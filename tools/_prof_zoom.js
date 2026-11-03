/**
 * 临时探针：在"地名最多/最贵"的那几档缩放下，按函数名剖开 drawLabels。
 *   node tools/_prof_zoom.js EU5
 * 跟 `_prof_labels.js` 的区别：那边三档视口里两档根本没名字（层门槛没过），
 * 这一版取的是**真正在画名字**的缩放（滚轮缩放时最卡的那几帧）。
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
  const cx = W / 2, cy = Hh / 2;
  ex.labels.frameBudgetMs = Infinity;
  const cssW = ex.labels.cssW || 1400;
  const mk = (scale) => {
    const w = cssW / scale, h = w * 0.62;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  };

  const session = new inspector.Session();
  session.connect();
  const post = (m) => new Promise((res, rej) => session.post(m, (e, r) => (e ? rej(e) : res(r))));
  await post('Profiler.enable');

  for (const scale of [0.58, 0.85, 1.6, 3.2]) {
    const v = mk(scale);
    ex.labels.scale = scale;
    for (let i = 0; i < 3; i++) ex.drawLabels(v);
    H.resetCanvasStats();
    await post('Profiler.start');
    const t0 = process.hrtime.bigint();
    const N = 20;
    for (let i = 0; i < N; i++) ex.drawLabels(v);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    const { profile } = await post('Profiler.stop');
    const drawn = ex.labels.drawn | 0;
    console.log(`\n########## ${CARD} · scale ${(scale * 100).toFixed(0)}% · ${ms.toFixed(2)} ms/帧 `
      + `· 画 ${drawn} 个 · drawImage ${(H.stats.image / N).toFixed(0)} · font ${(H.stats.font / N).toFixed(0)} ##########`);
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
    for (const [k, c] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${(c / total * 100).toFixed(1).padStart(5)}%  ${k}`);
    }
  }
  session.disconnect();
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
