/**
 * 临时探针：**整帧**（frameBody 那套顺序）在"最肉的那档缩放"下按函数名剖开。
 *   node tools/_prof_frame.js EU5 [scalePercent]
 * 只看一档（默认 58%，即地名刚冒出来、候选最多那档）。
 */
'use strict';
const H = require('./lib/browser_stub.js');
const inspector = require('inspector');

const WHICH = (process.argv[2] || 'EU5').toUpperCase();
const SCALE = Number(process.argv[3] || 58) / 100;
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

  const st = ex.state, r = ex.renderer, L = ex.labels;
  const W = (st.meta && (st.meta.mapWidth || st.meta.mapW)) || 8192;
  const Hh = (st.meta && (st.meta.mapHeight || st.meta.mapH)) || 4096;
  L.frameBudgetMs = Infinity;
  const cssW = L.cssW || 1400, cssH = L.cssH || 820;
  const w = cssW / SCALE, h = Math.min(cssH / SCALE, Hh);
  const v = { x: W / 2 - w / 2, y: Hh / 2 - h / 2, w, h };
  const frame = () => {
    st.cam.scale = SCALE; st.cam.cx = W / 2; st.cam.cy = Hh / 2;
    r.view.x = v.x; r.view.y = v.y; r.view.w = v.w; r.view.h = v.h; r.dirty = true;
    ex.syncLayerSwitches(); ex.syncParentBorder(); ex.wasteWatch();
    r.render(); ex.drawLabels(v);
  };
  for (let i = 0; i < 5; i++) frame();

  const session = new inspector.Session();
  session.connect();
  const post = (m) => new Promise((res, rej) => session.post(m, (e, x) => (e ? rej(e) : res(x))));
  await post('Profiler.enable');
  await post('Profiler.start');
  const N = 40;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) frame();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  const { profile } = await post('Profiler.stop');

  console.log(`\n########## ${CARD} · 整帧 @ ${(SCALE * 100).toFixed(0)}% = ${ms.toFixed(2)} ms ##########`);
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
  for (const [k, c] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
    console.log(`    ${(c / total * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
  session.disconnect();
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
