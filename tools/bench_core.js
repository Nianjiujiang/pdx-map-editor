/**
 * 核心路径性能基线（改造前 / 改造后同一把尺子）。
 *
 *   node tools/bench_core.js CK3
 *   node tools/bench_core.js EU4
 *   node tools/bench_core.js VIC3        ← 4 万地块，最看得出差别的那张
 *   node tools/bench_core.js EU5
 *
 * 跟 test_modes.js 一个路子：把 web/js 拍平、喂一套假 DOM / 假 WebGL
 * （那套桩在 tools/lib/browser_stub.js 里，三个入口共用），
 * 让**真的** boot() 跑起来，然后只掐表 —— 不验行为（那是 test_modes 的活）。
 *
 * 量的都是"每帧 / 每点一次都在跑"的东西，跑多次报**中位数**：
 *   · boot                —— 开一张图要多久
 *   · rebuildPaintBlocks  —— 涂一笔之后重算色块（全图 / 只涂过）← 改这里最见效
 *   · playerGroupPidsAt   —— 「填色·边界」下点一下认族（全图扫）
 *   · syncAllPaintLabels  —— 进剧本层时给每块地写标记
 *   · 帧里的同步三连      —— syncLayerSwitches + syncParentBorder + wasteWatch
 *
 * ⚠ 这份文件同时是**库** ✓（2026-11-03 改）：`tools/perf_baseline.js` 直接
 *   `require()` 它、拿 `measure()` 的返回值存基线 / 比红线 —— 量什么、怎么量
 *   只写在这一处，别在 perf_baseline.js 里再抄一套指标表 ✗（抄两份就会漂，
 *   这个仓库刚因为模块清单抄了三份吃过一次亏 ✓）。
 *   命令行用法不变：`node tools/bench_core.js EU5` 还是人话表格。
 */
'use strict';
const H = require('./lib/browser_stub.js');

//: 能拿来跑的几张图（写错时用它报错，别让调用方去翻 MAP_CHOICES）
const MAP_KEYS = ['CK3', 'EU4', 'VIC3', 'EU5'];

function cardOf(which) {
  return which === 'VIC3' ? 'VIC3 原版'
    : which === 'EU4HD' ? 'EU4HD'
      : which === 'EU5' ? 'EU5 原版'
        : `${which} 原版`;
}

/** 一个计时器工厂：量了同时记进 results，给 lib 用；`echo` 决定要不要打人话行 */
function makeBench(results, echo) {
  /** @param {string} key 指标的稳定名字（存进基线 JSON，**别随便改** ✓） */
  /** @param {string} label 人看的名字（可以改，不影响基线比对） */
  return function bench(key, label, fn, iters = 7) {
    fn(); fn();                                   // 预热
    const times = [];
    for (let i = 0; i < iters; i++) {
      const t0 = process.hrtime.bigint();
      fn();
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    const mid = times[Math.floor(times.length / 2)];
    results[key] = { label, med: mid, max: times[times.length - 1], n: iters };
    if (echo) {
      console.log(`  ${label.padEnd(38)} ${mid.toFixed(2).padStart(8)} ms   (最慢 ${times[times.length - 1].toFixed(2)})`);
    }
    return mid;
  };
}

/**
 * 跑一张图的全部指标。
 * @param {string} which CK3 / EU4 / VIC3 / EU5
 * @param {{quiet?: boolean, src?: string|null}} opts
 *        quiet —— 不打过程（perf_baseline 自己排表格）
 *        src   —— 换一份 web 源码量（对照改动前用），数据仍从本工程读
 * @returns {Promise<{map: string, card: string, boot: object, meta: object, results: object}>}
 */
async function measure(which, opts) {
  const o = opts || {};
  const echo = !o.quiet;
  const WHICH = String(which || 'EU4').toUpperCase();
  const SRC = o.src || null;
  const CARD = cardOf(WHICH);
  const log = echo ? console.log : () => {};

  // 数据永远从**本工程**读；只有源码可以换（PDX_SRC）
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(undefined, SRC || H.ROOT), env);

  log(`\n======== ${CARD}${SRC ? '（源码：' + SRC + '）' : ''} ========`);
  const t0 = Date.now();
  const booting = ex.boot();
  for (let i = 0; i < 400 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  // 卡片怎么找：**按地图清单的 label**（`MAP_CHOICES`）——
  // 不要去读卡片上的文字 ✗：那套桩里 `innerHTML` 会真造子节点，
  // 而 `flat()` 见子节点就只拼子节点（文字在解析时被丢掉了）→ 永远是空串 ✗
  const pick = ex.MAP_CHOICES.findIndex((m) => String(m.label || '').includes(CARD)
    || String(m.emb || '') === WHICH.toLowerCase());
  const card = env.get('map-pick-list').children[pick >= 0 ? pick : 0];
  if (!card) throw new Error(`选单里没有「${CARD}」这张图（能跑的是：${MAP_KEYS.join('、')}）`);
  if (pick < 0) log(`  （清单里没有「${CARD}」，用第一张顶替 ✓）`);
  card.onclick();
  await booting;
  const bootMs = Date.now() - t0;

  const st = ex.state;
  log(`  ${'boot()'.padEnd(38)} ${String(bootMs).padStart(8)} ms   （只报一次）`);
  log(`  地块 ${st.meta.numProvinces} · 头衔 ${st.meta.numTitles} · `
    + `层级 ${st.meta.tierNames.length} · 荒地 ${((st.meta.wasteland) || []).length}`);

  /** @type {Record<string, {label: string, med: number, max: number, n: number}>} */
  const r = {};
  const bench = makeBench(r, echo);

  // 先真的涂几块，不然 rebuildPaintBlocks 一进门就因为"没有涂过的地"返回了，
  // 量出来是个假数（0.1ms）
  {
    const fine = st.meta.tierNames.length - 1;
    let painted = 0;
    for (let q = 1; q < st.meta.numProvinces && painted < 400; q += 7) {
      const t = st.titlemap[fine * st.meta.numProvinces + q];
      if (t == null || t === 65535) continue;
      ex.paintAt(q, t);
      painted++;
    }
    log(`  （预热：涂了 ${painted} 个地块，改动 ${st.changed.size} 处）`);
  }

  // ① 全图重分组（进剧本视图 / 开「填色·地名」时会走到）
  bench('blocksAll', 'rebuildPaintBlocks(all=true)', () => ex.rebuildPaintBlocks(true), 5);
  bench('blocksPaint', 'rebuildPaintBlocks(all=false)', () => ex.rebuildPaintBlocks(false), 5);

  // ② 认族 / 定范围：全图扫（点一下涂色、擦除都走这里）
  const paint = ex.renderer && ex.renderer.paintData;
  let pidOne = 0;
  if (paint) {
    for (let q = 1; q < st.meta.numProvinces; q++) if (paint[q * 4 + 3] > 0) { pidOne = q; break; }
  }
  const probePid = pidOne || Math.max(1, Math.floor(st.meta.numProvinces / 2));
  // ⚠ 标签里**不带地块号** ✓：地块号随地图变，写进基线会让两份 JSON 对不上
  bench('groupPids', 'playerGroupPidsAt(探针格)', () => ex.playerGroupPidsAt(probePid), 5);
  bench('groupTids', 'playerGroupTidsAt(探针格)', () => ex.playerGroupTidsAt(probePid), 5);
  // **每点一次 / 拖动时每动一下都跑这个** —— 现在的热点 ✓（它逐格解析归属）
  bench('targets', 'paintTargetsAt(探针格)', () => ex.paintTargetsAt(probePid), 5);
  bench('provInfo', 'provInfoAt(探针格) ×1000', () => {
    for (let i = 0; i < 1000; i++) ex.provInfoAt(probePid, ex.countryTier ? ex.countryTier() : 0);
  }, 5);
  // 落笔 + 账本重算（涂一笔之后的固定开销）
  bench('paintOne', 'paintPidsAsOne(1 格)', () => ex.paintPidsAsOne([probePid], [200, 30, 30]), 5);
  bench('recompute', 'recomputePainted()', () => ex.recomputePainted(), 5);

  // ⑥ 标签层：**鼠标每换一格 / 每次滚轮缩放都会重画它** ✓
  //    （这是"鼠标一划就卡"的头号嫌疑犯）
  const _vr = () => ({ x: st.cam.cx - 400, y: st.cam.cy - 300, w: 800, h: 600 });
  bench('labels', 'drawLabels(视口 800×600)', () => ex.drawLabels(_vr()), 5);
  /* **拉远到整张图**那一档也得量 ✓（2026-11-03 加的）
   *   拉远时视野里塞着的点子最多（EU5 最细层 2.3 万），
   *   以前这档光是"取视口内的点"就要 3ms 左右 —— 只量 800×600 会漏掉它 ✓ */
  const _vrWide = () => ({ x: 0, y: 0, w: st.meta.mapW || 8192, h: st.meta.mapH || 3616 });
  bench('labelsWide', 'drawLabels(整图)', () => ex.drawLabels(_vrWide()), 3);

  // ⑦ 鼠标移动那条链（每次 mousemove 都跑）
  const _stg = env.get('stage');
  const _cx = Math.floor(_stg.clientWidth / 2), _cy = Math.floor(_stg.clientHeight / 2);
  bench('hoverSame', 'updateHover(同一格，只挪鼠标)', () => ex.updateHover(_cx, _cy), 21);
  bench('hoverMove', 'updateHover(每次都换一格)', () => {
    st.hover.pid = -1;                 // 逼它走"换格"那条（建卡片 + 高亮 + 标脏）
    ex.updateHover(_cx, _cy);
  }, 11);
  bench('card', 'renderHoverCard(pid)', () => ex.renderHoverCard(probePid), 11);
  bench('highlight', 'applyHoverHighlight(pid)', () => ex.applyHoverHighlight(probePid, null), 11);

  // ③ 打开设置里的图例栏 / 导图例
  bench('legendPanel', 'rebuildLegendPanel()', () => ex.rebuildLegendPanel(), 5);
  bench('legendEntries', 'legendEntries()', () => ex.legendEntries(), 5);

  // ④ 帧里的同步三连（每帧都跑）
  bench('syncFrame', 'syncLayerSwitches+Parent+waste', () => {
    ex.syncLayerSwitches();
    ex.syncParentBorder();
    ex.wasteWatch();
  }, 21);

  // ⑤ 标记表（层 / 涂色数变了才重算，但重算一次很贵）
  bench('paintLabels', 'syncAllPaintLabels()', () => {
    st._lblPassKey = null;
    ex.syncAllPaintLabels();
  }, 5);

  /* boot 也记进同一张表（只有一次，`n:1`）——
   * 它是"点开地图到能看见"的体感大头，回归不该只看运行期 ✓ */
  r.boot = { label: 'boot()', med: bootMs, max: bootMs, n: 1 };

  log('  ----');
  log(`  每帧固定开销 ≈ ${r.syncFrame.med.toFixed(2)} ms（预算 16.7 ms）`);

  /* 量完就把这个环境掐掉 ✓（定时器 + rAF 队列）
     不然它活着继续跑，连量三张图时后两张会被前一张拖慢 —— 实测 40% 的假回归 ✓
     见 `tools/lib/browser_stub.js` 里 `dispose()` 的注释 ✓ */
  try { if (env.dispose) env.dispose(); } catch (e) { /* 掐失败也不影响已经量到的数 ✓ */ }

  return {
    map: WHICH,
    card: CARD,
    meta: {
      provinces: st.meta.numProvinces,
      titles: st.meta.numTitles,
      tiers: st.meta.tierNames.length,
    },
    results: r,
  };
}

module.exports = { measure, MAP_KEYS, cardOf, makeBench };

// ---------------------------------------------------------------- 命令行
if (require.main === module) {
  const WHICH = (process.argv[2] || 'EU4').toUpperCase();
  //: 拿别处的源码跑同一把尺子（对照"改动前 / 改动后"用）：
  //:   PDX_SRC=/path/to/old/web node tools/bench_core.js VIC3
  //: 它按 `web/js/` 找文件，所以给的是 **web 那一层**的路径。
  const SRC = process.env.PDX_SRC || null;
  measure(WHICH, { src: SRC, quiet: false })
    .then(() => process.exit(0))
    .catch((e) => { console.error('崩了：', e); process.exit(1); });
}
