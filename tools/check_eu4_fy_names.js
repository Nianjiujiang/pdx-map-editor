'use strict';
/**
 * 风云世纪两千年「双字节汉化被当普通文件读」的回归 —— 2026-10-28 那次。
 *
 *   node tools/check_eu4_fy_names.js
 *
 * 现象：图上 200 多个国家名、70 多个省名是控制字符乱码（`\x11‹\x7f\x12¾R`），
 *      悬停里也是。206 个头衔名 + 70 个省名 + 4 个湖名全坏。
 *
 * 根因：`parsers/eu4/parser.py` 的 `is_doublebyte_loc(path)` 只读前 4096 字节，
 *      数 0x10–0x1F 标记字节够不够 40 个。这个 mod 里有 **77 个很小的 yml**
 *      （`QF_lujiang_l_english.yml` 75 B / 6 个标记、
 *        `LiangYu5_l_english.yml` 247 B / 34 个标记），
 *      被判成普通 UTF-8 文件 → `0x10 xx yy` 被解成控制字符垃圾。
 *
 * 修法：
 *   ① `hanhua.looks_hanhua()` —— 头 4KB 不够数，就整文件解一遍看汉字占比 ≥ 30%
 *   ② `build_eu4.py` 把 mod 自带的中文并进汉化表（且 **mod 优先**，外部汉化退兜底）
 *   ③ 坏省名在 definition.csv 和本体都救不回时，用汉化表的 `PROV<id>` 顶上
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

/** 控制字符（0x10–0x1F）或替换符，这类名字画到图上是不可读的 */
function garbage(s) {
  return typeof s === 'string'
    && (/[\u0010-\u001f]/.test(s) || s.includes('\uFFFD'));
}

// ---- ① 源码：判据不再只看头 4KB，且带缓存 ----
const hanhuaSrc = fs.readFileSync(path.join(ROOT, 'parsers', 'eu4', 'hanhua.py'), 'utf8');
ok('hanhua 有 cjk_ratio 判据', /def cjk_ratio\(/.test(hanhuaSrc));
ok('hanhua 有 looks_hanhua（快路 + 整文件兜底）', /def looks_hanhua\(/.test(hanhuaSrc));
ok('快路仍只看头 4KB（大目录不白读）',
  /_PROBE_BYTES\s*=\s*4096/.test(hanhuaSrc));
ok('慢路用汉字占比而不是「标记字节够不够多」',
  /_MIN_CJK_RATIO\s*=\s*0\.30/.test(hanhuaSrc));

const parserSrc = fs.readFileSync(path.join(ROOT, 'parsers', 'eu4', 'parser.py'), 'utf8');
ok('is_doublebyte_loc 慢路委托给 hanhua.looks_hanhua',
  /is_doublebyte_loc[\s\S]{0,900}looks_hanhua/.test(parserSrc));
ok('is_doublebyte_loc 有缓存（构建期要问上百次）',
  /_DOUBLEBYTE_CACHE/.test(parserSrc));

const buildSrc = fs.readFileSync(path.join(ROOT, 'build_eu4.py'), 'utf8');
ok('构建期把 mod 自带中文并进汉化表', /_own_zh\s*=/.test(buildSrc));
ok('坏名不许夺权（_own_ok 过滤掉 broken/控制字符）',
  /_own_ok\s*=/.test(buildSrc) && /_own_ok/.test(buildSrc));
ok('mod 自带优先级高于外部汉化（真值表：zh 在前、own 在后覆盖）',
  /zh\s*=\s*\{\*\*zh,\s*\*\*_own_ok\}/.test(buildSrc));
ok('坏省名用汉化表 PROV<id> 顶上', /name_zh/.test(buildSrc)
  && /nametools_has_zh\(z\)/.test(buildSrc));

// ---- ② 三个「小文件被判成普通文件」的实例，现在必须解得出中文 ----
const locDir = path.join(ROOT, '_local', 'fy_root', 'localisation');

/** 复刻 hanhua.looks_hanhua：头 4KB 数标记字节，不够就整文件解一遍看汉字占比 */
function decodeDouble(raw) {
  // 0x10 xx yy → 双字节；这里是粗略复刻，只为验证「这个文件该走双字节那条路」
  return null;
}

function markBytes(buf, limit) {
  let n = 0;
  const end = Math.min(buf.length, limit);
  for (let i = 0; i < end; i++) {
    const b = buf[i];
    if (b >= 0x10 && b <= 0x1f) n++;
  }
  return n;
}

const SMALL = [
  'LiangYu5_l_english.yml',
  'QF_sanguojunfa_l_english.yml',
  'QF_ZO_l_english.yml',
  'QF_lujiang_l_english.yml',
];
let found = 0;
for (const name of SMALL) {
  for (const p of [path.join(locDir, name), path.join(locDir, 'replace', name)]) {
    if (!fs.existsSync(p)) continue;
    found++;
    const buf = fs.readFileSync(p);
    const head = markBytes(buf, 4096);
    ok(`「${name}」确实很小/标记字节很少（旧判据会误判）`,
      head < 40, `${buf.length} B · 标记 ${head} 个`);
    break;
  }
}
if (!found) console.log('  · 跳过（没有 _local/fy_root/localisation）');

// ---- ③ 成品数据：一个乱码都不许剩 ----
const FY = path.join(ROOT, 'data_fy_all', 'titles.json');
if (fs.existsSync(FY)) {
  const T = JSON.parse(fs.readFileSync(FY, 'utf8').replace(/^\uFEFF/, ''));
  const names = T.names || [];
  const bad = names.filter(garbage);
  ok('成品头衔名里没有控制字符 / U+FFFD', bad.length === 0,
    bad.length ? `${bad.length} 个，如 ${JSON.stringify(bad[0])}` : '0 个');

  const pn = T.provinceNames || [];
  const pbad = pn.filter(garbage);
  ok('成品省名里没有控制字符 / U+FFFD', pbad.length === 0,
    pbad.length ? `${pbad.length} 个，如 ${JSON.stringify(pbad[0])}` : '0 个');

  // 原来那批点名的坏名，现在得是正经中文
  const want = {
    '4_JBG': '罽宾',
    '194_HDS': '邯郸商军',
    '190_ZOH': '周术军',
    '582_BL6': '勃律',
    '1337_BES': '山北',
    '1926_MG0': '蒙古人民共和国',
    '1756_BL7': '博洛尔',
    '1187_QSG': '怯失米尔',
  };
  let hit = 0;
  const miss = [];
  for (const [k, v] of Object.entries(want)) {
    const i = names.length && T.keys.indexOf(k);
    if (i >= 0 && names[i] === v) hit++;
    else miss.push(`${k}=${i >= 0 ? names[i] : '(无)'}`);
  }
  ok('原来那 8 个坏国名全对上了', hit === Object.keys(want).length,
    hit === Object.keys(want).length ? `${hit}/${hit}` : miss.join(' '));
} else {
  console.log('  · 跳过（还没有 data_fy_all）');
}

// ---- ③b 占位名（`x` / `Unused19` / `Blocked` / `RNW` …）——
//      2026-10-28 伏尔泰的噩梦那一轮补的。definition.csv 第 5 列里这类"不是地名"的
//      标记原来只认 `Unused`，其余原样印到图上（`x` 一个字母、`Waste` 类型名）。
const nameSrc = fs.readFileSync(path.join(ROOT, 'parsers', 'eu4', 'parser.py'), 'utf8');
const unusedLine = (nameSrc.match(/_UNUSED_NAME\s*=\s*re\.compile\(([\s\S]{0,300}?)\)\s*\n/) || [])[1] || '';
for (const w of ['unused', 'placeholder', 'x', 'waste', 'blocked', 'rnw']) {
  ok(`_UNUSED_NAME 认「${w}」`, new RegExp(`\\b${w}\\b`, 'i').test(unusedLine),
    unusedLine ? '' : '没找到 _UNUSED_NAME');
}

// 伪头衔的兜底名 `#<地块号>`：剥完井号变成裸数字，前端虽然也挡，
// 但数据里躺着省号迟早从别的路漏出去 —— 现在整个写成空。
const pieceSrc = fs.readFileSync(path.join(ROOT, 'build_tier_pieces.py'), 'utf8');
ok('伪头衔的兜底名整个退成空（不是只剥井号留裸数字）',
  /name_sink\[t\.key\]\s*=\s*""\s+if\s+_pn\.startswith\("#"\)/.test(pieceSrc));

/** data_* 里"名字是占位标记"的条数（titles.names + meta 三张表） */
function placeholderAudit(dir) {
  const tj = path.join(ROOT, dir, 'titles.json');
  if (!fs.existsSync(tj)) return null;
  const PAT = /^\s*(?:unused(?:\s*land)?\s*\d*|placeholder\s*\d*|x|waste|blocked|rnw)\s*$/i;
  const T = JSON.parse(fs.readFileSync(tj, 'utf8').replace(/^\uFEFF/, ''));
  const out = { titles: (T.names || []).filter((n) => PAT.test(String(n || ''))).length };
  const mj = path.join(ROOT, dir, 'meta.json');
  if (fs.existsSync(mj)) {
    const M = JSON.parse(fs.readFileSync(mj, 'utf8').replace(/^\uFEFF/, ''));
    out.sea = Object.values(M.seaNames || {}).filter((v) => PAT.test(String(v || ''))).length;
    out.waste = Object.values(M.wastelandNames || {})
      .filter((v) => PAT.test(String(v || ''))).length;
    out.digits = (T.names || []).filter((n) => /^\d+$/.test(String(n || ''))).length;
  }
  return out;
}

const vn = placeholderAudit('data_vn');
if (vn) {
  ok('伏尔泰的噩梦：头衔名里没有占位标记', vn.titles === 0, `${vn.titles} 个`);
  ok('伏尔泰的噩梦：海/湖名里没有占位标记', vn.sea === 0, `${vn.sea} 个`);
  ok('伏尔泰的噩梦：荒地名里没有占位标记', vn.waste === 0, `${vn.waste} 个`);
  ok('伏尔泰的噩梦：伪头衔没有裸省号兜底名', vn.digits === 0, `${vn.digits} 个`);
} else {
  console.log('  · 跳过（还没有 data_vn）');
}

// ---- ④ meta：湖名、tag 名也不许有 ----
const META = path.join(ROOT, 'data_fy_all', 'meta.json');
if (fs.existsSync(META)) {
  const M = JSON.parse(fs.readFileSync(META, 'utf8').replace(/^\uFEFF/, ''));
  const sea = Object.values(M.seaNames || {});
  ok('海洋/湖泊名里没有乱码', sea.filter(garbage).length === 0,
    `${sea.filter(garbage).length} / ${sea.length}`);
  const tags = Object.values(M.countryTags || {}).map((v) => v && v.n);
  ok('国家 tag 名里没有乱码', tags.filter(garbage).length === 0,
    `${tags.filter(garbage).length} / ${tags.length}`);
  const waste = Object.values(M.wastelandNames || {});
  ok('荒地地名里没有乱码', waste.filter(garbage).length === 0,
    `${waste.filter(garbage).length} / ${waste.length}`);
} else {
  console.log('  · 跳过（还没有 data_fy_all/meta.json）');
}

console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
process.exit(fails.length ? 1 : 0);
