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

/** 🔴 **跟 `_pick_def_name` 同一套判据** ✗✗（2026-10-19 加的）
 *
 *  中文 mod 把中文塞在 `#` 后面，两种位置都有：
 *    第 5 列：` #大泽山` / `Eastern Daba Mountains;x #大巴山（东）`
 *    第 6 列：`Ravensburg;x\t#拉文斯堡`
 *  ⚠ **不能见 `#` 就切** ✗ —— 原版 `Central Atlantic #1` 是编号，后面没汉字 ✓
 *  这条复刻的是"`#` 之后必须带汉字"那个判据 ✓
 */
const HASH_ZH = /#\s*([^#]*[\u4e00-\u9fff][^#]*)/;
function pickDefName(parts) {
  const c5 = (parts[4] || '').trim();
  const c6 = (parts[5] || '').trim();
  for (const raw of [c6, c5]) {
    if (!raw.includes('#')) continue;
    const m = HASH_ZH.exec(raw);
    if (m && m[1].trim()) return m[1].trim();
  }
  // `; #` 这种空占位 → 空名字 ✓（不能返回 `#` ✗ 见 parser.py 同一段 ✓）
  if (c5.startsWith('#')) return '';
  return c5;
}

/** 按**新**判据取名字（= 烘数据时真正会得到的那个） */
function provNamesFixed(p) {
  const out = [];
  for (const line of readText(p).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(';');
    if (parts.length < 5) continue;
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push(pickDefName(parts));
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

  /* 🔴 **`#` 后面的中文名要取出来** ✗✗（2026-10-19 用户报的"荒地变英文 / 带井号"）
   *   这条是那件事**真正的根因**：名字根本没读对，后面的补丁只是擦屁股 ✓
   *   ⚠ 判据见 `pickDefName` —— 只有 `#` 后**带汉字**才切 ✓
   *     原版 `Central Atlantic #1` 那种编号**必须原样留着** ✗ */
  const fixed = provNamesFixed(MOD_CSV);
  const stillHash = fixed.filter((n) => /^#/.test(n));
  const hashZh = fixed.filter((n) => /[\u4e00-\u9fa5]/.test(n));
  ok('第 6 列的中文名也读出来了（`Ravensburg;x #拉文斯堡`）',
    fixed.length === names.length && hashZh.length > 500,
    `${hashZh.length} 个带中文`);
  ok('成品名字不再以 `#` 开头（井号是"不上地图"约定，不能印出来 ✗）',
    stillHash.length === 0, stillHash.slice(0, 3).join(' | ') || '无');
  /* 那两个用户点名的省，必须拿到中文 ✓ */
  {
    const byPid = new Map();
    let k = 0;
    for (const line of readText(MOD_CSV).split(/\r?\n/)) {
      const parts = line.split(';');
      if (parts.length < 5) continue;
      const pid = Number(parts[0]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      byPid.set(pid, pickDefName(parts));
    }
    const a = byPid.get(3210) || '';
    const b = byPid.get(5067) || '';
    ok('省 3210 拿到「大泽山」（第 5 列的 ` #大泽山` ✓）',
      /大泽山/.test(a), a || '(空)');
    ok('省 5067 拿到「大巴山（东）」（第 6 列的 `x #大巴山（东）` ✓）',
      /大巴山/.test(b), b || '(空)');
  }
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
  /* 🔴 **原版的 `# 编号` 一个都不许被切掉** ✗✗（2026-10-19）
   *   原版有 131 个 `Central Atlantic #1` 这种水域名 ✓
   *   新加的 `#` 判据要是写宽了，就会把它们切成 `1` ✗ —— 那才是真回归 ✓ */
  const fixedBase = provNamesFixed(BASE_CSV);
  const numOnly = fixedBase.filter((n) => /^\d+$/.test(n)).length;
  const hashKeep = fixedBase.filter((n) => /#\d+$/.test(n)).length;
  ok('原版的 `Central Atlantic #1` 原样保留（`#` 后没汉字就不切 ✓）',
    hashKeep >= 100 && numOnly === 0,
    `保留 ${hashKeep} 个 · 被切成纯数字的 ${numOnly} 个`);
  ok('原版名字跟改动前逐字一致',
    fixedBase.length === names.length && fixedBase.every((v, i) => v === names[i]));
} else {
  console.log('  · 跳过（本机没装 EU4）');
}

console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
process.exit(fails.length ? 1 : 0);
