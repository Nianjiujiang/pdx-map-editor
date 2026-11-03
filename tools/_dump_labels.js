/**
 * 对拍：`drawLabels(view, capture=true)` 抓出来的**名单**（只抓不画）。
 *   node tools/_dump_labels.js EU5 out.json
 * 拿新旧两份 app.js 各跑一遍、diff json —— 名单必须一字不差。
 */
'use strict';
const fs = require('fs');
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'EU5').toUpperCase();
const OUT = process.argv[3] || 'tmp_labels.json';
const CARDS = { VIC3: 'VIC3 原版', EU5: 'EU5 原版', EU4: 'EU4 原版', CK3: 'CK3 原版', HOI4: 'HOI4 原版' };
const CARD = CARDS[WHICH] || `${WHICH} 原版`;

(async () => {
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(), env);
  const booting = ex.boot();
  for (let i = 0; i < 6000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const list = env.get('map-pick-list').children;
  const card = list.find((x) => x.flat().includes(CARD)) || list[0];
  card.onclick();
  await booting;

  const st = ex.state;
  const W = st.meta.mapWidth, Hh = st.meta.mapHeight;
  const nEra = (st.meta.eraDates && st.meta.eraDates.length) || 0;
  const views = {
    '整图': { x: 0, y: 0, w: W, h: Hh },
    '半图': { x: W * 0.25, y: Hh * 0.25, w: W * 0.5, h: Hh * 0.5 },
    '近景': { x: W * 0.45, y: Hh * 0.45, w: 1400, h: 900 },
  };
  const out = {};
  // 层：剧本层（如果有）+ 最粗地理层 + 中间层 + 最细层
  const tiers = [];
  if (nEra > 0) tiers.push(0, nEra);
  tiers.push((st.meta.tiers.length - 1));
  const tierList = [...new Set(tiers.map((t) => Math.max(0, Math.min(st.meta.tiers.length - 1, t))))];
  const toggles = [
    ['全开', { showLabelsTitle: true, showWaterName: true, showWasteName: true, showLabelsPaint: true }],
    ['只地', { showLabelsTitle: true, showWaterName: false, showWasteName: false, showLabelsPaint: false }],
    ['只水', { showLabelsTitle: false, showWaterName: true, showWasteName: false, showLabelsPaint: false }],
    ['只荒', { showLabelsTitle: false, showWaterName: false, showWasteName: true, showLabelsPaint: false }],
    ['全关', { showLabelsTitle: false, showWaterName: false, showWasteName: false, showLabelsPaint: false }],
  ];
  // 缩放档：让 zoom 门槛内外都过一遍
  const scales = [0.15, 0.4, 1.0, 3.0];
  for (const t of tierList) {
    for (const [tname, tg] of toggles) {
      for (const sc of scales) {
        st.tier = t;
        Object.assign(st, tg);
        ex.labels.scale = sc;
        for (const [vname, v] of Object.entries(views)) {
          let got = [];
          try {
            got = ex.drawLabels(v, true) || [];
          } catch (e) {
            got = ['ERR:' + e.message];
          }
          out[`t${t}|${tname}|s${sc}|${vname}`] = got
            .map((q) => `${q.tid}:${q.name}`)
            .sort();
        }
      }
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  let total = 0;
  for (const v of Object.values(out)) total += v.length;
  console.log(`${CARD}: ${Object.keys(out).length} 组，共 ${total} 条名字 → ${OUT}`);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
