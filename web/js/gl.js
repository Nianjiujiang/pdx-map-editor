// ==================== gl.js ====================
﻿/**
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

/*: **画布的像素总数上限**（自动降 dpr 用 ✓）。

 * 边界是逐像素算的，一帧开销 ∝ 画布像素数 ✗ 所以给总像素封顶：
 * 超了就把 dpr 降下来（`resize()` 里那句 ✓），画面略糊、但省下的是十几倍时间 ✓
 *
 * 2.6e6 这个数的来源：手机（390×844、dpr 2）就是 260 万左右 ✓ ——
 * 也就是"拿手机上那个流畅的量级"当标准 ✓
 * 普通 1080p 屏（1920×1080×1 ≈ 200 万）在限额内，**一点不受影响** ✓
 * 会被降的是 4K 屏、以及 Windows 缩放 125%/150% 那种高 dpr 场合 ✓
 */
const MAX_CANVAS_PX = 2.6e6;

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
/* **距离场**：RGBA8 ✓ 每通道一条主线（R 填色 · G 水岸线 · B 荒地边 · A 本层 ✓）
 *   值 = "格心到最近那条缝的距离 − 0.5"（单位是**格** ✗ 所以采样后要 ×255 ✓）
 *   ⚠ **必须 LINEAR 采样** ✗ —— 缝两侧的格都存 0，靠插值在缝的位置过零才拿得到亚格精度 ✓
 *     用 NEAREST 就退化成"一格一格"的阶梯了 ✓（我拿布尔掩码试过一轮，就是栽在这 ✓）*/
/* **边掩码**：R16UI ✓ 每格 16 bit —— 每条线 4 位（1 左 · 2 右 · 4 上 · 8 下 ✓）
 *   线0 填色（bit0~3）· 线1 水（4~7）· 线2 荒地（8~11）· 线3 本层（12~15）✓
 *   用户点破的：边界就是"把一部分格子的**边框**点亮"✓ 所以缝就是**格子的边** ✓
 *   → 亚格精度天然有（用的是片元在格内的小数 f ✓）**不需要插值、也不需要距离场** ✓ */
/* **距离场**：RGBA8 ✓ 每格 4 个字节 = 四路"到最近那条缝有多远"（单位：格 ✓）
 *   R 填色 · G 水 · B 荒地 · A 头衔（本层 + 多级链共用 ✓ 它俩只差线宽 ✓）
 *   加载时算一次（app.js 的 buildBorderDepth ✓）· 用来**粗筛**每帧要不要细算 ✓
 *   实测 EU4：需要承担边界的只有 8.6% ✗ 其余 91.4% 在这儿一次采样就返回了 ✓
 *   ⚠ **不参与画线** ✗ 只当守门员 —— 算不准最多多跑几趟射线 ✓ 线的样子不会变 ✓ */
/* ⚠ **归一化 sampler2D，不是 usampler2D** ✗ —— 上传用的是 gl.R8（归一化 ✓）
 *   归一化 R8 是各家的**最快上传路径** ✓ 而整数纹理（R8UI）会走格式转换的慢路 ✓
 *   代价：texelFetch 出来是 **0~1 的 float** ✗ 所以取位前要 ×255 还原 ✓
 *   🔴 **这两处必须同时改** ✗ 只改一处就是白屏：
 *     纹理用 R8、声明却写 usampler2D → texelFetch 给 uint → uint x float 编不过 ✓
 *     报错长这样：'*' : no operation exists that takes 'highp uint' and 'const float' ✓（踩过 ✓）*/
uniform sampler2D  uBorderDepth;
uniform int        uBorderDepthOn;
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
/* ---- 水域边界 / 荒地边界（背景上那两条线 ✓）---------------------------------
 *   · **各有一条自己的开关** ✓（用户要求：能单独关 ✓ ——
 *     以前两条共用一个 uShowWater ✗ 还得"当前模式里能关的边界全关"才跟着藏 ✓）
 *   · **各自的粗细和浓度也独立** ✓（用户要求 ✓
 *     以前：水域写死实心 + 固定 1 格 ✗；荒地借 uPaintBorderW / uPaintBorderA ✗）
 *   · 判据：一侧是水（或荒地）、一侧不是 ✓（同类之间不画 ✓）
 */
uniform int   uShowWater;       // 1 = 画水域边界
uniform float uWaterW;          // 水域边界粗细（**就是格数** ✓）
uniform float uWaterA;          // 水域边界浓度
uniform vec3  uSeaCol;          // 三个水域色：拿来认"这块地是不是水"
uniform vec3  uLakeCol;
uniform vec3  uRiverCol;
uniform int   uShowWasteBorder; // 1 = 画荒地边界
uniform float uWasteW;          // 荒地边界粗细（**就是格数** ✓）
uniform float uWasteA;          // 荒地边界浓度
/* 荒地那趟的范围：**所有**带荒地的缝都归它 ✓（荒地↔国家 ✓、荒地↔荒地 ✓、荒地↔无主地 ✓）
 *   本层 / 多级边界那几趟一律让出来 ✗（水岸线先 break，归水域那条 ✓）
 *   ⚠ 我按"另一侧是不是真头衔"分过一次家 ✗ —— 荒地 ↔ 国家 被判给本层那条线，
 *     于是荒地轮廓看着还是**子级的宽浓**（细 + 50%）✗ 用户报的"怎么还是子级" ✓
 *   以前它没有自己这一趟 —— 荒地边缘是头衔那趟顺手画的 ✗
 *     于是宽浓跟着"本层那条线"走：剧本层 + 没开粒度时是 1.5 + 实心，
 *     细层视图里是 1.0 + 50% ✗（用户报的"开不开剧本会变" ✓）*/
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

/*: 沿一个方向**最多找多少格**。
 *
 * ⚠ 这个数**直接决定性能** ✗（用户报"边界很吃性能、缩放时特别卡"✓）：
 *   每个像素是**四个方向各走 R 步**找边界的，而 R 会跟着缩放涨 ——
 *   缩到全图时 uMapPerPx 能有几十，R 就顶到这个上限 ✗
 *   一帧的采样次数 ≈ 像素 × 4 × R × 边界趟数（本层 / 填色 / 水域 / 荒地 / 多级链最多 4 级）
 *   48 的时候：144 万像素 × 4 × 48 × 6 ≈ **十六亿次** ✗✗ 那就是卡顿的来源 ✓
 *
 * 12 为什么够：屏幕上一条线的**半宽最多就是这个数（像素）** ✓
 *   真要更粗的线，那是"缩得很小、线糊成一片"的视图 —— 那时候多走的那几十步
 *   在画面上根本分不出来 ✓ 拿这点精度换 4 倍速度，划算 ✓
 */
const int MAXR = 12;

/*: 射线**跳步预筛**从多大的 R 开始用（见 rayDistTitle / rayDistPaint 里那段说明 ✓）。
 *
 *   ⚠ 这个数是**画质与速度的分界**，动它之前先想清楚 ✗：
 *     · 定太小（原来就是 4 ✗）→ 用户涂一小块时"跳过去看一眼"会漏掉新边界，
 *       表现成"涂了色 / 还原之后边界不更新" ✓（用户报的，踩过 ✓）
 *     · 定太大（比如 12）→ 预筛几乎不生效，缩小时又慢回去 ✓
 *   8 是个平衡点：正常编辑（R ≤ 6）走**精确路径** ✓ 只有缩得比较小才用近似 ✓
 *   想要**绝对精确**：把它改成一个到不了的数（999 ✓ 预筛就永远不生效 ✓）
 */
const int PRESCREEN_MIN_R = 8;

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
  /* **"这儿是不是水"必须按颜色**精确**判 ✗ 不能近似** ✓
   *
   * 为什么（用户报的那三个 HOI4 省份 ✓）：以前这里写的是 distance(...) <= 0.02 ✗
   *   而 HOI4 的省份色是**技术色**（为了把相邻省份分开随便生成的 ✓），
   *   跟 #lake 的 [47,110,150] 只差几个数：
   *     p_3511 [44,111,153] ≈ 0.0172 ✓  p_4788 [50,111,148] ≈ 0.0147 ✓
   *     p_4343 [48,114,148] ≈ 0.0184 ✓          ← 全都小于 0.02 ✗
   *   → 那三块地在画面上被当成湖水，边界走了"水域那一趟" ✗（用户报的 ✓）
   *
   * 真正的水平白：水域节点的 LUT 色跟 uSeaCol / uLakeCol / uRiverCol 是**同一份数据** ✓
   *   （见 app.js 里"三个水域色必须跟 LUT 真正生效的那个一致"那段 ✓）→ 距离是 0 ✓
   *   所以阈值收到 0.004 足够，而上面那三个（最接近的也有 0.0147）稳稳妥妥被排除 ✓
   */
  vec3 c = lutColour(ip);
  if (c.x < -0.5) return false;
  if (distance(c, uSeaCol) <= 0.004) return true;
  if (distance(c, uLakeCol) <= 0.004) return true;
  if (distance(c, uRiverCol) <= 0.004) return true;
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
  /* **先跳一步探路** ✓（用户报的"缩放太卡"✓）
   *
   * 每个像素是**四个方向各走 R 步**，每步 3 次纹理采样 ✗ ——
   * 而画面里**绝大多数像素不在边界上**：它们要一路走满 R 步、
   * 才能确认"这个方向附近没有线"✗ 纯白烧 ✓ 缩放时 R 变大，这笔开销成倍涨 ✗✗
   *
   * 所以先只采**一个点**：ip + dir*R（正好是"这条射线能看到的尽头"✓）
   *   同头衔 → 这一向**基本**没有边界 ✓ 直接返回"很远" ✓ 省掉整整 R 步 ✗
   *
   * ⚠ 三点分寸：
   *   · 只在 R >= 8 时才这么干 ✗ —— **门槛原来定在 4，太高了，捅过篓子** ✓
   *     用户报的"涂了色 / 还原之后边界不更新"就是它 ✗：
   *     你涂一小块时，新边界就在这一小块的边缘上；只要这块**比 R 格还窄**，
   *     "跳到 dir*R 看一眼"就会说"这一向没边界" ✓ 那条线**根本不画** ✗
   *     而 R=4 时就已经能盖住很常见的小地块了 ✓（放大编辑时 R 常常才 1~2 ✓）
   *     提到 8 之后：**正常编辑（R ≤ 6）走的是精确路径** ✓
   *     只有缩得比较小（R 到 8~12 ✓）才用近似 —— 那时候比 8 格还窄的细线本来就看不清 ✓
   *   · 这是**近似**（同头衔不代表中间没有别的 ✗），拿它换掉的是 R 倍的采样量 ✓
   *   · 想要**绝对精确**就把这两处预筛删掉 ✓ 代价是缩小时慢回 2~3 倍 ✓
   */
  if (R >= PRESCREEN_MIN_R) {
    ivec2 far = ip + ivec2(dir.x * R, dir.y * R);
    if (isWaterAt(far) == _wSelf
        && (tier < 0 ? tidAt(far) : titleAt(pidAt(far), tier)) == t) return 1e9;
  }
  /* 🔴 **跳步**（用户报的"缩放超级无敌卡"✓）——
   *   半径 R 是按**地图格**算的 ✗ 缩到全图时它能有 10 格 ✓
   *   而"地图上 10 格"在屏幕上**不到 2 个像素** ✗ 为它走 10 步纯属白烧 ✓
   *   → 每步跨 stride 格：stride ≈ 半个屏幕像素跨的地图格数 ✓
   *   于是步数 = R / stride ≈ 线宽（**跟缩放到多少无关** ✓✓）
   *   ⚠ 会漏掉的只有"比 stride 还细"的东西 ✗ 而它在屏幕上不到半像素 ✓ 本来就看不见 ✓
   *   ⚠ 放大时 uMapPerPx < 2 ⇒ stride = 1 ⇒ **一步不跳** ✓ 精度**完全不变** ✓ */
  int _st = max(1, int(uMapPerPx * 0.5));
  for (int k = 1; k <= MAXR; k++) {
    int _d = k * _st;                       // 这一趟实际跨了多少格 ✓
    if (_d > R) break;
    // 写成 ivec2(dir.x * k, dir.y * k) 而不是 dir * k ——
    // 整数向量乘整数标量在 GLSL ES 3.0 里规不规范我记不准，展开最保险
    // tier：看哪一层的边界（-1 表示跟 uEditTier 一样）
    ivec2 q = ip + ivec2(dir.x * _d, dir.y * _d);
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
    /* **这一格算不算"荒地边"**：看 LUT 那个荒地标记 ✓ —— **但被涂过的不算** ✗
     *
     * 用户定的（2026）：**荒地一旦被玩家涂上色，它在边界上就不再是"荒地身份"** ✓
     *   那块地已经是你的版图了 ✓ 边界该按**普通地块**走（本层那条线 ✓），
     *   不该再顶着"荒地轮廓"那一套宽浓 ✓
     *   判据就是手绘层那个 alpha（paintAt 的 .a > 0.5 = 涂过 ✓）
     *   两侧各判一次：ip 是起点那侧、q 是射线当前那侧 ✓
     *
     * ⚠ 不许再加"必须是伪头衔（>= uRealTitles）"的前置 ✗ ——
     *   那是 CK3 / EU4 那类数据的习惯，**EU5 不成立**：
     *   EU5 的荒地节点序号**混在真头衔范围内**（1819 个荒地里有 1818 个 < numRealTitles ✗，
     *   阿卜杜勒库里岛那种 —— 打空白剧本补丁时踩过同一个坑 ✓）
     *   加了那个前置 → EU5 的荒地缝**一条都进不来** ✗ → 全落到"本层那条线"上（50%）✗
     *   用户报的"EU5 的荒地不会像其他那样划界，用的全是 50%" ✓ 就是它 ✓
     * （wasteAlphaOf 自己对 NONE 返回 0 ✓ 所以无主地不会被误判成荒地 ✓）*/
    bool _hasWaste = (wasteAlphaOf(t) > 0.5 && paintAt(ip).a < 0.5)
                  || (wasteAlphaOf(tt) > 0.5 && paintAt(q).a < 0.5);
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
    //（"是不是荒地"这儿也得**算上"涂过就不算"** ✓ 跟上面那句一个口径 ✗ 别两套）
    if (_tw && _uw) {
      float wa = wasteAlphaOf(t) > 0.5 && paintAt(ip).a < 0.5 ? 1.0 : 0.0;
      float wb = wasteAlphaOf(tt) > 0.5 && paintAt(q).a < 0.5 ? 1.0 : 0.0;
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
      float kf = float(_d);
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

/** 一格**在屏幕上**的样子：颜色 + 涂没涂 + 标记 + 是不是水 ✓
 *
 *  为什么要有这个"先算一次再比"的结构（用户要求的"维持矢量画法、只降压"✓）：
 *   射线循环里**起点那一侧从头到尾都没变** ✗ 可以前每步都把它重算一遍 ——
 *   paintAt + shownColour（里面还有 pidAt / titleAt / wasteAlphaOf）+ paintLabelAt
 *   一趟下来是 10 次左右的纹理采样 ✗✗ 而它 4 方向 × R 步 全在重复同一件事 ✓
 *   缩放时 R 一涨，这笔账就是卡顿的大头 ✓
 *   → 起点算一次（cellViewOf(ip) ✓），循环里每步只算对面那一格 ✓ **省一半** ✓
 */
struct CellView {
  vec3 col;       // 屏幕上的颜色（x < -0.5 = 这一格没颜色）
  bool painted;   // 玩家涂过没有
  bool water;     // 是不是水（水岸线要用 ✓）
  bool waste;     // 是不是**没被涂过**的荒地（荒地边要用 ✓）
  uint tid;       // **编辑层**的头衔序号（荒地边还要判"两侧头衔不同" ✓）
  uint label;     // 标记编号
};

CellView cellViewOf(ivec2 ip) {
  CellView v;
  vec4 p = paintAt(ip);
  v.painted = p.a > 0.5;
  v.col = v.painted ? p.rgb : shownColour(ip);
  v.water = isWaterAt(ip);
  /* **荒地身份要"没被涂过"才算** ✓（用户定的：涂上色的荒地不再是荒地 ✓）
   *   跟 rayDistTitle 里 _hasWaste 那两行**同一个口径** ✗ 别两套 ✓
   *
   * ⚠ **层要用 uEditTier，不是 uTier** ✗ —— 我图省事写过 uTier，捅了篓子 ✓
   *   结果：用户报「不可通行区域边界变成密密麻麻网格」✓ 根因就是它：
   *     rayDistTitle 那边取的是 tidAt() = **编辑层** ✓
   *     而不可通行区在**编辑层**上是**一格一个伪头衔**（17677、17678、17679… ✗）
   *     → 每格都被判成"荒地" → 起点侧恒真 → 第一格就 break、距离恒为 1
   *     → **每格四条边都画** ✓ 密密麻麻 ✓
   *   视图层（比如"帝国"）上那片往往同属一个头衔 → 不会这样 ✗ 所以看着"有时正常" ✓
   */
  v.tid = titleAt(pidAt(ip), uEditTier);
  v.waste = wasteAlphaOf(v.tid) > 0.5 && !v.painted;
  v.label = paintLabelAt(ip);
  return v;
}

/** 两格在**画面上**算不算"两种东西"（就是原来那个 shownDiffers 的判断 ✓ 一个字没改）*/
bool viewsDiffer(CellView A, CellView B) {
  /* **年份视图没开 → 未上色的省份之间，一律不划国家级边界** ✓
   *   （用户定的 ✓ **不管颜色** ✗ —— 两个都没涂就是没线 ✓）
   *   ⚠ 这一行必须在**最前面** ✓：
   *     放到颜色比较后面的话，"颜色不同的两个没涂省份"照样会划一条 ✗
   *     —— 那是**年份视图里**的规矩 ✓；没开年份视图时不该有这些线 ✓
   *     （uPaintOnly 的定义就是"当前没停在年份层" ✓ CK3 那种没有年份层的也算 ✓）
   */
  if (uPaintOnly == 1 && !A.painted && !B.painted) return false;
  vec3 ca = A.col, cb = B.col;
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
  return A.label != B.label;
}

/** 这一格是**水岸线或荒地边**吗（不归手绘那趟管 ✓）
 *
 * ⚠ **起点那一侧必须由调用方算一次传进来** ✗（wIp = 起点是不是水、jIp = 起点是不是荒地）
 *   以前这儿每次调用都重算 titleAt(pidAt(ip)) ✗ 而 ip 是**循环不变量** ——
 *   射线每走一步就白采两次纹理 ✓ 单这一步就占这一趟四成的采样量 ✓
 *   （rayDistPaint 每帧是 4 方向 × R 步 ✗ 所以省下来的是四倍那份 ✓）
 *   这跟 rayDistTitle 里把 _wSelf 提到循环外是同一件事 ✓ */
bool _terrainSeam(ivec2 q, bool wIp, bool jIp) {
  if (wIp != isWaterAt(q)) return true;                           // 水岸线 ✓
  uint t1 = titleAt(pidAt(q), uTier);
  return jIp || wasteAlphaOf(t1) > 0.5;                           // 荒地边 ✓
}

/* **沿 dir 找最近的分界线，一次吐出两个距离** ✓（用户要求"合并那几趟射线"✓）
 *   .x = 填色/头衔边界的距离、.y = **水岸线**的距离 ✓
 *
 *   为什么合成一个：水岸线原来有**单独一趟**（rayDistWater × 4 方向 ✗），
 *   可它判的"这一侧是不是水"，这趟的 _terrainSeam **本来就在判** ✗ ——
 *   同一件事每帧算两遍 ✓ 现在撞上水岸线时先把它记进 .y 再 break ✓
 *   → **四趟射线变三趟** ✓ 判据一个字没改，画出来的线完全一样 ✓
 */
vec3 rayDistPaint(ivec2 ip, vec2 f, ivec2 dir, int R) {
  // **显示出来的颜色边界**：手绘层不同 ✓ 或**原版色**不同 ✓ 都算
  //（地图本来就有的剧本色也算 ✓ —— 不用"先涂一笔"✗）
  // 每步比这两样就够（2~4 次取纹理 ✓），不再算 showPaint/showTitles/荒地那一堆分支 ✗
  /* **起点那一侧算一次** ✓（循环不变量 ✗ 原来每步重算，一趟下来 10 次采样 ✗ 见 cellViewOf ✓）
   * ⚠ **这里不能写 const** ✗ —— GLSL 的 const 是**编译期常量**，
   *   接运行时函数（isWaterAt / titleAt）会直接编不过：
   *     ERROR: 0:507: '=': assigning non-constant to 'const bool'
   *   （用户报过一次，整个着色器编译失败 → 画面全白 ✓ 我踩的 ✓）*/
  CellView _A = cellViewOf(ip);
  bool _wIp = _A.water;
  bool _jIp = _A.waste;
  /* **先跳一步探路** ✓（见 rayDistTitle 上面那段注释 ✓）
   *   这一趟每步要跑水 / 荒地 / 颜色 / 标记四样判定 ✗
   *   是这几条射线里最贵的一条 ✗ 所以这个预筛在这儿收益最大 ✓ */
  if (R >= PRESCREEN_MIN_R) {
    ivec2 far = ip + ivec2(dir.x * R, dir.y * R);
    CellView _F = cellViewOf(far);
    if (!_jIp && !_F.waste && _wIp == _F.water && !viewsDiffer(_A, _F)) return vec3(1e9);
  }
  float _wa = 1e9;                     // 水岸线的距离（顺便算 ✓）
  float _ja = 1e9;                     // 荒地边的距离（顺便算 ✓）
  /* 🔴 **跳步**（用户报的"缩放超级无敌卡"✓）——
   *   半径 R 是按**地图格**算的 ✗ 缩到全图时它能有 10 格 ✓
   *   而"地图上 10 格"在屏幕上**不到 2 个像素** ✗ 为它走 10 步纯属白烧 ✓
   *   → 每步跨 stride 格：stride ≈ 半个屏幕像素跨的地图格数 ✓
   *   于是步数 = R / stride ≈ 线宽（**跟缩放到多少无关** ✓✓）
   *   ⚠ 会漏掉的只有"比 stride 还细"的东西 ✗ 而它在屏幕上不到半像素 ✓ 本来就看不见 ✓
   *   ⚠ 放大时 uMapPerPx < 2 ⇒ stride = 1 ⇒ **一步不跳** ✓ 精度**完全不变** ✓ */
  int _st = max(1, int(uMapPerPx * 0.5));
  for (int k = 1; k <= MAXR; k++) {
    int _d = k * _st;                       // 这一趟实际跨了多少格 ✓
    if (_d > R) break;
    ivec2 q = ip + ivec2(dir.x * _d, dir.y * _d);
    float kf = float(_d);
    float dl = dir.x != 0 ? (dir.x > 0 ? kf - f.x : f.x + kf - 1.0)
                          : (dir.y > 0 ? kf - f.y : f.y + kf - 1.0);
    CellView _B = cellViewOf(q);       // **每步只算一次** ✓ 四样判定共用它 ✓
    /* **水岸线**：先记下距离再 break ✓（它不归这趟画，各有各的宽浓 ✓
     *   用 break 不用 continue：continue 会穿过水面继续往外找 ✗
     *   → 把对岸那条色块线当成本格的边界画上来（线跑到岸两边去 ✓）*/
    if (_wIp != _B.water) { _wa = dl; break; }
    /* **荒地边**：两个条件**缺一不可** ✗ —— 我合并时漏了第二条，捅了大篓子 ✓
     *   ① 两侧至少一侧是"没被涂过的荒地" ✓
     *   ② **而且两侧的（编辑层）头衔序号不同** ✓ ← 就是这一句
     *   为什么 ② 不能省（用户报的"荒地密密麻麻"✓）：
     *     不可通行区是**一整片共用一个伪头衔**（meta.wasteland 里 672 个 id = 672 片 ✗）
     *     → 片**内部**每一格 tt == t、**不算缝** ✓ 射线继续走 → 到**片边缘**才返回 ✓
     *     → 画出来的是这片的外轮廓 ✓（这才是对的样子）
     *   只留 ① 的话：片内每格起点都是荒地 → **第一格就 break、距离恒为 1**
     *     → 每格四条边全画 ✓ 密密麻麻的网格 ✓（用户报的 ✓）*/
    if ((_jIp || _B.waste) && _B.tid != _A.tid) { _ja = dl; break; }
    if (viewsDiffer(_A, _B)) return vec3(dl, _wa, _ja);
  }
  return vec3(1e9, _wa, _ja);
}

/** **一条线在某一格里的距离** ✓（b 是那 4 个边标记位：1 左 · 2 右 · 4 上 · 8 下 ✓）
 *  f 是片元在格内的小数 ✓ 所以 f.x 天然就是"到左边那条边的距离" ✓
 *  → **亚格精度是天然的，不需要插值、也不需要距离场** ✓（用户点破的：缝就是格子的边 ✓）*/
float edgeDist(uint b, vec2 f) {
  float d = 1e9;
  if ((b & 1u) != 0u) d = min(d, f.x);
  if ((b & 2u) != 0u) d = min(d, 1.0 - f.x);
  if ((b & 4u) != 0u) d = min(d, f.y);
  if ((b & 8u) != 0u) d = min(d, 1.0 - f.y);
  return d;
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
    /* **缩小那一档：四路距离直接填进去** ✓（放大走边掩码、射线只当兜底 ✓）
     *   四路各跟自己的半宽比就行 —— 半宽那步在下面混色处做 ✓ 不用在这儿判 ✓
     *   ⚠ 头衔那一通道（A）同时供"本层线"和"多级链"✓ 它俩只差线宽 ✓ */
    /* 多级链也各有自己的宽度 ✗ 新路径一次扫描要扫到"最粗那条"的半径才够 ✓
     *（距离本身**不按线宽裁剪** ✓ 每条线各自在混色那步判够不够 ✓ 所以取最大就对 ✓）*/
    float _wAll = max(max(uBorderW, uPaintBorderW), max(uWaterW, uWasteW));
    for (int ex = 0; ex < 4; ex++) if (ex < uExtraCount) _wAll = max(_wAll, uExtraW[ex]);
    int Rall = int(clamp(ceil(0.5 * uMapPerPx * (_wAll + 1.0)), 1.0, float(MAXR)));

    /* ============ **逐像素射线：缩小时的兜底路径** ============
     * 放大时四条主线 + 多级链全走边掩码（一次采样 ✓ 见下面 _useEdges 那段 ✓）
     * **缩小时只能回这儿** ✗ —— 线宽超过 1 格时，缝可能落在**邻居的边**上，
     *   而每格只记自己的四条边，量不到 → 线会断 ✓
     * 好在缩小的时候屏幕像素本来就少，射线不贵 ✓ 加上深度图粗筛挡掉九成，够用 ✓
     *
     * 🔴 走过的两条弯路（都删了，别再走一遍）：
     *   ① **布尔掩码**：把"这一格有没有缝"记在**格**上 ✗
     *      可"缝"是**格子之间那条边** ✓ 于是"到缝的距离"丢了一维（缝在我哪一侧 ✓）
     *      靠它凑距离，放大时线断成台阶、一般缩放下又粗得离谱 ✓
     *      （用户截图里那个"梯子"就是它 ✓ 仿真里 bw=0.15 全空、bw=0.6 却有十格宽 ✓）
     *   ② **浮点距离场**（RGBA8 + 双线性插值）：方向对了，但真机上线宽乱 ✗
     *      根因是"多级链还在走射线"跟它叠在同一位置 ✓ 1 粗 1 细压在一起 ✓
     *   ③ 正解 = **边掩码**：只记"我这一格的四条边里哪几条是缝" ✓
     *      亚格精度**天然有**（用片元在格内的小数 f ✓）不需要插值、不需要距离 ✓
     */
    }

    /* ⚠ 这一整套声明**不能挪位置、不能删** ✗
     *   它们原来是写在上面那个 if 块里的 ✗ 而那个 if 在上一轮清理时被提前闭合了 ✓
     *   → 射线代码就跑到块外、看不到它们 → 白屏报 dTitle undeclared ✓
     *   现在在这里补一份（块外、main 作用域 ✓）**别再动它** ✓
     *
     * **射线半径**：按"最粗那条线"算 ✓
     *   ⚠ 每条线各自在混色那步按**自己的**半宽判 ✓ 所以这里取最大就够 ✓
     *   （被删掩码块时连这几个声明一起吃掉了 ✗ 白屏报 dTitle undeclared ✓ 别再删这段 ✓）*/
    int R = int(clamp(ceil(0.5 * uMapPerPx
             * (max(max(uBorderW, uPaintBorderW), max(uWaterW, uWasteW)) + 1.0)),
             1.0, float(MAXR)));
    float dTitle = 1e9;
    float dPaint = 1e9;
    float dWater = 1e9;
    float dWaste = 1e9;
    /* **粗筛：一位定生死** ✓（加载时算好的那张"省界 ±2 格"轮廓位图 ✓）
     *   bit 1 ⇒ 值得看一眼（跑射线）· bit 0 ⇒ **一辈子画不到线**，直接退出 ✓
     *   ⚠ 它跟"当前层 / 涂色"无关 ✗ 所以换层、涂色都**不用重算**这张图 ✓
     *   ⚠ 没接上图时 _nearSeam 恒真 → 完全退回旧行为 ✓ 不会画错 ✓ */
    bool _nearSeam = true;
    if (uBorderDepthOn == 1) {
      /* ⚠ 这里原来是算 _maxHalf（"最粗那条线的半宽"）再拿它跟位图覆盖范围比 ✗
       *   现在位图是"省界 ±2 格"，覆盖范围由 CPU 侧膨胀的格数决定 ✓
       *   → _maxHalf **没人读了**，整段是死代码 ✓ 删掉（顺带少一个常量上界的循环 ✓）*/
      uint _cb = uint(texelFetch(uBorderDepth, ivec2(ip.x >> 3, ip.y), 0).r * 255.0 + 0.5);
      _nearSeam = ((_cb >> uint(ip.x & 7)) & 1u) != 0u;
    }
    if (_nearSeam && uBorderTitle == 1) {
      uint t0 = tidAt(ip);
      // 正常那条（**荒地边缘和水岸线都让出来** ✓）
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 1, 0), t0, R, -1, false));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2(-1, 0), t0, R, -1, false));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 0, 1), t0, R, -1, false));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 0,-1), t0, R, -1, false));
    }
    /* **这一趟顺便把水岸线 + 荒地边都算出来** ✓ —— 搭便车的（合并那几趟射线 ✓）
     *   三个开关里有**任何一个**要画，这一趟就得跑 ✓ */
    if (_nearSeam && (uBorderPaint == 1 || uShowWater == 1 || uShowWasteBorder == 1)) {
      vec3 _w0 = rayDistPaint(ip, f, ivec2( 1, 0), R);
      vec3 _w1 = rayDistPaint(ip, f, ivec2(-1, 0), R);
      vec3 _w2 = rayDistPaint(ip, f, ivec2( 0, 1), R);
      vec3 _w3 = rayDistPaint(ip, f, ivec2( 0,-1), R);
      dWater = min(min(_w0.y, _w1.y), min(_w2.y, _w3.y));
      dWaste = min(min(_w0.z, _w1.z), min(_w2.z, _w3.z));
      if (uBorderPaint == 1) {
        dPaint = min(min(_w0.x, _w1.x), min(_w2.x, _w3.x));
      }
    }
    // 过渡带 ≈ 一个设备像素（**要提到外面**：下面多级边界那圈也要用 ✗）
    float ramp = 0.5 * uMapPerPx;
    if (dTitle < 1e8) {
      float bw = 0.5 * uBorderW * uMapPerPx;     // 半宽
      float b  = 1.0 - smoothstep(bw - ramp, bw + ramp, dTitle);
      col = mix(col, vec3(0.035, 0.045, 0.06), b * uBorderA);
    }
    /* **荒地边界**：宽浓**自己一套** ✓（设置页「荒地宽度 / 荒地浓度」✓
     *   以前是借「填色边界」那两个值 ✗ 用户要求拆开 ✓）*/
    if (dWaste < 1e8) {
      float bwwd = 0.5 * uWasteW * uMapPerPx;
      float bwd  = 1.0 - smoothstep(bwwd - ramp, bwwd + ramp, dWaste);
      col = mix(col, vec3(0.035, 0.045, 0.06), bwd * uWasteA);
    }
    // **填色边界**：永远用自己那套（链上最粗那条的粗细 + 实心），跟本层互不干扰 ✓
    if (dPaint < 1e8) {
      float bwp = 0.5 * uPaintBorderW * uMapPerPx;
      float bp  = 1.0 - smoothstep(bwp - ramp, bwp + ramp, dPaint);
      col = mix(col, vec3(0.035, 0.045, 0.06), bp * uPaintBorderA);
    }
    /* **水域边界**：宽浓**自己一套** ✓（设置页「海域宽度 / 海域浓度」✓
     *   以前粗细固定 1 格 × 基准缩放、浓度写死实心 ✗ 用户要求拆开 ✓）*/
    if (dWater < 1e8) {
      float bww = 0.5 * uWaterW * uMapPerPx;
      float bwv = 1.0 - smoothstep(bww - ramp, bww + ramp, dWater);
      col = mix(col, vec3(0.035, 0.045, 0.06), bwv * uWaterA);
    }
    // **多级边界**：粒度那层之上，一层比一层粗（地区 → 国家）——
    // 中间那些"年份"层跳过（不然 1618 + 省份 会冒出 1789 那条 ✗）。
    /* 🔴🔴 **上界必须是常量 4，用 break 收** ✗ —— 别改成 uniform ✓
     *   我为了"少让编译器展开、编译快一点"改成过 ex < uExtraCount ✗
     *   规范上 GLSL ES 3.0 确实允许运行时上界 ✓ 但**手机驱动不认** ✗
     *   → 着色器编译失败 → **整屏黑** ✓（用户报的"手机版黑屏"✓）
     *   💡 取舍：**兼容性 > 编译速度** ✗
     *     编译慢是"第一次打开等一会儿" ✓ 编译不过 = 直接不能用 ✓
     *   ⚠ 想再提速就从别处省 ✗ 这里不许动 ✓ */
    for (int ex = 0; ex < 4; ex++) {
      if (ex >= uExtraCount) break;
      if (uExtraShow[ex] == 0) continue;
      /* **闸门只能比它守的门框宽** ✗ 宁可给链多留一条路 ✓
       *   粗筛位图圈的是"省界 ±2 格"✓ 链上那几层必然落在里面 ✓
       *   （以前的教训：闸门比门框窄 → 链整片消失 ✓）*/
      if (!_nearSeam) break;
      int et = uExtraTier[ex];
      if (et < 0) continue;
      /* **链上这一环也走边掩码** ✓（用户点破的：多级边界没有新增边界 ✗
       *   它画的就是"这一层的头衔缝" ✓ 所以 CPU 侧按层各存了一组 4 位 ✓）
       *   组 4+ex（位 16 + 4*ex ✓）—— 顺序跟 app.js 传的 headTiers[1..4] 对齐 ✗ */
      float de;
      {
        uint te = titleAt(pidAt(ip), et);
        int Re = int(clamp(ceil(0.5 * uMapPerPx * (uExtraW[ex] + 1.0)), 1.0, float(MAXR)));
        de = 1e9;
        de = min(de, rayDistTitle(ip, f, ivec2( 1, 0), te, Re, et, false));
        de = min(de, rayDistTitle(ip, f, ivec2(-1, 0), te, Re, et, false));
        de = min(de, rayDistTitle(ip, f, ivec2( 0, 1), te, Re, et, false));
        de = min(de, rayDistTitle(ip, f, ivec2( 0,-1), te, Re, et, false));
      }
      if (de < 1e8) {
        float bwe = 0.5 * uExtraW[ex] * uMapPerPx;
        float be  = 1.0 - smoothstep(bwe - ramp, bwe + ramp, de);
        col = mix(col, vec3(0.035, 0.045, 0.06), be * uExtraA[ex]);
      }
    }

  // 悬停**压暗**：整个头衔一起暗 ✓（用户要求：高亮 → 高暗）
  // **亮**起来的是 **uEditTier** 那一级 ✓（用户要求：把"高暗"改回"高亮"✓）
  // 暗下去的那块必须正好是"点下去会涂到的那块"，不然根本不知道会改到谁。
  // 注意：**不看 uShowTitles**。关掉原版颜色之后图上是底色，
  // 但悬停仍然要暗下去 —— 不然根本不知道会涂到哪一块。
  if (uHoverPid > 0) {
    // 海/湖/荒地：只压暗光标底下这**一块**（它们共用同一个伪节点，按头衔会整片变暗 ✗）
    /* **悬停一律提亮** ✓（用户定的：低亮 → 高亮 ✓ 就是字面意思）
     *   ⚠ 我中途自作聪明改成过"跟着底色走"（浅色压暗）✗ 用户又提了一次
     *     → **不要自适应** ✗ 用户要的是提亮 ✓
     *   💡 浅色地也不是问题：各省的色基本是中低亮度的饱和色 ✓
     *     往白里混 0.30 一眼就看得出来 ✓ */
    if (int(pidAt(ip)) == uHoverPid) col = mix(col, vec3(1.0), 0.30);
  } else if (uHoverPaintOn == 1) {
    // 整族变暗（"高暗"）：按**显示色 + 标记**认 —— 涂过的用手绘色，没涂的用原版色。
    // 这样"取大清的颜色涂俄罗斯"之后，大清和俄罗斯会一起变暗 ✓
    // 但**同色不同标记**是两块 ✗ → 标记也得对上（0 = 没涂，跟没涂的一起 ✓）
    vec4 hp = paintAt(ip);
    vec3 hc = hp.a > 0.5 ? hp.rgb : lutColour(ip);
    // 颜色对上之后：
    //   · **没涂过的同色地** → 算同一族 ✓（它的名字来自原版 ✓，比如开局那块瓦窑堡 ✓）
    //   · **涂过的** → 必须同一标记 ✓（同色不同标记是两块 ✗）
    bool sameLabel = (paintLabelAt(ip) == uHoverLabel);
    if (hc.x > -0.5 && distance(hc, uHoverPaint) < 0.01 && sameLabel) {
      col = mix(col, vec3(1.0), 0.30);              // 同样是提亮 ✓
    }
  } else if (uHoverTid != NONE) {
    uint h = pidAt(ip);
    if (h != 0u && titleAt(h, uEditTier) == uHoverTid) {
      col = mix(col, vec3(1.0), 0.32);              // 整片稍微再亮一点，好认 ✓
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
    /* 🔴 **每个 sampler 都必须指向一张"完整纹理"** ✗ —— WebGL 的硬规矩 ✓
     *   用户报：手机版黑屏、中心像素 [0,0,0]、**drawArrays 报 1282** ✓
     *   根因：着色器里声明了 sampler2D uBorderDepth ✓ 而**手机上不建那张粗筛位图** ✗
     *     → render 里走 else 分支，只把 uBorderDepthOn 设成 0 ✗
     *       **纹理单元 9 上什么都没绑** → 采样器指向空 → 1282 → 整帧丢弃 → 全黑 ✓✓
     *   规矩：**就算这一路根本不采样，也得绑一张完整纹理** ✗（1×1 就够 ✓）
     *   ⚠ 电脑上没事是因为那张图建得出来、绑上了 ✓ → "电脑行手机不行"就是这么来的 ✓
     *   ⚠ 这张占位纹理要**在 render 之前**就建好 ✗（constructor 里最省事 ✓）
     *     而 constructor 时 gl 已经拿到了 ✓ 所以放这儿没问题 ✓ */
    this.dummyTex = makeTexture(gl, 1, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE,
      new Uint8Array([0]), gl.NEAREST);
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
    for (const n of ['uView', 'uProv', 'uProvArr', 'uProvTiles', 'uProvCols', 'uUseTiles', 'uNoAA', 'uShowWaste', 'uTitleMap', 'uColorLut', 'uPaint', 'uPaintLabel', 'uBorderDepth', 'uBorderDepthOn',
                     'uMapSize', 'uTitleMapW', 'uNumProvinces', 'uPaintW', 'uTier', 'uEditTier',
                     'uShowTitles', 'uShowPaint', 'uMix',
                     'uShowWaste', 'uWasteGrey', 'uBorderTitle', 'uBorderPaint', 'uPaintOnly', 'uBorderW', 'uBorderA', 'uPaintBorderW', 'uPaintBorderA', 'uMapPerPx',
                     'uShowWater', 'uWaterW', 'uWaterA', 'uSeaCol', 'uLakeCol', 'uRiverCol',
                      'uShowWasteBorder', 'uWasteW', 'uWasteA',
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
    this.lowRes = false;         // resize() 里判定：这台机器我给降过分辨率（见它那段说明 ✓）
    this.showWater = true;
    this.waterW = 1.0;
    this.waterA = 1.0;
    this.showWasteBorder = true;
    this.wasteW = 1.5;
    this.wasteA = 1.0;
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
        /* 🔴 **块尺寸别贴着上限开** ✗（用户报：手机版黑屏，而电脑正常 ✓）
         *   原来 tileW/tileH 直接取 lim（手机上 4096 ✓）✓
         *   → 地图 5632×2048 被切成 **2 块 4096×4096** ✗
         *     每层 = 4096×4096×2 字节 = **33MB** → 两层 **67MB 显存** ✓
         *     再加 CPU 那份 buf（33MB）+ 省份数据（23MB）→ 手机直接爆 ✓
         *     → 上下文丢失 / 纹理变坏 → **画面全黑** ✓
         *   ⚠ 这条路**只有手机走** ✗（电脑上限 16384 > 5632 → 不切块 ✓）
         *     所以电脑上永远测不出来 ✓ 这正是"电脑行、手机不行"的原因 ✓
         *   💡 改成**按实际需要开**：一块 2048 是条舒服的线 ✓
         *     同样这张图：2048 → 3 层 × 8MB = 24MB ✓（省 2.7 倍 ✓）
         *     层数多一点反而更好：显存按**块**算，不用一次占满 ✓ */
        const cap = Math.min(lim, 2048);
        const tileW = Math.max(1, Math.min(m.mapWidth, cap));
        const tileH = Math.max(1, Math.min(m.mapHeight, cap));
        layout = {
          tileW, tileH,
          cols: Math.ceil(m.mapWidth / tileW),
          rows: Math.ceil(m.mapHeight / tileH),
          synthetic: true,
        };
        const _mb = (layout.cols * layout.rows * tileW * tileH * 2 / 1048576).toFixed(0);
        console.log(`贴图上限 ${lim}px 装不下 ${m.mapWidth}×${m.mapHeight}`
          + ` → 就地切成 ${layout.cols}×${layout.rows} 块（每块 ${tileW}×${tileH}，约 ${_mb}MB）`);
        /* ⚠ 顺手写进"启动里程表" ✗ —— 用户手机上能直接看到走没走这条路 ✓ */
        try {
          if (typeof bootMark === 'function') {
            bootMark('切块' + layout.cols + '×' + layout.rows + ' 每块' + tileW + '×' + tileH + ' 约' + _mb + 'MB');
          }
        } catch (e) { /* ✓ */ }
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
  setHover(tid) {
    const v = tid == null ? this.noTitle : tid;
    if (this.hoverTid === v) return;        // 没换就别标脏 ✓（见下面 setHoverState 的说明）
    this.hoverTid = v;
    this.dirty = true;
  }

  /**
   * 悬停高亮那一组值**整体设一次**，而且**跟上一帧完全一样就不重画** ✓
   *
   * 为什么非要比较：高亮是画在着色器里的（不是叠一层透明的框），所以
   * "换高亮"= 整张图重跑一遍 fragment shader ✗
   * 而鼠标在地图上划动时**每换一格**都会走到这儿 —— 划过一整片海、或者划过一个
   * 大国家的许多省份时，高亮范围其实**一直没变**（还是那一片 / 还是那个国家）✓
   * 以前 `setHover()` 无条件 `dirty = true` ✗ → 每个 mousemove 都白渲染一整张图 ✗
   */
  setHoverState(hoverPid, paintOn, paint, label, tid) {
    const t = (tid == null) ? this.noTitle : tid;
    const p = paintOn ? 1 : 0;
    const c = paint || this.hoverPaint;
    const lb = label || 0;
    const hp = this.hoverPid || 0;
    const same = hp === (hoverPid || 0)
      && this.hoverPaintOn === p
      && this.hoverTid === t
      && (this.hoverLabel || 0) === lb
      && this.hoverPaint[0] === c[0] && this.hoverPaint[1] === c[1] && this.hoverPaint[2] === c[2];
    if (same) return;
    this.hoverPid = hoverPid || 0;
    this.hoverPaintOn = p;
    if (paint) this.hoverPaint = paint;
    this.hoverLabel = lb;
    this.hoverTid = t;
    this.dirty = true;
  }

  setView(x, y, w, h) {
    this.view.x = x; this.view.y = y;
    this.view.w = Math.max(w, 1e-3); this.view.h = Math.max(h, 1e-3);
    this.dirty = true;
  }

  /** **边界深度图** ✓（CPU 侧算好的 —— 见 app.js 的 buildBorderDepth ✓）
   *  R8UI ✓ 每格一个数 = "到最近那条缝的距离"（格 ✓ 0 = 紧挨着 ✓）
   *  ⚠ NEAREST ✗ —— 它是整数枚举（粗筛门槛），插值出来的小数没有意义 ✓
   *  ⚠ 跟 uProv / uTitleMap 同一套写法（整型纹理 + texelFetch ✓）不会引入新写法 ✓ */
  setBorderDepth(dist, w, h) {
    const gl = this.gl;
    /* 🔴 **先看这张卡吃不吃得下** ✗ —— 用户报"手机版进地图黑屏、只剩地名" ✓
     *   地名走 2D canvas ✗ 不受影响 → 所以问题在 WebGL 这边 ✓
     *   手机的 MAX_TEXTURE_SIZE 常常只有 4096 ✗ 而地图宽 5632 ✓
     *   超限时 texImage2D **不抛错**（只设个错误码 ✓）→ 纹理是坏的 → 后面全乱 ✓
     *   → 索性**不上传**：borderDepthOn 保持 false → 着色器 on = 0 → 退回射线 ✓ 画得对 ✓
     *   ⚠ 拿不到上限时按 16384 算（别因为读不到参数就把功能关了 ✓）*/
    const _maxTex = (gl.getParameter && gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 16384;
    if (w > _maxTex || h > _maxTex) {
      this.borderDepthOn = false;
      this.dirty = true;
      return;
    }
    if (this.borderDepthTex) gl.deleteTexture(this.borderDepthTex);
    /* **等级图**：R8UI ✓ 每格 1 字节 = **四路各 2 位**（0 压在边界上 · 1 紧挨着 · 2 更远 ✓）
     *   用户点的：离边界 2 格和 3 格**没有区别** ✗ 都不画 ✓ 所以 2 位就够 ✓
     *   它**只管排除**（这一路还要不要细算 ✓）· **画线仍旧走边掩码**（那里才有方向/亚格精度 ✓）
     *   ⚠ NEAREST ✗ —— 等级是枚举，插值没有意义 ✓ */
    /* ⚠ **用归一化 R8 而不是 R8UI** ✗ —— 整数纹理上传在某些驱动上会走
     *   **格式转换的慢路** ✓ 而归一化 R8 是各家的最快路径 ✓
     *   代价：texelFetch 出来是 0~1 的浮点 ✗ 着色器里 ×255 还原即可 ✓ */
    this.borderDepthTex = makeTexture(gl, w, h, gl.R8, gl.RED, gl.UNSIGNED_BYTE, dist, gl.NEAREST);
    this.borderDepthW = w;       // ⚠ 改签名时**必须一起来看函数体** ✗ 我漏过两次（w → bw → w）
    this.borderDepthH = h;       //   → 抛 ReferenceError → 纹理压根没传上去（异步的，同步断言抓不到 ✗）
    this.borderDepthOn = true;
    this.dirty = true;
  }

  
      resize() {
    if (this.fixedSize) return;   // 整图导出期间由调用方自己定尺寸
    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    /* **画布像素总数封顶** ✓（用户报的"电脑版非常卡"✓ 这条是主因）
     *
     * 边界那几趟是**逐像素**算的，一帧的开销 ∝ 画布像素数 ✗
     * 而 dpr 上限原来写死 2 ✗ —— 于是：
     *   · 4K 屏（3840×2160）dpr 2 → 3840×2160×4 ≈ **3300 万像素** ✗✗
     *   · Windows 缩放 125% / 150% 时 dpr 也已经到 1.25 / 1.5 ✗ 同样爆
     *   · 手机（390×844）dpr 2 → 才 260 万 ✓
     * 差了十几倍，这就是"手机不卡、电脑卡"的原因 ✓
     *
     * 所以给总量封顶：超了就把 dpr 降下来（画面略糊一点，但那点糊换的是十几倍速度 ✓）。
     * 下限 0.75 —— 再低就真糊了，宁可慢一点 ✗
     * ⚠ 普通 1080p（1920×1080×1 ≈ 200 万）**稳稳在限额内** ✓ 一点不受影响 ✓
     */
    const px = cssW * cssH * dpr * dpr;
    this.lowRes = false;
    if (px > MAX_CANVAS_PX) {
      dpr = Math.max(0.75, Math.sqrt(MAX_CANVAS_PX / (cssW * cssH)));
      this.lowRes = true;                 // 记住"这台机器我给它降过" ✓ 见 render() 里那个抗锯齿
    }
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.dirty = true;
    }
  }

  render() {
    /* 🔴 **逐帧体检**（只在手机上）✗ —— 用户报：手机版黑屏、中心像素 [0,0,0]、
     *   出错码 **1282（GL_INVALID_OPERATION）** ✓
     *   1282 是**异步**留下的：getError 返回的是"上一个还没被取走的错" ✓
     *   所以光看一次不知道是谁干的 ✓ 这里画前清空、画后看看还剩什么 ✓
     *   ⭐ 同时把**视口和画布尺寸**一起打出来 —— 我怀疑是"渲染器建的时候
     *     画布才 300×150（canvas 默认尺寸 ✓）而后来的视口没跟上" ✓
     *     → 画面被画进一个 300×150 的小角 → 屏幕其余地方全黑 ✓✓
     * ⚠ 只在手机上打 ✗ 桌面不刷屏 ✓ */
    const _diag = (typeof window !== 'undefined') && window.innerWidth && window.innerWidth <= 900;
    let _e0 = 0;
    if (_diag) {
      try {
        const g0 = this.gl;
        while (g0.getError() !== g0.NO_ERROR) { /* 清空历史错误 ✓ 最多几次 */ }
      } catch (e) { /* ✓ */ }
    }
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


    // **深度图：单元 9** ✓（0~8 已经被上面占满）
    if (this.borderDepthTex && this.borderDepthOn) {
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_2D, this.borderDepthTex);
      gl.uniform1i(u.uBorderDepth, 9);
      gl.uniform1i(u.uBorderDepthOn, 1);
    } else {
      /* ⚠ **关掉也得绑** ✗ —— 光设 uBorderDepthOn=0 不够 ✓
       *   着色器里那个 sampler 仍然存在 ✓ WebGL 会检查它指向的纹理完不完整 ✓
       *   （这条就是手机黑屏的根 ✓ 踩过一次别再踩 ✓）*/
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
      gl.uniform1i(u.uBorderDepth, 9);
      gl.uniform1i(u.uBorderDepthOn, 0);
    }

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
    // 水域 / 荒地边界：各一条开关 + 各自的粗细浓度 ✓
    gl.uniform1i(u.uShowWater, this.showWater ? 1 : 0);
    gl.uniform1f(u.uWaterW, this.waterW);
    gl.uniform1f(u.uWaterA, this.waterA != null ? this.waterA : 1);
    gl.uniform1i(u.uShowWasteBorder, this.showWasteBorder ? 1 : 0);
    gl.uniform1f(u.uWasteW, this.wasteW != null ? this.wasteW : 1.5);
    gl.uniform1f(u.uWasteA, this.wasteA != null ? this.wasteA : 1);
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
    gl.uniform1i(u.uNoAA, (this.noAA || this.lowRes) ? 1 : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    /* 🔴 **逐帧体检**（只在手机上）✗ —— 用户报：手机版黑屏、中心像素 [0,0,0]、
     *   出错码 **1282（GL_INVALID_OPERATION）** ✓
     *   这里把"这一帧画的时候"的几个关键状态一起打出来：
     *     · 画布 vs **视口**（我怀疑是视口没跟上画布 ✗）
     *     · 画完之后的 GL 错误码（画前我清过 ✓ 所以这儿报的就是**这一帧**的 ✓）
     *     · 采样用的那几张纹理有没有绑上 ✓
     * ⚠ 只在手机上打 ✗ 桌面不刷屏 ✓ */
    if ((typeof window !== 'undefined') && window.innerWidth && window.innerWidth <= 900
        && typeof bootMark === 'function') {
      try {
        const cv1 = gl.canvas;
        const vp = gl.getParameter(gl.VIEWPORT);
        const err = gl.getError();
        bootMark('帧:画布' + cv1.width + '×' + cv1.height
          + ' 视口' + vp[2] + '×' + vp[3] + ' 画后错' + err
          + ' 贴图' + (gl.isTexture(this.provTex) ? 'ok' : '坏'));
      } catch (e) { /* ✓ */ }
    }
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
