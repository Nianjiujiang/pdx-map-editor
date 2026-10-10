/**
 * 报错日志 —— 出事了至少留下现场，玩家导出一个 txt 发过来就行
 *
 * 为什么**单独一个文件、还排在 app.js 前面**：
 *   它要能在"编辑器自己坏了"的时候照样工作 ✓
 *   塞进 app.js 的话，app.js 一旦没加载起来、或者早期就抛，日志跟着一起没了 ✗
 *   —— 而那正好是最需要现场的场合 ✓ 所以它是普通脚本（不走 ES module），
 *   只往 window 上挂一个 PDXLOG 给 app.js 用 ✓
 *
 * 收三样东西：
 *   ① 错误：window.onerror / 未处理的 Promise / console.error / console.warn
 *   ② 轨迹：启动、选图、导出、导入、清除…（"出问题前最后干了什么"比栈还管用）
 *   ③ 环境：这是哪一版文件、什么浏览器、当时在看哪张图的哪一层
 *
 * 界面**一个像素都不碰** ✓ 按钮在顶栏「导出 ▾」菜单里，接线在 app.js 那边
 * （这个文件只管记录和导出，不碰 DOM 结构 —— 免得它一出问题就是把界面搞坏）
 *
 * 导出的 .txt 长这样：
 *   [这是哪一份] → [当时的状态] → [错误] → [轨迹]
 *   前两段回答"他手上是什么"，后两段回答"出了什么事" ✓
 */
(function (window) {
  'use strict';

  // 同一个页面里挂过就别重来（脚本被引两次 / 单文件版里被拼两次）
  if (window.PDXLOG) return;

  /* ---- 上限 ----------------------------------------------------------------
   * 日志是用来定位问题的，不是用来把内存吃掉的 ✗
   * 尤其帧循环那种错：一秒能刷 60 条，一晚上能把标签页撑死 ✓
   * 所以**同一处错只留一条**（后面只加次数），不同错最多留 MAX_ERR 条
   */
  const MAX_ERR = 200;      // 不同的错误最多留几条
  const MAX_EVENT = 400;    // 轨迹最多留几条
  const MAX_MSG = 1200;     // 单条消息最多留几个字
  const MAX_ARG = 20;       // 对象/数组展开到第几项

  // ---------------------------------------------------------------- 小工具

  const pad = (n, w) => String(n).padStart(w, '0');

  /** 时刻：带上毫秒 —— "一秒 60 条"这种事，只有毫秒看得出来 ✓ */
  function clock(t) {
    const d = new Date(t);
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2)
      + '.' + pad(d.getMilliseconds(), 3);
  }

  function fullTime(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2)
      + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
  }

  function cut(s, n) {
    s = String(s == null ? '' : s);
    if (s.length <= n) return s;
    return s.slice(0, n) + '…（后面还有 ' + (s.length - n) + ' 字，没留）';
  }

  /**
   * 把 console 的参数变成一个可读字符串。
   * Error 要**把栈留住**（那是唯一能指出"哪一行"的东西），
   * 普通对象展开一层就够 —— 再深就是一堆数字，反而看不动 ✗
   */
  function fmt(v, depth) {
    depth = depth || 0;
    try {
      if (v == null) return String(v);
      const t = typeof v;
      if (t === 'string') return v;
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
      if (t === 'function') return 'function ' + (v.name || '(匿名)');
      // 鸭子式认 Error：跨 iframe / 被包装过的异常也能认出来 ✓
      // 有栈就**只留栈** —— stack 第一行本来就是 "Error: 消息"，
      // 再拼一遍会在日志里印成两行一样的 ✗
      if (t === 'object' && (v.stack || v.message) && v.name !== undefined) {
        const head = (v.name || 'Error') + ': ' + (v.message || '');
        const st = String(v.stack || '');
        if (!st) return head;
        return st.indexOf(head) === 0 ? st : head + '\n' + st;
      }
      if (depth >= 2) return Array.isArray(v) ? '[…]' : '{…}';
      if (Array.isArray(v)) {
        const head = v.slice(0, MAX_ARG).map((x) => fmt(x, depth + 1)).join(', ');
        return '[' + head + (v.length > MAX_ARG ? ', …共 ' + v.length + ' 项]' : ']');
      }
      const ks = Object.keys(v);
      const head = ks.slice(0, MAX_ARG).map((k) => k + ': ' + fmt(v[k], depth + 1)).join(', ');
      return '{' + head + (ks.length > MAX_ARG ? ', …共 ' + ks.length + ' 个键}' : '}');
    } catch (e) {
      return '[这个值取不出来]';
    }
  }

  /** 从一段文本里把栈拆出来（console.error(e) 那条路：栈在消息里） */
  function splitStack(text) {
    const m = /\n\s+at /.exec(text);
    if (!m) return { msg: text, stack: '' };
    return { msg: text.slice(0, m.index), stack: text.slice(m.index).replace(/^\s+/, '') };
  }

  // ---------------------------------------------------------------- 收记录

  const rec = {
    t0: Date.now(),
    events: [],          // 轨迹：{ t, name, detail }
    errors: [],          // 错误：{ t, kind, msg, where, stack, n }
    byKey: new Map(),    // 同一处错 → 那一条记录（只加次数，不重复占位）
    env: {},             // 环境：app.js 登记（地图/数据/视图…）
    snaps: [],           // 导出时现取一份现状的回调
    dropped: 0,          // 上限丢掉的条数
  };

  /**
   * 记一条错。
   * key 里**去掉数字**再比 —— "第 3 帧失败"和"第 4 帧失败"是同一处错，
   * 不归一化的话 200 条上限几秒钟就被同一句话占满了 ✗
   */
  function push(kind, msg, where, stack) {
    msg = cut(msg, MAX_MSG);
    if (!msg) msg = '(没有消息)';
    const key = kind + '|' + msg.replace(/\d+/g, '#').slice(0, 160) + '|' + (where || '');
    const hit = rec.byKey.get(key);
    if (hit) { hit.n++; return hit; }
    if (rec.errors.length >= MAX_ERR) { rec.dropped++; return null; }
    const e = {
      t: Date.now(), kind: kind, msg: msg,
      where: where || '', stack: cut(stack || '', MAX_MSG), n: 1,
    };
    rec.byKey.set(key, e);
    rec.errors.push(e);
    return e;
  }

  /** 轨迹：一件"做了什么"的事，不带立场、不用怕多（上限 400 条兜着 ✓） */
  function event(name, detail) {
    if (!name) return;
    if (rec.events.length >= MAX_EVENT) { rec.dropped++; return; }
    rec.events.push({ t: Date.now(), name: String(name), detail: cut(detail || '', 300) });
  }

  /** app.js 主动记一条错（catch 里那条路 —— 比只 console.error 更明确 ✓） */
  function error(msg, err) {
    const stack = err && err.stack ? err.stack : '';
    const extra = err && err.message && String(msg).indexOf(err.message) < 0
      ? String(msg) + '：' + err.message : String(msg);
    return push('错误', extra, '', stack);
  }

  // ---------------------------------------------------------------- 钩子

  /* ---- console 拦截 --------------------------------------------------------
   * 为什么非拦不可：这个项目的错误**本来就都往控制台走** ——
   * 界面上的浮条被整体关掉了（app.js 的 TOAST_OFF，"这些提示都去掉好了"），
   * 于是"导出失败""导入失败""分块初始化失败"全只剩一行控制台记录：
   * 玩家看不见，来报问题只能说"它坏了" ✗
   * 把这一行收进日志，现场就完整了 ✓ —— 这是这个功能最值钱的一块
   *
   * 原输出照旧转发（F12 里该怎么看还怎么看 ✓），包装只做一次
   * （tools/ 那套桩里同一个 console 会被重复用到，叠六层就不好看了 ✗）
   */
  function hookConsole() {
    if (!window.console || window.console.__pdxHooked) return;
    try {
      window.console.__pdxHooked = true;
      for (const lv of ['error', 'warn']) {
        if (typeof window.console[lv] !== 'function') continue;
        const raw = window.console[lv].bind(window.console);
        window.console[lv] = function () {
          try {
            const args = Array.prototype.slice.call(arguments);
            const text = args.map((a) => fmt(a)).join(' ');
            const sp = splitStack(text);
            push(lv === 'error' ? 'error' : 'warn', sp.msg,
                 args.length > 1 && typeof args[0] === 'string' ? '' : '', sp.stack);
          } catch (e) { /* 记录自己出问题，也绝不能拦着原输出 ✗ */ }
          return raw.apply(null, arguments);
        };
      }
    } catch (e) { /* 有些环境不让改 console —— 那就算了，别的钩子还在 ✓ */ }
  }

  /* ---- 未捕获异常 / 没接住的 Promise --------------------------------------
   * 这两条是**唯一**能兜住"编辑器自己崩了"的网 ✓
   * 资源加载失败（img/script 404）也会走 error 这条：它没有 message，
   * 只有 target —— 那种也要记（"地图打不开"十有八九就是它 ✓）
   */
  function hookGlobal() {
    const on = window.addEventListener;
    if (typeof on !== 'function') return;
    try {
      on.call(window, 'error', function (e) {
        try {
          const tgt = e && e.target;
          const isRes = tgt && (tgt.src || tgt.href) && !(e && e.message);
          const msg = (e && e.message)
            || (isRes ? '资源加载失败：' + (tgt.src || tgt.href) : '未知错误');
          push('未捕获', msg,
               (e && (e.filename || (isRes ? (tgt.src || tgt.href) : ''))) || '',
               (e && e.error && e.error.stack) || '');
        } catch (err) { /* ✓ */ }
      });
      on.call(window, 'unhandledrejection', function (e) {
        try {
          const r = e && e.reason;
          const msg = (r && (r.message || r)) || '(空)';
          push('Promise', msg, '', (r && r.stack) || '');
        } catch (err) { /* ✓ */ }
      });
    } catch (e) { /* 没有 addEventListener 的环境就算了 ✓ */ }
  }

  // ---------------------------------------------------------------- 对外

  /** 登记一条环境信息（键值都直接写在导出的 [当时的状态] 里，用中文键 ✓） */
  function env(k, v) {
    if (!k) return;
    rec.env[k] = String(v == null ? '' : v);
  }

  /** 注册"导出时现取一份现状"（app.js 才知道当前视图/工具/WebGL 是什么 ✓） */
  function snapshot(fn) {
    if (typeof fn === 'function') rec.snaps.push(fn);
  }

  /** 记了几条"真错"（warn 不算 —— 那是提示，不是故障） */
  function count() {
    let n = 0;
    for (const e of rec.errors) if (e.kind !== 'warn') n++;
    return n;
  }

  function clear() {
    rec.events.length = 0;
    rec.errors.length = 0;
    rec.byKey.clear();
    rec.dropped = 0;
  }

  /* ---- "这是哪一份"：全是从浏览器现问的，问不到就写"取不到" ✓ ---------- */
  function basics() {
    const out = {};
    const put = (k, v) => { out[k] = (v === '' || v == null) ? '取不到' : String(v); };
    try {
      const nav = (typeof navigator !== 'undefined' && navigator) || null;
      const loc = window.location || null;
      const scr = (typeof screen !== 'undefined' && screen) || null;
      put('版本戳', (window.document && window.document.lastModified)
        ? window.document.lastModified : '');
      put('运行方式', window.__CK3_EMBEDDED__
        ? '单文件版（数据烘在文件里）' : '开发版（走 server.py 读 web/）');
      put('页面地址', loc ? loc.href : '');
      put('浏览器', nav ? nav.userAgent : '');
      put('屏幕', scr ? (scr.width + '×' + scr.height
        + ' @' + (window.devicePixelRatio || 1) + 'x'
        + '，窗口 ' + (window.innerWidth || '?') + '×' + (window.innerHeight || '?')) : '');
      put('语言 / 时区', (nav && nav.language ? nav.language : '')
        + ' / ' + tz());
    } catch (e) { /* 问不到就少几行，不影响下面的正文 ✓ */ }
    return out;
  }

  function tz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  /** 把 [当时的状态] 那一段拼出来：app.js 登记的 + 现取的快照 ✓ */
  function stateLines() {
    const pairs = [];
    for (const k of Object.keys(rec.env)) pairs.push([k, rec.env[k]]);
    for (const fn of rec.snaps) {
      let got = null;
      // 快照自己炸了不能把整份日志带走 ✗ —— 打不开现场还谈什么定位
      try { got = fn(); } catch (e) { got = { '（现状取不出来）': String((e && e.message) || e) }; }
      if (got && typeof got === 'object') {
        for (const k of Object.keys(got)) {
          const v = got[k];
          if (v != null && String(v) !== '') pairs.push([k, String(v)]);
        }
      }
    }
    return pairs;
  }

  /** 拼出整份日志文本 */
  function text() {
    const L = [];
    const line = (s) => L.push(s == null ? '' : s);
    const hr = '============================================================';
    const thin = '------------------------------------------------------------';
  /**
   * 标签列对齐：中文按两个位宽算，补到 12 位。
   * 记事本里中文是等宽的，这样左右两栏才站得齐 ✓
   * （直接用 padEnd 的话，"地图"和"语言 / 时区"后面差一半 ✗）
   */
  function col(k) {
    let w = 0;
    for (const ch of String(k)) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    return String(k) + ' '.repeat(Math.max(2, 12 - w));
  }

    line(hr);
    line(' 地图编辑器 · 报错日志');
    line(' 导出时间 ' + fullTime(Date.now()) + '（本机时间）');
    line(thin);

    line(' [这是哪一份]');
    const b = basics();
    for (const k of Object.keys(b)) line('   ' + col(k) + b[k]);
    line('');

    line(' [当时的状态]');
    const st = stateLines();
    if (st.length) for (const [k, v] of st) line('   ' + col(k) + v);
    else line('   （编辑器还没起来，没有状态可取）');
    line('');

    const errs = rec.errors;
    const nWarn = errs.filter((e) => e.kind === 'warn').length;
    line(' [错误] ' + (errs.length - nWarn) + ' 处'
         + (nWarn ? '，另有 ' + nWarn + ' 条提示' : '')
         + (rec.dropped ? '（到上限没留的还有 ' + rec.dropped + ' 条）' : ''));
    if (!errs.length) {
      line('   （一条都没有 —— 到这里为止是干净的 ✓）');
    } else {
      if (errs.length === nWarn) line('   （只有提示，没有真错误 —— 基本是干净的 ✓）');
      for (const e of errs) {
        // 消息自己带换行（JSON、栈）时，后续行也**跟着缩进** —— 不然会顶到最左边，
        // 看着像下一条记录的标题 ✗
        line('   ' + clock(e.t) + '  ' + (e.kind === 'warn' ? '·' : '✗') + ' ['
             + e.kind + '] ' + e.msg.split('\n').join('\n       '));
        if (e.where) line('       ' + e.where);
        if (e.stack) {
          const rows = e.stack.split('\n').slice(0, 12);
          for (const r of rows) line('       ' + r.trim());
        }
        if (e.n > 1) line('       （同一处，共 ' + e.n + ' 次）');
      }
    }
    line('');

    line(' [轨迹] ' + rec.events.length + ' 条');
    if (!rec.events.length) line('   （一条都没有）');
    for (const ev of rec.events) {
      line('   ' + clock(ev.t) + '  · ' + ev.name + (ev.detail ? '：' + ev.detail : ''));
    }
    line(hr);
    line(' 把这一整份发给作者（B 站：永夜廿九）就行，不用再教怎么看控制台 ✓');
    line(hr);
    return L.join('\r\n');   // CRLF：Windows 记事本里换行才不会挤成一行 ✓
  }

  /**
   * 存成文件。
   * 名字由 app.js 给（它才知道当前是哪个游戏 ✓）——给了就带上前缀和时间。
   * **开头写 BOM**：老版记事本不认无 BOM 的 UTF-8，中文会变成乱码 ✗
   * （玩家双击打开第一眼就是乱码，这份日志等于白导了 ✓）
   */
  function download(name) {
    try {
      const blob = new Blob(['\ufeff' + text()], { type: 'text/plain;charset=utf-8' });
      const a = window.document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name || ('pdx-map-editor_日志_' + fullTime(Date.now()).replace(/[-: ]/g, '') + '.txt');
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      return true;
    } catch (e) {
      return false;
    }
  }

  window.PDXLOG = {
    event: event,
    error: error,
    push: push,
    env: env,
    snapshot: snapshot,
    count: count,
    clear: clear,
    text: text,
    download: download,
    //: 自己看自己（调试用：控制台里敲 PDXLOG.rec.errors 就能翻）
    rec: rec,
  };

  hookConsole();
  hookGlobal();
  event('日志就绪', '（这一条能看见 = 日志模块加载上了 ✓）');
})(window);
