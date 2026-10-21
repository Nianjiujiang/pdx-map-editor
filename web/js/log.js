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
 * 界面**几乎一个像素都不碰** ✓：顶栏按钮在 app.js 那边接线；
 * 唯一一处是启动页那颗「导出诊断报告」—— 它必须在 app.js 没起来时也能用，
 * 所以由本文件绑一个已经存在的按钮（不创建 DOM、不改布局 ✓）
 *
 * 导出的是一份正式诊断报告（见文件末尾 text()）：
 *   报告头（编号 / 时间 / 结论）→ 环境 → 运行状态 → 错误摘要 → 错误明细
 *   → 事件时间线 → 机器可读的 JSON 附录
 *   前两节回答"他手上是什么"，中间回答"出了什么事"，最后给自动化分析留口子 ✓
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

  /** 报告编号：一份报告一个号，客服/作者按号定位 ✓（同一次页面会话内固定） */
  const reportId = 'PDX-' + idStamp(new Date()) + '-' + hex4();

  function idStamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2)
      + '-' + pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2);
  }

  function hex4() {
    let n = 0;
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        const a = new Uint8Array(2);
        window.crypto.getRandomValues(a);
        n = (a[0] << 8) | a[1];
      } else {
        n = Math.floor(Math.random() * 65536);
      }
    } catch (e) { n = Math.floor(Math.random() * 65536); }
    return ('0000' + n.toString(16).toUpperCase()).slice(-4);
  }

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

  /** 构建戳：读 `<meta name="pdx-build">`（build_standalone.py 写打包时间）✓
   *  ⚠ 不用 document.lastModified ✗ —— 单文件 / 某些浏览器里它是当前时间 ✓ */
  function buildStamp() {
    try {
      const doc = window.document;
      const m = doc && doc.querySelector && doc.querySelector('meta[name="pdx-build"]');
      const v = m && m.content ? String(m.content).trim() : '';
      return v && v !== 'dev' ? v : '开发版';
    } catch (e) { return '开发版'; }
  }

  /* ---- 环境信息：全是从浏览器现问的，问不到就写"取不到" ✓ ---------- */
  function basics() {
    const out = {};
    const put = (k, v) => { out[k] = (v === '' || v == null) ? '取不到' : String(v); };
    try {
      const nav = (typeof navigator !== 'undefined' && navigator) || null;
      const loc = window.location || null;
      const scr = (typeof screen !== 'undefined' && screen) || null;
      const ua = nav && nav.userAgent ? String(nav.userAgent) : '';
      put('版本戳', buildStamp());
      put('运行方式', window.__CK3_EMBEDDED__
        ? '单文件版（数据烘在文件里）' : '开发版（走 server.py 读 web/）');
      put('页面地址', loc ? loc.href : '');
      put('协议', loc && loc.protocol ? loc.protocol : '');
      put('浏览器', ua ? browserName(ua) : '');
      put('平台', osName(ua) !== '未知' ? osName(ua)
        : ((nav && nav.userAgentData && nav.userAgentData.platform) || ''));
      put('语言 / 时区', (nav && nav.language ? nav.language : '') + ' / ' + tz());
      put('屏幕', scr ? (scr.width + '×' + scr.height
        + ' @' + (window.devicePixelRatio || 1) + 'x'
        + '，窗口 ' + (window.innerWidth || '?') + '×' + (window.innerHeight || '?')) : '');
      put('User-Agent', ua);
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

  /** 时区偏移（+08:00） */
  function tzOffset(t) {
    const d = new Date(t);
    const m = -d.getTimezoneOffset();
    const sign = m >= 0 ? '+' : '-';
    const a = Math.abs(m);
    return 'UTC' + sign + pad(Math.floor(a / 60), 2) + ':' + pad(a % 60, 2);
  }

  /** 带时区的完整时间 */
  function fullTimeZone(t) {
    return fullTime(t) + ' (' + tzOffset(t) + ')';
  }

  /** 会话时长：00:02:31.482 */
  function durationText(ms) {
    const s = Math.max(0, ms) / 1000;
    return pad(Math.floor(s / 3600), 2) + ':' + pad(Math.floor((s % 3600) / 60), 2)
      + ':' + pad(Math.floor(s % 60), 2)
      + '.' + pad(Math.floor((s - Math.floor(s)) * 1000), 3);
  }

  /** 从 UA 认浏览器 / 系统 —— 只做粗分，认不出就写"未知" ✓（不猜） */
  function browserName(ua) {
    const s = String(ua || '');
    // ⚠ Edge / Opera 的 UA 里**也带 Chrome/** ✗ 必须先认它们，再认 Chrome ✓
    let m = /(?:Edg|Edge)\/([\d.]+)/.exec(s);
    if (m) return 'Edge ' + m[1];
    m = /OPR\/([\d.]+)/.exec(s);
    if (m) return 'Opera ' + m[1];
    m = /Firefox\/([\d.]+)/.exec(s);
    if (m) return 'Firefox ' + m[1];
    m = /Chrome\/([\d.]+)/.exec(s);
    if (m) return 'Chrome ' + m[1];
    m = /Version\/([\d.]+).*Safari/.exec(s);
    if (m) return 'Safari ' + m[1];
    return '未知';
  }

  function osName(ua) {
    const s = String(ua || '');
    if (/Windows NT 10\.0/.test(s)) return 'Windows 10/11';
    if (/Windows NT 6\.3/.test(s)) return 'Windows 8.1';
    if (/Android/.test(s)) return 'Android';
    if (/iPhone|iPad|iPod/.test(s)) return 'iOS / iPadOS';
    if (/Mac OS X/.test(s)) return 'macOS';
    if (/Linux/.test(s)) return 'Linux';
    return '未知';
  }

  /** 内部 kind → 报告里的严重级别 */
  function severityOf(kind) {
    if (kind === 'warn') return 'WARN';
    if (kind === '未捕获') return 'UNCAUGHT';
    if (kind === 'Promise') return 'REJECTION';
    return 'ERROR';
  }

  /** 报告里不要 ✓/✗ 这类手写标记：统一清掉、压掉多余空格 ✓
   *  ⚠ 只用于**环境 / 状态 / 时间线**这些展示字段 ✗ —— 错误消息与堆栈保持原样，
   *     那是现场证据，不能替它"美化" ✓ */
  function cleanValue(v) {
    return String(v == null ? '' : v)
      .replace(/[✓✗]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  /** 拼出整份**诊断报告**（正式格式；最后一节是机器可读的 JSON） */
  function text() {
    const L = [];
    const line = (s) => L.push(s == null ? '' : s);
    const hr = '==============================================================================';
    const thin = '------------------------------------------------------------------------------';
    const width = (str) => {
      let w = 0;
      for (const ch of String(str)) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
      return w;
    };
    /** 顶层字段：标签列对齐（中文按两位算） */
    const col = (k) => String(k) + ' '.repeat(Math.max(2, 14 - width(k)));
    const field = (k, v) => line('  ' + col(k) + ' : '
      + (v == null || String(v) === '' ? '—' : cleanValue(v)));
    /** 错误块里的短字段 */
    const ecol = (k) => String(k) + ' '.repeat(Math.max(1, 8 - width(k)));
    const efield = (k, v, indent) => {
      const pad = ' '.repeat(indent);
      const head = ecol(k);
      const rows = String(v == null ? '' : v).split('\n');
      rows.forEach((row, i) => line(pad
        + (i === 0 ? head + ': ' : ' '.repeat(head.length + 2)) + row));
    };

    const now = Date.now();
    const b = basics();
    const stPairs = stateLines();
    const runtime = {};
    for (const [k, v] of stPairs) runtime[k] = v;

    const errs = rec.errors;
    const nWarn = errs.filter((e) => e.kind === 'warn').length;
    const nTrue = errs.length - nWarn;
    const nUncaught = errs.filter((e) => e.kind === '未捕获').length;
    const nReject = errs.filter((e) => e.kind === 'Promise').length;
    const nOccur = errs.reduce((a, e) => a + (e.n || 1), 0);
    const bootFail = runtime['渲染器状态'] || '';
    const conclusion = bootFail ? 'BOOT FAILURE'
      : (nTrue ? 'ERROR' : (nWarn ? 'WARN' : 'OK'));
    const summary = bootFail
      ? 'BOOT FAILURE（启动阶段失败，详见 [2] / [4]）'
      : (nTrue ? 'ERROR（' + nTrue + ' 个错误，' + nWarn + ' 条警告）'
        : (nWarn ? 'WARN（仅 ' + nWarn + ' 条警告）' : 'OK（未记录到错误）'));

    line(hr);
    line('  悖论制图 · 诊断报告');
    line('  PDX MAP EDITOR · DIAGNOSTIC REPORT');
    line(hr);
    field('报告编号', reportId);
    field('生成时间', fullTimeZone(now));
    field('报告格式', 'pdx-map-editor.diagnostic/2');
    field('会话时长', durationText(now - rec.t0));
    field('结论', summary);
    line(hr);

    line('');
    line('[1] 环境信息 / ENVIRONMENT');
    line(thin);
    for (const k of Object.keys(b)) field(k, b[k]);

    line('');
    line('[2] 运行状态 / RUNTIME STATE');
    line(thin);
    if (stPairs.length) {
      for (const [k, v] of stPairs) field(k, v);
    } else {
      line('  （编辑器尚未完成初始化，无运行状态可取）');
    }

    line('');
    line('[3] 错误摘要 / ERROR SUMMARY');
    line(thin);
    field('错误', nTrue);
    field('警告', nWarn);
    field('未捕获', nUncaught);
    field('Promise 拒绝', nReject);
    field('记录条数', errs.length);
    field('累计出现', nOccur);
    field('丢弃记录', rec.dropped);
    field('首条错误', errs.length ? fullTimeZone(errs[0].t) : '—');
    field('末条错误', errs.length ? fullTimeZone(errs[errs.length - 1].t) : '—');

    line('');
    line('[4] 错误明细 / ERRORS');
    line(thin);
    if (!errs.length) {
      line('  （未记录到错误）');
    } else {
      for (let i = 0; i < errs.length; i++) {
        const e = errs[i];
        line('  E-' + pad(i + 1, 3) + '  [' + severityOf(e.kind) + ']  ' + clock(e.t));
        efield('来源', e.kind, 9);
        efield('消息', e.msg, 9);
        efield('位置', e.where || '（未提供）', 9);
        efield('次数', e.n || 1, 9);
        if (e.stack) {
          line(' '.repeat(9) + ecol('堆栈') + ':');
          const rows = e.stack.split('\n');
          const shown = rows.slice(0, 12);
          for (const r of shown) line(' '.repeat(11) + r.trim());
          if (rows.length > shown.length) {
            line(' '.repeat(11) + '…（堆栈后 ' + (rows.length - shown.length) + ' 行未收录）');
          }
        } else {
          efield('堆栈', '（无）', 9);
        }
        if (i + 1 < errs.length) line('');
      }
    }

    line('');
    line('[5] 事件时间线 / TIMELINE');
    line(thin);
    if (!rec.events.length) {
      line('  （无事件）');
    } else {
      for (let i = 0; i < rec.events.length; i++) {
        const ev = rec.events[i];
        const rel = '+' + ((ev.t - rec.t0) / 1000).toFixed(3) + 's';
        line('  T-' + pad(i + 1, 3) + '  ' + rel.padEnd(10) + '  ' + clock(ev.t)
          + '  ' + ev.name + (ev.detail
            ? '  |  ' + cleanValue(ev.detail).replace(/\n/g, ' / ') : ''));
      }
      if (rec.events.length >= MAX_EVENT) {
        line('  （事件已到上限 ' + MAX_EVENT + ' 条，较早记录可能被截断）');
      }
    }

    line('');
    line('[6] 附录 / APPENDIX (JSON)');
    line(thin);
    line('---- BEGIN JSON ----');
    const json = JSON.stringify(buildRaw(b, runtime, conclusion), null, 2);
    for (const row of json.split('\n')) line(row);
    line('---- END JSON ----');

    line(hr);
    line('  说明：本报告由编辑器自动生成，不包含涂色图片、地图数据或游戏文件。');
    line('  提交问题时请附完整报告；报告编号 ' + reportId + ' 便于定位。');
    line(hr);
    return L.join('\r\n');   // CRLF：Windows 记事本里换行才不会挤成一行 ✓
  }

  function cleanMap(obj) {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = cleanValue(obj[k]);
    return out;
  }

  /** JSON 附录：给自动化分析 / 附件归档用，字段与正文一一对应 */
  function buildRaw(b, runtime, conclusion) {
    const errors = rec.errors.map((e, i) => ({
      id: 'E-' + pad(i + 1, 3),
      severity: severityOf(e.kind),
      source: e.kind,
      time: new Date(e.t).toISOString(),
      message: e.msg,
      location: e.where || null,
      stack: e.stack || null,
      count: e.n || 1,
    }));
    const events = rec.events.map((ev, i) => ({
      id: 'T-' + pad(i + 1, 3),
      time: new Date(ev.t).toISOString(),
      relativeMs: ev.t - rec.t0,
      name: ev.name,
      detail: ev.detail ? cleanValue(ev.detail) : null,
    }));
    return {
      schema: 'pdx-map-editor.diagnostic/2',
      reportId: reportId,
      generatedAt: new Date().toISOString(),
      sessionStartedAt: new Date(rec.t0).toISOString(),
      durationMs: Date.now() - rec.t0,
      conclusion: conclusion,
      environment: cleanMap(b),
      runtime: cleanMap(runtime),
      errors: errors,
      events: events,
      dropped: rec.dropped,
    };
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

  /** 启动页「导出诊断报告」按钮 —— **不依赖 app.js** ✓
   *
   *  为什么放在 log.js 里：编辑器自己没起来（脚本报错 / 加载失败 / 渲染器建不出来）时，
   *  app.js 里的导出入口根本挂不上；而这时正是最需要日志的场合 ✓
   *  这里只**绑一个已经存在的按钮**，不创建 DOM、不改布局 ✓
   *  （按钮在 web/index.html 的启动页署名区 ✓） */
  function bindBootExport() {
    try {
      const doc = window.document;
      const btn = doc && doc.getElementById && doc.getElementById('btn-boot-log');
      if (!btn || btn.__pdxLogBound) return;
      btn.__pdxLogBound = true;
      const label = btn.textContent;
      btn.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        event('导出诊断报告', '启动页');
        const ok = download('pdx-map-editor_诊断报告_' + idStamp(new Date()) + '.txt');
        btn.textContent = ok ? '已导出' : '导出失败';
        setTimeout(function () { btn.textContent = label; }, 2200);
      });
    } catch (e) { /* 没有 DOM 就算了 ✓ */ }
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
    reportId: reportId,
    //: 自己看自己（调试用：控制台里敲 PDXLOG.rec.errors 就能翻）
    rec: rec,
  };

  hookConsole();
  hookGlobal();
  bindBootExport();
  if (window.document && window.document.addEventListener) {
    window.document.addEventListener('DOMContentLoaded', bindBootExport);
  }
  event('日志就绪', '（这一条能看见 = 日志模块加载上了 ✓）');
})(window);
