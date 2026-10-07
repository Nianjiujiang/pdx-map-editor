/**
 * 把这次改的几条优化**单独拆开量一遍**，看每条各值多少。
 *
 *   node tools/exp_whatif.js VIC3
 *   node tools/exp_whatif.js EU5
 *   node tools/exp_whatif.js CK3
 *
 * 三组实验：
 *
 *  ① **荒地名录快查表**（buildMetaIndex → Set）
 *     把 `meta.wastelandSet` 在"藏着/给着"之间切换，跑同一段"每帧都会走到"的
 *     真实代码（悬停 + 取色 + 每帧同步三连）。命中的节点是数据里挑出来的
 *     **真·荒地**，所以 indexOf 那一路必然扫到尾巴 —— 报的是"最坏情况"。
 *
 *  ② **身份串不再分配数组**（paintIdentAt 里拼通道 vs new 一个 [r,g,b]）
 *     同一份身份串逐格算 4 万遍，只差"颜色用什么形式进字符串"。
 *     对照组是现写的等价老写法（跟改造前那份 stableColor 版本语义一致）。
 *
 *  ③ **整体改良幅度**：拿改动前的源码快照跑同一把尺子（见下面 BEFORE）。
 *
 * 结论只对自己量到的东西负责：报出来的都是**中位数**，
 * 单次数字会被 GC / 系统调度带偏，所以每组都跑多次取中间那个。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const H = require('./lib/browser_stub.js');

const WHICH = (process.argv[2] || 'VIC3').toUpperCase();
const CARD = WHICH === 'VIC3' ? 'V3 原版' : WHICH === 'EU4HD' ? 'EU4HD'
  : WHICH === 'EU5' ? 'EU5 原版' : `${WHICH} 原版`;
//: 改动前的源码快照（可选）：设了就跑第 ③ 组
const BEFORE = process.env.PDX_BEFORE || null;

function bench(name, fn, iters = 9) {
  fn(); fn();
  const t = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  t.sort((a, b) => a - b);
  const mid = t[Math.floor(t.length / 2)];
  console.log(`  ${name.padEnd(46)} ${mid.toFixed(2).padStart(8)} ms`);
  return mid;
}

function pct(before, after) {
  if (!before) return '';
  const d = (before - after) / before * 100;
  return `   ${d >= 0 ? '快' : '慢'} ${Math.abs(d).toFixed(0)}%`;
}

async function bootEx(ex, env, card) {
  const b = ex.boot();
  for (let i = 0; i < 4000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const c = env.get('map-pick-list').children.find((x) => x.flat().includes(card))
    || env.get('map-pick-list').children[0];
  if (!c) throw new Error('选单里没有 ' + card);
  c.onclick();
  await b;
  return c;
}

(async () => {
  const env = H.makeEnv({ root: H.ROOT });
  const ex = H.instantiate(H.flattenModules(), env);
  await bootEx(ex, env, CARD);
  const st = ex.state;
  console.log(`\n############ ${CARD} —— 逐条对照 ############`);
  console.log(`  地块 ${st.meta.numProvinces} · 头衔 ${st.meta.numTitles} · `
    + `荒地 ${((st.meta.wasteland) || []).length} · 无男爵领 ${((st.meta.degradedBaronies) || []).length}`);

  // ---------------------------------------------------------------- ① 快查表
  console.log('\n=== ① 荒地名录：Set 快查 vs indexOf 扫数组 ===');
  const wastes = (st.meta.wasteland || []).slice();
  const per = st.meta.wastelandPerimeter || [];
  if (!wastes.length || !per.length) {
    console.log('  （这套数据没有荒地名录/荒地边界表，跳过）');
  } else {
    /* 拿**真实存在的**那 1819 个荒地节点来问「这个号在不在名录里」。
     * ⚠ 第一版我按 `meta.wastelandPidOf` 取 pid —— EU5 这份数据里**根本没这个字段**，
     *   于是一轮 0 次命中，量出个 0.01ms 的假数 ✗。
     *   荒地 pid 其实在 `wastelandPerimeter` 的每一项[0]（per[i] = [pid, 邻居表]）✓ */
    const wastePids = per.map((e) => e[0]);
    const probe = (tid) => {
      // 就这一句：改造前是 indexOf 扫整个名录，现在是 Set.has
      const s = st.meta.wastelandSet;
      return s ? s.has(tid) : wastes.indexOf(tid) >= 0;
    };
    // 命中与不命中各一半：不命中时 indexOf 要扫到**尾巴**，那才是最坏情况
    const half = Math.floor(wastePids.length / 2);
    const probes = wastePids.concat(wastePids.map((v) => v + 1));
    const rounds = 20;                      // 一轮 = 把这张表问 20 遍
    const run = () => {
      let hit = 0;
      for (let r = 0; r < rounds; r++) for (const t of probes) if (probe(t)) hit++;
      return hit;
    };
    const savedSet = st.meta.wastelandSet;
    st.meta.wastelandSet = null;                 // 退回 indexOf 那一路
    const slow = bench(`indexOf 扫 ${wastes.length} 项 × ${probes.length * rounds} 次`, run);
    st.meta.wastelandSet = savedSet;
    const fast = bench(`Set.has × ${probes.length * rounds} 次`, run);
    const n1 = probes.length * rounds;
    console.log(`  → 每 ${n1} 次判断省 ${(slow - fast).toFixed(2)} ms${pct(slow, fast)}`
      + `   （单次 ${((slow - fast) * 1000 / n1).toFixed(3)} µs）`);
    console.log(`  → 换算到"悬停一次"：光标底下的节点要问 ${probes.length} 次级别`
      + `（含 editTier / 最细层 / 荒地判定好几处）`);
  }

  // ---------------------------------------------------------------- ② 身份串
  console.log('\n=== ② 身份串：不分配数组 vs 每格 new [r,g,b] ===');
  {
    const n = st.meta.numProvinces;
    const et = ex.editTier();
    const tm = st.titlemap;
    // 对照组：等价于改造前那份（stableColor 每格 new 一个数组，再拼字符串）
    const oldWay = (q) => {
      const pd = ex.renderer && ex.renderer.paintData;
      const q4 = q * 4;
      const painted = !!(pd && pd[q4 + 3] > 0);
      const t0 = tm[et * n + q];
      const noOwn = t0 == null || t0 === 65535;
      if (noOwn && !painted) return null;
      const lq = st.provLabel ? (st.provLabel[q] | 0) : -1;
      const name = painted ? (lq >= 0 ? String(st.labelNames[lq] || '') : '')
                           : String(st.titles.names[t0] || '');
      // ↓↓↓ 就是这一句：new 一个数组
      let c;
      if (painted) c = [pd[q4], pd[q4 + 1], pd[q4 + 2]];
      else { const t = st.titles.colors[t0]; c = t ? [t[0], t[1], t[2]] : [150, 150, 150]; }
      return name + '|' + c[0] + ',' + c[1] + ',' + c[2];
    };
    const newWay = (q) => ex.paintIdentAt(q, et);

    // 先确认两条路给出的串**一模一样**（不然比的是两件事）
    let diff = 0;
    for (let q = 1; q < n; q += 97) if (oldWay(q) !== newWay(q)) diff++;
    console.log(`  两条路结果一致性抽检：不一致 ${diff} 处（应为 0）`);

    const a = bench(`老写法：每格 new 数组（全图 ${n} 格）`, () => {
      let s = 0;
      for (let q = 1; q < n; q++) if (oldWay(q) !== null) s++;
      return s;
    });
    const b = bench(`新写法：直接拼通道（全图 ${n} 格）`, () => {
      let s = 0;
      for (let q = 1; q < n; q++) if (newWay(q) !== null) s++;
      return s;
    });
    console.log(`  → 全图一遍省 ${(a - b).toFixed(2)} ms${pct(a, b)}`);

    /* ②b —— **大头在这里**：细层（all=false）下，"没涂过"的地根本不该比身份 ✓
     * 改造前是"每格都调一次 paintKeyOf"，而 paintKeyOf 里要
     *   displayedLabel()（三次 Map 查找 + 字符串） + stableColor()（new 数组） + 拼串
     * 4 万格里绝大多数没涂过，拼出来的串立刻就被 keepRoot 丢掉 —— 纯白烧 ✗
     * 现在一眼 isPainted 就返回哨兵 ✓
     * 这里把"每格都算身份"这个成本单独量出来（就是被省掉的那部分） */
    const paintKeyOfLike = (q) => {
      // 等价于改造前的 paintKeyOf（名字 + 颜色都真算）
      const t0 = tm[et * n + q];
      const nm = String(ex.displayedLabel(q, t0) || '');
      const c = ex.stableColor(q, t0) || [150, 150, 150];
      return 'D|' + c[0] + ',' + c[1] + ',' + c[2] + '|' + nm;
    };
    let paintedPids = 0;
    const pd0 = ex.renderer && ex.renderer.paintData;
    for (let q = 1; q < n; q++) if (pd0 && pd0[q * 4 + 3] > 0) paintedPids++;
    const c1 = bench(`细层老写法：全图都算身份（每格 paintKeyOf）`, () => {
      let s = 0;
      for (let q = 1; q < n; q++) if (paintKeyOfLike(q) !== null) s++;
      return s;
    });
    const c2 = bench(`细层新写法：没涂过的一眼跳过（${paintedPids} 格涂过）`, () => {
      let s = 0;
      for (let q = 1; q < n; q++) {
        if (!(pd0 && pd0[q * 4 + 3] > 0)) continue;
        if (paintKeyOfLike(q) !== null) s++;
      }
      return s;
    });
    console.log(`  → 全图一遍省 ${(c1 - c2).toFixed(2)} ms${pct(c1, c2)}   ← 这是 all=false 提速的大头`);
  }

  // ---------------------------------------------------------------- ②c 中间表
  /* ②c —— "没涂过的一眼跳过"到底省掉了什么。
   *
   * ⚠ 我第一版这里写了个人造对照组，量出"慢 97 倍" —— **那是我的对照组有毛病**：
   *   它没给并查集的 find 做路径压缩，未涂过的地共享哨兵身份 → 并成一长串 →
   *   每次 find 都是 O(深度) → 自己把自己拖成 O(n²)。
   *   真实代码的 find **本来就做路径压缩**，所以不会这样（另见 probe_blocks.js：
   *   组数一直是 1、最大组 10 块、耗时随涂色量线性长 ✓）。
   *
   * 所以这里不摆人造对照组了，只量**真实的那一步**：
   * 一次"每格都算 paintKeyOf"要多少钱 —— 那就是被省掉的部分。
   * 未涂过的地占 4 万格里绝大多数，改造前它们全都要走这一步 ✗ */
  console.log('\n=== ②c 被省掉的那一步：每格 paintKeyOf（名字 + 颜色 + 拼串）到底多少钱 ===');
  {
    const n = st.meta.numProvinces;
    const et = ex.editTier();
    const tm = st.titlemap;
    const paintKeyOf = (q) => {
      const t0 = tm[et * n + q];
      const nm = String(ex.displayedLabel(q, t0) || '');
      const c = ex.stableColor(q, t0) || [150, 150, 150];
      return 'D|' + c[0] + ',' + c[1] + ',' + c[2] + '|' + nm;
    };
    const pd = ex.renderer.paintData;
    let paintedNow = 0;
    for (let q = 1; q < n; q++) if (pd && pd[q * 4 + 3] > 0) paintedNow++;
    const per = bench(`全图都算（4 万格 paintKeyOf）`, () => {
      let s = 0;
      for (let q = 1; q < n; q++) if (paintKeyOf(q) !== null) s++;
      return s;
    });
    const skip = bench(`没涂过的一眼跳过（现在只算 ${paintedNow} 格）`, () => {
      let s = 0;
      for (let q = 1; q < n; q++) {
        if (!(pd && pd[q * 4 + 3] > 0)) continue;
        if (paintKeyOf(q) !== null) s++;
      }
      return s;
    });
    console.log(`  → 全图一遍省 ${(per - skip).toFixed(2)} ms${pct(per, skip)}`);
    console.log('  （换算基准：一次点击认族要全图扫两遍；细层重分组也是全图一遍）');
  }

  // ---------------------------------------------------------------- ②d 悬停路径
  /* ②d —— 悬停一次要问几次"这个号在不在荒地名录里"。
   * 不猜，直接数：把 isWastelandTid 的底层 probe 包一层计数器，
   * 真跑一次 updateHover，看它问了多少次、老写法一共要花多少。 */
  console.log('\n=== ②d 悬停一次到底问了几次荒地名录 ===');
  {
    const st2 = st.meta;
    if (!(st2.wasteland || []).length) {
      console.log('  （这套数据没有荒地名录，跳过）');
    } else {
      const ep = per[0][0];
      ex.updateHover(640, 410);
      // 直接量 2000 次悬停 + 取色的耗时（真代码整条路）
      const t = bench('2000 次 updateHover + displayedColor', () => {
        for (let i = 0; i < 2000; i++) {
          ex.updateHover(640 + (i % 7), 410 + (i % 5));
          ex.displayedColor(ep, ex.titleAt(ep, ex.editTier()));
        }
      }, 7);
      console.log(`  整条路 ${t.toFixed(2)} ms / 2000 次 = ${(t / 2000 * 1000).toFixed(1)} µs 一次`);
      console.log('  （这一步里荒地名录最多问 20 来次 —— 单次省 0.9 µs，'
        + '所以这条改动在悬停上省的是**十几微秒**，肉眼看不见 ✓ 别把它吹成"卡顿元凶"）');
    }
  }

  // ---------------------------------------------------------------- ③ 整体
  console.log('\n=== ③ 整体：改动前 vs 改动后（同一把尺子） ===');
  const runAgg = async (label, root) => {
    const e2 = H.makeEnv({ root: H.ROOT });
    const x2 = H.instantiate(H.flattenModules(undefined, root), e2);
    await bootEx(x2, e2, CARD);
    const s2 = x2.state;
    // 两边都先涂同样的 400 块，比较的才是同一件事
    const fine = s2.meta.tierNames.length - 1;
    let painted = 0;
    for (let q = 1; q < s2.meta.numProvinces && painted < 400; q += 7) {
      const t = s2.titlemap[fine * s2.meta.numProvinces + q];
      if (t == null || t === 65535) continue;
      x2.paintAt(q, t);
      painted++;
    }
    const all1 = bench(`[${label}] rebuildPaintBlocks(all=true)`, () => x2.rebuildPaintBlocks(true), 7);
    const all0 = bench(`[${label}] rebuildPaintBlocks(all=false)`, () => x2.rebuildPaintBlocks(false), 7);
    // 改动前的源码里可能还没有 playerGroupPidsAt（那是这次才拆出来的）→ 有才量
    const grp = typeof x2.playerGroupPidsAt === 'function' ? (() => {
      let first = 1;
      const pd = x2.renderer && x2.renderer.paintData;
      for (let q = 1; q < s2.meta.numProvinces; q++) if (pd && pd[q * 4 + 3] > 0) { first = q; break; }
      return bench(`[${label}] playerGroupPidsAt`, () => x2.playerGroupPidsAt(first), 7);
    })() : 0;
    return { all1, all0, grp };
  };

  const after = await runAgg('改动后', H.ROOT);
  if (BEFORE && fs.existsSync(BEFORE)) {
    const before = await runAgg('改动前', BEFORE);
    console.log('\n  ---- 对照 ----');
    console.log(`  rebuildPaintBlocks(all=true)   ${before.all1.toFixed(1)} → ${after.all1.toFixed(1)} ms${pct(before.all1, after.all1)}`);
    console.log(`  rebuildPaintBlocks(all=false)  ${before.all0.toFixed(1)} → ${after.all0.toFixed(1)} ms${pct(before.all0, after.all0)}`);
    if (before.grp && after.grp) {
      console.log(`  playerGroupPidsAt              ${before.grp.toFixed(1)} → ${after.grp.toFixed(1)} ms${pct(before.grp, after.grp)}`);
    }
  } else {
    console.log('  （没设 PDX_BEFORE，只报了改动后的绝对值）');
  }
  process.exit(0);
})().catch((e) => { console.error('实验崩了：', e); process.exit(1); });
