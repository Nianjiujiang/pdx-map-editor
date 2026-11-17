/**
 * 数据装载。
 *
 * 三种数据来源：
 *   * 本地服务：从 /data/ 读取文件；
 *   * 单文件版（双击 HTML 直接打开）：数据内嵌在页面中，
 *     位于 window.__CK3_EMBEDDED__，此处解析取出；
 *   * 导入的地图包（存于 IndexedDB，见 packstore.js）：
 *     包内文件与 data_xxx/ 同名同格式，解码逻辑无需区分来源。
 *
 * 二进制由 Python 侧预先压缩，这里用 DecompressionStream 直接解，
 * 省去数百 MB 的中间数据。
 */

import { getFileBytes } from './packstore.js';

//: 数据目录。启动时选定一张地图，默认第一张
export let DATA = '/data';

export function setDataDir(dir) {
  DATA = dir;
  /* 三个来源互斥：切到目录模式时必须同时清空内嵌数据与地图包，
     否则单文件版读到的仍是内嵌那份（轻量版则为空）。 */
  EMB_MAP = null;
  PACK = null;
}

//: 单文件版会塞进这个全局变量（形状 `{maps:{…}}`）；走服务时它是 undefined
const EMB = (typeof window !== 'undefined') ? window.__CK3_EMBEDDED__ : null;
//: 内嵌的那几张（轻量版是空对象）
const EMB_MAPS = (EMB && EMB.maps) ? EMB.maps : null;

/*: 单文件版默认选中的那套（boot 会随即用 setEmbeddedMap 切换成选定的那张）。
    空对象也是真值：轻量版的内嵌数据为 `{maps:{}}`，若误判为"有内嵌数据"，
    每次取字节都会去解一份空数据，最终抛出 atob 的
    "The string to be decoded is not correctly encoded"。
    因此必须确认确实存在 map。 */
let EMB_MAP = (EMB_MAPS && Object.keys(EMB_MAPS).length) ? (EMB_MAPS.vanilla || null) : null;

export function setEmbeddedMap(key) {
  if (!EMB || !EMB.maps) return false;
  const m = EMB.maps[key];
  if (!m) return false;
  EMB_MAP = m;
  PACK = null;
  return true;
}

/* ============================================================================
 * 第三种来源：导入进来的地图包
 *
 * 包内文件与 data_xxx/ 同名同格式，这里只多一层取字节的路径，
 * 解压与解析仍复用同一套代码。
 *
 * 三个来源必须互斥，否则无法确定读到的是哪一份数据
 * （setDataDir / setEmbeddedMap / setPackMap 互相清空对方）。
 * ========================================================================== */

//: 当前选中的实例键（即库中记录的键，见 packstore.js）；null 表示走内嵌或服务器
//: 不是作者填写的 manifest.id：同一个包可导入多份，每份是一张独立的图
let PACK = null;

/** 切到"导入的某一份图"（参数是实例键） */
export function setPackMap(key) {
  PACK = key ? String(key) : null;
  if (PACK) EMB_MAP = null;      // 包优先：内嵌数据让位
}

/** 现在读的是不是导入的包 */
export function isPackMap() { return !!PACK; }

/** 包里的某个文件（原始字节，没解压） */
async function packBytes(name) {
  const bytes = await getFileBytes(PACK, name);
  if (!bytes) throw new Error(`地图包「${PACK}」里读不到 ${name}（存储可能被清了，重新导入一次）`);
  return bytes;
}

async function packJson(name) {
  return JSON.parse(new TextDecoder('utf-8').decode(await packBytes(name)));
}

/**
 * .bin 文件的原始字节（zlib 压缩，未解压）：三个来源共用同一路径
 * @param {string} name    文件名
 * @param {string} embKey  内嵌版里对应的字段名
 */
async function rawBytes(name, embKey, onProgress) {
  if (PACK) return packBytes(name);
  if (EMB_MAP) return b64ToBytes(EMB_MAP[embKey]);
  return fetchBytes(`${DATA}/${name}`, onProgress);
}

/** 单文件版里内嵌了哪几套地图（走服务时返回空） */
export function embeddedMapKeys() {
  if (!EMB || !EMB.maps) return [];
  return Object.keys(EMB.maps);
}

/**
 * 单文件版里另一张地图的 meta（不切换当前图，只取其 countryTags）
 *
 * 跨剧本搜国家只读取该图的 meta，不涉及其地图数据。
 * 服务模式不走这里，直接 fetch 对应地图的 meta.json（见 app.js 的 _xgLoad）
 */
export function embeddedMeta(key) {
  const m = EMB_MAP_OF(key);
  return m ? (m.meta || null) : null;
}
function EMB_MAP_OF(key) {
  if (!EMB || !EMB.maps) return null;
  return EMB.maps[key] || null;
}

export const isEmbedded = () => !!EMB;

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** 带进度回调的二进制下载 */
async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/*: base64 → 原始字节（内嵌版及 meta 中拍平的数据均使用） */
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function decompress(bytes, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('这个浏览器版本过旧，无法解压地图包，请更新到较新的 Chrome / Edge / Firefox。');
  }
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const api = {
  async meta() {
    if (PACK) {
      /* stashKey 固定按这一份实例计算：
         涂色暂存按 mapKeyOf(meta) 区分是哪一张图（见 app.js），
         本键优先级高于按尺寸拼接的键。
         同一个包可导入多份（导入只增不改），因此键必须落到实例上：
         两份同名图各自独立；meta 中自带的 stashKey 也不会覆盖此键，
         否则会与原版共用一份涂色数据，两张图互相污染。
         设置与最近颜色不使用此键，它们按 `meta.game` 区分
         （同款游戏共用一份，见 app.js 的 prefsKeyOf）*/
      const m = await packJson('meta.json');
      return Object.assign({}, m, { stashKey: 'pack:' + PACK });
    }
    return EMB_MAP ? EMB_MAP.meta : getJSON(`${DATA}/meta.json`);
  },

  async titles() {
    if (PACK) return packJson('titles.json');
    if (!EMB_MAP) return getJSON(`${DATA}/titles.json`);
    const buf = await decompress(b64ToBytes(EMB_MAP.titles), 'gzip');
    return JSON.parse(new TextDecoder().decode(buf));
  },

  /** 数据目录里是否存在 tiles.json（原尺寸数据分块，无需下载整张 id 图） */
  async tileManifest() {
    // 单文件版 / 地图包：数据在本地，file:// 协议下 fetch 必然失败
    if (PACK) {
      try {
        return await packJson('tiles.json');
      } catch (e) {
        return null;                    // 没有分块数据是常态，不是错误
      }
    }
    if (EMB_MAP && EMB_MAP.tiles) return EMB_MAP.tiles.manifest;
    try {
      const res = await fetch(`${DATA}/tiles.json`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  /** 取一块的字节（内嵌 / 地图包优先；服务器模式走网络） */
  async tileBytes(name) {
    if (PACK) return packBytes(`tiles/${name}`);
    if (EMB_MAP && EMB_MAP.tiles && EMB_MAP.tiles.files[name]) {
      return b64ToBytes(EMB_MAP.tiles.files[name]);
    }
    const res = await fetch(`${DATA}/tiles/${name}`);
    if (!res.ok) throw new Error(`取块失败 ${name}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },

  async provinceIds(onProgress) {
    const raw = await rawBytes('provinces_id.bin', 'provinces', onProgress);
    const buf = await decompress(raw, 'deflate');
    return new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  },

  /** (省份, 层级) → 头衔序号，Uint16Array */
  async titlemap() {
    const raw = await rawBytes('titlemap.bin', 'titlemap', null);
    const buf = await decompress(raw, 'deflate');
    return new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  },

  /** 省份邻接表（CSR：n+1 个 uint32 偏移 + uint16 邻居），原始字节 */
  async adjacency() {
    const raw = await rawBytes('adjacency.bin', 'adjacency', null);
    return decompress(raw, 'deflate');
  },

  /** 各省质心和像素数（每 3 个 float 一组），切连通色块用 */
  async provPos() {
    const raw = await rawBytes('prov_pos.bin', 'provPos', null);
    const buf = await decompress(raw, 'deflate');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  },
};
