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
    ok(`内嵌了 ${keys.length} 套地图`, keys.length >= 6, keys.join(' / '));
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

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
