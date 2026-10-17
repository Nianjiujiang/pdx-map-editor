'use strict';
/**
 * **启动时显卡上下文被收走** —— 分类 + 等回来重试 + 「真错不许重试」的回归自检。
 *
 *   node tools/check_ctxlost.js
 *
 * 为什么要有它（也是它为什么在这儿 ✗）：
 *   2026-10-16 用户报的那一幕 —— "着色器经常加载失败，不知道什么缘故"：
 *   真凶是**上下文在编译那一瞬被浏览器收走**（切后台 / 显存紧张 / 驱动重置 ✓），
 *   而当时 boot 里对 `new MapRenderer` 的**任何**异常都写"着色器编译失败" ✗
 *   （`getShaderInfoLog` 那时是 null → 报出来只有「着色器编译失败：null」✓）
 *   → 所有人都去查着色器源码，什么都查不出来 ✓
 *
 *   后来 `tools/check_renderer_error.js` 把**分类**钉住了 ✓，
 *   但**"等 restored 再重试、最后跑到就绪"这条行为**没人守 ✗ ——
 *   分类对 ≠ 重试真的接上了（重试那一环是 app.js 里的异步链 ✓）。
 *   这份就是守那一环的（它原先在 PR #7 里，合并时被弄丢了 ✗ 这次补回来 ✓）。
 *
 * 盯五件事：
 *   ① 上下文 / 恢复那**两个监听挂在编译之前** ✗
 *      （挂晚了没人在 lost 上 preventDefault → 浏览器永不发 restored ✓）
 *   ② 编译到一半丢上下文 → 归类到 **context-lost**（文案里**不许出现"着色器编译失败"** ✗）
 *   ③ 等 restored 回来 → **重新建一次**并接着跑到「就绪」✓
 *   ④ 真·着色器编译错（上下文好好的）→ 立刻报（带驱动日志）**而且不重试** ✗
 *      （重试只会把真正的报错刷掉 ✓）
 *   ⑤ 起来之后**正常丢 / 回来那条路照旧**（重建 + 重新喂数据 ✓）
 *
 * 做法：假 GL（`fakeGL()` 外面包一层）演两种故障 + 假 canvas，驱动真 boot() ✓
 *   ⚠ 等条件要**按真实时间**等（setTimeout）✗ —— 拿 setImmediate 空转几毫秒能转几千圈，
 *     而 boot 里每一步靠 `setTimeout(…,16)` 推进：那 16ms 一次都没到期就误判成"没发生" ✓
 *   ⚠ 没有 data/ 这套夹具时**明说跳过**（别静默退出 —— 那样"没跑"跟"全过"长得一样 ✓）
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

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某个条件成立 —— **按真实时间**等（见文件头那条 ⚠）*/
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
}

/** 够 `_build()` 跑到"编译着色器"那一步的假 GL ✓
 *  mode：
 *    · `lost-at-compile` —— `shaderSource` 那一刻上下文丢掉（用户踩的那种 ✓）
 *    · `bad-shader`      —— 上下文好好的，但编译就是不过（真·着色器错 ✓）
 *    · `good`            —— 一切正常 ✓ */
function glStub(order, mode) {
  let lost = false;
  return {
    VERSION: 0x1F02, RENDERER: 0x1F01, VENDOR: 0x1F00, MAX_TEXTURE_SIZE: 0x0D33,
    VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
    R8: 0x8229, RED: 0x1903, UNSIGNED_BYTE: 0x1401, NEAREST: 0x2600,
    NO_ERROR: 0, OUT_OF_MEMORY: 0x0505,
    getParameter: (p) => {
      if (p === 0x0D33) return 16384;
      if (p === 0x1F02) return 'WebGL 2.0 (自检假 GL)';
      if (p === 0x1F01) return 'FakeGPU';
      if (p === 0x1F00) return 'FakeVendor';
      return 0;
    },
    getExtension: () => null,
    isContextLost: () => lost,
    getError: () => (lost ? 0x9242 : 0),          // 0x9242 = CONTEXT_LOST_WEBGL ✓
    createTexture: () => ({}), bindTexture() {}, texParameteri() {}, texImage2D() {},
    texStorage3D() {}, texSubImage3D() {}, pixelStorei() {}, deleteTexture() {},
    createShader: () => { if (order) order.push('createShader'); return {}; },
    shaderSource() { if (mode === 'lost-at-compile') lost = true; },
    compileShader() {}, deleteShader() {},
    getShaderParameter: () => (mode === 'good'),
    getShaderInfoLog: () => (mode === 'bad-shader' ? 'ERROR: 0:12: syntax error' : ''),
    createProgram: () => ({}), attachShader() {}, linkProgram() {}, deleteProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => '',
    getUniformLocation: () => null,
    createVertexArray: () => ({}), bindVertexArray() {},
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
    getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
    disable() {}, clearColor() {}, viewport() {},
    activeTexture() {}, uniform1i() {}, uniform1f() {}, uniform1ui() {}, uniform2i() {},
    uniform3f() {}, uniform3fv() {}, uniform1iv() {}, uniform1fv() {}, uniform4f() {},
    drawArrays() {}, flush() {}, finish() {}, readPixels() {},
    isTexture: () => true, getSupportedExtensions: () => [],
  };
}

/**
 * 起一套环境、跑 boot、按 `modeOf(第几次拿上下文)` 给假 GL。
 * @returns {Promise<{ex, env, cv, calls, step, events, boot, restore}>}
 */
async function bootWith(modeOf) {
  const origGet = H.El.prototype.getContext;
  const order = [];
  const calls = [];
  H.El.prototype.getContext = function (kind, ...rest) {
    if (kind !== 'webgl2' && kind !== 'webgl') return origGet.call(this, kind, ...rest);
    const mode = modeOf(calls.length);
    calls.push(mode);
    return glStub(order, mode);
  };
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(), env);
  /* 画布上的监听要记顺序 ✓（① 那条断言就靠它 —— "监听挂在编译之前" ✗）*/
  const cv = env.get('map');
  const origAdd = cv.addEventListener.bind(cv);
  cv.addEventListener = (t, fn) => { order.push('listen:' + t); return origAdd(t, fn); };
  const boot = ex.boot();
  for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) await tick();
  const cards = env.get('map-pick-list').children;
  if (!cards.length) {
    H.El.prototype.getContext = origGet;
    return null;                                   // 没有夹具 → 调用方明说跳过 ✓
  }
  cards[0].onclick();
  return {
    ex, env, cv, calls, order, boot,
    step: () => String((env.get('boot-step') || {}).textContent || ''),
    /* 详细的"人话 + 现场"在**红字面板**里 ✓（启动步骤那行只放一句结论 ✓）*/
    fatal: () => String((env.get('fatal-text') || {}).textContent || ''),
    events: () => (ex.LOG && ex.LOG.rec ? ex.LOG.rec.events.map((e) => e.name + '：' + e.detail) : []),
    restore: () => { H.El.prototype.getContext = origGet; },
  };
}

(async () => {
  if (!fs.existsSync(path.join(H.ROOT, 'data', 'meta.json'))) {
    console.log('（没有 data/ 这套夹具 —— 先跑 python _local/make_fake_data.py 生成一份 ✓）');
    process.exit(0);
  }

  // ============================================================ ① 编译时丢上下文
  console.log('\n=== A. 编译到一半上下文被收走：分类对、等回来、重试到就绪 ===');
  {
    const t = await bootWith((n) => (n === 0 ? 'lost-at-compile' : 'good'));
    const touched = await until(() => t.order.indexOf('createShader') >= 0 || /上下文|出错|就绪/.test(t.step()));

    ok('① 上下文 / 恢复监听挂在**编译之前**（createShader 之前就挂了 ✓）',
      t.order.indexOf('listen:webglcontextlost') >= 0
      && t.order.indexOf('listen:webglcontextlost') < t.order.indexOf('createShader')
      && t.order.indexOf('listen:webglcontextrestored') < t.order.indexOf('createShader'),
      `lost@${t.order.indexOf('listen:webglcontextlost')}`
      + ` / restored@${t.order.indexOf('listen:webglcontextrestored')}`
      + ` / createShader@${t.order.indexOf('createShader')}（touched=${touched}）`);

    const waited = await until(() => /正在重试|上下文/.test(t.step()), 8000);
    ok('② 报的是"上下文丢了 / 正在重试"，**不是**"着色器编译失败"（别再把人往着色器上带 ✗）',
      waited && !/着色器/.test(t.step()), t.step());
    ok('② 日志里把这事记下来了（工单里一眼看得出来 ✓）',
      t.events().some((e) => /context-lost/.test(e) && /渲染器创建失败/.test(e)),
      t.events().filter((e) => /渲染器创建失败/.test(e)).slice(-1)[0] || '（没记 ✗）');

    t.cv.dispatchEvent({ type: 'webglcontextrestored' });   // 浏览器把上下文还回来 ✓
    const done = await until(() => /就绪|出错|失败/.test(t.step()), 9000);
    ok('③ restored 一到：**重新建了一次**并接着跑到「就绪」',
      done && /就绪/.test(t.step()) && !!t.ex.renderer,
      `step=${t.step()} · 共拿了 ${t.calls.length} 次上下文 · renderer=${t.ex.renderer ? '有' : '没有'}`);
    ok('③ 一共建了两次（第一次丢了、第二次成功 ✓）', t.calls.length === 2, t.calls.join(' → '));

    // 起来之后再丢一次（正常那条路）—— 不许被"半成品守卫"连累 ✓
    t.cv.dispatchEvent({ type: 'webglcontextlost', preventDefault() {} });
    t.cv.dispatchEvent({ type: 'webglcontextrestored' });
    const refed = await until(() => t.ex.renderer && !!t.ex.renderer.provTex);
    ok('③ 起来之后正常丢 / 回来这条路**照旧**（重建 + 重新喂数据 ✓）', !!refed,
      `provTex=${t.ex.renderer && t.ex.renderer.provTex ? '有' : '没有'}`);
    await t.boot.catch(() => {});
    t.restore();
  }

  // ============================================================ ② 真·着色器错
  console.log('\n=== B. 真·着色器编译错（上下文好好的）：立刻报，**不许重试** ===');
  {
    const t = await bootWith(() => 'bad-shader');
    const done = await until(() => /出错|失败/.test(t.step()), 8000);
    ok('④ 立刻失败上屏（没被当成上下文丢失 ✓）',
      done && /着色器/.test(t.step()) && !/上下文/.test(t.step()), t.step().split('\n')[0].slice(0, 110));
    /* ⚠ 驱动日志 / 显卡档案在**红字面板**里（`fatal-text` ✓），启动那行只放结论 ✓ */
    const fat = t.fatal();
    ok('④ 报错带上了驱动给的日志 ✓', /ERROR: 0:12/.test(fat), fat.split('\n').slice(0, 3).join(' ｜ ').slice(0, 160));
    ok('④ 报错带上了显卡档案（不许只说一句"失败了" ✗）',
      /FakeGPU|自检假 GL/.test(fat), fat.split('\n').slice(0, 3).join(' ｜ ').slice(0, 160));
    ok('④ **没有重试**（重试只会把真正的报错刷掉 ✗）', t.calls.length === 1, `拿了 ${t.calls.length} 次上下文`);
    await t.boot.catch(() => {});
    t.restore();
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
