/**
 * 极简 ZIP 打包。
 *
 * ``makeZip`` 是 store 模式（不压缩），给 CK3 那种几 KB 的文本 mod 用，
 * 而且是同步的 —— 单文件版（file:// 直接双击）也能导出，不用后端接口。
 *
 * ``makeZipAsync`` 多走一道 deflate-raw，给 EU4 那种要塞一张 34 MB
 * provinces.bmp 的 mod 用。浏览器自带 CompressionStream，不用引库。
 *
 * 下半截是**读**（``readZip``）：导入地图包（.pdxmap）用。
 * 它只信**中央目录**，按需解压单条，不把整包摊进内存 ✗
 * —— EU5 原尺寸那张图解压后光省份图就 268 MB ✓（见 docs/导入式地图-策划.md）
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

/* ============================================================================
 * 读 zip（导入地图包用）
 *
 * 四条硬规矩，都是为了"陌生人给的包不许弄坏我们"：
 *
 *   ① **只信中央目录** ✓ —— 本地头里的长度字段可以是假的，中央目录是唯一权威；
 *      本地头只用来定位数据起点，顺便核对签名（签名不对 = 偏移是坏的，立刻拒）
 *   ② **单条按需解压** ✓ —— 整包进内存是最容易被"压缩炸弹"打死的做法 ✗
 *      调用方拿 stream() 自己一块块读，读到多少算多少
 *   ③ **不认识的一律拒** ✗ —— 加密 / zip64 / 分卷 / 没见过的压缩方式，
 *      宁可报错也不要猜（猜错的表现是"某张图渲染出鬼东西"，比报错难查十倍）
 *   ④ **重名条目直接拒** ✗ —— 两个同名条目 + 我们只查其中一个的 hash，
 *      就是"校验过了但用的是另一份"的经典漏洞
 *
 * CRC 不在这儿验：导入端会按 manifest 的 sha256 逐个核（那才是防篡改的那道），
 * 再算一遍 CRC 纯属白烧一遍 CPU ✗（EU5 原尺寸那包 540 MB 解压量）
 * ========================================================================== */

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

//: 尾部最多看 64 KB + 22：EOCD 的注释字段最长 65535 ✓
const EOCD_TAIL = 65557;

function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
function u32le(b, o) {
  return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
}

async function sliceBytes(blob, off, len) {
  return new Uint8Array(await blob.slice(off, off + len).arrayBuffer());
}

/** 一条条目的静态信息（中央目录里那一行） */
export class ZipEntry {
  constructor(o) {
    this.name = o.name;
    this.method = o.method;
    this.size = o.size;                 // 解压后多大（**声明值**，不信它，只用来算进度）
    this.compressedSize = o.compressedSize;
    this.offset = o.offset;             // 本地头在文件里的位置
  }
  get stored() { return this.method === 0; }
}

/**
 * 一个只读的 zip。**别直接 new**，用 readZip(blob)。
 */
export class ZipFile {
  constructor(blob, list) {
    this.blob = blob;
    this.list = list;
    this.byName = new Map(list.map((e) => [e.name, e]));
  }

  get entries() { return this.list; }
  has(name) { return this.byName.has(name); }
  info(name) { return this.byName.get(name) || null; }

  /** 这条的解压后字节流（ReadableStream）。调用方自己 reader.read() */
  async stream(name) {
    const e = this.byName.get(name);
    if (!e) throw new Error(`包里没有「${name}」`);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('这个浏览器不支持 DecompressionStream，请用较新的 Chrome / Edge / Firefox。');
    }
    // 本地头的 name/extra 长度**可能和中央目录不一样**，所以得现读一遍 ✓
    const head = await sliceBytes(this.blob, e.offset, 30);
    if (head.length < 30 || u32le(head, 0) !== SIG_LOCAL) {
      throw new Error(`「${name}」定位不到数据（这个包坏了）`);
    }
    const start = e.offset + 30 + u16le(head, 26) + u16le(head, 28);
    const end = start + e.compressedSize;
    if (end > this.blob.size) throw new Error(`「${name}」的数据越界（这个包被截断了）`);
    const raw = this.blob.slice(start, end).stream();
    if (e.method === 0) return raw;
    return raw.pipeThrough(new DecompressionStream('deflate-raw'));
  }

  /** 整条读出来。maxBytes 传了就边读边数，超了立刻中止（炸弹防线）✓ */
  async bytes(name, maxBytes) {
    const out = [];
    let got = 0;
    const reader = (await this.stream(name)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (maxBytes && got > maxBytes) {
        try { await reader.cancel(); } catch (err) { /* 取消失败无所谓，反正要抛了 */ }
        throw new Error(`「${name}」超过上限（${maxBytes} 字节）`);
      }
      out.push(value);
    }
    const buf = new Uint8Array(got);
    let p = 0;
    for (const c of out) { buf.set(c, p); p += c.length; }
    return buf;
  }

  async text(name, maxBytes) {
    return new TextDecoder('utf-8').decode(await this.bytes(name, maxBytes));
  }

  async json(name, maxBytes) {
    const t = await this.text(name, maxBytes);
    try {
      return JSON.parse(t);
    } catch (err) {
      throw new Error(`「${name}」不是合法 JSON：${err && err.message ? err.message : err}`);
    }
  }

  /** 只取开头几个字节（认魔数用，比如预览图到底是不是图片） */
  async head(name, n) {
    const reader = (await this.stream(name)).getReader();
    const out = [];
    let got = 0;
    while (got < n) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
      got += value.length;
    }
    try { await reader.cancel(); } catch (err) { /* 同上 */ }
    const buf = new Uint8Array(Math.min(got, n));
    let p = 0;
    for (const c of out) {
      const take = Math.min(c.length, buf.length - p);
      if (take <= 0) break;
      buf.set(c.subarray(0, take), p);
      p += take;
    }
    return buf;
  }
}

/**
 * 读一个 zip（Blob / File 都行）。
 *
 * 分卷、zip64、加密、未知压缩方式**在这里就拒** ✓ —— 校验器只看"内容对不对"，
 * 结构性的坏东西不该漏到那一层去判断。
 *
 * @param {Blob} blob
 * @returns {Promise<ZipFile>}
 */
export async function readZip(blob) {
  const size = blob.size;
  if ((size >>> 0) !== size) throw new Error('这个文件太大了（超过 4 GB），不支持');
  if (size < 22) throw new Error('这不是一个完整的 zip 包（文件太小，可能没传完）');

  // EOCD 从尾巴往回找（后面可能挂着注释）
  const tailLen = Math.min(size, EOCD_TAIL);
  const tail = await sliceBytes(blob, size - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32le(tail, i) === SIG_EOCD) { at = i; break; }
  }
  if (at < 0) throw new Error('这不是一个完整的 zip 包（没找到结尾记录，可能没传完）');

  const diskNum = u16le(tail, at + 4);
  const cdDisk = u16le(tail, at + 6);
  const nDisk = u16le(tail, at + 8);
  const nAll = u16le(tail, at + 10);
  const cdSize = u32le(tail, at + 12);
  const cdOff = u32le(tail, at + 16);
  const commentLen = u16le(tail, at + 20);

  if (diskNum !== 0 || cdDisk !== 0 || nDisk !== nAll) throw new Error('这是分卷 zip，不支持');
  if (nAll === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
    throw new Error('这是 zip64 格式的包，不支持（换个打包工具，别开大文件模式）');
  }
  /* ⚠ **结尾记录必须正好顶到文件末尾** ✗（2026-10-19 变异测试）
   *   注释字段是 zip 的最后一段 ✓ 所以 EOCD 后面只该是注释、然后就是 EOF
   *   只判"不超过"的话，**注释里塞一个假签名**也会被当成真的 ✗
   *   （从尾巴往回扫第一次就扫到它 ✓ 然后按假的中央目录去读 ✓ 轻则报错、重则读到别处）
   *   反过来：真的 EOCD + 注释正好占满尾部 → 这个等式成立 ✓ 不影响任何正常包 ✓ */
  if (at + 22 + commentLen !== tail.length) {
    throw new Error('zip 结尾记录对不上（文件被截断了，或者结尾有假签名）');
  }
  if (cdOff + cdSize > size || cdOff + cdSize < cdOff) throw new Error('zip 中央目录越界（文件被截断了）');

  const cd = await sliceBytes(blob, cdOff, cdSize);
  const list = [];
  const seen = new Set();
  let p = 0;
  while (p + 46 <= cd.length) {
    if (u32le(cd, p) !== SIG_CD) {
      throw new Error(`中央目录第 ${list.length + 1} 条读不动（这个包坏了）`);
    }
    const flags = u16le(cd, p + 8);
    const method = u16le(cd, p + 10);
    const csize = u32le(cd, p + 20);
    const usize = u32le(cd, p + 24);
    const nlen = u16le(cd, p + 28);
    const elen = u16le(cd, p + 30);
    const clen = u16le(cd, p + 32);
    const lho = u32le(cd, p + 42);
    const name = new TextDecoder('utf-8').decode(cd.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;

    if (flags & 0x0001) throw new Error(`「${name}」是加密的，不支持`);
    if (usize === 0xFFFFFFFF || csize === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
      throw new Error('包里有 zip64 条目，不支持');
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`「${name}」用的压缩方式（${method}）不认识，只支持不压缩和 deflate`);
    }
    if (!name) throw new Error('包里有条目的名字是空的');
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      throw new Error(`条目的名字不干净：${name}`);
    }
    if (seen.has(name)) throw new Error(`包里有重名条目「${name}」`);
    seen.add(name);
    if (lho + 30 > size) throw new Error(`「${name}」的位置越界（这个包坏了）`);

    list.push(new ZipEntry({ name, method, size: usize, compressedSize: csize, offset: lho }));
  }
  if (list.length !== nAll) {
    throw new Error(`中央目录条目数（${list.length}）和结尾记录（${nAll}）对不上`);
  }
  return new ZipFile(blob, list);
}
