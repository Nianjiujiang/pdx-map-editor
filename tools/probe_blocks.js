/**
 * 专项排查：细层重分组（all=false）会不会因为"未涂过的地共享同一个哨兵身份"
 * 而被并成一个巨组、把并查集拖成 O(n²)。
 *
 *   node tools/probe_blocks.js VIC3
 *   node tools/probe_blocks.js CK3
 *
 * 这是我自己引入的改动（改造前每格都算真身份，未涂过的地身份各不相同），
 * 所以必须专门验一遍 —— 不是"跑通了就算"，是量**组的规模分布**和**耗时随涂色量的增长**。
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'VIC3').toUpperCase();
const CARD = WHICH === 'VIC3' ? 'V3 原版' : WHICH === 'EU5' ? 'EU5 原版' : `${WHICH} 原版`;

async function boot(paintN) {
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(), env);
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
  for (let q = 1; q < st.meta.numProvinces && painted < paintN; q += 3) {
    const t = st.titlemap[fine * st.meta.numProvinces + q];
    if (t == null || t === 65535) continue;
    ex.paintAt(q, t);
    painted++;
  }
  return { ex, st, painted };
}

(async () => {
  console.log(`\n########## ${CARD}：细层重分组会不会并出巨组 ##########`);
  const { ex, st, painted } = await boot(400);
  const n = st.meta.numProvinces;
  console.log(`  地块 ${n} · 涂了 ${painted} 块`);

  const t0 = process.hrtime.bigint();
  ex.rebuildPaintBlocks(false);      // all=false：细层
  const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
  const blocks = st.paintBlocks || [];
  const sizes = blocks.map((b) => b.pids.length).sort((a, b) => b - a);
  const total = sizes.reduce((s, v) => s + v, 0);
  console.log(`  rebuildPaintBlocks(all=false)：${ms1.toFixed(2)} ms`);
  console.log(`  组数 ${blocks.length}（应该跟"涂出来的色块数"同量级，不该是 1 个大组）`);
  console.log(`  最大的 5 个组：${sizes.slice(0, 5).join(', ')} 块`);
  console.log(`  所有组合计 ${total} 块（= ${(total / n * 100).toFixed(1)}% 的地块）`);
  const giant = sizes.filter((s) => s > n * 0.1).length;
  console.log(`  ${giant === 0 ? '✔' : '✘'} 没有超过 10% 全图规模的巨组`);
  console.log(`  ${total < n * 0.2 ? '✔' : '✘'} 参与重分组的像素占全图不到 20%（没把整张图卷进来）`);

  // 耗时随涂色量增长：如果是 O(n²)，翻倍涂色量会看到远超线性的增长
  console.log('\n  ---- 耗时随涂色量怎么长（线性增长才正常）----');
  for (const k of [100, 400, 1600, 6400]) {
    const r = await boot(k);
    const t = process.hrtime.bigint();
    r.ex.rebuildPaintBlocks(false);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const sizes2 = (r.st.paintBlocks || []).map((b) => b.pids.length).sort((a, b) => b - a);
    console.log(`    涂 ${String(r.painted).padStart(5)} 块 → ${ms.toFixed(2).padStart(7)} ms · `
      + `组数 ${sizes2.length} · 最大组 ${sizes2[0] || 0}`);
  }
  process.exit(0);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
