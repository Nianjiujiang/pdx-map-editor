/**
 * 临时探针：解剖 drawLabels 一帧的耗时分布（标签层是"一拖就卡"的头号嫌疑）。
 *   node tools/_prof_labels.js EU5
 * 视口取"拉到能看见整张图"那一档，因为那档候选点最多。
 */
'use strict';
const H = require('./lib/browser_stub.js');
const inspector = require('inspector');

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
  ex.labels.frameBudgetMs = Infinity;          // 量"全量"那一档（交互中的 12ms 截断是设计）
  const views = {
    '近景 1400×900': () => ({ x: st.cam.cx - 700, y: st.cam.cy - 450, w: 1400, h: 900 }),
    '半图 4000×2500': () => ({ x: W / 2 - 2000, y: Hh / 2 - 1250, w: 4000, h: 2500 }),
    '整图': () => ({ x: 0, y: 0, w: W, h: Hh }),
  };

  const session = new inspector.Session();
  session.connect();
  const post = (m) => new Promise((res, rej) => session.post(m, (e, r) => (e ? rej(e) : res(r))));
  await post('Profiler.enable');

  for (const [name, mk] of Object.entries(views)) {
    const v = mk();
    for (let i = 0; i < 3; i++) ex.drawLabels(v);
    await post('Profiler.start');
    const t0 = process.hrtime.bigint();
    const N = 20;
    for (let i = 0; i < N; i++) ex.drawLabels(v);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    const { profile } = await post('Profiler.stop');
    console.log(`\n########## ${CARD} · ${name} · ${ms.toFixed(2)} ms/帧 ##########`);
    const byId = new Map();
    for (const n of profile.nodes) byId.set(n.id, n);
    const self = new Map();
    for (const s of profile.samples || []) {
      const n = byId.get(s); if (!n) continue;
      const cf = n.callFrame;
      const key = `${cf.functionName || '(anon)'}  ${(cf.url || '').replace(/^file:\/\/\//, '').split(/[\\/]/).pop()}:${cf.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + 1);
    }
    const total = (profile.samples || []).length || 1;
    for (const [k, c] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${(c / total * 100).toFixed(1).padStart(5)}%  ${k}`);
    }
  }
  session.disconnect();
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
