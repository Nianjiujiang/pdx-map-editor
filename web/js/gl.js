/**
 * WebGL2 渲染器。
 *
 * 三层间接查表，全程在 GPU 上：
 *
 *   屏幕像素 → uProv(省份 id 纹理) → uTitleMap[(省份, 层级)] → 头衔序号
 *            → uColorLut(头衔序号) → 实际颜色
 *
 * 这么绕的好处是：改一个头衔的颜色只要往 LUT 里写一个像素，
 * 不用碰那张 9216×4608 的大纹理，涂色是即时的。
 *
 * 两个正交的显示开关：
 *   uShowTitles —— 画不画头衔色
 *   uShowPaint  —— 画不画玩家手绘层
 *   头衔关 + 手绘开 = 只有自己涂过的东西，别的领地留空。
 *
 * 注意 uColorLut 里放的是**这一刻该显示的头衔色**，不是"头衔被改成了什么色"：
 * 玩家涂过的头衔，LUT 那份颜色只在 uShowPaint 开着时才换成涂色，
 * 关掉就换回游戏原色 —— 不然"藏掉填色"根本藏不掉（改过的色还顶在 LUT 里）。
 * 谁写进 LUT 由 app.js 的 lutColorOf() 说了算。
 *
 * 还有两件不受开关管的事：
 *   * 海、湖、河、不可通行区（伪头衔）始终显示 —— 它们不是领地，
 *     没有"上不上色"这回事，抹掉只会让地图看着像破了个洞；
 *   * 玩家手绘盖在头衔色上面 —— 玩家涂的是"地图上这块地方"，
 *     不管当前在看哪个层级，涂过的地方都保持那个色。
 */

const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uView;
out vec2 vMap;
void main() {
  vMap = uView.xy + aPos * uView.zw;
  vec2 clip = vec2(aPos.x * 2.0 - 1.0, aPos.y * 2.0 - 1.0);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp usampler2DArray;   // ← 数组采样器是**独立类型**，精度要单独声明 ✗
                                   //   （少了这行，编译到 uniform 就会报 No precision specified）

uniform usampler2D uProv;       // R16UI  province id（整张，老路）
// **分块路径**（原尺寸 16384×8192 用）：每层一块 ✓
// uUseTiles == 0 时下面的 provAt() 就退化成 texelFetch(uProv, ip, 0)，
// 跟加这套东西之前**完全等价** ✓ —— 所以半尺寸那套一点不受影响。
uniform usampler2DArray uProvArr; // R16UI  每层一块
uniform ivec2 uProvTiles;         // (tileW, tileH)
uniform int   uProvCols;          // 每行几块
uniform int   uUseTiles;          // 0 = 用 uProv（老路）, 1 = 用 uProvArr（分块）
uniform usampler2D uTitleMap;   // R16UI  (省份, 层级) → 头衔序号（**拍平成一维**存）
uniform sampler2D  uColorLut;   // RGBA8  头衔序号 -> 颜色
uniform sampler2D  uPaint;      // RGBA8  province -> 手绘色（alpha=0 表示没涂）
uniform usampler2D uPaintLabel; // R16UI  province -> 标记编号+1（0 = 没涂）
uniform ivec2 uMapSize;
uniform int   uTitleMapW;       // 归属表纹理的宽度
uniform int   uNumProvinces;    // 省份总数（拍平索引要用）
uniform int   uPaintW;          // 手绘层纹理的宽度（同样是拍平的）
uniform int   uTier;           // 颜色取哪一层
uniform int   uEditTier;       // **边界和悬停**看哪一层
uniform int   uShowTitles;
uniform int   uShowPaint;
uniform int   uShowWaste;       // 1 = 荒地显示自己的颜色，0 = 一律显示灰（荒漠涂色开关）
uniform vec3  uWasteGrey;       // 荒漠显示成什么灰（设置页可改）
uniform float uMix;
uniform int   uBorderTitle;     // 画不画头衔之间的分界线
uniform int   uBorderPaint;     // 画不画手绘色块的分界线
uniform int   uPaintOnly;       // 1 = **当前没停在年份视图**（CK3 那种没有年份层的也算）
                                //     JS 那边 = !(有年份层 && 视图停在年份层)
                                //     用途：没开年份视图时，未上色的地块之间不互相划界
/* ---- 水域边界（海洋 / 湖泊 / 河流 ✓ 用户定的四条 ✓）------------------------
 *   · **一直画** ✓ 只有"当前模式下能关的边界**全关了**"才跟着藏 ✓（uShowWater）
 *   · 浓度**实心** ✓（下面那笔不加浓度系数 ✓）
 *   · 粗细取值跟势力边界一样 ✓ 但**各是各的** ✗ 不做绑定（uWaterW 单独一个）
 *   · 判据：一侧是水、一侧不是 ✓（水与水之间不画 ✓ 那是海面 ✗）
 */
uniform int   uShowWater;       // 1 = 画水域边界
uniform float uWaterW;          // 水域边界粗细（**固定 1 格 × 基准线宽** ✓ 用户定的 ✓ 不跟链走 ✗）
uniform vec3  uSeaCol;          // 三个水域色：拿来认"这块地是不是水"
uniform vec3  uLakeCol;
uniform vec3  uRiverCol;
/* ---- 荒地边界（宽浓**跟"填色边界"同一套** ✓ 用户定的 ✓）---------------------
 *   · 所以它**没有自己的 uniform** —— 直接用 uPaintBorderW / uPaintBorderA ✓
 *     （那两个来自设置页的「势力线宽」和「势力边界浓度」✓ 默认 = 1.5 格 × 缩放、实心 ✓）
 *   · 范围：**所有**带荒地的缝都归这一趟 ✓（荒地↔国家 ✓、荒地↔荒地 ✓、荒地↔无主地 ✓）
 *     本层 / 多级边界那几趟一律让出来 ✗（水岸线先 break，归水域那条 ✓）
 *     ⚠ 我按"另一侧是不是真头衔"分过一次家 ✗ —— 荒地 ↔ 国家 被判给本层那条线，
 *       于是荒地轮廓看着还是**子级的宽浓**（细 + 50%）✗ 用户报的"怎么还是子级" ✓
 *   · 以前它没有自己这一趟 —— 荒地边缘是头衔那趟顺手画的 ✗
 *     于是宽浓跟着"本层那条线"走：剧本层 + 没开粒度时是 1.5 + 实心，
 *     细层视图里是 1.0 + 50% ✗（用户报的"开不开剧本会变" ✓）
 */
uniform float uBorderW;         // 分界线线宽，单位是**设备像素**
uniform int   uExtraCount;      // 链上还有几级（0~4）
uniform int   uExtraTier[4];    // 每一级看哪一层
uniform float uExtraW[4];       // 每一级的线宽（越往上越粗）
uniform int   uExtraShow[4];    // 每一级那个开关开没开
uniform float uExtraA[4];       // 每一级的浓度（本层之上：父级可半透明）
uniform float uBorderA;         // 分界线浓度
uniform float uPaintBorderW;    // **填色边界**自己的宽度（默认取上两层 ✓）
                                // 注意别跟上面的 uPaintW（手绘纹理宽度 ✗）撞名
uniform float uPaintBorderA;    // 填色边界的浓度（实心 ✓）

uniform float uMapPerPx;        // 一个设备像素等于多少个地图像素
uniform int   uNoAA;            // 1 = 关掉抗锯齿（整图导出用：每个像素取精确颜色）
uniform int   uLutW;
uniform int   uRealTitles;      // 序号 >= 它的都是海/湖/河/山这类伪头衔
uniform uint  uHoverTid;
uniform int   uHoverPaintOn;    // 1 = 高亮按涂色认族（只有剧本粒度 + 填色·边界时）
uniform vec3  uHoverPaint;      // 要高亮的那一族的涂色
uniform int   uHoverPid;        // >0 = 只高亮这一个地块（海/湖/荒地那种共享伪节点用）
uniform uint  uHoverLabel;      // 要高亮的那一族的**标记编号**（0 = 没涂）✓ 同色不同标记 = 两块 ✗
uniform vec3  uBackdrop;

in vec2 vMap;
out vec4 outColor;

const uint NONE = 65535u;

// 地图矩形之外：什么都不画，只铺一层底色。
// 不挡的话，视口一旦越界，采样会被 CLAMP_TO_EDGE 沿边缘拉成一条条横向色带。
const vec3 OUTSIDE = vec3(0.035, 0.043, 0.052);

/** (省份, 层级) → 头衔序号。
 *
 *  归属表是**拍平成一维**存的（索引 = 层级 × 省份数 + 省份），不是二维的：
 *  维多利亚3 有 4 万多个省份，拿「省份数 × 层级数」当纹理宽度会超掉显卡的
 *  MAX_TEXTURE_SIZE（常见是 16384），二维存根本传不上去。
 */
uint titleAt(uint pid, int tier) {
  int idx = tier * uNumProvinces + int(pid);
  return texelFetch(uTitleMap, ivec2(idx % uTitleMapW, idx / uTitleMapW), 0).r;
}

/** 手绘层也是**拍平**存的（索引 = 省份，宽度压在 uPaintW 以内） */
vec4 paintOf(uint pid) {
  int i = int(pid);
  return texelFetch(uPaint, ivec2(i % uPaintW, i / uPaintW), 0);
}

uint paintLabelOf(uint pid) {
  int i = int(pid);
  return texelFetch(uPaintLabel, ivec2(i % uPaintW, i / uPaintW), 0).r;
}

/** 一个省份此刻该显示成什么颜色。 */
vec4 colorOfPid(uint pid) {
  uint tid = titleAt(pid, uTier);
  // LUT 的 alpha 是**荒地标记**（setWasteland() 里按 meta.wasteland 打的；
  // 除此之外这个通道空着，谁也没用）。「荒漠涂色」关着时荒地一律显示灰 ——
  // 连自己涂的颜色也藏起来，这就是"不开就显示那种灰色"。
  vec4 lc = texelFetch(uColorLut, ivec2(int(tid) % uLutW, int(tid) / uLutW), 0);
  // 无主地（NONE）在 LUT 里没有自己那一格，越界读到的 alpha 是未定义值 ——
  // 它**不是荒地**，别被那个值判成"该显示荒地灰"✗（否则无主地会跟荒地一个色）
  // **手绘在最上层，连荒地那层灰也压得住。**
  // 荒地只有开着「荒地可上色」才涂得上去，所以"涂过"就等于"允许涂"，
  // 那就该显示他自己涂的色。早先荒地灰排在手绘**前面**，于是荒地涂了也是灰
  // （用户报的：开了允许上色还是没法上色，始终灰色）。
  // 其余照旧：不管这一层此刻是海/湖这类伪头衔，还是压根没有归属，
  // 也不管「浓度」调到多少 —— 手绘不受浓度影响（浓度是给头衔色用的）。
  if (uShowPaint == 1) {
    vec4 pc = paintOf(pid);
    if (pc.a > 0.5) return vec4(pc.rgb, 1.0);
  }

  // 荒地标记（LUT 的 alpha）：没涂过、且「荒漠涂色」关着 → 一律显示那层灰
  if (uShowWaste == 0 && tid != NONE && lc.a > 0.5) {
    return vec4(uWasteGrey, 1.0);
  }

  // 没有归属的地块画成中性灰（150,150,150），不是透明 —— 透明的话露出来的
  // 是深色底，跟海、跟空地都分不清。
  if (tid == NONE) return vec4(150.0 / 255.0, 150.0 / 255.0, 150.0 / 255.0, 1.0);
  int t = int(tid);
  vec4 c = lc;                      // 上面已经取过这张 LUT 了，别取第二遍

  // 头衔色在这里就按「浓度」淡掉 —— 手绘在上面那一步已经返回了，不受浓度影响。
  // （早先浓度是在最外面统一 mix 的，于是连手绘一起淡掉。）
  return vec4(mix(uBackdrop, c.rgb, uMix), uShowTitles == 1 || t >= uRealTitles ? 1.0 : 0.0);
}

/** 地图像素 → 省份 id：老路一张整图，新路按块取（两者结果一致） */
uint provAt(ivec2 ip) {
  if (uUseTiles == 0) return texelFetch(uProv, ip, 0).r;
  ivec2 t = ivec2(ip.x / uProvTiles.x, ip.y / uProvTiles.y);
  ivec2 l = ivec2(ip.x % uProvTiles.x, ip.y % uProvTiles.y);
  return texelFetch(uProvArr, ivec3(l, t.y * uProvCols + t.x), 0).r;
}

vec4 colorAt(ivec2 ip) {
  ip = clamp(ip, ivec2(0), uMapSize - 1);
  return colorOfPid(provAt(ip));
}

uint pidAt(ivec2 ip) {
  ip = clamp(ip, ivec2(0), uMapSize - 1);
  return provAt(ip);
}

uint tidAt(ivec2 ip) {
  return titleAt(pidAt(ip), uEditTier);
}

vec4 paintAt(ivec2 ip) {
  return paintOf(pidAt(ip));
}

/** 这个像素的标记编号（0 = 没涂） */
uint paintLabelAt(ivec2 ip) {
  return paintLabelOf(pidAt(ip));
}

/** 手绘层上两个像素算不算不同的块。
 *
 *  一个涂了一个没涂、涂的色不同 —— 都算不同块。
 *  **同色但标记不同也算** —— 这跟 JS 那边切手绘色块的规则必须一致
 *  （rebuildPaintBlocks 也是"同色 + 同标记"才算一块），
 *  不然两块明明是两个标记、中间却没有线，看着就是一坨。 */
bool paintDiffers(ivec2 a, ivec2 b) {
  vec4 pa = paintAt(a);
  vec4 pb = paintAt(b);
  bool ta = pa.a > 0.5;
  bool tb = pb.a > 0.5;
  if (ta != tb) return true;
  if (!ta) return false;
  if (any(notEqual(pa.rgb, pb.rgb))) return true;
  return paintLabelAt(a) != paintLabelAt(b);
}

//: 沿一个方向最多找多少格。缩到全图时一个屏幕像素能盖住几十个地图像素，
//: 半径要跟着它走；48 是给"窗口拉得很窄、还缩到底"留的余量。
const int MAXR = 48;

/** LUT 里某一格的 alpha = **荒地标记**（setWasteland() 按 meta.wasteland 打的）。
 *
 *  无主地（tid == NONE）在 LUT 里**没有自己那一格**，直接 texelFetch 会读到
 *  越界坐标 —— GLSL 那边越界是未定义值（有的驱动给 0、有的按 CLAMP 给边缘那格），
 *  于是"无主地是不是荒地"会随驱动变。这里统一当它**不是荒地**（alpha 0）✓ */
float wasteAlphaOf(uint t) {
  if (t == NONE) return 0.0;
  return texelFetch(uColorLut, ivec2(int(t) % uLutW, int(t) / uLutW), 0).a;
}

/** 两点的"原版色"（LUT 里那个头衔的颜色）✓ */
vec3 lutColour(ivec2 ip) {
  uint tid = titleAt(pidAt(ip), uTier);
  if (tid == NONE) return vec3(-1.0);
  return texelFetch(uColorLut, ivec2(int(tid) % uLutW, int(tid) / uLutW), 0).rgb;
}

/** 这块地是不是水域（海洋 / 湖泊 / 河流）
 *
 *  判法：拿它 LUT 里的颜色跟**设置里那三个水域色**比 ✓
 *  （用户在设置里改了水域颜色，这里跟着变 ✓ 因为颜色是每帧传上来的 ✓）
 *  没颜色的地（海以外的无主地 ✓）不算水 ✓
 *
 *  ⚠ 它得排在 rayDistTitle 前面 ✓ —— 那几趟要靠它把**水岸线让出来** ✓
 *    （GLSL 要求先声明后使用，测试里也有那一条 ✗ 挪下去就编译不过 ✓）
 */
bool isWaterAt(ivec2 ip) {
  vec3 c = lutColour(ip);
  if (c.x < -0.5) return false;
  if (distance(c, uSeaCol) <= 0.02) return true;
  if (distance(c, uLakeCol) <= 0.02) return true;
  if (distance(c, uRiverCol) <= 0.02) return true;
  return false;
}

/** 沿 dir 方向找到最近的一条分界线，返回它到当前片元的**垂距**（地图像素）。

    必须往外走，不能只看紧邻那一格：缩小时一个屏幕像素盖住好几个地图像素，
    分界线完全可能落在两个采样点中间，只看紧邻就会整条漏掉（边框时有时无）。
    走到第一格不一样的邻居就停 —— 那就是这个方向上最近的一条缝。

    四个方向取最小，得到的就是到最近那条像素边的真实垂距：缝本身是横平竖直的，
    而我们必定落在它那一格的跨度之内，所以不用开方。 */
float rayDistTitle(ivec2 ip, vec2 f, ivec2 dir, uint t, int R, int tier, bool wasteOnly) {
  bool _wSelf = isWaterAt(ip);
  for (int k = 1; k <= MAXR; k++) {
    if (k > R) break;
    // 写成 ivec2(dir.x * k, dir.y * k) 而不是 dir * k ——
    // 整数向量乘整数标量在 GLSL ES 3.0 里规不规范我记不准，展开最保险
    // tier：看哪一层的边界（-1 表示跟 uEditTier 一样）
    ivec2 q = ip + ivec2(dir.x * k, dir.y * k);
    /* **水岸线不归这一趟** ✓（用户定的：它固定宽 1、实心 ✓ 由水域那一趟画 ✓）
     *   用 break 不用 continue：continue 会让射线**穿过水面**继续往外找 ✗
     *   → 把对岸那条线当成本格的边界画上来（线就跑到岸两边去了 ✗）*/
    if (isWaterAt(q) != _wSelf) break;
    uint tt = tier < 0 ? tidAt(q) : titleAt(pidAt(q), tier);
    // **海与海之间不画边界**（海岸线保留）✓ —— 这个跳过只管"两侧都是伪头衔、
    // 而且都不是荒地"的情形 ✓（荒地在下面**单独判**，不靠伪头衔这个身份 ✗）
    //   · **无主地（NONE）不是地形，是地** —— 它跟海之间那条就是海岸线，
    //     得画 ✓（以前把 NONE 一起算成"伪头衔"，无主地挨着海那条海岸线
    //     就整条没了 ✗）
    bool _tw = (t != NONE && t >= uint(uRealTitles));
    bool _uw = (tt != NONE && tt >= uint(uRealTitles));
    /* **这一格算不算"荒地边"**：一门心思看 LUT 那个荒地标记 ✓
     *   ⚠ 不许再加"必须是伪头衔（>= uRealTitles）"的前置 ✗ ——
     *     那是 CK3 / EU4 那类数据的习惯，**EU5 不成立**：
     *     EU5 的荒地节点序号**混在真头衔范围内**（1819 个荒地里有 1818 个 < numRealTitles ✗，
     *     阿卜杜勒库里岛那种 —— 打空白剧本补丁时踩过同一个坑 ✓）
     *     加了那个前置 → EU5 的荒地缝**一条都进不来** ✗ → 全落到"本层那条线"上（50%）✗
     *     用户报的"EU5 的荒地不会像其他那样划界，用的全是 50%" ✓ 就是它 ✓
     *   （wasteAlphaOf 自己对 NONE 返回 0 ✓ 所以无主地不会被误判成荒地 ✓）*/
    bool _hasWaste = wasteAlphaOf(t) > 0.5 || wasteAlphaOf(tt) > 0.5;
    /* **荒地边单独走一趟**（wasteOnly）✓ —— 宽浓吃「填色边界」那套 ✓（用户定的 ✓）
     *   也就是"以国家为准"：跟势力/填色那条线一样粗、一样浓 ✓
     *   —— 这一趟管的是**所有**带荒地的缝：荒地 ↔ 国家 ✓、荒地 ↔ 荒地 ✓、
     *      荒地 ↔ 无主地 ✓（荒地 ↔ 水 上面就 break 了，归水域那条 ✓）
     *   ⚠ 别按"另一侧是不是真头衔"再分家 ✗ —— 我这么分过一次：
     *     荒地 ↔ 国家（荒地周围绝大多数就是这种）全被判给"本层那条线"，
     *     于是荒地轮廓看着还是**子级的宽浓**（细 + 50%）✗ 用户报的"怎么还是子级" ✓
     *   所以正常那几趟（本层 / 多级边界）**把所有荒地缝都让出来** ✗，
     *   只由这一趟按填色那套画 ✓（两头必须一起改：只加新那趟不让旧的 =
     *   同一条缝画两遍，粗的压细的 ✗）
     *   理由：以前荒地边缘是这一趟顺手画的 ✗ → 跟着"本层那条线"在
     *   1.5+实心（剧本层）和 1.0+50%（细层）之间跳 ✗ */
    if (_hasWaste != wasteOnly) continue;
    // 两侧都是伪头衔、且都不是荒地 → 海与海之间那种，不画 ✓
    if (_tw && _uw) {
      float wa = wasteAlphaOf(t);
      float wb = wasteAlphaOf(tt);
      if (wa < 0.5 && wb < 0.5) continue;
    }
    /* ⚠ **这里一个字都不许动** ✗ —— 用户定的规矩：
     *
     *   · **地区边界绝对不要动** ✓ 它根本不看玩家画了什么 ✓
     *     而 rayDistTitle 是「本层头衔线 + 多级边界」**共用**的 ✓
     *     在这里加"涂过就跳过"的闸 ✗ 会同时把地区边界一起吃掉 ✗
     *     （我这么干过一次：地区边界全没了 ✓ 挨了一顿 ✓）
     *
     *   · 国家 / 玩家填色的边界规矩，全在那个判据函数里 ✓（名字不带括号写，
     *     免得被测试当成一次调用 ✗ —— 它连注释一起扫 ✓ 我踩过 ✓）
     *     填色边界**不开** → 按当前剧本的默认边界 ✓ 玩家怎么画都不影响 ✓
     *     填色边界**开**   → 一律按色块（颜色 + 标记）划界 ✓
     *                        且**未上色与未上色之间不划界** ✓
     *     （那正是手绘层判据的语义 ✓ 别在这儿重复实现 ✗）
     */
    if (tt != t) {
      float kf = float(k);
      if (dir.x != 0) return dir.x > 0 ? kf - f.x : f.x + kf - 1.0;
      return dir.y > 0 ? kf - f.y : f.y + kf - 1.0;
    }
  }
  return 1e9;
}

/** 同上，但看的是手绘层的分界 */
/** 手绘那条边界线的判据 ✓
 *
 * **用户定的口径（权威 ✓ 别自己发明 ✓）**：
 *
 *   填色边界**开着**时 → 这条线看**颜色 + 标记**，一个不同就划 ✓
 *     颜色取"显示出来的那个" ✓：**玩家涂过的用玩家色 ✓ 没涂的用当前剧本色** ✓
 *
 *     · 两边都**没有颜色**（海 / 无主地）→ **不划** ✓
 *         （用户说的"未上色与未上色之间不划界"就是这个意思 ✓
 *          不是"玩家没涂过"✗ —— 我按后者理解过一次，结果国家之间全没线 ✗ 挨了一顿 ✓）
 *     · 一边有颜色一边没有 → 划 ✓
 *     · **颜色不同 → 划** ✓ ← **国家与国家之间就是靠这条** ✓
 *     · 颜色相同 → **一律比标记** ✓ 三种情况都比 ✓
 *         两边都涂过 → 比手绘层的标记 ✓
 *         两边都没涂 → 比**头衔** ✓（同色不同国也得有线 ✓ 比如 HOI4 同色国家 ✓）
 *         一涂一没涂 → 一边有标记一边没有 → **标记不同 → 划** ✓
 *
 *   填色边界**不开**时 → 这条 pass 根本不跑 ✓（外面有闸 ✓）
 *     国家/地区边界走「头衔线 + 多级边界」那条路 ✓ = 当前剧本的默认边界 ✓
 *     玩家怎么画都不影响 ✓ **那条路一个字都不许动** ✗（地区边界就是它 ✓）
 */
/* **屏幕上那一格到底是什么颜色** - 判定必须用玩家看到的那个，不是 LUT 原色。
 *
 * 荒地（LUT 的 alpha 打了标记）在「荒漠 / 荒地涂色」关着时，画面上是 uWasteGrey；
 * 而 lutColour 返回的是 LUT 里的原色，跟屏幕上那个灰不是一个东西。
 * 势力那一趟一直是按"灰"处理的（wasteAlphaOf + 灰），填色这趟以前按原色比，
 * 于是荒地那条边两趟结果对不上（用户报的出入）。
 */
vec3 shownColour(ivec2 ip) {
  vec3 c = lutColour(ip);
  if (c.x < -0.5) return c;                       // 没颜色（海 / 无主地）原样返回
  uint tid = titleAt(pidAt(ip), uTier);
  if (uShowWaste == 0 && tid != NONE && wasteAlphaOf(tid) > 0.5) return uWasteGrey;
  return c;
}

bool shownDiffers(ivec2 a, ivec2 b) {
  vec4 pa = paintAt(a);
  vec4 pb = paintAt(b);
  bool ta = pa.a > 0.5;
  bool tb = pb.a > 0.5;
  /* **年份视图没开 → 未上色的省份之间，一律不划国家级边界** ✓
   *   （用户定的 ✓ **不管颜色** ✗ —— 两个都没涂就是没线 ✓）
   *   ⚠ 这一行必须在**最前面** ✓：
   *     放到颜色比较后面的话，"颜色不同的两个没涂省份"照样会划一条 ✗
   *     —— 那是**年份视图里**的规矩 ✓；没开年份视图时不该有这些线 ✓
   *     （uPaintOnly 的定义就是"当前没停在年份层" ✓ CK3 那种没有年份层的也算 ✓）
   */
  if (uPaintOnly == 1 && !ta && !tb) return false;
  vec3 ca = ta ? pa.rgb : shownColour(a);          // 显示出来的颜色 ✓
  vec3 cb = tb ? pb.rgb : shownColour(b);
  if (ca.x < -0.5 && cb.x < -0.5) return false;  // 两边都没颜色（海 / 无主地）→ 不划 ✓
  if (ca.x < -0.5 || cb.x < -0.5) return true;   // 一边有一边没有 → 划 ✓

    if (distance(ca, cb) > 0.02) return true;      // **颜色不同 → 划**（国家之间 ✓）
  /* 颜色相同 → **一律比标记** ✓ 三种情况一个不落（用户明确要求 ✓）
   *
   * ⚠ 这里**只有一套编号** ✗ —— JS 那边 syncAllPaintLabels 给**每一块地**都写了标记：
   *     涂过的地 = 你填的那个名 ✓
   *     没涂的地 = **它自己原版的国名** ✓（**不是 0** ✗ —— 用户点醒的：没涂过的地方也有标记 ✓）
   *   所以"原版那块地"和"你涂出来的那块地"**名字一样就是同一个编号** ✓
   *   → 用自己的色 + 自己的名涂自己那块 → 两边同号 → **不划** ✓（本来就该这样 ✓）
   *   我以前在这里又把没涂的地换成比头衔 ✗ —— 两套编号对不上，比出来永远是"不同" ✓
   */
  return paintLabelAt(a) != paintLabelAt(b);
}

/** 沿 dir 找最近的一条**水岸线**（一侧是水、一侧不是 ✓） */
float rayDistWater(ivec2 ip, vec2 f, ivec2 dir, int R) {
  bool wa = isWaterAt(ip);
  for (int k = 1; k <= MAXR; k++) {
    if (k > R) break;
    ivec2 q = ip + ivec2(dir.x * k, dir.y * k);
    if (isWaterAt(q) != wa) {
      float kf = float(k);
      if (dir.x != 0) return dir.x > 0 ? kf - f.x : f.x + kf - 1.0;
      return dir.y > 0 ? kf - f.y : f.y + kf - 1.0;
    }
  }
  return 1e9;
}

/** 这一格是**水岸线或荒地边**吗（不归手绘那趟管 ✓）—— 见下面 rayDistPaint ✓ */
bool _terrainSeam(ivec2 ip, ivec2 q) {
  if (isWaterAt(ip) != isWaterAt(q)) return true;                 // 水岸线 ✓
  uint t0 = titleAt(pidAt(ip), uTier);
  uint t1 = titleAt(pidAt(q), uTier);
  return wasteAlphaOf(t0) > 0.5 || wasteAlphaOf(t1) > 0.5;        // 荒地边 ✓
}

float rayDistPaint(ivec2 ip, vec2 f, ivec2 dir, int R) {
  // **显示出来的颜色边界**：手绘层不同 ✓ 或**原版色**不同 ✓ 都算
  //（地图本来就有的剧本色也算 ✓ —— 不用"先涂一笔"✗）
  // 每步比这两样就够（2~4 次取纹理 ✓），不再算 showPaint/showTitles/荒地那一堆分支 ✗
  for (int k = 1; k <= MAXR; k++) {
    if (k > R) break;
    ivec2 q = ip + ivec2(dir.x * k, dir.y * k);
    /* **水岸线 / 荒地边不归这一趟** ✓（用户定的：那两条固定宽 1、实心 ✓ 各有各的一趟 ✓）
     *   用 break 不用 continue：continue 会穿过水面/荒地继续往外找 ✗
     *   → 把对岸那条色块线当成本格的边界画上来（线跑到岸两边去 ✓）*/
    if (_terrainSeam(ip, q)) break;
    if (shownDiffers(ip, q)) {
      float kf = float(k);
      if (dir.x != 0) return dir.x > 0 ? kf - f.x : f.x + kf - 1.0;
      return dir.y > 0 ? kf - f.y : f.y + kf - 1.0;
    }
  }
  return 1e9;
}

void main() {
  if (vMap.x < 0.0 || vMap.y < 0.0 ||
      vMap.x >= float(uMapSize.x) || vMap.y >= float(uMapSize.y)) {
    outColor = vec4(OUTSIDE, 1.0);
    return;
  }

  // 4 点超采样。偏移必须按**屏幕**算（uMapPerPx = 一个屏幕像素占多少地图像素），
  // 不能写成固定的地图像素 —— 那是个随缩放放大的坑：
  // 放大到 18 倍时 0.25 个地图像素 = 4.5 个屏幕像素，四个点摊开跨 9 个像素，
  // 两个色块之间就被平均出一条 9 像素宽的纯色混色带，越放大越糊。
  // 锁在一个屏幕像素以内，接缝就永远只有一格过渡。
  //
  // 位置用 4 点旋转网格（RGSS）而不是正方形四角：斜边上过渡层次更多，
  // 不会出现"要么纯色要么 50%"的硬台阶。最大偏移 0.5 个屏幕像素。
  // 导出整图时**关掉抗锯齿** ✓ —— 那时一个屏幕像素正好等于一个地图像素，
  // 四点超采样会把相邻两个色块的颜色平均出一条混色带，放大看就是"糊的区域"。
  // 屏幕上不动（uNoAA=0），观感保持原样 ✓。
  float pu = uNoAA == 1 ? 0.0 : uMapPerPx;
  vec4 c0 = colorAt(ivec2(floor(vMap + vec2( 0.5,      0.16667) * pu)));
  vec4 c1 = colorAt(ivec2(floor(vMap + vec2(-0.16667,  0.5    ) * pu)));
  vec4 c2 = colorAt(ivec2(floor(vMap + vec2( 0.16667, -0.5    ) * pu)));
  vec4 c3 = colorAt(ivec2(floor(vMap + vec2(-0.5,     -0.16667) * pu)));

  vec3  acc = c0.rgb * c0.a + c1.rgb * c1.a + c2.rgb * c2.a + c3.rgb * c3.a;
  float cov = (c0.a + c1.a + c2.a + c3.a) * 0.25;
  vec3  tc  = cov > 0.002 ? acc / max(c0.a + c1.a + c2.a + c3.a, 0.001) : vec3(0.0);

  vec3 col = mix(uBackdrop, tc, cov);

  ivec2 ip = ivec2(floor(vMap));
  vec2  f  = vMap - vec2(ip);      // 落在这一格里的哪个位置，0..1

  // 边界分两套，各自开关：
  //   头衔边界 —— 不同头衔之间画线（跟颜色开关无关，关掉头衔色时线还在）
  //   手绘边界 —— 涂了/没涂之间、或者涂的色不一样之间画线
  //
  // 不能写成"这个像素跟四邻不一样就涂黑" —— 分界线两侧的像素各自都满足条件，
  // 于是线变成两个地图像素宽、两边各占一格的一条半透明带子，放大了就是糊的。
  //
  // 改成算**到分界线的距离**，再套一条宽度锁在设备像素上的抗锯齿斜坡：
  // 屏幕上永远是同一条细实线，缩放多少都不变粗细。
  // **无主地块也是一块地** ✗ —— 这道闸以前写的是「本格在编辑层有头衔」，
  // 而"无主地"在编辑层拿到的正是 NONE，于是它的**整段边界计算全被跳过**：
  //   · 国家 ↔ 无主地：只有国家那一半画得出线，另一半整段没有 →
  //     看着就是"国家跟无主地之间没画边界"（用户报的 ✓）
  //   · 无主地 ↔ 海、无主地 ↔ 荒地：同理只有半边
  // 该跳过的是**根本没有省份的地图底**（provAt = 0）✓ 无主地照样要算。
  if (pidAt(ip) != 0u) {
    // 只要这个半径以内看得见线；半径之外算出来也是 0，不用白找
    // （荒地那条用的是**填色边界**的宽浓 ✓ 所以这里不用再单列一个 ✓）
    int R = int(clamp(ceil(0.5 * uMapPerPx
                           * (max(max(uBorderW, uPaintBorderW), uWaterW) + 1.0)),
                           1.0, float(MAXR)));
    float dTitle = 1e9;
    float dPaint = 1e9;
    float dWater = 1e9;
    float dWaste = 1e9;
    /* **水域边界**：一直画 ✓ 只有"当前模式里能关的边界全关了"才跟着藏 ✓（JS 给 uShowWater） */
    if (uShowWater == 1) {
      dWater = min(dWater, rayDistWater(ip, f, ivec2( 1, 0), R));
      dWater = min(dWater, rayDistWater(ip, f, ivec2(-1, 0), R));
      dWater = min(dWater, rayDistWater(ip, f, ivec2( 0, 1), R));
      dWater = min(dWater, rayDistWater(ip, f, ivec2( 0,-1), R));
      // **荒地边界**跟它一个待遇（都"一直画" ✓）—— 但宽浓吃的是**填色边界**那一套 ✓
      //   （见下面 dWaste 那一段 ✓ 不归本层/多级那几趟 ✓ 见 rayDistTitle）
      uint t9 = tidAt(ip);
      dWaste = min(dWaste, rayDistTitle(ip, f, ivec2( 1, 0), t9, R, -1, true));
      dWaste = min(dWaste, rayDistTitle(ip, f, ivec2(-1, 0), t9, R, -1, true));
      dWaste = min(dWaste, rayDistTitle(ip, f, ivec2( 0, 1), t9, R, -1, true));
      dWaste = min(dWaste, rayDistTitle(ip, f, ivec2( 0,-1), t9, R, -1, true));
    }
    if (uBorderTitle == 1) {
      uint t0 = tidAt(ip);
      // 正常那条（**荒地边缘和水岸线都让出来** ✓）
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 1, 0), t0, R, -1, false));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2(-1, 0), t0, R, -1, false));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 0, 1), t0, R, -1, false));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 0,-1), t0, R, -1, false));
    }
    if (uBorderPaint == 1) {
      dPaint = min(dPaint, rayDistPaint(ip, f, ivec2( 1, 0), R));
      dPaint = min(dPaint, rayDistPaint(ip, f, ivec2(-1, 0), R));
      dPaint = min(dPaint, rayDistPaint(ip, f, ivec2( 0, 1), R));
      dPaint = min(dPaint, rayDistPaint(ip, f, ivec2( 0,-1), R));
    }
    // 过渡带 ≈ 一个设备像素（**要提到外面**：下面多级边界那圈也要用 ✗）
    float ramp = 0.5 * uMapPerPx;
    if (dTitle < 1e8) {
      float bw = 0.5 * uBorderW * uMapPerPx;     // 半宽
      float b  = 1.0 - smoothstep(bw - ramp, bw + ramp, dTitle);
      col = mix(col, vec3(0.035, 0.045, 0.06), b * uBorderA);
    }
    /* **荒地边界**：宽与浓**跟"填色边界"同一套** ✓（用户定的 ✓）——
     *   也就是受设置页那两个滑条调：「**势力线宽**」（pw → uPaintBorderW ✓）与
     *   「**势力边界浓度**」（ca → uPaintBorderA ✓，默认 100 = 实心 ✓）
     *   于是它跟填色线永远一样粗一样浓，不再是自己的固定档 ✓
     *   范围只管"两侧都没有真头衔"的荒地缝 ✓ —— 荒地 ↔ 国家那条归国家那趟 ✓
     *   它以前是借头衔那一趟画的 ✗ → 跟着剧本/粒度在 1.5+实心 与 1.0+50% 之间跳 ✓ */
    if (dWaste < 1e8) {
      float bwwd = 0.5 * uPaintBorderW * uMapPerPx;
      float bwd  = 1.0 - smoothstep(bwwd - ramp, bwwd + ramp, dWaste);
      col = mix(col, vec3(0.035, 0.045, 0.06), bwd * uPaintBorderA);
    }
    // **填色边界**：永远用自己那套（链上最粗那条的粗细 + 实心），跟本层互不干扰 ✓
    if (dPaint < 1e8) {
      float bwp = 0.5 * uPaintBorderW * uMapPerPx;
      float bp  = 1.0 - smoothstep(bwp - ramp, bwp + ramp, dPaint);
      col = mix(col, vec3(0.035, 0.045, 0.06), bp * uPaintBorderA);
    }
    /* **水域边界**：浓度**实心** ✓（不加浓度系数 ✓ 用户定的 ✓）
     * 粗细固定 1 格 × 基准线宽（uWaterW ✓ 用户定的 ✓ 不再跟链/本层宽走 ✗）*/
    if (dWater < 1e8) {
      float bww = 0.5 * uWaterW * uMapPerPx;
      float bwv = 1.0 - smoothstep(bww - ramp, bww + ramp, dWater);
      col = mix(col, vec3(0.035, 0.045, 0.06), bwv);
    }
    // **多级边界**：粒度那层之上，一层比一层粗（地区 → 国家）——
    // 中间那些"年份"层跳过（不然 1618 + 省份 会冒出 1789 那条 ✗）。
    for (int ex = 0; ex < 4; ex++) {
      if (ex >= uExtraCount) break;
      if (uExtraShow[ex] == 0) continue;
      int et = uExtraTier[ex];
      if (et < 0) continue;
      uint te = titleAt(pidAt(ip), et);
      int Re = int(clamp(ceil(0.5 * uMapPerPx * (uExtraW[ex] + 1.0)), 1.0, float(MAXR)));
      float de = 1e9;
      de = min(de, rayDistTitle(ip, f, ivec2( 1, 0), te, Re, et, false));
      de = min(de, rayDistTitle(ip, f, ivec2(-1, 0), te, Re, et, false));
      de = min(de, rayDistTitle(ip, f, ivec2( 0, 1), te, Re, et, false));
      de = min(de, rayDistTitle(ip, f, ivec2( 0,-1), te, Re, et, false));
      if (de < 1e8) {
        float bwe = 0.5 * uExtraW[ex] * uMapPerPx;
        float be  = 1.0 - smoothstep(bwe - ramp, bwe + ramp, de);
        col = mix(col, vec3(0.035, 0.045, 0.06), be * uExtraA[ex]);
      }
    }
  }

  // 悬停高亮：整个头衔一起亮。
  // 亮的是 **uEditTier** 那一级 —— 换粒度时（看 1444 的配色、按省份改）
  // 亮起来的那块必须正好是"点下去会涂到的那块"，不然根本不知道会改到谁。
  // 注意：**不看 uShowTitles**。关掉原版颜色之后图上是底色，
  // 但悬停仍然要亮起来 —— 不然根本不知道会涂到哪一块。
  if (uHoverPid > 0) {
    // 海/湖/荒地：只点亮光标底下这**一块**（它们共用同一个伪节点，按头衔会整片亮 ✗）
    if (int(pidAt(ip)) == uHoverPid) col = mix(col, vec3(1.0, 1.0, 1.0), 0.18);
  } else if (uHoverPaintOn == 1) {
    // 整族高亮：按**显示色 + 标记**认 —— 涂过的用手绘色，没涂的用原版色。
    // 这样"取大清的颜色涂俄罗斯"之后，大清和俄罗斯会一起亮 ✓
    // 但**同色不同标记**是两块 ✗ → 标记也得对上（0 = 没涂，跟没涂的一起 ✓）
    vec4 hp = paintAt(ip);
    vec3 hc = hp.a > 0.5 ? hp.rgb : lutColour(ip);
    // 颜色对上之后：
    //   · **没涂过的同色地** → 算同一族 ✓（它的名字来自原版 ✓，比如开局那块瓦窑堡 ✓）
    //   · **涂过的** → 必须同一标记 ✓（同色不同标记是两块 ✗）
    bool sameLabel = (paintLabelAt(ip) == uHoverLabel);
    if (hc.x > -0.5 && distance(hc, uHoverPaint) < 0.01 && sameLabel) {
      col = mix(col, vec3(1.0, 1.0, 1.0), 0.18);
    }
  } else if (uHoverTid != NONE) {
    uint h = pidAt(ip);
    if (h != 0u && titleAt(h, uEditTier) == uHoverTid) {
      col = mix(col, vec3(1.0, 0.99, 0.9), 0.24);
    }
  }

  outColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('着色器编译失败：' + log);
  }
  return sh;
}

function makeTexture(gl, w, h, internal, format, type, data, filter) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  return tex;
}

export class MapRenderer {
  constructor(canvas, meta) {
    this.canvas = canvas;
    this.meta = meta;
    this.mapW = meta.mapWidth;
    this.mapH = meta.mapHeight;
    this.noTitle = meta.noTitle ?? 65535;
    this.numProvinces = meta.numProvinces;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('这个浏览器/显卡不支持 WebGL2，换 Chrome 或 Edge 试试。');
    this.gl = gl;

    // 显卡驱动重置 / 显存吃紧时浏览器会把 WebGL 上下文整个收走 —— 不接住的话
    // 每帧 GL 调用全部静默 no-op，画面冻结成白板还没任何提示。preventDefault
    // 表示"我们知道出事了"；真恢复要重建全部纹理，直接提示用户刷新最稳。
    this.onContextLost = null;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.dirty = false;
      if (this.onContextLost) this.onContextLost();
    });

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    // **地图比"单张贴图上限"大时不再拒绝** ✓ —— setData 里会把它就地切成一块块贴图 ✓
    // （手机 GPU 常见上限只有 4096 / 8192：CK3 9216×4608、EU5 8192×4096、
    //   米勒投影 11680×5760 都塞不进一张 ✗ 以前这里直接抛错 → 整张图加载不出来 ✗）
    // 只有小到连一块切片都放不下的设备才真的没救 ✓
    if (maxTex < 256) {
      throw new Error(`这个设备的贴图上限只有 ${maxTex}px，放不下任何地图切片。`);
    }
    this.maxTex = maxTex;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败：' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;

    this.uni = {};
    for (const n of ['uView', 'uProv', 'uProvArr', 'uProvTiles', 'uProvCols', 'uUseTiles', 'uNoAA', 'uShowWaste', 'uTitleMap', 'uColorLut', 'uPaint', 'uPaintLabel',
                     'uMapSize', 'uTitleMapW', 'uNumProvinces', 'uPaintW', 'uTier', 'uEditTier',
                     'uShowTitles', 'uShowPaint', 'uMix',
                     'uShowWaste', 'uWasteGrey', 'uBorderTitle', 'uBorderPaint', 'uPaintOnly', 'uBorderW', 'uBorderA', 'uPaintBorderW', 'uPaintBorderA', 'uMapPerPx',
                     'uShowWater', 'uWaterW', 'uSeaCol', 'uLakeCol', 'uRiverCol',
                     'uExtraCount', 'uExtraTier', 'uExtraW', 'uExtraShow', 'uExtraA',
                     'uLutW', 'uRealTitles', 'uHoverTid', 'uHoverPaintOn', 'uHoverPaint', 'uHoverPid', 'uHoverLabel',
                     'uBackdrop']) {
      this.uni[n] = gl.getUniformLocation(prog, n);
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;

    this.tier = 3;
    this.editTier = 3;          // 默认跟 tier 一样（不换粒度时两者恒等）
    this.showTitles = true;
    this.showPaint = true;
    this.mix = 1.0;
    this.borderTitle = true;    // 头衔区域描边（和 borderPaint 互斥，由 UI 保证）
    this.borderPaint = false;
    this.paintOnly = false;
    /* 水域边界（海 / 湖 / 河 ✓ 用户定的四条）：
     *   · showWater：一直画 ✓ 只有"当前模式里能关的边界全关了"才藏（app 每帧给）
     *   · waterW：**固定 1 格 × 「基准线宽」** ✓（用户定的 ✓）
     *     以前它取"链上最粗那条"，会跟着剧本/粒度变 ✗；
     *     现在固定，但**仍随基准线宽等比缩放** ✓（app 每帧给 = 缩放值 ✓）
     *   · 浓度：着色器里写死实心 ✓
     *   · **荒地那条没有自己的字段** ✓ —— 它直接吃"填色边界"那套
     *     （uPaintBorderW / uPaintBorderA ✓ 用户定的 ✓）
     *   · 三个水域色：用来认"这块地是不是水" ✓ 设置里改了颜色这里跟着变 ✓ */
    this.showWater = true;
    this.waterW = 1.0;
    this.seaCol = [0, 0, 0];
    this.lakeCol = [0, 0, 0];
    this.riverCol = [0, 0, 0];   // 玩家涂色范围描边
    this.paintWidth = 1.7;      // 填色那条边界：默认取链上最粗那条的粗细（app 每帧给）
    this.paintAlpha = 1.0;      // 且实心
    // 分界线是两个可调的旋钮：粗细按**设备像素**算，所以缩放多少都是同一个粗细；
    // 深浅就是往底色里混多少。想改观感改这两个数就行。
    this.borderWidth = 1.35;    // 基准线宽（设备像素）：太粗就往小调
    this.borderStrength = 0.75;
    // 基本底色 = (150,150,150)：**没填色的地区**（该层级没有头衔，或者你没涂过）
    // 统一用这个灰，跟海面、边界都分得开。
    // 多级边界链（粒度那层之上，一层比一层粗；app 每帧填）
    this.extraCount = 0;
    this.extraTiers = new Int32Array([-1, -1, -1, -1]);
    this.extraWs = new Float32Array([1.8, 2.4, 3.0, 3.6]);
    this.extraShows = new Int32Array([0, 0, 0, 0]);
    this.extraAs = new Float32Array([1, 1, 1, 1]);   // 每级浓度（父级可 0.75）
    // 兼容字段：等于链上第一条（老代码/测试看这几个 ✓）
    this.parentBorder = 0;
    this.parentTier = -1;
    this.parentWidth = 1.8;
    this.parentAlpha = 1.0;
    this.parentShow = 0;
    this.backdrop = [150 / 255, 150 / 255, 150 / 255];
    this.hoverTid = this.noTitle;
    this.hoverPaintOn = 0;
    this.hoverPaint = [0, 0, 0];
    this.hoverPid = 0;                     // >0 = 只亮这一个地块 ✓
    this.hoverLabel = 0;                   // 要高亮那一族的标记编号（0 = 没涂）✓
    this.view = { x: 0, y: 0, w: this.mapW, h: this.mapH };
    this.lutW = meta.colorLutWidth || 256;
    this.realTitles = meta.numRealTitles || meta.numTitles;
    this.lutH = 1;
    this.dirty = true;
    this.paintDirty = false;
    this.lutDirty = false;
    this.fixedSize = false;   // 整图导出时置 true，屏蔽自动 resize
    this.noAA = false;        // 整图导出时置 true，关掉四点超采样（逐像素精确）
    this.showWaste = true;
    this.wasteGrey = [94 / 255, 94 / 255, 94 / 255];   // 设置页可改    // 荒地（不可通行）显示自己的颜色吗（荒漠涂色开关）

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(this.backdrop[0], this.backdrop[1], this.backdrop[2], 1);
  }

  lutXY(tid) {
    return [tid % this.lutW, Math.floor(tid / this.lutW)];
  }

  /** 建一张 R16UI 的 2D 数组纹理（每层一块），并上传第 0 层 */
  makeTileArray(tileW, tileH, layers, first) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R16UI, tileW, tileH, layers);
    if (first) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, tileW, tileH, 1,
        gl.RED_INTEGER, gl.UNSIGNED_SHORT, first);
    }
    return tex;
  }

  /** 把某一块上传到数组纹理的第 layer 层 */
  uploadTile(layer, data) {
    const gl = this.gl;
    if (!this.provArrTex || !this.tileInfo) return false;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.provArrTex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer,
      this.tileInfo.tileW, this.tileInfo.tileH, 1,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
    this.dirty = true;
    return true;
  }

  /**
   * 把**整张** id 图按块传进数组纹理 ✓
   * 用在"设备上限装不下整图、我们当场切块"这条路上（没有 tiles.json ✓ 数据全在内存里 ✓）。
   * 带 tiles.json 的按视野逐块喂，不走这里 ✓
   */
  uploadAllTiles(ids, layout) {
    const m = this.meta;
    const buf = new Uint16Array(layout.tileW * layout.tileH);
    const at = (a, b) => (ids.subarray ? ids.subarray(a, b) : ids.slice(a, b));
    for (let r = 0; r < layout.rows; r++) {
      for (let c = 0; c < layout.cols; c++) {
        const x0 = c * layout.tileW;
        const y0 = r * layout.tileH;
        buf.fill(0);                       // 右/下边缘不足一块的地方补 0（= 无省份 ✓）
        for (let y = 0; y < layout.tileH; y++) {
          const sy = y0 + y;
          if (sy >= m.mapHeight) break;
          const n = Math.min(layout.tileW, m.mapWidth - x0);
          if (n <= 0) break;
          const src = sy * m.mapWidth + x0;
          buf.set(at(src, src + n), y * layout.tileW);
        }
        this.uploadTile(r * layout.cols + c, buf);
      }
    }
    console.log(`就地切块：已上传 ${layout.cols * layout.rows} 块 ✓`);
  }

  async setData({ provinceIds, titlemap, colors, tiles }) {
    const gl = this.gl;
    const m = this.meta;

    // 诊断：纹理要多大、数据实际多长，只写进控制台（**别上屏** ✗ ——
    // 正常走老路的地图也会经过这里，红框会把成品弄脏）
    {
      const need = m.mapWidth * m.mapHeight;
      const have = provinceIds ? provinceIds.length : -1;
      console.log(`provTex: 需要 ${need} (${m.mapWidth}×${m.mapHeight}), `
        + `数据 ${have}, tiles=${tiles ? 'yes' : 'no'}`);
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    // 走分块时**不建整图纹理** ✗ —— 16384×8192 的 R16UI 要 268MB 显存，
    // 而且 uUseTiles=1 时这一路根本不会被采样，放一张 1×1 占位即可。
    if (!tiles && provinceIds && provinceIds.length !== m.mapWidth * m.mapHeight) {
      // 宁可**吵一声**也别静默出一张白图 ✗ —— 这一条就是今天白屏的根因：
      // 数据对不上尺寸时 WebGL 只报一个 INVALID_OPERATION，画面却是全白。
      throw new Error(`省份 id 图和地图尺寸对不上：数据 ${provinceIds.length} 个，`
        + `需要 ${m.mapWidth * m.mapHeight} 个（${m.mapWidth}×${m.mapHeight}）`
        + `，而且没传分块清单 tiles ✗`);
    }
    // **装不下就当场切块** ✓ 不依赖 tiles.json（单文件版没有那个清单 ✗）
    // 切块走的是渲染器**本来就有的**那条分块通路（TEXTURE_2D_ARRAY ✓
    // 电脑版那张 16384 的 EU5 就是这么跑的 ✓）→ 着色器 / 拾取 / 涂色全都不用改 ✓
    // 只在"设备上限装不下这张图"时才生效 ✓ 电脑上什么都不变 ✓
    let layout = tiles || null;
    if (!layout && provinceIds) {
      const lim = this.maxTex || gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (m.mapWidth > lim || m.mapHeight > lim) {
        const tileW = Math.max(1, Math.min(m.mapWidth, lim));
        const tileH = Math.max(1, Math.min(m.mapHeight, lim));
        layout = {
          tileW, tileH,
          cols: Math.ceil(m.mapWidth / tileW),
          rows: Math.ceil(m.mapHeight / tileH),
          synthetic: true,
        };
        console.log(`贴图上限 ${lim}px 装不下 ${m.mapWidth}×${m.mapHeight}`
          + ` → 就地切成 ${layout.cols}×${layout.rows} 块（每块 ${tileW}×${tileH}）`);
      }
    }

    this.provTex = layout
      ? makeTexture(gl, 1, 1, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT,
                    new Uint16Array(1), gl.NEAREST)
      : makeTexture(gl, m.mapWidth, m.mapHeight, gl.R16UI,
                    gl.RED_INTEGER, gl.UNSIGNED_SHORT, provinceIds, gl.NEAREST);

    // 分块路径：数据目录带了 tiles.json ✓ 或者上面就地切了块 ✓
    this.tileInfo = layout || null;
    this.useTiles = layout ? 1 : 0;
    if (layout) {
      const first = new Uint16Array(layout.tileW * layout.tileH);
      this.provArrTex = this.makeTileArray(layout.tileW, layout.tileH,
        layout.cols * layout.rows, first);
      // 就地切的那条：数据全在内存里 ✓ 立刻逐块传上去 ✓
      // （带 tiles.json 的那条不用管 —— app 会按视野逐块喂给 uploadTile ✓）
      if (layout.synthetic) this.uploadAllTiles(provinceIds, layout);
    } else {
      // 没有分块数据时也建一张 1×1 的数组纹理 —— 采样器不完整的话，
      // 有些驱动会直接报错（哪怕这一路根本没被采样）。uUseTiles 仍是 0 ✓。
      const one = new Uint16Array(1);
      this.provArrTex = this.makeTileArray(1, 1, 1, one);
    }

    // 归属表：**拍平成一维**（索引 = 层级 × 省份数 + 省份）。
    // 二维存（省份数 × 层级数）在维多利亚3 上会超 MAX_TEXTURE_SIZE —— 它 4 万多个省份。
    const total = titlemap.length;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.titleMapW = Math.max(1, Math.min(maxTex, 4096, total));
    const tmRows = Math.max(1, Math.ceil(total / this.titleMapW));
    const flat = new Uint16Array(this.titleMapW * tmRows);
    flat.set(titlemap);
    this.titleTex = makeTexture(gl, this.titleMapW, tmRows, gl.R16UI,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, flat, gl.NEAREST);

    this.lutH = Math.max(1, Math.ceil(m.numTitles / this.lutW));
    this.lutData = new Uint8Array(this.lutW * this.lutH * 4);
    for (let i = 0; i < m.numTitles; i++) {
      const c = colors[i] || [0, 0, 0];
      this.lutData[i * 4] = c[0];
      this.lutData[i * 4 + 1] = c[1];
      this.lutData[i * 4 + 2] = c[2];
      // alpha 现在当**荒地标记**用（setWasteland 会按 meta.wasteland 打 255），
    // 默认 0 = 不是荒地。别处没人读这个通道 ✓
    this.lutData[i * 4 + 3] = 0;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.colorTex = makeTexture(gl, this.lutW, this.lutH, gl.RGBA8,
      gl.RGBA, gl.UNSIGNED_BYTE, this.lutData, gl.NEAREST);

    // 手绘层：一个省份一格。**纹理要拍平**：宽度压在显卡上限以内，
    // 维多利亚3 有 4 万多个省份，按 numProvinces 宽建纹理传不上去（上限常见 16384），
    // 结果就是"填了色没反应"。JS 这边仍然按省份下标访问（pid*4），
    // 只在上传时拍平成二维。
    this.paintW = Math.max(1, Math.min(maxTex, 4096, this.numProvinces));
    this.paintRows = Math.max(1, Math.ceil(this.numProvinces / this.paintW));
    this.paintData = new Uint8Array(this.numProvinces * 4);
    this.paintFlat = new Uint8Array(this.paintW * this.paintRows * 4);
    this.paintTex = makeTexture(gl, this.paintW, this.paintRows, gl.RGBA8,
      gl.RGBA, gl.UNSIGNED_BYTE, this.paintFlat, gl.NEAREST);

    // 手绘层对应的"标记编号"。描边要区分同色不同标记，颜色那张表塞不下了
    // （RGB 是颜色、alpha 是"涂没涂"），所以单开一张 R16UI，一个省一格。
    this.paintLabelData = new Uint16Array(this.numProvinces);
    this.paintLabelFlat = new Uint16Array(this.paintW * this.paintRows);
    this.paintLabelTex = makeTexture(gl, this.paintW, this.paintRows, gl.R16UI,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.paintLabelFlat, gl.NEAREST);

    this.dirty = true;
  }

  /** 改 LUT 里的一个像素。只写内存，真正上传在 flushLut() 里一次做完 */
  /**
   * 多级边界链：list = [{tier, width, show}, …]（从最粗到最细都行，顺序无所谓）。
   * 同时把老的 parent* 字段同步成链上**第一条**，老代码和测试继续能用 ✓。
   */
  setExtraBorders(list) {
    this.extraCount = Math.min(list.length, 4);
    for (let i = 0; i < 4; i++) {
      const e = list[i];
      this.extraTiers[i] = e ? e.tier : -1;
      this.extraWs[i] = e ? e.width : 1.8;
      this.extraShows[i] = e && e.show ? 1 : 0;
      this.extraAs[i] = e && e.alpha != null ? e.alpha : 1;
    }
    const f = list[0];
    this.parentTier = f ? f.tier : -1;
    this.parentBorder = f ? 1 : 0;
    this.parentWidth = f ? f.width : 1.8;
    this.parentShow = f && f.show ? 1 : 0;
    this.dirty = true;
  }

  /** 老接口：只设一条（保留，免得别处炸） */
  setParentBorder(tier, width) {
    this.setExtraBorders(tier >= 0 ? [{ tier, width: width || 1.8, show: true }] : []);
  }

  setLutColor(tid, r, g, b) {
    const [x, y] = this.lutXY(tid);
    const i = (y * this.lutW + x) * 4;
    this.lutData[i] = r;
    this.lutData[i + 1] = g;
    this.lutData[i + 2] = b;
    this.lutDirty = true;
    this.dirty = true;
  }

  /** 整张 LUT 一次传上去。71 KB，比逐个 texSubImage2D 快得多 */
  flushLut() {
    if (!this.lutDirty) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.lutW, this.lutH,
      gl.RGBA, gl.UNSIGNED_BYTE, this.lutData);
    this.lutDirty = false;
  }

  /** 手绘层：给一个省份上色（a=0 表示擦掉） */
  setPaint(pid, r, g, b, a = 255) {
    if (pid <= 0 || pid >= this.numProvinces) return;
    const i = pid * 4;
    this.paintData[i] = r;
    this.paintData[i + 1] = g;
    this.paintData[i + 2] = b;
    this.paintData[i + 3] = a;
    this.paintDirty = true;
    this.dirty = true;
  }

  /**
   * 手绘层：记下这个省份的标记编号（0 = 没涂）。
   * 描边靠它区分"同色但不同标记"的两块 —— 只看颜色的话它们中间不会有线。
   */
  setPaintLabel(pid, id) {
    if (pid <= 0 || pid >= this.numProvinces) return;
    if (this.paintLabelData[pid] === id) return;
    this.paintLabelData[pid] = id;
    this.paintDirty = true;
    this.dirty = true;
  }

  /** 整张重传（53 KB，比逐个 texSubImage2D 快得多） */
  flushPaint() {
    if (!this.paintDirty) return;
    const gl = this.gl;
    // 上传前拍平（按省份的连续内存 → 宽度受限的二维）
    this.paintFlat.set(this.paintData);
    this.paintLabelFlat.set(this.paintLabelData);
    gl.bindTexture(gl.TEXTURE_2D, this.paintTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
      gl.RGBA, gl.UNSIGNED_BYTE, this.paintFlat);
    gl.bindTexture(gl.TEXTURE_2D, this.paintLabelTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.paintLabelFlat);
    this.paintDirty = false;
  }

  setTier(t) { this.tier = t; this.dirty = true; }

  /**
   * 边界和悬停看哪一层。
   *
   * 年份视图（1444/1618/1800）下允许跟 uTier 分开：颜色还是那年的归属色，
   * 但边界画到地区/省份的接缝上、悬停高亮也按那一级 —— 于是可以"看着 1444
   * 的政治地图，按省份去改"。不换粒度时传的就是 tier，行为跟以前一模一样。
   */
  setEditTier(t) { this.editTier = t; this.dirty = true; }
  setShowTitles(v) { this.showTitles = !!v; this.dirty = true; }
  setShowPaint(v) { this.showPaint = !!v; this.dirty = true; }
  /** 荒漠涂色开关：关着时荒地一律显示灰（着色器里就用 LUT 的 alpha 判） */
  setShowWaste(v) { this.showWaste = !!v; this.dirty = true; }

  /**
   * 标出哪些头衔是"荒地（不可通行）" —— 借用 LUT 的 **alpha** 通道：
   * 荒地 = 255，其余 = 0。这个通道别处没人用（输出 alpha 是着色器里另算的），
   * 拿来当"这是荒地"的标记，着色器一次取样就能判，不用多传一张纹理。
   */
  setWasteland(tids) {
    const set = new Set(tids || []);
    const n = Math.floor(this.lutData.length / 4);   // LUT 一共多少格
    for (let t = 0; t < n; t++) {
      this.lutData[t * 4 + 3] = set.has(t) ? 255 : 0;
    }
    this.wastelandCount = set.size;
    this.lutDirty = true;
    this.dirty = true;
  }
  setMix(v) { this.mix = v; this.dirty = true; }
  setBorderTitle(v) { this.borderTitle = !!v; this.dirty = true; }
  setBorderPaint(v) { this.borderPaint = !!v; this.dirty = true; }
  setHover(tid) { this.hoverTid = tid == null ? this.noTitle : tid; this.dirty = true; }

  setView(x, y, w, h) {
    this.view.x = x; this.view.y = y;
    this.view.w = Math.max(w, 1e-3); this.view.h = Math.max(h, 1e-3);
    this.dirty = true;
  }

  resize() {
    if (this.fixedSize) return;   // 整图导出期间由调用方自己定尺寸
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.dirty = true;
    }
  }

  render() {
    if (!this.provTex) return false;
    this.flushPaint();
    this.flushLut();
    if (!this.dirty) return false;

    const gl = this.gl;
    const u = this.uni;

    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.provTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.titleTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.paintTex);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.paintLabelTex);
    gl.uniform1i(u.uProv, 0);
    gl.uniform1i(u.uTitleMap, 1);
    gl.uniform1i(u.uColorLut, 2);
    gl.uniform1i(u.uPaint, 3);
    gl.uniform1i(u.uPaintLabel, 4);
    // 分块那条路：纹理单元 5（0~4 已经被上面占满）
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.provArrTex);
    gl.uniform1i(u.uProvArr, 5);

    gl.uniform4f(u.uView, this.view.x, this.view.y, this.view.w, this.view.h);
    gl.uniform2i(u.uMapSize, this.mapW, this.mapH);
    gl.uniform1i(u.uTitleMapW, this.titleMapW);
    gl.uniform1i(u.uNumProvinces, this.numProvinces);
    gl.uniform1i(u.uPaintW, this.paintW);
    gl.uniform1i(u.uTier, this.tier);
    gl.uniform1i(u.uEditTier, this.editTier);
    gl.uniform1i(u.uShowTitles, this.showTitles ? 1 : 0);
    gl.uniform1i(u.uShowPaint, this.showPaint ? 1 : 0);
    gl.uniform1i(u.uShowWaste, this.showWaste ? 1 : 0);
    gl.uniform3f(u.uWasteGrey, this.wasteGrey[0], this.wasteGrey[1], this.wasteGrey[2]);
    // 分块参数（没有分块数据时 useTiles=0 → 着色器走老路，跟以前等价 ✓）
    const _ti = this.tileInfo || { tileW: 1, tileH: 1, cols: 1 };
    gl.uniform2i(u.uProvTiles, _ti.tileW, _ti.tileH);
    gl.uniform1i(u.uProvCols, _ti.cols);
    gl.uniform1i(u.uUseTiles, this.useTiles || 0);
    gl.uniform1f(u.uMix, this.mix);
    gl.uniform1i(u.uBorderTitle, this.borderTitle ? 1 : 0);
    gl.uniform1i(u.uBorderPaint, this.borderPaint ? 1 : 0);
    gl.uniform1i(u.uPaintOnly, this.paintOnly ? 1 : 0);
    // 水域边界：开关 + 粗细 + 三个水域色（实心 ✓ 所以没有浓度 uniform）
    gl.uniform1i(u.uShowWater, this.showWater ? 1 : 0);
    gl.uniform1f(u.uWaterW, this.waterW);
    gl.uniform3f(u.uSeaCol, this.seaCol[0], this.seaCol[1], this.seaCol[2]);
    gl.uniform3f(u.uLakeCol, this.lakeCol[0], this.lakeCol[1], this.lakeCol[2]);
    gl.uniform3f(u.uRiverCol, this.riverCol[0], this.riverCol[1], this.riverCol[2]);
    gl.uniform1f(u.uBorderW, this.borderWidth);
    gl.uniform1f(u.uPaintBorderW, this.paintWidth);
    gl.uniform1f(u.uPaintBorderA, this.paintAlpha);
    gl.uniform1i(u.uExtraCount, this.extraCount | 0);
    gl.uniform1iv(u.uExtraTier, this.extraTiers);
    gl.uniform1fv(u.uExtraW, this.extraWs);
    gl.uniform1iv(u.uExtraShow, this.extraShows);
    gl.uniform1fv(u.uExtraA, this.extraAs);
    gl.uniform1f(u.uBorderA, this.borderStrength);
    gl.uniform1i(u.uLutW, this.lutW);
    gl.uniform1i(u.uRealTitles, this.realTitles);
    gl.uniform1ui(u.uHoverTid, this.hoverTid);
    gl.uniform1i(u.uHoverPaintOn, this.hoverPaintOn ? 1 : 0);
    gl.uniform3f(u.uHoverPaint, this.hoverPaint[0], this.hoverPaint[1], this.hoverPaint[2]);
    gl.uniform1i(u.uHoverPid, this.hoverPid || 0);
    gl.uniform1ui(u.uHoverLabel, this.hoverLabel || 0);
    gl.uniform3fv(u.uBackdrop, this.backdrop);

    // 一个屏幕像素折算成多少个地图像素 —— 采样和画边界都要用它。
    // 用 canvas.width（设备像素）而不是 clientWidth，固定尺寸渲染时才对得上。
    const scale = this.canvas.width / this.view.w;
    gl.uniform1f(u.uMapPerPx, 1 / Math.max(scale, 1e-6));
    gl.uniform1i(u.uNoAA, this.noAA ? 1 : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.dirty = false;
    return true;
  }

  screenToMap(px, py) {
    const rect = this.canvas.getBoundingClientRect();
    const nx = (px - rect.left) / rect.width;
    const ny = (py - rect.top) / rect.height;
    return [this.view.x + nx * this.view.w, this.view.y + ny * this.view.h];
  }
}
