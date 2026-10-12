'use strict';
/**
 * 「改动 N」计数器回归自检 —— 在 Node 里跑**真的 app.js**（轻量版加载器 + 测试包）。
 *
 *   node tools/check_counter.js
 *
 * 盯的是一条曾经出过的 bug（2026-10-12，v1.9）：
 *   **计数器慢一拍** —— paintPids() 里调 updateStatus() 的时候 state.changed
 *   还是重算之前的旧账本（recomputePainted 在它之后才跑），于是
 *   "涂一笔显示 0、擦掉显示 1"，永远差一步。
 *
 * 断言两条：
 *   ① 每次动完手绘层，状态栏那行**就等于账本**（`改动 {state.changed.size}`）——
 *      不管数值是几，两边必须一致 ✗ 差一拍就是它 ✓
 *   ② 几个关键动作的**方向**：涂完 > 0、清空 = 0、导入恢复 > 0、撤销回 0 ✓
 *
 * 需要的料（跟 check_mobile / check_import 一样，缺了会提示）：
 *   · pdx-map-editor.html        —— python build_standalone.py
 *   · _local/packs/*.pdxmap      —— python pack_map.py 或 build_packs.py
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

/** 找一个测试包（优先 eu4-vanilla 那套；随便一个能用的就行） */
function findPack() {
  const names = ['eu4-vanilla.pdxmap', 'eu4-vanilla-test.pdxmap', 'probe-ck3.pdxmap'];
  for (const d of [path.join(H.ROOT, '_local', 'packs'), path.join(H.ROOT, 'packs')]) {
    for (const n of names) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) return p;
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
    console.log('（没有 _local/packs/ 里的测试包 —— 先跑 '
      + 'python pack_map.py data_xxx --id xxx --label "xxx" --out _local/packs/xxx.pdxmap）');
    process.exit(0);
  }

  const { js, embedded } = H.readStandalone(LOADER);
  const env = H.makeEnv({ embedded, root: H.ROOT });
  const ex = H.instantiate(js, env);
  const b = ex.boot();
  // 等选图界面的导入接线挂上（轻量版没有内嵌图 → 列表空着，等 onchange 就绪）
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
  ok('导入测试包后选单里有卡片', cards.length >= 1, cards.length + ' 张');
  if (!cards.length) { console.log('（没进得去，后面的没法测）'); process.exit(1); }
  cards[0].onclick();
  await b;
  ok('boot 跑到就绪', /就绪/.test((env.get('boot-step') || {}).textContent || ''),
     (env.get('boot-step') || {}).textContent || '');

  const statusEl = env.get('status-changes');
  const status = () => (statusEl || {}).textContent || '';
  const ledger = () => `改动 ${ex.state.changed.size}`;
  /** 断言①：状态栏 === 账本（差一拍就是这条亮） */
  const same = (step) => ok(`${step}：状态栏跟账本一致`, status() === ledger(),
                           `${status()} vs ${ledger()}`);

  same('初始');

  // ---- 涂一笔（真实入口 paintAt）----
  const pid = 3;                       // 测试包的 3 号地块（eu4-vanilla 那套这里有地）
  const tid = ex.titleAt(pid, ex.editTier());
  ex.paintAt(pid, tid);
  same('涂一笔后');
  ok('涂完账本 > 0', ex.state.changed.size > 0, String(ex.state.changed.size));

  // ---- 记下工程 → 清空 → 导入恢复 ----
  const proj = JSON.parse(JSON.stringify(ex.projectData()));
  const n = ex.state.meta.numProvinces;
  const pd = ex.renderer.paintData;
  const all = [];
  for (let q = 1; q < n; q++) if (pd && pd[q * 4 + 3] > 0) all.push(q);
  ex.paintPids(all, null);             // 「清除全部」用手绘层真相的那套
  ex.recomputePainted();
  same('清空后');
  ok('清空后账本 = 0', ex.state.changed.size === 0, String(ex.state.changed.size));

  ex.applyProject(proj);               // 「导入涂色」恢复
  ex.recomputePainted();
  same('导入恢复后');
  ok('导入后账本 > 0', ex.state.changed.size > 0, String(ex.state.changed.size));
  ok('导入后那格真涂回来了', pd[pid * 4 + 3] > 0, `alpha=${pd[pid * 4 + 3]}`);

  // ---- 撤销回原样（历史里有"导入"那些步，撤到底）----
  let guard = 0;
  while (ex.state.history.undo.length && guard++ < 50) ex.undo();
  same('撤销到底后');
  ok('撤销到底账本 = 0', ex.state.changed.size === 0, String(ex.state.changed.size));

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
