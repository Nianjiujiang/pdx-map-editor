/**
 * 报错日志：记录故障现场，可导出为 txt 提交。
 *
 * 单独成文件并排在 app.js 之前：编辑器自身故障时仍能工作。
 * 若并入 app.js，app.js 加载失败或早期抛错时日志会一并失效，
 * 而那正是最需要现场的时机。因此它是普通脚本（不使用 ES module），
 * 仅在 window 上挂载 PDXLOG 供 app.js 使用。
 *
 * 记录三类信息：
 *   ① 错误：window.onerror / 未处理的 Promise / console.error / console.warn
 *   ② 轨迹：启动、选图、导出、导入、清除等操作（故障前最后一步往往比栈更有用）
 *   ③ 环境：版本、浏览器、当前查看的地图与图层
 *
 * 不创建或改动界面：顶栏按钮在 app.js 中接线；
 * 唯一例外是启动页的「导出诊断报告」按钮，它必须在 app.js 未启动时也能使用，
 * 因此由本文件绑定现有按钮（不创建 DOM、不改布局）。
 *
 * 导出内容为正式诊断报告（见文件末尾 text()）：
 *   报告头（编号 / 时间 / 结论）→ 环境 → 运行状态 → 错误摘要 → 错误明细
 *   → 事件时间线 → 机器可读的 JSON 附录
 *   前两节说明运行环境，中间说明故障经过，最后供自动化分析使用。
 */
(function (window) {
  'use strict';

  // 同一页面重复挂载时直接返回（脚本被引用两次 / 单文件版中被拼接两次）
  if (window.PDXLOG) return;

  /* ---- 上限 ----------------------------------------------------------------
   * 日志用于定位问题，不能无限占用内存：
   * 帧循环中的错误每秒可能产生 60 条。
   * 因此同一处错误只保留一条（后续仅累加次数），不同错误最多保留 MAX_ERR 条。
   */
  const MAX_ERR = 200;      // 不同错误的最大条数
  const MAX_EVENT = 400;    // 轨迹的最大条数
  const MAX_MSG = 1200;     // 单条消息的最大字符数
  const MAX_ARG = 20;       // 对象/数组展开的最大项数

  // ---------------------------------------------------------------- 小工具

  const pad = (n, w) => String(n).padStart(w, '0');

  /** 时刻，含毫秒（一秒多条错误只能靠毫秒区分） */
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
   * 把 console 的参数转换成可读字符串。
   * Error 保留栈信息（唯一能指出出错行），
   * 普通对象展开一层即可，更深层的数值意义不大。
   */
  function fmt(v, depth) {
    depth = depth || 0;
    try {
      if (v == null) return String(v);
      const t = typeof v;
      if (t === 'string') return v;
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
      if (t === 'function') return 'function ' + (v.name || '(匿名)');
      // 按特征识别 Error：可识别跨 iframe / 被包装过的异常
      // 有栈时只保留栈：stack 首行本为 "Error: 消息"，
      // 再次拼接会在日志中重复输出
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

  /** 报告编号：每份报告唯一，便于按号定位（同一页面会话内固定） */
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
   * 记录一条错误。
   * 比较 key 前先去掉数字："第 3 帧失败"与"第 4 帧失败"属于同一处错误，
   * 不归一化时 200 条上限会很快被同一句话占满。
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

  /** 轨迹：记录一次操作，不判断对错（上限 400 条） */
  function event(name, detail) {
    if (!name) return;
    if (rec.events.length >= MAX_EVENT) { rec.dropped++; return; }
    rec.events.push({ t: Date.now(), name: String(name), detail: cut(detail || '', 300) });
  }

  /** app.js 主动记录一条错误（用于 catch 分支，比仅调用 console.error 更明确） */
  function error(msg, err) {
    const stack = err && err.stack ? err.stack : '';
    const extra = err && err.message && String(msg).indexOf(err.message) < 0
      ? String(msg) + '：' + err.message : String(msg);
    return push('错误', extra, '', stack);
  }

  // ---------------------------------------------------------------- 钩子

  /* ---- console 拦截 --------------------------------------------------------
   * 拦截原因：错误信息主要输出到控制台，界面浮条已整体关闭
   * （app.js 的 TOAST_OFF），"导出失败""导入失败""分块初始化失败"
   * 仅剩控制台一行记录，界面上看不到。
   * 将其收进日志可补全现场信息。
   *
   * 原输出照常转发（F12 中查看方式不变），包装仅执行一次
   * （tools/ 的桩中同一 console 会被重复使用，避免多层包装）
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
          } catch (e) { /* 记录失败也不能阻断原输出 */ }
          return raw.apply(null, arguments);
        };
      }
    } catch (e) { /* 部分环境不允许改写 console，跳过该钩子 */ }
  }

  /* ---- 未捕获异常 / 未处理的 Promise --------------------------------------
   * 这两类事件是捕获编辑器崩溃的唯一途径。
   * 资源加载失败（img/script 404）同样触发 error：没有 message，
   * 只有 target，也需要记录（地图无法打开多由此引起）。
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
        } catch (err) { /* 忽略 */ }
      });
      on.call(window, 'unhandledrejection', function (e) {
        try {
          const r = e && e.reason;
          const msg = (r && (r.message || r)) || '(空)';
          push('Promise', msg, '', (r && r.stack) || '');
        } catch (err) { /* 忽略 */ }
      });
    } catch (e) { /* 无 addEventListener 的环境跳过 */ }
  }

  // ---------------------------------------------------------------- 对外

  /** 登记一条环境信息（键值写入导出的运行状态段，使用中文键） */
  function env(k, v) {
    if (!k) return;
    rec.env[k] = String(v == null ? '' : v);
  }

  /** 注册"导出时现取状态"的回调（当前视图、工具、WebGL 状态由 app.js 提供） */
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

  /** 构建戳：读取 `<meta name="pdx-build">`（build_standalone.py 写入打包时间）
   *  不使用 document.lastModified：单文件及部分浏览器中它等于当前时间。 */
  function buildStamp() {
    try {
      const doc = window.document;
      const m = doc && doc.querySelector && doc.querySelector('meta[name="pdx-build"]');
      const v = m && m.content ? String(m.content).trim() : '';
      return v && v !== 'dev' ? v : '开发版';
    } catch (e) { return '开发版'; }
  }

  /* ---- 环境信息：均从浏览器实时读取，取不到时写"取不到" ---------- */
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
    } catch (e) { /* 取不到时少输出几行，不影响正文 */ }
    return out;
  }

  function tz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  /** 拼接运行状态段：app.js 登记项 + 实时快照 */
  function stateLines() {
    const pairs = [];
    for (const k of Object.keys(rec.env)) pairs.push([k, rec.env[k]]);
    for (const fn of rec.snaps) {
      let got = null;
      // 快照抛错不能影响整份日志
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

  /** 从 UA 识别浏览器 / 系统：仅做粗略分类，识别不出时写"未知" */
  function browserName(ua) {
    const s = String(ua || '');
    // Edge / Opera 的 UA 中也含 Chrome/，必须先识别它们，再识别 Chrome
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

  /** 清除展示字段中的勾叉标记并压缩多余空格
   *  仅用于环境 / 状态 / 时间线等展示字段；错误消息与堆栈保持原样，
   *  它们属于现场证据，不做改写。 */
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
    return L.join('\r\n');   // CRLF：Windows 记事本中换行才不会挤成一行
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
   * 文件名由 app.js 提供（它掌握当前游戏信息），传入时作为前缀并附带时间。
   * 开头写入 BOM：旧版记事本不识别无 BOM 的 UTF-8，中文会显示为乱码。
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

  /** 启动页「导出诊断报告」按钮：不依赖 app.js
   *
   *  放在 log.js 中的原因：编辑器未能启动（脚本报错 / 加载失败 / 渲染器创建失败）时，
   *  app.js 中的导出入口无法挂载，而此时最需要日志。
   *  此处只绑定已存在的按钮，不创建 DOM、不改布局
   *  （按钮位于 web/index.html 的启动页署名区）。 */
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
    } catch (e) { /* 无 DOM 环境跳过 */ }
  }


  /* ========================================================================
     启动看门狗
     用于处理白屏 / 黑屏 / 打开即闪退且无日志的情况：
       ① `tick(label)`：app.js 每推进一个启动阶段即记录时间戳（见 setBoot）
       ② 超过 25 秒没有进展、且未设置 `window.__PDX_BOOTED` 时，将启动页
          替换为"没能启动"说明卡：环境信息 + 常见原因 + 重新加载 + 复制诊断
     app.js 未能解析时（旧浏览器 / 隐私模式禁用 module / 文件损坏）
     同样会显示该卡，而不是空白页面。
     ====================================================================== */
  var _hb = { t: Date.now(), label: '（还没开始）' };
  var _act = { t: 0 };            // 最后一次用户交互（点击/按键/滚动；有交互时视为未卡死）
  var _bootFailShown = false;

  /** 启动进度心跳（app.js 的 setBoot 每步调用，开销很小）*/
  function tick(label) {
    _hb.t = Date.now();
    if (label) _hb.label = String(label);
  }

  function _supportsESModule() {
    try {
      var sc = window.document.createElement('script');
      return 'noModule' in sc;
    } catch (e) { return false; }
  }

  function _facts() {
    var f = [];
    try { f.push('浏览器 ' + (navigator.userAgent || '?')); } catch (e) { /* 忽略 */ }
    try { f.push('WebGL2 ' + (window.WebGL2RenderingContext ? '有' : '**没有**')); } catch (e) { /* 忽略 */ }
    try { f.push('ES module ' + (_supportsESModule() ? '支持' : '**不支持**')); } catch (e) { /* 忽略 */ }
    try { f.push('打开方式 ' + (location.protocol || '?')); } catch (e) { /* 忽略 */ }
    try { f.push('窗口 ' + window.innerWidth + '×' + window.innerHeight); } catch (e) { /* 忽略 */ }
    try { if (navigator.deviceMemory) f.push('内存约 ' + navigator.deviceMemory + ' GB'); } catch (e) { /* 忽略 */ }
    try { f.push('最后进度 "' + _hb.label + '"（' + Math.round((Date.now() - _hb.t) / 1000) + ' 秒前）'); } catch (e) { /* 忽略 */ }
    try { f.push('已记录错误 ' + rec.errors.length + ' 条'); } catch (e) { /* 忽略 */ }
    return f;
  }

  function _btn(text, onClick) {
    var b = window.document.createElement('button');
    b.textContent = text;
    b.type = 'button';
    b.style.cssText = 'margin:8px 8px 0 0;padding:7px 14px;border-radius:8px;cursor:pointer;'
      + 'border:1px solid #3a4a5e;background:#22303f;color:#dbe7f3;font:inherit;font-size:13px';
    b.addEventListener('click', onClick);
    return b;
  }

  function _copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 走下面的兜底 */ }
    try {
      var ta = window.document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      window.document.body.appendChild(ta);
      ta.select();
      var ok = window.document.execCommand && window.document.execCommand('copy');
      window.document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  /**
   * 把启动页换成"没能启动"的说明卡
   * @param {string} [reason] 一句话原因（不给就用"启动卡住/脚本没加载"）
   * @param {string} [steps]  额外的排查建议（多行）
   */
  function bootFail(reason, steps) {
    try {
      if (_bootFailShown) return;
      var doc = window.document;
      var host = doc.getElementById && doc.getElementById('boot-inner');
      if (!host) return;
      _bootFailShown = true;

      var isNoModule = !_supportsESModule();
      var isNoGL2 = !window.WebGL2RenderingContext;
      var title = '没能启动（画面白屏 / 黑屏）';
      var body = reason || ('启动在「' + _hb.label + '」这一步停住了，'
        + Math.round((Date.now() - _hb.t) / 1000) + ' 秒没有新的进展。');

      var wrap = doc.createElement('div');
      wrap.style.cssText = 'max-width:640px;margin:0 auto;text-align:left;'
        + 'font:13px/1.65 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;color:#dbe7f3';

      var h = doc.createElement('div');
      h.textContent = title;
      h.style.cssText = 'font-size:17px;font-weight:600;margin:0 0 10px;color:#ffd27a';
      wrap.appendChild(h);

      var p1 = doc.createElement('p');
      p1.textContent = body;
      p1.style.cssText = 'margin:0 0 10px';
      wrap.appendChild(p1);

      var hints = [];
      if (isNoModule) hints.push('这台浏览器不支持 ES 模块：请用新版 Chrome / Edge / Firefox / Safari。');
      if (isNoGL2) hints.push('这台浏览器没有 WebGL2：多半是关了硬件加速，或显卡/驱动太旧。');
      hints.push('如果是双击单文件打开的：确认文件完整（1 MB 出头），复制到本机磁盘再打开，别在压缩包里双击。');
      hints.push('浏览器扩展（广告拦截 / 脚本管理）可能挡掉了脚本：用无痕窗口再试一次。');
      hints.push('手机 / 平板：内存紧张时会被系统杀掉，先关掉别的标签页再重开。');
      if (steps) hints.push(steps);

      var ul = doc.createElement('ul');
      ul.style.cssText = 'margin:6px 0 10px;padding-left:20px';
      for (var i = 0; i < hints.length; i++) {
        var li = doc.createElement('li');
        li.textContent = hints[i].replace(/\*\*/g, '');
        li.style.cssText = 'margin:3px 0';
        ul.appendChild(li);
      }
      wrap.appendChild(ul);

      var facts = doc.createElement('pre');
      facts.textContent = _facts().join('\n');
      facts.style.cssText = 'margin:8px 0 0;padding:9px 11px;border-radius:8px;'
        + 'background:#141d26;border:1px solid #2a3a4a;color:#9fb3c8;'
        + 'font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all';
      wrap.appendChild(facts);

      var row = doc.createElement('div');
      row.appendChild(_btn('重新加载', function () { location.reload(); }));
      row.appendChild(_btn('复制诊断', function (e) {
        var ok = _copy(text());
        e.target.textContent = ok ? '已复制' : '复制失败';
        setTimeout(function () { e.target.textContent = '复制诊断'; }, 2000);
      }));
      row.appendChild(_btn('导出诊断报告', function () {
        download('pdx-map-editor_诊断报告_' + idStamp(new Date()) + '.txt');
      }));
      wrap.appendChild(row);

      host.textContent = '';
      host.appendChild(wrap);
      error('启动失败（看门狗）', String(body));
    } catch (e) { /* 兜底逻辑中出错时静默 */ }
  }

  /* 每 2 秒检查一次：25 秒无进展且未就绪时显示说明卡
   * 仅在启动页仍存在时生效（地图已显示说明启动完成）*/
  function _watchdog() {
    try {
      if (_bootFailShown || window.__PDX_BOOTED) return;
      var boot = window.document.getElementById && window.document.getElementById('boot');
      if (boot && boot.hidden) return;
      /* 正在选图不计为卡住：
       * 启动页停留在"选一张地图"时属于等待用户操作，并非白屏。
       * 选图面板可见或最近几秒有交互时，一律不报告。 */
      var pick = window.document.getElementById && window.document.getElementById('map-pick');
      if (pick && !pick.hidden) return;
      if (Date.now() - (_act.t || 0) < 8000) return;
      if (Date.now() - _hb.t < 25000) return;
      bootFail('启动卡住了：' + Math.round((Date.now() - _hb.t) / 1000) + ' 秒没有新进展'
        + '（最后一步「' + _hb.label + '」）。');
    } catch (e) { /* 忽略 */ }
  }
  try {
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, function () { _act.t = Date.now(); }, { passive: true });
    });
  } catch (e) { /* 忽略 */ }
  try { window.setInterval(_watchdog, 2000); } catch (e) { /* 忽略 */ }

  window.PDXLOG = {
    event: event,
    tick: tick,
    bootFail: bootFail,
    error: error,
    push: push,
    env: env,
    snapshot: snapshot,
    count: count,
    clear: clear,
    text: text,
    download: download,
    reportId: reportId,
    // 内部记录（调试用：控制台访问 PDXLOG.rec.errors）
    rec: rec,
  };

  hookConsole();
  hookGlobal();
  bindBootExport();
  if (window.document && window.document.addEventListener) {
    window.document.addEventListener('DOMContentLoaded', bindBootExport);
  }
  tick('日志模块已加载');
  event('日志就绪', '（这一条能看见 = 日志模块加载上了 ✓）');
})(window);
