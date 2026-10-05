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
uniform int   uPaintOnly;       // 1 = 这条边界**只比手绘层**（CK3：不管原版颜色差）
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
  if (uShowWaste == 0 && tid != NONE && lc.a > 0.5) {
    return vec4(uWasteGrey, 1.0);
  }

  // **手绘在最上层**（荒地那条例外：它上面已经返回了）。
  // 玩家涂过的地方就该显示他涂的那个色：不管这一层此刻是海/湖这类
  // 伪头衔（地形是"永远显示、开关管不着"的），还是这个层级压根没有归属，
  // 也不管「浓度」调到了多少 —— 手绘不受浓度影响（浓度是给头衔色用的）。
  // 早先手绘排在两条提前返回**后面**，涂过的地块会被地形色顶掉。
  if (uShowPaint == 1) {
    vec4 pc = paintOf(pid);
    if (pc.a > 0.5) return vec4(pc.rgb, 1.0);
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

/** 沿 dir 方向找到最近的一条分界线，返回它到当前片元的**垂距**（地图像素）。

    必须往外走，不能只看紧邻那一格：缩小时一个屏幕像素盖住好几个地图像素，
    分界线完全可能落在两个采样点中间，只看紧邻就会整条漏掉（边框时有时无）。
    走到第一格不一样的邻居就停 —— 那就是这个方向上最近的一条缝。

    四个方向取最小，得到的就是到最近那条像素边的真实垂距：缝本身是横平竖直的，
    而我们必定落在它那一格的跨度之内，所以不用开方。 */
float rayDistTitle(ivec2 ip, vec2 f, ivec2 dir, uint t, int R, int tier) {
  for (int k = 1; k <= MAXR; k++) {
    if (k > R) break;
    // 写成 ivec2(dir.x * k, dir.y * k) 而不是 dir * k ——
    // 整数向量乘整数标量在 GLSL ES 3.0 里规不规范我记不准，展开最保险
    // tier：看哪一层的边界（-1 表示跟 uEditTier 一样）
    ivec2 q = ip + ivec2(dir.x * k, dir.y * k);
    uint tt = tier < 0 ? tidAt(q) : titleAt(pidAt(q), tier);
    // **海与海之间不画边界**（海岸线保留）✓
    // 注意两件事：
    //   · 荒地也是伪头衔（>= uRealTitles），但它**该有边界** ——
    //     所以两侧都不是荒地时才跳过（LUT 的 alpha 就是荒地标记 ✓）
    //   · **无主地（NONE）不是地形，是地** —— 它跟海之间那条就是海岸线，
    //     得画 ✓（以前把 NONE 一起算成"伪头衔"，无主地挨着海那条海岸线
    //     就整条没了 ✗）
    bool _tw = (t != NONE && t >= uint(uRealTitles));
    bool _uw = (tt != NONE && tt >= uint(uRealTitles));
    if (_tw && _uw) {
      float wa = wasteAlphaOf(t);
      float wb = wasteAlphaOf(tt);
      if (wa < 0.5 && wb < 0.5) continue;
    }
    if (tt != t) {
      float kf = float(k);
      if (dir.x != 0) return dir.x > 0 ? kf - f.x : f.x + kf - 1.0;
      return dir.y > 0 ? kf - f.y : f.y + kf - 1.0;
    }
  }
  return 1e9;
}

/** 同上，但看的是手绘层的分界 */
/** 两点的"原版色"（LUT 里那个头衔的颜色）✓ */
vec3 lutColour(ivec2 ip) {
  uint tid = titleAt(pidAt(ip), uTier);
  if (tid == NONE) return vec3(-1.0);
  return texelFetch(uColorLut, ivec2(int(tid) % uLutW, int(tid) / uLutW), 0).rgb;
}

/** 边界判据 = **颜色 + 标签** ✓
 *  ① 颜色不同（涂的色 / 原版色，各取显示的那个）→ 边界 ✓
 *  ② 颜色相同：两侧都没涂 → 头衔不同就算不同国家（标签不同 ✓）
 *             有一侧涂过 → **不画** ✓（他就是他自己那块，比如用自己的色涂自己的首都 ✓）*/
bool shownDiffers(ivec2 a, ivec2 b) {
  // CK3：这条边界只管**自己涂出来的**分界，原版颜色差归「头衔·边界」管 ✓
  if (uPaintOnly == 1) return paintDiffers(a, b);
  vec4 pa = paintAt(a);
  vec4 pb = paintAt(b);
  bool ta = pa.a > 0.5;
  bool tb = pb.a > 0.5;
  vec3 ca = ta ? pa.rgb : lutColour(a);
  vec3 cb = tb ? pb.rgb : lutColour(b);
  if (ca.x < -0.5 && cb.x < -0.5) return false;         // **两侧都没颜色（无主地）→ 不算分界** ✓
  if (ca.x < -0.5 || cb.x < -0.5) return true;          // 一侧有一侧没有 → 算分界 ✓
  if (distance(ca, cb) > 0.02) return true;             // 颜色不同 ✓
  if (ta && tb) {
    // **两侧都涂过、颜色还一样 → 比标记** ✓
    // 同色不同标记是两块，中间必须有线 ✗（以前这里直接 return false ✗ = 用户报的"边界没分开"✓）
    return paintLabelAt(a) != paintLabelAt(b);
  }
  if (!ta && !tb) {                                     // 都没涂：看标签（头衔）✓
    return titleAt(pidAt(a), uTier) != titleAt(pidAt(b), uTier);
  }
  return false;   // 一侧涂、一侧没涂且同色 → 不分界 ✓（"用自己的色涂自己的地"那种 ✓）
}

float rayDistPaint(ivec2 ip, vec2 f, ivec2 dir, int R) {
  // **显示出来的颜色边界**：手绘层不同 ✓ 或**原版色**不同 ✓ 都算
  //（地图本来就有的剧本色也算 ✓ —— 不用"先涂一笔"✗）
  // 每步比这两样就够（2~4 次取纹理 ✓），不再算 showPaint/showTitles/荒地那一堆分支 ✗
  for (int k = 1; k <= MAXR; k++) {
    if (k > R) break;
    ivec2 q = ip + ivec2(dir.x * k, dir.y * k);
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
    int R = int(clamp(ceil(0.5 * uMapPerPx * (max(uBorderW, uPaintBorderW) + 1.0)), 1.0, float(MAXR)));
    float dTitle = 1e9;
    float dPaint = 1e9;
    if (uBorderTitle == 1) {
      uint t0 = tidAt(ip);
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 1, 0), t0, R, -1));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2(-1, 0), t0, R, -1));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 0, 1), t0, R, -1));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 0,-1), t0, R, -1));
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
    // **填色边界**：永远用自己那套（链上最粗那条的粗细 + 实心），跟本层互不干扰 ✓
    if (dPaint < 1e8) {
      float bwp = 0.5 * uPaintBorderW * uMapPerPx;
      float bp  = 1.0 - smoothstep(bwp - ramp, bwp + ramp, dPaint);
      col = mix(col, vec3(0.035, 0.045, 0.06), bp * uPaintBorderA);
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
      de = min(de, rayDistTitle(ip, f, ivec2( 1, 0), te, Re, et));
      de = min(de, rayDistTitle(ip, f, ivec2(-1, 0), te, Re, et));
      de = min(de, rayDistTitle(ip, f, ivec2( 0, 1), te, Re, et));
      de = min(de, rayDistTitle(ip, f, ivec2( 0,-1), te, Re, et));
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

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (maxTex < this.mapW || maxTex < this.mapH) {
      throw new Error(`显卡最大纹理 ${maxTex}px，装不下这张地图（${this.mapW}×${this.mapH}）。`);
    }

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
    this.paintOnly = false;   // 见 uPaintOnly：CK3 会打开它   // 玩家涂色范围描边
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
    this.provTex = tiles
      ? makeTexture(gl, 1, 1, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT,
                    new Uint16Array(1), gl.NEAREST)
      : makeTexture(gl, m.mapWidth, m.mapHeight, gl.R16UI,
                    gl.RED_INTEGER, gl.UNSIGNED_SHORT, provinceIds, gl.NEAREST);

    // 分块路径：只有数据目录里带了 tiles.json（原尺寸那套）才启用 ✓
    this.tileInfo = tiles || null;
    this.useTiles = tiles ? 1 : 0;
    if (tiles) {
      const first = new Uint16Array(tiles.tileW * tiles.tileH);
      this.provArrTex = this.makeTileArray(tiles.tileW, tiles.tileH,
        tiles.cols * tiles.rows, first);
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
