'use strict';
/**
 * 「边界缝判据」的断言（2026-11-05 ✓）
 *
 *   node tools/check_border_rules.js
 *
 * 盯的是 web/js/border_rules.js 里那三条导出 —— 它们是从 gl.js 的片元着色器里
 * **一个字一个字抄**出来的判据 ✓ 抄错一个字，画面上就是"该有的线没了 / 该让开的
 * 线两条都画" ✗ 而这种错在 GLSL 里根本看不出来 ✓ 只能在这里钉住 ✓
 *
 * 每条断言的 want 都写成**整条返回值**（不是"含不含某通道"✓ 那太松了 ✗）——
 * 多出来一条也算错 ✓ 比如"水↔水只属 water"这条，要是 title 没让开，
 * 返回值会多一条 ✓ 当场就红 ✓
 *
 * 退出码：全过 0 / 有一条红 1 ✓（最后打印 OK: N cases ✓）
 */
const path = require('path');

let R;
try {
  R = require(path.join(__dirname, 'lib', 'border_rules.js'));
} catch (e) {
  console.log('✘ 读不到 tools/lib/border_rules.js：' + String(e && e.message || e));
  process.exit(1);
}

let cases = 0;
const fails = [];

/** 一条断言：got / want 一律按 JSON 比 ✓（对象顺序也一致 ✓ 见文件头 ✓）*/
function eq(name, got, want) {
  cases++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log('  ✔ ' + name);
  } else {
    fails.push(name);
    console.log('  ✘ ' + name + '\n      got  ' + g + '\n      want ' + w);
  }
}

/* ---------------- 造格子 ----------------
 * 默认值：有色 / 涂过 / tid 10 / 标记 5 / 不是水 / 不是荒地 / 各级 tid 全 10
 *   → 默认两格**完全一样** ✓ 谁也不该划 ✓
 *   ⚠ 默认 titleTids 全相同 ✗ 这样 title / paint 那几条断言不会被 extra 搅浑 ✓
 */
function cell(over) {
  const v = {
    col: [0.8, 0.4, 0.2],
    painted: true,
    tid: 10,
    label: 5,
    pid: 100,
    water: false,
    waste: false,
    titleTids: [10, 10, 10, 10],
  };
  if (over) Object.keys(over).forEach((k) => { v[k] = over[k]; });
  return v;
}

/* 默认 ctx：编辑层 1、四环都有层、四环都勾着 ✓ */
const CTX = { paintOnly: 0, editTid: 1, extraTiers: [2, 3, 4, 5], extraShows: [1, 1, 1, 1] };
function ctx(over) {
  const c = {
    paintOnly: CTX.paintOnly,
    editTid: CTX.editTid,
    extraTiers: CTX.extraTiers.slice(),
    extraShows: CTX.extraShows.slice(),
  };
  if (over) Object.keys(over).forEach((k) => { c[k] = over[k]; });
  return c;
}

/** 一条缝的分类（A = 起点侧、B = 对面侧 ✓）*/
function seam(A, B, c) {
  return R.classifySeam(A, B, c || ctx());
}

console.log('=== 通道清单 ===');
eq('CHANNELS 是 5 条，顺序 = 渲染顺序',
  R.CHANNELS.map((c) => c.id), ['title', 'extra', 'paint', 'water', 'waste']);
eq('widthKey / alphaKey 对得上 uniform',
  R.CHANNELS.map((c) => [c.widthKey, c.alphaKey]),
  [['uBorderW', 'uBorderA'],
    ['uExtraW', 'uExtraA'],
    ['uPaintBorderW', 'uPaintBorderA'],
    ['uWaterBorderW', 'uWaterBorderA'],
    ['uWasteBorderW', 'uWasteBorderA']]);

console.log('\n=== viewsDiffer：五条规则（顺序也算数）===');
const C1 = { col: [0.8, 0.4, 0.2], painted: true, label: 5 };
eq('paintOnly=1 且两边都没涂 → 不划（颜色不一样也不划 ✗ 这条在最前面 ✓）',
  R.viewsDiffer({ col: [0.8, 0.4, 0.2], painted: false, label: 1 },
    { col: [0.9, 0.1, 0.1], painted: false, label: 2 }, 1), false);
eq('paintOnly=0 且两边都没涂、颜色不同 → 划',
  R.viewsDiffer({ col: [0.8, 0.4, 0.2], painted: false, label: 1 },
    { col: [0.9, 0.1, 0.1], painted: false, label: 2 }, 0), true);
eq('两边都没颜色（-1）→ 不划',
  R.viewsDiffer({ col: [-1, -1, -1], painted: false, label: 1 },
    { col: [-1, -1, -1], painted: false, label: 9 }, 0), false);
eq('一边有颜色一边没有 → 划',
  R.viewsDiffer({ col: [-1, -1, -1], painted: false, label: 1 }, C1, 0), true);
eq('颜色差 0.03 → 划', R.viewsDiffer(C1, { col: [0.83, 0.4, 0.2], painted: true, label: 5 }, 0), true);
eq('颜色差正好 0.02 → 不算"不同"（判据是 > 0.02 ✓）',
  R.viewsDiffer({ col: [0, 0, 0], painted: true, label: 5 },
    { col: [0.02, 0, 0], painted: true, label: 5 }, 0), false);
eq('颜色一样、label 不同 → 划', R.viewsDiffer(C1, { col: [0.8, 0.4, 0.2], painted: true, label: 6 }, 0), true);
eq('全同 → 不划', R.viewsDiffer(C1, { col: [0.8, 0.4, 0.2], painted: true, label: 5 }, 0), false);

console.log('\n=== paint 通道 ===');
eq('paintOnly=1 两边都没涂 → paint 不属',
  seam(cell({ painted: false, label: 1 }), cell({ painted: false, label: 2 }), ctx({ paintOnly: 1 })), []);
eq('一边有色一边无色 → paint 属',
  seam(cell(), cell({ col: [-1, -1, -1], painted: false })), [{ ch: 'paint' }]);
eq('颜色差 >0.02 → paint 属',
  seam(cell(), cell({ col: [0.8, 0.4, 0.25] })), [{ ch: 'paint' }]);
eq('颜色同、label 不同 → paint 属',
  seam(cell(), cell({ label: 6 })), [{ ch: 'paint' }]);
eq('全同 → 谁都不属', seam(cell(), cell()), []);

console.log('\n=== title 通道 ===');
eq('tid 不同 → title 属', seam(cell({ tid: 10 }), cell({ tid: 11 })), [{ ch: 'title' }]);
eq('tid 相同 → title 不属', seam(cell({ tid: 10 }), cell({ tid: 10 })), []);

console.log('\n=== 让位：水 / 荒地 ===');
eq('水↔水（tid 不同）→ 只有 water',
  seam(cell({ water: true, tid: 10 }), cell({ water: true, tid: 11 })), [{ ch: 'water' }]);
eq('水↔水 且两格涂的颜色完全不一样 → 还是只有 water（title/paint/extra 全让开 ✓）',
  seam(cell({ water: true, tid: 10, col: [0.8, 0.4, 0.2], label: 3, titleTids: [1, 2, 3, 4] }),
    cell({ water: true, tid: 11, col: [0.1, 0.9, 0.5], label: 9, titleTids: [5, 6, 7, 8] })),
  [{ ch: 'water' }]);
eq('水↔水 且 tid 相同 → 一条线都没有（water 要 tid 不同 ✓ 别的通道已让开 ✓）',
  seam(cell({ water: true }), cell({ water: true })), []);
eq('荒地↔荒地（tid 不同）→ 只有 waste',
  seam(cell({ waste: true, tid: 10 }), cell({ waste: true, tid: 11 })), [{ ch: 'waste' }]);
eq('荒地↔荒地 且 tid 相同 → 一条线都没有',
  seam(cell({ waste: true }), cell({ waste: true })), []);
eq('水↔陆 → title 按 tid 判，water 不属',
  seam(cell({ water: true, tid: 10 }), cell({ water: false, tid: 11 })), [{ ch: 'title' }]);
eq('陆↔水（反方向）→ water 也不属（只判对面是水就画是错的 ✗ 2026-11-09）',
  seam(cell({ water: false, tid: 10 }), cell({ water: true, tid: 11 })), [{ ch: 'title' }]);
eq('荒地↔陆 → title 按 tid 判，waste 不属',
  seam(cell({ waste: true, tid: 10 }), cell({ waste: false, tid: 11 })), [{ ch: 'title' }]);
eq('陆↔荒地（反方向）→ waste 也不属',
  seam(cell({ waste: false, tid: 10 }), cell({ waste: true, tid: 11 })), [{ ch: 'title' }]);
eq('水↔荒地 → 只有 title，water / waste 都不属',
  seam(cell({ water: true, tid: 10 }), cell({ waste: true, tid: 11 })), [{ ch: 'title' }]);
eq('水↔陆 且 tid 相同 → 谁都不属（water 要两边都是水 ✓）',
  seam(cell({ water: true }), cell({ water: false })), []);

console.log('\n=== extra（多级边界）===');
eq('第 0、1 环 tid 不同 → 同时属 extra[0]、extra[1]',
  seam(cell({ titleTids: [7, 8, 9, 10] }), cell({ titleTids: [1, 2, 9, 10] })),
  [{ ch: 'extra', ex: 0 }, { ch: 'extra', ex: 1 }]);
eq('extra 那环用户没勾（uExtraShow=0）→ 不属',
  seam(cell({ titleTids: [7, 8, 9, 10] }), cell({ titleTids: [1, 8, 9, 10] }),
    ctx({ extraShows: [0, 1, 1, 1] })), []);
eq('extra 那环没有层（uExtraTier=-1）→ 不属',
  seam(cell({ titleTids: [7, 8, 9, 10] }), cell({ titleTids: [1, 8, 9, 10] }),
    ctx({ extraTiers: [-1, 3, 4, 5] })), []);
eq('一条缝同时属 title + paint + extra[0] → 三个都在（渲染顺序：title → extra → paint）',
  seam(cell({ tid: 10, col: [0.8, 0.4, 0.2], label: 3, titleTids: [7, 8, 9, 10] }),
    cell({ tid: 11, col: [0.1, 0.9, 0.5], label: 9, titleTids: [1, 8, 9, 10] })),
  [{ ch: 'title' }, { ch: 'extra', ex: 0 }, { ch: 'paint' }]);
eq('水↔水缝上 extra 也不出现（让位对多级边界同样成立 ✓）',
  seam(cell({ water: true, tid: 10, titleTids: [1, 2, 3, 4] }),
    cell({ water: true, tid: 11, titleTids: [5, 6, 7, 8] })), [{ ch: 'water' }]);

/* ---------------- 收尾 ---------------- */
if (fails.length) {
  console.log('\n失败 ' + fails.length + ' / ' + cases + ' 条：');
  fails.forEach((n) => console.log('  ✘ ' + n));
  process.exit(1);
}
console.log('\nOK: ' + cases + ' cases');
process.exit(0);
