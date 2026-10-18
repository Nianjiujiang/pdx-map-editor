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

// ---- 渲染器初始化失败的分类 / 现场收集（**必须排在 FRAG 之前** ✓
//    ⚠ 测试把片元着色器那一段到 compile 函数之间当**着色器源码**扫保留字 ✗
//      这段里只要出现 class / this 就会被误报成"着色器里用了保留字" ✓
//      （2026-10-17 第一次就这么红的 ✓）
//    ⚠ 注释里也**不许**写出那两个标记字面量 ✗ —— 测试用 indexOf 找它们，
//      注释里先出现一次就会把"着色器源码"截成一段注释（这次真踩了 ✓）
/**
 * **渲染器初始化失败** —— 错误里必须带"死在哪一步" ✓（2026-10-17 加）
 *
 *  以前 `_build()` 里任何一处失败都只剩一句 `着色器编译失败` ✗ ——
 *  可"上下文在创建时就被浏览器收走"跟"着色器真的写错了"完全是两回事：
 *    · 前者是**显卡/显存/驱动/后台切换**，换台机器或刷新就好了；
 *    · 后者是**代码 bug**，刷新一百次也一样。
 *  管理员那边看到的"着色器连接失败"就是被这一句话带偏的 ✓
 *
 *  stage 取值（app.js 的 `describeRendererFailure` 按它分人话）：
 *    `no-webgl2`      —— 浏览器/显卡没给出 WebGL2 上下文
 *    `context-lost`   —— 上下文创建后丢了 / 编译或链接时丢了
 *    `out-of-memory`  —— 显存 / 内存不够
 *    `shader-compile` —— 顶点 / 片元着色器真的编译不过
 *    `shader-link`    —— 两个着色器链接失败
 *    `texture-limit`  —— 设备贴图上限小到放不下任何切片
 *    `renderer`       —— 上面之外（建纹理 / VAO 之类）
 */
export class RendererSetupError extends Error {
  constructor(stage, message, detail) {
    super(message);
    this.name = 'RendererSetupError';
    this.stage = stage || 'renderer';
    this.detail = detail || {};
  }
}

/**
 * 这台机器是不是在用**软件渲染**（SwiftShader / llvmpipe / 微软基本显示适配器）✓
 *
 *  判据只用品味得出的两条，任意一条成立就算 ✓：
 *    ① `WEBGL_debug_renderer_info` 的 unmasked 名字里带软件光栅器的特征；
 *    ② **拿不到 unmasked 名字**，但 RENDERER 就是 `WebKit WebGL`
 *       （真显卡的 Chrome/Edge 在 Windows 上一般给得出 unmasked ✓；
 *        拿不到 + 原生渲染器名 = 大概率为软件路径 ✓）
 *
 *  ⚠ 宁可**少判**也别误伤 ✗ —— 把正常显卡认成软件渲染，会让用户白关一堆东西 ✓
 */
function detectSoftwareGL(gl) {
  try {
    let name = '';
    const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg && gl.getParameter) {
      name = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
    }
    const base = String((gl.getParameter && gl.getParameter(gl.RENDERER)) || '');
    const s = (name + ' ' + base).toLowerCase();
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(s)) return true;
    // 没有 unmasked 名字、且原生名就是 WebKit WebGL → 多半是软件路径 ✓
    if (!name && /webkit webgl/.test(base.toLowerCase())) return true;
    return false;
  } catch (e) { return false; }
}

/** 把 GL 的"现场"收集成一组普通字段 ✓（导出日志 / 错误屏都要用） */
function _glFacts(gl) {
  const out = { contextLost: false, glError: 0 };
  if (!gl) return out;
  try {
    out.contextLost = !!(gl.isContextLost && gl.isContextLost());
    out.glError = (gl.getError && gl.getError()) || 0;
    out.version = String((gl.getParameter && gl.getParameter(gl.VERSION)) || '');
    out.renderer = String((gl.getParameter && gl.getParameter(gl.RENDERER)) || '');
    out.vendor = String((gl.getParameter && gl.getParameter(gl.VENDOR)) || '');
    const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg && gl.getParameter) {
      out.unmaskedRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
      out.unmaskedVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
    }
    /* ⚠ 软件渲染标记也要进报告 ✗ —— 它决定了错误屏给哪一套建议 ✓
     *   （2026-10-18：用户那台就是软件渲染，报告里却只有一句 "WebKit WebGL"，
     *     光看报告分不出是"显卡弱"还是"根本没用显卡" ✓）*/
    out.softwareGL = detectSoftwareGL(gl);
  } catch (e) {
    out.factsError = String((e && e.message) || e);
  }
  return out;
}

/** 抛一个带 stage 的初始化错误 ✓（detail 里自动带上 GL 现场） */
function _setupFail(stage, message, gl, extra) {
  throw new RendererSetupError(stage, message, Object.assign(_glFacts(gl), extra || {}));
}

/** 建 WebGL2 上下文 —— **多试几组属性** ✓（2026-10-17 加）
 *
 *  为什么不能一次定生死 ✗：
 *    · 双显卡 / 集显机器上 `powerPreference: 'high-performance'` 偶尔直接返回 null；
 *    · 浏览器把"硬件加速被关"报成创建失败，但换一组属性（或稍后再试）能拿到软件上下文；
 *    · `webglcontextcreationerror` 的 `statusMessage` 是**唯一**能说明原因的文字，
 *      以前没接，玩家只能看到一句"不支持 WebGL2"。
 *
 *  ⚠ 这里只负责"拿到一个 gl 对象"，**不判断它是不是已经丢了** ✗ ——
 *    调用方在拿到之后立刻要 `isContextLost()` 判一次 ✓
 */
const _GL_ATTRS = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
};

function _createGL(canvas) {
  let creationError = '';
  const onCreationError = (e) => {
    creationError = String((e && e.statusMessage) || '');
    if (e && e.preventDefault) e.preventDefault();
  };
  if (canvas && canvas.addEventListener) {
    canvas.addEventListener('webglcontextcreationerror', onCreationError, false);
  }
  const tries = [
    Object.assign({}, _GL_ATTRS, { powerPreference: 'high-performance' }),
    Object.assign({}, _GL_ATTRS, { powerPreference: 'default' }),
    Object.assign({}, _GL_ATTRS),
  ];
  let gl = null;
  let thrown = null;
  for (const opts of tries) {
    try {
      gl = canvas.getContext('webgl2', opts);
    } catch (e) {
      thrown = e;
      gl = null;
    }
    if (gl) break;
  }
  if (canvas && canvas.removeEventListener) {
    canvas.removeEventListener('webglcontextcreationerror', onCreationError, false);
  }
  return { gl, creationError, thrown };
}

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
uniform int   uFineTier;       // **最细层**（荒地逐块节点住在这一层）
uniform int   uShowTitles;
uniform int   uShowPaint;
uniform float uMix;
uniform int   uBorderTitle;     // 画不画头衔之间的分界线
uniform int   uBorderPaint;     // 画不画手绘色块的分界线
uniform int   uPaintOnly;       // 1 = **当前没停在年份视图**（CK3 那种没有年份层的也算）
                                //     JS 那边 = !(有年份层 && 视图停在年份层)
                                //     用途：没开年份视图时，未上色的地块之间不互相划界
uniform vec3  uUnpainted;       // 「未上色区域」的颜色
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
uniform uint  uHoverTid;        // != NONE 时按**当前层那个头衔**整片亮（新包：一片一个 tid ✓）
uniform int   uHoverPaintOn;    // 1 = 高亮按涂色认族（只有剧本粒度 + 填色·边界时）
uniform vec3  uHoverPaint;      // 要高亮的那一族的涂色
uniform int   uHoverPid;        // >0 = 只高亮这一个地块（老包那种共享伪节点退回这一条）
/* **「同一片海」的编组号** —— 2026-10-13 起这是**老包的退路** ✓
 *   每层一片之后（#sea_<层>_<序号> 那种 ✓）同一片 = 同一个 tid ✓ 直接比 uHoverTid 就行 ✓
 *   但**每层一片之前打的包**里全世界的海共用一个 #sea（tid 相同 ✗）：
 *     按 tid 亮 = 全世界的海一起亮 ✗ 按 pid 又只能亮一格 ✗
 *   → 那批包仍由 CPU 侧按**当前编辑层那张水域名表**编号：同名 = 同一组 ✓
 *     （见 gl.js 的 rebuildHoverGroups / app.js 的悬停那一段 ✓）
 *   ⚠ 组号是**每 pid 一个**（EU5 最细层有 3635 组 ✗ 8 位装不下 ✓ 所以走 R16UI ✓）
 *   ⚠ uHoverGroupId == 0 = 没编组（新包 ✓）→ 走 uHoverTid / uHoverPid 那两条 ✓
 *   ⚠ 编组**优先于**下面两条 ✗（新包传的就是 0，所以不会打架 ✓）*/
uniform usampler2D uHoverGroup; // R16UI  province -> 组号（1..N 海 · N+1.. 荒地 · 0 = 不属于任何一片）
uniform int   uHoverGroupW;     // 那张表的宽度（跟手绘层同一套**拍平**写法 ✓）
uniform uint  uHoverGroupId;    // != 0 = 亮**这一组**（同一片海的所有地块 ✓ 不是全世界的海 ✗）
uniform uint  uHoverLabel;      // 要高亮的那一族的**标记编号**（0 = 没涂）✓ 同色不同标记 = 两块 ✗
uniform vec3  uBackdrop;
/* 🔴🔴 **底层身份标**（meta.kindMask 传成一张"每 pid 一格"的整数纹理 ✓ 2026-10-15 ✓）
 *   0 = 空位（0 号不用 ✓）/ 1 陆地 / 2 海洋 / 3 湖泊 / 4 河流 /
 *   5 不可通行海域 / 6 不可通行区域 ✓
 *   用途：**每一格按它最底层那个 pid 的身份上色** ✗ —
 *     归属、当前层有没有片，**都不参与** ✓（用户原话见下面 colorOfPid 那段 ✓）
 *   ⚠ uKindOn == 0（老包没这枚标 ✓）→ 整条让开，行为一丝不变 ✓ */
uniform usampler2D uKindTex;
uniform int   uKindOn;
uniform int   uKindW;           // 拍平宽度（跟 hoverGroup 同一套写法 ✓）
uniform vec3  uNature[5];       // 2..6 → 海 / 湖 / 河 / 不可通行海域 / 不可通行 ✓

/* **「水域 · 边界」那条线**（2026-10-16 ✓ 用户定的口径 ✓）
 *   只管**水域之间**（海洋 / 湖泊 / 河流 / 不可通行海域 ✓ 身份码 2..5 ✓）的缝 ✗
 *   海岸线（水 ↔ 陆）照旧归**本层头衔线**那条通道 ✓ 不归它 ✓
 *   于是同一条缝**只有一个出处** ✗（"两条通道不许同处画一遍"那个坑的正面写法 ✓
 *     旧通道那边由 rayDistTitle 让开 ✓ 见它里面那段 ✓）
 *   ⚠ 它是**独立一条通道**：地区 / 势力 / 填色三个开关**都不管它** ✓
 *     （用户原话："水域边界开关负责且仅负责水域之间的边界的显示或隐藏"✓
 *      所以"边界全关"也不影响它 ✓ —— 只认自己那个勾 ✓）
 *   ⚠ 走**编辑层**（uEditTier ✓）：跟本层头衔线同一层 ✓ 换层就换粒度 ✓
 *     跟别的边界一条规矩 ✓（见 handover 2026-10-16 §3.4 第 5 步 ✓）*/
uniform int   uWaterBorderOn;
uniform float uWaterBorderW;    // 粗细（格数，跟其它边界同一个单位 ✓）
uniform float uWaterBorderA;    // 浓度（0~1 ✓）
uniform usampler2D uWaterKind;  // R8UI 每 pid 一格：0 = 不是水 / 2..5 = 那四类 ✓
uniform int   uWaterKindW;      // 拍平宽度（跟 kindTex 同一套 ✓）

/* **「荒地 · 边界」那条线**（2026-10-17 ✓ 用户点名要的 ✓）
 *   原话："给荒地加上边界开关，这个负责的是**荒地与荒地之间**的边界，
 *          你之前做了水域-水域的边界，这个应该轻车熟路了吧"✓
 *   → 跟上面水域那条**同构**：只管"荒地 ↔ 荒地"的缝 ✗
 *     荒地挨着陆地 / 水的那一圈（外缘）**不归它** ✓ 照旧归本层头衔线 ✓
 *   ⚠ **它没有自己的纹理** ✗ —— 荒地读的是 「uKindTex」（身份标原样 ✓ 6 = 不可通行 ✓）
 *     那张本来就是每 pid 一格的 usampler2D ✓ 而且**一直绑着** ✓
 *     （对比：水域那条读 「uWaterKind」，因为"认不认得出是水"要算过一遍 ✓
 *       荒地不用算：kindMask 里 6 就是 6 ✓）
 *   ⚠ 独立一条通道：地区 / 势力 / 填色三个开关**都不管它** ✓
 *     跟水域那条一个规矩 —— "边界全关"也不影响它 ✓ 只认自己那个勾 ✓
 *   ⚠ 走**编辑层**（uEditTier ✓）跟别的边界同一层 ✓ */
uniform int   uWasteBorderOn;
uniform float uWasteBorderW;    // 粗细（格数 ✓）
uniform float uWasteBorderA;    // 浓度（0~1 ✓）

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

/** 这个地块属于哪一片海 / 荒地（0 = 不属于任何一片 ✓）
 *
 *  跟 paintLabelOf 同一套**拍平**索引（宽度另给一个 uniform ✗ 万一以后两者不一样 ✓）
 *  ⚠ 整数纹理一律 texelFetch ✗ 不能拿 sampler 的插值去采它 ✓ */
uint hoverGroupAt(uint pid) {
  int i = int(pid);
  return texelFetch(uHoverGroup, ivec2(i % uHoverGroupW, i / uHoverGroupW), 0).r;
}

/** 这个地块**最底层那个 pid 的身份** ✓（1 陆地 / 2 海 / 3 湖 / 4 河 / 5 不可通行海域 / 6 不可通行）
 *
 *  ⚠ uKindOn == 0（老包没有 kindMask ✓）→ 一律返回 1（陆地）✓
 *     调用方那条覆盖就会让开 ✓ 画面跟以前一模一样 ✓
 *  ⚠ 整数纹理一律 texelFetch ✗（跟 hoverGroupAt 同一条规矩 ✓ 不能靠采样器插值 ✓） */
int kindOf(uint pid) {
  if (uKindOn == 0) return 1;
  int i = int(pid);
  return int(texelFetch(uKindTex, ivec2(i % uKindW, i / uKindW), 0).r);
}

/** 身份 → 类色 ✓（七行调色板里那五行：2..6 ✓ 由 JS 侧 applySettings() 灌进来 ✓） */
vec3 natureColor(int k) {
  return uNature[clamp(k - 2, 0, 4)];
}

/** 一个省份此刻该显示成什么颜色。 */
vec4 colorOfPid(uint pid) {
  uint tid = titleAt(pid, uTier);
  vec4 lc = texelFetch(uColorLut, ivec2(int(tid) % uLutW, int(tid) / uLutW), 0);
  // 手绘在最上层：涂过的地直接返回它的颜色，浓度（uMix 只作用在头衔色上）
  // 与它无关 —— 不管这一层此刻是伪头衔还是没有归属。
  if (uShowPaint == 1) {
    vec4 pc = paintOf(pid);
    if (pc.a > 0.5) return vec4(pc.rgb, 1.0);
  }

  /* 🔴🔴 **荒地：读最细层那个 wl_ 节点的 LUT** ✗✗（2026-10-17 重做 ✓）
   *
   *   荒地自动上色算出来的颜色写在**每块荒地自己的最细节点**上（wl_<pid> ✓）——
   *   粗层那个荒地块是**同名几块共用**的（#impassable_c_3 那种 ✗），颜色会互相踩 ✗
   *   → 这里按 uFineTier 查，**跟当前视图 / 粒度无关** ✓
   *
   *   ⚠ **必须排在 kind >= 2 那道类色判断之前** ✗✗（2026-10-17 实跑修的 ✓）
   *     CK3 的荒地底层身份是 **kind = 6**（不可通行山地 ✓）→ 先判 kind 的话
   *     会直接返回「不可通行区域」那个灰，自动色永远露不出来 ✓
   *     （用户报的"取色/悬停都说上色成功，画面还是荒地色"正是这个 ✓）
   *
   *   ⚠ 怎么知道"这一格是荒地" ✗：JS 侧 setWasteFixed() 把标记打在
   *     **LUT 的 alpha 通道**上（荒地 = 255，其余 = 0 ✓ 那个通道别处没人用 ✓）
   *     → 一次取样就够，不用多传一张纹理 ✓
   *   ⚠ 也必须在 tid == NONE 那道早退**之前**查 ✗ ——
   *     剧本层荒地本来就没有归属（titleAt 给 NONE ✓）
   *   ⚠ 手绘层在上面已经先返回了 ✓（玩家直接涂的荒地仍然以涂色为准 ✓）
   *   ⚠ 水不会误命中 ✓：水的 LUT alpha 是 0，查完会继续往下走 kind 那条 ✓
   *   ⚠ 关掉「荒地自动上色」时 JS 会把这份 LUT 写回「不可通行区域」那个色 ✓
   *     着色器这边**不用再判开关** ✓ */
  {
    uint _fw = titleAt(pid, uFineTier);
    if (_fw != NONE) {
      vec4 _fc = texelFetch(uColorLut, ivec2(int(_fw) % uLutW, int(_fw) / uLutW), 0);
      if (_fc.a > 0.5) return vec4(_fc.rgb, 1.0);
    }
  }

  /* 🔴🔴 **按底层身份上色** ✗✗（2026-10-15 ✓ 用户要求 ✓）
   *   用户原话："解决一下 EU5 的海洋不上色的问题……上不上色看的是**具体的最底层单位
   *     属于什么东西**" ✓
   *   → 这一格的底层 pid 只要是水 / 不可通行那几类（kind ≥ 2 ✓），**直接给类色** ✓：
   *     跟它在哪一层、有没有片、有没有归属**都无关** ✓✓
   *     （EU5 的脚本层海域本来是"无主 → 未上色灰"✗ 正是用户在报的那件事 ✓）
   *   ⚠ **顺序**：手绘那层在上面 ✓（涂过的地上面已经原样返回 ✓
   *     玩家涂色 / 涂出来的色块一个字节都不受影响 ✓）
   *   ⚠ 荒地（alpha 标记）已经在上一步返回了 ✓ 这里只剩真正的水 / 老荒地 ✓
   *   ⚠ kind == 1（陆地）**一律往下走老路** ✗：
   *     无片（无主）→ uBackdrop / uUnpainted ✓、有片 → LUT 头衔色 + 浓度 ✓
   *     脚本层有主地、地理层陆地头衔、国名色、边界全都不许受影响 ✓
   *   ⚠ 老包（uKindOn == 0 → kindOf 恒为 1）→ 这一段永不命中 ✓ 行为不变 ✓ */
  int _kind = kindOf(pid);
  if (_kind >= 2) return vec4(natureColor(_kind), 1.0);

  /* **没有归属的地块**（NONE）—— 两种情形给两种色 ✓（2026-10-13 用户定的 ✓）：
   *   · **没开剧本**（uPaintOnly == 1，见它声明处）→ 显示**背景色** ✓
   *     这时候整张图就是"还没上色的底"，跟背景一气呵成 ✓
   *   · **开着剧本** → 显示设置里那项「未上色区域」✓
   *     它跟背景色是**两项**（用户要求拆开 ✓）—— 默认背景 220、未上色 150 ✓
   *   ⚠ 不是透明 ✗：透明露出来的是深色底，跟海、跟空地都分不清 ✓
   *   （以前这里写死 150 灰、两种情况一个样 ✓）*/
  if (tid == NONE) {
    return vec4(uPaintOnly == 1 ? uBackdrop : uUnpainted, 1.0);
  }
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

/** 这个地块**是不是水**、是哪一类水 ✓（0 = 不是水 ✓ 2 海 / 3 湖 / 4 河 / 5 不可通行海域 ✓）
 *
 *  ⚠ **算不出水陆的包**（没有 kindMask、也没有 #sea_ 那几把键 ✓ 老包 ✓）
 *     那张表全 0、app 侧给的 waterBorderOn 也是 false → 一律返回 0
 *     → 水域那条通道整条退化成现状 ✓ 一个字节都不动 ✓
 *     （v0.30 的 GLSL ES 3.0：uniform 在**非一致控制流**里照样能读 ✗
 *       所以这个提前返回是纯优化 ✓ 不是必须的 ✓）
 *  ⚠ 整数纹理一律 texelFetch ✗（跟 kindOf / hoverGroupAt 同一条规矩 ✓）
 *  🔴 **位置很讲究** ✗✗ —— 它调 pidAt，所以在着色器里必须排在 pidAt **后面** ✓
 *     （我第一版顺手放在 natureColor 旁边 = 排到 pidAt 前头去了 ✓
 *      test_modes 那条"先用后定义"的断言当场报出来："缺前置声明: pidAt" ✓
 *      真跑起来就是**着色器编译失败 → 白屏** ✓ 那条断言救了一次 ✓）
 *     → 所以它跟 paintLabelAt 那几个**同一段**（都在 pidAt 之后 ✓）*/
uint waterAt(ivec2 q) {
  uint pid = pidAt(q);
  if (pid == 0u) return 0u;
  int i = int(pid);
  return texelFetch(uWaterKind, ivec2(i % uWaterKindW, i / uWaterKindW), 0).r;
}

/** 这一格是水（且**算得出水陆**）✓ —— 判据就一句话，收在一处 ✓
 *  ⚠ 表全 0 时它恒 false → 老包上所有跟水有关的让位全都不生效 ✓ 观感不变 ✓ */
bool waterIs(ivec2 q) {
  return waterAt(q) != 0u;
}

/** 这一格**是不是荒地**（不可通行区域 ✓ 身份码 6 ✓）
 *
 *  🔴🔴 **2026-10-17：给荒地也开一条"荒地 ↔ 荒地"的边界通道** ✗✗
 *    用户原话："给荒地加上边界开关，这个负责的是荒地与荒地之间的边界，
 *              你之前做了水域-水域的边界，这个应该轻车熟路了吧"✓
 *
 *  ⚠ **它跟水域那条读的纹理本来就是同一张** ✗ ——
 *    水域那条读的是 「uWaterKind」（app 侧算的"认不认得出是水" 2..5 ✓）；
 *    荒地这条读 **「uKindTex」**（身份标原样 2..6 ✓）——
 *    **6 就在里面** ✓ 所以**不用新开纹理、不用新加 uniform** ✓
 *    （「uKindTex」 一直是绑着的 ✓ 见 JS 那边"它跟 kindTex 一样一直绑着"那段 ✓）
 *  ⚠ 判据收在这一处 ✗ —— 别在别处写 「kindOf == 6」 ✓
 *  ⚠ 「uKindOn == 0」（老包没这枚标 ✓）→ 它恒 false → 荒地那条整条不生效 ✓ 观感不变 ✓ */
bool wasteIs(ivec2 q) {
  if (uKindOn == 0) return false;
  uint pid = pidAt(q);
  if (pid == 0u) return false;
  int i = int(pid);
  return texelFetch(uKindTex, ivec2(i % uKindW, i / uKindW), 0).r == 6u;
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
 *   一帧的采样次数 ≈ 像素 × 4 × R × 边界趟数（本层 / 填色 / 多级链最多 4 级）
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

/** 两点的"原版色"（LUT 里那个头衔的颜色）✓ */
vec3 lutColour(ivec2 ip) {
  uint tid = titleAt(pidAt(ip), uTier);
  if (tid == NONE) return vec3(-1.0);
  return texelFetch(uColorLut, ivec2(int(tid) % uLutW, int(tid) / uLutW), 0).rgb;
}

/** 沿 dir 方向找到最近的一条分界线，返回它到当前片元的**垂距**（地图像素）。

    必须往外走，不能只看紧邻那一格：缩小时一个屏幕像素盖住好几个地图像素，
    分界线完全可能落在两个采样点中间，只看紧邻就会整条漏掉（边框时有时无）。
    走到第一格不一样的邻居就停 —— 那就是这个方向上最近的一条缝。

    四个方向取最小，得到的就是到最近那条像素边的真实垂距：缝本身是横平竖直的，
    而我们必定落在它那一格的跨度之内，所以不用开方。 */
float rayDistTitle(ivec2 ip, vec2 f, ivec2 dir, uint t, int R, int tier) {
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
    /* ⚠ **两边都是水** → 这一向不做"跳一步"预筛 ✗（2026-10-16 ✓）
     *   水水缝现在归「水域 · 边界」那条通道 ✓ **本层线 / 多级链一律让开** ✓
     *   预筛只看头衔：一片水自己内部头衔相同 → 会说"这一向没缝" ✓
     *   可这一片水的**另一头**就贴着另一片水 ✓ 那条缝正好在中间被跳过去 ✗
     *   → 两边都是水时不预筛，老老实实走下面的逐格循环 ✓（水面上本来就不多 ✓）*/
    if (!(waterIs(ip) && waterIs(far))
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
    uint tt = tier < 0 ? tidAt(q) : titleAt(pidAt(q), tier);
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
      /* 🔴🔴 **水 ↔ 水那条缝让给「水域 · 边界」** ✗✗（2026-10-16 ✓ 用户定的口径 ✓）
       *
       *   用户原话："水域边界开关负责且仅负责**水域之间**（海洋、湖泊、河流、
       *     不可通行水域）的边界"✓ 而且"**剧本层**：水↔水的缝**任何层都归水域开关**"✓
       *     （他的理由："不存在一个水域能被涂色成为势力"✓
       *      所以势力 / 地区 / 填色三个开关都不该管它 ✓）
       *
       *   ⚠ **只让开"两边都是水"那条** ✗ —— 海岸线（水 ↔ 陆）**照旧归本通道** ✓
       *     （用户点名要的："水域边界只管水域之间的边界"✓ 海岸线是陆那边的线 ✓）
       *   ⚠ 那张表算不出水陆（老包 ✓）时 waterIs 恒 false → 这一句等于不存在 ✓
       *     行为跟改造前一模一样 ✓
       *   ⚠ **不能在这儿 return 1e9 走"这一向没了"** ✗——
       *     得**继续往外走** ✓：跳过这条水水缝之后，外面可能还有一条
       *     真正归本通道的缝（比如再过去是一片陆地的边 ✓）
       *     continue 就是"这条不算，接着找" ✓（见 8.3 第 4 条那个坑 ✓）*/
      if (waterIs(ip) && waterIs(q)) continue;
      /* 🔴 **荒地 ↔ 荒地那条也让开** ✗✗（2026-10-17 ✓ 跟水域同一句、同一个道理 ✓）
       *   荒地有自己那条通道了（「荒地 · 边界」✓）→ 这条缝归它 ✓
       *   ⚠ 同样**只让开两边都是荒地** ✗ —— 荒地的外缘（挨着陆地 / 水）照旧归本通道 ✓
       *   ⚠ 同样**必须 continue 不是 return** ✗（跳过这条，外面可能还有一条归本通道的 ✓）*/
      if (wasteIs(ip) && wasteIs(q)) continue;
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
/** 屏幕上那一格显示的颜色 = LUT 原色（没涂时）✓ */
vec3 shownColour(ivec2 ip) {
  return lutColour(ip);
}

/** 一格**在屏幕上**的样子：颜色 + 涂没涂 + 标记 ✓
 *
 *  为什么要有这个"先算一次再比"的结构（用户要求的"维持矢量画法、只降压"✓）：
 *   射线循环里**起点那一侧从头到尾都没变** ✗ 可以前每步都把它重算一遍 ——
 *   paintAt + shownColour（里面还有 pidAt / titleAt）+ paintLabelAt
 *   一趟下来是 10 次左右的纹理采样 ✗✗ 而它 4 方向 × R 步 全在重复同一件事 ✓
 *   缩放时 R 一涨，这笔账就是卡顿的大头 ✓
 *   → 起点算一次（cellViewOf(ip) ✓），循环里每步只算对面那一格 ✓ **省一半** ✓
 */
struct CellView {
  vec3 col;       // 屏幕上的颜色（x < -0.5 = 这一格没颜色）
  bool painted;   // 玩家涂过没有
  uint tid;       // **编辑层**的头衔序号（预筛算"两侧头衔同不同"要用 ✓）
  uint label;     // 标记编号
  uint pid;       // 省份号（取 tid 时要用 ✓ 见 cellViewOf）
};

CellView cellViewOf(ivec2 ip) {
  CellView v;
  vec4 p = paintAt(ip);
  v.painted = p.a > 0.5;
  v.col = v.painted ? p.rgb : shownColour(ip);
  v.pid = pidAt(ip);
  v.tid = titleAt(v.pid, uEditTier);
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
  if (ca.x < -0.5 && cb.x < -0.5) return false;  // 两边都没颜色（无主地）→ 不划 ✓
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

/* **沿 dir 找最近的填色分界线**（到缝的垂距，单位是地图像素 ✓）
 */
float rayDistPaint(ivec2 ip, vec2 f, ivec2 dir, int R) {
  // **显示出来的颜色边界**：手绘层不同 ✓ 或**显示色**不同 ✓ 都算
  //（地图本来就有的剧本色也算 ✓ —— 不用"先涂一笔"✗）
  // 每步比这两样就够（2~4 次取纹理 ✓），不再算 showPaint/showTitles 那一堆分支 ✗
  /* **起点那一侧算一次** ✓（循环不变量 ✗ 原来每步重算，一趟下来 10 次采样 ✗ 见 cellViewOf ✓）
   * ⚠ **这里不能写 const** ✗ —— GLSL 的 const 是**编译期常量**，
   *   接运行时函数（titleAt）会直接编不过：
   *     ERROR: '=': assigning non-constant to 'const bool'
   *   （用户报过一次，整个着色器编译失败 → 画面全白 ✓ 我踩的 ✓）*/
  CellView _A = cellViewOf(ip);
  /* **先跳一步探路** ✓（见 rayDistTitle 上面那段注释 ✓）
   *   这一趟每步要跑颜色 / 标记两样判定，是几条射线里最贵的一条 ✗
   *   所以预筛在这儿收益最大 ✓ */
  if (R >= PRESCREEN_MIN_R) {
    ivec2 far = ip + ivec2(dir.x * R, dir.y * R);
    CellView _F = cellViewOf(far);
    if (_A.tid == _F.tid && !viewsDiffer(_A, _F)) return 1e9;
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
    ivec2 q = ip + ivec2(dir.x * _d, dir.y * _d);
    float kf = float(_d);
    float dl = dir.x != 0 ? (dir.x > 0 ? kf - f.x : f.x + kf - 1.0)
                          : (dir.y > 0 ? kf - f.y : f.y + kf - 1.0);
    CellView _B = cellViewOf(q);       // **每步只算一次** ✓ 两样判定共用它 ✓
    if (viewsDiffer(_A, _B)) {
      /* **水 ↔ 水那条缝也让开** ✓（2026-10-16 ✓ 跟 rayDistTitle 里同一条规矩 ✓）
       *   填色边界管的是"你涂出来的色块"✓ 而水**压根不能涂** ✓
       *   （用户 2026-10-16 定的第 11 条：水域四类禁止上色 ✓ 判据按 pid ✓）
       *   → 它上面永远不会有玩家色块 ✓ 这条缝归「水域 · 边界」✓
       *   ⚠ 同样**只让开两边都是水**那条 ✗ —— 海岸线还得它画 ✓ */
      if (waterIs(ip) && waterIs(q)) continue;
      /* 🔴 **荒地 ↔ 荒地那条也让开** ✗✗（2026-10-17 ✓ 跟水域同一句、同一个道理 ✓）
       *   荒地有自己那条通道了（「荒地 · 边界」✓）→ 这条缝归它 ✓
       *   ⚠ 同样**只让开两边都是荒地** ✗ —— 荒地的外缘（挨着陆地 / 水）照旧归本通道 ✓
       *   ⚠ 同样**必须 continue 不是 return** ✗（跳过这条，外面可能还有一条归本通道的 ✓）*/
      if (wasteIs(ip) && wasteIs(q)) continue;
      return dl;
    }
  }
  return 1e9;
}

/** **沿 dir 找最近的一条"水域 ↔ 水域"的缝** ✓（到缝的垂距，单位是地图像素 ✓）
 *
 *  「水域 · 边界」那条通道专用 ✓（2026-10-16 ✓ 用户定的口径 ✓）
 *
 *  判据两句话：
 *    · **两侧都得是水** ✓（waterIs ✓ 一侧是陆就不归这条通道 ✗
 *      —— 那是海岸线，归本层头衔线 ✓）
 *    · **编辑层那两个 tid 不同** ✓（跟本层头衔线**同一层** ✓ 换层就换粒度 ✓
 *      跟别的边界一条规矩 ✓）
 *
 *  ⚠ 这一条**故意不看**上面那两条通道的让位 ✗ ——
 *    水水缝正是它们让开的那一类 ✓ 让位归让位、画归画，两边判据刚好互补 ✓
 *  ⚠ **先跳一步探路**的预筛在这儿**不能用** ✗（跟 rayDistTitle 里那条同理 ✓）：
 *    预筛比的是**头衔**，而水水缝要的是**头衔不同** ✓
 *    可"一头一尾头衔相同"中间照样可能夹着另一片水 ✗ → 直接走满全程 ✓
 *    （水面上这类像素本来就不多 ✓ 不会拖慢陆地 ✓）
 *  ⚠ 跳步（stride ✓）照旧要用 ✓ —— 缩小时它才是"不卡"的那一半 ✓ */
float rayDistWater(ivec2 ip, vec2 f, ivec2 dir, uint t, int R) {
  int _st = max(1, int(uMapPerPx * 0.5));
  for (int k = 1; k <= MAXR; k++) {
    int _d = k * _st;                       // 这一趟实际跨了多少格 ✓
    if (_d > R) break;
    ivec2 q = ip + ivec2(dir.x * _d, dir.y * _d);
    if (!waterIs(q)) continue;              // 对面不是水 → 这条不算（海岸线不归我 ✓）
    if (titleAt(pidAt(q), uEditTier) != t) {
      float kf = float(_d);
      if (dir.x != 0) return dir.x > 0 ? kf - f.x : f.x + kf - 1.0;
      return dir.y > 0 ? kf - f.y : f.y + kf - 1.0;
    }
  }
  return 1e9;
}

/** **荒地 ↔ 荒地**那条缝最近在哪个方向、多远 ✓（2026-10-17 ✓ 照 「rayDistWater」 抄的 ✓）
 *
 *  用户原话："给荒地加上边界开关，这个负责的是荒地与荒地之间的边界，
 *            你之前做了水域-水域的边界，这个应该轻车熟路了吧"✓
 *
 *  判据两句话（跟水域那条**一字不差**，只有 「waterIs」 → 「wasteIs」 换了 ✓）：
 *    · **两侧都得是荒地** ✓（一侧是陆地 / 水就不归这条 ✗ —— 那是它的外缘 ✓）
 *    · **编辑层那两个 tid 不同** ✓（跟本层头衔线同一层 ✓ 换层就换粒度 ✓）
 *
 *  ⚠ 跟水域那条一样：**先跳一步探路**的预筛在这儿不能用 ✗（理由同 ✓）
 *  ⚠ 跳步照旧要用 ✓ —— 缩小时它才是"不卡"的那一半 ✓ */
float rayDistWaste(ivec2 ip, vec2 f, ivec2 dir, uint t, int R) {
  int _st = max(1, int(uMapPerPx * 0.5));
  for (int k = 1; k <= MAXR; k++) {
    int _d = k * _st;                       // 这一趟实际跨了多少格 ✓
    if (_d > R) break;
    ivec2 q = ip + ivec2(dir.x * _d, dir.y * _d);
    if (!wasteIs(q)) continue;              // 对面不是荒地 → 这条不算 ✓
    if (titleAt(pidAt(q), uEditTier) != t) {
      float kf = float(_d);
      if (dir.x != 0) return dir.x > 0 ? kf - f.x : f.x + kf - 1.0;
      return dir.y > 0 ? kf - f.y : f.y + kf - 1.0;
    }
  }
  return 1e9;
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
    // ⚠ 半径按**最粗的那条**算（线宽大于此半径的线会被裁掉 ✓）
    float _bMax = max(uBorderW, uPaintBorderW);
    int R = int(clamp(ceil(0.5 * uMapPerPx * (_bMax + 1.0)),
                           1.0, float(MAXR)));
    float dTitle = 1e9;
    float dPaint = 1e9;
    /* **缩小那一档：四路距离直接填进去** ✓（放大走边掩码、射线只当兜底 ✓）
     *   四路各跟自己的半宽比就行 —— 半宽那步在下面混色处做 ✓ 不用在这儿判 ✓
     *   ⚠ 头衔那一通道（A）同时供"本层线"和"多级链"✓ 它俩只差线宽 ✓ */
    /* 多级链也各有自己的宽度 ✗ 新路径一次扫描要扫到"最粗那条"的半径才够 ✓
     *（距离本身**不按线宽裁剪** ✓ 每条线各自在混色那步判够不够 ✓ 所以取最大就对 ✓）*/
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
      // 正常那条：就是本层的普通头衔缝 ✓
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 1, 0), t0, R, -1));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2(-1, 0), t0, R, -1));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 0, 1), t0, R, -1));
      dTitle = min(dTitle, rayDistTitle(ip, f, ivec2( 0,-1), t0, R, -1));
    }
    /* **填色边界的那趟射线**：只在「填色边界」开着时才算（dPaint 只有它用 ✓）*/
    if (_nearSeam && uBorderPaint == 1) {
      float _w0 = rayDistPaint(ip, f, ivec2( 1, 0), R);
      float _w1 = rayDistPaint(ip, f, ivec2(-1, 0), R);
      float _w2 = rayDistPaint(ip, f, ivec2( 0, 1), R);
      float _w3 = rayDistPaint(ip, f, ivec2( 0,-1), R);
      dPaint = min(min(_w0, _w1), min(_w2, _w3));
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
        de = min(de, rayDistTitle(ip, f, ivec2( 1, 0), te, Re, et));
        de = min(de, rayDistTitle(ip, f, ivec2(-1, 0), te, Re, et));
        de = min(de, rayDistTitle(ip, f, ivec2( 0, 1), te, Re, et));
        de = min(de, rayDistTitle(ip, f, ivec2( 0,-1), te, Re, et));
      }
      if (de < 1e8) {
        float bwe = 0.5 * uExtraW[ex] * uMapPerPx;
        float be  = 1.0 - smoothstep(bwe - ramp, bwe + ramp, de);
        col = mix(col, vec3(0.035, 0.045, 0.06), be * uExtraA[ex]);
      }
    }
    /* ============ **水域边界**（水域 ↔ 水域 ✓ 2026-10-16）============
     *  用户口径（原话见 handover §3.1 ✓）：水域边界开关**负责且仅负责**
     *    「水域之间（海洋 / 湖泊 / 河流 / 不可通行海域）的边界」✓
     *  海岸线（水 ↔ 陆）**不归它** ✗ —— 那条仍旧由本层头衔线画 ✓
     *
     *  ⚠ 三级闸，一个都不能少 ✗：
     *    ① uWaterBorderOn —— 用户那个勾（app 那边已把"勾了 + 这张图算得出水陆"AND 好 ✓）
     *       它**不看** 地区 / 势力 / 填色 那三个开关 ✓（用户要的就是独立 ✓
     *       所以"边界全关"时水域线**照样在** ✓ —— 想关就关自己那个勾 ✓）
     *    ② uWaterBorderA > 0 —— 浓度拉到 0% = 那条线完全不画 ✓
     *       （跟别处同一个口径 ✓：浓度 0 不是"线还在但看不见"✗ 是压根不画 ✓）
     *    ③ 射线要真找得到那条缝（下面 de < 1e8 ✓）
     *
     *  ⚠ 判据 = "**两侧都是水** 且 编辑层那两个 tid 不同" ✓（跟本层线**同一层** ✓）
     *    一侧水一侧陆 → waterIs 有一个 false → 这条通道不管 ✓ 交给本层线 ✓
     *  ⚠ 旧那两条通道在水水缝上已经被让开了 ✓（rayDistTitle / rayDistPaint ✓）
     *    → 同一条缝**只有一个出处** ✓ 不会"后画的赢" ✓ */
    if (uWaterBorderOn == 1 && uWaterBorderA > 0.0) {
      uint tw = titleAt(pidAt(ip), uEditTier);
      int Rw = int(clamp(ceil(0.5 * uMapPerPx * (uWaterBorderW + 1.0)), 1.0, float(MAXR)));
      float dw = 1e9;
      dw = min(dw, rayDistWater(ip, f, ivec2( 1, 0), tw, Rw));
      dw = min(dw, rayDistWater(ip, f, ivec2(-1, 0), tw, Rw));
      dw = min(dw, rayDistWater(ip, f, ivec2( 0, 1), tw, Rw));
      dw = min(dw, rayDistWater(ip, f, ivec2( 0,-1), tw, Rw));
      if (dw < 1e8) {
        float bww = 0.5 * uWaterBorderW * uMapPerPx;
        float bw2 = 1.0 - smoothstep(bww - ramp, bww + ramp, dw);
        col = mix(col, vec3(0.035, 0.045, 0.06), bw2 * uWaterBorderA);
      }
    }
    /* ============ **荒地边界**（荒地 ↔ 荒地 ✓ 2026-10-17）============
     *  用户原话："给荒地加上边界开关，这个负责的是**荒地与荒地之间**的边界，
     *            你之前做了水域-水域的边界，这个应该轻车熟路了吧"✓
     *  → 跟上面水域那段**一个模子** ✗ 只换了三处：
     *    ① uniform 名（uWasteBorder* ✓）
     *    ② 判据函数（「wasteIs」 ✓ —— 读的是 「uKindTex」 那张本来就绑着的身份标 ✓
     *       **没有新纹理** ✓ 跟水域那条不同：水域要算过一遍才知道是不是水 ✓ 荒地不用 ✓）
     *    ③ 让位那两句（两条旧通道在**荒地缝**上让开 ✓ 见 rayDistTitle / rayDistPaint ✓）
     *
     *  ⚠ 三级闸照样一个都不能少 ✗（On / A > 0 / 射线真找得到 ✓）
     *    ① uWasteBorderOn —— 用户那个勾**且**这张图有身份标（app 那边 AND 好 ✓）
     *       它**不看** 地区 / 势力 / 填色 那三个开关 ✓ 独立 ✓
     *    ② uWasteBorderA > 0 —— 浓度 0% = 那条线完全不画 ✓（跟别处同口径 ✓）
     *    ③ 射线找得到 ✓ */
    if (uWasteBorderOn == 1 && uWasteBorderA > 0.0) {
      uint tw2 = titleAt(pidAt(ip), uEditTier);
      int Rw2 = int(clamp(ceil(0.5 * uMapPerPx * (uWasteBorderW + 1.0)), 1.0, float(MAXR)));
      float dq = 1e9;
      dq = min(dq, rayDistWaste(ip, f, ivec2( 1, 0), tw2, Rw2));
      dq = min(dq, rayDistWaste(ip, f, ivec2(-1, 0), tw2, Rw2));
      dq = min(dq, rayDistWaste(ip, f, ivec2( 0, 1), tw2, Rw2));
      dq = min(dq, rayDistWaste(ip, f, ivec2( 0,-1), tw2, Rw2));
      if (dq < 1e8) {
        float bwq = 0.5 * uWasteBorderW * uMapPerPx;
        float bq2 = 1.0 - smoothstep(bwq - ramp, bwq + ramp, dq);
        col = mix(col, vec3(0.035, 0.045, 0.06), bq2 * uWasteBorderA);
      }
    }
  }
  /* 🔴 **这个右花括号属于上面那个 if (pidAt(ip) != 0u)** ✗ ——
   *   它以前落在那一堆 dTitle / dPaint 声明后面，把 if **提前闭合**了 ✓
   *   后果：射线那整段跑到块外 —— 连地图底色（provAt = 0）都去跑边界射线 ✗
   *   为了让它还能编过，当时**又补了一份一模一样的声明**（R / dTitle / …）✓
   *   → 一个 if 两个作用域、同一批名字两份、外加一个算完没人用的 Rall ✓
   *   2026-10-12：把这个右花括号挪回它该在的位置（缩进本来就写着它在这儿 ✓），
   *   删掉那份重复声明和死代码 ✓ **别再把它往上挪** ✗
   *   ⚠ 还有：这段里**不许出现反引号** ✗ —— 整段着色器是 JS 模板字符串，
   *    一个反引号就把文件截断（测试当场炸在模块加载上 ✓）*/

  // 悬停**压暗**：整个头衔一起暗 ✓（用户要求：高亮 → 高暗）
  // **亮**起来的是 **uEditTier** 那一级 ✓（用户要求：把"高暗"改回"高亮"✓）
  // 暗下去的那块必须正好是"点下去会涂到的那块"，不然根本不知道会改到谁。
  // 注意：**不看 uShowTitles**。关掉原版颜色之后图上是底色，
  // 但悬停仍然要暗下去 —— 不然根本不知道会涂到哪一块。
  if (uHoverGroupId != 0u) {
    /* **同一片海**（或同一片荒地）整片一起亮 ✓（2026-10-13 用户要求：
     *   "HOI4 的战略地图的高亮显示是海域一起来而不是分开，EU 同理"）
     *   ⚠ 这一条现在**只有老包走** ✗ —— 那批包里全世界的海共用一个 #sea
     *     （tid 相同 ✗ 按 tid 亮会把**全世界的海**一起点亮 ✓）所以 CPU 侧
     *     按真名表编了组号 ✓（组号跟着**编辑层**那张水域名表走 ✓ 见 rebuildHoverGroups）
     *   新包（每层一片 ✓）走的是下面 uHoverTid 那条：同一个 tid = 同一片 ✓
     *   ⚠ 排在 uHoverPid 前面：有编组就按编组亮 ✓ 没编组才退回"只亮一格" ✓ */
    if (hoverGroupAt(pidAt(ip)) == uHoverGroupId) col = mix(col, vec3(1.0), 0.30);
  } else if (uHoverPid > 0) {
    // 海/湖/荒地：只压暗光标底下这**一块**（老包那种共享伪节点退回这一条）
    // ⚠ 现在这是**退路** ✓ —— 有编组表 / 有每层一片的包都走上面那两条 ✓
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

/** 上下文是不是**被浏览器收走了**（驱动重置 / 切后台 / 显存紧张 ✓）
 *
 * 🔴 **这条判断必须排在"编译失败"前面** ✗ —— 见过的那一幕（2026-10-16）：
 *   上下文在编译途中被收走 → `COMPILE_STATUS` 是 false、`getShaderInfoLog` 是 **null**
 *   → 报出来只有一句「着色器编译失败：null」✓
 *   于是所有人都去查着色器（查了半天什么都没问题）✗ 而真凶是上下文没了 ✓
 *   ⚠ 拿不到 isContextLost 的（老桩 / 假 GL）就当"没丢" ✓ 别把正常失败也吞了 */
function ctxLost(gl) {
  try { return !!(gl.isContextLost && gl.isContextLost()); } catch (e) { return false; }
}

/** 显卡档案 —— 报错时**必须带上** ✗（不然只看得见"失败了"三个字，无从下手 ✓）
 *  优先用不打码的那个串（WEBGL_debug_renderer_info ✓ 各家都支持） */
function gpuProfile(gl) {
  try {
    let gpu = '';
    const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg && dbg.UNMASKED_RENDERER_WEBGL) {
      gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
    }
    const ver = String((gl.getParameter && gl.getParameter(gl.VERSION)) || '');
    return ver + (gpu ? ' · ' + gpu : '');
  } catch (e) { return '（显卡档案没问出来）'; }
}

/** 编译/链接失败：分两种，各带各的话 ✓（`code` 给 app 那边认"要不要等上下文回来" ✓）
 *  · `CTX_LOST` —— 上下文被收走了，**等它回来重来一次就行** ✓（app.js 的 buildRenderer ✓）
 *  · `COMPILE` / `LINK` —— 真·着色器问题，带上驱动给的日志 + 显卡档案 ✓
 *  ⚠ 消息里**不许写"着色器加载失败"**这种笼统话 ✗ 要让看的人一眼知道该往哪儿查 ✓ */
function shaderErr(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

function compile(gl, type, src) {
  const label = type === gl.VERTEX_SHADER ? '顶点着色器' : '片元着色器';
  /* 🔴 **先判上下文丢没丢** ✗✗（2026-10-17）
   *   上下文一丢，`createShader` / `compileShader` 全是静默 no-op ✓
   *   `getShaderParameter` 于是返回 false → 以前下一句就报"着色器编译失败" ✗
   *   可着色器源码一个字都没问题 ✓ —— 这条就是管理员说的那种误报 ✔ */
  if (gl.isContextLost && gl.isContextLost()) {
    _setupFail('context-lost', `${label}编译前 WebGL 上下文已经丢了`, gl,
      { stageAt: 'compile-before' });
  }
  const sh = gl.createShader(type);
  if (!sh) {
    _setupFail('shader-compile', `${label}对象创建失败（驱动 / 显存问题）`, gl,
      { stageAt: 'create-shader' });
  }
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = String(gl.getShaderInfoLog(sh) || '').trim();
    const lost = !!(gl.isContextLost && gl.isContextLost());
    const ge = (gl.getError && gl.getError()) || 0;
    try { gl.deleteShader(sh); } catch (e) { /* ✓ */ }
    // WebGL 的 CONTEXT_LOST_WEBGL = 0x9242、OUT_OF_MEMORY = 0x0505
    if (lost || ge === 0x9242) {
      _setupFail('context-lost', `${label}编译时 WebGL 上下文丢失`, gl,
        { stageAt: 'compile', log, glError: ge });
    }
    if (ge === 0x0505) {
      _setupFail('out-of-memory', `${label}编译失败：显存 / 内存不足`, gl,
        { stageAt: 'compile', log, glError: ge });
    }
    _setupFail('shader-compile',
      log ? `${label}编译失败：${log}` : `${label}编译失败（驱动没给日志）`, gl,
      { stageAt: 'compile', log, glError: ge, shader: label });
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

/**
 * 挑一个「最省显存」的块尺寸 ✓（2026-10-17 手机丢上下文之后加的）
 *
 *  为什么不能直接贴着上限开 ✗：
 *    · 贴 4096 → 9216 宽的图要 3×2 块，每块 4096² × 2 字节 = 33MB，合计 **192MB**；
 *    · 用 2048 → 5×3 = 15 块，合计 **120MB**（每块只有 8MB，但边角补零全浪费）；
 *    · 用 2304 → 4×2 = 8 块，合计 **85MB** —— 正好等于"整张图本身"的大小。
 *  所以这里把候选尺寸都算一遍总字节，挑**最小的那个**（并列取大块：层数少、上传次数少）。
 *
 *  ⚠ 总显存的下限就是 mapW × mapH × 2 ✓（块只能比它大、不可能更小）
 *  ⚠ 层数还得 ≤ 2048（MAX_ARRAY_TEXTURE_LAYERS 的常见下限）✓
 */
function pickTileLayout(mapW, mapH, maxTex) {
  const cap = Math.max(256, Math.min(maxTex || 4096, 4096));
  let best = null;
  for (let t = 256; t <= cap; t += 64) {
    const cols = Math.ceil(mapW / t), rows = Math.ceil(mapH / t);
    if (cols * rows > 2048) continue;
    const bytes = cols * rows * t * t * 2;
    if (!best || bytes < best.bytes || (bytes === best.bytes && t > best.tileW)) {
      best = { tileW: t, tileH: t, cols, rows, bytes };
    }
  }
  if (!best) {                       // 极端情况：退回最小的能装下的块
    const t = Math.max(1, Math.min(mapW, mapH, cap));
    best = { tileW: t, tileH: t, cols: Math.ceil(mapW / t), rows: Math.ceil(mapH / t), bytes: 0 };
  }
  best.synthetic = true;
  return best;
}

export class MapRenderer {
  constructor(canvas, meta) {
    this.canvas = canvas;
    this.meta = meta;
    this.mapW = meta.mapWidth;
    this.mapH = meta.mapHeight;
    this.noTitle = meta.noTitle ?? 65535;
    this.numProvinces = meta.numProvinces;

    const _glTry = _createGL(canvas);
    const gl = _glTry.gl;
    if (!gl) {
      const why = _glTry.creationError
        || (_glTry.thrown && _glTry.thrown.message)
        || '';
      _setupFail('no-webgl2',
        '这个浏览器没能创建 WebGL2 上下文' + (why ? '：' + why : ''),
        null, { creationError: why });
    }
    this.gl = gl;
    /* 🔴 **刚创建就可能已经是"丢的"** ✗✗（2026-10-17）
     *   低端机 / 驱动刚重置 / 浏览器 GPU 进程正忙时，getContext 会先给一个
     *   `isContextLost() === true` 的上下文 —— 之后所有 GL 调用静默 no-op ✓
     *   不在这儿拦住的话，下面 `_build()` 会一路失败，最后被报成
     *   "着色器编译失败" ✗（正是管理员查了半天的那个假线索 ✓） */
    if (gl.isContextLost && gl.isContextLost()) {
      _setupFail('context-lost', 'WebGL2 上下文创建后立刻丢失（显卡驱动 / 显存）', gl,
        { stageAt: 'after-create' });
    }

    /* 显卡驱动重置 / 显存吃紧 / **手机切到后台** 时，浏览器会把整个 WebGL 上下文收走：
     * 所有 GL 对象（着色器 / 缓冲 / 全部纹理）一起作废，之后每帧 GL 调用静默 no-op ✓
     * 不 preventDefault 的话浏览器**不会再给 restored 事件**（等于放弃这个上下文）✗
     * 所以接住它，并等 restored —— 那边把资源重建一遍（见下面的监听与 _build ✓）
     * ⚠ 上下文丢着的时候**别画** ✗：画了也不上屏，还会把 GL 错误搅浑 ✓ */
    this.ctxLost = false;
    this.onContextLost = null;
    this.onContextRestored = null;      // 上下文回来了（app 那边要把数据重新喂一遍 ✓）
    this.onContextRestoreFailed = null;

    this.tier = 3;
    this.editTier = 3;          // 默认跟 tier 一样（不换粒度时两者恒等）
    this.fineTier = 0;          // 最细层（荒地逐块节点住这一层；载图时由 app 设）
    this.showTitles = true;
    this.showPaint = true;
    this.mix = 1.0;
    this.borderTitle = true;    // 头衔区域描边（和 borderPaint 互斥，由 UI 保证）
    this.borderPaint = false;
    this.paintOnly = false;
    this.lowRes = false;         // resize() 里判定：这台机器我给降过分辨率（见它那段说明 ✓）
    this.unpainted = [150 / 255, 150 / 255, 150 / 255];   // 「未上色区域」的颜色（无归属地块用 ✓）
    this.paintWidth = 1.7;      // 填色那条边界：默认取链上最粗那条的粗细（app 每帧给）
    this.paintAlpha = 1.0;      // 且实心
    /* **水域边界**（2026-10-16 ✓ 用户定的：**自己一套**宽浓 ✓ 不沿用省份/地区那一档 ✓）
     *   ⚠ 它跟"填色那条"是两回事 ✗：填色线是链上最粗那一级 ✓ 这条只管水域之间的缝 ✓
     *   ⚠ `waterBorderOn` 由 app 每帧给（= 那个勾 **且** 这张图算得出水陆 ✓）
     *     默认 true —— app 还没跑第一帧时（自检 / 早期那几帧）行为跟老版一致 ✓ */
    this.waterBorderOn = true;
    this.waterBorderW = 1.0;
    this.waterBorderA = 1.0;
    /* 🔴 **荒地边界**（2026-10-17 ✓ 用户点名要的 ✓）
     *   ⚠ app 侧必须把"那个勾 **且** 这张图有身份标"AND 好再写进来 ✓
     *     （跟水域那条一个规矩 ✓ 不然老包上会画出一堆假缝 ✓）*/
    this.wasteBorderOn = false;
    this.wasteBorderW = 1.0;
    this.wasteBorderA = 1.0;
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
    /* 「同一片海 / 同一片荒地」的**编组号表**（每 pid 一个 Uint16 ✓ 见 rebuildHoverGroups ✓）
     *   0 = 不属于任何一片 → 退回 hoverPid 那条"只亮一格" ✓（老包 / CK3 没有水名表 ✓）*/
    this.hoverGroupData = null;            // Uint16Array(numProvinces)（懒建：第一次悬停才算 ✓）
    this.hoverGroupTier = null;            // 这份表是**哪一层**编的（换层要重建 ✓）
    this.hoverGroupId = 0;                 // 这一帧要高亮的那一组（0 = 不按编组亮 ✓）
    this.hoverGroupDirty = false;
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
    this.wasteGrey = [94 / 255, 94 / 255, 94 / 255];
    /*: 哪些分块真的传进显存了（JS 缓存里有 ≠ 显存里有）✓ */
    this.uploadedTiles = new Set();
    this._ready = false;

    /* **监听器要在 `_build()` 之前挂** ✗✗（2026-10-17）
     *   显卡上下文有可能**在建渲染器的过程中**就丢 ✓
     *   以前监听器挂在 `_build()` 后面 → 那一次丢失没人接住（也就没 preventDefault）
     *   → 浏览器不再发 restored → 只能刷新 ✓（这正是"打开就莫名其妙失败"的一条真因） */
    this._onCtxLost = (e) => {
      /* preventDefault = "我们知道出事了，**请把它还回来**" ✓
       * 不写这一句，浏览器认为没人管 → 永远不发 restored ✓ */
      if (e && e.preventDefault) e.preventDefault();
      this.ctxLost = true;
      this.dirty = false;          // 丢着的时候别画：画什么都不会上屏 ✓
      if (this.onContextLost) this.onContextLost();
    };
    /* 上下文回来了 —— **每一样 GL 资源都要重建**（WebGL 的规矩：对象全作废 ✓）
     *   这里只管"跟上下文绑在一起"的那几样 ✓
     *   纹理交给 app 重新喂（它手上才有省份 id / 归属表 / 笔迹 ✓ 见 onContextRestored ✓）*/
    this._onCtxRestored = () => {
      if (!this._ready) return;   // 建到一半就抛出去的那个半成品不接 restored ✓
      try {
        this._build();
        // 旧纹理的句柄全部作废：清成 null，render() 会一直等到数据重新喂完才画 ✓
        this.provTex = null;
        this.titleTex = null;
        this.colorTex = null;
        this.paintTex = null;
        this.paintLabelTex = null;
        this.provArrTex = null;
        this.borderDepthTex = null;
        this.borderDepthOn = false;
        this.useTiles = 0;
        this.tileInfo = null;
        this.ctxLost = false;
        this.paintDirty = true;
        this.lutDirty = true;
        this.dirty = true;
        this.uploadedTiles.clear();    // 显存里的块全没了 → 记录也清（重新喂时逐块重记 ✓）
        if (this.onContextRestored) this.onContextRestored();
      } catch (err) {
        this.ctxLost = true;
        if (this.onContextRestoreFailed) this.onContextRestoreFailed(err);
        else if (this.onContextLost) this.onContextLost();
      }
    };
    if (this.canvas.addEventListener) {
      this.canvas.addEventListener('webglcontextlost', this._onCtxLost);
      this.canvas.addEventListener('webglcontextrestored', this._onCtxRestored);
    }

    try {
      this._build();
      this._ready = true;
    } catch (err) {
      this._detachContextListeners();
      /* 已经是分类好的错就原样往上抛 ✓；普通异常包成 `renderer` 类（别丢掉现场） */
      if (err instanceof RendererSetupError) throw err;
      if (err && err.code) throw err;   // 老 shaderErr（CTX_LOST / COMPILE / LINK）原样给 app 认 ✓
      _setupFail('renderer', '建渲染器时出错：' + ((err && err.message) || err), gl,
        { stageAt: 'build', cause: String((err && err.stack) || err) });
    }
    /* ⚠ **建完再看一眼** ✗：有些驱动不抛错、只是把上下文悄悄收走 ✓ */
    if (this.ctxLost || (gl.isContextLost && gl.isContextLost())) {
      this._detachContextListeners();
      _setupFail('context-lost', '建渲染器时 WebGL 上下文丢失', gl,
        { stageAt: 'after-build' });
    }
  }

  /** 建失败了就把 canvas 上的两个监听摘掉 ✓（重试时不会再叠一份） */
  _detachContextListeners() {
    const c = this.canvas;
    if (!c || !c.removeEventListener) return;
    if (this._onCtxLost) c.removeEventListener('webglcontextlost', this._onCtxLost);
    if (this._onCtxRestored) c.removeEventListener('webglcontextrestored', this._onCtxRestored);
  }

  /**
   * 建"跟上下文绑在一起"的那几样：着色器 / uniform 位置 / VAO / 占位纹理 ✓
   *
   * **可以重复调用** ✗ —— 上下文丢了又回来的时候要整个重建一遍 ✓
   * （手机切后台再回来就是这么一条路：iOS / Android 都会把上下文收走 ✓）
   * ⚠ 所以这里**不许碰**任何"用户的东西"（笔迹 / 颜色 / 视角）✗ 那些都在别处存着 ✓
   */
  _build() {
    const gl = this.gl;

    /* 🔴 **每个 sampler 都必须指向一张"完整纹理"** ✗ —— WebGL 的硬规矩 ✓
     *   用户报：手机版黑屏、中心像素 [0,0,0]、**drawArrays 报 1282** ✓
     *   根因：着色器里声明了 sampler2D uBorderDepth ✓ 而**手机上不建那张粗筛位图** ✗
     *     → render 里走 else 分支，只把 uBorderDepthOn 设成 0 ✗
     *       **纹理单元 9 上什么都没绑** → 采样器指向空 → 1282 → 整帧丢弃 → 全黑 ✓✓
     *   规矩：**就算这一路根本不采样，也得绑一张完整纹理** ✗（1×1 就够 ✓）
     *   ⚠ 电脑上没事是因为那张图建得出来、绑上了 ✓ → "电脑行手机不行"就是这么来的 ✓
     *   ⚠ 这张占位纹理要**在 render 之前**就建好 ✗（这里最省事 ✓）*/
    this.dummyTex = makeTexture(gl, 1, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE,
      new Uint8Array([0]), gl.NEAREST);

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    /* ⚠ 上下文丢着的时候 **getParameter 给 null** ✓
     *   —— 不拦的话下面那句会报"贴图上限只有 nullpx"，把人往"设备太小"上带 ✗
     *   （真正的原因还是上下文没了 ✓ 先说清楚 ✓）*/
    if (ctxLost(gl)) {
      throw shaderErr('CTX_LOST', '建渲染器的时候显卡上下文已经被收走了（还没轮到编译着色器）');
    }
    // **地图比"单张贴图上限"大时不再拒绝** ✓ —— setData 里会把它就地切成一块块贴图 ✓
    // （手机 GPU 常见上限只有 4096 / 8192：CK3 9216×4608、EU5 8192×4096、
    //   米勒投影 11680×5760 都塞不进一张 ✗ 以前这里直接抛错 → 整张图加载不出来 ✗）
    // 只有小到连一块切片都放不下的设备才真的没救 ✓
    if (maxTex < 256) {
      _setupFail('texture-limit', `这个设备的贴图上限只有 ${maxTex}px，放不下任何地图切片。`,
        gl, { stageAt: 'limits', maxTex });
    }
    this.maxTex = maxTex;

    /* 🔴 **先认一下"是不是软件渲染"** ✗✗（2026-10-18 用户报：VIC3 图链接失败）
     *
     *  报告里 `渲染器 WebKit WebGL · GL WebGL 2.0 ()`、**没有 unmasked 显卡名** ✓
     *  而「上传到显卡 → 失败」花了 **92 秒** —— 这是 SwiftShader（软件光栅器）
     *  在拿 CPU 一点点啃这个巨大的片元着色器 ✓ 真显卡上几毫秒就完了 ✓
     *
     *  典型成因：浏览器关掉了「使用硬件加速」/ 远程桌面 / 虚拟机 / 驱动被禁用 ✓
     *  → 记下来，报错时**第一句就说这个** ✓ 不然用户照着"换浏览器"折腾半天也没用 ✓
     */
    this.softwareGL = detectSoftwareGL(gl);

    const prog = gl.createProgram();
    if (!prog) {
      if (ctxLost(gl)) throw shaderErr('CTX_LOST', '着色器程序没建出来：显卡上下文已经丢了');
      throw shaderErr('LINK', '着色器程序没建出来（createProgram 给了 null）｜ ' + gpuProfile(gl));
    }
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    /* ⏱ **量一下链接花了多久** ✗✗（2026-10-18 用户报告：这一段花了 92 秒）
     *  真显卡几毫秒，软件渲染一两分钟 —— 这个数本身就是"是不是用上显卡"的铁证 ✓
     *  记进 detail，报告和错误屏都能看到 ✓ */
    const _linkT0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    gl.linkProgram(prog);
    const linkMs = Math.round(((typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now()) - _linkT0);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      /* ⚠ **先问上下文再说着色器** ✗ —— 上下文被收走时 LINK_STATUS 也是 false ✓
       *   这种"失败"等上下文回来重来一次就好了，报成链接失败会把人带偏 ✓ */
      if (ctxLost(gl)) {
        throw shaderErr('CTX_LOST', '着色器还没链接完，显卡上下文就被收走了'
          + '（切后台 / 显存紧张 / 驱动重置都会这样）');
      }
      /* ⚠ 日志**可能是空的** ✗（驱动内部报错时只给个 LINK_STATUS = false ✓）
         那就把渲染器和版本一起带上 —— 否则报上来只有"链接失败"四个字，
         根因（指令数超限 / 寄存器不够 / ANGLE 翻译不过）一点都看不出来 ✓ */
      const info = String(gl.getProgramInfoLog(prog) || '').trim();
      const lost = !!(gl.isContextLost && gl.isContextLost());
      const ge = (gl.getError && gl.getError()) || 0;
      try { gl.deleteProgram(prog); } catch (e) { /* ✓ */ }
      if (lost || ge === 0x9242) {
        _setupFail('context-lost', '着色器链接时 WebGL 上下文丢失', gl,
          { stageAt: 'link', log: info, glError: ge });
      }
      if (ge === 0x0505) {
        _setupFail('out-of-memory', '着色器链接失败：显存 / 内存不足', gl,
          { stageAt: 'link', log: info, glError: ge, linkMs });
      }
      _setupFail('shader-link',
        info ? '着色器链接失败：' + info : '着色器链接失败（驱动没给日志）', gl,
        { stageAt: 'link', log: info, glError: ge, linkMs });    }
    this.prog = prog;

    this.uni = {};
    for (const n of ['uView', 'uProv', 'uProvArr', 'uProvTiles', 'uProvCols', 'uUseTiles', 'uNoAA', 'uTitleMap', 'uColorLut', 'uPaint', 'uPaintLabel', 'uBorderDepth', 'uBorderDepthOn',
                     'uMapSize', 'uTitleMapW', 'uNumProvinces', 'uPaintW', 'uTier', 'uEditTier', 'uFineTier',
                     'uShowTitles', 'uShowPaint', 'uMix',
                     'uBorderTitle', 'uBorderPaint', 'uPaintOnly', 'uBorderW', 'uBorderA', 'uPaintBorderW', 'uPaintBorderA', 'uMapPerPx',
                     'uUnpainted',
                     'uExtraCount', 'uExtraTier', 'uExtraW', 'uExtraShow', 'uExtraA',
                     'uLutW', 'uRealTitles', 'uHoverTid', 'uHoverPaintOn', 'uHoverPaint', 'uHoverPid', 'uHoverLabel',
                     'uHoverGroup', 'uHoverGroupW', 'uHoverGroupId',
                     'uKindTex', 'uKindOn', 'uKindW', 'uNature',
                     'uWaterBorderOn', 'uWaterBorderW', 'uWaterBorderA',
                     'uWaterKind', 'uWaterKindW',
                     /* 🔴 **荒地边界那三根**（2026-10-17 ✓）——
                      *   ⚠ 它**没有自己的纹理 uniform** ✗（读的是 uKindTex ✓ 见着色器那段 ✓）*/
                     'uWasteBorderOn', 'uWasteBorderW', 'uWasteBorderA',
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

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    // 用**现在**的背景色，不是出厂色 —— 重建时别把用户改过的背景抹回默认 ✓
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

  /**
   * 从整张 id 数组里切一块、传给数组纹理的第 (r, c) 块 ✓（合成切块专用）
   *
   *  ⚠ 传过的直接返回 false（`uploadedTiles` 去重 ✓）—— 帧循环每帧都会问一遍，
   *    不去重的话每帧白切 10MB 内存 + 白传一次 ✓
   *  ⚠ 右/下边缘不足一块的地方补 0（= 无省份 ✓）
   *
   *  @returns {boolean} 真传上去了
   */
  uploadSyntheticTile(r, c) {
    const layout = this.tileInfo;
    const ids = this.synthIds;
    if (!layout || !layout.synthetic || !ids) return false;
    if (r < 0 || c < 0 || r >= layout.rows || c >= layout.cols) return false;
    const layer = r * layout.cols + c;
    if (this.uploadedTiles.has(layer)) return false;
    if (this.ctxLost) return false;

    const m = this.meta;
    const x0 = c * layout.tileW, y0 = r * layout.tileH;
    const n = Math.min(layout.tileW, m.mapWidth - x0);
    if (n <= 0) return false;

    const buf = new Uint16Array(layout.tileW * layout.tileH);
    const at = ids.subarray ? ids.subarray.bind(ids) : ids.slice.bind(ids);
    for (let y = 0; y < layout.tileH; y++) {
      const sy = y0 + y;
      if (sy >= m.mapHeight) break;
      const src = sy * m.mapWidth + x0;
      buf.set(at(src, src + n), y * layout.tileW);
    }
    return this.uploadTile(layer, buf);
  }

  /** 把某一块上传到数组纹理的第 layer 层 */
  uploadTile(layer, data) {
    const gl = this.gl;
    if (!this.provArrTex || !this.tileInfo) return false;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.provArrTex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer,
      this.tileInfo.tileW, this.tileInfo.tileH, 1,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
    this.uploadedTiles.add(layer);      // 传成功了才记 ✓（早退 false 的那条路不算 ✓）
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
        /* 🔴 **块尺寸按"最省显存"挑** ✗✗（2026-10-17 手机丢上下文之后改的）
         *   原来是贴着上限开（每块 2048）→ CK3 那张 9216×4608 要 15 块 =
         *   **120MB** 显存，手机一次全传直接把 GPU 上下文顶丢了（用户白屏 ✓）。
         *   现在挑总字节最小的那组：同一张图只要 8 块 = 85MB（= 整图大小）；
         *   而且**不再一次全传**，交给帧循环按视野补（见 app.js 的懒上传 ✓）。
         *   ⚠ 电脑上限 16384 > 图宽 → 根本不走这条路，一行都不变 ✓ */
        layout = pickTileLayout(m.mapWidth, m.mapHeight, lim);
        const _mb = (layout.cols * layout.rows * layout.tileW * layout.tileH * 2 / 1048576).toFixed(0);
        console.log(`贴图上限 ${lim}px 装不下 ${m.mapWidth}×${m.mapHeight}`
          + ` → 就地切成 ${layout.cols}×${layout.rows} 块（每块 ${layout.tileW}×${layout.tileH}，约 ${_mb}MB）`);
        /* ⚠ 顺手写进"启动里程表" ✗ —— 用户手机上能直接看到走没走这条路 ✓ */
        try {
          if (typeof bootMark === 'function') {
            bootMark('切块' + layout.cols + '×' + layout.rows + ' 每块' + layout.tileW + '×' + layout.tileH + ' 约' + _mb + 'MB');
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
    /* 🔴 **就地切的那条要留着整张 id 数组** ✗✗（2026-10-17）
     *   以前这里一次 `uploadAllTiles` 全传（CK3 那张 = 120MB → 手机上下文丢了 ✓）
     *   现在只留个**引用**（不复制，零额外内存 ✓），帧循环按视野逐块切、逐块传 ✓ */
    this.synthIds = (layout && layout.synthetic) ? provinceIds : null;
    // 数组纹理刚重建（每层都是全新的占位 0）→ 上传记录清空 ✓
    // （synthetic 那条就地切的不受影响：紧接着 uploadAllTiles 会逐块传、逐块记 ✓）
    this.uploadedTiles.clear();
    if (layout) {
      const first = new Uint16Array(layout.tileW * layout.tileH);
      this.provArrTex = this.makeTileArray(layout.tileW, layout.tileH,
        layout.cols * layout.rows, first);
      // 就地切的那条：**不再一次全传** ✗✗（2026-10-17 —— 全传 = 120MB，手机当场丢上下文 ✓）
      // 只先传「视野中央」那一块，保证第一帧不是空白；其余由帧循环按视野补 ✓
      // （带 tiles.json 的那条也一样 —— app 会按视野逐块喂给 uploadTile ✓）
      if (layout.synthetic) {
        this.uploadSyntheticTile(Math.floor(layout.rows / 2), Math.floor(layout.cols / 2));
      }
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

    /* ⚠ **上下文恢复时会再调一次本函数** ✗（见 onContextRestored ✓）
     *   —— 那时候 lutData / paintData 里装的是**用户已经涂好、调好的东西** ✓
     *   无脑重建 = 把他的笔迹和荒地色全抹掉 ✓（正是"切个后台回来，涂的全没了" ✓）
     *   所以：**尺寸对得上就留着**，只标个"要重传" ✓
     *   （纹理本身照样重建 —— 旧的随上下文一起作废了 ✗）*/
    this.lutH = Math.max(1, Math.ceil(m.numTitles / this.lutW));
    const _lutLen = this.lutW * this.lutH * 4;
    if (this.lutData && this.lutData.length === _lutLen) {
      this.lutDirty = true;                 // 内容还在，重传一遍就行 ✓
    } else {
      this.lutData = new Uint8Array(_lutLen);
      for (let i = 0; i < m.numTitles; i++) {
        const c = colors[i] || [0, 0, 0];
        this.lutData[i * 4] = c[0];
        this.lutData[i * 4 + 1] = c[1];
        this.lutData[i * 4 + 2] = c[2];
        // alpha 现在当**荒地标记**用（setWasteland 会按 meta.wasteland 打 255），
      // 默认 0 = 不是荒地。别处没人读这个通道 ✓
      this.lutData[i * 4 + 3] = 0;
      }
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
    // 笔迹同理：**留着**（重建就等于把用户涂的东西全擦了 ✗）
    if (this.paintData && this.paintData.length === this.numProvinces * 4) {
      this.paintDirty = true;               // 重传在 flushPaint() 里 ✓
    } else {
      this.paintData = new Uint8Array(this.numProvinces * 4);
    }
    this.paintFlat = new Uint8Array(this.paintW * this.paintRows * 4);
    this.paintTex = makeTexture(gl, this.paintW, this.paintRows, gl.RGBA8,
      gl.RGBA, gl.UNSIGNED_BYTE, this.paintFlat, gl.NEAREST);

    // 手绘层对应的"标记编号"。描边要区分同色不同标记，颜色那张表塞不下了
    // （RGB 是颜色、alpha 是"涂没涂"），所以单开一张 R16UI，一个省一格。
    if (this.paintLabelData && this.paintLabelData.length === this.numProvinces) {
      this.paintDirty = true;
    } else {
      this.paintLabelData = new Uint16Array(this.numProvinces);
    }
    this.paintLabelFlat = new Uint16Array(this.paintW * this.paintRows);
    this.paintLabelTex = makeTexture(gl, this.paintW, this.paintRows, gl.R16UI,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.paintLabelFlat, gl.NEAREST);

    /* **悬停编组表**（"同一片海"那种 ✓）—— 跟 paintLabel 同一套拍平写法 ✓
     *   ⚠ 一定要建、一定要绑 ✗ —— 采样器指向一张**不完整**的纹理，整个 program
     *     会被 WebGL 判成非法（手机黑屏那条根因就是它 ✓ 见 uBorderDepth 那段 ✓）
     *   内容**留着**（上下文丢失时重建：表不用重算，重传一遍就行 ✓ 跟笔迹一个待遇 ✓）*/
    if (this.hoverGroupData && this.hoverGroupData.length === this.numProvinces) {
      this.hoverGroupDirty = true;         // 内容还在，重传在 flushPaint() 里 ✓
    } else {
      this.hoverGroupData = new Uint16Array(this.numProvinces);
      this.hoverGroupTier = null;          // 表没了 → 下次悬停按当前层重建 ✓
    }
    this.hoverGroupFlat = new Uint16Array(this.paintW * this.paintRows);
    this.hoverGroupTex = makeTexture(gl, this.paintW, this.paintRows, gl.R16UI,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.hoverGroupFlat, gl.NEAREST);

    /* 🔴 **身份标纹理**（每 pid 一格：1 陆地 / 2 海 / 3 湖 / 4 河 / 5 不可通行海域 /
     *   6 不可通行 ✓ 2026-10-15 ✓）—— 跟 hoverGroup 同一套拍平写法 ✓
     *   ⚠ **一定要建、一定要绑** ✗ —— 采样器指向一张不完整纹理，整个 program 会被
     *     WebGL 判成非法（手机黑屏那条根因就是它 ✓ 上面 hoverGroup 那段记着 ✓）
     *   ⚠ 内容全 0（老包 / 还没灌）时 `uKindOn = 0` → 着色器整条让开 ✓
     *   ⚠ 上下文丢失重建时**内容留着**（重传就行 ✓ 跟笔迹一个待遇 ✓）*/
    if (!(this.kindData && this.kindData.length === this.numProvinces)) this.kindData = null;
    this.kindFlat = new Uint8Array(this.paintW * this.paintRows);
    this.kindTex = makeTexture(gl, this.paintW, this.paintRows, gl.R8UI,
      gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.kindFlat, gl.NEAREST);
    this.kindDirty = true;
    /* **「水域 · 边界」那张表**（每 pid 一格：0 = 不是水 / 2..5 = 那四类 ✓ 2026-10-16 ✓）
     *   ⚠ 一定要建、一定要绑 ✗ —— 采样器指向一张不完整纹理，整个 program 会被
     *     WebGL 判成非法（手机黑屏那条根因就是它 ✓ 见上面 kindTex / uBorderDepth 那两段 ✓）
     *   ⚠ 内容全 0（老包 / 还没灌 ✓）→ 着色器的 waterIs 恒 false
     *     → 水域那条通道 + 两条让位**一起退化成现状** ✓ 行为一丝不变 ✓
     *   跟 kindTex **长得一样、判据也同源** ✓ 但**不是同一张** ✗：
     *     kindMask 说的是"这一格最底层是什么"（含陆地 1 / 荒地 6 ✓）
     *     这张说的是"**认不认得出它是水**"（认水走 waterKindByPid ✓
     *       老包没 kindMask 时退回 `#` 开头的键前缀 ✓ 正是老包那条退路 ✓）*/
    if (!(this.waterKindData && this.waterKindData.length === this.numProvinces)) {
      this.waterKindData = null;
    }
    this.waterKindFlat = new Uint8Array(this.paintW * this.paintRows);
    this.waterKindTex = makeTexture(gl, this.paintW, this.paintRows, gl.R8UI,
      gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.waterKindFlat, gl.NEAREST);
    this.waterKindDirty = true;
    /* **七行里的五行类色**（2..6 → 海 / 湖 / 河 / 不可通行海域 / 不可通行 ✓）
     *   出厂值就是 `build_data.py` 那份类色 ✓ 开图后由 app.js 按设置覆盖 ✓ */
    this.natureFlat = this.natureFlat || new Float32Array([
      32 / 255, 57 / 255, 92 / 255,        // 2 海洋 ✓
      47 / 255, 110 / 255, 150 / 255,      // 3 湖泊 ✓
      62 / 255, 136 / 255, 181 / 255,      // 4 河流 ✓
      26 / 255, 46 / 255, 71 / 255,        // 5 不可通行海域 ✓
      94 / 255, 94 / 255, 94 / 255,        // 6 不可通行区域 ✓
    ]);

    /* 🔴 **上传完再看一眼上下文** ✗（2026-10-17）
     *   低端机 / 手机在 `texImage2D` 那一批调用里把显存吃爆时，上下文会**悄悄丢**：
     *   所有调用静默成功返回，可显存里什么都没有 → 开图后一片空白 ✓
     *   不在这里拦住，玩家看到的就是"打开是白的、日志却没有错" ✗ */
    if (this.ctxLost || (gl.isContextLost && gl.isContextLost())) {
      _setupFail('context-lost', '上传地图数据时 WebGL 上下文丢失', gl,
        { stageAt: 'setData' });
    }
    this.dirty = true;
  }

  /** 灌入**底层身份标**（meta.kindMask 解出来的 Uint8Array ✓ 每 pid 一字节 ✓）
   *
   *  ⚠ 长度对不上 / 传 null → 当"没有这枚标"（`uKindOn = 0`）✓ 老包行为一丝不变 ✓
   *  ⚠ 只标脏 ✗ —— 真正上传在 `flushPaint()` 里一趟做完（`draw()` 每帧都调它 ✓）*/
  setKindMask(bytes) {
    this.kindData = (bytes && this.numProvinces && bytes.length >= this.numProvinces)
      ? bytes : null;
    this.kindDirty = true;
    this.dirty = true;
  }

  /** 灌入**「认得出是水吗」那张表**（每 pid 一字节 ✓ 0 = 不是水 / 2..5 = 那四类 ✓）
   *
   *  ⚠ 长度对不上 / 传 null → 当"这张图算不出水陆"（`waterIs` 恒 false ✓）
   *    → 水域那条通道跟两条让位**一起让开** ✓ 老包 / 认不出水的图观感一丝不变 ✓
   *  ⚠ 只标脏 ✗ —— 真正上传在 `flushPaint()` 里一趟做完（`draw()` 每帧都调它 ✓）*/
  setWaterKindMask(bytes) {
    this.waterKindData = (bytes && this.numProvinces && bytes.length >= this.numProvinces)
      ? bytes : null;
    this.waterKindDirty = true;
    this.dirty = true;
  }

  /** **七行里的五行类色**（[海, 湖, 河, 不可通行海域, 不可通行] ✓ 各 [r,g,b] 0~255 ✓）
   *
   *  着色器按**底层身份**直接给这几类上色（见 kindOf / natureColor ✓）——
   *  所以改设置 = 改这几个 uniform → 下一帧就变 ✓ **不用重烤包** ✓✓
   *  ⚠ 陆地不在里面 ✗（它照旧走 LUT 头衔色 / 无主兜底 ✓）*/
  setNatureColors(list) {
    if (!list || list.length < 5 || !this.natureFlat) return;
    for (let i = 0; i < 5; i++) {
      const c = list[i] || [0, 0, 0];
      this.natureFlat[i * 3] = (c[0] || 0) / 255;
      this.natureFlat[i * 3 + 1] = (c[1] || 0) / 255;
      this.natureFlat[i * 3 + 2] = (c[2] || 0) / 255;
    }
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
    const gl = this.gl;
    if (this.paintDirty) {
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
    /* **身份标**（换图才动一次 ✓ 每 pid 一字节 ≈ 29 KB ✓）——
     *   老包（没这枚标）→ 传全 0 → 着色器 `uKindOn = 0` 让开 ✓ */
    if (this.kindDirty) {
      if (this.kindData) this.kindFlat.set(this.kindData);
      else this.kindFlat.fill(0);
      gl.bindTexture(gl.TEXTURE_2D, this.kindTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
        gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.kindFlat);
      this.kindDirty = false;
    }
    /* **水域表**（换图才动一次 ✓ 跟身份标同一套 ✓）——
     *   老包 / 认不出水 → 传全 0 → 着色器 `waterIs` 恒 false → 整条让开 ✓ */
    if (this.waterKindDirty) {
      if (this.waterKindData) this.waterKindFlat.set(this.waterKindData);
      else this.waterKindFlat.fill(0);
      gl.bindTexture(gl.TEXTURE_2D, this.waterKindTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
        gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.waterKindFlat);
      this.waterKindDirty = false;
    }
    /* 悬停编组表**换层才动一次** ✓（EU5 40 KB 一趟 ✗ 每帧传是白烧 ✓）*/
    if (this.hoverGroupDirty && this.hoverGroupData) {
      this.hoverGroupFlat.set(this.hoverGroupData);
      gl.bindTexture(gl.TEXTURE_2D, this.hoverGroupTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
        gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.hoverGroupFlat);
      this.hoverGroupDirty = false;
    }
  }

  /**
   * **老包的"同一片海"编组** —— 2026-10-13 每层一片之后，这条只剩**兜底**用途 ✓
   *
   *  每层一片的包里，**同一片 = 当前层那个 tid** ✓（`#sea_pr_57` 那种）
   *  → 悬停那一段直接把 tid 交给着色器（uHoverTid ✓ 见 app.js 的 applyHoverHighlight ✓）
   *    这一整套编组表就**用不上了** ✓
   *
   *  ⚠ 但**每层一片之前打的包**（packs 里还在发的那几张）里全世界的海
   *    共用一个 `#sea`（tid 相同 ✗）—— 那批包按 tid 亮 = 全世界的海一起亮 ✗
   *    所以留着它：非"每层一片"的键才走这一条 ✓（app.js 靠 isTierPieceKey 分流 ✓）
   *
   *  （下面这段是它当年的来历，仍然准确 ✓）
   * **"同一片海"在渲染里本来没有 id** ✗ —— 全世界的海共用一个 `#sea` 伪头衔
   * （tid 相同 ✓）→ 按 tid 亮 = 全世界的海一起亮 ✗；按 pid 又只能亮一格 ✗
   *
   * 所以在这儿按**当前视图层那张水域名表**给每一片海编个号：**同名 = 同一组** ✓
   *   · 表来源跟海名标签**完全一套**（app.js 的 buildSeaLabelPoints ✓）：
   *     `seaNamesByTier[this.tier]`，那一层没有就退回 `meta.seaNames`（合并口径 ✓）
   *     → 地图上标着"波罗的海"的那一整片，悬停时也正好整片一起亮 ✓（对得上 ✓）
   *   · **荒地顺手一起做** ✓（用户只说了海 ✗ 但荒地也是"共享伪节点"那一类 ✓
   *     `meta.wastelandNames` 不分层 ✓ 所以荒地不跟着换层变 ✓）
   *   · 组号：**1..N = 海 · N+1.. = 荒地 · 0 = 不属于任何一片** ✓
   *     0 那批照旧走"只亮光标底下这一块"（老包 / CK3 没有水名表 ✓ 一点没变 ✓）
   *   ⚠ Uint16 ✗ 不是 Uint8 —— EU5 最细层有 3635 片海，8 位装不下 ✓
   *   ⚠ 只在**换层**时重建（毫秒级 ✓）—— 鼠标每划过一格都重建就是每帧几十 KB ✗
   */
  rebuildHoverGroups() {
    /* 🔴 **编组跟"编辑层"走，不是"视图层"** ✗✗
     *   （2026-10-13 用户报："剧本模式悬停海域仍然为最高层"✓ 根因就在这一行）
     *
     *   原来取的是 `this.tier`（**视图层** ✗）——
     *   而剧本模式里 `tier` 停在剧本层（0~2 ✓）→ `seaNamesByTier[剧本层]` 是 **null** ✗
     *   → 退回 `meta.seaNames`（**合并口径 = 最粗那层** ✓）→ 整片海一起亮 ✓
     *
     *   用户要的（原话）：「**和无主地一样**，不开粒度就是最低层，开粒度就跟随粒度」✓
     *   而"粒度"这件事项目里早就有现成的答案：**`editTier()`** ✓
     *     · 没换粒度 → `editTier()` == 最细那层 → 海域组 = 最细层的一片（基本就是一块 ✓）
     *     · 换了粒度 → `editTier()` 就是用户选的那层 → 跟着它 ✓
     *   —— 跟普通地块 / 无主地的高亮完全是同一套口径 ✓（它们都在 `applyHoverHighlight` 里
     *      用 `editTier()` 取 tid ✓ 见那边 ✓）
     *   ⚠ `setEditTier()` 那边**不用**手动失效 ✗ —— 下面 `hoverGroupIdOf` 每次都比层号 ✓ */
    const tier = this.editTier | 0;
    this.hoverGroupTier = tier;
    const n = this.numProvinces | 0;
    const meta = this.meta || {};
    const bt = meta.seaNamesByTier;
    /* ⚠ **那一层是 null = 这一层没名字** ✗（2026-10-14 用户点破的口径：
     *   "每个水域不同的层级按游戏内容给名字……Hoi4 的省份级水域和地区级是
     *    同一个东西，而且**没有名字**而已"✓）
     *   → 别退回 `meta.seaNames`（那是**最粗那层**的口径 ✓ 拿它填细层
     *     = 拿别层的名字充数 ✗ 编组也会跟着编错 ✗）
     *   ⚠ 判据跟 app.js 的 `waterNameTable` **同一套** ✗（两处都改 ✓
     *     gl.js 是独立模块、拿不到那个函数 ✓ 只好照抄这三行 ✓ 改一处记得改两处 ✓）
     *   只有**压根没有这张分层表**（或者它比层数还短 = 老包 ✓）才退回 `meta.seaNames` ✓ */
    const _nT = (meta.tiers && meta.tiers.length) || 0;
    const _hasBt = Array.isArray(bt) && _nT > 0 && bt.length >= _nT;
    const tbl = _hasBt ? (bt[tier] || null) : meta.seaNames;
    const wl = meta.wastelandNames;
    const ids = new Uint16Array(n);
    if (tbl || wl) {
      let next = 1;
      /* ⚠ 海先编、荒地后编 ✗ 而且**已经归过一片的地块不再改**（`ids[pid]` 非 0 就跳过 ✓）
       *   两张表理论上不会重叠（水 / 荒地是两类地 ✗）—— 真重叠了以海为准 ✓ */
      const put = (map) => {
        if (!map) return;
        const byName = new Map();
        for (const k in map) {
          const pid = Number(k);
          if (!pid || pid >= n) continue;
          const nm = map[k];
          if (!nm) continue;
          if (ids[pid]) continue;
          let g = byName.get(nm);
          if (g === undefined) { g = next++; byName.set(nm, g); }
          ids[pid] = g;
        }
      };
      put(tbl);
      put(wl);
    }
    this.hoverGroupData = ids;
    this.hoverGroupDirty = true;
    this.dirty = true;
  }

  /**
   * 这个地块属于哪一片海 / 荒地（0 = 不属于任何一片 ✓）—— 悬停那段（app.js）每换一格问一次 ✓
   * ⚠ 换层之后**懒重建** ✗（第一次悬停那一下算 ✓ 不占切层的帧 ✓）
   * ⚠ **新包（每层一片）压根不会问到这儿** ✗ —— 那边同一个 tid 就是同一片 ✓
   *   只有老包、以及最细层逐块的荒地（`wl_<地块号>`）才走这条 ✓
   */
  hoverGroupIdOf(pid) {
    if (!pid || pid >= this.numProvinces) return 0;
    // ⚠ 比的是**编辑层** ✗（跟 rebuildHoverGroups 里取的那个必须一致 ✓ 见那边的注释 ✓）
    if (this.hoverGroupTier !== (this.editTier | 0) || !this.hoverGroupData) this.rebuildHoverGroups();
    return this.hoverGroupData[pid] || 0;
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
  setFineTier(t) { this.fineTier = t; this.dirty = true; }
  setShowTitles(v) { this.showTitles = !!v; this.dirty = true; }
  setShowPaint(v) { this.showPaint = !!v; this.dirty = true; }

  /**
   * 标出哪些头衔是"荒地（不可通行）" —— 借用 LUT 的 **alpha** 通道：
   * 荒地 = 255，其余 = 0。这个通道别处没人用（输出 alpha 是着色器里另算的），
   * 拿来当"这是荒地"的标记，着色器一次取样就能判，不用多传一张纹理。
   */
  /** **荒地固定显示"它自己那份 LUT 色"** ✓（2026-10-17 ✓ 用户定的 ✓）
   *
   *  原话："**荒地不管什么视图都是荒地颜色**，就这样"✓
   *
   *  ⚠ 做法 ✗：把标记打在 **LUT 的 alpha 通道**上 ✓
   *    着色器在 `tid == NONE` 那道早退**之前**先查它 ✓
   *    （剧本层荒地永远没归属 → 不查就被 `uUnpainted`(150) 盖掉 ✗）
   *  ⚠ **不再是"自动上色"那套** ✗ —— 那一套 2026-10-17 整个撤了 ✓
   *    现在这份色就是 `applyNatureColors()` 按设置里「不可通行区域」那一行刷的 ✓
   *  ⚠ 跟 `setWasteland` 那套没关系 ✗ —— 那个 2026-10-14 就退役了、没人调 ✓
   *    所以 LUT 的 alpha 通道本来空着没人用 ✓ 拿它当这枚标记正好 ✓
   *
   *  @param {Iterable<number>} tids 要固定显示自己那份色的头衔（= 所有荒地节点 ✓）
   */
  setWasteFixed(tids) {
    const set = new Set(tids || []);
    const n = Math.floor(this.lutData.length / 4);
    for (let t = 0; t < n; t++) {
      this.lutData[t * 4 + 3] = set.has(t) ? 255 : 0;
    }
    this.wasteFixedCount = set.size;
    this.lutDirty = true;
    this.dirty = true;
  }

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

  /**
   * **导出前把悬停高亮临时哑掉** ✓（2026-10-17 用户报的：导出的图里莫名亮一块）
   *
   *  高亮是**画在着色器里的**（mix 到白 0.30）✗ 不是叠一层半透明框 ✓
   *  → 导出时只要鼠标正停着，那一块就被"提亮"进 PNG 了 ✓ 图上永远带一块亮的 ✗
   *  这里把几个悬停量整体清零，返回一个**恢复函数**；调用方导出完必须调它 ✓
   *
   *  ⚠ 只动"高亮"这一路 ✗ —— 悬停卡片、取色那些走 state ✓ 不受影响 ✓
   */
  muteHoverForExport() {
    const save = {
      tid: this.hoverTid,
      pid: this.hoverPid,
      group: this.hoverGroupId,
      on: this.hoverPaintOn,
      paint: this.hoverPaint ? this.hoverPaint.slice() : null,
      label: this.hoverLabel,
    };
    this.hoverTid = this.noTitle;      // NONE → 着色器那几路全不命中 ✓
    this.hoverPid = 0;
    this.hoverGroupId = 0;
    this.hoverPaintOn = false;
    this.hoverLabel = 0;
    this.dirty = true;
    return () => {
      this.hoverTid = save.tid;
      this.hoverPid = save.pid;
      this.hoverGroupId = save.group;
      this.hoverPaintOn = save.on;
      if (save.paint) this.hoverPaint = save.paint;
      this.hoverLabel = save.label;
      this.dirty = true;
    };
  }

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
   *
   * ⚠ 第 6 个参数是**「同一片海」那组号**（0 = 没编组 → 照旧只亮一格 ✓）——
   *   老的 5 参调用照样能用（缺省就是 0 ✓ 行为一点没变 ✓）
   */
  setHoverState(hoverPid, paintOn, paint, label, tid, hoverGroup) {
    const t = (tid == null) ? this.noTitle : tid;
    const p = paintOn ? 1 : 0;
    const c = paint || this.hoverPaint;
    const lb = label || 0;
    const hp = this.hoverPid || 0;
    const hg = hoverGroup || 0;
    const same = hp === (hoverPid || 0)
      && (this.hoverGroupId || 0) === hg
      && this.hoverPaintOn === p
      && this.hoverTid === t
      && (this.hoverLabel || 0) === lb
      && this.hoverPaint[0] === c[0] && this.hoverPaint[1] === c[1] && this.hoverPaint[2] === c[2];
    if (same) return;
    this.hoverPid = hoverPid || 0;
    this.hoverGroupId = hg;
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
    /* 🔴 **排障探针：显式开关** ✓（地址后面加 `#diag` 再打开，见 app.js 的 bootMark ✓）
     *   ⚠ 默认**关着** ✗ —— 下面那段 while 会把真实的 GL 错误**吃掉** ✓
     *   以前写的是「innerWidth ≤ 900 就开」✗：手机上没有控制台，恰恰最需要真实错误码，
     *   却偏偏在那儿被吞掉 ✓ 现在谁要排障谁自己打开 ✓ */
    const _diag = (typeof window !== 'undefined') && !!window.__PDX_DIAG;
    if (_diag) {
      try {
        const g0 = this.gl;
        while (g0.getError() !== g0.NO_ERROR) { /* 清空历史错误 ✓ 最多几次 */ }
      } catch (e) { /* ✓ */ }
    }
    if (this.ctxLost) return false;      // 上下文被收走了：画也不上屏，等它回来（见 restored ✓）
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

    // **悬停编组表：单元 6** ✓（"同一片海"那条路要用 ✓ 任何一层都绑着 —— 那张表一直存在 ✓）
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.hoverGroupTex);
    gl.uniform1i(u.uHoverGroup, 6);
    gl.uniform1i(u.uHoverGroupW, this.paintW);

    /* **底层身份标：单元 7** ✓（"每格按底层身份上色"那条要用 ✓）
     *   ⚠ 老包 / 没灌过 → kindData 为空 → `uKindOn = 0`，着色器整条让开 ✓ */
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this.kindTex);
    gl.uniform1i(u.uKindTex, 7);
    gl.uniform1i(u.uKindOn, this.kindData ? 1 : 0);
    gl.uniform1i(u.uKindW, this.paintW);
    gl.uniform3fv(u.uNature, this.natureFlat);

    /* **「认得出是水吗」那张表：单元 8** ✓（「水域 · 边界」那条通道要用 ✓）
     *   ⚠ 它跟 kindTex 一样**一直绑着** ✓ —— 表本身一直存在（内容可以是全 0 ✓）
     *     `uWaterKindOn` 那个闸由 app 侧跟"这个勾"AND 好之后写进 waterBorderOn ✓
     *     （着色器里只留一个闸，省得两个地方各判一遍 ✗ 见 handover §3.4 第 2 步 ✓）*/
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, this.waterKindTex);
    gl.uniform1i(u.uWaterKind, 8);
    gl.uniform1i(u.uWaterKindW, this.paintW);

    // **深度图：单元 9** ✓（纹理单元编号保持不变 ✓）
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
    gl.uniform1i(u.uFineTier, this.fineTier);
    gl.uniform1i(u.uShowTitles, this.showTitles ? 1 : 0);
    gl.uniform1i(u.uShowPaint, this.showPaint ? 1 : 0);
    // 分块参数（没有分块数据时 useTiles=0 → 着色器走老路，跟以前等价 ✓）
    const _ti = this.tileInfo || { tileW: 1, tileH: 1, cols: 1 };
    gl.uniform2i(u.uProvTiles, _ti.tileW, _ti.tileH);
    gl.uniform1i(u.uProvCols, _ti.cols);
    gl.uniform1i(u.uUseTiles, this.useTiles || 0);
    gl.uniform1f(u.uMix, this.mix);
    gl.uniform1i(u.uBorderTitle, this.borderTitle ? 1 : 0);
    gl.uniform1i(u.uBorderPaint, this.borderPaint ? 1 : 0);
    gl.uniform1i(u.uPaintOnly, this.paintOnly ? 1 : 0);
    // 「未上色区域」的颜色：无归属地块在开着剧本时的显示色 ✓
    gl.uniform3f(u.uUnpainted, this.unpainted[0], this.unpainted[1], this.unpainted[2]);
    gl.uniform1f(u.uBorderW, this.borderWidth);
    gl.uniform1f(u.uPaintBorderW, this.paintWidth);
    gl.uniform1f(u.uPaintBorderA, this.paintAlpha);
    /* **水域边界**（2026-10-16 ✓）—— 自己一套宽浓 ✓ 独立于那三个开关 ✓
     *   ⚠ `waterBorderOn` 是布尔 → app 每帧给 ✓（它已经把"那个勾 + 算得出水陆"AND 好 ✓）*/
    gl.uniform1i(u.uWaterBorderOn, this.waterBorderOn ? 1 : 0);
    gl.uniform1f(u.uWaterBorderW, this.waterBorderW);
    gl.uniform1f(u.uWaterBorderA, this.waterBorderA);
    /* 🔴 **荒地边界那三根**（2026-10-17 ✓ 跟水域一模一样的三行 ✓）*/
    gl.uniform1i(u.uWasteBorderOn, this.wasteBorderOn ? 1 : 0);
    gl.uniform1f(u.uWasteBorderW, this.wasteBorderW);
    gl.uniform1f(u.uWasteBorderA, this.wasteBorderA);
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
    gl.uniform1ui(u.uHoverGroupId, this.hoverGroupId || 0);
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
    if (_diag && typeof bootMark === 'function') {
      try {
        const cv1 = gl.canvas;
        const vp1 = gl.getParameter(gl.VIEWPORT) || [0, 0, 0, 0];
        /* ⚠ 这里**不调 getError()** ✗ —— 它会把手头那个真实的 GL 错误取走，
         *   别处（工单里最值钱的那一行）就再也看不见它了 ✓
         *   ⚠ 曾经这段写的是 `vp[2]` / `err` —— 那两个变量随着逐帧探针停用一起没了 ✗
         *   → 每次跑到这儿都是一句 ReferenceError（被 try 吞掉，看不出任何东西 ✓）
         *   **别再把变量写成不存在的** ✗ */
        bootMark('帧:画布' + cv1.width + '×' + cv1.height
          + ' 视口' + vp1[2] + '×' + vp1[3]
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
