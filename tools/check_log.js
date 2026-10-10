/**
 * 报错日志（`web/js/log.js`）单模块自检。
 *
 *   node tools/check_log.js
 *
 * 为什么要单独有一把尺子：日志这东西**平时看不出好坏** ——
 * 它一声不响地跑着，直到真出事那天才有人打开它。
 * 那天要是发现"里面是空的""只剩最后三条""栈没留住"，这一份就白留了 ✗
 * 所以这里逐条量它：
 *   · **收得到吗**：未捕获 / 没接住的 Promise / console.error / console.warn，
 *     以及**原输出还转不转发**（F12 里该怎么看还得怎么看 ✓）
 *   · **记得住吗**：同一处合并计次、到上限只累计丢弃、快照自己炸了不陪葬
 *   · **导得出吗**：四段齐全、BOM、CRLF、文件名、没内容时也不抛
 *
 * 它**不依赖** browser_stub 那套假 DOM —— 日志模块要能在"编辑器整个没起来"
 * 的时候还工作，所以这里给的就是一个最小的 window：依赖越少，
 * 越接近它真正要顶事的那种场合 ✓
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'web', 'js', 'log.js');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

/** 一个最小的假 window：日志模块只该碰这几样东西 */
function makeWindow() {
  const listeners = {};
  const raw = [];
  const win = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    console: {
      error: (...a) => raw.push(['error', ...a]),
      warn: (...a) => raw.push(['warn', ...a]),
      log: () => {},
    },
    document: {
      lastModified: '10/08/2026 12:00:00',
      createElement: () => ({ click() { this.clicked = true; }, style: {} }),
    },
    __CK3_EMBEDDED__: {},
    devicePixelRatio: 1.25,
    innerWidth: 1920,
    innerHeight: 900,
    location: { href: 'file:///D:/pdx-map-editor.html' },
  };
  return { win, listeners, raw };
}

console.log('\n===== 报错日志自检：web/js/log.js =====');
const src = fs.readFileSync(SRC, 'utf8');
const { win, listeners, raw } = makeWindow();
new Function('window', src)(win);
const LOG = win.PDXLOG;

ok('PDXLOG 挂上了', !!LOG && typeof LOG.text === 'function');
if (!LOG) process.exit(1);
ok('window 上留了 error 钩子（未捕获异常这条路）', (listeners.error || []).length === 1);
ok('window 上留了 unhandledrejection 钩子', (listeners.unhandledrejection || []).length === 1);
ok('console 被包上了', win.console.__pdxHooked === true);

// ---- 收得到吗
win.console.error('分块初始化失败，退回普通路径：', new Error('boom'));
ok('console.error 进日志了', LOG.rec.errors.length === 1,
   (LOG.rec.errors[0] || {}).msg || '空');
ok('原 console.error 照样被调用（F12 里还看得见）',
   raw.length === 1 && raw[0][0] === 'error');
win.console.warn('这只是一条提示');
ok('console.warn 也收（但要标成提示，不算错）',
   LOG.rec.errors.length === 2 && LOG.rec.errors[1].kind === 'warn' && LOG.count() === 1,
   `count=${LOG.count()} / 共 ${LOG.rec.errors.length} 条`);

listeners.error[0]({ message: 'Cannot read properties of null (reading x)',
  filename: 'file:///x.html', lineno: 123,
  error: { stack: 'TypeError: ...\n    at frameBody (x.html:123)' } });
ok('未捕获异常收住了（带位置）',
   LOG.rec.errors.some((e) => e.kind === '未捕获' && /x\.html/.test(e.where || '')));
listeners.error[0]({ target: { src: 'data/tiles/t_0_0.bin' } });
ok('资源加载失败（只有 target、没有 message）也收得住',
   LOG.rec.errors.some((e) => /资源加载失败/.test(e.msg)));
listeners.unhandledrejection[0]({ reason: new Error('fetch 挂了') });
ok('没接住的 Promise 收住了', LOG.rec.errors.some((e) => e.kind === 'Promise'));

// ---- 记得住吗
win.console.error('第 3 帧失败');
win.console.error('第 4 帧失败');
const merged = LOG.rec.errors.filter((e) => /帧失败/.test(e.msg));
ok('同一处错合并成一条、只加次数（数字不同也算同一处）',
   merged.length === 1 && merged[0].n === 2, `${merged.length} 条，n=${merged[0] && merged[0].n}`);

LOG.event('启动');
LOG.event('选图', 'CK3 · 原版');
LOG.env('地图', 'CK3 · 原版');
LOG.snapshot(() => ({ '视图': '省份（第 3 层）', 'WebGL': 'WebGL 2.0 · NVIDIA' }));
LOG.snapshot(() => { throw new Error('快照自己炸了'); });
const t1 = LOG.text();
ok('轨迹 / 环境 / 快照都进得了文本',
   /· 启动/.test(t1) && /地图/.test(t1) && /NVIDIA/.test(t1));
ok('快照自己炸了不陪葬（只多一行说明）', /（现状取不出来）/.test(t1));

// 上限：消息里**不能带数字** —— 数字会被归一化，500 条会缩成几十种 ✗
const uniq = (i) => { let s = ''; do { s = String.fromCharCode(97 + (i % 26)) + s; i = Math.floor(i / 26); } while (i > 0); return s; };
for (let i = 0; i < 500; i++) LOG.error('唯一错误 ' + uniq(i) + ' 尾巴');
ok('到上限不再新增，只累计"没留几条"',
   LOG.rec.errors.length === 200 && LOG.rec.dropped > 0,
   `${LOG.rec.errors.length} 条 / 丢 ${LOG.rec.dropped}`);

// ---- 导得出吗
const txt = LOG.text();
ok('四段齐全（这是哪一份 / 当时的状态 / 错误 / 轨迹）',
   ['[这是哪一份]', '[当时的状态]', '[错误]', '[轨迹]'].every((s) => txt.includes(s)));
ok('版本戳 / 浏览器 / 时区都在（认得出是哪一版、什么机器）',
   /版本戳/.test(txt) && /浏览器/.test(txt) && /时区/.test(txt) && /单文件版/.test(txt));
ok('栈留在文本里（没有它这份日志没意义）', /at frameBody/.test(txt));
ok('行尾是 CRLF（记事本里不挤成一行）', txt.includes('\r\n'));
ok('提示与错误分开数（"另有 N 条提示"）', /另有 1 条提示/.test(txt));

let savedName = '';
const realCreate = URL.createObjectURL;
URL.createObjectURL = () => 'blob:fake';
const realEl = win.document.createElement;
win.document.createElement = () => ({ set download(v) { savedName = v; }, click() {} });
const dl = LOG.download('ck3_日志_20261008.txt');
win.document.createElement = realEl;
URL.createObjectURL = realCreate;
ok('download() 返回 true 并带上给的文件名',
   dl === true && savedName === 'ck3_日志_20261008.txt', savedName || '没拿到文件名');

// BOM：老版记事本不认无 BOM 的 UTF-8，中文会变乱码 —— 玩家双击第一眼就是乱码的话，
// 这份日志等于白导了 ✗ 所以这里真的看一眼字节
(async () => {
  let head = '';
  if (typeof Blob !== 'undefined') {
    const { win: w2 } = makeWindow();
    new Function('window', src)(w2);
    const realCreate2 = URL.createObjectURL;
    let blob = null;
    URL.createObjectURL = (b) => { blob = b; return 'blob:fake'; };
    w2.PDXLOG.download('x.txt');
    URL.createObjectURL = realCreate2;
    if (blob) {
      const buf = Buffer.from(await blob.arrayBuffer());
      head = [...buf.slice(0, 3)].map((b) => b.toString(16)).join(' ');
    }
  }
  ok('导出文件开头是 UTF-8 BOM（ef bb bf）', head === 'ef bb bf', head || '没拿到 blob');

  console.log('\n---- 导出的文本长这样（前 16 行）----');
  console.log(txt.split('\r\n').slice(0, 16).join('\n'));
  console.log(`   …… 共 ${txt.split('\r\n').length} 行 / ${txt.length} 字符`);

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
})();
