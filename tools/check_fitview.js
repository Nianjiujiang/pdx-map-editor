'use strict';
/**
 * 「视口瞬时塌成 0×0」回归自检 —— 在 Node 里跑**真的 app.js**。
 *
 *   node tools/check_fitview.js
 *
 * 曾经出过的 bug（2026-10-13 查实）：
 *   切后台 / 嵌入容器收放时视口会**塌一帧 0×0**（实测"首次导入地图包后进图"
 *   那几秒约一半概率撞上）；`fitView()` 恰好在那一下量尺寸 → "适配缩放"算出 0
 *   写进相机 → **整张图全黑、缩放 0%**，刷新后正常、只有点「⤢」能救 ✗。
 *
 * 修法两条（都在 app.js 的相机段）：
 *   ① `fitView()` 量不到有效尺寸就**先不动相机**，下一帧再试（有次数上限兜底）；
 *   ② `minScale()` 永不返回 0/NaN（兜底用当前缩放，再不行 1）—— zoomBy / flyTo
 *      那些 clamp 下限也跟着安全 ✓。
 *
 * 这条尺子盯的就是这两条：0×0 时不许把相机写坏、视口回来要自动适配到位。
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

  const stage = env.get('stage');
  const zoomEl = env.get('status-zoom');
  const zoom = () => (zoomEl || {}).textContent || '';
  const flushRafs = () => {
    let n = 0;
    while (env.rafs.length && n++ < 300) {
      const fn = env.rafs.shift();
      try { fn(n); } catch (e) { /* frame 之类跑不动无所谓 */ }
    }
  };

  // ---- ① 正常尺寸：适配值 = minScale ✓ ----
  env.rafs.length = 0;
  ex.fitView();
  const fit1 = zoom();
  ok('正常尺寸：fitView 落在可用缩放', /^\d+%$/.test(fit1) && parseInt(fit1, 10) > 0, fit1);
  ok('正常尺寸：minScale 有效', ex.minScale() > 0, String(ex.minScale()));

  // ---- ② 视口塌成 0×0：不许把相机写坏 ----
  stage.clientWidth = 0;
  stage.clientHeight = 0;
  env.rafs.length = 0;
  const before = zoom();
  ex.fitView();
  ex.fitView();                      // 连撞两下（真实"塌着的那几帧"就是这样）
  ok('**0×0 时 fitView 不动相机**（没有 0% 黑屏）', zoom() === before && zoom() !== '0%', zoom());
  ok('排了重试帧（视口回来会自动再适配 ✓）', env.rafs.length > 0, String(env.rafs.length));
  ok('**0×0 时 minScale 也返回有效值**（zoomBy 那些下限跟着安全 ✓）',
     Number.isFinite(ex.minScale()) && ex.minScale() > 0, String(ex.minScale()));

  // ---- ③ 视口恢复：重试落地成正确适配 ----
  stage.clientWidth = 1024;
  stage.clientHeight = 700;
  flushRafs();
  const want = Math.round(ex.minScale() * 100) + '%';
  ok('视口恢复后：重试把它适配到位', zoom() === want, `${zoom()} vs ${want}`);

  // ---- ④ 一直量不到（页面藏着）：撞过重试上限也不许写 0%、不许空转 ----
  stage.clientWidth = 0;
  stage.clientHeight = 0;
  const held = zoom();
  for (let i = 0; i < 200; i++) { ex.fitView(); flushRafs(); }
  ok('一直 0×0：相机保持有效、不再空转排队',
     zoom() === held && zoom() !== '0%' && parseInt(zoom(), 10) > 0,
     `${zoom()} / rafs=${env.rafs.length}`);

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
