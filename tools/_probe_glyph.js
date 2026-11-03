/**
 * 临时探针：验证 GlyphCache 分层索引与老键缓存**完全等价**（2026-11-03 改）
 *   node tools/_probe_glyph.js EU5
 *
 * 验证四件事：
 *   ① 索引里的每一张，跟 `map` 老键里的都是**同一个对象**（逐条对拍）；
 *   ② 热一遍之后再画同样视口，一张新贴图都不该产生（命中率没退）；
 *   ③ `pixels` 恰好等于所有贴图 px 之和（淘汰没算错）；
 *   ④ 索引条目总数 === 老键条目数（没有孤儿）。
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'EU5').toUpperCase();
const CARD = `${WHICH} 原版`;

function walk(cache) {
  let n = 0;
  for (const g1 of cache._idx.values()) for (const inner of g1.values()) n += inner.size;
  return n;
}
function pxSum(cache) {
  let s = 0;
  for (const sp of cache.map.values()) s += sp.px;
  return s;
}

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
  const cache = ex.labels.glyphs;
  ex.labels.frameBudgetMs = Infinity;
  const v = { x: st.cam.cx - 700, y: st.cam.cy - 450, w: 1400, h: 900 };

  for (let i = 0; i < 3; i++) ex.drawLabels(v);
  const warm = cache.map.size;

  for (let i = 0; i < 5; i++) ex.drawLabels(v);

  let bad = 0, checked = 0, missed = 0;
  for (const [key, sp] of cache.map) {
    /* key = dk|sizeKey|color|ft|ch —— ft 里自带 '|'，所以掐两头 ✓ */
    const i1 = key.indexOf('|');
    const i2 = key.indexOf('|', i1 + 1);
    const i3 = key.indexOf('|', i2 + 1);
    const last = key.lastIndexOf('|');
    const dk = key.slice(0, i1);
    const sizeKey = key.slice(i1 + 1, i2);
    const color = key.slice(i2 + 1, i3);
    const ft = key.slice(i3 + 1, last);
    const ch = key.slice(last + 1);
    checked++;
    const g1 = cache._idx.get(dk + '|' + ft);
    const inner = g1 && g1.get(sizeKey + '|' + color);
    const got = inner && inner.get(ch);
    if (got !== sp) { bad++; if (bad <= 3) console.log('  不一致:', key, got ? '对象不同' : '索引里没有'); }
    if (!got) missed++;
  }

  const idxCount = walk(cache);
  const ok2 = cache.map.size === warm;
  const ok3 = cache.pixels === pxSum(cache);
  const ok4 = idxCount === cache.map.size;
  console.log(`\n== ${CARD} ==`);
  console.log(`  贴图数 ${cache.map.size}（热身 ${warm}）  像素 ${(cache.pixels / 1048576).toFixed(2)}MB`);
  console.log(`  ① 逐条对拍 ${checked} 条，不一致 ${bad} 条 ${bad ? '✗' : '✓'}`);
  console.log(`  ② 再画 5 帧新增贴图 ${cache.map.size - warm} 张 ${ok2 ? '✓' : '✗'}`);
  console.log(`  ③ pixels 与 px 之和 ${ok3 ? '一致 ✓' : `不一致 ✗ (${cache.pixels} vs ${pxSum(cache)})`}`);
  console.log(`  ④ 索引条目 ${idxCount} vs 老键 ${cache.map.size} ${ok4 ? '✓' : '✗'}`);
  const pass = bad === 0 && ok2 && ok3 && ok4;
  console.log(`  → ${pass ? '等价 ✓' : '有问题 ✗'}`);
  process.exitCode = pass ? 0 : 1;
})();
