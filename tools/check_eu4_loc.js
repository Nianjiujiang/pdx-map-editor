'use strict';
/**
 * EU4 本地化「整目录读」的回归 —— 2026-10-18 风云世纪两千年「P 5088」那次。
 *
 *   node tools/check_eu4_loc.js
 *
 * 现象：图上大量省份写着 `P 5139` 这种编号。
 * 根因：`build_eu4.py` 读名字时**手写了 5 个顶层文件名**，而 mod 的省份名整份放在
 *      `localisation/replace/bu_prov_names_l_english.yml`（Paradox 的覆盖机制）→
 *      63 个省查不到名字，全退成 `humanize('p_5139')` = `P 5139`。
 * 修法：改用 `E.read_loc_dir()` 整目录递归读（它本来就支持 replace/ 覆盖）。
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

// ---- ① 源码：不再手写文件名清单，走 read_loc_dir ----
const src = fs.readFileSync(path.join(ROOT, 'build_eu4.py'), 'utf8');
ok('用了 read_loc_dir（整目录递归 + replace 覆盖）', /E\.read_loc_dir\(LOC\)/.test(src));
ok('不再依赖手写的 prov_names_l_english.yml 清单',
  !/prov_names_l_english\.yml", LOC \/ "areas_regions_l_english/.test(src));

// ---- ② 成品：没有 `P 编号` 占位名 ----
const TITLES = path.join(ROOT, 'data_fy', 'titles.json');
if (fs.existsSync(TITLES)) {
  const T = JSON.parse(fs.readFileSync(TITLES, 'utf8'));
  const names = T.names || [];
  const ph = names.filter((n) => /^P \d+$/.test(String(n || '')));
  ok('成品里没有 `P 编号` 占位名', ph.length === 0, `${ph.length} 个`);
  const zh = names.filter((n) => /^[\u4e00-\u9fa5]/.test(n || ''));
  ok('中文头衔名足够多', zh.length > 5000, `${zh.length} 个`);

  // 抽查：mod 新加的那批省份应该有真名
  const samples = { p_5139: '灵州', p_4961: '通州', p_5036: '毗陵' };
  let hit = 0;
  for (const [k, want] of Object.entries(samples)) {
    const i = T.keys.indexOf(k);
    if (i >= 0 && T.names[i] === want) hit++;
  }
  ok('抽查的省份名对得上', hit >= 2, `${hit}/3`);
} else {
  console.log('  · 跳过（还没有 data_fy）');
}

console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
process.exit(fails.length ? 1 : 0);
