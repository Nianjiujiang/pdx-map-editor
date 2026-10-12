/**
 * 手机版单文件自检。
 *
 *   node tools/check_mobile.js
 *   node tools/check_mobile.js path/to/pdx-map-editor-mobile.html
 *
 * 手机版 = 同一套源码 + `mobile/*.txt` 那三块补丁，烤成一个单文件 ✓
 * 所以验它要比验电脑版多两件事：
 *   ① 那个补丁**打进去了没有**（#mob-ui 在 CSS 里、bindMobile 在 JS 里、那段注释在 HTML 里）
 *   ② **打进去之后还跑不跑得起来** —— 补丁是在 app.js 的 `bindEvents()` 前面插一大段 +
 *      在启动流程里插一句 `bindMobile()`，插歪了就是一启动就抛，白屏
 *
 * 做法：把单文件里那个 `<script>` 整段抠出来（**里面已经含着打完补丁的 app.js**），
 * 原样喂给同一套假 DOM 跑一遍 boot() ✓ —— 不是"重打一遍补丁来近似"，是验真产物。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const HTML = process.argv[2] || path.join(H.ROOT, 'pdx-map-editor-mobile.html');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

/** 把单文件的 <script> 里那段拍平源码抠出来（含打完补丁的 app.js） */
function readScript(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const at = html.indexOf('window.__CK3_EMBEDDED__=');
  if (at < 0) return { html, js: '', embedded: null };
  const open = html.lastIndexOf('<script>', at);
  const close = html.indexOf('</script>', at);
  const body = html.slice(open + 8, close);
  const endPayload = body.indexOf('}};', at - open);
  const stmt = body.slice(0, endPayload + 3);
  const js = body.slice(endPayload + 3);
  const embedded = new Function('window', stmt + '\nreturn window.__CK3_EMBEDDED__;')({});
  return { html, js, embedded };
}

(async () => {
  console.log(`\n===== 手机版自检：${path.relative(H.ROOT, HTML)} =====`);
  if (!fs.existsSync(HTML)) { console.log('  ✘ 文件不存在（先跑 python mobile/build.py）'); process.exit(1); }
  console.log(`  文件 ${(fs.statSync(HTML).size / 1048576).toFixed(2)} MB`);

  const { html, js, embedded } = readScript(HTML);
  ok('内嵌数据在', !!embedded, embedded ? Object.keys(embedded.maps || {}).length + ' 套地图' : '没有 ✗');

  // ① 补丁痕迹 —— 三块都要在
  ok('CSS 补丁打进去了（#mob-ui）', html.includes('#mob-ui'));
  /* 滚动条统一暗色 ✓（用户 2026-10-12："手机版剧本太多冒出来的那条滑块是白的" ✗）
     —— 这条盯着"别哪天把这几行删了、白条又回来" ✓ */
  ok('滚动条染成暗色（不是浏览器那根白条 ✓）',
     /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*#2b3542/i.test(html)
     && /scrollbar-color:\s*#2b3542/.test(html),
     /::-webkit-scrollbar-thumb/i.test(html) ? 'webkit 那条在 ✓' : '暗色滚动条那几行没找到 ✗');
  ok('JS 补丁打进去了（function bindMobile）', js.includes('function bindMobile'));
  /* 手机上的文件过滤整个放开 ✓（用户 2026-10-12 报的"pdxmap 选不了"：
     `.pdxmap` 类型是 octet-stream，安卓/iOS 的选择器按 MIME 过滤就把它灰掉 ✗）*/
  ok('手机上把选文件的 MIME 过滤放开了（不然 .pdxmap 灰着点不动 ✗）',
     /pack-file'\)[\s\S]{0,80}?accept = '\*\/\*'/.test(js),
     /accept = '\*\/\*'/.test(js) ? "accept = '*/*' ✓" : '没找到放开过滤那两行 ✗');
  ok('JS 补丁的启动挂点也在（bindMobile() 的调用）',
     /bindEvents\(\);\s*\n\s*bindMobile\(\)/.test(js));
  ok('HTML 那段注释也打了（手机版界面说明）', html.includes('手机版的界面'));

  // ② 补丁**没有**漏进源码本该干净的地方：单文件里 app.js 只该有一份
  const nBind = (js.match(/function bindMobile\s*\(/g) || []).length;
  ok('bindMobile 只有一份（没重复打补丁）', nBind === 1, String(nBind));

  // **面板宽度分档** ✓（用户定的）：工具 / 视图 / 文件里面就几个字 → 窄；
  // 设置 / 颜色是一排排的开关和输入框 → 摊到接近整屏 ✓
  ok('「文件」面板跟工具 / 视图同宽（不再单独一档 220 ✓）',
     /WANT = \{ tool: 148, view: 148, io: 148 \}/.test(js),
     /io: 148/.test(js) ? 'io=148 ✓' : '文件那档还是旧的 ✗');
  ok('「设置」「颜色」面板摊到接近整屏（a.width - 16 ✓）',
     /const FULL = \{ display: 1, color: 1 \}/.test(js) && /FULL\[key\] \? \(a\.width - 16\)/.test(js));

  // ③ 真跑一遍
  console.log('\n---- 真跑一遍（补丁后的 app.js）----');
  const env = H.makeEnv({ embedded, root: H.ROOT });
  const ex = H.instantiate(js, env);
  const b = ex.boot();
  for (let i = 0; i < 4000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  let cards = env.get('map-pick-list').children;
  /* 轻量版（2026-10-12 起单文件默认不内嵌地图）这里会是 0 张 ——
     那就**先导一个包**，走玩家第一次用的那条路 ✓ */
  const keys = Object.keys(embedded.maps || {});
  if (!cards.length && keys.length === 0) {
    let packPath = null;
    for (const d of [path.join(H.ROOT, 'packs'), path.join(H.ROOT, '_local', 'packs')]) {
      for (const n of ['pdx-eu4-vanilla.pdxmap', 'eu4-vanilla.pdxmap', 'eu4-vanilla-test.pdxmap']) {
        const p = path.join(d, n);
        if (fs.existsSync(p)) { packPath = p; break; }
      }
      if (packPath) break;
    }
    if (packPath) {
      const fi = env.get('pack-file');
      fi.files = [new Blob([fs.readFileSync(packPath)])];
      await fi.onchange();
      for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) {
        await new Promise((r) => setImmediate(r));
      }
      cards = env.get('map-pick-list').children;
      ok('轻量版：导进一个地图包之后选单里有卡片了', cards.length === 1, cards.length + ' 张');
    } else {
      console.log('  （没有 _local/packs/ 里的测试包，轻量版这条跳过）');
    }
  }
  ok('启动选单出来了（有内嵌地图，或者导进来一个包）', cards.length > 0, cards.length + ' 张');
  /* 导入式地图这套手机版也带（同一套源码 ✓）——
     补丁只碰界面结构，但选图界面那个导入入口是**新加的节点**，
     手机版补丁要是把它搬没了、或者拍平漏了 packstore.js，这条会响 ✓ */
  ok('手机版选图界面也有「导入地图包」', !!env.get('map-import'));
  ok('校验器 / 仓库都拼进手机版了（拍平清单没有漏）',
     /function validatePack/.test(js) && /function importPack/.test(js));
  if (cards.length) cards[0].onclick();
  await b;
  const step = (env.get('boot-step') || {}).textContent || '';
  ok('boot 跑到就绪（补丁没把启动弄崩）', /就绪/.test(step), step || '（没走到）');
  ok('渲染器建起来了', !!ex.renderer);
  ok('标签层建起来了', !!ex.labels);
  ok('meta / 头衔表都装上了', !!(ex.state.meta && ex.state.titles),
     ex.state.meta ? `${ex.state.meta.numProvinces} 地块 / ${ex.GAME.name}` : '');

  // 报错日志：手机版跟电脑版共用同一套源码 ✓ —— 补丁只碰界面，
  // 日志该在也得在（漏拼了 log.js 的话手机版玩家出事就没现场可发 ✗）
  const log = env.sandbox && env.sandbox.window && env.sandbox.window.PDXLOG;
  ok('报错日志模块也在（手机版同一套源码 ✓）', !!(log && typeof log.text === 'function'),
     log && typeof log.text === 'function' ? 'PDXLOG 有了' : '没有 ✗');

  // ④ 手机版特有：bindMobile 跑过之后应该造出 #mob-ui 那些节点
  const mobUi = env.get('mob-ui');
  const madeIt = !!mobUi && (mobUi.children.length > 0 || String(mobUi.className || '').includes('mob'));
  ok('bindMobile() 造出了手机版界面节点', madeIt,
     mobUi ? `#mob-ui 子节点 ${mobUi.children.length} 个` : '没造出来 ✗');

  // ⑤ 手机切后台再回来 —— 黑屏那条路。
  //    手机把 WebGL 上下文整个收走（省显存 ✓）回来时必须把数据重喂一遍 ✓
  //    笔迹在 CPU 那份里，重喂**不许擦掉** ✓（这正是"切个后台回来，涂的全没了" ✓）
  console.log('\n---- 切后台再回来（丢上下文）----');
  {
    const cv2 = env.get('map');
    const r2 = ex.renderer;
    r2.setPaint(11, 200, 30, 40, 255);
    cv2.dispatchEvent({ type: 'webglcontextlost', preventDefault() {} });
    const stopped = r2.ctxLost === true && r2.dirty === false;
    ok('丢上下文时停画（不然那几帧全是白费 + 搅浑 GL 错误）', stopped);
    cv2.dispatchEvent({ type: 'webglcontextrestored' });
    for (let i = 0; i < 400 && !r2.provTex; i++) await new Promise((res) => setImmediate(res));
    ok('回来：地图数据重新喂进去了', !!(r2.provTex && r2.titleTex && r2.paintTex),
       `prov=${!!r2.provTex} paint=${!!r2.paintTex}`);
    ok('**笔迹没丢**（颜色 + alpha 都在）',
       r2.paintData[11 * 4] === 200 && r2.paintData[11 * 4 + 3] === 255,
       `rgba=${r2.paintData[11 * 4]},${r2.paintData[11 * 4 + 1]},`
       + `${r2.paintData[11 * 4 + 2]},${r2.paintData[11 * 4 + 3]}`);
    r2.dirty = false;
    env.documentStub.hidden = false;
    env.dispatchDocument('visibilitychange');
    ok('回到前台：强制重画一帧', r2.dirty === true);
  }

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
  // 手机端补丁里有 setInterval（胶囊状态那 0.4 秒一刷）→ 不显式退，Node 不会自己结束
  process.exit(0);
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
