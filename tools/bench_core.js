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
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'EU4').toUpperCase();
const CARD = WHICH === 'VIC3' ? 'V3 原版' : WHICH === 'EU4HD' ? 'EU4HD'
  : WHICH === 'EU5' ? 'EU5 原版' : `${WHICH} 原版`;
//: 拿别处的源码跑同一把尺子（对照"改动前 / 改动后"用）：
//:   PDX_SRC=/path/to/old/web node tools/bench_core.js VIC3
//: 它按 `web/js/` 找文件，所以给的是 **web 那一层**的路径。
const SRC = process.env.PDX_SRC || null;

function bench(name, fn, iters = 7) {
  fn(); fn();                                   // 预热
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const mid = times[Math.floor(times.length / 2)];
  console.log(`  ${name.padEnd(38)} ${mid.toFixed(2).padStart(8)} ms   (最慢 ${times[times.length - 1].toFixed(2)})`);
  return mid;
}

(async () => {
  // 数据永远从**本工程**读；只有源码可以换（PDX_SRC）
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(undefined, SRC || H.ROOT), env);

  console.log(`\n======== ${CARD}${SRC ? '（源码：' + SRC + '）' : ''} ========`);
  const t0 = Date.now();
  const booting = ex.boot();
  for (let i = 0; i < 400 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const card = env.get('map-pick-list').children.find((c) => c.flat().includes(CARD));
  if (!card) { console.log('  ✘ 选单里没有这张图'); process.exit(1); }
  card.onclick();
  await booting;
  const bootMs = Date.now() - t0;

  const st = ex.state;
  console.log(`  ${'boot()'.padEnd(38)} ${String(bootMs).padStart(8)} ms   （只报一次）`);
  console.log(`  地块 ${st.meta.numProvinces} · 头衔 ${st.meta.numTitles} · `
    + `层级 ${st.meta.tierNames.length} · 荒地 ${((st.meta.wasteland) || []).length}`);

  const r = {};

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
    console.log(`  （预热：涂了 ${painted} 个地块，改动 ${st.changed.size} 处）`);
  }

  // ① 全图重分组（进剧本视图 / 开「填色·地名」时会走到）
  r.blocksAll = bench('rebuildPaintBlocks(all=true)', () => ex.rebuildPaintBlocks(true), 5);
  r.blocksPaint = bench('rebuildPaintBlocks(all=false)', () => ex.rebuildPaintBlocks(false), 5);

  // ② 认族：全图扫（「填色·边界」下点一下涂色 / 擦除都走这里）
  const paint = ex.renderer && ex.renderer.paintData;
  let pidOne = 0;
  if (paint) {
    for (let q = 1; q < st.meta.numProvinces; q++) if (paint[q * 4 + 3] > 0) { pidOne = q; break; }
  }
  const probePid = pidOne || Math.max(1, Math.floor(st.meta.numProvinces / 2));
  r.groupPids = bench(`playerGroupPidsAt(#${probePid})`, () => ex.playerGroupPidsAt(probePid), 5);
  r.groupTids = bench('playerGroupTidsAt(#同上)', () => ex.playerGroupTidsAt(probePid), 5);
  r.sameBlock = bench('sameBlockPids(tid, #同上)', () => {
    ex.sameBlockPids(ex.titleAt(probePid, ex.editTier()), probePid);
  }, 5);

  // ③ 打开设置里的图例栏 / 导图例
  r.legendPanel = bench('rebuildLegendPanel()', () => ex.rebuildLegendPanel(), 5);
  r.legendEntries = bench('legendEntries()', () => ex.legendEntries(), 5);

  // ④ 帧里的同步三连（每帧都跑）
  r.syncFrame = bench('syncLayerSwitches+Parent+waste', () => {
    ex.syncLayerSwitches();
    ex.syncParentBorder();
    ex.wasteWatch();
  }, 21);

  // ⑤ 标记表（层 / 涂色数变了才重算，但重算一次很贵）
  r.paintLabels = bench('syncAllPaintLabels()', () => {
    st._lblPassKey = null;
    ex.syncAllPaintLabels();
  }, 5);

  console.log('  ----');
  console.log(`  每帧固定开销 ≈ ${r.syncFrame.toFixed(2)} ms（预算 16.7 ms）`);
  process.exit(0);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
