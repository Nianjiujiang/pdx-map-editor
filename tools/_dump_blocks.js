const fs = require('fs');
const H = require('./lib/browser_stub.js');
const WHICH = (process.argv[2] || 'VIC3').toUpperCase();
const OUT = process.argv[3] || 'tmp_blocks.json';
const CARDS = { VIC3: 'VIC3 原版', EU5: 'EU5 原版', EU4: 'EU4 原版', CK3: 'CK3 原版', HOI4: 'HOI4 原版' };
(async () => {
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(), env);
  const booting = ex.boot();
  for (let i = 0; i < 8000 && !env.get('map-pick-list').children.length; i++) await new Promise((r) => setImmediate(r));
  const list = env.get('map-pick-list').children;
  (list.find((x) => x.flat().includes(CARDS[WHICH])) || list[0]).onclick();
  await booting;
  const st = ex.state;
  const fine = st.meta.tierNames.length - 1;
  let painted = 0;
  for (let q = 1; q < st.meta.numProvinces && painted < 400; q += 7) {
    const t = st.titlemap[fine * st.meta.numProvinces + q];
    if (t == null || t === 65535) continue;
    ex.paintAt(q, t); painted++;
  }
  const sig = (bs) => bs.map((b) => [b.name, +b.x.toFixed(3), +b.y.toFixed(3), b.area,
    b.w, b.tid, b.singleTid, b.paintedAny, b.pids.length, b.rgb.join(',')]);
  ex.rebuildPaintBlocks(true);
  const all = sig(st.paintBlocks);
  const blockOfAll = Array.from(st._blockOf || []).join(',');
  ex.rebuildPaintBlocks(false);
  const fineSig = sig(st.paintBlocks);
  const blockOfFine = Array.from(st._blockOf || []).join(',');
  fs.writeFileSync(OUT, JSON.stringify({ painted, all, fine: fineSig,
    blockOfAllHash: blockOfAll.length + ':' + blockOfAll.slice(0, 200),
    blockOfFineHash: blockOfFine.length + ':' + blockOfFine.slice(0, 200) }));
  console.log(`${WHICH}: painted=${painted} all=${all.length} fine=${fineSig.length} -> ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
