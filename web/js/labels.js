/**
 * 地名标注层。
 *
 * 单独一层 Canvas2D，盖在 WebGL 地图上面。两种画法：
 *
 *   draw()       常规：标当前层级的所有头衔，位置按各层的规则定（见 build_*.py），
 *                缩放百分比到了这一层的门槛才标。
 *
 *   drawPoints() 常规模式下（头衔关、手绘开）用：只画传进来的那几个点。
 *                点是由调用方按**颜色**聚出来的 —— 见 app.js 的 paintedPoints()，
 *                因为玩家常常是吸了某个头衔的色去铺别的地方，
 *                这时候该显示的是"这个颜色原本属于谁"，不是地块本身属于谁。
 *
 * 裁剪按**文字包围盒**算：只要还有一部分落在视口里就画。
 *
 * ---------------------------------------------------------------- 为什么不卡了
 *
 * 这套东西每帧要把几百个地名画一遍（平移时相机一直在动，每帧都重画），
 * 三个开销按大小排：
 *
 * 1. **strokeText / fillText 现场栅格化汉字** —— 最贵的一步，尤其带描边（等于画两遍）。
 *    → 加了**字形贴图缓存**：同一段文字 + 同一个字号 + 同一个颜色只画一次到离屏
 *      canvas，之后每帧只 drawImage。平移时缩放不变，命中率几乎 100%。
 *      贴图按 devicePixelRatio 渲染，高分屏上不糊。
 *
 * 2. **ctx.font 一改就要重新解析 CSS 字体简写、重新选字体** —— 第二贵。
 *    而字号现在是跟着缩放连续变的，几乎每个标签都不一样，于是每个标签都要改一次。
 *    → 把字号吸附到一条 6% 的**几何阶梯**上（quantizeFont）。同一级共用一次 font，
 *      肉眼看不出差别。字号分桶之后，还要按桶从大到小画，保证大的在下面。
 *
 * 3. **measureText** 每帧每个标签量一次宽度。
 *    → 量宽缓存按**量化后**的字号做 key，命中率从"几乎为 0"变成"几乎 100%"。
 *
 * 还有一件小但很阴的：`canvas.clientWidth` 不能在标签循环里读 —— 读它会逼浏览器
 * 同步重排，几百次就是一场灾难。现在一帧只读一次，存在 this.cssW/cssH 里。
 *
 * 每帧的临时数组（文本、坐标、字号）都挂在实例上复用，稳态下不产生垃圾。
 */

import { RealmMaskSource, layoutMapName, mapNameParams } from './maplabels.js';

/* 🔴 **P社式排版**（2026-10-22 ✓）
 *   `桌面/P社国名地图排版原理与实现.md` 那套：在版图里找基线 → 逐字贴着曲线摆 ✓
 *   具体算法在 `maplabels.js` ✓ 这边只负责：
 *     · 把省份图 / 归属表喂给排版器（`setRealmMask` ✓）
 *     · 按"这个标是国名还是地名"决定套不套（`mapNameMode` ✓）
 *     · 把排好的"每个字的位置 + 角度"画出来（字形贴图逐字旋转 ✓）
 *   ⚠ 排版结果**跟缩放无关** → 按（层 / 头衔 / 文字 / 字体 / 用户字号）缓存 ✓
 *     相机平移、放大缩小都不重算 ✓ 只有换层 / 改名 / 换字体 / 调字号才失效 ✓
 */
const MAPNAME_REF = 100;          //: 量字用的参考字号（排版按比例缩 ✓）
/* 🔴🔴 **地名不再按字号设门槛**（2026-10-23 用户：地名也要一律贴合版图）
 *   以前这里是 `MAPNAME_PLACE_MIN = 8`：屏幕字号不到 8px 就不排版、退回横着写 ✗
 *   → 缩到某一层刚出现时，小地块全横着，放大一点才变贴合 —— 画法跟着缩放变 ✗
 *   现在**一律排** ✓ 排版结果按（层 / 头衔 / 文字 / 字体 / 用户字号）缓存，
 *   跟缩放无关 → 一层的名字只付一次排版成本，之后放大缩小、拖动都是命中 ✓
 *   （实测单次 ~0.5ms；一屏地名最多几百个，只在那一层第一次出现时算一轮 ✓）
 *   ⚠ 试过"每帧限排几个、剩下的下一帧补" ✗ —— 一屏 188 个时会被拖成
 *     一帧只冒 20 个，看着像卡顿 ✓ 所以宁可一次算完 ✓ */


//: 排版缓存最多存多少条（开局整层预热要装得下 ✓ 一条几十字节 ✓）
const LAYOUT_CACHE_MAX = 60000;

//: 各层级从多少缩放百分比开始显示 —— 只是一层**兜底**：
//: 真正用的门槛由 `computeLabelZoom()` 按**这张图自己的地块大小**算出来 ✓
//: （以前每个游戏写死一套数，谁也没跟着地图尺寸走：EU5 半尺寸和原尺寸差了 2 倍，
//:   门槛却一模一样 → 半尺寸那张的地名会提早一倍糊出来 ✗）
const MIN_ZOOM_PERCENT = [8, 30, 60, 120, 250];

//: 细层的口径：门槛那一刻，这一层**中位地块**在屏幕上要多宽（CSS px）。
//: 20px 是"保证不比以前那套写死值更晚"的临界值（用户要求：别放得更近）——
//: 各图细层因此都比旧值早或持平：CK3 男爵领 250→63、EU4 省份 110→88、
//: HOI4 省份 165→158、V3 省份 150→132、EU5 地点 240→129（原尺寸 65）。
//: 觉得太早（CK3 那种上万块细层的图名字会碎）就调大：25 / 35 / 45 各是一档 ✓
export const ARRIVE_SPAN = 20;
//: 国名层（年份层；CK3 是最粗那层）**不设缩放门槛** ✓（2026-10-27 用户：
//: "国名显示不要那个 20 门槛，无论手机版还是电脑版"）
//: 原来按"整张图缩进 1600px 视口"算出一个 ~20% 的门槛 ✓
//: 于是缩到 19% 时国名整层消失；用户要它一直出 ✓
//: ⚠ 字号本身还有一道 4px 的可读性门槛（见 `_fontSize`）✓
//:   缩得特别小的时候只有大国名够 4px，这是"别糊成一团"的底线，不是缩放门槛 ✓
const ZOOM_MIN = 4;
const ZOOM_MAX = 800;

/** 国名层数：有年份层就是年份层数；没有年份时最粗那层算国名 ✓ */
function countryTierCount(meta) {
  const nEra = (meta && meta.eraDates && meta.eraDates.length) || 0;
  return nEra > 0 ? nEra : 1;
}

/** 把一份门槛表里的国名层**全部置 0** ✓（0 = 不设缩放门槛，不是"永不显示" ✓） */
function zeroCountryGates(arr, meta) {
  const out = (arr || []).slice();
  const nCountry = countryTierCount(meta);
  for (let t = 0; t < nCountry && t < out.length; t++) out[t] = 0;
  return out;
}

/**
 * 按**这张图自己的地块大小**算每一层的地名门槛（缩放百分比）。
 *
 * 两条口径：
 *   · 细层：`100 × 70 / 这一层的中位地块跨度`（地图像素）——
 *     地块小的图（V3 的省份 15px、HOI4 的省份 12.6px）门槛自然就高 ✓
 *   · 国名层（`meta.eraDates` 那几层；没有年份时是最粗那层）：**= 0，不设缩放门槛** ✓
 *     （2026-10-27 用户："国名显示不要那个 20 门槛" ✓ 原来按整图视角算 ≈20% ✓）
 *
 * 拿 CK3 复算验证过：帝国/王国/公爵领/伯爵领/男爵领 = 12/30/61/119/221%，
 * 跟当年手调的 8/30/60/120/250% 基本一致 —— 说明这才是那套数背后的口径 ✓
 *
 * @param {object} meta   meta.json 的内容（要 mapWidth / tiers / eraDates / 兜底 labelZoom）
 * @param {object} titles titles.json 的内容（要 tiers，以及**跟字号同一个来源**的面积：
 *                        `blockArea` 优先、退回 `area` —— EU5 的 `area` 是成员个数不是像素 ✗）
 */
export function computeLabelZoom(meta, titles) {
  const areaArr = titles && (titles.blockArea || titles.area);
  if (!meta || !titles || !titles.tiers || !areaArr) {
    return zeroCountryGates((meta && meta.labelZoom) || MIN_ZOOM_PERCENT, meta);
  }
  const nT = meta.tiers ? meta.tiers.length : 0;
  if (!nT) return zeroCountryGates((meta && meta.labelZoom) || MIN_ZOOM_PERCENT, meta);
  const real = meta.numRealTitles || meta.numTitles || titles.tiers.length;
  const nCountry = countryTierCount(meta);
  const spans = [];
  for (let t = 0; t < nT; t++) spans.push([]);
  for (let i = 0; i < titles.tiers.length && i < real && i < areaArr.length; i++) {
    const t = titles.tiers[i];
    const a = areaArr[i];
    if (t >= 0 && t < nT && a > 0) spans[t].push(Math.sqrt(a));
  }
  const out = new Array(nT);
  for (let t = 0; t < nT; t++) {
    let z;
    if (t < nCountry) {
      z = 0;                                  // 国名：不设缩放门槛 ✓
    } else if (spans[t].length) {
      const arr = spans[t].sort((a, b) => a - b);
      const med = arr[arr.length >> 1];       // 中位数：一半地块够大就该上地名了
      z = med > 0 ? (100 * ARRIVE_SPAN / med) : 0;
    } else {
      z = 0;
    }
    if (t >= nCountry && !(z > 0)) {
      const fb = (meta.labelZoom && meta.labelZoom[t]) || MIN_ZOOM_PERCENT[t] || 30;
      z = fb;
    }
    /* ⚠ 0 = 不设门槛，**不能**被 ZOOM_MIN 夹回去 ✗
     *   以前统一 `Math.max(ZOOM_MIN, …)` → 国名层再怎么样也至少 4% ✓ */
    out[t] = z > 0 ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z))) : 0;
  }
  return out;
}

//: 字体栈。用系统自带的雅黑这一类黑体 —— 楷体系列（华文楷体等）在 Canvas 上
//: 逐字渲染中文明显更慢，标签一多就卡。
const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';

/* 🔴 **导入字体：地名和势力名各用各的** ✗✗（2026-10-20 ✓ 用户要求）
 *
 *   两槽：`place`（地块名 / 海湖河荒地）和 `power`（势力名 = 剧本年份那几层 + 涂出来的色块）
 *   空串 = 用默认栈 ✓ 有值 = 那个族名排在最前面，后面照样接默认栈 ✓
 *     （导入的字体缺字时，浏览器会自己往后面的系统字体里找 ✓ 不会变成豆腐块 ✓）
 *
 *   ⚠ **缓存全要带字体** ✗ —— 换字体之后如果不区分，
 *     量宽缓存和字形贴图还是旧字体那批 ✓ 画面就会新旧混着，像是没生效 ✓
 *     所以 `fontFor` / `measureCached` / `SpriteCache` 的键里都放进了族名 ✓
 */
const FONT_FACE = { place: '', power: '' };

/* 🔴 **位图字体**（2026-10-20 ✓ 用户："这个应该是可以攻克的"）
 *   TTF 那套靠 `document.fonts` 注册，位图字体（EU4 汉化那种 .fnt + .dds）走不了那条路 ✗
 *   只能自己逐字贴图 ✓ —— 这里存两槽 BitmapFont 实例（null = 没选 ✓）
 *   有值就**盖过** `FONT_FACE` ✓（同一个下拉里选中的是位图字体 ✓）
 *
 *   ⚠ 位图字体**没有矢量轮廓** ✗ —— 描边只能把同一个字偏移着多画几遍 ✓
 *     所以贴图缓存对位图字体更重要（每段字只铸一次 ✓）
 */
const BITMAP = { place: null, power: null };

/** 挂一套位图字体（传 null 取消 ✓）
 *  @param {'place'|'power'} kind
 *  @param {object|null} bf BitmapFont 实例
 */
export function setLabelBitmap(kind, bf) {
  _dropFontTag(kind);
  if (kind !== 'place' && kind !== 'power') return;
  BITMAP[kind] = bf || null;
}

/** 现在挂的是哪套位图字体（自测用 ✓） */
export function labelBitmap(kind) {
  return BITMAP[kind] || null;
}

/** 设置某一类的字体族名（传空串 = 回到默认 ✓）
 *  @param {'place'|'power'} kind
 *  @param {string} family
 */
export function setLabelFont(kind, family) {
  if (kind !== 'place' && kind !== 'power') return;
  FONT_FACE[kind] = String(family || '');
  _dropFontTag(kind);          // 键里的字体身份变了 ✓ 缓存要跟着作废 ✓
}

/** 现在用的是哪套（给设置页回显 / 自测用 ✓） */
export function labelFont(kind) {
  return FONT_FACE[kind] || '';
}

/** 某一类拼出来的字体栈 */
function stackOf(kind) {
  const f = FONT_FACE[kind];
  return f ? `"${f}", ${FONT_STACK}` : FONT_STACK;
}

/**
 * 🔴 **字体的身份标签** —— 所有缓存键都要带上它 ✗✗
 *
 *  2026-10-20 用户报"字体选择根本没有生效" ✓ 根因就在这儿：
 *  量宽 / 字形贴图 / fontFor 三处当初只把 `kind`（place|power）编进键里，
 *  可 `kind` 是**固定的**（一类就一个值 ✓）—— 换字体键根本不变 ✓
 *  于是：旧字体量出来的宽度、旧字体栅格化的贴图，全都原封不动命中 ✓
 *  画面上自然一点变化都没有 ✓ 看着就像"选了没反应" ✗
 *
 *  现在键里带两样：
 *    · `FONT_FACE[kind]` —— 导入的 TTF 族名（空 = 默认栈 ✓）
 *    · `BITMAP[kind].uid` —— 位图字体实例号（两套位图字体也可能同名 ✓）
 */
const _FONT_TAG = { place: null, power: null };
/** 换字体 / 换位图字体时要把这张缓存作废 ✓（setLabelFont / setLabelBitmap 里清 ✓）*/
function _dropFontTag(kind) {
  if (kind) { _FONT_TAG[kind] = null; return; }
  _FONT_TAG.place = null; _FONT_TAG.power = null;
}
function fontTag(kind) {
  const k = (kind === 'power') ? 'power' : 'place';
  /* 🔴 **缓存一下**（2026-10-23 体检）：它会进每一个缓存键，每帧上千次调用 ✗
   *   以前每次现拼字符串 → 每帧上千个小字符串，纯 GC 压力 ✓
   *   `_dropFontTag` 由 setLabelFont / setLabelBitmap 负责失效 ✓ */
  let t = _FONT_TAG[k];
  if (t === null) {
    const bf = BITMAP[k];
    t = (bf ? 'b' + bf.uid : '') + '|' + (FONT_FACE[k] || '');
    _FONT_TAG[k] = t;
  }
  return t;
}

//: 文字：白字 + 黑描边
const LABEL_FG = '#ffffff';
const LABEL_FG_HOVER = '#ffe9a8';
const LABEL_STROKE = 'rgba(0, 0, 0, 0.82)';

//: 字号 = **这个头衔在屏幕上有多大** × 这个比例。
//:
//: 关键是它对缩放是**线性**的：放大两倍，屏幕上的地盘大两倍，字也就大两倍。
//: 以前的写法是 `8 + log2(side) * 2` 再夹到 [9, 26] —— 对数是"放大一点、字大一点
//: 点"，那个 26 的上限更是直接封顶，放到 4 倍字也不长了，于是地图越放越大、
//: 字却越来越小气，这就是"缩放失真"。
let FONT_RATIO = 0.18;

//: 下限：再小就看不清了。只有很小的地块会碰到它（碰到时不线性，但总比一个
//: 两像素高的名字强）。**没有上限** —— 上限正是失真的来源。
const MIN_FONT = 10;

/** 设置页用：字号总倍率（1 = 默认 0.18） */
export function setFontScale(k) {
  const n = Number(k);
  if (Number.isFinite(n) && n >= 0.4 && n <= 3) FONT_RATIO = 0.18 * n;
}

/**
 * 各层的"显示门槛"：算出来比它小就整个不画。
 *
 * 只给**国名那层**留 2px 的可读底线（2026-10-27 试验：从 4px 降到 2px ✓
 *   用户："国名显示不要那个 20 门槛" —— 光去掉缩放门槛没用，
 *   真正卡住的是这道字号线：4px 时大部分国名要缩到 ~20% 才够大 ✓
 *   → 降到 2px 后，5% 全图视角也能先浮出几个最大国的名字 ✓
 *   ⚠ 再往下（0）会变成几百个 1px 蚂蚁字糊满屏，试验过，不可读 ✗）
 * 地区 / 省份这些细层一律 **0 = 全显示**：
 * 它们各自有 meta.labelZoom 的缩放门（没到那个缩放整层都不出现），
 * 门一开就该把这一层全摆出来 —— 跟 CK3 伯爵领那套一样。
 */
const TIER_MIN_FONT = [2, 0, 0, 0, 0];

/** 真正允许画出来的最小字号：字号阶梯从这里起步 */
const MIN_DRAW = 4;

/* 导出图里只收**大于 15px** 的名字（2026-10-27 用户要求）：
 * 低倍率导出时 4–15px 的字在 PNG 里只剩一团灰，既不好认又拖慢导出；
 * 字号顺便取整，保证 canvas 按整像素栅格化，不会因为 15.4px 这种字号发虚。
 * 返回 0 = 这个字号不画。 */
const EXPORT_MIN_FONT = 15;
function exportFontPx(size) {
  const px = Math.ceil(Number(size));
  return px > EXPORT_MIN_FONT ? px : 0;
}

//: 逐层的字号倍率。细层级（CK3 的伯爵领 / 男爵领，EU4 的地区 / 省份）再放大两成 ——
//: 这些地块本身就小，按面积等比算出来的字偏小，缩到那一层看着费劲。
//: 它是个常数倍率，所以字号对缩放还是线性的。
const TIER_FONT_BOOST = [1, 1, 1, 1.2, 1.2];

const MAX_LABELS = 4000;

//: 候选上限，纯保险。**注意它跟 MAX_LABELS 不是一回事** ——
//: 以前这里拿 MAX_LABELS 当候选上限，于是"只考虑面积最大的 4000 个"，
//: CK3 有 11295 个男爵领，结果放到最大、视口里明明有三十几个，
//: 却可能一个都进不了候选（实测随机挑位置有 20% 是这情况）——
//: 看起来就是"男爵领名字放多大都看不见"。
//: 现在这里只防病态数据，真正的限量在 _paint 里按**画出来的**数。
const MAX_CANDIDATES = 30000;

// ---------------------------------------------------------------- 字号阶梯

//: 相邻两级差 6%。吸附误差最多 ±3%，肉眼分不出来，但字号种类从"连续无限个"
//: 变成 ~90 个桶 —— font 变更次数、量宽缓存命中率全靠这个。
const SIZE_STEP = 1.06;
const SIZE_STEPS_MAX = 220;
const SIZE_LADDER = [MIN_DRAW];
const FONT_CACHE = new Map();

function quantizeFont(size) {
  if (!(size > MIN_DRAW)) return MIN_DRAW;
  let k = Math.round(Math.log(size / MIN_DRAW) / Math.log(SIZE_STEP));
  if (k < 0) k = 0;
  else if (k > SIZE_STEPS_MAX) k = SIZE_STEPS_MAX;
  let v = SIZE_LADDER[k];
  if (v === undefined) {
    v = MIN_DRAW * Math.pow(SIZE_STEP, k);
    SIZE_LADDER[k] = v;
  }
  return v;
}

/** 拼 `ctx.font` 用的字符串
 *  ⚠ 缓存键要带 **kind** ✗ —— 两套字体各缓存各的 ✓
 *     只按字号缓存的话，换字体之后拿到的是旧那套字符串 ✓
 */
function fontFor(size, kind) {
  const k = size.toFixed(1) + '|' + (kind || 'place') + '|' + fontTag(kind);
  let f = FONT_CACHE.get(k);
  if (f === undefined) {
    f = `600 ${size.toFixed(1)}px ${stackOf(kind || 'place')}`;
    FONT_CACHE.set(k, f);
  }
  return f;
}

// ---------------------------------------------------------------- 量宽缓存

//: 标签每帧都要量一遍宽度，几百个标签时 measureText 是主要开销；
//: 同一个地名在**同一级字号**下量一次就够了（字号已经量化过了）。
const WIDTH_CACHE = new Map();
const WIDTH_CACHE_MAX = 20000;

function measureCached(ctx, text, size, kind) {
  /* 位图字体：宽度 = 各字 xadvance 之和 ✓ 不用 measureText（也没有东西可量 ✗）*/
  const bf = BITMAP[kind];
  if (bf) return bf.measure(text, size);
  /* ⚠ 键里要带**字体** ✗ —— 换了字体还命中旧宽度，
   *   名字会按错的宽度居中 / 判断放不放得下 ✓ 看着就像"字体没生效" ✓ */
  const key = size.toFixed(1) + '\u0000' + fontTag(kind) + '\u0000' + text;
  let w = WIDTH_CACHE.get(key);
  if (w === undefined) {
    ctx.font = fontFor(size, kind);
    w = ctx.measureText(text).width;
    if (WIDTH_CACHE.size >= WIDTH_CACHE_MAX) WIDTH_CACHE.clear();
    WIDTH_CACHE.set(key, w);
  }
  return w;
}

// ---------------------------------------------------------------- 字形贴图

//: 贴图总预算（含 dpr 放大后的像素数）。超了就从最老的开始丢。
const SPRITE_BUDGET = 16 * 1024 * 1024;
//: 字再大就不做贴图了（一张就几十 MB），现场画 —— 那种字号屏幕上也没几个标签。
const SPRITE_MAX_FONT = 200;

class SpriteCache {
  constructor() {
    this.map = new Map();
    this.pixels = 0;
  }

  /**
   * 取一张"这段文字 + 这个字号 + 这个颜色"的贴图，没有就现做一张。
   * @param {number} tw 已经量好的文字宽度（CSS px）
   * @returns {{c:object,w:number,h:number,px:number}|null} null = 别贴了，现场画
   */
  get(text, size, color, dpr, tw, kind, bf) {
    /* ⚠ 键里要带**字体** ✗ —— 贴图是栅格化好的像素，
     *   不区分的话换字体之后屏幕上还是旧字形 ✓ 而且看起来"怎么换都没反应" ✓
     *   位图字体再额外带上实例 uid ✓（两套位图字体也可能同名 ✓）*/
    const fk = fontTag(kind);
    /* dpr 必须进键 ✗：屏幕上是 2x 贴图，导出是 1x；混用会把 2x 贴图缩着画，
       字就发糊（2026-10-27 用户反馈"字体有点糊" ✓） */
    const dk = (Number(dpr) > 0 ? Number(dpr) : 1).toFixed(2);
    const key = dk + '|' + size.toFixed(1) + '|' + color + '|' + fk + '|' + text;
    const hit = this.map.get(key);
    if (hit !== undefined) return hit;
    if (size > SPRITE_MAX_FONT) return null;

    const pad = Math.ceil(Math.max(2, size * 0.13));   // 给描边留地方，不然边被切掉
    const w = Math.ceil(tw) + pad * 2;
    const h = Math.ceil(size * 1.5) + pad * 2;
    const px = Math.ceil(w * dpr) * Math.ceil(h * dpr);
    if (px > SPRITE_BUDGET / 4) return null;

    while (this.pixels + px > SPRITE_BUDGET && this.map.size) {
      const oldest = this.map.keys().next().value;
      this.pixels -= this.map.get(oldest).px;
      this.map.delete(oldest);
    }

    const c = document.createElement('canvas');
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);      // 高分屏上按 dpr 画，贴出来才不糊
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    if (bf) {
      /* 位图字体：逐字贴 ✓ 描边靠"偏移着多画几遍"（它没有矢量轮廓 ✗）*/
      bf.draw(g, text, w / 2, h / 2, size, color,
        { outline: Math.max(1, size * 0.09), stroke: LABEL_STROKE });
    } else {
      g.font = fontFor(size, kind);
      g.lineWidth = Math.max(1.3, size * 0.14);
      g.strokeStyle = LABEL_STROKE;
      g.strokeText(text, w / 2, h / 2);
      g.fillStyle = color;
      g.fillText(text, w / 2, h / 2);
    }

    const sprite = { c, w, h, px };
    this.map.set(key, sprite);
    this.pixels += px;
    return sprite;
  }

  clear() {
    this.map.clear();
    this.pixels = 0;
  }
}

// ---------------------------------------------------------------- 字形贴图（逐字）
//
// 🔴 **P社式排版是逐字画的**（每个字位置 / 角度都不同 ✓）——
//   老的 `SpriteCache` 是"整段文字一张贴图" ✗ 那个转不了（一转整段一起转，就没曲线了 ✓）
//   所以另开一套：**一个字一张贴图**，缓存键里带单字 ✓
//
//   ⚠ 汉字名字重复率高（"大""王""国"到处都是）→ 命中率比整段贴图还高 ✓
//   ⚠ 贴图里要留出**基线的位置**（`oy` ✓）：画的时候把"基线中心"对到曲线上的点，
//     不是把整张图的中心对上去 ✗ —— 不然字会在曲线上下乱跳 ✓

//: 逐字贴图的总预算（12 MB，比整段那套小一点 —— 它数量多 ✓）
const GLYPH_BUDGET = 12 * 1024 * 1024;

/** 量字用的公共 2D context（不画东西，只拿来 measureText ✓） */
let _scratch = null;
function scratchCtx() {
  if (!_scratch) {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    _scratch = c.getContext('2d');
  }
  return _scratch;
}

/** 取一段字的**字形度量**（都换算到 MAPNAME_REF 号字 ✓）
 *
 *  ⚠ 老浏览器没有 `fontBoundingBoxAscent` ✗ → 退回 `actualBoundingBox*` →
 *    再退回"8 : 2 的近似"（测试桩只给 width ✓ 也得能跑 ✓）
 */
function glyphMetrics(text, kind) {
  const chars = Array.from(String(text));
  /* 🔴 **位图字体也要有度量**（2026-10-23 用户："导入的字体没法实现版图适应弯曲"）
   *   位图字体没有 `measureText` 那套矢量框 ✗ 但 BMFont 自己带 lineHeight / base /
   *   每字 xadvance ✓ 拿这些拼出一份"参考字号下的度量"就够了：
   *   参考字号 = lineHeight，adv = 各字 xadvance，ascent/descent 按 base 拆 ✓ */
  const bf = BITMAP[kind];
  if (bf) {
    const ref = Math.max(1, bf.lineHeight | 0);
    const base = Math.max(0, bf.meta && bf.meta.base ? bf.meta.base : ref * 0.8);
    const adv = chars.map((ch) => {
      const g = bf.glyph(ch.codePointAt(0));
      return g ? (g.adv || ref * 0.5) : ref * 0.5;
    });
    return { ref, adv, ascent: base, descent: Math.max(1, ref - base) };
  }
  const ctx = scratchCtx();
  ctx.font = fontFor(MAPNAME_REF, kind);
  const adv = new Array(chars.length);
  let asc = 0, desc = 0;
  for (let i = 0; i < chars.length; i++) {
    const m = ctx.measureText(chars[i]);
    adv[i] = (m && m.width) || MAPNAME_REF * 0.5;
    const a = (m && m.fontBoundingBoxAscent != null) ? m.fontBoundingBoxAscent
      : (m && m.actualBoundingBoxAscent != null) ? m.actualBoundingBoxAscent : 0;
    const d = (m && m.fontBoundingBoxDescent != null) ? m.fontBoundingBoxDescent
      : (m && m.actualBoundingBoxDescent != null) ? m.actualBoundingBoxDescent : 0;
    if (a > asc) asc = a;
    if (d > desc) desc = d;
  }
  return {
    ref: MAPNAME_REF,
    adv,
    ascent: asc > 0 ? asc : MAPNAME_REF * 0.8,
    descent: desc > 0 ? desc : MAPNAME_REF * 0.2,
  };
}

class GlyphCache {
  constructor() {
    this.map = new Map();
    this.pixels = 0;
  }

  /**
   * 取一个字的贴图（基线位置写在 `ox` / `oy` 里 ✓）
   * @returns {{c:object,w:number,h:number,ox:number,oy:number,px:number}|null}
   */
  get(ch, size, color, dpr, kind) {
    /* 同 `SpriteCache`：屏幕贴图 / 导出贴图的 dpr 不同，不能共用一张 ✗ */
    const dk = (Number(dpr) > 0 ? Number(dpr) : 1).toFixed(2);
    const key = dk + '|' + size.toFixed(1) + '|' + color + '|' + fontTag(kind) + '|' + ch;
    const hit = this.map.get(key);
    if (hit !== undefined) return hit;
    if (size > SPRITE_MAX_FONT) return null;

    const ctx = scratchCtx();
    ctx.font = fontFor(size, kind);
    const m = ctx.measureText(ch);
    const adv = Math.max(1, (m && m.width) || size * 0.5);
    const asc = (m && m.fontBoundingBoxAscent != null) ? m.fontBoundingBoxAscent
      : (m && m.actualBoundingBoxAscent != null) ? m.actualBoundingBoxAscent : size * 0.8;
    const desc = (m && m.fontBoundingBoxDescent != null) ? m.fontBoundingBoxDescent
      : (m && m.actualBoundingBoxDescent != null) ? m.actualBoundingBoxDescent : size * 0.2;

    const pad = Math.ceil(Math.max(2, size * 0.13));   // 描边 / 斜体的余量
    const w = Math.ceil(adv) + pad * 2;
    const h = Math.ceil(Math.max(1, asc) + Math.max(1, desc)) + pad * 2;
    const px = Math.ceil(w * dpr) * Math.ceil(h * dpr);
    if (px > GLYPH_BUDGET / 4) return null;

    while (this.pixels + px > GLYPH_BUDGET && this.map.size) {
      const oldest = this.map.keys().next().value;
      this.pixels -= this.map.get(oldest).px;
      this.map.delete(oldest);
    }

    const c = document.createElement('canvas');
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = fontFor(size, kind);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    g.lineWidth = Math.max(1.3, size * 0.14);
    g.strokeStyle = LABEL_STROKE;
    g.strokeText(ch, pad, pad + asc);
    g.fillStyle = color;
    g.fillText(ch, pad, pad + asc);

    /* ⚠ 锚点放**贴图正中心** ✗ 不是"基线" ✗（2026-10-22 改）
     *   文档 §3.6 的四边形是"中心在基线上、上下各 h/2"✓
     *   所以字是**骑在曲线上的**，不是坐在曲线上 ✓
     *   用基线锚点的话，字会整体偏高约 0.4em，贴图顶部容易顶出版图 ✓
     *   ⚠ 高宽用的是**这个字号下的整行框**（fontBoundingBox 是字体级的 ✓
     *     'a' 和 'g' 不会各算各的 ✓ 拉丁文的基线才对得齐 ✓）*/
    const sprite = { c, w, h, ox: w / 2, oy: h / 2, px };
    this.map.set(key, sprite);
    this.pixels += px;
    return sprite;
  }

  clear() {
    this.map.clear();
    this.pixels = 0;
  }
}

// ---------------------------------------------------------------- 标注层

export class LabelLayer {
  constructor(canvas, titles, meta = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.titles = titles;
    this.enabled = true;
    this.dpr = 1;
    this.drawn = 0;
    this.view = { x: 0, y: 0, w: 1, h: 1 };
    this.scale = 1;
    this.hover = null;
    /* 🔴 **名字层的帧预算**（2026-10-23 改）
     *   以前是"自适应上限 `_cap`"：慢了就永久少画一些，只有再次重画才慢慢涨回来 ✗
     *   → 缩放停下后名字回不来，**得动一下鼠标触发重画才补齐** ✓（用户："鼠标移过去了再画"）
     *   现在改成**按帧计时**：交互中只画 frameBudgetMs 那么多毫秒，
     *   手一停（app 那边 250ms 定时器）预算恢复成 Infinity 并补画一帧 ✓ */
    this.frameBudgetMs = Infinity;
    this._truncated = false;
    this.zoom = (meta && meta.labelZoom) || MIN_ZOOM_PERCENT;
    /* 🔴 国名层不设缩放门槛（2026-10-27 用户："不要那个 20 门槛"）
     *   `computeLabelZoom()` 已经给 0 了 ✓ 这里再兜一道：
     *   老数据 / 别处直接传进来的 labelZoom 里国名层还可能是 20 ✓
     *   ⚠ 0 = 不设门槛，不是"永不显示" ✗（`draw` / `paintExport` 判 `need == null` 才跳过）*/
    {
      const _nCountry = countryTierCount(meta);
      for (let t = 0; t < _nCountry && t < this.zoom.length; t++) this.zoom[t] = 0;
    }
    this.sprites = new SpriteCache();
    this.glyphs = new GlyphCache();

    /* ---- P社式排版（见文件头那段 ✓）----
     * `mode`: off = 老样子（横着写） / power = 只排国名 / both = 国名 + 大地名 ✓
     * `source`: app.js 在开图之后塞进来的 `RealmMaskSource` ✓（null = 这张图不支持 ✓）
     * `cache`: 排版结果（地图坐标 ✓ 跟缩放无关 ✓）
     * `metrics`: 字形度量（一段文字量一次 ✓）
     */
    this.mapNameMode = 'both';
    this.mapNameParams = mapNameParams();
    this.debug = false;             // 排版调试：画基线 / 字框 / 包围盒 / 质心 ✓
    /* 也可以直接开：`pdx-map-editor.html#mapdebug`（不用进设置翻 ✓）*/
    this.debugHash = (typeof location !== 'undefined' && location.hash)
      ? /mapdebug/.test(String(location.hash)) : false;
    this.debug = this.debugHash;
    this.realmMask = null;
    this.realmPos = null;          // 各省质心（涂色块估包围盒用 ✓）
    this._layoutCache = new Map();
    this._metricsCache = new Map();
    this._layoutHits = 0;
    this._layoutMiss = 0;
    // 一帧只读一次的视口尺寸（CSS px）
    this.cssW = canvas.clientWidth || 1;
    this.cssH = canvas.clientHeight || 1;

    // 每帧复用的临时数组，稳态下不产生垃圾
    this._text = [];
    this._x = [];
    this._y = [];
    this._size = [];
    this._hot = [];
    this._color = [];   // 标签自带颜色（「国名取色」给的；空串 = 用默认米白）
    this._layout = [];  // 这个标排好版了没（有就逐字画 ✓ 没有走老那套 ✓）
    this._kind = [];    // 'power' | 'place' —— 字号/字体两条路的分类（跟 _fontSize 同一个口径 ✓）
    this._buckets = new Map();
    this._bucketKeys = [];

    const area = titles.area || titles.provCount.map((n) => n * 3300);
    this.area = area;
    // 字号看的是**名字实际待着的那块地**有多大：像 1618 年的西班牙横跨大西洋，
    // 拿全部地盘算字号会撑得离谱，而名字其实是写在伊比利亚那一块上的。
    this.sizeArea = titles.blockArea || area;

    // 层级数按数据来：CK3/EU4/HOI4 是 5 层，维多利亚3 是 4 层
    const nTier = (meta && meta.tiers && meta.tiers.length) || 5;
    // hideLabel: 只隐藏地名的节点（比如含岛屿的大西洋），照旧可涂
    const hideLabel = titles.hideLabel;
    // 有几个“剧本/年份层”（国家层）：EU4 三层、HOI4 两层、V3 一层；
    // CK3/EU5 没有剧本层 → 退化成 1（只有最粗那层吃门槛）。
    // 有几个"国家层"：EU4 三个年份层、HOI4 两个剧本、V3 一个。
    // **CK3 的帝国/王国/公爵领是封建头衔，不是国家**，EU5 现在也还没有归属层
    // —— 这两个模式给 0，界面上那个「国名」开关会直接藏掉。
    this.nEra = (meta && meta.eraDates && meta.eraDates.length) || 0;
    this.byTier = Array.from({ length: nTier }, () => []);
    const { lx, ly } = titles;
    for (let i = 0; i < area.length; i++) {
      if (lx[i] == null || ly[i] == null || !area[i]) continue;
      const t = titles.tiers[i];
      if (t < 0 || t >= this.byTier.length) continue;
      if (hideLabel && hideLabel[i]) continue;   // 只隐藏地名（照旧可涂）  // 海/湖/河/山这类伪头衔不上地名
      this.byTier[t].push(i);
    }
    for (const list of this.byTier) list.sort((a, b) => area[b] - area[a]);
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = Math.max(1, this.canvas.clientWidth || 1);
    this.cssH = Math.max(1, this.canvas.clientHeight || 1);
    const w = Math.max(1, Math.floor(this.cssW * this.dpr));
    const h = Math.max(1, Math.floor(this.cssH * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.sprites.clear();           // 画布重建了，之前的贴图按尺寸分的，作废
      this.glyphs.clear();            // 逐字那套同理 ✓
    }
  }

  /* ================================================================ P社式排版接口 */

  /**
   * 把"版图从哪来"接进来（app.js 开图之后调一次 ✓）
   *
   * @param {object|null} o `{provinceIds,width,height,titleAt,noTitle,cell}`
   *   传 null = 这张图不支持（分块地图 / 数据没齐）→ 全部退回老画法 ✓
   */
  setRealmMask(o) {
    this.realmMask = (o && o.provinceIds && o.provinceIds.length > 1
      && o.titleAt) ? new RealmMaskSource(o) : null;
    this.realmPos = (o && o.provPos) || null;
    /* 色块的"每省属于哪一块"（2026-10-23）—— 全图共用一张块号栅格 ✓
     * ⚠ 涂色一变 `blockVer` 就变，这边看到版本变了会重建 ✓ 不用整份清缓存 ✓ */
    this.blockOf = (o && o.blockOf) || null;
    this.blockVerFn = (o && o.blockVer) || null;
    this._blockMask = null;
    this._blockMaskVer = -1;
    this.clearLayouts();
  }

  /** 块号栅格：没有就现建；`blockVer` 变了就重建（涂色之后 ✓） */
  _ensureBlockMask() {
    if (!this.blockOf || !this.realmMask || !this.realmMask.usable) return null;
    let ver = 0;
    try { ver = this.blockVerFn ? (this.blockVerFn() | 0) : 0; } catch (e) { ver = 0; }
    if (this._blockMask && this._blockMaskVer === ver) return this._blockMask;
    this._blockMask = new RealmMaskSource({
      provinceIds: this.realmMask.ids,
      width: this.realmMask.width,
      height: this.realmMask.height,
      titleAt: this.realmMask.titleAt,
      noTitle: this.realmMask.noTitle,
      cell: this.realmMask.cell,
      groupOf: (pid) => this.blockOf(pid),
    });
    this._blockMaskVer = ver;
    return this._blockMask;
  }

  /** 排版模式：off / power / both（设置页那个下拉 ✓ 每帧现读也行，这里存一份 ✓） */
  setMapNameMode(mode) {
    const m = (mode === 'off' || mode === 'power' || mode === 'both') ? mode : 'both';
    if (m !== this.mapNameMode) {
      this.mapNameMode = m;
      this.clearLayouts();
    }
  }

  /** 排版参数（设置页/自测改参数之后调一下 ✓） */
  setMapNameParams(over) {
    this.mapNameParams = mapNameParams(over);
    this.clearLayouts();
  }

  /** 排版缓存作废（换层 / 换图 / 改名 / 换字体 / 调字号都要 ✓） */
  clearLayouts() {
    this._layoutCache.clear();
    this._metricsCache.clear();
    this._layoutHits = 0;
    this._layoutMiss = 0;
  }

  /** 字号总倍率 —— 跟 `_fontSize` 同一个口径（势力名那块 / 地块名那块 ✓） */
  _userScale(tier = 0, layer = 0) {
    const _w = (typeof window !== 'undefined') ? window : null;
    const legacy = (_w && _w.__CK3_FONT_SCALE) || 1;
    const isPower = (tier < (this.nEra || 1)) || (layer === 2);
    return isPower ? ((_w && _w.__CK3_FONT_POWER) || legacy)
                   : ((_w && _w.__CK3_FONT_PLACE) || legacy);
  }

  /** 一段字的度量（带缓存 ✓ 键里带字体 ✓） */
  _textMetrics(text, kind) {
    const key = fontTag(kind) + '\u0000' + text;
    let m = this._metricsCache.get(key);
    if (m === undefined) {
      m = glyphMetrics(text, kind);
      if (this._metricsCache.size > 4000) this._metricsCache.clear();
      this._metricsCache.set(key, m);
    }
    return m;
  }

  /**
   * 给一个标排版（没有就现排 + 缓存 ✓）
   *
   * @param {object} p 标（`{name,x,y,area,tier,layer,tid}` ✓）
   * @param {'power'|'place'} kind
   * @param {number} size0 老算法算出来的屏幕字号（现在只留着兼容调用点 ✓ 不再拿它卡门槛）
   * @returns {object|null|undefined} 排好的 {fs,glyphs,bbox,...} /
   *   null = 这块地排不出来（走老画法） /
   *   null = 这块地排不出来（走老画法 ✓）
   */
  _maybeLayout(p, kind, size0) {
    if (!p) return null;
    if (this.mapNameMode === 'off' || !this.realmMask || !this.realmMask.usable) return null;
    if (kind === 'place' && this.mapNameMode !== 'both') return null;
    /* 🔴 **色块名（layer 2）也能套** ✗✗（2026-10-22 用户实拍："哪里有，根本没有"）
     *   年份视图里的国名走的就是这条路（`paintedPoints` 按色块聚出来的）✗
     *
     * 🔴🔴 **色块的版图 = 那一组省，永远不看头衔** ✗✗（2026-10-23 用户纠正：
     *   "为什么没涂的看头衔，那怎么行，别忽视旧秩序"）
     *   旧秩序一直是：**画面上看到的这一国 = 同颜色 + 同名字的那一组省** ✓
     *   头衔的完整范围跟画面上不一样（被占走的省显示成别人的颜色 ✗）——
     *   拿头衔当版图，名字就会写到别的国家的色块上去 ✗
     *   所以：**只要这一块带着省号集合，就用它当版图**，涂没涂一视同仁 ✓
     *   这样"同样颜色范围"的两块，几何完全一样 → 名字也一样 ✓ */
    /* 🔴 **位图字体也能贴合了**（2026-10-23 用户："导入的字体没法实现版图适应弯曲"）
     *   以前这里一行 `if (BITMAP[kind]) return null;` 把位图字体全挡在门外 ✗
     *   现在 `glyphMetrics` 会给位图字体拼一份度量（lineHeight / base / xadvance ✓），
     *   绘制端再用 `bf.drawGlyph` 逐字旋转贴 ✓ 见 `_paintGlyphs` / `paintExport` ✓ */
    const tid = p.tid;
    const name = String(p.name || '');
    if (!name) return null;
    /* 用**哪一层**的版图查：色块名带 `mtier`（它自己那一层 ✓）；
     * 普通头衔点就是 `p.tier` ✓。⚠ 别拿 `p.tier` 代替色块名 —— 它被写死成 0
     * （字号/不透明度的分类口径），不是归属层 ✓ */
    const tier = (p.mtier != null) ? (p.mtier | 0) : (p.tier || 0);
    const us = this._userScale(p.tier || 0, p.layer || 0);

    /* ---- 选版图 ---- */
    let mask = this.realmMask;
    let maskTag = 'r';
    const needPidMask = p.layer === 2 && p.gid != null && p.gid >= 0 && !!this.blockOf;
    if (needPidMask) {
      /* 🔴 **一张全图级的块号栅格**（2026-10-23 修卡顿）
       *   上一版每块色块现搭一张小栅格、缓存 48 张 —— 一屏几十上百个色块，
       *   等于每帧重搭一遍 → 卡爆 ✗
       *   现在 app 直接把"每个省属于哪一块"（`blockOf`）给过来，
       *   跟头衔栅格同一个做法：全图只建一张，所有色块共用 ✓
       *   块号一变（涂色）→ 版本号变 → 重建一次 ✓ */
      const bm = this._ensureBlockMask();
      if (!bm || !bm.usable) return null;
      mask = bm;
      maskTag = 'b' + this._blockMaskVer;
    }
    if (!mask || !mask.usable) return null;
    if (maskTag === 'r' && (tid == null || tid < 0)) return null;

    /* 缓存键：**锚点按 1px 量化** ✓（同一个头衔的本土 + 殖民地各有一个标 ✓
     *   它们要各排各的 ✓ 但每帧的质心有亚像素抖动，不量化就一帧都命中不了 ✓
     *   ⚠ 别量化得太粗（32px）✗ —— 挨得近的两块殖民地会共用一条缓存，
     *     第二个标会跑到第一个标的位置上 ✓ 1px 够区分、又稳 ✓）*/
    const gidKey = needPidMask ? (p.gid != null ? p.gid : -1) : -1;
    /* 🔴 **键在点对象上缓存一份** ✗✗（2026-10-23 体检）
     *   每一帧、每个标都要拼一次长键（六七个字符串拼接）—— 一屏上千个就是上千个小字符串 ✗
     *   相机平移 / 缩放**不改变**构成键的各项（锚点在地图坐标里是定死的 ✓）→
     *   把上次的键记在点对象上，逐项比一遍（数字 + 字符串引用比较，很便宜）✓
     *   任何一项变了（换层 / 涂色 / 换字体 / 改名）才重拼 ✓ */
    const mver = needPidMask ? (this._blockMaskVer | 0) : -1;
    const idPart = needPidMask ? gidKey : (tid == null ? -1 : tid);
    const ft = fontTag(kind);
    const rx = Math.round(p.x), ry = Math.round(p.y);
    const lk = p._lk;
    let key;
    if (lk && lk.mver === mver && lk.tier === tier && lk.id === idPart
        && lk.rx === rx && lk.ry === ry && lk.us === us && lk.ft === ft && lk.name === name) {
      key = lk.key;
    } else {
      key = (needPidMask ? 'b' : 'r') + mver + '|' + tier + '|' + idPart
        + '|' + rx + ',' + ry + '|' + us + '|' + ft + '|' + name;
      p._lk = { mver, tier, id: idPart, rx, ry, us, ft, name, key };
    }
    const hit = this._layoutCache.get(key);
    if (hit !== undefined) { this._layoutHits++; return hit; }
    this._layoutMiss++;
    const lay = layoutMapName(name, mask, tid, tier,
      this._textMetrics(name, kind), {
        gid: needPidMask ? p.gid : null,
        anchor: { x: p.x, y: p.y, area: p.area },
        userScale: us,
        params: this.mapNameParams,
        curve: this.mapNameParams.curve,
      });
    // 缓存上限：开局会**整层预热**（见 `warmPoint` ✓），名额要够装下几层 ✓
    // 一条 = 几个字的 x/y/角度（几十字节）→ 6 万条约几 MB ✓
    // ⚠ 失败（null）也要记，也要占名额 ✗ —— 不删的话失败条目会无限涨 ✓
    if (this._layoutCache.size >= LAYOUT_CACHE_MAX) {
      const oldest = this._layoutCache.keys().next().value;
      this._layoutCache.delete(oldest);
    }
    this._layoutCache.set(key, lay || null);   // null 也缓存：省得每帧重试一遍必失败的 ✓
    return lay;
  }

  /**
   * 预热一个标的排版（开局整层跑一遍时用 ✓）
   *
   * 用户 2026-10-23："这些玩意没有重算的可能，开局的时候算完一遍就行了，定死了的"
   * 排版结果只跟（层 / 头衔 / 文字 / 字体 / 用户字号）有关，**跟缩放无关** ✓
   * 所以开局算完，之后放大缩小、平移动画全是查表 ✓
   * ⚠ 换字体 / 调字号 / 改名会让缓存整份作废（`clearLayouts` ✓）→ 再由 app 重新预热 ✓
   */
  warmPoint(p, kind) {
    if (!p || !p.name) return;
    this._maybeLayout(p, kind || 'place', 0);
  }

  /** 调试角标：这一帧有多少标 / 多少同名重复 ✓ */
  _paintDebugHud(ctx, n, dup) {
    const dpr = this.dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '13px "Microsoft YaHei", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(8, 8, 360, 26);
    let dupN = 0;
    if (dup) for (const v of dup.values()) if (v > 1) dupN++;
    ctx.fillStyle = '#7dff9a';
    ctx.fillText(`排版调试：标签 ${n} · 贴合 ${this.fitCount} · 横排 ${this.flatCount}`
      + ` · 同名重复 ${dupN} · 缩放 ${(this.scale * 100).toFixed(0)}%`
      + ` · ${(this.lastMs || 0).toFixed(1)}ms`, 14, 14);
    ctx.restore();
    /* 同名重复每秒在控制台提醒一次（F12 能看到是哪个名字 ✓）*/
    if (dupN) {
      const now = Date.now();
      if (!this._dupAt || now - this._dupAt > 1000) {
        this._dupAt = now;
        for (const [nm, c] of dup) if (c > 1) console.warn('[排版] 同名标', nm, '×' + c);
      }
    }
  }


  /**
   * 贴合排版在屏幕上太小时，整条名字要绕自己的中心放大多少倍（1 = 不放大 ✓）
   * 口径就这一处：`_paintGlyphs` 按它画、`_paint` 按它算包围盒 ✓
   */
  _fitGrow(lay) {
    const px = lay.fs * this.scale;
    if (!(px > 0.05)) return 1;
    return px >= MIN_DRAW ? 1 : Math.min(MIN_DRAW / px, 4);
  }

  /**
   * **逐字画一段排版结果** —— 屏幕和导出共用这一份（2026-10-23 体检：去重）
   *
   * 两边原来各写一遍（屏幕那份带视口裁剪、导出那份带倍率换算），
   * 逻辑一样、只差坐标变换 → 收成一个出口，改一处两边都对 ✓
   *
   * @param {object} o
   *   `ctx` 目标 2D context / `lay` 排版结果 / `size` 字号（已经乘过倍率、已量化 ✓）
   *   `color` 颜色 / `kind` 'power' | 'place'
   *   `dpr` 设备像素比（屏幕传 this.dpr，导出传 1 ✓）
   *   `origin(g)` 把某个字换算成目标坐标 → `{x,y}`（返回 null = 跳过这个字 ✓）
   *   `cull` 可选 `{w,h}`：屏幕外跳过（导出不传 ✓）
   * @returns {number} 画了几个字
   */
  _drawGlyphRun(o) {
    const ctx = o && o.ctx;
    const glyphs = (o && o.lay && o.lay.glyphs) || null;
    const size = o && o.size;
    if (!ctx || !glyphs || !glyphs.length || !(size > 0)) return 0;
    const { color, kind } = o;
    const dpr = o.dpr || 1;
    const origin = o.origin;
    if (typeof origin !== 'function') return 0;
    const bfg = BITMAP[kind];
    /* 高倍导出直接走实时矢量，不再从字形贴图里取样 ✓
     *   （2026-10-27 用户："高倍下字体应该更清晰"）
     *   贴图是按字号缓存再 drawImage 的，高倍下会有一次重采样；
     *   实时 fillText 没有这一步，边缘更干净 ✓ 1× 仍走贴图，省时间 ✓ */
    const live = !bfg && (o.exportText || size > SPRITE_MAX_FONT);
    if (live) {
      ctx.font = fontFor(size, kind);
      ctx.lineWidth = Math.max(1.3, size * 0.14);
      ctx.strokeStyle = LABEL_STROKE;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    }
    const outline = Math.max(1, size * 0.09);
    const cull = o.cull || null;
    let drawn = 0;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      const ch = g && g.ch;
      if (!ch || ch === ' ' || ch === '\u00a0') continue;
      const q = origin(g);
      if (!q) continue;
      if (cull) {
        const r = size * 1.3;
        if (q.x < -r || q.x > cull.w + r || q.y < -r || q.y > cull.h + r) continue;
      }
      if (bfg) {
        bfg.drawGlyph(ctx, ch, q.x, q.y, size, g.angle, color, outline, LABEL_STROKE);
        drawn++;
        continue;
      }
      const cos = Math.cos(g.angle), sin = Math.sin(g.angle);
      ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, dpr * q.x, dpr * q.y);
      if (live) {
        ctx.strokeText(ch, 0, 0);
        ctx.fillStyle = color;
        ctx.fillText(ch, 0, 0);
      } else {
        const sp = this.glyphs.get(ch, size, color, dpr, kind);
        if (!sp) continue;
        ctx.drawImage(sp.c, -sp.ox, -sp.oy, sp.w, sp.h);
      }
      drawn++;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return drawn;
  }

  /** 把排好的字逐字画出来（屏幕用：带视口裁剪 + 太小时绕中心放大 ✓） */
  _paintGlyphs(ctx, lay, view, color, kind) {
    const scale = this.scale;
    const sizePx = lay.fs * scale;
    /* 连放大 4 倍都够不着 MIN_DRAW（< 1px）→ 那是真看不见了，不画 ✓ */
    if (!(sizePx * 4 >= MIN_DRAW)) return 0;
    const grow = this._fitGrow(lay);
    const size = quantizeFont(sizePx * grow);
    /* 放大时绕**排版包围盒中心** ✓（不绕视口原点，否则名字会跑位 ✓）*/
    const bx = lay.bbox ? (lay.bbox.x0 + lay.bbox.x1) / 2 : null;
    const by = lay.bbox ? (lay.bbox.y0 + lay.bbox.y1) / 2 : null;
    const drawn = this._drawGlyphRun({
      ctx, lay, size, color, kind, dpr: this.dpr,
      cull: { w: this.cssW, h: this.cssH },
      origin: (g) => ({
        x: bx == null ? (g.x - view.x) * scale : (bx - view.x) * scale + (g.x - bx) * scale * grow,
        y: by == null ? (g.y - view.y) * scale : (by - view.y) * scale + (g.y - by) * scale * grow,
      }),
    });
    // 画布变换已由 _drawGlyphRun 还原 ✓ 这里只要把文字对齐恢复成默认 ✓
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    return drawn;
  }

  /**
   * **排版调试层**（设置里勾「排版调试」才画 ✓）
   *
   * 画什么：
   *   · 青色框 = 这块地的**连通域包围盒**
   *   · 红点   = 连通域**质心**（居中就对准它 ✓）
   *   · 品红线 = 选中的那段"最长连续命中段"
   *   · 黄线   = 实际基线折线（曲线化之后的 ✓）
   *   · 绿框   = 每个字的四边形（宽 = advance、高 = 字号、按切线转 ✓）
   *
   * 用户报"七零八落"时，看这张图就知道是**线乱了**还是**字没跟着线** ✓
   */
  _paintLayoutDebug(ctx, lay, view, dup) {
    const s = this.scale, dpr = this.dpr;
    /* 跟 `_paintGlyphs` 同一个放大口径：调试框必须画在**实际画出来的位置**上 ✓ */
    const gr = this._fitGrow(lay);
    const bcx = lay.bbox ? (lay.bbox.x0 + lay.bbox.x1) / 2 : 0;
    const bcy = lay.bbox ? (lay.bbox.y0 + lay.bbox.y1) / 2 : 0;
    const X = (x) => (bcx - view.x) * s + (x - bcx) * s * gr;
    const Y = (y) => (bcy - view.y) * s + (y - bcy) * s * gr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);

    // 连通域包围盒
    if (lay.compBox) {
      const b = lay.compBox;
      ctx.strokeStyle = 'rgba(0, 210, 255, 0.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(X(b.x0), Y(b.y0), (b.x1 - b.x0) * s, (b.y1 - b.y0) * s);
    }
    // 选中的那一段（run）
    if (lay.run) {
      ctx.strokeStyle = 'rgba(255, 0, 220, 0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(lay.run.a.x), Y(lay.run.a.y));
      ctx.lineTo(X(lay.run.b.x), Y(lay.run.b.y));
      ctx.stroke();
    }
    // 实际基线折线
    if (lay.path && lay.path.length) {
      ctx.strokeStyle = 'rgba(255, 220, 0, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(X(lay.path[0].x), Y(lay.path[0].y));
      for (let i = 1; i < lay.path.length; i++) ctx.lineTo(X(lay.path[i].x), Y(lay.path[i].y));
      ctx.stroke();
    }
    // 每个字的四边形 + 中心
    const fs = lay.fs * s * gr;
    ctx.strokeStyle = 'rgba(0, 255, 120, 0.9)';
    ctx.fillStyle = 'rgba(0, 255, 120, 0.9)';
    ctx.lineWidth = 1;
    for (const g of lay.glyphs) {
      const gx = X(g.x), gy = Y(g.y);
      const w = Math.max(2, (g.adv || lay.fs) * s * gr);
      const h = Math.max(2, fs);
      const ca = Math.cos(g.angle), sa = Math.sin(g.angle);
      const hw = w / 2, hh = h / 2;
      const p = [
        [gx - hw * ca + hh * sa, gy - hw * sa - hh * ca],
        [gx + hw * ca + hh * sa, gy + hw * sa - hh * ca],
        [gx + hw * ca - hh * sa, gy + hw * sa + hh * ca],
        [gx - hw * ca - hh * sa, gy - hw * sa + hh * ca],
      ];
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(gx, gy, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // 质心
    if (lay.centroid) {
      ctx.fillStyle = 'rgba(255, 60, 60, 0.95)';
      ctx.beginPath();
      ctx.arc(X(lay.centroid.x), Y(lay.centroid.y), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // 信息
    ctx.font = '12px "Microsoft YaHei", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255, 230, 90, 0.95)';
    const bx = X(lay.bbox.x0), by = Y(lay.bbox.y0) - 3;
    const n = dup && dup.get(lay.name);
    ctx.fillText(`${lay.name} · ${lay.fs.toFixed(0)}px · ${(lay.angle * 57.3).toFixed(0)}°`
      + (n > 1 ? ` · 同名 ×${n}` : ''), bx, by);
    ctx.restore();
  }


  clear() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** 画前的公共准备，返回 2D context */
  _begin(view) {
    this.resize();
    this.clear();
    this.view = view;
    this.scale = this.cssW / view.w;
    this.drawn = 0;
    /* 这一帧里"贴合版图"和"老画法横排"各画了几个（调试角标要报 ✓）*/
    this.fitCount = 0;
    this.flatCount = 0;

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    return ctx;
  }

  /**
   * 一个地块的字号：它在屏幕上占多大 × FONT_RATIO，细层级再乘一个倍率。
   * 屏幕尺寸 = √像素数 × 缩放，所以字号对缩放是线性的 —— 放大两倍字就大两倍。
   *
   * **没有保底。** 算出来够不着 MIN_FONT 就返回 0，调用方直接**不画**这个地名。
   * 以前是硬撑到 MIN_FONT，于是缩小时密密麻麻的小国名全挤在一起。
   * 现在 MIN_FONT 是"够不够格显示"的门槛，不是下限。
   */
  /*  🔴🔴 **2026-10-17：字号拆成两个** ✗✗（用户："把字号分开两个，一个给地块，一个给势力"✓）
   *
   *  以前只有一个 `__CK3_FONT_SCALE` ✗ —— 调大地名，国名也跟着一起大 ✓ 两件事绑死 ✓
   *  现在分成：`__CK3_FONT_PLACE`（地块名 ✓）/ `__CK3_FONT_POWER`（势力名 ✓）
   *
   *  ⚠⚠ **用现成的判据分这两类** ✗✗ —— 代码里本来就有，别新造字段 ✓
   *    · `tier < nEra` = **时代层**（剧本 / 年份那几层的国名 / 势力名 ✓）
   *      `open()` 和上面那道字号门槛**用的就是它** ✓ 同一个口径 ✓
   *    · `layer === 2` = **玩家涂出来的色块名** ✓（`_paint` 里那个"玩家名"层 ✓
   *      见 drawPoints 里"地名 0 / 国名 1 / 玩家名 2"那段 ✓）
   *    · 其余（`tier >= nEra` 且不是色块）→ **地块名** ✓（含海 / 湖 / 河 / 荒地名 ✓）
   *  ⚠ `this.nEra` 本来就在（构造时从 meta.eraDates 取 ✓）—— 别再传 `nEra` 进来 ✗
   *  ⚠ **两个都要留回退** ✗ —— 老的内联产物 / 测试桩可能只设了旧那个名字 ✓
   *    回退顺序：新名字 → 旧名字 `__CK3_FONT_SCALE` → 1 ✓
   *    （"只设旧值"的环境行为**跟改造前一模一样** ✓ 不炸也不变 ✓）
   *  @param {number} pixels 面积（√ 之后就是边的像素数 ✓）
   *  @param {number} tier   这个点自己那一层（`open()` 拿它查缩放门槛 ✓）
   *  @param {number} layer  这个点画在哪一层（0 地名 / 1 国名 / 2 玩家名 ✓ 缺省 0 ✓）*/
  _fontSize(pixels, tier = 0, layer = 0) {
    const side = Math.sqrt(Math.max(pixels || 1, 1)) * this.scale;
    const boost = TIER_FONT_BOOST[tier] || 1;
    const _userScale = this._userScale(tier, layer);
    const size = side * FONT_RATIO * boost * _userScale;
    // **只有最粗那一层（国名/大洲名）留一道可读底线**，其余层一律 0 = 全显示。
    // 不按下标查表：层数每个游戏不一样（EU5 有 6 层），查不到就会退回 MIN_FONT，
    // 结果细层又被卡住 —— 统一成"第 0 层之外都全显示"就没这个问题。
    // 0 层（国名）留一道**字号底线**：`√像素 × 缩放 × 0.18` 小于它就不画。
    // （2026-10-27 用户："不要那个 20 门槛" → 4px 降到 **2px** ✓
    //   4px 时 EU4 的 665 个国家大多要 ~20% 才够大 ✓ 降到 2px 后
    //   10% 就能浮出二十来个、20% 上百个；再往下会糊成蚂蚁字 ✗）
    // ⚠ 这里是"可读性底线"，不是缩放门槛 ✗ —— 缩放门槛已经全部置 0 ✓
    // 「全部地名」只管"要不要隐藏"，**不改字号** —— 该多大就多大。
    // （以前这里写成 Math.max(size, 8)，一勾上小于 8px 的地名全被放大，
    //   看起来就是"勾了之后字号变了"。）
    if (this.showAll) return size;
    const floor = tier < (this.nEra || 1) ? (TIER_MIN_FONT[0] ?? 4) : 0;
    return size < floor ? 0 : size;
  }

  /** 把 this._text[0..n) 这批标签画出来（按字号分桶，每桶只设一次 font） */
  _paint(ctx, n, view) {
    this._truncated = false;      // 这一帧到底有没有被预算截断（给自测 / 调试看 ✓）
    const buckets = this._buckets;
    const keys = this._bucketKeys;
    for (const arr of buckets.values()) arr.length = 0;   // 数组留着复用，清内容

    const S = this._size;
    const LY = this._layer || [];
    const L = this._layout || [];
    const KINDS = this._kind || [];
    // 桶键把"层"也编进去：层小的（地名）先画、压在最下面；同一层里字号大的先画。
    // 编码方式：layer * 100000 + (100000 - 字号)，升序遍历就是这个次序。
    // 字号上限远小于 100000（现在最大也就几十像素），不会串。
    const KEY = 100000;
    for (let k = 0; k < n; k++) {
      const q = quantizeFont(S[k]);
      S[k] = q;
      const key = (LY[k] || 0) * KEY + (KEY - q);
      let arr = buckets.get(key);
      if (arr === undefined) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(k);
    }

    // 桶是复用的，键得**从桶里现取** —— 只清 keys 不清 buckets 的话，
    // 第二帧的桶还在、get() 都不是 undefined，就一个键都收不进来，整帧空白。
    keys.length = 0;
    for (const q of buckets.keys()) keys.push(q);
    keys.sort((a, b) => a - b);        // 升序 = 层小的先画、同层内大的先画

    const T = this._text;
    const X = this._x;
    const Y = this._y;
    const HOT = this._hot;
    const F = this._fade || [];
    const C = this._color || [];   // 每个标签自己的颜色（没有就落 LABEL_FG）
    const cssW = this.cssW;
    const cssH = this.cssH;
    const dpr = this.dpr;
    const scale = this.scale;
    const sprites = this.sprites;

    /* 调试模式：先数一遍同名标（同一个名字被几个标画了 ✓）*/
    let dup = null;
    if (this.debug) {
      dup = new Map();
      for (let k = 0; k < n; k++) {
        const l = L[k];
        if (l) dup.set(l.name, (dup.get(l.name) || 0) + 1);
      }
    }

    for (const key of keys) {
      const size = KEY - (key % KEY);      // 从桶键里把字号取回来
      const list = buckets.get(key);
      const layer = Math.floor(key / KEY);
      const half = size * 1.15 / 2;
      // 位置粗筛的余量：地名再长也不会超过 size * 8 的半宽（十几个汉字都够）
      const pad = size * 8;
      /* 这一桶用什么字体：**按每个标自己的类别**（`_kind` ✓）——
       * ⚠ 不能只看桶键里的层 ✗：年份层的国名是从"普通头衔点"那条路来的，
       *   层号是 0（跟地名一样）✓ 可它该用「势力名」那套字体和字号 ✓
       *   （`_fontSize` 早就是按 `tier < nEra` 分的 ✓ 这里只是把同一个口径补齐 ✓）*/
      let curKind = '', curSize = 0;

      const _p0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const _budget = this.frameBudgetMs;
      for (let _li = 0; _li < list.length; _li++) {
        const k = list[_li];
        if (this.drawn >= MAX_LABELS) break;
        /* 🔴 **交互中按时间预算截断**（2026-10-23）
         *   缩放 / 拖动时一屏名字可能画不完 —— 只画到 budget 毫秒就打住，
         *   剩下的等"手停下来"那次全量重画补齐 ✓
         *   ⚠ 不许把截断变成常态 ✗（以前的自适应上限就犯了这个错：
         *     停下来也不补，得等下一次鼠标移动 ✓ 用户当场发现"移过去才画"）
         * ⚠ **必须 `>=`，不许 `>`** ✗✗（2026-10-24 EU4 回归抓到的 ✓）：
         *   排版提速后 16 个标画完 elapsed 还是 0，`0 > 0` 永远不成立 →
         *   budget=0 也能一路画到底 ✗ 预算形同虚设 ✓ `>=` 恢复语义 ✓
         *   （每 16 个才看一次钟是**故意的** ✓ 1 万个标逐个 now() 太贵 ✓）*/
        if ((_li & 15) === 15 && Number.isFinite(_budget)
            && ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - _p0) >= _budget) {
          this._truncated = true;
          break;
        }
        const fa = F[k] == null ? 1 : F[k];
        if (ctx.globalAlpha !== fa) ctx.globalAlpha = fa;
        const sx = (X[k] - view.x) * scale;
        const sy = (Y[k] - view.y) * scale;
        const kind = KINDS[k] || (layer >= 1 ? 'power' : 'place');
        // **标签可以自带颜色**（「国名取色」按钮给的，drawPoints 存进 _color）——
        // 悬浮时仍旧用米黄，免得看不出鼠标在哪 ✓
        const color = HOT[k] ? LABEL_FG_HOVER
          : (C[k] || LABEL_FG);

        /* 🔴 排好版的：**逐字画**（每个字自己的位置 / 角度 ✓ 见 maplabels.js）*/
        const lay = L[k];
        if (lay) {
          /* 太小会被 _paintGlyphs 绕中心等比放大 → 包围盒也得按放大后的算，
           * 不然边缘上看得见的名字会被提前剔掉 ✓（口径见 `_paintGlyphs` ✓）*/
          const gr = this._fitGrow(lay);
          const cx = (lay.bbox.x0 + lay.bbox.x1) / 2;
          const cy = (lay.bbox.y0 + lay.bbox.y1) / 2;
          const bx0 = (cx - view.x) * scale - (cx - lay.bbox.x0) * scale * gr;
          const bx1 = (cx - view.x) * scale + (lay.bbox.x1 - cx) * scale * gr;
          const by0 = (cy - view.y) * scale - (cy - lay.bbox.y0) * scale * gr;
          const by1 = (cy - view.y) * scale + (lay.bbox.y1 - cy) * scale * gr;
          if (bx1 < 0 || bx0 > cssW || by1 < 0 || by0 > cssH) continue;
          if (this._paintGlyphs(ctx, lay, view, color, kind) > 0) { this.drawn++; this.fitCount++; }
          if (this.debug) this._paintLayoutDebug(ctx, lay, view, dup);
          curKind = '';               // 逐字画里可能改过 font，下一条重新设 ✓
          continue;
        }

        // 先按位置粗筛，再量宽 —— 不然一帧要对上万个标签逐个 measureText
        if (sx < -pad || sx > cssW + pad || sy < -pad || sy > cssH + pad) continue;

        /* 这一档有没有挂位图字体 ✓ 有就用它逐字贴，没有走原来的 fillText */
        const bf = BITMAP[kind];
        if (!bf && (kind !== curKind || size !== curSize)) {
          ctx.font = fontFor(size, kind);
          ctx.lineWidth = Math.max(1.3, size * 0.14);
          ctx.strokeStyle = LABEL_STROKE;
          curKind = kind;
          curSize = size;
        }

        const text = T[k];
        const tw = measureCached(ctx, text, size, kind);
        const hw = tw / 2;
        if (sx + hw < 0 || sx - hw > cssW) continue;
        if (sy + half < 0 || sy - half > cssH) continue;

        const sp = sprites.get(text, size, color, dpr, tw, kind, bf);
        if (sp !== null) {
          ctx.drawImage(sp.c, sx - sp.w / 2, sy - sp.h / 2, sp.w, sp.h);
        } else if (bf) {
          /* 太大做不了贴图 → 现场逐字贴 ✓（描边照旧靠偏移 ✓）*/
          bf.draw(ctx, text, sx, sy, size, color,
            { outline: Math.max(1, size * 0.09), stroke: LABEL_STROKE });
        } else {
          ctx.strokeText(text, sx, sy);
          ctx.fillStyle = color;
          ctx.fillText(text, sx, sy);
        }
        this.drawn++;
        this.flatCount++;        // 走老画法（横排）的 —— 调试角标要报 ✓
      }
    }
    if (this.debug) this._paintDebugHud(ctx, n, dup);
  }

  /**
   * 常规画法。
   * @param {object} view   视口 {x, y, w, h}，单位是地图像素
   * @param {number} tier   当前层级
   * @param {number} hover  要高亮的头衔序号，没有就 null
   */
  draw(view, tier, hover = null) {
    const _t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!this.enabled) { this.resize(); this.clear(); return; }
    // **地名的显示门槛**：这一层要缩放到百分之多少才画 ✓（meta.labelZoom 给的）
    // 用户觉得"要放很大才一起冒出来"太晚了 ✗ → 统一放宽一档：
    // 这里乘一个系数，**越小越早出现** ✓ 想再宽/再紧就改这一个数 ✓
    const LABEL_ZOOM_RELAX = 0.7;
    const raw = this.zoom[tier];
    const need = raw == null ? null : raw * LABEL_ZOOM_RELAX;
    if (need == null) { this.resize(); this.clear(); return; }

    const ctx = this._begin(view);
    if (this.scale * 100 < need) return;

    const list = this.byTier[tier];
    if (!list || !list.length) return;
    const { names, lx, ly } = this.titles;
    const sizeArea = this.sizeArea;
    // **先按视口粗筛**：候选是按面积从大到小排的，密集的小块排在几万名之后，
    // 不先筛就会撞上 MAX_CANDIDATES —— 视口里明明有上百个，却一个都捞不着
    // （VIC3 最细层 4 万多个地块就是这样）。余量跟 _paint 的 pad 同口径。
    const padMap = Math.max(64, 900 / this.scale);
    const vx0 = view.x - padMap, vx1 = view.x + view.w + padMap;
    const vy0 = view.y - padMap, vy1 = view.y + view.h + padMap;

    const T = this._text;
    const X = this._x;
    const Y = this._y;
    const S = this._size;
    const HOT = this._hot;
    const F = this._fade || (this._fade = []);
    const C = this._color || (this._color = []);
    const L = this._layout || (this._layout = []);
    const KINDS = this._kind || (this._kind = []);
    let n = 0;
    for (const i of list) {
      // 这里**只防病态数据**，不用 MAX_LABELS 截 —— 先截就是把视口外的大块地
      // 当成了视口内的，放多大都可能一个名字都画不出来（见 MAX_CANDIDATES）
      if (n >= MAX_CANDIDATES) break;
      // 没名字的跳过（HOI4 的省份多数没有城市名，是真·无名地块）
      if (!names[i]) continue;
      // 视口外的直接跳过（写成一整个判断，顺带把没有坐标的也滤掉）
      if (!(lx[i] >= vx0 && lx[i] <= vx1 && ly[i] >= vy0 && ly[i] <= vy1)) continue;
      T[n] = names[i];
      X[n] = lx[i];
      Y[n] = ly[i];
      const size = this._fontSize(sizeArea[i], tier);
      if (size <= 0) continue;      // 太小了：不画，别硬撑成最小字号挤一片
      /* P社式排版：年份层（`tier < nEra`）是国名，走"贴合版图" ✓
       * ⚠ **排出来就一律按排好的画** ✗ 别按屏幕字号退回老画法 ——
       *   那会让画法随缩放变化（用户 2026-10-23：「不想只有特定缩放下才那样」✓）*/
      const kind = (tier < (this.nEra || 1)) ? 'power' : 'place';
      const lay = this._maybeLayout(
        { name: names[i], tid: i, x: lx[i], y: ly[i], area: sizeArea[i], tier, layer: 0 },
        kind, size);
      /* 现在 `_maybeLayout` 只会给 对象 / null；留一手 undefined（以后要加预算法也接得住 ✓）*/
      if (lay === undefined) continue;
      S[n] = lay ? lay.fs * this.scale : size;
      L[n] = lay;
      KINDS[n] = kind;
      HOT[n] = i === hover;
      C[n] = '';                    // 这条路上没有自定义颜色，清掉上帧残留
      n++;
    }
    this._paint(ctx, n, view);
    this.lastMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0;
  }

  /**
   * 直接画一组点（常规模式按颜色聚出来的那些色块）。
   * @param {Array<{name:string, x:number, y:number, area:number}>} points
   */
  /**
   * 直接画一组点。
   * @param {number} [need] 这一层的缩放门槛（百分比）。缩放不到就整层不画 ——
   *   必须等 _begin(view) 之后判，那之后 this.scale 才是这一帧的。
   */
  drawPoints(points, view, need = null) {
    const _t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!this.enabled) { this.resize(); this.clear(); return; }
    const ctx = this._begin(view);
    if (!points || !points.length) return;
    const pct = this.scale * 100;
    if (!this.showAll && need != null && pct < need) { this.clear(); return; }
    // 每个点按**它自己的层**过门槛：玩家色块名的点是第 0 层（国家那套），
    // 所以它跟国家名一起出现，不受当前视图层（地区 / 省份）门槛的影响。
    const zoom = this.zoom || [];
    const open = (p) => {
      const t = p.tier != null ? p.tier : 0;
      const n = zoom[t];
      return n == null || pct >= n;
    };

    const T = this._text;
    const X = this._x;
    const Y = this._y;
    const S = this._size;
    const HOT = this._hot;
    // 每个标签的"层"：地名 0 / 国名 1 / 玩家名 2。
    // **必须按层分开排** ✗ —— _paint 是按字号分桶画的，桶大的先画（在下面），
    // 所以国名只要字号比地名小，就会被画到地名底下（入列顺序管不了它）。
    const LY = this._layer || (this._layer = []);
    let n = 0;
    // 逐点的透明度（国名 0.6，其余 1）——必须在本函数里声明
    const F = this._fade || (this._fade = []);
    // 每个点自带的颜色（「国名取色」给的）——没有就落默认色
    const C = this._color || (this._color = []);
    // 这个标排好版了没 / 它是国名还是地名（见 `_maybeLayout` ✓）
    const L = this._layout || (this._layout = []);
    const KINDS = this._kind || (this._kind = []);
    // 跟 draw() 一样先按视口粗筛：不然上万个候选里视口内的那几个
    // 可能刚好排在 MAX_CANDIDATES 之外，整层就是空的（VIC3 4 万地块的坑）
    const padMap = Math.max(64, 900 / this.scale);
    const vx0 = view.x - padMap, vx1 = view.x + view.w + padMap;
    const vy0 = view.y - padMap, vy1 = view.y + view.h + padMap;
    for (const p of points) {
      if (n >= MAX_CANDIDATES) break;
      if (!p.name || !open(p)) continue;
      if (!(p.x >= vx0 && p.x <= vx1 && p.y >= vy0 && p.y <= vy1)) continue;
      T[n] = p.name;
      X[n] = p.x;
      Y[n] = p.y;
      /* ⚠ 第三个参数是**层**（0 地名 / 1 国名 / 2 玩家名 ✓）——
       *   字号分"地块 / 势力"两类就靠它 + tier（见 `_fontSize` 那段 ✓）
       *   别新造字段 ✗ 这个 `layer` 本来就是每个点自带的 ✓ */
      const size0 = this._fontSize(p.area, p.tier || 0, p.layer || 0);
      if (size0 <= 0) continue;
      /* 这个标是什么（字号那套早就在用同一个判据 ✓ 见 `_fontSize`）：
       *   tier < nEra = 剧本 / 年份那几层的**势力名** ✓
       *   layer === 2 = 玩家涂出来的色块名（也算势力名 ✓）
       *   其余 = 地块名 ✓ */
      const _nEra = this.nEra || 0;
      const kind = ((p.tier || 0) < _nEra || p.layer === 2) ? 'power' : 'place';
      /* P社式排版：**国名地名一律试** ✓（2026-10-23 起地名不再按字号设门槛 ✗）
       * 真排不出来（分块地图 / 名字塞不进 / 位图字体）→ `lay` 为 null →
       * 下面老老实实走老那套（含 p.w 限宽 ✓）
       * ⚠ **整份 `p` 传进去** ✗ 别只挑几个字段 —— 色块名的
       *   `singleTid` / `paintedAny` / `mtier` 就在里面（国名能不能套全靠它们 ✓）*/
      let lay = this._maybeLayout(p, kind, size0);
      /* 现在 `_maybeLayout` 只会给 对象 / null；留一手 undefined（以后要加预算法也接得住 ✓）*/
      if (lay === undefined) continue;
      /* **排出来就按排好的画** ✓（同 `draw()` 那段：别按屏幕字号切回横平竖直 ✓）
       *   名字不超出自己的版图（`p.w` 限宽）只在**没排出来**时才管 ——
       *   排出来的宽度是版图里量出来的，本来就塞得下 ✓ */
      let size = lay ? lay.fs * this.scale : size0;
      if (!lay && p.w > 0) {
        const need = String(p.name).length * size;        // 这些字大约要多宽（汉字方块 ≈ 字号）
        const room = p.w * this.scale * 0.92;             // 版图里能用的宽度
        if (need > room) {
          // **最多只缩到自然字号的 7 成** ✓ 别压得太死 ✗
          // 以前是 size × (room/need)，一句话也不留余地 —— 名字比版图宽三倍，
          // 字号就被砍成三分之一，砍到底还有 5px 的硬地板，结果就是蚂蚁字 ✓
          // 现在：宁可让长名字压出版图一点点（反正底下没有别的东西挡着），
          // 也不许它缩到看不清 ✓ 真要更狠更松，就调下面这个 0.7 ✓
          const SHRINK_FLOOR = 0.7;
          size = Math.max(size0 * SHRINK_FLOOR, size * (room / need));
        }
      }
      S[n] = size;
      HOT[n] = false;
      LY[n] = p.layer || 0;
      L[n] = lay;
      KINDS[n] = kind;
      /* **所有名字一律 50% 不透明** ✓（用户要求：地名和国名都要 ✓）
       *   半透的好处是底下的填色 / 边界还看得见 ✓
       * **两档可调**（用户定的：设置里 25 / 50 / 75 / 100 ✓）——
       * **分法是按"层"**（2026-10-16 用户定的 ✓）：
       *   · `tier < nEra`（剧本 / 年份那几层）= **势力名** → 「势力名称不透明度」✓
       *     **玩家涂出来的色块名也归这档** ✗（drawLabels 给它们 `tier: 0` ✓）
       *   · `tier >= nEra`（地区 / 省份 / 地点，"真正的"地名）= **地名** → 「地名不透明度」✓
       *   ⚠ 跟 drawLabels 里那条分层口径必须一致 ✗ 错一处就没法单独调 ✓
       *     （以前画面上叫"色块名"的那批一律压进地名档 ✗ →
       *      剧本层的国名全跟着「地名不透明度」走，「势力名称」那根滑条怎么拖都没反应 ✓）
       *   ⚠ 这里只有 **this.nEra** ✗（那个自由变量 nEra 在模块顶上，类里取不到 ✓）*/
      const _aC = this.alphaCountry == null ? 0.5 : this.alphaCountry;
      const _aP = this.alphaPlace == null ? 0.5 : this.alphaPlace;
      F[n] = (_nEra > 0 && (p.tier || 0) < _nEra) ? _aC : _aP;
      C[n] = p.color || '';   // 「国名取色」：带着自己那族的颜色画
      n++;
    }
    this._paint(ctx, n, view);
    this.lastMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0;
  }

  /**
   * **整图导出时把名字画上去**（2026-10-23 用户要的）
   *
   * 整图导出是分块渲染再拼起来的，标签层根本没参与 ✓ 以前导出来的大图没有字 ✗
   * 这里按**导出尺寸**重画一遍：排版结果都在地图像素里（跟缩放无关 ✓），
   * 所以只要把每个字的坐标 × 导出倍率就能画 ✓ 不用重排 ✓
   *
   * 哪些名字上：**完全听显示区那几个开关**（`drawLabels` 已经按开关筛过一轮 ✓）
   * 不需要另加"导出带不带名字"的开关 ✓（用户定的 ✓）
   *
   * @param {CanvasRenderingContext2D} ctx 输出画布的 2D context
   * @param {Array} points `drawLabels(view, true)` 抓到的那份名单
   * @param {number} scale 导出倍率（输出像素 / 地图像素）
   * @param {number} gateScale 决定"这一层名字出不出来"的缩放比（= 整图视角的倍率 ✓）
   * @param {{x:number,y:number,w:number,h:number}} [rect] 只画这块地图区域（缺省 = 整张）
   * @returns {number} 画了几个名字
   */
  paintExport(ctx, points, scale, gateScale, rect) {
    if (!points || !points.length || !(scale > 0)) return 0;
    const ox = rect && Number.isFinite(rect.x) ? rect.x : 0;
    const oy = rect && Number.isFinite(rect.y) ? rect.y : 0;
    const rw = rect && Number.isFinite(rect.w) ? Math.max(0, rect.w) : Infinity;
    const rh = rect && Number.isFinite(rect.h) ? Math.max(0, rect.h) : Infinity;
    if (rect && !(rw > 0 && rh > 0)) return 0;
    const oldScale = this.scale;
    /* 借 this.scale 给 `_fitGrow` / `_fontSize` 用（画完立刻还回去 ✓）*/
    this.scale = scale;
    const nEra = this.nEra || 0;
    const zoom = this.zoom || [];
    const hasLayout = this.mapNameMode !== 'off' && this.realmMask && this.realmMask.usable;
    /* 整张导出时这里会跑几千上万个地名：
       · 原点换算提成一个函数，别每个名字都新建一个闭包 ✓
       · 对齐 / 基线 / 圆角只设一次，每个名字只改 alpha ✓
       · 不再每个名字 save/restore 一次状态栈 ✓
       （下面 finally 统一把 alpha / 对齐 / 变换恢复干净 ✓） */
    const origin = (g) => ({
      x: (g.x - ox) * scale,
      y: (g.y - oy) * scale,
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    let drawn = 0;
    try {
      for (const p of points) {
        if (!p || !p.name) continue;
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        /* 框选导出：只画落在区域里的名字 ✓ 坐标再平移到输出画布左上角 ✓ */
        if (p.x < ox || p.x > ox + rw || p.y < oy || p.y > oy + rh) continue;
        const t = p.tier != null ? (p.tier | 0) : 0;
        /* 层的门槛按"整图视角"判（跟屏幕上那套一致 ✓ 只是倍率换成整图 ✓）*/
        const need = zoom[t];
        if (need != null && gateScale * 100 < need) continue;
        const isPower = (p.tier || 0) < nEra || p.layer === 2;
        const kind = isPower ? 'power' : 'place';
        const alpha = isPower
          ? (this.alphaCountry == null ? 0.5 : this.alphaCountry)
          : (this.alphaPlace == null ? 0.5 : this.alphaPlace);
        const lay = hasLayout ? this._maybeLayout(p, kind, 0) : null;
        ctx.globalAlpha = alpha;
        if (lay) {
          /* 逐字画：**跟屏幕同一个出口** ✓（2026-10-23 体检去重）
           * 只有坐标变换不一样：导出是"地图坐标 × 倍率"，没有视口偏移 ✓ */
          /* 门槛统一按**最终输出字号**算：15px 就是 15px，不随倍率变成 45px ✓
           *   （2026-10-27 用户："都按 15px 来"）
           *   高倍下字更大、再用实时矢量绘制，清晰度靠渲染质量，不靠抬门槛 ✓ */
          const size = exportFontPx(quantizeFont(lay.fs * scale * this._fitGrow(lay)));
          if (!size) continue;
          this._drawGlyphRun({
            ctx, lay, size, kind, color: p.color || LABEL_FG, dpr: 1, origin,
            exportText: scale > 1,
          });
        } else {
          /* 排不出来 / 关掉了贴合 → 老画法：横着写在锚点上 ✓
           * 🔴 **字体要跟屏幕上同一套** ✗✗（2026-10-23 用户："导出的字体为什么都是默认"）
           *   屏幕上这里是两条路：挂了**位图字体**就 `bf.draw`，否则才 `fillText` +
           *   当前字体栈 ✓ 导出这一版只写了后者 → 用了位图字体的图，导出就退回默认字体 ✗
           *   → 照抄屏幕那条判据 ✓ 位图字体直接用 ✓ */
          /* 老画法也一样：按最终输出字号过 15px 门槛 ✓ */
          const size = exportFontPx(this._fontSize(p.area, p.tier || 0, p.layer || 0) * scale);
          if (!size) continue;
          const bf = BITMAP[kind];
          const color = p.color || LABEL_FG;
          if (bf) {
            bf.draw(ctx, p.name, (p.x - ox) * scale, (p.y - oy) * scale, size, color,
              { outline: Math.max(1, size * 0.09), stroke: LABEL_STROKE });
          } else {
            ctx.font = fontFor(size, kind);
            ctx.lineWidth = Math.max(1.3, size * 0.14);
            ctx.strokeStyle = LABEL_STROKE;
            ctx.fillStyle = color;
            ctx.strokeText(p.name, (p.x - ox) * scale, (p.y - oy) * scale);
            ctx.fillText(p.name, (p.x - ox) * scale, (p.y - oy) * scale);
          }
        }
        drawn++;
      }
    } finally {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      this.scale = oldScale;      // 一定要还回去 ✓ 不然屏幕上的字号全变 ✗
    }
    return drawn;
  }
}
