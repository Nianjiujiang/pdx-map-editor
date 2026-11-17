/**
 * 极简 ZIP 打包与读取。
 *
 * ``makeZip`` 为 store 模式（不压缩），用于 CK3 等仅数 KB 的文本 mod；
 * 该函数是同步的，单文件版（file:// 直接打开）也可导出，无需后端接口。
 *
 * ``makeZipAsync`` 额外使用 deflate-raw，用于 EU4 等需包含 34 MB
 * provinces.bmp 的 mod。压缩依赖浏览器内置的 CompressionStream，不引入外部库。
 *
 * 下半部分为**读取**（``readZip``）：用于导入地图包（.pdxmap）。
 * 只信任**中央目录**，按需解压单个条目，不将整包读入内存
 * —— EU5 原尺寸地图的省份图仅解压后即 268 MB。
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
 * 将一组「条目」拼成一个 zip（本地头 + 数据 + 中央目录 + 结尾记录）。
 *
 * store 与 deflate 两条路径**只有方法号和体积两个数值不同**，
 * 布局完全一致，因此只保留一份拼装逻辑，两个入口均调用此函数。
 *
 * @param {Array<{name: Uint8Array, data: Uint8Array, body: Uint8Array,
 *                method: number, crc: number}>} items
 *        data = 原始字节（中央目录记录"解压后大小"）
 *        body = 实际写入的字节（store 时即 data，deflate 时为压缩后数据）
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

/** 文件名 / 内容统一转为字节（字符串按 UTF-8 编码） */
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

/** deflate-raw；浏览器不支持时返回 null，调用方回退到 store */
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
 * 带压缩的版本（小文件仍走 store —— 压缩后反而更大）。
 *
 * @param {Array<{name: string, data: string|Uint8Array}>} files
 * @param {(msg: string) => void} [onStep] 进度回调，用于报告大文件的处理进度
 * @returns {Promise<Uint8Array>} zip 字节
 */
export async function makeZipAsync(files, onStep) {
  const items = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (onStep) onStep(`打包 ${i + 1}/${files.length}：${f.name}`);
    const data = asBytes(f.data);
    // 小于 4KB 的数据压缩后反而更大（deflate 头部即有数十字节），直接 store
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
 * 四项约束，用于防止外部包造成破坏：
 *
 *   ① **只信任中央目录** —— 本地头中的长度字段可能不可靠，中央目录是唯一权威；
 *      本地头仅用于定位数据起点，并核对签名（签名不符说明偏移损坏，立即拒绝）
 *   ② **单条目按需解压** —— 整包读入内存易受"压缩炸弹"攻击；
 *      调用方通过 stream() 分块读取，读多少算多少
 *   ③ **未知格式一律拒绝** —— 加密 / zip64 / 分卷 / 未支持的压缩方式
 *      一律报错，不做猜测（猜测错误会表现为图像渲染异常，难以排查）
 *   ④ **重名条目直接拒绝** —— 两个同名条目且仅校验其中一个的哈希，
 *      会形成"校验通过但使用另一份"的漏洞
 *
 * CRC 不在此处校验：导入端按 manifest 的 sha256 逐项核对（防篡改的主要手段），
 * 再次计算 CRC 只会重复消耗 CPU（EU5 原尺寸包解压量达 540 MB）
 * ========================================================================== */

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

//: 尾部最多检查 64 KB + 22 字节：EOCD 注释字段最长为 65535
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
    this.size = o.size;                 // 解压后大小（**声明值**，不可信，仅用于进度估算）
    this.compressedSize = o.compressedSize;
    this.offset = o.offset;             // 本地头在文件里的位置
  }
  get stored() { return this.method === 0; }
}

/**
 * 只读 zip。**不要直接 new**，请使用 readZip(blob)。
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
      throw new Error('这个浏览器版本过旧，无法解压地图包，请更新到较新的 Chrome / Edge / Firefox。');
    }
    // 本地头的 name/extra 长度**可能与中央目录不同**，需重新读取
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

  /** 读取完整条目。指定 maxBytes 时边读边计数，超限立即中止（防压缩炸弹） */
  async bytes(name, maxBytes) {
    const out = [];
    let got = 0;
    const reader = (await this.stream(name)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (maxBytes && got > maxBytes) {
        try { await reader.cancel(); } catch (err) { /* 取消失败可忽略（随后即抛出） */ }
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
    try { await reader.cancel(); } catch (err) { /* 取消失败可忽略 */ }
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
 * 读取一个 zip（Blob / File 均可）。
 *
 * 分卷、zip64、加密、未知压缩方式**在此处即拒绝** —— 校验器只检查内容是否正确，
 * 结构性错误不应交由该层判断。
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
    throw new Error('地图包使用了暂不支持的 zip64 格式，请换用常规方式重新打包');
  }
  /* **结尾记录必须恰好结束于文件末尾**：
   *   注释字段位于 zip 的最后，因此 EOCD 之后只应为注释，随后即 EOF。
   *   若只判断"不超过"，**注释中伪造的签名**也会被当作真实记录
   *   （从尾部倒序扫描会首先命中该签名，随后按伪造的中央目录读取，轻则报错，重则读取错误位置）。
   *   反之，真实 EOCD 加注释恰好占满尾部时等式成立，不影响正常包。 */
  if (at + 22 + commentLen !== tail.length) {
    throw new Error('地图包不完整（结尾记录后面还有多余数据，文件可能被传坏或截断）');
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
      throw new Error('地图包包含暂不支持的 zip64 条目');
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
