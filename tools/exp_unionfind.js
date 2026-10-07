/**
 * 忠实复刻对照：`rebuildPaintBlocks(all=false)` 里，
 * "并查集那一遍的身份查找"改了以后到底省多少。
 *
 *   node tools/exp_unionfind.js VIC3
 *   node tools/exp_unionfind.js EU5
 *
 * 为什么专门写一个：exp_whatif.js 里我先摆过一个人造对照组，量出"慢 97 倍" ——
 * 那是我自己的对照组没做路径压缩，不是真代码的问题（见那边的注释）。
 * 这次两份实现都**照抄真代码**（同样的 find、同样的 union、同样的遍历顺序），
 * 只差"身份从哪儿取"这一件事：
 *
 *   旧：paintKeyOf(pid) 每格都算一次（displayedLabel + stableColor + 拼串）
 *   新：没涂过的地一眼跳过，涂过的才靠 Map 缓存算一次
 */
'use strict';
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'VIC3').toUpperCase();
const CARD = WHICH === 'VIC3' ? 'V3 原版' : WHICH === 'EU5' ? 'EU5 原版' : `${WHICH} 原版`;

function bench(name, fn, iters = 7) {
  fn(); fn();
  const t = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  t.sort((a, b) => a - b);
  const mid = t[Math.floor(t.length / 2)];
  console.log(`  ${name.padEnd(40)} ${mid.toFixed(2).padStart(8)} ms`);
  return mid;
}

(async () => {
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(), env);
  const b = ex.boot();
  for (let i = 0; i < 4000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  (env.get('map-pick-list').children.find((x) => x.flat().includes(CARD))
    || env.get('map-pick-list').children[0]).onclick();
  await b;

  const st = ex.state;
  const n = st.meta.numProvinces;
  const adj = st.adjacency;
  const pd = ex.renderer.paintData;
  const et = ex.editTier();
  const tm = st.titlemap;
  const labels = st.provLabel;
  const fine = st.meta.tierNames.length - 1;

  // 涂 400 块（跟 bench_core 一样的涂法，两边比的是同一件事）
  let painted = 0;
  for (let q = 1; q < n && painted < 400; q += 7) {
    const t = tm[fine * n + q];
    if (t == null || t === 65535) continue;
    ex.paintAt(q, t); painted++;
  }
  console.log(`\n########## ${CARD} · ${n} 地块 · 涂了 ${painted} 块 ##########`);

  const offsets = new Uint32Array(adj.buffer, adj.byteOffset, n + 1);
  const neighbors = new Uint16Array(adj.buffer, adj.byteOffset + (n + 1) * 4);

  /** 跟真代码一字不差的 find（含路径压缩） */
  const makeFind = (parent) => (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const p = parent[x]; parent[x] = r; x = p; }
    return r;
  };

  const paintKeyOf = (q) => {
    const t0 = tm[et * n + q];
    const nm = String(ex.displayedLabel(q, t0) || '');
    const c = ex.stableColor(q, t0) || [150, 150, 150];
    return 'D|' + c[0] + ',' + c[1] + ',' + c[2] + '|' + nm;
  };
  const NO_IDENT = '\u0000';

  // 旧：照抄改造前那一遍（只有 identOfPid 走 Map 缓存，其余原样）
  const oldPass = () => {
    const parent = new Int32Array(n);
    for (let q = 1; q < n; q++) parent[q] = q;
    const find = makeFind(parent);
    const cache = new Map();
    const identOfPid = (q) => {
      let v = cache.get(q);
      if (v === undefined) { v = paintKeyOf(q); cache.set(q, v); }
      return v;
    };
    for (let pid = 1; pid < n; pid++) {
      for (let k = offsets[pid], e = offsets[pid + 1]; k < e; k++) {
        const nb = neighbors[k];
        if (nb <= 0) continue;
        if (identOfPid(nb) !== identOfPid(pid)) continue;
        const ra = find(pid), rb = find(nb);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    return parent;
  };
  // 新：照抄现在的实现
  const newPass = () => {
    const parent = new Int32Array(n);
    for (let q = 1; q < n; q++) parent[q] = q;
    const find = makeFind(parent);
    const isPainted = new Uint8Array(n);
    for (let q = 1; q < n; q++) if (pd[q * 4 + 3] > 0) isPainted[q] = 1;
    const cache = new Map();
    const identOfPid = (q) => {
      if (!isPainted[q]) return NO_IDENT;
      let v = cache.get(q);
      if (v === undefined) { v = paintKeyOf(q); cache.set(q, v); }
      return v;
    };
    for (let pid = 1; pid < n; pid++) {
      const _ownPidIdent = identOfPid(pid);
      for (let k = offsets[pid], e = offsets[pid + 1]; k < e; k++) {
        const nb = neighbors[k];
        if (nb <= 0) continue;
        if (identOfPid(nb) !== _ownPidIdent) continue;
        const ra = find(pid), rb = find(nb);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    return parent;
  };

  // 结果一致性：**按"最终留下的组"比**，而且必须把 keepRoot 那一步算进来 ✓
  //
  // ⚠ 这里我踩过一次，写清楚免得下次又绕：
  //   细层（all=false）下，旧写法会为**每个没涂过的地**各建一个组
  //   （因为每格都算了真身份，未涂过的地身份各不相同）→ 一万多个碎组 ✗
  //   新写法让未涂过的地共享哨兵身份 → 它们并成一大片、只算一个组 ✓
  //   **但真代码随后用 keepRoot 把"不含任何涂过地块的组"全丢掉了** ——
  //   所以两种写法的**输出**一样，差别只在"扔掉多少垃圾"。
  //   比较时漏掉 keepRoot 就会看到"1371 组 vs 390 组"，那是比错了东西 ✗
  {
    const p1 = oldPass(), p2 = newPass();
    const f1 = makeFind(p1), f2 = makeFind(p2);
    // keepRoot：只有"含涂过地块"的那些根才留下（跟 rebuildPaintBlocks 里一致）
    const keepOf = (f) => {
      const keep = new Set();
      for (let q = 1; q < n; q++) if (pd[q * 4 + 3] > 0) keep.add(f(q));
      return keep;
    };
    const groupsOf = (f, keep) => {
      const m = new Map();
      for (let q = 1; q < n; q++) {
        const k = f(q);
        if (!keep.has(k)) continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(q);
      }
      // 每组排成有序列表，再按列表本身排序 → 与代表元编号无关的规范形式
      return [...m.values()].map((g) => g.join(',')).sort();
    };
    const k1 = keepOf(f1), k2 = keepOf(f2);
    const g1 = groupsOf(f1, k1), g2 = groupsOf(f2, k2);
    let same = g1.length === g2.length;
    if (same) for (let i = 0; i < g1.length; i++) if (g1[i] !== g2[i]) { same = false; break; }
    console.log(`  ★ 最终输出（套上 keepRoot 之后）：${same ? '完全一致 ✓' : '有差异 ✗'}  `
      + `（旧 ${g1.length} 组 / 新 ${g2.length} 组）`);
    if (!same) {
      for (let i = 0; i < Math.max(g1.length, g2.length); i++) {
        if (g1[i] !== g2[i]) {
          console.log(`     第一处不同：旧[${i}] ${String(g1[i]).slice(0, 60)}…`);
          console.log(`                 新[${i}] ${String(g2[i]).slice(0, 60)}…`);
          break;
        }
      }
    }
  }

  // 分组之前：两条路的**身份集合**必须一模一样（这是纯函数，没有任何并查集影响）
  {
    const ids = (paintedOnly) => {
      const s = new Set();
      for (let q = 1; q < n; q++) {
        if (paintedOnly && !(pd[q * 4 + 3] > 0)) continue;
        s.add(paintKeyOf(q));
      }
      return s;
    };
    const iAll = ids(false), iPaint = ids(true);
    console.log(`  身份集合：全图 ${iAll.size} 种 · 只涂过的 ${iPaint.size} 种`);
    console.log(`  ✔ 涂过的身份全都落在全图那套里：`
      + `${[...iPaint].every((v) => iAll.has(v))}`);
  }

  const o = bench('旧：每格 paintKeyOf + Map 缓存', oldPass);
  const m = bench('新：没涂过一眼跳过 + Map 缓存', newPass);
  console.log(`\n  → 并查集这一遍省 ${(o - m).toFixed(2)} ms  （${((o - m) / o * 100).toFixed(0)}%）`);
  process.exit(0);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
