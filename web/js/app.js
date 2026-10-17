/**
 * CK3 地图编辑器 —— 主逻辑
 */

// 开发版是真 ES module（index.html 只加载本文件）——别的模块都得显式 import。
// 单文件版由 build_standalone.py 剥掉这些行、按序拍平，两边的加载方式都兼容。
import { DATA, api, b64ToBytes, decompress, embeddedMapKeys, isEmbedded, setDataDir, setEmbeddedMap, setPackMap, isPackMap } from './data.js';
import { MapRenderer } from './gl.js';
import { LabelLayer, computeLabelZoom } from './labels.js';
import { TileMap } from './tilemap.js';
import { importPack, listPacks, getPack, removePack, exportPackBytes, packStoreMode } from './packstore.js';

const $ = (id) => document.getElementById(id);

/*
 * 水域 / 荒地 = **普通地块** ✓（2026-10-14 定案 ✓）
 *   原来的"紧急回滚开关"和它旁路的那套专属边界、专属颜色、专属高亮
 *   **全部拆除** ✓
 *   水片与荒地片就是普通头衔：涂色 / 悬停 / 边界缝全走普通头衔那条管线 ✓
 *   认水用的三件小工具（`isWaterKey` / `isWaterPid` / `isWaterHere`）还留着 ✓
 *     —— 老包海名表、水域名表那几处还要用 ✓
 */

/**
 * 报错日志（`web/js/log.js` —— 它比本文件先加载 ✓）
 *
 * 拿不到就当一个空壳 ✓：日志坏了**绝不能连累编辑器** ✗
 * （单文件版烤的时候漏拼了 log.js、或者谁把那个 <script> 删了，
 *   编辑器照常用，只是「导出日志」导出来是空的 —— 那也比崩了强 ✓）
 */
const LOG = window.PDXLOG || {
  event() {}, error() {}, env() {}, snapshot() {},
  count: () => 0, text: () => '', download: () => false,
};

/**
 * 作者署名 —— 启动页那行小字和顶栏那个小按钮都指这里 ✓
 *
 * 换主页**只改这一行**（`space.bilibili.com/<数字 ID>` ✓）
 */
const AUTHOR = {
  name: '永夜廿九',
  url: 'https://space.bilibili.com/442256114',
};

/**
 * 把署名那两个入口接上 —— **页面一出来就挂** ✓
 *
 * 千万别挪进 `bindEvents()`：那个要等地图整个烘完才跑，EU5 / V3 得等好几秒 ✗
 * 而署名就印在启动页上，玩家进来第一眼看见就会点，那时候 <a> 还没有 href
 * → 点了什么都不会发生 ✗（这个坑就是在这踩的）
 */
function bindAuthorLinks() {
  for (const id of ['author-link', 'btn-author']) {
    const el = $(id);
    if (!el) continue;
    el.href = AUTHOR.url;
    el.target = '_blank';
    el.rel = 'noopener';
  }
  // 启动页角落挂一个**构建戳**：出问题时一眼看出"手上是哪一份文件" ✓
  // 🔴 **不能拿 document.lastModified** ✗✗（2026-10-17 用户发现）——
  //    单文件 / 某些浏览器里它是**当前时间**，看着像"版本戳一直在变" ✓
  //    现在由 build_standalone.py 把打包时间写进 <meta name="pdx-build">；
  //    开发版里是 dev → 显示「开发版」✓
  const bv = $('boot-ver');
  if (bv) {
    let build = '';
    try {
      const m = document.querySelector && document.querySelector('meta[name="pdx-build"]');
      build = m && m.content ? String(m.content).trim() : '';
    } catch (e) { build = ''; }
    bv.textContent = build
      ? (build === 'dev' ? '开发版' : '构建 ' + build)
      : '';
  }
}
bindAuthorLinks();

/**
 * 每个游戏的术语、存档键、叫法
 *
 * 渲染那一层两个游戏是**完全共用** —— EU4 的「省份/地区/区域/大洲」
 * 正好也是五级，一一对上 titlemap 那 5 行。不同的只有叫法
 *
 * ⚠ 这里只放**真被读的字段** ✗ —— 2026-10-12 删掉了 `modName` / `exportKind` /
 *   `exportTip` / `brushTip` 四个：全仓库一个消费者都没有（"导出 mod"这条路
 *   编辑器里压根没做 ✓），留着只会让人以为还有那功能 ✓
 */
const GAMES = {
  /* CK2 —— **一个独立的模式** ✗ 不是"CK3 加个别名" ✓（2026-10-15 用户点名的口径 ✓）
     渲染那一层确实跟 CK3 共用（都是五级头衔那套界面 ✓），但**每一条规矩都各自定** ✓：
       · **四级**不是五级：帝国 / 王国 / 公爵领 / 伯爵领 ✓ **没有男爵领** ✗
         —— CK2 的男爵领是伯爵领**里面的地产**、不占地图像素 ✓
         （层名层数一律读 `meta.tiers` ✓ 前端不写死 ✓ 见 build_ck2.py 顶上那段 ✓）
       · **名字有中文** ✓ —— 走汉化 mod 那套"自造三字节"编码 ✓
         （`parsers/ck2/hanhua.py` ✓ 回退链：汉化中文 → 原版英文 → 键名 ✓）
         所以搜索**中英都认** ✓
       · **剧本层是 1066** ✓（日期从游戏书签里读的 ✓ 见 `meta.bookmark` ✓）
         + 一层「空白剧本」✓（跟别的游戏同一个构造 ✓） */
  ck2: {
    id: 'ck2',
    name: 'CK2',
    brand: 'CK', brandSmall: 'II',
    title: 'CK2 地图编辑',
    entity: '头衔',
    saveKey: 'ck2-map-editor/v1',
    filePrefix: 'ck2',
    searchHint: '支持中文名、英文名，以及 c_/d_/k_/e_ 开头的 key',
    searchPlaceholder: '',
    pickHint: '这个颜色在数据里归好几个头衔，挑一个当标记',
    colorTip: '显示头衔自带的颜色',
    borderTip: '给头衔区域描边（和「填色·边界」二选一）',
    labelsTip: '在地图上标出头衔名字',
    notInMap: '这块地不在 CK2 的地图范围内。',
  },
  ck3: {
    id: 'ck3',
    name: 'CK3',
    brand: 'CK', brandSmall: 'III',
    title: 'CK3 地图编辑',
    entity: '头衔',
    saveKey: 'ck3-map-editor/v1',
    filePrefix: 'ck3',
    searchHint: '支持中文名、英文名、c_/d_/k_/e_ 开头的 key',
    searchPlaceholder: '',
    pickHint: '这个颜色在数据里归好几个头衔，挑一个当标记',
    colorTip: '显示头衔自带的颜色',
    borderTip: '给头衔区域描边（和「填色·边界」二选一）',
    labelsTip: '在地图上标出头衔名字',
    notInMap: '这块地不在 CK3 的地图范围内。',
  },
  eu4: {
    id: 'eu4',
    name: 'EU4',
    brand: 'EU', brandSmall: 'IV',
    title: 'EU4 地图编辑',
    entity: '省份',
    saveKey: 'eu4-map-editor/v1',
    filePrefix: 'eu4',
    searchHint: '支持 TAG 与势力名、区域名、地区名、省份名；key 形如 SWE / p_118 / brittany_area。',
    searchPlaceholder: '',
    pickHint: '这个颜色在数据里归好几个省份，挑一个当标记',
    colorTip: '显示省份 / 地区自带的颜',
    borderTip: '给省份区域描边（和「填色·边界」二选一）',
    labelsTip: '在地图上标出地名',
    notInMap: '这块地不在 EU4 的地图范围内。',
  },
  hoi4: {
    id: 'hoi4',
    name: 'HOI4',
    brand: 'HOI', brandSmall: 'IV',
    title: 'HOI4 地图编辑',
    entity: '省份',
    saveKey: 'hoi4-map-editor/v1',
    filePrefix: 'hoi4',
    searchHint: '支持 TAG 与势力名、州名、战略区名、城市名；key 形如 GER / STATE_118 / STRATEGICREGION_1。',
    searchPlaceholder: '',
    pickHint: '这个颜色在数据里归好几个省份，挑一个当标记',
    colorTip: '显示国家 / 州自带的颜色',
    borderTip: '给省份区域描边（和「填色·边界」二选一）',
    labelsTip: '在地图上标出地名',
    notInMap: '这块地不在 HOI4 的地图范围内。',
  },
  eu5: {
    id: 'eu5',
    name: 'EU5',
    brand: 'EU', brandSmall: 'V',
    title: 'EU5 地图编辑器',
    entity: '地点',
    saveKey: 'eu5-map-editor/v1',
    filePrefix: 'eu5',
    searchHint: '支持 TAG 与势力名，以及 国家 / 区域 / 地区 / 省份 / 地点的名字。',
    searchPlaceholder: '',
    pickHint: '这个颜色在数据里归好几个地块，挑一个当标记：',
    colorTip: '显示地块自带的颜色',
    borderTip: '给地块描边（和「填色·边界」二选一）',
    labelsTip: '在地图上标出地名',
    notInMap: '这块地不在 EU5 的地图范围内。',
  },
  vic3: {
    id: 'vic3',
    /* 🔴 **2026-10-16 用户定的：显示名写成「VIC3」** ✗（原来是 `V3` ✓）
     *   原话："之后V3改名叫VIC3吧" ✓
     *   ⚠ **只改"给人看的名字"** ✗✗ —— 下面这几个一律**不许动**：
     *     · `id: 'vic3'` / `game: 'vic3'`（数据 meta、存档键、测试都在用 ✓）
     *     · `dir: '/data_vic3'`（缓存目录 ✓）
     *     · `saveKey` / `filePrefix`（存档与导出文件名 ✓ 改了老存档就接不上 ✓）
     *     · `brand` / `brandSmall`（那是**图形化的招牌**：VIC + 上标 3 ✓ 不是文字名 ✓）
     *   —— 所以这条改动**不碰任何数据 / 存档 / 路径** ✓ 只是换个叫法 ✓ */
    name: 'VIC3',
    brand: 'VIC', brandSmall: '3',
    title: '维多利亚3 地图编辑',
    entity: '省份',
    saveKey: 'vic3-map-editor/v1',
    filePrefix: 'vic3',
    searchHint: '支持 TAG 与势力名、州名、战略区名；key 形如 SWE / STATE_SVEALAND / p_118。',
    searchPlaceholder: '',
    pickHint: '这个颜色在数据里归好几个省份，挑一个当标记',
    colorTip: '显示国家 / 州自带的颜色',
    borderTip: '给省份区域描边（和「填色·边界」二选一）',
    labelsTip: '在地图上标出地名',
    notInMap: '这块地不在维多利亚3 的地图范围内。',
  },
};

/** 当前是哪个游戏，boot 时按 meta.game 定 */
let GAME = GAMES.ck3;

/** 可选的地图。key 是单文件版内嵌数据的键，dir 是走服务时的目录
 *
 * **只放游戏自带的地图** ✓ —— 创意工坊模组那张图没拿到作者授权，
 * 不进对外发的单文件 ✗（自己在本地烤一份数据、把条目加回来就能用 ✓）
 */
const MAP_CHOICES = [
  { key: 'vanilla', emb: 'vanilla', dir: '/data',        game: 'ck3', label: 'CK3 原版',     note: '9216 × 4608' },
  { key: 'eu4',     emb: 'eu4',     dir: '/data_eu4',    game: 'eu4', label: 'EU4 原版',     note: '5632 × 2048' },
  { key: 'eu5',     emb: 'eu5',     dir: '/data_eu5',    game: 'eu5',  label: 'EU5 原版',   note: '8192 × 4096' },
  { key: 'eu5full', emb: 'eu5full', dir: '/data_eu5_full', game: 'eu5', label: 'EU5 原尺寸', note: '16384 × 8192' },
  { key: 'vic3',    emb: 'vic3',    dir: '/data_vic3',   game: 'vic3', label: 'VIC3 原版',  note: '8192 × 3616' },
  { key: 'hoi4',    emb: 'hoi4',    dir: '/data_hoi4',   game: 'hoi4', label: 'HOI4 原版',   note: '5632 × 2048' },
  { key: 'hoi4alt', emb: 'hoi4alt', dir: '/data_hoi4_alt', game: 'hoi4', label: 'HOI4 修改边界', note: '5632 × 2048' },
];

// 层级数由数据 meta.tiers 决定 —— CK3 是 6 层（1066 + 法理那五级）、
// EU4/HOI4 是 6~7 层，维多利亚3 是 5 层，所以这几个都别写死，boot 时按 meta 填
// TIER_KEYS 只有 CK3 的 mod 用得到，meta.tiers 里就是那几个字母 + 剧本那一格
let TIER_KEYS = ['e', 'k', 'd', 'c', 'b'];
let TIER_COUNT = TIER_KEYS.length;
let TIER_HOTKEY = ['1', '2', '3', '4', '5'];

/** 悬停链里那个小徽章：CK3 是 e_/k_/…，EU4 是 ''/…（空串），boot 时从 meta 读 */
let TIER_BADGE = ['e_', 'k_', 'd_', 'c_', 'b_'];

/* ⚠ **工具没有图标** ✗（桌面那排只用文字 ✓ 手机底部固定一支笔 ✎ ✓）
 *   中间给手机版试过两版"每个工具一个图标"：
 *     ① emoji → 彩色，跟这套黑白界面打架 ✗
 *     ② 自己画的单色 SVG → 用户看过觉得丑 ✗
 *   → **都撤了** ✓ 现在手机底部就是一支笔 + 当前工具名 ✓
 *     靠文字区分工具（手机上面板里也是文字按钮 ✓ 一致 ✓）
 *   💡 以后要是再加图标：**别只加手机版** ✗ 桌面那排也一起加才不割裂 ✓ */
const TOOLS = [
  { id: 'view', label: '查看', key: 'Q', tip: '' },
  { id: 'pick', label: '吸管', key: 'W', tip: '' },
  // **填色**：跟涂抹**同一套范围算法** ✓，差别只在"按住拖动要不要连发"——
  // 填色是**一次一个**（点一下动一次 ✓），涂抹才是按住拖出一片 ✓（用户要求）
  { id: 'fill', label: '填色', key: 'F', tip: '' },
  { id: 'paint', label: '涂抹', key: 'E', tip: '' },
  { id: 'erase', label: '橡皮', key: 'R', tip: '' },
  { id: 'rename', label: '改名', key: 'N', tip: '' },
];

const state = {
  meta: null,
  titles: null,
  original: null,
  provinceIds: null,
  titlemap: null,
  provinceNames: null,
  tier: -1,             // boot 时按 meta.defaultTier 定（CK3 是伯爵领、EU4 是省份）
  // 年份视图（1444/1618/1800）下的「粒度」：null = 跟视图走（按国家），
  // 或者填一个下层级序号（地区 / 省份）。只影响**边界画在哪一级的接缝上**
  // 笔刷涂哪一块** —— 地图配色始终是那年的归属色，不会跟着变
  grain: null,
  /* 🔴 **"当前是哪一个剧本"**（2026-10-17 ✓ 用户那条取色标准要用 ✓）
   *   · 停在剧本层时 = `state.tier` ✓
   *   · 切到地理层（地区 / 省 / 地点）之后 = **上一次停过的那个剧本层** ✓
   *   ⚠ 为什么非记不可 ✗：切到细层后 `state.tier` 就不是剧本层了 ✓
   *     而用户那条规矩是"**只要开了剧本、而且剧本颜色开着，就先看剧本**"✓
   *     —— 得知道"是哪个剧本"才取得出那一层的色 ✓
   *   ⚠ 它**只给取色用** ✗（荒地自动上色 ✓）别拿它去影响着色器 / 边界 ✓ */
  lastEraTier: -1,
  tool: 'paint',
  brush: [200, 50, 50],            // 默认颜色：RGB(200, 50, 50) ✓
  /* 🔴 **剧本那三个开关 2026-10-17 删了** ✗（用户："已经没什么用了"✓）
   *   · showPowerColor = **固定开**（剧本颜色永远显示，不然开图就是空的 ✓）
   *   · showPowerBorder = **固定关**（剧本边界不再单独画 ✓ 要边界用「势力 · 边界」✓）
   *   ⚠ 名字留着 ✗ —— 着色器 / 荒地取色 / 分级边界那几处还在读它 ✓
   *     只是**没有界面入口**了 ✓ 别当成可调开关再用 ✓ */
  showPowerColor: true,       // **固定开** ✓（剧本颜色永远显示 ✓）
  showPowerBorder: false,     // **固定关** ✓（剧本边界不再单独画 ✓）
  showRegionColor: false,     // 地区（更细的那几层）颜色：默认关，画面干净
  showRegionBorder: true,
  showRegionName: false,
  showParentBorderTitle: false,   // 父级边界：默认**关**（要用再勾）
  // 二级设置页里的东西（null = 用各游戏/代码里的原值 ✓）
  set: {
    /* ⚠ **背景色和未上色色是两项** ✗（2026-10-13 用户要求拆开 ✓）
     *   · bg        = 「背景颜色」（默认 180,180,180 ✓）—— 也是一般说的"空白地区" ✓
     *   · unpainted = 「未上色区域」—— **只在开着剧本时**给无主地用 ✓
     *     没开剧本的时候无主地直接用 bg（见 gl.js 里 NONE 那段 ✓）*/
    bg: null, unpainted: null,
    /* 🔴 **七行颜色** ✗✗（2026-10-15 ✓ 用户定的口径 ✓）——
     *   bg      空白区域     180,180,180 ✓（没开剧本时的默认底 ✓）
     *   unpainted 无归属区域  150,150,150 ✓（开着剧本、没归属的地 ✓ **不进身份标** ✓）
     *   其余五行 = `NATURE_RGB` 里那份出厂值 ✓（null = 用出厂 ✓）
     *   ⚠ 这是 `state.set` 那份初值；出厂表在下面 `SET_DEFAULTS` ✓ 两处一起加 ✓ */
    impass: null, sea: null, isea: null, lake: null, river: null,
  /* ⚠ **宽度默认一律 1.0** ✗（用户定的 ✓ 老几样当年是 1.5 ✓）
   *   浓度（pa/ra/ca）不动 ✓ 用户说的是"宽度都是 1.0" ✓
   * ⚠ **「地方边界宽度」2026-10-13 拆成两条** ✓（用户要求 ✓）：
   *   · wRegion = 「**地区**边界宽度」→ 管**父级边界**（多级链上层那些线 ✓）
   *   · wProv   = 「**省份**边界宽度」→ 管**子级边界**（本层那条线 ✓）
   *   默认都是 1 ✓ 跟原来那一条相等 —— 观感不变 ✓
   *   ⚠ 老的 `w` 还留着 ✗：老存档只有它，代码里两条都从它继承（见 syncParentBorder ✓）
   *     删了的话老用户那两根滑条会一夜回到默认 ✓ */
  wRegion: 1, wProv: 1, w: null,
  pa: 50, ra: 75, ca: 100, pw: 1,
  /* 🔴🔴 **字号拆成两块** ✗✗（2026-10-17 用户定的 ✓
   *   "把字号分开两个，一个给地块，一个给势力"✓）
   *   · `fontPlace` = 地块名（含海 / 湖 / 河 / 荒地名 ✓）
   *   · `fontPower` = 势力名（剧本 / 年份那几层 + 涂出来的色块名 ✓）
   *   ⚠ **老的 `font` 保留但不再读** ✗（老存档只有它 ✓
   *     迁移收在 `fontSizes()` 那一个口子里 ✓ —— 别在每处各写一遍 ✓）*/
  fontPlace: 1, fontPower: 1,
  // **背景那两条线各有一套宽度 + 浓度** ✓（用户要求可调 ✓；显示开关去掉了 ✗）
  //   宽度跟「势力线宽」一个口径（格数 ✓ 直接就是粗细）；浓度是百分比 ✓
  //   （水域 / 荒地那两条专属的「内部 / 外部」宽浓已退役 ✓ 水走普通头衔边界 ✓）
    // 导出图例（用户要的：相关设置都放在「设置」这一页 ✓）
    legend: false, legendTitle: '', legendPos: 'tl',
  },
  showTitles: true,
  /* 原版边界的开关原来挂在「头衔」那组的复选框上（state 里干脆没这个字段 ✗）——
     那组删掉之后，这个值就由「势力/地区 · 边界」每帧算出来写进来 ✓
     （这一条只是给"没有年代层的旧缓存"兜底：默认不画原版边界 ✓） */
  showBorderTitle: false,
  // 地名拆两套：原有地名（头衔/地区名）和玩家地名（手绘色块名），互不影响
  // （原来还有第三套「势力名」——它算出来的东西跟玩家地名**完全是同一批点** ✓
  //   所以那个开关删了，剧本层的国名就由「填色 · 名称」统一负责 ✓）
  showLabelsTitle: true,
  showLabelsPaint: false,
  showPaint: true,
  // 水域 / 荒地的专属开关全部退役 ✓（边界 / 颜色 / 允许上色 / 自动上色 ✓）
  //   水片与荒地片就是普通头衔：涂色、悬停全走普通路径 ✓
  /* 🔴 2026-10-16 **「水域 · 边界」请回来了** ✗✗（用户点名要的 ✓ 见 handover §3.1）
   *   口径：水域边界开关**负责且仅负责**"水域之间（海洋/湖泊/河流/不可通行海域）的边界"✓
   *     水 ↔ 陆那条**海岸线不归它** ✓ 照旧归「地区 / 势力 · 边界」✓
   *   ⚠ 它不是"背景那条线"了 ✗ —— 是**真正一条独立通道**（着色器里那条 ✓）
   *     独立到"地区 / 势力 / 填色三个开关全关"它**照样在** ✓（想关就关自己那个勾 ✓）
   *   ⚠ 它跟 `showWaterName` 一样**每帧现读** ✓ —— 这个字段写的是"勾了没" ✓
   *     真正生效还要 AND 上"这张图算得出水陆"（见 syncLayerSwitches ✓）
   *   🔴🔴 **2026-10-17 用户改的默认值：默认关闭** ✗✗
   *     原话："默认关闭水域边界、名称"✓
   *     （2026-10-16 那版给的是 true ✓ 理由是"默认观感完全不变"✓
   *      现在用户要它默认关 ✓ → 开图时水与水之间那些缝**不画**、水名**不出** ✓
   *      想看得自己去勾 ✓ 这是他第二次改这俩的默认值了 ✗ 别再自作主张改回去 ✓）*/
  showWaterBorder: false,
  // 「名称」两件事：水那面旗**请回来当界面开关** ✓（2026-10-16 ✓）
  //   荒地那面旗字段仍保留但恒 false —— 用户这次只点名了水域 ✓（界面上没有它的勾 ✓）
  //   🔴 **2026-10-17 默认值同样改成关闭** ✗（同上 ✓）
  showWaterName: false,
  /* 🔴🔴 **「荒地 · 边界」那个勾**（2026-10-17 ✓ 用户点名要的 ✓）
   *   原话："给荒地加上边界开关，这个负责的是**荒地与荒地之间**的边界"✓
   *   ⚠ 跟「荒地 · 名称」**是两件事** ✗ —— 那个管名字，这个管缝 ✓
   *   ⚠ 默认**关闭** ✓（跟水域那两个一个口径 ✓ 用户 2026-10-17 定的默认值 ✓）*/
  showWasteBorder: false,
  showWasteName: false,
  /* 🔴 **荒地自动上色**（2026-10-17 重做 ✓）—— 用户点名要一个开关 ✓
   *   开：按「周边陆地最低地块」的显示色加权，严格过半才给这块荒地上色 ✓
   *   关：全部回退设置里「不可通行区域」那个色 ✓
   *   ⚠ **默认关闭** ✗（2026-10-17 用户定的 ✓ —— 想要上色自己勾 ✓）
   *   ⚠ 它只影响**自动算出来的那份色** ✗ —— 玩家直接涂在荒地上的色照旧优先 ✓ */
  wasteAuto: false,
  /* 荒地上色的运行时缓存（见 `buildWastePidIndex` / `refreshWasteAuto` ✓）
   *   · wastePidFlag：pid → 是不是荒地（1 = 是）
   *   · wasteFineTid：pid → 它最细层那个 wl_ 节点号（-1 = 不是荒地）
   *   · wastePerim：pid → [[邻居 pid, 共享边像素数], …]（只含陆地，水不算）
   *   · _wastePerimSeq：周长表换了一版就 +1（帧循环靠它重算 ✓）*/
  wastePidFlag: null,
  wasteFineTid: null,
  wastePidList: [],
  wastePerim: null,
  _wastePerimSeq: 0,
  _wasteCfgSeq: 0,
  painted: new Set(),          // **涂过的最细层节点**集合（`recomputePainted` 从每格反推的缓存 ✓）
  brushLabel: '请输入文本',      // 当前画笔的标记：默认就写这五个字 ✓（用户要求 ✓）
  titleName: new Map(),        // 头衔 → 改过的名字（改名工具写的）
  colorIndex: new Map(),
  labelTint: null,            // 势力名 → 它当前显示的颜色（「势力名取色」按钮给的 ✓）
  labelTintByName: null,      // 同上，按名字索引（喂给标签层用 ✓）       // 颜色 '同色的头衔列表（手动输入颜色时消歧义用）
  adjacency: null,             // 省份邻接表（CSR'
  provPos: null,               // 各省质心 + 像素'
  provTitle: null,             // 省份 '最后涂它的头衔（Int32Array'
  provLabel: null,             // 省份 '涂它那支笔的标记编号（Int32Array'1 未涂'
  labelNames: [],              // 标记编号 '名字
  labelIds: new Map(),         // 名字 '标记编号
  paintBlocks: [],             // 手绘层切出来的连通色'
  recent: [],
  changed: new Set(),
  history: { undo: [], redo: [] },
  hover: { pid: 0, tids: [], inside: false },
  cam: { cx: 0, cy: 0, scale: 1 },
  focus: null,          // 搜索定位后短暂高亮的头衔
  focusUntil: 0,
};

let renderer = null;
let labels = null;
let labelDirty = true;
let blocksDirty = true;     // 涂色后标脏，下一帧重算连通色'
let NO_TITLE = 65535;
let panning = null;
let painting = false;

// ================================================================ 小工具

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hex2 = (n) => n.toString(16).padStart(2, '0');
const rgbToHex = (c) => '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
const sameColor = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
/** 数组里有没有这一项 —— 只给冷路径（启动、构建索引）用 */
const hasIn = (arr, v) => !!arr && arr.indexOf(v) >= 0;

function hexToRgb(s) {
  if (typeof s !== 'string') return null;      // 空输入 / 非字符串：别让 trim 崩掉 ✓
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---------------------------------------------------------------- 快查表
//
// 底下几张表全是**同一件事**：把"每次都要 indexOf 扫一遍"的成员判断，
// 换成建一次就 O(1) 的查表 ✓
//
// 为什么要紧：荒地（EU5 1819 块）、无男爵领（CK3 上万块）这些名单原来长这样 ——
//   `(state.meta.wasteland || []).indexOf(tid) >= 0`
// 它散落在**悬停、取色、涂色、锁判定、荒地那一趟、显示色**里头，
// 全在"鼠标一动 / 每帧 / 每格"的路径上 ✗
// 而 indexOf 是线性扫：1819 项的名单 × 每帧几万次调用 = 白烧的几毫秒 ✓
// （EU5 那 1818 块荒地正是这么撞上来的 ✓）
//
// 名字统一带个 W，跟 state.meta.wasteland 那份原始数组区分开：
// **原始数组照旧留着**（烘数据的字段、导出、测试都在看它 ✓），
// 这里只是给它配一张查表 ✓

/** 键是不是以某个前缀开头（null 安全） */
const keyStarts = (key, prefix) => String(key == null ? '' : key).indexOf(prefix) === 0;

/** 「不可通行海域」的判据（CK3 的 #impassable_sea 那种）—— 它是**水**，跟海一个待遇
 *
 *  三个地方各判过一次（isLocked / 悬停 / 高亮），写法一模一样 ✓ 收在这里 */
const isImpassSeaKey = (key) => {
  const s = String(key == null ? '' : key);
  return s.indexOf('#impassable') === 0 && s.indexOf('sea') >= 0;
};

/** 「这一格的键是不是**水**」—— 海 / 湖 / 河，以及 CK3 那种「不可通行海域」
 *
 *  判据在项目里出现过四次（悬停卡片 / 侧栏 / 高亮 / 名字过滤），
 *  每次都要把四个前缀挨个 startsWith 一遍 ✓ 收成一处，
 *  以后多一种水（比如运河）只改这里 ✓ */
const isWaterKey = (key) => {
  const s = String(key == null ? '' : key);
  return isImpassSeaKey(s)
    || s.indexOf('#sea') === 0 || s.indexOf('#lake') === 0 || s.indexOf('#river') === 0;
};

/** 🔴🔴 **这一格是不是水 —— 按 pid 查"水域标签"** ✗✗（2026-10-14 ✓ 用户要求 ✓）
 *
 *   用户原话："你就不能把水域变成一个**仅仅是不能填色的地块**吗……
 *     而且**最底层的单位也有自己的 Province id**"
 *     "只是水域**带一个小标签**来让他在**边界和颜色**等方面听从相关的开关"
 *
 *   → 水域**不再有伪头衔**（`#sea_e_0` 那种删了 ✓）——
 *     所以**不能**再靠"键名前缀"认它 ✓（那正是老办法 ✗）
 *     现在靠**这个函数**：拿 pid 去 `meta.waterMask` 里查一位 ✓
 *
 *   ⚠ 这是水域**唯一**的判据来源 ✗ —— 别的地方（颜色 / 边界 / 高亮）都该调它 ✓
 *     而不是各自 `startsWith('#sea')` ✓（那种写法在新包里**永远返回 false** ✓）
 *   ⚠ 老包没有 `waterMask` ✗ → 这个函数返回 false ✓
 *     调用方要**再退回** `isWaterKey(键)` 那条老路 ✓（见 `isWaterHere` ✓）
 *   ⚠ pid 无效（0 / NO_TITLE ✓）→ false ✓
 */
function isWaterPid(pid) {
  const wm = state.waterMask;
  if (!wm || pid == null) return false;
  const p = pid | 0;
  return p > 0 && p < wm.length && wm[p] !== 0;
}

/** **这一格是不是水** —— 新包查表 ✓ 老包退回键名前缀 ✓（两套判据收在一处）
 *
 *   ⚠ 顺序很重要 ✗：**先查表** ✓（新包唯一正确的判据 ✓）
 *     表没有才看键 ✓（老包 ✓）
 *   ⚠ 键也要判 ✗ —— 因为新包里**荒地**仍然有伪头衔（`#impassable_c_3` ✓）
 *     而 `isWaterKey` 会把 `#impassable_sea` 认成水 ✓ 那种键在新包里已经没有了 ✓
 *     留着是为了老包 ✓ 不是多余 ✓ */
function isWaterHere(pid, tid) {
  if (isWaterPid(pid)) return true;
  const T = state.titles || {};
  const k = (tid == null) ? '' : String((T.keys && T.keys[tid]) || '');
  return isWaterKey(k);
}

/** 这个键是不是**「每层一片」的那个伪头衔片**（`#sea_pr_57` / `#impassable_c_3` 那种 ✓）
 *
 *  2026-10-13 架构统一之后，海 / 湖 / 河 / 荒地**每一层各有各的节点** ✓
 *  一层的"片" = **该层同名地块的集合** ✓（见 build_tier_pieces.tier_pieces ✓）
 *  于是前端只认一条：**当前层那个 tid 是谁** ✓ —— 名字、边界、高亮全跟着层走 ✓
 *
 *  ⚠ **`wl_<地块号>` 不算** ✗ —— 那是荒地**最细层逐块**的节点 ✓
 *    它的名字得走 `meta.wastelandNames`（节点名在 CK3 那边只是类名"不可通行山地"✗，
 *    拿它当"具体名"会凭空多出悬停第二行 ✓ 用户明确要求去掉过 ✓）
 *
 *  ⚠ 老包（每层一片之前打的）里全世界的海共用一个 `#sea` ✗ → 这里判 false ✓
 *    那批包退回真名表那条老路（见 specificPlaceName / buildSeaLabelPoints ✓）
 */
const PIECE_KEY_RE = /^#[a-z_]+_[a-z]+_\d+$/;
const isTierPieceKey = (key) => PIECE_KEY_RE.test(String(key == null ? '' : key));

/** 伪头衔的**类名** —— 构建期那一层取不到真名时拿来充数的那些 ✓
 *  （来源是 build_tier_pieces 里 `tier_pieces(..., label)` 的 label ✓
 *    海 / 湖 / 河 / 不可通行 / 荒地各一个 ✓）
 *
 *  ⚠ 这些**不算"具体名"** ✗ —— 地图上的标、悬停的第二行都不该出现它们 ✓
 *    用户 2026-10-13 明确要求过：CK3 的荒地别拿"不可通行山地"充第二行 ✓
 *    海 / 湖 / 河同理：一片取不到真名的水域**就叫没名字** ✓ 不该顶着"海洋"两个字 ✓
 *    （实跑量出来的：TOT 的 rg 层会多出一个 212011 像素的「海洋」标 ✗
 *      —— 那一片在水名表里本来就没名字 ✓）
 */
const PSEUDO_CATEGORY_NAMES = new Set([
  /* ⚠ 这份名单是照**五个构建脚本的类别表**抄的 ✗（"#xxx" 那几行 ✓）——
   *   CK3：河流 / 湖泊 / 海洋 / 不可通行海域 / 不可通行山地 / 无归属荒地
   *   EU4：湖泊 / 海洋 / 不可通行荒地 · HOI4：湖泊 / 海洋
   *   VIC3：湖泊 / 海洋 / 不可通行 · EU5：湖泊 / 不可通行
   *   以后哪边加了新类别名，这边跟着补 ✓（漏一个就会有一片顶着类名出标 ✓ 踩过一次）*/
  '海洋', '湖泊', '河流', '不可通行', '不可通行海域', '不可通行山地',
  '不可通行区域', '不可通行荒地', '无归属荒地',
]);
const isPseudoCategoryName = (nm) => PSEUDO_CATEGORY_NAMES.has(String(nm == null ? '' : nm));

/** 重新给 meta 里那几张名单建快查表（boot 时调一次；meta 不变就一直是它） */
function buildMetaIndex() {
  const m = state.meta;
  if (!m) return;
  m.wastelandSet = new Set(m.wasteland || []);
  m.degradedSet = new Set(m.degradedBaronies || []);
}

/** 这块地的**最细层节点**是荒地吗（快查表；meta 没建表时退回原来的扫数组） */
function isWastelandTid(tid) {
  if (tid == null || tid === NO_TITLE) return false;
  const s = state.meta && state.meta.wastelandSet;
  return s ? s.has(tid) : hasIn(state.meta && state.meta.wasteland, tid);
}

/** 这个头衔是**荒地还是水域**的伪头衔？返回 'waste' / 'water' / null ✓
 *
 *  ⚠ **判据必须包含键名前缀** ✗ —— 只按 isWastelandTid 判会漏（2026-10-13 踩的 ✓）：
 *    `meta.wasteland` 里存的是**最细层**那些节点的 id ✗
 *    而标签是按**当前视图层**取的 —— 你在"地区"层看的时候 tid 是地区层的节点，
 *    拿去 isWastelandTid 一查当然不在名单里 ✗ 于是荒地名照画 ✓
 *    （用户报的"CK3 仍然会给荒地显示名字，很怪"正是这个 ✓）
 *  所以：键名（wl_ / #impassable）跟 isWastelandTid **两个都要看** ✓
 *  跟势力名那条过滤（下面 drawLabels 外头那处）保持同一个口径 ✓
 */
function isWasteOrWaterTid(tid) {
  if (tid == null || tid === NO_TITLE) return null;
  const k = String((state.titles && state.titles.keys && state.titles.keys[tid]) || '');
  if (isWaterKey(k)) return 'water';
  if (isWastelandTid(tid) || keyStarts(k, 'wl_') || keyStarts(k, '#impassable')) return 'waste';
  return null;
}

/** **要不要给这类伪头衔标名字**（荒地 / 水域 ✓ 2026-10-13 用户定的规矩）
 *
 *   · **CK3 一律不标** ✗（2026-10-13 用户当年点名的规矩 ✓ 只对 CK3 ✓）
 *
 *   · **CK2 标** ✓（2026-10-15 用户定 ✓ —— CK2 是**独立的模式**，不是"CK3 加个别名" ✗）
 *     依据（两条，都是游戏数据里的实情 ✓）：
 *       ① CK2 的 ``default.map`` 里 ``sea_zones`` / ``major_rivers`` 也只是**一串地块号** ✓
 *          同样没有"每片海叫什么"这一级 ✓ —— **这一点跟 CK3 一样** ✓
 *          但那正是要点：CK3 那条"没有真名就一个都不标"是**当年只给 CK3 定的** ✓
 *          不是"P 社游戏通例" ✗ 别顺手扩到别人头上 ✓
 *       ② 编辑器这边**有东西可标** ✓：每一片水 / 荒地都有节点（``#sea_e_3`` / ``wl_<pid>`` ✓
 *          名字是 ``#<地块号>`` 占位 ✓），前端会把占位换成**类别名**（海洋 / 河流 / 无归属荒地 ✓
 *          见 ``isPseudoCategoryName`` 那段 ✓）—— 跟 EU4/EU5/HOI4/VIC3 的待遇一致 ✓
 *     ⚠ 想改回"跟 EU4 一样听开关的"：把下面 CK2 那一行删掉就行 ✓（那时它就走开关 ✓
 *       而那两个开关的出厂值是 false ✓ 于是地图上就不标了 ✓）
 *
 *   · 其他游戏看各自的「名称」开关 ✓
 */
function pseudoNameAllowed(kind) {
  if (!kind) return true;
  const _g = String((state.meta && state.meta.game) || '');
  if (_g === 'ck3') return false;
  if (_g === 'ck2') return true;          // CK2 独立口径：水与荒地照常标名 ✓
  if (kind === 'water') return !!state.showWaterName;
  return !!state.showWasteName;
}

/** **所有**前缀命中的头衔序号（`#sea` → 每一层的每一片 ✓）——
 *  建"伪头衔标签位置"那类**要把整类捞全**的地方用 ✓ */
function titleIndicesByPrefix(prefix) {
  const out = [];
  if (!state.titles) return out;
  const K = state.titles.keys || [];
  const p = String(prefix == null ? '' : prefix);
  if (!p) return out;
  for (let i = 0; i < K.length; i++) if (String(K[i]).indexOf(p) === 0) out.push(i);
  return out;
}

/**
 * 浮条（toast）—— **整个关掉了** ✗（用户：这些提示都去掉好了）
 *
 * 为什么是"关掉"而不是"一条条删"：
 *   二十几条文案留着，以后想开回来（或者自己改词）改一个 false 就够了 ✓
 *   删掉的话，那些话就永远找不回来了 ✗
 *
 * 出错的情况**不静默**：往控制台留一行 ✓
 *   这样界面上干干净净 ✓ 真出毛病时按 F12 也查得到原因 ✓
 *   （玩家看不到 = 不打扰 ✓ 我们自己排查时还在 ✓）
 */
const TOAST_OFF = true;

let toastTimer = 0;
function toast(msg, isErr = false) {
  if (isErr) console.warn('[提示] ' + msg);
  if (TOAST_OFF) return;                      // 开关关着 → 什么都不显示 ✓
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ================================================================ 查表

function provinceAt(mx, my) {
  const meta = state.meta;
  if (!meta || !(meta.mapWidth > 0) || !(meta.mapHeight > 0)) return 0;
  const x = Math.floor(mx);
  const y = Math.floor(my);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  if (x < 0 || y < 0 || x >= meta.mapWidth || y >= meta.mapHeight) return 0;
  // 分块（EU5 原尺寸）：真数据在块里，整图 id 只是个占位 ✗
  if (state.tileMap) {
    if (state.tileMap.has(x, y)) return state.tileMap.at(x, y);
    state.tileMap.get(Math.floor(y / state.tiles.tileH),
                      Math.floor(x / state.tiles.tileW)).catch(() => {});
    return 0;                       // 这一块还没到，先当空；下一帧就正常
  }
  return state.provinceIds ? state.provinceIds[y * meta.mapWidth + x] : 0;
}

/** 取 `(pid, tier)` 那一格的归属 —— **越界一律给 NO_TITLE** ✓
 *
 *  它在全图扫 / 悬停 / 标签里被调几千上万次 —— 加几道边界判断很便宜，
 *  换来的是"数据没齐 / 层数对不上 / 地块号越界"时不会整个功能 TypeError ✓
 *  （以前直接 `state.titlemap[tier * n + pid]`：越界读到隔壁层的值 = 静默认错归属 ✗）
 */
function titleAt(pid, tier) {
  if (!(pid > 0)) return NO_TITLE;
  const meta = state.meta, tm = state.titlemap;
  if (!meta || !tm) return NO_TITLE;
  const n = meta.numProvinces | 0;
  const t = tier | 0;
  if (n <= 0 || t < 0 || pid >= n) return NO_TITLE;
  const i = t * n + pid;
  return i < tm.length ? tm[i] : NO_TITLE;
}

/** **这一格在"最细层"的头衔号** ✓（2026-10-17 加的 ✓）
 *
 *  用途：**荒地名按最细层分组**（用户定的 ✓）
 *    "所有荒地都应该按**最细层级**分组"✓
 *
 *  ⚠ 为什么荒地要单独取一层 ✗✗：它在**粗层是不切的**——
 *    实测 EU5：那 8 块亚马逊荒地在 `1337 / blank / reg / area / prov`
 *    **五层上全都是同一个伪头衔**（键 `#impassable` · tid 36188 ✓）
 *    只有最细的 `loc` 层才分成 8 个（`amazon_jungle` / `madeira_amazon_jungle` … ✓）
 *    → 用当前层分组的话，8 个地点永远并成一个标 ✓
 *      （用户原话："明明有很多个叫亚马逊丛林的荒地地点，可是却只显示了一个名字"✓）
 *
 *  ⚠ **层数读 `meta.tiers.length`，不许读 `TIER_COUNT`** ✗✗ ——
 *    那个模块变量初值 5、要等 boot 靠后才是真值 ✓（为它栽过好几次了 ✓）
 *  ⚠ 越界 / 取不到就回落到"当前层"✓（老包 / 数据不全时不至于整片没标 ✓）
 *
 *  @param {number} pid
 *  @param {number} fallbackTier 取不到最细层时用哪一层
 *  @returns {number} 头衔号（可能是 `NO_TITLE` ✓）*/
function titleAtFinest(pid, fallbackTier) {
  const nt = (state.meta && Array.isArray(state.meta.tiers)) ? state.meta.tiers.length : 0;
  if (!nt) return titleAt(pid, fallbackTier | 0);
  const t = titleAt(pid, nt - 1);
  if (t == null || t < 0 || t === NO_TITLE) return titleAt(pid, fallbackTier | 0);
  return t;
}

/** **「标签藏起来」的那批头衔**（2026-10-17 ✓ 用户点名要的"掩耳盗铃"那条 ✓）
 *
 *  用户原话："如果一个属于水域的地点的像素位于地图**左右两侧都有**，
 *            就不要让**它的名字**显示，也不要让**包含这个地点的上层水域**的名字显示"✓
 *  动机（也是他说的）：EU5 没在日期变更线切，那几块地自己就横跨整幅图 →
 *    名字的"中心"会落到地图正中央、跟它实际那片水没关系 ✓
 *    与其把位置算法做复杂，不如**这种名字干脆别显示** ✓（原话："掩耳盗铃"✓）
 *
 *  ⚠ **判据只扫左右两列** ✗✗ —— 别看"这个头衔的像素 x 范围是不是 0~W-1" ✓
 *    原因：**横跨的那一块，在光栅上就是"左列也有它、右列也有它"** ✓（直接指标 ✓）
 *    而"x 范围 0~W-1"是**间接指标**（别的块凑巧占满两端也会满足 ✓ 会误伤 ✓）
 *    实测（EU5）：夏威夷那几块 + 白令的 `inchoun_coast` / `kialegak_cape` ✓
 *    成本：两列 × 图高 ≈ 8000 次读 ✓ 一次性 ✓ 换图才重算 ✓
 *
 *  ⚠ **"含它的上层"怎么算** ✗：拿**横跨地的 pid**，把它**每一层**的头衔都收进来 ✓
 *    —— 上级片的像素本来就是子片的并集 ✓ 所以从最细层往粗层一遍收齐就够 ✓
 *    这样这个 Set 里既有"横跨的那个地点"，也有**它所有的上级水域** ✓
 *  ⚠ 收的是**所有**头衔（不分水域 / 陆地）✗ —— 调用方自己按需取 ✓
 *    （用户点名的是水域 ✓ 陆地那边不查这个 Set ✓）
 *
 *  ⚠ **只在算得出像素图时算** ✗（分块模式 `provinceIds` 是占位数组 ✓）
 *    算不出 → 空 Set → 一个字都不藏 ✓ 行为跟改造前一模一样 ✓
 *
 *  @returns {Set<number>} 要藏掉名字的头衔号
 */
function buildCrossSeamTids() {
  const out = new Set();
  const meta = state.meta, tm = state.titlemap, ids = state.provinceIds;
  const W = (meta && meta.mapWidth) | 0, H = (meta && meta.mapHeight) | 0;
  const nT = (meta && Array.isArray(meta.tiers)) ? meta.tiers.length : 0;
  if (!meta || !tm || !nT || !(W > 1) || !(H > 0)) return out;
  /* 分块模式：`provinceIds` 是个占位（长度 1）→ 认不出，直接返回空 ✓ */
  if (!ids || ids.length < W * H) return out;

  /* ① **左右两列都出现过的地块** = 横跨 ✓（一次扫两列 ✓）*/
  const seenL = new Set(), seenR = new Set();
  for (let y = 0; y < H; y++) {
    const a = ids[y * W];
    if (a) seenL.add(a);
    const b = ids[y * W + W - 1];
    if (b) seenR.add(b);
  }
  if (!seenL.size || !seenR.size) return out;
  const crossPid = new Set();
  for (const p of seenL) if (seenR.has(p)) crossPid.add(p);
  if (!crossPid.size) return out;

  /* ② 横跨地 **每一层**的头衔全收进来 ✓（`titlemap` 排布 = tid * numProvinces + pid）*/
  const n = meta.numProvinces | 0;
  if (!n) return out;
  for (const p of crossPid) {
    for (let t = 0; t < nT; t++) {
      const q = tm[t * n + p];
      if (q != null && q !== NO_TITLE && q >= 0) out.add(q);
    }
  }
  return out;
}

function titleInfo(tid) {
  if (tid === NO_TITLE || tid == null) return null;
  const t = state.titles;
  return {
    tid,
    key: t.keys[tid],
    tier: t.tiers[tid],
    name: t.names[tid],
    nameEn: t.namesEn ? t.namesEn[tid] : '',   // 中文名底下挂个原名，鼠标停上去能'
    color: t.colors[tid],
  };
}

function isChanged(tid) {
  return state.changed.has(tid);
}

// ================================================================ 颜色

/**
 * 换画笔颜色。
 *
 * `fromPick = true` 表示这一下是**取色**（搜索里点色块 / 右键 / 吸管 / 调色板 ✓）——
 * 那才会**顺便切到画图工具** ✓（用户要求：取完色直接就能涂 ✓）
 * 其余情况（初始化、手动输色、程序里设色）只换颜色，**不动工具** ✗
 *
 * 切到哪个由设置决定（设置页「取色后切到」：**涂抹** / **填色**，默认涂抹 ✓）；
 * **已经在画图工具上（涂抹 / 填色）就不动** ✓ ——
 * 正在填色时取个色，不该被踹去涂抹 ✗（画画的人最烦这个 ✓）
 */
function setBrush(rgb, remember = true, fromPick = false) {
  state.brush = [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0];
  $('brush-swatch').style.background = rgbToHex(state.brush);
  $('brush-hex').value = rgbToHex(state.brush);
  $('brush-r').value = state.brush[0];
  $('brush-g').value = state.brush[1];
  $('brush-b').value = state.brush[2];
  if (remember) pushRecent(state.brush);
  if (fromPick && state.tool !== 'paint' && state.tool !== 'fill') {
    setTool((state.set && state.set.pickTool) === 'fill' ? 'fill' : 'paint');
  }
}

/** 标记名字 → 编号（连通块按标记分堆，比字符串比较省事）*/
function labelIdOf(name) {
  let id = state.labelIds.get(name);
  if (id == null) {
    id = state.labelNames.length;
    state.labelNames.push(name);
    state.labelIds.set(name, id);
  }
  return id;
}

/** 设定画笔的标记（涂色时写进手绘层，色块上标的就是它） */
function setBrushLabel(name) {
  state.brushLabel = name || '';
  $('brush-label').value = state.brushLabel;
}

/** 原始色 → 同色头衔列表，手动输入颜色时要靠它消歧义 */
function buildColorIndex() {
  state.colorIndex = new Map();
  state.tagColorIndex = new Map();     // 颜色 → tag（含没地盘的 ✓）
  const t = state.titles;
  // 剧本层数：有剧本层的模式（现在**每一套都有** ✓ 见 build_data 的 eraDates 那段）
  // 只把**剧本层那些头衔**（国家 / 1066 政权）收进"颜色 → 头衔"表 ✓
  // 地区层（帝国/王国/…）的颜色取色时匹配到它们没意义（一堆同色杂项 ✗）
  const _nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  for (let i = 0; i < t.keys.length; i++) {
    if (t.tiers[i] >= TIER_COUNT) continue;       // 海/湖/荒地那些伪头衔：不算 ✓
    if (_nEra > 0 && t.tiers[i] >= _nEra) continue;
    const o = t.colors[i];
    const key = (o[0] << 16) | (o[1] << 8) | o[2];
    let list = state.colorIndex.get(key);
    if (!list) { list = []; state.colorIndex.set(key, list); }
    list.push(i);
  }
  // 全部 tag 的颜色也进来（没地盘的 tag 颜色照样能用 ✓）
  const ctags2 = (state.meta && state.meta.countryTags) || null;
  if (ctags2) {
    for (const tag of Object.keys(ctags2)) {
      const c = (ctags2[tag] || {}).c;
      if (!c) continue;
      const k2 = (c[0] << 16) | (c[1] << 8) | c[2];
      let l2 = state.tagColorIndex.get(k2);
      if (!l2) { l2 = []; state.tagColorIndex.set(k2, l2); }
      l2.push(tag);
    }
  }
  // 每组按层级从高到低排，消歧义时帝国排在王国前面
  for (const list of state.colorIndex.values()) list.sort((a, b) => t.tiers[a] - t.tiers[b]);
}

/**
 * 手动输入的颜色没有「取色来源」。去数据里查同色的头衔：
 * 唯一就直接用它当标记，多个就让玩家挑一个，一个都没有就用色值
 */
function labelForColor(rgb) {
  const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  const list = state.colorIndex.get(key) || [];
  const box = $('label-pick');
  const sel = $('label-select');

  if (!list.length) {
    box.hidden = true;
    // 取色**不改标记** ✓（用户要求）
    return;
  }
  if (list.length === 1) {
    box.hidden = true;
    // 取色**不改标记** ✓
    return;
  }

  sel.innerHTML = '';
  for (const tid of list) {
    const op = document.createElement('option');
    op.value = String(tid);
    op.textContent = `${state.titles.names[tid]}（${state.titles.keys[tid]}）`;
    sel.appendChild(op);
  }
  box.hidden = false;
  // 只定"这一笔叫什么" ✓ —— 取色**不跳镜头、不选地盘**（那是搜索定位那条路的事 ✓）
  // 取色**不改标记** ✓
}

/** 手动改颜色：设色 + 重新定标记 */
function onManualColor(rgb) {
  setBrush(rgb);
  labelForColor(rgb);
}

/**
 * 搜索结果那个**色点**该显示什么色 ✓
 *
 * **跟画面上一致**：涂过的显涂色、没涂的显数据色 ✓
 *（用户报的"最近用的颜色没更新搜索框"就是这个 ✗ ——
 *  以前直接取 `titles.colors[tid]`，那是**数据色**，你涂过它也不会变 ✓）
 *
 * 一个头衔名下可能有好几种涂色（1936 那半壁法国 ✗），取**第一块涂过的**当代表 ✓
 */
function swatchColorOf(tid) {
  const c = state.titles.colors[tid];
  const pd = renderer && renderer.paintData;
  const tm = state.titlemap;
  const n = state.meta ? state.meta.numProvinces : 0;
  const tier = state.titles.tiers[tid];
  if (pd && tm && n && tier >= 0 && tier < TIER_COUNT) {
    const row = tier * n;
    for (let q = 1; q < n; q++) {
      if (tm[row + q] !== tid) continue;
      if (pd[q * 4 + 3] > 0) return [pd[q * 4], pd[q * 4 + 1], pd[q * 4 + 2]];
    }
  }
  return c || [128, 128, 128];
}

/**
 * **按名字**找"玩家给它涂过什么色" ✓
 *
 * 国家行（搜 tag 那种）手里只有 tag 和名字、**没有地块编号** ——
 * 可它本来就有名字啊 ✓ 而手绘层是按"标记名"记的（`labelNames[provLabel[q]]` ✓），
 * 拿名字对一下就知道玩家涂过没有 ✓ 不用绕地块编号 ✓
 *
 * 没涂过返回 null（调用方退回数据色 ✓）
 */
function paintedColorByName(name) {
  const nm = String(name || '');
  if (!nm || !state.labelNames || !state.provLabel) return null;
  const lid = state.labelNames.indexOf(nm);
  if (lid < 0) return null;
  const pd = renderer && renderer.paintData;
  const pl = state.provLabel;
  const n = state.meta ? state.meta.numProvinces : 0;
  if (!pd) return null;
  for (let q = 1; q < n; q++) {
    if (pl[q] !== lid) continue;
    if (pd[q * 4 + 3] > 0) return [pd[q * 4], pd[q * 4 + 1], pd[q * 4 + 2]];
  }
  return null;
}

/** **只记颜色，不记标记** ✓（用户定的：节约一点 ✓）
 *  原来存的是 { rgb, label } ✗ 而点它的候还会把标记一起恢复 ✓
 *  → 但"最近取色"本来就是个**颜色**记忆 ✗ 不该顺手改掉你当前的标记名 ✓
 *  ⚠ 老存档里多出来的 label 字段**忽略即可** ✓ 不用做迁移 ✓
 *    （读进来是 { rgb, label } 的对象也照样能用 —— 只读 .rgb ✓）*/
function pushRecent(rgb) {
  const key = rgb.join(',');
  const entry = { rgb: rgb.slice() };
  state.recent = state.recent.filter((c) => c.rgb.join(',') !== key);
  state.recent.unshift(entry);
  if (state.recent.length > 24) state.recent.length = 24;
  renderPalette();
}

/** 清空「最近用过」的颜色 ✓（用户要求给个按钮 ✓）
 *  ⚠ 这份记忆是**跟着设置持久化**的 ✓ —— 清完必须**落盘** ✗
 *    只清内存的话刷新一下它又回来了 ✓（跟当年那个"涂色删不掉"是同一类坑 ✓）*/
function clearRecent() {
  state.recent = [];
  renderPalette();
  saveMapPrefs();
}

function renderPalette() {
  const box = $('palette');
  box.innerHTML = '';
  if (!state.recent.length) {
    box.innerHTML = '<p class="empty">取过的颜色会留在这里</p>';
    return;
  }
  for (const e of state.recent) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.background = rgbToHex(e.rgb);
    /* ⚠ 只设颜色 ✗ 不动标记 —— 跟上面 pushRecent 存的东西对齐 ✓ */
    chip.onclick = () => { setBrush(e.rgb, false, true); };
    box.appendChild(chip);
  }
}

/**
 * 一个头衔此刻该往 GPU 的 LUT 里写什么颜色
 *
 * **LUT 里放的是「当前这一层该显示的颜色」，不是「头衔的颜色」**，两者在有涂色时
 * 不一样：`state.titles.colors` 记的是玩家改过的颜色（导出、悬停卡片、取色都用它），
 * 但关掉「填色·颜色」时，画面上必须露出**游戏原色** —— 不然玩家填的色
 * 就永远藏不掉（LUT 里那份改过的颜色还在那儿顶着）
 */
function lutColorOf(tid) {
  return state.titles.colors[tid];     // 原色就是数据里那一份 ✓（以前还额外存了一份 original ✗）
}

/**
 * 荒地"没上色"的样子 = 这个灰（跟渲染器的 uWasteGrey 是同一份）✓
 *
 * 为什么不直接用 titles.colors[tid]：**EU5 的荒地节点在数据里是给省份位图用的
 * 技术色** —— 1819 块里 1818 块五颜六色，连同一个"代赫纳沙漠"的两块颜色都不一样，
 * 屏幕上从来不该按它显示。CK3/EU4 那份数据本来就写的是这个灰，所以两边行为一致 ✓
 * （荒地自动上色那套已退役 ✓ 这份灰现在只当 LUT 的「起手色」用 ✓）
 */
function wasteGrey() {
  /* 🔴 **改成读设置里那一行** ✗✗（2026-10-15 ✓ 用户要求"七行颜色可调" ✓）
   *   「不可通行区域」出厂还是 **94,94,94** ✓（跟数据里 wl 节点写的一致 ✓
   *     所以什么都不动的话，观感跟以前一个字节不差 ✓）
   *   改设置 → `applySettings()` → `applyNatureColors()` 会把这几类重刷一遍 ✓ */
  return natureColor('impass');
}












/** 把每块荒地的 LUT 刷成"荒地灰"（= 它没上色的样子）✓ */
function paintWasteGrey() {
  if (!renderer || !renderer.setLutColor || !state.meta) return 0;
  const w = wasteGrey();
  let n = 0;
  for (const t2 of (state.meta.wasteland || [])) {
    if (t2 < 0) continue;
    renderer.setLutColor(t2, w[0], w[1], w[2]);
    n++;
  }
  if (n) renderer.dirty = true;
  return n;
}

/* ============================================================================
 * **荒地自动上色**（2026-10-17 推翻重做 ✓）
 *
 * 用户口径（原话整理）：
 *   ① 检查每块荒地周边**所有陆地最低地块**（EU4 是 province，CK3 是男爵领那级）；
 *   ② 每个邻居按优先级取色：
 *        · 剧本视图：玩家涂色 → 当前剧本色（**不再看地区色** ✗ 2026-10-17 用户定的）
 *        · 非剧本视图：玩家涂色 → 当前视图上该地块所属头衔的颜色；
 *   ③ 按**共享边长**加权，某种颜色**严格过半**才给这块荒地；
 *   ④ 没有过半 / 一个可用颜色都没有（开关全关）→ 回退设置里「不可通行区域」那个色；
 *   ⑤ 玩家直接涂在荒地上的色优先显示；
 *   ⑥ 其他荒地也按已经算出的颜色投票，并**逐圈传染**到稳定。
 *
 * 实现要点：
 *   · 颜色写在**每块荒地自己的最细层节点**（`wl_<pid>`）的 LUT 上 ✓
 *     粗层荒地块是同名几块共用的，写上去会互相踩 ✗
 *   · 着色器按 `uFineTier` 读它（见 gl.js 的 colorOfPid ✓）
 *   · 周长表 = pid → [[邻居, 共享边像素数]]，水不算；没有现成表就在开图时
 *     从省份 id 图扫一遍（CK3 42M 像素实测 0.08s ✓）
 *   · **每秒重算不读 LUT** ✗：用上一轮的独立快照做传染，避免"自己上一轮的色
 *     被当成邻居票"那种自环 ✓
 * ========================================================================== */

/** 建立"哪些 pid 是荒地"的快查表。返回荒地块数。 */
function buildWastePidIndex() {
  state.wastePidList = [];
  state.wastePidFlag = null;
  state.wasteFineTid = null;
  const meta = state.meta, tm = state.titlemap;
  const n = meta ? (meta.numProvinces | 0) : 0;
  if (!meta || !tm || !n || !Array.isArray(meta.tiers) || !meta.tiers.length) return 0;
  const fine = meta.tiers.length - 1;
  const flag = new Uint8Array(n);
  const fineTid = new Int32Array(n).fill(-1);
  const list = [];
  for (let pid = 1; pid < n; pid++) {
    const tid = tm[fine * n + pid];
    if (tid == null || tid === NO_TITLE || !isWastelandTid(tid)) continue;
    flag[pid] = 1;
    fineTid[pid] = tid;
    list.push(pid);
  }
  state.wastePidFlag = flag;
  state.wasteFineTid = fineTid;
  state.wastePidList = list;
  return list.length;
}

/** 这个 pid 是不是水（周长只统计陆地 ✓） */
function _wasteIsWaterPid(pid) {
  const wm = state.waterKindArr;
  if (wm && pid < wm.length) return wm[pid] !== 0;
  return isWaterPid(pid);
}

/** 往周长累加器里记一条"两侧地块之间的边"。两个方向各记一次。 */
function _wasteAddEdge(acc, a, b) {
  if (!(a > 0) || !(b > 0) || a === b) return;
  const flag = state.wastePidFlag;
  if (!flag) return;
  if (_wasteIsWaterPid(a) || _wasteIsWaterPid(b)) return;
  if (flag[a]) {
    let m = acc.get(a);
    if (!m) { m = new Map(); acc.set(a, m); }
    m.set(b, (m.get(b) || 0) + 1);
  }
  if (flag[b]) {
    let m = acc.get(b);
    if (!m) { m = new Map(); acc.set(b, m); }
    m.set(a, (m.get(a) || 0) + 1);
  }
}

/** Map<pid, Map<nb, 边数>> → Map<pid, [[nb, 边数], …]>（边多的排前面） */
function _wasteFinishPerimeter(acc) {
  const out = new Map();
  for (const [pid, m] of acc) {
    const arr = [];
    for (const [nb, c] of m) arr.push([nb, c]);
    arr.sort((x, y) => y[1] - x[1]);
    if (arr.length) out.set(pid, arr);
  }
  return out;
}

/** 从完整的省份 id 图扫出荒地周长（4 邻接，水边不算） */
function buildWastePerimeterFromIds(ids, W, H) {
  const acc = new Map();
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W - 1; x++) {
      const a = ids[row + x], b = ids[row + x + 1];
      if (a !== b) _wasteAddEdge(acc, a, b);
    }
  }
  for (let y = 0; y < H - 1; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const a = ids[row + x], b = ids[row + W + x];
      if (a !== b) _wasteAddEdge(acc, a, b);
    }
  }
  return _wasteFinishPerimeter(acc);
}

/** 没有像素图时的退路：邻接表，每条边先按 1 计（分块图等真周长算完会替换） */
function buildWastePerimeterFromAdjacency() {
  const out = new Map();
  const adj = state.adjacency;
  const n = state.meta ? (state.meta.numProvinces | 0) : 0;
  if (!adj || !n || !state.wastePidList) return out;
  const offsets = new Uint32Array(adj.buffer, adj.byteOffset, n + 1);
  const neighbors = new Uint16Array(adj.buffer, adj.byteOffset + (n + 1) * 4);
  for (const w of state.wastePidList) {
    const arr = [];
    for (let k = offsets[w], e = offsets[w + 1]; k < e; k++) {
      const nb = neighbors[k];
      if (!(nb > 0) || nb >= n || _wasteIsWaterPid(nb)) continue;
      arr.push([nb, 1]);
    }
    if (arr.length) out.set(w, arr);
  }
  return out;
}

/**
 * 分块图（EU5 原尺寸）的精确周长：逐行取块，算块内 + 块缝的边。
 * 一次只留两行块（4×2 块 ≈ 134 MB 解压态），取完就放 ✓
 */
async function buildWastePerimeterFromTiles(tm, tiles) {
  const acc = new Map();
  const cols = tiles.cols | 0, rows = tiles.rows | 0;
  const tw = tiles.tileW | 0, th = tiles.tileH | 0;
  if (!(cols > 0) || !(rows > 0) || !(tw > 0) || !(th > 0)) return acc;

  const loadRow = async (r) => {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = await tm.get(r, c);
    return row;
  };

  let cur = await loadRow(0);
  for (let r = 0; r < rows; r++) {
    const next = (r + 1 < rows) ? await loadRow(r + 1) : null;
    for (let c = 0; c < cols; c++) {
      const t = cur[c];
      if (!t) continue;
      for (let y = 0; y < th; y++) {
        const base = y * tw;
        for (let x = 0; x < tw - 1; x++) {
          const a = t[base + x], b = t[base + x + 1];
          if (a !== b) _wasteAddEdge(acc, a, b);
        }
      }
      for (let y = 0; y < th - 1; y++) {
        const base = y * tw;
        for (let x = 0; x < tw; x++) {
          const a = t[base + x], b = t[base + tw + x];
          if (a !== b) _wasteAddEdge(acc, a, b);
        }
      }
      // 右边缝：本块最后一列 ↔ 右边那块第一列
      const rt = (c + 1 < cols) ? cur[c + 1] : null;
      if (rt) {
        for (let y = 0; y < th; y++) {
          const a = t[y * tw + tw - 1], b = rt[y * tw];
          if (a !== b) _wasteAddEdge(acc, a, b);
        }
      }
      // 下边缝：本块最后一行 ↔ 下面那块第一行
      const bt = next ? next[c] : null;
      if (bt) {
        for (let x = 0; x < tw; x++) {
          const a = t[(th - 1) * tw + x], b = bt[x];
          if (a !== b) _wasteAddEdge(acc, a, b);
        }
      }
    }
    cur = next;
    // 让一让：别把主线程按住几百毫秒
    await new Promise((res) => setTimeout(res, 0));
  }
  return _wasteFinishPerimeter(acc);
}

/** 开图时把周长表准备好（有像素图立刻算；分块图先给近似，后台再算精确） */
function setupWastePerimeter() {
  const nWaste = buildWastePidIndex();
  state.wastePerim = new Map();
  state._wastePerimSeq = (state._wastePerimSeq || 0) + 1;
  if (!nWaste) return 0;

  const meta = state.meta;
  const ids = state.provinceIds;
  const W = meta.mapWidth | 0, H = meta.mapHeight | 0;

  // ① 老包/新包如果已经烘了周长表，优先用它（只认确实是荒地的那些 pid）
  const baked = meta.wastelandPerimeter;
  if (Array.isArray(baked) && baked.length) {
    const out = new Map();
    for (const e of baked) {
      if (!Array.isArray(e) || e.length < 2) continue;
      const pid = e[0] | 0;
      if (!(pid > 0) || !state.wastePidFlag[pid]) continue;
      const arr = [];
      for (const pair of (e[1] || [])) {
        const nb = pair && pair[0] | 0, c = pair && pair[1] | 0;
        if (nb > 0 && c > 0 && !_wasteIsWaterPid(nb)) arr.push([nb, c]);
      }
      if (arr.length) out.set(pid, arr);
    }
    state.wastePerim = out;
    return out.size;
  }

  // ② 有整张 id 图：直接扫（实测 CK3 42M 像素 0.08s）
  if (ids && W > 0 && H > 0 && ids.length >= W * H) {
    state.wastePerim = buildWastePerimeterFromIds(ids, W, H);
    return state.wastePerim.size;
  }

  // ③ 分块图：先按邻接表给个近似，开图后再后台算精确的
  state.wastePerim = buildWastePerimeterFromAdjacency();
  if (state.tileMap && state.tiles) scheduleTileWastePerimeter();
  return state.wastePerim.size;
}

/** 分块图的精确周长放到后台算，算完替换近似表并重算颜色 */
function scheduleTileWastePerimeter() {
  const tm = state.tileMap, tiles = state.tiles;
  if (!tm || !tiles) return;
  const token = (state._wasteTileToken = (state._wasteTileToken || 0) + 1);
  setTimeout(async () => {
    try {
      const per = await buildWastePerimeterFromTiles(tm, tiles);
      if (state.tileMap !== tm || state._wasteTileToken !== token) return;
      if (!per.size) return;
      state.wastePerim = per;
      state._wastePerimSeq = (state._wastePerimSeq || 0) + 1;
      state._wasteSig = null;
      if (renderer) renderer.dirty = true;
    } catch (e) {
      console.warn('荒地周长（分块）计算失败，继续用邻接近似：', e);
    }
  }, 600);
}

/** 一个邻居地块按用户口径该算成什么颜色（null = 这一票没有颜色） */
function wasteVoteColor(nb, prevAuto, isEra, regionTier) {
  const pd = renderer && renderer.paintData;
  // ① 玩家涂色（「填色 · 颜色」开着才算 ✓）
  if (state.showPaint && pd && nb > 0 && pd[nb * 4 + 3] > 0) {
    return [pd[nb * 4], pd[nb * 4 + 1], pd[nb * 4 + 2]];
  }
  const nReal = (state.meta && state.meta.numRealTitles != null)
    ? state.meta.numRealTitles : null;
  /* 老包没有 `numRealTitles` 时，至少把**荒地伪头衔**挡掉 ✓
   *   不然粗层那片荒地会拿自己的类色来投票，把自动色盖成灰 ✓ */
  const realTid = (t) => (t != null && t !== NO_TITLE
    && (nReal != null ? t < nReal : !isWastelandTid(t)));
  // ② 剧本视图：当前剧本有归属 → 剧本色（「势力 · 颜色」开着才算 ✓）
  if (isEra && state.showPowerColor) {
    const t = titleAt(nb, state.tier);
    if (realTid(t)) return state.titles.colors[t];
  }
  /* ③ 地区颜色（「地区 · 颜色」开着才算 ✓）
   *   🔴 **剧本模式开启时不再检查地区颜色** ✗✗（2026-10-17 用户定的 ✓）
   *     → 剧本视图里只认：玩家涂色 → 当前剧本色 → 其他荒地的传染色 ✓
   *       剧本没归属的邻居**不拿地区色来凑**（只进分母 ✓）
   *   → 非剧本视图里仍旧看当前视图层 ✓ */
  if (!isEra && state.showRegionColor) {
    const t = titleAt(nb, regionTier);
    if (realTid(t)) return state.titles.colors[t];
  }
  /* ④ 邻居也是荒地：用上一轮**真的算出了颜色**的那份（逐圈传染 ✓）
   *   ⚠ 回退灰不算票 ✗ —— 那代表"这块还没颜色"，只进分母 ✓
   *     （算成灰也投票的话，一大片荒地会互相堵住，颜色永远传不进去 ✓）*/
  if (state.wasteAuto && state.wastePidFlag && state.wastePidFlag[nb]) {
    const c = prevAuto.get(nb);
    if (c) return c;
  }
  return null;
}

/** 重算所有荒地的自动色，写进它们最细层节点的 LUT。返回真正变了的块数。 */
function refreshWasteAuto() {
  if (!renderer || !renderer.setLutColor || !state.titles || !state.meta) return 0;
  if (!state.wastePidList || !state.wastePerim || !state.wasteFineTid) return 0;
  const grey = wasteGrey();
  const fineTid = state.wasteFineTid;
  const lut = renderer.lutData;
  let n = 0;

  const writeGrey = () => {
    for (const pid of state.wastePidList) {
      const tid = fineTid[pid];
      if (tid < 0) continue;
      const i = tid * 4;
      if (lut[i] !== grey[0] || lut[i + 1] !== grey[1] || lut[i + 2] !== grey[2]) {
        renderer.setLutColor(tid, grey[0], grey[1], grey[2]);
        n++;
      }
    }
    return n;
  };
  if (!state.wasteAuto) return writeGrey();

  const nEra = eraTierCount();
  const isEra = state.tier >= 0 && state.tier < nEra;
  const nTier = (state.meta && Array.isArray(state.meta.tiers)) ? state.meta.tiers.length : 0;
  /* 地区颜色**只在非剧本视图里用** ✓（2026-10-17 用户定的：剧本模式不再检查地区色 ✗）
   *   → 这里就是当前视图层；粒度不再影响荒地取色 ✓ */
  let regionTier = state.tier;
  // 开图早期 `state.tier` 可能还是 -1：别拿它去索引归属表 ✓ 回落最细层 ✓
  if (!(regionTier >= 0 && regionTier < nTier)) regionTier = Math.max(0, nTier - 1);

  /* 固定点迭代：每一圈都拿**上一圈的快照**投票，避免遍历顺序影响结果。
   * 每圈最多往外传一环 ✓ 荒地链条可能很长（CK3 的山脉一串几十块 ✓）→ 上限给 32；
   * 真不收敛（两块互相投）就停在最后一圈 ✓ 正常情况几圈就稳定 ✓ */
  let prev = new Map();
  for (let pass = 0; pass < 32; pass++) {
    const next = new Map();
    for (const pid of state.wastePidList) {
      const per = state.wastePerim.get(pid);
      if (!per || !per.length) { next.set(pid, null); continue; }
      let total = 0;
      const votes = new Map();
      for (const pair of per) {
        const nb = pair[0], w = pair[1] || 0;
        total += w;
        const c = wasteVoteColor(nb, prev, isEra, regionTier);
        if (!c) continue;
        const key = ((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255);
        let v = votes.get(key);
        if (!v) { v = { w: 0, rgb: c }; votes.set(key, v); }
        v.w += w;
      }
      let best = null;
      for (const v of votes.values()) if (!best || v.w > best.w) best = v;
      // null = 没算出颜色（最终写回灰，但**不参与下一轮投票** ✓）
      next.set(pid, (total > 0 && best && best.w * 2 > total) ? best.rgb : null);
    }
    let same = next.size === prev.size;
    if (same) {
      for (const [pid, c] of next) {
        const p = prev.get(pid) || null;
        if ((p === null) !== (c === null)) { same = false; break; }
        if (p && c && (p[0] !== c[0] || p[1] !== c[1] || p[2] !== c[2])) { same = false; break; }
      }
    }
    prev = next;
    if (same) break;
  }

  for (const pid of state.wastePidList) {
    const tid = fineTid[pid];
    if (tid < 0) continue;
    const c = prev.get(pid) || grey;
    const i = tid * 4;
    if (lut[i] !== c[0] || lut[i + 1] !== c[1] || lut[i + 2] !== c[2]) {
      renderer.setLutColor(tid, c[0], c[1], c[2]);
      n++;
    }
  }
  return n;
}

/** 帧循环里比对签名：层 / 粒度 / 三个颜色开关 / 开关 / 涂色 / 设置色 变了就重算 */
function wasteWatch() {
  if (!renderer || !state.meta) return;
  const imp = state.set && state.set.impass;
  const sig = [
    state.tier | 0,
    state.grain == null ? 'x' : (state.grain | 0),
    state.showPaint ? 1 : 0,
    state.showPowerColor ? 1 : 0,
    state.showRegionColor ? 1 : 0,
    state.wasteAuto ? 1 : 0,
    state._paintSeq || 0,
    state._wastePerimSeq || 0,
    state._wasteCfgSeq || 0,
    imp ? imp.join(',') : '',
  ].join('|');
  if (state._wasteSig === sig) return;
  state._wasteSig = sig;
  refreshWasteAuto();
}

/** 切「填色·颜色」：LUT 里永远是游戏原色，所以这里只要重画一帧 */
// ---------------------------------------------------------------- 设置页
/** 设置页的出厂值（点「恢复默认」就回到这里） */
const SET_DEFAULTS = {
  /* 背景色 / 未上色色 **两项分开** ✓（2026-10-13 用户要求 ✓）
   *   bg        = 「背景颜色」默认 **180,180,180** ✓
   *   unpainted = 「未上色区域」默认 150,150,150 ✓（就是原来那层中性灰 ✓）*/
  bg: null, unpainted: null,
  /* 🔴 **七行颜色** ✗✗（2026-10-15 ✓ 用户定 ✓）—— 空白区域 / 无归属区域 +
   *   海 / 不可通行海域 / 湖 / 河 / 不可通行 ✓
   *   null = 用 `NATURE_RGB`（前三行另在 `_now()` 里给了 180 / 150 ✓）*/
  impass: null, sea: null, isea: null, lake: null, river: null,
  // 线宽五档 / 浓度四档（默认都取**标准那一档** ✓ 见 W_STEPS / PW_STEPS / CONC_STEPS）
  /* ⚠ **宽度默认一律 1.0** ✗（用户定的 ✓ 老几样当年是 1.5 ✓）
   *   浓度（pa/ra/ca）不动 ✓ 用户说的是"宽度都是 1.0" ✓
   * ⚠ **「地方边界宽度」2026-10-13 拆成两条** ✓（用户要求 ✓）：
   *   · wRegion = 「**地区**边界宽度」→ 管**父级边界**（多级链上层那些线 ✓）
   *   · wProv   = 「**省份**边界宽度」→ 管**子级边界**（本层那条线 ✓）
   *   默认都是 1 ✓ 跟原来那一条相等 —— 观感不变 ✓
   *   ⚠ 老的 `w` 还留着 ✗：老存档只有它，代码里两条都从它继承（见 syncParentBorder ✓）
   *     删了的话老用户那两根滑条会一夜回到默认 ✓ */
  wRegion: 1, wProv: 1, w: null,
  pa: 50, ra: 75, ca: 100, pw: 1,
  /* 🔴🔴 **字号拆成两块** ✗✗（2026-10-17 用户定的 ✓
   *   "把字号分开两个，一个给地块，一个给势力"✓）
   *   · `fontPlace` = 地块名（含海 / 湖 / 河 / 荒地名 ✓）
   *   · `fontPower` = 势力名（剧本 / 年份那几层 + 涂出来的色块名 ✓）
   *   ⚠ **老的 `font` 保留但不再读** ✗（老存档只有它 ✓
   *     迁移收在 `fontSizes()` 那一个口子里 ✓ —— 别在每处各写一遍 ✓）*/
  fontPlace: 1, fontPower: 1,
  /* **水域边界那一对**（2026-10-16 ✓ 用户定的 ✓）
   *   用户原话："新增一对滑条「水域边界宽度 / 浓度」（**不沿用省份/地区那一档**）"✓
   *   宽度 1（六档表里那一档 ✓ 跟别处同一个口径 ✓）
   *   🔴🔴 **不透明度默认 25%** ✗✗（2026-10-17 用户定的 ✓
   *     原话："默认水域边界不透明度是25%"✓
   *     2026-10-16 那版给的是 100%（实心 ✓ 图个"默认观感不变"），现在改成**淡的 25%** ✓
   *     跟"默认关闭水域边界"配着看就明白了：这一档默认就是个**很淡的辅助线** ✓
   *       —— 界面上勾上就能看见一点，但不抢戏 ✓）
   *   ⚠ **荒地那一对（wasteW / wasteA）不请回来** ✗ ——
   *     用户只点名了水域 ✓ 荒地仍然"没有专属边界"（见 check_wiring 的退役名单 ✓）*/
  waterW: 1, waterA: 25,
  /* **荒地边界那一对**（2026-10-17 ✓ 用户点名要的那条通道 ✓）
   *   宽度跟水域那对一样是 1 ✓
   *   🔴 **不透明度默认 100%（实心）** ✗✗（2026-10-17 用户定的 ✓
   *     原话："荒地边界默认100%"✓）
   *     ⚠ 它跟水域那条**不再是一个出厂值**了 ✗ —— 水域是 25%（很淡的辅助线 ✓）
   *       荒地是 100%（实心 ✓）别顺手改成一样 ✗
   *   ⚠ 它俩仍然是**独立一档** ✗（不沿用省份/地区那一档 ✓）*/
  wasteW: 1, wasteA: 100,
  // **背景那两条线各有一套宽度 + 浓度** ✓（用户要求可调 ✓；显示开关去掉了 ✗）
  //   宽度跟「势力线宽」一个口径（格数 ✓ 直接就是粗细）；浓度是百分比 ✓
  //（水域 / 荒地的专属宽浓出厂值已随开关一起退役 ✓ 水走普通头衔边界 ✓）
  // **名字显示上限**：按连通域面积**从大到小**取前 N 个 ✓
  // 自从"一个连通域一个名字"之后，全图能有几千坨（EU4 的 1444 有 1863 坨 ✗），
  // 标签层每帧都要过一遍 —— 所以封个顶防卡顿 ✓ **数量 1~20**；
  // **滑杆最右那一格（21）= 无上限** ✓（省掉单独一个勾选框 —— 用户要求）
  //
  // ⚠ 默认值别压太狠 ✗（用户报的"国名很多没显示"✓）：
  //   真正决定"画面上能看见几个"的是**字号门槛**（√面积 × 缩放 × 0.18 ≥ 4px ✓），
  //   全图视图下 EU4 只放行 62 个、EU5 42 个 ✓
  //   默认若还是 12，就把门槛放出来的那些**又砍掉一半** ✗ → 看起来"到处都没名字" ✓
  //   → 默认 12：**每个国家**最多留 12 个名字（本土 + 11 块殖民地 ✓ 用户的原意 ✓）
  labelMax: 12,
  /* **地名上限** ✓（2026-10-16 用户定的 ✓）—— 跟「势力名称上限」**同一套档位**
   *  （1~21，`21` = 无上限 ✓ 默认 12 ✓），也是**按组**各留 N 个：
   *   势力的"一组"是**一个国家**；地名的"一组"是**一个头衔** ✓
   *   ⚠ 为什么要有它：地名也改成"**每个连通域一个标**"之后，
   *     一个头衔底下可能有一大堆碎块（CK3 的飞地 / EU4 的岛群 / 群岛伯爵领 ✓）
   *     —— 不封顶的话细层会碎成一片 ✗ */
  /* **地名上限** ✓（2026-10-16 用户定的 ✓）
   *  （1~21，`21` = 无上限 ✓）
   *  ⚠ 2026-10-17 用户："设置里的地名最高上限改为1" ✓ → 默认从 12 改成 **1**
   *    （每个头衔/连通域只留最大的那一个标；想多显示还能自己拉高 ✓）
   *    `placeCapV1` 是**一次性迁移标记**：老存档里还是旧默认 12 的迁到 1，
   *    用户之后自己改的值不再被覆盖 ✓ */
  labelPlaceMax: 1,
  placeCapV1: 1,
  /* **两张名字的不透明度**（%）—— **势力名称** = 剧本/年份那几层 · 地名 = 地区/省份/地点 ✓
   *  ⚠ 界面上叫「**势力名称**」✗（用户定的 ✓ 原来写的是"国名" ✓）
   *     它盖的其实是**剧本/年份那几层的势力名**，叫"国名"会把范围说窄 ✓
   *  变量名 labelAC / alphaCountry 是历史包袱 ✗ 不用改（改了到处都得动 ✓）
   *  半透明的好处：底下的填色和边界还看得见 ✓（用户定的档位：25 / 50 / 75 / 100 ✓）*/
  labelAC: 50,
  labelAP: 50,
  // **取完色切到哪个画图工具**（涂抹 / 填色 ✓ 用户要求可在设置里选）
  pickTool: 'paint',
};

/** **两块字号取值的唯一口子** ✓（2026-10-17 加的 ✓）
 *
 *  为什么要它：字号拆成"地块 / 势力"两块之后，**老存档里只有一个数字** ✗ ——
 *  那个数得**同时喂给两块**（不然老用户一升级：要么归 1，要么其中一块被丢掉 ✓）。
 *  ⚠ **迁移只写这一处** ✗✗ —— 别在"读设置 / 存设置 / 刷界面"各写一遍 ✓
 *    三处各写一遍就是三个会走偏的口子 ✓（今天已经在别处栽过同款 ✓）
 *
 *  认三种形状（按顺序）：
 *    ① 新格式 `s.fontPlace` / `s.fontPower`（各自生效 ✓）
 *    ② 老格式 `s.font`（**一个数字** ✓ 两块**都**用它 —— 这就是迁移 ✓）
 *    ③ 什么都没有 → 1 ✓
 *  ⚠ 返回值**一定是两个数** ✗（调用方不用再判 null ✓）
 *  @returns {{place: number, power: number}} */
function fontSizes(s) {
  const _one = (v) => ((typeof v === 'number' && isFinite(v) && v > 0) ? v : null);
  const legacy = _one(s && s.font);
  const place = _one(s && s.fontPlace);
  const power = _one(s && s.fontPower);
  const fallback = legacy != null ? legacy : 1;
  return { place: place != null ? place : fallback, power: power != null ? power : fallback };
}

/** 滑杆拉到满 = **无上限** ✓
 *  ⚠ 这个数必须跟 `index.html` 那根 range 的 `max` 一致 —— 测试里有一条断言盯着两边 ✓ */
const LABEL_MAX_UNLIMITED = 21;

/* **线宽五档 / 浓度四档**（用户定的 ✓）——
 * 档位就几个，用下拉"选一档"比滑杆连续拖清楚 ✓
 * ⚠ 这两张表必须跟 `index.html` 里那五个 `<select>` 的 `value` 一致
 *   （测试里有一条断言盯着两边对不对得上 ✓）
 *   浓度那四档是用户点名的：25% / 50% / 75% / 100% ✓
 */
/* ⚠ **0.5 这一档是用户后来要的** ✗（原来从 1 起 ✓ 现在是六档 ✓）
 *   最细那一档给"看细节时不想被线压住"的场合 ✓ */
const W_STEPS = [0.5, 1, 1.5, 2, 2.5, 3];    // 地方边界宽度**六档**（默认 1 ✓）
const PW_STEPS = [0.5, 1, 1.5, 2, 2.5, 3];    // 势力边界宽度**六档**（**就是这个粗细** ✓ 不再是倍率 ✗）默认 1 ✓
/* **0% 这一档是用户后来要的** ✗（原来从 25 起 ✓ 现在五档 ✓）
 *   0% = 那条线**完全不画** ✓ 等于"单独关掉这一种边界"而保留其余设置 ✓ */
const CONC_STEPS = [0, 25, 50, 75, 100];      // 边界浓度**五档** ✓

/** **设置里某个数值项的唯一读法** ✓（2026-10-17 收口）
 *
 *  以前每处都写一遍 `(state.set && state.set.xxx != null) ? Number(...) : 默认值` ——
 *  全仓库十几份，`pa` 那种还要在括号里再包一层除法 ✓
 *  坏处很实在：万一某一处忘了判 `state.set` 就是 TypeError；
 *  老存档里存成字符串 / NaN 时，各处的回退口径也会各走各的 ✓
 *
 *  @param {string} key  `state.set` 里的键
 *  @param {number|null} def 缺省值（**原样返回**，包括 null ✓）
 *  @returns {number|null} 非有限数一律回退到 `def` ✓
 */
function setNum(key, def) {
  const s = state.set;
  const v = s ? s[key] : null;
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 把一个数**吸附到最近的档位**上 ✓
 *  （老存档里存的是滑杆时代的连续值（比如 `w: 1.7` ✗），
 *    下拉里没有这一项会显示成空白 —— 吸附过去就对了 ✓） */
function snapStep(v, steps) {
  let best = steps[0];
  for (const s of steps) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

/** 设置页那行「名字上限」旁边显示的当前值 ✓（满格写"无上限"） */
function labelMaxText() {
  const v = setNum('labelMax', SET_DEFAULTS.labelMax);
  return v >= LABEL_MAX_UNLIMITED ? '无上限' : Math.max(1, v) + ' 个';
}

/** 真正生效的上限（**0 = 不封顶** ✓ 给 `rebuildPaintBlocks` 用） */
function labelMaxValue() {
  const v = setNum('labelMax', SET_DEFAULTS.labelMax);
  return v >= LABEL_MAX_UNLIMITED ? 0 : Math.max(1, v);
}

/** 设置页那行「地名上限」旁边显示的当前值 ✓（跟 `labelMaxText` 一个长相 ✓） */
function labelPlaceMaxText() {
  const v = setNum('labelPlaceMax', SET_DEFAULTS.labelPlaceMax);
  return v >= LABEL_MAX_UNLIMITED ? '无上限' : Math.max(1, v) + ' 个';
}

/** 真正生效的地名上限（**0 = 不封顶** ✓ 给 `placePointsFor` 用 ✓） */
function labelPlaceMaxValue() {
  const v = setNum('labelPlaceMax', SET_DEFAULTS.labelPlaceMax);
  return v >= LABEL_MAX_UNLIMITED ? 0 : Math.max(1, v);
}

/* ---- 边界那几条滑条**旁边显示当前值** ---------------------------------------
 * 跟「名字上限」那行同一个长相（标签 + 值 + 滑条 ✓ `.set-row .hint` 有 margin-right:auto
 * → 值贴着标签、滑条照样贴右 ✓）
 * 值是**动态插进去的** ✗ 不用在 HTML 里写九遍 span ✓
 */
const SLIDER_TIPS = [
  /* ⚠ 2026-10-13：原来这条叫「地方边界宽度」✗ 现在**拆成两条** ✓
   *   · 地区边界宽度 = 管**父级边界**（多级链上那些上层线 ✓）
   *   · 省份边界宽度 = 管**子级边界**（本层那条线 ✓）
   *   所以下面两行替掉了原来那一行 `['set-w', …]` ✓ */
  ['set-w-region', (v) => String(v)],
  ['set-w-prov', (v) => String(v)],
  ['set-pw', (v) => String(v)],
  ['set-pa', (v) => v + '%'],
  ['set-ra', (v) => v + '%'],
  ['set-ca', (v) => v + '%'],
  /* **水域边界那一对请回来了** ✓（2026-10-16 ✓ 用户要求"新增一对"✓
   *   跟别的一模一样：滑条**左边**写当前值 ✓）*/
  ['set-water-w', (v) => String(v)],
  ['set-water-a', (v) => v + '%'],
  /* 🔴 **荒地边界那两根**（2026-10-17 ✓ 跟水域那对同一个长相 ✓）*/
  ['set-waste-w', (v) => String(v)],
  ['set-waste-a', (v) => v + '%'],
  /* **名字这一栏的三根也要**（用户要求：跟边界那些一样，滑条**左边**写当前值 ✓）
   *   漏了这一步的表现就是"别的滑条旁边有数字、名字这几根没有" ✓
   *   ⚠ 「势力名称上限」不在这儿 ✗ 它自己有 set-labelmax-v 那个 span（还要写"无上限" ✓）*/
  /* 🔴 **两根字号**（2026-10-17 拆的 ✓ 用户：「把字号分开两个，一个给地块，一个给势力」✓）*/
  ['set-fontplace', (v) => v + '×'],
  ['set-fontpower', (v) => v + '×'],
  ['set-labelac', (v) => v + '%'],
  ['set-labelap', (v) => v + '%'],
];

/** 把表里那些滑条的当前值刷一遍（顺便把缺的提示 span 插上 ✓ 幂等 ✓）
 *  插的位置是**滑条前面** ✓ 所以看着就是"标签 · 数值 · 滑条" ✓（用户要的"左边写数值"✓）*/
function buildSliderTips() {
  if (typeof document === 'undefined') return;
  for (const [id, fmt] of SLIDER_TIPS) {
    const el = $(id);
    if (!el || !el.parentNode || !el.parentNode.insertBefore) continue;
    let tip = el.parentNode.querySelector('.hint[data-tip="' + id + '"]');
    if (!tip) {
      tip = document.createElement('span');
      tip.className = 'hint';
      tip.setAttribute('data-tip', id);
      el.parentNode.insertBefore(tip, el);        // 插在**滑条前面** ✓ 滑条才能贴右 ✓
    }
    tip.textContent = fmt(el.value);
  }
}

/** 设置改了就调它：推到渲染器 / 标签层并重画 */
function applySettings() {
  /* 设置一变就让荒地自动色重算一遍 ✓（2026-10-17 ✓）
   *   `applyNatureColors()` 会按「不可通行区域」把荒地节点的 LUT 刷回类色 ✓
   *   不跟着重算的话，自动色会被这一趟覆盖掉 ✓ */
  state._wasteCfgSeq = (state._wasteCfgSeq || 0) + 1;
  /* **两张名字的不透明度**送到标签层 ✓（那边按 tier 分层挑用 ✓）
   *   放到 applySettings 最前面：它不依赖下面任何几何设置 ✓ 早设早生效 ✓ */
  if (labels) {
    labels.alphaCountry = setNum('labelAC', 50) / 100;
    labels.alphaPlace = setNum('labelAP', 50) / 100;
    labelDirty = true;
  }
  const s = state.set || (state.set = Object.assign({}, SET_DEFAULTS));
  if (renderer) {
    /* **背景色默认 180,180,180** ✓（2026-10-13 用户定的 ✓ 220 → 200 → **180**）
     *   「未上色区域」另有一项（默认 150 ✓）—— **只在开着剧本时**用它 ✓
     *   没开剧本的无主地跟着背景色走（gl.js 里 NONE 那段按 uPaintOnly 挑 ✓）*/
    const bg = s.bg || [180, 180, 180];
    renderer.backdrop = [bg[0] / 255, bg[1] / 255, bg[2] / 255];
    const up = s.unpainted || [150, 150, 150];
    renderer.unpainted = [up[0] / 255, up[1] / 255, up[2] / 255];
    /* 🔴 **每一格按底层身份上色** ✗✗（2026-10-15 ✓ 用户要求 ✓）
     *   用户原话："解决一下 EU5 的海洋不上色的问题……上不上色看的是**具体的最底层
     *     单位属于什么东西**" ✓
     *   → 把这枚身份标与**七行里的五行类色**灌给渲染器 ✓
     *     着色器那边（gl.js 的 colorOfPid ✓）只看底层 pid 的 kind：
     *       2/3/4/5/6 → 直接给类色 ✓（**跟哪一层、有没有片、有没有归属都无关** ✓）
     *       1 陆地     → 老路照旧 ✓（手绘 / 无主兜底 / LUT 头衔色 + 浓度 ✓）
     *   ⚠ 老包没有 `state.kindMask` → 传 null → `uKindOn = 0` → 整条让开 ✓
     *     行为一丝不变 ✓
     *   ⚠ 每次 `applySettings()` 都重灌一遍 ✗ —— 它很便宜（只标脏 ✓
     *     真正上传在下一帧的 `flushPaint()` 里 ✓）而**改设置立刻生效**靠的就是它 ✓
     *     （用户要求"实时跟着变、不许重烤包" ✓ 一个字节的包都不用动 ✓）*/
    renderer.setKindMask(state.kindMask || null);
    /* **「认得出是水吗」那张表** ✓（2026-10-16 ✓ 给「水域 · 边界」那条通道 ✓）
     *   ⚠ 传 null（老包 / 一个水都认不出）→ 着色器 `waterIs` 恒 false
     *     → 水域那条通道 + 两条让位一起退化成现状 ✓ 一个字节都不动 ✓
     *   ⚠ 跟 kindMask 一样：每次 applySettings() 都重灌一遍 ✗ 很便宜（只标脏 ✓
     *     真正上传在下一帧的 flushPaint() ✓），改设置立刻生效靠的就是它 ✓ */
    renderer.setWaterKindMask(state.waterKindArr || null);
    renderer.setNatureColors([
      natureColor('sea'), natureColor('lake'), natureColor('river'),
      natureColor('isea'), natureColor('impass'),
    ]);
    // （`renderer.wasteGrey` 一行已退役 ✓ —— gl.js 上没有这个 uniform 了 ✓
    //   荒地 LUT 起手灰由 `paintWasteGrey()` 在载图时写进 LUT ✓）
    renderer.dirty = true;
  }
  resyncTitleLut();
  /* 🔴 **七行颜色刷进 LUT** ✗✗（2026-10-15 ✓ 用户要求"改完立刻生效" ✓）
   *   —— 放在 `resyncTitleLut()` 后面：那一步只是标脏，真正重画在下一帧 ✓
   *   开图时也走这条（`openMap` 最后调的就是 `applySettings()` ✓ 不用另挂 ✓）*/
  applyNatureColors();
  /* 🔴🔴 **2026-10-17：字号拆成两个全局值** ✗✗（用户："把字号分开两个，一个给地块，一个给势力"✓）
   *   `__CK3_FONT_PLACE` = 地块名（含海 / 湖 / 河 / 荒地名 ✓）
   *   `__CK3_FONT_POWER` = 势力名（剧本 / 年份那几层 + 玩家涂出来的色块名 ✓）
   *   ⚠ **旧的 `__CK3_FONT_SCALE` 仍然写着** ✗ —— 别删 ✓
   *     它是 `labels.js` 里那两级回退的兜底（老产物 / 测试桩只认它 ✓）
   *     也省得"哪天别处还读着它"直接崩 ✓ 三个一起维护，成本就一个赋值 ✓
   *   ⚠ 取值要**兼容老存档**：`s.font` 老格式是**一个数字** ✓
   *     新格式是 `{ place, power }` ✓ 两种都得认 ✓（`fontSizes()` 那一个口子 ✓）*/
  if (typeof window !== 'undefined') {
    const _fo = fontSizes(s);
    window.__CK3_FONT_SCALE = _fo.place;
    window.__CK3_FONT_PLACE = _fo.place;
    window.__CK3_FONT_POWER = _fo.power;
  }
  state._parentSig = null;
  syncParentBorder();
  labelDirty = true;
}

// ---------------------------------------------------------------- 改名
/**
 * 给一块地改名（改名工具和弹窗都走这里，方便自测）。
 *
 *  · 涂过的地：改**这支标记的名字** —— 同一支笔铺的所有块一起改 ✓
 *    （没标记的纯色块：现登记一个标记，并把同色的地一起挂上 ✓）
 *  · 没涂的地：改该层头衔的名字（写进 state.titleName ✓）
 *
 * @returns {boolean} 有没有改成功
 */
function renameAt(pid, name) {
  const nm = String(name == null ? '' : name).trim();
  if (!pid || pid <= 0 || !nm) return false;
  const pd = renderer && renderer.paintData;
  const n2 = state.meta.numProvinces;
  const tier = editTier();

  // 点中的这块地"是什么"：**颜色 + 标签名**
  //   涂过 → 手绘色 + 标记名；没涂 → 头衔色 + 头衔名
  const p4 = pid * 4;
  const tid0 = titleAt(pid, tier);
  const painted0 = !!(pd && pd[p4 + 3] > 0);
  const lab0 = painted0 && state.provLabel ? (state.provLabel[pid] | 0) : -1;
  const name0 = painted0 ? (lab0 >= 0 ? String(state.labelNames[lab0] || '') : '')
                         : String((state.titles.names[tid0] || ''));
  const c0 = stableColor(pid, tid0);
  if (!c0) return false;
  // 下面这一整遍是**全图扫**（4 万格）——比较时直接用通道，别每格 new 一个数组 ✓
  const c0r = c0[0], c0g = c0[1], c0b = c0[2];

  const newId = labelIdOf(nm);          // 涂过的那部分挂到这个新标记上 ✓
  const touched = new Set();            // 没涂的那部分：这些头衔要改名 ✓
  let hit = 0;
  for (let q = 1; q < n2; q++) {
    const q4 = q * 4;
    const tidQ = titleAt(q, tier);
    const paintedQ = !!(pd && pd[q4 + 3] > 0);
    const labQ = paintedQ && state.provLabel ? (state.provLabel[q] | 0) : -1;
    const nameQ = paintedQ ? (labQ >= 0 ? String(state.labelNames[labQ] || '') : '')
                           : String((state.titles.names[tidQ] || ''));
    if (nameQ !== name0) continue;                       // 标签名不一样 → 不是一家
    const cQ = stableColor(q, tidQ);
    if (!cQ || cQ[0] !== c0r || cQ[1] !== c0g || cQ[2] !== c0b) continue;   // 颜色不一样 → 不是一家
    if (paintedQ) {
      state.provLabel[q] = newId;
    } else if (tidQ !== NO_TITLE && tidQ != null) {
      touched.add(tidQ);
    }
    hit++;
  }
  if (hit <= 0) return false;
  state.labelIds.set(nm, newId);
  state.titleName = state.titleName || new Map();
  for (const tid of touched) {
    state.titles.names[tid] = nm;       // 标签层读的是这份 ✓
    state.titleName.set(tid, nm);       // 存档带上 ✓
  }
  blocksDirty = true;
  labelDirty = true;
  if (renderer) renderer.dirty = true;
  return true;
}


/** 改名工具点下去：先把它现在的名字填进弹窗 ✓ */
let _renamePid = 0;
function openRename(pid) {
  _renamePid = pid | 0;
  const box = $('rename');
  const inp = $('rename-input');
  const pd = renderer && renderer.paintData;
  if (inp) {
    let now = '';
    if (pd && pd[pid * 4 + 3] > 0) {
      const lab = state.provLabel ? (state.provLabel[pid] | 0) : -1;
      now = lab >= 0 ? (state.labelNames[lab] || '') : '';
    } else {
      now = displayedLabel(pid, titleAt(pid, editTier()));
    }
    inp.value = now || '';
  }
  if (box) { box.hidden = false; if (inp) inp.focus(); }
}

function resyncTitleLut() {
  if (!renderer) return;
  renderer.dirty = true;
  labelDirty = true;
}

/**
 * 涂色**只新建玩家填色区**，头衔本身的颜色一个字都不动
 *
 * 这里**不看颜色变没变**。玩家常常先从某个头衔吸色、再涂回同一个头衔
 * （比如给整个帝国统一铺一遍色），涂出来的色跟原色一模一样，
 * 但那仍然是「我涂的」—— 不能因为颜色没变就当成还原、把手绘擦掉
 */

// ================================================================ 涂色的"底层单位"账本
//
// 一笔涂色的本质 = 改了一批**最底层单位**（省份像素）的颜色和标签。
// 所以历史记录的单位也是它，而不是"某个头衔" —— 这样"切到王国层整个河南填一遍"
// 撤销时，只会把**上一步之后仍然不同**的那些 pixel 恢复，前半原本涂过的
// 会回到它自己的颜色（而不是被一并抹掉）。
//
// state.provTitle[pid] 已经记着"这个 pixel 当前显示的是哪个头衔的涂色"（-1 = 没涂），
// state.provLabel[pid] 是对应的标记编号。这里只是把它当作账本用。

/** 这个头衔覆盖了哪些底层单位（pid） */
function pidsOf(tid) {
  const out = [];
  if (!state.meta) return out;
  const n = state.meta.numProvinces;
  const tier = state.titles.tiers[tid];
  if (tier >= TIER_COUNT) return out;
  const tm = state.titlemap;
  const row = tier * n;
  for (let pid = 1; pid < n; pid++) if (tm[row + pid] === tid) out.push(pid);
  return out;
}

/**
 * 同上，但直接给一串 pid ✓
 *
 * 「填色·边界」下按**色块**擦除时走这条：那一笔不是按头衔清的
 * （同一个头衔里别的颜色的地不归它管 ✗），所以快照也得按地块拍 ✓
 *
 * 颜色**直接读这一格自己**（`paintData`）✓ —— 这才是真相：
 * 每一格有自己的颜色（`paintData[pid]`）、自己的标记编号（`provLabel[pid]`）、
 * 自己的归属（`provTitle[pid]`）。以前绕一层 `paintColor.get(头衔)` ✗ ——
 * 在那个头衔被重新涂过之后，取回来的是**新颜色**，快照就不准了 ✓
 */
function snapshotPidsList(pids) {
  const pd = renderer && renderer.paintData;
  const snap = [];
  for (const pid of pids) {
    const p4 = pid * 4;
    const on = !!(pd && pd[p4 + 3] > 0);
    snap.push({
      pid,
      rgb: on ? [pd[p4], pd[p4 + 1], pd[p4 + 2]] : null,
      tid: state.provTitle ? state.provTitle[pid] : -1,
      label: state.provLabel ? (state.provLabel[pid] | 0) : 0,
    });
  }
  return snap;
}

/** 把快照和"现在"比一比，只把**真的变了**的收成一步历史 */
function pushPatches(snap) {
  const pd = renderer && renderer.paintData;
  const patches = [];
  for (const before of snap) {
    const p4 = before.pid * 4;
    const on = !!(pd && pd[p4 + 3] > 0);
    const after = {
      pid: before.pid,
      rgb: on ? [pd[p4], pd[p4 + 1], pd[p4 + 2]] : null,      // 同上：读这一格自己 ✓
      tid: state.provTitle ? state.provTitle[before.pid] : -1,
      label: state.provLabel ? (state.provLabel[before.pid] | 0) : 0,
    };
    const same = before.tid === after.tid && before.label === after.label
      && String(before.rgb) === String(after.rgb);
    if (!same) patches.push({ pid: before.pid, from: before, to: after });
  }
  if (!patches.length) return;
  state.history.undo.push({ patches });
  if (state.history.undo.length > 400) state.history.undo.shift();
  state.history.redo.length = 0;
  updateHistoryUI();
}

/** 把一条 patch 的某一侧写回去（只动这一个底层单位） */
function applySide(side) {
  if (side.rgb) {
    // alpha 是 **0~255** —— 这里曾经写成 1 ✗，等于"透明度 99.6%"，画面上看着就是
    // "撤销之后全被清掉了"（其实颜色写回去了，只是几乎全透明）。
    renderer.setPaint(side.pid, side.rgb[0] | 0, side.rgb[1] | 0, side.rgb[2] | 0, 255);
    renderer.setPaintLabel(side.pid, Math.max(side.label | 0, 0));
  } else {
    renderer.setPaint(side.pid, 0, 0, 0, 0);
    renderer.setPaintLabel(side.pid, 0);
  }
  if (state.provTitle) state.provTitle[side.pid] = side.tid;
  if (state.provLabel) state.provLabel[side.pid] = side.label;

  markPaint();
}

/** 从账本重算"哪些头衔算涂过"（撤销之后可能只剩一半了） */
/**
 * 手绘层变了：喊一声。（原来那半句"自动填色跟着重算"的机制已退役 ✓）
 * 涂色、擦除、撤销、重做、导入、清除 —— 全部走这里。
 */
function markPaint() {
  state._paintSeq = (state._paintSeq || 0) + 1;  state._paintAnyFor = null;     // 作废：下一帧同步时按新数组重扫 ✓

}

function recomputePainted() {
  markPaint();   // 手绘层变了 —— 先作废缓存再重算 ✓
  if (!state.provTitle) return;
  const pd = renderer && renderer.paintData;
  state.painted.clear();
  state.changed.clear();
  const n = state.meta ? state.meta.numProvinces : 0;
  for (let pid = 1; pid < n; pid++) {
    /* **以"这一格到底有没有颜色"为准** ✓ —— `paintData` 才是真相，
     * `provTitle` 只是个索引（"这一格是哪一笔涂的"）。
     * 两边万一脱节（老存档 / 别处直接改过手绘纹理），只看 provTitle 会冒出
     * **幽灵记录**：明明一格颜色都没有，却算出"某头衔涂过" ✗
     * （导出时就会多出一条、撤销后账本也对不上 —— 测试里真撞到过 ✓）
     * 所以：有颜色才算涂过，没颜色就顺手把索引修掉 ✓
     */
    const on = !!(pd && pd[pid * 4 + 3] > 0);
    const tid = state.provTitle[pid];
    if (on && tid >= 0) {
      state.painted.add(tid);
      state.changed.add(tid);
    } else if (!on && tid >= 0) {
      state.provTitle[pid] = -1;
      if (state.provLabel) state.provLabel[pid] = -1;
    }
  }
  /* **状态栏那个"改动 N"在这里统一刷** ✗ ——
   *   以前是 paintPids() 里自己调 updateStatus()，可那时 state.changed 还是
   *   **旧账本**（重算在它之后才跑）→ 涂完显示的还是上一笔的数（慢一拍 ✗）。
   *   账本是这里重建的，那就这里刷 —— 涂 / 擦 / 清除 / 导入 / 撤销，
   *   所有改手绘层的路最终都汇到这一个函数 ✓ */
  updateStatus();
}

/** 把派生值推给渲染器 —— **变了才写、写就置脏** ✓
 *
 *  这几条每帧都会算一遍（syncLayerSwitches / syncParentBorder ✓），
 *  以前每一处都手写一遍 `if (renderer.x !== v) { renderer.x = v; renderer.dirty = true; }` ——
 *  光 app.js 里就十几份，漏写 `dirty = true` 的那份表现是"滑条拖了没反应"✓
 *
 *  @param {string} key 渲染器上的属性名
 *  @param {*} v        目标值
 *  @param {number} [eps] 浮点容差（给了才按容差比；布尔/整型别传 ✓）
 *  @returns {boolean} 有没有真的写进去
 */
function pushRenderer(key, v, eps) {
  if (!renderer) return false;
  const cur = renderer[key];
  if (eps != null && typeof v === 'number' && typeof cur === 'number') {
    if (Math.abs(cur - v) <= eps) return false;
  } else if (cur === v) return false;
  renderer[key] = v;
  renderer.dirty = true;
  return true;
}

function syncLayerSwitches() {
  const n = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  // 边界各听各的：势力·边界 → 原版地界；填色·边界 → 按**当前显示颜色**画的分界 ✓
  // （放在早退之前：没有剧本层的数据也要同步这条 ✓）
  // 这条边界要一直跑（剧本/头衔本来就有的颜色也算 ✓），不再看手绘层空不空 ✗
  // **哪一层都画** ✓ —— 细层（地区/省份/地点视图）也要，跟剧本层**同一套规矩**：
  //   浓度 = 势力边界浓度（设置页那一档，内部字段仍叫 ca；实心），粗细 = 链上最粗那一档（见下面 _pw）✓
  //   （以前写死"只在剧本/国家那层"✗ —— 细层里勾了「填色 · 边界」什么都不出来 ✓）
  pushRenderer('borderPaint', !!state.showBorderPaint);
  // 这条边界**比什么**：
  //   · CK3（没有年代层）和**细层**（地区/省份/地点视图）→ 只管**自己涂出来的那一圈** ✓
  //     （细层要是按"显示颜色"比，原版每个省本身颜色就不同 → 整张图的省界上都会多出
  //      一条又粗又实的涂色线，叠在本层细线上面，看着就是"所有线条都变粗了" ✗）
  //   · 剧本/国家那层 → 按**当前显示颜色**比（原版剧本色也算分界）✓
  const _paintOnly = !(n > 0 && state.tier < n);
  pushRenderer('paintOnly', _paintOnly);
  /* ---- 水域那条海岸线 + 四个水域色 ------------------------------------------
   *   · 海岸线（water ↔ 非水）**跟着"还有边界在画"走** ✓
   *   · 四个水域色（海 / 湖 / 河 / 不可通行海域）每帧送上去 ✓
   *     设置里改了颜色立刻生效 ✓（认水的判据、老包海名那几处还要用 ✓）
   */
  /* ---- **水域边界那条独立通道**（2026-10-16 ✓ 用户点名要的 ✓）----------------
   *  口径（原话见 handover §3.1）：
   *    水域边界开关**负责且仅负责**「水域之间（海洋 / 湖泊 / 河流 / 不可通行海域）
   *      的边界」的显示或隐藏 ✓
   *    同时受管理的这些东西**不再受地区边界、地区名称的管理** ✓
   *
   *  ⚠ 三级闸，缺一不可 ✗：
   *    ① 用户那个勾（`showWaterBorder` ✓ HTML 里默认勾上 ✓）
   *    ② **这张图算得出水陆**（`state.waterKindArr` 非空 ✓）——
   *       老包 / 认不出水 → 没有这张表 → 通道整条让开 ✓ 跟改造前一模一样 ✓
   *    ③ 渲染器上那个值跟它不一样才推（别每帧置脏 ✗）
   *
   *  ⚠ **它故意不看** 地区 / 势力 / 填色 三个开关 ✗✗ ——
   *    这正是用户要的"独立"：水域之间的缝**只认这一个勾** ✓
   *    （"边界全关"时它照样在 ✓）
   *  ⚠ 它跟普通头衔边界不是一回事 ✗ 别合并（合并了就又变成"跟着别的开关走"✗）*/
  {
    const _waterBorderOn = !!state.showWaterBorder && !!state.waterKindArr;
    pushRenderer('waterBorderOn', _waterBorderOn);
  }
  /* 🔴🔴 **「荒地 · 边界」**（2026-10-17 ✓ 照上面水域那段一字不差地抄 ✓）
   *   ① 用户那个勾（`showWasteBorder` ✓ 默认关 ✓）
   *   ② **这张图有身份标**（`state.kindMask` 非空 ✓）——
   *      荒地那条读的就是身份标纹理（着色器里读 uKindTex ✓ 没有第二张表 ✓）
   *      ⚠ 老包没这枚标 → 通道整条让开 ✓ 观感一点不变 ✓
   *      ⚠ **不看 `waterKindArr`** ✗ —— 那是水域那条的表，荒地不用它 ✓
   *   ③ 值不一样才推 ✓
   *   ⚠ 同样**不看** 地区 / 势力 / 填色 三个开关 ✗（独立 ✓ 用户要的口径 ✓）*/
  {
    const _wasteBorderOn = !!state.showWasteBorder && !!state.kindMask;
    pushRenderer('wasteBorderOn', _wasteBorderOn);
  }
  // 玩家名字要不要**全图重分组**：只在国家/剧本那层 ✓（细层只画涂过的块 ✓）
  // 剧本层的国名（原版那批）现在也由这份分组负责 ✓ —— 以前那个「势力 · 名称」
  // 开关算出来的是同一批点，所以删了，只剩这一个开关说了算 ✓
  {
    const _all = !!state.showLabelsPaint && n > 0 && state.tier < n;
    if (state._blocksAll !== _all || state._blocksTier !== state.tier) {
      state._blocksAll = _all;
      state._blocksTier = state.tier;
      blocksDirty = true;
    }
  }
  /* ⚠ **「头衔」那组显示开关删了**（2026-10-12，廿九点的 ✓）
   * 原来 CK3 走「头衔」一组、别的游戏走「势力 + 地区」两组；
   * 可 CK3 后来也有剧本层了（1066 / 空白剧本 → `meta.eraDates` 有两条），
   * 于是"有没有年代层"这个判据在**每一个模式**里都成立 →
   * 势力/地区一直显示着，而「头衔」那一组**永远是藏着的** ✗（纯死 UI）
   * 它控的三样（原版颜色 / 原版地名 / 原版边界）现在都由「势力 · 地区」那几组
   * 每帧算出来写进 state（见下面 `state.showTitles = col` 那几行 ✓），
   * 所以删掉界面 **运行时一点变化都没有** ✓ */
  if (!n) return;   // 没有年代层：不动 ✓（「剧本」那组开关已删，不再判元素 ✓）
  const isPower = state.tier < n;
  // 边界是照**编辑层**画的（开粒度时就是粒度那一层）→ 听**那一类**的开关
  const _editIsPower = editTier() < n;
  const col = isPower ? state.showPowerColor : state.showRegionColor;
  // 名称按**画的是哪一层**分（跟视图停在哪无关）：
  //   地名画的是编辑层（开粒度时是粒度那层）→ 听「地区 · 名称」
  //   剧本层那批国名 = 玩家地名那份分组         → 听「填色 · 名称」
  // 解析出来的值写回 state（着色器、标签那些地方照旧读它们）
  state.showTitles = col;
  state.showBorderTitle = _editIsPower ? state.showPowerBorder : state.showRegionBorder;
  const _labTitle = state.showRegionName;
  if (state.showLabelsTitle !== _labTitle) {
    state.showLabelsTitle = _labTitle;
    labelDirty = true;
  }
  // 推给渲染器：**跟渲染器现值比**，不一样才推 ——
  // 用私有签名的话，别处（比如加载地图那段拿旧勾选框）推错一次就再也纠不回来 ✗
  if (renderer.showTitles !== col) renderer.setShowTitles(col);
  if (renderer.borderTitle !== state.showBorderTitle) renderer.setBorderTitle(state.showBorderTitle);
  // 边界只剩一个开关了：**两条边界都听它的** ✓（玩家边界已取消 ✓）

}

function syncParentBorder() {
  if (!renderer || !state.meta || !state.meta.tierNames) return;
  const fine = state.meta.tierNames.length - 1;
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  // 基准线宽只记一次（下面会按链调细本层，不能拿被改过的值当基准 ✗）
  if (state._borderWidthBase == null) state._borderWidthBase = renderer.borderWidth || 1;
  /* ⚠ 2026-10-13：「地方边界宽度」拆成了**地区 / 省份**两条 ✓
   *   · **省份**那条管**本层**（子级线 ✓ 也就是原来 `_setW` 干的活 ✓）
   *   · **地区**那条管**父级链** ✓ —— 以前两边取同一个值，拆开才调得动 ✓
   *   老存档里只有 `w`（语义 = 本层 ✓）→ 两条都从它继承，观感跟以前一模一样 ✓ */
  const _setW = setNum('w', null);
  const _setWProv = setNum('wProv', _setW);
  const _setWRegion = setNum('wRegion', _setW);
  const baseW = _setWProv != null ? _setWProv : state._borderWidthBase;
  // 「势力/地区」那两套分开关只在**有剧本层的模式**里才有意义（现在每套都有 ✓）
  // ⚠ 「剧本」元素已删（2026-10-17）→ 判据只看有没有年代层 ✓
  const hasSwitches = nEra > 0;
  // 某一层听哪个开关：剧本层（国家 / 1066 政权）归「势力」，其余（帝国/王国/…）归「地区」✓
  const showOf = (tier) => (hasSwitches
    ? ((nEra > 0 && tier < nEra) ? state.showPowerBorder : state.showRegionBorder)
    : state.showBorderTitle);

  const list = [];        // 从**贴近粒度**的那层往上，一级比一级粗 ✓
  // 有链的时候本层自己**再细一档**（它是最细的那条线）
  const thinBase = baseW * 0.75;
  const step = 0.25;
  /* 粗细阶梯（用户定的）：本层 1 / 父层 1.25 / 填色线与多级链 1.5
   *   整体乘「地方边界宽度 / 1」—— 也就是**直接就是那个倍数** ✓（默认 1 → 1 / 1.25 / 1.5，观感不变 ✓）。
   *   势力那一档（势力线 / 填色线）**直接用「势力线宽」** pw，不乘基准缩放 ✓ */
  /* 两条各自的宽度（以前是一条 `_wScale` 管两边 ✗ 现在分开 ✓）
   *   默认都取 1 ✓ 老存档只有 w 时两边都跟着 w 走 ✓ */
  const _wScaleThin = _setWProv != null ? _setWProv : 1;
  const _wScaleParent = _setWRegion != null ? _setWRegion : 1;
  /* 宽度不再层层加粗（用户定的：父级链 / 涂色边界那个 1.25、1.5 的额外倍率取消掉 ✓）
   *   以前：本层 1.0× · 父层 1.25× · 填色 1.5× —— 都是拿「地方边界宽度」再乘一遍 ✗
   *        于是你在设置里拉 1，画出来却有三档粗细 ✓ 跟设置对不上 ✓
   *   现在：一律 1.0× = 就是你在「地方边界宽度」里拉的那个值 ✓
   *   层与层的区别交给浓度（地区 75% / 势力 100% ✓）和各自的宽度设置 ✓
   *   ⚠ 涂色边界（填色线）走的是「势力边界宽度」那个设置（_pwW ✓ 默认值 1.5 ✓）
   *     它本来就**没被乘过** ✗ 那个 1.5 是设置值本身、不是倍率 ✓
   *   ⚠ W_TOP 更是早就没人用了（死变量 ✗ 只有定义、搜不到任何引用 ✓）
   *     一并删掉 —— 留着迟早被谁当成「填色线该乘 1.5」捡起来用 ✓ */
  const W_THIN = 1.0 * _wScaleThin;      // 本层（子级）—— 听「**省份**边界宽度」✓
  const W_PARENT = 1.0 * _wScaleParent;  // 父级链 —— 听「**地区**边界宽度」✓（两者不再共用 ✓）
  /* **势力线宽 = 就是这个粗细** ✓（以前是"乘在别人身上的倍率" ✗ 用户说很难理解 ✓）
   *   单位跟「基准线宽」一样是"格"：势力那条线 / 势力层上的本层线 / 填色线 ——
   *   三条都**直接用这个值** ✓（它们本来就该一样粗 ✓），不乘基准缩放 ✗ */
  const _pwW = setNum('pw', 1.5);
  /* **势力那条线的粗细：跟「填色线」同一套规则** ✓（用户要求 ✓）
   *
   * 填色线（下面几行）是这么算的：
   *     max(链上最粗那条, baseW + 0.25) × 「填色线宽」倍率
   *     ↑ 浓度固定吃「势力边界浓度」_CA
   * 所以势力那条线就取**同一个下限、同一个基准** ✓（它是那条基准粗线，不加倍率 ✓）：
   *     powerW = max(thinBase + step * 2, baseW + 0.25)
   * 以前它是写死的 `thinBase + step * 2` = 0.75×基准 + 0.5 ✗
   * → 永远不等于你在设置里拉的那个宽度 ✓（用户报的"程度和设置不一样"✓）
   */
    if (state.grain != null && nEra > 0) {
    // **只画"上一层"这一条** —— 不要再一路往上扫：
    // 省份粒度时把区域/都扫进来，会冒出用户不要的上二级边界 ✗
    const _pt = Math.max(nEra, state.grain - 1);
    list.push({ tier: _pt, width: W_PARENT, show: showOf(_pt) });
    // 剧本（国家）那一圈仍旧画 —— 它有自己的一档浓度（「剧本国家边界」）✓
    // 粗细用 powerW ✓ = 跟填色线同一个下限、同一个基准 ✓（用户要求 ✓）
    list.push({ tier: Math.max(0, state.tier),
                width: _pwW, show: showOf(state.tier) });
  } else if (state.grain != null) {
    // 没有剧本层的数据（兜底）：只描**地理上的上一层**（父级）✓
    // 注意："爷爷级"不是更高的地理单位，而是**玩家填色的那条线**（见下面的 _paintIsTop）
    const pt = Math.max(0, state.grain - 1);
    list.push({ tier: pt, width: W_PARENT, show: showOf(pt) });
  } else {
    const detail = [fine, fine - 1];
    if (fine > 0 && detail.indexOf(state.tier) >= 0) {
      const pt = state.tier - 1;
      list.push({ tier: pt, width: thinBase + step, show: showOf(pt) });
    }
  }
  // 「父级边界」关着 → **不要链**，只留本层那一条线 ✓（必须放在构造之后 ✗）
  //   本层的浓淡**跟这条开关无关** ✓ —— 子级那条一律吃省份档（见下面 _bs ✓）
  //
  // **「爷爷级」= 玩家填色的那条线**（链上最粗、实心那一级），不是更高的地理单位 ✓
  // 所以 CK3 里「头衔·边界」+「填色·边界」一起开时：本层 0.5 / 父级 0.75 / 填色线 1.0 ✓
  // （以前这里还算过一个 hasGrand / _paintIsTop 用来"本层要不要压到 50%" ✗ ——
  //   现在本层**一律** 50%，那两个变量就都撤了 ✓）
  /* 「父级边界」关着 → 不要**中间那些父辈** ✓ 但**不能把整条链清空** ✗
   * 用户报的：剧本视图 + 开了粒度 + **只勾「势力 · 边界」**（父级边界没勾 ✗）
   *   → 那条"势力 / 国家"线是挂在**链上**的一环 ✓
   *   → `list.length = 0` 把它也一起清掉了 ✗
   *   → 本层那条线又归「地区 · 边界」（没开 ✗）→ **画面上什么都没有** ✓
   * 所以只清中间父辈 ✓ 剧本/势力那一环（tier < nEra）留着 ✓
   *（它跟「父级边界」是两回事：前者是独立的一层开关 ✓ 后者才是"要不要再往上画几环"✓）*/
  if (!state.showParentBorderTitle) {
    // **只留"开着的那一环"**：势力/剧本那一环 ✓
    //   `showPowerBorder` 关着就什么都不留 ✓ —— 原来那条"链就是空的"测试守的就是它 ✓
    //   这样两边诉求正好对上：只勾势力边界 → 有线 ✓；势力也没勾 → 依旧全空 ✓
    const _keepEra = list.filter((e) => nEra > 0 && e.tier < nEra && !!state.showPowerBorder);
    list.length = 0;
    for (const e of _keepEra) list.push(e);
  }
  // 浓度：本层 0.45（在下面设）；**有上两层时，上一级 0.75**；更高层实心
  const _PA = setNum('pa', 50) / 100;
  const _RA = setNum('ra', 75) / 100;
  const _CA = setNum('ca', 100) / 100;
  /* **水域边界那一对**（2026-10-16 ✓ 用户定的：**自己一套**，不沿用省份/地区那一档 ✓）
   *   ⚠ 挂在 syncParentBorder 里跟别的一起推 ✓ —— 它已经是"边界参数变化的必经之路"✓
   *     单独找个地方推的话，改设置 / 开图都得记着调一遍，漏一处就是"滑条是死的"✗ */
  const _WW = setNum('waterW', SET_DEFAULTS.waterW);
  const _WA = setNum('waterA', SET_DEFAULTS.waterA) / 100;
  pushRenderer('waterBorderW', _WW, 0.001);
  pushRenderer('waterBorderA', _WA, 0.001);
  /* **荒地边界那一对**（2026-10-17 ✓ 跟水域一样**自己一套** ✓
   *   用户要的是"荒地与荒地之间的边界"✓ 归它自己那两根滑条管 ✓
   *   ⚠ 出厂值跟水域那对对齐（宽 1 · 不透明度 25% ✓ 都是"很淡的辅助线"✓）*/
  const _QW = setNum('wasteW', SET_DEFAULTS.wasteW);
  const _QA = setNum('wasteA', SET_DEFAULTS.wasteA) / 100;
  pushRenderer('wasteBorderW', _QW, 0.001);
  pushRenderer('wasteBorderA', _QA, 0.001);
  // 剧本层（国家）那一圈吃「上两层浓度」；中间的父辈吃「父级浓度」✓
  // 剧本国家那一圈 = 「涂色」（100，实心）；其余父辈 = 「地区」✓
  for (let k = 0; k < list.length; k++) {
    const isEraRing = nEra > 0 && list[k].tier < nEra;
    list[k].alpha = isEraRing ? _CA : _RA;
  }

  // **子级（本层）那条线：任何时候都吃「省份边界浓度」（默认 50 ✓ 用户定的 ✓）**
  //   以前它分两档：有链（或"本来会有上两层"）→ 50，孤零零一条 → 默认档 75 ✗
  //   现在「默认边界浓度」这一档**整个去掉了** ✓（设置页那一行也删了 ✓）
  //   → 「父级边界」这个开关只管**链本身画不画**，不再改本层的浓淡 ✓
  //
  // **例外（用户定的）：「势力 · 边界」= 国家/tag 那一层，一律吃「势力边界浓度」** ✓
  //   （设置页那一档，内部字段仍叫 ca —— 以前它显示成「涂色边界浓度」）
  //   以前它在剧本视图里吃「省份/默认」（50/75），跑到链上当父辈时又吃这一档（100）✗
  //   → 同一根线两种浓淡。现在统一按这一档（默认 100 = 实心 ✓）
  //   注意判的是**编辑层**（editTier）不是视图层 ✗：开着粒度时"本层"是粒度那层（省份），
  //   它不是势力边界，仍旧该吃省份档 ✓
  const _isPowerBase = nEra > 0 && editTier() < nEra;
  const _bs = _isPowerBase ? _CA : _PA;
  if (state._borderStrengthBase == null) state._borderStrengthBase = renderer.borderStrength;
  if (_bs != null) pushRenderer('borderStrength', _bs);
  /* 「势力线宽」倍率（用户定的 ✓ 这个滑条**同时管两条线** ✓）
   *   滑条名字原来是「填色线宽」✓ 现在改叫「势力线宽」✓（见 index.html ✓ 内部字段仍叫 pw ✓
   *   免得旧存档和测试崩 ✗）
   *   它乘在**势力那条线**和**填色线**上 ✓ 两条线因此粗细完全一致 ✓（用户要求 ✓）*/
  
  // 本层（链上最细那条）也跟着细一档；没有链时恢复基准
  // **没有链 + 当前就在势力那层 → 这条本层线就是势力线** ✓
  // 要跟填色线同一套（同一个下限 + 乘「势力线宽」倍率）✓ 用户要求 ✓
  const _wBase = _isPowerBase ? _pwW : W_THIN;
  pushRenderer('borderWidth', _wBase, 0.01);

  // **填色边界**：它就是链上的**爷爷那一级** —— 粗细按"爷爷档"（基准×0.75 再加 0.5）+ 实心 ✓
  // 注意不能只取"链上最粗那条"：链短的时候（只有父级一级）那样拿到的是**父级档** ✗
  // 所以以"爷爷档"为下限 —— 链本身更粗就跟着链（剧本模式不变）✓
  const _pw = _pwW;             // 填色线：跟势力线**同粗** ✓（同一个设置值 ✓）
  pushRenderer('paintWidth', _pw, 0.01);
  pushRenderer('paintAlpha', _CA, 0.01);

  // 链跟渲染器现值一样就不动它（setExtraBorders 会置脏 ✓，别每帧都置）
  const same = renderer.extraCount === list.length
    && list.every((e, k) => renderer.extraTiers[k] === e.tier
      && Math.abs(renderer.extraWs[k] - e.width) < 0.01
      && renderer.extraShows[k] === (e.show ? 1 : 0)
      && Math.abs(renderer.extraAs[k] - (e.alpha != null ? e.alpha : 1)) < 0.01);
  if (!same) renderer.setExtraBorders(list);
  /* **边界图跟着重算** ✓（防抖 150ms ✓）
   *   为什么要挂在这儿：它是"视图层 / 粒度 / 那几条边的开关"变化的必经之路 ✓
   *   边界图的身份是按"当前层 + 当前粒度"算的 ✗ 这几样一变，掩码就过时了 ✓
   *   ⚠ 开图早期 state.tier 还是 -1，那次算出来是空的 ✗
   *     这里补上"层真正定下来之后"的那一次 ✓（防抖会把连续变化合成一次 ✓）*/
  
}

/* 「荒地自动上色」整套已删（2026-10-14 ✓ 水域 / 荒地 = 普通地块 ✓
 *   要给荒地上色就用普通手涂那条路，跟别的地块一样 ✓
 *   「清除荒地填色 / 自动涂色」两个按钮连同处理器一起退役 ✓）
 */

/**
 * 找"同一族"的头衔（**同色 + 同标签**）—— 给"以玩家为准"的涂色用。
 *
 * 只有剧本粒度、且开着「填色·边界」时，玩家一次用新颜色涂的那几个国家
 * 在这层就算一个国家；再点其中任何一个，整族一起涂 ✓
 *
 * @param {number} tid   点中的头衔（编辑层那一级）
 * @param {number[]} rgb 它的涂色
 * @param {string} label 它的标记名
 */
function playerGroupTids(tid, rgb, label) {
  // **从地块出发认族**：颜色 + 标记都一样的地块算一族 ✓（不查"头衔 → 颜色/名字"那两张表 ✗）
  const wr = rgb[0] | 0, wg = rgb[1] | 0, wb = rgb[2] | 0;
  const wantName = String(label || '');
  const et = editTier();
  const n = state.meta ? state.meta.numProvinces : 0;
  const pd = renderer && renderer.paintData;
  const out = [];
  const seen = new Set();
  for (let q = 1; q < n; q++) {
    if (!pd || pd[q * 4 + 3] === 0) continue;
    if (pd[q * 4] !== wr || pd[q * 4 + 1] !== wg || pd[q * 4 + 2] !== wb) continue;
    const lq = state.provLabel ? (state.provLabel[q] | 0) : -1;
    if ((lq >= 0 ? String(state.labelNames[lq] || '') : '') !== wantName) continue;
    const t0 = titleAt(q, et);
    if (t0 == null || t0 === NO_TITLE || seen.has(t0)) continue;
    seen.add(t0);
    out.push(t0);
  }
  if (out.indexOf(tid) < 0) out.push(tid);
  return out;
}

/**
 * 涂一笔（涂色工具和自测都走这里）。
 *
 * **只有剧本粒度（没开更细的粒度）+ 开着「填色·边界」时，以玩家为准**：
 * 玩家一次用新颜色涂的那几个国家算一个国家，点其中任何一个 → 整族一起涂 ✓
 */
/**
 * 从**点到的地块**出发认那一族：颜色 + 标记都一样的地块算一族，
 * 再把它们所在的（编辑层）头衔收进来。
 *
 * 不能按头衔级的账找（paintColor/titleLabel）—— 你停在跟涂色时**不同的粒度**时
 * 那个账对不上，族里就只剩它自己，于是"点了没反应" ✗
 */
function playerGroupTidsAt(pid) {
  const pd = renderer && renderer.paintData;
  const n = state.meta.numProvinces;
  if (!pid || !pd) return [];
  const et = editTier();
  const tm = state.titlemap;
  const want = identWantAt(pid, et);       // 身份内核只此一套（见 identFieldsAt ✓）
  if (!want) return [];
  // ⚠ 身份**只能逐格算** ✗ —— 同一个头衔底下的地块可以涂成不同颜色/不同标记，
  //   身份是按"这块地"算的，不能按头衔缓存（缓存过一版，结果整片认错族 ✓）
  const out = new Set();
  for (let q = 1; q < n; q++) {
    if (samePaintIdent(q, et, want)) out.add(tm[et * n + q]);
  }
  return Array.from(out);
}

/** 跟 playerGroupTidsAt 同一套身份（标签名 + 颜色），但返回**地块** —— 用于按地块逐块涂 ✓ */
function playerGroupPidsAt(pid) {
  const pd = renderer && renderer.paintData;
  const n = state.meta.numProvinces;
  if (!pid || !pd) return [];
  const et = editTier();
  const want = identWantAt(pid, et);
  if (!want) return [];
  const out = [];
  for (let q = 1; q < n; q++) if (samePaintIdent(q, et, want)) out.push(q);
  return out;
}

/**
 * **解析一格地的归属信息** —— 这项目里判断"这块地属于谁"只用它 ✓
 *
 * @param {number} pid    地块号
 * @param {number} [tier] 问**游戏那一侧**的哪一层（不传 = 编辑层）
 * @returns {{pid:number, painted:boolean,
 *            fill:?{name:string, rgb:number[]},
 *            owner:?{name:string, rgb:number[], tid:number}}}
 *
 *   · `fill`  —— **填色归属**（玩家那一侧）：标记名 + 颜色；没涂过就是 null ✓
 *   · `owner` —— **这一层的归属**（游戏那一侧）：名字 + 颜色 + 序号 ✓
 *
 * 判断"两块地是不是同一个归属"要**比这里的名字 + 颜色**（见 `sameOwner`）✓ ——
 * 不拿头衔序号去比 ✗：序号是数据内部的编号（换张图、换一层就变），
 * 名字 + 颜色才是"说得出来的那个归属" ✓
 * 而且填色那一侧和剧本那一侧**都看名字**，两边才对得上
 *（"涂成德国的那些地" ↔ "1936 剧本里的德国" ✓）
 *
 * 内容就是左栏「悬停地块」上那几行（每个层级一行 = 一个 `owner` ✓）。
 */
function provInfoAt(pid, tier) {
  if (!pid) return null;
  const t = (tier == null) ? editTier() : tier;
  const pd = renderer && renderer.paintData;
  const p4 = pid * 4;
  const painted = !!(pd && pd[p4 + 3] > 0);
  const lid = state.provLabel ? (state.provLabel[pid] | 0) : -1;
  const fill = painted ? {
    name: lid >= 0 ? String(state.labelNames[lid] || '') : '',
    rgb: [pd[p4], pd[p4 + 1], pd[p4 + 2]],
  } : null;
  const tid = titleAt(pid, t);
  const ok = tid != null && tid !== NO_TITLE;
  const owner = ok ? {
    tid,
    name: String(state.titles.names[tid] || ''),
    rgb: state.titles.colors[tid] || [150, 150, 150],
  } : null;
  return { pid, painted, fill, owner };
}

/** 两个"归属"是不是同一个 —— **比名字 + 颜色** ✓（名字一样、颜色不同 = 不是同一个 ✗） */
function sameOwner(a, b) {
  if (!a || !b) return false;
  if (String(a.name || '') !== String(b.name || '')) return false;
  const x = a.rgb || [], y = b.rgb || [];
  return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
}

/**
 * 「点这一下该动哪些地块」—— **涂色和还原共用这一个范围** ✓
 * 只在**剧本视图 + 没开粒度**时用得上（那个条件调用方判 ✓）。
 *
 * 🔴 **优先级**（2026-10-16 用户定的 ✓ —— **分两种模式** ✗）：
 *   · 「势力 · 边界」**开着** → **先看剧本归属**，没有就**最低粒度** ✓
 *     ⚠ **不看填色** ✗（用户原话："先看剧本再看最低粒度，不看填色"✓）
 *   · 「势力 · 边界」**关着**（= 填色那条路 ✓）→ **先看所指处的填色** ✓，
 *     没填色再看**剧本归属**，剧本也没归属（无主地 / 空白剧本那种）→ **最低粒度** ✓
 *     （用户原话："填色应优先看鼠标所指处的填色，无填色再剧本，
 *       剧本无归属再最低粒度"✓）
 *
 * 规则（用户给的，两个开关两条路）：
 *
 * **「势力 · 边界」开着**（而「填色 · 边界」没开）→ 按**剧本归属**整块 ✓
 *   例：巴黎在 1936 剧本里属法国、却被涂成了德国色 —— 指着巴黎，
 *   势力边界开着时目标是**整个法国** ✓（不管涂色 ✓）
 *
 * **否则**（「填色 · 边界」开着，**或者两个都没开** —— 那种也按填色算 ✓）→
 *   目标 = 「**填色归属**跟指着这块一样的」∪「**没涂过**、但**剧本归属**对得上的」✓
 *   例：指着涂成德国色的巴黎 → 目标是整个德国 = 涂成德国的那些 +
 *       没涂过且剧本属德国的那些 ✓
 *       指着没涂过的里昂 → 目标是"除了巴黎之外的整个法国" =
 *       涂成法国的那些 + 没涂过且剧本属法国的那些 ✓
 *      （巴黎涂的是德国色 ✗ 填色归属对不上、又已经涂过了 → 不算 ✓）
 *
 *   一句话：**涂过的看填色归属，没涂过的看剧本归属**；
 *   涂过的那块要是填色归属对不上，哪怕剧本归属是目标国也**不算** ✓
 *
 * 都没有就给最低单位那一块 ✓
 *
 * @returns {number[]|null} 目标地块（空 / null = 连最低单位都取不到）
 */
function paintTargetsAt(pid) {
  if (!pid || !(renderer && renderer.paintData)) return null;
  const n = state.meta.numProvinces;
  /* 🔴 **荒地要一块一块涂** ✗（用户报的 bug：涂一块荒地，整片荒地全上色 ✗）
   *
   *   荒地那些地块**共享同一个"归属"**（owner 名字一样 ✓，见 2242 / 2433 那几处的
   *   `#impassable` / 荒地伪头衔 ✓）—— 下面 B 段是按**名字**匹配的 ✓
   *   → 点一块，凡是"同一个归属"的荒地全被算进来 ✗ 整片一起变色 ✓
   *
   *   荒地本来就该当成**独立的地块**处理 ✓（跟海/湖不一样：海是一个头衔管一大片 ✓）
   *   所以在这儿直接返回它自己这一块 ✓，后面 A/B/C 三段都不走 ✓ */
  {
    const _fineTid = titleAt(pid, TIER_COUNT - 1);
    if (_fineTid != null && _fineTid !== NO_TITLE && isWastelandTid(_fineTid)) return [pid];
  }
  /* **剧本层 + 无粒度：没主的地块一律单格涂** ✓（2026-10-15 用户定的口径——
   *   "是不是有一个更简单的操作，把没有主的地块在剧本层无粒度时统一按单格涂色" ✓）
   *   · 剧本层的格子分两类，**归属说了算**：
   *     · **有主**（真头衔，`1444_MNG` 那种 ✓）→ 照旧走下面的 A/B/C 归属匹配 ✓
   *       （点一笔涂整国 —— 那是"涂归属"的本意 ✓）
   *     · **没主**（无主陆地 NO_TITLE / 海·湖·河·不可通行·荒地的类片 ✓ tid ≥ 真头衔数）
   *       → **一律单格** ✓ —— 悬停已经单格（applyHoverHighlight 同一判定 ✓），
   *       涂色同一个口径 ✓ 擦除走同一个函数 ✓ 一起成立 ✓
   *   · 判据 = **编辑层那一行的 tilemap 有没有主**（titleAt(pid, editTier) ✓）
   *     —— 上一刀用最细层判水，用户提的这把更简单更全 ✓
   *   · 粒度层（开了粒度 / 地理层）不在此列 ✓ —— 真名海片整片涂的老规矩保留 ✓ */
  {
    const _nEraP = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
    if (_nEraP > 0 && state.grain == null && editTier() < _nEraP) {
      const _tid0 = titleAt(pid, editTier());
      const _real = state.meta && state.meta.numRealTitles != null
        ? state.meta.numRealTitles : 1e9;
      /* 🔴 **"填色优先"那条路上，所指处有填色就不吃这一刀** ✗✗
       *   （2026-10-16 用户报的 ✓）
       *   用户原话："在剧本+无粒度时，**填色应优先看鼠标所指处的填色**，
       *     无填色再剧本，剧本无归属再最低粒度"✓
       *
       *   ⚠ 这一刀本身是给"**没涂过的**无主地"用的（2026-10-15 定的：无主地按单格 ✓）——
       *     而**空白剧本那一层全是无主** ✗ → 这一刀对每一格都成立 →
       *     玩家涂出来的那块色块**永远只能单格** ✗（整块涂色动不了 ✓）
       *   涂过的地**在手绘层上有身份**（标记名 + 颜色 ✓ 见 paintIdentAt ✓）→
       *   放它过这一刀，交给下面按**填色归属**整块认 ✓
       *
       *   ⚠ 2026-10-17：「剧本 · 边界」那个勾删了 → 不再有"先剧本、不看填色"的分支 ✓
       *     现在**永远先看填色** ✓ */
      const _pdP = renderer && renderer.paintData;
      const _paintedP = !!(_pdP && _pdP[pid * 4 + 3] > 0);
      if (!_paintedP
          && (_tid0 == null || _tid0 === NO_TITLE || _tid0 >= _real || isWastelandTid(_tid0))) {
        return [pid];
      }
    }
  }
  const eraT = countryTier();                    // 「最近的**有主**剧本层」✓
  const mine = provInfoAt(pid, eraT);
  if (!mine) return null;

  // 填色那条（「势力 · 边界」开着/关着都走它 ✓）
  const myFill = mine.fill;
  const wantName = myFill ? String(myFill.name || '')
                          : (mine.owner ? String(mine.owner.name || '') : '');
  if (wantName) {
    const out = [];
    for (let q = 1; q < n; q++) {
      const o = provInfoAt(q, eraT);
      if (!o) continue;
      if (o.painted) {
        // **涂过的**：认填色归属，名字必须对上 ✓
        if (!o.fill || String(o.fill.name || '') !== wantName) continue;
        // 指着的那块**涂过**时还要求**同色同标记** ✓；
        // 指着没涂过时只比名字（"涂成法国的那些"用别的颜色也算 ✓ 用户例子）
        if (myFill && !sameOwner(o.fill, myFill)) continue;
        out.push(q);
      } else if (o.owner && String(o.owner.name || '') === wantName) {
        // **没涂过的**：认剧本归属 ✓
        out.push(q);
      }
    }
    if (out.length) return out;
  }

  // C. 都没有 → 只动最低单位这一块 ✓
  const fine = titleAt(pid, TIER_COUNT - 1);
  if (fine == null || fine === NO_TITLE) return null;
  const one = pidsOf(fine);
  return one.length ? one : null;
}

/**
 * **按地块涂（或擦）** —— 一次写下去，**不经过头衔** ✓
 *
 * 手绘层的真相就是"每一格自己的颜色 / 标记 / 归属"（见 `provInfoAt` 的注释 ✓），
 * 所以落笔单位**就是地块**：写 `paintData` + `provLabel` + `provTitle` 三样 ✓
 *
 * 以前主路径是"头衔 → `syncPaint` → 按那一层扫 `titlemap` 把地块找回来" ✗ ——
 * 绕一圈，还得先知道"这块地属于哪个头衔"（涂色本不该关心这个 ✓），
 * 而且那套把"一格的笔迹"和"一个头衔"绑在了一起 ✗
 *
 * @param {number[]} pids
 * @param {number[]|null} rgb  给了就涂这个色（标记名用当前画笔 ✓）；null = 擦掉
 */
function paintPids(pids, rgb) {
  const n = state.meta ? state.meta.numProvinces : 0;
  const name = rgb ? String(state.brushLabel || '') : '';
  const lid = name ? labelIdOf(name) : -1;
  const fine = TIER_COUNT - 1;
  for (const q of pids) {
    if (!(q > 0) || q >= n) continue;
    if (rgb) {
      renderer.setPaint(q, rgb[0] | 0, rgb[1] | 0, rgb[2] | 0, 255);
      renderer.setPaintLabel(q, lid >= 0 ? lid : 0);
      if (state.provLabel) state.provLabel[q] = lid;
      // 「哪一笔涂的」记成**这一格自己的最细层节点** ✓（账本 / 撤销要用，见 recomputePainted）
      if (state.provTitle) state.provTitle[q] = titleAt(q, fine);
    } else {
      renderer.setPaint(q, 0, 0, 0, 0);
      renderer.setPaintLabel(q, 0);
      if (state.provLabel) state.provLabel[q] = -1;
      if (state.provTitle) state.provTitle[q] = -1;
    }
  }
  blocksDirty = true;
  labelDirty = true;
  scheduleSave();
  markPaint();   // "改动 N" 的状态栏刷新在 recomputePainted() 里统一做 ✓（见那儿）
  // **边界图跟着变** ✓（身份变了 ✓ 防抖 150ms —— 拖动时每帧一笔，不能每帧重算 ✗）
  
}

/** 把这一批地块一次涂完 / 擦完，**合成一条历史** ✓（一次点击 = 一步撤销） */
function paintPidsAsOne(pids, rgb) {
  if (!pids || !pids.length) return;
  const snaps = snapshotPidsList(pids);      // 快照**按地块**拍，不绕头衔 ✓
  paintPids(pids, rgb);
  recomputePainted();                        // 账本按"每格有没有颜色"重算 ✓
  pushPatches(snaps);
}

/** 某个地块的"身份"（标签名 + 颜色）—— 涂色分支要用它判断"整块是否同族" ✓
 *
 *  实现整个搬到 paintIdentAt()（见下面那一段）✓ —— 这里只留一层
 *  "看当前编辑层"的壳，免得两处判据各走各的 ✗ */
function paintIdentOf(q) {
  if (!q || !(renderer && renderer.paintData)) return null;
  return paintIdentAt(q, editTier());
}

// ---------------------------------------------------------------- 地块身份
//
// 「这块地算哪一个色块 / 哪一族」在项目里问过很多次（认族、改名、涂色、图例、
// 悬停高亮），判据是同一套：**显示出来的名字 + 显示出来的颜色** ——
//
//   涂过的地 → 手绘色 + 那一笔的标记名
//   没涂的地 → 原版色 + 该层头衔名
//   都没编号的（海/无主地）→ 没有身份（null）
//
// 以前这几件事各写各的 identOf（playerGroupTidsAt / playerGroupPidsAt /
// paintIdentOf 三份几乎一模一样的循环 ✗），改一处就得记得改三处。
// 而且它们都在**全图扫**里被逐格调用 —— 每次都要 new 一个 [r,g,b] 数组
// 只为拼个字符串（V3 4 万格 = 一次点击 4 万个短命数组 ✗）。
//
// 现在统一走 paintIdentAt()：**不分配数组**，颜色直接拼数字 ✓
// 而需要真颜色数组的地方（画图、取色）仍旧用 stableColor ✓

/**
 * 一块地的"身份"内核（显示名 + 显示色）—— **认族唯一的判据** ✓
 *
 * 写进一张**复用**的临时表，返回值只在"调完立刻比"的时候有效 ✓
 * 全图扫（V3 4 万格）时一格一个 `[r,g,b]` / 一个 `"名字|r,g,b"` 字符串
 * 就是几万次短命分配 ✗ —— 这里一个都不分 ✓
 *
 * 判据（跟改造前逐字一致 ✓）：
 *   涂过的 → 手绘色 + 那一笔的标记名（跟这一层有没有主无关 ✓）
 *   没涂的 → 原版色 + 该层头衔名；两者都没有 → null（海 / 无主地）
 *
 * @returns {?Array} `[name, r, g, b]`（**共用数组** ✓ 要留着就拷一份，见 `identWantAt`）
 */
const _identTmp = [null, 0, 0, 0];
function identFieldsAt(q, tier) {
  if (!q) return null;
  const pd = renderer && renderer.paintData;
  const q4 = q * 4;
  const painted = !!(pd && pd[q4 + 3] > 0);
  const t0 = titleAt(q, tier);
  // **没涂过的无主地：没有身份** ✓（不参与认族）
  // **涂过的照旧有** ✓ —— 名字和颜色都在手绘层上，跟这一层有没有主无关 ✓
  // （空白剧本那一层全是无主地，涂出来的色块就靠这一条才能"同色同标记算一族" ✓）
  if ((t0 == null || t0 === NO_TITLE) && !painted) return null;

  const lq = state.provLabel ? (state.provLabel[q] | 0) : -1;
  _identTmp[0] = painted
    ? (lq >= 0 ? (state.labelNames[lq] || '') : '')
    : (state.titles.names[t0] || '');
  if (painted) {
    _identTmp[1] = pd[q4]; _identTmp[2] = pd[q4 + 1]; _identTmp[3] = pd[q4 + 2];
  } else {
    const c = state.titles.colors[t0];
    if (!c) { _identTmp[1] = 150; _identTmp[2] = 150; _identTmp[3] = 150; }
    else { _identTmp[1] = c[0]; _identTmp[2] = c[1]; _identTmp[3] = c[2]; }
  }
  return _identTmp;
}

/** 身份串（`名字|r,g,b`）—— 给"要拿它当 Map 键 / 比相等"的地方用 ✓ */
function paintIdentAt(q, tier) {
  const f = identFieldsAt(q, tier);
  return f ? f[0] + '|' + f[1] + ',' + f[2] + ',' + f[3] : null;
}

/** 把当前这一格的身份**拷成快照** ✓（临时表会被下一次调用覆盖 ✗） */
function identWantAt(q, tier) {
  const f = identFieldsAt(q, tier);
  return f ? [f[0], f[1], f[2], f[3]] : null;
}

/** 跟 `paintIdentAt(q,tier) === want` 等价，但**不拼字符串** ✓（全图扫专用）
 *  @param {string[]} want `identWantAt` 给的快照 */
function samePaintIdent(q, tier, want) {
  const f = identFieldsAt(q, tier);
  return !!f && f[0] === want[0] && f[1] === want[1]
    && f[2] === want[2] && f[3] === want[3];
}

// ── 悬停用：满足「停在国家那几层 + 无粒度 + 填色·边界开」时，
//    颜色与势力名都用**玩家涂完之后的当前结果** ✓（两个悬停卡片共用 ✓）
function liveHoverOn() {
  const nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  return nEra > 0 && state.grain == null && !!state.showBorderPaint && editTier() < nEra;
}
function liveColorOf(pid, tid) {
  return liveHoverOn() ? stableColor(pid || 0, tid) : null;
}

function paintAt(pid, tid) {
    // 没头衔 / 越界：不涂（界面上走不到这儿 —— actAt 会把无主地换到最细那层 ✓，
    // 但外部直接调它（脚本 / 测试）时别崩 ✗）
    if (!state.titles) return;
    if (tid == null || tid === NO_TITLE || tid < 0 || tid >= (state.titles.keys || []).length) return;
    const to = state.brush.slice();
    /* **"要不要真的动手"看这一格自己**（`provInfoAt` 解析出来的三样 ✓），
     * 不看"那个头衔涂过没有" ✗ ——
     *   颜色一样、标记也一样 → 这一笔等于什么都没做，直接返回 ✓
     *   颜色一样但**标记变了** → 必须继续（同色换个标记再涂一遍是常规操作 ✓）
     *（早先这里只看颜色，于是"同色不同标记"点了没反应、标记永远改不掉 ✓）
     */
    const _here = provInfoAt(pid);
    const _wantLabel = String(state.brushLabel || state.titles.names[tid] || '');
    if (_here && _here.fill) {
      if (sameColor(_here.fill.rgb, to) && String(_here.fill.name || '') === _wantLabel) return;
    }
    //（荒地的"允许上色"总闸已删 ✓ —— 水片 / 荒地片跟普通头衔一样可涂 ✓）
    // **剧本视图下的口径**：一笔涂哪些地块，由 `paintTargetsAt` 统一算 ✓
    //   势力边界 → 剧本归属整块；否则 → 涂过的看填色归属、没涂过的看剧本归属 ✓
    //   还原那边（actAt 的 erase 支线）用的是**同一个函数** ✓ 涂了什么就还原什么
    {
      const _nEra1 = (state.meta.eraDates && state.meta.eraDates.length) || 0;
      const _eraOnly = _nEra1 > 0 && state.grain == null && editTier() < _nEra1;
      if (_eraOnly) {
        const _pids = paintTargetsAt(pid);
        if (_pids && _pids.length) { paintPidsAsOne(_pids, to); return; }
      }
    }
    // 没走"填色那条"（细层 / 开了粒度）→ 把**编辑层那一块**展开成地块，按地块涂 ✓
    paintPidsAsOne(pidsOf(tid), to);
}

/**
 * 按**头衔**涂 —— 只是 `paintPids` 的一层薄壳 ✓
 *
 * 给两条路用：**导入旧档**（文件里那个 key 可能是任意一层的头衔 ✗）和**测试** ✓
 * 界面上的涂色一律走 `paintAt → paintTargetsAt/pidsOf → paintPids`（落笔单位是地块 ✓），
 * 所以这里**不再**维护"头衔 → 颜色/名字"那两张表（`paintColor` / `titleLabel` 已经删了 ✓）
 */
function paintTitle(tid, rgb, noHistory) {
  const pids = pidsOf(tid);
  if (!pids.length) return;                 // 没头衔的头衔号：动作等于没做 ✓（涂色单位本来就是地块 ✓）
  const c = [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0];
  const _snap = noHistory ? null : snapshotPidsList(pids);
  paintPids(pids, c);
  recomputePainted();
  if (_snap) pushPatches(_snap);            // noHistory：调用方（整族涂）自己合成一条 ✓
}

/** 按**头衔**还原（擦掉手绘）—— 同样是 `paintPids` 的薄壳 ✓（头衔级的清理 / 测试用） */
function restoreTitle(tid, noHistory) {
  const pids = pidsOf(tid);
  if (!pids.length) return;
  const _snap = noHistory ? null : snapshotPidsList(pids);
  paintPids(pids, null);
  recomputePainted();
  if (_snap) pushPatches(_snap);
}


// ================================================================ 相机

function viewRect() {
  const w = $('stage').clientWidth / state.cam.scale;
  const h = $('stage').clientHeight / state.cam.scale;
  return { x: state.cam.cx - w / 2, y: state.cam.cy - h / 2, w, h };
}

/* **能缩到多小** ✓（2026-10-13 用户要求："缩放时我希望允许画面出现地图的边界以外的一部分"）
 *
 *  ⚠ 以前这里是"**刚好把整张图放进视口**"✗ —— 缩到那个比例就顶死了 ✓
 *    于是你永远看不到地图外面的东西：地图边缘永远贴着视口边 ✓
 *  ✅ 现在再多给 **30%** 的余量（能缩得比"刚好放下"更小一点 ✓）——
 *    缩到底的时候，四周会露出一圈**地图边界以外的空地**（背景色 ✓）
 *    看全貌 / 截图留白 / 确认某块地在图上的位置都用得上 ✓
 *  ⚠ 只放 30% 不是无限 ✗ —— 放开了地图会缩成屏幕中间一小块，反而不好操作 ✓ */
function minScale() {
  const stage = $('stage');
  const fit = Math.min(stage.clientWidth / state.meta.mapWidth,
                       stage.clientHeight / state.meta.mapHeight);
  const s = fit * 0.7;
  /* stage 会瞬时量出 0×0（切后台 / 嵌入容器收放）→ 别把 0 写进相机缩放，否则整图全黑 ✓ */
  if (Number.isFinite(s) && s > 0) return s;
  return (state.cam && state.cam.scale > 0) ? state.cam.scale : 1;
}

/** 相机允许**露出一部分地图外面** ✓（2026-10-13 用户要求 ✓）
 *
 *  ⚠ 以前是硬夹在地图内 ✗：哪边地图比视口小就居中、比视口大就不许把边缘拖进来 ✓
 *    结果是**边缘永远顶在视口边上**，一点地图外的空地都看不到 ✓
 *  ✅ 现在允许两边各露出 **30% 视口**的余量：
 *    · 地图比视口大 → 能多拖出去一截，看到边界外的空地 ✓
 *    · 地图比视口小 → 不再强行居中，能挪到旁边去（方便对着别的东西看 ✓）
 *  ⚠ 但不能**无限**拖 ✗ —— 留 30% 是"不至于把地图整个拖出视野、还能找回来" ✓
 *  ⚠ 那个 `_clampC`：`vw >= W` 时上下限会**反过来** ✗ 直接 clamp 会给出个诡异值 ✓
 *    所以上下限交叉时取**中点**（＝居中 ✓），跟以前那个三目表达式一个效果 ✓ */
function clampCamera() {
  const stage = $('stage');
  const vw = stage.clientWidth / state.cam.scale;
  const vh = stage.clientHeight / state.cam.scale;
  const W = state.meta.mapWidth;
  const H = state.meta.mapHeight;
  const mx = vw * 0.3;
  const my = vh * 0.3;
  const _clampC = (c, lo, hi) => (lo > hi ? (lo + hi) / 2 : clamp(c, lo, hi));
  state.cam.cx = _clampC(state.cam.cx, vw / 2 - mx, W - vw / 2 + mx);
  state.cam.cy = _clampC(state.cam.cy, vh / 2 - my, H - vh / 2 + my);
}

function invalidate() {
  clampCamera();
  const v = viewRect();
  renderer.setView(v.x, v.y, v.w, v.h);
  labelDirty = true;
  $('status-zoom').textContent = (state.cam.scale * 100).toFixed(0) + '%';
}

/** 按视口比例平移视角（方向键用）。invalidate 里会做边界夹取，跑不出地图 */
function panBy(dx, dy, ratio) {
  const v = viewRect();
  state.cam.cx += dx * v.w * ratio;
  state.cam.cy += dy * v.h * ratio;
  invalidate();
}

function fitView() {
  const stage = $('stage');
  /* ⚠ 视口会**瞬时塌成 0×0**（切后台 / 嵌入容器；实测进图那几秒约一半概率撞上
     那一瞬）——这一下量出来的"适配缩放"是 0，写进去就是**黑屏**
     （用户报的那次：缩放 0%、地图全黑，点「⤢」才回来 ✗）。
     量不到有效尺寸就**先不动相机**，下一帧再试 ✓（布局回来就有值）；
     给个次数上限兜底，真的一直量不到（页面藏着没显示）就别空转了 ✓ */
  if (!(stage.clientWidth > 0) || !(stage.clientHeight > 0)) {
    if ((fitView._retry = (fitView._retry || 0) + 1) <= 120) requestAnimationFrame(fitView);
    return;
  }
  fitView._retry = 0;
  state.cam.scale = minScale();
  state.cam.cx = state.meta.mapWidth / 2;
  state.cam.cy = state.meta.mapHeight / 2;
  invalidate();
}

function screenToMap(clientX, clientY) {
  const rect = $('stage').getBoundingClientRect();
  const v = viewRect();
  return [v.x + ((clientX - rect.left) / rect.width) * v.w,
          v.y + ((clientY - rect.top) / rect.height) * v.h];
}

function zoomBy(factor, anchorX, anchorY) {
  const before = screenToMap(anchorX, anchorY);
  state.cam.scale = clamp(state.cam.scale * factor, minScale(), 12);
  const after = screenToMap(anchorX, anchorY);
  state.cam.cx += before[0] - after[0];
  state.cam.cy += before[1] - after[1];
  invalidate();
}

/**
 * 搜索定位时该用多大缩放 —— 按**地盘大小**算。
 *
 * 以前这里写死 0.35：搜到一个小男爵领，飞过去还是全图视角，等于没定位 ✗。
 * 地盘按面积开方就是它的"直径"（像素），让它大约占屏幕高度的三分之一：
 * 屏幕上能看到的纵向地图像素数 = cssH / scale，取 diameter ≈ 0.35 * 那个值。
 */
function searchJumpScale(tid) {
  const t = state.titles;
  const px = Math.max(t.area ? t.area[tid] || 0 : 0, 1);
  const dia = Math.sqrt(px);           // ≈ 地盘的直径（像素）
  const cssH = ($('map') && $('map').clientHeight) || 820;
  const want = (0.35 * cssH) / Math.max(dia, 1);
  return clamp(want, minScale(), 12);
}

function flyTo(tid, targetScale = null) {
  const t = state.titles;
  // **跳不了就安静地不跳** ✓：定位是附赠功能 ✓ 没有地盘（或没算出标签点）就没得跳 ✗
  // 以前这里弹一条"这个势力没有地盘，定位不了" ✗ —— 可搜势力本来就不是为了定位 ✓
  // （用户原话：本来搜势力就不需要定位啊 ✗）
  if (t.lx[tid] == null) return;
  state.cam.cx = t.lx[tid];
  state.cam.cy = t.ly[tid];
  if (targetScale) state.cam.scale = clamp(targetScale, minScale(), 12);
  state.focus = tid;
  state.focusUntil = performance.now() + 2200;
  invalidate();
}

// ================================================================ 悬停

function updateHover(clientX, clientY) {
  const [mx, my] = screenToMap(clientX, clientY);
  const pid = provinceAt(mx, my);

  if (pid !== state.hover.pid || !state.hover.inside) {
    state.hover.pid = pid;
    state.hover.tids = Array.from({ length: TIER_COUNT }, (_, i) => titleAt(pid, i));
    renderHoverCard(pid);
    const hl = hoverTargetTid(pid, state.hover.tids[viewTierFor(pid)]);
    // 海 / 山是背景板，不给选中，也不高亮
    applyHoverHighlight(pid, hl);
    labelDirty = true;
    updateCursor(hl, pid);
  }
  state.hover.inside = true;

  $('status-pos').textContent = `${Math.floor(mx)}, ${Math.floor(my)}`;
  positionHoverCard(clientX, clientY);
}

/** 海 / 山这类伪头衔，key 以 '#' 开头，它们不属于任何层 */
/** 悬停高亮该看哪个节点：海/湖/不可通行/荒地这些**共享的粗层伪节点**，
 *  换成光标底下**最细层**的那一个（海洋就能一块一块地查、一块一块地亮）✓ */
/**
 * 这个名字是不是"能给玩家看的"：
 *   · 含中文/日文等非 ASCII → 是
 *   · 正常地名（有空格、大小写混合，如 Gulf of Bothnia）→ 是
 *   · 机器串（全大写 NORWEGIAN IMPASSABLE 1 / 纯小写键名 river_hooghly）→ 不是
 *     （CK3 的不可通行海域就是这类占位串，游戏里也不显示名字）
 */
/**
 * 手工翻译表：这些水块名（海/湖/屏障）在游戏本地化里**确实没有中文**
 * （基础中文 + 11 个 workshop 汉化 mod 里都查过，没有对应条目），
 * 所以在这儿人工补上 —— 放 app 里，重烤数据也不会丢 ✓
 */
const MANUAL_WATER_NAMES = {
  'ATLANTIC EUROPE-AFRICA': '大西洋欧洲-非洲',
  'ATLANTIC TI': '大西洋',
  'INDIAN OCEAN TI': '印度洋',
  'Coast of Siberia': '西伯利亚海岸',
  'Sea of Okhotsk': '鄂霍次克海',
  'BAIKAL': '贝加尔湖', 'Peipus': '佩普西湖', 'Khanka': '兴凯湖',
  'Lop Nur Lake': '罗布泊', 'Tiveriade Lake': '加利利海',
  'Saimaa': '塞马湖', 'Näsijärvi': '奈西湖', 'Oulujärvi': '奥卢湖',
  'Chott el Djerid': '杰里德盐湖', 'ZIWAY_LAKE': '济韦湖', 'ABHE': '阿贝湖',
  'WOLLO_HIGHLANDS': '沃洛高地', 'North Shanxi': '晋北', 'eastern Mongolia': '蒙古东部',
  'JPN': '日本',
  'Borneo Lakes': '婆罗洲湖泊群', 'EAST OF BURMA': '缅甸东部',
  'EAST TURKISH LAKES': '土耳其东部湖泊群', 'WEST TURKISH LAKES': '土耳其西部湖泊群',
  'FINISEH LAKES 1': '芬兰湖泊群 1', 'FINNISH LAKES 2': '芬兰湖泊群 2',
  'ICELANDIC LAKES': '冰岛湖泊群', 'MIDDLE SWEDEN LAKES': '瑞典中部湖泊群',
  'NORTH SWEDEN LAKES': '瑞典北部湖泊群', 'SOUTH SWEDEN LAKES': '瑞典南部湖泊群',
  'SOUTH NORWAY LAKES': '挪威南部湖泊群', 'Moroccoan Lakes': '摩洛哥湖泊群',
  'RUSSIAN LAKES 2': '俄罗斯湖泊群 2', 'RUSSIAN LAKES 4': '俄罗斯湖泊群 4',
  'Sumatra lakes 1': '苏门答腊湖泊群 1', 'Sumatra lakes 2': '苏门答腊湖泊群 2',
  'TIBETAN LAKES': '西藏湖泊群',
  'Philippines lake south': '菲律宾南部湖泊', 'Philippines lakes north': '菲律宾北部湖泊',
  // HOI4 战略区里汉化 mod 没覆盖的（10 个）
  'Bolovia': '玻利维亚', 'East Karelia': '东卡累利阿', 'Ferghana': '费尔干纳',
  'Gulf of Bothnia': '波的尼亚湾', 'North-Western Australia': '澳大利亚西北部',
  'Northern Norrland': '北诺尔兰', 'Patagonia': '巴塔哥尼亚',
  'Tanscaspia': '外里海', 'Transbaikal': '外贝加尔', 'Western Finland': '芬兰西部',
};

/** 手工表里有没有这一条（有就显示中文，不看"是不是机器串"那套） */
function manualWaterName(name) {
  if (name == null) return null;
  return MANUAL_WATER_NAMES[String(name)] || null;
}

function readablePlaceName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return false;
  if (/[^\x00-\x7f]/.test(s)) return true;           // 有非 ASCII（中文等）✓
  if (/^[A-Z0-9 _\-]+$/.test(s)) return false;         // 全大写机器串 ✗
  if (/^[A-Z]{2,}\s/.test(s)) return false;            // LAKES eastern Mongolia 这种 ✗
  if (/^[a-z0-9_]+$/.test(s)) return false;             // 纯小写键名 ✗
  return /[A-Za-z]/.test(s);                            // 其余（Gulf of Bothnia）✓
}

function hoverTargetTid(pid, tierTid) {
  const real = state.meta.numRealTitles != null ? state.meta.numRealTitles : 1e9;
  const fine = state.hover.tids.length - 1;
  const special = tierTid == null || tierTid === NO_TITLE || tierTid >= real
    || isWastelandTid(tierTid);
  if (special) {
    const own = state.hover.tids[fine];
    if (own != null && own !== NO_TITLE) return own;
  }
  return tierTid;
}

function isSpecialTid(tid) {
  if (tid == null || tid === NO_TITLE) return false;
  const K = state.titles && state.titles.keys;
  const k = K ? K[tid] : null;
  return typeof k === 'string' && k.charCodeAt(0) === 35;
}

/** 🔴🔴 **能不能涂这一格 —— 一句话判据** ✗✗（2026-10-16 用户定的 ✓）
 *
 *  用户原话："**鼠标所指处的最低单位的身份 id 是否为陆地 or 荒地，是则涂色，否则不涂色**"✓
 *
 *  → 就这么判 ✓ 别搞复杂 ✗
 *    · 身份标（`kindMask` ✓ 底层地块身份 ✓）**1 = 陆地 · 6 = 不可通行区域** → 能涂 ✓
 *    · 其余（2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域）→ **不许涂** ✓
 *
 *  ⚠ 老包（没有 `kindMask`）退回**最细层的键前缀** ✓ 一格一个身份 ✓ 结论一样 ✓
 *  ⚠ **"逐块荒地"是个例外** ✗ —— 那批（`wl_<地块号>` ✓）在身份标里写的是 **1** ✓
 *    可它们明明是不可通行 ✓ 光看码会把它们误判成"陆地、能涂" ✓
 *    （那正是 10-14 定的"荒地要能一块块涂"✓ 不能丢 ✓）→ 补一句 `isWastelandTile` 即可 ✓
 *  ⚠ 两个判据都**只看地块号** ✓ 跟"现在停在哪一层、那个 tid 是谁"无关 ✓
 *    （粗层那片水共用一个 `#sea_*` 伪头衔 ✓ 光看 tid 认不出"这一格到底是不是水"✗）
 */
function isPaintable(pid) {
  if (!pid) return false;
  const k = kindOfPid(pid);
  /* 身份标就说是"河 / 湖 / 海 / 不可通行海域"（码 2~5）→ **不许涂** ✓ 别的都好说 ✓ */
  if (k >= 2 && k <= 5) return false;
  /* 码 1（陆地）/ 6（不可通行区域）/ 老包认不出来的 → **能涂** ✓
   * ⚠ 逐块荒地（`wl_<地块号>` ✓）在身份标里写的是 **1** ✗ 但它本来就该能涂 ✓
   *   所以这里**不用再判荒地** ✓（那批进了码 2~5 的只有"不可通行海域"✓ 那个该锁 ✓）
   *   —— 一句话就是用户那句："**是陆地 or 荒地就涂，否则不涂**" ✓ */
  return true;
}

/** 能不能对这块地动手
 *
 * 🔴 **2026-10-16 用户改的口径**："为填色做 id 区分，**河流 / 海洋 / 不可通行海域 /
 *    湖泊禁止上色**"✓ —— 判据收成一句话：**身份 id 是陆地 or 荒地才给涂** ✓
 *
 * ⚠ 跟 10-14 那条**相反** ✗（那天定的是"水片 / 荒地片 = 普通头衔，想涂就涂"✓）——
 *   以**现在**这条为准 ✓
 * ⚠ 只有"压根没头衔"照旧锁（那种地动手时该落到更细一层 ✓ 见 actAt ✓）
 *
 * @param tid 头衔号（可空 —— 调用方有时只拿得到地块号 ✓）
 * @param pid 地块号（**给了才判得了身份** ✓ 不给就只按头衔判 ✓）
 */
function isLocked(tid, pid) {
  if (pid) return !isPaintable(pid);
  return tid === NO_TITLE || tid == null;
}

/** 能编辑的地块给十字光标，锁住的给禁止符 */
function updateCursor(tid, pid) {
  const el = $('map');
  if (state.tool === 'view') { el.style.cursor = 'grab'; return; }
  el.style.cursor = isLocked(tid, pid) ? 'not-allowed' : 'crosshair';
}

/** 这个省份是不是**没有男爵领、拿伯爵领色块顶**的那种（快查表） */
function isDegradedBaron(pid) {
  const s = state.meta && state.meta.degradedSet;
  return s ? s.has(pid) : hasIn(state.meta && state.meta.degradedBaronies, pid);
}

function renderHoverCard(pid) {

  const box = $('hover-chain');
  /* 🔴 **那个小方格 = 所指地块的"最低级别号码"** ✗✗（2026-10-16 用户第二次拍 ✓）
   *
   *   用户原话："悬停时左侧栏的那个方块的左上角，有一个小字，那边**被你改成显示地名了**，
   *     应当**始终显示所指地块的最低级别的号码**"✓
   *
   *   ⚠ 我 2026-10-15 把它改成了"真名 → 类别名"那套 ✗（理由是"任何一行都不许出现编号"✓）——
   *     那条口径说的是**卡片那两行** ✓ 这个小格子是**另一回事** ✓ 用户现在点明了：
   *     这里**就是要号码** ✓（它是给"这块地到底是多少号"用的定位信息 ✓）
   *   ⚠ 前一轮的 `#` 前缀也该撤 ✗ —— 原话是"**号码**" ✓ 就是光秃秃的数字 ✓
   *   ⚠ 最低级别 = 最细那一层的**地块号** = pid 本身 ✓（不是头衔号 ✗）
   *     —— 这跟 `hoverTileLines` 的"最低单位"是同一个东西 ✓ 两处口径一致 ✓ */
  $('hover-pid').textContent = pid ? String(pid | 0) : '';


  if (!pid) {
    box.innerHTML = `<p class="empty">${GAME.notInMap}</p>`;
    return;
  }
  box.innerHTML = '';

  /* 海 / 湖 / 河 / 荒地：背景地块 —— 侧栏**不列层级**，只给那两行 ✓
   * 🔴 跟悬停卡片**同一个出处**（`hoverTileLines` ✓ 用户 2026-10-16 的规格表 ✓）——
   *   以前这儿自己拼了一套（`_hideName` / `_typeLabel` / `_realName` 那一大堆 ✗），
   *   跟卡片各说各的 ✓ 规格一改就只改到一边 ✓ 现在收口了 ✓
   * ⚠ 只有两类走这儿：
   *   ① 伪头衔地块（键以 `#` 开头 ✓ 海 / 湖 / 河 / 不可通行 ✓）
   *   ② 荒地（`wl_*` / `#wasteland_*` / `isWastelandTid` ✓）
   *   —— 普通有主陆地照旧走下面那条**层级链** ✓（那是侧栏的本职 ✓）*/
  const special = state.hover.tids[viewTierFor(pid)];
  const _fineTid0 = state.hover.tids[TIER_COUNT - 1];
  const _fineKey0 = _fineTid0 != null ? String(state.titles.keys[_fineTid0] || '') : '';
  const _isWasteTile = isWastelandTile(pid, _fineTid0);
  const _isImpass = keyStarts(_fineKey0, '#impassable');
  /* 🔴 **"背景地块"的判据不能只看"键以 `#` 开头"** ✗✗（2026-10-16 修 ✓）
   *   伪头衔那套前缀（`#sea_*` / `#lake_*` ✓）是**别的游戏**的写法 ✓
   *   **EU5 的水键没有 `#`**（`siberian_lakes_1` / `chukchi_sea` ✓）
   *   → 只认前缀的话，EU5 的湖会**掉进层级链**里 ✗（用户口径是"湖泊：照旧"✓）
   *   补两条与键无关的判据：`isWaterPid`（那枚小标签 ✓）和 `kindOfPid`（身份标 ✓）
   *   两者任一说是水 / 不可通行，就当背景地块 ✓ */
  const _kind0 = kindOfPid(pid);
  const _isWaterTile = isWaterPid(pid) || (_kind0 >= 2 && _kind0 <= 5);
  if ((isSpecialTid(special) || _isWasteTile || _isImpass || _isWaterTile)
      && !sidebarUsesChain(pid, special)) {
    const lines = hoverTileLines(pid);
    const a = lines.a || '—';
    /* 🔴 **第二行 = 这一格"是什么"** ✗✗（2026-10-16 用户第二次拍 ✓）
     *
     *   用户原话："左侧栏的那个方块的**第二行**，那边**遇到非陆地 且 非EU4/EU5 的海域**时
     *     都显示**海洋啊不可通行荒地啊这样的称呼**"✓
     *
     *   读法（把两个"非"拆开 ✓）：
     *     · **陆地** → 不给称呼 ✗（那是层级链那边的事 ✓ 走不到这个分支 ✓）
     *     · **EU4 / EU5 的海域** → 不给称呼 ✗（它第二行是**最低单位名** ✓
     *       由 `hoverTileLines` 给出 ✓ 正是 `lines.b` ✓ 别抢它的位置 ✓）
     *     · 其余一切水 / 荒地（河 / 湖 / 海 / 不可通行 ✓ **含 EU4/EU5 的湖** ✓）
     *       → 第二行写类别名：海洋 / 湖泊 / 河流 / 不可通行海域 / 不可通行区域 ✓
     *
     *   ⚠ 这一条**只管左侧栏那个方块** ✗ —— 悬停小卡片的第二行还是按 `hoverTileLines`
     *     那套"你之前定为空"的口径 ✓ 两处本来就分开 ✓（见 `positionHoverCard` ✓）
     *   ⚠ 类别名从 `CATEGORY_NAME[kind]` 拿 ✓ 别按名字内容猜 ✗
     *     （判序天然"先不可通行海域再不可通行区域" ✓ 见那张表 ✓）
     *   🔴 **荒地那几块 `kindMask` 给的码不是 6** ✗✗（实测：CK2/EU4/CK3 都是 1 ✓）
     *     —— `wl_*` / `#wasteland_*` 那批是构建期兜底塞进去的，身份标那边还当地 ✓
     *     → 判出"是荒地"就**直接给「不可通行区域」** ✓ 别指望那枚标 ✓
     *     （`#impassable*` 那种真带码 6 的，`CATEGORY_NAME` 那条照样对 ✓）
     *   ⚠ EU4 / EU5 的海**进不来这个分支** ✗ —— 上面那句 `&& !sidebarUsesChain(...)`
     *     已经把它们让给层级链了 ✓（用户："EU4/EU5 的海域：和陆地一样显示其层级"✓
     *      那边第二行是最低单位名 ✓ 本来就符合"不给类别称呼"✓）*/
    const _cat2 = CATEGORY_NAME[_kind0]
      || ((_isWasteTile || _isImpass) ? '不可通行区域' : '');
    const _sub2 = _cat2 || lines.b || '';
    box.innerHTML =
      `<p class="empty"><b style="color:var(--text-dim)">${_escHtml(a)}</b>`
      + (_sub2 ? `<br><b style="color:var(--text)">${_escHtml(_sub2)}</b>` : '')
      + `<br>这类地块在游戏里没有归属，颜色是固定的</p>`;
    return;
  }

  // 从最上面那一级一路排到最底下
  // **剧本级（年份那几层）不列** ✓ —— 悬停面板从剧本下面那一层开始 ✓
  const _nEraHide = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  for (let tier = _nEraHide; tier < TIER_COUNT; tier++) {
    const tid = state.hover.tids[tier];
    const info = titleInfo(tid);
    const row = document.createElement('div');
    row.className = 'chain-row' + (tier === editTier() ? ' active' : '');
    if (!info) {
      row.innerHTML = `<span class="dot" style="background:#2a323d"></span>
        <span class="tier">${TIER_BADGE[tier]}</span>
        <span class="name" style="color:var(--text-faint)">（无</span>`;
    } else if (tier === 4 && isDegradedBaron(pid)) {
      // 这地块本来就没有男爵领，地图上是拿伯爵领的色块顶的
      row.innerHTML =
        `<span class="dot" style="background:${rgbToHex(state.titles.colors[tid])}"></span>
         <span class="tier">${TIER_BADGE[tier]}</span>
         <span class="name" style="color:var(--text-faint)">（无男爵领，显示的是伯爵领色块）</span>`;
    } else {
      const col = state.titles.colors[tid];
      const changed = isChanged(tid) ? ' ' : '';
      /* 🔴🔴 **链条行也不许出现编号** ✗✗（2026-10-15 ✓ 用户口径 ✓）
       *   原来这里给荒地**故意挂了个 `#<省份号>`** ✗（注释写的是"便于指认哪块"✓）——
       *   用户明确不许："第二行不许有编号" ✓ → **撤掉** ✓
       *   另一头：HOI4 pr 层水域的 `info.name` **本身就是占位号**（构建期取的 `#2581` ✗）
       *     → 占位名一律换成**类别名** ✓（`kindOfPid` ✓ = 按 kind 判 ✓
       *       先判不可通行海域再判不可通行区域是 CATEGORY_NAME 表的天然顺序 ✓）
       *   ⚠ 真名照旧原样 ✓（陆地地名 / 中文水名一字不动 ✓）*/
      let _rowName = String(info.name || '');
      if (isPlaceholderName(_rowName)) {
        /* ① 先取真名 ✓（CK2 的 259 条水名 / 20 条荒地名就在这张表里 ✓）
         * ② 真名也没有 → 才退类别名 ✓（先判不可通行海域 ✗ 见 CATEGORY_NAME ✓）
         * ③ 任何一行都不许出现 `#<数字>` ✗（下面 `impassLabel` 也不会造编号 ✓）*/
        _rowName = realNameFromTables(pid) || CATEGORY_NAME[kindOfPid(pid)] || TIER_BADGE[tier] || '';
      }
      row.innerHTML =
        `<span class="dot" style="background:${rgbToHex(col)}"></span>
         <span class="tier">${TIER_BADGE[tier]}</span>
         <span class="name">${impassLabel(_rowName)}${changed}</span>
         <span class="pick">取色</span>`;
      row.onclick = () => {
        gotoLevel(tier);
        setBrush(col, true, true);        // 取色 → 顺手切到画图工具 ✓
        // **取色不改标记** ✓（用户要求：别把这块地的名字写到「标记」那边 ✗）
      };
    }
    box.appendChild(row);
  }
}

/**
 * 「不可通行××」一律显示成「**不可通行区域**」✓
 *   各套数据叫法五花八门：不可通行山地（Miller 那套 673 处）· 不可通行荒地（EU4）…
 *   与其到处改数据，不如**显示的时候归一** ✓（用户要求：跟设置页那个叫法一致 ✓）
 *   海域那类例外：CK3 的「不可通行海域」是有意义的类型名，保留 ✓
 *   —— 只在**显示**处用 ✓，别拿去改身份串（那会动到涂色分族 ✗）
 */
function impassLabel(nm) {
  const s = String(nm == null ? '' : nm);
  if (!s || s.indexOf('不可通行') < 0) return s;
  return s.indexOf('海域') >= 0 ? s : '不可通行区域';
}

/** 背景地块（海 / 湖 / 河 / 不可通行）在悬停时的显示名 ✓
 *   **卡片和侧栏共用同一个** —— 以前 EU5 的不可通行在这边是"直接隐藏"✗，
 *   别的游戏却能显示「不可通行区域」→ 就是区别对待 ✗ 现在统一 ✓
 *
 *   **有真名就显示真名** ✓（照 EU5 原版的做法 ✓）：
 *   原尺寸那份数据把某些地块挂到了荒地节点上，于是被当成"不可通行"✗
 *   —— 可它本身是有名字的（比如「俄罗斯针叶林」✓）
 *   原版显示什么，这儿就显示什么 ✓ 不再自作主张换成「不可通行区域」✗
 *   只有**真的没有名字**时，才退回类型名 ✓
 *   ⚠ **水域的真名也走这儿** ✓（2026-10-14：原来是塞在卡片**第二行**的 ✗
 *     用户要求"跟地块一样" → 挪到第一行 ✓ 见 waterSpecificName ✓）
 */
function specialTileLabel() {
  const pid = state.hover.pid;
  const fine = state.hover.tids[TIER_COUNT - 1];
  const key = fine != null ? String(state.titles.keys[fine] || '') : '';
  const dn = String(state.titles.names[state.hover.tids[viewTierFor(pid)]] || '');
  /* 🔴🔴 **水的类别问 `waterKindByPid`** ✗✗（2026-10-17 收口 ✓）
   *   原话（用户）："既然是如何判别水，那不是还有现成的东西嘛"✓ —— 就是它 ✓
   *
   *   以前这儿是拿**键前缀**挨个判（`#sea` / `#lake` / `#river` / `#impassable` ✓）：
   *     · `#sea` 那三句在 **EU5 上永远不成立** ✗ —— EU5 的水键不带 `#`
   *       （实测：`isWaterKey` 在 EU5 认出水 **0** 块 ✓ 见 `_local/probe_water_predicates.js` ✓）
   *       → 于是 EU5 的水被当陆地走上面那条分支 ✓ 悬停显示的是地块名不是水域名 ✓
   *     · `#impassable` 那一句还把**不可通行陆地**跟**不可通行海域**混在一起 ✓
   *
   *   现在：**有 pid 就按 pid 问** ✓（身份标最权威 → 老包退回 `#` 键，这条链在
   *   `waterKindByPid` 里本来就写好了 ✓ 一处都不用另写 ✓）
   *   `w = 0` 不是水 / 2 海 / 3 湖 / 4 河 / 5 不可通行海域 ✓（6 = 不可通行陆地 ✗ 那是荒地那一侧 ✓）*/
  const w = waterKindByPid(pid);
  const _isWater = w !== 0;
  const _impSea = w === 5;
  // 这一块自己的名字：优先各地块名册，其次最细层那个节点的名字 ✓
  if (!_isWater) {
    const raw = state.provinceNames ? state.provinceNames[pid] : null;
    const fineName = fine != null ? String(state.titles.names[fine] || '') : '';
    const generic = ['湖泊', '海洋', '河流', '不可通行'];
    const cand = (manualWaterName(raw) || raw) || (generic.indexOf(fineName) < 0 ? fineName : '');
    if (readablePlaceName(cand)) return String(cand);
    // 节点自己的名字也认（「俄罗斯针叶林」就在这层 ✓）
    if (readablePlaceName(dn) && !/^不可通行/.test(dn)) return dn;
  }
  /* 荒地 / 不可通行（含 CK3 那种"不可通行海域"那种叫法 ✓）——
   * ⚠ 判据仍是"键前缀 + 荒地名册"✗ 那是**荒地**那一侧的事 ✓ 这一轮只收水的口 ✓ */
  if (keyStarts(key, '#impassable') || isWastelandTid(fine)) {
    if (_impSea) return '不可通行海域';                 // 身份标 5 = CK3 那种海域 ✓
    return impassLabel(dn.indexOf('海域') >= 0 || key.indexOf('sea') >= 0 ? (dn || '不可通行海域') : '不可通行区域');
  }
  /* 水：类别名从 `waterKindByPid` 来 ✓（不再看键 ✓）*/
  if (w === 2) return waterSpecificName(pid, state.hover.tids[viewTierFor(pid)]) || '海洋';
  if (w === 3) return waterSpecificName(pid, state.hover.tids[viewTierFor(pid)]) || '湖泊';
  if (w === 4) return waterSpecificName(pid, state.hover.tids[viewTierFor(pid)]) || '河流';
  return impassLabel(dn);
}

/** **这一层的水名表** ✓（那一层没名字就是**没有** ✗ 不许拿别层充数 —— 2026-10-14 ✓）
 *
 *  🔴 用户点破的口径（原话）："每个水域不同的层级按游戏内容给名字，反正是
 *    **遵循陆地那样的思路**，只不过 Hoi4 的省份级水域和地区级是同一个东西，
 *    而且**没有名字**而已" ✓
 *  → 于是这张表只有两种拿法：
 *    · `seaNamesByTier` **在**（这份数据本来就**按层**给表 ✓）→ 就用 `bt[tier]` ✓
 *      **那一层是 null = 这一层没名字** ✓ 返回 null ✓ **别退回 `meta.seaNames`** ✗
 *      （`meta.seaNames` 是**最粗那层**的口径 ✓ 拿它填细层 = 拿别层的名字充数 ✗
 *       正是用户点破的"拿战略区名去填" ✓）
 *    · 表**压根没有** / 比层数还短（老包、VIC3 那种只有一张 `seaNames` ✓）→ 退回它 ✓
 *      （那是"没有分层"，不是"这一层没名字" ✗ 两回事 ✓）
 */
function waterNameTable(bt, tier) {
  const meta = state.meta || {};
  const nT = (meta.tiers && meta.tiers.length) || 0;
  if (Array.isArray(bt) && nT > 0 && bt.length >= nT) return bt[tier] || null;
  return meta.seaNames || null;
}

/** **水域那一格的真名** ✓（悬停卡片**第一行**用 —— 2026-10-14 ✓）
 *
 *  用户 2026-10-14 的要求："**水域和其他地块一样**，仅仅是不能填色"✓ ——
 *  普通地块的卡片就是**一行**：这块地叫什么 ✓
 *  水域原来把真名塞在**第二行** ✗（第一行固定是"海洋"那种类名 ✓）——
 *  第二行一去（见 specificPlaceName ✓）那个名字就**没地方显示了** ✗
 *  → 挪到第一行 ✓ 跟陆地**同一个位置** ✓ 这才叫"一样" ✓
 *
 *  两条来源（跟高亮 / 跟标签**同一个来源** ✓ 都看 `editTier()` ✓）：
 *   ① **每层一片的包** → **当前层那个片自己的名字** ✓（`#sea_pr_57` ✓
 *      见 isTierPieceKey ✗）—— 它在那一层没名字就是没名字 ✓
 *      拿**别的层**的名字来填是错的 ✗（用户点破过：HOI4 的省份级水域
 *      本来就没有名字 ✓ 那儿就该空着、退回笼统名 ✓）
 *   ② **老包**（整个世界的海共用一个 `#sea` ✗ 不是片 ✓）→ 构建期那张真名表
 *      （见 waterNameTable ✓ 那一层是 null 就是"这层没名字" ✓ 不退 ✓）
 *  ⚠ 取到**类名**（"海洋"/"湖泊" ✓）或空 → 返回空串 ✓ 调用方退回笼统名 ✓
 *    （CK3 的海就是这样 ✓ 它本来就没名字 ✓）
 */
function waterSpecificName(pid, tid) {
  if (!pid) return '';
  const T = state.titles || {};
  const key = (tid != null) ? String((T.keys && T.keys[tid]) || '') : '';
  /* ① **每层一片的那片**：片名就是这一格的真名 ✓（跟标签、跟高亮同一个来源 ✓）*/
  if (isTierPieceKey(key)) {
    const nm = String((T.names && T.names[tid]) || '');
    return (nm && !isPseudoCategoryName(nm)) ? nm : '';
  }
  /* ② **老包**：真名表（键是**地块 id** ✓ JSON 会变成字符串 ✓ 两种都试 ✓）
   *   ⚠ 看的是**动手那一层**（`editTier` ✓）不是视图层 —— 跟高亮 / 跟标签
   *     同一个来源 ✓（剧本层下没开粒度时 editTier 就是最低层 ✓
   *     拿视图层的表 = 名字跟高亮的那一片对不上 ✗）*/
  const meta = state.meta || {};
  const bt = meta.seaNamesByTier;
  const tbl = waterNameTable(bt, labelTier() | 0);
  if (!tbl) return '';
  const v = (tbl[pid] != null) ? tbl[pid]
          : (tbl[String(pid)] != null ? tbl[String(pid)] : null);
  return v ? String(v) : '';
}

/** **这块地的"具体名字"** —— 只剩**荒地名** ✓（水域名 2026-10-14 移走了 ✓）
 *
 *  🔴 **水域不再有第二行了** ✗（2026-10-14 用户要求："水域和其他地块一样，
 *    仅仅是不能填色"✓）—— 普通地块的悬停卡片就是**一行**：这块地叫什么 ✓
 *    水域原来把"丹麦海峡 / 波罗的海"那种真名塞在**第二行** ✗（第一行固定是
 *    "海洋"那种类名 ✓）—— 那正是**区别对待** ✗ 现在真名回第一行 ✓
 *    （见 `specialTileLabel` / `waterSpecificName` ✓ 按"当前层那个 tid"取 ✓）
 *
 *  **荒地**这条**保留** ✓（用户点名要过："EU4 和 EU5 的荒地有自己的名字，
 *    你怎么还是隐藏了"✓）—— 荒地的第一行常常是"不可通行区域 / 不可通行荒地"
 *    那种类名 ✓，真名（热那亚 / 波尔多 ✓）就得靠第二行 ✓
 *    来源：构建期把每个荒地块的真名收在 `meta.wastelandNames` 里
 *    （EU4 87 / VN 329 / EU5 1971 条 ✓ 见 docs/水域名调研.md ✓）
 *  返回空串 = "没有额外的具体名" ✓
 */
function specificPlaceName(pid) {
  if (!pid) return '';
  const meta = state.meta || {};
  const T = state.titles;
  const _tier = labelTier();
  /* ① **每层一片的荒地片：这片自己的名字就是具体名** ✓（2026-10-13 架构统一 ✓）
   *
   *   "片" = **该层同名地块的集合** ✓（见 build_tier_pieces.tier_pieces ✓）
   *   片名天然就是**这一层**的名字 ✓ —— 跟地图上标的、跟悬停高亮的那一整片
   *   **同一个来源** ✓ 再也不会对不上 ✓
   *
   *   ⚠ 只认"每层一片"的那种键（`#wasteland_rg_0` ✓ 见 isTierPieceKey ✗）
   *     `wl_<地块号>`（荒地最细层逐块）**不算** ✗ —— 它的节点名在 CK3 那边
   *     只是类名"不可通行山地"，拿它当具体名会**凭空多出第二行** ✓（用户去掉过 ✓）
   *     → 那批走下面的真名表 ✓（EU4/VN 那边真名表本来就有同一份名字 ✓ 结果一样 ✓）
   *   ⚠ **水域片不走这儿** ✗（`#sea_*` / `#lake_*` ✓）见上面那段：水域没有第二行 ✓ */
  const _tid = titleAt(pid, _tier);
  const _key = (T && _tid != null) ? String(T.keys[_tid] || '') : '';
  if (isTierPieceKey(_key) && !isWaterKey(_key)) {
    const nm = (T && T.names && T.names[_tid]) || '';
    /* ⚠ **片名是类名（"不可通行山地"/"无归属荒地"）的不算具体名** ✗ ——
     *   那说明这一片在**这一层**根本没名字 ✓
     *   拿它充第二行就是"跟第一行说同一个词" ✓ 用户明确要求过去掉 ✓ */
    if (!nm || isPseudoCategoryName(nm)) return '';
    return String(nm);
  }
  /* ② **荒地名**（2026-10-13 用户要求："EU4 和 EU5 的荒地有自己的名字，
   *   你怎么还是隐藏了"✓）
   *   构建期把每个荒地块的**真名**收在 `meta.wastelandNames` 里
   *   （EU4 87 / VN 329 / EU5 1971 条 ✓ 出处是本地化的 `PROV<id>`，
   *    跟海名同一套读法 ✓ 见 docs/水域名调研.md）
   *   ⚠ 它比"节点名字"准 ✗ —— 节点名可能是 `Unused19` 这种占位垃圾 ✓
   *     所以**先查它**，查不到才退到节点自己的名字 ✓ */
  const _wl = meta.wastelandNames;
  if (_wl) {
    const v = (_wl[pid] != null) ? _wl[pid]
            : (_wl[String(pid)] != null ? _wl[String(pid)] : null);
    if (v) return String(v);
  }
  // ③ **退路：去掉** ✗（2026-10-13 用户报："CK3 的荒地悬停时会显示'不可通行山地'，
  //    去掉第二行" ✓）
  //   这里原来退到"最细层节点自己的名字" ✗ —— 而那是**类名**（"不可通行山地"
  //   "海洋""湖泊"那种 ✓）**第一行已经在显示了** ✓ 第二行再写一遍纯属重复 ✓
  //   第二行存在的意义是"**这一格具体叫什么**"（波罗的海 / 热那亚 ✓）——
  //   只有构建期那两张真名表（`seaNames` / `wastelandNames` ✓）配得上 ✓
  //   查不到就**老老实实不显示** ✓ 别拿类名充数 ✓
  return '';
}

/** **悬停卡片第二行**（"这一格具体叫什么"）—— 真名 → 类别名 → 空 ✓
 *
 *  🔴 2026-10-16：**占位号一律不许上屏** ✗✗
 *    用户看到的（A 线 dump 的原始 HTML，pid=281 悬停）：
 *
 *        <div class="hc-title">…不可通行区域</div><div class="hc-sub">#281</div>
 *
 *    —— 第一行**是对的** ✅，漏出来的是**第二行** ✗
 *    根因：CK3 的不可通行"片"是**逐块**建的、构建期没有名字表 ✓
 *      片名落在 `tier_pieces` 的 `#<地块号>` 兜底上 ✓
 *      而 `specificPlaceName` 只按"是不是**类名**"过滤（`isPseudoCategoryName` ✓）
 *      → `#281` 既不是类名、也不是空 ✓ 就**原样上了屏** ✗
 *      （同一个坑我在 CK2 那边也踩过 ✓ 见 `build_ck2` 的 11b ✓ 那边是拿真名盖掉的 ✓
 *        通用这一侧得靠这道过滤 ✓）
 *    → 判据统一走 **`isPlaceholderName`**（`#…` / `#u12` / 纯数字 / 空 ✓ 一律不算名字 ✓）
 *      跟 `realNameFromTables` 里那把尺**同一把** ✓ 别各写各的 ✗
 *
 *  ⚠ 2026-10-16 起**实际那两行不再走这里** ✗ —— 悬停卡片自己按
 *    「第一行 = 目前层级 / 第二行 = 最低层级」拼（见 `positionHoverCard` ✓）
 *    这个函数留着当**同口径的第二行**（老调用方 / 探针还能用 ✓）
 */
function hoverSubName(pid) {
  if (!pid) return '';
  const fine = titleAt(pid, TIER_COUNT - 1);
  return realNameAtTier(pid, fine, TIER_COUNT - 1) || categoryNameOf(kindOfPid(pid), '');
}

/** **某一层的这一格叫什么** ✓（悬停那两行都走它）
 *
 *  用户口径（原话）：陆地"**第二行显示鼠标所指处最低层级的相关信息**"✓
 *   → 最细层（CK3 男爵领 / EU4 省份 / HOI4 省份 / VIC3 省份 / EU5 地点）那个节点自己的名字 ✓
 *
 *  🔴 **水域的"地名"归构建期的真名表** ✗✗ —— 逐块节点自己的名字**不是**地名：
 *    EU4 的 `#lake_pr_185` 名是"喀拉海"（细层才有 ✓），更细的逐块节点反而叫 `#1888` ✗；
 *    CK3 的 `#sea_b_2218` 干脆就是 `#8613` ✗ —— 所以先查
 *    `waterNameTable(seaNamesByTier, 最细层)`（**那一层**的表 ✓ 表里是 null = 这一层没名字 ✗
 *    不许拿别层充数 ✓ 见那个函数 ✓），查不到才退回节点自己的名字 ✓
 *  ⚠ 顺序不能反 ✗：先看节点名的话，EU4 的湖会从"喀拉海"掉回 `#1888` ✓ 又把编号放上屏 ✓
 *
 *  过滤走 `nameIsMeaningful`（占位 / 类名 / 机器串一律不算 ✓）
 */
function realNameAtTier(pid, tid, tier) {
  if (!pid || tid == null || tid === NO_TITLE) return '';
  const T = state.titles || {};
  /* 🔴 **"这一格是不是水"问 `waterKindByPid`** ✗✗（2026-10-17 收口 ✓）
   *   原来这儿是 `isWaterKey(键)` ✗ —— 有 pid 在手却去看键 ✓
   *   在 EU5 上那句**恒为假**（EU5 的水键不带 `#`）→ 水名的真名表**根本不查** ✓
   *     直接退回逐块节点名（`#1888` 那种占位号）✓ 正是这段注释上面写的那个坑 ✓ */
  if (waterKindByPid(pid) !== 0) {
    const meta = state.meta || {};
    const tbl = waterNameTable(meta.seaNamesByTier, tier | 0);
    if (tbl) {
      const v = (tbl[pid] != null) ? tbl[pid]
              : (tbl[String(pid)] != null ? tbl[String(pid)] : null);
      if (nameIsMeaningful(v)) return String(v);
    }
  }
  const own = String((T.names && T.names[tid]) || '');
  return nameIsMeaningful(own) ? own : '';
}

/** 四类**类别名**（河 / 湖 / 海 / 不可通行那几样 ✓）——
 *  用户口径："没有名字的就说它是什么" ✓ 两个字那种 ✓ */
const TYPE_LABEL = { 2: '海洋', 3: '湖泊', 4: '河流', 5: '不可通行海域', 6: '不可通行区域' };

/** 🔴🔴 **名字显示方案** ✗✗（用户 2026-10-16 点名 —— 管的是**地图上那个名字** ✓
 *   跟悬停卡片那套是**两件事** ✗ 别混 ✓）
 *
 *  原话：
 *    陆地：照旧
 *    湖泊：EU4/EU5 显示，其他不显示
 *    河流：CK2/CK3 不显示，其他无此设定
 *    海域：CK2/EU4/EU5/VIC3 显示，CK3 不显示，
 *          HOI4 **只有战略区显示**而 state 和 prov 不显示
 *    不可通行区域：CK3 不显示，EU4/EU5 显示，其他无此设定
 *
 *  读法（"无此设定"= 那几作压根没这一类 ✓ 所以不显示 ✓）：
 *    · 湖：EU4 / EU5 ✓ **加上 CK2**（2026-10-16 第二次更变 ✓
 *      用户原话："**CK2 的湖泊和河流其实是有名字的**……CK2 的湖泊和河流应当显示名字"✓
 *      CK2 那份数据里的"湖"是构建期算出来的（四邻全陆地 ✓ 见 `build_ck2.find_enclosed_lakes` ✓）
 *      以前没有这一档 → 湖被并进 `#sea` ✓ 所以那一条本来就是**分类错了**，不是规则 ✓）
 *    · 河：**CK2 显示**（同一句原话 ✓）✓ CK3 不显示 ✓ 别的游戏无此设定 → 当海办 ✓
 *      （"无此设定"= 那几作压根不分河这种类别 ✓ 它们是水，但落到 `kind=2` 那条 ✓
 *       见 `labelZoneOf` ✓）
 *    · 荒地（不可通行）：只有 EU4 / EU5 ✓
 *    · 海：CK2 / EU4 / EU5 / VIC3 ✓
 *
 *  ⚠ HOI4 那半条**不用在这儿特判** ✗ —— "只有战略区显示"是**数据本身**决定的：
 *    那两作的海名只挂在 `#sea_sr_*` / `#lake_sr_*` 上 ✓
 *    state / prov 两层是 `#<地块号>` 占位 ✓ 真名表里也没有 ✓
 *    `drawLabels` 里"占位名不出标"那道闸自动把它挡住了 ✓
 *  ⚠ VIC3 没进过 `#sea_all_*` 那种整类名之外的名字表？不 —— 它三层都有真名 ✓ 照出 ✓
 */
const NAME_POLICY = {
  land: { ck3: true, ck2: true, eu4: true, eu5: true, hoi4: true, vic3: true },
  sea: { ck3: false, ck2: true, eu4: true, eu5: true, hoi4: true, vic3: true },
  lake: { ck3: false, ck2: true, eu4: true, eu5: true, hoi4: false, vic3: false },
  river: { ck3: false, ck2: true, eu4: false, eu5: false, hoi4: false, vic3: false },
  waste: { ck3: false, ck2: false, eu4: true, eu5: true, hoi4: false, vic3: false },
};

/** 这一个**标签节点**属于哪一类（跟 `waterKindOf` 同一口径 ✓ 只是不看 hover ✓）
 *
 *  ⚠ 判据必须**按键名 + 地图规模**来 ✗ —— 标签这条路上没有 `state.hover` ✓
 *    （`waterKindOf` 读的是悬停那几个 tid ✓ 这儿拿不到 ✓）
 *  ⚠ CK3 的 `#impassable_sea` 算**荒地**那条 ✓（用户："不可通行区域"✓ 它是屏障不是海 ✓）
 */
function labelZoneOf(key, tid) {
  const k = String(key == null ? '' : key);
  /* ⚠ **EU5 的荒地键上看不出来** ✗（`arctic_archipelago` 那种真头衔名 ✓）
   *   → 先拿 `meta.wasteland` 那张名单查一下 tid ✓（跟别处 `isWastelandTid` 同一份 ✓）*/
  if (tid != null && tid >= 0 && isWastelandTid(tid)) return 'waste';
  if (keyStarts(k, '#impassable') || keyStarts(k, 'wl_') || keyStarts(k, '#wasteland')) return 'waste';
  if (keyStarts(k, '#river')) return 'river';
  if (keyStarts(k, '#lake') || k.indexOf('_lake') >= 0) return 'lake';
  if (keyStarts(k, '#sea') || k.indexOf('_sea') >= 0) return 'sea';
  return 'land';
}

/** 这类名字在这个游戏里**要不要显示**（`NAME_POLICY` 那张表的取用口 ✓）
 *  ⚠ 别在别处再写一遍 game 判断 ✗ —— 要改就改那张表 ✓ */
function nameShown(kind) {
  const row = NAME_POLICY[kind] || NAME_POLICY.land;
  const g = String((state.meta && state.meta.game) || '');
  return row[g] !== false;
}

/** **这一格是不是荒地**（水 / 山那种"没归属的屏障地" ✓ 跟真正的陆地分开）
 *
 *  四个来源，一个都不能漏 ✗：
 *    · `meta.wasteland` 那张名单（**EU5 的荒地序号混在真头衔里** ✓ 只能靠它 ✓
 *      VIC3 的也在这张名单里 —— 但 VIC3 那条按用户规格**不当荒地办** ✗ 见调用处 ✓）
 *    · 最细层那个 `wl_<地块号>`（EU4 / CK2 / EU5 的逐块荒地 ✓）
 *    · 每层一片的 `#wasteland_*` / `#impassable_*` 片 ✓
 *    · 类别码 6（不可通行 ✓）
 */
function isWastelandTile(pid, fineTid) {
  const T = state.titles || {};
  /* 🔴 **先按地块号自己查** ✗✗（2026-10-16 修 ✓）——
   *   原来只扫 `state.hover.tids` ✗（那是**悬停那一刻**的链条 ✓）：
   *   没悬停 / 悬停在别处时，链条是空的或别人的 ✓ → 荒地判不出来 ✓
   *   而我拿它当"能不能涂"的判据（`isPaintable` ✓）→ **逐块荒地被误锁** ✗
   *   （实测 CK2 / EU4 / CK3 的 `wl_*` 全被锁了 ✓ 正是这个原因 ✓）
   *   → 现在**按 pid 取最细层那个节点**就够了 ✓ 跟悬停状态无关 ✓
   *   （悬停那条链照旧扫 ✓ 它多兜一层"粗层的片"✓ 留着 ✓）*/
  const _own = (fineTid != null) ? fineTid : titleAt(pid, TIER_COUNT - 1);
  const _ownKey = (_own != null && _own >= 0) ? String((T.keys && T.keys[_own]) || '') : '';
  if (keyStarts(_ownKey, 'wl_') || keyStarts(_ownKey, '#wasteland')
      || keyStarts(_ownKey, '#impassable')) return true;
  const chain = (state.hover && state.hover.tids) || [];
  for (const t of chain) {
    const k = (t == null || t < 0) ? '' : String((T.keys && T.keys[t]) || '');
    if (keyStarts(k, 'wl_') || keyStarts(k, '#wasteland') || keyStarts(k, '#impassable')) return true;
  }
  if (_own != null && isWastelandTid(_own)) return true;
  return kindOfPid(pid) === 6;
}

/** 这一格是**哪一类水**（湖 / 河 / 海 ✓ 判不出来回 2 ✓）
 *
 *  ⚠ **不能只看最细层那把键** ✗（那正是 2026-10-16 踩过的坑 ✓）：
 *    CK3 最细层是 `#sea_b_2218`、EU5 是 `chukchi_sea`（连 # 都没有 ✓）
 *    → 得**从最细层往粗层找**，认得出"河 / 湖"就停 ✓
 *  ⚠ 顺序：**先河后湖** ✗（CK2 那条"奥涅加湖"就在 `#river_*` 里 ✓ 按游戏的口径算河 ✓）
 *  ⚠ EU5 是 `_lake` / `lake` **后缀**（`siberian_lakes_1` / `..._region_lake` ✓）
 *    别拿 `#lake` 那个前缀去套它 ✓
 */
function waterKindOf(pid) {
  const T = state.titles || {};
  const k0 = String((T.keys && T.keys[state.hover.tids[state.hover.tids.length - 1]]) || '');
  if (kindOfPid(pid) === 4 || k0.indexOf('#river') === 0) return 4;
  for (let t = state.hover.tids.length - 1; t >= 0; t--) {
    const tid = state.hover.tids[t];
    if (tid == null || tid < 0) continue;
    const k = String((T.keys && T.keys[tid]) || '');
    if (k.indexOf('#river') === 0) return 4;
    if (k.indexOf('#lake') === 0 || k.indexOf('_lake') >= 0) return 3;
  }
  return 2;
}

/** HOI4 的水：名字挂在**战略区**那一层（`#sea_sr_65` ✓ 州 / 省份那两层是占位号 ✗）
 *  用户口径："HOI4：悬停时显示其**所属的战略区**的名称，第二行无"✓ */
function hoi4WaterName(pid) {
  const T = state.titles || {};
  for (let t = 0; t < state.hover.tids.length; t++) {
    const tid = state.hover.tids[t];
    if (tid == null || tid < 0) continue;
    if (!/_sr_/.test(String((T.keys && T.keys[tid]) || ''))) continue;
    const nm = realNameAtTier(pid, tid, t);
    if (nm) return nm;
  }
  return '';
}

/** 把某一格的**逐层链条**查出来（`{ tid, key }[]` ✓）
 *  ⚠ 按需现查 ✗ —— **别依赖 `state.hover.tids`** ✓（那个只在"鼠标停在它上面"时才是这一格 ✓
 *   而右键取色的下半场、导出、重算标签都可能在别的时机调进来 ✓）*/
function chainOfPid(pid) {
  const T = state.titles || {};
  const hov = (state.hover && state.hover.pid === pid && Array.isArray(state.hover.tids))
    ? state.hover.tids : null;
  const out = [];
  for (let t = 0; t < TIER_COUNT; t++) {
    const tid = hov ? hov[t] : titleAt(pid, t);
    out.push({
      tid: (tid == null) ? NO_TITLE : tid,
      key: (tid == null || tid < 0) ? '' : String((T.keys && T.keys[tid]) || ''),
    });
  }
  return out;
}

/** 这一格是**哪一类水**（2 海 · 3 湖 · 4 河 · 5 不可通行海域 ✓ 不看悬停状态 ✓）
 *
 *  🔴 为什么不能只看最细层那把键 ✗（2026-10-16 踩过 ✓）：
 *    · CK3 最细层是 `#sea_b_2218`（认得出海 ✓）、荒地是 `wl_1464`（不是水 ✓）
 *    · **HOI4 的键一个 `#` 都没有** ✗ —— 靠**身份标**（`kindMask` ✓ 码 2/3 ✓）才分得出 ✓
 *  ⚠ 判序：**先身份标（码 2~5 最权威）→ 再 `#` 开头的键** ✓
 *
 *  🔴🔴 **绝对不许拿"键名里含某个词"去认水** ✗✗（2026-10-16 当场炸过 ✓）
 *    我第一版写了 `/_sea_/` 这类宽松匹配 → 挪威那块陆地 `d_duortno**sea**tnu`
 *    里带 `sea` ✓ 被认成海 ✓ 于是"右键取陆地"给出了「海洋」✗（用户一眼就会看到 ✓）
 *    → 现在**只认 `#` 开头的那几把键**（编辑器自己造的伪头衔才长这样 ✓
 *      `#sea_*` / `#lake_*` / `#river_*` / `#impassable_sea_*` ✓）
 *    真人头衔的键（`d_*` / `c_*` / `b_*` / `k_*` / `e_*` ✓）**一个都不会带 `#`** ✓
 *  ⚠ 老包（没身份标）真遇到水又认不出来时，宁可回 **2**（类别名会显示"海洋"）
 *    也别乱猜 —— 那条路只在"已经是水"的分支里走 ✓ 不会碰到陆地 ✓
 */
function waterKindByPid(pid) {
  if (!pid) return 0;
  const k = kindOfPid(pid);
  if (k >= 2 && k <= 5) return k;
  /* 身份标说不出话来（老包 / 每层一片）→ **只认 `#` 开头那几把键** ✓ */
  const chain = chainOfPid(pid);
  for (let t = chain.length - 1; t >= 0; t--) {
    const key = chain[t].key;
    if (!key || key.charCodeAt(0) !== 35) continue;        // 不是 `#` 开头 → 不是伪头衔 ✓ 跳过 ✓
    const m = /^#(impassable_sea|sea|lake|river)(_|$)/.exec(key);
    if (!m) continue;
    return m[1] === 'impassable_sea' ? 5 : m[1] === 'sea' ? 2 : m[1] === 'lake' ? 3 : 4;
  }
  return 0;                                                // 认不出来 = 不是水 ✓
}

/** 🔴🔴 **右键取色拿到的"标记名"** ✗✗（用户 2026-10-16 点名的三条 ✓）
 *
 *  原话：
 *    ① "右键取 **CK3 的水域或荒地**时，得到的标记不应该是具体的 `#多少`，而是**不给予标记**"✓
 *    ② "右键取 **EU4/EU5/CK2 之外的湖泊**时，……**不给予标记**"✓
 *    ③ "右键取 **HOI4 的 prov 或 state 水域**时，……应该**给予战略级名称标记**"✓
 *
 *  读法（三句合起来就是一张小表 ✓）：
 *    · **CK3**：水 / 荒地一律**不给标记** ✓（`#10228` 那种占位号一个都不许上笔）
 *    · **HOI4**：水 → **战略区名**（`#sea_sr_65` = 白令海 ✓）拿不到就类别名 ✓
 *    · **湖**：只有 **EU4 / EU5 / CK2** 给名字 ✓ 其余（CK3 / HOI4 / VIC3）**不给标记** ✓
 *    · 其余水（海 / 河 / 不可通行海域）→ 按**真名表 → 类别的名字**
 *      （EU4 的海给"白令海峡"✓ CK2 的海给"冰岛西海岸"✓ 无名 → "海洋"✓）
 *
 *  ⚠ `#<地块号>` / `#u12` / 纯数字**任何情况都不许当标记** ✗
 *    （拿不到人话名就退回类别名「海洋 / 湖泊 / 河流 / 不可通行区域」✓ 再不济就空 ✓）
 *  ⚠ 这一条**只管右键取色那支笔** ✗ —— 地图上的标签点 / 涂色分族走的是原路 ✓
 *    所以只改 `pickTitle` ✓ 不动 `displayedLabel` 的那些调用方 ✓
 *
 * @returns 标记名（`''` = **真的不给标记** ✓）；**不是**水 / 荒地时返回 `null`（调用方走原路 ✓）
 */
function pickMarkerName(pid, tid) {
  if (!pid) return null;
  const g = String((state.meta && state.meta.game) || '');
  const chain = chainOfPid(pid);
  const fineKey = chain.length ? chain[chain.length - 1].key : '';
  const _fineTid = chain.length ? chain[chain.length - 1].tid : NO_TITLE;
  const isWaste = isWastelandTile(pid, _fineTid)
    || keyStarts(fineKey, 'wl_')
    || /^#(wasteland|impassable)(_|$)/.test(fineKey);     // ⚠ 只认 `#` 开头 ✓ 别子串匹配 ✗
  if (isWaste) return g === 'ck3' ? '' : (realNameFromTables(pid) || categoryNameOf(6, ''));

  const wk = waterKindByPid(pid);
  if (!wk) return null;                     // 不是水（陆地）→ 交给原路 ✓
  if (g === 'ck3') return '';               // ① CK3 的水：不给予标记 ✓
  if (g === 'hoi4') {                       // ③ HOI4 的 prov / state 水域 → 战略区名 ✓
    const nm = hoi4WaterName(pid);
    if (nameIsMeaningful(nm)) return String(nm);
    return categoryNameOf(wk, '') || '';
  }
  if (wk === 3 && !(g === 'ck2' || g === 'eu4' || g === 'eu5')) return '';   // ② 那三家之外的湖 ✓
  const real = realNameFromTables(pid);
  if (nameIsMeaningful(real)) return String(real);
  return categoryNameOf(wk, '') || '';
}

/** **悬停那两行的唯一出处** ✓✓（卡片和侧栏都走它 —— 用户 2026-10-16 的规格表）
 *
 *  规格表（原话，一类一类点的名；**2026-10-16 第二轮把 CK2 的水改了** ✓）：
 *    荒地：CK3 → 第一行「不可通行区域」· 第二行无
 *          CK2 / EU4 / EU5 → **以最低单位为单位显示名称** → 第一行其名称 · 第二行无
 *          VIC3 / HOI4 → **无此设定** → 走陆地那条（目前层级 + 最低层级）
 *    河流：**CK2 / CK3 → 第一行「河流」· 第二行无**（第一轮）
 *          🔴 **第二轮更变**："CK2 的湖泊和河流应当显示名字，悬停时同理"✓
 *          → **CK2 的河改成"它的名字"**（跟它的湖一个待遇 ✓）；**CK3 不变**（还是「河流」✓）
 *          其他游戏无此设定 → 走水域
 *    湖泊：**除 EU4 / EU5 外都不显示**（第一轮）
 *          🔴 **第二轮更变**：CK2 的湖也显示名字 ✓ → 现在 = **CK2 名字 · EU4/EU5 名字 ·
 *          CK3/HOI4/VIC3「湖泊」** ✓
 *    水域：CK2 / VIC3 → 最低单位名称 → 第一行其名称 · 第二行无
 *          CK3 → 第一行「海洋」· 第二行无
 *          EU4 / EU5 → **根据层级**显示第一行，第二行给最低单位名称
 *          HOI4 → 第一行**所属战略区**的名称 · 第二行无
 *
 *  返回 `{ a, b, kind }`：a = 第一行，b = 第二行（'' = 不显示 ✓）
 *  ⚠ 占位号（`#281` / `#8613`）**任何一行都不许出现** ✗（走 realNameAtTier 那把尺 ✓）
 *  ⚠ **左侧栏**那边另有一步：EU4 / EU5 的海要走**层级链** ✓ 见 `sidebarUsesChain` ✓
 */
function hoverTileLines(pid) {
  const none = { a: '', b: '', kind: '' };
  if (!pid) return none;
  const T = state.titles || {};
  const meta = state.meta || {};
  const _g = String(meta.game || '');
  const fineTid = state.hover.tids[TIER_COUNT - 1];

  /* ---- 先判类别，再决定"目前层级"是哪一层 ---- */
  const isWaste = isWastelandTile(pid, fineTid);
  const isWater = !isWaste
    && (isWaterHere(pid, fineTid) || kindOfPid(pid) >= 2);
  /* 水 / 荒地 → **剧本 / 粒度**那一层（用户："根据层级"✓ —— 就直接看 `state.tier` ✓）
   * 陆地       → `viewTierFor` ✓（有主按视图层 / 无主按最低层 ✓）
   * ⚠ 别拿一个 tier 通吃 ✗ —— 用户 2026-10-16 实测点破：
   *   水的 `viewTierFor` 会把剧本层**拉到最低层** → "根据层级"那条直接失效 ✓
   * ⚠ 也别用 `editTier()` ✗ —— 它把**粒度**优先了（粒度=省份时水就不跟层级了 ✓）
   *   而用户要的是"跟**层级**"（实验：逐层扫第一行，得一层一个名字 ✓）*/
  let t = (isWaste || isWater) ? (state.tier | 0) : (viewTierFor(pid) | 0);
  if (t < 0 || t >= TIER_COUNT) t = TIER_COUNT - 1;

  const curName = realNameAtTier(pid, state.hover.tids[t], t) || '';
  const fineName = realNameAtTier(pid, fineTid, TIER_COUNT - 1) || '';
  const typeLabel = (k) => TYPE_LABEL[k] || '陆地';
  /* 类别名（河 / 湖 / 海 / 不可通行那几样 ✓）：
   * ⚠ 水 / 荒地的 kind 得**按它们那条口径**再定一次 ✗ —— `kindOfPid` 是"底层身份标"，
   *   而"每层一片"之后最细层的键可能是 `wl_<地块号>`（荒地 ✓）或 `#sea_b_*`（海 ✓）；
   *   老包没那枚标时它认不出来 ✓ 所以先按最细层的键补一刀 ✓（跟 `waterKindOf` 同一套 ✓）
   * ⚠ **不可通行海域（码 5）和不可通行区域（码 6）是两回事** ✗✗
   *   `CATEGORY_NAME` 表的天然顺序就是先 5 后 6 ✓ 直接查表最准 ✓ */
  const _fineKey = String((T.keys && T.keys[fineTid]) || '');
  let _kind = kindOfPid(pid);
  if (isWaste || isWater) {
    /* 身份标认不出来（码 1）或本来就没这枚标 → 按类别那条口径定一次 ✓ */
    if (_kind === 1) _kind = isWaste ? (isImpassSeaKey(_fineKey) ? 5 : 6) : waterKindOf(pid);
    /* ⚠ 荒地还得再核一道 ✗ —— 有的包给逐块荒地的码是 1（实测 CK2/EU4/CK3 都是 ✓）
     *   而它明明是不可通行 ✓ 别让它退成"陆地"那种类别名 ✓ */
    if (isWaste && _kind < 5) _kind = isImpassSeaKey(_fineKey) ? 5 : 6;
  }
  const kindLabel = typeLabel(_kind);

  /* ---- ① 荒地 ---- */
  if (isWaste) {
    /* 🔴 **CK3 那块不可通行也按类别给名字** ✗✗（2026-10-16 用户抓到 ✓）
     *   用户原话："为什么**不可通行海域**那边写的是**第一行不可通行区域、第二行不可通行海域**，
     *     判据是什么"✓
     *   —— 判据就是 `CATEGORY_NAME[码]`：**不可通行海域是码 5、不可通行区域是码 6** ✓
     *     两边本来就该是**同一个词** ✓ 我上一版第一行写死了「不可通行区域」✗
     *     → 不可通行海域那一格第一行成了"区域"、第二行成了"海域"，自相矛盾 ✓
     *   现在两边都走 `kindLabel` ✓（CK3 的不可通行海域 = 不可通行海域 ✓
     *   普通荒地 = 不可通行区域 ✓） */
    if (_g === 'ck3') return { a: kindLabel, b: '', kind: 'waste' };
    if (_g === 'ck2' || _g === 'eu4' || _g === 'eu5') {
      /* 以**最低单位**为单位显示名称 ✓ —— 最低单位没名字才往粗层退 ✓
       * （EU5 的"北极群岛"就在最细层那个真头衔上 ✓ 靠 `fineName` 拿 ✓
       *   `curName` 那条备用：万一这一格在最低层没节点 ✓）*/
      return { a: fineName || curName || kindLabel, b: '', kind: 'waste' };
    }
    // VIC3 / HOI4：无此设定 → 掉到下面陆地那条 ✓
  }

  /* ---- ② 水（河 / 湖 / 海）---- */
  if (isWater) {
    const wk = waterKindOf(pid);
    const label = typeLabel(wk);
    if (wk === 4) {                                   // 河
      /* 🔴 **第二轮更变**（2026-10-16）：CK2 的河**显示它的名字** ✓
       *   用户原话："CK2 的湖泊和河流其实是有名字的……应当显示名字，悬停时同理"✓
       *   → CK2 跟它的湖一个待遇（名字）✓ **CK3 不变**（还是「河流」✓ 那条没人动过 ✓）*/
      if (_g === 'ck2') return { a: fineName || curName || label, b: '', kind: 'river' };
      if (_g === 'ck3') return { a: '河流', b: '', kind: 'river' };
    } else if (wk === 3) {                            // 湖
      /* 有名字就出名字（**CK2 这一轮加进来** ✓ EU4 / EU5 本来就有 ✓）；
       * 其余（CK3 / HOI4 / VIC3）照旧只给类别名「湖泊」✓ */
      if (_g === 'ck2' || _g === 'eu4' || _g === 'eu5') {
        return { a: fineName || curName || label, b: '', kind: 'lake' };
      }
      return { a: '湖泊', b: '', kind: 'lake' };
    } else {                                          // 海 / 湾
      if (_g === 'hoi4') return { a: hoi4WaterName(pid) || label, b: '', kind: 'sea' };
      if (_g === 'eu4' || _g === 'eu5') {
        const a = curName || label;
        const b = (fineName && fineName !== a) ? fineName : '';
        return { a, b, kind: 'sea' };
      }
      if (_g === 'ck3') return { a: label, b: '', kind: 'sea' };
      return { a: fineName || curName || label, b: '', kind: 'sea' };   // CK2 / VIC3
    }
  }

  /* ---- ③ 陆地（含 VIC3 / HOI4 的"荒地"）：第一行 = 目前层级，第二行 = 最低层级 ---- */
  const fine = realNameAtTier(pid, fineTid, TIER_COUNT - 1) || '';
  const a = curName || fine || typeLabel(kindOfPid(pid));
  let b = '';
  if (curName) {
    /* 第一行是**目前层级**的名字 → 第二行给**最低层级** ✓ 同词不重复 ✓
     * ⚠ 最细层没名字（HOI4 的 `p_*` / CK3 的某些格子 ✓）→ **就空着** ✗
     *   别往下退到粗层充数 ✓ —— 那会冒出 `韦斯特比格德/丹麦` 这种**反的**
     *   （第一行成了最低单位、第二行成了国家 ✗ 实测踩到 ✓） */
    b = (fine && fine !== a) ? fine : '';
  } else {
    /* 第一行本来就是"最低层级"那个名字（目前层级没名字 ✓）
     * → 第二行只可能在"更细"的方向上补，没有更细的了 ✓ 空着 ✓ */
    b = '';
  }
  return { a, b, kind: 'land' };
}

/** 拼 innerHTML 前把游戏数据里的尖括号引号挡一下（名字是外部数据 ✓ 顺手防一手）*/
function _escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** **左侧栏这一格要不要列层级链** ✓（用户 2026-10-16 的方案）
 *
 *  原话："悬停时左侧栏 —— 荒地、湖泊、河流：照旧；EU4/EU5 之外的海域：照旧；
 *        **EU4/EU5 的海域：和陆地一样显示其层级**"
 *
 *  → 只有 **EU4 / EU5 的海**（`waterKindOf === 2` ✓ 河 / 湖不算 ✓ 它们是"照旧"那条 ✓）
 *    走下面那条**层级链** ✓；其余背景地块走 `hoverTileLines` 那两行 ✓
 *
 *  ⚠ 判据用 `waterKindOf(pid) === 2` ✗ 别直接看 `kindMask` 的码 ✓
 *    —— 老包没有那枚标 ✓ `waterKindOf` 两个来源都兜得住（键前缀 + 身份标 ✓）
 *  ⚠ 不可通行海域（CK3 的 `#impassable_sea`）算**荒地**那条 ✗ 不是海 ✓
 *    （`isWastelandTile` 已经把它归进去了 ✓ 这儿先判它一步 ✓）
 */
function sidebarUsesChain(pid, special) {
  const _g = String((state.meta && state.meta.game) || '');
  if (_g !== 'eu4' && _g !== 'eu5') return false;
  const fineTid = state.hover.tids[TIER_COUNT - 1];
  if (isWastelandTile(pid, fineTid)) return false;
  return waterKindOf(pid) === 2;
}

function positionHoverCard(clientX, clientY) {
  const card = $('hover-card');
  if (!state.hover.inside || !state.hover.pid) { card.hidden = true; return; }
  /* ⚠ 这个函数**没有 pid 参数** ✗ —— 用 `state.hover.pid` ✓
   *   （我批量替换时写成了裸 `pid` → `ReferenceError: pid is not defined` ✓
   *    用户当场抓的 ✓ 整个悬停卡片直接崩 ✓）*/
  const info = titleInfo(state.hover.tids[viewTierFor(state.hover.pid)]);
  const rect = $('stage').getBoundingClientRect();
  // 背景地块（海/湖/河/不可通行）也**照显示** ✓ 不再直接隐藏（用户要求：不要区别对待 ✓）
  const _special = !info || isSpecialTid(info.tid);
  const _fineHoverTid = state.hover.tids[TIER_COUNT - 1];
  /* 荒地的悬停色块也读**自动上色写进 LUT 的那份** ✓（2026-10-17 重做 ✓）
   *   EU5 的 `titles.colors` 是省份位图技术色（1818 块五颜六色），直接取会跟画面不一致 ✗ */
  const col = _special
    ? ((isWastelandTid(_fineHoverTid) && renderer && renderer.lutData)
      ? [renderer.lutData[_fineHoverTid * 4], renderer.lutData[_fineHoverTid * 4 + 1],
         renderer.lutData[_fineHoverTid * 4 + 2]]
      : state.titles.colors[_fineHoverTid])
    : (liveColorOf(state.hover.pid, info.tid) || state.titles.colors[info.tid]);
  /* 🔴 **那两行整个交给 `hoverTileLines`** ✗✗（2026-10-16 用户把规格一类一类点全了 ✓）
   *
   *   以前这儿自己拼了一套（"有名字给名字、水给类别名"那种 ✓）——
   *   用户随后给的是**逐类逐游戏**的表 ✓ 再散着写就对不上了 ✗
   *   → 现在只有**一处**出处：`hoverTileLines`（那张规格表就在它的注释里 ✓）
   *     卡片、侧栏、以后别的地方都走它 ✓
   *
   *   ⚠ 这里只负责**颜色 + 位置** ✗；两层文字一个字都不许在这儿改 ✓
   *   ⚠ 两个坑当年踩过，判据留在 `nameIsMeaningful` / `isWastelandTile` /
   *     `waterKindOf` 里了（编号不许上屏 · 类别要逐层找键 ✓）*/
  const _hpid = state.hover.pid;
  const lines = hoverTileLines(_hpid);
  const nm = lines.a || '—';
  const sub = lines.b || '';
  /* 🔴 **类别判据必须"从最细层往粗层找键"** ✗✗（2026-10-16 踩的坑）
   *   CK3 的数据里**没有 `kindMask`**（那份包是 kindMask 之前烤的 ✓），
   *   于是只能按键名前缀判 —— 可最细层的键是 `wl_<地块号>`（荒地 ✓）
   *   或 `#sea_b_2218`（海 ✓）、**都不是类别前缀** ✗
   *   只判最细层那一把键的话：海判成陆地、荒地也判成陆地 ✓
   *    → 第一行漏出 `#1464` 那种编号 ✓
   *   往粗层找到第一个类别键（`#sea` / `#lake` / `#river` / `#impassable*` ✓）
   *   或 `wl_` 就算数 ✓ —— 这段现在收在 `isWastelandTile` / `waterKindOf` 里 ✓
   *   （老包那条 `kindByKey` 只认最细层 ✓ 那儿补上了"逐层找" ✓）*/
  card.innerHTML =
    `<div class="hc-title"><span class="dot" style="background:${rgbToHex(col || [120, 120, 120])}"></span>${_escHtml(nm)}</div>`
    + (sub ? `<div class="hc-sub">${_escHtml(sub)}</div>` : '');
  card.hidden = false;

  const cw = card.offsetWidth;
  const chh = card.offsetHeight;
  let x = clientX - rect.left + 16;
  let y = clientY - rect.top + 16;
  if (x + cw > rect.width - 6) x = clientX - rect.left - cw - 16;
  if (y + chh > rect.height - 6) y = clientY - rect.top - chh - 16;
  card.style.left = Math.max(4, x) + 'px';
  card.style.top = Math.max(4, y) + 'px';
}

// ================================================================ 工具动作

/** `meta.provColors` → RGBA8 字节（**每块地自己的原色** ✓ 2026-10-14 ✓）
 *
 *  base64 的 `numProvinces × 4` 字节（第 4 个字节 = 这块地有没有登记色 ✓）
 *  ⚠ 没这个字段 / 长度对不上 → **null**（老包、还没接线的游戏 ✓）——
 *    只解进 state 备查 ✓ 前端不再拿它做水域显示特判 ✓ */
function decodeProvColors(meta) {
  const b64 = meta && meta.provColors;
  if (!b64) return null;
  const want = (meta.numProvinces | 0) * 4;
  try {
    const out = b64ToBytes(String(b64));
    if (!want || out.length !== want) {
      console.warn(`provColors 长度对不上：${out.length} ≠ ${want}（当"没有这份数据"处理）`);
      return null;
    }
    return out;
  } catch (e) {
    console.warn('provColors 解不出来（当"没有这份数据"处理）：', e);
    return null;
  }
}

/**
 * **水域标签**（`meta.waterMask` 解出来的 Uint8Array ✓）
 *
 *   base64 的 `numProvinces` 字节（每地块 1 字节：1 = 水 ✓ 0 = 不是 ✓）
 *   ⚠ **现在只解进 `state.waterMask` 备查** ✓（2026-10-14 定案：水域 = 普通地块 ✓）
 *     原来它给着色器当"认水"的小标签（颜色 / 边界特判）✗ 那套都退役了 ✓
 *     前端这边 `isWaterPid` 还会从它查 ✓（认水的判据留着 ✓ 拆的只是特判的用场 ✓）
 *   ⚠ 没这个字段 / 长度对不上 → **null**（老包 ✓）
 */
function decodeWaterMask(meta) {
  const b64 = meta && meta.waterMask;
  if (!b64) return null;
  const want = meta.numProvinces | 0;
  try {
    const out = b64ToBytes(String(b64));
    if (!want || out.length !== want) {
      console.warn(`waterMask 长度对不上：${out.length} ≠ ${want}（当"没有这份数据"处理）`);
      return null;
    }
    return out;
  } catch (e) {
    console.warn('waterMask 解不出来（当"没有这份数据"处理）：', e);
    return null;
  }
}

/**
 * **底层地块身份标**（`meta.kindMask` 解出来的 Uint8Array ✓ 2026-10-15 用户定 ✓）
 *
 *   base64 的 `numProvinces` 字节（每地块 **1 字节** ✓ —— 跟当年 `waterMask` 一个口径 ✓）
 *   码：1 陆地（兜底 ✓）/ 2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域 / 6 不可通行区域 ✓
 *
 *   ⚠ **无归属区域不在里面** ✗✗（用户明确交代：无归属是**剧本 / 归属**决定的，
 *     不是地块身份 ✓ 它继续按运行时算 —— 见设置里那行 `set-unpainted` ✓）
 *   ⚠ 没这个字段 / 长度对不上 → **null**（老包 ✓）
 *     → 类别判据退回**键名前缀**那条老路 ✓ 一个字节都不动 ✓
 */
function decodeKindMask(meta) {
  const b64 = meta && meta.kindMask;
  if (!b64) return null;
  const want = meta.numProvinces | 0;
  try {
    const out = b64ToBytes(String(b64));
    if (!want || out.length !== want) {
      console.warn(`kindMask 长度对不上：${out.length} ≠ ${want}（当"没有这份数据"处理）`);
      return null;
    }
    return out;
  } catch (e) {
    console.warn('kindMask 解不出来（当"没有这份数据"处理）：', e);
    return null;
  }
}

/** 类别码 → 设置里那一行的键 ✓（1 陆地没有颜色行：陆地照旧用**它自己的**颜色 ✓） */
const KIND_SETTING = { 1: null, 2: 'sea', 3: 'lake', 4: 'river', 5: 'isea', 6: 'impass' };

/** 七行的**出厂色** ✓（跟 `index.html` 那七行、跟 `build_data.py` 的类色一字不差 ✓） */
const NATURE_RGB = {
  impass: [94, 94, 94], sea: [32, 57, 92], isea: [26, 46, 71],
  lake: [47, 110, 150], river: [62, 136, 181],
};

/** 某一行的当前颜色（设置里没设过 → 出厂色 ✓） */
function natureColor(key) {
  const c = (state.set || {})[key];
  return c || NATURE_RGB[key] || [150, 150, 150];
}

/** **老包那条路**：按键名前缀认类别 ✓（没有 kindMask 的时候才走 ✓）
 *   ⚠ `#impassable_sea` 必须判在 `#impassable` **前面** ✗（它俩是前缀关系 ✓）*/
function kindByKey(key) {
  const s2 = String(key == null ? '' : key);
  if (s2.indexOf('#impassable_sea') === 0) return 5;
  if (s2.indexOf('#impassable') === 0) return 6;
  if (s2.indexOf('#river') === 0) return 4;
  if (s2.indexOf('#lake') === 0) return 3;
  if (s2.indexOf('#sea') === 0) return 2;
  return 1;                                   // 其余都算陆地 ✓（兜底 ✓ 不许有空洞 ✗）
}

/** `kindMask` → **头衔号 → 类别码**（懒建一次、换图重建 ✓）
 *   ⚠ 同一片水在**不同层是不同节点** ✗ → 每层都登记 ✓（同一个 tid 只记一次 ✓）
 *
 *  🔴🔴 **层数必须读 `meta.tiers.length`，不许读 `TIER_COUNT`** ✗✗（2026-10-17 修 ✓）
 *    这是 `TIER_COUNT` 那个坑的**第四次**了 ✗ ——
 *      `TIER_COUNT` 是模块变量，初值 5（照 CK3 那五级写的 ✓），
 *      要等 boot 靠后那句 `TIER_COUNT = TIER_KEYS.length` 才变成真值 ✓
 *    后果（实测，`_local/_dbg_kindoftid.js` 打出来的）：
 *      · **EU5**（6 层）→ 循环只跑到第 4 层 ✗ **最细的 `loc` 层 5709 个 tid 一个都没登记** ✓
 *      · **CK3**（7 层）→ 只跑到第 4 层 ✗ `c` / `b` 那两层漏 ✓
 *    表现：**最细层的水名被判成陆地** ✗ —— 正是"关掉水名开关还剩一堆水名"那个老症状 ✓
 *    ⚠ `titleAt(p, t)` 自己是按 `state.meta.numProvinces` 索引的 ✓ 它没问题 ✗
 *      **只有这个循环上界**读错了变量 ✓（所以症状是"少了后面几层"，不是"全错位"✓）
 *    ⚠ 「老包没 kindMask」不归这条管 ✗ —— 那种情况 `m` 是空的，
 *      `kindOfTid` 会退回 `kindByKey(键)` ✓ 那条路一直在 ✓ */
function kindTidMap() {
  const _k = ((state.meta && state.meta.numTitles) | 0) + '|'
    + ((state.kindMask && state.kindMask.length) | 0);
  if (state._kindMap && state._kindMapKey === _k) return state._kindMap;
  const m = new Map();
  const km = state.kindMask;
  const n = (state.meta && state.meta.numProvinces) | 0;
  const nT = Math.max(1, ((state.meta && state.meta.tiers && state.meta.tiers.length)
    || TIER_COUNT || 1) | 0);
  if (km) {
    for (let p = 1; p < n; p++) {
      const k = km[p];
      if (!k || k === 1) continue;            // 陆地不登记（兜底 ✓ 颜色不动 ✓）
      for (let t = 0; t < nT; t++) {
        const q = titleAt(p, t);
        if (q != null && q !== NO_TITLE && !m.has(q)) m.set(q, k);
      }
    }
  }
  state._kindMap = m;
  state._kindMapKey = _k;
  return m;
}

/** **类别名表**（身份标码 → 中文类别名 ✓ 2026-10-15 ✓）
 *   ⚠ 顺序天然是**先不可通行海域（5）再不可通行区域（6）** ✗（用户点名的那条 ✓）
 *   ⚠ 1 = 陆地：**没有类别名** ✓（陆地照旧显示自己的头衔名 ✓）*/
const CATEGORY_NAME = { 2: '海洋', 3: '湖泊', 4: '河流', 5: '不可通行海域', 6: '不可通行区域' };

/** 类别码 → 这一类的**名字**（悬停卡片 / 侧栏走同一处 ✓ `label` 那张表跟类别名同源 ✓）
 *   ⚠ `label` 只在 `_dataName` **合格**（不是占位 / 不是空 ✓）时才用 ✓ ——
 *     CK3 的逐块节点名那一列里躺着 `#10228` 这种占位号 ✗，拿它兜底 = 把编号放上屏 ✓ */
function categoryNameOf(kind, label) {
  return CATEGORY_NAME[kind] || (!isPlaceholderName(label) ? String(label || '') : '');
}

/** **这个名字值不值得上屏** ✓（2026-10-16 收口 —— 悬停第一行 / 第二行 / 侧栏共用一把尺）
 *
 *  三条判据（少一条都会漏东西上屏 ✓）：
 *    ① `readablePlaceName` —— 机器串 / 全大写 / 纯小写键名不算人名地名 ✓
 *       （CK3 的 `Siberian Wastes` · HOI4 的 `p_13254` 都栽在这一条上 ✓）
 *    ② `isPlaceholderName` —— `#281` / `#u12` / 纯数字 ✗（用户口径：任何一行都不许出现编号 ✓）
 *    ③ `isPseudoCategoryName` —— "海洋""不可通行山地"那种**类名**不算**这一格的名字** ✓
 *       地形节点（`#sea_all_1066` ✓）的名字就是它 ✓ 拿它当"最低层级的信息"没意义 ✗
 *       要用类别名的地方走 `categoryNameOf` ✓（那儿是另一条路，不受这把尺管 ✓）
 *   ⚠ 不再另外判"有没有中文" ✗ —— CK2 的 259 条水名里混着拉丁字母的，
 *     那种是**真名**（基克拉格斯群岛那种地名），不该被当成机器串扔掉 ✓
 *  ⚠ **别拿它去筛类别名** ✗✗（2026-10-16 踩的坑 ✓）：`categoryNameOf` 的结果
 *    本来就该原样用 ✓ 我上一版让 `nameIsMeaningful` 放行类名、结果
 *    "海洋"那一格的第一行从"海洋"掉成了 `#114514` 那种编号 ✓
 *    （现在这条尺**挡类名**、`categoryNameOf` **给类名**，各管一头 ✓）
 */
function nameIsMeaningful(nm) {
  const s = String(nm == null ? '' : nm).trim();
  if (!s) return false;
  if (isPlaceholderName(s) || isPseudoCategoryName(s)) return false;
  return readablePlaceName(s);
}

/** **占位名**（`#6586` / `#u12` / 纯数字 / 空 ✓）—— 任何一行都不许原样出现 ✗
 *   用户口径（2026-10-15 ✓）："第二行不许有编号" ✓ · "HOI4 st/pr 不许出现 `#3004`" ✓
 *   ⚠ 只判"是不是占位"✓ —— **不判名字内容像不像中文** ✗（那种判据作废 ✓）*/
function isPlaceholderName(nm) {
  const t = String(nm == null ? '' : nm).trim();
  return !t || t.charAt(0) === '#' || /^u?\d+$/i.test(t);
}

/** **从真名表里取这一块的真名** ✓（2026-10-15 ✓ 用户口径 ✓）
 *
 *   `meta.seaNames` / `meta.wastelandNames` / `meta.seaNamesByTier[]` ——
 *   键是**地块号的字符串** ✓（`"936"` 那种 ✓ 两种写法都试一遍 ✓ 别只试一种 ✗）
 *   ⚠ CK2 就是这条救回来的 ✓：数据里 259 条水名 / 20 条荒地名都在 ✓
 *     可 `titles.names` 里那一片只剩 `#936` 占位 ✗ → 不查表就显示占位号 ✗
 *   ⚠ 占位名 / 类名（"海洋"那种泛称 ✓）都不算真名 ✗ */
function realNameFromTables(pid) {
  const M = (state && state.meta) || {};
  const keys = [String(pid)];
  /* ⚠ 有的包里表按 **节点号** 存（`titles.names` 那套 ✓）—— 那种不在这儿管 ✓
   *   这儿只管"地块号 → 名字"的表 ✓（用户点的那两张 ✓）*/
  for (const tb of [M.seaNames, M.wastelandNames, M.waterNames, M.lakeNames, M.riverNames]) {
    if (!tb) continue;
    for (const k of keys) {
      const v = tb[k];
      if (v && !isPlaceholderName(v) && !isPseudoCategoryName(String(v))) return String(v);
    }
  }
  for (const tb of (M.seaNamesByTier || [])) {
    if (!tb) continue;
    for (const k of keys) {
      const v = tb[k];
      if (v && !isPlaceholderName(v) && !isPseudoCategoryName(String(v))) return String(v);
    }
  }
  return '';
}

/** **一个地块属于哪一类**（底层 pid 的身份 ✓ 跟在哪一层 / 有没有归属无关 ✓）
 *   有 `state.kindMask` → 查它（权威 ✓）
 *   老包 → 退到**最细层那个节点的键前缀**（`kindByKey` ✓ 那里
 *     `#impassable_sea` 判在 `#impassable` 之前 ✓ 判序也是对的 ✓）*/
function kindOfPid(pid) {
  if (!pid) return 1;
  if (state.kindMask && pid < state.kindMask.length && state.kindMask[pid]) {
    return state.kindMask[pid];
  }
  const t = state.titles;
  if (!t || !state.meta) return 1;
  const fine = TIER_COUNT - 1;
  const tid = titleAt(pid, fine);
  return (tid != null && tid !== NO_TITLE) ? kindByKey(t.keys[tid]) : 1;
}

/** 🔴 **「每省是不是水」那张表**（给「水域 · 边界」那条通道用 ✓ 2026-10-16 ✓）
 *
 *  用户口径（见 handover §3.1 ✓）：水域边界管的是**水域之间**的缝 ✓
 *  着色器那边是**逐像素**判的 ✗ —— 它拿不到 pid 的键名 / 也读不了 meta ✓
 *  所以 CPU 侧先把 `numProvinces` 走一遍存成 `Uint8Array`，再传成一张纹理 ✓
 *
 *  ⚠ 判据**只用 `waterKindByPid`** ✗（别在这儿另写一套 ✓）：
 *     它本身就是"身份标最权威 → 老包退回 `#` 开头的键"那条完整口径 ✓
 *     （0 = 不是水 / 2 海 / 3 湖 / 4 河 / 5 不可通行海域 ✓）
 *  ⚠ **不缓存** ✓ —— 它只在换图（开一份新 meta）时算一次，
 *     一个 Uint8Array 走 numProvinces 而已（EU5 四万多个也就几毫秒 ✓）
 *     缓存反而会带来"换了图还拿着旧表"的坑 ✗
 *  ⚠ 与 `kindMask` **不是一回事** ✗：那是"最底层是什么"（含陆地 1 / 荒地 6 ✓）
 *     这张是"**认不认得出它是水**"（含老包那条键前缀退路 ✓）
 *     `waterKindByPid` 里头正是先查 kindMask、再退回键 ✓ 两级都对上 ✓
 *
 *  @returns {Uint8Array|null} 长度 = numProvinces（第 0 格不用 ✓ 恒 0）
 *
 *  ⚠ **2026-10-17：不再顺带收「哪些头衔沾水」那张表了** ✗✗（用户点破的 ✓）
 *    原来这里会顺手收一张 `state.waterKindSet`（所有层的 tid 并集 ✓）——
 *    可项目里**本来就有**按 tid 问的那条：`kindOfTid(tid)` ✓
 *    （`kindTidMap()` 扫每一层 + 老包退回键前缀 ✓ 判据比那张 Set 还全 ✓
 *      而且自带缓存 ✓）见 `_isWaterLabel` 那段 ✓
 */
function buildWaterKindMask() {
  const n = (state.meta && state.meta.numProvinces) | 0;
  const T = state.titles;
  if (!n || !T || !T.keys || !T.keys.length) return null;
  const out = new Uint8Array(n);
  let any = 0;
  for (let pid = 1; pid < n; pid++) {
    const k = waterKindByPid(pid);
    if (!k) continue;
    out[pid] = k;
    any++;
  }
  /* 🔴🔴 **2026-10-17：这一趟只出"纹理那张表"了** ✗✗（用户点破的 ✓）
   *   原来这儿**顺手还收一张 `state.waterKindSet`**（所有层的 tid 并集 ✓）——
   *   目的是"标签闸按 tid 问一句：这个头衔沾不沾水" ✓
   *   我甚至为了收全还加了一圈**逐层循环**（`for t < nTier` ✓ 见下头那段历史 ✓）
   *
   *   ⚠ **那个 Set 是白造的** ✗✗ —— 项目里**本来就有** `kindOfTid(tid)` ✓
   *     （`kindTidMap()` 扫每一层 + 老包退回键前缀 ✓ 判据比这个 Set 还全 ✓）
   *   用户原话："既然是如何判别水，那不是还有现成的东西嘛"✓ —— 就是这个 ✓
   *   → Set 连同那圈内层循环**一起删了** ✓ 标签闸改问 `kindOfTid` ✓
   *     （省掉：每块水 × 层数 次 `titleAt` + 一个几千条的 Set 内存 ✓
   *       而且少一处"两份 tid→水 的表可能不一致"的隐患 ✓）
   *   ⚠ `out` 这张纹理表**还得留着** ✗ —— 着色器逐像素判、拿不到 tid ✓
   *     它是 `waterKindArr` 的唯一来源（见 setWaterKindMask ✓）*/
  /* ⚠ **一个水都没有 → 当"这张图算不出水陆"** ✓（跟老包一个待遇 ✓）
   *   于是 `waterIs` 恒 false → 水域通道 + 两条让位一起退化成现状 ✓
   *   （正常地图不可能全陆地，走到这儿基本就是"认水的判据全落空"✓
   *     那种图上再画"水域边界"只会画出假缝 ✗ 宁可让它整条让开 ✓）*/
  if (!any) return null;
  return out;
}

/** **一个头衔属于哪一类** —— 判据就收口在这一处 ✓（用户要求"别散着写" ✓）
 *   有 `state.kindMask` → 查它（权威 ✓ 底层 pid 的身份，切层 / 切剧本都不变 ✓）
 *   老包 → 退回键名前缀（`#sea` / `#lake` / `#river` / `#impassable_sea` / `#impassable` ✓）*/
function kindOfTid(tid) {
  if (tid == null || tid === NO_TITLE || !state.titles) return 1;
  if (state.kindMask) {
    const k = kindTidMap().get(tid);
    if (k) return k;
  }
  return kindByKey(state.titles.keys[tid]);
}

/** **把七行颜色刷进 LUT** ✓（2026-10-15 用户要求 ✓）
 *
 *   走 LUT（`renderer.setLutColor` ✓ 跟 `paintWasteGrey()` 同一手法 ✓）——
 *   所以**改设置立刻生效，不用重烤包** ✓✓（用户点名要求 ✓）
 *   只刷有颜色行的几类（海 / 湖 / 河 / 不可通行海域 / 不可通行 ✓）；
 *   **陆地照旧用它自己的颜色** ✓ —— 用户要的"陆地标记"是指 `kindMask` 里那一码 1 ✓
 *   （身份标 ✓），不是把陆地涂成一个色 ✗
 *   ⚠ 老包（没有 kindMask）→ 按键名前缀扫一遍节点 ✓ 行为跟以前一模一样 ✓ */
function applyNatureColors() {
  if (!renderer || !renderer.setLutColor || !state.titles) return 0;
  const t = state.titles;
  let n = 0;
  if (state.kindMask) {
    for (const [tid, kind] of kindTidMap()) {
      const sk = KIND_SETTING[kind];
      if (!sk) continue;
      const c = natureColor(sk);
      renderer.setLutColor(tid, c[0], c[1], c[2]);
      n++;
    }
  } else {
    for (let i = 0; i < t.keys.length; i++) {
      const sk = KIND_SETTING[kindByKey(t.keys[i])];
      if (!sk) continue;
      const c = natureColor(sk);
      renderer.setLutColor(i, c[0], c[1], c[2]);
      n++;
    }
  }
  if (n) renderer.dirty = true;
  return n;
}

/**
 * 一个地块此刻在屏幕上显示的颜色
 *
 * 手绘层优先，其次才是头衔自己的色 —— 取色要取「你眼睛看到的那个」
 * 而不是头衔理论上该有的那个。两者不一致时（比如你在伯爵领视图涂过色，
 * 现在切到帝国视图看），照头衔取就会取错）
 */
function displayedColor(pid, tid) {
  // 跟着色器**同一个优先级**，取"这块地此刻显示的颜色"。
  // 顺序：手绘层(开关) → 未上色兜底 → 头衔色 / 背景。
  const fine = state.meta.tierNames.length - 1;
  const own = pid ? titleAt(pid, fine) : NO_TITLE;

  /* 🔴 **顺序必须跟着色器的 colorOfPid 逐条对齐** ✗（用户报：涂了色却取不到 ✓）
   *   ⚠ 这个坑在着色器那边**修过一次**？但那次只改了着色器 ✗ 取色这边漏了 ✓
   *   💡 **displayedColor 和 colorOfPid 是同一个函数的两份实现** ✗
   *     改任何一边都必须同时看另一边 ✓
   * ① 手绘层：**最优先** ✓（水片 / 荒地片现在跟普通头衔一样可涂 ✓ 涂了就显示涂色 ✓）*/
  const pd = renderer && renderer.paintData;
  if (state.showPaint && pd && pid && pd[pid * 4 + 3] > 0) {
    return [pd[pid * 4], pd[pid * 4 + 1], pd[pid * 4 + 2]];
  }
  /* ①″ 🔴 **荒地自动色**（2026-10-17 重做 ✓ 跟着色器那段逐字对齐 ✓）
   *   荒地读的是**最细层那个 wl_ 节点**的 LUT（粗层是同名几块共用的 ✗）
   *   ⚠ 必须排在下面 `kindMask` 那条**之前** ✗：
   *     有些图里荒地的底层身份是 6 → 先走身份那条就变成类色了 ✓
   *   ⚠ LUT 的 alpha = 255 才是荒地标记 ✓ 跟 `setWasteFixed` 对齐 ✓ */
  if (pid && isWastelandTid(own) && renderer && renderer.lutData) {
    const l = renderer.lutData;
    return [l[own * 4], l[own * 4 + 1], l[own * 4 + 2]];
  }
  /* ①′ 🔴 **底层身份那条覆盖** ✗✗（2026-10-15 ✓ 跟着色器 `colorOfPid` 里那段逐字对齐 ✓）
   *   用户原话："上不上色看的是**具体的最底层单位属于什么东西**" ✓ ——
   *   水 / 不可通行那几类（kind 2~6 ✓）**不管在哪一层、有没有片、有没有归属**都给类色 ✓
   *   ⚠ **必须跟着色器同步** ✗ —— `displayedColor` 跟 `colorOfPid` 是同一个函数的
   *     两份实现（上面那条血泪注释记着 ✓）；只改一边 = 吸管 / 悬停取色跟画面不一致 ✗
   *   ⚠ `kind == 1`（陆地）→ `KIND_SETTING[1]` 是 null → 往下走老路 ✓ 一个字节不动 ✓
   *   ⚠ 老包没有 `state.kindMask` → 整条让开 ✓ 行为一丝不变 ✓ */
  if (state.kindMask && pid) {
    const _ksk = KIND_SETTING[state.kindMask[pid]];
    if (_ksk) return natureColor(_ksk).slice();
  }
  // ② 没有头衔的地块：固定灰
  if (tid === NO_TITLE || tid == null || !state.titles.colors[tid]) {
    return [150, 150, 150];
  }
  // ④ 头衔色：地形（海/湖/荒地这些，t >= 真实头衔数）**永远看得见**；
  //    真实头衔在「头衔 · 颜色」关着时是透明的 → 露出背景色
  const real = state.meta.numRealTitles || 0;
  if (state.showTitles || tid >= real) {
    const c = state.titles.colors[tid];
    return [c[0], c[1], c[2]];
  }
  const bd = (renderer && renderer.backdrop) || [200 / 255, 200 / 255, 200 / 255];
  return [Math.round(bd[0] * 255), Math.round(bd[1] * 255), Math.round(bd[2] * 255)];
}

/**
 * **分组/身份**用的稳定色：涂过就用涂色，否则用头衔自己的颜色。
 *
 * 为什么不直接用 displayedColor：那个会跟着「头衔·颜色」这些**显示开关**变。
 * 一旦用它拼身份串，关掉国家颜色就会让原版国家统统变成背景灰，和玩家涂的同一块地
 * 分成两组 —— 表现就是"同一个国家名冒出两个" ✗（乌兹别克那次就是这么来的）。
 * 吸管那些要"看到什么取什么"的地方仍旧用 displayedColor ✓
 */
function stableColor(pid, tid) {
  const pd = renderer && renderer.paintData;
  if (pd && pid && pd[pid * 4 + 3] > 0) {
    return [pd[pid * 4], pd[pid * 4 + 1], pd[pid * 4 + 2]];
  }
  if (tid === NO_TITLE || tid == null || !state.titles.colors[tid]) return [150, 150, 150];
  const c = state.titles.colors[tid];
  return [c[0], c[1], c[2]];
}

/** 一个地块此刻显示的标记名（手绘层的标记优先，否则用头衔名） */
function displayedLabel(pid, tid) {
  if (state.provLabel && pid > 0) {
    const lid = state.provLabel[pid];
    if (lid >= 0 && state.labelNames[lid]) return state.labelNames[lid];
  }
  // 改名工具改过的头衔：优先用它 ✓
  if (state.titleName && tid !== NO_TITLE && tid != null && state.titleName.has(tid)) {
    return state.titleName.get(tid);
  }
  return tid === NO_TITLE ? '' : state.titles.names[tid];
}

/**
 * 取色。取的是「这块地此刻显示的颜色」
 *
 * @param {number}  pid            地块，用来查手绘层
 * @param {boolean} switchToPaint  取完是否顺手切到涂色
 */
/* 取色（吸管）：**遵循玩家在屏幕上看到的颜色** ✓（用户定的 ✓）
 *
 * 曾经改成"取纯色"（涂过的取涂的色、没涂的取 LUT 原色 ✗）—— 用户否了 ✓
 * 吸管就该给"眼睛看到的那个" ✓ 屏幕上的颜色掺过地形 / 底图那一层 ✓（见 displayedColor）
 *
 * ⚠ 再**四舍五入成整数 RGB** ✓（用户要求 ✓）：
 *   屏幕上那个色是算出来的，经常带小数（比如 189.7 / 20.4 / 65.2 ✗）
 *   小数带进画笔 → 涂上去跟原色差一丁点 ✗ → 边界判据严格比 RGB → 平白划一条线 ✓
 *   取整之后就干净了 ✓（HEX 那格显示的也是整数值 ✓ 两边一致 ✓）
 */
function pickTitle(tid, switchToPaint = false, pid = 0) {
  // **颜色**：玩家看到什么就吸什么 ✓（`displayedColor` = 屏幕上那个色 ——
  // 「填色·颜色」「头衔·颜色」「荒漠·涂色」这些开关它全都算进去了 ✓）
  const _raw = displayedColor(pid, tid) || [0, 0, 0];
  const _c255 = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  const col = [_c255(_raw[0]), _c255(_raw[1]), _c255(_raw[2])];
  setBrush(col, true, true);        // 取色 → 顺手切到画图工具 ✓

  /* **名字**：直接解析**这一格自己**的信息拿 ✓（不再手拼三处状态 ✗）
   *
   * 原则（用户定的 ✓）：
   *   · **开着剧本** → 涂过色就用**涂色的标记名** ✓、没涂过就用**剧本归属**那个国家的名字 ✓
   *   · **没开剧本**（在省份 / 地区那些层）→ 用**对应级别的名字**（省名、地区名 ✓）
   * `tid` 是 `actAt` 按**视图层**取的（吸管看的永远是眼前这一眼 ✓），
   * 所以上面两条不用自己分情况 —— `displayedLabel` 就是按这个顺序给的 ✓
   *（它顺带把"改名工具改过的头衔"也放在前面 ✓）
   *
   * 🔴 **水 / 荒地那几类另有一套** ✗✗（2026-10-16 用户点名 ✓ 见 `pickMarkerName`）：
   *   · CK3 的水与荒地 → **不给标记** ✗（不拿 `#10228` 那种占位号当标记 ✓）
   *   · 湖：只有 EU4 / EU5 / CK2 给名字，其余**不给标记** ✓
   *   · HOI4 的水 → 给**战略区名**（白令海那种 ✓）
   *   · 其余水 → 真名表 → 类别名（海洋 / 湖泊 / 河流 / 不可通行区域 ✓）
   *   ⚠ 判据收在 `pickMarkerName` 一处 ✗ 别在这儿再写一遍 ✓
   */
  const _mk = pickMarkerName(pid, tid);
  setBrushLabel(String((_mk != null ? _mk : displayedLabel(pid, tid)) || '').trim());

  // 不弹提示 —— 左边画笔卡片实时显示着颜色和标记，那才是反馈
  // 这里原本每次都弹一条，右键连点取色时糊一屏
  if (switchToPaint && state.tool !== 'paint') setTool('paint');
}

/** 右键取色：不管当前是哪个工具，右键点一下就能把这儿的色吸走，并切到涂色 */
/**
 * 给**每一块地**都写上它的"标记编号" ✓（不只涂过的 ✗）
 *
 * 标记 = 名字 ✓（面板里那格）。没涂过的地，标记就是它原版的国名 ✓；
 * 涂过的地，标记就是你填的名 ✓。这样"原版那块"和"你涂出来的那块"
 * 在着色器里就是同一个编号 → 高亮、边界两边口径**同一条** ✓
 * （以前没涂的地编号是 0 ✗ → 跟涂出来的对不上 → 判成两个国家 ✓）
 */
function syncAllPaintLabels() {
  if (!renderer || !state.meta || !state.titles) return;
  const n = state.meta.numProvinces;
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  /* **记录色块的单位 = province ✓ 标记也给每块地都标上** ✓（用户定的 ✓）
   *
   * 标记看哪一层（用户的"最简方案" ✓ 原话）：
   *   · **开了剧本 → 标记就是该剧本的** ✓（除非你换了一个剧本 ✓）
   *   · 没剧本   → 用当前视图那一层 ✓
   * 「该剧本」= 离当前视图最近的那个剧本层 ✓（视图停在细层时不会被粒度带走 ✓）
   *
   * ⚠ 这一行我来回改坏过两次 ✗ 记在这儿别再犯：
   *   ① 改成 `state.tier` ✗（视图停在细层时就不是剧本了 ✓ 你要的是"该剧本" ✓）
   *   ② 改成 `editTier()` ✗（会把粒度掺进来 ✓ 你特意说不要 ✓ 被当场抓 ✓）
   */
  const ct = countryTier();          // 该剧本 = 最近的**有主**剧本层 ✓（空白剧本不算 ✓）
  /* **逐块地取"它自己"的归属** ✓（一个州半边日本半边中国 → 5 块日本 5 块中国 ✓）
   *   绝不能按州整体给一个名字 ✗ 也绝不能取不到就写 0 ✗
   *   （"标记被清空"就是这个 0 ✓ 用户抓到的 ✓）
   *   → 取不到就退到**最底层单位**那一层 ✓ 绝不再出现 0 ✓
   */
  const FINE = Math.max(0, ((state.meta.tierNames && state.meta.tierNames.length) || 1) - 1);
  for (let pid = 1; pid < n; pid++) {
    let nm = String(displayedLabel(pid, titleAt(pid, ct)) || '');
    if (!nm) nm = String(displayedLabel(pid, titleAt(pid, FINE)) || '');   // 兜底：最底层单位 ✓
    renderer.setPaintLabel(pid, nm ? Math.min(labelIdOf(nm) + 1, 65535) : 0);
  }
  state._lblPassKey = ct + '|' + (state.painted ? state.painted.size : 0)
    + '|' + ((state.labelNames && state.labelNames.length) || 0);
}

function pickAt(clientX, clientY) {
  const [mx, my] = screenToMap(clientX, clientY);
  const pid = provinceAt(mx, my);
  if (!pid) return;
  // 同样是**视图那一层** —— 取的是画面上这一刻的颜色
  const tid = titleAt(pid, state.tier);
  /* 🔴 **取色不能被 isLocked 拦住** ✗（用户报：空白剧本下没法取色 ✓）
   *   那一层的地几乎全是**无主地**（tid = NONE ✓）而 isLocked(NONE) = true ✗
   *   → 整个取色在这层被拦死 ✓ 其他层 tid 是真实头衔 → 所以只有空白剧本坏 ✓
   *   ⚠ 取色**只是把画面上的颜色吸走** ✗ 不改任何数据 ✓ 没什么可锁的 ✓
   *   ⚠ 真正给颜色的是 pickTitle → displayedColor(pid, tid) ✓
   *     它**先看手绘层** ✓ 所以涂过的地一定吸得到你自己的色 ✓ */
  pickTitle(tid, true, pid);
  if (state.hover.inside) {
    renderHoverCard(state.hover.pid);
    positionHoverCard(clientX, clientY);
  }
}

/**
 * 这块地值不值得还原
 *
 * 只看两件事：现在是不是原色、手绘层有没有记过它
 * 早先写的是 `!painted.has(tid) && !changed.has(tid)` —— 只认集合
 * 一旦哪个环节没把 tid 记进去（取色后涂回原色就容易漏），还原工具就点了没反应
 */
function needsRestore(tid) {
  // 还原 = **清掉玩家的涂色**，不是把颜色改回原色。
  // 所以判据只有一个：这块地有没有被玩家涂过 —— 跟「颜色是不是恰好等于原色」无关。
  // 玩家完全可以涂一个跟原色一样的色（吸自己的色再涂回去），
  // 那属于「涂过了」，以前却判成不用还原，于是点了没反应、擦不掉。
  return state.painted.has(tid);
}

function actAt(clientX, clientY) {
  const [mx, my] = screenToMap(clientX, clientY);
  const pid = provinceAt(mx, my);
  if (!pid) return;
  // 取色取的是**画面上这一刻的颜色**，而配色永远来自视图那一层 ——
  // 所以粒度换到省份时，吸管吸的仍是 1444 的那个国色
  // 涂色和还原才是按粒度落笔的
  let tid = titleAt(pid, state.tool === 'pick' ? state.tier : editTier());
  // **粗层点到荒地**：换掉这个共享伪头衔，改成"光标底下这一块"自己的节点。
  // 每块荒地只在最细那层有自己的节点（粗层共享一片 ✓），
  // 不这么换的话，粗层那一笔会把整片荒地一起涂上 ✗。
  // 手绘层是按省份记的，所以这一笔在**所有层级**都能看见 ✓。
  {
    if (state.tool !== 'pick' && isWastelandTid(tid)) {
      const _own = titleAt(pid, state.meta.tierNames.length - 1);
      if (_own !== NO_TITLE && isWastelandTid(_own)) tid = _own;
    }
  }
  // **粗层点到无主地**（空白剧本那一层全是无主地 ✓，1444 那种没归属的地也一样）：
  // 这一层没有归属可言，可**地还在** ✓ —— 笔跟光标都按"光标底下这一块"最细那层走 ✓
  //（跟上面荒地那条同一个道理：粗层没有可分的东西，就往细处落 ✓）
  if (state.tool !== 'pick' && (tid == null || tid === NO_TITLE)) {
    const _own2 = titleAt(pid, state.meta.tierNames.length - 1);
    if (_own2 != null && _own2 !== NO_TITLE) tid = _own2;
  }
  /* ⚠ **取色例外** ✗ —— 见 pickAt 里那段说明 ✓
   *   水那四类**禁止上色**（2026-10-16 用户定的 ✓ 见 `isLocked` 那段 ✓）——
   *   判据按**地块号**走 ✓ 所以 pid 一定要传进去 ✓
   *   （拿到的是粗层那个 `#sea_*` 片的 tid 也照样锁得住 ✓）*/
  if (state.tool !== 'pick' && isLocked(tid, pid)) return;

  if (state.tool === 'rename') { openRename(pid); return; }
  if (state.tool === 'pick') {
    pickTitle(tid, false, pid);
  } else if (state.tool === 'paint' || state.tool === 'fill') {
    // 「涂抹」和「填色」的**范围算法完全一样** ✓（都走 `paintAt`）——
    // 差别只在"按住拖动要不要沿路连发"：涂抹要、填色不要（见 mousedown 那儿的 painting ✓）
    paintAt(pid, tid);
  } else if (state.tool === 'erase') {
    // 两种口径，**清的单位都是地块**，而且范围跟涂色**共用同一个函数** ✓
    //   · **剧本视图 + 没开粒度 + 编辑层在剧本那一层** → 走 `paintTargetsAt`：
    //     涂色归属 → 剧本归属 → 最低单位那一块（涂了什么就还原什么 ✓）
    //   · 其余情况 → 范围取**编辑层那一块**：在最细层点就只有那一格（只清它 ✓），
    //     在地区 / 州那一层点就清这一块**包含的**涂色（里面涂过的省份不用一个个点 ✓）
    const _nEraE = (state.meta.eraDates && state.meta.eraDates.length) || 0;
    const _eraErase = _nEraE > 0 && state.grain == null && editTier() < _nEraE;
    const _pdE = renderer && renderer.paintData;
    if (_eraErase && _pdE) {
      // 范围 = 涂色那一套（开关怎么读也在它里面，所以这儿不再自己判 showBorderPaint ✗）
      const _tgt = paintTargetsAt(pid) || [];
      const _live = _tgt.filter((q) => _pdE[q * 4 + 3] > 0);   // 只清真有笔迹的地块 ✓
      paintPidsAsOne(_live, null);                             // 按地块擦（一条历史 ✓）
    } else {
      /* 范围 = **这一格在编辑层的那一块归属**，把属于它的地块的玩家涂色清空 ✓
       *
       * 跟涂色**完全对称**：涂色也是"认出这一格的归属 → 展开成地块 → 按地块涂" ✓
       *（actAt 取 tid → paintAt → `paintPidsAsOne(pidsOf(tid))` —— 两边同一套 ✓）。
       *
       * 以前这里是把这块地在**所有层级**上的头衔捞出来逐个清 ✗ ——
       * 于是在地区层涂一整块、切到省份层点一下还原，那个**地区头衔**也在名单里，
       * 整块地区跟着被清空 ✗（用户报的正是这个：4 个省份一起没了）
       */
      paintPidsAsOne(pidsOf(tid), null);
    }
  }
  renderHoverCard(state.hover.pid);
  positionHoverCard(clientX, clientY);
}

// ================================================================ 撤销重做

function undo() {
  const op = state.history.undo.pop();
  if (!op) return;
  for (const p of op.patches) applySide(p.from);
  recomputePainted();   // 账本重算 + 状态栏 "改动 N" 都在里面 ✓
  state.history.redo.push(op);
  updateHistoryUI();
  scheduleSave();
  blocksDirty = true;   // 标签块要跟着重建，否则颜色回来了、名字没回来
  renderHoverCard(state.hover.pid);
}

function redo() {
  const op = state.history.redo.pop();
  if (!op) return;
  for (const p of op.patches) applySide(p.to);
  recomputePainted();   // 同上
  state.history.undo.push(op);
  updateHistoryUI();
  scheduleSave();
  blocksDirty = true;   // 标签块要跟着重建，否则颜色回来了、名字没回来
  renderHoverCard(state.hover.pid);
}

function updateHistoryUI() {
  $('btn-undo').disabled = state.history.undo.length === 0;
  $('btn-redo').disabled = state.history.redo.length === 0;
}

// ================================================================ 粒度
//
// 年份视图（EU4 的 1444 / 1618 / 1800）里，颜色和「你动手改哪一块」可以分开
//
//     颜色      始终是 state.tier —— 画面永远是那年的政治地图
//     边界 / 悬停 / 笔刷   是 editTier() —— 默认跟视图一样，也可以换到地区或省份
//
// 于是可以"看着 1444 的归属，按省份一块一块改"。地图配色不跟着变，
// 不然一勾省份整张图就翻成省份配色了，等于把底图弄丢

/** 顶部有几层是剧本层（数据里没有剧本层就返回 0 —— 现在每套都有 ✓ 这条留着兜底）*/
function eraTierCount() {
  const m = state.meta;
  return (m && m.eraDates && m.eraDates.length) || 0;
}

/** 「空白剧本」在剧本块里的下标（没有就是 -1 ✓）—— 从数据里读（meta.tiers 里那个 'blank' ✓）*/
function blankTierIndex() {
  if (state._blankTier === undefined) {
    state._blankTier = ((state.meta && state.meta.tiers) || []).indexOf('blank');
  }
  return state._blankTier;
}

/**
 * **离当前视图最近的那个"有主"剧本层** ✓
 *
 * 用途：细层视图里"这块地原来是哪个国家"（更新国名 / 族的身份 / 名字落点 ✓）。
 * 停在剧本层时就是它自己 ✓ —— **空白剧本也算它自己**（那一层本来就谁都没有 ✓，
 * 所以在那儿画出来的东西才叫"你自己的国" ✓）。
 *
 * ⚠ 别写回 `min(tier, eraDates.length - 1)`：空白剧本挂在**剧本块最右边** ✓，
 *   细层视图下"最近的那个剧本"就变成空白层了 ✗ → 原版国名/身份全没了 ✗
 *   （空白层不在最后时（老数据）这条自动退回老行为 ✓）
 */
function countryTier() {
  /* **这张图根本没有"国家层"** ✓ —— 数据里标了 `noCountryLayer` 就直接认负 ✓
   *
   * 为什么 CK3 空白剧本要标它：CK3 的帝国 / 王国 / 公爵领是**封建头衔，不是国家** ✓
   * 而它那个"空白剧本"层是**全无主**的一层（就是拿来从零涂的 ✓）。
   * 不标的话这里会返回 blank 那一层 → 调用方去扫"那一层有哪些国家" →
   * 一个都扫不到（tid = -1）→ 取色 / 改名 / 图例那些全拿不到东西 ✗
   * 标了之后返回 -1，调用方就走"**没有国家层**"那条老路 ✓（跟 CK3 没有剧本时一样 ✓）
   */
  if (state.meta && state.meta.noCountryLayer) return -1;
  const n = eraTierCount();
  if (n <= 0) return state.tier;
  if (state.tier < n) return state.tier;          // 停在剧本层：就是它自己 ✓
  const last = n - 1;
  if (blankTierIndex() === last && last > 0) return last - 1;
  return last;
}

/** 此刻**动手**按哪一层走 */
function editTier() {
  const n = eraTierCount();
  if (n === 0 || state.tier < 0 || state.tier >= n) return state.tier;
  if (state.grain != null) return state.grain;
  /* 🔴🔴 **改回"视图层"** ✗✗（2026-10-14 ✓ 用户报的第三个问题 ✓）
   *
   *   用户原话："还有一个引申出的更严重的问题，**只开剧本不开粒度时的
   *     有主地块也出现了，他们以最低单位出现**"✓
   *
   *   ⚠ 我上一版把这里改成了"没粒度 → **最低层**"✗ ——
   *     那是冲着用户另一句话改的（"剧本下**高亮范围和名字**应该跟随粒度，
   *     没有粒度就是最低"✓）—— **可那句话只说高亮和名字** ✗
   *     而 `editTier()` 管的东西**远不止那两样** ✓：
   *       · 边界（`uEditTier` ✓ 见 gl.js）→ 剧本模式下按**最低单位**画 ✗
   *         （用户看到的"有主地块以最低单位出现"✓ 就是它 ✓）
   *       · 笔刷 / 涂色落点 / 各种"跟动手那一层有关"的判断 ✓
   *   → 所以 `editTier()` **必须回到"跟视图层一样"** ✓
   *     而"高亮和名字要最低层"那件事，**另开一个函数** ✓ 见 `labelTier()` ✓
   *
   *   ⚠ 两者分工（别再混 ✗）：
   *     `editTier()`  = **动手那一层**（边界 / 笔刷 / 涂色 ✓）→ 默认 = 视图层 ✓
   *     `labelTier()` = **显示那一层**（高亮 / 名字 ✓）→ 没粒度时 = 最低层 ✓
   */
  return state.tier;
}

/** 🔴 **这一格该按哪一层看** ✗✗（2026-10-14 ✓ 用户澄清后重写 ✓）
 *
 *   用户原话："我这里所谓的这些东西都针对的是**在剧本时没有归属具体国家
 *     或涂色的东西**"✓
 *
 *   ⚠ 所以"没粒度就是最低"那句**不是给所有人定的** ✗ ——
 *     它是给"**剧本时无主**的那些东西"（水域 / 荒地 ✓）定的特例 ✓
 *   正确规则 = **按这一格自己有没有归属分** ✗：
 *     · **有主**（属于某个国家 ✓ 或者被玩家涂过色 ✓）→ **视图层** ✓
 *       剧本模式下就是**国家** ✓ 悬停显示国家、高亮亮整国 ✓
 *     · **无主**（水域 / 荒地那类 ✓）→ **最低层** ✓
 *       高亮只亮一格、卡片显示细的 ✓（不然它在剧本层只有"整类"✓ 没法看 ✓）
 *
 *   ⚠ 开了粒度就一律用粒度 ✗ —— 那是用户明确选的 ✓
 *   ⚠ **别把它当成"全局最低层"** ✗ —— 我上一版就是这么错的 ✓：
 *     一律最低 → 有主地块也按最低单位显示 ✗（用户报的"有主地块以最低单位出现"✓）
 *     而且**高亮永远对不上国家** ✗（用户报的 ✓）
 */
function viewTierFor(pid, tid) {
  const n = eraTierCount();
  if (n === 0 || state.tier < 0 || state.tier >= n) return state.tier;
  if (state.grain != null) return state.grain;      // 开了粒度：一律听它的 ✓
  /* **这一格有没有"归属具体国家或涂色"** ✗ —— 三个条件（跟用户那句一致 ✓）：
   *   ① 视图层上它有头衔 ✓
   *   ② **而且那不是伪头衔** ✗✗ —— 水域 / 荒地那些是**编辑器造的**
   *      （`tid >= numRealTitles` ✓ 或者 `waterMask` 说是水 ✓）
   *      它们**不是"归属具体国家"** ✓ 用户明确点名要排除 ✓
   *   ③ 或者玩家**涂过**它（涂过就算"有主"✓ 见 paintData 的 alpha ✓）
   *
   *   ⚠ 实跑踩到的 ✗：CK3 的河流 pid 456 在**剧本层**拿到了 `#river_e_136`
   *     （伪头衔 ✓）→ 只看 ① 的话会判成"有主"→ 走视图层 ✗
   *     而用户要的是它按**最低层**（高亮一格 ✓）✓
   *   ⚠ `waterMask` 是最直接的判据 ✗（那个"小标签"✓ 见 `isWaterPid` ✓）
   *     伪头衔那个判断是**兜底**（老包没有 waterMask ✓ 荒地也没有 ✓）*/
  const t = (tid == null) ? titleAt(pid, state.tier) : tid;
  const _real = (state.meta && state.meta.numRealTitles != null)
    ? state.meta.numRealTitles : 1e9;
  const _isPseudo = (t != null && t !== NO_TITLE && t >= _real);
  const _isWater = isWaterPid(pid);
  const hasOwner = (t != null && t !== NO_TITLE && !_isPseudo && !_isWater);
  const pd = renderer && renderer.paintData;
  const painted = !!(pd && pid && pd[pid * 4 + 3] > 0);
  if (hasOwner || painted) return state.tier;        // 有主 → 视图层 ✓
  /* 无主（水域 / 荒地）→ **最低层** ✓（那儿才是"每块各自一片"✓）*/
  const _nt = (state.meta && Array.isArray(state.meta.tiers)) ? state.meta.tiers.length : n;
  return Math.max(0, _nt - 1);
}

/** **显示那一层** —— 高亮 / 名字看它（`editTier` 看边界 / 笔刷 ✓）
 *
 *  ⚠ 现在它只是 `viewTierFor` 的"无 pid 版" ✗ —— 拿不到具体地块时退回最低层 ✓
 *    （调用方大多有 pid ✓ 优先用 `viewTierFor(pid)` ✓）
 *
 *  为什么"最低层"是它的兜底：
 *    · 剧本层是"**国家**"那一层 ✗ 水域 / 荒地在那儿只有"整类"（没有"片"✓）
 *      → 高亮只能亮一格、名字也只能是"海洋"这种类名 ✓
 *    · 最低层才是"**每一块地各自一片**"那一层 ✓ 高亮 / 名字都准 ✓
 *
 *  ⚠ 取 `tiers.length - 1` ✗ 别硬编码层号 —— 每个游戏层数不一样 ✓
 *    （CK3 7 层、EU5 6 层、HOI4 6 层 ✓）
 *  ⚠ 开了粒度就用粒度 ✗ —— 那是用户选的 ✓
 */
function labelTier() {
  const n = eraTierCount();
  if (n === 0 || state.tier < 0 || state.tier >= n) return state.tier;
  if (state.grain != null) return state.grain;
  const _nt = (state.meta && Array.isArray(state.meta.tiers)) ? state.meta.tiers.length : n;
  return Math.max(0, _nt - 1);
}

function setGrain(t) {
  if (state.grain === t) return;
  state.grain = t;
  applyEditTier();
}

/** 把有效编辑层推给渲染器，并把跟着它走的界面刷一遍 */
function applyEditTier() {
  const e = editTier();
  renderer.setEditTier(e);
  //（「水域内部边界」那套 uniform 已随专属边界一起退役 ✓）
  const hl = hoverTargetTid(state.hover.pid, state.hover.tids[e]);
  applyHoverHighlight(state.hover.pid, hl == null ? null : hl);
  updateCursor(hl, state.hover.pid);
  refreshTierButtons();
  renderHoverCard(state.hover.pid);
  /* 🔴🔴 **换粒度必须重算海名标** ✗✗
   *   （2026-10-13 用户："水域名称好像也是这样，开剧本的时候显示的反而是最高层"✓
   *     实跑量到的：剧本层 + 粒度=4 时 `editTier()` 已经是 4 ✓
   *     可海名标还是 **561 个**（该是 98 个、跟 rg 层一致 ✗））
   *
   *   原因：`state.seaLabelPoints` 是**预先算好的一整份** ✓
   *     `labelDirty = true` 只会让 `drawLabels` **重画**它 ✗ 不会重算 ✓
   *     而它原来只在 `setTier()` 里算过一次 ✓ → 换粒度就停在旧那份 ✓
   *
   *   ⚠ 高亮 / 边界**不用**在这儿补 ✗ —— 它们每帧都读 `uEditTier` ✓
   *     只有"海名标"是**算一次存起来**的那种 ✓ 所以只有它需要重算 ✓
   *   ⚠ 包在 try 里 ✗ —— 没载地图时 `state.titles` 还没有 ✓ 不能让它把切层弄崩 ✓ */
  try { state.seaLabelPoints = buildSeaLabelPoints(); } catch (err) { /* 没载图就跳过 ✓ */ }
  labelDirty = true;
  invalidate();
}

/**
 * 按一下视图那一排的某个层级 —— 按钮和快捷键都走这里
 *
 * 年份视图里这一排兼作粒度开关，不用另开一排。**每个按钮都是「按一下开、再按一下关」**
 *
 *   年份 + 细层级是一对：年份出配色，细层级出边界和笔
 *
 *   按着省份再按 1618          → 配成一对：1618 配色 + 省份粒度
 *   再按一下同一个年份         → 拆开，退回省份视图
 *   按着 1618 再按地区 / 省份   → 只换粒度（配色还是 1618）
 *   再按一下同一个细层级        → 拆开，退回 1618 的整国粒度
 *
 * 别的视图下这一排就是普通的切视图
 */
function pressTier(tier) {
  const n = eraTierCount();
  const inEra = n > 0 && state.tier >= 0 && state.tier < n;

  if (!inEra) {
    // 不在年份视图。按年份那一层的话，顺手把**当前这一层**收成它的粒度 ——
    // 于是「省份 → 1618」给的是 1618 配色 + 省份粒度，再按一下 1618 又退回来
    if (n > 0 && tier < n && state.tier >= n) {
      const g = state.tier;
      setGrain(g);
      setTier(tier);
      return;
    }
    setTier(tier);
    return;
  }

  if (state.grain === tier) { setGrain(null); return; }   // 再按一下粒度：拆开

  if (tier >= n) { setGrain(tier); return; }              // 更细的一层：当粒'

  if (tier === state.tier) {                              // 再按一下视图：拆开
    if (state.grain != null) {
      const g = state.grain;
      setGrain(null);
      setTier(g);          // 年份配色退掉，粒度那一层接手当视图
    }
    return;                // 只有一层亮着时不响应（总得留一层）
  }
  setTier(tier);
}

/**
 * 悬停卡片那几行、还有搜索结果用的：点哪一行就把那一级拿来编辑
 * 跟 pressTier 的差别只有一点 —— 这里**不取色**，点谁就是按谁编辑
 */
function gotoLevel(tier) {
  const n = eraTierCount();
  if (n > 0 && state.tier >= 0 && state.tier < n && tier >= n) { setGrain(tier); return; }
  setTier(tier);
  // 点到年份那一层 = 「按整个国家编辑」，粒度得收掉 ——
  // 不收的话 setTier 会提前返回（层级没变），粒度就赖着不走
  if (n > 0 && tier < n) setGrain(null);
}

/** 视图那一排的高亮：视图一个（金色），粒度一个（弱一档的蓝） */
function refreshTierButtons() {
  const n = eraTierCount();
  const inEra = n > 0 && state.tier >= 0 && state.tier < n;
  const grain = inEra ? state.grain : null;
  for (const b of document.querySelectorAll('[data-role="tier"] button')) {
    const i = Number(b.dataset.tier);
    b.classList.toggle('on', i === state.tier);
    b.classList.toggle('grain', grain != null && i === grain);
  }
}

// ================================================================ 界面

function updateStatus() {
  $('status-changes').textContent = `改动 ${state.changed.size}`;
}

function setTier(tier) {
  if (state.tier !== tier) {
    state.tier = tier;
    renderer.setTier(tier);
    renderer.setEditTier(editTier());
    /* **记下"当前是哪个剧本"** ✓（取色阶梯②要用 ✓ 见 `wasteColorTiers` ✓）
     *   ⚠ 只记**剧本层**那几次 ✗ —— 地理层不覆盖它 ✓
     *     不然切到 pr 层就把"1444"冲掉了 ✓ ②又取不到色 ✓ */
    {
      const _nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
      if ((tier | 0) >= 0 && (tier | 0) < _nEra) state.lastEraTier = tier | 0;
    }
  }
  /* **换层当场把跟层级绑的那几个开关也同步过来** ✓
   *   （颜色 / 本层边界 / 名称那几个的值是按"当前视图属于哪一类"解析出来的 ✓）
   *   ✗ 不能等帧循环里那次 syncLayerSwitches()：它以前跑在 renderer.render() **之后**，
   *     于是换层后的第一帧是"新层的归属表 + 旧层的颜色开关" ——
   *     表现就是切层时屏幕上闪一帧**另一层原版的五颜六色**（省份位图那种图）✗
   *     （帧循环那边也已经挪到 render() 之前 ✓ 两头都堵上 ✓） */
  syncLayerSwitches();
  syncParentBorder();
  refreshTierButtons();
  /* **换层要重算水域名标签** ✓（2026-10-13 用户要求：
   *   "HOI4 的海域在 province 和 state 下应该每个地块一个名字，战略视图是合并的"
   *   "EU4/5 在不同的视图下，海域包括的范围也不一样" ✓）
   *   构建期给了 `seaNamesByTier`（下标 = tier ✓），换层 = 换一张表 ✗
   *   所以这里按新层重聚一次（那张表不存在就退回旧的 `seaNames` ✓ 见函数里 ✓）
   *   ⚠ 别漏了这一句 ✗ —— 只在加载时算一次的话，换层后海名还是**老那层**的 ✓ */
  try { state.seaLabelPoints = buildSeaLabelPoints(); }
  catch (e) { state.seaLabelPoints = []; }
  // **换层 = 换了一批色块** ✓ 分组要重算 ✓
  //（图例列表本身不去当场刷 ✗ —— 按用户的主意：只在"点图例 / 导出"时才更新 ✓）
  blocksDirty = true;
  const hl = hoverTargetTid(state.hover.pid, state.hover.tids[editTier()]);
  // 海 / 山是背景板，不给选中也不高亮 —— 高亮会把**整片海**当成一个头衔点亮
  applyHoverHighlight(state.hover.pid, hl == null ? null : hl);
  labelDirty = true;
  renderHoverCard(state.hover.pid);
}

function setTool(id) {
  state.tool = id;
  for (const b of document.querySelectorAll('[data-role="tool"] button')) {
    b.classList.toggle('on', b.dataset.tool === id);
  }
  const t = TOOLS.find((x) => x.id === id);
  updateCursor(state.hover.tids[editTier()], state.hover.pid);
}


/**
 * 把界面里写死的中文换成当前游戏的说法
 *
 * CK3 说「头衔」，EU4 说「省份 / 地区 / 区域 / 大洲」—— 同一个编辑器
 * 两套词汇。渲染层完全共用，只有这些标签和导出方式不一样
 */
function applyGameText() {
  const g = GAME;
  document.title = g.title;
  $('brand-mark').innerHTML = `${g.brand}<small>${g.brandSmall}</small>`;
  $('boot-title').textContent = g.title;
  // （原来这里还把「头衔」那组的标签改成 g.entity —— 那组删了 ✓ 标题那边用同一个值 ✓）

  /* 各模式的默认开关（**八套地图都一样** ✓ —— CK3 原来是个例外（只有「头衔」那一组、
   * 颜色边界全开 ✗），用户点名的"取消 CK3 的特立独行、和其他模式一样" ✓ 见 build_data
   * 里 eraDates 那段：CK3 现在也是"剧本层 + 地区层"的结构 ✓）：
   *   势力（玩家涂色那组）：开边界 + 开地名 + 开颜色 ✓
   *   地块：默认**显示地名**（颜色按需自己开 ✓ 画面干净 ✓）
   *   剧本颜色：**固定开** · 剧本边界：**固定关** ✓（「剧本」那组 2026-10-17 删了 ✓）
   * 注意要改"来源"开关 —— 那几个派生值由 syncLayerSwitches 每帧按来源重算 ✓ */
  {
    state.showPowerColor = true;       // **剧本颜色固定开** ✓（那个勾已删 ✓）
    state.showRegionName = true;       // 地块·名称：默认**开**（用户要求：默认显示地名 ✓）
    state.showPowerBorder = false;     // **剧本边界固定关** ✓（那个勾已删 ✓）
    state.showPaint = true;
    state.showBorderPaint = true;
    state.showLabelsPaint = true;
    state.showTitles = true;
    state.showBorderTitle = false;
    state.showLabelsTitle = true;       // 地名：**默认开** ✓（用户要求 ✓）
    state.wasteAuto = false;            // 荒地自动上色：**默认关** ✓（用户定的 ✓）
    state._layerSig = null;
    state._parentSig = null;
    state._wasteSig = null;             // 换了图/重置了开关：让帧循环重算一遍 ✓
  }
  // 状态 → 界面上的勾（HTML 里的 checked 只是初值，这里统一过来）
  // 注意：**别把 state 里不存在的字段塞进来** ✗ —— `el.checked = undefined`
  // 等于把勾取消（另外，界面上没有的开关也别塞：`$()` 会返回 null ✓）
  const _sw = [
    ['show-paint', state.showPaint],
    ['show-labels-paint', state.showLabelsPaint],
    /* ⚠ 「剧本」那三个（show-power-names / color / border）2026-10-17 删了 ✗
     *   → 这里不再有那三行 ✓ 名字那个状态只剩 #show-labels-paint 独家管 ✓ */
    ['show-border-paint', state.showBorderPaint],
    ['show-parent-border', state.showParentBorderTitle],
    ['show-region-color', state.showRegionColor],
    ['show-region-border', state.showRegionBorder],
    ['show-region-name', state.showRegionName],
    /* 水域那两个（2026-10-16 新加的 ✓）+ 荒地那个（2026-10-17 新加的 ✓）——
     *  它们每帧现读、**不写 state** ✗ 但界面上的勾也得跟 state 对齐 ✓
     *  （存过的偏好 / 换图重置都算 ✓）*/
    ['show-water-border', state.showWaterBorder],
    ['show-water-name', state.showWaterName],
    ['show-waste-border', state.showWasteBorder],
    ['show-waste-name', state.showWasteName],
    ['waste-auto', state.wasteAuto],
  ];
  for (const [_id, _v] of _sw) {
    const _el = $(_id);
    if (_el) _el.checked = _v;
  }
  // **状态 → 渲染器**：这几个 setter 原来只在用户点复选框的回调里调，
  // 程序里改 state 是不会触发 change 的 ✗ —— 于是"勾是关的、画面还是五颜六色"。
  if (typeof renderer !== 'undefined' && renderer) {
    renderer.setShowTitles(state.showTitles);
    renderer.setShowPaint(state.showPaint);
    /* 原版边界（原来是从「头衔 · 边界」那个复选框读的 ✗ 那组已经删了）——
       现在从 state 读；有年代层的话，下一帧 `syncLayerSwitches` 会按
       「势力/地区 · 边界」重算一遍 ✓ */
    renderer.setBorderTitle(!!state.showBorderTitle);

    // **把签名作废一次**：上面这几行是照着旧勾选框推的，
    // 势力/地区那套带签名去重 —— 不这么做，它们后面不会再推，旧值就赖着 ✗
    state._layerSig = null;
    state._parentSig = null;
    const _bp = $('show-border-paint');
    if (_bp) renderer.setBorderPaint(_bp.checked);
    renderer.setMix(1.0);
  }
  /* 「地块」那一组要有年代层才出现 ✓
     （「剧本」那一组 2026-10-17 整组删了 ✗ —— 用户说那三个开关没用了 ✓
       「势力 / 水域 / 荒地」三组默认都在 ✓
       🔴 荒地那一组例外：**没有荒地设定的游戏（VIC3 / HOI4）整组藏掉** ✓
          设置页里的「荒地」小节 + 清除荒地按钮也跟着藏 ✓） */
  {
    const _hasEra = !!(state.meta && state.meta.eraDates && state.meta.eraDates.length);
    for (const _id of ['region-group']) {
      const _el2 = $(_id);
      if (_el2) _el2.style.display = _hasEra ? '' : 'none';
    }
    /* 荒地 UI：有没有荒地只看**数据里的名单** ✓（VIC3 / HOI4 原版是空的 ✓）
       ⚠ 清除按钮另看 `wastePidList`（索引建没建好），没有索引时禁用而不是藏掉 ✓ */
    const _hasWaste = !!(state.meta && state.meta.wasteland && state.meta.wasteland.length);
    const _wg = $('waste-group');
    if (_wg) _wg.style.display = _hasWaste ? '' : 'none';
    for (const _wid of ['set-waste-sub', 'set-waste-w-row', 'set-waste-a-row']) {
      const _wel = $(_wid);
      if (_wel) _wel.style.display = _hasWaste ? '' : 'none';
    }
    const _cw = $('btn-clear-waste');
    if (_cw) {
      _cw.style.display = _hasWaste ? '' : 'none';
      const _hasWastePids = !!(state.wastePidList && state.wastePidList.length);
      _cw.disabled = !_hasWastePids;
      _cw.title = _hasWastePids
        ? '清除荒地上的涂色，并关闭「荒地 · 自动上色」'
        : (_hasWaste ? '这张图的荒地块还没建好索引' : '这张图没有荒地');
    }
  }  // 有年代层的模式（非 CK3）能查TAG，标题就别写死"省份"了 ✓
  $('hdr-search').textContent = ((state.meta.eraDates || []).length) ? '查找' : `查找${g.entity}`;

  // 没有对应导出方式的模式（HOI4）直接把这个按钮收掉 —— 留着点了没反应更糟
  // 用 style.display 而不是 hidden：按钮在 display:flex 的容器里，hidden 会被压掉

  $('label-pick-hint').textContent = g.pickHint;
  $('search').placeholder = g.searchPlaceholder;
  $('results').innerHTML = `<p class="empty">${g.searchHint}</p>`;

  const meta = state.meta;
  if (meta) {
    // 层级数按数据来（V3 只有 4 层），快捷键就顺势给 1..N
    TIER_KEYS = meta.tiers || TIER_KEYS;
    TIER_COUNT = TIER_KEYS.length;
    TIER_HOTKEY = TIER_KEYS.map((_, i) => String(i + 1));
  }
}

function buildToolbar() {
  const tierBox = document.querySelector('[data-role="tier"]');
  // 年份那几层就是剧本层：日期和名字都是从游戏里common/bookmarks 读的
  // （DLC 会改那些文件），tooltip 里带上剧本名和日期
  const bms = (state.meta && state.meta.bookmarks) || [];
  state.meta.tierNames.forEach((label, i) => {
    const b = document.createElement('button');
    b.dataset.tier = i;
    b.innerHTML = `${label}<span class="k">${TIER_HOTKEY[i]}</span>`;
    const bm = bms[i];
    b.onclick = () => pressTier(i);
    tierBox.appendChild(b);
  });

  const toolBox = document.querySelector('[data-role="tool"]');
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.dataset.tool = t.id;
    b.innerHTML = `${t.label}<span class="k">${t.key}</span>`;
    b.onclick = () => setTool(t.id);
    toolBox.appendChild(b);
  }
}

// ================================================================ 搜索

let searchTimer = 0;
let searchHits = [];          // 最近一次搜索的结果（回车跳第一条要用）
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 90);
}

/** 跳到某条搜索结果：换到它那一级、按地盘大小飞过去、顺手把它的颜色吸进画笔 */
function jumpToResult(tid) {
  if (tid == null || tid < 0) return;
  gotoLevel(state.titles.tiers[tid]);
  flyTo(tid, searchJumpScale(tid));
  setBrush(state.titles.colors[tid], true, true);   // 定位时顺手取的色也算 ✓
  // **标签也要跟着来** —— 以前只取了色，名字还得自己敲 ✗
  setBrushLabel(state.titles.names[tid]);
}

/**
 * 按 tag 找**当前年代**里那个国家节点（1444_SWE / 1936_XSM 这种 key）。
 * 找不到返回 -1 —— 那说明它当前年代没地盘（就只取色、不跳 ✓）。
 */
function runSearch() {
  const q = $('search').value.trim().toLowerCase();
  const box = $('results');
  if (!q) {
    box.innerHTML = `<p class="empty">${GAME.searchHint}</p>`;
    $('search-count').textContent = '';
    searchHits = [];
    return;
  }
  const t = state.titles;
  // 名字 / key / 统计数都可能有**个别空洞**（数据是外面烘的）：直接拿去
  // .toLowerCase() 或比大小，一抛就是整个面板空着 —— 外面看就是"搜了没反应" ✗
  const _low = (v) => String(v == null ? '' : v).toLowerCase();
  const _sz = t.provCount || [];
  const hits = [];
  // 非 CK3：**跳过剧本/国家那几层** —— 「查找地区」这边只该查地区那一侧
  // （那些节点的 key 是TAG、颜色是国旗色，混在地区搜索结果里没意义）
  const _eraN = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  for (let i = 0; i < t.keys.length; i++) {
    if (t.tiers[i] >= TIER_COUNT) continue;   // ''荒地不是真领地，不参与搜'
    // 国家/剧本层（tag）**要能搜到**（也就能拿到它的颜色 ✓）；
    // 取色匹配那边不认细层 ✓（见 buildColorIndex）
    // 中文名显示、英文名也搜得到（EU4 的缓存里带了 namesEn）
    // **这里不许"收满 200 就停"**：收的顺序是节点序号，序号靠前的国家/剧本层
    // 会把名额吃光，排在后面的省份/地点一条都进不来 —— 于是「计数 200+、列表空着」✗
    // 要截也只能等按地盘排完序再截（全量扫 41k 节点实测 1.7ms，不是瓶颈 ✓）
    const alt = t.namesEn ? t.namesEn[i] : '';
    if (_low(t.keys[i]).includes(q) || _low(t.names[i]).includes(q) ||
        (alt && _low(alt).includes(q))) {
      hits.push(i);
    }
  }
  // **全部 tag**（含当前年代没地盘的）：数据里给了就也出结果行 ✓
  // 这段原来排在 `if (!hits.length) 没找到` **后面** —— 于是"只有 tag 表里才有"的
  // 国家（没地盘的 708 个 / 节点名跟国名不一样的那些）全都搜不出来 ✗
  const tagHits = [];
  const tagShown = new Set();   // 国家行已经列过的 tag —— 下面按它去重 ✓
  const ctags = (state.meta && state.meta.countryTags) || null;
  if (ctags) {
    for (const tag of Object.keys(ctags)) {
      const e = ctags[tag] || {};
      const nm = e.n || tag;
      if (_low(tag).includes(q) || _low(nm).includes(q)) {
        tagHits.push({ tag, name: nm, color: e.c || [128, 128, 128] });
        tagShown.add(tag);
        if (tagHits.length >= 120) break;
      }
    }
  }
  // **两边都没命中才算没找到**（以前只看节点那一侧 ✗）
  if (!hits.length && !tagHits.length) {
    box.innerHTML = '<p class="empty">没找到</p>';
    $('search-count').textContent = '';
    searchHits = [];
    return;
  }
  // **按 tag 去重**：同一个国家在三个年代各有一份节点，搜索里只该出一条 ✓
  // （年代跟搜索无关 —— 名字取"地盘最大"那份，key 用纯 tag）
  // 先按地盘大小排：大国家排前面，真要截也只截掉小的 ✓
  hits.sort((a, b) => (_sz[b] || 0) - (_sz[a] || 0));
  const seenTag = new Set();
  const rows = [];
  for (const tid of hits) {
    if (_eraN > 0 && t.tiers[tid] < _eraN) {
      const k = String(t.keys[tid]);
      const tag = k.includes('_') ? k.slice(k.indexOf('_') + 1) : k;
      // 国家行**已经把它列出来**了就不再重复（一个 tag 只出一条 ✓）；
      // 但节点名跟国名对不上的（V3 的 1836_FIN 在图上叫"芬兰大公国"、表里叫"芬兰"）
      // 必须自己出一条 —— 不然搜图上那个名字会说没找到 ✗
      if (tagShown.has(tag) || seenTag.has(tag)) continue;
      seenTag.add(tag);
      rows.push({ tid, tag });
    } else {
      rows.push({ tid, tag: null });
    }
    if (rows.length >= 120) break;
  }
  searchHits = rows.map((r) => r.tid);
  box.innerHTML = '';
  // 计数按**真列出来的行数**写；被 120 那条截过才带个 + ✓
  // （原来写死 "200+"，跟列表里到底几条完全对不上）
  const _shown = tagHits.length + rows.length;
  const _cut = rows.length >= 120 || tagHits.length >= 120;
  $('search-count').textContent = _cut ? `${_shown}+` : String(_shown);
  // 结果行里那几个 <span> 的小工厂 —— 一批（国家行）一批（地区/省份行）共用 ✓
  // （原来这两处各写了一份逐字相同的 _mkTag / _mk ✗）
  const _mk = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text == null ? '' : String(text);
    return s;
  };
  for (const h of tagHits) {
    const row = document.createElement('div');
    row.className = 'result-row';
    const dot = _mk('dot', '');
    // 国家行没有地块编号，但**有名字** ✓ → 按名字反查玩家涂过没有 ✓
    //（没涂过就用数据色 ✓）
    dot.style.background = rgbToHex(paintedColorByName(h.name) || h.color);
    dot.onclick = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      setBrush(h.color, true, true);      // 搜索里取的色也要进「最近用过」✓
      setBrushLabel(h.name);
    };
    const tier = _mk('tier', h.tag);
    const name = _mk('name', h.name);
    row.appendChild(dot);
    row.appendChild(tier);
    row.appendChild(name);
    row.appendChild(_mk('cnt', ''));
    // **国家行：点整行 = 取色 + 取标签，但不跳镜头** ✓
    // （要定位就用地区/省份那些条目 ✓）—— "不跳"这条用户强调过两次 ✗
    row.onclick = () => { setBrush(h.color, true, true); setBrushLabel(h.name); };
    box.appendChild(row);
  }
  for (const r of rows) {
    const tid = r.tid;
    const row = document.createElement('div');
    row.className = 'result-row';
    // 色点：**点它只取色**（设画笔 + 定标记），绝不跳镜头、不动图层 ✓
    const dot = _mk('dot', '');
    // 颜色取不到也给个灰的 —— rgbToHex(undefined) 会抛，抛了就整块面板空着 ✗
    const _col = swatchColorOf(tid);
    dot.style.background = rgbToHex(_col);
    dot.onclick = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      setBrush(_col, true, true);         // 同上 ✓
      setBrushLabel(t.names[tid]);
    };
    const tier = _mk('tier', r.tag || TIER_BADGE[t.tiers[tid]]);
    const name = _mk('name', t.names[tid]);
    const cnt = _mk('cnt', (t.provCount || [])[tid] || '');
    row.appendChild(dot);
    row.appendChild(tier);
    row.appendChild(name);
    row.appendChild(cnt);
    // **势力行（带国家 tag 的那些）= 只取色取名，不跳镜头** ✓
    // 跟上面"国家行"同一个规矩 ✓ —— 搜一个势力，图的是"把它的颜色和名字拿来用" ✓
    // 定位只是附赠 ✗（要看它在哪，用地区 / 省份那些条目 ✓）
    // 而且这层里有些势力在这张图上根本没有地盘 ✓ 本来也跳不了 ✓ 更不该弹个错
    if (r.tag) row.onclick = () => { setBrush(_col, true, true); setBrushLabel(t.names[tid]); };
    else row.onclick = () => jumpToResult(tid);   // 地区 / 省份：点行 = 定位 ✓
    box.appendChild(row);
  }
}

// ================================================================ 导出

/**
 * 把一份数据交给用户保存
 *
 * 🔴 **就用 <a download>，不许再调 navigator.share** ✗
 *   我上一轮"为了手机"加过一层系统分享 ✓ 结果（用户实测）：
 *     **文件照样存得下来** ✓ 但**分享面板弹出来就一直挂在那儿** ✓
 *   手机上那个面板不是我们能关的 ✗ 用户存完还得自己找路退出去 ✓ 纯添乱 ✓
 *   💡 结论：**手机上 <a download> 是能用的** ✓ 别看见"手机"两个字就上 Web Share ✗
 *
 * ⚠ 出错的兜底**不在这儿** ✗ —— 在 _wrap 的 catch 里 ✓
 *   （toBlob 那种异步失败也要有人接 ✓ 见 _wrap / onExportFail ✓）
 */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 导出当前画面：WebGL 那层和地名层叠起来存 PNG */
function exportViewPNG() {
  // 先补一帧，保证 WebGL 缓冲区里是刚画好的内容
  // （preserveDrawingBuffer 是关的，隔一帧就取不到了）
  renderer.dirty = true;
  renderer.render();
  // 两套地名各自独立：原有的（头衔/地区名）和玩家的（手绘色块名），
  // 谁开着画谁，两套都开就合并成一张名单一次画完
  drawLabels(viewRect());

  const glCanvas = $('map');
  const out = document.createElement('canvas');
  out.width = glCanvas.width;
  out.height = glCanvas.height;
  const ctx = out.getContext('2d');
  // 画布太大 / 设备内存不够时 getContext 会给 null —— 别让后面 drawImage 变成 TypeError ✓
  if (!ctx) return toast('导出失败：画布太大，这台设备画不出来', true);
  ctx.drawImage(glCanvas, 0, 0);
  ctx.drawImage($('overlay'), 0, 0);
  // 导出图例：勾了「画进导出的图」就画上去 ✓
  const _lgN = maybeDrawLegend(ctx, out.width, out.height);

  out.toBlob((b) => {
    if (!b) return toast('导出失败', true);
    download(b, `${GAME.filePrefix}_视图_${stamp()}.png`);
    LOG.event('导出窗口 PNG', `${out.width}×${out.height}${_lgN ? ' · 图例 ' + _lgN + ' 条' : ''}`);
    if (_lgN < 0) return toast('已导出，但图例是空的：这个视图里还没有可列的颜色 ✓ 先涂几块、或者在剧本层导出试试');
    toast(`已导出当前画面 ${out.width}×${out.height}` + (_lgN ? `（含 ${_lgN} 条图例）` : ''));
  }, 'image/png');
}

/**
 * 导出整张地图，按原始 9216×4608 分块渲染再拼起来
 * 不带地名 —— 地名是按屏幕尺寸排布的，拼到原尺寸上要重算一套，先不掺和
 */
/**
 * 导出整张地图 ✓
 *
 * `scale = 2` 就是**高清导出**（用户要求 ✓）：输出画布是 `地图宽高 × scale`，
 * 但 `setView()` 照旧按**地图坐标**给视口 ——
 * 着色器那边的 `uMapPerPx = view.w / canvas.width` 会自动减半 ✓
 * 于是**边界按新的尺度重画**（半宽 `0.5 × 宽度 × uMapPerPx` 跟着变 ✓），
 * 不再是"把 1× 的图画大了"那种放大糊 ✓ 这就是用户要的"失真大大降低" ✓
 *
 * ⚠ 分块尺寸要**按比例缩小** ✗：2× 时若还用 2048 的块，输出就是 4096×4096 的纹理，
 *   老显卡的最大纹理尺寸可能只有 4096（刚好卡线 ✓）甚至 2048 ✗ → 块要减半 ✓
 */
async function exportFullPNG(scale = 1) {
  const meta = state.meta;
  const W = meta.mapWidth;
  const H = meta.mapHeight;
  const OW = W * scale;
  const OH = H * scale;
  /* **浏览器画布上限护栏** ✗ —— 面积上限约 2.68 亿像素、边长常见 32767。
   *   EU5 原尺寸（16384×8192）点「导出高清地图」要 32768×16384 = 5.4 亿像素，
   *   必超 —— 以前是**闷头渲染好几分钟**，到 toBlob 那一步才告诉你"可能图太大" ✗。
   *   在这儿直接拦：说清楚要多大、怎么导才成 ✓ */
  if (OW > 32767 || OH > 32767 || OW * OH > 268435456) {
    LOG.event('导出整图被拦', `${OW}×${OH} 超过浏览器画布上限`);
    return toast(`这张图 ${scale}× 要 ${OW}×${OH}，超过浏览器能画的画布上限——`
      + (scale > 1 ? '请改用普通的「导出整图」（1×）。' : '这张图太大了，导不出来。'), true);
  }
  const glCanvas = $('map');
  // 输出块 = TILE × scale ≤ 2048 ✓（1× 时 2048、2× 时 1024 地图像素）
  const TILE = Math.max(512, Math.floor(2048 / scale));
  let _lgN2 = 0;                 // 图例画了几条（-1 = 勾了但没东西可画 ✓）

  const savedW = glCanvas.width;
  const savedH = glCanvas.height;
  const savedView = { ...renderer.view };

  const out = document.createElement('canvas');
  out.width = W * scale;
  out.height = H * scale;
  const ctx = out.getContext('2d');
  if (!ctx) return toast('导出失败：输出画布太大，这台设备画不出来', true);

  renderer.fixedSize = true;
  // 关掉抗锯齿：整图导出时一个像素 = 一个地图像素，四点超采样会在两个色块
  // 之间平均出一条混色带（放大看就是"糊的区域"）。屏幕上不受影响 ✓。
  renderer.noAA = true;
  toast(scale > 1 ? `正在渲染整张地图（${scale}× 高清）` : '正在渲染整张地图');

  try {
    for (let ty = 0; ty < H; ty += TILE) {
      for (let tx = 0; tx < W; tx += TILE) {
        const tw = Math.min(TILE, W - tx);
        const th = Math.min(TILE, H - ty);
        glCanvas.width = tw * scale;
        glCanvas.height = th * scale;
        renderer.setView(tx, ty, tw, th);        // 视口照旧是**地图坐标** ✓ 画布才是放大的那个 ✓
        // 分块图（EU5 原尺寸）：这一块的省份 id 瓦片多半还没进显存 ——
        // 平时靠 frame() 按视野异步补，导出必须先逐块拉齐再渲染，
        // 否则没看过的区域全渲成 0 号省份的底色。
        if (state.tileMap && renderer.provArrTex && renderer.tileInfo) {
          const jobs = [];
          for (const [r, c] of state.tileMap.tilesInView({ x: tx, y: ty, w: tw, h: th })) {
            const layer = r * state.tiles.cols + c;
            const cached = state.tileMap.cache.get(`${r}_${c}`);
            if (cached) { renderer.uploadTile(layer, cached); continue; }
            jobs.push(state.tileMap.get(r, c).then((tile) => {
              if (tile) renderer.uploadTile(layer, tile);
            }).catch(() => {}));
          }
          await Promise.all(jobs);
        }
        renderer.dirty = true;
        renderer.render();
        // 把这一块**按放大后的尺寸**贴到输出画布上 ✓（1:1，不再缩放 ✓）
        ctx.drawImage(glCanvas, 0, 0, tw * scale, th * scale,
                      tx * scale, ty * scale, tw * scale, th * scale);
        await new Promise((r) => setTimeout(r, 0));   // 让主线程喘口'
      }
    }
  } finally {
    renderer.fixedSize = false;
    renderer.noAA = false;
    glCanvas.width = savedW;
    glCanvas.height = savedH;
    renderer.setView(savedView.x, savedView.y, savedView.w, savedView.h);
    // 整图也把图例画上 ✓（放在 finally 里，前面就算哪块渲染失败也照样出一张带图例的图 ✓）
    // 尺寸也按放大后的给 ✓ → 图例的字和色块跟着一起放大 ✓
    _lgN2 = maybeDrawLegend(ctx, W * scale, H * scale);
    invalidate();
  }

  const _tag = scale > 1 ? `_整图${scale}x` : '_整图';
  out.toBlob((b) => {
    if (!b) return toast('导出失败，可能图太大', true);
    download(b, `${GAME.filePrefix}${_tag}_${stamp()}.png`);
    LOG.event('导出整图 PNG', `${OW}×${OH}` + (scale > 1 ? `（${scale}× 高清）` : '')
      + (_lgN2 ? ' · 图例 ' + _lgN2 + ' 条' : ''));
    if (_lgN2 < 0) return toast('已导出，但图例是空的：这个视图里还没有可列的颜色 ✓ 先涂几块试试');
    toast(`已导出整张地图 ${OW}×${OH}` + (scale > 1 ? `（${scale}× 高清）` : '')
      + (_lgN2 ? `（含 ${_lgN2} 条图例）` : ''));
  }, 'image/png');
}


/**
 * 工程的存取
 *
 * 只存「涂过的头衔」这一个清单 —— 颜色 + 标记，恢复时重放一遍即可
 * 比存整张手绘层（53 KB 的位图）小得多，而且天然跨版本：头衔 key 是稳定的
 *
 * localStorage 用来防「手滑刷新」，导出文件用来备份和换机器
 */
/* ============================================================================
 * **设置 + 最近颜色**（跟"涂色暂存"是**两码事** ✓ 用户要求分清楚）
 *
 *   · 涂色（`STASH_KEY`）：回主菜单才存、**F5 刷新就清** ✓（用户当年定的 ✓）
 *   · 设置 / 最近颜色（`SET_KEY`）：**刷新也在、回主菜单也在** ✓
 *
 * 🔴 **两份认的键不一样** ✗（2026-10-12 廿九定的）：
 *   · 设置 / 最近颜色 → **游戏类型**（`prefsKeyOf` = `meta.game`）✓
 *     同一个游戏的不同图**共用一套**（TNO 和钢铁雄心4原版共用 ✓ ——
 *     它们说的本来就是一回事：界面上那几档线宽浓度、以及你记过的颜色 ✓）
 *     删掉某一张图也**不许**把它们带走 ✓
 *   · 涂色暂存 → **哪一张图**（`mapKeyOf`）✗ 这个绝不能共用：
 *     CK3 和 EU4 的省份编号是两套，同一个游戏的不同 mod 省份数也可能不同，
 *     混在一起会互相把对方涂花 ✓
 * ========================================================================== */
const SET_KEY = 'pdx-map-editor/prefs/v1';

/** 设置 / 最近颜色认的键 = **游戏类型**（ck3 / eu4 / hoi4 / vic3 / eu5 ✓）
 *  —— 跟"哪一张图"无关 ✓（用户定的：TNO 和原版共用一份 ✓）*/
function prefsKeyOf(meta) {
  return (meta && meta.game) ? String(meta.game) : '';
}

/** 读设置 + 最近颜色 ✓（没有就返回 null → 用出厂值 ✓） */
function loadMapPrefs(meta) {
  try {
    const k = prefsKeyOf(meta);
    if (!k) return null;
    const box = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {};
    let v = box[k];
    /* 老版本是**按每张图**存的（键 = mapKeyOf）✗ —— 读不到就顺手认一次旧的，
       认到就地搬到游戏键上 ✓ 不然升级之后老用户的设置会一夜回到出厂值 ✓ */
    if (!v || typeof v !== 'object') {
      const old = mapKeyOf(meta);
      const legacy = old ? box[old] : null;
      if (legacy && typeof legacy === 'object') {
        v = legacy;
        try { box[k] = legacy; localStorage.setItem(SET_KEY, JSON.stringify(box)); } catch (e) { /* ✓ */ }
      }
    }
    // （水域那套专属边界宽浓的老存档搬迁已删 ✓ 老存档里多出来的那些键
    //   会被 Object.assign 拼进 state.set、谁也不读 ✓ 下次保存自然挤掉 ✓）
    return (v && typeof v === 'object') ? v : null;
  } catch (e) { return null; }
}

/** 把设置 + 最近颜色按**游戏类型**存下来 ✓（写不进去就返回 false，别让调用方以为成了 ✓） */
function saveMapPrefs() {
  try {
    const k = prefsKeyOf(state.meta);
    if (!k || !state.set) return false;
    const box = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {};
    box[k] = { set: Object.assign({}, state.set),
               // 最近颜色：只留颜色和它当时的标记名 ✓（最多 24 条，跟内存里那个上限一致 ✓）
               recent: (state.recent || []).slice(0, 24) };
    localStorage.setItem(SET_KEY, JSON.stringify(box));
    return true;
  } catch (e) { return false; }
}
let saveTimer = 0;

/** 涂完别马上写盘，等手停下来一会儿再存
 *  —— 存的是**设置 + 最近颜色** ✓（涂色那份故意不在这儿落盘 ✗ 见 saveProject ✓）*/
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveMapPrefs, 800);
}

/** 打包成一份工程数据 */
function projectData() {
  const t = state.titles;
  const out = { version: 1, generated: new Date().toISOString(), titles: {}, labels: {},
                // 图例的设定，跟着「导出涂色」一起存 ✓（名字不再存 ✗ —— 列表里不能改名了 ✓）
                legend: { show: !!(state.set && state.set.legend),
                          title: (state.set && state.set.legendTitle) || '',
                          pos: (state.set && state.set.legendPos) || 'tl',
                          on: Object.assign({}, state.legendOn || {}),
                          // 图例的**手动顺序**也跟存档走 ✓（在图例列表里用 ↑↓ 排的 ✓）
                          order: Array.isArray(state.legendOrder) ? state.legendOrder.slice() : [] },
                settings: Object.assign({}, state.set || {}),
                names: (() => {
                  const o = {};
                  if (state.titleName) {
                    for (const [tid, nm] of state.titleName) {
                      const k = t.keys[tid];
                      if (k && nm) o[k] = nm;
                    }
                  }
                  return o;
                })() };
  /* **逐最细层单位导出** ✓ —— 手绘层的真相是"每格自己的颜色 + 标记"：
   *   颜色读 `paintData[q]`、名字读 `labelNames[provLabel[q]]` ✓
   *   以前是"遍历涂过的头衔，去 `paintColor` / `titleLabel` 那两张表取" ✗ ——
   *   同一个头衔下可以有好几笔不同颜色/名字（1936 那半壁法国就是这种），
   *   按头衔存只能记下最后一笔 ✗ 这里逐格写就不会丢 ✓
   */
  const pd0 = renderer && renderer.paintData;
  const fine0 = TIER_COUNT - 1;
  const n0 = state.meta ? state.meta.numProvinces : 0;
  for (let q = 1; q < n0; q++) {
    if (!pd0 || pd0[q * 4 + 3] === 0) continue;
    const ft = titleAt(q, fine0);
    if (ft == null || ft === NO_TITLE) continue;
    const key = t.keys[ft];
    if (!key) continue;
    out.titles[key] = [pd0[q * 4], pd0[q * 4 + 1], pd0[q * 4 + 2]];
    const lq = state.provLabel ? (state.provLabel[q] | 0) : -1;
    if (lq >= 0 && state.labelNames[lq]) out.labels[key] = String(state.labelNames[lq]);
  }
  return out;
}

/* ---- 暂存：**按地图分开存** ----------------------------------------------
 * 这里原本就是这么设计的（"localStorage 防手滑刷新，导出文件做备份"）✓
 * 后来被关成了空函数 ✗ —— 用户现在明确要求：**回主菜单不许把画的东西弄丢** ✓
 * 所以重新启用，而且比原来更细：键里带上"哪张图" ✓
 * 钢铁雄心4 的原版 / 修改边界版、以及各代游戏之间，都不会串味 ✓
 */
const STASH_KEY = 'pdx-map-editor/stash/v1';

/** 认地图用：换地图数据就对不上 ✓（有 stashKey 就用它，没有就按数据特征拼） */
function mapKeyOf(meta) {
  if (!meta) return '';
  if (meta.stashKey) return String(meta.stashKey);
  return [meta.game, meta.mapWidth, meta.mapHeight, meta.numTitles,
          meta.numProvinces].join('|');
}
function stashBox() {
  try { return JSON.parse(localStorage.getItem(STASH_KEY) || '{}') || {}; } catch (e) { return {}; }
}
/** 把当前这张图上的涂色写进暂存区 ✓ 写不进去（无痕模式、配额满）返回 false ✓ */
function stashNow() {
  try {
    const k = mapKeyOf(state.meta);
    if (!k || !state.titles) return false;
    const box = stashBox();
    box[k] = projectData();
    localStorage.setItem(STASH_KEY, JSON.stringify(box));
    return true;
  } catch (e) { return false; }
}

/* ---- 暂存的写入时机：**只在"回主菜单"那一刻** -------------------------------
 * 用户要把两条路分开：
 *   · **回主菜单** → 存住 ✓ 回来接上 ✓
 *   · **F5 / 刷新** → 清空 ✓ 从零开始 ✓
 * 所以这里（涂一笔就触发的那个自动保存）**故意不落盘** ✗
 * —— 一旦在这儿存，F5 也会把东西接回来 ✗ 两条路就分不开了 ✓
 * 真正写盘的地方只有一处：goHome() 里那次 stashNow() ✓
 */
function saveProject() {
  // 空实现 ✓（别在这儿写 stashNow() ✗ 见上面那段说明）
}

function loadProject() {
  // 回到**同一张图**就把上次"回主菜单"存下的那份接上 ✓
  // **接完立刻删掉** ✓ —— 这样紧跟着按 F5 就是干干净净从零开始 ✓
  // （不删的话 F5 会又接回来 ✗ 那跟主菜单就分不开了 ✓）
  try {
    const k = mapKeyOf(state.meta);
    if (!k) return 0;
    const box = stashBox();
    const data = box[k];
    if (!data) return 0;
    const n = applyProject(data) || 0;
    /* **接完立刻把它删掉** ✓ 不然紧接着按 F5 又接回来 ✗（刷新就等于清不掉 ✓ 用户报的 ✓）
     *
     * ⚠ 必须"删 + **写回 localStorage**"两步都做 ✗
     *   上一版我只 delete 了内存里那份，然后调了一个**当时根本不存在的**存档写入函数 ✗
     *   → 抛错被 catch 吞掉 ✓ 内存删了、localStorage 里那份**原封不动** ✗
     *   → 于是每次刷新都从旧的读回来 ✓ 涂色怎么清都清不掉 ✓（用户报的那个 ✓）
     */
    try {
      delete box[k];
      localStorage.setItem(STASH_KEY, JSON.stringify(box));
    } catch (e) { /* ✓ */ }
    return n;
  } catch (e) { return 0; }
}

/**
 * 把一份工程数据套到当前状态上，返回恢复了几个头衔
 * 同时兼容图省事手写的 { "e_xxx": [r,g,b] } 这种扁平格式
 */
function applyProject(data) {
  // **外部文件 / 暂存区里读回来的东西不可信** ✗ —— 不是对象就直接当"没有可识别内容"✓
  if (!data || typeof data !== 'object') return 0;
  const t = state.titles;
  if (!t || !t.index) return 0;
  const colors = data.titles || data.colors || data;
  // 导入：图例设定也还原回来 ✓
  if (data.legend) {
    state.set = state.set || {};
    state.set.legend = !!data.legend.show;
    state.set.legendTitle = data.legend.title || '';
    state.set.legendPos = data.legend.pos || 'tl';
    // 老存档里的 legend.names 直接忽略 ✓ —— 图例改名的功能已经删了 ✓
    state.legendOn = Object.assign({}, data.legend.on || {});
    // 图例顺序一起还原 ✓（老存档没有这个字段 → 空数组 = 照旧按大小排 ✓）
    state.legendOrder = Array.isArray(data.legend.order) ? data.legend.order.slice() : [];
  }
  const labels = data.labels || {};
  if (data.names && typeof data.names === 'object') {
    state.titleName = new Map();
    for (const [k, nm] of Object.entries(data.names)) {
      const tid = t.index[k];
      if (tid != null && nm) {
        state.titleName.set(tid, String(nm));
        if (t.names) t.names[tid] = String(nm);   // 标签层读的是这份 ✓
      }
    }
    labelDirty = true;
    blocksDirty = true;
  }
  // **按文件声明清理原版"国家级"头衔名** ✓
  // 1444/1618/1789 那三层的名字是原版数据（普鲁士、美利坚、大不列颠、清…）。
  // displayedLabel() 对没涂色的省会回退到 state.titles.names[tid]，
  // 于是这些不属于本图的国名会漏到地图上（用户报的正是这个 ✗）。
  // 只有导入文件显式带了 "clearEraNames": true 才清 —— 默认一行不动 ✓
  if (data.clearEraNames) {
    const _t = state.titles;
    const _nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
    if (_t && _t.names && _nEra > 0) {
      let _cleared = 0;
      for (let i = 0; i < _t.names.length; i++) {
        if (_t.tiers[i] < _nEra && _t.names[i]) {
          // 抹掉就抹掉了 —— 名字从画面上消失是这个文件要求的 ✓
          // （以前还留一份底给"数据首都"那条路当身份用；首都机制整个拿掉之后，
          //   留底没人读了 ✗ 一起删 ✓）
          _t.names[i] = '';
          _cleared++;
        }
      }
      if (_cleared) { labelDirty = true; blocksDirty = true; }
    }
  }
  // **导入不动"设置"** ✗ —— 工程里那份 settings 是导出那一刻的界面开关 ✓
  // （势力名/地名那些一被套回来，剧本国家名就整片空了 ✓ = 用户报的"导入后国名全空"✓）
  // **导入只管涂色** ✓，你看什么由你自己当前的开关切定 ✓
  const savedLabel = state.brushLabel;
  let n = 0;

  for (const [key, rgb] of Object.entries(colors)) {
    const tid = t.index[key];
    if (tid == null || !Array.isArray(rgb) || rgb.length < 3) continue;
    if (t.tiers[tid] >= TIER_COUNT) continue;   // ''荒地不给'
    setBrushLabel(labels[key] || t.names[tid]);
    paintTitle(tid, [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0]);
    n++;
  }

  setBrushLabel(savedLabel);
  if (n) { blocksDirty = true; labelDirty = true; }
  return n;
}

function exportProject() {
  const data = projectData();
  const count = Object.keys(data.titles).length;
  if (!count) return toast('还没涂过任何东西', true);
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    `${GAME.filePrefix}_工程_${stamp()}.json`);
  state._exported = true;      // 手上有备份了 → 关页面时不再提醒（见 beforeunload）
  LOG.event('导出涂色', `${count} 处`);
  toast(`已导出${count} ${GAME.entity}的涂色，下次拖回窗口就能恢复。`);
}

/**
 * 导出报错日志 —— 出问题时报给作者的那一份 txt
 *
 * 跟别的导出不一样：**它不挑时候** ✓ 一条错误都没有也能导 ——
 * "有点卡""名字对不上""导出来的图不对"这类问题，
 * 日志里的 [当时的状态] 和 [轨迹] 就够了（不用再教玩家按 F12 抄控制台 ✓）
 *
 * 崩溃上屏框里挂的是同一个入口（见 showFatal）：那种时候顶栏已经点不动了，
 * 但按钮就在眼前 ✓
 */
function exportLog() {
  LOG.event('导出诊断报告', state.meta ? '顶栏 / 文件菜单' : '启动页');
  // 还没选图时用中性前缀；选了图就带上游戏（方便在附件里一眼认出来 ✓）
  const prefix = (state.meta && GAME && GAME.filePrefix)
    ? GAME.filePrefix : 'pdx-map-editor';
  const ok = LOG.download(`${prefix}_诊断报告_${stamp()}.txt`);
  if (!ok) {
    toast('诊断报告导不出来（日志模块没加载？）', true);
    return false;
  }
  toast('已导出诊断报告：出问题时把它发给作者就行。');
  return true;
}

function importJSON(file) {
  // 导入一份文本 —— 两条入口（拖文件 / 传文本）共用的收尾
  // （原来这两个分支各写了一份逐字相同的处理 ✗ —— 改了 toast 忘了改另一处就分叉了 ✓）
  const applyText = (text) => {
    try {
      const n = applyProject(JSON.parse(text));
      if (!n) return toast(`这份文件里没有能识别的${GAME.entity}。`, true);
      scheduleSave();
      LOG.event('导入涂色', `${n} 处`);
      toast(`导入 ${n} ${GAME.entity}的涂色。`);
      renderHoverCard(state.hover.pid);
    } catch (e) {
      toast('导入失败' + e.message, true);
    }
    recomputePainted();      // 手绘层变了：账本重算一遍 ✓
  };

  // 两种入口：拖进来给的是 File/Blob，别处给的可能已经是文本
  if (typeof file === 'string') { applyText(file); return; }
  const reader = new FileReader();
  reader.onload = () => applyText(reader.result);
  reader.readAsText(file);
}

function resetAll() {
  // **静默执行，不弹提示** ✓ —— 「清除」是你亲手按的 ✗ 不用再告诉你一遍
  // 按**地块**清（手绘层的真相就是"每格自己的颜色"✓），不再绕"涂过的头衔"那一圈 ✗
  const pd = renderer && renderer.paintData;
  const n = state.meta ? state.meta.numProvinces : 0;
  const pids = [];
  for (let q = 1; q < n; q++) if (pd && pd[q * 4 + 3] > 0) pids.push(q);
  if (!pids.length) return;
  LOG.event('清除全部改动', `${pids.length} 格`);
  paintPids(pids, null);
  state.history.undo.length = 0;
  state.history.redo.length = 0;
  updateHistoryUI();
  renderHoverCard(state.hover.pid);

  recomputePainted();   // 手绘层变了：账本重算一遍 ✓
}

/**
 * **清除荒地涂色**（2026-10-17 用户要的按钮 ✓）
 *
 * 干两件事：
 *   ① 把**荒地块上玩家手绘的色**清掉（走正常擦除那条路，算一步撤销 ✓）
 *   ② 关掉「荒地 · 自动上色」，并把荒地节点的 LUT 刷回荒地灰 ——
 *      不关的话下一帧 `wasteWatch` 会按周围颜色又算回来，看着就像"按钮没生效" ✗
 *
 * ⚠ 只动**荒地** ✗：普通地块一格都不碰；地图没有荒地（VIC3 / HOI4 原版）时按钮是禁用的 ✓
 */
function clearWastePaint() {
  if (!state.meta) return;
  const list = state.wastePidList || [];
  const pd = renderer && renderer.paintData;
  const pids = [];
  for (const pid of list) {
    if (pid > 0 && pd && pd[pid * 4 + 3] > 0) pids.push(pid);
  }
  const autoWas = !!state.wasteAuto;
  if (pids.length) {
    paintPidsAsOne(pids, null);      // 一次点击 = 一步撤销 ✓
  }
  // ② 自动上色：关掉它，否则清完立刻又被算回来
  state.wasteAuto = false;
  const autoEl = $('waste-auto');
  if (autoEl) autoEl.checked = false;
  state._wasteSig = null;
  try { refreshWasteAuto(); } catch (e) { /* 算不出来也别拖垮清除 ✓ */ }
  if (renderer) renderer.dirty = true;
  // 色块 / 图例 / 悬停都跟着变
  blocksDirty = true;
  labelDirty = true;
  renderHoverCard(state.hover.pid);
  LOG.event('清除荒地涂色',
    `${pids.length} 格手绘${autoWas ? ' · 自动上色已关' : ''}`);
  toast(pids.length || autoWas ? '已清除荒地涂色' : '荒地上本来就没有涂色');
}

// ================================================================ 事件

function bindEvents() {
  const stage = $('stage');

  /* ---- 回主菜单（选地图那一页）：右上角那个按钮，或者键盘 Esc ----------
   * 换地图要把数据、渲染器、整套状态全部重来一遍，这个 app 里没有
   * "重新初始化"的口子 ✗ —— 自造一套很容易把状态搞乱 ✓
   * 页面自带的启动流程（boot）干的正好就是这件事 ✓ 所以走重新加载这条路 ✓
   * 回主菜单之前**先把涂色存进暂存区** ✓ 再选同一张图会自动接上 ✓
   */
  const goHome = () => {
    const boot = $('boot');
    if (boot && getComputedStyle(boot).display !== 'none') return;   // 还在启动/选图阶段 ✓ 别动
    let dirty = 0;
    try { dirty = (state.changed && state.changed.size) || 0; } catch (e) { dirty = 0; }
    if (dirty > 0 && !stashNow()) {
      // 存不进暂存区（无痕模式 / 配额满）才问一句 ✗ 至少不静默丢
      if (!window.confirm('这台浏览器不让暂存，回主菜单会丢掉还没导出的涂色（改动 ' + dirty + ' 处）。\n'
        + '想留着就先点「导出 ▾ → 导出涂色」存一份。\n\n确定要回主菜单吗？')) return;
    }
    location.reload();
  };
  const homeBtn = $('btn-home');
  if (homeBtn) homeBtn.addEventListener('click', goHome);

  /* **Esc 只管一件事：回主菜单** ✓（用户定的 —— 不再一层层退 ✗）
   * 所以这里不判断"输入框里没里""有没有弹层开着" —— 按下去就是回主菜单 ✓
   * 但要把事件**抢在别人前面吃掉** ✓ 不然改名框、导出菜单各自的 Esc 也会跟着响应，
   * 那就又变成"两个功能"了 ✗（先 preventDefault，再 stopImmediatePropagation）
   */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    goHome();
  });

  /* ---- 滚轮缩放：**一步到位**（回滚了那版"分帧缓动" ✗）-----------------------
   * 曾经试过把累积量分几帧吃掉 ✓ 看着确实滑一点 ✓ 但带"尾巴"：
   *   滚轮停了画面还在自己走 ✗ 手感就是"卡 / 拖" ✓ 用户否了 ✓ 回滚 ✓
   * 现在还是：一格滚轮 = 当场算完 ✓ 立刻出结果 ✓
   * 嫌一格跳太大就只调下面那个系数（越小越细 ✓ 没有任何缓动 ✓）：
   */
  const WHEEL_K = 0.0016;
  /* ---- 滚轮缩放：**合并到帧** ----------------------------------------------
   * 触控板一次划动能连发十几个 `wheel` 事件 ✗ —— 以前每个都跑一遍 `zoomBy`，
   * 也就是**整张图重渲染十几遍**（还得重排一次标签），缩放自然卡 ✓
   * 现在把比例**乘起来攒着**、一帧只应用一次 ✓
   *（乘起来 = 缩放量一点不丢，手感跟原来一样 ✓）
   */
  let wheelAcc = 1, wheelAt = null, wheelRaf = 0;
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Firefox 的滚轮默认是"行"模式（一格 ±3），不换算的话一格只缩 ~0.5%；
    // "页"模式同样换算回像素量级，几个浏览器手感才一致。
    const dy = e.deltaMode === 1 ? e.deltaY * 33
      : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
    wheelAcc *= Math.exp(-dy * WHEEL_K);
    wheelAt = { x: e.clientX, y: e.clientY };
    if (wheelRaf) return;                       // 这一帧已经排了队 ✓
    wheelRaf = requestAnimationFrame(() => {
      wheelRaf = 0;
      const k = wheelAcc, at = wheelAt;
      wheelAcc = 1;
      if (k !== 1 && at) zoomBy(k, at.x, at.y);
    });
  }, { passive: false });

  stage.addEventListener('mousedown', (e) => {
    if (e.button === 1 || (e.button === 0 && state.tool === 'view')) {
      panning = { x: e.clientX, y: e.clientY, cx: state.cam.cx, cy: state.cam.cy };
      $('map').style.cursor = 'grabbing';
      e.preventDefault();
    } else if (e.button === 0 && state.tool !== 'view') {
      // 只有「涂抹 / 橡皮」支持按住拖动连发 ✓ ——
      // **「填色」是一次一个**（用户要求：按住拖也不会沿路填一片 ✓），
      // 改名这种单击工具同理（不然从 A 拖到 B 会沿路连发 ✗）。
      painting = (state.tool === 'paint' || state.tool === 'erase');
      actAt(e.clientX, e.clientY);
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', (e) => {
    const rect = stage.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                   e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (panning) {
      const dx = (e.clientX - panning.x) / state.cam.scale;
      const dy = (e.clientY - panning.y) / state.cam.scale;
      state.cam.cx = panning.cx - dx;
      state.cam.cy = panning.cy - dy;
      invalidate();
      return;
    }
    if (!inside) {
      if (state.hover.inside) {
        state.hover.inside = false;
        $('hover-card').hidden = true;
        renderer.setHover(null);
        labelDirty = true;
      }
      return;
    }
    if (painting && state.tool !== 'pick') actAt(e.clientX, e.clientY);
    updateHover(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', () => {
    if (panning) { panning = null; updateCursor(state.hover.tids[editTier()], state.hover.pid); }
    if (painting) state._blocksForce = true;    // 松手：把拖动期间欠下的那次重算补上 ✓
    painting = false;
  });

  stage.addEventListener('mouseleave', () => {
    state.hover.inside = false;
    $('hover-card').hidden = true;
    renderer.setHover(null);
    labelDirty = true;
  });

  // 右键取色（顺便把浏览器菜单挡掉）
  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    pickAt(e.clientX, e.clientY);
  });

  window.addEventListener('resize', () => {
    renderer.resize();
    labels.resize();
    state.cam.cx = clamp(state.cam.cx, 0, state.meta.mapWidth);
    state.cam.cy = clamp(state.cam.cy, 0, state.meta.mapHeight);
    invalidate();
  });

  /* **从后台回来** —— 手机切出去再回来黑屏那条路就在这儿收口 ✓
   *   · visibilitychange 是标准那条（手机 / 桌面都发 ✓）
   *   · pageshow 兜"从往返缓存回来"（有的浏览器只发这一条 ✓）
   *   · focus 再兜一道（桌面切窗口回来也顺手重画一帧 ✓）
   *   （三件都在 onEnterForeground 里，重复触发没关系 ✓）*/
  document.addEventListener('visibilitychange', onEnterForeground);
  window.addEventListener('pageshow', onEnterForeground);
  window.addEventListener('focus', onEnterForeground);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      return;
    }
    const ti = TIER_HOTKEY.indexOf(e.key);
    if (ti >= 0) return pressTier(ti);      // 快捷键跟按钮同一套语'
    const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
    if (tool) return setTool(tool.id);

    // 方向键推视角。按住会连着触发 keydown，所以长按就是连续平移；
    // 按住 Shift 步子大一点，方便横跨整片大陆
    const ARROWS = {
      arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1],
    };
    if (ARROWS[k]) {
      e.preventDefault();
      panBy(ARROWS[k][0], ARROWS[k][1], e.shiftKey ? 0.5 : 0.12);
      return;
    }

    if (k === 'escape') { $('search').value = ''; runSearch(); }
    if (k === 'f') fitView();
  });

  // 画笔输入
  $('brush-hex').addEventListener('change', () => {
    const c = hexToRgb($('brush-hex').value);
    if (c) onManualColor(c); else setBrush(state.brush, false);
  });
  const readRGB = () => {
    const r = clamp(parseInt($('brush-r').value, 10) || 0, 0, 255);
    const g = clamp(parseInt($('brush-g').value, 10) || 0, 0, 255);
    const b = clamp(parseInt($('brush-b').value, 10) || 0, 0, 255);
    onManualColor([r, g, b]);
  };
  for (const id of ['brush-r', 'brush-g', 'brush-b']) $(id).addEventListener('change', readRGB);

  // 色块点一下 → 弹**系统取色器**（跟设置页里那些 <input type="color"> 一模一样 ✓）
  // 走 onManualColor：和上面 HEX 框同一条路（设色 + 重新定标 ✓），不是只改个显示 ✗
  if ($('brush-swatch') && $('brush-color')) {
    // **取色器关掉（确认）之后**才记进「最近使用」✓（拖的时候一路记会刷一屏 ✗）
    $('brush-color').addEventListener('change', () => {
      const c = hexToRgb($('brush-color').value);
      if (c) setBrush(c, true);
    });
    $('brush-swatch').onclick = () => {
      $('brush-color').value = rgbToHex(state.brush);   // 每次打开都同步成当前色 ✓
      $('brush-color').click();
    };
    // 用 input 而不是 change：在取色器里拖着调的时候就能实时跟着变 ✓
    $('brush-color').addEventListener('input', () => {
      const c = hexToRgb($('brush-color').value);
      if (c) { setBrush(c, false); labelForColor(c); }
    });
  }

  $('brush-label').addEventListener('input', (e) => { state.brushLabel = e.target.value; });
  $('label-select').addEventListener('change', (e) => {
    const tid = Number(e.target.value);
    if (Number.isFinite(tid)) setBrushLabel(state.titles.names[tid]);
  });

  // 开关
  /* 「头衔」那组（原版颜色 / 地名 / 边界）的监听器跟着界面一起删了 ——
     它控的三样现在都由「势力 / 地区」那几组每帧算（见 syncLayerSwitches ✓）*/
  $('show-paint').addEventListener('change', (e) => {
    state.showPaint = e.target.checked;
    renderer.setShowPaint(state.showPaint);
    // 关掉手绘层之后，头衔那一层要露出**游戏原色** —— 不然玩家填的色还顶在 LUT 里
    resyncTitleLut();
    labelDirty = true;
  });
  // （荒地 / 水域的「允许上色 / 颜色 / 边界 / 清除 / 自动」监听器全删了 ✓
  //   水片与荒地片 = 普通头衔 ✓ 不再有专属开关 ✓）
  /* 🔴🔴 **「水域 · 边界 / 名称」两个开关请回来了** ✗✗（2026-10-16 ✓ 用户点名要的 ✓）
   *   ⚠ 写法**故意不跟上面那批一样** ✗（不往 `state` 里写、不调 syncXXX ✓）：
   *     两个都是**每帧现读**的字段 ✓（`state.showWaterBorder` / `state.showWaterName` ✓）——
   *     边界那条由 `syncLayerSwitches()` 每帧解析成渲染器上的派生值 ✓；
   *     名称那条由 `drawLabels()` 每帧取点前判一次 ✓
   *   ⚠ 那为什么还要监听器？—— 因为要**立刻置脏重画** ✓：
   *     主循环只"看不脏"就不画 ✗（`draw()` 里 `if (!this.dirty) return false;` ✓）
   *     不置脏的话，你勾掉之后画面要等到下一次别的操作才变 ✓（看着就是"点了没反应"✗）
   *   ⚠ 勾「水域 · 名称」还要把**标签重算** ✓（`labelDirty` ✓ 别只置渲染器脏 ✗）*/
  if ($('show-water-border')) {
    $('show-water-border').addEventListener('change', (e) => {
      state.showWaterBorder = !!e.target.checked;
      syncLayerSwitches();          // 立刻解析成渲染器上的 waterBorderOn ✓
      renderer.dirty = true;
    });
  }
  if ($('show-water-name')) {
    $('show-water-name').addEventListener('change', (e) => {
      state.showWaterName = !!e.target.checked;
      labelDirty = true;            // 水名那一批点要在下一次取点时重判 ✓
      renderer.dirty = true;
    });
  }
  /* 🔴 **「荒地 · 名称」**（2026-10-17 用户要的 ✓ 显示区新加那一行 ✓）
   *   跟水域那个一模一样的写法 ✗（都是每帧现读、都只置脏 ✓）
   *   ⚠ 注意：荒地**没有**「边界」那一条 ✗ —— 它 2026-10-15 就没有专属边界了 ✓
   *     用户这次点名的也只是**名称** ✓（别顺手给它加个边界勾 ✗）*/
  if ($('show-waste-name')) {
    $('show-waste-name').addEventListener('change', (e) => {
      state.showWasteName = !!e.target.checked;
      labelDirty = true;
      renderer.dirty = true;
    });
  }
  /* 🔴 **「荒地 · 边界」**（2026-10-17 ✓ 照水域边界那个一模一样的写法 ✓）
   *   ⚠ 它走 `syncLayerSwitches()`（跟水域边界同一处 ✓）——
   *     "勾 + 这张图有身份标"那个 AND 在里面 ✓ 别在这儿自己 AND 一遍 ✗ */
  if ($('show-waste-border')) {
    $('show-waste-border').addEventListener('change', (e) => {
      state.showWasteBorder = !!e.target.checked;
      syncLayerSwitches();
      renderer.dirty = true;
    });
  }
  /* 🔴 **「荒地自动上色」开关**（2026-10-17 重做 ✓ 用户点名要的 ✓）
   *   ⚠ 只写 state ✗ —— 真正重算由帧循环的 `wasteWatch()` 按签名做 ✓
   *     这里顺手置脏，保证下一帧立刻看得见 ✓ */
  if ($('waste-auto')) {
    $('waste-auto').addEventListener('change', (e) => {
      state.wasteAuto = !!e.target.checked;
      state._wasteSig = null;
      if (renderer) renderer.dirty = true;
    });
  }
  /* 「地块」那几个开关：勾了写回状态（下一帧 syncLayerSwitches 会解析生效）✓
   * ⚠ 「剧本」那三个 2026-10-17 删了 ✗ —— 不再有互斥绑定 / 不再有它们的监听器 ✓ */
  for (const [id, key] of [['show-region-color', 'showRegionColor'],
                           ['show-region-border', 'showRegionBorder'],
                           ['show-region-name', 'showRegionName']]) {
    const el = $(id);
    if (el) el.addEventListener('change', (e) => {
      state[key] = e.target.checked;
      /* 🔴 **「地区 · 颜色」一变，荒地自动色就得重算** ✗✗（2026-10-17 ✓）
       *   自动色的取色来源之一就是它（见 `wasteVoteColor` ✓）——
       *   关了 → 该**退回荒地色**；只改状态不重算的话，上一轮那份色会赖在 LUT 上 ✓
       *   ⚠ 剧本颜色现在是**固定开**（那个勾删了 ✓）→ 不用再听它 ✓ */
      if (key === 'showRegionColor') {
        try { refreshWasteAuto(); } catch (err) { /* ✓ */ }
      }
    });
  }

  /* 边界：**原版那条现在没有开关了**（「剧本」那组 2026-10-17 删了 ✓）——
     有年代层的模式由「地区 · 边界」管；这里只剩「势力 · 边界」这个复选框要听 ✓
     （「势力 · 边界」= 玩家涂色块的边界；按**当前显示的颜色**画 ✓） */
  const borderBox = $('show-border-paint');
  const applyBorders = () => {
    if (borderBox) {
      state.showBorderPaint = borderBox.checked;
      renderer.setBorderPaint(state.showBorderPaint);
    }
    state._parentSig = null;
    syncParentBorder();          // 本层/父级/爷爷的宽度与浓度立刻跟上
    renderer.dirty = true;
  };
  if (borderBox) borderBox.addEventListener('change', applyBorders);
  /* 地名：原来界面上一左一右两个开关（头衔组里那个管头衔/地区名）——
     头衔组的那个删了 ✓ 现在只有「填色 · 名称」，
     而普通地名（头衔/地区/省份名）由解析层按势力/地区每帧算 ✓ */
  /* 「父级边界」：关了就只有本层一条线（多级链不画）✓
     原来有两个开关（势力/地区那组一个、CK3「头衔」组一个），CK3 那个跟着删了 ✓
     现在只剩「地区」组那个 —— 但没有年代层的老缓存上它也可能不在，所以照旧判空 ✓ */
  {
    const _el = $('show-parent-border');
    if (_el) _el.addEventListener('change', (e) => {
      state.showParentBorderTitle = e.target.checked;
      state._parentSig = null;
      syncParentBorder();
      renderer.dirty = true;
    });
  }
  // （原来这里还有一个「填色 · 边界」的监听器 —— 跟上面 applyBorders 是同一件事的
  //   死副本 ✗ 顺手删了 ✓）

  /* 「名称」只剩「势力 · 名称」这一个入口 ✓
     （「剧本 · 名称」那个镜像勾 2026-10-17 随整组一起删了 ✓ 用户："已经没什么用了"✓）
     它同时管：玩家涂出来的色块名 + 剧本层那批国名 ✓（本来就是同一份分组 ✓）*/
  const _setLabelPaint = (on) => {
    blocksDirty = true;      // 玩家名字 = 全图实时重分组 ✓
    state.showLabelsPaint = on;
    labelDirty = true;
    const _el = $('show-labels-paint');
    if (_el && _el.checked !== on) _el.checked = on;
  };
  {
    const _el = $('show-labels-paint');
    if (_el) _el.addEventListener('change', (e) => _setLabelPaint(e.target.checked));
  }

  // 按钮
  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;
  $('btn-reset').onclick = resetAll;
  {
    const _cw = $('btn-clear-waste');
    if (_cw) _cw.onclick = clearWastePaint;
  }

  // 右上角「导出 ▾」：点开下拉，选完就收起来（省地方）
  const _menu = $('export-menu');
  const _closeMenu = () => { if (_menu) _menu.hidden = true; };
  if ($('btn-export') && _menu) {
    $('btn-export').onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      _menu.hidden = !_menu.hidden;
    };
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('click', (e) => {
        if (!_menu.hidden && e && e.target !== $('btn-export')) _menu.hidden = true;
      });
      window.addEventListener('keydown', (e) => {
        if (e && e.key === 'Escape') _menu.hidden = true;
      });
    }
  }
  // 「改名」小弹窗
  {
    const _rbox = $('rename');
    const _done = () => {
      const v = $('rename-input') ? $('rename-input').value : '';
      if (renameAt(_renamePid, v)) { _renamePid = 0; }
      if (_rbox) _rbox.hidden = true;
    };
    if ($('rename-ok')) $('rename-ok').onclick = _done;
    if ($('rename-cancel')) $('rename-cancel').onclick = () => { if (_rbox) _rbox.hidden = true; };
    const _inp = $('rename-input');
    if (_inp) _inp.addEventListener('keydown', (e) => {
      if (e && e.key === 'Enter') _done();
      else if (e && e.key === 'Escape' && _rbox) _rbox.hidden = true;
    });
    if (_rbox) _rbox.addEventListener('click', (e) => { if (e.target === _rbox) _rbox.hidden = true; });
  }

  // 「设置」二级面板（右上角开，改完立刻生效 ✓）
  {
    const _panel = $('settings');
    const _open = () => {
      if (!_panel) return;
      const s = state.set || {};
      const _now = (key) => {
        const c = s[key];
        if (c) return rgbToHex(c);
        /* 两项默认色（2026-10-13 拆开 ✓）：
         *   bg        「背景颜色」—— **180,180,180** ✓（用户定的 ✓ 220 → 200 → **180**）
         *   unpainted 「未上色区域」—— 150,150,150 ✓（就是原来那层中性灰 ✓）*/
        if (key === 'bg') return rgbToHex([180, 180, 180]);
        if (key === 'unpainted') return rgbToHex([150, 150, 150]);
        /* 🔴 **海 / 不可通行海域 / 湖 / 河 / 不可通行** 五行 ✓（2026-10-15 ✓）
         *   出厂色跟 `index.html` 那七行、跟 `build_data.py` 的类色一字不差 ✓ */
        if (NATURE_RGB[key]) return rgbToHex(NATURE_RGB[key]);
        return '#808080';
      };
      const put = (id, v) => { const el = $(id); if (el && v != null) el.value = v; };
      put('set-bg', _now('bg'));
      put('set-unpainted', _now('unpainted'));
      // 七行里的另外五行 ✓（海 / 不可通行海域 / 湖 / 河 / 不可通行区域 ✓）
      for (const _k5 of ['sea', 'isea', 'lake', 'river', 'impass']) {
        put('set-' + (_k5 === 'impass' ? 'impass' : _k5), _now(_k5));
      }
      // 线宽五档 / 浓度四档：**回填时吸附到最近的档位** ✓
      //（老存档里是滑杆时代的连续值，下拉里没有那一项会显示成空白 ✗）
      /* 「地方边界宽度」拆成了**地区 / 省份**两条 ✓（2026-10-13 用户要求 ✓）
       *   老存档只有 `w` → **两条都按它回填** ✓（那时两边就是同一个值 ✓ 观感不变 ✓）*/
      const _wOld = Number(s.w != null ? s.w : (state._borderWidthBase || 1));
      put('set-w-region', snapStep(Number(s.wRegion != null ? s.wRegion : _wOld), W_STEPS));
      put('set-w-prov', snapStep(Number(s.wProv != null ? s.wProv : _wOld), W_STEPS));
      put('set-pw', snapStep(Number(s.pw != null ? s.pw : 1), PW_STEPS));
      put('set-pa', snapStep(Number(s.pa != null ? s.pa : 50), CONC_STEPS));
      put('set-ra', snapStep(Number(s.ra != null ? s.ra : 75), CONC_STEPS));
      put('set-ca', snapStep(Number(s.ca != null ? s.ca : 100), CONC_STEPS));
      /* **水域边界那一对**（2026-10-16 ✓ 请回来了 ✓）
       *   老存档没这两项 → 出厂值（宽 1 / 浓 100% ✓）—— 跟改造前那条
       *   "水域线一直画、实心"的口径对得上 ✓ 观感不变 ✓ */
      put('set-water-w', snapStep(Number(s.waterW != null ? s.waterW : SET_DEFAULTS.waterW), W_STEPS));
      put('set-water-a', snapStep(Number(s.waterA != null ? s.waterA : SET_DEFAULTS.waterA), CONC_STEPS));
      /* 🔴 **荒地那一对**（2026-10-17 ✓ 老存档没这两项 → 出厂值 1 / 25% ✓）*/
      put('set-waste-w', snapStep(Number(s.wasteW != null ? s.wasteW : SET_DEFAULTS.wasteW), W_STEPS));
      put('set-waste-a', snapStep(Number(s.wasteA != null ? s.wasteA : SET_DEFAULTS.wasteA), CONC_STEPS));
      /* 两块字号都从 `fontSizes()` 取 ✓（老存档那个数字两块都用 ✓ 迁移只那一处 ✓）*/
      const _fo0 = fontSizes(s);
      put('set-fontplace', _fo0.place);
      put('set-fontpower', _fo0.power);
    put('set-labelac', s.labelAC != null ? s.labelAC : SET_DEFAULTS.labelAC);
    put('set-labelap', s.labelAP != null ? s.labelAP : SET_DEFAULTS.labelAP);
      // 背景那两条线：宽度 + 浓度 ✓（老存档没这几项 → 用出厂值 ✓
      //   水域 / 荒地的专属宽浓那六格已随开关一起退役 ✓）
      // 名字上限：range（1~20，**拉满 = 无上限** ✓）+ 旁边那个数值 ✓
      put('set-labelmax', s.labelMax != null ? s.labelMax : SET_DEFAULTS.labelMax);
      const _lmv0 = $('set-labelmax-v');
      if (_lmv0) _lmv0.textContent = labelMaxText();
      // 地名上限：另一根（同款"拉满 = 无上限"✓）；回填 + 刷旁边那个数值 ✓
      put('set-labelplacemax',
        s.labelPlaceMax != null ? s.labelPlaceMax : SET_DEFAULTS.labelPlaceMax);
      const _lpmv0 = $('set-labelplacemax-v');
      if (_lpmv0) _lpmv0.textContent = labelPlaceMaxText();
      // 取色后切到哪个画图工具（涂抹 / 填色 ✓）
      put('set-picktool', s.pickTool === 'fill' ? 'fill' : 'paint');
      // 导出图例那一栏：回填勾选/标题/位置，并把条目列表刷出来 ✓
      // （这里以前漏了 ✗ → 设置里那一栏是空的、勾选也回填不了 ✓）
      const _lgEl0 = $('set-legend');
      if (_lgEl0) _lgEl0.checked = !!(s.legend);
      put('set-legend-title', s.legendTitle || '');
      const _lpEl0 = $('set-legend-pos');
      if (_lpEl0) _lpEl0.value = s.legendPos || 'tl';
      rebuildLegendPanel();
      buildSliderTips();          // 九条滑条的当前值 ✓（提示 span 也是这儿插的 ✓）
      _panel.hidden = false;
    };
    if ($('btn-settings')) $('btn-settings').onclick = _open;
    // 署名那两个入口在文件开头就挂过了 ✓ 这里再挂一次只是兜底（幂等 ✓）
    bindAuthorLinks();
    if ($('set-close')) $('set-close').onclick = () => { if (_panel) _panel.hidden = true; };
    if (_panel) _panel.addEventListener('click', (e) => { if (e.target === _panel) _panel.hidden = true; });
    const bindColor = (id, key) => {
      const el = $(id);
      if (el) el.addEventListener('input', () => {
        const rgb = hexToRgb(el.value);
        if (rgb) { state.set[key] = rgb; applySettings(); }
      });
    };
    if ($('btn-clear-recent')) $('btn-clear-recent').onclick = clearRecent;   // 清空记忆颜色 ✓
    bindColor('set-bg', 'bg');
    bindColor('set-unpainted', 'unpainted');
    // 七行里另外五行 ✓（改完 `applySettings()` → `applyNatureColors()` 立刻重刷 LUT ✓）
    bindColor('set-impass', 'impass');
    bindColor('set-sea', 'sea');
    bindColor('set-isea', 'isea');
    bindColor('set-lake', 'lake');
    bindColor('set-river', 'river');
    const bindRange = (id, key) => {
      const el = $(id);
      if (el) el.addEventListener('input', () => {
        state.set[key] = Number(el.value);
        buildSliderTips();          // 旁边那个当前值跟着走 ✓（跟「名字上限」那行一个长相 ✓）
        applySettings();
        scheduleSave();             // 这几个值会落盘 ✓（设置是持久化的 ✓）
      });
    };
    /* **边界那一栏全是滑条** ✓（用户定的）——
     * 档位本来就是等距的（线宽 0.5 一档、浓度 25% 一档 ✓），
     * 所以 `min/max/step` 在 HTML 里一锁就天然只有那几档 ✓ 不用再靠下拉兜着 ✓ */
    bindRange('set-w-region', 'wRegion');
    bindRange('set-w-prov', 'wProv');
    bindRange('set-pw', 'pw');
    bindRange('set-pa', 'pa');
    bindRange('set-ra', 'ra');
    bindRange('set-ca', 'ca');
    /* **水域边界那一对**（2026-10-16 ✓ 请回来了 ✓ 走 bindRange，别手写 ✗
     *   —— 手写那版会漏掉旁边那个数值 / 落盘 / applySettings，正是当年踩过的坑 ✓）*/
    bindRange('set-water-w', 'waterW');
    bindRange('set-water-a', 'waterA');
    /* 🔴 **荒地边界那一对**（2026-10-17 ✓ 走 bindRange：数值 / 落盘 / applySettings 一条龙 ✓）*/
    bindRange('set-waste-w', 'wasteW');
    bindRange('set-waste-a', 'wasteA');
    /* 两块字号各绑各的 ✓（走 bindRange：旁边数值 / 落盘 / applySettings 一条龙 ✓）*/
    bindRange('set-fontplace', 'fontPlace');
    bindRange('set-fontpower', 'fontPower');
    /* **两个不透明度**：直接走 bindRange ✓（别手写 ✗）
     *   用户报的"滑块旁边的字不跟着变"—— 就是因为手写的这版**没调 buildSliderTips()** ✗
     *   而 bindRange 里那句一直在（旁边那个数值就是它刷的 ✓）
     *   → 走同一条路之后：① 数值跟着动 ✓ ② 落盘 / applySettings 也一并对齐 ✓
     *   ⚠ applySettings 里已经会把这两档推给标签层并置 labelDirty ✓ 所以这儿不用再补 ✓ */
    bindRange('set-labelac', 'labelAC');
    bindRange('set-labelap', 'labelAP');
    // **名字上限**（1~20，拉满 = 无上限 ✓）：跟颜色/线宽无关，改完把名字重算一遍就行 ✓
    {
      const el = $('set-labelmax');
      if (el) el.addEventListener('input', () => {
        state.set.labelMax = Number(el.value);
        const v = $('set-labelmax-v');
        if (v) v.textContent = labelMaxText();      // 拉满那一格会写"无上限" ✓
        blocksDirty = true;     // 名字要按新上限重算 ✓
        labelDirty = true;
        scheduleSave();
        if (typeof invalidate === 'function') invalidate();
      });
    }
    // **地名上限**（同款 1~21，拉满 = 无上限 ✓）：跟势力那根**分开** ✓
    //   ⚠ 这里**只重截断**（`_placeCapped` 作废 ✓）—— 连通域那趟并查集**不重跑** ✓
    //   ⚠ 千万别顺手置 `blocksDirty` ✗ 那是势力名的账，跟地名无关 ✓
    {
      const el = $('set-labelplacemax');
      if (el) el.addEventListener('input', () => {
        state.set.labelPlaceMax = Number(el.value);
        const v = $('set-labelplacemax-v');
        if (v) v.textContent = labelPlaceMaxText();   // 拉满那一格会写"无上限" ✓
        state._placeCapped = null;   // 重截断（见 placePointsFor ✓）
        state._placeKept = null;
        labelDirty = true;
        scheduleSave();
        if (typeof invalidate === 'function') invalidate();
      });
    }
    // **取色后切到**（涂抹 / 填色）：只存个偏好，跟界面/渲染都没关系 ✓（不走 applySettings）
    {
      const el = $('set-picktool');
      if (el) el.addEventListener('change', () => {
        state.set.pickTool = el.value === 'fill' ? 'fill' : 'paint';
        scheduleSave();
      });
    }
    // 导出图例的三个控件 ✓（勾选 / 标题 / 位置）
    const _lgEl = $('set-legend');
    if (_lgEl) _lgEl.addEventListener('change', () => { state.set.legend = _lgEl.checked; scheduleSave(); });
    const _ltEl = $('set-legend-title');
    if (_ltEl) _ltEl.addEventListener('input', () => { state.set.legendTitle = _ltEl.value; scheduleSave(); });
    const _lpEl = $('set-legend-pos');
    if (_lpEl) _lpEl.addEventListener('change', () => { state.set.legendPos = _lpEl.value; scheduleSave(); });
    if ($('set-reset')) $('set-reset').onclick = () => {
      /* 恢复默认必须当场落盘（用户报：点了恢复默认、刷新之后还是改过的值）
       *   原因：这里原来只重置了内存（state.set）而没写盘
       *     → 存的那份还是改过的值 → 一刷新又被读回来
       *   用 scheduleSave() 也不行：它是 800ms 防抖，点完立刻刷新就还没写下去
       *   → 所以直接 saveMapPrefs() 同步写一次
       *     写失败（无痕模式 / 配额满）再退回防抖那条路，至少不会静默丢掉 */
      state.set = Object.assign({}, SET_DEFAULTS);
      try { saveMapPrefs(); } catch (e) { scheduleSave(); }
      applySettings();
      _open();
    };
  }

  /**
 * 给导出一类按钮套一层"出错有人管"
 *
 * 🔴 **必须连 async 的拒绝一起接住** ✗（用户报：手机版导出 `Script error: 0` ✓）
 *   原来只有一句 `return fn(ev)` ✗ 而 `exportFullPNG` 是 **async** ✓
 *   → 它抛错 = **未处理的 Promise 拒绝** ✓
 *   → 手机浏览器对内联脚本做跨域屏蔽 → 报成 `Script error: 0` ✓ **堆栈全空** ✓
 *     所以那个报错"什么信息都没有" —— 不是没出错，是被藏了 ✓
 *   现在同步异常和异步拒绝都落到同一个出口 ✓ 至少能告诉用户出了什么事 ✓
 */
const _wrap = (fn) => (ev) => {
  _closeMenu();
  try {
    const r = fn(ev);
    // ⚠ 这里不能只看 typeof r === 'object' ✗ 任何带 .then 的都要接 ✓
    if (r && typeof r.then === 'function') r.catch(onExportFail);
    return r;
  } catch (e) {
    onExportFail(e);
  }
};

/** 导出失败时的统一出口：给一句人话 + 记进日志（别让它变成空白报错 ✓）*/
function onExportFail(e) {
  const msg = (e && (e.message || e.name)) || String(e);
  const full = msg + ((e && e.stack) ? ' · ' + String(e.stack).split('\n')[1] : '');
  try { LOG.event('导出失败', full); } catch (e2) { /* ✓ */ }
  /* 手机上最常见的就是"画布太大、内存不够" ✓ 顺手把解决办法说了 ✓
   *（整图导出在手机上要拼好几个大 canvas ✓ 内存本来就紧 ✓）*/
  const big = /memory|alloc|size|canvas|blob/i.test(msg);
  toast(big
    ? '导出失败了：这张图的画布太大，手机内存不够 ✓ 换成"导出当前画面"试试，或者用电脑 ✓'
    : '导出失败了：' + msg + '（细节记在导出日志里）', true);
}
  $('btn-png').onclick = _wrap(exportViewPNG);
  $('btn-png-full').onclick = _wrap(() => exportFullPNG(1));
  // **高清 2×**：输出宽高都翻倍、边界按新尺度重画 ✓（用户要求 ✓）
  if ($('btn-png-full2')) $('btn-png-full2').onclick = _wrap(() => exportFullPNG(2));
  $('btn-project').onclick = _wrap(exportProject);
  // 「导入涂色」：跟拖文件进来是同一个入口（importJSON），只是一个选文件、一个拖
  $('btn-import').onclick = _wrap(() => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      importJSON(f);          // 直接把文件交给 importJSON，别再自己读一遍
    };
    inp.click();
  });
  $('btn-log').onclick = _wrap(exportLog);      // 报错日志（web/js/log.js 收着 ✓）
  $('btn-zoom-in').onclick = () => zoomBy(1.35, stage.getBoundingClientRect().left + stage.clientWidth / 2,
                                                stage.getBoundingClientRect().top + stage.clientHeight / 2);
  $('btn-zoom-out').onclick = () => zoomBy(1 / 1.35, stage.getBoundingClientRect().left + stage.clientWidth / 2,
                                                    stage.getBoundingClientRect().top + stage.clientHeight / 2);
  $('btn-zoom-fit').onclick = fitView;

  $('search').addEventListener('input', onSearch);
  // 搜索框上的键盘：
  //   · 回车 → 跳到**第一条能定位的结果** ✓
  //     （searchHits 本来就是为这条路存着的，可它一直只写不读 ——
  //      笔记里那句"回车跳第一条"在当前代码里根本不存在 ✗）
  //   · Esc → 清空搜索。窗口那层也有一份，但它开头就 `INPUT 直接 return`，
  //     光标在搜索框里时轮不到它，所以这儿得接上 ✓
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // README 承诺"跳到第一条**能定位**的结果" —— 排最前的可能是个没地盘的头衔，
      // 直接 jumpToResult 会对着它 toast 完就结束；先找第一条真有坐标的。
      const _t = state.titles || {};
      const hit = searchHits.find((x) => x != null && _t.lx && _t.lx[x] != null);
      jumpToResult(hit != null ? hit : searchHits[0]);   // 全都定不了位：仍走第一条，让它弹"没有地盘"
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      $('search').value = '';
      runSearch();
    }
  });

  // 拖 JSON 进来导入
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    // Windows 常见的「方案.JSON」也别漏掉 —— 大小写敏感的 endsWith 会静默忽略它
    if (f.type === 'application/json' || /\.json$/i.test(f.name)) importJSON(f);
    else toast('只认 JSON 涂色文件（*.json）', true);
  });
}

// ================================================================ 渲染循环

function frame() {
  /* **帧循环整个包一层** ✓ —— 这是唯一一处"出错就再也不重排"的地方：
   * 里面任何一句抛了，requestAnimationFrame(frame)（在最底下）就永远轮不到 ✗
   * → 画面冻在最后一帧、控制台一条错、界面上什么提示都没有 ✓（最难查的那种）
   * 现在：报一次上屏（showFatal），但**继续排下一帧** —— 于是这一帧画坏了，
   * 下一帧照样有机会恢复 ✓
   * 只在第一次出错时弹一次提示，不然每帧一条会把屏幕刷爆 ✗
   */
  try {
    frameBody();
  } catch (e) {
    if (!state._frameErrShown) {
      state._frameErrShown = true;
      console.error('帧循环出错：', e);
      showFatal('✗ 渲染循环出错（地图可能不再刷新）：' + (e && (e.message || e)));
    }
  }
  requestAnimationFrame(frame);
}

/** 帧里的一步 —— **单独兜底** ✓（某一步坏了别把整帧的 render 一起拖下水）
 *
 *  以前 syncLayerSwitches / syncParentBorder 是裸调的：它们一抛，
 *  后面的 render() 根本轮不到 → 画面冻住，而 frame() 那层只会上屏一次 ✗
 *  现在（跟 wasteWatch 同一个待遇）每步各自 catch：错了记一次、下一帧照常跑 ✓
 *  ⚠ 同一个步骤只记第一条 ✗ —— 一帧一条会把控制台刷爆 ✓ */
function frameStep(name, fn) {
  try { fn(); }
  catch (e) {
    if (!state._frameStepErr) state._frameStepErr = new Set();
    if (!state._frameStepErr.has(name)) {
      state._frameStepErr.add(name);
      console.error(`帧步骤「${name}」出错（本帧跳过，之后照常继续）：`, e);
    }
  }
}

function frameBody() {
    /* **标记表必须在这里写** - 全项目原来只有 applyHoverHighlight 里调过一次，
     * 那是悬停高亮那条路：没悬停 -> 永远不写 -> 没涂过的地标记全是 0，
     * 只有涂色自己的那条路写了标记。表现就是"这个标记居然只看填色的"（用户抓到的）。
     * 放在渲染之前，写完立刻强制上传，保证这一帧着色器就拿得到。
     * 仍旧用那个键做闸（层 / 涂色数 / 标记名数变了才重算），不然每帧几万次白跑。*/ 
    try {
      if (renderer) {
        const _ctF = countryTier();    // 该层看的是"最近的**有主**剧本层" ✓
        const _keyF = _ctF + '|' + (state.painted ? state.painted.size : 0)
          + '|' + ((state.labelNames && state.labelNames.length) || 0);
        if (state._lblPassKey !== _keyF) {
          syncAllPaintLabels();
          renderer.paintDirty = true;
          if (typeof renderer.flushPaint === 'function') renderer.flushPaint();
        }
      }
    } catch (e) { /* ok */ }
  // ---- **跟层级绑的那几个开关：必须在 render() 之前同步** ----
  //   颜色 / 本层边界 / 名称那几个的值，是按"当前视图属于哪一类"（势力 or 地区）
  //   现算出来写回 state 再推给渲染器的（见 syncLayerSwitches ✓）。
  //   它们以前排在 renderer.render() **之后** ✗ → 换层后的第一帧是
  //   "**新层的归属表 + 旧层的颜色开关**" ✗：切到剧本、或从剧本切回细层时，
  //   屏幕上会闪一帧**另一层原版的五颜六色**（省份位图那种图）✗
  //   （现在 setTier() 也会当场同步一次 ✓ 这里再兜一道：别让任何状态变更晚一帧 ✓）
  frameStep('开关同步', syncLayerSwitches);
  frameStep('边界链', syncParentBorder);
  /* **荒地自动色**：签名变了才重算 ✓（层 / 粒度 / 三个颜色开关 / 开关 / 涂色 /
   *   周长表版本 / 设置里那个荒地色 ✓）—— 必须在 render() 之前 ✓
   * ⚠ 这三步各自兜底 ✗ —— 一步坏了不该让这一帧的 render 也轮不到 ✓（见 frameStep）*/
  frameStep('荒地自动色', wasteWatch);
  // ---- 分块：按视野补齐缺的块、离开视野的自然被缓存淘汰 ----
  // 半尺寸那套 state.tileMap 是 null → 走下面「合成切块」那条 ✓
  if (renderer && renderer.provArrTex && renderer.tileInfo) {
    const ti = renderer.tileInfo;
    const v = renderer.view;
    if (v && v.w > 0 && v.h > 0) {
      if (state.tileMap) {
        for (const [r, c] of state.tileMap.tilesInView(v)) {
          const layer = r * state.tiles.cols + c;
          const cached = state.tileMap.cache.get(`${r}_${c}`);
          /* **「缓存里有」≠「显存里有」** ✗ —— `provinceAt`（悬停）也会把块拉进
           *   缓存、而不上传 ✓ 原来只看缓存的跳过判断会让这些块**永远上不了车**：
           *   那块地图一直渲成 0 号省份的灰（悬停却查得到 —— 用户报的"缺一块"就是它 ✓）。
           *   所以：缓存有 → 没传过就趁这一帧补传 ✓；没缓存 → 取了传 ✓；
           *   传过的（uploadedTiles 里有）才跳过 —— 别每帧白传 ✓ */
          if (cached) {
            if (!renderer.uploadedTiles.has(layer)) renderer.uploadTile(layer, cached);
            continue;
          }
          state.tileMap.get(r, c).then((tile) => {
            if (tile) renderer.uploadTile(layer, tile);
          }).catch(() => { /* 取块失败就下一帧再试 */ });
        }
      } else if (ti.synthetic && renderer.uploadSyntheticTile) {
        /* 🔴 **合成切块：按视野懒传** ✗✗（2026-10-17 用户白屏之后改的）
         *   以前在 gl.js 的 setData 里一次全传：CK3 那张 9216×4608 要
         *   **120MB 显存**，手机 GPU 上下文当场被顶丢（画面变白、只剩地名 ✓）。
         *   现在：每帧最多两块、按"离视野中心近"排先；总显存还有 96MB 软上限
         *   （缩到最小、整张都在视野里时，也别一口气全灌进去 ✓ ——
         *    没传的块先空着，放大到那边自然就补上了 ✓）。
         *   ⚠ 传上去的记在 `renderer.uploadedTiles` 里，不会每帧白切白传 ✓ */
        const tileBytes = ti.tileW * ti.tileH * 2;
        const BUDGET = 96 * 1048576;
        const c0 = Math.max(0, Math.floor(v.x / ti.tileW) - 1);
        const c1 = Math.min(ti.cols - 1, Math.floor((v.x + v.w - 1e-6) / ti.tileW) + 1);
        const r0 = Math.max(0, Math.floor(v.y / ti.tileH) - 1);
        const r1 = Math.min(ti.rows - 1, Math.floor((v.y + v.h - 1e-6) / ti.tileH) + 1);
        const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
        const want = [];
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            if (renderer.uploadedTiles.has(r * ti.cols + c)) continue;
            const dx = (c + 0.5) * ti.tileW - cx;
            const dy = (r + 0.5) * ti.tileH - cy;
            want.push([dx * dx + dy * dy, r, c]);
          }
        }
        want.sort((a, b) => a[0] - b[0]);
        let n = 0;
        for (const [, r, c] of want) {
          if (n >= 2) break;
          if (renderer.uploadedTiles.size * tileBytes >= BUDGET) break;
          if (renderer.uploadSyntheticTile(r, c)) n++;
        }
      }
    }
  }
  const drew = renderer.render();
  const now = performance.now();
  if (state.focus && now > state.focusUntil) {
    state.focus = null;
    labelDirty = true;
  }
  if (blocksDirty) {
    /* **拖动涂色期间不重算** ✓（V3 4 万地块一次要 7~11 ms ✗ 那是半个帧预算，
     *   按住拖时会变成规律性的顿 ✓；而拖的时候你根本看不清标签在变 ✓）
     * 松手时 `state._blocksForce` 会把欠下的那次补上 ✓（见 mouseup）
     * 其余情况照旧**尾部节流**：最多 ~120 ms 一次 ✓
     */
    const _nowB = performance.now();
    const _due = state._blocksForce
      || (!painting && _nowB - (state._blocksAt || 0) > 120);
    if (_due) {
      state._blocksAt = _nowB;
      state._blocksForce = false;
      rebuildPaintBlocks(!!state._blocksAll);    // 只有国家/剧本那层才全图重分组 ✓
      blocksDirty = false;
      labelDirty = true;
    }
  }

  if (drew || labelDirty) {
    // 两套地名各自独立：原有的（头衔/地区名）和玩家的（手绘色块名），
    // 谁开着画谁，两套都开就合并成一张名单一次画完
    drawLabels(viewRect());
    labelDirty = false;
  }
  // 上面那两条（syncLayerSwitches / syncParentBorder）
  // **已经挪到 render() 之前了** ✓ —— 放这儿会让画面晚一帧才跟上 ✗
  // （下一帧的排队在 frame() 那层做 —— 出错了也要接着排 ✓）
}

/**
 * 悬停该按**哪一族**高亮 —— 跟涂色 / 还原同一套口径 ✓
 *
 *   · **涂过的地** → 返回那一族的涂色（全图同色同标记 ✓）
 *   · **没涂过的地** → 返回它的**稳定色**（原版色）：着色器按"颜色 + 标记"亮，
 *     而标记来自头衔名 → 亮出来的正是"那一国里**同色同名**的那些" ✓
 *     （同一个国家里被涂成别的颜色的占领区颜色不同，**不亮** ✓ 跟涂色那条一致 ✓）
 *   · 其余情况返回 null → 退回**按编辑层头衔**高亮（细层 / 开了粒度时用 ✓）
 *
 * **不看那两个边界开关** ✓ —— 涂色 / 还原那边的"归属"永远是"同色同标记"，
 * 开关只决定先看**全图玩家族**还是先看**那一国里同色同标记的那些**；
 * 而着色器这边的"颜色 + 标记"两条路本来就把这两种都盖住了 ✓
 *（以前这里要求「填色 · 边界」开着，只开「势力 · 边界」时就不整族亮了 ✗ —— 对不上）
 */
function hoverGroupRgb(pid) {
  if (!pid) return null;
  // **剧本层 + 没开粒度 + 编辑层就在剧本那一层**才谈得上"按族" ✓
  // （细层 / 开了粒度：归属就是编辑层那一块，按头衔亮就够了 ✓）
  const _nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  if (!(_nEra > 0 && state.grain == null && editTier() < _nEra)) return null;
  const pd = renderer && renderer.paintData;
  const p4 = pid * 4;
  // **涂过的先答** ✓：这一族的身份整个在手绘层上（颜色 + 标记）✓
  if (pd && pd[p4 + 3] > 0) return [pd[p4], pd[p4 + 1], pd[p4 + 2]];
  // 海 / 湖 / 不可通行 / 荒地 / 无主地：**不做整族高亮** ✓
  //（它们共用同一个伪节点，整族高亮会把一整片海都点亮 ✗）
  const _real = state.meta.numRealTitles != null ? state.meta.numRealTitles : 1e9;
  /* ⚠ 层用 `viewTierFor(pid)` ✗（2026-10-14 ✓ 用户澄清 ✓）——
   *   有主的地 → 视图层（剧本模式 = 国家 ✓ 整族亮整国 ✓）
   *   无主的水 / 荒地 → 最低层 ✓（那儿才逐块 ✓）*/
  const _t0 = titleAt(pid, viewTierFor(pid));
  if (_t0 == null || _t0 === NO_TITLE || _t0 >= _real) return null;
  if (isWastelandTid(_t0)) return null;
  // **按显示色**：没涂过的地 → 原版色（着色器配"标记"一起判，等价于同色同名 ✓）
  const c = stableColor(pid, _t0);
  if (!c || (c[0] === 150 && c[1] === 150 && c[2] === 150)) return null;   // 没颜色的地不高亮
  return [c[0], c[1], c[2]];
}

/** 把「整族高亮」推给渲染器（没有族就退回按头衔高亮） */
function applyHoverHighlight(pid, hl) {
  // 着色器是按 uEditTier 比对的 —— 每次都对齐，别让它停在初值上
  renderer.setEditTier(editTier());
  const _real = state.meta.numRealTitles != null ? state.meta.numRealTitles : 1e9;
  const _t0 = titleAt(pid, editTier());
  /* **背景（无主地 / 伪头衔 / 荒地）：按「同一片」整片亮** ✓（2026-10-13 用户追加要求 ——
   *   原话："HOI4 的战略地图的高亮显示是**海域一起来**而不是分开，EU 同理" ✓）
   *  ⚠ 新包现在每层一片了（`#sea_pr_57` 那种 ✓）—— **同一个 tid 就是同一片** ✓
   *     水片多半是伪头衔（`tid >= numRealTitles` ✓）→ 落进这条 ✓ 跟荒地一个待遇 ✓
   *     直接把 **tid** 交给着色器（uHoverTid ✓ 它比的就是
   *     `titleAt(pid, uEditTier)` ✓）→ 名字 / 边界 / 高亮**同一个来源** ✓
   *     换层之后高亮范围**自己就跟着变** ✓ 不用再编组 ✓
   *  ⚠ **老包**（每层一片之前打的）还是共享 `#sea` ✗ —— 那批包比 tid 就等于
   *     "全世界的海一起亮" ✗ 所以它们**退回编组表那条老路** ✓
   *     （`isTierPieceKey` 一判就知道新旧 ✓ 新包传 0 = 不编组 ✓
   *       着色器里编组优先（uHoverGroupId != 0 就走编组 ✓）→ 两条不会打架 ✓）
   *
   *  ⚠ **水域单独那支高亮已删** ✓（2026-10-14 定案：水域 = 普通地块 ✓）
   *     —— 原来那支走 `isWaterHere` / 「水域 · 颜色」开关搞特殊（"整片亮"还是
   *     "只亮一格"跟着色源变 ✗）；现在无主的水跟荒地一样：
   *     新包 = 板片 tid、老包 = 真名编组、涂过的 = 玩家涂色一族 ✓ */
  const _k0 = _t0 == null ? '' : String(state.titles.keys[_t0] || '');
  const _isBg = (_t0 == null || _t0 === NO_TITLE || _t0 >= _real
    || isWastelandTid(_t0));
  const _pieceHere = isTierPieceKey(_k0) ? _t0 : 0;
  const _gidHere = (_isBg && !_pieceHere) ? renderer.hoverGroupIdOf(pid) : 0;
  /* ⚠ **走 tid 那条时必须把 pid 传 0** ✗✗ —— 着色器里那三条的先后是
   *   `uHoverGroupId` → **`uHoverPid`** → `uHoverPaintOn` → `uHoverTid` ✓
   *   两个都传的话 `uHoverPid > 0` **先命中** ✓ → 永远只亮光标底下那一格，
   *   tid 那条路根本轮不到 ✗（我这一版实跑量出来的：海里还是只亮 1 格 ✓）
   *   —— 组号 / tid 任一有效就不再传 pid ✓ 都没有才退回"只亮一格" ✓ */
  const _hp = (_pieceHere || _gidHere) ? 0 : (pid || 0);
  // **涂过的无主地**（空白剧本那种一层全无主的）也按"一族"亮 ✓ ——
  // 没"片"的老包水节点（组号 0）→ 照旧只亮光标底下这一块 ✓
  // ⚠ 荒地有真名（meta.wastelandNames）→ 同名的那些也整片亮 ✓ 没名字的还是只亮一格 ✓
  const _noOwnHere = (_t0 == null || _t0 === NO_TITLE);
  const _paintNoOwn = _noOwnHere
    && !!(renderer.paintData && pid && renderer.paintData[pid * 4 + 3] > 0);
  if (_isBg && !_paintNoOwn) {
    /* **剧本层（含空白）海/湖全部单格** ✓（2026-10-15 用户报的两连：
     *   "空白剧本鼠标指着海洋和湖泊一下亮一片" → "正常剧本也有这种问题" ✓）
     *   · 成因 = 剧本层的海 / 湖格 tilemap 全指着**类片**（`#sea_all_<年份>` ✓
     *     整层共享一个 tid）→ 传 tid 给着色器（uHoverTid ✓ 它比 titleAt(h,uEditTier)）
     *     → **所有海域同时亮** ✗（用户原话 ✓ —— 空白和正常剧本全是这一个成因 ✓）
     *   · 陆 / 荒在剧本层**一格一个节点**（wl_<pid> ✓）→ 单格亮；海没有理由特殊 ✓
     *   → **剧本层悬停海/湖也单格** ✓：tid / 编组都不传、只传 pid ✓（uHoverPid 单格路 ✓）
     *   · 粒度层（地理层）的海片是真名片（`#sea_pr_57` ✓）→ 走 tid 整片亮那一条
     *     （普通头衔规则：hover 一片海区亮那一片 —— 不变 ✓）
     *   —— 涂过的格（_paintNoOwn ✓）照旧走后面的玩家涂色一族 ✓ 一个字节都不变 ✓*/
    /* **类名片格一律单格** ✓（2026-10-15 用户报的：EU5 的不可通行区域
     *   **本来是几块**、但名字全是"不可通行"（类名 ✓）→ 悬停把它们全都亮起来 ✗
     *   —— 涂色 / 边界都正常 ✓（它们本来就是普通地块、独立片 ✓ 分色不共享 ✓））
     *   · EU5 的数据形状查过了：**一个 `#impassable` 节点**（名字"不可通行" ✓）
     *     在 1337 / 区域 / 地区 / 省份四层各管 **1818 格**（整层一件 ✓）
     *     → hover 一格 = tid 匹配 = 全部不可通行区一块儿亮 ✗（用户所见 ✓）
     *   · **推广成统一口径**：**片自己的名字是类名**（走 isPseudoCategoryName ✓）
     *     = 它只是"同一类的格"，不是"一个地理单元" ✓ → hover 单格 ✓
     *     剧本层的海/湖（名字全是"海洋/湖泊" ✓）本来就落在这条里 ✓
     *     —— 上一把"剧本层全单格"的刀被这一条**收编**（判据更普适 ✓），
     *     真名海片（东太平洋等 ✓）不命中 → 照旧整片亮 ✓ 一个字节都没丢 ✓ */
    const _bgName = (_t0 != null && _t0 !== NO_TITLE)
      ? String((state.titles.names && state.titles.names[_t0]) || '') : '';
    /* 🔴🔴 **一格一片的背景（逐块真名的荒地 / 水）也单格** ✗✗
     *   （2026-10-15 用户报的："地点视图下悬停于荒地而同名荒地都同时高亮" ✓）
     *   成因：地点层的荒地是**逐块真名节点**（约顿海姆那种 ✓ `provCount` = 1 ✓）——
     *     名字不是类名 ✓ 于是掉到下面"同一片整片亮"那条 ✓
     *     可那条给的是**同名编组**（`hoverGroupIdOf` ✓ 按 `wastelandNames` 的
     *     **名字**分族 ✓）→ **同名的几块荒地一起亮** ✗
     *     （那本是给"整类共用一个伪节点"的老包留的 ✓ 新包每块自己一个节点 ✓）
     *   判据：这一片**自己就一块地**（`provCount <= 1` ✓）→ 直接按 pid 单格 ✓
     *   ⚠ 粗层的类片（一"片"上百格 ✓ `#impassable` 那种）不命中 →
     *     照旧走上面"类名 / 编组"那两条 ✓ 一个字节都没丢 ✓
     *   ⚠ 只收**无主 / 荒地**那类背景 ✗ —— 水片跟陆片一样是普通头衔 ✓
     *     它们有真名就该整片亮（用户要的"海域一起来" ✓ 见 `hoverGroupRgb` ✓）*/
    const _pc = state.titles.provCount;
    const _oneCellBg = (_t0 == null || _t0 === NO_TITLE || isWastelandTid(_t0))
      && !!(_pc && (_pc[_t0] | 0) <= 1);
    if (editTier() < eraTierCount()
        || (_bgName && isPseudoCategoryName(_bgName))
        || _oneCellBg) {
      renderer.setHoverState(pid || 0, 0, null, 0, null, 0);
      return;
    }
    // 背景：同一片整片亮 ✓（无主的水片 / 荒地片 ✓ 新包 = 比 tid ✓ 老包 = 比组号 ✓）
    renderer.setHoverState(_hp, 0, null, 0, _pieceHere || null, _gidHere);
    return;
  }
  /* 高亮跟**涂色 / 还原同一套口径**（悬停看到的 = 点下去会动的 ✓）——
   * 怎么算"哪一族"整个在 `hoverGroupRgb` 里（见它的注释 ✓）：
   *   涂过的地 + 「填色 · 边界」那条生效 → 按**玩家涂色归属**亮那一族；
   *   其余（没涂过的地、只开「势力 · 边界」、开了粒度、在细层）→
   *   退回**按编辑层头衔**亮：剧本层下就是那一年的整个国家 ✓
   *
   * ⚠ 最后统一走 `setHoverState` —— 它**跟上一帧一样就不重画** ✓
   *   （高亮在着色器里，换一次 = 整张图重跑 fragment shader ✗；
   *    而鼠标划过一片海、或划过一个国家的许多省份时，高亮范围**根本没变** ✓）
   */
  const grp = hoverGroupRgb(pid);
  let _hlLabel = 0;
  if (grp) {
    // **标记也要算上** ✓：同色不同标记是两块 ✗
    // 而且**每块地都要有标记编号** ✗（没涂过的地用它的原版国名 ✓ = 原版那块跟涂出来那块是一家 ✓）
    const _ctH = countryTier();        // 同上（跟那个键保持一致 ✓）
    const _keyH = _ctH + '|' + (state.painted ? state.painted.size : 0)
      + '|' + ((state.labelNames && state.labelNames.length) || 0);
    if (state._lblPassKey !== _keyH) syncAllPaintLabels();
    _hlLabel = (renderer.paintLabelData && renderer.paintLabelData[pid]) | 0;
  }
  renderer.setHoverState(0, grp ? 1 : 0,
    grp ? [grp[0] / 255, grp[1] / 255, grp[2] / 255] : null,
    _hlLabel,
    grp ? null : (hl != null ? hl : _t0));
}

/**
 * 标注点：**一个连通域 = 一个标签**
 *
 * 不看头衔、也不看颜色，而是按省份邻接关系做并查集，把涂过的地方切成一坨一坨
 * （**同色 + 同标记**才算同一坨，相邻但不同色、或同色但标记不同的都是两块）✓
 *
 * **每一坨各自出一个名字** —— 名字标在那一坨自己的几何中心上 ✓
 *   · 同一族铺成好几块互不相连的地方（本土 + 海外省 + 一堆小岛）→
 *     每一块都有自己的名字 ✓ 不再只留最大那块 ✗
 *   · 字号按**那一坨自己的面积**给，所以小岛的名字自然小、够不上门槛就不画 ✓
 *
 * 以前这儿还有一整套"哪一片才算老家"的规矩（玩家定都 / 数据首都 / 本土），
 * 名字只落在挑中的那一片上 —— 现在整套拿掉了 ✓ 谁也不用再问"首都放哪" ✓
 *
 * 结果缓存 state.paintBlocks，涂色后标脏、下一帧重算
 */
function rebuildPaintBlocks(all = false, unpainted = false) {
  state.paintBlocks = [];
  const adj = state.adjacency;
  const pos = state.provPos;
  const paint = renderer && renderer.paintData;
  if (!adj || !pos || !paint) return;

  const n = state.meta.numProvinces;
  const offsets = new Uint32Array(adj.buffer, adj.byteOffset, n + 1);
  const neighbors = new Uint16Array(adj.buffer, adj.byteOffset + (n + 1) * 4);

  const parent = new Int32Array(n);
  const painted = [];
  // 涂没涂的表 —— **在下面收集那一遍里顺手标掉** ✓（以前这里又全图扫了一遍 ✗）
  const isPainted = new Uint8Array(n);
  // all=true：**全图每省都参与**（身份用现成的显示逻辑算 ✓），不再只挑涂过的
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  const cTier = countryTier();       // 无主地的身份 / 国名落点都按「最近的**有主**剧本层」✓
  const ident = new Map();
  if (all) {
    const nReal = state.meta.numRealTitles != null ? state.meta.numRealTitles : 1e9;
    // **只有真在"国家/剧本"视图时才让没涂色的省参与** ✓
    // 以前只要 all=true 就全图参与，于是导入一份只涂了少数的配色后，
    // 几千个没涂的省会拿原版那一层的国名当势力名冒出来
    //（用户报的「导入后看见 1789 的普鲁士／美利坚」就是这个 ✗）。
    // 省份/地区视图下势力名只该来自玩家涂的块；原版那套由标签层按视图层自己画 ✓
    const incUnpainted = unpainted || (nEra > 0 && state.tier < nEra);
    // 身份串**按头衔缓存** —— 同一个国家几万个省，没必要每省拼一遍字符串。
    // （V3 4 万省时，正是这一遍把全图重分组顶到 108 ms ✗）
    // 🔴 **能按头衔缓存的别按省算** ✗（2026-10-17）：`_noOwn` / hideLabel / 伪头衔判定
    //   全都只看 tid —— 以前每省都跑一遍 `isWasteOrWaterTid`（键名 + 名单 + 前缀），
    //   4 万次里有 3.9 万次是同一批国家的重复劳动 ✓ 现在一格头衔只算一次 ✓
    const tidInfo = new Map();
    for (let pid = 1; pid < n; pid++) {
      const tid = titleAt(pid, cTier);
      let info = tidInfo.get(tid);
      if (info === undefined) {
        const noOwn = (tid === NO_TITLE || tid == null || tid >= nReal);
        const allowed = !(!noOwn && state.titles.hideLabel && state.titles.hideLabel[tid])
          && pseudoNameAllowed(isWasteOrWaterTid(tid));
        let key = null;
        if (allowed) {
          // 没涂过的地只能靠**原版那一层的名字**（它没有标签）✓
          const nm0 = state.titles.names[tid] || '';
          const c0 = state.titles.colors[tid] || [150, 150, 150];
          key = nm0 ? (nm0 + "|" + c0[0] + "," + c0[1] + "," + c0[2]) : null;
        }
        info = { noOwn, allowed, key };
        tidInfo.set(tid, info);
      }
      const _paintedPid = paint[pid * 4 + 3] > 0;
      if (_paintedPid) isPainted[pid] = 1;
      // **只收真头衔** —— 海、湖、河、山那些是伪头衔（第勒尼安海之类 ✗），不该当势力名画 ✓
      // **无主地也是**（空白剧本那一层全是无主地 ✓）：它本身没有归属/名字 ✗
      //   —— 但**玩家涂过的无主地**例外 ✓：那块的色块名/图例得照画 ✓（见下面 _paintedPid 那一段 ✓）
      if (info.noOwn && !_paintedPid) continue;
      /* **荒地 / 水域那类伪头衔不画成势力名** ✓（2026-10-13）
       *   ⚠ 这里原来只靠上面那条 hideLabel ✗ —— 而 hideLabel 只标在**最细层**的
       *     荒地上，换个视图层（cTier 跟着视图走）就漏 ✓
       *   所以补一道**按键名**的判据：CK3 一律不标，别的游戏看「名称」开关 ✓
       *   （跟 drawLabels 里那条用同一个函数 ✓ 口径一致 ✓）*/
      if (!info.allowed) continue;
      if (!incUnpainted && !_paintedPid) continue;
      const key = info.key;
      // **原版名是空的不等于这块地没名字** ✗ —— 涂过的地名字在标签层 ✓
      // （导入带 clearEraNames 的配色时，原版国名被整层清掉；以前这里一律 continue
      //   → 涂过的地也一起跳过 → 全图一个国名都画不出来
      //   = 用户报的「导入涂色方案之后显示不出国家名称」✓）
      if (key == null && !_paintedPid) continue;
      let k0 = key;
      if (_paintedPid) {
        // 涂过的省：身份按手绘层算（名字取标记名、颜色取涂色）✓
        // 名字就查**这一格自己的**标记编号 → 名字 ✓（不再去头衔级的账上找 ✗）
        const nm2 = displayedLabel(pid, tid);
        if (!nm2) continue;
        const c2 = stableColor(pid, tid);
        if (!c2) continue;
        k0 = nm2 + "|" + c2[0] + "," + c2[1] + "," + c2[2];
      }
      ident.set(pid, k0);
      parent[pid] = pid;            // union-find 初始化并进这一遍（原来又扫了一遍 ✗）
      painted.push(pid);
    }
  } else {
    for (let pid = 1; pid < n; pid++) {
      if (paint[pid * 4 + 3] > 0) {
        parent[pid] = pid;
        painted.push(pid);
        isPainted[pid] = 1;
      }
    }
  }
  // 一块都没涂：没有色块可分（**这句必须在"建 isPainted 表"之前** ✓
  // —— 不然 4 万格的空图也要白扫一遍数组）
  if (!painted.length) return;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const p = parent[x]; parent[x] = r; x = p; }
    return r;
  };

  const labels = state.provLabel;
  // **取名字要用对层** ✓
  // 涂过的省：名字（头衔级标签）是记在**涂色那一层**的头衔上的（通常是省份层），
  //   所以必须用 editTier() 取；用 cTier（= 年份层）会取到原版那一层，
  //   而原版年份层的名字可能已按 clearEraNames 清空 → 名字变空 → 整块没标签 ✗
  // 全图重分组（剧本层，all=true）：没涂的省用 cTier = 那一层的原版国家 ✓
  //   ✗ **这里千万别跟着粒度走**：粒度=省份 时若把"没涂过的地"也按省份算身份，
  //     一整片同色的海（没名字 ✗）会并成一个几百万像素的巨块 →
  //     名字取到海边第一个省名（"百慕大"），字号按整片海算 → 糊满全屏 ✗✗
  // 只画涂过的块（细层，all=false）：涂过的用 editTier()（名字记在涂色那一层 ✓）
  const nameTidOf = (pid) => {
    const p4 = pid * 4;
    const et = (typeof editTier === 'function') ? editTier() : cTier;
    const useEt = (paint && paint[p4 + 3] > 0);
    return titleAt(pid, useEt ? et : cTier);
  };
  // 涂色实体的身份串：**有名字按名字**（颜色不参与分家），没名字才按颜色。
  const paintKeyOf = (pid) => {
    // **同显示色 + 同显示名/标签**才算一族 ✓
    // （没涂过的地按它的原版色 + 原名算 ✓ —— 不能只看涂色层的颜色 ✗）
    const tid = nameTidOf(pid);
    const p4 = pid * 4;
    const painted = !!(paint && paint[p4 + 3] > 0);
    const lab = labels ? (labels[pid] | 0) : -1;
    // 名字统一走 displayedLabel ✓（地块级标签 → 头衔级标签 → 改名 → 原版名 ✓）
    // 以前涂过的才认标记名、没涂的只认原版名 ✗ → 导入的工程（头衔级标签）两边都对不上 ✗
    const nm = String(displayedLabel(pid, tid) || '');
    const c = stableColor(pid, tid) || [150, 150, 150];
    // 身份里**只放显示出来的名字** ✓ —— 不能再塞标签编号 ✗
    // （未涂的 PRC 地是 "…|中华苏维埃共和国"、涂过的是 "…|中华苏维埃共和国|L11" ✗
    //   → 同色同名的两块地被判成两族 ✗）
    return "D|" + c[0] + "," + c[1] + "," + c[2] + "|" + nm;
  };
  // 并查集初始化 —— **两种模式都要** ✓
  // （这句原来只写在 all 分支里 ✗ → 涂色模式 parent 全是 0 ✗
  //   → find() 对全图都返回同一个根 ✗ → 整张图并成几个幽灵连通域 ✗）
  for (let q = 1; q < n; q++) parent[q] = q;

  /** 没涂过的地在这个模式下的身份：**一个永远撞不上的哨兵** ✓
   *
   *  细层（all=false）只画玩家涂出来的色块 ✓，所以"没涂过"的地本身没有身份 ——
   *  但它**照样要参与并查集**：陕北那块没被涂过的地方也要能并进自己那一族 ✓
   *  （见下面 identOfPid 的说明 ✓）
   *
   *  以前这里是"每格都调 paintKeyOf()"—— 4 万格里绝大多数根本没涂过，
   *  却每格拼一个 `D|r,g,b|名字` 的字符串（还要读三处状态 ✗），
   *  拼出来立刻就因为 keepRoot 被丢掉 ✓ 纯白烧的 ✓ */
  const NO_IDENT = '\u0000';      // 真实身份串一律以 'D|' / 名字开头，撞不上 ✓

  // 身份：**显示色 + 显示名/标签**（带缓存 ✗ 每个邻居都重算等于白算）
  const _idCache = new Map();
  const identOfPid = (q) => {
    if (!all && !isPainted[q]) return NO_IDENT;   // 细层：没涂过的地不比身份（省掉 4 万次拼串 ✓）
    let v = _idCache.get(q);
    if (v === undefined) { v = paintKeyOf(q); _idCache.set(q, v); }
    return v;
  };
  // **全图每个省都参与**（以前只遍历涂过的 ✗ → 没涂过的地永远并不到族里 ✗）
  for (let pid = 1; pid < n; pid++) {
    const _ownIdent = all ? ident.get(pid) : null;        // 每个邻居都取一次等于白算 ✗
    const _ownPidIdent = all ? null : identOfPid(pid);
    /* **pid 的根一进循环就取一次** ✓ —— 以前每个邻居都 find(pid) 一遍（4 万格 × 4 邻 = 16 万次 ✗）
     * 并完之后 `parent[ra] = rb`，pid 的根就变成 rb ✓ 后面接着用这个 ra 就行 ✓ */
    let ra = -1;
    for (let k = offsets[pid], e = offsets[pid + 1]; k < e; k++) {
      const nb = neighbors[k];
      if (nb <= 0) continue;
      if (all) {
        if (ident.get(nb) !== _ownIdent) continue;
        if (ra < 0) ra = find(pid);
        const rb0 = find(nb);
        if (ra !== rb0) { parent[ra] = rb0; ra = rb0; }
        continue;
      }
      // **同显示色 + 同显示名/标签**才并 ✓
      // 没涂过的地按它的原版色 + 原名算 ✓，而且**没涂过的邻居也要能并进来** ✓
      // （陕北那块没被涂过 ✗，只按涂色层判就永远并不到这一族里 ✗）
      if (identOfPid(nb) !== _ownPidIdent) continue;
      if (ra < 0) ra = find(pid);
      const rb = find(nb);
      if (ra !== rb) { parent[ra] = rb; ra = rb; }
    }
  }

  const groups = new Map();
  // **剧本层（all）里全图每个省都要有组** ✓ —— 没涂过的那一片也得有个组，
  // 它跟涂出来的同色同名地块并起来之后，才是完整的那一族 ✓
  //
  // **细层（非剧本视图）反过来：只编玩家涂出来的那些片** ✓
  // 细层的「填色 · 地名」画的是玩家自己的色块名，没涂过的地方不该有名字 ✗
  // （以前两种情形共用这一遍：只要涂过一笔，没涂的地方就顶着原版国名/地名冒出来
  //   —— EU4 涂一个省 → 355 个原版国名、CK3 → 1.1 万个 ✗）
  // 判定按**并查集的根**：pids 里含"涂过的那块"的组才算
  //（被并进来的没涂邻居跟着这一族一起留 ✓）
  const keepRoot = all ? null : new Set();
  if (keepRoot) for (const pid of painted) keepRoot.add(find(pid));
  for (let pid = 1; pid < n; pid++) {
    const root = find(pid);
    if (keepRoot && !keepRoot.has(root)) continue;
    let g = groups.get(root);
    if (!g) {
      const p4 = pid * 4;
      g = {
        x: 0, y: 0, w: 0,
        pids: [],
        label: labels ? labels[pid] : -1,
        // 显示色（涂过用涂色、没涂用原版 ✓）—— 不再直接读涂色层 ✗
        rgb: stableColor(pid, titleAt(pid, cTier)) || [255, 255, 255],
        key: all ? ident.get(pid)
                 : paintKeyOf(pid),
      };
      groups.set(root, g);
    }
    g.pids.push(pid);
    // **细层（all=false）：只有玩家涂过的地才计入位置 / 面积 / 跨度** ✓
    //   没涂过的邻居仍然"跟着这一族活着"（陕北那块该并还是并 ✓），但**不许撑大这一族** ✗
    //   以前它们全都算进去 ✗ → 挑的颜色+标签一旦撞上某个 1789 的 tag，
    //   整块 1789 的地就把中心和面积全带跑了 → 名字显示成整个国家的大小和位置 ✗
    //   （用户报的 bug：不跟着涂色实时变）
    if (!all && paint[pid * 4 + 3] === 0) continue;
    const w = pos[pid * 3 + 2] || 1;
    // 顺便记下这一片的横向跨度 ✓（字号要按它限一下，免得名字长到跑出版图 ✗）
    const _px = pos[pid * 3];
    if (g.minx === undefined || _px < g.minx) g.minx = _px;
    if (g.maxx === undefined || _px > g.maxx) g.maxx = _px;
    g.x += pos[pid * 3] * w;
    g.y += pos[pid * 3 + 1] * w;
    g.w += w;
  }

  /* ---- 每一坨连通域各自出一个名字 ------------------------------------------
   * 同色同标记可能铺成好几块互不相连的地方（本土 + 海外省 + 一堆沿海小岛）——
   * **每一块都标一个** ✓（用户定的规矩：不再挑"哪一片才算老家"）
   *
   * 挑"老家"那一整套（玩家定都 / 数据首都 / 本土）已经整个拿掉了：
   * 那时候为了决定"名字该落在哪一片"写了一百多行，还得跟涂色、改名、
   * 导入文件的清名打配合 ✗ —— 现在每个连通域各标各的，那些规矩一件都不需要 ✓
   *
   * 字号是**按这一坨自己的面积**给的（见 labels 那边），所以小岛的名字自然小、
   * 够不上门槛就不画 ✓ —— 这是原先"只留最大那片"想解决的问题，
   * 现在交给门槛管，不用再牺牲别的连通域 ✓
   */
  const out = [];
  for (const g of groups.values()) {
    if (g.w <= 0) continue;
    // 一坨里的标记和颜色都是统一的（不同标记/不同颜色不会被并到一起）
    // 名字统一取**显示出来的那个名字** ✓（涂过 → 玩家的标签名；没涂 → 原版名 ✓）
    // 不再区分"涂没涂" ✗（以前只认涂色标签，没涂过的族一律没名字 ✗）
    const _p0n = g.pids[0];
    let name = String(displayedLabel(_p0n, nameTidOf(_p0n)) || '');
    // 旧包共享水节点的**类名**（"海洋"/"湖泊"那种）不是具体名 ✗ 别当国家名画 ✓
    //（具体的片名 / 荒地名跟普通头衔一样可以进名册 ✓ 那条按键名的特判已删 ✓）
    if (name === '湖泊' || name === '海洋' || name === '河流' || name === '不可通行') name = '';
    if (all && g.key) name = g.key.split('|')[0];
    // 落点 = **这一坨连通域自己**的几何中心与像素数 ✓
    //   以前取的是"挑中的那一片"（首都/本土）—— 于是吞并全国之后，名字还只有老家那么大 ✗
    //   现在每坨各算各的：大块的名字就大、小岛的就小 ✓
    out.push({ name, x: g.x / g.w, y: g.y / g.w, area: g.w, rgb: g.rgb,
               w: Math.max(0, (g.maxx || 0) - (g.minx || 0)),   // 横向跨度 ✓（限字号用 ✓）
               tid: nameTidOf(_p0n),   // 这一坨代表哪个头衔 ✓（图例里改名要写回它 ✓）
               pids: g.pids });        // 图例算"这一族涂出来的面积"要用（legendEntries）
  }
  out.sort((a, b) => b.area - a.area);   // 大的先摆
  /* **每一族最多留 N 个名字** ✓（设置页「每国名字上限」，0 / 拉到底 = 不限）——
   *
   * ⚠ **是"同一个国家"的，不是"全世界"的** ✗（这里我理解错过一次 ✓）：
   *   用户要的是"英国本土 + 它的殖民地，加起来最多显示 N 个" ✓
   *   我第一版写成了全局取前 N ✓ → 一屏只剩十几个国名、别的国家全没名字 ✗
   *   （EU4 的 1444 有 1863 坨，被砍到 12 ✓ 用户报的"国名很多不显示"就是这个 ✓）
   *
   * 分组按**显示色 + 名字**（跟上面分族同一个身份 ✓ 同色不同国也不会串 ✗）。
   * `out` 已经按面积降序 ✓ 所以每组自然就是"留最大的那 N 坨" ✓ ——
   * 本土 + 最大的几块殖民地会留下，零碎小岛被截掉 ✓（它们本来也够不上字号门槛 ✓）
   */
  const _cap = labelMaxValue();          // 0 = 拉到最右「无上限」→ 不截 ✓
  if (_cap > 0) {
    const _per = new Map();              // 族 → 已经留了几个
    const _kept = [];
    for (const b of out) {
      const k = (b.rgb ? b.rgb.join(',') : '') + '|' + (b.name || '');
      const n = _per.get(k) || 0;
      if (n >= _cap) continue;           // 这一族够了 ✓ 后面的（更小的）都不要 ✓
      _per.set(k, n + 1);
      _kept.push(b);
    }
    out.length = 0;
    for (const b of _kept) out.push(b);
  }
  state.paintBlocks = out;

  /* 图例列表**不在这儿刷** ✗ —— 这里是"涂一笔就重新分组"的地方 ✓
   * 每次涂色都重建一遍图例 DOM 是白费力气 ✓（而且面板开着的时候你根本涂不了地图 ✓）
   * 按用户的主意：**列表只在「点开图例 / 导出」时才更新** ✓
   *   · 手机版：切到「导出图例」那一页时刷一遍 ✓（见 mobile/mobile_js.txt 的 showTab）
   *   · 导出：maybeDrawLegend 开头会把欠着的色块重算补上 ✓ 用的就是同一份新数据 ✓
   */
}

/**
 * **重建边界图并推给渲染器** ✓（CPU 按省份算 ✓ 见 buildBorderEdges / buildBorderDepth 那两段说明）
 *
 * 什么时候得重算：涂色、清除、换视图层、换粒度 —— 凡是"身份"会变的都算 ✓
 * ⚠ 但拖动涂色是**每帧**画一笔 ✗ 每帧重算一次 17ms 会卡 ✓
 *   → 加 150ms **防抖** ✓（松手之后算一次就够了 ✓）
 *
 * @param {boolean} now true = 立刻算（开图那一次 ✓）
 */
/** 上一次算的时候"身份相关的输入"长什么样 —— 没变就别重算 ✓ */
/** 去掉"涂色进度"的核心签名 —— 跟 borderFieldSig 只差它时，说明这次是涂色触发的 ✓ */
let borderFieldSigCore = '';
/**
 * **算那张粗筛位图并推给渲染器** ✓
 *
 * ⚠ 它**只在加载地图时跑一次** ✗ 之后换层 / 换粒度 / 涂色**都不再调用** ✓
 *   原因（用户点的）：粗筛只需要回答"这一带将来会不会出边界" ✗
 *     而**任何层的边界都落在省界上** ✓ 省界是纯几何、加载完就定了 ✓
 *     → 所以这张图跟"当前层 / 有没有涂色"**完全无关** ✓
 *   以前把它当"当前层级的边界图"，于是每次涂色都要重算一遍 ✗
 *     那 1 秒的卡顿（用户报过）就是它 ✓ 现在彻底没有了 ✓
 */
function refreshBorderField() {
  if (!renderer || !renderer.setBorderDepth) return;
  /* 手机上不生成（显存吃紧 ✓ 退回射线：画得对，只是慢一点 ✓）*/
  const _smallScreen = (typeof window !== 'undefined') && window.innerWidth
    && window.innerWidth <= 900;
  if (_smallScreen) return;
  const bd = buildBorderDepth();
  if (!bd) {
    console.log('[粗筛] 这张图不算（分块 / 缺数据）→ 全走射线 ✓');
    if (window.PDXLOG) window.PDXLOG.event('粗筛', '不算 → 走射线');
    return;
  }
  let _on = 0;
  for (let i = 0; i < bd.bits.length; i++) _on += bd.bits[i] ? 1 : 0;
  const msg = bd.w + '×' + bd.h + ' · 位图 ' + (bd.bits.length / 1048576).toFixed(1)
    + 'MB · ' + bd.ms.toFixed(0) + 'ms';
  console.log('[粗筛] ' + msg);
  if (window.PDXLOG) window.PDXLOG.event('粗筛', msg);
  renderer.setBorderDepth(bd.bits, bd.bw, bd.h);
}


/**
 * **边界粗筛位图** —— 加载时算一次，之后永不重算 ✓
 *
 * 用户点的三件事，全在这一个函数里兑现：
 *   ① **上级不新增边界** → 任何层的边界都落在**省界**上 ✓
 *      所以这张图只跟"省份图的形状"有关 ✓ 跟当前层、跟涂色**完全无关** ✓
 *   ② **不需要距离** → 只要 1 位："这一格值不值得看一眼" ✓
 *   ③ **加载时顺便算完** → 换层 / 换粒度 / 涂色都**不再重算** ✓
 *      （以前每次涂色都要重算一遍，那 1 秒的卡顿就是它 ✓）
 *
 * 做法（用户说的"一个最简单的程序"✓）：
 *   标轮廓：相邻两个**像素**的省份 id 不同 → 这一格在省界上 ✓
 *   膨胀 2 格：粗线（最大线宽 3 格 ⇒ 半宽 1.5 格）也要覆盖到 ✓
 *   打包：8 格 1 字节 ✓ EU4 上 1.4MB ✓
 *
 * ⚠ **它只管排除** ✗ —— 圈内具体画不画、画多粗，由着色器**现算**（省份归属是现成的 ✓）
 *   所以它保守一点没关系：多留几格只是多跑几趟射线 ✓ **线不会画错** ✓
 *
 * @returns {{bits: Uint8Array, bw: number, w, h, ms}|null}
 */
function buildBorderDepth(opts) {
  const meta = state.meta;
  const pids = state.provinceIds;
  if (!meta || !pids) return null;
  const W = meta.mapWidth, H = meta.mapHeight;
  if (pids.length !== W * H) return null;              // 分块图不算 ✓
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  /* ① 标轮廓（省界上的**像素** ✓）—— **一遍全图，边标边写位** ✓
   *   ⚠ 之前是"标进 near 数组 → 膨胀 → 再扫一遍全图打包" ✗ 那是**两遍全图** ✓
   *     现在位图直接当标记用 ✗ 膨胀时**在位图上翻位** ✓ → 只剩这一遍全图 ✓
   *   💡 省下的那遍是 1153 万次（EU4）✗ 大图上是上亿次 ✓ 这是最实在的一刀 ✓
   *   ⚠ 缝的两侧**都要标** ✗（跟原来一样 ✓）不然膨胀出来的带子偏一格 ✓ */
  const bw = (W + 7) >> 3;
  const bits = new Uint8Array(bw * H);
  const _get = (x, y) => (bits[y * bw + (x >> 3)] >> (x & 7)) & 1;
  const _set = (x, y) => { bits[y * bw + (x >> 3)] |= (1 << (x & 7)); };
  let front = [];                       // 本轮要往外扩的格（只存"新点亮"的 ✓）
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x, p = pids[i];
      if (p <= 0) continue;
      /* 右边 / 下边是别的省 → 这一格和对面那一格都在缝上 ✓ */
      if (x + 1 < W && pids[i + 1] !== p) {
        if (!_get(x, y)) { _set(x, y); front.push(i); }
        if (!_get(x + 1, y)) { _set(x + 1, y); front.push(i + 1); }
      }
      if (y + 1 < H && pids[i + W] !== p) {
        if (!_get(x, y)) { _set(x, y); front.push(i); }
        if (!_get(x, y + 1)) { _set(x, y + 1); front.push(i + W); }
      }
    }
  }
  /* ② 膨胀 2 格：**只从上一轮新点亮的那一圈往外扩** ✗ 不扫全图 ✓
   *   ⚠ 每轮只看 newList（本轮刚点亮的 ✓）—— 不然同一轮里会连锁扩散出去 ✓ */
  for (let pass = 0; pass < 2; pass++) {
    const nextList = [];
    for (let n = 0; n < front.length; n++) {
      const i = front[n];
      const y = (i / W) | 0, x = i - y * W;
      if (x + 1 < W && !_get(x + 1, y)) { _set(x + 1, y); nextList.push(i + 1); }
      if (x > 0 && !_get(x - 1, y)) { _set(x - 1, y); nextList.push(i - 1); }
      if (y + 1 < H && !_get(x, y + 1)) { _set(x, y + 1); nextList.push(i + W); }
      if (y > 0 && !_get(x, y - 1)) { _set(x, y - 1); nextList.push(i - W); }
    }
    front = nextList;
  }
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { bits, bw, w: W, h: H, ms };
}

/**
 * 画地名。两套名字各由自己的开关管：
 *   state.showLabelsTitle —— 原有地名（头衔 / 地区 / 省份名）
 *   state.showLabelsPaint —— 玩家地名（自己涂出来的色块名）
 * 两个都开就合并成一张名单，一次画完（同一个画布，不能分两次画）。
 */
/**
 * 「更新势力名」：清空**所有势力名**，按"玩家现在看到的颜色"重新画一遍。
 *
 * 画完之后这些势力名就**当原版势力名用** ✓ —— 该受的开关（势力·名称 / 地区·名称）
 * 照受，换层级、换地图也是同一套规矩，没有额外的特殊状态 ✓。
 */
function retintCountryLabels() {
  // ① 清空**所有**势力名（连贴图缓存一起清 ✓）
  labels.clear();
  // ② 直接复用现成那套（泛化成"看全图"）——坐标/面积一律不自己算 ✓
  //    unpainted=true：**允许没涂色的省也参与**（这是「更新国名」的本意：
  //    按全图当前显示重画国名，原版那套名字也要在 ✓）
  rebuildPaintBlocks(true, true);
  const meta = state.meta;
  const fadeCountry = !(meta.tiers && meta.tiers[0] === 'e');
  const nEra = (meta.eraDates && meta.eraDates.length) || 0;
  const tier = countryTier();        // 同上 ✓
  const out = [];
  for (const b of (state.paintBlocks || [])) {
    if (!b.name || !(b.area > 0)) continue;
    out.push({ name: b.name, x: b.x, y: b.y, area: b.area, w: b.w, tier, layer: 1,
               fade: fadeCountry,
               color: b.rgb ? rgbToHex(b.rgb) : undefined });
  }
  state.countryNameOverride = out;
  labelDirty = true;
  renderHoverCard(state.hover.pid);
  return out.length;
}

/* ================================================================ 地名的取点
 *
 * **一个连通域一个标** ✓（2026-10-16 用户定的 ✓ —— 跟势力名**同一套**口径 ✓）
 *
 * 以前地名是"**一个头衔一个标**"✗：坐标直接取 `titles.lx/ly`
 * （构建期算的**最大连通域**的重心 ✓ 见 build_data.py 的 centroids_for_titles）。
 * 于是跨不相连区域的头衔（CK3 王国/公爵领的飞地、EU4 的岛群、跨 180° 经线的那片海）
 * **只会出一个名** ✗ —— 那个名落在最大的那块上，别的块上什么都没有。
 *
 * 现在照 `rebuildPaintBlocks`（势力名那条 ✓）抄：
 *   按地块邻接做并查集 → **每个连通域一个点** ✓ → 再按头衔截断（「地名上限」✓）
 *
 * 🔴 **顺带退役了「跨接缝」那整套** ✗✗（2026-10-16 用户定的 ✓）：
 *   `build_adjacency` 只连**图内 4 邻域** ✗ 没有跨左右边界的边 ✓
 *   → 跨 180° 经线的那片海在邻接图上**本来就是两块** ✓
 *   → 这里自然就"左右各出一枚"（而且分几块就出几个 ✓ 不止两个 ✓）——
 *     于是 `titles.wrapLabel` / `buildWrapLabelPoints()` / 圆均值那套**全都不需要了** ✓
 *     （它们本来就是在给"全体像素求几何中心 → 名字落中部"打补丁 ✓ 现在那个问题没有了 ✓）
 */

/** 把"每块地一个身份"打成**连通域**（并查集 ✓ 跟 `rebuildPaintBlocks` 同一套口径）
 *
 *  @param {Int32Array} ident  pid → 身份号（**相同身份 + 相邻**才算一块 ✓；
 *                             `-1` = 这块地不参与 —— 由调用方先排掉 ✓）
 *  @param {number} n          numProvinces
 *  @returns {Array<{id:number,x:number,y:number,area:number}>}
 *           每个连通域一项；`id` 就是身份号；`x/y` 是**像素加权质心** ✓
 *
 *  🔴 **x 是普通加权平均，不是圆均值** ✗✗（2026-10-16 用户定的 ✓）——
 *     `build_adjacency` 只连**图内 4 邻域**、没有跨左右边界的边 ✓
 *     → 跨 180° 经线的那片海在邻接图上**本来就是两块** ✓
 *      每一块自己都落在它那半边 ✓ 于是"把 x 当角度"那套（`cos/sin/atan2`）
 *      连同 `wrapLabel` / 左右各一枚 **整套退役** ✓
 */
function groupComponents(ident, n) {
  const out = [];
  const adj = state.adjacency, pos = state.provPos;
  if (!adj || !pos || !n) return out;
  const offsets = new Uint32Array(adj.buffer, adj.byteOffset, n + 1);
  const neighbors = new Uint16Array(adj.buffer, adj.byteOffset + (n + 1) * 4);

  const parent = new Int32Array(n);
  for (let pid = 1; pid < n; pid++) parent[pid] = pid;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const p = parent[x]; parent[x] = r; x = p; }
    return r;
  };
  for (let pid = 1; pid < n; pid++) {
    const id = ident[pid];
    if (id < 0) continue;
    for (let k = offsets[pid], e = offsets[pid + 1]; k < e; k++) {
      const nb = neighbors[k];
      if (nb <= 0 || nb >= n || ident[nb] !== id) continue;
      const ra = find(pid), rb = find(nb);
      if (ra !== rb) parent[ra] = rb;
    }
  }

  const acc = new Map();          // 根 → { id, x, y, area }
  for (let pid = 1; pid < n; pid++) {
    const id = ident[pid];
    if (id < 0) continue;
    const r = find(pid);
    let a = acc.get(r);
    if (!a) { a = { id, x: 0, y: 0, area: 0 }; acc.set(r, a); }
    const w = pos[pid * 3 + 2] || 1;
    a.x += (pos[pid * 3] || 0) * w;
    a.y += (pos[pid * 3 + 1] || 0) * w;
    a.area += w;
  }
  for (const a of acc.values()) {
    if (!(a.area > 0)) continue;
    out.push({ id: a.id, x: a.x / a.area, y: a.y / a.area, area: a.area });
  }
  return out;
}


/** 某一层上**所有头衔的连通域点**（未截断 ✓ 全局按面积降序 ✓）
 *
 *  @param {number} tier
 *  @returns {Array<{tid:number,x:number,y:number,area:number,tier:number}>}
 *
 *  ⚠ 点的 `name` **不在这儿存** ✗ —— 改名要实时生效，名字留到每帧取用时现读
 *    （见 `placePointsFor` ✓ 这样改个名不用把这趟并查集重跑一遍 ✓）
 *  ⚠ 料跟 `rebuildPaintBlocks` 一模一样 ✓：`state.adjacency` / `state.provPos` /
 *    `titleAt(pid, tier)` —— **数据格式一个字节都不动** ✓
 */
function buildPlaceComponents(tier) {
  const idx = tier | 0;
  const m = state.meta;
  const T = state.titles;
  const n = (m && m.numProvinces) | 0;
  if (!state._placeCache) state._placeCache = new Map();
  const key = idx + '|' + n + '|' + ((T && T.keys && T.keys.length) | 0);
  const hit = state._placeCache.get(key);
  if (hit) return hit;

  const out = [];
  if (state.adjacency && state.provPos && T && n) {
    const names = T.names || [];
    const hide = T.hideLabel;
    /* 身份 = 这一层这一格属于哪个头衔 ✓
     * 两道闸跟旧的 `byTier` 收人判据 + `pointsFor` 的 `!names[i]` **等价** ✓ */
    const ident = new Int32Array(n).fill(-1);
    for (let pid = 1; pid < n; pid++) {
      const t = titleAt(pid, idx);
      if (t == null || t < 0 || t === NO_TITLE || t >= names.length) continue;
      if (!names[t]) continue;         // 没名字的不出标 ✓
      if (hide && hide[t]) continue;   // 标了"不上地名"的（海/湖/河/山那类伪头衔）✓
      ident[pid] = t;
    }
    for (const c of groupComponents(ident, n)) {
      out.push({ tid: c.id, x: c.x, y: c.y, area: c.area, tier: idx });
    }
    // **大的在前** ✓ —— `placePointsFor` 的"每个头衔留最大的 N 个"直接靠这个顺序 ✓
    out.sort((a, b) => b.area - a.area);
  }
  state._placeCache.set(key, out);
  return out;
}

/** 某一层**真正要画**的地名点：按「地名上限」**按头衔**截断 ✓
 *
 *  ⚠ 每帧都会调 ✓ 所以这里只做两件便宜事：
 *    ① 上限 / 层没变就直接返回上次那份（**并查集不重跑** ✓）
 *    ② 把 `name` **现读一遍**（改名实时生效 ✓ 也不用重建连通域 ✓）
 *  （以前 `labels.pointsFor()` 每帧新建 m 个对象 ✗ 现在连对象都复用 ✓）
 */
function placePointsFor(tier) {
  const all = buildPlaceComponents(tier);
  const cap = labelPlaceMaxValue();          // 0 = 不封顶
  if (state._placeCapped !== all || state._placeCapUsed !== cap) {
    let kept = all;
    if (cap > 0) {
      const per = new Map();                 // 头衔 → 这个头衔已经留了几个
      kept = [];
      for (const p of all) {                 // all 已按面积降序 ✓ 留下的自然是最大的那几块 ✓
        const c = per.get(p.tid) || 0;
        if (c >= cap) continue;
        per.set(p.tid, c + 1);
        kept.push(p);
      }
    }
    state._placeCapped = all;
    state._placeCapUsed = cap;
    state._placeKept = kept;
  }
  const kept = state._placeKept || all;
  const names = (state.titles && state.titles.names) || [];
  for (const p of kept) p.name = names[p.tid] || '';
  return kept;
}

/** **给荒地 / 水域节点补上标签位置** ✓（2026-10-13 用户要求 ✓）
 *
 *  这两类节点在缓存里**有名字、没有 lx/ly、也没有 area** ——
 *  于是 LabelLayer 压根不收它们（它要求 lx/ly/area 三个都有 ✓）。
 *  名字本身是齐的：荒地名是"热那亚""波尔多"这种**真地名**、
 *  水域是"海洋 / 湖泊 / 河流 / 不可通行海域"✓（用户说的"各游戏剧本里都有"就是它们 ✓）
 *
 *  算法：拿**最细那一层**把省份按头衔归堆，用**像素数当权重**求质心 ✓
 *  （跟构建时给真头衔算位置同一套口径，只是这里现算 —— 各省质心在 provPos 里 ✓）
 *  area 就用这一堆的像素总数（字号门槛看它 ✓）。
 *
 *  ⚠ **CK3 按规则不标** ✗（用户 2026-10-13 定的：CK3 不给荒地和水域标名字，
 *    别的游戏标 ✓）—— CK3 直接不算，LabelLayer 也就收不到它们 ✓
 *    配套：那两个「名称」开关在 CK3 里是藏起来的（见 syncLayerSwitches ✓）
 *
 *  🔴 2026-10-16 用户把"**名字显示方案**"点全之后（见 `NAME_POLICY` ✓）：
 *    CK3 唯一要出标的是**河流** ✓（海 / 湖 / 荒地全不出 ✓）
 *    → 这儿不能再整块 `return` ✗：CK3 走**只认河流**那条窄路（`_ck3` 那个分支 ✓）
 *      别的游戏照旧全算 ✓（谁出谁不出由 `drawLabels` 按那张表判 ✓）
 */
function buildPseudoLabelPositions() {
  const t = state.titles, pp = state.provPos, meta = state.meta || {};
  if (!t || !pp) return;
  const _ck3onlyRiver = String(meta.game) === 'ck3';   // CK3：只给河流补位置 ✓
  const n = meta.numProvinces | 0;
  const tiers = (meta.tiers && meta.tiers.length) || 5;
  const fine = tiers - 1;
  const nNames = (t.names || []).length;

  // 要找的两类：荒地（meta.wasteland）+ 水域那四个伪头衔
  // ⚠ 键现在是**每层一片**（`#sea_pr_57` 那种 ✗ 精确查 `'#sea'` 一个都命不中 ✓）
  //   → 分**两条路**：
  //     ① **每层一片的那种片**（`#sea_pr_57` / `#lake_ar_3` ✓ 见 isTierPieceKey）
  //        —— 2026-10-14 起**走普通头衔那套**（用户要求："水域和其他地块一样，
  //           仅仅是不能填色，其他绘制规则什么的都一样"✓）：
  //           位置 / 折线全写进 `titles` 那几本数组 ✓ LabelLayer 当普通头衔
  //           收进 byTier ✓ 名字 / 缩放门槛 / 那两个「名称」开关全跟地名一条路 ✓
  //           ⚠ 这就是"一片一个标"的来源：**一个 tid 就是一片** ✓（不再另发一组点 ✓）
  //     ② **老包那个共享节点**（整个世界的海共用一个 `#sea` ✗）+ 最细层逐块的荒地
  //        （`wl_<地块号>` ✓）—— 它们**不是片**（一个 tid 底下几百个不同名字 ✗）
  //        → 照旧只补一个位置 ✓ 名字交给 buildSeaLabelPoints 按真名表出 ✓
  //          （那片共享的海在图上还是只有一个"海洋"标 ✓ 跟改造前一模一样 ✓）
  const K = t.keys || [];
  const want = new Set(_ck3onlyRiver ? [] : (meta.wasteland || []));
  for (const k of (_ck3onlyRiver ? ['#river'] : ['#sea', '#lake', '#river', '#impassable_sea', '#impassable'])) {
    for (const i of titleIndicesByPrefix(k)) {
      if (isTierPieceKey(K[i])) continue;
      want.add(i);
    }
  }

  /* **一个 tid 一个点，但这个点取它"最大那一块"的质心** ✓（2026-10-16 用户定的 ✓）
   *   ⚠ 数组一个 tid 只能存**一个**坐标 ✗ —— 所以只能挑一块当代表：
   *     挑**最大**的那块 ✓（`flyTo` / 搜索落到那一块里，不会落地图中部 ✓）
   *   ⚠ 圆均值那套退了 ✗：邻接表只连图内 4 邻域、没有跨左右边界的边 →
   *     跨 180° 经线的海本来就是**两块** ✓ 各自都落在自己那半边 ✓ */
  const cAcc = new Map();          // tid → { 最大那块的 x/y + 总面积 }
  {
    const ident = new Int32Array(n).fill(-1);
    for (let pid = 1; pid < n; pid++) {
      const tid = titleAt(pid, fine);
      if (tid == null || tid === NO_TITLE || !want.has(tid)) continue;
      ident[pid] = tid;
    }
    for (const c of groupComponents(ident, n)) {
      let a = cAcc.get(c.id);
      if (!a) { a = { x: 0, y: 0, best: -1, total: 0 }; cAcc.set(c.id, a); }
      if (c.area > a.best) { a.best = c.area; a.x = c.x; a.y = c.y; }
      a.total += c.area;
    }
  }

  /* ② **水域：每层一片的那种片** ✓（`#sea_pr_57` / `#lake_ar_3` ✓ 见 isTierPieceKey）
   *   ⚠ 按**层**扫 ✗ 不能只扫最细层（片是**每层各有一份**的 ✓
   *     最细层的 tid 跟粗层的 tid 不是一个节点 ✓）
   *   ⚠ 片名是**类名**的（"海洋"/"湖泊" ✓ 见 PSEUDO_CATEGORY_NAMES）
   *     **不给位置** ✗ —— 那一层的水名表里这一片根本没名字 ✓
   *     给它位置 = 地图上凭空多出一个「海洋」大标 ✓（用户 2026-10-13 报过去掉过一次 ✓）
   *     —— 跟普通头衔那边的 `hideLabel` 一个意思：**没名字就不该出标** ✓ */
  const wAcc = new Map();          // tid → { 最大那块的 x/y + 总面积 }
  for (let ti = 0; ti < tiers; ti++) {
    const ident = new Int32Array(n).fill(-1);
    for (let pid = 1; pid < n; pid++) {
      const tid = titleAt(pid, ti);
      if (tid == null || tid === NO_TITLE) continue;
      const key = String(K[tid] || '');
      if (!isTierPieceKey(key) || !isWaterKey(key)) continue;
      /* CK3 只补**河流**的片 ✓（别的按方案不出标 ✓ 连位置都不必算 ✓ 省内存 ✓）*/
      if (_ck3onlyRiver && !keyStarts(key, '#river')) continue;
      const nm = String((t.names && t.names[tid]) || '');
      if (!nm || isPseudoCategoryName(nm)) continue;
      ident[pid] = tid;
    }
    for (const c of groupComponents(ident, n)) {
      let a = wAcc.get(c.id);
      if (!a) { a = { x: 0, y: 0, best: -1, total: 0 }; wAcc.set(c.id, a); }
      if (c.area > a.best) { a.best = c.area; a.x = c.x; a.y = c.y; }
      a.total += c.area;
    }
  }
  if (!cAcc.size && !wAcc.size) return;
  if (!t.lx || t.lx.length < nNames) t.lx = new Array(nNames).fill(null);
  if (!t.ly || t.ly.length < nNames) t.ly = new Array(nNames).fill(null);
  if (!t.area) t.area = (t.provCount || []).map((x) => x * 3300);
  if (!t.blockArea) t.blockArea = t.area;
  let done = 0;
  for (const [tid, a] of cAcc) {
    if (!(a.total > 0)) continue;
    t.lx[tid] = Math.round(a.x);       // **最大那块**的质心 ✓（不再是圆均值 ✗）
    t.ly[tid] = Math.round(a.y);
    t.area[tid] = a.total;             // 面积仍是**总和** ✓（字号门槛看它 ✓）
    t.blockArea[tid] = a.total;
    done++;
  }
  /* 水域片：质心 ✓（名字一律**横着写在质心上** ✓ —— 不再算铺排折线 ✓）*/
  let wDone = 0;
  for (const [tid, a] of wAcc) {
    if (!(a.total > 0)) continue;
    t.lx[tid] = Math.round(a.x);
    t.ly[tid] = Math.round(a.y);
    t.area[tid] = a.total;
    t.blockArea[tid] = a.total;
    wDone++;
  }
  LOG.event('伪头衔补位置', `荒地/水域 ${done} 个节点 + 水域片 ${wDone} 个补上了标签位置`);
}

/** **荒地名 / 老包的水域名标签点** —— 一个名字一个标 ✓（2026-10-13 架构统一之后 ✓）
 *
 *  🔴 **每层一片的水域片已经不走这儿了** ✗✗（2026-10-14 用户要求：
 *    "水域和其他地块一样，仅仅是不能填色"✓）—— 它们归 `buildPseudoLabelPositions`
 *    + `labels.byTier` 那套**普通头衔**的路 ✓（见那边的注释 ✓）
 *    这里留下的是**两类没有片的伪头衔**：
 *      · **老包的水域**（整个世界的海共用一个 `#sea` ✗ 不是片 ✓）→ 按真名表出 ✓
 *        一个名字一个标（波罗的海那种 ✓）—— 不是片就没法按 tid 聚 ✓ 只能这样 ✓
 *      · **荒地**（`wl_<地块号>` 逐块 + `#wasteland_*` 片 ✓）→ 一个名字一个标 ✓
 *        （用户点名过"EU4 和 EU5 的荒地有自己的名字"✓ 这一块**先别动** ✓）
 *
 *  每组一个标：用**像素数加权求质心**（跟 buildPseudoLabelPositions 同一套算法 ✓）
 *    x 走**圆均值**（不然跨 180° 经线的那片名字会跑到地图正中 ✓ 见下面那段 ✓）
 *    名字**横着写在质心上** ✓（不再算铺排折线 ✓）
 *    粗层聚成一大片、细层聚成小片，**同一套算法** ✓
 *
 *  ⚠ **老包**（每层一片之前打的）退回 `meta.seaNames` 那几张真名表 ✓
 *    （那种包里全世界的海共用一个 `#sea` ✗，按 tid 聚只会剩一个"海洋" ✓）
 *
 *  ⚠ `tid` 给 null ✗ —— 这些点不属于任何头衔，是"凭空多出来的一层"，
 *    标签层只用 name/x/y/area/tier，不看 tid ✓
 *  ⚠ CK3 不给水域 / 荒地标名字 ✗（那两个开关在 CK3 里强制 false ✓
 *    drawLabels 那边还有一道 ✓）
 */
function buildSeaLabelPoints() {
  const meta = state.meta || {}, pp = state.provPos;
  if (!pp) return [];
  /* ⚠ 用**视图层**（state.tier）✗ 不是编辑层 —— 标签画的是"这一层看到的水域" ✓
   *   （悬停高亮那边用的是 editTier ✓ 两边都是"当前层那个片" ✓ 指向同一批地块 ✓）
   *
   * **一个名字一个组** ✓ 组键两种来源，按包的**新旧**分流：
   *   ① **每层一片的包** → 组 = **当前层那个 tid** ✓（**只剩荒地走这条** ✓
   *      水域片在上面那句 `if (_isWater && _piece) continue;` 就让开了 ✓）
   *      （同一个 tid 的地块就是一片 ✓ 名字取该 tid 的 ✓）
   *   ② **老包**（每层一片之前打的）→ 组 = 真名表里的**名字** ✓
   *      ⚠ 老包全世界的海共用一个 `#sea` ✗：按 tid 聚只会聚出**一个**"海洋" ✓
   *        表里那几百个真海名（波罗的海那种）**全丢** ✗ → 那批包非得走表不可 ✓
   *     ⚠ 两种包的组键**故意不同**（`t123` / `n波罗的海`）✗ 别合成一个 Map 的键 ✓
   */
  const T = state.titles || {};
  /* 🔴 **用"编辑层"（= 粒度），不是视图层** ✗✗
   *   （2026-10-13 用户："剧本下**高亮范围和名字应该跟随粒度**，
   *     **没有粒度就是最低**"✓）
   *   原来这里是 `state.tier`（**视图层** ✓）——
   *   在剧本模式下它停在剧本层 ✗ 而那一层的水域只有"整类"（`#sea_1444_xx` ✓）
   *   → 名字只能是"海洋"这种类名、整类挤成一个标 ✓
   *   ⚠ `editTier()` 已经改好了：**没开粒度 = 最低层** ✓ 开了 = 那一层 ✓
   *     于是名字 / 高亮 / 边界**同一个来源** ✓ 三处一致 ✓ */
  const _vt = labelTier() | 0;
  /* ⚠ **这一层没名字就是没名字** ✗（2026-10-14 用户点破的口径 ✓ 见 waterNameTable ✓）——
   *   以前写成 `_bt[_vt] || meta.seaNames` ✗ → HOI4 的省份级水域明明没名字，
   *   却拿战略区名填上了 ✓（用户原话："没有名字而已"✓）*/
  const _waterTbl = waterNameTable(meta.seaNamesByTier, _vt);
  const _wlTbl = meta.wastelandNames;
  const n = meta.numProvinces | 0;
  /* 表里的键是**地块 id**（JSON 会变成字符串 ✓ 两种都试 ✓）*/
  const _tblName = (tbl, pid) => {
    if (!tbl) return '';
    const v = (tbl[pid] != null) ? tbl[pid] : (tbl[String(pid)] != null ? tbl[String(pid)] : null);
    return v ? String(v) : '';
  };
  /* **一个连通域一个标** ✓（2026-10-16 用户定的 ✓ —— 跟地名那条同一套 ✓）
   *   组身份 `gk` 照旧（有片的包 → `t<tid>`；老包 → 类别字 + 名字 ✓），
   *   ⚠ 但**同名不等于同一块** ✗：一个名字的像素可能分处地图两头
   *     （太平洋被 180° 经线切开 ✓）→ 聚完组还要过一趟**连通域** ✓
   *     两块就出两个标 ✓（用户原话："一个太平洋会变成两块，从而有两个名字"✓）
   *   ⚠ 圆均值那套退了 ✗：邻接表没有跨左右边界的边 →
   *     每一块自己都落在它那半边 ✓ 普通像素加权平均就对了 ✓ */
  const gidOf = new Map();         // 组身份 → 数字号（并查集要整数 ✓）
  const gInfo = new Map();         // 数字号 → { name, waste }
  const ident = new Int32Array(n).fill(-1);
  for (let pid = 1; pid < n; pid++) {
    let tid = titleAt(pid, _vt);
    if (tid == null || tid === NO_TITLE) continue;
    let key = String(T.keys[tid] || '');
    /* 🔴 **水按 pid 问 `waterKindByPid`** ✗✗（2026-10-17 收口 ✓）
     *   原来这儿也是 `isWaterKey(key)` ✗ —— 这一层的水片键（`#sea_pr_57` ✓）在
     *   CK3/CK2/EU4/HOI4 上确实带 `#` ✓ 可 **EU5 不带** → 那一整套（名字 / 位置 /
     *   连通域）在 EU5 上**一块水都不进** ✓（用户："那不是还有现成的东西嘛"✓ 就是它 ✓）
     *   荒地那一侧照旧：键前缀 + `isWastelandTid` ✓（这一轮只收水的口 ✓）*/
    const _isWater = waterKindByPid(pid) !== 0;
    const _isWaste = !_isWater && (keyStarts(key, 'wl_') || keyStarts(key, '#impassable')
      || keyStarts(key, '#wasteland') || isWastelandTid(tid));
    /* 🔴🔴 **荒地换到最细层那一个头衔** ✗✗（2026-10-17 用户定的 ✓
     *   原话："所有荒地都应该按**最细层级**分组。"✓）
     *
     *  ⚠ 为什么非换不可 ✗✗：荒地在**粗层是不切的** ✓
     *    实测 EU5：那 8 块亚马逊荒地在
     *      `1337 / blank / reg / area / prov` **五层上全都是同一个伪头衔**
     *      （键 `#impassable` · tid 36188 ✓）
     *    只有最细的 `loc` 层才分成 8 个
     *      （`amazon_jungle` / `madeira_amazon_jungle` / `negro_amazon_jungle` … ✓）
     *    → 用当前层分组 = 8 个地点永远并成一个标 ✓
     *      （用户原话："明明有很多个叫亚马逊丛林的荒地地点，可是却只显示了一个名字"✓
     *        还有一句更关键："可以**统一一下**吗，你看看**海域和陆地都不会这样**"✓
     *        —— 它们就是**一个头衔一个标** ✓ 荒地现在也照这个口径 ✓）
     *
     *  ⚠ **只动荒地** ✗ —— 水域有自己的"每层一片"（`#sea_pr_57` 那种 ✓
     *    它在**每一层**都有自己的片 ✓ 换层反而会串 ✓ 所以水一个字都不动 ✓
     *  ⚠ 老包（键 `wl_<地块号>` ✓）在最细层本来就有逐块的头衔 ✓ 换了也一样 ✓ */
    if (_isWaste) {
      const _ft = titleAtFinest(pid, _vt);
      if (_ft != null && _ft !== NO_TITLE && _ft >= 0) {
        tid = _ft;
        key = String(T.keys[tid] || '');
      }
    }
    if (!_isWater && !_isWaste) continue;
    /* ⚠ 「每层一片」的那片才从**节点**取名字（`#sea_pr_57` ✓ 见 isTierPieceKey）
     *   别的（老包的共享 `#sea` / 最细层逐块的 `wl_<地块号>` ✓）名字在**真名表**里 ✓
     *   ⚠ 荒地没有分层表（游戏里就一张 ✓）→ 每个地理层都拿它分片 ✓ 结果一样 ✓ */
    const _piece = isTierPieceKey(key);
    /* 🔴 **每层一片的水域片不再走这儿** ✗✗（2026-10-14 用户要求：
     *   "水域和其他地块一样，仅仅是不能填色"✓）
     *   它们的 lx/ly/path 已经由 `buildPseudoLabelPositions` 补进 `titles` 数组 ✓
     *   LabelLayer 拿它们**当普通头衔**收进 byTier ✓（名字 / 缩放门槛 /
     *   「地名」与「水域·名称」两个开关全跟地名一条路 ✓）
     *   ⚠ 两边都发 = **同一个名字在图上叠两层字** ✗ 所以这里必须让开 ✓
     *   ⚠ **老包**（整个世界的海共用一个 `#sea` ✗ 不是片 ✓）照旧留在这儿 ✓ ——
     *     它们的海名只有 `meta.seaNames` 那张真名表里有 ✓
     *     （按 tid 聚只能聚出一个"海洋" ✓ 几百个真海名全丢 ✗ 那批包非走表不可 ✓）*/
    /* 🔴🔴 **有片就一片一标** ✗✗（2026-10-15 ✓ 用户口径 ✓）
     *   原来只让**水**片走开（`_isWater && _piece` ✗）—— 荒地片还留在这儿按名字合组 ✓
     *   现在放宽成**只要有片就让开** ✓：水片 / 荒地片一律交给**普通头衔那条**
     *   （`drawLabels` ✓ 一个 tid 一个标 ✓ 名字就是它自己那片的名字 ✓）
     *   ⚠ **老包**（整类共用一个共享节点 ✗ 压根没有片 ✓）照旧留在这儿 ✓ ——
     *     它们的真名只在 `meta.seaNames` / `meta.wastelandNames` 那两张表里 ✓
     *     按 tid 聚只能聚出一个"海洋" ✗ 那批包非走表不可 ✓
     *   ⚠ 片名是**类名 / 占位号 / 空**的照旧不出标 ✓（下面那道闸不动 ✗）*/
    if (_piece) continue;
    let nm = _piece ? String((T.names && T.names[tid]) || '')
                    : _tblName(_isWater ? _waterTbl : _wlTbl, pid);
    /* ⚠ **片名是类名的不出标** ✗（"海洋" / "不可通行山地" 那种 ✓）
     *   片名是构建期取的：那一层的水名表里没这个名字时，节点名就是**类名** ✓
     *   那种片本来就没有具体名 → 跟老路一样**不出标** ✓ 别拿类名充数 ✓
     *   ⚠ 只判**片名** ✗ —— 真名表那条路（老包 / wl_ 逐块）一字不动 ✓ */
    /* 🔴 **片名是占位号的一律出真名、再没有就不出标** ✗✗（2026-10-15 ✓ 用户口径 ✓）
     *   CK2 的 259 个水片 / 20 个荒地片：`titles.names` 里可能只剩 `#936` 占位 ✗
     *   → 先查 `meta.seaNames` / `meta.wastelandNames` ✓ 拿到真名就出标 ✓
     *   真名也没有（或名字是"海洋"那种类名 ✓）→ **不出标** ✓ 绝不把 `#936` 画到图上 ✗ */
    if ((_piece || _isWaste) && isPlaceholderName(nm)) nm = realNameFromTables(pid);
    if ((_piece || _isWaste) && isPseudoCategoryName(nm)) nm = '';
    /* ⚠ **荒地那一列在最细层可能没名字** ✗（EU5 的 `loc` 层就是这样 ✓）——
     *   那就退一步用**真名表**（`meta.wastelandNames` ✓ 逐地块的 ✓）
     *   实测那 8 块：细层头衔自己也是有名字的 ✓ 这条只是兜底 ✓ */
    if (_isWaste && !nm) nm = _tblName(_wlTbl, pid);
    if (!nm) continue;         // 表里没有 → 这一格不给标（老包 / CK3 没有真名 ✓）
    /* ⚠ 组键要把**水 / 荒地**也编进去 ✗✗ ——
     *   水面和荒地的名字**会撞**（VN 那个包里湖的名字就叫 "x" ✓
     *   而荒地真名表里**也有一条 "x"** ✓）—— 只按名字当键的话两条会并成一组 ✓
     *   然后后到的那个地块就被算进**先到的那个的** waste 标记里 ✓
     *   （实跑量出来的：120 块湖的水名整批变成了荒地名标 ✗）
     *   改造前是**两张 Map 各扫一遍表**（水一张、荒地一张 ✓）所以不会撞 ✓
     *   现在合成一趟了 → 键里必须带类别 ✓ */
    /* 🔴🔴 **组键一律按头衔** ✗✗（2026-10-17 用户报的"亚马逊丛林只出一个名字"✓）
     *
     *  改之前是：`_piece ? ('t' + tid) : ((_isWater ? 'w' : 'j') + nm)` ——
     *    **没有片**（键不带 `#`）的那批按**名字**分组 ✓ → **同名就并成一组** ✗
     *
     *  ⚠ 而 `PIECE_KEY_RE = /^#[a-z_]+_[a-z]+_\d+$/` **要求键以 `#` 开头** ✗✗ ——
     *    **EU5 的键不带 `#`**（`amazon_jungle` / `lake_baikal` 那种 ✓）
     *    → EU5 的荒地**全部**掉进"按名字分组"那条 ✓
     *    实测：`loc` 层有 **8 个**不同的亚马逊荒地地点
     *      （`amazon_jungle` / `madeira_amazon_jungle` / `negro_amazon_jungle` … ✓
     *       每个都是独立的一块 ✓ `meta.wastelandNames` 里也是 8 条真名 ✓
     *       只是名字恰好都叫「亚马逊丛林」✓）
     *    → 按名字一并 → 8 个地点只剩一个标 ✓（用户原话：
     *      "明明有很多个叫亚马逊丛林的荒地地点，可是却只显示了一个名字"✓）
     *
     *  ⚠ 用户那句"**海域和陆地都不会这样**"正是这个道理 ✗：
     *    它们的键在一层上是 `t<tid>` ✓ 一个头衔一组 ✓ 天然不会同名相并 ✓
     *    → 荒地现在也照这个口径 ✓ 跟代码里那句注释「**一个 tid 一个标**」对上 ✓
     *
     *  ⚠ **同名但不相邻的两块，仍然会出两个标** ✗ —— 下面还有一趟连通域 ✓
     *    （那正是"同名不等于同一块"那条老规矩 ✓ 见 `groupComponents` ✓）
     *  ⚠ 老那个"水名 / 荒地名会撞"的担心（VN 那个包里湖和荒地都叫 "x" ✓）
     *    **按头衔分组之后自然就没了** ✓ 头衔本来就不会撞 ✓ */
    /* ⚠ 组键：**有片按头衔、没片按「类别 + 名字」** ✗
     *   实测（2026-10-17）：**EU5 的荒地全部共用一个伪头衔**
     *     （键 `#impassable` · tid 36188 · 全世界荒地都是它 ✓）
     *     → 荒地**没法**按头衔分组 ✓ 只能按名字 ✓
     *   而 `meta.wastelandNames` 是**逐地块**的（EU5 有 1971 条 ✓）
     *     837 = 亚马逊丛林 · 65 = 阿比蒂比高地 · 82 = 阿布丛林 … ✓
     *     → 同名的一组 = 一片 ✓ 这正是要的 ✓
     *   ⚠ 类别字（`w` / `j`）**必须留着** ✗：水面和荒地的名字会撞
     *     （VN 那个包里湖和荒地都叫 "x" ✓ → 120 块湖的水名整批变成荒地名标 ✓）
     *   ⚠ 我中间把它改成过 `'t' + tid` ✗ —— 那等于把全世界荒地并成一组 ✓
     *     实测**标签直接归零** ✓ 别再往那个方向走 ✓ */
    /* 🔴🔴 **荒地按"地点"分组** ✗✗（2026-10-17 用户定的 ✓）
     *   原话："他们的**地点的颜色**是不一样的，我是说那张 EU5 的原图，
     *          他会**映射每一个颜色给每一个地点**"✓
     *   → 最细层**一个头衔 = 一个地点 = 一种颜色** ✓ 那就一个头衔一个标 ✓
     *
     *  ⚠ 荒地这一行的 `tid` 在上面已经被换成**最细层的头衔**了 ✗（见 `if (_isWaste)` ✓）
     *    所以 `'t' + tid` 就是"按地点"✓
     *  ⚠ **水域 / 荒地片**仍然用 `'t' + tid`（`_piece` 那条 ✓）一个字没动 ✓
     *  ⚠ **别退回"按名字"** ✗✗：同名**且相邻**的一整片会并成一个 ident ✓
     *    下面那趟连通域就再也切不开它 ✓
     *    实测亚马逊那 8 块互相都是邻居（837↔14565↔24236↔27523↔25043 ✓）
     *      → 按名字 = **1 个标** ✗（用户要 8 个 ✓）
     *    而塔克拉玛干那 5 块彼此不相邻 → 按名字也能出 5 个 ✓
     *      → "塔克拉玛干行、亚马逊不行"的差别**全在数据里**（相邻与否）✗ */
    const gk = (_piece || _isWaste) ? ('t' + tid) : (('w') + nm);
    let gid = gidOf.get(gk);
    if (gid === undefined) {
      gid = gidOf.size;
      gidOf.set(gk, gid);
      gInfo.set(gid, { name: nm, waste: _isWaste });
    }
    ident[pid] = gid;
  }
  const out = [];
  /* ⚠ **水先、荒地后** ✗（跟改造前同一个叠放顺序 ✓ 荒地标压在水名标上面 ✓） */
  const _comps = groupComponents(ident, n)
    .sort((a, b) => ((gInfo.get(a.id) || {}).waste ? 1 : 0)
                  - ((gInfo.get(b.id) || {}).waste ? 1 : 0));
  /* 🔴 **这个连通域是不是"横跨左右"** ✗✗（2026-10-17 ✓ 用户点名的那条 ✓）
   *   原话："如果一个属于水域的地点的像素位于地图左侧和右侧都有，
   *          就不要让它的名字显示，也不要让包含这个地点的上层水域的名字显示"✓
   *  ⚠ **判据拿成员地块的 x 跨度** ✗：跨度 > 半幅图宽 = 左右两侧都有它 ✓
   *    —— 跟"扫左右两列"是同一件事 ✓ 只是这儿手里只有 `provPos` 的质心 x ✓
   *    （连通域的成员一定相邻 ✓ 所以"最左那块"和"最右那块"的差就是它的跨度 ✓）
   *  ⚠ 这一段的点是**聚合过的** ✗（`tid: null` ✓）→ 后面那道闸查不了 ✓
   *    所以**必须在建点时就判** ✓ 判完挂在 `_pt.cross` 上 ✓
   *  ⚠ 只给**水**标 ✗ —— 用户点名的范围就是水域 ✓ 荒地那条不动 ✓
   *
   *  🔴 **跨度一次扫出来** ✗✗（2026-10-17 体检改的）——
   *    以前 `_crossOf(c)` 每个组都把全图 pid 扫一遍 ✗
   *    （EU5 几千个水 / 荒地组 × 4 万格 = 上千万次白扫 ✓）
   *    现在先 O(n) 一趟收每个组的 min/max x ✓ 之后每组 O(1) ✓ */
  const _W = (meta && meta.mapWidth) | 0;
  const _halfW = _W / 2;
  const _nG = gidOf.size;
  const _xMin = new Float64Array(_nG).fill(Infinity);
  const _xMax = new Float64Array(_nG).fill(-Infinity);
  for (let p = 1; p < n; p++) {
    const g = ident[p];
    if (g < 0 || g >= _nG) continue;
    const x = pp[p * 3] || 0;
    if (x < _xMin[g]) _xMin[g] = x;
    if (x > _xMax[g]) _xMax[g] = x;
  }
  const _crossOf = (c) => _W > 0 && c.id >= 0 && c.id < _nG
    && (_xMax[c.id] - _xMin[c.id]) > _halfW;
  for (const c of _comps) {
    const g = gInfo.get(c.id);
    if (!g || !g.name || !(c.area > 0)) continue;
    const _pt = {
      tid: null, sea: true, name: String(g.name),
      x: Math.round(c.x), y: Math.round(c.y),
      /* ⚠ **不要再给面积铺下限** ✗✗（2026-10-13 用户要求："湖泊那个巨大的最低地名
       *   太诡异了，马上去掉" ✓）
       *   我上一版为了让小湖看得见，写了 `Math.max(a.w, 6000)` ✗ ——
       *   结果**小湖的字号跟大湖一个样**（马尔马拉海才 6 像素却按 6000 算 ✓
       *   字号 14px，比它整片海还大 ✓ 用户说"诡异"就是这个 ✓）
       * 现在：**字号就是真实面积算出来的** ✓ 小的就该小 ✓
       *   （想让小水域也看得清该去调 `_fontSize` 的 `FONT_RATIO`，不是在这儿造假面积 ✗）*/
      area: c.area,
      /* ⚠ **tier 千万不能给 0** ✗（2026-10-13 用户报"还是看不见水域名称"✓ 就是它）
       *   `drawPoints` 里每个点按**自己那一层**过缩放门槛（`open()` ✓）：
       *     第 0 层是"国家 / 剧本层"，门槛**最高** ✗
       *   → 给 0 就等于"把海名锁到最深缩放下才显示" ✓ 平时一个都看不见 ✓
       *   海名点不属于任何头衔 ✗ 本来就不该吃任何一层的门槛 ✓
       *   所以给一个**层表之外的号**（99 ✓）：`zoom[99]` 是 undefined，
       *   `open()` 里 `n == null` 直接放行 ✓（比改 drawPoints 安全 ✗ 那函数别人也在用 ✓）*/
      tier: 99,
    };
    /* 荒地那一组多一个标记 ✓（drawLabels 按它挑「荒地 · 名称」还是「水域 · 名称」✓）
     *   ⚠ CK3 没有荒地名表 → 上面名字那一步就取不到 → **本来就不会有荒地标** ✓
     *     （用户定的：CK3 不给荒地和水域标名字 ✓）*/
    if (g.waste) _pt.waste = true;
    /* 🔴 **横跨左右的水点：挂个标记，名字一个都不出** ✗✗（2026-10-17 ✓ 用户点名的那条 ✓）
     *   只给**水**标是故意的 ✗ —— 用户点名的范围就是水域 ✓ 荒地那条不动 ✓
     *   ⚠ 判据在 `_crossOf(c)` 里（拿成员地块的 x 跨度 ✓ 见上面那段 ✓）*/
    if (!g.waste && _crossOf(c)) _pt.cross = true;
    out.push(_pt);
  }
  return out;
}

function drawLabels(view) {
  // 视口粗筛（边距跟 drawPoints 里那套一致 ✓）——省下大量入列与建对象 ✓
  const _padC = Math.max(64, 900 / labels.scale);
  const _cull = (arr) => arr.filter((q) => q.x >= view.x - _padC && q.x <= view.x + view.w + _padC
                                        && q.y >= view.y - _padC && q.y <= view.y + view.h + _padC);
  labels.showAll = false;   // 「显示全部地名」那个开关删了 —— 一律按字号门槛来
  // 顺序就是叠放顺序：**原版地名先画、玩家地名后画** ——
  // 两套名字重叠时，玩家的那个压在上面（同一个画布，后画的在上层）。
  const list = [];
  // 势力名和地名**分开管**：剧本/年份那几层算势力名，地区/省份/地点那些算地名。
  // 两个开关默认都开，想看干净的版图可以单独关掉一个。
  // 取名字用的是**编辑层**（editTier）：没换粒度时它等于视图层，换了粒度才分叉。
  // 这样"看 1444 的配色、粒度设成省份"时，出来的是省名（勾「地名」就显示），
  // 而不是被当成势力名、点了没反应。
  // 没有年代层就没有势力名（CK3）：原来用 `|| 1` 兜底 ✗，于是帝国层被当成势力名、
  // ② 又画了一遍同样的名字 —— 关「地名」看着没反应。
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  const viewTier = state.tier;
  const isCountryView = viewTier < nEra;
  /* **这层名字用哪一层的门槛** ✓（普通地名 / 水名 / 荒地名**同一个**值 ✓
   *   剧本层就是 editTier，地理层就是视图层 —— 提到这里，②′ 那段水名点也用它 ✓）
   *   2026-10-15 用户定："作为地名，缩放到何比例才显示**应该按规定是统一的**" ✓ */
  const nameTier = isCountryView ? editTier() : viewTier;

  /* 🔴🔴 **哪些头衔"是水"** ✗✗（2026-10-16 ✓「水域 · 名称」那个闸的判据 ✓）
   *
   *  ⚠ 判据**不能只看键名** ✗✗（现场实跑栽过一次 ✓）：
   *    `isWaterKey` 只认 `#` 开头的伪头衔 ✓ —— CK3 / CK2 的水是 `#sea_b_2218` ✓ 认得出 ✓
   *    可 **EU5 的水键压根不带 `#`**（`chukchi_sea` / `siberian_lakes_1` ✓）→ 全认成陆地 ✓
   *    实测：EU5 关掉水名开关之后**还剩 5709 个水名点** ✓（开关看着就是坏的 ✓）
   *  → 正解是走**认水的唯一出处** `waterKindByPid` ✓（身份标最权威 → 老包退回 `#` 键 ✓
   *    跟「水域 · 边界」那张纹理**同源** ✓ 两个开关不会各认一套 ✓）
   *
   *  🔴🔴 **2026-10-17：不再自建那张 Set** ✗✗（用户点破的 ✓）
   *    原来这儿是 `state.waterKindSet`（我在 `buildWaterKindMask` 里顺手收的 tid 并集 ✓），
   *    理由是"标签点只有 `tid`，而认水是按 pid 问的" ✗ ——
   *    **可项目里本来就有按 tid 问的那条** ✓：`kindOfTid(tid)` ✓
   *      （走 `kindTidMap()`：扫每一层 + 老包退回键前缀 ✓ 判据比我那张 Set 还全 ✓
   *        而且它自己带缓存 `state._kindMap` ✓ 换图按 `numTitles|kindMask长度` 作废 ✓）
   *    用户原话："既然是如何判别水，那不是还有现成的东西嘛"✓ —— 就是它 ✓
   *    → 那张 Set 连同"逐层收 tid"那圈循环一起删了 ✓ 这里直接问现成的 ✓
   *    ⚠ **纹理那张表（`state.waterKindArr`）仍然要** ✗ —— 着色器逐像素、问不了 tid ✓
   *      两张表的分工没变，只是"逐头衔"那一张改用现成的了 ✓ */
  /** 这个标签点算不算"水域"✓（给「水域 · 名称」那个闸用 ✓）
   *
   *  🔴🔴 **两道，顺序不能反** ✗✗（2026-10-17 现场量出来的 ✓）
   *    ① **键先说**：`isWaterKey(键)` —— `#sea` / `#lake` / `#river` / `#impassable_sea` ✓
   *       CK3/CK2/EU4/HOI4 的水片键都长这样 ✓ 一眼就是水 ✓
   *    ② 键**说不出话**（EU5 那种不带 `#` 的 ✓）→ 问现成的 `kindOfTid(tid)` ✓
   *       （内部走 `kindTidMap()` + 老包退回键 ✓）
   *
   *  ⚠ **为什么不能只留 ②** ✗：实测 CK3 有 **2 块**地（pid 1080 / 1088 ✓）——
   *     键是 `#lake_k_83` / `#lake_b_308`（**明摆着是湖** ✓），
   *     可 `kindMask` 给的是 **6（不可通行陆地）** ✓
   *     根因在构建期：`kind_mask()` 按 `KIND_CODES` 的次序填，
   *       `#impassable` 排在 `#lake` **后面** → 同时落进两类的省被覆写成 6 ✓
   *     → 只按身份标判就会把这 2 块湖算成陆地 ✗（"关掉水名还剩 2 个湖名"✓）
   *     而**键自己就先说了答案** ✓ —— 这也正是 `kindOfTid` 给老包留的那条退路的意思 ✓
   *  ⚠ 反过来"只留 ①"也不行 ✗：EU5 的键一块水都认不出来（实测 0 块 ✓）见下 ✓
   *
   *  ⚠ 判据**收在这一处** ✗ —— 别在调用点各写一遍 ✓
   *  ⚠ 6 = 不可通行**陆地**，那是荒地那一侧 ✗ 不算水 ✓（5 = 不可通行**海域**算 ✓）*/
  const _isWaterLabel = (tid, key) => {
    if (isWaterKey(key)) return true;
    if (tid == null || tid < 0) return false;
    const k = kindOfTid(tid);
    return k >= 2 && k <= 5;
  };

  // ① 地名（先入列 = 在下面）：勾了「地名」就画**当前选中的那一层**。
  /* 🔴 2026-10-16：**「水域 · 名称」是独立一闸** ✗✗（用户定的 ✓ 见 handover §3.1）
   *   原话："水域名称开关同理 … 同时受管理的这些东西**不再受地区名称的管理**"✓
   *   → 所以**不能**把这个 if 整个包住（包住 = 关掉「地区 · 名称」水名也没了 ✗）
   *   → 下面**按点分家**：
   *       · 水域那几类（这一层的键走 isWaterKey ✓）→ 只听 state.showWaterName ✓
   *       · 其余（陆地 / 荒地 ✓）→ 跟以前一模一样，**没有任何新闸** ✓
   *   ⚠ **河与湖算"水域"** ✓（用户点名的四类就是"海洋、湖泊、河流、不可通行海域"✓
   *     它们本来就被 isWaterKey 收在内 ✓ 一切照旧 ✓）
   *   ⚠ 荒地（不可通行区域）**现在也有自己的开关了** ✓（2026-10-17 用户加的 ✗
   *     "显示区加一行，关于荒地的名称开关"✓）——
   *     在这之前它是跟着「地块 · 名称」走的 ✓ 现在独立 ✓
   *     （这条注释 2026-10-16 时写的是"荒地没有开关"✗ 那一轮确实没有 ✓ 别当它还有效 ✓）
   *   ⚠ 「地块 · 名称」关着 + 「水域 · 名称」开着 → **只剩水名** ✓（正是用户要的独立 ✓）
   *   ⚠ **荒地 / 河那一批仍然只听「地区 · 名称」** ✗（实跑量出来的口径 ✓）：
   *     用户原话是"**水域**名称开关同理"，而"水域"在他点名的那四类（海洋/湖泊/河流/不可通行海域）里
   *     —— 河流**算**水域 ✓（isWaterKey 收着它 ✓）；**荒地不算** ✗
   *     所以关掉「地区 · 名称」之后：河名还得跟着水名开关活着 ✓
   *     荒地（不可通行区域）该跟陆地一起消失 ✓ —— 它没有自己的开关（用户没要 ✓）*/
  /* ① 地名 / 水名 / 荒地名 —— **三类各听各的开关** ✓
   *   · 地块名（陆地）→ 「地块 · 名称」
   *   · 水那几类（海 / 湖 / 河 / 不可通行海域）→ 「水域 · 名称」
   *   · 荒地 → 「荒地 · 名称」
   *   ⚠ **不能用一个 if 把整段包在「地块 · 名称」里** ✗ ——
   *     那样关掉地块名，水名 / 荒地名也会跟着没了（用户要的是各管各的 ✓）
   *   ⚠ **剧本层本身不算地名** ✗ —— 那一层是国家 / 势力，归 ③ 那套管；
   *     剧本层只放行"自己那个名称开关开着"的水 / 荒地 ✓
   */
  if ((state.showLabelsTitle || state.showWaterName || state.showWasteName)
      && (nameTier >= nEra || state.showWaterName || state.showWasteName)) {
    const K = state.titles.keys || [];
    /* **取点：一个连通域一个标** ✓（2026-10-16 用户定的 ✓ 见 buildPlaceComponents ✓）
     *   以前是 `labels.pointsFor(nameTier)` ✗ —— 一个头衔只出一个标 ✓ */
    for (const q of _cull(placePointsFor(nameTier))) {
      const _key = String(K[q.tid] || '');
      /* 🔴 **这一格是水吗** ✗✗（2026-10-16 ✓「水域 · 名称」那个独立闸的判据 ✓）
       *   ⚠ 判据收在 `_isWaterLabel` 那一处 ✗（别在这儿另写一套 ✓
       *     那正是"EU5 的水不带 `#`"那个坑的来源 ✓）
       *   ⚠ 判在 _cull 之后 —— 被剔除的点才不用查，省一笔 ✓ */
      const _isWaterPt = _isWaterLabel(q.tid, _key);
      const _isWastePt = !_isWaterPt && isWasteOrWaterTid(q.tid) === 'waste';
      /* 🔴🔴 **横跨左右的水地点：名字一个都不出** ✗✗（2026-10-17 用户点名的 ✓）
       *   `state.crossSeamTids` 里**上层也收进来了** ✓（见 buildCrossSeamTids ✓）
       *   所以这一句同时管住"它自己"和"它的上级"✓；**只加水** ✗ 陆地一个字不动 ✓ */
      if (_isWaterPt && state.crossSeamTids && state.crossSeamTids.has(q.tid)) continue;
      // 剧本层只出水 / 荒地（且要各自开关开着）；陆地名归 ③ 那套势力名 ✓
      if (nameTier < nEra && !_isWaterPt && !_isWastePt) continue;
      /* **一个名称开关管一类** ✓（判序：先水、再荒地、其余陆地 ✓）——
       *   ⚠ 荒地 2026-10-17 之前是跟着「地块 · 名称」走的 ✗ 现在独立 ✓ */
      if (_isWaterPt ? !state.showWaterName
          : _isWastePt ? !state.showWasteName
          : !state.showLabelsTitle) continue;
      /* 游戏规则：哪一代出哪一类名（`NAME_POLICY` 那张表 ✓）——
       *   `labelZoneOf` 要**键**（它判的是"键上看是哪一类"✓ 跟 `kindOfTid` 两条路 ✓）*/
      const _zone = labelZoneOf(_key, q.tid);
      if (!nameShown(_zone)) continue;
      const _nm = String((state.titles.names && state.titles.names[q.tid]) || '');
      if (!_nm || isPseudoCategoryName(_nm)) continue;
      /* **占位片名**（tier_pieces 的 `#<地块号>` 兜底 ✓）—— 没有真名就别出字 ✗
       *   （HOI4 的 pr 层 3259 片 / V3 的多数湖泊都在这一档 ✓ ——
       *     显示出来就是一排 "#3004" 那种乱码地名 ✗ 按类名的同一口径不出 ✓）*/
      if ((_isWaterPt || _isWastePt) && _nm.startsWith('#')) continue;
      list.push(q);
    }
  }
  /* ②′ **水域名单独一层** ✓（2026-10-13 ✓）
   *   ⚠ 这一段**不能塞在上头那个 `if (nameTier >= nEra)` 里** ✗，
   *     （2012-10-13 那时它是独立一层的点）——
   *   **2026-10-15 全改统一** ✓：
   *     · 「水域/荒地 · 名称」两个开关退役 ✓
   *     · 门槛也统一：点的 tier 用 **nameTier** —— `labels.drawPoints` 的
   *       `open(p)` 拿 **zoom[nameTier]** 跟普通地名**同一个值** ✓
   *       （以前 tier=99 = 恒显 ✗ —— 那正是「空白剧本也冒荒地名」的推手 ✓）
   *     · **剧本层（含空白）一个名字都不显示** ✓ —— **跟普通地名同一道 gate**：
   *       `nameTier >= nEra`（普通地名在剧本层整层不画 → 水名/荒地名也不画 ✓）
   *       ⚠ 名单只受这个门 ✗ —— `buildSeaLabelPoints` 里扫的是**最细层**
   *         （`labelTier()` 没开粒度 = 最细层 ✓）—— 它跟 nameTier 不是一个层 ✓
   *         （细层的荒地名顶着剧本层门槛冒出的正是它 · 悬停区域对应放飞 ✓）*/
  {
    /* **只有 CK3 被排除** ✓ —— CK2 要照常把水域名点推进名单里 ✓（独立模式 ✓
     *   见 `pseudoNameAllowed` 那段：CK2 给水与荒地标名 ✓ 2026-10-15 用户定 ✓）
     * 🔴 2026-10-16 用户把"名字显示方案"点名之后，这里改成**按类别查表** ✗：
     *   CK3 只出**河流**（海 / 湖 / 荒地都不出 ✓）→ 不能再整块 `if (!isCk3)` 一刀切 ✓ */
    /* ⚠ **2026-10-17：外闸也要带上荒地那一面旗** ✗✗
     *   原来这儿是 `nameTier >= nEra && state.showLabelsTitle` ✓
     *   可荒地现在**有自己的开关**了 ✓ → 只勾「荒地 · 名称」时这一整段也得跑 ✓
     *   （不然"勾了荒地名称却一个荒地名都不出" ✗ —— 那开关就是死的 ✓
     *    ⚠ 同理，水那面旗 2026-10-16 就加进外闸了 ✓ 这一轮把荒地也补上 ✓）*/
    if (nameTier >= nEra
        && (state.showLabelsTitle || state.showWaterName || state.showWasteName)) {
      /* 🔴 **一条一条按类别过** ✗✗（`NAME_POLICY` 那张表 ✓）
       *   `buildSeaLabelPoints` 聚出来的点带 `sea` 标记 ✓ 但它分不出海 / 湖 / 河 ✗
       *   （老包那边名字是从**真名表**取的，表里没类别 ✓）——
       *   所以按**这一格自己的键**判类别 ✓ 跟 `drawLabels` 上面那条同一个口径 ✓ */
      const _K = state.titles.keys || [];
      for (const p of (state.seaLabelPoints || [])) {
        const _z = labelZoneOf(String(_K[p.tid] || ''), p.tid);
        if (!nameShown(_z)) continue;
        /* 🔴 **水域那个独立闸** ✗✗（2026-10-16 ✓ 用户定的 ✓）
         *   这一段吐出来的点**全是"没有片的老包"**（有片的那批在上头
         *   `if (_piece) continue;` 就让开了 ✓ 它们走 ① 那条普通头衔路 ✓）——
         *   可这一批过不了 ①（① 只收 LabelLayer 认的"有头衔的点"，
         *   而它们 `tid: null` ✗）→ 所以水名 / 荒地名各留一条路在这儿 ✓
         *   ⚠ 「水域 · 名称」关着 → **带 sea 标记的点一个都不加** ✓
         *     这正是用户要的："水域名称开关负责且仅负责水域名称的显示或隐藏"✓
         *   ⚠ 荒地那些**不归它** ✓（`sea: true` 水、`waste: true` 荒地 ✓ 分开判 ✓
         *     用户 2026-10-16 只点名了水域 ✓ 荒地照旧看它自己那面旗 / 游戏规则 ✓）
         *   ⚠ 顺序：**先过游戏规则那张表、再让开关说话** ✗ 反过来会在
         *     CK3 上"勾了水名开关就冒出「海洋」两个字" ✓（正是用户点名不要的 ✓）*/
        if (p.sea && !p.waste && !state.showWaterName) continue;
        /* 🔴🔴 **横跨左右的水点：名字一个都不出** ✗✗（2026-10-17 用户点名的 ✓）
         *   原话："如果一个属于水域的地点的像素位于地图左右两侧都有，
         *          就不要让**它的名字**显示，也不要让**包含这个地点的上层水域**的名字显示"✓
         *   动机（原话）："掩耳盗铃"✓ —— EU5 没切日期变更线，
         *     那几块横跨图宽的地会让名字的"中心"落到地图正中 ✓ 与其把位置算法做复杂，
         *     不如这种名字干脆别显示 ✓
         *   ⚠ 这个标记是 `buildSeaLabelPoints` 建点时判好的 ✗（那儿的点是聚合过的、
         *     `tid: null` ✓ 到这儿已经查不出它含哪些地块了 ✓）
         *   ⚠ **"上层水域"也一起藏** ✗：`state.crossSeamTids` 里收了横跨地的**每一层**头衔 ✓
         *     所以走 ① 那条"普通头衔"路的水片（含上级）由那句 `has(q.tid)` 挡掉 ✓
         *     两条路各挡各的，合起来正好覆盖"它自己 + 它的上级"✓ */
        if (p.cross) continue;
        /* 🔴 **荒地那一批听它自己那面旗** ✗✗（2026-10-17 ✓ 用户给荒地加了开关 ✓）
         *   `buildSeaLabelPoints` 聚出来的荒地真名点带 `waste: true` ✓
         *   ⚠ 在这之前它们是跟着「地块 · 名称」走的 ✓ 现在独立 ✓ */
        if (p.waste && !state.showWasteName) continue;
        list.push({ ...p, tier: nameTier });
      }
    }
  }
  /* ③ 色块名：最上层（半透明）。
   *   🔴 **一律归「势力名」那一档** ✗✗（2026-10-16 用户定的 ✓）——
   *     剧本层上是原版国名 + 玩家涂出来的国 ✓；细层上就是玩家自己涂的色块名 ✓
   *     两者都算"势力名" ✓ 跟真正的地名（`①` / `②′` 那两路）分开管 ✓
   *   → 给 `tier: 0`（最粗那层）就落进 `tier < nEra` ✓ 走「势力名称不透明度」✓
   *   ⚠ 以前挂了个 `fade` 标记把这批压进**地名档** ✗ ——
   *     结果剧本层的国名跟着「地名不透明度」走、
   *     「势力名称不透明度」那根滑条**怎么拖都没反应** ✓（用户报的就是这个 ✓）*/
  if (state.showLabelsPaint) {
    /* ⚠ **这里什么都不用加** ✗✗（2026-10-17 差点画蛇添足 ✓）
     *   字号拆成"地块 / 势力"两块之后，看着好像得给这点标个"我是哪一类" ——
     *   **不用** ✓：`layer: 2` 就是"玩家涂出来的色块名"这个身份 ✓
     *   `labels.js` 的 `_fontSize` 拿 `tier < nEra || layer === 2` 就分得清 ✓
     *   （年份层那些国名走 `tier < nEra` ✓ 同一套判据 ✓ 见 `_fontSize` 那段注释 ✓）
     *   → 我第一版给这儿加了个 `kind: 'power'` ✗ 那是**新造字段** ✓ 用户当场点破 ✓ */
    for (const p of (paintedPoints(true) || [])) list.push({ ...p, tier: 0, layer: 2 });
  }
  if (!list.length) { labels.clear(); return; }

  // 缩放门交给标签层按"每个点自己的层"判：
  //   头衔 / 地区 / 省份名 —— 按当前视图层的门槛；
  //   玩家色块名       —— 按第 0 层（国家那套），所以不用放大就能看见。
  labels.drawPoints(list, view);
}

/* ================================================================ 导出图例
 *
 * 导出的图加一段**图例 + 标题**，发出去才像一张"图" ✓
 *   · 条目**自动来自你涂出来的颜色分组**（state.paintBlocks ✓ 名字用当前的显示名 ✓）
 *     同色算一组，取面积最大那一族的名字当组的名字 ✓
 *   · 名字就是**地图上现在显示的那个**（想改走「改名」工具 ✓），不想要的可以关掉（state.legendOn ✓）
 *   · 面板在「设置」里（用户要求 ✓）；勾上之后「导出窗口 / 导出整图」都会画进去 ✓
 *   · 整图 9216 宽时字号会自动放大，不会小得像蚂蚁 ✓
 */

/** 当前该列进图例的条目
 *
 * 两条规矩（用户定的 ✓）：
 *   ① **只列"现在在图上涂出来的颜色"** ✓ —— 一个颜色底下没有一块是涂过的，
 *      那就是原版底色、不该进图例 ✗（以前列的是"这一族整块多大"，
 *      于是没涂过的国家、或者只涂了一点点的大国都会混进来 ✗）
 *   ② **按"你涂出来的面积"从大到小排** ✓ —— 不是按国家本身大小排 ✗
 *
 * 一点都没涂的图（比如就想出"1789 年的欧洲"）→ 退回到"当前年份的全部国家" ✓
 * 那时候没有涂色面积可比，就按各自的版图大小排 ✓
 */
function legendEntries() {
  const paint = renderer && renderer.paintData;
  const pp = state.provPos;
  // 这一族里"被涂过"的地块，按像素数加起来 = 这个颜色在图上的**实际大小** ✓
  const paintedSize = (b) => {
    if (!paint) return 0;
    let w = 0;
    for (const x of (b.pids || [])) {
      if (paint[x * 4 + 3] > 0) w += pp ? (pp[x * 3 + 2] || 0) : 1;
    }
    return w;
  };
  const blocks = (state.paintBlocks || []).filter((b) => b && b.name);
  const sizes = new Map(blocks.map((b) => [b, paintedSize(b)]));
  const anyPainted = [...sizes.values()].some((v) => v > 0);
  const seen = new Map();
  for (const b of blocks) {
    const pSize = sizes.get(b);
    // ① 有涂色时：没涂过的族一律不进图例 ✓（那只是原版底色，不是"现在显示的东西"✓）
    if (anyPainted && pSize <= 0) continue;
    const rgb = b.rgb || [150, 150, 150];
    const key = rgb.join(',');
    // ② 排序用的"大小"：有涂色看涂出来的，没涂色看整块版图 ✓
    const size = anyPainted ? pSize : (b.area || 0);
    const hit = seen.get(key);
    if (!hit || size > hit.size) {
      seen.set(key, { key, rgb, size, area: b.area || 0, painted: pSize,
                      name: String(b.name), tid: b.tid });
    }
  }
  const _ordered = [...seen.values()]
    .sort((a, b) => b.size - a.size)
    .map((e) => ({
      ...e,
      // **名字用"现在显示的那个"** ✓ —— b.name 是 rebuildPaintBlocks 从
      // state.titleName 现算的 ✓ 所以用「改名」工具改完，这边**立刻就是新名字** ✓
      //（图例自己那份 legendNames 已经删了 ✗ —— 列表里不再能改名 ✓）
      name: e.name || '',
      on: !(state.legendOn && state.legendOn[e.key] === false),
    }));
  /* **手动顺序优先** ✓（在图例列表里用 ↑↓ 排过的 ✓ 存在 state.legendOrder ✓）
   * 排过的按你排的次序走 ✓；没排过的（比如刚涂出来的一族）接在后面按大小走 ✓
   * 不然手动排一次就把新来的条目挤没了 ✗ */
  const ord = state.legendOrder;
  if (Array.isArray(ord) && ord.length) {
    const at = new Map(ord.map((k, i) => [k, i]));
    _ordered.sort((a, b) => {
      const ia = at.has(a.key) ? at.get(a.key) : Infinity;
      const ib = at.has(b.key) ? at.get(b.key) : Infinity;
      if (ia !== ib) return ia - ib;
      return b.size - a.size;
    });
  }
  return _ordered;
}

const _hexOf = (rgb) => {
  const h = rgbToHex(rgb);
  return h && h[0] === '#' ? h : '#' + h;
};

/**
 * **按"现在这一刻"的视图重算色块，然后刷图例列表** ✓
 *
 * 为什么要这么写：色块分组（state.paintBlocks）是"跟当前剧本/层级"绑定的 ✓
 * 而它是**上一帧**算的 —— 你换了剧本、打开设置的时候那一帧可能还没轮到 ✗
 * 只刷列表就会把**上一个剧本**的条目列出来 ✗（用户报的正是这个 ✓）
 * 所以：先把欠着的那次重算补上 ✓ 再列 ✓
 *
 * 导出图例走的是同一套（见 maybeDrawLegend ✓），两边口径一致 ✓
 */
function freshPaintBlocks() {
  if (!blocksDirty) return;
  try {
    rebuildPaintBlocks(!!state._blocksAll);
    blocksDirty = false;
    labelDirty = true;
  } catch (e) { /* 出错就按现有的数据来 ✓ 别把界面打断 ✗ */ }
}

/** 打开设置那一栏用的：先补算色块 ✓ 再刷列表 ✓ */
function legendFresh() {
  freshPaintBlocks();
  rebuildLegendPanel();
}

/** 把设置页里的图例列表刷一遍（打开设置、涂完色都该刷 ✓） */
function rebuildLegendPanel() {
  const box = $('legend-list');
  if (!box) return;
  const list = legendEntries();
  if (!list.length) {
    /* 一条都没有：**什么都不写** ✓ 连这个空框一起藏起来 ✓
     * （用户：那句提示字去掉 ✓ 加它是为了诊断"我图例呢"，现在刷新已经修好了 ✓
     *   有涂过的时候，点开这一页就会列出条目 ✓ 真的没内容就安安静静不显示 ✓） */
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  // 名字的 HTML 转义（就地在模板里拼，别让 & < > " 把结构破了 ✗）
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  box.innerHTML = list.map((e, i) => (
    '<div class="legend-row" data-key="' + e.key + '">'
    + '<input type="checkbox" class="legend-on"' + (e.on ? ' checked' : '') + '>'
    + '<span class="legend-sw" style="background:' + _hexOf(e.rgb) + '"></span>'
    // **名字只读** ✓ —— 列表里不再能改名（想改走「改名」工具 ✓）
    // title 里放全名：太长了会被省略号截掉，悬停还能看全 ✓
    + '<span class="legend-name" title="' + esc(e.name) + '">' + esc(e.name) + '</span>'
    + '<span class="legend-move">'
    +   '<button type="button" class="legend-up" aria-label="上移"'
    +     (i === 0 ? ' disabled' : '') + '>▲</button>'
    +   '<button type="button" class="legend-down" aria-label="下移"'
    +     (i === list.length - 1 ? ' disabled' : '') + '>▼</button>'
    + '</span>'
    + '<span class="legend-drag" title="" aria-label="按住拖动排序">⠿</span>'
    + '</div>'
  )).join('');
  let dragRow = null;      // 正在拖的那一行（拖动排序用 ✓ 一次只可能有一行 ✓）

  /** 拖动中：看指针掠过哪一行，就把拖的那行插到它前/后 ✓（事件挂在 window 上 ✓ 见下面说明） */
  const onLegendDragMove = (ev) => {
    if (!dragRow) return;
    ev.preventDefault();
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = over && over.closest ? over.closest('.legend-row') : null;
    if (!target || target === dragRow || !box.contains(target)) return;
    // 指针在目标行的上半 → 插到它前面 ✓；下半 → 插到它后面 ✓
    const r = target.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    box.insertBefore(dragRow, after ? target.nextSibling : target);
  };

  /** 松手 / 被系统打断：收尾 ✓ 顺序存下来 ✓ 那一行立刻恢复原样 ✓ */
  const endLegendDrag = () => {
    window.removeEventListener('pointermove', onLegendDragMove);
    window.removeEventListener('pointerup', endLegendDrag);
    window.removeEventListener('pointercancel', endLegendDrag);
    try { document.body.style.userSelect = ''; } catch (e) { /* ✓ */ }
    if (!dragRow) return;
    dragRow.classList.remove('dragging');   // **立刻取消变暗** ✓（用户报过：放开后一直暗着 ✗）
    dragRow = null;
    // 松手这一刻的 DOM 顺序就是新顺序 ✓ 存下来 ✓
    const keys = [...box.querySelectorAll('.legend-row')]
      .map((r2) => r2.getAttribute('data-key')).filter((k) => k != null);
    if (keys.length) { state.legendOrder = keys; scheduleSave(); }
    rebuildLegendPanel();                   // 重建一遍：变暗状态、箭头灰亮、上下边界全对上 ✓
  };

  for (const row of box.querySelectorAll('.legend-row')) {
    const key = row.dataset ? row.dataset.key : row.getAttribute('data-key');
    const on = row.querySelector('.legend-on');
    /* 顺序调整：点一下换一格 ✓
     * 把**当前看到的顺序**整条存进 state.legendOrder ✓（含没手动排过的 ✓）
     * 这样后面再排、以及导出图例，都按这个顺序走 ✓ */
    const move = (dir) => {
      const keys = legendEntries().map((e) => e.key);
      const i = keys.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= keys.length) return;
      const tmp = keys[i]; keys[i] = keys[j]; keys[j] = tmp;
      state.legendOrder = keys;
      legendFresh();     // 先补算色块再列 ✓ 不然列的是上一个剧本的 ✗          // 立刻重排 ✓
      scheduleSave();
    };
    const up = row.querySelector('.legend-up');
    const down = row.querySelector('.legend-down');
    if (up) up.addEventListener('click', () => move(-1));
    if (down) down.addEventListener('click', () => move(1));

    /* **按住拖动排序** ✓（除了上面那对小箭头，多一条更顺手的路 ✓）
     * 用 Pointer Events 一套通吃鼠标和手指 ✓（HTML5 那套 draggable 在手机上不能用 ✗）
     * 拖动时**直接挪 DOM**：手指掠过哪一行就插到它前/后面 ✓ 松手才写 state ✓
     *
     * ⚠ 事件**挂在 window 上，不挂在把手上** ✗ —— 踩过的坑：
     *   把手挂 pointer capture 的话，拖到一半我们把整行 insertBefore 挪走 ✓
     *   而 DOM 规范里"移动节点"是先摘下来再插回去 ✗ → **capture 当场失效** ✗
     *   于是后面的 pointerup 收不到 → finish 不跑 → 那一行**一直暗着** ✗
     *   （用户报的"放开不会变回来、还得再按一下把手"就是这个 ✓）
     */
    const dragGrip = row.querySelector('.legend-drag');
    if (dragGrip) {
      dragGrip.addEventListener('pointerdown', (ev) => {
        if (dragRow) return;                // 一次只拖一行 ✓
        ev.preventDefault();                // 别让它变成选文字 / 滚页面 ✓
        dragRow = row;
        row.classList.add('dragging');
        try { document.body.style.userSelect = 'none'; } catch (e) { /* ✓ */ }
        window.addEventListener('pointermove', onLegendDragMove, { passive: false });
        window.addEventListener('pointerup', endLegendDrag);
        window.addEventListener('pointercancel', endLegendDrag);
      });
    }
    if (on) on.addEventListener('change', () => {
      state.legendOn = state.legendOn || {};
      state.legendOn[key] = on.checked;
      scheduleSave();
    });
    /* 「在图例列表里改名」这条路已经删掉 ✓（用户要的）
     * 名字就是地图上现在显示的那个；真要改名走「改名」工具（renameAt）✓ */
  }
}

/**
 * 把图例画到导出用的 2D 画布上 ✓
 * **标题和图例分开对待** ✓：只要有标题就画标题（哪怕一条图例都没有 ✓）
 *   （踩过的坑：以前"没条目就整个 return" ✗ → 连标题都不画，看着像功能坏了 ✗）
 * @returns 画了几行（0 = 什么都没画）
 */
function drawLegend(ctx, W, H) {
  const all = legendEntries().filter((e) => e.on);
  const _title0 = String((state.set && state.set.legendTitle) || '').trim();
  if (!ctx || !(W > 0) || !(H > 0)) return 0;
  if (!all.length && !_title0) return 0;
  const title = _title0;
  const pos = (state.set && state.set.legendPos) || 'tl';
  const FONT = '"Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';
  // 字号随图宽走，但**调小了**（用户要求：小一点 → 一屏塞得更多 ✓）
  //   以前 W/110，9216 宽的整图算出来 84px ✗ 又大又占地方
  const fs = Math.max(11, Math.round(W / 175));
  const pad = Math.round(fs * 0.85);
  const rowH = Math.round(fs * 1.7);                     // 行距也压紧一点 ✓
  const sw = Math.round(fs * 1.15);
  const M = Math.round(fs * 1.4);                        // 离图边的距离 ✓
  // **能塞多少塞多少**：按图高算行数（以前写死 40 ✗ 图小就画到外面、图大又浪费 ✓）
  const maxRows = Math.max(4, Math.floor(
    (H - M * 2 - pad * 2 - (title ? fs * 2 : 0)) / rowH));
  const list = all.slice(0, maxRows);
  const more = all.length - list.length;
  ctx.save();
  ctx.font = '600 ' + fs + 'px ' + FONT;
  const tw = title ? ctx.measureText(title).width : 0;
  let nameW = 0;
  for (const e of list) nameW = Math.max(nameW, ctx.measureText(e.name).width);
  const boxW = Math.round(pad * 2 + sw + fs * 0.7 + Math.max(nameW, tw));
  const boxH = Math.round(pad * 2 + (title ? fs * 2 : 0) + list.length * rowH);
  // 位置：**左上 / 右上 / 左下 / 右下** ✓（原先只留了上面两个 ✓ 用户要四个角 ✓）
  // 认不出来的一律当左上 ✓ 不会画到图外 ✓（老存档里可能存着别的值 ✓）
  const onRight = pos === 'tr' || pos === 'br';
  const onBottom = pos === 'bl' || pos === 'br';
  const x = onRight ? Math.max(M, W - boxW - M) : M;
  const y = onBottom ? Math.max(M, H - boxH - M) : M;
  // 底板：半透明白，浅色深色底图都读得清 ✓
  const r = Math.round(fs * 0.6);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + boxW, y, x + boxW, y + boxH, r);
  ctx.arcTo(x + boxW, y + boxH, x, y + boxH, r);
  ctx.arcTo(x, y + boxH, x, y, r);
  ctx.arcTo(x, y, x + boxW, y, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,.90)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, Math.round(fs / 14));
  ctx.strokeStyle = 'rgba(0,0,0,.32)';
  ctx.stroke();
  let ty = y + pad + fs * 0.9;
  if (title) {
    ctx.font = '700 ' + Math.round(fs * 1.15) + 'px ' + FONT;
    ctx.fillStyle = '#111';
    ctx.fillText(title, x + pad, ty + fs * 0.15);
    ty += fs * 2;
  }
  ctx.font = '500 ' + fs + 'px ' + FONT;
  for (const e of list) {
    const sy = Math.round(ty - sw + fs * 0.15);
    ctx.fillStyle = _hexOf(e.rgb);
    ctx.fillRect(x + pad, sy, sw, sw);
    ctx.lineWidth = Math.max(1, Math.round(fs / 18));
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.strokeRect(x + pad, sy, sw, sw);
    ctx.fillStyle = '#111';
    ctx.fillText(e.name, x + pad + sw + Math.round(fs * 0.8), ty);
    ty += rowH;
  }
  if (more > 0) {
    // **不再画「另有 N 组…」那一行了** ✓（用户：这个去掉 ✓）
    // more 还留着（只是个数字 ✓）万一以后想在别处用 ✓ 但图上不再画它 ✓
  }
  ctx.restore();
  // 画了标题也算"画到了东西" ✓（哪怕一条图例都没有 —— 不然调用方会误报"空的" ✗）
  return list.length + (title && !list.length ? 1 : 0);
}

/** 导出前统一调这个：勾了图例就画上去 ✓
 *  返回值：>0 = 画了几条；0 = 没勾"导出时显示"；**-1 = 勾了但没东西可画** ✓
 *  （-1 是为了能在提示里说清"为什么看不见" ✗ —— 以前它悄悄返回 0，啥也不说 ✓）
 */
function maybeDrawLegend(ctx, W, H) {
  /* **导出这一刻先把色块重算一遍** ✓（用户的主意：导出时才更新 ✓）
   * 换完剧本要是还没轮到那一帧重算，这里不补一刀的话，导出的图例还是上一层的 ✗
   * 列表那边同样只在「点开图例 / 导出」时才刷 ✓ 平时不打扰 ✓ */
  freshPaintBlocks();   // 跟"打开设置"用的是同一套 ✓ 口径一致 ✓
  if (!(state.set && state.set.legend)) return 0;
  try {
    const n = drawLegend(ctx, W, H);
    return n > 0 ? n : -1;
  } catch (e) { return 0; }   // 图例坏了不能连累导出 ✗
}

function paintedPoints(forNames = false) {
  // forNames=true 时**不看颜色开关**：玩家地名开了就该显示，
  // 跟「原版地名」「填色·颜色」开没开都没关系。
  if (!forNames && (state.showTitles || !state.showPaint)) return null;
  return state.paintBlocks;
}

// ================================================================ 启动

/* **启动分段计时** ✓（用户报"加载地图巨慢无比"✓ —— 先量出卡在哪一段，别瞎猜 ✗）
 *
 *  setBoot 本来就是**按阶段**调的（看看地图 → 元数据 → 头衔表 → 解压 id 图 →
 *  归属表 → 上传显卡 → 就绪 ✓），正好拿它当秒表用 ✓
 *  每次"阶段名变了"就报一次上一段花了多久，最后给个总账 ✓
 *  结果写进 PDXLOG（导出日志里能直接看到 ✓ 不用开控制台 ✓）
 */
let _bootPrevStep = '';
let _bootPrevAt = 0;
let _bootStartAt = 0;
let _bootLog = [];

function setBoot(step, pct) {
  if (step) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!_bootStartAt) _bootStartAt = _bootPrevAt = now;
    const dt = now - _bootPrevAt;
    if (_bootPrevStep) {
      _bootLog.push(`${_bootPrevStep} → ${step}  ${dt.toFixed(0)}ms`);
      if (window.PDXLOG) window.PDXLOG.event('加载耗时', `${_bootPrevStep} → ${step}: ${dt.toFixed(0)} ms`);
    }
    console.log(`[加载] ${_bootPrevStep || '开始'} → ${step}: ${dt.toFixed(0)} ms`);
    if (step === '就绪' && _bootStartAt) {
      const total = now - _bootStartAt;
      console.log(`[加载] **总耗时 ${(total / 1000).toFixed(2)} 秒**\n  ` + _bootLog.join('\n  '));
      if (window.PDXLOG) window.PDXLOG.event('加载总耗时', `${(total / 1000).toFixed(2)} 秒`);
    }
    _bootPrevStep = step;
    _bootPrevAt = now;
  }
  if (step) $('boot-step').textContent = step;
  if (pct != null) $('boot-bar').style.width = pct.toFixed(0) + '%';
}

const nextTick = () => new Promise((r) => setTimeout(r, 16));

/** 哪些地图真的能用 —— 单文件版看内嵌清单，走服务时探一下各自的 meta.json，
 *  最后再接上**玩家导入进来的地图包**（存在浏览器里那份，见 packstore.js）✓ */
async function availableMaps() {
  const out = [];
  if (isEmbedded()) {
    const keys = embeddedMapKeys();
    for (const m of MAP_CHOICES) if (keys.includes(m.emb)) out.push(m);
  } else {
    for (const m of MAP_CHOICES) {
      try {
        const res = await fetch(`${m.dir}/meta.json`, { method: 'HEAD' });
        if (res.ok) out.push(m);
      } catch (e) { /* 没有这套就跳'*/ }
    }
  }
  /* 导入的包：**读不出来不该挡住原版那几张** ✓
     （存储被清了、隐私模式、库坏了 —— 都只该少几张图，不该让人打不开编辑器 ✗）
     同一个作者 id 有多份时，第 2 份起在名字后面标「第 N 份」——
     不然两张卡片长得一模一样，玩家根本分不清哪个是哪个 ✗ */
  try {
    const recs = await listPacks();
    const nth = {};
    for (const r of recs) {
      const mid = r.manifestId || r.id;
      nth[mid] = (nth[mid] || 0) + 1;
      out.push(packEntry(r, nth[mid]));
    }
  } catch (e) {
    LOG.error('读已导入的地图包失败（原版那几张不受影响）', e);
  }
  return out;
}

/* ============================================================================
 * 导入式地图：选图界面那一套（见 docs/导入式地图-策划.md 第 4 节）
 *
 * 三件事：① 导入入口（点一下 / 拖进来）② 导入过程的人话进度
 *         ③ 已导入的图怎么管（导出备份 / 删除）
 *
 * 两条铁律：
 *   · **进到界面上的字符串一律 textContent** ✗ —— label / note / author
 *     全是陌生人写的，拼进 innerHTML 就是一个能在玩家机器上跑的脚本 ✓
 *   · 失败**只说人话 + 出在哪个文件**，同时进报错日志（旁边给个"复制详情"）✓
 *
 * ⚠ **导入只增不改**（2026-10-11 按廿九的要求改的）：
 *   同一个包导两次就是两张图，作者的 id 只用来展示和认重，**
 *   任何已导入的图都不会被后来的导入改动** ✓
 *   唯一会拦一下的是"逐文件 sha256 一模一样的那一份"——那多半是手滑重复导入，
 *   问一句再决定（确认了也是新增一张，绝不替换）✓
 * ========================================================================== */

/** 正在导入（防手滑点两下 / 拖两次） */
let _importing = false;

/**
 * 把库里的一条记录变成选图界面要的那张卡片。
 *
 * ⚠ `key` 用的是**实例键**（`rec.id`）而不是作者写的 id ✗ ——
 * 导入是"只增不改"，同一个包导两次就是两条记录、两张卡片 ✓
 * 所以卡片、涂色、删除、导出**全都认实例键**，作者 id 只用来展示和认重 ✓
 *
 * @param {object} rec   库里的记录（id = 实例键，manifest，size）
 * @param {number} [nth] 同一个作者 id 的第几份（**从 1 数** ✓ 只有一份时界面上不标）
 */
function packEntry(rec, nth) {
  const m = rec.manifest || {};
  const size = rec.size || 0;
  return {
    key: 'pack:' + rec.id,
    pack: rec.id,                     // boot 认这个字段：有它就走导入的包
    game: GAMES[m.game] ? m.game : 'ck3',
    /* ⚠ 名字就是名字，**不往里面塞"（第 2 份）"** ✗ ——
       重复的那几份靠卡片左上角那个**小序号**区分 ✓（2026-10-12 用户改的 ✓
       塞进名字里会把名字撑长，两张卡还是得逐个读字才分得出 ✓）*/
    label: m.label || m.id || rec.id,
    nth: nth || 0,                    // 同一张图的第几份（界面上只用它画那个小序号 ✓）
    note: m.note || '',
    author: m.author || '',
    version: m.version || '',
    size,
    manifestId: m.id || rec.id,
    imported: true,
  };
}

/** 进度 / 结果那一条（**只吃字符串**，一律当文字显示） */
function setPackMsg(kind, text, pct) {
  const box = $('map-msg');
  if (!box) return;
  box.hidden = false;
  /* 用 classList 而不是 className：这套界面别的地方也是这么写的，
     而且桩（tools/lib/browser_stub.js）只同步 classList ✓ */
  box.classList.remove('busy', 'bad', 'done');
  if (kind) box.classList.add(kind);
  box.textContent = String(text == null ? '' : text);   // 陌生人写的字符串 → 永远当文字 ✓
  if (kind === 'busy' && pct !== undefined && pct !== null) {
    const bar = document.createElement('div');
    bar.className = 'map-msg-bar';
    const i = document.createElement('i');
    i.style.width = Math.max(0, Math.min(100, Number(pct) || 0)).toFixed(0) + '%';
    bar.appendChild(i);
    box.appendChild(bar);
  }
  if (kind === 'bad') {
    // 报错详情早进日志了；这里给一条"复制详情"的路，玩家好发过来 ✓
    const b = document.createElement('button');
    b.className = 'btn tiny';
    b.textContent = '复制详情';
    b.onclick = () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(LOG.text());
          b.textContent = '复制好了 ✓';
        } else {
          b.textContent = '复制不了，走「导出 ▾ → 导出日志」';
        }
      } catch (e) {
        b.textContent = '复制不了，走「导出 ▾ → 导出日志」';
      }
    };
    box.appendChild(b);
  }
}

function clearPackMsg() {
  const box = $('map-msg');
  if (box) { box.hidden = true; box.textContent = ''; }
}

/**
 * 清掉某张图存的**涂色暂存**。
 * 只在**删图**的时候问一句要不要顺手清 ✓
 * （以前覆盖版本时也调它 —— 现在导入只增不改，那条路没了 ✓）
 *
 * 🔴 **只动 `STASH_KEY`，绝不许碰 `SET_KEY`** ✗（2026-10-12 廿九定的 ✓）
 *   设置 / 最近颜色现在按**游戏类型**存（`prefsKeyOf`），不归任何一张图 ✓
 *   在这儿顺手把 SET_KEY 里那条删掉的话，删一张图会把**同款游戏所有图**的
 *   设置一起清空 ✗（而且现在那 key 就是游戏名，删的正好是整份 ✓）
 */
function forgetMapPaint(key) {
  if (!key) return;
  try {
    const box = JSON.parse(localStorage.getItem(STASH_KEY) || '{}') || {};
    if (box[key] !== undefined) {
      delete box[key];
      localStorage.setItem(STASH_KEY, JSON.stringify(box));
    }
  } catch (e) { /* 存不进去就算了 —— 清理失败不该挡住删除 */ }
}

/**
 * 导入一个包（点选 / 拖拽 / 将来创意工坊下载完，都走这一个入口）✓
 *
 * **只增不改**：成功就是"又多了（或多了第一张）一张图" ——
 * 之前导入的图一个字节都不动 ✓
 * **一模一样的那一份也照导** ✗（2026-10-12 用户要求：不再弹窗问"要再导一份吗"）——
 * 库里就多一张，旧的绝不替换 ✓ 哪份是哪份看卡片左上角那个小序号 ✓
 *
 * @param {Blob} blob
 * @param {(r: {manifest: object, key: string, sameMap: number}) => void} [onDone] 成了就回调
 * @returns {Promise<boolean>}
 */
async function importPackFlow(blob, onDone) {
  if (_importing) return false;
  _importing = true;
  setPackMsg('busy', '正在导入…', 0);
  const opt = {
    onProgress: (msg, pct) => setPackMsg('busy', msg, pct),
    onNote: (msg) => { LOG.event('地图包', msg); },
  };
  try {
    let r;
    try {
      r = await importPack(blob, opt);
    } catch (e) {
      if (!e || e.code !== 'DUPLICATE') throw e;
      /* 库里已经有一份一个字节都不差的了 —— **不再问，直接再导一份** ✗
         （2026-10-12 用户要求：多一张就多一张，别为这个多按一次"确定" ✓
          两张各自独立、涂色互不影响、原来那张一个字节不动 ✓
          哪份是哪份，看卡片左上角那个小序号 ✓
          ⚠ 库里那道 DUPLICATE 检查**留着** ✗ —— 它挡的是"同一次流程里被写两遍"
            这种意外，不是要弹给玩家看的问句 ✓）*/
      r = await importPack(blob, Object.assign({ allowDuplicate: true }, opt));
    }
    /* ⚠ 后面那截"（HOI4 · 20006 个地块 · 5120×2560）"**删了** ✗（2026-10-12 用户要求）
       —— 提示只报"哪张图进去了"就够；尺寸和地块数卡片上那一栏本来就有 ✓ */
    setPackMsg('done', `成功导入地图：${r.manifest.label}`
      + (r.sameMap > 1
          ? ` —— 这是这张图的第 ${r.sameMap} 份，之前那 ${r.sameMap - 1} 份都留着`
          : ''));
    LOG.event('导入地图包', `${r.key}（${r.sameMap > 1 ? '第 ' + r.sameMap + ' 份' : '新增'}）✓`);
    if (onDone) await onDone(r);               // 等界面刷完再收工（不然调用方以为还没好）
    return true;
  } catch (e) {
    setPackMsg('bad', '导入失败：' + (e && e.message ? e.message : e));
    LOG.error('导入地图包失败', e);
    return false;
  } finally {
    _importing = false;
  }
}

/** 让玩家挑一张。只有一套、而且没有导入入口时才直接进 */
function pickMap(maps) {
  return new Promise((resolve) => {
    const box = $('map-pick');
    const list = $('map-pick-list');
    const fileInput = $('pack-file');
    let current = maps.slice();

    /* 这行平时**不显示** ✗ —— 只有"这台浏览器存不下东西"的时候才跳出来警示：
       不说的话玩家会以为存上了，第二天发现没了还以为是编辑器坏的 ✓ */
    packStoreMode().then((mode) => {
      const hint = $('map-import-hint');
      if (!hint) return;
      if (mode === 'memory') {
        hint.hidden = false;
        hint.classList.add('warn');
        hint.textContent = '⚠ 这台浏览器不让存本地数据（或是隐私模式）：导入的图**刷新就没了**，自己的原文件请留好';
      } else {
        hint.hidden = true;
        hint.classList.remove('warn');
        hint.textContent = '';
      }
    }).catch(() => {});

    /* 🔴 两个动作**直接摆在卡片上** ✗ —— 原来藏在卡片右上角那个「⋯」小面板里，
       用户 2026-10-12 要求提上来（多一次点击才看得见，不值当 ✓）
       面板连元素带样式整个拆了：`#pack-menu` / `.map-more` 都不再有 ✓ */
    async function doExportPack(id) {
      setPackMsg('busy', '打包备份…', 5);
      try {
        let label = id;
        try {
          const rec = await getPack(id);
          label = (rec && rec.manifest && rec.manifest.label) || id;
        } catch (e) { /* 读不到就用 id 当名字 */ }
        const bytes = await exportPackBytes(id, (msg) => setPackMsg('busy', msg, 60));
        const blob = new Blob([bytes], { type: 'application/zip' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = id + '.pdxmap';
        a.click();
        setPackMsg('done', `成功导出地图：${label}`);
      } catch (e) {
        setPackMsg('bad', '导出失败：' + (e && e.message ? e.message : e));
        LOG.error('导出地图包备份失败', e);
      }
    }

    async function doDeletePack(id) {
      let label = id;
      try {
        const rec = await getPack(id);
        label = (rec && rec.manifest && rec.manifest.label) || id;
      } catch (e) { /* 读不到就用 id 当名字 */ }
      if (typeof window.confirm === 'function'
          && !window.confirm('是否删除该地图？')) return;
      try {
        await removePack(id);
        /* 🔴 **涂色跟着一起删，不再问** ✗（用户 2026-10-12 定的 ✓）
           以前会多问一句"要不要同时清掉这张图的涂色"—— 留着只有
           "下次重新导入同一个包"才用得上，为这个多按一次"确定"不值当 ✓
           ⚠ 但**设置 / 最近颜色不能碰**：它们按游戏类型存，不归这张图 ✓
             （见 forgetMapPaint 那段说明 ✓）*/
        forgetMapPaint('pack:' + id);
        current = current.filter((x) => x.pack !== id);
        render();
        setPackMsg('', `成功删除地图：${label}`);
      } catch (e) {
        setPackMsg('bad', '删不掉：' + (e && e.message ? e.message : e));
        LOG.error('删除地图包失败', e);
      }
    }

    /** 导入成功后：把新卡片接进列表，高亮一下（**不自动进去**，玩家自己点 ✓） */
    const afterImport = async (r) => {
      let rec = null;
      try {
        rec = await getPack(r.key);
      } catch (e) { /* 读不到记录不影响用，下面用返回值兜底 */ }
      if (!rec) rec = { id: r.key, manifest: r.manifest, size: 0 };
      /* 同一个作者 id 现在有几份了：第 2 份起名字后面标「第 N 份」✓
         （两张卡长得一模一样的话，玩家根本分不清哪个是哪个 ✗） */
      const mid = rec.manifestId || (rec.manifest && rec.manifest.id) || rec.id;
      const n = current.filter((x) => x.manifestId === mid).length + 1;
      const e = packEntry(rec, n);
      const i = current.findIndex((x) => x.pack === e.pack);
      if (i >= 0) current[i] = e; else current.push(e);
      render(e.key);
    };

    const render = (flashKey) => {
      list.innerHTML = '';
      /* 一张卡都没有的时候说一句人话 ✗
         （轻量版第一次打开就是这样：0.6 MB 的编辑器 + 还没导入任何地图包 ✓）
         不说的话玩家看到的是"空白的选单 + 一个导入按钮"——
         他不知道自己是不是漏了什么，也不知道下一步该干嘛 ✓
         ⚠ 2026-10-12 用户要求：这句话**搬进下面那个提示框**（跟"成功导入地图…"
           同一个框 ✓）—— 原来它在列表**上面**单独占一整块，白花一块地方 ✗
         ⚠ 提示框里**已经有话**的时候（正在导入 / 报错 / 刚导完成）别去盖它 ✗ */
      if (!current.length) {
        const msgBox = $('map-msg');
        if (msgBox && msgBox.hidden) {
          setPackMsg('', '请点击导入按钮，或将 .pdxmap 文件直接拖进这一页。');
        }
      }
      /* 🔴 **一律一列** ✓（2026-10-17 用户："统一变成列表形式，多的时候塞进列表
       *   而不是塞进两列"）—— 卡片多就**列表自己滚**（CSS 的 max-height ✓），
       *   不再改列数、也不再放宽启动面板 ✓ */
      for (const m of current) {
        const b = document.createElement('button');
        b.className = 'map-card' + (m.imported ? ' imported' : '');
        /* ⚠ 这里原来是把 label 直接拼进 innerHTML 的 ✗
           原版那几张的 label 是我们自己写死的，拼就拼了；
           可导入的包是**陌生人给的文件**，label / note / author 全是他写的 ✓
           一个 <img src=x onerror=...> 就是一个能在玩家机器上跑起来的脚本 ✗
           所以改成建节点 + textContent（一个字符都不当 HTML 解释）*/
        const bName = document.createElement('b');
        bName.textContent = m.label;
        const bNote = document.createElement('span');
        bNote.textContent = m.note || '';
        /* 同一张图导了好几份时，**左上角标个小序号**（1 / 2 / …）✓
           ⚠ 只有一份时**不标** ✗ —— 每张卡都挂个"1"是噪音 ✓
           （名字里不再塞"（第 2 份）"，就靠它认是哪一份 ✓ 2026-10-12 用户定的）*/
        const dupN = current.filter((x) => x.manifestId === m.manifestId).length;
        if (m.imported && dupN > 1 && m.nth) {
          const no = document.createElement('span');
          no.className = 'map-card-no';
          no.textContent = String(m.nth);
          no.title = `这是《${m.label}》的第 ${m.nth} 份`;
          b.classList.add('has-no');        // 左边多让一点位置给这个序号 ✓
          b.appendChild(no);
        }
        b.appendChild(bName);
        b.appendChild(bNote);
        if (m.imported) {
          const tag = document.createElement('span');
          tag.className = 'map-card-tag';
          /* 作者**不显示**了 —— 这批包基本同一个作者，挂上去只是噪音 ✗
             （字段本身留着：外来的包爱写就写，界面就是不露 ✓） */
          /* ⚠ 「已导入」三个字**去掉了** ✗（2026-10-12 用户要求）——
             卡片右下角那两个"导出 / 删除"本身就说明它是导入进来的 ✓
             这一栏只剩版本号（没写版本号就整个空着 ✓）*/
          tag.textContent = m.version ? 'v' + m.version : '';
          b.appendChild(tag);
          /* 两个动作**直接摆在卡片上**（右下角，跟左下角那栏版本号（v…）同一行 ✓）
             —— 上面那种"藏在 ⋯ 弹窗里"多一次点击才看得见，用户要求提上来 ✓
             ⚠ 它们必须**自己吃掉点击** ✗ 不然点按钮 = 点了卡片 = 直接进图 ✓ */
          const acts = document.createElement('span');
          acts.className = 'map-card-acts';
          const mkAct = (text, danger, fn) => {
            const x = document.createElement('span');
            x.className = 'map-act' + (danger ? ' danger' : '');
            x.textContent = text;
            x.onclick = (ev) => {
              if (ev && ev.stopPropagation) ev.stopPropagation();
              if (ev && ev.preventDefault) ev.preventDefault();
              /* ⚠ **必须把 Promise 返回出去** ✗ —— 自测走的是 `await 按钮.onclick(...)`，
                 不 return 的话它拿到 undefined 就往下跑，导出/删除还在后台跑 ✓（踩过 ✓）
                 真浏览器不看返回值，返回了也没副作用 ✓ */
              return fn();
            };
            return x;
          };
          acts.appendChild(mkAct('导出', false, () => doExportPack(m.pack)));
          acts.appendChild(mkAct('删除', true, () => doDeletePack(m.pack)));
          b.appendChild(acts);
        }
        b.onclick = () => {
          box.hidden = true;
          dropOff();
          resolve(m);
        };
        list.appendChild(b);
        if (flashKey && m.key === flashKey) {
          b.classList.add('flash');
          setTimeout(() => { try { b.classList.remove('flash'); } catch (e) {} }, 1500);
        }
      }
    };

    // ---- 导入入口：点一下 ／ 拖进来（**都可以一次好几个** ✓ 2026-10-12 用户要求）
    const onImportClick = () => {
      if (_importing) return;
      if (fileInput) fileInput.click();
    };
    /** 挨个导 ✓ 一个不成不影响后面的 ✓
     *  **提示照旧** ✗ —— 每次 importPackFlow 自己会说那一句，这里不另报总数
     *  （多选时屏幕上留的就是最后那一张的提示 ✓ 用户 2026-10-12 定的 ✓
     *    "这是第几份"改由卡片左上角那个**小序号**说 ✓）*/
    const importMany = async (files) => {
      const todo = Array.from(files || []).filter(Boolean);
      for (const f of todo) await importPackFlow(f, afterImport);
    };
    const onFilePicked = async () => {
      const files = fileInput && fileInput.files;
      if (!files || !files.length) return;
      await importMany(files);
      try { fileInput.value = ''; } catch (e) { /* 清不掉无所谓，别连累导入 */ }
    };
    const onDragOver = (ev) => {
      if (box.hidden) return;
      if (ev && ev.preventDefault) ev.preventDefault();   // 不拦的话浏览器会拿文件当导航 ✗
    };
    const onDrop = async (ev) => {
      if (box.hidden) return;
      if (ev && ev.preventDefault) ev.preventDefault();
      const dt = ev && ev.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      await importMany(dt.files);
    };
    const dropOff = () => {
      const boot = $('boot');
      if (boot && boot.removeEventListener) {
        boot.removeEventListener('dragover', onDragOver);
        boot.removeEventListener('drop', onDrop);
      }
    };

    $('map-import').onclick = onImportClick;
    if (fileInput) fileInput.onchange = onFilePicked;
    const bootBox = $('boot');
    if (bootBox && bootBox.addEventListener) {
      bootBox.addEventListener('dragover', onDragOver);
      bootBox.addEventListener('drop', onDrop);
    }

    clearPackMsg();
    render();
    box.hidden = false;
    /* 只有一套、而且这一套就是导入来的？那也得让人看见导入入口 ✓
       所以这里**不再**"只剩一张就跳过界面"：
       跳过了，玩家就永远没有第二个入口了 ✗（单文件版本来就有六七张，不受影响） */
  });
}
// ---- 崩溃上屏：未捕获异常/未处理的 Promise 直接显示在页面上 ----
// 白屏最难受的不是出错，是"错看不见" ✗ —— 有了这个，刷新一下就能看到
// 出错的文件、行号和前几层调用栈。
function showFatal(msg) {
  try {
    // **同一条错只上屏一次** ✓ —— 帧循环里的错一秒钟能刷 60 条，
    // 把屏幕铺满反而看不见第一条（第一条才是真正的原因 ✓）
    const key = String(msg).slice(0, 200);
    state._fatals = state._fatals || new Map();
    const n = (state._fatals.get(key) || 0) + 1;
    state._fatals.set(key, n);
    if (n > 3) return;                       // 前三条留证据，后面的丢掉

    let box = document.getElementById('fatal-box');
    /* 「结构建过没有」不能只看 `!box` —— 测试那套桩（tools/lib/browser_stub.js）
     * 里"取不到的 id"会**现造一个空 div 返回**，于是永远走不进这个分支、
     * 按钮就长不出来 ✗ 用 dataset 打个标记，真实浏览器和桩都准 ✓
     */
    if (!box || !box.dataset || box.dataset.pdxBuilt !== '1') {
      /* 结构是「容器 + <pre> + 一颗按钮」——
       * 以前 box 本身就是那个 <pre>，靠 `textContent +=` 往里加字；
       * 一旦里面放了按钮，加字就会把按钮一起抹掉 ✗（textContent 是整体替换）
       * 所以文字加到里层那个 <pre>，按钮挂在外层 ✓
       */
      if (!box) box = document.createElement('div');
      box.id = 'fatal-box';
      box.dataset.pdxBuilt = '1';
      box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;'
        + 'max-height:45%;overflow:auto;padding:10px 12px;'
        + 'background:rgba(120,10,10,.94);color:#fff;'
        + 'font:12px/1.6 ui-monospace,Consolas,monospace;'
        + 'border-top:2px solid #ff6b6b';
      const pre = document.createElement('pre');
      pre.id = 'fatal-text';
      pre.style.cssText = 'margin:0;white-space:pre-wrap;font:inherit';
      box.appendChild(pre);
      // 出事现场最该有的两颗按钮：日志要能导、面板要能关 ✓
      // 🔴 **以前只有"导出日志"这一颗 ✗ 于是这个条一旦弹出来就永远关不掉** ✓
      //   （用户报："报错弹窗不知道为什么会一直显示" ✓ 就是这个 ✓
      //     它固定在屏幕底部、`position:fixed; bottom:0` ✗ 手机上还占 45% 高 ✓
      //     没有关闭入口 = 一旦有错就永久挡着半屏 ✓）
      const bar = document.createElement('div');
      bar.style.cssText = 'margin-top:10px;display:flex;gap:10px;align-items:center';
      const btn = document.createElement('button');
      btn.id = 'fatal-log';
      btn.type = 'button';
      btn.textContent = '导出诊断报告';
      btn.style.cssText = 'padding:5px 14px;cursor:pointer;'
        + 'background:#fff;color:#7a0a0a;border:0;border-radius:4px;font:inherit';
      btn.onclick = (ev) => { ev.stopPropagation(); exportLog(); };
      bar.appendChild(btn);
      /* 🔴 **「刷新重试」那颗** ✗✗（2026-10-17）
       *   显卡上下文丢失 / 显存紧张这类失败，**刷新一次经常就好了** ✓
       *   以前这个红条只有"导出日志"和"关掉"，玩家只能自己想起来按 F5 ✓ */
      const reload = document.createElement('button');
      reload.id = 'fatal-reload';
      reload.type = 'button';
      reload.textContent = '刷新重试';
      reload.style.cssText = 'padding:7px 20px;cursor:pointer;font:inherit;'
        + 'background:#fff;color:#7a0a0a;border:0;border-radius:4px';
      reload.onclick = (ev) => {
        ev.stopPropagation();
        try { window.location.reload(); } catch (e) { /* 测试桩 / 特殊环境 ✓ */ }
      };
      bar.appendChild(reload);
      /* 「关掉」那颗 ✓ —— 手机上手指粗，按钮做大一点 ✓ */
      const close = document.createElement('button');
      close.id = 'fatal-close';
      close.type = 'button';
      close.textContent = '关掉';
      close.style.cssText = 'padding:7px 20px;cursor:pointer;font:inherit;'
        + 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6);border-radius:4px';
      close.onclick = (ev) => { ev.stopPropagation(); box.remove(); };
      bar.appendChild(close);
      box.appendChild(bar);
      /* ⚠ **整条也能点着关** ✓ —— 手机上找按钮容易点偏 ✓
       *   但按钮自己要先 stopPropagation ✗ 不然想点"导出日志"反而把它关了 ✓ */
      box.onclick = () => box.remove();
      document.body.appendChild(box);
    }
    const pre = document.getElementById('fatal-text');
    if (pre) pre.textContent += msg + (n > 1 ? `   （同一处，第 ${n} 次）` : '') + '\n';
  } catch (e) { /* 上屏都失败就算了 */ }
}
/**
 * 🔴 **黑屏时也要能看见报错** ✗（用户报"手机版黑屏、什么也看不见" ✓）
 *
 * 为什么不用 showFatal ✗ —— 它是条**有样式**的红条 ✓ 而黑屏多半发生在
 *   **着色器编译失败** 或 **很早的初始化** 里 ✓ 那会儿页面还没正常起来 ✓
 *   华丽的条不一定画得出来 ✓（而且它挂在 bottom ✓ 有的机型上会被盖住 ✓）
 *
 * 这里用最原始的东西：一个 inline style 的 <pre>，插到 **body 最前面** ✓
 *   `position:fixed; top:0; z-index:最大值` ✓ 别的全黑它也看得见 ✓
 * ⚠ 只在**出错时**才插 ✗ 正常页面干干净净 ✓
 * ⚠ 它和 showFatal 是**两条路** ✗ 都留着：一个给人看细节、一个保证看得见 ✓
 */
/**
 * 🔴 **启动里程表**（`#diag` 打开，默认不显示）—— 用户报"手机版黑屏、也没有报错条" ✓
 *
 * 为什么需要它 ✗：黑屏如果**没有异常** ✓ 那错误捕获就一点用没有 ✓
 *   （着色器编译失败会抛 ✓ 但"画出来是黑的"不会抛 ✓）
 *   → 那就需要一条**不用等出错、一直在那儿**的文字 ✓
 *   它一路打勾：停在哪儿，就知道是哪一步 ✓✓
 *
 * ⚠ 默认**一个字都不显示** ✗ 桌面版、手机版的页面都干干净净 ✓
 *   要看它：地址后面加 `#diag` 再打开 ✓
 *   （手机上：把文件路径改成 `…/pdx-map-editor.html#diag` ✓
 *     或者排障时在控制台敲 `__PDX_DIAG_ON()` ✓）
 * ⚠ 用最原始的东西（inline style + <div>）✗ 不依赖任何样式表 ✓
 *
 * ⚠ **它以前是彻底哑的** ✗（函数体第一行就是 `return` ✓）——
 *   文档里写着"手机版上留了启动里程表"，实际一个像素都没有 ✓
 *   于是"手机黑屏、不知道什么缘故"这件事**连排障工具都没得用** ✓
 *   → 现在是"开关一开就能用"，而不是"要改代码才有" ✓
 */
let _markEl = null;
function bootMark(txt) {
  if (!DIAG) return;
  try {
    if (!_markEl) {
      _markEl = document.createElement('pre');
      _markEl.id = 'boot-mark';
      _markEl.style.cssText = 'position:fixed;left:4px;top:4px;z-index:2147483647;'
        + 'margin:0;padding:2px 6px;max-width:92vw;font:12px/1.45 monospace;'
        + 'color:#5f5;background:rgba(0,0,0,.6);pointer-events:none;'
        + 'white-space:pre-wrap;word-break:break-all';
      document.body.appendChild(_markEl);
    }
    _markEl.textContent = txt;
  } catch (e) { /* 上屏失败不能连累启动 ✓ */ }
}

/*: 排障模式（`#diag` / `?diag`）—— 里程表和 gl.js 那几处逐帧探针都看它 ✓
 *  ⚠ **一处开、两处用** ✗：gl.js 读的是 window.__PDX_DIAG（它排在 app.js 前面 ✓）
 *  ⚠ 是 `let` 不是 const ✗ —— 控制台里 `__PDX_DIAG_ON()` 要能当场打开（见下 ✓） */
let DIAG = (() => {
  try {
    if (typeof location === 'undefined' || !location) return false;
    return /(^|[#&?])diag\b/.test(String(location.hash || '') + String(location.search || ''));
  } catch (e) { return false; }
})();
try { window.__PDX_DIAG = DIAG; } catch (e) { /* ✓ */ }
/* 排障时也能现开：控制台敲 __PDX_DIAG_ON() —— 不用刷新，这一趟就能看着 ✓ */
try {
  const turnOn = () => {
    DIAG = true;
    window.__PDX_DIAG = true;
    bootMark('排障已打开 ✓（里程表从这一条开始）');
  };
  window.__PDX_DIAG_ON = turnOn;
  /* ⚠ 光看启动那一刻的 hash 不够 ✗ —— 往地址栏后面补 `#diag` **不会重载页面** ✓
   *   （同文档导航：浏览器只挪个锚点 ✓）于是用户"加了 #diag 却什么都没出现" ✓
   *   → 监听 hashchange：补上就当场开 ✓（问号那一路 `?diag=1` 本来就会重载 ✓）*/
  window.addEventListener('hashchange', () => {
    if (DIAG) return;
    try {
      if (/(^|[#&?])diag\b/.test(String(location.hash || ''))) turnOn();
    } catch (e) { /* ✓ */ }
  });
} catch (e) { /* ✓ */ }

function rawErr(msg) {
  /* 排障用的顶部红条 —— **正式版不显示** ✓
   * 它在手机版黑屏那阵很有用：出错就能看见，不用连电脑看控制台 ✓
   * ⚠ 但手机上有一种**查不了的**东西会不停冒出来：
   *     Script error. @ :0   （没有文件名、没有行号）
   *   那是浏览器对**本地文件**里某些异常做的跨域屏蔽 ✓ 细节永远拿不到 ✓
   *   实测它由导出时那句 a.click() 引起，而**下载本身是成功的** ✓
   *   → 一条无害的噪音被红条报出来，比没有提示更糟（用户以为出错了）✓
   * ⚠ 出错上屏这件事**已经有人管**：showFatal 那个面板 ✓ 它是正式的 ✓
   *   所以这里静音，不是把"报错"关掉，是把**排障通道**关掉 ✓
   * 要再排障：去掉下面这个 return ✓ */
  return;
  void msg;
}
window.addEventListener('error', (e) => {
  /* ⚠ 两条路都走 ✗ 别只留一条 —— rawErr 保证"黑屏时也看得见" ✓ */
  rawErr('✗ ' + (e.message || 'error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0)
    + (e.error && e.error.stack ? '\n' + String(e.error.stack).split('\n').slice(0, 4).join('\n') : ''));
  showFatal(`✗ ${e.message}\n  ${e.filename || ''}:${e.lineno || 0}`
    + (e.error && e.error.stack
       ? '\n' + String(e.error.stack).split('\n').slice(1, 4).join('\n') : ''));
});
window.addEventListener('unhandledrejection', (e) => {
  /* 未处理的 Promise 拒绝也要上屏 ✓ 手机上多半是它 ✓ */
  try { rawErr('✗ 未处理的 Promise 拒绝：' + ((e.reason && (e.reason.message || e.reason)) || '?')); } catch (err) { /* ✓ */ }
  showFatal('✗ Promise 未处理: '
    + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

/* ---- 关页面 / 刷新前提醒一次 ------------------------------------------------
 * README 里写着"涂色不会自动保存"（故意的 ✓），可**"故意的"不等于用户记得住** ✗
 * 真按 F5 把半小时的涂色丢掉，再回来看那句说明一点安慰都没有 ✓
 * 所以：**有改动、且还没导出过**才问一句 ✓
 *   · 点了导出涂色 / 导入过工程 → 认为你手上有备胎，不再打扰 ✓
 *   · "回主菜单"那条路有自己的暂存（goHome → stashNow）→ 也不算丢 ✓
 */
window.addEventListener('beforeunload', (e) => {
  if (!state.meta || state._exported) return;
  if (!(state.changed && state.changed.size)) return;
  e.preventDefault();
  e.returnValue = '';     // Chrome 要这一句才认
});

// ================================================================ 显存那份数据 & 上下文恢复
//
// 手机切到别的 App / 锁屏 / 切标签页，回来时画面是黑的 —— 这条在手机上几乎是必然的：
//   · 手机会把 WebGL 上下文**整个收走**（省显存，尤其 iOS ✓）
//   · 上下文一丢，显存里**所有东西都没了**：地图 id 图、归属表、颜色表、你涂的那层 ✓
//   · 以前只接住了 lost（还给浏览器 preventDefault 了 ✓）**却没接 restored** ✗
//     → 回来时上下文是好的、显存里空着、`dirty` 还是 false → **再也不画** ✓ 一直黑 ✓
//
// 现在：gl.js 那边把"跟上下文绑的"重建 ✓ 这里把**数据**重新喂一遍 ✓
//   ⚠ 笔迹不用管 ✗ —— `paintData` 是 CPU 那边的数组 ✓ 一直好好的 ✓
//     （setData 里特意加了"尺寸对得上就留着"，不然重喂一次就等于把涂色擦了 ✓）

/**
 * 把地图数据推给显卡。
 * 开图时跑一次 ✓ 上下文丢了又回来时**再跑一次** ✓
 *
 * @param {(name: string) => void} [tick] 开图那条路的细分计时（恢复时不传 ✓）
 */
async function uploadMapToGpu(tick) {
  const say = typeof tick === 'function' ? tick : () => {};
  await renderer.setData({
    provinceIds: state.provinceIds,
    titlemap: state.titlemap,
    colors: state.titles.colors,
    // 分块清单**必须传进去** ✗ —— 少了这一行，渲染器会按"整图模式"建
    // 16384×8192 的纹理，却只拿到 1 个元素的占位数组 → WebGL 报
    // "ArrayBufferView not big enough"、纹理不完整 → 画面全白。
    tiles: state.tiles || null,
  });
  say('上传地图纹理');
  // （`renderer.setProvColors` / `setWaterMask` 两句已删 ✓
  //   「水域 · 颜色」色源与水域标签都不再喂给渲染器 ✓ 数据留在 state 备查 ✓
  //   —— gl.js 那边的对应 uniform / API 由另一位同步拆，两边口径一致 ✓）
  /* **最细层层号**要告诉渲染器（2026-10-17 重做 ✓）——
   *   荒地自动色记在每块荒地自己的 `wl_<pid>` 节点上，着色器按 `uFineTier` 查 ✓
   *   ⚠ 别用 `uEditTier` ✗：剧本视图没开粒度时它 = 剧本层，荒地在那儿根本没有节点 ✓ */
  try {
    const _nt = (state.meta && Array.isArray(state.meta.tiers)) ? state.meta.tiers.length : 0;
    if (_nt > 0 && renderer && renderer.setFineTier) renderer.setFineTier(_nt - 1);
  } catch (e) { /* ✓ */ }
  // **每块荒地的 LUT 起手 = 荒地灰** ✓（那才是它"没上色"的样子）
  paintWasteGrey();
  say('荒地起手灰');
  syncParentBorder();
  /* **把接回来的设置推给渲染器** ✓（只在面板里改过才 applySettings 是不够的 ✗
   *   刷新/回主菜单后那份设置得在**开图时**就生效 ✓）*/
  applySettings();
  syncAllPaintLabels();
  /* 🔴🔴 **荒地：不管哪个视图都显示"荒地色"** ✗✗（2026-10-17 ✓ 用户定的 ✓）
   *   原话："**荒地不管什么视图都是荒地颜色**，就这样"✓
   *
   *   ⚠ **必须排在这儿** ✗✗（我第一版放在 `openMap` 里、栽了）：
   *     `openMap` 那条链上 `renderer` 是**后面**才 `new MapRenderer(...)` 的 ✓
   *     我提前几十行就调 `setWasteFixed` → 那时 `renderer` 还是 **null** ✓
   *     那句 `if (renderer && ...)` 直接跳过 → **一块都没打上** ✓
   *     （而 `renderer.setData` 就是本函数第一句 ✓ LUT 到这儿已经建好 ✓）
   *   ⚠ 放这儿还白赚一件事 ✗：**上下文丢失恢复**时这个函数会再跑一遍 ✓
   *     标记跟着重建的 LUT 一起补回来 ✓（不然切个后台回来标记就没了 ✓）
   *
   *   ⚠ 靠什么生效 ✗：把标记打在 **LUT 的 alpha 通道**上 ✓
   *     着色器在 `tid == NONE` 那道早退**之前**先查它 ✓
   *     （剧本层荒地永远没归属 → 不查就被 `uUnpainted`(150,150,150) 盖掉 ✗
   *       —— 用户报的"剧本模式把荒地颜色覆盖了，明明画好了却还是 150,150,150"✓）
   *   ⚠ 名单用**现成的** `meta.wasteland` ✗（`isWastelandTid()` 读的就是它 ✓）——
   *     别自己拿 `kindTidMap()` 筛 kind 6 ✗：实测 EU4 那份身份标里
   *     **kind=6 一条都没有**（只有海 / 湖 ✓）→ 清单空 → 一块都打不上 ✓
   *     （用户点破的："你自己看看为什么**海洋都是蓝色**，抄一份代码过去不就好了吗"✓）
   *   ⚠ 那份色就是设置里「不可通行区域」那一行的颜色 ✓
   *     `applySettings()`（上一句）刚按它刷过 LUT ✓ 这里只打"认它"的标记 ✓ */
  try {
    const _wl = new Set((state.meta && state.meta.wasteland) || []);
    /* 再补上**我们自己认出来的**逐块节点 ✓（有的包 meta.wasteland 只登记了粗层那片，
     *   最细的 wl_<pid> 没进去 → 只按名单打会漏标 ✓）*/
    if (state.wasteFineTid) {
      for (const t of state.wasteFineTid) if (t >= 0) _wl.add(t);
    }
    if (renderer && renderer.setWasteFixed) renderer.setWasteFixed(_wl);
  } catch (e) { /* 打不上标记不该拖垮开图 ✓ */ }
  /* 标记打好之后立刻算一遍自动色（第一帧之前就位 ✓）
   *   ⚠ 顺序不能反 ✗：先 setWasteFixed 打 alpha，再把 RGB 写成算出来的色 ✓
   *     `setLutColor` 只改 RGB、不动 alpha ✓ 标记不会丢 ✓ */
  try { state._wasteSig = null; refreshWasteAuto(); } catch (e) { /* ✓ */ }
  reuploadTiles();
  say('设置 + 标签同步');
}

/**
 * 分块那条路（EU5 原尺寸）：把**已经读过、在缓存里的块**重新传上去 ✓
 *   上下文一丢，显存里那些块就没了 ✗ 而 CPU 这边还留着（tileMap.cache ✓）
 *   → 不用重新下载解压，直接重传 ✓
 * ⚠ 只传缓存里有的 ✗：没进过视野的块本来也没传过，帧循环那条路会按视野补 ✓
 */
function reuploadTiles() {
  if (!state.tileMap || !renderer || !renderer.tileInfo || !renderer.provArrTex) return 0;
  const cols = renderer.tileInfo.cols || 1;
  let n = 0;
  for (const [key, data] of state.tileMap.cache) {
    const at = key.indexOf('_');
    if (at < 0) continue;
    const r = Number(key.slice(0, at));
    const c = Number(key.slice(at + 1));
    if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
    if (renderer.uploadTile(r * cols + c, data)) n++;
  }
  if (n) renderer.dirty = true;
  if (n) LOG.event('分块重传', n + ' 块');
  return n;
}

/** 上下文回来之后的重活（gl.js 那个 restored 事件叫过来的 ✓） */
let ctxRestoring = false;
async function restoreGpuAfterContextLoss() {
  if (ctxRestoring) return;
  ctxRestoring = true;
  clearTimeout(state._ctxWaitTimer);       // 等恢复的那根表可以撤了 ✓
  const t0 = performance.now();
  LOG.event('WebGL 上下文已恢复', '重新喂地图数据');
  try {
    await uploadMapToGpu();
    refreshBorderField();                  // 粗筛位图（桌面才建；手机上它自己会跳过 ✓）
    renderer.dirty = true;
    invalidate();                          // 视角照旧 → 重画一帧 ✓
    labelDirty = true;
    LOG.event('上下文恢复完成', ((performance.now() - t0) / 1000).toFixed(1) + ' 秒');
  } catch (e) {
    LOG.event('上下文恢复失败', (e && e.message) || String(e));
    showFatal('✗ 显卡上下文恢复失败：' + ((e && e.message) || e) + '\n刷新页面可以重来。');
  } finally {
    ctxRestoring = false;
  }
}

/**
 * **回到前台**（手机切出去又回来 / 锁屏解锁 / 从别的标签页切回来）——
 * 三件事都要做，少一件就是"回来还是黑的" ✗
 *   ① 重量画布尺寸：浏览器的地址栏 / 工具栏这时候可能收起了 ✗
 *      而画布是按 clientWidth 定的，不重量的话画面会被拉歪或留边 ✓
 *   ② **强制重画一帧**：切后台期间 requestAnimationFrame 被冻住 ✓
 *      回来时若没别的东西碰 dirty，那一帧永远不来 ✓
 *   ③ 上下文要是**没回来** → 给一条出口（黑屏上什么都没有最难受 ✓）
 *      （正常路径是 restored 事件 → restoreGpuAfterContextLoss ✓ 这里只管异常）
 */
function onEnterForeground() {
  if (!state.meta || !renderer) return;
  if (typeof document !== 'undefined' && document.hidden) return;   // 还在后台，别忙 ✓
  try { renderer.resize(); } catch (e) { /* 尺寸读不到就算了，下一帧还会试 ✓ */ }
  try { if (labels) labels.resize(); } catch (e) { /* ✓ */ }
  invalidate();
  labelDirty = true;
  if (!renderer.ctxLost) return;
  /* 上下文还丢着：有的机型不发 restored（或者要等一会儿 ✓）
   * → 等 3 秒；还丢着就明说"刷新能重来" ✓ 别让人对着黑屏猜 ✓ */
  clearTimeout(state._ctxWaitTimer);
  state._ctxWaitTimer = setTimeout(() => {
    if (!renderer || !renderer.ctxLost) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    LOG.event('上下文未恢复', '提示用户刷新');
    showFatal('✗ 显卡把 WebGL 上下文收走了，一直没还回来 —— 地图现在是空白的。\n'
      + '刷新页面就能重来（涂色记得先导出 ✓）。');
  }, 3000);
}

/** 等显卡上下文恢复 / 给重试留一点时间 ✓（2026-10-17）
 *  · 上下文丢了的恢复靠 `webglcontextrestored` 事件；有的浏览器会晚几百毫秒
 *  · 超时也往下走 —— 下一轮 `getContext` 会自己判断恢复没有 ✓ */
function waitForGpuRestore(ms) {
  return new Promise((resolve) => {
    const cv = $('map');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (cv && cv.removeEventListener) cv.removeEventListener('webglcontextrestored', onRestored);
      resolve();
    };
    const onRestored = () => finish();
    if (cv && cv.addEventListener) cv.addEventListener('webglcontextrestored', onRestored);
    setTimeout(finish, ms);
  });
}

/** 建渲染器，**遇到"上下文丢了 / 显存紧张"自动重试** ✓（2026-10-17）
 *
 *  为什么值得重试：这两种都是**暂时性**失败（显卡刚被重置、别的页面刚吃掉显存、
 *  手机刚切过后台）—— 等一等、重来一次经常就好了 ✓
 *  `no-webgl2` 也试一次：GPU 进程忙 / 上下文创建超时是暂时性的 ✓
 *  ⚠ 着色器真的编译不过 **不重试** ✗（重试一百次也一样）✓
 */
/* gl.js 里有两套错误来源：RendererSetupError（stage）和老 shaderErr（code）——
   统一成 stage，否则从 _build 里抛出来的 CTX_LOST 不会被重试 ✓ */
function _stageOfError(err) {
  if (err && err.stage) return err.stage;
  const code = err && err.code;
  if (code === 'CTX_LOST') return 'context-lost';
  if (code === 'COMPILE') return 'shader-compile';
  if (code === 'LINK') return 'shader-link';
  return '';
}

async function createRendererWithRetry(meta, opts) {
  const o = opts || {};
  const make = (typeof o.make === 'function') ? o.make : () => new MapRenderer($('map'), meta);
  const wait = (typeof o.wait === 'function') ? o.wait : waitForGpuRestore;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return make();
    } catch (err) {
      lastErr = err;
      const stage = _stageOfError(err);
      const retryable = stage === 'context-lost' || stage === 'out-of-memory'
        || stage === 'no-webgl2';
      try {
        LOG.event('渲染器创建失败',
          `${stage || 'unknown'} · 第 ${attempt} 次 · ${(err && err.message) || err}`);
      } catch (e) { /* 日志坏了别影响主流程 ✓ */ }
      if (!retryable || attempt >= 3) throw err;
      if (stage === 'no-webgl2' && attempt >= 2) throw err;   // 这一类只试一次 ✓
      setBoot(stage === 'context-lost'
        ? `显卡上下文丢了，正在重试（${attempt}/2）…`
        : stage === 'no-webgl2'
          ? `显卡上下文没建起来，正在重试（${attempt}/2）…`
          : `显存紧张，正在重试（${attempt}/2）…`, 90);
      await wait(attempt === 1 ? 700 : 1500);
    }
  }
  throw lastErr;
}

/**
 * **把渲染器初始化失败翻译成人话** ✓（2026-10-17）
 *
 *  管理员报的那条"着色器连接失败"就是这里以前的毛病 ✗：
 *  `new MapRenderer()` 的**任何**异常都套一句"着色器编译失败" ✓
 *  可真正的原因常常是 **WebGL 上下文创建失败 / 建到一半丢了** ——
 *  跟着色器源码一个字的关系都没有 ✓
 *
 *  @param {Error} err 带 `stage` / `detail` 的 `RendererSetupError`（见 gl.js）
 *  @returns {{code:string,title:string,body:string,steps:string[],facts:string}}
 */
function describeRendererFailure(err) {
  const stage = _stageOfError(err) || 'renderer';
  const d = (err && err.detail) || {};
  const raw = String((err && err.message) || err || '');
  const facts = [
    d.unmaskedRenderer ? '显卡 ' + d.unmaskedRenderer
      : (d.renderer ? '渲染器 ' + d.renderer : ''),
    d.version ? 'GL ' + d.version : '',
    d.contextLost ? '上下文已丢失' : '',
    d.creationError ? '创建失败原因：' + d.creationError : '',
    d.glError ? 'glError=' + d.glError : '',
    d.maxTex ? '贴图上限 ' + d.maxTex + 'px' : '',
  ].filter(Boolean).join(' · ');

  if (stage === 'no-webgl2') {
    return {
      code: 'WEBGL2_UNAVAILABLE',
      title: '这个浏览器没能创建 WebGL2（不是地图数据的问题）',
      body: '编辑器需要 WebGL2 才能画地图。常见原因：浏览器关掉了硬件加速、'
        + '显卡驱动太旧、远程桌面 / 虚拟机 / 旧显卡，或者浏览器策略禁用了 WebGL。',
      steps: [
        '在浏览器设置里打开「使用硬件加速」，重启浏览器再试',
        '更新显卡驱动；关掉远程桌面 / 虚拟机再试',
        '换最新版 Chrome / Edge（Firefox 也行）',
        '都不行 → 点下面「导出日志」发给作者',
      ],
      facts,
    };
  }
  if (stage === 'context-lost') {
    return {
      code: 'WEBGL_CONTEXT_LOST',
      title: '显卡上下文在启动时丢失了（不是着色器写错了）',
      body: '浏览器 / 显卡把 WebGL 上下文收走了。常见于：显存紧张、显卡驱动重置、'
        + '刚切过后台、手机省电，或者同时开了太多大页面。编辑器已经自动重试过，'
        + '两次都没等到上下文回来，才停在这里。',
      steps: [
        '点「刷新重试」再开一次 —— 最常见的情况刷新就好了',
        '关掉其他吃显存的标签页 / 游戏 / 视频，再刷新',
        '手机：先回桌面再切回来，或者换 Chrome / Edge 试试',
        '仍然失败 → 导出日志发给作者（里面带着显卡型号和 GL 版本）',
      ],
      facts,
    };
  }
  if (stage === 'out-of-memory') {
    return {
      code: 'GPU_OUT_OF_MEMORY',
      title: '显存不够，渲染器没能建起来',
      body: '这张地图的纹理和着色器把显存吃满了。常见于手机、老旧集显，'
        + '或者浏览器同时开了很多大页面。',
      steps: [
        '关掉其他标签页 / 游戏 / 视频，再点「刷新重试」',
        '换一张小一点的地图（例如 EU5 原版而不是原尺寸）',
        '还是不行就换台设备，或把日志发给作者',
      ],
      facts,
    };
  }
  if (stage === 'shader-compile' || stage === 'shader-link') {
    const log = String(d.log || '').trim();
    return {
      code: stage === 'shader-compile' ? 'SHADER_COMPILE_FAILED' : 'SHADER_LINK_FAILED',
      title: stage === 'shader-compile' ? '着色器在这台设备上编译失败' : '着色器在这台设备上链接失败',
      body: (log ? '驱动给的日志：' + log : '驱动没有给出日志（常见于指令数 / 寄存器超限）。')
        + '\n这条才是真的着色器问题；如果日志里看不出语法错，多半是这台设备的显卡 / 驱动撑不住。',
      steps: [
        '更新显卡驱动 / 换最新版浏览器',
        '老显卡或手机可能显存 / 指令数不够，换台设备试试',
        '导出日志发给作者，里面带着显卡型号和 GL 版本',
      ],
      facts,
    };
  }
  if (stage === 'texture-limit') {
    return {
      code: 'TEXTURE_LIMIT',
      title: '这台设备的贴图上限太小，放不下地图切片',
      body: '显卡报告的单张纹理上限只有 ' + (d.maxTex || '?') + 'px，连最小的一块地图切片都放不下。',
      steps: ['换一台设备 / 换最新版浏览器', '把日志发给作者（这属于设备限制，不是地图坏了）'],
      facts,
    };
  }
  return {
    code: 'RENDERER_INIT_FAILED',
    title: '渲染器初始化失败',
    body: raw || '没有拿到更具体的原因。',
    steps: ['点「刷新重试」再开一次', '仍然失败 → 导出日志发给作者'],
    facts,
  };
}

/** 把分类后的渲染器失败上屏（带步骤 + 技术信息）✓ */
function showRendererFailure(fail) {
  const lines = ['✗ ' + fail.title, '', fail.body];
  if (fail.steps && fail.steps.length) {
    lines.push('');
    fail.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  if (fail.facts) lines.push('', '技术信息：' + fail.facts);
  showFatal(lines.join('\n'));
}

/** 启动时渲染器失败的统一出口 ✓（建渲染器 / 灌数据两处共用）
 *  上屏 + 写日志 + 把启动屏停在人话上 ✓ */
function handleBootRendererFailure(err) {
  const fail = describeRendererFailure(err);
  state._rendererFail = fail;
  bootMark('✗渲染器失败[' + fail.code + ']');
  console.error('渲染器创建 / 初始化失败：', err);
  try {
    LOG.env('渲染器状态', fail.code + ' · ' + fail.title);
    if (fail.facts) LOG.env('渲染器详情', fail.facts);
    LOG.event('渲染器初始化失败',
      fail.code + ' · ' + fail.body + (fail.facts ? ' · ' + fail.facts : ''));
  } catch (e) { /* ✓ */ }
  showRendererFailure(fail);
  setBoot(fail.title, 100);
  const _bs = $('boot-step');
  if (_bs) _bs.style.color = 'var(--danger)';
  return fail;
}

async function boot() {
  try {
    // 启动屏那条**静态兜底提示**：脚本跑起来了就藏掉（它只在"脚本没跑"时才有意义 ✓）
    // 用 hidden 不用 remove() —— 测试用的假 DOM（tools/lib/browser_stub.js）没实现 remove ✓
    const _bh = document.getElementById('boot-hint');
    if (_bh) _bh.hidden = true;
    LOG.event('启动');
    setBoot('看看有哪些地图', 3);
    const maps = await availableMaps();
    /* **一张图都没有也要能进来** ✗（2026-10-12 改的）
       单文件版从今天起默认不内嵌地图（约 0.6 MB，地图改成 .pdxmap 包单独下）——
       这时候"第一屏"本来就是"还没有地图，导一个进来" ✓
       原来是直接抛错让人去跑 build_data.py ✗ 那是**开发者**才该看到的话，
       玩家打开一个 0.6 MB 的文件却看到这句，等于告诉他"这东西坏了" ✗
       （页面上那句"请点击导入按钮，或将 .pdxmap 文件直接拖进这一页。"
         就摆在下方的提示框里，进度条这边就不再重复唠叨了 ✓） */
    if (!maps.length) {
      LOG.event('地图', '一张都没有（轻量版？还是缓存没建）—— 让玩家导入地图包');
    }

    const chosen = await pickMap(maps);
    LOG.event('选图', String(chosen.label || '')
      + (chosen.pack ? '（导入的地图包 ' + chosen.pack + '）'
         : isEmbedded() ? '（单文件内嵌）' : '（' + chosen.dir + '）'));
    if (chosen.pack) setPackMap(chosen.pack);
    else if (isEmbedded()) setEmbeddedMap(chosen.emb);
    else setDataDir(chosen.dir);

    setBoot(`读取「${chosen.label}」的元数据…`, 6);
    const meta = await api.meta();
    if (!meta || !meta.numTitles) throw new Error('data/ 里还没生成好缓存，先跑 python build_data.py');
    state.meta = meta;
    /* **每块地自己的原色** ✓（数据保留备用 ✓）
     *   meta.provColors = base64 的 RGBA8，长度 = numProvinces × 4 ✓
     *   （第 4 个字节 = "这块地有没有登记色" ✓ 构建期打的 ✓ 见 build_data.py ✓）
     *   ⚠ 前端不再拿它做"水域显示地块原色"的那套特判 ✓ 解出来只进 state 备查 ✓ */
    state.provColors = decodeProvColors(meta);
    /* **水域标签** ✓（数据保留备用 ✓ —— 不再传给渲染器 ✓）
     *   `meta.waterMask` 解出来存 state ✓ 万一后面还有别的读水者 ✓
     *   isWaterPid / isWaterHere 仍会从它查 ✓（认水判据没拆 ✓ 拆的只是使用场 ✓） */
    state.waterMask = decodeWaterMask(meta);
    /* **身份标**（底层 pid 的类别 ✓ 七行颜色的唯一判据 ✓ 2026-10-15 ✓）
     *   ⚠ 老包没有 → null → 判据退回键名前缀 ✓ 一个字节都不动 ✓ */
    state.kindMask = decodeKindMask(meta);
    state._kindMap = null;                    // 换图 → 头衔→类别那张表作废 ✓
    state._kindMapKey = '';
    /* **「每省是不是水」那张表**（给「水域 · 边界」用 ✓ 2026-10-16 ✓）
     *   ⚠ 必须排在 `state.titles` 之后算 ✗ —— 老包那条退路要读键名 ✓
     *     所以这里先**置空**，等下头 titles 取回来再算一次（见下面 ✓）
     *   置空这一步不能省 ✗：上一张图的表还留着的话，
     *     新图前几帧会拿着**别人的水域**画边界（看着像"水域边界全是乱的"✓）*/
    state.waterKindArr = null;
    /* **设置 + 最近颜色按游戏类型接回来** ✓（刷新 / 回主菜单都不丢 ✓
     * 同款游戏的图**共用一套**：TNO 和钢铁雄心4原版是同一份设置 ✓ 见 prefsKeyOf ✓）
     * 这份跟"涂色暂存"是分开的两份 —— 那份回主菜单才存、F5 就清 ✓（见 saveProject 上面的说明 ✓）
     * 接回来之后 `applySettings()` 会把它推给渲染器（renderer 建好之后调一次 ✓ 见下面）*/
    {
      const prefs = loadMapPrefs(meta);
      state.set = Object.assign({}, SET_DEFAULTS, (prefs && prefs.set) || {});
      /* 2026-10-17：地名上限默认 12 → 1。
         老存档若还停在旧默认 12，顺手迁到 1（只迁这一次 ✓）；之后用户自己调的值不动 ✓ */
      if (!state.set.placeCapV1) {
        if (state.set.labelPlaceMax == null || Number(state.set.labelPlaceMax) === 12) {
          state.set.labelPlaceMax = 1;
        }
        state.set.placeCapV1 = 1;
      }
      if (prefs && Array.isArray(prefs.recent)) state.recent = prefs.recent.slice(0, 24);
      LOG.event('设置', prefs ? '接回这张图上次的设置 ✓' : '用出厂设置 ✓');
    }
    buildMetaIndex();            // 名录快查表（荒地 / 无男爵领 / 巨型荒地）
    NO_TITLE = meta.noTitle ?? 65535;
    // 选的是哪张图，就按哪个游戏的术语和存档来
    GAME = GAMES[meta.game] || GAMES[chosen.game] || GAMES.ck3;
    TIER_BADGE = meta.tierKeys || ['e_', 'k_', 'd_', 'c_', 'b_'];
    // 报错日志要记住"他当时看的是哪张图" ✓（导出时这几条落在 [当时的状态] 里）
    LOG.env('地图', `${GAME.name} · ${chosen.label || ''}`);
    LOG.env('数据', `${meta.numTitles} ${GAME.entity} · ${meta.numProvinces} 个地块`
      + ` · ${meta.mapWidth}×${meta.mapHeight}`);
    LOG.env('数据生成于', String(meta.generated || ''));

    setBoot(`加载${GAME.entity}表…`, 10);
    const titles = await api.titles();
    state.titles = titles;
    // （以前这里还抄一份 `state.original` 当"原色" ✗ —— 原色就是 titles.colors 那一份 ✓）
    state.provinceNames = titles.provinceNames || [];
    // **名录快查表**：荒地 / 无男爵领 —— 悬停、涂色、每帧都要问
    // "这个号在不在名单里"，原来是拿 indexOf 线性扫的 ✓（见上面快查表那一段）
    buildMetaIndex();

    /* **荒地名 / 老包水域名**走 buildSeaLabelPoints 那条真名表的路 ✓
     *   （「水域 / 荒地 · 名称」那两个界面开关已随专属设置退役 ✓
     *     state 里两面旗保留、恒为 false → 显示口径跟"用户定的默认"一致 ✓
     *   ⚠ 数据里这两类节点（wl_* / #sea / #lake / #river）**都没有标签位置** ✗
     *     所以默认关 = 跟以前一模一样看不到 ✓；打开了也还看不到（等数据带 lx/ly ✓）*/
    buildColorIndex();
    // key → 序号，导入配色时用
    titles.index = Object.create(null);
    for (let i = 0; i < titles.keys.length; i++) titles.index[titles.keys[i]] = i;

    setBoot('解压省份 id 图', 20);
    await nextTick();
    // 先看数据目录里有没有分块清单：有（原尺寸那套）就**不下**整张 id 图 ✗，
    // 改成按视野取块 —— 整张解压要 268MB JS 堆、纹理还要 268MB 显存。
    // 整段包起来：分块这条路**任何异常都不该让整页白屏** ✗ ——
    // 出问题就退回"整图 id 图"那条老路（那些地图本来就走这条路 ✓）。
    try {
      state.tiles = await api.tileManifest();
    } catch (e) {
      console.warn('读分块清单失败，退回普通路径：', e);
      showFatal('✗ 读分块清单失败：' + (e && (e.stack || e.message) || e));
      state.tiles = null;
    }
    if (state.tiles) {
      try {
        // 块是 zlib 压的（zlib.compress），用 zip.js 的全局 decompress 解
        state.tileMap = new TileMap(DATA, state.tiles, (u8) => decompress(u8, 'deflate'),
          (name) => api.tileBytes(name));
        state.provinceIds = new Uint16Array(1);    // 占位（走分块时不用它）
        console.log(`分块数据：${state.tiles.cols}×${state.tiles.rows} 块，`
          + `每块 ${state.tiles.tileW}×${state.tiles.tileH}`);
      } catch (e) {
        console.error('分块初始化失败，退回普通路径：', e);
        showFatal('✗ 分块初始化失败：' + (e && (e.stack || e.message) || e));
        state.tiles = null;
        state.tileMap = null;
      }
    }
    if (!state.tiles) {
      state.tileMap = null;
      state.provinceIds = await api.provinceIds((got, total) => {
      setBoot(null, 18 + 40 * (got / (total || 1)));
    });
    }

    setBoot(`加载${GAME.entity}归属表…`, 62);
    await nextTick();
    state.titlemap = await api.titlemap();
    state.adjacency = await api.adjacency();
    state.provPos = await api.provPos();
    state.provTitle = new Int32Array(meta.numProvinces).fill(-1);
    state.provLabel = new Int32Array(meta.numProvinces).fill(-1);

    /* **「每省是不是水」那张表**（2026-10-16 ✓ 见 buildWaterKindMask ✓）
     *   ⚠ **必须等到这儿** ✗✗ —— 这是实跑炸出来的（"Cannot read properties of null"）：
     *     `waterKindByPid` 一路会走到 `titleAt` ✓ 而它读的是 **`state.titlemap`** ✗
     *     （不是 `state.titles.keys` ✓ 我先按后者判断、把调用放早了整整 50 行 ✓）
     *     上面那次置空之后就一直是 null ✓ 直到这句 `await api.titlemap()` 才有值 ✓
     *   ⚠ 放在 `provPos` 那几行之后、上传显卡之前 ✓ —— 不依赖显卡、也不拖着开图 ✓
     *     （EU5 四万多个地块走一趟也就几毫秒 ✓）*/
    state.waterKindArr = buildWaterKindMask();
    /* 🔴 **荒地自动上色的周长表**（2026-10-17 ✓ 重做 ✓）
     *   ⚠ 必须等 `titlemap` + `provinceIds` 都有值之后再跑 ✗
     *     —— 荒地名单来自最细层归属，周长来自像素图 / 邻接表 ✓
     *   有整张 id 图的模式（除 EU5 原尺寸）直接扫，实测 CK3 0.08s ✓
     *   分块图先按邻接表给近似，开图后再后台算精确的（见 scheduleTileWastePerimeter ✓）*/
    setupWastePerimeter();
    /* 🔴 **横跨左右的那批头衔**（2026-10-17 ✓ 用户点名的"掩耳盗铃"那条 ✓）
     *   ⚠ **必须排在 `state.provinceIds` + `state.titlemap` 都有值之后** ✗✗
     *     —— 它扫的是**像素图**（左右两列）+ 查 `titlemap` ✓（跟上面那张表同一个坑 ✓）
     *   ⚠ 一次性 ✓：两列 × 图高（EU5 8192×4096 → 8192 次读 ✓）几毫秒 ✓ 换图才重算 ✓ */
    state.crossSeamTids = buildCrossSeamTids();
    /* ⚠ **荒地那个标记挪到 `uploadMapToGpu()` 末尾了** ✗✗（2026-10-17 ✓）
     *   原因：这一行的时候 `renderer` **还是 null** ✓（它是几十行之后才 new 的 ✓）
     *     原来那句 `if (renderer && …)` 直接跳过 → 一块都没打上 ✓
     *   现在挂在 `uploadMapToGpu()` 尾部 ✓ —— 那儿 `setData` 刚跑完、LUT 现成 ✓
     *     而且上下文丢失恢复时会跟着重跑 ✓（标记不会丢 ✓）*/

    setBoot('上传到显卡', 88);
    await nextTick();
    /* **这一步细分计时** ✓（用户那份日志："上传到显卡 → 就绪" 花了 **23.5 秒** ✗
     *  而这一段里其实是好几件事叠在一起：编译着色器 / 上传纹理 / 建标签索引 ✓
     *  不细分就不知道刀该往哪儿下 ✗ —— 上一回瞎猜预筛，把边界都猜没了 ✓）
     */
    bootMark('①开始建');
    let _tMark = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const _tick = (name) => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dt = now - _tMark; _tMark = now;
      console.log(`[加载·细] ${name}: ${dt.toFixed(0)} ms`);
      if (window.PDXLOG) window.PDXLOG.event('加载细分', `${name}: ${dt.toFixed(0)} ms`);
    };
    bootMark('①到渲染器');
    try {
      renderer = await createRendererWithRetry(meta);
      bootMark('②渲染器OK');
    } catch (err) {
      /* 🔴 **别再一律写成"着色器编译失败"** ✗✗（2026-10-17）
       *   那样会把"WebGL 上下文丢了"指成"着色器写错了" ✓
       *   （管理员就是在着色器源码里白找了半天 ✓）
       *   现在按 gl.js 给的 `stage` 分成人话 + 排查步骤，并且**上屏** ✓
       *   （手机上没有控制台可看 ✓） */
      handleBootRendererFailure(err);
      return;                       // 后面全是"渲染器已经建好"的步骤，别硬跑 ✓
    }
    _tick('建渲染器');
    renderer.onContextLost = () => {
      // 这一条要进日志：白屏的最常见原因之一，而玩家只会说"它黑了" ✓
      LOG.event('WebGL 上下文丢失', '显卡驱动 / 显存（手机切后台最常见）');
      state._ctxLostAt = performance.now();
    };
    /* 上下文**回来了** —— 显卡把它们自己的东西重建了（gl.js 里那个 restored ✓），
     * 现在轮到我们：把地图数据重新喂一遍 ✓（笔迹在 CPU 那份里，没丢 ✓）
     * ⚠ 这是手机切后台回来黑屏的正解 ✗：以前只接 lost、不接 restored，
     *   于是回来时"上下文是好的、显存里什么都没有" → 一直黑 ✓ */
    renderer.onContextRestored = () => {
      // 开图还没喂完就丢又回来（罕见）→ 别抢：boot 那条路本来就会喂一遍 ✓
      if (!state.meta || !state.titles) return;
      restoreGpuAfterContextLoss();
    };
    renderer.onContextRestoreFailed = (err) => {
      LOG.event('上下文恢复失败', (err && err.message) || String(err));
      showFatal('✗ 显卡上下文恢复失败：' + ((err && err.message) || err) + '\n刷新页面可以重来。');
    };
    /* 🔴 **把关键数字打出来** ✗（用户报：手机版黑屏，绿字停在"③传数据前" ✓）
     *   手机上黑屏最经典的一条就是**纹理超限** ✓
     *     地图 5632×2048 而手机的 MAX_TEXTURE_SIZE 常见只有 **4096** ✗
     *   → 纹理传不进去 → 全黑 ✓ 而且**不报错** ✓（GL 只设个错误码 ✓）
     *   ⭐ 我只给"粗筛位图"那张加过尺寸检查 ✗ 底图/省份 id 那几张老纹理没加 ✓
     *   所以这里先把数打出来：**一对比就知道是不是它** ✓ */
    try {
      const _gl = renderer && renderer.gl;
      const _mx = _gl ? _gl.getParameter(_gl.MAX_TEXTURE_SIZE) : 0;
      const _cv = document.getElementById('map');
      bootMark('③传数据前 [GL上限' + _mx + ' 地图' + meta.mapWidth + '×' + meta.mapHeight
        + ' 画布' + ((_cv && _cv.width) || 0) + '×' + ((_cv && _cv.height) || 0) + ']'
        + (meta.mapWidth > _mx || meta.mapHeight > _mx ? ' ⚠超限' : ''));
    } catch (e) { bootMark('③传数据前 [查GL失败]'); }
    /* ⚠ **灌数据时也可能丢上下文** ✗（2026-10-17）——
     *   显存吃爆时 `texImage2D` 会静默失败，gl.js 的 `setData` 末尾会抛
     *   `context-lost`；这里接住并按同一套人话上屏 ✓
     *   普通数据错误（尺寸对不上之类）仍然交给外层启动失败 ✓ */
    try {
      await uploadMapToGpu(_tick);
    } catch (err) {
      if (!err || !err.stage) throw err;
      handleBootRendererFailure(err);
      return;
    }
    bootMark('④数据OK');
    // **地名门槛按这张图自己的地块大小现算** ✓（不再吃 meta 里写死那套 ——
    //  那套是照某一张图调的，换个尺寸/换个游戏就对不上：地块小的图地名会提早糊出来）
    meta.labelZoom = computeLabelZoom(meta, titles);
    /* **荒地 / 水域的标签位置在这儿补** ✓（2026-10-13 ✓）
     *   ⚠ 必须在 `new LabelLayer` **之前** ✗ —— 它是构造时把 lx/ly 吃进去的，
     *     晚了这一步就白算了（跟 hideLabel 那个坑同一个道理 ✓）
     *   ⚠ CK3 按规则直接不算（见函数里那段 ✓）*/
    try { buildPseudoLabelPositions(); } catch (e) { LOG.event('伪头衔补位置失败', String(e)); }
    /* **水域名标签点** ✓（2026-10-13：悬停 + 地图上都要显示具体海域名 ✓）
     *   同样得赶在 `new LabelLayer` 之前 ✗ —— 嗯，其实这几个点**不进 LabelLayer**
     *   （它们是凭空多出来的一层，没头衔 ✓），是 drawLabels 里直接塞进去的 ✓
     *   所以只要在第一次画之前算好就成，放这儿刚好 ✓
     *   ⚠ CK3 按规矩不算（那份数据里也没有水域名表 ✓ 双保险 ✓）*/
    try {
      /* 🔴 **CK3 那一路现在收在函数里面了** ✗（2026-10-16 ✓）
       *   以前在这儿整块置空 ✗ —— 那会儿 CK3 一个都不标 ✓ 现在按方案
       *   CK3 的**河流**要出标 ✓ 而河名点在 `titles` 那边补（`buildPseudoLabelPositions` ✓），
       *   这儿聚的是"荒地 + 老包水名"两类 ✓ CK3 两类都不出 ✓ → 算了也是白算 ✓
       *   ⚠ 判据留给函数自己（`NAME_POLICY` 那张表 ✓）别在调用处再写一遍 game ✗ */
      state.seaLabelPoints = buildSeaLabelPoints();
      if (state.seaLabelPoints.length) {
        LOG.event('水域名', `${state.seaLabelPoints.length} 片水域有具体名字`);
      }
    } catch (e) { state.seaLabelPoints = []; LOG.event('水域名标签失败', String(e)); }
    labels = new LabelLayer($('overlay'), titles, meta);
    /* ⚠ **开场就得把存过的不透明度喂进去** ✗ —— applySettings 跑在这句**之前** ✓
     *   那时候 labels 还没建、会跳过 ✓ 于是"存过的偏好"要等用户动一下滑块才生效 ✓ */
    labels.alphaCountry = setNum('labelAC', 50) / 100;
    labels.alphaPlace = setNum('labelAP', 50) / 100;
    _tick('建标签索引');

    /* **边界图重算一次** ✓ —— 这时候层号、粒度、多级链全都定下来了 ✓
     *   开图早期那次（state.tier 还是 -1）算出来的可能是空的 ✗ 这次才是准的 ✓
     *   为什么非得再算一遍：边界图按"当前层 + 当前粒度"算身份 ✗
     *   而这两样在 boot 前半段还没定值 ✓（我在这儿栽过一次 ✓）*/
    /* ⚠ **这里必须打点** ✗ —— 用户报：绿字走到"④数据OK"之后就没有了 ✓
     *   而上面那句 refreshBorderField() 正是"④之后、藏遮罩之前"唯一的重活 ✓
     *     （它要在 CPU 上把整张图扫一遍、算粗筛位图 ✓ 手机上可能很慢 ✓）
     *   所以卡住 = 卡在它 ✓ 走过去了 = 它在手机上没问题 ✓ */
    bootMark('⑤算粗筛前');
    try {
      refreshBorderField();
      bootMark('⑥算粗筛后');
    } catch (err) {
      bootMark('⑥粗筛失败: ' + (err && err.message ? err.message : err));
      rawErr('✗ 粗筛失败：' + (err && err.message ? err.message : err));
    }

    setBoot('就绪', 100);
    bootMark('⑦就绪');
    LOG.event('就绪', `${state.meta.numProvinces} 个地块 · ${GAME.name}`);

    /* 报错日志：注册一份"导出时现取"的现状 ——
     * 视图 / 工具 / 改动数是随时变的，记死在启动那一刻没意义 ✓
     * 显卡那两行尤其值钱：白屏十次里有几次是 WebGL2 根本没起来 ✓
     */
    LOG.snapshot(() => {
      const m = state.meta || {};
      const out = {
        '视图': ((m.tierNames && m.tierNames[state.tier]) || state.tier)
          + '（第 ' + state.tier + ' 层）',
        '粒度': state.grain == null ? '无' : (state.grain + '（' + ((m.tierNames && m.tierNames[state.grain]) || '') + '）'),
        '工具': state.tool,
        '改动 / 涂色': (state.changed ? state.changed.size : 0) + ' 处 / '
          + (state.painted ? state.painted.size : 0) + ' 个' + GAME.entity,
      };
      try {
        const gl = renderer && renderer.gl;
        if (gl) {
          let gpu = '';
          if (typeof gl.getExtension === 'function') {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            if (dbg && dbg.UNMASKED_RENDERER_WEBGL) gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
          }
          out['WebGL'] = String(gl.getParameter(gl.VERSION) || '') + (gpu ? ' · ' + gpu : '');
        } else out['WebGL'] = '没有上下文';
      } catch (e) { /* 问不到显卡也没关系，别的照记 ✓ */ }
      /* 🔴 **渲染健康自检**（2026-10-13 加的 ✓ 起因见下面）
       *
       *   用户报"点进去黑屏"，可导出来的日志上写的是「**错误 0 处**」✗ ——
       *   因为那一条只说明 **JS 没抛异常** ✗，**完全不等于"画出来了"** ✓
       *   这几种情况在旧日志里**长得一模一样**，没法分辨 ✗：
       *     · 画布尺寸是 0（CSS 没算对 / 被压扁）→ 什么都没画
       *     · WebGL 上下文丢了（手机上切后台、内存吃紧很常见）→ 画的都是空的
       *     · **真画了，但安卓浏览器没把它合成上屏**（`content://` 协议下是老坑）
       *   所以这里**直接读回像素** —— 这是唯一能一锤定音的判据 ✓
       *     · 中心点**非零** → 渲染器**真的在画** ✓ 那黑屏是**显示/合成**那一侧的事
       *     · 中心点**全零** → **渲染器没画出来** ✓ 那是渲染侧的问题（往下查画布尺寸 / 上下文）
       *   ⚠ 只在"导出日志"这一刻取 ✗ —— 那时肯定已经渲染过若干帧了 ✓
       *     （`readPixels` 读的是**当前后台缓冲**，没画过就都是 0 ✓）*/
      try {
        const cv = $('map');
        if (cv) {
          out['画布'] = `${cv.width}×${cv.height} 绘制缓冲 · 显示 ${cv.clientWidth}×${cv.clientHeight}`
            + ` · 缩放 ${window.devicePixelRatio || 1}x`;
        }
        const gl2 = renderer && renderer.gl;
        if (gl2 && cv && cv.width > 0 && cv.height > 0) {
          const px = new Uint8Array(4);
          gl2.readPixels((cv.width / 2) | 0, (cv.height / 2) | 0, 1, 1,
                         gl2.RGBA, gl2.UNSIGNED_BYTE, px);
          const _glerr = gl2.getError();
          const _lost = !!(gl2.isContextLost && gl2.isContextLost());
          out['像素自检'] = `中心像素=(${px[0]},${px[1]},${px[2]},${px[3]})`
            + ((px[0] || px[1] || px[2]) ? ' · 渲染正常' : ' · 无像素')
            + (_lost ? ' · 上下文丢失' : ' · 上下文正常')
            + ` · glError=${_glerr}${_glerr ? '（有错误）' : '（无错误）'}`;
        } else if (cv) {
          out['像素自检'] = '画布尺寸为 0，无法渲染';
        }
      } catch (e) {
        out['像素自检'] = '读不了：' + (e && e.message ? e.message : e);
      }
      return out;
    });

    applyGameText();
    buildToolbar();
    bindEvents();
    setBrush(state.brush, false);
    setBrushLabel(state.brushLabel);      // 「标记」框里一开始就写着「请输入文本」✓
    renderPalette();
    setTier(meta.defaultTier ?? 3);
    setTool('paint');          // 默认工具：**涂色** ✓（用户要求；拖动平移按中键 ✓）
    fitView();
    updateStatus();
    updateHistoryUI();

    $('status-meta').textContent =
      `${meta.numTitles} ${GAME.entity} · ${meta.numProvinces} 个地块 · ` +
      `${meta.mapWidth}×${meta.mapHeight} · 数据 ${meta.generated}`;

    requestAnimationFrame(frame);
    /* ⚠ 遮罩是靠**延时**藏的 ✗ 所以"黑屏"也可能是**遮罩没藏掉** ✓
     *   这里打两个点：到这儿了 / 遮罩真的藏了 ✓ */
    bootMark('⑧进帧循环');
    setTimeout(() => $('boot').classList.add('done'), 220);
    setTimeout(() => {
      $('boot').style.display = 'none';
      /* 🔴 **决定性探针：把画布上的像素读回来** ✗
       *   用户报：电脑上手机版能跑 ✓ 手机上黑 ✗ 而启动链全通（⑨都到了 ✓）
       *   分岔只有两种：
       *     · 读回来是**黑** → 真的没画出来（渲染 / 数据那条路 ✓）
       *     · 读回来**有色** → 画对了，是**显示 / 合成**（CSS 尺寸、被盖住 ✓）
       *   一次就能定性，不用再猜 ✓
       *   ⚠ readPixels 读的是**当前绑定的 framebuffer** ✓ 所以必须先 render 一帧 ✓
       *   ⚠ 它读的是**帧缓冲**，不是屏幕合成的结果 ✗
       *     所以"读回来有色但屏幕黑"= 十有八九是 CSS/布局 ✓✓ */
      try {
        const cv = document.getElementById('map');
        const g2 = renderer && renderer.gl;
        if (g2 && cv) {
          const px = new Uint8Array(4);
          g2.readPixels(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1,
                        g2.RGBA, g2.UNSIGNED_BYTE, px);
          const cs = window.getComputedStyle ? window.getComputedStyle(cv) : null;
          bootMark('⑨遮罩已藏 · 画布' + cv.width + '×' + cv.height
            + ' · CSS' + (cs ? cs.width + '×' + cs.height + ' display:' + cs.display : '?')
            + ' · 中心像素[' + px[0] + ',' + px[1] + ',' + px[2] + ']'
            + ' · 出错码' + g2.getError());
        } else bootMark('⑨遮罩已藏 · 没有 gl 或 canvas');
      } catch (e) { bootMark('⑨遮罩已藏 · 读像素失败:' + (e && e.message ? e.message : e)); }
    }, 900);

    // 上次没画完的，接着来 —— **静默接上** ✓ 不弹提示
    //（回到同一张图，画的东西原样在那儿就够了 ✗ 不用再飘一条"恢复了 N 个势力"打断你）
    loadProject();
  } catch (e) {
    LOG.event('启动失败', (e && e.message) || String(e));
    console.error(e);
    // 渲染器失败那条已经在上面分类上屏了 → 别用一句更模糊的话把它盖掉 ✓
    if (!state._rendererFail) {
      const msg = (e && e.message) ? e.message : String(e);
      setBoot('出错了：' + msg, 100);
      const _bs = $('boot-step');
      if (_bs) _bs.style.color = 'var(--danger)';
    }
  }
}

boot();

// 新手引导：就绪后挂上顶栏那个「教程」按钮 ✓（本文件是独立小模块，不碰主逻辑）
if (typeof window.initTutorial === 'function') window.initTutorial();
