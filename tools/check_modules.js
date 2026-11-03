'use strict';
/**
 * 模块清单体检 —— 「三份清单要一致」的自动化版（2026-11-03）
 *
 *   node tools/check_modules.js
 *
 * 背景：web/js 下十几个模块要靠一份**顺序**拍平成单文件版；
 * 桩（tools/lib/browser_stub.js）、自测（tools/test_modes.js）、构建脚本
 * （build_standalone.py）以前各自抄了一份清单，谁错了都不报 ——
 * 2026-11-02 加 brewer.js 只改了构建脚本，结果**所有**拍平工具一启动就
 * `ReferenceError: BREWER is not defined`（连 bench 都跑不了）。
 *
 * 现在唯一事实源是 build_standalone.py 的 `MODULES`，桩把它读出来。
 * 这份检查盯这些"看起来没事、跑起来才发现"的漂移：
 *   A. 构建脚本的清单**能被解析**（行首 MODULES = (...)），且非空、无重复
 *   B. 清单里每个文件都真实存在（大小写 / 改名 / 删文件）
 *   C. web/js 下每个 .js 都登记了（新增模块最容易漏）
 *   D. web/index.html 的 <script src="js/..."> 都登记了
 *   E. 所有相对 import 的 ./x.js 都登记了（漏一个就是运行时 ReferenceError）
 *   F. 拍平之后真的能 instantiate（顺序错 / 语法错 / 少模块会在这里炸）
 *
 * 退出码：全过 0，任一失败 1 ✓（方便塞进 CI / pre-commit）
 */
const fs = require('fs');
const path = require('path');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}
/** 错误信息一律带**路径 + 怎么修** ✗ 别只留一个原生 stack ✓ */
function die(msg) {
  console.log('\n✘ ' + msg);
  process.exit(1);
}

/* 桩本身读不到构建脚本时会**大声抛**（带路径和修法）✓
 * 这里接住它，把提示原样转给用户，而不是甩一个 require 栈 ✓ */
let H;
try {
  H = require('./lib/browser_stub.js');
} catch (e) {
  die('加载工具桩失败（tools/lib/browser_stub.js）：\n'
    + '  ' + String(e && e.message || e).split('\n').join('\n  ')
    + '\n  怎么修：先按上面的提示修好清单；这条检查本身就是来抓清单漂移的。');
}

const ROOT = H.ROOT;
const BUILD = path.join(ROOT, 'build_standalone.py');
const JS_DIR = path.join(ROOT, 'web', 'js');
const HTML = path.join(ROOT, 'web', 'index.html');

/** 从构建脚本里再独立解析一遍（验证桩读出来的确实是那一份 ✓）*/
function parseBuildList() {
  const src = fs.readFileSync(BUILD, 'utf8');
  const m = /^MODULES\s*=\s*\(([\s\S]*?)\)\s*$/m.exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/["']([^"']+\.js)["']/g)].map((x) => x[1]);
}

/** 一个 .js 源码里所有相对 import 指向的文件 ✓ */
function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/(?:from\s+|import\s+)['"]\.\/([A-Za-z0-9_.-]+\.js)['"]/g)) {
    out.add(m[1]);
  }
  return [...out];
}

console.log('=== 模块清单（唯一事实源 = build_standalone.py 的 MODULES）===');

const buildList = (() => {
  try { return parseBuildList(); } catch (e) {
    die(`读不到 ${BUILD}：${e.code || e.message}\n`
      + '  怎么修：确认在仓库根目录运行；这个文件是清单的事实源，不能缺。');
  }
})();
ok('build_standalone.py 里的 MODULES 能解析（行首 `MODULES = (...)`）',
  Array.isArray(buildList) && buildList.length > 0,
  Array.isArray(buildList) ? `${buildList.length} 个` : '解析失败');
if (!Array.isArray(buildList) || !buildList.length) {
  die('清单解析失败，后面的检查没有意义。\n'
    + `  期望：${BUILD} 里有一行以 MODULES = ( 开头、以 ) 收尾的文件名列表。\n`
    + '  怎么修：照着构建脚本里原来的形状写回去；别把清单挪成多份。');
}

ok('桩读出来的清单 = 构建脚本里那份（含顺序 ✓）',
  JSON.stringify(H.MODULES) === JSON.stringify(buildList),
  JSON.stringify(H.MODULES) === JSON.stringify(buildList)
    ? `${H.MODULES.length} 个`
    : `桩 ${H.MODULES.length} 个 ｜ 构建 ${buildList.length} 个`);

ok('清单里没有重复项', new Set(buildList).size === buildList.length,
  [...new Set(buildList.filter((n, i) => buildList.indexOf(n) !== i))].join(' ') || '无重复');

/* ---- B. 文件都在 ---------------------------------------------------------- */
const missing = buildList.filter((n) => !fs.existsSync(path.join(JS_DIR, n)));
ok('清单里每个文件都存在 ✓', missing.length === 0,
  missing.length ? '缺：' + missing.join(' ') : '全部存在');
if (missing.length) {
  console.log(`  怎么修：在 ${JS_DIR} 下补回这些文件，或从 build_standalone.py 的 MODULES 里删掉。`);
}

/* ---- C. 磁盘上的 .js 都登记了 -------------------------------------------- */
const onDisk = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();
const notListed = onDisk.filter((f) => !buildList.includes(f));
ok('web/js 下每个 .js 都登记在清单里 ✓', notListed.length === 0,
  notListed.length ? '漏登记：' + notListed.join(' ') : `共 ${onDisk.length} 个，全部登记`);
if (notListed.length) {
  console.log('  怎么修：把新文件加到 build_standalone.py 的 MODULES（位置按依赖顺序，'
    + '一般放在 app.js 前面）；桩会自动读到，不用再改第二处。');
}

/* ---- D. index.html 的本地脚本 -------------------------------------------- */
const htmlSrc = fs.readFileSync(HTML, 'utf8');
const pageScripts = [...htmlSrc.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)]
  .map((m) => m[1]).filter((s) => /^js\//.test(s)).map((s) => s.slice(3));
const pageMissing = pageScripts.filter((s) => !buildList.includes(s));
ok('index.html 的 <script src="js/..."> 都登记在清单里', pageMissing.length === 0,
  pageMissing.length ? '未登记：' + pageMissing.join(' ') : pageScripts.join(' ') || '（没有本地脚本）');
if (pageMissing.length) {
  console.log('  怎么修：它们要么加进 MODULES，要么从 index.html 删掉 —— '
    + '只在页面里加载、单文件版拼不进去，就是"开发版能用、发布版少功能"✗');
}

/* ---- E. 相对 import 全部落在清单上 ---------------------------------------- */
{
  const bad = [];
  for (const f of onDisk) {
    for (const dep of importsOf(path.join(JS_DIR, f))) {
      if (!buildList.includes(dep)) bad.push(`${f} → ${dep}`);
      else if (!fs.existsSync(path.join(JS_DIR, dep))) bad.push(`${f} → ${dep}（文件不存在）`);
    }
  }
  ok('所有相对 import 的目标都在清单里、且文件存在 ✓', bad.length === 0,
    bad.length ? bad.join(' ｜ ') : '无悬空 import');
  if (bad.length) {
    console.log('  怎么修：import 指向的模块必须先加进 MODULES，否则拍平后它就是 undefined ✗');
  }
}

/* ---- F. 真拍一遍、真跑一遍 ------------------------------------------------ */
console.log('\n=== 拍平后能不能跑 ===');
try {
  const js = H.flattenModules();
  ok('拍平成功（每个文件都读得到 ✓）', js.length > 0, `${(js.length / 1024).toFixed(0)} KB`);
  const env = H.makeEnv({ root: ROOT });
  const ex = H.instantiate(js, env);
  ok('instantiate 成功（顺序 / 语法 / 少模块都会在这里炸 ✓）', !!ex && typeof ex.boot === 'function',
    ex ? '拿到 boot()' : '没有 boot');
  /* 只验"能起来"，不真开图（那是 bench / test_modes 的活 ✓）*/
  ok('自测清单恰好少 log.js / tutorial.js 两个 ✓',
    JSON.stringify(H.testModules()) === JSON.stringify(buildList.filter(
      (n) => n !== 'log.js' && n !== 'tutorial.js')),
    `${H.testModules().length} 个`);
} catch (e) {
  ok('拍平后能运行', false, String(e && e.message || e).split('\n')[0]);
  console.log('\n  ↓ 完整错误（挑头几行够定位了）');
  console.log(String(e && e.stack || e).split('\n').slice(0, 12).join('\n'));
  console.log('  怎么修：按上面 "==== 模块名 ====" 的边界看是哪个模块出的错；'
    + '常见是清单顺序不对（依赖要排在用它的文件前面）或新模块漏登记。');
}

console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
if (fails.length) {
  console.log('失败项：');
  fails.forEach((f) => console.log('  ✘ ' + f));
}
process.exit(fails.length ? 1 : 0);
