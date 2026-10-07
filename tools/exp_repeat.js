/**
 * 重复测量：同一件事跑 N 轮，报**均值 ± 标准差**和最好/最坏。
 *
 *   node tools/exp_repeat.js VIC3 7
 *   node tools/exp_repeat.js CK3 7
 *
 * 为什么要它：单次掐表会被 GC 和系统调度带偏 —— 我第一轮量的时候，
 * CK3 那组 playerGroupPidsAt 甚至跑出"慢 18%"，而那条代码我压根没动过。
 * 报均值之前先看波动：**波动比差值大的话，那个差值就不能当结论** ✓
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'VIC3').toUpperCase();
const ROUNDS = Number(process.argv[3] || 7);
const CARD = WHICH === 'VIC3' ? 'V3 原版' : WHICH === 'EU5' ? 'EU5 原版' : `${WHICH} 原版`;
const BEFORE = process.env.PDX_BEFORE || null;

function stats(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const sorted = [...xs].sort((a, b) => a - b);
  return { mean, sd, min: sorted[0], max: sorted[n - 1] };
}

async function measure(root, label) {
  const env = H.makeEnv({ root: H.ROOT });       // 数据总是从本工程读
  const ex = H.instantiate(H.flattenModules(undefined, root), env);
  const b = ex.boot();
  for (let i = 0; i < 4000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  (env.get('map-pick-list').children.find((x) => x.flat().includes(CARD))
    || env.get('map-pick-list').children[0]).onclick();
  await b;
  const st = ex.state;
  const fine = st.meta.tierNames.length - 1;
  let painted = 0;
  for (let q = 1; q < st.meta.numProvinces && painted < 400; q += 7) {
    const t = st.titlemap[fine * st.meta.numProvinces + q];
    if (t == null || t === 65535) continue;
    ex.paintAt(q, t); painted++;
  }
  let firstPainted = 1;
  const pd = ex.renderer && ex.renderer.paintData;
  for (let q = 1; q < st.meta.numProvinces; q++) if (pd && pd[q * 4 + 3] > 0) { firstPainted = q; break; }

  const cases = {
    'rebuildPaintBlocks(all=true)': () => ex.rebuildPaintBlocks(true),
    'rebuildPaintBlocks(all=false)': () => ex.rebuildPaintBlocks(false),
  };
  if (typeof ex.playerGroupPidsAt === 'function') {
    cases['playerGroupPidsAt(认族)'] = () => ex.playerGroupPidsAt(firstPainted);
  }
  const out = {};
  for (const [name, fn] of Object.entries(cases)) {
    fn(); fn();                                   // 预热
    const xs = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t0 = process.hrtime.bigint();
      fn();
      xs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    out[name] = stats(xs);
  }
  console.log(`  [${label}] 地块 ${st.meta.numProvinces} · 涂了 ${painted} 块 · ${ROUNDS} 轮`);
  return out;
}

(async () => {
  console.log(`\n########## ${CARD}：重复测量（各 ${ROUNDS} 轮）##########`);
  const after = await measure(H.ROOT, '改动后');
  const before = (BEFORE && require('fs').existsSync(BEFORE)) ? await measure(BEFORE, '改动前') : null;

  for (const name of Object.keys(after)) {
    const a = after[name];
    console.log(`\n  ${name}`);
    console.log(`    改动后  ${a.mean.toFixed(2).padStart(7)} ± ${a.sd.toFixed(2)} ms`
      + `   （${a.min.toFixed(2)} ~ ${a.max.toFixed(2)}）`);
    if (before && before[name]) {
      const b0 = before[name];
      console.log(`    改动前  ${b0.mean.toFixed(2).padStart(7)} ± ${b0.sd.toFixed(2)} ms`
        + `   （${b0.min.toFixed(2)} ~ ${b0.max.toFixed(2)}）`);
      const d = b0.mean - a.mean;
      const trustworthy = Math.abs(d) > (b0.sd + a.sd);
      console.log(`    差      ${d >= 0 ? '快' : '慢'} ${Math.abs(d).toFixed(2)} ms`
        + `（${(d / b0.mean * 100).toFixed(0)}%）`
        + `   ${trustworthy ? '✔ 差值大于两边波动之和，可信' : '⚠ 差值没超过波动，别当结论'}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
