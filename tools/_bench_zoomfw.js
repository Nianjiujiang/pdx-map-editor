/**
 * 临时探针：**整帧**缩放开销（不是只 drawLabels）。
 *   node tools/_bench_zoomfw.js EU5 [--csv]
 *
 * 每帧干的活跟 `frameBody()` 一样（顺序照抄）：
 *   view 变 → renderer.view 更新 + dirty → syncLayerSwitches → syncParentBorder
 *   → wasteWatch → renderer.render() → drawLabels(viewRect())
 *
 * 另外报"名单流水"：placePointsInView 捞出多少 → drawPoints 收到多少候选 →
 * 真正画了几个 → 排版查表几次。这三段的比例决定"该削哪一段"。
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'EU5').toUpperCase();
const CSV = process.argv.includes('--csv');
const CARD = `${WHICH} 原版`;
//: 缩放扫的几档（覆盖"地名刚冒出来"到"近景"）
const SCALES = [0.58, 0.70, 0.85, 1.00, 1.45, 2.20];
const N = 20;

function med(a) { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; }
function mn(a) { return Math.min.apply(null, a); }
function p90(a) { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * 0.9))]; }

(async () => {
  const env = H.makeEnv({ root: H.ROOT });
  /* ⚠ 换源码树只给"改前 / 改后"对拍用（`ZF_SRC=tools/_before_src node tools/_bench_zoomfw.js EU5` ✓
   *   数据永远读本工程 ✓ 只有 web/js 那几张源码可以换 ✓）*/
  const SRC = process.env.ZF_SRC || null;
  const ex = H.instantiate(H.flattenModules(undefined, SRC || H.ROOT), env);
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
  const L = ex.labels;
  const W = (st.meta && (st.meta.mapWidth || st.meta.mapW)) || 8192;
  const Hh = (st.meta && (st.meta.mapHeight || st.meta.mapH)) || 4096;
  L.frameBudgetMs = Infinity;      // 量"全量"（交互中的 12ms 截断是设计，单独看）

  // ---- 名单流水计数器（包一层，只数不拦） ----
  const cnt = { cand: 0, pts: 0, lay: 0, frames: 0 };
  const realDrawPoints = L.drawPoints.bind(L);
  L.drawPoints = function (pts, view, need) {
    cnt.pts += (pts && pts.length) || 0; cnt.frames++;
    return realDrawPoints(pts, view, need);
  };
  const realMaybe = L._maybeLayout.bind(L);
  L._maybeLayout = function (p, k, s) { cnt.lay++; return realMaybe(p, k, s); };

  const cssW = L.cssW || 1400;
  const cssH = L.cssH || 820;
  const cx = W / 2, cy = Hh / 2;
  const viewOf = (scale) => {
    const w = cssW / scale, h = Math.min(cssH / scale, Hh);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  };
  const setView = (v) => {
    r.view.x = v.x; r.view.y = v.y; r.view.w = v.w; r.view.h = v.h;
    r.dirty = true;
  };

  const rows = [];
  for (const scale of SCALES) {
    const v = viewOf(scale);
    const frame = () => {
      st.cam.scale = scale;
      st.cam.cx = cx; st.cam.cy = cy;
      /* frameBody 的顺序 —— 照抄，别改顺序（缓存命中与否跟它有关 ✓）*/
      setView(v);
      ex.syncLayerSwitches();
      ex.syncParentBorder();
      ex.wasteWatch();
      r.render();
      ex.drawLabels(v);
    };
    for (let i = 0; i < 3; i++) frame();     // 预热（冷缓存 / 贴图首建不算）
    const tot = [], gl = [], lab = [];
    cnt.cand = cnt.pts = cnt.lay = cnt.frames = 0;
    /* 画布调用数：桩里一张画就是一个计数 ✓ 它是"画出来的东西"的**校验和**
     * （改前后这两个数字必须一模一样 ✓ 不一样就是画的东西变了 ✓）*/
    H.resetCanvasStats();
    const s0 = { image: H.stats.image, fill: H.stats.fill, measure: H.stats.measure, font: H.stats.font };
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      frame();
      tot.push(Number(process.hrtime.bigint() - t0) / 1e6);
      gl.push(0); lab.push(0);
    }
    const img = H.stats.image - s0.image, fil = H.stats.fill - s0.fill;
    const mea = H.stats.measure - s0.measure, fnt = H.stats.font - s0.font;
    rows.push({
      scale, tot: med(tot), best: mn(tot), worst: p90(tot),
      cand: cnt.pts / cnt.frames, pts: cnt.pts / cnt.frames, lay: cnt.lay / cnt.frames,
      drawn: L.drawn | 0,
      fit: L.fitCount | 0, flat: L.flatCount | 0,
      image: img / cnt.frames, fill: fil / cnt.frames,
      measure: mea / cnt.frames, font: fnt / cnt.frames,
    });
  }

  if (CSV) { console.log('scale,total_ms,p90,cand,pts,layout,drawn'); }
  if (!CSV) console.log(`\n########## ${CARD} · 整帧缩放（${N} 次中位） ##########`);
  console.log('  scale   整帧ms   min   p90  候选  排版查表  画出  贴合/横排  image  fill  meas  font');
  for (const x of rows) {
    console.log(`  ${(x.scale * 100).toFixed(0).padStart(4)}%  ${x.tot.toFixed(2).padStart(6)} `
      + `${x.best.toFixed(2).padStart(5)} ${x.worst.toFixed(2).padStart(5)} ${String(Math.round(x.cand)).padStart(6)} `
      + `${String(Math.round(x.lay)).padStart(8)} ${String(x.drawn).padStart(5)} `
      + `${String(x.fit).padStart(5)}/${String(x.flat).padEnd(5)} `
      + `${String(x.image).padStart(6)} ${String(x.fill).padStart(5)} `
      + `${String(x.measure).padStart(5)} ${String(x.font).padStart(5)}`);
  }
  const mid = rows.find((x) => Math.abs(x.scale - 0.58) < 1e-6) || rows[0];
  console.log(`  ----  最肉的一档（${(mid.scale * 100).toFixed(0)}%）：整帧 ${mid.tot.toFixed(2)} ms`);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
