'use strict';
/**
 * EU4 数据文件的编码回归 —— 2026-10-18 风云世纪两千年乱码那次。
 *
 *   node tools/check_eu4_encoding.js
 *
 * 现象：图上和悬停里一大堆地名/国名是 `å®‹å¡` 这种。
 * 根因：`read_text()` 一律按 cp1252 解，而这个 mod 的 `definition.csv` 是 **UTF-8**
 *      → 中文字节被当成 cp1252 → 99 个以 `#中文` 命名的省份全成乱码。
 * 修法：先按 UTF-8 严格解，解不了才退回 cp1252（纯 ASCII 两者等价，原版不变）。
 *
 * ⚠ 这里**不调用 python**（沙箱里子进程管道会被拦）—— 直接用 node 复刻那两条判据 ✓
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name);
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

// ---- ① 源码层面：read_text 真的先试 UTF-8、再退 cp1252 ----
const src = fs.readFileSync(path.join(ROOT, 'parsers', 'eu4', 'parser.py'), 'utf8');
const at = src.indexOf('def read_text(path: Path) -> str:');
const tail = src.slice(at, at + 900);
ok('read_text 先按 utf-8-sig 解', /utf-8-sig/.test(tail));
ok('解不了才退回 cp1252', /UnicodeDecodeError/.test(tail) && /cp1252/.test(tail));

// ---- 复刻 read_text 的行为 ----
function readText(p) {
  const raw = fs.readFileSync(p);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch (e) {
    return new TextDecoder('windows-1252').decode(raw);
  }
}

/** 只取第 5 列（省份名），跟 parse_definition 同一套切法 */
function provNames(p) {
  const out = [];
  for (const line of readText(p).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(';');
    if (parts.length < 5) continue;
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push(parts[4].trim());
  }
  return out;
}

// ---- ② 真文件：mod 的 definition.csv 中文名解对了 ----
const MOD_CSV = path.join(ROOT, '_local', 'fy_root', 'map', 'definition.csv');
if (fs.existsSync(MOD_CSV)) {
  const names = provNames(MOD_CSV);
  const bad = names.filter((n) => /\uFFFD/.test(n));
  const zh = names.filter((n) => n && /^[\u4e00-\u9fa5]/.test(n));
  ok('mod 的 definition.csv 读出来了', names.length > 4000, `${names.length} 个省份`);
  ok('没有 `å®‹` 那种典型乱码', !names.some((n) => /å|ã|æ|ç|é¾/.test(n)),
    names.find((n) => /å/.test(n)) || '无');
  ok('坏字节没超过一小撮', bad.length < 20, `${bad.length} 个`);
} else {
  console.log('  · 跳过（没有 _local/fy_root/map/definition.csv）');
}

// ---- ②b 成品数据：烘出来的 titles.json 里中文名要正常 ----
const FY_TITLES = path.join(ROOT, 'data_fy', 'titles.json');
if (fs.existsSync(FY_TITLES)) {
  const T = JSON.parse(fs.readFileSync(FY_TITLES, 'utf8'));
  const names = T.names || [];
  const bad = names.filter((n) => /\uFFFD/.test(n || ''));
  const zh = names.filter((n) => n && /^[\u4e00-\u9fa5]/.test(n));
  ok('成品里中文头衔名很多', zh.length > 300, `${zh.length} 个，如 ${zh.slice(0, 3).join('、')}`);
  ok('成品里坏字节很少', bad.length < 20, `${bad.length} / ${names.length}`);
  ok('成品里没有整片 `å®‹` 式乱码',
    names.filter((n) => /^å|^ã|^æ|^ç/.test(n || '')).length === 0,
    names.find((n) => /^å/.test(n || '')) || '无');
} else {
  console.log('  · 跳过（还没有 data_fy）');
}

// ---- ③ 原版那份不能被带歪 ----
const BASE_CSV = 'C:\\Steam\\steamapps\\common\\Europa Universalis IV\\map\\definition.csv';
if (fs.existsSync(BASE_CSV)) {
  const names = provNames(BASE_CSV);
  ok('原版 definition.csv 读得出来', names.length > 4000, `${names.length} 个`);
  ok('原版没有乱码', !names.some((n) => /\uFFFD/.test(n)));
  ok('原版的 Ö 还是 Ö（cp1252 那条路没坏）',
    names.some((n) => /Östergötland/.test(n)), names[1]);
} else {
  console.log('  · 跳过（本机没装 EU4）');
}

console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
process.exit(fails.length ? 1 : 0);
