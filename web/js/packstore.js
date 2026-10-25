/**
 * 地图包的仓库 —— 导入进来的图存在浏览器里（IndexedDB），刷新/关掉再开都还在。
 *
 * 为什么要落库而不是"当场用一下"：玩家导一张 KR 图，是要**反复开工**的 ✓
 * 每次打开编辑器都让他重新选一遍文件，那还不如继续出"适配 KR 版" ✗
 * （用户明确要求：导入的图刷新不丢，只有手动删才没 ✓）
 *
 * 两个 store：
 *   `packs`  key = id      → { manifest, importedAt, size, files: [名字…] }   ← 很小，选图界面只读它
 *   `files`  key = "id/名" → Blob                                            ← 选中某张图后才**逐个**读
 * 分开的理由：选图界面要列出十几张图，没必要把每张图的 84 MB 省份图解进内存 ✗
 *
 * 三条必须守住的：
 *   ① **导入是一个事务**：删旧 + 写新在同一个 readwrite 事务里 ✓
 *      中途关页面的话，库里要么是旧版、要么是新版，**不许出现半个包** ✗
 *      （所以事务里除了 IDB 请求别的什么都不 await —— 一旦 await 了别的东西，
 *        浏览器会把事务提前提交，后面的写就飞了 ✗）
 *   ② **IndexedDB 用不了时要有话说**：隐私模式 / 老浏览器 → 降级成"只在这次会话里"，
 *      界面上必须写明"刷新会丢"，不能假装存上了 ✓（见 mode()）
 *   ③ **Blob 原样存**：不解压、不重编码 ✓ 读出来就是 zip 里那一份字节，
 *      data.js 那边两层解压的路跟原版走的一模一样
 */

/* ⚠ **必须是静态 import** ✗ 别用"运行到才去加载"那种动态导入（await 后面跟 import 的写法）：
   单文件版（build_standalone.py）是把这个文件拍平成一段普通脚本的，
   拍平只认得行首那两种静态写法；动态导入会**原样留在产物里**，
   双击 HTML 打开时 file:// 下那句必炸 ✗（这个坑很深：开发版一切正常 ✓）
   （tools/check_standalone.js 里有一条断言专门扫这个，注释里也别写出那种字面写法 ——
     它会把注释一起抓出来 ✗） */
import { readZip, makeZipAsync } from './zip.js';
import { validatePack } from './pack.js';

//: 库名 / store 名。改名字等于把玩家已导入的图全弄丢 ✗ 别乱动 ✓
const PS_DB = 'pdx-map-editor';
//: ⚠ 2026-10-24：1 → 2 加了 `saved_maps`（地图仓库 ✓）。IndexedDB 升版本
//:   只会**新增** store，已有的 packs / files 原封不动 ✓ 玩家导入的图安然无恙 ✓
const PS_VER = 2;
const PS_PACKS = 'packs';
const PS_FILES = 'files';
const PS_MAPS = 'saved_maps';

//: 'idb' = 真存下来了 ✓ / 'memory' = 这次会话能用，刷新就没了 ✗ / null = 还没探过
let PS_MODE = null;
let PS_DB_HANDLE = null;

//: 降级模式下的内存仓库（跟 IndexedDB 那套行为一致，只是活不过刷新）
const PS_MEM_PACKS = new Map();
const PS_MEM_MAPS = new Map();
const PS_MEM_FILES = new Map();

/** 记一笔轨迹（日志模块是普通脚本，单文件版里也在；没有就安静跳过 ✓） */
function psLog(name, detail) {
  try {
    if (typeof window !== 'undefined' && window.PDXLOG) window.PDXLOG.event(name, detail);
  } catch (e) { /* 日志坏了不能连累导入 */ }
}

function psFail(msg) {
  return new Error(msg);
}

/** 把 IDB 请求包成 Promise（onerror 也接住） */
function psReq(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || psFail('IndexedDB 报错了'));
  });
}

/**
 * 探一次 IndexedDB 能不能用。
 * @returns {Promise<'idb'|'memory'>}
 */
export async function packStoreMode() {
  if (PS_MODE) return PS_MODE;
  if (typeof indexedDB === 'undefined' || !indexedDB) {
    PS_MODE = 'memory';
    psLog('地图包', '这台浏览器/这个模式没有 IndexedDB → 导入的图只在本次会话里 ✓');
    return PS_MODE;
  }
  try {
    PS_DB_HANDLE = await new Promise((resolve, reject) => {
      const req = indexedDB.open(PS_DB, PS_VER);
      // 有些浏览器（隐私模式）是**悄悄卡住**而不是报错 ✗ → 给个超时，超了就走降级
      const timer = setTimeout(() => reject(psFail('打开数据库超时')), 4000);
      const stop = () => clearTimeout(timer);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PS_PACKS)) db.createObjectStore(PS_PACKS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(PS_FILES)) db.createObjectStore(PS_FILES);
        if (!db.objectStoreNames.contains(PS_MAPS)) db.createObjectStore(PS_MAPS, { keyPath: 'id' });
      };
      req.onsuccess = () => { stop(); resolve(req.result); };
      req.onerror = () => { stop(); reject(req.error || psFail('打不开数据库')); };
    });
  } catch (e) {
    PS_MODE = 'memory';
    psLog('地图包', `IndexedDB 用不了（${e && e.message}）→ 导入的图只在本次会话里 ✓`);
    return PS_MODE;
  }
  PS_MODE = 'idb';
  return PS_MODE;
}

function psDb() {
  if (!PS_DB_HANDLE) throw psFail('数据库还没打开（先 await packStoreMode()）');
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

/** 库里那份东西 → **Blob**（调用方只认 Blob ✓）
 *
 *  ⚠ 库里现在存的是 **ArrayBuffer**（不是 Blob ✗ 见 putPack 那段：Safari 写 Blob 会失败 ✓）
 *    —— 这里统一包回 Blob，`data.js` / 导出备份那些地方**一个字都不用改** ✓
 *  ⚠ 也认 Blob / Uint8Array：**老版本存进去的就是 Blob** ✓ 读出来照旧能用 ✓
 *    （用户升级之后，之前导进来的图不能突然读不出来 ✓）*/
function _asBlob(v) {
  if (!v) return null;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
  return new Blob([v]);
}

/** 取包里某个文件的字节（Blob）。**按需取** —— 别在选图界面批量取 ✗ */
export async function getFile(id, name) {
  const mode = await packStoreMode();
  const key = psFileKey(id, name);
  if (mode === 'memory') return _asBlob(PS_MEM_FILES.get(key));
  const tx = psDb().transaction([PS_FILES], 'readonly');
  const v = await psReq(tx.objectStore(PS_FILES).get(key));
  return _asBlob(v);
}

/** 取包里某个文件的**字节**（Uint8Array）—— 读图走这条 ✓
 *
 *  为什么不先包成 Blob：Blob 会把整份字节再拷一遍，而省份 id 图动辄几百 MB，
 *  手机上多这一份就可能爆；直接给字节省掉这次拷贝。
 *  老库里存的是 Blob，这里转一次就好（新库是 ArrayBuffer，包一层视图就够）。 */
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
  return v;                                  // Uint8Array / 其它 TypedArray ✓
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
 * 一张图 = 一条记录，**键是"这一份"而不是作者写的 id** ✗
 *
 * 为什么要分开（2026-10-11 按廿九的要求改的）：
 *   「导入的地图不覆盖之前的地图，而是新建一张，只是类型上跟着某个游戏走」
 *   所以**导入永远是新建** ✓ 同一个包导两次就是两张图（涂色各自独立），
 *   升个版本进来也是"多一张"，旧的那张原封不动 —— 玩家的东西**任何时候都不会被
 *   悄悄换掉** ✓（想清掉旧的那张，自己在「⋯」里删 ✓）
 *
 * 于是库里有两层身份：
 *   · `id`（记录的键，= **实例键**）：第一份就是作者写的 id，之后每份加 `~2`、`~3`……
 *   · `manifestId`：作者写的那个 id（展示、认"这是不是同一张图"用）
 * 文件键是 `${实例键}/${文件名}` ✓ 两份同名图各存各的字节，互不影响 ✓
 * ========================================================================== */

// ---------------------------------------------------------------- 写

/**
 * 挑一个没被占用的实例键。
 *
 * 第一份**就用作者写的 id** ✓ —— 这样昨天导入过的图（老键就是作者 id）不用迁移，
 * 界面上看到的也是干净的名字；第二份起才加 `~2`、`~3`……
 */
async function freePackKey(base) {
  if (!(await getPack(base))) return base;
  for (let i = 2; i < 200; i++) {
    const k = base + '~' + i;
    if (!(await getPack(k))) return k;
  }
  throw psFail('同一张图已经导了 200 份了，先在「⋯」里删掉几份吧');
}

/**
 * 写入**一份新的**包（调用方先用 freePackKey 挑好键 ✓）
 *
 * @param {string} key            实例键
 * @param {object} manifest       校验过的 manifest（原样存，作者信息一个不改 ✓）
 * @param {Array<{name:string, blob:Blob}>} files  要存的条目
 * @param {(msg: string, pct: number) => void} [onProgress]
 * @returns {Promise<string>} 实例键
 */
export async function putPack(key, manifest, files, onProgress) {
  const mode = await packStoreMode();
  const say = (m, p) => { if (onProgress) onProgress(m, p); };

  /* Safari / WebKit 在临时存储（隐私模式等）下**不收 Blob**：
   *   UnknownError: Error preparing Blob/File data to be stored in object store
   * 同一个库存 ArrayBuffer / Uint8Array / 字符串都正常（2026-10-19 实测）。
   * 所以入库前先统一成字节：优先用调用方给的 `data`，只有老式的 `blob` 才转一次。
   * 转换必须在开事务之前做完：事务里除了 IDB 请求不许 await 别的。 */
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
  /* 事务完成 / 失败都在这一个 Promise 上等 ✓ 先挂好再发请求 ——
     反过来的话，最后一个请求完成时事务可能已经 commit，回调就挂空了 ✗ */
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || psFail('写入失败'));
    tx.onabort = () => reject(tx.error || psFail('写入被中止'));
  });

  try {
    const sf = tx.objectStore(PS_FILES);
    const sp = tx.objectStore(PS_PACKS);
    /* 只清"这个键底下"的残留（上一次写到一半留下的孤儿）✓
       ⚠ **绝不碰别的键** —— 这张图是新建的，别人的文件一个都不能动 ✗ */
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
    try { tx.abort(); } catch (err) { /* 已经废了就无所谓 */ }
    await done.catch(() => {});          // 别留下没人接的 rejection ✗
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
 * 把库里的一个包重新打成一个 `.pdxmap` 下载 —— 玩家的后路 ✓
 *
 * 浏览器存储不是网盘：清了站点数据、或者系统在空间紧张时回收，
 * 导入的图就没了 ✗ 所以「导出备份」是必须有的，README 里也要写明 ✓
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
  // .bin 已经是 zlib 压过的，makeZipAsync 压不动会自动退回 store ✓
  return makeZipAsync(files, onStep);
}

// ---------------------------------------------------------------- 导入（一条龙）

/** 这两份包的**内容**一样吗（用来认"你是不是又导了一遍同一个文件"） */
function psSameContent(rec, man) {
  const a = (rec && rec.manifest && rec.manifest.files) || null;
  const b = (man && man.files) || null;
  if (a && b) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => a[k] === b[k]);          // 逐个文件的 sha256 全等 = 同一份东西 ✓
  }
  // 都没给哈希清单（包是可选的）：退回比版本号，只能说"大概是同一版" ✓
  return !!(rec && rec.manifest && rec.manifest.version === man.version);
}

/** 库里所有"跟这个 manifest 同一个作者 id"的那几份 */
export async function findSameMap(manifestId) {
  const all = await listPacks();
  return all.filter((r) => (r.manifestId || r.id) === manifestId);
}

/**
 * 导入一个地图包：读 → 校验 → **新建一张图**。失败的话库里一个字节都不留 ✓
 *
 * ⚠ **永远是新增，不覆盖任何已导入的图**（2026-10-11 按廿九的要求改的）：
 * 同一个包导两次就是两张图，涂色各自独立；作者出了新版本，导进来就是"多一张"，
 * 旧那张原封不动 ✓ 想清掉旧的，玩家在卡片上按「删除」✓
 * 唯一会拦一下的是**一模一样的那一份**（逐文件 sha256 全等）——
 * ⚠ 2026-10-12 起这里**不再弹窗问玩家**了 ✗：界面拿到 `code: 'DUPLICATE'`
 * 就自己带 `allowDuplicate` 重来，直接多一张（用户要求：别为这个多按一次"确定" ✓）
 * 这道检查留着是挡"同一次流程里被写两遍"那种意外 ✓
 *
 * 来源无关：选文件、拖进来、将来创意工坊下载完把 Blob 交给它，都是这一个入口 ✓
 *
 * @param {Blob} blob       .pdxmap / .zip
 * @param {object} [opts]
 * @param {(msg: string, pct: number) => void} [opts.onProgress]
 * @param {(msg: string) => void} [opts.onNote]
 * @param {boolean} [opts.allowDuplicate] 已经知道库里有一份一模一样的，还是再进一张
 * @returns {Promise<{manifest: object, key: string, sameMap: number}>}
 *          key = 实例键（界面、涂色、删除全用它）；sameMap = 库里同一个作者 id 的份数
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

  /* 要入库的条目：**原样搬**（zip 里那一份字节）✓
     这里读的是"第一层"—— 也就是包里那个文件本身，不做任何再加工 ✓
     manifest.json 用**校验后**的那一份（未知字段保留，跟作者写的一致） */
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
// 🗺 **命名的涂色存档**（2026-10-24 ✓）：画地图时「存入地图仓库」，选图页统一管理。
//   一条记录 = { id, name, created, updated, emb, base, game, mapKey, build,
//               preview(缩略图 dataURL), project(工程 JSON ✓ projectData() 那份) }
//   都很小（几十 KB）✓ 不用像地图包那样分两个 store ✓
//   降级（无 IndexedDB）时存内存：行为一致，只是刷新就没 —— 跟地图包同一条规矩 ✓
//   ⚠ 事务纪律跟 putPack 一样：事务里除了 IDB 请求不许 await 别的东西 ✓

/** 仓库里全部存档，**新的在前** ✓ */
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

/** 存 / 覆盖一条存档（id 相同 = 覆盖 ✓ 复制 / 改名走别的入口 ✓） */
export async function putMap(rec) {
  const mode = await packStoreMode();
  if (mode === 'memory') { PS_MEM_MAPS.set(rec.id, rec); return rec; }
  const tx = psDb().transaction([PS_MAPS], 'readwrite');
  await psReq(tx.objectStore(PS_MAPS).put(rec));
  psLog('地图仓库', String(rec.name || rec.id));
  return rec;
}

/** 删一条存档 ✓ */
export async function deleteMap(id) {
  const mode = await packStoreMode();
  if (mode === 'memory') { PS_MEM_MAPS.delete(id); return true; }
  const tx = psDb().transaction([PS_MAPS], 'readwrite');
  await psReq(tx.objectStore(PS_MAPS).delete(id));
  psLog('仓库删除', String(id));
  return true;
}
