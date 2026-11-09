'use strict';
/**
 * 「边界缝判据」的纯 JS 版 —— 从 web/js/gl.js 的片元着色器里**一对一**抄出来的
 * （2026-11-05 ✓ 抽出来只为**能单测** ✗ 渲染那边一个字都没动 ✓）
 *
 *   node tools/check_border_rules.js
 *
 * 为什么要有这一份：
 *   一条缝归哪条通道，判据原来散在四套射线里；2026-11-05 并成**一趟射线**之后，
 *   它们只是同一趟循环里的几个 if 块 ✓
 *   它们之间还**互相让位** ✗：水↔水归「水域」、荒地↔荒地归「荒地」，
 *   另外三条通道在那种缝上得让开 ✓ 这种"谁让谁"的关系在 GLSL 里根本没法单测 ✗
 *   → 抄成纯函数之后，语义有没有被悄悄改掉，跑一遍断言就知道 ✓
 *
 * ⚠ 抄的范围就这么点：**判据** ✓ 距离怎么算（垂距 / 跳步 stride）一条没抄 ✗
 *   那是射线的事，跟"这条缝属不属于这条通道"无关 ✓
 * ⚠ 输入从"纹理采样"换成了对象字段 ✓ 这是唯一改写的地方
 *   （本来也没法在 node 里跑 GLSL ✓）
 * ⚠ 普通脚本、不是 ES module ✗（浏览器里挂 window.BorderRules ✓
 *   node 里 require 得到同一份 ✓）
 */

/* ======================= 通道清单 =======================
 * 跟着色器里那五段画线的参数**一一对应** ✓（顺序 = **实际渲染顺序** ✓）
 *   title → uBorderW / uBorderA
 *   extra → uExtraW[ex] / uExtraA[ex]（多级边界：父级在前、剧本在后 ✓）
 *   paint → uPaintBorderW / uPaintBorderA（2026-11-05 起压在所有政治边界之上 ✓）
 *   water → uWaterBorderW / uWaterBorderA
 *   waste → uWasteBorderW / uWasteBorderA
 * ⚠ extra 那两个是**数组**（按 ex 取）✗ 别当标量用 ✓
 */
const CHANNELS = [
  { id: 'title', widthKey: 'uBorderW', alphaKey: 'uBorderA' },
  { id: 'extra', widthKey: 'uExtraW', alphaKey: 'uExtraA' },
  { id: 'paint', widthKey: 'uPaintBorderW', alphaKey: 'uPaintBorderA' },
  { id: 'water', widthKey: 'uWaterBorderW', alphaKey: 'uWaterBorderA' },
  { id: 'waste', widthKey: 'uWasteBorderW', alphaKey: 'uWasteBorderA' },
];

/* 一格"没有颜色"的记号 —— 着色器里是 vec3(-1.0) ✓（gl.js:730 lutColour 的 NONE 分支 ✓）
 * 判据只读 col.x ✓ 所以这里也只认第 0 个分量 < -0.5 ✓ */
const NO_COLOUR_X = -0.5;
/* 颜色差多少才算"两种颜色" —— 着色器里是 distance(ca, cb) > 0.02（gl.js:902 ✓）*/
const COLOUR_EPS = 0.02;

/** GLSL 的 distance(vec3, vec3) ✓ 原样照抄
 *  ⚠ 别换成"逐分量差都 > eps"✗ 语义不一样 ✓ */
function colDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/* ======================= viewsDiffer =======================
 * 照抄 gl.js:889-913 ✓ **五条规则的顺序一个字都没换** ✗
 * 顺序是有语义的：paintOnly 那条必须**最前面** ✓
 *   （放到颜色比较后面的话，年份视图里"颜色不同的两个没涂省份"照样会划线 ✗
 *     见 gl.js:890-896 那段注释 ✓）
 *
 * @param {object} A 起点侧（CellView）
 * @param {object} B 对面侧（CellView）
 * @param {number|boolean} paintOnly = 着色器的 uPaintOnly
 *        生产端只写 0 / 1（gl.js:3546 `this.paintOnly ? 1 : 0` ✓）所以这里按真假判就够了 ✓
 *        （GLSL 那句是 == 1 ✓ 但 0/1 之外的数压根到不了这儿 ✗）
 * @returns {boolean} 这两格在画面上算不算"两种东西"
 */
function viewsDiffer(A, B, paintOnly) {
  // ① 年份视图没开 → 未上色的省份之间不划国家级边界（**不管颜色** ✗）
  if (paintOnly && !A.painted && !B.painted) return false;
  const ca = A.col;
  const cb = B.col;
  // ② 两边都没颜色（无主地 / 海）→ 不划
  if (ca[0] < NO_COLOUR_X && cb[0] < NO_COLOUR_X) return false;
  // ③ 一边有一边没有 → 划
  if (ca[0] < NO_COLOUR_X || cb[0] < NO_COLOUR_X) return true;
  // ④ 颜色不同 → 划（国家与国家之间就是靠这条 ✓）
  if (colDistance(ca, cb) > COLOUR_EPS) return true;
  // ⑤ 颜色相同 → 一律比标记（三种情况一个不落 ✓ 见 gl.js:903-911 ✓）
  return A.label !== B.label;
}

/* ======================= classifySeam =======================
 * 一条缝**同时**可能属于好几条通道 ✓（用户点名要的：一条缝能同时是
 * 本层头衔 + 填色 + 多级第 0 环 ✓）所以返回的是**数组** ✗ 不是一个布尔 ✓
 *
 * 让位规则（2026-10-16 / 10-17 用户定的口径 ✓ 别自己发明 ✓）：
 *   · 水↔水     → **只**属 water  ✓ title / paint / extra 全让开
 *                 （"不存在一个水域能被涂色成为势力" ✓ 见 gl.js:804-818 ✓）
 *   · 荒地↔荒地 → **只**属 waste  ✓ 同上（gl.js:820-824 ✓）
 *   · 其它缝     → 照各自判据 ✓
 *   ⚠ 只让开"两边都是"的那条 ✗ —— 海岸线（水↔陆）、荒地的外缘（荒地↔陆）
 *     照旧归本层头衔线 / 填色通道 ✓（用户点名要的 ✓）
 *   ⚠ 让位是**整条通道**让，不是"这一条射线让" ✓
 *     着色器里写的是 continue（跳过这条缝接着往外找 ✓）不是 return ✓
 *     但对"这一格到这一格"这一条缝来说，含义就是"不属于我" ✓
 *
 *   ⚠ 通道**开没开**不归这里判 ✗ —— uBorderTitle / uBorderPaint / uWaterBorderOn /
 *     uWasteBorderOn、还有"浓度 0 就当没画"，全在着色器外面那几道闸里（gl.js:1176 /
 *     1186 / 1264 / 1294 ✓）这里只回答"这条缝属于谁" ✓
 *
 * @param {object} A   起点侧
 * @param {object} B   对面侧
 *        A/B 都要带 { col:[r,g,b], painted, tid, label, pid, water, waste, titleTids:[] }
 *          · col       屏幕上的颜色（没颜色 = [负数,...]，x < -0.5 ✓）
 *          · painted   玩家涂过没有
 *          · tid       **编辑层**的头衔序号（rayDistTitle / rayDistWater 里的 t ✓）
 *          · label     标记编号
 *          · pid       省份号（只做记录，判据不用 ✓）
 *          · water     waterIs(q) ✓（uWaterKind != 0 ✓）
 *          · waste     wasteIs(q) ✓（uKindTex == 6 且 uKindOn != 0 ✓）
 *          · titleTids 该格**各级 tier** 的 tid ✓ 下标跟 ctx.extraTiers **对齐** ✗
 *                      即 titleTids[ex] = 这一格在 extraTiers[ex] 那一层的 tid ✓
 *                      （多级边界每一环比的就是这个 ✓ 见 gl.js:1231-1237 ✓）
 *        ⚠ water / waste 这两个布尔由调用方按着色器算好再传 ✓ 别在这儿重新判 ✗
 *          尤其 pid == 0 的格子：waterAt / wasteIs 都是**先短路返回 false** 的
 *          （gl.js:653 / 680 ✓）→ 调用方也得带着这一条 ✓
 * @param {object} ctx { paintOnly, editTid, extraTiers:[], extraShows:[] }
 *        · paintOnly    = uPaintOnly（0/1 ✓）
 *        · editTid      = uEditTier（编辑层号 ✓ 判据用不到它，
 *                         它决定 A.tid / B.tid 是**哪一层**的 ✓ 留作记录 ✓）
 *        · extraTiers   = uExtraTier[ex]（-1 = 这一环没有层 → 跳过 ✓）
 *        · extraShows   = uExtraShow[ex]（0 = 用户没勾这一环 → 跳过 ✓）
 * @returns {Array<{ch:string, ex?:number}>} 按渲染顺序排：title → extra → paint → water → waste
 */
function classifySeam(A, B, ctx) {
  const c = ctx || {};
  const out = [];

  const bothWater = !!(A.water && B.water);
  const bothWaste = !!(A.waste && B.waste);
  /* 让位只认"**两边都是**" ✓（gl.js 的 pairW / pairX ✓）*/
  const givenWay = bothWater || bothWaste;
  /* 这几条通道比的都是**编辑层**那一级的 tid ✓ */
  const tidDiff = A.tid !== B.tid;

  /* ① 本层头衔线 + 多级边界共用一趟射线 ✓ 让开"水↔水 / 荒地↔荒地"
   *    ⚠ 地区边界在这一条里 ✓ 它根本不看玩家画了什么 ✓ */
  if (!givenWay && tidDiff) out.push({ ch: 'title' });

  /* ② 多级边界：一环一环比该层的 tid ✓
   *    GLSL 那三条闸照抄：
   *      ex >= uExtraCount → break（这里 extraTiers 的长度就是 uExtraCount ✓）
   *      uExtraShow[ex] == 0 → continue（用户没勾这一环 ✓）
   *      uExtraTier[ex] < 0  → continue（这一环没有层 ✓）
   *    ⚠ 第 0、1 环可以**同时**属于 ✓ 不是"取最粗的一条"✗
   *    ⚠ 2026-11-05 起 extra 画在 paint **下面**（用户定的优先级）✓ */
  if (!givenWay) {
    const tiers = c.extraTiers || [];
    const shows = c.extraShows || [];
    for (let ex = 0; ex < tiers.length; ex++) {
      if (!shows[ex]) continue;
      if (!(tiers[ex] >= 0)) continue;
      const ta = A.titleTids ? A.titleTids[ex] : undefined;
      const tb = B.titleTids ? B.titleTids[ex] : undefined;
      if (ta !== tb) out.push({ ch: 'extra', ex: ex });
    }
  }

  /* ③ 填色边界：viewsDiffer 为真 ✓ 让开同上（水压根不能涂 ✓）
   *    ⚠ 画在 extra **上面** ✓（用户定的：（涂色+剧本）＞父级＞其他 ✓）*/
  if (!givenWay && viewsDiffer(A, B, c.paintOnly)) out.push({ ch: 'paint' });

  /* ④ 水域：**两侧都得是水** ✓ 且编辑层 tid 不同 ✓（2026-11-09 起跟着色器一致 ✓）
   *    ⚠ 海岸线（水↔陆）不归这条 ✗ 一侧不是水 → 不算 ✓
   *    ⚠ 水↔水但 tid 相同 → 这条也不画 ✓
   *      而 title / paint / extra 已经让开了 → 这条缝**没有任何线** ✓ 正对 ✓ */
  if (bothWater && tidDiff) out.push({ ch: 'water' });

  /* ⑤ 荒地：跟水域那条**一字不差**，只有 waterIs → wasteIs ✓*/
  if (bothWaste && tidDiff) out.push({ ch: 'waste' });

  return out;
}

const API = {
  CHANNELS: CHANNELS,
  viewsDiffer: viewsDiffer,
  classifySeam: classifySeam,
};

/* 浏览器里当普通脚本加载时挂到 window ✓ */
if (typeof window !== 'undefined') window.BorderRules = API;
/* node 里 require 得到同一份 ✓（tools/check_border_rules.js 走这条 ✓）*/
if (typeof module !== 'undefined') module.exports = API;
