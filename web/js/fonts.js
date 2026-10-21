/**
 * 本地字体库 —— 导入的字体存在浏览器里，想用哪套随时切换 ✓
 *
 * 存哪儿：**IndexedDB**（不是 localStorage ✗）
 *   一个中文字体动辄 5~15 MB ✓ localStorage 总共才 5 MB 左右，塞一个就满 ✗
 *   IndexedDB 没这个限制，浏览器也会自己落盘 ✓
 *
 * ⚠⚠ **存 ArrayBuffer，不许存 Blob** ✗✗（2026-10-19 真机踩过的坑 ✓）
 *   Safari 在隐私模式这类临时存储下，往 IndexedDB 里 put(Blob) 会直接抛：
 *     UnknownError: Error preparing Blob/File data to be stored in object store
 *   同一个库存 ArrayBuffer / Uint8Array / 字符串都正常 ✓ 只有 Blob 不行 ✓
 *   所以：入库前 `await file.arrayBuffer()` ✓ 读出来再自己包 ✓
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

/** 字体族名的前缀 —— 别跟系统字体撞（`PDX-Font-3` 这种）*/
const FAMILY_PREFIX = 'PDX-Font-';

let _db = null;
/** 已经注册进 document.fonts 的：id → FontFace ✓（删除时要 remove ✓）*/
const _faces = new Map();
/** 内存里那份清单（省得每次都读库 ✓）*/
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
        // keyPath = id：自增用不上（id 我们自己生成更稳 ✓）
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

/** 族名：给 canvas 的 ctx.font 用的 ✓ */
export function fontLibFamily(id) {
  return FAMILY_PREFIX + id;
}

/**
 * 把一个字体字节注册进 document ✓ —— 之后 `ctx.font = '... "PDX-Font-1"'` 才认
 *
 * ⚠ `FontFace` 在很老的浏览器上没有 ✗ —— 那就只能跳过（导入的字体用不了，
 *   但默认字体照常，整个编辑器不会因为这件事打不开 ✓）
 */
async function _register(id, bytes) {
  if (typeof FontFace === 'undefined' || !document.fonts) return false;
  /* ⚠ 这里当初写的是 `familyOf(id)` ✗ —— 那是**改名前的旧名字** ✓
   *   2026-10-20 我把导出改成 `fontLibFamily`（避打包器拍平后撞名），
   *   可内部这一句没跟着改 → `ReferenceError: familyOf is not defined` ✓
   *   后果是**所有 TTF 都注册失败**：下拉里明明有名字、`document.fonts` 里却没有 ✓
   *   canvas 一画就回退默认栈 → 玩家看到的就是"选了没反应" ✓
   *   （自检也没抓到：桩里没有 FontFace，`_register` 压根跑不到这一行 ✗）
   *   → 现在自检里带了假 FontFace，专门盯着这条 ✓ */
  const family = fontLibFamily(id);

  /* 🔴 **两种注册方式都试** ✗✗（2026-10-20 ✓ 用户："也没生效啊"）
   *   ① 直接喂 ArrayBuffer —— 规范支持，但各家浏览器支持面不一样
   *   ② 退回 blob URL（`url(blob:…)`）—— 老路，兼容性最好
   *   第一种不通就试第二种 ✓ 两条都不通才算真没辙 ✓
   *   ⚠ 两个用**同一个族名** ✓ 成功之后 canvas 那边照常按族名取 ✓ */
  const sources = [bytes];
  /* ⚠ **blob URL 用完要撤销** ✗（2026-10-20）
   *   以前每次走到这条路都建一个、从来不撤销 → 一直挂在内存里 ✓
   *   `FontFace.load()` 之后它自己握着字体数据 ✓ 撤了不影响渲染 ✓ */
  const _urls = [];
  try {
    if (typeof URL !== 'undefined' && URL.createObjectURL && typeof Blob !== 'undefined') {
      sources.push(() => {
        const u = URL.createObjectURL(new Blob([bytes], { type: 'font/ttf' }));
        _urls.push(u);
        return 'url(' + u + ')';
      });
    }
  } catch (e) { /* 造不出 blob URL 就只试第一种 ✓ */ }

  try {
    for (const src of sources) {
      const s = typeof src === 'function' ? src() : src;
      /* ⚠ **字重必须对上** ✗✗（2026-10-20 ✓ 用户："也没生效啊"）
       *   标签画字用的是 `600 ${size}px "族名"` ✓
       *   可 FontFace 不写 descriptors 时，这套字被登记成 **400** ✓
       *   字重对不上，`document.fonts.check('600 …')` 直接 false，
       *   canvas 那边也拿不到它 → 画面照旧是默认字体 ✓
       *   → 按 600 登记一份；万一浏览器不认 descriptors，再退回不写 ✓ */
      for (const desc of [{ weight: '600' }, undefined]) {
        try {
          const face = desc ? new FontFace(family, s, desc) : new FontFace(family, s);
          await face.load();
          document.fonts.add(face);
          _faces.set(id, face);
          return true;
        } catch (e) {
          /* 这一种不行，试下一种 ✓ */
        }
      }
    }
  } finally {
    /* 成功失败都要清 ✓ —— 一个都不留 ✓ */
    for (const u of _urls) {
      try { URL.revokeObjectURL(u); } catch (e) { /* ✓ */ }
    }
  }
  // 两种都不行：字体文件坏了 / 格式浏览器不认 —— 别把启动带崩 ✗
  return false;
}

/**
 * 开机把所有字体注册一遍 ✓
 * @returns {Promise<Array<{id:string,name:string,ok:boolean}>>}
 */
export async function fontLibLoadAll() {
  const list = await fontLibList();
  const out = [];
  for (const item of list) {
    /* ⚠ 位图字体**不进 document.fonts** ✗ —— 它的"字节"是 .dds 图集，
     *   拿去 new FontFace 必然失败 ✓ 它靠 labels.js 逐字贴，不靠浏览器 ✓ */
    if (item.kind === 'bitmap') {
      out.push({ id: item.id, name: item.name, ok: true });
      continue;
    }
    // 注册过的别再注册（重复 add 同一个族名会让 canvas 拿到旧的 ✓）
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
    /* ⚠ 老记录万一存的是 Blob（别的版本写的 ✓）也顺手认一下 ✓
     *   新写的永远是 ArrayBuffer ✓ */
    if (rec.bytes instanceof ArrayBuffer) return rec.bytes;
    if (typeof Blob !== 'undefined' && rec.bytes instanceof Blob) {
      return await rec.bytes.arrayBuffer();
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** 库里有哪些字体（不含字节，列表用）
 *  ⚠ 带 `kind` ✓：'ttf' = 真字体（走 FontFace ✓）
 *                 'bitmap' = 位图字体（.fnt + .dds，逐字贴 ✓）
 */
export async function fontLibList() {
  if (_list) return _list.slice();
  try {
    const st = await _tx('readonly');
    const all = await _req(st.getAll());
    _list = (all || []).map((r) => ({
      id: r.id, name: r.name, size: r.size || 0, added: r.added || 0,
      kind: r.kind || 'ttf',        // 老记录没有这个字段 → 一定是 ttf ✓
    })).sort((a, b) => (a.added || 0) - (b.added || 0));
  } catch (e) {
    _list = [];
  }
  return _list.slice();
}

/** 取一条完整记录（位图字体要拿 fnt 文本 + dds 字节 ✓）*/
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
 * @param {ArrayBuffer} bytes **必须是 ArrayBuffer** ✗ Blob 会在 Safari 上炸
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
  _list = null;                                  // 让下次 list() 重读 ✓
  const ok = await _register(id, bytes);
  return { id, name: rec.name, ok };
}

/**
 * 导入一套**位图字体**（EU4 汉化那种 `.fnt` + `.dds` ✓）
 *
 * ⚠ 两样都得存 ✗ —— fnt 是索引、dds 是字形图，少一个就用不了 ✓
 *   dds 也走 ArrayBuffer ✓（同样不能在 Safari 上存 Blob ✓）
 *   **不在这里解码** ✓ 大图集整张解要几百 MB，用到哪个字再解 ✓ 见 bitmapfont.js
 *
 * @param {string} name 显示名
 * @param {string} fntText `.fnt` 全文
 * @param {ArrayBuffer} ddsBytes `.dds` 原始字节
 */
/* 🔴 **一个位图字体可以有好几页** ✗✗（2026-10-20 ✓ 用户：
 *   "CN_mapfont_0 / CN_mapfont_1 这俩要合一起才能用"）
 *   → 第三个参数既收单个 ArrayBuffer，也收 [{fnt, dds}, …] 数组 ✓
 *   老的单页调用一个都不用改 ✓ */
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
    /* 老字段留着：单页时它们跟 pages[0] 一模一样 ✓ 别的代码还在读 ✓ */
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
  } catch (e) { /* 删不掉也别炸 ✓ */ }
  const face = _faces.get(id);
  if (face && document.fonts && document.fonts.delete) {
    try { document.fonts.delete(face); } catch (e) { /* ✓ */ }
  }
  _faces.delete(id);
  _list = null;
}

/** 这个 id 是不是真的注册成功了（导入后可能格式不认 ✓） */
export function fontLibReady(id) {
  return _faces.has(id);
}

/** 清空整个字体库（连同注册过的字体一起撤掉 ✓）
 *  用途：早先版本留下的坏记录会一直占着下拉（导入失败那阵子写进去的 ✓），
 *  留着只会让人以为"新导入的也没用" ✗ 一键清干净再重导最省事 ✓ */
export async function fontLibClear() {
  try {
    const st = await _tx('readwrite');
    await _req(st.clear());
  } catch (e) { /* 清不掉也别炸 ✓ */ }
  for (const [, face] of _faces) {
    if (document.fonts && document.fonts.delete) {
      try { document.fonts.delete(face); } catch (e) { /* ✓ */ }
    }
  }
  _faces.clear();
  _list = null;
}

/** 自测用：把内存状态清掉，逼它重新读库 ✓ */
export function _resetForTest() {
  _db = null;
  _list = null;
  _faces.clear();
}
