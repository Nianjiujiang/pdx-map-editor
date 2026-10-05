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

//: 各层级从多少缩放百分比开始显示 —— 默认这套是 CK3 调出来的
//: （帝国 / 王国 / 公爵领 / 伯爵领 / 男爵领）。EU4 的图小得多、省份密得多，
//: 门槛得另给一套，所以实际用的是 meta.labelZoom。
const MIN_ZOOM_PERCENT = [8, 30, 60, 120, 250];

//: 字体栈。用系统自带的雅黑这一类黑体 —— 楷体系列（华文楷体等）在 Canvas 上
//: 逐字渲染中文明显更慢，标签一多就卡。
const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';

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
 * 只给**国名那层**留门槛（4px），因为一国之地往往横跨半个屏幕，
 * 名字太小会跟别国糊在一起。地区 / 省份这些细层一律 **0 = 全显示**：
 * 它们各自有 meta.labelZoom 的缩放门（没到那个缩放整层都不出现），
 * 门一开就该把这一层全摆出来 —— 跟 CK3 伯爵领那套一样。
 */
const TIER_MIN_FONT = [4, 0, 0, 0, 0];

/** 真正允许画出来的最小字号：字号阶梯从这里起步 */
const MIN_DRAW = 4;

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

function fontFor(size) {
  let f = FONT_CACHE.get(size);
  if (f === undefined) {
    f = `600 ${size.toFixed(1)}px ${FONT_STACK}`;
    FONT_CACHE.set(size, f);
  }
  return f;
}

// ---------------------------------------------------------------- 量宽缓存

//: 标签每帧都要量一遍宽度，几百个标签时 measureText 是主要开销；
//: 同一个地名在**同一级字号**下量一次就够了（字号已经量化过了）。
const WIDTH_CACHE = new Map();
const WIDTH_CACHE_MAX = 20000;

function measureCached(ctx, text, size) {
  const key = size.toFixed(1) + '\u0000' + text;
  let w = WIDTH_CACHE.get(key);
  if (w === undefined) {
    ctx.font = fontFor(size);
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
  get(text, size, color, dpr, tw) {
    const key = size.toFixed(1) + '|' + color + '|' + text;
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
    g.font = fontFor(size);
    g.lineWidth = Math.max(1.3, size * 0.14);
    g.strokeStyle = LABEL_STROKE;
    g.strokeText(text, w / 2, h / 2);
    g.fillStyle = color;
    g.fillText(text, w / 2, h / 2);

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
    this.zoom = (meta && meta.labelZoom) || MIN_ZOOM_PERCENT;
    this.sprites = new SpriteCache();

    // 一帧只读一次的视口尺寸（CSS px）
    this.cssW = canvas.clientWidth || 1;
    this.cssH = canvas.clientHeight || 1;

    // 每帧复用的临时数组，稳态下不产生垃圾
    this._text = [];
    this._x = [];
    this._y = [];
    this._size = [];
    this._hot = [];
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
    }
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
  _fontSize(pixels, tier = 0) {
    const side = Math.sqrt(Math.max(pixels || 1, 1)) * this.scale;
    const boost = TIER_FONT_BOOST[tier] || 1;
    // 设置页的字号倍率：走一个全局值，开发版（真 ES module）和内联版都能用 ✓
  const _userScale = (typeof window !== "undefined" && window.__CK3_FONT_SCALE) || 1;
    const size = side * FONT_RATIO * boost * _userScale;
    // **只有最粗那一层（国名/大洲名）留门槛**，其余层一律 0 = 全显示。
    // 不按下标查表：层数每个游戏不一样（EU5 有 6 层），查不到就会退回 MIN_FONT，
    // 结果细层又被卡住 —— 统一成"第 0 层之外都全显示"就没这个问题。
    // 0 层（国名）留一道**字号门槛**：`√像素 × 缩放 × 0.18` 小于它就不画。
    // 于是缩小的时候只有大国名浮出来，越放大冒出越多 —— 这就是"渐次出现"。
    // 门槛值 4px：EU4 的 1444 有 665 个国家（HOI4 才 96 个），同样是 4px，
    // 它天生就比别的模式热闹 —— 这是国家的绝对数量决定的，不是逻辑差异。
    // 「全部地名」只管"要不要隐藏"，**不改字号** —— 该多大就多大。
    // （以前这里写成 Math.max(size, 8)，一勾上小于 8px 的地名全被放大，
    //   看起来就是"勾了之后字号变了"。）
    if (this.showAll) return size;
    const floor = tier < (this.nEra || 1) ? (TIER_MIN_FONT[0] || 4) : 0;
    return size < floor ? 0 : size;
  }

  /** 把 this._text[0..n) 这批标签画出来（按字号分桶，每桶只设一次 font） */
  _paint(ctx, n, view) {
    const buckets = this._buckets;
    const keys = this._bucketKeys;
    for (const arr of buckets.values()) arr.length = 0;   // 数组留着复用，清内容

    const S = this._size;
    const LY = this._layer || [];
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
    const cssW = this.cssW;
    const cssH = this.cssH;
    const dpr = this.dpr;
    const scale = this.scale;
    const sprites = this.sprites;

    for (const key of keys) {
      const size = KEY - (key % KEY);      // 从桶键里把字号取回来
      const list = buckets.get(key);
      ctx.font = fontFor(size);
      ctx.lineWidth = Math.max(1.3, size * 0.14);
      ctx.strokeStyle = LABEL_STROKE;
      const half = size * 1.15 / 2;
      // 位置粗筛的余量：地名再长也不会超过 size * 8 的半宽（十几个汉字都够）
      const pad = size * 8;

      for (const k of list) {
        if (this.drawn >= MAX_LABELS) break;
        const fa = F[k] == null ? 1 : F[k];
        if (ctx.globalAlpha !== fa) ctx.globalAlpha = fa;
        const sx = (X[k] - view.x) * scale;
        const sy = (Y[k] - view.y) * scale;
        // 先按位置粗筛，再量宽 —— 不然一帧要对上万个标签逐个 measureText
        if (sx < -pad || sx > cssW + pad || sy < -pad || sy > cssH + pad) continue;

        const text = T[k];
        const tw = measureCached(ctx, text, size);
        const hw = tw / 2;
        if (sx + hw < 0 || sx - hw > cssW) continue;
        if (sy + half < 0 || sy - half > cssH) continue;

        // **标签可以自带颜色**（「国名取色」按钮给的）——
        // 悬浮时仍旧用米黄，免得看不出鼠标在哪 ✓
        const color = HOT[k] ? LABEL_FG_HOVER
          : ((list[k] && list[k].color) || LABEL_FG);
        const sp = sprites.get(text, size, color, dpr, tw);
        if (sp !== null) {
          ctx.drawImage(sp.c, sx - sp.w / 2, sy - sp.h / 2, sp.w, sp.h);
        } else {
          ctx.strokeText(text, sx, sy);
          ctx.fillStyle = color;
          ctx.fillText(text, sx, sy);
        }
        this.drawn++;
      }
    }
  }

  /**
   * 常规画法。
   * @param {object} view   视口 {x, y, w, h}，单位是地图像素
   * @param {number} tier   当前层级
   * @param {number} hover  要高亮的头衔序号，没有就 null
   */
  draw(view, tier, hover = null) {
    if (!this.enabled) { this.resize(); this.clear(); return; }
    const need = this.zoom[tier];
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
      S[n] = size;
      HOT[n] = i === hover;
      n++;
    }
    this._paint(ctx, n, view);
  }

  /**
   * 直接画一组点（常规模式按颜色聚出来的那些色块）。
   * @param {Array<{name:string, x:number, y:number, area:number}>} points
   */
  /** 某一层的地名导成点数组（给"两套名字合并画"用）
   *  `tid` 是头衔序号 —— 上层要按"首都那片连通域"挪位置时得认得出来 ✓ */
  pointsFor(tier) {
    const list = this.byTier[tier];
    if (!list || !list.length) return [];
    const { names, lx, ly } = this.titles;
    const out = [];
    for (const i of list) {
      if (!names[i]) continue;
      out.push({ tid: i, name: names[i], x: lx[i], y: ly[i], area: this.sizeArea[i], tier });
    }
    return out;
  }

  /**
   * 直接画一组点。
   * @param {number} [need] 这一层的缩放门槛（百分比）。缩放不到就整层不画 ——
   *   必须等 _begin(view) 之后判，那之后 this.scale 才是这一帧的。
   */
  drawPoints(points, view, need = null) {
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
      const size0 = this._fontSize(p.area, p.tier || 0);
      if (size0 <= 0) continue;
      // **名字不超出自己的版图** ✓（不是裁字 ✗ —— 太长就自己变小 ✓）
      // p.w = 那一片的横向跨度（地图像素 ✓，由 app 随 paintBlocks 一起给）
      let size = size0;
      if (p.w > 0) {
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
      // 国名（含玩家涂出来的国名）统一半透明 —— 它们压在细层名字上面，
      // 太实会把底下的省名糊掉。
      F[n] = p.fade ? 0.6 : 1;
      n++;
    }
    this._paint(ctx, n, view);
  }
}
