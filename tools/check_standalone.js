/**
 * 验一下**烤好的单文件版**能不能跑。
 *
 *   node tools/check_standalone.js                      # 默认看根目录那个 35MB 的
 *   node tools/check_standalone.js path/to/other.html
 *
 * 为什么要有这个：那个 HTML 是唯一发给玩家的东西，而它是**烤出来的** ——
 * 源文件改了、忘了重烤，或者烤的过程中哪一步错了（内嵌数据被压坏、
 * 拍平脚本被截断、`window.__CK3_EMBEDDED__` 没写对），
 * 原来只有"玩家双击、白屏、来问你"这一条路能发现。
 *
 * 这里直接把 HTML 里的**内嵌数据 + 拍平脚本**原样抠出来，
 * 用同一套假 DOM / 假 WebGL 跑一遍 boot()，然后逐项验：
 *   · 选单列出了几套地图（= 内嵌了几套）
 *   · 每套地图的 meta / 头衔表 / 省份 id 图都解得出、尺寸对得上
 *   · 渲染器真的建起来了（着色器没编译失败）
 *   · 换一张图也能起来
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const HTML = process.argv[2] || path.join(H.ROOT, 'pdx-map-editor.html');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

/** 跑一次启动，返回探针与假环境 */
async function bootWith(embedded, wantLabel) {
  const env = H.makeEnv({ embedded });
  const js = H.readStandalone(HTML).js;      // 拍平脚本只读一次，重复跑没关系
  const ex = H.instantiate(js, env);
  const booting = ex.boot();
  for (let i = 0; i < 2000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const cards = env.get('map-pick-list').children;
  const card = wantLabel
    ? cards.find((c) => c.flat().includes(wantLabel))
    : cards[0];
  if (card) card.onclick();
  await booting;
  return { ex, env, cards, card };
}

(async () => {
  console.log(`\n===== 单文件版自检：${path.relative(H.ROOT, HTML)} =====`);
  if (!fs.existsSync(HTML)) { console.log('  ✘ 文件不存在'); process.exit(1); }
  const size = fs.statSync(HTML).size;
  console.log(`  文件 ${(size / 1048576).toFixed(2)} MB`);

  const { embedded, js, html } = H.readStandalone(HTML);
  ok('HTML 里有 window.__CK3_EMBEDDED__（内嵌数据）', !!embedded,
     embedded ? Object.keys(embedded.maps || {}).join('/') : '没有 ✗');
  ok('拍平脚本抠出来了（不是空壳）', js.length > 100000, `${js.length} 字符`);
  ok('file:// 那段"不能双击打开"的提示已经摘掉', !/不能直接双击打开/.test(html));
  ok('外链 CSS 已经内联（没有 <link rel=stylesheet>）',
     !/<link rel="stylesheet" href="style\.css">/.test(html));
  if (!embedded) process.exit(1);

  const keys = Object.keys(embedded.maps || {});
  ok(`内嵌了 ${keys.length} 套地图`, keys.length >= 6, keys.join(' / '));

  // 每一套：meta / 头衔表都解得出，并且尺寸自洽
  for (const [key, m] of Object.entries(embedded.maps)) {
    const hasMeta = !!m.meta;
    const hasTitles = !!m.titles;
    let titleCount = -1;
    try {
      const gz = Buffer.from(m.titles, 'base64');
      const t = JSON.parse(require('zlib').gunzipSync(gz).toString('utf8'));
      titleCount = (t.keys || []).length;
    } catch (e) { titleCount = -1; }
    ok(`  [${key}] meta + 头衔表都内嵌且解得开`,
       hasMeta && hasTitles && titleCount > 0,
       hasMeta ? `${m.meta.game} ${m.meta.mapWidth}×${m.meta.mapHeight} · ${titleCount} 个头衔`
               : '没有 meta ✗');
    if (hasMeta) {
      const need = m.meta.mapWidth * m.meta.mapHeight;
      const got = Buffer.from(m.provinces, 'base64').length;   // 压缩后，只能判个大概
      ok(`  [${key}] 省份 id 图在（压缩后 ${(got / 1024).toFixed(0)} KB）`, got > 0,
         `解压后应有 ${(need / 1048576).toFixed(1)}M 个像素位`);
    }
  }

  // 真跑一遍：挑第一张能起来
  console.log('\n---- 真跑一遍 ----');
  const { ex, env, cards } = await bootWith(embedded, null);
  ok('选单里的地图数 = 内嵌的数', cards.length === keys.length,
     `${cards.length} 张：${cards.map((c) => c.flat().replace(/<[^>]*>/g, '').trim()).join(' / ')}`);
  const step = (env.get('boot-step') || {}).textContent || '';
  ok('boot 跑到"就绪"', /就绪/.test(step), step || '（没走到那一步）');
  ok('meta 装上了', !!(ex.state.meta && ex.state.meta.numTitles),
     ex.state.meta ? `${ex.state.meta.numProvinces} 地块 / ${ex.GAME.name}` : '没装上 ✗');
  ok('渲染器建起来了（WebGL2 着色器没编译失败）', !!ex.renderer);
  ok('头衔表解开了', !!(ex.state.titles && ex.state.titles.keys.length),
     ex.state.titles ? `${ex.state.titles.keys.length} 个头衔` : '没有 ✗');
  ok('省份 id 图就位（一整张或分块）',
     !!ex.state.provinceIds || !!ex.state.tileMap,
     ex.state.tileMap ? '分块' : '整张');
  ok('标签层建起来了', !!ex.labels);
  ok('状态栏写上了版本信息',
     /地块/.test((env.get('status-meta') || {}).textContent || ''),
     (env.get('status-meta') || {}).textContent || '');

  // 再挑一张别的（有的话）—— 换游戏能不能起来
  if (cards.length > 1) {
    const other = cards[cards.length - 1];
    const label = other.flat().replace(/<[^>]*>/g, '').trim().split(/\s+/)[0];
    const r2 = await bootWith(embedded, label);
    ok(`换一张（${label}）也能起来`, /就绪/.test((r2.env.get('boot-step') || {}).textContent || ''),
       (r2.env.get('boot-step') || {}).textContent || '');
  }

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
