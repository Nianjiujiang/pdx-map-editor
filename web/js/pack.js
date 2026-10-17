/**
 * 地图包（.pdxmap）的校验 —— 导入前把陌生人给的东西查一遍。
 *
 * 分工（见 docs/导入式地图-策划.md 第 3.2 节）：
 *   · ``zip.js`` 的 readZip：只管**结构**（是不是 zip、有没有加密 / zip64 / 重名 / 越界）
 *   · 这里：管**内容**（认不认识这些文件、哈希对不对、数字自不自洽）
 *   · **只负责拒绝，绝不修数据** ✓ —— 缺什么就说什么缺，不替作者猜、不补齐
 *
 * 三条贯穿全篇的原则：
 *   ① 每一步都要给人话：**哪个文件、哪儿不对、应该是什么**，
 *      别只说"校验失败"（作者拿着这句话没法改 ✗）
 *   ② 大文件一律**流式**过，边读边数、边算哈希 ✓
 *      EU5 原尺寸那张图，光省份图解压后 268 MB，整块摊进内存手机上必崩 ✗
 *   ③ 先看**声明值**（中央目录里的 size）把明显过大的挡在门外，
 *      再在流里数**实际值** —— 声明可以撒谎，实际数出来的不会 ✓
 */

/** 包格式名，写在 manifest.format 里 */
export const PACK_FORMAT = 'pdxmap';

/** 包格式版本（zip 内的布局）。比它高的包要求玩家更新编辑器 */
export const PACK_FORMAT_VERSION = 1;

/** 缓存数据结构的版本范围。build_*.py 改结构就 +1，两端一起改 */
export const PACK_SCHEMA_MIN = 1;
export const PACK_SCHEMA_MAX = 1;

/** 包必须属于这六个游戏之一（术语 / 层级 / 导出格式全走那个游戏的现成设定）
 *  ⚠ 跟 `pack_map.py` 的 `GAMES` **必须一起改** ✗ —— 那边放行这边拒收就是
 *    "自己打的包自己导不进来"（CK2 是 2026-10-15 加的，两头同时加） */
export const PACK_GAMES = ['ck2', 'ck3', 'eu4', 'hoi4', 'vic3', 'eu5'];

/** 必需文件：和 data_xxx/ 里同名同格式，编辑器一个字节都不用改 */
export const PACK_REQUIRED = [
  'manifest.json', 'meta.json', 'titles.json',
  'provinces_id.bin', 'titlemap.bin', 'adjacency.bin', 'prov_pos.bin',
];

/** 上限：压缩包本身 / 单个文件解压后 / 全部解压后 / 条目数 */
export const PACK_MAX_BYTES = 300 * 1024 * 1024;
export const PACK_MAX_FILE = 512 * 1024 * 1024;
export const PACK_MAX_TOTAL = 1024 * 1024 * 1024;
export const PACK_MAX_ENTRIES = 500;

/** 字段长度上限（**超了拒绝，不截断**） */
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

/** 地图尺寸上限（宽高各自）—— 再大就不是给人看的图了，纯属拿内存开玩笑 */
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

/** 这个条目名是地图包允许的吗（认不认识） */
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
 * 为什么不用 ``crypto.subtle.digest``：它只能**整块**吃（要一个完整 ArrayBuffer），
 * EU5 原尺寸那包光省份图就 268 MB ✗；而且 ``file://`` 双击打开时
 * （非安全上下文）有些浏览器根本没有 crypto.subtle ✗。
 * 自带这份不到 60 行的流式实现，两个问题一起没了 ✓
 *
 * 实现就是标准 SHA-256。**别改成"看着差不多"的写法** ——
 * 它错了不会报错，只会安静地算出另一个哈希值，然后所有包都"哈希不对" ✗
 * （tools/check_pack.js 里有 FIPS 的测试向量盯着）
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
    this.total = 0;             // 一共吃了多少字节（用 Number，2^53 够大了）
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

  /** 收尾出十六进制（调完别再 update 了） */
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

/** 顺手给别处用（导入时算整包哈希、测试里比向量） */
export async function sha256Hex(blobOrBytes) {
  const s = new Sha256();
  if (blobOrBytes instanceof Uint8Array) {
    s.update(blobOrBytes);
  } else {
    const reader = blobOrBytes.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      s.update(value);
    }
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
 * 查 manifest.json。返回清好的 manifest（未知字段原样留着，给 v1.x 留余地 ✓）
 */
export async function readManifest(zip) {
  if (!zip.has('manifest.json')) fail('包里没有 manifest.json —— 这不像是地图包', 'manifest.json');
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
 * 流式过一条，边读边喂回调。
 *
 * ⚠ **.bin 是两层压**：zip 一层（外面），里面还有一层 zlib（`78 9c` 开头）。
 * 数据目录里那些 `.bin` 本来就是 zlib 压的，包只是把它们装进了 zip ✓
 * 所以这一条要揭两层 —— 少揭一层的话，读出来的是 zlib 字节流，
 * 长度公式会全部对不上（EU5 那种光省份图就差 268 MB）✗
 * （编辑器真正取数据时也是两层：包 → zlib → u16，见 data.js 的 decompress ✓）
 *
 * 两个回调分的是**不同层**，别弄混：
 *   · onLayer1(chunk) 第一层（zip 里那份）—— 进度 + **算哈希**（manifest.files 就是按这份算的）
 *   · onChunk(chunk)  第二层（zlib 解完）—— 长度 / 内容范围检查
 * @returns {Promise<number>} 第二层解完有多少字节（= 真正的数据长度）
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
    const { done, value } = await reader.read();
    if (done) break;
    raw += value.length;
    if (raw > cap) {
      try { await reader.cancel(); } catch (err) { /* 取消失败无所谓，反正要抛了 */ }
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

/** 预览图的魔数：只认 JPEG / PNG / WebP（**不看扩展名**，也不收 SVG）✓ */
function imageKind(head) {
  if (head.length >= 3 && head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'jpeg';
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return 'png';
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
      && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'webp';
  return null;
}

/* ---------------------------------------------------------------- 主入口 */

/**
 * 把一个 zip 当地图包查一遍。**通过就返回解好的数据，不通过就抛 PackError**。
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

  // ---- 3. 先按声明值挡一道（炸弹最便宜的防线：看它自己说有多大）
  /* ⚠ e.size 是**第一层**（zip 解完）的大小。.bin 里面还有一层 zlib，
     所以这一道只是"荒唐值"的粗筛；真正卡死的是后面流式数出来的第二层字节 ✓ */
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
  // 必需的下标数组：编辑器会直接按下标取；width/length 不对会读到 undefined 而**不报错** ✗
  // （labels.js 里 `titles.area || titles.provCount.map(...)` 就是没护栏的那一处）
  for (const k of ['keys', 'tiers', 'parents', 'names', 'colors', 'provCount']) {
    if (!Array.isArray(titles[k])) fail(`titles.json 里缺 ${k}（编辑器会直接按下标取）`, 'titles.json');
    if (titles[k].length !== N) {
      fail(`titles.json 的 ${k} 有 ${titles[k].length} 项，应该和 numTitles 一样是 ${N} 项`, 'titles.json');
    }
  }
  // 可选字段：**有就必须等长**（没有是允许的，编辑器都有兜底 ✓）
  // ⚠ `angle` / `path` 是**旧缓存遗留**的兼容字段（2026-10-13 加的倾斜/折线系统 ✓，
  //   2026-10-15 整体退役 ✗ 构建侧已不再产出 ✓ 前端也不再读 ✓）
  //   旧包里有 → 继续照"等长"校验：万一长度不对照样报出来，别默默放过 ✓
  //   （当年 `angle` 那次真的闹到"整包导不进来"：patch_wasteland 追加节点时漏加了它 ✓）
  // ⚠ `seaNames` 这类不在这儿 ✗ 它们挂在 `meta` 上（是字典，不是等长数组 ✓）
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
  // locKeys 只在 EU5 那种数据里有，实测**允许比 numTitles 少**（差 2 条），所以只查不超 ✗
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
    /* 先查"清单和包里的文件对不对得上"，再查几何 ——
       顺序反过来的话，一个多写的幽灵条目会报成"块数不对"，
       而作者需要看到的是**哪个文件名**没对上 ✗（这条踩过） */
    const listed = new Set(tileManifest.files.map((f) => `tiles/${f.name}`));
    for (const n of listed) if (!zip.has(n)) fail(`tiles.json 里列了 ${n}，包里没有`, n);
    for (const e of zip.entries) {
      if (e.name.indexOf('tiles/') === 0 && !listed.has(e.name)) {
        fail(`包里的 ${e.name} 没写进 tiles.json`, e.name);
      }
    }
    /* 几何自洽（tilemap.js 是按 cols/rows 找块、按 tileW/tileH 定位的 ✓）：
       这几条对不上，表现是"有些块永远加载不出来 / 画到错的地方"——
       比报错难查得多，所以在导入时就说清楚 ✗ */
    const tw = tileManifest.tileW, th = tileManifest.tileH;
    const cols = tileManifest.cols, rows = tileManifest.rows;
    if (!(tw > 0) || !(th > 0) || !(cols > 0) || !(rows > 0)) {
      fail(`tiles.json 的 tileW/tileH/cols/rows 得是正整数（现在是 ${tw}/${th}/${cols}/${rows}）`, 'tiles.json');
    }
    if (cols * rows !== tileManifest.files.length) {
      fail(`tiles.json 说有 ${cols}×${rows} = ${cols * rows} 块，但只列了 ${tileManifest.files.length} 块`, 'tiles.json');
    }
    if (tw * cols !== W || th * rows !== H) {
      // 只报**对不上的那一维**（对的那维也写上去，作者会以为自己看错了 ✗）
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

  // ---- 8. 大文件：**一趟走完**（长度 + 哈希 + 内容范围一次过）
  /* 每个 .bin 解压一遍是几百 MB 的开销，所以哈希和内容检查挤在同一趟里 ✓
     （分两趟 = 白解压一遍，EU5 原尺寸那包要多花好几秒 ✗） */
  const wantHash = (manifest.files && typeof manifest.files === 'object') ? manifest.files : null;
  if (!wantHash) note('这个包没给 manifest.files，跳过 sha256 核对');
  const hashed = {};

  if (wantHash) {
    // 小文件在别处已经读过/读过一遍了，这里补上它们的哈希 ✓
    hashed['meta.json'] = new Sha256().update(metaBytes).hex();
    hashed['titles.json'] = new Sha256().update(titleBytes).hex();
    if (zip.has('tiles.json')) {
      hashed['tiles.json'] = new Sha256().update(tileBytes).hex();
    }
    if (zip.has('preview.jpg')) {
      hashed['preview.jpg'] = new Sha256().update(await smallBytes(zip, 'preview.jpg')).hex();
    }
  }

  // 分块的地图，每块的期望解压长度从 tiles.json 拿（tilemap.js 加载时也按这个查 ✓）
  const tileWant = {};
  if (tileManifest) {
    for (const f of tileManifest.files) tileWant[`tiles/${f.name}`] = f.w * f.h * 2;
  }

  const dataEntries = zip.entries.filter((e) => e.name !== 'manifest.json'
    && e.name !== 'meta.json' && e.name !== 'titles.json'
    && e.name !== 'tiles.json' && e.name !== 'preview.jpg');

  // 进度按"声明解压总量"铺在 16% ~ 96% 这一段上（声明值可以撒谎，所以只用来画进度）
  let rawSum = 0;
  for (const e of dataEntries) rawSum += e.size || 0;
  let rawDone = 0;
  let rawTotal = 0;
  let lastPct = -1;

  // 半截 u16 的暂存（块边界不保证落在偶数位上）
  let provTail = new Uint8Array(0);
  let tmTail = new Uint8Array(0);
  let badProv = -1;
  let badTid = -1;

  for (const e of dataEntries) {
    const isProv = e.name === 'provinces_id.bin';
    const isTm = e.name === 'titlemap.bin';
    const hasher = wantHash ? new Sha256() : null;

    const len = await scan(zip, e, PACK_MAX_FILE, (bytes) => {
      if (isProv || isTm) {
        // 上一块剩的半个 u16 接回来再看（不然会读出一堆错位的值 ✗）
        const prev = isProv ? provTail : tmTail;
        const buf = prev.length ? cat(prev, bytes) : bytes;
        let end = buf.length;
        const rest = (end & 1) ? buf.slice(end - 1) : new Uint8Array(0);
        if (isProv) provTail = rest; else tmTail = rest;
        if (end & 1) end -= 1;
        for (let i = 0; i < end; i += 2) {
          const v = buf[i] | (buf[i + 1] << 8);
          if (isProv) {
            // 省份号 >= numProvinces：一半是手改坏的，一半是版本对不上 —— 两种都得在导入时说清楚 ✓
            if (v >= P && badProv < 0) badProv = v;
          } else if (v >= N && v !== NO_TITLE && badTid < 0) {
            badTid = v;
          }
        }
      }
    }, (chunk) => {
      // 第一层（zip 里那份）：哈希的口径就是它 ——
      // manifest.files 记的是"包里那个文件"的 sha256，不是解压之后的省份图 ✓
      if (hasher) hasher.update(chunk);
      rawDone += chunk.length;
      // 进度**按整数百分比节流** ✓ —— 268 MB 是几千个 chunk，
      // 每个 chunk 都去改一次界面就是自己把自己卡死 ✗
      if (rawSum) {
        const pct = Math.floor(16 + 80 * Math.min(1, rawDone / rawSum));
        if (pct !== lastPct) { lastPct = pct; say(`校验 ${e.name}…`, pct); }
      }
    });
    rawTotal += len;                      // 第二层：真正解出来的量，用来卡总上限
    if (hasher) hashed[e.name] = hasher.hex();

    // 长度公式：跟 pack_map.py 的 check_data_dir 是同一套，改一边必须改另一边
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

  // ---- 9. 哈希核对（放在最后：内容先自洽了，再谈"是不是原来那份"）
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
    // 有哈希就必须列全 —— 不然"改个没列进去的文件"就绕过了这道 ✓
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

/** 把两段接起来（u16 跨块用；只在块边界上发生，几字节的事） */
function cat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
