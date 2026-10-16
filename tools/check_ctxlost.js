'use strict';
/**
 * 「启动时显卡上下文被收走」回归自检 —— 在 Node 里跑**真的 app.js + gl.js**。
 *
 *   node tools/check_ctxlost.js
 *
 * 用户报（2026-10-16）：**"着色器经常加载失败，不知道什么缘故"**。
 * 真相不在着色器 ✗：手机上启动要好几秒到几十秒（维护者记过：首次编译 20 秒级），
 * 这段时间切后台 / 锁屏 / 系统回收显存 / 驱动重置，浏览器就把 **WebGL 上下文**收走 ✓
 * 而编译着色器**正好落在这个窗口里** ——
 *   `COMPILE_STATUS` 是 false、`getShaderInfoLog` 是 **null** → 报出来只有一句
 *   「着色器编译失败：null」✓（于是所有人都去查着色器，什么都查不出来 ✓）
 *
 * 这条尺子盯四件事（每一条都对应这次改动的一个"别再退回去"）：
 *   ① 上下文/恢复那**两个监听挂在编译之前** ✗ —— 挂晚了没人在 lost 上
 *      `preventDefault()` → 浏览器**永远不发 restored**（那个上下文就废了 ✓）
 *   ② 这种失败要**认得出是"上下文丢了"**（`code: 'CTX_LOST'`），不许报成着色器错 ✓
 *   ③ 认出来之后**等它回来重试**：restored 一到，启动能接着跑完（到「就绪」✓）
 *   ④ 反过来：**真·着色器编译错**（上下文好好的）不许被当成上下文丢失 ✗，
 *      也不许重试 —— 要立刻报出来，而且带上驱动日志 + 显卡档案 ✓
 *
 * 做法：用假 GL（`H.fakeGL()` 上包一层）演两种故障，驱动真 app 的 boot ✓
 *   · 「编译到一半上下文丢了」：`shaderSource` 之后 `isContextLost()` 变 true ✓
 *   · 「着色器真的编不过」：`isContextLost()` 一直是 false，编译给日志 ✓
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

const LOADER = path.join(H.ROOT, 'pdx-map-editor.html');
const tick = () => new Promise((r) => setImmediate(r));

function findPack() {
  for (const d of [path.join(H.ROOT, '_local', 'packs'), path.join(H.ROOT, 'packs')]) {
    for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      if (n.endsWith('.pdxmap')) return path.join(d, n);
    }
  }
  return null;
}

/**
 * 一个假 WebGL：默认跟桩一样好，按 mode 演两种故障。
 *
 * @param {string[]} order  记录调用顺序（用来验"监听挂在编译之前" ✓）
 * @param {'lost-at-compile'|'bad-shader'|'good'} mode
 */
function glStub(order, mode) {
  const base = H.fakeGL();
  let lost = false;
  const over = {
    isContextLost: () => lost,
    getShaderParameter: () => (mode === 'good' ? true : false),
    getShaderInfoLog: () => (mode === 'bad-shader' ? 'ERROR: 0:12: syntax error' : null),
    shaderSource: (sh, src) => {
      if (mode === 'lost-at-compile') lost = true;      // 就在这一刻，上下文没了 ✓
      order.push('shaderSource' + (mode === 'lost-at-compile' ? '(上下文随即丢失)' : ''));
      void sh;
      void src;
    },
  };
  return new Proxy({}, {
    get(_, k) {
      const s = String(k);
      if (s === 'createShader') {
        order.push('createShader');
        return () => ({ __m: 'createShader' });
      }
      if (s in over) return over[s];
      return base[s];
    },
  });
}

/**
 * 起一套环境、导入测试包、点开第一张图，跑 boot —— 并把画布上的 WebGL
 * 换成我们指定的假 GL（`modeOf` 按第几次 getContext 给模式 ✓）。
 *
 * @returns {Promise<{ex:object, env:object, order:string[], ctxCalls:number[], step:()=>string, events:string[]}>}
 */
async function bootWith(modeOf) {
  const pack = findPack();
  const { js, embedded } = H.readStandalone(LOADER);
  const env = H.makeEnv({ embedded, root: H.ROOT });
  const ex = H.instantiate(js, env);

  const cv = env.get('map');
  const order = [];
  const ctxCalls = [];
  const origAdd = cv.addEventListener.bind(cv);
  cv.addEventListener = (t, fn) => { order.push('listen:' + t); return origAdd(t, fn); };
  const origGet = cv.getContext.bind(cv);
  cv.getContext = (kind, ...rest) => {
    if (kind !== 'webgl2' && kind !== 'webgl') return origGet(kind, ...rest);
    const mode = modeOf(ctxCalls.length);
    ctxCalls.push(mode);
    return glStub(order, mode);
  };

  const b = ex.boot();
  const fi = env.get('pack-file');
  for (let i = 0; i < 4000 && typeof fi.onchange !== 'function'; i++) await tick();
  fi.files = [new Blob([fs.readFileSync(pack)])];
  await fi.onchange();
  for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) await tick();
  const cards = env.get('map-pick-list').children;
  if (!cards.length) throw new Error('测试包没导进来');
  cards[0].onclick();

  const step = () => String((env.get('boot-step') || {}).textContent || '');
  const events = () => (ex.LOG && ex.LOG.rec ? ex.LOG.rec.events.map((e) => e.name + '：' + e.detail) : []);
  return { ex, env, order, ctxCalls, step, events, boot: b, cv };
}

/**
 * 等某个条件成立 —— **按真实时间等** ✓
 *
 * ⚠ 不能拿 `setImmediate` 空转 ✗：boot 里的每一步靠 `setTimeout(…,16)` 推进，
 *   而 setImmediate 的循环几毫秒就能转几千圈 —— 那 16ms 的定时器一次都没到期，
 *   于是"等不到"就误判成"没发生" ✓（我第一版就是这么假失败的 ✓）
 */
async function until(fn, timeoutMs = 6000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
}

(async () => {
  if (!fs.existsSync(LOADER)) {
    console.log('✘ 缺 pdx-map-editor.html（先跑 python build_standalone.py）');
    process.exit(1);
  }
  if (!findPack()) {
    console.log('（没有 _local/packs/ 里的测试包 —— 先跑 python pack_map.py 打一个）');
    process.exit(0);
  }

  // ================================================================ 场景 A
  // 「编译到一半，上下文被收走」—— 用户报的那一幕 ✓
  console.log('\n=== A. 编译时上下文被收走：认得出、等它回来、重试能跑完 ===');
  {
    const t = await bootWith((n) => (n === 0 ? 'lost-at-compile' : 'good'));

    // 先等它真的动手建渲染器（这一步是异步的 ✓）
    const touched = await until(() => t.order.indexOf('createShader') >= 0 || /上下文|出错|就绪/.test(t.step()));

    ok('① 上下文/恢复监听挂在**编译之前**（createShader 之前就挂了 ✓）',
      t.order.indexOf('listen:webglcontextlost') >= 0
      && t.order.indexOf('listen:webglcontextlost') < t.order.indexOf('createShader')
      && t.order.indexOf('listen:webglcontextrestored') < t.order.indexOf('createShader'),
      `lost@${t.order.indexOf('listen:webglcontextlost')} / restored@${t.order.indexOf('listen:webglcontextrestored')} / createShader@${t.order.indexOf('createShader')}（touched=${touched}）`);

    const waited = await until(() => /上下文被收走/.test(t.step()), 8000);
    ok('② 报的是"上下文被收走"，**不是**"着色器编译失败"（别再把人往着色器上带 ✗）',
      waited && !/着色器/.test(t.step()),
      t.step());
    ok('② 日志里记下了这件事（工单里能一眼看出来 ✓）',
      t.events().some((e) => /上下文在启动时被收走/.test(e)),
      t.events().slice(-3).join(' ｜ '));

    // 浏览器把上下文还回来 —— 多半就是这时候 ✓
    t.cv.dispatchEvent({ type: 'webglcontextrestored' });
    const done = await until(() => /就绪|出错/.test(t.step()));
    ok('③ restored 一到：**重新建了一次**并接着跑到「就绪」',
      done && /就绪/.test(t.step()) && !!t.ex.renderer,
      `step=${t.step()} ctxCalls=${t.ctxCalls.length} renderer=${t.ex.renderer ? '有' : '没有'}`);
    ok('③ 一共建了两次（第一次丢了、第二次成功 ✓）', t.ctxCalls.length === 2,
      t.ctxCalls.join(' → '));

    // 跑起来之后再丢一次（正常那条路）—— 不许被"半成品守卫"连累 ✓
    t.cv.dispatchEvent({ type: 'webglcontextlost', preventDefault() {} });
    t.cv.dispatchEvent({ type: 'webglcontextrestored' });
    const refed = await until(() => t.ex.renderer && !!t.ex.renderer.provTex);
    ok('③ 起来之后正常丢/回来这条路**照旧**（重建 + 重新喂数据 ✓）', !!refed,
      `provTex=${t.ex.renderer && t.ex.renderer.provTex ? '有' : '没有'}`);
    await t.boot.catch(() => {});
  }

  // ================================================================ 场景 B
  // 「着色器真的编不过」—— 上下文好好的，必须立刻报、不许重试 ✓
  console.log('\n=== B. 真·着色器编译错：立刻报（带日志 + 显卡档案），不许重试 ===');
  {
    const t = await bootWith(() => 'bad-shader');
    const done = await until(() => /出错/.test(t.step()), 4000);
    ok('④ 立刻失败上屏（没当成上下文丢失）',
      done && /着色器编译失败/.test(t.step()),
      t.step().slice(0, 120));
    ok('④ 报错带上了驱动给的日志 ✓', /ERROR: 0:12/.test(t.step()), t.step().slice(0, 160));
    ok('④ 报错带上了显卡档案（不许只说一句"失败了" ✗）',
      /｜/.test(t.step()), t.step().slice(0, 160));
    ok('④ **没有重试**（等一万年也不会好，重试只会把真报错刷掉 ✗）',
      t.ctxCalls.length === 1, `ctxCalls=${t.ctxCalls.length}`);
    ok('④ 不许报成"上下文丢失" ✗', !/上下文/.test(t.step()), t.step().slice(0, 120));
    await t.boot.catch(() => {});
  }

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
