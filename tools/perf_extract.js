/**
 * 从"正式版单文件"里抽出 web/js/*.js 和 index.html，铺到 _local/rel/ 下
 * （这样桩就能像跑当前版一样跑它 ✓ 等价于用户机器上那个文件 ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const SRC = process.env.REL || 'C:\\Users\\lyc20\\Downloads\\→电脑点这里丨地图编辑器.html';
const OUT = path.join(H.ROOT, '_local', 'rel');

const { js, html } = H.readStandalone(SRC);
if (!js) { console.log('解不出 JS ✗（不是单文件产物？）'); process.exit(1); }

fs.mkdirSync(path.join(OUT, 'web', 'js'), { recursive: true });
// 单文件是按 `// ==== xxx.js ====` 拼的 ✓ 照这个切成模块
const parts = js.split(/\/\/ ={4,} ([\w.]+) ={4,}\r?\n/);
let n = 0;
for (let i = 1; i < parts.length; i += 2) {
  const name = parts[i], body = parts[i + 1] || '';
  if (!/\.js$/.test(name)) continue;
  fs.writeFileSync(path.join(OUT, 'web', 'js', name), body);
  n++;
}
// HTML 也用它自己的 ✓（makeEnv 从 root/web/index.html 读 ✓）
fs.writeFileSync(path.join(OUT, 'web', 'index.html'), html);
// 样式表：单文件里是内联的 ✗ 桩大概不做样式 → 给个空文件占位 ✓
const css = path.join(OUT, 'web', 'style.css');
if (!fs.existsSync(css)) fs.writeFileSync(css, '/* 单文件版样式是内联的 ✓ 这里占位 */\n');

console.log('抽出 ' + n + ' 个模块 → ' + OUT);
console.log('模块：' + fs.readdirSync(path.join(OUT, 'web', 'js')).join(' '));
console.log('index.html ' + (html.length / 1024).toFixed(0) + 'KB · 有 map-pick-list：' + (html.includes('map-pick-list') ? '有' : '没有'));
