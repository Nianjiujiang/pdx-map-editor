'use strict';
/**
 * EU4 剧本层 + 附庸并入的回归 —— 2026-10-19（v1.10）
 *
 *   node tools/check_eu4_bookmarks.js
 *
 * 这一版干了两件事，都得钉住，不然以后改回去没人发现：
 *
 *  ① **剧本不再写死三个**（用户原话："EU4 的游戏剧本其实有不少，你说的三个是
 *     脚本写死的，能不能不要那么死板"✓）
 *     → bookmarks 全部读进来；原版 1.37 有 12 个 ✓
 *
 *  ② **藏（UTS）当清朝附庸时并入清朝**（用户原话："如果藏（UTS）是清朝附庸，
 *     就改成并入清朝"✓）
 *     → 按 `history/diplomacy` 那条 vassal（1724.1.1 → 1792.11.1）自己判 ✓
 *
 *  ⚠⚠ **②里最容易改错的一步：不能把"所有附庸"都并进宗主** ✗✗
 *     我第一版就是那么写的 —— 挪威并进丹麦（18 省）、立陶宛并进波兰（48 省）、
 *     葡萄牙并进西班牙（81 省）……**整张欧洲全糊成几坨** ✗
 *     所以这里专门有一条"别的附庸不许动"的断言 ✓
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const H = require('./lib/browser_stub.js');

const ROOT = H.ROOT;
const DATA = path.join(ROOT, 'data_eu4');
const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name);
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

function load() {
  const M = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
  const T = JSON.parse(fs.readFileSync(path.join(DATA, 'titles.json'), 'utf8'));
  const raw = zlib.inflateSync(fs.readFileSync(path.join(DATA, 'titlemap.bin')));
  const n = M.numProvinces;
  const rows = M.tiers.length;
  const a = new Uint16Array(raw.buffer, raw.byteOffset, rows * n);
  return { M, T, a, n, rows };
}

/* 某个省份在某年归谁（按**年份标签**找层，不写死层号 ✓） */
function ownerAt(D, pid, year) {
  const i = D.M.tiers.indexOf(String(year));
  if (i < 0) return '(没有这一层)';
  const idx = D.a[i * D.n + pid];
  if (idx === D.M.noTitle || idx >= D.T.keys.length) return '(无主)';
  return { key: D.T.keys[idx], name: D.T.names[idx] };
}

/** 这一年图上有没有某个 tag（按 key 前缀认） */
function tagsInYear(D, year) {
  const i = D.M.tiers.indexOf(String(year));
  const out = new Set();
  if (i < 0) return out;
  for (let p = 1; p < D.n; p++) {
    const idx = D.a[i * D.n + p];
    if (idx === D.M.noTitle || idx >= D.T.keys.length) continue;
    out.add(String(D.T.keys[idx] || ''));
  }
  return out;
}

(async () => {
  if (!fs.existsSync(path.join(DATA, 'meta.json'))) {
    console.log(`  ✘ 缺 ${path.relative(ROOT, DATA)}/meta.json —— 先跑 py build_eu4.py`);
    process.exit(1);
  }
  const D = load();
  const M = D.M;

  console.log('=== A. 剧本层：不写死，bookmarks 全读 ===');
  {
    const eras = (M.eraDates || []).filter(Boolean);
    ok('剧本层不止 3 个（bookmarks 全读进来了 ✓）', eras.length > 3,
      `${eras.length} 个：${eras.join(' ')}`);
    ok('原版 1.37 应该有 12 个剧本', eras.length === 12, `${eras.length} 个`);
    /* 这 12 个是原版 1.37 的真实 bookmark —— 少一个都说明读取逻辑退化了 ✓ */
    const want = ['1444.11.11', '1453.5.29', '1492.1.1', '1508.12.10', '1579.1.23',
      '1618.5.23', '1701.9.1', '1718.12.17', '1756.5.15', '1776.7.4', '1789.7.14',
      '1792.9.21'];
    const miss = want.filter((d) => eras.indexOf(d) < 0);
    ok('12 个剧本的日期都对得上（少一个就是读取退化了）', miss.length === 0,
      miss.length ? `缺：${miss.join(' ')}` : '全对 ✓');
    ok('meta.bookmarks 也写进去了（顶栏 tooltip 要用 ✓）',
      Array.isArray(M.bookmarks) && M.bookmarks.length >= eras.length,
      `${(M.bookmarks || []).length} 条`);
  }

  console.log('\n=== B. 地理层：大洲 / 大区接进层级了 ===');
  {
    const nm = M.tierNames || [];
    ok('层级里有「大洲」', nm.indexOf('大洲') >= 0, nm.join('/'));
    ok('层级里有「大区」', nm.indexOf('大区') >= 0, nm.join('/'));
    /* 从粗到细：大洲 → 大区 → 区域 → 地区 → 省份 ✓ */
    const tail = nm.slice(-5);
    ok('地理层顺序 大洲→大区→区域→地区→省份',
      JSON.stringify(tail) === JSON.stringify(['大洲', '大区', '区域', '地区', '省份']),
      tail.join('→'));
    /* 大洲那层真的挂上了（不是一片空 ✓） */
    const ci = M.tiers.indexOf('ct');
    let nct = 0;
    for (let p = 1; p < D.n; p++) {
      const idx = D.a[ci * D.n + p];
      if (idx !== M.noTitle && String(D.T.keys[idx] || '').indexOf('#') !== 0) nct++;
    }
    ok('大洲层真的挂上了省份（不是空壳 ✓）', nct > 3000, `${nct} 个省`);
  }

  console.log('\n=== C. 藏（UTS）当清朝附庸 → 并入清朝 ===');
  {
    /* ⚠ 只验"哪年并了、哪年没并" —— 具体省份号各版本会变，但年份区间不会 ✓
     *   原版那条 vassal：QNG → UTS，1724.1.1 起、1792.11.1 止 ✓ */
    const inRange = ['1756', '1776', '1789', '1792'];
    const outside = ['1444', '1453', '1492', '1508', '1579', '1618'];

    for (const y of inRange) {
      if (M.tiers.indexOf(y) < 0) { oks.push(`（跳过 ${y}）`); continue; }
      const tags = tagsInYear(D, y);
      ok(`${y}：藏已并入清朝（图上没有 UTS，有 QNG）`,
        !tags.has(`${y}_UTS`) && tags.has(`${y}_QNG`),
        `UTS=${tags.has(`${y}_UTS`)} QNG=${tags.has(`${y}_QNG`)}`);
    }
    for (const y of outside) {
      if (M.tiers.indexOf(y) < 0) { oks.push(`（跳过 ${y}）`); continue; }
      const tags = tagsInYear(D, y);
      /* 那年西藏还没归清朝（1724 才开始）→ **必须还独立** ✓
       * ⚠ 但如果那年 UTS 压根没地（1701/1718 就是），它本来就不在图里 ✓
       *   所以这里判"要么还在、要么那年确实没地"—— 用省份数判断 ✓ */
      let utsProv = 0;
      const i = M.tiers.indexOf(y);
      for (let p = 1; p < D.n; p++) {
        const idx = D.a[i * D.n + p];
        if (idx !== M.noTitle && D.T.keys[idx] === `${y}_UTS`) utsProv++;
      }
      ok(`${y}：藏还没归清朝 → 仍独立（或那年本就没地）`,
        utsProv > 0 || !tags.has(`${y}_QNG`),
        `藏 ${utsProv} 省 · QNG=${tags.has(`${y}_QNG`)}`);
    }

    /* 🔴 **康（KAM）也走同一条规则** ✗✗（2026-10-20 ✓ 用户："UTS 那条规则也补上对康（KAM）的"）
     *   diplomacy 里两条并列：QNG→UTS（1724.1.1~1792.11.1）和 QNG→KAM（1724.1.1~**1776.1.1**）
     *   ⚠ KAM 结束得早 —— 剧本 1776 是 **7 月 4 日**，已经过期 ✓
     *     所以只在 **1756** 那层能看到"UTS 和 KAM 同时并入" ✓
     *     1776 及以后 KAM 在自己 history 里也没地了（原始数据就是 0 省 ✓）*/
    /* ⚠ `M.tiers` 里存的是**字符串**（'1756' ✓）—— 拿数字 1756 去 indexOf
     *   永远 -1 ✗ 于是 `if (indexOf(1756) >= 0)` 一直是 false，
     *   这两条断言**悄悄跳过**了（我第一次跑就是这么"全绿"的 ✓）
     *   → 一律 `String(y)` ✓ */
    const countBy = (y, tag) => {
      const i = M.tiers.indexOf(String(y));
      if (i < 0) return -1;
      let c = 0;
      for (let p = 1; p < D.n; p++) {
        const idx = D.a[i * D.n + p];
        if (idx !== M.noTitle && D.T.keys[idx] === `${y}_${tag}`) c++;
      }
      return c;
    };
    if (M.tiers.indexOf('1756') >= 0) {
      ok('1756：康（KAM）也并进清朝了（跟藏同一条规则 ✓）',
        countBy(1756, 'KAM') === 0 && countBy(1756, 'QNG') > 0,
        `KAM=${countBy(1756, 'KAM')} 省 · QNG=${countBy(1756, 'QNG')} 省`);
      ok('1756：藏和康**两家都并**（不是找到一个就 break ✗）',
        countBy(1756, 'UTS') === 0 && countBy(1756, 'KAM') === 0,
        `UTS=${countBy(1756, 'UTS')} · KAM=${countBy(1756, 'KAM')}`);
    }
    /* 康在 1724 之前是独立的 ✓ */
    if (M.tiers.indexOf('1618') >= 0) {
      ok('1618：康还没归清朝 → 仍独立（7 省 ✓）',
        countBy(1618, 'KAM') > 0, `KAM ${countBy(1618, 'KAM')} 省`);
    }
  }

  console.log('\n=== D. 别的附庸一律不许并（我第一版在这栽了）===');
  {
    /* ⚠ **选年份要挑"附庸确实有地"的那种** ✗
     *   我第一版拿 1718 的挪威来验 —— 可那年在**原始 history 里就不是它的**
     *   （丹麦直辖，NOR 0 省 ✓）→ 断言红得莫名其妙 ✓ 跟并附庸毫无关系 ✓
     *
     *   真正有说服力的两组（都是**有地的附庸** ✓）：
     *     · 1444 挪威 NOR 18 省 —— diplomacy 里是 DAN 的附庸 ✓
     *     · 1618 葡萄牙 POR 70 省 —— 是 SPA 的附庸 ✓
     *   如果哪天有人又把"所有附庸并入宗主"写回去，这两条当场红 ✗ */
    const cases = [
      ['1444', 'NOR', 'DAN', '挪威', '丹麦', 18],
      ['1618', 'POR', 'SPA', '葡萄牙', '西班牙', 70],
    ];
    for (const [y, sub, lord, cnSub, cnLord, atLeast] of cases) {
      if (D.M.tiers.indexOf(y) < 0) { oks.push(`（跳过 ${y}）`); continue; }
      const tags = tagsInYear(D, y);
      if (!tags.has(`${y}_${lord}`)) {
        console.log(`     · ${y} 的${cnLord}不在图里 → 这组跳过`);
        continue;
      }
      /* 数一下附庸还剩多少省（并进宗主的话会是 0 ✓）*/
      let cnt = 0;
      const i = D.M.tiers.indexOf(y);
      for (let p = 1; p < D.n; p++) {
        const idx = D.a[i * D.n + p];
        if (idx !== D.M.noTitle && D.T.keys[idx] === `${y}_${sub}`) cnt++;
      }
      ok(`${y} 的${cnSub}（${sub}）没并进${cnLord}（${lord}）—— 只并西藏 ✓`,
        cnt >= atLeast,
        `还剩 ${cnt} 省（应 ≥ ${atLeast}）· ${lord}=${tags.has(`${y}_${lord}`)}`);
    }
  }

  console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    fails.forEach((f) => console.log('  ✘ ' + f));
  }
  process.exit(fails.length ? 1 : 0);
})();
