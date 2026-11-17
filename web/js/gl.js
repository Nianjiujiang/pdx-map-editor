// ==================== gl.js ====================
﻿/**
 * WebGL2 渲染器。
 *
 * 三层间接查表，全程在 GPU 上：
 *
 *   屏幕像素 → uProv（省份 id 纹理）→ uTitleMap[(省份, 层级)] → 头衔序号
 *            → uColorLut(头衔序号) → 实际颜色
 *
 * 改一个头衔的颜色只需往 LUT 写一个像素，不必改那张 9216×4608 的大纹理，
 * 所以涂色是即时的。
 *
 * 两个正交的显示开关：
 *   uShowTitles —— 画不画头衔色
 *   uShowPaint  —— 画不画手绘层
 *   头衔关、手绘开 = 只显示涂过的区域，其余领地留空。
 *
 * uColorLut 存的是当前该显示的头衔色，不是"头衔被改成了什么色"：
 * 涂过的头衔只有在 uShowPaint 开着时才用涂色，关掉就回到游戏原色，
 * 否则"藏掉填色"无法生效：LUT 里仍是改写后的颜色。
 * 写 LUT 的规则由 app.js 的 lutColorOf() 决定。
 *
 * 两件不受开关管的事：
 *   * 海、湖、河、不可通行区（伪头衔）始终显示 —— 它们不是领地，
 *     没有"上不上色"一说，抹掉只会让地图出现空洞；
 *   * 手绘层盖在头衔色之上 —— 涂的是地图上的位置，与当前层级无关。
 */

/**
 * 画布像素总数上限（自动降 dpr 用）。
 *
 * 边界逐像素计算，一帧开销与画布像素数成正比，因此给总像素封顶：
 * 超限就降低 dpr（见 resize()），画面略糊，但省下十几倍时间。
 *
 * 2.6e6 的取值依据：手机（390×844、dpr 2）约 260 万像素，
 * 即以手机上流畅的量级为标准。
 * 1080p 屏（1920×1080×1 ≈ 200 万）在限额内，不受影响。
 * 会被降的是 4K 屏，以及 Windows 缩放 125%/150% 的高 dpr 场合。
 */
const MAX_CANVAS_PX = 2.6e6;

// ---- 渲染器初始化失败的分类 / 现场收集（必须排在 FRAG 之前）
//    测试把从片元着色器开头到 compile 之间的内容当作着色器源码扫描保留字：
//    该区间内出现 class / this 会被误报成"着色器里用了保留字"。
//    测试还用 indexOf 定位两个标记字面量，注释里出现同样的字面量会把
//    "着色器源码"截成一段注释，因此在该区间内不要写出这两个词。
/**
 * 渲染器初始化失败。错误信息必须说明失败发生在哪一步。
 *
 * 上下文在创建时被浏览器收走与着色器写错是两回事：
 *   · 前者是显卡 / 显存 / 驱动 / 后台切换问题，换机器或刷新即可；
 *   · 后者是代码 bug，刷新多少次都一样。
 * 二者混为一谈会把排查方向带偏。
 *
 * stage 取值（app.js 的 describeRendererFailure 据此生成说明）：
 *   no-webgl2      —— 浏览器 / 显卡没给出 WebGL2 上下文
 *   context-lost   —— 上下文创建后丢失，或编译 / 链接期间丢失
 *   out-of-memory  —— 显存 / 内存不足
 *   shader-compile —— 顶点 / 片元着色器编译失败
 *   shader-link    —— 两个着色器链接失败
 *   texture-limit  —— 设备贴图上限小到放不下任何切片
 *   renderer       —— 以上之外（建纹理 / VAO 等）
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
 * 判断这台机器是否在用软件渲染（SwiftShader / llvmpipe / 微软基本显示适配器）。
 *
 * 两条判据，任意一条成立即算：
 *   ① WEBGL_debug_renderer_info 的 unmasked 名字含软件光栅器特征；
 *   ② 拿不到 unmasked 名字，但 RENDERER 是 WebKit WebGL
 *      （真显卡的 Chrome/Edge 在 Windows 上通常给得出 unmasked 名字；
 *       拿不到且原生名如此，大概率为软件路径）。
 *
 * 宁可漏判，也不要把正常显卡误判成软件渲染 —— 误判会让排查方向偏离。
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
    // 没有 unmasked 名字、且原生名就是 WebKit WebGL → 多半是软件路径
    if (!name && /webkit webgl/.test(base.toLowerCase())) return true;
    return false;
  } catch (e) { return false; }
}

/**
 * 地址栏的 ?shader=border 之类调试开关（量性能用）。
 *
 * 软件渲染下链接完整着色器需要 39 秒（SwiftShader 现场编译），
 * 要衡量"退一档省多少"必须能直接指定档位。
 * 普通使用不需要它；支持时加 ?shader=border 即可先跑起来。
 * 认不出的值一律当作"未指定"，不改变默认行为。
 */
function _shaderTierFromUrl() {
  try {
    if (typeof location === 'undefined') return '';
    const m = /[?&]shader=(mid|border|title|lite|full)\b/.exec(String(location.search || ''));
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

/**
 * 把 GL 的现场收集成一组普通字段（导出日志 / 错误屏都要用）。
 */
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
    /* 软件渲染标记也要进报告：它决定错误屏给出哪一套建议。
     * 报告里只有 "WebKit WebGL" 时，无法区分"显卡弱"和"根本没用到显卡"。 */
    out.softwareGL = detectSoftwareGL(gl);
  } catch (e) {
    out.factsError = String((e && e.message) || e);
  }
  return out;
}

/** 抛一个带 stage 的初始化错误（detail 自动带上 GL 现场）。 */
function _setupFail(stage, message, gl, extra) {
  throw new RendererSetupError(stage, message, Object.assign(_glFacts(gl), extra || {}));
}

/** 建 WebGL2 上下文 —— 依次尝试多组属性。
 *
 * 不能只试一次：
 *   · 双显卡 / 集显机器上 powerPreference: 'high-performance' 偶尔直接返回 null；
 *   · 浏览器把"硬件加速被关"报成创建失败，但换一组属性（或稍后再试）能拿到软件上下文；
 *   · webglcontextcreationerror 的 statusMessage 是唯一能说明原因的文字，
 *     不接它就只剩一句"不支持 WebGL2"。
 *
 * 这里只负责拿到 gl 对象，不判断它是否已经丢失；
 * 调用方取得后应立即用 isContextLost() 判断一次。
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
    /* 最后尝试完全默认的属性：有些浏览器对 alpha:false /
     * premultipliedAlpha:false 这类组合会直接拒绝，默认属性反而能拿到上下文。 */
    {},
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

/* 整数纹理全部停用。
 *
 * HOI4 的报告与图形体检定位到根因（Adreno 616 · Chrome 132）：
 *    · 「整数纹理采样: 读回 0，应该是 156」    → R16UI + texelFetch 恒为 0
 *    · 「分块数组纹理: 读回 0 / 0 / 0」        → R16UI 数组纹理一层都采不出
 * 于是每个像素的省份 id 都是 0 → 全图按 0 号地块上色 → 纯白 255,255,255，
 * 而地名走 2D canvas，不受影响。
 * （报告里的 WEBGL2_UNAVAILABLE 属于 content:// 那条路径，与此无关。）
 *
 * 16 位值改用 RG8 归一化（低字节 R、高字节 G），仍是 2 字节/像素，
 * 显存不增加；8 位值改用 R8 归一化（与 uBorderDepth 同一套）。
 * 归一化纹理是所有驱动的最快路径，避开整型采样。
 * 代价：着色器里多一次解码（两次乘、一次移位，可忽略）。
 * 收益：不再有任何整数采样器，这一类驱动 bug 整体消失。
 */
const FRAG = `#version 300 es
precision highp float;
precision highp int;
/* 采样器的精度必须单独声明。
 *
 * GLSL ES 3.00 中 sampler 类型没有默认精度，不声明会在部分驱动上编译失败：
 *      ERROR: 0:9:   'sampler2DArray' : No precision specified
 *      ERROR: 0:178: 'sampler2DArray' : No precision specified
 * （AMD Radeon 610M · ANGLE D3D11；ANGLE 校严格，桌面原生 GL 常常放过，
 *   因此本地怎么试都正常，一到 ANGLE 就白屏。）
 *
 * 整数纹理退役时，usampler 的两行精度声明被删除，却未补归一化版本的声明，
 * 会使采样器全部失去精度声明，构成全平台隐患。
 * sampler2DArray 与 sampler2D 是两个独立类型，各需声明一次。
 */
precision highp sampler2D;
precision highp sampler2DArray;

uniform sampler2D uProv;          // RG8    province id（低字节 R · 高字节 G）
// 分块路径（原尺寸 16384×8192 用）：每层一块
// uUseTiles == 0 时下面的 provAt() 退化为读 uProv，
// 与不分块时完全等价，半尺寸那套一点不受影响。
uniform sampler2DArray uProvArr;  // RG8    每层一块
uniform ivec2 uProvTiles;         // (tileW, tileH)
uniform int   uProvCols;          // 每行几块
uniform int   uUseTiles;          // 0 = 用 uProv（老路）, 1 = 用 uProvArr（分块）
/* 降采样倍数（只有"数组纹理都采不出"的设备才 >1）
 *   这类机器无法使用分块贴图，只能把 id 图缩小上传（一块 2D 贴图即可容纳）
 *   画面上的省界会粗一些，但地图仍可显示、涂色和悬停
 *   取整除法即可（最近邻，缩图后的省界会粗一格）*/
uniform int   uProvScale;
uniform sampler2D uTitleMap;    // RG8    (省份, 层级) → 头衔序号（拍平成一维存）
uniform sampler2D  uColorLut;   // RGBA8  头衔序号 -> 颜色
uniform sampler2D  uPaint;      // RGBA8  province -> 手绘色（alpha=0 表示没涂）
/* 边界粗筛位图：归一化 R8，每个字节存 8 个格子的 1 bit
 *   1 = 该格靠近省界，值得跑射线；0 = 该格不可能画到线
 *   与当前层、涂色无关，换层 / 涂色都不需要重算
 *   未接入该图时 _nearSeam 恒真 → 完全退回逐像素射线，不会画错
 *   采样用 texelFetch；归一化取样后需 ×255 还原
 *   纹理格式与着色器声明必须一致：纹理用 R8、声明写 usampler2D 会因
 *     uint 与 float 混算而编译失败，报错形如
 *     '*' : no operation exists that takes 'highp uint' and 'const float'
 */
uniform sampler2D  uBorderDepth;
uniform int        uBorderDepthOn;
uniform sampler2D  uPaintLabel; // RG8    province -> 标记编号（0 = 没涂）
uniform ivec2 uMapSize;
uniform int   uTitleMapW;       // 归属表纹理的宽度
uniform int   uNumProvinces;    // 省份总数（拍平索引要用）
uniform int   uPaintW;          // 手绘层纹理的宽度（同样是拍平的）
uniform int   uTier;           // 颜色取哪一层
uniform int   uEditTier;       // 边界和悬停看哪一层
uniform int   uFineTier;       // 最细层（荒地逐块节点住在这一层）
uniform int   uShowTitles;
uniform int   uShowPaint;
uniform float uMix;
uniform int   uBorderTitle;     // 画不画头衔之间的分界线
uniform int   uBorderPaint;     // 画不画手绘色块的分界线
uniform int   uPaintOnly;       // 1 = 当前没停在年份视图（CK3 那种没有年份层的也算）
                                //     JS 那边 = !(有年份层 && 视图停在年份层)
                                //     用途：没开年份视图时，未上色的地块之间不互相划界
uniform vec3  uUnpainted;       // 「未上色区域」的颜色
uniform float uBorderW;         // 分界线线宽，单位是设备像素
uniform int   uExtraCount;      // 链上还有几级（0~4）
uniform int   uExtraTier[4];    // 每一级看哪一层
uniform float uExtraW[4];       // 每一级的线宽（越往上越粗）
uniform int   uExtraShow[4];    // 每一级那个开关开没开
uniform float uExtraA[4];       // 每一级的浓度（本层之上：父级可半透明）
uniform float uBorderA;         // 分界线浓度
uniform float uPaintBorderW;    // 填色边界的宽度（默认取上两层）
                                // 注意别与上面的 uPaintW（手绘纹理宽度）重名
uniform float uPaintBorderA;    // 填色边界的浓度（实心）

uniform float uMapPerPx;        // 一个设备像素等于多少个地图像素
uniform int   uNoAA;            // 1 = 关掉抗锯齿（整图导出用：每个像素取精确颜色）
uniform int   uLutW;
uniform int   uRealTitles;      // 序号 >= 它的都是海/湖/河/山这类伪头衔
uniform uint  uHoverTid;        // != NONE 时按当前层那个头衔整片亮（新包：一片一个 tid）
uniform int   uHoverPaintOn;    // 1 = 高亮按涂色认族（只有剧本粒度 + 填色·边界时）
uniform vec3  uHoverPaint;      // 要高亮的那一族的涂色
uniform int   uHoverPid;        // >0 = 只高亮这一个地块（老包那种共享伪节点退回这一条）
/* 「同一片海」的编组号 —— 老包的退路
 *   每层一片的包里，同一片 = 同一个 tid，直接比较 uHoverTid 即可
 *   但每层一片之前打的包里，全世界的海共用一个 #sea（tid 相同）：
 *     按 tid 亮会让全世界的海一起亮，按 pid 又只能亮一格
 *   → 那批包由 CPU 侧按当前编辑层那张水域名表编号：同名 = 同一组
 *     （见 gl.js 的 rebuildHoverGroups / app.js 的悬停逻辑）
 *   组号每个 pid 一个（EU5 最细层有 3635 组，超过 8 位，按 16 位传入）
 *   uHoverGroupId == 0 表示未编组（新包），走 uHoverTid / uHoverPid 两条
 *   编组优先于后两条（新包传的就是 0，不会冲突）
 */
uniform sampler2D  uHoverGroup; // RG8    province -> 组号（1..N 海 · N+1.. 荒地 · 0 = 不属于任何一片）
uniform int   uHoverGroupW;     // 那张表的宽度（与手绘层同一套拍平写法）
uniform uint  uHoverGroupId;    // != 0 = 亮这一组（同一片海的所有地块，不是全世界的海）
uniform uint  uHoverLabel;      // 要高亮那一族的标记编号（0 = 没涂），同色不同标记 = 两块
uniform vec3  uBackdrop;
/* 底层身份标（meta.kindMask 传成一张每 pid 一格的表）
 *   0 = 空位（0 号不用）/ 1 陆地 / 2 海洋 / 3 湖泊 / 4 河流 /
 *   5 不可通行海域 / 6 不可通行区域
 *   用途：每一格按它最底层那个 pid 的身份上色 ——
 *     归属、当前层有没有片，都不参与
 *   uKindOn == 0（老包没有这枚标）→ 整条让开，行为不变
 */
uniform sampler2D uKindTex;     // R8     0..6（归一化，取样后 ×255 还原）
uniform int   uKindOn;
uniform int   uKindW;           // 拍平宽度（与 hoverGroup 同一套写法）
uniform vec3  uNature[5];       // 2..6 → 海 / 湖 / 河 / 不可通行海域 / 不可通行

/* 「水域 · 边界」那条线
 *   只负责水域之间（海洋 / 湖泊 / 河流 / 不可通行海域，身份码 2..5）的缝
 *   海岸线（水 ↔ 陆）仍归本层头衔线，不归它
 *   同一条缝只有一个出处：旧通道（本层线 / 填色 / 多级链）在这一条上让开
 *     （见 main 里的射线）
 *   独立通道：地区 / 势力 / 填色三个开关都不管它，
 *     因此"边界全关"也不影响它，只认自己的开关
 *   走编辑层（uEditTier），与本层头衔线同一层，换层即换粒度
 */
uniform int   uWaterBorderOn;
uniform float uWaterBorderW;    // 粗细（格数，与其它边界同一个单位）
uniform float uWaterBorderA;    // 浓度（0~1）
uniform sampler2D uWaterKind;   // R8    每 pid 一格：0 = 不是水 / 2..5 = 那四类
uniform int   uWaterKindW;      // 拍平宽度（与 kindTex 同一套）

/* 国旗（剪贴蒙版）
 *
 *   每个省份记录一个旗号（0 = 没旗），渲染时按旗号取旗面颜色
 *   → 旗子被国土形状裁掉（不在这个旗号里的省不会走到这张表）
 *   → 头衔线 / 国名照旧压在上面，因为它们画在颜色之后
 *
 *   旗子按色块分组，不按头衔 —— 一个色块能跨好几个头衔
 *     （涂色层 A 色 A 名，见 app.js 的 rebuildPaintBlocks）→ 只能按 pid 记录
 */
uniform sampler2D uFlagIdx;     // R8      pid → 旗号（0 = 没旗，1.. = 第几面）
uniform int   uFlagIdxW;        // 拍平宽度（与 kindTex 同一套）
uniform sampler2D uFlagSlots;   // RGBA32F 每面旗两格：矩形(x0,y0,x1,y1) / 图集uv(u0,v0,u1,v1)
uniform int   uFlagSlotW;
uniform sampler2DArray uFlagTex; // 一层一面旗的数组纹理（层数按需增长）
                                  //   每面旗各占一层，不再受图集格数限制
uniform int   uFlagOn;          // 0 = 整条让开（没贴任何旗时开销为零）

/* 「荒地 · 边界」那条线
 *   与水域那条同构：只管"荒地 ↔ 荒地"的缝
 *   荒地挨着陆地 / 水的外缘不归它，仍归本层头衔线
 *   没有自己的纹理 —— 读的是 uKindTex（身份标原样，6 = 不可通行）
 *     那张本来就是每 pid 一格的 usampler2D，而且一直绑着
 *     （水域那条读 uWaterKind，因为"认不认得出是水"需要另算一遍；
 *       荒地不用算：kindMask 里 6 就是 6）
 *   独立通道：地区 / 势力 / 填色三个开关都不管它，
 *     "边界全关"也不影响它，只认自己的开关
 *   走编辑层（uEditTier），与别的边界同一层
 */
uniform int   uWasteBorderOn;
uniform float uWasteBorderW;    // 粗细（格数）
uniform float uWasteBorderA;    // 浓度（0~1）

in vec2 vMap;
out vec4 outColor;

const uint NONE = 65535u;

// 地图矩形之外：只铺一层底色。
// 否则视口越界时，采样会被 CLAMP_TO_EDGE 沿边缘拉成横向色带。
const vec3 OUTSIDE = vec3(0.035, 0.043, 0.052);

/* ============ 归一化解码：16 位值读回来是两个通道 ============
 *
 *  不再使用整数纹理（HOI4 报告 + 图形体检定位）
 *
 *     Adreno 616 + Chrome 132 上实测：
 *       「整数纹理采样: 读回 0，应该是 156」        ← R16UI + texelFetch 恒给 0
 *       「分块数组纹理: 读回 0 / 0 / 0」            ← R16UI 数组纹理一层都采不出
 *     于是每个像素的省份 id 都是 0 → 整张图按 0 号地块上色 → 纯白 255,255,255，
 *     而地名走 2D canvas，不受影响。
 *
 *     这是驱动 / ANGLE 翻译层的问题，换写法绕开：16 位值拆成
 *     R = 低字节 · G = 高字节，用归一化 RG8 传（仍是 2 字节/像素，
 *     显存不增加），着色器里 r×255 + g×255×256 还原；
 *     8 位值用归一化 R8（与 uBorderDepth 同一套，各家最快路径）。
 *
 *  采样一律 NEAREST + texelFetch —— 这些格子是枚举值，插值无意义。
 *  取整用加 0.5 再取整（不是直接 int()）：归一化反算有 ~1e-5 误差，
 *    int() 朝零截断，168/255*255 稍有偏小就变成 167，整张图会逐渐错位。
 */

/** R8 归一化取样 → 0..255 的整数 */
int u8At(sampler2D t, ivec2 xy) {
  return int(texelFetch(t, xy, 0).r * 255.0 + 0.5);
}

/** RG8 归一化取样 → 0..65535 的整数（R = 低字节 · G = 高字节） */
uint u16At(sampler2D t, ivec2 xy) {
  vec4 c = texelFetch(t, xy, 0);
  uint lo = uint(c.r * 255.0 + 0.5);
  uint hi = uint(c.g * 255.0 + 0.5);
  return lo + hi * 256u;
}

/** 数组纹理同理（分块路径） */
uint u16AtArr(sampler2DArray t, ivec3 xy) {
  vec4 c = texelFetch(t, xy, 0);
  uint lo = uint(c.r * 255.0 + 0.5);
  uint hi = uint(c.g * 255.0 + 0.5);
  return lo + hi * 256u;
}

/** (省份, 层级) → 头衔序号。
 *
 *  归属表拍平成一维存（索引 = 层级 × 省份数 + 省份），不是二维的：
 *  维多利亚3 有 4 万多个省份，拿「省份数 × 层级数」当纹理宽度会超掉显卡的
 *  MAX_TEXTURE_SIZE（常见是 16384），二维存根本传不上去。
 */
uint titleAt(uint pid, int tier) {
  int idx = tier * uNumProvinces + int(pid);
  return u16At(uTitleMap, ivec2(idx % uTitleMapW, idx / uTitleMapW));
}

/** 手绘层也是拍平存的（索引 = 省份，宽度压在 uPaintW 以内） */
vec4 paintOf(uint pid) {
  int i = int(pid);
  return texelFetch(uPaint, ivec2(i % uPaintW, i / uPaintW), 0);
}

uint paintLabelOf(uint pid) {
  int i = int(pid);
  return u16At(uPaintLabel, ivec2(i % uPaintW, i / uPaintW));
}

/** 这个地块属于哪一片海 / 荒地（0 = 不属于任何一片）
 *
 *  与 paintLabelOf 同一套拍平索引（宽度另给一个 uniform，两者可能不同）
 *  这些表一律 texelFetch，不能用 sampler 的插值采样
 */
uint hoverGroupAt(uint pid) {
  int i = int(pid);
  return u16At(uHoverGroup, ivec2(i % uHoverGroupW, i / uHoverGroupW));
}

/** 这个地块最底层那个 pid 的身份（1 陆地 / 2 海 / 3 湖 / 4 河 / 5 不可通行海域 / 6 不可通行）
 *
 *  uKindOn == 0（老包没有 kindMask）→ 一律返回 1（陆地），调用方的覆盖逻辑让开
 *  归一化 R8 + texelFetch（与 hoverGroupAt 同一规矩，不能靠采样器插值）
 */
int kindOf(uint pid) {
  if (uKindOn == 0) return 1;
  int i = int(pid);
  return u8At(uKindTex, ivec2(i % uKindW, i / uKindW));
}

/** 身份 → 类色（调色板里 2..6 那五行，由 JS 侧 applySettings() 传入） */
vec3 natureColor(int k) {
  return uNature[clamp(k - 2, 0, 4)];
}

/** 一个省份此刻该显示成什么颜色。 */
vec4 colorOfPid(uint pid) {
  uint tid = titleAt(pid, uTier);
  vec4 lc = texelFetch(uColorLut, ivec2(int(tid) % uLutW, int(tid) / uLutW), 0);
  // 手绘在最上层：涂过的地直接返回它的颜色；uMix 只作用在头衔色上
  // 与它无关 —— 不论这一层此刻是伪头衔还是没有归属。
  if (uShowPaint == 1) {
    vec4 pc = paintOf(pid);
    if (pc.a > 0.5) return vec4(pc.rgb, 1.0);
  }

  /* 荒地：读最细层那个 wl_ 节点的 LUT
   *
   *   荒地自动上色算出的颜色写在每块荒地自己的最细节点上（wl_<pid>）——
   *   粗层的荒地块是同名几块共用的（#impassable_c_3 之类），颜色会互相覆盖
   *   → 按 uFineTier 查，与当前视图 / 粒度无关
   *
   *   必须排在 kind >= 2 的类色判断之前：
   *     CK3 的荒地底层身份是 kind = 6（不可通行山地），先判 kind 会直接
   *     返回"不可通行区域"的灰色，自动色永远露不出来。
   *
   *   判断"这一格是荒地"：JS 侧 setWasteFixed() 把标记打在 LUT 的 alpha 通道
   *     （荒地 = 255，其余 = 0，该通道别处不用）→ 一次取样即可，不用多传纹理
   *   也必须在 tid == NONE 的早退之前查 —— 剧本层荒地本来就没有归属
   *   手绘层在上面已经先返回（直接涂的荒地仍以涂色为准）
   *   水不会误命中：水的 LUT alpha 是 0，查完继续走 kind 那条
   *   关掉「荒地自动上色」时 JS 会把这份 LUT 写回"不可通行区域"的色，
   *     着色器这边不用再判开关
   */
  {
    uint _fw = titleAt(pid, uFineTier);
    if (_fw != NONE) {
      vec4 _fc = texelFetch(uColorLut, ivec2(int(_fw) % uLutW, int(_fw) / uLutW), 0);
      if (_fc.a > 0.5) return vec4(_fc.rgb, 1.0);
    }
  }

  /* 按底层身份上色
   *   这一格的底层 pid 只要是水 / 不可通行那几类（kind >= 2），直接给类色：
   *     与它在哪一层、有没有片、有没有归属都无关
   *     （EU5 的脚本层海域本来无主 → 未上色灰，正是要解决的问题）
   *   顺序：手绘层在上面（涂过的地已经返回，涂色不受影响）
   *   荒地（alpha 标记）已经在上一步返回，这里只剩真正的水 / 老荒地
   *   kind == 1（陆地）一律往下走原逻辑：
   *     无片（无主）→ uBackdrop / uUnpainted；有片 → LUT 头衔色 + 浓度
   *     脚本层有主地、地理层陆地头衔、国名色、边界都不受影响
   *   老包（uKindOn == 0 → kindOf 恒为 1）→ 这一段永不命中，行为不变
   */
  int _kind = kindOf(pid);
  if (_kind >= 2) return vec4(natureColor(_kind), 1.0);

  /* 没有归属的地块（NONE）—— 两种情形给两种色：
   *   · 没开剧本（uPaintOnly == 1，见它声明处）→ 显示背景色
   *     整张图就是"还没上色的底"，与背景一致
   *   · 开着剧本 → 显示设置里的「未上色区域」
   *     它与背景色是两项（分开配置）—— 默认背景 220、未上色 150
   *   不是透明：透明露出来的是深色底，与海、空地都分不清
   */
  if (tid == NONE) {
    return vec4(uPaintOnly == 1 ? uBackdrop : uUnpainted, 1.0);
  }
  int t = int(tid);
  vec4 c = lc;                      // 上面已经取过这张 LUT 了，不取第二遍

  // 头衔色在这里按「浓度」淡掉 —— 手绘在上面那一步已经返回，不受浓度影响。
  // 浓度不能在最外面统一 mix，否则手绘会一起被淡掉。
  return vec4(mix(uBackdrop, c.rgb, uMix), uShowTitles == 1 || t >= uRealTitles ? 1.0 : 0.0);
}

/** 地图像素 → 省份 id：老路一张整图，新路按块取（两者结果一致）
 *
 *  两条路都是归一化纹理 + texelFetch + 手写解码（见 u16At 那段说明）
 *  uProvScale > 1 时（只有"数组纹理都采不出"的机器才 >1）：
 *     id 图是缩小上传的，坐标要先除回去；取整除法 = 最近邻
 *     省界会粗一点，但地图仍可显示、涂色、悬停
 */
uint provAt(ivec2 ip) {
  if (uProvScale > 1) ip = ip / uProvScale;
  if (uUseTiles == 0) return u16At(uProv, ip);
  ivec2 t = ivec2(ip.x / uProvTiles.x, ip.y / uProvTiles.y);
  ivec2 l = ivec2(ip.x % uProvTiles.x, ip.y % uProvTiles.y);
  return u16AtArr(uProvArr, ivec3(l, t.y * uProvCols + t.x));
}

/** 这一格如果是国旗地盘，取旗面颜色（不是 → alpha = 0）
 *
 *  必须在 colorOfPid 之后定义（它要用 provAt / colorOfPid）
 *  矩形用地图像素写，不做归一化 —— 归一化在 16384 的图上精度不够
 */
vec4 flagAt(uint pid, vec2 pos) {
  int i = int(pid);
  float fv = texelFetch(uFlagIdx, ivec2(i % uFlagIdxW, i / uFlagIdxW), 0).r;
  int f = int(fv * 255.0 + 0.5);
  if (f <= 0) return vec4(0.0);
  /* 每面旗占三格：矩形 / uv / 层号 */
  int b = (f - 1) * 3;
  vec4 rc = texelFetch(uFlagSlots, ivec2(b % uFlagSlotW, b / uFlagSlotW), 0);
  vec4 uv = texelFetch(uFlagSlots, ivec2((b + 1) % uFlagSlotW, (b + 1) / uFlagSlotW), 0);
  float lay = texelFetch(uFlagSlots, ivec2((b + 2) % uFlagSlotW, (b + 2) / uFlagSlotW), 0).r;
  vec2 sz = rc.zw - rc.xy;
  if (sz.x <= 0.5 || sz.y <= 0.5) return vec4(0.0);
  /* uv 必须用连续坐标 pos，不能用格心（ip + 0.5）
   *   用格心 → 每个地图像素里旗面是一块纯色，放大后呈马赛克
   *   用连续坐标 → 一个地图像素内部旗面仍渐变，屏幕分辨率越高旗越细
   *   （遮罩仍按地图像素算，旗子仍被国土形状裁掉）
   */
  vec2 t = (pos - rc.xy) / sz;
  if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) return vec4(0.0);
  return vec4(texture(uFlagTex, vec3(mix(uv.xy, uv.zw, t), lay)).rgb, 1.0);
}

vec4 colorAt(ivec2 ip, vec2 pos) {
  ip = clamp(ip, ivec2(0), uMapSize - 1);
  uint pid = provAt(ip);
  vec4 c = colorOfPid(pid);
  /* 国旗盖住颜色（旗面完全盖住）——
   * 但只盖填色，不盖边界线和名字，那些在这之后画
   * pos 是连续坐标（不是格心），旗面清晰度全靠它
   */
  if (uFlagOn == 1) {
    vec4 f = flagAt(pid, pos);
    if (f.a > 0.5) c = f;
  }
  return c;
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

/** 这个地块是不是水、是哪一类水（0 = 不是水；2 海 / 3 湖 / 4 河 / 5 不可通行海域）
 *
 *  算不出水陆的包（没有 kindMask、也没有 #sea_ 那几把键，老包）：
 *     那张表全 0、app 侧给的 waterBorderOn 也是 false → 一律返回 0
 *     → 水域通道整条退化，行为不变
 *     （GLSL ES 3.0 的 uniform 在非一致控制流里照样能读，
 *       所以这个提前返回是纯优化，不是必须的）
 *  整数纹理一律 texelFetch（与 kindOf / hoverGroupAt 同一规矩）
 *  位置要求：它调 pidAt，必须排在 pidAt 后面
 *     （放错会报"缺前置声明: pidAt"，运行起来是着色器编译失败 → 白屏）
 *     → 与 paintLabelAt 那几个同处一段（都在 pidAt 之后）
 */
uint waterAt(ivec2 q) {
  uint pid = pidAt(q);
  if (pid == 0u) return 0u;
  int i = int(pid);
  return uint(u8At(uWaterKind, ivec2(i % uWaterKindW, i / uWaterKindW)));
}

/** 这一格是水（且算得出水陆）—— 判据收在一处
 *  表全 0 时恒 false → 老包上所有跟水有关的让位都不生效，观感不变
 */
bool waterIs(ivec2 q) {
  return waterAt(q) != 0u;
}

/** 这一格是不是荒地（不可通行区域，身份码 6）
 *
 *  荒地边界与水域边界读的纹理不同：
 *    水域那条读 uWaterKind（app 侧算的"认不认得出是水" 2..5）
 *    荒地这条读 uKindTex（身份标原样 2..6），6 就在里面
 *    → 不用新开纹理、不用新加 uniform（uKindTex 一直绑着）
 *  判据收在这一处，别在别处写 kindOf == 6
 *  uKindOn == 0（老包没有这枚标）→ 恒 false → 荒地通道整条不生效，观感不变
 */
bool wasteIs(ivec2 q) {
  if (uKindOn == 0) return false;
  uint pid = pidAt(q);
  if (pid == 0u) return false;
  int i = int(pid);
  return u8At(uKindTex, ivec2(i % uKindW, i / uKindW)) == 6;
}

/** 手绘层上两个像素算不算不同的块。
 *
 *  一个涂了一个没涂、涂的色不同 —— 都算不同块。
 *  同色但标记不同也算 —— 这与 JS 那边切手绘色块的规则必须一致
 *  （rebuildPaintBlocks 也是"同色 + 同标记"才算一块），
 *  否则两块明明是两个标记、中间却没有线。
 */
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

/* 沿一个方向最多找多少格。
 *
 * 这个数直接决定性能：
 *   每个像素四个方向各走 R 步找边界，而 R 随缩放增大 ——
 *   缩到全图时 uMapPerPx 能有几十，R 就顶到这个上限
 *   一帧采样次数 ≈ 像素 × 4 × R；144 万像素、R = 48 时约 2.7 亿次采样，
 *   边界开销主要在这里
 *
 * 12 足够：屏幕上一条线的半宽最多就是这个数（像素）。
 *   更粗的线只出现在"缩得很小、线糊成一片"的视图里，
 *   那时多走几十步在画面上分辨不出，用这点精度换 4 倍速度。
 */
const int MAXR = 12;

/** 两点的原版色（LUT 里那个头衔的颜色） */
vec3 lutColour(ivec2 ip) {
  uint tid = titleAt(pidAt(ip), uTier);
  if (tid == NONE) return vec3(-1.0);
  return texelFetch(uColorLut, ivec2(int(tid) % uLutW, int(tid) / uLutW), 0).rgb;
}

/* ============================================================================
 * 一趟射线：所有边界通道共用一次采样
 *
 * 原先每条通道各跑一趟 —— 本层头衔、填色、链上每一级、水域、荒地，
 * 各有一套 rayDist*，各走 4 方向 × 最多 12 步：同一条缝最多被算五遍，
 * 同一个邻居格被采十几遍，通道之间还会抢同一条缝，只能靠"让开"补丁维持秩序。
 *
 * 正确结构：
 *   · 所有延伸边界都是最底层边界（例如 province）的子集
 *   · 同一个边界分成不同的段，开关只决定段的不透明度、粗细度和是否显示
 * → "这条缝归谁"是一张分类表，不是五套并列的射线
 *
 * 现在只有一趟：每步只采一次，边采边把这条缝分进它挂着的每一段，
 * 每段各自记"这个方向上最近的一条"，四方向取最小（见 main 里那段）
 *
 * 三条让开规则，一个都不能丢：
 *   ① 水 ↔ 水那条缝任何层都归「水域 · 边界」
 *      理由：不存在一个水域能被涂色成为势力
 *      → 本层线 / 填色 / 多级链在这一条上一律让开
 *   ② 荒地 ↔ 荒地同理 → 归「荒地 · 边界」
 *   ③ 只让开"两边同类"那一条 —— 海岸线（水↔陆）、荒地外缘（荒地↔陆）
 *      仍归本层线
 * "让开"是这一条缝不算、继续往外走，不是"这个方向没了"
 *   （跳过这条之后，外面可能还有一条真正归本段的缝）
 *
 * 两件故意不做的事：
 *   · 「跳一步预筛」（先只采 ip+dir*R 那一点，头衔相同就说"这一向没缝"）
 *     是近似：比 R 格还窄的地块会被整段漏掉，
 *     表现为涂色 / 还原之后边界不更新
 *     一趟射线之后每步本来就要采样，预筛省下的两三步不值这个风险
 *   · 「每段各截自己的半径」—— 现在按最粗那一段走到底，
 *     细的各自在混色那步跟自己的半宽比（超出半宽算出来本来就是 0）
 * ========================================================================== */

/** 屏幕上那一格显示的颜色 = LUT 原色（没涂时） */
vec3 shownColour(ivec2 ip) {
  return lutColour(ip);
}

/** 一格在屏幕上的样子：颜色 + 涂没涂 + 标记
 *
 *  先算一次再比的结构：
 *   射线循环里起点那一侧从头到尾都没变，不能每步重算 ——
 *   paintAt + shownColour（内含 pidAt / titleAt）+ paintLabelAt
 *   一趟下来约 10 次纹理采样，而 4 方向 × R 步都在重复同一件事；
 *   缩放时 R 增大，这笔开销是卡顿的主要来源
 *   → 起点算一次（cellViewOf(ip)），循环里每步只算对面那一格，省一半
 */
struct CellView {
  vec3 col;       // 屏幕上的颜色（x < -0.5 = 这一格没颜色）
  bool painted;   // 玩家涂过没有
  uint tid;       // 编辑层的头衔序号（本层线 / 水域 / 荒地都用它）
  uint label;     // 标记编号
  uint pid;       // 省份号（取 tid 时要用  见 cellViewOf）
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

/* @@MID_CUT_PAINTRAY_BEGIN@@ */
  /** 两格在画面上算不算"两种东西"（沿用原 shownDiffers 的判断，逻辑未改） */
bool viewsDiffer(CellView A, CellView B) {
  /* 年份视图没开 → 未上色的省份之间，一律不划国家级边界
   *   （不管颜色 —— 两个都没涂就是没线）
   *   这一行必须在最前面：
   *     放到颜色比较后面的话，颜色不同的两个没涂省份照样会划一条 */
  if (uPaintOnly == 1 && !A.painted && !B.painted) return false;
  vec3 ca = A.col, cb = B.col;
  if (ca.x < -0.5 && cb.x < -0.5) return false;  // 两边都没颜色（无主地）→ 不划
  if (ca.x < -0.5 || cb.x < -0.5) return true;   // 一边有一边没有 → 划

  if (distance(ca, cb) > 0.02) return true;      // 颜色不同 → 划（国家之间）
  /* 颜色相同 → 一律比标记（三种情况都要覆盖）
   *
   * 这里只有一套编号 —— JS 那边 syncAllPaintLabels 给每一块地都写了标记：
   *     涂过的地 = 填的那个名
   *     没涂的地 = 它自己原版的国名（不是 0 —— 没涂过的地方也有标记）
   *   所以"原版那块地"和"涂出来的那块地"名字一样就是同一个编号
   *   → 用自己的色 + 自己的名涂自己那块 → 两边同号 → 不划
   */
  return A.label != B.label;
}
/* @@MID_CUT_PAINTRAY_END@@ */

/** 一条线在某一格里的距离（b 是那 4 个边标记位：1 左 · 2 右 · 4 上 · 8 下）
 *  f 是片元在格内的小数，所以 f.x 天然就是"到左边那条边的距离"
 *  → 亚格精度是天然的，不需要插值、也不需要距离场
 */
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

  // 4 点超采样。偏移必须按屏幕算（uMapPerPx = 一个屏幕像素占多少地图像素），
  // 不能写成固定的地图像素 —— 否则放大到 18 倍时 0.25 个地图像素 = 4.5 个屏幕像素，
  // 四个点摊开跨 9 个像素，两个色块之间会被平均出一条 9 像素宽的纯色混色带。
  // 锁在一个屏幕像素以内，接缝就永远只有一格过渡。
  //
  // 位置用 4 点旋转网格（RGSS）而不是正方形四角：斜边上过渡层次更多，
  // 不会出现"要么纯色要么 50%"的硬台阶。最大偏移 0.5 个屏幕像素。
  // 导出整图时关掉抗锯齿 —— 那时一个屏幕像素正好等于一个地图像素，
  // 四点超采样会把相邻两个色块的颜色平均出一条混色带，放大看就是"糊的区域"。
  // 屏幕上不动（uNoAA=0），观感保持原样。
  /* 四个采样点落在同一个地图像素上时，只采一次
   *
   *  两种时候四个点完全重合：
   *    · uNoAA=1（pu 是 0）—— 整图 / 高清导出、降分辨率那条路
   *    · 放大编辑（地图一格 ≫ 屏幕一格）—— 平时绝大多数像素
   *  否则每种都跑四遍 colorAt（每遍十来次纹理取样），白烧三遍
   *
   *  只把同一个颜色抄给 c1..c3，下面那段合并算式不改
   *    → 结果与四遍采样逐位相同
   *    → 边界上那几圈仍走四采样，抗锯齿效果不变 */
  float pu = uNoAA == 1 ? 0.0 : uMapPerPx;
  vec2 f0 = vMap + vec2( 0.5,      0.16667) * pu;
  vec2 f1 = vMap + vec2(-0.16667,  0.5    ) * pu;
  vec2 f2 = vMap + vec2( 0.16667, -0.5    ) * pu;
  vec2 f3 = vMap + vec2(-0.5,     -0.16667) * pu;
  ivec2 q0 = ivec2(floor(f0));
  ivec2 q1 = ivec2(floor(f1));
  ivec2 q2 = ivec2(floor(f2));
  ivec2 q3 = ivec2(floor(f3));
  vec4 c0, c1, c2, c3;
  if (q0 == q1 && q1 == q2 && q2 == q3) {
    c0 = colorAt(q0, f0);
    c1 = c0;
    c2 = c0;
    c3 = c0;
  } else {
    c0 = colorAt(q0, f0);
    c1 = colorAt(q1, f1);
    c2 = colorAt(q2, f2);
    c3 = colorAt(q3, f3);
  }

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
  // 改成算到分界线的距离，再套一条宽度锁在设备像素上的抗锯齿斜坡：
  // 屏幕上永远是同一条细实线，缩放多少都不变粗细。
  // 无主地块也是一块地 —— 这道闸不能写成「本格在编辑层有头衔」，
  // 而"无主地"在编辑层拿到的正是 NONE，于是它的整段边界计算全被跳过：
  //   · 国家 ↔ 无主地：只有国家那一半画得出线，另一半整段没有 →
  //     看着就是"国家跟无主地之间没画边界"
  //   · 无主地 ↔ 海、无主地 ↔ 荒地：同理只有半边
  // 该跳过的是根本没有省份的地图底（provAt = 0），无主地照样要算。
  /* 精简版从这里切（见下面 makeLiteFragment）
   *
   *  软件渲染（SwiftShader）会在这一段边界射线上链接失败 ——
   *  报告里「上传到显卡 → 失败」花了 92 秒，即 CPU 在硬啃这一坨循环
   *  这段整块拿掉之后：颜色 / 涂色 / 悬停都还在，只少了边界线
   *  → 画面能用，比"打开就是一张报错屏"好得多
   *
   *  两个标记必须各占一行、周围不能多写别的 —— 切法是
   *     「前半段 + 后半段」直接拼接，依赖这两行的位置
   *  切掉的是一个完整的 if 块（连同大括号），所以切完语法仍然完整
   *     切完会少掉 R / dTitle / ramp 这些只在块里用的变量 —— 它们本来就没出过块 */
  /* @@LITE_CUT_BEGIN@@ */
  if (pidAt(ip) != 0u) {    /* 精简版把整个 if 块切掉（从 @@LITE_CUT_BEGIN@@ 到 @@LITE_CUT_END@@）
     *  块里那几个变量（R / dTitle / dPaint / ramp）都没出过块，切完不留孤儿 */
    /* ---- 半径：按所有通道里最粗的那一条算 ----
     *  每段各算各的（R / Re / Rw / Rw2）；一趟射线之后只能有一个半径
     *  → 取最粗的那条，保证没有一条线被裁掉；细的各自在混色那步判
     *  线宽大于半径的线会被裁掉，所以必须取 max */
    float _bMax = 0.0;
    if (uBorderTitle == 1) _bMax = max(_bMax, uBorderW);
    if (uBorderPaint == 1) _bMax = max(_bMax, uPaintBorderW);
    if (uWaterBorderOn == 1 && uWaterBorderA > 0.0) _bMax = max(_bMax, uWaterBorderW);
    if (uWasteBorderOn == 1 && uWasteBorderA > 0.0) _bMax = max(_bMax, uWasteBorderW);
    for (int i = 0; i < 4; i++) {
      if (i >= uExtraCount) break;
      if (uExtraShow[i] == 0 || uExtraTier[i] < 0) continue;
      _bMax = max(_bMax, uExtraW[i]);
    }
    int R = int(clamp(ceil(0.5 * uMapPerPx * (_bMax + 1.0)),
                           1.0, float(MAXR)));

    /* 每一段各自记"这个方向上最近的一条缝"，没找到就是 1e9 */
    float dTitle = 1e9;
    float dPaint = 1e9;
    float dWater = 1e9;
    float dWaste = 1e9;
    float dEx[4];
    for (int i = 0; i < 4; i++) dEx[i] = 1e9;

    /* 粗筛：一位定生死（加载时算好的"省界 ±2 格"轮廓位图）
     *   bit 1 ⇒ 值得跑射线 · bit 0 ⇒ 不可能画到线，直接跳过
     *   与当前层 / 涂色无关，换层、涂色都不用重算这张图
     *   未接入该图时 _nearSeam 恒真 → 完全退回逐像素射线，不会画错 */
    bool _nearSeam = true;
    if (uBorderDepthOn == 1) {
      uint _cb = uint(texelFetch(uBorderDepth, ivec2(ip.x >> 3, ip.y), 0).r * 255.0 + 0.5);
      _nearSeam = ((_cb >> uint(ip.x & 7)) & 1u) != 0u;
    }

    if (_nearSeam) {
      /* 起点那一侧只算一次（否则每步重算，一趟要十几次采样）*/
      CellView _A = cellViewOf(ip);
      uint tSelf = _A.tid;          // 编辑层的头衔（本层线 / 水域 / 荒地共用）
      bool _ipW = waterIs(ip);
      bool _ipX = wasteIs(ip);
      /* 链上每一环自身一侧的头衔 —— 同样只算一次 */
      uint tEx[4];
      for (int i = 0; i < 4; i++) {
        tEx[i] = 0u;
        if (i >= uExtraCount) break;
        if (uExtraShow[i] == 0 || uExtraTier[i] < 0) continue;
        tEx[i] = titleAt(_A.pid, uExtraTier[i]);
      }
      int _st = max(1, int(uMapPerPx * 0.5));

      for (int di = 0; di < 4; di++) {
        ivec2 dir = di == 0 ? ivec2( 1, 0)
                  : di == 1 ? ivec2(-1, 0)
                  : di == 2 ? ivec2( 0, 1)
                            : ivec2( 0,-1);
        for (int k = 1; k <= MAXR; k++) {
          int _d = k * _st;                    // 这一趟实际跨了多少格
          if (_d > R) break;
          ivec2 q = ip + ivec2(dir.x * _d, dir.y * _d);
          /* 垂距：缝是横平竖直的，必定落在它那一格的跨度之内，不用开方 */
          float dl = dir.x != 0 ? (dir.x > 0 ? float(_d) - f.x : f.x + float(_d) - 1.0)
                                : (dir.y > 0 ? float(_d) - f.y : f.y + float(_d) - 1.0);
          /* ---- 这里是唯一一次采样，下面每一段都从它取信息 ---- */
          uint qpid = pidAt(q);
          uint qtid = titleAt(qpid, uEditTier);
          /* 这两个 && 是性能开关，不要为了好读改成先算后判
           *   「让开」只在自己这侧就是水/荒地时才有意义（pairW = _ipW && qW），
           *   所以陆地像素（绝大多数）这里一次采样都不做
           *   —— 一趟射线不等于"每个像素都多采四次"，见下面 ④⑤ 各自的闸 */
          bool qW = _ipW && waterIs(q);
          bool qX = _ipX && wasteIs(q);
          bool pairW = qW;     // 水 ↔ 水：归「水域 · 边界」
          bool pairX = qX;     // 荒地 ↔ 荒地：归「荒地 · 边界」

          /* ① 本层头衔线 —— 海岸线、荒地外缘、国界、无主地边界都是它
           *   这里不能加"涂过就跳过"的闸 ——
           *     地区边界不看涂色内容，加了闸会把地区边界一起吃没 */
          if (uBorderTitle == 1 && !pairW && !pairX && qtid != tSelf)
            dTitle = min(dTitle, dl);

          /* @@MID_CUT_PAINTRAY_BEGIN@@ */
          /* ② 填色边界：颜色 / 标记有一个不同就划，判据全在 viewsDiffer 里
           *   不要在这儿重复实现；填色边界关闭时这条 pass 根本不跑 */
          if (uBorderPaint == 1 && !pairW && !pairX) {
            vec4 _pp = paintAt(q);
            CellView _B;
            _B.pid = qpid;
            _B.tid = qtid;
            _B.painted = _pp.a > 0.5;
            _B.col = _B.painted ? _pp.rgb : shownColour(q);
            _B.label = paintLabelAt(q);
            if (viewsDiffer(_A, _B)) dPaint = min(dPaint, dl);
          }
          /* @@MID_CUT_PAINTRAY_END@@ */

          /* @@MID_CUT_EXTRA_BEGIN@@ */
          /* ③ 多级链：这条缝同时挂在哪几级上（不是二选一）
           *   上界必须是常量 4，用 break 收 —— 见下面混色那段的长注释 */
          for (int ex = 0; ex < 4; ex++) {
            if (ex >= uExtraCount) break;
            if (uExtraShow[ex] == 0) continue;
            if (uExtraTier[ex] < 0) continue;
            if (pairW || pairX) continue;
            int Re = int(clamp(ceil(0.5 * uMapPerPx * (uExtraW[ex] + 1.0)), 1.0, float(MAXR)));
            if (dl > float(Re)) continue;      // 超出这一环的半径就不必采了
            if (titleAt(qpid, uExtraTier[ex]) != tEx[ex]) dEx[ex] = min(dEx[ex], dl);
          }
          /* @@MID_CUT_EXTRA_END@@ */

          /* @@MID_CUT_WATER_BEGIN@@ */
          /* ④ 水域边界：判据是"对面是水 且 编辑层 tid 不同" —— 只查对面一侧
           *   差别只在海岸线上：陆侧那半边也会被它画一条
           *   让开那两句跟它无关：水水缝让开的是 title / paint / extra */
          if (uWaterBorderOn == 1 && uWaterBorderA > 0.0 && qtid != tSelf && waterIs(q))
            dWater = min(dWater, dl);
          /* @@MID_CUT_WATER_END@@ */

          /* @@MID_CUT_WASTE_BEGIN@@ */
          /* ⑤ 荒地边界（与水域那条同构，只换了身份判据
           *   同样只查对面）*/
          if (uWasteBorderOn == 1 && uWasteBorderA > 0.0 && qtid != tSelf && wasteIs(q))
            dWaste = min(dWaste, dl);
          /* @@MID_CUT_WASTE_END@@ */
        }
      }
    }

    // 过渡带 ≈ 一个设备像素（要提到外面：下面多级边界那几圈也要用）
    float ramp = 0.5 * uMapPerPx;
    if (dTitle < 1e8) {
      float bw = 0.5 * uBorderW * uMapPerPx;     // 半宽
      float b  = 1.0 - smoothstep(bw - ramp, bw + ramp, dTitle);
      col = mix(col, vec3(0.035, 0.045, 0.06), b * uBorderA);
    }
    /* 多级边界：粒度那层之上，一层比一层粗（地区 → 国家）——
     * 中间那些"年份"层跳过（不然 1618 + 省份 会冒出 1789 那条）。
     *
     * 上界必须是常量 4，用 break 收 —— 不要改成 uniform
     *   规范上 GLSL ES 3.0 允许运行时上界，但手机驱动不认
     *   → 着色器编译失败 → 整屏黑
     *   取舍：兼容性 > 编译速度 */
    /* @@MID_CUT_EXTRA_BEGIN@@ */
    for (int ex = 0; ex < 4; ex++) {
      if (ex >= uExtraCount) break;
      if (uExtraShow[ex] == 0) continue;
      if (dEx[ex] >= 1e8) continue;
      float bwe = 0.5 * uExtraW[ex] * uMapPerPx;
      float be  = 1.0 - smoothstep(bwe - ramp, bwe + ramp, dEx[ex]);
      col = mix(col, vec3(0.035, 0.045, 0.06), be * uExtraA[ex]);
    }
    /* @@MID_CUT_EXTRA_END@@ */
    /* @@MID_CUT_PAINTRAY_BEGIN@@ */
    /* ============ 涂色边界（手绘色块之间）============
     *  压在所有政治边界之上，显示优先级为：
     *    涂色 + 剧本 ＞ 父级 ＞ 其他；开启父级时，所选粒度的上位边界居中。
     *  → 底 → 顶：本层头衔（所选粒度）→ 父级 → 剧本 → 涂色
     *  剧本那一圈也在 uExtra* 里（app.js 把父级排在前、剧本排在后），
     *  所以这里只要排在多级链之后，就是"涂色高过它们全部"
     *
     *  永远用自己那套浓度/粗细（uPaintBorderW / uPaintBorderA）
     *    不跟着本层那条走 —— 色块边界是画出来的线，不是行政区划 */
    if (dPaint < 1e8) {
      float bwp = 0.5 * uPaintBorderW * uMapPerPx;
      float bp  = 1.0 - smoothstep(bwp - ramp, bwp + ramp, dPaint);
      col = mix(col, vec3(0.035, 0.045, 0.06), bp * uPaintBorderA);
    }
    /* @@MID_CUT_PAINTRAY_END@@ */
    /* ============ 水域边界（水域 ↔ 水域）============
     *  水域边界开关负责且仅负责「水域之间（海洋 / 湖泊 / 河流 /
     *    不可通行海域）的边界」
     *  海岸线（水 ↔ 陆）不归它 —— 那条仍由本层头衔线画
     *
     *  三级闸，一个都不能少：
     *    ① uWaterBorderOn —— 开关（app 侧已把"勾了 + 这张图算得出水陆"AND 好）
     *       它不看 地区 / 势力 / 填色 那三个开关（要的就是独立，
     *       所以"边界全关"时水域线照样在，想关就关自己那个勾）
     *    ② uWaterBorderA > 0 —— 浓度拉到 0% 即完全不画
     *    ③ 射线要真找得到那条缝（下面 dWater < 1e8）
     *
     *  旧那两条通道在水水缝上已经让开（见上面一趟射线里 pairW）
     *    → 同一条缝只有一个出处，不会"后画的赢" */
    /* @@MID_CUT_WATER_BEGIN@@ */
    if (uWaterBorderOn == 1 && uWaterBorderA > 0.0 && dWater < 1e8) {
      float bww = 0.5 * uWaterBorderW * uMapPerPx;
      float bw2 = 1.0 - smoothstep(bww - ramp, bww + ramp, dWater);
      col = mix(col, vec3(0.035, 0.045, 0.06), bw2 * uWaterBorderA);
    }
    /* @@MID_CUT_WATER_END@@ */
    /* ============ 荒地边界（荒地 ↔ 荒地）============
     *  与水域那段同构，只有三处不同：
     *    ① uniform 名（uWasteBorder*）
     *    ② 判据（wasteIs —— 读的是 uKindTex 那张一直绑着的身份标，
     *       没有新纹理；水域要算过一遍才知道是不是水，荒地不用）
     *    ③ 让位那一句（一趟射线里 pairX）
     *  三级闸照样一个都不能少（On / A > 0 / 射线真找得到）*/
    /* @@MID_CUT_WASTE_BEGIN@@ */
    if (uWasteBorderOn == 1 && uWasteBorderA > 0.0 && dWaste < 1e8) {
      float bwq = 0.5 * uWasteBorderW * uMapPerPx;
      float bq2 = 1.0 - smoothstep(bwq - ramp, bwq + ramp, dWaste);
      col = mix(col, vec3(0.035, 0.045, 0.06), bq2 * uWasteBorderA);
    }
    /* @@MID_CUT_WASTE_END@@ */
  }
  /* @@LITE_CUT_END@@ */
  /* 这个右花括号属于上面那个 if (pidAt(ip) != 0u)。
   *   上移会提前闭合 if，使射线整段跑到块外 —— 连地图底色（provAt = 0）
   *   也会去跑边界射线，并且会迫使下面重复声明 R / dTitle 等变量。
   *   位置由缩进标明，不要再把它往上挪。
   *   注意：这段里不许出现反引号 —— 整段着色器是 JS 模板字符串，
   *     一个反引号就会截断文件。*/

  // 悬停提亮：整个头衔一起提亮（高亮 → 更高亮）
  // 亮起来的是 uEditTier 那一级
  // 提亮的那块必须正好是"点下去会涂到的那块"，否则不知道会改到谁。
  // 注意：不看 uShowTitles。关掉原版颜色之后图上是底色，
  // 但悬停仍然要提亮 —— 否则不知道会涂到哪一块。
  if (uHoverGroupId != 0u) {
    /* 同一片海（或同一片荒地）整片一起亮
     *   这一条只有老包走 —— 那批包里全世界的海共用一个 #sea
     *     （tid 相同，按 tid 亮会把全世界的海一起点亮），所以 CPU 侧
     *     按真名表编了组号（组号跟着编辑层那张水域名表走，见 rebuildHoverGroups）
     *   新包（每层一片）走下面 uHoverTid 那条：同一个 tid = 同一片
     *   排在 uHoverPid 前面：有编组就按编组亮，没编组才退回"只亮一格" */
    if (hoverGroupAt(pidAt(ip)) == uHoverGroupId) col = mix(col, vec3(1.0), 0.30);
  } else if (uHoverPid > 0) {
    // 海/湖/荒地：只提亮光标底下这一块（老包那种共享伪节点退回这一条）
    // 现在是退路 —— 有编组表 / 有每层一片的包都走上面那两条
    /* 悬停一律提亮（就是字面意思）
     *   不要自适应：按底色深浅决定压暗或提亮会让行为不稳定，统一提亮
     *   浅色地也不是问题：各省的色基本是中低亮度的饱和色，
     *     往白里混 0.30 一眼就看得出来 */
    if (int(pidAt(ip)) == uHoverPid) col = mix(col, vec3(1.0), 0.30);
  } else if (uHoverPaintOn == 1) {
    // 整族提亮：按显示色 + 标记认 —— 涂过的用手绘色，没涂的用原版色。
    // 这样"取大清的颜色涂俄罗斯"之后，大清和俄罗斯会一起提亮
    // 但同色不同标记是两块 → 标记也得对上（0 = 没涂，跟没涂的一起）
    vec4 hp = paintAt(ip);
    vec3 hc = hp.a > 0.5 ? hp.rgb : lutColour(ip);
    // 颜色对上之后：
    //   · 没涂过的同色地 → 算同一族（它的名字来自原版，比如开局那块瓦窑堡）
    //   · 涂过的 → 必须同一标记（同色不同标记是两块）
    bool sameLabel = (paintLabelAt(ip) == uHoverLabel);
    if (hc.x > -0.5 && distance(hc, uHoverPaint) < 0.01 && sameLabel) {
      col = mix(col, vec3(1.0), 0.30);              // 同样是提亮
    }
  } else if (uHoverTid != NONE) {
    uint h = pidAt(ip);
    if (h != 0u && titleAt(h, uEditTier) == uHoverTid) {
      col = mix(col, vec3(1.0), 0.32);              // 整片稍微再亮一点，好认
    }
  }

  outColor = vec4(col, 1.0);
}`;

/* ============ 精简版片元着色器（链接失败时的保底）============
 *
 *  软件渲染（SwiftShader）上这个着色器可能链接失败，光链接就烧了 92 秒；
 *  真显卡几毫秒。
 *  能画出来永远比"看得懂报错"强。
 *
 *  做法：把主着色器里唯一那个巨型段落（逐像素跑边界射线，4 方向 × MAXR 步
 *  × 最多 6 条通道）整块切掉，其余不动。
 *  切完剩下的：颜色 / 涂色 / 荒地 / 身份色 / 悬停高亮 —— 全都在
 *  少掉的就是边界线（那些线本来也要在放大时才好看）
 *
 *  切法靠两个标记行的位置（见 FRAG 里的 @@LITE_CUT_BEGIN/END@@）
 *  切完还是同一份 uniform 名单 —— 少用的那几个照样要 getUniformLocation
 *    并每个都传值：GLSL 会把没用的 uniform 优化掉，位置是 null，
 *    传 null 在 WebGL 里是静默 no-op，不会报错
 */
function makeLiteFragment(src) {
  const a = src.indexOf('/* @@LITE_CUT_BEGIN@@ */');
  const b = src.indexOf('/* @@LITE_CUT_END@@ */');
  if (a < 0 || b < 0 || b <= a) return null;      // 标记被人动过 → 宁可不给精简版
  return src.slice(0, a) + src.slice(b);
}

/* ==========================================================================
 * 中间档着色器（Adreno 613 + vivo 浏览器）
 *
 *  诊断报告：「完整着色器链接失败，已退到精简版（少了边界线）」
 *  即不是开关 / 涂色 / 数据的问题 —— 完整着色器在这台机器上根本链接不过
 *
 *  精简版为了保命把整个边界块都切了（连本层地区线也没了）
 *  但 Adreno 613 并非一点边界都算不了：它是被完整版那一大坨
 *    「4 方向 × 12 步 × 最多 6 条通道」的射线循环拖垮的
 *  → 做两档逐步减负的中间版，按"能链上、画质尽量高"的顺序试：
 *
 *    ① mid：保留本层头衔 / 填色 / 多级链，只砍「水域」「荒地」两条独立通道
 *    ② border：再砍多级链，只留本层头衔 + 填色（地区边界就是这条）
 *    ③ lite：边界整块不要（最后保底）
 *
 *  三个版本都还是同一份 uniform 名单，少用的由 GLSL 自己优化掉
 *  切块靠 @@MID_CUT_*@@ 标记；标记被动了就返回 null，宁可不给
 * ========================================================================== */

/** 切掉 @@MID_CUT_<name>_BEGIN/END@@ 之间的整段（同名可以有好几对）
 *  一趟射线之后，一条通道的代码分成两处（循环里的判据 + 循环后的混色）
 *  → 同名标记各写一对，这里把所有出现的都切掉
 *  一对都找不到就是标记被人动过 → 返回 null，宁可不给这个变体 */
function cutAuxBlock(src, name) {
  const bMark = '/* @@MID_CUT_' + name + '_BEGIN@@ */';
  const eMark = '/* @@MID_CUT_' + name + '_END@@ */';
  let out = src;
  let hit = false;
  for (;;) {
    const a = out.indexOf(bMark);
    if (a < 0) break;
    const b = out.indexOf(eMark, a + bMark.length);
    if (b <= a) return null;
    out = out.slice(0, a) + out.slice(b + eMark.length);
    hit = true;
  }
  return hit ? out : null;
}

/** 中等着色器：多级边界还在，只砍水域 / 荒地两条独立通道
 *  一趟射线之后，通道不再各有"射线函数"，只是同一趟循环里的几个判据块，
 *  切的就是那几个块 */
function makeMidFragment(src) {
  let out = cutAuxBlock(src, 'WATER');
  if (out == null) return null;
  out = cutAuxBlock(out, 'WASTE');
  return out;
}

/** 边界着色器：只留本层头衔 + 填色边界（地区 / 省份线就是这条） */
function makeBorderOnlyFragment(src) {
  let out = cutAuxBlock(src, 'EXTRA');
  if (out == null) return null;
  out = cutAuxBlock(out, 'WATER');
  if (out == null) return null;
  out = cutAuxBlock(out, 'WASTE');
  return out;
}

/** 最简边界版：只留本层头衔线，连填色那一小段判据也砍掉
 *  —— 万一 border 档还链不上，至少地区 / 省份边界要能看见 */
function makeTitleOnlyFragment(src) {
  let out = makeBorderOnlyFragment(src);
  if (out == null) return null;
  out = cutAuxBlock(out, 'PAINTRAY');
  return out;
}

/** 上下文是不是被浏览器收走了（驱动重置 / 切后台 / 显存紧张）
 *
 *  这条判断必须排在"编译失败"前面：
 *   上下文在编译途中被收走 → COMPILE_STATUS 是 false、getShaderInfoLog 是 null
 *   → 只报一句「着色器编译失败：null」，会把排查方向引向着色器
 *   注意：拿不到 isContextLost 的（老桩 / 假 GL）当作"没丢"，别把正常失败也吞了 */
function ctxLost(gl) {
  try { return !!(gl.isContextLost && gl.isContextLost()); } catch (e) { return false; }
}

/** 显卡档案 —— 报错时必须带上（否则只看得见"失败了"三个字，无从下手）
 *  优先用不打码的那个串（WEBGL_debug_renderer_info，各家都支持） */
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

/** 编译/链接失败：分两种，各带各的话（code 给 app 那边认"要不要等上下文回来"）
 *  · CTX_LOST —— 上下文被收走了，等它回来重来一次即可（app.js 的 buildRenderer）
 *  · COMPILE / LINK —— 真的着色器问题，带上驱动给的日志 + 显卡档案
 *  消息里不许写"着色器加载失败"这种笼统话，要让看的人一眼知道该往哪儿查 */
function shaderErr(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

function compile(gl, type, src) {
  const label = type === gl.VERTEX_SHADER ? '顶点着色器' : '片元着色器';
  /* 先判上下文丢没丢
   *   上下文一丢，createShader / compileShader 全是静默 no-op
   *   getShaderParameter 于是返回 false → 下一句就报"着色器编译失败"
   *   可着色器源码本身没有任何问题 —— 这条会造成误报 */
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
    try { gl.deleteShader(sh); } catch (e) { /* 忽略删除失败 */ }
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

/* 纹理绑定的"代号"
 *
 *  render() 会记「第 N 号单元绑着哪张纹理」，下次一样就不重复绑
 *  但绑纹理的不止 render() —— 传块、换图、传国旗、探测纹理这些都在别处绑，
 *  而且都绑在"当前那个单元"上 → render 记的那本账就过期了
 *
 *  所以：凡是 render() 之外的绑定，一律把代号 +1
 *  render() 每帧比一次代号，变了就把整本账撕掉重记（一次比较而已，可忽略）
 *  不这么做的话，传块时顺手绑的那张块纹理会被当成"第 12 号单元还是那张占位纹理"
 *    → 下一帧跳过重绑 → 国旗那一路采到块纹理上（画面不会黑，但会错，极难查）
 */
let GL_TEX_EPOCH = 0;

/** 「没有分块数据」时那三个数的替身（做成常量 → 每帧不用再 new 一个对象） */
const NO_TILES = Object.freeze({ tileW: 1, tileH: 1, cols: 1 });

/** 别处动过纹理绑定 → 代号 +1，让 render() 记的那本账作废（见上面那段） */
function glTexTouched() { GL_TEX_EPOCH++; }

function makeTexture(gl, w, h, internal, format, type, data, filter) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  glTexTouched();      // 绑在"当前单元"上 → render 的账过期
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  return tex;
}

/**
 * 挑一个最省显存的块尺寸
 *
 *  不能直接贴着上限开：
 *    · 贴 4096 → 9216 宽的图要 3×2 块，每块 4096² × 2 字节 = 33MB，合计 192MB；
 *    · 用 2048 → 5×3 = 15 块，合计 120MB（每块只有 8MB，但边角补零全浪费）；
 *    · 用 2304 → 4×2 = 8 块，合计 85MB —— 正好等于"整张图本身"的大小。
 *  所以这里把候选尺寸都算一遍总字节，挑最小的那个（并列取大块：层数少、上传次数少）。
 *
 *  总显存的下限就是 mapW × mapH × 2（块只能比它大、不可能更小）
 *  层数还得 ≤ 2048（MAX_ARRAY_TEXTURE_LAYERS 的常见下限）
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
  constructor(canvas, meta, opts) {
    /* opts.fastBoot = "先拿低一档把图打出来，着色器后台再升级"
       启动路径传它；自检 / 导出用的临时渲染器不传，行为与不传时一致 */
    this._fastBoot = !!(opts && opts.fastBoot);
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
    /* 刚创建就可能已经是"丢的"
     *   低端机 / 驱动刚重置 / 浏览器 GPU 进程正忙时，getContext 会先给一个
     *   isContextLost() === true 的上下文 —— 之后所有 GL 调用静默 no-op
     *   不在这儿拦住的话，下面 _build() 会一路失败，最后被报成
     *   "着色器编译失败"（会误导排查） */
    if (gl.isContextLost && gl.isContextLost()) {
      _setupFail('context-lost', 'WebGL2 上下文创建后立刻丢失（显卡驱动 / 显存）', gl,
        { stageAt: 'after-create' });
    }

    /* 显卡驱动重置 / 显存吃紧 / 手机切到后台时，浏览器会把整个 WebGL 上下文收走：
     * 所有 GL 对象（着色器 / 缓冲 / 全部纹理）一起作废，之后每帧 GL 调用静默 no-op
     * 不 preventDefault 的话浏览器不会再给 restored 事件（等于放弃这个上下文）
     * 所以接住它，并等 restored —— 那边把资源重建一遍（见下面的监听与 _build）
     * 上下文丢着的时候别画：画了也不上屏，还会把 GL 错误搅浑 */
    this.ctxLost = false;
    this.onContextLost = null;
    this.onContextRestored = null;      // 上下文回来了（app 那边要把数据重新喂一遍）
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
    this.lowRes = false;         // resize() 里判定：这台机器降过分辨率（见它那段说明）
    /* 拖动/缩放期间的分辨率折扣
     *   边界逐像素计算，一帧开销与画布像素数成正比。视角在动时 app.js 把它调成
     *   0.7（像素数 ×0.49），手停下 250ms 再调回 1 并补画一帧
     *   地名画在另一张 2D canvas 上，不受影响（拖动期间名字照样清楚）*/
    this.motionScale = 1;
    this.unpainted = [150 / 255, 150 / 255, 150 / 255];   // 「未上色区域」的颜色（无归属地块用）
    this.paintWidth = 1.7;      // 填色那条边界：默认取链上最粗那条的粗细（app 每帧给）
    this.paintAlpha = 1.0;      // 且实心
    /* 水域边界（自己一套宽浓，不沿用省份/地区那一档）
     *   它与"填色那条"是两回事：填色线是链上最粗那一级，这条只管水域之间的缝
     *   waterBorderOn 由 app 每帧给（= 那个勾 且 这张图算得出水陆）
     *     默认 true —— app 还没跑第一帧时（自检 / 最初几帧）行为与不设时一致 */
    this.waterBorderOn = true;
    this.waterBorderW = 1.0;
    this.waterBorderA = 1.0;
    /* 荒地边界
     *   app 侧必须把"那个勾 且 这张图有身份标"AND 好再写进来
     *     （与水域那条同一规矩，否则老包上会画出一堆假缝）*/
    this.wasteBorderOn = false;
    this.wasteBorderW = 1.0;
    this.wasteBorderA = 1.0;
    // 分界线是两个可调的旋钮：粗细按设备像素算，所以缩放多少都是同一个粗细；
    // 深浅就是往底色里混多少。想改观感改这两个数即可。
    this.borderWidth = 1.35;    // 基准线宽（设备像素）：太粗就往小调
    this.borderStrength = 0.75;
    // 基本底色 = (150,150,150)：没填色的地区（该层级没有头衔，或者没涂过）
    // 统一用这个灰，与海面、边界都分得开。
    // 多级边界链（粒度那层之上，一层比一层粗；app 每帧填）
    this.extraCount = 0;
    this.extraTiers = new Int32Array([-1, -1, -1, -1]);
    this.extraWs = new Float32Array([1.8, 2.4, 3.0, 3.6]);
    this.extraShows = new Int32Array([0, 0, 0, 0]);
    this.extraAs = new Float32Array([1, 1, 1, 1]);   // 每级浓度（父级可 0.75）
    // 兼容字段：等于链上第一条（老代码/测试看这几个）
    this.parentBorder = 0;
    this.parentTier = -1;
    this.parentWidth = 1.8;
    this.parentAlpha = 1.0;
    this.parentShow = 0;
    this.backdrop = [150 / 255, 150 / 255, 150 / 255];
    this.hoverTid = this.noTitle;
    this.hoverPaintOn = 0;
    this.hoverPaint = [0, 0, 0];
    this.hoverPid = 0;                     // >0 = 只亮这一个地块
    this.hoverLabel = 0;                   // 要高亮那一族的标记编号（0 = 没涂）
    /* 「同一片海 / 同一片荒地」的编组号表（每 pid 一个 Uint16，见 rebuildHoverGroups）
     *   0 = 不属于任何一片 → 退回 hoverPid 那条"只亮一格"（老包 / CK3 没有水名表）*/
    this.hoverGroupData = null;            // Uint16Array(numProvinces)（懒建：第一次悬停才算）
    this.hoverGroupTier = null;            // 这份表是哪一层编的（换层要重建）
    this.hoverGroupId = 0;                 // 这一帧要高亮的那一组（0 = 不按编组亮）
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
    /*: 哪些分块真的传进显存了（JS 缓存里有 ≠ 显存里有） */
    this.uploadedTiles = new Set();
    this._ready = false;

    /* 监听器要在 _build() 之前挂
     *   显卡上下文有可能在建渲染器的过程中就丢
     *   监听器挂在 _build() 后面时，那一次丢失没人接住（也就没 preventDefault）
     *   → 浏览器不再发 restored → 只能刷新（"打开就莫名其妙失败"的一条真因） */
    this._onCtxLost = (e) => {
      /* preventDefault 表示"这个事件由页面接管，请把它还回来"
       * 不写这一句，浏览器认为没人管 → 永远不发 restored */
      if (e && e.preventDefault) e.preventDefault();
      this.ctxLost = true;
      this.dirty = false;          // 丢着的时候别画：画什么都不会上屏
      if (this.onContextLost) this.onContextLost();
    };
    /* 上下文回来了 —— 每一样 GL 资源都要重建（WebGL 的规矩：对象全作废）
     *   这里只管"跟上下文绑在一起"的那几样
     *   纹理交给 app 重新喂（它手上才有省份 id / 归属表 / 笔迹，见 onContextRestored）*/
    this._onCtxRestored = () => {
      if (!this._ready) return;   // 建到一半就抛出去的那个半成品不接 restored
      try {
        this._build();
        // 旧纹理的句柄全部作废：清成 null，render() 会一直等到数据重新喂完才画
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
        this.uploadedTiles.clear();    // 显存里的块全没了 → 记录也清（重新喂时逐块重记）
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
      /* 已经是分类好的错就原样往上抛；普通异常包成 renderer 类（别丢掉现场） */
      if (err instanceof RendererSetupError) throw err;
      if (err && err.code) throw err;   // 老 shaderErr（CTX_LOST / COMPILE / LINK）原样给 app 认
      _setupFail('renderer', '建渲染器时出错：' + ((err && err.message) || err), gl,
        { stageAt: 'build', cause: String((err && err.stack) || err) });
    }
    /* 建完再看一眼：有些驱动不抛错、只是把上下文悄悄收走 */
    if (this.ctxLost || (gl.isContextLost && gl.isContextLost())) {
      this._detachContextListeners();
      _setupFail('context-lost', '建渲染器时 WebGL 上下文丢失', gl,
        { stageAt: 'after-build' });
    }
  }

  /** 建失败了就把 canvas 上的两个监听摘掉（重试时不会再叠一份） */
  _detachContextListeners() {
    const c = this.canvas;
    if (!c || !c.removeEventListener) return;
    if (this._onCtxLost) c.removeEventListener('webglcontextlost', this._onCtxLost);
    if (this._onCtxRestored) c.removeEventListener('webglcontextrestored', this._onCtxRestored);
  }

  /**
   * 建"跟上下文绑在一起"的那几样：着色器 / uniform 位置 / VAO / 占位纹理
   *
   * 可以重复调用 —— 上下文丢了又回来的时候要整个重建一遍
   * （手机切后台再回来就是这么一条路：iOS / Android 都会把上下文收走）
   * 注意：这里不许碰任何地图内容（笔迹 / 颜色 / 视角），那些都在别处存着
   */
  _build() {
    const gl = this.gl;

    /* 每个 sampler 都必须指向一张完整纹理 —— WebGL 的硬规矩
     *   手机版黑屏、中心像素 [0,0,0]、drawArrays 报 1282：
     *   着色器里声明了 sampler2D uBorderDepth，而手机上不建那张粗筛位图
     *     → render 里走 else 分支，只把 uBorderDepthOn 设成 0
     *       纹理单元 9 上什么都没绑 → 采样器指向空 → 1282 → 整帧丢弃 → 全黑
     *   规矩：就算这一路根本不采样，也得绑一张完整纹理（1×1 就够）
     *   电脑上没事是因为那张图建得出来、绑上了 → "电脑行手机不行"就是这么来的
     *   这张占位纹理要在 render 之前就建好（这里最省事）*/
    this.dummyTex = makeTexture(gl, 1, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE,
      new Uint8Array([0]), gl.NEAREST);
    /* 国旗那张是数组纹理，关掉的时候也得绑一张完整的占位
       （不绑 = 纹理不完整 → 整个画面黑）*/
    try {
      const dA = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, dA);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 1,
        gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.dummyArrTex = dA;
    } catch (e) { this.dummyArrTex = null; }

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    /* 上下文丢着的时候 getParameter 给 null
     *   —— 不拦的话下面那句会报"贴图上限只有 nullpx"，把人往"设备太小"上带
     *   （真正的原因还是上下文没了，先说清楚）*/
    if (ctxLost(gl)) {
      throw shaderErr('CTX_LOST', '建渲染器的时候显卡上下文已经被收走了（还没轮到编译着色器）');
    }
    // 地图比"单张贴图上限"大时不再拒绝 —— setData 里会把它就地切成一块块贴图
    // （手机 GPU 常见上限只有 4096 / 8192：CK3 9216×4608、EU5 8192×4096、
    //   米勒投影 11680×5760 都塞不进一张，直接抛错会导致整张图加载不出来）
    // 只有小到连一块切片都放不下的设备才真的没救
    if (maxTex < 256) {
      _setupFail('texture-limit', `这个设备的贴图上限只有 ${maxTex}px，放不下任何地图切片。`,
        gl, { stageAt: 'limits', maxTex });
    }
    this.maxTex = maxTex;

    /* 先认一下是不是软件渲染
     *
     *  报告里 渲染器 WebKit WebGL · GL WebGL 2.0 ()、没有 unmasked 显卡名，
     *  而「上传到显卡 → 失败」花了 92 秒 —— 这是 SwiftShader（软件光栅器）
     *  在拿 CPU 一点点啃这个巨大的片元着色器；真显卡上几毫秒就完了
     *
     *  典型成因：浏览器关掉了「使用硬件加速」/ 远程桌面 / 虚拟机 / 驱动被禁用
     *  → 记下来，报错时第一句就说这个，否则会照着"换浏览器"折腾半天
     */
    this.softwareGL = detectSoftwareGL(gl);

    /* ============ 链接：先试完整版，不行就退精简版 ============
     *
     *  完整版里那块"逐像素边界射线"在软件渲染上会把编译器拖垮（92 秒 → 链接失败）
     *  精简版把它切掉（见 makeLiteFragment）—— 能显示地图比什么都强
     *
     *  只有链接失败才退精简版 —— 语法错 / 上下文丢了，换个着色器也一样坏
     *  退成功之后 this.liteShader = true 要一路带进日志和报告，
     *     否则拿到报告的人会以为"没开硬件加速"是唯一原因
     */
    const _linkTry = (fragSrc) => {
      const prog = gl.createProgram();
      if (!prog) return { prog: null, info: 'createProgram 给了 null', linkMs: 0 };
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
      /* 量一下链接花了多久：真显卡几毫秒，软件渲染一两分钟 ——
       * 这个数本身就是"是不是用上显卡"的证据 */
      const t0 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      gl.linkProgram(prog);
      const ms = Math.round(((typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now()) - t0);
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) return { prog, info: '', linkMs: ms };
      const info = String(gl.getProgramInfoLog(prog) || '').trim();
      try { gl.deleteProgram(prog); } catch (e) { /* 忽略 */ }
      return { prog: null, info, linkMs: ms };
    };

    /* 软件渲染不要先撞完整版
     *
     *   没开硬件加速的机器上，「完整着色器链接」单这一项 39 秒
     *   （SwiftShader 现场编译；第二次打开只 43 ms，因为浏览器缓存了编译结果）
     *   而它最后是成功的 —— 干等 40 秒才看到地图，会以为软件坏了
     *
     *   软件渲染本来也画不快，完整版那块"逐像素边界射线"在它身上毫无收益
     *   所以：认出来是软件渲染，就直接从「最简边界」起步（本层头衔的边界还在），
     *   完整版留给真显卡
     *   真显卡的行为不变 —— 只有 detectSoftwareGL 说"是"才走这条
     *   ?shader=border 这种地址参数可以手动指定档位（量性能 / 支持用）
     */
    const _forcedTier = _shaderTierFromUrl();
    const _skipFull = _forcedTier ? (_forcedTier !== 'full') : (!!this.softwareGL || this._fastBoot);
    let linkMs = 0;
    let linkLog = '';
    this.liteShader = false;
    this.shaderTier = 'full';
    this.liteWhy = '';
    this.skippedFull = _skipFull;

    /* 画质从高到低：mid（本层 + 填色 + 多级链）→ border（本层 + 填色）→ title（本层头衔）→ lite（没有边界线）*/
    const _variants = [
      ['mid', makeMidFragment(FRAG), '中等着色器（保留本层 + 多级边界）'],
      ['border', makeBorderOnlyFragment(FRAG), '边界着色器（仅本层头衔/填色）'],
      ['title', makeTitleOnlyFragment(FRAG), '最简边界（仅本层头衔）'],
      ['lite', makeLiteFragment(FRAG), '精简着色器（无边界线）'],
    ];
    const _order = ['mid', 'border', 'title', 'lite'];
    const _chainStart = () => {
      if (_forcedTier) return Math.max(0, _order.indexOf(_forcedTier));
      if (this.softwareGL || this._fastBoot) return 2;   /* title：边界还在，2.4 s */
      return 0;     // 软件渲染直接落 title（border 那档 8.5 s，纯烧时间）
    };
    /* 从第 startIdx 档起顺着往下试，谁先链成功就用谁 */
    const _tryChain = (startIdx, why) => {
      for (let i = startIdx; i < _variants.length; i++) {
        const [tier, src, label] = _variants[i];
        if (!src) continue;
        const lr = _linkTry(src);
        if (lr.prog) {
          this.shaderTier = tier;
          this.liteShader = (tier === 'lite');
          this.liteWhy = why || '';
          this.liteLinkMs = lr.linkMs;
          try {
            console.warn('[gl] 用' + label + (why ? '（' + why + '）' : '')
              + '，链接 ' + lr.linkMs + ' ms ✓');
          } catch (e) { /* 忽略 */ }
          return lr;
        }
      }
      return { prog: null, info: '', linkMs: 0 };
    };

    let _r = { prog: null, info: '', linkMs: 0 };
    if (_skipFull) {
      try {
        console.warn('[gl] ' + (_forcedTier ? '按地址参数跳过完整着色器'
          : (this.softwareGL ? '软件渲染' : '快速启动'))
          + '：先用「' + (_forcedTier || 'title') + '」把图打出来'
          + (this._fastBoot && !this.softwareGL && !_forcedTier ? '，完整版后台再升 ✓' : ' ✓'));
      } catch (e) { /* 忽略 */ }
      _r = _tryChain(_chainStart(), this.softwareGL ? '软件渲染（没用上显卡）' : '');
      linkMs = _r.linkMs || 0;
    } else {
      _r = _linkTry(FRAG);
      linkMs = _r.linkMs;
      linkLog = _r.info;
      if (!_r.prog) {
        /* 先问上下文再说着色器 —— 上下文被收走时 LINK_STATUS 也是 false
         *   这种"失败"等上下文回来重来一次就好了，报成链接失败会把人带偏 */
        if (ctxLost(gl)) {
          throw shaderErr('CTX_LOST', '着色器还没链接完，显卡上下文就被收走了'
            + '（切后台 / 显存紧张 / 驱动重置都会这样）');
        }
        const ge0 = (gl.getError && gl.getError()) || 0;
        if (ge0 === 0x9242) {
          _setupFail('context-lost', '着色器链接时 WebGL 上下文丢失', gl,
            { stageAt: 'link', log: linkLog, glError: ge0, linkMs });
        }
        /* 只有"像个真着色器问题"时才降档（显存不足再试只是白等） */
        if (ge0 !== 0x0505) {
          const _why = linkLog || '（驱动没给日志）';
          const lr = _tryChain(0, _why);
          if (lr.prog) { _r = lr; linkMs = lr.linkMs; linkLog = ''; }
        }
      }
    }
    if (!_r.prog) {
      /* 日志可能是空的（驱动内部报错时只给个 LINK_STATUS = false）
          那就把渲染器和版本一起带上 —— 否则报上来只有"链接失败"四个字，
          根因（指令数超限 / 寄存器不够 / ANGLE 翻译不过）一点都看不出来 */
      _setupFail('shader-link',
        linkLog ? '着色器链接失败：' + linkLog : '着色器链接失败（驱动没给日志）', gl,
        { stageAt: 'link', log: linkLog, glError: (gl.getError && gl.getError()) || 0, linkMs,
          liteTried: !!makeMidFragment(FRAG),
          liteLog: (this.liteWhy || ''), softwareGL: this.softwareGL });
    }
    const prog = _r.prog;
    this._installProgram(prog);
    this._linkMs = linkMs;
    this._linkLog = linkLog;
    /* 数组纹理能不能采（真数据试一遍，见 _probeArrTex）——
     *   只在这里跑一次：上下文重建会再走一遍 _build，正好重测 */
    const _arr = this._probeArrTex();
    this.arrOk = _arr.ok;
    this.arrWhy = _arr.why || '';


    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    // 用当前的背景色，不是出厂色 —— 重建时别把调好的背景抹回默认
    gl.clearColor(this.backdrop[0], this.backdrop[1], this.backdrop[2], 1);
  }

  /**
   * 把一套 program 装到渲染器上：uniform 位置 + 顶点数组
   *
   *  这段独立成函数：后台升级着色器时需要重新安装一遍
   */
  _installProgram(prog) {
    const gl = this.gl;
    this.prog = prog;
    this.uni = {};
    /* 换了程序 → 每帧那本"上次发过什么"的账全作废
     *   新程序的 uniform 全是默认值（0），旧账里记的"已经发过 1 了"是别的程序的
     *   不清就会整帧沿用旧值 → 后台升级着色器之后画面全白/全黑（极难对出来）*/
    this._uCache = new Map();
    /* 类色那一组要重发
     *   uNature[5] 是数组 uniform，新程序的默认值同样是全 0
     *   它不走 _uCache（那本账一个 location 只记 4 个数，装不下 15 个 float），
     *   由 natureDirty 单独管 → 换程序必须置脏，否则后台升级完着色器
     *   海/湖/河那几类立刻变黑 */
    this.natureDirty = true;
    this._texBound = null;      // 纹理那本账：交给 render() 第一次用时重建
    this._texEpoch = -1;
    for (const n of ['uView', 'uProv', 'uProvArr', 'uProvTiles', 'uProvCols', 'uUseTiles', 'uProvScale', 'uNoAA', 'uTitleMap', 'uColorLut', 'uPaint', 'uPaintLabel', 'uBorderDepth', 'uBorderDepthOn',
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
                     'uFlagIdx', 'uFlagIdxW', 'uFlagSlots', 'uFlagSlotW', 'uFlagTex', 'uFlagOn',
                     /* 荒地边界那三根 ——
                      *   它没有自己的纹理 uniform（读的是 uKindTex，见着色器那段）*/
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
    return prog;
  }

  /**
   * 后台把着色器升级到完整版
   *
   *  完整版在入门独显/集显上首次链接要 39 秒（实测 AMD 610M + ANGLE；
   *  浏览器缓存命中后只 43 ms）—— 干等 39 秒，等于"这软件坏了"
   *  现在先用低一档把图打出来（2 秒），再在后台编完整版，编好了无缝换掉
   *
   *  两个要点：
   *   · 有 KHR_parallel_shader_compile 就用它轮询 —— 编译在 GPU 进程里跑，
   *     主线程 await 等，界面不冻（没这个扩展就退回同步链接）
   *   · 换 program 只在画完一帧之后（dirty 置真即可），旧纹理/数据一个不动
   *
   *  @returns {Promise<boolean>} 真的换上了没有
   */
  async upgradeShader() {
    if (this.upgrading || this.ctxLost) return false;
    if (this.shaderTier === 'full') return false;
    /* 软件渲染就别升了 —— SwiftShader 编一遍要 45 秒，纯烧 CPU 换一点画质不值
       （它本来也画不快，多级边界对它只是负担）*/
    if (this.softwareGL) return false;
    if (_shaderTierFromUrl()) return false;      // 手动指定档位时就别自作主张
    this.upgrading = true;
    const gl = this.gl;
    /* 缺扩展时不许静默退出
     *
     *   没有 KHR_parallel_shader_compile 时直接 return false、一行日志都不打，
     *   会一直停在「最简边界（仅本层头衔）」，国家之间的粗边界整片消失，
     *   诊断报告里却干干净净。
     *
     *   现在：缺扩展就同步升（先打一条警告说明可能卡一下）。
     *   真显卡缓存命中时是毫秒级，只有极冷的首次编译才会卡
     *
     *   这个检查必须在 gl 拿到之后（写在前头会 ReferenceError）*/
    let parExt = null;
    try {
      parExt = (gl.getExtension && gl.getExtension('KHR_parallel_shader_compile')) || null;
    } catch (e) { parExt = null; }
    if (!parExt) {
      try {
        console.warn('[gl] 没有 KHR_parallel_shader_compile，改用同步升级（可能卡一下）✓');
      } catch (e) { /* 忽略 */ }
      try { LOG.event('渲染升级', '无并行编译扩展，同步升一档'); } catch (e) { /* 忽略 */ }
    }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      /* 依次试完整 → 中等 → 边界，取第一个链成功的；都不行就维持现状 */
      const _rank = { lite: 0, title: 1, border: 2, mid: 3, full: 4 };
      const _now = _rank[this.shaderTier] == null ? 0 : _rank[this.shaderTier];
      let prog = null;
      let tier = '';
      for (const [t, src] of [['full', FRAG], ['mid', makeMidFragment(FRAG)], ['border', makeBorderOnlyFragment(FRAG)]]) {
        if (!src) continue;
        if (_rank[t] <= _now) break;            // 不比现在好就别试了
        prog = await this._linkFullAsync(src, parExt);
        if (prog) { tier = t; break; }
      }
      const ms = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now())) - t0);
      /* 一档都没升上去也要留痕：静默失败会让人以为是"地图坏了" */
      if (!prog) {
        this.upgrading = false;
        try {
          console.warn('[gl] 后台升级没有更优档位可用，维持「' + this.shaderTier + '」✗');
        } catch (e) { /* 忽略 */ }
        try { LOG.event('渲染升级', '没有更优档位，维持「' + this.shaderTier + '」'); } catch (e) { /* 忽略 */ }
        return false;
      }
      if (this.ctxLost) { try { gl.deleteProgram(prog); } catch (e) { /* 忽略 */ } this.upgrading = false; return false; }
      const old = this.prog;
      const oldVao = this.vao;
      this._installProgram(prog);
      try { if (old) gl.deleteProgram(old); } catch (e) { /* 忽略 */ }
      try { if (oldVao) gl.deleteVertexArray(oldVao); } catch (e) { /* 忽略 */ }
      this.shaderTier = tier;
      this.liteShader = (tier === 'lite');
      this.liteWhy = '';
      this._linkMs = ms;
      this.dirty = true;
      this.upgrading = false;
      try { console.log('[gl] 已后台升级着色器到「' + tier + '」（' + ms + ' ms）✓'); } catch (e) { /* 忽略 */ }
      return true;
    } catch (e) {
      this.upgrading = false;
      try { console.warn('[gl] 后台升级着色器失败（继续用当前档 ✓）：' + ((e && e.message) || e)); } catch (e2) { /* 忽略 */ }
      return false;
    }
  }

  /** 链接完整版；能并行就并行（轮询期间主线程是自由的），不能就同步
   *  @param {any} parExt 上层已经取过的 KHR_parallel_shader_compile（null = 没有，走同步）*/
  _linkFullAsync(fragSrc, parExt) {
    const gl = this.gl;
    const prog = gl.createProgram();
    if (!prog) return Promise.resolve(null);
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    const ext = parExt !== undefined
      ? parExt
      : ((gl.getExtension && gl.getExtension('KHR_parallel_shader_compile')) || null);
    if (!ext) {
      const ok = gl.getProgramParameter(prog, gl.LINK_STATUS);
      if (!ok) { try { gl.deleteProgram(prog); } catch (e) { /* 忽略 */ } return Promise.resolve(null); }
      return Promise.resolve(prog);
    }
    return new Promise((resolve) => {
      /* 轮询必须有个尽头
       *   有的驱动/浏览器 COMPLETION_STATUS_KHR 永远不置真 →
       *   这个 Promise 永不 resolve，upgrading 一直是 true → 后续每次升级都直接返回
       *   表现就是"停在最简边界、且一个字日志都没有"
       *   现在：20 秒还没好就放弃这一档（并留一条警告）*/
      const t0 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      const poll = () => {
        const el = ((typeof performance !== 'undefined' && performance.now)
          ? performance.now() : Date.now()) - t0;
        let done = true;
        try { done = !!gl.getProgramParameter(prog, ext.COMPLETION_STATUS_KHR); } catch (e) { done = true; }
        if (!done) {
          if (el > 20000) {
            try { console.warn('[gl] 并行编译 20 秒没完成，放弃这一档 ✓'); } catch (e) { /* 忽略 */ }
            try { gl.deleteProgram(prog); } catch (e) { /* 忽略 */ }
            resolve(null);
            return;
          }
          setTimeout(poll, 40);
          return;
        }
        let ok = false;
        try { ok = !!gl.getProgramParameter(prog, gl.LINK_STATUS); } catch (e) { ok = false; }
        if (!ok) { try { gl.deleteProgram(prog); } catch (e) { /* 忽略 */ } resolve(null); return; }
        resolve(prog);
      };
      setTimeout(poll, 40);
    });
  }

  lutXY(tid) {
    return [tid % this.lutW, Math.floor(tid / this.lutW)];
  }

  /* ============ 跑一遍"这台机器的纹理到底能不能采" ============
   *
   *  为什么要实测、不能信能力查询：
   *    HOI4 那台（Adreno 616）的图形体检里，R16UI 的 texelFetch 读回 0、
   *    R16UI 的数组纹理三层全是 0 —— 可 MAX_ARRAY_TEXTURE_LAYERS 报的是 2048
   *    能力查询说"有"，实际用起来是坏的，这种驱动只能拿真数据试出来
   *
   *  所以：建一张 8×8、3 层的 RG8 数组纹理，塞几个已知的双字节值，
   *  用一个 1×1 的离屏帧缓冲画一格、把采到的两个通道读回来比
   *    · 对得上 → arrOk = true，分块路径照常走
   *    · 对不上 → arrOk = false，setData 改走「整图缩小」那条（见 uProvScale）
   *
   *  用的是离屏 FBO，不碰主画布 —— 主画布这时候还没有地图，画上去只会闪一下
   *  任何一步出岔子都当成不支持（保守）：顶多把 id 图缩着传，画面糙一点，
   *    但不会白屏；反过来误判成支持，就是那台机器原样复发
   */
  _probeArrTex() {
    const gl = this.gl;
    glTexTouched();      // 下面这一串会用 0 号单元传测试纹理 → render 的账过期
    /* 三态：'ok' 实测通过 / 'bad' 实测读回不对 / 'unknown' 这次探测做不了
     *   —— 只有 'bad' 才改道（见 setData）
     *   探测本身做不成时不许判坏：宁可维持老行为（分块照走），
     *   也别因为"这台机器不支持离屏帧缓冲"就把画质无缘无故降一档
     *   （自检桩里的假 GL 就是这种情况：FBO 状态取不到，不能当成"驱动坏了"）*/
    const out = { ok: 'unknown', why: '' };
    let tex = null, fb = null, rb = null, prog = null;
    try {
      const S = 8, L = 3;
      /* 已知值：每层 (1,1) 格填入下面三组可分辨的双字节值 */
      const want = [[0x2C, 0x01], [0x91, 0x5B], [0x75, 0x75]];   // 300 / 23441 / 30069
      const data = new Uint8Array(S * S * L * 2);
      for (let l = 0; l < L; l++) {
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const i = ((l * S + y) * S + x) * 2;
            data[i] = want[l][0];
            data[i + 1] = want[l][1];
          }
        }
      }
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG8, S, S, L);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, S, S, L,
        gl.RG, gl.UNSIGNED_BYTE, data);

      /* 1×1 的离屏帧缓冲（RGBA8）—— 只画一格，只读一个像素 */
      rb = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, rb);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rb, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        out.why = '离屏帧缓冲建不起来';
        return out;
      }

      const vs = compile(gl, gl.VERTEX_SHADER, `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`);
      const fs = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uArr;
uniform int uLayer;
out vec4 o;
void main() {
  vec4 c = texelFetch(uArr, ivec3(1, 1, uLayer), 0);
  o = vec4(c.r, c.g, 0.0, 1.0);
}`);
      prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        out.why = '自检着色器链接失败';
        return out;
      }
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // 盖住整个 1×1
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      gl.useProgram(prog);
      gl.viewport(0, 0, 1, 1);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.uniform1i(gl.getUniformLocation(prog, 'uArr'), 0);
      const px = new Uint8Array(4);
      for (let l = 0; l < 3; l++) {
        gl.uniform1i(gl.getUniformLocation(prog, 'uLayer'), l);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (Math.abs(px[0] - want[l][0]) > 2 || Math.abs(px[1] - want[l][1]) > 2) {
          out.ok = 'bad';
          out.why = `第 ${l} 层读回 ${px[0]}/${px[1]}，应该是 ${want[l][0]}/${want[l][1]}`;
          return out;
        }
      }
      out.ok = 'ok';
      return out;
    } catch (e) {
      out.why = String((e && e.message) || e).slice(0, 120);
      return out;
    } finally {
      /* 收摊：把状态还回去（上下文这时还没开始画地图，但也别留垃圾）*/
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);
        if (tex) gl.deleteTexture(tex);
        if (rb) gl.deleteTexture(rb);
        if (fb) gl.deleteFramebuffer(fb);
        if (prog) gl.deleteProgram(prog);
        /* 清错误码必须有次数上限：
         *   自检桩的假 GL 上 getError 恒返回 1、NO_ERROR 也是 1（Proxy 给常数），
         *   写成 while(getError() !== NO_ERROR) 会死循环，整机卡在开图那一步 */
        for (let i = 0; i < 8; i++) {
          if (gl.getError() === gl.NO_ERROR) break;
        }
      } catch (e) { /* 忽略 */ }
    }
  }

  /* ============ 归一化编码的工具（见 FRAG 开头那段说明）============
   *
   *  Uint16Array 在小端内存里就是一个元素两个字节 { 低字节, 高字节 }
   *  而 RG8 的 R 通道排在前、G 在后 —— 两者逐字节同构
   *  所以上传时不用拆包、不用拷一份，按字节看直接喂给 GL 即可
   *  （省掉的那次 40MB 拷贝，正好是手机上最容易出事的量级）
   */
  static _bytesOf16(a, count) {
    if (!a) return null;
    if (a instanceof Uint8Array) return a;
    if (a instanceof Uint16Array) {
      return new Uint8Array(a.buffer, a.byteOffset, Math.min(a.length, count) * 2);
    }
    // 普通数组 / 类型不对的：老实转一份
    const out = new Uint8Array((count || a.length) * 2);
    const n = Math.min(a.length, count || a.length);
    for (let i = 0; i < n; i++) {
      const v = a[i] | 0;
      out[i * 2] = v & 255;
      out[i * 2 + 1] = (v >> 8) & 255;
    }
    return out;
  }

  /** 建一张 RG8 归一化的 2D 数组纹理（每层一块 = 每层一块省份 id），并上传第 0 层 */
  makeTileArray(tileW, tileH, layers, first) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    glTexTouched();      // 绑在"当前单元"上 → render 的账过期
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG8, tileW, tileH, layers);
    if (first) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, tileW, tileH, 1,
        gl.RG, gl.UNSIGNED_BYTE, MapRenderer._bytesOf16(first, tileW * tileH));
    }
    return tex;
  }

  /**
   * 从整张 id 数组里切一块、传给数组纹理的第 (r, c) 块（合成切块专用）
   *
   *  传过的直接返回 false（uploadedTiles 去重）—— 帧循环每帧都会问一遍，
   *    不去重的话每帧白切 10MB 内存 + 白传一次
   *  右/下边缘不足一块的地方补 0（= 无省份）
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

  /** 把某一块上传到数组纹理的第 layer 层（RG8 归一化，见上面 _bytesOf16） */
  uploadTile(layer, data) {
    const gl = this.gl;
    if (!this.provArrTex || !this.tileInfo) return false;
    if (!data) return false;
    const _t0 = performance.now();
    const n = this.tileInfo.tileW * this.tileInfo.tileH;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.provArrTex);
    glTexTouched();      // 传块每帧都可能来一次 → 这条必须有（否则第 12 号单元那本账会错）
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer,
      this.tileInfo.tileW, this.tileInfo.tileH, 1,
      gl.RG, gl.UNSIGNED_BYTE, MapRenderer._bytesOf16(data, n));
    this.uploadedTiles.add(layer);      // 传成功了才记（早退 false 的那条路不算）
    this.dirty = true;
    /* 性能指标（app.js 的 PERF）：这里只累加，frameBody 每帧读走并清零
     *   合成切块 / tiles.json / 悬停拉块三条路都汇到这一个出口，量一处就够 */
    this._perfTileMs = (this._perfTileMs || 0) + (performance.now() - _t0);
    return true;
  }

  /**
   * 把整张 id 图按块传进数组纹理
   * 用在"设备上限装不下整图、按需就地切块"这条路上（没有 tiles.json，数据全在内存里）。
   * 带 tiles.json 的按视野逐块喂，不走这里
   */
  uploadAllTiles(ids, layout) {
    const m = this.meta;
    const buf = new Uint16Array(layout.tileW * layout.tileH);
    const at = (a, b) => (ids.subarray ? ids.subarray(a, b) : ids.slice(a, b));
    for (let r = 0; r < layout.rows; r++) {
      for (let c = 0; c < layout.cols; c++) {
        const x0 = c * layout.tileW;
        const y0 = r * layout.tileH;
        buf.fill(0);                       // 右/下边缘不足一块的地方补 0（= 无省份）
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

  /* ===================== 国旗（剪贴蒙版）=========================
   *  给一个色块贴一张旗，旗面拉满它的外接框，被国土形状裁掉 —— 剪贴蒙版
   *
   *  三张纹理：
   *    · flagIdxTex   R8      pid → 旗号（0 = 没旗），换贴旗时重建
   *    * flagSlotTex  RGBA32F 每面旗两格：矩形 / 图集 uv，拖拽时只重传这一张
   *    · flagTexArr   RGBA8 数组纹理，一层一面旗（1024²/层），不封顶
   *
   *  数据存在渲染器上（this._flagMask 等）—— 上下文丢失重建后要原样重传，
   *     否则切个后台回来旗子就没了
   */

  /** 每省一个旗号（Uint8Array(numProvinces)，0 = 没旗）换旗才重传 */
  setFlagMask(mask) {
    this._flagMask = mask || null;
    this._uploadFlagMask();
    this.dirty = true;
  }

  /** 每面旗的 矩形 / uv / 层号（Float32Array(4*N*3)）拖拽时每帧都可能重传 */
  setFlagSlots(slots) {
    this._flagSlots = slots || null;
    this._uploadFlagSlots();
    this.flagOn = (this._flagSlots && this._flagSlots.length >= 12 && this.flagTexArr) ? 1 : 0;
    this.dirty = true;
  }

  /** 每面旗一层（canvas 数组，1024²）加减旗 / 换图时重传 */
  setFlagLayers(layers) {
    this._flagLayers = layers || null;
    this._uploadFlagLayers();
    this.flagOn = (this._flagSlots && this._flagSlots.length >= 12 && this.flagTexArr) ? 1 : 0;
    this.dirty = true;
  }

  clearFlags() {
    this._flagMask = null;
    this._flagSlots = null;
    this.flagOn = 0;
    this.dirty = true;
  }

  _uploadFlagMask() {
    const gl = this.gl;
    if (this.flagIdxTex) { try { gl.deleteTexture(this.flagIdxTex); } catch (e) { /* 忽略 */ } this.flagIdxTex = null; }
    if (!this._flagMask) return;
    const n = this._flagMask.length;
    const lim = this.maxTex || gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const W = Math.max(1, Math.min(n, Math.min(lim, 4096)));
    const H = Math.max(1, Math.ceil(n / W));
    const buf = new Uint8Array(W * H);
    buf.set(this._flagMask);
    this.flagIdxW = W;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    glTexTouched();      // 绑在"当前单元"上 → render 的账过期
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, buf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.flagIdxTex = tex;
  }

  _uploadFlagSlots() {
    const gl = this.gl;
    if (this.flagSlotTex) { try { gl.deleteTexture(this.flagSlotTex); } catch (e) { /* 忽略 */ } this.flagSlotTex = null; }
    if (!this._flagSlots) return;
    const n = this._flagSlots.length / 4;      // 每格 4 个数
    const W = Math.max(1, Math.min(n, 64));
    const H = Math.max(1, Math.ceil(n / W));
    const buf = new Float32Array(W * H * 4);
    buf.set(this._flagSlots.slice(0, W * H * 4));
    this.flagSlotW = W;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    glTexTouched();      // 绑在"当前单元"上 → render 的账过期
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, buf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.flagSlotTex = tex;
  }

  /** 一层一面旗的数组纹理（不封顶：贴多少面就多少层）
   *
   *  每层固定 1024²（RGBA8，约 4 MB + 三分之一 mipmap）——
   *    小旗也占一层，图省事；层数由 app 侧的旗子数量决定
   *  重传是"整张重建"：加减旗 / 换图都不频繁，重建一次几百毫秒，换来代码简单
   */
  _uploadFlagLayers() {
    const gl = this.gl;
    if (this.flagTexArr) { try { gl.deleteTexture(this.flagTexArr); } catch (e) { /* 忽略 */ } this.flagTexArr = null; }
    const L = this._flagLayers;
    if (!L || !L.length) return;
    const S = L[0].width || 1024;
    const levels = Math.floor(Math.log2(S)) + 1;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    glTexTouched();      // 绑在"当前单元"上 → render 的账过期
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, S, S, L.length);
    for (let i = 0; i < L.length; i++) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, S, S, 1,
        gl.RGBA, gl.UNSIGNED_BYTE, L[i]);
    }
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.flagTexArr = tex;
  }

  async setData({ provinceIds, titlemap, colors, tiles }) {
    const gl = this.gl;
    const m = this.meta;

    // 诊断：纹理要多大、数据实际多长，只写进控制台（别上屏 ——
    // 正常走老路的地图也会经过这里，红框会把成品弄脏）
    {
      const need = m.mapWidth * m.mapHeight;
      const have = provinceIds ? provinceIds.length : -1;
      console.log(`provTex: 需要 ${need} (${m.mapWidth}×${m.mapHeight}), `
        + `数据 ${have}, tiles=${tiles ? 'yes' : 'no'}`);
    }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    // 走分块时不建整图纹理：16384×8192 的 RG8 要 268MB 显存，
    // 且 uUseTiles=1 时这一路不会被采样，放一张 1×1 占位即可。
    if (!tiles && provinceIds && provinceIds.length !== m.mapWidth * m.mapHeight) {
      // 宁可吵一声也别静默出一张白图  —— 这一条就是今天白屏的根因：
      // 数据对不上尺寸时 WebGL 只报一个 INVALID_OPERATION，画面却是全白。
      throw new Error(`省份 id 图和地图尺寸对不上：数据 ${provinceIds.length} 个，`
        + `需要 ${m.mapWidth * m.mapHeight} 个（${m.mapWidth}×${m.mapHeight}）`
        + `，而且没传分块清单 tiles ✗`);
    }
    // 装不下就当场切块，不依赖 tiles.json（单文件版没有该清单）。
    // 切块复用渲染器已有的分块通路（TEXTURE_2D_ARRAY），着色器 / 拾取 / 涂色均无需改动；
    // 仅在设备上限装不下整图时生效，桌面端行为不变。
    let layout = tiles || null;
    if (!layout && provinceIds) {
      const lim = this.maxTex || gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (m.mapWidth > lim || m.mapHeight > lim) {
        /* 块尺寸按"总显存最小"挑，不贴着上限开。
         *   贴上限开时，5632×2048 会切成两块 4096×4096：每层 33MB、两层 67MB，
         *   再加 CPU 侧缓冲与省份数据，手机显存直接见底，
         *   表现为上下文丢失、纹理损坏、画面全黑。
         *   桌面上限 16384 > 图宽，不走这条路，故桌面上测不出来。
         *   pickTileLayout 取总字节最小的一组：CK3 9216×4608 只需 8 块 ≈ 85MB（= 整图大小）。
         *   切块后不再一次全传，由帧循环按视野逐块补（见 app.js 的懒上传）。
         */
        layout = pickTileLayout(m.mapWidth, m.mapHeight, lim);
        /* 数组纹理实测采不出来时整条改道（见 _probeArrTex）。
         *   Adreno 那类驱动上分块数组纹理三层全读回 0，而贴图上限 4096 < 5632，
         *   必须切块、切块又全靠数组纹理 → 该路径走不通。
         *   退路：把 id 图缩着传，scale = ceil(最大边 / 上限)，缩小后单张 2D 即可装下
         *   （5632×2048 → 2048×1024，显存更省），省界会粗一格，但地图仍可看、可涂、可悬停。
         *   只在实测读回不对（'bad'）时改道；探测做不成或正常设备不动。
         */
        if (this.arrOk === 'bad' && provinceIds) {
          const sc = Math.max(1, Math.ceil(Math.max(m.mapWidth, m.mapHeight) / lim));
          const sw = Math.max(1, Math.floor(m.mapWidth / sc));
          const sh = Math.max(1, Math.floor(m.mapHeight / sc));
          const small = new Uint16Array(sw * sh);
          /* 每格取块中心那一格的值（取角上会让边界整体偏半块）*/
          const half = (sc - 1) >> 1;
          for (let y = 0; y < sh; y++) {
            const sy = Math.min(m.mapHeight - 1, y * sc + half);
            const src = sy * m.mapWidth;
            const dst = y * sw;
            for (let x = 0; x < sw; x++) {
              small[dst + x] = provinceIds[src + Math.min(m.mapWidth - 1, x * sc + half)] || 0;
            }
          }
          layout = null;
          this.provScale = sc;
          this.provSmall = { w: sw, h: sh };
          this._smallIds = small;
          console.log(`[gl] 数组纹理采不出来（${this.arrWhy}）→ id 图缩 ${sc} 倍传：`
            + `${sw}×${sh}（原 ${m.mapWidth}×${m.mapHeight}）`);
          try {
            if (typeof bootMark === 'function') {
              bootMark('id图缩' + sc + '倍' + sw + '×' + sh);
            }
          } catch (e) { /* 忽略 */ }
        } else {
          const _mb = (layout.cols * layout.rows * layout.tileW * layout.tileH * 2 / 1048576).toFixed(0);
          console.log(`贴图上限 ${lim}px 装不下 ${m.mapWidth}×${m.mapHeight}`
            + ` → 就地切成 ${layout.cols}×${layout.rows} 块（每块 ${layout.tileW}×${layout.tileH}，约 ${_mb}MB）`);
          /* 同时写进启动里程，便于在设备上确认走了哪条路 */
          try {
            if (typeof bootMark === 'function') {
              bootMark('切块' + layout.cols + '×' + layout.rows + ' 每块' + layout.tileW + '×' + layout.tileH + ' 约' + _mb + 'MB');
            }
          } catch (e) { /* 忽略 */ }
        }
      }
    }

    this.provTex = layout
      ? makeTexture(gl, 1, 1, gl.RG8, gl.RG, gl.UNSIGNED_BYTE,
                    new Uint8Array([0, 0]), gl.NEAREST)
      : (this._smallIds
        ? makeTexture(gl, this.provSmall.w, this.provSmall.h, gl.RG8, gl.RG, gl.UNSIGNED_BYTE,
                      MapRenderer._bytesOf16(this._smallIds, this.provSmall.w * this.provSmall.h),
                      gl.NEAREST)
        : makeTexture(gl, m.mapWidth, m.mapHeight, gl.RG8, gl.RG, gl.UNSIGNED_BYTE,
                      MapRenderer._bytesOf16(provinceIds, m.mapWidth * m.mapHeight), gl.NEAREST));

    // 分块路径：数据目录带了 tiles.json  或者上面就地切了块
    this.tileInfo = layout || null;
    this.useTiles = layout ? 1 : 0;
    // 「id 图缩着传」那条（数组纹理不可用，见上面 arrOk 一段）——
    //   uProvScale 由 render() 每帧传；未走该路径时恒为 1
    this.provScale = this.provScale || 1;
    if (!this._smallIds) this.provScale = 1;
    /* 就地切块时保留整张 id 数组的引用（不复制，零额外内存），
     *   由帧循环按视野逐块切、逐块传；一次全传会让 CK3 那张占 120MB 显存并丢失上下文 */
    this.synthIds = (layout && layout.synthetic) ? provinceIds : null;
    // 数组纹理刚重建（每层都是占位 0）→ 上传记录清空
    // （synthetic 就地切块不受影响：随后 uploadAllTiles 会逐块传、逐块记）
    this.uploadedTiles.clear();
    if (layout) {
      const first = new Uint16Array(layout.tileW * layout.tileH);
      this.provArrTex = this.makeTileArray(layout.tileW, layout.tileH,
        layout.cols * layout.rows, first);
      // 就地切块只先传视野中央那一块，保证第一帧不空白，其余由帧循环按视野补
      // （带 tiles.json 的路径同样按视野逐块喂给 uploadTile）
      if (layout.synthetic) {
        this.uploadSyntheticTile(Math.floor(layout.rows / 2), Math.floor(layout.cols / 2));
      }
    } else {
      // 没有分块数据时也建一张 1×1 数组纹理：采样器指向不完整纹理会报错，
      // 即使这一路未被采样。uUseTiles 仍为 0。
      const one = new Uint16Array(1);
      this.provArrTex = this.makeTileArray(1, 1, 1, one);
    }

    // 归属表拍平成一维（索引 = 层级 × 省份数 + 省份）。
    // 按二维（省份数 × 层级数）存会超 MAX_TEXTURE_SIZE —— 维多利亚3 有 4 万多个省份。
    const total = titlemap.length;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.titleMapW = Math.max(1, Math.min(maxTex, 4096, total));
    const tmRows = Math.max(1, Math.ceil(total / this.titleMapW));
    const flat = new Uint16Array(this.titleMapW * tmRows);
    flat.set(titlemap);
    this.titleTex = makeTexture(gl, this.titleMapW, tmRows, gl.RG8,
      gl.RG, gl.UNSIGNED_BYTE,
      MapRenderer._bytesOf16(flat, this.titleMapW * tmRows), gl.NEAREST);

    /* 上下文恢复时会再调一次本函数（见 onContextRestored）——
     *   lutData / paintData 里是已涂好、调好的内容，重建会全部抹掉。
     *   尺寸对得上就保留，只标脏等待重传；纹理本身照旧重建（旧的随上下文作废）。
     */
    this.lutH = Math.max(1, Math.ceil(m.numTitles / this.lutW));
    const _lutLen = this.lutW * this.lutH * 4;
    if (this.lutData && this.lutData.length === _lutLen) {
      this.lutDirty = true;                 // 内容还在，重传即可
    } else {
      this.lutData = new Uint8Array(_lutLen);
      for (let i = 0; i < m.numTitles; i++) {
        const c = colors[i] || [0, 0, 0];
        this.lutData[i * 4] = c[0];
        this.lutData[i * 4 + 1] = c[1];
        this.lutData[i * 4 + 2] = c[2];
        // alpha 通道用作荒地标记（setWasteland 按 meta.wasteland 置 255），
      // 默认 0 = 非荒地；没有其他读取方。
      this.lutData[i * 4 + 3] = 0;
      }
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.colorTex = makeTexture(gl, this.lutW, this.lutH, gl.RGBA8,
      gl.RGBA, gl.UNSIGNED_BYTE, this.lutData, gl.NEAREST);

    // 手绘层：一省一格。纹理需拍平：宽度压在显卡上限内，
    // 维多利亚3 四万多个省份按 numProvinces 宽建纹理传不上去（上限常见 16384），
    // 表现为填色无反应。JS 侧仍按省份下标访问（pid*4），仅上传时拍平成二维。
    this.paintW = Math.max(1, Math.min(maxTex, 4096, this.numProvinces));
    this.paintRows = Math.max(1, Math.ceil(this.numProvinces / this.paintW));
    // 笔迹同理：保留数据（重建会清掉已涂内容）
    if (this.paintData && this.paintData.length === this.numProvinces * 4) {
      this.paintDirty = true;               // 重传在 flushPaint() 里
    } else {
      this.paintData = new Uint8Array(this.numProvinces * 4);
    }
    this.paintFlat = new Uint8Array(this.paintW * this.paintRows * 4);
    this.paintTex = makeTexture(gl, this.paintW, this.paintRows, gl.RGBA8,
      gl.RGBA, gl.UNSIGNED_BYTE, this.paintFlat, gl.NEAREST);

    // 手绘层的标记编号：描边要区分同色不同标记，颜色表已占满
    // （RGB 是颜色、alpha 是涂没涂），故单开一张表，一省一格。
    // RG8 归一化（16 位拆两个字节，见 FRAG 开头一段）
    if (this.paintLabelData && this.paintLabelData.length === this.numProvinces) {
      this.paintDirty = true;
    } else {
      this.paintLabelData = new Uint16Array(this.numProvinces);
    }
    this.paintLabelFlat = new Uint16Array(this.paintW * this.paintRows);
    this.paintLabelTex = makeTexture(gl, this.paintW, this.paintRows, gl.RG8,
      gl.RG, gl.UNSIGNED_BYTE,
      MapRenderer._bytesOf16(this.paintLabelFlat, this.paintW * this.paintRows), gl.NEAREST);

    /* 悬停编组表（"同一片海"）—— 与 paintLabel 同一套拍平写法。
     *   必须建、必须绑：采样器指向不完整纹理会令整个 program 非法
     *   （手机黑屏的根因，见 uBorderDepth 一段）。
     *   内容保留：上下文丢失重建时无需重算，重传即可，与笔迹同等处理。
     */
    if (this.hoverGroupData && this.hoverGroupData.length === this.numProvinces) {
      this.hoverGroupDirty = true;         // 内容还在，重传在 flushPaint() 里
    } else {
      this.hoverGroupData = new Uint16Array(this.numProvinces);
      this.hoverGroupTier = null;          // 表没了 → 下次悬停按当前层重建
    }
    this.hoverGroupFlat = new Uint16Array(this.paintW * this.paintRows);
    this.hoverGroupTex = makeTexture(gl, this.paintW, this.paintRows, gl.RG8,
      gl.RG, gl.UNSIGNED_BYTE,
      MapRenderer._bytesOf16(this.hoverGroupFlat, this.paintW * this.paintRows), gl.NEAREST);

    /* 身份标纹理（每 pid 一格：1 陆地 / 2 海 / 3 湖 / 4 河 / 5 不可通行海域 /
     *   6 不可通行）—— 与 hoverGroup 同一套拍平写法。
     *   必须建、必须绑：采样器指向不完整纹理会令整个 program 非法。
     *   内容全 0（旧包或未灌入）时 uKindOn = 0，着色器整条让开。
     *   上下文丢失重建时内容保留，重传即可。
     */
    if (!(this.kindData && this.kindData.length === this.numProvinces)) this.kindData = null;
    this.kindFlat = new Uint8Array(this.paintW * this.paintRows);
    this.kindTex = makeTexture(gl, this.paintW, this.paintRows, gl.R8,
      gl.RED, gl.UNSIGNED_BYTE, this.kindFlat, gl.NEAREST);
    this.kindDirty = true;
    /* 「水域 · 边界」表（每 pid 一格：0 = 非水 / 2..5 = 四类水域）
     *   必须建、必须绑：采样器指向不完整纹理会令整个 program 非法。
     *   内容全 0（旧包或未灌入）→ 着色器的 waterIs 恒 false，
     *   水域通道与两条让位一起退化，行为与未加该功能时一致。
     *   与 kindTex 形状相同、判据同源，但不是同一张：
     *     kindMask 表示"这一格最底层是什么"（含陆地 1 / 荒地 6）；
     *     这张表示"能否认出是水"（认水走 waterKindByPid，
     *       旧包无 kindMask 时退回 `#` 开头的键前缀）。
     */
    if (!(this.waterKindData && this.waterKindData.length === this.numProvinces)) {
      this.waterKindData = null;
    }
    this.waterKindFlat = new Uint8Array(this.paintW * this.paintRows);
    this.waterKindTex = makeTexture(gl, this.paintW, this.paintRows, gl.R8,
      gl.RED, gl.UNSIGNED_BYTE, this.waterKindFlat, gl.NEAREST);
    this.waterKindDirty = true;
    /* 七行里的五行类色（2..6 → 海 / 湖 / 河 / 不可通行海域 / 不可通行）
     *   出厂值取自 build_data.py 的类色表，开图后由 app.js 按设置覆盖
     */
    this.natureFlat = this.natureFlat || new Float32Array([
      32 / 255, 57 / 255, 92 / 255,        // 2 海洋
      47 / 255, 110 / 255, 150 / 255,      // 3 湖泊
      62 / 255, 136 / 255, 181 / 255,      // 4 河流
      26 / 255, 46 / 255, 71 / 255,        // 5 不可通行海域
      94 / 255, 94 / 255, 94 / 255,        // 6 不可通行区域
    ]);
    /* 换图 / 首次上传：这一组整段重发（见 render() 里 uNature 一段）*/
    this.natureDirty = true;

    /* 上传后复查上下文：低端机 / 手机在 texImage2D 这批调用里耗尽显存时，
     *   上下文会静默丢失 —— 调用全部"成功"返回，显存里却什么都没有，画面空白。
     *   不在此处拦截，界面上表现为"打开是白的、日志却无错"。
     */
    if (this.ctxLost || (gl.isContextLost && gl.isContextLost())) {
      _setupFail('context-lost', '上传地图数据时 WebGL 上下文丢失', gl,
        { stageAt: 'setData' });
    }
    this.dirty = true;
  }

  /** 灌入底层身份标（meta.kindMask 解出的 Uint8Array，每 pid 一字节）
   *
   *  长度对不上或传 null → 视作"没有这枚标"（uKindOn = 0），行为与旧包一致。
   *  只标脏：真正上传在 flushPaint() 里一趟做完（draw() 每帧都调它）。
   */
  setKindMask(bytes) {
    this.kindData = (bytes && this.numProvinces && bytes.length >= this.numProvinces)
      ? bytes : null;
    this.kindDirty = true;
    this.dirty = true;
  }

  /** 灌入「能否认出是水」表（每 pid 一字节：0 = 非水 / 2..5 = 四类水域）
   *
   *  长度对不上或传 null → 视作"这张图算不出水陆"（waterIs 恒 false），
   *    水域通道与两条让位一起让开，行为与旧包一致。
   *  只标脏：真正上传在 flushPaint() 里一趟做完（draw() 每帧都调它）。
   */
  setWaterKindMask(bytes) {
    this.waterKindData = (bytes && this.numProvinces && bytes.length >= this.numProvinces)
      ? bytes : null;
    this.waterKindDirty = true;
    this.dirty = true;
  }

  /** 七行里的五行类色（[海, 湖, 河, 不可通行海域, 不可通行]，各 [r,g,b] 0~255）
   *
   *  着色器按底层身份直接给这几类上色（见 kindOf / natureColor），
   *  因此改设置只改这几个 uniform，下一帧生效，无需重新烤包。
   *  陆地不在其中（走 LUT 头衔色 / 无主兜底）。
   */
  setNatureColors(list) {
    if (!list || list.length < 5 || !this.natureFlat) return;
    for (let i = 0; i < 5; i++) {
      const c = list[i] || [0, 0, 0];
      this.natureFlat[i * 3] = (c[0] || 0) / 255;
      this.natureFlat[i * 3 + 1] = (c[1] || 0) / 255;
      this.natureFlat[i * 3 + 2] = (c[2] || 0) / 255;
    }
    this.natureDirty = true;
    this.dirty = true;
  }

  /** 改 LUT 里的一个像素。只写内存，真正上传在 flushLut() 里一次做完 */
  /**
   * 多级边界链：list = [{tier, width, show, alpha}, …]（顺序不限）。
   * 同时把旧的 parent* 字段同步为链上第一条，兼容旧调用与测试。
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

  /** 兼容接口：只设一条 */
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
    glTexTouched();      // 绑在"当前单元"上 → render 的账过期
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
   * 手绘层：记录该省份的标记编号（0 = 未涂）。
   * 描边靠它区分"同色但不同标记"的两块 —— 只看颜色时两者之间不会画线。
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
    /* 每次绑定都要通知纹理账本 —— 五段上传都绑在"当前单元"上，
     *   漏一处会让下一帧沿用错误的绑定记录（见 GL_TEX_EPOCH）
     */
    if (this.paintDirty) {
      // 上传前拍平（按省份的连续内存 → 宽度受限的二维）
      this.paintFlat.set(this.paintData);
      this.paintLabelFlat.set(this.paintLabelData);
      gl.bindTexture(gl.TEXTURE_2D, this.paintTex);
      glTexTouched();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
        gl.RGBA, gl.UNSIGNED_BYTE, this.paintFlat);
      gl.bindTexture(gl.TEXTURE_2D, this.paintLabelTex);
      glTexTouched();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
        gl.RG, gl.UNSIGNED_BYTE,
        MapRenderer._bytesOf16(this.paintLabelFlat, this.paintW * this.paintRows));
      this.paintDirty = false;
    }
    /* 身份标（换图才动一次，每 pid 一字节 ≈ 29 KB）——
     *   旧包（无此标）传全 0 → 着色器 uKindOn = 0 让开 */
    if (this.kindDirty) {
      if (this.kindData) this.kindFlat.set(this.kindData);
      else this.kindFlat.fill(0);
      gl.bindTexture(gl.TEXTURE_2D, this.kindTex);
      glTexTouched();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
        gl.RED, gl.UNSIGNED_BYTE, this.kindFlat);
      this.kindDirty = false;
    }
    /* 水域表（换图才动一次，与身份标同一套）——
     *   旧包 / 认不出水 → 传全 0 → 着色器 waterIs 恒 false，整条让开 */
    if (this.waterKindDirty) {
      if (this.waterKindData) this.waterKindFlat.set(this.waterKindData);
      else this.waterKindFlat.fill(0);
      gl.bindTexture(gl.TEXTURE_2D, this.waterKindTex);
      glTexTouched();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
        gl.RED, gl.UNSIGNED_BYTE, this.waterKindFlat);
      this.waterKindDirty = false;
    }
    /* 悬停编组表换层才动一次（EU5 约 40 KB，每帧传是白耗）*/
    if (this.hoverGroupDirty && this.hoverGroupData) {
      this.hoverGroupFlat.set(this.hoverGroupData);
      gl.bindTexture(gl.TEXTURE_2D, this.hoverGroupTex);
      glTexTouched();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paintW, this.paintRows,
        gl.RG, gl.UNSIGNED_BYTE,
        MapRenderer._bytesOf16(this.hoverGroupFlat, this.paintW * this.paintRows));
      this.hoverGroupDirty = false;
    }
  }

  /**
   * 旧包的"同一片海"编组 —— 每层一片的包出现后，此表只剩兜底用途。
   *
   *  每层一片的包里，同一片 = 当前层那个 tid（`#sea_pr_57` 那种），
   *  悬停段直接把 tid 交给着色器（uHoverTid，见 app.js 的 applyHoverHighlight），
   *  整套编组表用不上。
   *
   *  但每层一片之前的包（packs 里仍在发布的几张）中，全世界的海共用一个 `#sea`，
   *  tid 相同 —— 按 tid 亮会让全世界的海一起亮，按 pid 又只能亮一格。
   *  因此保留：非"每层一片"的键才走这一条（app.js 靠 isTierPieceKey 分流）。
   *
   *  做法：按当前视图层的水域名表给每片海编号，同名 = 同一组。
   *   · 表来源与海名标签完全一致（app.js 的 buildSeaLabelPoints）：
   *     seaNamesByTier[this.tier]，该层为空则退回 meta.seaNames（合并口径），
   *     地图上标着"波罗的海"的整片海，悬停时也整片一起亮。
   *   · 荒地一并处理：meta.wastelandNames 不分层，不随换层变化。
   *   · 组号：1..N = 海，N+1.. = 荒地，0 = 不属于任何一片；
   *     0 的那批仍走"只亮光标底下这一块"（旧包 / CK3 无水名表，行为不变）。
   *   · 用 Uint16 而非 Uint8：EU5 最细层有 3635 片海，8 位装不下。
   *   · 只在换层时重建（毫秒级）；每次划过一格都重建会每帧传几十 KB。
   */
  rebuildHoverGroups() {
    /* 编组跟"编辑层"走，不是"视图层"。
     *   取 this.tier（视图层）时，剧本模式里 tier 停在剧本层（0~2），
     *   seaNamesByTier[剧本层] 为 null → 退回 meta.seaNames（合并口径 = 最粗层）
     *   → 整片海一起亮。
     *   期望口径与无主地一致：不开粒度就是最低层，开粒度就跟随粒度；
     *   项目里对应的接口是 editTier()：
     *     · 未换粒度 → editTier() == 最细层 → 海域组 = 最细层的一片（基本就是一块）
     *     · 换了粒度 → editTier() 即所选层 → 跟随它
     *   与普通地块 / 无主地的高亮同一口径（它们都在 applyHoverHighlight 里
     *   用 editTier() 取 tid）。
     *   setEditTier() 无需手动失效：下面 hoverGroupIdOf 每次都比层号。
     */
    const tier = this.editTier | 0;
    this.hoverGroupTier = tier;
    const n = this.numProvinces | 0;
    const meta = this.meta || {};
    const bt = meta.seaNamesByTier;
    /* 该层为 null = 这一层没有名字（每个水域按游戏内容命名；
     *   HOI4 的省份级水域与地区级是同一个东西，只是没有名字）。
     *   → 不退回 meta.seaNames（那是最粗层的口径，拿它填细层等于拿别层名字充数，
     *     编组也会跟着编错）。
     *   判据与 app.js 的 waterNameTable 同一套（两处都要改；
     *     gl.js 是独立模块、拿不到该函数，故照抄这三行）。
     *   只有压根没有分层表（或它比层数还短 = 旧包）才退回 meta.seaNames。
     */
    const _nT = (meta.tiers && meta.tiers.length) || 0;
    const _hasBt = Array.isArray(bt) && _nT > 0 && bt.length >= _nT;
    const tbl = _hasBt ? (bt[tier] || null) : meta.seaNames;
    const wl = meta.wastelandNames;
    const ids = new Uint16Array(n);
    if (tbl || wl) {
      let next = 1;
      /* 海先编、荒地后编，且已归组的地块不再改（ids[pid] 非 0 就跳过）。
       *   两张表理论上不重叠（水 / 荒地是两类地），真重叠时以海为准。
       */
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
   * 该地块属于哪一片海 / 荒地（0 = 不属于任何一片）—— 悬停段（app.js）每换一格问一次。
   * 换层后懒重建（第一次悬停时算，不占切层的帧）。
   * 新包（每层一片）不会问到这儿：那边同一个 tid 就是同一片。
   * 只有旧包、以及最细层逐块的荒地（`wl_<地块号>`）才走这条。
   */
  hoverGroupIdOf(pid) {
    if (!pid || pid >= this.numProvinces) return 0;
    // 比较的是编辑层（与 rebuildHoverGroups 里取的必须一致，见该处注释）
    if (this.hoverGroupTier !== (this.editTier | 0) || !this.hoverGroupData) this.rebuildHoverGroups();
    return this.hoverGroupData[pid] || 0;
  }

  setTier(t) { this.tier = t; this.dirty = true; }

  /**
   * 边界和悬停看哪一层。
   *
   * 年份视图（1444/1618/1800）下允许与 uTier 分开：颜色仍是那年的归属色，
   * 但边界画到地区/省份的接缝上、悬停高亮也按那一级 —— 于是可以"看着 1444
   * 的政治地图，按省份去改"。不换粒度时传入的就是 tier，行为不变。
   */
  setEditTier(t) { this.editTier = t; this.dirty = true; }
  setFineTier(t) { this.fineTier = t; this.dirty = true; }
  setShowTitles(v) { this.showTitles = !!v; this.dirty = true; }
  setShowPaint(v) { this.showPaint = !!v; this.dirty = true; }

  /**
   * 标出哪些头衔是"荒地（不可通行）"：借用 LUT 的 alpha 通道，
   * 荒地 = 255，其余 = 0。该通道没有其他读取方（输出 alpha 由着色器另算），
   * 因此无需额外纹理，一次取样即可判定。
   *
   * 荒地始终显示 applyNatureColors() 里「不可通行区域」那一行的颜色，不随视图变化。
   * 着色器须在 tid == NONE 的早退之前查这个标记，否则剧本层荒地
   * 会被 uUnpainted(150) 覆盖。
   * 与 setWasteland 写法相同，后者已无调用方。
   *
   * @param {Iterable<number>} tids 固定显示自身颜色的头衔（全部荒地节点）
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
   * 导出前临时关闭悬停高亮（导出的图里会莫名亮一块）。
   *
   *  高亮是画在着色器里的（mix 到白 0.30），不是叠加半透明框，
   *  因此只要鼠标停在图上，那一块就会被提亮进 PNG。
   *  这里把几个悬停量清零，返回恢复函数；调用方导出完必须调用它。
   *  只动"高亮"这一路：悬停卡片、取色走 state，不受影响。
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
    this.hoverTid = this.noTitle;      // NONE → 着色器那几路全不命中
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
    if (this.hoverTid === v) return;        // 未变化就不标脏（见 setHoverState 的说明）
    this.hoverTid = v;
    this.dirty = true;
  }

  /**
   * 悬停高亮那一组值整体设置一次，与上一帧完全相同则不重画。
   *
   * 需要比较的原因：高亮画在着色器里（不是叠加透明框），
   * "换高亮"= 整张图重跑一遍 fragment shader；
   * 而鼠标划动时每换一格都会走到这儿 —— 划过一整片海、或划过
   * 大国的许多省份时，高亮范围其实没变（还是那一片 / 还是那个国家）。
   * setHover() 无条件置脏时，每个 mousemove 都会白渲染一整张图。
   *
   * 第 6 个参数是「同一片海」的组号（0 = 未编组，照旧只亮一格）；
   * 旧的 5 参调用仍然可用（缺省为 0，行为不变）。
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

  /** 边界深度图（CPU 侧算好，见 app.js 的 buildBorderDepth）
   *  R8 归一化，每格 1 字节 = 四路各 2 位等级（0 压在边界上 · 1 紧邻 · 2 更远）
   *  NEAREST：整数枚举，插值无意义
   *  与 uProv / uTitleMap 同为 texelFetch 取样，不引入新写法
   */
  setBorderDepth(dist, w, h) {
    const gl = this.gl;
    /* 先确认这张卡装得下 —— 手机 MAX_TEXTURE_SIZE 常为 4096，而地图宽 5632。
     *   超限时 texImage2D 只置错误码、不抛异常，纹理是坏的，后续全乱；
     *   → 索性不上传：borderDepthOn 保持 false，着色器 on = 0，退回射线，结果正确。
     *   拿不到上限时按 16384 算，不因读不到参数而关闭功能。
     */
    const _maxTex = (gl.getParameter && gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 16384;
    if (w > _maxTex || h > _maxTex) {
      this.borderDepthOn = false;
      this.dirty = true;
      return;
    }
    if (this.borderDepthTex) gl.deleteTexture(this.borderDepthTex);
    /* 等级图：R8 归一化，每格 1 字节 = 四路各 2 位（0 压在边界上 · 1 紧邻 · 2 更远）
     *   离边界 2 格与 3 格没有区别，都不画，2 位足够。
     *   它只用于排除（这一路是否细算）；画线仍走边掩码（那里才有方向 / 亚格精度）。
     *   NEAREST：等级是枚举，插值无意义。
     */
    /* 用归一化 R8 而非 R8UI：整数纹理上传在某些驱动上走格式转换的慢路，
     *   归一化 R8 是各家的最快路径；代价是 texelFetch 得到 0~1 浮点，
     *   着色器里 ×255 还原。
     */
    this.borderDepthTex = makeTexture(gl, w, h, gl.R8, gl.RED, gl.UNSIGNED_BYTE, dist, gl.NEAREST);
    this.borderDepthW = w;       // 改参数名时必须同步函数体：名字写错会抛 ReferenceError，纹理传不上去
    this.borderDepthH = h;       // （上传是异步的，同步断言抓不到这类错）
    this.borderDepthOn = true;
    this.dirty = true;
  }

  
      resize() {
    if (this.fixedSize) return;   // 整图导出期间由调用方自己定尺寸
    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    /* 画布像素总数封顶（"电脑版非常卡"的主因）
     *
     * 边界那几趟逐像素计算，一帧开销 ∝ 画布像素数；
     * dpr 上限写死 2 时：
     *   · 4K 屏（3840×2160）dpr 2 → 3840×2160×4 ≈ 3300 万像素
     *   · Windows 缩放 125% / 150% 时 dpr 已到 1.25 / 1.5，同样爆
     *   · 手机（390×844）dpr 2 → 仅 260 万
     * 相差十几倍，即"手机不卡、电脑卡"的来源。
     *
     * 总量封顶：超了把 dpr 降下来（画面略糊，换来十几倍速度）。
     * 下限 0.75，再低就糊得看不清。1080p（约 200 万像素）稳在限额内，不受影响。
     */
    const px = cssW * cssH * dpr * dpr;
    this.lowRes = false;
    if (px > MAX_CANVAS_PX) {
      dpr = Math.max(0.75, Math.sqrt(MAX_CANVAS_PX / (cssW * cssH)));
      this.lowRes = true;                 // 记住降过采样，见 render() 里的抗锯齿开关
    }
    /* 拖动期间再打折 —— 见构造函数里 motionScale 一段。
     *   折扣写在总量封顶之后，否则大屏上两次削减叠加，拖一次就糊成马赛克。
     *   下限 0.5 同理：再低看不清国界。
     */
    if (this.motionScale > 0 && this.motionScale < 1) {
      dpr = Math.max(0.5, dpr * this.motionScale);
    }
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.dirty = true;
    }
  }

  /* ============ 每帧九十多条 GL 调用：值没变就不发 ============
   *
   *  一帧 render() 固定发多少条？`node tools/_bench_render.js EU4` 实测：
   *    43 条 uniform1i + 13 条 activeTexture + 13 条 bindTexture + 10 条 uniform1f
   *    + 其余向量几条 = 97 条
   *  拖动 / 缩放时真正变的只有 uView 那 4 个数，其余九十多条每次都一样。
   *
   *  每条 JS→WebGL 调用都要过参数校验、抄进命令缓冲：
   *    桌面约 0.2~0.5 µs、手机（尤其 Adreno 那批）1~3 µs
   *  → 97 条 ≈ 桌面 0.02 ms / 手机 0.3 ms，每帧白耗；
   *    60 帧即手机 18 ms，"一拖就掉帧"有一部分来自这里。
   *
   *  做法：缓存上次发出的值，相同则整条跳过。
   *  只跳过"发同一个值"的调用 → 渲染结果一个字节都不变（必须守住）。
   *  缓存按 location 对象记，换程序时 _installProgram 会整个清掉
   *  （不清则新程序沿用旧程序的记录 → 整帧错色，极难排查）。
   *  纹理另有代号兜底，见 GL_TEX_EPOCH 一段。
   */

  /** 一个分量：与上次相同则跳过（kind: 0=uniform1i · 1=uniform1f · 2=uniform1ui）*/
  _u1(loc, v, kind) {
    if (loc == null) return;
    const cache = this._uCache;
    if (cache.get(loc) === v) return;
    cache.set(loc, v);
    const gl = this.gl;
    if (kind === 0) gl.uniform1i(loc, v);
    else if (kind === 1) gl.uniform1f(loc, v);
    else gl.uniform1ui(loc, v);
  }

  /** 二 / 三 / 四个分量：先逐项比较再决定是否发送（kind: 0=2i · 1=3f · 2=4f）
   *  值存在定长小数组里就地改，不每帧新建（避免 GC 抖动）*/
  _uN(loc, kind, a, b, c, d) {
    if (loc == null) return;
    const cache = this._uCache;
    let p = cache.get(loc);
    if (p === undefined) { p = [a, b, c, d]; cache.set(loc, p); }
    else {
      const same = kind === 0 ? (p[0] === a && p[1] === b)
        : kind === 1 ? (p[0] === a && p[1] === b && p[2] === c)
          : (p[0] === a && p[1] === b && p[2] === c && p[3] === d);
      if (same) return;
      p[0] = a; p[1] = b; p[2] = c; p[3] = d;
    }
    const gl = this.gl;
    if (kind === 0) gl.uniform2i(loc, a, b);
    else if (kind === 1) gl.uniform3f(loc, a, b, c);
    else gl.uniform4f(loc, a, b, c, d);
  }

  /** 定长数组（uExtraTier 那四根，8 个）：逐元素比完再决定是否发送
   *  比较的是当前值而非引用 —— app 侧是拿同一个数组就地改的 */
  _uArr(loc, arr, n, isInt) {
    if (loc == null || !arr) return;
    const len = n | 0;
    const cache = this._uCache;
    let p = cache.get(loc);
    if (p === undefined || p.length !== len) { p = new Array(len); cache.set(loc, p); }
    let same = true;
    for (let i = 0; i < len; i++) { if (p[i] !== arr[i]) { same = false; break; } }
    if (same) return;
    for (let i = 0; i < len; i++) p[i] = arr[i];
    const gl = this.gl;
    if (isInt) gl.uniform1iv(loc, arr); else gl.uniform1fv(loc, arr);
  }

  /** 绑纹理单元：同一单元已绑同一张 → activeTexture + bindTexture 全跳
   *  代号变了（别处绑过）就把整本记录清掉重记，见 GL_TEX_EPOCH 一段 */
  _tex(unit, target, tex) {
    if (this._texEpoch !== GL_TEX_EPOCH || !this._texBound) {
      this._texEpoch = GL_TEX_EPOCH;
      this._texBound = new Array(13).fill(null);
      this._texUnit = -1;          // 别处可能 activeTexture 过 → 当前单元也不可信
    }
    const gl = this.gl;
    /* 先判断"这张是否还绑着"，再决定是否切单元；
     *   反过来写（先 activeTexture 后判断）等于每帧把 13 个单元全切一遍。
     */
    if (this._texBound[unit] === tex) return;
    if (this._texUnit !== unit) { gl.activeTexture(gl.TEXTURE0 + unit); this._texUnit = unit; }
    gl.bindTexture(target, tex);
    this._texBound[unit] = tex;
  }

  render() {
    /* 逐帧体检（仅调试开关打开时）——
     *   现象：手机黑屏、中心像素 [0,0,0]、错误码 1282（GL_INVALID_OPERATION）。
     *   1282 是异步留下的：getError 返回"上一个尚未被取走的错"，
     *   单看一次无法定位来源，故画前清空、画后看剩余错误，
     *   同时打印视口与画布尺寸；视口未跟上画布时（例如渲染器建立时画布仍是
     *   300×150 默认尺寸），画面会画进小角、其余全黑。
     *   开关：地址后加 `#diag`（见 app.js 的 bootMark），默认关闭 ——
     *   下面那段 while 会吞掉真实的 GL 错误，故不可按 innerWidth ≤ 900 自动开启：
     *   手机没有控制台，恰恰最需要真实错误码。
     */
    const _diag = (typeof window !== 'undefined') && !!window.__PDX_DIAG;
    if (_diag) {
      try {
        const g0 = this.gl;
        while (g0.getError() !== g0.NO_ERROR) { /* 清空历史错误 */ }
      } catch (e) { /* 忽略 */ }
    }
    if (this.ctxLost) return false;      // 上下文被收走：不上屏，等它恢复（见 restored）
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

    /* 0~4 号单元（顺序 / 单元号不可改动，见文件头的着色器规矩）
     *   不再直接 activeTexture + bindTexture：_tex() 先看"该单元上次绑的是不是同一张"，
     *   是就整条跳过，省下的正是每帧的固定开销 */
    this._tex(0, gl.TEXTURE_2D, this.provTex);
    this._tex(1, gl.TEXTURE_2D, this.titleTex);
    this._tex(2, gl.TEXTURE_2D, this.colorTex);
    this._tex(3, gl.TEXTURE_2D, this.paintTex);
    this._tex(4, gl.TEXTURE_2D, this.paintLabelTex);
    this._u1(u.uProv, 0, 0);
    this._u1(u.uTitleMap, 1, 0);
    this._u1(u.uColorLut, 2, 0);
    this._u1(u.uPaint, 3, 0);
    this._u1(u.uPaintLabel, 4, 0);
    // 分块那条路：纹理单元 5（0~4 已经被上面占满）
    this._tex(5, gl.TEXTURE_2D_ARRAY, this.provArrTex);
    this._u1(u.uProvArr, 5, 0);

    // 悬停编组表：单元 6（"同一片海"那条路要用；任何一层都绑着，该表一直存在）
    this._tex(6, gl.TEXTURE_2D, this.hoverGroupTex);
    this._u1(u.uHoverGroup, 6, 0);
    this._u1(u.uHoverGroupW, this.paintW, 0);

    /* 底层身份标：单元 7（"每格按底层身份上色"那条要用）
     *   旧包 / 未灌入 → kindData 为空 → uKindOn = 0，着色器整条让开 */
    this._tex(7, gl.TEXTURE_2D, this.kindTex);
    this._u1(u.uKindTex, 7, 0);
    this._u1(u.uKindOn, this.kindData ? 1 : 0, 0);
    this._u1(u.uKindW, this.paintW, 0);
    /* 未灌入自然色（旧包 / 尚未跑到）时该 uniform 无值可发，
     *   直接把 undefined 交给 uniform3fv 会抛 TypeError，故跳过。
     *
     * 数组 uniform 必须按实际长度发满：只用 gl.uniform3f 写 uNature[0]，
     *   未写到的元素按 WebGL 规范取初值 0，湖 / 河 / 不可通行海域 / 不可通行
     *   随之全黑：
     *   → 着色器 natureColor(k) = uNature[k-2]（见 GLSL 一段）：
     *     海(2)=uNature[0] 有值；
     *     湖(3)=uNature[1] / 河(4)=uNature[2] / 不可通行海域(5)=uNature[3] /
     *     不可通行(6)=uNature[4] 全为 (0,0,0) → vec4(0,0,0,1) = 纯黑
     *     （"湖泊 / 河流 / 锁定海域一片黑"）。
     *   做法：一次 uniform3fv 把 15 个 float 全部发出。
     *   勿塞进 _uCache：那本账一个 location 只存 4 个数，用单独的 natureDirty；
     *   只在脏了才发。
     */
    if (this.natureFlat && this.natureDirty) {
      if (u.uNature) gl.uniform3fv(u.uNature, this.natureFlat);
      this.natureDirty = false;
    }

    /* 「能否认出是水」表：单元 8（「水域 · 边界」通道要用）
     *   与 kindTex 一样一直绑着 —— 表本身一直存在（内容可以是全 0）。
     *   uWaterKindOn 由 app 侧与"这个勾"取 AND 后写进 waterBorderOn，
     *   着色器里只留一个闸，避免两处各判一遍（见 handover §3.4 第 2 步）。
     */
    this._tex(8, gl.TEXTURE_2D, this.waterKindTex);
    this._u1(u.uWaterKind, 8, 0);
    this._u1(u.uWaterKindW, this.paintW, 0);

    // 深度图：单元 9（纹理单元编号保持不变）
    if (this.borderDepthTex && this.borderDepthOn) {
      this._tex(9, gl.TEXTURE_2D, this.borderDepthTex);
      this._u1(u.uBorderDepth, 9, 0);
      this._u1(u.uBorderDepthOn, 1, 0);
    } else {
      /* 关闭时也必须绑 —— 仅设 uBorderDepthOn=0 不够：
       *   着色器里的 sampler 仍然存在，WebGL 会检查它指向的纹理是否完整
       *   （手机黑屏的根因）。
       */
      this._tex(9, gl.TEXTURE_2D, this.dummyTex);
      this._u1(u.uBorderDepth, 9, 0);
      this._u1(u.uBorderDepthOn, 0, 0);
    }

    /* 国旗三张表：单元 10 / 11 / 12（关闭时也绑 1×1，否则纹理不完整 → 画面黑）*/
    if (this.flagOn && this.flagIdxTex && this.flagSlotTex && this.flagTexArr) {
      this._tex(10, gl.TEXTURE_2D, this.flagIdxTex);
      this._u1(u.uFlagIdx, 10, 0);
      this._tex(11, gl.TEXTURE_2D, this.flagSlotTex);
      this._u1(u.uFlagSlots, 11, 0);
      this._tex(12, gl.TEXTURE_2D_ARRAY, this.flagTexArr);
      this._u1(u.uFlagTex, 12, 0);
      this._u1(u.uFlagOn, 1, 0);
      this._u1(u.uFlagIdxW, this.flagIdxW || 1, 0);
      this._u1(u.uFlagSlotW, this.flagSlotW || 1, 0);
    } else {
      this._tex(10, gl.TEXTURE_2D, this.dummyTex);
      this._u1(u.uFlagIdx, 10, 0);
      this._tex(11, gl.TEXTURE_2D, this.dummyTex);
      this._u1(u.uFlagSlots, 11, 0);
      this._tex(12, gl.TEXTURE_2D_ARRAY, this.dummyArrTex);
      this._u1(u.uFlagTex, 12, 0);
      this._u1(u.uFlagOn, 0, 0);
      this._u1(u.uFlagIdxW, 1, 0);
      this._u1(u.uFlagSlotW, 1, 0);
    }

    this._uN(u.uView, 2, this.view.x, this.view.y, this.view.w, this.view.h);
    this._uN(u.uMapSize, 0, this.mapW, this.mapH, 0, 0);
    this._u1(u.uTitleMapW, this.titleMapW, 0);
    this._u1(u.uNumProvinces, this.numProvinces, 0);
    this._u1(u.uPaintW, this.paintW, 0);
    this._u1(u.uTier, this.tier, 0);
    this._u1(u.uEditTier, this.editTier, 0);
    this._u1(u.uFineTier, this.fineTier, 0);
    this._u1(u.uShowTitles, this.showTitles ? 1 : 0, 0);
    this._u1(u.uShowPaint, this.showPaint ? 1 : 0, 0);
    // 分块参数（无分块数据时 useTiles=0 → 着色器走旧路，等价）
    /* 用模块级常量对象，避免无分块数据时每帧新建 {tileW:1,...} 白喂 GC
     *  （该对象只读，不要修改）*/
    const _ti = this.tileInfo || NO_TILES;
    this._uN(u.uProvTiles, 0, _ti.tileW, _ti.tileH, 0, 0);
    this._u1(u.uProvCols, _ti.cols, 0);
    this._u1(u.uUseTiles, this.useTiles || 0, 0);
    // id 图缩着传时 >1（见 setData 里 arrOk 一段）；通常恒 1
    this._u1(u.uProvScale, this._smallIds ? (this.provScale || 1) : 1, 0);
    this._u1(u.uMix, this.mix, 1);
    this._u1(u.uBorderTitle, this.borderTitle ? 1 : 0, 0);
    this._u1(u.uBorderPaint, this.borderPaint ? 1 : 0, 0);
    this._u1(u.uPaintOnly, this.paintOnly ? 1 : 0, 0);
    // 「未上色区域」的颜色：无归属地块在开着剧本时的显示色
    this._uN(u.uUnpainted, 1, this.unpainted[0], this.unpainted[1], this.unpainted[2], 0);
    this._u1(u.uBorderW, this.borderWidth, 1);
    this._u1(u.uPaintBorderW, this.paintWidth, 1);
    this._u1(u.uPaintBorderA, this.paintAlpha, 1);
    /* 水域边界：独立的一套宽 / 浓，独立于那三个开关
     *   waterBorderOn 是布尔，由 app 每帧传入（它已把"这个勾 + 算得出水陆"取 AND）
     */
    this._u1(u.uWaterBorderOn, this.waterBorderOn ? 1 : 0, 0);
    this._u1(u.uWaterBorderW, this.waterBorderW, 1);
    this._u1(u.uWaterBorderA, this.waterBorderA, 1);
    /* 荒地边界那三根，与水域同样的三行 */
    this._u1(u.uWasteBorderOn, this.wasteBorderOn ? 1 : 0, 0);
    this._u1(u.uWasteBorderW, this.wasteBorderW, 1);
    this._u1(u.uWasteBorderA, this.wasteBorderA, 1);
    const _exN = this.extraTiers.length;
    this._u1(u.uExtraCount, this.extraCount | 0, 0);
    this._uArr(u.uExtraTier, this.extraTiers, _exN, true);
    this._uArr(u.uExtraW, this.extraWs, _exN, false);
    this._uArr(u.uExtraShow, this.extraShows, _exN, true);
    this._uArr(u.uExtraA, this.extraAs, _exN, false);
    this._u1(u.uBorderA, this.borderStrength, 1);
    this._u1(u.uLutW, this.lutW, 0);
    this._u1(u.uRealTitles, this.realTitles, 0);
    this._u1(u.uHoverTid, this.hoverTid, 2);
    this._u1(u.uHoverPaintOn, this.hoverPaintOn ? 1 : 0, 0);
    this._uN(u.uHoverPaint, 1, this.hoverPaint[0], this.hoverPaint[1], this.hoverPaint[2], 0);
    this._u1(u.uHoverPid, this.hoverPid || 0, 0);
    this._u1(u.uHoverGroupId, this.hoverGroupId || 0, 2);
    this._u1(u.uHoverLabel, this.hoverLabel || 0, 2);
    this._uN(u.uBackdrop, 1, this.backdrop[0], this.backdrop[1], this.backdrop[2], 0);

    // 一个屏幕像素折算成多少个地图像素 —— 采样和画边界都要用它。
    // 用 canvas.width（设备像素）而不是 clientWidth，固定尺寸渲染时才对得上。
    const scale = this.canvas.width / this.view.w;
    this._u1(u.uMapPerPx, 1 / Math.max(scale, 1e-6), 1);
    this._u1(u.uNoAA, (this.noAA || this.lowRes) ? 1 : 0, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    /* 逐帧体检（仅调试开关打开时）：打印这一帧画时的关键状态
     *   · 画布 vs 视口
     *   · 画完后的 GL 错误码（画前已清空，故此处报的就是这一帧的）
     *   · 采样用的那几张纹理是否绑上
     */
    if (_diag && typeof bootMark === 'function') {
      try {
        const cv1 = gl.canvas;
        const vp1 = gl.getParameter(gl.VIEWPORT) || [0, 0, 0, 0];
        /* 这里不调 getError()：它会取走手头那个真实的 GL 错误，
         *   别处（工单里最值钱的那一行）就再也看不到它。
         *   变量名必须与作用域内实际存在的标识符一致：引用了已移除的变量时，
         *   每次执行都抛 ReferenceError，被 try 吞掉后什么也看不到。
         */
        bootMark('帧:画布' + cv1.width + '×' + cv1.height
          + ' 视口' + vp1[2] + '×' + vp1[3]
          + ' 贴图' + (gl.isTexture(this.provTex) ? 'ok' : '坏'));
      } catch (e) { /* 忽略 */ }
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
