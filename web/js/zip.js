/**
 * 极简 ZIP 打包。
 *
 * ``makeZip`` 是 store 模式（不压缩），给 CK3 那种几 KB 的文本 mod 用，
 * 而且是同步的 —— 单文件版（file:// 直接双击）也能导出，不用后端接口。
 *
 * ``makeZipAsync`` 多走一道 deflate-raw，给 EU4 那种要塞一张 34 MB
 * provinces.bmp 的 mod 用。浏览器自带 CompressionStream，不用引库。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const u16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
const u32 = (v) => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF];

/**
 * 把一堆「条目」拼成一个 zip（本地头 + 数据 + 中央目录 + 结尾记录）。
 *
 * store 和 deflate 两条路**只有方法号和体积两个数字不一样** ✓，
 * 布局一模一样 —— 所以这里只写一遍，两个入口都调它 ✓
 * （以前是两份逐行重复的拼装代码 ✗：改一处地址算错就整包打不开，
 *   而两份代码里只改一份是最容易犯的错 ✓）
 *
 * @param {Array<{name: Uint8Array, data: Uint8Array, body: Uint8Array,
 *                method: number, crc: number}>} items
 *        data = 原始字节（中央目录里记"解压后多大"）
 *        body = 真正写进去的字节（store 时就是 data，deflate 时是压过的）
 */
function assembleZip(items) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const it of items) {
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(it.method), ...u16(0), ...u16(0),
      ...u32(it.crc), ...u32(it.body.length), ...u32(it.data.length),
      ...u16(it.name.length), ...u16(0),
    ]);
    parts.push(local, it.name, it.body);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800),
      ...u16(it.method), ...u16(0), ...u16(0),
      ...u32(it.crc), ...u32(it.body.length), ...u32(it.data.length),
      ...u16(it.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset),
    ]), it.name);
    offset += local.length + it.name.length + it.body.length;
  }

  let cdSize = 0;
  for (const c of central) cdSize += c.length;

  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(items.length), ...u16(items.length),
    ...u32(cdSize), ...u32(offset), ...u16(0),
  ]);

  const all = parts.concat(central, [end]);
  const total = all.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

/** 文件名/内容统一成字节（字符串就按 UTF-8 编） */
function asBytes(v) {
  return typeof v === 'string' ? new TextEncoder().encode(v) : v;
}

/**
 * @param {Array<{name: string, data: string|Uint8Array}>} files
 * @returns {Uint8Array} zip 字节
 */
export function makeZip(files) {
  return assembleZip(files.map((f) => {
    const data = asBytes(f.data);
    return { name: asBytes(f.name), data, body: data, method: 0, crc: crc32(data) };
  }));
}

/** deflate-raw；浏览器不支持就返回 null，调用方退回 store */
async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    return null;
  }
}

/**
 * 带压缩的版本（小文件仍然走 store —— 压了反而更大）。
 *
 * @param {Array<{name: string, data: string|Uint8Array}>} files
 * @param {(msg: string) => void} [onStep] 进度回调，大文件时给用户一个交代
 * @returns {Promise<Uint8Array>} zip 字节
 */
export async function makeZipAsync(files, onStep) {
  const items = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (onStep) onStep(`打包 ${i + 1}/${files.length}：${f.name}`);
    const data = asBytes(f.data);
    // 小于 4KB 的东西压了反而更大（deflate 的头就有几十字节）→ 直接 store
    let method = 0;
    let body = data;
    if (data.length >= 4096) {
      const z = await deflateRaw(data);
      if (z && z.length < data.length) { method = 8; body = z; }
    }
    items.push({ name: asBytes(f.name), data, body, method, crc: crc32(data) });
  }
  return assembleZip(items);
}
