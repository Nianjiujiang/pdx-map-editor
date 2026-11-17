/**
 * 地图包仓库：导入的图保存在浏览器 IndexedDB 中，刷新或重开页面后仍在。
 *
 * 持久化的必要性：一张地图会被反复打开编辑，
 * 每次进入编辑器都重新选择文件不可接受。
 *
 * 两个 store：
 *   `packs`  key = id      → { manifest, importedAt, size, files: [名字…] }   ← 很小，选图界面只读它
 *   `files`  key = "id/名" → Blob                                            ← 选中某张图后才逐个读取
 * 分开的原因：选图界面要列出十几张图，无需把每张图的省份数据全部读入内存。
 *
 * 三条约束：
 *   ① 导入是一个事务：删旧与写新在同一个 readwrite 事务内完成，
 *      中途关闭页面时，库中只会是旧版或新版，不会出现半个包。
 *      （事务内除 IDB 请求外不 await 其他操作：await 其他任务会让浏览器提前提交事务，
 *        后续写入随之失效。）
 *   ② IndexedDB 不可用时要明确告知：隐私模式或旧浏览器下降级为"仅本次会话有效"，
 *      界面必须写明"刷新会丢"，不得显示为已保存（见 packStoreMode()）。
 *   ③ 字节原样存储：不解压、不重新编码，读出的就是 zip 内的原始字节，
 *      data.js 的两层解压路径与本地文件一致。
 */

/* import 必须写在文件顶部且为静态形式，不能使用动态导入：
   单文件版（build_standalone.py）会把本文件合并为普通脚本，
   合并只识别行首的静态写法，动态导入会原样保留在产物里，
   双击 HTML 以 file:// 打开时该语句必然失败（开发模式下不受影响）。
   tools/check_standalone.js 中有一条断言专门扫描这种写法，注释里同样不能出现该字面形式，
   否则也会被扫出。 */
import { readZip, makeZipAsync } from './zip.js';
import { validatePack } from './pack.js';

//: 库名 / store 名。改名会导致已导入的图全部丢失，不要修改
const PS_DB = 'pdx-map-editor';
//: 版本 2 新增 `saved_maps`（地图仓库）。IndexedDB 升版本只新增 store，
//:   已有的 packs / files 保持不变，已导入的图不受影响
const PS_VER = 2;
const PS_PACKS = 'packs';
const PS_FILES = 'files';
const PS_MAPS = 'saved_maps';

//: 'idb' = 已持久化 / 'memory' = 仅本次会话可用，刷新即失效 / null = 尚未探测
let PS_MODE = null;
let PS_DB_HANDLE = null;

//: 降级模式下的内存仓库（行为与 IndexedDB 一致，仅不跨刷新保存）
const PS_MEM_PACKS = new Map();
const PS_MEM_MAPS = new Map();
const PS_MEM_FILES = new Map();

/** 记录一条日志（日志模块为普通脚本，单文件版同样存在；缺失时跳过） */
function psLog(name, detail) {
  try {
    if (typeof window !== 'undefined' && window.PDXLOG) window.PDXLOG.event(name, detail);
  } catch (e) { /* 日志失败不影响导入 */ }
}

function psFail(msg) {
  return new Error(msg);
}

/** 把 IDB 请求包成 Promise（onerror 也接住） */
function psReq(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || psFail('浏览器本地存储出错'));
  });
}

/**
 * 探一次 IndexedDB 能不能用。
 *   打不开时只对本次调用降级；超时/被占用这类临时原因不记死，
 *   下次调用会再试一次。真正被禁止（隐私模式）才长期降级。
 * @returns {Promise<'idb'|'memory'>}
 */
let PS_OPEN = null;
function psOpen() {
  if (PS_DB_HANDLE) return Promise.resolve(PS_DB_HANDLE);
  if (PS_OPEN) return PS_OPEN;
  PS_OPEN = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      PS_OPEN = null;
      reject(e || psFail('打不开数据库'));
    };
    timer = setTimeout(() => fail(psFail('打开数据库超时')), 8000);
    let req;
    try {
      req = indexedDB.open(PS_DB, PS_VER);
    } catch (e) {
      fail(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PS_PACKS)) db.createObjectStore(PS_PACKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PS_FILES)) db.createObjectStore(PS_FILES);
      if (!db.objectStoreNames.contains(PS_MAPS)) db.createObjectStore(PS_MAPS, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      if (settled) { try { req.result.close(); } catch (e) { /* 迟到的连接直接关掉 */ } return; }
      settled = true;
      if (timer) clearTimeout(timer);
      PS_DB_HANDLE = req.result;
      PS_OPEN = null;
      resolve(PS_DB_HANDLE);
    };
    req.onerror = () => fail(req.error);
    req.onblocked = () => fail(psFail('数据库被其他页签占用'));
  });
  return PS_OPEN;
}

export async function packStoreMode() {
  if (PS_MODE === 'idb' && PS_DB_HANDLE) return 'idb';
  if (typeof indexedDB === 'undefined' || !indexedDB) {
    PS_MODE = 'memory';
    psLog('地图包', '这台浏览器无法长期保存数据，导入的地图只在本次打开期间有效');
    return PS_MODE;
  }
  try {
    await psOpen();
    PS_MODE = 'idb';
  } catch (e) {
    const msg = String((e && e.name) || '') + ' ' + String((e && e.message) || '');
    const hard = /Security|NotAllowed|InvalidState|denied|禁止/i.test(msg);
    PS_MODE = hard ? 'memory' : null;
    psLog('地图包', `IndexedDB 用不了（${e && e.message}）→ 本次会话保存在内存里`);
  }
  return PS_MODE || 'memory';
}

function psDb() {
  if (!PS_DB_HANDLE) throw psFail('本地数据库尚未就绪，请刷新页面后重试');
  return PS_DB_HANDLE;
}

/** 一条文件在库里的键 */
function psFileKey(id, name) {
  return `${id}/${name}`;
}

// ---------------------------------------------------------------- 读

/** 库里有哪些地图包（按导入时间排，新的在后） */
export async function listPacks() {
  const mode = await packStoreMode();
  if (mode === 'memory') {
    return Array.from(PS_MEM_PACKS.values()).sort((a, b) => (a.importedAt || 0) - (b.importedAt || 0));
  }
  const tx = psDb().transaction([PS_PACKS], 'readonly');
  const all = await psReq(tx.objectStore(PS_PACKS).getAll());
  return (all || []).sort((a, b) => (a.importedAt || 0) - (b.importedAt || 0));
}

/** 某个包的那条记录（没有就 null） */
export async function getPack(id) {
  const mode = await packStoreMode();
  if (mode === 'memory') return PS_MEM_PACKS.get(id) || null;
  const tx = psDb().transaction([PS_PACKS], 'readonly');
  const v = await psReq(tx.objectStore(PS_PACKS).get(id));
  return v || null;
}

/** 库中记录 → Blob（调用方只接受 Blob）
 *
 *  库中存的是 ArrayBuffer（见 putPack：Safari 写入 Blob 会失败），
 *  这里统一包装回 Blob，`data.js` 与导出备份的调用方式无需改动。
 *  同时兼容 Blob / Uint8Array：旧版本写入的是 Blob，
 *  升级后已导入的图仍需可读。*/
function _asBlob(v) {
  if (!v) return null;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
  return new Blob([v]);
}

/** 取包内某个文件的字节（Blob）。按需读取，选图界面不要批量调用 */
export async function getFile(id, name) {
  const mode = await packStoreMode();
  const key = psFileKey(id, name);
  if (mode === 'memory') return _asBlob(PS_MEM_FILES.get(key));
  const tx = psDb().transaction([PS_FILES], 'readonly');
  const v = await psReq(tx.objectStore(PS_FILES).get(key));
  return _asBlob(v);
}

/** 取包内某个文件的字节（Uint8Array），读图走这条路径。
 *
 *  不先包装成 Blob：Blob 会复制整份字节，而省份 id 图可达数百 MB，
 *  移动端多这一份拷贝可能耗尽内存；直接返回字节可避免该拷贝。
 *  旧库存储的是 Blob，此处转换一次（新库为 ArrayBuffer，包一层视图即可）。 */
export async function getFileBytes(id, name) {
  const mode = await packStoreMode();
  const key = psFileKey(id, name);
  let v;
  if (mode === 'memory') {
    v = PS_MEM_FILES.get(key);
  } else {
    const tx = psDb().transaction([PS_FILES], 'readonly');
    v = await psReq(tx.objectStore(PS_FILES).get(key));
  }
  if (!v) return null;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v;                                  // Uint8Array / 其它 TypedArray
}

/** 这个包在库里的文件名字列表 */
export async function listFiles(id) {
  const rec = await getPack(id);
  if (rec && Array.isArray(rec.files)) return rec.files.slice();
  const mode = await packStoreMode();
  if (mode === 'memory') {
    const pre = id + '/';
    return Array.from(PS_MEM_FILES.keys()).filter((k) => k.indexOf(pre) === 0).map((k) => k.slice(pre.length));
  }
  const tx = psDb().transaction([PS_FILES], 'readonly');
  const keys = await psReq(tx.objectStore(PS_FILES).getAllKeys(
    IDBKeyRange.bound(id + '/', id + '/\uffff')));
  const pre = id + '/';
  return (keys || []).filter((k) => String(k).indexOf(pre) === 0).map((k) => String(k).slice(pre.length));
}

/* ============================================================================
 * 一张图对应一条记录，记录的键是实例键，而非作者写的 id
 *
 * 设计原因：导入地图不覆盖已有地图，而是新建一张，仅在类型上归属某个游戏。
 * 因此导入永远是新增：同一个包导入两次就是两张图（涂色各自独立），
 * 导入新版本同样是新增一张，旧记录保持不变，已有数据不会被静默替换
 * （需要清理时通过「⋯」菜单删除）。
 *
 * 库中存在两层身份：
 *   · `id`（记录的键，即实例键）：第一份就是作者写的 id，之后每份加 `~2`、`~3`……
 *   · `manifestId`：作者写的 id（用于展示与判断是否为同一张图）
 * 文件键为 `${实例键}/${文件名}`，两份同名图各存各的字节，互不影响。
 * ========================================================================== */

// ---------------------------------------------------------------- 写

/**
 * 选择一个未被占用的实例键。
 *
 * 第一份使用作者写的 id，已导入的旧记录无需迁移，
 * 界面上显示的也是原始名称；第二份起加 `~2`、`~3`……
 */
async function freePackKey(base) {
  if (!(await getPack(base))) return base;
  for (let i = 2; i < 200; i++) {
    const k = base + '~' + i;
    if (!(await getPack(k))) return k;
  }
  throw psFail('同一张图已达到 200 份上限，请先在「⋯」菜单中删除部分记录');
}

/**
 * 写入一份新的包（调用方先经 freePackKey 选定键）
 *
 * @param {string} key            实例键
 * @param {object} manifest       校验过的 manifest（原样存储，不改动作者信息）
 * @param {Array<{name:string, blob:Blob}>} files  要存的条目
 * @param {(msg: string, pct: number) => void} [onProgress]
 * @returns {Promise<string>} 实例键
 */
export async function putPack(key, manifest, files, onProgress) {
  const mode = await packStoreMode();
  const say = (m, p) => { if (onProgress) onProgress(m, p); };

  /* Safari / WebKit 在临时存储（隐私模式等）下不接受 Blob：
   *   UnknownError: Error preparing Blob/File data to be stored in object store
   * 同一存储中 ArrayBuffer / Uint8Array / 字符串均正常。
   * 因此入库前统一转为字节：优先使用调用方提供的 `data`，仅在传入 `blob` 时转换一次。
   * 转换必须在开启事务之前完成：事务内除 IDB 请求外不可 await 其他操作。 */
  const payload = [];
  for (const f of files) {
    let data = f.data;
    if (!data && f.blob && typeof f.blob.arrayBuffer === 'function') data = await f.blob.arrayBuffer();
    if (!data) data = new ArrayBuffer(0);
    payload.push({ name: f.name, data, size: (data.byteLength != null ? data.byteLength : (data.size || 0)) });
  }

  const names = payload.map((f) => f.name);
  const totalBytes = payload.reduce((s, f) => s + f.size, 0);
  const rec = {
    id: key,                                   // 记录的键 = 实例键
    manifestId: manifest.id,                   // 作者写的 id（展示 / 认重）
    manifest,
    files: names,
    size: totalBytes,
    importedAt: Date.now(),
  };

  say('写入…', 0);
  if (mode === 'memory') {
    PS_MEM_PACKS.set(key, rec);
    for (const f of payload) PS_MEM_FILES.set(psFileKey(key, f.name), f.data);
    psLog('导入地图包', `${key}（仅本次会话）`);
    return key;
  }

  const tx = psDb().transaction([PS_PACKS, PS_FILES], 'readwrite');
  /* 事务完成或失败都在这一个 Promise 上等待：先挂好回调再发请求，
     否则最后一个请求完成时事务可能已经提交，回调不会触发。 */
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || psFail('写入失败'));
    tx.onabort = () => reject(tx.error || psFail('写入被中止'));
  });

  try {
    const sf = tx.objectStore(PS_FILES);
    const sp = tx.objectStore(PS_PACKS);
    /* 只清理这个键下的残留（上次写入中断留下的条目），
       不触碰其他键：这张图是新建的，其余记录的文件不可改动。 */
    const keys = await psReq(sf.getAllKeys(IDBKeyRange.bound(key + '/', key + '/\uffff')));
    for (const k of keys || []) await psReq(sf.delete(k));

    let doneBytes = 0;
    for (const f of payload) {
      await psReq(sf.put(f.data, psFileKey(key, f.name)));
      doneBytes += f.size;
      say(`写入 ${f.name}…`, totalBytes ? Math.round(100 * doneBytes / totalBytes) : 100);
    }
    await psReq(sp.put(rec));
  } catch (e) {
    try { tx.abort(); } catch (err) { /* 事务已失效，忽略 */ }
    await done.catch(() => {});          // 避免产生未处理的 rejection
    throw psFail(`写进浏览器存储失败：${e && e.message ? e.message : e}`);
  }
  await done;
  psLog('导入地图包', `${key} v${manifest.version || '?'}（新增，${names.length} 个文件）`);
  return key;
}

/** 删掉一个包（记录 + 它的全部文件） */
export async function removePack(id) {
  const mode = await packStoreMode();
  const rec = await getPack(id);
  const names = (rec && rec.files) || [];
  if (mode === 'memory') {
    for (const n of names) PS_MEM_FILES.delete(psFileKey(id, n));
    PS_MEM_PACKS.delete(id);
    psLog('删除地图包', id);
    return true;
  }
  const tx = psDb().transaction([PS_PACKS, PS_FILES], 'readwrite');
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || psFail('删除失败'));
    tx.onabort = () => reject(tx.error || psFail('删除被中止'));
  });
  try {
    const sf = tx.objectStore(PS_FILES);
    for (const n of names) await psReq(sf.delete(psFileKey(id, n)));
    const keys = await psReq(sf.getAllKeys(IDBKeyRange.bound(id + '/', id + '/\uffff')));
    for (const k of keys || []) await psReq(sf.delete(k));
    await psReq(tx.objectStore(PS_PACKS).delete(id));
  } catch (e) {
    try { tx.abort(); } catch (err) { /* 同上 */ }
    await done.catch(() => {});
    throw psFail(`删除失败：${e && e.message ? e.message : e}`);
  }
  await done;
  psLog('删除地图包', id);
  return true;
}

// ---------------------------------------------------------------- 导出备份

/**
 * 把库中的一个包重新打包为 `.pdxmap` 供下载，作为数据的备份出口。
 *
 * 浏览器存储并不可靠：清除站点数据或系统在空间紧张时回收，
 * 导入的图都会丢失，因此必须提供「导出备份」功能，README 中也要说明。
 */
export async function exportPackBytes(id, onStep) {
  const rec = await getPack(id);
  if (!rec) throw psFail(`库里没有「${id}」`);
  const files = [{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(rec.manifest)) }];
  for (const n of rec.files) {
    if (n === 'manifest.json') continue;
    const bytes = await getFileBytes(id, n);
    if (!bytes) throw psFail(`包里缺 ${n}（存储可能被清了）`);
    if (onStep) onStep(`读 ${n}…`);
    files.push({ name: n, data: bytes });
  }
  psLog('导出备份', `${id}（${files.length} 个条目）`);
  // .bin 已由 zlib 压缩，makeZipAsync 无法进一步压缩时会自动改为 store
  return makeZipAsync(files, onStep);
}

// ---------------------------------------------------------------- 导入（一条龙）

/** 判断两份包的内容是否相同（用于识别重复导入的同一文件） */
function psSameContent(rec, man) {
  const a = (rec && rec.manifest && rec.manifest.files) || null;
  const b = (man && man.files) || null;
  if (a && b) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => a[k] === b[k]);          // 逐文件 sha256 全部相同即视为同一份
  }
  // 未提供哈希清单（该字段可选）时退化为比较版本号，仅能粗略判断是否同版
  return !!(rec && rec.manifest && rec.manifest.version === man.version);
}

/** 库中所有与该 manifest 同一作者 id 的记录 */
export async function findSameMap(manifestId) {
  const all = await listPacks();
  return all.filter((r) => (r.manifestId || r.id) === manifestId);
}

/**
 * 导入一个地图包：读取 → 校验 → 新建一张图。失败时库中不留任何字节。
 *
 * 导入永远为新增，不覆盖任何已导入的图：
 * 同一个包导入两次就是两张图，涂色各自独立；导入新版本同样是新增一张，
 * 旧记录保持不变；需要清理时在卡片上按「删除」。
 * 唯一会被拦下的是内容完全相同的那一份（逐文件 sha256 全等）：
 * 此处不弹窗询问，界面收到 `code: 'DUPLICATE'` 后自行带上 `allowDuplicate`
 * 重新调用，直接新增一张。
 * 该检查用于拦截同一次流程中被写入两遍之类的异常。
 *
 * 来源无关：选择文件、拖入、创意工坊下载后传入 Blob，都走这一个入口。
 *
 * @param {Blob} blob       .pdxmap / .zip
 * @param {object} [opts]
 * @param {(msg: string, pct: number) => void} [opts.onProgress]
 * @param {(msg: string) => void} [opts.onNote]
 * @param {boolean} [opts.allowDuplicate] 已知库中存在内容相同的一份，仍然再导入一张
 * @returns {Promise<{manifest: object, key: string, sameMap: number}>}
 *          key = 实例键（界面、涂色、删除均使用）；sameMap = 库中同一作者 id 的份数
 */
export async function importPack(blob, opts = {}) {
  const say = (m, p) => { if (opts.onProgress) opts.onProgress(m, p); };
  say('读包…', 1);
  const zip = await readZip(blob);
  const { manifest } = await validatePack(zip, {
    onProgress: (m, p) => say(m, p),
    onNote: opts.onNote,
  });

  const same = await findSameMap(manifest.id);
  const twin = same.find((r) => psSameContent(r, manifest));
  if (twin && !opts.allowDuplicate) {
    const err = psFail(`这张图你已经导过一份一模一样的了「${manifest.label}」`
      + `（v${(twin.manifest && twin.manifest.version) || '?'}）`);
    err.code = 'DUPLICATE';
    err.id = twin.id;                 // 已存在那一份的实例键
    err.existing = twin.manifest;
    err.incoming = manifest;
    throw err;
  }

  /* 入库条目按 zip 内原始字节搬运，
     此处读取的是第一层文件本身，不做任何再加工；
     manifest.json 使用校验后的那一份（保留未知字段，与作者写入的一致）。 */
  const files = [{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) }];
  for (const e of zip.entries) {
    if (e.name === 'manifest.json') continue;
    say(`读 ${e.name}…`, 60);
    const bytes = await zip.bytes(e.name, 512 * 1024 * 1024);
    files.push({ name: e.name, data: bytes });
  }

  const key = await freePackKey(manifest.id);
  await putPack(key, manifest, files, (m, p) => say(m, 60 + Math.round(p * 0.4)));
  say('导入完成', 100);
  return { manifest, key, sameMap: same.length + 1 };
}

// ---------------------------------------------------------------- 地图仓库
//
// 命名的涂色存档：绘制时「存入地图仓库」，在选图页统一管理。
//   一条记录 = { id, name, created, updated, emb, base, game, mapKey, build,
//               preview(缩略图 dataURL), project(工程 JSON，即 projectData() 的结果) }
//   体积很小（几十 KB），无需像地图包那样拆成两个 store。
//   无 IndexedDB 时存入内存：行为一致，仅不跨刷新保存，规则与地图包相同。
//   事务纪律与 putPack 相同：事务内除 IDB 请求外不可 await 其他操作。

/** 仓库中的全部存档，按更新时间倒序 */
export async function listMaps() {
  const mode = await packStoreMode();
  if (mode === 'memory') {
    return Array.from(PS_MEM_MAPS.values()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }
  const tx = psDb().transaction([PS_MAPS], 'readonly');
  const all = await psReq(tx.objectStore(PS_MAPS).getAll());
  return (all || []).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

/** 某条存档（没有就 null） */
export async function getMap(id) {
  const mode = await packStoreMode();
  if (mode === 'memory') return PS_MEM_MAPS.get(id) || null;
  const tx = psDb().transaction([PS_MAPS], 'readonly');
  const v = await psReq(tx.objectStore(PS_MAPS).get(id));
  return v || null;
}

/** 保存或覆盖一条存档（id 相同即覆盖；复制与改名走其他入口） */
export async function putMap(rec) {
  const mode = await packStoreMode();
  if (mode === 'memory') { PS_MEM_MAPS.set(rec.id, rec); return rec; }
  const tx = psDb().transaction([PS_MAPS], 'readwrite');
  await psReq(tx.objectStore(PS_MAPS).put(rec));
  psLog('地图仓库', String(rec.name || rec.id));
  return rec;
}

/** 删除一条存档 */
export async function deleteMap(id) {
  const mode = await packStoreMode();
  if (mode === 'memory') { PS_MEM_MAPS.delete(id); return true; }
  const tx = psDb().transaction([PS_MAPS], 'readwrite');
  await psReq(tx.objectStore(PS_MAPS).delete(id));
  psLog('仓库删除', String(id));
  return true;
}
