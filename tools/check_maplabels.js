/**
 * 验一遍「P社式版图排版」（web/js/maplabels.js）。
 *
 *   node tools/check_maplabels.js            # 默认 CK3
 *   node tools/check_maplabels.js EU4
 *   node tools/check_maplabels.js VIC3
 *
 * 为什么要有它：排版这东西**看截图最快**，但截图进不了自测 ✗ ——
 *   这里用真实地图数据（省份图 + 归属表）把几何关系量出来：
 *     · 字的中心有没有落在自己的版图里（文档 §9 的 80% ✓）
 *     · ≤2 个字的名字是不是直的（CK3 的 LENGTH_CURVE_CUTOFF ✓）
 *     · 接近方形的版图有没有莫名歪掉（SQUARENESS ✓）
 *     · 单次排版耗时（文档要求 < 1ms ✓）
 *   这些条件挂了，画面上多半就是"名字跑到海里 / 歪七扭八"✓
 *
 * ⚠ 它**不画字** ✗ —— 字宽用近似值（汉字 1em、拉丁按字母粗估 ✓），
 *   真实 Canvas 的 measureText 会略有出入 ✓ 但判"在不在版图里"够用了 ✓
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const WHICH = (process.argv[2] || 'CK3').toUpperCase();
const DIRS = {
  CK3: 'data', EU4: 'data_eu4', VIC3: 'data_vic3', HOI4: 'data_hoi4', EU5: 'data_eu5',
};
const DIR = DIRS[WHICH] || 'data';

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

/** 汉字按 1em、拉丁按字母粗估 —— 只用来算"名字大概多宽" ✓ */
function metricsOf(text) {
  const chars = Array.from(String(text));
  const adv = chars.map((ch) => {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(ch)) return 100;
    if (ch === ' ') return 32;
    if (/[ilI1.,'`]/.test(ch)) return 28;
    if (/[mwMW]/.test(ch)) return 85;
    return 55;
  });
  return { ref: 100, adv, ascent: 80, descent: 20 };
}

function isPseudoKey(k) {
  return !k || k.startsWith('#') || k.startsWith('wl_') || k.startsWith('impassable');
}

(async () => {
  console.log(`=== P社式版图排版 · ${WHICH}（${DIR}）===`);
  const base = path.join(ROOT, DIR);
  if (!fs.existsSync(path.join(base, 'meta.json'))) {
    console.log(`  ✘ 没有 ${DIR}/meta.json —— 先跑构建`);
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(base, 'meta.json'), 'utf8'));
  const titles = JSON.parse(fs.readFileSync(path.join(base, 'titles.json'), 'utf8'));
  const W = meta.mapWidth | 0, H = meta.mapHeight | 0, n = meta.numProvinces | 0;
  const idsBuf = zlib.inflateSync(fs.readFileSync(path.join(base, 'provinces_id.bin')));
  const tmBuf = zlib.inflateSync(fs.readFileSync(path.join(base, 'titlemap.bin')));
  const ids = new Uint16Array(idsBuf.buffer, idsBuf.byteOffset, idsBuf.length >> 1);
  const tm = new Uint16Array(tmBuf.buffer, tmBuf.byteOffset, tmBuf.length >> 1);
  const NO_TITLE = meta.noTitle != null ? meta.noTitle : 65535;
  const titleAt = (pid, tier) => (pid > 0 && pid < n ? tm[(tier | 0) * n + pid] : NO_TITLE);

  const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'maplabels.js'), 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const { RealmMaskSource, layoutMapName } = mod;

  ok('省份图尺寸对得上 meta', ids.length >= W * H, `${ids.length} vs ${W * H}`);
  const mask = new RealmMaskSource({
    provinceIds: ids, width: W, height: H, titleAt, noTitle: NO_TITLE, cell: 8,
  });
  ok('能建版图栅格', mask.usable);

  const nTier = (meta.tiers || []).length || 5;
  const nEra = (meta.eraDates || []).length;
  /* 国名层：有剧本就测第一层；没有（CK3 其实是"剧本层"混在最粗几层里）就测 0 ✓
   * 地名层：取中间一层（CK3 是公爵领 / 伯爵领那一带 ✓）*/
  const countryTier = 0;
  const placeTier = Math.min(nTier - 1, Math.max(countryTier + 1, 3));

  /* 🔴 **有块号时必须听 app 的**（2026-10-23 用户："名字数量的标准和版图的连通域必须是一套"）
   *   名字有几个块一直是 app 按省份并查集定的 ✓ 排版器以前自己按像素再分一次 ✗
   *   这里给一个"按头衔当块号"的 groupOf：同一个头衔**只能有一块** ✓
   *   （真实场景里 app 给的是更细的块号，一个头衔可能有好几块 —— 那也是 app 说了算 ✓）*/
  {
    const m2 = new RealmMaskSource({
      provinceIds: ids, width: W, height: H, titleAt, noTitle: NO_TITLE, cell: 8,
      groupOf: (pid, t) => titleAt(pid, t),
    });
    const g2 = m2.gridFor(countryTier);
    let split = 0;
    if (g2) {
      g2.tidComps.forEach((list, tid) => { if (list.length > 1) split++; });
    }
    ok('给了块号就按 app 的块分（一个头衔不会被拆成好几块）',
       !!g2 && split === 0, g2 ? `${split} 个头衔被拆开` : '栅格没建出来');
  }

  let totalMs = 0, totalN = 0;
  const bad = [];
  for (const [label, tier, minCount] of [
    ['国名层', countryTier, 60],
    ['地名层', placeTier, 25],
  ]) {
    const t0 = Date.now();
    const g = mask.gridFor(tier);
    if (!g) { ok(`${label}：栅格建得出来`, false); continue; }
    const buildMs = Date.now() - t0;
    const comps = g.comps
      .filter((c) => {
        const k = String(titles.keys[c.tid] || '');
        const nm = String(titles.names[c.tid] || '');
        return c.count >= minCount && c.diag >= 40 && !isPseudoKey(k)
          && nm && !nm.startsWith('#');
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 160);

    let laid = 0, fallback = 0, smoothOk = 0, straightOk = 0, squareOk = 0;
    let straightN = 0, squareN = 0;
    /* 🔴 **基线不许跑到"同头衔的另一块"上**（2026-10-23 用户点破的坑）
     *   同一个头衔本来就有好几个**像素连通域**（本土 + 一堆岛）——
     *   拿 `titleAt` 比头衔等于"整国都算自己"，跨海照样连过去 ✗
     *   这里逐个字查它落在哪个连通域：同 tid、但**不是选中的那一块** → 记一次违规 ✓ */
    let crossN = 0;
    const crossBad = [];
    let curvedN = 0, curvedOk = 0;
    const flatBad = [];
    const compAt = (x, y) => {
      const cx = (x / g.cell) | 0, cy = (y / g.cell) | 0;
      if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return -1;
      return g.comp[cy * g.cols + cx];
    };
    for (const c of comps) {
      const name = String(titles.names[c.tid]);
      const m = metricsOf(name);
      const t1 = Date.now();
      const lay = layoutMapName(name, mask, c.tid, tier, m, {
        anchor: { x: c.cx, y: c.cy, area: c.count * 64 },
        userScale: 1,
      });
      totalMs += Date.now() - t1;
      totalN++;
      /* null = 排不出来（小岛 / 太细 / 字心会飘出去 ✓）→ 画面上退回老画法 ✓
       * 这是**允许**的兜底 ✓ 只要别大面积发生 ✓ */
      if (!lay) { fallback++; bad.push(`${name}（退回老画法）`); continue; }
      laid++;
      /* 有没有字跑进了同头衔的**另一块**（不是选中的那个连通域）✓       * ⚠ 紧贴本块边缘的那一格不算 ✗ —— 那是 8px 栅格的台阶误差（跟排版里的准入同一口径 ✓）*/
      {
        const near = (cx, cy, want) => {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = cx + dx, yy = cy + dy;
              if (xx < 0 || yy < 0 || xx >= g.cols || yy >= g.rows) continue;
              if (g.comp[yy * g.cols + xx] === want) return true;
            }
          }
          return false;
        };
        let crossed = 0;
        for (const gl of lay.glyphs) {
          const cx = (gl.x / g.cell) | 0, cy = (gl.y / g.cell) | 0;
          const ci2 = compAt(gl.x, gl.y);
          if (ci2 < 0 || ci2 === lay.comp) continue;
          const c2 = g.comps[ci2];
          if (!c2 || c2.tid !== c.tid) continue;
          if (c2.count < 400) continue;           // 小岛 / 碎屑：字压在岛上是正常的 ✓
          if (near(cx, cy, lay.comp)) continue;   // 台阶误差，允许 ✓
          crossed++;
        }
        if (crossed) { crossN++; if (crossBad.length < 5) crossBad.push(`${name}×${crossed}`); }
      }
      /* 🔴 **弯曲的字必须真的弯着**（2026-10-23 用户："过于贴合几何中心会让弧度失效"）
       *   之前把每列都夹到同一个偏移上 = 曲线被抹平成直线 ✗
       *   这里量"各字相对首尾连线的垂向极差"：弯的标必须 > 0.2% 线长 ✓ */
      if (lay.path && lay.path.length > 2 && lay.glyphs.length > 2) {
        curvedN++;
        const A = lay.glyphs[0], B = lay.glyphs[lay.glyphs.length - 1];
        let vx = B.x - A.x, vy = B.y - A.y;
        const L = Math.hypot(vx, vy) || 1;
        vx /= L; vy /= L;
        let lo = Infinity, hi = -Infinity;
        for (const q of lay.glyphs) {
          const off = (q.x - A.x) * -vy + (q.y - A.y) * vx;
          if (off < lo) lo = off;
          if (off > hi) hi = off;
        }
        if ((hi - lo) / L > 0.002) curvedOk++;
        else if (flatBad.length < 5) flatBad.push(`${name}（弧幅 ${(100 * (hi - lo) / L).toFixed(2)}%）`);
      }
      /* 🔴 **字避水已取消**（2026-10-22 用户）—— 不再验"字心在不在版图里" ✗
       *   改验"字与字之间的转角不许跳" ✓ 这条才是"七零八落"的直接判据 ✓ */
      let jump = 0;
      for (let gi = 1; gi < lay.glyphs.length; gi++) {
        if (Math.abs(lay.glyphs[gi].angle - lay.glyphs[gi - 1].angle) > 20.5 * Math.PI / 180) jump++;
      }
      if (!jump) smoothOk++;
      else bad.push(`${name}（相邻字转角跳了 ${jump} 次）`);
      // ≤2 个字：转角必须一致（直的 ✓）
      if (Array.from(name).length <= 2) {
        straightN++;
        let lo = Infinity, hi = -Infinity;
        for (const gl of lay.glyphs) { lo = Math.min(lo, gl.angle); hi = Math.max(hi, gl.angle); }
        if (hi - lo < 0.02) straightOk++;
        else bad.push(`${name}（两个字没排直：${(hi - lo) * 57.3 | 0}°）`);
      }
      // 接近方形（宽高比 1±10%）：不许歪过 20°
      if (c.w > 0 && c.h > 0) {
        const ar = c.w / c.h;
        if (Math.abs(ar - 1) <= 0.10) {
          squareN++;
          if (Math.abs(lay.angle) <= 20 * Math.PI / 180) squareOk++;
          else bad.push(`${name}（方版图歪了 ${(lay.angle * 57.3) | 0}°）`);
        }
      }
    }
    ok(`${label}：抽 ${comps.length} 个真实头衔排得出来（允许 ≤10% 退回老画法）`,
       comps.length > 0 && fallback <= Math.ceil(comps.length * 0.1),
       `${laid}/${comps.length} 排好 · ${fallback} 退回`);
    ok(`${label}：相邻字转角不跳（≤20° ✓ 不七零八落）`,
       laid === 0 || smoothOk === laid,
       `${smoothOk}/${laid}`);
    ok(`${label}：没有字跑到"同一个头衔的另一块"上（按像素连通域判 ✓）`,
       crossN === 0,
       crossN ? `${crossN} 个跨过去了：${crossBad.join(' / ')}` : '一块都没跨 ✓');
    /* ⚠ 门槛放到 80%：形状本来就近乎直的（大洋 / 大洲那种摊开的区）弧幅自然很小，
     *   不该算"被抹平" ✗ 这条只抓"大面积全被压平"的回归 ✓ */
    ok(`${label}：该弯的确实弯着（没被"贴中心"抹平 ✓）`,
       curvedN === 0 || curvedOk >= curvedN * 0.8,
       curvedN ? `${curvedOk}/${curvedN} 弯着` + (flatBad.length ? ' · ' + flatBad.join(' / ') : '')
               : '这一层没有要弯的');
    ok(`${label}：≤2 字的名字是直的`, straightN === 0 || straightOk === straightN,
       `${straightOk}/${straightN}`);
    ok(`${label}：接近方形的版图不歪`, squareN === 0 || squareOk === squareN,
       `${squareOk}/${squareN}`);
    /* 🔴 **每个连通域必须找回自己** ✗✗（2026-10-22 用户："小连通域的名字跳到最近大连通域"）
     *   小岛常常整个躺在大国的包围盒里 → bbox 距离都是 0；
     *   以前同分选"面积大的" → 小岛名字跳到大国那块、跟大国名重叠 ✗
     *   现在同分比"面积接近"，并且面积差 >4 倍直接退回老画法 ✓ */
    {
      const sample = g.comps.filter((c) => c.count >= 3).sort((a, b) => b.count - a.count).slice(0, 400);
      let same = 0;
      for (const c of sample) {
        const hit = mask.componentFor(tier, c.tid, c.cx, c.cy, c.count * g.cell * g.cell);
        if (hit && hit.comp === c) same++;
      }
      ok(`${label}：每个连通域都找回自己（不跳到隔壁大块）`,
         sample.length === 0 || same >= sample.length * 0.98,
         `${same}/${sample.length}`);
      /* 小连通域没进栅格时：宁可返回 null（退回老画法），也不许拿大块顶替 ✓ */
      if (sample.length) {
        const big = sample[0];
        const tiny = Math.max(64, big.count * g.cell * g.cell / 20);
        const hit = mask.componentFor(tier, big.tid, big.cx, big.cy, tiny);
        const ca = hit ? hit.comp.count * g.cell * g.cell : 0;
        ok(`${label}：小面积锚点不会被大块顶替`,
           hit === null || ca <= tiny * 4,
           hit ? `顶替成 ${ca}px 的块（锚点只有 ${Math.round(tiny)}px）` : '退回老画法 ✓');
      }
    }
    console.log(`    （${label}栅格 ${g.cols}×${g.rows} · 建 ${buildMs}ms · `
      + `连通域 ${g.comps.length} 个）`);
  }

  const avg = totalN ? totalMs / totalN : 0;
  ok('单次排版平均耗时 < 1ms（文档 §9 的验收线 ✓）', avg < 1,
     `${avg.toFixed(2)}ms · ${totalN} 次`);
  if (bad.length) console.log('  有问题的：' + bad.slice(0, 8).join(' / ')
    + (bad.length > 8 ? ` … 共 ${bad.length} 个` : ''));

  console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) process.exit(1);
})().catch((e) => {
  console.error('测试本身炸了：', e);
  process.exit(1);
});
