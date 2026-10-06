/**
 * 数据装载。
 *
 * 两种模式：
 *   * 走本地服务时，从 /data/ 拉文件；
 *   * 单文件版（双击 HTML 直接开）时，数据已经内嵌在页面里，
 *     放在 window.__CK3_EMBEDDED__，这里解出来就行。
 *
 * 二进制都是 Python 那边压过的，用 DecompressionStream 直接解，
 * 省掉几百 MB 的中间态。
 */

//: 数据目录。启动时由玩家选一张，默认第一张
export let DATA = '/data';

export function setDataDir(dir) {
  DATA = dir;
}

//: 单文件版会塞进这个全局变量；走服务时它是 undefined
const EMB = (typeof window !== 'undefined') ? window.__CK3_EMBEDDED__ : null;

//: 单文件版选中的那套内嵌数据（setDataDir 时同步）
let EMB_MAP = EMB ? (EMB.vanilla || EMB) : null;

export function setEmbeddedMap(key) {
  if (!EMB || !EMB.maps) return false;
  const m = EMB.maps[key];
  if (!m) return false;
  EMB_MAP = m;
  return true;
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
    return EMB_MAP ? EMB_MAP.meta : getJSON(`${DATA}/meta.json`);
  },

  async titles() {
    if (!EMB_MAP) return getJSON(`${DATA}/titles.json`);
    const buf = await decompress(b64ToBytes(EMB_MAP.titles), 'gzip');
    return JSON.parse(new TextDecoder().decode(buf));
  },

  /** 9216×4608 的省份 id 图，解出来是 Uint16Array */
  /** 数据目录里有 tiles.json 吗（原尺寸那套是分块的，就不用下整张 id 图了 ✗） */
  async tileManifest() {
    // 单文件版：数据是内嵌的，fetch 在 file:// 下必然失败 ✗
    if (EMB_MAP && EMB_MAP.tiles) return EMB_MAP.tiles.manifest;
    try {
      const res = await fetch(`${DATA}/tiles.json`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  /** 取一块的字节（内嵌优先；服务器模式走网络） */
  async tileBytes(name) {
    if (EMB_MAP && EMB_MAP.tiles && EMB_MAP.tiles.files[name]) {
      return b64ToBytes(EMB_MAP.tiles.files[name]);
    }
    const res = await fetch(`${DATA}/tiles/${name}`);
    if (!res.ok) throw new Error(`取块失败 ${name}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },

  async provinceIds(onProgress) {
    const raw = EMB_MAP
      ? b64ToBytes(EMB_MAP.provinces)
      : await fetchBytes(`${DATA}/provinces_id.bin`, onProgress);
    const buf = await decompress(raw, 'deflate');
    return new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  },

  /** (省份, 层级) → 头衔序号，Uint16Array */
  async titlemap() {
    const raw = EMB_MAP
      ? b64ToBytes(EMB_MAP.titlemap)
      : await fetchBytes(`${DATA}/titlemap.bin`, null);
    const buf = await decompress(raw, 'deflate');
    return new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  },

  /** 省份邻接表（CSR：n+1 个 uint32 偏移 + uint16 邻居），原始字节 */
  async adjacency() {
    const raw = EMB_MAP
      ? b64ToBytes(EMB_MAP.adjacency)
      : await fetchBytes(`${DATA}/adjacency.bin`, null);
    return decompress(raw, 'deflate');
  },

  /** 各省质心和像素数（每 3 个 float 一组），切连通色块用 */
  async provPos() {
    const raw = EMB_MAP
      ? b64ToBytes(EMB_MAP.provPos)
      : await fetchBytes(`${DATA}/prov_pos.bin`, null);
    const buf = await decompress(raw, 'deflate');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  },
};
