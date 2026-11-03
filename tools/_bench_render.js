/**
 * 临时探针：数一帧 render() 到底发了多少条 GL 调用、JS 侧花多少时间。
 *   node tools/_bench_render.js EU4
 * ⚠ 桩里的 GL 是空函数转的 Proxy ✓ 计时只反映 JS→调用的开销，
 *   不等于真机驱动开销；**调用条数**才是能横比的那把尺子 ✓
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'EU4').toUpperCase();
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

  const r = ex.renderer;
  const realGl = r.gl;
  const counts = new Map();
  let total = 0;
  const counting = new Proxy({}, {
    get(_, k) {
      const s = String(k);
      const v = realGl[s];
      if (typeof v !== 'function') return v;
      return (...a) => { counts.set(s, (counts.get(s) || 0) + 1); total++; return v.apply(realGl, a); };
    },
  });
  r.gl = counting;

  // 热身 + 让纹理/LUT 之类都上过一次（脏标清掉）
  r.dirty = true; r.render();
  counts.clear(); total = 0;

  const N = 200;
  // 相机一直在动（拖动/缩放那档：每帧都脏，但绝大多数 uniform 其实没变）
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    r.view.x += 1; r.dirty = true;
    r.render();
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`\n########## ${CARD} · render() ################`);
  console.log(`  每帧 GL 调用 ${(total / N).toFixed(1)} 条 · JS 侧 ${ms.toFixed(3)} ms/帧`);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, c] of rows) console.log(`    ${(c / N).toFixed(1).padStart(7)}  ${k}`);
  r.gl = realGl;
  process.exit(0);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
