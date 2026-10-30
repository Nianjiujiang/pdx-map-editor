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

/** 两个定型数组逐字节一样吗（"包里读的和内嵌那份是同一个东西"就靠它） */
function sameArr(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 两张头衔表一样吗 —— **名字 / 颜色 / 层级 / 父级 / 归属个数**逐项比 ✓
 *
 * 2026-10-12 廿九点名要确认的那件事：「国家、地区等以及他们的颜色也包含在地图包里」
 * 说白了就是：包里那几份表 = 地图的**全部**数据，一样都不许少 ✗
 * （名字和颜色在 titles.json，归属在 titlemap.bin ✓ 都在包的一个个条目里 ✓）
 *
 * @param {boolean} [brief] 只回一句摘要（给断言当 detail 用）
 * @returns {string|null} null = 一致；否则是"哪一项不一样"
 */
function titlesDiff(a, b) {
  if (!a || !b) return '有一边读不出来';
  const fields = ['keys', 'tiers', 'parents', 'names', 'colors', 'provCount'];
  for (const f of fields) {
    const x = a[f];
    const y = b[f];
    if (!x || !y) return `${f} 缺`;
    if (x.length !== y.length) return `${f} 条数不同（${x.length} vs ${y.length}）`;
    for (let i = 0; i < x.length; i++) {
      if (JSON.stringify(x[i]) !== JSON.stringify(y[i])) return `${f} 第 ${i} 项不同`;
    }
  }
  return null;
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

/**
 * **轻量版**的启动：先导一个地图包，再点它进编辑器 —— 这正是玩家的路 ✓
 * @param {string} packPath 测试包（本地打的那个，仓库里没有）
 */
async function bootLiteWithPack(embedded, packPath) {
  const env = H.makeEnv({ embedded });
  const js = H.readStandalone(HTML).js;
  const ex = H.instantiate(js, env);
  const booting = ex.boot();
  /* 等 pickMap 把界面接好 ✓
     ⚠ 别等 `map-pick.hidden == false`：假 DOM 里 hidden 的默认值不一定是我们想的那个，
       会"一秒都没等就往下走" ✗ 等**接线本身**（选文件那个 input 挂上 onchange = 界面出来了）✓ */
  const fi = env.get('pack-file');
  for (let i = 0; i < 3000 && typeof fi.onchange !== 'function'; i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (typeof fi.onchange !== 'function') throw new Error('选图界面没接上（pack-file 没有 onchange）');
  /* 没有地图时那句引导现在在 `#map-msg` 那个框里 ✓（2026-10-12 挪下来的）
     ⚠ 它**不再是 HTML 里的静态文字**了 —— 是 render() 用 setPackMsg 写进去的 ✓ */
  const hintBox = env.get('map-msg');
  const emptyShown = !!(hintBox && !hintBox.hidden);
  const emptyText = (hintBox && hintBox.textContent) || '';
  // 走玩家那条路：选文件 → 导入（UI 的接线也一起验了 ✓）
  fi.files = [new Blob([fs.readFileSync(packPath)])];
  await fi.onchange();
  for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const cards = env.get('map-pick-list').children;
  const card = cards[0];
  if (card) card.onclick();
  await booting;
  return { ex, env, cards, card, emptyShown, emptyText };
}

/** 本地那个测试包（build_packs.py / pack_map.py 打的），没有就返回 null
 *  `packs/` 是 build_packs.py 的正经输出；`_local/packs/` 是早先手工打的几个 ✓ */
function findTestPack() {
  const dirs = [path.join(H.ROOT, 'packs'), path.join(H.ROOT, '_local', 'packs')];
  const names = ['pdx-eu4-vanilla.pdxmap', 'eu4-vanilla.pdxmap', 'eu4-vanilla-test.pdxmap'];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
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
  ok('主题脚本留下来了（开机先定白天/黑夜 ✓）', /pdx-theme/.test(html) && /data-theme/.test(html));
  ok('玻璃壳有降级（backdrop-filter 不支持也不糊 ✓）', /-webkit-backdrop-filter/.test(html));
  ok('外链 CSS 已经内联（没有 <link rel=stylesheet>）',
     !/<link rel="stylesheet" href="style\.css">/.test(html));
  if (!embedded) process.exit(1);

  const keys = Object.keys(embedded.maps || {});
  /* 两种形态都得认 ✓（2026-10-12 起单文件默认出**轻量版**：不内嵌地图，
     地图改成 .pdxmap 包单独下；全量版还留着：`--all-maps` ✓） */
  const lite = keys.length === 0;
  if (lite) {
    ok('这是轻量版（没内嵌地图，配地图包一起发）', true, 'maps 是空的 ✓');
    ok('轻量版体积应该是 0.6 MB 量级（不是 35 MB）', size < 2 * 1024 * 1024,
       `${(size / 1048576).toFixed(2)} MB`);
  } else {
    /* ⚠ 别写死 ≥6 ✗：那是**官方全量版**的数；本地按需烘一两张（比如自测真图）也合法 ✓
     *   每套地图的内容后面逐张验（meta / 头衔表 / 尺寸自洽）✓ */
    ok(`内嵌了 ${keys.length} 套地图`, keys.length >= 1, keys.join(' / '));
  }

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
  const testPack = findTestPack();
  let ex; let env; let cards;
  if (lite) {
    /* 轻量版没有内嵌地图 → 必须"导入一个包 → 点它 → 进去"才跑得起来 ✓
       这正好是玩家第一次用的完整路径，所以这一条比全量版那几条还值钱 ✓ */
    if (!testPack) {
      ok('轻量版能导入地图包并进去（需要 _local/packs/ 里的测试包）', false,
         '没有测试包：先跑 python build_packs.py 或 pack_map.py');
      process.exitCode = 1;
      return;
    }
    const r = await bootLiteWithPack(embedded, testPack);
    ex = r.ex; env = r.env; cards = r.cards;
    /* ⚠ 2026-10-12 起那句引导**不在 HTML 里了** ✗ —— 它跟"成功导入地图…"共用
       `#map-msg` 那个框，是 render() 用 setPackMsg 写进去的：直接读那个元素 ✓ */
    ok('轻量版：一进来先看到那句引导（在下面那个提示框里 ✓）',
       r.emptyShown === true && /请点击导入按钮/.test(r.emptyText || ''),
       `hidden=${!r.emptyShown} · "${(r.emptyText || '').slice(0, 46)}"`);
    ok('轻量版：导入地图包之后卡片出现了', cards.length === 1,
       `${cards.length} 张：${cards.map((c) => c.flat().replace(/<[^>]*>/g, '').trim()).join(' / ')}`);
  } else {
    ({ ex, env, cards } = await bootWith(embedded, null));
    ok('选单里的地图数 = 内嵌的数', cards.length === keys.length,
       `${cards.length} 张：${cards.map((c) => c.flat().replace(/<[^>]*>/g, '').trim()).join(' / ')}`);
  }
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
  /* 2026-10-27 用户："国名显示不要那个 20 门槛，无论手机版还是电脑版"
   *   国名层（有年份 = 年份层；没有 = 最粗那层）门槛必须是 **0** ✓
   *   （0 = 不设缩放门槛，不是"永不显示" ✓） */
  ok('国名层没有缩放门槛（0 = 缩到全图也画 ✓）',
     !!(ex.labels && ex.state.meta && ex.state.meta.labelZoom)
     && ex.labels.zoom[0] === 0 && ex.state.meta.labelZoom[0] === 0,
     ex.labels ? `labels.zoom[0]=${ex.labels.zoom[0]} · meta=${ex.state.meta && ex.state.meta.labelZoom && ex.state.meta.labelZoom[0]}` : '标签层没建起来');
  /* 真画一帧：以前 `20% 门槛` 会让 `draw()` 整层直接 return ✓
   * 现在 `zoom[0]=0`，字号底线 2px —— 只要缩放到"最大的国家刚好够 2px"就该画得出来 ✓
   * ⚠ **5% 不是对哪张图都成立** ✗（2026-10-27）：夹具图只有 96×48，
   *   最大的块也才三四十像素宽，5% 时字号不到 1px —— 再怎么修也画不出来 ✓
   *   → 按"最大地块在屏幕上够 2px"反推缩放；真实大地图反推出来就是 5% 上下 ✓ */
  {
    const W = ex.state.meta ? ex.state.meta.mapWidth : 5632;
    const H = ex.state.meta ? ex.state.meta.mapHeight : 2048;
    const cv = ex.labels && ex.labels.canvas;
    const oldCW = cv ? cv.clientWidth : 0;
    const areas = (ex.state.titles && (ex.state.titles.blockArea || ex.state.titles.area)) || [];
    let side = 0;
    for (const a of areas) if (a > 0) side = Math.max(side, Math.sqrt(a));
    /* 字号 = √面积 × 缩放 × 0.18；要它 ≥ 2px → 缩放 ≥ 2 / (0.18 × 边长) ✓ */
    const needScale = side > 0 ? 2 / (0.18 * side) : 0.05;
    const useScale = Math.max(0.05, needScale * 1.05);
    const viewW = 1000 / useScale;
    if (ex.labels && cv && W > 0) {
      cv.clientWidth = 1000;
      ex.labels.draw({ x: 0, y: 0, w: viewW, h: viewW * H / W }, 0, null);
      ok('国名门槛为 0 时画得出来（缩到"最大国刚好够 2px"也画 ✓）',
         ex.labels.drawn > 0,
         `${ex.labels.drawn} 个 · scale=${(ex.labels.scale * 100).toFixed(1)}%`
         + `（最大块 ${side.toFixed(0)}px）`);
      cv.clientWidth = oldCW;
      try { ex.labels.resize(); } catch (e) { /* ✓ */ }
    } else {
      ok('国名门槛为 0 时画得出来（缩到"最大国刚好够 2px"也画 ✓）', false, '没有标签层 ✗');
    }
  }
  /* 🔴 **空色块也必须换代** ✗✗（2026-10-27 用户：
   *   "切空白剧本 / 无剧本后国名不消失，必须画一下才刷新"
   *   "清除和橡皮点了之后国名仍然没消失，需要画一下才刷新"）
   *
   *   根因：`rebuildPaintBlocks()` 在两处 early return 里只清空了 `paintBlocks` ✓
   *   可 `blockLabelPoints()` 是按 `_blockVer` 缓存的 ✗
   *   → 版本没变 → 旧国名点原样返回 → 用户看到名字赖着不走 ✓
   *   → 只有再涂一笔（走到函数末尾 ++）才换代 ✓
   *
   *   这条直接量版本号：**空结果也必须算一次新结果** ✓ */
  {
    const v0 = ex.state._blockVer | 0;
    ex.rebuildPaintBlocks(false);
    const v1 = ex.state._blockVer | 0;
    ok('空色块重建也会换版本号（旧国名缓存不会再赖着 ✓）',
       v1 > v0, `paintBlocks=${(ex.state.paintBlocks || []).length} · ${v0} → ${v1}`);
  }

  // 报错日志：log.js 得**真的拼进单文件**，而且 boot 完已经有东西可导 ✓
  // 漏拼的话 app.js 那边是个空壳、编辑器照常跑 —— 这种"功能悄悄没了"
  // 比报错难发现得多 ✗ 所以让自检盯着它
  const log = env.sandbox && env.sandbox.window && env.sandbox.window.PDXLOG;
  ok('报错日志模块在（log.js 拼进单文件了）', !!(log && typeof log.text === 'function'));
  const logTxt = log && typeof log.text === 'function' ? log.text() : '';
  ok('日志里有启动轨迹和地图信息（不是个空壳）',
     /\[5\] 事件时间线/.test(logTxt) && /就绪/.test(logTxt) && /\[2\] 运行状态/.test(logTxt),
     logTxt ? `'${logTxt.split(/\r?\n/).find((l) => /版本戳/.test(l)) || ''}'` : '');
  /* 🔴 **启动页就能导出诊断报告** ✗（2026-10-17）
   *   编辑器自己没起来时，顶栏「导出日志」根本挂不上 —— 所以按钮必须由
   *   **log.js 自己绑定**，而且按钮得真的在烤出来的 HTML 里 ✓ */
  {
    const htmlText = fs.readFileSync(HTML, 'utf8');
    const flat = H.readStandalone(HTML).js;
    ok('启动页有「导出诊断报告」按钮，且由 log.js 自己绑定（不依赖 app.js ✓）',
       /id="btn-boot-log"/.test(htmlText)
       && /function bindBootExport/.test(flat)
       && /btn-boot-log/.test(flat),
       '按钮=' + /id="btn-boot-log"/.test(htmlText)
       + ' 绑定=' + /function bindBootExport/.test(flat));
    const bb = env.get('btn-boot-log');
    if (bb && typeof bb.dispatchEvent === 'function') {
      bb.dispatchEvent({ type: 'click', preventDefault() {} });
      ok('启动页按钮点了真能生成报告（不是死按钮 ✓）',
         bb.textContent === '已导出', `按钮文字：${bb.textContent}`);
    }
    ok('产物里有构建戳（打包时间，不是 dev ✗）',
       /<meta name="pdx-build" content="\d{4}-\d{2}-\d{2} \d{2}:\d{2}">/.test(htmlText),
       (htmlText.match(/<meta name="pdx-build"[^>]*>/) || ['没找到'])[0]);
  }

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

  /* ---- 导入式地图（见 docs/导入式地图-策划.md）----
     pack.js / packstore.js / data.js 的第三数据源都是**新加的模块**，
     拍平清单漏一个，功能就悄悄没了（页面照常跑，只是"导入"那颗按钮点了没反应）✗
     这种"少拼一个文件"是最容易发生的回归，所以这里点名盯着它 ✓ */
  ok('拍平脚本里有校验器（pack.js 拼进去了）',
     /function validatePack/.test(js) && /class Sha256/.test(js));
  ok('拍平脚本里有仓库（packstore.js 拼进去了）',
     /function importPack/.test(js) && /function putPack/.test(js));
  ok('data.js 的第三数据源在（setPackMap 拼进去了）', /function setPackMap/.test(js));
  ok('HTML 里有选文件的 input（点「导入地图包」要有地方选）', /id="pack-file"/.test(html));
  /* ⚠ `application/octet-stream` **不许从 accept 里掉出去** ✗
     （2026-10-12 用户报的"手机上没法把 pdxmap 识别为可导入文件"：
      `.pdxmap` 是自定义扩展名 → 类型是 octet-stream → 安卓按 MIME 过滤就把它灰掉 ✓） */
  ok('选文件的 accept 里留着 application/octet-stream（不然手机上选不了 .pdxmap ✗）',
     /id="pack-file"[\s\S]{0,200}?accept="[^"]*application\/octet-stream/.test(html),
     (html.match(/id="pack-file"[\s\S]{0,160}?accept="[^"]*"/) || ['没找到'])[0].replace(/\s+/g, ' '));
  /* ⚠ 动态 import 在单文件版里是**死路**：file:// 下 import() 会被拦掉 ✗
     拍平只认得行首那种静态 import，所以产物里一个都不该有 ✓ */
  ok('拍平脚本里没有动态 import（那在 file:// 下必炸）', !/await\s+import\s*\(/.test(js));

  // 选图界面上那颗入口（点了会去开选文件那个 input）
  const importBtn = env.get('map-import');
  ok('单文件版的选图界面也有「导入地图包」（导入的是库里的，不占内嵌体积）',
     !!importBtn && typeof importBtn.onclick === 'function');
  ok('入口下面平时不摆说明文字（存的住的时候不啰嗦 ✓）',
     !((env.get('map-import-hint') || {}).textContent || '').trim()
     && (env.get('map-import-hint') || {}).hidden === true,
     (env.get('map-import-hint') || {}).textContent || '（空的 ✓）');
  // 卡片数不受影响：导入入口是**另一个按钮**，不混进卡片列表 ✓
  ok('导入入口没有算进"地图卡片"里（换游戏那几条断言才不会错位）',
     cards.every((c) => !/导入地图包/.test(c.flat())));

  /* ⚠ `hidden` 必须真的能藏住 ✗
     这条守卫是被玩家逮到之后补的：选图那页那个「⋯」管理面板
     （`.pack-menu { display: flex }`，2026-10-12 已经连元素带样式整个拆了 ✓）
     把我们自己的 hidden 属性压过去了 → **一进编辑器就浮在屏幕正中间，而且关不掉** ✓
     （手机版的改名窗踩过同一个坑，所以这次提到全局做兜底）
     假 DOM 不做 CSS，行为测不出来 —— 所以这条只能靠"扫样式表"：
     兜底那条在，**任何**浮层就不会再犯这个错 ✓ */
  ok('样式表里有 [hidden] 兜底（"浮层关不掉"那个 bug 的守卫）',
     /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(html),
     /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(html) ? '[hidden] { display: none !important }' : '没有 ✗');

  /* ---- 导入的地图包：在**烤好的产物**里也整条走一遍 --------------------------
     跟 check_import.js 那条不一样：那边是开发版（走服务、没有内嵌数据），
     这边是真正发给玩家的那个文件 —— **内嵌的七套图和导入的包同时在** ✗
     两个数据源要是打架（比如切包时没把内嵌那份让开），只有这里看得见 ✓
     没有测试包就跳过（它不在仓库里，是 pack_map.py 现打的） */
  const packPath = testPack;
  if (packPath && typeof ex.importPack === 'function') {
    console.log('\n---- 单文件版里导入一个地图包 ----');
    // root 给上：轻量版要拿 data_eu4/ 目录那份当参照物（走桩的 fetch ✓）
    const env2 = H.makeEnv({ embedded, root: H.ROOT });
    const ex2 = H.instantiate(js, env2);
    const r = await ex2.importPack(new Blob([fs.readFileSync(packPath)]), {});
    ok('单文件版里能导入地图包', !!r.key, r.key);

    /* 贴着"另一个来源的那份"比：这是"包里放的就是同一个东西"最硬的证据 ✓
       全量版跟**内嵌**那份比；轻量版没有内嵌的，就跟 **data/ 目录**那份比 ✓
       （两边都是同一套 EU4 数据，只是来源不同 ✓） */
    let refTm; let refAdj; let refTitles; let refMeta; let refName;
    if (lite) {
      ex2.setDataDir('/data_eu4');
      refName = 'data_eu4/ 目录';
    } else {
      ex2.setEmbeddedMap('eu4');
      refName = '内嵌那份';
    }
    try {
      refTm = await ex2.api.titlemap();
      refAdj = await ex2.api.adjacency();
      refTitles = await ex2.api.titles();
      refMeta = await ex2.api.meta();
    } catch (e) {
      refTm = null; refAdj = null; refTitles = null; refMeta = null;
      console.log(`  （参照物读不到：${e.message}）`);
    }
    ex2.setPackMap(r.key);
    const packTm = await ex2.api.titlemap();
    const packAdj = await ex2.api.adjacency();
    const packTitles = await ex2.api.titles();
    const packMeta = await ex2.api.meta();
    ok(`导入的包和${refName}逐字节一致（titlemap）`, sameArr(refTm, packTm), `${packTm.length} 项`);
    ok(`导入的包和${refName}逐字节一致（adjacency）`, sameArr(refAdj, packAdj), `${packAdj.length} 字节`);
    /* **国家 / 地区以及它们的颜色也在包里**（廿九点名要的那件事）——
       名字、颜色、层级、父级、每层归属个数都在 titles.json 里 ✓
       这条以前没验：只比了"归属图"和"邻接"，名字和颜色要是丢了就悄悄丢了 ✗ */
    const tDiff = titlesDiff(refTitles, packTitles);
    ok(`导入的包和${refName}一致（头衔表：名字 + 颜色 + 层级 + 父级）`,
       tDiff === null,
       tDiff || `${packTitles.keys.length} 个头衔 · ${packTitles.colors.length} 条颜色 · `
         + `${(packMeta.tierNames || []).length} 层（${(packMeta.tierNames || []).join('/')}）`);
    ok('切到包之后别的来源让开了（两个数据源不打架）', ex2.isPackMap() === true);

    // 再来一次真启动：选单里"原有的 + 刚导入的"，点导入那张能进去
    const booting2 = ex2.boot();
    for (let i = 0; i < 3000 && !env2.get('map-pick-list').children.length; i++) {
      await new Promise((rr) => setImmediate(rr));
    }
    const cards2 = env2.get('map-pick-list').children;
    /* 基准 = "本来就有几张"：全量版是内嵌那几套，轻量版是 0 ✓
       （别拿上面那个 cards.length 当基准 ✗ 轻量版的 cards 里是**导进来的那一张**，
         不是"本来有的"） */
    const baseCards = lite ? 0 : keys.length;
    ok(`选单里是「原有的 ${baseCards} 张 + 导入的 1 张」`, cards2.length === baseCards + 1,
      `${baseCards} → ${cards2.length} 张`);
    /* ⚠ 认卡不能只认名字 ✗ ——
       全量版里内嵌的 EU4 卡也叫「EU4 原版」，而且在列表前面 ——
       只按名字找会点到**内嵌那张**，然后"进去的确实是那张包"就会假红 ✓
       ⚠ 2026-10-12 起那一栏上不写「已导入」了 ✗ —— 改认卡片的 `imported` 类
       （内嵌的卡没有这个类，也没有"导出 / 删除"那两个动作 ✓）*/
    const isPackCard = (c) => /(^| )imported( |$)/.test(c.className || '');
    const packCard = cards2.find((c) => isPackCard(c) && /EU4/.test(c.flat()))
      || cards2.find(isPackCard);
    ok('导入的那张排在选单里', !!packCard);
    if (packCard) packCard.onclick();
    await booting2;
    ok('点导入的那张能起到「就绪」',
      /就绪/.test((env2.get('boot-step') || {}).textContent || ''),
      (env2.get('boot-step') || {}).textContent || '');
    ok('进去的确实是那张包', ex2.isPackMap() === true);
  } else {
    console.log('\n---- 跳过"单文件版里导入"（没有 _local/packs/ 里的测试包）----');
  }

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
    /* ⚠ 地块号从数据里现取（同 check_mobile）—— 测试包省份数不同，
       写死 11 在小包上就是越界，断言全变 undefined 误报 ✗ */
    const paintPid = Math.max(1, Math.min(11, (ex.state.meta.numProvinces || 2) - 2));
    r.setPaint(paintPid, 200, 30, 40, 255);
    r.setPaintLabel(paintPid, 7);
    ok('（预备）渲染器在、笔迹写得进去', !!(r.provTex && r.paintData[paintPid * 4] === 200));

    cv.dispatchEvent({ type: 'webglcontextlost', preventDefault() {} });
    ok('丢上下文：接住了（preventDefault）+ 停画',
       r.ctxLost === true && r.dirty === false, `ctxLost=${r.ctxLost} dirty=${r.dirty}`);

    cv.dispatchEvent({ type: 'webglcontextrestored' });
    for (let i = 0; i < 400 && !r.provTex; i++) await new Promise((res) => setImmediate(res));
    ok('回来：地图数据重新喂进去了（省份图 / 归属表 / 颜色表 / 手绘层）',
       !!(r.provTex && r.titleTex && r.colorTex && r.paintTex && r.paintLabelTex),
       `prov=${!!r.provTex} title=${!!r.titleTex} color=${!!r.colorTex} paint=${!!r.paintTex}`);
    ok('**笔迹没被重喂擦掉**（颜色 + 标记都还在）',
       r.paintData[paintPid * 4] === 200 && r.paintData[paintPid * 4 + 3] === 255
       && r.paintLabelData[paintPid] === 7,
       `rgba=${r.paintData[paintPid * 4]},${r.paintData[paintPid * 4 + 1]},${r.paintData[paintPid * 4 + 2]},`
       + `${r.paintData[paintPid * 4 + 3]} · label=${r.paintLabelData[paintPid]}`);
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

  /* ---- **`viewTierFor(pid)` 的每一处，作用域里都得真有 `pid`** ✗✗ ----
   *
   * 2026-10-14 用户当场抓的：`Uncaught ReferenceError: pid is not defined`
   *   at `positionHoverCard` —— 我批量替换 `labelTier()` → `viewTierFor(pid)`
   *   时没看作用域 ✗ 那个函数**没有 pid 参数**（该用 `state.hover.pid` ✓）
   *   → 整个悬停卡片直接崩 ✓ 而**现有自检全绿** ✗（没有一条覆盖悬停）
   *
   * 所以补这一条：静态扫源码，逐个 `viewTierFor(pid)` 往上看最近的函数，
   * 要么它有 `pid` 参数、要么函数体里有 `const/let/var pid` ✓
   * ⚠ 这条只查"有没有"，不查"取的是不是**当前**那一格" ✗（那是语义 ✓ 靠人看 ✓）
   */
  /* ---- **产物里不许留 `<script src=...>`** ✗✗ ----
   *
   * 2026-10-14 用户报的：`Failed to load resource: net::ERR_FILE_NOT_FOUND tutorial.js:1`
   *   根因：`web/index.html` 有三句 script（log.js / tutorial.js 是**传统脚本** ✓
   *     app.js 是模块入口 ✓），而 `build_standalone.py` 只替换了**模块那一句** ✗
   *     → 单文件版去抓旁边不存在的 `js/log.js` / `js/tutorial.js` ✓ 控制台报错 ✓
   *   ⚠ 这两句的代码**早就内联进产物了** ✓ 所以它们只剩坏处 ✓
   * 这条就是守着它别再回来 ✓
   */
  {
    const raw = fs.readFileSync(HTML, 'utf8');
    const hits = raw.match(/<script[^>]*\ssrc=/g) || [];
    ok('产物里没有 <script src=...>（单文件版不该再去抓外部 js）',
       hits.length === 0, hits.length ? hits.slice(0, 3).join(' ') : '一句都没有 ✓');
  }

  /* 🔴 **白屏 / 闪退那几条护栏必须在产物里**（2026-10-23）
   *   这些代码都在 app.js / log.js 里，单文件版是拼进去的 ——
   *   这条守着"改了源码忘了重打"（用户拿到的是旧产物，等于没修 ✓） */
  {
    const raw = fs.readFileSync(HTML, 'utf8');
    const need = [
      ['启动看门狗', /没能启动/],
      ['导出内存预算', /function exportBudgetTight/],
      ['iOS 画布上限', /function isAppleTouch/],
      ['导出看门狗', /function exportBlob/],
      ['启动完成标志', /__PDX_BOOTED/],
    ];
    const miss = need.filter(([, re]) => !re.test(raw)).map(([n]) => n);
    ok('白屏 / 闪退那几条护栏都打进产物了 ✓', miss.length === 0,
       miss.length ? '缺：' + miss.join(' / ') : need.map(([n]) => n).join(' · '));
  }

  {
    const src = fs.readFileSync(path.join(H.ROOT, 'web/js/app.js'), 'utf8').split('\n');
    const bad = [];
    for (let i = 0; i < src.length; i++) {
      const ln = src[i];
      if (!/viewTierFor\(pid\)/.test(ln)) continue;
      if (/^\s*[*/]/.test(ln)) continue;                 // 注释行不算 ✓
      let fn = null;
      let args = '';
      let start = 0;
      for (let j = i; j >= 0; j--) {
        const m = /^\s*function\s+(\w+)\s*\(([^)]*)\)/.exec(src[j]);
        if (m) { fn = m[1]; args = m[2]; start = j; break; }
      }
      const hasArg = /\bpid\b/.test(args);
      let hasLocal = false;
      for (let k = start; k < i; k++) {
        if (/(const|let|var)\s+pid\b/.test(src[k])) { hasLocal = true; break; }
      }
      if (!hasArg && !hasLocal) bad.push(`L${i + 1} ${fn || '?'}()`);
    }
    ok('viewTierFor(pid) 的每一处，作用域里都有 pid（不然悬停直接崩）',
       bad.length === 0, bad.length ? bad.join(' · ') : `${src.filter((l) => /viewTierFor\(pid\)/.test(l)).length} 处全有`);
  }

  /* 🔴 **白昼模式：不透明度那四块要分得清谁是谁** ✗✗（2026-10-27 用户：
   *   "白昼模式下不透明度块块根本看不见谁是谁"）
   *
   *   根因：`html[data-theme="light"] .ctl-seg > button` 跟 `.ctl-seg > button.on`
   *   权重一样、但写在后面 ✗ → 选中块的 background/color 被盖成"普通按钮" ✓
   *   → 四块一模一样，看不出 25 / 50 / 75 / 100 哪档亮着 ✓
   *
   *   判据：日间必须有一条**后写的** `.ctl-seg > button.on`，
   *   而且真的写了背景 / 字色 / 内圈 ✓（只改字色也会在浅底上糊掉 ✓） */
  {
    const raw = fs.readFileSync(HTML, 'utf8');
    const m = /html\[data-theme="light"\] \.ctl-seg > button\.on\s*\{([^}]*)\}/.exec(raw);
    const body = m ? m[1] : '';
    ok('白昼模式：不透明度分段条的选中块看得出来（底 / 字 / 内圈 ✓）',
       !!m && /background\s*:/.test(body) && /color\s*:/.test(body) && /box-shadow\s*:/.test(body),
       m ? '有日间选中态 ✓' : '没有日间选中态 ✗ 四块长得一样');
  }

  /* 🔴 **清除之后，色块名单必须立刻变空** ✗✗（2026-10-27 用户：
   *   "清除功能和橡皮工具点了之后国名仍然没消失，需要画一下才刷新"）
   *
   *   上面那条验的是"空重建也换代" ✓ 这条直接验**用户看到的结果**：
   *     涂一笔 → 名单有名字 ✓ → 全清 → 名单必须当场 0 条 ✓
   *   旧代码在"清空后重建"那一步会命中 early return、版本不换代 ✓
   *   `blockLabelPoints()` 拿着上一版的缓存 → 国名原样复活 ✓
   *
   *   ⚠ 放在最后：这里会把测试图上的涂色清掉 ✓ 不影响前面的断言 ✓ */
  {
    const nProv = ex.state.meta ? ex.state.meta.numProvinces : 0;
    const nTier = (ex.state.meta && ex.state.meta.tiers || []).length;
    let tid = -1;
    for (let p = 1; p < Math.min(nProv, 300); p++) {
      const t = ex.titleAt(p, nTier - 1);
      if (t != null && t >= 0) { tid = t; break; }
    }
    if (tid >= 0 && nProv > 1) {
      ex.paintTitle(tid, [200, 40, 40], true, false);
      ex.rebuildPaintBlocks(false);
      const paintedPts = (ex.blockLabelPoints() || []).length;
      const pd = ex.renderer && ex.renderer.paintData;
      const all = [];
      for (let p = 1; p < nProv; p++) if (pd && pd[p * 4 + 3] > 0) all.push(p);
      ex.paintPids(all, null);                 // 全清
      ex.rebuildPaintBlocks(false);            // 清完立刻重建（正是出问题那步）
      const emptyPts = (ex.blockLabelPoints() || []).length;
      ok('清除后色块名单立刻清空（不是等下一次涂色 ✓）',
         paintedPts > 0 && emptyPts === 0,
         `涂色后 ${paintedPts} 条 → 清除后 ${emptyPts} 条`);
    } else {
      console.log('  （这张图找不到可涂头衔，跳过"清除后名单清空"检查）');
    }
  }

  /* 🔴 **切空白剧本 / 无剧本，国名名单也要立刻清空** ✗✗（2026-10-27 用户）
   *   和上面"清除"同一个根：空重建不换代 → `blockLabelPoints()` 的旧缓存复活 ✓
   *   这里走真实入口 `setTier()` + 对应的 `rebuildPaintBlocks(all)` ✓
   *   ⚠ 放在最后：只动层级，不动涂色（前面已经清空了）✓ */
  {
    const nEra = ex.eraTierCount();
    const nTier = (ex.state.meta && ex.state.meta.tiers || []).length;
    const names = (ex.state.meta && ex.state.meta.tierNames) || [];
    const blankIdx = names.findIndex((n) => /空白/.test(String(n || '')));
    if (nEra > 0 && nTier > nEra) {
      ex.setTier(0);
      ex.rebuildPaintBlocks(true);            // 1444 那层：没涂也按原版国名分组 ✓
      const eraPts = (ex.blockLabelPoints() || []).length;
      const blank = blankIdx >= 0 ? blankIdx : nEra;
      ex.setTier(blank);
      ex.rebuildPaintBlocks(true);            // 空白剧本：全是无主地 → 空 ✓
      const blankPts = (ex.blockLabelPoints() || []).length;
      ex.setTier(nTier - 1);
      ex.rebuildPaintBlocks(false);           // 无剧本（地理层）：只画涂过的 → 空 ✓
      const noEraPts = (ex.blockLabelPoints() || []).length;
      ok('切空白剧本 / 无剧本后，国名名单立刻清空（不用再画一下 ✓）',
         eraPts > 0 && blankPts === 0 && noEraPts === 0,
         `剧本 ${eraPts} 条 → 空白 ${blankPts} 条 → 无剧本 ${noEraPts} 条`);
    } else {
      console.log('  （这张图没有剧本层，跳过"切空白 / 无剧本"检查）');
    }
  }

  /* 🔴 **「清除全部」要能撤销** ✗✗（2026-10-27 用户定：v1.10.1 加这一条）
   *   旧代码点完直接清空撤销栈 ✓ 误触就真没了 ✓
   *   新代码走 `paintPidsAsOne` → 一步历史 → Ctrl+Z 能回来 ✓ */
  {
    const nProv = ex.state.meta ? ex.state.meta.numProvinces : 0;
    const nTier = (ex.state.meta && ex.state.meta.tiers || []).length;
    let tid = -1;
    for (let p = 1; p < Math.min(nProv, 300); p++) {
      const t = ex.titleAt(p, nTier - 1);
      if (t != null && t >= 0) { tid = t; break; }
    }
    const pd = ex.renderer && ex.renderer.paintData;
    if (tid >= 0 && pd) {
      ex.paintTitle(tid, [200, 40, 40], true, false);
      let pid = 0;
      for (let p = 1; p < nProv; p++) if (pd[p * 4 + 3] > 0) { pid = p; break; }
      const undo0 = ex.state.history.undo.length;
      if (pid) ex.resetAll();
      const undo1 = ex.state.history.undo.length;
      const cleared = pid ? pd[pid * 4 + 3] : -1;
      if (pid) ex.undo();
      const back = pid ? pd[pid * 4 + 3] : -1;
      ok('「清除全部」记为一步撤销，Ctrl+Z 能恢复涂色',
         !!pid && undo1 > undo0 && cleared === 0 && back > 0,
         `undo ${undo0}→${undo1} · 清除后 alpha=${cleared} · 撤销后 alpha=${back}`);
    } else {
      ok('「清除全部」记为一步撤销，Ctrl+Z 能恢复涂色', false, '找不到可涂头衔 ✗');
    }
  }
  /* 2026-10-27 v1.10.1：保存地图默认名 ✓ */
  {
    const name = ex.defaultSaveName ? ex.defaultSaveName() : '';
    ex.openSaveMapDialog();
    const inp = env.get('save-map-name');
    const box = env.get('save-map');
    ok('保存地图弹窗预填了「地图名 · 日期」并全选',
       /^.+ · \d{1,2}月\d{1,2}日$/.test(name) && !!inp && inp.value === name && !!box && box.hidden === false,
       `默认名="${name}" · input="${inp ? inp.value : '(没有)'}"`);
    if (box) box.hidden = true;
  }

  /* 2026-10-27：导出整图合并成「规格 + 范围 + 进度」✓ */
  {
    const raw = fs.readFileSync(HTML, 'utf8');
    const need = [
      ['只有一个「导出整图」', /id="btn-png-full">导出整图</],
      ['没有旧的「导出高清地图」', /^(?![\s\S]*btn-png-full2)/],
      ['四档倍率', /data-scale="0\.5"[\s\S]*data-scale="1"[\s\S]*data-scale="2"[\s\S]*data-scale="3"/],
      ['倍率 / 分辨率分开', /export-label">倍率[\s\S]*export-size-label">分辨率/],
      ['范围只有全图 / 框选', /data-range="full"[^>]*>全图[\s\S]*data-range="part"[^>]*>框选/],
      ['没有多余的「在图上框选」', /^(?![\s\S]*id="export-pick")/],
      ['没有多余的「默认整张地图」', /^(?![\s\S]*id="export-rect")/],
      ['没有倍率提示行', /^(?![\s\S]*点上面的倍率快速选)/],
      ['框选三键：取消 / 重选 / 确定', /id="export-pick-cancel"[^>]*>取消[\s\S]*id="export-pick-redo"[^>]*>重选[\s\S]*id="export-pick-ok"[^>]*>确定/],
      ['框选三键加大', /\.export-pick-bar \.btn\s*\{[^}]*height:\s*40px[^}]*font-size:\s*13px/],
      ['宽 / 高可以直接填', /id="export-w"[\s\S]*id="export-h"/],
      ['进度条', /id="export-prog-bar"/],
      ['停止按钮', /id="export-stop"/],
    ];
    const miss = need.filter(([, re]) => !re.test(raw)).map(([n]) => n);
    ok('导出整图弹窗的规格 / 范围 / 进度都打进产物了 ✓', miss.length === 0,
       miss.length ? '缺：' + miss.join(' / ') : '四档 · 两种范围 · 进度 · 停止');
  }

  {
    ex.openExportDialog();
    const modal = env.get('export-map');
    const m = ex._exportMetrics ? ex._exportMetrics() : null;
    ok('「导出整图」弹窗能打开，默认 1× 整张',
       !!modal && modal.hidden === false
       && env.get('export-form').hidden === false
       && !!m && m.scale === 1 && m.part === false && !m.why,
       m ? `默认 ${m.OW}×${m.OH} · ${m.needMB} MB` : '没有 metrics');
    if (!modal) return;
    /* 2026-10-27：默认 1× 整图把分块放宽到一整块（5632 宽的 EU4 少切一刀 ✓） */
    {
      const t1 = ex._exportTileSize ? ex._exportTileSize(1, { w: 5632, h: 2048 }) : 0;
      const t2 = ex._exportTileSize ? ex._exportTileSize(2, { w: 5632, h: 2048 }) : 0;
      ok('默认 1× 整图只切一块（2× 仍按安全分块 ✓）',
         t1 === 5632 && t2 === 2048,
         t1 ? `1× ${t1}px/块 · 2× ${t2}px/块` : '没有 tile size');
    }
    if (ex.exportFontPx) {
      ok('导出只收 >15px 的字，并且字号按整像素画 ✓',
         ex.exportFontPx(15) === 0 && ex.exportFontPx(15.1) === 16
         && ex.exportFontPx(20.2) === 21,
         `15→${ex.exportFontPx(15)} · 15.1→${ex.exportFontPx(15.1)} · 20.2→${ex.exportFontPx(20.2)}`);
    }
    /* 桩不解析 #export-map 的子树 ✗ 按钮点不到 —— 直接验状态机本身 ✓
       （HTML 里四档按钮 / 两种范围另有静态断言 ✓） */
    /* ⚠ 期望尺寸按**这张图自己的宽高**算 ✗（以前写死 5632×2048 的 EU4 数，
     *   夹具图上必红 ✓ 2026-10-27）*/
    const MW = (ex.state.meta && ex.state.meta.mapWidth) || 5632;
    const MH = (ex.state.meta && ex.state.meta.mapHeight) || 2048;
    ex._exportDlg.scale = 3;
    ex._exportDlg.range = 'full';
    ex._exportDlg.rect = null;
    ex._exportRefresh();
    const m3 = ex._exportMetrics ? ex._exportMetrics() : null;
    /* ⚠ 大地图 3× 是**真的**会超预算（CK3 9216×4608 → 27648×13824 ≈ 3.8 亿像素）✗
     *   那不是误拦 —— 只要 why 说的是"预算 / 画布上限"就放行 ✓
     *   小图（EU4 那档）仍要求不拦 ✓ */
    ok('桌面 3× 整张：尺寸按倍率算，超预算 / 画布上限才拦 ✓',
       !!m3 && m3.scale === 3 && m3.OW === MW * 3 && m3.OH === MH * 3
       && (!m3.why || /预算|画布上限/.test(m3.why)),
       m3 ? `${m3.OW}×${m3.OH} · ${m3.needMB} MB / ${m3.capMB} MB`
            + (m3.why ? ' · ' + m3.why : ' · 不拦') : '没有 metrics');
    const pw = Math.max(1, Math.floor(MW * 0.6));
    const ph = Math.max(1, Math.floor(MH * 0.6));
    ex._exportDlg.scale = 2;
    ex._exportDlg.rect = { x: 0, y: 0, w: pw, h: ph };
    ex._exportDlg.range = 'part';
    ex._exportRefresh();
    const m2 = ex._exportMetrics ? ex._exportMetrics() : null;
    ok('2× + 框选后输出尺寸真的按倍率 / 矩形算（不是只换样式）',
       !!m2 && m2.scale === 2 && m2.OW === pw * 2 && m2.OH === ph * 2
       && /预计 \d+ MB 内存/.test(env.get('export-info').textContent || '')
       && !/输出|(?:^|\D)2×/.test(env.get('export-info').textContent || ''),
       m2 ? `${m2.OW}×${m2.OH} · ${env.get('export-info').textContent}` : '没有 metrics');
    /* 2026-10-27：宽 / 高可以直接填，另一边按比例自动跟 ✓
       ⚠ 填的数按地图尺寸封顶（≤ 8×）✗ —— 夹具图填 8000 会直接超上限（2026-10-27）*/
    const tw = Math.max(1, Math.min(8000, Math.floor(MW * 7.2)));
    const eh = Math.max(1, Math.round(MH * tw / MW));
    ex._exportDlg.range = 'full';
    ex._exportDlg.rect = null;
    ex._exportDlg.scale = 1;
    ex._exportDlg.sizeBad = false;
    ex._exportSizeInput('w', String(tw));
    const mw = ex._exportMetrics ? ex._exportMetrics() : null;
    ok('宽/高能直接填：写宽，高按地图比例自动算 ✓',
       !!mw && mw.OW === tw && mw.OH === eh
       && env.get('export-w').value === String(tw)
       && env.get('export-h').value === String(eh)
       && /预计 \d+ MB 内存/.test(env.get('export-info').textContent || '')
       && !new RegExp(tw + ' × ' + eh + '|输出').test(env.get('export-info').textContent || ''),
       mw ? `${mw.OW}×${mw.OH} · ${mw.scale} · ${env.get('export-info').textContent}` : '没有 metrics');
    ex._exportSizeInput('w', '999999');
    const mBad = ex._exportMetrics ? ex._exportMetrics() : null;
    ok('填得离谱会当场拦住（倍率超过 8×，导出键变灰 ✓）',
       !!mBad && !!mBad.why && ex._exportDlg.sizeBad === true
       && env.get('export-start').disabled === true,
       mBad ? mBad.why : '没有 metrics');
    const th = Math.max(1, Math.min(3000, Math.floor(MH * 7.2)));
    const ew2 = Math.max(1, Math.round(MW * th / MH));
    ex._exportSizeCommit();
    ex._exportSizeInput('h', String(th));
    const mh = ex._exportMetrics ? ex._exportMetrics() : null;
    ok('改高也行：写高，宽自动跟 ✓',
       !!mh && mh.OH === th && mh.OW === ew2
       && env.get('export-w').value === String(ew2),
       mh ? `${mh.OW}×${mh.OH}` : '没有 metrics');
    ex._exportDlg.scale = 1;
    ex._exportDlg.sizeBad = false;
    ex._exportRefresh();
    ex._exportPickStart();
    ok('「框选一部分」会直接进框选层（弹窗先让开）',
       env.get('export-pick-layer').hidden === false && modal.hidden === true);
    const handles = (html.match(/data-handle="(?:nw|n|ne|e|se|s|sw|w)"/g) || []).length;
    ok('框选层有八个把手（四角 + 四边，能像绘图软件那样调 ✓）',
       handles === 8, `${handles} 个`);
    /* ⚠ 框选矩形按地图比例取 ✗ —— 写死 100~500 的话，96×48 的夹具图会被
     *   clamp 成 0×0（2026-10-27）*/
    const ax = Math.max(1, Math.round(MW * 0.1));
    const ay = Math.max(1, Math.round(MH * 0.1));
    const bx2 = Math.max(ax + 4, Math.round(MW * 0.6));
    const by2 = Math.max(ay + 4, Math.round(MH * 0.6));
    const ew = bx2 - ax, eh3 = by2 - ay;
    const nr = ex._exportPickNorm({ x: ax, y: ay }, { x: bx2, y: by2 });
    ex._exportPickState.rect = nr;
    ex._exportPickRender();
    ok('框选会显示尺寸角标，确认键也能点 ✓',
       env.get('export-pick-box').hidden === false
       && env.get('export-pick-size').textContent === `${ew} × ${eh3} px`
       && env.get('export-pick-ok').disabled === false,
       `${env.get('export-pick-size').textContent} · ok=${!env.get('export-pick-ok').disabled}`);
    const sx = Math.max(2, Math.round(MW * 0.1));
    const sy = Math.max(2, Math.round(MH * 0.1));
    const sw = Math.max(20, Math.floor(MW * 0.4));
    const sh = Math.max(16, Math.floor(MH * 0.4));
    const rr = ex._exportPickResizeRect(
      { x: sx, y: sy, w: sw, h: sh }, 'nw',
      { x: sx + 7, y: sy + 5 }, { w: 10, h: 10 });
    ok('拖左上把手会改 x / y / 宽 / 高（不是只重画边框 ✓）',
       !!rr && rr.x === sx + 7 && rr.y === sy + 5
       && rr.w === sw - 7 && rr.h === sh - 5,
       rr ? `${rr.x},${rr.y} · ${rr.w}×${rr.h}` : '没有返回');
    ex._exportPickConfirm();
    ok('确认框选后回到弹窗，并把范围写回导出参数 ✓',
       modal.hidden === false && env.get('export-pick-layer').hidden === true
       && !!ex._exportDlg.rect && ex._exportDlg.rect.x === ax
       && ex._exportDlg.rect.w === ew && ex._exportDlg.rect.h === eh3
       && ex._exportDlg.range === 'part',
       ex._exportDlg.rect ? JSON.stringify(ex._exportDlg.rect) : '没有 rect');
    /* 收尾：别把 picking / 框选状态留给后面的断言 ✓ */
    ex._exportDlg.picking = false;
    ex._exportDlg.rect = null;
    ex._exportDlg.range = 'full';
    ex._exportDlg.scale = 1;
    env.get('export-pick-layer').hidden = true;
    modal.hidden = true;
  }

  /* 真跑一次**小范围导出**：不验像素，只验这条链能从分块渲染走到 PNG / 下载 ✓
     （桩没有 toBlob 之前这里会静默走失败分支；有假 Blob 才跑得完 ✓） */
  {
    const before = env.savedBlob;
    const seen = [];
    const res = await ex.exportFullPNG(0.5, {
      rect: { x: 0, y: 0, w: 80, h: 60 },
      onProgress: (p) => seen.push(p),
    });
    ok('整图导出链路跑得通（分块 → PNG → 下载，不中途抛错）',
       !!res && res.ok === true && env.savedBlob !== before,
       res ? `输出 ${res.OW}×${res.OH} · ${env.savedBlob ? '已有 Blob' : '没有 Blob'}` : '没有返回');
    ok('导出进度真的从 0 走到 100（不是只换文案）',
       seen.length >= 4 && seen[seen.length - 1] === 100
       && seen.every((v, i) => i === 0 || v >= seen[i - 1]),
       seen.join(' → '));
    const rc = await ex.exportFullPNG(0.5, {
      rect: { x: 0, y: 0, w: 80, h: 60 },
      shouldCancel: () => true,
    });
    ok('停止导出会返回 canceled，并且不下载半张图',
       !!rc && rc.canceled === true && rc.ok === false);
    const MW2 = (ex.state.meta && ex.state.meta.mapWidth) || 5632;
    const MH2 = (ex.state.meta && ex.state.meta.mapHeight) || 2048;
    const cw = Math.min(80, MW2), chh = Math.min(60, MH2);
    const r125 = await ex.exportFullPNG(1.25, {
      rect: { x: 0, y: 0, w: cw, h: chh },
    });
    ok('自定义倍率也能真的导出（不是只认四档 ✓）',
       !!r125 && r125.ok === true
       && r125.OW === Math.round(cw * 1.25) && r125.OH === Math.round(chh * 1.25),
       r125 ? `${r125.OW}×${r125.OH}` : '没有返回');
    /* 3× 整图直接过一遍名字绘制：记录每一条真正下笔的字号，确认没有 3px 蚂蚁字 ✓
       （走 `paintLabelsForExport`，跟导出时同一条路径 ✓） */
    let sizes = [];
    let liveFlags = [];
    let oldDraw = null;
    let ctx = null;
    const prevTier = ex.state.tier;
    const prevTitle = ex.state.showLabelsTitle;
    const prevPaint = ex.state.showLabelsPaint;
    try {
      ex.state.showLabelsTitle = true;
      ex.state.showLabelsPaint = true;
      ex.setTier(0);
      ex.rebuildPaintBlocks(true);
      ctx = env.sandbox.document.createElement('canvas').getContext('2d');
      oldDraw = ex.labels && ex.labels._drawGlyphRun;
      if (oldDraw) {
        ex.labels._drawGlyphRun = function (o) {
          if (o && Number.isFinite(o.size)) sizes.push(o.size);
          if (o) liveFlags.push(!!o.exportText);
          return oldDraw.call(this, o);
        };
      }
      const oldFill = ctx && ctx.fillText;
      if (oldFill) {
        ctx.fillText = function (...args) {
          const m = /([\d.]+)px/.exec(this.font || '');
          if (m) sizes.push(Number(m[1]));
          return oldFill.apply(this, args);
        };
      }
      const n3 = ex.paintLabelsForExport(ctx, 3) | 0;
      ok('3× 整图里下笔的名字都大于 15px（统一输出门槛 ✓）',
         n3 > 0 && sizes.length > 0 && sizes.every((v) => v > 15),
         sizes.length ? `min=${Math.min(...sizes)} · ${sizes.length} 个` : `画了 ${n3} 个但没记录到字号`);
      ok('3× 整图里的名字走实时矢量绘制（高倍不糊 ✓）',
         liveFlags.length > 0 && liveFlags.every(Boolean),
         liveFlags.length ? `${liveFlags.length} 个全走矢量 ✓` : '没记录到绘制路径');
    } catch (e) {
      ok('3× 整图里下笔的名字都大于 15px（统一输出门槛 ✓）', false,
         String(e && (e.message || e)));
    } finally {
      if (ex.labels && oldDraw) ex.labels._drawGlyphRun = oldDraw;
      ex.state.showLabelsTitle = prevTitle;
      ex.state.showLabelsPaint = prevPaint;
      ex.setTier(prevTier);
      ex.rebuildPaintBlocks(!!ex.state._blocksAll);
    }
  }

  /* ---- 图例：预览 / 排版 / 导出共用一套 ---- */
  {
    const st = ex.state;
    const stageEl = env.get('stage');
    const oldW = stageEl.clientWidth;
    const oldH = stageEl.clientHeight;
    const oldBlocks = st.paintBlocks;
    const oldPaint = ex.renderer && ex.renderer.paintData;
    const oldOn = st.legendOn;
    const oldNames = st.legendNames;
    const oldOrder = st.legendOrder;
    const oldSet = {
      legend: st.set.legend, title: st.set.legendTitle, titleOnly: st.set.legendTitleOnly,
      pos: st.set.legendPos, size: st.set.legendSize, font: st.set.legendFont,
      cols: st.set.legendCols, bg: st.set.legendBg, alpha: st.set.legendBgAlpha,
      border: st.set.legendBorder, fg: st.set.legendFg, fgAuto: st.set.legendFgAuto,
      box: st.set.legendBox,
    };
    try {
      stageEl.clientWidth = 1000;
      stageEl.clientHeight = 600;
      st.set.legend = true;
      st.set.legendTitle = '测试图例';
      st.set.legendTitleOnly = true;
      st.set.legendPos = 'br';
      st.set.legendSize = 'm';
      st.set.legendFont = 'sans';
      st.set.legendCols = 2;
      st.set.legendBg = '#ffffff';
      st.set.legendBgAlpha = 90;
      st.set.legendBorder = '#000000';
      st.set.legendFg = '#111111';
      st.set.legendFgAuto = false;
      st.set.legendBox = 'square';
      st.paintBlocks = [];
      st.legendOn = {};
      st.legendNames = {};
      st.legendOrder = [];
      ex.renderLegendOverlay();
      const ov = env.get('legend-overlay');
      const cv = env.get('legend-canvas');
      ok('图例预览会出现在地图上，并且外层真的拿到了宽高 ✓',
         ov.hidden === false && cv.width > 0 && cv.height > 0
         && parseFloat(ov.style.width) > 0 && parseFloat(ov.style.height) > 0,
         `hidden=${ov.hidden} · ${ov.style.width}×${ov.style.height} · canvas ${cv.width}×${cv.height}`);
      ok('图例选右下角时会贴到舞台右下（不是永远钉在左上 ✓）',
         parseFloat(ov.style.left) > 500 && parseFloat(ov.style.top) > 300,
         `left=${ov.style.left} · top=${ov.style.top}`);

      /* 预览和导出必须用同一组四角坐标 —— 不然设置里看着在右下，导出来跑左上 ✗ */
      const Lbr = ex.legendLayout(H.ctx2d(), 1000, 600, {
        show: true, title: '测试图例', titleOnly: true, pos: 'br', size: 'm', scale: 1,
        font: 'sans', cols: 2, bg: '#ffffff', bgAlpha: 90, border: '#000000',
        fg: '#111111', fgAuto: false, box: 'square', x: 0.04, y: 0.04,
      });
      ok('预览和导出用同一组四角坐标（不是各算一套）',
         !!Lbr && Math.abs(parseFloat(ov.style.left) - Lbr.x) <= 1
         && Math.abs(parseFloat(ov.style.top) - Lbr.y) <= 1,
         Lbr ? `预览 ${ov.style.left}/${ov.style.top} · 导出 ${Lbr.x}/${Lbr.y}` : '没有排版');

      /* 5 个色块、2 列：应排成 3 行；标题单列时不排条目 */
      ex.renderer.paintData = null;
      st.paintBlocks = [1, 2, 3, 4, 5].map((i) => ({
        name: '色块' + i, rgb: [i * 30, 100, 200 - i * 20], area: i * 100, pids: [i], tid: i,
      }));
      st.legendTitle = '图例';
      st.legendTitleOnly = false;
      st.set.legendTitleOnly = false;
      const opts = {
        show: true, title: '图例', titleOnly: false, pos: 'tl', size: 'm', scale: 1,
        font: 'sans', cols: 2, bg: '#ffffff', bgAlpha: 90, border: '#000000',
        fg: '#111111', fgAuto: false, box: 'square', x: 0.04, y: 0.04,
      };
      const c2 = H.ctx2d();
      const L = ex.legendLayout(c2, 1000, 600, opts);
      ok('图例按列数排（5 个条目 2 列 → 3 行 ✓）',
         !!L && L.cols === 2 && L.rows === 3 && L.count === 5,
         L ? `${L.cols} 列 · ${L.rows} 行 · count=${L.count}` : '没有排版');
      const n = ex.drawLegend(c2, 1000, 600);
      ok('图例绘制真的画了 5 条（不是只排了个空框 ✓）', n === 5, `画了 ${n} 条`);
      const blocks9 = Array.from({ length: 9 }, (_, i) => ({
        name: '色块' + (i + 1), rgb: [i * 20, 60 + i * 10, 190 - i * 10], area: 900 - i, pids: [i + 1], tid: i + 1,
      }));
      const savedBlocks = st.paintBlocks;
      st.paintBlocks = blocks9;
      const L8 = ex.legendLayout(c2, 1000, 600, Object.assign({}, opts, { cols: 8 }));
      st.paintBlocks = savedBlocks;
      ok('列数上限是 8（9 个条目选 8 列 → 8 列 2 行，不会被悄悄截成 6 ✓）',
         !!L8 && L8.cols === 8 && L8.rows === 2,
         L8 ? `${L8.cols} 列 · ${L8.rows} 行` : '没有排版');
      st.legendTitleOnly = true;
      const Lt = ex.legendLayout(c2, 1000, 600, Object.assign({}, opts, { titleOnly: true }));
      ok('「只显示标题」时不再排条目，但标题还在 ✓',
         !!Lt && Lt.grid.length === 0 && Lt.count === 1 && Lt.boxH > 0,
         Lt ? `grid=${Lt.grid.length} · count=${Lt.count}` : '没有排版');

      /* ---- 窄屏列数：390px 选 8 列不许把后几列画到框外 ---- */
      st.paintBlocks = Array.from({ length: 9 }, (_, i) => ({
        name: '很长很长的图例条目名字' + (i + 1), rgb: [i * 20, 60 + i, 190 - i * 10],
        area: 900 - i, pids: [i + 1], tid: i + 1,
      }));
      st.set.legendTitleOnly = false;
      const L390 = ex.legendLayout(c2, 390, 600, Object.assign({}, opts, { cols: 8 }));
      let rightMost = 0;
      if (L390) {
        for (let r = 0; r < L390.grid.length; r++) {
          for (let c = 0; c < L390.grid[r].length; c++) {
            const cell = L390.grid[r][c];
            if (!cell) continue;
            let tw = 0;
            for (const ln of cell.lines) tw = Math.max(tw, c2.measureText(ln).width);
            const shapeW = opts.box === 'rect' ? Math.round(L390.sw * 1.4) : L390.sw;
            rightMost = Math.max(rightMost, L390.pad + L390.colOffsets[c] + shapeW + L390.gap + tw);
          }
        }
      }
      ok('390px 宽选 8 列会自动收列，最后一列不出框',
         !!L390 && L390.cols >= 1 && L390.cols < 8
         && L390.boxW <= 390 - 2 * L390.M + 0.5
         && rightMost <= L390.boxW - L390.pad + 0.5,
         L390 ? `${L390.cols} 列 · boxW=${L390.boxW} · 最右=${Math.round(rightMost)}` : '没有排版');

      /* ---- 读数 / 联动：改了要看得见，不生效的要置灰 ---- */
      st.set.legendBg = '#123456';
      st.set.legendBgAlpha = 35;
      st.set.legendBorder = '#abcdef';
      st.set.legendFg = '#fedcba';
      ex.syncLegendControls(st.set);
      ok('图例三种颜色都有 HEX 读数（不再是盲盒）',
         env.get('v-set-legend-bg').textContent === '#123456'
         && env.get('v-set-legend-border').textContent === '#ABCDEF'
         && env.get('v-set-legend-fg').textContent === '#FEDCBA',
         `${env.get('v-set-legend-bg').textContent} / ${env.get('v-set-legend-border').textContent} / ${env.get('v-set-legend-fg').textContent}`);
      ok('背景透明度有百分比读数', env.get('v-set-legend-alpha').textContent === '35%',
         env.get('v-set-legend-alpha').textContent);
      st.set.legendTitleOnly = true;
      st.set.legendFgAuto = true;
      ex.syncLegendControls(st.set);
      ok('「只显示标题」时条目列表置灰、排序按钮禁用',
         env.get('legend-list').classList.contains('is-off') && env.get('legend-sort').disabled === true,
         `is-off=${env.get('legend-list').classList.contains('is-off')} · disabled=${env.get('legend-sort').disabled}`);
      ok('「同色块」时字色选择器禁用（改了也不生效）',
         env.get('set-legend-fg').disabled === true,
         `disabled=${env.get('set-legend-fg').disabled}`);
      st.set.legendTitleOnly = false;
      st.set.legendFgAuto = false;

      /* ---- 空状态 / 可访问名称 ---- */
      st.paintBlocks = [];
      st.set.legend = true;
      st.set.legendTitle = '';
      ex.rebuildLegendPanel();
      const listEl = env.get('legend-list');
      ok('没有条目时只写「还没有条目」，不再附赠一长串解释',
         listEl.style.display !== 'none' && /还没有条目/.test(listEl.innerHTML)
         && !/按颜色自动分组/.test(listEl.innerHTML),
         `display=${listEl.style.display} · ${String(listEl.innerHTML).slice(0, 36)}`);
      /* 三种颜色必须是同一套卡片：同样的 class、同样的色块 + HEX 结构
         ⚠ 别拿假 DOM 的 `#legend-colors.querySelectorAll()` 数：这个桩对
         某些嵌套 div 的 class 查询会漏（真浏览器没这毛病）✗ —— 直接查烤好的
         HTML 更硬，还能防止构建时把卡片烤丢 ✓ */
      const rawHtml = fs.readFileSync(HTML, 'utf8');
      const cardCount = (rawHtml.match(/class="legend-color-card"/g) || []).length;
      const swatchCount = (rawHtml.match(/class="legend-swatch"/g) || []).length;
      const hexCount = (rawHtml.match(/class="legend-hex"/g) || []).length;
      ok('背景 / 边框 / 字色是同一套三张颜色卡（不再三种排版）',
         cardCount === 3 && swatchCount === 3 && hexCount === 3,
         `${cardCount} 张卡 · ${swatchCount} 个色块 · ${hexCount} 个 HEX`);
      const fontSel = env.get('set-legend-font');
      const fontVals = Array.from(fontSel.options || fontSel.querySelectorAll('option'))
        .map((o) => o.value);
      ok('图例字体下拉只留默认 + 导入字体，不再写死宋/楷/等宽',
         fontVals.length === 1 && fontVals[0] === '',
         fontVals.join(' / ') || '（空）');
      /* 字体库里有东西时，下拉必须真的列出来、而且选完能进 legendOpts ✓ */
      const oldLegendFont = st.set.legendFont;
      await ex.refreshLegendFonts([{ id: 4242, name: '测试字体', kind: 'ttf' }]);
      const importedVals = Array.from(fontSel.options || fontSel.querySelectorAll('option'))
        .map((o) => o.value);
      st.set.legendFont = 'PDX-Font-4242';
      const importedOpts = ex.legendOpts();
      ok('导入的字体真的进了图例下拉，并成为 canvas 字体族',
         importedVals.includes('PDX-Font-4242')
         && /PDX-Font-4242/.test(importedOpts.fontCss || ''),
         importedVals.join(' / '));
      st.set.legendFont = oldLegendFont;
      await ex.refreshLegendFonts([]);
      st.paintBlocks = [
        { name: '甲族', rgb: [10, 20, 30], area: 100, pids: [1], tid: 1 },
        { name: '乙族', rgb: [40, 50, 60], area: 90, pids: [2], tid: 2 },
      ];
      ex.rebuildLegendPanel();
      const firstRow = listEl.querySelector('.legend-row');
      const firstCb = firstRow && firstRow.querySelector('.legend-on');
      ok('条目勾选框带上了具体名字（读屏不会只念“复选框”）',
         !!firstCb && /甲族/.test(firstCb.getAttribute('aria-label') || ''),
         firstCb ? firstCb.getAttribute('aria-label') : '没有勾选框');
      const resetBtn = env.get('legend-reset-names');
      ok('没有自定义名时「恢复自动名」是禁用的',
         resetBtn.disabled === true, `disabled=${resetBtn.disabled}`);
      const nameEl = firstRow && firstRow.querySelector('.legend-name');
      if (nameEl) {
        nameEl.value = '甲族自定义';
        nameEl.dispatchEvent({ type: 'input' });
      }
      ok('改出第一个自定义名后，「恢复自动名」立刻可用（不用重开面板）',
         resetBtn.disabled === false, `disabled=${resetBtn.disabled}`);
      delete st.legendNames['10,20,30'];
      ex.rebuildLegendPanel();

      st.legendOn = { '10,20,30': false, '40,50,60': false };
      ex.rebuildLegendPanel();
      ok('条目全关掉时，说明会直说地图上什么都不显示',
         /全关掉了/.test(env.get('legend-count').textContent),
         env.get('legend-count').textContent);

      /* 图例关着时外层 hidden，rect 是 0；这时选「自定义」不许把坐标清到左上角 */
      st.set.legendX = 0.5;
      st.set.legendY = 0.5;
      ov.clientWidth = 0;
      ov.clientHeight = 0;
      ov.hidden = true;
      ex._legendCustomFromBox();
      ok('图例关着时选「自定义」不会把坐标重置到左上角',
         st.set.legendX === 0.5 && st.set.legendY === 0.5,
         `${st.set.legendX}, ${st.set.legendY}`);
      ov.hidden = false;
    } finally {
      stageEl.clientWidth = oldW;
      stageEl.clientHeight = oldH;
      st.paintBlocks = oldBlocks;
      if (ex.renderer) ex.renderer.paintData = oldPaint;
      st.legendOn = oldOn;
      st.legendNames = oldNames;
      st.legendOrder = oldOrder;
      st.set.legend = oldSet.legend;
      st.set.legendTitle = oldSet.title;
      st.set.legendTitleOnly = oldSet.titleOnly;
      st.set.legendPos = oldSet.pos;
      st.set.legendSize = oldSet.size;
      st.set.legendFont = oldSet.font;
      st.set.legendCols = oldSet.cols;
      st.set.legendBg = oldSet.bg;
      st.set.legendBgAlpha = oldSet.alpha;
      st.set.legendBorder = oldSet.border;
      st.set.legendFg = oldSet.fg;
      st.set.legendFgAuto = oldSet.fgAuto;
      st.set.legendBox = oldSet.box;
      try { ex.renderLegendOverlay(); } catch (e) { /* 恢复失败不影响断言 */ }
    }
  }

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
