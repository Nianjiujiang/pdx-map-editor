/**
 * 24 位 BMP 编码。
 *
 * 仅 EU4 导出路径使用：EU4 的省份颜色不存于文本文件，而由 ``map/provinces.bmp``
 * 本身表达（颜色即省份身份，与 definition.csv 对齐），因此需要按当前涂色
 * 重写一份省份图。
 *
 * EU4 原图为 5632×2048、24 位、自下而上存放，本模块输出格式与之相同，
 * 可直接覆盖进 mod。
 */

/**
 * @param {Uint8Array} rgb  长度 w*h*3，自上而下、逐行 RGB
 * @param {number} w
 * @param {number} h
 * @returns {Uint8Array} BMP 字节
 */
export function encodeBMP24(rgb, w, h) {
  const raw = w * 3;
  const pad = (4 - (raw % 4)) % 4;
  const row = raw + pad;
  const size = 54 + row * h;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);

  out[0] = 0x42;                       // 'B'
  out[1] = 0x4D;                       // 'M'
  dv.setUint32(2, size, true);         // 文件大小
  dv.setUint32(10, 54, true);          // 像素数据偏移
  dv.setUint32(14, 40, true);          // BITMAPINFOHEADER
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);            // 正数 = 自下而上，与 EU4 原图一致
  dv.setUint16(26, 1, true);           // planes
  dv.setUint16(28, 24, true);          // 位深
  dv.setUint32(30, 0, true);           // 不压缩
  dv.setUint32(34, row * h, true);     // 像素数据字节数

  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 3;   // 写第 y 行 = 读倒数第 y 行
    let d = 54 + y * row;
    for (let x = 0; x < w; x++) {
      const s = src + x * 3;
      out[d++] = rgb[s + 2];           // BMP 是 BGR
      out[d++] = rgb[s + 1];
      out[d++] = rgb[s];
    }
  }
  return out;
}
