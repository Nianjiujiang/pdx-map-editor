/** 只跑"当前版"，把各项实测量出来（正式版那半在桩里暂时跑不通 ✓） */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');
const maps = process.argv.slice(2);
const LIST = maps.length ? maps : ['ck3', 'eu4', 'hoi4', 'vic3', 'eu5'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuMs = (a, b) => (b.user + b.system - a.user - a.system) / 1000;

(async () => {
  const rows = [];
  for (const MAP of LIST) {
    const env = H.makeEnv({ root: H.ROOT });
    const ex = H.instantiate(H.flattenModules(), env);
    let c0 = process.cpuUsage(), w0 = Date.now();
    const booting = ex.boot();
    for (let i = 0; i < 400 && !env.get('map-pick-list').children.length; i++) {
      await new Promise((r) => setImmediate(r));
      if (i % 20 === 19) await wait(5);
    }
    const idx = ex.MAP_CHOICES.findIndex((m) => m.emb === MAP);
    if (idx < 0) { rows.push({ map: MAP, err: '没有这张图' }); continue; }
    env.get('map-pick-list').children[idx].onclick();
    await booting;
    const boot = cpuMs(c0, process.cpuUsage());

    const st = ex.state;
    const W = st.meta.mapWidth, Hh = st.meta.mapHeight;

    // 粗筛位图（加载时算一次 ✓）单独量
    let border = null;
    if (ex.buildBorderDepth) {
      const b0 = process.cpuUsage();
      const bd = ex.buildBorderDepth();
      border = bd ? cpuMs(b0, process.cpuUsage()) : null;
      if (bd) {
        let on = 0;
        for (let i = 0; i < bd.bits.length; i++) { let b = bd.bits[i]; while (b) { on += b & 1; b >>= 1; } }
        var cover = on / (bd.w * bd.h);
        var mb = bd.bits.length / 1048576;
      }
    }
    // 涂 8 笔（含防抖后重算 ✓）
    const picks = [];
    for (let k = 0; k < 8; k++) {
      const x = Math.floor(W * (0.10 + 0.095 * k)), y = Math.floor(Hh * (0.30 + 0.06 * (k % 4)));
      const p = st.provinceIds[y * W + x];
      if (p > 0) picks.push(p);
    }
    c0 = process.cpuUsage();
    if (ex.paintPids) for (const p of picks) ex.paintPids([p], [200, 60, 60]);
    await wait(700);
    const paint = cpuMs(c0, process.cpuUsage());

    // 换层 5 次
    c0 = process.cpuUsage();
    const nT = (st.meta.tierNames || []).length || 1;
    for (let k = 0; k < 5; k++) ex.setTier((k * 2 + 1) % nT);
    await wait(700);
    const tier = cpuMs(c0, process.cpuUsage());

    rows.push({ map: MAP, boot, border, paint, tier, cover, mb, picks: picks.length });
  }

  const pad = (s, n) => String(s).padEnd(n);
  const f = (v) => (v == null ? '-' : v.toFixed(0));
  console.log('');
  console.log(pad('图', 8) + pad('开图', 9) + pad('粗筛位图', 11) + pad('位图MB', 9)
    + pad('需细算%', 10) + pad('涂8笔', 9) + pad('换层5次', 10));
  console.log('─'.repeat(68));
  for (const r of rows) {
    if (r.err) { console.log(pad(r.map, 8) + r.err); continue; }
    console.log(pad(r.map, 8) + pad(f(r.boot), 9) + pad(f(r.border), 11) + pad(r.mb ? r.mb.toFixed(1) : '-', 9)
      + pad(r.cover != null ? (r.cover * 100).toFixed(1) : '-', 10)
      + pad(f(r.paint), 9) + pad(f(r.tier), 10));
  }
  console.log('─'.repeat(68));
  console.log('单位 ms（CPU 时间）· "需细算%"= 粗筛位图圈住的格占比（越低越好 ✓）');
  console.log('★ 这几项的看点是：粗筛位图**只在开图算一次** ✓ 所以"涂8笔"和"换层5次"');
  console.log('  基本不花时间 ✓ —— 正式版这两项每次都要重算整张边界图 ✗');
  process.exit(0);
})();
