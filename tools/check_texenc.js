'use strict';
/**
 * 「整数纹理不可用 / 着色器链接失败」这两条**真机路**的回归 —— 2026-10-19。
 *
 *   node tools/check_texenc.js
 *
 * 来历是两份用户报告：
 *   ① VIC3 那份：`渲染器 WebKit WebGL · GL WebGL 2.0 ()`（没显卡名），
 *      「上传到显卡 → 失败」花了 **92377 ms** → 软件渲染（SwiftShader）啃不动
 *      这个巨型片元着色器，**链接失败**（驱动连日志都没给）。
 *   ② HOI4 那份（Adreno 616 · Chrome 132）：图形体检里
 *      「整数纹理采样: 读回 0，应该是 156」+「分块数组纹理: 读回 0 / 0 / 0」
 *      → 整张图的像素都拿到省份 id = 0 → **地图纯白 255,255,255**，地名却好好的。
 *
 * 这份守三件事：
 *   A. 整数纹理 / 整数采样器**一个都不许回来**（那台机器会再次白屏 ✗）
 *   B. 16 位值走 RG8 的**字节序**必须对（低字节在前 = Uint16 的小端布局 ✓）
 *   C. 精简版切得出来、而且**语法是整的**（切坏了就是编译失败 → 又白一次 ✗）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const ROOT = H.ROOT;
const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name);
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

const GL = fs.readFileSync(path.join(ROOT, 'web', 'js', 'gl.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');

/** 抠出片元着色器源码（从 const FRAG = 到 makeLiteFragment 之前）*/
function fragSrc() {
  const a = GL.indexOf('const FRAG = ');
  const b = GL.indexOf('function makeLiteFragment');
  if (a < 0 || b < 0) throw new Error('找不到 FRAG / makeLiteFragment');
  const s = GL.slice(a, b);
  return s.slice(s.indexOf('`') + 1, s.lastIndexOf('`'));
}
const FRAG = fragSrc();

/** 去掉注释（注释里写着这些名字是"档案"，不能算代码 ✓）*/
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const CODE = stripComments(FRAG);

console.log('=== A. 整数纹理必须彻底退役 ===');
for (const k of ['R16UI', 'R8UI', 'usampler2D', 'usampler2DArray', 'RED_INTEGER', 'isampler']) {
  ok(`片元着色器里没有 ${k}`, !CODE.includes(k),
    CODE.includes(k) ? '又回来了 ✗（Adreno 616 上恒读 0）' : '干净');
}
ok('纹理上传侧也不用整数格式（RED_INTEGER / R16UI / R8UI 一个不剩）',
  !/gl\.RED_INTEGER/.test(stripComments(GL)) && !/gl\.R16UI|gl\.R8UI/.test(stripComments(GL)));

console.log('\n=== B. RG8 的字节序（低字节在前）===');
{
  /* _bytesOf16：Uint16Array 走**视图**（零拷贝 ✓），不能是逐个 >>8 拼的慢路 ✓ */
  const hasView = /new Uint8Array\(a\.buffer, a\.byteOffset/.test(GL);
  ok('_bytesOf16 对 Uint16Array 走零拷贝视图（不是逐元素拆字节）', hasView,
    hasView ? '省掉 40MB 级的一次拷贝 ✓' : '又变成逐个拆了 ✗');
  /* 着色器解码：lo = R，hi = G，值 = lo + hi*256 ✓ */
  ok('着色器解码是 lo + hi×256（R 低、G 高）',
    /lo \+ hi \* 256u/.test(CODE));
  /* 真算一遍，确认这个公式跟小端内存布局一致 */
  const u16 = new Uint16Array([0x2C01, 0x5B91, 30069]);
  const bytes = new Uint8Array(u16.buffer, u16.byteOffset, u16.length * 2);
  const decode = (i) => bytes[i * 2] + bytes[i * 2 + 1] * 256;
  ok('往返一致：Uint16 → 字节 → lo+hi×256 同一个值',
    decode(0) === 0x2C01 && decode(1) === 0x5B91 && decode(2) === 30069,
    [decode(0), decode(1), decode(2)].join(' / '));
}

console.log('\n=== C. 精简版着色器（链接失败时的保底）===');
{
  const a = FRAG.indexOf('/* @@LITE_CUT_BEGIN@@ */');
  const b = FRAG.indexOf('/* @@LITE_CUT_END@@ */');
  ok('两个切割标记都在、且顺序正确', a >= 0 && b > a, `@${a} / @${b}`);
  ok('切掉的那段就是边界射线（里面有 rayDistTitle 调用）',
    a >= 0 && b > a && /rayDist(ip|Title)\(/.test(FRAG.slice(a, b)));
  ok('切完之后剩下的还在：颜色 / 涂色 / 悬停',
    a >= 0 && b > a && (() => {
      const lite = FRAG.slice(0, a) + FRAG.slice(b);
      return /vec4 colorOfPid/.test(lite) && /uShowPaint/.test(lite) && /uHoverTid/.test(lite);
    })());
  /* 括号必须还配平 —— 切歪了就是编译失败，比原来更糟 ✗ */
  const bal = (s, x, y) => s.split(x).length - s.split(y).length;
  const lite = a >= 0 && b > a ? FRAG.slice(0, a) + FRAG.slice(b) : '';
  ok('精简版大括号配平', bal(lite, '{', '}') === 0, `差 ${bal(lite, '{', '}')}`);
  ok('精简版小括号配平', bal(lite, '(', ')') === 0, `差 ${bal(lite, '(', ')')}`);
  ok('精简版比完整版小（切掉了那一大坨循环）', lite.length > 0 && lite.length < FRAG.length * 0.9,
    `${lite.length} vs ${FRAG.length}`);
}

console.log('\n=== D. 链接失败要自动退精简版 ===');
{
  ok('_build 里先试完整版、失败再试精简版',
    /_linkTry\(FRAG\)/.test(GL) && /_linkTry\(_liteSrc\)/.test(GL));
  ok('退成功之后记了 liteShader 标记（报告要看得见）',
    /this\.liteShader = true/.test(GL) && /if \(renderer\.liteShader\)/.test(APP));
  ok('精简版的**原因**也留着（下次排查不用再猜）',
    /this\.liteWhy = linkLog/.test(GL));
  /* ⚠ 显存不足（0x0505）时不许再试精简版 ✗ —— 再试一次只是白等 92 秒 ✓ */
  ok('显存不足时不白试精简版（白等 92 秒的事不许再来）',
    /ge0 !== 0x0505/.test(GL));
}

console.log('\n=== E. 数组纹理采不出来时改走「缩图」===');
{
  ok('有 _probeArrTex 自检', /_probeArrTex\(\)/.test(GL));
  ok('自检是**三态**（ok / bad / unknown），不是布尔',
    /ok: 'unknown'/.test(GL) && /out\.ok = 'bad'/.test(GL) && /out\.ok = 'ok'/.test(GL));
  ok('只有实测 bad 才改道（探测做不成不当坏 ✓）',
    /this\.arrOk === 'bad' && provinceIds/.test(GL));
  ok('改道时把 id 图按整数倍缩小（ceil(最大边/上限)）',
    /Math\.ceil\(Math\.max\(m\.mapWidth, m\.mapHeight\) \/ lim\)/.test(GL));
  ok('着色器按 uProvScale 除回去', /if \(uProvScale > 1\) ip = ip \/ uProvScale;/.test(CODE));
  ok('render() 每帧传了 uProvScale', /uniform1i\(u\.uProvScale/.test(GL));
  ok('自检收摊时的循环有上界（假 GL 上会死循环 ✗ 踩过）',
    /for \(let i = 0; i < 8; i\+\+\) \{\s*if \(gl\.getError\(\) === gl\.NO_ERROR\) break;/.test(GL));
}

console.log('\n=== F. 报告里写清楚走了哪条降级路 ===');
{
  ok('报告有「渲染降级」和「纹理编码」两条', /LOG\.env\('渲染降级'/.test(APP) && /LOG\.env\('纹理编码'/.test(APP));
}

console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
if (fails.length) {
  console.log('失败项：');
  fails.forEach((f) => console.log('  ✘ ' + f));
}
process.exit(fails.length ? 1 : 0);
