/**
 * CK3 地图编辑器 —— 主逻辑
 */

// 开发版是真 ES module（index.html 只加载本文件）——别的模块都得显式 import。
// 单文件版由 build_standalone.py 剥掉这些行、按序拍平，两边的加载方式都兼容。
import { DATA, api, decompress, embeddedMapKeys, isEmbedded, setDataDir, setEmbeddedMap } from './data.js';
import { MapRenderer } from './gl.js';
import { LabelLayer, computeLabelZoom } from './labels.js';
import { TileMap } from './tilemap.js';

const $ = (id) => document.getElementById(id);

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
  // 启动页角落挂一个版本戳：出问题时一眼能看出"手上是哪份文件" ✓
  // （以前放在设置页里，用户嫌那句说明占地方 ✓ 挪这儿来，不占正地方 ✓）
  const bv = $('boot-ver');
  if (bv) bv.textContent = document.lastModified ? '· ' + document.lastModified : '';
}
bindAuthorLinks();

/**
 * 每个游戏的术语、存档键、导出方式
 *
 * 渲染那一层两个游戏是**完全共用** —— EU4 的「省份/地区/区域/大洲」
 * 正好也是五级，一一对上 titlemap 那 5 行。不同的只有叫法、落盘位置和
 * "导出 mod"到底该导出什么
 */
const GAMES = {
  ck3: {
    id: 'ck3',
    name: 'CK3',
    brand: 'CK', brandSmall: 'III',
    title: 'CK3 地图编辑',
    entity: '头衔',
    saveKey: 'ck3-map-editor/v1',
    filePrefix: 'ck3',
    modName: 'CK3颜色编辑',
    exportKind: 'ck3',
    searchHint: '支持中文名、英文名、c_/d_/k_/e_ 开头的 key',
    searchPlaceholder: '',
    brushTip: '用吸管（W）在地图上取色，再用涂色（E）刷到别的头衔上',
    pickHint: '这个颜色在数据里归好几个头衔，挑一个当标记',
    exportTip: '导出到 CK3 mod：把颜色写进 common/landed_titles',
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
    modName: 'EU4省份配色',
    exportKind: 'eu4',
    searchHint: '支持 TAG 与势力名、区域名、地区名、省份名；key 形如 SWE / p_118 / brittany_area。',
    searchPlaceholder: '',
    brushTip: '用吸管（W）在地图上取色，再用涂色（E）刷到别的省份或地区上',
    pickHint: '这个颜色在数据里归好几个省份，挑一个当标记',
    exportTip: '导出到 EU4 mod：重写 map/provinces.bmp 和 definition.csv',
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
    modName: 'HOI4省份配色',
    // HOI4 的 provinces.bmp 里那个「省份 id」：那里的颜色是编号，不是显示用的地图
    // 改了它游戏画面不会变，所以这个模式没有「导出 mod」这条路，按钮直接收起来
    exportKind: 'none',
    searchHint: '支持 TAG 与势力名、州名、战略区名、城市名；key 形如 GER / STATE_118 / STRATEGICREGION_1。',
    searchPlaceholder: '',
    brushTip: '用吸管（W）在地图上取色，再用涂色（E）刷到别的州或省份上',
    pickHint: '这个颜色在数据里归好几个省份，挑一个当标记',
    exportTip: '',
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
    modName: 'EU5地块配色',
    // EU5 的地块图是"像素色 = 地块色"的索引图（跟 V3 一个道理），
    // 改了它游戏画面不会变，所以这个模式也没有"导出 mod"这条路
    exportKind: 'none',
    searchHint: '支持 TAG 与势力名，以及 国家 / 区域 / 地区 / 省份 / 地点的名字。',
    searchPlaceholder: '',
    brushTip: '用吸管（W）在地图上取色，再用涂色（E）刷到别的地块上。',
    pickHint: '这个颜色在数据里归好几个地块，挑一个当标记：',
    exportTip: '',
    colorTip: '显示地块自带的颜色',
    borderTip: '给地块描边（和「填色·边界」二选一）',
    labelsTip: '在地图上标出地名',
    notInMap: '这块地不在 EU5 的地图范围内。',
  },
  vic3: {
    id: 'vic3',
    name: 'V3',
    brand: 'VIC', brandSmall: '3',
    title: '维多利亚3 地图编辑',
    entity: '省份',
    saveKey: 'vic3-map-editor/v1',
    filePrefix: 'vic3',
    modName: 'V3省份配色',
    // 跟 HOI4 一个道理：provinces.png 的像素是**省份 id**（xRRGGBB），不是显示地图
    // 改了它游戏画面不会变 —— 这个模式也没有「导出 mod」这条路
    exportKind: 'none',
    searchHint: '支持 TAG 与势力名、州名、战略区名；key 形如 SWE / STATE_SVEALAND / p_118。',
    searchPlaceholder: '',
    brushTip: '用吸管（W）在地图上取色，再用涂色（E）刷到别的州或省份上',
    pickHint: '这个颜色在数据里归好几个省份，挑一个当标记',
    exportTip: '',
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
  { key: 'vic3',    emb: 'vic3',    dir: '/data_vic3',   game: 'vic3', label: 'V3 原版',     note: '8192 × 3616' },
  { key: 'hoi4',    emb: 'hoi4',    dir: '/data_hoi4',   game: 'hoi4', label: 'HOI4 原版',   note: '5632 × 2048' },
  { key: 'hoi4alt', emb: 'hoi4alt', dir: '/data_hoi4_alt', game: 'hoi4', label: 'HOI4 修改边界', note: '5632 × 2048' },
];

// 层级数由数据 meta.tiers 决定 —— CK3/EU4/HOI4 是 5 层，维多利亚3 是 4 层
// （1836 / 战略 / 地区 / 省份），所以这几个都别写死，boot 时按 meta 填
// TIER_KEYS 只有 CK3 的 mod 用得到，meta.tiers 里就是那几个字母
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
  tool: 'paint',
  brush: [200, 50, 50],            // 默认颜色：RGB(200, 50, 50) ✓
  showPowerColor: false,      // 势力（剧本/国家那层）的颜色（默认开：不然 1936 层是空的）
  showPowerBorder: false,
  showRegionColor: false,     // 地区（更细的那几层）颜色：默认关，画面干净
  showRegionBorder: true,
  showRegionName: false,
  showParentBorderTitle: false,   // 父级边界：默认**关**（要用再勾）
  // 二级设置页里的东西（null = 用各游戏/代码里的原值 ✓）
  set: {
    bg: null, waste: null, sea: null, lake: null, impass: null,
  impassSea: null, river: null,
  /* ⚠ **宽度默认一律 1.0** ✗（用户定的 ✓ 原来 pw/waterW/wasteW 是 1.5 ✓）
   *   浓度（pa/ra/ca）不动 ✓ 用户说的是"宽度都是 1.0" ✓ */
  w: 1, pa: 50, ra: 75, ca: 100, pw: 1, font: 1,
  // **背景那两条线各有一套宽度 + 浓度** ✓（用户要求可调 ✓；显示开关去掉了 ✗）
  //   宽度跟「势力线宽」一个口径（格数 ✓ 直接就是粗细）；浓度是百分比 ✓
  waterW: 1, waterA: 100,                     // 水域（海/湖/河）—— 宽度默认 1 ✓
  wasteW: 1, wasteA: 100,                     // 荒地 —— 宽度默认 1 ✓
    // 导出图例（用户要的：相关设置都放在「设置」这一页 ✓）
    legend: false, legendTitle: '', legendPos: 'tl',
  },
  showTitles: true,
  // 地名拆两套：原有地名（头衔/地区名）和玩家地名（手绘色块名），互不影响
  // （原来还有第三套「势力名」——它算出来的东西跟玩家地名**完全是同一批点** ✓
  //   所以那个开关删了，剧本层的国名就由「填色 · 名称」统一负责 ✓）
  showLabelsTitle: true,
  showLabelsPaint: false,
  showPaint: true,
  // 荒地（不可通行）：「荒漠涂色」关着时一律显示灰（跟以前一样）；
  // 「荒地自动上色」按烘好的接壤边长过半归属给荒地上色。两个都默认关。
  showWaste: false,
  wasteAuto: false,
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

/** 名字是不是那一类**共享伪节点**（海 / 湖 / 河 / 不可通行 —— 键以 '#' 开头）
 *
 *  判据只有一个：键的第一个字符是 '#'。
 *  以前这段写在 isSpecialTid / 空间那些地方，一共重复了十几处，
 *  而且各写各的（有的还顺手拼了别的条件 ✗）—— 收在这里 ✓ */
const isSpecialKey = (key) => {
  const s = key == null ? '' : String(key);
  return s.charCodeAt(0) === 35;   // '#'
};

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

/** 重新给 meta 里那几张名单建快查表（boot 时调一次；meta 不变就一直是它） */
function buildMetaIndex() {
  const m = state.meta;
  if (!m) return;
  m.wastelandSet = new Set(m.wasteland || []);
  m.degradedSet = new Set(m.degradedBaronies || []);
  m.wasteSkipSet = new Set(m.wasteAutoSkip || []);
}

/** 这块地的**最细层节点**是荒地吗（快查表；meta 没建表时退回原来的扫数组） */
function isWastelandTid(tid) {
  if (tid == null || tid === NO_TITLE) return false;
  const s = state.meta && state.meta.wastelandSet;
  return s ? s.has(tid) : hasIn(state.meta && state.meta.wasteland, tid);
}

/** 这块地是不是**巨型荒地**（数据里列了"不参与自动填色"的那些） */
function isWasteSkipPid(pid) {
  const s = state.meta && state.meta.wasteSkipSet;
  return s ? s.has(pid) : hasIn(state.meta && state.meta.wasteAutoSkip, pid);
}

/** 头衔键 → 序号（建一次；以前每帧在 syncLayerSwitches 里 indexOf 全表扫） */
function titleIndexByKey(key) {
  if (!state.titles) return -1;
  if (!state.titles.byKey) {
    const idx = new Map();
    const K = state.titles.keys || [];
    for (let i = 0; i < K.length; i++) if (!idx.has(K[i])) idx.set(K[i], i);
    state.titles.byKey = idx;
  }
  const hit = state.titles.byKey.get(key);
  return hit === undefined ? -1 : hit;
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
  const x = Math.floor(mx);
  const y = Math.floor(my);
  if (x < 0 || y < 0 || x >= state.meta.mapWidth || y >= state.meta.mapHeight) return 0;
  // 分块（EU5 原尺寸）：真数据在块里，整图 id 只是个占位 ✗
  if (state.tileMap) {
    if (state.tileMap.has(x, y)) return state.tileMap.at(x, y);
    state.tileMap.get(Math.floor(y / state.tiles.tileH),
                      Math.floor(x / state.tiles.tileW)).catch(() => {});
    return 0;                       // 这一块还没到，先当空；下一帧就正常
  }
  return state.provinceIds[y * state.meta.mapWidth + x];
}

function titleAt(pid, tier) {
  if (!pid) return NO_TITLE;
  return state.titlemap[tier * state.meta.numProvinces + pid];
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
  // 年代层数：非 CK3 只把国家（tag）收进"颜色 → 头衔"表 ✓
  const _nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  for (let i = 0; i < t.keys.length; i++) {
    if (t.tiers[i] >= TIER_COUNT) continue;
    const o = t.colors[i];
    const key = (o[0] << 16) | (o[1] << 8) | o[2];
    let list = state.colorIndex.get(key);
    // **非 CK3 只收年代层（国家/tag）**：地区、省份那些颜色是自动生成的，
    // 取色时匹配到它们没意义（而且会挑出一堆同色的杂项 ✗）。
    // CK3 没有年代层，全都收 ✓。
    if (_nEra > 0 && t.tiers[i] >= _nEra) continue;
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
 * （用户报的：EU5 剧本视图开「荒地自动上色」，一片荒地冒出莫名其妙的颜色 ✗）
 */
function wasteGrey() {
  const s = state.set || {};
  return s.impass || s.waste || [94, 94, 94];
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

/** 切「填色·颜色」：LUT 里永远是游戏原色，所以这里只要重画一帧 */
// ---------------------------------------------------------------- 设置页
/** 设置页的出厂值（点「恢复默认」就回到这里） */
const SET_DEFAULTS = {
  bg: null, waste: null, sea: null, lake: null, impass: null,
  // 线宽五档 / 浓度四档（默认都取**标准那一档** ✓ 见 W_STEPS / PW_STEPS / CONC_STEPS）
  /* ⚠ **宽度默认一律 1.0** ✗（用户定的 ✓ 原来 pw/waterW/wasteW 是 1.5 ✓）
   *   浓度（pa/ra/ca）不动 ✓ 用户说的是"宽度都是 1.0" ✓ */
  w: 1, pa: 50, ra: 75, ca: 100, pw: 1, font: 1,
  // **背景那两条线各有一套宽度 + 浓度** ✓（用户要求可调 ✓；显示开关去掉了 ✗）
  //   宽度跟「势力线宽」一个口径（格数 ✓ 直接就是粗细）；浓度是百分比 ✓
  waterW: 1, waterA: 100,                     // 水域（海/湖/河）—— 宽度默认 1 ✓
  wasteW: 1, wasteA: 100,                     // 荒地 —— 宽度默认 1 ✓
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
  /* **两张名字的不透明度**（%）—— **势力名称** = 剧本/年份那几层 · 地名 = 地区/省份/地点 ✓
   *  ⚠ 界面上叫「**势力名称**」✗（用户定的 ✓ 原来写的是"国名" ✓）
   *     它盖的其实是**剧本/年份那几层的势力名**，叫"国名"会把范围说窄 ✓
   *     变量名 labelAC / alphaCountry 是历史包袱 ✗ 不用改（改了到处都得动 ✓）
   *  半透明的好处：底下的填色和边界还看得见 ✓（用户定的档位：25 / 50 / 75 / 100 ✓）*/
  labelAC: 50,
  labelAP: 50,
  // **取完色切到哪个画图工具**（涂抹 / 填色 ✓ 用户要求可在设置里选）
  pickTool: 'paint',
};

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
const BG_STEPS = [0.5, 1, 1.5, 2, 2.5, 3];   // 水域/荒地宽度**六档**（默认 1 ✓ 0.5 是最细那档 ✓）         // 水域 / 荒地边界宽度**跟地方边界同一个范围** ✓（用户定的 ✓）
/* **0% 这一档是用户后来要的** ✗（原来从 25 起 ✓ 现在五档 ✓）
 *   0% = 那条线**完全不画** ✓ 等于"单独关掉这一种边界"而保留其余设置 ✓ */
const CONC_STEPS = [0, 25, 50, 75, 100];      // 边界浓度**五档** ✓

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
  const v = (state.set && state.set.labelMax != null)
    ? Number(state.set.labelMax) : SET_DEFAULTS.labelMax;
  return v >= LABEL_MAX_UNLIMITED ? '无上限' : Math.max(1, v) + ' 个';
}

/** 真正生效的上限（**0 = 不封顶** ✓ 给 `rebuildPaintBlocks` 用） */
function labelMaxValue() {
  const v = (state.set && state.set.labelMax != null)
    ? Number(state.set.labelMax) : SET_DEFAULTS.labelMax;
  return v >= LABEL_MAX_UNLIMITED ? 0 : Math.max(1, v);
}

/* ---- 边界那几条滑条**旁边显示当前值** ---------------------------------------
 * 跟「名字上限」那行同一个长相（标签 + 值 + 滑条 ✓ `.set-row .hint` 有 margin-right:auto
 * → 值贴着标签、滑条照样贴右 ✓）
 * 值是**动态插进去的** ✗ 不用在 HTML 里写九遍 span ✓
 */
const SLIDER_TIPS = [
  ['set-w', (v) => String(v)],
  ['set-pw', (v) => String(v)],
  ['set-water-w', (v) => String(v)],
  ['set-waste-w', (v) => String(v)],
  ['set-pa', (v) => v + '%'],
  ['set-ra', (v) => v + '%'],
  ['set-ca', (v) => v + '%'],
  ['set-water-a', (v) => v + '%'],
  ['set-waste-a', (v) => v + '%'],
  /* **名字这一栏的三根也要**（用户要求：跟边界那些一样，滑条**左边**写当前值 ✓）
   *   漏了这一步的表现就是"别的滑条旁边有数字、名字这几根没有" ✓
   *   ⚠ 「势力名称上限」不在这儿 ✗ 它自己有 set-labelmax-v 那个 span（还要写"无上限" ✓）*/
  ['set-font', (v) => v + '×'],
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

/** 把设置里那几种颜色盖到 LUT 的特殊节点上（海 / 湖 / 不可通行） */
function applyLutOverrides() {
  const s = state.set || {};
  if (!renderer || !state.titles) return;
  const K = state.titles.keys;
  // 同一类在不同作品里键不同（EU4 的荒地叫 #wasteland）→ 都列上 ✓
  const want = { '#sea': s.sea, '#lake': s.lake, '#river': s.river,
    '#impassable': s.impass, '#impassable_sea': s.impassSea,
    '#wasteland': s.impass };
  for (let i = 0; i < K.length; i++) {
    const c = want[String(K[i])];
    // 自定义色是 null（「恢复默认」）也要把 LUT 写回**烘数据时的原色** ——
    // 直接跳过的话，之前盖上去的自定义海/湖/河颜色会一直残留在显存里
    const o = c || state.titles.colors[i];
    if (o) renderer.setLutColor(i, o[0], o[1], o[2]);
  }
}

/** 设置改了就调它：推到渲染器 / 标签层并重画 */
function applySettings() {
  /* **两张名字的不透明度**送到标签层 ✓（那边按 tier 分层挑用 ✓）
   *   放到 applySettings 最前面：它不依赖下面任何几何设置 ✓ 早设早生效 ✓ */
  if (labels) {
    const _ac = state.set.labelAC != null ? Number(state.set.labelAC) : 50;
    const _ap = state.set.labelAP != null ? Number(state.set.labelAP) : 50;
    labels.alphaCountry = _ac / 100;
    labels.alphaPlace = _ap / 100;
    labelDirty = true;
  }
  const s = state.set || (state.set = Object.assign({}, SET_DEFAULTS));
  if (renderer) {
    const bg = s.bg || [150, 150, 150];
    renderer.backdrop = [bg[0] / 255, bg[1] / 255, bg[2] / 255];
    // 荒地就是不可通行 —— 用同一个颜色（设置里只有「不可通行」这一项）✓
    const wg = s.impass || s.waste || [94, 94, 94];
    renderer.wasteGrey = [wg[0] / 255, wg[1] / 255, wg[2] / 255];
    renderer.dirty = true;
  }
  resyncTitleLut();
  applyLutOverrides();
  if (typeof window !== 'undefined') window.__CK3_FONT_SCALE = s.font || 1;
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
 * 手绘层变了：喊一声。自动填色（开着的化）会在下一帧重算。
 * 涂色、擦除、撤销、重做、导入、清除 —— 全部走这里。
 */
function markPaint() {
  state._paintSeq = (state._paintSeq || 0) + 1;  state._paintAnyFor = null;     // 作废：下一帧同步时按新数组重扫 ✓

}

function recomputePainted() {
  markPaint();   // 手绘层变了 —— 自动填色靠它知道该重算了（实时）
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
  // 撤销/重做/导入之后，荒地那些"自动底色"要重铺一遍
  // （玩家涂过的地方会被跳过，所以不会盖掉他的笔迹）
}

/**
 * 荒地自动上色 —— 写成**地图原版颜色**（改那一块荒地自己的节点颜色）。
 *
 * 归属是构建时烘好的（`wastelandAuto`：按"整条陆地周长里贴着某一个国家的比例"算，
 * 严格过半才认）。它属于原版那一层，所以：关掉「填色·颜色」照样看得见、
 * 不进涂色导出、也不进撤销历史；玩家自己涂过的地块仍然以玩家为准
 * （着色器里手绘永远在头衔色之上）。
 *
 * 每块荒地都在最细那层有自己的节点，所以这里能一块一块改颜色。
 * 关掉开关就把颜色**还回原来的那个灰**（节点自带的 color）。
 */

function syncLayerSwitches() {
  const n = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  // 边界各听各的：势力·边界 → 原版地界；填色·边界 → 按**当前显示颜色**画的分界 ✓
  // （放在早退之前：CK3 没有年代层，也要同步这条 ✓）
  // 这条边界要一直跑（剧本/头衔本来就有的颜色也算 ✓），不再看手绘层空不空 ✗
  // **哪一层都画** ✓ —— 细层（地区/省份/地点视图）也要，跟剧本层**同一套规矩**：
  //   浓度 = 势力边界浓度（设置页那一档，内部字段仍叫 ca；实心），粗细 = 链上最粗那一档（见下面 _pw）✓
  //   （以前写死"只在剧本/国家那层"✗ —— 细层里勾了「填色 · 边界」什么都不出来 ✓）
  const _wantPaintBorder = !!state.showBorderPaint;
  if (renderer.borderPaint !== _wantPaintBorder) {
    renderer.borderPaint = _wantPaintBorder;
    renderer.dirty = true;
  }
  // 这条边界**比什么**：
  //   · CK3（没有年代层）和**细层**（地区/省份/地点视图）→ 只管**自己涂出来的那一圈** ✓
  //     （细层要是按"显示颜色"比，原版每个省本身颜色就不同 → 整张图的省界上都会多出
  //      一条又粗又实的涂色线，叠在本层细线上面，看着就是"所有线条都变粗了" ✗）
  //   · 剧本/国家那层 → 按**当前显示颜色**比（原版剧本色也算分界）✓
  const _paintOnly = !(n > 0 && state.tier < n);
  if (renderer.paintOnly !== _paintOnly) {
    renderer.paintOnly = _paintOnly;
    renderer.dirty = true;
  }
  /* ---- 水域边界（海洋 / 湖泊 / 河流 ✓ 用户定的四条 ✓）------------------------
   *   · **一直画** ✓ 只有下面这三个**全关了**才跟着藏 ✓（用户指着截图定的 ✓）
   *       势力 · 边界 ✓  地区 · 边界 ✓  填色 · 边界 ✓
   *       （不是"按当前模式挑出来的那一个" ✗ 那样会漏掉另一个 ✓ 父级边界也不算 ✓）
   *   · 粗细取**势力边界**那个值 ✓（= 链上最粗那条 ✓）
   *       数值一样 ✓ 但**各是各的** ✗ 不做绑定（以后改一边不会动另一边 ✓）
   *   · 浓度实心 ✓（着色器那边写死 1，没有浓度 uniform ✓）
   *   · 三个水域色每帧送上去 ✓ 设置里改了颜色立刻生效 ✓
   */
  {
    /* **当前模式里能关的那几个边界**全关了，才连水域 + 荒地一起藏 ✓
     *
     * 有年代层的模式（EU4 / HOI4 / V3 / EU5）：界面上的三组是
     *   · 势力 · 边界（showPowerBorder）
     *   · 地区 · 边界（showRegionBorder）
     *   · 填色 · 边界（showBorderPaint）
     * CK3：那两组是**隐藏的**（它没有国家层，只有「头衔」那一组），
     *   能关的是 头衔 · 边界（showBorderTitle）+ 填色 · 边界 ✓
     *
     * ⚠ 所以**不能写死那三个名字** ✗ —— 以前就是写死的，于是 CK3 里把
     *   「头衔·边界」和「填色·边界」都关了，水域和荒地那两条线照样画 ✓
     *   （隐藏的 `showRegionBorder` 默认还是 true，把判断顶上去了 ✓）
     * 父级边界不算在里头 ✓（它是地区那一组的子选项 ✓）
     */
    const _hasSw = !!$('show-power-border') && n > 0;    // 跟 syncParentBorder 里同一个判法 ✓
    const _anyBorderOn = _hasSw
      ? !!(state.showPowerBorder || state.showRegionBorder || state.showBorderPaint)
      : !!(state.showBorderTitle || state.showBorderPaint);
    if (renderer.showWater !== _anyBorderOn) { renderer.showWater = _anyBorderOn; renderer.dirty = true; }
    /* **粗细 / 浓度都是这两条线自己的** ✓（用户要求：水域和荒地各有一组开关 + 宽 + 浓 ✓
     *   以前：水域固定 1 格 × 基准缩放、浓度写死实心 ✗
     *         荒地借「填色边界」那两个值（uPaintBorderW / uPaintBorderA）✗）
     *   值都是**格数 / 百分比**，跟「势力线宽」一个口径 ✓ */
    const _wW = (state.set && state.set.waterW != null) ? Number(state.set.waterW) : 1;
    const _wA = ((state.set && state.set.waterA != null) ? Number(state.set.waterA) : 100) / 100;
    const _sW = (state.set && state.set.wasteW != null) ? Number(state.set.wasteW) : 1.5;
    const _sA = ((state.set && state.set.wasteA != null) ? Number(state.set.wasteA) : 100) / 100;
    const _showW = _anyBorderOn;          // 没有单独的开关了：只看"当前模式的边界全关了没" ✓
    const _showS = _anyBorderOn;
    if (renderer.showWater !== _showW) { renderer.showWater = _showW; renderer.dirty = true; }
    if (renderer.showWasteBorder !== _showS) { renderer.showWasteBorder = _showS; renderer.dirty = true; }
    if (Math.abs(renderer.waterW - _wW) > 0.001) { renderer.waterW = _wW; renderer.dirty = true; }
    if (Math.abs(renderer.waterA - _wA) > 0.001) { renderer.waterA = _wA; renderer.dirty = true; }
    if (Math.abs(renderer.wasteW - _sW) > 0.001) { renderer.wasteW = _sW; renderer.dirty = true; }
    if (Math.abs(renderer.wasteA - _sA) > 0.001) { renderer.wasteA = _sA; renderer.dirty = true; }
    /* 三个水域色：**必须跟 LUT 里真正生效的那个颜色一致** ✓
     *
     * ⚠ 两个坑我都踩过 ✗
     *   ① 不能读 state.special ✗ —— 那是"从地图数据里认出来的默认色"，跟 LUT 没关系 ✓
     *   ② 光读 state.set 也不行 ✗ —— 它默认是 **null**（用户没改过就没值 ✓）
     *      而 applyLutOverrides 是 `if (c) 才覆盖` ✓ null 就不覆盖 ✓
     *      → 那会儿 LUT 里用的是**地图数据烘进去的原色** ✓
     *
     * 所以：设置里有就用设置的 ✓ 没有就退回**原色** ✓ 两条合起来才等于 LUT 里的真值 ✓
     *（诊断打出来的：renderer.seaCol=[0,0,0]、set.sea=null、#sea 在 keys 的索引 17675 ✓
     *  —— 伪头衔是有的 ✓ 就是颜色没取到 ✓）
     */
    const _origCol = (key) => {
      const t = titleIndexByKey(key);            // 反查表：不再每次 indexOf 扫全表
      if (t < 0) return null;
      const c = (state.titles && state.titles.colors && state.titles.colors[t]) || null;
      return (c && c.length >= 3) ? [c[0] / 255, c[1] / 255, c[2] / 255] : null;
    };
    const _effCol = (key) => {
      const s = (state.set || {})[key.slice(1)];      // '#sea' → state.set.sea ✓
      if (s && s.length >= 3) return [s[0] / 255, s[1] / 255, s[2] / 255];
      return _origCol(key);
    };
    const _sea = _effCol('#sea'), _lake = _effCol('#lake'), _river = _effCol('#river');
    const _same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 0.002 && Math.abs(a[1] - b[1]) < 0.002 && Math.abs(a[2] - b[2]) < 0.002;
    if (_sea && !_same(renderer.seaCol, _sea)) { renderer.seaCol = _sea; renderer.dirty = true; }
    if (_lake && !_same(renderer.lakeCol, _lake)) { renderer.lakeCol = _lake; renderer.dirty = true; }
    if (_river && !_same(renderer.riverCol, _river)) { renderer.riverCol = _river; renderer.dirty = true; }
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
  if (!n) {
    // CK3（没有年代层）：界面上「头衔」那一组的勾选**直接说了算**。
    // 以前这里什么都不做，state.showBorderTitle 就一直是旧值（默认 false），
    // 而父级链又去听了隐藏的「地区·边界」→ 表现就是"边界关了，父级线还在" ✗
    const _bt = $('show-border-title');
    const _tt = $('show-titles');
    if (_bt && state.showBorderTitle !== _bt.checked) state.showBorderTitle = _bt.checked;
    if (_tt) state.showTitles = _tt.checked;
  }
  if (!n || !$('show-power-color')) return;          // CK3 / 没有年代层的：不动
  const isPower = state.tier < n;
  // 边界是照**编辑层**画的（开粒度时就是粒度那一层）→ 听**那一类**的开关
  const _editIsPower = editTier() < n;
  const col = isPower ? state.showPowerColor : state.showRegionColor;
  // 名称按**画的是哪一层**分（跟视图停在哪无关）：
  //   地名画的是编辑层（开粒度时是粒度那层）→ 听「地区 · 名称」
  //   剧本层那批国名 = 玩家地名那份分组         → 听「填色 · 名称」
  const nm = state.showRegionName;
  // 签名要把"真正会用到的那几个"都算上：颜色类、编辑类的边界、名称类
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
  const _setW = state.set && state.set.w;
  const baseW = _setW ? _setW : state._borderWidthBase;   // 设置页改过就用它的 ✓
  // 「势力/地区」那两套分开关只在**有年代层的模式**里才有意义；
  // CK3 界面里这些元素虽然存在（只是隐藏），但不能拿它们当依据 ✗
  const hasSwitches = !!$('show-power-border') && nEra > 0;
  // 某一层听哪个开关：年份层（国家/剧本）归「势力」，其余归「地区」；CK3 还是那一组
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
  const _wScale = ((state.set && state.set.w) ? state.set.w : 1) / 1;
  /* 宽度不再层层加粗（用户定的：父级链 / 涂色边界那个 1.25、1.5 的额外倍率取消掉 ✓）
   *   以前：本层 1.0× · 父层 1.25× · 填色 1.5× —— 都是拿「地方边界宽度」再乘一遍 ✗
   *        于是你在设置里拉 1，画出来却有三档粗细 ✓ 跟设置对不上 ✓
   *   现在：一律 1.0× = 就是你在「地方边界宽度」里拉的那个值 ✓
   *   层与层的区别交给浓度（地区 75% / 势力 100% ✓）和各自的宽度设置 ✓
   *   ⚠ 涂色边界（填色线）走的是「势力边界宽度」那个设置（_pwW ✓ 默认值 1.5 ✓）
   *     它本来就**没被乘过** ✗ 那个 1.5 是设置值本身、不是倍率 ✓
   *   ⚠ W_TOP 更是早就没人用了（死变量 ✗ 只有定义、搜不到任何引用 ✓）
   *     一并删掉 —— 留着迟早被谁当成「填色线该乘 1.5」捡起来用 ✓ */
  const W_THIN = 1.0 * _wScale;    // 本层
  const W_PARENT = 1.0 * _wScale;  // 父级链（不再 ×1.25 ✓）
  /* **势力线宽 = 就是这个粗细** ✓（以前是"乘在别人身上的倍率" ✗ 用户说很难理解 ✓）
   *   单位跟「基准线宽」一样是"格"：势力那条线 / 势力层上的本层线 / 填色线 ——
   *   三条都**直接用这个值** ✓（它们本来就该一样粗 ✓），不乘基准缩放 ✗ */
  const _pwW = (state.set && state.set.pw != null) ? Number(state.set.pw) : 1.5;
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
    // CK3（没有年代层）：只描**地理上的上一层**（父级）✓
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
  const _PA = ((state.set && state.set.pa != null ? state.set.pa : 50) / 100);
  const _RA = ((state.set && state.set.ra != null ? state.set.ra : 75) / 100);
  const _CA = ((state.set && state.set.ca != null ? state.set.ca : 100) / 100);
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
  if (renderer.borderStrength !== _bs && _bs != null) {
    renderer.borderStrength = _bs;
    renderer.dirty = true;
  }
  /* 「势力线宽」倍率（用户定的 ✓ 这个滑条**同时管两条线** ✓）
   *   滑条名字原来是「填色线宽」✓ 现在改叫「势力线宽」✓（见 index.html ✓ 内部字段仍叫 pw ✓
   *   免得旧存档和测试崩 ✗）
   *   它乘在**势力那条线**和**填色线**上 ✓ 两条线因此粗细完全一致 ✓（用户要求 ✓）*/
  
  // 本层（链上最细那条）也跟着细一档；没有链时恢复基准
  // **没有链 + 当前就在势力那层 → 这条本层线就是势力线** ✓
  // 要跟填色线同一套（同一个下限 + 乘「势力线宽」倍率）✓ 用户要求 ✓
  const _wBase = _isPowerBase ? _pwW : W_THIN;
  if (Math.abs(renderer.borderWidth - _wBase) > 0.01) {
    renderer.borderWidth = _wBase;
    renderer.dirty = true;
  }

  // **填色边界**：它就是链上的**爷爷那一级** —— 粗细按"爷爷档"（基准×0.75 再加 0.5）+ 实心 ✓
  // 注意不能只取"链上最粗那条"：CK3 的链只有父级一级，那样拿到的是**父级档** ✗
  // 所以以"爷爷档"为下限 —— 链本身更粗就跟着链（年代模式不变），CK3 则从父级提到爷爷 ✓
  const _pw = _pwW;             // 填色线：跟势力线**同粗** ✓（同一个设置值 ✓）
  if (Math.abs(renderer.paintWidth - _pw) > 0.01) {
    renderer.paintWidth = _pw;
    renderer.dirty = true;
  }
  if (Math.abs(renderer.paintAlpha - _CA) > 0.01) {
    renderer.paintAlpha = _CA;
    renderer.dirty = true;
  }

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

function wasteWatch() {
  // 开关/层级的签名（跟涂色分开）—— 它们一变就得**全量**重算 ✓
  const sigUI = `${state.tier}|${state.showPaint}|${state.showTitles}|${state.showWaste}`;
  const sig = sigUI + `|${state._paintSeq || 0}`;   // 手绘层一变就重算（实时）
  if (state._wasteSig === sig) return;
  if (state._wasteSigUI !== sigUI) state._wasteDirty = null;   // 全量 ✓
  state._wasteSigUI = sigUI;
  if (state.wasteAuto) {
    // **尾部节流**：连续涂色时最多 ~120ms 一次；停手后会补算（签名这时才记账 ✓）
    const now = performance.now();
    if (now - (state._wasteAt || 0) <= 120) return;
    state._wasteAt = now;
    state._wasteSig = sig;
    wasteApply();
    return;
  }
  state._wasteSig = sig;
  wasteClear();
}

/** 开关「自动荒地涂色」（处理器与自测都走这里）*/
function setWasteAuto(on) {
    state.wasteAuto = on;
    if (state.wasteAuto) {
      // 自动色看不见就太蠢了 —— 顺手把「荒漠 · 涂色」打开
      if (!state.showWaste) {
        state.showWaste = true;
        const cb = $('show-waste');
        if (cb) cb.checked = true;
        // 推 **true**：荒地显示自己（自动算出来）的颜色 ✓
        // 原来这里推的是 false = "荒地恒显示灰"，跟上面那句"把荒漠·涂色打开"自相矛盾，
        // 结果是自动上的色根本看不见 ✗（快照 diff 证实这行不是最近改坏的，是老毛病）
        renderer.setShowWaste(true);
      }
      wasteApply();
    } else {
      wasteClear();
    }
    labelDirty = true;
}

function wasteApply() {
  // **保底**：一次触发就跑到不再变化（最多 8 圈）。
  // 一圈只往外推一环，跑满几圈才能把该上色的都上完。
  let total = 0;
  for (let pass = 0; pass < 8; pass++) {
    const changed = wastePassOnce();
    total += changed;
    if (!changed) break;
  }
  state._wasteDirty = null;      // 算完就清 ✓（下次没人标脏 = 全量 ✓）
  return total;
}

function wastePassOnce() {
  if (!renderer || !state.titles || !state.meta) return 0;
  const per = state.meta.wastelandPerimeter;
  if (!per || !per.length) return 0;
  const fine = state.meta.tierNames.length - 1;
  const paint = renderer.paintData;
  const lut = renderer.lutData;
  const GREY = 94;                        // 荒地原版灰 = "还没上色"
  // 按下去那一刻，各荒地节点此刻的颜色 —— 这一按从头到尾都读这份快照，
  // 免得"边算边看"导致结果依赖遍历顺序。
  const snap = new Map();
  for (const t2 of (state.meta.wasteland || [])) {
    snap.set(t2, [lut[t2 * 4], lut[t2 * 4 + 1], lut[t2 * 4 + 2]]);
  }
  let n = 0;
  for (const entry of per) {
    const pid = entry[0], nbrs = entry[1];
    if (state.provTitle && state.provTitle[pid] >= 0) continue;   // 玩家自己涂的，别动
    const tid = titleAt(pid, fine);
    if (tid === NO_TITLE || tid == null) continue;
    // **不参与自动填色的地块**（数据里列的巨型荒地）：保持荒地灰
    if (isWasteSkipPid(pid)) {
      const b0 = wasteGrey();
      if (lut[tid * 4] !== b0[0] || lut[tid * 4 + 1] !== b0[1] || lut[tid * 4 + 2] !== b0[2]) {
        renderer.setLutColor(tid, b0[0], b0[1], b0[2]);
        n++;
      }
      continue;
    }
    let tot = 0;
    const votes = new Map();              // "r,g,b" → {w, rgb}
    for (const pair of nbrs) {
      const nb = pair[0], w = pair[1];
      tot += w;
      let rgb = null;
      let src = "title";               // 这一票是"原版色"来的，还是"玩家涂的色"来的 ✓
      if (state.showPaint && paint && paint[nb * 4 + 3] > 0) {
        rgb = [paint[nb * 4], paint[nb * 4 + 1], paint[nb * 4 + 2]];
        src = "paint";
      } else {
        const nt = titleAt(nb, state.tier);
        if (nt === NO_TITLE || nt == null) continue;     // 这一层没主：只进分母
        // **看显示出来的颜色**（跟吸管同一套）：填色·颜色/头衔·颜色/荒漠·涂色 都算数 ✓
        // 荒地邻居用本圈开始时的快照（它们正是这一圈要改的），别的现取。
        if (snap.has(nt)) {
          // 邻居也是荒地：**只有"已经给它算过色"的才算一票** ✓
          // 没算过的荒地还挂着数据里那个技术色（EU5 的荒地底下五颜六色，屏幕上却是灰的），
          // 拿它当票投出去 = 凭空继承邻居荒地的私有颜色 —— 用户报的
          // 「西伯利亚针叶林变成莫名其妙的颜色」就是这么来的 ✗（只进分母）
          if (!(state.wasteSrc && state.wasteSrc.has(nb))) continue;
          rgb = snap.get(nt).slice();
          src = (state.wasteSrc && state.wasteSrc.get(nb)) || "title";
        } else {
          rgb = displayedColor(nb, nt).slice();
        }
        // 纯灰 = "没有颜色"（荒地灰 / 背景灰）：只进分母，不当票
        if (rgb[0] === rgb[1] && rgb[1] === rgb[2] && (rgb[0] === GREY || rgb[0] === 150)) {
          continue;
        }
      }
      const key = `${rgb[0]},${rgb[1]},${rgb[2]}`;
      let v = votes.get(key);
      if (v === undefined) { v = { w: 0, rgb, wp: 0, wt: 0 }; votes.set(key, v); }
      v.w += w;
      if (src === "paint") v.wp += w; else v.wt += w;
    }
    let best = null;
    for (const v of votes.values()) if (best === null || v.w > best.w) best = v;
    // 荒地"没上色"的样子 = 荒地灰（**不是**数据里那个技术色）✓
    const baseC = wasteGrey();
    // 过半 → 用那个色；**没有任何颜色过半 → 自己变回荒地灰**
    let want = (tot && best && best.w * 2 > tot) ? best.rgb : baseC;
    // **来源随开关**：原版色来的看「颜色」开关，玩家色来的看「填色·颜色」开关 ✓
    if (tot && best && best.w * 2 > tot) {
      const srcWin = best.wp >= best.wt ? "paint" : "title";
      state.wasteSrc = state.wasteSrc || new Map();
      state.wasteSrc.set(pid, srcWin);
      const srcOn = srcWin === "paint" ? !!state.showPaint : !!state.showTitles;
      if (!srcOn) want = baseC;        // 对应开关关着 → 回荒地原版灰 ✓
    } else if (state.wasteSrc) {
      state.wasteSrc.delete(pid);
    }
    if (!want) continue;
    if (lut[tid * 4] === want[0] && lut[tid * 4 + 1] === want[1] && lut[tid * 4 + 2] === want[2]) {
      continue;                       // 颜色没变 → 不写、也不计（免得空转）
    }
    renderer.setLutColor(tid, want[0], want[1], want[2]);
    n++;
  }
  renderer.dirty = true;
  return n;
}

/**
 * 「清除荒地填色」——**只清玩家自己涂在荒地上的笔迹**。
 *
 * 自动填色写的是"原版色"那一层（LUT），跟玩家的手绘层是两回事 ✓，
 * 所以这个按钮只动玩家那一层：走 restoreTitle（跟擦除工具同一套，带撤销历史）。
 */
function wasteClearPlayerPaint() {
  if (!state.titles || !state.meta) return 0;
  const fine = state.meta.tierNames.length - 1;
  const n = state.meta.numProvinces;
  const seen = [];
  const pids = [];
  for (let pid = 1; pid < n; pid++) {
    if (!(state.provTitle && state.provTitle[pid] >= 0)) continue;   // 不是玩家涂的
    const tid = titleAt(pid, fine);
    if (tid === NO_TITLE || tid == null) continue;
    if (!isWastelandTid(tid)) continue;                              // 不是荒地
    if (seen.indexOf(tid) < 0) seen.push(tid);
    pids.push(pid);
  }
  paintPids(pids, null);       // 按地块清（清的还是这些荒地 ✓，只是不再绕头衔那一圈）
  return seen.length;
}

/** 「清除自动涂色」：荒地全部还原成**荒地灰**（你手涂的地块不受影响）。 */
function wasteClear() {
  if (!renderer || !state.titles || !state.meta) return 0;
  const w = wasteGrey();
  let n = 0;
  for (const t2 of (state.meta.wasteland || [])) {
    renderer.setLutColor(t2, w[0], w[1], w[2]);
    n++;
  }
  renderer.dirty = true;
  return n;
}

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
  const want = [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0].join(',');
  const wantName = String(label || '');
  const et = editTier();
  const n = state.meta ? state.meta.numProvinces : 0;
  const pd = renderer && renderer.paintData;
  const out = [];
  const seen = new Set();
  for (let q = 1; q < n; q++) {
    if (!pd || pd[q * 4 + 3] === 0) continue;
    if ((pd[q * 4] + ',' + pd[q * 4 + 1] + ',' + pd[q * 4 + 2]) !== want) continue;
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
  const want = paintIdentAt(pid, et);      // 身份串就在这一处算（见 paintIdentAt ✓）
  if (!want) return [];
  // ⚠ 身份**只能逐格算** ✗ —— 同一个头衔底下的地块可以涂成不同颜色/不同标记，
  //   身份是按"这块地"算的，不能按头衔缓存（缓存过一版，结果整片认错族 ✓）
  const out = new Set();
  for (let q = 1; q < n; q++) {
    if (paintIdentAt(q, et) === want) out.add(tm[et * n + q]);
  }
  return Array.from(out);
}

/** 跟 playerGroupTidsAt 同一套身份（标签名 + 颜色），但返回**地块** —— 用于按地块逐块涂 ✓ */
function playerGroupPidsAt(pid) {
  const pd = renderer && renderer.paintData;
  const n = state.meta.numProvinces;
  if (!pid || !pd) return [];
  const et = editTier();
  const want = paintIdentAt(pid, et);
  if (!want) return [];
  const out = [];
  for (let q = 1; q < n; q++) if (paintIdentAt(q, et) === want) out.push(q);
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
  const eraT = countryTier();                    // 「最近的**有主**剧本层」✓
  const mine = provInfoAt(pid, eraT);
  if (!mine) return null;

  // A. 「势力 · 边界」开着 → 剧本归属那一整块 ✓
  if (state.showPowerBorder && !state.showBorderPaint) {
    const out = [];
    for (let q = 1; q < n; q++) {
      const o = provInfoAt(q, eraT);
      if (o && sameOwner(o.owner, mine.owner)) out.push(q);
    }
    if (out.length) return out;
  }

  // B. 填色那条（填色开着 / 两个都没开 ✓）
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
  state._wasteDirty = null;      // 头衔重刷会影响显示颜色 → 荒地那套全量重算 ✓
  blocksDirty = true;
  labelDirty = true;
  updateStatus();
  scheduleSave();
  markPaint();
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
 * 一块地的"身份串"（显示名 | r,g,b）。**这是认族唯一的判据** ✓
 *
 * 不分配任何数组 —— 它在全图扫里被调用，每次分配一个 [r,g,b] 就是 4 万次垃圾 ✓
 * @param {number} q     地块号
 * @param {number} tier  看哪一层的头衔（**名字取这一层**）
 */
function paintIdentAt(q, tier) {
  if (!q) return null;
  const pd = renderer && renderer.paintData;
  const q4 = q * 4;
  const painted = !!(pd && pd[q4 + 3] > 0);
  const t0 = titleAt(q, tier);
  const noOwn = t0 == null || t0 === NO_TITLE;
  // **没涂过的无主地：没有身份** ✓（不参与认族）
  // **涂过的照旧有** ✓ —— 名字和颜色都在手绘层上，跟这一层有没有主无关 ✓
  // （空白剧本那一层全是无主地，涂出来的色块就靠这一条才能"同色同标记算一族" ✓）
  if (noOwn && !painted) return null;

  const lq = state.provLabel ? (state.provLabel[q] | 0) : -1;
  const name = painted
    ? (lq >= 0 ? String(state.labelNames[lq] || '') : '')
    : String((state.titles.names[t0]) || '');

  let r, g, b;
  if (painted) {
    r = pd[q4]; g = pd[q4 + 1]; b = pd[q4 + 2];
  } else {
    const c = state.titles.colors[t0];
    if (!c) { r = 150; g = 150; b = 150; }
    else { r = c[0]; g = c[1]; b = c[2]; }
  }
  return name + '|' + r + ',' + g + ',' + b;
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
function liveNameOf(pid, tid) {
  if (!liveHoverOn()) return null;
  // **这一格自己的填色归属**（名字就在手绘层上：标记编号 → 名字 ✓）——
  // 以前是"翻遍各层头衔、去 `paintColor`/`titleLabel` 那两张表里找哪一笔涂的" ✗
  // （同一个头衔下可以有好几笔、好几个名字，按头衔找本来就会找错 ✓）
  const here = provInfoAt(pid);
  if (here && here.fill && here.fill.name) return String(here.fill.name);
  const lq = state.provLabel ? (state.provLabel[pid] | 0) : -1;
  if (lq >= 0) {
    const nm = String(state.labelNames[lq] || '');
    if (nm) return nm;
  }
  return null;
}

function paintAt(pid, tid) {
    // 没头衔 / 越界：不涂（界面上走不到这儿 —— actAt 会把无主地换到最细那层 ✓，
    // 但外部直接调它（脚本 / 测试）时别崩 ✗）
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
    // 荒地：只有「荒漠 · 涂色」开着时才给涂。
    // 关着 = 不对荒地做任何填色（这是用户要的语义：那个开关是荒地填色的总闸）
    if (isWastelandTid(tid) && !state.showWaste) {
      return;   // 静静地不涂就行，别弹东西打扰
    }
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
  if (!pids.length) return;                 // 锁住的伪头衔（海 / 荒地那种）涂不上 ✓
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

function minScale() {
  // 刚好把整张图放进视口的比例，再小就只会在边上留出地图外的空地
  return Math.min($('stage').clientWidth / state.meta.mapWidth,
                  $('stage').clientHeight / state.meta.mapHeight);
}

/** 相机不许跑出地图：哪一边地图比视口小就居中，比视口大就不许把边缘拖进来 */
function clampCamera() {
  const stage = $('stage');
  const vw = stage.clientWidth / state.cam.scale;
  const vh = stage.clientHeight / state.cam.scale;
  const W = state.meta.mapWidth;
  const H = state.meta.mapHeight;
  state.cam.cx = vw >= W ? W / 2 : clamp(state.cam.cx, vw / 2, W - vw / 2);
  state.cam.cy = vh >= H ? H / 2 : clamp(state.cam.cy, vh / 2, H - vh / 2);
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
    const hl = hoverTargetTid(pid, state.hover.tids[editTier()]);
    // 海 / 山是背景板，不给选中，也不高亮
    applyHoverHighlight(pid, hl);
    labelDirty = true;
    updateCursor(hl);
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
  return tid !== NO_TITLE && tid != null && state.titles.keys[tid].charCodeAt(0) === 35;
}

/** 能不能对这块地动手：没头衔、或者只是背景地形，都算锁住
 *
 * **荒地例外**：开了「荒地可上色」（state.showWaste）时，荒地是可以动手的 ✓
 *   以前这里一律按伪头衔锁住 ✗ → 那个开关打开也涂不上去 ✓
 *   （用户报的：开了允许上色但是无法上色 ✓）
 *   荒地 = meta.wasteland 里列的那些 ✓ 或者最细层那个 #impassable* 节点 ✓
 *   （跟悬停卡片那边的判法保持一致 ✓）
 *
 * **但「不可通行海域」不算荒地**（用户要求 ✓）—— 它是**水**，跟海一个待遇：
 *   开着「允许」也不给涂。以前那句"`#impassable` 开头就放行"把海也放了 ✗ →
 *   光标是十字、点下去还会在历史和「改动 N」里记一笔（syncPaint 因为它是 `@`
 *   层，最后并没上色，只留下一笔脏状态 ✗）。
 *   判法照抄别处那两处（悬停卡片 / 水域判据）：`#impassable` 开头 **且** 含 sea ✓
 */
function isLocked(tid) {
  if (tid === NO_TITLE || tid == null) return true;
  if (!isSpecialTid(tid)) return false;
  if (state.showWaste) {
    const _key = String((state.titles.keys && state.titles.keys[tid]) || '');
    // 不可通行**陆地**：允许时可涂；不可通行**海域**不算（它是水，跟海一个待遇）
    if (keyStarts(_key, '#impassable') && !isImpassSeaKey(_key)) return false;
    if (isWastelandTid(tid)) return false;                             // 荒地：同上
  }
  return true;
}

/** 能编辑的地块给十字光标，锁住的给禁止符 */
function updateCursor(tid) {
  const el = $('map');
  if (state.tool === 'view') { el.style.cursor = 'grab'; return; }
  el.style.cursor = isLocked(tid) ? 'not-allowed' : 'crosshair';
}

/** 这个省份是不是**没有男爵领、拿伯爵领色块顶**的那种（快查表） */
function isDegradedBaron(pid) {
  const s = state.meta && state.meta.degradedSet;
  return s ? s.has(pid) : hasIn(state.meta && state.meta.degradedBaronies, pid);
}

function renderHoverCard(pid) {

  const box = $('hover-chain');
  $('hover-pid').textContent = pid ? `#${pid}` : '';


  if (!pid) {
    box.innerHTML = `<p class="empty">${GAME.notInMap}</p>`;
    return;
  }
  box.innerHTML = '';

  // 海、湖、荒地：背景地块，不列层级、不给取色
  const special = state.hover.tids[editTier()];
  const _fineTid0 = state.hover.tids[TIER_COUNT - 1];
  const _fineKey0 = _fineTid0 != null ? String(state.titles.keys[_fineTid0] || '') : '';
  const _isWasteTile = isWastelandTid(special);
  const _isImpass = keyStarts(_fineKey0, '#impassable');
  if (isSpecialTid(special) || _isWasteTile || _isImpass) {
    // 这一块自己的名字（数据里存各地块名；CK3 存键名，认不出来就不显示）
    const raw = state.provinceNames ? state.provinceNames[pid] : null;
    const _fineTid = state.hover.tids[TIER_COUNT - 1];
    // 有些数据里 provinceNames 只是代号（EU4 的不可通行是 'RNW' 这种 ✗），
    // 真正的名字在最细层那个节点上（昆仑山）→ 优先用它 ✓
    const _fineName = _fineTid != null ? String(state.titles.names[_fineTid] || '') : '';
    const _key = _fineTid != null ? String(state.titles.keys[_fineTid] || '') : '';
    // **荒地就是不可通行** —— 同一件事，数据里从两处进来：
    //   最细层的 #impassable 节点（海域那类）· 荒地名册（陆地屏障，键多为 wl_<pid>）
    const _isImpassable = keyStarts(_key, '#impassable') || isWastelandTid(_fineTid);
    const _ck3 = (typeof GAME !== 'undefined' && GAME && GAME.id === 'ck3');
    const _dataName = state.titles.names[special] || '';
    // 陆地统一叫「不可通行区域」；海域保留原本的类型名（不可通行海域）✓
    // （海分区/逐块海块那套已经删了：现在海就是共享的 #sea 节点，名字本来就叫「海洋」✓）
    const _typeLabel = _isImpassable ? (_dataName.includes('海域') ? _dataName : '不可通行区域')
      : _dataName;
    // **CK3 的湖泊与不可通行都不显示名字**（用户要求）；别的游戏照显示 ✓
    // 海洋、河流不显示名字；湖泊显示 ✓
    // ⚠ 这里**不写成 isWaterKey(_key)** ✗ —— 那个把「不可通行海域」也算成水 ✓
    //   而它是有意义的类型名、卡片上要显示出来（下面 _isImpassable 那条走它 ✓）
    const _isSeaKey = keyStarts(_key, '#sea') || keyStarts(_key, '#seaname_');
    const _noName = _isImpassable || _isSeaKey || keyStarts(_key, '#lake') || keyStarts(_key, '#river');
    const manual = manualWaterName(raw);
    // 代号（RNW / wl_1231 这类）先换成最细层的真名；真名也没有才退回代号 ✓
    const _nameSrc = (manual || raw);
    // 回退时**不要**拿共享节点的泛称（湖泊/海洋/河流）当名字 ✗
    const _generic = ['湖泊', '海洋', '河流', '不可通行'];
    const _fineOk = _fineName && !_generic.includes(_fineName);
    const pn = readablePlaceName(_nameSrc) ? _nameSrc
      : (readablePlaceName(_fineName) && _fineOk ? _fineName : _nameSrc);
    // **有真名就显示** ✓（CK3 除外 —— 那边是你之前定过"不可通行不显示名字"✓）
    // 原尺寸那份数据把某些地块挂到了荒地节点上 → 以前会只剩「不可通行区域」✗
    // 现在跟原版一样：有名字（俄罗斯针叶林那种）就把名字放出来 ✓
    const readable = readablePlaceName(pn) && (!_noName || (_isImpassable && !_ck3));
    box.innerHTML =
      `<p class="empty"><b style="color:var(--text-dim)">${_typeLabel}</b>`
      + (readable ? `<br><b style="color:var(--text)">${pn}</b>` : '')
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
      // 荒地（键是 wl_<省份号>）：名字后面挂上编号 —— 便于指认"这一块"到底是哪块
      const wid = (info.key && info.key.indexOf('wl_') === 0)
        ? ` <span style="color:var(--text-faint)">#${info.key.slice(3)}</span>` : '';
      row.innerHTML =
        `<span class="dot" style="background:${rgbToHex(col)}"></span>
         <span class="tier">${TIER_BADGE[tier]}</span>
         <span class="name">${impassLabel(info.name)}${wid}${changed}</span>
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
 */
function specialTileLabel() {
  const pid = state.hover.pid;
  const fine = state.hover.tids[TIER_COUNT - 1];
  const key = fine != null ? String(state.titles.keys[fine] || '') : '';
  const dn = String(state.titles.names[state.hover.tids[editTier()]] || '');
  // CK3 的「不可通行海域」= 键 #impassable_sea ✓ 它是**水**，跟别的海一个待遇 ✓
  const _impSea = isImpassSeaKey(key);
  const _isWater = isWaterKey(key);
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
  if (keyStarts(key, '#impassable') || isWastelandTid(fine)) {
    if (_impSea) return '不可通行海域';                 // CK3 那种：就叫海域 ✓
    return impassLabel(dn.indexOf('海域') >= 0 || key.indexOf('sea') >= 0 ? (dn || '不可通行海域') : '不可通行区域');
  }
  if (key.indexOf('#sea') === 0) return '海洋';
  if (key.indexOf('#lake') === 0) return '湖泊';
  if (key.indexOf('#river') === 0) return '河流';
  return impassLabel(dn);
}

function positionHoverCard(clientX, clientY) {
  const card = $('hover-card');
  if (!state.hover.inside || !state.hover.pid) { card.hidden = true; return; }
  const info = titleInfo(state.hover.tids[editTier()]);
  const rect = $('stage').getBoundingClientRect();
  // 背景地块（海/湖/河/不可通行）也**照显示** ✓ 不再直接隐藏（用户要求：不要区别对待 ✓）
  const _special = !info || isSpecialTid(info.tid);
  const col = _special ? state.titles.colors[state.hover.tids[TIER_COUNT - 1]]
                       : (liveColorOf(state.hover.pid, info.tid) || state.titles.colors[info.tid]);
  const nm = _special ? specialTileLabel()
                      : impassLabel(liveNameOf(state.hover.pid, info.tid) || info.name);
  card.innerHTML =
    `<div class="hc-title"><span class="dot" style="background:${rgbToHex(col || [120, 120, 120])}"></span>${nm}</div>`;
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

/**
 * 一个地块此刻在屏幕上显示的颜色
 *
 * 手绘层优先，其次才是头衔自己的色 —— 取色要取「你眼睛看到的那个」
 * 而不是头衔理论上该有的那个。两者不一致时（比如你在伯爵领视图涂过色，
 * 现在切到帝国视图看），照头衔取就会取错）
 */
function displayedColor(pid, tid) {
  // 跟着色器**同一个优先级**，取"这块地此刻显示的颜色"。
  // 顺序：荒地灰(开关) → 手绘层(开关) → 头衔色/地形 → 背景色。
  const fine = state.meta.tierNames.length - 1;
  const own = pid ? titleAt(pid, fine) : NO_TITLE;

  // 🔴 **顺序必须跟着色器的 colorOfPid 逐条对齐** ✗（用户报：涂了色却取不到 ✓）
  //   着色器是：**手绘层 → 荒地灰 → 无归属 → 头衔色**
  //   ⚠ 这里以前是"荒地灰 → 手绘层" ✗ 反的 ✓
  //     后果：荒地被涂过之后，**画面显示你的涂色**（着色器手绘优先 ✓）
  //           而**吸管吸出来是灰的**（这里先撞上荒地那条 ✓）→ 取色跟画面不一致 ✓
  //   ⚠ 这个坑在着色器那边**修过一次**（注释写着"荒地灰排在手绘前面 → 涂了也是灰"✗）
  //     但那次只改了着色器 ✗ 取色这边漏了 ✓ → 两个函数口径分岔 ✓
  //   💡 **displayedColor 和 colorOfPid 是同一个函数的两份实现** ✗
  //     改任何一边都必须同时看另一边 ✓
  // ① 手绘层：**最优先** ✓ 连荒地那层灰都压得住
  //    （荒地只有开着「荒地可上色」才涂得上去 → "涂过"就等于"允许涂" ✓）
  const pd = renderer && renderer.paintData;
  if (state.showPaint && pd && pid && pd[pid * 4 + 3] > 0) {
    return [pd[pid * 4], pd[pid * 4 + 1], pd[pid * 4 + 2]];
  }
  // ② 「荒漠 · 涂色」关着：荒地一律显示原版灰（连自动色一起藏）
  //    ⚠ 必须放在手绘**后面** ✗（放前面就又把涂色盖掉了 ✓）
  if (isWastelandTid(own) && !state.showWaste) {
    return [94, 94, 94];
  }
  // ③ 没有头衔的地块：固定灰
  if (tid === NO_TITLE || tid == null || !state.titles.colors[tid]) {
    return [150, 150, 150];
  }
  // ④ 头衔色：地形（海/湖/荒地这些，t >= 真实头衔数）**永远看得见**；
  //    真实头衔在「头衔 · 颜色」关着时是透明的 → 露出背景色
  const real = state.meta.numRealTitles || 0;
  if (state.showTitles || tid >= real) {
    // **荒地取 LUT 里那份** ✓ —— "荒漠 · 涂色"开着时画面上就是它：
    //   没自动上色 = 荒地灰、上过 = 那个色。不能取 titles.colors，EU5 那份是
    //   省份位图的技术色（1818 块五颜六色），取到它 = 吸管吸出一个莫名其妙的色 ✗
    if (isWastelandTid(own) && renderer && renderer.lutData) {
      const l = renderer.lutData;
      return [l[own * 4], l[own * 4 + 1], l[own * 4 + 2]];
    }
    const c = state.titles.colors[tid];
    return [c[0], c[1], c[2]];
  }
  const bd = (renderer && renderer.backdrop) || [150 / 255, 150 / 255, 150 / 255];
  return [Math.round(bd[0] * 255), Math.round(bd[1] * 255), Math.round(bd[2] * 255)];
}

/**
 * **分组/身份**用的稳定色：涂过就用涂色，否则用头衔自己的颜色。
 *
 * 为什么不直接用 displayedColor：那个会跟着「头衔·颜色 / 荒漠·涂色」这些**显示开关**变。
 * 一旦用它拼身份串，关掉国家颜色就会让原版国家统统变成背景灰，和玩家涂的同一块地
 * 分成两组 —— 表现就是"同一个国家名冒出两个" ✗（乌兹别克那次就是这么来的）。
 * 吸管、荒地自动涂色那些要"看到什么取什么"的地方仍旧用 displayedColor ✓
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
   */
  setBrushLabel(String(displayedLabel(pid, tid) || '').trim());

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
  // 每块荒地只在最细那层有自己的节点（粗层是共享的灰 + 锁住），
  // 不这么换的话，在伯爵领/省份视图里点沙漠会被 isLocked 挡掉 ✗。
  // 手绘层是按省份记的，所以这一笔在**所有层级**都能看见 ✓。
  {
    const _wl = state.meta.wasteland || [];   // 只为下面那句「数据里有没有荒地」兜底
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
   *   其余工具（涂色/还原/改名）该锁还是锁 ✓ */
  if (state.tool !== 'pick' && isLocked(tid)) return;   // 山/海那些是背景，不给改

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
  recomputePainted();
  updateStatus();       // "改动 N"跟着历史走，不然撤销后还停在旧数
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
  recomputePainted();
  updateStatus();       // 同 undo
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

/** 顶部有几层是年份视图（没有年份视图就返回 0，CK3 就是这种）*/
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
  return state.grain == null ? state.tier : state.grain;
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
  const hl = hoverTargetTid(state.hover.pid, state.hover.tids[e]);
  applyHoverHighlight(state.hover.pid, hl == null ? null : hl);
  updateCursor(hl);
  refreshTierButtons();
  updateBrushTarget();
  renderHoverCard(state.hover.pid);
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
  // **换层 = 换了一批色块** ✓ 分组要重算 ✓
  //（图例列表本身不去当场刷 ✗ —— 按用户的主意：只在"点图例 / 导出"时才更新 ✓）
  blocksDirty = true;
  const hl = hoverTargetTid(state.hover.pid, state.hover.tids[editTier()]);
  // 海 / 山是背景板，不给选中也不高亮 —— 高亮会把**整片海**当成一个头衔点亮
  applyHoverHighlight(state.hover.pid, hl == null ? null : hl);
  labelDirty = true;
  renderHoverCard(state.hover.pid);
  updateBrushTarget();
}

function setTool(id) {
  state.tool = id;
  for (const b of document.querySelectorAll('[data-role="tool"] button')) {
    b.classList.toggle('on', b.dataset.tool === id);
  }
  const t = TOOLS.find((x) => x.id === id);
  updateCursor(state.hover.tids[editTier()]);
  updateBrushTarget();
}

function updateBrushTarget() {
  // 显示的是**有效编辑层**：年份视图里换了粒度就写粒度那一级，
  // 一眼能看出这笔按国家涂还是按省份涂
  const e = editTier();
  const tierName = state.meta.tierNames[e];
  const t = TOOLS.find((x) => x.id === state.tool);
  $('brush-target').textContent = `${tierName} · ${t ? t.label : ''}`;
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
  $('title-group-label').textContent = g.entity;

  // 各模式的默认开关（**CK3 除外**，它保持原样：头衔颜色/边界都开）：
  //   头衔：颜色 ✗ 边界 ✓ 地名 ✓ 势力名 ✓
  //   填色：颜色 ✓ 边界 ✗ 地名 ✗
  if (g.id !== 'ck3') {
    // 约定（非 CK3）：**势力只留上色**；**填色：开边界 + 开地名**（颜色本来就开）✓
    // 注意要改"来源"开关 —— 那几个派生值由 syncLayerSwitches 每帧按来源重算 ✓
    state.showPowerColor = true;       // 势力·上色：默认开 ✓
    state.showRegionName = true;       // 地区·名称：默认**开**（用户要求：默认显示地名 ✓）
    state.showPowerBorder = false;
    state.showPaint = true;
    state.showBorderPaint = true;
    state.showLabelsPaint = true;
    state.showTitles = true;
    state.showBorderTitle = false;
    state.showLabelsTitle = true;       // 地名：**默认开** ✓（用户要求 ✓）
    state._layerSig = null;
    state._parentSig = null;
  }
  // 状态 → 界面上的勾（HTML 里的 checked 只是初值，这里统一过来）
  // 注意：**别把 state 里不存在的字段塞进来** ✗ —— `el.checked = undefined`
  // 等于把勾取消（边界那两个就存在复选框上，所以不在这张表里）。
  const _sw = [
    ['show-titles', state.showTitles],
    ['show-paint', state.showPaint],
    ['show-labels', state.showLabelsTitle],
    ['show-labels-paint', state.showLabelsPaint],
    ['show-power-names', state.showLabelsPaint],   // 势力那组的镜像开关 ✓ 跟上面同一个状态 ✓
    ['show-border-paint', state.showBorderPaint],
    ['show-parent-border', state.showParentBorderTitle],
    ['show-parent-border-ck3', state.showParentBorderTitle],
    ['show-waste', state.showWaste],
    ['show-power-color', state.showPowerColor],
    ['show-power-border', state.showPowerBorder],
    ['show-region-color', state.showRegionColor],
    ['show-region-border', state.showRegionBorder],
    ['show-region-name', state.showRegionName],
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
    // 同一处 bug 的另一个入口：程序化恢复状态（换图/导入）也会走到这里，
    // 无条件推 false 会把荒地涂色藏掉 —— 口径与下面的 change 处理器一致
    renderer.setShowWaste(state.showWaste || state.wasteAuto);
    // 边界的状态存在**复选框**上（state 里没有 showBorderTitle 字段 ✗
    // —— 传 undefined 会被 !! 变成 false，把边界关掉）
    const _bt = $('show-border-title');
    const _bp = $('show-border-paint');
    if (_bt) renderer.setBorderTitle(_bt.checked);

    // **把签名作废一次**：上面这几行是按**藏起来的**旧勾选框推的，
    // 势力/地区那套带签名去重 —— 不这么做，它们后面不会再推，旧值就赖着 ✗
    state._layerSig = null;
    state._parentSig = null;
    if (_bp) renderer.setBorderPaint(_bp.checked);
    renderer.setMix(1.0);
  }
  // 没有荒地数据的模式（比如还没做这块的 CK3）把这两个开关收起来
  {
    const _hasWaste = !!(state.meta && state.meta.wasteland && state.meta.wasteland.length);
    for (const _id of ['waste-label', 'waste-row', 'waste-auto-row', 'waste-clear']) {
      const _row = $(_id);
      if (_row) _row.style.display = _hasWaste ? '' : 'none';
    }
  }
  // 「势力 / 地区」两组只在有年代层（非 CK3）的模式里出现；CK3 仍旧用「头衔」一组
  {
    const _hasEra = !!(state.meta && state.meta.eraDates && state.meta.eraDates.length);
    for (const _id of ['power-group', 'region-group']) {
      const _el2 = $(_id);
      if (_el2) _el2.style.display = _hasEra ? '' : 'none';
    }
    const _tg = $('titles-group');
    if (_tg) _tg.style.display = _hasEra ? 'none' : '';
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
function findTitleByTag(tag) {
  const t = state.titles;
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  if (nEra > 0) {
    const i = t.keys.indexOf(`${state.tier}_${tag}`);
    if (i >= 0) return i;
    for (let k = 0; k < t.keys.length; k++) {
      if (t.tiers[k] < nEra && String(t.keys[k]).endsWith('_' + tag)) return k;
    }
  }
  for (let k2 = 0; k2 < t.keys.length; k2++) {
    if (String(t.keys[k2]) === tag) return k2;
  }
  return -1;
}

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
  const pts = paintedPoints();
  // 两套地名各自独立：原有的（头衔/地区名）和玩家的（手绘色块名），
  // 谁开着画谁，两套都开就合并成一张名单一次画完
  drawLabels(viewRect());

  const glCanvas = $('map');
  const out = document.createElement('canvas');
  out.width = glCanvas.width;
  out.height = glCanvas.height;
  const ctx = out.getContext('2d');
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

  const OW = W * scale;
  const OH = H * scale;
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
 * 两份都按**地图**分（`mapKeyOf`）✓ —— CK3 和 EU4 的省份编号是两套，
 * 混在一起会互相把对方涂花，设置也一样（各图的层数、颜色键根本不同 ✓）
 * ========================================================================== */
const SET_KEY = 'pdx-map-editor/prefs/v1';

/** 读**这张图**存下的设置 + 最近颜色 ✓（没有就返回 null → 用出厂值 ✓） */
function loadMapPrefs(meta) {
  try {
    const box = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {};
    const v = box[mapKeyOf(meta)];
    return (v && typeof v === 'object') ? v : null;
  } catch (e) { return null; }
}

/** 把设置 + 最近颜色按地图存下来 ✓（写不进去就返回 false，别让调用方以为成了 ✓） */
function saveMapPrefs() {
  try {
    const k = mapKeyOf(state.meta);
    if (!k || !state.set) return false;
    const box = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {};
    box[k] = { set: Object.assign({}, state.set),
               // 最近颜色：只留颜色和它当时的标记名 ✓（最多 24 条，跟内存里那个上限一致 ✓）
               recent: (state.recent || []).slice(0, 24) };
    localStorage.setItem(SET_KEY, JSON.stringify(box));
    return true;
  } catch (e) { return false; }
}

// 存档按游戏分开存：ck3-map-editor/v1、eu4-map-editor/v1
// 两边的省份 id 完全是两套编号，混在一起会互相把对方涂花
// （CK3 的键跟老版本一样，所以已有的存档不用迁移。）
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
  const t = state.titles;
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
  LOG.event('导出日志');        // 先记再导：这一条也该出现在文件里 ✓
  const ok = LOG.download(`${(GAME && GAME.filePrefix) || 'pdx'}_日志_${stamp()}.txt`);
  if (!ok) return toast('日志导不出来（日志模块没加载？）', true);
  toast('已导出日志：出问题时把它发给作者就行。');
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
    recomputePainted();      // 手绘层变了：让自动填色跟着重算
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

  recomputePainted();   // 手绘层变了：让自动填色跟着重算
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
    if (panning) { panning = null; updateCursor(state.hover.tids[editTier()]); }
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
  $('show-titles').addEventListener('change', (e) => {
    state.showTitles = e.target.checked;
    renderer.setShowTitles(state.showTitles);
    labelDirty = true;
  });
  $('show-paint').addEventListener('change', (e) => {
    state.showPaint = e.target.checked;
    renderer.setShowPaint(state.showPaint);
    // 关掉手绘层之后，头衔那一层要露出**游戏原色** —— 不然玩家填的色还顶在 LUT 里
    resyncTitleLut();
    labelDirty = true;
  });
  $('show-waste').addEventListener('change', (e) => {
    state.showWaste = e.target.checked;
    // 勾着「允许」（或「自动」还开着）就该显示荒地的涂色 —— 着色器里
    // uShowWaste==0 会把手绘色也一起盖成灰，推 false 的老写法让用户涂了
    // 也看不见（跟 setWasteAuto 里那条推 true 的路自相矛盾，README 也承诺
    // 允许之后"像普通地块一样涂"）。自动开着时取消勾选不藏自动色。
    renderer.setShowWaste(state.showWaste || state.wasteAuto);
    labelDirty = true;
  });
  // 「清除自动填色」：把自动涂的颜色还原（开关开着也没关系，下次触发会重算）
  $('waste-clear').addEventListener('click', () => { wasteClearPlayerPaint(); });
  // 「自动」开关：开着就一直自动涂，关掉全部还原
  // 势力 / 地区 那几个开关：勾了写回状态（下一帧 syncLayerSwitches 会解析生效）
  // **二选一互斥**：边界那条（势力·边界 ↔ 填色·边界）
  // （名字那条已经不需要了：势力名和填色·地名本来就是同一批点，开关删了一个 ✓）
  for (const [a, b] of [['show-power-border', 'show-border-paint']]) {
    const ea = $(a), eb = $(b);
    if (!ea || !eb) continue;
    const tie = (x, y) => x.addEventListener('change', () => { if (x.checked && y.checked) { y.checked = false; y.dispatchEvent(new Event('change')); } });
    tie(ea, eb); tie(eb, ea);
  }

  for (const [id, key] of [['show-power-color', 'showPowerColor'],
                           ['show-power-border', 'showPowerBorder'],
                           ['show-region-color', 'showRegionColor'],
                           ['show-region-border', 'showRegionBorder'],
                           ['show-region-name', 'showRegionName']]) {
    const el = $(id);
    if (el) el.addEventListener('change', (e) => { state[key] = e.target.checked; });
  }

  $('waste-auto').addEventListener('change', (e) => setWasteAuto(e.target.checked));
  // 两条边界**不互斥**：可以只开一条，也可以一起开 ——
  //   一起开时，头衔那边按体系往上数（本层 0.5 / 父级 0.75 / 爷爷及以上 1.0），
  //   填色那边再叠一条实心的自家分界，跟年代模式的「剧本 + 粒度」是一个样子 ✓
  const borderBoxes = [$('show-border-title'), $('show-border-paint')];
  const applyBorders = () => {
    if (borderBoxes[0]) {
      state.showBorderTitle = borderBoxes[0].checked;
      renderer.setBorderTitle(state.showBorderTitle);
    }
    if (borderBoxes[1]) {
      state.showBorderPaint = borderBoxes[1].checked;
      renderer.setBorderPaint(state.showBorderPaint);
    }
    state._parentSig = null;
    syncParentBorder();          // 本层/父级/爷爷的宽度与浓度立刻跟上
    renderer.dirty = true;
  };
  for (const _box of borderBoxes) {
    if (_box) _box.addEventListener('change', applyBorders);
  }
  // 地名两个开关（界面上一左一右：头衔组里的管头衔/地区名，填色组里的管玩家色块名）
  $('show-labels').addEventListener('change', (e) => {
    state.showLabelsTitle = e.target.checked;   // 解析层每帧会按势力/地区重写 ✓
    labelDirty = true;
  });  
  // 「填色 · 边界」：这条边界按**当前显示的颜色**画 ✓（不再专门看涂了哪些 ✓）
  // 「父级边界」：关了就只有本层一条线（多级链不画）✓
  // 两个开关都能改这件事（势力那组 / 地区那组，CK3 那两个）→ 挂同一个处理器 ✓
  // （原来这里还留了一个 `if (false) ...` 的死副本 ✗，挂的是同一件事，
  //   什么时候被谁改坏的已经查不出来了 —— 删掉 ✓）
  for (const _id of ['show-parent-border', 'show-parent-border-ck3']) {
    const _el = $(_id);
    if (_el) _el.addEventListener('change', (e) => {
      state.showParentBorderTitle = e.target.checked;
      state._parentSig = null;
      syncParentBorder();
      renderer.dirty = true;
    });
  }

  $('show-border-paint').addEventListener('change', (e) => {
    state.showBorderPaint = e.target.checked;
    renderer.setBorderPaint(state.showBorderPaint);
    renderer.dirty = true;
  });

  /* 「名称」有两个开关：填色那组的 #show-labels-paint（哪一代都有 ✓）
     和势力那组的 #show-power-names（只有有国家/年代层时才看得见 ✓）
     —— 它们写的是**同一个状态**、互相镜像 ✓ 因为 CK3 没有国家层，
        势力那一整组在 CK3 里是隐藏的，只留那一个的话 CK3 就点不到 ✗ */
  const _setLabelPaint = (on) => {
    blocksDirty = true;      // 玩家名字 = 全图实时重分组 ✓
    state.showLabelsPaint = on;
    labelDirty = true;
    const a = $('show-labels-paint'), b = $('show-power-names');
    if (a && a.checked !== on) a.checked = on;
    if (b && b.checked !== on) b.checked = on;
  };
  if ($('show-labels-paint')) {
    $('show-labels-paint').addEventListener('change', (e) => _setLabelPaint(e.target.checked));
  }
  if ($('show-power-names')) {
    $('show-power-names').addEventListener('change', (e) => _setLabelPaint(e.target.checked));
  }

  // 按钮
  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;
  $('btn-reset').onclick = resetAll;

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
      const _now = (key, tidGuess) => {
        const c = s[key];
        if (c) return rgbToHex(c);
        if (key === 'bg') return rgbToHex([150, 150, 150]);
        if (key === 'waste') return rgbToHex([94, 94, 94]);
        const i = state.titles.keys.indexOf(tidGuess);
        if (i >= 0) { const lc = lutColorOf(i); if (lc) return rgbToHex(lc); }
        return '#808080';
      };
      const put = (id, v) => { const el = $(id); if (el && v != null) el.value = v; };
      put('set-bg', _now('bg'));
      put('set-sea', _now('sea', '#sea'));
      put('set-lake', _now('lake', '#lake'));
      put('set-impass', _now('impass', '#impassable'));
      put('set-impass-sea', _now('impassSea', '#impassable_sea'));
      put('set-river', _now('river', '#river'));
      // 线宽五档 / 浓度四档：**回填时吸附到最近的档位** ✓
      //（老存档里是滑杆时代的连续值，下拉里没有那一项会显示成空白 ✗）
      put('set-w', snapStep(Number(s.w != null ? s.w : (state._borderWidthBase || 1)), W_STEPS));
      put('set-pw', snapStep(Number(s.pw != null ? s.pw : 1), PW_STEPS));
      put('set-pa', snapStep(Number(s.pa != null ? s.pa : 50), CONC_STEPS));
      put('set-ra', snapStep(Number(s.ra != null ? s.ra : 75), CONC_STEPS));
      put('set-ca', snapStep(Number(s.ca != null ? s.ca : 100), CONC_STEPS));
      put('set-font', s.font || 1);
    put('set-labelac', s.labelAC != null ? s.labelAC : SET_DEFAULTS.labelAC);
    put('set-labelap', s.labelAP != null ? s.labelAP : SET_DEFAULTS.labelAP);
      // 背景那两条线：宽度 + 浓度 ✓（老存档没这几项 → 用出厂值 ✓）
      put('set-water-w', snapStep(Number(s.waterW != null ? s.waterW : 1), BG_STEPS));
      put('set-water-a', snapStep(Number(s.waterA != null ? s.waterA : 100), CONC_STEPS));
      put('set-waste-w', snapStep(Number(s.wasteW != null ? s.wasteW : 1), BG_STEPS));
      put('set-waste-a', snapStep(Number(s.wasteA != null ? s.wasteA : 100), CONC_STEPS));
      // 名字上限：range（1~20，**拉满 = 无上限** ✓）+ 旁边那个数值 ✓
      put('set-labelmax', s.labelMax != null ? s.labelMax : SET_DEFAULTS.labelMax);
      const _lmv0 = $('set-labelmax-v');
      if (_lmv0) _lmv0.textContent = labelMaxText();
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
    bindColor('set-sea', 'sea');
    bindColor('set-lake', 'lake');
    bindColor('set-impass', 'impass');
    bindColor('set-impass-sea', 'impassSea');
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
    bindRange('set-w', 'w');
    bindRange('set-pw', 'pw');
    bindRange('set-water-w', 'waterW');
    bindRange('set-waste-w', 'wasteW');
    bindRange('set-pa', 'pa');
    bindRange('set-ra', 'ra');
    bindRange('set-ca', 'ca');
    bindRange('set-water-a', 'waterA');
    bindRange('set-waste-a', 'wasteA');
    bindRange('set-font', 'font');
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
  wasteWatch();
  syncLayerSwitches();
  syncParentBorder();
  // ---- 分块（EU5 原尺寸）：按视野补齐缺的块、离开视野的自然被缓存淘汰 ----
  // 半尺寸那套 state.tileMap 是 null → 这段整个跳过 ✓
  if (state.tileMap && renderer && renderer.provArrTex && renderer.tileInfo) {
    const v = renderer.view;
    if (v && v.w > 0 && v.h > 0) {
      for (const [r, c] of state.tileMap.tilesInView(v)) {
        if (state.tileMap.cache.has(`${r}_${c}`)) continue;
        const layer = r * state.tiles.cols + c;
        state.tileMap.get(r, c).then((tile) => {
          if (tile) renderer.uploadTile(layer, tile);
        }).catch(() => { /* 取块失败就下一帧再试 */ });
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
    const pts = paintedPoints();
    // 两套地名各自独立：原有的（头衔/地区名）和玩家的（手绘色块名），
    // 谁开着画谁，两套都开就合并成一张名单一次画完
    drawLabels(viewRect());
    labelDirty = false;
  }
  // 上面那三条（wasteWatch / syncLayerSwitches / syncParentBorder）
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
  const _t0 = titleAt(pid, editTier());
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
  const _k0 = _t0 == null ? '' : String(state.titles.keys[_t0] || '');
  // 水域（海/湖/河）一律不高亮 —— 不亮整片、也不亮单块 ✓
  // **CK3 的「不可通行海域」也是水** ✓（键是 #impassable_sea 那种 + 开头是 #impassable ✗
  //   只认 #sea 开头的话它就漏进"陆地不通行"→ 会被单块高亮 ✗ 别的海都不亮 = 区别对待 ✓）
  const _isWaterHere = isWaterKey(_k0);
  const _isBg = !_isWaterHere && (_t0 == null || _t0 === NO_TITLE || _t0 >= _real
    || isWastelandTid(_t0));
  if (_isWaterHere) {
    renderer.setHoverState(0, 0, null, 0, null);      // 水：不亮 ✓
    return;
  }
  // **涂过的无主地**（空白剧本那种一层全无主的）也按"一族"亮 ✓ ——
  // 别的背景（海/湖/荒地）照旧只亮光标底下这一块 ✓
  const _noOwnHere = (_t0 == null || _t0 === NO_TITLE);
  const _paintNoOwn = _noOwnHere
    && !!(renderer.paintData && pid && renderer.paintData[pid * 4 + 3] > 0);
  if (_isBg && !_paintNoOwn) {
    renderer.setHoverState(pid || 0, 0, null, 0, null);   // 背景：只亮这一块 ✓
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
    const identOfTid = new Map();
    for (let pid = 1; pid < n; pid++) {
      const tid = titleAt(pid, cTier);
      const p4 = pid * 4;
      const _paintedPid = paint[p4 + 3] > 0;
      // **只收真头衔** —— 海、湖、河、山那些是伪头衔（第勒尼安海之类 ✗），不该当势力名画 ✓
      // **无主地也是**（空白剧本那一层全是无主地 ✓）：它本身没有归属/名字 ✗
      //   —— 但**玩家涂过的无主地**例外 ✓：那块的色块名/图例得照画 ✓（见下面 _paintedPid 那一段 ✓）
      const _noOwn = (tid === NO_TITLE || tid == null || tid >= nReal);
      if (_noOwn && !_paintedPid) continue;
      // **数据里标了 hideLabel 的（荒地那些）不显示名字** ✓（平常那套也是这么筛的 ✓）
      if (!_noOwn && state.titles.hideLabel && state.titles.hideLabel[tid]) continue;
      if (!incUnpainted && !_paintedPid) continue;
      let key = identOfTid.get(tid);
      if (key === undefined) {
        // 没涂过的地只能靠**原版那一层的名字**（它没有标签）✓
        const nm0 = state.titles.names[tid] || '';
        const c0 = state.titles.colors[tid] || [150, 150, 150];
        key = nm0 ? (nm0 + "|" + c0[0] + "," + c0[1] + "," + c0[2]) : null;
        identOfTid.set(tid, key);
      }
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
      if (paint[pid * 4 + 3] > 0) { parent[pid] = pid; painted.push(pid); }
    }
  }
  // 一块都没涂：没有色块可分（**这句必须在"建 isPainted 表"之前** ✓
  // —— 不然 4 万格的空图也要白扫一遍数组）
  if (!painted.length) return;

  // 涂没涂先过一遍（0/1），并查集那一遍要用
  const isPainted = new Uint8Array(n);
  for (let q = 1; q < n; q++) if (paint[q * 4 + 3] > 0) isPainted[q] = 1;

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
    for (let k = offsets[pid], e = offsets[pid + 1]; k < e; k++) {
      const nb = neighbors[k];
      if (nb <= 0) continue;
      if (all) {
        if (ident.get(nb) !== _ownIdent) continue;
        const ra0 = find(pid), rb0 = find(nb);
        if (ra0 !== rb0) parent[ra0] = rb0;
        continue;
      }
      // **同显示色 + 同显示名/标签**才并 ✓
      // 没涂过的地按它的原版色 + 原名算 ✓，而且**没涂过的邻居也要能并进来** ✓
      // （陕北那块没被涂过 ✗，只按涂色层判就永远并不到这一族里 ✗）
      if (identOfPid(nb) !== _ownPidIdent) continue;
      const ra = find(pid), rb = find(nb);
      if (ra !== rb) parent[ra] = rb;
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
    // 水面的共享节点（湖泊/海洋/河流）、**荒地**、不可通行 —— 都是**伪头衔**，不当国家名画 ✗
    if (name === '湖泊' || name === '海洋' || name === '河流' || name === '不可通行') name = '';
    // 荒地也会被当成"一族"✗（它的显示名就是荒地名 ✓）→ 在这儿一并滤掉 ✓
    {
      const _p0w = g.pids[0];
      const _tW = titleAt(_p0w, (typeof editTier === 'function') ? editTier() : cTier);
      const _kW = (_tW != null && _tW !== NO_TITLE) ? String(state.titles.keys[_tW] || '') : '';
      if (isWastelandTid(_tW) || isWaterKey(_kW)
          || keyStarts(_kW, '#impassable') || keyStarts(_kW, 'wl_')) name = '';
    }
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

  // ① 地名（先入列 = 在下面）：勾了「地名」就画**当前选中的那一层**。
  if (state.showLabelsTitle) {
    /* **选哪层就画哪层** ✓（用户定的：粒度设成地区 / 州 / 战略区时，地名也得跟着出来 ✓）
     *
     * 以前剧本视图下**只放行"最细的两层"**（省份 + 它更细的那层 ✗），别的层一律 -1 ✗ ——
     * 于是把粒度选成"地区"，地图上**一个地名都没有** ✓（用户报的 ✓）
     * 当年的顾虑是"一开门一堆名、把势力名压住"✗ 但那该交给**用户自己**：
     * 嫌挤就关掉「地名」那个开关 ✓ 替用户做主反而不对 ✓
     *
     * ⚠ 但**剧本层本身不算地名** ✗ —— 那一层是国家 / 势力，归下头那一套管
     *   （`paintedPoints` / 势力名 ✓）。所以只放行 `>= nEra` 的**地理层** ✓
     */
    const _et = editTier();
    const nameTier = isCountryView ? _et : viewTier;
    if (nameTier >= nEra) {
      for (const q of _cull(labels.pointsFor(nameTier))) list.push(q);
    }
  }
  // ③ 玩家涂出来的色块名：最上层（半透明）
  if (state.showLabelsPaint) {
    for (const p of (paintedPoints(true) || [])) list.push({ ...p, tier: 0, fade: true, layer: 2 });
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

/** 哪些地图真的能用 —— 单文件版看内嵌清单，走服务时探一下各自的 meta.json */
async function availableMaps() {
  const out = [];
  if (isEmbedded()) {
    const keys = embeddedMapKeys();
    for (const m of MAP_CHOICES) if (keys.includes(m.emb)) out.push(m);
    return out;
  }
  for (const m of MAP_CHOICES) {
    try {
      const res = await fetch(`${m.dir}/meta.json`, { method: 'HEAD' });
      if (res.ok) out.push(m);
    } catch (e) { /* 没有这套就跳'*/ }
  }
  return out;
}

/** 让玩家挑一张。只有一套的话直接用，不弹界面 */
function pickMap(maps) {
  return new Promise((resolve) => {
    if (maps.length <= 1) return resolve(maps[0]);

    const box = $('map-pick');
    const list = $('map-pick-list');
    list.innerHTML = '';
    for (const m of maps) {
      const b = document.createElement('button');
      b.className = 'map-card';
      b.innerHTML = `<b>${m.label}</b><span>${m.note}</span>`;
      b.onclick = () => { box.hidden = true; resolve(m); };
      list.appendChild(b);
    }
    box.hidden = false;
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
      btn.textContent = '导出日志（发给作者）';
      btn.style.cssText = 'padding:5px 14px;cursor:pointer;'
        + 'background:#fff;color:#7a0a0a;border:0;border-radius:4px;font:inherit';
      btn.onclick = (ev) => { ev.stopPropagation(); exportLog(); };
      bar.appendChild(btn);
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
 * 🔴 **启动里程表**（只在手机上显示）—— 用户报"手机版黑屏、也没有报错条" ✓
 *
 * 为什么需要它 ✗：黑屏如果**没有异常** ✓ 那错误捕获就一点用没有 ✓
 *   （着色器编译失败会抛 ✓ 但"画出来是黑的"不会抛 ✓）
 *   → 那就需要一条**不用等出错、一直在那儿**的文字 ✓
 *   它一路打勾：停在哪儿，就知道是哪一步 ✓✓
 *
 * ⚠ 只在**手机**上显示 ✗ 桌面版页面干干净净 ✓
 * ⚠ 用最原始的东西（inline style + <div>）✗ 不依赖任何样式表 ✓
 */
function bootMark(txt) {
  try {
    if (!(typeof window !== 'undefined' && window.innerWidth && window.innerWidth <= 900)) return;
    let d = document.getElementById('pdx-boot');
    if (!d) {
      d = document.createElement('div');
      d.id = 'pdx-boot';
      d.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:2147483646;'
        + 'background:rgba(0,0,0,.82);color:#7fff7f;font:11px/1.45 monospace;'
        + 'padding:3px 6px;white-space:pre-wrap;word-break:break-all;pointer-events:none';
      (document.body || document.documentElement).appendChild(d);
      d.textContent = '';
    }
    d.textContent += (d.textContent ? ' → ' : '') + txt;
  } catch (e) { /* ✓ */ }
}

function rawErr(msg) {
  try {
    const host = document.body || document.documentElement;
    if (!host) return;
    let box = document.getElementById('pdx-raw-err');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'pdx-raw-err';
      box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;'
        + 'max-height:60%;overflow:auto;margin:0;padding:8px;'
        + 'background:#b00;color:#fff;font:12px/1.5 monospace;white-space:pre-wrap';
      host.insertBefore(box, host.firstChild);
    }
    box.textContent += msg + '\n';
  } catch (e) { /* 连这个都失败就真没辙了 ✓ */ }
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

async function boot() {
  try {
    LOG.event('启动');
    setBoot('看看有哪些地图', 3);
    const maps = await availableMaps();
    if (!maps.length) throw new Error('没有可用的地图数据，先跑一次 python build_data.py');

    const chosen = await pickMap(maps);
    LOG.event('选图', String(chosen.label || '') + (isEmbedded() ? '（单文件内嵌）' : '（' + chosen.dir + '）'));
    if (isEmbedded()) setEmbeddedMap(chosen.emb);
    else setDataDir(chosen.dir);

    setBoot(`读取「${chosen.label}」的元数据…`, 6);
    const meta = await api.meta();
    if (!meta || !meta.numTitles) throw new Error('data/ 里还没生成好缓存，先跑 python build_data.py');
    state.meta = meta;
    /* **设置 + 最近颜色按地图接回来** ✓（用户要求：刷新 / 回主菜单都不丢 ✓ 每张图各存各的 ✓）
     * 这份跟"涂色暂存"是分开的两份 —— 那份回主菜单才存、F5 就清 ✓（见 saveProject 上面的说明 ✓）
     * 接回来之后 `applySettings()` 会把它推给渲染器（renderer 建好之后调一次 ✓ 见下面）*/
    {
      const prefs = loadMapPrefs(meta);
      state.set = Object.assign({}, SET_DEFAULTS, (prefs && prefs.set) || {});
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
    // **名录快查表**：荒地 / 无男爵领 / 巨型荒地 —— 悬停、涂色、每帧都要问
    // "这个号在不在名单里"，原来是拿 indexOf 线性扫的 ✓（见上面快查表那一段）
    buildMetaIndex();

    // 荒地的地名**一律不显示** —— 它们要么是临时名（wl_1234）、要么是"约顿海姆"
    // 这种真名，摆在图上都是噪音。借 LabelLayer 现成的 hideLabel 通道
    // （那份数据里没有这个数组的就现建一个）。
    {
      const _wl = state.meta.wasteland || [];
      if (_wl.length) {
        const need = titles.keys.length;
        if (!titles.hideLabel || titles.hideLabel.length < need) {
          const arr = new Array(need).fill(false);
          if (titles.hideLabel) {
            for (let i = 0; i < titles.hideLabel.length && i < need; i++) {
              arr[i] = !!titles.hideLabel[i];
            }
          }
          titles.hideLabel = arr;
        }
        for (const _t of _wl) {
          if (_t >= 0 && _t < titles.hideLabel.length) titles.hideLabel[_t] = true;
        }
      }
    }
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
      renderer = new MapRenderer($('map'), meta);
      bootMark('②着色器OK');
    } catch (err) {
      /* ⚠ 编译失败必须上屏 ✗ 手机上没有控制台可看 ✓ */
      bootMark('②着色器失败: ' + (err && err.message ? err.message : err));
      rawErr('✗ 着色器编译失败：' + (err && err.message ? err.message : err));
      throw err;
    }
    _tick('编译着色器 + 建渲染器');
    renderer.onContextLost = () => {
      // 这一条要进日志：白屏的最常见原因之一，而玩家只会说"它黑了" ✓
      LOG.event('WebGL 上下文丢失', '显卡驱动 / 显存');
      toast('显卡把 WebGL 上下文弄丢了，地图画不下去了 —— 请刷新页面重试。', true);
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
    await renderer.setData({
      provinceIds: state.provinceIds,
      titlemap: state.titlemap,
      colors: titles.colors,
      // 分块清单**必须传进去** ✗ —— 少了这一行，渲染器会按"整图模式"建
      // 16384×8192 的纹理，却只拿到 1 个元素的占位数组 → WebGL 报
      // "ArrayBufferView not big enough"、纹理不完整 → 画面全白。
      tiles: state.tiles || null,
    });
    bootMark('④数据OK');
    _tick('上传地图纹理');
    // 荒地标记（LUT 的 alpha 通道）+ 自动上色（写手绘层）。
    // 两个都在 setData 之后做：LUT 和手绘层都是那时才建好的。
    renderer.setWasteland(meta.wasteland || []);
    // **每块荒地的 LUT 起手 = 荒地灰** ✓（那才是它"没上色"的样子）
    // 这段原来写在文件末尾、`boot()` **之后** —— 而 boot 是 async，跑到那儿
    // state.meta 还是 null，于是这段**一次都没执行过**：EU5 的荒地就一直顶着
    // 数据里给省份位图用的技术色，一开「荒漠 · 涂色 / 自动」就是一片怪色 ✗
    paintWasteGrey();
    _tick('荒地起手灰');
    syncParentBorder();
    /* **把接回来的设置推给渲染器** ✓（只在面板里改过才 applySettings 是不够的 ✗
     *   刷新/回主菜单后那份设置得在**开图时**就生效 ✓）*/
    applySettings();
    syncAllPaintLabels();
    _tick('设置 + 标签同步');
    // **地名门槛按这张图自己的地块大小现算** ✓（不再吃 meta 里写死那套 ——
    //  那套是照某一张图调的，换个尺寸/换个游戏就对不上：地块小的图地名会提早糊出来）
    meta.labelZoom = computeLabelZoom(meta, titles);
    labels = new LabelLayer($('overlay'), titles, meta);
    /* ⚠ **开场就得把存过的不透明度喂进去** ✗ —— applySettings 跑在这句**之前** ✓
     *   那时候 labels 还没建、会跳过 ✓ 于是"存过的偏好"要等用户动一下滑块才生效 ✓ */
    labels.alphaCountry = (state.set.labelAC != null ? Number(state.set.labelAC) : 50) / 100;
    labels.alphaPlace = (state.set.labelAP != null ? Number(state.set.labelAP) : 50) / 100;
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
    setBoot('出错了：' + e.message, 100);
    $('boot-step').style.color = 'var(--danger)';
  }
}

boot();

// 新手引导：就绪后挂上顶栏那个「教程」按钮 ✓（本文件是独立小模块，不碰主逻辑）
if (typeof window.initTutorial === 'function') window.initTutorial();
