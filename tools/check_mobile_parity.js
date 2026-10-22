/**
 * 「手机版 vs 桌面版」结构对照 —— 桌面加了新区块，手机版没跟上就红。
 *
 *   node tools/check_mobile_parity.js
 *
 * 为什么要有它：手机版是"同一套源码 + 打补丁"，节点靠**选择器 / 正则**搬过来 ✓
 *   桌面一改结构，手机那边就**静默失配** ✗ —— 不报错、不崩，那块就是空的 ✓
 *   2026-10-21 用户报的"设置什么的其实根本没跟上"就是这个 ✓
 *
 * 它查两件事：
 *   ① **认页规则**：手机版不许再用"中文标题正则 / <h3>"去认设置页 ✗
 *      桌面早就改成 `data-group` 了 ✓（h3 一个都不剩 ✓ 正则永远匹配不上 ✓）
 *   ② **结构清单**：桌面上有的那些块，手机版搬移代码里**必须点到名** ✓
 *      桌面上新加一个显示分组 / 设置页 / 全局按钮，这里就会红 ✓
 *
 * ⚠ 这是**静态**检查（扫源码）✗ 不跑 boot ✓
 *   跑 boot 那套在 check_mobile.js 里 ✓ 那边慢（要加载整张图）✓ 这边秒出 ✓
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const MOB_JS = fs.readFileSync(path.join(ROOT, 'mobile', 'mobile_js.txt'), 'utf8');
const MOB_CSS = fs.readFileSync(path.join(ROOT, 'mobile', 'mobile_css.txt'), 'utf8');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

// ---------------------------------------------------------------- ① 认页规则

console.log('\n===== ① 设置页：认页规则 =====');

/* 桌面设置页那四个 section 的 data-group */
const deskGroups = [...HTML.matchAll(/<section class="set-col" data-group="([^"]+)"/g)].map((m) => m[1]);
ok('桌面设置页能从 data-group 认出分组', deskGroups.length > 0, deskGroups.join(' / '));

/* 🔴 核心那条：手机版认页必须按 data-group，不许再按 h3 中文正则 ✗
 *   （2026-10-21 的历史 bug：h3 早被删光了，正则一条都匹配不上 → 四页全空）*/
{
  /* 把"设置页搬移"那一段切出来（从认栏那段到它的收尾） */
  const a = MOB_JS.indexOf("const byTitle");
  const b = MOB_JS.indexOf("const sb = $('btn-settings')");
  const block = (a >= 0 && b > a) ? MOB_JS.slice(a, b) : MOB_JS;
  ok('手机版认设置页用的是 data-group（不是中文标题正则 ✗）',
     /getAttribute\(\s*['"]data-group['"]\s*\)/.test(MOB_JS) || /dataset\.group/.test(MOB_JS),
     /byTitle/.test(MOB_JS) ? '还在用 byTitle 正则 ✗' : '按 data-group ✓');
  /* ⚠ 判据要**先剔掉注释** ✗✗（2026-10-21 我自己踩的）
   *   新写的那段注释里正举着"`const byTitle = [[/颜色/, 'color']]`"当反例 ✓
   *   直接在原文里 `includes('byTitle')` → 把注释也算上 → 永远红 ✓
   *   → 先剥注释，再认 ✓（这跟"注释里别写出被扫的字面量"那条老规矩是一回事 ✓）*/
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const MOB_CODE = stripComments(MOB_JS);
  ok('认页那块不再依赖 <h3> 标题（桌面上一个 h3 都没有 ✓）',
     !/querySelector\(\s*['"]h3['"]\s*\)/.test(stripComments(block)) && !/byTitle\s*=/.test(MOB_CODE),
     /byTitle\s*=/.test(MOB_CODE) ? 'byTitle 还在 ✗' : '已换成 data-group ✓');
}

/* 桌面上有的每个分组，手机版都得有对应的一个 pane ✓ */
{
  /* 手机版那几个 pane 的 key */
  const paneKeys = [...MOB_JS.matchAll(/\{\s*key:\s*'([a-z]+)'\s*,\s*title:\s*'([^']+)'/g)]
    .map((m) => [m[1], m[2]]);
  ok('手机版设置页的 pane 是按清单建的', paneKeys.length >= 4,
     paneKeys.map((p) => p[1]).join(' / '));
  const paneKeySet = new Set(paneKeys.map((p) => p[0]));
  for (const g of deskGroups) {
    ok(`桌面分组「${g}」在手机版有对应 pane`, paneKeySet.has(g),
       paneKeySet.has(g) ? '有 ✓' : `缺 ${g} ✗（pane 只有 ${[...paneKeySet].join(',')}）`);
  }
}

// ---------------------------------------------------------------- ② 结构清单

console.log('\n===== ② 桌面有、手机版有没有搬 =====');

/* 侧栏里那四块 panel 的 id / 判别式，手机版搬移时必须点到名 */
function idPresent(id) { return new RegExp(`id="${id}"`).test(HTML); }
function moved(sel) { return MOB_JS.includes(`'${sel}'`) || MOB_JS.includes(`"${sel}"`); }

const SIDEBAR = [
  ['display-panel', '显示区（四个分组的家）', "$('display-panel')"],
  ['brush-hex', '当前颜色', "$('brush-hex')"],
  ['palette', '最近使用', "$('palette')"],
  ['results', '搜索', "$('results')"],
  ['label-pick', '标记挑选', "$('label-pick')"],
];
for (const [id, label, needle] of SIDEBAR) {
  if (!idPresent(id)) { ok(`侧栏「${label}」还在桌面上`, false, `${id} 在 HTML 里都没有 ✗`); continue; }
  ok(`侧栏「${label}」搬进手机版了`, moved(needle) || MOB_JS.includes(id),
     MOB_JS.includes(id) ? '搬了 ✓' : '没搬 ✗');
}

/* 顶栏那几块 */
const TOOLBAR = [
  ['tool-group', '工具'],
  ['tier-group', '视图（地理层级）'],
  ['era-group', '剧本'],
  ['export-row', '文件'],
  ['history-row', '撤销 / 重做'],
];
for (const [id, label] of TOOLBAR) {
  if (!idPresent(id)) continue;
  ok(`顶栏「${label}」搬进手机版了`, MOB_JS.includes(id), MOB_JS.includes(id) ? '搬了 ✓' : '没搬 ✗');
}

/* 🔴 **显示区四个分组**：它们在 #display-panel 里面 ✓ 搬那一块就全带过来了 ✓
 *   但**得确认它们真的还在 display-panel 里** ✗ —— 哪天有个分组被挪到外面，
 *   手机版就会悄没声地少一组 ✓ 这条就是盯那个的 ✓ */
{
  const dispStart = HTML.indexOf('<section class="panel" id="display-panel"');
  const dispEnd = HTML.indexOf('</section>', dispStart);
  const disp = dispStart >= 0 ? HTML.slice(dispStart, dispEnd) : '';
  for (const gid of ['region-group', 'power-group', 'water-group', 'waste-group']) {
    if (!new RegExp(`id="${gid}"`).test(HTML)) {
      console.log(`  · ${gid} 桌面上没有（这套游戏不缺这一组 ✓ 跳过）`);
      continue;
    }
    ok(`显示分组「${gid}」住在 #display-panel 里（搬一次就全带走 ✓）`,
       disp.includes(`id="${gid}"`),
       disp.includes(`id="${gid}"`) ? '在里面 ✓' : '搬到外面了 ✗ 手机会漏掉这一组');
  }
}

/* 设置页底部那几个全局件
 * ⚠ `.set-foot` 是**类**不是 id ✗（2026-10-21 我自己先写错过一遍 ✓
 *   查 `id="set-foot"` 当然查不到 —— 它一直是 `<div class="set-foot">` ✓）*/
console.log('\n  ── 设置页底部 / 全局 ──');
const GLOBALS = [
  ['set-foot', '底栏（已改动 / 恢复默认）', 'class'],
  ['set-reset', '全部恢复默认', 'id'],
  ['btn-theme', '白天 / 黑夜开关', 'id'],
];
for (const [name, label, kind] of GLOBALS) {
  const present = kind === 'class'
    ? new RegExp(`class="[^"]*\\b${name}\\b`).test(HTML)
    : new RegExp(`id="${name}"`).test(HTML);
  if (!present) { ok(`桌面「${label}」还在`, false, `${name} 没了 ✗`); continue; }
  /* ⚠ 「全部恢复默认」这些**住在 `.set-foot` 里** ✓
   *   手机版只要把底栏整块搬走，里面的按钮就跟着到了 ✓
   *   → 判据分开：能独立搬的看它自己的名字，住底栏里的看底栏搬没搬 ✓ */
  const byFoot = /^set-(reset|dirty)/.test(name) || name === 'set-reset-group';
  const hit = byFoot ? MOB_JS.includes('set-foot') : MOB_JS.includes(name);
  ok(`桌面「${label}」在手机版摸得到`, hit,
     hit ? (byFoot ? '跟着底栏一起搬了 ✓' : '接了 ✓') : '没接 ✗（手机上够不着）');
}

/* 主题：手机版改 data-theme 得真能改 ✓ */
ok('手机版能切白天/黑夜（有 data-theme 的写入口）',
   /data-theme/.test(MOB_JS) || /btn-theme/.test(MOB_JS),
   /data-theme/.test(MOB_JS) ? '有 ✓' : '没有 ✗ 手机版等于永远夜间');

/* 🔴 **「晨昏按钮放在设置的【其他】页面」**（2026-10-21 ✓ 用户点名）
 *   桌面 `#btn-theme` 必须在 `.set-col[data-group="legend"]` 里 ✓
 *   不在标签行（`.set-tabs`）里 ✗ 也不在别的分组 ✓
 *   ⚠ 全文只能有**一个** `id="btn-theme"` ✗ —— `app.js` 用 `$()` 取，
 *     取到哪个就只给哪个挂 onclick ✓ 两颗的话另一颗点了没反应 ✓ */
{
  const tabsStart = HTML.indexOf('<div class="set-tabs"');
  const tabsEnd = HTML.indexOf('</div>', tabsStart);
  const tabsSeg = HTML.slice(tabsStart, tabsEnd);
  const hasInTabs = /id="btn-theme"/.test(tabsSeg);
  ok('主题按钮不在标签行里了（挪进「其他」页 ✓）', !hasInTabs,
     hasInTabs ? '还在 .set-tabs 里 ✗' : '已挪走 ✓');

  const lgStart = HTML.indexOf('<section class="set-col" data-group="legend"');
  const lgEnd = HTML.indexOf('</section>', lgStart);
  const lgSeg = lgStart >= 0 ? HTML.slice(lgStart, lgEnd) : '';
  ok('主题按钮在「其他」页（data-group="legend"）里', /id="btn-theme"/.test(lgSeg),
     /id="btn-theme"/.test(lgSeg) ? '在里面 ✓' : '不在 ✗');

  const nTh = (HTML.match(/id="btn-theme"/g) || []).length;
  ok('全页只有一个主题按钮（两颗的话有一颗点了没反应 ✗）', nTh === 1, `${nTh} 个`);

  /* 那一页的标签也该叫「其他」✓（用户口径）*/
  ok('「其他」页的标签写着「其他」（不叫「图例 ✓）',
     /data-group="legend"[^>]*>\s*其他/.test(HTML),
     /data-group="legend"[^>]*>\s*其他/.test(HTML) ? '对 ✓' : '标签还是旧的 ✗');
}

/* ---------------------------------------------------------------- ③ CSS */

console.log('\n===== ③ 手机版 CSS 的几个硬口径 =====');
ok('手机版隐藏了顶栏（内容全靠面板搬 ✓）', /\.toolbar\s*\{[^}]*display:\s*none/.test(MOB_CSS));
ok('手机版隐藏了桌面设置弹窗（内容得搬出来 ✓）', /#settings\s*\{[^}]*display:\s*none/.test(MOB_CSS));
/* 桌面设置弹窗藏掉了，那它里面的东西**必须**被搬走 ✓
   这条是"搬了没"的兜底：至少得有 .set-col / set-foot 的搬移痕迹 */
ok('设置弹窗里的内容确实被搬出来了（有 .set-col 或 set-foot 的搬移）',
   /set-col|set-grid|set-foot/.test(MOB_JS),
   /set-col/.test(MOB_JS) ? '搬了 ✓' : '没搬 ✗ 设置页会是空的');

/* 🔴🔴 **宽屏（电脑上调试手机版）不许把布局撑破** ✗✗（2026-10-21 ✓ 用户截图报的）
 *
 *   用户原话："在电脑上的手机版怎么变这样了" —— 截图里启动页的进度条
 *   **横贯整个 2549px 屏幕**，文字缩在中间一小条 ✓
 *
 *   根因：`.boot-inner { width: 100% }` 是**无条件**的 ✗
 *     · 真手机上它等于屏幕宽 ✓ 对 ✓
 *     · 电脑上 `#app` 被那条 561px 的媒体查询收成 430px 的手机框 ✓
 *       可 `100%` 是按**视口**算的 ✗ → 2549px → 顶破手机框 ✓
 *
 *   → 判据：`.boot-inner` 出现 `width:100%` 时，
 *     ① 要么包在**窄屏**的 @media 里 ✓
 *     ② 要么同一条规则里有 `max-width` 兜着 ✓
 *     两者都不满足 = 会顶破手机框 ✗
 *
 *   ⚠ 别用"往上找最近的 @media"那种写法 ✗ —— 大括号一层层回退很容易算歪
 *     （我第一版就是这么写的，把两条合法的都判成违规了 ✓）
 *     → 正经做一次**块扫描**，记下每个声明所在的条件链 ✓
 */
{
  /* 先剥注释：注释里也写着 `.boot-inner { width: 100% }` 当反例 ✓ 会误伤 ✓ */
  const code = MOB_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  /** 扫一遍，返回 [{sel, body, conds:[...]}]；conds 是外层的 @media 条件 */
  const blocks = [];
  {
    const stack = [];      // 每层：{ cond } 或 { sel }
    let buf = '';
    let i = 0;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '{') {
        const head = buf.trim();
        buf = '';
        if (/^@media/i.test(head)) {
          stack.push({ cond: head.replace(/^@media/i, '').trim() });
        } else {
          stack.push({ sel: head });
        }
      } else if (ch === '}') {
        const top = stack.pop();
        if (top && top.sel) {
          const conds = stack.filter((s) => s.cond).map((s) => s.cond);
          blocks.push({ sel: top.sel, body: buf, conds });
          buf = '';
        }
        buf = '';
      } else {
        buf += ch;
      }
      i++;
    }
  }

  /* ⚠ **判定要"按视口分别算"，不能只看"某条规则有没有约束"** ✗✗
   *   我第一版写的是"有没有哪条 width:100% 既不在窄屏、又没 max-width" ✓
   *   结果：把无条件的旧写法改回去，它照样报绿 ✓ 成了摆设 ✓
   *   因为宽屏那条带 max-width 的规则把问题盖住了 —— 断言得站在**浏览器视角**：
   *     在 2549px 视口下，`.boot-inner` 最终会算出多宽？
   *   → 真的算一遍，超了手机框就红 ✓ */
  const VIEWPORTS = [2549, 1920, 1280, 900, 561];
  const bad = [];
  for (const vw of VIEWPORTS) {
    // 该视口下生效的 .boot-inner 规则
    const live = blocks.filter((b) => {
      if (!/\.boot-inner\b/.test(b.sel)) return false;
      return b.conds.every((c) => {
        const mn = /min-width\s*:\s*([\d.]+)px/.exec(c);
        const mx = /max-width\s*:\s*([\d.]+)px/.exec(c);
        if (mn && vw < Number(mn[1])) return false;
        if (mx && vw > Number(mx[1])) return false;
        return true;
      });
    });
    // 宽屏时包含块是 430px 的手机框；窄屏是视口
    const contain = vw >= 561 ? 430 : vw;
    // ⚠ 取值只到 `;` 或结尾 ✗ 不能用 `[^;]+` 吃到下一个属性（会把 padding 一起吞掉 ✓）
    const declOf = (body, prop) => {
      const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body);
      return m ? m[1].trim().replace(/!important/, '').trim() : null;
    };
    let w = null, max = null;
    for (const b of live) {
      const wv = declOf(b.body, 'width');
      if (wv) {
        if (/^[\d.]+%$/.test(wv)) w = (Number(wv.replace('%', '')) / 100) * contain;
        else if (/^[\d.]+px$/.test(wv)) w = Number(wv.replace('px', ''));
      }
      const mv = declOf(b.body, 'max-width');
      if (mv) {
        if (/^[\d.]+px$/.test(mv)) max = Number(mv.replace('px', ''));
        else if (/^[\d.]+%$/.test(mv)) max = (Number(mv.replace('%', '')) / 100) * contain;
      }
    }
    if (w == null) continue;                 // 没写 width → 用桌面那份（340px ✓ 不会超）
    if (max != null) w = Math.min(w, max);
    if (w > contain + 1) bad.push(`${vw}px → ${Math.round(w)}px`);
  }
  ok('宽屏下 `.boot-inner` 宽度不超出手机框（进度条不会横贯屏幕 ✓）',
     bad.length === 0,
     bad.length ? `超了：${bad.join('、')}` : '2549~561px 都收在 430px 框里 ✓');

  /* 🔴🔴 **桌面那条 `@media (min-width: 761px)` 必须被手机版盖回去** ✗✗
   *
   *   这才是 2026-10-21 用户截图报的真凶 ✓
   *   桌面 style.css 给宽屏写了：
   *     `.body { position: fixed; inset: 0 }` / `.stage { position: absolute; inset: 0 }`
   *   在电脑上（视口 > 761）它**和手机版那条 561 同时生效** ✓
   *   → `#app` 收成了 430px ✓ 可 `.body` / `.stage` 按**视口**铺满 ✓
   *   → 启动页、进度条、地图全顶出手机框（进度条横贯 2549px）✓
   *
   *   → 判据：手机版的宽屏 @media 里，必须**显式**把 `.body` / `.stage` 的
   *     position 改回来 ✓ 光靠 `.boot-inner` 收宽度是不够的 ✓
   *   ⚠ 这是两个**不同的**媒体查询 ✗ 谁生效只看视口，跟书写顺序无关 ✓
   *     所以"后写的赢"这种指望在这里不成立 ✓ 必须显式覆盖 ✓ */
  {
    const wideBlocks = [];
    {
      const stack = [];
      let buf = '';
      const code = MOB_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const ch of code) {
        if (ch === '{') {
          const head = buf.trim(); buf = '';
          stack.push(/^@media/i.test(head) ? { cond: head.replace(/^@media/i, '').trim() } : { sel: head });
        } else if (ch === '}') {
          const top = stack.pop();
          if (top && top.sel) wideBlocks.push({ sel: top.sel, body: buf, conds: stack.filter((s) => s.cond).map((s) => s.cond) });
          buf = '';
        } else buf += ch;
      }
    }
    const inWide = (re) => wideBlocks.filter((b) => re.test(b.sel)
      && b.conds.some((c) => /min-width\s*:\s*561px/.test(c)));
    const bodyFix = inWide(/(^|[\s,])\.body\b/).some((b) => /position\s*:\s*(static|relative)/.test(b.body));
    const stageFix = inWide(/(^|[\s,])\.stage\b/).some((b) => /position\s*:\s*(relative|static)/.test(b.body));
    ok('宽屏里把 `.body` 的 fixed 收回来了（桌面 761px 那条会铺满视口 ✗）',
       bodyFix, bodyFix ? '已改回 static ✓' : '还是 fixed ✗ 手机会顶出手机框');
    ok('宽屏里把 `.stage` 的 absolute 收回来了',
       stageFix, stageFix ? '已改回 relative ✓' : '还是 absolute;inset:0 ✗');
    /* 弹窗类也得跟着手机框走 */
    const modalFix = inWide(/(^|[\s,])\.modal\b|#rename|#mob-intro/).some((b) => /position\s*:\s*absolute/.test(b.body));
    ok('宽屏里弹窗类改成了 absolute（跟着手机框走 ✓）',
       modalFix, modalFix ? '改了 ✓' : '还是 fixed ✗');
  }

  /* 宽屏那条得把宽度收住 —— 有 max-width 才算写死 ✓ */
  const wideOk = blocks.some((b) => /\.boot-inner\b/.test(b.sel)
    && b.conds.some((c) => /min-width\s*:\s*561px/.test(c))
    && /max-width\s*:/.test(b.body));
  ok('宽屏那条把 `.boot-inner` 的宽度收进手机框了（有 max-width ✓）',
     wideOk, wideOk ? '收住了 ✓' : '没收 ✗ 进度条会横贯屏幕');
}

/* ---------------------------------------------------------------- ④ 液态玻璃 */

console.log('\n===== ④ 液态玻璃 =====');
{
  const CSS = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');

  /* 🔴🔴 **玻璃是"透明"的，不是"实心 + 模糊"** ✗✗（2026-10-21 用户纠正）
   *   "液态玻璃明明是需要透明的"
   *
   *   我第一版把 `backdrop-filter: blur()` 铺开就算完事 ✓
   *   可那些元素的底子还是**不透明**的（`#101820` / `rgba(...,.92)`）✗
   *   → 模糊糊在一块实心色板上 ✓ 等于什么都没做 ✓
   *   → 判据：玻璃元素的 background 必须含 **rgba(…, <1)** 或 `var(--glass)` ✓
   *     出现纯 `#xxxxxx` / `rgb(` 当主底色 = 不透 ✗ */
  const GLASS = [
    ['.toolbar', '顶栏'],
    ['.sidebar', '侧栏'],
    ['#mob-sheet', '手机二级面板', 'mobile'],
    ['#mob-topbar', '手机顶栏', 'mobile'],
    ['#mob-dock button', '手机底部入口', 'mobile'],
  ];
  const MOB_CSS = fs.readFileSync(path.join(ROOT, 'mobile', 'mobile_css.txt'), 'utf8');
  for (const [sel, label, where] of GLASS) {
    const src = where === 'mobile' ? MOB_CSS : CSS;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    /* 取**最后一条**提到这个选择器的规则里的 background */
    let last = null;
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(code))) {
      const sels = m[1].split(',').map((x) => x.trim());
      if (!sels.includes(sel)) continue;
      const bg = /(?:^|[;\s])background\s*:\s*([^;]+)/.exec(m[2]);
      if (bg) last = bg[1].trim();
    }
    if (!last) { ok(`「${label}」有半透明玻璃底`, false, '没写 background ✗'); continue; }
    /* 半透明的判据：rgba 且 alpha < 1 ✓ 或用了 --glass 变量 ✓ */
    const hasAlpha = /rgba\([^)]*,\s*0?\.\d+\s*\)/.test(last);
    const hasVar = /var\(--glass/.test(last);
    const solidHex = /(^|[\s,])#[0-9a-f]{3,8}\b/i.test(last) && !hasAlpha && !hasVar;
    ok(`「${label}」是**半透明**玻璃底（不是实心色 ✗）`,
       hasAlpha || hasVar || !solidHex,
       solidHex ? `还是实心：${last.slice(0, 40)}` : '半透明 ✓');
  }

  /* 🔴 **`backdrop-filter` 必须带 `-webkit-` 前缀** ✗✗
   *   Safari / iOS 只认前缀那个 ✓ 少一个就是"安卓是玻璃、苹果是黑板" ✓ */
  for (const [src, name] of [[CSS, '电脑版'], [MOB_CSS, '手机版']]) {
    const bare = (src.match(/(?<!-webkit-)backdrop-filter\s*:/g) || []).length;
    const webkit = (src.match(/-webkit-backdrop-filter\s*:/g) || []).length;
    ok(`${name}的 backdrop-filter 都配了 -webkit- 前缀（iOS 只认前缀那个 ✓）`,
       webkit >= bare, `无前缀 ${bare} / 带前缀 ${webkit}`);
  }

  /* 🔴🔴 **玻璃那一段不许改别人的 position** ✗✗
   *   （2026-10-21 用户截图报的："电脑版怎么改出来一个白色大条"）
   *   我给 `.zoom-box` 加了 `position: relative` ✓
   *   它本来是 `absolute; left:12px; bottom:12px` → 掉进文档流 ✓
   *   → 在地图上撑出**一条横贯整屏的白带** ✓
   *
   *   判据：这几个"浮层"的最终 position 必须是各自该有的那个 ✓
   *   ⚠ `::before` 的高光**不需要**父元素写 relative ✓
   *     abs / fixed 的父元素本来就够 ✓ 所以一句 position 都不用加 ✓ */
  {
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const finalPos = (sel) => {
      let last = null;
      const re = /([^{}]+)\{([^{}]*)\}/g;
      let m;
      while ((m = re.exec(code))) {
        const sels = m[1].split(',').map((x) => x.trim());
        if (!sels.includes(sel)) continue;
        const d = /(?:^|[;\s])position\s*:\s*([^;]+)/.exec(m[2]);
        if (d) last = d[1].trim();
      }
      return last;
    };
    const FLOATERS = [
      ['.zoom-box', 'absolute', '缩放条（贴地图左下角）'],
      ['#tutCard', 'fixed', '教程步骤卡'],
      ['.dropdown', 'absolute', '「文件 ▾」下拉'],
      ['.dd-panel', 'absolute', '剧本下拉面板'],
    ];
    for (const [sel, want, label] of FLOATERS) {
      const got = finalPos(sel);
      ok(`「${label}」的 position 没被玻璃那段改坏（会变成白色大条 ✗）`,
         got === want, `现在 = ${got || '(没写)'}，应为 ${want}`);
    }
  }
}

/* ---------------------------------------------------------------- ⑤ 左侧栏折叠 */

console.log('\n===== ⑤ 左侧栏可收起（电脑版）=====');
{
  const CSS = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');
  const APP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');

  /* 🔴 2026-10-21 ✓ 用户："电脑版的显示左侧栏改成和设置栏一样可打开可收起的模式" */
  ok('顶栏有「☰ 侧栏」按钮', /id="btn-sidebar"/.test(HTML),
     /id="btn-sidebar"/.test(HTML) ? '有 ✓' : '没有 ✗');

  /* 🔴 2026-10-21 ✓ 用户："侧栏按钮移动到上方栏最左边" */
  ok('「☰ 侧栏」按钮在顶栏**最左边**（第一个元素 ✓）',
     /<header class="toolbar">\s*(<!--[\s\S]*?-->\s*)*<button[^>]*id="btn-sidebar"/.test(HTML),
     /<header class="toolbar">[\s\S]{0,400}?id="btn-sidebar"/.test(HTML) ? '在顶栏开头 ✓' : '不在最左 ✗');

  /* 收起态必须**宽度归零** ✗ 光平移的话地图右边会缺一截 ✓ */
  ok('收起时侧栏宽度归零（不然地图右边缺一截 ✗）',
     /body\.sb-folded\s+\.sidebar\s*\{[^}]*width\s*:\s*0/.test(CSS),
     /width\s*:\s*0/.test((/body\.sb-folded\s+\.sidebar\s*\{([^}]*)\}/.exec(CSS) || [])[1] || '')
       ? '归零了 ✓' : '没收 ✓ 地图不会变宽 ✗');

  /* 用平移而不是 display:none ✓ 这样滚动位置/输入内容都留着 */
  ok('收起用平移（不是 display:none ✗ 那样会重置滚动和输入 ✓）',
     /body\.sb-folded\s+\.sidebar\s*\{[^}]*translateX/.test(CSS)
     && !/body\.sb-folded\s+\.sidebar\s*\{[^}]*display\s*:\s*none/.test(CSS));

  /* 状态得记住 ✓ */
  ok('收起状态会记住（localStorage 的 pdx-sidebar ✓）',
     /pdx-sidebar/.test(APP), /pdx-sidebar/.test(APP) ? '有 ✓' : '没存 ✗ 刷新就弹回来');
  /* 默认展开 ✓ 老用户一进来发现侧栏没了会以为坏了 */
  ok('默认是展开（读不到记录时不收 ✓）',
     /getItem\('pdx-sidebar'\)\s*===\s*'0'/.test(APP),
     /===\s*'0'/.test(APP) ? '缺省展开 ✓' : '默认就收起 ✗');

  /* 收起之后画布要重算 ✓ 不然画面会被拉伸/留白 */
  ok('收起后有重算画布（resize + invalidate ✓）',
     /sb-folded[\s\S]{0,600}renderer[\s\S]{0,80}resize/.test(APP),
     /renderer[\s\S]{0,80}resize/.test(APP) ? '有 ✓' : '没有 ✗ 画面会拉伸');

  /* 手机版要藏掉这个按钮 ✓ */
  const MOB_CSS2 = fs.readFileSync(path.join(ROOT, 'mobile', 'mobile_css.txt'), 'utf8');
  ok('手机上藏掉「☰ 侧栏」（那边侧栏本来就不可见 ✓）',
     /#btn-sidebar\s*\{\s*display:\s*none\s*!important/.test(MOB_CSS2));

  /* 🔴 **设置按钮是开合开关**（2026-10-21 ✓ 用户："按一下弹出按一下隐藏，
   *    而不依靠那个小叉叉"）
   *
   *   ⚠ 判据三件套（少一件就"点了没反应"或"没动画"）：
   *     ① 有 `.open` 类驱动动画（CSS 里有 `#settings.open ...` ✓）
   *     ② 用**意图布尔**判开合 ✗ 不能用 `.open`（rAF 之后才加、那一刻还没有 ✓
   *        我第一版就写错了 ✓ 连点两下关不掉 ✓）
   *     ③ 关的时候**等动画跑完再 hidden** ✗ 直接 hidden = 没滑出 ✓
   */
  ok('设置抽屉有 `.open` 类驱动滑入 / 滑出',
     /#settings\.open\s+\.modal-box\.set-box/.test(CSS)
     && /translateX\(100%\)/.test(CSS));
  ok('设置按钮是开合开关（再点一下会关 ✓）',
     /const toggleSettings[\s\S]{0,200}_wantOpen[\s\S]{0,80}closeSettings/.test(APP)
     || /_wantOpen\)\s*closeSettings/.test(APP),
     /_wantOpen/.test(APP) ? '用意图布尔判 ✓' : '没找到 ✗');
  ok('开合状态用意图布尔（不是瞬时 `.open` ✗ 那样连点两下关不掉）',
     /let _wantOpen/.test(APP), /let _wantOpen/.test(APP) ? '有 ✓' : '没有 ✗');
  ok('关的时候等动画跑完再 hidden（不然没有滑出 ✓）',
     /_closeTimer = setTimeout\([\s\S]{0,900}?\.hidden = true/.test(APP),
     /_closeTimer = setTimeout/.test(APP) ? '有定时收尾 ✓' : '没有 ✗');
}

/* ---------------------------------------------------------------- ⑥ 日间模式覆盖 */

console.log('\n===== ⑥ 日间模式：写死深色的都有白色版本吗 =====');
{
  const MOB = fs.readFileSync(path.join(ROOT, 'mobile', 'mobile_css.txt'), 'utf8');
  const code = MOB.replace(/\/\*[\s\S]*?\*\//g, '');

  /* 🔴🔴 **这一类 bug 用户会一个个截图来问** ✗✗（2026-10-21："这个按钮为什么没有跟随晨昏变化"）
   *
   *   「更高」那个小圆钮写死了 `background: #101820` ✓ 一个 `html[data-theme=light]`
   *   都没写 ✓ 于是白天开着它还是**一块黑板** ✓
   *
   *   这种毛病肉眼一处处找太慢 ✓ 所以做成**扫子**：
   *     某条规则定了深色（底 / 字 / 边），而**没有任何**日间规则覆盖同一个
   *     选择器的同一族属性 → 就是"白天切了它也不变" ✓
   *
   *   ⚠ 判据的三条坑（都踩过）：
   *     ① 选择器可能是**逗号分组** ✗ 要逐个子选择器比 ✓
   *     ② 一条规则可能同时写深底**和**黑边 ✗ 只盖了底不算完 ✓ 要按族逐个要求 ✓
   *     ③ `!important` 的规则，日间版也得带 `!important` 才盖得住 ✓
   *        （这条扫子只管"有没有写"，`!important` 对不对由下面单独查 ✓）
   */
  const parseRules = (src) => {
    const out = [];
    const stack = [];
    let buf = '';
    let order = 0;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') {
        const head = buf.trim(); buf = '';
        stack.push(/^@(media|supports)/i.test(head) ? { cond: head } : { sel: head, id: order++ });
      } else if (ch === '}') {
        const top = stack.pop();
        if (top && top.sel) {
          const decls = {};
          for (const p of buf.split(';')) {
            const k = p.indexOf(':');
            if (k > 0) decls[p.slice(0, k).trim()] = p.slice(k + 1).trim();
          }
          out.push({ sel: top.sel, decls, order: top.id });
        }
        buf = '';
      } else buf += ch;
    }
    return out;
  };
  const RULES = parseRules(code);

  /* 🔴 **必须扫值里的全部颜色，不能只看第一个** ✗✗（2026-10-21 踩过）
   *   `background: linear-gradient(...白色.08...), rgba(13,19,26,.86)`
   *   → 只取第一个 = 那条**白色高光** → 判成"不是深色" ✓ 整条漏掉 ✓
   *   → 介绍窗的深底就这么躲过了检查 ✓ 白天成了**深底 + 深字** ✓
   *   判据：值里出现**任何**深色，就算这条是深底 / 深边 ✓ */
  const isDark = (v) => {
    if (!v) return false;
    let found = false;
    const scan = (r, g, b) => { if (r * .299 + g * .587 + b * .114 < 90) found = true; };
    let m;
    const hexRe = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
    while ((m = hexRe.exec(v))) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      scan(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
    }
    const rgbRe = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
    while ((m = rgbRe.exec(v))) scan(+m[1], +m[2], +m[3]);
    return found;
  };
  const FAM = (p) => (p === 'background' || p === 'background-color' ? 'background'
    : p === 'color' ? 'color' : 'border');
  const PROPS = ['background', 'background-color', 'color', 'border-color', 'border'];

  const lightRules = RULES.filter((r) => /html\[data-theme=["']?light/.test(r.sel));
  const bareSels = (sel) => sel.split(',')
    .map((s) => s.trim().replace(/html\[data-theme=["']?light["']?\]\s*/g, '').trim())
    .filter(Boolean);
  const coverage = new Map();        // 子选择器 → Set(属性族)
  for (const r of lightRules) {
    const fams = PROPS.filter((p) => r.decls[p] !== undefined).map(FAM);
    for (const b of bareSels(r.sel)) {
      if (!coverage.has(b)) coverage.set(b, new Set());
      for (const f of fams) coverage.get(b).add(f);
    }
  }

  /** 选择器的"尾巴"：最后一个后代组合符之后那段
   *  `.mob-pane .set-row > span:first-child` → `.set-row > span:first-child` */
  const tailOf = (sel) => {
    const s = sel.trim();
    let depth = 0, cut = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && c === ' ') cut = i + 1;
    }
    return s.slice(cut).trim() || s;
  };

  /* 🔴🔴 **覆盖判据：只认"精确相等" + 一张显式白名单** ✗✗
   *
   *   ⚠⚠ 我上一版写了个"尾巴相同就算覆盖"的模糊匹配 ✗ 结果**把断言废掉了** ✓
   *     它把 `.mob-pane .segmented button.on` 的尾巴算成 `button.on` ✓
   *     而日间有一条 `#mob-dock button.on` ✓ 尾巴也是 `button.on` ✓
   *     → **底栏那颗按钮的选择器，替别处的规则顶了包** ✓ 断言永远绿 ✓
   *     （负向测试才发现的：把 `.on` 的日间版整块删掉，自检居然还报 ✓）
   *
   *   → 现在只认 `选择器精确相等` ✓
   *     真有"祖先覆盖"的情况（日间写 `#mob-sheet .xxx`、基础写 `.mob-pane .xxx`）
   *     就**明明白白列进白名单** ✓ 每条带上理由 ✓
   *     这样漏报不可能 ✓ 误报可控 ✓ 而且白名单本身就是一份"这里要小心"的清单 ✓
   */
  const ANCESTOR_OK = [
    /* 日间规则用 `#mob-sheet .panel-head h2`（ID 特异性 1,1,1 > 0,2,1 ✓ 确实生效 ✓）
     * 而基础规则写成 `.mob-group .panel-head h2` ✓ 两个选择器字面不同 ✓ */
    '.mob-group .panel-head h2',
    /* 同上：`#mob-sheet .set-row > span:first-child` vs `.mob-pane .set-row > span:first-child`
     * 特异性 1,2,1 > 0,3,1 ✓ ID 赢 ✓ */
    '.mob-pane .set-row > span:first-child',
  ];

  const coveredByLight = (sel, props) => {
    if (ANCESTOR_OK.includes(sel.trim())) {
      /* 白名单里的也得真有日间规则兜着 ✓ 不然白名单会变成"免死金牌" ✗ */
      const t = tailOf(sel);
      for (const [k, v] of coverage) {
        if (tailOf(k) === t && props.map(FAM).every((f) => v.has(f))) return true;
      }
      return false;
    }
    const set = coverage.get(sel.trim());
    return !!set && props.map(FAM).every((f) => set.has(f));
  };

  const missing = [];
  const seen = new Set();
  for (const r of RULES) {
    if (/html\[data-theme=["']?light/.test(r.sel)) continue;
    const darkProps = PROPS.filter((p) => r.decls[p] !== undefined && isDark(r.decls[p]));
    if (!darkProps.length) continue;
    const mine = r.sel.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = mine.filter((s) => !coveredByLight(s, darkProps));
    if (!bad.length) continue;
    const key = bad.join(',') + '|' + darkProps.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push({ sel: bad.join(','), props: darkProps.map((p) => `${p}:${r.decls[p]}`) });
  }

  ok('手机版没有"写死深色、白天不跟随"的规则',
     missing.length === 0,
     missing.length
       ? `${missing.length} 条：` + missing.slice(0, 6).map((m) => `${m.sel}（${m.props.join(' ')}）`).join('；')
       : '全部有日间版本 ✓');

  /* 🔴🔴 **反方向：写死的"亮色字"也得有日间版** ✗✗
   *   （2026-10-21 ✓ 用户截图："这里的字怎么还是亮金色的（白天模式下）"
   *     → 「涂抹」那一项是 `color: #f6dfa0` ✓ 深底上 9:1 好看 ✓
   *       白玻璃底上 1.3:1 ✓ 基本看不见 ✓）
   *
   *   我第一版扫子只查"**写死深色**没日间版" ✓ 方向反了 ✗
   *   白天真正致命的往往是**浅字压浅底** ✓（介绍窗整篇都是这种 ✓）
   *
   *   ⚠ 判据只认 `color` ✗
   *     背景 / 边框写成浅色在白天**不是问题** ✓
   *     只有**字**变浅才会看不见 ✓
   *   ⚠ 阈值 165：低于这个的（比如 `#8b9aab`）在浅底上还能读 ✓ 不报 ✓
   */
  const brightGaps = new Map();
  for (const r of RULES) {
    if (/html\[data-theme=["']?light/.test(r.sel)) continue;
    const v = r.decls['color'];
    if (!v) continue;
    const L = (() => {
      let m = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(v);
      if (m) {
        let h = m[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        return parseInt(h.slice(0, 2), 16) * .299 + parseInt(h.slice(2, 4), 16) * .587
          + parseInt(h.slice(4, 6), 16) * .114;
      }
      m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
      if (m) return (+m[1]) * .299 + (+m[2]) * .587 + (+m[3]) * .114;
      return null;
    })();
    if (L === null || L < 165) continue;
    for (const s of r.sel.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (coveredByLight(s, ['color'])) continue;
      if (!brightGaps.has(s)) brightGaps.set(s, []);
      brightGaps.get(s).push(v);
    }
  }
  const bg = [...brightGaps.entries()];
  ok('手机版没有"亮色字、白天看不见"的规则',
     bg.length === 0,
     bg.length
       ? `${bg.length} 条：` + bg.slice(0, 6).map(([s, v]) => `${s}（${v[0]}）`).join('；')
       : '全部有日间版本 ✓');

  /* 🔴🔴 **介绍窗的卡片底，日间不许被刷成透明** ✗✗
   *   （2026-10-22 ✓ 用户："我开了白昼模式，但是面板却是黑夜模式，而字是白昼模式"）
   *
   *   根因：手机版建窗写的是 `<div class="modal-box mi-box">` ✓
   *   **那两个类是同一个元素** ✗ 我照电脑版的结构当成"外层卡片 + 内层盒子"两层 ✓
   *   → 写了 `#mob-intro .mi-box { background: transparent }`（"内层别叠底"）
   *   → 它把**卡片自己的底**刷成透明 ✓
   *   → 底下露出遮罩 + 地图（看着像黑板）✓ 而字已经换成日间的深色 ✓
   *   → 深字压深底，读不出来 ✓
   *   ⚠ 特异性还跟日间那条一样、又排在后面 → 它赢 ✓
   *
   *   ⚠ 桌面版（`#app-intro`）**才是真的两层** ✓ 那边"内层透明"是对的 ✓
   *     所以这条只盯 `#mob-intro` ✓
   */
  {
    const mob = fs.readFileSync(path.join(ROOT, 'mobile', 'mobile_css.txt'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const bad = /#mob-intro\s+\.mi-box\s*\{[^}]*background\s*:\s*transparent/.test(mob)
      || /#mob-intro\s+\.modal-box\s*\{[^}]*background\s*:\s*(none|transparent)/.test(mob);
    ok('介绍窗的卡片底没被刷成透明（`.mi-box` 与 `.modal-box` 是同一元素 ✓）',
       !bad, bad ? '被设成 transparent 了 ✗ 整窗会透出地图、深字压深底' : '底还在 ✓');

    /* 日间那条必须有，而且不能太透（长文压着地图读不了 ✓）
     * ⚠ 同一个选择器在文件里出现**不止一次** ✗（一条只改边框、一条改底 ✓）
     *   所以要把所有命中都过一遍、挑**带 background 的那条** ✓
     *   （我第一版只取第一条 → 拿到的是"只改边框"那条 → α 恒为 '?' ✓）*/
    const re = /html\[data-theme="light"\]\s*#mob-intro\s+\.modal-box\s*\{([^}]*)\}/g;
    let hit = null, mm;
    while ((mm = re.exec(mob))) {
      if (/background\s*:/.test(mm[1])) { hit = mm[1]; break; }
    }
    const body = hit || '';
    const alphaMatch = /rgba\(\s*2\d\d\s*,\s*2\d\d\s*,\s*2\d\d\s*,\s*(0?\.\d+)\s*\)/.exec(body);
    const alpha = alphaMatch ? Number(alphaMatch[1]) : null;
    ok('介绍窗日间有够实的白底（长文不能浮在地图上 ✓）',
       !!hit && alpha !== null && alpha >= 0.9,
       hit ? `α=${alpha === null ? '?' : alpha}` : '没有日间底 ✗');
  }
}

/* ---------------------------------------------------------------- 汇总 */
console.log(`\n${fails.length ? '✗' : '✓'} 通过 ${oks.length} 条，失败 ${fails.length} 条`);
if (fails.length) {
  console.log('失败的：');
  for (const f of fails) console.log('  · ' + f);
  process.exitCode = 1;
}
