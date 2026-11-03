/**
 * 临时探针：排版缓存命中率（2026-11-03）
 *   node tools/_probe_layout.js VIC3
 * 目的：确认 `p._lk` 键记忆化现在真的命中了（以前点对象每帧新建，一次都没命中）。
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'VIC3').toUpperCase();
const CARD = `${WHICH} 原版`;

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
  const L = ex.labels;
  L.frameBudgetMs = Infinity;
  const v = { x: st.cam.cx - 700, y: st.cam.cy - 450, w: 1400, h: 900 };
  console.log(`mapNameMode = ${L.mapNameMode}  realmMask.usable = ${!!(L.realmMask && L.realmMask.usable)}`);
  for (let i = 0; i < 3; i++) ex.drawLabels(v);
  const h0 = L._layoutHits, m0 = L._layoutMiss;
  const t0 = process.hrtime.bigint();
  const N = 20;
  for (let i = 0; i < N; i++) ex.drawLabels(v);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  const dh = L._layoutHits - h0, dm = L._layoutMiss - m0;
  console.log(`\n== ${CARD} 近景 ==`);
  console.log(`  ${ms.toFixed(2)} ms/帧  排版命中 +${dh}  未命中 +${dm}  命中率 ${(100 * dh / Math.max(1, dh + dm)).toFixed(1)}%`);
  console.log(`  缓存条目 ${L._layoutCache.size}  画出 ${L.drawn} 个标/帧`);
})();
