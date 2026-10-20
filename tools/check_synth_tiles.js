'use strict';
/**
 * 合成切块（手机专属路径）回归自检 —— 在 Node 里跑**真的 app.js**。
 *
 *   node tools/check_synth_tiles.js
 *
 * 盯的是 2026-10-17 用户白屏那件事：CK3 图 9216×4608，在贴图上限 4096 的手机上
 * 被就地切成 5×3 块、`uploadAllTiles` 一次全传 = **120MB 显存**，GPU 上下文被顶丢，
 * 地图变白（只余地名）。改完之后应该是：
 *
 *   ① 块尺寸按"总字节最小"挑（这张图 2304 → 4×2 = 8 块 ≈ 85MB，跟整图一样大）；
 *   ② 开图**只传视野中央那一块**，不是全传；
 *   ③ 帧循环按视野补，**每帧最多两块**、传过的不重传、有 96MB 软上限；
 *   ④ 切出来的每一块内容跟原数组对得上（不能错位一列）。
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
  if (!pack) {
    console.log('（没有 packs/ 里的测试包 —— 先跑 py build_packs.py）');
    process.exit(0);
  }

  const { js, embedded } = H.readStandalone(LOADER);
  const env = H.makeEnv({ embedded, root: H.ROOT });
  const ex = H.instantiate(js, env);
  const b = ex.boot();
  const fi = env.get('pack-file');
  for (let i = 0; i < 4000 && typeof fi.onchange !== 'function'; i++) await tick();
  fi.files = [new Blob([fs.readFileSync(pack)])];
  await fi.onchange();
  for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) await tick();
  const cards = env.get('map-pick-list').children;
  if (!cards.length) { console.log('✘ 测试包没导进来'); process.exit(1); }
  cards[0].onclick();
  await b;
  ok('boot 跑到就绪', /就绪/.test((env.get('boot-step') || {}).textContent || ''));

  const r = ex.renderer;
  const W = ex.state.meta.mapWidth, Hh = ex.state.meta.mapHeight;

  // ---- 假装这台机器贴图上限只有 4096（手机就是这样，图 9216 宽）----
  r.maxTex = 4096;

  // 每个像素给一个可辨认的值：能一眼看出切歪没切歪
  const ids = new Uint16Array(W * Hh);
  for (let i = 0; i < ids.length; i++) ids[i] = i % 65535;

  const caught = [];
  const origUpload = r.uploadTile.bind(r);
  r.uploadTile = (layer, data) => { caught.push({ layer, data }); return origUpload(layer, data); };

  await r.setData({
    provinceIds: ids,
    titlemap: ex.state.titlemap,
    colors: ex.state.titles.colors,
    tiles: null,
  });

  /* ---- ① 块尺寸：总字节最小 ---- */
  const ti = r.tileInfo;
  ok('进的是合成切块模式', !!(ti && ti.synthetic), JSON.stringify(ti));
  if (!ti || !ti.synthetic) {
    /* ⚠ **图本来就装得下 4096** → 合成切块压根不会启用 ✓ 这是**跳过**，不是失败 ✗
     *   （普通夹具 96×48 就是这样 ✓ 以前一句"后面不测了" + 状态码 1 ✗
     *     → 没大图的人每次跑都是红的，还看不出只是缺夹具 ✓
     *      跟 check_hover_card 那次同一类问题 ✓）
     *   ⚠ 反过来：图**比 4096 大**却没切块 → 那是真坏了 ✓ 照旧红 ✓ */
    if (Math.max(W, Hh) > 4096) {
      console.log('  ✘ 图比 4096 大，却没进合成切块 ✗');
      process.exit(1);
    }
    console.log(`  ·（跳过：这张图 ${W}×${Hh} 本来就装得进 4096，走不到合成切块 ✓`
      + ' —— 要宽过 4096 的图才测得到 ✓）');
    console.log('\n跳过：0 条失败');
    process.exit(0);
  }
  const bytes = ti.cols * ti.rows * ti.tileW * ti.tileH * 2;
  const rawBytes = W * Hh * 2;
  ok('总显存压到接近整图（≤ 整图 × 1.15）', bytes <= rawBytes * 1.15,
     `${(bytes / 1048576).toFixed(0)}MB vs 整图 ${(rawBytes / 1048576).toFixed(0)}MB`);
  ok('层数不超过 2048', ti.cols * ti.rows <= 2048, `${ti.cols}×${ti.rows}`);

  /* ---- ② 开图只传一块 ---- */
  ok('开图只传了视野中央那一块（不是全传）', r.uploadedTiles.size === 1,
     `已传 ${r.uploadedTiles.size} 块 / 共 ${ti.cols * ti.rows} 块`);

  /* ---- ③ 帧循环按视野补 ---- */
  ex.state.tileMap = null;                       // 合成切块没有 tileMap ✓
  r.setView(0, 0, W, Hh);                        // 视野 = 整张图
  const perFrame = [];
  for (let k = 0; k < 8; k++) {
    const before = r.uploadedTiles.size;
    caught.length = 0;
    ex.frame();
    await tick();
    perFrame.push(r.uploadedTiles.size - before);
    env.rafs.length = 0;                         // frame 尾巴会再排一帧
  }
  ok('每帧最多补两块', perFrame.every((n) => n <= 2), JSON.stringify(perFrame));
  ok('几帧之后视野里的块都补上了', r.uploadedTiles.size === ti.cols * ti.rows,
     `${r.uploadedTiles.size} / ${ti.cols * ti.rows}`);

  const before = caught.length;
  caught.length = 0;
  ex.frame();
  await tick();
  env.rafs.length = 0;
  ok('传过的块不再重复传', caught.length === 0, `多传了 ${caught.length} 块（本轮之前 ${before}）`);

  /* ---- ④ 切块内容对得上 ---- */
  const layerWanted = 0;                          // (r=0, c=0)
  const hit = caught.length ? null : null;
  let sample = null;
  for (const c of r.__caughtForTest || []) { /* 占位：下面是直接重切一遍比 */ }
  // 用同一条路径重新切一块（不计入 uploadedTiles 的副作用：先删掉记录）
  r.uploadedTiles.delete(layerWanted);
  caught.length = 0;
  r.uploadSyntheticTile(0, 0);
  sample = caught.find((c) => c.layer === layerWanted);
  ok('(0,0) 块切出来了', !!sample, sample ? 'ok' : '没拿到');
  if (sample) {
    const { tileW, tileH } = ti;
    const at = (x, y) => sample.data[y * tileW + x];
    const expect = (x, y) => ids[(y * W + x)] % 65535;
    const pts = [[0, 0], [tileW - 1, 0], [0, tileH - 1], [tileW - 1, tileH - 1], [123, 456]];
    let bad = 0;
    for (const [x, y] of pts) if (at(x, y) !== expect(x, y)) bad++;
    ok('块内像素跟原数组对得上（没错位）', bad === 0, `5 个采样点错了 ${bad} 个`);
  }

  console.log('\n' + '='.repeat(58));
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    fails.forEach((f) => console.log('  ✘ ' + f));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('测试自己炸了：', e); process.exit(1); });
