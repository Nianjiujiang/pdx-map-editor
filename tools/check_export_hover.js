'use strict';
/**
 * 导出时的悬停高亮回归 —— 在 Node 里跑真的 app.js。
 *
 *   node tools/check_export_hover.js
 *
 * 2026-10-17 用户报的：**导出的图里莫名亮一块**。
 * 高亮是画在着色器里的（mix 到白 0.30），不是叠框 —— 鼠标停着就一起被截进 PNG 了。
 * 修法是在导出前后 mute / restore。这里盯的就是这两个动作真的把四个悬停量清干净、
 * 又能原样还回去。
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name);
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

const LOADER = path.join(H.ROOT, 'pdx-map-editor.html');
const tick = () => new Promise((r) => setImmediate(r));

function findPack() {
  for (const d of [path.join(H.ROOT, '_local', 'packs'), path.join(H.ROOT, 'packs')]) {
    for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      if (n.endsWith('.pdxmap')) return path.join(d, n);
    }
  }
  return null;
}

(async () => {
  if (!fs.existsSync(LOADER)) { console.log('✘ 缺 pdx-map-editor.html'); process.exit(1); }
  const pack = findPack();
  if (!pack) { console.log('（没有测试包）'); process.exit(0); }

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

  const r = ex.renderer;
  ok('渲染器在', !!r);
  ok('有 muteHoverForExport', typeof r.muteHoverForExport === 'function');
  if (!r || typeof r.muteHoverForExport !== 'function') process.exit(1);

  // 造一个"正悬停在某个头衔上"的状态
  r.hoverTid = 1234;
  r.hoverPid = 567;
  r.hoverGroupId = 9;
  r.hoverPaintOn = true;
  r.hoverPaint = [0.1, 0.2, 0.3];
  r.hoverLabel = 42;

  const restore = r.muteHoverForExport();
  ok('哑掉后 hoverTid = noTitle', r.hoverTid === r.noTitle, String(r.hoverTid));
  ok('哑掉后 hoverPid = 0', r.hoverPid === 0);
  ok('哑掉后 hoverGroupId = 0', r.hoverGroupId === 0);
  ok('哑掉后 hoverPaintOn = false', r.hoverPaintOn === false);
  ok('哑掉后 hoverLabel = 0', r.hoverLabel === 0);
  ok('哑掉后标了脏（下一帧会重画）', r.dirty === true);

  restore();
  ok('恢复后 hoverTid', r.hoverTid === 1234);
  ok('恢复后 hoverPid', r.hoverPid === 567);
  ok('恢复后 hoverGroupId', r.hoverGroupId === 9);
  ok('恢复后 hoverPaintOn', r.hoverPaintOn === true);
  ok('恢复后 hoverPaint 原样', Array.isArray(r.hoverPaint) && Math.abs(r.hoverPaint[0] - 0.1) < 1e-6);
  ok('恢复后 hoverLabel', r.hoverLabel === 42);

  console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('测试自己炸了：', e); process.exit(1); });
