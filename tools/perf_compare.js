/**
 * **性能对比：正式版（v1.7）vs 当前测试版** ✓
 *
 * 目的（用户要的）：把这几轮的性能改动量出来 —— 哪些地方真的快了、快多少。
 *
 * 做法：
 *   · 两边**用同一个桩、同一份数据**跑（正式版源码从 git 的 v1.7 提交里抽出来 ✓）
 *   · 跑同一串操作：开图 → 涂 8 笔 → 换层 5 次 → 撤销 8 次
 *   · 每一步都量 **CPU 时间**（不是墙钟 ✗）——
 *     因为"涂色后防抖重算"那段时间里，慢的那版在**烧 CPU**、快的那版在**空等** ✓
 *     用 CPU 时间才量得出真正的差别 ✓（墙钟会被那个固定延迟摊平 ✓）
 *
 * 用法：
 *   node tools/perf_compare.js            # 默认用 hoi4
 *   MAP=eu4 node tools/perf_compare.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const ROOT = H.ROOT;
const REL = path.join(ROOT, '_local', 'rel');          // 正式版源码（从 git v1.7 抽的 ✓）
const MAP = process.env.MAP || 'hoi4';
const SETTLE = 800;                                     // 让防抖跑完的等待（ms ✓）

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuMs = (a, b) => (b.user + b.system - a.user - a.system) / 1000;

async function runOne(tag, root) {
  const env = H.makeEnv({ root });
  let src = H.flattenModules(undefined, root);
  /* ⚠ **老版本缺探针** ✗ —— 桩在源码末尾追加了一串 `_p('x', x);` ✓
   *   而 v1.7 里没有这些函数（provInfoAt / saveMapPrefs …）→ 直接 ReferenceError ✗
   *   所以：把**名字清单直接从桩里抽出来**（不手抄 ✗ 手抄必漏 ✓）
   *   然后只把"它确实没有的"预先声明成空的 ✓
   *     为什么不能一把全声明 ✗ —— 桩里那些名字有的是 function / const ✓
   *     对 const 再来一个 var 是 **SyntaxError** ✓（连跑都跑不起来 ✓）*/
  const PROBES = [...new Set([...fs.readFileSync(path.join(__dirname, 'lib', 'browser_stub.js'), 'utf8')
    .matchAll(/_p\('([A-Za-z_$][\w$]*)'/g)].map((m) => m[1]))];
  const missing = PROBES.filter((n) => !new RegExp('\\b' + n + '\\b').test(src));
  if (missing.length) {
    src = 'var ' + missing.map((n) => n + ' = undefined').join(', ') + ';\n' + src;
  }
  const ex = H.instantiate(src, env);

  // ── ① 开图 ──
  let c0 = process.cpuUsage(), w0 = Date.now();
  const booting = ex.boot();
  /* ⚠ 等地图列表出来时**也要给定时器机会** ✗ ——
   *   光推 setImmediate 会饿着 setTimeout（老版本是在定时器里建这个列表的 ✓）
   *   于是老版本永远等不到列表 → "Cannot read properties of undefined (reading 'onclick')" ✓ */
  for (let i = 0; i < 400 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
    try { if (ex.frame) ex.frame(); } catch (e) { /* ✓ */ }      // 有的版本在渲染循环里建列表 ✓
    if (i % 20 === 19) await wait(10);
  }
  const idx = ex.MAP_CHOICES.findIndex((m) => m.emb === MAP);
  if (idx < 0) throw new Error('找不到地图 ' + MAP);
  env.get('map-pick-list').children[idx].onclick();
  await booting;
  const boot = { cpu: cpuMs(c0, process.cpuUsage()), wall: Date.now() - w0 };

  const st = ex.state;
  const W = st.meta.mapWidth, Hh = st.meta.mapHeight;

  // ── ② 涂 8 笔（挑图上分散的位置，尽量每笔都落在新区块 ✓）──
  const picks = [];
  for (let k = 0; k < 8; k++) {
    const x = Math.floor(W * (0.10 + 0.095 * k));
    const y = Math.floor(Hh * (0.30 + 0.06 * (k % 4)));
    const p = st.provinceIds[y * W + x];
    if (p > 0) picks.push(p);
  }
  c0 = process.cpuUsage();
  for (const p of picks) ex.paintPids([p], [200, 60, 60]);
  await wait(SETTLE);
  const paint = cpuMs(c0, process.cpuUsage());

  // ── ③ 换层 5 次 ──
  c0 = process.cpuUsage();
  const nT = (st.meta.tierNames || []).length || 1;
  for (let k = 0; k < 5; k++) ex.setTier((k * 2 + 1) % nT);
  await wait(SETTLE);
  const tier = cpuMs(c0, process.cpuUsage());

  // ── ④ 撤销 8 次（撤销会把涂色回退 → 又触发一轮重算 ✓）──
  c0 = process.cpuUsage();
  for (let k = 0; k < 8; k++) { try { ex.undo(); } catch (e) { /* ✓ */ } }
  await wait(SETTLE);
  const undoM = cpuMs(c0, process.cpuUsage());

  return { tag, boot, paint, tier, undo: undoM, picks: picks.length };
}

(async () => {
  const rows = [];
  for (const [tag, root] of [['正式版 v1.7', REL], ['当前测试版', ROOT]]) {
    try {
      rows.push(await runOne(tag, root));
    } catch (e) {
      rows.push({ tag, err: e.message });
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (v) => (v == null ? '-' : v.toFixed(0));
  console.log('');
  console.log('地图：' + MAP + ' · 每项单位 ms（CPU 时间，越低越好）');
  console.log('─'.repeat(66));
  console.log(pad('项目', 22) + pad('正式版 v1.7', 16) + pad('当前测试版', 16) + '提升');
  console.log('─'.repeat(66));
  const items = [['开图（含边界图构建）', 'boot'], ['涂 8 笔（含重算）', 'paint'],
                 ['换层 5 次', 'tier'], ['撤销 8 次', 'undo']];
  const ok = rows.filter((r) => !r.err);
  if (ok.length < 1) { console.log('两边都没跑起来 ✗'); process.exit(1); }
  for (const [name, key] of items) {
    const a = rows[0].err ? null : rows[0][key].cpu;
    const b = rows[1].err ? null : rows[1][key].cpu;
    let lift = '-';
    if (a != null && b != null && b > 0) {
      lift = a > b ? ('快 ' + (a / b).toFixed(1) + ' 倍') : ('慢 ' + (b / a).toFixed(1) + ' 倍');
    }
    console.log(pad(name, 22) + pad(num(a), 16) + pad(num(b), 16) + lift);
  }
  console.log('─'.repeat(66));
  for (const r of rows) {
    if (r.err) console.log(r.tag + ' 跑不起来：' + r.err);
    else console.log(r.tag + '：开图墙钟 ' + r.boot.wall + 'ms · 涂到的地块 ' + r.picks + ' 个');
  }
  console.log('');
  console.log('注：用 CPU 时间而不是墙钟 ✗ —— "涂色后防抖重算"那段等待里，');
  console.log('    慢的那版在烧 CPU、快的那版在空等 ✓ 墙钟会被固定延迟摊平 ✓');
  process.exit(0);
})();
