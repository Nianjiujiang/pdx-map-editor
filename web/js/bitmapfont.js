/**
 * 位图字体（BMFont `.fnt` + DDS 字图集）
 *
 * 用途：欧陆风云4 的中文模组全部使用位图字体，不带 TTF。
 *   `gfx/fonts/zh-hans-16.fnt` + `zh-hans-16.dds`：
 *     · `.fnt` = 标准 BMFont 文本格式（每个字在图集内的位置与前进宽度）
 *     · `.dds` = DXT5（BC3）块压缩，尺寸 2048×3840，与 fnt 的 scaleW/scaleH 一致
 *   使用这些模组的字体需自行解码，并按 xadvance 逐字绘制。
 *
 * DXT5 的**字形位于 alpha 通道**（白色字 + 透明底）：
 *   合成时以 alpha 作为墨量、颜色由调用方指定，同一套图集可用于任意颜色。
 *
 * **不整张解码，按字取值**：
 *   `zh-hans-map.dds` 尺寸 6400×8192，整张解成 RGBA 需 **187 MB**；
 *   DXT5 为块压缩，每块可独立解码。
 *   → 使用某个字时只解**覆盖该字图像的块**（一个 16×18 的汉字最多涉及 5×5 个块）
 *   → 每个字铸成一张小 canvas 缓存；内存占用只与**实际用到的字数**有关
 */

/* ================================================================ .fnt */

/** BMFont 一行的 `k=v` 键值对（值可能带引号） */
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
 * 解**一小块矩形**（按需解码的核心）
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

  /* 块压缩：先求出覆盖该矩形的块范围，只解这些块 */
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

/** 整张解码（自测 / 小图集适用；大图集请勿调用，可能占用数百 MB 内存） */
export function decodeDDS(buf) {
  const info = ddsInfo(buf);
  if (!info) return null;
  const r = decodeRect(buf, info, 0, 0, info.width, info.height);
  return r ? { width: r.width, height: r.height, rgba: r.rgba, format: info.format } : null;
}

/** 解码一个 4×4 块 → rgb(16×3) + alpha(16) */
function _decodeBlock(dv, off, format, rgb, alpha) {
  const isDXT5 = format === 'DXT5';
  /* **需支持 DXT3**：
   *   字体库中的「简中地图字体-颜真卿多宝塔碑体」为 **DXT3**
   *   （6400×4800，字形全在 alpha 通道）；若仅实现 DXT1/DXT5，
   *   `ddsInfo` 返回 null，选中该字体会回退到默认字体。
   *
   *   DXT3 = BC2：
   *     前 8 字节 = alpha，**每像素 4 位**（DXT5 为 8 字节插值表）
   *     后 8 字节 = 色块，与 DXT1 相同，但**始终使用四色插值**（无 1 位透明模式）
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

  /* 色块仅作占位：字形完全来自 alpha 通道
   *   （Paradox 的字图集为白字透明底，色块基本为白色）*/
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
      /* 每像素 4 位：低半字节对应偶数号像素；0..15 × 17 映射到 0..255 */
      const byteI = i >> 1;
      const nib = (i & 1) ? ((aNib[byteI] >> 4) & 0xF) : (aNib[byteI] & 0xF);
      alpha[i] = nib * 17;
    } else {
      alpha[i] = (c0 > c1 || ci !== 3) ? 255 : 0;
    }
  }
}

/* ================================================================ 字体对象 */

/** 每个实例一个 uid，贴图缓存据此判断字体是否更换 */
let _FONT_UID = 0;

/**
 * 一套位图字体：`fnt` 元数据 + 图集原始字节 + 已解码的字形
 *
 * 字体**固有尺寸固定**（fnt 中的 lineHeight）；
 *   任意字号均按 `size / lineHeight` 缩放，缩小后会有轻微模糊，
 *   这是位图字体的固有特性，与游戏内显示一致。
 */
export class BitmapFont {
  /**
   * **一个字体可包含多页**：
   *
   *   BMFont 图集有尺寸上限，汉字较多时无法容纳，
   *   因此**同一字体被拆成多对 `.fnt` + `.dds`**。
   *   模组中 CN_mapfont_0 含 4718 个字、CN_mapfont_1 含 2168 个；
   *   仅加载一对会导致另一半字显示为空白（缺字）。
   *
   *   单页签名需继续兼容，两种入参均支持：
   *     数组 = 多页；两个参数 = 单页
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
    /* 兼容字段：meta / dds / info 均指向第一页 */
    const first = this.pages[0];
    this.meta = first ? first.meta : parseFnt('');
    this.dds = first ? first.dds : null;
    this.info = first ? first.info : null;
    this.ok = this.pages.length > 0;
    this.uid = ++_FONT_UID;
    /** 码点 → 小 canvas（按需生成） */
    this._glyphs = new Map();
    this._canvas = null;
  }

  /** 跨页查找字形 */
  _find(cp) {
    for (const pg of this.pages) {
      const g = pg.meta.chars.get(cp);
      if (g) return { pg, g };
    }
    return null;
  }

  /** 显示名（fnt 中的 face） */
  get face() { return this.meta.face || ''; }

  /** 固有行高（用于计算缩放） */
  get lineHeight() { return this.meta.lineHeight || this.meta.size || 16; }

  /** 取一个字的**原始数据**（未缓存时即时解码）
   *  @returns {{w:number,h:number,adv:number,xoff:number,yoff:number,rgba:Uint8ClampedArray}|null}
   *  此方法**不创建 canvas**，仅返回纯数据，可在 Node 中测试；
   *    绘制时由 `_canvasFor` 生成 canvas。 */
  glyph(cp) {
    const hit = this._glyphs.get(cp);
    if (hit !== undefined) return hit;
    const found = this._find(cp);
    const g = found ? found.g : null;
    if (!g || !g.w || !g.h) {
      this._glyphs.set(cp, null);
      return null;
    }
    /* **必须使用该字形所在页的图集**：用第一页解第二页的坐标会得到错乱方块 */
    const r = decodeRect(found.pg.dds, found.pg.info, g.x, g.y, g.w, g.h);
    if (!r) { this._glyphs.set(cp, null); return null; }
    const out = { w: g.w, h: g.h, adv: g.adv, xoff: g.xoff, yoff: g.yoff, rgba: r.rgba };
    this._glyphs.set(cp, out);
    return out;
  }

  /** 一段文字在指定字号下的宽度（CSS px）*/
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
   * 把一段文字画到 ctx 上（**居中**：x 为水平中心、y 为垂直中心，与 fillText 对齐）
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {number} x 中心 x
   * @param {number} y 中心 y
   * @param {number} size 字号（CSS px）
   * @param {string} color
   * @param {{outline?:number,stroke?:string}} [opt] outline = 描边粗细（0 = 不描边）；stroke = 描边颜色
   */
  draw(ctx, text, x, y, size, color, opt) {
    /* 描边半径取整（`_outlineFor` 按整数格膨胀，详见该处说明）*/
    const s = String(text || '');
    if (!s) return;
    const scale = size / this.lineHeight;
    const total = this.measure(s, size);
    const lineH = this.lineHeight * scale;
    const top = y - lineH / 2;
    const outline = Math.max(0, Math.round((opt && opt.outline) || 0));

    /* **描边 = 对 alpha 做膨胀**，而非重复绘制字形：
     *   按偏移 4 个方向各画一遍会在笔画密集处产生**四重重影**，小字号下尤为明显。
     *
     *   改用形态学膨胀：
     *     ① 将字形 alpha 按半径 r **取邻域最大值**（morphological dilate），
     *        得到一圈**实心外扩**，即为描边
     *     ② 以描边色填充该层，铺在字形下方
     *     ③ 再绘制字形本体
     *   膨胀逐像素计算，仅与字形相关 → 按 (字形, 颜色, 半径) 缓存
     *   r 以**字形像素**为单位：屏幕粗细 ÷ 缩放，放大时描边比例不变
     */
    const strokeColor = (opt && opt.stroke) || 'rgba(0, 0, 0, 0.82)';
    /* 半径**减半后向上取整**：
     *   以真实字体实测，相同 `outline = size × 0.09` 参数下
     *     · 偏移 4 次：描边实心面积 2761 px
     *     · 全半径膨胀：6284 px，约粗一倍
     *   原因在于几何差异：偏移只向**四个方向**各扩一份，
     *   膨胀按**整个圆盘**外扩，相同半径覆盖面积更大
     *   → 半径取一半，使两种做法的视觉粗细接近（实测约 3000 px）
     *   `ceil` 保留：位图字体缩放幅度较大，宁可多半个像素
     */
    const rGlyph = this._outlineRadius(scale, outline);
    this._run(ctx, s, x - total / 2, top, scale, color, rGlyph, strokeColor);
  }

  /**
   * **屏幕描边粗细 → 字形像素半径**
   *
   * 该换算必须**集中在一处**：`size × 0.09` 为**屏幕像素**，
   *   而膨胀在**字形像素**上进行；若不除以缩放，
   *   放大 10 倍时半径同样放大 10 倍，字形会变成实心黑块。
   *   `draw()` 与逐字贴（`drawGlyph`）两条路径共用此换算，避免遗漏。
   *
   * 半径**减半后向上取整**（见 `draw()` 中的量测：膨胀比偏移约粗一倍）。
   */
  _outlineRadius(scale, outline) {
    return outline > 0
      ? Math.max(1, Math.ceil(outline / Math.max(scale, 0.001) / 2 - 0.001))
      : 0;
  }

  /** 一行内逐字绘制（penX 为左端）
   *  r > 0 时先绘制膨胀得到的描边层 */
  _run(ctx, text, penX, lineTop, scale, color, r, strokeColor) {
    let px = penX;
    for (const ch of text) {
      const g = this.glyph(ch.codePointAt(0));
      if (g) {
        if (r > 0) {
          /* 描边层比字形大一圈：外扩 r 个字形像素，绘制原点需相应向左上偏移 r */
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
   * 描边层：将字形 alpha **向外膨胀 r 个像素**，再染成描边色
   * 膨胀 = 每个像素取周围 (2r+1)² 邻域内 alpha 的最大值；
   * 即邻域内存在笔画时该像素视为有墨，整体向外扩展一圈。
   */
  _outlineFor(g, color, r) {
    if (!this._outlineCache) this._outlineCache = new Map();
    /* **半径必须先取整**：
     *   调用方传入 `size × 0.09`（小数，如 1.3）；
     *   膨胀采样为 `for (dy = -r; dy <= r; dy++)`，r 为小数时
     *   `sy = y0 + dy` 落在非整数像素上，读取 `src[(row+sx)*4+3]` 得到 undefined，
     *   导致 best 恒为 0、整圈 alpha 为 0，描边不可见。
     *   取整同时使缓存键稳定（1.3 与 1.35 共用同一缓存）。
     */
    const rr = Math.max(1, Math.round(r || 0));
    let m = this._outlineCache.get(g);
    const key = color + '|' + rr;
    if (m && m.has(key)) return m.get(key);

    const W = g.w + rr * 2, H = g.h + rr * 2;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(W, H);
    const d = img.data, src = g.rgba;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        /* 邻域取最大 alpha；坐标需减去 r 换算回字形自身网格 */
        let best = 0;
        const y0 = y - rr, x0 = x - rr;
        for (let dy = -rr; dy <= rr && best < 255; dy++) {
          const sy = y0 + dy;
          if (sy < 0 || sy >= g.h) continue;
          const row = sy * g.w;
          for (let dx = -rr; dx <= rr; dx++) {
            const sx = x0 + dx;
            if (sx < 0 || sx >= g.w) continue;
            const a = src[(row + sx) * 4 + 3];
            if (a > best) best = a;
          }
        }
        const i = (y * W + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        /* 描边需**实心**：
         *   仅取邻域最大 alpha 时，外圈仍是字形的抗锯齿灰阶，视觉上偏细；
         *   → 乘以增益后夹到 255，使外圈实心，同时保留少量羽化。 */
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

  /**
   * **绘制单个字**：以 (x,y) 为中心，按 angle 旋转，用于版图贴合排版
   *
   * `draw()` 按整段横向排列；贴合排版中每个字有独立的位置与转角，
   * 因此单独提供单字绘制入口：字形取自所属图集，
   * 描边复用同一套 alpha 膨胀（`_outlineFor`），外层增加旋转变换。
   */
  drawGlyph(ctx, ch, x, y, size, angle, color, outline, strokeColor) {
    const g = this.glyph(String(ch || '').codePointAt(0));
    if (!g || !g.w || !g.h) return false;
    const scale = size / this.lineHeight;
    /* 描边半径需换算为**字形像素**（见 `_outlineRadius` 的说明；
     *   直接使用屏幕像素会导致放大后字形变成实心黑块）*/
    const r = this._outlineRadius(scale, outline);
    const w = g.w * scale, h = g.h * scale;
    ctx.save();
    ctx.translate(x, y);
    if (angle) ctx.rotate(angle);
    if (r > 0) {
      const ow = (g.w + r * 2) * scale, oh = (g.h + r * 2) * scale;
      ctx.drawImage(this._outlineFor(g, strokeColor || '#000', r), -ow / 2, -oh / 2, ow, oh);
    }
    ctx.drawImage(this._canvasFor(g, color), -w / 2, -h / 2, w, h);
    ctx.restore();
    return true;
  }

  /** 将字形数据染成目标色并生成 canvas（按 字形+颜色 缓存）*/
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
 * 按位图字体计算一段文字的排版 —— **纯数据版**，不创建 canvas
 *
 * 用于自检：核对每个字的落点与前进宽度，无需 Canvas。
 * 实际渲染由 `BitmapFont.draw` 完成，两者使用同一套排版规则。
 *
 * @returns {Array<{cp:number,x:number,y:number,w:number,h:number}>} 每个字的落点
 */
export function layoutRun(bf, text, size) {
  const s = String(text || '');
  const scale = size / bf.lineHeight;
  const total = bf.measure(s, size);
  const lineH = bf.lineHeight * scale;
  let px = -total / 2;                    // 相对中心
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
