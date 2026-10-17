'use strict';
/**
 * 分块图「缓存 ≠ 显存」回归自检 —— 在 Node 里跑**真的 app.js**。
 *
 *   node tools/check_tiles.js
 *
 * 曾经出过的 bug（2026-10-13，v1.9）：
 *   帧循环按「JS 缓存里有这块」就跳过上传 ✗ —— 可 `provinceAt`（悬停取块）
 *   也会把块拉进缓存、**而不上传** ✓ 于是被悬停"抢跑"的那些块**永远上不了车**：
 *   那块地图一直渲成 0 号省份的灰（悬停却查得到）——EU5 原尺寸上就是一大块糊的 ✓
 *
 * 这条尺子盯的就是那个不变量：**缓存里有、显存里没有的块，下一帧必须被补传** ✓
 * 同时盯"别矫枉过正"：已经传过的块不许每帧白传 ✓
 *
 * 做法：boot 一张图 → 把渲染器切进"分块模式"（假的 tiles 清单）+ 一个
 * duck-type 的 tileMap（cache / tilesInView / get 三个方法就够帧循环用 ✓），
 * 再拿 spy 数 `uploadTile` 到底传了哪几层。
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
    console.log('✘ 缺 pdx-map-editor.html（先跑 python build_standalone.py）');
    process.exit(1);
  }
  const pack = findPack();
  if (!pack) {
    console.log('（没有 _local/packs/ 里的测试包 —— 先跑 python pack_map.py 打一个）');
    process.exit(0);
  }

  const { js, embedded } = H.readStandalone(LOADER);
  const env = H.makeEnv({ embedded, root: H.ROOT });
  const ex = H.instantiate(js, env);
  const b = ex.boot();
  const fi = env.get('pack-file');
  for (let i = 0; i < 4000 && typeof fi.onchange !== 'function'; i++) {
    await new Promise((r) => setImmediate(r));
  }
  fi.files = [new Blob([fs.readFileSync(pack)])];
  await fi.onchange();
  for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const cards = env.get('map-pick-list').children;
  if (!cards.length) { console.log('✘ 测试包没导进来'); process.exit(1); }
  cards[0].onclick();
  await b;
  ok('boot 跑到就绪', /就绪/.test((env.get('boot-step') || {}).textContent || ''));

  // ---- 把渲染器切进分块模式 + 挂一个 duck-type 的 tileMap ----
  const r = ex.renderer;
  const W = ex.state.meta.mapWidth, Hh = ex.state.meta.mapHeight;
  const TW = 48, TH = 24;
  const tilesInfo = { tileW: TW, tileH: TH, cols: Math.ceil(W / TW), rows: Math.ceil(Hh / TH) };
  await r.setData({
    provinceIds: new Uint16Array(W * Hh),   // 分块模式下只是占位 ✓
    titlemap: ex.state.titlemap,
    colors: ex.state.titles.colors,
    tiles: tilesInfo,
  });
  ok('渲染器在分块模式（数组纹理建起来了）', !!(r.provArrTex && r.tileInfo),
     'uploadedTiles=' + (r.uploadedTiles ? '有' : '没有 ✗'));

  const views = [[0, 0]];
  ex.state.tiles = tilesInfo;
  ex.state.tileMap = {
    cache: new Map(),
    tilesInView: () => views.slice(),
    get: () => Promise.resolve(null),
  };
  const tick = () => new Promise((res) => setImmediate(res));
  let calls = [];
  const origUpload = r.uploadTile.bind(r);
  r.uploadTile = (layer, data) => { calls.push(layer); return origUpload(layer, data); };
  const uploaded = (layer) => (r.uploadedTiles ? r.uploadedTiles.has(layer) : false);

  // ---- 场景 A（回归核心）：块只进了缓存、没进显存 → 下一帧必须补传 ----
  ex.state.tileMap.cache.set('0_0', new Uint16Array(TW * TH).fill(4));
  calls = [];
  ex.frame();
  await tick();
  ok('**缓存里有、显存没有的块，下一帧被补传**', calls.includes(0) && uploaded(0),
     `calls=${JSON.stringify(calls)} uploaded=${uploaded(0)}`);
  env.rafs.length = 0;                 // frame 尾巴会再排一帧 —— 清掉别乱跑 ✓

  // ---- 场景 B：已经传过的块不许每帧白传 ----
  calls = [];
  ex.frame();
  await tick();
  ok('传过的块不再重复传（别每帧白传）', !calls.includes(0), `calls=${JSON.stringify(calls)}`);
  env.rafs.length = 0;

  // ---- 场景 C：来了一块新的（缓存有、没传过）→ 只补新的这一块 ----
  views.push([0, 1]);
  ex.state.tileMap.cache.set('0_1', new Uint16Array(TW * TH).fill(5));
  calls = [];
  ex.frame();
  await tick();
  ok('新进的块补传、老块不重传', calls.includes(1) && !calls.includes(0),
     `calls=${JSON.stringify(calls)}`);
  env.rafs.length = 0;

  // ---- 场景 D：丢上下文又回来 → 记录清空、重新喂完再画时块要重新上车 ----
  await tablikeLossRestore(env, ex);
  ok('上下文恢复后块重新上车（记录清过也要重传）', uploaded(0) && uploaded(1),
     `uploaded0=${uploaded(0)} uploaded1=${uploaded(1)}`);

  async function tablikeLossRestore(env2, ex2) {
    const cv = env2.get('map');
    cv.dispatchEvent({ type: 'webglcontextlost', preventDefault() {} });
    cv.dispatchEvent({ type: 'webglcontextrestored' });
    for (let i = 0; i < 2000; i++) await tick();
    // 恢复后 app 会重新喂一遍（reuploadTiles 会把缓存里的块重传 ✓）；
    // 再跑一帧兜底（万一喂的时候这块还没进缓存 ✓）
    ex2.frame();
    for (let i = 0; i < 50; i++) await tick();
    env2.rafs.length = 0;
  }

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
