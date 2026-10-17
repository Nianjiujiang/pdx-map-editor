'use strict';
/** 单独对比 paintTargetsAt / 认族（排除 bench 里前后用例的 JIT 干扰）
 *
 *   node tools/bench_family_compare.js VIC3
 *   node tools/bench_family_compare.js VIC3 <改动前的仓库根目录>   # 对照旧源码
 *
 * 为什么要有它：bench_core 里各用例是连着跑的，前一个用例的快慢会改变 V8 的预热状态，
 * 单看一次输出容易把 paintTargetsAt 的抖动读成"改了它"。这里每个用例独立预热 3 次再取中位。
 */
const H = require('./lib/browser_stub.js');
const path = require('path');
const which = process.argv[2] || 'VIC3';
const src = process.argv[3] || null;
const CARD = which === 'VIC3' ? 'VIC3 原版' : `${which} 原版`;

function bench(name, fn, iters = 15) {
  fn(); fn(); fn();
  const t = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  t.sort((a, b) => a - b);
  console.log(`  ${name.padEnd(30)} ${t[Math.floor(t.length / 2)].toFixed(2)} ms`);
}

(async () => {
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(undefined, src || H.ROOT), env);
  const booting = ex.boot();
  for (let i = 0; i < 400 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const pick = ex.MAP_CHOICES.findIndex((m) => String(m.label || '').includes(CARD));
  env.get('map-pick-list').children[pick >= 0 ? pick : 0].onclick();
  await booting;
  const st = ex.state;
  const fine = st.meta.tierNames.length - 1;
  let painted = 0;
  for (let q = 1; q < st.meta.numProvinces && painted < 400; q += 7) {
    const tid = ex.titleAt(q, fine);
    if (tid == null || tid === 65535) continue;
    ex.setBrush([11, 22, 33], false);
    ex.paintTitle(tid, [11, 22, 33]);
    painted++;
  }
  const ex2 = ex;
  const probe = (() => { for (let q = 1; q < st.meta.numProvinces; q++) if (ex2.state.provLabel && ex2.state.provLabel[q] >= 0) return q; return 0; })();
  console.log(`  probe pid=${probe}`);
  bench('paintTargetsAt', () => ex.paintTargetsAt(probe));
  bench('playerGroupPidsAt', () => ex.playerGroupPidsAt(probe));
  bench('playerGroupTidsAt', () => ex.playerGroupTidsAt(probe));
})();
