/**
 * 地名标注层。
 *
 * 单独一层 Canvas2D，盖在 WebGL 地图上面。两种画法：
 *
 *   draw()       常规：标当前层级的所有头衔，位置由各层的规则决定（见 build_*.py），
 *                缩放百分比达到该层的门槛才标。
 *
 *   drawPoints() 常规模式下（头衔关、手绘开）用：只画传进来的那几个点。
 *                点由调用方按**颜色**聚出来 —— 见 app.js 的 paintedPoints()。
 *                玩家常常吸某个头衔的色去铺别处，此时该显示的是"这个颜色原本属于谁"，
 *                而非地块本身属于谁。
 *
 * 裁剪按**文字包围盒**算：只要还有一部分落在视口里就画。
 *
 * ---------------------------------------------------------------- 绘制开销与对策
 *
 * 每帧要画几百个地名（平移时相机一直在动，每帧都重画），开销按大小排：
 *
 * 1. **strokeText / fillText 现场栅格化汉字** —— 最贵的一步，带描边时等于画两遍。
 *    对策是**字形贴图缓存**：同一段文字 + 同一个字号 + 同一个颜色只画一次到离屏
 *    canvas，之后每帧只 drawImage。平移时缩放不变，命中率接近 100%。
 *    贴图按 devicePixelRatio 渲染，高分屏上不糊。
 *
 * 2. **ctx.font 每改一次都要重新解析 CSS 字体简写、重新选字体** —— 第二贵。
 *    字号随缩放连续变化，几乎每个标签都不同，于是每个标签都要改一次。
 *    对策是把字号吸附到一条 6% 的**几何阶梯**上（quantizeFont）。同一级共用一次
 *    font，肉眼看不出差别。字号分桶之后按桶从大到小画，保证大的在下面。
 *
 * 3. **measureText** 每帧每个标签量一次宽度。
 *    量宽缓存按**量化后**的字号做 key，命中率接近 100%。
 *
 * 另有一处易忽略的开销：`canvas.clientWidth` 不能在标签循环里读 —— 读它会逼浏览器
 * 同步重排，几百次就是一场灾难。一帧只读一次，存在 this.cssW / this.cssH 里。
 *
 * 每帧的临时数组（文本、坐标、字号）都挂在实例上复用，稳态下不产生垃圾。
 */

import { RealmMaskSource, layoutMapName, mapNameParams } from './maplabels.js';

/* **P社式排版**
 *   原理见 `桌面/P社国名地图排版原理与实现.md`：在版图里找基线，逐字贴着曲线摆。
 *   具体算法在 `maplabels.js`，这边只负责：
 *     · 把省份图 / 归属表喂给排版器（`setRealmMask`）
 *     · 按"这个标是国名还是地名"决定套不套（`mapNameMode`）
 *     · 把排好的"每个字的位置 + 角度"画出来（字形贴图逐字旋转）
 *   排版结果**跟缩放无关**，按（层 / 头衔 / 文字 / 字体 / 字号倍率）缓存：
 *   相机平移、放大缩小都不重算，只有换层 / 改名 / 换字体 / 调字号才失效。
 */
const MAPNAME_REF = 100;          //: 量字用的参考字号（排版按比例缩放）
/* **地名一律贴合版图，不按字号设门槛**
 *   按屏幕字号决定是否排版，会让画法随缩放变化：某层刚出现时小地块全横着写，
 *   放大一点才变贴合。
 *   一律排版后，结果按（层 / 头衔 / 文字 / 字体 / 字号倍率）缓存，与缩放无关 ——
 *   一层的名字只付一次排版成本，之后放大缩小、拖动都命中缓存。
 *   （实测单次约 0.5ms；一屏地名最多几百个，只在那一层第一次出现时算一轮。）
 *   注意：分帧限排（每帧排几个、剩下的下一帧补）会拖成一帧只冒出二十来个，
 *   观感像卡顿，因此一次算完。 */


//: 排版缓存最多存多少条（开局整层预热要装得下，一条几十字节）
const LAYOUT_CACHE_MAX = 60000;

//: 各层级从多少缩放百分比开始显示 —— 仅作**兜底**：
//: 实际门槛由 `computeLabelZoom()` 按**这张图自己的地块大小**算出来，
//: 不写死一套数（同一张图的半尺寸版本和原尺寸版本相差 2 倍，
//: 门槛相同会让半尺寸那张的地名提前一倍变糊）。
const MIN_ZOOM_PERCENT = [8, 30, 60, 120, 250];

//: 细层的口径：门槛那一刻，这一层**中位地块**在屏幕上要多宽（CSS px）。
//: 20px 是"不晚于写死门槛"的临界值；各图细层据此得到的门槛：
//: CK3 男爵领 63、EU4 省份 88、HOI4 省份 158、V3 省份 132、EU5 地点 129
//: （原尺寸 65）。CK3 这类上万块细层的图名字会碎，可调大到 25 / 35 / 45。
export const ARRIVE_SPAN = 20;
//: 国名层（年份层；CK3 是最粗那层）**不设缩放门槛**，任何缩放下都显示。
//: 若按"整张图缩进 1600px 视口"折算，门槛约为 20%，缩到 19% 时整层就消失了。
//: 字号另有一道可读性门槛（见 `_fontSize`）：缩得极小时只有大国名够大，
//: 这是"不糊成一团"的底线，不是缩放门槛。
const ZOOM_MIN = 4;
const ZOOM_MAX = 800;

/** 国名层数：有年份层就是年份层数；没有年份时最粗那层算国名 */
function countryTierCount(meta) {
  const nEra = (meta && meta.eraDates && meta.eraDates.length) || 0;
  return nEra > 0 ? nEra : 1;
}

/** 把门槛表里的国名层**全部置 0**（0 = 不设缩放门槛，不是"永不显示"） */
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
 *     地块小的图（V3 的省份 15px、HOI4 的省份 12.6px）门槛自然就高。
 *   · 国名层（`meta.eraDates` 那几层；没有年份时是最粗那层）：**= 0，不设缩放门槛**。
 *
 * 用 CK3 复算：帝国/王国/公爵领/伯爵领/男爵领 = 12/30/61/119/221%，
 * 与手调的 8/30/60/120/250% 基本一致 —— 两者是同一口径。
 *
 * @param {object} meta   meta.json 的内容（要 mapWidth / tiers / eraDates / 兜底 labelZoom）
 * @param {object} titles titles.json 的内容（要 tiers，以及**跟字号同一个来源**的面积：
 *                        `blockArea` 优先、退回 `area` —— EU5 的 `area` 是成员个数不是像素）
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
      z = 0;                                  // 国名：不设缩放门槛
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
    /* 注意：0 = 不设门槛，**不能**被 ZOOM_MIN 夹回去 ——
     * 统一写 `Math.max(ZOOM_MIN, …)` 会让国名层至少 4%。 */
    out[t] = z > 0 ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z))) : 0;
  }
  return out;
}

//: 字体栈。用系统自带的雅黑这一类黑体 —— 楷体系列（华文楷体等）在 Canvas 上
//: 逐字渲染中文明显更慢，标签一多就卡。
const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';

/* **导入字体：地名和势力名各用各的**
 *
 *   两槽：`place`（地块名 / 海湖河荒地）和 `power`（势力名 = 剧本年份那几层 + 涂出来的色块）。
 *   空串 = 用默认栈；有值 = 该族名排在最前面，后面照样接默认栈
 *   （导入的字体缺字时，浏览器会往后面的系统字体里找，不会变成豆腐块）。
 *
 *   缓存键必须带字体身份：换字体后若不区分，量宽缓存和字形贴图仍是旧字体那批，
 *   画面会新旧混着，像是没生效。因此 `fontFor` / `measureCached` / `SpriteCache`
 *   的键里都放进了族名。
 */
const FONT_FACE = { place: '', power: '' };

/* **位图字体**
 *   TTF 靠 `document.fonts` 注册，位图字体（EU4 汉化那种 .fnt + .dds）走不了那条路，
 *   只能逐字贴图。这里存两槽 BitmapFont 实例（null = 没选）。
 *   有值就**盖过** `FONT_FACE`（同一个下拉里选中的是位图字体）。
 *
 *   位图字体**没有矢量轮廓**，描边只能把同一个字偏移着多画几遍，
 *   因此贴图缓存对它更要紧（每段字只铸一次）。
 */
const BITMAP = { place: null, power: null };

/** 挂一套位图字体（传 null 取消）
 *  @param {'place'|'power'} kind
 *  @param {object|null} bf BitmapFont 实例
 */
export function setLabelBitmap(kind, bf) {
  _dropFontTag(kind);
  if (kind !== 'place' && kind !== 'power') return;
  BITMAP[kind] = bf || null;
}

/** 当前挂的位图字体（自测用） */
export function labelBitmap(kind) {
  return BITMAP[kind] || null;
}

/** 设置某一类的字体族名（传空串 = 回到默认）
 *  @param {'place'|'power'} kind
 *  @param {string} family
 */
export function setLabelFont(kind, family) {
  if (kind !== 'place' && kind !== 'power') return;
  FONT_FACE[kind] = String(family || '');
  _dropFontTag(kind);          // 键里的字体身份变了，缓存要跟着作废
}

/** 当前使用的字体族（给设置页回显 / 自测用） */
export function labelFont(kind) {
  return FONT_FACE[kind] || '';
}

/** 某一类拼出来的字体栈 */
function stackOf(kind) {
  const f = FONT_FACE[kind];
  return f ? `"${f}", ${FONT_STACK}` : FONT_STACK;
}

/**
 * **字体的身份标签** —— 所有缓存键都要带上它。
 *
 *  量宽 / 字形贴图 / fontFor 三处若只把 `kind`（place|power）编进键里，
 *  由于 `kind` 是**固定的**（一类就一个值），换字体后键不变，
 *  旧字体量出的宽度、旧字体栅格化的贴图会原封不动命中，画面上看不出任何变化。
 *
 *  键里带两样：
 *    · `FONT_FACE[kind]` —— 导入的 TTF 族名（空 = 默认栈）
 *    · `BITMAP[kind].uid` —— 位图字体实例号（两套位图字体也可能同名）
 */
const _FONT_TAG = { place: null, power: null };
/** 换字体 / 换位图字体时作废这份缓存（setLabelFont / setLabelBitmap 里清） */
function _dropFontTag(kind) {
  if (kind) { _FONT_TAG[kind] = null; return; }
  _FONT_TAG.place = null; _FONT_TAG.power = null;
}
function fontTag(kind) {
  const k = (kind === 'power') ? 'power' : 'place';
  /* 这份标签进每一个缓存键，每帧上千次调用，因此缓存起来：
   * 现拼字符串会每帧产生上千个小字符串，纯属 GC 压力。
   * 失效由 setLabelFont / setLabelBitmap 里的 `_dropFontTag` 负责。 */
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
//: 它对缩放是**线性**的：放大两倍，屏幕上的地盘大两倍，字也就大两倍。
//: 对数式写法（`8 + log2(side) * 2` 再夹到 [9, 26]）会让放大逐渐失效，
//: 加上限封顶后，地图越放越大而字不再增长，即"缩放失真"。
let FONT_RATIO = 0.18;

//: 下限：再小就看不清了。只有很小的地块会碰到它（碰到时不再线性，但总比
//: 一个两像素高的名字强）。**没有上限** —— 上限正是失真的来源。
const MIN_FONT = 10;

/** 设置页用：字号总倍率（1 = 默认 0.18） */
export function setFontScale(k) {
  const n = Number(k);
  if (Number.isFinite(n) && n >= 0.4 && n <= 3) FONT_RATIO = 0.18 * n;
}

/**
 * 各层的"显示门槛"：算出来比它小就整个不画。
 *
 * 只给**国名那层**留 2px 的可读底线。真正卡住国名的是这道字号线：
 * 取 4px 时大部分国名要缩到约 20% 才够大，取 2px 后 5% 的全图视角
 * 也能先浮出几个最大国的名字。再往下取 0 会变成几百个 1px 蚂蚁字糊满屏，不可读。
 * 地区 / 省份这些细层一律 **0 = 全显示**：
 * 它们各自有 meta.labelZoom 的缩放门（没到那个缩放整层都不出现），
 * 门一开就该把这一层全摆出来 —— 与 CK3 伯爵领一致。
 */
const TIER_MIN_FONT = [2, 0, 0, 0, 0];

/** 真正允许画出来的最小字号：字号阶梯从这里起步 */
const MIN_DRAW = 4;

/* 导出图里只收**大于 15px** 的名字：
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

//: 候选上限，纯保险。**跟 MAX_LABELS 不是一回事** ——
//: 若拿 MAX_LABELS 当候选上限，就只考虑面积最大的 4000 个：CK3 有 11295 个男爵领，
//: 放到最大、视口里明明有三十几个，也可能一个都进不了候选
//: （随机挑位置实测约 20% 出现），表现为"男爵领名字放多大都看不见"。
//: 这里只防病态数据，真正的限量在 _paint 里按**画出来的**数。
const MAX_CANDIDATES = 30000;

// ---------------------------------------------------------------- 字号阶梯

//: 相邻两级差 6%。吸附误差最多 ±3%，肉眼分不出来，但字号种类从"连续无限个"
//: 变成 ~90 个桶 —— font 变更次数、量宽缓存命中率全靠这个。
const SIZE_STEP = 1.06;
const SIZE_STEPS_MAX = 220;
const SIZE_LADDER = [MIN_DRAW];
const FONT_CACHE = new Map();

/*: 每个标一帧要调一次 `quantizeFont`，几百个标就是几百次 `Math.log`
 *  （剖面里它在 `_paint` 中占 6%），而字号实际取值只有几十档。
 *  按原值记一份结果；表满了整个清掉（比逐条淘汰便宜得多，很快又会热回来）。 */
const QUANT_MEMO = new Map();
const QUANT_MEMO_MAX = 8192;
const LOG_STEP = Math.log(SIZE_STEP);

function quantizeFont(size) {
  if (!(size > MIN_DRAW)) return MIN_DRAW;
  const hit = QUANT_MEMO.get(size);
  if (hit !== undefined) return hit;
  let k = Math.round(Math.log(size / MIN_DRAW) / LOG_STEP);   // 少算一次 log
  if (k < 0) k = 0;
  else if (k > SIZE_STEPS_MAX) k = SIZE_STEPS_MAX;
  let v = SIZE_LADDER[k];
  if (v === undefined) {
    v = MIN_DRAW * Math.pow(SIZE_STEP, k);
    SIZE_LADDER[k] = v;
  }
  if (QUANT_MEMO.size >= QUANT_MEMO_MAX) QUANT_MEMO.clear();
  QUANT_MEMO.set(size, v);
  return v;
}

/** 拼 `ctx.font` 用的字符串
 *  缓存键要带 **kind** 与字体身份，两套字体各缓存各的 ——
 *  只按字号缓存的话，换字体之后拿到的是旧那套字符串。
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
  /* 位图字体：宽度 = 各字 xadvance 之和，不用 measureText，也没有东西可量。 */
  const bf = BITMAP[kind];
  if (bf) return bf.measure(text, size);
  /* 键里要带**字体** —— 否则换了字体还命中旧宽度，
   * 名字会按错的宽度居中 / 判断放不放得下，看起来像"字体没生效"。 */
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
    /* 键里要带**字体**：贴图是栅格化好的像素，不区分的话换字体后屏幕上还是旧字形，
     * 看起来像"怎么换都没反应"。位图字体再额外带上实例 uid（两套也可能同名）。 */
    const fk = fontTag(kind);
    /* dpr 必须进键：屏幕上是 2x 贴图，导出是 1x；混用会把 2x 贴图缩着画，字就发糊。 */
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
      /* 位图字体：逐字贴；描边靠"偏移着多画几遍"（它没有矢量轮廓）。 */
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
// **P社式排版是逐字画的**（每个字位置 / 角度都不同）。
// `SpriteCache` 是"整段文字一张贴图"，整段一起转就没有曲线了，
// 因此另开一套：**一个字一张贴图**，缓存键里带单字。
//
//   汉字名字重复率高（"大""王""国"到处都是），命中率比整段贴图还高。
//   贴图里要留出**基线的位置**（`oy`）：画的时候把"基线中心"对到曲线上的点，
//   不是把整张图的中心对上去 —— 否则字会在曲线上下乱跳。

//: 逐字贴图的总预算（12 MB，比整段那套小 —— 它数量多）
const GLYPH_BUDGET = 12 * 1024 * 1024;

/** 量字用的公共 2D context（不画东西，只拿来 measureText） */
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

/** 取一段字的**字形度量**（都换算到 MAPNAME_REF 号字）
 *
 *  浏览器没有 `fontBoundingBoxAscent` 时退回 `actualBoundingBox*`，
 *  再退回"8 : 2 的近似"（测试桩只给 width 时也要能跑）。
 */
function glyphMetrics(text, kind) {
  const chars = Array.from(String(text));
  /* **位图字体也要有度量**
   *  位图字体没有 `measureText` 那套矢量框，但 BMFont 自带 lineHeight / base /
   *  每字 xadvance，用这些拼一份"参考字号下的度量"：参考字号 = lineHeight，
   *  adv = 各字 xadvance，ascent/descent 按 base 拆。 */
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
    /* **分组索引**
     *  把 `dpr|字号|颜色|字体|字` 五段拼成一条长串时，**每个字**都要两次 `toFixed`、
     *  五次拼接加一次长键 Map 查找；一帧几百个字形全花在这上面
     *  （剖面里 `get` 占一帧 self time 的 20%）。
     *  改按「dpr+字体」→「字号+颜色」→「字」三层存放：同一次绘制里前两层恒定
     *  （`_drawGlyphRun` 一个 run 一个字号一个颜色），快路只剩最深一层的短键查找。
     *  语义不变：同一组 (dpr, 字号, 颜色, 字体, 字) 仍拿到同一张贴图；
     *  `this.map` 仍用长键，容量统计与淘汰顺序照旧。 */
    this._idx = new Map();
    this._own = new Map();      // 贴图 → {g1,g1key,ik,inner,ch}（淘汰时顺着它清索引）
    this._cur = null;           // 最近用到的内层表（快路）
    /* 快路要比的四项 —— 存**原始值**（不是拼好的键） */
    this._gd = 0; this._gs = -1; this._gc = null; this._gk = null;
    /* 慢路顺手算好的字符串键，插入时要用来写 `this.map` */
    this._dk = ''; this._sizeKey = ''; this._ft = '';
    this._cg1 = null; this._cg1key = ''; this._cik = '';
  }

  /** 慢路：按 (字号, 颜色, dpr, 字体) 取到（没有就建）最深一层的表
   *  一次 `_drawGlyphRun` 只走这一遍 —— 之后的字全走快路 */
  _group(size, color, dpr, kind) {
    const dk = dpr.toFixed(2);
    const ft = fontTag(kind);
    const sizeKey = size.toFixed(1);
    const g1key = dk + '|' + ft;
    let g1 = this._idx.get(g1key);
    if (g1 === undefined) { g1 = new Map(); this._idx.set(g1key, g1); }
    const ik = sizeKey + '|' + color;
    let inner = g1.get(ik);
    if (inner === undefined) { inner = new Map(); g1.set(ik, inner); }
    this._cur = inner;
    this._gd = dpr; this._gs = size; this._gc = color; this._gk = kind;
    this._cg1 = g1; this._cg1key = g1key; this._cik = ik;
    this._dk = dk; this._sizeKey = sizeKey; this._ft = ft;
    return inner;
  }

  /** 取一个字的贴图（锚点写在 `ox` / `oy` 里）
   * @returns {{c:object,w:number,h:number,ox:number,oy:number,px:number}|null}
   */
  get(ch, size, color, dpr, kind) {
    /* 同 `SpriteCache`：屏幕贴图 / 导出贴图的 dpr 不同，不能共用一张 */
    const sz = (size === size) ? size : -1;      // NaN 别进 memo（它跟谁都不相等）
    const dv = Number(dpr) > 0 ? Number(dpr) : 1;
    /* 快路比的是**原始值**（数字 / 字符串引用），不是拼出来的键：
     * 一个 run 里 (字号, 颜色, dpr, 字体) 恒定，快路一次 `toFixed` 都不用算。
     * （实测只省拼串而留着 `toFixed`，只有 1.24× 提升。） */
    let inner = this._cur;
    if (inner === null || this._gd !== dv || this._gs !== sz
        || this._gc !== color || this._gk !== kind) {
      inner = this._group(sz, color, dv, kind);   // 慢路：算键、取/建三层
    }
    const hit = inner.get(ch);
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
      const old = this.map.get(oldest);
      this.pixels -= old.px;
      this.map.delete(oldest);
      /* 索引里那条也得跟着删，否则被淘汰的贴图还挂在索引上：
       * 预算白算，下次还会拿到一张本该回收的。 */
      const own = this._own.get(old);
      if (own) {
        this._own.delete(old);
        own.inner.delete(own.ch);
        if (own.inner.size === 0) {
          own.g1.delete(own.ik);
          if (own.g1.size === 0) this._idx.delete(own.g1key);
          if (this._cur === own.inner) this._cur = null;   // 快路作废，下次重建
        }
      }
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

    /* 锚点放**贴图正中心**，不是"基线"：
     * 文档 §3.6 的四边形是"中心在基线上、上下各 h/2"，所以字是**骑在曲线上的**，
     * 不是坐在曲线上。用基线锚点的话，字会整体偏高约 0.4em，贴图顶部容易顶出版图。
     * 高宽用**这个字号下的整行框**：fontBoundingBox 是字体级的，'a' 和 'g'
     * 不会各算各的，拉丁文的基线才对得齐。 */
    const sprite = { c, w, h, ox: w / 2, oy: h / 2, px };
    /* 两份都记：`map` 用长键（容量统计 / 淘汰顺序照旧），`_idx` 供下次快查。 */
    this.map.set(this._dk + '|' + this._sizeKey + '|' + color + '|' + this._ft + '|' + ch, sprite);
    inner.set(ch, sprite);
    this._own.set(sprite, { g1: this._cg1, g1key: this._cg1key, ik: this._cik, inner, ch });
    this.pixels += px;
    return sprite;
  }

  clear() {
    this.map.clear();
    this._idx.clear();
    this._own.clear();
    this._cur = null;          // 快路指向的表已经不在索引里，必须一起作废
    this._gd = 0; this._gs = -1; this._gc = null; this._gk = null;
    this.pixels = 0;
  }
}

// ---------------------------------------------------------------- 导出避让

/* **导出避让**
 * 屏幕那条路只画视口里那几十个标；导出是**整张图一次画完**，当前层的所有名字
 * 一起落纸 —— 巨型贴合名（大洋 / 大洲，`lay.fs` 能到 1140px）的**字**正好压在
 * 小名（岛屿 / 湖泊，15~50px）的**字**上。实测（EU4 原版 5632×2048、tier 13、
 * 1× 导出）画出的 77 个名字里有 11 对字级相交。
 * （`_fitGrow` 与此无关：grow>1 只在 `lay.fs*scale < 4` 时发生，那时最终字号 ≤ 4px，
 *   必被 `exportFontPx` 的 15px 门槛丢掉，那种标一个字都画不出来。）
 *
 * 做法：**逐字的包围盒 + 贪心占位**
 *   · 一条名字的"占地"不能用整条 AABB —— 贴合名是**弯的**（大洋沿着海盆走），
 *     整条 AABB 会把半个海都圈进去，跟谁都算撞，白白丢掉一大堆好名字。
 *   · 按 `lay.glyphs` 逐字算：宽 = `adv × size/fs`、高 = `size`、按 `g.angle` 转，
 *     取**外接矩形**（`|hw·cos| + |hh·sin|`，不用造四个角）——
 *     旋转 / 竖排 / 曲线几种情形都覆盖在内。
 *   · 占位顺序：**势力名 / 涂色块名**（国名）最先，然后**字号大的先画**
 *     （与屏幕上"势力名压在最上面"、"面积大的先画"同一口径；`fs` 本来就 ∝ √面积）。
 *     大名字是整张图的骨架，小名字是细节；被大名字压住的小名字本来就**读不出来**，
 *     丢它比丢大名字划算。
 *   · 撞上的**后画者整条跳过**（不缩字、不挪位，字号口径固定）。
 *
 * 只在 `paintExport` 里使用；屏幕那条路不动（那边有视口裁剪、缩放门槛和帧预算，
 * 导出是"一次画完、不看帧"的另一套）。
 */

/** 名字外面的**描边**也算占地
 *  `_drawGlyphRun` 的描边 `lineWidth = max(1.3, size*0.14)`（`live` 那支）→
 *  外半宽 0.07em；这里取 0.08em 再留一点余量，两个名字的描边就不会贴在一起。
 *  取 0 也能"不相交"，但那只是**字面**上不相交，描边仍会挨上，而最终看图看到的是描边。
 */
const EXPORT_INK_PAD = 0.08;

/** 一条贴合名在**输出坐标**里逐字的 AABB（转过的字取外接矩形）
 *  @param {object} lay `_maybeLayout` 的排版结果
 *  @param {number} size 最终字号（已量化、已过 15px 门槛）
 *  @param {(g:object)=>{x:number,y:number}} origin 字心 → 输出坐标
 *  @returns {Array<{x0:number,y0:number,x1:number,y1:number}>} 没有任何可见字时是空数组
 */
function exportGlyphBoxes(lay, size, origin) {
  const out = [];
  const gl = (lay && lay.glyphs) || null;
  if (!gl || !gl.length || !(size > 0)) return out;
  const k = size / (lay.fs > 0 ? lay.fs : size);
  const pad = Math.max(1, size * EXPORT_INK_PAD);
  for (let i = 0; i < gl.length; i++) {
    const g = gl[i];
    const ch = g && g.ch;
    if (!ch || ch === ' ' || ch === '\u00a0') continue;
    const q = origin(g);
    if (!q) continue;
    const hw = Math.max(1, (g.adv > 0 ? g.adv : lay.fs * 0.5) * k) * 0.5;
    const hh = size * 0.5;
    /* 角度三角值：`_drawGlyphRun` 会算好挂在字上；没有就现算（导出只跑一趟）。 */
    const ca = g.cosa !== undefined ? g.cosa : (g.cosa = Math.cos(g.angle || 0));
    const sa = g.sina !== undefined ? g.sina : (g.sina = Math.sin(g.angle || 0));
    const ex = Math.abs(hw * ca) + Math.abs(hh * sa) + pad;
    const ey = Math.abs(hw * sa) + Math.abs(hh * ca) + pad;
    out.push({ x0: q.x - ex, y0: q.y - ey, x1: q.x + ex, y1: q.y + ey });
  }
  return out;
}

/**
 * 导出避让用的**稀疏网格**：已被占的字框记进来，新来的一问就知道撞不撞。
 *
 * 每次导出 new 一个 —— 不缓存、不挂在实例上，导出结束就扔。
 * 键用 `"cx,cy"` 拼串：导出**只跑一次**（不是每帧），图的是可读性，不是省那点拼串。
 * 屏幕那条路的无串键写法见 `GlyphCache`，那边的要求不适用于这里。
 * 格子边长只影响"多查几个框"，不影响结果 —— 命中还要再过一次精确相交。
 */
class PackGrid {
  constructor(cell) {
    this.cell = cell > 0 ? cell : 128;
    this.map = new Map();
    this.boxes = [];        // 摊平的字框：格子桶里存的是这里的下标
  }
  /** 这个字框跟已收下的有没有真相交（贴着边不算，差 1px 也不许）*/
  hits(b) {
    const c = this.cell;
    const x0 = Math.floor(b.x0 / c), x1 = Math.floor(b.x1 / c);
    const y0 = Math.floor(b.y0 / c), y1 = Math.floor(b.y1 / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.map.get(cx + ',' + cy);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const o = this.boxes[bucket[i]];
          if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) return true;
        }
      }
    }
    return false;
  }
  /** 收下这个字框（占住它盖到的每一格）*/
  add(b) {
    const id = this.boxes.push(b) - 1;
    const c = this.cell;
    const x0 = Math.floor(b.x0 / c), x1 = Math.floor(b.x1 / c);
    const y0 = Math.floor(b.y0 / c), y1 = Math.floor(b.y1 / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cx + ',' + cy;
        let bucket = this.map.get(key);
        if (!bucket) { bucket = []; this.map.set(key, bucket); }
        bucket.push(id);
      }
    }
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
    /* **名字层的帧预算**
     *  交互中只画 frameBudgetMs 毫秒；手一停（app 那边 250ms 定时器）
     *  预算恢复成 Infinity 并补画一帧。
     *  不用"自适应上限"：那种做法在变慢时永久少画一些，缩放停下后名字回不来，
     *  必须动一下鼠标触发重画才补齐。 */
    this.frameBudgetMs = Infinity;
    this._truncated = false;
    this.zoom = (meta && meta.labelZoom) || MIN_ZOOM_PERCENT;
    /* 国名层不设缩放门槛。`computeLabelZoom()` 已给出 0，这里再兜一道：
     * 外部传入的 labelZoom（旧格式）里国名层还可能是 20。
     * 0 = 不设门槛，不是"永不显示"（`draw` / `paintExport` 判 `need == null` 才跳过）。 */
    {
      const _nCountry = countryTierCount(meta);
      for (let t = 0; t < _nCountry && t < this.zoom.length; t++) this.zoom[t] = 0;
    }
    this.sprites = new SpriteCache();
    this.glyphs = new GlyphCache();

    /* ---- P社式排版（见文件头那段）----
     * `mode`: off = 横着写 / power = 只排国名 / both = 国名 + 大地名
     * `source`: app.js 开图之后传进来的 `RealmMaskSource`（null = 这张图不支持）
     * `cache`: 排版结果（地图坐标，跟缩放无关）
     * `metrics`: 字形度量（一段文字量一次）
     */
    this.mapNameMode = 'both';
    this.mapNameParams = mapNameParams();
    this.debug = false;             // 排版调试：画基线 / 字框 / 包围盒 / 质心
    /* 也可以直接开：`pdx-map-editor.html#mapdebug`（不用进设置翻）*/
    this.debugHash = (typeof location !== 'undefined' && location.hash)
      ? /mapdebug/.test(String(location.hash)) : false;
    this.debug = this.debugHash;
    this.realmMask = null;
    this.realmPos = null;          // 各省质心（涂色块估包围盒用）
    this._layoutCache = new Map();
    this._metricsCache = new Map();
    this._layoutHits = 0;
    this._layoutMiss = 0;
    /* 排版缓存的"代"（见 `_maybeLayout` 里点对象上的记忆）——
     * `clearLayouts()` 每调一次 +1，点对象上记着的旧排版就全作废。
     * 必须用整数比较，不能拿 `_layoutCache.size` 当判据（LRU 会淘汰，size 不代表内容）。 */
    this._layGen = 0;
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
    this._layout = [];  // 这个标排好版了没（有就逐字画，没有走横排那套）
    this._kind = [];    // 'power' | 'place' —— 字号/字体两条路的分类（跟 _fontSize 同一个口径）
    this._buckets = new Map();
    this._bucketKeys = [];
    /* **逐字绘制的壳子跨标复用**
     *  每个标新建 origin 闭包 + options 对象 + cull 对象时，
     *  一帧五百多个标就是 1500 多个短命对象，剖面里 GC 占 2.6%~6.9%。
     *  这里一份壳子改字段，origin 的返回值也复用（否则一个字一个 `{x,y}`，
     *  一帧 1600 多个；`_drawGlyphRun` 拿到就立刻用掉、不留引用）。 */
    this._gPt = { x: 0, y: 0 };
    this._gOrg = { bx: 0, by: 0, vx: 0, vy: 0, s: 1, grow: 1, flat: true };
    this._gRun = { ctx: null, lay: null, size: 0, color: '', kind: '', dpr: 1,
                   cull: { w: 1, h: 1 }, origin: null };
    {
      const self = this;
      this._gRun.origin = (g) => {
        const o = self._gOrg, r = self._gPt;
        if (o.flat) {
          r.x = (g.x - o.vx) * o.s;
          r.y = (g.y - o.vy) * o.s;
        } else {
          r.x = (o.bx - o.vx) * o.s + (g.x - o.bx) * o.s * o.grow;
          r.y = (o.by - o.vy) * o.s + (g.y - o.by) * o.s * o.grow;
        }
        return r;
      };
    }
    /* 每层一份「点对象」——**跨帧复用**（`draw()` 用，见那里的注释）。
     * 只缓存对象壳子，字段每帧原地刷新，所以换图 / 改名 / 换层都不会串味。 */
    this._ptCache = [];

    const area = titles.area || titles.provCount.map((n) => n * 3300);
    this.area = area;
    // 字号看的是**名字实际待着的那块地**有多大：像 1618 年的西班牙横跨大西洋，
    // 拿全部地盘算字号会撑得离谱，而名字其实是写在伊比利亚那一块上的。
    this.sizeArea = titles.blockArea || area;

    // 层级数按数据来：CK3/EU4/HOI4 是 5 层，维多利亚3 是 4 层
    const nTier = (meta && meta.tiers && meta.tiers.length) || 5;
    // hideLabel: 只隐藏地名的节点（比如含岛屿的大西洋），照旧可涂
    const hideLabel = titles.hideLabel;
    // 有几个"国家层"：EU4 三个年份层、HOI4 两个剧本、V3 一个；
    // CK3/EU5 没有剧本层 → 退化成 1（只有最粗那层吃门槛）。
    // **CK3 的帝国/王国/公爵领是封建头衔，不是国家**，EU5 也没有归属层
    // —— 这两个模式给 0，界面上那个「国名」开关会直接藏掉。
    this.nEra = (meta && meta.eraDates && meta.eraDates.length) || 0;
    this.byTier = Array.from({ length: nTier }, () => []);
    const { lx, ly } = titles;
    for (let i = 0; i < area.length; i++) {
      if (lx[i] == null || ly[i] == null || !area[i]) continue;
      const t = titles.tiers[i];
      if (t < 0 || t >= this.byTier.length) continue;
      if (hideLabel && hideLabel[i]) continue;   // 只隐藏地名（照旧可涂）：海/湖/河/山这类伪头衔不上地名
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
      this.sprites.clear();           // 画布重建后，按尺寸缓存的贴图作废
      this.glyphs.clear();            // 逐字那套同理
    }
  }

  /* ================================================================ P社式排版接口 */

  /**
   * 把"版图从哪来"接进来（app.js 开图之后调一次）
   *
   * @param {object|null} o `{provinceIds,width,height,titleAt,noTitle,cell}`
   *   传 null = 这张图不支持（分块地图 / 数据没齐）→ 全部退回横排画法
   */
  setRealmMask(o) {
    this.realmMask = (o && o.provinceIds && o.provinceIds.length > 1
      && o.titleAt) ? new RealmMaskSource(o) : null;
    this.realmPos = (o && o.provPos) || null;
    /* 色块的"每省属于哪一块"—— 全图共用一张块号栅格。
     * 涂色一变 `blockVer` 就变，版本变了会重建，不用整份清缓存。 */
    this.blockOf = (o && o.blockOf) || null;
    this.blockVerFn = (o && o.blockVer) || null;
    this._blockMask = null;
    this._blockMaskVer = -1;
    this.clearLayouts();
  }

  /** 块号栅格：没有就现建；`blockVer` 变了就重建（涂色之后） */
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

  /** 排版模式：off / power / both（设置页的下拉；每帧现读也行，这里存一份） */
  setMapNameMode(mode) {
    const m = (mode === 'off' || mode === 'power' || mode === 'both') ? mode : 'both';
    if (m !== this.mapNameMode) {
      this.mapNameMode = m;
      this.clearLayouts();
    }
  }

  /** 排版参数（设置页 / 自测改参数之后调一下） */
  setMapNameParams(over) {
    this.mapNameParams = mapNameParams(over);
    this.clearLayouts();
  }

  /** 排版缓存作废（换层 / 换图 / 改名 / 换字体 / 调字号都要） */
  clearLayouts() {
    this._layoutCache.clear();
    this._metricsCache.clear();
    this._layoutHits = 0;
    this._layoutMiss = 0;
    this._layGen = (this._layGen | 0) + 1;   // 点对象上那份记忆跟着作废
  }

  /** 字号总倍率 —— 跟 `_fontSize` 同一个口径（势力名那块 / 地块名那块） */
  _userScale(tier = 0, layer = 0) {
    const _w = (typeof window !== 'undefined') ? window : null;
    const legacy = (_w && _w.__CK3_FONT_SCALE) || 1;
    const isPower = (tier < (this.nEra || 1)) || (layer === 2);
    return isPower ? ((_w && _w.__CK3_FONT_POWER) || legacy)
                   : ((_w && _w.__CK3_FONT_PLACE) || legacy);
  }

  /** 一段字的度量（带缓存，键里带字体） */
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
   * 给一个标排版（没有就现排 + 缓存）
   *
   * @param {object} p 标（`{name,x,y,area,tier,layer,tid}`）
   * @param {'power'|'place'} kind
   * @param {number} size0 按面积算出的屏幕字号（只为兼容调用点，不参与门槛判断）
   * @returns {object|null|undefined} 排好的 {fs,glyphs,bbox,...} /
   *   null = 这块地排不出来（走横排画法）
   */
  _maybeLayout(p, kind, size0) {
    if (!p) return null;
    if (this.mapNameMode === 'off' || !this.realmMask || !this.realmMask.usable) return null;
    if (kind === 'place' && this.mapNameMode !== 'both') return null;
    /* **色块名（layer 2）也能套**
     * 年份视图里的国名走的就是这条路（`paintedPoints` 按色块聚出来的）。
     *
     * **色块的版图 = 那一组省，永远不看头衔**：
     * 画面上看到的这一国 = 同颜色 + 同名字的那一组省；头衔的完整范围跟画面上不一样
     * （被占走的省显示成别人的颜色），拿头衔当版图，名字就会写到别的国家的色块上。
     * 所以只要这一块带着省号集合，就用它当版图，涂没涂一视同仁 ——
     * 这样"同样颜色范围"的两块几何完全一样，名字也一样。 */
    /* **位图字体也能贴合**
     *  `glyphMetrics` 会给位图字体拼一份度量（lineHeight / base / xadvance），
     *  绘制端再用 `bf.drawGlyph` 逐字旋转贴，见 `_paintGlyphs` / `paintExport`。 */
    const tid = p.tid;
    const name = String(p.name || '');
    if (!name) return null;
    /* 用**哪一层**的版图查：色块名带 `mtier`（它自己那一层）；
     * 普通头衔点就是 `p.tier`。不能拿 `p.tier` 代替色块名 —— 它被写死成 0
     * （字号/不透明度的分类口径），不是归属层。 */
    const tier = (p.mtier != null) ? (p.mtier | 0) : (p.tier || 0);
    const us = this._userScale(p.tier || 0, p.layer || 0);

    /* ---- 选版图 ---- */
    let mask = this.realmMask;
    let maskTag = 'r';
    const needPidMask = p.layer === 2 && p.gid != null && p.gid >= 0 && !!this.blockOf;
    if (needPidMask) {
      /* **一张全图级的块号栅格**
       * 若每块色块现搭一张小栅格再缓存，一屏几十上百个色块等于每帧重搭一遍。
       * app 直接给出"每个省属于哪一块"（`blockOf`），跟头衔栅格同一个做法：
       * 全图只建一张，所有色块共用；块号一变（涂色）版本号变，重建一次。 */
      const bm = this._ensureBlockMask();
      if (!bm || !bm.usable) return null;
      mask = bm;
      maskTag = 'b' + this._blockMaskVer;
    }
    if (!mask || !mask.usable) return null;
    if (maskTag === 'r' && (tid == null || tid < 0)) return null;

    /* 缓存键：**锚点按 1px 量化**（同一个头衔的本土 + 殖民地各有一个标，
     * 它们要各排各的；每帧质心有亚像素抖动，不量化就一帧都命中不了。
     * 量化得太粗（32px）会让挨得近的两块殖民地共用一条缓存，
     * 第二个标跑到第一个标的位置上；1px 够区分、又稳。） */
    const gidKey = needPidMask ? (p.gid != null ? p.gid : -1) : -1;
    /* **键在点对象上缓存一份**
     * 每帧每个标拼一次长键要六七个字符串拼接，一屏上千个就是上千个小字符串。
     * 相机平移 / 缩放**不改变**构成键的各项（锚点在地图坐标里是定死的），
     * 因此把上次的键记在点对象上，逐项比一遍（数字 + 字符串引用比较，很便宜），
     * 任何一项变了（换层 / 涂色 / 换字体 / 改名）才重拼。 */
    const mver = needPidMask ? (this._blockMaskVer | 0) : -1;
    const idPart = needPidMask ? gidKey : (tid == null ? -1 : tid);
    const ft = fontTag(kind);
    const rx = Math.round(p.x), ry = Math.round(p.y);
    const lk = p._lk;
    let key;
    if (lk && lk.mver === mver && lk.tier === tier && lk.id === idPart
        && lk.rx === rx && lk.ry === ry && lk.us === us && lk.ft === ft && lk.name === name) {
      key = lk.key;
      /* **排好的对象也记在点对象上**
       * 只记"键"时，键没变仍要拿**长串键**去 Map 里查一次。一帧 2950 个候选
       * （真画出来的才 524 个）就是 2950 次长串哈希 + 查表，占整帧自时间的第一名
       * （18.4%），而这些键在缩放 / 平移时**一个都没变**。
       * 命中过一次就把 `lay` 一起记在 `lk` 上，下次键没变直接返回，零查表。
       * 必须跟"代"比（`_layGen`：换字体 / 调字号 / 换图 / 改排版模式时
       * `clearLayouts()` 会 +1），否则旧排版会一直用下去。
       * 计数照旧 +1（`_layoutHits` 是"查表命中"的口径，自测在盯它）。 */
      if (lk.gen === this._layGen) { this._layoutHits++; return lk.lay; }
    } else {
      key = (needPidMask ? 'b' : 'r') + mver + '|' + tier + '|' + idPart
        + '|' + rx + ',' + ry + '|' + us + '|' + ft + '|' + name;
      p._lk = { mver, tier, id: idPart, rx, ry, us, ft, name, key, lay: null, gen: -1 };
    }
    const hit = this._layoutCache.get(key);
    if (hit !== undefined) {
      this._layoutHits++;
      const m = p._lk;                       // 走到这儿它一定在（两个分支都保证）
      if (m !== undefined && m !== null && m.key === key) { m.lay = hit; m.gen = this._layGen; }
      return hit;
    }
    this._layoutMiss++;
    const lay = layoutMapName(name, mask, tid, tier,
      this._textMetrics(name, kind), {
        gid: needPidMask ? p.gid : null,
        anchor: { x: p.x, y: p.y, area: p.area },
        userScale: us,
        params: this.mapNameParams,
        curve: this.mapNameParams.curve,
      });
    // 缓存上限：开局会**整层预热**（见 `warmPoint`），名额要够装下几层。
    // 一条 = 几个字的 x/y/角度（几十字节）→ 6 万条约几 MB。
    // 失败（null）也要记、也要占名额，否则失败条目会无限涨。
    if (this._layoutCache.size >= LAYOUT_CACHE_MAX) {
      const oldest = this._layoutCache.keys().next().value;
      this._layoutCache.delete(oldest);
    }
    this._layoutCache.set(key, lay || null);   // null 也缓存：省得每帧重试一遍必失败的
    /* 包围盒中心：算一次存下来（`_paint` / `_paintGlyphs` / `drawPoints` 每帧
     * 都要用，否则每帧每个标除两次，一帧几千个就是几千次白除）。 */
    if (lay && lay.bbox) {
      lay._cx = (lay.bbox.x0 + lay.bbox.x1) / 2;
      lay._cy = (lay.bbox.y0 + lay.bbox.y1) / 2;
    }
    /* 刚排出来的也记到点对象上（下次连查表都省，见上面的注释）。 */
    const _m = p._lk;
    if (_m !== undefined && _m !== null && _m.key === key) { _m.lay = lay || null; _m.gen = this._layGen; }
    return lay;
  }

  /**
   * 预热一个标的排版（开局整层跑一遍时用）
   *
   * 排版结果只跟（层 / 头衔 / 文字 / 字体 / 字号倍率）有关，**跟缩放无关**，
   * 因此开局算完，之后放大缩小、平移动画全是查表。
   * 换字体 / 调字号 / 改名会让缓存整份作废（`clearLayouts`），再由 app 重新预热。
   */
  warmPoint(p, kind) {
    if (!p || !p.name) return;
    this._maybeLayout(p, kind || 'place', 0);
  }

  /** 调试角标：这一帧有多少标 / 多少同名重复 */
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
    /* 同名重复每秒在控制台提醒一次（F12 能看到是哪个名字）*/
    if (dupN) {
      const now = Date.now();
      if (!this._dupAt || now - this._dupAt > 1000) {
        this._dupAt = now;
        for (const [nm, c] of dup) if (c > 1) console.warn('[排版] 同名标', nm, '×' + c);
      }
    }
  }


  /**
   * 贴合排版在屏幕上太小时，整条名字要绕自己的中心放大多少倍（1 = 不放大）
   * 口径就这一处：`_paintGlyphs` 按它画、`_paint` 按它算包围盒
   */
  _fitGrow(lay) {
    const px = lay.fs * this.scale;
    if (!(px > 0.05)) return 1;
    return px >= MIN_DRAW ? 1 : Math.min(MIN_DRAW / px, 4);
  }

  /**
   * **逐字画一段排版结果** —— 屏幕和导出共用这一份
   *
   * 两边逻辑一样、只差坐标变换（屏幕那份带视口裁剪、导出那份带倍率换算），
   * 收成一个出口，改一处两边都对。
   *
   * @param {object} o
   *   `ctx` 目标 2D context / `lay` 排版结果 / `size` 字号（已经乘过倍率、已量化）
   *   `color` 颜色 / `kind` 'power' | 'place'
   *   `dpr` 设备像素比（屏幕传 this.dpr，导出传 1）
   *   `origin(g)` 把某个字换算成目标坐标 → `{x,y}`（返回 null = 跳过这个字）
   *   `cull` 可选 `{w,h}`：屏幕外跳过（导出不传）
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
    /* 高倍导出直接走实时矢量，不从字形贴图里取样：
     * 贴图按字号缓存再 drawImage，高倍下会有一次重采样；
     * 实时 fillText 没有这一步，边缘更干净。1× 仍走贴图，省时间。 */
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
      /* **角度三角值记在字上**
       * 排版结果是**定死**的（见 `_maybeLayout`：跟缩放无关），每个字的角度不会变；
       * 每帧现算 cos/sin 的话，一帧五百多个标、一千六百多个字就是三千多次三角函数
       * （整帧自时间 10% 上下）。第一次算完挂 `cosa/sina`，之后直接读
       * （字对象本来就活在布局缓存里）。 */
      const cos = g.cosa !== undefined ? g.cosa : (g.cosa = Math.cos(g.angle));
      const sin = g.sina !== undefined ? g.sina : (g.sina = Math.sin(g.angle));
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

  /** 把排好的字逐字画出来（屏幕用：带视口裁剪 + 太小时绕中心放大） */
  _paintGlyphs(ctx, lay, view, color, kind) {
    const scale = this.scale;
    const sizePx = lay.fs * scale;
    /* 连放大 4 倍都够不着 MIN_DRAW（< 1px）→ 真看不见了，不画 */
    if (!(sizePx * 4 >= MIN_DRAW)) return 0;
    const grow = this._fitGrow(lay);
    const size = quantizeFont(sizePx * grow);
    /* 放大时绕**排版包围盒中心**（不绕视口原点，否则名字会跑位）。
     * 中心在 `_maybeLayout` 里算好存下了（`lay._cx/_cy`），缺字段时现算。 */
    const bx = lay.bbox ? (lay._cx != null ? lay._cx : (lay.bbox.x0 + lay.bbox.x1) / 2) : null;
    const by = lay.bbox ? (lay._cy != null ? lay._cy : (lay.bbox.y0 + lay.bbox.y1) / 2) : null;
    /* 壳子跨标复用（见构造函数里的注释） */
    const org = this._gOrg;
    org.bx = bx == null ? 0 : bx;
    org.by = by == null ? 0 : by;
    org.vx = view.x; org.vy = view.y;
    org.s = scale; org.grow = grow;
    org.flat = (bx == null);
    const opt = this._gRun;
    opt.ctx = ctx; opt.lay = lay; opt.size = size;
    opt.color = color; opt.kind = kind; opt.dpr = this.dpr;
    opt.cull.w = this.cssW; opt.cull.h = this.cssH;
    const drawn = this._drawGlyphRun(opt);
    // 画布变换已由 _drawGlyphRun 还原，这里只要把文字对齐恢复成默认
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    return drawn;
  }

  /**
   * **排版调试层**（设置里勾「排版调试」才画）
   *
   * 画什么：
   *   · 青色框 = 这块地的**连通域包围盒**
   *   · 红点   = 连通域**质心**（居中就对准它）
   *   · 品红线 = 选中的那段"最长连续命中段"
   *   · 黄线   = 实际基线折线（曲线化之后的）
   *   · 绿框   = 每个字的四边形（宽 = advance、高 = 字号、按切线转）
   *
   * 名字位置异常时，看这张图就能区分是**线乱了**还是**字没跟着线**。
   */
  _paintLayoutDebug(ctx, lay, view, dup) {
    const s = this.scale, dpr = this.dpr;
    /* 跟 `_paintGlyphs` 同一个放大口径：调试框必须画在**实际画出来的位置**上 */
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
    /* 这一帧里"贴合版图"和"横排"各画了几个（调试角标要报）*/
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
   * **没有保底。** 算出来够不着 MIN_FONT 就返回 0，调用方直接**不画**这个地名；
   * 硬撑到 MIN_FONT 会让缩小时密密麻麻的小国名全挤在一起。
   * MIN_FONT 是"够不够格显示"的门槛，不是下限。
   *
   * **字号分两类**：`__CK3_FONT_PLACE`（地块名）/ `__CK3_FONT_POWER`（势力名），
   * 否则调大地名时国名会跟着一起大。
   *
   * 分类用现成的判据，不新造字段：
   *    · `tier < nEra` = **时代层**（剧本 / 年份那几层的国名 / 势力名），
   *      `open()` 和字号门槛用的就是它，同一个口径。
   *    · `layer === 2` = **玩家涂出来的色块名**（`_paint` 里那个"玩家名"层，
   *      见 drawPoints 里"地名 0 / 国名 1 / 玩家名 2"那段）。
   *    · 其余（`tier >= nEra` 且不是色块）→ **地块名**（含海 / 湖 / 河 / 荒地名）。
   *  `this.nEra` 构造时已从 meta.eraDates 取好，不需要再传进来。
   *  两个开关都要留回退（内联产物 / 测试桩可能只设了旧键名）：
   *  未设新键时退回 `__CK3_FONT_SCALE`，再退回 1。
   *
   * @param {number} pixels 面积（√ 之后就是边的像素数）
   * @param {number} tier   这个点自己那一层（`open()` 拿它查缩放门槛）
   * @param {number} layer  这个点画在哪一层（0 地名 / 1 国名 / 2 玩家名，缺省 0）
   */
  _fontSize(pixels, tier = 0, layer = 0) {
    const side = Math.sqrt(Math.max(pixels || 1, 1)) * this.scale;
    const boost = TIER_FONT_BOOST[tier] || 1;
    const _userScale = this._userScale(tier, layer);
    const size = side * FONT_RATIO * boost * _userScale;
    // **只有最粗那一层（国名/大洲名）留一道可读底线**，其余层一律 0 = 全显示。
    // 不按下标查表：层数每个游戏不一样（EU5 有 6 层），查不到就会退回 MIN_FONT，
    // 细层又被卡住 —— 统一成"第 0 层之外都全显示"就没这个问题。
    // 0 层（国名）留一道**字号底线**：`√像素 × 缩放 × 0.18` 小于它就不画。
    // 取 4px 时 EU4 的 665 个国家大多要 ~20% 才够大；取 2px 后
    // 10% 就能浮出二十来个、20% 上百个；再往下会糊成蚂蚁字。
    // 这是"可读性底线"，不是缩放门槛 —— 缩放门槛已经全部置 0。
    // 「全部地名」只管"要不要隐藏"，**不改字号** —— 该多大就多大。
    // （写成 Math.max(size, 8) 的话，一勾上小于 8px 的地名全被放大，
    //   表现为"勾了之后字号变了"。）
    if (this.showAll) return size;
    const floor = tier < (this.nEra || 1) ? (TIER_MIN_FONT[0] ?? 4) : 0;
    return size < floor ? 0 : size;
  }

  /** 把 this._text[0..n) 这批标签画出来（按字号分桶，每桶只设一次 font） */
  _paint(ctx, n, view) {
    this._truncated = false;      // 这一帧到底有没有被预算截断（给自测 / 调试看）
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

    /* 调试模式：先数一遍同名标（同一个名字被几个标画了）*/
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
      /* 这一桶用什么字体：**按每个标自己的类别**（`_kind`）。
       * 不能只看桶键里的层：年份层的国名是从"普通头衔点"那条路来的，
       * 层号是 0（跟地名一样），但它该用「势力名」那套字体和字号
       * （`_fontSize` 一直按 `tier < nEra` 分，这里只是把同一个口径补齐）。 */
      let curKind = '', curSize = 0;

      const _p0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const _budget = this.frameBudgetMs;
      for (let _li = 0; _li < list.length; _li++) {
        const k = list[_li];
        if (this.drawn >= MAX_LABELS) break;
        /* **交互中按时间预算截断**
         * 缩放 / 拖动时一屏名字可能画不完，只画到 budget 毫秒就打住，
         * 剩下的等"手停下来"那次全量重画补齐。
         * 截断不能变成常态：自适应上限就是在这里出问题 —— 停下来也不补，
         * 得等下一次鼠标移动才画出来。
         * **必须用 `>=`，不能用 `>`**：排版提速后 16 个标画完 elapsed 还是 0，
         * `0 > 0` 永远不成立，budget=0 也能一路画到底，预算形同虚设；
         * `>=` 恢复其语义。（每 16 个才看一次钟是**故意的**，1 万个标逐个 now() 太贵。） */
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
        // 悬浮时仍旧用米黄，免得看不出鼠标在哪
        const color = HOT[k] ? LABEL_FG_HOVER
          : (C[k] || LABEL_FG);

        /* 排好版的：**逐字画**（每个字自己的位置 / 角度，见 maplabels.js）*/
        const lay = L[k];
        if (lay) {
          /* 太小会被 _paintGlyphs 绕中心等比放大 → 包围盒也得按放大后的算，
           * 不然边缘上看得见的名字会被提前剔掉（口径见 `_paintGlyphs`）*/
          const gr = this._fitGrow(lay);
          /* 中心在 `_maybeLayout` 里算好存下了（`lay._cx/_cy`）—— 缺字段时现算 */
          const cx = lay._cx != null ? lay._cx : (lay.bbox.x0 + lay.bbox.x1) / 2;
          const cy = lay._cy != null ? lay._cy : (lay.bbox.y0 + lay.bbox.y1) / 2;
          const bx0 = (cx - view.x) * scale - (cx - lay.bbox.x0) * scale * gr;
          const bx1 = (cx - view.x) * scale + (lay.bbox.x1 - cx) * scale * gr;
          const by0 = (cy - view.y) * scale - (cy - lay.bbox.y0) * scale * gr;
          const by1 = (cy - view.y) * scale + (lay.bbox.y1 - cy) * scale * gr;
          if (bx1 < 0 || bx0 > cssW || by1 < 0 || by0 > cssH) continue;
          if (this._paintGlyphs(ctx, lay, view, color, kind) > 0) { this.drawn++; this.fitCount++; }
          if (this.debug) this._paintLayoutDebug(ctx, lay, view, dup);
          curKind = '';               // 逐字绘制会改 font，下一条重新设
          continue;
        }

        // 先按位置粗筛，再量宽 —— 不然一帧要对上万个标签逐个 measureText
        if (sx < -pad || sx > cssW + pad || sy < -pad || sy > cssH + pad) continue;

        /* 这一档有没有挂位图字体：有就逐字贴，没有走 fillText */
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
          /* 太大做不了贴图 → 现场逐字贴（描边照旧靠偏移）。 */
          bf.draw(ctx, text, sx, sy, size, color,
            { outline: Math.max(1, size * 0.09), stroke: LABEL_STROKE });
        } else {
          ctx.strokeText(text, sx, sy);
          ctx.fillStyle = color;
          ctx.fillText(text, sx, sy);
        }
        this.drawn++;
        this.flatCount++;        // 走横排画法的 —— 调试角标要报
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
    // **地名的显示门槛**：这一层要缩放到百分之多少才画（meta.labelZoom 给的）。
    // 门槛统一放宽一档：这里乘一个系数，**越小越早出现**；想更宽或更紧就改这一个数。
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
    /* 这一层全都要「贴合版图」吗？**一次判完，别逐点判**。
     * `_maybeLayout` 头两行就是这两个闸，不成立时一律返回 null。
     * 那种层（多数细层：`mapNameMode` 不是 both）若逐点调进去会被立刻弹回来，
     * 纯属白跑，见下面的注释。 */
    const _layoutOn = !(this.mapNameMode === 'off' || !this.realmMask || !this.realmMask.usable);
    const kind = (tier < (this.nEra || 1)) ? 'power' : 'place';
    const _layoutCan = _layoutOn && (kind === 'place' ? this.mapNameMode === 'both' : true);
    /* **点对象要跨帧复用**（剖面里这段占一帧的 1/4）
     * 每个候选每帧现造 `{ name, tid, x, y, area, tier, layer }`，
     * VIC3 最细层 4 万个候选就是每帧 4 万个对象，GC 当场抖动。
     * 更关键的是 `_maybeLayout` 的缓存键**挂在点对象上**（`p._lk`）：
     * 对象每帧都是新的 → `p._lk` 永远 undefined → 那份"键记忆化"一次都没命中过，
     * 于是每帧、每个标都重拼一条六七段的长字符串，那才是真开销。
     * 按层缓存一份点对象，字段原地改，`_lk` 就留得住了。 */
    const PT = this._ptCache[tier] || (this._ptCache[tier] = []);
    const nEra = this.nEra || 1;
    let n = 0;
    /* 索引循环，不用 `for...of` —— 这里一帧要走几万次，
     * 迭代器那点开销在 4 万次上就是实打实的一截（数组语义完全一样）。 */
    for (let k = 0, m = list.length; k < m; k++) {
      const i = list[k];
      // 这里**只防病态数据**，不用 MAX_LABELS 截 —— 先截就是把视口外的大块地
      // 当成了视口内的，放多大都可能一个名字都画不出来（见 MAX_CANDIDATES）
      if (n >= MAX_CANDIDATES) break;
      // 没名字的跳过（HOI4 的省份多数没有城市名，是真·无名地块）
      const nm = names[i];
      if (!nm) continue;
      // 视口外的直接跳过（写成一整个判断，顺带把没有坐标的也滤掉）
      const px = lx[i], py = ly[i];
      if (!(px >= vx0 && px <= vx1 && py >= vy0 && py <= vy1)) continue;
      const size = this._fontSize(sizeArea[i], tier);
      if (size <= 0) continue;      // 太小了：不画，别硬撑成最小字号挤一片
      T[n] = nm;
      X[n] = px;
      Y[n] = py;
      /* P社式排版：年份层（`tier < nEra`）是国名，走"贴合版图"。
       * **排出来就一律按排好的画**，不按屏幕字号退回横排 ——
       * 那会让画法随缩放变化。 */
      let lay = null;
      if (_layoutCan) {
        let p = PT[i];
        if (p === undefined) {
          p = PT[i] = { name: nm, tid: i, x: px, y: py, area: sizeArea[i], tier, layer: 0 };
        } else {
          p.name = nm; p.tid = i; p.x = px; p.y = py; p.area = sizeArea[i];
          p.tier = tier; p.layer = 0;
        }
        lay = this._maybeLayout(p, kind, size);
        /* `_maybeLayout` 只返回 对象 / null；留一手 undefined（以后加预算逻辑也接得住）*/
        if (lay === undefined) continue;
      }
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

    const T = this._text;
    const X = this._x;
    const Y = this._y;
    const S = this._size;
    const HOT = this._hot;
    // 每个标签的"层"：地名 0 / 国名 1 / 玩家名 2。
    // **必须按层分开排** —— _paint 是按字号分桶画的，桶大的先画（在下面），
    // 所以国名只要字号比地名小，就会被画到地名底下（入列顺序管不了它）。
    const LY = this._layer || (this._layer = []);
    let n = 0;
    // 逐点的透明度（势力名 / 地名各一档，缺省 0.5）——必须在本函数里声明
    const F = this._fade || (this._fade = []);
    // 每个点自带的颜色（「国名取色」给的）——没有就落默认色
    const C = this._color || (this._color = []);
    // 这个标排好版了没 / 它是国名还是地名（见 `_maybeLayout`）
    const L = this._layout || (this._layout = []);
    const KINDS = this._kind || (this._kind = []);
    // 跟 draw() 一样先按视口粗筛：不然上万个候选里视口内的那几个
    // 可能刚好排在 MAX_CANDIDATES 之外，整层就是空的（VIC3 最细层 4 万个地块时如此）
    const padMap = Math.max(64, 900 / this.scale);
    const vx0 = view.x - padMap, vx1 = view.x + view.w + padMap;
    const vy0 = view.y - padMap, vy1 = view.y + view.h + padMap;
    /* 这几项**跟点无关**，放在循环外只取一次
     * （`for...of` + 每点一个闭包 `open(p)`，在几百点/帧上也白花钱）。 */
    const _nEra = this.nEra || 0;
    const _aC = this.alphaCountry == null ? 0.5 : this.alphaCountry;
    const _aP = this.alphaPlace == null ? 0.5 : this.alphaPlace;
    for (let pi = 0, pm = points.length; pi < pm; pi++) {
      const p = points[pi];
      if (n >= MAX_CANDIDATES) break;
      if (!p.name) continue;
      /* 这一层的缩放门槛（等价于闭包 `open(p)`；没设门槛就一律画）*/
      const pt = p.tier != null ? p.tier : 0;
      const zn = zoom[pt];
      if (zn != null && pct < zn) continue;
      if (!(p.x >= vx0 && p.x <= vx1 && p.y >= vy0 && p.y <= vy1)) continue;
      /* 三行写入放在早筛之后：
       * 58% 那档一帧 2950 个候选、扔掉 2400 多个，给每个要扔的都写三格数组是白写
       * （`n` 只在最后 `n++`，中间 `continue` 掉的那些写了也没用，顺序不影响结果）。 */
      /* 第三个参数是**层**（0 地名 / 1 国名 / 2 玩家名）——
       * 字号分"地块 / 势力"两类就靠它 + tier（见 `_fontSize` 那段）。
       * 不用新造字段，这个 `layer` 本来就是每个点自带的。 */
      const size0 = this._fontSize(p.area, p.tier || 0, p.layer || 0);
      if (size0 <= 0) continue;
      /* 这个标是什么（字号那套用的是同一个判据，见 `_fontSize`）：
       *   tier < nEra = 剧本 / 年份那几层的**势力名**
       *   layer === 2 = 玩家涂出来的色块名（也算势力名）
       *   其余 = 地块名 */
      const kind = ((p.tier || 0) < _nEra || p.layer === 2) ? 'power' : 'place';
      /* P社式排版：**国名地名一律试**（地名不按字号设门槛）。
       * 真排不出来（分块地图 / 名字塞不进 / 位图字体）→ `lay` 为 null →
       * 下面走横排那套（含 p.w 限宽）。
       * **整份 `p` 传进去**，别只挑几个字段 —— 色块名的
       * `singleTid` / `paintedAny` / `mtier` 就在里面（国名能不能套全靠它们）。 */
      let lay = this._maybeLayout(p, kind, size0);
      /* `_maybeLayout` 只返回 对象 / null；留一手 undefined（以后加预算逻辑也接得住）*/
      if (lay === undefined) continue;
      /* **排好版了、可这一帧压根不在屏幕上 → 不进名单**
       * 候选池按 `padMap = max(64, 900/scale)` 捞（那个余量是给"锚点在视口外、
       * 字伸进来"的名字留的，**不许删**，`_paint` 里也有同样的提醒）。
       * 58% 那档一帧捞进 2950 个、真正画出来的才 524 个，
       * 剩下的 2400 个全要排在 `_paint` 的分桶里并每桶空转一遍（整帧自时间第二名）。
       * 判据跟 `_paint` 里那段**一字不差**（放大倍率 `_fitGrow` 也算进去了），
       * 只把"肯定一个像素都不画"的提前扔掉 → 画出来的东西**不多不少**。
       * 只对**已经排好版**的点判：没排出来（null）的走横排画法，
       * 其位置判据在 `_paint` 里（`pad = size*8` 那套），保持原样。 */
      if (lay && lay.bbox) {
        const _fs = lay.fs * this.scale;
        if (!(_fs * 4 >= MIN_DRAW)) continue;        // 连放大 4 倍都够不着 → 真看不见
        const _gr = this._fitGrow(lay);
        const _s = this.scale;
        const _cx = lay._cx != null ? lay._cx : (lay.bbox.x0 + lay.bbox.x1) / 2;
        const _cy = lay._cy != null ? lay._cy : (lay.bbox.y0 + lay.bbox.y1) / 2;
        const _bx0 = (_cx - view.x) * _s - (_cx - lay.bbox.x0) * _s * _gr;
        const _bx1 = (_cx - view.x) * _s + (lay.bbox.x1 - _cx) * _s * _gr;
        const _by0 = (_cy - view.y) * _s - (_cy - lay.bbox.y0) * _s * _gr;
        const _by1 = (_cy - view.y) * _s + (lay.bbox.y1 - _cy) * _s * _gr;
        if (_bx1 < 0 || _bx0 > this.cssW || _by1 < 0 || _by0 > this.cssH) continue;
      }
      T[n] = p.name;
      X[n] = p.x;
      Y[n] = p.y;
      /* **排出来就按排好的画**（同 `draw()` 那段：不按屏幕字号切回横平竖直）。
       * 名字不超出自己的版图（`p.w` 限宽）只在**没排出来**时才管 ——
       * 排出来的宽度是版图里量出来的，本来就塞得下。 */
      let size = lay ? lay.fs * this.scale : size0;
      if (!lay && p.w > 0) {
        const need = String(p.name).length * size;        // 这些字大约要多宽（汉字方块 ≈ 字号）
        const room = p.w * this.scale * 0.92;             // 版图里能用的宽度
        if (need > room) {
          // **最多只缩到自然字号的 7 成**，别压得太死。
          // 按 size × (room/need) 算的话，名字比版图宽三倍，字号就被砍成三分之一，
          // 砍到底还有 5px 的硬地板，结果就是蚂蚁字。
          // 宁可让长名字压出版图一点点（底下没有别的东西挡着），也不许它缩到看不清；
          // 要更狠或更松就调下面这个 0.7。
          const SHRINK_FLOOR = 0.7;
          size = Math.max(size0 * SHRINK_FLOOR, size * (room / need));
        }
      }
      S[n] = size;
      HOT[n] = false;
      LY[n] = p.layer || 0;
      L[n] = lay;
      KINDS[n] = kind;
      /* **名字默认 50% 不透明**，半透可以看见底下的填色 / 边界。
       * **两档可调**（设置里 25 / 50 / 75 / 100），**分法按"层"**：
       *   · `tier < nEra`（剧本 / 年份那几层）= **势力名** → 「势力名称不透明度」
       *     **玩家涂出来的色块名也归这档**（drawLabels 给它们 `tier: 0`）
       *   · `tier >= nEra`（地区 / 省份 / 地点，"真正的"地名）= **地名** → 「地名不透明度」
       * 必须跟 drawLabels 里那条分层口径一致，错一处就没法单独调 ——
       * 若把"色块名"那批一律压进地名档，剧本层的国名就会跟着「地名不透明度」走，
       * 「势力名称」那根滑条怎么拖都没反应。
       * 这里只能用 **this.nEra**（模块顶部的自由变量 nEra 在类里取不到）。 */
      F[n] = (_nEra > 0 && (p.tier || 0) < _nEra) ? _aC : _aP;
      C[n] = p.color || '';   // 「国名取色」：带着自己那族的颜色画
      n++;
    }
    this._paint(ctx, n, view);
    this.lastMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0;
  }

  /**
   * **整图导出时把名字画上去**
   *
   * 整图导出是分块渲染再拼起来的，标签层不参与，导出的图里就没有字。
   * 这里按**导出尺寸**重画一遍：排版结果都在地图像素里（跟缩放无关），
   * 只要把每个字的坐标 × 导出倍率就能画，不用重排。
   *
   * 哪些名字上：**完全听显示区那几个开关**（`drawLabels` 已按开关筛过一轮），
   * 不另设"导出带不带名字"的开关。
   *
   * @param {CanvasRenderingContext2D} ctx 输出画布的 2D context
   * @param {Array} points `drawLabels(view, true)` 抓到的那份名单
   * @param {number} scale 导出倍率（输出像素 / 地图像素）
   * @param {number} gateScale 决定"这一层名字出不出来"的缩放比（= 整图视角的倍率）
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
    /* 借 this.scale 给 `_fitGrow` / `_fontSize` 用（画完立刻还回去）*/
    this.scale = scale;
    const nEra = this.nEra || 0;
    const zoom = this.zoom || [];
    const hasLayout = this.mapNameMode !== 'off' && this.realmMask && this.realmMask.usable;
    /* 整张导出时这里会跑几千上万个地名：
       · 原点换算提成一个函数，不为每个名字新建闭包
       · 对齐 / 基线 / 圆角只设一次，每个名字只改 alpha
       · 不为每个名字 save/restore 一次状态栈
       （下面 finally 统一把 alpha / 对齐 / 变换恢复干净） */
    const origin = (g) => ({
      x: (g.x - ox) * scale,
      y: (g.y - oy) * scale,
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    let drawn = 0;
    try {
      /* ================================================================
       * ① 先摊候选：字号 / 颜色 / **字框**都算好，画之前还要过一道避让
       *   （整张图一次画完，弯的大洋名会压在小名上，见上面那一节）
       * ================================================================ */
      const cand = [];
      for (const p of points) {
        if (!p || !p.name) continue;
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        /* 框选导出：只画落在区域里的名字，坐标再平移到输出画布左上角 */
        if (p.x < ox || p.x > ox + rw || p.y < oy || p.y > oy + rh) continue;
        const t = p.tier != null ? (p.tier | 0) : 0;
        /* 层的门槛按"整图视角"判（跟屏幕上那套一致，只是倍率换成整图）*/
        const need = zoom[t];
        if (need != null && gateScale * 100 < need) continue;
        const isPower = (p.tier || 0) < nEra || p.layer === 2;
        const kind = isPower ? 'power' : 'place';
        const lay = hasLayout ? this._maybeLayout(p, kind, 0) : null;
        let size;
        let boxes;
        if (lay) {
          /* 门槛统一按**最终输出字号**算：15px 就是 15px，不随倍率变成 45px。
           * 高倍下字更大、再用实时矢量绘制，清晰度靠渲染质量，不靠抬门槛。 */
          size = exportFontPx(quantizeFont(lay.fs * scale * this._fitGrow(lay)));
          if (!size) continue;
          /* 逐字算占地：弯名 / 竖排 / 转过的字都算得准（整条 AABB 会假撞）。 */
          boxes = exportGlyphBoxes(lay, size, origin);
        } else {
          /* 横排画法也一样：按最终输出字号过 15px 门槛 */
          size = exportFontPx(this._fontSize(p.area, p.tier || 0, p.layer || 0) * scale);
          if (!size) continue;
          const pad = Math.max(1, size * EXPORT_INK_PAD);
          const hw = Math.max(1, measureCached(ctx, p.name, size, kind)) * 0.5 + pad;
          const hh = size * 0.5 + pad;
          const tx = (p.x - ox) * scale;
          const ty = (p.y - oy) * scale;
          boxes = [{ x0: tx - hw, y0: ty - hh, x1: tx + hw, y1: ty + hh }];
        }
        cand.push({
          p, lay, size, kind, boxes, color: p.color || LABEL_FG, power: isPower,
          alpha: isPower
            ? (this.alphaCountry == null ? 0.5 : this.alphaCountry)
            : (this.alphaPlace == null ? 0.5 : this.alphaPlace),
        });
      }

      /* ================================================================
       * ② 贪心占位：**势力名 / 涂色块名最先占**（国名是这张图的主语，
       *   屏幕上它们也是最后画、压在最上面的；分桶键 `layer*100000` 那套）
       *   然后是**字号大的先占**；同字号再按 tier 升序；最后按名单原序
       *   （名单原序本来就是面积降序，见 `placePointsInView`，排序是稳的）
       * ================================================================ */
      const keep = new Uint8Array(cand.length);
      const order = new Array(cand.length);
      for (let i = 0; i < cand.length; i++) order[i] = i;
      order.sort((a, b) => ((cand[b].power ? 1 : 0) - (cand[a].power ? 1 : 0))
        || (cand[b].size - cand[a].size)
        || ((cand[a].p.tier | 0) - (cand[b].p.tier | 0))
        || (a - b));
      const grid = new PackGrid(128);
      for (let i = 0; i < order.length; i++) {
        const c = cand[order[i]];
        let hit = false;
        for (let j = 0; j < c.boxes.length && !hit; j++) hit = grid.hits(c.boxes[j]);
        if (hit) continue;
        keep[order[i]] = 1;
        for (let j = 0; j < c.boxes.length; j++) grid.add(c.boxes[j]);
      }

      /* ================================================================
       * ③ 按名单原顺序画：叠放次序保持不变
       *   只是被挤掉的那几条不画；颜色 / 字体 / 描边 / 字号全走原路
       * ================================================================ */
      for (let i = 0; i < cand.length; i++) {
        if (!keep[i]) continue;
        const c = cand[i];
        const p = c.p;
        ctx.globalAlpha = c.alpha;
        if (c.lay) {
          /* 逐字画：**跟屏幕同一个出口**，只有坐标变换不同 ——
           * 导出是"地图坐标 × 倍率"，没有视口偏移。 */
          this._drawGlyphRun({
            ctx, lay: c.lay, size: c.size, kind: c.kind, color: c.color, dpr: 1, origin,
            exportText: scale > 1,
          });
        } else {
          /* 排不出来 / 关掉了贴合 → 横排画法：横着写在锚点上
           * **字体要跟屏幕上同一套**：屏幕上这里是两条路 —— 挂了**位图字体**就
           * `bf.draw`，否则才 `fillText` + 当前字体栈。导出只写后者的话，
           * 用了位图字体的图导出就退回默认字体，因此照抄屏幕那条判据。 */
          const bf = BITMAP[c.kind];
          const tx = (p.x - ox) * scale;
          const ty = (p.y - oy) * scale;
          if (bf) {
            bf.draw(ctx, p.name, tx, ty, c.size, c.color,
              { outline: Math.max(1, c.size * 0.09), stroke: LABEL_STROKE });
          } else {
            ctx.font = fontFor(c.size, c.kind);
            ctx.lineWidth = Math.max(1.3, c.size * 0.14);
            ctx.strokeStyle = LABEL_STROKE;
            ctx.fillStyle = c.color;
            ctx.strokeText(p.name, tx, ty);
            ctx.fillText(p.name, tx, ty);
          }
        }
        drawn++;
      }
    } finally {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      this.scale = oldScale;      // 一定要还回去，不然屏幕上的字号全变
    }
    return drawn;
  }
}
