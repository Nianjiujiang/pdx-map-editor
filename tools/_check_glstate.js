/**
 * 临时自检：render() 那本"上次发过什么"的账**到底会不会发错**。
 *   node tools/_check_glstate.js EU4
 *
 * 为什么非要这个：
 *   缓存能省的正是"同一个值发两遍"✗ 可一旦**该发的没发**，画面就悄悄错 ✓
 *   桩里的 GL 是空函数，看不出对错 ✓ 所以这里给 renderer.gl 套一层**记账替身**：
 *     · activeTexture / bindTexture → 记下"第几号单元绑着哪张"
 *     · uniform* → 按 uniform 名字记下最后发出去的值
 *     · drawArrays → 就在这一瞬间拍快照（= 着色器真正看到的状态 ✓）
 *   然后各种"改一下再画"的场景都跑一遍，逐个断言 ✓
 *   —— 断言的都是"着色器看到的东西"，不是"调了几条"，所以跟缓存怎么实现无关 ✓
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'EU4').toUpperCase();
const CARD = `${WHICH} 原版`;

let fails = 0, checks = 0;
function ok(cond, what, extra) {
  checks++;
  if (cond) return;
  fails++;
  console.log(`  ✘ ${what}${extra === undefined ? '' : '  → ' + JSON.stringify(extra)}`);
}

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

  const r = ex.renderer;
  const realGl = r.gl;

  /* ---- 记账替身 ---------------------------------------------------- */
  const BASE = 33984;                    // 真机上 gl.TEXTURE0 的值
  const st = { unit: 0, units: new Array(16).fill(null), uni: new Map(), snap: null };
  const unitOf = (v) => (typeof v === 'number' ? v - BASE : -1);
  const rec = {
    TEXTURE0: BASE + 0, TEXTURE1: BASE + 1, TEXTURE2: BASE + 2, TEXTURE3: BASE + 3,
    TEXTURE4: BASE + 4, TEXTURE5: BASE + 5, TEXTURE6: BASE + 6, TEXTURE7: BASE + 7,
    TEXTURE8: BASE + 8, TEXTURE9: BASE + 9, TEXTURE10: BASE + 10, TEXTURE11: BASE + 11,
    TEXTURE12: BASE + 12, TEXTURE13: BASE + 13, TEXTURE14: BASE + 14, TEXTURE15: BASE + 15,
    activeTexture(v) { st.unit = unitOf(v); return realGl.activeTexture(v); },
    bindTexture(target, tex) { st.units[st.unit] = tex || null; return realGl.bindTexture(target, tex); },
    uniform1i(l, v) { st.uni.set(l && l.name, v); return realGl.uniform1i(l, v); },
    uniform1f(l, v) { st.uni.set(l && l.name, v); return realGl.uniform1f(l, v); },
    uniform1ui(l, v) { st.uni.set(l && l.name, v); return realGl.uniform1ui(l, v); },
    uniform2i(l, a, b) { st.uni.set(l && l.name, [a, b]); return realGl.uniform2i(l, a, b); },
    uniform2f(l, a, b) { st.uni.set(l && l.name, [a, b]); return realGl.uniform2f(l, a, b); },
    uniform3f(l, a, b, c) { st.uni.set(l && l.name, [a, b, c]); return realGl.uniform3f(l, a, b, c); },
    uniform4f(l, a, b, c, d) { st.uni.set(l && l.name, [a, b, c, d]); return realGl.uniform4f(l, a, b, c, d); },
    uniform1iv(l, v) { st.uni.set(l && l.name, Array.from(v)); return realGl.uniform1iv(l, v); },
    uniform1fv(l, v) { st.uni.set(l && l.name, Array.from(v)); return realGl.uniform1fv(l, v); },
    uniform3fv(l, v) { st.uni.set(l && l.name, Array.from(v)); return realGl.uniform3fv(l, v); },
    drawArrays(...a) {
      st.snap = { units: st.units.slice(), uni: new Map(st.uni) };
      return realGl.drawArrays(...a);
    },
  };
  r.gl = new Proxy(rec, {
    get(t, k) {
      if (k in t) return t[k];
      const v = realGl[k];
      return typeof v === 'function' ? v.bind(realGl) : v;
    },
  });

  const draw = () => {
    st.snap = null;
    r.dirty = true;
    r.render();
    return st.snap;
  };
  const u = (s, n) => s.uni.get(n);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /* 期望的纹理绑定（按当前 renderer 的字段推，不是抄代码 ✓）*/
  const wantUnits = () => {
    const e = new Array(16).fill(null);
    e[0] = r.provTex; e[1] = r.titleTex; e[2] = r.colorTex;
    e[3] = r.paintTex; e[4] = r.paintLabelTex; e[5] = r.provArrTex || null;
    e[6] = r.hoverGroupTex || null; e[7] = r.kindTex || null; e[8] = r.waterKindTex || null;
    e[9] = (r.borderDepthTex && r.borderDepthOn) ? r.borderDepthTex : r.dummyTex;
    if (r.flagOn && r.flagIdxTex && r.flagSlotTex && r.flagTexArr) {
      e[10] = r.flagIdxTex; e[11] = r.flagSlotTex; e[12] = r.flagTexArr;
    } else {
      e[10] = r.dummyTex; e[11] = r.dummyTex; e[12] = r.dummyArrTex;
    }
    return e;
  };
  const checkUnits = (tag) => {
    const s = draw();
    if (!s) { ok(false, `${tag}：这一帧没画（dirty 被谁清了？）`); return; }
    const e = wantUnits();
    for (let i = 0; i < 13; i++) {
      ok(s.units[i] === e[i], `${tag}：${i} 号单元的纹理`, i);
    }
  };
  const checkUniforms = (tag) => {
    const s = draw();
    if (!s) { ok(false, `${tag}：这一帧没画`); return; }
    ok(u(s, 'uTier') === r.tier, `${tag}：uTier`, u(s, 'uTier'));
    ok(u(s, 'uEditTier') === r.editTier, `${tag}：uEditTier`, u(s, 'uEditTier'));
    ok(u(s, 'uShowTitles') === (r.showTitles ? 1 : 0), `${tag}：uShowTitles`);
    ok(same(u(s, 'uView'), [r.view.x, r.view.y, r.view.w, r.view.h]), `${tag}：uView`, u(s, 'uView'));
    ok(u(s, 'uPaintW') === r.paintW, `${tag}：uPaintW`);
    ok(u(s, 'uHoverTid') === r.hoverTid, `${tag}：uHoverTid`, u(s, 'uHoverTid'));
    ok(u(s, 'uHoverPid') === (r.hoverPid || 0), `${tag}：uHoverPid`);
    ok(u(s, 'uBorderW') === r.borderWidth, `${tag}：uBorderW`);
    ok(same(u(s, 'uExtraTier'), Array.from(r.extraTiers)), `${tag}：uExtraTier`, u(s, 'uExtraTier'));
    ok(same(u(s, 'uExtraW'), Array.from(r.extraWs)), `${tag}：uExtraW`);
    ok(u(s, 'uExtraCount') === (r.extraCount | 0), `${tag}：uExtraCount`);
    ok(same(u(s, 'uUnpainted'), r.unpainted.slice(0, 3)), `${tag}：uUnpainted`);
    ok(same(u(s, 'uBackdrop'), r.backdrop.slice(0, 3)), `${tag}：uBackdrop`);
  };

  console.log(`\n########## ${CARD} · GL 状态对账 ################`);

  /* ① 冷启动第一帧 */
  checkUnits('冷启动');
  checkUniforms('冷启动');

  /* ② 只挪相机：纹理一条都不该重绑，uView 必须跟上 ✓ */
  r.setView(r.view.x + 37, r.view.y - 11, r.view.w * 1.1, r.view.h * 1.1);
  checkUnits('挪相机');
  checkUniforms('挪相机');

  /* ③ 换层 + 关/开图层：uniform 必须跟着变 ✓ */
  const tiers = r.tier;
  r.setTier((tiers + 1) % 3); r.setEditTier(r.tier);
  r.setShowTitles(!r.showTitles); r.setShowPaint(!r.showPaint); r.setMix(0.5);
  checkUniforms('换层/关图');
  checkUnits('换层/关图');

  /* ④ 悬停高亮：三个 ui / 颜色 ✓ */
  r.setHoverState(42, true, [255, 0, 0], 7, 1234, 0);
  {
    const s = draw();
    ok(u(s, 'uHoverPid') === 42, '悬停：uHoverPid');
    ok(u(s, 'uHoverTid') === 1234, '悬停：uHoverTid', u(s, 'uHoverTid'));
    ok(u(s, 'uHoverPaintOn') === 1, '悬停：uHoverPaintOn');
    ok(u(s, 'uHoverLabel') === 7, '悬停：uHoverLabel');
    ok(same(u(s, 'uHoverPaint'), [0, 0, 0]) || same(u(s, 'uHoverPaint'), [255, 0, 0]),
      '悬停：uHoverPaint 只能是传进去的那份', u(s, 'uHoverPaint'));
  }

  /* ⑤ **别处绑过纹理**（换图 / 传块最常干的事）→ 下一帧必须自己重绑回来 ✓
   *    这条是缓存最容易出错的地方：账上写着"12 号单元还是占位纹理"✗ 其实早被顶掉了 ✓ */
  {
    const before = st.units.slice();
    realGl.activeTexture(BASE + 11);        // 模拟"别处的当前单元"
    st.unit = 11;
    const junk = r.makeTileArray ? r.makeTileArray(8, 8, 1, null) : null;
    if (junk) st.units[11] = junk;
    r.dirty = true;
    const s = draw();
    ok(!!s, '别处绑纹理后：这一帧画了');
    const e = wantUnits();
    for (let i = 0; i < 13; i++) ok(s.units[i] === e[i], `别处绑纹理后：${i} 号单元`, i);
    ok(before[0] === e[0], '（前置）0 号单元本来就是那张');
  }

  /* ⑥ 真传一块（上传会绑数组纹理到"当前单元"）→ 下一帧 5 号必须还是 provArrTex ✓ */
  if (r.tileInfo && r.provArrTex) {
    const n = r.tileInfo.tileW * r.tileInfo.tileH;
    r.uploadedTiles && r.uploadedTiles.clear();
    r.uploadTile(0, new Uint16Array(n).fill(7));
    const s = draw();
    ok(s.units[5] === r.provArrTex, '传块之后：5 号单元还是分块数组纹理', s.units[5] && 'other');
    ok(s.units[12] === r.dummyArrTex, '传块之后：12 号单元没被顶掉', s.units[12] && 'other');
  }

  /* ⑦ 换程序（后台升级着色器走的就是这条路）：uniform 必须**全部**重发 ✓
   *    不清账的话新程序沿用旧账 → 整帧零值 ✓ */
  {
    r._installProgram(r.prog);
    // 新程序 → 统一把账清空；下面这些值全都要重新出现 ✓
    st.uni.clear();
    checkUniforms('换程序');
    const s = draw();
    ok(u(s, 'uNumProvinces') === r.numProvinces, '换程序：uNumProvinces 重发了');
    ok(u(s, 'uLutW') === r.lutW, '换程序：uLutW 重发了');
    checkUnits('换程序');
  }

  /* ⑧ 三帧连着画（模拟拖动）：状态不许漂 ✓ */
  for (let i = 0; i < 3; i++) {
    r.setView(r.view.x + 5 * (i + 1), r.view.y, r.view.w, r.view.h);
    const s = draw();
    const e = wantUnits();
    for (let k = 0; k < 13; k++) ok(s.units[k] === e[k], `连拖第 ${i + 1} 帧：${k} 号单元`, k);
  }

  r.gl = realGl;
  console.log(fails
    ? `\n  ✘ ${fails} / ${checks} 条不对`
    : `\n  ✓ ${checks} 条全对（纹理 13 路 / uniform 十几路 / 换程序 / 别处绑纹理 / 传块）`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
