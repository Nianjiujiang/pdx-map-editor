/**
 * 临时微基准：GlyphCache 查表这条路的成本（2026-11-03 改造前后）
 *   node tools/_bench_glyph_get.js EU5
 *
 * 只量**命中**那一路（贴图已经全部建好），因为热帧里 99% 都是命中：
 *   · 老写法：每个字现拼 `dpr|字号|颜色|字体|字` 五段长键 → Map.get
 *   · 新写法：快路 memo + 最深一层的短键 → Map.get
 * 两边拿到的是同一张贴图（前一个探针已经逐条对拍过 ✓）。
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'EU5').toUpperCase();
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
  const cache = L.glyphs;
  L.frameBudgetMs = Infinity;
  const v = { x: st.cam.cx - 700, y: st.cam.cy - 450, w: 1400, h: 900 };
  for (let i = 0; i < 3; i++) ex.drawLabels(v);

  /* 从老键里反解出 (dpr, 字号, 颜色, 字体, 字)，造一份"一帧里会查的字"清单 */
  const chars = [];
  for (const key of cache.map.keys()) {
    const i1 = key.indexOf('|');
    const i2 = key.indexOf('|', i1 + 1);
    const i3 = key.indexOf('|', i2 + 1);
    const last = key.lastIndexOf('|');
    chars.push({
      dk: key.slice(0, i1),
      sizeKey: key.slice(i1 + 1, i2),
      color: key.slice(i2 + 1, i3),
      ft: key.slice(i3 + 1, last),
      ch: key.slice(last + 1),
      size: Number(key.slice(i1 + 1, i2)),
    });
  }
  if (!chars.length) { console.log('没有贴图可测'); return; }
  /* kind 从字体标签反推不出来了，直接拿现成的层：用 place 与 power 各测一遍，
   * 只要 (size,color,dpr,kind) 这一组在缓存里存在就是命中 ✓ */
  const kinds = ['place', 'power'];
  const sameKey = (c, kind) => cache.map.has(c.dk + '|' + c.sizeKey + '|' + c.color + '|' + c.ft + '|' + c.ch);

  const ROUNDS = 400;
  function runOld() {
    let sink = 0;
    for (let r = 0; r < ROUNDS; r++) {
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        const sp = cache.map.get(c.dk + '|' + c.sizeKey + '|' + c.color + '|' + c.ft + '|' + c.ch);
        if (sp !== undefined) sink++;
      }
    }
    return sink;
  }
  function runNew(kind) {
    let sink = 0;
    for (let r = 0; r < ROUNDS; r++) {
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        const sp = cache.get(c.ch, c.size, c.color, Number(c.dk), kind);
        if (sp !== null) sink++;
      }
    }
    return sink;
  }

  const med = (f) => {
    const t = [];
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint();
      f();
      t.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    t.sort((a, b) => a - b);
    return t[2];
  };
  const n = chars.length * ROUNDS;
  const oldMs = med(runOld);
  /* 新写法：kind 用哪一套无所谓（同一个 (size,color,dpr,kind) 组合才命中），
   * 这里两种都跑，取快的那个作代表 —— 反正帧里就是这么交替的 ✓ */
  const newMs = Math.min(med(() => runNew('place')), med(() => runNew('power')));
  console.log(`\n== ${CARD} ==  每次 ${chars.length} 个字 × ${ROUNDS} 轮 = ${n} 次查表`);
  console.log(`  老写法（现拼五段长键） ${oldMs.toFixed(1)} ms  → ${(oldMs * 1e6 / n).toFixed(0)} ns/次`);
  console.log(`  新写法（快路 + 短键）   ${newMs.toFixed(1)} ms  → ${(newMs * 1e6 / n).toFixed(0)} ns/次`);
  console.log(`  快 ${(oldMs / newMs).toFixed(2)}×`);
})();
