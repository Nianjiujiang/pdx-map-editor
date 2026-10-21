/**
 * 位图字体（BMFont `.fnt` + DDS 字图集）—— 2026-10-20
 *
 * 为什么要它：欧陆风云4 的中文模组**全是位图字体**，一个 TTF 都不带。
 *   `gfx/fonts/zh-hans-16.fnt` + `zh-hans-16.dds`：
 *     · `.fnt` = 标准 BMFont 文本格式（每个字在图集里的位置 / 前进宽度 ✓）
 *     · `.dds` = DXT5（BC3）块压缩，那张 2048×3840，跟 fnt 的 scaleW/scaleH 对得上
 *   想把那些模组的字体也用起来，只能自己解出来、按 xadvance 逐字画 ✓
 *
 * ⚠ DXT5 的**字形在 alpha 通道里**（白色字 + 透明底 ✓）——
 *   合成时用 alpha 当墨量、颜色由调用方给 ✓ 同一套图集能当任意颜色用 ✓
 *
 * 🔴 **不整张解码，按字取** ✗✗（2026-10-20）
 *   `zh-hans-map.dds` 是 6400×8192 —— 整张解成 RGBA 要 **187 MB** ✗
 *   但 DXT5 是**块压缩**，随便翻开哪一块都不依赖前面的数据 ✓
 *   → 用到哪个字，就只解**盖住它的那几块**（一个汉字 16×18 顶多 5×5 个块 ✓）
 *   → 每个字铸成一张小 canvas 存起来 ✓ 整张字体占多少内存只跟"用到几个字"有关 ✓
 */

/* ================================================================ .fnt */

/** BMFont 里一行的 `k=v` 对（值可能带引号 ✓） */
function _kv(line) {
  const out = {};
  const re = /(\w+)=("([^"]*)"|\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return out;
}

/**
 * 解析 BMFont 文本格式
 * @returns {{face:string,size:number,lineHeight:number,base:number,
 *            scaleW:number,scaleH:number,pages:number,
 *            chars:Map<number,{x:number,y:number,w:number,h:number,
 *                              xoff:number,yoff:number,adv:number,page:number}>}}
 */
export function parseFnt(text) {
  const out = {
    face: '', size: 0, lineHeight: 0, base: 0,
    scaleW: 0, scaleH: 0, pages: 1,
    chars: new Map(),
  };
  if (typeof text !== 'string' || !text) return out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('info ')) {
      const kv = _kv(line);
      out.face = kv.face || '';
      out.size = Number(kv.size) || 0;
    } else if (line.startsWith('common ')) {
      const kv = _kv(line);
      out.lineHeight = Number(kv.lineHeight) || 0;
      out.base = Number(kv.base) || 0;
      out.scaleW = Number(kv.scaleW) || 0;
      out.scaleH = Number(kv.scaleH) || 0;
      out.pages = Number(kv.pages) || 1;
    } else if (line.startsWith('char ')) {
      const kv = _kv(line);
      const id = Number(kv.id);
      if (!Number.isFinite(id)) continue;
      out.chars.set(id, {
        x: Number(kv.x) || 0,
        y: Number(kv.y) || 0,
        w: Number(kv.width) || 0,
        h: Number(kv.height) || 0,
        xoff: Number(kv.xoffset) || 0,
        yoff: Number(kv.yoffset) || 0,
        adv: Number(kv.xadvance) || 0,
        page: Number(kv.page) || 0,
      });
    }
  }
  return out;
}

/* ================================================================ DDS */

const DDS_MAGIC = 0x20534444;   // "DDS "

/**
 * 只读个头：尺寸 / 格式 / 每块字节数
 * @returns {{width:number,height:number,format:string,blockBytes:number,dataOff:number}|null}
 */
export function ddsInfo(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 128) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== DDS_MAGIC) return null;
  const height = dv.getUint32(12, true);
  const width = dv.getUint32(16, true);
  if (!width || !height) return null;
  const pfFlags = dv.getUint32(80, true);
  const fourCC = String.fromCharCode(
    dv.getUint8(84), dv.getUint8(85), dv.getUint8(86), dv.getUint8(87));
  const bitCount = dv.getUint32(88, true);
  const isFourCC = (pfFlags & 0x4) !== 0;

  if (isFourCC && (fourCC === 'DXT1' || fourCC === 'DXT3' || fourCC === 'DXT5')) {
    return {
      width, height, format: fourCC,
      blockBytes: fourCC === 'DXT1' ? 8 : 16,
      dataOff: 128,
    };
  }
  if (!isFourCC && bitCount === 32) {
    return { width, height, format: 'RGBA', blockBytes: 0, dataOff: 128 };
  }
  return null;
}

/**
 * 解**一小块矩形**（懒解的核心 ✓）
 * @returns {{rgba:Uint8ClampedArray,width:number,height:number}|null}
 */
export function decodeRect(buf, info, rx, ry, rw, rh) {
  if (!info || rw <= 0 || rh <= 0) return null;
  const out = new Uint8ClampedArray(rw * rh * 4);
  const dv = new DataView(buf);

  if (info.format === 'RGBA') {
    for (let y = 0; y < rh; y++) {
      const sy = ry + y;
      if (sy >= info.height) break;
      for (let x = 0; x < rw; x++) {
        const sx = rx + x;
        if (sx >= info.width) break;
        const si = info.dataOff + (sy * info.width + sx) * 4;
        const di = (y * rw + x) * 4;
        out[di] = dv.getUint8(si + 2);
        out[di + 1] = dv.getUint8(si + 1);
        out[di + 2] = dv.getUint8(si);
        out[di + 3] = dv.getUint8(si + 3);
      }
    }
    return { rgba: out, width: rw, height: rh };
  }

  /* 块压缩：算出盖住这块矩形的是哪几块 ✓ 只解这些 ✓ */
  const bb = info.blockBytes;
  const bw = Math.ceil(info.width / 4);
  const bx0 = Math.floor(rx / 4), by0 = Math.floor(ry / 4);
  const bx1 = Math.floor((rx + rw - 1) / 4), by1 = Math.floor((ry + rh - 1) / 4);
  const rgb = new Uint8Array(48);
  const alpha = new Uint8Array(16);

  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) {
      const off = info.dataOff + (by * bw + bx) * bb;
      if (off + bb > buf.byteLength) continue;
      _decodeBlock(dv, off, info.format, rgb, alpha);
      const px0 = bx * 4, py0 = by * 4;
      for (let y = 0; y < 4; y++) {
        const dy = py0 + y - ry;
        if (dy < 0 || dy >= rh) continue;
        for (let x = 0; x < 4; x++) {
          const dx = px0 + x - rx;
          if (dx < 0 || dx >= rw) continue;
          const si = y * 4 + x;
          const di = (dy * rw + dx) * 4;
          out[di] = rgb[si * 3];
          out[di + 1] = rgb[si * 3 + 1];
          out[di + 2] = rgb[si * 3 + 2];
          out[di + 3] = alpha[si];
        }
      }
    }
  }
  return { rgba: out, width: rw, height: rh };
}

/** 整张解（自测 / 小图集用；大图集别调它 ✗ 会吃几百 MB） */
export function decodeDDS(buf) {
  const info = ddsInfo(buf);
  if (!info) return null;
  const r = decodeRect(buf, info, 0, 0, info.width, info.height);
  return r ? { width: r.width, height: r.height, rgba: r.rgba, format: info.format } : null;
}

/** 解一个 4×4 块 → rgb(16×3) + alpha(16) */
function _decodeBlock(dv, off, format, rgb, alpha) {
  const isDXT5 = format === 'DXT5';
  /* 🔴 **DXT3 也要认** ✗✗（2026-10-20 ✓ 用户："字体里面那个是选中会退回默认"）
   *   字体库里「简中地图字体-颜真卿多宝塔碑体」那份就是 **DXT3**
   *   （6400×4800，字形全在 alpha 里）—— 当初只写了 DXT1/DXT5，
   *   `ddsInfo` 直接返回 null → 选中就退回默认 ✓
   *
   *   DXT3 = BC2：
   *     前 8 字节 = alpha，**每像素 4 位**（不是 DXT5 那种 8 字节插值表 ✓）
   *     后 8 字节 = 色块，跟 DXT1 一样，但**永远走四色插值**（没有 1 位透明那套 ✓）
   */
  const isDXT3 = format === 'DXT3';
  let p = off;

  let a0 = 255, a1 = 255;
  const aBits = [0, 0, 0, 0, 0, 0];
  const aNib = [0, 0, 0, 0, 0, 0, 0, 0];
  if (isDXT5) {
    a0 = dv.getUint8(p);
    a1 = dv.getUint8(p + 1);
    for (let i = 0; i < 6; i++) aBits[i] = dv.getUint8(p + 2 + i);
    p += 8;
  } else if (isDXT3) {
    for (let i = 0; i < 8; i++) aNib[i] = dv.getUint8(p + i);
    p += 8;
  }

  const c0 = dv.getUint16(p, true);
  const c1 = dv.getUint16(p + 2, true);
  const bits = dv.getUint32(p + 4, true);

  const r0 = ((c0 >> 11) & 31) * 255 / 31 | 0;
  const g0 = ((c0 >> 5) & 63) * 255 / 63 | 0;
  const b0 = (c0 & 31) * 255 / 31 | 0;
  const r1 = ((c1 >> 11) & 31) * 255 / 31 | 0;
  const g1 = ((c1 >> 5) & 63) * 255 / 63 | 0;
  const b1 = (c1 & 31) * 255 / 31 | 0;

  /* ⚠ 色块这里只是占位 —— 字形完全来自 alpha ✓
   *   （Paradox 的字图集是白字透明底 ✓ 色块基本都是白的）*/
  const pal = [
    [r0, g0, b0], [r1, g1, b1],
    [(r0 + r1) >> 1, (g0 + g1) >> 1, (b0 + b1) >> 1], [0, 0, 0],
  ];
  if (isDXT5 || isDXT3 || c0 > c1) {
    pal[2] = [(2 * r0 + r1) / 3 | 0, (2 * g0 + g1) / 3 | 0, (2 * b0 + b1) / 3 | 0];
    pal[3] = [(r0 + 2 * r1) / 3 | 0, (g0 + 2 * g1) / 3 | 0, (b0 + 2 * b1) / 3 | 0];
  }

  const aPal = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    for (let i = 0; i < 6; i++) aPal[2 + i] = ((6 - i) * a0 + (1 + i) * a1) / 7 | 0;
  } else {
    for (let i = 0; i < 4; i++) aPal[2 + i] = ((4 - i) * a0 + (1 + i) * a1) / 5 | 0;
    aPal[6] = 0;
    aPal[7] = 255;
  }

  for (let i = 0; i < 16; i++) {
    const ci = (bits >>> (i * 2)) & 3;
    rgb[i * 3] = pal[ci][0];
    rgb[i * 3 + 1] = pal[ci][1];
    rgb[i * 3 + 2] = pal[ci][2];
    if (isDXT5) {
      const bitPos = i * 3;
      const byteI = bitPos >> 3;
      const shift = bitPos & 7;
      let v = aBits[byteI] >> shift;
      if (shift > 5) v |= aBits[byteI + 1] << (8 - shift);
      alpha[i] = aPal[v & 7];
    } else if (isDXT3) {
      /* 每像素 4 位：低半字节 = 偶数号像素 ✓ 0..15 × 17 铺满 0..255 ✓ */
      const byteI = i >> 1;
      const nib = (i & 1) ? ((aNib[byteI] >> 4) & 0xF) : (aNib[byteI] & 0xF);
      alpha[i] = nib * 17;
    } else {
      alpha[i] = (c0 > c1 || ci !== 3) ? 255 : 0;
    }
  }
}

/* ================================================================ 字体对象 */

/** 每个实例一个 uid —— 贴图缓存靠它区分"换没换字体" ✓ */
let _FONT_UID = 0;

/**
 * 一套位图字体：`fnt` 元数据 + 图集原始字节 + 用到过的字
 *
 * ⚠ 字体**出厂尺寸固定**（fnt 里的 lineHeight）✗
 *   要画多大都得按 `size / lineHeight` 缩放 ✓ 缩小会糊一点点，
 *   这是位图字体天生如此 —— 但游戏里本来就是这么显示的 ✓
 */
export class BitmapFont {
  /**
   * 🔴 **一个字体可以有好几页** ✗✗（2026-10-20 ✓ 用户：
   *   "CN_mapfont_0 / CN_mapfont_1 这俩要合一起才能用，不然一半一半的"）
   *
   *   BMFont 的图集有上限 ✓ 汉字多了装不下 ✓
   *   于是**同一个字体被拆成好几对 `.fnt` + `.dds`** ✓
   *   模组那边就是 CN_mapfont_0 装 4718 个字、CN_mapfont_1 装 2168 个 ✓
   *   只喂一对 → 另一半字全变空白 ✓ 看着就是"缺字"
   *
   *   ⚠ 老的单页签名必须继续能用 ✗ —— 两种入参都认：
   *     数组 = 多页；两个参数 = 单页 ✓
   *
   * @param {string|Array<{fnt:string,dds:ArrayBuffer}>} fntText
   * @param {ArrayBuffer} [ddsBytes]
   */
  constructor(fntText, ddsBytes) {
    const raw = Array.isArray(fntText)
      ? fntText
      : [{ fnt: fntText, dds: ddsBytes }];
    this.pages = [];
    for (const pg of raw) {
      if (!pg || typeof pg.fnt !== 'string') continue;
      const meta = parseFnt(pg.fnt);
      const dds = pg.dds instanceof ArrayBuffer ? pg.dds : null;
      const info = dds ? ddsInfo(dds) : null;
      if (!info || !meta.chars.size) continue;
      this.pages.push({ meta, dds, info });
    }
    /* 兼容老字段：meta / dds / info 都指向第一页 ✓ */
    const first = this.pages[0];
    this.meta = first ? first.meta : parseFnt('');
    this.dds = first ? first.dds : null;
    this.info = first ? first.info : null;
    this.ok = this.pages.length > 0;
    this.uid = ++_FONT_UID;
    /** 码点 → 小 canvas（懒铸 ✓） */
    this._glyphs = new Map();
    this._canvas = null;
  }

  /** 跨页找字 ✓ */
  _find(cp) {
    for (const pg of this.pages) {
      const g = pg.meta.chars.get(cp);
      if (g) return { pg, g };
    }
    return null;
  }

  /** 显示名（fnt 里的 face ✓） */
  get face() { return this.meta.face || ''; }

  /** 出厂行高（判缩放用 ✓） */
  get lineHeight() { return this.meta.lineHeight || this.meta.size || 16; }

  /** 取一个字的**原始数据**（没有就现解 ✓）
   *  @returns {{w:number,h:number,adv:number,xoff:number,yoff:number,rgba:Uint8ClampedArray}|null}
   *  ⚠ 这里**不碰 canvas** ✗ —— 纯数据，Node 里也能测 ✓
   *    要画的时候才由 `_canvasFor` 铸成 canvas ✓ */
  glyph(cp) {
    const hit = this._glyphs.get(cp);
    if (hit !== undefined) return hit;
    const found = this._find(cp);
    const g = found ? found.g : null;
    if (!g || !g.w || !g.h) {
      this._glyphs.set(cp, null);
      return null;
    }
    /* ⚠ **要用那一页自己的图集** ✗ —— 拿第一页去解第二页的坐标会解出乱码方块 ✓ */
    const r = decodeRect(found.pg.dds, found.pg.info, g.x, g.y, g.w, g.h);
    if (!r) { this._glyphs.set(cp, null); return null; }
    const out = { w: g.w, h: g.h, adv: g.adv, xoff: g.xoff, yoff: g.yoff, rgba: r.rgba };
    this._glyphs.set(cp, out);
    return out;
  }

  /** 一段文字在某个字号下的宽度（CSS px ✓）*/
  measure(text, size) {
    const scale = size / this.lineHeight;
    let w = 0;
    for (const ch of String(text || '')) {
      const found = this._find(ch.codePointAt(0));
      w += (found ? found.g.adv : this.meta.size * 0.5) * scale;
    }
    return w;
  }

  /**
   * 把一段文字画到 ctx 上（**居中**：x 是中心、y 是垂直中心 ✓ 跟 fillText 那套对齐 ✓）
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {number} x 中心 x
   * @param {number} y 中心 y
   * @param {number} size 字号（CSS px）
   * @param {string} color
   * @param {{outline?:number}} [opt] outline = 描边粗细（0 = 不描 ✓）
   */
  draw(ctx, text, x, y, size, color, opt) {
    const s = String(text || '');
    if (!s) return;
    const scale = size / this.lineHeight;
    const total = this.measure(s, size);
    const lineH = this.lineHeight * scale;
    const top = y - lineH / 2;
    const outline = (opt && opt.outline) || 0;

    /* 🔴 **描边 = 对 alpha 做膨胀，不是把字形复制几遍** ✗✗
     *   （2026-10-20 ✓ 用户："他的描边方式是把字的每个偏旁复制到原本位置的上下左右，非常诡异"）
     *
     *   原来那版图省事：同一个字偏移 4 个方向各画一遍 ✓
     *   笔画之间本来就挨着，一偏就是**四条重影** ✓ 小字上尤其明显 ✗
     *
     *   现在改成正路：
     *     ① 把字形的 alpha 按半径 r **取邻域最大值**（morphological dilate ✓）
     *        —— 结果是一圈**实心外扩**，跟真实描边一个意思 ✓
     *     ② 这层用描边色填，铺在字底下 ✓
     *     ③ 再把字形本体盖上去 ✓
     *   膨胀是逐像素算的，只跟字形有关 → 按 (字形, 颜色, 半径) 缓存 ✓
     *   r 用**字形像素**算：屏幕上的粗细 ÷ 缩放 ✓ 这样放大时描边不会跟着变粗 ✓
     */
    const strokeColor = (opt && opt.stroke) || 'rgba(0, 0, 0, 0.82)';
    /* ⚠ 半径**减半再向上取整** ✗✗（2026-10-20 ✓ 用户先报"变细一半"、再报"粗了"）
     *   拿真字体量过：同样 `outline = size × 0.09` 参数下
     *     · 老的"偏移 4 次"：描边实心 2761 px
     *     · 新的"膨胀 r 全半径"：6284 px —— 粗了一倍多 ✓
     *   原因是几何上不一样：偏移只往**四个方向**各长一份，
     *   膨胀是**整个圆盘**往外长，同样的半径覆盖面积大得多 ✓
     *   → 半径取一半，两种做法的视觉粗细才基本对齐（量完在 3000 px 上下 ✓）
     *   `ceil` 保留：位图字被缩放得厉害，宁可多半个像素也别少 ✓ */
    const rGlyph = outline > 0
      ? Math.max(1, Math.ceil(outline / Math.max(scale, 0.001) / 2 - 0.001))
      : 0;
    this._run(ctx, s, x - total / 2, top, scale, color, rGlyph, strokeColor);
  }

  /** 一格里逐字贴（penX 是左端 ✓）
   *  r > 0 时先垫一层膨胀出来的描边 ✓ */
  _run(ctx, text, penX, lineTop, scale, color, r, strokeColor) {
    let px = penX;
    for (const ch of text) {
      const g = this.glyph(ch.codePointAt(0));
      if (g) {
        if (r > 0) {
          /* 描边层比字形大一圈：往外扩 r 个字形像素 ✓ 所以绘制原点也要往左上挪 r ✓ */
          ctx.drawImage(this._outlineFor(g, strokeColor, r),
            px + (g.xoff - r) * scale, lineTop + (g.yoff - r) * scale,
            (g.w + r * 2) * scale, (g.h + r * 2) * scale);
        }
        ctx.drawImage(this._canvasFor(g, color), px + g.xoff * scale, lineTop + g.yoff * scale,
          g.w * scale, g.h * scale);
      }
      px += (g ? g.adv : this.meta.size * 0.5) * scale;
    }
  }

  /**
   * 描边层：把字形 alpha **向外膨胀 r 个像素**，再染成描边色 ✓
   * 膨胀 = 每个像素取周围 (2r+1)² 个邻域里 alpha 的最大值 ✓
   * （通俗说：只要附近有笔画，这一格就算"有墨"，于是整体往外长出一圈 ✓）
   */
  _outlineFor(g, color, r) {
    if (!this._outlineCache) this._outlineCache = new Map();
    let m = this._outlineCache.get(g);
    const key = color + '|' + r;
    if (m && m.has(key)) return m.get(key);

    const W = g.w + r * 2, H = g.h + r * 2;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(W, H);
    const d = img.data, src = g.rgba;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        /* 邻域取最大 alpha —— 注意坐标要减 r 换回字形自己的格子里 ✓ */
        let best = 0;
        const y0 = y - r, x0 = x - r;
        for (let dy = -r; dy <= r && best < 255; dy++) {
          const sy = y0 + dy;
          if (sy < 0 || sy >= g.h) continue;
          const row = sy * g.w;
          for (let dx = -r; dx <= r; dx++) {
            const sx = x0 + dx;
            if (sx < 0 || sx >= g.w) continue;
            const a = src[(row + sx) * 4 + 3];
            if (a > best) best = a;
          }
        }
        const i = (y * W + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        /* ⚠ 描边要**实心** ✗（2026-10-20 ✓ 用户："描边变细一半"）
         *   只取邻域最大 alpha 的话，外圈那半像素还是字形的抗锯齿灰 ✓
         *   看着就比原来那套"偏移重画"细一截 ✓
         *   → 乘个增益再夹到 255，让外圈一样实 ✓ 同时保留一点羽化不扎眼 ✓ */
        d[i + 3] = best <= 0 ? 0 : Math.min(255, Math.round(best * 2.2));
      }
    }
    c2.putImageData(img, 0, 0);
    c2.globalCompositeOperation = 'source-in';
    c2.fillStyle = color;
    c2.fillRect(0, 0, W, H);

    if (!m) { m = new Map(); this._outlineCache.set(g, m); }
    m.set(key, cv);
    return cv;
  }

  /** 把一块字形数据染成目标色、铸成 canvas（按 字形+颜色 缓存 ✓）*/
  _canvasFor(g, color) {
    if (!this._tintCache) this._tintCache = new Map();
    let m = this._tintCache.get(g);
    if (m && m.has(color)) return m.get(color);
    const cv = document.createElement('canvas');
    cv.width = g.w; cv.height = g.h;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(g.w, g.h);
    const d = img.data, src = g.rgba;
    for (let i = 0; i < g.w * g.h; i++) {
      d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255;
      d[i * 4 + 3] = src[i * 4 + 3];
    }
    c2.putImageData(img, 0, 0);
    c2.globalCompositeOperation = 'source-in';
    c2.fillStyle = color;
    c2.fillRect(0, 0, cv.width, cv.height);
    if (!m) { m = new Map(); this._tintCache.set(g, m); }
    m.set(color, cv);
    return cv;
  }
}

/**
 * 把一段字按位图画出来 —— **纯数据版**，不碰 canvas ✓
 *
 * 给自检用：能核对"每个字落在哪、前进多少"，不用造 canvas ✓
 * 真渲染走 `BitmapFont.draw`（那个才有 canvas ✓），但两者的排版口径是同一套 ✓
 *
 * @returns {Array<{cp:number,x:number,y:number,w:number,h:number}>} 每个字的落点
 */
export function layoutRun(bf, text, size) {
  const s = String(text || '');
  const scale = size / bf.lineHeight;
  const total = bf.measure(s, size);
  const lineH = bf.lineHeight * scale;
  let px = -total / 2;                    // 相对中心 ✓
  const top = -lineH / 2;
  const out = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const g = bf.glyph(cp);
    if (g) {
      out.push({
        cp,
        x: px + g.xoff * scale,
        y: top + g.yoff * scale,
        w: g.w * scale,
        h: g.h * scale,
      });
    }
    px += (g ? g.adv : bf.meta.size * 0.5) * scale;
  }
  return out;
}
