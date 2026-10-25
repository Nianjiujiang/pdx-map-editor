/**
 * **版本性能对比：v1.7 / v1.8 / v1.9（tag 快照）vs 当前工作区** ✓
 *
 * 做法（跟 perf_compare.js 同一套方法论，修了它的两个口径问题 ✓）：
 *   · 每个版本用 **tag 里的 web/ 源码**（`_local/perfcmp/<版本>/`，
 *     `git archive <tag> web` 抽的 ✓）+ **同一份数据**（各 data_ 目录已拷过去 ✓）
 *   · 同一串操作：开图 → 涂 8 笔 → 换层 5 次 → 撤销 8 次 → 应用当前视角画名字 30 遍
 *   · 每步量 **CPU 时间**（不是墙钟 ✗）—— 防抖那段等待里，
 *     慢的版本在烧 CPU、快的在空等，墙钟会把差别摊平 ✓
 *   · ⚠ **等待期必须泵帧** ✗✗ —— 桩的 rAF 只入队、从不自动触发 ✓，
 *     不泵的话"rAF 型"的活全被漏计、"setTimeout 型"的全被计入，
 *     谁用哪种机制谁吃亏 —— 等待分段并每段调 `ex.frame()`，把账记全 ✓
 *   · 老版本缺的探针 / 缺的模块：跟 perf_compare 一样兜住（预声明 / 过滤清单 ✓）
 *   · 涂色按版本自适应：新的 `paintPids` / 老的 `setBrush + paintAt(pid, tid)` ✓
 *   · 哪个版本没有哪张图 → 那一格如实报"没有这张图" ✓
 *
 * 用法：
 *   node tools/perf_versions.js                # 全部地图
 *   MAP=ck3,eu4 node tools/perf_versions.js    # 指定地图
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const ROOT = H.ROOT;
const MAPS = (process.env.MAP || 'vanilla,eu4,hoi4,vic3,eu5').split(',').map((s) => s.trim());
const SNAP = (v) => path.join(ROOT, '_local', 'perfcmp', v);
const VERSIONS = [
  ['v1.7', SNAP('v1.7')],
  ['v1.8', SNAP('v1.8')],
  ['v1.9', SNAP('v1.9')],
  ['当前', ROOT],
];
const SETTLE = 800;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuMs = (a, b) => (b.user + b.system - a.user - a.system) / 1000;

/* 老版本缺探针 → 预声明成空（跟 perf_compare 同一个坑 ✓）*/
const PROBES = [...new Set([...fs.readFileSync(path.join(__dirname, 'lib', 'browser_stub.js'), 'utf8')
  .matchAll(/_p\('([A-Za-z_$][\w$]*)'/g)].map((m) => m[1]))];

/** 等 SETTLE 毫秒，**分 8 段、每段泵一帧** —— 把 rAF 型的活也记进账 ✓ */
async function settle(ex, ms = SETTLE) {
  for (let i = 0; i < 8; i++) {
    await wait(ms / 8);
    try { if (ex.frame) ex.frame(); } catch (e) { /* 老版本 frame 缺就缺 ✓ */ }
  }
}

/** 等 CPU 冷下来 ✓ —— 开局「地名预热」是 setTimeout 切片（EU5 要预排 2.3 万个
 *  地名、约 2.5s CPU）✗ 不等它跑完就量下一步，预热的账全记到涂色头上 ✗✗
 *  （2026-10-24 实测踩过：EU5"涂 8 笔 1172ms"里大半是没等完的预热 ✓）
 *  连续两轮 250+150ms 的 CPU 都 < 20ms 就算冷了；等不到就按上限放弃 ✓ */
async function waitIdle(ex, capMs = 20000) {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < capMs) {
    await wait(250);
    try { if (ex.frame) ex.frame(); } catch (e) { /* ✓ */ }
    const c = process.cpuUsage();
    await wait(150);
    if (cpuMs(c, process.cpuUsage()) < 20) { if (++quiet >= 2) return Date.now() - t0; }
    else quiet = 0;
  }
  return Date.now() - t0;
}

async function runOne(root, mapKey) {
  const env = H.makeEnv({ root });
  let src = H.flattenModules(H.moduleListFor(root), root);
  const missing = PROBES.filter((n) => !new RegExp('\\b' + n + '\\b').test(src));
  if (missing.length) {
    src = 'var ' + missing.map((n) => n + ' = undefined').join(', ') + ';\n' + src;
  }
  const ex = H.instantiate(src, env);

  // ── ① 开图 ──
  let c0 = process.cpuUsage(), w0 = Date.now();
  const booting = ex.boot();
  for (let i = 0; i < 400 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
    try { if (ex.frame) ex.frame(); } catch (e) { /* ✓ */ }
    if (i % 20 === 19) await wait(10);
  }
  const idx = ex.MAP_CHOICES.findIndex((m) => m.emb === mapKey);
  if (idx < 0) return { err: '这个版本还没有这张图' };
  /* 选图卡**按卡面文字找**，别按 children 下标 ✗ —— 老版本的列表里
   * 卡片前面还有别的元素，而且同一张图的文案在版本间变过
   * （VIC3：v1.7 叫「V3 原版」、后来叫「VIC3 原版」✓）
   * → 匹配**尺寸 note**（'8192 × 3616' 这种 ✓ 版本间从没变过 ✓）✓
   *   HOI4 两张卡 note 相同 → find 取第一个 = 排在前面的「原版」✓ */
  const ch = ex.MAP_CHOICES[idx];
  const noteCore = String(ch.note || '').split('（')[0];
  const kids = env.get('map-pick-list').children;
  const flat = (c) => { try { const f = c.flat(); return Array.isArray(f) ? f.join(' ') : String(f); } catch (e) { return ''; } };
  let card = kids.find((c) => flat(c).includes(noteCore))
    || kids.find((c) => flat(c).includes(ch.label));
  if (!card) {
    /* 老版本（v1.7 / v1.8）用 innerHTML 建卡、桩不解析 → flat 全是空 ✗
     * → 照它 `availableMaps` 的口径（HEAD 到 meta.json 才列 ✓）重算顺序、按位置点 ✓
     *   （数量对不上就不猜 —— 宁可不测也别点错卡 ✓） */
    const avail = ex.MAP_CHOICES.filter((m) => {
      try { return fs.existsSync(path.join(root, String(m.dir || ''), 'meta.json')); }
      catch (e) { return false; }
    });
    const pos = avail.indexOf(ch);
    if (pos >= 0 && kids.length === avail.length) card = kids[pos];
  }
  if (!card) {
    return { err: '选图卡找不到（' + (ch.label || noteCore) + '）· 列表 ' + kids.length
      + ' 张：' + kids.slice(0, 3).map((c) => flat(c).slice(0, 60)).join(' | ') };
  }
  card.onclick();
  await booting;
  const idleMs = await waitIdle(ex);            // 预热跑完再开量 ✓（账记在开图上 ✓）
  const boot = { cpu: cpuMs(c0, process.cpuUsage()), wall: Date.now() - w0, idleMs };

  const st = ex.state;
  const W = st.meta.mapWidth, Hh = st.meta.mapHeight;

  // ── ② 涂 8 笔（新 paintPids / 老 setBrush+paintAt ✓）──
  const picks = [];
  for (let k = 0; k < 8; k++) {
    const x = Math.floor(W * (0.10 + 0.095 * k));
    const y = Math.floor(Hh * (0.30 + 0.06 * (k % 4)));
    const p = st.provinceIds[y * W + x];
    if (p > 0) picks.push(p);
  }
  c0 = process.cpuUsage();
  for (const p of picks) {
    if (ex.paintPids) ex.paintPids([p], [200, 60, 60]);
    else {
      try {
        ex.setBrush([200, 60, 60]);
        const tid = st.titleAt ? st.titleAt(p, st.tier) : p;
        if (tid != null) ex.paintAt(p, tid);
      } catch (e) { /* 这一笔涂不上就算了 ✓ */ }
    }
  }
  await settle(ex);
  const paint = cpuMs(c0, process.cpuUsage());

  // ── ③ 换层 5 次 ──
  c0 = process.cpuUsage();
  const nT = (st.meta.tierNames || []).length || 1;
  for (let k = 0; k < 5; k++) ex.setTier((k * 2 + 1) % nT);
  await settle(ex);
  const tier = cpuMs(c0, process.cpuUsage());

  // ── ④ 撤销 8 次 ──
  c0 = process.cpuUsage();
  for (let k = 0; k < 8; k++) { try { ex.undo(); } catch (e) { /* ✓ */ } }
  await settle(ex);
  const undoM = cpuMs(c0, process.cpuUsage());

  // ── ⑤ 画名字 ×30（应用自己的当前视角 ✓ 热两遍再量）──
  try { st.showLabelsTitle = true; } catch (e) { /* ✓ */ }
  const vr = ex.viewRect ? ex.viewRect() : { x: 0, y: 0, w: W, h: Hh };
  for (let i = 0; i < 2; i++) { try { ex.drawLabels(vr); } catch (e) { /* ✓ */ } }
  /* ⚠ drawn 每次 drawLabels 开头都会清零 ✓ —— 取**热身后那一次**的值
   *   （= 一遍画了多少个名字 ✓），别拿前后差算 ✗ 那恒等于 0 ✓ */
  const drawnWarm = (ex.labels && ex.labels.drawn) | 0;
  const stat0 = { fill: H.stats.fill, stroke: H.stats.stroke, image: H.stats.image };
  c0 = process.cpuUsage();
  for (let i = 0; i < 30; i++) { try { ex.drawLabels(vr); } catch (e) { /* ✓ */ } }
  const labels = cpuMs(c0, process.cpuUsage());
  const statDelta = { fill: H.stats.fill - stat0.fill, stroke: H.stats.stroke - stat0.stroke,
                      image: H.stats.image - stat0.image };

  return { boot, paint, tier, undo: undoM, labels,
           drawn: drawnWarm, stat: statDelta, picks: picks.length };
}

(async () => {
  for (const mapKey of MAPS) {
    const rows = [];
    for (const [tag, root] of VERSIONS) {
      try {
        rows.push([tag, await runOne(root, mapKey)]);
      } catch (e) {
        rows.push([tag, { err: e.message }]);
      }
    }
    const pad = (s, n) => String(s).padEnd(n);

    console.log('\n═══ 地图 ' + mapKey + ' ═══（单位 ms · CPU 时间，越低越好）');
    const items = [
      ['开图（含边界图构建）', (r) => r.boot && r.boot.cpu],
      ['涂 8 笔（含重算）', (r) => r.paint],
      ['换层 5 次', (r) => r.tier],
      ['撤销 8 次', (r) => r.undo],
      ['画名字 ×30（当前视角）', (r) => r.labels],
    ];
    console.log(pad('项目', 24) + VERSIONS.map(([t]) => pad(t, 10)).join('') + '提升(当前 vs v1.7)');
    console.log('─'.repeat(76));
    for (const [name, get] of items) {
      const cells = rows.map(([, r]) => get(r));
      const lift = (cells[0] != null && cells[3] != null && cells[3] > 0)
        ? (cells[0] > cells[3] ? '快 ' + (cells[0] / cells[3]).toFixed(1) + ' 倍'
                               : '慢 ' + (cells[3] / cells[0]).toFixed(1) + ' 倍') : '-';
      console.log(pad(name, 24) + cells.map((v) => pad(v == null ? '-' : v.toFixed(0), 10)).join('') + lift);
    }
    for (const [tag, r] of rows) {
      if (r.err) { console.log('  ' + tag + '：' + r.err); continue; }
      console.log('  ' + tag + '：开图墙钟 ' + r.boot.wall + 'ms（含等预热冷却 '
        + (r.boot.idleMs | 0) + 'ms）· 30 遍画了 ' + r.drawn
        + ' 个名字（fill ' + r.stat.fill + ' / image ' + r.stat.image + '）· 涂到 ' + r.picks + ' 块');
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
