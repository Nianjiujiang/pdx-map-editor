/**
 * 悬停两行的规格自检（用户 2026-10-16 点名的**逐类逐游戏**方案）。
 *
 *   node tools/check_hover_card.js          # 六套地图都过一遍
 *   node tools/check_hover_card.js CK3      # 只跑一套
 *
 * 规格（原话整理）：
 *   荒地：CK3 → 一行「不可通行区域」
 *         CK2 / EU4 / EU5 → 以**最低单位**为单位显示名称（一行）
 *         VIC3 / HOI4 → 无此设定（按陆地：目前层级 + 最低层级）
 *   河流：CK2 / CK3 → 一行「河流」／其他游戏无此设定（按水域）
 *   湖泊：除 EU4 / EU5 → 一行「湖泊」／EU4 / EU5 → 最低单位名称（一行）
 *   水域：CK2 / VIC3 → 最低单位名称（一行）
 *         CK3 → 一行「海洋」
 *         EU4 / EU5 → 第一行按**层级**，第二行最低单位名称
 *         HOI4 → 第一行**所属战略区**的名称（一行）
 *   陆地（其余一切）：第一行 = 目前层级，第二行 = 鼠标所指处最低层级
 *
 * 做法：把 web/js 拍平、喂假 DOM 跑真的 boot()，从 data_xxx 载入地图逐格悬停读卡片。
 * ⚠ 断言别钉死在"最细层" ✗ —— 那一层第一行本来就是最低单位、第二行同词留空 ✓
 *   （用户拍过"同词不重复" ✓）要验"按层级"就在**粗层**验 ✓
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const ONLY = (process.argv[2] || '').toUpperCase();
const fails = [];

function ok(name, cond, extra = '') {
  if (!cond) fails.push(name);
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

const MAPS = [
  { id: 'CK3', game: 'ck3', data: 'data', card: 'CK3 原版' },
  { id: 'CK2', game: 'ck2', data: 'data_ck2', card: 'CK2 原版' },
  { id: 'EU4', game: 'eu4', data: 'data_eu4', card: 'EU4 原版' },
  { id: 'HOI4', game: 'hoi4', data: 'data_hoi4', card: 'HOI4 原版' },
  { id: 'VIC3', game: 'vic3', data: 'data_vic3', card: 'VIC3 原版' },
  { id: 'EU5', game: 'eu5', data: 'data_eu5', card: 'EU5 原版' },
];

async function bootMap(m) {
  const js = H.flattenModules();
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(js, env);
  const booting = ex.boot();
  for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  ex.setDataDir(m.data);
  const cards = env.get('map-pick-list').children;
  const card = cards.find((c) => c.flat().includes(m.card));
  if (card) card.onclick();
  await booting;
  return { ex, env };
}

/** 把镜头挪到"确实属于这个 pid 的一个像素"上，再派一发 mousemove */
function hover(ex, env, pid) {
  const ids = ex.state.provinceIds, W = ex.state.meta.mapWidth;
  let idx = -1;
  for (let i = 0; i < ids.length; i++) { if (ids[i] === pid) { idx = i; break; } }
  if (idx < 0) return null;
  const mx = (idx % W) + 0.5, my = Math.floor(idx / W) + 0.5;
  const stage = env.get('stage'), rect = stage.getBoundingClientRect();
  ex.state.cam.scale = Math.min(stage.clientWidth / ex.state.meta.mapWidth,
                                stage.clientHeight / ex.state.meta.mapHeight);
  ex.state.cam.cx = mx; ex.state.cam.cy = my;
  const w = stage.clientWidth / ex.state.cam.scale, h = stage.clientHeight / ex.state.cam.scale;
  const vx = ex.state.cam.cx - w / 2, vy = ex.state.cam.cy - h / 2;
  const X = rect.left + ((mx - vx) / w) * rect.width;
  const Y = rect.top + ((my - vy) / h) * rect.height;
  ex.state.hover.inside = false; ex.state.hover.pid = 0;
  env.dispatchWindow('mousemove', { clientX: X, clientY: Y });
  return env.get('hover-card').innerHTML;
}

/** 左侧栏那口（`#hover-chain`）里到底是"层级链"还是"紧凑那一句"？
 *
 *  🔴 桩有两个坑，都在这儿 ✗：
 *    ① `innerHTML` 的 getter 只回 **set 进去的那个串** ✓ —— `appendChild` 加进去的
 *      子节点不在里面 ✗（层级链正是 append 出来的 ✓）
 *    ② `flat()` 读不到 `row.innerHTML` 里的文本 ✗（桩不建文本节点 ✓）
 *    → 递归抠子节点的 `_html` 才算得准 ✓
 */
function sidebarShape(env) {
  const box = env.get('hover-chain');
  const rough = (el) => {
    if (!el) return '';
    let s = el._html || '';
    if (!el.children || !el.children.length) s += el.textContent || '';
    return s + (el.children || []).map(rough).join('');
  };
  const html = rough(box);
  const names = [...html.matchAll(/<span class="name"[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, '').trim());
  return { rows: (box.children || []).length, names, html };
}

/*: **地图上的名字**显示方案（用户 2026-10-16 ✓
 *  ⚠ **第二轮更变**：CK2 的湖泊和河流也要显示名字 ✓ 见下面两行 ✓）*/
const NAME_POLICY = {
  land: { ck3: true, ck2: true, eu4: true, eu5: true, hoi4: true, vic3: true },
  sea: { ck3: false, ck2: true, eu4: true, eu5: true, hoi4: true, vic3: true },
  lake: { ck3: false, ck2: true, eu4: true, eu5: true, hoi4: false, vic3: false },
  river: { ck3: false, ck2: true, eu4: false, eu5: false, hoi4: false, vic3: false },
  waste: { ck3: false, ck2: false, eu4: true, eu5: true, hoi4: false, vic3: false },
};

/** 拦住 `labels.drawPoints(list, view)` —— 最终入列的名单就是"图上会画什么" ✓ */
function watchLabelList(ex) {
  const box = { list: null };
  const L = ex.labels;
  if (L && typeof L.drawPoints === 'function') {
    const orig = L.drawPoints.bind(L);
    L.drawPoints = (pts, view, need) => { box.list = pts || []; return orig(pts, view, need); };
  }
  return box;
}

/** 逐层跑 `drawLabels`，把各层最终入列名单并起来（HOI4 的海名在战略层 ✓ 只扫最细层会漏 ✓）
 *
 *  🔴 **2026-10-17 加了两个开关参数** ✗ ——
 *    用户把「水域 · 名称」和「荒地 · 名称」的默认值都改成了**关闭** ✓
 *    所以"水名 / 荒地名出不出"多了一道**用户开关** ✓
 *    量名字那一段得分**两种状态**各量一遍（关着 = 新默认值 ✓ 打开 = 看 NAME_POLICY ✓）
 *    ⚠ 开关必须在**这个循环里面**设 ✗ —— `drawLabels` 是它逐层调的 ✓
 *      在外面设一次是没用的 ✓（我第一版就这么写的 → 两条假红 ✓）
 *  ⚠ 用的是**应用现成的两个旗**（`showWaterName` / `showWasteName` ✓）——
 *    别在这儿另建一套"哪一类算水/荒地"的判据 ✗（见 `tallyLabelZones` 那段 ✓）
 *  @param {boolean|object|undefined} opt
 *     · 布尔 = 只设 `showWaterName`（老写法，留着 ✓）
 *     · 对象 = `{ waterName, wasteName }`，谁给了就设谁 ✓
 *     · undefined = 一个都不动 ✓ */
function labelListAllTiers(ex, box, opt) {
  const st = ex.state;
  const asObj = (typeof opt === 'object' && opt !== null) ? opt
    : (opt === undefined ? {} : { waterName: opt });
  st.showLabelsTitle = true;
  st.showLabelsPaint = false;
  st.grain = null;
  const all = [];
  const nt = st.meta.tiers.length;
  const nEra = (st.meta.eraDates && st.meta.eraDates.length) || 0;
  for (let t = nEra; t < nt; t++) {
    st.tier = t;
    /* ← 每层都设一次 ✓（在外面设一次是没用的 ✗）*/
    if (asObj.waterName !== undefined) st.showWaterName = !!asObj.waterName;
    if (asObj.wasteName !== undefined) st.showWasteName = !!asObj.wasteName;
    if (ex.renderer && typeof ex.renderer.setTier === 'function') ex.renderer.setTier(t);
    box.list = null;
    const view = { x: 0, y: 0, w: st.meta.mapWidth, h: st.meta.mapHeight };
    try { ex.drawLabels(view); } catch (e) { /* 某一层抛了不算失败，继续扫 */ }
    for (const p of (box.list || [])) all.push(p);
  }
  return all;
}

/** 最终名单里每一项归哪一类：**看它 tid 指的节点自己的键** ✓（名字会撞车 ✗ 键不会 ✓）*/
/** 把一个地名点归到哪一类（陆 / 海 / 湖 / 河 / 荒地 ✓）
 *
 *  🔴🔴 **2026-10-17 改成「跟应用同源」** ✗✗ ——
 *    原来这里用的是**键名子串**（`/^#sea|_sea/` `/^#lake|_lake/` ✓）✗
 *    那正是**应用早就废掉**的判据 ✓（当年 `d_duortnoseatnu` 那块挪威陆地
 *      就因为名字里带 `sea` 被认成海 ✓ 见 `waterKindByPid` 上面那段血泪注释 ✓）
 *    后果（实测）：EU4 的「红海海岸」「普吉特海湾」、EU5 的「五大湖区」
 *      —— 都是**陆地省份**，只是键名带 `_sea` / `_lake` ✓ 被这个助手算成了水 ✓
 *      于是「水域开关关着时水名一条不出」那条**假红**了 ✓（我差点去改应用 ✓）
 *    → 现在调 **应用自己的 `waterKindByPid`** ✓（身份标最权威 → 老包退回 `#` 键 ✓
 *      跟「水域 · 边界」那张纹理、跟「水域 · 名称」那个闸**同一个出处** ✓）
 *    ⚠ tid → zone 得先建一张表 ✗（标签点只有 tid，而认水是按 pid 问的 ✓）
 *      扫一遍最细层就够 ✓（水片在每一层都有自己的 tid ✓ 见 probe_water_allsets ✓）
 */
function tallyLabelZones(ex, list) {
  const K = ex.state.titles.keys || [];
  const meta = ex.state.meta || {};
  const wl = meta.wasteland || [];
  const n = meta.numProvinces | 0;
  /* pid → 类别（跟应用同源 ✓）：海 / 湖 / 河 / 不可通行海域 都算「水」那一侧 ✓ */
  const zoneOfPid = new Map();
  if (typeof ex.waterKindByPid === 'function' && n) {
    for (let q = 1; q < n; q++) {
      const k2 = ex.waterKindByPid(q);
      if (k2) zoneOfPid.set(q, k2 === 4 ? 'river' : (k2 === 3 ? 'lake' : 'sea'));
    }
  }
  const out = { land: 0, sea: 0, lake: 0, river: 0, waste: 0 };
  const sample = { land: [], sea: [], lake: [], river: [], waste: [] };
  for (const p of list) {
    if (!p || !p.name) continue;
    let z = 'land';
    if (p.tid != null && p.tid >= 0) {
      /* 🔴🔴 **跟应用同源：一个 `kindOfTid` 就够** ✗✗（2026-10-17 收口 ✓）
       *   原话（用户）：「既然是如何判别水，那不是还有现成的东西嘛」✓
       *   改之前这儿是**两套拼的**：键正则判荒地 + 一张自己建的 `zoneOfPid` 判水 ✗ ——
       *     于是同一种东西有两个出处 ✓ 迟早打架 ✓
       *   现在：`kindOfTid(tid)`（走 `kindTidMap()` ✓ 扫每一层 + 老包退回键前缀 ✓）
       *     2 海 / 3 湖 / 4 河 / 5 不可通行海域 → 水 ✓
       *     6 不可通行区域 → **荒地** ✓（它跟水不重叠 ✓ 一条判据分得清 ✓）
       *   ⚠ 「键先说」那条口径在应用那边有（CK3 那 2 块"键写着 lake、身份标写着 6"✓）——
       *     这里**不必**照抄 ✗：这条断言量的是"名字有没有画出来"✓
       *     那 2 块的归类差异不影响它 ✓（少一处会漂的判据更值 ✓）*/
      /* 🔴 **先认点自带的那两个标记** ✗✗（2026-10-17 补 ✓）
       *   水域 / 荒地那批点从 `buildSeaLabelPoints` 来 ✓ 自带 `sea` / `waste` ✓
       *   ⚠ **不能只按 `tid` 判** ✗：荒地分组 2026-10-17 改成"按地点
       *     （最细层头衔）"之后，那些点的 `tid` 是**细层的荒地头衔** ✓
       *     实测 EU5 上那一路把它算成了 land → 荒地名 6944 掉到 0 ✓（**假红** ✓）
       *   点自带的标记最权威 ✓ 先认它 ✓ */
      if (p.waste) z = 'waste';
      else if (p.sea) z = 'sea';
      else {
      const _kd = ex.kindOfTid(p.tid);
      if (_kd === 6) z = 'waste';
      else if (_kd === 2 || _kd === 5) z = 'sea';
      else if (_kd === 3) z = 'lake';
      else if (_kd === 4) z = 'river';
      else if (/^wl_|^#wasteland/.test(String(K[p.tid] || '')) || wl.indexOf(p.tid) >= 0) z = 'waste';
      else z = 'land';
      }
    } else {
      /* 无 tid = `buildSeaLabelPoints` 聚出来的水名 / 荒地名点 ✓（它自己带标记 ✓）*/
      z = p.sea ? 'sea' : 'land';
      if (p.waste) z = 'waste';
    }
    out[z]++;
    if (sample[z].length < 3) sample[z].push(String(p.name));
  }
  return { tally: out, sample };
}

/** 左侧栏那个方块（`#hover-chain` 里那口 `<p class="empty">`）——
 *  用户 2026-10-16 第三次拍的两条：
 *    ① 方块**左上角的小字**（`#hover-pid`）= 所指地块的**最低级别号码**（光秃秃的数字 ✓）
 *    ② 方块**第二行** = 这一格"是什么"的称呼（海洋 / 湖泊 / 河流 / 不可通行区域 那种 ✓）
 *       —— 陆地不给 ✗；EU4/EU5 的海域不给（那边走层级链 ✓）
 *  ⚠ 桩的 `innerHTML` 读不到 append 的子节点 ✗ → 递归抠 `_html`（见 `sidebarShape` ✓）
 *  返回 `{ rows, a, b, pidText, isCompact }`
 */
function sidebarBlock(env) {
  const box = env.get('hover-chain');
  const sh = sidebarShape(env);
  const bolds = [...sh.html.matchAll(/<b[^>]*>([\s\S]*?)<\/b>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, '').trim());
  return {
    rows: sh.rows,
    a: bolds[0] || '',
    b: bolds[1] || '',
    pidText: String(env.get('hover-pid').textContent || ''),
    isCompact: /^\s*<p class="empty"/.test(sh.html),
    boxHtml: sh.html,
  };
}

/** 把 `hover-chain` 刷成"悬停在这一格上"的稳定状态 —— 直接调 `renderHoverCard` ✓
 *  ⚠ 别只靠 mousemove ✗ —— 上一句 `setTier` 刚跑完，卡可能还停在别的一格 ✓ */
function renderSide(ex, env, pid) {
  ex.state.hover.pid = pid;
  ex.state.hover.tids = Array.from({ length: ex.state.meta.tiers.length },
    (_, i) => ex.titleAt(pid, i));
  try { ex.renderHoverCard(pid); } catch (e) { /* 抛了就让断言自己报空 ✓ */ }
  return sidebarBlock(env);
}

function parts(html) {
  const t = /<div class="hc-title">([\s\S]*?)<\/div>/.exec(html || '');
  const s = /<div class="hc-sub">([\s\S]*?)<\/div>/.exec(html || '');
  const strip = (x) => String(x || '').replace(/<[^>]*>/g, '').trim();
  return { a: strip(t && t[1]), b: strip(s && s[1]) };
}

const isId = (s) => /^#/.test(String(s)) || /^#?u?\d+$/i.test(String(s));

/** 一类挑一个代表地块
 *  ⚠ **别写死 pid** ✗ —— 2026-10-16 CK2 重分河/湖之后，以前那几个（997 奥涅加湖
 *    那种）从"河"变成了"湖" ✓ 写死就假红 ✓ 一律按 `kindMask` 现挑 ✓ */
function pick(ex) {
  const M = ex.state.meta, T = ex.state.titles, ids = ex.state.provinceIds;
  const km = ex.state.kindMask, wm = ex.state.waterMask;
  const nt = M.tiers.length;
  const keyAt = (p, t) => { const i = ex.titleAt(p, t); return (i == null || i < 0) ? '' : String(T.keys[i] || ''); };
  const nameAt = (p, t) => { const i = ex.titleAt(p, t); return (i == null || i < 0) ? '' : String(T.names[i] || ''); };
  const kindOf = (p) => {
    if (km && km[p]) return km[p];
    for (let t = nt - 1; t >= 0; t--) {
      const k = keyAt(p, t);
      if (!k) continue;
      if (k.indexOf('#impassable_sea') === 0) return 5;
      if (k.indexOf('#impassable') === 0) return 6;
      if (k.indexOf('#river') === 0) return 4;
      if (k.indexOf('#lake') === 0) return 3;
      if (k.indexOf('#sea') === 0) return 2;
      break;
    }
    return 1;
  };
  const out = {};
  const seen = new Set();
  for (let i = 0; i < ids.length && Object.keys(out).length < 7; i++) {
    const p = ids[i];
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const k = kindOf(p);
    const fineKey = keyAt(p, nt - 1);
    let g = null;
    if (/^wl_/.test(fineKey) || /^#wasteland/.test(fineKey)) g = 'waste';
    else if (k === 4) g = 'river';
    else if (k === 3) g = 'lake';
    else if (k === 2) g = 'sea';
    else if (k === 5) g = 'isea';
    if (g && !out[g]) out[g] = p;
  }
  /* EU5 那群荒地没有 wl_ 前缀（序号在真头衔里）→ 用名单反查 ✓ */
  if (!out.waste && (M.wasteland || []).length && (wm || km)) {
    const set = new Set(M.wasteland);
    for (let i = 0; i < ids.length; i++) {
      const p = ids[i];
      if (!p || (wm && wm[p])) continue;
      let hit = false;
      for (let t = nt - 1; t >= 0 && !hit; t--) {
        const tid = ex.titleAt(p, t);
        if (tid >= 0 && set.has(tid)) hit = true;
      }
      if (hit) { out.waste = p; break; }
    }
  }
  /* 陆地：最细层有中文真名的**
   * ⚠ 排掉 `wl_` / 水（那是别类 ✓）*/
  for (let i = 0; i < ids.length && !out.land; i++) {
    const p = ids[i];
    if (!p) continue;
    const fineKey = keyAt(p, nt - 1);
    if (/^wl_/.test(fineKey) || kindOf(p) >= 2) continue;
    const nm = nameAt(p, nt - 1);
    if (nm && !isId(nm) && /[\u4e00-\u9fa5]/.test(nm)) out.land = p;
  }
  return out;
}

(async () => {
  for (const m of MAPS) {
    if (ONLY && ONLY !== m.id) continue;
    console.log(`\n=========== ${m.id} ===========`);
    const { ex, env } = await bootMap(m);
    const M = ex.state.meta;
    if (String(M.game) !== m.game) { ok(`${m.id}：载入的是这套地图`, false, `实际 ${M.game}`); continue; }
    const nt = M.tiers.length;
    const fineTier = nt - 1;
    const p = pick(ex);
    console.log(`  （${M.tierNames.join('/')} · 代表地块 ${JSON.stringify(p)}）`);
    const at = (pid, t) => { ex.setTier(t); ex.setGrain(null); return parts(hover(ex, env, pid)); };

    /* ① 荒地 */
    if (p.waste) {
      const q = at(p.waste, fineTier);
      console.log(`    荒地：${JSON.stringify(q)}`);
      if (m.game === 'ck3') {
        ok('荒地 · CK3：第一行「不可通行区域」', q.a === '不可通行区域', q.a);
        ok('荒地 · CK3：第二行无', q.b === '', q.b);
      } else if (['ck2', 'eu4', 'eu5'].includes(m.game)) {
        ok(`荒地 · ${m.id}：第一行是它的名字`, !!q.a && !q.a.startsWith('#')
          && q.a !== '不可通行区域' && q.a !== '不可通行', q.a);
        ok(`荒地 · ${m.id}：第二行无`, q.b === '', q.b);
      } else {
        ok(`荒地 · ${m.id}：无此设定 → 按陆地（第一行有名字）`, !!q.a && !q.a.startsWith('#'), q.a);
      }
    }

    /* ② 河流 */
    if (p.river) {
      const q = at(p.river, fineTier);
      console.log(`    河流：${JSON.stringify(q)}`);
      if (m.game === 'ck2') {
        /* 🔴 第二轮更变：**CK2 的河显示它的名字** ✓（跟它的湖一个待遇 ✓）*/
        ok('河流 · CK2：第一行是它的名字', !!q.a && !isId(q.a) && q.a !== '河流', q.a);
        ok('河流 · CK2：第二行无', q.b === '', q.b);
      } else if (m.game === 'ck3') {
        ok('河流 · CK3：第一行「河流」', q.a === '河流', q.a);
        ok('河流 · CK3：第二行无', q.b === '', q.b);
      } else {
        ok(`河流 · ${m.id}：无此设定（按水域办，不出编号）`, !!q.a && !isId(q.a), q.a);
      }
    }

    /* ③ 湖泊 */
    if (p.lake) {
      const q = at(p.lake, fineTier);
      console.log(`    湖泊：${JSON.stringify(q)}`);
      if (m.game === 'ck2' || m.game === 'eu4' || m.game === 'eu5') {
        /* 🔴 第二轮更变：**CK2 的湖也显示名字** ✓（EU4 / EU5 本来就有 ✓）*/
        ok(`湖泊 · ${m.id}：第一行是它的名字`, !!q.a && !isId(q.a) && q.a !== '湖泊', q.a);
        ok(`湖泊 · ${m.id}：第二行无`, q.b === '', q.b);
      } else {
        ok(`湖泊 · ${m.id}：第一行「湖泊」`, q.a === '湖泊', q.a);
        ok(`湖泊 · ${m.id}：第二行无`, q.b === '', q.b);
      }
    }

    /* ④′ 不可通行**海域**（CK3 的 `#impassable_sea`）：
     *     它跟"不可通行区域"是**两回事**（码 5 vs 码 6 ✓）——
     *     两行必须都是「不可通行海域」✓ 别一边区域一边海域 ✗（2026-10-16 用户抓到过 ✓）*/
    if (p.isea) {
      const q = at(p.isea, fineTier);
      console.log(`    不可通行海域：${JSON.stringify(q)}`);
      ok('不可通行海域 · CK3：第一行「不可通行海域」', q.a === '不可通行海域', q.a);
      ok('不可通行海域 · CK3：两行不打架（第二行空或同词）',
        q.b === '' || q.b === q.a, q.b);
    }

    /* ④ 水域 */
    if (p.sea) {
      const q = at(p.sea, fineTier);
      console.log(`    水域：${JSON.stringify(q)}`);
      ok(`水域 · ${m.id}：第一行不空、不带编号`, !!q.a && !isId(q.a), q.a);
      if (m.game === 'ck3') {
        ok('水域 · CK3：第一行「海洋」', q.a === '海洋', q.a);
        ok('水域 · CK3：第二行无', q.b === '', q.b);
      } else if (m.game === 'ck2' || m.game === 'vic3') {
        ok(`水域 · ${m.id}：第一行是最低单位的名字`, q.a !== '海洋', q.a);
        ok(`水域 · ${m.id}：第二行无`, q.b === '', q.b);
      } else if (m.game === 'hoi4') {
        ok('水域 · HOI4：第一行是所属战略区的名字', !!q.a && q.a !== '海洋', q.a);
        ok('水域 · HOI4：第二行无', q.b === '', q.b);
      } else {
        const rows = [];
        for (let t = 0; t < nt; t++) rows.push(at(p.sea, t));
        console.log(`     逐层：${rows.map((r) => r.a + (r.b ? '/' + r.b : '')).join('  ')}`);
        ok(`水域 · ${m.id}：换层时第一行跟着层级变`,
          new Set(rows.map((r) => r.a)).size >= 2, [...new Set(rows.map((r) => r.a))].join(' / '));
        ok(`水域 · ${m.id}：粗层给出最低单位的名字`,
          rows.some((r) => r.b === rows[fineTier].a), rows.map((r) => r.b).join(' / '));
        ok(`水域 · ${m.id}：最细层不重复（第一行就是最低单位）`,
          rows[fineTier].b === '', rows[fineTier].b);
      }
    }

    /* ⑤ 左侧栏（用户 2026-10-16 的方案）
     *    荒地 / 湖泊 / 河流：照旧（紧凑那条）· EU4/EU5 之外的海域：照旧
     *    **EU4/EU5 的海域：和陆地一样显示其层级**（层级链）*/
    if (p.sea) {
      at(p.sea, fineTier);                          // 先把侧栏刷成这一格
      const sb = sidebarShape(env);
      console.log(`    侧栏（水域）：${sb.rows} 行 ${JSON.stringify(sb.names)}`);
      if (m.game === 'eu4' || m.game === 'eu5') {
        ok(`侧栏 · ${m.id} 海域：列出层级链`, sb.rows >= 2, `${sb.rows} 行`);
        ok(`侧栏 · ${m.id} 海域：链上是这一格各层的名字`,
          sb.names.filter(Boolean).length >= 1 && sb.names.every((n) => !n.startsWith('#')),
          sb.names.join(' / '));
      } else {
        ok(`侧栏 · ${m.id} 海域：照旧走紧凑那条`, sb.rows <= 1,
          `${sb.rows} 行 · ${sb.names.join(' / ')}`);
      }
    }
    for (const [label, pid] of [['湖泊', p.lake], ['荒地', p.waste], ['河流', p.river]]) {
      if (!pid) continue;
      at(pid, fineTier);
      const sb = sidebarShape(env);
      ok(`侧栏 · ${m.id} ${label}：照旧走紧凑那条`, sb.rows <= 1,
        `${sb.rows} 行 · ${sb.names.join(' / ')}`);
    }

    /* ⑥ 左侧栏那个方块的两条（用户 2026-10-16 第三次拍 ✓）
     *    ① 左上角小字 = 最低级别号码   ② 第二行 = 这一格"是什么"的称呼 */
    {
      const CAT = { 2: '海洋', 3: '湖泊', 4: '河流', 5: '不可通行海域', 6: '不可通行区域' };
      const kindOfPid = (pid) => {
        const km = ex.state.kindMask;
        if (km && km[pid]) return km[pid];
        const nt = M.tiers.length;
        for (let t = nt - 1; t >= 0; t--) {
          const i = ex.titleAt(pid, t);
          if (i == null || i < 0) continue;
          const k = String((ex.state.titles.keys || [])[i] || '');
          if (k.indexOf('#impassable_sea') === 0) return 5;
          if (k.indexOf('#impassable') === 0) return 6;
          if (k.indexOf('#river') === 0) return 4;
          if (k.indexOf('#lake') === 0) return 3;
          if (k.indexOf('#sea') === 0) return 2;
          break;
        }
        return 1;
      };
      for (const [label, pid] of [['海域', p.sea], ['湖泊', p.lake], ['河流', p.river], ['荒地', p.waste]]) {
        if (!pid) continue;
        at(pid, fineTier);
        const sb = renderSide(ex, env, pid);
        console.log(`    方块（${label}）：小字=${JSON.stringify(sb.pidText)}`
          + ` 第一行=${JSON.stringify(sb.a)} 第二行=${JSON.stringify(sb.b)}`);
        ok(`方块 · ${m.id} ${label}：小字 = 地块号（永远）`,
          sb.pidText === String(pid), `显示 ${JSON.stringify(sb.pidText)}`);
        /* 陆地走层级链、那块方块的第二行规则不适用 ✓ 这一圈里都是水 / 荒地 ✓
         * EU4/EU5 的海同层级链 ✓ 不给类别称呼 ✓ */
        const isEuSea = (m.game === 'eu4' || m.game === 'eu5') && label === '海域';
        if (isEuSea) {
          ok(`方块 · ${m.id} ${label}：走层级链（不套类别称呼）`,
            sb.rows >= 2 && !/^(海洋|湖泊|河流|不可通行海域|不可通行区域)$/.test(sb.b),
            `${sb.rows} 行 · 第二行 ${JSON.stringify(sb.b)}`);
          continue;
        }
        const want = CAT[kindOfPid(pid)] || (label === '荒地' ? '不可通行区域' : '');
        ok(`方块 · ${m.id} ${label}：第二行 = 称呼「${want}」`, sb.b === want,
          `显示 ${JSON.stringify(sb.b)}`);
      }
      /* 陆地：小字照样是号码 ✓（第二行归层级链那套 ✓ 不在这儿验 ✓）*/
      if (p.land) {
        const sb = renderSide(ex, env, p.land);
        ok(`方块 · ${m.id} 陆地：小字 = 地块号`, sb.pidText === String(p.land),
          `显示 ${JSON.stringify(sb.pidText)}`);
      }
    }

    /* ⑧ 填色那道锁（用户 2026-10-16 最后一条 ✓）
     *    **河流 / 海洋 / 不可通行海域 / 湖泊 —— 禁止上色**
     *    其余照旧能涂（陆地 ✓ 大陆荒地"不可通行区域" ✓）
     * ⚠ 只验**判据**（`isLocked` ✓ 光标和 `actAt` 都看它 ✓）——
     *   真点一下要求"找到这一格的一个真像素"，分块/散块那张图不一定找得到 ✗
     *   （那部分在 `_local/probe_lock.js` 里按坐标表试 ✓）*/
    {
      const LOCK = { 1: false, 2: true, 3: true, 4: true, 5: true, 6: false };
      const kindOfPid2 = (pid) => {
        const km = ex.state.kindMask;
        if (km && km[pid]) return km[pid];
        const nt = M.tiers.length;
        for (let t = nt - 1; t >= 0; t--) {
          const i = ex.titleAt(pid, t);
          if (i == null || i < 0) continue;
          const k = String((ex.state.titles.keys || [])[i] || '');
          if (k.indexOf('#impassable_sea') === 0) return 5;
          if (k.indexOf('#impassable') === 0) return 6;
          if (k.indexOf('#river') === 0) return 4;
          if (k.indexOf('#lake') === 0) return 3;
          if (k.indexOf('#sea') === 0) return 2;
          break;
        }
        return 1;
      };
      const ZN = { 1: '陆地', 2: '海洋', 3: '湖泊', 4: '河流', 5: '不可通行海域', 6: '不可通行区域' };
      /* 键是 `sea` / `lake` / `river` / `isea` / `waste` / `land` ✓（见 pick ✓）
       * ⚠ 别按 `k<数字>` 那套去解 ✗ —— 那是 `_local/probe_lock.js` 的取名习惯 ✓
       *   （两边不一致我栽过一次：`g.slice(1)` 出来是 `ea` ✓）*/
      const ZONE_KIND = { sea: 2, lake: 3, river: 4, isea: 5, waste: 6, land: 1 };
      for (const [g, pid] of Object.entries(p)) {
        if (!pid) continue;
        const k = ZONE_KIND[g] || 1;
        const want = (LOCK[k] === true);
        const label = ZN[k] || g;
        ex.state.hover.pid = pid;
        ex.state.hover.tids = Array.from({ length: M.tiers.length }, (_, i) => ex.titleAt(pid, i));
        const locked = ex.isLocked(ex.titleAt(pid, fineTier), pid);
        ok(`填色锁 · ${m.id} ${label}：锁=${want}`, locked === want, `实际 ${locked}`);
      }
      const water = p.k2 || p.k3 || p.k4 || p.k5;
      if (water) {
        ex.state.tool = 'paint';
        ex.updateCursor(ex.titleAt(water, fineTier), water);
        ok(`填色锁 · ${m.id}：水面上光标是禁止符`,
          env.get('map').style.cursor === 'not-allowed', env.get('map').style.cursor);
      }
      if (p.k1) {
        ex.state.tool = 'paint';
        ex.updateCursor(ex.titleAt(p.k1, fineTier), p.k1);
        ok(`填色锁 · ${m.id}：陆地上光标是十字`,
          env.get('map').style.cursor === 'crosshair', env.get('map').style.cursor);
      }
      void kindOfPid2;
    }

    /* ⑨ 右键取色拿到的**标记名**（用户 2026-10-16 的三条 ✓）
     *    ① CK3 的水 / 荒地 → **不给标记**（不许 `#10228`）
     *    ② EU4/EU5/CK2 之外的湖 → **不给标记**
     *    ③ HOI4 的水 → **战略区名**（白令海那种）
     *   走真路：`pickTitle` → 左边那块标记（`#brush-label`）✓ */
    {
      const mkOf = (pid) => {
        ex.state.tier = fineTier;
        ex.state.grain = null;
        ex.state.hover.pid = pid;
        ex.state.hover.tids = Array.from({ length: M.tiers.length }, (_, i) => ex.titleAt(pid, i));
        try { ex.pickTitle(ex.titleAt(pid, fineTier), false, pid); } catch (e) { return 'err:' + e; }
        return String(env.get('brush-label').value || '');
      };
      for (const [label, pid] of [['海域', p.sea], ['湖泊', p.lake], ['河流', p.river],
                                  ['荒地', p.waste], ['陆地', p.land]]) {
        if (!pid) continue;
        const mk = mkOf(pid);
        console.log(`    右键标记（${label}）=${JSON.stringify(mk)}`);
        /* 通用：**任何情况都不许拿 `#<数字>` 当标记** ✓ */
        ok(`右键 · ${m.id} ${label}：标记里没有编号`, !/^#/.test(mk) && !/^#?u?\d+$/.test(mk),
          JSON.stringify(mk));
        if (label === '陆地') continue;                     // 陆地照旧走原路 ✓
        const isLake = (label === '湖泊');
        if (m.game === 'ck3') {
          ok(`右键 · ${m.id} ${label}：不给标记`, mk === '', JSON.stringify(mk));
        } else if (m.game === 'hoi4') {
          ok(`右键 · ${m.id} ${label}：给战略区名`, !!mk && !/^#/.test(mk), JSON.stringify(mk));
        } else if (isLake && !(m.game === 'eu4' || m.game === 'eu5' || m.game === 'ck2')) {
          ok(`右键 · ${m.id} ${label}：不给标记`, mk === '', JSON.stringify(mk));
        }
      }
    }

    /* ⑦ 地图上的名字（用户 2026-10-16 的方案 ✓ 跟悬停那套分开 ✓）
     *
     *  🔴🔴 **2026-10-17：这一段要先把「水域 · 名称」打开再量** ✗✗
     *    这一段的判据是 `NAME_POLICY`（哪一代该出哪类名 ✓）——
     *    **它不知道还有"水域 · 名称"那个开关** ✗
     *    而用户 2026-10-17 把那个开关的**默认值改成了关闭** ✓
     *    → 水名一个都不出 → sea / lake / river 那三条全红 ✗（CK2 的 lake / river 也一起红 ✓）
     *    ⚠ 这不是 NAME_POLICY 变了 ✗ 是**多了一道用户开关** ✓
     *    → 所以这里显式打开它，量"**开关打开时，NAME_POLICY 说的那几类出不出**" ✓
     *      另加一条：**关着的时候一条水名都不许有** ✓（那才是新默认值该有的样子 ✓）
     *    ⚠ 荒地那一档没有开关（用户只点名了水域 ✓）→ 照旧直接量 ✓ */
    {
      const _st = ex.state || {};
      const _keepWN = _st.showWaterName;
      /* ① **关着**（= 新默认值）→ 水那三类一条都不许有 ✓
       *   ⚠ 开关交给 `labelListAllTiers` 在**每层**设 ✓（在外面设一次没用 ✗）*/
      const _offRes = (() => {
        const b = watchLabelList(ex);
        const l = labelListAllTiers(ex, b, { waterName: false, wasteName: false });
        return { list: l, z: tallyLabelZones(ex, l) };
      })();
      const _off = _offRes.z;
      const _tOff = _off.tally;
      const _waterOff = _tOff.sea + _tOff.lake + _tOff.river;
      ok(`名字 · ${m.id}：「水域 · 名称」**关着**时水名一条都不出（新默认值 ✓）`,
         _waterOff === 0, `海域 ${_tOff.sea} · 湖泊 ${_tOff.lake} · 河流 ${_tOff.river}`);

      /* ② **打开** → 按 NAME_POLICY 量 ✓ */
      const box = watchLabelList(ex);
      const list = labelListAllTiers(ex, box, { waterName: true, wasteName: true });
      const { tally, sample } = tallyLabelZones(ex, list);
      const ZN = { sea: '海域', lake: '湖泊', river: '河流', waste: '不可通行区域' };
      console.log(`    地图名字（水域开关打开）：${list.length} 项 · ` + Object.entries(tally)
        .map(([z, n]) => `${z}${n}`).join(' '));
      ok(`名字 · ${m.id}：陆地名字照旧能画出来`, tally.land > 0, `${tally.land} 项`);
      for (const z of ['sea', 'lake', 'river', 'waste']) {
        if (NAME_POLICY[z][m.game]) {
          ok(`名字 · ${ZN[z]}：${m.id} 应当显示`, tally[z] > 0, `${tally[z]} 项`);
        } else {
          ok(`名字 · ${ZN[z]}：${m.id} 不应显示`, tally[z] === 0,
            `却入了 ${tally[z]} 项（例：${sample[z].join(' / ')}）`);
        }
      }
      _st.showWaterName = _keepWN;          // 还回去 ✓
    }

    /* ⑥ 陆地 */
    if (p.land) {
      const rows = [];
      for (let t = 0; t < nt; t++) rows.push(at(p.land, t));
      console.log(`    陆地：${rows.map((r) => r.a + (r.b ? '/' + r.b : '')).join('  ')}`);
      ok(`陆地 · ${m.id}：第一行一律不空、不带编号`,
        rows.every((r) => r.a && !isId(r.a)), rows.map((r) => r.a).join(' / '));
      ok(`陆地 · ${m.id}：第二行不带编号`, rows.every((r) => !r.b || !isId(r.b)),
        rows.map((r) => r.b).filter(Boolean).join(' / ') || '（都没给）');
      ok(`陆地 · ${m.id}：第二行从不等于第一行（同词不重复）`,
        rows.every((r) => !r.b || r.b !== r.a), rows.map((r) => r.a + '|' + r.b).join('  '));
      if (m.game === 'ck3' || m.game === 'ck2') {
        ok(`陆地 · ${m.id}：至少一层给出更低层级的信息`,
          rows.some((r) => !!r.b), rows.map((r) => r.b).filter(Boolean).join(' / ') || '（一层都没有 ✗）');
      }
    }
  }

  console.log('\n==========================================================');
  console.log(fails.length ? `失败 ${fails.length} 条：\n  - ${fails.join('\n  - ')}` : '✔ 悬停规格表全过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
