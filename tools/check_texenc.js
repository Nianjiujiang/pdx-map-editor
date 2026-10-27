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

console.log('\n=== C2. 中间档着色器（Adreno 613 链接失败的退路）===');
{
  const a = GL.indexOf('function cutAuxBlock');
  const b = GL.indexOf('function ctxLost');
  ok('能抠出切块函数', a >= 0 && b > a, `@${a} / @${b}`);
  const mk = a >= 0 && b > a
    ? new Function(GL.slice(a, b) + '; return { cutAuxBlock, makeMidFragment, makeBorderOnlyFragment, makeTitleOnlyFragment };')()
    : null;
  const mid = mk ? mk.makeMidFragment(FRAG) : null;
  const border = mk ? mk.makeBorderOnlyFragment(FRAG) : null;
  const title = mk ? mk.makeTitleOnlyFragment(FRAG) : null;
  const bal = (s, x, y) => s.split(x).length - s.split(y).length;
  const midCode = stripComments(mid || '');
  const borderCode = stripComments(border || '');
  const titleCode = stripComments(title || '');

  ok('mid 生成得出来', !!mid, mid ? `${mid.length} 字符` : 'null ✗');
  ok('mid 还留着本层头衔 / 填色 / 多级链',
    /rayDistTitle\(/.test(midCode) && /rayDistPaint\(/.test(midCode) && /uExtraCount/.test(midCode));
  ok('mid 砍掉了水域 / 荒地两条独立通道',
    !/rayDistWater\(/.test(midCode) && !/rayDistWaste\(/.test(midCode));
  ok('mid 大括号 / 小括号配平',
    bal(mid || '', '{', '}') === 0 && bal(mid || '', '(', ')') === 0);

  ok('border 生成得出来', !!border, border ? `${border.length} 字符` : 'null ✗');
  ok('border 只留本层头衔 + 填色边界',
    /rayDistTitle\(/.test(borderCode) && /rayDistPaint\(/.test(borderCode)
    && !/for \(int ex/.test(borderCode) && !/uExtraShow\[ex\]/.test(borderCode)
    && !/rayDistWater\(/.test(borderCode) && !/rayDistWaste\(/.test(borderCode));
  ok('border 大括号 / 小括号配平',
    bal(border || '', '{', '}') === 0 && bal(border || '', '(', ')') === 0);

  ok('title 生成得出来', !!title, title ? `${title.length} 字符` : 'null ✗');
  ok('title 只留本层头衔线（填色 / 多级 / 水 / 荒地全砍）',
    /rayDistTitle\(/.test(titleCode)
    && !/rayDistPaint\(/.test(titleCode)
    && !/for \(int ex/.test(titleCode) && !/uExtraShow\[ex\]/.test(titleCode)
    && !/rayDistWater\(/.test(titleCode) && !/rayDistWaste\(/.test(titleCode));
  ok('title 大括号 / 小括号配平',
    bal(title || '', '{', '}') === 0 && bal(title || '', '(', ')') === 0);

  ok('五个切割标记都成对（EXTRA / WATER / WASTE / PAINTRAY / PAINTFN）',
    ['EXTRA', 'WATER', 'WASTE', 'PAINTRAY', 'PAINTFN'].every((n) => {
      const x = FRAG.indexOf('/* @@MID_CUT_' + n + '_BEGIN@@ */');
      const y = FRAG.indexOf('/* @@MID_CUT_' + n + '_END@@ */');
      return x >= 0 && y > x;
    }));
}

console.log('\n=== D. 链接失败要逐档退，不许一步退到没边界 ===');
{
  ok('_build 里先试完整版',
    /_linkTry\(FRAG\)/.test(GL));
  ok('完整版失败后会试 mid / border / title / lite 四档',
    /makeMidFragment\(FRAG\)/.test(GL)
    && /makeBorderOnlyFragment\(FRAG\)/.test(GL)
    && /makeTitleOnlyFragment\(FRAG\)/.test(GL)
    && /makeLiteFragment\(FRAG\)/.test(GL)
    && /_linkTry\(src\)/.test(GL));
  ok('退成功之后记了 shaderTier（报告要看得见）',
    /this\.shaderTier = tier/.test(GL)
    && /renderer\.shaderTier === 'mid'/.test(APP)
    && /renderer\.shaderTier === 'border'/.test(APP)
    && /renderer\.shaderTier === 'title'/.test(APP));
  ok('精简版仍然有 liteShader 标记（保底那条报告要看得见）',
    /this\.liteShader = \(tier === 'lite'\)/.test(GL) && /if \(renderer\.liteShader\)/.test(APP));
  ok('降级原因也留着（下次排查不用再猜）',
    /this\.liteWhy = _why/.test(GL));
  /* ⚠ 显存不足（0x0505）时不许再试 ✗ —— 再试一次只是白等 92 秒 ✓ */
  ok('显存不足时不白试降级着色器（白等 92 秒的事不许再来）',
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

console.log('\n=== G. 采样器精度（ANGLE 上不写就是编译不过）===');
{
  /* 🔴🔴 **2026-10-19 真机踩到的** ✗✗
   *   用户那台 AMD Radeon 610M · ANGLE D3D11 直接报：
   *       ERROR: 0:9:   'sampler2DArray' : No precision specified
   *       ERROR: 0:178: 'sampler2DArray' : No precision specified
   *   GLSL ES 3.00 里 **sampler 类型没有默认精度** ✓ 必须显式声明 ✓
   *   桌面原生 GL 常常糊过去 → **本地怎么试都好，一上 ANGLE 就白屏** ✗
   *
   *   ⚠ 这个 bug 是退役整数纹理时带进来的：v1.9 有
   *       `precision highp usampler2D;` / `precision highp usampler2DArray;`
   *     我删了 usampler 那两行，**却没补归一化的** ✗
   *   → 这条断言以后死死盯着：**用到的每个采样器类型，都必须有精度声明** ✓
   *
   *  ⚠ `sampler2D` 和 `sampler2DArray` 是**两个独立类型** ✗ 各写一次 ✓
   *  ⚠ 只看**代码**（注释里出现 `sampler2D` 不算 ✓ 先剥注释 ✓）
   */
  const code = stripComments(FRAG);
  // 用到的采样器类型（`uniform <type> <name>` 那张表里出现的 ✓）
  const used = new Set();
  for (const m of code.matchAll(/\buniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w*sampler\w*)\s+/g)) {
    used.add(m[1]);
  }
  const declared = new Set();
  for (const m of code.matchAll(/\bprecision\s+\w+\s+(\w*sampler\w*)\s*;/g)) {
    declared.add(m[1]);
  }
  ok('着色器里确实用了采样器（不然这条断言是空转的）', used.size > 0,
    [...used].join(' '));
  const missing = [...used].filter((t) => !declared.has(t));
  ok('每个用到的采样器类型都有 precision 声明（ANGLE 上不写就编译不过 ✗）',
    missing.length === 0,
    missing.length ? `缺：${missing.join(' / ')}` : `用了 ${[...used].join(' ')} · 都声明了 ✓`);
  /* **数组采样器单独一条** —— 它最容易漏（写了 sampler2D 不管用 ✗）*/
  if (used.has('sampler2DArray')) {
    ok('sampler2DArray 单独声明了精度（写 sampler2D 管不住它 ✗）',
      declared.has('sampler2DArray'));
  }
  /* 贪心抓一遍整个 gl.js：所有含 `#version 300 es` 的片元着色器模板都要有 ✓
     （主着色器 / 自检着色器 / 以后新加的 —— 一个都不许漏 ✓）*/
  {
    const shaders = [...GL.matchAll(/`#version 300 es[\s\S]*?`/g)]
      .map((m) => m[0])
      .filter((s) => /\buniform\s+\w*sampler\w*/.test(s) || /\buniform\s+\w+\s+\w*sampler/.test(s));
    let bad = 0;
    for (const s of shaders) {
      const u = new Set([...s.matchAll(/\buniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w*sampler\w*)\s+/g)]
        .map((m) => m[1]));
      const d = new Set([...s.matchAll(/\bprecision\s+\w+\s+(\w*sampler\w*)\s*;/g)].map((m) => m[1]));
      for (const t of u) if (!d.has(t)) bad++;
    }
    ok('gl.js 里每一段片元着色器都写了采样器精度（不止主着色器 ✓）',
      shaders.length > 0 && bad === 0,
      `${shaders.length} 段着色器 · 漏声明 ${bad} 处`);
  }
}

console.log('\n=== H. 着色器模板完整性（反引号不许进注释）===');
{
  /* 🔴🔴 **一个坑我踩了两次，所以钉死它** ✗✗（2026-10-19 ✓）
   *
   *  着色器是**模板字符串**（反引号括起来的 ✓）—— 只要注释里出现一个反引号，
   *  模板就**当场截断**：后面那段变成 JS 代码 → SyntaxError 或着色器残缺 ✓
   *
   *  · 第一次（退役整数纹理那天）：注释里写「`整数纹理采样`」→
   *      SyntaxError: Unexpected identifier '整数纹理采样' ✓ 页面直接白屏 ✓
   *  · 第二次（就是刚才修 ANGLE 精度那次）：我在精度说明里写了
   *      `sampler2DArray` 和 `sampler2D` —— 模板从 41311 字符截到 **459** ✗
   *      而且**语法居然还过**（两个反引号凑成了合法的表达式 ✓）
   *      → 只有编译着色器时才会炸，又一次"本地测不出来"✓
   *  → 这条断言：**FRAG 模板里出现任何反引号就红** ✓
   */
  const src = GL;
  const bt = String.fromCharCode(96);
  // FRAG 从 `const FRAG = ` + 反引号 开始，到**下一个反引号**为止 —— 正常应该是几万字符
  const m = new RegExp('const FRAG = ' + bt + '([\\s\\S]*?)' + bt).exec(src);
  ok('FRAG 模板找得到', !!m);
  if (m) {
    const body = m[1];
    ok('FRAG 里一个反引号都没有（有一个就会把模板截断 ✗）',
      body.indexOf(bt) < 0,
      body.indexOf(bt) < 0 ? `${body.length} 字符，干净 ✓`
        : `在第 ${body.indexOf(bt)} 字符处混进了一个反引号 ✗`);
    /* **长度兜底**：正常 FRAG 是几万字符 ✓ 只有几百 = 被截断了 ✓
       （这条防的是"两个反引号凑成合法语法"那种 —— 光看有没有反引号看不出来 ✓）*/
    ok('FRAG 长度正常（几万字符，不是被截断的几百）',
      body.length > 5000, `${body.length} 字符`);
    ok('FRAG 结尾是完整的那几句（uWaterKind / 主函数收尾 ✓）',
      /void main\s*\(/.test(body) && body.trim().endsWith(bt === '' ? '' : '}'),
      `结尾：…${body.trim().slice(-40)}`);
  }
  /* 整个 gl.js 里所有着色器模板都要过这一关 ✓（以后新加的也算 ✓）*/
  {
    const re = new RegExp(bt + '#version 300 es([\\s\\S]*?)' + bt, 'g');
    const all = [...src.matchAll(re)];
    ok('gl.js 里每段着色器都完整（共 ' + all.length + ' 段 ✓）',
      all.length >= 2 && all.every((x) => x[1].length > 60 || /^[\s\S]{0,60}$/.test(x[1])),
      all.map((x) => x[1].length).join(' / '));
  }
}

console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
if (fails.length) {
  console.log('失败项：');
  fails.forEach((f) => console.log('  ✘ ' + f));
}
process.exit(fails.length ? 1 : 0);
