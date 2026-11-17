/**
 * 地图包（.pdxmap）的校验：导入前检查外部来源的包内容。
 *
 * 分工：
 *   · ``zip.js`` 的 readZip：只校验**结构**（是否 zip、是否加密 / zip64 / 重名 / 越界）
 *   · 本模块：校验**内容**（文件是否认识、哈希是否匹配、数值是否自洽）
 *   · **只拒绝，不修改数据** —— 缺什么就报告什么，不猜测、不补齐
 *
 * 三条原则：
 *   ① 错误信息须指明**哪个文件、哪里不对、期望是什么**，
 *      不能只报告"校验失败"（作者无法据此修正）
 *   ② 大文件一律**流式**处理，边读边计数、边计算哈希
 *      EU5 原尺寸地图的省份图仅解压后即 268 MB，整块读入内存会导致移动端崩溃
 *   ③ 先用**声明值**（中央目录中的 size）拦截明显过大的条目，
 *      再在流中统计**实际值** —— 声明值可能不准确，实际统计值可靠
 */

/** 包格式名，写在 manifest.format 里 */
export const PACK_FORMAT = 'pdxmap';

/** 包格式版本（zip 内的布局）。高于此版本的包要求更新编辑器 */
export const PACK_FORMAT_VERSION = 1;

/** 缓存数据结构的版本范围。build_*.py 改结构就 +1，两端一起改 */
export const PACK_SCHEMA_MIN = 1;
export const PACK_SCHEMA_MAX = 1;

/** 包必须属于下列游戏之一（术语 / 层级 / 导出格式沿用该游戏的现有设定）
 *  必须与 `pack_map.py` 的 `GAMES` **同步修改** —— 两侧不一致会导致
 *  自行打包的文件无法导入 */
export const PACK_GAMES = ['ck3', 'eu4', 'hoi4', 'vic3', 'eu5'];

/** 必需文件：与 data_xxx/ 中同名同格式，编辑器无需改动即可读取 */
export const PACK_REQUIRED = [
  'manifest.json', 'meta.json', 'titles.json',
  'provinces_id.bin', 'titlemap.bin', 'adjacency.bin', 'prov_pos.bin',
];

/** 上限：压缩包本身 / 单个文件解压后 / 全部解压后 / 条目数 */
export const PACK_MAX_BYTES = 300 * 1024 * 1024;
export const PACK_MAX_FILE = 512 * 1024 * 1024;
export const PACK_MAX_TOTAL = 1024 * 1024 * 1024;
export const PACK_MAX_ENTRIES = 500;

/** 字段长度上限（**超限即拒绝，不截断**） */
export const PACK_LIMITS = {
  id: 64, label: 40, note: 80, version: 32,
  author: 40, license: 200, description: 1000, homepage: 300,
};

/** 各个小文件读进内存的上限（大文件不走这条路） */
const CAP = {
  'manifest.json': 256 * 1024,
  'meta.json': 8 * 1024 * 1024,
  'titles.json': 64 * 1024 * 1024,
  'tiles.json': 256 * 1024,
  'preview.jpg': 2 * 1024 * 1024,
};

/** id 的规矩：小写字母数字和 . _ -，3~64 位，首字符是字母或数字 */
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

/** 地图尺寸上限（宽高各自）；超过此尺寸的图不具可用性，且会占用过多内存 */
const MAX_SIDE = 32768;

/** 校验失败。message 是给人看的，file 指出问题在哪个文件 */
export class PackError extends Error {
  constructor(msg, file) {
    super(msg);
    this.name = 'PackError';
    this.file = file || '';
  }
}

function fail(msg, file) {
  throw new PackError(msg, file);
}

/** 判断条目名是否为地图包允许的文件 */
export function isKnownPackFile(name) {
  if (PACK_REQUIRED.indexOf(name) >= 0) return true;
  if (name === 'tiles.json' || name === 'preview.jpg') return true;
  if (name.indexOf('tiles/') === 0) {
    const rest = name.slice(6);
    return rest.length > 0 && rest.indexOf('/') < 0;
  }
  return false;
}

/* ---------------------------------------------------------------- 流式 SHA-256
 *
 * 不使用 ``crypto.subtle.digest``：该方法只能**整块**处理（需要完整 ArrayBuffer），
 * EU5 原尺寸包的省份图即 268 MB；且在 ``file://`` 直接打开
 * （非安全上下文）时，部分浏览器没有 crypto.subtle。
 * 因此内置这份流式实现，同时解决上述两个问题。
 *
 * 实现为标准 SHA-256。**不可改为近似实现** ——
 * 此类错误不会抛异常，只会静默算出不同的哈希值，导致所有包都报"哈希不对"
 * （tools/check_pack.js 中有 FIPS 测试向量）
 */
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.buf = new Uint8Array(64);
    this.n = 0;                 // buf 里攒了几个字节
    this.total = 0;             // 已累计处理的字节数（Number 可表示到 2^53，足够）
    this.w = new Uint32Array(64);
  }

  update(bytes) {
    this.total += bytes.length;
    let i = 0;
    if (this.n > 0) {
      while (i < bytes.length && this.n < 64) this.buf[this.n++] = bytes[i++];
      if (this.n === 64) { this._block(this.buf, 0); this.n = 0; }
    }
    while (i + 64 <= bytes.length) { this._block(bytes, i); i += 64; }
    while (i < bytes.length) this.buf[this.n++] = bytes[i++];
    return this;
  }

  _block(src, off) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const o = off + i * 4;
      w[i] = ((src[o] << 24) | (src[o + 1] << 16) | (src[o + 2] << 8) | src[o + 3]) | 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3];
    let e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    this.h[0] = (this.h[0] + a) | 0;
    this.h[1] = (this.h[1] + b) | 0;
    this.h[2] = (this.h[2] + c) | 0;
    this.h[3] = (this.h[3] + d) | 0;
    this.h[4] = (this.h[4] + e) | 0;
    this.h[5] = (this.h[5] + f) | 0;
    this.h[6] = (this.h[6] + g) | 0;
    this.h[7] = (this.h[7] + h) | 0;
  }

  /** 输出十六进制摘要（调用后不应再 update） */
  hex() {
    const bits = this.total * 8;
    const pad = new Uint8Array(this.n < 56 ? 64 : 128);
    pad.set(this.buf.subarray(0, this.n));
    pad[this.n] = 0x80;
    const dv = new DataView(pad.buffer);
    // 长度是 64 位大端：高 32 位 + 低 32 位
    dv.setUint32(pad.length - 8, Math.floor(bits / 4294967296), false);
    dv.setUint32(pad.length - 4, bits >>> 0, false);
    this._block(pad, 0);
    if (pad.length === 128) this._block(pad, 64);
    let out = '';
    for (let i = 0; i < 8; i++) out += (this.h[i] >>> 0).toString(16).padStart(8, '0');
    return out;
  }
}

/** 计算 SHA-256：**优先使用原生实现**（快一个数量级：约 3ms/MB 对约 100ms/MB）
 *
 *  原生 `crypto.subtle.digest` 只能**整块**处理，仅在数据量可控处使用：
 *    导入校验传入的是**包内那一层**的原始字节（十余 MB 以内），不含解压后的省份图
 *  `file://` 直接打开时部分浏览器没有 `crypto.subtle`，此时回退到上方的流式实现；
 *    两种实现的输出必须完全一致（check_pack 中使用 FIPS 向量分别校验）
 *  原生实现**失败时同样回退**：部分环境中 subtle 存在但 digest 会抛异常（策略限制）
 */
async function sha256Chunks(chunks, total) {
  let subtle = null;
  try { subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle) || null; } catch (e) { subtle = null; }
  if (subtle && typeof subtle.digest === 'function') {
    try {
      let buf;
      if (chunks.length === 1) {
        buf = chunks[0];
      } else {
        buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
      }
      const dig = new Uint8Array(await subtle.digest('SHA-256', buf));
      let out = '';
      for (let i = 0; i < dig.length; i++) out += dig[i].toString(16).padStart(2, '0');
      return out;
    } catch (e) { /* 回退 */ }
  }
  const h = new Sha256();
  for (const c of chunks) h.update(c);
  return h.hex();
}

/** 供其他模块使用（导入时计算整包哈希、测试中比对向量） */
export async function sha256Hex(blobOrBytes) {
  if (blobOrBytes instanceof Uint8Array) {
    return sha256Chunks([blobOrBytes], blobOrBytes.length);
  }
  const size = Number(blobOrBytes.size) || 0;
  // 大 Blob 不要整块读入，改走流式实现（调用方传入的通常较小，此分支为兜底）
  if (size <= 16 * 1024 * 1024) {
    const buf = new Uint8Array(await blobOrBytes.arrayBuffer());
    return sha256Chunks([buf], buf.length);
  }
  const s = new Sha256();
  const reader = blobOrBytes.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    s.update(value);
  }
  return s.hex();
}

/* ---------------------------------------------------------------- 字段校验 */

function wantStr(v, field, limit, required) {
  if (v === undefined || v === null) {
    if (required) fail(`manifest 里缺 ${field}`);
    return '';
  }
  if (typeof v !== 'string') fail(`manifest 的 ${field} 得是字符串`);
  if (required && !v.length) fail(`manifest 的 ${field} 不能是空的`);
  if (v.length > limit) fail(`manifest 的 ${field} 太长（${v.length} > ${limit} 字）`);
  return v;
}

function wantPosInt(v, field) {
  if (!Number.isInteger(v) || v <= 0) fail(`manifest 的 ${field} 得是正整数（现在是 ${JSON.stringify(v)}）`);
  return v;
}

/**
 * 校验 manifest.json，返回整理后的 manifest（未知字段原样保留，兼容 v1.x）
 */
export async function readManifest(zip) {
  if (!zip.has('manifest.json')) fail('缺少 manifest.json，不是有效的地图包', 'manifest.json');
  let m;
  try {
    m = await zip.json('manifest.json', CAP['manifest.json']);
  } catch (e) {
    fail(`manifest.json 读不了：${e.message}`, 'manifest.json');
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('manifest.json 得是一个对象', 'manifest.json');

  if (m.format !== PACK_FORMAT) {
    fail(`manifest 的 format 是 ${JSON.stringify(m.format)}，得是 "${PACK_FORMAT}"`, 'manifest.json');
  }
  if (!Number.isInteger(m.formatVersion) || m.formatVersion < 1) {
    fail('manifest 的 formatVersion 得是正整数', 'manifest.json');
  }
  if (m.formatVersion > PACK_FORMAT_VERSION) {
    fail(`这个包用的是新版格式（v${m.formatVersion}），请更新编辑器`, 'manifest.json');
  }
  if (!Number.isInteger(m.dataSchema)) fail('manifest 的 dataSchema 得是整数', 'manifest.json');
  if (m.dataSchema > PACK_SCHEMA_MAX) {
    fail(`这个包的 dataSchema 更新（v${m.dataSchema}），请更新编辑器`, 'manifest.json');
  }
  if (m.dataSchema < PACK_SCHEMA_MIN) {
    fail(`这个包的 dataSchema 太旧（v${m.dataSchema}），请让作者重新打包`, 'manifest.json');
  }

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    fail('manifest 的 id 不合法（要小写字母数字和 . _ -，3~64 位）', 'manifest.json');
  }
  if (PACK_GAMES.indexOf(m.game) < 0) {
    fail(`manifest 的 game 是 ${JSON.stringify(m.game)}，只能是 ${PACK_GAMES.join(' / ')}`, 'manifest.json');
  }
  wantStr(m.label, 'label', PACK_LIMITS.label, true);
  wantStr(m.note, 'note', PACK_LIMITS.note, false);
  wantStr(m.version, 'version', PACK_LIMITS.version, false);
  wantStr(m.author, 'author', PACK_LIMITS.author, false);
  wantStr(m.license, 'license', PACK_LIMITS.license, false);
  wantStr(m.homepage, 'homepage', PACK_LIMITS.homepage, false);
  wantStr(m.description, 'description', PACK_LIMITS.description, false);

  if (!m.stats || typeof m.stats !== 'object') fail('manifest 里缺 stats', 'manifest.json');
  for (const k of ['numProvinces', 'numTitles', 'mapWidth', 'mapHeight']) {
    wantPosInt(m.stats[k], `stats.${k}`);
  }

  if (m.files !== undefined) {
    if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) {
      fail('manifest 的 files 得是一个「文件名 → sha256」的对象', 'manifest.json');
    }
    for (const k of Object.keys(m.files)) {
      if (!HEX64_RE.test(String(m.files[k]))) {
        fail(`manifest 里 ${k} 的 sha256 不是 64 位小写十六进制`, 'manifest.json');
      }
    }
  }
  return m;
}

/* ---------------------------------------------------------------- 大文件扫描 */

/**
 * 流式读取一个条目，边读边回调。
 *
 * **.bin 为双层压缩**：外层 zip，内层 zlib（以 `78 9c` 开头）。
 * 数据目录中的 `.bin` 本身即为 zlib 压缩，包只是将其装入 zip。
 * 因此该函数需解两层；只解一层会得到 zlib 字节流，
 * 所有长度公式均不成立（EU5 的省份图相差 268 MB）。
 * （编辑器读取数据时同样为两层：包 → zlib → u16，见 data.js 的 decompress）
 *
 * 两个回调作用于**不同层**：
 *   · onLayer1(chunk) 第一层（zip 内数据）—— 进度 + **计算哈希**（manifest.files 按此层计算）
 *   · onChunk(chunk)  第二层（zlib 解压后）—— 长度 / 内容范围检查
 * @returns {Promise<number>} 第二层解压后的字节数（即真实数据长度）
 */
async function scan(zip, e, cap, onChunk, onLayer1) {
  const inner = e.name.slice(-4) === '.bin';
  const layer1 = (await zip.stream(e.name)).pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      if (onLayer1) onLayer1(chunk);
      ctrl.enqueue(chunk);
    },
  }));
  const reader = (inner ? layer1.pipeThrough(new DecompressionStream('deflate')) : layer1).getReader();

  let raw = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (err) {
      /* 解压流出错（文件被修改或传输不完整）—— 底层抛出的是英文信息，
         部分环境仅有空的 TypeError，直接展示无法说明问题。 */
      try { await reader.cancel(); } catch (e2) { /* 取消失败可忽略（随后即抛出） */ }
      fail(`「${e.name}」解压失败（文件坏了或者没传完）`, e.name);
    }
    const { done, value } = step;
    if (done) break;
    raw += value.length;
    if (raw > cap) {
      try { await reader.cancel(); } catch (err) { /* 取消失败可忽略（随后即抛出） */ }
      fail(`「${e.name}」解压后超过上限（${Math.floor(cap / 1048576)} MB）`, e.name);
    }
    if (onChunk) onChunk(value);
  }
  return raw;
}

/** 小文件整块读（带上限） */
async function smallBytes(zip, name) {
  const e = zip.info(name);
  const cap = CAP[name] || (8 * 1024 * 1024);
  if (e && e.size > cap) fail(`「${name}」超过上限（${Math.floor(cap / 1024)} KB）`, name);
  try {
    return await zip.bytes(name, cap);
  } catch (err) {
    fail(`「${name}」读不了：${err.message}`, name);
  }
}

/** 预览图魔数：仅接受 JPEG / PNG / WebP（**不依据扩展名**，不接受 SVG） */
function imageKind(head) {
  if (head.length >= 3 && head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'jpeg';
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return 'png';
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
      && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'webp';
  return null;
}

/* ---------------------------------------------------------------- 主入口 */

/**
 * 将 zip 作为地图包校验。**通过则返回解析后的数据，不通过则抛出 PackError**。
 *
 * @param {ZipFile} zip     readZip() 的结果
 * @param {object} [opts]
 * @param {(msg: string, pct: number) => void} [opts.onProgress]
 * @param {(msg: string) => void} [opts.onNote]      提示（比如"没给 manifest.files，跳过哈希核对"）
 * @returns {Promise<{manifest: object, meta: object, raw: object}>}
 */
export async function validatePack(zip, opts = {}) {
  const say = (msg, pct) => { if (opts.onProgress) opts.onProgress(msg, pct || 0); };
  const note = (msg) => { if (opts.onNote) opts.onNote(msg); };

  // ---- 0. 包的体积和条目
  if (zip.blob && zip.blob.size > PACK_MAX_BYTES) {
    fail(`这个包有 ${Math.round(zip.blob.size / 1048576)} MB，超过上限 ${PACK_MAX_BYTES / 1048576} MB`);
  }
  const names = zip.entries.map((e) => e.name);
  if (names.length > PACK_MAX_ENTRIES) fail(`包里条目太多（${names.length} > ${PACK_MAX_ENTRIES}）`);
  for (const n of names) {
    if (!isKnownPackFile(n)) fail(`包里有个地图包不该有的文件「${n}」`, n);
  }

  // ---- 1. manifest
  say('读清单…', 2);
  const manifest = await readManifest(zip);

  // ---- 2. 必需文件齐全
  for (const n of PACK_REQUIRED) {
    if (!zip.has(n)) fail(`包里缺「${n}」`, n);
  }

  // ---- 3. 先按声明值拦截（以声明尺寸作为第一道防线）
  /* e.size 为**第一层**（zip 解压后）的大小；.bin 内部还有一层 zlib，
     因此此处仅粗筛异常值，实际限制由后续流式统计的第二层字节数决定 */
  let declaredTotal = 0;
  for (const e of zip.entries) {
    if (e.name === 'manifest.json') continue;
    if (e.size > PACK_MAX_FILE) {
      fail(`「${e.name}」在包里就声明有 ${Math.round(e.size / 1048576)} MB，超过单文件上限`, e.name);
    }
    declaredTotal += e.size;
  }
  if (declaredTotal > PACK_MAX_TOTAL) {
    fail(`这个包声明的体积合计超过 ${PACK_MAX_TOTAL / 1048576} MB 上限`);
  }

  // ---- 4. meta.json
  say('查元数据…', 8);
  const metaBytes = await smallBytes(zip, 'meta.json');
  let meta;
  try {
    meta = JSON.parse(new TextDecoder('utf-8').decode(metaBytes));
  } catch (e) {
    fail(`meta.json 不是合法 JSON：${e.message}`, 'meta.json');
  }
  if (!meta || typeof meta !== 'object') fail('meta.json 得是一个对象', 'meta.json');
  for (const k of ['numProvinces', 'numTitles', 'mapWidth', 'mapHeight']) {
    if (!Number.isInteger(meta[k]) || meta[k] <= 0) {
      fail(`meta.json 的 ${k} 得是正整数（现在是 ${JSON.stringify(meta[k])}）`, 'meta.json');
    }
  }
  if (meta.mapWidth > MAX_SIDE || meta.mapHeight > MAX_SIDE) {
    fail(`地图像素太大（${meta.mapWidth}×${meta.mapHeight}，单边上限 ${MAX_SIDE}）`, 'meta.json');
  }
  if (meta.game !== manifest.game) {
    fail(`meta.json 说是 ${JSON.stringify(meta.game)}，manifest 说是 ${JSON.stringify(manifest.game)}，对不上`, 'meta.json');
  }
  if (!Array.isArray(meta.tiers) || !meta.tiers.length) fail('meta.json 的 tiers 得是非空数组', 'meta.json');
  for (const k of ['numProvinces', 'numTitles', 'mapWidth', 'mapHeight']) {
    if (meta[k] !== manifest.stats[k]) {
      fail(`meta.json 的 ${k}（${meta[k]}）和 manifest.stats 里的（${manifest.stats[k]}）不一致`, 'meta.json');
    }
  }

  const W = meta.mapWidth, H = meta.mapHeight;
  const P = meta.numProvinces, N = meta.numTitles, T = meta.tiers.length;
  const NO_TITLE = (meta.noTitle === undefined || meta.noTitle === null) ? 65535 : meta.noTitle;

  // ---- 5. titles.json
  say('查头衔表…', 12);
  const titleBytes = await smallBytes(zip, 'titles.json');
  let titles;
  try {
    titles = JSON.parse(new TextDecoder('utf-8').decode(titleBytes));
  } catch (e) {
    fail(`titles.json 不是合法 JSON：${e.message}`, 'titles.json');
  }
  if (!titles || typeof titles !== 'object' || Array.isArray(titles)) {
    fail('titles.json 得是一个对象（里面是一组等长数组）', 'titles.json');
  }
  // 必需的下标数组：编辑器按下标直接读取；长度不符会读到 undefined 而不抛错
  // （labels.js 中 `titles.area || titles.provCount.map(...)` 即缺少保护的一处）
  for (const k of ['keys', 'tiers', 'parents', 'names', 'colors', 'provCount']) {
    if (!Array.isArray(titles[k])) fail(`titles.json 里缺 ${k}（编辑器会直接按下标取）`, 'titles.json');
    if (titles[k].length !== N) {
      fail(`titles.json 的 ${k} 有 ${titles[k].length} 项，应该和 numTitles 一样是 ${N} 项`, 'titles.json');
    }
  }
  // 可选字段：**存在时长度必须一致**（可缺省，编辑器均有兜底）
  // `angle` / `path` 为旧缓存遗留的兼容字段（倾斜 / 折线系统已停用，
  //   构建侧不再产出，前端不再读取）；
  //   旧包中若存在，仍按等长规则校验，长度不符时照常报错，不静默跳过
  //   （`angle` 缺失曾导致整包无法导入：patch_wasteland 追加节点时遗漏该字段）
  // `seaNames` 等字段不在此列，它们位于 `meta` 中（为字典，非等长数组）
  for (const k of ['area', 'blockArea', 'lx', 'ly', 'gx', 'gy', 'hideLabel', 'namesEn', 'angle', 'path']) {
    if (titles[k] === undefined || titles[k] === null) continue;
    if (!Array.isArray(titles[k])) fail(`titles.json 的 ${k} 得是数组`, 'titles.json');
    if (titles[k].length !== N) {
      fail(`titles.json 的 ${k} 有 ${titles[k].length} 项，应该和 numTitles 一样是 ${N} 项`, 'titles.json');
    }
  }
  if (titles.provinceNames) {
    if (!Array.isArray(titles.provinceNames)) fail('titles.json 的 provinceNames 得是数组', 'titles.json');
    if (titles.provinceNames.length !== P) {
      fail(`titles.json 的 provinceNames 有 ${titles.provinceNames.length} 项，应该和 numProvinces 一样是 ${P} 项`, 'titles.json');
    }
  }
  // locKeys 仅部分数据（如 EU5）存在，允许少于 numTitles（实测差 2 条），故只校验不超出
  if (titles.locKeys && Array.isArray(titles.locKeys) && titles.locKeys.length > N) {
    fail(`titles.json 的 locKeys 比 numTitles 还多（${titles.locKeys.length} > ${N}）`, 'titles.json');
  }

  // ---- 6. 预览图（有就认魔数）
  if (zip.has('preview.jpg')) {
    if (zip.info('preview.jpg').size > CAP['preview.jpg']) {
      fail('预览图超过 2 MB', 'preview.jpg');
    }
    const kind = imageKind(await zip.head('preview.jpg', 12));
    if (!kind) fail('预览图不是 JPEG / PNG / WebP（只按文件头判断，改扩展名没用）', 'preview.jpg');
  }

  // ---- 7. tiles.json（有分块的话先读它，后面核瓦片尺寸要用）
  let tileManifest = null;
  let tileBytes = null;
  if (zip.has('tiles.json')) {
    tileBytes = await smallBytes(zip, 'tiles.json');
    try {
      tileManifest = JSON.parse(new TextDecoder('utf-8').decode(tileBytes));
    } catch (e) {
      fail(`tiles.json 不是合法 JSON：${e.message}`, 'tiles.json');
    }
    if (!Array.isArray(tileManifest.files) || !tileManifest.files.length) {
      fail('tiles.json 的 files 得是非空数组', 'tiles.json');
    }
    if (tileManifest.mapW !== W || tileManifest.mapH !== H) {
      fail(`tiles.json 里的图是 ${tileManifest.mapW}×${tileManifest.mapH}，meta.json 说是 ${W}×${H}`, 'tiles.json');
    }
    /* 先校验清单与包内文件是否一致，再校验几何参数 ——
       顺序相反时，多余的条目会被误报为块数不符，
       而实际需要指出的是**哪个文件名**未对上 */
    const listed = new Set(tileManifest.files.map((f) => `tiles/${f.name}`));
    for (const n of listed) if (!zip.has(n)) fail(`tiles.json 里列了 ${n}，包里没有`, n);
    for (const e of zip.entries) {
      if (e.name.indexOf('tiles/') === 0 && !listed.has(e.name)) {
        fail(`包里的 ${e.name} 没写进 tiles.json`, e.name);
      }
    }
    /* 几何自洽（tilemap.js 按 cols/rows 查找块、按 tileW/tileH 定位）：
       参数不符时表现为部分块无法加载或绘制位置错误，
       这类问题排查困难，因此在导入阶段即报错 */
    const tw = tileManifest.tileW, th = tileManifest.tileH;
    const cols = tileManifest.cols, rows = tileManifest.rows;
    if (!(tw > 0) || !(th > 0) || !(cols > 0) || !(rows > 0)) {
      fail(`tiles.json 的 tileW/tileH/cols/rows 得是正整数（现在是 ${tw}/${th}/${cols}/${rows}）`, 'tiles.json');
    }
    if (cols * rows !== tileManifest.files.length) {
      fail(`tiles.json 说有 ${cols}×${rows} = ${cols * rows} 块，但只列了 ${tileManifest.files.length} 块`, 'tiles.json');
    }
    if (tw * cols !== W || th * rows !== H) {
      // 只报告**不匹配的那一维**（写出匹配的维度会误导作者）
      const bad = [];
      if (tw * cols !== W) bad.push(`横向 ${tw}×${cols} = ${tw * cols}（应该是 ${W}）`);
      if (th * rows !== H) bad.push(`纵向 ${th}×${rows} = ${th * rows}（应该是 ${H}）`);
      fail(`tiles.json 的块尺寸凑不出整张图：${bad.join('、')}`, 'tiles.json');
    }
    {
      const seenRC = new Set();
      for (const f of tileManifest.files) {
        const nm = `tiles/${f.name}`;
        if (f.w !== tw || f.h !== th) {
          fail(`tiles.json 里 ${nm} 是 ${f.w}×${f.h}，跟块尺寸 ${tw}×${th} 不一致`, 'tiles.json');
        }
        if (!(f.r >= 0 && f.r < rows && f.c >= 0 && f.c < cols)) {
          fail(`tiles.json 里 ${nm} 的位置 ${f.r},${f.c} 超出了 ${rows}×${cols} 的范围`, 'tiles.json');
        }
        const rc = f.r + ',' + f.c;
        if (seenRC.has(rc)) fail(`tiles.json 里有两块都写着 ${rc}（位置重复）`, 'tiles.json');
        seenRC.add(rc);
      }
    }
  }

  // ---- 8. 大文件：**单趟完成**（长度 + 哈希 + 内容范围一次处理）
  /* 每个 .bin 解压一次即产生数百 MB 开销，因此哈希与内容检查合并为同一趟；
     分两趟会重复解压，EU5 原尺寸包将额外耗时数秒 */
  const wantHash = (manifest.files && typeof manifest.files === 'object') ? manifest.files : null;
  if (!wantHash) note('这个包没给 manifest.files，跳过 sha256 核对');
  const hashed = {};

  if (wantHash) {
    // 小文件已在别处读取，此处补充其哈希
    hashed['meta.json'] = await sha256Chunks([metaBytes], metaBytes.length);
    hashed['titles.json'] = await sha256Chunks([titleBytes], titleBytes.length);
    if (zip.has('tiles.json')) {
      hashed['tiles.json'] = await sha256Chunks([tileBytes], tileBytes.length);
    }
    if (zip.has('preview.jpg')) {
      const _pv = await smallBytes(zip, 'preview.jpg');
      hashed['preview.jpg'] = await sha256Chunks([_pv], _pv.length);
    }
  }

  // 分块地图的每块期望解压长度取自 tiles.json（tilemap.js 加载时按同一规则校验）
  const tileWant = {};
  if (tileManifest) {
    for (const f of tileManifest.files) tileWant[`tiles/${f.name}`] = f.w * f.h * 2;
  }

  const dataEntries = zip.entries.filter((e) => e.name !== 'manifest.json'
    && e.name !== 'meta.json' && e.name !== 'titles.json'
    && e.name !== 'tiles.json' && e.name !== 'preview.jpg');

  // 进度按"声明解压总量"映射到 16% ~ 96% 区间（声明值不可靠，仅用于进度显示）
  let rawSum = 0;
  for (const e of dataEntries) rawSum += e.size || 0;
  let rawDone = 0;
  let rawTotal = 0;
  let lastPct = -1;

  // 跨块半截 u16 的暂存区（块边界不保证落在偶数位）
  let provTail = new Uint8Array(0);
  let tmTail = new Uint8Array(0);
  let badProv = -1;
  let badTid = -1;

  for (const e of dataEntries) {
    const isProv = e.name === 'provinces_id.bin';
    const isTm = e.name === 'titlemap.bin';
    /* 哈希口径 = **包内那一层**的原始字节（十余 MB 以内），先攒齐再一次性计算
       原生实现优先（约 3ms/MB），优于 JS 流式实现（约 100ms/MB）
       攒存的是**拷贝**：分块缓冲区的生命周期不保证延伸到循环之外 */
    const hashChunks = wantHash ? [] : null;

    const len = await scan(zip, e, PACK_MAX_FILE, (bytes) => {
      if (isProv || isTm) {
        // 接续上一块剩余的半个 u16，否则会出现整体错位的读数
        const prev = isProv ? provTail : tmTail;
        const buf = prev.length ? cat(prev, bytes) : bytes;
        let end = buf.length;
        const rest = (end & 1) ? buf.slice(end - 1) : new Uint8Array(0);
        if (isProv) provTail = rest; else tmTail = rest;
        if (end & 1) end -= 1;
        for (let i = 0; i < end; i += 2) {
          const v = buf[i] | (buf[i + 1] << 8);
          if (isProv) {
            // 省份号 >= numProvinces：可能为手工修改错误或版本不匹配，两种情况均需在导入时说明
            if (v >= P && badProv < 0) badProv = v;
          } else if (v >= N && v !== NO_TITLE && badTid < 0) {
            badTid = v;
          }
        }
      }
    }, (chunk) => {
      // 第一层（zip 内数据）：哈希按此层计算 ——
      // manifest.files 记录的是包内文件的 sha256，而非解压后的省份图
      if (hashChunks) hashChunks.push(chunk.slice());
      rawDone += chunk.length;
      // 进度**按整数百分比节流** —— 268 MB 数据包含数千个 chunk，
      // 每个 chunk 均更新界面会造成卡顿
      if (rawSum) {
        const pct = Math.floor(16 + 80 * Math.min(1, rawDone / rawSum));
        if (pct !== lastPct) { lastPct = pct; say(`校验 ${e.name}…`, pct); }
      }
    });
    rawTotal += len;                      // 第二层：真正解出来的量，用来卡总上限
    /* 长度必须使用**第一层**累计的字节数 —— `len` 是解压后的量（可能数百 MB），
       用它拼接缓冲区会导致尾部全为 0，哈希必然不匹配 */
    if (hashChunks) hashed[e.name] = await sha256Chunks(hashChunks,
      hashChunks.reduce((s2, c) => s2 + c.length, 0));

    // 长度公式与 pack_map.py 的 check_data_dir 一致，修改一处必须同步另一处
    if (isProv && len !== W * H * 2) {
      fail(`provinces_id.bin 解压后 ${len} 字节，应该正好是 ${W}×${H}×2 = ${W * H * 2} 字节`, e.name);
    }
    if (isTm && len !== P * T * 2) {
      fail(`titlemap.bin 解压后 ${len} 字节，应该正好是 ${P}×${T}×2 = ${P * T * 2} 字节`, e.name);
    }
    if (e.name === 'prov_pos.bin' && len !== P * 12) {
      fail(`prov_pos.bin 解压后 ${len} 字节，应该正好是 ${P}×3×4 = ${P * 12} 字节`, e.name);
    }
    if (e.name === 'adjacency.bin') {
      const head = (P + 1) * 4;
      if (len < head || (len - head) % 2 !== 0) {
        fail(`adjacency.bin 解压后 ${len} 字节，对不上 CSR 布局（至少 ${head} 字节，余下得是偶数）`, e.name);
      }
    }
    if (tileWant[e.name] !== undefined && len !== tileWant[e.name]) {
      fail(`${e.name} 解压后 ${len} 字节，tiles.json 说它应该是 ${tileWant[e.name]} 字节`, e.name);
    }

    if (rawTotal > PACK_MAX_TOTAL) {
      fail(`这个包解压后超过 ${PACK_MAX_TOTAL / 1048576} MB 上限`);
    }
  }

  if (badProv >= 0) {
    fail(`provinces_id.bin 里有省份号 ${badProv}，但这张图只有 ${P} 个省份（0~${P - 1}）`, 'provinces_id.bin');
  }
  if (badTid >= 0) {
    fail(`titlemap.bin 里有头衔号 ${badTid}，超出了 ${N} 个头衔的范围`, 'titlemap.bin');
  }

  // ---- 9. 哈希核对（置于最后：先确认内容自洽，再确认是否为原始内容）
  if (wantHash) {
    say('核对哈希…', 97);
    const names2 = Object.keys(wantHash);
    for (const n of names2) {
      if (!zip.has(n)) fail(`manifest.files 里写了 ${n}，包里没有`, n);
      if (hashed[n] === undefined) fail(`manifest.files 里写了 ${n}，但校验时没读到它`, n);
      if (hashed[n] !== wantHash[n]) {
        fail(`${n} 的内容和 manifest 里记的 sha256 对不上（这个包被改过或者传坏了）`, n);
      }
    }
    // 存在哈希清单时必须列全，否则未列入的文件可绕过此项校验
    for (const e of zip.entries) {
      if (e.name === 'manifest.json') continue;
      if (wantHash[e.name] === undefined) {
        fail(`manifest.files 里漏了 ${e.name}（有哈希清单就必须列全）`, e.name);
      }
    }
  }

  say('校验通过', 100);
  return { manifest, meta, titles, raw: { rawTotal } };
}

/** 拼接两段字节（用于跨块 u16；仅发生在块边界，长度很小） */
function cat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
