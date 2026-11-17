/**
 * 悖论制图（PDX Map Editor）主逻辑
 * 对外名称统一为「悖论制图」。
 */

// 开发版为 ES module（index.html 只加载本文件），其余模块须显式 import。
// 单文件版由 build_standalone.py 剥掉这些行、按序拍平，两边的加载方式都兼容。
/* 地图仓库需要显式导出 listMaps / putMap / deleteMap
 *    漏写 import 时，单文件版（已拍平）仍可运行，开发版会直接抛 listMaps is not defined， 且该异常会被 catch 静默吞成「空仓库」。
 */

import { DATA, api, b64ToBytes, decompress, embeddedMapKeys, embeddedMeta, isEmbedded, setDataDir, setEmbeddedMap, setPackMap, isPackMap } from './data.js';
import { MapRenderer } from './gl.js';
import { LabelLayer, computeLabelZoom, setLabelFont, labelFont, setLabelBitmap, labelBitmap } from './labels.js';
import { fontLibLoadAll, fontLibList, fontLibAdd, fontLibAddBitmap, fontLibRecord, fontLibRemove, fontLibFamily, fontLibClear, fontLibReady } from './fonts.js';
import { BitmapFont } from './bitmapfont.js';
import { TileMap } from './tilemap.js';
/* 地图仓库需要显式导出 listMaps / putMap / deleteMap
 *    漏写 import 时，单文件版（已拍平）仍可运行，开发版会直接抛 listMaps is not defined， 且该异常会被 catch 静默吞成「空仓库」。
 */
import { importPack, listPacks, getPack, removePack, exportPackBytes, packStoreMode, listMaps, getMap, putMap, deleteMap, getFileBytes } from './packstore.js';
/* 色标数据（ColorBrewer）；打包顺序排在 app.js 前面。 */
import { BREWER, BREWER_NAMES, brewerLevels, brewerColors } from './brewer.js';

const $ = (id) => document.getElementById(id);

/* 位图字体解码缓存：地名 / 势力名 / 图例共用，避免为同一套 .dds 重复解码占用几十 MB */
const _bmFontCache = new Map();
async function _loadBmFont(id) {
  if (_bmFontCache.has(id)) return _bmFontCache.get(id);
  const rec = await fontLibRecord(id);
  let bf = null;
  if (rec && rec.kind === 'bitmap' && rec.fnt) {
    try {
      bf = Array.isArray(rec.pages) && rec.pages.length
        ? new BitmapFont(rec.pages)
        : new BitmapFont(rec.fnt, rec.bytes);
      if (!bf.ok) bf = null;
    } catch (e) {
      bf = null;
      LOG.event('位图字体解析失败', ((e && e.message) || String(e)));
    }
  }
  _bmFontCache.set(id, bf);
  return bf;
}

/* 水域 / 荒地按普通地块处理
 *   没有专属的边界、颜色与高亮通道，涂色 / 悬停 / 边界缝统一走普通头衔管线。
 *   识别水域用的三个函数（`isWaterKey` / `isWaterPid` / `isWaterHere`）保留，
 *   供旧数据包的海名表、水域名表使用。
 */

/**
 * 报错日志（`web/js/log.js`，先于本文件加载）。
 *
 * 取不到时退化为空壳：日志异常不得影响编辑器。
 * 单文件版未打包 log.js、或对应的 <script> 被移除时，编辑器照常可用，
 * 只有「导出日志」内容为空。
 */
const LOG = window.PDXLOG || {
  event() {}, error() {}, env() {}, snapshot() {},
  count: () => 0, text: () => '', download: () => false,
};

/**
 * 作者署名：启动页小字与顶栏按钮均指向此处
 *
 * 换主页只改这一行（`space.bilibili.com/<数字 ID>`）
 */
const AUTHOR = {
  name: '永夜廿九',
  url: 'https://space.bilibili.com/442256114',
};

/**
 * 接上署名两个入口，页面初始化时立即挂载。
 *
 * 不要挪进 `bindEvents`：该函数要等地图烘焙完成才执行，EU5 / V3 需要数秒；
 * 署名印在启动页上，进入页面即可能点击，此时 <a> 尚无 href，点击不会产生效果。
 */
function bindAuthorLinks() {
  for (const id of ['author-link', 'btn-author']) {
    const el = $(id);
    if (!el) continue;
    el.href = AUTHOR.url;
    el.target = '_blank';
    el.rel = 'noopener';
  }
  // 启动页角落显示构建戳：便于确认当前使用的文件版本
  // 不能拿 document.lastModified
  //    单文件 / 某些浏览器里它是当前时间，看着像"版本戳一直在变"
  //    现在由 build_standalone.py 把打包时间写进 <meta name="pdx-build">
  //    开发版里是 dev → 显示「开发版」
  const bv = $('boot-ver');
  if (bv) {
    let build = '';
    try {
      const m = document.querySelector && document.querySelector('meta[name="pdx-build"]');
      build = m && m.content ? String(m.content).trim() : '';
    } catch (e) { build = ''; }
    bv.textContent = (UPDATE.version ? 'v' + UPDATE.version + ' · ' : '')
      + (build ? (build === 'dev' ? '开发版' : '构建 ' + build) : '');
  }
}

/* 检查更新：入口在启动页版本号旁。点击后查询 GitHub 最新 release 的 tag：
 *   比当前 `<meta name="pdx-version">` 新 → 下载对应的 .html 资源
 *   相同 → 「已是最新」；请求失败 → 「检查失败」（不弹窗、不阻塞）
 *
 * 只下载、不自动替换的原因：
 *   ① release 资源位于 release-assets.githubusercontent.com，响应无 CORS 头（ACAO 为空），
 *      JS 无法取回字节，也无法校验
 *   ② 单文件以 file:// 打开，浏览器不允许页面写入自身所在文件
 *   因此采用 <a download>：下载由浏览器接管，由使用者替换旧文件；
 *   全自动更新需要改为 https 部署。
 *
 * 接口使用 releases/latest（带 `Access-Control-Allow-Origin: *`，file:// 下可读）；
 * 限额 60 次/小时/IP，只在点击后请求一次，不做后台轮询。
 */
const UPDATE = {
  repo: 'Nianjiujiang/pdx-map-editor',
  version: metaOf('pdx-version'),
};

/** 读一个 <meta name/content>（读不到就给空串）*/
function metaOf(name) {
  try {
    const m = document.querySelector && document.querySelector('meta[name="' + name + '"]');
    return m && m.content ? String(m.content).trim() : '';
  } catch (e) { return ''; }
}

/** "v1.10.2" → [1,10,2]（非数字当 0 后缀 -beta 之类直接忽略）*/
function verParts(s) {
  const m = String(s || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [+m[1] || 0, +m[2] || 0, +m[3] || 0] : [0, 0, 0];
}

/*  remote 版本是否高于 local */
function verNewer(remote, local) {
  const a = verParts(remote), b = verParts(local);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * 点「检查更新」→ 查 → 有新的就点一下下载
 * @param {HTMLButtonElement} btn
 */
async function checkUpdate(btn) {
  const label = btn.textContent;
  const restore = (text, ms) => {
    setTimeout(() => {
      btn.textContent = label;
      btn.disabled = false;
      btn.classList.remove('is-new');
    }, ms);
  };
  btn.disabled = true;
  btn.classList.remove('is-new');
  btn.textContent = '检查中…';

  let rel = null;
  try {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimeout(() => { try { ac && ac.abort(); } catch (e) {} }, 12000);
    const r = await fetch('https://api.github.com/repos/' + UPDATE.repo + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ac ? ac.signal : undefined,
      cache: 'no-store',
    });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    rel = await r.json();
  } catch (e) {
    btn.textContent = '检查失败，点击重试';
    restore('', 4000);
    try { PDXLOG.event('update', '检查更新失败：' + (e && e.message)); } catch (_) {}
    return;
  }

  const tag = String(rel && rel.tag_name || '');
  const latest = tag.replace(/^v/i, '');
  if (!latest || !verNewer(latest, UPDATE.version)) {
    btn.textContent = '已是最新 v' + (UPDATE.version || '?');
    restore('', 4000);
    return;
  }

  /* 挑对应那一份资源：手机版跑的就拿手机版 （data-mobile 由 mobile/patch.py 打上）*/
  const wantMobile = document.documentElement.hasAttribute('data-mobile');
  const wantName = wantMobile ? 'pdx-map-editor-mobile.html' : 'pdx-map-editor.html';
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  /* 兜底同样按平台区分
 *   兜底不能接受任意 .html：release 缺少手机版时，手机版会下载到电脑版，安装后界面布局错误。
 *   手机版只在名称含 mobile 的资源中兜底；电脑版只在名称不含 mobile 的资源中兜底。
 */
  const hit = assets.find(a => a && a.name === wantName)
    || assets.find(a => a && /\.html$/i.test(a.name)
      && (wantMobile ? /mobile/i.test(a.name) : !/mobile/i.test(a.name)));

  btn.classList.add('is-new');
  btn.textContent = '发现 v' + latest + '，正在下载…';
  try { PDXLOG.event('update', '发现新版本 ' + latest + '（本地 v' + UPDATE.version + '）'); } catch (_) {}

  if (!hit || !hit.browser_download_url) {
    btn.textContent = '未找到 .html，正在打开发布页';
    btn.disabled = false;   // 不放开的话 onclick 永远不触发（disabled 的按钮不派发事件）
    btn.onclick = () => window.open(rel.html_url || ('https://github.com/' + UPDATE.repo + '/releases/latest'), '_blank', 'noopener');
    return;
  }

  /* 直接抓下载链接：跨域时 `download` 属性会被忽略，靠 GitHub 自己的
     Content-Disposition: attachment 落地 所以文件名会是资源名*/
  const a = document.createElement('a');
  a.href = hit.browser_download_url;
  a.download = hit.name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { a.remove(); } catch (e) {} }, 800);

  btn.textContent = 'v' + latest + ' 已开始下载，用它换掉旧文件';
  setTimeout(() => {
    btn.textContent = '重新下载 v' + latest;
    btn.disabled = false;
  }, 6000);
}

/* 接入「检查更新」（与署名一同初始化，启动页加载后即可点击） */
function bindUpdateCheck() {
  UPDATE.version = metaOf('pdx-version');
  const btn = $('btn-check-update');
  if (!btn) return;
  btn.addEventListener('click', () => { checkUpdate(btn); });
}
bindAuthorLinks();
bindUpdateCheck();

/* 「下载地图包」使用的两个底层工具
 * 选图页按下「下载地图包」后，卡片区切换为可下载卡片：点击即下载对应地图包，下载完成移除该卡，
 * 全部完成后恢复正常界面（流程见 bindPackDownload）。
 * 本段只负责两个底层函数。
 */
let PACK_ASSETS_CACHE = null;

/** 问 GitHub 最新 release 要 .pdxmap 清单 （问过一次就缓存，接口一小时只给 60 次）*/
async function fetchReleaseAssets() {
  if (PACK_ASSETS_CACHE) return PACK_ASSETS_CACHE;
  const r = await fetch('https://api.github.com/repos/' + UPDATE.repo + '/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const rel = await r.json();
  PACK_ASSETS_CACHE = {
    assets: (Array.isArray(rel.assets) ? rel.assets : [])
      .filter(a => a && /\.pdxmap$/i.test(a.name))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    htmlUrl: rel.html_url || ('https://github.com/' + UPDATE.repo + '/releases/latest'),
  };
  return PACK_ASSETS_CACHE;
}

/* 将资源交由浏览器下载（跨域无法读取字节，只能由浏览器落盘；同「检查更新」） */
function downloadAsset(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { a.remove(); } catch (e) {} }, 800);
}

/**
 * 地图包的显示名
 *   pdx-hoi4-vanilla.pdxmap → 「HOI4 原版」；pdx-hoi4-alt.pdxmap → 「HOI4 修改边界」
 *   卡片上不显示版本号：名称右侧不放其他内容 无法识别的包原样显示文件名，不做猜测
 */
const PACK_DISPLAY_NAMES = {
  'ck3-vanilla': 'CK3 原版',
  'eu4-vanilla': 'EU4 原版',
  'eu5-full': 'EU5 原版',
  'vic3-vanilla': 'VIC3 原版',
  'hoi4-vanilla': 'HOI4 原版',
  'hoi4-alt': 'HOI4 修改边界',
};
const PACK_GAME_NAMES = { ck3: 'CK3', eu4: 'EU4', hoi4: 'HOI4', vic3: 'VIC3', eu5: 'EU5' };
const PACK_VARIANT_NAMES = { vanilla: '原版', alt: '改版', full: '完整' };

function prettyPackName(file) {
  const base = String(file).replace(/\.pdxmap$/i, '').replace(/^pdx-/i, '');
  if (PACK_DISPLAY_NAMES[base.toLowerCase()]) return PACK_DISPLAY_NAMES[base.toLowerCase()];
  const m = /^([a-z0-9]+)-(.+)$/i.exec(base);
  if (!m) return base;
  const g = PACK_GAME_NAMES[m[1].toLowerCase()];
  if (!g) return base;
  return g + ' ' + m[2].split('-').map((w) => PACK_VARIANT_NAMES[w] || w).join(' ');
}

/** 字节数说人话（1.5 MB / 924 KB）*/
function fmtSize(n) {
  const b = Number(n) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}

/**
 * 每个游戏的术语、存档键与显示名
 *
 * 渲染层由两个游戏共用：EU4 的「省份 / 地区 / 区域 / 大洲」同为五级，与 titlemap 的 5 行一一对应，差异仅在叫法。
 *
 * 仅保留实际读取的字段：`modName` / `exportKind` / `exportTip` / `brushTip` 已删除，全仓库无消费者（编辑器未实现「导出 mod」），保留会误导。
 */
const GAMES = {
  /* CK2 是独立模式，并非「CK3 加别名」。渲染层与 CK3 共用（同为五级头衔界面），但规则各自定义：
 * · 四级而非五级：帝国 / 王国 / 公爵领 / 伯爵领，无男爵领；CK2 的男爵领是伯爵领内的地产，不占地图像素（层名与层数一律读 `meta.tiers`，前端不得硬编码，见 build_ck2.py 开头）。
 * · 名称含中文：走汉化 mod 的「自造三字节」编码（`parsers/ck2/hanhua.py` 回退链：汉化中文 → 原版英文 → 键名），搜索支持中英文。
 * · 剧本层为 1066（日期读游戏书签，见 `meta.bookmark`），另有「空白剧本」一层，构造与其他游戏相同。
 */
  ck2: {
    id: 'ck2',
    name: 'CK2',
    brand: 'CK', brandSmall: 'II',
    title: 'CK2 · 悖论制图',
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
    title: 'CK3 · 悖论制图',
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
    title: 'EU4 · 悖论制图',
    entity: '省份',
    saveKey: 'eu4-map-editor/v1',
    filePrefix: 'eu4',
    searchHint: '支持 TAG 与势力名、区域名、地区名、省份名；key 形如 SWE / p_118 / brittany_area。',
    searchPlaceholder: '',
    pickHint: '这个颜色在数据里归好几个省份，挑一个当标记',
    colorTip: '显示省份 / 地区自带的颜色',
    borderTip: '给省份区域描边（和「填色·边界」二选一）',
    labelsTip: '在地图上标出地名',
    notInMap: '这块地不在 EU4 的地图范围内。',
  },
  hoi4: {
    id: 'hoi4',
    name: 'HOI4',
    brand: 'HOI', brandSmall: 'IV',
    title: 'HOI4 · 悖论制图',
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
    title: 'EU5 · 悖论制图',
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
    /* 显示名统一为「VIC3」
 *   只改对外显示名，以下字段保持不变：
 *     · `id: 'vic3'` / `game: 'vic3'`（数据 meta、存档键、测试均在用）
 *     · `dir: '/data_vic3'`（缓存目录）
 *     · `saveKey` / `filePrefix`（存档与导出文件名，变更会导致旧存档无法衔接）
 *     · `brand` / `brandSmall`（图形化标识：VIC + 上标 3，不是文字名）
 *   该改动不涉及任何数据 / 存档 / 路径，仅调整显示名。
 */
    name: 'VIC3',
    brand: 'VIC', brandSmall: '3',
    title: '维多利亚3 · 悖论制图',
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

/** 当前是哪个游戏，boot 时按 meta.game 定*/
let GAME = GAMES.ck3;

/**
 * 可选地图。key 为单文件版内嵌数据的键，dir 为走服务时的目录。
 *
 * 仅收录游戏自带地图：创意工坊模组地图未取得作者授权，不进入对外发布的单文件（本地烘焙数据并加回条目即可使用）。
 */
const MAP_CHOICES = [
  { key: 'vanilla', emb: 'vanilla', dir: '/data',        game: 'ck3', label: 'CK3 原版',     note: '9216 × 4608' },
  { key: 'eu4',     emb: 'eu4',     dir: '/data_eu4',    game: 'eu4', label: 'EU4 原版',     note: '5632 × 2048' },
  { key: 'eu5full', emb: 'eu5full', dir: '/data_eu5_full', game: 'eu5', label: 'EU5 原版', note: '16384 × 8192' },
  { key: 'vic3',    emb: 'vic3',    dir: '/data_vic3',   game: 'vic3', label: 'VIC3 原版',  note: '8192 × 3616' },
  { key: 'hoi4',    emb: 'hoi4',    dir: '/data_hoi4',   game: 'hoi4', label: 'HOI4 原版',   note: '5632 × 2048' },
  { key: 'hoi4alt', emb: 'hoi4alt', dir: '/data_hoi4_alt', game: 'hoi4', label: 'HOI4 修改边界', note: '5632 × 2048' },
];

// 层级数由数据 meta.tiers 决定：CK3 为 6 层（1066 与法理五级）。
// EU4/HOI4 为 6~7 层，维多利亚3 为 5 层；层数不得硬编码，boot 时按 meta 填充
// TIER_KEYS 只有 CK3 的 mod 用得到，meta.tiers 里就是那几个字母 + 剧本那一格
let TIER_KEYS = ['e', 'k', 'd', 'c', 'b'];
let TIER_COUNT = TIER_KEYS.length;
let TIER_HOTKEY = ['1', '2', '3', '4', '5'];

/* 悬停链上的小徽章：CK3 为 e_/k_/…，EU4 为 ''/…（空串），boot 时从 meta 读取 */
let TIER_BADGE = ['e_', 'k_', 'd_', 'c_', 'b_'];

/* 工具栏不使用图标（桌面端仅文字，移动端底部固定一支笔图标 + 当前工具名）
 *   emoji 为彩色，与黑白界面冲突；自绘单色 SVG 观感不佳，故不采用图标方案。
 *   后续如需增加图标，桌面端与移动端需同时处理，避免风格割裂。
 */
const TOOLS = [
  { id: 'view', label: '查看', key: 'Q', tip: '' },
  { id: 'pick', label: '吸管', key: 'W', tip: '' },
  // 填色：与涂抹共用同一套范围算法，差别仅在于「按住拖动是否连发」
  // 填色为单次操作（点一次应用一次），涂抹支持按住拖动连续应用。
  { id: 'fill', label: '填色', key: 'F', tip: '' },
  { id: 'paint', label: '涂抹', key: 'E', tip: '' },
  { id: 'erase', label: '橡皮', key: 'R', tip: '' },
  { id: 'rename', label: '改名', key: 'N', tip: '' },
  /* 旗帜（剪贴蒙版） 选中后点击地块：无旗则选图贴上，有旗则选中并弹出悬浮窗
 */
  { id: 'flag', label: '旗帜', key: 'T', tip: '' },
];

const state = {
  meta: null,
  titles: null,
  original: null,
  provinceIds: null,
  titlemap: null,
  provinceNames: null,
  tier: -1,             // boot 时按 meta.defaultTier 定（CK3 是伯爵领、EU4 是省份）
  // 年份视图（1444/1618/1800）下的「粒度」：null = 跟视图走（按国家）
  // 或者填一个下层级序号（地区 / 省份）。只影响边界画在哪一级的接缝上
  // 笔刷作用的地块；地图配色始终为该年归属色，不随笔刷变化。
  grain: null,
  tool: 'paint',
  brush: [200, 50, 50],            // 默认颜色：RGB(200, 50, 50)
  /* 剧本相关的三个开关已移除，名称保留
 *   · showPowerColor：固定开启（剧本颜色始终显示，否则开图为空）
 *   · showPowerBorder：固定关闭（剧本边界不再单独绘制，边界由「势力 · 边界」提供）
 *   上述名称仍被着色器 / 荒地取色 / 分级边界读取，但没有界面入口，不作为可调开关使用。
 */
  showPowerColor: true,       // 固定开 （剧本颜色永远显示）
  showPowerBorder: false,     // 固定关 （剧本边界不再单独画）
  showRegionColor: false,     // 地区（更细的那几层）颜色：默认关，画面干净
  showRegionBorder: true,
  showRegionName: false,
  showParentBorderTitle: false,   // 父级边界：默认关（要用再勾）
  // 二级设置页里的东西（null = 用各游戏/代码里的原值）
  set: {
    /* 背景色与未上色色为两项：
 *   · bg =「背景颜色」（默认 180,180,180），即通常所称「空白地区」
 *   · unpainted =「未上色区域」，仅在显示剧本时用于无主地 未显示剧本时，无主地直接使用 bg（见 gl.js 中 NONE 段）
 */
    bg: null, unpainted: null,
    /* 七行颜色
     *   bg 空白区域 180,180,180 （没开剧本时的默认底）
     *   unpainted 无归属区域 150,150,150 （开着剧本、没归属的地 不进身份标）
     *   其余五行 = `NATURE_RGB` 里那份出厂值 （null = 用出厂）
     *   这是 `state.set` 那份初值；出厂表在下面 `SET_DEFAULTS` 两处一起加*/
    impass: null, sea: null, isea: null, lake: null, river: null,
  /* 线宽默认值统一为 1.0 浓度（pa/ra/ca）默认值不变。
 *   「地方边界宽度」拆为两项：
 *     · wRegion = 「地区边界宽度」，控制父级边界（多级链上层）
 *     · wProv = 「省份边界宽度」，控制子级边界（本层）
 *   两项默认均为 1，与原单值等价，观感不变。
 *   旧键 `w` 保留：旧存档只存该字段，两项均从它继承（见 syncParentBorder）；
 *   删除会导致旧存档的两根滑条回到默认值。
 */
  wRegion: 1, wProv: 1, w: null,
  pa: 50, ra: 75, ca: 100, pw: 1,
  /* 字号拆为两项
 *   · `fontPlace` = 地块名（含海 / 湖 / 河 / 荒地名）
 *   · `fontPower` = 势力名（剧本 / 年份层 + 涂色色块名）
 *   旧键 `font` 保留但不再读取（旧存档只有该字段）；
 *   迁移集中在 `fontSizes()`，不要在各调用处重复处理。
 */
  fontPlace: 1, fontPower: 1,
  // 背景两条线各有一套宽度与浓度，均可调；不提供显示开关。
  //   宽度跟「势力线宽」一个口径（格数 直接就是粗细）；浓度是百分比
  // 水域 / 荒地不使用专属的内部 / 外部宽度与浓度；水域边界走普通头衔管线。
    // 图例
    legend: false, legendTitle: '', legendTitleOnly: false,
    legendPos: 'tl', legendSize: 'm', legendScale: 1, legendFont: '',
    legendCols: 1, legendBg: '#ffffff', legendBgAlpha: 90,
    legendBorder: '#000000', legendFg: '#111111', legendFgAuto: false,
    legendBox: 'square', legendX: 0.04, legendY: 0.04,
  },
  showTitles: true,
  /* 原版边界由「势力/地区 · 边界」每帧计算后写入该值（state 中没有对应字段）。
 * 仅用于没有年代层的旧缓存兜底：默认不绘制原版边界。
 */
  showBorderTitle: false,
  // 地名拆两套：原有地名（头衔/地区名）和玩家地名（手绘色块名），互不影响
  // （不存在独立的「势力名」标注层：其标注点与玩家地名相同，
  // 剧本层国名由「填色 · 名称」统一负责）
  /* 地名默认关
   *   这里只是"还没开图 / 没有年代层"时的初值 开图后由 `applyGameText`
   *     按游戏的默认口径重设 真正生效的源头是 `state.showRegionName`
   *     （每帧 `syncLayerSwitches` 把它抄进 showLabelsTitle）*/
  showLabelsTitle: false,
  showLabelsPaint: false,
  showPaint: true,
  // 水域 / 荒地按普通头衔处理：涂色、悬停走普通路径，没有专属的颜色 / 允许上色 / 自动上色开关。
  // 边界与名称开关见下。
  /* 「水域 · 边界」开关
 *   职责：仅控制水域之间（海洋 / 湖泊 / 河流 / 不可通行海域）的边界；
 *     水陆之间的海岸线不归它管，仍由「地区 / 势力 · 边界」控制。
 *   独立的渲染通道：即使「地区 / 势力 / 填色」三个开关全关，本通道仍生效。
 *   与 `showWaterName` 一样每帧读取；该字段只表示是否勾选，
 *   实际生效还需「这张图能算出水陆」（见 syncLayerSwitches）。
 *   默认关闭：开图时水与水之间不画缝、水名不显示，需要时自行勾选。
 */
  showWaterBorder: false,
  // 「名称」相关的两个开关：水域名称作为界面开关暴露，
  // 荒地名称字段保留但恒为 false（界面无对应勾选）。
  // 默认值均为关闭。
  showWaterName: false,
  /* 「荒地 · 边界」勾选 控制荒地与荒地之间的边界
 *   与「荒地 · 名称」相互独立：前者管缝，后者管名字
 *   默认关闭（与水域相关开关一致）
 */
  showWasteBorder: false,
  showWasteName: false,
  /* 荒地自动上色开关
 *   开：按周边陆地最低地块的显示色加权，严格过半才为该荒地上色
 *   关：全部回退到设置中「不可通行区域」颜色
 *   默认关闭；仅影响自动计算的颜色，玩家直接涂在荒地上的颜色优先
 */
  wasteAuto: false,
  /* 荒地上色的运行时缓存（见 `buildWastePidIndex` / `refreshWasteAuto`）
   *   · wastePidFlag：pid → 是不是荒地（1 = 是）
   *   · wasteFineTid：pid → 它最细层那个 wl_ 节点号（-1 = 不是荒地）
   *   · wastePerim：pid → [[邻居 pid, 共享边像素数], …]（只含陆地，水不算）
   *   · _wastePerimSeq：周长表换了一版就 +1（帧循环靠它重算）*/
  wastePidFlag: null,
  wasteFineTid: null,
  wastePidList: [],
  wastePerim: null,
  _wastePerimSeq: 0,
  _wasteCfgSeq: 0,
  painted: new Set(),          // 涂过的最细层节点集合（`recomputePainted` 从每格反推的缓存）
  brushLabel: '请输入文本',      // 当前画笔的标记：开局不能空
                                // 默认值不得为空串：标注框初始为空时不可用。
                                // 默认值为「请输入文本」（五个字），不得改回空串。
                                // 框里写什么就是什么，不区分“提示字”和“真名字”。
  titleName: new Map(),        // 头衔 → 改过的名字（改名工具写的）
  colorIndex: new Map(),
  labelTint: null,            // 势力名 → 它当前显示的颜色（「势力名取色」按钮给的）
  labelTintByName: null,      // 同上，按名字索引（供标签层使用）；颜色 → 同色的头衔列表（手动输入颜色时消歧义用）
  adjacency: null,             // 省份邻接表（CSR）
  provPos: null,               // 各省质心 + 像素数
  provTitle: null,             // 省份 → 最后涂它的头衔（Int32Array）
  provLabel: null,             // 省份 → 涂它那支笔的标记编号（Int32Array，1 表示未涂）
  labelNames: [],              // 标记编号 → 名字
  labelIds: new Map(),         // 名字 → 标记编号
  paintBlocks: [],             // 手绘层切出的连通色块
  // 图例条目自定义名：色块 key（"r,g,b"）→ 名字；空对象 = 全用地图上现在的名字
  legendNames: {},
  legendOn: {},
  legendOrder: [],
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

/* 拖入的文件按类型分派
 *
 *   地图包不走此路径：`.pdxmap` 只在选图页导入，拖到地图上不导入，但会提示导入位置。
 *
 *   `fontDropHandler` 由 `bindFontPicker` 赋值（需要闭包内的刷新逻辑）。
 */
let fontDropHandler = null;
let blocksDirty = true;     // 涂色后标脏，下一帧重算连通色'
let NO_TITLE = 65535;
let panning = null;
let painting = false;

// ================================================================ 小工具

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hex2 = (n) => n.toString(16).padStart(2, '0');
const rgbToHex = (c) => '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
const sameColor = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
/* 数组是否包含该项；仅用于冷路径（启动、构建索引）。 */
const hasIn = (arr, v) => !!arr && arr.indexOf(v) >= 0;

function hexToRgb(s) {
  if (typeof s !== 'string') return null;      // 空输入 / 非字符串：避免 trim 抛错
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---------------------------------------------------------------- 快查表
//
// 底下几张表全是同一件事：把"每次都要 indexOf 扫一遍"的成员判断
// 换成建一次就 O(1) 的查表
//
// 数据规模：荒地（EU5 1819 块）、无男爵领（CK3 上万块），因此这些名单用查表而非数组遍历。
//   `(state.meta.wasteland || []).indexOf(tid) >= 0`
// 它散落在悬停、取色、涂色、锁判定、荒地那一趟、显示色里头
// 全在"鼠标一动 / 每帧 / 每格"的路径上
// 而 indexOf 是线性扫：1819 项的名单 × 每帧几万次调用 = 白烧的几毫秒
// （EU5 那 1818 块荒地正是这么撞上来的）
//
// 名字统一带个 W，跟 state.meta.wasteland 那份原始数组区分开：
// 原始数组照旧留着（烘数据的字段、导出、测试都在看它）
// 这里只是给它配一张查表

/** 键是不是以某个前缀开头（null 安全）*/
const keyStarts = (key, prefix) => String(key == null ? '' : key).indexOf(prefix) === 0;

/**
 * 「不可通行海域」的判据（如 CK3 的 `#impassable_sea`）：它属于水域，按海域处理。
 *
 * isLocked / 悬停 / 高亮三处各判一次且写法相同，故集中于此。
 */
const isImpassSeaKey = (key) => {
  const s = String(key == null ? '' : key);
  return s.indexOf('#impassable') === 0 && s.indexOf('sea') >= 0;
};

/**
 * 「该格的键是否表示水域」：海 / 湖 / 河，以及 CK3 的「不可通行海域」。
 *
 * 该判据在项目中出现四次（悬停卡片 / 侧栏 / 高亮 / 名字过滤），均需对四个前缀逐个 startsWith，故收于一处；新增水域类型（如运河）时只改此处。
 */
const isWaterKey = (key) => {
  const s = String(key == null ? '' : key);
  return isImpassSeaKey(s)
    || s.indexOf('#sea') === 0 || s.indexOf('#lake') === 0 || s.indexOf('#river') === 0;
};

/**
 * 这一格是不是水：按 pid 查「水域标签」
 *
 *   水域不再有伪头衔（`#sea_e_0` 一类已删除），因此不能按键名前缀识别；
 *   统一在此处取 pid，到 `meta.waterMask` 中查对应位。
 *
 *   这是水域的唯一判据来源：颜色 / 边界 / 高亮都应调用它，
 *   不要各自 `startsWith('#sea')`（新包中该写法恒为 false）。
 *   旧包没有 `waterMask`，函数返回 false，调用方需退回 `isWaterKey(键)`
 *   （见 `isWaterHere`）。
 *   pid 无效（0 / NO_TITLE）返回 false。
 */
function isWaterPid(pid) {
  const wm = state.waterMask;
  if (!wm || pid == null) return false;
  const p = pid | 0;
  return p > 0 && p < wm.length && wm[p] !== 0;
}

/**
 * 该格是否为水：新包查表，老包退回键名前缀（两套判据集中于此）。
 *
 * 顺序：先查表（新包唯一正确判据），表无记录再看键（老包）。
 * 键也需判断：新包中荒地仍有伪头衔（`#impassable_c_3`），而 `isWaterKey` 会把 `#impassable_sea` 认作水域；此类键在新包中已不存在，保留仅为兼容老包。
 */
function isWaterHere(pid, tid) {
  if (isWaterPid(pid)) return true;
  const T = state.titles || {};
  const k = (tid == null) ? '' : String((T.keys && T.keys[tid]) || '');
  return isWaterKey(k);
}

/**
 * 键是否为「每层一片」结构的伪头衔片（`#sea_pr_57` / `#impassable_c_3` 这类）
 *
 *   海 / 湖 / 河 / 荒地每一层各有节点；一层的「片」= 该层同名地块的集合
 *   （见 build_tier_pieces.tier_pieces）。前端只认当前层的 tid：名字、边界、高亮均按层取。
 *
 *   `wl_<地块号>` 不算：它是荒地最细层逐块节点，名字走 `meta.wastelandNames`
 *   （CK3 的节点名只是类名「不可通行山地」，当作具体名会多出悬停第二行）。
 *
 *   旧数据包（生成时每层一片结构尚未引入）里全世界海共用一个 `#sea`，此处返回 false，
 *   那批包退回真名表（见 specificPlaceName / buildSeaLabelPoints）。
 */
const PIECE_KEY_RE = /^#[a-z_]+_[a-z]+_\d+$/;
const isTierPieceKey = (key) => PIECE_KEY_RE.test(String(key == null ? '' : key));

/**
 * 伪头衔的类名：构建期取不到真名时的占位
 *   （来源为 build_tier_pieces 里 `tier_pieces(..., label)` 的 label，
 *     海 / 湖 / 河 / 不可通行 / 荒地各一个）
 *
 *   类名不算具体名：地图标注与悬停第二行都不得出现
 *     取不到真名的水域视为无名，不得显示「海洋」等类别名
 *     CK3 的荒地不得以「不可通行山地」充当悬停第二行
 *     （实测 TOT 的 rg 层会多出一个 212011 像素的「海洋」标，该片在水名表中本就没有名字）
 */
const PSEUDO_CATEGORY_NAMES = new Set([
  /* 名单与五个构建脚本的类别表一致（"#xxx" 那几行） CK3：河流 / 湖泊 / 海洋 / 不可通行海域 / 不可通行山地 / 无归属荒地
 *   EU4：湖泊 / 海洋 / 不可通行荒地 · HOI4：湖泊 / 海洋
 *   VIC3：湖泊 / 海洋 / 不可通行 · EU5：湖泊 / 不可通行
 *   构建脚本新增类别名时需同步补充；漏一个就会有整片区域顶着类名出标。
 */
  '海洋', '湖泊', '河流', '不可通行', '不可通行海域', '不可通行山地',
  '不可通行区域', '不可通行荒地', '无归属荒地',
]);
const isPseudoCategoryName = (nm) => PSEUDO_CATEGORY_NAMES.has(String(nm == null ? '' : nm));

/** 重新给 meta 里那几张名单建快查表（boot 时调一次；meta 不变就一直是它）*/
function buildMetaIndex() {
  const m = state.meta;
  if (!m) return;
  m.wastelandSet = new Set(m.wasteland || []);
  m.degradedSet = new Set(m.degradedBaronies || []);
}

/* 该地块的最细层节点是否为荒地（查表；meta 未建表时退回数组扫描） */
function isWastelandTid(tid) {
  if (tid == null || tid === NO_TITLE) return false;
  const s = state.meta && state.meta.wastelandSet;
  return s ? s.has(tid) : hasIn(state.meta && state.meta.wasteland, tid);
}

/**
 * 该头衔是否为荒地或水域的伪头衔，返回 'waste' / 'water' / null
 *
 *   判据必须包含键名前缀：只按 isWastelandTid 判会漏。
 *   `meta.wasteland` 存的是最细层节点 id，而标签按当前视图层取；
 *   在「地区」层查看时 tid 是地区层节点，查名单必然不在，荒地名仍会绘出。
 *   因此键名（wl_ / #impassable）与 isWastelandTid 两个都要看，
 *   与势力名过滤（drawLabels 外那处）保持同一口径。
 */
function isWasteOrWaterTid(tid) {
  if (tid == null || tid === NO_TITLE) return null;
  const k = String((state.titles && state.titles.keys && state.titles.keys[tid]) || '');
  if (isWaterKey(k)) return 'water';
  if (isWastelandTid(tid) || keyStarts(k, 'wl_') || keyStarts(k, '#impassable')) return 'waste';
  return null;
}

/**
 * 是否为这类伪头衔标注名字（荒地 / 水域的统一规则）
 *
 *    · CK3 一律不标
 *
 *    · CK2 标
 *      依据（均为游戏数据事实）：
 *        ① CK2 的 ``default.map`` 中 ``sea_zones`` / ``major_rivers`` 同样只有地块号，
 *           不存在「每片海叫什么」这一级，与 CK3 相同；
 *           但 CK3 那条「没有真名就一个都不标」只适用于 CK3，不是 P 社游戏通例。
 *        ② 编辑器侧有内容可标：每片水 / 荒地都有节点（``#sea_e_3`` / ``wl_<pid>``，
 *           名字为 ``#<地块号>`` 占位），前端会把占位换成类别名（海洋 / 河流 / 无归属荒地，
 *           见 ``isPseudoCategoryName``），与 EU4/EU5/HOI4/VIC3 一致。
 *      如需改为「与 EU4 一样听开关」：删掉下方 CK2 那一行即可，
 *      此时走开关，两个开关出厂值为 false，地图上不标注。
 *
 *    · 其他游戏看各自的「名称」开关
 */
function pseudoNameAllowed(kind) {
  if (!kind) return true;
  const _g = String((state.meta && state.meta.game) || '');
  if (_g === 'ck3') return false;
  if (_g === 'ck2') return true;          // CK2 独立口径：水与荒地照常标名
  if (kind === 'water') return !!state.showWaterName;
  return !!state.showWasteName;
}

/** 所有前缀命中的头衔序号（`#sea` → 每一层的每一片）
 *  建"伪头衔标签位置"那类要把整类捞全的地方用*/
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
 * 浮条（toast）整体关闭
 *
 * 采用整开关而非逐条删除：二十余条文案保留，需要时改一个 false 即可恢复或改词。
 *
 * 异常不静默：控制台保留一行输出，界面保持干净，排查问题时仍可从控制台取得原因。
 */
const TOAST_OFF = true;

let toastTimer = 0;
function toast(msg, isErr = false) {
  if (isErr) console.warn('[提示] ' + msg);
  if (TOAST_OFF) return;                      // 开关关着 → 什么都不显示
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
  // 分块（EU5 原尺寸）：真数据在块里，整图 id 只是个占位
  if (state.tileMap) {
    if (state.tileMap.has(x, y)) return state.tileMap.at(x, y);
    state.tileMap.get(Math.floor(y / state.tiles.tileH),
                      Math.floor(x / state.tiles.tileW)).catch(() => {});
    return 0;                       // 这一块还没到，先当空；下一帧就正常
  }
  return state.provinceIds ? state.provinceIds[y * meta.mapWidth + x] : 0;
}

/**
 * 取 `(pid, tier)` 那一格的归属，越界一律返回 NO_TITLE
 *
 *   该函数在全图扫 / 悬停 / 标签中被调用数千至数万次，边界判断开销可忽略；
 *   可避免「数据未齐 / 层数不符 / 地块号越界」时整个功能抛 TypeError
 *   （直接取 `state.titlemap[tier * n + pid]` 会越界读到相邻层的值，归属静默出错）。
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

/**
 * 该格在「最细层」的头衔号
 *
 *   用途：荒地名按最细层分组（所有荒地按最细层级分组）。
 *
 *   荒地需单独取层：粗层不切分荒地。
 *     EU5 实测：8 块亚马逊荒地在 `1337 / blank / reg / area / prov` 五层上
 *     是同一个伪头衔（键 `#impassable` · tid 36188），
 *     只有最细的 `loc` 层分成 8 个（`amazon_jungle` / `madeira_amazon_jungle` 等）；
 *     按当前层分组时 8 个地点会并成一个标。
 *
 *   层数读 `meta.tiers.length`，不得读 `TIER_COUNT`
 *     （该模块变量初值为 5，boot 靠后才更新为真值）。
 *   越界 / 取不到时回落到「当前层」，避免旧包 / 数据不全时整片无标。
 *
 *   @param {number} pid
 *   @param {number} fallbackTier 取不到最细层时使用的层号
 *   @returns {number} 头衔号（可能为 `NO_TITLE`）
 */
function titleAtFinest(pid, fallbackTier) {
  const nt = (state.meta && Array.isArray(state.meta.tiers)) ? state.meta.tiers.length : 0;
  if (!nt) return titleAt(pid, fallbackTier | 0);
  const t = titleAt(pid, nt - 1);
  if (t == null || t < 0 || t === NO_TITLE) return titleAt(pid, fallbackTier | 0);
  return t;
}

/**
 * 「隐藏标签」的头衔集合
 *
 *   规则：属于水域的地块若像素同时位于地图左右两侧，
 *         其名字及包含它的上层水域名字都不显示。
 *   原因：EU5 未按日期变更线切分，部分地块横跨整幅地图，
 *         名字中心会落到地图正中，与所属水域无关。
 *
 *   判据只扫左右两列，不看「该头衔像素 x 范围是否为 0~W-1」：
 *     横跨地块在光栅上的直接表现就是左列与右列都含它；
 *     x 范围是间接指标，其他块占满两端时也会命中。
 *     EU5 实测：夏威夷诸块 + 白令的 `inchoun_coast` / `kialegak_cape`。
 *     成本：两列 × 图高约 8000 次读取，一次计算，换图才重算。
 *
 *   「含它的上层」：取横跨地的 pid，收集其每一层的头衔
 *     上级片的像素是子片的并集，从最细层向粗层收一遍即可。
 *     集合中既有横跨地块，也有其所有上级水域。
 *   收集所有头衔（不分水域 / 陆地），调用方按需取用。
 *
 *   仅在能算出像素图时计算（分块模式下 `provinceIds` 是占位数组）；
 *   算不出时为空集，不隐藏任何名字。
 *
 *   @returns {Set<number>} 需要隐藏名字的头衔号
 */
function buildCrossSeamTids() {
  const out = new Set();
  const meta = state.meta, tm = state.titlemap, ids = state.provinceIds;
  const W = (meta && meta.mapWidth) | 0, H = (meta && meta.mapHeight) | 0;
  const nT = (meta && Array.isArray(meta.tiers)) ? meta.tiers.length : 0;
  if (!meta || !tm || !nT || !(W > 1) || !(H > 0)) return out;
  /* 分块模式：`provinceIds` 是个占位（长度 1）→ 认不出，直接返回空*/
  if (!ids || ids.length < W * H) return out;

  /* ① 左右两列都出现过的地块 = 横跨 （一次扫两列）*/
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

  /* ② 横跨地 每一层的头衔全收进来 （`titlemap` 排布 = tid * numProvinces + pid）*/
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
    nameEn: t.namesEn ? t.namesEn[tid] : '',   // 中文名下方显示原名，悬停时可见
    color: t.colors[tid],
  };
}

function isChanged(tid) {
  return state.changed.has(tid);
}

// ================================================================ 颜色

/**
 * 切换画笔颜色
 *
 * `fromPick = true` 表示本次为取色（搜索中点色块 / 右键 / 吸管 / 调色板），
 * 此时同时切到画图工具；其余情况（初始化、手动输色、程序设色）只换颜色，不动工具。
 *
 * 切到哪个工具由设置决定（设置页「取色后切到」：涂抹 / 填色，默认涂抹）；
 * 已处于画图工具（涂抹 / 填色）时不切换，避免填色过程中取色被切到涂抹。
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

/**
 * 「标记留空」时写入 labelNames 的占位符（零宽，永不显示）。
 *
 *  · 含占位符 = 该格明确无名字（玩家清空标记框后涂色）
 *  · `provLabel === -1` = 该标记位从未被修改
 * 两者在数据上须区分：「仅上色空标记才补名」与改名工具选择目标均依赖它。
 */
const LABEL_BLANK = '\u2060';
const isBlankLabel = (nm) => String(nm == null ? '' : nm) === LABEL_BLANK;

/** 设定画笔的标记（涂色时写进手绘层，色块上标的就是它）*/
function setBrushLabel(name) {
  state.brushLabel = name || '';
  $('brush-label').value = state.brushLabel;
}

/** 原始色 → 同色头衔列表，手动输入颜色时要靠它消歧义*/
function buildColorIndex() {
  state.colorIndex = new Map();
  state.tagColorIndex = new Map();     // 颜色 → tag（含没地盘的）
  const t = state.titles;
  // 剧本层数：有剧本层的模式（现在每一套都有 见 build_data 的 eraDates 那段）
  // 只把剧本层那些头衔（国家 / 1066 政权）收进"颜色 → 头衔"表
  // 地区层（帝国/王国/…）的颜色在取色时无匹配意义（大量同色杂项）
  const _nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  for (let i = 0; i < t.keys.length; i++) {
    if (t.tiers[i] >= TIER_COUNT) continue;       // 海/湖/荒地那些伪头衔：不算
    if (_nEra > 0 && t.tiers[i] >= _nEra) continue;
    const o = t.colors[i];
    const key = (o[0] << 16) | (o[1] << 8) | o[2];
    let list = state.colorIndex.get(key);
    if (!list) { list = []; state.colorIndex.set(key, list); }
    list.push(i);
  }
  // 全部 tag 的颜色也进来（没地盘的 tag 颜色照样能用）
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
    // 取色不改变标记
    return;
  }
  if (list.length === 1) {
    box.hidden = true;
    // 取色不改标记
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
  // 仅确定「这一笔的名称」；不跳转镜头、不选中地块（后者属于搜索定位流程）。
  // 取色不改标记
}

/** 手动改颜色：设色 + 重新定标记*/
function onManualColor(rgb) {
  setBrush(rgb);
  labelForColor(rgb);
}

/**
 * 搜索结果色点的颜色
 *
 * 与画面一致：涂过的显示涂色，未涂的显示数据色
 * （直接取 `titles.colors[tid]` 得到的是数据色，涂色后不会更新）。
 *
 * 一个头衔名下可能有多块涂色（1936 那半壁法国），取第一块涂过的作为代表。
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
 * 按名字查该名称对应的手绘颜色
 *
 *   国家行（按 tag 搜索）只持有 tag 与名字，没有地块编号；
 *   手绘层按「标记名」记录（`labelNames[provLabel[q]]`），
 *   用名字直接比对即可判断是否涂过色，无需地块编号。
 *
 *   未涂色返回 null（调用方退回数据色）。
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

/**
 * 只记录颜色，不记录标记（节约存储）
 *   项为 { rgb }；点击该颜色只改颜色，不恢复标记名
 *   旧存档中多出的 label 字段忽略即可，无需迁移
 *   （读入 { rgb, label } 对象同样可用，只读 .rgb）
 */
function pushRecent(rgb) {
  const key = rgb.join(',');
  const entry = { rgb: rgb.slice() };
  state.recent = state.recent.filter((c) => c.rgb.join(',') !== key);
  state.recent.unshift(entry);
  if (state.recent.length > 24) state.recent.length = 24;
  renderPalette();
}

/**
 * 清空「最近用过」的颜色
 *   该记录随设置持久化，清空后必须落盘；只清内存时刷新会恢复。
 */
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
    /* 仅设置颜色，不修改标记，与 pushRecent 中保存的内容一致。 */
    chip.onclick = () => { setBrush(e.rgb, false, true); };
    /* 右键 = 从「最近使用」里删掉这一个*/
    chip.oncontextmenu = (ev) => {
      ev.preventDefault();
      removeRecent(e.rgb);
    };
    box.appendChild(chip);
  }
}

/* 删除「最近使用」中的某一项（右键圆圈）；与 clearRecent 使用同一落盘路径。 */
function removeRecent(rgb) {
  const key = rgb.join(',');
  state.recent = state.recent.filter((c) => c.rgb.join(',') !== key);
  renderPalette();
  saveMapPrefs();
}

/**
 * 头衔在当前层写入 GPU LUT 的颜色。
 *
 * LUT 存「当前层应显示的颜色」，与「头衔颜色」不同：`state.titles.colors` 记录玩家修改过的颜色（导出、悬停卡片、取色均使用）；关闭「填色 · 颜色」时必须露出游戏原色，否则玩家的填色无法隐藏（LUT 中修改过的颜色仍然生效）。
 */
function lutColorOf(tid) {
  return state.titles.colors[tid];     // 原色取数据中的值
}

/**
 * 荒地「未上色」外观使用的灰色（与渲染器的 uWasteGrey 一致）
 *
 * 不直接使用 titles.colors[tid]：EU5 的荒地节点在数据中是给省份位图用的技术色，
 * 1819 块里有 1818 块颜色各异，同一片「代赫纳沙漠」的两块颜色都不同，不应按它显示。
 * CK3/EU4 的数据本身即为该灰色，两端行为一致。
 * 该灰色当前仅作为 LUT 的起手色。
 */
function wasteGrey() {
  /* 读取设置中的该项
 *   「不可通行区域」出厂值 94,94,94（与数据中 wl 节点一致，不改动时观感一致）
 *   修改设置后 `applySettings` / `applyNatureColors` 会重刷这几类
 */
  return natureColor('impass');
}












/** 把每块荒地的 LUT 刷成"荒地灰"（= 它没上色的样子）*/
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

/* 荒地自动上色
 *
 * 规则：
 *   ① 检查每块荒地周边所有陆地最低地块（EU4 为 province，CK3 为男爵领级）
 *   ② 每个邻居按优先级取色：
 *        · 剧本视图：玩家涂色 → 当前剧本色（不看地区色）
 *        · 非剧本视图：玩家涂色 → 当前视图上该地块所属头衔的颜色
 *   ③ 按共享边长加权，某颜色严格过半才赋给该荒地
 *   ④ 不过半 / 无可用颜色（开关全关）时回退设置中「不可通行区域」颜色
 *   ⑤ 玩家直接涂在荒地上的颜色优先显示
 *   ⑥ 其他荒地按已算出的颜色投票，逐圈传染至稳定
 *
 * 实现要点：
 *   · 颜色写在每块荒地自己最细层节点（`wl_<pid>`）的 LUT 上；
 *     粗层荒地块由同名几块共用，写入会互相覆盖
 *   · 着色器按 `uFineTier` 读取（见 gl.js 的 colorOfPid）
 *   · 周长表 = pid → [[邻居, 共享边像素数]]，不计水；无现成表时在开图时
 *     从省份 id 图扫描一遍（CK3 42M 像素实测 0.08s）
 *   · 每秒重算不读 LUT：用上一轮的独立快照做传染，避免自环
 */

/** 建立"哪些 pid 是荒地"的快查表。返回荒地块数。*/
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

/** 这个 pid 是不是水（周长只统计陆地）*/
function _wasteIsWaterPid(pid) {
  const wm = state.waterKindArr;
  if (wm && pid < wm.length) return wm[pid] !== 0;
  return isWaterPid(pid);
}

/** 往周长累加器里记一条"两侧地块之间的边"。两个方向各记一次。*/
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

/** Map<pid, Map<nb, 边数>> → Map<pid, [[nb, 边数], …]>（边多的排前面）*/
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

/** 从完整的省份 id 图扫出荒地周长（4 邻接，水边不算）*/
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

/** 没有像素图时的退路：邻接表，每条边先按 1 计（分块图等真周长算完会替换）*/
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
 * 一次只留两行块（4×2 块 ≈ 134 MB 解压态），取完就放
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
    // 避让：不要阻塞主线程数百毫秒
    await new Promise((res) => setTimeout(res, 0));
  }
  return _wasteFinishPerimeter(acc);
}

/** 开图时把周长表准备好（有像素图立刻算；分块图先给近似，后台再算精确）*/
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

  // ② 有整张 id 图：直接扫描（CK3 42M 像素实测 0.08s）
  if (ids && W > 0 && H > 0 && ids.length >= W * H) {
    state.wastePerim = buildWastePerimeterFromIds(ids, W, H);
    return state.wastePerim.size;
  }

  // ③ 分块图：先按邻接表给个近似，开图后再后台算精确的
  state.wastePerim = buildWastePerimeterFromAdjacency();
  if (state.tileMap && state.tiles) scheduleTileWastePerimeter();
  return state.wastePerim.size;
}

/** 分块图的精确周长放到后台算，算完替换近似表并重算颜色*/
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

/* 一个邻居地块按规则应有的颜色（null = 该票无颜色） */
function wasteVoteColor(nb, prevAuto, isEra, regionTier) {
  const pd = renderer && renderer.paintData;
  // ① 玩家涂色（「填色 · 颜色」开着才算）
  if (state.showPaint && pd && nb > 0 && pd[nb * 4 + 3] > 0) {
    return [pd[nb * 4], pd[nb * 4 + 1], pd[nb * 4 + 2]];
  }
  const nReal = (state.meta && state.meta.numRealTitles != null)
    ? state.meta.numRealTitles : null;
  /* 老包没有 `numRealTitles` 时，至少把荒地伪头衔挡掉
   *   不然粗层那片荒地会拿自己的类色来投票，把自动色盖成灰*/
  const realTid = (t) => (t != null && t !== NO_TITLE
    && (nReal != null ? t < nReal : !isWastelandTid(t)));
  // ② 剧本视图：当前剧本有归属 → 剧本色（「势力 · 颜色」开着才算）
  if (isEra && state.showPowerColor) {
    const t = titleAt(nb, state.tier);
    if (realTid(t)) return state.titles.colors[t];
  }
  /* ③ 地区颜色（「地区 · 颜色」开着才算）
   *   剧本模式开启时不再检查地区颜色
   *     → 剧本视图里只认：玩家涂色 → 当前剧本色 → 其他荒地的传染色
   *       剧本没归属的邻居不拿地区色来凑（只进分母）
   *   → 非剧本视图里仍旧看当前视图层*/
  if (!isEra && state.showRegionColor) {
    const t = titleAt(nb, regionTier);
    if (realTid(t)) return state.titles.colors[t];
  }
  /* ④ 邻居同为荒地：使用上一轮确实算出颜色的结果（逐圈传染）。
 *   回退灰不计票，仅计入分母；若回退灰也投票，连片荒地会互相阻塞，颜色无法传入。
 */
  if (state.wasteAuto && state.wastePidFlag && state.wastePidFlag[nb]) {
    const c = prevAuto.get(nb);
    if (c) return c;
  }
  return null;
}

/** 重算所有荒地的自动色，写进它们最细层节点的 LUT。返回真正变了的块数。*/
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
  /* 地区颜色只在非剧本视图里用
   *   → 这里就是当前视图层；粒度不再影响荒地取色*/
  let regionTier = state.tier;
  // 开图早期 `state.tier` 可能仍为 -1：不得用它索引归属表，回落最细层
  if (!(regionTier >= 0 && regionTier < nTier)) regionTier = Math.max(0, nTier - 1);

  /* 固定点迭代：每一圈都拿上一圈的快照投票，避免遍历顺序影响结果。
   * 每圈最多往外传一环 荒地链条可能很长（CK3 的山脉一串几十块）→ 上限给 32
   * 真不收敛（两块互相投）就停在最后一圈 正常情况几圈就稳定*/
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
      // null = 没算出颜色（最终写回灰，但不参与下一轮投票）
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

/** 帧循环里比对签名：层 / 粒度 / 三个颜色开关 / 开关 / 涂色 / 设置色 变了就重算*/
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

/** 切「填色·颜色」：LUT 里永远是游戏原色，所以这里只要重画一帧*/
// ---------------------------------------------------------------- 设置页
/** 设置页的出厂值（点「恢复默认」就回到这里）*/
const SET_DEFAULTS = {
  /* 背景色 / 未上色色：两项分开 bg        = 「背景颜色」默认 180,180,180
 *   unpainted = 「未上色区域」默认 150,150,150（中性灰）
 */
  bg: null, unpainted: null,
  /* 七行颜色：空白区域 / 无归属区域 + 海 / 不可通行海域 / 湖 / 河 / 不可通行
 *   null = 用 `NATURE_RGB`（前三行另在 `_now()` 里给了 180 / 150）
 */
  impass: null, sea: null, isea: null, lake: null, river: null,
  // 线宽五档 / 浓度四档（默认都取标准那一档，见 W_STEPS / PW_STEPS / CONC_STEPS）
  /* 宽度默认一律 1.0 浓度（pa/ra/ca）不变；宽度统一为 1.0。
 * 「地方边界宽度」拆成两条：
 *   · wRegion = 「地区边界宽度」，管父级边界（多级链上层那些线）
 *   · wProv   = 「省份边界宽度」，管子级边界（本层那条线）
 *   两者默认均为 1，与单条设置相等，观感不变。
 *   旧设置键 `w` 保留：旧存档只有它，两条宽度均从它继承（见 syncParentBorder）；
 *   删除后旧存档的这两根滑条会回到默认值。
 */
  wRegion: 1, wProv: 1, w: null,
  pa: 50, ra: 75, ca: 100, pw: 1,
  /* 字号拆成两块：
 *   · `fontPlace` = 地块名（含海 / 湖 / 河 / 荒地名）
 *   · `fontPower` = 势力名（剧本 / 年份那几层 + 涂出来的色块名）
 *   旧的 `font` 保留但不再读取（旧存档只有它）
 *   迁移集中在 `fontSizes()` 一处，不在各处重复实现
 */
  fontPlace: 1, fontPower: 1,
  /* 导入的字体：存的是族名（PDX-Font-xxx） 空串 = 用默认栈；库里的字体被删掉时，此处留着的族名匹配不上，
 *   开机时自动退回默认（见 bindFontPicker）
 */
  fontFacePlace: '', fontFacePower: '',
  /* 水域边界那一对
 *   不沿用省份 / 地区那一档
 *   宽度 1（六档表里那一档，与其他档位同一口径）
 *   不透明度默认 25%
 *   与「默认关闭水域边界」配合：该档默认是很淡的辅助线，
 *   界面勾选后可见，但不抢占视觉
 *   荒地那一对（wasteW / wasteA）不恢复：只点名了水域，
 *   荒地仍然没有专属边界（见 check_wiring 的退役名单）
 */
  waterW: 1, waterA: 25,
  /* 荒地边界那一对
 *   宽度与水域那对一致，为 1
 *   不透明度默认 100%（实心）
 *   与水域那条出厂值不同：水域 25%（很淡的辅助线），荒地 100%（实心），不可改成一致
 *   两者仍为独立一档，不沿用省份 / 地区那一档
 */
  wasteW: 1, wasteA: 100,
  // 背景那两条线各有一套宽度 + 浓度（可调；显示开关已去掉）
  //   宽度跟「势力线宽」一个口径（格数 直接就是粗细）；浓度是百分比
  // （水域 / 荒地的专属宽浓出厂值已随开关一起退役，水走普通头衔边界）
  // 名字显示上限：按连通域面积从大到小取前 N 个
  // 自从"一个连通域一个名字"之后，全图能有几千坨（EU4 的 1444 有 1863 坨）
  // 标签层每帧遍历，故设上限防卡顿；数量范围 1~20。
  // 滑杆最右那一格（21）= 无上限（省掉单独的勾选框）
  //
  // 默认值不可压得过低（否则国名大量不显示）：
  // 真正决定「画面上能看见几个」的是字号门槛（√面积 × 缩放 × 0.18 ≥ 4px），
  // 全图视图下 EU4 只放行 62 个、EU5 42 个
  // 默认若为 12，会把门槛放出来的那些再砍掉一半，看起来「到处都没名字」
  // 默认 12：每个国家最多留 12 个名字（本土 + 11 块殖民地）
  labelMax: 12,
  /* 地名上限：与「势力名称上限」同一套档位
 *   （1~21，`21` = 无上限，默认 12），也是按组各留 N 个：
 *   势力的「一组」是一个国家；地名的「一组」是一个头衔 设此上限的原因：地名改为「每个连通域一个标」之后，
 *   一个头衔底下可能有很多碎块（CK3 的飞地 / EU4 的岛群 / 群岛伯爵领）；
 *   不封顶时细层会碎成一片
 */
  /* 地名上限
 *   （1~21，`21` = 无上限）
 *   默认从 12 改为 1：每个头衔 / 连通域只留最大的那一个标，想多显示可自行拉高
 *   `placeCapV1` 是一次性迁移标记：旧存档里仍为旧默认 12 的迁到 1，
 *   之后自行改过的值不再被覆盖
 */
  labelPlaceMax: 1,
  placeCapV1: 1,
  /* 两种名称的不透明度（%）：势力名称 = 剧本 / 年份层，地名 = 地区 / 省份 / 地点层。
 *   界面称「势力名称」；其覆盖剧本 / 年份层的势力名，称「国名」会缩小范围。
 *   变量名 labelAC / alphaCountry 为历史命名，保持不变（改动面过大）。
 *   半透明可保留下方填色与边界（档位：25 / 50 / 75 / 100）。
 */
  labelAC: 50,
  labelAP: 50,
  /* P 社式排版 国名 / 大地名贴着版图排（在版图里找基线 → 逐字弯曲，见 maplabels.js）
 *   `both` = 国名 + 地名 / `power` = 只排国名 / `off` = 横排
 *   旧存档没有这个键，取 `both`（新功能默认开启）
 */
  mapNameFit: 'both',
  // 排版调试：把基线 / 字框 / 包围盒 / 质心画出来（默认关）
  mapNameDebug: false,
  // 取完色切到哪个画图工具（涂抹 / 填色，可在设置里选）
  pickTool: 'paint',
  /* 涂色限制 `both`  = 上色 + 标记（颜色和标记名一起写）
 *   `color` = 仅上色：只改颜色，不改动已有标记（画笔框里的「标记」不生效）
 *   仅作用于「上色」；擦除仍四样一起清（否则标记会留在没有颜色的地上）
 */
  paintLimit: 'both',
  /* 跨剧本搜国家开启后，搜索框除当前地图外，还会按 TAG / 国名检索本机其他剧本（其他游戏地图）的 countryTags。
 *   仅搜国家（tag），不跨剧本搜地区 / 省份：地区划分因图而异。
 *   默认关闭，保持与原有搜索结果一致。
 */
  searchCross: false,
  // 图例（预览 + 导出共用同一套排版）
  legend: false, legendTitle: '', legendTitleOnly: false,
  legendPos: 'tl', legendSize: 'm', legendScale: 1, legendFont: '',
  legendCols: 1, legendBg: '#ffffff', legendBgAlpha: 90,
  legendBorder: '#000000', legendFg: '#111111', legendFgAuto: false,
  legendBox: 'square', legendX: 0.04, legendY: 0.04,
};

/**
 * 两块字号的唯一取值入口。
 *
 *   字号拆为「地块 / 势力」后，旧存档只有一个数字，需同时用于两块（否则旧存档升级后或归 1，或其中一块被丢弃）。
 *   迁移只写此处，不在「读设置 / 存设置 / 刷界面」各写一遍，避免三处口径不一致。
 *
 *   按顺序识别三种形状：
 *     ① 新格式 `s.fontPlace` / `s.fontPower`（各自生效）
 *     ② 旧格式 `s.font`（一个数字，两块共用，即迁移）
 *     ③ 均无 → 1；返回值必为两个数（调用方无需判 null）
 *   @returns {{place: number, power: number}}
 */
function fontSizes(s) {
  const _one = (v) => ((typeof v === 'number' && isFinite(v) && v > 0) ? v : null);
  const legacy = _one(s && s.font);
  const place = _one(s && s.fontPlace);
  const power = _one(s && s.fontPower);
  const fallback = legacy != null ? legacy : 1;
  return { place: place != null ? place : fallback, power: power != null ? power : fallback };
}

/**
 * 滑杆拉到满 = 无上限 该数必须与 `index.html` 那根 range 的 `max` 一致（测试中有断言校验）
 */
const LABEL_MAX_UNLIMITED = 21;

/* 线宽五档 / 浓度四档：档位较少，用下拉「选一档」比滑杆连续拖动更明确。
 *   这两张表须与 `index.html` 中五个 `<select>` 的 `value` 一致（测试中有断言校验）。
 *   浓度四档：25% / 50% / 75% / 100%。
 */
/* 0.5 这一档用于「看细节时不想被线压住」的场合 因此线宽从 1 起改为六档
 */
const W_STEPS = [0.5, 1, 1.5, 2, 2.5, 3];    // 地方边界宽度六档（默认 1）
const PW_STEPS = [0.5, 1, 1.5, 2, 2.5, 3];    // 势力边界宽度六档（该值即线粗，不是倍率）默认 1
/* 0% 这一档：那条线完全不画 等于单独关掉这一种边界而保留其余设置
 */
const CONC_STEPS = [0, 25, 50, 75, 100];      // 边界浓度五档

/**
 * 设置里某个数值项的唯一读取方式
 *
 *   原先各处重复写 `(state.set && state.set.xxx != null) ? Number(...) : 默认值`，
 *   全仓库十几份，`pa` 那种还要再包一层除法；
 *   某处漏判 `state.set` 即为 TypeError，
 *   旧存档存成字符串 / NaN 时各处回退口径也不一致。
 *
 *   @param {string} key  `state.set` 里的键
 *   @param {number|null} def 缺省值（原样返回，包括 null）
 *   @returns {number|null} 非有限数一律回退到 `def`
 */
function setNum(key, def) {
  const s = state.set;
  const v = s ? s[key] : null;
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * 把数值吸附到最近的档位。
 *   旧存档保存的是滑杆时代的连续值（如 `w: 1.7`），下拉中无对应项会显示空白，吸附后可正常显示。
 */
function snapStep(v, steps) {
  let best = steps[0];
  for (const s of steps) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

/** 设置页那行「名字上限」旁边显示的当前值 （满格写"无上限"）*/
function labelMaxText() {
  const v = setNum('labelMax', SET_DEFAULTS.labelMax);
  return v >= LABEL_MAX_UNLIMITED ? '无上限' : Math.max(1, v) + ' 个';
}

/** 真正生效的上限（0 = 不封顶 给 `rebuildPaintBlocks` 用）*/
function labelMaxValue() {
  const v = setNum('labelMax', SET_DEFAULTS.labelMax);
  return v >= LABEL_MAX_UNLIMITED ? 0 : Math.max(1, v);
}

/** 设置页那行「地名上限」旁边显示的当前值 （跟 `labelMaxText` 一个长相）*/
function labelPlaceMaxText() {
  const v = setNum('labelPlaceMax', SET_DEFAULTS.labelPlaceMax);
  return v >= LABEL_MAX_UNLIMITED ? '无上限' : Math.max(1, v) + ' 个';
}

/** 真正生效的地名上限（0 = 不封顶 给 `placePointsFor` 用）*/
function labelPlaceMaxValue() {
  const v = setNum('labelPlaceMax', SET_DEFAULTS.labelPlaceMax);
  return v >= LABEL_MAX_UNLIMITED ? 0 : Math.max(1, v);
}

/* ---- 边界那几条滑条旁边显示当前值 ---------------------------------------
 * 跟「名字上限」那行同一个长相（标签 + 值 + 滑条 `.set-row .hint` 有 margin-right:auto
 * → 值贴着标签、滑条照样贴右）
 * 值是动态插进去的 不用在 HTML 里写九遍 span
 */
const SLIDER_TIPS = [
  /* 「地方边界宽度」拆成两条：
 *   · 地区边界宽度 = 管父级边界（多级链上那些上层线）
 *   · 省份边界宽度 = 管子级边界（本层那条线） 下面两行取代单条 `['set-w', …]`。
 */
  ['set-w-region', (v) => String(v)],
  ['set-w-prov', (v) => String(v)],
  ['set-pw', (v) => String(v)],
  ['set-pa', (v) => v + '%'],
  ['set-ra', (v) => v + '%'],
  ['set-ca', (v) => v + '%'],
  /* 水域边界那一对（独立一档） 与其他项一致：滑条左边写当前值
 */
  ['set-water-w', (v) => String(v)],
  ['set-water-a', (v) => v + '%'],
  /*  荒地边界那两根（与水域那对同一长相） */
  ['set-waste-w', (v) => String(v)],
  ['set-waste-a', (v) => v + '%'],
  /* 名字这一栏的三个滑条同样处理（与边界类一致，滑条左侧显示当前值） 缺少这一步时表现为「其他滑条旁有数字、名字这三个没有」
 *    「势力名称上限」不在此处，它自身有 set-labelmax-v 该 span（还要写「无上限」）
 */
  /*  两根字号（已拆分） */
  ['set-fontplace', (v) => v + '×'],
  ['set-fontpower', (v) => v + '×'],
  ['set-labelac', (v) => v + '%'],
  ['set-labelap', (v) => v + '%'],
];

/**
 * 把表里那些滑条的当前值刷一遍（同时补上缺失的提示 span，幂等） 插在滑条前面，显示为「标签 · 数值 · 滑条」
 */
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
      el.parentNode.insertBefore(tip, el);        // 插在滑条前面，滑条才能贴右
    }
    tip.textContent = fmt(el.value);
  }
}

/*  设置改动后调用：推送到渲染器 / 标签层并重画 */
function applySettings() {
  /* 设置一变就让荒地自动色重算一遍 `applyNatureColors()` 会按「不可通行区域」把荒地节点的 LUT 刷回类色；
 *   不重算时自动色会被这一趟覆盖
 */
  state._wasteCfgSeq = (state._wasteCfgSeq || 0) + 1;
  /* 把两张名字的不透明度送到标签层（那边按 tier 分层取用） 放在 applySettings 最前面：不依赖下面的几何设置，早设早生效
 */
  if (labels) {
    labels.alphaCountry = setNum('labelAC', 50) / 100;
    labels.alphaPlace = setNum('labelAP', 50) / 100;
    /* 导入的字体也在这儿推给标签层
     *   `state.set.fontFacePlace` / `fontFacePower` 存的是族名（空 = 默认）
     *   标签层那边换字体会让名宽 / 字形贴图的缓存失效
     *     所以这里跟着置 labelDirty 下一帧重排一遍*/
    setLabelFont('place', ((state.set && state.set.fontFacePlace) || ''));
    setLabelFont('power', ((state.set && state.set.fontFacePower) || ''));
    /* 版图贴合（P 社式排版）：换档位会使已排好的缓存失效（见 labels.js）。 */
    labels.setMapNameMode((state.set && state.set.mapNameFit) || 'both');
    labels.debug = !!(state.set && state.set.mapNameDebug) || !!labels.debugHash;
  }
  const s = state.set || (state.set = Object.assign({}, SET_DEFAULTS));
  if (renderer) {
    /* 背景色默认 180,180,180。 「未上色区域」另有一项（默认 150），仅在显示剧本时使用。
 *   未显示剧本时，无主地跟随背景色（gl.js 中 NONE 段按 uPaintOnly 选择）。
 */
    const bg = s.bg || [180, 180, 180];
    renderer.backdrop = [bg[0] / 255, bg[1] / 255, bg[2] / 255];
    const up = s.unpainted || [150, 150, 150];
    renderer.unpainted = [up[0] / 255, up[1] / 255, up[2] / 255];
    /* 每一格按底层身份上色
 *   把身份标与七行里的五行类色传给渲染器；
 *   着色器（gl.js 的 colorOfPid）只看底层 pid 的 kind：
 *     2/3/4/5/6 → 直接给类色（与哪一层、有没有片、有没有归属无关）
 *     1 陆地   → 原路径（手绘 / 无主兜底 / LUT 头衔色 + 浓度）
 *   旧数据包没有 `state.kindMask`，传 null，`uKindOn = 0`，整条让开，行为不变
 *   每次 `applySettings()` 都重灌一遍：只标脏，真正上传在下一帧的 `flushPaint()`；
 *   改设置立刻生效即依赖于此（不重烤包，包内数据不动）
 */
    renderer.setKindMask(state.kindMask || null);
    /* 「认得出是水」那张表（供「水域 · 边界」通道使用）
 *   传 null（旧包 / 未识别出水）时着色器 `waterIs` 恒 false，
 *   水域通道与两条让位一起退化，行为不变
 *   与 kindMask 一样每次 applySettings() 重灌，只标脏，下一帧 flushPaint() 上传
 */
    renderer.setWaterKindMask(state.waterKindArr || null);
    renderer.setNatureColors([
      natureColor('sea'), natureColor('lake'), natureColor('river'),
      natureColor('isea'), natureColor('impass'),
    ]);
    // （`renderer.wasteGrey` 已移除，gl.js 中无此 uniform。）
    // 荒地 LUT 起手灰由 `paintWasteGrey()` 在载图时写进 LUT
    renderer.dirty = true;
  }
  resyncTitleLut();
  /* 七行颜色刷进 LUT（修改后立即生效） 放在 `resyncTitleLut()` 后面：那一步只标脏，真正重画在下一帧
 *   开图时也走这条（`openMap` 最后调用的就是 `applySettings()`）
 */
  applyNatureColors();
  /* 字号拆成两个全局值： `__CK3_FONT_PLACE` = 地块名（含海 / 湖 / 河 / 荒地名）
 *   `__CK3_FONT_POWER` = 势力名（剧本 / 年份那几层 + 玩家涂出来的色块名）
 *   兼容值 `__CK3_FONT_SCALE` 仍需写入：
 *   它是 `labels.js` 两级回退的兜底（旧产物 / 测试桩只认它）；
 *   三个一起维护，成本仅一次赋值。
 *   取值兼容旧存档：`s.font` 旧格式为数字，新格式为 `{ place, power }`，
 *   两种都要认（入口为 `fontSizes()`）。
 */
  if (typeof window !== 'undefined') {
    const _fo = fontSizes(s);
    window.__CK3_FONT_SCALE = _fo.place;
    window.__CK3_FONT_PLACE = _fo.place;
    window.__CK3_FONT_POWER = _fo.power;
  }
  state._parentSig = null;
  syncParentBorder();
  labelDirty = true;
  // 图例样式（列数 / 字体 / 颜色 / 尺寸）也走这个口子；预览跟着一起刷新
  if (state.set && state.set.legend) scheduleLegendOverlay();
}

// ---------------------------------------------------------------- 改名
/**
 * 为地块改名（改名工具与弹窗共用此入口，便于自测）。
 *
 *  · 涂过的地：修改该标记名，同一支笔铺设的所有块一并修改（无标记的纯色块先登记标记，并将同色地块一并纳入）。
 *  · 没涂的地：修改该层头衔名（写入 state.titleName）。
 *
 * @returns {boolean} 是否修改成功
 */
/**
 * 改名工具此刻该改谁：涂色名 > 当前显示的剧本归属 > 当前编辑层的地块名
 * 
 *
 * 只认界面上真正在起作用的那层 不读任何"上次看过哪个剧本"的暗记
 * @returns {{kind:'paint',lid:number,name:string}|{kind:'title',tid:number,name:string}|null}
 */
function renameFocus(pid) {
  if (!(pid > 0)) return null;
  const pd = renderer && renderer.paintData;
  const painted = !!(pd && pd[pid * 4 + 3] > 0);
  if (painted && state.provLabel) {
    const lid = state.provLabel[pid] | 0;
    const raw = lid >= 0 ? String(state.labelNames[lid] || '') : '';
    /* 占位符 = 明确留空：预填空串，改名时把这一整组（含占位符那组）改成新名字*/
    return { kind: 'paint', lid, name: isBlankLabel(raw) ? '' : raw };
  }
  /* 剧本在界面上真的显示着（停在剧本层，或地理层借用了剧本配色）→ 改这一格所属的国家
   * 判据只看 `shownEraTier`：没有剧本在显示就直接落到当前层的地块名*/
  const era = shownEraTier();
  if (era >= 0) {
    const tid = titleAt(pid, era);
    const real = state.meta.numRealTitles || 0;
    if (tid !== NO_TITLE && tid != null && !isWaterPid(pid)
        && (real <= 0 || tid < real) && !isWastelandTid(titleAt(pid, TIER_COUNT - 1))) {
      return { kind: 'title', tid, name: String(displayedLabel(pid, tid) || '') };
    }
  }
  const tid = titleAt(pid, editTier());
  if (tid === NO_TITLE || tid == null) return null;
  return { kind: 'title', tid, name: String(displayedLabel(pid, tid) || '') };
}

function renameAt(pid, name) {
  const nm = String(name == null ? '' : name).trim();
  if (!pid || pid <= 0 || !nm) return false;
  const focus = renameFocus(pid);
  if (!focus) return false;
  state._nameVer = (state._nameVer | 0) + 1;   // 名字改了 → 标签点上的 name 缓存需重写

  /* ① 涂色名：修改该标记，同标记的块一并修改（纯色块无标记，仅为点中的这一块登记新标记）。
 *   不按颜色筛选：标记号代表「这一笔」，颜色为每块各自所有。
 */
  if (focus.kind === 'paint') {
    const newId = labelIdOf(nm);
    state.labelIds.set(nm, newId);
    const pd = renderer && renderer.paintData;
    const n2 = state.meta.numProvinces;
    let hit = 0;
    if (focus.lid >= 0) {
      for (let q = 1; q < n2; q++) {
        if (!(pd && pd[q * 4 + 3] > 0)) continue;
        if ((state.provLabel[q] | 0) !== focus.lid) continue;
        state.provLabel[q] = newId;
        hit++;
      }
    } else {
      state.provLabel[pid] = newId;
      hit = 1;
    }
    if (!hit) return false;
    blocksDirty = true;
    labelDirty = true;
    if (renderer) renderer.dirty = true;
    return true;
  }

  /* ② 剧本归属（国家名）：修改头衔名字，全国一并修改。 ③ 未显示剧本：修改当前编辑层的地块名。
 */
  state.titles.names[focus.tid] = nm;
  state.titleName = state.titleName || new Map();
  state.titleName.set(focus.tid, nm);
  blocksDirty = true;
  labelDirty = true;
  if (renderer) renderer.dirty = true;
  return true;
}


/*  改名工具点下去：先把当前名字填进弹窗 */
let _renamePid = 0;
function openRename(pid) {
  _renamePid = pid | 0;
  const box = $('rename');
  const inp = $('rename-input');
  if (inp) {
    /*  跟真正改名时同一口径（涂色名 > 当前剧本归属 > 当前编辑层） */
    const focus = renameFocus(pid);
    inp.value = (focus && focus.name) || '';
  }
  if (box) { box.hidden = false; if (inp) inp.focus(); }
}

function resyncTitleLut() {
  if (!renderer) return;
  renderer.dirty = true;
  labelDirty = true;
}

/**
 * 涂色只新建玩家填色区，头衔本身的颜色不动
 *
 *   不判断颜色是否变化：玩家常先从一个头衔吸色、再涂回同一个头衔
 *   （例如给整个帝国统一铺色），涂出的颜色与原色相同，
 *   但仍属于玩家涂色，不能因颜色未变而视为还原并擦除手绘
 */

// ============================================================ 涂色的「底层单位」账本
//
// 一笔涂色的本质 = 改了一批最底层单位（省份像素）的颜色和标签。
// 历史记录的单位同样为标记，而非「某个头衔」：例如「切到王国层把整个河南填一遍」按标记记录。
// 撤销时只恢复上一步之后仍有差异的像素，前半已涂过的像素保持原样
// 会回到它自己的颜色（而不是被一并抹掉）。
//
// state.provTitle[pid] 记录「这个 pixel 当前显示的是哪个头衔的涂色」（-1 = 没涂），
// state.provLabel[pid] 是对应的标记编号。此处仅把它当作账本使用。

/*  这个头衔覆盖了哪些底层单位（pid） */
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
 * 同上，但直接接收一串 pid
 *
 *   「填色·边界」下按色块擦除时走这条：那一笔不是按头衔清的
 *   （同一个头衔里其他颜色的地不归它管），所以快照也按地块拍
 *
 *   颜色直接读这一格自身（`paintData`）：
 *   每一格有自己的颜色（`paintData[pid]`）、标记编号（`provLabel[pid]`）、
 *   归属（`provTitle[pid]`）。若绕一层 `paintColor.get(头衔)`，
 *   在该头衔被重新涂过之后取回的是新颜色，快照不准
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

/*  把快照与当前状态比较，只把真正变化的收成一步历史 */
function pushPatches(snap) {
  const pd = renderer && renderer.paintData;
  const patches = [];
  for (const before of snap) {
    const p4 = before.pid * 4;
    const on = !!(pd && pd[p4 + 3] > 0);
    const after = {
      pid: before.pid,
      rgb: on ? [pd[p4], pd[p4 + 1], pd[p4 + 2]] : null,      // 同上：读这一格自己
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

/*  把一条 patch 的某一侧写回去（只动这一个底层单位） */
function applySide(side) {
  if (side.rgb) {
    // alpha 取值 0~255；写成 1 相当于透明度 99.6%。
    // 「撤销后被清空」（颜色已写回，但几乎全透明）。
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

/*  从账本重算「哪些头衔算涂过」（撤销之后可能只剩一半） */
/**
 * 手绘层变了：通知一声
 *   涂色、擦除、撤销、重做、导入、清除全部走这里。
 */
function markPaint() {
  state._paintSeq = (state._paintSeq || 0) + 1;  state._paintAnyFor = null;     // 作废：下一帧同步时按新数组重扫

}

function recomputePainted() {
  markPaint();   // 手绘层变化：先作废缓存再重算。
  if (!state.provTitle) return;
  const pd = renderer && renderer.paintData;
  state.painted.clear();
  state.changed.clear();
  const n = state.meta ? state.meta.numProvinces : 0;
  for (let pid = 1; pid < n; pid++) {
    /* 以「该格是否真的有颜色」为准：`paintData` 为依据，`provTitle` 仅为索引（记录该格由哪一笔涂过）。
 *   两者脱节时（旧存档 / 直接修改过手绘纹理），只看 provTitle 会留下残留记录：某格实际无色却被算作「某头衔涂过」（导出时多出一条、撤销后账本不符）。
 *   因此：有颜色才算涂过，无颜色则同步修正索引。
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
  /* 状态栏的「改动 N」在此统一刷新
 *   账本在此重建，故在此刷新：涂 / 擦 / 清除 / 导入 / 撤销
 *   所有改手绘层的路径最终都汇到这一个函数
 */
  updateStatus();
}

/**
 * 把派生值推给渲染器：变化才写入，写入即置脏。
 *
 *   这些值每帧计算（syncLayerSwitches / syncParentBorder）；统一封装可避免各处手写 `if (renderer.x !== v) { ... }` 时漏置 `dirty`（表现为「拖动滑条无反应」）。
 *
 *   @param {string} key 渲染器上的属性名
 *   @param {*} v        目标值
 *   @param {number} [eps] 浮点容差（传入才按容差比较；布尔 / 整型不传）
 *   @returns {boolean} 是否实际写入
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
  // 边界各听各的：势力·边界 → 原版地界；填色·边界 → 按当前显示颜色画的分界
  // （须在早退判断前执行：没有剧本层的数据也要同步这条）
  // 这条边界始终运行（剧本 / 头衔自带颜色亦计入），不看手绘层是否为空
  // 各层均绘制：细层（地区 / 省份 / 地点视图）同样需要，规则与剧本层一致。
  // 浓度 = 势力边界浓度（设置页那一档，内部字段仍叫 ca；实心），粗细 = 链上最粗那一档（见下面 _pw）
  // （细层同样生效：细层勾了「填色 · 边界」即有输出）
  pushRenderer('borderPaint', !!state.showBorderPaint);
  // 这条边界比较的对象：
  // · CK3（没有年代层）和细层（地区 / 省份 / 地点视图）→ 只管自己涂出来的那一圈
  // （细层若按「显示颜色」比，原版每个省本身颜色就不同，整张图的省界上都会多出
  // 一条又粗又实的涂色线，叠在本层细线上面，看起来就是「所有线条都变粗了」）
  // · 剧本 / 国家那层 → 按当前显示颜色比（原版剧本色也算分界）
  const _paintOnly = !(n > 0 && state.tier < n);
  pushRenderer('paintOnly', _paintOnly);
  /* ---- 水域那条海岸线 + 四个水域色 ------------------------------------------
 *    · 海岸线（water ↔ 非水）跟着「还有边界在画」走
 *    · 四个水域色（海 / 湖 / 河 / 不可通行海域）每帧送上去
 *      设置里改了颜色立刻生效（认水的判据、旧包海名那几处还要用）
 */
  /* 水域边界为独立通道（独立一档）。
 *   口径（详见 handover §3.1）：该开关仅负责「水域之间（海洋 / 湖泊 / 河流 / 不可通行海域）的边界」显示与隐藏；受其管理的内容不再受地区边界、地区名称管理。
 *
 *   三级条件，缺一不可：
 *     ① 界面勾选（`showWaterBorder`，HTML 中默认勾选）
 *     ② 该图能算出水陆（`state.waterKindArr` 非空）；旧包或无法识别水域时无此表，通道整体跳过，行为与改造前一致
 *     ③ 渲染器上的值不同才推送（避免每帧置脏）
 *   不读取地区 / 势力 / 填色三个开关：水域之间的缝只认这一个勾选（「边界全关」时仍然生效）。
 *   它与普通头衔边界不是同一类，不合并（合并后会跟随其他开关）。
 */
  {
    const _waterBorderOn = !!state.showWaterBorder && !!state.waterKindArr;
    pushRenderer('waterBorderOn', _waterBorderOn);
  }
  /* 「荒地 · 边界」
 *   ① 界面勾选（`showWasteBorder`，默认关）
 *   ② 该图有身份标（`state.kindMask` 非空）：荒地读取身份标纹理（着色器读 uKindTex，无第二张表）；旧包无此标，通道整体跳过，观感不变；不读 `waterKindArr`（那是水域通道的表）
 *   ③ 值不同才推送；同样不读地区 / 势力 / 填色三个开关（独立一档）
 */
  {
    const _wasteBorderOn = !!state.showWasteBorder && !!state.kindMask;
    pushRenderer('wasteBorderOn', _wasteBorderOn);
  }
  // 玩家名字是否全图重分组：只在国家 / 剧本那层（细层只画涂过的块）
  // 剧本层的国名（原版那批）同样由这份分组负责，「势力 · 名称」不再单独处理。
  // 开关算出的是同一批点，故删除，只剩这一个开关生效
  {
    /* 只有剧本层才全图分组；细层只认玩家涂过的块
 *   末尾的 `&& state.tier < n` 必须保留：
 *   去掉后省份 / 地区层也全图重分组，细层会冒出一整片原版国名
 */
    const _all = !!state.showLabelsPaint && n > 0 && state.tier < n;
    if (state._blocksAll !== _all || state._blocksTier !== state.tier) {
      state._blocksAll = _all;
      state._blocksTier = state.tier;
      blocksDirty = true;
    }
  }
  /* 「头衔」那组显示开关已删除
 *  CK3 也有剧本层（1066 / 空白剧本，`meta.eraDates` 有两条），
 *  故「有没有年代层」的判据在每个模式里都成立，
 *  势力 / 地区一直显示，而「头衔」那组始终隐藏（无作用 UI）。
 *  它控的三样（原版颜色 / 原版地名 / 原版边界）现由「势力 · 地区」那几组
 *  每帧算出并写进 state（见下面 `state.showTitles = col` 那几行），
 *  删除界面后运行时行为不变。
 */
  /* 此处不可提前返回。
 *
 *   `if (!n) return;` 会跳过紧随其后的推导。凡没有年代层的地图（旧包 / 旧缓存，`meta.eraDates` 为空数组）会出现以下问题：
 *    · `state.showBorderTitle` 永远停留在出厂值 false
 *    · 本层头衔边界不再绘制（boot 时按 state 推入 false，之后无人修改，`syncLayerSwitches` 即那个「之后」）
 *    · `syncParentBorder` 在无年代层时以它作为开关（`showOf()` 的兜底），父级链边界一并消失，整条边界链失效
 *
 *   不提前返回时，无年代层也照常向下执行，依据「势力 / 地区 · 边界」两个开关（`state.tier < 0` / `editTier() < 0` 均为 false，落到「地区」档）。
 *   此段不访问任何 DOM 元素（无 `$()` 调用），不存在访问缺失元素的风险。
 */
  const isPower = state.tier < n;
  // 边界照编辑层绘制（开粒度时是粒度那一层），因此听那一类的开关
  const _editIsPower = editTier() < n;
  const col = isPower ? state.showPowerColor : state.showRegionColor;
  // 名称按画的是哪一层分（与视图停在哪无关）：
  // 地名画的是编辑层（开粒度时是粒度那层）→ 听「地区 · 名称」
  // 剧本层那批国名 = 玩家地名那份分组         → 听「填色 · 名称」
  // 解析出的值写回 state（着色器、标签等仍读它们）
  state.showTitles = col;
  state.showBorderTitle = _editIsPower ? state.showPowerBorder : state.showRegionBorder;
  const _labTitle = state.showRegionName;
  if (state.showLabelsTitle !== _labTitle) {
    state.showLabelsTitle = _labTitle;
    labelDirty = true;
  }
  // 推送渲染器：与现值比较，不同才写。
  // 使用私有签名时，其他位置（如加载地图段使用旧勾选框）推送错误一次便无法纠正
  if (renderer.showTitles !== col) renderer.setShowTitles(col);
  if (renderer.borderTitle !== state.showBorderTitle) renderer.setBorderTitle(state.showBorderTitle);
  // 边界只剩一个开关：两条边界都听它的（玩家边界已取消）

}

function syncParentBorder() {
  if (!renderer || !state.meta || !state.meta.tierNames) return;
  const fine = state.meta.tierNames.length - 1;
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  // 基准线宽只记一次（下面会按链调细本层，不能用被改过的值当基准）
  if (state._borderWidthBase == null) state._borderWidthBase = renderer.borderWidth || 1;
  /* 「地方边界宽度」拆为地区 / 省份两条：
 *   · 省份那条管本层（子级线，即 `_setW` 的职责）
 *   · 地区那条管父级链；两项原先取同一值，拆开后可分别调整 旧存档中只有 `w`（语义 = 本层），两条均从它继承，观感不变。
 */
  const _setW = setNum('w', null);
  const _setWProv = setNum('wProv', _setW);
  const _setWRegion = setNum('wRegion', _setW);
  const baseW = _setWProv != null ? _setWProv : state._borderWidthBase;
  // 「势力 / 地区」那两套分开关只在有剧本层的模式里有意义（现在每套都有）
  // 「剧本」元素已删除，判据只看有没有年代层
  const hasSwitches = nEra > 0;
  // 某一层听哪个开关：剧本层（国家 / 1066 政权）归「势力」，其余（帝国 / 王国 / …）归「地区」
  const showOf = (tier) => (hasSwitches
    ? ((nEra > 0 && tier < nEra) ? state.showPowerBorder : state.showRegionBorder)
    : state.showBorderTitle);

  const list = [];        // 从贴近粒度的层往上，一级比一级粗
  // 有链的时候本层自己再细一档（它是最细的那条线）
  const thinBase = baseW * 0.75;
  const step = 0.25;
  /* 粗细阶梯：本层 1 / 父层 1.25 / 填色线与多级链 1.5 整体乘「地方边界宽度 / 1」，即直接取该倍数（默认 1 → 1 / 1.25 / 1.5，观感不变）。
 *   势力那一档（势力线 / 填色线）直接用「势力线宽」pw，不乘基准缩放
 */
  /* 两条各自的宽度（原先一条 `_wScale` 管两边，现分开） 默认都取 1；旧存档只有 w 时两边都跟着 w 走
 */
  const _wScaleThin = _setWProv != null ? _setWProv : 1;
  const _wScaleParent = _setWRegion != null ? _setWRegion : 1;
  /* 宽度不再层层加粗（父级链 / 涂色边界的 1.25、1.5 额外倍率取消）
 *   一律 1.0× = 「地区边界宽度」设置值本身
 *   层与层的区别交给浓度（地区 75% / 势力 100%）和各自的宽度设置
 *   涂色边界（填色线）走「势力边界宽度」设置（_pwW，默认值 1.5），
 *   该 1.5 是设置值本身、不是倍率，未参与任何乘法
 *   W_TOP 为未使用变量（只有定义、无引用），一并删除；
 *   保留会被误当作「填色线乘 1.5」的依据
 */
  const W_THIN = 1.0 * _wScaleThin;      // 本层（子级）：取「省份边界宽度」。
  const W_PARENT = 1.0 * _wScaleParent;  // 父级链：取「地区边界宽度」（两者不再共用）。
  /* 势力线宽即该线粗细（并非乘在其他位置的倍率） 单位与「基准线宽」相同，为「格」：势力那条线 / 势力层上的本层线 / 填色线
 *    三条都直接使用该值（三者应当同粗），不乘基准缩放
 */
  const _pwW = setNum('pw', 1.5);
  /* 势力那条线的粗细：与「填色线」同一套规则
 * 
 * 填色线（下面几行）的算法：
 * max(链上最粗那条, baseW + 0.25) × 「填色线宽」倍率
 * ↑ 浓度固定取「势力边界浓度」_CA
 * 势力那条线取同一个下限、同一个基准（它是那条基准粗线，不加倍率）：
 * powerW = max(thinBase + step * 2, baseW + 0.25)
 * 若固定为 `thinBase + step * 2` = 0.75×基准 + 0.5，
 * 则永远不等于设置中的宽度值
 */
    if (state.grain != null && nEra > 0) {
    // 仅绘制「上一层」这一条，不再逐级上扫：省份粒度下若扫入区域 / 大洲，会多出上二级边界。
    // 省份粒度下将区域 / 都扫入，会多出上两级边界
    const _pt = Math.max(nEra, state.grain - 1);
    list.push({ tier: _pt, width: W_PARENT, show: showOf(_pt) });
    // 剧本（国家）外圈仍绘制，具有独立浓度档（「剧本国家边界」）；粗细用 powerW，与填色线同一下限、同一基准。
    // 粗细用 powerW：与填色线同一下限、同一基准
    list.push({ tier: Math.max(0, state.tier),
                width: _pwW, show: showOf(state.tier) });
  } else if (state.grain != null) {
    // 没有剧本层的数据（兜底）：只描地理上的上一层（父级） 注意：「爷爷级」不是更高的地理单位，而是玩家填色的那条线（见下面的 _paintIsTop）
    // 注意："爷爷级"不是更高的地理单位，而是玩家填色的那条线（见下面的 _paintIsTop）
    const pt = Math.max(0, state.grain - 1);
    list.push({ tier: pt, width: W_PARENT, show: showOf(pt) });
  } else {
    const detail = [fine, fine - 1];
    if (fine > 0 && detail.indexOf(state.tier) >= 0) {
      const pt = state.tier - 1;
      list.push({ tier: pt, width: thinBase + step, show: showOf(pt) });
    }
  }
  // 「父级边界」关着 → 不要链，只留本层那一条线（必须放在构造之后）
  // 本层浓淡与这条开关无关：子级一律取省份档（见下方 `_bs`）。
  //
  // 「爷爷级」= 玩家填色的那条线（链上最粗、实心那一级），不是更高的地理单位
  // 因此 CK3 里「头衔·边界」+「填色·边界」一起开时：本层 0.5 / 父级 0.75 / 填色线 1.0
  // 本层一律 50%，原先用于「本层是否压到 50%」的 hasGrand / _paintIsTop 两个变量已撤除。
  // 相关变量已从本函数移除。
  /* 「父级边界」关着 → 不要中间那些父辈，但不能把整条链清空
 *  场景：剧本视图 + 开了粒度 + 只勾「势力 · 边界」（父级边界未勾）
 *    → 那条「势力 / 国家」线挂在链上的一环，`list.length = 0` 会把它一起清掉
 *    → 本层那条线又归「地区 · 边界」（未开）→ 画面上什么都没有
 *  故只清中间父辈，保留剧本 / 势力那一环（tier < nEra）
 * （前者是独立的一层开关，后者是「是否继续往上画几环」）
 */
  if (!state.showParentBorderTitle) {
    // 只留「开着的那一环」：势力 / 剧本那一环 `showPowerBorder` 关着就什么都不留（对应「链就是空的」那条测试） 只勾势力边界 → 有线；势力也未勾 → 全空
    // `showPowerBorder` 关闭时不返回内容；「链就是空的」那条测试守的正是该行为。
    //   这样两边诉求正好对上：只勾势力边界 → 有线；势力也没勾 → 依旧全空
    const _keepEra = list.filter((e) => nEra > 0 && e.tier < nEra && !!state.showPowerBorder);
    list.length = 0;
    for (const e of _keepEra) list.push(e);
  }
  // 浓度：本层 0.45（在下面设）；有上两层时，上一级 0.75；更高层实心
  const _PA = setNum('pa', 50) / 100;
  const _RA = setNum('ra', 75) / 100;
  const _CA = setNum('ca', 100) / 100;
  /* 水域边界参数独立一套，不沿用省份 / 地区档位；在 syncParentBorder 中与其他参数一并推送。
 *   此函数是边界参数变化的必经路径；单独推送需在改设置 / 开图时各调一次，漏一处即「滑条无效」。
 */
  const _WW = setNum('waterW', SET_DEFAULTS.waterW);
  const _WA = setNum('waterA', SET_DEFAULTS.waterA) / 100;
  pushRenderer('waterBorderW', _WW, 0.001);
  pushRenderer('waterBorderA', _WA, 0.001);
  /* 荒地边界那一对（与水域一样自己一套） 管理「荒地与荒地之间的边界」，由它自己那两根滑条控制
 *    出厂值与水域那对对齐（宽 1 · 不透明度 25%，都是很淡的辅助线）
 */
  const _QW = setNum('wasteW', SET_DEFAULTS.wasteW);
  const _QA = setNum('wasteA', SET_DEFAULTS.wasteA) / 100;
  pushRenderer('wasteBorderW', _QW, 0.001);
  pushRenderer('wasteBorderA', _QA, 0.001);
  // 剧本层（国家）那一圈取「上两层浓度」；中间的父辈取「父级浓度」
  // 剧本国家那一圈 = 「涂色」（100，实心）；其余父辈 = 「地区」
  for (let k = 0; k < list.length; k++) {
    const isEraRing = nEra > 0 && list[k].tier < nEra;
    list[k].alpha = isEraRing ? _CA : _RA;
  }

  // 子级（本层）那条线：任何时候都取「省份边界浓度」（默认 50）
  // 原先它分两档：有链 → 50，孤零零一条 → 默认档 75；该「默认边界浓度」档已整体去掉
  // （设置页那一行也删了）
  // → 「父级边界」这个开关只管链路本身画不画，不再改本层的浓淡
  //
  // 例外：「势力 · 边界」= 国家 / tag 那一层，一律取「势力边界浓度」
  // （设置页那一档，内部字段仍叫 ca）
  // 原先在剧本视图里取「省份 / 默认」（50/75），当父辈时又取这一档（100）
  //   → 同一根线两种浓淡。现在统一按这一档（默认 100 = 实心）
  //   注意判的是编辑层（editTier）不是视图层：开着粒度时"本层"是粒度那层（省份）
  //   它不是势力边界，仍旧该吃省份档
  const _isPowerBase = nEra > 0 && editTier() < nEra;
  const _bs = _isPowerBase ? _CA : _PA;
  if (state._borderStrengthBase == null) state._borderStrengthBase = renderer.borderStrength;
  if (_bs != null) pushRenderer('borderStrength', _bs);
  /* 「势力线宽」倍率：该滑条同时控制势力线与填色线。
 *   滑条名称为「势力线宽」（见 index.html），内部字段仍叫 pw，以免旧存档与测试失效。
 *   它乘在势力线和填色线上，两条线粗细完全一致。
 */
  
  // 本层（链上最细那条）也跟着细一档；没有链时恢复基准
  // 没有链 + 当前就在势力那层 → 这条本层线就是势力线
  // 与填色线同一套：同一下限 + 乘「势力线宽」倍率
  const _wBase = _isPowerBase ? _pwW : W_THIN;
  pushRenderer('borderWidth', _wBase, 0.01);

  // 填色边界取链上祖父级档位：粗细 = 基准×0.75 + 0.5，并画实心。
  // 注意不能只取"链上最粗那条"：链短的时候（只有父级一级）那样拿到的是父级档
  // 因此以「祖父档」为下限：链本身更粗时跟随链（剧本模式不变）。
  const _pw = _pwW;             // 填色线：跟势力线同粗 （同一个设置值）
  pushRenderer('paintWidth', _pw, 0.01);
  pushRenderer('paintAlpha', _CA, 0.01);

  // 链与渲染器现值一致时不再改动（setExtraBorders 会置脏，不要每帧置脏）
  const same = renderer.extraCount === list.length
    && list.every((e, k) => renderer.extraTiers[k] === e.tier
      && Math.abs(renderer.extraWs[k] - e.width) < 0.01
      && renderer.extraShows[k] === (e.show ? 1 : 0)
      && Math.abs(renderer.extraAs[k] - (e.alpha != null ? e.alpha : 1)) < 0.01);
  if (!same) renderer.setExtraBorders(list);
  /* 边界图跟着重算 （防抖 150ms）
   *   为什么要挂在这儿：它是"视图层 / 粒度 / 那几条边的开关"变化的必经之路
   *   边界图的身份是按"当前层 + 当前粒度"算的 这几样一变，掩码就过时了
   *   开图早期 state.tier 还是 -1，那次算出来是空的
   *     这里补上"层真正定下来之后"的那一次 （防抖会把连续变化合成一次）*/
  
}

/* 「荒地自动上色」整套已删除（水域 / 荒地 = 普通地块
 *    为荒地上色使用普通手涂路径，与其他地块一致
 *    「清除荒地填色 / 自动涂色」两个按钮连同处理器一并退役）
 */

/**
 * 找「同一族」的头衔（同色 + 同标签），供「以玩家为准」的涂色使用。
 *
 * 仅剧本粒度、且开启「填色 · 边界」时，玩家一次用新颜色涂的若干国家在该层视为一个国家；再点其中任一，整族一并涂色。
 *
 * @param {number} tid 点中的头衔（编辑层那一级）
 * @param {number[]} rgb 该头衔的涂色
 * @param {string} label 该头衔的标记名
 */
function playerGroupTids(tid, rgb, label) {
  // 从地块出发认族：颜色 + 标记都一样的地块算一族 （不查"头衔 → 颜色/名字"那两张表）
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
 * 只有剧本粒度（没开更细的粒度）+ 开着「填色·边界」时，以玩家为准：
 * 玩家一次用新颜色涂的那几个国家算一个国家，点其中任何一个 → 整族一起涂
 */
/**
 * 从点到的地块出发归并同族：颜色与标记都相同的地块算一族，
 * 再把它们所在的（编辑层）头衔收进来。
 *
 * 不能按头衔级账目查找（paintColor/titleLabel）：停在与涂色时不同的粒度时，
 * 该账目对不上，族里只剩自身，表现为「点了没反应」。
 */
function playerGroupTidsAt(pid) {
  const pd = renderer && renderer.paintData;
  const n = state.meta.numProvinces;
  if (!pid || !pd) return [];
  const et = editTier();
  const tm = state.titlemap;
  const want = identWantAt(pid, et);       // 身份内核只此一套（见 identFieldsAt）
  if (!want) return [];
  // 身份只能逐格计算：同一头衔下的地块可涂成不同颜色或不同标记。
  //   身份是按"这块地"算的，不能按头衔缓存（缓存过一版，结果整片认错族）
  const out = new Set();
  for (let q = 1; q < n; q++) {
    if (samePaintIdent(q, et, want)) out.add(tm[et * n + q]);
  }
  return Array.from(out);
}

/* 与 playerGroupTidsAt 使用同一套身份（标签名 + 颜色），但返回地块，供按地块逐块涂色。 */
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
 * 解析一格地的归属信息：项目中判断「这块地属于谁」只用它。
 *
 * @param {number} pid 地块号
 * @param {number} [tier] 指定游戏侧的层级（不传 = 编辑层）
 * @returns {{pid:number, painted:boolean,
 *            fill:?{name:string, rgb:number[]},
 *            owner:?{name:string, rgb:number[], tid:number}}}
 *
 *  · `fill`：填色归属（玩家侧），标记名 + 颜色；未涂过为 null
 *  · `owner`：该层归属（游戏侧），名字 + 颜色 + 序号
 *
 * 判断「两块地是否同一归属」比较此处的名字 + 颜色（见 `sameOwner`），不比较头衔序号：序号是数据内部编号（换图、换层即变）；名字 + 颜色才是可表述的归属。填色侧与剧本侧均看名字，两侧因此对得上（「涂成德国的那些地」与「1936 剧本里的德国」）。
 *
 * 内容即左栏「悬停地块」的几行（每层一行 = 一个 `owner`）。
 */
function provInfoAt(pid, tier) {
  if (!pid) return null;
  const t = (tier == null) ? editTier() : tier;
  const pd = renderer && renderer.paintData;
  const p4 = pid * 4;
  const painted = !!(pd && pd[p4 + 3] > 0);
  const lid = state.provLabel ? (state.provLabel[pid] | 0) : -1;
  const fill = painted ? {
    /* 占位符 = 明确留空 → 左栏也显示空 不把零宽字符漏到界面上*/
    name: (lid >= 0 && !isBlankLabel(state.labelNames[lid])) ? String(state.labelNames[lid] || '') : '',
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

/* 两个「归属」是否相同：比较名字 + 颜色（名字相同、颜色不同即不同）。 */
function sameOwner(a, b) {
  if (!a || !b) return false;
  if (String(a.name || '') !== String(b.name || '')) return false;
  const x = a.rgb || [], y = b.rgb || [];
  return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
}

/**
 * 「点这一下该动哪些地块」：涂色与还原共用此范围
 * 仅在剧本视图且未开启粒度时使用（条件由调用方判断）。
 *
 * 优先级：
 *   · 「势力 · 边界」开启 → 先看剧本归属，没有则最低粒度；不看填色
 *   · 「势力 · 边界」关闭（即填色路径）→ 先看所指处的填色；
 *     无填色再看剧本归属；剧本也无归属（无主地 / 空白剧本）→ 最低粒度
 *
 * 规则（两个开关两条路）：
 *
 * 「势力 · 边界」开启（且「填色 · 边界」未开）→ 按剧本归属整块
 *   例：巴黎在 1936 剧本属法国、却被涂成德国色，指向巴黎时
 *   目标为整个法国（与涂色无关）
 *
 * 否则（「填色 · 边界」开启，或两个都未开）→
 *   目标 = 「填色归属与所指地块相同」∪「未涂过但剧本归属一致」
 *   例：指向涂成德国色的巴黎 → 整个德国 = 涂成德国的地块 +
 *       未涂过且剧本属德国的地块
 *       指向未涂过的里昂 → 「除巴黎外的整个法国」=
 *       涂成法国的地块 + 未涂过且剧本属法国的地块
 *      （巴黎涂的是德国色，填色归属不符且已涂过 → 不计入）
 *
 *   一句话：涂过的看填色归属，未涂过的看剧本归属；
 *   涂过但填色归属不符的，即使剧本归属是目标国也不计入。
 *
 * 均无则给最低单位地块
 *
 * @returns {number[]|null} 目标地块（空 / null = 连最低单位都取不到）
 */
function paintTargetsAt(pid) {
  if (!pid || !(renderer && renderer.paintData)) return null;
  const n = state.meta.numProvinces;
  /* 荒地须逐块涂色（否则涂一块荒地会使整片荒地一同上色）。
 *   荒地地块共享同一「归属」（owner 名字相同，见 2242 / 2433 处的 `#impassable` / 荒地伪头衔），下方 B 段按名字匹配，故点一块会命中同归属的全部荒地。
 *   荒地应作为独立地块处理（与海 / 湖不同：海由一个头衔管辖一大片），因此此处直接返回其自身这一块，后续 A / B / C 三段均不执行。
 */
  {
    const _fineTid = titleAt(pid, TIER_COUNT - 1);
    if (_fineTid != null && _fineTid !== NO_TITLE && isWastelandTid(_fineTid)) return [pid];
  }
  /* 剧本层 + 无粒度：无主地块一律按单格涂。
 *   · 剧本层的格子分两类，按归属决定：
 *     · 有主（真头衔，`1444_MNG` 那种）→ 走下面的 A/B/C 归属匹配
 *       （点一笔涂整国，即「涂归属」的本意）
 *     · 无主（无主陆地 NO_TITLE / 海·湖·河·不可通行·荒地的类片 tid ≥ 真头衔数）
 *       → 一律单格；悬停同样单格（applyHoverHighlight 同一判定），涂色与擦除同一口径
 *   · 判据 = 编辑层那一行的 tilemap 有无主（titleAt(pid, editTier)）
 *   · 粒度层（开了粒度 / 地理层）不在此列：真名海片整片涂的规则保留
 */
  {
    const _nEraP = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
    if (_nEraP > 0 && state.grain == null && editTier() < _nEraP) {
      const _tid0 = titleAt(pid, editTier());
      const _real = state.meta && state.meta.numRealTitles != null
        ? state.meta.numRealTitles : 1e9;
      /* 「填色优先」路径中，所指处有填色则不受此步拦截
 * 
 * 该步针对「未涂过的无主地」；空白剧本层全为无主，
 * 故该步对每格都成立，玩家涂出的色块只能单格（整块涂色失效）。
 * 涂过的地块在手绘层有身份（标记名 + 颜色，见 paintIdentAt），
 * 放行后交给下面按填色归属整块识别。
 * 
 * 「剧本 · 边界」勾选项已删除，不再有「先剧本、不看填色」的分支，
 * 现永远先看填色。
 */
      const _pdP = renderer && renderer.paintData;
      const _paintedP = !!(_pdP && _pdP[pid * 4 + 3] > 0);
      if (!_paintedP
          && (_tid0 == null || _tid0 === NO_TITLE || _tid0 >= _real || isWastelandTid(_tid0))) {
        return [pid];
      }
    }
  }
  const eraT = countryTier();                    // 「最近的有主剧本层」
  const mine = provInfoAt(pid, eraT);
  if (!mine) return null;

  // 填色那条（「势力 · 边界」开着/关着都走它）
  const myFill = mine.fill;
  const wantName = myFill ? String(myFill.name || '')
                          : (mine.owner ? String(mine.owner.name || '') : '');
  if (wantName) {
    /* 这一圈不再走 `provInfoAt`：
 * 它每扫一格都要为 `fill` / `owner` / `rgb` 各造一个对象，
 * 四万格 × 三个临时对象 / 次（拖动时一次一笔），GC 持续抖动。
 * 
 * 此处判据只有三样：涂没涂 / 填色名字 / 剧本名字（外加涂过时的颜色比对），
 * 故直接读表：`paintData`（颜色与 alpha）/ `provLabel` + `labelNames`（标记名）/
 * `titleAt` + `titles.names`（剧本名），不构造对象。
 * 
 * 语义与 `provInfoAt` 逐条对齐（对拍脚本 `tools/_dump_targets.js`：
 * 两份 app.js 各跑一遍，全图每个 pid 的目标名单须完全一致）。
 * 涂过的：名字对上还要颜色对上（`sameOwner` 口径；名字此处已比较，只剩 rgb 三个数）。
 * 指向地块未涂（`myFill` 为空）时：涂过的格只比名字。
 * 该口径为既有行为（以其他颜色涂成法国的地块亦计入），不可额外加上
 * 「没填色就不收涂过的」。
 */
    const _pd = renderer.paintData;
    const _lidT = state.provLabel;
    const _lnames = state.labelNames || [];
    const _tnames = (state.titles && state.titles.names) || [];
    const _myLid = _lidT ? (_lidT[pid] | 0) : -1;
    const _myR = _pd[pid * 4], _myG = _pd[pid * 4 + 1], _myB = _pd[pid * 4 + 2];
    const out = [];
    for (let q = 1; q < n; q++) {
      const q4 = q * 4;
      if (_pd[q4 + 3] > 0) {
        /* 涂过的 → 认填色归属 （名字 = 标记名）*/
        const olid = _lidT ? (_lidT[q] | 0) : -1;
        const oname = olid >= 0 ? String(_lnames[olid] || '') : '';
        if (oname !== wantName) continue;
        if (myFill && (_pd[q4] !== _myR || _pd[q4 + 1] !== _myG || _pd[q4 + 2] !== _myB)) continue;
        out.push(q);
      } else {
        /* 没涂过的 → 认剧本归属*/
        const _oq = titleAt(q, eraT);
        if (_oq == null || _oq === NO_TITLE) continue;
        if (String(_tnames[_oq] || '') !== wantName) continue;
        out.push(q);
      }
    }
    if (out.length) return out;
  }

  // C. 都没有 → 只动最低单位这一块
  const fine = titleAt(pid, TIER_COUNT - 1);
  if (fine == null || fine === NO_TITLE) return null;
  const one = pidsOf(fine);
  return one.length ? one : null;
}

/** 涂色时这一格默认该用的势力名（空 = 落占位符）。
 *
 *  只有停在剧本层、且没开粒度时，落笔单位才是势力本身：
 *  · 剧本层：取这一格的势力名；无主地 / 伪头衔 → 空
 *  · 开粒度：落笔单位是地块，不是势力 → 空
 *  · 没有剧本（地块模式）→ 空
 */
function paintUnitName(pid) {
  const t = titleAt(pid, editTier());
  if (t == null || t === NO_TITLE) return '';
  const tier = state.titles.tiers ? state.titles.tiers[t] : -1;
  const nEra = eraTierCount();
  if (!(nEra > 0 && tier >= 0 && tier < nEra)) return '';
  const real = (state.meta && state.meta.numRealTitles) || 0;
  if (real > 0 && t >= real) return '';
  if (isWastelandTid(t)) return '';
  const nm = (state.titleName && state.titleName.get(t))
    || (state.titles.names && state.titles.names[t]) || '';
  return nameIsMeaningful(nm) ? String(nm).trim() : '';
}

/**
 * 按地块涂（或擦），一次写入，不经过头衔。
 *
 * 手绘层的实际数据是「每格自己的颜色 / 标记 / 归属」（见 `provInfoAt` 注释），落笔单位为地块：写 `paintData` + `provLabel` + `provTitle` 三项。
 *
 * 标记取法（见 `paintUnitName`）：画笔中写了自定义标记则使用；否则取落笔格所属势力的名字；无势力名（未开剧本 / 开了粒度 / 无主地）则落占位符。
 *
 * @param {number[]} pids
 * @param {number[]|null} rgb 传入即涂该色；null = 擦除
 */
function paintPids(pids, rgb) {
  const n = state.meta ? state.meta.numProvinces : 0;
  const custom = rgb ? String(state.brushLabel || '').trim() : '';
  const fine = TIER_COUNT - 1;
  /* 「仅上色」：标记取目标地块的势力名（没有势力名就落占位符空）
   * 「上色+标记」不动，仍用画笔里写的标记
   * 擦除两边都不受影响 （擦掉色却留个标记，地图上会飘着没主的名字）*/
  const colorOnly = !!(rgb && state.set && state.set.paintLimit === 'color');
  /* 标记框留空 ≠ 不写标记位：空也落一个占位符（不显示）。 由此「明确无名字」与「从未标记」在数据上可区分（见 LABEL_BLANK）。
 */
  const lidByName = new Map();
  const lidFor = (nm) => {
    const k = nm || LABEL_BLANK;
    let v = lidByName.get(k);
    if (v == null) { v = labelIdOf(k); lidByName.set(k, v); }
    return v;
  };
  for (const q of pids) {
    if (!(q > 0) || q >= n) continue;
    if (rgb) {
      renderer.setPaint(q, rgb[0] | 0, rgb[1] | 0, rgb[2] | 0, 255);
      const qlid = colorOnly ? lidFor(paintUnitName(q)) : lidFor(custom);
      renderer.setPaintLabel(q, qlid >= 0 ? qlid : 0);
      if (state.provLabel) state.provLabel[q] = qlid;
      // 「哪一笔涂的」记成这一格自己的最细层节点 （账本 / 撤销要用，见 recomputePainted）
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
  markPaint();   // "改动 N" 的状态栏刷新在 recomputePainted 里统一做 （见那儿）
  // 边界图随之变化（身份变化后防抖 150ms：拖动时每帧一笔，不能每帧重算）。
  
}

/** 把这一批地块一次涂完 / 擦完，合成一条历史 （一次点击 = 一步撤销）*/
function paintPidsAsOne(pids, rgb) {
  if (!pids || !pids.length) return;
  const snaps = snapshotPidsList(pids);      // 快照按地块拍，不绕头衔
  paintPids(pids, rgb);
  recomputePainted();                        // 账本按"每格有没有颜色"重算
  pushPatches(snaps);
}

/**
 * 界面当前实际生效的剧本层；未显示则为 -1。
 *
 *   不可写成「最后选过的那个」：
 *      · 停在剧本层 → 即该层
 *      · 在地理层但配色借用剧本（grain）→ 即该层
 *      · 均无 → -1（取色 / 改名 / 运用剧本涂色一视同仁）
 */
function shownEraTier() {
  const n = eraTierCount();
  if (n > 0 && state.tier >= 0 && state.tier < n) return state.tier | 0;
  const g = state.grain;
  if (g != null && g >= 0 && g < eraBlockCount()) return g | 0;
  return -1;
}

/** 「运用剧本涂色」：把还没上色的地块按当前显示的剧本配色铺一遍
 *
 *  · 只碰没涂过的地块；水 / 荒地 / 没有归属的格子都跳过
 *  · 标记取剧本归属的国名；没有国名（无主地）就落占位符空
 *  · 整批合成一步撤销
 */
function applyEraPaint() {
  const era = shownEraTier();
  if (era < 0) { toast('当前没有显示剧本'); return; }
  const pd = renderer && renderer.paintData;
  if (!pd || !state.meta) return;
  const n = state.meta.numProvinces;
  const fine = TIER_COUNT - 1;
  const real = state.meta.numRealTitles || 0;
  const colorOnly = !!(state.set && state.set.paintLimit === 'color');
  const cols = state.titles.colors || [];
  const todo = [];
  for (let pid = 1; pid < n; pid++) {
    if (pd[pid * 4 + 3] > 0) continue;                 // 已经上过色
    if (!isPaintable(pid)) continue;                   // 海 / 湖 / 河 / 不可通行海域不涂
    const tid = titleAt(pid, era);
    if (tid == null || tid === NO_TITLE) continue;
    if (real > 0 && tid >= real) continue;             // 海 / 湖 / 荒地那种伪头衔
    if (isWastelandTid(titleAt(pid, fine))) continue;  // 荒地不涂（老包兜底）
    const c = cols[tid];
    if (!c) continue;
    todo.push({ pid, c, nm: String(displayedLabel(pid, tid) || '').trim() });
  }
  if (!todo.length) {
    toast(era === blankTierIndex() ? '这个空白剧本里没有国家' : '这个剧本里没有可上色的地块');
    return;
  }
  const snaps = snapshotPidsList(todo.map((t) => t.pid));
  /* 只落剧本国名；没有国名的格子写占位符空 （跟「仅上色」的取名规则一致）*/
  const lidOf = new Map();
  for (const t of todo) {
    renderer.setPaint(t.pid, t.c[0] | 0, t.c[1] | 0, t.c[2] | 0, 255);
    const nm = t.nm || LABEL_BLANK;
    if (!lidOf.has(nm)) lidOf.set(nm, labelIdOf(nm));
    const lid = lidOf.get(nm);
    renderer.setPaintLabel(t.pid, lid >= 0 ? lid : 0);
    if (state.provLabel) state.provLabel[t.pid] = lid;
    if (state.provTitle) state.provTitle[t.pid] = titleAt(t.pid, fine);
  }
  recomputePainted();
  pushPatches(snaps);
  blocksDirty = true;
  labelDirty = true;
  if (renderer) renderer.dirty = true;
  scheduleSave();   // 一次铺数千格，与 paintPids 一样走防抖存档。
  if (state.hover && state.hover.pid) renderHoverCard(state.hover.pid);
  LOG.event('涂色', `运用剧本涂色：${todo.length} 格` + (colorOnly ? '（仅上色）' : ''));
  toast(`已按剧本上色 ${todo.length} 格`);
}

/**
 * 某地块的「身份」（标签名 + 颜色），涂色分支用它判断「整块是否同族」。
 *
 *   实现整体位于 paintIdentAt（见下文），此处仅保留「看当前编辑层」的外壳，避免两处判据不一致。
 */
function paintIdentOf(q) {
  if (!q || !(renderer && renderer.paintData)) return null;
  return paintIdentAt(q, editTier());
}

// ---------------------------------------------------------------- 地块身份
//
// 「这块地算哪一个色块 / 哪一族」在项目里问过很多次（认族、改名、涂色、图例
// 悬停高亮），判据是同一套：显示出来的名字 + 显示出来的颜色
//
//   涂过的地 → 手绘色 + 那一笔的标记名
//   没涂的地 → 原版色 + 该层头衔名
//   都没编号的（海/无主地）→ 没有身份（null）
//
// 这几处各自实现过 identOf（playerGroupTidsAt / playerGroupPidsAt /
// paintIdentOf 三份几乎一模一样的循环），改一处就得记得改三处。
// 且它们在全图扫描中逐格调用，每次都要新建一个 [r,g,b] 数组。
// 只为拼个字符串（V3 4 万格 = 一次点击 4 万个短命数组）。
//
// 现在统一走 paintIdentAt：不分配数组，颜色直接拼数字
// 而需要真颜色数组的地方（画图、取色）仍旧用 stableColor

/**
 * 一块地的「身份」内核（显示名 + 显示色），认族的唯一判据。
 *
 * 写入一张复用临时表，返回值仅在「调用后立即比较」时有效。全图扫描（V3 4 万格）时每格一个 `[r,g,b]` / 一个「名字|r,g,b」字符串，即数万次短命分配；此处不分配。
 *
 * 判据（与改造前逐字一致）：
 *   涂过的 → 手绘色 + 该笔的标记名（与该层是否有主无关）
 *   未涂的 → 原版色 + 该层头衔名；两者皆无 → null（海 / 无主地）
 *
 * @returns {?Array} `[name, r, g, b]`（共用数组，需保留时拷贝，见 `identWantAt`）
 */
const _identTmp = [null, 0, 0, 0];
function identFieldsAt(q, tier) {
  if (!q) return null;
  const pd = renderer && renderer.paintData;
  const q4 = q * 4;
  const painted = !!(pd && pd[q4 + 3] > 0);
  const t0 = titleAt(q, tier);
  // 没涂过的无主地：没有身份 （不参与认族）
  // 涂过的照旧有：名字与颜色都在手绘层上，与该层是否有主无关。
  // （空白剧本那一层全是无主地，涂出来的色块就靠这一条才能"同色同标记算一族"）
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

/* 身份串（`名字|r,g,b`），供需要作为 Map 键或比较相等的地方使用。 */
function paintIdentAt(q, tier) {
  const f = identFieldsAt(q, tier);
  return f ? f[0] + '|' + f[1] + ',' + f[2] + ',' + f[3] : null;
}

/** 把当前这一格的身份拷成快照 （临时表会被下一次调用覆盖）*/
function identWantAt(q, tier) {
  const f = identFieldsAt(q, tier);
  return f ? [f[0], f[1], f[2], f[3]] : null;
}

/** 跟 `paintIdentAt(q,tier) === want` 等价，但不拼字符串 （全图扫专用）
 *  @param {string[]} want `identWantAt` 给的快照*/
function samePaintIdent(q, tier, want) {
  const f = identFieldsAt(q, tier);
  return !!f && f[0] === want[0] && f[1] === want[1]
    && f[2] === want[2] && f[3] === want[3];
}

// ── 悬停用：满足「停在国家那几层 + 无粒度 + 填色·边界开」时
//    颜色与势力名都用玩家涂完之后的当前结果 （两个悬停卡片共用）
function liveHoverOn() {
  const nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  return nEra > 0 && state.grain == null && !!state.showBorderPaint && editTier() < nEra;
}
function liveColorOf(pid, tid) {
  return liveHoverOn() ? stableColor(pid || 0, tid) : null;
}

function paintAt(pid, tid) {
    // 无头衔 / 越界：不涂（界面流程不会走到此处，actAt 会把无主地换到最细层）。
    // 外部直接调用（脚本 / 测试）时不得抛错
    if (!state.titles) return;
    if (tid == null || tid === NO_TITLE || tid < 0 || tid >= (state.titles.keys || []).length) return;
    const to = state.brush.slice();
    /* 「要不要真的动手」看这一格自己（`provInfoAt` 解析出的三样）
 * 不看「那个头衔涂过没有」
 * 颜色相同、标记也相同 → 本次无改动，直接返回
 * 颜色相同但标记变了 → 必须继续（同色换标记再涂是常规操作）
 * （仅看颜色时，「同色不同标记」点击无响应、标记无法修改）
 */
    const _here = provInfoAt(pid);
    const _wantLabel = String(state.brushLabel || state.titles.names[tid] || '');
    if (_here && _here.fill) {
      if (sameColor(_here.fill.rgb, to) && String(_here.fill.name || '') === _wantLabel) return;
    }
    // （荒地的「允许上色」总开关已删除：水片 / 荒地片与普通头衔一样可涂。）
    // 剧本视图下的口径：一笔涂哪些地块，由 `paintTargetsAt` 统一算
    //   势力边界 → 剧本归属整块；否则 → 涂过的看填色归属、没涂过的看剧本归属
    //   还原那边（actAt 的 erase 支线）用的是同一个函数 涂了什么就还原什么
    {
      const _nEra1 = (state.meta.eraDates && state.meta.eraDates.length) || 0;
      const _eraOnly = _nEra1 > 0 && state.grain == null && editTier() < _nEra1;
      if (_eraOnly) {
        const _pids = paintTargetsAt(pid);
        if (_pids && _pids.length) { paintPidsAsOne(_pids, to); return; }
      }
    }
    // 没走"填色那条"（细层 / 开了粒度）→ 把编辑层那一块展开成地块，按地块涂
    paintPidsAsOne(pidsOf(tid), to);
}

/**
 * 按头衔涂，仅为 `paintPids` 的薄封装。
 *
 * 供两条路径使用：导入旧档（文件中的 key 可能属于任意一层头衔）与测试。界面涂色一律走 `paintAt → paintTargetsAt/pidsOf → paintPids`（落笔单位为地块），因此此处不再维护「头衔 → 颜色/名字」两张表（`paintColor` / `titleLabel` 已删除）。
 */
function paintTitle(tid, rgb, noHistory, noRecompute) {
  const pids = pidsOf(tid);
  if (!pids.length) return;                 // 无头衔的头衔号：动作等于未执行（涂色单位即地块）
  const c = [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0];
  const _snap = noHistory ? null : snapshotPidsList(pids);
  paintPids(pids, c);
  /* `noRecompute` 供批量场景使用（导入涂色那种成千上万个头衔的场合） `recomputePainted` 是 O(省份数)，每涂一个执行一次 = 几千 × 一万多 ≈ 上亿次操作
 *      → 界面会整个冻结十余秒（表现为界面无响应）。批量场景由调用方最后计算一次
 */
  if (!noRecompute) recomputePainted();
  if (_snap) pushPatches(_snap);            // noHistory：调用方（整族涂）自己合成一条
}

/* 按头衔还原（擦除手绘），同样为 `paintPids` 的薄封装（头衔级清理 / 测试用）。 */
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

/* 能缩到多小
 *
 *   「刚好把整张图放进视口」是缩放下限的基准；在此基础上再给 30% 余量，
 *   因此可以缩得比「刚好放下」更小。
 *   缩到底时四周会露出一圈地图边界以外的空地（背景色），
 *   便于看全貌、截图留白、确认某块地的位置。
 *   余量固定为 30%：放开后地图会缩成屏幕中间一小块，反而不便操作。
 */
function minScale() {
  const stage = $('stage');
  const fit = Math.min(stage.clientWidth / state.meta.mapWidth,
                       stage.clientHeight / state.meta.mapHeight);
  const s = fit * 0.7;
  /* stage 会瞬时量出 0×0（切后台 / 嵌入容器收放）→ 不得把 0 写入相机缩放，否则整图全黑 */
  if (Number.isFinite(s) && s > 0) return s;
  return (state.cam && state.cam.scale > 0) ? state.cam.scale : 1;
}

/**
 * 相机允许露出一部分地图外部。
 *
 *   硬夹在地图内的做法：地图比视口小则居中，比视口大则不允许把边缘拖进来，
 *   结果是边缘始终顶在视口边上，看不到地图外的空地。 现允许两侧各露出 30% 视口的余量：
 *     · 地图比视口大 → 可多拖出一截，看到边界外的空地
 *     · 地图比视口小 → 不再强行居中，可移到旁边（便于对照其他内容）
 *   上限受 30% 约束，避免把地图整个拖出视野。
 *   `_clampC`：`vw >= W` 时上下限会反转，直接 clamp 会得到异常值，
 *   故上下限交叉时取中点（即居中），与三目表达式等效。
 */
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

/** 按视口比例平移视角（方向键用）。invalidate 里会做边界夹取，跑不出地图*/
/**
 * 视角移动中：给名字层一个「每帧最多画几毫秒」的预算。
 *
 *   现象：部分名字平时不画，鼠标移过去才出现。
 *   根因是自适应上限：变慢后永久少画，需再次重画才逐步恢复。
 *   现改为：移动中按预算截断（保证跟手），停止 250ms 后立即全量补画一帧，
 *   因此停下后名字即完整，无需再移动鼠标。
 */
let _labelIdleTimer = 0;
/* 拖动 / 缩放时画布降低的分辨率。 边界逐像素计算，单帧开销与画布像素数成正比，拖动时降一档可保证跟手。
 *   0.7 → 像素数 ×0.49；手停下 250ms 后由 noteViewMotion 中的定时器调回 1 并补一帧。
 *   `?motion=0.55` 自行调整 / `?motion=1` 完全关闭，改地址栏即可，无需重新打包。
 */
const MOTION_SCALE = (() => {
  try {
    const m = /[?&]motion=([0-9.]+)/.exec(location.search);
    if (m) return Math.min(1, Math.max(0.4, parseFloat(m[1]) || 1));
  } catch (e) { /* */ }
  return 0.7;
})();
function noteViewMotion() {
  if (labels && labels.frameBudgetMs !== undefined) labels.frameBudgetMs = 12;
  if (renderer) renderer.motionScale = MOTION_SCALE;
  /* 皮肤为液态玻璃：大面板的 backdrop blur 每帧重算开销较大
 *   拖动/缩放期间先在 body 上添加标记，CSS 收窄模糊半径，操作结束后恢复 （仅影响皮肤样式；未启用皮肤时该 class 无任何规则）
 */
  try {
    if (typeof document !== 'undefined' && document.body) document.body.classList.add('vz-moving');
  } catch (e) { /* */ }
  if (_labelIdleTimer) clearTimeout(_labelIdleTimer);
  _labelIdleTimer = setTimeout(() => {
    _labelIdleTimer = 0;
    if (labels && labels.frameBudgetMs !== undefined) labels.frameBudgetMs = Infinity;
    if (renderer) renderer.motionScale = 1;      // 手停了 → 分辨率调回来
    try {
      if (typeof document !== 'undefined' && document.body) document.body.classList.remove('vz-moving');
    } catch (e) { /* */ }
    labelDirty = true;          // 补一帧"全量"的名字
    invalidate();
  }, 250);
}

function panBy(dx, dy, ratio) {
  const v = viewRect();
  state.cam.cx += dx * v.w * ratio;
  state.cam.cy += dy * v.h * ratio;
  noteViewMotion();
  invalidate();
}

function fitView() {
  const stage = $('stage');
  /* 视口会瞬时塌成 0×0（切后台 / 嵌入容器；实测进图那几秒约一半概率出现）。
 *     此时量出的「适配缩放」为 0，写入即黑屏。
 *     量不到有效尺寸时先不动相机，下一帧再试（布局恢复后即有值）。
 *     设次数上限兜底：持续量不到（页面隐藏）则停止重试。
 */
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
  noteViewMotion();
  invalidate();
}

/**
 * 
 * 搜索定位时的缩放按地盘面积计算。
 * 
 * 固定为 0.35 时，小男爵领定位后仍是全图视角，等于没有定位。
 * 地盘按面积开方即其「直径」（像素）；令其约占屏幕高度的三分之一：
 * 屏幕上纵向可见地图像素数 = cssH / scale，取 diameter ≈ 0.35 * 该值。
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
  // 无地盘（或未算出标签点）时不跳转：定位为附加功能，无地可跳即静默返回
  // 此处不再提示「该势力没有地盘，无法定位」：搜索势力本就不以定位为目的。
  // （按势力搜索无需定位）
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

/** 海 / 山这类伪头衔，key 以 '#' 开头，它们不属于任何层*/
/** 悬停高亮该看哪个节点：海/湖/不可通行/荒地这些共享的粗层伪节点
 *  换成光标底下最细层的那一个（海洋就能一块一块地查、一块一块地亮）*/
/**
 * 这个名字是不是"能给玩家看的"：
 *   · 含中文/日文等非 ASCII → 是
 *   · 正常地名（有空格、大小写混合，如 Gulf of Bothnia）→ 是
 *   · 机器串（全大写 NORWEGIAN IMPASSABLE 1 / 纯小写键名 river_hooghly）→ 不是
 *     （CK3 的不可通行海域就是这类占位串，游戏里也不显示名字）
 */
/**
 * 手工翻译表：以下水块名（海 / 湖 / 屏障）在游戏本地化中确实没有中文
 * （基础中文与 11 个 workshop 汉化 mod 中均无对应条目）。
 * 因此在此人工补充，放在 app 内，重烤数据也不会丢失。
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

/** 手工表里有没有这一条（有就显示中文，不看"是不是机器串"那套）*/
function manualWaterName(name) {
  if (name == null) return null;
  return MANUAL_WATER_NAMES[String(name)] || null;
}

function readablePlaceName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return false;
  if (/[^\x00-\x7f]/.test(s)) return true;           // 有非 ASCII（中文等）
  if (/^[A-Z0-9 _\-]+$/.test(s)) return false;         // 全大写机器串
  if (/^[A-Z]{2,}\s/.test(s)) return false;            // LAKES eastern Mongolia 这种
  if (/^[a-z0-9_]+$/.test(s)) return false;             // 纯小写键名
  return /[A-Za-z]/.test(s);                            // 其余（Gulf of Bothnia）
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

/**
 * 能否涂这一格：单一判据
 *
 *   所指处最低单位的身份 id 是否为陆地或荒地：是则涂色，否则不涂。
 *
 *     · 身份标（`kindMask` 底层地块身份）1 = 陆地 · 6 = 不可通行区域 → 能涂
 *     · 其余（2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域）→ 不许涂
 *
 *   旧包（无 `kindMask`）退回最细层的键前缀，逐格判断身份，结论一致。
 *   「逐块荒地」为例外：那批（`wl_<地块号>`）身份标写的是 1，
 *     实为不可通行，仅看码会误判为「陆地、能涂」，
 *     需补 `isWastelandTile` 判定（荒地必须可逐块涂色）。
 *   两个判据都只看地块号，与当前层级、tid 归属无关
 *     （粗层同一片水共用一个 `#sea_*` 伪头衔，仅看 tid 无法判定单格是否为水）。
 */
function isPaintable(pid) {
  if (!pid) return false;
  const k = kindOfPid(pid);
  /* 身份标即为"河 / 湖 / 海 / 不可通行海域"（码 2~5）→ 禁止涂色，其余情况均可涂 */
  if (k >= 2 && k <= 5) return false;
  /* 码 1（陆地）/ 6（不可通行区域）/ 老包认不出的 → 可涂。
 *   逐块荒地（`wl_<地块号>`）在身份标中写的是 1，但本应可涂。
 *   因此此处不再判断荒地（码 2~5 中只有「不可通行海域」需要锁定）。 即：陆地或荒地可涂，其余不可涂。
 */
  return true;
}

/**
 * 能否对该地块执行涂色。
 *
 * 口径：为填色做 id 区分，河流 / 海洋 / 不可通行海域 / 湖泊禁止上色。判据归纳为：身份 id 为陆地或荒地才可涂。
 *
 * 与既有「水片 / 荒地片 = 普通头衔，可涂」的规则相反，以本条为准。
 * 仅「完全没有头衔」仍锁定（此类地动手时应落到更细一层，见 actAt）。
 *
 * @param tid 头衔号（可空：调用方有时只拿得到地块号）
 * @param pid 地块号（传入才可判断身份；不传则仅按头衔判断）
 */
function isLocked(tid, pid) {
  if (pid) return !isPaintable(pid);
  return tid === NO_TITLE || tid == null;
}

/** 能编辑的地块给十字光标，锁住的给禁止符*/
function updateCursor(tid, pid) {
  const el = $('map');
  if (state.tool === 'view') { el.style.cursor = 'grab'; return; }
  el.style.cursor = isLocked(tid, pid) ? 'not-allowed' : 'crosshair';
}

/* 该省份是否无男爵领、以伯爵领色块代替（快查表） */
function isDegradedBaron(pid) {
  const s = state.meta && state.meta.degradedSet;
  return s ? s.has(pid) : hasIn(state.meta && state.meta.degradedBaronies, pid);
}

function renderHoverCard(pid) {

  const box = $('hover-chain');
  /* 该小方格 = 所指地块的「最低级别号码」
 *
 *    方框左上角的小字显示该地块的最低级别号码，用于定位「该地块的编号」。
 *
 *    最低级别 = 最细一层的地块号 = pid 本身（不是头衔号），
 *    与 `hoverTileLines` 的「最低单位」口径一致。
 *    号码不带 `#` 前缀，直接显示数字。
 */
  $('hover-pid').textContent = pid ? String(pid | 0) : '';


  if (!pid) {
    box.innerHTML = `<p class="empty">${GAME.notInMap}</p>`;
    return;
  }
  box.innerHTML = '';

  /* 海 / 湖 / 河 / 荒地：背景地块，侧栏不列层级，仅给两行。
 * 与悬停卡片同源（`hoverTileLines` 规格表）。
 * 拼装逻辑统一收口于 `hoverTileLines`（`_hideName` / `_typeLabel` / `_realName` 等不再各自拼装），避免规格变更只改到一侧。
 * 仅两类走此处：
 * ① 伪头衔地块（键以 `#` 开头：海 / 湖 / 河 / 不可通行）
 * ② 荒地（`wl_*` / `#wasteland_*` / `isWastelandTid`）
 * 普通有主陆地仍走下方层级链（侧栏的本职）。
 */
  const special = state.hover.tids[viewTierFor(pid)];
  const _fineTid0 = state.hover.tids[TIER_COUNT - 1];
  const _fineKey0 = _fineTid0 != null ? String(state.titles.keys[_fineTid0] || '') : '';
  const _isWasteTile = isWastelandTile(pid, _fineTid0);
  const _isImpass = keyStarts(_fineKey0, '#impassable');
  /* "背景地块"的判据不能只看"键以 `#` 开头"
 *   · 伪头衔前缀（`#sea_*` / `#lake_*`）为其他游戏的写法
 *   · EU5 的水键没有 `#`（`siberian_lakes_1` / `chukchi_sea`）
 *   · 仅认前缀时，EU5 的湖会落入层级链（既定口径为「湖泊：照旧」）
 *   · 补两条与键无关的判据：`isWaterPid`（那枚小标签）和 `kindOfPid`（身份标）
 *   · 两者任一判为水 / 不可通行，即按背景地块处理
 */
  const _kind0 = kindOfPid(pid);
  const _isWaterTile = isWaterPid(pid) || (_kind0 >= 2 && _kind0 <= 5);
  if ((isSpecialTid(special) || _isWasteTile || _isImpass || _isWaterTile)
      && !sidebarUsesChain(pid, special)) {
    const lines = hoverTileLines(pid);
    const a = lines.a || '—';
    /* 第二行 = 该格的「类别」。
 *
 *   读法（两个「非」拆开）：
 *     · 陆地 → 不给称呼（由层级链给出，走不到此分支）
 *     · EU4 / EU5 的海域 → 不给称呼（其第二行为最低单位名，
 *       由 `hoverTileLines` 给出，即 `lines.b`，不抢占该位置）
 *     · 其余水 / 荒地（河 / 湖 / 海 / 不可通行，含 EU4/EU5 的湖）
 *       → 第二行写类别名：海洋 / 湖泊 / 河流 / 不可通行海域 / 不可通行区域
 *
 *   该规则仅作用于左侧栏方块；悬停小卡片第二行仍按 `hoverTileLines`
 *   （空串即不显示），两处口径独立（见 `positionHoverCard`）。
 *   类别名取自 `CATEGORY_NAME[kind]`，不按名字内容推断
 *   （判序为先不可通行海域、再不可通行区域，见该表）。
 *   荒地那几块的 `kindMask` 码不是 6（实测 CK2/EU4/CK3 均为 1）：
 *   `wl_*` / `#wasteland_*` 为构建期兜底写入；判出「是荒地」即给
 *   「不可通行区域」，不依赖该标。
 *   （`#impassable*` 中确实带码 6 的，查 `CATEGORY_NAME` 仍正确。）
 *   EU4 / EU5 的海不进入此分支：上面的 `&& !sidebarUsesChain(...)`
 *   已将其交给层级链（该类地块第二行为最低单位名）。
 */
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
  // 剧本级（年份那几层）不列：悬停面板从剧本下方那一层开始。
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
      // 该地块无男爵领时，地图以伯爵领的色块代替
      row.innerHTML =
        `<span class="dot" style="background:${rgbToHex(state.titles.colors[tid])}"></span>
         <span class="tier">${TIER_BADGE[tier]}</span>
         <span class="name" style="color:var(--text-faint)">（无男爵领，显示的是伯爵领色块）</span>`;
    } else {
      const col = state.titles.colors[tid];
      const changed = isChanged(tid) ? ' ' : '';
      /* 链条行也不显示编号。
 *   荒地此处不显示 `#<省份号>`：「第二行不显示编号」。
 *   另一处：HOI4 pr 层水域的 `info.name` 本身即占位号（构建期取 `#2581`），
 *   占位名一律换成类别名（`kindOfPid` 按 kind 判定；
 *   先判不可通行海域、再判不可通行区域，与 CATEGORY_NAME 表顺序一致）。
 *   真名原样保留（陆地地名 / 中文水名不做改动）。
 */
      let _rowName = String(info.name || '');
      if (isPlaceholderName(_rowName)) {
        /* ① 先取真名（CK2 的 259 条水名 / 20 条荒地名即在此表）
 * ② 无真名 → 退类别名（先判不可通行海域，见 CATEGORY_NAME）
 * ③ 任何一行都不显示 `#<数字>`（下面 `impassLabel` 也不造编号）
 * 兜底不再退层级名（否则「没有名字的 province 直接变成了『省』」）：
 *   HOI4 的省份本身无名字（13055 块中仅 3247 块有城市名），
 *   退到 TIER_BADGE 会把层级名当地名印出；现退成空 → 渲染为淡色「—」。
 */
        _rowName = realNameFromTables(pid) || CATEGORY_NAME[kindOfPid(pid)] || '';
      }
      const _shown = impassLabel(_rowName);
      row.innerHTML =
        `<span class="dot" style="background:${rgbToHex(col)}"></span>
         <span class="tier">${TIER_BADGE[tier]}</span>
         <span class="name"${_shown ? '' : ' style="color:var(--text-faint)"'}>${_escHtml(_shown || '—')}${changed}</span>
         <span class="pick">取色</span>`;
      row.onclick = () => {
        gotoLevel(tier);
        setBrush(col, true, true);        // 取色后同时切换到绘图工具
        // 取色不改标记（不把地块名写入「标记」）
      };
    }
    box.appendChild(row);
  }
}

/**
 * 「不可通行××」一律显示为「不可通行区域」。
 *   各套数据叫法不一：不可通行山地（Miller 那套 673 处）· 不可通行荒地（EU4）等。
 *   逐处改数据不如在显示时归一（与设置页叫法一致）。
 *   海域为例外：CK3 的「不可通行海域」是有意义的类型名，保留。
 *   仅在显示处使用，不得修改身份串（会影响涂色分族）。
 */
function impassLabel(nm) {
  const s = String(nm == null ? '' : nm);
  if (!s || s.indexOf('不可通行') < 0) return s;
  return s.indexOf('海域') >= 0 ? s : '不可通行区域';
}

/**
 * 背景地块（海 / 湖 / 河 / 不可通行）在悬停时的显示名。
 *   卡片与侧栏共用同一实现：EU5 的不可通行此处同样显示「不可通行区域」，
 *   不再区别对待。
 *
 *   有真名即显示真名（同 EU5 原版做法）：
 *   原尺寸数据把部分地块挂在荒地节点上，因而被判为「不可通行」，
 *   但这些地块本身有名字（如「俄罗斯针叶林」）。
 *   原版显示什么，此处显示什么，不自行替换为「不可通行区域」；
 *   仅真无名字时才退回类型名。
 *   水域真名也走此处（原在卡片第二行，要求「与地块一样」，故移至第一行；
 *   见 waterSpecificName）。
 */
function specialTileLabel() {
  const pid = state.hover.pid;
  const fine = state.hover.tids[TIER_COUNT - 1];
  const key = fine != null ? String(state.titles.keys[fine] || '') : '';
  const dn = String(state.titles.names[state.hover.tids[viewTierFor(pid)]] || '');
  /* 水的类别由 `waterKindByPid` 判定（既有判据，直接复用）。
 *
 *   键前缀逐个判断（`#sea` / `#lake` / `#river` / `#impassable`）存在三处问题：
 *      · `#sea` 三句在 EU5 上恒不成立：EU5 的水键不带 `#`（实测 `isWaterKey` 在 EU5 认出水 0 块，见 `_local/probe_water_predicates.js`），EU5 的水被当陆地走上一分支，悬停显示地块名而非水域名
 *      · `#impassable` 一句把不可通行陆地与不可通行海域混在一起
 *
 *   现按 pid 判定（身份标最权威，旧包退回 `#` 键；该链已在 `waterKindByPid` 内实现，无需另写）。
 *   `w = 0` 非水 / 2 海 / 3 湖 / 4 河 / 5 不可通行海域（6 = 不可通行陆地，属荒地一侧）。
 */
  const w = waterKindByPid(pid);
  const _isWater = w !== 0;
  const _impSea = w === 5;
  // 本块自身的名字：优先各地块名册，其次最细层节点的名字
  if (!_isWater) {
    const raw = state.provinceNames ? state.provinceNames[pid] : null;
    const fineName = fine != null ? String(state.titles.names[fine] || '') : '';
    const generic = ['湖泊', '海洋', '河流', '不可通行'];
    const cand = (manualWaterName(raw) || raw) || (generic.indexOf(fineName) < 0 ? fineName : '');
    if (readablePlaceName(cand)) return String(cand);
    // 节点自己的名字也认（「俄罗斯针叶林」就在这层）
    if (readablePlaceName(dn) && !/^不可通行/.test(dn)) return dn;
  }
  /* 荒地 / 不可通行（含 CK3 那种"不可通行海域"那种叫法）
   * 判据仍是"键前缀 + 荒地名册" 那是荒地那一侧的事 这一轮只收水的口*/
  if (keyStarts(key, '#impassable') || isWastelandTid(fine)) {
    if (_impSea) return '不可通行海域';                 // 身份标 5 = CK3 那种海域
    return impassLabel(dn.indexOf('海域') >= 0 || key.indexOf('sea') >= 0 ? (dn || '不可通行海域') : '不可通行区域');
  }
  /* 水：类别名从 `waterKindByPid` 来 （不再看键）*/
  if (w === 2) return waterSpecificName(pid, state.hover.tids[viewTierFor(pid)]) || '海洋';
  if (w === 3) return waterSpecificName(pid, state.hover.tids[viewTierFor(pid)]) || '湖泊';
  if (w === 4) return waterSpecificName(pid, state.hover.tids[viewTierFor(pid)]) || '河流';
  return impassLabel(dn);
}

/**
 * 这一层的水名表（该层无名字即无名字，不得以其他层充数）
 *
 *   口径：每个水域按层级取游戏内容给出的名字，思路同陆地；
 *     HOI4 的省份级水域与地区级为同一对象，且没有名字。
 *   → 该表只有两种取法：
 *     · `seaNamesByTier` 存在（数据本身按层给表）→ 用 `bt[tier]`
 *       该层为 null = 这一层没有名字，返回 null，不退回 `meta.seaNames`
 *       （`meta.seaNames` 是最粗层的口径，用它填细层即「以其他层名字充数」）
 *     · 表不存在 / 短于层数（旧包、VIC3 仅有单张 `seaNames`）→ 退回它
 *       （属「没有分层」，与「这一层没名字」不同）
 */
function waterNameTable(bt, tier) {
  const meta = state.meta || {};
  const nT = (meta.tiers && meta.tiers.length) || 0;
  if (Array.isArray(bt) && nT > 0 && bt.length >= nT) return bt[tier] || null;
  return meta.seaNames || null;
}

/**
 * 水域那一格的真名（悬停卡片第一行使用）。
 *
 *   要求：「水域和其他地块一样，仅仅是不能填色」。
 *   普通地块卡片只有一行：这块地叫什么。
 *   水域原先把真名放在第二行（第一行固定为「海洋」类名），
 *   第二行取消后（见 specificPlaceName）该名字无处显示，故移至第一行，与陆地同位置。
 *
 *   两条来源（与高亮、标签同源，均看 `editTier`）：
 *    ① 每层一片的包 → 当前层该片自身的名字（`#sea_pr_57`，见 isTierPieceKey）；
 *       该层没有名字即为空，不以其他层的名字填充
 *       （HOI4 省份级水域本无名字，此处应为空并退回笼统名）
 *    ② 旧包（全世界海共用一个 `#sea`，无片）→ 构建期真名表
 *       （见 waterNameTable；该层为 null 即「此层无名字」，不退）
 *   取到类名（「海洋」「湖泊」）或空 → 返回空串，调用方退回笼统名
 *   （CK3 的海即如此，本身无名字）。
 */
function waterSpecificName(pid, tid) {
  if (!pid) return '';
  const T = state.titles || {};
  const key = (tid != null) ? String((T.keys && T.keys[tid]) || '') : '';
  /* ① 每层一片的那片：片名就是这一格的真名 （跟标签、跟高亮同一个来源）*/
  if (isTierPieceKey(key)) {
    const nm = String((T.names && T.names[tid]) || '');
    return (nm && !isPseudoCategoryName(nm)) ? nm : '';
  }
  /* ② 老包：真名表（键为地块 id，JSON 中会变为字符串，两种均试）。
 *   取动手那一层（`editTier`）而非视图层，与高亮 / 标签同源。
 *   （剧本层下未开粒度时 editTier 即最低层；取视图层的表会使名字与高亮的区域不一致。）
 */
  const meta = state.meta || {};
  const bt = meta.seaNamesByTier;
  const tbl = waterNameTable(bt, labelTier() | 0);
  if (!tbl) return '';
  const v = (tbl[pid] != null) ? tbl[pid]
          : (tbl[String(pid)] != null ? tbl[String(pid)] : null);
  return v ? String(v) : '';
}

/**
 * 该地块的「具体名字」，仅剩荒地名（水域名已移走）。
 *
 *   水域不再有第二行（要求：水域与其他地块一样，仅是不能填色）：普通地块悬停卡片只有一行「这块地叫什么」；水域原先把「丹麦海峡 / 波罗的海」一类真名放在第二行（第一行固定为「海洋」类名），属区别对待，现真名回第一行（见 `specialTileLabel` / `waterSpecificName`，按「当前层的 tid」取）。
 *
 *   荒地此条保留（EU4 / EU5 的荒地有自己的名字，否则会被隐藏）：荒地第一行常为「不可通行区域 / 不可通行荒地」类名，真名（热那亚 / 波尔多）需靠第二行。
 *   来源：构建期把每个荒地块的真名收在 `meta.wastelandNames`（EU4 87 / VN 329 / EU5 1971 条，见 docs/水域名调研.md）。
 *   返回空串 = 「没有额外的具体名」。
 */
function specificPlaceName(pid) {
  if (!pid) return '';
  const meta = state.meta || {};
  const T = state.titles;
  const _tier = labelTier();
  /* ① 每层一片的荒地片：该片自身的名字即具体名。
 *
 *   「片」= 该层同名地块的集合（见 build_tier_pieces.tier_pieces）。
 *   片名天然就是该层的名字，与地图标注、悬停高亮的整片同源，不会对不上。
 *
 *   仅认「每层一片」的键（`#wasteland_rg_0`，见 isTierPieceKey）。
 *     `wl_<地块号>`（荒地最细层逐块）不算：其节点名在 CK3 侧只是类名「不可通行山地」，作为具体名会凭空多出第二行，故该批走下方真名表（EU4/VN 真名表本就有同一份名字，结果一致）。
 *   水域片不走此处（`#sea_*` / `#lake_*`），见上文：水域没有第二行。
 */
  const _tid = titleAt(pid, _tier);
  const _key = (T && _tid != null) ? String(T.keys[_tid] || '') : '';
  if (isTierPieceKey(_key) && !isWaterKey(_key)) {
    const nm = (T && T.names && T.names[_tid]) || '';
    /* 片名是类名（"不可通行山地"/"无归属荒地"）的不算具体名
 *    说明这一片在该层没有名字 以其充第二行会与第一行重复，故不采用
 */
    if (!nm || isPseudoCategoryName(nm)) return '';
    return String(nm);
  }
  /* ② 荒地名
 *   构建期把每个荒地块的真名收在 `meta.wastelandNames` 里
 *   （EU4 87 / VN 329 / EU5 1971 条，出处是本地化的 `PROV<id>`，
 *    与海名同一套读法，见 docs/水域名调研.md）
 *   它比「节点名字」准：节点名可能是 `Unused19` 这类占位名，
 *   因此先查它，查不到才退到节点自身名字。
 */
  const _wl = meta.wastelandNames;
  if (_wl) {
    const v = (_wl[pid] != null) ? _wl[pid]
            : (_wl[String(pid)] != null ? _wl[String(pid)] : null);
    if (v) return String(v);
  }
  // ③ 退路：已移除。若退到类名，CK3 的荒地悬停会显示「不可通行山地」，
  // 且第二行与第一行重复。
  // 不能退到「最细层节点自身的名字」，那是类名（「不可通行山地」）。
  //   "海洋""湖泊"那种）第一行已经在显示了 第二行再写一遍纯属重复
  //   第二行存在的意义是"这一格具体叫什么"（波罗的海 / 热那亚）
  //   只有构建期那两张真名表（`seaNames` / `wastelandNames`）配得上
  // 查不到则不显示，不以类名代替
  return '';
}

/**
 * 悬停卡片第二行（「这一格具体叫什么」）：真名 → 类别名 → 空。
 *
 *   占位号一律不上屏。
 *     实测（pid=281 悬停）原始 HTML：
 *
 *         <div class="hc-title">…不可通行区域</div><div class="hc-sub">#281</div>
 *
 *     第一行正确，漏出的是第二行。
 *     根因：CK3 的不可通行「片」逐块构建，构建期无名字表，片名落到 `tier_pieces` 的 `#<地块号>` 兜底；而 `specificPlaceName` 只按「是否为类名」过滤（`isPseudoCategoryName`），`#281` 既非类名也不为空，故原样上屏（`build_ck2` 的 11b 以真名覆盖；通用侧依赖这道过滤）。
 *     判据统一走 `isPlaceholderName`（`#…` / `#u12` / 纯数字 / 空 均不算名字），与 `realNameFromTables` 同一套标准，不得各写各的。
 *
 *   实际那两行不再走此处：悬停卡片按「第一行 = 目前层级 / 第二行 = 最低层级」自行拼装（见 `positionHoverCard`）；本函数保留为同口径的第二行（旧调用方 / 探针仍可用）。
 */
function hoverSubName(pid) {
  if (!pid) return '';
  const fine = titleAt(pid, TIER_COUNT - 1);
  return realNameAtTier(pid, fine, TIER_COUNT - 1) || categoryNameOf(kindOfPid(pid), '');
}

/**
 * 某一层的该格叫什么（悬停两行均使用）。
 *
 *   陆地口径：第二行显示所指处最低层级的相关信息 → 最细层（CK3 男爵领 / EU4 省份 / HOI4 省份 / VIC3 省份 / EU5 地点）节点自身的名字。
 *
 *   水域的「地名」由构建期真名表提供，逐块节点名不是地名：
 *     EU4 的 `#lake_pr_185` 名为「喀拉海」（细层才有），更细的逐块节点反而叫 `#1888`；
 *     CK3 的 `#sea_b_2218` 为 `#8613`。故先查 `waterNameTable(seaNamesByTier, 最细层)`（该层表为 null = 这一层没名字，不得以其他层充数，见该函数），查不到才退回节点自身名字。
 *   顺序不可反：先看节点名时，EU4 的湖会从「喀拉海」退回 `#1888`，编号重新上屏。
 *
 *   过滤走 `nameIsMeaningful`（占位 / 类名 / 机器串均不算）。
 */
function realNameAtTier(pid, tid, tier) {
  if (!pid || tid == null || tid === NO_TITLE) return '';
  const T = state.titles || {};
  /* 「这一格是不是水」问 `waterKindByPid`。 此处原为 `isWaterKey(键)`：已有 pid 却看键。
 *   在 EU5 上该判断恒为假（EU5 的水键不带 `#`），真名表不会被查询，
 *   直接退回逐块节点名（`#1888` 这类占位号），即上文所述问题。
 */
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

/**
 * 四类类别名（河 / 湖 / 海 / 不可通行那几样） 既定口径：「没有名字的就说它是什么」
 */
const TYPE_LABEL = { 2: '海洋', 3: '湖泊', 4: '河流', 5: '不可通行海域', 6: '不可通行区域' };

/**
 * 名字显示方案（管理地图上的名字，与悬停卡片是两件事）。
 *
 *   规则：
 *    陆地：照旧
 *    湖泊：EU4/EU5 显示，其他不显示
 *    河流：CK2/CK3 不显示，其他无此设定
 *    海域：CK2/EU4/EU5/VIC3 显示，CK3 不显示
 *          HOI4 只有战略区显示，state 与 prov 不显示
 *    不可通行区域：CK3 不显示，EU4/EU5 显示，其他无此设定
 *
 *   读法（「无此设定」= 该作没有这一类，故不显示）：
 *    · 湖：EU4 / EU5 / CK2（CK2 的湖泊与河流有名字）。
 *      CK2 数据中的「湖」由构建期算出（四邻全陆地，见 `build_ck2.find_enclosed_lakes`）；
 *      该档位缺失时湖会被并进 `#sea`，属分类错误而非规则。
 *    · 河：CK2 显示；CK3 不显示；其他无此设定 → 按海处理
 *      （「无此设定」= 该作不分河这一类别，属水但落到 `kind=2`，见 `labelZoneOf`）。
 *    · 荒地（不可通行）：仅 EU4 / EU5。
 *    · 海：CK2 / EU4 / EU5 / VIC3。
 *
 *   HOI4 无需此处特判：「只有战略区显示」由数据决定：
 *   该作海名只挂在 `#sea_sr_*` / `#lake_sr_*` 上，
 *   state / prov 两层为 `#<地块号>` 占位，真名表亦无，
 *   `drawLabels` 的「占位名不出标」规则会自动拦截。
 *   VIC3 三层均有真名，照常出标。
 */
const NAME_POLICY = {
  land: { ck3: true, ck2: true, eu4: true, eu5: true, hoi4: true, vic3: true },
  sea: { ck3: false, ck2: true, eu4: true, eu5: true, hoi4: true, vic3: true },
  lake: { ck3: false, ck2: true, eu4: true, eu5: true, hoi4: false, vic3: false },
  river: { ck3: false, ck2: true, eu4: false, eu5: false, hoi4: false, vic3: false },
  waste: { ck3: false, ck2: false, eu4: true, eu5: true, hoi4: false, vic3: false },
};

/**
 * 该标签节点属于哪一类（与 `waterKindOf` 同一口径，仅不读 hover）。
 *
 *   判据须按键名 + 地图规模：标签路径上没有 `state.hover`（`waterKindOf` 读悬停的若干 tid，此处拿不到）。
 *   CK3 的 `#impassable_sea` 归入荒地那条（「不可通行区域」属屏障，不是海）。
 */
function labelZoneOf(key, tid) {
  const k = String(key == null ? '' : key);
  /* EU5 的荒地键上看不出来 （`arctic_archipelago` 那种真头衔名）
   *   → 先拿 `meta.wasteland` 那张名单查一下 tid （跟别处 `isWastelandTid` 同一份）*/
  if (tid != null && tid >= 0 && isWastelandTid(tid)) return 'waste';
  if (keyStarts(k, '#impassable') || keyStarts(k, 'wl_') || keyStarts(k, '#wasteland')) return 'waste';
  if (keyStarts(k, '#river')) return 'river';
  if (keyStarts(k, '#lake') || k.indexOf('_lake') >= 0) return 'lake';
  if (keyStarts(k, '#sea') || k.indexOf('_sea') >= 0) return 'sea';
  return 'land';
}

/**
 * 该类名字在此游戏中是否显示（`NAME_POLICY` 表的取用口）。 不得在其他处再写一遍 game 判断；要改就改该表。
 */
function nameShown(kind) {
  const row = NAME_POLICY[kind] || NAME_POLICY.land;
  const g = String((state.meta && state.meta.game) || '');
  return row[g] !== false;
}

/**
 * 该格是否为荒地（水 / 山这类「无归属的屏障地」，与真正的陆地分开）。
 *
 *   四个来源，均不可漏：
 *     · `meta.wasteland` 名单（EU5 的荒地序号混在真头衔中，只能靠它；VIC3 的也在此名单，但按规格 VIC3 不做荒地处理，见调用处）
 *     · 最细层的 `wl_<地块号>`（EU4 / CK2 / EU5 的逐块荒地）
 *     · 每层一片的 `#wasteland_*` / `#impassable_*` 片
 *     · 类别码 6（不可通行）
 */
function isWastelandTile(pid, fineTid) {
  const T = state.titles || {};
  /* 先按地块号查。 仅扫 `state.hover.tids`（悬停那一刻的链条）时：
 *   未悬停或悬停在别处，链条为空或属他人 → 荒地判不出；
 *   该判据用于 `isPaintable`，会使逐块荒地被误锁
 *   （实测 CK2 / EU4 / CK3 的 `wl_*` 全被锁）。
 *   → 现按 pid 取最细层节点，与悬停状态无关；
 *   悬停链条仍扫，额外兜一层「粗层的片」，保留。
 */
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

/**
 * 判断该地块的水域子类（湖 / 河 / 海，判不出来回 2）
 *
 *   不能只看最细层的键：
 *     CK3 最细层为 `#sea_b_2218`、EU5 为 `chukchi_sea`（不带 #）
 *     → 需从最细层向粗层查找，识别出「河 / 湖」即停止
 *   顺序：先河后湖（CK2 的「奥涅加湖」位于 `#river_*`，按游戏口径算河）
 *   EU5 使用 `_lake` / `lake` 后缀（`siberian_lakes_1` / `..._region_lake`），
 *     不要套用 `#lake` 前缀。
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

/**
 * HOI4 的水：名字挂在战略区那一层（`#sea_sr_65` 州 / 省份那两层是占位号） 既定口径：「HOI4：悬停时显示其所属的战略区的名称，第二行无」
 */
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

/**
 * 查出某格的逐层链条（`{ tid, key }[]`）。
 *   按需现查，不依赖 `state.hover.tids`（它仅在鼠标停在该格时有效，而右键取色的后续流程、导出、重算标签都可能在别的时机调用）。
 */
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

/**
 * 判断该地块的水域类别（2 海 · 3 湖 · 4 河 · 5 不可通行海域，不看悬停状态）
 *
 *   不能只看最细层的键：
 *     · CK3 最细层为 `#sea_b_2218`（可识别为海），荒地为 `wl_1464`（不是水）
 *     · HOI4 的键不带 `#`，需靠身份标（`kindMask` 码 2/3）区分
 *   判序：先身份标（码 2~5 最权威），再 `#` 开头的键
 *
 *   禁止以「键名含某个词」作为认水依据：
 *     `/_sea_/` 一类宽松匹配会把挪威陆地 `d_duortnoseatnu`（含 sea）认成海，
 *     导致「右键取陆地」返回「海洋」。
 *     → 只认 `#` 开头的键（编辑器自造的伪头衔：`#sea_*` / `#lake_*` /
 *       `#river_*` / `#impassable_sea_*`）；真人头衔键（`d_*` / `c_*` /
 *       `b_*` / `k_*` / `e_*`）均不带 `#`。
 *   旧包（无身份标）遇到水又无法识别时回 2（类别名显示「海洋」），
 *     不做猜测；该分支仅在「已经是水」的路径中执行，不会触及陆地。
 */
function waterKindByPid(pid) {
  if (!pid) return 0;
  const k = kindOfPid(pid);
  if (k >= 2 && k <= 5) return k;
  /* 身份标说不出话来（老包 / 每层一片）→ 只认 `#` 开头那几把键*/
  const chain = chainOfPid(pid);
  for (let t = chain.length - 1; t >= 0; t--) {
    const key = chain[t].key;
    if (!key || key.charCodeAt(0) !== 35) continue;        // 不是 `#` 开头 → 不是伪头衔 跳过
    const m = /^#(impassable_sea|sea|lake|river)(_|$)/.exec(key);
    if (!m) continue;
    return m[1] === 'impassable_sea' ? 5 : m[1] === 'sea' ? 2 : m[1] === 'lake' ? 3 : 4;
  }
  return 0;                                                // 认不出来 = 不是水
}

/**
 * 右键取色得到的「标记名」。
 *
 *   规则汇总：
 *     · CK3：水 / 荒地一律不给标记（`#10228` 一类占位号不得上笔）
 *     · HOI4：水 → 战略区名（`#sea_sr_65` = 白令海），取不到则类别名
 *     · 湖：仅 EU4 / EU5 / CK2 给名字，其余（CK3 / HOI4 / VIC3）不给标记
 *     · 其余水（海 / 河 / 不可通行海域）→ 按真名表 → 类别名（EU4 的海给「白令海峡」，CK2 的海给「冰岛西海岸」，无名则「海洋」）
 *
 *   `#<地块号>` / `#u12` / 纯数字在任何情况下均不得作为标记（取不到可读名则退回类别名「海洋 / 湖泊 / 河流 / 不可通行区域」，再退为空）。
 *   本条仅作用于右键取色这一支笔：地图标签点 / 涂色分族走原路径，故只改 `pickTitle`，不动 `displayedLabel` 的调用方。
 *
 * @returns 标记名（`''` = 不给标记）；非水 / 荒地时返回 `null`（调用方走原路径）
 */
function pickMarkerName(pid, tid) {
  if (!pid) return null;
  const g = String((state.meta && state.meta.game) || '');
  const chain = chainOfPid(pid);
  const fineKey = chain.length ? chain[chain.length - 1].key : '';
  const _fineTid = chain.length ? chain[chain.length - 1].tid : NO_TITLE;
  const isWaste = isWastelandTile(pid, _fineTid)
    || keyStarts(fineKey, 'wl_')
    || /^#(wasteland|impassable)(_|$)/.test(fineKey);     // 只认 `#` 开头 别子串匹配
  if (isWaste) return g === 'ck3' ? '' : (realNameFromTables(pid) || categoryNameOf(6, ''));

  const wk = waterKindByPid(pid);
  if (!wk) return null;                     // 不是水（陆地）→ 交给原路
  if (g === 'ck3') return '';               // ① CK3 的水：不给予标记
  if (g === 'hoi4') {                       // ③ HOI4 的 prov / state 水域 → 战略区名
    const nm = hoi4WaterName(pid);
    if (nameIsMeaningful(nm)) return String(nm);
    return categoryNameOf(wk, '') || '';
  }
  if (wk === 3 && !(g === 'ck2' || g === 'eu4' || g === 'eu5')) return '';   // ② 那三家之外的湖
  const real = realNameFromTables(pid);
  if (nameIsMeaningful(real)) return String(real);
  return categoryNameOf(wk, '') || '';
}

/**
 * 悬停两行的唯一出处（卡片与侧栏均使用，依据规格表）。
 *
 *   规格表（按类型）：
 *     荒地：CK3 → 第一行「不可通行区域」，第二行无
 *           CK2 / EU4 / EU5 → 以最低单位为单位显示名称，第一行为其名称，第二行无
 *           VIC3 / HOI4 → 无此设定，走陆地那条（目前层级 + 最低层级）
 *     河流：CK2 / CK3 → 第一行「河流」，第二行无；CK2 的河显示其名字（与其湖一致），CK3 仍为「河流」
 *           其他游戏无此设定，走水域
 *     湖泊：CK2 / EU4 / EU5 显示名字；CK3 / HOI4 / VIC3 显示「湖泊」
 *     水域：CK2 / VIC3 → 最低单位名称，第一行其名称，第二行无
 *           CK3 → 第一行「海洋」，第二行无
 *           EU4 / EU5 → 按层级显示第一行，第二行为最低单位名称
 *           HOI4 → 第一行为所属战略区名称，第二行无
 *
 *   返回 `{ a, b, kind }`：a = 第一行，b = 第二行（'' = 不显示）。
 *   占位号（`#281` / `#8613`）不得出现在任何一行（走 realNameAtTier 校验）。
 *   左侧栏另有一处：EU4 / EU5 的海走层级链，见 `sidebarUsesChain`。
 */
function hoverTileLines(pid) {
  const none = { a: '', b: '', kind: '' };
  if (!pid) return none;
  const T = state.titles || {};
  const meta = state.meta || {};
  const _g = String(meta.game || '');
  const fineTid = state.hover.tids[TIER_COUNT - 1];

  /* ---- 先判类别，再决定"目前层级"是哪一层 ----*/
  const isWaste = isWastelandTile(pid, fineTid);
  const isWater = !isWaste
    && (isWaterHere(pid, fineTid) || kindOfPid(pid) >= 2);
  /* 水 / 荒地 → 剧本 / 粒度那一层（「根据层级」：直接看 `state.tier`）。
 *   陆地 → `viewTierFor`（有主按视图层，无主按最低层）。
 *   不可用一个 tier 通吃：水的 `viewTierFor` 会把剧本层拉到最低层，「根据层级」即失效。
 *   也不可用 `editTier`：它优先粒度（粒度=省份时水就不跟层级了）。
 *   要求为「跟层级」：逐层扫第一行，每层一个名字。
 */
  let t = (isWaste || isWater) ? (state.tier | 0) : (viewTierFor(pid) | 0);
  if (t < 0 || t >= TIER_COUNT) t = TIER_COUNT - 1;

  const curName = realNameAtTier(pid, state.hover.tids[t], t) || '';
  const fineName = realNameAtTier(pid, fineTid, TIER_COUNT - 1) || '';
  const typeLabel = (k) => TYPE_LABEL[k] || '陆地';
  /* 类别名（河 / 湖 / 海 / 不可通行）：
 *   水 / 荒地的 kind 需按其口径再定一次：`kindOfPid` 是「底层身份标」，而「每层一片」之后最细层的键可能是 `wl_<地块号>`（荒地）或 `#sea_b_*`（海）。
 *   老包无该标时无法识别，故先按最细层的键补判一次（与 `waterKindOf` 同一套）。
 *   不可通行海域（码 5）与不可通行区域（码 6）是两回事。
 *   `CATEGORY_NAME` 表的天然顺序为先 5 后 6，直接查表最准。
 */
  const _fineKey = String((T.keys && T.keys[fineTid]) || '');
  let _kind = kindOfPid(pid);
  if (isWaste || isWater) {
    /* 身份标无法识别（码 1）或该地块无此标 → 按类别口径确定一次 */
    if (_kind === 1) _kind = isWaste ? (isImpassSeaKey(_fineKey) ? 5 : 6) : waterKindOf(pid);
    /* 荒地还需再核一次：部分包给逐块荒地的码是 1（实测 CK2 / EU4 / CK3 均如此）。 它实际为不可通行，不得退成「陆地」那类类别名。
 */
    if (isWaste && _kind < 5) _kind = isImpassSeaKey(_fineKey) ? 5 : 6;
  }
  const kindLabel = typeLabel(_kind);

  /* ---- ① 荒地 ----*/
  if (isWaste) {
    /* CK3 的不可通行按类别命名。
 *   判据为 `CATEGORY_NAME[码]`：不可通行海域为码 5、不可通行区域为码 6，
 *   两者本应为同一个词；若第一行固定写「不可通行区域」，
 *   则不可通行海域那一格第一行为「区域」、第二行为「海域」，自相矛盾。
 *   现两侧均走 `kindLabel`（CK3：不可通行海域 → 不可通行海域，
 *   普通荒地 → 不可通行区域）。
 */
    if (_g === 'ck3') return { a: kindLabel, b: '', kind: 'waste' };
    if (_g === 'ck2' || _g === 'eu4' || _g === 'eu5') {
      /* 以最低单位为单位显示名称：最低单位无名字才向粗层退。
 *   （EU5 的「北极群岛」就在最细层那个真头衔上，靠 `fineName` 取得；`curName` 为备用：万一该格在最低层无节点。）
 */
      return { a: fineName || curName || kindLabel, b: '', kind: 'waste' };
    }
    // VIC3 / HOI4：无此设定 → 掉到下面陆地那条
  }

  /* ---- ② 水（河 / 湖 / 海）----*/
  if (isWater) {
    const wk = waterKindOf(pid);
    const label = typeLabel(wk);
    if (wk === 4) {                                   // 河
      /* 第二轮变更：CK2 的河显示其名字
 * CK2 与它的湖同等处理（显示名字，悬停同理）；
 * CK3 不变（仍显示「河流」）。
 */
      if (_g === 'ck2') return { a: fineName || curName || label, b: '', kind: 'river' };
      if (_g === 'ck3') return { a: '河流', b: '', kind: 'river' };
    } else if (wk === 3) {                            // 湖
      /* 有名字则输出名字（CK2 已接入；EU4 / EU5 始终有此表）
 * 其余（CK3 / HOI4 / VIC3）仅给类别名「湖泊」
 */
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

  /* ③ 陆地（含 VIC3 / HOI4 的「荒地」）。
 *
 * 第一行优先级：
 *   「对待陆地时，第一行的内容优先为涂色，其次为所在剧本；若无剧本，第一行优先为涂色，其次为所属层级的地名。」
 *
 *   ① 涂色名：该地块已被玩家涂过，报涂色名。来源与 `renameAt` 同口径：`state.provLabel[pid]` → `state.labelNames[]`（涂过的地自带标记号，未涂的没有，不按颜色推断）。
 *   ② 剧本名：该图有国家层时，报其在剧本层的势力名。`countryTier` 即「最近的有主剧本层」；CK3 标了 `noCountryLayer` → 返回 -1 → 落到 ③（对应「若没有剧本」）。
 *   ③ 所属层级的地名：视图层 → 最低层。
 */
  const _pd = renderer && renderer.paintData;
  const _painted = !!(_pd && _pd.length > pid * 4 + 3 && _pd[pid * 4 + 3] > 0);
  let _paintName = '';
  if (_painted && state.provLabel) {
    const _lid = state.provLabel[pid] | 0;
    if (_lid >= 0) {
      const _nm = String(state.labelNames[_lid] || '');
      _paintName = isBlankLabel(_nm) ? '' : _nm;   // 占位符 = 明确留空 别把零宽字符塞进卡片
    }
  }
  /* 仅「剧本层开启」时使用剧本名。
 *
 *   「开启」= 当前视图停在剧本层（`state.tier < eraTierCount`）。玩家查看年份层时关注「这是哪个国家的地」，报剧本名；切到地理层（地区 / 省份 / 地点）后需要的是该层名字，此时再出现国家名即为错误（层级与归属是两件事）。
 *
 *   不可单独用 `countryTier` 判断：它在细层也会返回「最近的剧本层」，那是给取色 / 荒地取身份用的口径，与「界面当前是否显示剧本」不同。
 *   涂色名永远优先，与是否显示剧本无关（由玩家绘制）。
 */
  let _eraName = '';
  {
    const _nEra = eraTierCount();
    const _eraOn = _nEra > 0 && state.tier >= 0 && state.tier < _nEra;
    const _ct = countryTier();
    if (_eraOn && _ct >= 0 && _ct < TIER_COUNT && _ct !== t) {
      _eraName = realNameAtTier(pid, state.hover.tids[_ct], _ct) || '';
    }
  }

  const fine = realNameAtTier(pid, fineTid, TIER_COUNT - 1) || '';
  const a = _paintName || _eraName || curName || fine || typeLabel(kindOfPid(pid));
  /* 第二行：给出「再细一级 / 次一级」的名字，与第一行重复则留空。
 *   （第一行规则已定；第二行含义为最低单位名优先，不退到粗层充数，否则会出现 `韦斯特比格德/丹麦` 这类反序结果。）
 */
  /* 第二行不再「同词即隐藏」：
 *   第一行与第二行同名时隐藏第二行，会使卡片突然变矮，看似少一层信息；
 *   现照常显示，仅空字符串不显示（确实无名字）。
 */
  let b = fine || (curName && curName !== a ? curName : '');
  return { a, b, kind: 'land' };
}

/* 拼接 innerHTML 前转义游戏数据中的尖括号与引号（名字来自外部数据） */
function _escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 左侧栏该格是否列出层级链。
 *
 *   规则：悬停时左侧栏，荒地 / 湖泊 / 河流照旧；EU4 / EU5 之外的海域照旧；EU4 / EU5 的海域与陆地一样显示其层级。
 *
 *   → 仅 EU4 / EU5 的海（`waterKindOf === 2`；河 / 湖不算，属「照旧」那条）走下方层级链；其余背景地块走 `hoverTileLines` 的两行。
 *
 *   判据用 `waterKindOf(pid) === 2`，不直接看 `kindMask` 的码：老包无该标，`waterKindOf` 两个来源均可兜住（键前缀 + 身份标）。
 *   不可通行海域（CK3 的 `#impassable_sea`）归荒地那条，不是海（`isWastelandTile` 已将其归入，此处先判一步）。
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
  /* 这个函数没有 pid 参数，使用 `state.hover.pid`
 *   （误写成裸 `pid` 会抛 `ReferenceError: pid is not defined`， 导致悬停卡片不可用。）
 */
  const info = titleInfo(state.hover.tids[viewTierFor(state.hover.pid)]);
  const rect = $('stage').getBoundingClientRect();
  // 背景地块（海/湖/河/不可通行）同样显示，不特殊隐藏
  const _special = !info || isSpecialTid(info.tid);
  const _fineHoverTid = state.hover.tids[TIER_COUNT - 1];
  /* 荒地的悬停色块也读自动上色写进 LUT 的那份
   *   EU5 的 `titles.colors` 是省份位图技术色（1818 块五颜六色），直接取会跟画面不一致*/
  const col = _special
    ? ((isWastelandTid(_fineHoverTid) && renderer && renderer.lutData)
      ? [renderer.lutData[_fineHoverTid * 4], renderer.lutData[_fineHoverTid * 4 + 1],
         renderer.lutData[_fineHoverTid * 4 + 2]]
      : state.titles.colors[_fineHoverTid])
    : (liveColorOf(state.hover.pid, info.tid) || state.titles.colors[info.tid]);
  /* 那两行整体交给 `hoverTileLines`。
 * 
 * 拼装逻辑统一收口于 `hoverTileLines`（「有名字给名字、水给类别名」不再各自实现），
 * 与按类别、按游戏给出的规格表一致。
 * 
 * 此处只负责颜色与位置，两层文字一律不在此处修改。
 * 两类遗留问题的判据保留在 `nameIsMeaningful` / `isWastelandTile` /
 * `waterKindOf` 中（编号不上屏；类别需逐层找键）。
 */
  const _hpid = state.hover.pid;
  const lines = hoverTileLines(_hpid);
  const nm = lines.a || '—';
  const sub = lines.b || '';
  /* 类别判据须「从最细层往粗层找键」。
 *   CK3 数据无 `kindMask`（该包生成时尚未引入 kindMask），
 *   只能按键名前缀判；而最细层的键是 `wl_<地块号>`（荒地）
 *   或 `#sea_b_2218`（海），均非类别前缀。
 *   仅判最细层时：海与荒地都会被判成陆地，第一行会漏出 `#1464` 这类编号。
 *   → 往粗层找到第一个类别键（`#sea` / `#lake` / `#river` / `#impassable*`）
 *   或 `wl_` 即止；该逻辑收在 `isWastelandTile` / `waterKindOf` 中
 *   （旧包的 `kindByKey` 只认最细层，已补上「逐层找」）。
 */
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

/** `meta.provColors` → RGBA8 字节（每块地自己的原色）
 *
 *  base64 的 `numProvinces × 4` 字节（第 4 个字节 = 这块地有没有登记色）
 *  没这个字段 / 长度对不上 → null（老包、还没接线的游戏）
 *    只解进 state 备查 前端不再拿它做水域显示特判*/
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
 * 
 * 水域标签（`meta.waterMask` 解出的 Uint8Array）。
 * 
 * base64 的 `numProvinces` 字节（每地块 1 字节：1 = 水，0 = 非水）。
 * 现仅解进 `state.waterMask` 备查。
 * 着色器不再用它作「认水」标签（颜色 / 边界特判已废弃）；
 * 前端 `isWaterPid` 仍从它查询（判据保留，废弃的只是特判用途）。
 * 无此字段 / 长度不符 → null（旧包）。
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
 * 底层地块身份标（`meta.kindMask` 解出的 Uint8Array）。
 *
 *   base64 的 `numProvinces` 字节（每地块 1 字节，与 `waterMask` 同口径）。
 *   码：1 陆地（兜底）/ 2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域 / 6 不可通行区域。
 *
 *   无归属区域不在其中：归属由剧本 / 归属决定，非地块身份，
 *   仍按运行时计算（见设置项 `set-unpainted`）。
 *   无此字段 / 长度不符 → null（旧包），类别判据退回键名前缀，数据不做改动。
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

/** 类别码 → 设置里那一行的键 （1 陆地没有颜色行：陆地照旧用它自己的颜色）*/
const KIND_SETTING = { 1: null, 2: 'sea', 3: 'lake', 4: 'river', 5: 'isea', 6: 'impass' };

/** 七行的出厂色 （跟 `index.html` 那七行、跟 `build_data.py` 的类色一字不差）*/
const NATURE_RGB = {
  impass: [94, 94, 94], sea: [32, 57, 92], isea: [26, 46, 71],
  lake: [47, 110, 150], river: [62, 136, 181],
};

/** 某一行的当前颜色（设置里没设过 → 出厂色）*/
function natureColor(key) {
  const c = (state.set || {})[key];
  return c || NATURE_RGB[key] || [150, 150, 150];
}

/** 老包那条路：按键名前缀认类别 （没有 kindMask 的时候才走）
 *   `#impassable_sea` 必须判在 `#impassable` 前面 （它俩是前缀关系）*/
function kindByKey(key) {
  const s2 = String(key == null ? '' : key);
  if (s2.indexOf('#impassable_sea') === 0) return 5;
  if (s2.indexOf('#impassable') === 0) return 6;
  if (s2.indexOf('#river') === 0) return 4;
  if (s2.indexOf('#lake') === 0) return 3;
  if (s2.indexOf('#sea') === 0) return 2;
  return 1;                                   // 其余都算陆地 （兜底 不许有空洞）
}

/**
 * `kindMask` → 头衔号 → 类别码（懒建一次、换图重建）
 *   同一片水在不同层是不同节点 → 每层都登记（同一个 tid 只记一次）
 *
 *  层数必须读 `meta.tiers.length`，不可读 `TIER_COUNT`
 *     `TIER_COUNT` 是模块变量，初值 5（按 CK3 五级编写），
 *     需等 boot 靠后那句 `TIER_COUNT = TIER_KEYS.length` 才变为真值。
 *    后果（实测，`_local/_dbg_kindoftid.js` 输出）：
 *      · EU5（6 层）→ 循环只到第 4 层，最细的 `loc` 层 5709 个 tid 未登记
 *      · CK3（7 层）→ 只到第 4 层，`c` / `b` 两层遗漏
 *    表现：最细层的水名被判成陆地，即「关闭水名开关后仍有水名」。
 *    `titleAt(p, t)` 按 `state.meta.numProvinces` 索引，不受影响；
 *      仅此循环上界变量有误，故症状为「缺少后面几层」而非「全部错位」。
 *    「旧包无 kindMask」不属此条：此时 `m` 为空，
 *      `kindOfTid` 退回 `kindByKey(键)`。
 */
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
      if (!k || k === 1) continue;            // 陆地不登记（兜底 颜色不动）
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

/**
 * 类别名表（身份标码 → 中文类别名） 顺序为先不可通行海域（5）再不可通行区域（6）（既定规则）
 *    1 = 陆地：没有类别名 （陆地照旧显示自己的头衔名）
 */
const CATEGORY_NAME = { 2: '海洋', 3: '湖泊', 4: '河流', 5: '不可通行海域', 6: '不可通行区域' };

/** 类别码 → 这一类的名字（悬停卡片 / 侧栏走同一处 `label` 那张表跟类别名同源）
 *   `label` 只在 `_dataName` 合格（不是占位 / 不是空）时才用
 *     CK3 的逐块节点名那一列里躺着 `#10228` 这种占位号，拿它兜底 = 把编号放上屏*/
function categoryNameOf(kind, label) {
  return CATEGORY_NAME[kind] || (!isPlaceholderName(label) ? String(label || '') : '');
}

/**
 * 该名字是否值得上屏。
 *
 *   三条判据（缺一条都会有内容漏出）：
 *     ① `readablePlaceName`：机器串 / 全大写 / 纯小写键名不算人名地名（CK3 的 `Siberian Wastes`、HOI4 的 `p_13254` 属此列）
 *     ② `isPlaceholderName`：`#281` / `#u12` / 纯数字（任何一行都不显示编号）
 *     ③ `isPseudoCategoryName`：「海洋」「不可通行山地」这类类名不作为该格名字；地形节点（`#sea_all_1066`）的名字即类名，作为「最低层级信息」无意义；需要类名处走 `categoryNameOf`（另一条路径，不受本判据约束）
 *   不额外判断「是否含中文」：CK2 的 259 条水名中混有拉丁字母（如基克拉格斯群岛一类地名），属真名，不应按机器串丢弃。
 *   不可用于筛类别名：`categoryNameOf` 的结果应原样使用；若让 `nameIsMeaningful` 放行类名，「海洋」那一格的第一行会掉成 `#114514` 这类编号（现由本条挡类名、`categoryNameOf` 给类名，各司其职）。
 */
function nameIsMeaningful(nm) {
  const s = String(nm == null ? '' : nm).trim();
  if (!s) return false;
  if (isPlaceholderName(s) || isPseudoCategoryName(s)) return false;
  return readablePlaceName(s);
}

/**
 * 占位名（`#6586` / `#u12` / 纯数字 / 空）不得原样出现在任何一行。
 *   规则：第二行不得出现编号；HOI4 的 st/pr 不得出现 `#3004`。 仅判断是否为占位名，不判断名字内容是否像中文。
 */
function isPlaceholderName(nm) {
  const t = String(nm == null ? '' : nm).trim();
  return !t || t.charAt(0) === '#' || /^u?\d+$/i.test(t);
}

/** 从真名表里取这一块的真名
 *
 *   `meta.seaNames` / `meta.wastelandNames` / `meta.seaNamesByTier[]`
 *   键是地块号的字符串 （`"936"` 那种 两种写法都试一遍 别只试一种）
 *   CK2 就是这条救回来的：数据里 259 条水名 / 20 条荒地名都在
 *     可 `titles.names` 里那一片只剩 `#936` 占位 → 不查表就显示占位号
 *   占位名 / 类名（"海洋"那种泛称）都不算真名*/
function realNameFromTables(pid) {
  const M = (state && state.meta) || {};
  const keys = [String(pid)];
  /* 部分包中表按节点号存储（`titles.names`），此类不在此处处理。 此处仅处理「地块号 → 名字」的表。
 */
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

/**
 * 地块的分类（底层 pid 的身份，与所在层 / 有无归属无关）。
 *   有 `state.kindMask` → 查它（权威）。 旧包 → 退到最细层节点的键前缀（`kindByKey`；
 *   `#impassable_sea` 先于 `#impassable` 判断，判序正确）。
 */
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

/**
 * 「每省是否为水」表，供「水域 · 边界」通道使用。
 *
 *   口径（见 handover §3.1）：水域边界管理水域之间的缝。着色器逐像素判断，拿不到 pid 键名，也读不了 meta；故 CPU 侧先遍历 `numProvinces` 存为 `Uint8Array`，再传为纹理。
 *
 *   判据只用 `waterKindByPid`（不另写一套）：该函数即「身份标最权威 → 旧包退回 `#` 键」的完整口径（0 = 非水 / 2 海 / 3 湖 / 4 河 / 5 不可通行海域）。
 *   不缓存：仅换图（载入新 meta）时计算一次；一个 Uint8Array 遍历 numProvinces（EU5 四万多个约几毫秒），缓存会引入「换图后仍用旧表」的问题。
 *   与 `kindMask` 不同：后者表示「最底层是什么」（含陆地 1 / 荒地 6），本表表示「能否认出是水」（含旧包的键前缀退路）；`waterKindByPid` 即先查 kindMask、再退回键，两级一致。
 *
 *   @returns {Uint8Array|null} 长度 = numProvinces（第 0 格不用，恒 0）
 *
 *   不再顺带收集「哪些头衔沾水」表：
 *   项目内已有按 tid 查询的 `kindOfTid(tid)`（`kindTidMap` 扫每层 + 旧包退回键前缀，判据更全且自带缓存，见 `_isWaterLabel`）。
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
  /* 本次仅输出「纹理表」。
 *
 *   此处不再顺带收集 `state.waterKindSet`（所有层 tid 并集）。该 Set 原用于标签闸按 tid 判断「该头衔是否沾水」，并为收全而增加一圈逐层循环（`for t < nTier`）。
 *   该 Set 属冗余：项目内已有 `kindOfTid(tid)`（`kindTidMap` 扫每层 + 旧包退回键前缀，判据更全）。故 Set 与该圈内层循环一并删除，标签闸改问 `kindOfTid`（省去每块水 × 层数 次 `titleAt` 与一个数千条的 Set，并消除「两份 tid→水 表可能不一致」的隐患）。
 *   `out` 纹理表保留：着色器逐像素判断、拿不到 tid，它是 `waterKindArr` 的唯一来源（见 setWaterKindMask）。
 */
  /* 一个水都没有 → 当"这张图算不出水陆" （跟老包一个待遇）
   *   于是 `waterIs` 恒 false → 水域通道 + 两条让位一起退化成现状
   *   （正常地图不可能全陆地，走到这儿基本就是"认水的判据全落空"
   *     那种图上再画"水域边界"只会画出假缝 宁可让它整条让开）*/
  if (!any) return null;
  return out;
}

/**
 * 一个头衔属于哪一类：判据收敛于此 有 `state.kindMask` → 查它（权威，底层 pid 的身份，切层 / 切剧本不变）
 *   旧包 → 退回键名前缀（`#sea` / `#lake` / `#river` / `#impassable_sea` / `#impassable`）
 */
function kindOfTid(tid) {
  if (tid == null || tid === NO_TITLE || !state.titles) return 1;
  if (state.kindMask) {
    const k = kindTidMap().get(tid);
    if (k) return k;
  }
  return kindByKey(state.titles.keys[tid]);
}

/**
 * 把七行颜色刷进 LUT。
 *
 *   走 LUT（`renderer.setLutColor`，与 `paintWasteGrey` 同手法），
 *   因此改设置立即生效，无需重烤包。
 *   仅刷有颜色行的几类（海 / 湖 / 河 / 不可通行海域 / 不可通行）。
 *   陆地仍用自身颜色：「陆地标记」指 `kindMask` 中码 1（身份标），
 *   不是把陆地涂成单一色。 旧包（无 kindMask）→ 按键名前缀扫一遍节点，行为与既有实现一致。
 */
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
 * 地块当前在屏幕上显示的颜色
 *
 * 手绘层优先，其次为头衔自身的色：取色取的是实际显示的颜色，
 * 而非头衔理论颜色。两者不一致时（如伯爵领视图涂色后切到帝国视图），
 * 按头衔取色会取错。
 */
function displayedColor(pid, tid) {
  // 跟着色器同一个优先级，取"这块地此刻显示的颜色"。
  // 顺序：手绘层(开关) → 未上色兜底 → 头衔色 / 背景。
  const fine = state.meta.tierNames.length - 1;
  const own = pid ? titleAt(pid, fine) : NO_TITLE;

  /* 顺序必须与着色器 colorOfPid 逐条对齐（否则涂色后取不到色）
 * 着色器侧修正过一次，但仅改着色器，取色侧遗漏。
 * displayedColor 与 colorOfPid 是同一函数的两份实现，
 * 修改任一边都必须同步另一边。
 * ① 手绘层：最优先（水片 / 荒地片现与普通头衔一样可涂，涂后即显示涂色）
 */
  const pd = renderer && renderer.paintData;
  if (state.showPaint && pd && pid && pd[pid * 4 + 3] > 0) {
    return [pd[pid * 4], pd[pid * 4 + 1], pd[pid * 4 + 2]];
  }
  /* ①″ 荒地自动色。 荒地读最细层 `wl_` 节点的 LUT（粗层为同名几块共用）。
 *   必须在下文 `kindMask` 分支前处理：
 *   部分图中荒地底层身份为 6，先走身份分支会变成类色。
 *   LUT 的 alpha = 255 才是荒地标记，与 `setWasteFixed` 对齐。
 */
  if (pid && isWastelandTid(own) && renderer && renderer.lutData) {
    const l = renderer.lutData;
    return [l[own * 4], l[own * 4 + 1], l[own * 4 + 2]];
  }
  /* ①′ 底层身份覆盖：
 *     是否上色取决于具体最底层单位的类别。
 *     水 / 不可通行（kind 2~6）不论在哪一层、有无片、有无归属均给类色。
 *     必须与着色器同步：`displayedColor` 与 `colorOfPid` 是同一函数的两份实现，只改一边会导致吸管 / 悬停取色与画面不一致。
 *     `kind == 1`（陆地）→ `KIND_SETTING[1]` 为 null → 走原有分支，行为不变。
 *     旧包无 `state.kindMask` → 整条跳过，行为不变。
 */
  if (state.kindMask && pid) {
    const _ksk = KIND_SETTING[state.kindMask[pid]];
    if (_ksk) return natureColor(_ksk).slice();
  }
  // ② 没有头衔的地块：固定灰
  if (tid === NO_TITLE || tid == null || !state.titles.colors[tid]) {
    return [150, 150, 150];
  }
  // ④ 头衔色：地形（海/湖/荒地这些，t >= 真实头衔数）永远看得见
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
 * 分组 / 身份使用的稳定色：涂过则用涂色，否则用头衔自身的颜色。
 *
 *   不使用 displayedColor：它会随「头衔 · 颜色」等显示开关变化。若用它拼身份串，关闭国家颜色会使原版国家全部变为背景灰，与玩家涂的同一块地分成两组，表现为「同一个国家名出现两个」。
 *   吸管等「看到什么取什么」的场合仍用 displayedColor。
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

/** 一个地块此刻显示的标记名（手绘层的标记优先，否则用头衔名）*/
function displayedLabel(pid, tid) {
  if (state.provLabel && pid > 0) {
    const lid = state.provLabel[pid];
    /* 有标记位则以它为准，包括占位符（明确无名字 → 返回空）。 不得再回退到原版头衔名，否则无法区分「涂过但留空」。
 */
    if (lid >= 0) {
      const nm = String(state.labelNames[lid] || '');
      return isBlankLabel(nm) ? '' : nm;
    }
  }
  // 改名工具改过的头衔：优先用它
  if (state.titleName && tid !== NO_TITLE && tid != null && state.titleName.has(tid)) {
    return state.titleName.get(tid);
  }
  return tid === NO_TITLE ? '' : state.titles.names[tid];
}

/**
 * 取色。取的是「这块地此刻显示的颜色」
 *
 * @param {number} pid 地块，用来查手绘层
 * @param {boolean} switchToPaint 取色后是否切换到涂色工具
 */
/* 取色（吸管）：遵循玩家在屏幕上看到的颜色。
 *
 *   不使用「纯色」方案（涂过的取涂色、未涂的取 LUT 原色）：
 *   吸管应返回「眼睛看到的颜色」，屏幕色已掺入地形 / 底图层（见 displayedColor）。
 *
 *   再四舍五入为整数 RGB：
 *   屏幕色为计算结果，常带小数（如 189.7 / 20.4 / 65.2）；
 *   小数进入画笔会使涂色与原色有微小差异，而边界判据严格比较 RGB，
 *   从而多画出边界线。取整后消除该差异（HEX 格显示的亦为整数值，两侧一致）。
 */
function pickTitle(tid, switchToPaint = false, pid = 0) {
  // 颜色：取屏幕所见颜色（`displayedColor` = 屏幕上该格的颜色）
  // 「填色·颜色」「头衔·颜色」「荒漠·涂色」这些开关它全都算进去了）
  const _raw = displayedColor(pid, tid) || [0, 0, 0];
  const _c255 = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  const col = [_c255(_raw[0]), _c255(_raw[1]), _c255(_raw[2])];
  setBrush(col, true, true);        // 取色后同时切换到绘图工具

  /* 名字：直接解析该格自身信息（不手拼三处状态）。
 *
 *   原则：
 *   · 开剧本 → 涂过色用涂色标记名，未涂用剧本归属国家的名字
 *   · 未开剧本（省份 / 地区层）→ 用对应级别名字（省名、地区名）
 *   `tid` 由 `actAt` 按视图层取得（吸管只看当前视图）。上述两条无需在此分情况：`displayedLabel` 已按该顺序给出（同时把「改名工具改过的头衔」排在前面）。
 *
 *   水 / 荒地另有一套：
 *   · CK3 的水与荒地 → 不给标记（不以 `#10228` 这类占位号作标记）
 *   · 湖：仅 EU4 / EU5 / CK2 给名字，其余不给标记
 *   · HOI4 的水 → 给战略区名（如白令海）
 *   · 其余水 → 真名表 → 类别名（海洋 / 湖泊 / 河流 / 不可通行区域）
 *   判据收在 `pickMarkerName` 一处。
 */
  const _mk = pickMarkerName(pid, tid);
  setBrushLabel(String((_mk != null ? _mk : displayedLabel(pid, tid)) || '').trim());

  // 不弹提示：左侧画笔卡片实时显示颜色与标记，即为反馈。
  // 每次取色均弹提示时，右键连点会铺满屏幕
  if (switchToPaint && state.tool !== 'paint') setTool('paint');
}

/** 右键取色：不管当前是哪个工具，右键点一下就能把这儿的色吸走，并切到涂色*/
/**
 * 给每块地写入其「标记编号」（不只涂过的）。
 *
 *   标记 = 名字（面板中该格）。未涂过的地，标记为其原版国名；
 *   涂过的地，标记为填入的名字。这样「原版那块」与「涂出来的那块」
 *   在着色器中编号相同 → 高亮、边界两侧口径一致。
 *   （未涂的地编号为 0 会与涂出来的对不上，被判成两个国家。）
 */
function syncAllPaintLabels() {
  if (!renderer || !state.meta || !state.titles) return;
  const n = state.meta.numProvinces;
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  /* 记录色块的单位 = province，标记也给每块地标上
 *
 *   标记看哪一层：
 *   · 开剧本 → 标记取该剧本（除非切换到另一剧本）
 *   · 无剧本 → 用当前视图那一层
 *   「该剧本」= 离当前视图最近的那个剧本层（视图停在细层时不被粒度带走）。
 *
 *   取层时有两个错误做法：
 *   ① 用 `state.tier`（视图停在细层时不再是剧本，与「该剧本」不符）
 *   ② 用 `editTier`（会掺入粒度，而粒度在此处不适用）
 */
  const ct = countryTier();          // 该剧本 = 最近的有主剧本层 （空白剧本不算）
  /* 逐块地取"它自己"的归属 （一个州半边日本半边中国 → 5 块日本 5 块中国）
 *   绝不能按州整体给一个名字 也绝不能取不到就写 0
 *   （「标记被清空」即此 0）
 *   → 取不到就退到最底层单位那一层 绝不再出现 0
 */
  const FINE = Math.max(0, ((state.meta.tierNames && state.meta.tierNames.length) || 1) - 1);
  for (let pid = 1; pid < n; pid++) {
    let nm = String(displayedLabel(pid, titleAt(pid, ct)) || '');
    if (!nm) nm = String(displayedLabel(pid, titleAt(pid, FINE)) || '');   // 兜底：最底层单位
    renderer.setPaintLabel(pid, nm ? Math.min(labelIdOf(nm) + 1, 65535) : 0);
  }
  state._lblPassKey = ct + '|' + (state.painted ? state.painted.size : 0)
    + '|' + ((state.labelNames && state.labelNames.length) || 0);
}

function pickAt(clientX, clientY) {
  const [mx, my] = screenToMap(clientX, clientY);
  const pid = provinceAt(mx, my);
  if (!pid) return;
  // 同样取视图层：取的是画面上此刻的颜色。
  const tid = titleAt(pid, state.tier);
  /* 取色不受 isLocked 拦截（空白剧本下同样可取色）
 *   该层地块几乎全为无主地（tid = NONE），而 isLocked(NONE) = true，
 *   会拦截整个取色；其他层 tid 为真实头衔，故仅空白剧本受影响。 取色只读取画面颜色，不修改数据，无需加锁。
 *   实际给色的是 pickTitle → displayedColor(pid, tid)，
 *   它先看手绘层，涂过的地一定能取到对应颜色。
 */
  pickTitle(tid, true, pid);
  if (state.hover.inside) {
    renderHoverCard(state.hover.pid);
    positionHoverCard(clientX, clientY);
  }
}

/**
 * 这块地值不值得还原
 *
 * 只看两件事：现在是不是原色、手绘层有没有记过它。
 * 仅凭集合判断不够（`!painted.has(tid) && !changed.has(tid)`）：
 * 某个环节未记入 tid（取色后涂回原色容易漏）时，还原工具会无响应。
 */
function needsRestore(tid) {
  // 还原 = 清掉玩家的涂色，不是把颜色改回原色。
  // 判据只有一个：该地块是否被玩家涂过，与「颜色是否恰好等于原色」无关。
  // 玩家完全可以涂一个跟原色一样的色（吸自己的色再涂回去）
  // 该情况属于「涂过了」；若判为无需还原，则点击无效、无法擦除。
  return state.painted.has(tid);
}

function actAt(clientX, clientY) {
  /* 旗帜不从这里走
 * 桌面端在 `mousedown` 中已接管 flag（见 `state.tool === 'flag'` 那段）
 * 手机端抬手时总会补一次 `actAt` → 点击旗帜时还会弹出悬停卡
 * 此处拦截，保证手机端贴旗操作干净（桌面端本不进入此路径）
 */
  if (state.tool === 'flag') return;
  const [mx, my] = screenToMap(clientX, clientY);
  const pid = provinceAt(mx, my);
  if (!pid) return;
  // 取色取的是画面上这一刻的颜色，而配色永远来自视图那一层
  // 所以粒度换到省份时，吸管吸的仍是 1444 的那个国色
  // 涂色和还原才是按粒度落笔的
  let tid = titleAt(pid, state.tool === 'pick' ? state.tier : editTier());
  // 粗层点到荒地：换掉这个共享伪头衔，改成"光标底下这一块"自己的节点。
  // 每块荒地只在最细那层有自己的节点（粗层共享一片）
  // 不这么换的话，粗层那一笔会把整片荒地一起涂上。
  // 手绘层是按省份记的，所以这一笔在所有层级都能看见。
  {
    if (state.tool !== 'pick' && isWastelandTid(tid)) {
      const _own = titleAt(pid, state.meta.tierNames.length - 1);
      if (_own !== NO_TITLE && isWastelandTid(_own)) tid = _own;
    }
  }
  // 粗层点到无主地（空白剧本那一层全是无主地，1444 那种没归属的地也一样）：
  // 该层没有归属，但地块仍存在：笔与光标均按「光标底下这一块」的最细层处理。
  //（跟上面荒地那条同一个道理：粗层没有可分的东西，就往细处落）
  if (state.tool !== 'pick' && (tid == null || tid === NO_TITLE)) {
    const _own2 = titleAt(pid, state.meta.tierNames.length - 1);
    if (_own2 != null && _own2 !== NO_TITLE) tid = _own2;
  }
  /* 取色例外，见 pickAt 中说明。
 *   水的那四类禁止上色。
 *   判据按地块号执行，pid 必须传入（即使拿到的是粗层 `#sea_*` 片的 tid，也照样锁定）。
 */
  if (state.tool !== 'pick' && isLocked(tid, pid)) return;

  if (state.tool === 'rename') { openRename(pid); return; }
  if (state.tool === 'pick') {
    pickTitle(tid, false, pid);
  } else if (state.tool === 'paint' || state.tool === 'fill') {
    // 「涂抹」和「填色」的范围算法完全一样 （都走 `paintAt`）
    // 差别只在"按住拖动要不要沿路连发"：涂抹要、填色不要（见 mousedown 那儿的 painting）
    paintAt(pid, tid);
  } else if (state.tool === 'erase') {
    // 两种口径，清的单位都是地块，而且范围跟涂色共用同一个函数
    //   · 剧本视图 + 没开粒度 + 编辑层在剧本那一层 → 走 `paintTargetsAt`：
    //     涂色归属 → 剧本归属 → 最低单位那一块（涂了什么就还原什么）
    //   · 其余情况 → 范围取编辑层那一块：在最细层点就只有那一格（只清它）
    //     在地区 / 州那一层点就清这一块包含的涂色（里面涂过的省份不用一个个点）
    const _nEraE = (state.meta.eraDates && state.meta.eraDates.length) || 0;
    const _eraErase = _nEraE > 0 && state.grain == null && editTier() < _nEraE;
    const _pdE = renderer && renderer.paintData;
    if (_eraErase && _pdE) {
      // 范围 = 涂色那一套（开关怎么读也在它里面，所以这儿不再自己判 showBorderPaint）
      const _tgt = paintTargetsAt(pid) || [];
      const _live = _tgt.filter((q) => _pdE[q * 4 + 3] > 0);   // 只清真有笔迹的地块
      paintPidsAsOne(_live, null);                             // 按地块擦（一条历史）
    } else {
      /* 范围 = 该格在编辑层的归属，把属于它的地块的玩家涂色清空。
 *
 *   与涂色对称：涂色也是「认出该格归属 → 展开成地块 → 按地块涂」
 *   （actAt 取 tid → paintAt → `paintPidsAsOne(pidsOf(tid))`，两侧同一套）。
 *
 *   不逐层收集该地块在所有层级上的头衔：
 *   否则在地区层涂一整块、切到省份层点还原时，地区头衔也在名单中，
 *   整块地区会被清空（表现为 4 个省份一起清掉）。
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
  recomputePainted();   // 账本重算 + 状态栏 "改动 N" 都在里面
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
// 年份视图（EU4 的 1444 / 1618 / 1800）中，颜色与「手动修改的地块」可以分离
//
// 颜色始终取 state.tier：画面始终为该年政治地图。
// 边界 / 悬停 / 笔刷取 editTier：默认与视图一致，也可切换到地区或省份。
//
// 于是可以"看着 1444 的归属，按省份一块一块改"。地图配色不跟着变
// 否则勾选省份后整张图会切为省份配色，导致底图颜色丢失

/* 顶部剧本层数量（数据中无剧本层则返回 0；当前每套数据均有，此行保留作兜底）。 */
function eraTierCount() {
  const m = state.meta;
  return (m && m.eraDates && m.eraDates.length) || 0;
}

/* 「空白剧本」在剧本块中的下标（无则为 -1），从数据读取（meta.tiers 中的 'blank'）。 */
function blankTierIndex() {
  if (state._blankTier === undefined) {
    state._blankTier = ((state.meta && state.meta.tiers) || []).indexOf('blank');
  }
  return state._blankTier;
}

/**
 * 剧本块层数 = 年份层 + 紧随其后的「空白剧本」。
 *
 *   不可用它替换 `eraTierCount`，两者含义不同：
 *    · `eraTierCount` = 「哪些层是有主的年份视图」（逻辑用：粒度 / 取色 / 涂色）
 *    · `eraBlockCount` = 「哪几层该收进剧本下拉栏」（UI 用）
 *   空白层不是年份视图（全无主），但属于剧本块的一部分；放在「视图」那一排会很怪（「空白剧本」四字像视图名），与年份一起收进下拉栏则合适。
 *
 *   实测：EU4 12 个年份 + 空白 = 13 → 地理层从第 13 层（大洲）开始
 *        CK3 1066 + 空白 = 2 → 地理层从第 2 层（帝国）开始
 */
function eraBlockCount() {
  const n = eraTierCount();
  const b = blankTierIndex();
  return (n > 0 && b === n) ? n + 1 : n;
}

/**
 * 剧本层该用下拉栏还是按钮
 *
 *   规则：剧本块 ≥4 个用下拉栏，1~3 个回退为按钮。
 *
 *   阈值按剧本块计数（年份 + 空白层，见 `eraBlockCount`）：
 *     · EU4 12 个 + 空白 = 13 → 下拉栏
 *     · HOI4 2 个 + 空白 = 3 → 按钮
 *     · VIC3 1 个 + 空白 = 2 → 按钮
 *     · CK3 1066 + 空白 = 2 → 按钮
 *     · EU5 1337 + 空白 = 2 → 按钮
 *
 *   不要用 `eraTierCount` 判断：EU4（12 个年份）为 12，HOI4 为 2，
 *     且不计空白层，少一层即会判错。
 */
function useEraDropdown() {
  return eraBlockCount() >= 4;
}

/**
 * 离当前视图最近的那个「有主」剧本层。
 *
 *   用途：细层视图下「这块地属于哪个国家」（更新国名 / 族的身份 / 名字落点）。
 *   停在剧本层时即该层自身；空白剧本也算自身（该层本就无主，
 *   因此在其中绘制的内容称为「自己的国」）。
 *
 *   不可写回 `min(tier, eraDates.length - 1)`：空白剧本挂在剧本块最右侧，
 *   细层视图下「最近的剧本」会变成空白层 → 原版国名 / 身份全部丢失。
 *   （空白层不在最后时（旧数据）该写法退回既有行为。）
 */
function countryTier() {
  /* 此图没有「国家层」：数据标了 `noCountryLayer` 则直接返回负值
 * 
 * CK3 空白剧本标它的原因：CK3 的帝国 / 王国 / 公爵领是封建头衔，不是国家；
 * 其「空白剧本」层全为无主（用于从零涂色）。
 * 不标时此处返回 blank 层 → 调用方扫描该层国家 →
 * 一个都扫不到（tid = -1）→ 取色 / 改名 / 图例均无数据。
 * 标注后返回 -1，调用方走「没有国家层」分支（与 CK3 无剧本时一致）。
 */
  if (state.meta && state.meta.noCountryLayer) return -1;
  const n = eraTierCount();
  if (n <= 0) return state.tier;
  if (state.tier < n) return state.tier;          // 停在剧本层：就是它自己
  const last = n - 1;
  if (blankTierIndex() === last && last > 0) return last - 1;
  return last;
}

/** 此刻动手按哪一层走*/
function editTier() {
  const n = eraTierCount();
  if (n === 0 || state.tier < 0 || state.tier >= n) return state.tier;
  if (state.grain != null) return state.grain;
  /* 改回「视图层」。
 *
 *   现象：「只开剧本不开粒度时，有主地块也出现了，且以最低单位出现」。
 *
 *   此处不能取「无粒度 → 最低层」：
 *   「剧本下高亮范围和名字应跟随粒度，无粒度即最低」只针对高亮和名字，
 *   而 `editTier` 用途远不止这两项：
 *    · 边界（`uEditTier`，见 gl.js）→ 剧本模式下按最低单位绘制
 *      （即「有主地块以最低单位出现」的原因）
 *    · 笔刷 / 涂色落点 / 各项目「与操作层相关」的判断
 *   → `editTier` 必须与视图层一致；
 *   「高亮和名字用最低层」另开函数，见 `labelTier`。
 *
 *   两者分工：
 *   `editTier` = 操作层（边界 / 笔刷 / 涂色）→ 默认 = 视图层
 *   `labelTier` = 显示层（高亮 / 名字）→ 无粒度时 = 最低层
 */
  return state.tier;
}

/**
 * 该格按哪一层判断。
 *
 *   「无粒度即最低」只适用于「剧本时无主的内容」（水域 / 荒地），不是通用规则。
 *   正确规则 = 按该格自身有无归属区分：
 *    · 有主（属于某国或被玩家涂色）→ 视图层
 *      剧本模式下即国家：悬停显示国家、高亮整国
 *    · 无主（水域 / 荒地）→ 最低层
 *      高亮只亮一格、卡片显示细的（否则在剧本层只有「整类」，无法查看）
 *
 *   开了粒度则一律用粒度。
 *   不可当作「全局最低层」：一律最低会使有主地块按最低单位显示，
 *   且高亮始终对不上国家。
 */
function viewTierFor(pid, tid) {
  const n = eraTierCount();
  if (n === 0 || state.tier < 0 || state.tier >= n) return state.tier;
  if (state.grain != null) return state.grain;      // 开了粒度：一律听它的
  /* 该格是否有「归属具体国家或涂色」，三个条件：
 *   ① 视图层上它有头衔
 *   ② 且那不是伪头衔：水域 / 荒地等由编辑器构造（`tid >= numRealTitles` 或 `waterMask` 判为水），不属于「归属具体国家」，须排除
 *   ③ 或玩家涂过它（涂过即算「有主」，见 paintData 的 alpha）
 *
 *   实测：CK3 的河流 pid 456 在剧本层拿到 `#river_e_136`（伪头衔），只看 ① 会判成「有主」而走视图层，实际应按最低层（高亮一格）。
 *   `waterMask` 是最直接的判据（即 `isWaterPid` 所用的小标签）；伪头衔判断为兜底（老包无 waterMask，荒地也没有）。
 */
  const t = (tid == null) ? titleAt(pid, state.tier) : tid;
  const _real = (state.meta && state.meta.numRealTitles != null)
    ? state.meta.numRealTitles : 1e9;
  const _isPseudo = (t != null && t !== NO_TITLE && t >= _real);
  const _isWater = isWaterPid(pid);
  const hasOwner = (t != null && t !== NO_TITLE && !_isPseudo && !_isWater);
  const pd = renderer && renderer.paintData;
  const painted = !!(pd && pid && pd[pid * 4 + 3] > 0);
  if (hasOwner || painted) return state.tier;        // 有主 → 视图层
  /* 无主（水域 / 荒地）→ 最低层 （那儿才是"每块各自一片"）*/
  const _nt = (state.meta && Array.isArray(state.meta.tiers)) ? state.meta.tiers.length : n;
  return Math.max(0, _nt - 1);
}

/**
 * 显示层：高亮 / 名字看它（`editTier` 看边界 / 笔刷）。
 *
 *   现为 `viewTierFor` 的「无 pid 版」：拿不到具体地块时退回最低层（调用方大多有 pid，优先用 `viewTierFor(pid)`）。
 *
 *   以「最低层」兜底的原因：
 *    · 剧本层是「国家」那一层，水域 / 荒地在该层只有「整类」（无「片」），高亮只能亮一格、名字也只能是「海洋」这类类名
 *    · 最低层才是「每一块地各自一片」那一层，高亮 / 名字均准确
 *
 *   取 `tiers.length - 1`，不硬编码层号（各游戏层数不同：CK3 7 层、EU5 6 层、HOI4 6 层）。
 *   开了粒度则用粒度。
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

/** 把有效编辑层推给渲染器，并把跟着它走的界面刷一遍*/
function applyEditTier() {
  const e = editTier();
  renderer.setEditTier(e);
  //（「水域内部边界」那套 uniform 已随专属边界一起退役）
  const hl = hoverTargetTid(state.hover.pid, state.hover.tids[e]);
  applyHoverHighlight(state.hover.pid, hl == null ? null : hl);
  updateCursor(hl, state.hover.pid);
  refreshTierButtons();
  renderHoverCard(state.hover.pid);
  /* 换粒度必须重算海名标。
 *   （「水域名称也一样，开剧本时显示的反而最高层」；实测剧本层 + 粒度=4 时 `editTier` 已是 4，但海名标仍为 561 个，应为 98 个，与 rg 层一致。）
 *
 *   原因：`state.seaLabelPoints` 为预计算结果，`labelDirty = true` 只让 `drawLabels` 重画，不重算；它仅在 `setTier` 中计算过一次，换粒度后仍用旧结果。
 *
 *   高亮 / 边界无需在此补（每帧读 `uEditTier`）；仅「海名标」算一次存起来，故只需重算它。
 *   包在 try 中：未载地图时 `state.titles` 尚未存在，不能因此让切层失败。
 */
  try { state.seaLabelPoints = buildSeaLabelPoints(); } catch (err) { /* 没载图就跳过*/ }
  labelDirty = true;
  invalidate();
}

/**
 * 按视图那一排的某个层级：按钮与快捷键均走此处。
 *
 *   年份视图里该排兼作粒度开关，不另开一排。每个按钮均为「按一下开、再按一下关」。
 *
 *   年份 + 细层级成对：年份出配色，细层级出边界和笔。
 *   按住省份再按 1618 → 配成一对：1618 配色 + 省份粒度；再按同一 1618 → 拆开，退回省份视图。
 *   按住 1618 再按地区 / 省份 → 只换粒度（配色仍是 1618）；再按同一细层级 → 拆开，退回 1618 的整国粒度。
 *
 *   其他视图下该排为普通切视图。
 */
function pressTier(tier) {
  const n = eraTierCount();
  const inEra = n > 0 && state.tier >= 0 && state.tier < n;

  if (!inEra) {
    // 不在年份视图。若按年份层处理，同时将当前层收为其粒度
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
 * 悬停卡片各行与搜索结果使用：点哪一行即把那一级拿来编辑。
 *   与 pressTier 的差别仅在于此处不取色，点谁即按谁编辑。
 */
function gotoLevel(tier) {
  const n = eraTierCount();
  if (n > 0 && state.tier >= 0 && state.tier < n && tier >= n) { setGrain(tier); return; }
  setTier(tier);
  // 点到年份那一层 = 「按整个国家编辑」，粒度得收掉
  // 不收的话 setTier 会提前返回（层级没变），粒度就赖着不走
  if (n > 0 && tier < n) setGrain(null);
}

/** 视图那一排的高亮：视图一个（金色），粒度一个（弱一档的蓝）
 *
 *  剧本层不在那一排
 *    所以这里的 `[data-role="tier"] button` 里只有地理层
 *    剧本的高亮 / 标签由下面 `refreshEraPicker` 单独管
 */
function refreshTierButtons() {
  const n = eraTierCount();
  const inEra = n > 0 && state.tier >= 0 && state.tier < n;
  const grain = inEra ? state.grain : null;
  for (const b of document.querySelectorAll('[data-role="tier"] button')) {
    const i = Number(b.dataset.tier);
    b.classList.toggle('on', i === state.tier);
    b.classList.toggle('grain', grain != null && i === grain);
  }
  /* 「运用剧本涂色」只在界面上真有剧本时能按 （没显示就没有，别看暗记）*/
  const _ae = $('btn-apply-era');
  if (_ae) _ae.disabled = shownEraTier() < 0;
  refreshEraPicker();
}

/** 剧本下拉栏：按钮上的字 + 面板里的高亮
 *
 *  三种状态：
 *    · 正在看某个剧本 → 按钮写那个剧本的名字，那一行高亮
 *    · 在地理层但带着剧本粒度 → 按钮还写剧本名，但标"粒度"淡蓝
 *      （那正是"1618 配色 + 省份粒度"的意思 见 pressTier 的注释）
 *    · 压根没开剧本（含地理层）→ 按钮写「无」
 *      
 */
function refreshEraPicker() {
  const btn = document.querySelector('[data-role="era-btn"]');
  const panel = document.querySelector('[data-role="era-panel"]');
  if (!btn || !panel) return;
  /* 回退模式（剧本 < 4 个）里没有下拉栏 直接别管
   *   （那时候剧本就是普通按钮，高亮由 `refreshTierButtons` 那半边管）*/
  if (!useEraDropdown()) return;
  /* 高亮按剧本块计算：空白剧本也在下拉栏中，选中后同样需要高亮。 （`eraTierCount` 不含空白层，用它计算时空白层那一项永远不会亮。）
 */
  const nBlock = eraBlockCount();
  const n = eraTierCount();
  if (nBlock <= 0) return;
  const names = state.meta.tierNames || [];
  const inEra = state.tier >= 0 && state.tier < n;          // "有主的年份视图"
  const inBlock = state.tier >= 0 && state.tier < nBlock;   // "剧本块里"（含空白层）
  const grain = inEra ? state.grain : null;
  const lab = btn.querySelector('.dd-label');
  /* 未开剧本时写「无」。
 *
 *   「1444 ·未用」的写法含义不明，只会让人以为按钮损坏或文字被截断。
 *
 *   三种情况：
 *    · 正在看某个剧本 → 写其名字（1444）
 *    · 在地理层、配色沿用该剧本 → 也写其名字（`.grain` 蓝色表示「借用」）
 *    · 未开剧本 → 「无」
 *   不保留「·未用」后缀。
 */
  let text = '无';
  if (inEra) text = names[state.tier] || '无';
  else if (grain != null && grain >= 0 && grain < nBlock) text = names[grain] || '无';
  if (lab) lab.textContent = text;
  btn.classList.toggle('on', inEra);
  btn.classList.toggle('grain', !inEra && grain != null);
  for (const it of panel.querySelectorAll('[data-role="era-item"]')) {
    const i = Number(it.dataset.tier);
    it.classList.toggle('on', i === state.tier);
    it.classList.toggle('grain', grain != null && i === grain);
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
  /* 换层时同步与层级绑定的开关 （颜色 / 本层边界 / 名称的取值按「当前视图属于哪一类」解析）
 * 不能依赖帧循环中的 syncLayerSwitches：它在 renderer.render 之后执行，
 * 换层后的第一帧为「新层归属表 + 旧层颜色开关」，
 * 切层时会闪一帧另一层原版的配色（如省份位图）。
 * （帧循环中该调用已移到 render 前，两处均已同步。）
 */
  syncLayerSwitches();
  syncParentBorder();
  refreshTierButtons();
  /* 换层需重算水域名标签
 * HOI4 的海域在 province 与 state 下每个地块一个名字，战略视图为合并结果；
 * EU4/E5 不同视图下海域覆盖范围不同。
 * 构建期给出 `seaNamesByTier`（下标 = tier），换层即换表，
 * 故此处按新层重聚一次（该表不存在时退回旧 `seaNames`，见函数内）。
 * 不可省略：仅在加载时计算一次会导致换层后仍用旧层海名。
 */
  try { state.seaLabelPoints = buildSeaLabelPoints(); }
  catch (e) { state.seaLabelPoints = []; }
  // 换层 = 换了一批色块 分组要重算
  // （图例列表不即时刷新：仅在「点图例 / 导出」时更新。）
  blocksDirty = true;
  const hl = hoverTargetTid(state.hover.pid, state.hover.tids[editTier()]);
  // 海 / 山为背景板，不可选中也不高亮：高亮会把整片海当作一个头衔点亮。
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
 * 
 * 把界面中固定的中文替换为当前游戏的说法。
 * 
 * CK3 称「头衔」，EU4 称「省份 / 地区 / 区域 / 大洲」，同一编辑器两套词汇。渲染层完全共用，仅这些标签与导出方式不同。
 */
function applyGameText() {
  const g = GAME;
  document.title = g.title;
  $('brand-mark').innerHTML = `${g.brand}<small>${g.brandSmall}</small>`;
  $('boot-title').textContent = g.title;
  // （此处不再改「头衔」组的标签；该组已删除，标题使用同一个值。）

  /* 各模式的默认开关（八套地图一致）：
 * CK3 同样适用（原仅「头衔」组颜色边界全开），见 build_data 中 eraDates 段：CK3 同为「剧本层 + 地区层」结构。
 * 势力（玩家涂色那组）：开边界 + 开名称 + 开颜色
 * 地块：默认不显示地名（颜色按需开启，开图即干净版图）
 * 剧本颜色：固定开 · 剧本边界：固定关（「剧本」组已删除）
 * 注意改动「来源」开关：几个派生值由 syncLayerSwitches 每帧按来源重算
 */
  {
    state.showPowerColor = true;       // 剧本颜色固定开 （那个勾已删）
    state.showRegionName = false;      // 地块·名称：默认关
    state.showPowerBorder = false;     // 剧本边界固定关 （那个勾已删）
    state.showPaint = true;
    state.showBorderPaint = true;
    state.showLabelsPaint = true;
    state.showTitles = true;
    state.showBorderTitle = false;
    state.showLabelsTitle = false;      // 地名：默认关
    state.wasteAuto = false;            // 荒地自动上色：默认关闭。
    state._layerSig = null;
    state._parentSig = null;
    state._wasteSig = null;             // 换了图/重置了开关：让帧循环重算一遍
  }
  // 状态 → 界面上的勾（HTML 里的 checked 只是初值，这里统一过来）
  // 注意：不要把 state 中不存在的字段塞进来（`el.checked = undefined`）。
  // 等于把勾取消（另外，界面上没有的开关也别塞：`$` 会返回 null）
  const _sw = [
    ['show-paint', state.showPaint],
    ['show-labels-paint', state.showLabelsPaint],
    /* 「剧本」那三个（show-power-names / color / border）删了
     *   → 这里不再有那三行 名字那个状态只剩 #show-labels-paint 独家管*/
    ['show-border-paint', state.showBorderPaint],
    ['show-parent-border', state.showParentBorderTitle],
    ['show-region-color', state.showRegionColor],
    ['show-region-border', state.showRegionBorder],
    ['show-region-name', state.showRegionName],
    /* 水域那两个+ 荒地那个
     *  它们每帧现读、不写 state 但界面上的勾也得跟 state 对齐
     *  （存过的偏好 / 换图重置都算）*/
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
  // 状态 → 渲染器：这些 setter 不只由复选框回调调用
  // 程序中修改 state 不会触发 change 事件，会出现「勾选已关闭、画面仍为五颜六色」。
  if (typeof renderer !== 'undefined' && renderer) {
    renderer.setShowTitles(state.showTitles);
    renderer.setShowPaint(state.showPaint);
    /* 原版边界（不再从「头衔 · 边界」复选框读取，该组已删除）
 *   现从 state 读取；有年代层时，下一帧 `syncLayerSwitches` 按 「势力/地区 · 边界」重算
 */
    renderer.setBorderTitle(!!state.showBorderTitle);

    // 把签名作废一次：上面这几行是照着旧勾选框推的
    // 势力 / 地区那套带签名去重：否则它们后续不再推送，旧值会滞留。
    state._layerSig = null;
    state._parentSig = null;
    const _bp = $('show-border-paint');
    if (_bp) renderer.setBorderPaint(_bp.checked);
    renderer.setMix(1.0);
  }
  /* 「地块」组需有年代层才出现 （「剧本」组已整组删除，那三个开关不再使用；
 *    「势力 / 水域 / 荒地」三组默认都在。
 *    荒地组例外：无荒地设定的游戏（VIC3 / HOI4）整组隐藏，
 *    设置页的「荒地」小节与清除荒地按钮同样隐藏）
 */
  {
    const _hasEra = !!(state.meta && state.meta.eraDates && state.meta.eraDates.length);
    for (const _id of ['region-group']) {
      const _el2 = $(_id);
      if (_el2) _el2.style.display = _hasEra ? '' : 'none';
    }
    /* 荒地 UI：有没有荒地只看数据里的名单 （VIC3 / HOI4 原版是空的）
       清除按钮另看 `wastePidList`（索引建没建好），没有索引时禁用而不是藏掉*/
    const _hasWaste = !!(state.meta && state.meta.wasteland && state.meta.wasteland.length);
    const _wg = $('waste-group');
    if (_wg) _wg.style.display = _hasWaste ? '' : 'none';
    for (const _wid of ['set-waste-row', 'set-waste-sub', 'set-waste-w-row', 'set-waste-a-row']) {
      const _wel = $(_wid);
      if (_wel) _wel.style.display = _hasWaste ? '' : 'none';
    }
    const _cw = $('btn-clear-waste');
    if (_cw) {
      _cw.style.display = _hasWaste ? '' : 'none';
      const _hasWastePids = !!(state.wastePidList && state.wastePidList.length);
      _cw.disabled = !_hasWastePids;
    }
  }  // 有年代层的模式（非 CK3）能查 TAG，标题不应固定为「省份」
  $('hdr-search').textContent = ((state.meta.eraDates || []).length) ? '查找' : `查找${g.entity}`;

  // 无对应导出方式的模式（HOI4）隐藏该按钮：点击无响应体验更差
  // 用 style.display 而不是 hidden：按钮在 display:flex 的容器里，hidden 会被压掉

  $('label-pick-hint').textContent = g.pickHint;
  $('search').placeholder = g.searchPlaceholder;
  $('results').innerHTML = `<p class="empty">${g.searchHint}</p>`;

  const meta = state.meta;
  if (meta) {
    // 层级数按数据来（V3 只有 4 层），快捷键就顺势给 1..N
    TIER_KEYS = meta.tiers || TIER_KEYS;
    TIER_COUNT = TIER_KEYS.length;
    /* 热键只给地理层编号，剧本层不占号
 * 原实现为 `TIER_KEYS.map((_, i) => String(i + 1))`，每层一个号；
 * 剧本较多时（116 个）热键表变为 1..121，无法使用。
 * → 只编地理层段：1..(总层数 - 剧本层数)
 * `syncGameTerms` 不存在 `eraTierCount` 时机问题：
 * 它读 `state.meta`，此处 meta 刚赋值完。
 * （`eraTierCount` 本身即读 state.meta 计算，见该函数。）
 */
    {
      const _eraN = eraBlockCount();
      const _geoN = Math.max(0, TIER_KEYS.length - _eraN);
      /* 最多分配 9 个编号：两位数需连按两下，与「一键切视图」的直觉不符。 地理层通常 5~6 个，9 个足够；超出部分通过按钮切换。
 */
      TIER_HOTKEY = Array.from({ length: Math.min(_geoN, 9) }, (_, i) => String(i + 1));
    }
  }
}

function buildToolbar() {
  const tierBox = document.querySelector('[data-role="tier"]');
  const eraGroup = $('era-group');
  const eraBtn = document.querySelector('[data-role="era-btn"]');
  const eraPanel = document.querySelector('[data-role="era-panel"]');

  /* 剧本与地理层分开摆放
 * 
 * 剧本层随 bookmarks 变化：原版 EU4 12 个，风云世纪两千年 116 个；
 * 全摆成按钮会使顶栏溢出。
 * 
 * 分工：
 * · `data-role="era"` → 剧本（下拉栏，一行即可，数量不限）
 * · `data-role="tier"` → 地理层（按钮，5~6 个）
 * 两边的 `dataset.tier` 均存全局层号，不是各自序号，
 * 因此 pressTier / setTier / 归属表均无需修改。
 */
  const names = state.meta.tierNames || [];
  /* 用 `eraBlockCount` 而非 `eraTierCount`：空白剧本也要收进下拉栏。 （两者差一层，见 `eraBlockCount` 的说明。）
 */
  const eraN = eraBlockCount();
  const bms = (state.meta && state.meta.bookmarks) || [];

  // ---- 剧本下拉栏（没有剧本层的图就整个藏起来 CK3 有 1066 那层，也算）
  /* 剧本少于 4 个不使用下拉栏，回退为按钮
 * 
 * 原因：VIC3 为 1836 + 空白 = 2 层、CK3 为 1066 + 空白 = 2 层，
 * 为两层专门放下拉按钮会多一次点击；
 * 且下拉栏在顶栏中占位，两层时直接摆按钮更简洁。
 * → 由 `useEraDropdown` 决定（≥4 才用下拉）。
 */
  const useDD = useEraDropdown();
  if (eraGroup && eraBtn && eraPanel) {
    if (useDD) {
      eraGroup.hidden = false;
      eraPanel.innerHTML = '';
      for (let i = 0; i < eraN; i++) {
        const b = document.createElement('button');
        b.dataset.tier = i;
        /* 用 `setAttribute` 而不是 `dataset.role`
         *   真浏览器里两者等价，但测试桩的 dataset 是个普通对象（不写回属性）
         *   桩里的 `querySelectorAll('[data-role="era-item"]')` 就一个都找不到
         *   → 高亮永远不生效，测试红得莫名其妙
         *   用 setAttribute：真浏览器照样能 `dataset.role` 读到 两边都通*/
        b.setAttribute('data-role', 'era-item');
        b.setAttribute('role', 'option');
        b.className = 'dd-item';
        const bm = bms[i];
        /* 只写剧本名，不写日期。
 *         日期挪进 `title`（悬停才可见），需要核对年份时仍可查到；面板也可窄一些。
 */
        b.innerHTML = `<span class="dd-item-name">${_escHtml(names[i])}</span>`;
        b.onclick = () => { closeEraPanel(); pressTier(i); };
        eraPanel.appendChild(b);
      }
      eraBtn.onclick = (e) => {
        e.stopPropagation();
        const open = eraPanel.classList.toggle('open');
        eraBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      // 点别处就收起来 （只绑一次）
      if (!eraBtn.__outsideBound) {
        eraBtn.__outsideBound = true;
        document.addEventListener('click', (e) => {
          const dd = $('era-dd');
          if (dd && !dd.contains(e.target)) closeEraPanel();
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') closeEraPanel();
        });
      }
    } else {
      // 少于 4 个：整块藏起来，下面那排按钮会把剧本层一起摆出来
      eraGroup.hidden = true;
      eraPanel.innerHTML = '';
      closeEraPanel();
    }
  }

  // ---- 层按钮。用下拉时只摆地理层；回退时剧本层也摆进来（就是最开始那版）
  tierBox.innerHTML = '';
  const firstBtn = useDD ? eraN : 0;
  for (let i = firstBtn; i < names.length; i++) {
    const b = document.createElement('button');
    b.dataset.tier = i;
    /* 热键只给地理层（既定规则：快捷键不对剧本层生效） 回退模式下剧本层也在这一排，但它们不占号
 */
    const hk = (i >= eraN) ? (TIER_HOTKEY[i - eraN] || '') : '';
    /* names 来自 meta.tierNames，导入的地图包由外部提供文件。 拼进 innerHTML 前须转义（与选图卡片同一规矩）。
 */
    b.innerHTML = `${_escHtml(names[i])}${hk ? `<span class="k">${hk}</span>` : ''}`;
    b.onclick = () => pressTier(i);
    tierBox.appendChild(b);
  }

  const toolBox = document.querySelector('[data-role="tool"]');
  toolBox.innerHTML = '';
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.dataset.tool = t.id;
    b.innerHTML = `${t.label}<span class="k">${t.key}</span>`;
    b.onclick = () => setTool(t.id);
    toolBox.appendChild(b);
  }
}

/** 收起剧本下拉栏（点外面 / 按 Esc / 选中一项之后都走这里）*/
function closeEraPanel() {
  const panel = document.querySelector('[data-role="era-panel"]');
  const btn = document.querySelector('[data-role="era-btn"]');
  if (panel) panel.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/**
 * 顶栏折叠。
 *
 *   手机端顶栏为覆盖在地图上的透明层，收起可多露出一段地图。
 *   仅收起工具那一排：视图 / 剧本 / 文件保留（均为看图必需）。
 *   默认不收起，避免按钮看似消失。
 *   状态记在 localStorage（`kb` 前缀），手机端切换后保持。
 */
function bindToolbarFold() {
  const btn = $('toolbar-fold');
  if (!btn) return;
  const KEY = 'tb-folded';
  const apply = (folded) => {
    document.body.classList.toggle('tb-folded', folded);
    btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    const lab = btn.querySelector('.fold-label');
    const car = btn.querySelector('.fold-caret');
    if (lab) lab.textContent = folded ? '展开' : '收起';
    if (car) car.textContent = folded ? '▾' : '▴';
  };
  let folded = false;
  try { folded = localStorage.getItem(KEY) === '1'; } catch (e) { /* 隐私模式读不到就算了*/ }
  apply(folded);
  btn.onclick = () => {
    folded = !document.body.classList.contains('tb-folded');
    apply(folded);
    try { localStorage.setItem(KEY, folded ? '1' : '0'); } catch (e) { /* 同上*/ }
    // 折叠改了可视区域 → 画布尺寸得重算 （不然地图会留一条空白）
    if (typeof resize === 'function') { try { resize(); } catch (e) {} }
  };
}

// ================================================================ 搜索

let searchTimer = 0;
let searchHits = [];          // 最近一次搜索的结果（回车跳第一条要用）

/* 「跨剧本搜国家」使用的两项数据：
 *   AVAILABLE_MAPS：boot 时的可用地图清单（走服务 = HEAD 探测所得，单文件 = 内嵌）
 *   _xgCache：各图的 countryTags，取过一次即记录（meta.json 从 12KB 到 1.3MB 不等，避免每次输入都重新拉取）
 *   _xgSeq：异步返回时校验该次请求是否仍有效（搜索框已更换则丢弃）
 */
let AVAILABLE_MAPS = [];
let _xgSeq = 0;
const _xgCache = new Map();
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 90);
}

/* 跳到某条搜索结果：切换到它那一级、按地盘大小飞过去、同时将其颜色取入画笔 */
function jumpToResult(tid) {
  if (tid == null || tid < 0) return;
  gotoLevel(state.titles.tiers[tid]);
  flyTo(tid, searchJumpScale(tid));
  setBrush(state.titles.colors[tid], true, true);   // 定位过程中取的色同样计入
  // 标签一并带出，无需手输名字
  setBrushLabel(state.titles.names[tid]);
}

/**
 * 按 tag 查找当前年代中的国家节点（形如 1444_SWE / 1936_XSM 的 key）。
 * 找不到返回 -1：说明其当前年代没有地盘（只取色、不跳转）。
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
  // 名字 / key / 统计数都可能有个别空洞（数据是外面烘的）：直接拿去
  // toLowerCase 或比较大小一旦抛错，整个面板会为空，外部表现为「搜索无反应」。
  const _low = (v) => String(v == null ? '' : v).toLowerCase();
  const _sz = t.provCount || [];
  const hits = [];
  // 非 CK3：跳过剧本 / 国家那几层；「查找地区」只应查地区一侧。
  // （那些节点的 key 是TAG、颜色是国旗色，混在地区搜索结果里没意义）
  const _eraN = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  for (let i = 0; i < t.keys.length; i++) {
    if (t.tiers[i] >= TIER_COUNT) continue;   // ''荒地不是真领地，不参与搜'
    // 国家/剧本层（tag）要能搜到（也就能拿到它的颜色）
    // 取色匹配那边不认细层 （见 buildColorIndex）
    // 中文名显示、英文名也搜得到（EU4 的缓存里带了 namesEn）
    // 这里不许"收满 200 就停"：收的顺序是节点序号，序号靠前的国家/剧本层
    // 会占满名额，排在后面的省份 / 地点无法进入，于是出现「计数 200+、列表为空」。
    // 要截也只能等按地盘排完序再截（全量扫 41k 节点实测 1.7ms，不是瓶颈）
    const alt = t.namesEn ? t.namesEn[i] : '';
    if (_low(t.keys[i]).includes(q) || _low(t.names[i]).includes(q) ||
        (alt && _low(alt).includes(q))) {
      hits.push(i);
    }
  }
  // 全部 tag（含当前年代没地盘的）：数据里给了就也出结果行
  // 这段必须先于「没找到」判空执行；否则仅存在于 tag 表中的国家会全部搜不到
  // （没地盘的 708 个 / 节点名与国名不一致的那些）
  const tagHits = [];
  const tagShown = new Set();   // 国家行已列出的 tag，用于下方去重。
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
  // 两侧都未命中才算没找到
  // 「跨剧本」开启时不提前判定未命中，其他剧本中可能存在该 tag
  if (!hits.length && !tagHits.length) {
    box.innerHTML = '<p class="empty">没找到</p>';
    $('search-count').textContent = '';
    searchHits = [];
    const _xseq = ++_xgSeq;
    if (searchCrossOn()) _xgFill(q, _xseq, 0, box, true);
    return;
  }
  // 按 tag 去重：同一个国家在三个年代各有一份节点，搜索里只该出一条
  // （年代与搜索无关：名字取「地盘最大」那份，key 用纯 tag。）
  // 先按地盘大小排：大国家排前面，真要截也只截掉小的
  hits.sort((a, b) => (_sz[b] || 0) - (_sz[a] || 0));
  const seenTag = new Set();
  const rows = [];
  for (const tid of hits) {
    if (_eraN > 0 && t.tiers[tid] < _eraN) {
      const k = String(t.keys[tid]);
      const tag = k.includes('_') ? k.slice(k.indexOf('_') + 1) : k;
      // 国家行已经把它列出来了就不再重复（一个 tag 只出一条）
      // 但节点名跟国名对不上的（V3 的 1836_FIN 在图上叫"芬兰大公国"、表里叫"芬兰"）
      // 必须自行生成一条，否则搜索图上该名字会显示未找到。
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
  // 计数按实际列出的行数计算；被 120 条截断时才带 `+`
  // （不得硬编码 "200+"：与列表实际条数不符）
  const _shown = tagHits.length + rows.length;
  const _cut = rows.length >= 120 || tagHits.length >= 120;
  $('search-count').textContent = _cut ? `${_shown}+` : String(_shown);
  // 结果行中几个 `<span>` 的构造工厂，国家行与地区 / 省份行共用。
  // （两批结果行共用同一份 _mkTag / _mk）
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
    // 国家行没有地块编号，但有名字 → 按名字反查玩家涂过没有
    //（没涂过就用数据色）
    dot.style.background = rgbToHex(paintedColorByName(h.name) || h.color);
    dot.onclick = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      setBrush(h.color, true, true);      // 搜索里取的色也要进「最近用过」
      setBrushLabel(h.name);
    };
    const tier = _mk('tier', h.tag);
    const name = _mk('name', h.name);
    row.appendChild(dot);
    row.appendChild(tier);
    row.appendChild(name);
    row.appendChild(_mk('cnt', ''));
    // 国家行：点整行 = 取色 + 取标签，但不跳镜头
    // （需要定位时使用地区 / 省份条目。）「不跳转」为既定要求。
    row.onclick = () => { setBrush(h.color, true, true); setBrushLabel(h.name); };
    box.appendChild(row);
  }
  for (const r of rows) {
    const tid = r.tid;
    const row = document.createElement('div');
    row.className = 'result-row';
    // 色点：点它只取色（设画笔 + 定标记），绝不跳镜头、不动图层
    const dot = _mk('dot', '');
    // 颜色取不到时给灰色：`rgbToHex(undefined)` 会抛错，抛错则整个面板为空。
    const _col = swatchColorOf(tid);
    dot.style.background = rgbToHex(_col);
    dot.onclick = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      setBrush(_col, true, true);         // 同上
      setBrushLabel(t.names[tid]);
    };
    const tier = _mk('tier', r.tag || TIER_BADGE[t.tiers[tid]]);
    const name = _mk('name', t.names[tid]);
    const cnt = _mk('cnt', (t.provCount || [])[tid] || '');
    row.appendChild(dot);
    row.appendChild(tier);
    row.appendChild(name);
    row.appendChild(cnt);
    // 势力行（带国家 tag 的那些）= 只取色取名，不跳镜头
    // 与「国家行」同一规矩：搜索势力是为了取其颜色与名字。
    // 定位只是附赠 （要看它在哪，用地区 / 省份那些条目）
    // 该层中部分势力在此图没有地盘，无法跳转，不应报错
    if (r.tag) row.onclick = () => { setBrush(_col, true, true); setBrushLabel(t.names[tid]); };
    else row.onclick = () => jumpToResult(tid);   // 地区 / 省份：点行 = 定位
    box.appendChild(row);
  }
  /* 当前地图搜完后，再查询「其他剧本中是否存在该国家」。 仅加国家行（tag），不加地区 / 省份：地区划分因图而异。
 */
  if (searchCrossOn()) _xgFill(q, ++_xgSeq, _shown, box, false);
}

/** 「跨剧本搜国家」开关现在开着吗 （元素不在时按关算）*/
function searchCrossOn() {
  const el = $('search-cross-game');
  return !!(el && el.checked);
}

/* 一次最多列这么多别的剧本的国家行（够看，不刷屏）*/
const _XG_MAX = 40;

/**
 * 本次需要查询的其他地图。
 *
 *   仅借用 meta 中的 countryTags，不读取地图字节。
 *   · 同款游戏（EU5 原版 / 原尺寸）只问一次：同一套 tag 出现两遍属噪音
 *   · 导入的地图包同样查询（meta.json 在包内，getFileBytes 可读取）
 *   · GAMES 中无法识别的游戏直接跳过（不以一张图冒充另一张）
 */
function _xgTargets() {
  const cur = String(state.mapEmb || '');
  const seenGame = new Set();
  const out = [];
  for (const m of AVAILABLE_MAPS || []) {
    if (!m) continue;
    if (cur && String(m.emb || m.key || '') === cur) continue;
    const g = String(m.game || m.emb || m.key || '');
    if (!g || seenGame.has(g)) continue;
    if (!GAMES[g]) continue;
    if (!isEmbedded() && !m.dir && !m.pack) continue;
    seenGame.add(g);
    out.push({ key: String(m.key || m.emb || g), emb: String(m.emb || m.key || g),
               dir: String(m.dir || ''), pack: String(m.pack || ''),
               game: g, label: String(m.label || GAMES[g].name) });
  }
  return out;
}

/** 借一张别的图的 countryTags （成功失败都记进 _xgCache，别每次敲字重拉）*/
function _xgLoad(t) {
  const ck = `${t.key}|${t.pack ? 'p' : isEmbedded() ? 'e' : 's'}`;
  if (!_xgCache.has(ck)) {
    _xgCache.set(ck, (async () => {
      let meta = null;
      try {
        if (t.pack) {
          const bytes = await getFileBytes(t.pack, 'meta.json');
          if (bytes && bytes.length) meta = JSON.parse(new TextDecoder().decode(bytes));
        } else if (isEmbedded()) meta = embeddedMeta(t.emb);
        else {
          const res = await fetch(`${t.dir}/meta.json`);
          if (res.ok) meta = await res.json();
        }
      } catch (e) { meta = null; }
      if (!meta || !meta.countryTags) return null;
      return { game: t.game, label: t.label, tags: meta.countryTags };
    })());
  }
  return _xgCache.get(ck);
}

/**
 * 当前图搜索完成后，补充其他剧本中的国家行
 * 仅搜索国家（tag）：地区 / 省份是每张图自身的切分方式，跨剧本无意义
 * 异步返回后先校验 `seq / 搜索框`，中途换词则丢弃本次结果
 */
async function _xgFill(q, seq, base, box, hadEmpty) {
  const targets = _xgTargets();
  if (!targets.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'xg-wrap';
  box.appendChild(wrap);
  const metas = await Promise.all(targets.map(_xgLoad));
  /* 已换词，或面板被下一次搜索清空：本次结果作废 */
  if (seq !== _xgSeq) { if (wrap.parentNode) wrap.remove(); return; }
  if ($('search').value.trim().toLowerCase() !== q) { if (wrap.parentNode) wrap.remove(); return; }
  const low = (v) => String(v == null ? '' : v).toLowerCase();
  let n = 0;
  for (const meta of metas) {
    if (!meta || n >= _XG_MAX) continue;
    const tags = meta.tags || {};
    let k = 0;
    for (const tag of Object.keys(tags)) {
      if (n >= _XG_MAX || k >= 12) break;
      const e = tags[tag] || {};
      const nm = e.n || tag;
      if (!low(tag).includes(q) && !low(nm).includes(q)) continue;
      wrap.appendChild(_xgRow(tag, nm, e.c || [128, 128, 128]));
      n++; k++;
    }
  }
  if (!n) {
    /* 一个都没找到：移除空标题；当前图原本就未找到时，保留其“未找到”提示 */
    if (wrap.parentNode) wrap.remove();
    if (!hadEmpty) {
      const p = document.createElement('p');
      p.className = 'empty xg-none';
      p.textContent = '其他地图包里也没有这个国家';
      box.appendChild(p);
    }
    return;
  }
  if (hadEmpty) {
    const e0 = box.querySelector('p.empty');
    if (e0 && e0.parentNode) e0.parentNode.removeChild(e0);
  }
  $('search-count').textContent = String(base + n) + (n >= _XG_MAX ? '+' : '');
}

/**
 * 一行“其他剧本中的国家”：点击取色并取名字，不跳转镜头
 * 行格式与本图国家行一致：色块、TAG、国家名，其后不显示其他内容
 */
function _xgRow(tag, nm, color) {
  const row = document.createElement('div');
  row.className = 'result-row xg-row';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = rgbToHex(Array.isArray(color) ? color : [128, 128, 128]);
  const tier = document.createElement('span');
  tier.className = 'tier';
  tier.textContent = tag;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = nm;
  row.appendChild(dot);
  row.appendChild(tier);
  row.appendChild(name);
  row.onclick = () => { setBrush(color || [128, 128, 128], true, true); setBrushLabel(nm); };
  return row;
}

// ---------------------------------------------------------------- 导出

/**
 * 把一份数据交给用户保存
 * 只用 <a download>，不调用 navigator.share：
 * 文件可以正常保存，但分享面板弹出后无法关闭，用户保存完还需自行退出
 * 出错兜底不在此处，在 _wrap 的 catch 里（toBlob 这类异步失败也要有人接，
 * 见 _wrap / onExportFail）
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

/**
 * 整图导出时把名字画上去
 * 整图导出由分块渲染拼接而成，标签层不参与，导出的大图没有文字
 * 这里按导出倍率重画「当前应显示的名单」（与屏幕一致：显示区的那几个开关）
 * 不另设开关：不需要名字时，关闭显示区的「…· 名称」即可
 */
function paintLabelsForExport(ctx, scale, rect) {
  if (!labels || !state.meta || !(scale > 0) || !Number.isFinite(scale)) return 0;
  if (!(state.showLabelsTitle || state.showLabelsPaint
        || state.showWaterName || state.showWasteName)) return 0;
  const W = state.meta.mapWidth, H = state.meta.mapHeight;
  const rx = rect && Number.isFinite(rect.x) ? Math.max(0, rect.x) : 0;
  const ry = rect && Number.isFinite(rect.y) ? Math.max(0, rect.y) : 0;
  const rw = rect && Number.isFinite(rect.w) ? Math.max(0, rect.w) : W;
  const rh = rect && Number.isFinite(rect.h) ? Math.max(0, rect.h) : H;
  if (!(rw > 0 && rh > 0)) return 0;
  let list = [];
  try {
    /*
     * 排版仍按整张图计算：只按框选区域排会让边上的名字与屏幕上位置不符；
     * 排完再在 paintExport 里按区域裁剪
     */
    list = drawLabels({ x: 0, y: 0, w: W, h: H }, true) || [];
  } catch (e) {
    LOG.event('导出名字失败', String(e && (e.message || e)));
    return 0;
  }
  /*
   * 层的显示门槛按“整图视角”计算（≈ 把整张图缩进 1600px 宽的参考视口）
   * 否则 1× 全图导出相当于 100% 缩放，最细那一层的数万个名字会全部画出
   * 若用 labels.cssW（当前屏幕宽），门槛会随设备变化：
   * 手机上 cssW 只有约 390px，gate = 390 / 5632 ≈ 6.9%，
   * 而国名层门槛（computeLabelZoom）按 1600px 视口定为约 20%，
   * → 手机上导出的整图所有名字都过不了门槛，得到一张没有字的地图；
   * 桌面 cssW 约 1600，gate 约 28%，国名正常
   * 导出结果不随设备屏幕宽度变化：同一张图在手机与桌面应输出同一套名字
   * → 固定按 1600px 参考视口计算（与 computeLabelZoom 口径一致）
   * 国名层门槛现为 0；该参考视口只影响细层（地理层）的取舍
   * 与 scale 无关：2× 导出只是把同样的名字画大一倍，门槛仍按“整图缩进 1600px”计算
   * （字号已乘过 scale）
   */
  const EXPORT_FIT_W = 1600;             // 整图导出的参考视口（1600px 宽）
  /* 框选导出按框的宽度计算门槛：框越小视角越近，细层名字应显示；整张图时 rw = W，与整图口径一致 */
  const gate = Math.min(1, EXPORT_FIT_W / Math.max(1, rw));
  return labels.paintExport(ctx, list, scale, gate, { x: rx, y: ry, w: rw, h: rh });
}


/*
 * 导出的两条护栏（OOM 防护）
 * 导出闪退抓不到异常：这不是 JS 报错，而是浏览器因 OOM 杀掉标签页，
 * 因此只能「事前拦截 + 事中看门狗」：
 *
 * ① exportBudgetInfo(px)：按「像素 × 4 字节 × 2.2 份」（画布 + PNG 编码临时缓冲）
 * 估算内存量，超预算则拒绝导出，提示改用 1×，避免标签页崩溃。
 * 分块渲染时只有一张输出画布，地名也直接画在上面（没有第三份全图）。
 *
 * ② toBlob 包一层看门狗：真卡死（不再回调）时释放画布，
 * 给出「导出超时，试试 1×」，而不是一直停在「正在导出」。
 */
function exportBudgetInfo(px) {
  const n = Number(px);
  if (!(n > 0) || !Number.isFinite(n)) {
    return { blocked: true, needMB: 0, capMB: 0, reason: '输出尺寸不对' };
  }
  const needMB = Math.round(n * 4 * 2.2 / (1024 * 1024));
  /*
   * iOS / iPadOS 的画布上限是硬限制。
   * Safari（尤其低版本）单个画布约 1600 万像素，超出后整页崩溃而非报错。
   * 手机上的导出闪退多为此因；直接按像素上限拦截。
   */
  if (isAppleTouch()) {
    const maxPx = 16777216;
    return {
      blocked: n > maxPx,
      needMB,
      capMB: Math.round(maxPx * 8.8 / (1024 * 1024)),
      reason: n > maxPx ? '超过 iOS / iPadOS 单张画布约 1600 万像素的上限' : '',
    };
  }
  /*
   * 桌面默认 1100 MB；手机 720 MB（3× 整图在手机上基本必崩）
   * 4 GB 机器降至 480 MB；8 GB 以上放宽到 1400 MB，3× 才能跑完
   */
  let capMB = 1100;
  let dm = 0;
  try { dm = (typeof navigator !== 'undefined' && navigator.deviceMemory) | 0; } catch (e) { /* 忽略：读不到 deviceMemory */ }
  if (_exportIsHandheld()) capMB = 720;
  else if (dm && dm <= 4) capMB = 480;
  else if (dm && dm >= 8) capMB = 1400;
  return {
    blocked: needMB > capMB,
    needMB,
    capMB,
    reason: needMB > capMB
      ? `预计要 ${needMB} MB，超过这台设备约 ${capMB} MB 的导出预算`
      : '',
  };
}

/**  兼容旧调用：仅判断是否会超出内存预算 */
function exportBudgetTight(px) {
  return exportBudgetInfo(px).blocked;
}

/**  是否为 iOS / iPadOS（iPadOS 13 起 UA 伪装成 Mac，需按触点数判断） */
function isAppleTouch() {
  try {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return /Macintosh/.test(ua) && (navigator.maxTouchPoints | 0) > 1;
  } catch (e) { return false; }
}

/**  释放导出画布占用的内存（画布内存不归 JS 管理，只能把尺寸清零） */
function releaseCanvas(cv) {
  try {
    if (!cv) return;
    cv.width = 0;
    cv.height = 0;
  } catch (e) { /* 忽略：画布已不可用 */ }
}

/**
 * `toBlob` + 看门狗
 * @param {HTMLCanvasElement} cv 输出画布
 * @param {function} onOk 成功回调（blob）
 * @param {function} onFail 失败回调（原因字符串）
 * @param {number} [timeoutMs] 看门狗时长；大图编码较慢，按像素放宽
 */
function exportBlob(cv, onOk, onFail, timeoutMs) {
  let done = false;
  const finish = (ok, arg) => {
    if (done) return false;
    done = true;
    clearTimeout(timer);
    try {
      if (ok) onOk(arg);
      else onFail(arg);
    } finally {
      releaseCanvas(cv);              // 无论成败都交还画布
    }
    return true;
  };
  const ms = (Number(timeoutMs) > 0) ? Number(timeoutMs) : 90000;
  const timer = setTimeout(() => {
    finish(false, `导出超时（${Math.round(ms / 1000)} 秒无结果），请降低分辨率，或改用 1× 重试`);
  }, ms);
  try {
    if (typeof cv.toBlob !== 'function') throw new Error('no toBlob');
    cv.toBlob((b) => {
      if (!b) finish(false, '浏览器没能编码出这张图（多半是内存不够）');
      else finish(true, b);
    }, 'image/png');
  } catch (e) {
    /*
     * 低版本 Safari 没有 `toBlob`，退回 `toDataURL` 再转 blob
     * dataURL 会多占一份内存，仅在无 toBlob 时走这条路
     */
    try {
      const url = cv.toDataURL('image/png');
      const comma = url.indexOf(',');
      const bin = atob(url.slice(comma + 1));
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      finish(true, new Blob([buf], { type: 'image/png' }));
    } catch (e2) {
      finish(false, '导出时出错：' + ((e2 && e2.message) || e2));
    }
  }
}

/**  导出当前画面：WebGL 层与地名层叠加后存为 PNG */
function exportViewPNG() {
  // 先补一帧，保证 WebGL 缓冲区里是刚画好的内容
  // （preserveDrawingBuffer 为关闭状态，隔一帧就取不到内容）
  /*
   * 导出前关闭悬停高亮高亮在着色器里以 mix 到白的方式绘制，不是叠框；鼠标停留时会被一并截进 PNG
   * 画完立即恢复，屏幕上的高亮不受影响
   */
  const _restoreHover = (renderer && renderer.muteHoverForExport)
    ? renderer.muteHoverForExport() : null;
  renderer.dirty = true;
  renderer.render();
  // 两套地名各自独立：原有的（头衔/地区名）和玩家的（手绘色块名）
  // 各自按开关绘制，两套都开时合并成一张名单一次画完
  drawLabels(viewRect());

  const glCanvas = $('map');
  const out = document.createElement('canvas');
  out.width = glCanvas.width;
  out.height = glCanvas.height;
  const ctx = out.getContext('2d');
  // 画布过大或设备内存不足时 getContext 返回 null，避免后面 drawImage 抛 TypeError
  if (!ctx) {
    if (_restoreHover) _restoreHover();
    return toast('导出失败：画布太大，这台设备画不出来', true);
  }
  ctx.drawImage(glCanvas, 0, 0);
  /*
   * 标签层按地图画布的尺寸贴屏幕上两张画布都被 CSS 拉成 100%，像素尺寸不完全一致也看不出来
   * 导出时各贴各的原始像素，一旦两边 dpr 上限不同（标签层 min(dpr,2)，地图层另一套），
   * 文字会整体放大并向右下偏移，城名落到海上→ 显式给目标尺寸，等同复现屏幕上那次拉伸
   */
  ctx.drawImage($('overlay'), 0, 0, glCanvas.width, glCanvas.height);
  if (_restoreHover) _restoreHover();       // 像素已拷入 out，此时恢复画布尺寸
  // 导出图例：勾选「画进导出的图」时绘制
  const _lgN = maybeDrawLegend(ctx, out.width, out.height);

  const _w = out.width, _h = out.height;
  exportBlob(out, (b) => {
    download(b, `${GAME.filePrefix}_视图_${stamp()}.png`);
    LOG.event('导出窗口 PNG', `${_w}×${_h}${_lgN ? ' · 图例 ' + _lgN + ' 条' : ''}`);
    if (_lgN < 0) return toast('已导出，但图例为空：当前视图没有可列入的颜色，请先涂色或在剧本层导出');
    toast(`已导出当前画面 ${_w}×${_h}` + (_lgN ? `（含 ${_lgN} 条图例）` : ''));
  }, (why) => {
    toast(`${why}。请先将画面缩放到整图，再重新导出。`, true);
    LOG.event('导出窗口 PNG 失败', why);
  });
}

/**
 * 导出整张地图，按原始 9216×4608 分块渲染再拼接
 * 不含地名：地名按屏幕尺寸排布，拼到原尺寸需另算一套
 */
/**
 * 导出整张地图
 * `scale = 2` 为高清导出：输出画布为 `地图宽高 × scale`，但 `setView()` 仍按地图坐标给视口 ——
 * 着色器中的 `uMapPerPx = view.w / canvas.width` 自动减半，
 * 于是边界按新尺度重画（半宽 `0.5 × 宽度 × uMapPerPx` 随之变化），不是把 1× 的图放大，避免模糊
 * 分块尺寸需按比例缩小：2× 时若仍用 2048 的块，输出就是 4096×4096 的纹理，
 * 老显卡的最大纹理尺寸可能只有 4096（刚好卡线）甚至 2048，块要减半
 */
/*
 * 导出整图：分辨率 + 范围 + 进度
 * 单一入口：先选 0.5× / 1× / 2× / 3×，或直接填宽高，再选整张 / 框选；
 * 渲染与 PNG 编码在同一处，进度条按真实分块数推进
 */
const EXPORT_SCALES = [0.5, 1, 2, 3];
const EXPORT_SCALE_MIN = 0.1;
const EXPORT_SCALE_MAX = 8;
const _exportDlg = {
  scale: 1,
  sizeBad: false,     // 宽/高输入框的当前内容解析不出合法尺寸
  range: 'full',      // 'full' | 'part'
  rect: null,         // { x, y, w, h }，地图像素
  picking: false,
  busy: false,
  cancel: false,
};
let _exportYieldAt = 0;

function _exportIsHandheld() {
  try {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  } catch (e) { return false; }
}

/**
 * 按设备能力取分块上限：默认 4096，手机 2048，再按倍率折算回地图像素
 * `rect` 可省：1× / 0.5× 的大图若单块仍能塞进 16MP 输出，则把块放宽到
 * 6144 地图像素 —— 5632 宽的 EU4 默认整图可少切一刀，少一次 setView + 读回
 * 手机 / 2× 以上不适用：输出块再大会触及内存与 GPU 上限
 */
function _exportTileSize(scale, rect) {
  let cap = 6144;
  try {
    const gl = renderer && renderer.gl;
    if (gl && gl.getParameter) {
      const mt = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;
      const rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) | 0;
      if (mt > 0) cap = Math.min(cap, mt);
      if (rb > 0) cap = Math.min(cap, rb);
      const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      if (vp && vp.length >= 2) {
        if (vp[0] > 0) cap = Math.min(cap, vp[0]);
        if (vp[1] > 0) cap = Math.min(cap, vp[1]);
      }
    }
  } catch (e) { /* 部分模拟 GL 与旧驱动不支持这些参数，退回 4096 */ }
  if (_exportIsHandheld()) cap = Math.min(cap, 2048);
  /* 常规分块仍按 cap（桌面 4096 / 手机 2048）折算；下面的 fit 只对 1× / 0.5× 整图放宽 */
  const baseCap = Math.min(4096, cap);
  let tile = Math.max(256, Math.min(4096, Math.floor(baseCap / Math.max(0.5, scale))));
  if (rect && !_exportIsHandheld()) {
    const rw = Math.max(1, Math.floor(rect.w || 0));
    const rh = Math.max(1, Math.floor(rect.h || 0));
    /* 最多放大到 6144 地图像素；该块输出须 ≤ 6144 边长 / 16MP */
    const fit = Math.min(6144, cap, Math.max(rw, rh));
    const ow = Math.min(rw, fit) * scale;
    const oh = Math.min(rh, fit) * scale;
    if (fit > tile && ow <= 6144 && oh <= 6144 && ow * oh <= 16777216) {
      tile = fit;
    }
  }
  return tile;
}

/** 让出主线程：累计 30ms 才让一次，避免每块都等 16ms，进度条仍能刷新 */
function _exportYield(force) {
  const now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  if (!force && now - _exportYieldAt < 30) return Promise.resolve();
  _exportYieldAt = now;
  return new Promise((r) => setTimeout(r, 0));
}

/** 把框选 / 整张统一成地图像素下的整数矩形；空或越界返回 null */
function _exportNormRect(rect) {
  const W = state.meta && state.meta.mapWidth;
  const H = state.meta && state.meta.mapHeight;
  if (!(W > 0 && H > 0)) return null;
  if (!rect) return { x: 0, y: 0, w: W, h: H };
  const x0 = Number(rect.x), y0 = Number(rect.y);
  const x1 = x0 + Number(rect.w), y1 = y0 + Number(rect.h);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  const x2 = Math.min(W, Math.ceil(x1));
  const y2 = Math.min(H, Math.ceil(y1));
  if (!(x2 > x && y2 > y)) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

function _exportScaleValid(scale) {
  const s = Number(scale);
  return Number.isFinite(s) && s >= EXPORT_SCALE_MIN && s <= EXPORT_SCALE_MAX;
}

function _exportScaleText(scale) {
  const s = Number(scale);
  if (!_exportScaleValid(s)) return '—';
  return `${Math.round(s * 1000) / 1000}×`;
}

/** 弹窗当前选择的输出尺寸 / 内存 / 拦截原因 */
function _exportMetrics() {
  const W = state.meta && state.meta.mapWidth;
  const H = state.meta && state.meta.mapHeight;
  if (!(W > 0 && H > 0)) return null;
  const rawScale = Number(_exportDlg.scale);
  const scale = _exportScaleValid(rawScale) ? rawScale : 1;
  const rect = _exportDlg.range === 'part' ? _exportDlg.rect : null;
  const r = _exportNormRect(rect) || _exportNormRect(null);
  const OW = Math.max(1, Math.round(r.w * scale));
  const OH = Math.max(1, Math.round(r.h * scale));
  const bi = exportBudgetInfo(OW * OH);
  let why = '';
  if (rect && !_exportNormRect(rect)) {
    why = '框选范围无效，请重新框选';
  } else if (_exportDlg.range === 'part' && !_exportDlg.rect) {
    why = '先点「框选」，在图上拖出要导出的那一块';
  } else if (_exportDlg.sizeBad) {
    why = `宽 / 高要填正整数，而且倍率要在 ${EXPORT_SCALE_MIN}×–${EXPORT_SCALE_MAX}× 之间`;
  } else if (OW > 32767 || OH > 32767 || OW * OH > 268435456) {
    why = `输出 ${OW}×${OH} 超过浏览器画布上限（长边 32767 / 总面积 2.68 亿像素），`
      + '请降低分辨率或者缩小框选范围';
  } else if (bi.blocked) {
    why = bi.reason;
  }
  return {
    scale, rect: r, OW, OH,
    needMB: bi.needMB, capMB: bi.capMB,
    part: !(r.x === 0 && r.y === 0 && r.w === W && r.h === H),
    why,
  };
}

/**
 * 宽 / 高输入：改一边，另一边按地图比例自动跟随
 * 只接受正整数；对应倍率超出 0.1×–8× 时标红并阻止导出
 */
function _exportSizeInput(which, raw) {
  const m = _exportMetrics();
  if (!m) return;
  const v = Math.round(Number(String(raw == null ? '' : raw).replace(/[\s,，]/g, '')));
  const base = which === 'w' ? m.rect.w : m.rect.h;
  if (!Number.isFinite(v) || v < 1 || !(base > 0)) {
    _exportDlg.sizeBad = true;
    _exportRefresh();
    return;
  }
  const s = v / base;
  if (!_exportScaleValid(s)) {
    _exportDlg.sizeBad = true;
    _exportRefresh();
    return;
  }
  _exportDlg.scale = s;
  _exportDlg.sizeBad = false;
  _exportRefresh();
}

/** 输入框失焦：内容非法时退回上一个合法尺寸，避免红字常驻 */
function _exportSizeCommit() {
  if (!_exportDlg.sizeBad) return;
  _exportDlg.sizeBad = false;
  _exportRefresh();
}

function _exportRefresh() {
  const modal = $('export-map');
  if (!modal || modal.hidden) return;
  const m = _exportMetrics();
  const seg = $('export-scale');
  if (seg && seg.children) {
    for (const b of Array.from(seg.children)) {
      const v = Number(b.getAttribute && b.getAttribute('data-scale'));
      const on = !_exportDlg.sizeBad && Number.isFinite(v)
        && Math.abs(v - _exportDlg.scale) < 1e-9;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  const wi = $('export-w'), hi = $('export-h');
  if (wi || hi) {
    const ae = (typeof document !== 'undefined' && document.activeElement) || null;
    if (wi && ae !== wi && m) wi.value = String(m.OW);
    if (hi && ae !== hi && m) hi.value = String(m.OH);
    if (wi) {
      wi.classList.toggle('bad', !!_exportDlg.sizeBad);
      wi.setAttribute('aria-invalid', _exportDlg.sizeBad ? 'true' : 'false');
    }
    if (hi) {
      hi.classList.toggle('bad', !!_exportDlg.sizeBad);
      hi.setAttribute('aria-invalid', _exportDlg.sizeBad ? 'true' : 'false');
    }
  }
  const rg = $('export-range');
  if (rg && rg.children) {
    for (const b of Array.from(rg.children)) {
      const on = (b.getAttribute && b.getAttribute('data-range')) === _exportDlg.range;
      b.classList.toggle('on', on);
    }
  }
  if ($('export-info')) {
    $('export-info').textContent = m
      ? `预计 ${m.needMB} MB 内存`
      : '地图还没加载好';
  }
  if ($('export-warn')) {
    $('export-warn').hidden = !m || !m.why;
    $('export-warn').textContent = m && m.why ? m.why : '';
  }
  if ($('export-start')) $('export-start').disabled = !m || !!m.why || _exportDlg.busy;
}

function _exportShow() {
  const modal = $('export-map');
  if (!modal) return;
  $('export-form').hidden = false;
  $('export-progress').hidden = true;
  if ($('export-close')) $('export-close').disabled = false;
  modal.hidden = false;
  _exportRefresh();
}

function _exportClose() {
  if (_exportDlg.busy) return;
  if (_exportDlg.picking) _exportPickCancel(false);
  const modal = $('export-map');
  if (modal) modal.hidden = true;
}

function openExportDialog() {
  if (_exportDlg.busy || _exportDlg.picking) return;
  if (!state.meta) return toast('地图尚未加载完成，请稍后再导出', true);
  _exportDlg.rect = null;
  _exportDlg.range = 'full';
  _exportDlg.sizeBad = false;
  _exportDlg.cancel = false;
  _exportShow();
}

/** 屏幕坐标 → 经舞台裁剪的屏幕坐标 + 地图像素坐标 */
function _exportPoint(clientX, clientY) {
  const stage = $('stage');
  const v = viewRect();
  const r = stage.getBoundingClientRect();
  const sx = Math.min(Math.max(clientX - r.left, 0), Math.max(1, r.width));
  const sy = Math.min(Math.max(clientY - r.top, 0), Math.max(1, r.height));
  const W = state.meta.mapWidth, H = state.meta.mapHeight;
  const x = Math.min(Math.max(v.x + sx / Math.max(1, r.width) * v.w, 0), W);
  const y = Math.min(Math.max(v.y + sy / Math.max(1, r.height) * v.h, 0), H);
  return { sx, sy, x, y };
}

/**
 * 框选状态（绘图软件式交互）：  rect     当前框（地图像素，浮点）
 *   prevRect 进入框选前弹窗里的框 —— Esc / 取消时还原
 *   drag     正在进行的拖拽：new / move / resize
 */
const _exportPickState = {
  rect: null,
  prevRect: null,
  drag: null,
};

function _exportPickMinSize() {
  const stage = $('stage');
  const v = viewRect();
  const r = stage ? stage.getBoundingClientRect() : null;
  const sw = Math.max(1, r ? r.width : 1);
  const sh = Math.max(1, r ? r.height : 1);
  /* 至少拖出 4 个屏幕像素，否则轻微抖动会留下一条缝 */
  return {
    w: Math.max(1, 4 * v.w / sw),
    h: Math.max(1, 4 * v.h / sh),
  };
}

function _exportPickClampRect(r) {
  if (!r || !state.meta) return null;
  const W = state.meta.mapWidth, H = state.meta.mapHeight;
  const x = Math.min(Math.max(r.x, 0), W);
  const y = Math.min(Math.max(r.y, 0), H);
  return {
    x, y,
    w: Math.min(Math.max(r.w, 0), Math.max(0, W - x)),
    h: Math.min(Math.max(r.h, 0), Math.max(0, H - y)),
  };
}

/** 由两点确定的框（支持任意拖拽方向） */
function _exportPickNorm(a, b) {
  return _exportPickClampRect({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  });
}

/** 浮点框 → 导出用的整数地图像素（与原有 floor/ceil 口径一致） */
function _exportPickRound(r) {
  if (!r) return null;
  const x = Math.floor(r.x), y = Math.floor(r.y);
  const W = state.meta.mapWidth, H = state.meta.mapHeight;
  return {
    x, y,
    w: Math.max(1, Math.min(Math.round(r.x + r.w) - x, W - x)),
    h: Math.max(1, Math.min(Math.round(r.y + r.h) - y, H - y)),
  };
}

/** 拖拽把手：nw / n / ne / e / se / s / sw / w */
function _exportPickResizeRect(start, handle, p, min) {
  if (!start || !state.meta) return null;
  const W = state.meta.mapWidth, H = state.meta.mapHeight;
  const mw = Math.min(Math.max(1, min.w), W);
  const mh = Math.min(Math.max(1, min.h), H);
  let left = start.x, top = start.y;
  let right = start.x + start.w, bottom = start.y + start.h;
  if (handle.indexOf('w') >= 0) {
    left = Math.min(Math.max(p.x, 0), Math.max(0, right - mw));
  }
  if (handle.indexOf('e') >= 0) {
    right = Math.max(Math.min(p.x, W), Math.min(W, left + mw));
  }
  if (handle.indexOf('n') >= 0) {
    top = Math.min(Math.max(p.y, 0), Math.max(0, bottom - mh));
  }
  if (handle.indexOf('s') >= 0) {
    bottom = Math.max(Math.min(p.y, H), Math.min(H, top + mh));
  }
  return _exportPickClampRect({
    x: left, y: top, w: right - left, h: bottom - top,
  });
}

function _exportPickInside(p, r) {
  return !!r && p.x >= r.x && p.x <= r.x + r.w
    && p.y >= r.y && p.y <= r.y + r.h;
}

function _exportPickInBar(el) {
  for (let n = el; n; n = n.parentNode) {
    if (n.id === 'export-pick-bar') return true;
  }
  return false;
}

function _exportPickRender() {
  const box = $('export-pick-box');
  const ok = $('export-pick-ok');
  const size = $('export-pick-size');
  if (!box || !ok) return;
  const r = _exportPickState.rect;
  if (!r) {
    box.hidden = true;
    ok.disabled = true;
    if (size) size.textContent = '—';
  } else {
    const stage = $('stage');
    const sr = stage ? stage.getBoundingClientRect() : null;
    const v = viewRect();
    const sw = Math.max(1, sr ? sr.width : 1);
    const sh = Math.max(1, sr ? sr.height : 1);
    box.hidden = false;
    box.style.left = `${(r.x - v.x) / Math.max(1, v.w) * sw}px`;
    box.style.top = `${(r.y - v.y) / Math.max(1, v.h) * sh}px`;
    box.style.width = `${r.w / Math.max(1, v.w) * sw}px`;
    box.style.height = `${r.h / Math.max(1, v.h) * sh}px`;
    const min = _exportPickMinSize();
    ok.disabled = !(r.w >= min.w && r.h >= min.h);
    if (size) size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)} px`;
  }
}

function _exportPickStart() {
  if (!state.meta || _exportDlg.busy || _exportDlg.picking) return;
  const prev = _exportDlg.rect ? { ..._exportDlg.rect } : null;
  _exportDlg.picking = true;
  _exportDlg.range = 'part';
  _exportPickState.prevRect = prev;
  _exportPickState.rect = prev ? { ...prev } : null;
  _exportPickState.drag = null;
  const modal = $('export-map');
  if (modal) modal.hidden = true;
  $('export-pick-layer').hidden = false;
  _exportPickRender();
}

/** show=false：不弹出弹窗（关闭整个导出窗时使用） */
function _exportPickClose(commit, show) {
  const st = _exportPickState;
  _exportDlg.picking = false;
  st.drag = null;
  const layer = $('export-pick-layer');
  const box = $('export-pick-box');
  if (layer) layer.hidden = true;
  if (box) box.hidden = true;
  if (commit && st.rect) {
    _exportDlg.rect = _exportPickRound(st.rect);
    _exportDlg.range = 'part';
  } else {
    _exportDlg.rect = st.prevRect ? { ...st.prevRect } : null;
    _exportDlg.range = st.prevRect ? 'part' : 'full';
  }
  st.rect = null;
  st.prevRect = null;
  if (show) _exportShow();
  else {
    const modal = $('export-map');
    if (modal) modal.hidden = true;
  }
}

function _exportPickCancel(show) {
  _exportPickClose(false, show !== false);
}

function _exportPickConfirm() {
  if (!_exportDlg.picking || !_exportPickState.rect) return;
  const min = _exportPickMinSize();
  const r = _exportPickState.rect;
  if (r.w < min.w || r.h < min.h) return;
  _exportPickClose(true, true);
}

function _exportPickReset() {
  if (!_exportDlg.picking) return;
  _exportPickState.drag = null;
  _exportPickState.rect = null;
  _exportPickRender();
}

function _exportPickAbortDrag() {
  const d = _exportPickState.drag;
  if (!d) return;
  _exportPickState.drag = null;
  if (d.mode === 'new') _exportPickState.rect = d.backup ? { ...d.backup } : null;
  else if (d.startRect) _exportPickState.rect = { ...d.startRect };
  _exportPickRender();
}

function _exportPickApplyDrag(d, p) {
  if (!d) return;
  if (d.mode === 'new') {
    _exportPickState.rect = _exportPickNorm(d.start, p);
  } else if (d.mode === 'move') {
    const W = state.meta.mapWidth, H = state.meta.mapHeight;
    const x = Math.min(Math.max(d.startRect.x + (p.x - d.start.x), 0),
      Math.max(0, W - d.startRect.w));
    const y = Math.min(Math.max(d.startRect.y + (p.y - d.start.y), 0),
      Math.max(0, H - d.startRect.h));
    _exportPickState.rect = { x, y, w: d.startRect.w, h: d.startRect.h };
  } else {
    _exportPickState.rect = _exportPickResizeRect(
      d.startRect, d.handle, p, _exportPickMinSize());
  }
}

function _exportPickDown(e) {
  if (!_exportDlg.picking || _exportDlg.busy) return;
  /* 两指同时按下时只认第一只，避免第二只顶掉正在拖拽的框 */
  if (_exportPickState.drag) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (_exportPickInBar(e.target)) return;
  if (e.stopPropagation) e.stopPropagation();
  e.preventDefault();
  const p = _exportPoint(e.clientX, e.clientY);
  const target = e.target;
  const handle = target && target.getAttribute
    ? target.getAttribute('data-handle') : null;
  const st = _exportPickState;
  if (handle && st.rect) {
    st.drag = {
      id: e.pointerId, mode: 'resize', handle,
      start: p, startRect: { ...st.rect },
    };
  } else if (st.rect && _exportPickInside(p, st.rect)) {
    st.drag = {
      id: e.pointerId, mode: 'move',
      start: p, startRect: { ...st.rect },
    };
  } else {
    st.drag = {
      id: e.pointerId, mode: 'new', start: p,
      backup: st.rect ? { ...st.rect } : null,
    };
    st.rect = null;
  }
  const layer = $('export-pick-layer');
  if (layer && e.pointerId != null && layer.setPointerCapture) {
    try { layer.setPointerCapture(e.pointerId); } catch (err) { /* 低版本浏览器不支持指针捕获 */ }
  }
  _exportPickRender();
}

function _exportPickMove(e) {
  if (!_exportDlg.picking || !_exportPickState.drag) return;
  const d = _exportPickState.drag;
  if (d.id != null && e.pointerId != null && e.pointerId !== d.id) return;
  e.preventDefault();
  _exportPickApplyDrag(d, _exportPoint(e.clientX, e.clientY));
  _exportPickRender();
}

function _exportPickUp(e) {
  if (!_exportDlg.picking || !_exportPickState.drag) return;
  const d = _exportPickState.drag;
  if (d.id != null && e.pointerId != null && e.pointerId !== d.id) return;
  e.preventDefault();
  const p = _exportPoint(e.clientX, e.clientY);
  _exportPickApplyDrag(d, p);
  _exportPickState.drag = null;
  const r = _exportPickState.rect;
  const min = _exportPickMinSize();
  if (r && (r.w < min.w || r.h < min.h)) {
    /*
     * new：回到拖拽前那块（可能为空）；resize：回到把手拖动前的状态
     * 仅依据 d.backup 判断会在 resize 拖得过小时清掉整个框
     */
    const backup = d.mode === 'new' ? d.backup : d.startRect;
    _exportPickState.rect = backup ? { ...backup } : null;
    _exportPickRender();
    return;
  }
  _exportPickRender();
}

function _exportPickNudge(dx, dy) {
  const r = _exportPickState.rect;
  if (!r) return;
  const W = state.meta.mapWidth, H = state.meta.mapHeight;
  _exportPickState.rect = {
    x: Math.min(Math.max(r.x + dx, 0), Math.max(0, W - r.w)),
    y: Math.min(Math.max(r.y + dy, 0), Math.max(0, H - r.h)),
    w: r.w, h: r.h,
  };
  _exportPickRender();
}

function _exportProgress(pct, note) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  if ($('export-prog-bar')) $('export-prog-bar').style.width = `${v}%`;
  if ($('export-prog-pct')) $('export-prog-pct').textContent = `${v}%`;
  if (note && $('export-prog-note')) $('export-prog-note').textContent = note;
}

async function _exportRun() {
  if (_exportDlg.busy) return;
  const m = _exportMetrics();
  if (!m) return toast('地图尚未加载完成', true);
  if (m.why) return toast(m.why, true);
  _exportDlg.busy = true;
  _exportDlg.cancel = false;
  $('export-form').hidden = true;
  $('export-progress').hidden = false;
  if ($('export-close')) $('export-close').disabled = true;
  if ($('export-stop')) {
    $('export-stop').disabled = false;
    $('export-stop').textContent = '停止导出';
  }
  _exportProgress(0, '准备中…');
  const job = { cancel: false };
  _exportDlg.job = job;
  try {
    const r = await exportFullPNG(m.scale, {
      rect: m.rect,
      onProgress: (pct, note) => _exportProgress(pct, note),
      shouldCancel: () => job.cancel,
    });
    if (r && r.canceled) {
      $('export-map').hidden = true;
      toast('已停止导出');
    } else {
      $('export-map').hidden = true;
    }
  } catch (e) {
    onExportFail(e);
    $('export-form').hidden = false;
    $('export-progress').hidden = true;
    _exportRefresh();
  } finally {
    _exportDlg.busy = false;
    _exportDlg.job = null;
    if ($('export-close')) $('export-close').disabled = false;
  }
}

function _initExportDialog() {
  const modal = $('export-map');
  if (!modal) return;
  const seg = $('export-scale');
  if (seg && seg.children) {
    /* 直接挂到每个按钮上：不依赖事件冒泡（手机壳 / 假 DOM 中冒泡不一定存在，挂按钮最稳妥）/ */
    for (const b of Array.from(seg.children)) {
      b.addEventListener('click', () => {
        const v = Number(b.getAttribute && b.getAttribute('data-scale'));
        if (!(v > 0)) return;
        _exportDlg.scale = v;
        _exportDlg.sizeBad = false;
        _exportRefresh();
      });
    }
  }
  for (const [id, which] of [['export-w', 'w'], ['export-h', 'h']]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', () => _exportSizeInput(which, el.value));
    el.addEventListener('change', _exportSizeCommit);
    el.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Enter') return;
      if (e.preventDefault) e.preventDefault();
      if (el.blur) el.blur();
    });
  }
  const rg = $('export-range');
  if (rg && rg.children) {
    for (const b of Array.from(rg.children)) {
      b.addEventListener('click', () => {
        const v = b.getAttribute && b.getAttribute('data-range');
        if (v !== 'full' && v !== 'part') return;
        _exportDlg.range = v;
        if (v === 'full') _exportDlg.rect = null;
        _exportRefresh();
        /* 无「在图上框选」按钮：点「框选」直接进入画框层已有框时同样进入，便于再调位置 / 大小/ */
        if (v === 'part') _exportPickStart();
      });
    }
  }
  if ($('export-pick-cancel')) $('export-pick-cancel').onclick = () => _exportPickCancel(true);
  if ($('export-pick-redo')) $('export-pick-redo').onclick = () => _exportPickReset();
  if ($('export-pick-ok')) $('export-pick-ok').onclick = () => _exportPickConfirm();
  if ($('export-start')) $('export-start').onclick = () => { _exportRun(); };
  if ($('export-cancel')) $('export-cancel').onclick = () => _exportClose();
  if ($('export-close')) $('export-close').onclick = () => _exportClose();
  if ($('export-stop')) $('export-stop').onclick = () => {
    const job = _exportDlg.job;
    if (job) job.cancel = true;
    $('export-stop').disabled = true;
    $('export-stop').textContent = '正在停下…';
    const pct = $('export-prog-pct') ? parseInt($('export-prog-pct').textContent, 10) : 0;
    _exportProgress(Number.isFinite(pct) ? pct : 0,
      '正在停下，等这一块渲染完…');
  };
  modal.addEventListener('click', (e) => {
    if (e && e.target === modal && !_exportDlg.busy) _exportClose();
  });
  const layer = $('export-pick-layer');
  if (layer) {
    layer.addEventListener('pointerdown', _exportPickDown);
    /* move / up 挂在 window 上：拖出舞台边缘仍能跟随 */
    window.addEventListener('pointermove', _exportPickMove);
    window.addEventListener('pointerup', _exportPickUp);
    window.addEventListener('pointercancel', () => _exportPickAbortDrag());
    /* 框选时锁住地图缩放：滚轮缩放后选框停在旧像素上会对不上右键菜单同理，避免在选区上弹出遮挡操作 */
    layer.addEventListener('wheel', (e) => {
      if (!_exportDlg.picking) return;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    }, { passive: false });
    layer.addEventListener('contextmenu', (e) => {
      if (!_exportDlg.picking) return;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    });
  }
  /*
   * Esc 须先于全局「回主菜单」处理：全局那条在冒泡阶段，此处用捕获 + stopImmediatePropagation
   * 框选内另有 Enter 确认 / 方向键微调，贴近绘图软件的操作习惯
   */
  window.addEventListener('keydown', (e) => {
    if (!e || (e.key !== 'Escape' && e.key !== 'Esc')) {
      if (!_exportDlg.picking || !e) return;
      if (e.key === 'Enter') {
        if (e.preventDefault) e.preventDefault();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        _exportPickConfirm();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
          || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (e.preventDefault) e.preventDefault();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : (e.key === 'ArrowRight' ? step : 0);
        const dy = e.key === 'ArrowUp' ? -step : (e.key === 'ArrowDown' ? step : 0);
        _exportPickNudge(dx, dy);
        return;
      }
      /* 框选期间不让工具快捷键 / 撤销漏到底下的画布Tab 保留，键盘用户仍可移动焦点/ */
      if (e.key !== 'Tab') {
        if (e.preventDefault) e.preventDefault();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      }
      return;
    }
    if (_exportDlg.picking) {
      if (e.preventDefault) e.preventDefault();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      _exportPickCancel(true);
      return;
    }
    if (modal.hidden) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (!_exportDlg.busy) _exportClose();
  }, true);
}

/**
 * 导出整张地图 / 框选区域
 * `scale` 是输出像素 / 地图像素；`opts.rect` 是地图像素矩形。
 * 视口仍按地图坐标给，画布按倍率放大 —— 着色器的 `uMapPerPx`
 * 自动变小，边界按新尺度重画，不是把 1× 放大糊
 * 性能相关三点：
 *   ① 分块从 2048 提到 4096（手机 2048），同一张图少跑一半以上的块
 *   ② 只有块尺寸变化时才重设画布宽高，不再每块重新分配
 *   ③ 每 30ms 才让一次主线程，进度条仍能绘制，少等几十次 4ms 定时器
 */
async function exportFullPNG(scale = 1, opts = {}) {
  const meta = state.meta;
  if (!meta) { toast('地图尚未加载完成', true); return { ok: false }; }
  const s = Number(scale);
  if (!_exportScaleValid(s)) {
    toast(`导出倍率要在 ${EXPORT_SCALE_MIN}×–${EXPORT_SCALE_MAX}× 之间 ✓`, true);
    return { ok: false };
  }
  const rect = _exportNormRect(opts.rect);
  if (!rect) {
    toast('框选范围无效，请重新框选', true);
    return { ok: false };
  }
  const W = meta.mapWidth, H = meta.mapHeight;
  const OW = Math.max(1, Math.round(rect.w * s));
  const OH = Math.max(1, Math.round(rect.h * s));
  const part = !(rect.x === 0 && rect.y === 0 && rect.w === W && rect.h === H);

  if (OW > 32767 || OH > 32767 || OW * OH > 268435456) {
    LOG.event('导出整图被拦', `${OW}×${OH} 超过浏览器画布上限`);
    toast(`本次尺寸 ${OW}×${OH} 已超过浏览器的画布上限。`
      + '请降低分辨率，或缩小框选范围后重新导出。', true);
    return { ok: false };
  }
  const bi = exportBudgetInfo(OW * OH);
  if (bi.blocked) {
    LOG.event('导出整图被拦', `${OW}×${OH} 预计占用 ${bi.needMB} MB，超过本机预算`);
    toast(`本次尺寸 ${OW}×${OH} 预计占用 ${bi.needMB} MB 内存，可能导致页面崩溃。`
      + '请降低分辨率，或缩小框选范围后重新导出。', true);
    return { ok: false };
  }

  const notify = (pct, note) => {
    if (typeof opts.onProgress !== 'function') return;
    try { opts.onProgress(pct, note); } catch (e) { /* 进度条异常不应影响导出 */ }
  };
  const shouldCancel = () => !!(opts.shouldCancel && opts.shouldCancel());
  const cancelErr = new Error('导出已取消');
  cancelErr.__exportCanceled = true;
  const checkCancel = () => { if (shouldCancel()) throw cancelErr; };

  const glCanvas = $('map');
  const TILE = _exportTileSize(s, rect);
  const total = Math.max(1, Math.ceil(rect.w / TILE) * Math.ceil(rect.h / TILE));
  let done = 0;
  let _lgN2 = 0;
  let _labN2 = 0;

  const savedW = glCanvas.width;
  const savedH = glCanvas.height;
  const savedView = { ...renderer.view };

  const out = document.createElement('canvas');
  out.width = OW;
  out.height = OH;
  if (out.width !== OW || out.height !== OH) {
    releaseCanvas(out);
    return toast('导出失败：输出画布太大，这台设备画不出来', true);
  }
  const ctx = out.getContext('2d', { alpha: false });
  if (!ctx) {
    releaseCanvas(out);
    return toast('导出失败：输出画布太大，这台设备画不出来', true);
  }
  ctx.imageSmoothingEnabled = false;

  renderer.fixedSize = true;
  renderer.noAA = true;
  _exportYieldAt = 0;
  notify(1, part ? '准备渲染框选区域…' : '准备渲染整张地图…');

  let _restoreHover = null;
  try {
    await _exportYield(true);
    checkCancel();
    _restoreHover = (renderer && renderer.muteHoverForExport)
      ? renderer.muteHoverForExport() : null;
    for (let ty = rect.y; ty < rect.y + rect.h; ty += TILE) {
      for (let tx = rect.x; tx < rect.x + rect.w; tx += TILE) {
        checkCancel();
        const tw = Math.min(TILE, rect.x + rect.w - tx);
        const th = Math.min(TILE, rect.y + rect.h - ty);
        /*
         * 输出边界按累加后的整数边计算
         * 0.5× 时每块单独 round 会差出一像素，拼起来出现细缝 / 重叠
         * → 先算该块在输出中的左右上下边，再以差值作宽高，总和必然等于 OW / OH
         */
        const dx = Math.round((tx - rect.x) * s);
        const dy = Math.round((ty - rect.y) * s);
        const dx2 = Math.round((tx + tw - rect.x) * s);
        const dy2 = Math.round((ty + th - rect.y) * s);
        const dw = Math.max(1, dx2 - dx);
        const dh = Math.max(1, dy2 - dy);
        /* 仅尺寸变化时重设；每块都写一次 width 会重复分配显存并清屏 */
        if (glCanvas.width !== dw || glCanvas.height !== dh) {
          glCanvas.width = dw;
          glCanvas.height = dh;
        }
        renderer.setView(tx, ty, tw, th);
        if (state.tileMap && renderer.provArrTex && renderer.tileInfo) {
          const jobs = [];
          for (const [r, c] of state.tileMap.tilesInView({ x: tx, y: ty, w: tw, h: th })) {
            const layer = r * state.tiles.cols + c;
            /*
             * 上一块 / 上一帧已传过的块不再重复上传
             * `uploadTile` 每次都要把 Uint16 转成字节再 texSubImage3D；
             * 相邻导出分块在边界上会看到同一块，整图导出时可能重复上传几十次
             * （与帧循环判据一致：缓存里有 ≠ 显存里有，只看 uploadedTiles）
             */
            if (renderer.uploadedTiles && renderer.uploadedTiles.has(layer)) continue;
            const cached = state.tileMap.cache.get(`${r}_${c}`);
            if (cached) { renderer.uploadTile(layer, cached); continue; }
            jobs.push(state.tileMap.get(r, c).then((tile) => {
              if (tile) renderer.uploadTile(layer, tile);
            }).catch(() => {}));
          }
          if (jobs.length) await Promise.all(jobs);
        }
        checkCancel();
        renderer.dirty = true;
        renderer.render();
        ctx.drawImage(glCanvas, 0, 0, dw, dh, dx, dy, dw, dh);
        done++;
        notify(4 + 78 * done / total,
          `正在渲染地图分块… ${done} / ${total}`);
        await _exportYield(false);
      }
    }
    checkCancel();
    if (_restoreHover) { _restoreHover(); _restoreHover = null; }

    notify(86, '正在绘制地名…');
    await _exportYield(true);
    checkCancel();
    try { _labN2 = paintLabelsForExport(ctx, s, rect); } catch (e) {
      LOG.event('导出名字失败', String(e && (e.message || e)));
    }

    notify(92, '正在绘制图例…');
    await _exportYield(true);
    checkCancel();
    _lgN2 = maybeDrawLegend(ctx, OW, OH);

    notify(96, '正在编码 PNG…');
    await _exportYield(true);
    checkCancel();
    const timeoutMs = Math.min(300000,
      Math.max(90000, Math.round(OW * OH / 1000000 * 2.2) * 1000));
    const blob = await new Promise((resolve, reject) => {
      exportBlob(out, resolve, (why) => reject(new Error(why)), timeoutMs);
    });
    checkCancel();
    notify(100, '完成');

    const tag = part
      ? `_局部${_exportScaleText(s)}`
      : `_整图${s !== 1 ? _exportScaleText(s) : ''}`;
    download(blob, `${GAME.filePrefix}${tag}_${stamp()}.png`);
    LOG.event('导出整图 PNG', `${OW}×${OH}` + (s !== 1 ? `（${_exportScaleText(s)}）` : '')
      + (part ? ` · 框选 ${rect.x},${rect.y} ${rect.w}×${rect.h}` : '')
      + (_labN2 ? ` · 名字 ${_labN2} 个` : ' · 不带名字')
      + (_lgN2 ? ' · 图例 ' + _lgN2 + ' 条' : ''));
    if (_lgN2 < 0) {
      toast(`已导出${part ? '框选区域' : '整张地图'} ${OW}×${OH}，但图例是空的：`
        + '当前视图没有可列入的颜色，请先涂色');
    } else {
      toast(`已导出${part ? '框选区域' : '整张地图'} ${OW}×${OH}`
        + (s !== 1 ? `（${_exportScaleText(s)}）` : '')
        + (_labN2 ? `（含 ${_labN2} 个名字）` : '（不带名字：显示区的名称开关关着）')
        + (_lgN2 ? `（含 ${_lgN2} 条图例）` : ''));
    }
    return { ok: true, OW, OH };
  } catch (e) {
    if (e && e.__exportCanceled) {
      releaseCanvas(out);
      LOG.event('导出整图取消', `${OW}×${OH}`);
      return { ok: false, canceled: true };
    }
    releaseCanvas(out);
    LOG.event('导出整图 PNG 失败', String(e && (e.message || e)));
    throw e;
  } finally {
    if (_restoreHover) { _restoreHover(); _restoreHover = null; }
    renderer.fixedSize = false;
    renderer.noAA = false;
    glCanvas.width = savedW;
    glCanvas.height = savedH;
    renderer.setView(savedView.x, savedView.y, savedView.w, savedView.h);
    invalidate();
  }
}


/**
 * 工程的存取
 * 只存「涂过的头衔」清单 —— 颜色 + 标记，恢复时重放一遍即可
 * 比存整张手绘层（53 KB 的位图）小得多，且天然跨版本：头衔 key 稳定
 * localStorage 用于防止误刷新丢失，导出文件用于备份和换机器
 */
/*
 * 设置 + 最近颜色（与「涂色暂存」是两码事）
 * · 涂色（`STASH_KEY`）：回主菜单才存，F5 刷新即清
 * · 设置 / 最近颜色（`SET_KEY`）：刷新与回主菜单都保留
 * 两者使用的键不同：
 * · 设置 / 最近颜色 → 游戏类型（`prefsKeyOf` = `meta.game`）
 * 同一游戏的不同图共用一套（TNO 与钢铁雄心4原版共用 ——
 * 它们指同一组界面线宽浓度档位与记过的颜色）删除某一张图不得连带删除它们
 * · 涂色暂存 → 哪一张图（`mapKeyOf`），绝不能共用：
 * CK3 与 EU4 的省份编号是两套，同一游戏的不同 mod 省份数也可能不同，混在一起会互相涂花
 */
const SET_KEY = 'pdx-map-editor/prefs/v1';

/*
 * 本地存储里的「JSON 小盒子」
 * 设置 / 涂色暂存 / 调色板收藏三处做的事相同：整个对象塞进 localStorage。
 * 各写一遍 `JSON.parse(localStorage.getItem(K) || '{}')` 时，四处都没有兜底：
 * · 存档可能被写坏 —— 配额满时只写半截、浏览器崩在写入中间、手改过；
 * · 一旦损坏，`saveMapPrefs` 在 parse 处抛错 → 被 catch 吞掉 → return false；
 * · 于是设置再也存不进去，且没有任何提示。
 *
 * 这里统一为：读坏了 → 把坏档原样挪到 `K + '.broken'`（留作排查）→ 当空盒子用；
 * 下一次保存写出好档 → 自动恢复，无需清整站数据。
 * 注意：`readJSONBox` 不能直接返回 `{}` 了事 —— 坏档不挪走时，下一次 `localStorage.setItem` 虽可覆盖，
 * 但若此刻配额也满，覆盖失败 → 坏档始终留在原地 → 每次启动都白读一次。
 */
function readJSONBox(key, fallback) {
  const fb = (fallback === undefined) ? {} : fallback;
  let raw = null;
  try { raw = localStorage.getItem(key); } catch (e) { return fb; }   // 隐私模式下读取即抛错
  if (!raw) return fb;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : fb;
  } catch (e) {
    try {
      // 保留坏档片段（截断到 512KB 以内，避免撑爆配额），随后清除正本
      localStorage.setItem(key + '.broken', String(raw).slice(0, 512 * 1024));
      localStorage.removeItem(key);
    } catch (e2) { /* 无法挪走时保留原地，保证本次调用可用 */ }
    return fb;
  }
}

/** 写回一个盒子；写入失败（无痕模式 / 配额满）返回 false，调用方需判断 */
function writeJSONBox(key, box) {
  try { localStorage.setItem(key, JSON.stringify(box)); return true; } catch (e) { return false; }
}

/**
 * 设置 / 最近颜色使用的键 = 游戏类型（ck3 / eu4 / hoi4 / vic3 / eu5）
 * 与「哪一张图」无关（TNO 与原版共用一份）
 */
function prefsKeyOf(meta) {
  return (meta && meta.game) ? String(meta.game) : '';
}

/** 读设置 + 最近颜色（无数据返回 null，使用出厂值） */
function loadMapPrefs(meta) {
  try {
    const k = prefsKeyOf(meta);
    if (!k) return null;
    const box = readJSONBox(SET_KEY, {});
    let v = box[k];
    /* 旧格式按每张图存储（键 = mapKeyOf）：读不到时回退读取一次，命中后迁移到游戏键，避免升级后原有设置丢失 */
    if (!v || typeof v !== 'object') {
      const old = mapKeyOf(meta);
      const legacy = old ? box[old] : null;
      if (legacy && typeof legacy === 'object') {
        v = legacy;
        box[k] = legacy;
        writeJSONBox(SET_KEY, box);
      }
    }
    // （水域专属边界宽浓的存档迁移已删除；存档中多余的键
    // 会被 Object.assign 拼进 state.set，无人读取，下次保存自然清除）
    return (v && typeof v === 'object') ? v : null;
  } catch (e) { return null; }
}

/** 按游戏类型保存设置 + 最近颜色（写入失败返回 false，调用方需判断） */
function saveMapPrefs() {
  try {
    const k = prefsKeyOf(state.meta);
    if (!k || !state.set) return false;
    const box = readJSONBox(SET_KEY, {});
    box[k] = { set: Object.assign({}, state.set),
               // 最近颜色：只保留颜色及其标记名（最多 24 条，与内存中的上限一致）
               recent: (state.recent || []).slice(0, 24) };
    return writeJSONBox(SET_KEY, box);
  } catch (e) { return false; }
}
let saveTimer = 0;

/**
 * 涂色结束后延迟写盘，等操作停止一段时间再存
 * 存的是设置 + 最近颜色（涂色数据不在此处落盘，见 saveProject）
 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveMapPrefs, 800);
}

/** 打包成一份工程数据 */
function projectData() {
  const t = state.titles;
  const out = { version: 1, generated: new Date().toISOString(), titles: {}, labels: {},
                // 图例设置随「导出涂色」一起保存（含条目自定义名 / 顺序）
                legend: { show: !!(state.set && state.set.legend),
                          title: (state.set && state.set.legendTitle) || '',
                          titleOnly: !!(state.set && state.set.legendTitleOnly),
                          pos: (state.set && state.set.legendPos) || 'tl',
                          size: (state.set && state.set.legendSize) || 'm',
                          scale: Number(state.set && state.set.legendScale) || 1,
                          font: (state.set && state.set.legendFont) || '',
                          cols: (state.set && state.set.legendCols) || 1,
                          bg: (state.set && state.set.legendBg) || '#ffffff',
                          bgAlpha: state.set && state.set.legendBgAlpha != null ? state.set.legendBgAlpha : 90,
                          border: (state.set && state.set.legendBorder) || '#000000',
                          fg: (state.set && state.set.legendFg) || '#111111',
                          fgAuto: !!(state.set && state.set.legendFgAuto),
                          box: (state.set && state.set.legendBox) || 'square',
                          x: Number(state.set && state.set.legendX),
                          y: Number(state.set && state.set.legendY),
                          names: Object.assign({}, state.legendNames || {}),
                          on: Object.assign({}, state.legendOn || {}),
                          // 图例的手动顺序一并存档（在图例列表中用 ↑↓ 调整）
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
  /*
   * 逐最细层单位导出 —— 手绘层的实际数据是“每格自己的颜色 + 标记”：
   * 颜色读 `paintData[q]`、名字读 `labelNames[provLabel[q]]`
   * 按头衔存只能记下最后一笔（同一头衔下可以有多笔不同颜色 / 名字，
   * 如 1936 那半壁法国），逐格写不会丢
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
    /*
     * 占位符也要存 —— 否则读档后“明确留空”会变回“从没标记”，
     * 地图上会冒出原版地名（占位符本身不显示，见 displayedLabel）
     */
    if (lq >= 0 && state.labelNames[lq]) out.labels[key] = String(state.labelNames[lq]);
  }
  return out;
}

/*
 * 暂存：按地图分开存
 * 设计如此（localStorage 防手滑刷新，导出文件做备份）
 * 键中带“哪张图”：钢铁雄心4 的原版 / 修改边界版、以及各代游戏之间互不干扰
 */
const STASH_KEY = 'pdx-map-editor/stash/v1';

/** 地图标识：换地图数据即失配（有 stashKey 用 stashKey，否则按数据特征拼接） */
function mapKeyOf(meta) {
  if (!meta) return '';
  if (meta.stashKey) return String(meta.stashKey);
  return [meta.game, meta.mapWidth, meta.mapHeight, meta.numTitles,
          meta.numProvinces].join('|');
}
function stashBox() {
  return readJSONBox(STASH_KEY, {});
}
/** 把当前图上的涂色写入暂存区；写入失败（无痕模式、配额满）返回 false */
function stashNow() {
  try {
    const k = mapKeyOf(state.meta);
    if (!k || !state.titles) return false;
    const box = stashBox();
    box[k] = projectData();
    return writeJSONBox(STASH_KEY, box);
  } catch (e) { return false; }
}

/*
 * 暂存的写入时机：只在“回主菜单”那一刻 -------------------------------两条路分开：
 * · 回主菜单 → 保留，回来接上
 * · F5 / 刷新 → 清空，从零开始
 * 因此这里（涂一笔就触发的自动保存）不落盘：一旦在此存，F5 也会把内容接回来
 * 真正写盘的地方只有一处：goHome 里那次 stashNow
 */
function saveProject() {
  // 空实现（不要在此调用 stashNow()，见上段说明）
}

function loadProject() {
  // 回到同一张图时，接上上次“回主菜单”存下的那份
  // 接完立即删除，使随后的 F5 从零开始
  // （不删则 F5 会再次接回，与主菜单行为无法区分）
  /*
   * 仓库载入进行中时不接 stash
   * boot 前面刚把仓库存档的涂色套上，此处若再用“上次退出时的暂存”覆盖，
   * 玩家点涂色方案→选地图，载入的就是旧状态
   */
  if (state._pendingProject) return 0;
  try {
    const k = mapKeyOf(state.meta);
    if (!k) return 0;
    const box = stashBox();
    const data = box[k];
    if (!data) return 0;
    const n = applyProject(data) || 0;
    /*
     * 接完立即删除，否则紧接着 F5 又会接回来必须“删除 + 写回 localStorage”两步都做：
     * 仅 delete 内存中那份并调用不存在的存档写入函数，会抛错并被 catch 吞掉，
     * 内存删了而 localStorage 里那份原封不动，于是每次刷新都从旧数据读回
     */
    delete box[k];
    writeJSONBox(STASH_KEY, box);
    return n;
  } catch (e) { return 0; }
}

/** 把一份工程数据套到当前状态上，返回恢复了几个头衔同时兼容手写的 { "e_xxx": [r,g,b] } 扁平格式 */
function applyProject(data) {
  // 外部文件 / 暂存区读回的数据不可信：不是对象即视为无可识别内容
  if (!data || typeof data !== 'object') return 0;
  const t = state.titles;
  if (!t || !t.index) return 0;
  const colors = data.titles || data.colors || data;
  // 导入时一并还原图例设定
  if (data.legend) {
    state.set = state.set || {};
    const lg = data.legend;
    state.set.legend = !!lg.show;
    state.set.legendTitle = lg.title || '';
    state.set.legendTitleOnly = !!lg.titleOnly;
    state.set.legendPos = lg.pos || 'tl';
    state.set.legendSize = lg.size || 'm';
    state.set.legendScale = Number(lg.scale) > 0 ? Number(lg.scale) : 1;
    state.set.legendFont = lg.font || '';
    state.set.legendCols = Math.min(8, Math.max(1, Number(lg.cols) | 0 || 1));
    state.set.legendBg = /^#[0-9a-f]{6}$/i.test(lg.bg || '') ? lg.bg : '#ffffff';
    state.set.legendBgAlpha = Number(lg.bgAlpha);
    if (!(state.set.legendBgAlpha >= 0 && state.set.legendBgAlpha <= 100)) state.set.legendBgAlpha = 90;
    state.set.legendBorder = /^#[0-9a-f]{6}$/i.test(lg.border || '') ? lg.border : '#000000';
    state.set.legendFg = /^#[0-9a-f]{6}$/i.test(lg.fg || '') ? lg.fg : '#111111';
    state.set.legendFgAuto = !!lg.fgAuto;
    state.set.legendBox = ['square', 'rect', 'circle'].includes(lg.box) ? lg.box : 'square';
    state.set.legendX = Number(lg.x);
    if (!(state.set.legendX >= 0 && state.set.legendX <= 1)) state.set.legendX = 0.04;
    state.set.legendY = Number(lg.y);
    if (!(state.set.legendY >= 0 && state.set.legendY <= 1)) state.set.legendY = 0.04;
    // 兼容含 names 的存档（缺失则为空，全部使用自动名）
    state.legendNames = Object.assign({}, lg.names || {});
    state.legendOn = Object.assign({}, lg.on || {});
    // 同时还原图例顺序（存档无此字段则空数组，按大小排序）
    state.legendOrder = Array.isArray(lg.order) ? lg.order.slice() : [];
  }
  const labels = data.labels || {};
  if (data.names && typeof data.names === 'object') {
    state.titleName = new Map();
    for (const [k, nm] of Object.entries(data.names)) {
      const tid = t.index[k];
      if (tid != null && nm) {
        state.titleName.set(tid, String(nm));
        if (t.names) t.names[tid] = String(nm);   // 标签层读取的是这份数据
      }
    }
    labelDirty = true;
    blocksDirty = true;
  }
  // 按文件声明清理原版“国家级”头衔名
  // 1444/1618/1789 三层的名字是原版数据（普鲁士、美利坚、大不列颠、清…）
  // displayedLabel() 对没涂色的省会回退到 state.titles.names[tid]，
  // 这些不属于本图的国名会漏到地图上。
  // 仅当导入文件显式带 "clearEraNames": true 才清理，默认不动
  if (data.clearEraNames) {
    const _t = state.titles;
    const _nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
    if (_t && _t.names && _nEra > 0) {
      let _cleared = 0;
      for (let i = 0; i < _t.names.length; i++) {
        if (_t.tiers[i] < _nEra && _t.names[i]) {
          // 直接抹除：名字从画面上消失是该文件要求的效果
          // （原实现还留一份备份给“数据首都”路径当身份用；首都机制移除后
          // 备份无人读取，一并删除）
          _t.names[i] = '';
          _cleared++;
        }
      }
      if (_cleared) { labelDirty = true; blocksDirty = true; }
    }
  }
  // 导入不改动“设置”：工程中的 settings 是导出时刻的界面开关
  // （势力名 / 地名若被套回来，剧本国家名会整片为空）
  // 导入只负责涂色，显示内容由当前开关决定
  const savedLabel = state.brushLabel;
  /*
   * 导入是“还原账本”，不是一次手涂 —— 无论当前是否为「仅上色」，
   * 标记都要按存档写回（否则导入后标记全为空）
   */
  const savedLimit = state.set ? state.set.paintLimit : null;
  if (state.set) state.set.paintLimit = 'both';
  let n = 0;

  for (const [key, rgb] of Object.entries(colors)) {
    const tid = t.index[key];
    if (tid == null || !Array.isArray(rgb) || rgb.length < 3) continue;
    if (t.tiers[tid] >= TIER_COUNT) continue;   // 荒地不涂
    setBrushLabel(labels[key] || t.names[tid]);
    /*
     * 每涂一个先不重算账本 —— 含几千个头衔的工程会卡十几秒
     * 整批涂完在下面算一次即可（读数相同，避免重复 N 遍）
     */
    paintTitle(tid, [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0], false, true);
    n++;
  }
  if (n) recomputePainted();                 // 整批只计算这一次（账本与「改动 N」都在此处更新）

  setBrushLabel(savedLabel);
  if (state.set && savedLimit != null) state.set.paintLimit = savedLimit;
  if (n) { blocksDirty = true; labelDirty = true; }
  return n;
}

/*
 * 地图仓库
 * 「存入地图仓库」取代「导出涂色」：
 * 命名后存入浏览器（IndexedDB，见 packstore.js 的 `saved_maps`），
 * 选图页的「地图仓库」统一管理：载入继续画 / 改名 / 复制 / 删除 /导出 .json / 分享给朋友
 * 一条记录中的 project 即 `projectData()` 的工程 JSON；导出的 .json
 * 拖回窗口仍可使用（importJSON 路径不变）
 */

/** 编辑器构建戳（`<meta name="pdx-build">`，在仓库元数据中记录一份） */
function appBuild() {
  try {
    const mm = document.querySelector('meta[name="pdx-build"]');
    return mm ? String(mm.content || 'dev') : 'dev';
  } catch (e) { return 'dev'; }
}

/**
 * 仓库记录（project = projectData() 那份）
 * 不存缩略图：`preview`（320 宽 JPEG dataURL）不在卡片上显示，
 * 每份存档却多占十几 KB，故不生成也不写入该字段
 */
function mapStoreRec(name) {
  const m = state.meta;
  return {
    format: 'pdx-saved-map',
    v: 1,
    id: 'sm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: String(name || '').trim() || ('未命名 ' + new Date().toLocaleDateString()),
    created: Date.now(), updated: Date.now(),
    emb: String(state.mapEmb || ''),
    base: String((m && m.label) || ''),
    game: String((m && m.game) || ''),
    mapKey: mapKeyOf(m),
    build: appBuild(),
    project: projectData(),
  };
}

/** 存入仓库（已有备份后关闭页面不再提示，见 beforeunload 的 _exported） */
async function saveMapToStore(name) {
  const rec = mapStoreRec(name);
  const count = Object.keys((rec.project && rec.project.titles) || {}).length;
  if (!count) { toast('当前没有涂色内容，无法保存。', true); return null; }
  try {
    await putMap(rec);
    const back = await getMap(rec.id);
    if (!back) throw new Error('写进去了但读不回来');
  } catch (e) {
    toast('保存失败：' + (e && e.message || e), true);
    return null;
  }
  state._exported = true;
  LOG.event('存入地图仓库', rec.name + ' · ' + count + ' 处');
  const mode = await packStoreMode().catch(() => 'idb');
  toast(mode === 'memory'
    ? '已存入：「' + rec.name + '」。⚠ 这台浏览器无法长期保存，刷新后会丢失'
    : '已存入地图仓库：「' + rec.name + '」');
  return rec;
}

/**
 * 保存地图的默认名
 * · 格式：「EU4 · 10月27日」，可分辨地图与保存日期
 * · 仅预填并全选：可直接输入覆盖，不改动则保留
 */
function defaultSaveName() {
  const d = new Date();
  const day = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  const game = (typeof GAME !== 'undefined' && GAME && GAME.name) ? GAME.name : '地图';
  return game + ' · ' + day;
}

/**
 * 保存 / 加载地图共用弹窗
 * · save：起名另存；下方面板列出已有存档，可逐条覆盖
 * · load：只列存档，点一行即载入
 */
let _saveDlgMode = 'save';
function setSaveDlgMode(mode) {
  _saveDlgMode = mode === 'load' ? 'load' : 'save';
  const t = $('save-map-title');
  if (t) t.textContent = _saveDlgMode === 'load' ? '加载地图' : '保存地图';
  const inp = $('save-map-name');
  if (inp) inp.hidden = _saveDlgMode === 'load';
  const ok = $('save-map-ok');
  if (ok) ok.hidden = _saveDlgMode === 'load';
}

async function renderSaveMapList() {
  const wrap = $('save-map-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  let all = [];
  try { all = await listMaps(); } catch (e) { toast('读取地图仓库失败：' + (e && e.message || e), true); return; }
  /* 只列同一游戏类型的存档（EU4 的存档不在 HOI4 图里出现）：
     覆盖与载入都只认这一类 */
  const game = String((state.meta && state.meta.game) || '');
  if (game) all = all.filter((r) => String(r.game || '') === game);
  let mode = 'idb';
  try { mode = await packStoreMode(); } catch (e) { /* 探测失败按可用处理 */ }
  const hint = $('save-map-hint');
  if (hint) {
    const mem = mode === 'memory';
    hint.hidden = !mem;
    hint.textContent = mem ? '⚠ 这台浏览器无法长期保存数据，刷新后会丢失' : '';
  }
  if (!all.length) {
    const em = document.createElement('div');
    em.className = 'store-empty';
    em.textContent = game
      ? '还没有「' + ((typeof GAME !== 'undefined' && GAME && GAME.name) || game) + '」的存档'
      : '仓库还是空的';
    wrap.appendChild(em);
    return;
  }
  for (const rec of all) {
    const row = document.createElement('div');
    row.className = 'store-row' + (_saveDlgMode === 'load' ? ' load' : '');
    const nm = document.createElement('b');
    nm.textContent = rec.name || '未命名';
    const dt = document.createElement('span');
    dt.className = 'store-date';
    const when = rec.updated || rec.created || 0;
    dt.textContent = when ? new Date(when).toLocaleDateString() : '';
    row.appendChild(nm);
    row.appendChild(dt);
    if (_saveDlgMode === 'save') {
      const ov = document.createElement('button');
      ov.type = 'button';
      ov.className = 'btn ghost store-ov';
      ov.textContent = '覆盖';
      ov.onclick = async (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (!confirm('用当前的涂色覆盖「' + (rec.name || '未命名') + '」？')) return;
        try {
          rec.project = projectData();
          rec.updated = Date.now();
          await putMap(rec);
          toast('已覆盖「' + (rec.name || '未命名') + '」');
          renderSaveMapList();
        } catch (err) {
          toast('覆盖失败：' + (err && err.message || err), true);
        }
      };
      row.appendChild(ov);
      row.onclick = () => { /* 保存模式点行不动作，只认「覆盖」 */ };
    } else {
      row.onclick = () => loadStoreRec(rec);
    }
    wrap.appendChild(row);
  }
}

async function openSaveMapDialog(mode) {
  const box = $('save-map');
  if (!box) return;
  setSaveDlgMode(mode);
  if (_saveDlgMode === 'save') {
    const inp = $('save-map-name');
    if (inp) inp.value = defaultSaveName();
  }
  box.hidden = false;
  renderSaveMapList();
  if (_saveDlgMode === 'save') {
    const inp = $('save-map-name');
    if (inp) { inp.focus(); inp.select(); }
  }
}

/** 从存档载入：暂存到 sessionStorage，刷新回选图页再挑底图 */
function loadStoreRec(rec) {
  if (!rec || !rec.project) return;
  const pd = renderer && renderer.paintData;
  const n = state.meta ? state.meta.numProvinces : 0;
  let has = false;
  for (let q = 1; q < n; q++) { if (pd && pd[q * 4 + 3] > 0) { has = true; break; } }
  if (has && !confirm('载入会用「' + (rec.name || '未命名') + '」覆盖当前地图上的涂色，继续？')) return;
  const box = $('save-map');
  if (box) box.hidden = true;
  try {
    const pids = [];
    for (let q = 1; q < n; q++) { if (pd && pd[q * 4 + 3] > 0) pids.push(q); }
    if (pids.length) paintPidsAsOne(pids, null);
    const got = applyProject(rec.project) || 0;
    /* 整份替换：旧历史记的是上一份涂色，撤回去只会得到半截状态 */
    state.history.undo.length = 0;
    state.history.redo.length = 0;
    updateHistoryUI();
    recomputePainted();
    blocksDirty = true;
    labelDirty = true;
    if (renderer) renderer.dirty = true;
    renderHoverCard(state.hover.pid);
    if (got) {
      state._exported = true;
      toast('已载入「' + (rec.name || '未命名') + '」：' + got + ' 处涂色');
      LOG.event('载入存档', (rec.name || '') + ' · ' + got + ' 处');
    } else {
      toast('这份存档在「' + ((state.meta && state.meta.label) || '') + '」上没有能识别的涂色。', true);
    }
  } catch (e) {
    toast('载入失败：' + (e && e.message || e), true);
  }
}

/** 存档弹窗的保存按钮 */
async function saveMapFromDialog() {
  const inp = $('save-map-name');
  const nm = inp ? String(inp.value || '').trim() : '';
  if (!nm) { toast('先起个名字。', true); return; }
  const box = $('save-map');
  if (box) box.hidden = true;
  await saveMapToStore(nm);
}

/** 工程 JSON 下载（仓库「导出」使用；文件名含存档名） */
function downloadProjectJSON(name, project) {
  const data = project || projectData();
  const count = Object.keys((data && data.titles) || {}).length;
  if (!count) { toast('这份存档没有涂色内容，无需导出。', true); return; }
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    (GAME && GAME.filePrefix ? GAME.filePrefix + '_' : '') + String(name || '涂色方案') + '.json');
  LOG.event('导出涂色方案', String(name || '') + ' · ' + count + ' 处');
}

/** 分享给好友：系统分享面板支持文件则直传，否则退回下载 */
async function shareProjectFile(name, project) {
  const data = project || projectData();
  if (!Object.keys((data && data.titles) || {}).length) {
    toast('这份存档没有涂色内容，无需分享。', true);
    return;
  }
  const fname = (GAME && GAME.filePrefix ? GAME.filePrefix + '_' : '')
    + String(name || '涂色方案') + '.json';
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  try {
    const file = new File([blob], fname, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: String(name || '涂色方案') });
      LOG.event('分享地图', String(name || ''));
      return;                                  // 系统分享面板已调起
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;  // 用户取消分享，不视为失败
    /* 其他错误退回下载 */
  }
  download(blob, fname);
  toast('这台浏览器不支持直接上传，已改为下载文件，可直接发送给他人。');
}

/** 选图页的仓库列表（打开面板或数据变更后重绘） */
async function renderStoreList() {
  /*
   * 渲染进 #map-pick-list（与地图卡同一容器）。
   * #map-store-list 已删除，指向它的引用会导致仓库列表空白。
   */
  const listEl = $('map-pick-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  let all = [], storeErr = null;
  try { all = await listMaps(); } catch (e) { storeErr = String(e && e.message || e); }
  /*
   * 读取失败不得静默处理成“空仓库”（import 遗漏时 listMaps 为 undefined，
   * catch 一吞界面即显示空仓库，真实原因被掩盖）有错必须显式提示
   */
  if (storeErr) { toast('仓库读取失败：' + storeErr, true); return; }
  for (const rec of all) {
    /*
     * 卡片样式与地图区一致：使用 `.map-card` 那套（相同的悬停浮起 / 金色名字 / 右下角动作），
     * 点卡片 = 载入（与点地图卡 = 进图语义相同）
     * 名字 / 元数据用 textContent：导入的 .json 来自他人文件
     */
    /*
     * 卡片结构与地图卡一致：同一个 `.map-card` 类、同一 flex 排法、同一 hover
     * b = 存档名（金色）/ span = 元数据（mono 淡色）
     * .map-card-tag = 左下角游戏签名 .map-card-acts = 右下角动作
     * 名字 / 元数据用 textContent：导入的 .json 来自他人文件
     * （无缩略图 —— 地图卡同样没有，保持整齐）
     */
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'map-card';
    const nm = document.createElement('b');
    nm.textContent = rec.name || '未命名';
    /* 元数据留空占位（flex 布局需要；内容已全部移除） */
    const meta = document.createElement('span');
    meta.textContent = '';
    const acts = document.createElement('span');
    acts.className = 'map-card-acts';
    const mkAct = (text, danger, fn) => {
      const x = document.createElement('span');
      x.className = 'map-act' + (danger ? ' danger' : '');
      x.textContent = text;
      x.onclick = (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (ev && ev.preventDefault) ev.preventDefault();
        return fn();
      };
      return x;
    };
    acts.append(
      mkAct('导出', false, () => downloadProjectJSON(rec.name, rec.project)),
      mkAct('改名', false, () => storeRename(rec)),
      mkAct('删除', true, () => storeDelete(rec)),
    );
    /* 右下角签名：地图类型（与地图卡的版本号同位置） */
    if (rec.game) {
      const tag = document.createElement('span');
      tag.className = 'map-card-tag';
      tag.textContent = rec.game.toUpperCase();
      card.appendChild(tag);
    }
    card.append(nm, meta, acts);
    /* 点卡片 → 回「开始创作」页挑底图（不限定具体地图）涂色挂在存档上，选完图就绪后自动套用/ */
    card.onclick = () => storePickMapFor(rec);
    listEl.appendChild(card);
  }
}

function fmtStoreDate(t) {
  try {
    const d = new Date(t || Date.now());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 '
      + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  } catch (e) { return ''; }
}

/**
 * 点仓库卡片：回到「开始创作」页挑底图（不限定必须选哪张 ——
 * 存档的涂色跟随所选底图，选完图就绪后自动套用）
 * 注意：底图与存档不一致时（mapKey 不同）boot 会阻止套用。
 */
function storePickMapFor(rec) {
  state._pendingProject = { project: rec.project, mapKey: rec.mapKey || '', name: rec.name || '' };
  setPackMsg('', '请选择载入的地图包');
  const tab = $('pick-tab-maps');
  if (tab) tab.click();
}

async function storeRename(rec) {
  const nm = prompt('新的名字：', rec.name || '');
  if (nm == null) return;
  const clean = String(nm).trim();
  if (!clean) { toast('名字不能是空的。', true); return; }
  rec.name = clean;
  rec.updated = Date.now();
  await putMap(rec);
  renderStoreList();
}

async function storeDelete(rec) {
  /* 提示文案与地图包一致 */
  if (!confirm('是否删除该地图？')) return;
  await deleteMap(rec.id);
  renderStoreList();
}

/** 导入 .json 到仓库：支持仓库导出的整条存档与裸工程 JSON 两种 */
async function storeImportFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data && data.format === 'pdx-saved-map' && data.project) {
      const rec = Object.assign({}, data, {
        id: 'sm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        name: String(data.name || file.name.replace(/\.json$/i, '')),
        updated: Date.now(),
        created: data.created || Date.now(),
      });
      await putMap(rec);
    } else if (data && (data.titles || data.colors)) {
      const def = String(file.name || '').replace(/\.json$/i, '');
      const nm = prompt('这份是涂色方案。给它在仓库里起个名：', def);
      if (nm == null) return;
      const rec = mapStoreRec(String(nm).trim() || def || '未命名');
      rec.project = data;
      rec.mapKey = '';                     // 裸工程无底图信息，载入时不做键校验
      rec.base = data.base || '';
      await putMap(rec);
    } else {
      toast('这份文件不是涂色方案 / 仓库存档。', true);
      return;
    }
    await renderStoreList();
    toast('已导入地图仓库。');
  } catch (e) {
    toast('导入失败：' + (e && e.message ? e.message : e), true);
  }
}

/*
 * 收藏调色板
 * 侧栏「调色板」面板：收藏颜色，跨游戏共用（localStorage）
 * · 左键圆圈 = 直接用作画笔色（绘图时的高频动作）
 * · 右键圆圈 = 从调色板删除
 * · 底部「＋ 收当前颜色」= 把当前画笔颜色收进来
 * · 不限数量：新的在最前，旧的保留（localStorage 可存几千个）
 */
const PAL_FAV_KEY = 'pdx-map-editor/palette-fav/v1';

function paletteList() {
  const raw = readJSONBox(PAL_FAV_KEY, []);
  return Array.isArray(raw) ? raw.filter((c) => typeof c === 'string') : [];
}

function paletteSaveArr(arr) {
  writeJSONBox(PAL_FAV_KEY, arr);   // 写入失败不处理（无痕 / 配额满）
  renderPaletteFav();
}

function paletteAdd(hex) {
  const c = String(hex || '').toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(c)) return false;
  const arr = paletteList();
  const at = arr.indexOf(c);
  if (at >= 0) arr.splice(at, 1);            // 已存在则移到最前
  arr.unshift(c);
  paletteSaveArr(arr);
  return true;
}

function paletteRemoveAt(i) {
  const arr = paletteList();
  if (i < 0 || i >= arr.length) return false;
  arr.splice(i, 1);
  paletteSaveArr(arr);
  return true;
}

function paletteReset() { paletteSaveArr([]); }

/**
 * 收起色块的二级菜单（选中颜色 / 点外部 / 去拾色器时都会调用）
 * 注意：仅写调用而漏写函数体会导致 ReferenceError（调用先于定义存在属正常），函数本体不可遗漏
 */
function closeBrushMenu() {
  const m = $('brush-menu');
  if (m) m.hidden = true;
}

function renderPaletteFav() {
  const box = $('palette-fav');
  if (!box) return;
  box.innerHTML = '';
  /* 收藏行：圆角方块 + 行尾的「＋ 收当前颜色」（单独的收色按钮已删除，收色即点行尾这块）/ */
  paletteList().forEach((hex, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.style.background = hex;
    /* 不写原生 title（避免悬停小白块）；aria-label 供读屏使用 */
    chip.setAttribute('aria-label', '调色板颜色 ' + hex);
    chip.addEventListener('click', () => {
      const c = hexToRgb(hex);
      if (c) setBrush(c, false);             // 不进入「最近使用」：它本就是收藏项
      closeBrushMenu();
    });
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      paletteRemoveAt(i);
    });
    box.appendChild(chip);
  });
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'chip palette-plus';
  plus.textContent = '＋';
  plus.setAttribute('aria-label', '收当前颜色进调色板');
  plus.addEventListener('click', () => { paletteAdd(rgbToHex(state.brush)); });
  box.appendChild(plus);
}

/**
 * 导出报错日志 —— 出问题时报给作者的那份 txt。
 * 与其他导出的区别：不要求存在错误，没有错误也能导出 ——
 * 「有点卡」「名字对不上」「导出来的图不对」这类问题，
 * 日志中的状态与轨迹信息足以定位（无需让玩家按 F12 抄控制台）。
 * 崩溃上屏框里挂的是同一个入口（见 showFatal）：此时顶栏已无法点击，但该按钮仍可操作。
 */
function exportLog() {
  LOG.event('导出诊断报告', state.meta ? '顶栏 / 文件菜单' : '启动页');
  // 未选图时用中性前缀；已选图则带游戏名（便于在附件中辨认）
  const prefix = (state.meta && GAME && GAME.filePrefix)
    ? GAME.filePrefix : 'pdx-map-editor';
  const ok = LOG.download(`${prefix}_诊断报告_${stamp()}.txt`);
  if (!ok) {
    toast('诊断报告导不出来（日志模块未加载）', true);
    return false;
  }
  toast('已导出诊断报告，出现问题时请发送给作者。');
  return true;
}

function importJSON(file) {
  // 导入一份文本 —— 两条入口（拖文件 / 传文本）共用的收尾
  // （两个分支各写一份逐字相同的处理时，修改 toast 易只改一处而产生分叉）
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
    recomputePainted();      // 手绘层变更：重算账本
  };

  // 两种入口：拖进来给的是 File/Blob，别处给的可能已经是文本
  if (typeof file === 'string') { applyText(file); return; }
  const reader = new FileReader();
  reader.onload = () => applyText(reader.result);
  reader.readAsText(file);
}

function resetAll() {
  /*
   * 「清除全部」也可撤销：
   * · 清空撤销栈（`undo.length = 0`）时误触一次，整张图的涂色与所有撤销记录一并丢失，Ctrl+Z 也无法恢复；
   * · 现走 `paintPidsAsOne`：一次点击 = 一步历史，故无需确认弹窗；
   * · 不得再清空撤销栈 —— 清空后这一步也撤不回来。
   */
  const pd = renderer && renderer.paintData;
  const n = state.meta ? state.meta.numProvinces : 0;
  const pids = [];
  for (let q = 1; q < n; q++) if (pd && pd[q * 4 + 3] > 0) pids.push(q);
  if (!pids.length) return;
  LOG.event('清除全部改动', `${pids.length} 格（可撤销）`);
  paintPidsAsOne(pids, null);
  renderHoverCard(state.hover.pid);
}

/**
 * 清除荒地涂色
 * 做两件事：
 *   ① 清除荒地块上玩家手绘的颜色（走正常擦除路径，算一步撤销）；
 *   ② 关闭「荒地 · 自动上色」，并把荒地节点的 LUT 刷回荒地灰 ——
 *      不关闭时下一帧 `wasteWatch` 会按周围颜色重新算出，表现为按钮未生效。
 * 注意：只处理荒地，普通地块一律不动；地图没有荒地（VIC3 / HOI4 原版）时按钮禁用。
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
    paintPidsAsOne(pids, null);      // 一次点击 = 一步撤销
  }
  // ② 自动上色：关闭，否则清除后立即又被算回
  state.wasteAuto = false;
  const autoEl = $('waste-auto');
  if (autoEl) autoEl.checked = false;
  state._wasteSig = null;
  try { refreshWasteAuto(); } catch (e) { /* 计算失败不应影响清除 */ }
  if (renderer) renderer.dirty = true;
  // 色块 / 图例 / 悬停都跟着变
  blocksDirty = true;
  labelDirty = true;
  renderHoverCard(state.hover.pid);
  LOG.event('清除荒地涂色',
    `已清除 ${pids.length} 格手绘涂色${autoWas ? '（自动上色此前已关闭）' : ''}`);
  toast(pids.length || autoWas ? '已清除荒地涂色' : '荒地上本来就没有涂色');
}

// ---------------------------------------------------------------- 事件

/*
 * 导入字体
 * 用户可导入地名 / 势力名的字体并存到本地，随时切换
 * 两槽（地块名 / 势力名）各选各的，互不影响
 * 字体字节在 IndexedDB 里（`fonts.js`），选中的那套以族名记进设置
 * 修改后需让标签重排 —— 只置 labelDirty 不够：字形贴图和量宽缓存
 * 按字体分键，未用过新字体时不会命中旧数据
 * 旧字体的贴图仍保留（占内存，不碍事，最终会被预算挤掉）
 */
function bindFontPicker() {
  const selPlace = $('set-font-place');
  const selPower = $('set-font-power');
  const btnImport = $('btn-font-import');
  const btnDel = $('btn-font-del');
  const fileEl = $('font-file');
  if (!selPlace && !selPower) return;      // 无这套 UI 的页面直接跳过

  /*
   * 字体名来自用户（文件名）—— 直接拼进 innerHTML 会被 `<` `&` 破坏，
   * 甚至可注入标签，因此需要转义
   */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** 下拉选项：默认字体 + 本地字体库 */
  let fonts = [];

  const familyOfId = (id) => fontLibFamily(id);

  /* 设置里存的是键：TTF → 族名 `PDX-Font-xxx`位图 → `bm:<id>`（位图字体没有族名，用前缀区分）/ */
  const isBmKey = (v) => typeof v === 'string' && v.startsWith('bm:');
  const keyOfFont = (f) => (f.kind === 'bitmap' ? 'bm:' + f.id : familyOfId(f.id));
  const idOfKey = (key) => {
    if (!key) return '';
    if (isBmKey(key)) {
      const id = key.slice(3);
      return fonts.some((f) => f.id === id) ? id : '';
    }
    const hit = fonts.find((f) => f.kind !== 'bitmap' && familyOfId(f.id) === key);
    return hit ? hit.id : '';
  };

  /** 取（必要时创建）一套位图字体，与图例共用全局缓存 */
  const loadBitmapFont = (id) => _loadBmFont(id);

  /** 把库里的字体刷进两个下拉 */
  const refresh = async () => {
    fonts = await fontLibList().catch(() => []);
    for (const sel of [selPlace, selPower]) {
      if (!sel) continue;
      const keep = sel.value;
      sel.innerHTML = '<option value="">默认</option>'
        + fonts.map((f) => {
          const tag = f.kind === 'bitmap' ? '（位图）' : '';
          return `<option value="${f.id}">${esc(f.name || f.id)}${tag}</option>`;
        }).join('');
      // 尽量保留当前选中项（被删除的会回落到默认）
      if (keep && fonts.some((f) => f.id === keep)) sel.value = keep;
    }
    // 未导入任何字体时，删除按钮无意义
    if (btnDel) btnDel.disabled = fonts.length === 0;
    // 图例的字体下拉使用同一个库；导入 / 删除 / 清空后同步刷新
    refreshLegendFonts().catch(() => { /* 图例字体读取失败不影响字体库本身 */ });
  };

  /*
   * 状态行：设置在设置面板中的一行常驻文字toast 消失后无法复述发生了什么
   * 此处固定显示当前字体与已解出的字形数
   */
  function setFontStatus(msg, bad) {
    const el = $('font-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = bad ? '#e08a8a' : '';
  }
  /**
   * 浏览器是否接受该字体`document.fonts.check()` 按 CSS 规则判定：家族与字重均匹配才为 true
   * 仅看「设置里选中了」无效 —— 注册失败时选中状态同样成立
   */
  function fontReadyTag(fam) {
    try {
      if (!document.fonts || !document.fonts.check || !fam) return '';
      return document.fonts.check(`600 20px "${fam}"`) ? '（已生效）' : '（浏览器未识别）';
    } catch (e) { return ''; }
  }

  /** 把当前两槽的实际状态拼成一句话 */
  function refreshFontStatus(extra) {
    const parts = [];
    for (const [kind, label] of [['place', '地块'], ['power', '势力']]) {
      const bf = labelBitmap(kind);
      const fam = labelFont(kind);
      if (bf) {
        parts.push(`${label} = 位图「${bf.face || '?'}」${bf.meta.chars.size} 字`);
      } else if (fam) {
        parts.push(`${label} = ${fam}${fontReadyTag(fam)}`);
      } else {
        parts.push(`${label} = 默认`);
      }
    }
    setFontStatus((extra ? extra + ' · ' : '') + parts.join(' / '));
  }

  /**
   * 选中的字体 → 推给标签层并落盘位图字体需现读现造（dds 可达几十 MB），故为 async；
   * 构造失败则退回默认字体，不得让画面停在半截
   */
  const applyFace = async (kind, sel) => {
    if (!sel) return;
    const id = sel.value || '';
    const keyName = kind === 'power' ? 'fontFacePower' : 'fontFacePlace';
    const f = fonts.find((x) => x.id === id);
    if (!f) {
      state.set[keyName] = '';
      setLabelFont(kind, '');
      setLabelBitmap(kind, null);
      labelDirty = true;
      drawFontPreview();
      refreshFontStatus();
      scheduleSave();
      return;
    }
    if (f.kind === 'bitmap') {
      setFontStatus(`正在读位图字体「${f.name}」…`);
      const bf = await loadBitmapFont(f.id);
      setLabelFont(kind, '');
      setLabelBitmap(kind, bf || null);
      state.set[keyName] = bf ? ('bm:' + f.id) : '';
      if (!bf) {
        sel.value = '';
        setFontStatus(`「${f.name}」读不出来`, true);
        toast(`「${f.name}」这套位图字体没读出来`);
      }
    } else {
      setLabelBitmap(kind, null);
      const fam = familyOfId(f.id);
      setLabelFont(kind, fam);
      state.set[keyName] = fam;
      /*
       * 注册失败必须当场提示选中状态始终正确，仅看下拉会误以为成功；
       * 此处向浏览器查询该字体是否可用，不可用则明确告知
       */
      if (!fontLibReady(f.id)) {
        setFontStatus(`「${f.name}」浏览器没认这套字体（格式不支持？）`, true);
      }
    }
    labelDirty = true;              // 下一帧按新字体重排
    drawFontPreview();              // 设置页那行样例同步更新
    refreshFontStatus();
    scheduleSave();
  };

  /*
   * 字体预览：在地图上判断字体是否生效，取决于那一刻是否绘制了名字，不可靠
   * 此处固定绘制一行样例：地名槽字体与势力名槽字体各半行
   * 位图字体无法用 CSS，只能逐字贴图，两条路径分开绘制
   */
  function drawFontPreview() {
    /*
     * 预览出错不得影响导入：它只是样例行，画不出来至多样例为空
     * 异常若抛到 `importFontFiles` 的 catch，会出现字体已入库、下拉已有选项，
     * 却提示「这个字体没能导入」
     */
    try {
      const cv = $('font-preview');
      if (!cv || !cv.getContext) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const W = cv.width || 260, H = cv.height || 40;
      ctx.clearRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const size = Math.round(Math.min(22, H * 0.62));

      /* 位图字体优先：势力槽有则演示该槽，其次地名槽（两槽通常为同一套，先看哪槽有就画哪槽）/ */
      const bw = labelBitmap('power');
      const bp = labelBitmap('place');
      if (bw) { bw.draw(ctx, '势力 Abc', W / 2, H / 2, size, '#e8d9a8', { outline: 0 }); return; }
      if (bp) { bp.draw(ctx, '地名 Abc', W / 2, H / 2, size, '#e8d9a8', { outline: 0 }); return; }

      const fam = labelFont('power') || labelFont('place');
      ctx.fillStyle = '#e8d9a8';
      ctx.font = `600 ${size}px ${fam ? `"${fam}", ` : ''}"Microsoft YaHei", sans-serif`;
      ctx.fillText('地名 势力', W / 2, H / 2);
    } catch (e) {
      try { console.warn('[字体预览] 画不出来（不影响使用）', e); } catch (e2) { /* 忽略 */ }
    }
  }

  if (selPlace) selPlace.addEventListener('change', () => { applyFace('place', selPlace); });
  if (selPower) selPower.addEventListener('change', () => { applyFace('power', selPower); });

  if (btnImport && fileEl) {
    btnImport.addEventListener('click', () => {
      fileEl.value = '';            // 使同一文件可再次选择
      fileEl.click();
    });
    /*
     * 支持一次选择多个文件位图字体为一对文件：`.fnt`（索引）+ `.dds`（字图），
     * 需支持按住 Ctrl 多选或整个文件夹全选按主名配对：`zh-hans-16.fnt` ↔ `zh-hans-16.dds`
     * 只提供一半时必须说明缺少哪个，不得静默失败
     * 抽成 `importFontFiles(files)` 以使拖放走同一路径
     * （舞台拖放原本只认 .json，字体拖入会被当作涂色文件退回）
     */
    const importFontFiles = async (list) => {
      const files = Array.from(list || []);
      if (!files.length) return;
      /* 大字体读取需数秒（地图字体 .dds 约 40 MB），无「在处理」提示会被误认为点击无效/ */
      toast('正在读字体…');
      try {
        const byBase = new Map();
        for (const f of files) {
          const base = (f.name || '').replace(/\.[^.]+$/, '');
          let g = byBase.get(base);
          if (!g) { g = { base, fnt: null, dds: null, other: null }; byBase.set(base, g); }
          const ext = ((f.name || '').match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
          if (ext === 'fnt') g.fnt = f;
          else if (ext === 'dds') g.dds = f;
          else g.other = f;
        }

        let imported = 0;
        /*
         * 入库成功即导入成功：后续「换上」步骤出错，
         * 也不得回头提示「没能导入」（字体已在库中、下拉已有选项）。
         */
        const applyQuietly = async (id) => {
          try { await useNewFont(id); } catch (e) {
            try { console.warn('[字体] 换上时出错（已入库，可在下拉里手动选）', e); } catch (e2) { /* 忽略 */ }
          }
        };
        /*
         * 同一字体的多页需先合并：`CN_mapfont_0` / `CN_mapfont_1` 分开导入会各得一半
         * 判据为 fnt 中的 `info face`，同一 face 即同一字体只选一页也可用：该页含有的字可用，其余留空
         */
        const _faceOf = (txt) => {
          const m = /info[^\n]*face="([^"]*)"/.exec(String(txt || ''));
          return m ? m[1] : '';
        };
        const _shown = new Set();
        for (const g of byBase.values()) {
          if (g.fnt || g.dds) {
            if (!g.fnt || !g.dds) {
              toast(`「${g.base}」缺一半：位图字体要 .fnt 和 .dds 一起选`);
              continue;
            }
            if (_shown.has(g.base)) continue;
            const fntText = await g.fnt.text();
            const face = _faceOf(fntText);
            /* 同 face 的其余页一并收入（按名字排序，页序稳定） */
            const pages = [];
            const sibs = [...byBase.values()]
              .filter((o) => o.fnt && o.dds && !_shown.has(o.base))
              .sort((a, b) => a.base.localeCompare(b.base));
            for (const o of sibs) {
              const t = o === g ? fntText : await o.fnt.text();
              if (o !== g && _faceOf(t) !== face) continue;
              pages.push({ fnt: t, dds: await o.dds.arrayBuffer() });
              _shown.add(o.base);
            }
            const ddsBuf = pages[0].dds;
            const rec = await fontLibAddBitmap(g.base, pages);
            await refresh();
            await applyQuietly(rec.id);
            toast(`已导入位图字体「${rec.name}」`);
            LOG.event('导入位图字体',
              `${rec.name} · ${(ddsBuf.byteLength / 1024 / 1024).toFixed(1)} MB`);
            imported++;
            continue;
          }
          if (g.other) {
            /*
             * 必须取 ArrayBuffer，不得把 File 直接入库
             * File/Blob 在 Safari 隐私模式下会被 IndexedDB 拒收（见 fonts.js）
             */
            const bytes = await g.other.arrayBuffer();
            const rec = await fontLibAdd(g.base, bytes);
            await refresh();
            await applyQuietly(rec.id);
            toast(rec.ok ? `已导入字体「${rec.name}」` : `「${rec.name}」导进来了，但这个格式认不出`);
            LOG.event('导入字体',
              `${rec.name} · ${(bytes.byteLength / 1024).toFixed(0)} KB · ${rec.ok ? '可用' : '注册失败'}`);
            imported++;
          }
        }
        if (!imported) toast('没有认出字体文件（要 .ttf / .otf / .woff，或者 .fnt + .dds 一对）');
      } catch (e) {
        /* 存不下：浏览器 IndexedDB 有配额，地图字体一套可达几十 MB，容易触顶 */
        const quota = e && (e.name === 'QuotaExceededError'
          || /quota|storage/i.test(String(e.message || '')));
        const msg = quota
          ? '浏览器存储空间不足：请先删除部分字体后重试'
          : ('这个字体没能导入：' + ((e && e.message) || e));
        toast(msg, true);
        setFontStatus(msg, true);
        LOG.event('导入字体失败', (e && (e.name + ': ' + e.message)) || String(e));
        // 控制台同样输出一份，便于玩家直接转发
        try { console.error('[字体导入失败]', e); } catch (e2) { /* 忽略 */ }
      }
    };
    /* 舞台拖入字体时使用（见 bindEvents 中的拖放分派） */
    fontDropHandler = importFontFiles;
    fileEl.addEventListener('change', () => importFontFiles(fileEl.files));
  } else {
    fontDropHandler = null;
  }

  /*
   * 清空字体库：库中残留的坏记录会长期占用下拉，
   * 留着会被误认为新导入的也无效；清空后重新导入最省事。
   */
  const btnClear = $('btn-font-clear');
  if (btnClear) {
    btnClear.addEventListener('click', async () => {
      if (!confirm('清空整个本地字体库？\n（已导入的字体会被删除，地图与涂色不受影响）')) return;
      try { await fontLibClear(); } catch (e) { /* 忽略 */ }
      _bmFontCache.clear();
      await refresh();
      setLabelFont('place', ''); setLabelBitmap('place', null);
      setLabelFont('power', ''); setLabelBitmap('power', null);
      state.set.fontFacePlace = '';
      state.set.fontFacePower = '';
      if (selPlace) selPlace.value = '';
      if (selPower) selPower.value = '';
      labelDirty = true;
      drawFontPreview();
      refreshFontStatus('已清空');
      scheduleSave();
      toast('字体库已清空');
    });
  }

  /** 刚导入的那套直接启用两槽皆空则同时替换；已有选择时只补空槽，不覆盖已有选择/ */
  const useNewFont = async (id) => {
    const targets = [];
    if (selPlace) targets.push(['place', selPlace]);
    if (selPower) targets.push(['power', selPower]);
    const empty = targets.filter(([, el]) => !el.value);
    const use = empty.length ? empty : [targets[0]];
    for (const [, el] of targets) {
      if (use.some(([, x]) => x === el)) el.value = id;
    }
    for (const [k, el] of use) await applyFace(k, el);
  };

  if (btnDel) {
    btnDel.addEventListener('click', async () => {
      // 删除对象：两个下拉中当前选中的那项（都选中同一套则删除它）
      const ids = [selPlace && selPlace.value, selPower && selPower.value].filter(Boolean);
      const id = ids[0];
      if (!id) { toast('先在上面选一个导入的字体'); return; }
      const f = fonts.find((x) => x.id === id);
      if (!f) return;
      if (!confirm(`删除字体「${f.name}」？\n（用了它的地名 / 势力名会回到默认字体）`)) return;
      await fontLibRemove(id);
      _bmFontCache.delete(id);
      // 选中它的两槽均退回默认
      for (const [sel, kind] of [[selPlace, 'place'], [selPower, 'power']]) {
        if (sel && sel.value === id) { sel.value = ''; await applyFace(kind, sel); }
      }
      await refresh();
      toast('已删除');
      LOG.event('删除字体', f.name);
    });
  }

  /*
   * 启动：把库中已有字体注册进 document，再刷新下拉
   * 注册为异步（需等字体解析完成）；不 await 会出现下拉已有名字、
   * 画面仍为默认字体，看似「导入的没生效」
   */
  (async () => {
    try { await fontLibLoadAll(); } catch (e) { /* // 老浏览器无 FontFace 时跳过 */ }
    await refresh();
    /* 接上上次选中的那套（TTF 存族名、位图存 bm:id；库被清空则回默认） */
    for (const [kind, sel, saved] of [
      ['place', selPlace, state.set && state.set.fontFacePlace],
      ['power', selPower, state.set && state.set.fontFacePower],
    ]) {
      if (!sel) continue;
      const id = idOfKey(saved);
      sel.value = id;
      if (id) await applyFace(kind, sel);      // 走同一条路径，不在此另写一份
      else { setLabelFont(kind, ''); setLabelBitmap(kind, null); }
    }
    drawFontPreview();                         // 预览同样按上次选中的那套绘制
    refreshFontStatus();                       // 状态行照实输出
    labelDirty = true;
  })();
}

function bindEvents() {
  const stage = $('stage');

  /*
   * 回主菜单（选地图页）：右上角按钮或 Esc
   * 换地图需重建数据、渲染器与全部状态，本应用未提供「重新初始化」入口，
   * 自行实现易导致状态错乱；页面自带的启动流程（boot）正好完成该工作，故采用重新加载
   * 回主菜单前先把涂色存入暂存区，再选同一张图可自动接上
   */
  const goHome = () => {
    const boot = $('boot');
    if (boot && getComputedStyle(boot).display !== 'none') return;   // 仍在启动 / 选图阶段，不处理
    let dirty = 0;
    try { dirty = (state.changed && state.changed.size) || 0; } catch (e) { dirty = 0; }
    if (dirty > 0 && !stashNow()) {
      // 存不进暂存区（无痕模式 / 配额满）时才询问，至少不静默丢失
      if (!window.confirm('这台浏览器不让暂存，回主菜单会丢掉还没导出的涂色（改动 ' + dirty + ' 处）。\n'
        + '想留着就先点「文件 ▾ → 存入地图仓库」存一份。\n\n确定要回主菜单吗？')) return;
    }
    location.reload();
  };

  /*
   * Esc 只承担一件事：回主菜单（不逐层返回）因此不判断输入框焦点与弹层状态，按下即回主菜单
   * 但须抢占事件：先 preventDefault，再 stopImmediatePropagation，
   * 否则改名框与导出菜单各自的 Esc 会同时响应
   */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    goHome();
  });

  /*
   * 滚轮缩放：一步到位（不做分帧缓动）
   * 分帧消费累积量虽更顺滑，但滚轮停止后画面仍在移动，手感发拖，已否决
   * 现为一格滚轮即算完、立即出结果嫌单格步幅过大只调下方系数（越小越细，无缓动）：
   */
  const WHEEL_K = 0.0016;
  /*
   * 滚轮缩放：合并到帧 ----触控板一次划动可连发十几个 `wheel` 事件，逐事件执行 `zoomBy`
   * 等于整张图重复渲染十几遍（还需重排标签），缩放因此卡顿
   * 现把比例累乘、每帧只应用一次（累乘不丢缩放量，手感与逐事件一致）
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
    if (wheelRaf) return;                       // 该帧已排队
    wheelRaf = requestAnimationFrame(() => {
      wheelRaf = 0;
      const k = wheelAcc, at = wheelAt;
      wheelAcc = 1;
      if (k !== 1 && at) zoomBy(k, at.x, at.y);
    });
  }, { passive: false });

  /*
   * 浮在画布上的控件不得把点击漏给地图。
   * `.zoom-box`（缩放 − ＋ ⤢）、`.toast`、`#hover-card` 均为 `.stage` 的子元素，
   * 而 `mousedown` 挂在 `stage` 上并冒泡 —— 点「＋」会被当作在该处涂色，改动的是真实数据。
   * 手机版已有该判断（`mobile_js.txt` 的 `onWidget`），桌面版同样需要。
   * 两边保持同一份清单，新增控件需两边同改。
   */
  const onWidget = (t) => !!(t && t.closest
    && t.closest('.zoom-box, button, input, a, select, .modal, .toast, #hover-card, #boot,'
      + ' #flag-pop, #flag-knobbox'));

  /*
   * 手机上「旗帜」点不动
   * 桌面链路挂在 `mousedown` 上，而手机没有鼠标；且 `mobile_js.txt` 的 `touchstart`
   * 为免重复涂色调用了 `e.preventDefault`，规范规定取消 touch 系列后浏览器
   * 不再补发 `mousedown` / `mouseup` / `click`，故该段在手机上永不进入
   * （同一文件在电脑浏览器中正常，因有真实鼠标）
   * 此处自行接一道触摸：抬手时（未拖动）走同一个 `flagClickAt`
   * 必须同步调用，不得套 `setTimeout` / `await` —— `flagClickAt` 内会
   * `input.click` 弹出系统选图，用户手势过期后（iOS / 安卓均如此）不再弹出
   * 手指移动超过 12px 视为拖动地图，不算点击（与移动端其它工具阈值一致）
   */
  let flagTap = null;
  let flagTouchAt = -1e9;       // 上次用触摸处理旗帜的时间（用于拦掉重复的合成 mousedown）
  stage.addEventListener('touchstart', (e) => {
    if (state.tool !== 'flag' || e.touches.length !== 1) { flagTap = null; return; }
    if (onWidget(e.target)) return;
    const t = e.touches[0];
    flagTap = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!flagTap || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - flagTap.x, t.clientY - flagTap.y) > 12) flagTap = null;
  }, { passive: true });
  stage.addEventListener('touchend', () => {
    const at = flagTap;
    flagTap = null;
    if (!at) return;
    flagTouchAt = performance.now();
    try { flagClickAt(at.x, at.y); } catch (err) { console.warn('[旗帜] ' + err); }
  });
  stage.addEventListener('touchcancel', () => { flagTap = null; });

  stage.addEventListener('mousedown', (e) => {
    /*
     * 必须在第一句拦截：拖到下方任一分支才拦已过晚
     * （不改 `panning` / 不落笔 / 不 `preventDefault`，使按钮自身的 click 正常触发）
     */
    if (onWidget(e.target)) return;
    /* 导出框选进行中：画布上的工具全部停用（拖框交由 `#export-pick-layer` 处理） */
    if (_exportDlg.picking) return;
    /*
     * 旗帜工具：点一块地，有旗则选中、无旗则选图（不落笔、不拖地图）
     * 必须排在涂色分支前，否则点击会连带把地块涂色
     */
    if (state.tool === 'flag' && e.button === 0) {
      /* 同一次点按若已被上方触摸分支消费，不得再弹第二个选图框 */
      if (performance.now() - flagTouchAt < 700) return;
      if (flagClickAt(e.clientX, e.clientY)) { e.preventDefault(); return; }
    }
    if (e.button === 1 || (e.button === 0 && state.tool === 'view')) {
      panning = { x: e.clientX, y: e.clientY, cx: state.cam.cx, cy: state.cam.cy };
      $('map').style.cursor = 'grabbing';
      e.preventDefault();
    } else if (e.button === 0 && state.tool !== 'view') {
      // 仅「涂抹 / 橡皮」支持按住拖动连发
      // 「填色」一次一个（按住拖动也不会沿路填一片）
      // 改名等单击工具同理（否则从 A 拖到 B 会沿路连发）
      painting = (state.tool === 'paint' || state.tool === 'erase');
      actAt(e.clientX, e.clientY);
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (_exportDlg.picking) return;          // 框选时画布工具全部停用
    const rect = stage.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                   e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (panning) {
      const dx = (e.clientX - panning.x) / state.cam.scale;
      const dy = (e.clientY - panning.y) / state.cam.scale;
      state.cam.cx = panning.cx - dx;
      state.cam.cy = panning.cy - dy;
      noteViewMotion();
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
    /*
     * 光标在侧栏 / 浮层上不等于在地图上
     * 侧栏是盖在画布上的兄弟节点，window 级 mousemove 在其上同样触发，被盖住的地块会被高亮 / 悬停
     * `e.target` 为光标下最上层元素：不在 #stage 内即视为出界，按出界处理，清空悬停
     * （拖画同样停止 —— 隔着侧栏涂下方地块本属误操作）
     */
    const overMap = !!(e.target && e.target.closest && e.target.closest('#stage'));
    if (!overMap) {
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
    if (painting) state._blocksForce = true;    // 松手：补上拖动期间欠下的重算
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
    /*
     * 右键取色同样需要拦截在「＋」上点右键会被当作取该格颜色，面板内按钮同理
     * 此处只阻止浏览器菜单，不取色
     */
    if (onWidget(e.target)) { e.preventDefault(); return; }
    e.preventDefault();
    /* // 框选进行中：右键也不取色 */
    if (_exportDlg.picking) return;
    /* 查看模式：右键与长按均不取色查看即只看，不得顺带改动画笔颜色；浏览器菜单照常拦截/ */
    if (state.tool === 'view') return;
    pickAt(e.clientX, e.clientY);
  });

  window.addEventListener('resize', () => {
    renderer.resize();
    labels.resize();
    state.cam.cx = clamp(state.cam.cx, 0, state.meta.mapWidth);
    state.cam.cy = clamp(state.cam.cy, 0, state.meta.mapHeight);
    invalidate();
  });

  /*
   * 从后台返回：手机切出再回来黑屏的情形在此收口
   * · visibilitychange 为标准事件（手机 / 桌面均触发）
   * · pageshow 兜住从往返缓存返回（部分浏览器只触发这一条）
   * · focus 再兜一道（桌面切换窗口回来也重绘一帧）
   * 三者均在 onEnterForeground 内，重复触发无副作用
   */
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
    /*
     * 快捷键只作用于地理层，剧本层不占用。
     * 剧本最多可达 116 个（风云世纪两千年），按 1..116 排热键既按不过来，
     * 也会与其它快捷键冲突；且剧本依靠挑选而非计数，下拉栏点选更合适。
     * `TIER_HOTKEY` 中是地理层那一段的编号（1..N，见 buildToolbar），
     * 故此处算出的是地理层内部序号，需加 `eraTierCount` 才是层号（两者不再相等）。
     */
    {
      const _eraN = eraBlockCount();
      const ti = TIER_HOTKEY.indexOf(e.key);
      if (ti >= 0 && ti + _eraN < state.meta.tierNames.length) return pressTier(ti + _eraN);
    }
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

  // 色块点击 → 弹出系统取色器（与设置页的 <input type="color"> 相同）
  // 走 onManualColor：与上方 HEX 框同一路径（设色 + 重新定标），不只是改显示
  if ($('brush-swatch') && $('brush-color')) {
    // 取色器确认关闭后才记入「最近使用」（拖动过程中记录会刷满一屏）
    $('brush-color').addEventListener('change', () => {
      const c = hexToRgb($('brush-color').value);
      if (c) setBrush(c, true);
    });
    /*
     * 点大色块 → 弹出二级菜单：可去 RGB 拾色器调整，或从调色板 / 最近使用中挑选
     * （不再直接弹系统取色器）
     */
    /*
     * 菜单须移出左侧栏只要它仍是 `.sidebar` 的后代，无论 absolute 还是 fixed，展开时都会顶高
     * 侧栏的 scrollHeight（737 → 911），导致左栏出现滚动条
     * 解法是使其不再属于侧栏：改挂到 `document.body` 下，以 fixed 按色块屏幕坐标定位
     */
    (function liftBrushMenu() {
      const m = $('brush-menu');
      if (m && m.parentNode !== document.body) document.body.appendChild(m);
    })();

    $('brush-swatch').onclick = () => {
      const menu = $('brush-menu');
      if (!menu) return;
      menu.hidden = !menu.hidden;
      if (!menu.hidden) placeBrushMenu();
    };
    /*
     * 菜单改为 position: fixed原为 absolute + `top: calc(100% + 6px)`，挂在左侧栏滚动容器内，
     * 展开即顶高 scrollHeight（实测 737 → 911），侧栏出现滚动条
     * 改为 fixed 后不再计入侧栏滚动范围，坐标在此计算
     */
    function placeBrushMenu() {
      const menu = $('brush-menu');
      const sw = $('brush-swatch');
      if (!menu || !sw) return;
      const r = sw.getBoundingClientRect();
      /* // 色块滚出视口时直接收起，避免菜单悬空 */
      if (r.bottom < 0 || r.top > window.innerHeight) { closeBrushMenu(); return; }
      const w = 268;   // 与 CSS 的 width 一致（8 格 × 26px 刚好放得下）
      menu.style.position = 'fixed';
      menu.style.left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - w - 8)) + 'px';
      menu.style.top = Math.round(r.bottom + 6) + 'px';
      menu.style.maxHeight = Math.max(200, window.innerHeight - r.bottom - 20) + 'px';
      menu.style.overflowY = 'auto';
      menu.style.zIndex = '80';
    }
    window.addEventListener('resize', () => {
      const menu = $('brush-menu');
      if (menu && !menu.hidden) placeBrushMenu();
    });
    /* 侧栏滚动时菜单跟随色块移动，否则会与色块脱节 */
    (function watchSidebarScroll() {
      const sb = document.querySelector('.sidebar');
      if (!sb) return;
      sb.addEventListener('scroll', () => {
        const menu = $('brush-menu');
        if (menu && !menu.hidden) placeBrushMenu();
      }, { passive: true });
    })();
    $('brush-menu-custom').onclick = () => {
      $('brush-color').value = rgbToHex(state.brush);   // 每次打开都同步为当前色
      closeBrushMenu();
      /* 使用自写调色器，位置贴着大色块（`#brush-color` 为 1px 透明，不能作为锚点） */
      cpOpen($('brush-color'), $('brush-swatch'));
    };
    // 点击菜单外部即收起
    // 使用捕获阶段：冒泡阶段的 click 会被画布处理器截停
    // （合成点击无法关闭即由此导致）真实点击同样先走捕获 */
    document.addEventListener('click', (e) => {
      const menu = $('brush-menu');
      if (!menu || menu.hidden) return;
      if (e.target && e.target.closest && e.target.closest('#brush-menu')) return;
      if (e.target && e.target.closest && e.target.closest('#brush-swatch')) return;
      closeBrushMenu();
    }, { capture: true });
    // 用 input 而非 change：在取色器中拖动调整时可实时跟随
    $('brush-color').addEventListener('input', () => {
      const c = hexToRgb($('brush-color').value);
      if (c) { setBrush(c, false); labelForColor(c); }
    });
  }

  $('brush-label').addEventListener('input', (e) => {
    state.brushLabel = e.target.value;
  });
  $('label-select').addEventListener('change', (e) => {
    const tid = Number(e.target.value);
    if (Number.isFinite(tid)) setBrushLabel(state.titles.names[tid]);
  });

  // 开关
  /*
   * 「头衔」那组（原版颜色 / 地名 / 边界）的监听器随界面一并删除 ——
   * 其控制的三项现由「势力 / 地区」几组每帧计算（见 syncLayerSwitches）
   */
  $('show-paint').addEventListener('change', (e) => {
    state.showPaint = e.target.checked;
    renderer.setShowPaint(state.showPaint);
    // 关掉手绘层之后，头衔那一层要露出游戏原色 —— 不然玩家填的色还顶在 LUT 里
    resyncTitleLut();
    labelDirty = true;
  });
  // （荒地 / 水域的「允许上色 / 颜色 / 边界 / 清除 / 自动」监听器已全部删除
  // 水片与荒地片 = 普通头衔，不再有专属开关）
  /*
   * 「水域 · 边界 / 名称」两个开关。写法与上面那批不同（不往 `state` 里写、不调 syncXXX）：
   *   两个都是每帧现读的字段（`state.showWaterBorder` / `state.showWaterName`）——
   *   边界由 `syncLayerSwitches` 每帧解析成渲染器上的派生值；
   *   名称由 `drawLabels` 每帧取点前判一次。仍需监听器：勾选后要立刻置脏重画。主循环只在脏时重绘
   * （`draw` 里 `if (!this.dirty) return false;`），不置脏则画面要等下一次操作才变。
   * 勾「水域 · 名称」还要把标签重算（`labelDirty`），只置渲染器脏不够。
   */
  if ($('show-water-border')) {
    $('show-water-border').addEventListener('change', (e) => {
      state.showWaterBorder = !!e.target.checked;
      syncLayerSwitches();          // 立刻解析成渲染器上的 waterBorderOn
      renderer.dirty = true;
    });
  }
  if ($('show-water-name')) {
    $('show-water-name').addEventListener('change', (e) => {
      state.showWaterName = !!e.target.checked;
      labelDirty = true;            // 水名那一批点要在下一次取点时重判
      renderer.dirty = true;
    });
  }
  /*
   * 「荒地 · 名称」（显示区新增的一行）。  写法与水域那条相同（每帧现读、都只置脏）。
   *   注意：荒地没有「边界」那一条 —— 荒地无专属边界，这里只处理名称。
   */
  if ($('show-waste-name')) {
    $('show-waste-name').addEventListener('change', (e) => {
      state.showWasteName = !!e.target.checked;
      labelDirty = true;
      renderer.dirty = true;
    });
  }
  /*
   * 「荒地 · 边界」，写法与水域边界相同。  它走 `syncLayerSwitches`（与水域边界同一处）——
   *   「勾选 + 这张图有身份标」的 AND 在里面，此处不要再自行 AND 一遍。
   */
  if ($('show-waste-border')) {
    $('show-waste-border').addEventListener('change', (e) => {
      state.showWasteBorder = !!e.target.checked;
      syncLayerSwitches();
      renderer.dirty = true;
    });
  }
  /*
   * 「荒地自动上色」开关。  只写 state，真正重算由帧循环的 `wasteWatch` 按签名做；
   *   此处置脏，保证下一帧立刻可见。
   */
  if ($('waste-auto')) {
    $('waste-auto').addEventListener('change', (e) => {
      state.wasteAuto = !!e.target.checked;
      state._wasteSig = null;
      if (renderer) renderer.dirty = true;
    });
  }
  /*
   * 「地块」那几个开关：勾选后写回状态（下一帧 syncLayerSwitches 解析生效）。
   *   「剧本」那三个已删除 —— 不再有互斥绑定与其监听器。
   */
  for (const [id, key] of [['show-region-color', 'showRegionColor'],
                           ['show-region-border', 'showRegionBorder'],
                           ['show-region-name', 'showRegionName']]) {
    const el = $(id);
    if (el) el.addEventListener('change', (e) => {
      state[key] = e.target.checked;
      /*
       * 「地区 · 颜色」变化时，荒地自动色须重算。
       *   自动色的取色来源之一就是它（见 `wasteVoteColor`）——
       *   关闭时应退回荒地色；只改状态不重算时，上一轮的色会留在 LUT 上。
       *   注意：剧本颜色固定开启（对应复选框已删除），无需监听。
       */
      if (key === 'showRegionColor') {
        try { refreshWasteAuto(); } catch (err) { /* */ }
      }
    });
  }

  /*
   * 边界：原版那条没有开关了（「剧本」那组已删除）——
   * 有年代层的模式由「地区 · 边界」管；这里只剩「势力 · 边界」这个复选框要听
   * （「势力 · 边界」= 玩家涂色块的边界；按当前显示的颜色画）。
   */
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
  /*
   * 地名：界面原有左右两个开关（头衔组内那个管头衔 / 地区名），头衔组那个已删除
   * 现只有「填色 · 名称」，普通地名（头衔 / 地区 / 省份名）由解析层按势力 / 地区每帧计算
   */
  /*
   * 「父级边界」关闭时只画本层一条线（多级链不画）
   * 仅「地区」组保留该开关；无年代层的老缓存上它可能不存在，故仍需判空
   */
  {
    const _el = $('show-parent-border');
    if (_el) _el.addEventListener('change', (e) => {
      state.showParentBorderTitle = e.target.checked;
      state._parentSig = null;
      syncParentBorder();
      renderer.dirty = true;
    });
  }
  // （此处原有「填色 · 边界」的监听器 —— 与上面 applyBorders 是同一件事的
  // 重复副本，已删除）

  /*
   * 「名称」只剩「势力 · 名称」这一个入口（「剧本 · 名称」镜像勾已随整组删除）。
   * 它同时管：玩家涂出来的色块名 + 剧本层那批国名（同一份分组）。
   */
  const _setLabelPaint = (on) => {
    blocksDirty = true;      // 玩家名字 = 全图实时重分组
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
    const _ae = $('btn-apply-era');
    if (_ae) _ae.onclick = applyEraPaint;
  }
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

  // 「设置」二级面板（右上角开，改完立刻生效）
  {
    const _panel = $('settings');
    /* 本函数只负责把控件填成当前值，不负责显示 / 隐藏（开合带动画，显示需单独控制）/ */
    const _fill = () => {
      if (!_panel) return;
      const s = state.set || {};
      const _now = (key) => {
        const c = s[key];
        if (c) return rgbToHex(c);
        /*
         * 两项默认色：bg 「背景颜色」—— 180,180,180（220 → 200 → 180）
         * unpainted 「未上色区域」—— 150,150,150（中性灰）
         */
        if (key === 'bg') return rgbToHex([180, 180, 180]);
        if (key === 'unpainted') return rgbToHex([150, 150, 150]);
        /*
         * 海 / 不可通行海域 / 湖 / 河 / 不可通行 五行。
         * 出厂色与 `index.html` 那七行、与 `build_data.py` 的类色一致。
         */
        if (NATURE_RGB[key]) return rgbToHex(NATURE_RGB[key]);
        return '#808080';
      };
      /*
       * 两种控件都要认（步进器 / 分段条没有 .value）：
       * 颜色 / 文本 / 下拉 / 勾选 → 直接写 value / checked；
       * 步进器 / 分段条 → 走 setCtlValue（吸附到最近档位）。
       */
      const put = (id, v) => {
        const el = $(id);
        if (!el || v == null) return;
        if (el._steps) { setCtlValue(id, Number(v)); return; }
        if (el.tagName === 'INPUT' && el.type === 'checkbox') { el.checked = !!v; return; }
        el.value = v;
      };
      put('set-bg', _now('bg'));
      put('set-unpainted', _now('unpainted'));
      // 七行里的另外五行 （海 / 不可通行海域 / 湖 / 河 / 不可通行区域）
      for (const _k5 of ['sea', 'isea', 'lake', 'river', 'impass']) {
        put('set-' + (_k5 === 'impass' ? 'impass' : _k5), _now(_k5));
      }
      // 线宽五档 / 浓度四档：回填时吸附到最近的档位
      //（存档里可能是滑杆版本的连续值，下拉里没有该项会显示成空白）
      /*
       * 「地方边界宽度」拆成地区 / 省份两条。
       * 存档只有 `w` 时 → 两条都按它回填（此时两边同值，观感不变）。
       */
      const _wOld = Number(s.w != null ? s.w : (state._borderWidthBase || 1));
      put('set-w-region', snapStep(Number(s.wRegion != null ? s.wRegion : _wOld), W_STEPS));
      put('set-w-prov', snapStep(Number(s.wProv != null ? s.wProv : _wOld), W_STEPS));
      put('set-pw', snapStep(Number(s.pw != null ? s.pw : 1), PW_STEPS));
      put('set-pa', snapStep(Number(s.pa != null ? s.pa : 50), CONC_STEPS));
      put('set-ra', snapStep(Number(s.ra != null ? s.ra : 75), CONC_STEPS));
      put('set-ca', snapStep(Number(s.ca != null ? s.ca : 100), CONC_STEPS));
      /*
       * 水域边界那一对。存档无这两项 → 出厂值（宽 1 / 浓 100%），
       * 与「水域线一直画、实心」的既有口径一致，观感不变。
       */
      put('set-water-w', snapStep(Number(s.waterW != null ? s.waterW : SET_DEFAULTS.waterW), W_STEPS));
      put('set-water-a', snapStep(Number(s.waterA != null ? s.waterA : SET_DEFAULTS.waterA), CONC_STEPS));
      /* 荒地那一对（存档无这两项 → 出厂值 1 / 25%）。 */
      put('set-waste-w', snapStep(Number(s.wasteW != null ? s.wasteW : SET_DEFAULTS.wasteW), W_STEPS));
      put('set-waste-a', snapStep(Number(s.wasteA != null ? s.wasteA : SET_DEFAULTS.wasteA), CONC_STEPS));
      /* 两块字号都从 `fontSizes` 取（存档中该数字两块共用，迁移只此一处）。 */
      const _fo0 = fontSizes(s);
      put('set-fontplace', _fo0.place);
      put('set-fontpower', _fo0.power);
    put('set-labelac', s.labelAC != null ? s.labelAC : SET_DEFAULTS.labelAC);
    put('set-labelap', s.labelAP != null ? s.labelAP : SET_DEFAULTS.labelAP);
      // 背景那两条线：宽度 + 浓度（存档无这几项 → 用出厂值
      //   水域 / 荒地的专属宽浓那六格已随开关一并取消）
      // 名字上限：range（1~20，拉满 = 无上限）+ 旁边那个数值
      put('set-labelmax', s.labelMax != null ? s.labelMax : SET_DEFAULTS.labelMax);
      const _lmv0 = $('set-labelmax-v');
      if (_lmv0) _lmv0.textContent = labelMaxText();
      // 地名上限：另一根（同款"拉满 = 无上限"）；回填 + 刷旁边那个数值
      put('set-labelplacemax',
        s.labelPlaceMax != null ? s.labelPlaceMax : SET_DEFAULTS.labelPlaceMax);
      const _lpmv0 = $('set-labelplacemax-v');
      if (_lpmv0) _lpmv0.textContent = labelPlaceMaxText();
      // 取色后切到哪个画图工具（涂抹 / 填色）
      put('set-picktool', s.pickTool === 'fill' ? 'fill' : 'paint');
      // 涂色限制：上色+标记 / 仅上色
      put('set-paint-limit', s.paintLimit === 'color' ? 'color' : 'both');
      // 图例那一栏：勾选 / 标题 / 位置 / 尺寸 / 颜色 / 字体 / 列数 / 色块 全部回填
      // （仅回填三项会导致换完存档后其它控件仍停在旧值上）
      syncLegendControls(s);
      legendFresh();               // 先补算色块再列，避免列到上一个剧本的条目
      syncAllCtls();              // 所有数值控件的当前值 / HEX / 不限那两个勾
    };

    /*
     * 开 / 合
     * 设置按钮的显示动画：按一下弹出，再按一下隐藏，不依赖右上角小叉。
     * 与「☰ 侧栏」同一手感：同一条曲线 `.24s cubic-bezier(.16,1,.3,1)`，
     * 方向相反：侧栏往左滑出、设置从右滑入。
     * 为什么用 setTimeout 收尾，不能只靠 CSS：
     *   `#settings[hidden] { display: none !important }`
     *   `display` 由 `block` 变 `none` 是瞬间跳变，transition 不会执行；
     *   → 关闭：先摘 `.open`（触发滑出动画）→ 等它跑完再设 `hidden`；
     *   → 打开：`hidden = false` 之后等一帧再加 `.open`；
     *     同一帧里改两个属性，浏览器会合并成最终状态，动画不触发。
     * 关闭的 240ms 里抽屉仍为 `display:block`，
     * CSS 那边给 `#settings:not(.open) { pointer-events: none }`，故不接收点击。
     */
    const CLOSE_MS = 240;
    let _closeTimer = 0;
    /* 序号：开合靠 rAF 异步完成
 * 用户"点开 → 立刻又点关"时，那个还没跑的 rAF 会把面板又打开
 * → 每次开/合都 +1 rAF 里比对 对不上就直接放弃 */
    let _seq = 0;
    /*
     * 开合状态用布尔量记，不要看瞬时样式。
     *   若判断写成 `if (!hidden && classList.contains("open")) 关`：  `.open` 是 rAF 之后才加的，
     *   → 「点开 → 立刻又点关」时那一刻 `.open` 还没有，
     *   → 条件不成立 → 走 `openSettings()` 又开一次（表现为连点两下没关掉）。
     *   → 现用 `_wantOpen` 记意图，不受动画时序影响。
     */
    let _wantOpen = false;

    const _syncBtn = () => {
      const b = $('btn-settings');
      if (!b) return;
      b.setAttribute('aria-expanded', _wantOpen ? 'true' : 'false');
    };

    const openSettings = () => {
      if (!_panel) return;
      clearTimeout(_closeTimer);
      _wantOpen = true;
      _fill();                       // 每次打开都按当前状态回填
      _panel.hidden = false;
      const my = ++_seq;
      /* 合成"最终状态" 动画根本不触发套两层是稳妥写法 （第一层等样式结算、第二层等布局） */
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!_panel || my !== _seq) return;   // ← 期间被关掉了就别开
          _panel.classList.add('open');
          _syncBtn();
        });
      });
      _syncBtn();
    };

    const closeSettings = () => {
      if (!_panel) return;
      ++_seq;                        // ← 作废上面那些还没跑的 rAF
      _wantOpen = false;
      _panel.classList.remove('open');   // ← 这一步触发滑出
      _syncBtn();
      clearTimeout(_closeTimer);
      _closeTimer = setTimeout(() => {
        /*
         * 必须判 `_wantOpen` 不能判 `.open`"刚点开、rAF 还没跑"的那一瞬间 `.open` 是没有的
         * 判 `.open` 就会把刚打开的面板又藏起来 （闪一下就没）
         */
        if (_panel && !_wantOpen) _panel.hidden = true;
      }, CLOSE_MS);
    };

    const toggleSettings = () => {
      if (!_panel) return;
      /* 判 `_wantOpen`（意图） 不判 `.open`（瞬时样式）
 * 原因见上面 `_wantOpen` 那段注释 */
      if (_wantOpen) closeSettings();
      else openSettings();
    };

    /* 把这两个也挂到 window 上 手机版那边要用（它填完值要悄悄关掉
 * 直接写 `hidden = true` 会留下一个 `.open` 下次桌面打开就没动画了）*/
    try { window.__pdxSettings = { open: openSettings, close: closeSettings, toggle: toggleSettings }; } catch (e) { /* */ }

    const _sb = $('btn-settings');
    if (_sb) _sb.onclick = toggleSettings;
    _syncBtn();
    /* ESC 关掉 抽屉开着的时候才有反应 */
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !_panel || _panel.hidden) return;
      closeSettings();
    });

  /* ---- 顶栏高度写进 CSS 变量 ----
 * 侧栏要浮在"顶栏下面"，可顶栏会换行、高度不固定
 * → 量一次写进 --tb-h，`style.css` 那边 `top: var(--tb-h)` 直接用
 * 手机端不用（那套是 dock 布局 这条只在桌面端生效，写错了也不影响）*/
  {
    const tb = document.querySelector ? document.querySelector('.toolbar') : null;
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    const sync = () => {
      if (!tb || !root || !root.style || typeof root.style.setProperty !== 'function') return;
      const h = tb.offsetHeight || 46;
      root.style.setProperty('--tb-h', h + 'px');
    };
    sync();
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', sync);
      /* 工具栏折叠 / 展开也会变高 */
      const fold = $('toolbar-fold');
      if (fold) fold.addEventListener('click', () => setTimeout(sync, 0));
    }
  }
  /*
   * 白天 / 黑夜
   * 模式切换：开机那一下必须在 CSS 生效前定下 —— 真正设 data-theme 的是
   * `index.html` `<head>` 里那三行小脚本；这边只管切换和记住。
   * （放在此处会晚一拍，白底先闪一下再变黑。）
   * 配色无需额外处理 —— `style.css` 里 `html[data-theme="light"]` 覆盖了同一批变量，
   * 所有用 var(--panel/--text/--line) 的地方一起变。
   */
  {
    const btn = $('btn-theme');
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    const LABEL = () => (root && root.getAttribute('data-theme') === 'light')
      ? '☀ 白天' : '☾ 夜间';
    if (btn) {
      btn.textContent = LABEL();
      btn.onclick = () => {
        if (!root) return;
        const toLight = root.getAttribute('data-theme') !== 'light';
        if (toLight) root.setAttribute('data-theme', 'light');
        else root.removeAttribute('data-theme');
        btn.textContent = LABEL();
        try { localStorage.setItem('pdx-theme', toLight ? 'light' : 'dark'); } catch (e) { /* 无痕模式存不了，无所谓 */ }
        /* 玻璃那层糊在画布上，换主题后让标签重画一遍，字才不会糊 */
        if (typeof labelDirty !== 'undefined') { try { labelDirty = true; } catch (e) {} }
        if (typeof invalidate === 'function') invalidate();
      };
    }
  }

  /*
   * 左侧栏折叠
   * 左侧栏可开可收：顶栏一个按钮，按一下开、再按一下关（与「设置」抽屉同一口径）。
   *   · 收起 = 侧栏滑出屏幕 + 宽度归零（地图吃满，见 CSS 那条长注释）；
   *   · 状态记在 `pdx-sidebar`（`"0"` = 收起，缺省 = 展开）。
   * 默认展开 —— 否则用户会以为侧栏丢失。
   * 手机版不执行此逻辑：手机版侧栏本就是 `display: none`（内容全搬进面板了），
   * 这里只给 `body` 加个类，手机版不认这个类，不会互相干扰。
   * 收起之后要让画布重算尺寸，否则地图宽度变了会拉伸 / 留白。
   */
  {
    const btn = $('btn-sidebar');
    const apply = (folded) => {
      try { document.body.classList.toggle('sb-folded', folded); } catch (e) { /* */ }
      if (btn) btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
      /* 布局变了 → 让上游重算画布 + 重画一帧
 * `resize` 那边有它自己的节流 这里直接调也安全 */
      try {
        if (typeof renderer !== 'undefined' && renderer && renderer.resize) renderer.resize();
      } catch (e) { /* 渲染器还没建好就跳过 */ }
      try { if (typeof invalidate === 'function') invalidate(); } catch (e) { /* */ }
    };
    /* 开机：读上次的状态 */
    let folded = false;
    try { folded = localStorage.getItem('pdx-sidebar') === '0'; } catch (e) { folded = false; }
    apply(folded);

    if (btn) {
      btn.onclick = () => {
        const now = !document.body.classList.contains('sb-folded');
        apply(now);
        try { localStorage.setItem('pdx-sidebar', now ? '0' : '1'); } catch (e) { /* 无痕模式 */ }
      };
    }
    /* 快捷键：`\`（反斜杠）开关
 * 输入框里打字时别抢 （改名、搜索、HEX 都在用键盘）*/
    document.addEventListener('keydown', (e) => {
      if (e.key !== '\\' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
                || t.isContentEditable)) return;
      e.preventDefault();
      if (btn) btn.onclick();
    });
  }
    // 署名那两个入口在文件开头就挂过了 这里再挂一次只是兜底（幂等）
    bindAuthorLinks();
    /*
     * 小叉仍然保留，但不再是唯一出路。
     *   顶栏「设置」按钮按一下开、再按一下关（见上面的 toggleSettings）；
     *   叉与 ESC 只是同样可以关闭。
     *   三条路都须走 `closeSettings`：直接写 `hidden = true` 会跳过滑出动画，
     *   并留下 `.open`，下次打开就不动。
     */
    if ($('set-close')) $('set-close').onclick = () => closeSettings();
    if (_panel) _panel.addEventListener('click', (e) => { if (e.target === _panel) closeSettings(); });
    const bindColor = (id, key) => {
      const el = $(id);
      if (!el) return;
      const commit = () => {
        const rgb = hexToRgb(el.value);
        if (!rgb) return;
        state.set[key] = rgb;
        applySettings();
        /*
         * 颜色也要落盘：只有 set + applySettings 而没有 scheduleSave 时，
         * 滑条会存、颜色不会：改完七个色关掉标签页，回来仍是旧色
         * （除非之后恰好拖了别的滑条 —— 这种「有时候能记住」最难查）。
         */
        scheduleSave();
        /* 旁边那格 HEX 跟着走 两个灰（#B4B4B4 / #969696）就靠它分得开 */
        const v = $('v-' + id);
        if (v) v.textContent = String(el.value || '').toUpperCase();
      };
      el.addEventListener('input', commit);
      el.addEventListener('change', commit);   // 取色器多半只在 change 时给最终值
    };
    if ($('btn-clear-recent')) $('btn-clear-recent').onclick = clearRecent;   // 清空记忆颜色
    bindColor('set-bg', 'bg');
    bindColor('set-unpainted', 'unpainted');
    // 七行里另外五行 （改完 `applySettings` → `applyNatureColors` 立刻重刷 LUT）
    bindColor('set-impass', 'impass');
    bindColor('set-sea', 'sea');
    bindColor('set-isea', 'isea');
    bindColor('set-lake', 'lake');
    bindColor('set-river', 'river');
    /*
     * 控件层 v2设置面板重做
     * 分层原因：数值控件原为 `<input type="range">`，但其中多数并非连续量：
     * · 线宽 6 档、不透明度 5 档、字号 26 档、数量 20 档
     * 滑条把它们画成连续体，118px 里 5.9px 一档，点一下就跳，也看不出有几档
     * → 离散量改用步进器（[−] 值 [+]）与分段条（5 段全可见）
     * 入口名保持不变：仍为 `bindRange(id, key)`，调用点二十余处，改名成本过高
     * 变化在内部：先判断元素是 `range` 还是步进器 / 分段条
     */
    const _ctlSteps = (el) => {
      if (el._steps) return el._steps;
      const st = el.getAttribute && el.getAttribute('data-steps');
      let out = [];
      if (st) out = st.split(',').map(Number).filter((v) => Number.isFinite(v));
      else {
        const rg = (el.getAttribute && el.getAttribute('data-range') || '').split(',').map(Number);
        if (rg.length === 3 && rg[2] > 0) {
          /* 用整数步进算，别拿浮点累加 —— 0.1 累加 26 次会攒出 2.9999999 */
          const n = Math.round((rg[1] - rg[0]) / rg[2]);
          for (let i = 0; i <= n; i++) out.push(Math.round((rg[0] + i * rg[2]) * 10) / 10);
        }
      }
      el._steps = out;
      return out;
    };

    /**
     * 数值写成一句话的格式（与标签同一套口径）。
     *  注意：v 可能尚未赋值（真机报错 `Cannot read properties of undefined (reading "toFixed")`）：
     *    控件造出来那一刻 `_val` 还是空的，`paint()` 就调到这里；
     *    → 先兜住，随后由 `setCtlValue` / `bindRange` 填真值。
     */
    const _ctlText = (fmt, v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      if (fmt === 'w') return n.toFixed(1) + ' 格';
      if (fmt === 'pct') return n === 0 ? '不画' : Math.round(n) + '%';
      if (fmt === 'mul') return n.toFixed(1) + '×';
      if (fmt === 'count') return n + ' 个';
      return String(n);
    };

    /** 把一个控件的外壳造出来并挂上点击 → onChange(新值) */
    const _buildCtl = (el, fmt, onChange) => {
      if (el._built) { el._onChange = onChange; return; }
      const steps = _ctlSteps(el);
      if (!steps.length) return;
      /* 先给初值再画（空着会一路掉进 _ctlText，toFixed 报错） */
      if (!Number.isFinite(el._val)) el._val = steps[0];
      const isStep = el.classList.contains('ctl-step');
      el.innerHTML = '';
      let paint;

      if (isStep) {
        const btn = (txt, dir) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = txt;
          b.onclick = () => {
            const i = steps.indexOf(el._val);
            const j = Math.max(0, Math.min(steps.length - 1, i + dir));
            if (j === i) return;
            el._val = steps[j];
            paint();
            onChange(el._val);
          };
          return b;
        };
        const minus = btn('−', -1);
        const val = document.createElement('span');
        val.className = 'ctl-val';
        const plus = btn('+', 1);
        el.appendChild(minus); el.appendChild(val); el.appendChild(plus);
        paint = () => {
          val.textContent = _ctlText(fmt, el._val);
          const i = steps.indexOf(el._val);
          minus.disabled = i <= 0;
          plus.disabled = i >= steps.length - 1;
        };
      } else {
        const btns = steps.map((s) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = s === 0 ? '—' : String(s);
          if (s === 0) b.classList.add('off0');
          b.onclick = () => {
            if (el._val === s) return;
            el._val = s; paint(); onChange(s);
          };
          el.appendChild(b);
          return { b, s };
        });
        paint = () => { for (const { b, s } of btns) b.classList.toggle('on', s === el._val); };
      }
      el._paint = paint;
      el._built = true;
      el._onChange = onChange;
      paint();
    };

    /** 把某个控件设成一个值（吸附到最近的档位；存档中可能是连续值）。 */
    const setCtlValue = (id, v) => {
      const el = $(id);
      if (!el) return;
      if (!el._steps) return;                    // 还没造出来（开机顺序）→ 由 syncAll 再刷
      const steps = el._steps;
      let best = steps[0], d = Infinity;
      for (const s of steps) {
        const dd = Math.abs(s - Number(v));
        if (dd < d) { d = dd; best = s; }
      }
      el._val = best;
      if (el._paint) el._paint();
    };

    /** 读某个控件现在的值（给"恢复本组"和脏判断用）*/
    const getCtlValue = (id) => {
      const el = $(id);
      if (!el) return null;
      if (el._steps) return el._val;
      const n = Number(el.value);
      return Number.isFinite(n) ? n : null;
    };

    /**
     * 表里所有控件按 `state.set` 重刷一遍。
     * 注意：这个函数即 `buildSliderTips()` —— 名字未改，因为调用点不少。
     */
    const syncAllCtls = () => {
      const s = state.set || {};
      const map = {
        'set-w-prov': s.wProv, 'set-w-region': s.wRegion, 'set-pw': s.pw,
        'set-pa': s.pa, 'set-ra': s.ra, 'set-ca': s.ca,
        'set-water-w': s.waterW, 'set-water-a': s.waterA,
        'set-waste-w': s.wasteW, 'set-waste-a': s.wasteA,
        'set-fontplace': (fontSizes(s) || {}).place,
        'set-fontpower': (fontSizes(s) || {}).power,
        'set-labelap': s.labelAP, 'set-labelac': s.labelAC,
        'set-labelmax': s.labelMax, 'set-labelplacemax': s.labelPlaceMax,
      };
      for (const id in map) {
        if (map[id] == null) continue;
        setCtlValue(id, map[id]);
      }
      /* 颜色那七行旁边要写 HEX —— 两个灰（#B4B4B4 / #969696）并排看几乎一样，
 * 文字上才分得开 */
      for (const k of ['bg', 'unpainted', 'impass', 'river', 'lake', 'sea', 'isea']) {
        const el = $('set-' + k);
        const v = $('v-set-' + k);
        if (el && v) v.textContent = String(el.value || '').toUpperCase();
      }
      /* 「不限」那两枚勾勾要跟着数量走 （21 就是内部表示的"不限"）*/
      const _lm = $('set-labelmax-unlimited');
      if (_lm) _lm.checked = Number(s.labelMax) >= LABEL_MAX_UNLIMITED;
      const _lp = $('set-labelplacemax-unlimited');
      if (_lp) _lp.checked = Number(s.labelPlaceMax) >= 20;
      /* 版图贴合（P社式排版）那个下拉：存档无此项 → both。 */
      const _mn = $('set-mapname');
      if (_mn) _mn.value = (s.mapNameFit === 'power' || s.mapNameFit === 'off')
        ? s.mapNameFit : 'both';
      const _md = $('set-mapname-debug');
      if (_md) _md.checked = !!s.mapNameDebug;
      _refreshDirty();
    };

    /** 底栏那行「已改动 N 项」，跟 `SET_DEFAULTS` 比 */
    const _refreshDirty = () => {
      const el = $('set-dirty');
      if (!el) return;
      const s = state.set || {};
      let n = 0;
      for (const k in SET_DEFAULTS) {
        if (k === 'set') continue;
        const a = s[k], b = SET_DEFAULTS[k];
        if (a == null && b == null) continue;
        if (Array.isArray(a) && Array.isArray(b)) { if (a.join() !== b.join()) n++; continue; }
        if (a !== b) n++;
      }
      el.textContent = n ? `已改动 ${n} 项` : '都是默认值';
    };

    /**
     * 绑一个数值控件（range / 步进器 / 分段条都走这里）。
     * @param {string} id
     * @param {string} key  state.set 里的键
     * @param {Function} [after] 改完额外要做的事（比如名字上限要重算）
     */
    const bindRange = (id, key, after) => {
      const el = $(id);
      if (!el) return;
      const fmt = (el.getAttribute && el.getAttribute('data-fmt')) || '';
      const onChange = (v) => {
        state.set[key] = v;
        applySettings();
        scheduleSave();
        _refreshDirty();
        if (after) after(v);
      };
      if (el.classList && (el.classList.contains('ctl-step') || el.classList.contains('ctl-seg'))) {
        _buildCtl(el, fmt, onChange);
        /* 开机先按存档里的值摆好 （没有就落回第一档，随后由 `_open` 校正）*/
        const cur = state.set[key];
        if (cur != null) setCtlValue(id, cur);
        else if (el._steps && el._steps.length) { el._val = el._steps[0]; el._paint(); }
      } else if (el.tagName === 'INPUT' && el.type === 'range') {
        el.addEventListener('input', () => onChange(Number(el.value)));
      }
    };
    /*
     * 边界那一栏全是滑条：档位本身等距（线宽 0.5 一档、浓度 25% 一档），
     * `min/max/step` 在 HTML 里锁定即只有这几档，无需下拉兜底
     */
    bindRange('set-w-region', 'wRegion');
    bindRange('set-w-prov', 'wProv');
    bindRange('set-pw', 'pw');
    bindRange('set-pa', 'pa');
    bindRange('set-ra', 'ra');
    bindRange('set-ca', 'ca');
    /* 水域边界那一对，走 bindRange，不要手写：手写版本会漏掉旁边那个数值 / 落盘 / applySettings。/ */
    bindRange('set-water-w', 'waterW');
    bindRange('set-water-a', 'waterA');
    /* 荒地边界那一对，走 bindRange：数值 / 落盘 / applySettings 一并处理。 */
    bindRange('set-waste-w', 'wasteW');
    bindRange('set-waste-a', 'wasteA');
    /* 两块字号各绑各的 （走 bindRange：旁边数值 / 落盘 / applySettings 一条龙）*/
    bindRange('set-fontplace', 'fontPlace');
    bindRange('set-fontpower', 'fontPower');
    /* 导入的字体：两个下拉 + 导入 / 删除。 */
    bindFontPicker();
    /*
     * 两个不透明度：直接走 bindRange（不要手写）。
     * 手写的版本没调 buildSliderTips，滑块旁边的字不会跟着变；
     * 走同一条路之后：① 数值跟着动 ② 落盘 / applySettings 也一并对齐。
     */
    bindRange('set-labelac', 'labelAC');
    bindRange('set-labelap', 'labelAP');
    /*
     * 名字上限：步进器（1~20 档，第 21 档「不限」改为独立勾选）。
     * 两件事跟着它走：势力那条要重算连通域（blocksDirty）；
     * 地名那条只重截断（`_placeCapped` 作废），连通域那趟并查集不重跑。
     * 两者不可混用：地名变动触发势力名全重排会明显卡顿。
     */
    bindRange('set-labelmax', 'labelMax', () => {
      const v = $('set-labelmax-v');
      if (v) v.textContent = labelMaxText();
      blocksDirty = true;
      labelDirty = true;
      if (typeof invalidate === 'function') invalidate();
    });
    bindRange('set-labelplacemax', 'labelPlaceMax', () => {
      const v = $('set-labelplacemax-v');
      if (v) v.textContent = labelPlaceMaxText();
      state._placeCapped = null;
      state._placeKept = null;
      labelDirty = true;
      if (typeof invalidate === 'function') invalidate();
    });
    /*
     * 「数量不限」两个勾（独立开关，不再是滑条最右那一格）。
     * 内部仍写 21 → 兼容 `LABEL_MAX_UNLIMITED` 与 `labelMaxValue`。
     */
    {
      const wire = (cbId, id, key, after) => {
        const cb = $(cbId);
        if (!cb) return;
        cb.addEventListener('change', () => {
          setCtlValue(id, cb.checked ? LABEL_MAX_UNLIMITED : SET_DEFAULTS[key]);
          const el = $(id);
          state.set[key] = cb.checked ? LABEL_MAX_UNLIMITED : (el && el._val) || SET_DEFAULTS[key];
          blocksDirty = true;
          labelDirty = true;
          if (typeof invalidate === 'function') invalidate();
          applySettings();
          scheduleSave();
          if (after) after();
        });
      };
      wire('set-labelmax-unlimited', 'set-labelmax', 'labelMax', () => {
        const v = $('set-labelmax-v'); if (v) v.textContent = labelMaxText();
      });
      wire('set-labelplacemax-unlimited', 'set-labelplacemax', 'labelPlaceMax', () => {
        const v = $('set-labelplacemax-v'); if (v) v.textContent = labelPlaceMaxText();
        state._placeCapped = null; state._placeKept = null;
      });
    }
    // 版图贴合（P社式排版）：off / power / both
    {
      const el = $('set-mapname');
      if (el) el.addEventListener('change', () => {
        state.set.mapNameFit = el.value;
        labelDirty = true;
        applySettings();
        scheduleSave();
        _refreshDirty();
        if (typeof invalidate === 'function') invalidate();
      });
    }
    // 排版调试：勾上就画基线 / 字框 / 包围盒 / 质心
    {
      const el = $('set-mapname-debug');
      if (el) el.addEventListener('change', () => {
        state.set.mapNameDebug = !!el.checked;
        if (labels) labels.debug = !!el.checked || !!labels.debugHash;
        labelDirty = true;
        scheduleSave();
        _refreshDirty();
        if (typeof invalidate === 'function') invalidate();
      });
    }
    // 取色后切到（涂抹 / 填色）：只存个偏好，跟界面/渲染都没关系 （不走 applySettings）
    {
      const el = $('set-picktool');
      if (el) el.addEventListener('change', () => {
        state.set.pickTool = el.value === 'fill' ? 'fill' : 'paint';
        scheduleSave();
      });
    }
    // 涂色限制（上色+标记 / 仅上色）：只影响 `paintPids` 的写入
    {
      const el = $('set-paint-limit');
      if (el) el.addEventListener('change', () => {
        state.set.paintLimit = el.value === 'color' ? 'color' : 'both';
        scheduleSave();
      });
    }
    // 图例控件（勾选 / 标题 / 位置 / 尺寸 / 颜色 / 字体 / 列数 / 色块 / 排序）
    bindLegendControls();
    if ($('set-reset')) $('set-reset').onclick = () => {
      /*
       * 恢复默认必须当场落盘：仅重置内存（state.set）而不写盘时，存的仍是改过的值，刷新后会被读回。
       * 用 scheduleSave 不够：800ms 防抖，点完立刻刷新时尚未写入。
       * 故直接 saveMapPrefs 同步写一次；写失败（无痕模式 / 配额满）再退回防抖路径，至少不静默丢失。
       */
      /*
       * 须说清范围：`SET_DEFAULTS` 里有 `fontFacePlace` / `fontFacePower`，
       * 点击它会把字体选择清回默认；而底栏离字体那两行隔着一整组。
       * （库里的字体文件不会删除，只是不再选中。）
       */
      /* 不再弹确认 —— 点击即执行。 */
      state.set = Object.assign({}, SET_DEFAULTS);
      // 图例的每项开关 / 自定义名 / 手动顺序也是“改动”，恢复默认要一起清
      // （仅重置 state.set 时，列表里仍留着上一张图的勾选与改名）
      state.legendOn = {};
      state.legendOrder = [];
      state.legendNames = {};
      labelDirty = true;
      blocksDirty = true;
      try { saveMapPrefs(); } catch (e) { scheduleSave(); }
      applySettings();
      /*
       * 下拉与状态行同样需要回到默认：漏掉这一步会出现
       * 地图已回到系统字体、界面仍显示“MyFont · 已生效”
       */
      const sp = $('set-font-place'), sw = $('set-font-power');
      if (sp) sp.value = '';
      if (sw) sw.value = '';
      if (typeof syncFontPicker === 'function') syncFontPicker();
      /*
       * 此处原为 `_open`，该函数已拆成 `_fill` / `openSettings`
       * 点击后 state.set 确已回默认、applySettings 也执行，但下一行 `_open` 抛 ReferenceError，
       * 后续 `_fill` 永不执行，控件仍停在旧值，表现为滑块 / 勾选 / 颜色一个都没动
       * 恢复默认后必须回填控件：只改 state 不改 DOM 等于界面与状态不符
       * `_fill` 会走 syncAllCtls / _refreshDirty / 图例列表
       * 不调用 openSettings：手机版此时面板本已展开，桌面版也无需因恢复默认强行展开抽屉
       */
      _fill();
      if (typeof refreshFontStatus === 'function') { /* 由 syncFontPicker 内部刷 */ }
    };

    /* ---- 四组分页（桌面）---- */
    {
      const tabs = $('set-tabs');
      const grid = $('set-grid');
      const applyTab = (g) => {
        if (!grid) return;
        grid.setAttribute('data-active', g);
        const cols = grid.querySelectorAll ? grid.querySelectorAll('.set-col') : [];
        for (const col of cols) {
          col.hidden = !!(col.getAttribute('data-group') && col.getAttribute('data-group') !== g);
        }
        if (tabs && tabs.children) {
          for (const b of tabs.children) b.classList.toggle('on', b.getAttribute('data-group') === g);
        }
        _refreshDirty();
      };
      if (tabs) {
        tabs.addEventListener('click', (e) => {
          const t = e && e.target;
          const g = t && t.getAttribute && t.getAttribute('data-group');
          if (g) applyTab(g);
        });
      }
      /* 手机版会把 `.set-col` 搬进各自的面板 那时标签页不该再藏东西
 * 所以搬走的时候会把 hidden 清掉（见 mobile_js） 两套互不打架 */
      applyTab('color');
    }
  }

  /**
   * 给导出一类按钮套一层错误兜底。
   * 必须同时接住 async 的拒绝：`exportFullPNG` 是 async，若只写 `return fn(ev)`，
   * 其抛错即未处理的 Promise 拒绝；手机浏览器对内联脚本做跨域屏蔽，报成 `Script error: 0`，堆栈为空。
   * 同步异常与异步拒绝均落到同一出口，至少能告知具体问题。
   */
const _wrap = (fn) => (ev) => {
  _closeMenu();
  try {
    const r = fn(ev);
    // 这里不能只看 typeof r === 'object' 任何带 .then 的都要接
    if (r && typeof r.then === 'function') r.catch(onExportFail);
    return r;
  } catch (e) {
    onExportFail(e);
  }
};

/** 导出失败时的统一出口：给一句可读提示 + 记进日志，不要让它变成空白报错。 */
function onExportFail(e) {
  const msg = (e && (e.message || e.name)) || String(e);
  const full = msg + ((e && e.stack) ? ' · ' + String(e.stack).split('\n')[1] : '');
  try { LOG.event('导出失败', full); } catch (e2) { /* */ }
  /*
   * 手机上最常见的是画布过大、内存不足，这里一并给出解决办法
   * （整图导出在手机上要拼好几个大 canvas，内存本就紧张）。
   */
  const big = /memory|alloc|size|canvas|blob/i.test(msg);
  toast(big
    ? '导出失败：这张图的画布过大，手机内存不足。请改用「导出当前画面」，或在电脑上导出'
    : '导出失败了：' + msg + '（细节记在导出日志里）', true);
}
  $('btn-png').onclick = _wrap(exportViewPNG);
  /* 「导出整图」现在先开分辨率 / 范围弹窗，不再直接按 1× 跑 */
  _initExportDialog();
  $('btn-png-full').onclick = _wrap(openExportDialog);
  $('btn-project').onclick = _wrap(() => openSaveMapDialog('save'));
  if ($('btn-load-map')) $('btn-load-map').onclick = _wrap(() => openSaveMapDialog('load'));
  /* 导出涂色方案 .json 直通下载 （不进仓库、不弹窗）*/
  $('btn-export-project').onclick = _wrap(() => downloadProjectJSON());

  /* 存档弹窗的确定 / 取消 / 回车 */
  if ($('save-map-ok')) $('save-map-ok').onclick = _wrap(() => saveMapFromDialog());
  if ($('save-map-cancel')) $('save-map-cancel').onclick = () => { const b = $('save-map'); if (b) b.hidden = true; };
  if ($('save-map-name')) $('save-map-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveMapFromDialog(); }
  });

  /*
   * 仓库面板的绑定不在这儿 —— 那是选图页的东西， bindEvents 要等选完图才跑 那时选图页早就没用了
   *  绑定在 pickMap 里（跟 map-import 同一处 见那边）
   */
  renderPaletteFav();
  // 收色入口 = 收藏行行尾那个「＋」块（见 renderPaletteFav）
  /*
   * 地图包不在此处导入：`.pdxmap` 只有一个入口 —— 选图页（主菜单 → 选地图 → 底部按钮 / 直接拖入）
   * 此按钮本身是涂色方案 .json 的导入入口（走 importJSON，与拖文件进来同一路径）
   */
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
  $('btn-log').onclick = _wrap(exportLog);      // 报错日志（web/js/log.js 收着）
  $('btn-zoom-in').onclick = () => zoomBy(1.35, stage.getBoundingClientRect().left + stage.clientWidth / 2,
                                                stage.getBoundingClientRect().top + stage.clientHeight / 2);
  $('btn-zoom-out').onclick = () => zoomBy(1 / 1.35, stage.getBoundingClientRect().left + stage.clientWidth / 2,
                                                    stage.getBoundingClientRect().top + stage.clientHeight / 2);
  $('btn-zoom-fit').onclick = fitView;

  $('search').addEventListener('input', onSearch);
  /* 「跨剧本搜国家」开关。勾选状态跟设置一起存（每款游戏一份，见 SET_DEFAULTS.searchCross）。/ */
  {
    const _xcb = $('search-cross-game');
    if (_xcb) {
      _xcb.checked = !!(state.set && state.set.searchCross);
      _xcb.addEventListener('change', () => {
        state.set.searchCross = !!_xcb.checked;
        scheduleSave();
        runSearch();                 // 立刻按新范围重搜一遍
      });
    }
  }
  // 搜索框上的键盘：
  // · 回车 → 跳到第一条能定位的结果
  // （searchHits 为这条路而存，但只写不读 ——
  // 笔记里那句"回车跳第一条"在当前代码里根本不存在）
  // · Esc → 清空搜索。窗口那层也有一份，但它开头就 `INPUT 直接 return`，
  // 光标在搜索框里时轮不到它，所以这儿得接上
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // README 承诺"跳到第一条能定位的结果" —— 排最前的可能是个没地盘的头衔，
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

  // 拖进来导入：按扩展名分派（地图包与字体也走这条，不再被挡回）
  const dropDispatch = (e) => {
    e.preventDefault();
    const list = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const f = list[0];
    if (!f) return;
    const name = f.name || '';
    // Windows 常见的「方案.JSON」也别漏掉 —— 大小写敏感的 endsWith 会静默忽略它
    if (/\.json$/i.test(name) || f.type === 'application/json') {
      importJSON(f);
      return;
    }
    // 地图包：这里不收，只提示去哪里收（地图包不在进入时导入）
    if (/\.(pdxmap|zip)$/i.test(name)) {
      toast('地图包请在「选图页」导入：主菜单 → 选地图 → 底部「＋ 导入地图包…」，或者直接拖到那一页', true);
      return;
    }
    // 字体（位图字体要一对，所以整批递过去 按主名配对在那边做）
    if (/\.(ttf|otf|woff2?|fnt|dds)$/i.test(name)) {
      if (fontDropHandler) fontDropHandler(list);
      else toast('先把地图打开，再拖字体进来');
      return;
    }
    toast('认不出这个文件（涂色是 .json，地图包是 .pdxmap，字体是 .ttf/.otf 或 .fnt+.dds）', true);
  };
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', dropDispatch);
  /*
   * 设置面板上也要监听 —— 面板一打开就盖住舞台，
   * 拖文件的落点在面板上，只有舞台那个监听时仍无反应。
   */
  {
    const setPanel = $('settings');
    if (setPanel) {
      setPanel.addEventListener('dragover', (e) => e.preventDefault());
      setPanel.addEventListener('drop', dropDispatch);
    }
  }
  // 图例预览：拖动 / 右下角缩放 / 方向键微调
  bindLegendOverlay();
  scheduleLegendOverlay();
  window.addEventListener('resize', scheduleLegendOverlay);
  const _legendWrap0 = $('legend-overlay');
  if (_legendWrap0) {
    _legendWrap0.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }
}

// ================================================================ 渲染循环

function frame(_ts) {
  /* FPS：用 rAF 给的时间戳算（这才是"这一秒到底跑了几帧"
 * 别拿"重画间隔"当 FPS —— 静止时不重画，那样算出来是 0）*/
  try {
    if (_ts > 0) {
      const dt = _ts - (PERF.S._rafAt || _ts);
      PERF.S._rafAt = _ts;
      if (dt > 0 && dt < 500) PERF.S.fps = PERF.S.fps * 0.9 + (1000 / dt) * 0.1;
    }
  } catch (e) { /* */ }
  /*
   * 里面任何一句抛了，requestAnimationFrame(frame)（在最底下）就永远轮不到
   * → 画面冻在最后一帧、控制台一条错、界面上什么提示都没有 （最难查的那种）
   * 现在：报一次上屏（showFatal），但继续排下一帧 —— 于是这一帧画坏了，下一帧照样有机会恢复
   * 只在第一次出错时弹一次提示，不然每帧一条会把屏幕刷爆
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

/**
 * 帧内的一步：单独兜底（某一步出错不得连累整帧 render）
 * syncLayerSwitches / syncParentBorder 若裸调，一旦抛出，后续 render() 便轮不到，
 * 画面冻住，而 frame() 那层只会上屏一次
 * 现每步各自 catch（与 wasteWatch 同等待遇）：出错记一次，下一帧照常
 * 同一步骤只记第一条，避免一帧一条刷爆控制台
 */
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


/*
 * 性能指标
 * 只量自身可控的部分，不做完整的 FPS 面板：
 * · `frame` —— frameBody 整段耗时（滚动平均 / 最近 2 秒最差）；
 * · `render` —— WebGL 那一次 render；
 * · `labels` —— 画名字（2D canvas）；
 * · `list` —— 画名字里「凑名单」那一段（不含栅格化，纯 JS 优化它才有意义）；
 * · `tile` —— 这一帧补块 / 传块。
 * 开关：地址栏带 `#perf` / `#mapdebug`，或按 Shift+P。指标也进诊断报告。
 */
const PERF = (() => {
  const S = {
    frame: 16, render: 0, labels: 0, list: 0, tile: 0,
    worst: 0, worstAt: 0, frames: 0, fps: 60,
    drawn: 0, hits: 0, miss: 0, points: 0,
    _t: 0, _hud: null, _on: false, _hudAt: 0,
  };
  const ema = (old, v) => (old * 0.85 + v * 0.15);
  function begin() { S._t = performance.now(); return S._t; }
  /** 记一段耗时（ms）*/
  function mark(name, ms) {
    if (!(ms >= 0) || !Number.isFinite(ms)) return;
    if (name === 'frame') {
      S.frame = ema(S.frame, ms);
      if (ms > S.worst && performance.now() - S.worstAt > 2000) { S.worst = ms; S.worstAt = performance.now(); }
      S.frames++;
    } else if (S[name] != null) S[name] = ema(S[name], ms);
  }
  function since(t0) { return performance.now() - t0; }

  function on() {
    return S._on || (typeof location !== 'undefined' && /#(perf|mapdebug)/.test(location.hash || ''));
  }

  /** 5Hz 刷一次 HUD（不要每帧动 DOM，那本身就会拖慢） */
  function hud() {
    try {
      if (!on()) {
        if (S._hud && !S._hud.hidden) S._hud.hidden = true;
        return;
      }
      const now = performance.now();
      if (now - S._hudAt < 200) return;
      S._hudAt = now;
      if (!S._hud) {
        const d = document.createElement('div');
        d.id = 'perf-hud';
        d.style.cssText = 'position:fixed;right:10px;bottom:34px;z-index:60;'
          + 'padding:6px 9px;border-radius:8px;pointer-events:none;'
          + 'background:rgba(12,18,26,.82);border:1px solid rgba(90,120,150,.45);'
          + 'color:#bfe0ff;font:11px/1.55 ui-monospace,Consolas,monospace;white-space:pre';
        document.body.appendChild(d);
        S._hud = d;
      }
      const L = labels;
      const hit = L ? (L._layoutHits | 0) : 0, miss = L ? (L._layoutMiss | 0) : 0;
      const rate = (hit + miss) ? Math.round(100 * hit / (hit + miss)) : 0;
      S._hud.textContent =
        `帧 ${S.frame.toFixed(1)}ms（最差 ${S.worst.toFixed(0)}）\n`
        + `渲染 ${S.render.toFixed(1)} · 补块 ${S.tile.toFixed(1)} · 名字 ${S.labels.toFixed(1)}（凑名单 ${S.list.toFixed(1)}）\n`
        + `标签 ${S.drawn} · 候选 ${S.points} · 布局命中 ${rate}% · ${S.fps.toFixed(0)}fps`;
    } catch (e) { /* 指标不许把画面搞坏 */ }
  }

  /** 给诊断报告用的一份快照 */
  function snapshot() {
    return {
      '帧耗时': S.frame.toFixed(1) + ' ms（最近最差 ' + S.worst.toFixed(0) + ' ms）',
      'WebGL 渲染': S.render.toFixed(1) + ' ms',
      '补块 / 传块': S.tile.toFixed(1) + ' ms',
      '画名字': S.labels.toFixed(1) + ' ms（凑名单 ' + S.list.toFixed(1) + ' ms）',
      '标签 / 候选': S.drawn + ' / ' + S.points,
      '布局缓存': ((labels && labels._layoutHits) | 0) + ' 命中 / '
        + ((labels && labels._layoutMiss) | 0) + ' 重排',
      'FPS': S.fps.toFixed(0),
    };
  }

  function toggle() {
    S._on = !on();
    if (S._on) { hud(); }
    else if (S._hud) S._hud.hidden = true;
  }
  return { S, begin, mark, since, hud, snapshot, toggle, on };
})();
try {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'P' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) PERF.toggle();
  });
} catch (e) { /* */ }

function frameBody() {
    const _pT0 = PERF.begin();
    /*
     * 标记表必须在此处写入：`applyHoverHighlight` 是唯一写入方，属悬停高亮路径，
     * 无悬停时永不写入，未涂过的地标记全为 0；若仅由涂色路径写入，标记只随填色更新。
     * 写入放在渲染前，写完立即强制上传，保证该帧着色器即可取到。
     * 仍以该键作闸（层 / 涂色数 / 标记名数变化才重算），否则每帧数万次空跑。
     */ 
    try {
      if (renderer) {
        const _ctF = countryTier();    // 该层看的是"最近的有主剧本层"
        const _keyF = _ctF + '|' + (state.painted ? state.painted.size : 0)
          + '|' + ((state.labelNames && state.labelNames.length) || 0);
        if (state._lblPassKey !== _keyF) {
          syncAllPaintLabels();
          renderer.paintDirty = true;
          if (typeof renderer.flushPaint === 'function') renderer.flushPaint();
        }
      }
    } catch (e) { /* ok */ }
  // ---- 与层级绑定的几个开关：必须在 render() 前同步 ----
  // 颜色 / 本层边界 / 名称等值按“当前视图属于哪一类”（势力 or 地区）
  // 现算后写回 state，再推给渲染器（见 syncLayerSwitches）。
  // 这些值须先于 renderer.render 写入 → 否则换层后的第一帧为
  // “新层的归属表 + 旧层的颜色开关”：切到剧本、或从剧本切回细层时，
  // 屏幕会闪一帧另一层原版的配色（省份位图那种图）。
  // （setTier 也会当场同步一次，此处再兜一道，避免状态变更晚一帧）
  frameStep('开关同步', syncLayerSwitches);
  frameStep('边界链', syncParentBorder);
  /*
   * 荒地自动色：签名变化才重算（层 / 粒度 / 三个颜色开关 / 开关 / 涂色 /
   * 周长表版本 / 设置里的荒地色），必须在 render 前。
   * 三步各自兜底：一步出错不应导致该帧 render 轮不到（见 frameStep）
   */
  frameStep('荒地自动色', wasteWatch);
  // ---- 分块：按视野补齐缺的块、离开视野的自然被缓存淘汰 ----
  // 半尺寸那套 state.tileMap 是 null → 走下面「合成切块」那条
  if (renderer && renderer.provArrTex && renderer.tileInfo) {
    const ti = renderer.tileInfo;
    const v = renderer.view;
    if (v && v.w > 0 && v.h > 0) {
      if (state.tileMap) {
        for (const [r, c] of state.tileMap.tilesInView(v)) {
          const layer = r * state.tiles.cols + c;
          const cached = state.tileMap.cache.get(`${r}_${c}`);
          /*
           * 「缓存里有」不等于「显存里有」：`provinceAt`（悬停）也会把块拉进缓存而不上传，
           * 只看缓存的跳过判断会使这些块永远不上传：地图一直渲成 0 号省份的灰
           * （悬停却查得到，即“缺一块”）故：缓存有 → 未传过则本帧补传；无缓存 → 取了就传；
           * 传过的（uploadedTiles 内有）才跳过，避免每帧重复上传
           */
          if (cached) {
            if (!renderer.uploadedTiles.has(layer)) renderer.uploadTile(layer, cached);
            continue;
          }
          state.tileMap.get(r, c).then((tile) => {
            if (tile) renderer.uploadTile(layer, tile);
          }).catch(() => { /* 取块失败就下一帧再试 */ });
        }
      } else if (ti.synthetic && renderer.uploadSyntheticTile) {
        /*
         * 合成切块：按视野懒传
         * 一次性全传时，CK3 的 9216×4608 需 120MB 显存，手机 GPU 上下文会被顶丢（画面变白、只剩地名）
         * 现每帧最多两块，按离视野中心远近排序；总显存另有 96MB 软上限
         * （缩到最小、整张都在视野内时也不一次灌满：未传的块先空着，放大到该处再补）
         * 传上去的记录在 `renderer.uploadedTiles`，不会每帧重复切块与上传
         */
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
  const _pT1 = performance.now();
  const drew = renderer.render();
  frameStep('旗帜框', flagTick);
  PERF.mark('render', performance.now() - _pT1);
  const now = performance.now();
  if (state.focus && now > state.focusUntil) {
    state.focus = null;
    labelDirty = true;
  }
  if (blocksDirty) {
    /*
     * 拖动涂色期间不重算（V3 4 万地块一次要 7~11 ms，是半个帧预算，
     * 按住拖时会变成规律性卡顿；且拖动时难以看清标签变化）。
     * 松手时 `state._blocksForce` 会把欠下的那次补上（见 mouseup）；
     * 其余情况照旧尾部节流：最多约 120 ms 一次。
     */
    const _nowB = performance.now();
    const _due = state._blocksForce
      || (!painting && _nowB - (state._blocksAt || 0) > 120);
    if (_due) {
      state._blocksAt = _nowB;
      state._blocksForce = false;
      rebuildPaintBlocks(!!state._blocksAll);    // 只有国家/剧本那层才全图重分组
      blocksDirty = false;
      labelDirty = true;
      if (state.set && state.set.legend) scheduleLegendOverlay();
    }
  }

  if (drew || labelDirty) {
    // 两套地名各自独立：原有的（头衔/地区名）和玩家的（手绘色块名），
    // 谁开着画谁，两套都开就合并成一张名单一次画完
    /*
     * 名字层出错不得拖垮整帧：坏数据（NaN 锚点 / 空数组）会打断整个渲染循环，
     * 表现为画面卡住、地图不跟手，比不显示名字严重得多故兜住并记一次日志（不每帧刷屏），下一帧照常
     */
    const _pL0 = performance.now();
    try {
      drawLabels(viewRect());
    } catch (e) {
      if (!state._labelErrAt || performance.now() - state._labelErrAt > 5000) {
        state._labelErrAt = performance.now();
        LOG.event('画名字失败', String(e && (e.message || e)));
        console.warn('画名字失败（已兜住，不影响地图）:', e);
      }
    }
    PERF.mark('labels', performance.now() - _pL0);
    labelDirty = false;
  }
  PERF.mark('frame', performance.now() - _pT0);
  if (typeof renderer !== 'undefined' && renderer && renderer._perfTileMs) {
    PERF.mark('tile', renderer._perfTileMs);
    renderer._perfTileMs = 0;
  }
  PERF.hud();
  // 上面那两条（syncLayerSwitches / syncParentBorder）
  // 已在 render() 前调用：放在其后会让画面晚一帧跟上
  // （下一帧的排队在 frame 那层做 —— 出错了也要接着排）
}

/**
 * 悬停按哪一族高亮 —— 与涂色 / 还原同一口径。
 *   · 涂过的地 → 返回该族的涂色（全图同色同标记）
 *   · 没涂过的地 → 返回其稳定色（原版色）：着色器按「颜色 + 标记」点亮，
 *     标记来自头衔名 → 点亮的是「同一国里同色同名」的那些
 *     （同一国内被涂成其它颜色的占领区颜色不同，不亮，与涂色口径一致）
 *   · 其余返回 null → 退回按编辑层头衔高亮（细层 / 开粒度时用）
 * 不看那两个边界开关：涂色 / 还原的「归属」始终是「同色同标记」，
 * 开关只决定先看全图玩家族还是先看该国同色同标记的那些；
 * 着色器这边「颜色 + 标记」两条路已覆盖这两种。
 * 只开「势力 · 边界」而不开「填色 · 边界」时不整族点亮 —— 与涂色口径一致。
 */
function hoverGroupRgb(pid) {
  if (!pid) return null;
  // 剧本层 + 没开粒度 + 编辑层就在剧本那一层才谈得上"按族"
  // （细层 / 开了粒度：归属就是编辑层那一块，按头衔亮就够了）
  const _nEra = (state.meta && state.meta.eraDates && state.meta.eraDates.length) || 0;
  if (!(_nEra > 0 && state.grain == null && editTier() < _nEra)) return null;
  const pd = renderer && renderer.paintData;
  const p4 = pid * 4;
  // 涂过的先答：这一族的身份整个在手绘层上（颜色 + 标记）
  if (pd && pd[p4 + 3] > 0) return [pd[p4], pd[p4 + 1], pd[p4 + 2]];
  // 海 / 湖 / 不可通行 / 荒地 / 无主地：不做整族高亮
  //（它们共用同一个伪节点，整族高亮会把一整片海都点亮）
  const _real = state.meta.numRealTitles != null ? state.meta.numRealTitles : 1e9;
  /*
   * 层用 `viewTierFor(pid)`：有主的地 → 视图层（剧本模式 = 国家，整族亮整国）；
   * 无主的水 / 荒地 → 最低层（那里才逐块）。
   */
  const _t0 = titleAt(pid, viewTierFor(pid));
  if (_t0 == null || _t0 === NO_TITLE || _t0 >= _real) return null;
  if (isWastelandTid(_t0)) return null;
  // 按显示色：没涂过的地 → 原版色（着色器配"标记"一起判，等价于同色同名）
  const c = stableColor(pid, _t0);
  if (!c || (c[0] === 150 && c[1] === 150 && c[2] === 150)) return null;   // 没颜色的地不高亮
  return [c[0], c[1], c[2]];
}

/** 把「整族高亮」推给渲染器（没有族就退回按头衔高亮） */
function applyHoverHighlight(pid, hl) {
  // 着色器是按 uEditTier 比对的 —— 每次都对齐，不要让它停在初值上
  renderer.setEditTier(editTier());
  const _real = state.meta.numRealTitles != null ? state.meta.numRealTitles : 1e9;
  const _t0 = titleAt(pid, editTier());
  /*
   * 背景（无主地 / 伪头衔 / 荒地）：按「同一片」整片点亮（HOI4 战略地图高亮海域整体、EU 同理）
   * 新包每层一片（`#sea_pr_57` 那种）—— 同一个 tid 即同一片
   * 水片多为伪头衔（`tid >= numRealTitles`），落进这条，与荒地同等待遇
   * 直接把 tid 交给着色器（uHoverTid，它比的是 `titleAt(pid, uEditTier)`）
   * → 名字 / 边界 / 高亮同源，换层后高亮范围自动跟随，无需编组
   * 老包（未按层分片的包）仍共享 `#sea`：比 tid 即「全世界的海一起亮」，
   * 故退回编组表那条路径（`isTierPieceKey` 可判新旧；新包传 0 表示不编组；
   * 着色器内编组优先（uHoverGroupId != 0 走编组），两条不冲突）
   * 水域不单列高亮（水域 = 普通地块）：无主水域与荒地一致 ——
   * 新包取板片 tid、老包取真名编组、涂过的取玩家涂色一族
   */
  const _k0 = _t0 == null ? '' : String(state.titles.keys[_t0] || '');
  const _isBg = (_t0 == null || _t0 === NO_TITLE || _t0 >= _real
    || isWastelandTid(_t0));
  const _pieceHere = isTierPieceKey(_k0) ? _t0 : 0;
  const _gidHere = (_isBg && !_pieceHere) ? renderer.hoverGroupIdOf(pid) : 0;
  /*
   * 走 tid 那条时必须把 pid 传 0 —— 着色器里那三条的先后是
   * `uHoverGroupId` → `uHoverPid` → `uHoverPaintOn` → `uHoverTid`；
   * 两个都传时 `uHoverPid > 0` 先命中 → 永远只亮光标底下那一格，
   * tid 那条路轮不到（实测现象：海里仍只亮 1 格）。
   * —— 组号 / tid 任一有效就不再传 pid，都没有才退回「只亮一格」。
   */
  const _hp = (_pieceHere || _gidHere) ? 0 : (pid || 0);
  // 涂过的无主地（空白剧本那种一层全无主的）也按"一族"亮 ——
  // 没"片"的老包水节点（组号 0）→ 照旧只亮光标底下这一块
  // 荒地有真名（meta.wastelandNames）→ 同名的那些也整片亮 没名字的还是只亮一格
  const _noOwnHere = (_t0 == null || _t0 === NO_TITLE);
  const _paintNoOwn = _noOwnHere
    && !!(renderer.paintData && pid && renderer.paintData[pid * 4 + 3] > 0);
  if (_isBg && !_paintNoOwn) {
    /*
     * 剧本层（含空白）海 / 湖全部单格。
     * · 成因：剧本层的海 / 湖格 tilemap 全指向类片（`#sea_all_<年份>`，
     *   整层共享一个 tid）→ 传 tid 给着色器（uHoverTid 比 titleAt(h,uEditTier)）
     *   → 所有海域同时亮。空白剧本与正常剧本同一成因。
     * · 陆 / 荒在剧本层一格一个节点（`wl_<pid>`）→ 单格亮；海无理由特殊。
     * → 剧本层悬停海 / 湖也单格：tid / 编组都不传、只传 pid（uHoverPid 单格路）。
     * · 粒度层（地理层）的海片是真名片（`#sea_pr_57`）→ 走 tid 整片亮那一条
     * （普通头衔规则：悬停一片海区亮那一片，不变）。
     * —— 涂过的格（_paintNoOwn）照旧走后面的玩家涂色一族。
     */
    /*
     * 类名片格一律单格。
     * · 成因：EU5 的不可通行区域本有数块，但名字全是「不可通行」（类名）→
     *   悬停把它们全都点亮（涂色 / 边界正常：它们本就是普通地块、独立片）。
     * · EU5 的数据形状：一个 `#impassable` 节点（名字「不可通行」）
     *   在 1337 / 区域 / 地区 / 省份四层各管 1818 格（整层一件）
     *   → hover 一格 = tid 匹配 = 全部不可通行区一块儿亮。
     * · 推广为统一口径：片自己的名字是类名（走 isPseudoCategoryName）
     *   = 它只是「同一类的格」，不是「一个地理单元」→ hover 单格。
     *   剧本层的海 / 湖（名字全是「海洋 / 湖泊」）本就落在这条里；
     *   真名海片（东太平洋等）不命中 → 照旧整片亮。
     */
    const _bgName = (_t0 != null && _t0 !== NO_TITLE)
      ? String((state.titles.names && state.titles.names[_t0]) || '') : '';
    /*
     * 一格一片的背景（逐块真名的荒地 / 水）也单格。
     * 成因：地点层的荒地是逐块真名节点（约顿海姆那种 `provCount` = 1），
     * 名字不是类名，于是掉到下面「同一片整片亮」那条；
     * 可那条给的是同名编组（`hoverGroupIdOf` 按 `wastelandNames` 的名字分族）
     * → 同名的几块荒地一起亮（那本是给「整类共用一个伪节点」的包留的）。
     * 判据：这一片自己就一块地（`provCount <= 1`）→ 直接按 pid 单格。
     * 粗层的类片（一「片」上百格 `#impassable` 那种）不命中 →照旧走上面「类名 / 编组」那两条。
     * 只收无主 / 荒地那类背景 —— 水片与陆片一样是普通头衔，
     * 有真名就该整片亮（见 `hoverGroupRgb`）。
     */
    const _pc = state.titles.provCount;
    const _oneCellBg = (_t0 == null || _t0 === NO_TITLE || isWastelandTid(_t0))
      && !!(_pc && (_pc[_t0] | 0) <= 1);
    if (editTier() < eraTierCount()
        || (_bgName && isPseudoCategoryName(_bgName))
        || _oneCellBg) {
      renderer.setHoverState(pid || 0, 0, null, 0, null, 0);
      return;
    }
    // 背景：同一片整片亮 （无主的水片 / 荒地片 新包 = 比 tid 老包 = 比组号）
    renderer.setHoverState(_hp, 0, null, 0, _pieceHere || null, _gidHere);
    return;
  }
  /*
   * 怎么算"哪一族"整个在 `hoverGroupRgb` 里（见它的注释）：
   * 涂过的地 + 「填色 · 边界」那条生效 → 按玩家涂色归属亮那一族；
   * 其余（没涂过的地、只开「势力 · 边界」、开了粒度、在细层）→
   * 退回按编辑层头衔亮：剧本层下就是那一年的整个国家
   * 最后统一走 `setHoverState` —— 它跟上一帧一样就不重画
   * （高亮在着色器里，换一次 = 整张图重跑 fragment shader；
   * 而鼠标划过一片海、或划过一个国家的许多省份时，高亮范围根本没变）
   */
  const grp = hoverGroupRgb(pid);
  let _hlLabel = 0;
  if (grp) {
    // 标记也要算上：同色不同标记是两块
    // 而且每块地都要有标记编号 （没涂过的地用它的原版国名 = 原版那块跟涂出来那块是一家）
    const _ctH = countryTier();        // 同上（跟那个键保持一致）
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
 * 标注点：一个连通域 = 一个标签
 * 不看头衔、也不看颜色，按省份邻接关系做并查集，把涂过的地方切成若干组
 * （同色 + 同标记才算同一组；相邻但不同色、或同色但标记不同均为两组）
 * 每一组各自出一个名字，标在该组自己的几何中心上
 *   · 同一族铺成几块互不相连的地方（本土 + 海外省 + 小岛）→
 *     每块都有自己的名字，不只保留最大的一块
 *   · 字号按该组自己的面积给，小岛的名字自然小，够不上门槛则不画
 * “哪一片才算老家”（玩家定都 / 数据首都 / 本土）那套规则已整套移除
 * 结果缓存 state.paintBlocks，涂色后标脏，下一帧重算
 */
/**
 * rebuildPaintBlocks 的草稿缓冲 —— 按容量复用。
 * 涂色时 120ms 就重算一次（细层），V3 4 万格图上 parent / identId / groupOf / idCache
 * 四张 Int32Array 加起来 640 KB，每次新分配 → 一分钟几百兆垃圾 → GC 抖动 = 卡顿。
 * 这些数组只在函数里活着、算完就扔，所以复用是安全的（前提：不许被外部存下来）。
 */
const _blocksScratchBuf = Object.create(null);
function _blocksScratch(name, n) {
  const need = (n | 0) + 1;
  let a = _blocksScratchBuf[name];
  if (!a || a.length < need) { a = new Int32Array(need); _blocksScratchBuf[name] = a; }
  return a;
}

function rebuildPaintBlocks(all = false, unpainted = false) {
  state.paintBlocks = [];
  /*
   * 没涂色 / 没数据时也要给「色块缓存」换代。
   * 根因：下方两处 early return 只清空 paintBlocks，
   * 而 `blockLabelPoints` 按 `_blockVer` 缓存：版本未变即仍返回上一次的点（1444 的国名），
   * drawLabels 将其原样画回；只有再涂一笔（走到函数末尾 `_blockVer++`）才换代。
   * 故只要本次重建结果为空（或数据尚未就绪），必须 `_blockVer++`
   * 并把 `_blockOf` 清成 -1（空结果也是一次新结果）。
   * 不得只在末尾 —— 那正是「有块才换代、没块就卡住」的漏洞。
   */
  const _invalidateBlockCache = () => {
    state._blockVer = (state._blockVer || 0) + 1;
    const _np = (state.meta && state.meta.numProvinces) | 0;
    state._blockOf = new Int32Array(_np || 1).fill(-1);
  };
  const adj = state.adjacency;
  const pos = state.provPos;
  const paint = renderer && renderer.paintData;
  if (!adj || !pos || !paint) { _invalidateBlockCache(); return; }

  const n = state.meta.numProvinces;
  const offsets = new Uint32Array(adj.buffer, adj.byteOffset, n + 1);
  const neighbors = new Uint16Array(adj.buffer, adj.byteOffset + (n + 1) * 4);

  const parent = _blocksScratch('parent', n);
  const identId = _blocksScratch('ident', n);
  const painted = [];
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  const cTier = countryTier();       // 无主地的身份 / 国名落点都按「最近的有主剧本层」

  /*
   * 身份串 → 小整数
   * 并查集不得以字符串作身份：逐省拼 `D|r,g,b|名字`（或 `名字|r,g,b`）字符串，
   * 每个邻居再 `Map.get` 一次 —— V3 4 万省 × 平均 4 邻
   * = 16 万次哈希 + 4 万次拼串，仅此一遍约 10ms
   * 现每种身份只拼一次串、换一个小整数（涂色时通常几十种），并查集内全比 `Int32Array` 中的整数
   * 两种模式共用同一张 interning 表 —— 同串必得同号，与字符串相等一致
   */
  const internMap = new Map();
  const internName = [''];           // id → 显示名（0 号占位 = "没有身份"）
  const internIdentity = (key, name) => {
    let id = internMap.get(key);
    if (id === undefined) {
      id = internName.length;
      internMap.set(key, id);
      internName.push(name);
    }
    return id;
  };
  /* 并查集初始化 —— 两种模式都要执行（只写在 all 分支时，涂色模式 parent 全为 0） */
  for (let q = 1; q < n; q++) parent[q] = q;
  identId.fill(0);

  /** 这一层每个省的头衔（all 模式缓存；后面判 singleTid 还要用一遍） */
  const tidAt = _blocksScratch('tid', n);

  if (all) {
    const nReal = state.meta.numRealTitles != null ? state.meta.numRealTitles : 1e9;
    /*
     * 没涂色的省也参与分组EU4/EU5 默认停在省份层（省份层 zoom 门槛 88%）：
     * 开局 20% 全图视角一条名字都不过闸，色块名（门槛 20%）又因 paintBlocks=0
     * （没涂色即无块）一条都没有 → 开局一片空白
     * 故没涂色的省也进来：身份按“当前显示逻辑”算 = 原版政治地图的国名
     * “导入后冒 1789 普鲁士”一类问题不归此处：那是 era 视图 + 用户主动导入配置，
     * 没涂的省显原色是正确的；需防的是玩家涂了色的块被没涂的省冲掉（下方涂过优先逻辑未变）
     */
    /*
     * 恢复为仅当停在剧本层时才顺带收没涂色的省，其余情况只收涂过的
     * 若为 true，没涂色的省全部作为色块名进来，未选剧本时整张图按“末代剧本”的国家分组，
     * 一进图便出现 2025 / 1939 / 1789 的国名
     */
    const incUnpainted = unpainted || (nEra > 0 && state.tier < nEra);
    /*
     * 身份按头衔缓存 —— 同一个国家几万个省，没必要每省拼一遍字符串。
     * 能按头衔缓存的不要按省算：`_noOwn` / hideLabel / 伪头衔判定
     * 全都只看 tid —— 4 万次里有 3.9 万次是同一批国家的重复劳动。
     */
    const tidInfo = new Map();
    for (let pid = 1; pid < n; pid++) {
      const tid = titleAt(pid, cTier);
      tidAt[pid] = tid;
      let info = tidInfo.get(tid);
      if (info === undefined) {
        const noOwn = (tid === NO_TITLE || tid == null || tid >= nReal);
        const allowed = !(!noOwn && state.titles.hideLabel && state.titles.hideLabel[tid])
          && pseudoNameAllowed(isWasteOrWaterTid(tid));
        let id = 0;
        if (allowed) {
          /*
           * 用「当前显示的名字」，不是原始 names：
           * 改名工具把国家改成 A 名之后，没涂的那半也必须按 A 名分组，
           * 否则涂色空但当前剧本为 A 色 / A 名的地块会被分到别处。
           */
          const nm0 = (state.titleName && state.titleName.has(tid))
            ? state.titleName.get(tid) : (state.titles.names[tid] || '');
          const c0 = state.titles.colors[tid] || [150, 150, 150];
          if (nm0) id = internIdentity(nm0 + "|" + c0[0] + "," + c0[1] + "," + c0[2], nm0);
        }
        info = { noOwn, allowed, id };
        tidInfo.set(tid, info);
      }
      const _paintedPid = paint[pid * 4 + 3] > 0;
      // 只收真头衔 —— 海、湖、河、山那些是伪头衔（第勒尼安海之类），不该当势力名画
      // 无主地也是 —— 但玩家涂过的无主地例外 （见下面 _paintedPid 那一段）
      if (info.noOwn && !_paintedPid) continue;
      /* 荒地 / 水域那类伪头衔不画成势力名 */
      if (!info.allowed) continue;
      if (!incUnpainted && !_paintedPid) continue;
      let id = info.id;
      // 原版名为空不等于该地没有名字 —— 涂过的地名字在标签层
      // （导入带 clearEraNames 的配色时，原版国名被整层清掉；一律 continue 会
      // 连涂过的地一起跳过 → 全图一个国名都画不出来
      // 即「导入涂色方案之后显示不出国家名称」）
      if (id === 0 && !_paintedPid) continue;
      if (_paintedPid) {
        // 涂过的省：身份按手绘层算（名字取标记名、颜色取涂色）
        const nm2 = displayedLabel(pid, tid);
        if (!nm2) continue;
        const c2 = stableColor(pid, tid);
        if (!c2) continue;
        id = internIdentity(nm2 + "|" + c2[0] + "," + c2[1] + "," + c2[2], nm2);
      }
      identId[pid] = id;
      painted.push(pid);
    }
  } else {
    for (let pid = 1; pid < n; pid++) {
      if (paint[pid * 4 + 3] > 0) painted.push(pid);
    }
  }
  // 一块都没涂：没有色块可分
  if (!painted.length) { _invalidateBlockCache(); return; }
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const p = parent[x]; parent[x] = r; x = p; }
    return r;
  };

  const labels = state.provLabel;
  const editT = (typeof editTier === 'function') ? editTier() : cTier;
  // 取名字要用对层 涂过的省：名字记在涂色那一层的头衔上
  const nameTidOf = (pid) => titleAt(pid, paint[pid * 4 + 3] > 0 ? editT : cTier);
  // 涂色实体的身份数字：有名字按名字（颜色不参与分家），没名字才按颜色
  const paintKeyOf = (pid) => {
    const tid = nameTidOf(pid);
    const nm = String(displayedLabel(pid, tid) || '');
    const c = stableColor(pid, tid) || [150, 150, 150];
    return internIdentity("D|" + c[0] + "," + c[1] + "," + c[2] + "|" + nm, nm);
  };

  /**
   * 没涂过的地在此模式下的身份：一个永不匹配的哨兵（-1）
   * 细层（all=false）只画玩家涂出来的色块，故“没涂过”的地本身没有身份，
   * 但它仍须参与并查集：没被涂过的地方也要能并入自己那一族
   * 若每格都调 paintKeyOf()，4 万格里绝大多数没涂过，
   * 却每格拼一个 `D|r,g,b|名字` 字符串，纯属浪费
   */
  const NO_IDENT = -1;
  const idCache = _blocksScratch('idcache', n);   // 0 = 没算过（真身份从 1 开始）
  idCache.fill(0);
  const identOfPid = (q) => {
    if (paint[q * 4 + 3] === 0) return NO_IDENT;
    let v = idCache[q];
    if (v === 0) { v = paintKeyOf(q); idCache[q] = v; }
    return v;
  };

  /* ---- 并查集：同身份相邻省并成一族 ---------------------------------- */
  /*
   * 细层（all=false）只扫涂过的地不分 all 都跑 1..n 时为 4 万格 × 4 邻 = 16 万次比较，
   * 而没涂过的地身份一律是哨兵 -1，它们只与彼此相等，并出来的组
   * 又因“必须含涂过的地”被整组丢弃，等于白跑（涂过的身份是 interning 出来的正数，永远不等于 -1，
   * 故哨兵组不可能混进涂过的族里，跳过它不影响任何保留的组）
   * 涂 400 块时从 4 万格降到 400 格；涂满全图才回到原量级
   */
  const unionFrom = (pid) => {
    // pid 的根在进入循环时取一次 —— 免去每个邻居都 find(pid)
    const _own = all ? identId[pid] : identOfPid(pid);
    let ra = -1;
    for (let k = offsets[pid], e = offsets[pid + 1]; k < e; k++) {
      const nb = neighbors[k];
      if (nb <= 0) continue;
      if ((all ? identId[nb] : identOfPid(nb)) !== _own) continue;
      if (ra < 0) ra = find(pid);
      const rb = find(nb);
      if (ra !== rb) { parent[ra] = rb; ra = rb; }
    }
  };
  if (all) { for (let pid = 1; pid < n; pid++) unionFrom(pid); }
  else { for (let i = 0; i < painted.length; i++) unionFrom(painted[i]); }

  /* ---- 按根聚成族 ---------------------------------------------------- */
  const groupOf = _blocksScratch('group', n);
  groupOf.fill(-1);
  const groupsArr = [];
  const addPid = (pid) => {
    const root = find(pid);
    let gi = groupOf[root];
    if (gi < 0) {
      gi = groupsArr.length;
      groupOf[root] = gi;
      const _tid0 = nameTidOf(pid);
      groupsArr.push({
        x: 0, y: 0, w: 0, pids: [],
        label: labels ? labels[pid] : -1,
        // 显示色（涂过用涂色、没涂用原版）
        rgb: stableColor(pid, titleAt(pid, cTier)) || [255, 255, 255],
        id: all ? identId[pid] : 0,
        name: String(displayedLabel(pid, _tid0) || ''),
        tid0: _tid0,
        // 判"整坨同一个头衔 / 这一坨里有涂过的省"（版图贴合用）
        // 此处不再做一遍全图扫（40k 次 titleAt + paint 读取），改为就地记下
        single: true, paintedAny: false,
        minx: 0, maxx: 0, _hasBox: 0,
      });
    }
    const g = groupsArr[gi];
    g.pids.push(pid);
    if ((all ? tidAt[pid] : titleAt(pid, cTier)) !== g.tid0) g.single = false;
    const _paintedHere = paint[pid * 4 + 3] > 0;
    if (_paintedHere) g.paintedAny = true;
    // 细层：只有玩家涂过的地才计入位置 / 面积 / 跨度
    // 没涂过的邻居仍然"跟着这一族活着"，但不许撑大这一族
    // （若全都算进去，挑的颜色 + 标签一旦撞上某个 1789 的 tag，
    // 整块 1789 的地会把中心与面积一并带偏）
    if (!all && !_paintedHere) return;   // 现包在 addPid 里（不再直接 continue）
    const w = pos[pid * 3 + 2] || 1;
    const _px = pos[pid * 3];
    if (!g._hasBox) { g._hasBox = 1; g.minx = _px; g.maxx = _px; }
    else { if (_px < g.minx) g.minx = _px; if (_px > g.maxx) g.maxx = _px; }
    g.x += _px * w;
    g.y += pos[pid * 3 + 1] * w;
    g.w += w;
  };
  /* 剧本层（all）里全图每个省都要有组；细层只编玩家涂出来的那些片
 * （细层跳过的理由跟上面并查集那条一模一样 只有涂过的省可能成组）*/
  if (all) { for (let pid = 1; pid < n; pid++) addPid(pid); }
  else { for (let i = 0; i < painted.length; i++) addPid(painted[i]); }

  /*
   * 每个连通域各自出一个名字
   * 同色同标记可能铺成几块互不相连的地方（本土 + 海外省 + 沿海小岛），每块都标一个
   * 字号按该组自己的面积给（见 labels 那边），小岛的名字自然小，够不上门槛则不画 ——
   * 这是“只留最大那片”原本要解决的问题，现由门槛处理，无需牺牲其它连通域
   */
  const out = [];
  for (const g of groupsArr) {
    if (g.w <= 0) continue;
    let name = g.name;
    // 剧本层用"身份串的名字部分" （跟分族同一个口径）
    if (all && g.id) name = internName[g.id];
    // 旧包共享水节点的类名（"海洋"/"湖泊"那种）不是具体名 别当国家名画
    if (name === '湖泊' || name === '海洋' || name === '河流' || name === '不可通行') name = '';
    // 落点 = 这一坨连通域自己的几何中心与像素数
    // 若取“挑中的那一片”（首都 / 本土），吞并全国后名字仍只有老家那么大
    out.push({ name, x: g.x / g.w, y: g.y / g.w, area: g.w, rgb: g.rgb,
               w: Math.max(0, g.maxx - g.minx),   // 横向跨度 （限字号用）
               tid: g.tid0,           // 这一坨代表哪个头衔 （图例里改名要写回它）
               mtier: cTier,          // 版图贴合按这一层的归属查（不是视图层）
               singleTid: g.single, paintedAny: g.paintedAny,
               pids: g.pids });        // 图例算"这一族涂出来的面积"要用（legendEntries）
  }
  out.sort((a, b) => b.area - a.area);   // 大的先摆
  /*
   * 每一族最多留 N 个名字（设置页「每国名字上限」，0 / 拉到底 = 不限）。
   * 是「同一个国家」的，不是「全世界」的：即「英国本土 + 它的殖民地，加起来最多显示 N 个」。
   * 若写成全局取前 N → 一屏只剩十几个国名、别的国家全没名字
   * （EU4 的 1444 有 1863 坨，被砍到 12，表现为国名很多不显示）。
   * 分组按显示色 + 名字（与上面分族同一个身份，同色不同国也不会串）。
   * `out` 已按面积降序，所以每组自然就是「留最大的那 N 坨」。
   */
  const _cap = labelMaxValue();          // 0 = 拉到最右「无上限」→ 不截
  if (_cap > 0) {
    const _per = new Map();              // 族 → 已经留了几个
    const _kept = [];
    for (const b of out) {
      const k = (b.rgb ? b.rgb.join(',') : '') + '|' + (b.name || '');
      const n0 = _per.get(k) || 0;
      if (n0 >= _cap) continue;           // 这一族够了 后面的（更小的）都不要
      _per.set(k, n0 + 1);
      _kept.push(b);
    }
    out.length = 0;
    for (const b of _kept) out.push(b);
  }
  state.paintBlocks = out;
  /*
   * 涂色一变，旗帜的覆盖范围要跟着重算：
   * 每面旗按自己的 key + 范围重新解析省号（比例「看地图」时外接框也跟着变）。
   * （内部有 220ms 防抖，不会在此同步算几百毫秒。）
   */
  try { if (typeof flagOnBlocksChanged === 'function') flagOnBlocksChanged(); } catch (e) { /* */ }
  /*
   * 给每块色块一个块号，并记下每个省属于哪一块
   * 逐块现建小栅格（`PaintedMaskSource`，缓存 48 张）时，一屏国名几十上百个，
   * 等于每帧重建一遍，导致卡顿现改为一张全图级的块号栅格：排版器按 `blockOf(pid)` 分块
   * 涂色变化即换代：`_blockVer` 自增，排版器见版本变化后重建栅格
   */
  for (let i = 0; i < out.length; i++) out[i].gid = i;
  const _nProv = (state.meta && state.meta.numProvinces) | 0;
  const _blockOf = new Int32Array(_nProv || 1).fill(-1);
  for (let i = 0; i < out.length; i++) {
    const pids = out[i].pids;
    if (!pids) continue;
    for (const pid of pids) if (pid > 0 && pid < _nProv) _blockOf[pid] = i;
  }
  state._blockOf = _blockOf;
  state._blockVer = (state._blockVer || 0) + 1;

  /*
   * 图例列表不在此处刷 —— 这里是「涂一笔就重新分组」的地方，
   * 每次涂色都重建一遍图例 DOM 是白费开销（且面板开着时无法涂地图）。
   * 列表只在「点开图例 / 导出」时更新。
   */
}

/**
 * 重建边界图并推给渲染器（CPU 按省份算，见 buildBorderEdges / buildBorderDepth 那两段说明）。
 * 什么时候得重算：涂色、清除、换视图层、换粒度 —— 凡是「身份」会变的都算。
 * 注意：拖动涂色是每帧画一笔，每帧重算一次 17ms 会卡，
 *   → 加 150ms 防抖（松手之后算一次就够了）。
 * @param {boolean} now true = 立刻算（开图那一次）
 */
/** 上一次算的时候「身份相关的输入」长什么样 —— 没变就不重算 */
/** 去掉「涂色进度」的核心签名 —— 跟 borderFieldSig 只差它时，说明这次是涂色触发的 */
let borderFieldSigCore = '';
/**
 * 计算粗筛位图并推给渲染器
 * 仅在加载地图时执行一次，换层 / 换粒度 / 涂色均不再调用
 * 原因：粗筛只需回答“这一带将来会不会出边界”，而任何层的边界都落在省界上，
 * 省界是纯几何、加载完即固定，故该图与当前层、有无涂色无关
 * 若当作“当前层级的边界图”，每次涂色都要重算，即那 1 秒的卡顿
 */
function refreshBorderField() {
  if (!renderer || !renderer.setBorderDepth) return;
  /* 手机上不生成（显存吃紧 退回射线：画得对，只是慢一点）*/
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
 * 边界粗筛位图 —— 加载时算一次，之后不再重算
 * 三个前提：
 *   ① 上级不新增边界 → 任何层的边界都落在省界上，故该图只与省份图形状有关，
 *      与当前层、涂色无关
 *   ② 不需要距离 → 只需 1 位：“这一格是否值得看一眼”
 *   ③ 加载时顺便算完 → 换层 / 换粒度 / 涂色都不再重算
 * 做法：
 *   标轮廓：相邻两个像素的省份 id 不同 → 该格在省界上
 *   膨胀 2 格：粗线（最大线宽 3 格 ⇒ 半宽 1.5 格）也要覆盖
 *   打包：8 格 1 字节，EU4 上 1.4MB
 * 它只负责排除：圈内是否画、画多粗由着色器现算（省份归属现成），
 * 故保守一点无妨：多留几格只是多跑几趟射线，线不会画错
 * @returns {{bits: Uint8Array, bw: number, w, h, ms}|null}
 */
function buildBorderDepth(opts) {
  const meta = state.meta;
  const pids = state.provinceIds;
  if (!meta || !pids) return null;
  const W = meta.mapWidth, H = meta.mapHeight;
  if (pids.length !== W * H) return null;              // 分块图不算
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  /*
   * ① 标轮廓（省界上的像素）—— 一遍全图，边标边写位
   * 逐像素标进 near 数组 → 膨胀 → 再扫一遍全图打包，为两遍全图；
   * 现直接以位图作标记，膨胀时在位图上翻位 → 只剩一遍全图
   * 省下的一遍为 1153 万次（EU4），大图上亿次缝的两侧都要标，否则膨胀出的带子偏一格
   */
  const bw = (W + 7) >> 3;
  const bits = new Uint8Array(bw * H);
  const _get = (x, y) => (bits[y * bw + (x >> 3)] >> (x & 7)) & 1;
  const _set = (x, y) => { bits[y * bw + (x >> 3)] |= (1 << (x & 7)); };
  let front = [];                       // 本轮要往外扩的格（只存"新点亮"的）
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x, p = pids[i];
      if (p <= 0) continue;
      /* 右边 / 下边是别的省 → 这一格和对面那一格都在缝上 */
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
  /* ② 膨胀 2 格：只从上一轮新点亮的那一圈往外扩 不扫全图
 * 每轮只看 newList（本轮刚点亮的）—— 不然同一轮里会连锁扩散出去 */
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
 * 「更新势力名」：清空所有势力名，按「玩家现在看到的颜色」重新画一遍。
 * 画完之后这些势力名就当原版势力名用 —— 该受的开关（势力·名称 / 地区·名称）
 * 照受，换层级、换地图也是同一套规矩，没有额外的特殊状态。
 */
function retintCountryLabels() {
  // ① 清空所有势力名（连贴图缓存一起清）
  labels.clear();
  // ② 直接复用现成那套（泛化成"看全图"）——坐标/面积一律不自己算
  // unpainted=true：允许没涂色的省也参与（这是「更新国名」的本意：
  // 按全图当前显示重画国名，原版那套名字也要在）
  rebuildPaintBlocks(true, true);
  const meta = state.meta;
  const fadeCountry = !(meta.tiers && meta.tiers[0] === 'e');
  const nEra = (meta.eraDates && meta.eraDates.length) || 0;
  const tier = countryTier();        // 同上
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

/*
 * 地名的取点
 * 口径：一个连通域一个标，与势力名同一套。
 * 若按头衔取点：坐标取 `titles.lx/ly`（构建期算出的最大连通域重心，
 * 见 build_data.py 的 centroids_for_titles）。跨不相连区域的头衔（CK3 王国/公爵领的
 * 飞地、EU4 的岛群、跨 180° 经线的那片海）只会出一个名，落在最大的一块上，其余块无标。
 * 现按 `rebuildPaintBlocks`（势力名那条）实现：
 * 按地块邻接做并查集 → 每个连通域一个点 → 再按头衔截断（「地名上限」）。
 * 「跨接缝」那套随之退役：`build_adjacency` 只连图内 4 邻域，没有跨左右边界的边，
 * 因此跨 180° 经线的那片海在邻接图上本就是两块，这里自然左右各出一枚（分几块就出几个标）；
 * `titles.wrapLabel` / `buildWrapLabelPoints` / 圆均值那套均不再需要。
 */

/**
 * 把「每块地一个身份」打成连通域（并查集，与 `rebuildPaintBlocks` 同一套）
 *  @param {Int32Array} ident  pid → 身份号（相同身份 + 相邻才算一块；
 *                             `-1` = 该地块不参与，由调用方先排除）
 *  @param {number} n          numProvinces
 *  @returns {Array<{id:number,x:number,y:number,area:number}>}
 *           每个连通域一项；`id` 为身份号；`x/y` 为像素加权质心
 *  注意：x 为普通加权平均，不是圆均值。`build_adjacency` 只连图内 4 邻域、
 *    没有跨左右边界的边，故跨 180° 经线的那片海在邻接图上本就是两块，
 *    每块各自落在自己那半边；「把 x 当角度」那套（`cos/sin/atan2`）
 *    连同 `wrapLabel` / 左右各一枚均不再需要。
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
  /*
   * 把「每省属于哪个名字块」一起带出去。
   * 排版器要用同一套块号 —— 名字的数量和版图的块必须是一个标准。
   * 值 = 那一块的代表省号；-1 = 不参与（没名字 / 不上地名 / 无主）。
   */
  const roots = new Int32Array(n).fill(-1);
  for (let pid = 1; pid < n; pid++) {
    if (ident[pid] >= 0) roots[pid] = find(pid);
  }
  out.roots = roots;
  out.ident = ident;
  return out;
}


/*
 * 构建期拆出来的「同名水片」键（`2:west_siberia_region_lake` / `0:asia_lake` 那种）。
 * EU5 的包里水陆混片会被拆成两片，新片的名字继承陆地父节点
 * （`2:west_siberia_region_lake` 名「西西伯利亚」，`4:bayanday_province_lake` 名「巴彦代」）
 * → 若照常走地名那条，湖面上写的就还是陆地那个名字。
 * 这个 `层级:` 前缀只有 EU5 的包会带（别的包的水片是 `#` 前缀，实测 0 条）。
 * 用途见 `buildPlaceComponents` 里那段水陆分离。
 */
const SPLIT_WATER_KEY_RE = /^\d+:/;

/**
 * 某一层上所有头衔的连通域点（未截断，全局按面积降序）。
 * @param {number} tier
 * @returns {Array<{tid:number,x:number,y:number,area:number,tier:number}>}
 * 注意：点的 `name` 不在这儿存 —— 改名要实时生效，名字留到每帧取用时现读
 *   （见 `placePointsFor`；这样改个名不用把这趟并查集重跑一遍）。
 * 注意：料跟 `rebuildPaintBlocks` 一模一样：`state.adjacency` / `state.provPos` /
 *   `titleAt(pid, tier)` —— 数据格式一个字节都不动。
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
    /* 身份 = 这一层这一格属于哪个头衔
 * 两道闸跟旧的 `byTier` 收人判据 + `pointsFor` 的 `!names[i]` 等价 */
    const ident = new Int32Array(n).fill(-1);
    for (let pid = 1; pid < n; pid++) {
      const t = titleAt(pid, idx);
      if (t == null || t < 0 || t === NO_TITLE || t >= names.length) continue;
      if (!names[t]) continue;         // 没名字的不出标
      if (hide && hide[t]) continue;   // 标了"不上地名"的（海/湖/河/山那类伪头衔）
      ident[pid] = t;
    }
    /*
     * 水陆不许并进同一个名字块（针对「巴彦岱 + 贝加尔湖」）。
     * 部分地图包的 area / prov 层湖格与陆格共用同一个头衔（data_eu5 的 pid 2313
     * 贝加尔湖与 pid 2842 巴彦代在 prov 层同为 1279）→ 并查集把它们并成一块，
     * 块的质心落在湖上，于是「巴彦代」一个名字压着两种地形。
     * 海不受此影响：海在游戏数据里本就有独立的 area / prov 头衔。
     * 两条规则都很窄，且只认 `state.waterKindArr`（无水陆分类的地图包整段跳过；
     * 这张表在 `loadPack` 末尾就建好，构建点全在 draw / export 里）：
     * ① 混片：这一层这个头衔既有陆格又有水格 → 水格那半不参与地名块，
     * 其名字交给水域那条（`buildSeaLabelPoints` 处有真名表，
     * EU5 每层都答得出「贝加尔湖」，见 `meta.seaNamesByTier`）；
     * ② 同名拆片：全水、键是 `2:…_lake` 那种（名字继承自陆地）→ 整片不出地名，
     * 同上交给水域那条 —— 否则「西西伯利亚」会在湖上再写一遍。
     * 不碰 `state._blockOf` / `paintBlocks` —— 那是给涂色用的块，两套。
     * 一次构建只多两趟 numProvinces 的整数扫（`Uint8Array` 复用一份，不是每帧）。
     */
    const _wk = state.waterKindArr;
    if (_wk) {
      /* 位1 = 有陆格，位2 = 有水格，位4 = 这个头衔已判过"不出地名"（免得逐块重判）*/
      const _has = new Uint8Array(names.length);
      for (let pid = 1; pid < n; pid++) {
        const t = ident[pid];
        if (t < 0) continue;
        _has[t] |= _wk[pid] ? 2 : 1;
      }
      const _TK = T.keys || [];
      for (let pid = 1; pid < n; pid++) {
        const t = ident[pid];
        if (t < 0 || !_wk[pid]) continue;
        if (!(_has[t] & 4)) {   // 同一个头衔就判一次
          /* ① 混片（水陆都有）② 同名拆片（`2:…_lake` 那种名字继承自陆地）→ 都不出地名 */
          if ((_has[t] & 3) === 3 || SPLIT_WATER_KEY_RE.test(String(_TK[t] || ''))) _has[t] |= 4;
        }
        if (_has[t] & 4) ident[pid] = -1;
      }
    }
    const comps = groupComponents(ident, n);
    for (const c of comps) {
      out.push({ tid: c.id, x: c.x, y: c.y, area: c.area, tier: idx });
    }
    /* 名字块号存一份，排版器要跟它对齐（见 maplabels 的 `groupOf`）
 * 键跟 `_placeCache` 一致 —— 换图 / 换数据时要一起失效 */
    if (!state._groupRoots) state._groupRoots = new Map();
    state._groupRoots.set(key, comps.roots);
    // 大的在前 —— `placePointsFor` 的"每个头衔留最大的 N 个"直接靠这个顺序
    out.sort((a, b) => b.area - a.area);
  }
  state._placeCache.set(key, out);
  return out;
}

/**
 * 某一层：这一省属于哪个名字块（和 `buildPlaceComponents` 同一套并查集）。
 * 排版器建版图栅格时按这个分块 —— 名字有几个块、版图就几块，不会两套标准。
 * 没算过就现算（`buildPlaceComponents` 自己带缓存）。
 */
function placeGroupAt(tier, pid) {
  const idx = tier | 0;
  const m = state.meta, T = state.titles;
  const n = (m && m.numProvinces) | 0;
  const kN = (T && T.keys && T.keys.length) | 0;
  /*
   * 键记忆：CPU 剖析中此处占 23.9%。
   * 版图栅格 _build 时每格都要问一次「这省属于哪块」（CK3 每层 66 万格），
   * 若每次都现拼字符串键再 Map.get，拼键比查表更贵。
   * 调用方是逐格循环，同一层内键几乎不变 → 记住上一次的键，相同则直用；
   * 换层 / 换图时键变化 → 走正常路径重建。
   */
  if (state._pgKey === idx && state._pgN === n && state._pgK === kN
      && state._pgRoots) {
    return state._pgRoots[pid];
  }
  const key = idx + '|' + n + '|' + kN;
  let roots = state._groupRoots && state._groupRoots.get(key);
  if (!roots) {
    buildPlaceComponents(idx);
    roots = state._groupRoots && state._groupRoots.get(key);
  }
  state._pgKey = idx;
  state._pgN = n;
  state._pgK = kN;
  state._pgRoots = roots || null;
  return roots ? roots[pid] : -1;
}

/**
 * 某一层真正要画的地名点：按「地名上限」按头衔截断。
 *  每帧都会调用，因此只做两件廉价操作：
 *    ① 上限 / 层未变则直接返回上次那份（并查集不重跑）；
 *    ② 把 `name` 现读一遍（改名实时生效，也不必重建连通域）。
 *  对象复用，不再每帧新建 m 个对象。
 */
function placePointsFor(tier) {
  const all = buildPlaceComponents(tier);
  const cap = labelPlaceMaxValue();          // 0 = 不封顶
  if (state._placeCapped !== all || state._placeCapUsed !== cap) {
    let kept = all;
    if (cap > 0) {
      const per = new Map();                 // 头衔 → 这个头衔已经留了几个
      kept = [];
      for (const p of all) {                 // all 已按面积降序 留下的自然是最大的那几块
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
  /*
   * 名字不能每帧重写一遍（性能实测：EU5 最细层 2.3 万个点，
   * 每帧两万多次字符串赋值是凑名单里的大头）。
   * 而 `placePointsFor` 的调用方（自测 / 预热）要求点上带着 `name`
   * → 用「名字版本号」挡一下：只有改名 / 换图之后才写一轮
   * （`state._nameVer` 由改名的出口自增，见 `renameAt`）。
   */
  const ver = state._nameVer | 0;
  if (state._placeNameVer !== ver || (kept.length && kept[0].name === undefined)) {
    const names = (state.titles && state.titles.names) || [];
    for (let i = 0; i < kept.length; i++) kept[i].name = names[kept[i].tid] || '';
    state._placeNameVer = ver;
  }
  return kept;
}

/**
 * 给荒地 / 水域节点补上标签位置。
 *  这两类节点在缓存里有名字、没有 lx/ly、也没有 area，
 *  因此 LabelLayer 不收它们（要求 lx/ly/area 三个都有）。
 *  名字本身齐全：荒地名是「热那亚」「波尔多」这类真地名，
 *  水域是「海洋 / 湖泊 / 河流 / 不可通行海域」（各游戏剧本里都有）。
 *  算法：取最细一层把省份按头衔归堆，以像素数当权重求质心
 *  （与构建期给真头衔算位置的算法一致，只是这里现算；各省质心在 provPos 里）。
 *  area 取这一堆的像素总数（字号门槛看它）。
 *  注意：CK3 按规则不标（CK3 不给荒地和水域标名字，其他游戏标），
 *    CK3 直接不算，LabelLayer 也就收不到它们；
 *    配套：那两个「名称」开关在 CK3 里隐藏（见 syncLayerSwitches）。
 *  注意：按 `NAME_POLICY` 分流后，CK3 唯一要出标的是河流（海 / 湖 / 荒地全不出），
 *    故此处不能整块 `return`：CK3 走只认河流的窄路（`_ck3` 分支），
 *    其他游戏照旧全算（谁出谁不出由 `drawLabels` 按那张表判定）。
 */
function buildPseudoLabelPositions() {
  const t = state.titles, pp = state.provPos, meta = state.meta || {};
  if (!t || !pp) return;
  const _ck3onlyRiver = String(meta.game) === 'ck3';   // CK3：只给河流补位置
  const n = meta.numProvinces | 0;
  const tiers = (meta.tiers && meta.tiers.length) || 5;
  const fine = tiers - 1;
  const nNames = (t.names || []).length;

  // 要找的两类：荒地（meta.wasteland）+ 水域那四个伪头衔
  // 键现在是每层一片（`#sea_pr_57` 那种 精确查 `'#sea'` 一个都命不中）
  // → 分两条路：
  // ① 每层一片的那种片（`#sea_pr_57` / `#lake_ar_3` 见 isTierPieceKey）
  // —— 走普通头衔那套（水域和其他地块一样，仅仅是不能填色）
  // 仅仅是不能填色，其他绘制规则什么的都一样"）：
  // 位置 / 折线全写进 `titles` 那几本数组 LabelLayer 当普通头衔
  // 收进 byTier 名字 / 缩放门槛 / 那两个「名称」开关全跟地名一条路
  // 这就是"一片一个标"的来源：一个 tid 就是一片 （不再另发一组点）
  // ② 老包那个共享节点（整个世界的海共用一个 `#sea`）+ 最细层逐块的荒地
  // （`wl_<地块号>`）—— 它们不是片（一个 tid 底下几百个不同名字）
  // → 照旧只补一个位置 名字交给 buildSeaLabelPoints 按真名表出
  // （那片共享的海在图上仍只有一个「海洋」标，叠放顺序不变）
  const K = t.keys || [];
  const want = new Set(_ck3onlyRiver ? [] : (meta.wasteland || []));
  for (const k of (_ck3onlyRiver ? ['#river'] : ['#sea', '#lake', '#river', '#impassable_sea', '#impassable'])) {
    for (const i of titleIndicesByPrefix(k)) {
      if (isTierPieceKey(K[i])) continue;
      want.add(i);
    }
  }

  /*
   * 一个 tid 一个点，该点取其「最大那一块」的质心。
   * 注意：数组一个 tid 只能存一个坐标，故只能挑一块作代表：
   * 挑最大的那块（`flyTo` / 搜索落到那一块里，不会落地图中部）。
   * 注意：圆均值那套不再使用 —— 邻接表只连图内 4 邻域、没有跨左右边界的边，
   * 跨 180° 经线的海本就是两块，各自落在自己那半边。
   */
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

  /*
   * ② 水域：每层一片的那种片（`#sea_pr_57` / `#lake_ar_3`，见 isTierPieceKey）。
   * 按层扫，不能只扫最细层（片是每层各有一份的，最细层的 tid 跟粗层的 tid 不是一个节点）。
   * 片名是类名的（「海洋」/「湖泊」，见 PSEUDO_CATEGORY_NAMES）不给位置
   * —— 那一层的水名表里这一片根本没名字；给了位置 = 地图上凭空多出一个「海洋」大标。
   * —— 与普通头衔那边的 `hideLabel` 同义：没名字就不该出标。
   */
  const wAcc = new Map();          // tid → { 最大那块的 x/y + 总面积 }
  for (let ti = 0; ti < tiers; ti++) {
    const ident = new Int32Array(n).fill(-1);
    for (let pid = 1; pid < n; pid++) {
      const tid = titleAt(pid, ti);
      if (tid == null || tid === NO_TITLE) continue;
      const key = String(K[tid] || '');
      if (!isTierPieceKey(key) || !isWaterKey(key)) continue;
      /* CK3 只补河流的片 （别的按方案不出标 连位置都不必算 省内存）*/
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
    t.lx[tid] = Math.round(a.x);       // 最大那块的质心 （不再是圆均值）
    t.ly[tid] = Math.round(a.y);
    t.area[tid] = a.total;             // 面积仍是总和 （字号门槛看它）
    t.blockArea[tid] = a.total;
    done++;
  }
  /* 水域片：质心 （名字一律横着写在质心上 —— 不再算铺排折线）*/
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

/**
 * 荒地名 / 老包的水域名标签点 —— 一个名字一个标。
 *  注意：每层一片的水域片不走此处（水域与其他地块一样，只是不能填色）：
 *    它们归 `buildPseudoLabelPositions` + `labels.byTier` 的普通头衔路径。
 *    此处只处理两类没有片的伪头衔：
 *      · 老包的水域（整个世界的海共用一个 `#sea`，不是片）→ 按真名表出，
 *        一个名字一个标（波罗的海这种）；不是片就无法按 tid 聚。
 *      · 荒地（`wl_<地块号>` 逐块 + `#wasteland_*` 片）→ 一个名字一个标
 *        （EU4 和 EU5 的荒地有自己的名字，这一块保持现状）。
 *  每组一个标：用像素数加权求质心（与 buildPseudoLabelPositions 同一套算法）；
 *    x 走圆均值（否则跨 180° 经线的那片名字会跑到地图正中）；
 *    名字横写在质心上（不再算铺排折线）；
 *    粗层聚成一大片、细层聚成小片，同一套算法。
 *  注意：老包（未按层分片）退回 `meta.seaNames` 那几张真名表
 *    （那种包里全世界的海共用一个 `#sea`，按 tid 聚只会剩一个「海洋」）。
 *  注意：`tid` 给 null —— 这些点不属于任何头衔，是额外的一层；
 *    标签层只用 name/x/y/area/tier，不看 tid。
 *  注意：CK3 不给水域 / 荒地标名字（那两个开关在 CK3 里强制 false，
 *    drawLabels 那边还有一道）。
 */
function buildSeaLabelPoints() {
  const meta = state.meta || {}, pp = state.provPos;
  if (!pp) return [];
  /*
   * 注意：用视图层（state.tier），不是编辑层 —— 标签画的是「这一层看到的水域」
   * （悬停高亮那边用的是 editTier，两边都是「当前层那个片」，指向同一批地块）。
   * 一个名字一个组：组键两种来源，按包的新旧分流：
   * ① 每层一片的包 → 组 = 当前层那个 tid（只剩荒地走这条，
   * 水域片由上面 `if (_isWater && _piece) continue;` 让开）；
   * （同一个 tid 的地块就是一片，名字取该 tid 的）；
   * ② 老包（未按层分片）→ 组 = 真名表里的名字；
   * 注意：老包全世界的海共用一个 `#sea`，按 tid 聚只会聚出一个「海洋」，
   * 表里那几百个真海名（波罗的海那种）会全丢，那批包须走表；
   * 注意：两种包的组键故意不同（`t123` / `n波罗的海`），不要合成一个 Map 的键。
   */
  const T = state.titles || {};
  /*
   * 注意：用「编辑层」（= 粒度），不是视图层。
   * （剧本下高亮范围和名字应跟随粒度，没有粒度就是最低。）
   * 若用 `state.tier`（视图层），在剧本模式下它停在剧本层，
   * 而那一层的水域只有「整类」（`#sea_1444_xx`），名字只能是「海洋」这种类名、整类挤成一个标。
   * 注意：`editTier` 已处理：未开粒度 = 最低层，开了 = 那一层，
   * 于是名字 / 高亮 / 边界同一来源，三处一致。
   */
  const _vt = labelTier() | 0;
  /*
   * 注意：这一层没名字就是没名字（见 waterNameTable），
   * 不能写成 `_bt[_vt] || meta.seaNames`：HOI4 的省份级水域明明没名字，却会被战略区名填上。
   */
  const _waterTbl = waterNameTable(meta.seaNamesByTier, _vt);
  const _wlTbl = meta.wastelandNames;
  const n = meta.numProvinces | 0;
  /* 表里的键是地块 id（JSON 会变成字符串 两种都试）*/
  const _tblName = (tbl, pid) => {
    if (!tbl) return '';
    const v = (tbl[pid] != null) ? tbl[pid] : (tbl[String(pid)] != null ? tbl[String(pid)] : null);
    return v ? String(v) : '';
  };
  /*
   * 一个连通域一个标（与地名那条同一套）。
   * 组身份 `gk` 照旧（有片的包 → `t<tid>`；老包 → 类别字 + 名字），
   * 注意：同名不等于同一块：一个名字的像素可能分处地图两头
   * （太平洋被 180° 经线切开）→ 聚完组还要过一趟连通域，
   * 两块就出两个标（一个太平洋会变成两块，从而有两个名字）。
   * 注意：圆均值那套不再使用：邻接表没有跨左右边界的边，
   * 每一块自己都落在它那半边，普通像素加权平均即可。
   */
  const gidOf = new Map();         // 组身份 → 数字号（并查集要整数）
  const gInfo = new Map();         // 数字号 → { name, waste }
  const ident = new Int32Array(n).fill(-1);
  for (let pid = 1; pid < n; pid++) {
    let tid = titleAt(pid, _vt);
    if (tid == null || tid === NO_TITLE) continue;
    let key = String(T.keys[tid] || '');
    /*
     * 注意：水按 pid 问 `waterKindByPid`，不用 `isWaterKey(key)`。
     * 这一层的水片键（`#sea_pr_57`）在 CK3/CK2/EU4/HOI4 上带 `#`，
     * 但 EU5 不带 → 按键判断会使那一整套（名字 / 位置 / 连通域）在 EU5 上一块水都不进。
     * 荒地那一侧同理：键前缀 + `isWastelandTid`（该入口只收水）。
     */
    const _isWater = waterKindByPid(pid) !== 0;
    const _isWaste = !_isWater && (keyStarts(key, 'wl_') || keyStarts(key, '#impassable')
      || keyStarts(key, '#wasteland') || isWastelandTid(tid));
    /*
     * 注意：荒地换到最细层那一个头衔。
     * 原因：荒地在粗层不切分。实测 EU5 那 8 块亚马逊荒地在
     * `1337 / blank / reg / area / prov` 五层上全是同一个伪头衔（键 `#impassable` · tid 36188），
     * 只有最细的 `loc` 层才分成 8 个
     * （`amazon_jungle` / `madeira_amazon_jungle` / `negro_amazon_jungle` …）。
     * → 用当前层分组 = 8 个地点永远并成一个标
     * （现象：很多个叫「亚马逊丛林」的荒地地点只显示一个名字；
     * 海域和陆地都是一个头衔一个标，不会这样）。
     * 注意：只动荒地：水域有自己的「每层一片」（`#sea_pr_57` 那种），
     * 它在每一层都有自己的片，换层反而会串，水不动。
     * 注意：老包（键 `wl_<地块号>`）在最细层本就有逐块的头衔，换了也一样。
     */
    if (_isWaste) {
      const _ft = titleAtFinest(pid, _vt);
      if (_ft != null && _ft !== NO_TITLE && _ft >= 0) {
        tid = _ft;
        key = String(T.keys[tid] || '');
      }
    }
    if (!_isWater && !_isWaste) continue;
    /* 「每层一片」的那片才从节点取名字（`#sea_pr_57` 见 isTierPieceKey）
 * 别的（老包的共享 `#sea` / 最细层逐块的 `wl_<地块号>`）名字在真名表里
 * 荒地没有分层表（游戏里就一张）→ 每个地理层都拿它分片 结果一样 */
    const _piece = isTierPieceKey(key);
    /*
     * 每层一片的水域片不再走这儿（水域和其他地块一样，仅仅是不能填色）。
     * 它们的 lx/ly/path 已由 `buildPseudoLabelPositions` 补进 `titles` 数组，
     * LabelLayer 拿它们当普通头衔收进 byTier（名字 / 缩放门槛 /
     * 「地名」与「水域·名称」两个开关全跟地名一条路）。
     * 两边都发 = 同一个名字在图上叠两层字，所以这里必须让开。
     * 老包（整个世界的海共用一个 `#sea`，不是片）照旧留在这儿 ——
     * 它们的海名只有 `meta.seaNames` 那张真名表里有
     * （按 tid 聚只能聚出一个「海洋」，几百个真海名全丢，那批包非走表不可）。
     */
    /*
     * 注意：有片就一片一标。若仅用 `_isWater && _piece` 判水片，荒地片仍会留在此处按名字合组；
     * 现放宽为只要有片就让开：水片 / 荒地片一律交给普通头衔那条
     * （`drawLabels` 一个 tid 一个标，名字就是它自己那片的名字）。
     * 注意：老包（整类共用一个共享节点，没有片）照旧留在此处 ——
     * 它们的真名只在 `meta.seaNames` / `meta.wastelandNames` 那两张表里，
     * 按 tid 聚只能聚出一个「海洋」，那批包须走表。
     * 注意：片名是类名 / 占位号 / 空的照旧不出标（下面那道闸不动）。
     */
    if (_piece) continue;
    let nm = _piece ? String((T.names && T.names[tid]) || '')
                    : _tblName(_isWater ? _waterTbl : _wlTbl, pid);
    /*
     * 片名是类名的不出标（「海洋」/「不可通行山地」那种）。
     * 片名是构建期取的：那一层的水名表里没这个名字时，节点名就是类名，
     * 那种片没有具体名 → 不出标，不得拿类名充数。
     * 只判片名 —— 真名表那条路（`wl_` 逐块）不动。
     */
    /*
     * 片名是占位号的一律出真名，再没有就不出标。
     * CK2 的 259 个水片 / 20 个荒地片：`titles.names` 里可能只剩 `#936` 占位
     * → 先查 `meta.seaNames` / `meta.wastelandNames` 拿到真名就出标；
     * 真名也没有（或名字是「海洋」那种类名）→ 不出标，绝不把 `#936` 画到图上。
     */
    if ((_piece || _isWaste) && isPlaceholderName(nm)) nm = realNameFromTables(pid);
    if ((_piece || _isWaste) && isPseudoCategoryName(nm)) nm = '';
    /* 荒地那一列在最细层可能没名字 （EU5 的 `loc` 层就是这样）——
 * 那就退一步用真名表（`meta.wastelandNames` 逐地块的）
 * 实测那 8 块：细层头衔自己也是有名字的 这条只是兜底 */
    if (_isWaste && !nm) nm = _tblName(_wlTbl, pid);
    if (!nm) continue;         // 表里没有 → 这一格不给标（老包 / CK3 没有真名）
    /*
     * 水面和荒地的名字会撞（VN 那个包里湖的名字就叫 "x"，
     * 而荒地真名表里也有一条 "x"）—— 只按名字当键的话两条会并成一组，
     * 后到的那个地块就被算进先到的那个的 waste 标记里
     * （实跑量出来的：120 块湖的水名整批变成了荒地名标）。
     * 两张 Map 各扫一遍表（水一张、荒地一张）不会撞；合成一趟之后，键里必须带类别。
     */
    /*
     * 注意：组键一律按头衔。
     * 若用 `_piece ? (`t` + tid) : ((_isWater ? `w` : `j`) + nm)` 分组：
     * 没有片（键不带 `#`）的那批按名字分组 → 同名就并成一组。
     * 注意：`PIECE_KEY_RE` 要求键以 `#` 开头，
     * 而 EU5 的键不带 `#`（`amazon_jungle` / `lake_baikal` 那种），
     * → EU5 的荒地全部掉进「按名字分组」那条。实测：`loc` 层有 8 个不同的亚马逊荒地地点
     * （`amazon_jungle` / `madeira_amazon_jungle` / `negro_amazon_jungle` …，
     * 每个都是独立的一块，`meta.wastelandNames` 里也是 8 条真名，
     * 只是名字恰好都叫「亚马逊丛林」），→ 按名字一并 → 8 个地点只剩一个标。
     * 注意：「海域和陆地都不会这样」正是这个道理：
     * 它们的键在一层上是 `t<tid>`，一个头衔一组，天然不会同名相并。
     * 注意：同名但不相邻的两块仍会出两个标 —— 下面还有一趟连通域
     * （同名不等于同一块，见 `groupComponents`）。
     * 注意：水名 / 荒地名相撞的担心（VN 那个包里湖和荒地都叫 x）
     * 按头衔分组之后自然消除，头衔本就不会撞。
     */
    /*
     * 组键：有片按头衔、没片按「类别 + 名字」。实测：EU5 的荒地全部共用一个伪头衔
     * （键 `#impassable` · tid 36188 · 全世界荒地都是它）→ 荒地没法按头衔分组，只能按名字；
     * 而 `meta.wastelandNames` 是逐地块的（EU5 有 1971 条）：
     * 837 = 亚马逊丛林 · 65 = 阿比蒂比高地 · 82 = 阿布丛林 …→ 同名的一组 = 一片，这正是要的。
     * 类别字（`w` / `j`）必须留着：水面和荒地的名字会撞
     * （VN 那个包里湖和荒地都叫 "x" → 120 块湖的水名整批变成荒地名标）。
     * 若改成 `'t' + tid`，等于把全世界荒地并成一组，实测标签直接归零。
     */
    /*
     * 注意：荒地按「地点」分组。
     * 依据：最细层一个头衔 = 一个地点 = 一种颜色（EU5 原图按地点映射颜色），故一个头衔一个标。
     * 注意：荒地这一行的 `tid` 已在上方被换成最细层的头衔（见 `if (_isWaste)`），
     * 所以 `t + tid` 即「按地点」。注意：水域 / 荒地片仍用 `t + tid`（`_piece` 那条），未改。
     * 注意：不要退回「按名字」：同名且相邻的一整片会并成一个 ident，下面那趟连通域就再也切不开它。
     * 实测亚马逊那 8 块互相都是邻居（837↔14565↔24236↔27523↔25043），→ 按名字 = 1 个标；
     * 而塔克拉玛干那 5 块彼此不相邻 → 按名字也能出 5 个，
     * → 「塔克拉玛干行、亚马逊不行」的差别全在数据里（相邻与否）。
     */
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
  /* 水先、荒地后（叠放顺序不变：荒地标压在水名标上面） */
  const _comps = groupComponents(ident, n)
    .sort((a, b) => ((gInfo.get(a.id) || {}).waste ? 1 : 0)
                  - ((gInfo.get(b.id) || {}).waste ? 1 : 0));
  /*
   * 注意：判断连通域是否「横跨左右」。
   * 判据用成员地块的 x 跨度：跨度 > 半幅图宽 = 左右两侧都有它，
   * 与「扫左右两列」是同一件事，只是这里只有 `provPos` 的质心 x；
   * 连通域成员一定相邻，故「最左那块」与「最右那块」之差即其跨度。
   * 注意：这一段的点是聚合过的（`tid: null`），后面那道闸查不了，
   * 所以必须在建点时就判，判完挂在 `_pt.cross` 上。
   * 注意：只给水标 —— 范围就是水域，荒地那条不动。
   * 注意：跨度一次扫出来。若每组都用 `_crossOf(c)` 把全图 pid 扫一遍
   * （EU5 几千个水 / 荒地组 × 4 万格 = 上千万次），代价过高；
   * 现先 O(n) 一趟收每个组的 min/max x，之后每组 O(1)。
   */
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
      /*
       * 注意：不要给面积铺下限。若写 `Math.max(a.w, 6000)` 让小湖看得见，小湖的字号会跟大湖一个样
       * （马尔马拉海才 6 像素却按 6000 算，字号 14px，比它整片海还大）。
       * 现在字号由真实面积算出，小的就该小
       * （想让小水域也看得清应调 `_fontSize` 的 `FONT_RATIO`，不是在此造假面积）。
       */
      area: c.area,
      /*
       * tier 不可给 0。`drawPoints` 里每个点按自己那一层过缩放门槛（`open`）：
       * 第 0 层是「国家 / 剧本层」，门槛最高
       * → 给 0 等于把海名锁到最深缩放下才显示，平时一个都看不见。
       * 海名点不属于任何头衔，不应吃任何一层的门槛，
       * 所以给一个层表之外的号（99）：`zoom[99]` 是 undefined，
       * `open` 里 `n == null` 直接放行（比改 drawPoints 安全，那函数别人也在用）。
       */
      tier: 99,
    };
    /*
     * 荒地那一组多一个标记（drawLabels 按它挑「荒地 · 名称」还是「水域 · 名称」）。
     * 注意：CK3 没有荒地名表 → 上面名字那一步取不到 → 因而不会有荒地标
     * （CK3 不给荒地和水域标名字）。
     */
    if (g.waste) _pt.waste = true;
    /*
     * 横跨左右的水点：挂个标记，名字一个都不出。
     * 只给水标是刻意为之 —— 适用范围就是水域，荒地那条不动。
     * 判据在 `_crossOf(c)` 里（拿成员地块的 x 跨度，见上面那段）。
     */
    if (!g.waste && _crossOf(c)) _pt.cross = true;
    out.push(_pt);
  }
  return out;
}

/**
 * 分块地图的「粗省份图」。
 * 原尺寸那张图（16384×8192）是切成 4×4 块的：`state.provinceIds` 只有一个
 * 占位元素 → 排版器拿不到整张省份图 → `setRealmMask` 判成 null → 一个名字都排不出来。
 * 这里把每块解出来、按 cell 抽稀拼成一张粗图（1/8 = 2048×1024 ≈ 4MB），
 * 排版器只要「哪个像素属于哪个省」，抽稀后的精度对找基线完全够用。
 * 成本：16 块全解一遍 ≈ 2~4 秒（跟加载别的重活一个量级），
 * 所以放在「就绪」之后、逐块让出主线程，画面照常跑。
 * 内存：每解一块就清一次分块缓存，峰值只有一块（16.8MB）。
 */
async function buildTiledRealmMask(cell = 8) {
  const m = state.tiles;
  const map = state.tileMap;
  if (!m || !map) return null;
  /* // 清单字段不对就不执行：字段异常时 NaN 会算出空循环 / 死循环 */
  if (!(m.mapW > 0) || !(m.mapH > 0) || !(m.tileW > 0) || !(m.tileH > 0)
      || !(m.cols > 0) || !(m.rows > 0)) return null;
  const cw = Math.ceil(m.mapW / cell), ch = Math.ceil(m.mapH / cell);
  const ids = new Uint16Array(cw * ch);
  const tw = m.tileW, th = m.tileH;
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      let tile = null;
      try { tile = await map.get(r, c); } catch (e) { tile = null; }   // 缺一块就算了
      if (tile) {
        for (let y = 0; y < th; y += cell) {
          const gy = (r * th + y) / cell | 0;
          if (gy >= ch) break;
          const row = y * tw, out = gy * cw;
          for (let x = 0; x < tw; x += cell) {
            const gx = (c * tw + x) / cell | 0;
            if (gx >= cw) break;
            ids[out + gx] = tile[row + x];
          }
        }
      }
      if (map.cache && map.cache.clear) map.cache.clear();   // 峰值内存只留一块
      await nextTick();
    }
  }
  return { ids, width: cw, height: ch };
}

/**
 * 开局把地名排版整层算一遍（这些是定死的，不用每帧重算）。
 * 为什么能这么干：排版只跟（层 / 头衔 / 文字 / 字体 / 用户字号）有关，
 * 跟缩放、相机位置都无关，所以算一次就永远命中。
 * 为什么不能同步一次性算完：几万个名字 × 0.1ms 会把「就绪」卡住好几秒，
 * → 切成每段 12ms 的小块让出主线程，画面照常跑。
 * 换字体 / 调字号会让缓存整份作废（见 `clearLayouts`）→ 下次绘制再懒算。
 */
/*
 * 让出主线程的方式：MessageChannel 优先（~0ms 宏任务），setTimeout 兜底
 * —— 见函数尾部的说明（setTimeout 嵌套钳 4ms 的问题）。信道要懒建 + unref（实测）：
 * · 模块求值就 `new MessageChannel` 的话，Node 端所有「拍平执行本文件」的
 *   工具（check_standalone / test_modes / perf_*）进程永远退不出去
 *   —— port 句柄把事件循环钉住了 → 首次用到才建；
 * · 就算建了，Node 里也要 `unref`：只送消息、不为它留住进程
 *   （浏览器没有 unref，try/catch 兜住）。
 */
let _prewarmYield = null;
function _makePrewarmYield() {
  if (typeof MessageChannel === 'undefined') return (f) => setTimeout(f, 0);
  const mc = new MessageChannel();
  let _pend = null;
  mc.port1.onmessage = () => { const f = _pend; _pend = null; if (f) f(); };
  /* unref 必须在挂上 onmessage 之后 —— Node 里挂监听（启动 port）会
 * 重新 ref 先 unref 后挂监听 = 白做，进程照样退不出去（实测）
 * 之后的 postMessage 不会重新 ref （实测连发 7 条照样自然退出）*/
  try {
    if (mc.port1 && mc.port1.unref) mc.port1.unref();
    if (mc.port2 && mc.port2.unref) mc.port2.unref();
  } catch (e) { /* 浏览器没有 unref */ }
  return (f) => { if (_pend) { setTimeout(f, 0); return; } _pend = f; mc.port2.postMessage(0); };
}

function prewarmMapNameLayouts() {
  if (typeof labels === 'undefined' || !labels || !labels.realmMask || !labels.realmMask.usable) return;
  const mode = (state.set && state.set.mapNameFit) || 'both';
  if (mode === 'off') return;
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  if (!state.meta || !(state.meta.tierNames)) return;
  const nTier = (state.meta.tierNames || []).length;
  const t0 = performance.now();
  let tier = 0, pts = null, idx = 0, kind = 'place', warmed = 0;

  /* 先暖国名色块（数量少、但每一块都是一个大名字）——
 * 它们的位置来自涂色块的分组，跟地名不是一套几何 */
  try {
    const blocks = paintedPoints(true) || [];
    for (const b of blocks) {
      /* 必须带上 `layer: 2` —— 画的时候那批点就是第 2 层（国名）
 * 少了它就会按"头衔版图"去排（用的是另一套几何），白算一场 */
      labels.warmPoint(Object.assign({}, b, { layer: 2 }), 'power');
      warmed++;
    }
  } catch (e) { /* 没涂色数据就算了 */ }

  const chunk = () => {
    /*
     * 预热出任何错都只当作「没预热」。
     * 这是启动后跑在 setTimeout 里的后台活 —— 一旦抛出去就是「未捕获错误」，
     * 全局兜底会弹报错面板，看起来就像启动失败。
     * 它只是提速手段：失败即停。
     */
    try {
    const start = performance.now();
    while (performance.now() - start < 12) {
      if (!pts) {
        if (tier >= nTier) {
          LOG.event('版图贴合预热', `${warmed} 个名字 · ${(performance.now() - t0).toFixed(0)}ms`);
          return;
        }
        kind = tier < nEra ? 'power' : 'place';
        if (kind === 'place' && mode !== 'both') { tier++; continue; }
        /* 单层出问题就跳过这一层，不要中断整轮预热。 */
        try { pts = placePointsFor(tier) || []; } catch (e) { pts = []; }
        idx = 0;
        if (!pts.length) { pts = null; tier++; continue; }
      }
      if (idx >= pts.length) { pts = null; tier++; continue; }
      labels.warmPoint(pts[idx++], kind);
      warmed++;
    }
    } catch (e) {
      LOG.event('版图预热中止', String((e && e.message) || e));
      return;                       // 停在这儿，不再排队 地图照常用
    }
    /*
     * 不用 `setTimeout(chunk, 0)` 排下一块 —— 浏览器对嵌套 5 层之后的
     * setTimeout 一律钳到 ~4ms，预热几百个小块就白等一两秒墙钟。
     * MessageChannel 的让出是 ~0ms 的宏任务，照样给渲染 / 输入让路；
     * 没有它的环境（测试桩 / 老浏览器）退回 setTimeout。
     * （实测：CK3 开图要等预热冷却 4.5s，白等的墙钟占一截。）
     */
    (_prewarmYield || (_prewarmYield = _makePrewarmYield()))(chunk);
  };
  chunk();
}

/**
 * 色块名字的点（`{...block, tier:0, layer:2}` 的包装版）。
 *  若每帧对新数组里每个色块 spread 一次，一屏上百个、每帧都在造对象，代价高；
 *  色块只在涂色 / 换层时变化（`state._blockVer` 管着），故按版本缓存一份即可。
 */
/**
 * 水名 / 荒地名点的包装版（`{...p, tier}`）。
 * 同样是「每帧 spread 一次」的问题 —— 按（源数组，层）缓存，涂色 / 换层才重建。
 */
function seaLabelPoint(p, tier) {
  let c = state._seaPtCache;
  if (!c || c.src !== state.seaLabelPoints || c.tier !== tier) {
    c = state._seaPtCache = { src: state.seaLabelPoints, tier, map: new Map() };
  }
  let q = c.map.get(p);
  if (!q) { q = Object.assign({}, p, { tier }); c.map.set(p, q); }
  return q;
}

function blockLabelPoints() {
  const ver = state._blockVer | 0;
  if (state._blockPts && state._blockPtsVer === ver) return state._blockPts;
  const src = paintedPoints(true) || [];
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Object.assign({}, src[i], { tier: 0, layer: 2 });
  state._blockPts = out;
  state._blockPtsVer = ver;
  return out;
}

/**
 * 视口内的地名点（空间分桶，性能）。
 *  若每帧都把这一层所有点扫一遍（CK3 最细层上万、VIC3 四万），
 *  只为挑出屏幕里那几百个，等于一帧一次全表扫描。
 *  现按 512px 分桶，只取视口覆盖的那几桶，再按面积降序排一下
 *  （顺序与全量扫描一致，上限截断时留下的仍是最大的那几块）。
 *  分桶表按（层，kept 数组身份）缓存：换层 / 涂色把它换成新数组时自然重建。
 */
let _ppOut = null;            // `placePointsInView` 的复用数组（见函数里的注释）
let _ppBusy = false;          // 这个复用数组正在被外面用着（嵌套调用时让里层另开一个）
function placePointsInView(tier, view, pad) {
  const kept = placePointsFor(tier);
  if (!kept || !kept.length) return kept;
  /*
   * 注意：分桶已取消，改为一趟线性扫（实测）。分桶方案：512px 分桶（每帧 900 多次拼串 + Map 查）
   * + 把命中的点全塞进新数组 + 再全量 sort 一次还原面积降序。
   * 量测（2.3 万个点，Node 微基准 `tools/_bench_viewpts.js`）：
   * 整图 2.95ms → 0.26ms；半图 2.84 → 0.25；近景 1.57 → 0.05；特写 0.99 → 0.03。
   * 大头不是查桶，是每帧对上千上万个点做比较器排序。
   * 关键事实：`kept` 本就是 `buildPlaceComponents` 出来的面积降序
   * （见 `placePointsFor` 里「all 已按面积降序」），
   * → 顺序扫过去，命中的点天然仍是降序，无需排序。
   * 注意：分桶返回的是「整格」（格子与视口相交就整格都给），点还要靠调用方
   * `_inView` 再筛一道；现为逐点精确筛，最终集合与分桶方案一致
   * （调用方那道 `_inView` 留着当保险）。
   * 注意：不要把 pad 直接删了当优化 —— 它是给「锚点在视口外、字伸进来」那些名字留的余量。
   */
  const x0 = view.x - pad, x1 = view.x + view.w + pad;
  const y0 = view.y - pad, y1 = view.y + view.h + pad;
  /*
   * 结果数组跨帧复用。
   * 半图视角一帧捞 2950 个点 —— 每帧新造一个 24KB 数组 + 十几次扩容，纯 GC 压力。
   * 只有一个调用点（`drawLabels` 的 ① 那段，`for...of` 当场用完），
   * 不往外传、不跨帧留着 → 复用安全。
   * 不要把这数组接到别处去：谁把它存下来，谁就会看到下一帧的内容被改掉。
   * 万一哪天真嵌套了（① 循环里有人加了一句会回头调 `drawLabels` 的代码），
   * 里层会把共享数组清空、外层的 `for...of` 少挑一半点 —— 所以留了 `_ppBusy`：
   * 发现「上一层的还没用完」就另开一个数组给它（多一次分配，换一个不会出错的实现）。
   * 注意这个标志必须靠 try/finally 收回（中途 throw 也不会永久卡在 busy 上）。
   */
  const mine = !_ppBusy;
  const out = mine ? (_ppOut || (_ppOut = [])) : [];
  if (mine) _ppBusy = true;
  try {
    out.length = 0;
    for (let i = 0; i < kept.length; i++) {
      const p = kept[i];
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push(p);
    }
    return out;
  } finally {
    if (mine) _ppBusy = false;
  }
}

/*
 * 判断这个标签点是否算「水域」（给「水域 · 名称」那个闸用）。
 * 注意：两道判据，顺序不能反（实测）：
 * ① 键先说：`isWaterKey(键)` —— `#sea` / `#lake` / `#river` / `#impassable_sea`，
 * CK3/CK2/EU4/HOI4 的水片键都长这样；
 * ② 键说不出话（EU5 那种不带 `#` 的）→ 问现成的 `kindOfTid(tid)`
 * （内部走 `kindTidMap` + 老包退回键）。
 * 注意：为什么不能只留 ②：实测 CK3 有 2 块地（pid 1080 / 1088），
 * 键是 `#lake_k_83` / `#lake_b_308`（明摆着是湖），可 `kindMask` 给的是 6（不可通行陆地）。
 * 根因在构建期：`kind_mask` 按 `KIND_CODES` 的次序填，
 * `#impassable` 排在 `#lake` 后面 → 同时落进两类的省被覆写成 6；
 * → 只按身份标判就会把这 2 块湖算成陆地（关掉水名还剩 2 个湖名），而键自己就先说了答案。
 * 注意：反过来只留 ① 也不行：EU5 的键一块水都认不出来（实测 0 块）。
 * 注意：判据收在这一处，不要在调用点各写一遍。
 * 注意：6 = 不可通行陆地，属荒地那一侧，不算水（5 = 不可通行海域算）。
 * 注意：本函数已从 `drawLabels` 提到模块级，`labelClassAt` 也要用它
 * （作为局部函数时，缓存表挪出去之后就够不着了）。
 */
function _isWaterLabel(tid, key) {
  if (isWaterKey(key)) return true;
  if (tid == null || tid < 0) return false;
  const k = kindOfTid(tid);
  return k >= 2 && k <= 5;
}

/*
 * 「这个头衔属于哪一类名字」逐帧重算是无效开销。
 * `drawLabels` 的 ① 那段对视口里每一个点都要判一遍：
 * · `_isWaterLabel` → `isWaterKey(键)` + `kindOfTid(tid)`（后者还要查 Map）
 * · `isWasteOrWaterTid(tid)`（又查一遍 `meta.wasteland`）
 * · `labelZoneOf(键, tid)` → `keyStarts` 一串（`#impassable` / `wl_` / `#river` ...
 *   每个点都好几次 `indexOf` 前缀比对）+ `nameShown` 查表
 * · 名字取两遍、`isPseudoCategoryName` 再过一遍
 * 可这些全都只跟 tid 有关，跟视口、跟开关、跟这一帧画到哪一格一点关系都没有。
 * CPU profiler 量出来（EU5 近景）：`keyStarts` 7.7% + `kindOfTid` 5.1% +
 * `isWasteOrWaterTid` 2.6% + `kindByKey` 2.6% ≈ 一帧 18% 都在算同一个答案。
 * → 收成一张按 tid 打标的位表（下面是那几位的意思），用到才填（懒填）：
 * 只在视口里出现过的 tid 会被算，不是一上来把 4 万个头衔全过一遍
 * （一次性全过 = 换图 / 改名时白卡几十毫秒，正是本轮优化针对的负载）。
 * 作废条件必须一个不漏（少一个 = 名字串台 / 水陆判错）：
 * 键表换身份、`numTitles` 变、`_nameVer` 变（改名）、`crossSeamTids` 换身份
 * —— 用 `gen` 号挡：作废就把 gen+1，旧标记自然全部失效（不用清数组）。
 * 开关（水名 / 荒地名 / 地块名 / 缩放门槛）不进这张表 ——
 * 那些每帧都在变，留在调用处判；表里只放「跟 tid 绑死」的事实。
 */
const _LCLS_NONE = 0;
const _LCLS_WATER = 1;        // 水（海 / 湖 / 河 / 不可通行海域）
const _LCLS_WASTE = 2;        // 荒地（不可通行区域）
const _LCLS_CROSS = 4;        // 横跨左右接缝的水点 → 名字一个都不出
const _LCLS_ZONE = 8;         // 这一类的名字在本游戏里要显示（`NAME_POLICY`）
const _LCLS_NAME = 16;        // 名字本身能上屏（非空 / 非类别名 / 非 `#` 占位）

let _lcls = null;             // { n, gen, stamp:Int32Array, bits:Uint8Array, keys, seam, ver }

/** 这个头衔的名字类别（懒填 + 代际作废，见上面那段注释）
 *  @returns {number} `_LCLS_*` 的位组合 */
function labelClassAt(tid) {
  const T = state.titles;
  const n = ((state.meta && state.meta.numTitles) | 0) || ((T && T.keys && T.keys.length) | 0) || 1;
  const ver = state._nameVer | 0;
  const keys = (T && T.keys) || null;
  const seam = state.crossSeamTids || null;
  let c = _lcls;
  if (!c || c.n !== n) {
    c = _lcls = { n, gen: 1, stamp: new Int32Array(n), bits: new Uint8Array(n),
                  keys, seam, ver };
  } else if (c.keys !== keys || c.seam !== seam || c.ver !== ver) {
    /* 换图 / 改名 / 接缝表重建 → 整张表作废 （不清数组，只翻代际号）*/
    c.keys = keys;
    c.seam = seam;
    c.ver = ver;
    c.gen++;
    if (c.gen >= 2147483000) { c.stamp.fill(0); c.gen = 1; }
  }
  if (tid == null || tid < 0 || tid >= n) return _LCLS_NONE;
  if (c.stamp[tid] === c.gen) return c.bits[tid];      // 命中：一次 Int32 读
  let b = _LCLS_NONE;
  const K = keys || [];
  const key = String(K[tid] || '');
  const isWater = _isWaterLabel(tid, key);
  const isWaste = !isWater && isWasteOrWaterTid(tid) === 'waste';
  if (isWater) b |= _LCLS_WATER;
  else if (isWaste) b |= _LCLS_WASTE;
  if (isWater && seam && seam.has(tid)) b |= _LCLS_CROSS;
  if (nameShown(labelZoneOf(key, tid))) b |= _LCLS_ZONE;
  const nm = String(((T && T.names && T.names[tid]) || ''));
  if (nm && !isPseudoCategoryName(nm) && !((b & (_LCLS_WATER | _LCLS_WASTE)) && nm.startsWith('#'))) {
    b |= _LCLS_NAME;
  }
  c.stamp[tid] = c.gen;
  c.bits[tid] = b;
  return b;
}

function drawLabels(view, capture = false) {
  /*
   * 「够不够格画」那道闸用的缩放，得拿这一帧的视口算。
   * `labels.scale` 只在 `drawPoints → _begin` 里更新 —— 而那一层要是被闸掉了，
   * `drawPoints` 根本不会被调 → scale 就冻在「关闸那一刻」的值上。
   * 一帧从 100% 直接跳到 20%（整图按钮 / 触控板一把捏到底 / 面板里的缩放档）：
   * · 那一帧闸是开的（scale 还是 1.0）→ 画完 scale 变成 0.2；
   * · 之后每帧都拿 0.2 比门槛 → 闸永远关着 → 再放大也不回来。
   * → 屏幕上地名从此消失，即「停手后地名缺失」最容易翻车的形态。
   * （实测：`tools/_bench_zoomfw.js` 的 SCALES 改成 [0.20, 0.30, 0.58…] 起手，
   * 不修的话 58% 那档也是 0 个点；修完 20/30% 该关就关、58% 起恢复正常。）
   * 现在每帧先按视口把 scale 对齐一遍，式子跟 `_begin` 里那句一字不差。
   * 导出的 capture 那一路别动 —— `paintExport` 自己换 scale 再还回去，
   * 这里抢着改会把它那份参考视口的缩放冲掉。
   * 也不要改成「只在 scale 变大时才更新」：缩小时也得跟着掉，否则门槛成了摆设。
   */
  if (!capture && view && view.w > 0 && labels.cssW > 0) {
    const _sc = labels.cssW / view.w;
    if (labels.scale !== _sc) labels.scale = _sc;
  }
  /*
   * 视口粗筛：内联判断，不再 filter 出新数组（每帧一次 1 万多元素的 filter
   * + 新数组，纯 GC 压力）。边距跟 `drawPoints` 里那套一致。
   */
  const _padC = Math.max(64, 900 / labels.scale);
  /*
   * 那道 `_inView` 闭包已删。
   * 它判的框跟 `placePointsInView(tier, view, _padC)` 用的是同一个 pad、同一套边界
   * —— 分桶取消之后，取点已经是逐点精确筛了（见那个函数上的注释），
   * → 这一道只是把同一件事再做一遍，一帧 2950 次闭包调用纯属重复开销。
   * 不要反过来理解：取点那边的 pad 不能删，它是给「锚点在视口外、
   * 字伸进来」的那些名字留的（框要留着，只是不用判两遍）。
   */
  const _listT0 = performance.now();
  PERF.S.listMs = -1;       // 裸值槽：这一帧这段还没量到就是 -1（mark 进 S.list 的是 EMA，自测要真值）
  labels.showAll = false;   // 「显示全部地名」那个开关删了 —— 一律按字号门槛来
  // 顺序就是叠放顺序：原版地名先画、玩家地名后画 ——
  // 两套名字重叠时，玩家的那个压在上面（同一个画布，后画的在上层）。
  const list = [];
  // 势力名和地名分开管：剧本/年份那几层算势力名，地区/省份/地点那些算地名。
  // 两个开关默认都开，想看干净的版图可以单独关掉一个。
  // 取名字用的是编辑层（editTier）：没换粒度时它等于视图层，换了粒度才分叉。
  // 这样"看 1444 的配色、粒度设成省份"时，出来的是省名（勾「地名」就显示），
  // 而不是被当成势力名、点了没反应。
  // 没有年代层就没有势力名（CK3）：用 `|| 1` 兜底会把帝国层当成势力名、
  // 又画一遍同样的名字，导致关「地名」看起来没有反应。
  const nEra = (state.meta.eraDates && state.meta.eraDates.length) || 0;
  const viewTier = state.tier;
  const isCountryView = viewTier < nEra;
  /*
   * 这层名字用哪一层的门槛（普通地名 / 水名 / 荒地名同一个值；
   * 剧本层就是 editTier，地理层就是视图层）—— ②′ 那段水名点也用它。
   * 规定：作为地名，缩放到何比例才显示是统一的。
   */
  const nameTier = isCountryView ? editTier() : viewTier;

  /*
   * 哪些头衔「是水」（「水域 · 名称」那个闸的判据）。
   * 注意：判据不能只看键名：
   * `isWaterKey` 只认 `#` 开头的伪头衔 —— CK3 / CK2 的水是 `#sea_b_2218`，认得出；
   * 但 EU5 的水键不带 `#`（`chukchi_sea` / `siberian_lakes_1`）→ 全认成陆地。
   * 实测：EU5 关掉水名开关之后还剩 5709 个水名点（开关失效）。
   * → 正解是走认水的唯一出处 `waterKindByPid`（身份标最权威 → 老包退回 `#` 键），
   * 与「水域 · 边界」那张纹理同源，两个开关不会各认一套。
   * 注意：不要自建 tid 集合。若改为 `state.waterKindSet`（`buildWaterKindMask` 里收 tid 并集），
   * 理由是「标签点只有 `tid`，而认水是按 pid 问的」，
   * 但项目里本就有按 tid 问的 `kindOfTid(tid)`：（走 `kindTidMap`：扫每一层 + 老包退回键前缀，
   * 且自带缓存 `state._kindMap`，换图按 `numTitles|kindMask长度` 作废），
   * 判据更全；此处直接调用现成接口。
   * 注意：纹理那张表（`state.waterKindArr`）仍然需要 —— 着色器逐像素、问不了 tid；
   * 两张表分工不变，只是「逐头衔」那一张改用现成接口。
   */
  /**
   * 这个标签点算不算「水域」（给「水域 · 名称」那个闸用）。
   * 两道，顺序不能反：
   * ① 键先说：`isWaterKey(键)` —— `#sea` / `#lake` / `#river` / `#impassable_sea`；
   *    CK3/CK2/EU4/HOI4 的水片键都长这样，一眼就是水。
   * ② 键说不出话（EU5 那种不带 `#` 的）→ 问现成的 `kindOfTid(tid)`
   *    （内部走 `kindTidMap()` + 老包退回键）。
   * 为什么不能只留 ②：实测 CK3 有 2 块地（pid 1080 / 1088）——
   *   键是 `#lake_k_83` / `#lake_b_308`（明摆着是湖），
   *   可 `kindMask` 给的是 6（不可通行陆地）。
   *   根因在构建期：`kind_mask()` 按 `KIND_CODES` 的次序填，
   *     `#impassable` 排在 `#lake` 后面 → 同时落进两类的省被覆写成 6。
   *   → 只按身份标判就会把这 2 块湖算成陆地（现象：关掉水名还剩 2 个湖名）；
   *   而键自己就先说了答案 —— 这也正是 `kindOfTid` 给老包留的那条退路的意思。
   * 反过来「只留 ①」也不行：EU5 的键一块水都认不出来（实测 0 块）。
   * 判据收在这一处 —— 不要在调用点各写一遍。
   * 6 = 不可通行陆地，属于荒地那一侧，不算水（5 = 不可通行海域，算）。
   */
  /*
   * `_isWaterLabel` 定义在模块级（`labelClassAt` 也要用）。
   * 这段长注释留在原位，说明那道判据的来历；函数体在上面。
   */

  // ① 地名（先入列 = 在下面）：勾了「地名」就画当前选中的那一层。
  /*
   * 「水域 · 名称」是独立一闸（见 handover §3.1）。
   * → 不能把这个 if 整个包住（包住 = 关掉「地区 · 名称」水名也没了）→ 下面按点分家：
   * · 水域那几类（这一层的键走 isWaterKey）→ 只听 state.showWaterName
   * · 其余（陆地 / 荒地）→ 与陆地路径一致，没有额外闸
   * 注意：河与湖算「水域」（海洋、湖泊、河流、不可通行海域四类），它们本就被 isWaterKey 收在内。
   * 注意：荒地（不可通行区域）也有自己的开关（见「显示」区的荒地名称行），
   * 独立于「地块 · 名称」。
   * 注意：「地块 · 名称」关着 + 「水域 · 名称」开着 → 只剩水名（两者互相独立）。
   * 注意：这一段里荒地 / 河那一批仍只听「地区 · 名称」：
   * 「水域」指海洋 / 湖泊 / 河流 / 不可通行海域 —— 河流算水域（isWaterKey 收着），
   * 荒地不算；故关掉「地区 · 名称」之后，河名仍随水名开关显示，
   * 荒地（不可通行区域）与陆地一起消失，它没有独立开关。
   */
  /*
   * · 地块名（陆地）→ 「地块 · 名称」
   * · 水那几类（海 / 湖 / 河 / 不可通行海域）→ 「水域 · 名称」
   * · 荒地 → 「荒地 · 名称」不能用一个 if 把整段包在「地块 · 名称」里 ——
   * 那样关掉地块名，水名 / 荒地名也会跟着没了（用户要的是各管各的）
   * 剧本层本身不算地名 —— 那一层是国家 / 势力，归 ③ 那套管；
   * 剧本层只放行"自己那个名称开关开着"的水 / 荒地
   */
  /*
   * 这一层还没到「该出现」的缩放，就不要凑名单了（性能）。
   * 名单是在 drawPoints 里按 `zoom[tier]` 逐点过闸的 ——
   * 可凑名单本身要扫全层（EU5 最细层 2.3 万点、CK3 1.2 万），
   * 结果全被闸掉，白扫一遍（实测 EU5 全图视角 11.6ms/帧）。
   * → 连门槛都还没到，直接跳过这一层；门槛值跟 drawPoints 用同一份 `labels.zoom`。
   */
  const _zoomNeed = (labels && labels.zoom) ? labels.zoom[nameTier] : null;
  const _zoomPct = (labels ? labels.scale : 1) * 100;
  /*
   * 导出抓名单时不按屏幕缩放过闸。
   * 导出自己的门槛按 1600px 参考视口算（见 `paintLabelsForExport`）——
   * 可这里要是先按手上这台设备的缩放把整层剔掉，第二道闸想放行也没东西可放；
   * → 同一张图在手机（竖屏 390 出头）和电脑（1600）上导出来的名字会不一样。
   * `capture` = 只抓名单、不画（整图导出那条路）→ 一律放行，交给 `paintExport` 按导出口径筛。
   */
  const _tierOpen = capture || (_zoomNeed == null) || (_zoomPct >= _zoomNeed);
  if (_tierOpen && (state.showLabelsTitle || state.showWaterName || state.showWasteName)
      && (nameTier >= nEra || state.showWaterName || state.showWasteName)) {
    const K = state.titles.keys || [];
    /*
     * 取点：一个连通域一个标（见 buildPlaceComponents）。
     * 按头衔取点时 `labels.pointsFor(nameTier)` 一个头衔只出一个标。
     */
    const _namesOfPlace = (state.titles && state.titles.names) || [];
    for (const q of placePointsInView(nameTier, view, _padC)) {
      /*
       * 跟 tid 绑死的那几项（水吗 / 荒地吗 / 横跨接缝吗 / 这一类出不出名 / 名字能上屏吗）
       * 一律走 `labelClassAt` 那张懒填位表（见上面那段注释）。
       * 若每个点都调 `kindOfTid` + `isWasteOrWaterTid` + `labelZoneOf`（一串 keyStarts）
       * + `nameShown` + 名字取两遍，一帧 18% 的开销都耗在重复算同一个答案上。
       * 注意：顺序变了但结果集合一致：这几位只与 tid 有关，
       * 与「先判名字还是先判开关」无关（每一步都是「不合格就丢」）。
       * 注意：开关和缩放门槛不进那张表 —— 它们每帧都在变（见 `labelClassAt` 注释）。
       */
      /*
       * 命中快路在此展开到调用点（实测：一帧 2950 次调用 → 0 次）。
       * `labelClassAt` 每次都要重读 `state.titles` / `meta.numTitles` / `_nameVer` /
       * `crossSeamTids`，再比三样才轮到「一次 Int32 读」，全摊到调用点来。
       * 判据必须跟 `labelClassAt` 里一模一样（n / gen / 下标越界），
       * 少一个就是名字串台；建表 / 换代 / 越界一律退回慢路（它会自己处理）。
       */
      const _c = _lcls;
      const _tid = q.tid;
      const _cls = (_c && _tid != null && _tid >= 0 && _tid < _c.n && _c.stamp[_tid] === _c.gen)
        ? _c.bits[_tid] : labelClassAt(_tid);
      if (!(_cls & _LCLS_NAME)) continue;         // 没名字 / 类别名 / `#` 占位名 → 不出字
      const _isWaterPt = (_cls & _LCLS_WATER) !== 0;
      const _isWastePt = (_cls & _LCLS_WASTE) !== 0;
      /*
       * 横跨左右的水地点：名字一个都不出。
       * `state.crossSeamTids` 里上层也收进来了（见 buildCrossSeamTids），
       * 所以这一句同时管住「它自己」和「它的上级」；只加水，陆地一个字不动。
       */
      if (_isWaterPt && (_cls & _LCLS_CROSS)) continue;
      // 剧本层只出水 / 荒地（且要各自开关开着）；陆地名归 ③ 那套势力名
      if (nameTier < nEra && !_isWaterPt && !_isWastePt) continue;
      /*
       * 一个名称开关管一类（判序：先水、再荒地、其余陆地）——
       * 注意：荒地独立于「地块 · 名称」，有自己的开关。
       */
      if (_isWaterPt ? !state.showWaterName
          : _isWastePt ? !state.showWasteName
          : !state.showLabelsTitle) continue;
      /* 游戏规则：哪一代出哪一类名（`NAME_POLICY` 那张表，表在 `labelClassAt` 里查过了）*/
      if (!(_cls & _LCLS_ZONE)) continue;
      q.name = _namesOfPlace[q.tid] || '';
      list.push(q);
    }
  }
  /*
   * ②′ 水域名单独一层。注意：这一段不能塞在上头那个 `if (nameTier >= nEra)` 里，
   * 它是独立一层的点。已统一：
   * · 「水域/荒地 · 名称」两个开关退役；
   * · 门槛也统一：点的 tier 用 nameTier —— `labels.drawPoints` 的
   * `open(p)` 拿 `zoom[nameTier]`，与普通地名同一个值
   * （若 tier=99 则恒显，会导致空白剧本也冒荒地名）；
   * · 剧本层（含空白）一个名字都不显示 —— 与普通地名同一道 gate：
   * `nameTier >= nEra`（普通地名在剧本层整层不画 → 水名/荒地名也不画）；
   * 注意：名单只受这个门 —— `buildSeaLabelPoints` 里扫的是最细层
   * （`labelTier` 没开粒度 = 最细层），它跟 nameTier 不是一个层，
   * 细层的荒地名顶着剧本层门槛冒出正是此因。
   */
  {
    /*
     * 只有 CK3 被排除 —— CK2 照常把水域名点推进名单里（独立模式，
     * 见 `pseudoNameAllowed`：CK2 给水与荒地标名）。
     * 按类别查表后，CK3 只出河流（海 / 湖 / 荒地都不出），故不能再整块 `if (!isCk3)` 一刀切。
     */
    /*
     * 注意：外闸也要带上荒地那一面旗。
     * 若闸为 `nameTier >= nEra && state.showLabelsTitle`，只勾「荒地 · 名称」时
     * 这一整段不会跑（勾了荒地名称却一个荒地名都不出，开关失效）。
     * → 荒地有自己的开关，只勾它时这一段也须执行；同理水那面旗也已计入外闸。
     */
    if (nameTier >= nEra
        && (state.showLabelsTitle || state.showWaterName || state.showWasteName)) {
      /* 一条一条按类别过 （`NAME_POLICY` 那张表）
 * `buildSeaLabelPoints` 聚出来的点带 `sea` 标记 但它分不出海 / 湖 / 河
 * （老包那边名字是从真名表取的，表里没类别）——
 * 所以按这一格自己的键判类别 跟 `drawLabels` 上面那条同一个口径 */
      const _K = state.titles.keys || [];
      for (const p of (state.seaLabelPoints || [])) {
        const _z = labelZoneOf(String(_K[p.tid] || ''), p.tid);
        if (!nameShown(_z)) continue;
        /*
         * 注意：水域的独立闸。这一段吐出来的点全是「没有片的老包」（有片的那批在上面
         * `if (_piece) continue;` 就让开了，走 ① 那条普通头衔路）；
         * 这批过不了 ①（① 只收 LabelLayer 认的「有头衔的点」，而它们 `tid: null`），
         * 故水名 / 荒地名各留一条路在此处。注意：「水域 · 名称」关着 → 带 sea 标记的点一个都不加
         * （水域名称开关负责且仅负责水域名称的显示或隐藏）。
         * 注意：荒地那些不归它（`sea: true` 水、`waste: true` 荒地，分开判；
         * 荒地看它自己那面旗 / 游戏规则）。注意：顺序为先过游戏规则那张表、再让开关说话；反过来会在
         * CK3 上「勾了水名开关就冒出「海洋」两个字」。
         */
        if (p.sea && !p.waste && !state.showWaterName) continue;
        /*
         * 横跨左右的水点：名字一个都不出。规则：一个属于水域的地点，其像素在左右两侧都有，
         * 则它自己的名字不显示，包含这个地点的上层水域的名字也不显示。
         * 动机：EU5 没切日期变更线，那几块横跨图宽的地会让名字的「中心」落到地图正中；
         * 与其把位置算法做复杂，不如让这类名字不显示。
         * 这个标记是 `buildSeaLabelPoints` 建点时判好的（该处的点是聚合过的、
         * `tid: null`，到这儿已经查不出它含哪些地块了）。
         * 「上层水域」也一起藏：`state.crossSeamTids` 里收了横跨地的每一层头衔，
         * 所以走 ① 那条「普通头衔」路的水片（含上级）由那句 `has(q.tid)` 挡掉。
         * 两条路各挡各的，合起来正好覆盖「它自己 + 它的上级」。
         */
        if (p.cross) continue;
        /*
         * 注意：荒地那一批听它自己那面旗。`buildSeaLabelPoints` 聚出来的荒地真名点带 `waste: true`，
         * 独立于「地块 · 名称」。
         */
        if (p.waste && !state.showWasteName) continue;
        list.push(seaLabelPoint(p, nameTier));
      }
    }
  }
  /*
   * ③ 色块名：最上层（半透明）。注意：一律归「势力名」那一档 ——
   * 剧本层上是原版国名 + 玩家涂出来的国；细层上是玩家涂的色块名，
   * 两者都算「势力名」，与真正的地名（`①` / `②′` 那两路）分开管。
   * → 给 `tier: 0`（最粗那层）就落进 `tier < nEra`，走「势力名称不透明度」。
   * 注意：不要挂 `fade` 标记把这批压进地名档 ——那样剧本层的国名会跟着「地名不透明度」走，
   * 「势力名称不透明度」滑条拖动无反应。
   */
  if (state.showLabelsPaint) {
    /*
     * 这里不需要额外标记。字号拆成「地块 / 势力」两块之后，看着好像得给这点标个「它属于哪一类」——
     * 不用：`layer: 2` 就是「玩家涂出来的色块名」这个身份，
     * `labels.js` 的 `_fontSize` 拿 `tier < nEra || layer === 2` 就分得清
     * （年份层那些国名走 `tier < nEra` 同一套判据，见 `_fontSize` 那段注释）。
     * → 在此加 `kind: 'power'` 属于新造字段，不需要。
     */
    for (const p of blockLabelPoints()) list.push(p);
  }
  PERF.S.listMs = performance.now() - _listT0;   // 裸值（自测用），EMA 那份走 mark
  PERF.mark('list', PERF.S.listMs);
  PERF.S.points = list.length;
  PERF.S.drawn = labels.drawn | 0;
  if (!list.length) {
    /* capture（导出抓名单）时不许清屏 —— 那会把屏幕上的名字抹掉 */
    if (!capture) labels.clear();
    return capture ? [] : undefined;
  }

  // 缩放门交给标签层按"每个点自己的层"判：
  // 头衔 / 地区 / 省份名 —— 按当前视图层的门槛；
  // 玩家色块名 —— 按第 0 层（国家那套），所以不用放大就能看见。
  /* `capture` = 只要名单、先别画（整图导出要按导出尺寸另画一遍 见 `paintLabelsForExport`）*/
  if (capture) return list;
  labels.drawPoints(list, view);
}

/*
 * 导出图例
 * 导出的图加一段图例 + 标题，发出去才像一张「图」。
 * · 条目自动来自涂出来的颜色分组（state.paintBlocks 名字用当前的显示名），
 *   同色算一组，取面积最大那一族的名字当组的名字；
 * · 名字就是地图上现在显示的那个（想改走「改名」工具），不想要的可以关掉（state.legendOn）；
 * · 面板在「设置」里；勾上之后「导出窗口 / 导出整图」都会画进去；
 * · 整图 9216 宽时字号会自动放大，不会小得像蚂蚁。
 */

/**
 * 当前该列进图例的条目
 *  两条规矩：
 *    ① 只列现在在图上涂出来的颜色 —— 一个颜色底下没有一块是涂过的，
 *       那是原版底色、不应进图例（若按「这一族整块多大」列，
 *       没涂过的国家、或只涂了一点的大国都会混进来）；
 *    ② 按涂出来的面积从大到小排，不按国家本身大小排。
 *  一点都没涂的图（例如「1789 年的欧洲」）→ 退回到「当前年份的全部国家」；
 *  此时没有涂色面积可比，按各自版图大小排。
 */
function legendEntries() {
  const paint = renderer && renderer.paintData;
  const pp = state.provPos;
  // 这一族里"被涂过"的地块，按像素数加起来 = 这个颜色在图上的实际大小
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
    // ① 有涂色时：没涂过的族一律不进图例 （那只是原版底色，不是"现在显示的东西"）
    if (anyPainted && pSize <= 0) continue;
    const rgb = b.rgb || [150, 150, 150];
    const key = rgb.join(',');
    // ② 排序用的"大小"：有涂色看涂出来的，没涂色看整块版图
    const size = anyPainted ? pSize : (b.area || 0);
    const hit = seen.get(key);
    if (!hit || size > hit.size) {
      seen.set(key, { key, rgb, size, area: b.area || 0, painted: pSize,
                      name: String(b.name), tid: b.tid });
    }
  }
  const _ordered = [...seen.values()]
    .sort((a, b) => b.size - a.size)
    .map((e) => {
      // 名字优先用图例自己的自定义名 （空串 / 纯空白 → 退回地图上现在的名字）
      const auto = e.name || '';
      const raw = state.legendNames && state.legendNames[e.key];
      const custom = raw == null ? '' : String(raw).trim();
      return {
        ...e,
        autoName: auto,
        customName: !!custom,
        name: custom || auto,
        on: !(state.legendOn && state.legendOn[e.key] === false),
      };
    });
  /*
   * 手动顺序优先（在图例列表里用 ↑↓ 排过的，存在 state.legendOrder）。
   * 排过的按排定次序走；没排过的（比如刚涂出来的一族）接在后面按大小走，
   * 否则手动排一次就会把新来的条目挤没。
   */
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
 * 按「现在这一刻」的视图重算色块，然后刷图例列表。
 * 为什么：色块分组（state.paintBlocks）是「跟当前剧本 / 层级」绑定的，
 * 而它是上一帧算的 —— 换剧本、打开设置的时候那一帧可能还没轮到；
 * 只刷列表就会把上一个剧本的条目列出来。所以：先把欠着的那次重算补上，再列。
 * 导出图例走的是同一套（见 maybeDrawLegend），两边口径一致。
 */
function freshPaintBlocks() {
  if (!blocksDirty) return;
  try {
    rebuildPaintBlocks(!!state._blocksAll);
    blocksDirty = false;
    labelDirty = true;
  } catch (e) { /* 出错就按现有的数据来，不要把界面打断。 */ }
}

/** 打开设置那一栏用的：先补算色块，再刷列表 */
function legendFresh() {
  freshPaintBlocks();
  rebuildLegendPanel();
  refreshLegendFonts().catch(() => { /* 字体库读不出来也照样显示图例 */ });
  scheduleLegendOverlay();
}

/** 面板底部那句说明：把「为什么灰了 / 为什么没东西」说清楚。 */
function _legendNoteText(rows, shown) {
  const s = state.set || {};
  if (!s.legend) return rows ? '图例已关闭' : '';
  if (s.legendTitleOnly) {
    return String(s.legendTitle || '').trim() ? '只显示标题' : '只显示标题，但标题是空的';
  }
  if (!rows) return '';
  const off = Math.max(0, rows - (shown == null ? rows : shown));
  if (shown === 0 && rows > 0) return '共 ' + rows + ' 条，已全部关闭';
  return '共 ' + rows + ' 条' + (off ? '，已关闭 ' + off + ' 条' : '');
}

function _legendRefreshNote() {
  const cnt = $('legend-count');
  const box = $('legend-list');
  if (!cnt) return;
  const rows = box ? box.querySelectorAll('.legend-row').length : 0;
  const boxes = box ? [...box.querySelectorAll('.legend-on')] : [];
  const shown = boxes.filter((b) => b.checked).length;
  cnt.textContent = _legendNoteText(rows, shown);
}

/** 互相关联的控件：不生效的时候置灰，避免对着改了没反应的框。 */
function _legendSyncLinkage() {
  const s = state.set || {};
  const titleOnly = !!s.legendTitleOnly;
  const box = $('legend-list');
  if (box) box.classList.toggle('is-off', titleOnly);
  for (const id of ['legend-sort', 'legend-reset-names']) {
    const b = $(id);
    if (b) b.disabled = titleOnly;
  }
  const reset = $('legend-reset-names');
  if (reset) {
    const hasCustom = !!(state.legendNames && Object.keys(state.legendNames).length);
    reset.disabled = titleOnly || !hasCustom;
  }
  const fg = $('set-legend-fg');
  if (fg) {
    fg.disabled = !!s.legendFgAuto;
  }
}

/** 把设置页里的图例列表刷一遍（打开设置、涂完色都该刷） */
function rebuildLegendPanel() {
  const box = $('legend-list');
  if (!box) return;
  const list = legendEntries();
  if (!list.length) {
    /*
     * 一条都没有：说清楚为什么空。仅 display:none 时，首次打开这一页只会看到一片空白，
     * 既不知道条目从哪来，也不知道涂个色就会有。
     */
    box.style.display = '';
    box.innerHTML = '<div class="legend-empty" role="note">还没有条目</div>';
    _legendSyncLinkage();
    const emptyCnt = $('legend-count');
    if (emptyCnt) emptyCnt.textContent = _legendNoteText(0);
    return;
  }
  box.style.display = '';
  const cnt = $('legend-count');
  if (cnt) cnt.textContent = _legendNoteText(list.length, list.filter((e) => e.on).length);
  // 名字的 HTML 转义（就地在模板里拼，避免 & < > " 把结构破了）
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  box.innerHTML = list.map((e, i) => {
    const nm = esc(e.name);
    return '<div class="legend-row" role="listitem" data-key="' + esc(e.key) + '">'
      + '<input type="checkbox" class="legend-on" aria-label="在图例里显示「' + nm + '」"'
      + (e.on ? ' checked' : '') + '>'
      + '<span class="legend-sw" aria-hidden="true" style="background:' + _hexOf(e.rgb) + '"></span>'
      // 名字可编辑 （留空 = 用自动名）
      + '<input type="text" class="legend-name" maxlength="60" spellcheck="false"'
      + ' aria-label="「' + nm + '」的图例名，留空用自动名"'
      + ' value="' + esc(e.customName ? e.name : '') + '" placeholder="' + esc(e.autoName) + '"'
      + '>'
      + '<span class="legend-move">'
      +   '<button type="button" class="legend-up" aria-label="上移「' + nm + '」"'
      +     (i === 0 ? ' disabled' : '') + '>▲</button>'
      +   '<button type="button" class="legend-down" aria-label="下移「' + nm + '」"'
      +     (i === list.length - 1 ? ' disabled' : '') + '>▼</button>'
      + '</span>'
      + '<span class="legend-drag" aria-hidden="true">⠿</span>'
      + '</div>';
  }).join('');
  _legendSyncLinkage();
  let dragRow = null;      // 正在拖的那一行（拖动排序用 一次只可能有一行）

  /** 拖动中：看指针掠过哪一行，就把拖的那行插到它前 / 后（事件挂在 window 上，见下面说明） */
  const onLegendDragMove = (ev) => {
    if (!dragRow) return;
    ev.preventDefault();
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = over && over.closest ? over.closest('.legend-row') : null;
    if (!target || target === dragRow || !box.contains(target)) return;
    // 指针在目标行的上半 → 插到它前面；下半 → 插到它后面
    const r = target.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    box.insertBefore(dragRow, after ? target.nextSibling : target);
  };

  /** 松手 / 被系统打断：收尾，顺序存下来，那一行立刻恢复原样 */
  const endLegendDrag = () => {
    window.removeEventListener('pointermove', onLegendDragMove);
    window.removeEventListener('pointerup', endLegendDrag);
    window.removeEventListener('pointercancel', endLegendDrag);
    try { document.body.style.userSelect = ''; } catch (e) { /* */ }
    if (!dragRow) return;
    dragRow.classList.remove('dragging');   // 立刻取消变暗（否则放开后一直暗着）
    dragRow = null;
    // 松手这一刻的 DOM 顺序就是新顺序 存下来
    const keys = [...box.querySelectorAll('.legend-row')]
      .map((r2) => r2.getAttribute('data-key')).filter((k) => k != null);
    if (keys.length) { state.legendOrder = keys; scheduleSave(); }
    rebuildLegendPanel();                   // 重建一遍：变暗状态、箭头灰亮、上下边界全对上
  };

  for (const row of box.querySelectorAll('.legend-row')) {
    const key = row.dataset ? row.dataset.key : row.getAttribute('data-key');
    const on = row.querySelector('.legend-on');
    /* 顺序调整：点一下换一格
 * 把当前看到的顺序整条存进 state.legendOrder （含没手动排过的）
 * 这样后面再排、以及导出图例，都按这个顺序走 */
    const move = (dir) => {
      const keys = legendEntries().map((e) => e.key);
      const i = keys.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= keys.length) return;
      const tmp = keys[i]; keys[i] = keys[j]; keys[j] = tmp;
      state.legendOrder = keys;
      legendFresh();     // 先补算色块再列 不然列的是上一个剧本的 // 立刻重排
      scheduleSave();
    };
    const up = row.querySelector('.legend-up');
    const down = row.querySelector('.legend-down');
    if (up) up.addEventListener('click', () => move(-1));
    if (down) down.addEventListener('click', () => move(1));

    /*
     * 按住拖动排序（除了上面那对小箭头，多一种排序方式）。
     * 用 Pointer Events 一套通吃鼠标和手指（HTML5 那套 draggable 在手机上不能用）。
     * 拖动时直接挪 DOM：手指掠过哪一行就插到它前 / 后面，松手才写 state。
     * 事件挂在 window 上，不挂在把手上 —— 已知问题：
     * 把手挂 pointer capture 的话，拖到一半把整行 insertBefore 挪走，
     * 而 DOM 规范里「移动节点」是先摘下来再插回去 → capture 当场失效，
     * 于是后面的 pointerup 收不到 → finish 不跑 → 那一行一直暗着
     * （现象：放开不会变回来，还需再按一下把手）。
     */
    const dragGrip = row.querySelector('.legend-drag');
    if (dragGrip) {
      dragGrip.addEventListener('pointerdown', (ev) => {
        if (dragRow) return;                // 一次只拖一行
        ev.preventDefault();                // 避免变成选文字 / 滚页面
        dragRow = row;
        row.classList.add('dragging');
        try { document.body.style.userSelect = 'none'; } catch (e) { /* 忽略 */ }
        window.addEventListener('pointermove', onLegendDragMove, { passive: false });
        window.addEventListener('pointerup', endLegendDrag);
        window.addEventListener('pointercancel', endLegendDrag);
      });
    }
    if (on) on.addEventListener('change', () => {
      state.legendOn = state.legendOn || {};
      state.legendOn[key] = on.checked;
      _legendRefreshNote();
      scheduleLegendOverlay();
      scheduleSave();
    });
    // 此处只影响图例显示名，不改变地图上的正式地名
    const nameInput = row.querySelector('.legend-name');
    if (nameInput) nameInput.addEventListener('input', () => {
      state.legendNames = state.legendNames || {};
      const v = String(nameInput.value || '').trim();
      if (v) state.legendNames[key] = nameInput.value;
      else delete state.legendNames[key];
      _legendSyncLinkage();   // 首个自定义名写入后需立即启用「恢复自动名」
      scheduleLegendOverlay();
      scheduleSave();
    });
    if (nameInput) nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); nameInput.blur(); }
      ev.stopPropagation();
    });
  }
}

/**
 * 图例的排版与绘制（统一实现）
 * 地图预览、导出、设置面板共用同一套；预览只更换画布与字号基准。
 */
const LEGEND_FONTS = {
  sans: '"Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,sans-serif',
  song: '"Songti SC","SimSun","Noto Serif SC",serif',
  kai: '"Kaiti SC","KaiTi","STKaiti","Noto Serif SC",serif',
  mono: '"Cascadia Mono","Consolas","Noto Sans Mono",monospace',
};
const LEGEND_SIZE_FACTOR = { s: 0.78, m: 1, l: 1.24, xl: 1.5 };

/* 图例字体：默认字体 + 本地字体库
 * 字体库存放的是「钥匙」：TTF 存族名，位图存 bm:<id>；早期存档中的
 * sans/song/kai/mono 仍可绘制（LEGEND_FONTS 兜底），下拉里只列默认与已导入字体。 */
let _legendFontList = [];
function _legendFontKey(f) {
  return f.kind === 'bitmap' ? 'bm:' + f.id : fontLibFamily(f.id);
}
function _legendFontSpec(key) {
  const raw = String(key || '');
  if (!raw || LEGEND_FONTS[raw]) {
    return { key: raw, css: LEGEND_FONTS[raw] || LEGEND_FONTS.sans, bitmap: null, imported: false, kind: 'system', name: '' };
  }
  const f = _legendFontList.find((x) => _legendFontKey(x) === raw);
  if (!f) return { key: '', css: LEGEND_FONTS.sans, bitmap: null, imported: false, kind: 'system', name: '' };
  if (f.kind === 'bitmap') {
    const bm = _bmFontCache.get(f.id) || null;
    return { key: raw, css: LEGEND_FONTS.sans, bitmap: bm, imported: true, kind: 'bitmap', name: f.name || f.id };
  }
  return {
    key: raw,
    css: '"' + fontLibFamily(f.id) + '","Microsoft YaHei","PingFang SC",sans-serif',
    bitmap: null, imported: true, kind: 'ttf', name: f.name || f.id,
  };
}

/* 把字体库写入图例下拉；当前选中位图时同步解出预览 */
async function refreshLegendFonts(given) {
  /* 自检可直接传入字体清单，无需先准备真实字体文件
     不传时照常读取本地字体库。 */
  const list = Array.isArray(given) ? given : await fontLibList().catch(() => []);
  _legendFontList = list;
  const sel = $('set-legend-font');
  const cur = String((state.set && state.set.legendFont) || '');
  if (sel) {
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = '默认（系统黑体）';
    sel.appendChild(def);
    for (const f of list) {
      const o = document.createElement('option');
      o.value = _legendFontKey(f);
      o.textContent = (f.name || f.id) + (f.kind === 'bitmap' ? '（位图）' : '');
      sel.appendChild(o);
    }
    const opts = sel.options || sel.querySelectorAll('option');
    const has = Array.prototype.some.call(opts || [], (o) => o && o.value === cur);
    sel.value = has ? cur : '';
  }
  const spec = _legendFontSpec(cur);
  if (spec.kind === 'bitmap' && !spec.bitmap) {
    await _loadBmFont(spec.key.slice(3));
  }
  scheduleLegendOverlay();
}

function _legendClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function legendOpts() {
  const s = (state && state.set) || {};
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
  const pos = ['tl', 'tr', 'bl', 'br', 'custom'].includes(s.legendPos) ? s.legendPos : 'tl';
  const size = ['s', 'm', 'l', 'xl', 'custom'].includes(s.legendSize) ? s.legendSize : 'm';
  const fontSpec = _legendFontSpec(s.legendFont);
  return {
    show: !!s.legend,
    title: String(s.legendTitle || '').trim(),
    titleOnly: !!s.legendTitleOnly,
    pos,
    size,
    scale: _legendClamp(num(s.legendScale, 1), 0.35, 3),
    font: fontSpec.key || 'sans',
    fontCss: fontSpec.css,
    fontBitmap: fontSpec.bitmap,
    fontImported: fontSpec.imported,
    fontKind: fontSpec.kind,
    cols: Math.round(_legendClamp(num(s.legendCols, 1), 1, 8)),
    bg: color(s.legendBg, '#ffffff'),
    bgAlpha: _legendClamp(num(s.legendBgAlpha, 90), 0, 100),
    border: color(s.legendBorder, '#000000'),
    fg: color(s.legendFg, '#111111'),
    fgAuto: !!s.legendFgAuto,
    box: ['square', 'rect', 'circle'].includes(s.legendBox) ? s.legendBox : 'square',
    x: _legendClamp(num(s.legendX, 0.04), 0, 1),
    y: _legendClamp(num(s.legendY, 0.04), 0, 1),
  };
}

function _legendHexA(hex, a) {
  const h = String(hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16) || 0;
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function _legendRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 按字符折行：中文无空格，逐字量宽最稳妥（最多 4 行，超出加省略号）。
 * measure 可替换为位图字体的量宽方法（不经过 ctx.font）。 */
function _legendWrap(ctx, text, maxW, maxLines, measure) {
  const s = String(text == null ? '' : text);
  if (!s) return [''];
  const mw = measure || ((t) => ctx.measureText(t).width);
  const chars = Array.from(s);
  const lines = [];
  let line = '';
  for (const ch of chars) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    const test = line + ch;
    if (line && mw(test) > maxW) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line || !lines.length) lines.push(line);
  const cap = Math.max(1, maxLines || 3);
  if (lines.length > cap) {
    lines.length = cap;
    let last = lines[cap - 1];
    while (last && mw(last + '…') > maxW) last = last.slice(0, -1);
    lines[cap - 1] = (last || '') + '…';
  }
  return lines;
}

function legendLayout(ctx, W, H, opts) {
  const opt = opts || legendOpts();
  if (!ctx || !(W > 0) || !(H > 0)) return null;
  let list = opt.titleOnly ? [] : legendEntries().filter((e) => e.on);
  const title = opt.title;
  if (!list.length && !title) return null;
  const font = opt.fontCss || LEGEND_FONTS.sans;
  const bm = opt.fontBitmap || null;
  const titleWeight = opt.fontKind === 'ttf' ? '600' : '700';
  const rowWeight = opt.fontKind === 'ttf' ? '600' : '500';
  const setFont = (weight, size) => { if (!bm) ctx.font = weight + ' ' + size + 'px ' + font; };
  const measure = (text, weight, size) => {
    if (bm) return bm.measure(text, size);
    ctx.font = weight + ' ' + size + 'px ' + font;
    return ctx.measureText(text).width;
  };
  // 基准字号随图宽变化；size 在此基础上乘以档位系数（自定义档位的 scale 由拖角算出）
  const base = Math.max(9, Math.round(W / 175));
  const factor = opt.size === 'custom' ? opt.scale : (LEGEND_SIZE_FACTOR[opt.size] || 1);
  const fs = Math.max(8, Math.round(base * factor));
  const titleFs = Math.max(fs, Math.round(fs * 1.17));
  const pad = Math.max(5, Math.round(fs * 0.8));
  const lineH = Math.max(10, Math.round(fs * 1.3));
  const rowGap = Math.max(2, Math.round(fs * 0.35));
  const sw = Math.max(7, Math.round(fs * 1.15));
  // 长方形色块比方块宽，排版须按实际宽度留位，否则文字会压到色块上
  const swEff = opt.box === 'rect' ? Math.round(sw * 1.4) : sw;
  const gap = Math.max(5, Math.round(fs * 0.65));
  const colGap = Math.max(8, Math.round(fs * 1.2));
  const M = Math.max(6, Math.round(fs * 1.4));
  const maxBoxW = Math.max(72, W - M * 2);
  const maxBoxH = Math.max(56, H - M * 2);
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  setFont(titleWeight, titleFs);
  const titleMaxW = Math.max(60, Math.min(Math.round(W * 0.62), maxBoxW - pad * 2));
  const measureTitle = (t) => measure(t, titleWeight, titleFs);
  const titleLines = title ? _legendWrap(ctx, title, titleMaxW, 3, measureTitle) : [];
  let titleW = 0;
  for (const ln of titleLines) titleW = Math.max(titleW, measureTitle(ln));
  const titleLineH = Math.max(11, Math.round(titleFs * 1.28));
  const titleH = titleLines.length ? titleLines.length * titleLineH + Math.round(fs * 0.6) : 0;

  /* 列数需按画布可用宽度收敛：
   * 只按 opt.cols 排时，手机 390px 下选 8 列，每列受 42px 文字下限支撑，
   * 后几列会画到框外并被 .stage 的 overflow:hidden 裁掉。
   * 因此先算一行所需的最小宽度（色块 + 间距 + 最短可读文字），放不下则减少列数。 */
  const minCellW = swEff + gap + 42;
  const maxCols = Math.max(1, Math.floor((maxBoxW - pad * 2 + colGap) / (minCellW + colGap)));
  let cols = list.length ? Math.min(opt.cols, list.length, maxCols) : 1;
  cols = Math.max(1, cols);
  let rows = list.length ? Math.ceil(list.length / cols) : 0;
  const availableW = Math.max(48, maxBoxW - pad * 2 - (cols - 1) * colGap);
  const maxTextW = Math.max(42, Math.min(Math.round(W * 0.28),
    Math.floor(availableW / cols) - swEff - gap));

  const build = (rr) => {
    const grid = [];
    const colW = new Array(cols).fill(0);
    const rowHeights = [];
    let totalH = 0;
    let visible = 0;
    setFont(rowWeight, fs);
    const measureRow = (t) => measure(t, rowWeight, fs);
    for (let r = 0; r < rr; r++) {
      const row = [];
      let rh = 0;
      for (let c = 0; c < cols; c++) {
        const e = list[c * rr + r];
        if (!e) { row.push(null); continue; }
        const lines = _legendWrap(ctx, e.name, maxTextW, 2, measureRow);
        let tw = 0;
        for (const ln of lines) tw = Math.max(tw, measureRow(ln));
        const cell = { e, lines, textW: tw };
        row.push(cell);
        colW[c] = Math.max(colW[c], swEff + gap + tw);
        rh = Math.max(rh, Math.max(1, lines.length) * lineH + rowGap);
        visible++;
      }
      grid.push(row);
      rowHeights.push(rh || (lineH + rowGap));
      totalH += rowHeights[r];
    }
    return { grid, colW, rowHeights, totalH, visible };
  };

  let built = build(rows);
  // 图高不足时从底部裁行，避免图例超出画面
  while (rows > 1 && pad * 2 + titleH + built.totalH > maxBoxH) {
    rows--;
    built = build(rows);
  }
  const contentW = built.colW.reduce((a, b) => a + b, 0) + colGap * (cols - 1);
  const boxW = Math.round(Math.min(maxBoxW, Math.max(60, pad * 2 + Math.max(contentW, titleW))));
  const boxH = Math.round(pad * 2 + titleH + built.totalH);
  const pos = opt.pos;
  let x;
  let y;
  const xMax = Math.max(M, W - boxW - M);
  const yMax = Math.max(M, H - boxH - M);
  if (pos === 'custom') {
    x = _legendClamp(opt.x * W, M, xMax);
    y = _legendClamp(opt.y * H, M, yMax);
  } else {
    const onRight = pos === 'tr' || pos === 'br';
    const onBottom = pos === 'bl' || pos === 'br';
    x = onRight ? xMax : M;
    y = onBottom ? yMax : M;
  }
  const colOffsets = [];
  let cx = 0;
  for (let c = 0; c < cols; c++) {
    colOffsets.push(cx);
    cx += built.colW[c] + colGap;
  }
  ctx.restore();
  const count = list.length
    ? built.visible + (titleLines.length && built.visible === 0 ? 1 : 0)
    : (titleLines.length ? 1 : 0);
  return {
    opt, fs, titleFs, pad, lineH, sw, gap, colGap, M,
    boxW, boxH, x, y, titleLines, titleLineH, titleH,
    cols, rows, grid: built.grid, rowHeights: built.rowHeights,
    colOffsets, count,
  };
}

function _legendPaintBox(ctx, L, x, y) {
  const opt = L.opt;
  const font = opt.fontCss || LEGEND_FONTS.sans;
  const bm = opt.fontBitmap || null;
  const titleWeight = opt.fontKind === 'ttf' ? '600' : '700';
  const rowWeight = opt.fontKind === 'ttf' ? '600' : '500';
  const drawLine = (text, lx, cy, size, weight, color) => {
    if (bm) {
      const w = bm.measure(text, size);
      bm.draw(ctx, text, lx + w / 2, cy, size, color);
      return;
    }
    ctx.font = weight + ' ' + size + 'px ' + font;
    ctx.fillStyle = color;
    ctx.fillText(text, lx, cy);
  };
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  _legendRoundRect(ctx, x, y, L.boxW, L.boxH, Math.round(L.fs * 0.55));
  if (opt.bgAlpha > 0) {
    ctx.fillStyle = _legendHexA(opt.bg, opt.bgAlpha / 100);
    ctx.fill();
  }
  ctx.lineWidth = Math.max(1, Math.round(L.fs / 16));
  ctx.strokeStyle = _legendHexA(opt.border, 0.72);
  ctx.stroke();
  let ty = y + L.pad;
  if (L.titleLines.length) {
    for (const ln of L.titleLines) {
      drawLine(ln, x + L.pad, ty + L.titleLineH / 2, L.titleFs, titleWeight, opt.fg);
      ty += L.titleLineH;
    }
    ty += Math.round(L.fs * 0.6);
  }
  for (let r = 0; r < L.grid.length; r++) {
    const row = L.grid[r];
    const rh = L.rowHeights[r] || L.lineH;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;
      const cx = x + L.pad + (L.colOffsets[c] || 0);
      const line1 = ty + L.lineH / 2;
      const shapeW = opt.box === 'rect' ? Math.round(L.sw * 1.4) : L.sw;
      const shapeH = opt.box === 'rect' ? Math.round(L.sw * 0.8) : L.sw;
      const sy = line1 - shapeH / 2;
      ctx.fillStyle = _hexOf(cell.e.rgb);
      if (opt.box === 'circle') {
        ctx.beginPath();
        ctx.arc(cx + L.sw / 2, line1, L.sw / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = Math.max(1, Math.round(L.fs / 20));
        ctx.strokeStyle = 'rgba(0,0,0,.45)';
        ctx.stroke();
      } else {
        ctx.fillRect(cx, sy, shapeW, shapeH);
        ctx.lineWidth = Math.max(1, Math.round(L.fs / 20));
        ctx.strokeStyle = 'rgba(0,0,0,.45)';
        ctx.strokeRect(cx, sy, shapeW, shapeH);
      }
      const lineColor = opt.fgAuto ? _hexOf(cell.e.rgb) : opt.fg;
      for (let i = 0; i < cell.lines.length; i++) {
        drawLine(cell.lines[i], cx + shapeW + L.gap, line1 + i * L.lineH, L.fs, rowWeight, lineColor);
      }
    }
    ty += rh;
  }
  ctx.restore();
}

/**
 * 把图例画到导出用的 2D 画布上。
 * @returns 画出的行数（0 = 什么都没画）
 */
function drawLegend(ctx, W, H) {
  if (!ctx) return 0;
  const opt = legendOpts();
  if (!opt.show) return 0;
  const L = legendLayout(ctx, W, H, opt);
  if (!L) return 0;
  _legendPaintBox(ctx, L, L.x, L.y);
  return L.count;
}

/** 导出前统一调用：勾选图例时把图例画上去。
 * 返回值：>0 表示画出的条目数；0 表示未勾选「导出时显示」；-1 表示已勾选但无内容可画。
 * -1 用于向调用方说明「为什么看不见」，与「未勾选」区分。
 */
function maybeDrawLegend(ctx, W, H) {
  /* 导出前先重算色块：切换剧本后若尚未轮到该帧重算，
   * 不在此处补算会导出切换前的配色。
   * 图例列表同样只在打开图例或导出时刷新，其余时刻不重算。 */
  freshPaintBlocks();   // 与「打开设置」使用同一套刷新逻辑，保证口径一致
  if (!(state.set && state.set.legend)) return 0;
  try {
    const n = drawLegend(ctx, W, H);
    return n > 0 ? n : -1;
  } catch (e) { return 0; }   // 图例渲染出错不应影响导出
}

/* 图例预览
 * 在地图上直接摆放一块与导出一致的图例（所见即所得）。
 * · 画布不铺满舞台：外层 div 只覆盖图例本身，因此可以拖动。
 * · 四角 / 自定义：位置存于 state.set.legendX / legendY（按舞台宽高归一化）。
 * · 拖右下角即切换到 legendSize='custom' 并调整 legendScale（0.35~3 倍）。
 * · 仅在「显示图例」打开时绘制；关闭立即隐藏，不留透明层遮挡地图。
 */
let _legendOverlayRaf = 0;

function scheduleLegendOverlay() {
  if (typeof requestAnimationFrame !== 'function') {
    try { renderLegendOverlay(); } catch (e) { /* 忽略图例预览的渲染异常 */ }
    return;
  }
  if (_legendOverlayRaf) return;
  _legendOverlayRaf = requestAnimationFrame(() => {
    _legendOverlayRaf = 0;
    try { renderLegendOverlay(); } catch (e) { /* 图例渲染失败不应影响地图 */ }
  });
}

function renderLegendOverlay() {
  const wrap = $('legend-overlay');
  const cv = $('legend-canvas');
  const stageEl = $('stage');
  if (!wrap || !cv || !stageEl) return;
  const opt = legendOpts();
  if (!opt.show) { wrap.hidden = true; return; }
  freshPaintBlocks();
  const W = stageEl.clientWidth || stageEl.getBoundingClientRect().width || 0;
  const H = stageEl.clientHeight || stageEl.getBoundingClientRect().height || 0;
  if (!(W > 0) || !(H > 0)) { wrap.hidden = true; return; }
  const ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) { wrap.hidden = true; return; }
  const L = legendLayout(ctx, W, H, opt);
  if (!L) { wrap.hidden = true; return; }
  const dpr = Math.min(2, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
  cv.width = Math.max(1, Math.round(L.boxW * dpr));
  cv.height = Math.max(1, Math.round(L.boxH * dpr));
  cv.style.width = L.boxW + 'px';
  cv.style.height = L.boxH + 'px';
  /* 画布为绝对定位，不会撑开外层，故外层需显式设置宽高；
     否则 wrap 为 0×0，拖拽区域与右上角定位都会出错。 */
  wrap.style.width = L.boxW + 'px';
  wrap.style.height = L.boxH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  _legendPaintBox(ctx, L, 0, 0);
  const M = L.M;   // 与导出版式使用同一边距，预览与成品位置一致
  let left;
  let top;
  if (opt.pos === 'custom') {
    left = opt.x * W;
    top = opt.y * H;
  } else {
    left = (opt.pos === 'tr' || opt.pos === 'br') ? W - L.boxW - M : M;
    top = (opt.pos === 'bl' || opt.pos === 'br') ? H - L.boxH - M : M;
  }
  left = Math.max(M, Math.min(left, W - L.boxW - M));
  top = Math.max(M, Math.min(top, H - L.boxH - M));
  wrap.style.left = Math.round(left) + 'px';
  wrap.style.top = Math.round(top) + 'px';
  wrap.hidden = false;
}

/* 把当前框的位置换算成归一化坐标（拖动开始时调用） */
function _legendCustomFromBox() {
  const wrap = $('legend-overlay');
  const stageEl = $('stage');
  if (!wrap || !stageEl) return;
  const r = wrap.getBoundingClientRect();
  const sr = stageEl.getBoundingClientRect();
  if (!(sr.width > 0) || !(sr.height > 0)) return;
  /* 图例关闭时外层为 hidden，getBoundingClientRect 全为 0。
     此时切到「自定义（拖动）」不能把坐标写成左上角，否则关闭再打开位置会偏移。 */
  if (!(r.width > 0) || !(r.height > 0)) return;
  state.set.legendX = _legendClamp((r.left - sr.left) / sr.width, 0, 1);
  state.set.legendY = _legendClamp((r.top - sr.top) / sr.height, 0, 1);
}

function _legendSyncCustomUi() {
  const p = $('set-legend-pos');
  if (p) p.value = state.set.legendPos || 'tl';
  const s = $('set-legend-size');
  if (s) s.value = state.set.legendSize || 'm';
}

function bindLegendOverlay() {
  const wrap = $('legend-overlay');
  const stageEl = $('stage');
  const handle = $('legend-resize');
  if (!wrap || !stageEl || wrap._legendBound) return;
  wrap._legendBound = true;
  /* 侧栏收起、设置面板开合、手机横竖屏切换不一定触发 window.resize，
     但舞台尺寸变化会使图例的四角定位偏移，故用 ResizeObserver 捕获。 */
  if (typeof ResizeObserver === 'function') {
    try {
      const ro = new ResizeObserver(() => scheduleLegendOverlay());
      ro.observe(stageEl);
      wrap._legendRO = ro;
    } catch (e) { /* 浏览器不支持 ResizeObserver 时忽略，window.resize 仍可兜底 */ }
  }
  let drag = null;

  const onMove = (ev) => {
    if (!drag) return;
    ev.preventDefault();
    let dx = ev.clientX - drag.startX;
    let dy = ev.clientY - drag.startY;
    /* 3px 死区内不改变状态：
     * 单击图例只是聚焦，若因此把位置从「右上」改成「自定义」并落盘属于误操作；
     * 触摸点击同样会误触，故必须实际拖动才切换到自定义。 */
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 3) return;
      drag.moved = true;
      _legendCustomFromBox();
      state.set.legendPos = 'custom';
      if (drag.mode === 'resize') {
        const opt = legendOpts();
        const cur = opt.size === 'custom' ? opt.scale : (LEGEND_SIZE_FACTOR[opt.size] || 1);
        state.set.legendSize = 'custom';
        state.set.legendScale = _legendClamp(cur, 0.35, 3);
        drag.startScale = state.set.legendScale;
        drag.startX = ev.clientX;   // 重新起算，避免第一下跳动
        drag.startY = ev.clientY;
        dx = 0;
        dy = 0;
      }
    }
    if (drag.mode === 'resize') {
      if (!(drag.startW > 0)) return;
      /* 把手位于右下角，横向与纵向拖动都应生效：
       * 只判断 dx 时，竖直下拉图例不动，看起来像失效。
       * 取位移较大的轴，斜向拖动也不会突然反向。 */
      const dd = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
      const ratio = (drag.startW + dd) / drag.startW;
      state.set.legendSize = 'custom';
      state.set.legendScale = _legendClamp(drag.startScale * ratio, 0.35, 3);
    } else {
      const sr = stageEl.getBoundingClientRect();
      if (!(sr.width > 0) || !(sr.height > 0)) return;
      state.set.legendPos = 'custom';
      state.set.legendX = _legendClamp((drag.left + dx) / sr.width, 0, 1);
      state.set.legendY = _legendClamp((drag.top + dy) / sr.height, 0, 1);
    }
    _legendSyncCustomUi();
    renderLegendOverlay();
  };

  const onUp = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (moved) scheduleSave();   // 仅点击聚焦，不写入存档
  };

  wrap.addEventListener('pointerdown', (ev) => {
    if (drag) return;
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = wrap.getBoundingClientRect();
    const isResize = !!(handle && (ev.target === handle || handle.contains(ev.target)));
    drag = {
      mode: isResize ? 'resize' : 'move',
      startX: ev.clientX, startY: ev.clientY,
      startW: r.width,
      left: r.left - stageEl.getBoundingClientRect().left,
      top: r.top - stageEl.getBoundingClientRect().top,
      moved: false,
    };
    try { wrap.focus({ preventScroll: true }); } catch (e) { /* 忽略焦点设置失败 */ }
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  // 键盘：方向键微调 4px，Shift + 方向键缩放，避免鼠标拖动精度不足
  wrap.addEventListener('keydown', (ev) => {
    const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = map[ev.key];
    if (!d) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.shiftKey) {
      // 缩放不需要先切换到自定义位置：四角锚点不变，只改大小
      const opt = legendOpts();
      const cur = opt.size === 'custom' ? opt.scale : (LEGEND_SIZE_FACTOR[opt.size] || 1);
      const dir = (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') ? -1 : 1;
      state.set.legendSize = 'custom';
      state.set.legendScale = _legendClamp(cur + dir * 0.06, 0.35, 3);
      _legendSyncCustomUi();
      renderLegendOverlay();
      scheduleSave();
      return;
    }
    const W = stageEl.clientWidth || 1;
    const H = stageEl.clientHeight || 1;
    if (state.set.legendPos !== 'custom') _legendCustomFromBox();
    state.set.legendPos = 'custom';
    state.set.legendX = _legendClamp((state.set.legendX || 0) + d[0] * 4 / W, 0, 1);
    state.set.legendY = _legendClamp((state.set.legendY || 0) + d[1] * 4 / H, 0, 1);
    _legendSyncCustomUi();
    renderLegendOverlay();
    scheduleSave();
  });
}

/* 颜色行右侧的 HEX / 透明度读数：与颜色页使用同一套换算 */
function _legendSyncReadouts() {
  const s = state.set || {};
  const hex = (v, d) => String(v || d).toUpperCase();
  const put = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  put('v-set-legend-bg', hex(s.legendBg, '#ffffff'));
  put('v-set-legend-border', hex(s.legendBorder, '#000000'));
  put('v-set-legend-fg', hex(s.legendFg, '#111111'));
  const a = Number(s.legendBgAlpha != null ? s.legendBgAlpha : 90);
  put('v-set-legend-alpha', Math.round(Number.isFinite(a) ? a : 90) + '%');
}

function syncLegendControls(s) {
  s = s || state.set || {};
  const put = (id, v) => {
    const el = $(id);
    if (!el) return;
    if (el.type === 'checkbox') { el.checked = !!v; return; }
    el.value = v;
  };
  put('set-legend', !!s.legend);
  put('set-legend-title', s.legendTitle || '');
  put('set-legend-title-only', !!s.legendTitleOnly);
  put('set-legend-pos', s.legendPos || 'tl');
  put('set-legend-size', s.legendSize || 'm');
  {
    /* 下拉只列「默认」与已导入字体；早期存档中的 sans/song/kai/mono 无对应项，
       显示为默认，绘制时仍按原值取字（见 legendOpts 的 LEGEND_FONTS 兜底） */
    const sel = $('set-legend-font');
    if (sel) {
      const want = String(s.legendFont || '');
      /* 测试桩的假 DOM 可能没有 select.options（只有 querySelectorAll），
         两种写法都做兼容，避免回填失败导致整页自检中断 */
      const opts = sel.options || sel.querySelectorAll('option');
      const has = Array.prototype.some.call(opts || [], (o) => o && o.value === want);
      sel.value = has ? want : '';
    }
  }
  put('set-legend-cols', String(s.legendCols || 1));
  put('set-legend-bg', s.legendBg || '#ffffff');
  put('set-legend-bg-alpha', s.legendBgAlpha != null ? s.legendBgAlpha : 90);
  put('set-legend-border', s.legendBorder || '#000000');
  put('set-legend-fg', s.legendFg || '#111111');
  put('set-legend-fg-auto', !!s.legendFgAuto);
  put('set-legend-box', s.legendBox || 'square');
  _legendSyncReadouts();
  _legendSyncLinkage();
}

function bindLegendControls() {
  const on = (id, ev, fn) => {
    const el = $(id);
    if (el) el.addEventListener(ev, fn);
  };
  const changed = () => {
    _legendSyncReadouts();
    _legendSyncLinkage();
    _legendRefreshNote();
    scheduleLegendOverlay();
    scheduleSave();
  };
  on('set-legend', 'change', (e) => {
    state.set.legend = !!e.target.checked;
    changed();
  });
  on('set-legend-title', 'input', (e) => {
    state.set.legendTitle = e.target.value;
    changed();
  });
  on('set-legend-title-only', 'change', (e) => {
    state.set.legendTitleOnly = !!e.target.checked;
    changed();
  });
  on('set-legend-pos', 'change', (e) => {
    if (e.target.value === 'custom') _legendCustomFromBox();
    state.set.legendPos = e.target.value;
    changed();
  });
  on('set-legend-size', 'change', (e) => {
    const v = e.target.value;
    if (v === 'custom') {
      /* 从「大 / 特大」切换到自定义时不要强制把 scale 写成 1，
         否则选择「自定义（拖角）」后图例会先缩回中号，拖动后才恢复 */
      const opt = legendOpts();
      const cur = opt.size === 'custom' ? opt.scale : (LEGEND_SIZE_FACTOR[opt.size] || 1);
      state.set.legendScale = _legendClamp(cur, 0.35, 3);
    } else {
      state.set.legendScale = 1;
    }
    state.set.legendSize = v;
    changed();
  });
  on('set-legend-font', 'change', async (e) => {
    const v = e.target.value;
    state.set.legendFont = v;
    if (v.startsWith('bm:')) {
      const bf = await _loadBmFont(v.slice(3));
      if (!bf) {
        state.set.legendFont = '';
        e.target.value = '';
        toast('这套位图字体读不出来，先用默认字体');
      }
    }
    changed();
  });
  on('set-legend-cols', 'change', (e) => { state.set.legendCols = Number(e.target.value) || 1; changed(); });
  on('set-legend-bg', 'input', (e) => { state.set.legendBg = e.target.value; changed(); });
  on('set-legend-bg-alpha', 'input', (e) => { state.set.legendBgAlpha = Number(e.target.value); changed(); });
  on('set-legend-border', 'input', (e) => { state.set.legendBorder = e.target.value; changed(); });
  on('set-legend-fg', 'input', (e) => { state.set.legendFg = e.target.value; changed(); });
  on('set-legend-fg-auto', 'change', (e) => { state.set.legendFgAuto = !!e.target.checked; changed(); });
  on('set-legend-box', 'change', (e) => { state.set.legendBox = e.target.value; changed(); });
  on('legend-sort', 'click', () => {
    const list = legendEntries().slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    state.legendOrder = list.map((e) => e.key);
    rebuildLegendPanel();
    scheduleLegendOverlay();
    scheduleSave();
  });
  on('legend-reset-names', 'click', () => {
    state.legendNames = {};
    rebuildLegendPanel();
    scheduleLegendOverlay();
    scheduleSave();
  });
}

function paintedPoints(forNames = false) {
  // forNames=true 时不看颜色开关：玩家地名开启即显示，与「原版地名」「填色·颜色」开关无关。
  // 与「原版地名」「填色·颜色」开关无关。
  if (!forNames && (state.showTitles || !state.showPaint)) return null;
  return state.paintBlocks;
}

// 启动

/* 启动分段计时：用于定位加载慢发生在哪一阶段。
 * setBoot 按阶段调用（看地图 → 元数据 → 头衔表 → 解压 id 图 →
 * 归属表 → 上传显卡 → 就绪），以此作为分段依据。
 * 阶段名变化时输出上一阶段耗时，结束时输出总耗时。
 * 结果写入 PDXLOG，可随导出日志一并查看，无需打开控制台。
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
  /* 启动看门狗心跳：白屏 / 黑屏时据此判断卡在哪一步 */
  if (step && window.PDXLOG && window.PDXLOG.tick) {
    try { window.PDXLOG.tick(step); } catch (e) { /* 忽略日志模块异常 */ }
  }
  if (pct != null) $('boot-bar').style.width = pct.toFixed(0) + '%';
}

const nextTick = () => new Promise((r) => setTimeout(r, 16));

/** 返回可用的地图列表：单文件版读取内嵌清单，HTTP 部署时探测各自的 meta.json，
 * 最后并入玩家导入的地图包（存于浏览器，见 packstore.js）。 */
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
      } catch (e) { /* 缺少该数据集时跳过 */ }
    }
  }
  /* 导入包读取失败不应影响内置地图：
     存储被清除、隐私模式、库损坏都只应导致少几张图，不应导致编辑器打不开。
     同一作者 id 有多份时，第 2 份起在名字后标「第 N 份」，
     否则卡片外观相同，无法区分。 */
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

/* 导入式地图：选图界面（见 docs/导入式地图-策划.md 第 4 节）
 * 三部分：① 导入入口（点选 / 拖放）② 导入进度与结果提示
 * ③ 已导入地图的管理（导出备份 / 删除）
 * 两条约束：
 * · 界面上显示的字符串一律用 textContent —— label / note / author
 *   均为外部数据，拼进 innerHTML 会在玩家机器上执行脚本
 * · 失败提示只说面向玩家的话并注明出错文件，同时写入报错日志（附「复制详情」）
 * 导入只增不改：
 * 同一个包导入两次即两张图，作者 id 仅用于展示和判断重复，
 * 已导入的图不会被后续导入改动。
 * 唯一的拦截是「逐文件 sha256 完全相同」——多为重复导入，
 * 确认后仍为新增一张，不替换原图。
 */

/* 导入进行中（避免重复点击 / 重复拖放） */
let _importing = false;

/**
 * 把库中的一条记录转换为选图界面的卡片数据。
 * key 使用实例键 rec.id，而非作者写的 id：
 * 导入只增不改，同一个包导入两次即两条记录、两张卡片，
 * 因此卡片、涂色、删除、导出均以实例键为准，作者 id 仅用于展示和判断重复。
 * @param {object} rec   库中的记录（id = 实例键，manifest，size）
 * @param {number} [nth] 同一作者 id 的第几份（从 1 计；仅一份时界面不标注）
 */
function packEntry(rec, nth) {
  const m = rec.manifest || {};
  const size = rec.size || 0;
  /* 卡片右侧优先显示分辨率（如 9216 × 4608），内置地图与导入包一致，
     两个数字即可反映地图体量；取不到 stats 的包或半成品退回显示作者 note */
  const st = m.stats || {};
  const mw = Number(st.mapWidth) || 0;
  const mh = Number(st.mapHeight) || 0;
  const dims = (mw > 0 && mh > 0) ? (mw + ' × ' + mh) : '';
  return {
    key: 'pack:' + rec.id,
    pack: rec.id,                     // boot 认这个字段：有它即走导入的包
    game: GAMES[m.game] ? m.game : 'ck3',
    /* 名字保持原样，不在其中附加「（第 2 份）」：
       重复份数由卡片左上角的小序号区分；写进名字会拉长标题，且仍需逐字辨认 */
    label: m.label || m.id || rec.id,
    nth: nth || 0,                    // 同一张图的第几份（界面用它绘制左上角小序号）
    note: dims || m.note || '',
    fullNote: m.note || '',           // 作者写的说明转入 tooltip，避免丢失
    author: m.author || '',
    version: m.version || '',
    size,
    manifestId: m.id || rec.id,
    imported: true,
  };
}

/* 进度 / 结果提示行（只接受字符串，一律按文本显示） */
function setPackMsg(kind, text, pct) {
  const box = $('map-msg');
  if (!box) return;
  box.hidden = false;
  /* 使用 classList 而非 className：界面其他部分同样如此，
     且测试桩（tools/lib/browser_stub.js）只同步 classList */
  box.classList.remove('busy', 'bad', 'done');
  if (kind) box.classList.add(kind);
  box.textContent = String(text == null ? '' : text);   // 外部字符串一律按文本写入
  if (kind === 'busy' && pct !== undefined && pct !== null) {
    const bar = document.createElement('div');
    bar.className = 'map-msg-bar';
    const i = document.createElement('i');
    i.style.width = Math.max(0, Math.min(100, Number(pct) || 0)).toFixed(0) + '%';
    bar.appendChild(i);
    box.appendChild(bar);
  }
  if (kind === 'bad') {
    // 报错详情已写入日志；此处提供「复制详情」入口，便于反馈
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
 * 清除某张图保存的涂色暂存。
 * 仅在删除地图时询问是否一并清除。
 * 只操作 `STASH_KEY`，不得触碰 `SET_KEY`：
 * 设置与最近颜色按游戏类型存储（`prefsKeyOf`），不归属任何单张地图；
 * 若在此删除 SET_KEY 中的条目，删除一张图会清空同款游戏所有地图的设置，
 * 且该 key 即游戏名，删除的正是整份数据。
 */
function forgetMapPaint(key) {
  if (!key) return;
  const box = readJSONBox(STASH_KEY, {});
  if (box[key] !== undefined) {
    delete box[key];
    writeJSONBox(STASH_KEY, box);
  }
}

/**
 * 导入一个包（点选、拖拽、后续创意工坊下载均走此入口）。
 * 只增不改：成功后新增一张图，已导入的图不受影响；
 * 内容完全相同的包同样导入，不弹窗确认，库中多一张，原图不替换，
 * 份数由卡片左上角的小序号区分。
 * @param {Blob} blob
 * @param {(r: {manifest: object, key: string, sameMap: number}) => void} [onDone] 导入完成回调
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
      /* 库中已存在内容完全相同的包时不再询问，直接新增一份：
         两份互相独立、涂色互不影响，原图不变，份数由卡片左上角小序号区分。
         库中的 DUPLICATE 检查保留，用于拦截同一次流程内重复写入的意外，
         而非向玩家提问。 */
      r = await importPack(blob, Object.assign({ allowDuplicate: true }, opt));
    }
    /* 提示只报导入的地图名称，不附加「（HOI4 · 20006 个地块 · 5120×2560）」；
       尺寸与地块数在卡片上已有显示 */
    setPackMsg('done', `成功导入地图：${r.manifest.label}`);
    LOG.event('导入地图包', `${r.key}（${r.sameMap > 1 ? '第 ' + r.sameMap + ' 份' : '新增'}）✓`);
    if (onDone) await onDone(r);               // 等界面刷新完成再返回，否则调用方会以为尚未完成
    return true;
  } catch (e) {
    /* 校验类错误不直接把打包者的原始文案展示给玩家：
     * pack.js 中「formatVersion 得是正整数 / files 得是 sha256 对象」一类
     * 面向打包者的提示，界面只给一句通俗说明，原文写入诊断报告。
     * 按玩家可采取的操作分四类：
     * ① 拖入错误文件   → 说明地图包的结构（重新下载或更换文件）
     * ② 包比编辑器新   → 提示更新编辑器
     * ③ 包过旧         → 只能由作者重新导出，需说明原因
     * ④ 传输损坏 / 超限 → pack.js 的原话已可读（「可能没传完」「超过上限」），直接使用
     * 四类都不匹配时原样给出 raw：自行改写为「格式不兼容」会掩盖真实原因。 */
    const raw = String((e && e.message) || e || '');
    let msg = '导入失败：' + raw;
    if (/不是有效的地图包|缺少 manifest/.test(raw)) {
      msg = '导入失败：这不是地图包。地图包的文件后缀是 .pdxmap，重新下载一份再试。';
    } else if (/新版格式|dataSchema 更新|请更新编辑器/.test(raw)) {
      msg = '导入失败：这个包是给新版编辑器做的，先把编辑器更新到最新版再导入。';
    } else if (/dataSchema 太旧|重新打包/.test(raw)) {
      msg = '导入失败：这个包是旧版本做的，得让作者用新版工具重新导出。';
    } else if (/超过上限|太大/.test(raw)) {
      msg = '导入失败：这个包太大了，编辑器装不下。' + raw;
    }
    setPackMsg('bad', msg);
    LOG.error('导入地图包失败', e);
    return false;
  } finally {
    _importing = false;
  }
}

/* 让玩家选择一张地图；只有一套且无导入入口时直接进入 */
function pickMap(maps) {
  return new Promise((resolve) => {
    /* 仓库的「载入」需要从外部 resolve 该流程（存档记录要载入哪张底图） */
    state._pickResolve = resolve;

    /* 本地测试 / 深链：打开后直接进入地图
     * `?map=ck3` / `?map=eu4` / `?auto=1` → 跳过选图页，直接以该图进入编辑器
     * `?pick=1` → 强制回到选图页（与上述深链配合使用）
     * 不带参数时行为不变，仍停留在选图页
     * 仅在存在可选地图时生效；无地图时仍走选图页（导入入口保留） */
    try {
      const q = new URLSearchParams((typeof location !== 'undefined' && location.search) || '');
      if (q.get('pick') == null) {
        const want = String(q.get('map') || '').toLowerCase();
        const auto = q.get('auto') != null;
        if (maps.length && (want || auto)) {
          const hit = maps.find((m) => want && (
            String(m.emb || '').toLowerCase() === want
            || String(m.key || '').toLowerCase() === want
            || String((m.pack && m.pack.id) || '').toLowerCase() === want
            || String(m.label || '').toLowerCase().includes(want))) || maps[0];
          if (hit) { resolve(hit); return; }
        }
      }
    } catch (e) { /* 参数无法解析时照旧走选图页 */ }
    const box = $('map-pick');
    let _pendHint = false;
    if (state._pendingProject) _pendHint = true;
    else { try { _pendHint = !!sessionStorage.getItem('pdx.pendingProject'); } catch (e) { _pendHint = false; } }
    if (_pendHint) {
      setPackMsg('', '请选择载入的地图包');
    }
    const list = $('map-pick-list');
    const fileInput = $('pack-file');
    let current = maps.slice();
    let currentView = 'maps';

    /* 该行平时隐藏，仅在浏览器无法持久存储时显示警示：
       不提示的话玩家会误以为已保存 */
    packStoreMode().then((mode) => {
      const hint = $('map-import-hint');
      if (!hint) return;
      if (mode === 'memory') {
        hint.hidden = false;
        hint.classList.add('warn');
        hint.textContent = '⚠ 这台浏览器无法保存本地数据（可能处于隐私模式）：导入的地图刷新后会丢失，请保留原始文件';
      } else {
        hint.hidden = true;
        hint.classList.remove('warn');
        hint.textContent = '';
      }
    }).catch(() => {});

    /* 两个操作直接显示在卡片上：藏在右上角「⋯」面板里需多点一次才能看见；
       该面板及其样式已移除，不再有 #pack-menu / .map-more。 */
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
        /* 删除地图时一并清除该图的涂色，不再询问：
           保留涂色仅在重新导入同一个包时有用，不值得为此多一次确认
           设置与最近颜色不得触碰：它们按游戏类型存储，不属于单张地图
           （见 forgetMapPaint 的说明） */
        forgetMapPaint('pack:' + id);
        current = current.filter((x) => x.pack !== id);
        render();
        setPackMsg('', `成功删除地图：${label}`);
      } catch (e) {
        setPackMsg('bad', '删不掉：' + (e && e.message ? e.message : e));
        LOG.error('删除地图包失败', e);
      }
    }

    /* 导入成功后：把新卡片加入列表并高亮（不自动进入，由玩家点击） */
    const afterImport = async (r) => {
      let rec = null;
      try {
        rec = await getPack(r.key);
      } catch (e) { /* 读不到记录不影响使用，下面用返回值兜底 */ }
      if (!rec) rec = { id: r.key, manifest: r.manifest, size: 0 };
      /* 统计同一作者 id 当前的份数，作为实例序号 nth（界面据此绘制左上角小序号） */
      const mid = rec.manifestId || (rec.manifest && rec.manifest.id) || rec.id;
      const n = current.filter((x) => x.manifestId === mid).length + 1;
      const e = packEntry(rec, n);
      const i = current.findIndex((x) => x.pack === e.pack);
      if (i >= 0) current[i] = e; else current.push(e);
      render(e.key);
    };

    const render = (flashKey) => {
      list.innerHTML = '';
      /* 一张卡都没有时给出说明：
         轻量版首次打开即是 0.6 MB 的编辑器 + 尚未导入任何地图包，
         否则玩家看到的是空白选单加一个导入按钮，不知道是否遗漏了步骤
         该说明写入下方提示框（与「成功导入地图…」共用），不再单独占一块区域
         提示框中已有内容时（导入中 / 报错 / 刚完成）不覆盖 */
      if (!current.length) {
        const msgBox = $('map-msg');
        if (msgBox && msgBox.hidden) {
          setPackMsg('', '请点击导入按钮，或将 .pdxmap 文件直接拖进这一页。');
        }
      }
      /* 一律单列：卡片多时由列表自身滚动（CSS max-height），
       * 不改变列数，也不放宽启动面板 */
      for (const m of current) {
        const b = document.createElement('button');
        b.className = 'map-card' + (m.imported ? ' imported' : '');
        /* label 不能直接拼进 innerHTML：
           内置地图的 label 由本文件写死，导入包则来自外部文件，
           label / note / author 均由他人提供，
           一个 <img src=x onerror=...> 即可在玩家机器上执行脚本，
           故用创建节点 + textContent 的方式写入，不作为 HTML 解析 */
        const bName = document.createElement('b');
        bName.textContent = m.label;
        const bNote = document.createElement('span');
        bNote.textContent = m.note || '';
        /* 不使用 title 悬停提示（fullNote 不再挂 title） */
        /* 同一张图导入多份时，左上角标出序号（1 / 2 / …）；
           仅一份时不标，避免每张卡都显示「1」造成干扰
           名字中不附加「（第 2 份）」，份数完全依赖该序号 */
        const dupN = current.filter((x) => x.manifestId === m.manifestId).length;
        if (m.imported && dupN > 1 && m.nth) {
          const no = document.createElement('span');
          no.className = 'map-card-no';
          no.textContent = String(m.nth);
          b.classList.add('has-no');        // 左侧留出序号的位置
          b.appendChild(no);
        }
        b.appendChild(bName);
        b.appendChild(bNote);
        if (m.imported) {
          const tag = document.createElement('span');
          tag.className = 'map-card-tag';
          /* 不显示作者：这批包多为同一作者，显示只是干扰
             （字段保留：外部包可自行填写，界面不展示） */
          /* 不显示「已导入」：卡片右下角的「导出 / 删除」已表明其来源
             该栏只保留版本号，未写版本号时留空 */
          tag.textContent = m.version ? 'v' + m.version : '';
          b.appendChild(tag);
          /* 两个操作直接显示在卡片上（右下角，与左下角版本号同一行）：
             藏在「⋯」弹窗中需多点一次才能看见
             二者必须自行阻止事件冒泡，否则点击按钮等同于点击卡片并进入地图 */
          const acts = document.createElement('span');
          acts.className = 'map-card-acts';
          const mkAct = (text, danger, fn) => {
            const x = document.createElement('span');
            x.className = 'map-act' + (danger ? ' danger' : '');
            x.textContent = text;
            x.onclick = (ev) => {
              if (ev && ev.stopPropagation) ev.stopPropagation();
              if (ev && ev.preventDefault) ev.preventDefault();
              /* 必须返回 Promise：自动测试通过 `await 按钮.onclick(...)` 调用，
                 不 return 时拿到 undefined 会继续执行，而导出 / 删除仍在后台进行
                 浏览器不读取返回值，返回没有副作用 */
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
          document.body.classList.remove('pick-open');
          resolve(m);
        };
        list.appendChild(b);
        if (flashKey && m.key === flashKey) {
          b.classList.add('flash');
          /* 列表较长时新卡片可能位于可视区外，闪烁提示不可见，
             故滚动一次使其进入视野（block:'nearest'，已在视野内则不动）
             测试桩没有 scrollIntoView，先判断是否存在 */
          if (b.scrollIntoView) { try { b.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
          setTimeout(() => { try { b.classList.remove('flash'); } catch (e) {} }, 1500);
        }
      }
    };

    // ---- 导入入口：点选 / 拖放（均支持一次多个文件）
    const onImportClick = () => {
      if (_importing) return;
      if (currentView === 'maps') {
        if (fileInput) fileInput.click();
      } else {
        const sf = $('map-store-import');
        if (sf) sf.click();
      }
    };
    /** 逐个导入，单个失败不影响后续；提示由每次 importPackFlow 自行给出，此处不另报总数。
     * 多选时屏幕保留最后一次的提示，「第几份」由卡片左上角小序号表示。 */
    const importMany = async (files) => {
      const todo = Array.from(files || []).filter(Boolean);
      for (const f of todo) await importPackFlow(f, afterImport);
      if (todo.length) showPickView('maps');   // 导入完成后直接显示卡片
    };
    const onFilePicked = async () => {
      const files = fileInput && fileInput.files;
      if (!files || !files.length) return;
      await importMany(files);
      try { fileInput.value = ''; } catch (e) { /* 清空失败不影响导入 */ }
    };
    /* 整页拖拽高亮：文件悬停在窗口上方时压暗整页并提示「松手就开始导入」
       dragenter / dragleave 会在子元素之间反复触发（拖过按钮即触发一次 leave），
       故用计数器：进入 +1、离开 -1，归零才收起
       提示层自身设置 pointer-events:none，避免遮挡下层拖拽事件 */
    const dropMask = $('drop-mask');
    let dragDepth = 0;
    const showDropHint = (on) => {
      if (dropMask) dropMask.hidden = !on;
      if (document.body && document.body.classList) document.body.classList.toggle('drop-on', on);
    };
    const onDragEnter = (ev) => {
      if (box.hidden) return;
      if (ev && ev.preventDefault) ev.preventDefault();
      dragDepth++;
      showDropHint(true);
    };
    const onDragLeave = (ev) => {
      dragDepth = Math.max(0, dragDepth - 1);
      const to = ev && ev.relatedTarget;
      /* relatedTarget 为 null 表示拖拽离开窗口（而非进入子元素），
         此时直接归零，避免计数卡住导致提示层不消失 */
      if (!dragDepth || !to) { dragDepth = 0; showDropHint(false); }
    };
    const onDragOver = (ev) => {
      if (box.hidden) return;
      if (ev && ev.preventDefault) ev.preventDefault();   // 不阻止默认行为时浏览器会把文件当作导航
      if (!dropMask || dropMask.hidden) showDropHint(true);   // dragenter 漏掉时补上高亮
    };
    /* 明显不是地图包的文件（图片 / 字体 / 文档等）不交给 zip 解析器，
       否则会返回「这不是一个完整的 zip 包」，玩家难以理解
       无扩展名的文件不算「明显不是」：安卓 / 微信下载的文件常无名字，
       这类仍交给校验器（按 pdxmap 内容识别，不看文件名） */
    const NOT_PACK = /\.(png|jpe?g|gif|webp|bmp|svg|ico|mp4|mov|avi|mp3|wav|ogg|flac|ttf|otf|fnt|dds|css|html?|js|md|txt|pdf|docx?|xlsx?|pptx?|exe|msi|7z|rar|tar|gz)$/i;
    const onDrop = async (ev) => {
      /* 先收起提示层：无论后续是否导入成功，高亮都应退出 */
      dragDepth = 0;
      showDropHint(false);
      if (box.hidden) return;
      if (ev && ev.preventDefault) ev.preventDefault();
      const dt = ev && ev.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) {
        setPackMsg('bad', '未接收到文件。请拖入 .pdxmap 地图包。');
        return;
      }
      /* 按文件类型分派，不依赖当前页签：
       * 按页签分派时，地图页拖入 .json 会被当作 zip 解析并报「这不是一个完整的 zip 包」；
       * 仓库页拖入 .pdxmap 会走 JSON.parse 并报「Unexpected token」
       * 现按类型分派：.json 进入地图仓库，.pdxmap / .zip 进入地图库
       * 导入按钮无需改动：其文字与目标本就随页签切换（见 onImportClick） */
      const list = Array.from(dt.files);
      const isJson = (f) => /\.json$/i.test(String((f && f.name) || ''))
        || !!(f && f.type === 'application/json');
      const isPack = (f) => /\.(pdxmap|zip)$/i.test(String((f && f.name) || ''));
      const packs = list.filter(isPack);
      const jsons = list.filter(isJson);
      const other = list.filter((f) => !isPack(f) && !isJson(f));
      if (packs.length) await importMany(packs);      // 导入完成后自动切回「开始创作」
      for (const f of jsons) await storeImportFile(f);
      /* 扩展名无法识别（无名字的 Blob 或其他后缀）时按当前页签处理：
       * 地图页交给地图包校验器，由它给出可读的拒绝原因（「不是完整的 zip」）；
       * 仓库页按涂色存档尝试；不在此处自行报「认不出」，以免掩盖真实原因 */
      if (other.length) {
        if (currentView === 'maps') {
          /* 没有可接收的文件，且拖入内容明显不是包（图片 / 字体 / 文档）时，
             在此给出说明，不交给 zip 解析器返回「这不是一个完整的 zip 包」
             常见情况：把涂色截图或涂色 .txt 当作地图包拖入 */
          const allJunk = !packs.length && !jsons.length
            && other.every((f) => NOT_PACK.test(String((f && f.name) || '')));
          if (allJunk) {
            const nm = String((other[0] && other[0].name) || '这个文件');
            setPackMsg('bad', `「${nm}」不是地图包。地图包为 .pdxmap 或 .zip 文件，请拖入正确的文件。`);
          } else {
            await importMany(other);
          }
        } else {
          for (const f of other) await storeImportFile(f);
        }
      }
      /* 只要接收到 .json 就切换到「读取地图」查看结果（混合拖入时同样如此）：
       * storeImportFile 写入同一个列表，停留在「开始创作」页会看到错误的页面 */
      if (jsons.length) showPickView('store');
    };
    const dropOff = () => {
      const boot = $('boot');
      if (boot && boot.removeEventListener) {
        boot.removeEventListener('dragenter', onDragEnter);
        boot.removeEventListener('dragleave', onDragLeave);
        boot.removeEventListener('dragover', onDragOver);
        boot.removeEventListener('drop', onDrop);
      }
      /* 离开选图页时收起高亮，否则进入编辑器后提示层仍覆盖在页面上，
         且不会再收到 drop 事件 */
      dragDepth = 0;
      showDropHint(false);
    };

    $('map-import').onclick = onImportClick;
    /* 二分起步页：落地页分为「地图」「涂色」两块，点击进入对应视图
     * 卡片在打开时已渲染进 #map-pick-list（见尾部的 render()），
     * 落地页仅为视觉层，自动测试 / 调优工具程序化点击卡片照常工作 */
    const tabMaps = $('pick-tab-maps');
    const tabStore = $('pick-tab-store');
    /* 上排两个页签，点击切换下方内容，默认「地图包」 */
    const showPickView = (v) => {
      const maps = v === 'maps';
      currentView = v;
      if (tabMaps) tabMaps.classList.toggle('on', maps);
      if (tabStore) tabStore.classList.toggle('on', !maps);
      /* .store-mode：仓库页专属样式的开关（大卡片），并隐藏地图侧提示 */
      box.classList.toggle('store-mode', !maps);
      /* 同一个 #map-pick-list，按页签渲染对应内容
       * 导入按钮文字随页签切换
       * 不要向 `#map-import-hint` 写入内容：该条是「浏览器无法持久存储」的
       * 警告专用位，平时应为空且隐藏
       * （tools/check_standalone.js 的「入口下面平时不摆说明文字」检查此项） */
      list.innerHTML = '';
      const mi = $('map-import');
      if (maps) {
        render();
        if (mi) mi.textContent = '＋ 导入地图包…';
      } else {
        renderStoreList();
        if (mi) mi.textContent = '＋ 导入涂色方案…';
      }
    };
    if (tabMaps) tabMaps.onclick = () => showPickView('maps');
    if (tabStore) tabStore.onclick = () => { exitDownload(); showPickView('store'); };
    /* 仓库面板自身的导入按钮（从地图视图与涂色视图均可进入仓库） */
    if ($('map-store-import')) $('map-store-import').onchange = async (e) => {
      const file = e.target && e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) await storeImportFile(file);
    };
    if (fileInput) fileInput.onchange = onFilePicked;

    /* 「下载地图包」：卡片区临时替换为可下载的卡片
     * 按下按钮后，上方的地图卡片暂时变为可下载的几份
     * 点击某张即下载该份，完成后该卡消失
     * 全部下载完 / 再次按下按钮 / 切换到其他页签 → 恢复为正常地图卡片
     * 这些卡不是真正的地图卡，只借用 `.map-card` 的骨架（.dl-card），
     * 点击不会选图，只触发一次下载
     * 退出时调用 `render()` 重建，不还原 innerHTML：
     * 卡片的 onclick 绑定在节点上，还原 HTML 会使监听器全部丢失
     */
    let dlMode = false;
    let dlSnap = null;          // 进入模式前 #map-msg 的内容（退出时原样恢复）

    const exitDownload = () => {
      if (!dlMode) return;
      dlMode = false;
      const fb = $('map-fetch');
      if (fb) { fb.textContent = '⤓ 下载地图包'; fb.classList.remove('on'); fb.disabled = false; }
      const imp = $('map-import'); if (imp) imp.style.display = '';
      const mb = $('map-msg');
      if (mb && dlSnap) { mb.hidden = dlSnap.hidden; mb.className = dlSnap.cls; mb.textContent = dlSnap.text; }
      dlSnap = null;
      list.innerHTML = '';
      render();
    };

    /* 同一 tick 内连点多张时，浏览器只接受最后一次导航（只下载一个文件），
       故下载按队列发号：一次一个、间隔 120ms
       该间隔只约束「发出下载」，实际传输仍并行 */
    let dlQueue = Promise.resolve();
    const queueDownload = (url, name) => {
      dlQueue = dlQueue.then(() => new Promise((res) => {
        downloadAsset(url, name);
        setTimeout(res, 120);
      }));
    };

    /* 点击下载卡时先尝试自行取回字节：
       取到则直接交给 importPackFlow，进入包列表并可立即打开，
       不落到下载文件夹，也无需再次点击「导入」
       注意：GitHub 的 release 附件位于 release-assets.githubusercontent.com，
       响应中没有 access-control-allow-origin，浏览器跨域无法读取字节，
       因此此路径必然进入 catch（`web/js/app.js:118` 处注释为同一结论）
       保留该路径的原因：将包放到带 CORS 的镜像（另开仓库走 jsDelivr）
       或套一层 Cloudflare Worker 代理后，此段代码无需修改即可全自动运行
       取不到时退回原路径：`<a download>` 交给浏览器下载，并提示「拖回来即自动导入」 */
    const PACK_FETCH_TIMEOUT = 20000;
    /* 代理跳的超时单独设为较短：
       代理未部署、域名未生效、网络不可达等失败均为「连不上」，数秒内即可判定；
       若给 20 秒，玩家看到的是点击卡片后长时间无响应，故 6 秒判定失败并转到下一跳
       直连保留 20 秒：它是真正可能取得字节的路径，值得多等 */
    const PACK_HOP_TIMEOUT = 6000;
    /* 取字节的候选链路：
       OSS/COS（`PACK_OSS`）：主力，国内直连较快，配置 CORS 后可读取
       Cloudflare Worker（`cloudflare/worker.js`）：海外 / 走代理时最快，国内直连多不可用
       公共 GitHub 加速站：无需账号、国内一般可连，稳定性较差，仅作备用加速
       直连：会被 CORS 拦截，保留以防附件日后自带 CORS 头
       全部失败 → 退回浏览器下载，玩家体验与未接入时一致
       失败的跳记入 `_hopDead`（5 分钟内不再尝试），成功后清除记录 */
    const PACK_MIRROR = 'https://map-packs.beilunzhitu-map-packs.workers.dev';
    const packMirrorURL = (url) => PACK_MIRROR +
      (PACK_MIRROR.indexOf('?') < 0 ? '?' : '&') + 'u=' + encodeURIComponent(url);
    /* 对象存储的根地址（Bucket 默认域名，不带末尾斜杠）；留空表示不走该跳
       包以同名方式放在桶根目录，故只需拼接附件名，不使用 GitHub 路径
       例：'https://pdx-packs.oss-cn-hangzhou.aliyuncs.com' → .../eu4-vanilla.pdxmap */
    const PACK_OSS = 'https://beilunzhitu-map-packs.oss-cn-hangzhou.aliyuncs.com';
    const packBaseName = (url) => {
      const s = String(url || '').split('#')[0].split('?')[0];
      const n = s.slice(s.lastIndexOf('/') + 1);
      try { return decodeURIComponent(n); } catch (_) { return n; }
    };
    const packOSSUrl = (url) => PACK_OSS
      ? PACK_OSS.replace(/\/+$/, '') + '/' + encodeURIComponent(packBaseName(url))
      : '';
    const PACK_HOPS = [
      { name: 'oss',     kind: 'oss' },
      { name: 'worker',  kind: 'worker' },
      { name: 'ghfast',  prefix: 'https://ghfast.top/' },
      { name: 'ghproxy', prefix: 'https://gh-proxy.com/' },
      { name: 'ghnet',   prefix: 'https://ghproxy.net/' },
      { name: 'direct',  kind: 'direct' },
    ];
    const _hopDead = Object.create(null);
    const HOP_TTL = 5 * 60 * 1000;
    const packHopURL = (hop, url) =>
      hop.kind === 'oss' ? packOSSUrl(url) :
        hop.kind === 'worker' ? packMirrorURL(url) :
          hop.kind === 'direct' ? url : hop.prefix + url;

    const fetchOnePack = async (url, timeoutMs) => {
      const ms = timeoutMs || PACK_FETCH_TIMEOUT;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, ms) : null;
      try {
        const res = await fetch(url, ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' });
        if (!res || !res.ok) throw new Error('HTTP ' + ((res && res.status) || '?'));
        return await res.blob();
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const fetchPackBlob = async (url) => {
      const now = Date.now();
      let hops = PACK_HOPS.filter((h) => h.kind === 'direct' ||
        !(_hopDead[h.name] && now - _hopDead[h.name] < HOP_TTL));
      if (!hops.length) hops = PACK_HOPS.slice();      // 全部记为失效时当作未记录，重新开始一轮
      let lastErr = null;
      for (let i = 0; i < hops.length; i++) {
        const hop = hops[i];
        const src = packHopURL(hop, url);
        if (!src) continue;                    // 该跳未配置（如 OSS 未填写）时视为不存在
        const ms = hop.kind === 'direct' ? PACK_FETCH_TIMEOUT : PACK_HOP_TIMEOUT;
        try {
          const blob = await fetchOnePack(src, ms);
          if (hop.kind !== 'direct') delete _hopDead[hop.name];
          return blob;
        } catch (e) {
          lastErr = e;
          if (hop.kind !== 'direct') _hopDead[hop.name] = Date.now();
          try {
            if (PDXLOG && PDXLOG.warn) PDXLOG.warn('pack', '取地图包失败：' + src + ' — ' + ((e && e.message) || e));
          } catch (_) {}
        }
      }
      throw lastErr || new Error('取不到');
    };
    /* 点击一张卡 = 一次完整的「取 + 导 + 报」流程；返回可 await 的 Promise（供自动测试） */
    const downloadOne = async (a, b) => {
      if (_importing) return;                  // 已有导入在进行，不叠加
      const nm = prettyPackName(a.name);
      const note = (b && b.querySelector) ? b.querySelector('.dl-note') : null;
      if (b) b.disabled = true;
      if (note) { note.hidden = false; note.textContent = '正在读取…'; }
      setPackMsg('busy', '正在取「' + nm + '」…', 6);
      let blob = null;
      try { blob = await fetchPackBlob(a.browser_download_url); } catch (e) { blob = null; }
      if (!dlMode) return;                     // 取字节期间玩家退出下载模式，中止流程
      if (blob) {
        const ok = await importPackFlow(blob, async (r) => {
          exitDownload();                      // 先收起下载面板（它会将 #map-msg 恢复为快照）
          await afterImport(r);
          setPackMsg('done', '成功下载地图：' + r.manifest.label);
        });
        if (!ok) {
          /* 导入失败（坏包 / 格式无法识别）：importPackFlow 已在 #map-msg 写入提示
             不能调用 exitDownload：它会把该提示恢复为进入下载前的快照，玩家看不到原因
             卡片恢复可点：玩家可换一张，或按「退出下载」返回列表查看提示 */
          if (b) b.disabled = false;
          if (note) note.textContent = '没导进去，看下面的提示';
        }
        return;
      }
      /* 字节获取失败（CORS / 断网 / 超时）→ 退回浏览器下载，
         并提示拖回窗口即自动导入（拖拽入口见 onDrop） */
      try { PDXLOG.event('pack', '下载地图包 ' + a.name); } catch (_) {}
      queueDownload(a.browser_download_url, a.name);
      if (b && b.remove) b.remove();
      if (!list.querySelector('.dl-card')) exitDownload();
      setPackMsg('done', '「' + nm + '」开始下载了。下好以后把文件直接拖进这个窗口，就会自动导入。');
    };

    const drawDownloadCards = (assets) => {
      list.innerHTML = '';
      clearPackMsg();
      for (const a of assets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'map-card dl-card';
        const name = document.createElement('b');
        name.textContent = prettyPackName(a.name);
        b.appendChild(name);
        /* 就地显示该卡的进度；平时隐藏，点击后出现 */
        const note = document.createElement('span');
        note.className = 'dl-note';
        note.hidden = true;
        b.appendChild(note);
        b.onclick = () => downloadOne(a, b);
        list.appendChild(b);
      }
    };

    const enterDownload = async () => {
      const fb = $('map-fetch');
      const mb = $('map-msg');
      dlMode = true;
      if (mb) dlSnap = { hidden: mb.hidden, cls: mb.className, text: mb.textContent };
      if (fb) { fb.textContent = '✕ 退出下载'; fb.classList.add('on'); fb.disabled = true; }
      const imp = $('map-import'); if (imp) imp.style.display = 'none';
      list.innerHTML = '';
      setPackMsg('', '正在获取地图包列表…');
      let res = null;
      try {
        res = await fetchReleaseAssets();
      } catch (e) {
        if (!dlMode) return;
        if (fb) fb.disabled = false;
        setPackMsg('bad', '连不上 GitHub（' + (e && e.message ? e.message : e) + '）。再按一次按钮退出，或到发布页手动下载。');
        return;
      }
      if (!dlMode) return;
      if (fb) fb.disabled = false;
      if (!res.assets.length) {
        setPackMsg('bad', '当前版本没有附带地图包。再按一次按钮退出。');
        return;
      }
      drawDownloadCards(res.assets);
    };

    const fetchBtn = $('map-fetch');
    if (fetchBtn) fetchBtn.onclick = () => { if (dlMode) exitDownload(); else enterDownload(); };
    const bootBox = $('boot');
    if (bootBox && bootBox.addEventListener) {
      bootBox.addEventListener('dragenter', onDragEnter);   // 整页高亮
      bootBox.addEventListener('dragleave', onDragLeave);
      bootBox.addEventListener('dragover', onDragOver);
      bootBox.addEventListener('drop', onDrop);
    }

    clearPackMsg();
    render();
    box.hidden = false;
    showPickView('maps');                // 默认「开始创作」页
    /* 主菜单期间隐藏顶栏，选完图后恢复 */
    document.body.classList.add('pick-open');
    /* 仅有一套且该套为导入时，同样需要保留导入入口：
       因此不「只剩一张就跳过界面」，跳过会使玩家没有第二个入口
       （单文件版内置六七张地图，不受影响） */
  });
}
// ---- 崩溃上屏：未捕获异常 / 未处理的 Promise 直接显示在页面上 ----
// 白屏最棘手的是错误不可见；有了该面板，刷新即可看到
// 出错文件、行号与前几层调用栈。
function showFatal(msg) {
  try {
    // 同一条错误只上屏一次 —— 帧循环中的错误一秒可达 60 条，
    // 铺满屏幕会遮住第一条（第一条才是根因）
    const key = String(msg).slice(0, 200);
    state._fatals = state._fatals || new Map();
    const n = (state._fatals.get(key) || 0) + 1;
    state._fatals.set(key, n);
    if (n > 3) return;                       // 前三条留证据，其余丢弃

    let box = document.getElementById('fatal-box');
    /* 判断「结构是否已建过」不能只看 `!box`：测试桩（tools/lib/browser_stub.js）
     * 对取不到的 id 会现造一个空 div 返回，导致永远进不了该分支、按钮无法生成
     * 故用 dataset 标记，真实浏览器与测试桩下均可靠
     */
    if (!box || !box.dataset || box.dataset.pdxBuilt !== '1') {
      /* 结构为「容器 + <pre> + 一个按钮」：
       * 若 box 本身就是 <pre> 并用 `textContent +=` 追加文字，
       * 一旦内部放入按钮，追加文字会整体替换内容并抹掉按钮（textContent 为整体替换）
       * 故文字写入里层 <pre>，按钮挂在外层
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
      // 出错面板需要的两个按钮：导出日志、关闭面板
      // 面板需能随时关闭：只留「导出日志」一个按钮时，弹出后无法关闭
      // 该面板固定在屏幕底部（position:fixed; bottom:0），手机上占 45% 高度
      // 缺少关闭入口时，一次报错即永久遮挡半屏
      // 故补上「关掉」按钮
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
      /* 「刷新重试」按钮：
       * 显卡上下文丢失 / 显存紧张这类失败，刷新一次通常即可恢复
       * 面板只剩「导出日志」与「关掉」时，玩家只能自行按 F5 重来 */
      const reload = document.createElement('button');
      reload.id = 'fatal-reload';
      reload.type = 'button';
      reload.textContent = '刷新重试';
      reload.style.cssText = 'padding:7px 20px;cursor:pointer;font:inherit;'
        + 'background:#fff;color:#7a0a0a;border:0;border-radius:4px';
      reload.onclick = (ev) => {
        ev.stopPropagation();
        try { window.location.reload(); } catch (e) { /* 测试桩等特殊环境 */ }
      };
      bar.appendChild(reload);
      /* 「关掉」按钮：手机上触点较大，按钮需做大一些 */
      const close = document.createElement('button');
      close.id = 'fatal-close';
      close.type = 'button';
      close.textContent = '关掉';
      close.style.cssText = 'padding:7px 20px;cursor:pointer;font:inherit;'
        + 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6);border-radius:4px';
      close.onclick = (ev) => { ev.stopPropagation(); box.remove(); };
      bar.appendChild(close);
      box.appendChild(bar);
      /* 整条提示也可点击关闭：手机上容易点偏
       * 但按钮自身需先 stopPropagation，否则点「导出日志」会连带关闭面板 */
      box.onclick = () => box.remove();
      document.body.appendChild(box);
    }
    const pre = document.getElementById('fatal-text');
    if (pre) pre.textContent += msg + (n > 1 ? `   （同一处，第 ${n} 次）` : '') + '\n';
  } catch (e) { /* 上屏失败时忽略 */ }
}
/**
 * 黑屏时仍能显示的报错输出。
 * 不使用 showFatal：它是有样式的红条，而黑屏多发生于着色器编译失败或极早的初始化阶段，
 * 此时页面尚未正常渲染，复杂样式的红条不一定画得出来，且它挂在底部，部分机型会被遮挡。
 * 这里使用最原始的方式：带 inline style 的 <pre>，插入 body 最前面，
 * `position:fixed; top:0; z-index:最大值`，即使整屏全黑也能看见。
 * 仅在出错时插入，正常页面不显示。
 * 它与 showFatal 是两条路径，均保留：一条提供细节，一条保证可见。
 */
/**
 * 启动里程表（`#diag` 打开，默认不显示）。
 * 用途：黑屏若无异常抛出，错误捕获无法提供信息
 * （着色器编译失败会抛异常，但「画出来是黑的」不会）
 * 因此需要一条不依赖出错、持续存在的文字提示，停在何处即表示卡在哪一步。
 * 默认不显示，桌面版与手机版页面均保持干净。
 * 查看方式：地址后加 `#diag` 再打开
 * （手机上可将文件路径改为 `…/pdx-map-editor.html#diag`，
 * 或在控制台执行 `__PDX_DIAG_ON()`）
 * 使用最原始的方式（inline style + <div>），不依赖任何样式表。
 * 开关打开即可使用，无需修改代码。
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
  } catch (e) { /* 上屏失败不应影响启动 */ }
}

/* 排障模式（`#diag` / `?diag`）—— 里程表与 gl.js 中的逐帧探针均读取该标记
 * 一处开关、两处使用：gl.js 读取的是 window.__PDX_DIAG（它先于 app.js 加载）
 * 用 `let` 而非 const：控制台中的 `__PDX_DIAG_ON()` 需能当场打开（见下） */
let DIAG = (() => {
  try {
    if (typeof location === 'undefined' || !location) return false;
    return /(^|[#&?])diag\b/.test(String(location.hash || '') + String(location.search || ''));
  } catch (e) { return false; }
})();
try { window.__PDX_DIAG = DIAG; } catch (e) { /* 忽略 */ }
/* 排障时也可现开：控制台执行 __PDX_DIAG_ON()，无需刷新，当次即生效 */
try {
  const turnOn = () => {
    DIAG = true;
    window.__PDX_DIAG = true;
    bootMark('排障已打开 ✓（里程表从这一条开始）');
  };
  window.__PDX_DIAG_ON = turnOn;
  /* 仅检查启动时的 hash 不够：在地址栏后补 `#diag` 不会重载页面
   * （同文档导航只移动锚点），因此会出现「加了 #diag 却什么都没出现」
   * 故监听 hashchange：补上即当场打开（`?diag=1` 那一路本就会重载） */
  window.addEventListener('hashchange', () => {
    if (DIAG) return;
    try {
      if (/(^|[#&?])diag\b/.test(String(location.hash || ''))) turnOn();
    } catch (e) { /* 忽略 */ }
  });
} catch (e) { /* 忽略 */ }

function rawErr(msg) {
  /* 排障用的顶部红条，正式版不显示
   * 在手机黑屏问题排查时有用：出错即可看见，无需连接电脑查看控制台
   * 但手机上有一类无法获取细节的错误会不断出现：
   * Script error. @ :0   （没有文件名、没有行号）
   * 这是浏览器对本地文件中部分异常的跨域屏蔽，细节永远拿不到
   * 该类错误由导出时的 a.click() 引起，而下载本身是成功的
   * 将这类无害噪音报出来比不提示更糟（玩家会误以为出错）
   * 出错上屏已由 showFatal 面板负责，该面板为正式通道
   * 因此此处静音的是排障通道，而非「报错」
   * 需再次排障时：去掉下面的 return */
  return;
  void msg;
}
window.addEventListener('error', (e) => {
  /* 两条路径都要走，不可只留一条：rawErr 保证黑屏时也可见 */
  rawErr('✗ ' + (e.message || 'error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0)
    + (e.error && e.error.stack ? '\n' + String(e.error.stack).split('\n').slice(0, 4).join('\n') : ''));
  showFatal(`✗ ${e.message}\n  ${e.filename || ''}:${e.lineno || 0}`
    + (e.error && e.error.stack
       ? '\n' + String(e.error.stack).split('\n').slice(1, 4).join('\n') : ''));
});
window.addEventListener('unhandledrejection', (e) => {
  /* 未处理的 Promise 拒绝同样要上屏，手机上多为此类 */
  try { rawErr('✗ 未处理的 Promise 拒绝：' + ((e.reason && (e.reason.message || e.reason)) || '?')); } catch (err) { /* 忽略 */ }
  showFatal('✗ Promise 未处理: '
    + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

/* ---- 关页面 / 刷新前提醒一次 ----
 * 涂色不会自动保存（有意如此），但「有意」不等于玩家记得住
 * 按 F5 丢失半小时的涂色后，再看到说明也无济于事
 * 因此仅在「有改动且尚未导出」时询问一次
 * · 存过地图仓库 / 导出过 / 导入过工程 → 视为已有备份，不再提示
 * · 「回主菜单」有自己的暂存（goHome → stashNow）→ 不算丢失
 */
window.addEventListener('beforeunload', (e) => {
  if (!state.meta || state._exported) return;
  if (!(state.changed && state.changed.size)) return;
  e.preventDefault();
  e.returnValue = '';     // Chrome 需要这一句才生效
});

// 显存数据与上下文恢复
//
// 手机切到其他应用 / 锁屏 / 切换标签页后返回，画面为黑，这在手机上几乎必然发生：
// · 系统会整体回收 WebGL 上下文以节省显存（iOS 尤其明显）
// · 上下文丢失后显存中的全部内容消失：地图 id 图、归属表、颜色表、涂色层
// · 只处理 lost（并对浏览器 preventDefault）而不处理 restored，
// 导致返回时上下文正常、显存为空、`dirty` 仍为 false，画面不再重绘，持续黑屏
//
// gl.js 重建与上下文绑定的资源，这里重新上传数据
// 笔迹无需处理：`paintData` 是 CPU 侧数组，始终保留
// （setData 中特意保留「尺寸一致则保留」的逻辑，否则重传会清掉涂色）

/**
 * 把地图数据上传到显卡。
 * 开图时执行一次；上下文丢失恢复后再执行一次。
 * @param {(name: string) => void} [tick] 开图路径的细分计时（恢复时不传）
 */
async function uploadMapToGpu(tick) {
  const say = typeof tick === 'function' ? tick : () => {};
  /* 换图时清空国旗：旗帜按 pid 记录，换图后 pid 全部改变，保留会造成错位
   * 上下文丢失恢复时不能清空：此情况尺寸相同、key 不变 */
  const _fk = (state.meta.mapWidth | 0) + 'x' + (state.meta.mapHeight | 0)
    + '|' + (state.meta.numProvinces | 0);
  if (state._flagMapKey !== _fk) {
    state._flagMapKey = _fk;
    state.flags = [];
    state.flagSel = -1;
    state.flagPickSeeds = false;
    try {
      if (state._flagAtlasCtx) {
        const _AS2 = state._flagAtlasSize || 2048;
        state._flagAtlasCtx.clearRect(0, 0, _AS2, _AS2);
      }
      flagSyncPanel();
    } catch (e) { /* 忽略 */ }
  }
  await renderer.setData({
    provinceIds: state.provinceIds,
    titlemap: state.titlemap,
    colors: state.titles.colors,
    // 分块清单必须传入：缺少这一行时，渲染器会按「整图模式」创建
    // 16384×8192 的纹理，而只拿到 1 个元素的占位数组，导致 WebGL 报
    // "ArrayBufferView not big enough"、纹理不完整，画面全白。
    tiles: state.tiles || null,
  });
  say('上传地图纹理');
  // 不调用 `renderer.setProvColors` / `setWaterMask`：
  // 「水域 · 颜色」色源与水域标签不传给渲染器，数据保留在 state 备查
  // gl.js 中对应的 uniform / API 已同步移除，两边口径一致
  /* 最细层层号需告知渲染器：
   * 荒地自动色记录在每块荒地自己的 `wl_<pid>` 节点上，着色器按 `uFineTier` 查询
   * 不能用 `uEditTier`：剧本视图未开粒度时它等于剧本层，而荒地在剧本层没有节点 */
  try {
    const _nt = (state.meta && Array.isArray(state.meta.tiers)) ? state.meta.tiers.length : 0;
    if (_nt > 0 && renderer && renderer.setFineTier) renderer.setFineTier(_nt - 1);
  } catch (e) { /* 忽略 */ }
  /* 国旗也需重新上传：
   * 这是上下文丢失恢复的正确路径：旗帜数据在 CPU 侧未丢失，
   * 但显存中的三张纹理已全部消失，不重传则切到后台再返回后旗帜消失 */
  try { flagPushGpu(true); } catch (e) { console.warn('[flag] 重传失败', e); }
  // 每块荒地的 LUT 初始值为荒地灰（即未上色时的颜色）
  paintWasteGrey();
  say('荒地起手灰');
  syncParentBorder();
  /* 把恢复后的设置推给渲染器：仅在面板中修改时 applySettings 不够，
   * 刷新 / 回主菜单后该设置需在开图时即生效 */
  applySettings();
  syncAllPaintLabels();
  /* 荒地：任何视图下都显示「荒地色」。
   * 调用位置必须在 `renderer.setData` 之后：
   * openMap 链路中 renderer 是之后才 `new MapRenderer(...)` 的，
   * 若提前调用，`if (renderer && ...)` 会跳过，标记一个也打不上。
   * 放在此处另有益处：上下文丢失恢复时本函数会再执行一遍，
   * 标记可随重建的 LUT 一并补回，否则切到后台再返回标记即丢失。
   * 生效方式：把标记打在 LUT 的 alpha 通道上，
   * 着色器在 `tid == NONE` 的早退前先检查它；
   * 剧本层荒地没有归属，若不检查会被 `uUnpainted`(150,150,150) 覆盖，
   * 表现为「剧本模式把已画好的荒地颜色覆盖成 150,150,150」。
   * 名单使用现成的 `meta.wasteland`（`isWastelandTid()` 读取它），
   * 不用 `kindTidMap()` 筛 kind 6：EU4 的身份标中 kind=6 一条也没有
   * （只有海 / 湖），按此筛会得到空清单，一块都打不上；海洋显示为蓝色即为此故。
   * 该色即设置中「不可通行区域」那一行的颜色，
   * `applySettings()`（上一句）刚按它刷过 LUT，此处只打「认它」的标记。 */
  try {
    const _wl = new Set((state.meta && state.meta.wasteland) || []);
    /* 再补上逐块识别出的节点：部分包的 meta.wasteland 只登记了粗层区域，
     * 最细的 wl_<pid> 未列入，仅按名单打会漏标 */
    if (state.wasteFineTid) {
      for (const t of state.wasteFineTid) if (t >= 0) _wl.add(t);
    }
    if (renderer && renderer.setWasteFixed) renderer.setWasteFixed(_wl);
  } catch (e) { /* 标记失败不应影响开图 */ }
  /* 标记完成后立即计算自动色（在第一帧前就位）
   * 顺序不可颠倒：先 setWasteFixed 打 alpha，再把 RGB 写成算出的色；
   * `setLutColor` 只改 RGB、不改 alpha，标记不会丢失 */
  try { state._wasteSig = null; refreshWasteAuto(); } catch (e) { /* 忽略 */ }
  reuploadTiles();
  say('设置 + 标签同步');
}

/**
 * 分块路径（EU5 原尺寸）：把已读取且仍在缓存中的块重新上传
 * 上下文丢失后显存中的块消失，而 CPU 侧仍保留（tileMap.cache），
 * 因此无需重新下载解压，直接重传即可
 * 只上传缓存中已有的块：未进入过视野的块本就没上传过，帧循环会按视野补齐
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

/* 上下文恢复后的重建工作（由 gl.js 的 restored 事件触发） */
let ctxRestoring = false;
async function restoreGpuAfterContextLoss() {
  if (ctxRestoring) return;
  ctxRestoring = true;
  clearTimeout(state._ctxWaitTimer);       // 可撤销等待恢复的定时器
  const t0 = performance.now();
  LOG.event('WebGL 上下文已恢复', '重新喂地图数据');
  try {
    await uploadMapToGpu();
    refreshBorderField();                  // 粗筛位图（仅桌面端创建，手机上自动跳过）
    renderer.dirty = true;
    invalidate();                          // 视角未变，重画一帧
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
 * 回到前台（手机切出后返回 / 解锁 / 从其他标签页切回）：
 * 三件事均需执行，缺少任一件都会导致「回来仍然黑屏」
 * ① 重新测量画布尺寸：浏览器地址栏 / 工具栏此时可能收起，
 * 而画布按 clientWidth 确定尺寸，不重新测量会导致画面拉伸或留边
 * ② 强制重画一帧：切后台期间 requestAnimationFrame 被冻结，
 * 返回时若没有其他操作触碰 dirty，该帧不会到来
 * ③ 上下文未恢复时给出提示出口（黑屏上没有任何信息最难排查）
 * （正常路径为 restored 事件 → restoreGpuAfterContextLoss，此处只处理异常）
 */
function onEnterForeground() {
  if (!state.meta || !renderer) return;
  if (typeof document !== 'undefined' && document.hidden) return;   // 仍在后台，不处理
  try { renderer.resize(); } catch (e) { /* 尺寸读取失败，下一帧会重试 */ }
  try { if (labels) labels.resize(); } catch (e) { /* 忽略 */ }
  invalidate();
  labelDirty = true;
  if (!renderer.ctxLost) return;
  /* 上下文仍处于丢失状态：部分机型不发 restored 或延迟发送
   * 等 3 秒；仍丢失则明确提示可刷新恢复，避免玩家面对黑屏猜测 */
  clearTimeout(state._ctxWaitTimer);
  state._ctxWaitTimer = setTimeout(() => {
    if (!renderer || !renderer.ctxLost) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    LOG.event('上下文未恢复', '提示用户刷新');
    showFatal('✗ 显卡的 WebGL 上下文已丢失且未恢复，地图为空白。\n'
      + '刷新页面后可重新开始（如需保留手绘涂色，请先导出）。');
  }, 3000);
}

/** 等待显卡上下文恢复 / 为重试留出时间
 * · 上下文丢失的恢复依赖 `webglcontextrestored` 事件，部分浏览器会延迟数百毫秒
 * · 超时也继续执行 —— 下一轮 `getContext` 会自行判断是否已恢复 */
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

/** 创建渲染器，遇到「上下文丢失 / 显存紧张」时自动重试
 * 这两类均为暂时性失败（显卡刚被重置、其他页面刚占用显存、手机刚切过后台），
 * 等待后重试通常即可恢复
 * `no-webgl2` 也重试一次：GPU 进程繁忙 / 上下文创建超时属于暂时性问题
 * 着色器确实编译失败则不重试（重试结果相同）
 */
/* gl.js 中有两套错误来源：RendererSetupError（stage）与 shaderErr（code），
   统一为 stage，否则从 _build 中抛出的 CTX_LOST 不会被重试 */
function _stageOfError(err) {
  if (err && err.stage) return err.stage;
  const code = err && err.code;
  if (code === 'CTX_LOST') return 'context-lost';
  if (code === 'COMPILE') return 'shader-compile';
  if (code === 'LINK') return 'shader-link';
  return '';
}

/**
 * 后台将着色器编译到可用的最高档
 * 开图时先用低一档（2 秒内出图），此处空闲时编译完整版；
 * 支持 `KHR_parallel_shader_compile` 时完全不阻塞界面
 * 升级成功会替换 program，下一帧即为完整效果
 */
function startShaderUpgrade() {
  if (!renderer) return;
  /* 一次未升级成功需重试：Firefox 上可能长期停留在「最简边界」，
   * 失败即静默放弃会让它一直停在最低档；故最多尝试 3 次，最终停在哪一档写入诊断报告 */
  const run = (attempt) => {
    if (!renderer) return;
    try {
      renderer.upgradeShader().then((ok) => {
        if (ok) {
          try {
            LOG.event('渲染升级', '着色器已升到「' + (renderer.shaderTier || '?') + '」');
            renderer.dirty = true;
          } catch (e) { /* 忽略 */ }
          return;
        }
        if (attempt < 3 && renderer.shaderTier !== 'full' && !renderer.softwareGL) {
          setTimeout(() => run(attempt + 1), 3000 * attempt);
          return;
        }
        try {
          LOG.event('渲染升级', '停在「' + (renderer.shaderTier || '?') + '」档（详见控制台警告）');
        } catch (e) { /* 忽略 */ }
      }).catch(() => {});
    } catch (e) { /* 忽略 */ }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run(1), { timeout: 3000 });
  else setTimeout(() => run(1), 1200);
}

async function createRendererWithRetry(meta, opts) {
  const o = opts || {};
  /* `fastBoot`：先以低一档着色器出图，完整版在后台升级
     AMD 610M 上完整着色器首次链接 39 秒（缓存命中后 43 ms），
     等待 39 秒会被当作程序故障，因此先出图、再升级 */
  const make = (typeof o.make === 'function') ? o.make : () => new MapRenderer($('map'), meta, { fastBoot: true });
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
      } catch (e) { /* 日志失败不影响主流程 */ }
      if (!retryable || attempt >= 3) throw err;
      if (stage === 'no-webgl2' && attempt >= 2) throw err;   // 这一类只试一次
      setBoot(stage === 'context-lost'
        ? `显卡渲染环境被系统回收，正在重试（第 ${attempt} 次 / 共 3 次）…`
        : stage === 'no-webgl2'
          ? `显卡渲染环境未能建立，正在重试（第 ${attempt} 次 / 共 3 次）…`
          : `显卡内存紧张，正在重试（第 ${attempt} 次 / 共 3 次）…`, 90);
      await wait(attempt === 1 ? 700 : 1500);
    }
  }
  throw lastErr;
}

/**
 * 把渲染器初始化失败翻译成可读的提示。
 * `new MapRenderer()` 抛出的异常不一律归为「着色器编译失败」：
 * 真正的原因常常是 WebGL 上下文创建失败或建到一半丢失，
 * 与着色器源码无关。
 * @param {Error} err 带 `stage` / `detail` 的 `RendererSetupError`（见 gl.js）
 * @returns {{code:string,title:string,body:string,steps:string[],facts:string}}
 */
/* 降级档位省掉的通道 → 界面上看得懂的名字 ✓（诊断报告 / 启动日志共用）*/
const CUT_CHANNEL_NAMES = {
  title: '本层边界', paint: '填色边界', extra: '父级/剧本边界',
  water: '水域边界', waste: '荒地边界',
};
function cutChannelNames(list) {
  return (list || []).map((k) => CUT_CHANNEL_NAMES[k] || k).join(' / ');
}

function describeRendererFailure(err) {
  const stage = _stageOfError(err) || 'renderer';
  const d = (err && err.detail) || {};
  const raw = String((err && err.message) || err || '');
  /* iOS / iPadOS：所有浏览器都是 WebKit，且 iOS 15 以下没有 WebGL2。
     "换 Chrome / Edge" 在苹果上是废话 ✓（2026-11-10）*/
  const _ios = isAppleTouch();
  const facts = [
    d.unmaskedRenderer ? '显卡 ' + d.unmaskedRenderer
      : (d.renderer ? '渲染器 ' + d.renderer : ''),
    d.version ? 'GL ' + d.version : '',
    d.softwareGL ? '⚠ 软件渲染（没用上显卡）' : '',
    d.linkMs ? '着色器链接耗时 ' + d.linkMs + ' ms' + (d.linkMs > 5000 ? '（真显卡通常 <100ms）' : '') : '',
    d.contextLost ? '上下文已丢失' : '',
    d.creationError ? '创建失败原因：' + d.creationError : '',
    d.glError ? 'glError=' + d.glError : '',
    d.maxTex ? '贴图上限 ' + d.maxTex + 'px' : '',
  ].filter(Boolean).join(' · ');

  if (stage === 'no-webgl2') {
    if (_ios) {
      return {
        code: 'WEBGL2_UNAVAILABLE',
        title: '这台 iPhone / iPad 没有提供地图渲染所需的 WebGL2',
        body: 'iOS 15 起 Safari 才支持 WebGL2。iOS 上的 Chrome / Edge 也使用 WebKit 内核，'
          + '换浏览器不会补上这个能力。',
        steps: [
          '打开「设置 → 通用 → 软件更新」，升级到 iOS / iPadOS 15 或更高版本',
          '用 Safari 打开这个页面（不要在「文件」预览里打开）',
          '升级后重启设备，再重试',
          '若仍无法解决，请点击下方「导出日志」并反馈给作者',
        ],
        facts,
      };
    }
    return {
      code: 'WEBGL2_UNAVAILABLE',
      title: '这个浏览器不支持地图渲染所需的图形功能（WebGL2）',
      body: '编辑器需要 WebGL2 才能画地图。常见原因：浏览器关掉了硬件加速、'
        + '显卡驱动太旧、远程桌面 / 虚拟机 / 旧显卡，或者浏览器策略禁用了 WebGL。',
      steps: [
        '在浏览器设置中开启「使用硬件加速」，然后重启浏览器后重试',
        '手机自带浏览器（vivo / 华为 / 小米等）有时会禁用 WebGL2，请改用 Chrome 打开',
        '更新显卡驱动；退出远程桌面或虚拟机后重试',
        '换用最新版 Chrome / Edge（Firefox 亦可）',
        '若仍无法解决，请点击下方「导出日志」并反馈给作者',
      ],
      facts,
    };
  }
  if (stage === 'context-lost') {
    return {
      code: 'WEBGL_CONTEXT_LOST',
      title: '显卡上下文已丢失，且未能自动恢复',
      body: '浏览器或显卡丢失了 WebGL 上下文，常见原因包括：显存不足、显卡驱动重置、'
        + '刚从后台切回、手机省电模式，或同时打开过多大型页面。编辑器已自动重试两次，'
        + '均未能恢复，暂时无法继续渲染。',
      steps: [
        '点击「刷新重试」，通常即可恢复',
        '关闭其他占用显存的标签页、游戏和视频，然后重试',
        _ios
          ? 'iPhone / iPad：先返回桌面再切回 Safari；仍不行就重启 Safari 或设备'
          : '手机端：先返回桌面再切回浏览器，或改用 Chrome / Edge',
        '若仍未恢复，请导出日志反馈（其中包含显卡型号与 GL 版本）',
      ],
      facts,
    };
  }
  if (stage === 'out-of-memory') {
    return {
      code: 'GPU_OUT_OF_MEMORY',
      title: '显卡内存不足，无法显示这张地图',
      body: '这张地图的纹理和着色器把显存吃满了。常见于手机、老旧集显，'
        + '或者浏览器同时开了很多大页面。',
      steps: [
        '关闭其他标签页 / 游戏 / 视频，然后点击「刷新重试」',
        '换用尺寸更小的地图（例如 EU5 原版而非原尺寸）',
        '若仍然失败，请更换设备，或将日志反馈给作者',
      ],
      facts,
    };
  }
  if (stage === 'shader-compile' || stage === 'shader-link') {
    const log = String(d.log || '').trim();
    /* 软件渲染要单独提示：
     * 报告里 `渲染器 WebKit WebGL`（没有 unmasked 显卡名）且「上传到显卡 → 失败」
     * 耗时 92 秒 —— 这是 SwiftShader 在 CPU 上执行这个巨大的片元着色器
     * （真显卡上只需几毫秒），软件光栅器往往连指令数都不够，直接链接失败。
     * 此时提示「换浏览器 / 更新驱动」没有作用，照着做仍是白屏，
     * 应直接指出需开启硬件加速，并说明开关位置。 */
    if (d.softwareGL) {
      return {
        code: stage === 'shader-compile' ? 'SHADER_COMPILE_FAILED' : 'SHADER_LINK_FAILED',
        title: _ios
          ? '这台 iPhone / iPad 正在使用软件渲染，性能不足以显示这张地图'
          : '这台电脑正在使用软件渲染，性能不足以显示这张地图',
        body: (_ios
          ? 'iPhone / iPad 没有启用显卡渲染，而是由 CPU 逐像素计算（软件渲染）。'
          : '浏览器没有启用显卡，而是由 CPU 逐像素计算（软件渲染 / SwiftShader）。')
          + '同一着色器在真实显卡上仅需几毫秒，此处却需一分多钟，且常常直接失败。'
          + (log ? '\n驱动给的日志：' + log : '')
          + '\n**问题不在地图或编辑器本身**，而是这台设备的浏览器没有启用显卡加速。',
        steps: _ios ? [
          'iPhone / iPad 没有「硬件加速」开关：请升级到 iOS 15 及以上，并用 Safari 打开',
          '升级后重启设备，再重试',
          '若均无效，请点击「导出诊断报告」，其中包含渲染器名称',
        ] : [
          'Edge：设置 → 系统和性能 → 开启「使用图形加速」，然后重启浏览器',
          'Chrome：设置 → 系统 → 开启「使用可用的硬件加速」，然后重启浏览器',
          '确认未在远程桌面或虚拟机中打开（这两种环境通常只能软件渲染）',
          '开启后可访问 edge://gpu 或 chrome://gpu，确认「WebGL」一项为 Hardware accelerated',
          '若均无效，请点击「导出诊断报告」，其中包含渲染器名称',
        ],
        facts,
      };
    }
    return {
      code: stage === 'shader-compile' ? 'SHADER_COMPILE_FAILED' : 'SHADER_LINK_FAILED',
      title: '这台设备的显卡无法完成地图渲染（着色器' + (stage === 'shader-compile' ? '编译' : '链接') + '失败）',
      body: (log ? '驱动给的日志：' + log : '驱动没有给出日志（常见于指令数 / 寄存器超限）。')
        + '\n此处属于真实的着色器问题；若日志中没有语法错误，通常是该设备的显卡或驱动能力不足。',
      steps: [
        '更新显卡驱动，或换用最新版浏览器',
        '旧显卡或手机可能存在显存 / 指令数不足，建议更换设备',
        '导出日志反馈给作者（其中包含显卡型号与 GL 版本）',
      ],
      facts,
    };
  }
  if (stage === 'texture-limit') {
    return {
      code: 'TEXTURE_LIMIT',
      title: '这台设备的显卡不支持这么大的地图',
      body: '显卡报告的单张纹理上限为 ' + (d.maxTex || '?') + 'px，不足以容纳地图的最小切片。',
      steps: ['更换设备，或使用最新版浏览器', '请将日志反馈给作者（属于设备限制，并非地图文件问题）'],
      facts,
    };
  }
  return {
    code: 'RENDERER_INIT_FAILED',
    title: '地图显示初始化失败',
    body: raw || '没有拿到更具体的原因。',
    steps: ['点「刷新重试」再开一次', '仍然失败 → 导出日志发给作者'],
    facts,
  };
}

/* 把分类后的渲染器失败上屏（带步骤 + 技术信息） */
function showRendererFailure(fail) {
  const lines = ['✗ ' + fail.title, '', fail.body];
  if (fail.steps && fail.steps.length) {
    lines.push('');
    fail.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  if (fail.facts) lines.push('', '技术信息：' + fail.facts);
  showFatal(lines.join('\n'));
}

/** 启动时渲染器失败的统一出口（建渲染器 / 灌数据两处共用）
 * 上屏 + 写日志 + 把启动屏停在可读提示上 */
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
  } catch (e) { /* 忽略 */ }
  showRendererFailure(fail);
  setBoot(fail.title, 100);
  const _bs = $('boot-step');
  if (_bs) _bs.style.color = 'var(--danger)';
  return fail;
}

// 自写调色器
//
// 原生 `<input type="color">` 弹出的是系统拾色器：Windows 上为一块小方板，
// 手机上为系统色轮，与编辑器界面风格不一致，也无法在两端共用一套手势。
// 因此改为自绘调色面板。
//
// 做法：不更换任何 input
// 捕获阶段截住点击 → 弹出面板 → 选完把值写回 input，再派发 input/change
// —— bindColor / 画笔接线无需改动
// （`#brush-color` 是 `.swatch-input`，1px 透明只作取值用，位置按大色块计算）

const CP = { input: null, anchor: null, h: 0, s: 1, v: 1, rgb: [200, 50, 50], bound: false };

/* RGB(0~255) → HSV（h 0~360，s/v 0~1） */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx > 0 ? d / mx : 0, v: mx };
}

/* HSV → RGB(0~255) */
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/* 把面板状态对准一个 RGB */
function cpSetRgb(rgb) {
  const o = rgbToHsv(rgb[0] | 0, rgb[1] | 0, rgb[2] | 0);
  CP.h = o.h; CP.s = o.s; CP.v = o.v;
  CP.rgb = [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0];
}

/* 画饱和/明度方块 + 色相条（每次拖动重画；尺寸小，开销可忽略） */
function cpDraw() {
  const sv = $('color-pop-sv'), hue = $('color-pop-hue');
  if (!sv || !hue) return;
  const w = sv.width, h = sv.height;
  const ctx = sv.getContext('2d');
  const base = hsvToRgb(CP.h, 1, 1);
  ctx.fillStyle = rgbToHex(base);
  ctx.fillRect(0, 0, w, h);
  let g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  /* 选中的那一点：白圈 + 深色外圈（深浅色背景上都可见） */
  const px = CP.s * w, py = (1 - CP.v) * h;
  ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.stroke();

  const hw = hue.width, hh = hue.height;
  const hc = hue.getContext('2d');
  const hg = hc.createLinearGradient(0, 0, 0, hh);
  for (let i = 0; i <= 6; i++) hg.addColorStop(i / 6, rgbToHex(hsvToRgb(i * 60, 1, 1)));
  hc.fillStyle = hg; hc.fillRect(0, 0, hw, hh);
  const hy = (CP.h / 360) * hh;
  hc.fillStyle = '#fff'; hc.fillRect(0, clamp(hy - 1.5, 0, hh - 3), hw, 3);
  hc.fillStyle = 'rgba(0,0,0,.5)'; hc.fillRect(0, clamp(hy - 2.5, 0, hh - 1), hw, 1);
}

/* 面板 → 状态：重算 rgb、重画、刷新 HEX / 预览 */
function cpSync() {
  CP.rgb = hsvToRgb(CP.h, CP.s, CP.v);
  cpDraw();
  const hex = rgbToHex(CP.rgb);
  const hx = $('color-pop-hex');
  if (hx && document.activeElement !== hx) hx.value = hex;
  const pv = $('color-pop-preview');
  if (pv) pv.style.background = hex;
}

/* 最近用过的颜色即现成色板（点击换用面板中的颜色） */
function cpPresets() {
  const box = $('color-pop-presets');
  if (!box) return;
  box.innerHTML = '';
  for (const e of (state.recent || []).slice(0, 12)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp-chip';
    b.style.background = rgbToHex(e.rgb);
    b.onclick = () => { cpSetRgb(e.rgb); cpSync(); cpCommit(); };
    box.appendChild(b);
  }
}

/* 摆位置：桌面贴控件下方、放不下则翻到上方；窄屏（手机）作为底部弹层 */
function cpPlace() {
  const pop = $('color-pop');
  if (!pop || pop.hidden) return;
  const el = CP.anchor || CP.input;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const pw = pop.offsetWidth || 272, ph = pop.offsetHeight || 320;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = r.left, y = r.bottom + 6;
  if (vw < 560) {
    x = Math.max(8, (vw - pw) / 2);
    y = Math.max(8, vh - ph - 12);
  } else {
    if (x + pw > vw - 8) x = vw - pw - 8;
    if (x < 8) x = 8;
    if (y + ph > vh - 8) y = Math.max(8, r.top - ph - 6);
  }
  pop.style.left = Math.round(x) + 'px';
  pop.style.top = Math.round(y) + 'px';
}

/* 打开：目标 input + 用于定位的可见元素（缺省用 input 自身） */
function cpOpen(input, anchor) {
  if (!input) return;
  cpBind();
  const pop = $('color-pop');
  if (!pop) return;
  CP.input = input;
  CP.anchor = anchor || input;
  const cur = hexToRgb(input.value) || (Array.isArray(state.brush) ? state.brush : [200, 50, 50]);
  cpSetRgb(cur);
  cpPresets();
  pop.hidden = false;
  cpSync();
  cpPlace();
}

function cpClose() {
  const pop = $('color-pop');
  if (pop) pop.hidden = true;
  CP.input = null;
  CP.anchor = null;
}

/** 把面板当前色写回目标 input（不关面板；拖动松手 / 点色板时使用）
 * 写回后照既有接线派发 input + change —— bindColor 与画笔接线均监听这两个事件 */
function cpCommit() {
  const inp = CP.input;
  if (!inp) return;
  const hex = rgbToHex(CP.rgb);
  if (inp.value === hex) return;
  inp.value = hex;
  /* `new Event` 的 target 在自检桩中为 null（图例那条 e.target.value 会报错），
     此处补上 target —— 真浏览器同样适用 */
  const fire = (type) => {
    const ev = new Event(type, { bubbles: true });
    try { Object.defineProperty(ev, 'target', { value: inp, configurable: true }); } catch (_) {}
    inp.dispatchEvent(ev);
  };
  fire('input');
  fire('change');
}

/* 确定：写回原生 input，再走既有接线（bindColor 监听 input + change） */
function cpApply() {
  cpCommit();
  cpClose();
}

function cpBind() {
  if (CP.bound) return;
  const pop = $('color-pop');
  if (!pop) return;
  CP.bound = true;
  const sv = $('color-pop-sv'), hue = $('color-pop-hue');
  let drag = 0;
  const svAt = (ev) => {
    const r = sv.getBoundingClientRect();
    CP.s = clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
    CP.v = 1 - clamp((ev.clientY - r.top) / Math.max(1, r.height), 0, 1);
    cpSync();
  };
  const hueAt = (ev) => {
    const r = hue.getBoundingClientRect();
    CP.h = clamp((ev.clientY - r.top) / Math.max(1, r.height), 0, 1) * 360;
    cpSync();
  };
  const grab = (el, fn, which) => {
    el.addEventListener('pointerdown', (ev) => {
      drag = which;
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* 早期 WebView 没有 setPointerCapture */ }
      fn(ev);
      ev.preventDefault();
    });
    el.addEventListener('pointermove', (ev) => { if (drag === which) fn(ev); });
    el.addEventListener('pointerup', () => { if (drag) { drag = 0; cpCommit(); } });
    el.addEventListener('pointercancel', () => { drag = 0; });
  };
  grab(sv, svAt, 1);
  grab(hue, hueAt, 2);
  $('color-pop-ok').onclick = cpApply;
  $('color-pop-close').onclick = cpClose;
  const hx = $('color-pop-hex');
  hx.addEventListener('input', () => {
    const rgb = hexToRgb(hx.value);
    if (rgb) { cpSetRgb(rgb); cpDraw(); cpCommit(); }
  });
  hx.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); cpApply(); }
  });
  /* 点外部收起（捕获阶段：避免画布 / 下拉先消费这一次点击） */
  document.addEventListener('pointerdown', (ev) => {
    if (pop.hidden) return;
    const t = ev.target;
    if (pop.contains(t)) return;
    if (t && t.closest && t.closest('input[type="color"]')) return;
    /* 收起这一次点击不要落到画布上（否则关闭面板时会顺带涂上一笔） */
    ev.stopPropagation();
    cpClose();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (pop.hidden || ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    cpClose();
  }, true);
  window.addEventListener('resize', cpPlace);
}

/* 接管系统拾色器：所有 `<input type="color">` 均走自绘面板 */
function cpInstall() {
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    const inp = t && t.closest ? t.closest('input[type="color"]') : null;
    if (!inp) return;
    ev.preventDefault();
    ev.stopPropagation();
    cpOpen(inp);
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const t = ev.target;
    if (!(t && t.matches && t.matches('input[type="color"]'))) return;
    if (t.classList && t.classList.contains('swatch-input')) return;
    ev.preventDefault();
    ev.stopPropagation();
    cpOpen(t);
  }, true);
}

cpInstall();

/* 设置里的「?」小提示（晦涩设置加问号，悬停出说明）
   原生 title 悬停已全部删除；这是自绘气泡。文案写在 HTML 的 data-help 上，
   这里只负责显示 —— 鼠标悬停 / 键盘聚焦 / 手机点一下均可 */
function helpTipInstall() {
  let tip = null;
  let timer = 0;
  let cur = null;
  const q = (ev) => (ev.target && ev.target.closest ? ev.target.closest('.help-q') : null);
  const ensure = () => {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'help-tip';
    tip.className = 'help-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  };
  const hide = () => {
    clearTimeout(timer);
    timer = 0;
    cur = null;
    if (tip) tip.hidden = true;
  };
  const place = (el) => {
    const t = ensure();
    const txt = el.getAttribute('data-help') || '';
    if (!txt) return;
    t.textContent = txt;
    t.hidden = false;
    const r = el.getBoundingClientRect();
    const tw = t.offsetWidth;
    const th = t.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
    let y = r.bottom + 8;
    if (y + th > window.innerHeight - 8) y = r.top - th - 8;
    if (y < 8) y = 8;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  };
  const show = (el) => {
    if (!el || !el.getAttribute('data-help')) return;
    cur = el;
    clearTimeout(timer);
    timer = setTimeout(() => { if (cur === el) place(el); }, 100);
  };
  document.addEventListener('pointerover', (ev) => {
    if (ev.pointerType && ev.pointerType !== 'mouse') return;
    const el = q(ev);
    if (el) show(el);
  });
  document.addEventListener('pointerout', (ev) => {
    const el = q(ev);
    if (el && el === cur) hide();
  });
  document.addEventListener('focusin', (ev) => {
    const el = q(ev);
    if (el) show(el);
  });
  document.addEventListener('focusout', (ev) => {
    const el = q(ev);
    if (el && el === cur) hide();
  });
  document.addEventListener('click', (ev) => {
    const el = q(ev);
    if (!el) { if (cur) hide(); return; }
    ev.preventDefault();
    ev.stopPropagation();
    if (cur === el && tip && !tip.hidden) hide();
    else { cur = el; place(el); }
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
helpTipInstall();

async function boot() {
  /* 启动期间自行打心跳：即使卡在一个很长的 await 上（读大图包要几十秒），
   * 只要主线程仍在运转，看门狗就不会误报「没能启动」 */
  const _hbTimer = setInterval(() => {
    try { if (window.PDXLOG && window.PDXLOG.tick) window.PDXLOG.tick('启动中…'); } catch (e) { /* 忽略 */ }
  }, 5000);
  try {
    // 启动屏那条静态兜底提示：脚本跑起来了即隐藏（它只在「脚本未运行」时才有意义）
    // 用 hidden 而非 remove() —— 测试用的假 DOM（tools/lib/browser_stub.js）未实现 remove
    const _bh = document.getElementById('boot-hint');
    if (_bh) _bh.hidden = true;
    LOG.event('启动');
    setBoot('正在读取地图列表…', 3);
    const maps = await availableMaps();
    /* 「跨剧本搜国家」要按这张清单去借别家的 meta
       走服务时是 HEAD 探到的目录，单文件版是内嵌的那几张 */
    AVAILABLE_MAPS = maps;    /* 一张图都没有也应能进入
                                 单文件版默认不内嵌地图（约 0.6 MB，地图改为 .pdxmap 包单独下载）——
                                 此时「第一屏」本就是「还没有地图，导入一个进来」
                                 若直接抛错并提示去跑 build_data.py，那是开发者才该看到的信息，
                                 玩家打开一个 0.6 MB 的文件看到这句，只会认为程序损坏
                                 （页面上「请点击导入按钮，或将 .pdxmap 文件直接拖进这一页。」
                                 已在下方提示框中给出，进度条这边不再重复） */
    if (!maps.length) {
      LOG.event('地图', '一张都没有（轻量版？还是缓存没建）—— 让玩家导入地图包');
    }

    const chosen = await pickMap(maps);
    /* 仓库载入的存档挂在这条选单上（见 storePickMapFor）—— 记录，就绪后应用 */
    if (chosen.__project) state._pendingProject = chosen.__project;
    state.mapEmb = String(chosen.emb || chosen.key || '');
    LOG.event('选图', String(chosen.label || '')
      + (chosen.pack ? '（导入的地图包 ' + chosen.pack + '）'
         : isEmbedded() ? '（单文件内嵌）' : '（' + chosen.dir + '）'));
    if (chosen.pack) setPackMap(chosen.pack);
    else if (isEmbedded()) setEmbeddedMap(chosen.emb);
    else setDataDir(chosen.dir);

    setBoot(`正在读取「${chosen.label}」的地图信息…`, 6);
    const meta = await api.meta();
    if (!meta || !meta.numTitles) throw new Error('地图数据缺失，请重新导入地图包');
    state.meta = meta;
    /* 每块地自己的原色（数据保留备用）
     * meta.provColors = base64 的 RGBA8，长度 = numProvinces × 4
     * （第 4 个字节表示「这块地有没有登记色」，构建期写入，见 build_data.py）
     * 前端不再用它做「水域显示地块原色」的特判，解出来只存进 state 备查 */
    state.provColors = decodeProvColors(meta);
    /* 水域标签（数据保留备用 —— 不传给渲染器）
     * `meta.waterMask` 解出来存 state，留有其他读水处
     * isWaterPid / isWaterHere 仍从它查询（认水判据保留，取消的只是使用场景） */
    state.waterMask = decodeWaterMask(meta);
    /* 身份标（底层 pid 的类别，七行颜色的唯一判据）
     * 早期包没有 → null → 判据退回键名前缀 */
    state.kindMask = decodeKindMask(meta);
    state._kindMap = null;                    // 换图 → 头衔→类别那张表作废
    state._kindMapKey = '';
    /* 「每省是不是水」那张表（给「水域 · 边界」用）
     * 必须排在 `state.titles` 之后算 —— 早期包那条退路要读键名
     * 所以这里先置空，等 titles 取回来再算一次（见下面）
     * 置空这一步不能省：另一张图的表若留着，
     * 新图前几帧会拿着别的图的水域画边界（表现为「水域边界全是乱的」） */
    state.waterKindArr = null;
    /* 设置与最近颜色按游戏类型接回来（刷新 / 回主菜单都不丢）
     * 同款游戏的图共用一套：TNO 和钢铁雄心4原版是同一份设置（见 prefsKeyOf）
     * 这份与「涂色暂存」是分开的两份 —— 后者回主菜单才存、F5 即清（见 saveProject 上面的说明）
     * 接回来之后 `applySettings()` 会把它推给渲染器（renderer 建好之后调一次，见下面） */
    {
      const prefs = loadMapPrefs(meta);
      state.set = Object.assign({}, SET_DEFAULTS, (prefs && prefs.set) || {});
      /* 地名上限默认 12 → 1。
         早期存档若仍停在旧默认 12，迁到 1（只迁一次）；之后自行调整的值不动 */
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
    // 报错日志需记录查看的是哪张图（导出时这几条落在日志状态的快照里）
    LOG.env('地图', `${GAME.name} · ${chosen.label || ''}`);
    LOG.env('数据', `${meta.numTitles} ${GAME.entity} · ${meta.numProvinces} 个地块`
      + ` · ${meta.mapWidth}×${meta.mapHeight}`);
    LOG.env('数据生成于', String(meta.generated || ''));

    setBoot(`加载${GAME.entity}表…`, 10);
    const titles = await api.titles();
    state.titles = titles;
    // （原色只有 titles.colors 一份，这里不再另抄一份 state.original）
    state.provinceNames = titles.provinceNames || [];
    // 名录快查表：荒地 / 无男爵领 —— 悬停、涂色、每帧都要问
    // 「这个号在不在名单里」若用 indexOf 线性扫，开销随名单增长（见上面快查表那一段）
    buildMetaIndex();

    /* 荒地名 / 早期包水域名走 buildSeaLabelPoints 那条真名表的路
     * （「水域 / 荒地 · 名称」那两个界面开关已随专属设置退役，
     * state 里两面旗保留、恒为 false，显示口径与默认设置一致）
     * 数据里这两类节点（wl_* / #sea / #lake / #river）都没有标签位置，
     * 因此默认关闭时看不到；打开同样看不到（需数据带 lx/ly） */
    buildColorIndex();
    // key → 序号，导入配色时用
    titles.index = Object.create(null);
    for (let i = 0; i < titles.keys.length; i++) titles.index[titles.keys[i]] = i;

    setBoot('正在解压地图数据…', 20);
    await nextTick();
    // 先看数据目录里有没有分块清单：有（原尺寸那套）就不下载整张 id 图，
    // 按视野取块：整张解压要 268MB JS 堆、纹理还要 268MB 显存。
    // 整段包起来：分块这条路任何异常都不该让整页白屏 ——
    // 出问题就退回「整图 id 图」这条路径（这些地图本来就走它）。
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

    /* 「每省是不是水」那张表（见 buildWaterKindMask）
     * 必须等到这里：`waterKindByPid` 会走到 `titleAt`，
     * 而它读的是 `state.titlemap`（不是 `state.titles.keys`），
     * 上面那次置空之后一直为 null，直到这句 `await api.titlemap()` 才有值。
     * 放在 `provPos` 那几行后、上传显卡前 —— 不依赖显卡、也不拖慢开图
     * （EU5 四万多个地块走一趟只需几毫秒） */
    state.waterKindArr = buildWaterKindMask();
    /* 荒地自动上色的周长表
     * 必须等 `titlemap` + `provinceIds` 都有值之后再跑
     * —— 荒地名单来自最细层归属，周长来自像素图 / 邻接表
     * 有整张 id 图的模式（除 EU5 原尺寸）直接扫，CK3 耗时 0.08s
     * 分块图先按邻接表给近似，开图后再后台算精确的（见 scheduleTileWastePerimeter） */
    setupWastePerimeter();
    /* 横跨左右的那批头衔
     * 必须排在 `state.provinceIds` + `state.titlemap` 都有值之后
     * —— 它扫的是像素图（左右两列）+ 查 `titlemap`（与上面那张表同一个约束）
     * 一次性：两列 × 图高（EU5 8192×4096 → 8192 次读）几毫秒，换图才重算 */
    state.crossSeamTids = buildCrossSeamTids();
    /* 荒地标记挪到 `uploadMapToGpu()` 末尾：
     * 在此处 `renderer` 仍为 null（它是几十行之后才 new 的），
     * `if (renderer && …)` 会直接跳过，一块都打不上；
     * 挂在 `uploadMapToGpu()` 尾部时 `setData` 刚跑完、LUT 现成，
     * 且上下文丢失恢复时会跟着重跑（标记不会丢） */

    setBoot('正在把地图送入显卡…', 88);
    await nextTick();
    /* 这一步细分计时（日志中「上传到显卡 → 就绪」花了 23.5 秒）
     * 而这一段里其实是好几件事叠在一起：编译着色器 / 上传纹理 / 建标签索引，
     * 不细分就无法判断耗时来源
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
      /* 不能一律写成「着色器编译失败」：
       * 那会把「WebGL 上下文丢失」指成「着色器写错」，
       * 在着色器源码里排查会白费时间。
       * 按 gl.js 给的 `stage` 分成人话 + 排查步骤，并且上屏
       * （手机上没有控制台可看） */
      handleBootRendererFailure(err);
      return;                       // 后面全是「渲染器已经建好」的步骤，不要硬跑
    }
    _tick('建渲染器');
    /* 渲染器这一路走了哪种「降级」——
     * 两份报告都是「画面上什么都没有」，但走的路完全不同：
     * · VIC3 那台：链接失败 → 退精简版（少边界线）
     * · HOI4 那台：数组纹理采不出来 → 把 id 图缩着传
     * 报告里不写清楚，下次仍只能靠猜 */
    try {
      const _mode = [];
      if (renderer.shaderTier === 'mid') _mode.push('中等着色器（保留本层 + 多级边界）');
      else if (renderer.shaderTier === 'border') _mode.push('边界着色器（仅本层头衔/填色）');
      else if (renderer.shaderTier === 'title') _mode.push('最简边界（仅本层头衔）');
      else if (renderer.liteShader) _mode.push('精简着色器（无边界线）');
      if (renderer.cutChannels && renderer.cutChannels.length) {
        _mode.push('省略 ' + cutChannelNames(renderer.cutChannels));
      }
      if (renderer._smallIds) _mode.push('id图缩' + (renderer.provScale || 1) + '倍');
      if (renderer.arrOk === 'bad') _mode.push('数组纹理采不出来');
      if (_mode.length) {
        LOG.env('启动渲染档位', _mode.join(' · ')
          + (renderer.liteWhy ? '（链接日志：' + String(renderer.liteWhy).slice(0, 200) + '）' : ''));
      }
      LOG.env('纹理编码', 'RG8/R8 归一化（整数纹理已退役）'
        + ' · 数组纹理自检 ' + (renderer.arrOk || '?'));
    } catch (e) { /* 报告写不进去不应拖垮开图 */ }
    renderer.onContextLost = () => {
      // 这一条要进日志：白屏的常见原因之一，而玩家只会说「它黑了」
      LOG.event('WebGL 上下文丢失', '显卡驱动 / 显存（手机切后台最常见）');
      state._ctxLostAt = performance.now();
    };
    /* 上下文恢复时显卡侧资源已重建（gl.js 里那个 restored），
     * 此时把地图数据重新喂一遍（笔迹在 CPU 那份里，未丢）
     * 这是手机切后台回来黑屏的处理：只接 lost、不接 restored 时，
     * 回来时「上下文是好的、显存里什么都没有」→ 一直黑 */
    renderer.onContextRestored = () => {
      // 开图还没喂完就丢又回来（罕见）→ 不抢：boot 那条路本来就会喂一遍
      if (!state.meta || !state.titles) return;
      restoreGpuAfterContextLoss();
    };
    renderer.onContextRestoreFailed = (err) => {
      LOG.event('上下文恢复失败', (err && err.message) || String(err));
      showFatal('✗ 显卡上下文恢复失败：' + ((err && err.message) || err) + '\n刷新页面可以重来。');
    };
    /* 把关键数字打出来（手机版黑屏时绿字停在「③传数据前」）
     * 手机上黑屏最典型的一条是纹理超限：
     * 地图 5632×2048 而手机的 MAX_TEXTURE_SIZE 常见只有 4096
     * → 纹理传不进去 → 全黑，而且不报错（GL 只设一个错误码）
     * 目前只有「粗筛位图」那张加了尺寸检查，底图 / 省份 id 那几张纹理没加，
     * 因此这里先把数字打出来，一对比即可判断 */
    try {
      const _gl = renderer && renderer.gl;
      const _mx = _gl ? _gl.getParameter(_gl.MAX_TEXTURE_SIZE) : 0;
      const _cv = document.getElementById('map');
      bootMark('③传数据前 [GL上限' + _mx + ' 地图' + meta.mapWidth + '×' + meta.mapHeight
        + ' 画布' + ((_cv && _cv.width) || 0) + '×' + ((_cv && _cv.height) || 0) + ']'
        + (meta.mapWidth > _mx || meta.mapHeight > _mx ? ' ⚠超限' : ''));
    } catch (e) { bootMark('③传数据前 [查GL失败]'); }
    /* 灌数据时也可能丢上下文：
     * 显存吃爆时 `texImage2D` 会静默失败，gl.js 的 `setData` 末尾会抛
     * `context-lost`；这里接住并按同一套人话上屏
     * 普通数据错误（尺寸对不上之类）仍交给外层启动失败 */
    try {
      await uploadMapToGpu(_tick);
    } catch (err) {
      if (!err || !err.stage) throw err;
      handleBootRendererFailure(err);
      return;
    }
    bootMark('④数据OK');
    // 地名门槛按这张图自己的地块大小现算（不用 meta 里固定那套 ——
    // 该值按某一张图调出，换尺寸 / 换游戏会对不上：地块小的图地名会提早糊出来）
    meta.labelZoom = computeLabelZoom(meta, titles);
    /* 荒地 / 水域的标签位置在这里补
     * 必须在 `new LabelLayer` 前 —— 它是构造时把 lx/ly 吃进去的，
     * 晚了这一步就失去意义（与 hideLabel 同一约束）
     * CK3 按规则直接不算（见函数里那段） */
    try { buildPseudoLabelPositions(); } catch (e) { LOG.event('伪头衔补位置失败', String(e)); }
    /* 水域名标签点（悬停 + 地图上都要显示具体海域名）
     * 这几个点不进 LabelLayer（它们是凭空多出来的一层，没有头衔），
     * 由 drawLabels 直接塞进去，因此只要在第一次画前算好即可，放这里正好
     * CK3 按规则不算（那份数据里也没有水域名表，双保险） */
    try {
      /* CK3 那一路收在函数里面：
       * 调用处不再整块置空 —— CK3 的河流需要出标，而河名点在 `titles` 那边补
       * （`buildPseudoLabelPositions`），这里聚的是「荒地 + 早期包水名」两类，
       * CK3 两类都不出，计算没有意义。
       * 判据留给函数自己（`NAME_POLICY` 那张表），调用处不再重复写 game */
      state.seaLabelPoints = buildSeaLabelPoints();
      if (state.seaLabelPoints.length) {
        LOG.event('水域名', `${state.seaLabelPoints.length} 片水域有具体名字`);
      }
    } catch (e) { state.seaLabelPoints = []; LOG.event('水域名标签失败', String(e)); }
    labels = new LabelLayer($('overlay'), titles, meta);
    /* 开场就要把存过的不透明度喂进去 —— applySettings 跑在这句前，
     * 那时 labels 还没建、会跳过，存过的偏好要等动一下滑块才生效 */
    labels.alphaCountry = setNum('labelAC', 50) / 100;
    labels.alphaPlace = setNum('labelAP', 50) / 100;
    /* P社式排版的「版图」从这里接进去
     * 它要的两样东西都是现成的：逐像素省份图 + 逐省归属表
     * 分块地图（EU5 原尺寸）没有整张省份图 → `setRealmMask` 判成 null
     * → 全部退回默认画法，一个像素都不动
     * 放在 `new LabelLayer` 之后、第一次画前（早了构造还没建） */
    try {
      labels.setRealmMask({
        provinceIds: state.provinceIds,
        width: meta.mapWidth,
        height: meta.mapHeight,
        titleAt: (pid, tier) => titleAt(pid, tier),
        noTitle: NO_TITLE,
        cell: 8,
        /* 块号听 app 的（名字数量 / 分块由它定）
         * 排版器不自己按像素分块 —— 两套标准会冲突 */
        groupOf: (pid, tier) => placeGroupAt(tier, pid),
        /* 色块的块号也一并传入（避免卡顿）——
         * 排版器用一张全图级的「块号栅格」分块，不再按块现搭 */
        blockOf: (pid) => (state._blockOf && pid < state._blockOf.length
          ? state._blockOf[pid] : -1),
        blockVer: () => state._blockVer || 0,
        /* `PaintedMaskSource` 这条路径已不再使用
         * `provPos` 仍保留（其它地方要各省质心） */
        provPos: state.provPos,
      });
      labels.setMapNameMode((state.set && state.set.mapNameFit) || 'both');
      labels.debug = !!(state.set && state.set.mapNameDebug) || !!labels.debugHash;
    } catch (e) {
      LOG.event('版图贴合未启用', String(e && (e.message || e)));
    }
    /* 分块地图（EU5 原尺寸）补一条路：
     * 分块时上面那张 `provinceIds` 是占位数组 → `realmMask` 为 null
     * 这里逐块解出来拼一张 1/8 的粗省份图，再重新接一次 */
    if (state.tiles && state.tileMap
        && (!labels.realmMask || !labels.realmMask.usable)
        && ((state.set && state.set.mapNameFit) || 'both') !== 'off') {
      setBoot('正在生成地图切片…', 100);
      buildTiledRealmMask(8).then((res) => {
        if (!res) return;
        try {
          labels.setRealmMask({
            provinceIds: res.ids,
            width: res.width,
            height: res.height,
            titleAt: (pid, tier) => titleAt(pid, tier),
            noTitle: NO_TITLE,
            cell: 1,          // 这张图本身已抽稀，不再抽稀
            groupOf: (pid, tier) => placeGroupAt(tier, pid),
            blockOf: (pid) => (state._blockOf && pid < state._blockOf.length
              ? state._blockOf[pid] : -1),
            blockVer: () => state._blockVer || 0,
            provPos: state.provPos,
          });
          LOG.event('版图贴合', `分块地图粗图 ${res.width}×${res.height}`);
          prewarmMapNameLayouts();
        } catch (e) { LOG.event('分块版图失败', String(e && (e.message || e))); }
      }).catch((e) => LOG.event('分块版图失败', String(e && (e.message || e))));
    }
    _tick('建标签索引');

    /* 边界图重算一次 —— 此时层号、粒度、多级链都已确定
     * 开图早期那次（state.tier 还是 -1）算出来的可能是空的，这次才是准的
     * 边界图按「当前层 + 当前粒度」算身份，而这两样在 boot 前半段还没定值 */
    /* 这里必须打点 —— 日志绿字走到「④数据OK」之后不再前进时，
     * 上面那句 refreshBorderField() 正是「④之后、藏遮罩前」唯一的重活
     * （它要在 CPU 上把整张图扫一遍、算粗筛位图，手机上可能很慢）
     * 卡住即卡在它；顺利通过则说明它在手机上没有问题 */
    bootMark('⑤算粗筛前');
    try {
      refreshBorderField();
      bootMark('⑥算粗筛后');
    } catch (err) {
      bootMark('⑥粗筛失败: ' + (err && err.message ? err.message : err));
      rawErr('✗ 粗筛失败：' + (err && err.message ? err.message : err));
    }

    setBoot('就绪', 100);
    /* 后台把着色器升到最高可用档（不冻界面，失败维持现状） */
    try { startShaderUpgrade(); } catch (e) { /* 升级失败不应拖垮开图 */ }
    window.__PDX_BOOTED = true;      // 看门狗（log.js）看到这个就不再报「没能启动」
    clearInterval(_hbTimer);
    bootMark('⑦就绪');
    LOG.event('就绪', `${state.meta.numProvinces} 个地块 · ${GAME.name}`);
    /* 仓库载入：选图页点「载入」的那份存档，就绪后套回来
     * 必须排在 prewarm 前 —— 套完的涂色 / 改名才是要预热的最终状态
     * 底图对不上（mapKey 不一致）就不套，照旧进编辑器 */
    if (!state._pendingProject) {
      try {
        const raw = sessionStorage.getItem('pdx.pendingProject');
        if (raw) {
          state._pendingProject = JSON.parse(raw);
          sessionStorage.removeItem('pdx.pendingProject');
        }
      } catch (e) { /* 暂存读不出来就当普通开图 */ }
    }
    if (state._pendingProject) {
      const pend = state._pendingProject;
      state._pendingProject = null;
      try {
        /* 先把层层数设成真值：
         * TIER_COUNT 平时由 applyGameText() 设，可它在这之后才跑（12187），
         * 此处消费点仍是默认 5，EU4 的省份层（tier 17）会被
         * `t.tiers[tid] >= TIER_COUNT` 当成「荒地」全滤掉 → n=0
         * （表现为「点了涂色方案再选地图，涂色没套上」） */
        TIER_KEYS = state.meta.tiers || TIER_KEYS;
        TIER_COUNT = TIER_KEYS.length;
        /* 底图对不上也照样套：
         * 工程按最细层的 key 存，不认识的 key 在 applyProject 里
         * 自然被 t.index[key]===undefined 滤掉，不会错位，只是套上多少的问题
         * 若直接 return，换张底图载入就「什么都没发生」（toast 还被关着） */
        {
          const n = applyProject(pend.project) || 0;
          if (n) {
            recomputePainted();
            blocksDirty = true;
            labelDirty = true;
            state._exported = true;      // 仓库里还有一份，关页面不用再提醒
            toast('已载入仓库存档「' + (pend.name || '') + '」：' + n + ' 处涂色。');
            LOG.event('仓库载入', (pend.name || '') + ' · ' + n + ' 处');
          } else {
            toast('这份存档在「' + ((state.meta && state.meta.label) || '') + '」上没有能识别的涂色。', true);
          }
        }
      } catch (e) { toast('仓库存档应用失败：' + (e && e.message ? e.message : e), true); }
    }
    /* 地名排版开局算一遍：与缩放无关，算一次即定
     * 切块（每段 12ms）→ 不占「就绪」那一刻，也不卡第一帧 */
    try { prewarmMapNameLayouts(); } catch (e) { LOG.event('排版预热失败', String(e)); }

    /* 报错日志：注册一份「导出时现取」的现状 ——
     * 视图 / 工具 / 改动数随时变化，记死在启动那一刻没有意义
     * 显卡那两行尤其关键：白屏中有多例是 WebGL2 根本没起来
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
      } catch (e) { /* 问不到显卡也没关系，其余照记 */ }
      /* 渲染健康自检
       * 日志上写「错误 0 处」只说明 JS 没抛异常，不等于「画出来了」。
       * 这几种情况在日志里长得一样，无法分辨：
       * · 画布尺寸是 0（CSS 没算对 / 被压扁）→ 什么都没画
       * · WebGL 上下文丢了（手机上切后台、内存吃紧很常见）→ 画的都是空的
       * · 真画了，但安卓浏览器没把它合成上屏（`content://` 协议下常见）
       * 因此这里直接读回像素 —— 这是唯一能定论的判据：
       * · 中心点非零 → 渲染器真的在画，黑屏出在显示 / 合成一侧
       * · 中心点全零 → 渲染器没画出来，属渲染侧问题（往下查画布尺寸 / 上下文）
       * 只在「导出日志」这一刻取 —— 那时肯定已经渲染过若干帧
       * （`readPixels` 读的是当前后台缓冲，没画过就都是 0） */
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
      /* 档位要「现在」的：
       * 启动时记的那条「渲染降级：最简边界」是那一刻的状态，
       * 后台升级成功以后它还留着 → 报告里写成「降级」，反而误导排查
       * 所以这里再按当前 renderer.shaderTier 补一条 */
      try {
        if (renderer) {
          const _tn = {
            full: '完整（本层 + 多级边界 + 填色）',
            mid: '中等（本层 + 多级边界）',
            border: '边界（仅本层头衔 / 填色）',
            title: '最简边界（仅本层头衔）',
            lite: '精简（无边界线）',
          };
          out['当前渲染档位'] = (_tn[renderer.shaderTier] || renderer.shaderTier || '?')
            + (renderer.upgrading ? ' · 后台升级中' : '');
          if (renderer.cutChannels && renderer.cutChannels.length) {
            out['降级省略'] = cutChannelNames(renderer.cutChannels);
          }
        }
      } catch (e) { /* 忽略 */ }
      /* 性能指标：玩家报告「卡」时，这几个数比描述有用 */
      try { Object.assign(out, PERF.snapshot()); } catch (e) { /* 忽略 */ }
      return out;
    });

    applyGameText();
    buildToolbar();
    bindToolbarFold();          // 顶栏折叠（手机版可见）
    bindEvents();
    setBrush(state.brush, false);
    setBrushLabel(state.brushLabel);      // 「标记」框里一开始就写着「请输入文本」
    renderPalette();
    setTier(meta.defaultTier ?? 3);
    setTool('paint');          // 默认工具：涂色（拖动平移按中键）
    fitView();
    updateStatus();
    updateHistoryUI();

    /* 状态栏只写尺寸：头衔数 / 地块数属于排障信息，留在诊断报告里 */
    $('status-meta').textContent =
      `${meta.mapWidth} × ${meta.mapHeight}`;
    try { LOG.env('地图规模', `${meta.numTitles} ${GAME.entity} · ${meta.numProvinces} 个地块 · 数据 ${meta.generated}`); } catch (e) { /* 忽略 */ }

    requestAnimationFrame(frame);
    /* 遮罩是靠延时藏的，所以「黑屏」也可能是遮罩没藏掉
     * 这里打两个点：到这儿了 / 遮罩真的藏了 */
    bootMark('⑧进帧循环');
    setTimeout(() => $('boot').classList.add('done'), 220);
    setTimeout(() => {
      $('boot').style.display = 'none';
      /* 决定性探针：把画布上的像素读回来
       * 启动链全通（⑨都到了）却黑屏时，分岔只有两种：
       * · 读回来是黑 → 真的没画出来（渲染 / 数据那条路）
       * · 读回来有色 → 画对了，问题在显示 / 合成（CSS 尺寸、被盖住）
       * 一次即可定性
       * readPixels 读的是当前绑定的 framebuffer，所以必须先 render 一帧
       * 它读的是帧缓冲，不是屏幕合成的结果，
       * 因此「读回来有色但屏幕黑」基本是 CSS / 布局问题 */
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

    // 未画完的接着来 —— 静默接上，不弹提示
    // （回到同一张图，画的东西原样在那儿即可，不必再飘一条「恢复了 N 个势力」）
    loadProject();
  } catch (e) {
    clearInterval(_hbTimer);       // 不再打心跳，下面给「没能启动」卡
    LOG.event('启动失败', (e && e.message) || String(e));
    console.error(e);
    // 渲染器失败那条已经在上面分类上屏了 → 不要用一句更模糊的话把它盖掉
    if (!state._rendererFail) {
      const msg = (e && e.message) ? e.message : String(e);
      setBoot('出错了：' + msg, 100);
      const _bs = $('boot-step');
      if (_bs) _bs.style.color = 'var(--danger)';
      /* 失败要给出可读的说明卡：
       * 只把一句话塞进启动页那行小字时，玩家看到的就是「卡住 / 白屏」
       * 故以「没能启动」卡呈现：环境事实 + 常见原因 + 重新加载 + 复制诊断 */
      if (window.PDXLOG && window.PDXLOG.bootFail) {
        try { window.PDXLOG.bootFail('启动过程中出错：' + msg); } catch (e2) { /* 忽略 */ }
      }
    }
  }
}

boot();

// 新手引导：就绪后挂上顶栏那个「教程」按钮（独立小模块，不碰主逻辑）
if (typeof window.initTutorial === 'function') window.initTutorial();

/* 电脑版「教程」= 介绍弹窗
   手机版的「教程」已有介绍长文（`mobile_js.txt` 的 `introHTML`），
   电脑版统一为同一个介绍窗。
   教程模块 `web/js/tutorial.js` 保留（步骤、圈高亮、注释均在），
   「教程」按钮不指向它。
   摘除教程模块挂在按钮上的监听：
   它是 `btn.addEventListener('click', start)`，addEventListener 无法摘除
   （除非保存当初的函数引用，而那是另一个模块的内部变量，拿不到）。
   → 用克隆替换原节点：克隆不带监听器，旧监听自然全部失效。
   手机版同样如此，两端一致。
   克隆之后 `#btn-tutorial` 的 id 仍在，别的代码按 id 查找仍可用。
   文案中凡是指「顶栏那排」的，电脑版要按电脑版措辞：
   手机版「单指按住 / 两根手指」直接照搬会出错。
   → 这边另写一份桌面口吻的文案，结构与手机版一致
   （.mi-lead / h4 / p / strong，样式共用）
 */
(function initDesktopIntro() {
  if (typeof document === 'undefined') return;

  const introHTML =
    '<p class="mi-lead">把 P 社五款游戏的<strong>真实地图</strong>拿来上色、修改国界、导出成图，'
    + '全部都在这个网页里面完成，不用安装游戏、不用注册账号，也不需要联网。</p>'

    + '<h4>怎么在地图上动手</h4>'
    + '<p>左边那排工具选一个，然后在图上<strong>按住左键拖动</strong>就能涂。'
    + '<strong>中键拖动</strong>（或者选「查看」之后左键拖）是平移画面，<strong>滚轮</strong>是缩放。<br>'
    + '想让某一块土地的颜色进入调色板吗？<strong>右键点它一下</strong>，等于取色。</p>'

    + '<h4>左边那栏「显示」</h4>'
    + '<p>管整张图画成什么样：地块 / 势力 / 水域 / 荒地各自的<strong>边界、名称、颜色</strong>开关，'
    + '还有边界浓度、字号、底图背景色。<br>'
    + '这一栏可以<strong>收起来</strong>（左上角那个「☰」，或者按 <strong>\</strong> 键），'
    + '收起来之后地图会吃满整个宽度。</p>'

    + '<h4>上面那条</h4>'
    + '<p><strong>剧本</strong>：点开才是年份（1444、1936 这种，整张地图的国界与配色都会跟着更换）。<br>'
    + '<strong>视图</strong>：地理层级，大洲 → 大区 → 区域 → 地区 → 省份，越往右边越细。<br>'
    + '<strong>工具</strong>：查看、吸管、填色、涂抹、橡皮、改名、旗帜，一共七个。'
    + '涂抹是按住拖出一片；<strong>填色</strong>是点一下变化一次（担心手滑就用它）；橡皮擦回原样。<br>'
    + '<strong>文件</strong>：导出整图 PNG、存入地图仓库、导入 / 导出涂色方案，还有撤销、重做、清除。<br>'
    + '<strong>设置</strong>：颜色、边界线、名称、图例（以及界面白天 / 黑夜）。设置面板也是按一下开、再按一下收。</p>'

    + '<h4>两个小提示</h4>'
    + '<p>涂错了就点「撤销」（<strong>Ctrl + Z</strong>），或者直接用「清除」重新开始，'
    + '随便尝试也不会弄乱真正的文件。<br>'
    + '想留住作品就选「文件 → 导出」，存下来的涂色下次导入依然可以接着修改。</p>'

    /* 最后补一节快捷键（教程末尾）
     * 下面每一条均对照代码确认：
     * `TOOLS` 里的 key / `keydown` 里那几个分支 / `\` 和 Esc 各自的监听
     * 不写「F = 适应窗口」：
     * `keydown` 末尾那句 `if (k === 'f') fitView()` 是死代码，
     * 因为上面 `TOOLS` 已经先命中 F（填色）并 `return` 了，
     * 写进教程会让人按了发现没反应
     * 手机版那块不加这一节：触屏上没有键盘，两边文案各写一份，
     * 不为「一致」硬塞 */
    + '<h4>快捷键</h4>'
    + '<p><strong>Q</strong> 查看 · <strong>W</strong> 吸管 · <strong>F</strong> 填色 · '
    + '<strong>E</strong> 涂抹 · <strong>R</strong> 橡皮 · <strong>N</strong> 改名<br>'
    + '<strong>Ctrl + Z</strong> 撤销 · <strong>Ctrl + Shift + Z</strong> 或 <strong>Ctrl + Y</strong> 重做<br>'
    + '<strong>1</strong> ~ <strong>5</strong> 切地理层级（大洲 → 省份，越往右越细）<br>'
    + '<strong>方向键</strong> 推视角，按住 <strong>Shift</strong> 步子大一些<br>'
    + '<strong>\\</strong> 收起 / 展开左侧栏 · <strong>Esc</strong> 回主菜单</p>';

  /** 造 / 取介绍窗（懒建：只在第一次点「教程」时建，不拖慢启动）
   * 用自己的变量缓存节点，不用每次 `getElementById` 去探：
   * 模拟 DOM 的 `getElementById` 是「找不到就懒建一个空 div」
   * （它必须这样，否则 `$('settings')` 那些拿不到节点），
   * 于是 `if (!box)` 永远不成立，窗从来不会被真正建出来，
   * 自检里「点教程 → 有介绍窗」永远是空的。
   * → 用闭包变量记着，建一次就够，也少一次 DOM 查询 */
  let boxEl = null;
  const showIntro = () => {
    if (!boxEl) {
      boxEl = document.createElement('div');
      boxEl.id = 'app-intro';
      boxEl.className = 'modal';
      boxEl.hidden = true;
      boxEl.innerHTML =
        '<div class="modal-box">'
        + '<div class="modal-head"><h2>这是什么？</h2>'
        +   '<button type="button" class="btn ghost" id="app-intro-close">知道了</button></div>'
        + '<div class="mi-box"><div class="mi-body">' + introHTML + '</div></div>'
        + '</div>';
      document.getElementById('app').appendChild(boxEl);
      /* 点窗外关掉，点「知道了」也关 */
      boxEl.addEventListener('click', (e) => { if (e.target === boxEl) boxEl.hidden = true; });
      const cb = boxEl.querySelector('#app-intro-close');
      if (cb) cb.addEventListener('click', () => { boxEl.hidden = true; });
    }
    boxEl.hidden = false;
    /* 每次打开滚回顶上，否则会停在上次读到的地方 */
    try { boxEl.querySelector('.mi-box').scrollTop = 0; } catch (e) { /* 忽略 */ }
  };

  const old = document.getElementById('btn-tutorial');
  if (!old || !old.parentNode) return;
  /* 先克隆、再换节点：顺序反了的话旧监听会跟着新节点跑 */
  const fresh = old.cloneNode(true);
  old.parentNode.replaceChild(fresh, old);
  fresh.addEventListener('click', showIntro);
})();


/* 旗帜（剪贴蒙版）
 * 效果：给一块地贴一张旗，旗面填进它的形状里，如同 PS 的剪贴蒙版；
 * 地图上拖一个框调拉伸。
 * 约定：
 * · 等比分两种基准：看图片（旗自身比例，不变形）/ 看地图（拉满外接框，变形）
 * · 面数不封顶（渲染器那张图集改成一层一面旗的数组纹理）
 * · 范围三选一：单个连通块 / 该势力全部连通块 / 自选若干块
 * · 剪贴蒙版实时跟随：地图上多一块少一块，旗跟着变（图片基准下大小不动）
 * · 海洋 / 湖泊 / 河流不许贴旗
 * 实现：每省一个「旗号」（R8 纹理）+ 每面旗三格参数（矩形 / uv / 层号）+ 一层一张图
 * 仅存在于本次会话：不写盘、刷新即失。
 */

const FLAG_LAYER = 1024;      // 每层边长（一面旗一层）

/* 这一格能不能贴旗：水（海 / 湖 / 河 / 不可通行海域）一律不行 */
function flagCanHold(pid) {
  try {
    const k = (typeof kindOfPid === 'function') ? kindOfPid(pid) : 1;
    return !(k >= 2 && k <= 5);
  } catch (e) { return true; }
}

/* 把一个省号集合里的水踢掉（剩下空集 = 这块地不能贴） */
function flagLandOnly(set) {
  const out = new Set();
  for (const p of set) if (flagCanHold(p)) out.add(p);
  return out;
}

function flagInit() {
  if (!state.flags) state.flags = [];
  if (typeof state.flagSel !== 'number') state.flagSel = -1;
  if (typeof state.flagLock !== 'boolean') state.flagLock = true;
  if (typeof state.flagAspect !== 'string') state.flagAspect = 'image';   // 全局默认：看图片
  if (typeof state.flagPickSeeds !== 'boolean') state.flagPickSeeds = false;
}

/** 一面旗新建时用的图层画布（1024²，图片拉满这一层
 * —— 上屏时按 rect 的宽高比去采，所以这里拉满不会变形） */
function flagLayerCanvas(img) {
  const c = document.createElement('canvas');
  c.width = FLAG_LAYER;
  c.height = FLAG_LAYER;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, FLAG_LAYER, FLAG_LAYER);
  return c;
}

/* 同一层的同一头衔、连在一起的那些省 */
function flagComponentOf(pid, tier) {
  const out = new Set([pid]);
  const adj = state.adjacency;
  const n = state.meta.numProvinces;
  const tm = state.titlemap;
  if (!adj || !tm || tier == null) return out;
  const base = tier * n;
  const tid = tm[base + pid];
  const offsets = new Uint32Array(adj.buffer, adj.byteOffset, n + 1);
  const nbrs = new Uint16Array(adj.buffer, adj.byteOffset + (n + 1) * 4);
  const seen = new Uint8Array(n);
  const stack = [pid];
  seen[pid] = 1;
  while (stack.length) {
    const q = stack.pop();
    for (let k = offsets[q]; k < offsets[q + 1]; k++) {
      const r = nbrs[k];
      if (r >= n || seen[r]) continue;
      if (tm[base + r] !== tid) continue;
      seen[r] = 1;
      out.add(r);
      stack.push(r);
    }
  }
  return out;
}

/** 点的地方是哪一块，返回 { key, name, rgb, pids, seed, tier }
 * key = 色块身份串（名字+显示色）或 '#tid:<层>:<头衔>'（未涂色的原版） */
function flagGroupAtClient(cx, cy) {
  const [mx, my] = screenToMap(cx, cy);
  const pid = provinceAt(mx, my);
  if (!pid || !flagCanHold(pid)) return null;

  const bi = (state._blockOf && state._blockOf.length > pid) ? state._blockOf[pid] : -1;
  const blk = bi >= 0 ? (state.paintBlocks || [])[bi] : null;
  if (blk) {
    const pids = flagLandOnly(new Set(blk.pids || []));
    if (!pids.size) return null;
    const key = String(blk.name || '') + '|' + ((blk.rgb || []).join(','));
    return { key, name: blk.name || '', rgb: (blk.rgb || []).slice(),
             pids, seed: pid, tier: null, fromBlock: true };
  }

  const tier = (typeof editTier === 'function') ? editTier() : state.tier;
  const tm = state.titlemap;
  const nP = state.meta && state.meta.numProvinces;
  if (!tm || !nP || tier == null) return null;
  const tid = titleAt(pid, tier);
  if (tid == null || tid === NO_TITLE) return null;
  try {
    if (typeof isWasteOrWaterTid === 'function' && isWasteOrWaterTid(tid)) return null;
  } catch (e) { /* 忽略 */ }
  {
    const _nm = String((state.titles.names && state.titles.names[tid]) || '');
    if (!_nm || _nm.charAt(0) === '#') return null;
  }
  const comp = flagLandOnly(flagComponentOf(pid, tier));
  if (!comp.size) return null;
  const nm = (state.titleName && state.titleName.has(tid))
    ? state.titleName.get(tid) : ((state.titles.names[tid]) || '');
  const rgb = (state.titles.colors[tid] || [150, 150, 150]).slice();
  return { key: '#tid:' + tier + ':' + tid, name: nm, rgb,
           pids: comp, seed: pid, tier, fromBlock: false };
}

/** 按 key + scope 把一面旗该盖住的省重算一遍
 * —— 剪贴蒙版实时跟随即在此：地图上多一块少一块，这里跟着变 */
function flagResolvePids(f) {
  const key = f.key;
  const out = new Set();
  if (key.indexOf('#tid:') === 0) {
    const [, tierS, tidS] = key.split(':');
    const tier = Number(tierS), tid = Number(tidS);
    const tm = state.titlemap;
    const nP = state.meta && state.meta.numProvinces;
    if (!tm || !nP || !Number.isFinite(tier)) return f.pids || out;
    if (f.scope === 'all') {
      const base = tier * nP;
      for (let p = 1; p < nP; p++) if (tm[base + p] === tid) out.add(p);
    } else {
      for (const s of (f.seeds || [])) {
        if (!(s > 0 && s < nP)) continue;
        for (const p of flagComponentOf(s, tier)) out.add(p);
      }
    }
  } else {
    const blks = (state.paintBlocks || []).filter(
      (b) => b && (String(b.name || '') + '|' + ((b.rgb || []).join(','))) === key);
    if (f.scope === 'all') {
      for (const b of blks) for (const p of (b.pids || [])) out.add(p);
    } else {
      for (const s of (f.seeds || [])) {
        const hit = blks.find((b) => (b.pids || []).indexOf(s) >= 0);
        if (hit) for (const p of (hit.pids || [])) out.add(p);
      }
    }
    if (!out.size && f.pids) return f.pids;      // 暂时找不到（涂色刚变）→ 先留着
  }
  return flagLandOnly(out);
}

/* 这一块的像素外接框（地图像素） */
function flagBBoxOf(pids) {
  const meta = state.meta;
  const ids = state.provinceIds;
  const W = meta.mapWidth, H = meta.mapHeight;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  if (ids && ids.length === W * H) {
    const mark = new Uint8Array(meta.numProvinces);
    for (const p of pids) mark[p] = 1;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        if (!mark[ids[row + x]]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0) {
    /* 分块图：provinceIds 只放了一个占位元素，不能按像素扫 ✗
       provPos 每组是「质心 x / 质心 y / 像素数」→ 用面积开方估外接框 ✓
       （单省也能得到一块可见的方形，不再退化成 1×1 的质心点 ✓）*/
    const pp = state.provPos;
    if (pp && pp.length >= meta.numProvinces * 3) {
      for (const p of pids) {
        if (!(p > 0 && p < meta.numProvinces)) continue;
        const x = pp[p * 3] || 0;
        const y = pp[p * 3 + 1] || 0;
        const a = Math.max(1, pp[p * 3 + 2] || 0);
        const r = 0.5 * Math.sqrt(a);
        if (x - r < x0) x0 = x - r;
        if (x + r > x1) x1 = x + r;
        if (y - r < y0) y0 = y - r;
        if (y + r > y1) y1 = y + r;
      }
    }
  }
  if (x1 < x0) {
    let sx = 0, sy = 0, n = 0;
    for (const p of pids) {
      sx += state.provPos[p * 3] || 0;
      sy += state.provPos[p * 3 + 1] || 0;
      n++;
    }
    if (!n) return null;
    x0 = x1 = sx / n;
    y0 = y1 = sy / n;
  }
  x0 = Math.max(0, Math.min(W - 1, x0));
  y0 = Math.max(0, Math.min(H - 1, y0));
  x1 = Math.max(0, Math.min(W - 1, x1));
  y1 = Math.max(0, Math.min(H - 1, y1));
  return [x0, y0, x1 + 1, y1 + 1];
}

/* 外接框 + 图片比例 → 初始矩形（「看图片」按图片比例塞进去，「看地图」拉满） */
function flagRectFor(bbox, img, aspect) {
  const bw = Math.max(1, bbox[2] - bbox[0]);
  const bh = Math.max(1, bbox[3] - bbox[1]);
  if (aspect === 'map' || !img) return [bbox[0], bbox[1], bw, bh];
  const ia = (img.width || 1) / (img.height || 1);
  let w = bw, h = bw / ia;
  if (h > bh) { h = bh; w = bh * ia; }
  return [bbox[0] + (bw - w) / 2, bbox[1] + (bh - h) / 2, w, h];
}

/* 推给显卡（regenLayers = 图层内容变了） */
function flagPushGpu(regenLayers) {
  flagInit();
  if (!renderer || !state.meta) return;
  if (!state.flags.length) { renderer.clearFlags(); return; }
  const n = state.meta.numProvinces;
  /* 每省 2 字节：低字节 + 高字节 ✓（RG8，最多 65535 面；R8 时 255 面就回绕 ✗）*/
  const mask = new Uint8Array(n * 2);
  const slots = new Float32Array(state.flags.length * 12);
  state.flags.forEach((f, i) => {
    f.layer = i;
    const idx = Math.min(65535, i + 1);
    for (const p of f.pids) if (p > 0 && p < n) {
      mask[p * 2] = idx & 255;
      mask[p * 2 + 1] = (idx >> 8) & 255;
    }
    const r = f.rect;
    slots[i * 12 + 0] = r[0];
    slots[i * 12 + 1] = r[1];
    slots[i * 12 + 2] = r[0] + r[2];
    slots[i * 12 + 3] = r[1] + r[3];
    slots[i * 12 + 4] = 0;                 // uv 左下
    slots[i * 12 + 5] = 0;
    slots[i * 12 + 6] = 1;                 // uv 右上
    slots[i * 12 + 7] = 1;
    slots[i * 12 + 8] = i;                 // 层号
    slots[i * 12 + 9] = 0;
    slots[i * 12 + 10] = 0;
    slots[i * 12 + 11] = 0;
  });
  renderer.setFlagMask(mask);
  if (regenLayers) renderer.setFlagLayers(state.flags.map((f) => f.layerCanvas));
  renderer.setFlagSlots(slots);
  invalidate();
}

/* 地图涂色变了 → 每面旗按 key + scope 重算覆盖范围 */
function flagOnBlocksChanged() {
  if (!state.flags || !state.flags.length) return;
  /* 防抖：涂一笔 `rebuildPaintBlocks` 就跑一次，
   * 而一次「重算省号 + 全图扫一遍外接框」是几百毫秒，直接同步做 = 每涂一笔卡一下
   * → 攒到 220ms 之后再算一次，而且外接框只在「看地图」时才真算 */
  clearTimeout(state._flagResyncT);
  state._flagResyncT = setTimeout(flagResyncNow, 220);
}

/* 真正重算一遍（剪贴蒙版实时跟随就靠这一步） */
function flagResyncNow() {
  if (!state.flags || !state.flags.length) return;
  let touched = false;
  for (const f of state.flags) {
    const pids = flagResolvePids(f);
    if (!pids || !pids.size) continue;
    f.pids = pids;
    f._bboxDirty = true;
    if (f.aspect === 'map') {
      const bbox = flagBBoxOf(pids);
      if (bbox) { f.bbox = bbox; f.rect = [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]]; }
    }
    touched = true;
  }
  if (touched) { flagPushGpu(false); flagSyncPanel(); }
}

/* 外接框按需要才算（全图扫一遍是几百毫秒，不能每次涂色都跑） */
function flagEnsureBBox(f) {
  if (!f) return null;
  if (!f.bbox || f._bboxDirty) {
    const b = flagBBoxOf(f.pids);
    if (b) { f.bbox = b; f._bboxDirty = false; }
  }
  return f.bbox || null;
}

function flagClickAt(cx, cy) {
  flagInit();
  const [mx, my] = screenToMap(cx, cy);
  const pid = provinceAt(mx, my);
  if (!pid) return true;
  /* 自选块模式：点一块 = 加进来 / 踢出去 */
  if (state.flagPickSeeds) {
    const f = state.flags[state.flagSel];
    if (!f) { state.flagPickSeeds = false; return true; }
    const g = flagGroupAtClient(cx, cy);
    if (!g) { flagNote('这里没有可加入的地块（海洋、湖泊、河流不在范围内）'); return true; }
    const at = f.seeds.indexOf(g.seed);
    if (at >= 0) f.seeds.splice(at, 1); else f.seeds.push(g.seed);
    if (!f.seeds.length) f.seeds.push(g.seed);
    f.pids = flagResolvePids(f);
    const bbox = flagBBoxOf(f.pids);
    if (bbox) {
      f.bbox = bbox;
      if (f.aspect === 'map') f.rect = [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]];
    }
    flagPushGpu(false);
    flagSyncPanel();
    return true;
  }
  const hit = state.flags.findIndex((f) => f.pids && f.pids.has(pid));
  if (hit >= 0) { flagSelect(hit); return true; }
  const g = flagGroupAtClient(cx, cy);
  if (!g) { flagNote('这里没有可贴旗的势力（海洋、湖泊、河流不在范围内）'); return true; }
  flagPickFile(g, -1);
  return true;
}

function flagFileInput() {
  let input = $('flag-file');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.id = 'flag-file';
    /* 不许 `display: none`：
     * iOS Safari（和一部分安卓浏览器）对 `display: none` 的
     * `<input type=file>` 调 `.click()` 不弹系统选图，点了没有反应，
     * 而桌面 Chrome / Edge 不受此限，因此同一个文件在电脑浏览器里是好的
     * 改成离屏但仍在布局里：
     * 1px 见方 + 挪到屏幕左边外面，看不见、也点不到（pointer-events 都不用改）
     * 换成 `visibility: hidden` / `opacity: 0` 也可 —— 但 `display: none` 一定不行
     */
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '0';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    input.setAttribute('aria-hidden', 'true');
    input.tabIndex = -1;
    document.body.appendChild(input);
  }
  return input;
}

/** 把挑中的那张图读成能直接 drawImage 的东西
 * 不能只靠 `createImageBitmap`：
 * · iOS Safari 15 及更早版本没有这个函数 → 一点就「图片读取失败」，
 * 而全项目的 toast 是关着的（`TOAST_OFF`）→ 表现为什么都没发生
 * · iPhone 拍的 HEIC，个别浏览器也不给 `createImageBitmap`
 * → 先走 `createImageBitmap`（桌面 / 新手机，快、还能顺带转正方向），
 * 不行再退回 `<img>` + `URL.createObjectURL`（早期 iOS 也认这条路）
 */
function flagReadImage(file) {
  const byImg = () => new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('这个格式的图片浏览器打不开')); };
    im.src = url;
  });
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).catch(byImg);      // 解码失败（HEIC / 超大图）→ 再试 <img>
  }
  return byImg();
}

/** 选图失败得让人看见
 * 全项目 `toast()` 是关着的（874 行那句）
 * 但「选了图，旗却没上去」属于必须说话的情况，
 * 这里直接借用页面上那个 `#toast` 元素（z-index 最高、两端都有），绕开开关
 */
function flagTell(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast err';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function flagPickFile(g, forIdx) {
  flagInit();
  const input = flagFileInput();
  input.value = '';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const img = await flagReadImage(file);
      if (forIdx >= 0 && state.flags[forIdx]) flagReplace(forIdx, img);
      else flagAttach(g, img);
    } catch (e) {
      const why = (e && e.message) || e || '未知原因';
      console.warn('[旗帜] 读图失败：' + why);
      flagTell('图片读取失败：' + why);
    }
  };
  input.click();
}

function flagAttach(g, img) {
  flagInit();
  /* 旗号走 RG8（低字节 + 高字节）→ 最多 65535 面 ✓ 到顶就明说，别静默串号 ✗ */
  if (state.flags.length >= 65535) {
    flagTell('旗帜数量已达上限（65535 面）');
    return;
  }
  const pids = flagLandOnly(g.pids);
  if (!pids.size) { toast('这块地没有可贴旗的地块', true); return; }
  const bbox = flagBBoxOf(pids);
  if (!bbox) { toast('无法计算这块地的范围', true); return; }
  const aspect = state.flagAspect || 'image';
  const f = {
    key: g.key,
    name: g.name || '',
    rgb: (g.rgb || []).slice(),
    pids,
    seeds: [g.seed],
    tier: g.tier,
    scope: 'single',
    aspect,
    img,
    layerCanvas: flagLayerCanvas(img),
    bbox,
    rect: flagRectFor(bbox, img, aspect),
  };
  state.flags.push(f);
  state.flagSel = state.flags.length - 1;
  flagPushGpu(true);
  flagSyncPanel();
  /* 贴完不再弹「已贴旗：xx」
   * 旗子当场就画在图上，提示是多余的噪声；失败时仍有提示（flagTell / flagNote） */
}

/* 换图：位置大小不动（图片基准下比例跟着新图变，框不变） */
function flagReplace(i, img) {
  const f = state.flags[i];
  if (!f) return;
  f.img = img;
  f.layerCanvas = flagLayerCanvas(img);
  if (f.aspect === 'image') {
    /* 图片比例变了 → 按新图比例重摆一次，中心不变 */
    const cx = f.rect[0] + f.rect[2] / 2, cy = f.rect[1] + f.rect[3] / 2;
    const ia = (img.width || 1) / (img.height || 1);
    const w = f.rect[2], h = w / ia;
    f.rect = [cx - w / 2, cy - h / 2, w, h];
  }
  flagPushGpu(true);
  flagSyncPanel();
  flagNote('已更换旗帜');
}

function flagSelect(i) {
  flagInit();
  if (i < 0 || i >= state.flags.length) return;
  state.flagSel = i;
  state.flagPickSeeds = false;
  flagSyncPanel();
  invalidate();
}

function flagDeselect() {
  state.flagSel = -1;
  state.flagPickSeeds = false;
  flagSyncPanel();
  invalidate();
}

function flagResetRect() {
  const f = state.flags[state.flagSel];
  if (!f) return;
  flagEnsureBBox(f);
  f.rect = flagRectFor(f.bbox, f.img, f.aspect);
  flagPushGpu(false);
  flagSyncPanel();
}

function flagDeleteSel() {
  flagInit();
  const i = state.flagSel;
  if (i < 0 || i >= state.flags.length) return;
  state.flags.splice(i, 1);
  state.flagPickSeeds = false;
  state.flagSel = state.flags.length ? Math.min(i, state.flags.length - 1) : -1;
  flagPushGpu(true);
  flagSyncPanel();
  flagNote('已删除这面旗帜');
}

/* 改范围（单个 / 全部 / 自选） */
function flagSetScope(scope) {
  const f = state.flags[state.flagSel];
  if (!f) return;
  f.scope = scope;
  if (scope === 'single' && (!f.seeds || !f.seeds.length)) return;
  state.flagPickSeeds = (scope === 'custom');
  f.pids = flagResolvePids(f);
  const bbox = flagBBoxOf(f.pids);
  if (bbox) {
    f.bbox = bbox;
    if (f.aspect === 'map') f.rect = [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]];
  }
  flagPushGpu(false);
  flagSyncPanel();
}

/* 改比例基准（图片 / 地图），换基准即按新口径重摆一次 */
function flagSetAspect(mode) {
  const f = state.flags[state.flagSel];
  state.flagAspect = mode;
  if (!f) { flagSyncPanel(); return; }
  f.aspect = mode;
  flagEnsureBBox(f);
  f.rect = flagRectFor(f.bbox, f.img, mode);
  flagPushGpu(false);
  flagSyncPanel();
}

/* 悬浮小窗 */

function flagEnsurePop() {
  let el = document.getElementById('flag-pop');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'flag-pop';
  el.hidden = true;
  el.innerHTML =
    '<div class="fp-head"><span class="fp-name" id="fp-name"></span>'
    + '<button class="fp-close" id="fp-close" type="button">×</button></div>'
    + '<div class="fp-grid">'
    +   '<label>X<input id="flag-x" type="number" step="1"></label>'
    +   '<label>Y<input id="flag-y" type="number" step="1"></label>'
    +   '<label>宽<input id="flag-w" type="number" step="1"></label>'
    +   '<label>高<input id="flag-h" type="number" step="1"></label>'
    + '</div>'
    + '<div class="fp-rows">'
    +   '<div class="fp-row"><span>范围</span>'
    +     '<button id="flag-scope-single" type="button">单个</button>'
    +     '<button id="flag-scope-all" type="button">全部</button>'
    +     '<button id="flag-scope-custom" type="button">自选</button>'
    +   '</div>'
    +   '<div class="fp-row"><span>比例</span>'
    +     '<button id="flag-aspect-image" type="button">看图片</button>'
    +     '<button id="flag-aspect-map" type="button">看地图</button>'
    +   '</div>'
    + '</div>'
    + '<div class="fp-hint" id="flag-pick-hint" hidden>点地图上的地块加进来 / 移出去</div>'
    + '<div class="fp-note" id="flag-note" hidden></div>'
    + '<div class="fp-acts">'
    +   '<button id="flag-lock" class="on" type="button">等比</button>'
    +   '<button id="flag-swap" type="button">换一张</button>'
    +   '<button id="flag-reset" type="button">重置</button>'
    +   '<button id="flag-del" type="button">删除</button>'
    + '</div>';
  const stage = $('stage') || document.body;
  stage.appendChild(el);
  flagBindUI();
  return el;
}

function flagSyncPanel() {
  flagInit();
  const pop = flagEnsurePop();
  const f = state.flags[state.flagSel];
  if (!f || state.tool !== 'flag') { pop.hidden = true; return; }
  pop.hidden = false;
  const put = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = String(Math.round(v)); };
  put('flag-x', f.rect[0]);
  put('flag-y', f.rect[1]);
  put('flag-w', f.rect[2]);
  put('flag-h', f.rect[3]);
  const nm = $('fp-name');
  if (nm) nm.textContent = f.name || ('旗帜 ' + (state.flagSel + 1));
  const on = (id, v) => { const el = $(id); if (el) el.classList.toggle('on', !!v); };
  on('flag-lock', state.flagLock);
  on('flag-scope-single', f.scope === 'single');
  on('flag-scope-all', f.scope === 'all');
  on('flag-scope-custom', f.scope === 'custom');
  on('flag-aspect-image', f.aspect !== 'map');
  on('flag-aspect-map', f.aspect === 'map');
  const hint = $('flag-pick-hint');
  if (hint) hint.hidden = !state.flagPickSeeds;
  flagUpdateBox();
}

function flagEnsureBox() {
  let el = document.getElementById('flag-knobbox');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'flag-knobbox';
  el.hidden = true;
  for (const h of ['nw', 'ne', 'sw', 'se']) {
    const i = document.createElement('i');
    i.className = 'fb-h';
    i.dataset.h = h;
    el.appendChild(i);
  }
  const stage = $('stage') || document.body;
  stage.appendChild(el);
  el.addEventListener('pointerdown', flagBoxDown);
  return el;
}

function flagUpdateBox() {
  const box = flagEnsureBox();
  const pop = document.getElementById('flag-pop');
  const f = state.flags && state.flags[state.flagSel];
  if (!f || state.tool !== 'flag') {
    box.hidden = true;
    if (pop) pop.hidden = true;
    return;
  }
  const stage = $('stage');
  const v = viewRect();
  if (!stage || !v || !(v.w > 0)) { box.hidden = true; return; }
  const k = stage.clientWidth / v.w;
  const L = (f.rect[0] - v.x) * k;
  const T = (f.rect[1] - v.y) * k;
  const W = Math.max(2, f.rect[2] * k);
  const H = Math.max(2, f.rect[3] * k);
  box.hidden = false;
  box.style.left = L + 'px';
  box.style.top = T + 'px';
  box.style.width = W + 'px';
  box.style.height = H + 'px';

  if (pop && !pop.hidden) {
    const ph = pop.offsetHeight || 150;
    const pw = pop.offsetWidth || 210;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    let px = L;
    let py = T - ph - 10;
    if (py < 4) py = Math.min(sh - ph - 4, T + H + 10);
    px = Math.max(4, Math.min(sw - pw - 4, px));
    py = Math.max(4, Math.min(sh - ph - 4, py));
    pop.style.left = px + 'px';
    pop.style.top = py + 'px';
  }
}

let flagDrag = null;

function flagBoxDown(ev) {
  flagInit();
  const f = state.flags[state.flagSel];
  if (!f) return;
  ev.preventDefault();
  ev.stopPropagation();
  const h = (ev.target && ev.target.dataset && ev.target.dataset.h) || 'move';
  flagDrag = { h, x: ev.clientX, y: ev.clientY, r: f.rect.slice() };
  window.addEventListener('pointermove', flagDragMove);
  window.addEventListener('pointerup', flagDragUp);
  window.addEventListener('pointercancel', flagDragUp);
  try { ev.target.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
}

function flagDragMove(ev) {
  if (!flagDrag) return;
  const f = state.flags[state.flagSel];
  if (!f) return;
  const stage = $('stage');
  const v = viewRect();
  const k = (stage.clientWidth || 1) / Math.max(v.w, 1e-6);
  const dx = (ev.clientX - flagDrag.x) / k;
  const dy = (ev.clientY - flagDrag.y) / k;
  const r0 = flagDrag.r;
  const h = flagDrag.h;
  const west = h.indexOf('w') >= 0, east = h.indexOf('e') >= 0;
  const north = h.indexOf('n') >= 0, south = h.indexOf('s') >= 0;
  let x = r0[0], y = r0[1], w = r0[2], hh = r0[3];
  if (h === 'move') { x += dx; y += dy; }
  else {
    if (east) w = r0[2] + dx;
    if (west) { w = r0[2] - dx; x = r0[0] + dx; }
    if (south) hh = r0[3] + dy;
    if (north) { hh = r0[3] - dy; y = r0[1] + dy; }
    /* 等比：基准跟「比例」那个选择走（看图片 = 旗不变形、看地图 = 跟疆域比例） */
    if (state.flagLock && !ev.shiftKey && (west || east) && (north || south)) {
      let asp;
      if (f.aspect === 'image' && f.img) {
        asp = (f.img.width || 1) / (f.img.height || 1);
      } else if (f.bbox) {
        asp = Math.max(1, f.bbox[2] - f.bbox[0]) / Math.max(1, f.bbox[3] - f.bbox[1]);
      } else {
        asp = r0[2] / Math.max(1e-6, r0[3]);
      }
      if (Math.abs(w - r0[2]) >= Math.abs(hh - r0[3]) * asp) hh = w / asp;
      else w = hh * asp;
      if (north) y = r0[1] + (r0[3] - hh);
      if (west) x = r0[0] + (r0[2] - w);
    }
    if (w < 8) w = 8;
    if (hh < 8) hh = 8;
  }
  f.rect = [x, y, w, hh];
  flagPushGpu(false);
  flagSyncPanel();
  invalidate();
}

function flagDragUp() {
  flagDrag = null;
  window.removeEventListener('pointermove', flagDragMove);
  window.removeEventListener('pointerup', flagDragUp);
  window.removeEventListener('pointercancel', flagDragUp);
}

function flagBindUI() {
  flagInit();
  const once = (id, fn) => {
    const el = $(id);
    if (!el || el._flagBound) return;
    el._flagBound = true;
    el.addEventListener('click', fn);
  };
  const num = (id, idx) => {
    const el = $(id);
    if (!el || el._flagBound) return;
    el._flagBound = true;
    const apply = () => {
      const f = state.flags[state.flagSel];
      if (!f) return;
      const val = Number(el.value);
      if (!Number.isFinite(val)) return;
      f.rect[idx] = val;
      if (f.rect[2] < 8) f.rect[2] = 8;
      if (f.rect[3] < 8) f.rect[3] = 8;
      flagPushGpu(false);
      flagSyncPanel();
      invalidate();
    };
    el.addEventListener('change', apply);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { apply(); el.blur(); } });
  };
  num('flag-x', 0); num('flag-y', 1); num('flag-w', 2); num('flag-h', 3);
  once('flag-lock', () => { state.flagLock = !state.flagLock; flagSyncPanel(); });
  once('flag-swap', () => { if (state.flagSel >= 0) flagPickFile(null, state.flagSel); });
  once('flag-reset', flagResetRect);
  once('flag-del', flagDeleteSel);
  once('fp-close', flagDeselect);
  once('flag-scope-single', () => flagSetScope('single'));
  once('flag-scope-all', () => flagSetScope('all'));
  once('flag-scope-custom', () => flagSetScope('custom'));
  once('flag-aspect-image', () => flagSetAspect('image'));
  once('flag-aspect-map', () => flagSetAspect('map'));
}

/* 窗里的结果行（全项目 toast 是关着的，反馈只能落在控件旁边） */
function flagNote(msg) {
  const el = $('flag-note');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
  clearTimeout(state._flagNoteT);
  if (msg) state._flagNoteT = setTimeout(() => { el.hidden = true; }, 2600);
}

/* 工具切走即收起 */
function flagTick() {
  if (state.tool !== 'flag') {
    const box = document.getElementById('flag-knobbox');
    const pop = document.getElementById('flag-pop');
    if (box) box.hidden = true;
    if (pop) pop.hidden = true;
    if (state.flagPickSeeds) state.flagPickSeeds = false;
    return;
  }
  flagUpdateBox();
}

/* 色标（ColorBrewer）
 * 只给颜色：不自动套用，也没有方案 / 级数那些选项。
 * 数据：ColorBrewer 2.0（Cynthia A. Brewer，宾州州立大学）的原始色表
 * 用法：一排色块 —— 点一下换成当前颜色、右键收进调色板
 */

/* 一行八个：取这套方案 8 级的那一档（顺序 3~9、发散 3~11 都有 8） */
function brwRow(kind, name) {
  const cols = brewerColors(kind, name, 8);
  return '<div class="brw-row" data-scheme="' + name + '">'
    + cols.map((c) => '<i data-c="' + c + '" style="background:' + c + '"></i>').join('') + '</div>';
}

/* 一组颜色里最能代表它的色相（取饱和度最高的那个算 HSV 的 H） */
function brwHue(cols) {
  let best = -1, bestH = 0;
  for (const hex of cols) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const sat = mx === 0 ? 0 : d / mx;
    let h = 0;
    if (d > 0.0001) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    if (sat > best) { best = sat; bestH = h; }
  }
  return best <= 0 ? 360 : bestH;
}

/** 铺开：按色相排序、一行一套
 * 单向渐变一组、双向渐变一组，各组内按色相从红到紫排 */
function brwBuildStripHTML() {
  const box = { innerHTML: '' };
  const rows = [];
  for (const kind of ['sequential', 'diverging']) {
    const names = Object.keys(BREWER[kind] || {});
    for (const n of names) {
      const cols = brewerColors(kind, n, 8);
      if (!cols.length) continue;
      rows.push({ kind, name: n, cols, hue: brwHue(cols.slice(-3)) });
    }
  }
  /* 顺序和发散不混排：
   * 两组各自按色相排，单向渐变整组在前、双向渐变整组在后 */
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'sequential' ? -1 : 1;
    return a.hue - b.hue;
  });
  return rows.map((r) => brwRow(r.kind, r.name)).join('');
}

function brwBuildStrip() {
  const box = $('brewer-strip');
  if (!box) return;
  box.innerHTML = brwBuildStripHTML();
}

function brwBindUI() {
  const box = $('brewer-strip');
  if (!box || box._brwBound) return;
  box._brwBound = true;
  brwBuildStrip();
  box.addEventListener('click', (e) => {
    const t = e.target;
    const c = t && t.dataset ? t.dataset.c : null;
    if (!c) return;
    const rgb = hexToRgb(c);
    if (rgb) setBrush(rgb, false, false);
  });
  box.addEventListener('contextmenu', (e) => {
    const t = e.target;
    const c = t && t.dataset ? t.dataset.c : null;
    if (!c) return;
    e.preventDefault();
    if (paletteAdd(c)) toast('已收进调色板：' + c);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', brwBindUI);
} else {
  brwBindUI();
}

/* 手机版复用：塞进任意容器、点一下换颜色（手机的颜色页不是 #brush-menu） */
if (typeof window !== 'undefined') {
  window.__PDX_BREWER = {
    rowsHTML() { return brwBuildStripHTML(); },
    buildInto(el) {
      if (!el) return;
      el.innerHTML = brwBuildStripHTML();
    },
    setColor(hex) {
      const rgb = hexToRgb(hex);
      if (rgb) setBrush(rgb, false, false);
    },
  };
}
