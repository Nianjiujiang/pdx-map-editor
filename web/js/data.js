/**
 * 数据装载。
 *
 * 三种模式：
 *   * 走本地服务时，从 /data/ 拉文件；
 *   * 单文件版（双击 HTML 直接开）时，数据已经内嵌在页面里，
 *     放在 window.__CK3_EMBEDDED__，这里解出来就行；
 *   * **导入进来的地图包**（存在 IndexedDB 里，见 packstore.js）——
 *     包里放的就是 data_xxx/ 里那些文件，所以解码逻辑一个字都不用改 ✓
 *
 * 二进制都是 Python 那边压过的，用 DecompressionStream 直接解，
 * 省掉几百 MB 的中间态。
 */

import { getFile } from './packstore.js';

//: 数据目录。启动时由玩家选一张，默认第一张
export let DATA = '/data';

export function setDataDir(dir) {
  DATA = dir;
  /* 三个来源互斥（见下面那段说明）—— 走目录就得把内嵌那份和包都让开 ✗
     原来这里只清了 PACK，没清 EMB_MAP：单文件版里调一次 setDataDir，
     读到的还是**内嵌**那份（全量版）或者干脆是空的（轻量版）✓ */
  EMB_MAP = null;
  PACK = null;
}

//: 单文件版会塞进这个全局变量（形状 `{maps:{…}}`）；走服务时它是 undefined
const EMB = (typeof window !== 'undefined') ? window.__CK3_EMBEDDED__ : null;
//: 内嵌的那几张（轻量版是空对象）
const EMB_MAPS = (EMB && EMB.maps) ? EMB.maps : null;

/*: 单文件版默认选中的那套（boot 会立刻用 setEmbeddedMap 换成玩家选的那张）
    ⚠ **空对象也是真值** ✗ —— 轻量版（2026-10-12 起默认）里 `{maps:{}}` 长这样，
    要是当成"有内嵌数据"，每次取字节都会去解一份空数据，
    报出来是 atob 的 "The string to be decoded is not correctly encoded" ✓
    所以这里必须判"真有 map"才算数 ✓ */
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
 * 包里的文件跟 data_xxx/ 里同名同格式（见 docs/导入式地图-策划.md）✓
 * 所以这里**只多一层"取字节"的路**，解压和解析全走原来那两行 ✓
 *
 * 三个来源必须互斥：两边都"有数据"的话，读到的是哪一份就说不清了 ✗
 * （所以 setDataDir / setEmbeddedMap / setPackMap 互相把对方清掉）
 * ========================================================================== */

//: 当前选中的**实例键**（= 库里那条记录的键，见 packstore.js）；null = 走内嵌或服务器
//: ⚠ 不是作者写的 manifest.id ✗ —— 同一个包可以导入好几份，各自是一张独立的图 ✓
let PACK = null;

/** 切到"导入的某一份图"（参数是实例键） */
export function setPackMap(key) {
  PACK = key ? String(key) : null;
  if (PACK) EMB_MAP = null;      // 包优先：内嵌那份让开 ✓
}

/** 现在读的是不是导入的包 */
export function isPackMap() { return !!PACK; }

/** 包里的某个文件（原始字节，没解压） */
async function packBytes(name) {
  const blob = await getFile(PACK, name);
  if (!blob) throw new Error(`地图包「${PACK}」里读不到 ${name}（存储可能被清了，重新导入一次）`);
  return new Uint8Array(await blob.arrayBuffer());
}

async function packJson(name) {
  return JSON.parse(new TextDecoder('utf-8').decode(await packBytes(name)));
}

/**
 * .bin 那几份的原始字节（**zlib 压过的**，还没解压）：三个来源走同一条路 ✓
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

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function decompress(bytes, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('这个浏览器不支持 DecompressionStream，请用较新的 Chrome / Edge / Firefox。');
  }
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const api = {
  async meta() {
    if (PACK) {
      /* stashKey 一律按**这一份**定死 ✓ ——
         **涂色暂存**按 mapKeyOf(meta) 分"哪一张图"存（见 app.js），
         而这个 key 的优先级高于"按尺寸拼"的那个。
         一个包可以导入好几份（导入只增不改），所以键必须落到**实例**上：
         两份同名图各涂各的 ✓；作者在 meta 里随手填个 stashKey 也抢不走这个键 ✓
         包里的 meta 是作者写的，让他填一个就跟原版共用一份涂色、两张图互相涂花 ✗
         ⚠ **设置 / 最近颜色不看这个键** ✗ —— 它们按 `meta.game` 分
         （同款游戏共用一份，见 app.js 的 prefsKeyOf ✓）*/
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

  /** 9216×4608 的省份 id 图，解出来是 Uint16Array */
  /** 数据目录里有 tiles.json 吗（原尺寸那套是分块的，就不用下整张 id 图了 ✗） */
  async tileManifest() {
    // 单文件版 / 地图包：数据在本地，fetch 在 file:// 下必然失败 ✗
    if (PACK) {
      try {
        return await packJson('tiles.json');
      } catch (e) {
        return null;                    // 没分块的包是常态，不是错误 ✓
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
