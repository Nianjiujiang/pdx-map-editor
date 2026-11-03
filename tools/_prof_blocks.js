/**
 * 临时探针：用 inspector 的 CPU profiler 精确解剖 rebuildPaintBlocks 的耗时分布。
 *   node tools/_prof_blocks.js VIC3
 * 只 profile 热身之后的那段循环，boot 不进样本。
 */
'use strict';
const H = require('./lib/browser_stub.js');
const inspector = require('inspector');

const WHICH = (process.argv[2] || 'VIC3').toUpperCase();
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
  const fine = st.meta.tierNames.length - 1;
  let painted = 0;
  for (let q = 1; q < st.meta.numProvinces && painted < 400; q += 7) {
    const t = st.titlemap[fine * st.meta.numProvinces + q];
    if (t == null || t === 65535) continue;
    ex.paintAt(q, t);
    painted++;
  }
  ex.rebuildPaintBlocks(true); // 热身，别让首次分配算进去

  const session = new inspector.Session();
  session.connect();
  const post = (m) => new Promise((res, rej) => session.post(m, (e, r) => (e ? rej(e) : res(r))));
  await post('Profiler.enable');
  await post('Profiler.start');

  const N_ALL = 12, N_PAINT = 30;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N_ALL; i++) ex.rebuildPaintBlocks(true);
  const allMs = Number(process.hrtime.bigint() - t0) / 1e6 / N_ALL;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < N_PAINT; i++) ex.rebuildPaintBlocks(false);
  const paintMs = Number(process.hrtime.bigint() - t1) / 1e6 / N_PAINT;

  const { profile } = await post('Profiler.stop');
  session.disconnect();

  console.log(`\n########## ${CARD} · 地块 ${st.meta.numProvinces} ##########`);
  console.log(`  rebuildPaintBlocks(all=true)  ${allMs.toFixed(2)} ms`);
  console.log(`  rebuildPaintBlocks(all=false) ${paintMs.toFixed(2)} ms`);

  // self time：按 nodeId 累加采样，再落到函数名
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  for (const s of profile.samples || []) {
    const n = byId.get(s);
    if (!n) continue;
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anon)'}  ${(cf.url || '').replace(/^file:\/\/\//, '').split(/[\\/]/).pop()}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (profile.timeDeltas ? 1 : 1));
  }
  const total = (profile.samples || []).length || 1;
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  console.log(`  采样 ${total} 次，self time 前 18：`);
  for (const [k, v] of rows) console.log(`    ${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`);
  // 行级热点（positionTicks 有就打印，没有就跳过）
  for (const n of profile.nodes) {
    if (!n.positionTicks) continue;
    if (n.callFrame.functionName !== 'rebuildPaintBlocks') continue;
    const ticks = n.positionTicks.slice().sort((a, b) => b.ticks - a.ticks).slice(0, 12);
    console.log(`  行级：${ticks.map((t) => `${t.line}:${t.ticks}`).join('  ')}`);
  }
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
