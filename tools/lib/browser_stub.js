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
const MODULES = ['log.js', 'pack.js', 'zip.js', 'packstore.js', 'data.js', 'bmp.js', 'gl.js', 'labels.js', 'tilemap.js', 'tutorial.js', 'app.js'];

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
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
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
    return c;
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
  blur() {}
  contains(n) {
    if (!n) return false;
    if (this === n) return true;
    return this.children.some((c) => c && c.contains && c.contains(n));
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
  querySelectorAll() { return []; }
  querySelector() { return null; }
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
  };
  Object.defineProperty(o, 'font', {
    get() { return this._font || ''; },
    set(v) { this._font = v; stats.font++; },
  });
  return o;
}

/** WebGL：Proxy 兜住 —— 真渲染不验，只求 gl.js 不炸 */
function fakeGL() {
  const t = {};
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
        if (s === 'getShaderParameter' || s === 'getProgramParameter') return true;
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
    querySelector: (sel) => (sel.includes('tier') ? containers.tier : containers.tool),
    querySelectorAll: (sel) => (sel.includes('tier') ? containers.tier.children
                               : sel.includes('tool') ? containers.tool.children : []),
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
_p('provInfoAt', provInfoAt); _p('paintTargetsAt', paintTargetsAt);
_p('labelMaxValue', labelMaxValue); _p('buildBorderEdges'); _p('buildBorderDepth', buildBorderDepth); _p('refreshBorderField', refreshBorderField); _p('editTier', editTier);
_p('saveMapPrefs', saveMapPrefs); _p('loadMapPrefs', loadMapPrefs);
_p('paintPids', paintPids); _p('paintPidsAsOne', paintPidsAsOne);
_p('pickAt', pickAt); _p('setBrush', setBrush); _p('setTier', setTier); _p('setTool', setTool);
_p('needsRestore', needsRestore); _p('isLocked', isLocked); _p('isSpecialTid', isSpecialTid);
_p('runSearch', runSearch); _p('jumpToResult', jumpToResult); _p('searchJumpScale', searchJumpScale);
_p('wasteApply', wasteApply); _p('wasteClear', wasteClear); _p('setWasteAuto', setWasteAuto);
_p('wasteClearPlayerPaint', wasteClearPlayerPaint);
_p('displayedColor', displayedColor); _p('displayedLabel', displayedLabel);
_p('syncParentBorder', syncParentBorder); _p('syncLayerSwitches', syncLayerSwitches);
_p('retintCountryLabels', retintCountryLabels); _p('wasteWatch', wasteWatch);
_p('syncAllPaintLabels', syncAllPaintLabels);
_p('editTier', editTier); _p('setGrain', setGrain); _p('gotoLevel', gotoLevel);
_p('pressTier', pressTier); _p('eraTierCount', eraTierCount);
_p('refreshTierButtons', refreshTierButtons);
_p('projectData', projectData); _p('saveProject', saveProject); _p('applyProject', applyProject);
_p('labelForColor', labelForColor);
_p('isDegradedBaron', isDegradedBaron); _p('screenToMap', screenToMap);
_p('updateHover', updateHover); _p('rebuildPaintBlocks', rebuildPaintBlocks);
_p('paintedPoints', paintedPoints); _p('playerGroupTidsAt', playerGroupTidsAt);
_p('paintAt', paintAt); _p('hoverGroupRgb', hoverGroupRgb); _p('stableColor', stableColor);
_p('hoverTargetTid', hoverTargetTid); _p('applyHoverHighlight', applyHoverHighlight);
_p('readablePlaceName', readablePlaceName); _p('manualWaterName', manualWaterName);
_p('drawLabels', drawLabels); _p('legendEntries', legendEntries);
_p('drawLegend', drawLegend); _p('rebuildLegendPanel', rebuildLegendPanel);
_p('impassLabel', impassLabel); _p('specialTileLabel', specialTileLabel);
_p('computeLabelZoom', computeLabelZoom); _p('applySettings', applySettings);
_p('fitView', fitView); _p('minScale', minScale);
_p('applyLutOverrides', applyLutOverrides); _p('lutColorOf', lutColorOf);
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
  El, ctx2d, fakeGL, stats, resetCanvasStats,
  makeIndexedDBFake,
};
