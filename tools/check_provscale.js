'use strict';
/**
 * 端到端复现「Adreno 白屏」那条路，确认现在能画出正确颜色 —— 2026-10-19。
 *
 *   node tools/check_provscale.js
 *
 * 做法：拿真包开图，然后把渲染器**强行**摆成那台机器的样子（数组纹理坏 ✓），
 * 再调一次 setData → 看它是不是走了「缩图」那条、而且 id 读回来对得上 ✓
 *
 * ⚠ 这里**不测画面像素** ✗（桩里的 WebGL 是假的、画不出东西 ✓）
 *   测的是**数据侧**：缩图后的每个格子在放大回去时，落在正确的省份上 ✓
 *   —— 白屏的根因就是"id 全 0"，所以这一条才是关键 ✓
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

const LOADER = path.join(H.ROOT, 'pdx-map-editor.html');
const tick = () => new Promise((res) => setImmediate(res));

function findPack() {
  for (const d of [path.join(H.ROOT, '_local', 'packs'), path.join(H.ROOT, 'packs')]) {
    for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      if (n.endsWith('.pdxmap')) return path.join(d, n);
    }
  }
  return null;
}

(async () => {
  if (!fs.existsSync(LOADER)) {
    console.log('✘ 缺 pdx-map-editor.html（先跑 py build_standalone.py）');
    process.exit(1);
  }
  const pack = findPack();
  if (!pack) { console.log('（没有测试包 —— 先跑 py build_packs.py）'); process.exit(0); }

  const { js, embedded } = H.readStandalone(LOADER);
  const env = H.makeEnv({ embedded, root: H.ROOT });
  const ex = H.instantiate(js, env);
  const b = ex.boot();
  const fi = env.get('pack-file');
  for (let i = 0; i < 4000 && typeof fi.onchange !== 'function'; i++) await tick();
  fi.files = [new Blob([fs.readFileSync(pack)])];
  await fi.onchange();
  for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) await tick();
  env.get('map-pick-list').children[0].onclick();
  await b;

  const r = ex.renderer;
  const meta = ex.state.meta;
  const W = meta.mapWidth, Hh = meta.mapHeight;
  ok('开图跑到就绪', /就绪/.test((env.get('boot-step') || {}).textContent || ''));
  ok('渲染器拿到了省份 id 图', !!(r && ex.state.provinceIds && ex.state.provinceIds.length > 1),
    ex.state.provinceIds ? ex.state.provinceIds.length + ' 格' : '没拿到');

  /* ---- 摆成那台 Adreno 的样子：贴图上限 4096、数组纹理实测坏的 ---- */
  r.maxTex = 4096;
  r.arrOk = 'bad';
  r.arrWhy = '第 0 层读回 0/0，应该是 44/1';
  const ids = ex.state.provinceIds;

  const caught = [];
  const origUpload = r.uploadTile.bind(r);
  r.uploadTile = (layer, data) => { caught.push(layer); return origUpload(layer, data); };

  await r.setData({
    provinceIds: ids,
    titlemap: ex.state.titlemap,
    colors: ex.state.titles.colors,
    tiles: null,
  });

  ok('数组纹理坏了 → 不再走分块（tileInfo 为空）', !r.tileInfo, JSON.stringify(r.tileInfo));
  ok('也不再往数组纹理里传块', caught.length === 0, `传了 ${caught.length} 块`);
  ok('改走了「id 图缩着传」', !!r._smallIds, r._smallIds ? `${r.provSmall.w}×${r.provSmall.h}` : '没走');
  ok('缩放倍数是整数、且缩完装得下', Number.isInteger(r.provScale) && r.provScale >= 2
    && Math.max(r.provSmall.w, r.provSmall.h) <= 4096,
    `缩 ${r.provScale} 倍 → ${r.provSmall.w}×${r.provSmall.h}（上限 4096）`);

  /* ---- 关键：缩图里的每个格子，放大回去时该落在哪个省 ---- */
  const sw = r.provSmall.w, sh = r.provSmall.h, sc = r.provScale;
  const half = (sc - 1) >> 1;
  let checked = 0, wrong = 0;
  for (let y = 0; y < sh; y += Math.max(1, Math.floor(sh / 40))) {
    for (let x = 0; x < sw; x += Math.max(1, Math.floor(sw / 40))) {
      const want = ids[Math.min(Hh - 1, y * sc + half) * W + Math.min(W - 1, x * sc + half)];
      const got = r._smallIds[y * sw + x];
      checked++;
      if (want !== got) wrong++;
    }
  }
  ok('缩图取样点逐格对得上（放大回去还是同一个省 ✓）', wrong === 0,
    `${checked} 个点错了 ${wrong} 个`);

  /* 全 0 就是白屏 —— 明确挡一条 ✗ */
  let nonzero = 0;
  for (let i = 0; i < r._smallIds.length; i++) if (r._smallIds[i]) nonzero++;
  ok('缩图**不是一片 0**（全 0 就是"整张图一个省"= 白屏 ✗）',
    nonzero > r._smallIds.length * 0.5,
    `${nonzero} / ${r._smallIds.length} 格有省号`);

  /* uProvScale 要真的传下去（不然着色器不除、整张图缩在左上角一格） */
  const uni = r.uni || {};
  ok('着色器拿到了 uProvScale 这个 uniform', 'uProvScale' in uni);
  ok('report 能看出走了缩图（_smallIds + provScale 都在）',
    !!r._smallIds && r.provScale === sc);

  console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  ✘ ' + f)); }
  process.exit(fails.length ? 1 : 0);
})();
