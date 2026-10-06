// ================================================================ 省份 id 图：分块按需加载
//
// 为什么要有这个文件：EU5 的**原尺寸**地图是 16384×8192 ✓ —— 整张 id 图解压成
// Uint16Array 要 268 MB JS 堆 ✗，做成一张 R16UI 纹理又要 268 MB 显存 ✗，
// 而且 16384 正好顶到常见显卡的 MAX_TEXTURE_SIZE ✗。
//
// 所以原尺寸那套数据（`build_eu5.py --scale 1` 产出）会**切成 4×4 张 4096×2048** ✓，
// 前端只下"当前视野盖到的那几块" ✓ —— 每块解压后 16.8 MB ✓，同时最多留几块 ✓。
//
// 半尺寸那套（8192×4096）**不受影响** ✓：它还是走一整张 provinces_id.bin，
// 只有当数据目录里有 tiles.json 时才启用分块。

/** 分块 id 图的读取器：只按需取块，带一个很小的 LRU 缓存。 */
export class TileMap {
  /**
   * @param {string} base      数据目录（如 /data_eu5_full）
   * @param {object} manifest  tiles.json 的内容
   * @param {(u8: Uint8Array) => Uint8Array} inflate  解压函数（zlib）
   * @param {number} cacheMax  最多缓存几块（默认 8，够盖住一屏）
   */
  constructor(base, manifest, inflate, fetchTile, cacheMax = 8) {
    this.base = base;
    this.m = manifest;
    this.inflate = inflate;
    // fetchTile(name) → Promise<Uint8Array>：内嵌或网络都行（由调用方决定）
    this.fetchTile = fetchTile;
    this.cacheMax = cacheMax;
    this.cache = new Map();          // key "r_c" → Uint16Array
    this.pending = new Map();        // key → Promise（同一块别重复下）
  }

  /** 地图像素 → 块号 */
  tileOf(x, y) {
    return [Math.floor(y / this.m.tileH), Math.floor(x / this.m.tileW)];
  }

  /** 视野矩形（地图像素）盖到的块号列表 */
  tilesInView(view) {
    const [r0, c0] = this.tileOf(Math.max(0, view.x), Math.max(0, view.y));
    const [r1, c1] = this.tileOf(
      Math.min(this.m.mapW - 1, view.x + view.w - 1),
      Math.min(this.m.mapH - 1, view.y + view.h - 1));
    const out = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) out.push([r, c]);
    }
    return out;
  }

  /** 取一块（没有就去下）。返回 Promise<Uint16Array|null> */
  async get(r, c) {
    if (r < 0 || c < 0 || r >= this.m.rows || c >= this.m.cols) return null;
    const key = `${r}_${c}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const entry = this.m.files.find((f) => f.r === r && f.c === c);
    if (!entry) return null;
    const p = (async () => {
      const raw = await this.fetchTile(entry.name);
      const bytes = await this.inflate(raw);   // data.js 的 decompress 是 async 的
      // 小端 u16 数组
      const out = new Uint16Array(bytes.buffer, bytes.byteOffset,
                                 Math.floor(bytes.byteLength / 2)).slice();
      if (out.length !== entry.w * entry.h) {
        throw new Error(`块 ${entry.name} 大小不对：${out.length} ≠ ${entry.w * entry.h}`);
      }
      this.cache.set(key, out);
      this.pending.delete(key);
      // 简单的 FIFO 淘汰（够用：一屏最多几块）
      while (this.cache.size > this.cacheMax) {
        const first = this.cache.keys().next().value;
        if (first === key) break;
        this.cache.delete(first);
      }
      return out;
    })();
    this.pending.set(key, p);
    // 失败的那块要把 pending 清掉，下一帧 get() 才会真正重试 ——
    // 不然永远命中同一个 rejected promise，这块区域就一直渲成 0 号省份。
    p.catch(() => { this.pending.delete(key); });
    return p;
  }

  /** 一个地图像素的值（只在块已经缓存时可用，用于取色/悬停这种临时查询） */
  at(x, y) {
    const [r, c] = this.tileOf(x, y);
    const t = this.cache.get(`${r}_${c}`);
    if (!t) return 0;
    const lx = x - c * this.m.tileW, ly = y - r * this.m.tileH;
    return t[ly * this.m.tileW + lx];
  }

  /** 这个像素所在的块缓存了吗（没缓存时调用方该去 await get） */
  has(x, y) {
    const [r, c] = this.tileOf(x, y);
    return this.cache.has(`${r}_${c}`);
  }
}

/** 数据目录里有没有分块清单 */
export async function loadTileManifest(base) {
  try {
    const res = await fetch(`${base}/tiles.json`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}
