/**
 * 验一下**烤好的单文件版**能不能跑。
 *
 *   node tools/check_standalone.js                      # 默认看根目录那个 35MB 的
 *   node tools/check_standalone.js path/to/other.html
 *
 * 为什么要有这个：那个 HTML 是唯一发给玩家的东西，而它是**烤出来的** ——
 * 源文件改了、忘了重烤，或者烤的过程中哪一步错了（内嵌数据被压坏、
 * 拍平脚本被截断、`window.__CK3_EMBEDDED__` 没写对），
 * 原来只有"玩家双击、白屏、来问你"这一条路能发现。
 *
 * 这里直接把 HTML 里的**内嵌数据 + 拍平脚本**原样抠出来，
 * 用同一套假 DOM / 假 WebGL 跑一遍 boot()，然后逐项验：
 *   · 选单列出了几套地图（= 内嵌了几套）
 *   · 每套地图的 meta / 头衔表 / 省份 id 图都解得出、尺寸对得上
 *   · 渲染器真的建起来了（着色器没编译失败）
 *   · 换一张图也能起来
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const HTML = process.argv[2] || path.join(H.ROOT, 'pdx-map-editor.html');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

/** 跑一次启动，返回探针与假环境 */
async function bootWith(embedded, wantLabel) {
  const env = H.makeEnv({ embedded });
  const js = H.readStandalone(HTML).js;      // 拍平脚本只读一次，重复跑没关系
  const ex = H.instantiate(js, env);
  const booting = ex.boot();
  for (let i = 0; i < 2000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const cards = env.get('map-pick-list').children;
  const card = wantLabel
    ? cards.find((c) => c.flat().includes(wantLabel))
    : cards[0];
  if (card) card.onclick();
  await booting;
  return { ex, env, cards, card };
}

(async () => {
  console.log(`\n===== 单文件版自检：${path.relative(H.ROOT, HTML)} =====`);
  if (!fs.existsSync(HTML)) { console.log('  ✘ 文件不存在'); process.exit(1); }
  const size = fs.statSync(HTML).size;
  console.log(`  文件 ${(size / 1048576).toFixed(2)} MB`);

  const { embedded, js, html } = H.readStandalone(HTML);
  ok('HTML 里有 window.__CK3_EMBEDDED__（内嵌数据）', !!embedded,
     embedded ? Object.keys(embedded.maps || {}).join('/') : '没有 ✗');
  ok('拍平脚本抠出来了（不是空壳）', js.length > 100000, `${js.length} 字符`);
  ok('file:// 那段"不能双击打开"的提示已经摘掉', !/不能直接双击打开/.test(html));
  ok('外链 CSS 已经内联（没有 <link rel=stylesheet>）',
     !/<link rel="stylesheet" href="style\.css">/.test(html));
  if (!embedded) process.exit(1);

  const keys = Object.keys(embedded.maps || {});
  ok(`内嵌了 ${keys.length} 套地图`, keys.length >= 6, keys.join(' / '));

  // 每一套：meta / 头衔表都解得出，并且尺寸自洽
  for (const [key, m] of Object.entries(embedded.maps)) {
    const hasMeta = !!m.meta;
    const hasTitles = !!m.titles;
    let titleCount = -1;
    try {
      const gz = Buffer.from(m.titles, 'base64');
      const t = JSON.parse(require('zlib').gunzipSync(gz).toString('utf8'));
      titleCount = (t.keys || []).length;
    } catch (e) { titleCount = -1; }
    ok(`  [${key}] meta + 头衔表都内嵌且解得开`,
       hasMeta && hasTitles && titleCount > 0,
       hasMeta ? `${m.meta.game} ${m.meta.mapWidth}×${m.meta.mapHeight} · ${titleCount} 个头衔`
               : '没有 meta ✗');
    if (hasMeta) {
      const need = m.meta.mapWidth * m.meta.mapHeight;
      const got = Buffer.from(m.provinces, 'base64').length;   // 压缩后，只能判个大概
      ok(`  [${key}] 省份 id 图在（压缩后 ${(got / 1024).toFixed(0)} KB）`, got > 0,
         `解压后应有 ${(need / 1048576).toFixed(1)}M 个像素位`);
    }
  }

  // 真跑一遍：挑第一张能起来
  console.log('\n---- 真跑一遍 ----');
  const { ex, env, cards } = await bootWith(embedded, null);
  ok('选单里的地图数 = 内嵌的数', cards.length === keys.length,
     `${cards.length} 张：${cards.map((c) => c.flat().replace(/<[^>]*>/g, '').trim()).join(' / ')}`);
  const step = (env.get('boot-step') || {}).textContent || '';
  ok('boot 跑到"就绪"', /就绪/.test(step), step || '（没走到那一步）');
  ok('meta 装上了', !!(ex.state.meta && ex.state.meta.numTitles),
     ex.state.meta ? `${ex.state.meta.numProvinces} 地块 / ${ex.GAME.name}` : '没装上 ✗');
  ok('渲染器建起来了（WebGL2 着色器没编译失败）', !!ex.renderer);
  ok('头衔表解开了', !!(ex.state.titles && ex.state.titles.keys.length),
     ex.state.titles ? `${ex.state.titles.keys.length} 个头衔` : '没有 ✗');
  ok('省份 id 图就位（一整张或分块）',
     !!ex.state.provinceIds || !!ex.state.tileMap,
     ex.state.tileMap ? '分块' : '整张');
  ok('标签层建起来了', !!ex.labels);

  // 报错日志：log.js 得**真的拼进单文件**，而且 boot 完已经有东西可导 ✓
  // 漏拼的话 app.js 那边是个空壳、编辑器照常跑 —— 这种"功能悄悄没了"
  // 比报错难发现得多 ✗ 所以让自检盯着它
  const log = env.sandbox && env.sandbox.window && env.sandbox.window.PDXLOG;
  ok('报错日志模块在（log.js 拼进单文件了）', !!(log && typeof log.text === 'function'));
  const logTxt = log && typeof log.text === 'function' ? log.text() : '';
  ok('日志里有启动轨迹和地图信息（不是个空壳）',
     /\[轨迹\]/.test(logTxt) && /就绪/.test(logTxt) && /\[当时的状态\]/.test(logTxt),
     logTxt ? `'${logTxt.split(/\r?\n/).find((l) => /版本戳/.test(l)) || ''}'` : '');

  // 崩溃上屏：结构改过（多一层容器 + 一颗导出按钮），
  // "文字还进得去""按钮还在""再崩一次不会把按钮冲掉"这三件都要盯
  // （这个框是白屏时唯一的出口，它坏掉等于现场彻底看不见 ✗）
  if (typeof ex.showFatal === 'function') {
    ex.showFatal('✗ 自检用的假崩溃');
    ex.showFatal('✗ 第二次假崩溃');
    const ft = env.get('fatal-text');
    const fl = env.get('fatal-log');
    ok('崩溃能上屏（两条都进内层 pre）',
       /假崩溃/.test(ft.textContent || '') && /第二次/.test(ft.textContent || ''),
       (ft.textContent || '').trim().split('\n').join(' / '));
    ok('上屏框里带着「导出日志」按钮，而且接着导出日志',
       !!fl && typeof fl.onclick === 'function');
  } else {
    ok('崩溃上屏函数拿得到（探针在）', false, 'ex.showFatal 没暴露 ✗');
  }
  ok('状态栏写上了版本信息',
     /地块/.test((env.get('status-meta') || {}).textContent || ''),
     (env.get('status-meta') || {}).textContent || '');

  // 再挑一张别的（有的话）—— 换游戏能不能起来
  if (cards.length > 1) {
    const other = cards[cards.length - 1];
    const label = other.flat().replace(/<[^>]*>/g, '').trim().split(/\s+/)[0];
    const r2 = await bootWith(embedded, label);
    ok(`换一张（${label}）也能起来`, /就绪/.test((r2.env.get('boot-step') || {}).textContent || ''),
       (r2.env.get('boot-step') || {}).textContent || '');
  }

  // ---- 显卡上下文丢了又回来（手机切后台再回来黑屏就是这条路）----------------
  //   丢：接住 + **停画**（丢着的时候画什么都不会上屏 ✓）
  //   回：**把地图数据重新喂一遍** ✓ 而且**不许把笔迹擦了** ✓
  //       （笔迹一直存在 CPU 那份 paintData 里 ✓ —— 重喂时无脑重建就把它抹掉了 ✓）
  console.log('\n---- 显卡上下文丢了又回来 ----');
  {
    const cv = env.get('map');
    const r = ex.renderer;
    r.setPaint(11, 200, 30, 40, 255);
    r.setPaintLabel(11, 7);
    ok('（预备）渲染器在、笔迹写得进去', !!(r.provTex && r.paintData[11 * 4] === 200));

    cv.dispatchEvent({ type: 'webglcontextlost', preventDefault() {} });
    ok('丢上下文：接住了（preventDefault）+ 停画',
       r.ctxLost === true && r.dirty === false, `ctxLost=${r.ctxLost} dirty=${r.dirty}`);

    cv.dispatchEvent({ type: 'webglcontextrestored' });
    for (let i = 0; i < 400 && !r.provTex; i++) await new Promise((res) => setImmediate(res));
    ok('回来：地图数据重新喂进去了（省份图 / 归属表 / 颜色表 / 手绘层）',
       !!(r.provTex && r.titleTex && r.colorTex && r.paintTex && r.paintLabelTex),
       `prov=${!!r.provTex} title=${!!r.titleTex} color=${!!r.colorTex} paint=${!!r.paintTex}`);
    ok('**笔迹没被重喂擦掉**（颜色 + 标记都还在）',
       r.paintData[11 * 4] === 200 && r.paintData[11 * 4 + 3] === 255 && r.paintLabelData[11] === 7,
       `rgba=${r.paintData[11 * 4]},${r.paintData[11 * 4 + 1]},${r.paintData[11 * 4 + 2]},`
       + `${r.paintData[11 * 4 + 3]} · label=${r.paintLabelData[11]}`);
    ok('回来之后会自动重画一帧（dirty = true）', r.dirty === true && r.ctxLost === false);
    ok('恢复这件事进了日志（出事能发出来）',
       /上下文/.test((log && typeof log.text === 'function' && log.text()) || ''));

    // ---- 没丢上下文那种"切出去再回来"：也要**强制重画一帧** ----
    // 后台期间 rAF 是冻住的 ✓ 回来时没人碰 dirty 的话，那一帧永远不来 ✓
    r.dirty = false;
    env.documentStub.hidden = false;
    const nVis = env.dispatchDocument('visibilitychange');
    ok('回到前台：强制重画一帧（visibilitychange 那条）',
       r.dirty === true, `监听 ${nVis} 个 · dirty=${r.dirty}`);
    r.dirty = false;
    env.dispatchWindow('pageshow');
    ok('回到前台：pageshow 那条也兜住了（有的浏览器只发这个）', r.dirty === true);
  }

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
