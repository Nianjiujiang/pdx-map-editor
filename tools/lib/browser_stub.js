/**
 * 浏览器环境的 Node 桩 —— test_modes.js / bench_core.js / check_standalone.js 共用。
 *
 * 这三件事本来各写一份一模一样的假 DOM / 假 localStorage / 假 WebGL / 拍平逻辑
 * （test_modes.js 里一套、bench_core.js 里又抄一套），
 * 结果就是"改了一处、另外两处跟不上"——比如 DOM 桩后来加了 elementFromPoint，
 * 另一份没有，那边就在图例拖动那一步炸掉。
 *
 * 现在只有这一份。要加新能力（比如新的 canvas API、新的 DOM 方法）改这里，
 * 三个入口一起受益。
 *
 * 用法：
 *   const H = require('./lib/browser_stub.js');
 *   const env = H.makeEnv();                       // 一整套假环境
 *   const js  = H.flattenModules(['data.js', ..., 'app.js']);   // = 单文件版的拍平
 *   const api = H.instantiate(js, env);            // 跑起来，返回探针
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

//: 单文件版（build_standalone.py）的拼接顺序 —— **必须和那边一致** ✓
const MODULES = ['log.js', 'pack.js', 'zip.js', 'packstore.js', 'fonts.js', 'bitmapfont.js', 'data.js', 'bmp.js', 'gl.js', 'maplabels.js', 'labels.js', 'tilemap.js', 'tutorial.js', 'app.js'];

/** 开发时 index.html 只加载 app.js（真 ES module），这里按单文件版的顺序拍平 */
function flattenModules(modules = MODULES, root = ROOT) {
  const strip = (src) => src.split('\n').map((line) => {
    const s = line.trim();
    if (s.startsWith('import ')) return '';
    if (s.startsWith('export ')) return line.replace('export ', '');
    return line;
  }).join('\n');
  return modules.map((n) => {
    const file = path.join(root, 'web', 'js', n);
    /* 清单和源码对不上时**说人话** ✗ —— 直接让 readFileSync 抛 ENOENT 的话，
       下一个加模块的人只会看到"找不到某个文件"，还得自己猜是清单的问题 ✓
       （perf_compare 那种拿老快照拍的，请自己按"那边实际有什么"过滤，见那个文件 ✓） */
    if (!fs.existsSync(file)) {
      throw new Error(`拍平清单里有 ${n}，但 ${file} 不存在 —— `
        + `清单（MODULES / build_standalone.py）和这份源码对不上了`);
    }
    return `// ==== ${n} ====\n` + strip(fs.readFileSync(file, 'utf8'));
  }).join('\n\n');
}

// ---------------------------------------------------------------- 假 IndexedDB

/**
 * 极简 IndexedDB 桩 —— 只实现 packstore.js 用到的那几样。
 *
 * 为什么要有它：导入的地图包存在 IndexedDB 里，而 Node 没有这个 API ✗
 * 没有桩的话「导入 → 覆盖 → 删除 → 中途失败回滚」这四件事在自测里**一条都测不到**，
 * 而它们恰好是最容易写错的地方（写一半关机、覆盖时把旧的删了新的没写进去…）
 *
 * 事务语义照着浏览器来：**有请求挂着就不算完** ✓
 * packstore 是"发一个、等它回调、再发下一个"的写法，
 * 所以"待完成请求数"必须真的对，不然"写了一半"的用例会假装通过 ✗
 *
 * 不实现（也用不到）：索引、游标、跨标签同步、版本迁移里的数据搬运、
 * 真正的异步 IO（这里同步做完，只把回调排进微任务）
 */
function makeIndexedDBFake() {
  const dbs = new Map();          // name → { version, data: Map<store, Map<key, value>>, keys: Map<store, keyPath> }

  /* 失败注入（只给自测用）：>0 时，第 N 次 put/delete 抛错 ✓
     用途是"写到一半失败"——回滚对不对，只有让它在中间炸一次才知道 ✗ */
  const inject = { failPut: 0, failDelete: 0 };

  const mkReq = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });

  /** 发一个请求：同步做掉，回调排微任务，事务的待完成数跟着走 */
  function issue(tx, req, work) {
    if (tx && tx._aborted) { req.error = new Error('事务已经中止'); if (req.onerror) req.onerror({ target: req }); return req; }
    if (tx) tx._pending++;
    try {
      req.result = work();
    } catch (e) {
      req.error = e;
      queueMicrotask(() => {
        if (req.onerror) req.onerror({ target: req });
        if (tx) tx._abort(e);
      });
      return req;
    }
    queueMicrotask(() => {
      if (tx) tx._pending--;
      if (tx && tx._aborted) return;
      if (req.onsuccess) req.onsuccess({ target: req });
      if (tx) tx._settle();
    });
    return req;
  }

  function inRange(range, key) {
    if (!range) return true;
    const s = String(key);
    if (range.lower !== undefined && !(s >= range.lower)) return false;
    if (range.upper !== undefined && !(s <= range.upper)) return false;
    return true;
  }

  function makeTx(entry, names, mode) {
    const tx = {
      mode: mode || 'readonly', error: null,
      oncomplete: null, onerror: null, onabort: null,
      _pending: 0, _aborted: false, _done: false,
    };
    /* **回滚日志**：第一次碰到某个键时记下它原来的样子 ✓
       真 IndexedDB 是"事务中止 = 全部撤销"，桩要是只把写入留在原地，
       "写一半失败"的用例就会**假通过**（库里明明留了半个包，却看着没事）✗
       记 undo 还有个附带好处：事务里读得到自己刚写的东西（read-your-writes）✓ */
    const undo = [];
    const touched = new Set();
    tx._record = (storeName, key) => {
      const tag = storeName + '\u0000' + key;
      if (touched.has(tag)) return;
      touched.add(tag);
      const m = entry.data.get(storeName);
      const had = !!(m && m.has(key));
      undo.push({ storeName, key, had, value: had ? m.get(key) : undefined });
    };
    tx._rollback = () => {
      for (let i = undo.length - 1; i >= 0; i--) {
        const u = undo[i];
        let m = entry.data.get(u.storeName);
        if (!m) { m = new Map(); entry.data.set(u.storeName, m); }
        if (u.had) m.set(u.key, u.value); else m.delete(u.key);
      }
      undo.length = 0;
    };
    tx._settle = () => {
      // 再排一层微任务：消费者可能刚在 onsuccess 里又发了一个请求 ✓
      queueMicrotask(() => {
        if (tx._done || tx._aborted || tx._pending > 0) return;
        tx._done = true;
        if (tx.oncomplete) tx.oncomplete({ target: tx });
      });
    };
    tx._abort = (e) => {
      if (tx._aborted) return;
      tx._aborted = true;
      tx._rollback();
      tx.error = tx.error || e || new Error('aborted');
      queueMicrotask(() => { if (tx.onabort) tx.onabort({ target: tx }); });
    };
    tx.abort = () => tx._abort(new Error('aborted'));
    tx.objectStore = (name) => {
      if (names.indexOf(name) < 0) throw new Error(`事务里没有 ${name} 这个 store`);
      const data = () => {
        if (!entry.data.has(name)) entry.data.set(name, new Map());
        return entry.data.get(name);
      };
      const keyPath = entry.keys.get(name);
      return {
        get: (k) => issue(tx, mkReq(), () => data().get(k)),
        getAll: () => issue(tx, mkReq(), () => Array.from(data().values())),
        getAllKeys: (r) => issue(tx, mkReq(), () => Array.from(data().keys()).filter((k) => inRange(r, k))),
        put: (v, k) => issue(tx, mkReq(), () => {
          if (inject.failPut && --inject.failPut === 0) throw new Error('（自测注入）写入失败');
          /* 🔴 **照 WebKit 的脾气来：IDB 里不收 Blob** ✗✗（2026-10-19 ✓）
           *   Safari 在 `file://` 下 put(Blob) 必炸：
           *     UnknownError: Error preparing Blob/File data to be stored in object store
           *   实测同一只库：ArrayBuffer / Uint8Array / 字符串都正常 ✓ **只有 Blob 不行** ✓
           *   ⚠ 真机上的后果是"iPad 导不进地图、整个工具用不了"（issue #3 ✓），
           *     而电脑上 Chrome 一切正常 → 一直没被发现 ✗
           *   → 桩里照**拒收** ✓ 以后谁再把 Blob 写进 IDB，`check_import` 当场红 ✓ */
          if (typeof Blob !== 'undefined' && v instanceof Blob) {
            throw new Error('Error preparing Blob/File data to be stored in object store');
          }
          const key = k !== undefined ? k : (keyPath ? v[keyPath] : undefined);
          if (key === undefined) throw new Error('这条记录没有主键');
          tx._record(name, key);
          data().set(key, v);
          return key;
        }),
        delete: (k) => issue(tx, mkReq(), () => {
          if (inject.failDelete && --inject.failDelete === 0) throw new Error('（自测注入）删除失败');
          tx._record(name, k);
          data().delete(k);
          return undefined;
        }),
        count: () => issue(tx, mkReq(), () => data().size),
        clear: () => issue(tx, mkReq(), () => {
          for (const k of Array.from(data().keys())) tx._record(name, k);
          data().clear();
          return undefined;
        }),
      };
    };
    return tx;
  }

  function makeDb(name, entry) {
    return {
      name,
      get version() { return entry.version; },
      objectStoreNames: { contains: (n) => entry.data.has(n) || entry.keys.has(n) },
      createObjectStore: (n, opt) => {
        if (!entry.data.has(n)) entry.data.set(n, new Map());
        entry.keys.set(n, (opt && opt.keyPath) || null);
        return { name: n };
      },
      deleteObjectStore: (n) => { entry.data.delete(n); entry.keys.delete(n); },
      transaction: (names, mode) => makeTx(entry, Array.isArray(names) ? names : [names], mode),
      close: () => {},
      onversionchange: null,
    };
  }

  return {
    open(name, version) {
      const req = mkReq();
      queueMicrotask(() => {
        let entry = dbs.get(name);
        if (!entry) {
          entry = { version: 0, data: new Map(), keys: new Map() };
          dbs.set(name, entry);
        }
        const oldVersion = entry.version;
        const upgrade = (version || 1) > entry.version;
        if (upgrade) entry.version = version || 1;
        req.result = makeDb(name, entry);
        if (upgrade && req.onupgradeneeded) {
          req.onupgradeneeded({ target: req, oldVersion, newVersion: entry.version });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    deleteDatabase(name) {
      const req = mkReq();
      queueMicrotask(() => {
        dbs.delete(name);
        req.result = undefined;
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    //: 自测用：把某个库整个抹掉，模拟"玩家清了站点数据" ✓
    _drop(name) { dbs.delete(name); },
    /*: 自测用：让第 N 次 put / delete 炸掉（N = 1 就是下一次）✓ */
    _failPutAfter(n) { inject.failPut = n; },
    _failDeleteAfter(n) { inject.failDelete = n; },
    /* 自测用：把库里的东西摊平成普通对象 ✓
       为什么要它：导入/覆盖/删除之后要能数一数"库里到底躺了几个文件"——
       数不出来就查不了"有没有留下孤儿条目"（覆盖时最容易留下的东西）✗ */
    _dump() {
      const out = {};
      for (const [name, entry] of dbs) {
        const stores = {};
        for (const [sn, data] of entry.data) stores[sn] = Object.fromEntries(data);
        out[name] = { version: entry.version, stores };
      }
      return out;
    },
  };
}

//: IDBKeyRange 的桩（就用到 bound 一种）
function makeKeyRangeFake() {
  return {
    bound: (lo, hi, loOpen, hiOpen) => ({ lower: lo, upper: hi, lowerOpen: !!loOpen, upperOpen: !!hiOpen }),
    only: (v) => ({ lower: v, upper: v }),
    lowerBound: (v) => ({ lower: v }),
    upperBound: (v) => ({ upper: v }),
  };
}

/**
 * 某个源码根下**实际存在**的那几个模块 ✓
 *
 * 给"拿旧快照做对比"的工具用（`tools/exp_*.js` 的 `PDX_BEFORE`、`tools/perf_compare.js`）：
 * 旧快照里没有后来才加的模块（比如导入式地图那套 pack.js / packstore.js）✗
 * 照当前清单硬拍会报"清单里有它但文件不存在" —— 那不是错觉，确实对不上 ✓
 * 这类比较本来要的就是"那一边当时有什么"，所以过滤掉缺的 ✓
 * （**别**拿它当默认行为：真缺文件时应该吵起来，那是清单和源码脱节了 ✓）
 */
function moduleListFor(root = ROOT) {
  return MODULES.filter((n) => fs.existsSync(path.join(root, 'web', 'js', n)));
}

// ---------------------------------------------------------------- 假 DOM

//: 自闭合标签：它们不该被当成容器往栈上压
const VOID_TAGS = new Set(['BR', 'HR', 'IMG', 'INPUT', 'META', 'LINK', 'SOURCE', 'AREA', 'BASE', 'COL']);

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.style = {};
    this.dataset = {};
    /* ⚠ `add` / `remove` 要收**多个参数** ✗✗（2026-10-21 修）
     *   真 DOM 支持 `classList.add('a', 'b')` ✓ 但桩原来只认第一个 ✓
     *   → `th.classList.add('mob-btn', 'mob-theme')` 只会加上 `mob-btn` ✓
     *   → 主题按钮的 `.mob-theme`（手机顶栏那套样式）**永远没加上** ✓
     *   自检里看着像"补丁没写"，其实写了、被桩吃掉了 ✓
     *   （这是同一类坑的第三次了：**桩比真 DOM 弱** → 测试冤枉代码 ✓）*/
    this.classList = {
      _s: new Set(),
      add: (...cs) => { for (const c of cs) if (c) this.classList._s.add(c); },
      remove: (...cs) => { for (const c of cs) if (c) this.classList._s.delete(c); },
      toggle: (c, on) => {
        const want = on === undefined ? !this.classList._s.has(c) : !!on;
        if (want) this.classList._s.add(c); else this.classList._s.delete(c);
        return want;
      },
      contains: (c) => this.classList._s.has(c),
    };
    /* 🔴 **`className` 必须跟 `classList` 是同一份数据** ✗✗（2026-10-21 补）
     *
     *   桩原来根本没实现 `className` —— 往里写只是挂了个普通字段 ✓
     *   于是 `el.className = 'mob-group'` 之后 `classList.contains('mob-group')`
     *   还是 **false** ✓（真 DOM 里这两者是同一个东西 ✓）
     *
     *   后果：手机版那些 `g.className = 'mob-group'` / `pane.className = 'mob-pane'`
     *   造出来的节点，在自检里**全都没有 class** ✓
     *   → `.mob-group[data-group="display"]` 一条都查不到 ✓
     *   → 自检报"设置面板没建出来" ✓ 可**真机上它是好的** ✓
     *   —— 这种"测试撒谎"最坑：它会让人去改本来没坏的代码 ✓
     *
     *   ⚠ 反过来 `classList.add()` 之后读 `className` 也得能读到 ✓
     *     两边都走 `_s` 这个 Set 就行 ✓ */
    Object.defineProperty(this, 'className', {
      get: () => [...this.classList._s].join(' '),
      set: (v) => {
        this.classList._s.clear();
        for (const c of String(v || '').split(/\s+/)) {
          if (c) this.classList._s.add(c);
        }
      },
      configurable: true,
      enumerable: true,
    });
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = true;
    this._cw = 1280;
    this._ch = 820;
    this.width = 1280;
    this.height = 820;
    this.offsetWidth = 120;
    this.offsetHeight = 40;
    this._listeners = {};
    this._attrs = {};
    this.parentNode = null;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    /* **真把子节点造出来** ✓
     *
     * 手机端核心那句就是 `ui.innerHTML = '<div id="mob-topbar">…'`，
     * 之后全靠 `$('mob-sheet')` / `$('mob-backdrop')` 按 id 取回来 ✓
     * 只把字符串存起来、不造节点的话，那些节点永远取不到 ✗
     * （我第一版就是这样：#mob-ui 造出来了却"子节点 0 个"，
     *   看着像手机版坏了，其实是桩不解析 innerHTML）
     *
     * 只认**开标签**、靠 depth 收尾就够了 —— 真实 DOM 那套（文本节点、属性转义、
     * 注释）这里不需要，桩要的是"id 找得到、父子关系对" ✓
     */
    const stack = [this];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const closing = m[1] === '/';
      const tag = m[2].toUpperCase();
      const attrs = m[3] || '';
      if (closing) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const el = new El(tag);
      const idm = /\bid\s*=\s*["']([^"']*)["']/.exec(attrs);
      if (idm) el.id = idm[1];
      const clm = /\bclass\s*=\s*["']([^"']*)["']/.exec(attrs);
      if (clm) for (const c of clm[1].split(/\s+/)) if (c) el.classList.add(c);
      const attrsAll = attrs.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g);
      for (const a of attrsAll) el._attrs[a[1]] = a[2] !== undefined ? a[2] : a[3];
      stack[stack.length - 1].appendChild(el);
      // 自闭合标签（br / img / input / meta …）不当容器
      if (!m[4] && !VOID_TAGS.has(tag)) stack.push(el);
    }
  }
  get clientWidth() { stats.clientW++; return this._cw; }
  set clientWidth(v) { this._cw = v; }
  get clientHeight() { stats.clientH++; return this._ch; }
  set clientHeight(v) { this._ch = v; }
  appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; }
  insertBefore(c, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c);
    if (c) c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  }
  /* ⚠ 手机版教程那段用的是 `parentNode.replaceChild(fresh, help)`
   *   —— 桩没这个的话，**教程按钮换监听**那一步就静默跳过了 ✓（2026-10-21 补）
   *
   * 🔴 **换完之后必须把 id 索引指向新节点** ✗✗（2026-10-21 再补）
   *   不更新的话：`get('btn-tutorial')` 仍然返回**那个已经被摘下来的旧节点** ✓
   *   → 自检在上面派发 click ✓ 打中的是没有监听的空壳 ✓
   *   → "点教程弹介绍窗"永远是空的 ✓ 又是一次"看着测了、其实没测" ✓
   *   （真 DOM 里 `getElementById` 是按树找的 ✓ 换了节点自然就换 ✓ 桩是查表 ✓
   *     所以这里得手动把表改过来 ✓）
   */
  replaceChild(newNode, oldNode) {
    const i = this.children.indexOf(oldNode);
    if (i >= 0) this.children[i] = newNode;
    else this.children.push(newNode);
    if (newNode) newNode.parentNode = this;
    if (oldNode) oldNode.parentNode = null;
    if (El.onReplace && newNode && newNode.id) El.onReplace(newNode);
    return oldNode;
  }
  addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); }
  removeEventListener() {}
  /** 派发一次事件 —— 手机端那套按钮是"点一下开面板"，自检要能点 ✓ */
  dispatchEvent(ev) {
    const type = ev && ev.type;
    for (const fn of (this._listeners[type] || [])) fn(ev || { type, target: this });
    return true;
  }
  // ---- 属性：手机端生造那批按钮全靠这些 ✓（桩缺了它，bindMobile 第一步就抛）
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }
  hasAttribute(k) { return this._attrs[k] !== undefined; }
  focus() {}
  select() {}
  blur() {}
  /* 🔴 **`remove()` / `cloneNode()` 必须真有** ✗✗（2026-10-21 补）
   *
   *   桩一直缺这两个，而手机补丁里有两处真用到了：
   *     · `menu.remove()`   —— 「文件」下拉摊平之后把空壳摘掉 ✓
   *     · `help.cloneNode(true)` —— 教程按钮换掉旧监听（克隆一份，旧监听自然失效 ✓）
   *   桩没有 → 那两步各自抛进 `wait()` 的 catch 里**静默跳过** ✓
   *   → 自检一直报"通过"，但那两条路径**其实一次都没跑到** ✗
   *     （报错只在控制台里留下一行 `[手机版] xxx is not a function` ✓ 没人看 ✓）
   *   现在补上：文件面板和教程按钮那两条路才真的被验到 ✓
   */
  remove() {
    const p = this.parentNode;
    if (!p || !p.children) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentNode = null;
  }
  cloneNode(deep) {
    const c = new El(this.tagName.toLowerCase(), this.id);
    c._html = this._html;
    c.textContent = this.textContent;
    c.value = this.value;
    c.title = this.title;
    c.hidden = this.hidden;
    c.disabled = this.disabled;
    c.checked = this.checked;
    c.style = Object.assign({}, this.style);
    c.dataset = Object.assign({}, this.dataset);
    c._attrs = Object.assign({}, this._attrs);
    for (const k of this.classList._s) c.classList._s.add(k);
    if (deep) {
      // ⚠ 深拷贝只搬结构（子节点挂新父 ✓）—— 监听器**故意不复制** ✓
      //   真 DOM 的 cloneNode 也不复制通过 addEventListener 挂上的监听 ✓
      for (const ch of this.children) {
        const cc = ch.cloneNode ? ch.cloneNode(true) : null;
        if (cc) { cc.parentNode = c; c.children.push(cc); }
      }
    }
    return c;
  }
  contains(n) {
    if (!n) return false;
    if (this === n) return true;
    return this.children.some((c) => c && c.contains && c.contains(n));
  }
  /* 🔴🔴 **`closest(sel)`**（2026-10-21 补 ✓ 第 7 个模拟 DOM 缺口）
   *
   *   ⚠⚠ 这个缺口**一直在骗测试** ✗✗
   *     真 DOM 里 `e.target.closest('.zoom-box')` 能一路往上找 ✓
   *     桩里**根本没有 `closest`** ✓ → `t.closest` 是 `undefined` ✓
   *     → 凡是写成 `t.closest && t.closest(...)` 的守门**永远返回 false** ✓
   *   → 于是"点缩放按钮会不会误涂色"这种 bug **测不出来** ✓
   *     （用户 2026-10-21 报的正是这条 ✓ 我加完守门、跑测试却全绿 ✓
   *       因为那个守门在桩里压根没生效 ✓）
   *
   *   ⚠ 语义要跟真 DOM 一致：**从自己开始往上** ✓ 第一个匹配的就行 ✓
   *     `matches` 也一并补上 ✓ `closest` 就是靠它判断的 ✓ */
  matches(sel) {
    const s = String(sel || '').trim();
    if (!s) return false;
    return this._matchSel(s);
  }
  closest(sel) {
    const s = String(sel || '').trim();
    if (!s) return null;
    /* 逗号分组：只要命中其中一个就算 ✓ */
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    for (let n = this; n; n = n.parentNode) {
      if (n._matchSel && parts.some((p) => n._matchSel(p))) return n;
    }
    return null;
  }
  /** 在子树里按 id 找（真 DOM 的 getElementById 语义）—— 手机端"造出来再按 id 取回来"要用 ✓ */
  findById(id) {
    if (this.id === id) return this;
    for (const c of this.children) {
      if (!c || !c.findById) continue;
      const hit = c.findById(id);
      if (hit) return hit;
    }
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight,
             right: this.clientWidth, bottom: this.clientHeight };
  }
  getContext(kind) { return kind === '2d' ? ctx2d() : fakeGL(); }
  /** 桩里的画布也能“编码”一张 PNG：只回一个带 PNG 头的假 Blob ✓
   *  导出链路（进度 / 看门狗 / 释放画布）要有地方验，真像素这里不看 ✓ */
  toBlob(cb, type) {
    setTimeout(() => {
      try { cb(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
        { type: type || 'image/png' })); } catch (e) { cb(null); }
    }, 0);
  }
  /* 🔴 **子树查询要真的能查** ✗✗（2026-10-19 ✓ 2026-10-21 升级）
   *   原来是两个空壳（`return []` / `return null`）✓
   *   剧本下拉栏那段用 `btn.querySelector('.dd-label')`、`panel.querySelectorAll('[data-role="era-item"]')`
   *   —— 空壳会让它们拿不到东西 ✓ 于是测试里"下拉栏按钮上的字"永远是空的 ✓
   *
   *  🔴🔴 **2026-10-21：从"一次只认一种"改成"复合选择器逐项都验"** ✗✗
   *   原来那段是 if / else 链 ✓ 只看**一种**写法：
   *     `if (dr) … else if (cl) … else if (idm) …`
   *   → `.mob-group[data-group="display"]` 这种**类名 + 属性**的组合 ✗
   *     它只会走 `cl` 那一支 → **把所有 `.mob-group` 全命中了** ✓
   *     （`env.documentStub.querySelector('.mob-group[data-group="display"]')`
   *       返回的是第一个 .mob-group（color 那个）✓ 于是"设置面板"永远找不到 ✓）
   *   ⚠ 而且属性只认 `data-role` 一个名字 ✗ `data-group` / `data-pane` 全当没看见 ✓
   *
   *   现在：把选择器切成"单个复合段"，**每一段里的 #id / .class / [attr] / tag
   *   必须同时满足** ✓ 段与段之间按后代处理（整棵子树都翻 ✓ 够用 ✓）*/
  _matchSel(sel) {
    /* ⚠ 参数**只有一个**（选择器字符串）✗ 一开始我写成 `_matchSel(c, s)`
     *   可调用处是 `c._matchSel(s)` —— `c` 就是 this 本身，不用再传 ✓
     *   结果：`String(sel)` 拿到的是 undefined → 空 → 恒 false ✓
     *   （所以那会儿读 @ts-check 是没用的，得**真跑一次**才看得出来 ✓）*/
    const s = String(sel || '');
    // 取最后一段复合选择器（空格 / > 之后那段）—— 桩不做父子精确，后代语义就够 ✓
    const parts = s.trim().split(/[\s>]+/).filter(Boolean);
    const seg = parts[parts.length - 1] || '';
    if (!seg) return false;
    const c = this;
    // 按 token 逐个验，**全部满足**才算命中 ✓（这就是复合选择器的意思）
    const tokens = seg.match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|[a-zA-Z][\w-]*/g) || [];
    if (!tokens.length) return false;
    for (const t of tokens) {
      if (t[0] === '#') {
        if (c.id !== t.slice(1)) return false;
      } else if (t[0] === '.') {
        if (!(c.classList && c.classList.contains(t.slice(1)))) return false;
      } else if (t[0] === '[') {
        // [attr] / [attr="v"] / [attr='v'] 都认 ✓（属性名不再写死 data-role ✓）
        const m = /^\[\s*([\w-]+)\s*(?:=\s*['"]?([^'"\]]*)['"]?)?\s*\]$/.exec(t);
        if (!m) return false;
        const got = c._attrs ? c._attrs[m[1]] : undefined;
        if (m[2] === undefined) { if (got === undefined) return false; }
        else if (String(got) !== m[2]) return false;
      } else {
        if (!c.tagName || String(c.tagName).toLowerCase() !== t.toLowerCase()) return false;
      }
    }
    return true;
  }
  _all(sel, out) {
    const s = String(sel || '').trim();
    for (const c of this.children) {
      if (!c || !c._all) continue;
      if (c._matchSel && c._matchSel(s)) out.push(c);
      c._all(sel, out);          // 继续往下翻（真 DOM 也是全子树 ✓）
    }
    return out;
  }
  querySelectorAll(sel) { return this._all(sel, []); }
  querySelector(sel) { return this._all(sel, [])[0] || null; }
  click() { this.dispatchEvent({ type: 'click', target: this }); }
  /** 递归拼出子树里的文本，方便断言
   *  （innerHTML 现在会真造子节点，所以有子节点就以子节点为准 ——
   *    不然 _html 和 children 各拼一遍，同一段文字会出现两次 ✗） */
  flat() {
    const own = this.children.length ? '' : (this._html || '');
    return own + this.children.map((c) => c.flat()).join(' | ') +
      (this.textContent ? ' ' + this.textContent : '');
  }
}

/** Canvas2D 的调用计数 —— 量标注层每帧到底调了多少次贵操作 */
const stats = { font: 0, measure: 0, stroke: 0, fill: 0, image: 0, clientW: 0, clientH: 0 };
function resetCanvasStats() {
  for (const k of Object.keys(stats)) stats[k] = 0;
}

function ctx2d() {
  const noop = () => {};
  const o = {
    textAlign: '', textBaseline: '', lineJoin: '', miterLimit: 0, lineWidth: 0,
    strokeStyle: '', fillStyle: '',
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: noop, arcTo: noop, arc: noop, rect: noop, quadraticCurveTo: noop,
    fill() { stats.fill++; }, stroke() { stats.stroke++; },
    fillRect() { stats.fill++; }, strokeRect() { stats.stroke++; }, clearRect: noop,
    translate: noop, scale: noop, rotate: noop, setLineDash: noop, clip: noop,
    setTransform: noop,
    measureText: (t) => { stats.measure++; return { width: String(t).length * 7 }; },
    strokeText: () => { stats.stroke++; },
    fillText: () => { stats.fill++; },
    drawImage: () => { stats.image++; },
    /* 🔴 **图像数据这三件必须有** ✗✗（2026-10-20 ✓）
     *   位图字体（`.fnt` + `.dds`）是靠 `createImageData` 把字形铸成小 canvas 的 ✓
     *   桩里没有它 → 导入流程在"画预览"那步抛异常 →
     *   被导入的 catch 接住 → 弹出「这个字体没能导入」✓
     *   真浏览器有这三个，所以**这个坑只在桩里露头** —— 也正因为如此，
     *   以前那套自检根本发现不了位图字体这条路是断的 ✓
     *   补上之后，`check_fonts` / `test_modes` 能真跑到"逐字贴图"那一步 ✓ */
    createImageData: (w, h) => ({
      width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    }),
    putImageData: () => { stats.image++; },
    getImageData: (x, y, w, h) => ({
      width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    }),
    globalCompositeOperation: 'source-over',
  };
  Object.defineProperty(o, 'font', {
    get() { return this._font || ''; },
    set(v) { this._font = v; stats.font++; },
  });
  return o;
}

/** WebGL：Proxy 兜住 —— 真渲染不验，只求 gl.js 不炸 */
/*: 让前 N 次 linkProgram 失败（2026-10-27：验证「完整版失败 → 中间档 → 精简版」的顺序） */
let forceLinkFail = 0;
function setForceLinkFail(n) { forceLinkFail = Math.max(0, n | 0); }
function fakeGL() {
  const t = {};
  let linkCalls = 0;
  let linkFailed = false;
  return new Proxy(t, {
    get(_, k) {
      const s = String(k);
      if (s in t) return t[s];
      if (/^[A-Z0-9_]+$/.test(s)) return 1;                  // 常量
      return (...a) => {
        if (s.startsWith('create')) return { __m: s };
        if (s === 'getUniformLocation') return { __m: 'loc', name: a[1] };
        if (s === 'getAttribLocation') return 0;
        if (s === 'getParameter') return 16384;                // MAX_TEXTURE_SIZE 之类
        if (s === 'linkProgram') {
          linkCalls++;
          linkFailed = linkCalls <= forceLinkFail;
          return undefined;
        }
        if (s === 'getProgramParameter') return !linkFailed;
        if (s === 'getShaderParameter') return true;
        if (s === 'getExtension') return null;
        if (s.startsWith('get')) return 0;
        return undefined;
      };
    },
  });
}

// ---------------------------------------------------------------- 一整套环境

/**
 * 造一套假环境（假 DOM / 假 localStorage / 假 fetch / 假 RAF）。
 *
 * @param {object} [opt]
 * @param {object} [opt.embedded] 单文件版的 window.__CK3_EMBEDDED__（走服务时留空）
 * @param {string} [opt.root]     数据根目录（fetch 从这儿读磁盘）
 */
function makeEnv(opt = {}) {
  const root = opt.root || ROOT;
  const els = new Map();
  /* ⚠ **`replaceChild` 换掉带 id 的节点时，索引也得跟着换** ✗
   *   真 DOM 的 `getElementById` 是按树找的 ✓ 换节点自然就换 ✓
   *   桩是查表 ✓ 不更新就永远返回旧节点 ✓（2026-10-21 踩过）*/
  El.onReplace = (n) => { if (n && n.id) els.set(n.id, n); };
  const containers = { tier: new El(), tool: new El() };
  const bodyEl = new El('body');
  /**
   * getElementById —— **先在树里找，再退回懒建的桩** ✓
   *
   * 手机端那套是"createElement 造按钮 → appendChild 挂进去 → 之后按 id 取回来"，
   * 所以只认懒建 map 的桩会让它第二步就找不到节点 ✗（我第一版就是这样，
   * bindMobile 一跑就炸 setAttribute —— 看着像手机版坏了，其实是桩不忠实）
   *
   * 三个地方都要翻：
   *   ① 已经懒建出来那个节点自己的名字
   *   ② **懒建节点的子树** —— 手机端把 #mob-ui 挂在 #app 底下，
   *      而 #app 是懒建的桩、不在 body 的子树里，只搜 body 会漏掉它 ✗
   *   ③ body 的子树
   */
  const get = (id) => {
    const direct = els.get(id);
    if (direct) return direct;
    for (const el of els.values()) {
      const hit = el.findById(id);
      if (hit) return hit;
    }
    const inBody = bodyEl.findById(id);
    if (inBody) return inBody;
    const fresh = new El('div', id);
    els.set(id, fresh);
    return fresh;
  };

  /* ==========================================================================
   * 🔴 **桌面设置页的骨架**（2026-10-21 加）
   *
   *   桩从来不解析 index.html ✗ —— `$('settings')` 拿到的是个**懒建的空 div** ✓
   *   于是手机版那句 `modal.querySelector('.set-grid')` 永远 null ✓
   *   → 「把桌面设置搬进手机面板」那段**一次都没真正跑过** ✓
   *     自检一直是绿的，因为搬失败也不抛错（外面套着 `wait()` 的 catch ✓）
   *
   *   要验"搬对了没有"，起码得让那几个节点**存在** ✓
   *   这里按 index.html 的真实结构懒建一份（**只建选择器要用到的那几层** ✗
   *   不是要造一整个 DOM ✓）：
   *     #settings.modal > .modal-box.set-box
   *       ├ .set-tabs (四个 .set-tab[data-group] + #btn-theme + #set-close)
   *       ├ .set-grid#set-grid[data-active]
   *       │   └ section.set-col[data-group=color|border|label|legend]
   *       └ .set-foot > #set-dirty + #set-reset-group + #set-reset
   *
   *   ⚠ 每个 `.set-col` 里放**一个好认的控件** ✓ 够验"它落到哪一页" ✓
   *     真实控件（set-bg / set-pa / set-font-place / set-legend-title）
   *     本来就由 `get()` 懒建 ✓ 这里把它们的 id 记进对应那一栏 ✓
   *     —— 这样"搬完之后控件在哪一页"就查得出来了 ✓
   * ========================================================================== */
  const settingsStub = {
    cols: null,           // { color: el, border: el, ... }
    foot: null,
    ensure() {
      if (this.cols) return;
      const modal = get('settings');
      modal.classList.add('modal', 'drawer');
      modal.hidden = true;

      const box = new El('div');
      box.className = 'modal-box set-box';
      modal.appendChild(box);

      const tabs = new El('div');
      tabs.className = 'set-tabs';
      tabs.id = 'set-tabs';
      box.appendChild(tabs);
      for (const g of ['color', 'border', 'label', 'legend']) {
        const b = new El('button');
        b.className = 'set-tab' + (g === 'color' ? ' on' : '');
        b._attrs['data-group'] = g;
        b.textContent = { color: '颜色', border: '边界线', label: '名称', legend: '图例' }[g];
        tabs.appendChild(b);
      }
      const sp = new El('span');
      sp.className = 'set-tabs-sp';
      tabs.appendChild(sp);
      // #btn-theme 由 get() 懒建 ✓ 这里只把它挂进标签行（手机版要把它搬去顶栏 ✓）
      tabs.appendChild(get('btn-theme'));

      const grid = new El('div');
      grid.className = 'set-grid';
      grid.id = 'set-grid';
      grid._attrs['data-active'] = 'color';
      box.appendChild(grid);

      this.cols = {};
      /* 每一栏放一个"好认的控件" ✓ id 跟 index.html 里真实的一致 ✓ */
      const SPEC = {
        color: ['set-bg', '无主地 / 地形底色'],
        border: ['set-pa', '省份边界浓度'],
        label: ['set-font-place', '地块名字体'],
        legend: ['set-legend-title', '图例标题'],
      };
      for (const g of ['color', 'border', 'label', 'legend']) {
        const col = new El('section');
        col.className = 'set-col';
        col._attrs['data-group'] = g;
        grid.appendChild(col);
        this.cols[g] = col;

        const sub = new El('div');
        sub.className = 'set-sub';
        sub.textContent = SPEC[g][1];
        col.appendChild(sub);

        const [id, label] = SPEC[g];
        const row = new El('label');
        row.className = 'set-row';
        const l = new El('span');
        l.className = 'set-l';
        l.textContent = label;
        row.appendChild(l);
        const ctl = get(id);           // ⚠ get() 懒建的那个才是**全局唯一**那个 ✓
        row.appendChild(ctl);
        col.appendChild(row);
      }
      /* 桌面分页会把非当前页藏起来 ✓ 照做 —— 手机版**必须**把它们清掉 ✓
       *   （这条正是 2026-10-21 那个 bug 的现场：清了才对，不清就是"节点在、看不见"）*/
      for (const g of ['border', 'label', 'legend']) this.cols[g].hidden = true;

      const foot = new El('div');
      foot.className = 'set-foot';
      box.appendChild(foot);
      this.foot = foot;
      const dirty = get('set-dirty'); dirty.className = 'set-dirty'; dirty.textContent = '已改动 0 项';
      foot.appendChild(dirty);
      const rg = get('set-reset-group'); rg.className = 'btn ghost'; rg.hidden = true;
      foot.appendChild(rg);
      const rs = get('set-reset'); rs.className = 'btn'; rs.textContent = '全部恢复默认';
      foot.appendChild(rs);

      // 隐藏的桌面弹窗：内容搬走之前它一直隐藏着 ✓（真机上就是这样 ✓）
      modal.hidden = true;
    },
  };

  /* 🔴🔴 **顶栏最小骨架**（2026-10-21 加 ✓ 第 8 个模拟 DOM 缺口）
   *
   *   ⚠⚠ 桩**从来不解析 `index.html`** ✗
   *   → `$('btn-tutorial')` 拿到的是**懒建的空 div、没有 parentNode** ✓
   *   → 凡是要"从父节点上换掉它"的写法（`cloneNode` + `replaceChild` ✓
   *     用来摘掉别的模块挂上的监听 ✓）在测试里**第一句就 return 了** ✓
   *   → 于是"点教程弹什么"根本测不到 ✓ 自检还说全绿 ✓（2026-10-21 就这样）
   *
   *   这里只补**够用**的那几个：`#btn-sidebar` / `.brand` / `#help-row > #btn-tutorial` ✓
   *   ⚠ 别贪多 ✗ 补得越多、跟真 `index.html` 走偏的风险越大 ✓
   *     真需要整条顶栏时，请照 `index.html` 一比一地补 ✓ 别凭印象编 ✓
   */
  const toolbarStub = {
    done: false,
    ensure() {
      if (this.done) return;
      this.done = true;
      const app = get('app');
      if (app.querySelector && app.querySelector('.toolbar')) return;

      const header = new El('header');
      header.className = 'toolbar';

      const sb = new El('button', 'btn-sidebar');
      sb.className = 'btn ghost';
      sb.textContent = '☰';

      const brand = new El('div');
      brand.className = 'brand';
      const brandMark = new El('span', 'brand-mark');
      brandMark.className = 'brand-mark';
      brandMark.textContent = 'PDX';
      brand.appendChild(brandMark);

      const help = new El('div', 'help-row');
      help.className = 'tool-group actions';
      const tut = new El('button', 'btn-tutorial');
      tut.className = 'btn ghost';
      tut.textContent = '教程';
      help.appendChild(tut);

      header.appendChild(sb);
      header.appendChild(brand);
      header.appendChild(help);
      app.appendChild(header);

      /* ⚠ 必须登记进 `els` ✗ 不然 `get()` 还会另建一个空的 ✓ 那就白搭了 ✓ */
      els.set('btn-sidebar', sb);
      els.set('btn-tutorial', tut);
      els.set('help-row', help);
      els.set('brand-mark', brandMark);
    },
  };

  /* **手机版/桌面版都要有一份设置骨架** ✓
   *   桌面版 app.js 的 `applyTab` 会 `grid.querySelectorAll('.set-col')` ✓
   *   桩里没有的话那一步也是空转 ✓（不抛错，但也没测到东西 ✓）
   *   → 默认为真，建一份 ✓ */
  if (opt.settingsStub !== false) settingsStub.ensure();
  if (opt.toolbarStub !== false) toolbarStub.ensure();

  /* **window / document 上的监听别一律丢掉** ✗
   *   原来是个空函数 ✓ 于是"回到前台"（visibilitychange）这类
   *   只挂在 window/document 上的行为**根本没法测** ✗
   *   现在照样记下来，自检可以自己派一发（见 dispatchWindow / dispatchDocument ✓）
   *   ⚠ 语义照着浏览器来：addEventListener 收进去、派发时按顺序调 ✓ */
  const listeners = { window: {}, document: {} };
  const listen = (bag) => (t, fn) => { (bag[t] || (bag[t] = [])).push(fn); };
  const fire = (bag) => (type, ev) => {
    const list = bag[type] || [];
    for (const fn of list) fn(Object.assign({ type, target: null }, ev || {}));
    return list.length;
  };

  const documentStub = {
    title: '',
    hidden: false,               // 自检要能演"切后台 / 回前台" ✓
    getElementById: get,
    createElement: (t) => new El(t),
    addEventListener: listen(listeners.document),
    querySelector: (sel) => {
      if (sel.includes('tier')) return containers.tier;
      if (sel.includes('tool')) return containers.tool;
      /* 🔴 剧本下拉栏那几个（2026-10-19 ✓）—— 桩不解析 index.html，
       *   所以按 `data-role` **懒建一个**再记住 ✓ 跟 getElementById 一个套路 ✓ */
      const m = /\[data-role\s*=\s*["']([^"']+)["']\]/.exec(sel);
      if (m) {
        const key = 'role:' + m[1];
        if (!els.has(key)) {
          const el = new El(m[1] === 'era-btn' ? 'button' : 'div');
          el._attrs['data-role'] = m[1];
          els.set(key, el);
        }
        return els.get(key);
      }
      return bodyEl.querySelector(sel);
    },
    querySelectorAll: (sel) => {
      if (sel.includes('tier')) return containers.tier.children
        .filter((c) => !/\bbutton\b/.test(sel) || String(c.tagName).toLowerCase() === 'button');
      if (sel.includes('tool')) return containers.tool.children
        .filter((c) => !/\bbutton\b/.test(sel) || String(c.tagName).toLowerCase() === 'button');
      const m = /\[data-role\s*=\s*["']([^"']+)["']\]/.exec(sel);
      if (m) {
        const key = 'role-list:' + m[1];
        if (!els.has(key)) els.set(key, new El('div'));
        return els.get(key).children;
      }
      return [];
    },
    elementFromPoint: () => null,
    body: bodyEl,
    documentElement: new El('html'),
    head: new El('head'),
  };

  let savedBlob = null;
  const store = new Map();
  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const rafs = [];
  const windowStub = {
    addEventListener: listen(listeners.window),
    devicePixelRatio: 1,
    __CK3_EMBEDDED__: opt.embedded,
    confirm: () => true,
    // 真浏览器里 window.console 当然有 —— 报错日志拦的就是这一份 ✓
    // 以前桩里没有它，于是"拦 console"那条路在自检里**一次都没跑到过** ✗
    console,
  };
  const sandbox = {
    console,
    document: documentStub,
    window: windowStub,
    localStorage: localStorageStub,
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, Blob, Response, Request, Headers, DecompressionStream,
    fetch: async (url) => {
      const rel = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) return new Response('', { status: 404 });
      const buf = fs.readFileSync(file);
      return new Response(buf, { status: 200, headers: { 'Content-Length': String(buf.length) } });
    },
  };
  sandbox.window.document = documentStub;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  /* IndexedDB：默认给桩 ✓
     opt.idb === false 时装成"没有这个 API"—— 用来测"隐私模式 / 老浏览器"那条降级路
     （那条路必须**明确告诉玩家刷新会丢**，不能假装存上了 ✗） */
  if (opt.idb === false) {
    sandbox.indexedDB = undefined;
    sandbox.IDBKeyRange = undefined;
  } else {
    sandbox.indexedDB = opt.indexedDB || makeIndexedDBFake();
    sandbox.IDBKeyRange = makeKeyRangeFake();
  }

  const RealURL = URL;
  sandbox.URL = class extends RealURL {
    static createObjectURL(b) { savedBlob = b; return 'blob:fake'; }
    static revokeObjectURL() {}
  };

  return { sandbox, get, containers, rafs, store, documentStub,
           /* 自检用：往 window / document 上派发一次事件 ✓
            *   派"回到前台"：dispatchDocument('visibilitychange')（document.hidden 自己先改成 false ✓）*/
           dispatchWindow: fire(listeners.window),
           dispatchDocument: fire(listeners.document),
           get savedBlob() { return savedBlob; } };
}

/**
 * 把拍平后的源码跑起来（等价于单文件版那个 <script> 干的事）。
 *
 * 结尾的 `boot();` 会被摘掉，改成由调用方自己触发（测试要控时序）；
 * 并且额外 return 一批探针出去 —— 自测与基准靠这些内部函数验行为 / 掐表。
 * 探针写宽一点没关系（多给几个引用而已），但**加新探针请加在这里**，
 * 别在各自的入口里再 return 一遍。
 *
 * 名字不一致的地方（老代码叫 paintIdentOf / playerGroupPidsAt）在下面用 typeof 兜住，
 * 于是同一把尺子既能量改动前的源码、也能量改动后的（见 bench_core 的 PDX_SRC）✓
 *
 * @param {string} js   拍平后的源码
 * @param {object} env  makeEnv() 的结果
 */
function instantiate(js, env) {
  // 行尾两种都要认：工作区是 CRLF（core.autocrlf=true 检出来的），
  // 仓库里是 LF —— 只写 \n 的话在 CRLF 工作区**根本匹配不上**，
  // 于是那个 boot(); 留着没摘，跑起来就变成"src 自己跑一次 + 调用方再跑一次"，
  // 日志与状态各初始化两遍 ✗（这个坑是给报错日志验"启动"轨迹时露出来的）
  let src = js.replace(/\r?\nboot\(\);\r?\n/, '\n');
  src += `
var _C = {};
function _p(k, v) { if (v !== undefined) _C[k] = v; }
_p('boot', boot); _p('state', state); _p('MAP_CHOICES', MAP_CHOICES);
_p('GAMES', GAMES); _p('frame', frame);
_p('titleAt', titleAt); _p('renderHoverCard', renderHoverCard); _p('actAt', actAt);
_p('pickTitle', pickTitle); _p('paintTitle', paintTitle); _p('restoreTitle', restoreTitle);
_p('undo', undo); _p('redo', redo); _p('recomputePainted', recomputePainted);
/* 2026-10-27 v1.10.1：清除全部要能撤销 / 保存地图默认名 ✓ */
_p('resetAll', resetAll); _p('defaultSaveName', defaultSaveName); _p('openSaveMapDialog', openSaveMapDialog);
/* 2026-10-27：导出整图弹窗（规格 / 范围 / 进度）✓
   框选按绘图软件那套：八个把手 / 移动 / 确认，导出纯函数给自测用 ✓ */
_p('openExportDialog', openExportDialog); _p('_exportDlg', _exportDlg); _p('_exportMetrics', _exportMetrics);
_p('_exportRefresh', _exportRefresh); _p('_exportPickStart', _exportPickStart);
_p('_exportTileSize', _exportTileSize);
_p('_exportPickState', _exportPickState); _p('_exportPickNorm', _exportPickNorm);
_p('_exportPickResizeRect', _exportPickResizeRect); _p('_exportPickConfirm', _exportPickConfirm);
_p('_exportPickCancel', _exportPickCancel); _p('_exportPickRender', _exportPickRender);
_p('_exportSizeInput', _exportSizeInput); _p('_exportSizeCommit', _exportSizeCommit);
_p('exportFullPNG', exportFullPNG);
_p('provInfoAt', provInfoAt); _p('paintTargetsAt', paintTargetsAt);
_p('labelMaxValue', labelMaxValue); _p('buildBorderEdges'); _p('buildBorderDepth', buildBorderDepth); _p('refreshBorderField', refreshBorderField); _p('editTier', editTier);
_p('saveMapPrefs', saveMapPrefs); _p('loadMapPrefs', loadMapPrefs);
_p('paintPids', paintPids); _p('paintPidsAsOne', paintPidsAsOne);
_p('pickAt', pickAt); _p('setBrush', setBrush); _p('setTier', setTier); _p('setTool', setTool);
_p('needsRestore', needsRestore); _p('isLocked', isLocked); _p('updateCursor', updateCursor); _p('provinceAt', provinceAt); _p('isPaintable', isPaintable); _p('pickMarkerName', pickMarkerName); _p('waterKindByPid', waterKindByPid); _p('buildSeaLabelPoints', buildSeaLabelPoints); _p('kindOfTid', kindOfTid); _p('kindTidMap', kindTidMap); _p('NO_TITLE', NO_TITLE); _p('syncLayerSwitches', syncLayerSwitches); _p('isWastelandTile', isWastelandTile); _p('isSpecialTid', isSpecialTid);
_p('runSearch', runSearch); _p('jumpToResult', jumpToResult); _p('searchJumpScale', searchJumpScale);
/* 荒地自动上色（2026-10-17 重做 ✓）—— 周长 / 重算 / 帧循环那三句导出来给自测用 ✓ */
_p('buildWastePidIndex', buildWastePidIndex); _p('setupWastePerimeter', setupWastePerimeter);
_p('refreshWasteAuto', refreshWasteAuto); _p('wasteWatch', wasteWatch);
_p('displayedColor', displayedColor); _p('displayedLabel', displayedLabel);
_p('syncParentBorder', syncParentBorder); _p('syncLayerSwitches', syncLayerSwitches);
_p('retintCountryLabels', retintCountryLabels);
_p('syncAllPaintLabels', syncAllPaintLabels);
_p('editTier', editTier); _p('setGrain', setGrain); _p('gotoLevel', gotoLevel);
/* **层级 / 显示那几个纯函数也导出来** ✓（2026-10-14 ✓ 为了能实测）
 *   「applyEditTier」—— "层级/粒度一变就跑"的那个 ✓（setTier/setGrain 都调它 ✓）
 *   「labelTier」    —— 显示那一层（高亮 / 名字 / 水域内部边界 ✓）
 *   「viewTierFor」  —— 按这一格挑层（有主→视图层 / 无主→最低层 ✓）
 *   「isWaterPid」   —— 查 waterMask 那个"小标签" ✓
 *   ⚠ 之前没导 → 探针里 ex.applyEditTier 是 undefined ✗
 *     于是"实测"静默跳过、结果全是旧值 ✓（我差点又被它骗一次 ✓）
 *   ⚠⚠ **这段整体在模板字符串里** ✗ —— 注释里**不许出现反引号** ✓
 *     （我在 gl.js 那边已经栽过一次了 ✓ 见 docs 里那条教训 ✓）*/
_p('applyEditTier', applyEditTier); _p('labelTier', labelTier);
_p('viewTierFor', viewTierFor); _p('isWaterPid', isWaterPid);
_p('pressTier', pressTier); _p('eraTierCount', eraTierCount);
_p('refreshTierButtons', refreshTierButtons);
_p('projectData', projectData); _p('saveProject', saveProject); _p('applyProject', applyProject);
/* 🗺 地图仓库 + 🎨 收藏调色板（2026-10-24 ✓）—— 自测要实测存取往返 ✓ */
_p('listMaps', listMaps); _p('putMap', putMap); _p('getMap', getMap); _p('deleteMap', deleteMap);
_p('paletteList', paletteList); _p('paletteAdd', paletteAdd); _p('paletteRemoveAt', paletteRemoveAt); _p('paletteReset', paletteReset);
_p('labelForColor', labelForColor);
_p('isDegradedBaron', isDegradedBaron); _p('screenToMap', screenToMap);
_p('updateHover', updateHover); _p('rebuildPaintBlocks', rebuildPaintBlocks);
_p('paintedPoints', paintedPoints); _p('playerGroupTidsAt', playerGroupTidsAt);
_p('paintAt', paintAt); _p('hoverGroupRgb', hoverGroupRgb); _p('stableColor', stableColor);
_p('hoverTargetTid', hoverTargetTid); _p('applyHoverHighlight', applyHoverHighlight);
_p('readablePlaceName', readablePlaceName); _p('manualWaterName', manualWaterName);
_p('drawLabels', drawLabels); _p('legendEntries', legendEntries);
_p('legendOpts', legendOpts); _p('refreshLegendFonts', refreshLegendFonts);
/* 整图导出的名字（2026-10-27 用户："手机版导出地图没有附赠名字"）
 * 自检要量：手机宽度下 export 也该按 1600px 参考视口放行国名 ✓ */
_p('paintLabelsForExport', paintLabelsForExport);
/* 2026-10-27 用户："导出的时候只有字体大于 15px 的才扔进去" —— 自检要直接量阈值 ✓ */
_p('exportFontPx', exportFontPx);
/* 色块名单（blockLabelPoints）—— 2026-10-27 自检要用：
 *   清除 / 切无剧本之后，这份缓存必须立刻变空 ✓ 不是等下一次涂色才更新 ✓
 *   ⚠ 这段在模板字符串里 ✗ 注释里不许出现反引号 ✓ */
_p('blockLabelPoints', blockLabelPoints);
/* **地名的连通域取点** ✓（2026-10-16 ✓ 探针 / test_modes 要能量它 ✓） */
_p('buildPlaceComponents', buildPlaceComponents); _p('placePointsFor', placePointsFor);
_p('groupComponents', groupComponents); _p('labelPlaceMaxValue', labelPlaceMaxValue);
_p('drawLegend', drawLegend); _p('legendLayout', legendLayout);
_p('renderLegendOverlay', renderLegendOverlay); _p('rebuildLegendPanel', rebuildLegendPanel);
_p('syncLegendControls', syncLegendControls); _p('bindLegendControls', bindLegendControls);
_p('_legendCustomFromBox', _legendCustomFromBox);
_p('impassLabel', impassLabel); _p('specialTileLabel', specialTileLabel);
_p('categoryNameOf', categoryNameOf); _p('nameIsMeaningful', nameIsMeaningful);
_p('realNameAtTier', realNameAtTier); _p('isWaterKey', isWaterKey);
_p('hoverSubName', hoverSubName); _p('kindOfPid', kindOfPid);
_p('computeLabelZoom', computeLabelZoom); _p('applySettings', applySettings);
_p('fitView', fitView); _p('minScale', minScale);
_p('lutColorOf', lutColorOf);
_p('hexToRgb', hexToRgb); _p('renameAt', renameAt); _p('openRename', openRename);
_p('exportLog', exportLog); _p('showFatal', showFatal);
if (typeof ARRIVE_SPAN !== 'undefined') _C.ARRIVE_SPAN = ARRIVE_SPAN;
if (typeof playerGroupTids !== 'undefined') _C.playerGroupTids = playerGroupTids;
if (typeof titleInfo !== 'undefined') _C.titleInfo = titleInfo;
// 新旧两个版本的名字不一样：老代码里是 playerGroupPidsAt / paintIdentOf / sameBlockPids，
// 改造后收成了 paintIdentAt。这里两个都给，于是同一把尺子能同时量"改动前"和"改动后" ✓
if (typeof playerGroupPidsAt !== 'undefined') _C.playerGroupPidsAt = playerGroupPidsAt;
if (typeof paintIdentAt !== 'undefined') _C.paintIdentAt = paintIdentAt;
if (typeof paintIdentOf !== 'undefined') _C.paintIdentOf = paintIdentOf;
if (typeof sameBlockPids !== 'undefined') _C.sameBlockPids = sameBlockPids;
// ⚠ renderer / labels 是 boot() 里才赋值的（模块级 let，初值 null）✗ ——
//   不能直接拷值：那是"取值快照"，拷进 _C 的永远是那个 null，
//   boot 之后再怎么建也追不上（踩过：单文件自检报"渲染器没建起来"，其实建了）
//   （注意这段是在模板字符串里，注释里别出现反引号 ✗）
// 地图包那套（pack.js / packstore.js / data.js 的第三数据源）——
// 用 typeof 兜住：换源代码（没有这几个文件时）照样能跑，同一把尺子两版都能量 ✓
if (typeof importPack !== 'undefined') _p('importPack', importPack);
if (typeof listPacks !== 'undefined') _p('listPacks', listPacks);
if (typeof getPack !== 'undefined') _p('getPack', getPack);
if (typeof removePack !== 'undefined') _p('removePack', removePack);
if (typeof exportPackBytes !== 'undefined') _p('exportPackBytes', exportPackBytes);
if (typeof packStoreMode !== 'undefined') _p('packStoreMode', packStoreMode);
if (typeof validatePack !== 'undefined') _p('validatePack', validatePack);
if (typeof readZip !== 'undefined') _p('readZip', readZip);
if (typeof makeZip !== 'undefined') _p('makeZip', makeZip);
if (typeof makeZipAsync !== 'undefined') _p('makeZipAsync', makeZipAsync);
if (typeof setPackMap !== 'undefined') _p('setPackMap', setPackMap);
if (typeof isPackMap !== 'undefined') _p('isPackMap', isPackMap);
if (typeof setDataDir !== 'undefined') _p('setDataDir', setDataDir);
if (typeof setEmbeddedMap !== 'undefined') _p('setEmbeddedMap', setEmbeddedMap);
if (typeof isEmbedded !== 'undefined') _p('isEmbedded', isEmbedded);
if (typeof api !== 'undefined') _p('api', api);
_p('LOG', window.PDXLOG);
Object.defineProperty(_C, 'renderer', { get: function () { return renderer; }, enumerable: true });
Object.defineProperty(_C, 'labels', { get: function () { return labels; }, enumerable: true });
/* GAME / TIER_BADGE 也是 boot() 里才按选中的图赋值的（模块级 let）✗
   跟上面 renderer / labels 同一个坑：拷值等于永远停在 GAMES.ck3 那个初值，
   测"选了一张 EU4 的图，术语应该跟着变成 EU4"就会假失败 ✗ —— 所以也改成活取 ✓ */
Object.defineProperty(_C, 'GAME', { get: function () { return GAME; }, enumerable: true });
Object.defineProperty(_C, 'TIER_BADGE', { get: function () { return TIER_BADGE; }, enumerable: true });
/* ⚠ TIER_HOTKEY 也是 boot 里按层数**重新生成**的模块级 let ✓
 *   拷值 = 永远停在初值 1~5 ✗ 测"快捷键只编地理层"就会假失败 ✓
 *   ⚠ 这段在**模板字符串**里 ✗ 注释里不许出现反引号（会把模板截断 ✓）
 *     2026-10-20 我又踩了一次 ✓ 所以改成全角引号 ✓ */
Object.defineProperty(_C, 'TIER_HOTKEY', { get: function () { return TIER_HOTKEY; }, enumerable: true });
return _C;`;
  const s = env.sandbox;
  const factory = new Function(
    'console', 'document', 'window', 'localStorage', 'performance',
    'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'fetch', 'URL', 'TextEncoder', 'TextDecoder',
    'Blob', 'Response', 'indexedDB', 'IDBKeyRange', src);
  return factory(s.console, s.document, s.window, s.localStorage, s.performance,
    s.requestAnimationFrame, s.cancelAnimationFrame, s.setTimeout, s.clearTimeout,
    s.setInterval, s.clearInterval, s.fetch, s.URL, s.TextEncoder, s.TextDecoder,
    s.Blob, s.Response, s.indexedDB, s.IDBKeyRange);
}

/**
 * 从烤好的单文件 HTML 里取出内嵌数据 + 拍平脚本。
 *
 * 这是**唯一**一条真正验证发布产物的路：原来没人打开过
 * pdx-map-editor.html 检查它，烤坏了只有玩家双击那一刻才知道。
 *
 * @returns {{embedded: object|null, js: string, html: string}}
 */
function readStandalone(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const marker = 'window.__CK3_EMBEDDED__=';
  const at = html.indexOf(marker);
  if (at < 0) return { embedded: null, js: '', html };

  // 脚本这一段是： <script>\n <内嵌数据> \n <拍平源码> \n</script>
  const open = html.lastIndexOf('<script>', at);
  const close = html.indexOf('</script>', at);
  if (open < 0 || close < 0) return { embedded: null, js: '', html };
  const body = html.slice(open + '<script>'.length, close);

  // 内嵌数据**自带换行**（meta 是原样拼进去的），所以不能只看第一行 ✗。
  // 它的收尾是 `}};`（build_standalone 拼的是 `{maps:{…}};`），
  // 而拍平源码里不会有这个形状 —— 从内嵌数据那一头往后找第一次出现即可 ✓
  const endPayload = body.indexOf('}};', at - open);
  if (endPayload < 0) return { embedded: null, js: '', html };

  const stmt = body.slice(0, endPayload + 3);     // 含结尾的 `}};`
  const js = body.slice(endPayload + 3).replace(/^\s*\n/, '');
  const embedded = new Function('window', stmt + '\nreturn window.__CK3_EMBEDDED__;')({});
  return { embedded, js, html };
}

module.exports = {
  ROOT, MODULES, flattenModules, moduleListFor, makeEnv, instantiate, readStandalone,
  El, ctx2d, fakeGL, stats, resetCanvasStats, setForceLinkFail,
  makeIndexedDBFake,
};
