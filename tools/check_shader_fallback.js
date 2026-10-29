'use strict';
/**
 * 着色器降级链的**运行时**回归（2026-10-27 Adreno 613 报告）。
 *
 *   node tools/check_shader_fallback.js 1
 *   node tools/check_shader_fallback.js 2
 *   node tools/check_shader_fallback.js 3
 *   node tools/check_shader_fallback.js 4
 *
 * 参数 = 模拟「前 N 次 linkProgram 失败」。
 *   1 → 完整版失败，应该退到 mid（保留本层 + 多级边界）
 *   2 → mid 也失败，应该退到 border（本层头衔 + 填色）
 *   3 → border 也失败，应该退到 title（仅本层头衔）
 *   4 → title 也失败，应该退到 lite（无边界，最后保底）
 *
 * 为什么单独一个进程：同一进程里第二次 boot 会踩全局状态，跑不通（踩过 ✓）。
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const force = Math.max(1, Math.min(4, Number(process.argv[2] || 1) | 0));
const expect = ['', 'mid', 'border', 'title', 'lite'][force];
const HTML = path.join(H.ROOT, 'pdx-map-editor.html');

/** 找一张测试图 ✓（2026-10-27）
 *  ⚠ 别写死 `packs/pdx-eu4-vanilla.pdxmap` ✗ —— 那个文件只有作者本机才有，
 *     别人跑这一条就是 ENOENT 直接崩（不是"红"）✗
 *  仓库里跟着 `_local/packs/*.pdxmap` 的自测包也认 ✓ 一张都没有就明说跳过 ✓ */
function findPack() {
  const want = ['pdx-eu4-vanilla.pdxmap', 'eu4-vanilla.pdxmap', 'eu4-vanilla-test.pdxmap'];
  for (const d of [path.join(H.ROOT, 'packs'), path.join(H.ROOT, '_local', 'packs')]) {
    for (const n of want) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) return p;
    }
    if (fs.existsSync(d)) {
      const any = fs.readdirSync(d).find((n) => n.endsWith('.pdxmap'));
      if (any) return path.join(d, any);
    }
  }
  return null;
}
const pack = findPack();
if (!pack) {
  console.log('（没有可用的测试地图包 —— 先跑 pack_map.py 打一个，或放一个进 _local/packs/ ✓ 本条跳过）');
  process.exit(0);
}

(async () => {
  const { embedded, js } = H.readStandalone(HTML);
  H.setForceLinkFail(force);
  const env = H.makeEnv({ embedded, root: H.ROOT });
  const ex = H.instantiate(js, env);
  const booting = ex.boot();

  const fi = env.get('pack-file');
  for (let i = 0; i < 3000 && typeof fi.onchange !== 'function'; i++) {
    await new Promise((r) => setImmediate(r));
  }
  fi.files = [new Blob([fs.readFileSync(pack)])];
  await fi.onchange();
  for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const card = env.get('map-pick-list').children[0];
  if (card) card.onclick();
  await booting;
  H.setForceLinkFail(0);

  const r = ex.renderer;
  const tier = r && r.shaderTier;
  const lite = !!(r && r.liteShader);
  const ok = tier === expect && (expect === 'lite' ? lite === true : lite === false);
  console.log(`force=${force}  expect=${expect}  got=${tier}  lite=${lite}  ${ok ? '✔' : '✘'}`);
  if (!ok) process.exit(1);
})().catch((e) => {
  H.setForceLinkFail(0);
  console.error('✘ boot 失败：', e && (e.stack || e.message || e));
  process.exit(1);
});
