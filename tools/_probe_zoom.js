/**
 * 临时探针：模拟"连续缩放"那档，逐帧看地名层的开销构成。
 *   node tools/_probe_zoom.js EU5
 *
 * 每帧只改视口大小（中心不动）—— 这正是滚轮缩放时 frameBody 干的事：
 *   renderer.view 变 → labels.scale 变 → drawLabels 整条重跑。
 *
 * 报的东西（都是"能横比"的量，不依赖真机 GPU）：
 *   ms       drawLabels 一帧的 JS 时间
 *   cand     凑进名单的候选点数（PERF.S.points）
 *   drawn    真正画出来的标签数
 *   font/measure/fill/image  canvas 调用次数（桩里数的，真机一一对应）
 *   layH/layM  排版缓存 命中 / 未命中
 *   sprites  字形贴图条数（缩放扫过去会一直长 → 就是"每档字号都重栅格化一遍"）
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'EU5').toUpperCase();
const CARDS = { VIC3: 'VIC3 原版', EU5: 'EU5 原版', EU4: 'EU4 原版', CK3: 'CK3 原版', HOI4: 'HOI4 原版' };
const CARD = CARDS[WHICH] || `${WHICH} 原版`;

(async () => {
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(), env);
  const booting = ex.boot();
  for (let i = 0; i < 6000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const list = env.get('map-pick-list').children;
  const card = list.find((x) => x.flat().includes(CARD)) || list[0];
  card.onclick();
  await booting;

  const st = ex.state;
  const W = (st.meta && (st.meta.mapWidth || st.meta.mapW)) || 8192;
  const Hh = (st.meta && (st.meta.mapHeight || st.meta.mapH)) || 4096;
  const cx = W / 2, cy = Hh / 2;
  ex.labels.frameBudgetMs = Infinity;   // 量"全量"（交互中的 12ms 截断是设计，别混进来）

  // 缩放扫：从整图 → 1/32 图（对应 scale 0.1 → 3.2 左右）
  const STEPS = 48;
  const W0 = W * 1.02, W1 = W / 26;
  const rows = [];
  const sp0 = ex.labels.sprites.map.size;
  for (let s = 0; s < STEPS; s++) {
    // 指数扫（滚轮缩放是几何级数，不是线性）
    const w = W0 * Math.pow(W1 / W0, s / (STEPS - 1));
    const view = { x: cx - w / 2, y: cy - (w * 0.62) / 2, w, h: w * 0.62 };
    /* 真机里 scroll 先改 renderer.view，`_begin` 再把 scale 算出来 ✓
     * 这里直接调 drawLabels，就得先把 scale 摆成"这一帧该有的值"
     * （drawLabels 开头那道层门槛读的就是它 ✓）*/
    ex.labels.scale = ex.labels.cssW / view.w;
    ex.drawLabels(view);                      // 预热一帧
    const lh0 = ex.labels._layoutHits | 0, lm0 = ex.labels._layoutMiss | 0;
    H.resetCanvasStats();
    const t0 = process.hrtime.bigint();
    ex.drawLabels(view);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const S = (ex.PERF && ex.PERF.S) || {};
    rows.push({
      s, scale: ex.labels.scale, ms,
      cand: S.points | 0, listMs: S.listMs,
      drawn: ex.labels.drawn | 0,
      font: H.stats.font, measure: H.stats.measure, fill: H.stats.fill, image: H.stats.image,
      layH: (ex.labels._layoutHits | 0) - lh0, layM: (ex.labels._layoutMiss | 0) - lm0,
      sprites: ex.labels.sprites.map.size,
    });
  }
  const tot = (k) => rows.reduce((a, b) => a + (b[k] || 0), 0);
  console.log(`\n########## ${CARD} · 连续缩放 ${STEPS} 帧 ##########`);
  console.log('  ms     scale   cand  drawn   font meas  fill  image  layH layM sprites');
  for (const r of rows) {
    console.log(`  ${r.ms.toFixed(2).padStart(6)} ${(r.scale * 100).toFixed(0).padStart(5)}% `
      + `${String(r.cand).padStart(6)} ${String(r.drawn).padStart(6)}  ${String(r.font).padStart(5)} `
      + `${String(r.measure).padStart(5)} ${String(r.fill).padStart(5)} ${String(r.image).padStart(6)} `
      + `${String(r.layH).padStart(4)} ${String(r.layM).padStart(4)} ${String(r.sprites).padStart(6)}`);
  }
  const sum = (k) => rows.reduce((a, b) => a + (b[k] || 0), 0);
  const mx = (k) => Math.max(...rows.map((r) => r[k] || 0));
  console.log('  ----');
  console.log(`  合计   ms ${sum('ms').toFixed(1)}  measure ${sum('measure')}  fill ${sum('fill')}  `
    + `image ${sum('image')}  排版命中 ${sum('layH')} / 未命中 ${sum('layM')}`);
  console.log(`  峰值   ms ${mx('ms').toFixed(2)}  cand ${mx('cand')}  drawn ${mx('drawn')}  `
    + `sprites ${mx('sprites')}（开局 ${sp0}）`);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
