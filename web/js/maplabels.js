/**
 * P社式地图名排版 —— 「国名 / 大地名贴着版图排」的那套算法。
 *
 * 文档在 `桌面/P社国名地图排版原理与实现.md`（从 CK3 / V3 / EU4 的游戏文件里扒出来的）。
 * 一句话结论：**不是把一整条文字渲染成贴图再扭曲** ✗ ——
 *   CPU 先在版图里找一条合适的基线，再**逐字**生成贴着地面的四边形 ✓
 *   弯曲、倾斜、字距拉伸都是"逐字摆放"的结果 ✓
 *
 * 这里落地的顺序（跟文档 §2 那张链路图一一对应）：
 *
 *   ① 版图栅格化     `RealmMaskSource` —— 省份 id 图抽稀成格子，格子上写头衔号；
 *                    再按 4 邻域做连通域（**一个连通域一个名** ✓ 跟编辑器本来那套口径一致 ✓）
 *   ② 候选基线       每个角度 × 每个纵向偏移各来一条线，沿线采样看落没落在版图里
 *   ③ 评分选优       覆盖率 + 最长连续段 + 水平偏好 + 离质心的距离 + **能撑多大字号**
 *   ④ 文字适配       宽度 90% / 高度 60% 两个上限取小的，再乘 0.75（CK3 的 SCALE ✓）
 *   ⑤ 字距拉伸       只加**字与字之间**的间距，最多 1.2 倍（字形本身不横向拉 ✗）
 *   ⑥ 曲线化         逐列取版图的纵向中心 → 平滑 → 每个字按切线转角
 *                    （≤2 个字不弯 ✓ 方版图不强弯 ✓ 跟 CK3 的 SQUARENESS 一个意思 ✓）
 *   ⑦ 逐字四边形     每个字一个"基线中心 + 切线角度 + 字号"，交给 labels.js 画
 *
 * ⚠ **它只算"在哪儿、多大、转多少度"** ✗ —— 一个像素都不画 ✓
 *   画是 labels.js 的事（那边有字形贴图缓存、描边、半透明、悬浮高亮 ✓）
 *   这么分是因为排版结果**跟缩放无关**（缓存得住 ✓ 相机怎么动都不用重算 ✓），
 *   而绘制每一帧都要来一遍 ✓
 *
 * ⚠ **算不出来就返回 null** ✗ —— 调用方退回"老那套：横着写在质心上" ✓
 *   认不出（分块地图没有整张省份图 ✓ / 名字太长塞不进 ✓ / 名字是位图字体 ✓）一律走这条路 ✓
 */

/* ================================================================ 参数
 *
 * 数值来源：CK3 的 `common/defines/graphic/00_graphics.txt`（文档 §4.1 那张表 ✓）
 * V3 的同名参数在 §4.2，差别是 SCALE 0.6 / STRETCH 1.6 / 只测 1 条线 ——
 * 想更像 V3 就把 `scale` 调 0.6、`maxStretch` 调 1.6 ✓
 *
 * ⚠ `numLineTests` / `lineSpacing` 在这儿是**纵向偏移的条数与幅度** ✗ ——
 *   CK3 那两个是"地图像素"（10.0 / 5 条 ✓），可这张图的尺寸从 2048 到 16384 都有 ✓
 *   写死 10 像素在 CK3 原图上等于没偏移 ✓ 所以这里按**版图自己的高度**取比例 ✓
 */
export const MAPNAME_PARAMS = {
  //: 最终缩放（CK3 的 COUNTRY_NAMES_SCALE ✓）
  scale: 0.75,
  //: 可用宽 / 高的上限（CK3 的 SCALE_CAP_WIDTH / HEIGHT ✓）
  capWidth: 0.9,
  capHeight: 0.6,
  /* 🔴 **字号主要跟"线的长短"走**（2026-10-23 用户）
   *   以前 `fs = min(线长×0.9, 厚度×0.6)` —— 细长条（智利、挪威那种）
   *   永远被厚度卡住，线再长字也不大 ✗
   *   现在：先按**线长**给字号，厚度只当"别捅出区外"的上限 ✓
   *   ⚠ 2026-10-23 用户实测"字太大、溢出线条 / 压到邻居上" ✗
   *     上一版这里给 1.15（故意允许溢出 15%）—— 收回到 **0.8**：
   *     字高最多占线宽的八成，四周永远留边，邻居那边压不到 ✓
   *     （想再紧一点往下调；0.6 是 CK3 的 `SCALE_CAP_HEIGHT` 原值 ✓）*/
  thickOverflow: 0.8,
  /* 少字的字号系数（1 / 2 / 3 个字各一档，≥4 字不压 ✓）——
   * 一两字的名字按"填满线长"算会大得离谱（2 字实测占版图对角的 20%），
   * 这里压掉一点点，既还是比多字的字大，又不至于糊满半个国家 ✓ */
  shortNameMul: { 1: 0.72, 2: 0.82, 3: 0.93 },
  /* 🔴 **名字要更贴几何中心**（2026-10-23 用户）
   *   评分里"候选线的中点离这块地质心多远"这一项的权重 ——
   *   以前 0.6，被"能撑多大字号"那项压下去，长条 / 半岛形的版图
   *   常挑到偏在一侧的线（名字贴在边上）✗
   *   加大它：宁可字号小一点，也要摆在中间 ✓ */
  centerPenaltyWeight: 1.2,
  /* **沿基线方向的居中**（2026-10-23 用户："更能贴合几何中心"）
   *   上面那项管"线离质心多远"（垂直），这一项管"质心落在这条线的哪一段"——
   *   质心偏在线的一端时，文字被 `[0, 长-字宽]` 夹住，怎么摆都会偏 ✗
   *   → 质心越靠中间越好，系数越大越执着 ✓ */
  asymWeight: 0.35,
  //: 字距最多拉伸到几倍（CK3 1.2 / V3 1.6 ✓）
  maxStretch: 1.2,
  /* 🔴🔴 **按角度加权**（2026-10-23 用户定的口径）
   *   以前这里是 CK3 的 `horizontalBias = 1.6`，评分项写的是 `1 - |sinθ|` —
   *   0° 拿满分、20° 就掉到 0.66、45° 只剩 0.29，曲线很陡 ✗
   *   稍一加权，所有名字就被压成横的：实测 45~52% 一个字都不转 ✗
   *   现在按**角度本身线性给分**：0° 得满、90° 得 0、中间均匀 ✓
   *   只有一个系数 `angleWeight`（0 = 完全不偏好水平，越大越躺平 ✓）
   *   ⚠ 想整体更斜就往下调这一个数 ✓（0.35 时完全水平的约 35%，
   *     0.5 时约 40%，0 时只剩真正适合斜着的那些 ✓）*/
  angleWeight: 0.3,
  //: 每个名字测几条候选线（CK3 5 ✓）
  numLineTests: 5,
  //: 候选线的纵向偏移范围 = 版图短边 × 这个比例（见上面那段说明 ✓）
  lineSpacing: 0.35,
  //: 候选角度（0 一定在最前：同分时它赢 ✓）
  //: ⚠ 只留 **+90**（从上往下读）✗ —— 留 -90 的话，同一张图上有的竖名往下读、
  //:   有的往上读，"拐弯方向"就又乱了 ✓（用户 2026-10-22 点名的那条 ✓）
  angles: [0, -10, 10, -20, 20, -30, 30, -45, 45, -60, 60, 90],
  //: 宽高比偏离 1 超过它就认为"不方"，考虑弯曲（CK3 0.06 ✓）
  squareness: 0.06,
  //: 单字名的宽高比阈值（CK3 0.15 ✓）
  singleSquareness: 0.15,
  //: ≤ 这么多字不弯曲（CK3 的 LENGTH_CURVE_CUTOFF = 2 ✓）
  lengthCurveCutoff: 2,
  //: 版图小于这么多地图像素就不排了（几个格子，排出来也是糊的 ✓）
  minSpan: 12,
  //: 曲线取多少个采样点（够了；再多只是白算 ✓）
  curveSamples: 24,
  //: 弯曲开关（文档说建议做成可关可调的模块 ✓）
  curve: true,
  //: 中文字距拉伸上限（文档 §7.4：中文别拉太开 ✓）
  cjkMaxStretch: 1.12,
  /* 🔴 **基线允许穿过不属于自己的地块** ✗✗（2026-10-23 用户）
   *   P社是先画一条直线、再把字贴着它摆 —— 那条线**不要求整条都在自己版图里** ✓
   *   以前这里只认"最长的一段连续命中"：中间夹一条海峡、一块飞地、
   *   邻国插进来的一条，名字就断成两截，只取最长那半截 ✗ → 名字被挤到一边
   *   （用户看到的"字不在版图中间 / 只占一小段"多半就是这个 ✓）
   *   现在：断口不超过「版图对角线的这么多倍」就跨过去接着算 ✓
   *   0.5 = 版图对角线的一半；调小 = 更守着自己版图，调大 = 更敢跨 ✓ */
  bridgeGap: 0.5,
  //: 跨过去之后，整条线上"真在自己版图里"的比例下限（太低就纯属乱画了 ✓）
  minCoverage: 0.2,
};

/** 把用户覆盖项并进默认参数（不改原表 ✓） */
export function mapNameParams(over) {
  return over ? Object.assign({}, MAPNAME_PARAMS, over) : MAPNAME_PARAMS;
}

/* ================================================================ ① 版图栅格
 *
 * 输入是编辑器本来就有的两样东西（**数据格式一个字节都不动** ✓）：
 *   · `state.provinceIds` —— 每个地图像素属于哪个省份（Uint16Array，W×H ✓）
 *   · `titleAt(pid, tier)` —— 那个省份在这一层属于哪个头衔 ✓
 *
 * 为什么不直接拿省份多边形：编辑器里根本没有多边形 ✗ ——
 *   归属是**逐像素**的（省份 id 图）+ **逐省**的（titlemap ✓）✓
 *   栅格化这张图等于"把省份 id 图抽稀"，比先拼多边形再栅格化便宜得多 ✓
 *
 * 抽稀的粒度（`cell`）是这张表最关键的一个数：
 *   · 小 → 形状准、但格数按平方涨（16384² 的图会吃掉几百 MB ✗）
 *   · 大 → 省内存、但细长条 / 小岛会被抹掉 ✓
 *   8 是实测的折中：CK3 9216×4608 → 1152×576 = 66 万格 ≈ 2.6 MB/层 ✓
 */

//: 一层的栅格缓存几条（换层来回切时不至于每次重建 ✓ 每条 2~3 MB ✓）
//: ⚠ 2026-10-24 从 3 提到 8：预热按层顺序扫，层数多于缓存会**循环挤掉重建**
//:   （CK3 实测 6 层建了 7 次、每次 135ms ✓ 提到 8 后每层恰好一次 ✓）
const GRID_CACHE = 8;

export class RealmMaskSource {
  /**
   * @param {object} o
   * @param {Uint16Array|Uint32Array} o.provinceIds 逐像素省份号（长度必须是 W×H ✓）
   * @param {number} o.width  o.height  地图像素尺寸
   * @param {(pid:number, tier:number)=>number} o.titleAt 归属查表（app.js 的那个 ✓）
   * @param {number} [o.noTitle] 空归属的哨兵值（默认 65535 ✓）
   * @param {number} [o.cell] 抽稀粒度（地图像素/格 ✓ 默认 8 ✓）
   */
  constructor(o) {
    const ids = o && o.provinceIds;
    this.width = (o && o.width) | 0;
    this.height = (o && o.height) | 0;
    this.ids = (ids && this.width > 0 && this.height > 0
                && ids.length >= this.width * this.height) ? ids : null;
    this.titleAt = (o && o.titleAt) || null;
    this.noTitle = (o && o.noTitle != null) ? o.noTitle : 65535;
    /* 🔴 **名字块号由 app 给**：`groupOf(pid, tier)` → 那一省属于哪个名字块 ✓
     *   （名字数量 / 分块一直是 app 的省份相邻并查集说了算 ✓ 排版器照它来 ✓）*/
    this.groupOf = (o && o.groupOf) || null;
    /* ⚠ 允许 cell = 1 ✓ —— 给"已经抽稀过的粗图"用（分块地图那条路：
     *   `buildTiledRealmMask` 出 1/8 的粗省份图，这里不能再抽 ✓ 再抽就是马赛克 ✗）*/
    this.cell = Math.max(1, Math.min(16, (o && o.cell) || 8));
    this.grids = new Map();          // tier → grid（LRU ✓）
    this.builds = 0;                 // 建过几次（自测用 ✓）
  }

  /** 这张源现在能不能排（分块地图 / 数据没齐 → false ✓） */
  get usable() {
    return !!(this.ids && this.titleAt);
  }

  /** 丢光缓存（换地图 / 数据换了 ✓） */
  clear() {
    this.grids.clear();
  }

  /**
   * 取某一层的栅格，没有就现建（连带连通域一起算 ✓）
   * @param {number} tier
   * @returns {object|null} {cell,cols,rows,tids,comp,comps,tidComps}
   */
  gridFor(tier) {
    if (!this.usable) return null;
    const t = tier | 0;
    const hit = this.grids.get(t);
    if (hit) return hit;
    const g = this._build(t);
    if (!g) return null;
    this.builds++;
    this.grids.set(t, g);
    while (this.grids.size > GRID_CACHE) {
      const oldest = this.grids.keys().next().value;
      this.grids.delete(oldest);
    }
    return g;
  }

  /** 真建一张：抽稀 → 并查集连通域 → 每块统计（包围盒 / 质心 / 格数 ✓） */
  _build(tier) {
    const W = this.width, H = this.height, ids = this.ids, cell = this.cell;
    const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
    const n = cols * rows;
    const tids = new Int32Array(n).fill(-1);
    const half = cell >> 1;
    for (let cy = 0; cy < rows; cy++) {
      const my = Math.min(H - 1, cy * cell + half);
      const row = cy * cols;
      const src = my * W;
      for (let cx = 0; cx < cols; cx++) {
        const mx = Math.min(W - 1, cx * cell + half);
        const pid = ids[src + mx];
        if (pid <= 0) continue;
        const t = this.titleAt(pid, tier);
        if (t == null || t < 0 || t === this.noTitle) continue;
        tids[row + cx] = t;
      }
    }

    /* 🔴🔴 **有"名字块"就用 app 的口径** ✗✗（2026-10-23 用户点破的）
     *   名字有几个、哪几个，一直是 `app.js` 按**省份相邻并查集**定的（老标准 ✓）
     *   排版器以前自己按"像素 4 邻域"再分一次 —— 两套标准，块数对不上 ✗
     *   → 现在：`groupOf(pid, tier)` 给了就**直接用它当块号**，
     *     一个 app 块 = 一个排版块，不再重新分 ✓
     *     没给（自测 / 没接上）才退回像素连通域 ✓ */
    const groupOf = this.groupOf;
    const parent = new Int32Array(n);
    const find = (x) => {
      let r = x;
      while (parent[r] !== r) r = parent[r];
      while (parent[x] !== r) { const p = parent[x]; parent[x] = r; x = p; }
      return r;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    if (!groupOf) {
      for (let i = 0; i < n; i++) parent[i] = i;
      for (let cy = 0; cy < rows; cy++) {
        const row = cy * cols;
        for (let cx = 0; cx < cols; cx++) {
          const i = row + cx, t = tids[i];
          if (t < 0) continue;
          if (cx > 0 && tids[i - 1] === t) union(i, i - 1);
          if (cy > 0 && tids[i - cols] === t) union(i, i - cols);
        }
      }
    }

    const comp = new Int32Array(n).fill(-1);
    const comps = [];
    const tidComps = new Map();
    const rootTo = new Map();
    const gids = groupOf ? new Int32Array(n).fill(-1) : null;
    if (groupOf) {
      for (let cy = 0; cy < rows; cy++) {
        const my = Math.min(H - 1, cy * cell + half);
        const src = my * W, row = cy * cols;
        for (let cx = 0; cx < cols; cx++) {
          const mx = Math.min(W - 1, cx * cell + half);
          const pid = ids[src + mx];
          if (pid <= 0) continue;
          const gid = groupOf(pid, tier);
          if (!(gid >= 0)) continue;
          gids[row + cx] = gid;
          /* 头衔号还用 `titleAt` 那一套（名字 / 隐藏 判据都按头衔 ✓）*/
          const t = this.titleAt(pid, tier);
          if (t != null && t >= 0 && t !== this.noTitle) tids[row + cx] = t;
        }
      }
    }
    for (let cy = 0; cy < rows; cy++) {
      const row = cy * cols;
      for (let cx = 0; cx < cols; cx++) {
        const i = row + cx;
        /* 有 groupOf：块号就是 app 的块号（同块 = 同一个连通域 ✓） */
        const key = gids ? gids[i] : tids[i];
        if (key < 0) continue;
        let ci = rootTo.get(key);
        if (ci === undefined) {
          ci = comps.length;
          rootTo.set(key, ci);
          comps.push({ tid: tids[i], gid: gids ? key : -1, count: 0,
                       minx: cx, miny: cy, maxx: cx, maxy: cy, sx: 0, sy: 0 });
          if (tids[i] >= 0) {
            let arr = tidComps.get(tids[i]);
            if (!arr) { arr = []; tidComps.set(tids[i], arr); }
            arr.push(ci);
          }
        }
        comp[i] = ci;
        const c = comps[ci];
        c.count++;
        c.sx += cx;
        c.sy += cy;
        if (cx < c.minx) c.minx = cx;
        if (cx > c.maxx) c.maxx = cx;
        if (cy < c.miny) c.miny = cy;
        if (cy > c.maxy) c.maxy = cy;
      }
    }
    /* 格坐标 → 地图像素坐标（包围盒外扩半格，质心取格子中心 ✓） */
    for (const c of comps) {
      c.x0 = c.minx * cell;
      c.y0 = c.miny * cell;
      c.x1 = Math.min(W, (c.maxx + 1) * cell);
      c.y1 = Math.min(H, (c.maxy + 1) * cell);
      c.cx = (c.sx / c.count + 0.5) * cell;
      c.cy = (c.sy / c.count + 0.5) * cell;
      c.w = c.x1 - c.x0;
      c.h = c.y1 - c.y0;
      c.diag = Math.hypot(c.w, c.h);
    }
    return { tier, cell, cols, rows, W, H, tids, comp, comps, tidComps,
             ids: this.ids, titleAt: this.titleAt, noTitle: this.noTitle,
             groupOf: groupOf || null,
             /* 粗格没命中时，回像素问"这一格算不算自己" ——
              * 有 app 块号：比**块号** ✓（同块就是同一坨，跟名字数量同一标准 ✓）
              * 普通头衔：同一个 tid ✓；玩家涂色块：同一个 pid 集合 ✓ */
             pixelInside: (pid, ci) => {
               if (!(pid > 0)) return false;
               if (groupOf && comps[ci].gid >= 0) return groupOf(pid, tier) === comps[ci].gid;
               if (!this.titleAt) return false;
               const t = this.titleAt(pid, tier);
               return t != null && t >= 0 && t !== this.noTitle && t === comps[ci].tid;
             } };
  }

  /**
   * 按**块号**找回那一块（色块专用 ✓ 2026-10-23）
   * 色块的名额是 app 按"同颜色 + 同名字"分好的，块号直接传进来 ✓
   * 一个块 = 一个连通域，不用再猜"离谁近" ✓
   */
  componentByGroup(tier, gid, x, y) {
    const g = this.gridFor(tier);
    if (!g || gid == null || gid < 0) return null;
    if (!g.gidComps) {
      const m = new Map();
      for (let i = 0; i < g.comps.length; i++) {
        const id = g.comps[i].gid;
        if (id != null && id >= 0) m.set(id, i);
      }
      g.gidComps = m;
    }
    const i = g.gidComps.get(gid);
    if (i == null) return null;
    return { grid: g, index: i, comp: g.comps[i] };
  }

  /**
   * 找一个头衔里**离这个锚点最近的那一块**（一个头衔可以有本土 + 一堆殖民地 ✓）
   *
   * ⚠ 这一步是必须的 ✗✗ —— 编辑器给"一个连通域一个标"，
   *   每个标只能把名字写在自己那一块上 ✓
   *   要是全按"这个头衔最大的一块"排，西班牙的殖民地会全部把名字写到伊比利亚 ✗
   *
   * @param {number} tier
   * @param {number} tid
   * @param {number} x 锚点（标自己的质心 ✓）
   * @param {number} y
   * @param {number} area 锚点那一块的像素数（用来定"离多远算不搭边"✓）
   * @returns {{grid:object, index:number, comp:object}|null}
   */
  componentFor(tier, tid, x, y, area) {
    const g = this.gridFor(tier);
    if (!g) return null;
    const list = g.tidComps.get(tid);
    if (!list || !list.length) return null;
    const hasPt = Number.isFinite(x) && Number.isFinite(y);
    const cellArea = (c) => c.count * g.cell * g.cell;
    let best = list[0], bestD = Infinity, bestAD = Infinity;
    for (let k = 0; k < list.length; k++) {
      const c = g.comps[list[k]];
      let d = 0;
      if (hasPt) {
        const dx = x < c.x0 ? c.x0 - x : (x > c.x1 ? x - c.x1 : 0);
        const dy = y < c.y0 ? c.y0 - y : (y > c.y1 ? y - c.y1 : 0);
        d = dx * dx + dy * dy;
      }
      /* 🔴 **同距离时按"面积接近"挑，不按"谁大"挑** ✗✗
       *   （2026-10-22 用户："小连通域的名字跳到最近大连通域"）
       *   小岛常常**整个躺在大国的包围盒里** → 两个候选的 bbox 距离都是 0 ✓
       *   以前同分时选 `count` 大的 → 小岛的名字跳到大国那块 ✗
       *   → 现在比 `|log(候选面积 / 这一块面积)|`，谁接近选谁 ✓ */
      const ad = (area > 0) ? Math.abs(Math.log(Math.max(1, cellArea(c)) / Math.max(1, area)))
                            : 0;
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && ad < bestAD)) {
        bestD = d;
        bestAD = ad;
        best = list[k];
      }
    }
    /* 离得太远 = 这块地根本没进栅格（小岛被抽稀抹掉了 ✓）→ 交给老那套 ✓ */
    if (hasPt) {
      const lim = Math.max(g.cell * 2, Math.sqrt(Math.max(1, area || 0)) * 0.8);
      if (bestD > lim * lim) return null;
      /* **面积差太多 = 拿大块顶替了** ✗（小岛没进栅格时的兜底）
       *   宁可退回老画法（横着写在小岛自己的质心上），也不许跑到大国那块去重叠 ✓
       *   4 倍 / 0.22 是给栅格抽稀的误差留的余量 ✓ */
      if (area > 0) {
        const ca = cellArea(g.comps[best]);
        if (ca > area * 4 || ca < area * 0.22) return null;
      }
    }
    return { grid: g, index: best, comp: g.comps[best] };
  }
}

/* ================================================================ ①′ 涂色块的版图
 *
 * 玩家涂出来的色块**没有头衔** ✗ —— 它的形状是"同一显示色 + 同一标签名"的省并起来的一坨 ✓
 * 所以不能拿 `titleAt` 当版图 ✓ 这里改用**省号集合**当"领土"：
 *   · 建一张只盖住这块包围盒的小栅格（不是全图 ✓ 一坨一次 ✓）
 *   · 格子里那个像素的省号在这个集合里 = 在里面 ✓
 *   · 整坨已经是一个连通域（app.js 并查集分好的 ✓）→ 只建一个 component ✓
 *
 * ⚠ 包围盒从 `provPos`（各省质心 + 像素数）估 ✗ 不扫全图 ✓
 *   质心 ± √像素数 能盖住绝大多数省；外面再放两格余量 ✓
 */


/* ================================================================ ②~⑦ 排版 */

/** 沿法线方向找"**当前这个点所在的**那一列版图"
 *
 *  🔴 **不再"避水"** ✗✗（2026-10-22 用户："取消掉字避水机制"）
 *    以前是"离 0 最近的那一段" —— 采样点落在湖里 / 海外时，
 *    它会跳到**旁边最近的一块陆地**上，曲线于是东躲西闪，字跟着七零八落 ✗
 *    现在只认 **s=0 真的在里面** 的那一段；不在里面就返回 null（基线走直线）✓
 *
 *  @returns {{a:number,b:number,mid:number,len:number}|null}
 */
function columnSpan(g, ci, px, py, nx, ny, limit, step) {
  let runA = null, runLast = null;
  for (let s = -limit; s <= limit + 1e-6; s += step) {
    const x = px + nx * s, y = py + ny * s;
    const hit = insideAt(g, ci, x, y);
    if (hit) {
      if (runA === null) runA = s;
      runLast = s;
    } else if (runA !== null) {
      if (runA <= 1e-6 && runLast >= -1e-6) {
        return { a: runA, b: runLast, mid: (runA + runLast) / 2,
                 len: Math.max(0, runLast - runA) };
      }
      runA = null;
    }
  }
  if (runA !== null && runA <= 1e-6 && runLast >= -1e-6) {
    return { a: runA, b: runLast, mid: (runA + runLast) / 2,
             len: Math.max(0, runLast - runA) };
  }
  return null;
}


/** 地图坐标 → 栅格下标（越界 = -1 ✓ 热路径：不分配对象 ✓） */
function cellOf(g, x, y) {
  const gx = x - (g.x0 || 0), gy = y - (g.y0 || 0);
  const cx = (gx / g.cell) | 0, cy = (gy / g.cell) | 0;
  if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return -1;
  return cy * g.cols + cx;
}

function insideAt(g, ci, x, y) {
  if (x < 0 || y < 0 || x >= g.W || y >= g.H) return false;
  const i = cellOf(g, x, y);
  if (i < 0) return false;
  if (g.comp[i] === ci) return true;
  /* 🔴 **粗格没命中时回真实像素再问一次** ✗✗
   *   8px 一格的边界是阶梯状的 ✓ 细长条 / 小岛 / 字的中心压在台阶上时，
   *   格心采样可能落到隔壁 ✓ 但**像素**明明还是这一家的 ✓
   *   → 只认同一个头衔（不是同一个连通域）✓ 隔着一片水不会误判 ✓
   *   （跨海的两个块中间是水，像素归属不同 ✓）
   *   ⚠ 这条只在**没命中**时跑 ✓ 绝大多数采样一次就返回了 ✓ */
  const px = x | 0, py = y | 0;
  const pid = g.ids ? g.ids[py * g.W + px] : 0;
  if (pid > 0 && g.pixelInside) return g.pixelInside(pid, ci);
  return false;
}

/**
 * 采样点属于谁（三态 ✓ 2026-10-23 用户："必须先选一个连通域，不要画到别的附近的同国连通域"）
 *
 *   2 = **就是这一块**（同一个像素连通域 ✓ 基线可以走）
 *   1 = **同一头衔的另一块**（本土与殖民地、隔海峡的两片）→ 线不许跨过去 ✗
 *   0 = 别人的地 / 水 / 图外 → 允许"跨断口"，但有宽度上限 ✓
 *
 * 🔴🔴 **判据是"像素连通域"，不是"头衔"** ✗✗（用户点破的）
 *   同一个头衔本来就有好几个连通域（本土 + 一堆岛 ✓），拿 `titleAt` 比头衔
 *   等于"整国都算自己"，跨海照样连过去 —— 一点用都没有 ✗
 *   现在：粗格说不是这一块之后，**只有紧贴着这一块边缘**（8 邻域里有一格是本块）
 *   才算"8px 栅格的台阶误差" ✓ 深入另一块内部的一律是"同国另一块" ✓
 */
function sampleKind(g, ci, x, y) {
  if (x < 0 || y < 0 || x >= g.W || y >= g.H) return 0;
  const gi = cellOf(g, x, y);
  if (gi < 0) return 0;
  const v = g.comp[gi];
  if (v === ci) return 2;

  const myComp = g.comps[ci];
  const myTid = myComp ? myComp.tid : -1;
  const pid = g.ids ? g.ids[(y | 0) * g.W + (x | 0)] : 0;

  /* 玩家涂出来的色块（头衔 = -1）：只有"这一坨的省号集合"算自己 ✓ */
  if (myTid < 0) {
    return (pid > 0 && g.pixelInside && g.pixelInside(pid, ci)) ? 2 : 0;
  }
  const t = (pid > 0 && g.titleAt && g.tier >= 0) ? g.titleAt(pid, g.tier) : -1;
  const sameTid = (t >= 0 && t !== g.noTitle && t === myTid);

  if (!sameTid) return 0;                       // 水 / 别人的地 → 允许跨 ✓
  /* 同头衔、还在包围盒里：贴着本块边缘的是栅格台阶误差 ✓ 深入的算另一块 ✗
   * ⚠ 小岛嵌在大陆的湾里时，"相邻"这个条件就失效了 ✗（实测东欧那块 74 格的小岛 ✓）
   *   → 再加一条：**离谁的中心近** —— 紧贴本块边缘时离本块中心更近 ✓
   *     已经在大陆腹地里了，离大陆中心更近 → 判成"另一块" ✓ */
  /* 下标反推回格坐标（nearComp 要 ×✓ 比再算一遍便宜 ✓）*/
  const gcx = gi % g.cols, gcy = (gi / g.cols) | 0;
  if (!nearComp(g, ci, gcx, gcy)) return 1;
  const other = (v >= 0 && g.comps[v]) ? g.comps[v] : null;
  /* 只在"对面明显更大"时比中心 ✓（小岛嵌在大陆湾里 = 大陆大得多 ✓）
   * ⚠ 两块差不多大时不能比 ✗ —— 相邻的两块往往离对方中心都不远，
   *   一律按中心判会把本块自己的边也判成"别人的"，整条线断光 → 排不出来 ✗ */
  if (other && other !== myComp && other.tid === myTid && other.count > myComp.count * 3) {
    const d1 = Math.hypot(x - myComp.cx, y - myComp.cy);
    const d2 = Math.hypot(x - other.cx, y - other.cy);
    if (d2 < d1) return 1;
  }
  return 2;
}

/** 这一格 8 邻域里有没有本块 ✓（判"台阶误差"用） */
function nearComp(g, ci, cx, cy) {
  for (let dy = -1; dy <= 1; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= g.rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx;
      if (xx < 0 || xx >= g.cols) continue;
      if (g.comp[yy * g.cols + xx] === ci) return true;
    }
  }
  return false;
}


/**
 * **字号 = min(线长能撑的, 带宽能撑的) × SCALE** —— 评分和收尾共用这一份
 * （2026-10-23 体检：两处原来各写一遍，改一处忘一处就会"评分算的和画的不一致" ✗）
 * @param {number} runLen 选中那段的长度（地图像素 ✓）
 * @param {number} bandW  平均带宽（面积 ÷ 线长 ✓）
 * @returns {number} 字号（地图像素；还没乘 userScale / 少字系数 ✓）
 */
function fittedSize(runLen, bandW, totalAdv, ref, refH, p) {
  if (!(totalAdv > 0) || !(refH > 0)) return 0;
  const fsW = runLen * p.capWidth * ref / totalAdv;
  const fsTall = bandW * ref / refH * p.thickOverflow;
  const fs = Math.min(fsW, fsTall) * p.scale;
  return fs > 0 ? fs : 0;
}

/** 在折线上按弧长取点（返回位置与切线角 ✓） */
function locate(poly, cum, d) {
  const n = poly.length;
  if (n === 1) return { x: poly[0].x, y: poly[0].y, angle: 0 };
  if (d <= 0) {
    const dx = poly[1].x - poly[0].x, dy = poly[1].y - poly[0].y;
    return { x: poly[0].x, y: poly[0].y, angle: Math.atan2(dy, dx) };
  }
  const total = cum[n - 1];
  if (d >= total) {
    const dx = poly[n - 1].x - poly[n - 2].x, dy = poly[n - 1].y - poly[n - 2].y;
    return { x: poly[n - 1].x, y: poly[n - 1].y, angle: Math.atan2(dy, dx) };
  }
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= d) lo = m; else hi = m;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / seg;
  const ax = poly[lo].x, ay = poly[lo].y;
  const bx = poly[hi].x, by = poly[hi].y;
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, angle: Math.atan2(by - ay, bx - ax) };
}

/**
 * 排一个名字。
 *
 * @param {string} text 名字（已本地化 / 已缩写 ✓）
 * @param {RealmMaskSource} mask
 * @param {number} tid 头衔号
 * @param {number} tier 层号
 * @param {object} metrics 字形度量（**都在 ref 号字下** ✓）
 *        `{ref, adv:number[], ascent, descent}`
 * @param {object} [opts]
 *        `{anchor:{x,y,area}, userScale, params, curve}`
 * @returns {object|null} `{fs, glyphs, bbox, score, runLen, thickness, angle, comp}`
 */
export function layoutMapName(text, mask, tid, tier, metrics, opts) {
  if (!mask || !mask.usable || !text || !metrics) return null;
  const chars = Array.from(String(text));
  if (!chars.length || chars.length > 64) return null;
  /* 度量要跟字数对齐（位图字体缺字 / 调用方给错都会让 adv 短一截 → 后面越界读 ✓
   * 2026-10-23 体检：直接判"排不出来"，让它退回横排，别拿 NaN 去算位置 ✗ */
  const _adv = metrics.adv;
  if (!_adv || _adv.length !== chars.length) return null;
  const o = opts || {};
  const p = mapNameParams(o.params);
  const anchor = o.anchor || null;
  /* 色块：块号由 app 给（一个色块 = 一个连通域 ✓）直接按块号找 ✓
   * 地名：按头衔 + 锚点找最近的那一块 ✓ */
  const hit = (o.gid != null && o.gid >= 0 && typeof mask.componentByGroup === 'function')
    ? mask.componentByGroup(tier, o.gid, anchor ? anchor.x : NaN, anchor ? anchor.y : NaN)
    : mask.componentFor(tier, tid, anchor ? anchor.x : NaN, anchor ? anchor.y : NaN,
                        anchor ? anchor.area : 0);
  if (!hit) return null;
  const g = hit.grid, c = hit.comp, ci = hit.index;
  if (!(c.w > 0) || !(c.h > 0)) return null;
  const diag = c.diag;
  if (diag < p.minSpan) return null;

  const ref = metrics.ref || 100;
  const refH = Math.max(1, (metrics.ascent || 0) + (metrics.descent || 0));
  let totalAdv = 0;
  for (let i = 0; i < chars.length; i++) totalAdv += metrics.adv[i] || 0;
  if (!(totalAdv > 0)) return null;

  /* 📊 **采样步长按对角线封顶**（2026-10-24 性能 · 预热剖析 ✓）
   *   巨型版图（帝国 / 王国，对角几千 px）一条线要走几百个采样点、
   *   60 条线就是几万次 —— CK3 实测 7 个巨名烧了 990ms ✓
   *   `diag/200` 把一条线封在 ~300 个采样点：大版图上 15~40px 的步长
   *   对 100px 级的字号毫无影响 ✓ 小版图不受影响 ✓ */
  const step = Math.max(4, g.cell, Math.ceil(diag / 200));
  const ccx = (c.x0 + c.x1) / 2, ccy = (c.y0 + c.y1) / 2;
  const radius = Math.max(1, diag / 2);
  const offRange = Math.min(c.w, c.h) * p.lineSpacing;
  const nOff = Math.max(1, p.numLineTests | 0);
  const half = diag * 0.75;
  const thickLimit = Math.max(step * 2, Math.min(c.w, c.h) * 0.85);

  /* 🔴 **接近方形的版图不许歪** ✗✗（文档 §3.5 / §7.3 ✓）
   *   方形版图上，斜着穿过去的那条线**更长** ✓ 光看"能撑多大字号"就会选它，
   *   于是「爱尔兰」会横过来 60° ✗ —— 但 P社的效果是**几乎水平**的 ✓
   *   （HORIZONTAL_BIAS = 1.6 说的就是这个意思 ✓）
   *   → 方版图只留 ±20° 的候选；长条形 / 斜着的版图不受影响 ✓ */
  const squareish = Math.abs(c.w / Math.max(1, c.h) - 1)
    <= Math.max(0.12, (chars.length === 1 ? p.singleSquareness : p.squareness) * 2);

  let best = null;
  let earlyAccept = false;
  for (let ai = 0; ai < p.angles.length && !earlyAccept; ai++) {
    if (squareish && Math.abs(p.angles[ai]) > 20) continue;
    const rad = p.angles[ai] * Math.PI / 180;
    const dx = Math.cos(rad), dy = Math.sin(rad);
    const nx = -dy, ny = dx;
    /* 角度偏好：**按角度线性**（0° = 1、90° = 0 ✓）——
     * 不是以前那个 `1 - |sinθ|`（20° 就掉三分之一，曲线太陡 ✗）*/
    const angPref = 1 - Math.abs(p.angles[ai]) / 90;
    for (let k = 0; k < nOff; k++) {
      const off = nOff === 1 ? 0 : ((k / (nOff - 1)) - 0.5) * 2 * offRange;
      const mx = ccx + nx * off, my = ccy + ny * off;

      /* 沿线采样：找"从进到出的整条跨度"，**允许中途跨过别人的地块** ✓
       *   （2026-10-23 用户：P社那条直线本来就该能穿过去 ✗ 以前一断就截 ✓）
       *   断口上限 `bridgeGap × 对角线`：太宽就真的是两截了，不再硬连 ✓ */
      let inside = 0, total = 0;
      let runA = null, gapA = null, lastIn = -1, insideRun = 0;
      let bestA = -1, bestB = -1, bestLen = 0;
      let last = -half;
      const maxGap = Math.max(step * 3, diag * p.bridgeGap);
      /* 收一段：**只在这一段自己的跨度里算命中率** ✓
       *   （以前拿整条扫描线算覆盖率 —— 线比版图长得多，小地块永远过不了 0.2 ✗
       *    实测 EU5 地名层 49 块里有 18 块就是这么被误杀的 ✗）*/
      const consider = (a, b, nIn) => {
        if (a == null || !(b > a)) return;
        const len = b - a;
        if (!(len > bestLen)) return;
        /* 这一段自己的跨度里，真在本块上的比例不能太低 ✓
         * （跨别人的地是允许的 ✓ 但不能整条线都躺在别人 / 水上 ✓）*/
        const cnt = Math.max(1, Math.round(len / step) + 1);
        if (nIn / cnt < p.minCoverage) return;
        bestLen = len; bestA = a; bestB = b;
      };
      for (let s = -half; s <= half + 1e-6; s += step) {
        total++;
        /* 三态：2 = 自己这一块 / 1 = 同国的**另一块** / 0 = 别人或水 ✓
         * 同国另一块**绝对不能跨** ✗（用户 2026-10-23：先选定一个连通域 ✓）*/
        const kindAt = sampleKind(g, ci, mx + dx * s, my + dy * s);
        if (kindAt === 2) {
          inside++;
          if (runA === null) { runA = s; insideRun = 0; }
          insideRun++;
          lastIn = s;
          gapA = null;
        } else if (kindAt === 1) {
          /* 撞到同头衔的另一块 → 这一段就地结束 ✓ 不许连过去 ✓ */
          if (runA !== null) consider(runA, lastIn, insideRun);
          runA = null; gapA = null; lastIn = -1; insideRun = 0;
        } else if (runA !== null) {
          if (gapA === null) gapA = s;
          else if (s - gapA > maxGap) {      // 断口太宽 → 这一段到此为止 ✓
            consider(runA, lastIn, insideRun);
            runA = null; gapA = null; lastIn = -1; insideRun = 0;
          }
        }
        last = s;
      }
      if (runA !== null) consider(runA, lastIn, insideRun);
      if (!(bestLen > step)) continue;

      const runMid = (bestA + bestB) / 2;
      const rmx = mx + dx * runMid, rmy = my + dy * runMid;
      const centerPenalty = Math.hypot(rmx - c.cx, rmy - c.cy) / radius;
      const coverage = inside / Math.max(1, total);

      /* 这一段能撑多大字号 —— 直接拿"宽度上限 / 高度上限"算 ✓
       * ⚠ 把它算进评分是这套算法的关键 ✗：
       *   只按"命中率高"选线，会挑到贴着边界的那条（又长又薄，字小得看不见 ✓）
       *   把字号算进来，才会选到"又居中、又宽、又厚"的那条 ✓ */
      /* 🔴🔴 **线宽用"面积 ÷ 线长"，别再拿某一列去量** ✗✗（2026-10-23 用户点破的）
       *   以前在上中点 / 质心那一列纵向量"这一列有多宽" ——
       *   可质心可能正好落在湾里 / 窄口上，那一列只量到 24px，
       *   于是「夏」这种基线 888px 的地，字号被压到 19px（实测）✗
       *   → 平均带宽 = **这一块的面积 ÷ 这段线的长度** ✓ 稳、不受单点影响 ✓
       *     （面积 = 格数 × 格面积 ✓ 整块连通域的面积）*/
      const bandW = (c.count * g.cell * g.cell) / Math.max(step, bestLen);
      const thick = bandW;
      /* 字号：**跟线的长短走** ✓（用户 2026-10-23）
       *   线长×0.9 是"字摆得下"的自然大小；厚度只当溢出上限
       *   （允许到 `thickOverflow` 倍厚度，细长条的字因此比以前大 ✓）*/
      const fs = fittedSize(bestLen, thick, totalAdv, ref, refH, p);
      if (!(fs > 0)) continue;

      /* 质心落在这条线上的**相对位置**（0 = 起点、1 = 终点）——
       * 越靠中间，最后越摆得正 ✓（见 `asymWeight`）*/
      const ax0 = mx + dx * bestA, ay0 = my + dy * bestA;
      const tCf = Math.max(0, Math.min(1,
        ((c.cx - ax0) * dx + (c.cy - ay0) * dy) / Math.max(1, bestLen)));
      const asym = Math.abs(tCf - 0.5);

      const score = 1.0 * (fs / (diag * 0.35))
        + 0.55 * (bestLen / diag)
        + 0.35 * coverage
        + p.angleWeight * angPref
        - p.centerPenaltyWeight * centerPenalty
        - p.asymWeight * asym * 2;      // 0.5 的最差偏移 = 1.0

      if (!best || score > best.score) {
        best = {
          score, dx, dy, nx, ny, mx, my, runA: bestA, runB: bestB,
          runLen: bestLen, thick, coverage, centerPenalty, angle: rad,
        };
        /* 📊 **早期接受**（2026-10-24 性能 · 预热剖析出来的大头 ✓）
         *   候选按角度**从水平往斜排** ✓：CK3 全图单名排版 2.5s 里，
         *   60 条线 × 逐点采样 = 平均 1277 次 sampleKind/名（2986 万次总量 ✓）
         *   允许在**近水平（≤10°）**的候选上收工：线长 ≥55% 对角、
         *   覆盖 ≥40%、居中偏差 ≤20% —— 这条线已经"又长又厚又正"，
         *   更斜的线很少能翻盘 ✓ 判据不满足（长条 / 半岛 / 群岛）照旧全扫 ✓
         *   （版图贴合的几何自测兜底：该弯的弯、居中误差、转角 ✓）*/
        if (Math.abs(p.angles[ai]) <= 10 && best.runLen >= diag * 0.55
            && best.coverage >= 0.4 && best.centerPenalty <= 0.2) {
          earlyAccept = true;
          break;
        }
      }
    }
  }
  if (!best) return null;

  /* ④ 适配：**字号按线长定**，厚度只当溢出上限（用户 2026-10-23 ✓
   *   以前 `min(线长×0.9, 厚度×0.6)` —— 细长条的线再长，字也被厚度卡死 ✗ */
  let fs = fittedSize(best.runLen, best.thick, totalAdv, ref, refH, p)
    * (o.userScale || 1);
  /* 🔴 **少字的稍微压一点**（2026-10-23 用户："稍微限制一下少字的大小"）
   *   一两字的名字按"填满线长"算出来的字特别大（实测 2 字有 20% 版图对角，
   *   铺满半个国家）✗ —— 这里按字数乘一个系数：字越少压得越多 ✓
   *   只压字号，不压字距 —— 居中和弯曲都不受影响 ✓ */
  const _n = chars.length;
  const shortMul = _n <= 1 ? p.shortNameMul[1]
    : _n === 2 ? p.shortNameMul[2]
    : _n === 3 ? p.shortNameMul[3] : 1;
  fs *= shortMul;
  if (!(fs > 0)) return null;

  /* ⑤ 字距：只加**字与字之间**的间距，最多 maxStretch 倍（中文更保守 ✓）*/
  const isCJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(text);
  const maxStretch = isCJK ? Math.min(p.maxStretch, p.cjkMaxStretch) : p.maxStretch;
  const natural = totalAdv * fs / ref;
  const target = Math.min(best.runLen * p.capWidth, natural * maxStretch);
  let gap = chars.length > 1 ? Math.max(0, (target - natural) / (chars.length - 1)) : 0;

  /* ⑥ 基线：直还是弯 */
  const thickness = Math.max(step, best.thick);
  const aspect = best.runLen / thickness;
  const sqTh = chars.length === 1 ? p.singleSquareness : p.squareness;
  const square = Math.abs(aspect - 1) <= sqTh;
  const wantCurve = (o.curve != null ? o.curve : p.curve)
    && !square && chars.length > p.lengthCurveCutoff;

  const startX = best.mx + best.dx * best.runA;
  const startY = best.my + best.dy * best.runA;
  const endX = best.mx + best.dx * best.runB;
  const endY = best.my + best.dy * best.runB;
  const runLen = Math.max(step, best.runLen);
  /* 质心在这条基线上的参数位置 —— **横向 / 纵向居中都以它为准** ✓
   * （用户 2026-10-22："很多时候名字并非居中" —— 最长段的中点经常偏在一边 ✗）*/
  const tC0 = Math.max(0, Math.min(1,
    ((c.cx - startX) * best.dx + (c.cy - startY) * best.dy) / Math.max(1, runLen)));

  let poly, cum;
  let pathLen = runLen;
  if (!wantCurve) {
    /* 直线也要**纵向居中**（不然名字会贴在版图边上 ✓）——
     * 在**质心那个位置**量一次列宽，取它的中心 ✓（不是整段中点 ✗）*/
    const px = startX + best.dx * runLen * tC0;
    const py = startY + best.dy * runLen * tC0;
    const midSpan = columnSpan(g, ci, px, py, best.nx, best.ny, thickLimit, step);
    /* 🔴 **更贴几何中心**（2026-10-23 用户）
     *   以前 `off = midSpan.mid`：把线平移到"质心那一列的**中点**" ✓
     *   可列中点 ≠ 质心（凹形 / 半岛形的列不对称），于是名字整体偏在一侧 ✗
     *   实测：离心误差里沿基线只有 1~2%，**垂直方向 7~9%** —— 就是这个 ✗
     *   现在直接平移到**过质心**的那条线：off = 质心到线的垂距 ✓
     *   但仍夹在"这一列的版图范围"里（不许把线推到版图外面去 ✓） */
    const offC = (c.cx - px) * best.nx + (c.cy - py) * best.ny;
    let off = midSpan
      ? Math.max(Math.min(midSpan.a, midSpan.b), Math.min(Math.max(midSpan.a, midSpan.b), offC))
      : offC;
    /* 🔴 **纵向居中之后要复查一遍** ✗（2026-10-23）
     *   在质心那一列量出来的中心可能把整条线**平移到同国的另一块上** ✓
     *   （东欧 / 东南亚那种跨一大堆岛的区最容易被推到隔壁一块 ✗）
     *   → 平移后沿线抽样，只要有一点落在"同国另一块"就放弃居中（off = 0）✓ */
    if (off) {
      let bad = false;
      for (let t = 0; t <= 1 + 1e-6; t += 0.125) {
        const sx2 = startX + (endX - startX) * t + best.nx * off;
        const sy2 = startY + (endY - startY) * t + best.ny * off;
        if (sampleKind(g, ci, sx2, sy2) === 1) { bad = true; break; }
      }
      if (bad) off = 0;
    }
    poly = [
      { x: startX + best.nx * off, y: startY + best.ny * off },
      { x: endX + best.nx * off, y: endY + best.ny * off },
    ];
    cum = [0, runLen];
  } else {
    const n = Math.max(8, Math.min(48, Math.round(runLen / step), p.curveSamples));
    const offs = new Array(n + 1);
    const spans = new Array(n + 1);
    /* 🔴🔴 **曲线形状必须留着** ✗✗（2026-10-23 用户："过于贴合几何中心会让弧度失效"）
     *   上一版把每一列都夹到同一个 `offC` 上 —— 每列偏移量一样 = 直线 ✗
     *   现在分两步：
     *     ① 每列先按**自己版图的列心** `sp.mid` 摆（弧度就是这么来的 ✓）
     *     ② 再整体加一个**修正量** `delta`，让"字中间"落到质心上 ✓
     *   修正量夹在每列自己的范围内（不许跑出版图 ✓），弧度只被平移、不被抹平 ✓ */
    const rawOffs = new Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const bx = startX + (endX - startX) * t;
      const by = startY + (endY - startY) * t;
      const sp = columnSpan(g, ci, bx, by, best.nx, best.ny, thickLimit, step);
      spans[i] = sp;
      rawOffs[i] = sp ? sp.mid : 0;
    }
    /* 质心那一列：现在的曲线在那儿偏离多少 → 还差多少才落到质心 ✓ */
    const cpx = startX + best.dx * runLen * tC0;
    const cpy = startY + best.dy * runLen * tC0;
    const offC = (c.cx - cpx) * best.nx + (c.cy - cpy) * best.ny;
    const ci0 = Math.max(0, Math.min(n, Math.round(tC0 * n)));
    const rawAtC = rawOffs[ci0] != null ? rawOffs[ci0] : 0;
    let delta = offC - rawAtC;
    /* 修正量别太猛（超过半条线宽就说明这块地的质心本来就不在带子上 ✓）*/
    const dLim = Math.max(step, thickness * 0.6);
    if (delta > dLim) delta = dLim; else if (delta < -dLim) delta = -dLim;
    for (let i = 0; i <= n; i++) {
      const sp = spans[i];
      const v = rawOffs[i] + delta;
      offs[i] = sp
        ? Math.max(Math.min(sp.a, sp.b), Math.min(Math.max(sp.a, sp.b), v))
        : v;
    }
    /* 相邻两点的偏移别跳（细长区域里会突然折弯 ✓ 文档 §3.5 第 5 条 ✓）*/
    const maxJump = Math.max(step * 2, thickness * 0.6);
    for (let i = 1; i <= n; i++) {
      const d = offs[i] - offs[i - 1];
      if (Math.abs(d) > maxJump) offs[i] = offs[i - 1] + Math.sign(d) * maxJump;
    }

    /* 🔴🔴 **只许朝一个方向弯** ✗✗（2026-10-22 用户："拐弯倾向必须每次都是同一方向"）
     *
     *   以前是"逐点取纵向中心 + 移动平均" —— 版图凹一下、凸一下，
     *   曲线就会先往左弯、再往右弯（S 形 ✓）字也跟着一会儿正转、一会儿反转 ✓
     *   这跟 P社 的观感完全不是一回事 ✗ 他们的名字永远是一条**单向的弧** ✓
     *
     *   现在的做法：把采样出来的偏移拟合成一条**二次曲线** `o(t)=a·t²+b·t+c` ✓
     *     · 二次曲线的二阶导是常数 `2a` → **拐弯方向永远不变**（要么一直朝上、要么一直朝下、要么直的）✓
     *     · 最小二乘拟合 → 个别凹点不会把整条线带成 S ✓
     *     · 端点斜率收一下（±50° 以内）→ 细长条末端也不会突然折 ✓
     *
     *   ⚠ 不是 Catmull-Rom / 样条 ✗ —— 那些天生允许拐点（S 形）✓
     *     要的就是"没有拐点"这一条硬约束 ✓ */
    const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7])
      - m[1] * (m[3] * m[8] - m[5] * m[6])
      + m[2] * (m[3] * m[7] - m[4] * m[6]);
    {
      let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0;
      let B0 = 0, B1 = 0, B2 = 0;
      for (let i = 0; i <= n; i++) {
        const t = i / n, t2 = t * t, o = offs[i];
        S0 += 1; S1 += t; S2 += t2; S3 += t2 * t; S4 += t2 * t2;
        B0 += o; B1 += o * t; B2 += o * t2;
      }
      const M = [S0, S1, S2, S1, S2, S3, S2, S3, S4];
      const D = det3(M);
      let a = 0, b = 0, c = 0;
      if (Math.abs(D) > 1e-9) {
        c = det3([B0, S1, S2, B1, S2, S3, B2, S3, S4]) / D;
        b = det3([S0, B0, S2, S1, B1, S3, S2, B2, S4]) / D;
        a = det3([S0, S1, B0, S1, S2, B1, S2, S3, B2]) / D;
      } else {
        // 退化（样本太少）：退成一条直线 ✓
        const den = S0 * S2 - S1 * S1;
        if (Math.abs(den) > 1e-9) {
          b = (S0 * B1 - S1 * B0) / den;
          c = (B0 - b * S1) / S0;
        } else c = B0 / Math.max(1, S0);
      }
      /* 端点斜率收进 ±50°：`o` 是垂直偏移、`t` 走的是 runLen ✓
       *   do/dt 跟 runLen 的比就是斜率 ✓ */
      const maxSlope = runLen * 1.2;
      const sl0 = b, sl1 = 2 * a + b;
      const mx = Math.max(Math.abs(sl0), Math.abs(sl1));
      if (mx > maxSlope) {
        const k = maxSlope / mx;
        a *= k;
        b *= k;
      }
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        offs[i] = a * t * t + b * t + c;
      }
      /* **纵向也对准质心** ✓（只平移，不改曲率 —— 拐弯方向还是同一个 ✓）
       * 在质心那个位置量一次真实列心，跟拟合值差多少就整体挪多少 ✓
       * 限幅 0.35 倍厚度：极端形状也不至于把两端甩出版图 ✓ */
      const pxC = startX + (endX - startX) * tC0;
      const pyC = startY + (endY - startY) * tC0;
      const centerC = columnSpan(g, ci, pxC, pyC, best.nx, best.ny, thickLimit, step);
      if (centerC) {
        const fitC = a * tC0 * tC0 + b * tC0 + c;
        const lim = thickness * 0.15;
        const delta = Math.max(-lim, Math.min(lim, centerC.mid - fitC));
        for (let i = 0; i <= n; i++) offs[i] += delta;
      }
    }
    poly = new Array(n + 1);
    cum = new Array(n + 1);
    let acc = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const bx = startX + (endX - startX) * t;
      const by = startY + (endY - startY) * t;
      poly[i] = { x: bx + best.nx * offs[i], y: by + best.ny * offs[i] };
      if (i > 0) acc += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
      cum[i] = acc;
    }
    /* 🔴 **不许把曲线长度按比例压回直线长度** ✗✗（2026-10-22 实测踩到）
     *   以前：`cum[i] *= runLen/acc` —— 曲线比直线长时（k<1）就把它压短 ✓
     *   可字距是按**真实弧长**算的 ✓ 压完之后"走 161 像素"实际走了 178 ✓
     *   → 塞尔柱三个字被拉开 30%（用户一眼就能看出"字距怪"✓）
     *   现在：**按真实弧长排** ✓ 居中也在真实弧长上做 ✓
     *   （拟合宽度仍然用 runLen —— 保守一点，名字不会因为曲线而超出 ✓）*/
    pathLen = Math.max(1, acc);
  }

  /* ⑦ 逐字：先居中，再按"前进宽度 + 字距"逐字走 ✓
   *
   * 🔴 **居中不是"最长段的中点"** ✗✗（2026-10-22 用户："很多时候名字并非居中"）
   *   最长段只是"能放字的那一段" ✓ 它经常偏在版图的一边（半岛 / 海湾 / 飞地）✗
   *   → 真正的中心是**这块地的质心** `c.cx/c.cy` ✓
   *     把它投影到基线上，再把整段文字的中心对到那儿 ✓
   *     最后夹进 `[0, pathLen-totalW]`，保证不跑出那段 ✓ */
  let totalW = natural + gap * (chars.length - 1);
  /* 曲线比"自然宽度 + 字距"还短（极细的条子）：把字距让出去 ✓ */
  if (totalW > pathLen && chars.length > 1) {
    gap = Math.max(0, (pathLen - natural) / (chars.length - 1));
    totalW = natural + gap * (chars.length - 1);
  }
  const tC = tC0;
  let dC = pathLen * tC;
  if (wantCurve) {
    /* 曲线：质心投影点对应的**弧长**要现找（弧长跟 t 不是线性的 ✓）*/
    const tx = startX + (endX - startX) * tC;
    const ty = startY + (endY - startY) * tC;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const dd = (poly[i].x - tx) * (poly[i].x - tx) + (poly[i].y - ty) * (poly[i].y - ty);
      if (dd < bd) { bd = dd; bi = i; }
    }
    dC = cum[bi];
  }
  const maxStart = Math.max(0, pathLen - totalW);
  let cursor = Math.max(0, Math.min(maxStart, dC - totalW / 2));
  const glyphs = [];
  const angles = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  /* 转角取**一小段窗口的割线方向** ✗ —— 不取相邻两个采样点 ✗
   *   采样点密的时候，两点的方向对噪声太敏感（末端会突然转 20°+ ✓）
   *   窗口 = 半个字宽，等于"这个字所在的那一小段往哪儿走" ✓ */
  const halfWin = Math.max(fs * 0.5, step);
  for (let i = 0; i < chars.length; i++) {
    const adv = (metrics.adv[i] || 0) * fs / ref;
    const d = cursor + adv / 2;
    const q = locate(poly, cum, d);
    const q0 = locate(poly, cum, Math.max(0, d - halfWin));
    const q1 = locate(poly, cum, Math.min(pathLen, d + halfWin));
    let ang = Math.atan2(q1.y - q0.y, q1.x - q0.x);
    if (!Number.isFinite(ang)) ang = q.angle;
    /* 🔴 **字不许转到反方向** ✗✗（同一句"每次都是同一方向"）
     *   曲线端点斜率再大，字也只能相对**基线方向**偏 ±66° ✓
     *   不然细长条末端会出现一个字横过来 / 倒过来 ✓ 看着就像"整条线拐反了"✗ */
    {
      const base = best.angle;
      let rel = Math.atan2(Math.sin(ang - base), Math.cos(ang - base));
      const LIM = 1.15;
      if (rel > LIM) rel = LIM;
      else if (rel < -LIM) rel = -LIM;
      ang = base + rel;
    }
    angles.push(ang);
    glyphs.push({ ch: chars[i], x: q.x, y: q.y, angle: ang, adv });
    cursor += adv + gap;
    if (q.x - fs < x0) x0 = q.x - fs;
    if (q.x + fs > x1) x1 = q.x + fs;
    if (q.y - fs < y0) y0 = q.y - fs;
    if (q.y + fs > y1) y1 = q.y + fs;
  }
  /* 相邻字的转角差**收一收**（文档 §3.5 第 5 条：别让字突然翻转 ✓）
   *   两趟平滑 + 硬上限 20° —— 细长 / 弯曲区域里也不会有一个字横过来 ✓ */
  for (let pass = 0; pass < 2 && glyphs.length > 2; pass++) {
    for (let i = 0; i < angles.length; i++) {
      const a = angles[Math.max(0, i - 1)];
      const b = angles[i];
      const c = angles[Math.min(angles.length - 1, i + 1)];
      angles[i] = (a + 2 * b + c) / 4;
    }
  }
  const MAX_D = 20 * Math.PI / 180;
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[i - 1];
    if (d > MAX_D) angles[i] = angles[i - 1] + MAX_D;
    else if (d < -MAX_D) angles[i] = angles[i - 1] - MAX_D;
  }
  for (let i = 0; i < glyphs.length; i++) glyphs[i].angle = angles[i];

  /* 🔴 **不再把字往陆地上挪** ✗✗（2026-10-22 用户："取消掉字避水机制"）
   *   以前有个 `snap`：字心落在水里就往最近的本块格子挪 1~2 格 ✓
   *   它会让**每个字各自往不同的岸边靠**，曲线看着就是七零八落 ✗
   *   现在字就老老实实待在基线上 —— 该压到水就压到水 ✓
   *   最后那道"字心 60% 在版图里，否则退回老画法"也一起撤了 ✓ */
  x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
  for (const gl of glyphs) {
    if (gl.x - fs < x0) x0 = gl.x - fs;
    if (gl.x + fs > x1) x1 = gl.x + fs;
    if (gl.y - fs < y0) y0 = gl.y - fs;
    if (gl.y + fs > y1) y1 = gl.y + fs;
  }


  /* 🔴 **NaN 一律当排不出来** ✗✗（2026-10-22 用户："七零八落"）
   *   只要有一个坐标 / 角度是 NaN，`locate` 的二分就全乱，
   *   字会散到任意位置 —— 宁可退回老画法，也不许画出一地碎字 ✓ */
  if (!Number.isFinite(fs)) return null;
  for (const gl of glyphs) {
    if (!Number.isFinite(gl.x) || !Number.isFinite(gl.y) || !Number.isFinite(gl.angle)) return null;
  }
  for (const p of poly) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  }

  return {
    name: String(text),
    fs, glyphs, comp: ci, runLen, thickness, angle: best.angle, score: best.score,
    bbox: { x0, y0, x1, y1 },
    /* 调试用（`LabelLayer.debug` 才画 ✓）：基线折线 / 选中的那段 / 版图包围盒 / 质心 */
    path: poly,
    run: { a: { x: startX, y: startY }, b: { x: endX, y: endY } },
    compBox: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
    centroid: { x: c.cx, y: c.cy },
  };
}
