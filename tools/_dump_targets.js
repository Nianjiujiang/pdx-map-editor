/**
 * 对拍：`paintTargetsAt(pid)` 全图逐 pid 的**目标名单**。
 *   node tools/_dump_targets.js EU5 out.json
 * 新旧两份 app.js 各跑一遍、比 hash —— 必须一字不差。
 *
 * 会自己捏几种手绘状态（不改磁盘）：
 *   ① 全没涂  ② 按 pid % 4 涂四色（每种一个标记名）
 *   ③ 只在剧本层某些国上涂（涂过的名字 = 剧本名）
 * 再 × 两个层（剧本层 / 最细层）。
 */
'use strict';
const fs = require('fs');
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'EU5').toUpperCase();
const OUT = process.argv[3] || 'tmp_targets.json';
const CARDS = { VIC3: 'VIC3 原版', EU5: 'EU5 原版', EU4: 'EU4 原版', CK3: 'CK3 原版', HOI4: 'HOI4 原版' };
const CARD = CARDS[WHICH] || `${WHICH} 原版`;

function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

(async () => {
  const env = H.makeEnv({ root: H.ROOT });
  /* `PDX_SRC=<目录>` → 从别的源码树拍平（那个目录下要有 web/js/*.js ✓）
   * 这样对拍"老版本"不用把 app.js 换来换去 ✓（换文件那招在并行干活时特别危险 ✓）*/
  const SRC = process.env.PDX_SRC || null;
  const js = SRC ? H.flattenModules(H.MODULES, SRC) : H.flattenModules();
  const ex = H.instantiate(js, env);
  const booting = ex.boot();
  for (let i = 0; i < 6000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const list = env.get('map-pick-list').children;
  const card = list.find((x) => x.flat().includes(CARD)) || list[0];
  card.onclick();
  await booting;

  const st = ex.state;
  const r = ex.renderer;
  const n = st.meta.numProvinces;
  const nEra = (st.meta.eraDates && st.meta.eraDates.length) || 0;
  const tiers = st.meta.tiers.length;

  // 名字表：四色标记（模仿玩家手绘色块）
  st.labelNames = ['红国', '蓝国', '绿国', '黄国'];
  const COLORS = [[200, 40, 40], [40, 60, 200], [40, 160, 80], [210, 180, 40]];

  const pd = r.paintData;
  const clearPaint = () => {
    pd.fill(0);
    st.provLabel.fill(-1);
    st.provTitle.fill(-1);
    ex.recomputePainted();
  };

  const paintPattern = (mode) => {
    clearPaint();
    for (let pid = 1; pid < n; pid++) {
      let lid = -1;
      if (mode === 'quarters') lid = pid % 4;
      else if (mode === 'owner') {
        // 照剧本最细层归属挑一部分国
        const tid = ex.titleAt(pid, tiers - 1);
        lid = (tid != null && tid > 0) ? tid % 4 : -1;
      } else if (mode === 'mixed') {
        lid = (pid % 3 === 0) ? (pid % 4) : -1;
      }
      if (lid < 0) continue;
      const q4 = pid * 4, c = COLORS[lid];
      pd[q4] = c[0]; pd[q4 + 1] = c[1]; pd[q4 + 2] = c[2]; pd[q4 + 3] = 255;
      st.provLabel[pid] = lid;
      const ft = ex.titleAt(pid, tiers - 1);
      st.provTitle[pid] = (ft != null && ft !== ex.NO_TITLE) ? ft : 0;
    }
    ex.recomputePainted();
  };

  const out = {};
  const paintModes = ['none', 'quarters', 'owner', 'mixed'];
  const tierList = [...new Set([0, Math.max(0, nEra - 1), tiers - 1].map((t) => Math.max(0, Math.min(tiers - 1, t))))];
  const grains = [null, 0];
  for (const pm of paintModes) {
    paintPattern(pm);
    for (const t of tierList) {
      for (const gr of grains) {
        st.tier = t;
        st.grain = gr;
        let cnt = 0, sum = 0;
        /* ⚠ **抽样**，别全扫 ✗（老版本 `paintTargetsAt` 一次 2ms × 4 万 pid × 24 组 = 半小时 ✓
         *   抽样 400 个 + 每个模式前 200 个（把荒地/无主那些边角也捞进来 ✓）就够对拍了 ✓）*/
        const step = Math.max(1, Math.floor(n / 400));
        for (let pid = 1; pid < n; pid += step) {
          let got;
          try { got = ex.paintTargetsAt(pid); } catch (e) { got = 'ERR:' + e.message; }
          const s = got == null ? 'null' : (typeof got === 'string' ? got : got.join(','));
          cnt++; sum = (sum * 31 + hash(s)) >>> 0;
        }
        for (let pid = 1; pid < Math.min(n, 200); pid++) {
          let got;
          try { got = ex.paintTargetsAt(pid); } catch (e) { got = 'ERR:' + e.message; }
          const s = got == null ? 'null' : (typeof got === 'string' ? got : got.join(','));
          cnt++; sum = (sum * 31 + hash(s)) >>> 0;
        }
        out[`${pm}|t${t}|g${gr}`] = { cnt, sum };
      }
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`${CARD}: ${Object.keys(out).length} 组 → ${OUT}`);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
