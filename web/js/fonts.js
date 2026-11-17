/**
 * 本地字体库：导入的字体保存在浏览器中，可随时切换。
 *
 * 存储位置：IndexedDB（不使用 localStorage）。
 *   一个中文字体通常 5~15 MB，而 localStorage 总量约 5 MB，存一套即满。
 *   IndexedDB 无此限制，浏览器会自动落盘。
 *
 * 必须存 ArrayBuffer，不能存 Blob。
 *   Safari 在隐私模式这类临时存储下，向 IndexedDB put(Blob) 会直接抛出：
 *     UnknownError: Error preparing Blob/File data to be stored in object store
 *   同一存储中 ArrayBuffer / Uint8Array / 字符串均正常，只有 Blob 不行。
 *   因此入库前先 `await file.arrayBuffer()`，读出后再自行包装。
 *
 * 用法：
 *   await FontLib.loadAll();              // 开机把库里的都注册进 document.fonts
 *   const list = await FontLib.list();    // [{id, name, family}]
 *   await FontLib.add(name, arrayBuffer); // 导入
 *   await FontLib.remove(id);             // 删除
 *   FontLib.familyOf(id)                  // 'PDX-Font-<id>'（给 canvas 用的族名）
 */

const DB_NAME = 'pdx-fonts';
const DB_VER = 1;
const STORE = 'fonts';

/** 字体族名前缀，避免与系统字体冲突（如 `PDX-Font-3`）*/
const FAMILY_PREFIX = 'PDX-Font-';

let _db = null;
/** 已注册进 document.fonts 的字体：id → FontFace（删除时需移除）*/
const _faces = new Map();
/** 内存缓存清单（避免每次都读库）*/
let _list = null;

function _open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VER);
    } catch (e) {
      rej(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // keyPath = id：不使用自增，id 由代码自行生成
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      res(_db);
    };
    req.onerror = () => rej(req.error || new Error('打不开字体库'));
  });
}

function _tx(mode) {
  return _open().then((db) => db.transaction([STORE], mode).objectStore(STORE));
}

function _req(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/** 族名，供 canvas 的 ctx.font 使用 */
export function fontLibFamily(id) {
  return FAMILY_PREFIX + id;
}

/**
 * 把字体字节注册进 document，之后 `ctx.font = '... "PDX-Font-1"'` 才会生效。
 *
 * 旧浏览器可能不支持 `FontFace`，此时只能跳过：导入的字体不可用，
 * 默认字体不受影响，编辑器仍可正常打开。
 */
async function _register(id, bytes) {
  if (typeof FontFace === 'undefined' || !document.fonts) return false;
  /* 内部必须使用 fontLibFamily(id)：旧名 familyOf 已不存在，
   * 误用会抛出 `ReferenceError: familyOf is not defined`，导致所有 TTF 注册失败。
   * 自检中提供了模拟 FontFace，用于覆盖这条路径。 */
  const family = fontLibFamily(id);

  /* 两种注册方式依次尝试：
   *   ① 直接传入 ArrayBuffer —— 规范支持，但各浏览器支持程度不一
   *   ② 退回 blob URL（`url(blob:…)`）—— 兼容性最好
   * 第一种失败再试第二种，两者均失败才判定不可用。
   * 两种方式使用同一个族名，注册成功后 canvas 按族名取用。 */
  const sources = [bytes];
  /* blob URL 用完必须撤销，否则会持续占用内存。
   * `FontFace.load()` 之后已持有字体数据，撤销 URL 不影响渲染。 */
  const _urls = [];
  try {
    if (typeof URL !== 'undefined' && URL.createObjectURL && typeof Blob !== 'undefined') {
      sources.push(() => {
        const u = URL.createObjectURL(new Blob([bytes], { type: 'font/ttf' }));
        _urls.push(u);
        return 'url(' + u + ')';
      });
    }
  } catch (e) { /* 无法创建 blob URL 时只尝试第一种 */ }

  try {
    for (const src of sources) {
      const s = typeof src === 'function' ? src() : src;
      /* 字重必须匹配：标签绘制使用 `600 ${size}px "族名"`，
       * 而 FontFace 不写 descriptors 时会登记为 400，
       * 字重不符时 `document.fonts.check('600 …')` 返回 false，
       * canvas 取不到该字体，画面仍显示默认字体。
       * 因此按 600 登记一份；若浏览器不支持 descriptors，再退回不写。 */
      for (const desc of [{ weight: '600' }, undefined]) {
        try {
          const face = desc ? new FontFace(family, s, desc) : new FontFace(family, s);
          await face.load();
          document.fonts.add(face);
          _faces.set(id, face);
          return true;
        } catch (e) {
          /* 该方式失败，尝试下一种 */
        }
      }
    }
  } finally {
    /* 无论成功或失败都要清理 */
    for (const u of _urls) {
      try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ }
    }
  }
  // 两种方式都失败：文件损坏或浏览器不支持该格式，不抛出异常以免影响启动
  return false;
}

/**
 * 启动时注册库中全部字体
 * @returns {Promise<Array<{id:string,name:string,ok:boolean}>>}
 */
export async function fontLibLoadAll() {
  const list = await fontLibList();
  const out = [];
  for (const item of list) {
    /* 位图字体不进入 document.fonts：其字节是 .dds 图集，
     * 传给 new FontFace 必然失败；该类型由 labels.js 逐字贴图，不依赖浏览器字体。 */
    if (item.kind === 'bitmap') {
      out.push({ id: item.id, name: item.name, ok: true });
      continue;
    }
    // 已注册的跳过（重复 add 同一个族名会让 canvas 取到旧字体）
    if (!_faces.has(item.id)) {
      const bytes = await _bytes(item.id);
      if (bytes) await _register(item.id, bytes);
    }
    out.push({ id: item.id, name: item.name, ok: _faces.has(item.id) });
  }
  return out;
}

async function _bytes(id) {
  try {
    const st = await _tx('readonly');
    const rec = await _req(st.get(id));
    if (!rec) return null;
    /* 兼容旧记录中存储的 Blob；新写入的记录一律为 ArrayBuffer。 */
    if (rec.bytes instanceof ArrayBuffer) return rec.bytes;
    if (typeof Blob !== 'undefined' && rec.bytes instanceof Blob) {
      return await rec.bytes.arrayBuffer();
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** 库中的字体列表（不含字节）
 *  kind 字段：'ttf' = 真字体（走 FontFace）
 *             'bitmap' = 位图字体（.fnt + .dds，逐字贴图）
 */
export async function fontLibList() {
  if (_list) return _list.slice();
  try {
    const st = await _tx('readonly');
    const all = await _req(st.getAll());
    _list = (all || []).map((r) => ({
      id: r.id, name: r.name, size: r.size || 0, added: r.added || 0,
      kind: r.kind || 'ttf',        // 旧记录缺该字段，按 ttf 处理
    })).sort((a, b) => (a.added || 0) - (b.added || 0));
  } catch (e) {
    _list = [];
  }
  return _list.slice();
}

/** 取一条完整记录（位图字体需要 fnt 文本与 dds 字节）*/
export async function fontLibRecord(id) {
  try {
    const st = await _tx('readonly');
    return (await _req(st.get(id))) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 导入一个字体
 * @param {string} name 显示名（一般用文件名去掉扩展名）
 * @param {ArrayBuffer} bytes 必须是 ArrayBuffer，Blob 在 Safari 上会失败
 * @returns {Promise<{id:string,name:string,ok:boolean}>}
 */
export async function fontLibAdd(name, bytes) {
  if (!(bytes instanceof ArrayBuffer)) {
    throw new Error('字体要以 ArrayBuffer 入库（Safari 不认 Blob）');
  }
  const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id, name: String(name || id).slice(0, 60),
    kind: 'ttf', bytes, size: bytes.byteLength, added: Date.now(),
  };
  const st = await _tx('readwrite');
  await _req(st.put(rec));
  _list = null;                                  // 使下次 list() 重新读库
  const ok = await _register(id, bytes);
  return { id, name: rec.name, ok };
}

/**
 * 导入一套位图字体（`.fnt` + `.dds` 组合）
 *
 * fnt 是索引、dds 是字形图集，两者都必须保存，缺少任一个都无法使用。
 * dds 同样以 ArrayBuffer 存储（Safari 上不能存 Blob）。
 * 此处不解码：大图集整张解码需要数百 MB，按需解出所用字形，见 bitmapfont.js
 *
 * @param {string} name 显示名
 * @param {string} fntText `.fnt` 全文
 * @param {ArrayBuffer} ddsBytes `.dds` 原始字节
 */
/* 一个位图字体可以包含多页（如 CN_mapfont_0 / CN_mapfont_1 需合并使用）：
 * 第三个参数既可传单个 ArrayBuffer，也可传 [{fnt, dds}, …] 数组。
 * 单页调用方式保持不变。 */
export async function fontLibAddBitmap(name, fntText, ddsBytes) {
  const pages = [];
  if (Array.isArray(fntText)) {
    for (const pg of fntText) {
      if (!pg || !(pg.dds instanceof ArrayBuffer) || typeof pg.fnt !== 'string') continue;
      pages.push({ fnt: pg.fnt, dds: pg.dds });
    }
  } else {
    if (!(ddsBytes instanceof ArrayBuffer)) {
      throw new Error('位图字体的 .dds 要以 ArrayBuffer 入库（Safari 不认 Blob）');
    }
    if (typeof fntText !== 'string' || !fntText) {
      throw new Error('位图字体缺 .fnt（只有 .dds 用不了）');
    }
    pages.push({ fnt: fntText, dds: ddsBytes });
  }
  if (!pages.length) throw new Error('位图字体一页都没读出来');
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const total = pages.reduce((a, pg) => a + pg.dds.byteLength, 0);
  const rec = {
    id, name: String(name || id).slice(0, 60),
    kind: 'bitmap', pages,
    /* 保留旧字段：单页时与 pages[0] 相同，仍有代码读取 */
    fnt: pages[0].fnt, bytes: pages[0].dds,
    pageCount: pages.length,
    size: total, added: Date.now(),
  };
  const st = await _tx('readwrite');
  await _req(st.put(rec));
  _list = null;
  return { id, name: rec.name, ok: true };
}


/** 删掉一个导入的字体 */
export async function fontLibRemove(id) {
  try {
    const st = await _tx('readwrite');
    await _req(st.delete(id));
  } catch (e) { /* 删除失败不抛出 */ }
  const face = _faces.get(id);
  if (face && document.fonts && document.fonts.delete) {
    try { document.fonts.delete(face); } catch (e) { /* 忽略 */ }
  }
  _faces.delete(id);
  _list = null;
}

/** 该 id 是否注册成功（导入的格式可能不被支持） */
export function fontLibReady(id) {
  return _faces.has(id);
}

/** 清空整个字体库（同时撤销已注册的字体）
 *  用途：导入失败留下的无效记录会一直占用下拉列表，
 *  清空后重新导入可避免误判为新导入的字体无效。 */
export async function fontLibClear() {
  try {
    const st = await _tx('readwrite');
    await _req(st.clear());
  } catch (e) { /* 清空失败不抛出 */ }
  for (const [, face] of _faces) {
    if (document.fonts && document.fonts.delete) {
      try { document.fonts.delete(face); } catch (e) { /* 忽略 */ }
    }
  }
  _faces.clear();
  _list = null;
}

/** 测试用：清空内存状态，强制重新读库 */
export function _resetForTest() {
  _db = null;
  _list = null;
  _faces.clear();
}
