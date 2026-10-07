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
  { key: 'eu5full', emb: 'eu5full', dir: '/data_eu5_full', game: 'eu5', label: 'EU5 原尺寸', note: '16384 × 8192（分块）' },
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

const TOOLS = [
  { id: 'view', label: '查看', key: 'Q', tip: '' },
  { id: 'pick', label: '吸管', key: 'W', tip: '' },
  { id: 'paint', label: '涂色', key: 'E', tip: '' },
  { id: 'erase', label: '还原', key: 'R', tip: '' },
  { id: 'capital', label: '定都', key: 'T', tip: '' },
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
    w: null, pa: 50, ra: 75, ca: 100, pw: 1, font: 1,
    // 导出图例（用户要的：相关设置都放在「设置」这一页 ✓）
    legend: false, legendTitle: '', legendPos: 'tl',
  },
  capitalPids: [],              // 玩家定过的首都（地块号；跟着导出涂色走 ✓）
  capitalOf: {},                // 那一族 → 首都地块号（名字落点按它走）   // 地名/头衔那侧的**父级边界**（多级链）开关 ✓
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
  painted: new Set(),          // 玩家涂过的头衔（'颜色变没'无关'
  paintColor: new Map(),       // 手绘层每个头衔用的颜色（涂色只写这儿，不改头衔色'
  brushLabel: '请输入文本',      // 当前画笔的标记：默认就写这五个字 ✓（用户要求 ✓）
  titleLabel: new Map(),       // 头衔 '涂它时用的标'
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

/**
 * 定都：把光标底下**最低层级单位**（就是 provinceAt 解出来的那块地 ✓）设成首都 ✓
 *
 *   · **只在剧本视图（年份层）下生效**；不在那一层就静默返回，不给任何提示 ✓
 *   · 判定只看**归属**（那一年的国家 ✓），跟涂色、颜色开关都无关 ✓
 *   · CK3 没有年份层 → 只给**玩家涂色**出来的实体定都，头衔不参与 ✓
 *   · 首都记在 state.capitalPids 里，「导出涂色 / 导入涂色」会带上它们 ✓
 */
function setCapitalAt(pid) {
  if (!pid) return;
  const n = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  // 记号：`国家key` 形式不统一，干脆**只记地点号**，用的时候再看它当年属于谁 ✓
  if (pid < 0) return;
  if (n && state.tier < n) {
    // 剧本视图：这块地当年有主才给定都 ✓（无主 / 伪头衔一律不动 ✓）
    const tid = titleAt(pid, state.tier);
    if (tid == null || tid === NO_TITLE || tid >= state.meta.numRealTitles) return;
  } else if (GAME.id !== 'ck3') {
    return;                     // 非剧本视图：静默 ✓
  } else if (!paintTouched(pid)) {
    return;                     // CK3：只有玩家涂过的地方才谈得上"给他的实体定都" ✓
  }
  if (state.capitalPids.indexOf(pid) < 0) state.capitalPids.push(pid);
  // 记到具体的"那一族"上（颜色块 + 剧本里的国家 key），名字落点才找得到它
  state.capitalOf = state.capitalOf || {};
  if (n && state.tier < n) {
    const tid2 = titleAt(pid, state.tier);
    if (tid2 != null && tid2 !== NO_TITLE && state.titles.keys[tid2]) {
      state.capitalOf[state.titles.keys[tid2]] = pid;
      // 全图重分组那套身份是 `名字|r,g,b`，这儿再记一份，那边才读得到
      const nm2 = displayedLabel(pid, tid2);
      const col2 = stableColor(pid, tid2);
      if (nm2 && col2) state.capitalOf[nm2 + "|" + col2[0] + "," + col2[1] + "," + col2[2]] = pid;
    }
  } else {
    const paint2 = renderer && renderer.paintData;
    if (paint2 && paint2[pid * 4 + 3] > 0) {
      const lab = state.provLabel ? (state.provLabel[pid] | 0) : -1;
      // 定都的键必须跟**族身份**一致 ✓：同显示色 + 同显示名
      // （以前写的是 C|r,g,b|L<标签号> ✗ → 跟族的新身份对不上 ✗ → 点了也不生效 ✗）
      const _ct0 = countryTier();      // 该剧本 = 最近的**有主**剧本层 ✓（空白剧本不算 ✓）
      const _tidC = titleAt(pid, _ct0);
      const _nmC = lab >= 0
        ? String(state.labelNames[lab] || '')
        : String((_tidC != null && _tidC !== NO_TITLE ? state.titles.names[_tidC] : '') || '');
      state.capitalOf["D|" + paint2[pid * 4] + "," + paint2[pid * 4 + 1]
        + "," + paint2[pid * 4 + 2] + "|" + _nmC] = pid;
      // 旧格式也留一份（老存档里可能有 ✓，多写一行不碍事 ✓）
      state.capitalOf["C|" + paint2[pid * 4] + "," + paint2[pid * 4 + 1]
        + "," + paint2[pid * 4 + 2] + "|L" + lab] = pid;
      state.capitalOf["L" + lab + "|name"] = pid;
    }
  }
  blocksDirty = true;
  labelDirty = true;
  renderer.dirty = true;
}

/** 这块地玩家涂过没有（定都时用来判断 CK3 的"涂色实体" ✓） */
function paintTouched(pid) {
  const paint = renderer && renderer.paintData;
  return !!(paint && paint[pid * 4 + 3] > 0);
}

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

function setBrush(rgb, remember = true) {
  state.brush = [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0];
  $('brush-swatch').style.background = rgbToHex(state.brush);
  $('brush-hex').value = rgbToHex(state.brush);
  $('brush-r').value = state.brush[0];
  $('brush-g').value = state.brush[1];
  $('brush-b').value = state.brush[2];
  if (remember) pushRecent(state.brush);
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
    const o = state.original[i];
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

function pushRecent(rgb) {
  const key = rgb.join(',');
  const entry = { rgb: rgb.slice(), label: state.brushLabel };
  state.recent = state.recent.filter((c) => c.rgb.join(',') !== key);
  state.recent.unshift(entry);
  if (state.recent.length > 24) state.recent.length = 24;
  renderPalette();
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
    chip.onclick = () => { setBrush(e.rgb, false); setBrushLabel(e.label); };
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
  return state.original[tid] || state.titles.colors[tid];
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
  w: null, pa: 50, ra: 75, ca: 100, pw: 1, font: 1,
};

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

/** 拍一张快照：这些 pid 现在是什么状态 */
function snapshotPids(tid) {
  return snapshotPidsList(pidsOf(tid));
}

/**
 * 同上，但直接给一串 pid ✓
 *
 * 「填色·边界」下按**色块**擦除时走这条：那一笔不是按头衔清的
 * （同一个头衔里别的颜色的地不归它管 ✗），所以快照也得按地块拍 ✓
 */
function snapshotPidsList(pids) {
  const snap = [];
  for (const pid of pids) {
    const cur = state.provTitle ? state.provTitle[pid] : -1;
    snap.push({
      pid,
      rgb: cur >= 0 ? (state.paintColor.get(cur) || null) : null,
      tid: cur >= 0 ? cur : -1,
      label: state.provLabel ? (state.provLabel[pid] || 0) : 0,
    });
  }
  return snap;
}

/** 把快照和"现在"比一比，只把**真的变了**的收成一步历史 */
function pushPatches(snap) {
  const patches = [];
  for (const before of snap) {
    const cur = state.provTitle ? state.provTitle[before.pid] : -1;
    const after = {
      pid: before.pid,
      rgb: cur >= 0 ? (state.paintColor.get(cur) || null) : null,
      tid: cur >= 0 ? cur : -1,
      label: state.provLabel ? (state.provLabel[before.pid] || 0) : 0,
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
  state.painted.clear();
  state.changed.clear();
  const n = state.meta ? state.meta.numProvinces : 0;
  for (let pid = 1; pid < n; pid++) {
    const tid = state.provTitle[pid];
    if (tid >= 0) { state.painted.add(tid); state.changed.add(tid); }
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
    /* **只有这三个全关才藏** ✓（用户指着截图定的 ✓）
     *   · 势力 · 边界（showPowerBorder）
     *   · 地区 · 边界（showRegionBorder）
     *   · 填色 · 边界（showBorderPaint）
     * 注意不是 showBorderTitle ✗ —— 那个是"**按当前模式**挑出来的那一个" ✓
     * 只算它的话就漏了另一个 ✓（我第一版就是这么写的 ✗ 只看了两个 ✓）
     * 父级边界不算在里头 ✓（它是地区那一组的子选项 ✓）
     */
    const _anyBorderOn = !!(state.showPowerBorder || state.showRegionBorder || state.showBorderPaint);
    if (renderer.showWater !== _anyBorderOn) { renderer.showWater = _anyBorderOn; renderer.dirty = true; }
    /* 粗细：**固定 1 格 × 「基准线宽」** ✓（用户定的 ✓）
     *   · **固定**：不跟链、也不跟本层那条线走 ✓
     *     （以前取"链上最后一级（势力那一圈）"，链空时退回本层宽 ✗ →
     *      开不开剧本 / 有没有粒度，水域线在 1.5 和 1.0 之间跳 ✗）
     *   · **但要受基准线宽影响** ✓：整套粗细阶梯都按「基准线宽 / 1.6」缩放，
     *     所以这里写 1 × 缩放，而不是钉死 1 个设备像素 ✓
     *   · **荒地那条不归这儿管** ✓ —— 它宽浓都吃"填色边界"那一套
     *     （uPaintBorderW / uPaintBorderA = 「势力线宽」+「势力边界浓度」✓ 用户定的 ✓）
     *   浓度那边不用管：着色器里写死实心（就水域那条 ✓）*/
    const _wScaleB = ((state.set && state.set.w) ? state.set.w : 1.6) / 1.6;
    if (Math.abs(renderer.waterW - _wScaleB) > 0.001) { renderer.waterW = _wScaleB; renderer.dirty = true; }
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
  if (state._borderWidthBase == null) state._borderWidthBase = renderer.borderWidth || 1.6;
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
   *   整体乘「基准线宽 / 1.6」：默认正好 1 / 1.25 / 1.5；拉基准线宽则整条等比缩放。
   *   填色线与多级链再乘「势力线宽」pw。 */
  const _wScale = ((state.set && state.set.w) ? state.set.w : 1.6) / 1.6;
  const W_THIN = 1.0 * _wScale;    // 本层
  const W_PARENT = 1.25 * _wScale; // 父层
  const W_TOP = 1.5 * _wScale;     // 填色线 / 多级链
  const _pwMul = state.set && state.set.pw ? state.set.pw : 1;   // 势力线宽倍率
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
                width: W_TOP * _pwMul, show: showOf(state.tier) });
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
  const _wBase = _isPowerBase ? (W_TOP * _pwMul) : W_THIN;
  if (Math.abs(renderer.borderWidth - _wBase) > 0.01) {
    renderer.borderWidth = _wBase;
    renderer.dirty = true;
  }

  // **填色边界**：它就是链上的**爷爷那一级** —— 粗细按"爷爷档"（基准×0.75 再加 0.5）+ 实心 ✓
  // 注意不能只取"链上最粗那条"：CK3 的链只有父级一级，那样拿到的是**父级档** ✗
  // 所以以"爷爷档"为下限 —— 链本身更粗就跟着链（年代模式不变），CK3 则从父级提到爷爷 ✓
  const _pw = W_TOP * _pwMul;   // 填色线：跟多级链同一档 1.5（再乘势力线宽）
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
  for (let pid = 1; pid < n; pid++) {
    if (!(state.provTitle && state.provTitle[pid] >= 0)) continue;   // 不是玩家涂的
    const tid = titleAt(pid, fine);
    if (tid === NO_TITLE || tid == null) continue;
    if (!isWastelandTid(tid)) continue;                              // 不是荒地
    if (seen.indexOf(tid) >= 0) continue;
    seen.push(tid);
    restoreTitle(tid);
  }
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
  const out = [];
  const want = [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0].join(',');
  for (const t0 of state.painted) {
    const c0 = state.paintColor.get(t0);
    if (!c0) continue;
    if (c0[0] + ',' + c0[1] + ',' + c0[2] !== want) continue;
    const l0 = state.titleLabel.get(t0) || state.titles.names[t0] || '';
    if (String(l0) !== String(label || '')) continue;
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
 * 同一层头衔**内部**、跟 pid 同一块色的那些地块 ✓（点在**没涂过**的地上时用）
 *
 * 跟 playerGroupPidsAt 的差别只有**范围**：
 *   · 那个是全图扫"同色同标签"（玩家一笔涂出来的那几个国家算一族 ✓）
 *   · 这个是"本层头衔那几块地里，颜色与标记都一样的那部分"
 *
 * 为什么要分开：剧本视图 + 「填色·边界」下点一块**原版色**的地，能动的只有
 * "跟它看起来一样的那一块色" ✗ 不能沿用手绘层那套全图扫 ——
 * 荒地、海那种"全图共用一个伪头衔"的会被一并卷进来 ✗
 * （悬停那套 hoverGroupRgb 就是为这个把伪头衔/荒地挡在外面的 ✓ 这里同理 ✓）
 */
function sameBlockPids(tid, pid) {
  const et = editTier();
  const want = paintIdentAt(pid, et);
  if (!want) return [];
  const out = [];
  for (const q of pidsOf(tid)) if (paintIdentAt(q, et) === want) out.push(q);
  return out;
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
  // ① 先看这块地**当前的色**是哪一笔涂色给的 —— 那一笔的标签才是它该显示的名字 ✓
  //    （只看本头衔的 titleLabel 会错：细层涂的那一笔记在别的 tid 上 ✗）
  const pd = renderer && renderer.paintData;
  if (pd && pid && pd[pid * 4 + 3] > 0) {
    const cr = pd[pid * 4], cg = pd[pid * 4 + 1], cb = pd[pid * 4 + 2];
    const nT = state.meta.tierNames ? state.meta.tierNames.length : 0;
    for (let ti = 0; ti < nT; ti++) {
      const t0 = titleAt(pid, ti);
      if (t0 == null || t0 === NO_TITLE) continue;
      const pc = state.paintColor && state.paintColor.get ? state.paintColor.get(t0) : null;
      if (!pc) continue;
      if (Math.abs(pc[0] - cr) + Math.abs(pc[1] - cg) + Math.abs(pc[2] - cb) !== 0) continue;
      const lb = state.titleLabel && state.titleLabel.get ? state.titleLabel.get(t0) : null;
      if (lb) return String(lb);
    }
  }
  const byTitle = state.titleLabel && state.titleLabel.get ? state.titleLabel.get(tid) : null;
  if (byTitle) return String(byTitle);
  const lq = state.provLabel ? (state.provLabel[pid] | 0) : -1;
  if (lq >= 0) {
    const nm = String(state.labelNames[lq] || "");
    if (nm) return nm;
  }
  return null;
}

function paintAt(pid, tid) {
    // 没头衔 / 越界：不涂（界面上走不到这儿 —— actAt 会把无主地换到最细那层 ✓，
    // 但外部直接调它（脚本 / 测试）时别崩 ✗）
    if (tid == null || tid === NO_TITLE || tid < 0 || tid >= (state.titles.keys || []).length) return;
    const from = (state.paintColor.get(tid) || lutColorOf(tid) || [0, 0, 0]).slice();
    const to = state.brush.slice();
    // 颜色没变也别急着返回 —— 涂过就得记进手绘层
    // 否则「吸自己的色再涂回原处」这种操作，关掉头衔色之后会什么都不剩
    //
    // **标记变了就必须继续**：同色换个标记再涂一遍是很正常的操作
    // 早先这里只看颜色，于是「同色不同标记」点了没反应，标记永远改不掉
    const wantLabel = state.brushLabel || state.titles.names[tid];
    if (sameColor(from, to) && state.painted.has(tid)
        && state.titleLabel.get(tid) === wantLabel) return;
    // 荒地：只有「荒漠 · 涂色」开着时才给涂。
    // 关着 = 不对荒地做任何填色（这是用户要的语义：那个开关是荒地填色的总闸）
    if (isWastelandTid(tid) && !state.showWaste) {
      return;   // 静静地不涂就行，别弹东西打扰
    }
    // **开着「填色·边界」→ 以玩家为准**：
    // 一笔涂的是**色块**（同色同标记的一片地），不是"整个头衔" ——
    //   · 点中的地**涂过** → 全图同色同标签的那些一起涂 ✓
    //     （玩家一次用新颜色涂的那几块，就算一个国家 ✓）
    //   · 点中的地**没涂过** → 只在本层头衔里找跟它同色同标记的 ✓
    {
      const _pd = renderer && renderer.paintData;
      const _nEra1 = (state.meta.eraDates && state.meta.eraDates.length) || 0;
      const _eraOnly = _nEra1 > 0 && state.grain == null && editTier() < _nEra1;
      if (_eraOnly && state.showBorderPaint && _pd) {
        // 规则：一次性涂「鼠标所指地块的**同色同标签的所有色块**」✓
        // 色块 = 地块；每块涂它自己最细那一层，保证只覆盖这一块 ✓
        //
        // ⚠ 点**没涂过**的地时，绝不能再退回 `paintTitle(tid)` 按头衔整国铺一遍 ✗ ——
        //   同一个头衔里玩家涂过别的颜色的那些地（1936 剧本里被德国占掉的半壁法国
        //   就是这种）属于**别的色块**，一块都不许碰 ✓
        //   （那个退路只在**涂过**的地上留着：认不出族时至少把点中这块涂掉 ✓；
        //     没涂过的地认不出身份就直接按下面的老路走，不在这里多涂 ✗）
        const _onPainted = _pd[pid * 4 + 3] > 0;
        const _pids = _onPainted ? playerGroupPidsAt(pid) : sameBlockPids(tid, pid);
        if (_pids.length) {
          const _fine = TIER_COUNT - 1;
          // 一次点击 = **一步**历史（跟擦除那边一个规矩）：先把整族要动的
          // 地块拍快照，再逐个涂（各自不记账），最后合成一条 patch ——
          // 不然撤销要按 N 次 Ctrl+Z，中途还露半涂状态。
          const _targets = [];
          for (const _q of _pids) {
            const _t = titleAt(_q, _fine);
            if (_t != null && _t !== NO_TITLE && _targets.indexOf(_t) < 0) _targets.push(_t);
          }
          const _snaps = [];
          for (const _t of _targets) _snaps.push(...snapshotPids(_t));
          for (const _t of _targets) paintTitle(_t, to, true);
          pushPatches(_snaps);
          return;
        }
        // 认不出族（没有同色同标签的）→ **涂过**的地退回只涂点中这块 ✓
        if (_onPainted) {
          const _fineT = titleAt(pid, TIER_COUNT - 1);
          if (_fineT != null && _fineT !== NO_TITLE) {
            paintTitle(_fineT, to);
            return;
          }
        }
      }
    }
    paintTitle(tid, to);
}

function paintTitle(tid, rgb, noHistory) {
  // 头衔重刷会影响显示颜色 → 荒地那套**全量重算** ✓
  state._wasteDirty = null;
  const c = [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0];
  // **只写手绘层，不动头衔本身的颜色** —— 涂色是新建一层「玩家填色」
  // 不是把游戏原有的配色改掉。所以关掉「填色·颜色」之后，底色还是游戏原色
  // 锁住的（海/湖/荒地这类伪头衔）涂不上色 —— syncPaint 会直接返回 0。
  // 那就**不该**把它记进 painted ✗（以前会，于是"涂了海"这种空操作也会留下记录、
  // 还会污染"哪些算涂过"的判断）。
  const _n = pidsOf(tid).length;
  if (!_n) return;
  const _snap = snapshotPids(tid);
  state.paintColor.set(tid, c);
  syncPaint(tid, c, false);
  state.painted.add(tid);
  if (!noHistory) pushPatches(_snap);   // noHistory：调用方（整族涂）自己合成一条
  state.changed.add(tid);
  updateStatus();
  blocksDirty = true;
  scheduleSave();

  markPaint();
}

/** 还原：改回原始色，并擦掉手绘 */
function restoreTitle(tid, noHistory) {
  // 头衔重刷会影响显示颜色 → 荒地那套**全量重算** ✓
  state._wasteDirty = null;
  const _snap = snapshotPids(tid);
  syncPaint(tid, state.original[tid] || [0, 0, 0], true);
  state.paintColor.delete(tid);
  state.painted.delete(tid);
  if (!noHistory) pushPatches(_snap);
  state.changed.delete(tid);
  updateStatus();
  blocksDirty = true;
  scheduleSave();

  markPaint();
}

/**
 * 只清**这几个地块**的笔迹（不进历史 —— 调用方自己拍快照、自己合成一条 patch ✓）
 *
 * 跟 restoreTitle 的区别只在范围：那个按**头衔**清（这个头衔的地块全算），
 * 这个按**地块**清。「填色·边界」下擦一个色块必须用这个 ——
 * 同一个头衔里被涂成别的颜色的地（1936 剧本里德国占的那半壁法国）不归这一笔管 ✗
 */
function clearPidsPaint(pids) {
  // 头衔重刷会影响显示颜色 → 荒地那套**全量重算** ✓
  state._wasteDirty = null;
  for (const pid of pids) {
    renderer.setPaint(pid, 0, 0, 0, 0);
    renderer.setPaintLabel(pid, 0);
    if (state.provTitle) state.provTitle[pid] = -1;
    if (state.provLabel) state.provLabel[pid] = -1;
  }
  updateStatus();
  blocksDirty = true;
  scheduleSave();

  markPaint();
}

/**
 * 把手绘层按省份刷一遍
 *
 * 手绘层是按**省份**记的，所以在伯爵领视图涂的，切到公爵领、王国视图
 * 依然在。clear=true 表示擦掉
 */
function syncPaint(tid, rgb, clear) {
  const tier = state.titles.tiers[tid];
  if (tier >= TIER_COUNT) return 0;   // ''荒地这类伪头衔不参与
  const n = state.meta.numProvinces;
  const row = tier * n;
  const tm = state.titlemap;
  // 这一笔的标记编号（整块地共用一个，不必每格重算）
  // 手绘描边要靠它区分"同色但不同标记"的两块，所以得写进那张标记纹理
  /* **一律取"这一笔用的名字"的编号** ✓ —— 不要再有 `-1` 那个特例 ✗
   *
   * 以前写的是：`_brushNm === _ownNm ? -1 : labelIdOf(_brushNm)`
   * 想法是"用的是自己的名 → 等于没换标记"✓ 可 `-1` 存进去变成 **0** ✗
   * 而着色器眼里 **0 就是一个普通的标记编号**（不是"没标记"）✗
   * → 于是：选一个头衔涂色（名字正好等于它自己的名 ✓）拿到 0 ✓
   *         周围同一颜色涂的格子拿到别的编号 ✓
   *         颜色一样、标记不同 → paintDiffers 判成两片 → **在它的边界上画一条粗线** ✗
   *   用户报的「这个头衔本身会和你涂的那一大堆划边界」就是它 ✓
   *
   * 现在：同名 → 同一个编号 ✓ 同色同号 → 真是一片 ✓ 线自然就没了 ✓
   * （"用自己的色 + 自己的名涂自己那块不该多一圈线"这个效果**反而更稳** ✓
   *   因为两边是**真的**同号，而不是靠一个哨兵值去糊 ✓）
   */
  const _ownNm = String(state.titles.names[tid] || '');
  const _brushNm = String(state.brushLabel || _ownNm);
  const lid = clear ? -1 : labelIdOf(_brushNm);
  let hits = 0;
  for (let pid = 1; pid < n; pid++) {
    if (tm[row + pid] !== tid) continue;
    hits++;
    if (clear) {
      renderer.setPaint(pid, 0, 0, 0, 0);
      renderer.setPaintLabel(pid, 0);
      if (state.provTitle) state.provTitle[pid] = -1;
      if (state.provLabel) state.provLabel[pid] = -1;
    } else {
      renderer.setPaint(pid, rgb[0], rgb[1], rgb[2], 255);
      renderer.setPaintLabel(pid, Math.min(lid + 1, 65535));
      if (state.provTitle) state.provTitle[pid] = tid;
      if (state.provLabel) state.provLabel[pid] = lid;
    }
  }
  // 这笔涂下去带了什么标记，回头色块上就标什么名
  if (clear) state.titleLabel.delete(tid);
  else state.titleLabel.set(tid, state.brushLabel || state.titles.names[tid]);
  return hits;
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
        setBrush(col, true);
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

  // ① 「荒漠 · 涂色」关着：荒地一律显示原版灰（连自动色一起藏）
  if (isWastelandTid(own) && !state.showWaste) {
    return [94, 94, 94];
  }
  // ② 手绘层：只有「填色 · 颜色」开着才看得见
  const pd = renderer && renderer.paintData;
  if (state.showPaint && pd && pid && pd[pid * 4 + 3] > 0) {
    return [pd[pid * 4], pd[pid * 4 + 1], pd[pid * 4 + 2]];
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
  // 头衔级标签（导入的工程 / 右键标名走的是这条 ✓）
  if (state.titleLabel && tid !== NO_TITLE && tid != null && state.titleLabel.has(tid)) {
    return state.titleLabel.get(tid);
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
  const _raw = displayedColor(pid, tid) || [0, 0, 0];
  const _c255 = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  const col = [_c255(_raw[0]), _c255(_raw[1]), _c255(_raw[2])];
  setBrush(col, true);
  // 标记名取法 ✓（两条：涂过 / 没涂过）
  //   · **你涂过的地** → 用它的**涂色标记**（你给它起的名字 ✓）
  //   · **没涂过的地** → 用**当前这一层头衔自己的名字** ✓（视图在省份 → 莫斯科 ✓）
  //   ✗ 不再经过"头衔级标签"那一档：那是按**剧本层头衔**存的 ✓ → 会把省名吸成国名 ✓
  let _nm = '';
  const _paintedHere = !!(renderer && renderer.paintData && renderer.paintData[pid * 4 + 3] > 0);
  const _lid = (_paintedHere && state.provLabel) ? (state.provLabel[pid] | 0) : -1;
  if (_lid >= 0 && state.labelNames && state.labelNames[_lid]) {
    _nm = String(state.labelNames[_lid]);
  } else if (state.titleName && tid != null && state.titleName.has(tid)) {
    _nm = String(state.titleName.get(tid));
  } else {
    _nm = String((state.titles.names && state.titles.names[tid]) || '');
  }
  setBrushLabel(_nm.trim());

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
  if (isLocked(tid)) return;
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
  if (isLocked(tid)) return;   // '''山是背景，不给改

  if (state.tool === 'rename') { openRename(pid); return; }
  if (state.tool === 'capital') {
    setCapitalAt(pid);        // 定都：静默，只看归属 ✓
    return;
  }
  if (state.tool === 'pick') {
    pickTitle(tid, false, pid);
  } else if (state.tool === 'paint') {
    paintAt(pid, tid);
  } else if (state.tool === 'erase') {
    // 两种口径：
    //   · **剧本视图 + 没开粒度 + 「填色·边界」开着** → **按色块清**（跟涂色同一个口径 ✓）：
    //     只清"跟点中的这块同色同标记"的笔迹。同一个头衔里被涂成别的颜色的地方
    //     （1936 剧本里德国占领的那半壁法国就是这种）一块都不许碰 ✗
    //   · 其余情况照旧 **按"点到的整块地区"清**：在河南（公爵领）上点一下，把这块地
    //     **包含的**所有涂色一起清掉 —— 里面涂过的伯爵领不用一个个点。
    //     涂色是按像素落下去的，所以范围就按编辑层那一块所占的像素来取。
    const _nEraE = (state.meta.eraDates && state.meta.eraDates.length) || 0;
    const _eraErase = _nEraE > 0 && state.grain == null && editTier() < _nEraE;
    const _pdE = renderer && renderer.paintData;
    if (_eraErase && state.showBorderPaint && _pdE) {
      // 点中的地**涂过** → 全图同色同标签的都算（跟涂色那边认族同一套 ✓）；
      // 没涂过 → 只在本层头衔里找同色同标记的（那多半一块都没涂 = 本来就没什么可清 ✓）
      const _blk = _pdE[pid * 4 + 3] > 0 ? playerGroupPidsAt(pid) : sameBlockPids(tid, pid);
      const _live = _blk.filter((q) => _pdE[q * 4 + 3] > 0);   // 只清真有笔迹的地块 ✓
      if (_live.length) {
        // 一次点击 = **一步**历史 ✓：快照 → 按**地块**清 → 合成一条 patch ✓
        const _snaps = snapshotPidsList(_live);
        clearPidsPaint(_live);
        // 清完可能有的头衔只剩半个、甚至一块地都不剩 → 账本按手绘层重算 ✓
        recomputePainted();
        pushPatches(_snaps);
      }
    } else {
      const n = state.meta.numProvinces;
      const tm = state.titlemap;
      const nT = state.meta.tierNames.length;
      // 范围按编辑层那一块取 ✓；点到**无主地**时那一层没有归属可言 →
      // 按"光标底下这一块"最细那层圈范围 ✓（跟 actAt 里笔的换法保持一致 ✓）
      const _t0E = titleAt(pid, editTier());
      const editT = (_t0E == null || _t0E === NO_TITLE) ? (nT - 1) : editTier();
      const hits = [];
      for (let p = 1; p < n; p++) {
        if (tm[editT * n + p] !== tid) continue;
        for (let ti = 0; ti < nT; ti++) {
          const one = tm[ti * n + p];
          if (one !== NO_TITLE && state.painted.has(one) && hits.indexOf(one) < 0) hits.push(one);
        }
      }
      if (!hits.length) return;
      // 一次点击 = **一步**历史：先把要清的都拍快照，再一起清，最后合成一条 patch
      const _snaps = [];
      for (const one of hits) _snaps.push(...snapshotPids(one));
      for (const one of hits) restoreTitle(one, true);
      pushPatches(_snaps);
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
 * 用途：细层视图里"这块地原来是哪个国家"（更新国名 / 族的身份 / 国名落点 / 定都的标记名 ✓）。
 * 停在剧本层时就是它自己 ✓ —— **空白剧本也算它自己**（那一层本来就谁都没有 ✓，
 * 所以在那儿画出来的东西才叫"你自己的国" ✓）。
 *
 * ⚠ 别写回 `min(tier, eraDates.length - 1)`：空白剧本挂在**剧本块最右边** ✓，
 *   细层视图下"最近的那个剧本"就变成空白层了 ✗ → 原版国名/身份全没了 ✗
 *   （空白层不在最后时（老数据）这条自动退回老行为 ✓）
 */
function countryTier() {
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
  setBrush(state.titles.colors[tid], false);
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
    dot.style.background = rgbToHex(h.color);
    dot.onclick = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      setBrush(h.color, false);
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
    row.onclick = () => { setBrush(h.color, false); setBrushLabel(h.name); };
    box.appendChild(row);
  }
  for (const r of rows) {
    const tid = r.tid;
    const row = document.createElement('div');
    row.className = 'result-row';
    // 色点：**点它只取色**（设画笔 + 定标记），绝不跳镜头、不动图层 ✓
    const dot = _mk('dot', '');
    // 颜色取不到也给个灰的 —— rgbToHex(undefined) 会抛，抛了就整块面板空着 ✗
    const _col = t.colors[tid] || [128, 128, 128];
    dot.style.background = rgbToHex(_col);
    dot.onclick = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      setBrush(_col, false);
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
    if (r.tag) row.onclick = () => { setBrush(_col, false); setBrushLabel(t.names[tid]); };
    else row.onclick = () => jumpToResult(tid);   // 地区 / 省份：点行 = 定位 ✓
    box.appendChild(row);
  }
}

// ================================================================ 导出

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
    if (_lgN < 0) return toast('已导出，但图例是空的：这个视图里还没有可列的颜色 ✓ 先涂几块、或者在剧本层导出试试');
    toast(`已导出当前画面 ${out.width}×${out.height}` + (_lgN ? `（含 ${_lgN} 条图例）` : ''));
  }, 'image/png');
}

/**
 * 导出整张地图，按原始 9216×4608 分块渲染再拼起来
 * 不带地名 —— 地名是按屏幕尺寸排布的，拼到原尺寸上要重算一套，先不掺和
 */
async function exportFullPNG() {
  const meta = state.meta;
  const W = meta.mapWidth;
  const H = meta.mapHeight;
  const glCanvas = $('map');
  const TILE = 2048;
  let _lgN2 = 0;                 // 图例画了几条（-1 = 勾了但没东西可画 ✓）

  const savedW = glCanvas.width;
  const savedH = glCanvas.height;
  const savedView = { ...renderer.view };

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');

  renderer.fixedSize = true;
  // 关掉抗锯齿：整图导出时一个像素 = 一个地图像素，四点超采样会在两个色块
  // 之间平均出一条混色带（放大看就是"糊的区域"）。屏幕上不受影响 ✓。
  renderer.noAA = true;
  toast('正在渲染整张地图');

  try {
    for (let ty = 0; ty < H; ty += TILE) {
      for (let tx = 0; tx < W; tx += TILE) {
        const tw = Math.min(TILE, W - tx);
        const th = Math.min(TILE, H - ty);
        glCanvas.width = tw;
        glCanvas.height = th;
        renderer.setView(tx, ty, tw, th);
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
        ctx.drawImage(glCanvas, 0, 0, tw, th, tx, ty, tw, th);
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
    _lgN2 = maybeDrawLegend(ctx, W, H);
    invalidate();
  }

  out.toBlob((b) => {
    if (!b) return toast('导出失败，可能图太大', true);
    download(b, `${GAME.filePrefix}_整图_${stamp()}.png`);
    if (_lgN2 < 0) return toast('已导出，但图例是空的：这个视图里还没有可列的颜色 ✓ 先涂几块试试');
    toast(`已导出整张地图 ${W}×${H}` + (_lgN2 ? `（含 ${_lgN2} 条图例）` : ''));
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
// 存档按游戏分开存：ck3-map-editor/v1、eu4-map-editor/v1
// 两边的省份 id 完全是两套编号，混在一起会互相把对方涂花
// （CK3 的键跟老版本一样，所以已有的存档不用迁移。）
let saveTimer = 0;

/** 涂完别马上写盘，等手停下来一会儿再存 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 800);
}

/** 打包成一份工程数据 */
function projectData() {
  const t = state.titles;
  const out = { version: 1, generated: new Date().toISOString(), titles: {}, labels: {},
                capitals: (state.capitalPids || []).slice(),
                capitalOf: Object.assign({}, state.capitalOf || {}),
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
  for (const tid of state.painted) {
    const key = t.keys[tid];
    const c = state.paintColor.get(tid) || t.colors[tid];
    out.titles[key] = [c[0], c[1], c[2]];
    const lb = state.titleLabel.get(tid);
    if (lb) out.labels[key] = lb;
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
  if (Array.isArray(data.capitals)) state.capitalPids = data.capitals.slice();   // 首都一起恢复 ✓
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
          // **抹掉之前先留一份底** ✓
          // 名字从画面上消失是文件要求的；但"数据首都"那条路（族的名字 == 哪个国的名字）
          // 还要拿它当**身份**用 —— 底没了，导入进来的国名就只能落到"面积最大那片"、
          // 落不到"首都那片" ✗（留底只给查表用，显示照旧看 titles.names ✓）
          state.eraNames = state.eraNames || new Map();
          state.eraNames.set(i, String(_t.names[i]));
          _t.names[i] = '';
          _cleared++;
        }
      }
      if (_cleared) { labelDirty = true; blocksDirty = true; }
    }
  }
  // **导入不动"设置"** ✗ —— 工程里那份 settings 是导出那一刻的界面开关 ✓
  // （势力名/地名那些一被套回来，剧本国家名就整片空了 ✓ = 用户报的"导入后国名全空"✓）
  // 导入只管涂色 ✓，你看什么由你自己当前的开关切定 ✓
  if (data.capitalOf && typeof data.capitalOf === 'object') state.capitalOf = Object.assign({}, data.capitalOf);
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
  toast(`已导出${count} ${GAME.entity}的涂色，下次拖回窗口就能恢复。`);
}

function importJSON(file) {
  // 导入一份文本 —— 两条入口（拖文件 / 传文本）共用的收尾
  // （原来这两个分支各写了一份逐字相同的处理 ✗ —— 改了 toast 忘了改另一处就分叉了 ✓）
  const applyText = (text) => {
    try {
      const n = applyProject(JSON.parse(text));
      if (!n) return toast(`这份文件里没有能识别的${GAME.entity}。`, true);
      scheduleSave();
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
  const all = new Set([...state.painted, ...state.changed]);
  if (!all.size) return;
  for (const tid of all) restoreTitle(tid);
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
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Firefox 的滚轮默认是"行"模式（一格 ±3），不换算的话一格只缩 ~0.5%；
    // "页"模式同样换算回像素量级，几个浏览器手感才一致。
    const dy = e.deltaMode === 1 ? e.deltaY * 33
      : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
    zoomBy(Math.exp(-dy * WHEEL_K), e.clientX, e.clientY);
  }, { passive: false });

  stage.addEventListener('mousedown', (e) => {
    if (e.button === 1 || (e.button === 0 && state.tool === 'view')) {
      panning = { x: e.clientX, y: e.clientY, cx: state.cam.cx, cy: state.cam.cy };
      $('map').style.cursor = 'grabbing';
      e.preventDefault();
    } else if (e.button === 0 && state.tool !== 'view') {
      // 只有涂色/擦除支持按住拖动连发 —— 定都/改名这些单击工具不置 painting，
      // 要不然从 A 拖到 B 会沿路连发（定都一路设过去、改名弹窗被反复重开，
      // 正打到一半的名字也被清掉）。
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
      put('set-w', s.w != null ? s.w : (state._borderWidthBase || 1.6));
      put('set-pa', s.pa != null ? s.pa : 50);
      put('set-ra', s.ra != null ? s.ra : 75);
  put('set-ca', s.ca != null ? s.ca : 100);
      put('set-pw', s.pw || 1);
      put('set-font', s.font || 1);
      // 导出图例那一栏：回填勾选/标题/位置，并把条目列表刷出来 ✓
      // （这里以前漏了 ✗ → 设置里那一栏是空的、勾选也回填不了 ✓）
      const _lgEl0 = $('set-legend');
      if (_lgEl0) _lgEl0.checked = !!(s.legend);
      put('set-legend-title', s.legendTitle || '');
      const _lpEl0 = $('set-legend-pos');
      if (_lpEl0) _lpEl0.value = s.legendPos || 'tl';
      rebuildLegendPanel();
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
    bindColor('set-bg', 'bg');
    bindColor('set-sea', 'sea');
    bindColor('set-lake', 'lake');
    bindColor('set-impass', 'impass');
    bindColor('set-impass-sea', 'impassSea');
    bindColor('set-river', 'river');
    const bindRange = (id, key) => {
      const el = $(id);
      if (el) el.addEventListener('input', () => { state.set[key] = Number(el.value); applySettings(); });
    };
    bindRange('set-w', 'w');
    bindRange('set-pa', 'pa');
    bindRange('set-ra', 'ra');
  bindRange('set-ca', 'ca');
    bindRange('set-pw', 'pw');
    bindRange('set-font', 'font');
    // 导出图例的三个控件 ✓（勾选 / 标题 / 位置）
    const _lgEl = $('set-legend');
    if (_lgEl) _lgEl.addEventListener('change', () => { state.set.legend = _lgEl.checked; scheduleSave(); });
    const _ltEl = $('set-legend-title');
    if (_ltEl) _ltEl.addEventListener('input', () => { state.set.legendTitle = _ltEl.value; scheduleSave(); });
    const _lpEl = $('set-legend-pos');
    if (_lpEl) _lpEl.addEventListener('change', () => { state.set.legendPos = _lpEl.value; scheduleSave(); });
    if ($('set-reset')) $('set-reset').onclick = () => {
      state.set = Object.assign({}, SET_DEFAULTS);
      applySettings();
      _open();
    };
  }

  const _wrap = (fn) => (ev) => { _closeMenu(); return fn(ev); };
  $('btn-png').onclick = _wrap(exportViewPNG);
  $('btn-png-full').onclick = _wrap(exportFullPNG);
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
    // **尾部节流**：连续涂色时最多 ~120ms 重算一次；停手后一定会补算一次 ✓
    // （原来每一笔都全图并查集，V3 4 万地块会卡 ✗）
    const _nowB = performance.now();
    if (_nowB - (state._blocksAt || 0) > 120) {
      state._blocksAt = _nowB;
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
 * 悬停该高亮谁：开着「填色·边界」时**以玩家为准** ——
 * 返回那一族的涂色（着色器按颜色整族点亮），否则返回 null（照旧按头衔单选）。
 */
function hoverGroupRgb(pid) {
  // **三个条件齐备**才以玩家为准：开着「填色·边界」+ 停在剧本层 + **没开粒度** ✓
  // （开了地区/省份粒度就照旧按头衔高亮 —— 一次一个，别整族）
  if (!state.showBorderPaint) return null;
  const _nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  if (!(_nEra > 0 && state.grain == null && editTier() < _nEra)) return null;
  if (!pid) return null;
  const pd = renderer && renderer.paintData;
  const p4 = pid * 4;
  // **涂过的先答** ✓：这一族的身份整个在手绘层上（颜色 + 标记），
  // 跟上位那一层有没有主无关 —— 空白剧本里（一层全无主）涂出来的色块照样整族亮 ✓
  if (pd && pd[p4 + 3] > 0) return [pd[p4], pd[p4 + 1], pd[p4 + 2]];
  // 海 / 湖 / 不可通行 / 荒地 / 无主地：**不做整族高亮** ✓
  // （它们共用同一个伪节点，整族高亮会把一整片海都点亮 ✗）
  const _real = state.meta.numRealTitles != null ? state.meta.numRealTitles : 1e9;
  const _t0 = titleAt(pid, editTier());
  if (_t0 == null || _t0 === NO_TITLE || _t0 >= _real) return null;
  if (isWastelandTid(_t0)) return null;
  // **按显示色**：涂过用手绘色，没涂用原版色 ——
  // 取大清的颜色涂俄罗斯之后，悬停俄罗斯时大清也该一起亮 ✓
  const tid = titleAt(pid, editTier());
  if (pd && pd[p4 + 3] > 0) return [pd[p4], pd[p4 + 1], pd[p4 + 2]];
  const c = stableColor(pid, tid);
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
    renderer.hoverPid = 0;
    renderer.hoverPaintOn = 0;
    renderer.setHover(null);
    return;
  }
  // **涂过的无主地**（空白剧本那种一层全无主的）也按"一族"亮 ✓ ——
  // 别的背景（海/湖/荒地）照旧只亮光标底下这一块 ✓
  const _noOwnHere = (_t0 == null || _t0 === NO_TITLE);
  const _paintNoOwn = _noOwnHere
    && !!(renderer.paintData && pid && renderer.paintData[pid * 4 + 3] > 0);
  if (_isBg && !_paintNoOwn) {
    renderer.hoverPid = pid ? pid : 0;
    renderer.hoverPaintOn = 0;
    renderer.setHover(null);
    return;
  }
  renderer.hoverPid = 0;
  const grp = hoverGroupRgb(pid);
  renderer.hoverPaintOn = grp ? 1 : 0;
  if (grp) {
    renderer.hoverPaint = [grp[0] / 255, grp[1] / 255, grp[2] / 255];
    // **标记也要算上** ✓：同色不同标记是两块 ✗
    // 而且**每块地都要有标记编号** ✗（没涂过的地用它的原版国名 ✓ = 原版那块跟涂出来那块是一家 ✓）
    const _ctH = countryTier();        // 同上（跟那个键保持一致 ✓）
    const _keyH = _ctH + '|' + (state.painted ? state.painted.size : 0)
      + '|' + ((state.labelNames && state.labelNames.length) || 0);
    if (state._lblPassKey !== _keyH) syncAllPaintLabels();
    renderer.hoverLabel = (renderer.paintLabelData && renderer.paintLabelData[pid]) | 0;
  }
  // 不过 isLocked：海/荒地是伪头衔，会被判成锁住从而把高亮清空
  renderer.setHover(grp ? null : (hl != null ? hl : _t0));
}

/**
 * 常规模式（头衔关、手绘开）下的标注点：**一坨连通色 = 一个标签**
 *
 * 一整个连成片的色块，哪怕跨了一百个帝国，也只该有一个名字 —— 所以这里
 * 不看头衔、也不看颜色，而是按省份邻接关系做并查集，把涂过的地方切成
 * 一坨一坨（**同色 + 同标记**才算同一坨，相邻但不同色、或同色但标记不同的都是两块），
 * 每一坨取**面积最大的那一块**的几何中心，名字就标在那里 ——
 * 同一个标记铺成好几块互不相连的地方时，只留最大的那块露名字，
 * 免得满屏都是同一个小岛的标签
 *
 * 结果缓存 state.paintBlocks，涂色后标脏、下一帧重算
 * 返回 null 表示「不在常规模式」，交给普通的按层级标法
 */
/** 一个头衔"原来的名字" —— 活着就直接读，被导入文件的 clearEraNames 清过就读留底那份 ✓
 *
 * 只给**身份 / 查表**用（"这一族是不是那个国家"、"国名 → 首都省"），
 * 显示那条线照旧只看 titles.names —— 清掉的名字不许漏回画面上 ✗ */
function eraNameOf(tid) {
  const live = (state.titles && state.titles.names && state.titles.names[tid]) || '';
  if (live) return String(live);
  return (state.eraNames && state.eraNames.get(tid)) || '';
}

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
  // **首都身份表**（all 模式用）：建在下面那一遍里顺手做，不再单独扫全图 ✗
  const capOfIdent = new Map();
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
    const capOfTid = new Map();          // 头衔 → 它的首都省（0 = 没有）
    const keyTag = new Map();            // 族 → 它坐在哪个国家里（-1 = 坐过好几个，说不清）
    const caps = state.meta.capitals || null;
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
        // 这一级头衔对应的首都也一并缓存 —— 否则每个省都要 split 一次键名 ✗
        let cp1 = 0;
        if (caps) {
          const tag0 = String(state.titles.keys[tid] || '').split('_').slice(1).join('_');
          const v0 = caps[tag0];
          if (v0 > 0 && v0 < n) cp1 = v0;
        }
        capOfTid.set(tid, cp1);
      }
      // **原版名是空的不等于这块地没名字** ✗ —— 涂过的地名字在标签层 ✓
      // （导入带 clearEraNames 的配色时，原版国名被整层清掉；以前这里一律 continue
      //   → 涂过的地也一起跳过 → 全图一个国名都画不出来
      //   = 用户报的「导入涂色方案之后显示不出国家名称」✓）
      if (key == null && !_paintedPid) continue;
      let k0 = key;
      if (_paintedPid) {
        // 涂过的省：身份按手绘层算（名字取标记名、颜色取涂色）
        let nm2 = displayedLabel(pid, tid);
        if (!nm2) {
          // 年份层那个名字取不出来时（导入文件按 clearEraNames 把它清空了），
          // 退回**涂它的那个头衔**身上的标记名 ✓
          // —— paintTitle 在"标记名 == 那块地本来的名字"时把 provLabel 记成 -1，
          //    标记名只留在那个头衔的 titleLabel 里；而那个头衔在**涂色那一层**，
          //    跟当前视图层无关 → 拿 editTier() 去找是找不到的 ✗（provTitle 才对）
          const _pt = state.provTitle ? state.provTitle[pid] : -1;
          if (_pt != null && _pt >= 0 && state.titleLabel && state.titleLabel.has(_pt)) {
            nm2 = String(state.titleLabel.get(_pt));
          }
        }
        if (!nm2) continue;
        const c2 = stableColor(pid, tid);
        if (!c2) continue;
        k0 = nm2 + "|" + c2[0] + "," + c2[1] + "," + c2[2];
      }
      ident.set(pid, k0);
      parent[pid] = pid;            // union-find 初始化并进这一遍（原来又扫了一遍 ✗）
      painted.push(pid);
      const cp0 = capOfTid.get(tid) | 0;
      // **只有"这一族就是这个国家"时才认它的 tag 首都** ✓
      // （否则中华民国那块顶着"中华苏维埃共和国"的名字，会把南京认成这一族的首都 ✗
      //   而且一旦认了，后面"按国名查表"那步会以为它已经有主、直接跳过 ✗ → 首都没了 ✓）
      // 名字用 eraNameOf：导入文件把原版国名清掉之后，靠**留底**那份照样对得上 ✓
      //（不然每一族都对不上 → 国名只能落到"面积最大那片"，落不到首都那片 ✗）
      // 另外**自家名字带后缀**也得认（作者写的是"威尼斯共和国""莫斯科大公国"，
      // 数据里那个头衔叫"威尼斯""莫斯科"）：族名里含国家本名就算 ✓
      // —— 本名要求 ≥2 字，不然"清""明"这种一字国名会到处乱撞 ✗
      const _nmTitle0 = eraNameOf(tid);
      const _nmFam0 = k0.indexOf('|') > 0 ? String(k0.split('|')[0]) : '';
      const _nmOk = !!_nmTitle0 && (!!_nmFam0 && (_nmFam0 === _nmTitle0
        || (_nmTitle0.length >= 2 && _nmFam0.indexOf(_nmTitle0) >= 0)));
      if (cp0 && _nmOk && !capOfIdent.has(k0)) {
        capOfIdent.set(k0, cp0);
      }
      // 顺手记：这一族**是不是只坐在一个国家里**（兜底要用）
      // keyTag: 族 → 那个国家的头衔；坐过两个国家就记 -1（那就是说不清了 ✓）
      {
        const _prev = keyTag.get(k0);
        if (_prev === undefined) keyTag.set(k0, tid);
        else if (_prev !== tid) keyTag.set(k0, -1);
      }
    }
    // 兜底：**族名在数据里认不出、但整族只坐在一个国家里** → 就用那个国家的首都 ✓
    // （色块的名字是随手填的，跟数据里的国名对不上很正常 —— 可整族全在这一个 tag 里，
    //   那它就是那个国家：名字该落在它的首都，不该落到"面积最大那片" ✗）
    // 只有"首都在自己地盘里"才真的起作用：下面 capOf 那段会拿 keyOfPid(首都) 跟这一族比，
    // 不在这族里的首都直接被丢掉 ✓（所以给单省族配一个外面的首都也没副作用 ✓）
    for (const [_k0, _t0] of keyTag) {
      if (_t0 < 0 || capOfIdent.has(_k0)) continue;
      const _cp = capOfTid.get(_t0) | 0;
      if (_cp > 0) capOfIdent.set(_k0, _cp);
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
  // 定都工具记的也是这个格式（L<编号> / C|r,g,b），两边必须一致 ✗
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
    //   → 同色同名却被判成两族 ✗ → 首都那片孤立 ✗）
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

  // 定都：涂色实体也能有首都 —— 名字该落在**含首都那一片**上，
  // 而不是默认的"面积最大那片"（同色可能铺成好几块互不相连的地方）。
  //   ① 首都还在那片里          → 用它
  //   ② 首都自己被涂掉了        → 用**挨着首都的那一片**（不是最大片）
  //   ③ 首都就是那片最后一块地  → 落到面积最大那片
  // 这两张表必须在下面的累加循环**之前**备好（第一版放到后面了，TDZ 直接把测试炸了）。
  const capOf = Object.assign({}, all ? Object.fromEntries(capOfIdent) : {},
                              state.capitalOf || {});   // 工具设的优先（它能覆盖数据里的默认）

  // 标首都统一走这里 ✓（顺手记下**是哪条路标的** ✗ → 高亮时能直接写出来 ✓）
  // 并且**每一次调用都记进日志** ✓（用户要求：凡是动首都的代码全留痕 ✓）
  const markCap = (g, pid, why) => {
    if (!g) return;
    g.hasCap = true;
    g.capPid = pid | 0;
    g.capWhy = why;
  };

  const groups = new Map();
  // **剧本层（all）里全图每个省都要有组** ✓ —— 没涂过的那一片（比如陕北）
  // 也得有个组，不然"首都那块地所在的那一片"查不到，名字只能退回最大片 ✗
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
    // 玩家/存档里的定都：只要那块地**还在这一族里**就一直算数 ✓
    // （涂成同色同标记 = 还在这一族 ✓ 不动；涂成别的色/别的标记 = 转族了 ✗ → 作废 ✓）
    // all 模式（画名字那层 ✓）的键是「名字|rgb」✗，它按 tag 查到的首都会给错族 ✗：
    //   只有"这块地的头衔名 == 这一族的名字"时才认 ✓（否则中华民国那块会把南京塞给中华苏维埃 ✗）
    const _famNmAll = all && g.key && g.key.indexOf('|') > 0 ? String(g.key.split('|')[0]) : '';
    const _pidNmAll = (() => {
      const t9 = titleAt(pid, cTier);
      return String((t9 != null && t9 !== NO_TITLE ? state.titles.names[t9] : '') || '');
    })();
    const _capOkAll = !all || !_famNmAll || !_pidNmAll || _famNmAll === _pidNmAll;
    if (capOf[g.key] > 0 && capOf[g.key] === pid && _capOkAll) {
      markCap(g, pid, all ? '数据 tag（名字一致）' : '玩家定都');
    }
    // 数据首都改成**独立一遍**做（见下面 _nameCap 那一段）：
    // 因为首都那块地常常没被涂过 ✗，在这一遍里根本扫不到它 ✓
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

  // 同色同标记可能铺成好几块互不相连的地方（一整片主色 + 一堆沿海小岛）
  // 这一组只让**面积最大的那一块**露名字，标在它自己的几何中心 ——
  // 免得满屏都是同一个小岛的标签
  // 「本土」= 首都所在的那一片区域。
  //   ① 首都还在这一族里 → 本土就是含首都那片，并**记下来**
  //   ② 首都被涂掉了      → 本土 ∩ 现在剩的地盘，取**最大的一片**
  //   ③ 本土整片都没了    → 不标，落到"目前最大的连通域"
  const keyOfPid = (pid) => {
    if (all) return ident.get(pid);
    const p4 = pid * 4;
    if (paint[p4 + 3] === 0) return undefined;
    return paintKeyOf(pid);
  };
  const homelandOf = state.homelandOf || (state.homelandOf = {});
  for (const k3 of Object.keys(capOf)) {
    const cp3 = capOf[k3];
    if (!(cp3 > 0) || cp3 >= n) continue;
    // 只要那块地**还在这一族里**（keyOfPid 相同 ✓）定都就一直算数 ✓
    // 涂成同色同标记不影响 ✓；涂成别的色/别的标记时会自动对不上、落到下面 ② 的兜底 ✓
    const ownG = keyOfPid(cp3) === k3 ? groups.get(find(cp3)) : null;
    if (ownG) {
      markCap(ownG, cp3, '本土/挨着首都');      // ① 首都还在：名字就摆这儿
      homelandOf[k3] = ownG.pids.slice();       //    并把本土记住
      continue;
    }
    const home = homelandOf[k3];
    if (!home || !home.length) continue;
    let bestG = null;
    for (const pid5 of home) {                  // ② 本土还剩几片？取最大的那片
      if (pid5 >= n || keyOfPid(pid5) !== k3) continue;
      const g5 = groups.get(find(pid5));
      if (g5 && (!bestG || g5.w > bestG.w)) bestG = g5;
    }
    if (bestG) bestG.isHomeland = true;
  }

  // 旧键清一清：改色/换标记重涂后族身份串就换了新的，旧键连着几千个 pid 的
  // 数组原样挂着（只增不减），长会话里越攒越多 —— 这轮没再出现的直接扔。
  for (const k3 of Object.keys(homelandOf)) {
    if (!(k3 in capOf)) delete homelandOf[k3];
  }

  // 每族只留一片露名字：优先"含首都那片"，其次"挨着首都那片"，最后才"面积最大那片"
  // 数据首都：**国名 → 首都省** 独立建表（从 meta.capitals + 各年份层的国名）
  // 族的标签名 == 某国名字 → 那个国的首都就算这一族的 ✓
  // 关键：**不要求首都那块地被涂过** ✗（它常常没涂 ✗，涂色那遍里扫不到它 ✓）
  {
    const _nameCap = new Map();
    if (state.meta.capitals) {
      const K = state.titles.keys;
      for (let i = 0; i < K.length; i++) {
        const k = String(K[i] || '');
        const m0 = /^\d{4}_(.+)$/.exec(k) || /^(?:e|k|d|c|b)_(.+)$/.exec(k);
        if (!m0) continue;
        const cpv = state.meta.capitals[m0[1]] | 0;
        const nmv = eraNameOf(i);
        // 只有"**标签名跟这个头衔原来的名字不一样**"的才排除 ✗（那种是在冒名 ✗）
        // 标名恰好等于原名（比如你标的就是 PRC 那块地 ✓）→ 照旧参与 ✓
        const _lb = state.titleLabel && state.titleLabel.has(i)
          ? String(state.titleLabel.get(i)) : '';
        const _impostor = !!_lb && _lb !== nmv;
        if (!_impostor && cpv > 0 && nmv && !_nameCap.has(nmv)) _nameCap.set(nmv, cpv);
      }
    }
    if (_nameCap.size) {
      for (const g of groups.values()) {
        // 玩家定过的族：数据首都让位 ✓（这个键是**按族**的 ✓ —— 有它就整族跳过 ✓）
        if (g.hasCap || capOf[g.key]) continue;
        // 名字取"**显示名**" ✓（没涂过的组 label = -1 ✗，用涂色标签会把它整组跳过 ✗
        //   —— 陕北那一片就是这么被漏掉的 ✗）
        const _p1 = g.pids[0];
        const ln = String(displayedLabel(_p1, titleAt(_p1, cTier)) || '');
        const cpv = ln ? (_nameCap.get(ln) | 0) : 0;
        // 注意：**不**因"首都被涂"作废 ✗ ——
        // 别的国家的首都根本轮不到（按国名对族，名字对不上 ✗），
        // 而自己那一族的首都（陕北）本来就可能被涂在自己的颜色里 ✓
        if (cpv > 0) {
          // **只标首都那块地所在的那一片** ✓（标整族会让同分的几片又比面积 ✗）
          const gg = groups.get(find(cpv));
          if (gg) markCap(gg, gg.capPid || cpv, '按国名查表 ' + ln);
        }
      }
    }
  }

  const rankOf = (g) => (g.hasCap ? 3 : (g.isHomeland ? 2 : 0));

  const biggest = new Map();
  for (const g of groups.values()) {
    if (g.w <= 0) continue;
    const prev = biggest.get(g.key);
    if (!prev || rankOf(g) > rankOf(prev) || (rankOf(g) === rankOf(prev) && g.w > prev.w)) {
      biggest.set(g.key, g);
    }
  }

  const out = [];
  for (const g of biggest.values()) {
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
    // 落点与字号 = **首都所在的那一族连通域自己**的几何中心与像素数 ✓
    //   （上面 rank 已经把"含首都那一片"选出来了 ✓：族群整体吞并之后它就是整块 ✓ → 名字跟着变大 ✓）
    //   以前这里钉在"原版同一个国家的那一小块"上 ✗（capPieceOf ✗）——
    //   于是"中华苏维埃吞并全国之后名字还只有陕北那么大"✗，迁都到南京才突然变大 ✓ = 用户报的假连通域 ✓
    out.push({ name, x: g.x / g.w, y: g.y / g.w, area: g.w, rgb: g.rgb,
               w: Math.max(0, (g.maxx || 0) - (g.minx || 0)),   // 横向跨度 ✓（限字号用 ✓）
               tid: nameTidOf(_p0n),   // 这一坨代表哪个头衔 ✓（图例里改名要写回它 ✓）
               pids: g.pids,   // 图例算"这一族涂出来的面积"要用（legendEntries）
               _key: g.key, _hasCap: !!g.hasCap, _capPid: g.capPid || 0 });
  }
  out.sort((a, b) => b.area - a.area);   // 大的先摆'
  state.paintBlocks = out;

  /* 图例列表**不在这儿刷** ✗ —— 这里是"涂一笔就重新分组"的地方 ✓
   * 每次涂色都重建一遍图例 DOM 是白费力气 ✓（而且面板开着的时候你根本涂不了地图 ✓）
   * 按用户的主意：**列表只在「点开图例 / 导出」时才更新** ✓
   *   · 手机版：切到「导出图例」那一页时刷一遍 ✓（见 mobile/mobile_js.txt 的 showTab）
   *   · 导出：maybeDrawLegend 开头会把欠着的色块重算补上 ✓ 用的就是同一份新数据 ✓
   */
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
  // "省份"那一层：**按层级键找**（meta.tierKeys 里写着"省"的那层）。
  // EU4/HOI4/V3 里它就是最细那层，EU5 里是倒数第二层（地区/省份/地点）——
  // 早先这里写死"最细那层" ✗，于是 EU5 的省份名在剧本层叠不出来。
  const _tk = (state.meta && state.meta.tierKeys) || [];
  let provTier = _tk.indexOf('省');
  if (provTier < 0) provTier = (state.meta ? state.meta.tierNames.length : nEra) - 1;

  // ① 地名（先入列 = 在下面）：勾了「地名」就画。
  //    视图本身是细层 → 画这一层；视图是年份层 → **只有粒度正好设成"省份"**时
  //    才把省名叠上去（地区/战略这些不叠），并且跟势力名**同时显示**、不互斥。
  if (state.showLabelsTitle) {
    // 剧本层下**只允许"最细的两层"叠地名**：省份 + 它更细的那层（EU5 是"地点"）。
    // 地区 / 战略这些**不叠**（不然一开门就是一堆名，把势力名压住了）。
    const _fineT = (state.meta ? state.meta.tierNames.length : nEra) - 1;
    const _et = editTier();
    const nameTier = isCountryView
      ? ((_et === provTier || _et === _fineT) ? _et : -1)
      : viewTier;
    if (nameTier >= 0) {
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

function setBoot(step, pct) {
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
    if (!box) {
      box = document.createElement('pre');
      box.id = 'fatal-box';
      box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;'
        + 'max-height:45%;overflow:auto;margin:0;padding:10px 12px;'
        + 'background:rgba(120,10,10,.94);color:#fff;'
        + 'font:12px/1.6 ui-monospace,Consolas,monospace;'
        + 'white-space:pre-wrap;border-top:2px solid #ff6b6b';
      document.body.appendChild(box);
    }
    box.textContent += msg + (n > 1 ? `   （同一处，第 ${n} 次）` : '') + '\n';
  } catch (e) { /* 上屏都失败就算了 */ }
}
window.addEventListener('error', (e) => {
  showFatal(`✗ ${e.message}\n  ${e.filename || ''}:${e.lineno || 0}`
    + (e.error && e.error.stack
       ? '\n' + String(e.error.stack).split('\n').slice(1, 4).join('\n') : ''));
});
window.addEventListener('unhandledrejection', (e) => {
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
    setBoot('看看有哪些地图', 3);
    const maps = await availableMaps();
    if (!maps.length) throw new Error('没有可用的地图数据，先跑一次 python build_data.py');

    const chosen = await pickMap(maps);
    if (isEmbedded()) setEmbeddedMap(chosen.emb);
    else setDataDir(chosen.dir);

    setBoot(`读取「${chosen.label}」的元数据…`, 6);
    const meta = await api.meta();
    if (!meta || !meta.numTitles) throw new Error('data/ 里还没生成好缓存，先跑 python build_data.py');
    state.meta = meta;
    buildMetaIndex();            // 名录快查表（荒地 / 无男爵领 / 巨型荒地）
    NO_TITLE = meta.noTitle ?? 65535;
    // 选的是哪张图，就按哪个游戏的术语和存档来
    GAME = GAMES[meta.game] || GAMES[chosen.game] || GAMES.ck3;
    TIER_BADGE = meta.tierKeys || ['e_', 'k_', 'd_', 'c_', 'b_'];

    setBoot(`加载${GAME.entity}表…`, 10);
    const titles = await api.titles();
    state.titles = titles;
    state.original = titles.colors.map((c) => c.slice());
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
    renderer = new MapRenderer($('map'), meta);
    renderer.onContextLost = () => toast('显卡把 WebGL 上下文弄丢了，地图画不下去了 —— 请刷新页面重试。', true);
    await renderer.setData({
      provinceIds: state.provinceIds,
      titlemap: state.titlemap,
      colors: titles.colors,
      // 分块清单**必须传进去** ✗ —— 少了这一行，渲染器会按"整图模式"建
      // 16384×8192 的纹理，却只拿到 1 个元素的占位数组 → WebGL 报
      // "ArrayBufferView not big enough"、纹理不完整 → 画面全白。
      tiles: state.tiles || null,
    });
    // 荒地标记（LUT 的 alpha 通道）+ 自动上色（写手绘层）。
    // 两个都在 setData 之后做：LUT 和手绘层都是那时才建好的。
    renderer.setWasteland(meta.wasteland || []);
    // **每块荒地的 LUT 起手 = 荒地灰** ✓（那才是它"没上色"的样子）
    // 这段原来写在文件末尾、`boot()` **之后** —— 而 boot 是 async，跑到那儿
    // state.meta 还是 null，于是这段**一次都没执行过**：EU5 的荒地就一直顶着
    // 数据里给省份位图用的技术色，一开「荒漠 · 涂色 / 自动」就是一片怪色 ✗
    paintWasteGrey();
    syncParentBorder();
    // **地名门槛按这张图自己的地块大小现算** ✓（不再吃 meta 里写死那套 ——
    //  那套是照某一张图调的，换个尺寸/换个游戏就对不上：地块小的图地名会提早糊出来）
    meta.labelZoom = computeLabelZoom(meta, titles);
    labels = new LabelLayer($('overlay'), titles, meta);

    setBoot('就绪', 100);

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
    setTimeout(() => $('boot').classList.add('done'), 220);
    setTimeout(() => { $('boot').style.display = 'none'; }, 900);

    // 上次没画完的，接着来 —— **静默接上** ✓ 不弹提示
    //（回到同一张图，画的东西原样在那儿就够了 ✗ 不用再飘一条"恢复了 N 个势力"打断你）
    loadProject();
  } catch (e) {
    console.error(e);
    setBoot('出错了：' + e.message, 100);
    $('boot-step').style.color = 'var(--danger)';
  }
}

boot();

// 新手引导：就绪后挂上顶栏那个「教程」按钮 ✓（本文件是独立小模块，不碰主逻辑）
if (typeof window.initTutorial === 'function') window.initTutorial();
