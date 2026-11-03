'use strict';
const H = require('./lib/browser_stub.js');
const WHICH = (process.argv[2] || 'EU5').toUpperCase();
(async () => {
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(), env);
  const booting = ex.boot();
  for (let i = 0; i < 6000 && !env.get('map-pick-list').children.length; i++) await new Promise((r) => setImmediate(r));
  const list = env.get('map-pick-list').children;
  const card = list.find((x) => x.flat().includes(WHICH + ' 原版')) || list[0];
  card.onclick(); await booting;
  const st = ex.state, L = ex.labels;
  const nEra = (st.meta.eraDates && st.meta.eraDates.length) || 0;
  const fine = st.meta.tierNames.length - 1;
  for (const tier of [fine, fine - 1, 0]) {
    const kept = ex.placePointsFor(tier) || [];
    console.log(`层 ${tier}: kept ${kept.length} 个点`);
  }
  console.log('nameTier(当前画图用的):', typeof ex.labelTier === 'function' ? ex.labelTier() : ex.labels && ex.labels.tier);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
