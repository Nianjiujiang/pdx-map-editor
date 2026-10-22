/**
 * 拿真实缓存数据，在 Node 里跑一遍**真的** app.js。
 *
 *   node test_modes.js CK3    /    node test_modes.js EU4
 *
 * 不是重写一遍逻辑来"证明"逻辑对 —— 是把 web/js 下那几份源文件按
 * build_standalone 的办法拍平，喂一套假 DOM / 假 localStorage / 假 WebGL，
 * 让真正的 boot() 跑起来，然后照着该有的行为一条条验。
 *
 * 开头那段是着色器的静态检查 + 边界线宽验算：着色器是字符串，JS 语法检查
 * 碰不到它，而它最阴的出错方式是 uniform 声明了却忘了写进名单 —— 那样
 * getUniformLocation 拿到 null，后面 uniform1f(null, ...) 是静默 no-op，
 * 参数永远是 0，界面上一句报错都没有。
 */
const fs = require('fs');
const path = require('path');
/* 借桩里那份 IndexedDB 假实现 —— 字体库要用 ✓（2026-10-20） */
const H = require('./lib/browser_stub.js');
const zlib = require('zlib');

/* ⚠ **仓库根目录，不是本文件所在目录** ✗✗（2026-10-19）
 *   这个脚本原来在仓库根目录（`node test_modes.js CK3` ✓），
 *   搬进 `tools/` 之后 `__dirname` 就变成 `tools/` 了 ✓
 *   ⚠ 但光改 ROOT 不够 ✗ —— 这文件里有几十处**裸相对路径**
 *     （`'web/js/gl.js'` / `'test_modes.js'` / `'build_standalone.py'` … ✓
 *      它们是按**当前工作目录**解析的 ✓ 不是按 ROOT ✓）
 *   → 干脆把工作目录切到仓库根：切完上面那些一处都不用改 ✓
 *     而且不管从根目录跑还是 `node tools/test_modes.js` 跑，结果一样 ✓
 *   ⚠ 必须在**其它 require / readFileSync 之前**切 ✓（虽然这里都是绝对路径，
 *     但后面 `require('fs')` 之后就有裸路径了 ✓）
 */
const ROOT = fs.existsSync(path.join(__dirname, 'web', 'index.html'))
  ? __dirname
  : path.join(__dirname, '..');
try { process.chdir(ROOT); } catch (e) { /* 切不过去就按原样跑 ✓ */ }
/** 跑哪一套：CK3 / EU4 / EU4HD。EU4HD 只是换张图，术语和断言跟 EU4 一样。 */
/** 跑哪一套：CK3 / EU4 / EU4HD / HOI4 / VIC3 */
const WHICH = (process.argv[2] || 'EU4').toUpperCase();
const isEU4 = WHICH.startsWith('EU4');
const isHoi4 = WHICH === 'HOI4';
const isVic3 = WHICH === 'VIC3';
const isEu5 = WHICH === 'EU5';
/** 有"年份视图"的几套（EU4 三个年份、HOI4 两个、VIC3 一个） */
const hasEras = isEU4 || isHoi4 || isVic3;
/*: ⚠ **卡片名要跟 `MAP_CHOICES` 一字不差** ✗ —— 测试是按名字找那张卡的 ✓
 *  （2026-10-16 用户把 V3 改名成 VIC3 ✓ 这一行跟着改 ✓
 *    源头上是 `web/js/app.js` 的 `MAP_CHOICES` + `GAMES.vic3.name` ✓） */
const CARD = WHICH === 'EU4HD' ? 'EU4HD'
  : WHICH === 'VIC3' ? 'VIC3 原版'
  : WHICH === 'HOI4' ? 'HOI4 原版'          // ① 原版 ② 修改边界，测试点原版 ✓
  : WHICH === 'EU5' ? 'EU5 原版' : WHICH;
const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

// ---------------------------------------------------------------- 静态文案检查
//
// 还没选地图的那一屏，选单里同时摆着 CK3 和 EU4 的图，标题要是写着"CK3 地图编辑器"
// 就是自相矛盾。这种"界面自称某一个游戏"的毛病必须由测试盯着。
{
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : ''; };
  console.log('=== 0a. 启动界面不能偏向某一个游戏 ===');
  for (const [what, s] of [
    ['<title>', pick(/<title>([^<]*)<\/title>/)],
    ['启动页标题', pick(/id="boot-title"[^>]*>([^<]*)</)],
    ['工具栏品牌', pick(/id="brand-mark"[^>]*>([^<]*)</)],
    ['file:// 提示', pick(/margin-bottom:22px">([^<]*)</)],
  ]) {
    ok(`${what} 是中性的`, s !== '' && !/CK3|EU4|CKⅢ/i.test(s), `${what} = ${s}`);
  }
}

// ---------------------------------------------------------------- 着色器静态检查

{
  const glSrc = fs.readFileSync(path.join(ROOT, 'web', 'js', 'gl.js'), 'utf8');
  const fragStart = glSrc.indexOf('const FRAG');
  const frag = glSrc.slice(fragStart, glSrc.indexOf('function compile'));

  const declared = [...frag.matchAll(/\buniform\s+\w+\s+(u[A-Z]\w*)/g)].map((m) => m[1]);
  const vert = glSrc.slice(0, fragStart);
  const allShaders = vert + frag;
  const listM = /for \(const n of \[([\s\S]*?)\]\)/.exec(glSrc);
  const listed = listM ? [...listM[1].matchAll(/'(u[A-Z]\w*)'/g)].map((m) => m[1]) : [];
  const renderBody = glSrc.slice(glSrc.indexOf('  render() {'));

  console.log('=== 0. 着色器静态检查 ===');
  ok('着色器里声明了 uniform', declared.length >= 15, `${declared.length} 个`);
  const notListed = declared.filter((n) => !listed.includes(n));
  ok('声明的 uniform 全进了 constructor 名单（漏了会静默失效）',
     notListed.length === 0, notListed.join(',') || '一个不漏');
  const notDeclared = listed.filter((n) => !allShaders.includes(n));
  ok('名单里的名字都在着色器里存在（没有拼错的）',
     notDeclared.length === 0, notDeclared.join(',') || '全对得上');
  const notSet = declared.filter((n) => !renderBody.includes('u.' + n));
  ok('每个 uniform 都真的被 render() 传了值', notSet.length === 0, notSet.join(',') || '全都传了');

  /* 纹理格式和 sampler 声明必须配对（配错 = 白屏）
     归一化格式（R8 / RG8 / RGBA8）→ sampler2D · 整数格式（R8UI / R16UI）→ usampler2D
     配错的报错很难猜：no operation exists that takes highp uint and const float
     所以做成硬检查 —— 改纹理格式时想漏都漏不掉

     🔴 **2026-10-19：整数纹理整条退役** ✗✗ —— Adreno 616 上 R16UI 的
     texelFetch 恒给 0、数组纹理三层全 0（HOI4 那份用户报告 + 图形体检一起钉死的）✓
     → 16 位值改 RG8、8 位值改 R8，全是归一化 ✓ 着色器里两个通道拼回去 ✓
     这一条现在守的是**"别又改回整数纹理"** ✗ —— 整条路只要再冒出
     R16UI / R8UI / usampler，那台机器就会再次白屏 ✓ */
  {
    const glAll = fs.readFileSync(path.join(ROOT, "web", "js", "gl.js"), "utf8");
    const pairs = [
      { tex: "uBorderDepth", re: /gl\.R8, gl\.RED, gl\.UNSIGNED_BYTE/, want: "sampler2D" },
      { tex: "uTitleMap", re: /gl\.RG8, gl\.RG, gl\.UNSIGNED_BYTE/, want: "sampler2D" },
      { tex: "uProvLabel", re: /gl\.RG8, gl\.RG, gl\.UNSIGNED_BYTE/, want: "sampler2D" },
    ];
    const bad = [];
    for (const p of pairs) {
      if (p.tex === "uProvLabel") continue;    // 名字对不上（老账），别误伤 ✓
      const decl = new RegExp("uniform (u?sampler2D)\\s+" + p.tex + "\\b").exec(frag);
      if (!decl) { bad.push(p.tex + " 没声明"); continue; }
      if (p.re.test(glAll) && decl[1] !== p.want) {
        bad.push(p.tex + " 声明是 " + decl[1] + "，但纹理格式要求 " + p.want);
      }
    }
    ok("纹理格式和 sampler 声明配对（配错 = 白屏）", bad.length === 0,
       bad.length ? bad.join(" · ") : "都对得上");

    /* **整数纹理一个都不许剩** ✗✗（见上面那段说明 ✓）
     *  ⚠ 只扫**代码**、不扫注释 ✗ —— 注释里明明白白写着这些名字（就是这段说明 ✓
     *    扫注释的话这条断言永远红 ✓ 我踩过同款：注释里写反引号把模板串截断了 ✓）*/
    const stripComments = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const codeOnly = stripComments(frag);
    const leftovers = ["R16UI", "R8UI", "usampler2D", "usampler2DArray", "RED_INTEGER"]
      .filter((k) => codeOnly.includes(k));
    ok("片元着色器里没有任何整数纹理 / 整数采样器（那台 Adreno 会白屏 ✗）",
       leftovers.length === 0, leftovers.join(",") || "干净：全归一化 ✓");
  }
  for (const [name, src] of [['FRAG', frag], ['VERT', vert]]) {
    const bal = (a, b) => src.split(a).length - src.split(b).length;
    ok(`${name} 大括号配平`, bal('{', '}') === 0, `差 ${bal('{', '}')}`);
    ok(`${name} 小括号配平`, bal('(', ')') === 0, `差 ${bal('(', ')')}`);
  }
  const reserved = ['half', 'fixed', 'double', 'long', 'short', 'goto', 'inline',
                    'volatile', 'public', 'static', 'extern', 'namespace', 'template',
                    'this', 'union', 'enum', 'typedef', 'class', 'packed', 'switch'];
  const hit = reserved.filter((w) => new RegExp(`\\b${w}\\b`).test(frag));
  ok('着色器没用保留字当变量名', hit.length === 0, hit.join(',') || '干净');
  // 着色器里先用后声明这种错，假 GL 编译不出来 —— 只能查源码顺序（真踩过 ✗）
  {
    const gsrc = require('fs').readFileSync('web/js/gl.js', 'utf8');
    const dRamp = gsrc.indexOf('float ramp = 0.5 * uMapPerPx;');
    /* ⚠ 找**多级边界**那个循环要用它的独有特征 ✗ ——
     *   不能再拿 `for (int ex = 0; ex < 4; ex++)` 去 indexOf ✗：
     *   算 _wAll / 算 want 也用同一句 for，第一次出现的位置在 ramp **之前** ✓
     *   于是断言会误判成"ramp 在循环后面" ✗（其实 ramp 好好地在前面 ✓）
     *   `int et = uExtraTier[ex];` 只有多级边界那圈才有 ✓ */
    const uRamp = gsrc.indexOf('int et = uExtraTier[ex];');
    ok('多级边界循环用到的 ramp 声明在它之前（别再编译失败 ✗）',
       dRamp >= 0 && uRamp >= 0 && dRamp < uRamp,
       'ramp@' + dRamp + ' loop@' + uRamp);
    }


  // **"能内嵌的地图清单"必须跟 app.js 的 MAP_CHOICES 一致** ——
  // 这两份名单以前是各写各的，加了新地图只改一处，单文件里就看不到它（EU4 1616 就是这么漏的）。
  // 2026-10-12：清单搬进了 `MAPS` 常量（`build_packs.py` 也用这一份 ✓），
  // 而**单文件默认出轻量版、一张都不嵌** —— 所以这里只比"表里有哪几张"，
  // 不再要求产物真嵌了它们 ✓（产物那一份到底嵌没嵌，由 check_standalone 按形态验 ✓）
  {
    const fs2 = require('fs');
    const app = fs2.readFileSync('web/js/app.js', 'utf8');
    const bs = fs2.readFileSync('build_standalone.py', 'utf8');
    const choiceKeys = [...app.matchAll(/\{ key: '([a-z0-9]+)',\s*emb: '([a-z0-9]+)'/g)].map((m) => m[2]);
    const tableKeys = [...bs.matchAll(/\(\"([a-z0-9]+)\", \"pdx-/g)].map((m) => m[1]);
    const missing = choiceKeys.filter((k) => !tableKeys.includes(k));
    ok('地图表（MAPS）跟 app.js 的地图清单一致（新增地图别只改一处）',
       missing.length === 0,
       missing.length ? ('表里少了: ' + missing.join(',')) : (choiceKeys.length + ' 张都在表里'));
    /* 反过来也看一眼：表里多出来的键 = 多半写错了，或者忘了在 app.js 里登记 ✓ */
    const extra = tableKeys.filter((k) => !choiceKeys.includes(k));
    ok('地图表里没有多余的东西（键名别写错）', extra.length === 0,
       extra.length ? ('多出来: ' + extra.join(',')) : '不多不少');
  }

  // **代码里取的元素必须真的在页面上** —— 删 UI 忘了删引用会直接崩 ✗（今天三次）
  {
    const fs = require('fs');
    const js = fs.readFileSync('web/js/app.js', 'utf8');
    const html = fs.readFileSync('web/index.html', 'utf8');
    const have = new Set((html.match(/id="[A-Za-z0-9_-]+"/g) || [])
      .map((s) => s.slice(4, -1)));
    const want = new Set((js.match(/\$\('[A-Za-z0-9_-]+'\)/g) || [])
      .map((s) => s.slice(3, -2)));
    for (const m of js.matchAll(/for \(const _?id of \[([^\]]+)\]/g)) {
      for (const q of (m[1].match(/'[A-Za-z0-9_-]+'/g) || [])) want.add(q.slice(1, -1));
    }
    for (const m of js.matchAll(/\['([a-z][A-Za-z0-9_-]*)',\s*state\./g)) want.add(m[1]);
    const missing = [...want].filter((x) => !have.has(x));
    ok('代码里取的元素都在页面上（删 UI 别忘删引用 ✗）',
       missing.length === 0, missing.join(',') || '无');

    // **不许浏览器自动填充**：搜索框上那个白色下拉是浏览器"保存的信息"，
    // 不是我们画的 —— 没写 autocomplete=off，Chrome 就会把打过的词记住再弹出来 ✗
    // （那个下拉开着时按回车，浏览器拿它当"选中建议"，还跟"回车跳第一条"撞车）
    {
      const textInputs = [
        ['search', '<input type="search" id="search"'],
        ['rename-input', '<input type="text" id="rename-input"'],
        ['brush-label', '<input type="text" id="brush-label"'],
        ['brush-hex', '<input type="text" id="brush-hex"'],
      ];
      const bad = textInputs.filter(([, frag]) => {
        const i = html.indexOf(frag);
        if (i < 0) return true;
        const tag = html.slice(i, html.indexOf('>', i));
        return !/autocomplete="off"/.test(tag);
      }).map(([id]) => id);
      ok('文本输入框都写了 autocomplete=off（不许浏览器弹「保存的信息」✗）',
         bad.length === 0, bad.length ? ('漏了：' + bad.join(',')) : `4 个都写了`);
    }

    // **作者署名**：顶栏一个小按钮 + 启动页一行小字，都要在，而且指同一个主页 ✓
    // （主页地址只写在 app.js 的 AUTHOR 里一处 —— 换链接不该满仓库找 ✗）
    {
      const hasBtn = /id="btn-author"/.test(html);
      const hasLink = /id="author-link"/.test(html);
      ok('页面上有作者署名（顶栏按钮 + 启动页那行）',
         hasBtn && hasLink, `顶栏 ${hasBtn ? '有' : '缺'} / 启动页 ${hasLink ? '有' : '缺'}`);
      const m = /const AUTHOR = \{[\s\S]{0,260}?url:\s*'([^']+)'/.exec(js);
      const url = m ? m[1] : '';
      ok('署名跳的是个正经外链（http/https）',
         /^https?:\/\//.test(url), url || '没找到 AUTHOR.url');
      // `/all` 是**视频**搜索（名字搜出来一堆不相关的 ✗）；要用户页（upuser）或主页（space）✓
      ok('署名跳的是「人」不是「视频搜索」（upuser / space.bilibili.com）',
         /search\.bilibili\.com\/upuser\?|space\.bilibili\.com\/\d/.test(url), url);
      ok('两个入口挂的是同一个地址（AUTHOR.url，改一处就够）',
         js.includes("'author-link'") && js.includes("'btn-author'") && js.includes('AUTHOR.url'),
         js.includes("'author-link'") && js.includes("'btn-author'") ? 'ok' : '有一处没挂');
      // **时机**：以前这段写在 bindEvents() 里 —— 那个要等地图烘完才跑（EU5 好几秒 ✗），
      // 而署名印在启动页上，玩家一进来就点 → 那会儿 <a> 还没 href → 点了没反应 ✗
      ok('署名是「页面一出来就挂」，不等 bindEvents 烘完地图 ✗',
         js.includes('function bindAuthorLinks') &&
         js.indexOf('bindAuthorLinks();') < js.indexOf('function bindEvents'),
         js.indexOf('bindAuthorLinks();') < js.indexOf('function bindEvents')
           ? '挂在文件开头 ✓' : '又挪回 bindEvents 里了 ✗');
      /* 🔴 **启动页版本戳不能再用 document.lastModified** ✗✗（2026-10-17 用户发现）
       *   lastModified 在单文件 / 某些浏览器里会变成**当前时间**，看着像"版本戳一直在变" ✓
       *   现在由 build_standalone.py 往 <meta name="pdx-build"> 里写构建时间，
       *   开发版写 dev → 显示"开发版" ✓ */
      ok('启动页版本戳来自构建 meta（不是 lastModified 当前时间 ✗）',
         /meta\[name="pdx-build"\]/.test(js)
         && /id="pdx-build"|name="pdx-build"/.test(html)
         && !/boot-ver[\s\S]{0,180}lastModified/.test(js),
         /pdx-build/.test(html) ? 'meta 在 ✓' : 'meta 不在 ✗');
      /* 🔴 2026-10-17 用户："地图列表统一变成列表形式，多的时候塞进列表而不是塞进两列"
       *   → 分列那套（TWO_COL_AT / two-col / wide-pick）全删，列表自己滚 ✓ */
      {
        const cssSrc = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');
        ok('地图列表永远一列（多张卡在列表里滚，不再排两列 ✓）',
           !/TWO_COL_AT|two-col|wide-pick/.test(js + html + cssSrc)
           && /\.map-pick-list\s*\{[^}]*overflow-y:\s*auto/.test(cssSrc),
           /two-col|wide-pick/.test(js + cssSrc) ? '还有分列残留 ✗' : '一列 + 滚动 ✓');
      }

      // 当前颜色那个色块：点一下要弹系统取色器（跟设置页里的 <input type=color> 同一个 ✓）
      ok('页面上有个取色 input（藏在色块旁边）',
         /id="brush-color"/.test(html) && /type="color"/.test(html.slice(html.indexOf('brush-swatch'), html.indexOf('brush-color') + 60)),
         /id="brush-color"/.test(html) ? '有' : '缺');
      ok('取色那块有接线（点色块 → 弹取色器 → 走 onManualColor）',
         /brush-swatch'\)\.onclick/.test(js) && /brush-color'\)\.addEventListener\('input'/.test(js)
         && js.includes('onManualColor(c)'),
         'ok');
    }
  }

  // 着色器 uniform 不许重名/重复声明（真撞过两次 ✗）
  // 这里**不用正则**：经过几层引号转义，正则很容易被写坏（踩过 ✗）。按行切就够。
  {
    const gsrc = require('fs').readFileSync('web/js/gl.js', 'utf8');
    const names = [];
    for (const line of gsrc.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('uniform ')) continue;
      const parts = s.split(' ').filter((x) => x.length);
      if (parts.length >= 3) names.push(parts[2].replace(/\[.*$/, ''));
    }
    const seen = {};
    const dup = [];
    for (const n of names) { if (seen[n]) dup.push(n); seen[n] = 1; }
    ok('着色器 uniform 没有重名（撞名会让整个着色器编译失败 ✗）',
       dup.length === 0 && names.length > 20,
       'dup=' + dup.join(',') + ' 共' + names.length + ' 个');
  }

  // 涂色边界那条：一侧有颜色、一侧没有 → 也必须算分界（原来那分支是空的 ✗）
  // 涂色边界那条：颜色取"显示出来的那个"（涂过的用玩家色、没涂的用剧本色）✓
  //   两边都没颜色（海 / 无主地）→ 不划 ✓；颜色不同 → 划 ✓（国家之间靠它 ✓）
  //   颜色相同 → **一律比标记** ✓（JS 给每块地都写了标记：涂过的=你填的名、没涂的=它原版的国名 ✓）
  {
    const g2 = require('fs').readFileSync('web/js/gl.js', 'utf8');
    /* **涂色边界看「颜色 + 标记」** ✓ 判据一个字没变，
     *   只是搬进了 `viewsDiffer(A, B)` —— 好让射线循环**起点那一侧只算一次** ✗
     *   （原来每步重算两边：约 10 次纹理采样 ✗ 现在是"起点算一次 + 每步只算对面" ✓ 省一半 ✓）*/
    ok('涂色边界看「颜色 + 标记」：颜色不同就划、同色比标记、没开年份视图时未上色互不划 ✓',
       g2.includes('vec3 lutColour(ivec2 ip)') && g2.includes('if (viewsDiffer(_A, _B))')
       && g2.includes('if (ca.x < -0.5 && cb.x < -0.5) return false;')
       && g2.includes('if (distance(ca, cb) > 0.02) return true;')
       && g2.includes('if (uPaintOnly == 1 && !A.painted && !B.painted) return false;')
       && g2.includes('return A.label != B.label;')
       // **起点那一侧必须只算一次** ✗（这是这一刀的重点：循环不变量别放循环里 ✓）
       && /CellView _A = cellViewOf\(ip\);/.test(g2)
       && !g2.includes('shownOf('), 'ok');
  }

  // 水域 / 荒地两条边界（用户定的 ✓）
  //   水域：一直画、浓度实心、粗细 = 1 格 × 基准线宽（不跟链 ✗）
  //   荒地：以前**没有自己这一趟** —— 边缘是头衔那趟顺手画的 ✗ → 宽浓跟着"本层那条线"
  //         在 1.5+实心（剧本层）和 1.0+50%（细层）之间跳 ✗
  //         现在两头一起改：头衔那几趟把**所有**荒地缝让出来（wasteOnly=false ✓），
  //         另开一趟 dWaste 按**「填色边界」那套宽浓**画 ✓
  //         （只加新的不让旧的 = 同一条缝画两遍，粗的压细的 ✗）
  {
    const g3 = require('fs').readFileSync('web/js/gl.js', 'utf8');
    const nWaste = (g3.match(/, true\)\);/g) || []).length;
    const nNorm = (g3.match(/, false\)\);/g) || []).length;
    /* 🔴🔴 **这一段 2026-10-16 整块按新口径重写** ✗✗（handover §3.4 第 9 步 ✓）
     *
     *  原来那三条量的是**已退役的背景线**（`uWaterW` / `uShowWasteBorder` / `uWasteW` ✓
     *    2026-10-15 "水与荒地 = 普通地块"那轮一起退役的 ✓）→ 一直是红的（历史老账 ✓）
     *  现在用户把「**水域 · 边界**」请回来了，但**语义不一样** ✗：
     *    · 旧：一条"水 ↔ 非水"的海岸线，跟着"边界全关"一起藏 ✓
     *    · 新：只管**水域之间**的缝 ✓ 独立一条通道 ✓ 地区/势力/填色三个开关都不管它 ✓
     *  荒地那条**没有**请回来 ✓（这次只点名了水域 ✓）
     *  → 所以旧断言一个字都用不上，整块换成新的 ✓ */
    ok('「水域 · 边界」和「荒地 · 边界」各有自己的开关 + 宽 + 浓三个 uniform ✓',
       g3.includes('uniform int   uWaterBorderOn;')
       && g3.includes('uniform float uWaterBorderW;')
       && g3.includes('uniform float uWaterBorderA;')
       && !g3.includes('uShowWasteBorder')     // 别另起一套命名（跟水域同一个长相 ✓）
       && g3.includes('uniform int   uWasteBorderOn;')
       && g3.includes('uniform float uWasteBorderW;')
       && g3.includes('uniform float uWasteBorderA;')
       && g3.includes('colorOfWaterBorder') === false,   // 别另造一个取色函数（线色跟别处一样 ✓）
       `开关=${g3.includes("uWaterBorderOn")} 宽=${g3.includes("uWaterBorderW")}`
       + ` 浓=${g3.includes("uWaterBorderA")} 荒地=${g3.includes("uWasteBorderOn")}`);
    /* 🔴 **2026-10-17 给荒地那条补的判据** ✗（用户："给荒地加上边界开关，
     *   这个负责的是**荒地与荒地之间**的边界，你之前做了水域-水域的边界，
     *   这个应该轻车熟路了吧"✓）
     *  量三件事（跟水域那条一一对应 ✓）：
     *    ① 判据函数 `wasteIs` 在，而且**读的是 uKindTex**（不是新开一张表 ✓
     *       —— 身份标里 6 就是 6，不用算 ✓ 跟水域那条的区别正在这儿 ✓）
     *    ② 射线 `rayDistWaste` 在 ✓
     *    ③ **两条旧通道都让开荒地缝**（rayDistTitle / rayDistPaint 各一句 ✓
     *       跟水域那两句同款 ✓ 少一句就是"同一条缝画两遍"✗）
     *  ⚠ `uKindOn == 0`（老包）时它恒 false ✓ 整条不生效 ✓ 观感不变 ✓ */
    ok('「荒地 · 边界」：wasteIs 读身份标 + rayDistWaste + 两处让位 ✓',
       /bool wasteIs\(ivec2 q\)/.test(g3)
       /* ⚠ 2026-10-19：判据从 `texelFetch(uKindTex…)` 换成了 `u8At(uKindTex…)` ✗
        *   —— 整数纹理退役、R8 归一化解码（见 gl.js 的 u8At ✓）
        *   这里钉的是**"读的是身份标那张表"**，不是具体哪个取数写法 ✓ */
       && /u8At\(uKindTex/.test(g3)
       && /float rayDistWaste\(ivec2 ip, vec2 f, ivec2 dir, uint t, int R\)/.test(g3)
       && (g3.match(/wasteIs\(ip\) && wasteIs\(q\)/g) || []).length === 2,
       `wasteIs=${/bool wasteIs/.test(g3)} 读身份标=${/u8At\(uKindTex/.test(g3)}`
       + ` 射线=${/rayDistWaste/.test(g3)} 让位=${(g3.match(/wasteIs\(ip\) && wasteIs\(q\)/g) || []).length} 处`);
    /* **判据必须"两侧都是水 + 编辑层 tid 不同"** ✓（handover §3.4 第 5 步 ✓）
     *  ⚠ 只有一条出处 ✗：`rayDistWater` 是这条通道**唯一**的射线函数 ✓
     *    旧通道那边由 `waterIs(ip) && waterIs(q)` 两处 `continue` 让开 ✓ */
    {
      const _rw = /float rayDistWater\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(g3);
      const _body = _rw ? _rw[0] : '';
      ok('水域边界的射线只管"对面也是水"的格子（海岸线不归它 ✓）',
         /if \(!waterIs\(q\)\) continue;/.test(_body)
         && /titleAt\(pidAt\(q\), uEditTier\) != t/.test(_body),
         _body ? '判据齐（对面得是水 + 编辑层 tid 不同）✓' : '(没找到 rayDistWater ✗)');
      /* **两条旧通道必须都把水水缝让出去** ✗（不然同一条缝画两遍 → 后画的赢 ✓
       *   那正是 8.3 第 4 条那个坑："水域那一档怎么调都没反应"✓ */
      const _rt = /float rayDistTitle\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(g3);
      const _tb = _rt ? _rt[0] : '';
      const _rp = /float rayDistPaint\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(g3);
      const _pb = _rp ? _rp[0] : '';
      ok('本层线 / 填色线都把"两侧都是水"那条缝让给水域通道 ✓（不许同处画两遍 ✗）',
         /if \(waterIs\(ip\) && waterIs\(q\)\) continue;/.test(_tb)
         && /if \(waterIs\(ip\) && waterIs\(q\)\) continue;/.test(_pb),
         `本层让位=${/waterIs\(ip\) && waterIs\(q\)\) continue;/.test(_tb)}`
         + ` 填色让位=${/waterIs\(ip\) && waterIs\(q\)\) continue;/.test(_pb)}`);
      /* **让位是 continue、不是 return** ✗✗ ——
       *  return 会让"这一向整个没了"，跳过水水缝之后的**真边界**也一起丢 ✓ */
      ok('让位用的是 continue（跳过这条缝接着往外找 ✓ 不是 return 1e9 ✗）',
         !/waterIs\(ip\) && waterIs\(q\)\) return/.test(_tb)
         && !/waterIs\(ip\) && waterIs\(q\)\) return/.test(_pb));
      /* **预筛也要让位** ✓：两边都是水时不许走"跳一步"那条近似 ✓
       *  （水片内部头衔相同 → 预筛会说"这一向没缝" → 另一头贴着的那条缝被跳过 ✗）*/
      ok('rayDistTitle 的跳步预筛在水面上让路 ✓（否则水水缝会被近似跳过去 ✗）',
         /if \(!\(waterIs\(ip\) && waterIs\(far\)\)/.test(_tb));
    }
    /* **旧那片"荒地边界"整套**（wasteOnly 那条路 ✓）**仍然不在** ✓
     *  用户 2026-10-16 只把水域请回来了 ✓ 荒地还是"普通地块" ✓
     *  ⚠ `_hasWaste` 那些判据留在 gl.js 里当档案（万一要回退 ✓）——
     *    所以只断言"没有 uWasteW / uShowWasteBorder 这两个 uniform" ✓
     *    别去断言函数名不存在 ✗（档案是要留的 ✓） */
    ok('荒地专属边界仍然退役（这次只请回水域 ✓）',
       !g3.includes('uShowWasteBorder') && !g3.includes('uWasteW')
       && !g3.includes('uWasteA') && !g3.includes('uWasteGrey'));

  }

  // 主菜单与 F5 的分工：接完必须把存档**写回 localStorage**
  // （只删内存里那份没用 ✗ 刷新还会从旧的读回来 → 涂色怎么清都清不掉 ✓ 踩过 ✓）
  {
    const src = require('fs').readFileSync('web/js/app.js', 'utf8');
    const i = src.indexOf('function loadProject()');
    // 找函数结尾：行首那个 } ✓（**别写 \n}\n** ✗ 这个文件是 CRLF，那样找不到、body 会是空的 ✓ 我栽过 ✓）
    const m = i < 0 ? null : /^}/m.exec(src.slice(i));
    const body = (i >= 0 && m) ? src.slice(i, i + m.index) : '';
    ok('主菜单接完存档要写回 localStorage（且不能调用不存在的函数）',
       body.includes('localStorage.setItem(STASH_KEY')
       && body.includes('delete box[k];')
       && !body.includes('stashWrite('), body.length + ' 字节');
  }

  ok('边界的射线搜索有硬上界（防止驱动把循环判成不合规）',
     /const int MAXR = \d+;/.test(frag), (frag.match(/const int MAXR = \d+;/) || ['无'])[0]);

  // 年份视图的"粒度"全靠这一件事成立：颜色读 uTier、边界和悬停读 uEditTier。
  // 混用的话要么配色跟着粒度变（底图就丢了），要么边界不跟着变。
  const fnBody = (name) => {
    const i = frag.indexOf(name + '(');
    return i < 0 ? '' : frag.slice(i, frag.indexOf('\n}', i) + 2);
  };
  {
    const cop = fnBody('vec4 colorOfPid');
    const tat = fnBody('uint tidAt');
    ok('颜色查的是 uTier', cop.includes('uTier') && !cop.includes('uEditTier'),
       (cop.split('\n')[1] || '').trim());
    ok('边界查的是 uEditTier', tat.includes('uEditTier') && !tat.includes('uTier'),
       (tat.split('\n')[1] || '').trim());
    ok('悬停**提亮**用的是 uEditTier（暗下去的那块 = 点下去会涂到的那块 ✓）',
       /titleAt\(h,\s*uEditTier\)[\s\S]{0,40}==\s*uHoverTid/.test(frag), '找 titleAt(h, uEditTier) … == uHoverTid');
    /* **悬停是"高暗"不是"高亮"** ✓（用户要求：改成正片压暗 ✓）
     *   以前三处都是 `mix(col, vec3(1.0,1.0,1.0), …)`（往白里混 ✗）*/
    /* **悬停一律提亮** ✓（用户两次说的都是这个：低亮 → 高亮）
     *   ⚠ 我中途自作聪明改成过"跟着底色走"（浅色压暗）✗ 被用户又提了一次 ✓
     *   → **不许再写自适应** ✗ 用户要的就是提亮 ✓
     *   每一处都得是直接 `mix(col, vec3(1.0), k)`，而且不许出现亮度判据 ✓
     *
     *  ⚠ 2026-10-13 起是**四处**（原来是三处 ✓）：多了一条「同一片海 / 同一片荒地」
     *    的编组高亮（用户要的 ✓ "HOI4 战略地图那种：海域一起来"✓）——
     *    它同样是 `mix(col, vec3(1.0), 0.30)` ✓ 所以这里数的是**下限**，不是等号 ✓
     *    （钉的仍然是"不许出现自适应 / 不许往黑里混 / 不许暖色调"✓）*/
    ok('悬停一律提亮（低亮 → 高亮 ✓ 不做自适应 ✗）',
       (frag.match(/col = mix\(col, vec3\(1\.0\), 0\.3[02]\)/g) || []).length >= 3
       && !/_hl > 0\.55/.test(frag)
       && !/mix\(col, vec3\(0\.0\)/.test(frag)
       && !/mix\(col, vec3\(1\.0, 0\.99, 0\.9\)/.test(frag));

    // **无主地块也要画边界** ✓ —— 那道闸以前是「本格在编辑层有头衔」，
    // 而"无主地"在编辑层拿到的正是 NONE → 它的整段边界计算被跳过 →
    // 「国家 ↔ 无主地」只剩国家那半边有线（用户报的 ✗）
    {
      const gateNew = /if \(pidAt\(ip\) != 0u\)/.test(frag);
      ok('边界那道闸看的是「本格是不是地块」，不是「有没有头衔」✓',
         gateNew && !/if \(tidAt\(ip\) != NONE\)/.test(frag),
         gateNew ? 'pidAt(ip) != 0u' : '还是老写法（tidAt != NONE）');
      /* ⚠ **2026-10-17 起判据换了写法** ✗：不再拿 `uRealTitles`（伪头衔序号）一刀切，
         改成按**底层身份**判 —— `waterIs()` / `wasteIs()` 两个助手 ✓
         （见 rayDistTitle 里那两行 `if (…) continue;` ✓）
         所以这条钉的是**意图**，不是写法：
           · 只有"**两边都是水**"才跳过（海 ↔ 海 不画 ✓）
           · 只有"**两边都是荒地**"才跳过 ✓
           · 无主地既不是水也不是荒地 → 它跟海之间那条**海岸线照画** ✓
         ⚠ 老写法（`t >= uRealTitles && tt >= uRealTitles`）**别回来** ✗ ——
           那一条把无主地也算成"地形"，海岸线会整条消失 ✓（用户报过 ✓）*/
      const skipWater = /if \(waterIs\(ip\) && waterIs\(q\)\)\s*continue;/.test(frag);
      const skipWaste = /if \(wasteIs\(ip\) && wasteIs\(q\)\)\s*continue;/.test(frag);
      const oldForm = /if \(t >= uint\(uRealTitles\) && tt >= uint\(uRealTitles\)\)/.test(frag);
      ok('「地形伪头衔」那道判据也得把无主地排除（NONE 是地，不是海）✓',
         skipWater && skipWaste && !oldForm,
         `两边都是水/荒地才跳过=${skipWater && skipWaste} · 老写法=${oldForm}`);
      /* 照着着色器那段**逐字重算**（按新写法 ✓）：一格格身份摆成一条带子，
         看每个方向找不找得到边 ✓
         一格带两样：`tid`（头衔号 ✓ 一样才算"同一块"）+ `kind`（1 陆地 / 2 水 / 3 荒地 ✓
         无主地那格 tid 就是 NONE ✓ 它自己的身份是"地"）*/
      const NONE2 = 65535, LAND2 = 1, WATER2 = 2, WASTE2 = 3;
      const cell2 = (tid2, kind2) => ({ tid: tid2, kind: kind2 });
      const none2 = (kind2) => cell2(NONE2, kind2);      // 无主地：没有头衔，但它是地 ✓
      const ray2 = (strip, i, dir) => {
        const t0 = strip[i].tid, k0 = strip[i].kind;
        for (let k = 1; k <= 8; k++) {
          const q = i + dir * k;
          if (q < 0 || q >= strip.length) break;
          const e = strip[q];
          if (e.tid === t0) continue;                    // 同一块 → 还没到缝 ✓
          if (k0 === WATER2 && e.kind === WATER2) continue;   // 海 ↔ 海 不画 ✓
          if (k0 === WASTE2 && e.kind === WASTE2) continue;   // 荒地 ↔ 荒地 不画 ✓
          return k;
        }
        return Infinity;
      };
      /* 复现用的老闸：无主地那一侧整段跳过（= 修复前的行为 ✗）*/
      const oldHit = (strip, i, dir) => (strip[i].tid === NONE2 ? Infinity : ray2(strip, i, dir));
      const newHit = (strip, i, dir) => ray2(strip, i, dir);
      const strip2 = [cell2(5, LAND2), none2(LAND2), none2(LAND2), cell2(7, LAND2), cell2(8, LAND2)];
      ok('国家 → 无主地：两边都算得出那条边 ✓',
         newHit(strip2, 0, 1) === 1 && newHit(strip2, 1, -1) === 1,
         `国家侧 ${newHit(strip2, 0, 1)} / 无主侧 ${newHit(strip2, 1, -1)}`);
      ok('（复现）老闸下无主那一侧整段跳过 → 线只剩半边 ✗',
         oldHit(strip2, 1, -1) === Infinity && oldHit(strip2, 0, 1) === 1,
         `老闸：无主侧 ${oldHit(strip2, 1, -1)} / 国家侧 ${oldHit(strip2, 0, 1)}`);
      ok('无主地之间不画边界', newHit([none2(LAND2), none2(LAND2)], 0, 1) === Infinity,
         String(newHit([none2(LAND2), none2(LAND2)], 0, 1)));
      ok('国家 ↔ 国家：照旧画', newHit([cell2(5, LAND2), cell2(7, LAND2)], 0, 1) === 1,
         String(newHit([cell2(5, LAND2), cell2(7, LAND2)], 0, 1)));
      // **无主地也是地** → 挨着海那一条就是海岸线，要画 ✓
      // （以前 NONE 被算成"地形伪头衔"，跟海一起被"海与海不画线"吃掉 ✗）
      ok('无主地 ↔ 海：也要画（那就是海岸线）✓',
         newHit([none2(LAND2), cell2(800, WATER2)], 0, 1) === 1
         && newHit([cell2(800, WATER2), none2(LAND2)], 1, -1) === 1,
         `无主侧 ${newHit([none2(LAND2), cell2(800, WATER2)], 0, 1)}`
         + ` / 海侧 ${newHit([cell2(800, WATER2), none2(LAND2)], 1, -1)}`);
      ok('海 ↔ 海：还是不画（原来的规矩不能丢）✓',
         newHit([cell2(800, WATER2), cell2(801, WATER2)], 0, 1) === Infinity,
         String(newHit([cell2(800, WATER2), cell2(801, WATER2)], 0, 1)));
      ok('国家 ↔ 海：海岸线照旧', newHit([cell2(5, LAND2), cell2(800, WATER2)], 0, 1) === 1,
         String(newHit([cell2(5, LAND2), cell2(800, WATER2)], 0, 1)));
      ok('无主地 ↔ 荒地：荒地该有边界 → 照画',
         newHit([none2(LAND2), cell2(900, WASTE2)], 0, 1) === 1,
         String(newHit([none2(LAND2), cell2(900, WASTE2)], 0, 1)));
    }
    // 手绘描边必须区分"同色但不同标记"—— 只看颜色的话两块中间不会有线
    const pd = fnBody('bool paintDiffers');
    const pl = fnBody('uint paintLabelAt');
    const plo = fnBody('uint paintLabelOf');
    ok('手绘描边也看标记（同色不同标记算两块）',
       pd.includes('paintLabelAt') && pl.includes('paintLabelOf')
       && plo.includes('uPaintLabel'),
       `paintDiffers 比标记：${pd.includes('paintLabelAt')}`
       + ` / paintLabelAt 转调：${pl.includes('paintLabelOf')}`
       + ` / paintLabelOf 读纹理：${plo.includes('uPaintLabel')}`);

    // 手绘必须是**最上层**：查它得排在"没有归属"和"伪头衔（海/湖/荒地）"
    // 这两条提前返回**前面**，不然涂过的地块会被地形色顶掉；
    // 「浓度」也只该淡头衔色，不该把手绘一起淡掉。
    {
      const body = frag.slice(frag.indexOf('vec4 colorOfPid'));
      const iPaint = body.indexOf('uShowPaint == 1');
      const iNone = body.indexOf('tid == NONE');
      const iPseudo = body.indexOf('uRealTitles');
      // GLSL 是"先定义后使用"，顺序错了直接编译失败（假 GL 编不了着色器，这类错只能这样守）
    ok('取手绘的函数定义在用到它的函数之前',
       frag.indexOf('vec4 paintOf(uint pid)') < frag.indexOf('vec4 colorOfPid(uint pid)')
       && frag.indexOf('uint paintLabelOf(uint pid)') < frag.indexOf('bool paintDiffers')
       && frag.indexOf('uint titleAt(uint pid, int tier)') < frag.indexOf('vec4 colorOfPid(uint pid)'),
       'paintOf / paintLabelOf / titleAt 都要排在 colorOfPid 前面');

    ok('手绘层纹理也是拍平的（uPaintW / paintOf）',
       frag.includes('paintOf(uint pid)') && frag.includes('uPaintW')
       && frag.includes('paintLabelOf'),
       '找 paintOf / paintLabelOf / uPaintW');

    ok('手绘排在任何提前返回之前（它是最上层）',
         iPaint >= 0 && iNone > iPaint && iPseudo > iPaint,
         `手绘@${iPaint} 无归属@${iNone} 伪头衔@${iPseudo}`);
      ok('浓度只淡头衔色，不淡手绘',
         /return vec4\(pc\.rgb, 1\.0\);/.test(body)
         && /mix\(uBackdrop, c\.rgb, uMix\)/.test(body) && !/cov \* uMix/.test(frag),
         '手绘直接返回原色，浓度在 colorOfPid 里只作用于头衔色');
    }
  }
}

// ---------------------------------------------------------------- 边界线宽验算
//
// 浏览器在这个沙箱里起不来（Start-Process 被拒），所以这里是**按着色器源码
// 逐字重算**，不是跑真 GL。它证明的是公式本身，两件事：
//   1. 线宽锁在设备像素上，放大不膨胀；
//   2. 缩小时线不会漏（靠的是沿方向找最近的缝，不是只看紧邻那一格）。
{
  const BW = 1.6;            // renderer.borderWidth
  const BA = 0.75;            // renderer.borderStrength
  const BR = 0.035 * 255;    // 边界色的红通道
  const FILL = 255;
  const st = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  /**
   * 新做法：沿四个方向走到第一条不一样的邻居，取垂距。
   * 这里只造一条竖着的分界线，所以只有左右两条射线找得到东西。
   */
  function profileNew(canvasW, viewX, viewW, B) {
    const mpd = viewW / canvasW;
    const R = Math.max(1, Math.min(48, Math.ceil(0.5 * mpd * (BW + 1))));
    const bw = 0.5 * BW * mpd, ramp = 0.5 * mpd;
    const tid = (p) => (p < B ? 0 : 1);
    const vals = [];
    for (let sx = 0; sx < canvasW; sx++) {
      const mx = viewX + (sx + 0.5) * viewW / canvasW;
      const ip = Math.floor(mx), f = mx - ip;
      const t = tid(ip);
      let d = Infinity;
      for (let k = 1; k <= R; k++) if (tid(ip + k) !== t) { d = Math.min(d, k - f); break; }
      for (let k = 1; k <= R; k++) if (tid(ip - k) !== t) { d = Math.min(d, f + k - 1); break; }
      const b = d < Infinity ? 1 - st(bw - ramp, bw + ramp, d) : 0;
      vals.push(FILL + b * BA * (BR - FILL));
    }
    return vals;
  }

  /** 旧做法：分界线两侧各占一格、按 0.6 混色；只看采样点紧邻那一格 */
  function profileOld(canvasW, viewX, viewW, B) {
    const vals = [];
    for (let sx = 0; sx < canvasW; sx++) {
      const mx = viewX + (sx + 0.5) * viewW / canvasW;
      const ip = Math.floor(mx);
      vals.push(FILL + ((ip === B - 1 || ip === B) ? 0.6 : 0) * (BR - FILL));
    }
    return vals;
  }

  const dark = (v) => v.filter((x) => x < 200).length;
  const cases = [
    ['1×',   128,    0,  128,   64],
    ['2×',   128,    0,   64,   32],
    ['4×',   128,   48,   32,   64],
    ['8×',   128,   56,   16,   64],
    ['全图', 1280,   0, 5632, 2816],
  ];
  console.log('\n=== 0b. 边界线宽（屏幕像素）===');
  console.log('   缩放      新：暗像素 / 最暗        旧：暗像素 / 最暗');
  for (const [name, cw, vx, vw, b] of cases) {
    const n = profileNew(cw, vx, vw, b), o = profileOld(cw, vx, vw, b);
    const nd = dark(n), od = dark(o);
    console.log(`   ${name.padEnd(6)} ${String(nd).padStart(3)} px / ${Math.min(...n).toFixed(0).padStart(4)}` +
                `             ${String(od).padStart(3)} px / ${Math.min(...o).toFixed(0).padStart(4)}`);
    ok(`  ${name}：线宽锁在设备像素上（2～3 个屏幕像素）`, nd >= 2 && nd <= 3, `${nd} px（旧版 ${od} px）`);
    ok(`  ${name}：是实线不是淡雾（最暗 ≤ 120）`, Math.min(...n) <= 120,
       `最暗 ${Math.min(...n).toFixed(0)}（旧版 ${Math.min(...o).toFixed(0)}）`);
  }
}

// ---------------------------------------------------------------- 色块接缝宽度
//
// 两个色块挨在一起时，接缝上被平均出来的那条混色带有多宽。
// 这是"边界上色为什么糊"的真正元凶：采样偏移以前写死 0.25 个**地图像素**，
// 放大 18 倍时那就是 4.5 个屏幕像素，四个采样点摊开跨 9 个像素，
// 中间那条 50% 混合色能铺满 8 个像素宽 —— 用户截图里量到的正是这个。
{
  const RED = [193, 58, 64], PINK = [227, 150, 255];
  //: 每个采样点相对片元中心的横向偏移，单位是"一个屏幕像素"
  const TAPS_NEW = [0.5, -0.16667, 0.16667, -0.5];            // 4 点旋转网格
  const TAPS_OLD = [0.25, -0.25, 0.25, -0.25];                // 旧的：固定 0.25 地图像素

  function seamWidth(taps, scale) {
    const mpd = 1 / scale;                 // 一个屏幕像素 = 多少地图像素
    const X = 1000;                        // 竖直的接缝落在哪
    let mixed = 0;
    for (let i = -20; i <= 20; i++) {      // 扫过接缝附近 41 个屏幕像素
      const mx = X + i * mpd;
      let r = 0, g = 0, b = 0;
      for (const t of taps) {
        // 旧的写法里偏移是固定 0.25 个地图像素；新的按屏幕折算
        const off = (taps === TAPS_OLD) ? t : t * mpd;
        const c = (mx + off) < X ? RED : PINK;
        r += c[0]; g += c[1]; b += c[2];
      }
      const cr = r / 4, cg = g / 4, cb = b / 4;
      const pureRed = Math.abs(cr - RED[0]) < 0.6 && Math.abs(cb - RED[2]) < 0.6;
      const purePink = Math.abs(cr - PINK[0]) < 0.6 && Math.abs(cb - PINK[2]) < 0.6;
      if (!pureRed && !purePink) mixed++;
    }
    return mixed;
  }

  console.log('\n=== 0c. 两个色块之间那条混色带有多宽（屏幕像素）===');
  console.log('   缩放     新（偏移按屏幕算）   旧（固定 0.25 地图像素）');
  const zooms = [1, 2, 4, 8, 18];
  let tooWide = 0;
  for (const z of zooms) {
    const n = seamWidth(TAPS_NEW, z), o = seamWidth(TAPS_OLD, z);
    console.log(`   ${String(z + '×').padEnd(7)} ${String(n).padStart(3)} px` +
                `                 ${String(o).padStart(3)} px`);
    if (n > 2) tooWide++;
    ok(`  ${z}×：接缝只有一格过渡（≤2 px）`, n <= 2, `${n} px（旧版 ${o} px）`);
  }
  ok('任何缩放下接缝都不糊', tooWide === 0, `${zooms.length} 个缩放档`);
  // 20 倍放大是用户截图那一档，旧写法铺了 8～9 个像素宽的 50% 混色
  ok('放大 18 倍时旧写法确实会糊成一条宽带（这条是复现，不是要求）',
     seamWidth(TAPS_OLD, 18) >= 8, `旧版 ${seamWidth(TAPS_OLD, 18)} px`);
}

// ---------------------------------------------------------------- 假 DOM

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = true;
    this.clientWidth = 1280;
    this.clientHeight = 820;
    this.width = 1280;
    this.height = 820;
    this.offsetWidth = 120;
    this.offsetHeight = 40;
    this._listeners = {};
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; }
  // 读 clientWidth 会逼浏览器同步重排，标注层在循环里读它是要命的，所以数一下
  get clientWidth() { canvasStats.clientW++; return this._cw; }
  set clientWidth(v) { this._cw = v; }
  get clientHeight() { canvasStats.clientH++; return this._ch; }
  set clientHeight(v) { this._ch = v; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; }
  getContext(kind) { return kind === '2d' ? ctx2d() : fakeGL(); }
  /* 🔴 **子树查询要真的能查** ✗✗（2026-10-19 ✓）
   *   原来是空壳 ✓ 可剧本下拉栏要用
   *     `btn.querySelector('.dd-label')` / `panel.querySelectorAll('[data-role="era-item"]')`
   *   —— 空壳拿不到东西，测试里下拉栏的字永远是空的 ✓
   *   三种写法够用：`[data-role="x"]` / `.cls` / `#id`（末尾可跟标签名 ✓）*/
  _all(sel, out) {
    const s = String(sel || '').trim();
    const dr = /\[data-role\s*=\s*["']([^"']+)["']\]/.exec(s);
    const cl = /(?:^|[\s>])\.([\w-]+)/.exec(s);
    const idm = /#([\w-]+)/.exec(s);
    const tagm = /([a-zA-Z][\w-]*)\s*$/.exec(s.replace(/\[[^\]]*\]/g, '').trim() || '');
    for (const c of this.children) {
      if (!c || !c._all) continue;
      let hit = false;
      if (dr) hit = !!(c._attrs && c._attrs['data-role'] === dr[1]);
      else if (cl) hit = !!(c.classList && c.classList.contains(cl[1]));
      else if (idm) hit = c.id === idm[1];
      if (hit && tagm && c.tagName && c.tagName.toLowerCase() !== tagm[1].toLowerCase()) hit = false;
      if (hit) out.push(c);
      c._all(sel, out);
    }
    return out;
  }
  querySelectorAll(sel) { return this._all(sel, []); }
  querySelector(sel) { return this._all(sel, [])[0] || null; }
  setAttribute(k, v) { this._attrs = this._attrs || {}; this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs && this._attrs[k] !== undefined ? this._attrs[k] : null; }
  removeAttribute(k) { if (this._attrs) delete this._attrs[k]; }
  contains(n) {
    if (!n) return false;
    if (this === n) return true;
    return this.children.some((c) => c && c.contains && c.contains(n));
  }
  click() { for (const fn of (this._listeners.click || [])) fn({ type: 'click', target: this }); }
  /** 派发任意事件（自测用 ✓）
   *  ⚠ 别只写 click ✓ —— 字体导入走的是 `change`、滑条走的是 `input` ✗ */
  dispatchEvent(ev) {
    const type = (ev && ev.type) || 'click';
    for (const fn of (this._listeners[type] || [])) fn(ev || { type, target: this });
  }
  /** 递归把子元素的 innerHTML/textContent 拼出来，方便断言 */
  flat() {
    return (this._html || '') + this.children.map((c) => c.flat()).join(' | ') +
      (this.textContent ? ' ' + this.textContent : '');
  }
}

/** Canvas2D 的调用计数 —— 用来量标注层每帧到底调了多少次贵操作 */
const canvasStats = { font: 0, measure: 0, stroke: 0, fill: 0, image: 0, clientW: 0, clientH: 0 };
function resetCanvasStats() {
  for (const k of Object.keys(canvasStats)) canvasStats[k] = 0;
}

function ctx2d() {
  const noop = () => {};
  const o = {
    setTransform: noop, clearRect: noop, textAlign: '', textBaseline: '', lineJoin: '',
    miterLimit: 0, lineWidth: 0, strokeStyle: '', fillStyle: '',
    // 2D 画布桩：图例要用到这一整套（save/beginPath/arcTo/fillRect…）✓ 缺了会直接炸 ✗
    save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arcTo() {}, arc() {}, rect() {}, quadraticCurveTo() {},
    fill() { canvasStats.fill++; }, stroke() { canvasStats.stroke++; },
    fillRect() { canvasStats.fill++; }, strokeRect() { canvasStats.stroke++; }, clearRect() {},
    translate() {}, scale() {}, rotate() {}, setLineDash() {}, clip() {}, setTransform() {},
    measureText: (t) => { canvasStats.measure++; return { width: String(t).length * 7 }; },
    strokeText: () => { canvasStats.stroke++; },
    fillText: () => { canvasStats.fill++; },
    drawImage: () => { canvasStats.image++; },
  };
  // font 是贵操作，单独数
  Object.defineProperty(o, 'font', {
    get() { return this._font || ''; },
    set(v) { this._font = v; canvasStats.font++; },
  });
  return o;
}

/** WebGL 用 Proxy 兜住 —— 真渲染不验，只求 gl.js 不炸 */
function fakeGL() {
  const t = {};
  return new Proxy(t, {
    get(_, k) {
      const s = String(k);
      if (s in t) return t[s];
      if (/^[A-Z0-9_]+$/.test(s)) return 1;                  // 常量
      return (...a) => {
        if (s.startsWith('create')) return { __m: s };
        if (s === 'getUniformLocation') return { __m: 'loc', name: a[1] };
        if (s === 'getAttribLocation') return 0;
        if (s === 'getParameter') return 16384;                // MAX_TEXTURE_SIZE 之类
        if (s === 'getShaderParameter' || s === 'getProgramParameter') return true;
        if (s === 'getExtension') return null;
        if (s.startsWith('get')) return 0;
        return undefined;
      };
    },
  });
}

const els = new Map();
const containers = { tier: new El(), tool: new El() };
function get(id) {
  if (!els.has(id)) els.set(id, new El('div', id));
  return els.get(id);
}

const documentStub = {
  title: '',
  getElementById: get,
  createElement: (t) => new El(t),
  addEventListener: () => {},
  querySelector: (sel) => {
    if (sel.includes('tier')) return containers.tier;
    if (sel.includes('tool')) return containers.tool;
    /* 🔴 剧本下拉栏那几个（2026-10-19 ✓）—— 按 `data-role` 懒建再记住 ✓
     *   （这个假 DOM 不解析 index.html ✓ 跟 getElementById 一个套路 ✓）*/
    const m = /\[data-role\s*=\s*["']([^"']+)["']\]/.exec(sel);
    if (m) {
      const key = 'role:' + m[1];
      if (!els.has(key)) {
        const el = new El(m[1] === 'era-btn' ? 'button' : 'div');
        el._attrs = { 'data-role': m[1] };
        els.set(key, el);
      }
      return els.get(key);
    }
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel.includes('tier')) return containers.tier.children
      .filter((c) => !/\bbutton\b/.test(sel) || String(c.tagName).toLowerCase() === 'button');
    if (sel.includes('tool')) return containers.tool.children
      .filter((c) => !/\bbutton\b/.test(sel) || String(c.tagName).toLowerCase() === 'button');
    const m = /\[data-role\s*=\s*["']([^"']+)["']\]/.exec(sel);
    if (m) {
      const key = 'role-list:' + m[1];
      if (!els.has(key)) els.set(key, new El('div'));
      return els.get(key).children;
    }
    return [];
  },
  body: new El('body'),
};

// ---------------------------------------------------------------- 假环境

let savedBlob = null;
const store = new Map();
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const rafs = [];
const sandbox = {
  console,
  document: documentStub,
  window: {
    addEventListener: () => {}, devicePixelRatio: 1,
    __CK3_EMBEDDED__: undefined,
  },
  localStorage: localStorageStub,
  indexedDB: H.makeIndexedDBFake(),   // 字体库要用 ✓
  performance: { now: () => Date.now() },
  requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
  cancelAnimationFrame: () => {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  TextEncoder, TextDecoder, Blob, Response, Request, Headers, URL, DecompressionStream,
  URL_createObjectURL_orig: URL.createObjectURL,
  fetch: async (url) => {
    const rel = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return new Response('', { status: 404 });
    const buf = fs.readFileSync(file);
    return new Response(buf, { status: 200, headers: { 'Content-Length': String(buf.length) } });
  },
};
sandbox.window.document = documentStub;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// URL.createObjectURL 抓 Blob
const RealURL = URL;
sandbox.URL = class extends RealURL {
  static createObjectURL(b) { savedBlob = b; return 'blob:fake'; }
  static revokeObjectURL() {}
};

// ---------------------------------------------------------------- 拍平源码

function stripModule(src) {
  return src.split('\n').map((line) => {
    const s = line.trim();
    if (s.startsWith('import ')) return '';
    if (s.startsWith('export ')) return line.replace('export ', '');
    return line;
  }).join('\n');
}

/* ⚠ 这份清单**必须和 build_standalone.py 的 MODULES 一致**（顺序也要对）——
   少一个模块的表现是"某个功能悄悄没了"，不是报错隔壁那行，特别难查 ✗
   pack.js / packstore.js 是导入式地图那套（见 docs/导入式地图-策划.md）；
   它们要排在 data.js 前面：data.js 的第三数据源会调 packstore 的 getFile ✓ */
const MODULES = ['pack.js', 'zip.js', 'packstore.js', 'fonts.js', 'bitmapfont.js', 'data.js', 'bmp.js', 'gl.js', 'labels.js', 'tilemap.js', 'app.js'];
let js = MODULES.map((n) => `// ==== ${n} ====\n` + stripModule(fs.readFileSync(path.join(ROOT, 'web', 'js', n), 'utf8'))).join('\n\n');

// 把结尾那次 boot() 摘掉，改由测试自己触发，并开几个探针出去
js = js.replace(/\nboot\(\);\n/, '\n');   // 只摘 boot(); 这一行（结尾还有注释和 initTutorial 挂钩，\s*$ 永远配不上）
js += `
return {
  boot, state, GAMES, MAP_CHOICES,
  get GAME() { return GAME; },
  get TIER_BADGE() { return TIER_BADGE; },
  /* ⚠ TIER_HOTKEY 是 boot 里按层数**重新生成**的模块级 let ✓
     不挂 getter 的话测试读到的是 undefined ✓（2026-10-19 加的 ✓）
     —— 这段在模板字符串里 ✗ 注释里不许出现反引号（会被截断 ✓ 我又踩了一次 ✓）*/
  get TIER_HOTKEY() { return TIER_HOTKEY; },
  get TIER_KEYS() { return TIER_KEYS; },
  eraBlockCount, blankTierIndex, closeEraPanel,
  titleAt, renderHoverCard, actAt, pickTitle, paintTitle, restoreTitle, pickAt,
  setBrush, setTier, setTool, needsRestore, isLocked, isSpecialTid, runSearch,
  jumpToResult, searchJumpScale, paintAt, hoverGroupRgb, hoverTargetTid, applyHoverHighlight,
  syncParentBorder, syncLayerSwitches, retintCountryLabels, buildBorderDepth,
  get searchHits() { return searchHits; },
  editTier, setGrain, gotoLevel, pressTier, eraTierCount, refreshTierButtons,
  projectData, saveProject, applyProject, labelForColor, undo, redo, recomputePainted,
  describeRendererFailure, createRendererWithRetry, clearWastePaint, paintPidsAsOne,
  provInfoAt, paintTargetsAt, labelMaxValue, labelPlaceMaxValue, saveMapPrefs, loadMapPrefs, clearRecent,
  rebuildPaintBlocks, paintedPoints, playerGroupTids, playerGroupTidsAt,
  /* **地名的连通域取点** ✓（2026-10-16 加 —— 地名改成"每个连通域一个标"之后
   *   真画的那份名单就是它 ✓ 下面 3h / 改名那两条断言要量它 ✓
   *   ⚠ 新加的探针函数**必须加进这一份清单** ✗ —— 少了就是
   *     "ex.xxx is not a function"（我这次就栽在这儿 ✓）
   *   ⚠ 这段整体在**模板字符串**里 ✗ —— 注释里**不许出现反引号** ✓
   *     （项目里栽过一次了：着色器那边同一个坑 ✓）*/
  buildPlaceComponents, placePointsFor, groupComponents,
  /* **「每省是不是水」那张表** ✓（2026-10-16 加 ——「水域 · 边界」那条通道的判据来源 ✓
   *   ⚠ 同样必须加进这一份清单 ✗ 见上面那段（少了就是 ex.xxx is not a function ✓）*/
  buildWaterKindMask, waterKindByPid,
  /* ⚠ **kindOfTid 也得加进来** ✗（2026-10-17 加 —— state.waterKindSet 那张表拆了 ✓
   *   标签闸改成问现成的 kindOfTid(tid) ✓ 断言要量它 ✓
   *   少了就是 ex.kindOfTid is not a function ✓ —— 我这次又栽在这儿了 ✓
   *   正是上面那段注释警告过的坑 ✓
   *   ⚠⚠ **这段注释里一个反引号都不许有** ✗✗ —— 整段在**模板字符串**里 ✓
   *     我第一版就是写了反引号 → 模板字符串当场截断 → Unexpected identifier ✓
   *     （上面那段警告写的正是这个 ✓ 我看了、还踩了 ✓）*/
  kindOfTid, kindOfPid,
  get renderer() { return renderer; },
  get labels() { return labels; },
  isDegradedBaron, displayedColor, displayedLabel, screenToMap, updateHover,
  drawLabels, legendEntries, drawLegend, rebuildLegendPanel, impassLabel, specialTileLabel,
  readablePlaceName, manualWaterName, computeLabelZoom, ARRIVE_SPAN,
  applySettings, lutColorOf, hexToRgb, renameAt, openRename,
  /* 荒地自动上色（2026-10-17 重做 ✓）—— 周长 / 重算 / 帧循环 ✓
   *   ⚠ 新探针必须加进这一份清单 ✗（少了就是 ex.xxx is not a function ✓）*/
  buildWastePidIndex, setupWastePerimeter, refreshWasteAuto, wasteWatch,
};`;

const factory = new Function(
  'console', 'document', 'window', 'localStorage', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'fetch', 'URL', 'TextEncoder', 'TextDecoder',
  'Blob', 'Response', 'indexedDB', js);

// ---------------------------------------------------------------- 跑

(async () => {
  const ex = factory(sandbox.console, documentStub, sandbox.window, localStorageStub,
    sandbox.performance, sandbox.requestAnimationFrame, sandbox.cancelAnimationFrame,
    setTimeout, clearTimeout, setInterval, clearInterval, sandbox.fetch, sandbox.URL,
    TextEncoder, TextDecoder, Blob, Response, sandbox.indexedDB);

  console.log(`\n=== 1. 启动（选单里点 ${CARD}）===`);
  // 界面上**只列游戏自带的图** ✓ —— 工坊那张高清图不对外发，所以清单里没有它。
  // 本地还想测它（数据在 data_eu4_hd/ ✓），就由测试临时把条目塞回去 ✓
  if (WHICH === 'EU4HD' && !ex.MAP_CHOICES.some((m) => m.key === 'eu4hd')) {
    ex.MAP_CHOICES.push({ key: 'eu4hd', emb: 'eu4hd', dir: '/data_eu4_hd', game: 'eu4',
                          label: 'EU4HD', note: '6400 × 2560' });
  }
  const booting = ex.boot();
  // boot 会 await fetch，先让它跑到弹出选单
  for (let i = 0; i < 50 && !get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const cards = get('map-pick-list').children;
  ok(`启动界面按地图表列出来（${ex.MAP_CHOICES.length} 张）`,
     cards.length === ex.MAP_CHOICES.length,
     cards.map((c) => c.flat().replace(/<[^>]*>/g, '').trim()).join(' / '));
  // 那一张工坊模组图**不许出现在对外版本里** ✓（没拿到模组作者授权 ✗）
  // 它要是哪天被人加回 MAP_CHOICES，这条立刻红 ✓
  const ali = cards.map((c) => c.flat()).join(' ');
  ok('选单里没有工坊那张模组图（只留游戏自带的）✓',
     !/米勒/.test(ali) && !/高清/.test(ali),
     /米勒|高清/.test(ali) ? '混进来了 ✗' : '干净');
  const card = cards.find((c) => c.flat().includes(CARD));
  ok(`其中一张是 ${CARD}`, !!card);
  // HOI4 拆成了两张：原版 + 自己改过边界的那张，两张都得在 ✓
  if (WHICH === 'HOI4') {
    const two = cards.map((c) => c.flat());
    ok('HOI4 有两张图可选（原版 / 修改边界）✓',
       two.some((t) => t.includes('HOI4 原版')) && two.some((t) => t.includes('HOI4 修改边界')),
       two.filter((t) => t.includes('HOI4')).join(' + ') || '（一张都没有）');
  }
  card.onclick();
  await booting;
  const bootStep = (get('boot-step') || {}).textContent || '';
  if (bootStep && !/就绪|100/.test(bootStep)) console.log('    启动失败：', bootStep);

  const st = ex.state;
  // ---- 剧本层的探针 ----------------------------------------------------------
  // **空白剧本**挂在剧本块最右边（1444 / 1618 / 1789 / 空白剧本 / 区域…✓ 见 patch_blank_era.py），
  // 所以"离当前视图最近的那个剧本层"（app 里的 countryTier()）在细层视图下要把它跳过去 ✓
  // 测试里统一用下面这两个：ERA0 = 第一个**有主**的剧本层；countryT = 跟 app 同一套 ✓
  // （CK3 没有剧本层：N_ERA=0、ERA0 取 0，跟着老规矩走 ✓）
  const N_ERA = (st.meta.eraDates || []).length;
  /** 空白剧本那一层（没有就是 -1 ✓） */
  const BLANK_T = (st.meta.tiers || []).indexOf('blank');
  const WL_SET = new Set(st.meta.wasteland || []);
  /** 这一格是不是**背景地形**（海/湖/河/荒地/不可通行 ✓）—— 空白层照抄的就是它们 ✓ */
  const isBgTid = (t) => (t == null || t === st.meta.noTitle) ? false
    : (WL_SET.has(t) || String((st.titles.keys || [])[t] || '').charAt(0) === '#');
  const ERA0 = (() => {
    for (let i = 0; i < N_ERA; i++) {
      if (i === BLANK_T) continue;               // 空白剧本不算"有主的剧本层" ✓
      for (let p = 1; p < st.meta.numProvinces; p++) {
        const t = ex.titleAt(p, i);
        if (t == null || t === st.meta.noTitle || t >= st.meta.numRealTitles) continue;
        if (isBgTid(t)) continue;                // 荒地节点（EU5 的小岛也算）不是"国家" ✓
        return i;
      }
    }
    return 0;
  })();
  /** 按名字现查某一层（'1444' / '省份' / '空白剧本' ✓）—— 别再用写死的下标 ✓ */
  const tierOf = (nm) => (st.meta.tierNames || []).indexOf(nm);
  {
    // 数据层的事实：这局荒地里有多少**序号在真头衔范围内**
    //   EU5 原来全是这种（17818/1819 ✗）→ 现在被 patch_waste_pseudo.py 挪成伪头衔了 ✓
    //   所以这条同时是**不变量断言**：荒地必须全在伪头衔区 ✓
    const _wl = st.meta.wasteland || [];
    const _nr = Number(st.meta.numRealTitles) || 0;
    const _below = _wl.filter((x) => x < _nr).length;
    console.log(`    （这局荒地 ${_wl.length} 个，序号在**真头衔范围内**的 ${_below} 个`
      + ' —— 必须全是 0 ✓ EU5 以前是 1818 ✗）');
    ok('荒地全是伪头衔（序号 >= numRealTitles ✓ 各模式一个形状 ✓）',
       _below === 0, `${_wl.length} 个荒地里 ${_below} 个还在真头衔范围 ✗`);
  }
  /* **越界 / 坏输入不许崩** ✓（2026-10-17 体检加的两条护栏）——
   *   `titleAt` 是全图扫 / 悬停 / 标签都在调的热路径，
   *   `applyProject` 吃的是**外部文件 / 本地暂存**，两者都不该让坏输入变成 TypeError ✓ */
  {
    const NONE = (st.meta.noTitle != null) ? st.meta.noTitle : 65535;
    ok('titleAt 越界 / 非法参数统一回 NO_TITLE（不崩 ✓）',
       ex.titleAt(0, 0) === NONE
       && ex.titleAt(-5, 0) === NONE
       && ex.titleAt(st.meta.numProvinces + 10, 0) === NONE
       && ex.titleAt(1, -1) === NONE,
       `0 / -5 / 越界 / 负层 = ${ex.titleAt(0, 0)} / ${ex.titleAt(-5, 0)} / `
       + `${ex.titleAt(st.meta.numProvinces + 10, 0)} / ${ex.titleAt(1, -1)}`);
    ok('applyProject 吃 null / 字符串 / 数字都静默回 0 ✓（外部文件不可信 ✓）',
       ex.applyProject(null) === 0 && ex.applyProject('x') === 0
       && ex.applyProject(42) === 0,
       '三种坏输入都没抛 ✓');
  }
  /** 跟 app 的 countryTier() 一套：细层视图下"最近的那个剧本层"要跳过空白剧本 ✓ */
  const countryT = () => {
    if (N_ERA <= 0) return st.tier;
    if (st.tier < N_ERA) return st.tier;
    const last = N_ERA - 1;
    return (BLANK_T === last && last > 0) ? last - 1 : last;
  };
  // **用自己的色 + 自己的名涂自己那块 → 两边必须同色同标记** ✓
  //   （数据层对不上，填色那趟就会平白划一条线 ✗ 用户报过 ✓ 这条锁死它 ✓）
  {
    try {
      const r0 = ex.renderer;
      const n = st.meta.numProvinces;
      const tm = st.titlemap;
      const ct = countryT();          // 跟 app 的 countryTier() 一套 ✓（跳过空白剧本 ✓）
      const row = ct * n;
      const nReal = st.meta.numRealTitles != null ? st.meta.numRealTitles : 1e9;
      const counts = new Map();
      for (let p = 1; p < n; p++) {
        const t = tm[row + p];
        if (t >= 0 && t < nReal) counts.set(t, (counts.get(t) || 0) + 1);
      }
      let tid = -1, bestC = 0;
      for (const [t, c] of counts) if (c > bestC) { bestC = c; tid = t; }
      const pids = [];
      for (let p = 1; p < n && pids.length < 2; p++) if (tm[row + p] === tid) pids.push(p);
      const nm = String(st.titles.names[tid] || '');
      const xy = r0.lutXY(tid);
      const i = (xy[1] * r0.lutW + xy[0]) * 4;
      const lutC = [r0.lutData[i], r0.lutData[i + 1], r0.lutData[i + 2]];
      const hasPaint = typeof ex.paintAt === 'function' && pids.length === 2;
      const a = pids[0], b = pids[1];
      // **整张快照**：涂色是按头衔刷的（会一次涂掉它名下**所有**省份 ✓）
      //   所以只还原一块没用 ✗ 后面的测试会被脏数据坑 ✓（我栽过一次 ✓）
      const svPD = hasPaint ? r0.paintData.slice() : null;
      const svPL = hasPaint ? r0.paintLabelData.slice() : null;
      const svProvLabelAll = (hasPaint && st.provLabel) ? st.provLabel.slice() : null;
      const svProvTitleAll = (hasPaint && st.provTitle) ? st.provTitle.slice() : null;
      const svPainted = st.painted ? Array.from(st.painted) : null;
      const svBrushLabel = st.brushLabel, svBrush = st.brush;
      try { if (hasPaint) { st.brushLabel = nm; st.brush = lutC; ex.paintAt(pids[0], tid); } } catch (e) { /* ✓ */ }
      const sameMark = hasPaint && r0.paintLabelData[a] === r0.paintLabelData[b];
      const sameCol = hasPaint && r0.paintData[a * 4] === lutC[0]
        && r0.paintData[a * 4 + 1] === lutC[1] && r0.paintData[a * 4 + 2] === lutC[2];
      const extra = hasPaint ? ('标记 ' + r0.paintLabelData[a] + '/' + r0.paintLabelData[b]
                     + '，涂的色 ' + JSON.stringify([r0.paintData[a * 4], r0.paintData[a * 4 + 1], r0.paintData[a * 4 + 2]])
                     + ' vs LUT ' + JSON.stringify(lutC)
                     + '，该头衔 ' + bestC + ' 块地') : '拿不到 paintAt ✗';
      // 整张还原现场 ✓
      try {
        if (hasPaint) {
          r0.paintData.set(svPD);
          r0.paintLabelData.set(svPL);
          if (svProvLabelAll) st.provLabel.set(svProvLabelAll);
          if (svProvTitleAll) st.provTitle.set(svProvTitleAll);
          if (svPainted) st.painted = new Set(svPainted);
          st.brushLabel = svBrushLabel; st.brush = svBrush;
          r0.paintDirty = true; r0.dirty = true;
        }
      } catch (e) { /* ✓ */ }
      ok('用自己的色 + 自己的名涂自己那块 → 颜色和标记都跟原版一致（填色线不该划）',
         sameMark && sameCol, extra);
    } catch (e) { ok('用自己的色 + 自己的名涂自己那块（跑不动）', false, String(e && e.message)); }
  }
  const HTML = require('fs').readFileSync('web/index.html', 'utf8');
  // 二级设置页：控件都在 / 改了真生效 / 恢复默认 / 跟着存档走 ✓
  {
    /* 🔴🔴 **2026-10-16 把这份清单换成"现在真的在界面上"的那些** ✗✗
     *   原来点名的 15 个里有一半是**已经不存在的 id** ✗：
     *     `set-waste`（荒地那组 2026-10-15 退役 ✓）· `set-w`（老「地方边界宽度」✓ 后来拆成
     *     省/地区两条 ✓）· `set-a0 / set-a1 / set-a2`（老的三条浓度 ✓ 现在是 pa/ra/ca ✓）
     *   → 它一直在红（历史老账 ✓）而且**红得没意义**：量的是早就删掉的东西 ✓
     *   现在改成量**当前这四栏里真的有**的那些 ✓ 一件不落 ✓
     *   ⚠ 加新控件时**记得往这份清单里补** ✗（这就是它的用处 ✓）*/
    const ids = ['btn-settings', 'settings', 'set-reset', 'set-close',
                 // 颜色栏（7 项 ✓）
                 'set-bg', 'set-unpainted', 'set-sea', 'set-isea', 'set-lake', 'set-river',
                 'set-impass',
                 // 边界栏（8 根 ✓）
                 'set-w-prov', 'set-pa', 'set-w-region', 'set-ra',
                 'set-pw', 'set-ca', 'set-water-w', 'set-water-a',
                 // 名字栏（5 项 ✓）
                 // 名字栏（6 项 ✓ 2026-10-17 字号拆两块 → 6 根 ✓）
                 // ⚠ **逗号别漏** ✗✗ —— 漏了就会跟下一行拼成一个字符串、静默少查一个 ✓
                 'set-fontplace', 'set-fontpower',
                 'set-labelmax', 'set-labelplacemax', 'set-labelac', 'set-labelap',
                 // 其他栏（4 项 ✓）
                 'set-legend', 'set-legend-title', 'set-legend-pos', 'set-picktool'];
    const miss = ids.filter((id) => !get(id));
    ok('设置页的控件都在页面上', miss.length === 0,
       miss.length ? ('缺: ' + miss.join(',')) : `${ids.length} 个都在`);

    /* 🔴🔴 **那一作的显示名是「VIC3」** ✗✗（2026-10-16 用户定的：原话"之后V3改名叫VIC3吧"✓）
     *   三件事一起钉 ✗：
     *     ① `GAMES.vic3.name` = `VIC3`（进日志与标题 ✓）
     *     ② `MAP_CHOICES` 那张卡 = `VIC3 原版`（**这一条最要紧**——
     *        测试 / 探针全是**按名字找那张卡**的 ✓ 改坏了它们会静默找不到 ✓）
     *     ③ **旧名不许再出现在界面文案里** ✗（`'V3'` 那种写法 ✓
     *        但注释里提历史是允许的 ✓ 所以只查"带引号的字面量" ✓）
     *   ⚠ 只改**给人看的名字** ✗ —— `id` / `game` / `dir` / `saveKey` / `filePrefix`
     *     一个都不许动 ✓（动了老存档、老包、缓存目录全接不上 ✓）
     *     `brand: 'VIC'` + `brandSmall: '3'` 是招牌，也不动 ✓ */
    {
      const _a = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');
      /* ⚠ **别拿 `indexOf('saveKey')` 当"这个对象到哪儿结束"的锚点** ✗✗ ——
       *   我第一版就这么写的 ✓ 结果那段注释里**我自己提了一句 `saveKey`** ✗
       *   → 切出来的片段是空的 → 断言报"(没找到)" → **假红** ✓
       *   正解：**按行扫**，只看**真字段行**（`^\s*saveKey:` 那种 ✓
       *     注释行以 `*` / `/*` 开头 ✓ 一眼能排掉 ✓）*/
      const _lines = _a.split('\n');
      const _start = _lines.findIndex((l) => /^\s{2}vic3:\s*\{/.test(l));
      let _nm = null;
      for (let k = _start; k >= 0 && k < _lines.length; k++) {
        const l = _lines[k];
        if (k > _start && /^\s*\}?,?\s*$/.test(l)) break;        // 这个对象收尾了 ✓
        const m = /^\s*name:\s*'([^']+)'/.exec(l);
        if (m) { _nm = m[1]; break; }
      }
      ok('GAMES.vic3.name 是「VIC3」（不再是 V3 ✗）',
         _nm === 'VIC3', _nm ? `name='${_nm}'` : '(没找到)');
      const _lb = /key:\s*'vic3'[^}]*label:\s*'([^']+)'/.exec(_a);
      ok('选图卡片叫「VIC3 原版」（测试与探针按这个名字找卡 ✓）',
         !!_lb && _lb[1] === 'VIC3 原版', _lb ? `label='${_lb[1]}'` : '(没找到)');
      //: ③ 旧名不许再当字面量出现（注释里提历史不算 ✗ → 只查引号包起来的 ✓）
      ok('界面文案里不再有「V3」这个旧名',
         !/'V3'/.test(_a), /'V3'/.test(_a) ? "还有 'V3' 字面量" : '干净 ✓');
    }

    // 改「海洋」颜色 → LUT 里那个节点真的变了
    let seaTid = -1;
    for (let i = 0; i < st.titles.keys.length; i++) {
      if (String(st.titles.keys[i]) === '#sea') { seaTid = i; break; }
    }
    if (seaTid >= 0) {
      const L = ex.renderer.lutData;
      const before = [L[seaTid * 4], L[seaTid * 4 + 1], L[seaTid * 4 + 2]];
      st.set.sea = [12, 34, 56];
      ex.applySettings();
      const after = [L[seaTid * 4], L[seaTid * 4 + 1], L[seaTid * 4 + 2]];
      ok('改「海洋」颜色 → LUT 真的变了',
         after[0] === 12 && after[1] === 34 && after[2] === 56,
         '前=' + before.join(',') + ' 后=' + after.join(','));
      st.set.sea = null;
      ex.applySettings();
    } else {
      ok('（这张图没有 #sea 节点，跳过改色检查）', true, '-');
    }

    // 改「省份 / 地区边界宽度」→ 渲染器线宽跟着变
    const w0 = ex.renderer.borderWidth;
    /* ⚠ **2026-10-13 起「地方边界宽度」拆成了两条** ✗（用户要求 ✓）：
     *     · `wProv`   = 「省份边界宽度」→ 管**本层**那条线（原来 `w` 干的活 ✓）
     *     · `wRegion` = 「地区边界宽度」→ 管**父级链** ✓
     *   老字段 `w` 只剩兼容读（`setNum('w', null)` ✓ 老存档里才有的那个 ✓）
     *   → 这条要动的是**新字段**，不是 `w` ✓（不然"设置了没反应"是假的 ✓）*/
    st.set.wProv = 3; st._parentSig = null; ex.syncParentBorder();
    const w1 = ex.renderer.borderWidth;
    // 默认没有链（父级边界出厂是关的）→ 本层线宽就等于「省份边界宽度」本身 ✓
    // （档位 = W_STEPS 六档 ✓ 默认 1；势力线 / 填色线走 `pw` ✓ 另一档）
         ok('改「省份边界宽度」→ 渲染器线宽跟着变（那个值就是粗细本身 ✓）', Math.abs(w1 - 3) < 0.01,
       w0.toFixed(2) + ' → ' + w1.toFixed(2));
    // 「恢复默认」→ 回到出厂值
    st.set = { bg: null, waste: null, sea: null, lake: null, impass: null,
               w: null, wProv: 1, wRegion: 1, a0: 0.5, a1: 0.75, a2: 1.0, pw: 1.5, font: 1 };
    st._parentSig = null; ex.syncParentBorder();
    ok('点「恢复默认」→ 线宽回出厂', Math.abs(ex.renderer.borderWidth - w0) < 0.01,
       ex.renderer.borderWidth.toFixed(2) + ' vs ' + w0.toFixed(2));

    // 存档里**仍然带着**设置 ✓，但**导入时不套回来** ✗
    // （工程里那份 settings 是导出那一刻的界面开关 ✓ —— 势力名/地名一被套回来，
    //   剧本国家名就整片空了 ✓ = 用户报的"导入后国名全空"✓）
    st.set.font = 1.3;
    const proj2 = ex.projectData();
    st.set.font = 1;
    ex.applyProject(proj2);
    ok('导出仍带设置、但**导入不覆盖**当前界面设置（免得国名被关掉）',
       st.set && Math.abs(st.set.font - 1) < 1e-6 && proj2.settings && proj2.settings.font === 1.3,
       'font=' + (st.set && st.set.font) + ' 文件里=' + (proj2.settings && proj2.settings.font));
    st.set = { bg: null, waste: null, sea: null, lake: null, impass: null,
               w: 1, a0: 0.5, a1: 0.75, a2: 1.0, pw: 1.5, font: 1 };
    ex.applySettings();                      // 把字号倍率也一起还原 ✓
  }

  // 改名工具：涂过的改「这支笔」的名字，没涂的改头衔名，都跟着存档走 ✓
  {
    const _fineT = st.meta.tiers.length - 1;   // LAST_TIER 这时还没定义（TDZ）✗
    // 工具按钮是 JS 按 TOOLS 生成的（不在 index.html 里）→ 工具表查源码、弹窗查页面 ✓
    const appSrc = require('fs').readFileSync('web/js/app.js', 'utf8');
    ok('改名工具在工具表里、弹窗控件也在',
       /id: 'rename'/.test(appSrc) && /id="rename-input"/.test(HTML)
       && /id="rename-ok"/.test(HTML) && /id="rename-cancel"/.test(HTML),
       'onclick=' + (typeof ex.renameAt === 'function'));

    // **工具表**：改名之后是"填色 / 涂抹 / 橡皮"这三个名字 ✓
    //   · 填色（F）—— 点一下动一次，**按住拖也不会连发** ✓
    //   · 涂抹（E）—— 按住拖刷一片（原来的「涂色」✓）
    //   · 橡皮（R）—— 擦回原样（原来的「还原」✓）
    ok('工具表里有 填色 / 涂抹 / 橡皮（顺序：吸管 → 填色 → 涂抹 → 橡皮 ✓）',
       /id: 'fill', label: '填色'/.test(appSrc)
       && /id: 'paint', label: '涂抹'/.test(appSrc)
       && /id: 'erase', label: '橡皮'/.test(appSrc)
       && appSrc.indexOf("id: 'fill'") < appSrc.indexOf("id: 'paint'"),
       '填色在前=' + (appSrc.indexOf("id: 'fill'") < appSrc.indexOf("id: 'paint'")));
    ok('「填色」不参与按住拖动连发（只有涂抹 / 橡皮置 painting ✓）',
       /painting = \(state\.tool === 'paint' \|\| state\.tool === 'erase'\)/.test(appSrc)
       && /state\.tool === 'paint' \|\| state\.tool === 'fill'/.test(appSrc),
       '落笔那一支也认 fill ✓');

    /* **取完色自动切工具** ✓（用户要求）
     *   · 已经在**涂抹 / 填色**上 → 不动（别打断正在画的活儿 ✓）
     *   · 其余工具上取色 → 切到设置指定的那个（涂抹 / 填色 ✓ 默认涂抹）
     */
    {
      const svTool = st.tool, svPT = st.set.pickTool;
      st.set.pickTool = 'paint';
      ex.setTool('view');
      ex.setBrush([11, 22, 33], false, true);
      ok('查看上取个色 → 自动切到「涂抹」✓', st.tool === 'paint', st.tool);
      ex.setTool('fill');
      ex.setBrush([44, 55, 66], false, true);
      ok('已经在「填色」上取色 → 不会被踹去涂抹 ✓', st.tool === 'fill', st.tool);
      ex.setTool('erase');
      ex.setBrush([77, 88, 99], false, true);
      ok('在画图工具之外的「橡皮」上取色 → 照样切涂抹 ✓', st.tool === 'paint', st.tool);
      st.set.pickTool = 'fill';
      ex.setTool('view');
      ex.setBrush([12, 34, 56], false, true);
      ok('设置成「切到填色」→ 取色后切到填色 ✓', st.tool === 'fill', st.tool);
      st.set.pickTool = svPT;
      ex.setTool(svTool);
      ex.setBrush([200, 50, 50], false);
      ex.setTool(svTool);
    }

    /* **设置页的控件统一长相** ✓（用户要求：字体、颜色统一一下）
     * 以前只给 color / range 写了样式 ✗ → select / text / checkbox / 数值提示
     * 全是浏览器默认的白底 + 默认字号，在深色主题里一眼就出戏 ✓
     */
    {
      const css = require('fs').readFileSync('web/style.css', 'utf8');
      const need = ['.set-row input[type=text]', '.set-row input[type=number]',
                    '.set-row select', '.set-row input[type=checkbox]', '.set-row .hint'];
      const miss = need.filter((s) => !css.includes(s));
      ok('设置页的控件都有统一样式（select / text / number / checkbox / hint ✓）',
         miss.length === 0, miss.length ? '缺：' + miss.join(' / ') : '5 类都写了');
      ok('控件的焦点色统一走 --gold ✓',
         /\.set-row select:focus[\s\S]{0,140}border-color: var\(--gold\)/.test(css));
      ok('图例列表也走同一套变量（不再硬编码那个 #26313d ✓）',
         !/\.legend-list \{[^}]*#26313d/.test(css));
      // 「名字上限」的数值提示必须在**滑块左边** ✓ ——
      // 放右边的话 `.set-row` 的 space-between 会把滑块挤到中间，
      // 跟上面「字号倍率」那根（标签 + 滑块两元素）就对不齐了 ✗
      /* ⚠ **2026-10-17：那两行标签都缩成「上限」了** ✗（块头说清了是谁的 ✓）*/
      /* ⚠ 2026-10-20 UI 重做：「上限」不再是滑条了 ✓
       *   数量 = 步进器（1~20）+ **独立的「不限」勾** ✓
       *   —— 原来"无上限"是滑条最右那一格（第 21 格），拖到底才知道有陷阱 ✗ */
      ok('「数量」有独立的「不限」勾（不再是滑条最右那格 ✓）',
         /上限<\/span><span class="hint" id="set-labelmax-v"><\/span><input type="range" id="set-labelmax"/.test(HTML)
         && /\.set-row \.hint \{[^}]*margin-right: auto/.test(css));
      /* **上限是"每个国家"的，不是"全世界"的** ✓（用户澄清过一次 ✓
       *   他要的是"英国本土 + 它的殖民地，加起来最多 N 个" ✓
       *   我第一版写成全局取前 N ✗ → 一屏只剩十几个国名 ✗（EU4 有 1863 坨）
       *   → 现在按**显示色 + 名字**分组、每组各留 N 个 ✓ */
      ok('每国名字上限：按族分组截断（不是全局取前 N ✗）',
         /const _per = new Map\(\)/.test(appSrc)
         && /_per\.get\(k\)/.test(appSrc)
         && !/if \(_cap > 0 && out\.length > _cap\) out\.length = _cap;/.test(appSrc));
      /* **地名上限**（2026-10-16 用户定的 ✓）：跟「势力名称上限」**分开一根** ✓
       *   地名也改成"每个连通域一个标"之后，一个头衔底下可能一堆碎块 ✓ */
      ok('「数量」是步进器（地块 / 势力各一个 ✓ 1~20，同款档位 ✓）',
         /上限<\/span><span class="hint" id="set-labelplacemax-v"><\/span><input type="range" id="set-labelplacemax"[^>]*min="1"[^>]*max="21"/
           .test(HTML)
         && />地名上限</.test(HTML) === false,      // 旧名一个都不许留 ✓
         '地块 / 势力各一根 ✓');
      /* 🔴 2026-10-17 用户："设置里的地名最高上限改为1" ✓
       *   默认值从 12 改成 1（老存档的旧默认 12 会迁一次，见 app.js 的 placeCapV1 ✓） */
      ok('地名上限默认 = 1（2026-10-17 用户定的 ✓）',
         /labelPlaceMax: 1,/.test(appSrc) && ex.labelPlaceMaxValue() === 1,
         `labelPlaceMaxValue=${ex.labelPlaceMaxValue()}`);
      ok('地名上限按 **tid** 分组截断（不是全局取前 N ✗）',
         /const per = new Map\(\)/.test(appSrc)
         && /per\.get\(p\.tid\)/.test(appSrc)
         && /per\.set\(p\.tid, c \+ 1\)/.test(appSrc));
      /* 🔴 **跨接缝那套已退役** ✓（2026-10-16 用户定的 ✓）——
       *   邻接表只连图内 4 邻域、没有跨左右边界的边 → 那片海本来就是两块 ✓
       *   → `wrapLabel` / `buildWrapLabelPoints` / 圆均值（`Math.atan2`）全没了 ✓
       *   ⚠ 断言只盯**代码** ✗ —— 注释里还写着这些名字（讲历史 ✓ 会误报 ✓）*/
      {
        const eu5src = fs.readFileSync(path.join(ROOT, 'build_eu5.py'), 'utf8');
        const left = [
          ['buildWrapLabelPoints 函数', /function buildWrapLabelPoints/.test(appSrc)],
          ['读 titles.wrapLabel', /state\.titles\.wrapLabel/.test(appSrc)],
          ['圆均值 Math.atan2', /Math\.atan2/.test(appSrc)],
          ['build_eu5.py emit wrapLabel', /"wrapLabel":/.test(eu5src)],
        ].filter(([, hit]) => hit).map(([k]) => k);
        ok('跨接缝那套（wrapLabel / 左右各一枚 / 圆均值）已退役',
           left.length === 0, left.length ? '还剩：' + left.join(' / ') : '一处不剩 ✓');
      }
      /* **线宽五档 / 浓度四档** ✓（用户定的）：
       *   下拉里的档位必须跟 app 里那几张表对得上（两处写死，测试盯着 ✓）
       *   浓度就是 25% / 50% / 75% / 100% 这四档 ✓ */
      /* **用户这次要的两件事**（都是硬要求 ✓ 钉住防回退）
     *   ① 边界宽度要有 **0.5** 这一档（原来从 1 起 ✗ 六档 ✓）
     *   ② **默认宽度一律 1.0**（原来 pw/waterW/wasteW 是 1.5 ✗）
     *   ⚠ 浓度（pa/ra/ca）**不动** ✗ 用户说的是"宽度都是 1.0" ✓ */
    {
      const a = fs.readFileSync(path.join(ROOT, "web", "js", "app.js"), "utf8");
      const h = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
      const _tables = (a.match(/const [A-Z_]+_STEPS = \[[^\]]*\]/g) || []);
      const _wTables = _tables.filter((s) => !/CONC_STEPS/.test(s));
      const _allHalf = _wTables.length >= 2 && _wTables.every((s) => /\[0\.5,/.test(s));
      ok("每张宽度档位表都有 0.5 那一档（六档 ✓）", _allHalf,
         (_allHalf ? '都在：' : '缺：')
         + _wTables.map((s) => s.replace('const ', '').split(' =')[0]).join(' / ')
         /* ⚠ 表名变过 ✗：以前还有一张「背景线宽」表（BG_STEPS ✓ 后来并掉 / 改名了 ✓）
            所以这里**不点名**某一张，只要求"凡是宽度表都从 0.5 起" ✓
            （哪天再加一张宽度表，这条也会自动盯着 ✓）*/);
      /* ⚠ 控件从滑条换成步进器 ✓ → 看 `data-range` ✓（2026-10-21）*/
      ok("宽度控件都从 0.5 起、按 0.5 一档（省份 / 地区 / 势力 / 水域 / 荒地 ✓）",
         (h.match(/data-range="0\.5,3,0\.5"/g) || []).length === 5,
         (h.match(/data-range="0\.5,3,0\.5"/g) || []).length + "/5");
      /* **浓度要有 0%** ✗（用户要的 ✓ 0% = 那条线完全不画 ✓）*/
      ok("不透明度档位含 0%（五档 ✓）",
         /const CONC_STEPS = \[0, 25, 50, 75, 100\]/.test(a)
         && (h.match(/data-steps="0,25,50,75,100"/g) || []).length >= 4,
         "档位表 " + (/\[0, 25, 50, 75, 100\]/.test(a) ? "有0" : "没0")
         + " · 滑条 " + (h.match(/min="0" max="100" step="25"/g) || []).length + " 条");
      /* 🔴🔴 **默认值那几条改成"读真值"** ✗✗（2026-10-17 重写 ✓）
       *   原来那套是拿正则在 app.js 里找 `/w: 1, pa/` 这种**排版片段** ✗ ——
       *   排版一改就假红 ✓（实测：**HEAD 版就已经红了** ✓ 老账一条）
       *   → 现在从 `const SET_DEFAULTS` 那一段里把键值**读出来**再比数 ✓
       *     排版怎么动都不影响 ✓（这是"量真值"，不是"量文字"✓）
       *   ⚠ 加了新的滑条就把它补进 `want` ✓（别再退回"正则找片段"那条路 ✗）*/
      {
        const _blk = a.slice(a.indexOf('const SET_DEFAULTS'));
        const _body = _blk.slice(0, _blk.indexOf('\n};'));
        /* ⚠ 这里**别用手写正则** ✗✗ —— 我第一版写的
         *   `new RegExp('(?:^|[{,\\s])' + k + ':\\s*…')` 死活读不出 `wRegion:` 那些键 ✓：
         *   `^` 在**没加 m 标志**时不匹配换行位置 ✗ 而那几个键正好在行首 ✓
         *   → 逐行解析 ✓ 顺带把「一行好几个键」那种写法
         *     （`pa: 50, ra: 75, ca: 100, pw: 1,`）也一并解决 ✓（靠正则得再写一条 ✗）*/
        const _num = (k) => {
          let hit = null;
          for (const _ln of _body.split('\n')) {
            const _re = new RegExp('(?:^|[{,])\\s*' + k + ':\\s*(-?[0-9.]+)');
            const _m = _re.exec(_ln);
            if (_m) hit = Number(_m[1]);
          }
          return hit;
        };
        /* **宽度一律 1.0**（用户 2026-10-16 定的："默认宽度都是 1.0"✓）
         * ⚠ `waterA` 是**不透明度**不是宽度 ✗ 归下一条管 ✓ 别塞进 want ✓ */
        const want = { wRegion: 1, wProv: 1, pw: 1, waterW: 1 };
        ok('默认宽度一律 1.0（省份 / 地区 / 势力 / 水域 ✓）',
           Object.keys(want).every((k) => _num(k) === want[k]),
           Object.keys(want).map((k) => k + '=' + _num(k)).join(' · '));
        /* **水域不透明度默认 25%** ✓（2026-10-17 用户定的："默认水域边界不透明度是25%"✓
         *   2026-10-16 那版是 100（实心 ✓ 图个"默认观感不变"）→ 现在改成淡的 25 ✓
         *   跟"默认关闭水域边界"配着看：这一档默认就是个**很淡的辅助线** ✓）*/
        ok('水域边界不透明度默认 25%（2026-10-17 用户定的 ✓）',
           _num('waterA') === 25, `waterA=${_num('waterA')}`);
        /* **两个水域开关默认关闭** ✓（2026-10-17 用户定的："默认关闭水域边界、名称"✓
         *   ⚠ 这两面旗在 `state` 的**初值**里（不在 SET_DEFAULTS 里 ✗ 那是设置页的账 ✓）
         *     所以这一条读 `app.js` 的 state 初值那两行 ✓
         *     顺带也盯 HTML 里那两个复选框**不许写 `checked`** ✗
         *     （不盯的话：界面一开是勾着的、状态却是关的 → 用户点一下反而"关"不掉 ✓）*/
        const _st = appSrc;
        ok('「水域 · 边界 / 名称」两面旗默认都是 false（开图时水缝不画、水名不出 ✓）',
           /showWaterBorder:\s*false/.test(_st) && /showWaterName:\s*false/.test(_st),
           (/showWaterBorder:\s*(\w+)/.exec(_st) || ['', '?'])[1] + ' / '
           + (/showWaterName:\s*(\w+)/.exec(_st) || ['', '?'])[1]);
        ok('HTML 里那两个复选框不许写 `checked`（界面初值要跟状态一致 ✓）',
           !/id="show-water-border"[^>]*\schecked/.test(HTML)
           && !/id="show-water-name"[^>]*\schecked/.test(HTML),
           '两个都没勾 ✓');
      }
    }
    ok('宽度 / 浓度档位表都在 app 里（宽度每张都含 0.5 ✓ 浓度含 0 ✓）',
         (appSrc.match(/const [A-Z_]+_STEPS = \[[^\]]*\]/g) || [])
           .filter((s) => !/CONC_STEPS/.test(s)).length >= 2
         && (appSrc.match(/const [A-Z_]+_STEPS = \[[^\]]*\]/g) || [])
           .filter((s) => !/CONC_STEPS/.test(s)).every((s) => /\[0\.5,/.test(s))
         && /const CONC_STEPS = \[0, 25, 50, 75, 100\]/.test(appSrc)
         /* ⚠ 同样**不点名**具体表名 ✗ —— 名字换过（BG_STEPS 那张没了 ✓）
            这条只管"宽度表从 0.5 起、浓度表含 0" ✓（见上面那段说明 ✓）*/);
      // **边界那九条全是滑条** ✓（用户定的）—— 档位靠 min/max/step 锁住 ✓ 不用下拉 ✓
      //   线宽：0.5~3 步长 0.5 ✓（六档）  浓度：0~100 步长 25 ✓（五档，含 0% = 不画 ✓）
      /* ✅ **2026-10-21 起控件换成步进器 / 分段条** ✗：`set-xxx` 不再是 `<input type=range>`
         而是 `<div class="ctl-step" data-range="0.5,3,0.5">` 和
         `<div class="ctl-seg" data-steps="0,25,50,75,100">` ✓
         → 这里统一折算成"min,max,step"三个数 ✓（老的 input 写法留作兜底 ✓）*/
      const _range = (id) => {
        let m = new RegExp('id="' + id + '"[^>]*data-range="([\\d.]+),([\\d.]+),([\\d.]+)"').exec(HTML);
        if (m) return m.slice(1).join(',');
        m = new RegExp('id="' + id + '"[^>]*data-steps="([\\d.,]+)"').exec(HTML);
        if (m) {
          const arr = m[1].split(',').map(Number);
          const step = arr.length > 1 ? (arr[arr.length - 1] - arr[0]) / (arr.length - 1) : 0;
          return [arr[0], arr[arr.length - 1], step].join(',');
        }
        m = new RegExp('id="' + id + '"[^>]*min="([\\d.]+)"[^>]*max="([\\d.]+)"[^>]*step="([\\d.]+)"').exec(HTML);
        return m ? m.slice(1).join(',') : '';
      };
      const _isRange = (id) => new RegExp('id="' + id + '"').test(HTML);
      /* 🔴 **2026-10-16 重写** ✗ —— 原来那四条量的是"背景那两条线"（水域 / 荒地 ✓
       *   荒地那条已退役 ✗；水域那条**语义换了**：现在是独立一条通道 ✓
       *   → 滑条 id 从 `set-waste-w/a` 换成 `set-water-w/a` ✓
       *     ⚠ `set-w` 那条老 id **还在 HTML 里**（老存档回填用它 ✓ 见 _range('set-w') ✓）
       *       但**界面上不显示**（它是历史包袱 ✓ 别再为它数滑条 ✗）*/
      const _widths = ['set-w-prov', 'set-w-region', 'set-pw', 'set-water-w'];
      ok('五条宽度控件**同一个范围**（0.5~3，步长 0.5 ✓ 六档）',
         _widths.every(_isRange) && _widths.every((id) => _range(id) === '0.5,3,0.5'),
         _widths.map((id) => id + '=' + (_range(id) || '无')).join(' '));
      ok('不透明度五条都是分段条（0/25/50/75/100 ✓ 五档）',
         ['set-pa', 'set-ra', 'set-ca', 'set-water-a'].every((id) => _isRange(id) && _range(id) === '0,100,25'),
         'set-ca=' + _range('set-ca') + ' 水域浓=' + _range('set-water-a'));
      /* 🔴 **导出按钮出错必须有人管** ✗（用户报：手机版导出 `Script error: 0` ✓）
       *   根因：`_wrap` 原来只有一句 `return fn(ev)` ✗ 而 exportFullPNG 是 **async** ✓
       *   → 它抛错成了**未处理的 Promise 拒绝** ✓ 手机浏览器报成 Script error: 0
       *     （跨域屏蔽把堆栈全藏了 ✓ 所以那个报错什么信息都没有 ✓）
       *   ⚠ 只接同步异常是不够的 ✗ **必须连 .then 的那种也接** ✓
       *     这条断言就是防"以后有人把 _wrap 简化回一句 return" ✓ */
      {
        const a = fs.readFileSync(path.join(ROOT, "web", "js", "app.js"), "utf8");
        const w = a.slice(a.indexOf("const _wrap = (fn)"), a.indexOf("function onExportFail"));
        ok("_wrap 同时接住同步异常和 async 拒绝 ✓",
           /try \{/.test(w) && /catch \(e\)/.test(w)
           && /typeof r\.then === .function./.test(w) && /r\.catch\(onExportFail\)/.test(w)
           && /function onExportFail/.test(a));
        /* 🔴 **不许弹系统分享面板** ✗（用户实测：文件存得下来 ✓ 但面板一直挂着 ✓）
         *   我上一轮"为了手机"加的 navigator.share 就是那个面板的来源 ✓
         *   → 手机上 <a download> 本来就能用 ✓ 别再自作聪明上 Web Share ✗
         *   ⚠ 断言要盯着**代码**，不能只看有没有"share"这个词 ✗
         *     （注释里就写着"不许调 navigator.share" ✓ 会误报 ✓）*/
        {
          const dl = a.slice(a.indexOf("function download(blob, name)"),
                             a.indexOf("function stamp()"));
          ok("download 只用 a.download（不弹系统分享面板 ✓）",
             /a\.download = name/.test(dl)
             && !/navigator\.share\s*\(/.test(dl) && !/navigator\.canShare/.test(dl)
             && !/window\.open/.test(dl),
             "download 里 " + (/navigator\.share\s*\(/.test(dl) ? "还有 share ✗" : "干净 ✓"));
        }
      }
      /* 🔴 **报错面板必须能关掉** ✗（用户报："报错弹窗不知道为什么会一直显示" ✓）
       *   以前那个条只有一颗"导出日志" ✗ 没有任何关闭入口 ✓
       *   而它 `position:fixed; bottom:0` ✓ 手机上占 45% 高 ✓
       *   → 一旦有错就**永久挡着半屏** ✓ 用户只能刷新页面 ✓
       *   ⚠ 这条跟"导出为什么出错"是**两件事** ✗ 这个是面板本身的缺陷 ✓
       *     所以单独钉住 —— 哪天别处又冒个错出来，至少用户能把它关掉 ✓ */
      {
        const a = fs.readFileSync(path.join(ROOT, "web", "js", "app.js"), "utf8");
        const fn = a.slice(a.indexOf("function showFatal"), a.indexOf("window.addEventListener('error'"));
        ok("报错面板有关闭按钮（点条也能关 ✓）",
           /id = 'fatal-close'/.test(fn) && /box\.remove\(\)/.test(fn)
           && /box\.onclick =/.test(fn),
           /fatal-close/.test(fn) ? "有关闭 ✓" : "关不掉 ✗");
      }
      /* 🔴 **渲染器初始化失败必须按 stage 分类** ✗✗（2026-10-17 管理员报的那条）
       *   以前 `new MapRenderer` 的任何异常都被 boot 写成"着色器编译失败" ✓
       *   管理员顺着这句在着色器源码里找了半天 —— 真正的病是 WebGL 上下文丢了 ✓
       *   现在：
       *     gl.js → `RendererSetupError` + `_setupFail('context-lost' …)` + compile 先判 `isContextLost`
       *     app.js → `describeRendererFailure` / `createRendererWithRetry` / 刷新重试按钮
       *   真行为用例在 `tools/check_renderer_error.js` ✓（这条只管"代码别退回老写法"✓）
       */
      {
        const _g = fs.readFileSync(path.join(ROOT, "web", "js", "gl.js"), "utf8");
        const _a = fs.readFileSync(path.join(ROOT, "web", "js", "app.js"), "utf8");
        ok('渲染器失败带 stage（上下文丢失不再被报成着色器错 ✗）',
           /class RendererSetupError/.test(_g)
           && /_setupFail\('context-lost'/.test(_g)
           && /gl\.isContextLost\(\)/.test(_g.slice(_g.indexOf('function compile'),
                                                    _g.indexOf('function makeTexture')))
           && /function describeRendererFailure/.test(_a)
           && /async function createRendererWithRetry/.test(_a)
           && /const fail = describeRendererFailure\(err\)/.test(_a)
           && !/rawErr\('✗ 着色器编译失败/.test(_a)
           && /id = 'fatal-reload'/.test(_a),
           '分类=' + /class RendererSetupError/.test(_g)
           + ' 翻译=' + /function describeRendererFailure/.test(_a)
           + ' 重试=' + /async function createRendererWithRetry/.test(_a)
           + ' 旧文案=' + /rawErr\('✗ 着色器编译失败/.test(_a));
        {
          const d1 = ex.describeRendererFailure({
            name: 'RendererSetupError', stage: 'context-lost',
            detail: { contextLost: true, unmaskedRenderer: 'FakeGPU' },
          });
          ok('上下文丢失 → 人话里只提显卡（不许再指着色器 ✗）',
             d1.code === 'WEBGL_CONTEXT_LOST'
             && /上下文/.test(d1.title)
             && !/着色器(编译|链接)失败/.test(d1.title + d1.body)
             && d1.steps.length >= 2,
             d1.code + ' · ' + d1.title);
          const d2 = ex.describeRendererFailure({
            stage: 'shader-compile', detail: { log: 'ERROR: 0:12 syntax error' },
          });
          ok('真·着色器编译错才说着色器，并带驱动日志 ✓',
             d2.code === 'SHADER_COMPILE_FAILED'
             && /着色器/.test(d2.title)
             && /syntax error/.test(d2.body),
             d2.code + ' · ' + d2.title);
        }
        {
          let n = 0;
          const r = await ex.createRendererWithRetry({}, {
            make: () => {
              n++;
              if (n === 1) {
                const e = new Error('lost');
                e.stage = 'context-lost';
                throw e;
              }
              return { ok: true };
            },
            wait: () => Promise.resolve(),
          });
          ok('上下文丢失会自动重试（刷新前先自救一次 ✓）',
             !!r && r.ok === true && n === 2, `第 ${n} 次成功`);
          let m = 0;
          let re = null;
          try {
            await ex.createRendererWithRetry({}, {
              make: () => {
                m++;
                const e = new Error('syntax');
                e.stage = 'shader-compile';
                throw e;
              },
              wait: () => Promise.resolve(),
            });
          } catch (e) { re = e; }
          ok('着色器真编译错不自动重试（重试也没用 ✓）',
             !!re && m === 1 && re.stage === 'shader-compile', `尝试 ${m} 次`);
          let k = 0;
          try {
            await ex.createRendererWithRetry({}, {
              make: () => {
                k++;
                const e = new Error('no webgl2');
                e.stage = 'no-webgl2';
                throw e;
              },
              wait: () => Promise.resolve(),
            });
          } catch (e) { /* 预期失败 ✓ */ }
          ok('no-webgl2 只重试一次（真不支持时别反复等 ✓）', k === 2, `尝试 ${k} 次`);
        }
      }
      /* **2026-10-17：那根滑条现在只叫「不透明度」** ✗（用户：「可以去掉那个势力or地块前缀了」✓
       *   块头「势力」已经说清了是谁的 ✓ 所以界面上就两个字 ✓
       *   ⚠ 变量名仍是 `labelAC` / `alphaCountry` ✗ 那是历史包袱 ✓ 别跟着改 ✓
       *   ⚠ 但**两根都得在**（地块一根 `set-labelap`、势力一根 `set-labelac` ✓
       *     拆两块之后少一根 = 有一类名字调不了不透明度 ✓）*/
      ok('两块各有一根「不透明度」（地块 = labelap · 势力 = labelac ✓）',
         (HTML.match(/<span>不透明度<\/span>/g) || []).length === 2
         && /id="set-labelap"/.test(HTML) && /id="set-labelac"/.test(HTML)
         && !/国名不透明度/.test(HTML) && !/势力名称不透明度/.test(HTML));
      ok('滑条旁边有当前值提示（跟「名字上限」同一套 ✓）',
         /function buildSliderTips/.test(appSrc) && /const SLIDER_TIPS = \[/.test(appSrc)
         && /margin-right: auto/.test(css));
      /* **高清导出（2×）** ✓（用户要求：一个地图像素拆成 2×2 ✓
       *   边界按**新的尺度**重画 ✓ —— 靠的是"视口照旧按地图坐标给、画布尺寸翻倍"，
       *   着色器那边 `uMapPerPx = view.w / canvas.width` 自动减半 ✓
       *   不是把 1× 的图放大那种糊 ✗）*/
      ok('导出菜单有「导出高清地图」（画布翻倍而视口不变 ✓）',
         /id="btn-png-full2">导出高清地图</.test(HTML)
         && /async function exportFullPNG\(scale = 1\)/.test(appSrc)
         && /out\.width = W \* scale/.test(appSrc)
         && /glCanvas\.width = tw \* scale/.test(appSrc)
         && /renderer\.setView\(tx, ty, tw, th\)/.test(appSrc)
         && /Math\.max\(512, Math\.floor\(2048 \/ scale\)\)/.test(appSrc)
         && /maybeDrawLegend\(ctx, W \* scale, H \* scale\)/.test(appSrc));
      /* ✅ **边界栏的命名规范 —— 2026-10-16 第二轮整条重写** ✓
       *   用户原话："**最大关键点：滑块左边就写边界宽度而不是省份边界宽度**"✓
       *   旧那条盯的是「省份边界宽度 / 地区边界浓度」那种**长标签** ✗
       *   现在那九个名字**一个都不在界面上了** ✓（类别交给 `.set-sub` 说 ✓）
       *   新规范 = **四类各两行，两行只说「边界宽度 / 浓度」** ✓
       *   ⚠ 旧名不许回来 ✗：「基准线宽」「海域宽度 / 海域浓度」「荒地浓度」
       *     还有把类别名重复一遍的「省份边界宽度」那种写法 ✓ */
      {
        /* 🔴 **2026-10-21 设置面板重排** ✗：旧的 `.set-sub` + `<h3>边界</h3>` 结构没了 ✓
           现在是按分页的 `<section class="set-col" data-group="border">` + **5×2 矩阵** ✓
           （行 = 省份/地区/势力/水域/荒地，列 = 线宽/不透明度 ✓ 表头只出现一次 ✓）
           → 断言认新结构，意图没变：这五类都各有"线宽 + 浓度"两列 ✓
           ⚠ 别再按旧的类名/标题找 ✗（那是上一版 UI 的写法 ✓）*/
        const _bi = HTML.indexOf('<section class="set-col" data-group="border"');
        const _bseg = _bi < 0 ? '' : HTML.slice(_bi, HTML.indexOf('</section>', _bi));
        /* ⚠ 允许 class 后面还跟着 id ✗ —— 荒地那格是
           `<span class="mx-name" id="set-waste-sub">荒地</span>` ✓ 只认紧贴 `>` 会漏掉它 ✓ */
        const _rows = (_bseg.match(/class="mx-name"[^>]*>([^<]+)</g) || [])
          .map((s) => s.replace(/.*mx-name"[^>]*>/, '').replace(/<.*$/, '').trim());
        const _wN = (_bseg.match(/class="ctl-step"/g) || []).length;
        const _aN = (_bseg.match(/class="ctl-seg"/g) || []).length;
        ok('边界栏：5×2 矩阵（行=省份/地区/势力/水域/荒地，列=线宽/不透明度 ✓）',
          _rows.length === 5 && _rows.join('/') === '省份/地区/势力/水域/荒地'
          && _wN === 5 && _aN === 5,
          `行=${_rows.join('/') || '（没找到）'} · 线宽 ${_wN} · 浓度 ${_aN}`);
      }
      /* **搜索框那个色点要跟着涂色走** ✓（用户报的"最近用的颜色没更新它"✓）
       *   地区 / 省份行：按地块查（`swatchColorOf`）✓
       *   国家行：手里只有名字 → **按名字反查手绘层**（`paintedColorByName`）✓ */
      ok('搜索结果的色点会跟着涂色走（两种行各走各的路 ✓）',
         /function swatchColorOf/.test(appSrc)
         && /function paintedColorByName/.test(appSrc)
         && /rgbToHex\(paintedColorByName\(h\.name\) \|\| h\.color\)/.test(appSrc)
         && /const _col = swatchColorOf\(tid\)/.test(appSrc));

      /* **搜索里取的色要进「最近用过」** ✓（用户报的"加不进记忆"✓
       *   以前那几处传的是 remember=false ✗ —— 从搜索取的色永远进不了调色板 ✓）*/
      ok('搜索里取的色会进「最近用过」（不再传 false ✗）',
         !/setBrush\(h\.color, false, true\)/.test(appSrc)
         && !/setBrush\(_col, false, true\)/.test(appSrc)
         && /setBrush\(h\.color, true, true\)/.test(appSrc)
         && /setBrush\(_col, true, true\)/.test(appSrc));
      {
        const _svRecent = (st.recent || []).slice();
        st.recent = [];
        ex.setBrush([10, 20, 30], true, false);
        ex.setBrush([40, 50, 60], true, false);
        ex.setBrush([10, 20, 30], true, false);      // 再来一次 → 提到最前、不重复 ✓
        ok('「最近用过」去重 + 置顶 ✓',
           st.recent.length === 2 && String(st.recent[0].rgb) === '10,20,30',
           st.recent.map((x) => x.rgb.join(',')).join(' / '));
        /* **「清空」按钮** ✓（用户要求）—— 而且要**连盘上那份一起清** ✗
         *   只清内存的话刷新一下记忆颜色又回来了 ✓（跟当年"涂色删不掉"同一类坑 ✓）*/
        ok('侧栏有个清空记忆颜色的按钮 ✓', /id="btn-clear-recent"/.test(HTML));
        ex.clearRecent();
        ok('点了清空 → 内存里没了 ✓', st.recent.length === 0, String(st.recent.length));
        const _pr = ex.loadMapPrefs(st.meta);
        ok('点了清空 → **盘上那份也清了**（刷新不会又冒出来 ✓）',
           !_pr || !Array.isArray(_pr.recent) || _pr.recent.length === 0,
           _pr && _pr.recent ? JSON.stringify(_pr.recent) : '空 ✓');
        st.recent = _svRecent;
        ex.saveMapPrefs();
      }

      /* **设置 + 最近颜色是存下来的** ✓（用户要求：刷新 / 回主菜单都不丢 ✓；
       *   而且按**游戏类型**存 ✓ —— 同款游戏的图共用一套 ✓
       *   跟"涂色暂存"那份是**两回事**：涂色回主菜单才存、F5 就清，而且按**哪一张图**分 ✓）*/
      {
        const _svW = st.set.w, _svPa = st.set.pa, _svWw = st.set.waterW;
        const _svRecent = (st.recent || []).slice();
        st.set.w = 2.5; st.set.pa = 25; st.set.waterW = 2;
        st.recent = [{ rgb: [7, 8, 9] }];          // 只存颜色 ✓ 不带标记 ✓
        ok('saveMapPrefs() 能写进去 ✓', ex.saveMapPrefs() === true);
        const _back = ex.loadMapPrefs(st.meta);
        ok('取回来的就是刚存下的设置 ✓',
           !!_back && !!_back.set && Number(_back.set.w) === 2.5
           && Number(_back.set.pa) === 25 && Number(_back.set.waterW) === 2,
           _back && _back.set
             ? `w=${_back.set.w} pa=${_back.set.pa} waterW=${_back.set.waterW}` : '没读到 ✗');
        ok('最近颜色也跟着存 ✓',
           !!_back && Array.isArray(_back.recent) && _back.recent.length === 1
           && String(_back.recent[0].rgb) === '7,8,9',
           _back && _back.recent ? JSON.stringify(_back.recent[0]) : '没读到 ✗');
        /* **只存颜色、不存标记** ✓（用户定的：节约一点 ✓）
         *   原来每条是 { rgb, label } ✗ 点它还会顺手把标记名也恢复 ✓
         *   → "最近取色"本来就是个**颜色**记忆 ✗ 不该改你当前的标记 ✓
         *   ⚠ 老存档里多出来的 label 会被忽略 ✓ 不用迁移 ✓ */
        ok('最近取色只存颜色（不存标记 ✓）',
           !!_back && _back.recent && _back.recent.length === 1
           && _back.recent[0].rgb != null && _back.recent[0].label === undefined,
           '字段：' + (_back && _back.recent ? Object.keys(_back.recent[0]).join(',') : '?'));
        // **按游戏类型分**：同款游戏换一张图（换 stashKey）照样读得到这一份 ✓
        const _other = Object.assign({}, st.meta, { stashKey: 'OTHER_MAP_FOR_TEST' });
        const _ob = ex.loadMapPrefs(_other);
        ok('同款游戏换一张图，照样读得到这份设置（按游戏分 ✓ 不按图分 ✓）',
           !!_ob && !!_ob.set && Number(_ob.set.w) === 2.5,
           _ob && _ob.set ? 'w=' + _ob.set.w : '空 ✗');
        // 换成**别的游戏**才是那条边界 ✓
        const _otherGame = Object.assign({}, st.meta,
          { game: (st.meta.game === 'ck3' ? 'eu4' : 'ck3') });
        ok('换成别的游戏就读不到（边界是"类型"✓）',
           !ex.loadMapPrefs(_otherGame), JSON.stringify(ex.loadMapPrefs(_otherGame)));
        st.set.w = _svW; st.set.pa = _svPa; st.set.waterW = _svWw;
        st.recent = _svRecent;
        ex.saveMapPrefs();
      }
      // 滑条的**档位数**得跟 app 里的档位表对得上 ✓（min/max/step 算出来 ✓）
      const _count = (r) => {
        const p = String(r).split(',').map(Number);
        return (p[2] > 0) ? Math.round((p[1] - p[0]) / p[2]) + 1 : 0;
      };
      ok('控件档位数跟档位表一致（宽度 6 / 不透明度 5 ✓）',
         _count(_range('set-w-prov')) === 6 && _count(_range('set-water-w')) === 6
         && _count(_range('set-ca')) === 5 && _count(_range('set-water-a')) === 5,
         `线宽 ${_count(_range('set-w-prov'))} / 水域宽 ${_count(_range('set-water-w'))}`
         + ` / 浓度 ${_count(_range('set-ca'))} / 水域浓 ${_count(_range('set-water-a'))}`);
      ok('老存档的连续值会**吸附**到最近的档位（不是显示成空白 ✓）',
         /function snapStep/.test(appSrc) && /snapStep\(Number\(s\.w/.test(appSrc));
      /* 🔴 **2026-10-16 重写** ✗（handover §3.1 / §3.2 ✓）
       *  原文：「海域 / 荒地」在设置里只有宽浓、且"跟着边界全关一起藏" ——
       *  **两条都不成立了** ✗：
       *   · 荒地那一对**整对退役** ✓（这次只点名水域 ✓）
       *   · 水域这条**语义换了**：只管水域之间的缝 ✓ **独立**于那三个开关 ✓
       *     → "边界全关就藏"恰恰是用户要废掉的行为 ✓（他要的是"不再受地区边界的管理"✓）
       *  所以下面改成量**新口径**：滑条在 ✓ 开关**不跟着别的开关走** ✓ */
      /* 🔴 **2026-10-17 重写** ✗（用户："给荒地加上边界开关…"✓ 并且确认要配一对宽/浓 ✓）
       *   原文盯的是"水域那对在、**荒地那对已退役**"✗ ——
       *     荒地那对 2026-10-15 退役过 ✓ 这一轮**又请回来了** ✓（用的还是原来的 id ✓）
       *   → 改成量：**水 + 荒地各一对，四条都在** ✓ 而且**各认自己的出厂值** ✓ */
      ok('设置页有「水域 / 荒地」各一对边界滑条（宽 + 不透明度 ✓）',
         ['set-water-w', 'set-water-a', 'set-waste-w', 'set-waste-a']
           .every((id) => HTML.includes('id="' + id + '"'))
         && !HTML.includes('set-water-on') && !HTML.includes('set-waste-on')
         && /waterW: 1, waterA: 25/.test(appSrc)
         /* 🔴 **荒地的出厂值 2026-10-17 改成了 100%（实心）** ✗
          *   用户原话："荒地边界默认100%"✓
          *   ⚠ **它跟水域那条不再是一个值** ✗（水域 25% = 很淡的辅助线 ✓）
          *     所以这两条**必须各写各的** ✓ 别图省事合成一条 ✗ */
         && /wasteW: 1, wasteA: 100/.test(appSrc)
         && !/wasteW: 1, wasteA: 25/.test(appSrc)
         /* ⚠ 别写成 !/waterOn|wasteOn/ ✗ —— 注释里引用着色器判据时会出现 wasteOnly，
          *   而它正好以 wasteOn 开头 → **误伤** ✓（踩过一次 ✓）
          *   这里要查的是"有没有这两个**字段**"，所以只认 waterOn: / waterOn= 那种写法 ✓ */
         && !/[^A-Za-z]waterOn\s*[:=]/.test(appSrc)
         && !/[^A-Za-z]wasteOn\s*[:=]/.test(appSrc));
      /* ⚠ **这条 2026-10-16 第二轮就过时了** ✗ —— 界面上早不叫「水域边界宽度」了 ✓
       *   现在那两行的标签是「**边界宽度 / 边界不透明度**」✓（类别交给小标题说 ✓）
       *   → 改成量**新名字 + 旧名一律不许回来** ✓
       *   ⚠ 留着这条有用 ✗：「海域宽度 / 海域浓度」是**绝对禁用**的旧叫法 ✓
       *     用户 2026-10-16 的命名规范里点过名 ✓（`>海域宽度<` 那种写法不许出现 ✓）*/
      /* ⚠ 2026-10-21 起这两行并进 5×2 矩阵 ✗：行名是「水域」✓ 列头是「线宽/不透明度」✓
         → 不再有「边界宽度 / 边界不透明度」这两个**行内**标签 ✓
         这条钉的仍然是"旧的长名字不许回来" ✓ */
      ok('水域那行用矩阵行名（「海域宽度 / 海域浓度」这种旧叫法不许回来 ✗）',
         /class="mx-name"[^>]*>水域</.test(HTML)
         && !HTML.includes('>海域宽度<') && !HTML.includes('>海域浓度<')
         && !HTML.includes('>水域边界宽度<') && !HTML.includes('>水域边界浓度<'));
      /* **设置页就 4 栏** ✓（颜色 / 边界 / 导出图例 / 名字等）——
       *   弹窗 1120px 一行放得下 4×240 + 3×22 ≈ 1026 ✓（用户要求加宽：不然标签会换行 ✓）
       *   拆成 5 栏就换行，后一栏掉进滚动区、**看不见** ✗（海域·荒地 就是这么丢的 ✓）
       *   所以边界里的东西**都装在一栏**里，靠"宽宽宽宽 + 浓浓浓浓"的顺序分 ✓ */
      ok('设置页排成 4 栏（多一栏就会换行、有栏看不见 ✓）',
         (HTML.match(/class="set-col"/g) || []).length === 4,
         (HTML.match(/class="set-col"/g) || []).length + ' 栏');

      /* 🔴🔴 **2026-10-16 收拾过一遍** ✗✗（用户："全都进行全面优化！"✓）
       *   两条断言，钉住"收拾成什么样了"：
       *   ① **栏内要分组** ✓ —— 颜色栏七项 / 边界栏八根，一栏平铺下来分不清谁跟谁一伙 ✓
       *      现在靠 `.set-sub` 小标题分开（颜色：底子/水域/陆地 ✓
       *      边界：省份/地区/势力/水域 ✓ 名字：显示/不透明度 ✓ 其他：导出图例/取色 ✓）
       *   ② **边界栏"一类两行连排"** ✓ —— 原来是"四根宽度挨着、四根浓度挨着"✗
       *      于是"把水域调淡"要跨半栏找 ✓ → 现在省份(宽,浓) 地区(宽,浓) 势力(宽,浓)
       *      水域(宽,浓) ✓ 排法直接量 **id 的出现次序** ✓（比数字符串稳 ✓）*/
      {
        const subs = (HTML.match(/class="set-sub"/g) || []).length;
        /* ⚠ 小标题数量**跟着 UI 走** ✗：2026-10-21 那版把边界 / 名称都改成了
           5×2 / 2×4 矩阵（表头只出现一次 ✓）→ `.set-sub` 从 8 个降到 3~4 个 ✓
           这里钉的是"有分组、组内还有小标题"，不是具体个数 ✓ */
        ok('设置页用 `data-group` 分了四组 + `.set-sub` 组内再分（不再一栏平铺 ✗）',
           subs >= 3 && /\.set-sub\s*\{/.test(css),
           `${subs} 个小标题 · CSS 里有 .set-sub ✓`);
        /* 边界栏那八根的**顺序**：宽/浓 成对交替 ✓ */
        /* ⚠ 锚点换成新的分页 section ✗（旧的 `<h3>边界</h3>` 已经没了 ✓）*/
        const _bi = HTML.indexOf('<section class="set-col" data-group="border"');
        const _bseg = _bi < 0 ? '' : HTML.slice(_bi, HTML.indexOf('</section>', _bi));
        const _ord = (_bseg.match(/id="(set-[a-z-]+)"/g) || [])
          .map((s) => s.slice(4, -1))      // 去掉 `id="` 与结尾那个 `"` ✓（少切一位会被截掉首字母 ✓）
          .filter((id) => !/-row$/.test(id));   // 行容器 id 不算滑条顺序 ✓
        const _want = ['set-w-prov', 'set-pa', 'set-w-region', 'set-ra',
                       'set-pw', 'set-ca', 'set-water-w', 'set-water-a',
                       'set-waste-sub', 'set-waste-w', 'set-waste-a'];
        ok('边界栏按矩阵排（每类一行，两个维度并排 ✓）',
           _ord.join(',') === _want.join(','),
           _ord.join(' → '));
      }

      /* 🔴 **2026-10-17：「剧本 · 名称」那个镜像勾随整组删了** ✓
       *   现在只剩「势力 · 名称」（#show-labels-paint）一个入口 ✓
       *   ⚠ 假 DOM 的 getElementById 找不到会**现造一个** ✗ → 必须扫源码 ✓ */
      {
        const _html = require('fs').readFileSync('web/index.html', 'utf8');
        ok('「剧本 · 名称」镜像勾已删（只剩「势力 · 名称」一个入口 ✓）',
           !/id="show-power-names"/.test(_html) && /id="show-labels-paint"/.test(_html),
           `show-power-names=${/id="show-power-names"/.test(_html)}`
           + ` · show-labels-paint=${/id="show-labels-paint"/.test(_html)}`);
      }

      /* 🔴🔴 **2026-10-16 整块重写** ✗✗（handover §3.1 / §3.2 第 3 条 ✓）
       *
       *  原文量的是："**当前模式里能关的边界全关 → 水域 + 荒地边界也藏了**"✓
       *  那条**正是用户这次要废掉的** ✗✗ ——
       *  他的原话："水域边界开关负责且仅负责水域之间的边界的显示或隐藏。
       *    **同时受管理的这些东西不再受地区边界、地区名称的管理**"✓
       *  → 所以现在是**反过来**的断言：别的边界全关，**水域那条照样在** ✓
       *    （想关就关「水域 · 边界」自己那个勾 ✓）
       *  ⚠ 海岸线**不归它** ✗ —— 水 ↔ 陆那条仍旧跟着"还有边界在画"走 ✓
       *    那条判据在 syncLayerSwitches 里（就是原来那个 _anyBorderOn ✓）
       *    下面把它一起量上：分开测"水域独立"和"海岸线跟大流"两件事 ✓ */
      {
        const svB = {
          pw: st.showPowerBorder, rg: st.showRegionBorder,
          bp: st.showBorderPaint, bt: st.showBorderTitle,
          wb: st.showWaterBorder,
        };
        const hasEraSw = !!get('show-power-border') && N_ERA > 0;
        /* ⚠ **这里要的不是"这张图有没有水"** ✗ —— 是"有没有那张**水域身份表**"
           （`state.waterKindArr` ✓ 新格式的包才有 ✓ 见 app.js 那三级闸的第二条 ✓）
           老包 / 旧夹具上它整条让开（**故意的** ✓ 行为退化成改造前 ✓）——
           那几条断言在这种图上根本测不了，所以下面**明说跳过** ✓
           （以前是硬报红 ✗ 看着像"功能坏了"，其实是夹具没有那张表 ✓）*/
        const canWater = !!(st.waterKindArr && st.waterKindArr.length);
        if (!canWater) {
          console.log('  ·（跳过"水域·边界 独立"那三条：这张图**没有水域身份表** ✓'
            + ' 老包 / 旧夹具都这样 —— 要新格式的图才测得到 ✓）');
        }
        /* ---- ① 别的边界**全关** → 水域那条**照样在** ✓（独立 ✓）---- */
        if (hasEraSw) {
          st.showPowerBorder = false; st.showRegionBorder = false; st.showBorderPaint = false;
        } else {
          /* ⚠ **没有年代层**时，头衔边界那一条的**源头**是「地区 · 边界」✗ ——
             不是 `state.showBorderTitle`（那是**推导出来**的 ✓ 见 syncLayerSwitches ✓）
             写推导值没用：同步时会按源头那两个开关重新算一遍 ✓ */
          st.showRegionBorder = false; st.showBorderTitle = false; st.showBorderPaint = false;
        }
        st.showWaterBorder = true;
        ex.syncLayerSwitches();
        if (canWater) {
          ok('别的边界全关 → 「水域 · 边界」**照样在**（独立于那三个开关 ✓）',
             ex.renderer.waterBorderOn === true,
             `waterBorderOn=${ex.renderer.waterBorderOn}`);
        } else {
          ok('别的边界全关 → 本层那条头衔边界确实灭了（没有水域表时不测水域 ✓）',
             ex.renderer.borderTitle === false && ex.renderer.borderPaint === false,
             `本层线=${ex.renderer.borderTitle} 填色线=${ex.renderer.borderPaint}`);
        }

        /* ---- ② 关掉它自己那个勾 → 才真的没了 ✓ ---- */
        st.showWaterBorder = false;
        ex.syncLayerSwitches();
        if (canWater) {
          ok('关掉「水域 · 边界」自己 → 那条通道这才让开 ✓',
             ex.renderer.waterBorderOn === false, 'waterBorderOn=' + ex.renderer.waterBorderOn);
        }

        /* ---- ③ 别的边界还关着，但水域勾回来 → 还是只有水域在 ✓ ---- */
        st.showWaterBorder = true;
        ex.syncLayerSwitches();
        if (canWater) {
        ok('「水域 · 边界」与地区 / 势力 / 填色**互不影响**（两条线各管各 ✓）',
           ex.renderer.waterBorderOn === true && ex.renderer.borderTitle === false,
           `水=${ex.renderer.waterBorderOn} 本层线=${ex.renderer.borderTitle}`);
        }

        st.showPowerBorder = svB.pw; st.showRegionBorder = svB.rg;
        st.showBorderPaint = svB.bp; st.showBorderTitle = svB.bt;
        st.showWaterBorder = svB.wb;
        ex.syncLayerSwitches();
      }
      /* ⚠ **这张图算不出水陆时它必须整条让开** ✗（老包 / 认不出水的图 ✓）
       *  判据是 `state.waterKindArr` 非空 —— 拿它置空试一下 ✓
       *  （handover §3.4 第 2 步："0 = 这张图算不出水陆 → 整条通道退化成现状"✓）*/
      {
        const _svWK = st.waterKindArr, _svWB = st.showWaterBorder;
        st.showWaterBorder = true;
        st.waterKindArr = null;
        ex.syncLayerSwitches();
        ok('这张图算不出水陆（老包）→ 水域通道整条让开 ✓（行为退化成现状 ✓）',
           ex.renderer.waterBorderOn === false,
           'waterBorderOn=' + ex.renderer.waterBorderOn);
        st.waterKindArr = _svWK; st.showWaterBorder = _svWB;
        ex.syncLayerSwitches();
      }
    }

    /* **取色（吸管）遵循 province 机制** ✓（用户定的）
     *   名字：开剧本 → 涂过用**涂色名**、没涂用**剧本归属**那个国家的名字；
     *         没开剧本 → 用**对应级别**的名字（省名 / 地区名）✓
     *   颜色：**玩家看到什么就吸什么** ✓（显示开关都算进去 ✓）
     */
    if (N_ERA > 0) {
      const svT2 = st.tier, svG2 = st.grain, svShow = st.showTitles;
      let q0 = 0;
      for (let q = 1; q < st.meta.numProvinces && !q0; q++) {
        const t = ex.titleAt(q, ERA0);
        if (t == null || t === st.meta.noTitle || ex.isLocked(t)) continue;
        if (st.provPos[q * 3 + 2] > 0) q0 = q;
      }
      if (q0) {
        const eraName = String(st.titles.names[ex.titleAt(q0, ERA0)] || '');
        // ① 剧本层视图、还没涂 → 吸到的是**剧本归属**那个国家的名字 ✓
        st.tier = ERA0; st.grain = null;
        ex.syncLayerSwitches();
        ex.pickTitle(ex.titleAt(q0, ERA0), false, q0);
        ok(`开剧本 + 没涂过 → 标记名是剧本归属「${eraName}」✓`,
           st.brushLabel === eraName, `吸到「${st.brushLabel}」`);
        // ② 涂过之后 → 吸到的是**涂色标记名** ✓（不是剧本名）
        const svLabel = st.brushLabel;
        st.brushLabel = '我的国';
        ex.paintTitle(ex.titleAt(q0, st.meta.tiers.length - 1), [200, 30, 30], true);
        ex.recomputePainted();
        ex.pickTitle(ex.titleAt(q0, ERA0), false, q0);
        ok('开剧本 + 涂过 → 标记名是**涂色名**（不是剧本名 ✓）',
           st.brushLabel === '我的国', `吸到「${st.brushLabel}」（剧本名是「${eraName}」）`);
        ex.restoreTitle(ex.titleAt(q0, st.meta.tiers.length - 1), true);
        ex.recomputePainted();
        st.brushLabel = svLabel;
        // ③ 细层视图、没涂 → 用**对应级别**的名字（省名 ✓）
        const _lastT = st.meta.tiers.length - 1;
        const fineName = String(st.titles.names[ex.titleAt(q0, _lastT)] || '');
        st.tier = _lastT; st.grain = null;
        ex.syncLayerSwitches();
        ex.pickTitle(ex.titleAt(q0, _lastT), false, q0);
        ok(`没开剧本 + 没涂过 → 标记名是**这一级**的名字「${fineName}」✓`,
           st.brushLabel === fineName, `吸到「${st.brushLabel}」`);
        // ④ 颜色 = 画面上那个（displayedColor ✓），而且**跟着显示开关走**
        st.tier = ERA0;
        ex.syncLayerSwitches();
        const onCol = String(ex.displayedColor(q0, ex.titleAt(q0, ERA0)));
        ex.pickTitle(ex.titleAt(q0, ERA0), false, q0);
        ok('取色 = 画面上那个色（displayedColor ✓）', String(st.brush) === onCol,
           `吸到 ${st.brush} / 画面 ${onCol}`);
        st.showTitles = false;
        const offCol = String(ex.displayedColor(q0, ex.titleAt(q0, ERA0)));
        ex.pickTitle(ex.titleAt(q0, ERA0), false, q0);
        ok('关掉「头衔 · 颜色」→ 吸到的是画面上的底色（看到的才算 ✓）',
           String(st.brush) === offCol, `吸到 ${st.brush} / 画面 ${offCol}`);
        st.showTitles = svShow;
        st.tier = svT2; st.grain = svG2;
        ex.syncLayerSwitches();
      }
    }

    // ① 涂过的地：改名 → 色块名字跟着变
    const anyPid = (() => {
      for (let q = 1; q < st.meta.numProvinces; q++) {
        const t0 = ex.titleAt(q, _fineT);
        if (t0 !== 65535 && !ex.isLocked(t0) && st.provPos[q * 3 + 2] > 0) return q;
      }
      return 0;
    })();
    if (anyPid) {
      st.showTitles = false; st.showPaint = true;
      const svLabel = st.brushLabel;
      st.brushLabel = '改名前';
      ex.paintTitle(ex.titleAt(anyPid, _fineT), [11, 99, 33]);
      ex.rebuildPaintBlocks(false);
      const before = (ex.paintedPoints(true) || []).filter((b) => b.name === '改名前').length;
      const okPaint = ex.renameAt(anyPid, '改名后');
      ex.rebuildPaintBlocks(false);
      const after = (ex.paintedPoints(true) || []).filter((b) => b.name === '改名后').length;
      ok('涂过的地改名 → 色块名字跟着变', okPaint === true && before === 1 && after === 1,
         '前=' + before + ' 后=' + after);

      // ② 没涂的地：改名 → displayedLabel 跟着变
      const clean = (() => {
        for (let q = 1; q < st.meta.numProvinces; q++) {
          const t0 = ex.titleAt(q, _fineT);
          if (t0 === 65535 || ex.isLocked(t0) || st.provPos[q * 3 + 2] <= 0) continue;
          if (ex.renderer.paintData[q * 4 + 3] === 0) return q;
        }
        return 0;
      })();
      if (clean) {
        const tid0 = ex.titleAt(clean, ex.editTier ? ex.editTier() : _fineT);
        const sv = ex.displayedLabel(clean, tid0);
        ex.renameAt(clean, '改过的头衔名');
        // 查**标签层真画出来的那份名单** —— 只查 displayedLabel 会漏掉
        // "改了名但界面上不变"这种毛病（上一版就是这么漏的 ✗）
        // ⚠ 2026-10-16：地名改成"**每个连通域一个标**"之后，
        //   真画的那份从 `labels.pointsFor` 换成了 app.js 的 `placePointsFor` ✓
        //   （口径变了，这把尺子得跟着走 —— 拿旧的那份量就量不到画出来的东西了 ✗）
        const _pt0 = (ex.editTier ? ex.editTier() : _fineT);
        const pts0 = (typeof ex.placePointsFor === 'function')
          ? (ex.placePointsFor(_pt0) || []) : [];
        const drawn = pts0.some((p) => p.name === '改过的头衔名');
        ok('没涂的地改名 → 显示名 + 标签层名单都跟着变',
           ex.displayedLabel(clean, tid0) === '改过的头衔名'
           && st.titles.names[tid0] === '改过的头衔名' && drawn,
           '原=' + sv + ' displayed=' + ex.displayedLabel(clean, tid0)
             + ' titles.names=' + st.titles.names[tid0] + ' 名单里有=' + drawn
             + ` · tid0=${tid0} 层=${_pt0} 名单 ${pts0.length} 枚`
             + ` 其中 tid0 的 ${pts0.filter((p) => p.tid === tid0).length} 枚`
             + ` · 全量 ${(ex.buildPlaceComponents ? ex.buildPlaceComponents(_pt0).length : '—')} 枚`
             + ` · cap=${ex.labelPlaceMaxValue ? ex.labelPlaceMaxValue() : '—'}`);
        // ③ 存读档带着走
        const proj3 = ex.projectData();
        st.titleName = new Map();
        ex.applyProject(proj3);
        ok('改名跟着「导出涂色」走', ex.displayedLabel(clean, tid0) === '改过的头衔名',
           String(ex.displayedLabel(clean, tid0)));
        st.titleName = new Map();
      }
      st.brushLabel = svLabel;
      ex.restoreTitle(ex.titleAt(anyPid, _fineT));
      ex.rebuildPaintBlocks(false);
    }
  }

  // 负例：**开了粒度就不整族**（照旧一次一个）✓
  if ((st.meta.eraDates || []).length) {
    const nEra = st.meta.eraDates.length;
    const svTier = st.tier, svGrain = st.grain, svBP = st.showBorderPaint, svBrush = st.brushLabel;
    const three3 = [];
    for (let tid = 0; tid < st.titles.keys.length && three3.length < 3; tid++) {
      if (st.titles.tiers[tid] !== ERA0) continue;
      if ((st.meta.wasteland || []).indexOf(tid) >= 0) continue;
      if (!st.titles.provCount || !st.titles.provCount[tid]) continue;
      three3.push(tid);
    }
    if (three3.length === 3) {
      st.tier = ERA0; st.grain = null; st.showBorderPaint = true; st.brushLabel = '负例';
      for (const tid of three3) ex.paintTitle(tid, [77, 88, 99]);
      // 找一个属于 three3[0] 的地块
      let q3 = 0;
      const tm3 = st.titlemap, nP3 = st.meta.numProvinces;
      for (let q = 1; q < nP3 && !q3; q++) {
        if (tm3[ERA0 * nP3 + q] === three3[0] && st.provPos[q * 3 + 2] > 0) q3 = q;
      }
      if (q3) {
        st.grain = st.meta.tiers.length - 1;      // **开粒度** ✓
        st.tier = st.meta.tiers.length - 1;
        ok('开了粒度 → 悬停不做整族高亮（一次一个）', ex.hoverGroupRgb(q3) === null,
           String(ex.hoverGroupRgb(q3)));
        st.brush = [10, 10, 10];
        ex.paintAt(q3, ex.titleAt(q3, st.meta.tiers.length - 1));
        // 只有点中的那一个（细层头衔）会变，另两个剧本层国家不动 ✓
        // "某个头衔还涂着 77,88,99 吗" → 落到**它名下那一格自己**身上问 ✓（不再查头衔级的账 ✗）
        const stillLit = (tid) => {
          const nn = st.meta.numProvinces, tmm = st.titlemap, pdd = ex.renderer.paintData;
          const nTT = st.meta.tiers.length;
          for (let q = 1; q < nn; q++) {
            if (pdd[q * 4 + 3] === 0) continue;
            let hit = false;
            for (let ti = 0; ti < nTT; ti++) if (tmm[ti * nn + q] === tid) { hit = true; break; }
            if (!hit) continue;
            if (pdd[q * 4] === 77 && pdd[q * 4 + 1] === 88 && pdd[q * 4 + 2] === 99) return true;
          }
          return false;
        };
        // 点中的那个国家可能只有那一格被涂过（覆盖掉就没了）——
        // 这条验的是"**另两个**国家没被连坐" ✓
        const keptThree = three3.slice(1).filter(stillLit).length;
        ok('开了粒度 → 涂色只动点中的那一块（另两个剧本层国家不变）',
           keptThree === 2, '保持原色的 ' + keptThree + ' / 2（另两个国家）');
      }
      for (const tid of three3) ex.restoreTitle(tid);
    }
    st.tier = svTier; st.grain = svGrain; st.showBorderPaint = svBP; st.brushLabel = svBrush;
    ex.syncLayerSwitches();
  }

  // 高亮也是**同一套口径**（判据 hoverGroupRgb）：
  //   涂过的地 → 返回那一族的涂色；没涂过的地 → 返回它的**稳定色**
  //   （着色器按"颜色 + 标记"亮，标记来自头衔名 → 等价于"同色同标记" ✓）
  //   细层 / 开了粒度 → 返回 null，退回按编辑层头衔亮（那一块）✓
  //   **不看那两个边界开关**（开关只决定涂色先看全图玩家族还是那一国里同色同标记的 ✓）
  if ((st.meta.eraDates || []).length) {
    const nEra = st.meta.eraDates.length;
    const svTier = st.tier, svGrain = st.grain, svBP = st.showBorderPaint;
    const svPB = st.showPowerBorder, svBrush = st.brushLabel;
    st.tier = ERA0; st.grain = null; st.showBorderPaint = true; st.showPowerBorder = false;
    let hitPid = 0;
    const _nReal = st.meta.numRealTitles != null ? st.meta.numRealTitles : 1e9;
    for (let q = 1; q < st.meta.numProvinces && !hitPid; q++) {
      const t0 = ex.titleAt(q, ERA0);
      if (t0 === 65535 || t0 >= _nReal || ex.isLocked(t0)) continue;      // 别选水域/锁定的 ✗
      if ((st.meta.wasteland || []).indexOf(t0) >= 0) continue;
      if (st.provPos[q * 3 + 2] > 0 && ex.renderer.paintData[q * 4 + 3] === 0) hitPid = q;
    }
    if (hitPid) {
      // ① 还没涂过 → 返回**稳定色**（原版色）：着色器配"标记"亮 = 同色同名那一族 ✓
      const g0 = ex.hoverGroupRgb(hitPid);
      ok('没涂过的地 → 返回稳定色（按"同色同标记"整族亮 ✓）',
         Array.isArray(g0) && g0.length === 3, JSON.stringify(g0));
      st.brushLabel = '高亮测';
      ex.paintTitle(ex.titleAt(hitPid, ERA0), [90, 40, 200]);
      const got = ex.hoverGroupRgb(hitPid);
      ok('涂过了 → 悬停拿到那一族的涂色',
         !!got && got[0] === 90 && got[1] === 40 && got[2] === 200, JSON.stringify(got));
      // ② 只开「势力 · 边界」→ 照样整族亮（跟涂色那条一致：归属永远是"同色同标记" ✓）
      st.showBorderPaint = false; st.showPowerBorder = true;
      const g2 = ex.hoverGroupRgb(hitPid);
      ok('只开「势力 · 边界」→ 照样整族亮（跟涂色同一套 ✓）',
         !!g2 && g2[0] === 90, JSON.stringify(g2));
      st.showBorderPaint = true; st.showPowerBorder = false;
      ex.restoreTitle(ex.titleAt(hitPid, ERA0));
    }
    st.tier = svTier; st.grain = svGrain; st.showBorderPaint = svBP;
    st.showPowerBorder = svPB; st.brushLabel = svBrush;
    ex.syncLayerSwitches();
  }

  // 「只有剧本粒度 + 填色·边界」时涂色以玩家为准：同色同标签的整族一起涂 ✓
  if ((st.meta.eraDates || []).length && st.meta.eraDates.length < st.meta.tiers.length) {
    const nEra = st.meta.eraDates.length;
    const svTier = st.tier, svGrain = st.grain, svLabel = st.brushLabel;
    const svBorderPaint = st.showBorderPaint;
    st.tier = ERA0; st.grain = null;          // 只有剧本粒度 ✓
    st.showBorderPaint = true;             // 「填色·边界」开着 ✓
    // 找三个剧本层的国家
    const three = [];
    for (let tid = 0; tid < st.titles.keys.length && three.length < 3; tid++) {
      if (st.titles.tiers[tid] !== ERA0) continue;
      if ((st.meta.wasteland || []).indexOf(tid) >= 0) continue;
      if (!st.titles.provCount || !st.titles.provCount[tid]) continue;
      three.push(tid);
    }
    if (three.length === 3) {
      st.brushLabel = '玩家国';
      for (const tid of three) ex.paintTitle(tid, [220, 30, 140]);      // 一次用新颜色涂三块 ✓
      // "那一族"的颜色和名字 → 从**它名下的一格**问（`provInfoAt` 解析出来的 ✓）
      const _gp = (() => {
        const nn = st.meta.numProvinces, tmm = st.titlemap, pdd = ex.renderer.paintData;
        const nTT = st.meta.tiers.length;
        for (let q = 1; q < nn; q++) {
          if (pdd[q * 4 + 3] === 0) continue;
          for (let ti = 0; ti < nTT; ti++) if (tmm[ti * nn + q] === three[0]) return q;
        }
        return 0;
      })();
      const _gi = _gp ? ex.provInfoAt(_gp) : null;
      const grp = ex.playerGroupTids(three[0],
        (_gi && _gi.fill ? _gi.fill.rgb : null),
        (_gi && _gi.fill ? _gi.fill.name : ''));
      ok('同色同标签的三个国家能认成一族', grp.length >= 3, '族里 ' + grp.length + ' 个');
      // 再点其中一个、换个颜色涂 → 三个一起变 ✓
      st.brushLabel = '玩家国';
      const first = st.titles.keys[0];
      // 用真实的点击流程走一遍：找到属于 three[0] 的某个地块
      let clickPid = 0;
      const tm = st.titlemap, nP = st.meta.numProvinces;
      for (let q = 1; q < nP && !clickPid; q++) {
        if (tm[ERA0 * nP + q] === three[0] && st.provPos[q * 3 + 2] > 0) clickPid = q;
      }
      if (clickPid) {
        st.brush = [30, 60, 200];
        ex.paintAt(clickPid, ex.titleAt(clickPid, ERA0));
        // 规则是"涂同色同标签的所有**色块**"→ 按**地块**数，而不是按国家账本数 ✓
        const paintedPids = new Set();
        for (let q = 1; q < nP; q++) {
          if (three.indexOf(tm[ERA0 * nP + q]) >= 0 && ex.renderer.paintData[q * 4 + 3] > 0
              && ex.renderer.paintData[q * 4] === 30) paintedPids.add(q);
        }
        const perCountry = three.map((tid) => {
          let n = 0;
          for (let q = 1; q < nP; q++) if (tm[ERA0 * nP + q] === tid && paintedPids.has(q)) n++;
          return n;
        });
        ok('点其中一块涂新色 → 同色同标签的色块（三个国家的地块）一起变',
           perCountry.every((n) => n > 0),
           '各国变了的色块数 ' + perCountry.join('/'));
      }
      for (const tid of three) ex.restoreTitle(tid);
    }
    st.tier = svTier; st.grain = svGrain; st.brushLabel = svLabel;
    st.showBorderPaint = svBorderPaint;
    ex.syncLayerSwitches();
  }

  // 剧本视图（**没开粒度**）下的**填色口径**（用户定的 ✓）——
  // 判据是 `provInfoAt` **解析出来的归属**（名字 + 颜色 ✓），不是头衔序号：
  //   · 「势力 · 边界」开着（填色没开）→ 按**剧本归属**整块（整个国家 ✓ 含别色的占领区）
  //   · 否则（填色开着 / **两个都没开**）→ **涂过的看填色归属、没涂过的看剧本归属** ✓
  //   · 都没有 → 只动最低单位那一块
  // 三个具体例子见下面 3c-3 那段（巴黎涂成德国色那种 ✓）
  if ((st.meta.eraDates || []).length && st.meta.eraDates.length < st.meta.tiers.length) {
    const svT0 = st.tier, svG0 = st.grain, svBP0 = st.showBorderPaint;
    const svPB0 = st.showPowerBorder, svB0 = st.brushLabel;
    st.tier = ERA0; st.grain = null;
    const n0 = st.meta.numProvinces, tm0 = st.titlemap;
    const fine0 = st.meta.tiers.length - 1;
    const _nReal0 = st.meta.numRealTitles != null ? st.meta.numRealTitles : 1e9;
    // 挑一个地最多的剧本层国家当"法国"
    const cnt0 = new Map();
    for (let q = 1; q < n0; q++) {
      const t0 = tm0[ERA0 * n0 + q];     // 有主的那个剧本层 ✓
      if (t0 == null || t0 === 65535 || t0 >= _nReal0) continue;
      if (ex.isLocked(t0)) continue;
      if (st.provPos[q * 3 + 2] <= 0) continue;
      cnt0.set(t0, (cnt0.get(t0) || 0) + 1);
    }
    let host0 = -1, best0 = 0;
    for (const [t0, c] of cnt0) if (c > best0) { best0 = c; host0 = t0; }
    ok('找得到一个地够多的剧本层国家（复现用）', host0 >= 0 && best0 >= 8,
       host0 >= 0 ? `#${host0} ${st.titles.names[host0]} 有 ${best0} 块地` : '没找到');
    if (host0 >= 0 && best0 >= 8) {
      const land0 = [];
      for (let q = 1; q < n0; q++) {
        if (tm0[ERA0 * n0 + q] === host0 && st.provPos[q * 3 + 2] > 0) land0.push(q);
      }
      // ① 开粒度，用"占领色"占掉一块（一块一块点，跟真人一样）
      st.grain = fine0;
      st.brush = [64, 64, 72]; st.brushLabel = '占领国';
      for (const q of land0.slice(0, Math.min(Math.floor(land0.length / 2), 30))) {
        ex.paintAt(q, ex.titleAt(q, fine0));
      }
      const occ0 = land0.filter((q) => ex.renderer.paintData[q * 4 + 3] > 0);
      ok('先占掉一块（复现的前置）', occ0.length >= 1 && occ0.length < land0.length,
         `占 ${occ0.length} / ${land0.length} 块`);
      // ② 回到剧本视图（**不开粒度**），用这个国家自己的颜色点它剩下的那半
      st.grain = null;
      const keptColor = (q) => {
        const p4 = q * 4;
        const pd = ex.renderer.paintData;
        return pd[p4 + 3] > 0 && pd[p4] === 64 && pd[p4 + 1] === 64 && pd[p4 + 2] === 72;
      };
      const free0 = land0.filter((q) => ex.renderer.paintData[q * 4 + 3] === 0);
      const pd0 = ex.renderer.paintData;
      const lit0 = (q) => pd0[q * 4 + 3] > 0;
      const countRGB = (rgb) => land0.filter((q) => lit0(q)
        && pd0[q * 4] === rgb[0] && pd0[q * 4 + 1] === rgb[1] && pd0[q * 4 + 2] === rgb[2]).length;
      const clearAll0 = () => {
        for (let q = 1; q < n0; q++) {
          for (let ti = 0; ti < st.meta.tiers.length; ti++) {
            const t1 = ex.titleAt(q, ti);
            if (t1 != null && t1 !== 65535 && st.painted.has(t1)) ex.restoreTitle(t1, true);
          }
        }
        ex.recomputePainted();
      };
      // 重新造一次"占领"（细层一块一块点出来，跟真人一样 ✓），再回剧本视图
      const makeOcc0 = () => {
        clearAll0();
        st.grain = fine0; ex.syncLayerSwitches();
        st.brush = [64, 64, 72]; st.brushLabel = '占领国';
        for (const q of land0.slice(0, Math.min(Math.floor(land0.length / 2), 30))) {
          ex.paintAt(q, ex.titleAt(q, fine0));
        }
        st.grain = null; ex.syncLayerSwitches();
      };
      const MY0 = [200, 30, 90];

      // ①② 填色·边界开着，点一块**没涂过**的地 → 只动那一国里**同色同标记**的那些 ✓
      //（"归属" = 标记 + 颜色；占领区被涂成别的颜色，颜色对不上 → 一块都不许碰 ✓）
      if (occ0.length && free0.length) {
        st.showBorderPaint = true; st.showPowerBorder = false;
        ex.syncLayerSwitches();
        st.brush = MY0.slice(); st.brushLabel = '玩家国';
        ex.paintAt(free0[0], ex.titleAt(free0[0], ERA0));
        ok('点没涂过的地 → 只动这一国里**没涂过**的地（占领区的名字对不上 ✗ 不碰 ✓）',
           countRGB(MY0) === free0.length && countRGB([64, 64, 72]) === occ0.length,
           `玩家色 ${countRGB(MY0)} / ${free0.length} 块，占领区保住 ${countRGB([64, 64, 72])} / ${occ0.length}`);
        // ③ 撤销 → 回到只有占领区那一步
        ex.undo();
        ok('撤销 → 回到只有占领区那一步 ✓',
           countRGB(MY0) === 0 && countRGB([64, 64, 72]) === occ0.length,
           `玩家色 ${countRGB(MY0)} 块 / 占领 ${countRGB([64, 64, 72])} 块`);
      }
      // ④ **2026-10-17：「剧本 · 边界」那个勾删了** ✓
      //    那条"按剧本归属整块（含被占的那半）"的路不再有入口 ✓
      //    下面只验剩下的「势力 · 边界」行为 ✓
      // ⑤ 「势力 · 边界」关着 → 按填色那条算（跟 ② 一样 ✓）
      if (occ0.length && free0.length) {
        clearAll0(); makeOcc0();
        st.showBorderPaint = false; st.showPowerBorder = false;
        ex.syncLayerSwitches();
        st.brush = MY0.slice(); st.brushLabel = '玩家国';
        ex.paintAt(free0[0], ex.titleAt(free0[0], ERA0));
        ok('两个边界都没开 → 按填色开着算（跟 ② 一样 ✓）',
           countRGB(MY0) === free0.length && countRGB([64, 64, 72]) === occ0.length,
           `玩家色 ${countRGB(MY0)} / ${free0.length} 块`);
      }
      // ⑥ 点一块**涂过的**地 → 只动"玩家涂色归属"（同色同标记那一族 ✓）
      {
        clearAll0();
        st.showBorderPaint = true; st.showPowerBorder = false;
        const few0 = land0.slice(0, 3);
        st.grain = fine0; ex.syncLayerSwitches();       // 先在最细层一块一块地涂出那一族
        st.brush = MY0.slice(); st.brushLabel = '玩家国';
        for (const q of few0) ex.paintAt(q, ex.titleAt(q, fine0));
        st.grain = null; ex.syncLayerSwitches();
        const before6 = countRGB(MY0);
        ex.paintAt(few0[0], ex.titleAt(few0[0], ERA0));
        ok('点一块**涂过的**地 → 只动它那一族，不碰这个国家的其他地 ✓',
           before6 === few0.length && countRGB(MY0) === few0.length,
           `涂前 ${before6} → 涂后 ${countRGB(MY0)} 块（这一国共 ${land0.length} 块）`);
      }
      // ⑦「还原」共用同一套范围：点那一族里的一块 → 只清那一族
      {
        const W0 = st.meta.mapWidth, H0 = st.meta.mapHeight;
        const pixOf = new Map();
        for (let y = 0; y < H0; y += 2) {
          for (let x = 0; x < W0; x += 2) {
            const q = st.provinceIds[y * W0 + x];
            if (q && !pixOf.has(q)) pixOf.set(q, [x, y]);
          }
        }
        const stg0 = get('stage');
        const vw0 = stg0.clientWidth / st.cam.scale, vh0 = stg0.clientHeight / st.cam.scale;
        const vx0 = st.cam.cx - vw0 / 2, vy0 = st.cam.cy - vh0 / 2;
        const toClient0 = (mx, my) => [(mx + 0.5 - vx0) / vw0 * stg0.clientWidth,
                                       (my + 0.5 - vy0) / vh0 * stg0.clientHeight];
        const three0 = land0.filter((q) => lit0(q) && pd0[q * 4] === MY0[0]);
        const px0 = three0.length ? pixOf.get(three0[0]) : null;
        if (px0) {
          ex.setTool('erase');
          ex.actAt(...toClient0(px0[0], px0[1]));
          ok('「还原」跟涂色同一套范围：点那一族里的一块 → 只清那一族 ✓',
             countRGB(MY0) === 0 && countRGB([64, 64, 72]) === 0,
             `还剩 ${countRGB(MY0)} 块玩家色`);
        }
        ex.setTool('paint');
      }
      clearAll0();
    }
    st.tier = svT0; st.grain = svG0; st.showBorderPaint = svBP0;
    st.showPowerBorder = svPB0; st.brushLabel = svB0;
    ex.syncLayerSwitches();
  }

  // ==== 3c-2. 「还原」只清被点到的那一个**最底层单位**（用户报的）====
  // 在**地区**层涂一整块 → 切到**省份**层点一下还原 → 以前整块地区跟着被清空 ✗
  //（那一支把这块地在**所有层级**上的头衔全捞出来清，地区头衔也在名单里 → 连坐）
  {
    // ⚠ 层数要用 `meta.tiers.length`（各层的 key），**不是** `tierNames.length` ✗
    // —— 这两个在 HOI4 上不一样长，按名字的层数挑会挑到不可涂的那一层
    //（paintTitle 里 `tier >= TIER_COUNT` 直接拒绝 → 一个省都涂不上）
    const nT2 = st.meta.tiers.length;
    const LAST2 = nT2 - 1, MID2 = LAST2 - 1;
    const NP2 = st.meta.numProvinces;
    const byMid = new Map();
    for (let p = 1; p < NP2; p++) {
      const t = ex.titleAt(p, MID2);
      if (t == null || t === st.meta.noTitle) continue;
      if (!byMid.has(t)) byMid.set(t, []);
      byMid.get(t).push(p);
    }
    let mid2 = -1, pids2 = null;
    for (const [t, list] of byMid) {
      // **只挑真头衔** —— 海 / 湖 / 荒地是各层共享的**伪头衔**（tiers[tid] 落在
      // TIER_COUNT 之外），涂色那条路会直接拒绝；挑到它就变成"一个省都涂不上" ✗
      //（HOI4 上就是这么翻的车：第一眼撞上的是某片海的伪头衔，126 个省全是海）
      const tt = st.titles.tiers[t];
      if (tt == null || tt >= st.meta.tiers.length) continue;
      if (list.length < 3) continue;
      mid2 = t; pids2 = list; break;
    }
    // 打印用的层名（名字表跟 key 表不一定一样长，取不到就写"第 n 层" ✓）
    const nmOf2 = (i) => String((st.meta.tierNames && st.meta.tierNames[i]) || ('第 ' + (i + 1) + ' 层'));
    if (mid2 < 0) {
      console.log(`  （这一局没有"管着 ≥3 个${nmOf2(LAST2)}的${nmOf2(MID2)}" —— 跳过）`);
    } else {
      const svT2 = st.tier, svG2 = st.grain, svB2 = st.brushLabel;
      st.grain = null;
      st.tier = MID2;
      ex.syncLayerSwitches();
      st.brushLabel = '还原口径';
      ex.setBrush([210, 60, 60], false);
      ex.paintTitle(mid2, [210, 60, 60]);
      const lit2 = (q) => ex.renderer.paintData[q * 4 + 3] > 0;
      const litN = () => pids2.filter(lit2).length;
      ok(`在「${nmOf2(MID2)}」层涂一整块 ✓`, litN() === pids2.length,
         `${litN()} / ${pids2.length} 个${nmOf2(LAST2)}涂上了`);

      // 点哪里：拿属于第一个最底层单位的一个像素，转成屏幕坐标
      const W2 = st.meta.mapWidth, H2 = st.meta.mapHeight;
      const pixOf2 = (want) => {
        for (let y = 0; y < H2; y += 2) {
          for (let x = 0; x < W2; x += 2) if (st.provinceIds[y * W2 + x] === want) return [x, y];
        }
        return null;
      };
      const toClient2 = (mx, my) => {
        const stg2 = get('stage');
        const vw2 = stg2.clientWidth / st.cam.scale, vh2 = stg2.clientHeight / st.cam.scale;
        const vx2 = st.cam.cx - vw2 / 2, vy2 = st.cam.cy - vh2 / 2;
        return [(mx + 0.5 - vx2) / vw2 * stg2.clientWidth,
                (my + 0.5 - vy2) / vh2 * stg2.clientHeight];
      };
      const one2 = pixOf2(pids2[0]);

      // ① 切到最细层点还原 → **只掉被点的那一个** ✓
      st.tier = LAST2;
      ex.syncLayerSwitches();
      ex.setTool('erase');
      if (one2) ex.actAt(...toClient2(one2[0], one2[1]));
      ok(`在「${nmOf2(LAST2)}」层点「还原」→ 只清掉被点的那一个 ✓`,
         litN() === pids2.length - 1, `还剩 ${litN()} / ${pids2.length}`);

      // ② 撤销 → 那一个回来（而且**只**回来一个 ✓）
      ex.undo();
      ok('撤销 → 那一个回来了，也没多清/多还 ✗', litN() === pids2.length,
         `${litN()} / ${pids2.length}`);

      // ③ 切回中间层再点还原 → 这一块**包含的**一起清（这一层该有的口径 ✓）
      st.tier = MID2;
      ex.syncLayerSwitches();
      ex.setTool('erase');
      if (one2) ex.actAt(...toClient2(one2[0], one2[1]));
      ok(`在「${nmOf2(MID2)}」层点「还原」→ 这一块包含的一起清掉 ✓`,
         litN() === 0, `还剩 ${litN()} / ${pids2.length}`);

      // 收尾：这一块涂过的全还原
      ex.setTool('paint');
      for (const q of pids2) {
        for (let ti = 0; ti < nT2; ti++) {
          const t1 = ex.titleAt(q, ti);
          if (t1 != null && t1 !== 65535 && st.painted.has(t1)) ex.restoreTitle(t1);
        }
      }
      st.tier = svT2; st.grain = svG2; st.brushLabel = svB2;
      ex.syncLayerSwitches();
    }
  }

  // ==== 空白剧本：一层**全无主**（不上色、没标记），别的规矩一条不少 ====
  //   CK3 从 2026-10-11 起也照搬了这一层（1066 是剧本 ✓ 空白剧本也是剧本 ✓
  //   见 build_data 末尾那句 patch_blank_era ✓）—— 所以这里**不再分模式** ✓
  ok('每一套都有空白剧本这一层（剧本块的最后一格 ✓）',
     BLANK_T >= 0 && BLANK_T < N_ERA,
     `第 ${BLANK_T} 层 / 共 ${N_ERA} 个剧本层 · 名字「${(st.meta.tierNames || [])[BLANK_T]}」`);
  if (BLANK_T >= 0) {
    // 空白层 = **最细那层**，只是"真头衔一律换成无主"；
    // 海 / 湖 / 荒地那些**背景地形**（含 EU5 那种序号在真头衔里的小岛 ✓）逐格照抄 ✓
    let bOwned = 0, bNoneLand = 0, bBg = 0;
    for (let p = 1; p < st.meta.numProvinces; p++) {
      const t = ex.titleAt(p, BLANK_T);
      const isLand = st.provPos[p * 3 + 2] > 0;
      if (t == null || t === st.meta.noTitle) { if (isLand) bNoneLand++; continue; }
      if (isBgTid(t)) bBg++;
      else bOwned++;                      // 既不是背景、又不是无主 → 空白层不该有 ✗
    }
    ok('空白剧本：除了海/湖/荒地，别的格子全是无主（不上色、没标记 ✓）',
       bOwned === 0 && bNoneLand > 500,
       `还有归属的格子 ${bOwned} 个 · 无主陆地 ${bNoneLand} 块 · 背景地形 ${bBg} 格`);
    {
      const fineT = st.meta.tierNames.length - 1;
      let offB = 0, nBgB = 0, notCleared = 0, colourOff = 0;
      for (let p = 1; p < st.meta.numProvinces; p++) {
        const tb = ex.titleAt(p, BLANK_T);
        const tf = ex.titleAt(p, fineT);
        if (isBgTid(tb)) {
          nBgB++;
          /* 🔴 **2026-10-19：判据从"节点号相同"改成"显示颜色相同"** ✗✗
           *   空白层抄的是**左边那个剧本层**（`#sea_all_1792` 那种"整类一片"✓
           *   见 patch_blank_era 里那段说明 ✓）—— 而最细层是逐块的水域节点
           *   （`#sea_pr_2264` ✓）→ **节点号本来就不同** ✗ 老断言必红 ✓
           *   用户真正在意的是"**画出来不像大陆灰**"✓ 所以比**颜色** ✓ */
          const cb = String(ex.displayedColor(p, tb));
          const cf = String(ex.displayedColor(p, tf));
          if (cb !== cf) { offB++; if (offB <= 3) console.log(`     省${p}: 空白层 ${cb} vs 最细层 ${cf}`); }
        }
        else if (tb != null && tb !== st.meta.noTitle) notCleared++;   // 别的真头衔没清掉 ✗
      }
      ok('空白剧本：海 / 湖 / 荒地那些背景地形跟最细那层**颜色一致**（不然整片海会变成大陆灰 ✗）',
         offB === 0 && notCleared === 0 && nBgB > 0,
         `背景地形 ${nBgB} 格 · 颜色对不上的 ${offB} 格 · 没清干净的真头衔 ${notCleared} 个`);
    }

    const svB = { tier: st.tier, grain: st.grain, tool: st.tool, label: st.brushLabel,
                  brush: st.brush.slice(), lp: st.showLabelsPaint,
                  all: st._blocksAll, bt: st._blocksTier };
    // 按按钮切过去：跟别的剧本一个规矩（细层按年份 = 配成"那年配色 + 细层粒度" ✓）
    {
      const _svT = st.tier;
      ex.setGrain(null);
      ex.setTier(tierOf('省份') >= 0 ? tierOf('省份') : st.meta.tierNames.length - 1);
      ex.pressTier(BLANK_T);
      ok('从细层按「空白剧本」= 切到那一层（跟别的剧本一个规矩 ✓）',
         st.tier === BLANK_T, `tier=${st.tier} grain=${st.grain}`);
      ex.setGrain(null);
      st.tier = _svT;
    }
    // ① 进去看一眼：一个势力名都不该有（没标记 ✓）
    st.tier = BLANK_T; st.grain = null; st.showLabelsPaint = true;
    st._blocksAll = null; st._blocksTier = null; st._layerSig = null;
    ex.syncLayerSwitches();
    ex.rebuildPaintBlocks(true, false);
    ok('空白剧本：一个势力名都没有 ✓',
       (st.paintBlocks || []).length === 0,
       `${(st.paintBlocks || []).length} 个色块`);
    // ② 找到一块**无主**的陆地，走完整的点击流程落笔
    const fineB = st.meta.tierNames.length - 1;
    let pidB = 0;
    for (let p = 1; p < st.meta.numProvinces && !pidB; p++) {
      if (!(st.provPos[p * 3 + 2] > 0)) continue;
      const tb = ex.titleAt(p, BLANK_T);
      if (tb != null && tb !== st.meta.noTitle) continue;      // 只要无主的 ✓
      const tf = ex.titleAt(p, fineB);
      if (tf == null || tf === st.meta.noTitle || ex.isLocked(tf)) continue;
      pidB = p;
    }
    ok('空白剧本里找得到一块无主陆地（下面要用）', pidB > 0, `#${pidB}`);
    if (pidB) {
      const WB = st.meta.mapWidth, HB = st.meta.mapHeight;
      let pxB = null;
      for (let y = 0; y < HB && !pxB; y += 2) {
        for (let x = 0; x < WB; x += 2) {
          if (st.provinceIds[y * WB + x] === pidB) { pxB = [x, y]; break; }
        }
      }
      const stgB = get('stage');
      const vwB = stgB.clientWidth / st.cam.scale, vhB = stgB.clientHeight / st.cam.scale;
      const vxB = st.cam.cx - vwB / 2, vyB = st.cam.cy - vhB / 2;
      const toClientB = (mx, my) => [(mx + 0.5 - vxB) / vwB * stgB.clientWidth,
                                     (my + 0.5 - vyB) / vhB * stgB.clientHeight];
      if (pxB) {
        ex.setTool('paint');
        st.brush = [30, 150, 90]; st.brushLabel = '我的国';
        ex.actAt(...toClientB(pxB[0], pxB[1]));
        const p4B = pidB * 4;
        ok('空白剧本里点一下就能落笔（无主地照样涂得上 ✓）',
           ex.renderer.paintData[p4B + 3] > 0 && ex.renderer.paintData[p4B] === 30
           && ex.renderer.paintData[p4B + 1] === 150,
           [...ex.renderer.paintData.slice(p4B, p4B + 4)].join(','));
        // ③ 涂完就有色块名（分组那套照旧认无主地上涂出来的色块 ✓）
        st._blocksAll = null; st._blocksTier = null;
        ex.rebuildPaintBlocks(true, false);
        const blkB = (st.paintBlocks || []).find((b) => b.name === '我的国');
        ok('空白剧本里涂出来的色块有名字 ✓', !!blkB,
           blkB ? `落点(${blkB.x.toFixed(0)},${blkB.y.toFixed(0)})` : '没找到这块');
        // ④ 还原工具也能擦掉（别修成"涂得上擦不掉" ✗）
        ex.setTool('erase');
        ex.actAt(...toClientB(pxB[0], pxB[1]));
        ok('空白剧本里点「还原」也能擦掉 ✓', ex.renderer.paintData[p4B + 3] === 0,
           [...ex.renderer.paintData.slice(p4B, p4B + 4)].join(','));
      }
      // 收尾：万一还有残留，按最细那层清掉
      const tfB = ex.titleAt(pidB, fineB);
      if (tfB != null && tfB !== st.meta.noTitle) ex.restoreTitle(tfB);
    }
    st.tier = svB.tier; st.grain = svB.grain; st.brushLabel = svB.label;
    st.brush = svB.brush; st.showLabelsPaint = svB.lp;
    st._blocksAll = svB.all; st._blocksTier = svB.bt; st._layerSig = null;
    ex.setTool(svB.tool);
    ex.syncLayerSwitches();
    }

  // 换层时"跟层级绑的那几个开关"必须**当场**同步 ✓
  //   以前 syncLayerSwitches() 排在 renderer.render() 之后 ✗ → 换层后第一帧是
  //   "新层的归属表 + 旧层的颜色开关" → 屏幕上闪一帧**另一层原版的五颜六色** ✗
  if (N_ERA > 0) {
    const svT = st.tier, svG = st.grain;
    const svPC = st.showPowerColor, svRC = st.showRegionColor;
    const fineT = tierOf('省份') >= 0 ? tierOf('省份') : st.meta.tierNames.length - 1;
    st.showPowerColor = true; st.showRegionColor = false;
    ex.setTier(ERA0);
    ok('切到剧本层：颜色开关**当场**解析成「势力·颜色」✓',
       ex.renderer.showTitles === true && st.showTitles === true,
       `renderer.showTitles=${ex.renderer.showTitles} state=${st.showTitles}`);
    ex.setTier(fineT);
    ok('切回细层：当场解析成「地区·颜色」（默认关 → 不露原版五颜六色 ✓）',
       ex.renderer.showTitles === false && st.showTitles === false,
       `renderer.showTitles=${ex.renderer.showTitles} state=${st.showTitles}`);
    st.showPowerColor = svPC; st.showRegionColor = svRC;
    ex.setGrain(svG); ex.setTier(svT);
  }


  // 机器串不当名字显示（CK3 的不可通行海域就是 NORWEGIAN IMPASSABLE 1 这种）✓
  if (typeof ex.readablePlaceName === 'function') {
    const bad2 = ['NORWEGIAN IMPASSABLE 1', 'river_hooghly', '', null, 'BLACK SEA 12',
                  'LAKES eastern Mongolia', 'IMPASSABLE eastern Mongolia desert 1'];
    const good2 = ['里加湾', '波罗的海', 'Gulf of Bothnia', 'Lake Vänern'];
    const okBad = bad2.every((x) => ex.readablePlaceName(x) === false);
    const okGood = good2.every((x) => ex.readablePlaceName(x) === true);
    ok('机器串（不可通行海域那类）不当地名显示，真地名照旧',
       okBad && okGood,
       '机器串判对=' + okBad + ' 真地名判对=' + okGood);
  }

  // 手工翻译表：本地化里没有的水块名，界面显示中文 ✓
  if (typeof ex.manualWaterName === 'function') {
    const cases = [['ATLANTIC EUROPE-AFRICA', '大西洋欧洲-非洲'],
                   ['BAIKAL', '贝加尔湖'], ['Sea of Okhotsk', '鄂霍次克海'],
                   ['RUSSIAN LAKES 2', '俄罗斯湖泊群 2'],
                   ['Gulf of Bothnia', '波的尼亚湾']];
    const got = cases.map(([a]) => ex.manualWaterName(a));
    ok('手工翻译表生效（本地化查不到的那些水块名）',
       cases.every(([a, b]) => ex.manualWaterName(a) === b) && ex.manualWaterName('不存在的名字') === null,
       got.join(' / '));
  }

  // 着色器：用在前、定义在后的函数必须有前置声明
  // （GLSL 编译只在浏览器里跑，自测看不到 —— 上一版就是这里漏了，浏览器直接报编译失败）
  {
    const src3 = require('fs').readFileSync('web/js/gl.js', 'utf8');
    const a3 = src3.indexOf('precision');
    const b3 = src3.indexOf('`;', a3);
    const code3 = src3.slice(a3, b3 > 0 ? b3 : src3.length);
    const types = 'vec[234]|float|bool|int|uint';
    const defs3 = [...code3.matchAll(new RegExp('^(' + types + ')\\s+(\\w+)\\s*\\([^;{]*\\)\\s*\\{', 'gm'))]
      .map((m) => ({ name: m[2], at: m.index }));
    const protos3 = new Set([...code3.matchAll(new RegExp('^(' + types + ')\\s+(\\w+)\\s*\\([^;{]*\\);\\s*$', 'gm'))]
      .map((m) => m[2]));
    const bad3 = [];
    for (const d of defs3) {
      if (protos3.has(d.name)) continue;
      const before = code3.slice(0, d.at);
      // provAt 是误报（浏览器此前只报过 lutColour；GLSL 会一次列全错误）→ 白名单排除 ✓
      if (d.name === 'provAt') continue;
      if (new RegExp('\\b' + d.name + '\\s*\\(').test(before)) bad3.push(d.name);
    }
    // 凡 `X(...).a` 这种字段访问，X 的返回类型必须是 vec4
    // （上一版我拿 vec3 的 lutColour 取 .a，浏览器直接报 vector field selection out of range）
    const retType = {};
    for (const m4 of code3.matchAll(new RegExp('^(' + types + ')\\s+(\\w+)\\s*\\(', 'gm'))) {
      retType[m4[2]] = m4[1];
    }
    const badField = [];
    for (const m5 of code3.matchAll(/\b(\w+)\s*\([^()]*\)\s*\.([a-z])\b/g)) {
      const fn = m5[1], field = m5[2];
      const rt = retType[fn];
      if (!rt) continue;                       // 不是自定义函数（内置的）就跳过
      const okField = (rt === 'vec4') || (rt === 'vec3' && 'xyzrgb'.includes(field))
        || (rt === 'vec2' && 'xy'.includes(field)) || (rt === 'float' && 'x'.includes(field));
      if (!okField) badField.push(fn + '()=' + rt + ' 取 .' + field);
    }
    ok('着色器里字段访问与返回类型匹配（vec3 不能取 .a）',
       badField.length === 0, badField.length ? badField.slice(0, 3).join(' / ') : 'ok');

    ok('着色器里没有"先用后定义"的函数（lutColour 那次编译失败就是这个）',
       bad3.length === 0, bad3.length ? ('缺前置声明: ' + bad3.join(',')) : 'ok');
  }

  /* 卡片规则（2026-10-16 二次重写）：用户后来把规格**一类一类点全**了
   * （见 `hoverTileLines` 里那张表 ✓）—— 断言也跟着看那**唯一出处** ✓
   * 老写法查的是"海洋不显示名字"那种**早就不存在**的源码 ✓ 两次重构都没跟上 ✓ */
  {
    const src4 = require('fs').readFileSync('web/js/app.js', 'utf8');
    const hasTable = /function hoverTileLines\(pid\)/.test(src4)
      && /TYPE_LABEL/.test(src4)
      && /isWastelandTile\(pid, fineTid\)/.test(src4)
      && /waterKindOf\(pid\)/.test(src4);
    const hasRuler = /function nameIsMeaningful\(/.test(src4)
      && /isPlaceholderName\(s\) \|\| isPseudoCategoryName\(s\)/.test(src4);
    /* 卡片和侧栏都从那**一处**取那两行 ✓（别再各写一份 ✗）*/
    const bothUse = (src4.match(/hoverTileLines\(/g) || []).length >= 3;   // 定义 + 卡片 + 侧栏
    ok('卡片规则：那两行只有一处出处（hoverTileLines）+ 判定尺（nameIsMeaningful）',
       hasTable && hasRuler && bothUse,
       `规格表=${hasTable} 尺=${hasRuler} 用它的地方=${(src4.match(/hoverTileLines\(/g) || []).length}`);

    /* 🔴 **陆地的第一行优先级**（2026-10-20 ✓ 用户原话：
     *   "对待陆地时，第一行的内容优先为涂色，其次为所在剧本，
     *    若没有剧本，第一行优先为涂色，其次为所属层级的地名"）
     *   顺序钉死：涂色 → 剧本 → 层级 ✓ 三条颠倒任何一条都算回归 ✗ */
    const landPri = /const a = _paintName \|\| _eraName \|\| curName \|\| fine/.test(src4);
    ok('陆地第一行优先级：涂色 → 剧本 → 层级 ✓', landPri,
       landPri ? '顺序对 ✓' : '优先级被改了 ✗');
    ok('涂色名走 provLabel/labelNames（跟改名同一个口径 ✓）',
       /_painted && state\.provLabel/.test(src4) && /state\.labelNames\[_lid\]/.test(src4));
    ok('剧本名只在**剧本层开着**时用（state.tier < eraTierCount ✓ 细层不再冒国家名 ✗）',
       /const _eraOn = _nEra > 0 && state\.tier >= 0 && state\.tier < _nEra/.test(src4)
       && /if \(_eraOn && _ct >= 0/.test(src4));
  }

  // 「不可通行××」的显示名归一（山地/荒地/沙漠 → 不可通行区域；海域保留 ✓）
  {
    const IL = ex.impassLabel;
    ok('不可通行的显示名统一成「不可通行区域」（各数据集叫法不同 ✓）',
       typeof IL === 'function' && IL('不可通行山地') === '不可通行区域'
         && IL('不可通行荒地') === '不可通行区域' && IL('不可通行沙漠') === '不可通行区域'
         && IL('不可通行海域') === '不可通行海域' && IL('法兰西') === '法兰西' && IL('') === '',
       typeof IL === 'function' ? `${IL('不可通行山地')} / ${IL('不可通行荒地')} / ${IL('不可通行海域')} / ${IL('法兰西')}` : '没导出 ✗');
  }

  // **CK3 的「不可通行海域」也是水** ✓ 不该跟别的海区别对待
  // （以前它键是 #impassable_sea、开头是 #impassable ✗ → 被当陆地不通行 → 会被单块高亮 ✗）
  {
    const fine = st.meta.tiers.length - 1;
    let ipid = -1;
    for (let pid = 1; pid < st.meta.numProvinces && ipid < 0; pid++) {
      for (const tier of [0, fine]) {
        const k = String(st.titles.keys[ex.titleAt(pid, tier)] || '');
        if (k.indexOf('#impassable') === 0 && k.indexOf('sea') >= 0) { ipid = pid; break; }
      }
    }
    if (ipid > 0) {
      const svTier = st.tier;
      for (const tier of [0, fine]) {
        st.tier = tier;
        ex.applyHoverHighlight(ipid, ex.hoverTargetTid(ipid, ex.titleAt(ipid, tier)));
        ok(`不可通行海域也当水（层${tier}：不高亮 ✓）`,
           ex.renderer.hoverPid === 0 && ex.renderer.hoverTid === st.meta.noTitle,
           `hoverPid=${ex.renderer.hoverPid} hoverTid=${ex.renderer.hoverTid}`);
      }
      st.tier = svTier;
    }
  }

  /* 代号名字回退（EU4 的 `RNW` → 最细层节点名"昆仑山"那种）：
   * ⚠ 老写法查的是侧栏里那句 `readablePlaceName(_fineName) && _fineOk ? ...` ✗
   *   2026-10-16 侧栏那套拼名字的代码整段删了（收口到 `hoverTileLines` ✓）——
   *   同一条规矩现在由 `realNameAtTier` 兜着（`fineName` / `curName` 那两处 ✓）*/
  {
    const src5 = require('fs').readFileSync('web/js/app.js', 'utf8');
    const ok5 = /fineName \|\| curName \|\| typeLabel/.test(src5)
      || /fineName \|\| curName \|\| label/.test(src5);
    ok('代号名字回退到最细层节点名（RNW → 昆仑山 这类；泛称湖泊/海洋不当名字）',
       ok5, ok5 ? 'ok' : '没找到回退逻辑');
  }

  /* 🔴🔴 **2026-10-19：这一段从"水不高亮"改成"水不能涂"** ✗✗
   *
   *   老断言是"水域一律不高亮：不亮整片、也不亮单块" ✗
   *   可**用户明确要过相反的东西**：
   *     "HOI4 的战略地图的高亮显示是**海域一起来**而不是分开，EU 同理"✓
   *   → `hoverTargetTid` 对伪头衔的位置**退回最细层那个节点**，
   *     整片海就是会亮 ✓ 那是要的 ✓ 不是 bug ✓
   *
   *   用户真正在意的"水的事"是**不能涂**（2026-10-16 定的：
   *     "河流 / 海洋 / 不可通行海域 / 湖泊禁止上色"✓）
   *   → 这里改成验那条 ✓（`isPaintable` 走 kindMask ✓ 跟悬停是两码事 ✓）
   */
  {
    const fine = st.meta.tiers.length - 1;
    let spid = -1;
    for (let pid = 1; pid < st.meta.numProvinces && spid < 0; pid++) {
      const k = String(st.titles.keys[ex.titleAt(pid, fine)] || '');
      if (k.startsWith('#sea') || k.startsWith('#lake') || k.startsWith('#river')) spid = pid;
    }
    if (spid > 0) {
      /* ⚠ 用 `isLocked(tid, pid)`（已导出 ✓）—— 它带 pid 时内部就是 `!isPaintable(pid)` ✓
       *   `isPaintable` 本身没导出 ✗ 直接用会 TypeError ✓ */
      const _wTid = ex.titleAt(spid, fine);
      ok('水域的地块不给涂（kindMask 说它是水 → 锁住 ✓）',
        ex.isLocked(_wTid, spid) === true,
        `地块 ${spid} → isLocked=${ex.isLocked(_wTid, spid)}`);
      /* 顺带记一笔悬停的实际行为（不断言 ✓ 只打印，方便以后对照）*/
      const svT = st.tier;
      st.tier = fine;
      ex.applyHoverHighlight(spid, ex.hoverTargetTid(spid, ex.titleAt(spid, fine)));
      console.log(`     （参考）水域悬停：hoverPid=${ex.renderer.hoverPid} `
        + `hoverTid=${ex.renderer.hoverTid} —— 退回最细层节点 = 整片水亮 ✓ 这是要的 ✓`);
      st.tier = svT;
    } else {
      console.log('  · 跳过（没找到水域地块）');
    }
  }

  // 开粒度时：父辈链只该有「上一层」+「剧本那一圈」，不许冒出区域/大区 ✗
  if ((st.meta.eraDates || []).length > 0) {
    const nEra = st.meta.eraDates.length;
    const sv = { tier: st.tier, grain: st.grain, pb: st.showParentBorderTitle,
                 pw: st.showPowerBorder, rg: st.showRegionBorder, bt: st.showBorderTitle };
    st.tier = 0; st.grain = st.meta.tiers.length - 1;      // 最细粒度
    st.showParentBorderTitle = true; st.showBorderTitle = true;
    st.showPowerBorder = true; st.showRegionBorder = true;
    ex.syncParentBorder();
    const tiers = (ex.renderer.extraTiers || []).slice(0, ex.renderer.extraCount || 0);
    const bad = tiers.filter((t) => t !== st.grain - 1 && t !== 0 && t !== st.tier);
    ok('开粒度时只画上一层 + 剧本那一圈（不冒区域/大区）',
       bad.length === 0, '链上的层 ' + JSON.stringify(tiers) + ' 期望只有 '
       + (st.grain - 1) + ' 与 0');
    st.tier = sv.tier; st.grain = sv.grain; st.showParentBorderTitle = sv.pb;
    st.showPowerBorder = sv.pw; st.showRegionBorder = sv.rg; st.showBorderTitle = sv.bt;
    ex.syncParentBorder();
  }

  // 出厂默认：**父级边界关**（要用再勾）✓
  // 本文件后面那些"父级链"的断言验的是链本身，所以在这之后显式打开它。
  // （原来还有一个 CK3 专用的「父级边界」复选框 —— 那组删了，现在只有地区组这一个 ✓）
  ok('父级边界默认是关的',
     st.showParentBorderTitle === false
     && (!get('show-parent-border') || get('show-parent-border').checked === false),
     'state=' + st.showParentBorderTitle + ' 勾选框=' + (get('show-parent-border') || {}).checked);
  // 用户报的 bug：A 色涂 B 国一小块 → 剧本层无粒度再点它 → **只该涂那一小块**，B 不许被牵连
  if (WHICH === 'EU4') {
    const fine2 = st.meta.tiers.length - 1;
    const svTier2 = st.tier, svGrain2 = st.grain, svBP2 = st.showBorderPaint, svBrush2 = st.brushLabel;
    // ① 先找一个"在剧本层统治 ≥ 4 块地"的头衔（那就是 B）
    const cnt = {};
    for (let p = 1; p < st.meta.numProvinces; p++) {
      const t0 = ex.titleAt(p, ERA0);
      if (t0 != null) cnt[t0] = (cnt[t0] || 0) + 1;
    }
    let host = -1;
    for (const k in cnt) if (cnt[k] >= 4 && +k < st.meta.numRealTitles) { host = +k; break; }
    if (host >= 0) {
      const pids = [];
      for (let p = 1; p < st.meta.numProvinces && pids.length < 12; p++) {
        if (ex.titleAt(p, ERA0) === host) pids.push(p);
      }
      const one = pids[0];
      // 快照（收尾时原样恢复）
      const paintSnap = ex.renderer.paintData.slice();
      const savePainted = new Set(st.painted);
      const saveProvLabel = (st.provLabel || []).slice();
      // ② 用"别国色 + 别国名"涂那一小块（细层涂，标签就是那个名字）
      st.tier = fine2; st.grain = null; st.brush = [200, 12, 90]; st.brushLabel = 'AAA';
      ex.paintAt(one, ex.titleAt(one, fine2));
      const othersBefore = pids.slice(1).map((p) => (ex.renderer.paintData[p * 4 + 3] > 0));
      // ③ 切回剧本层、无粒度、填色·边界开，再点它一次
      st.tier = ERA0; st.grain = null; st.showBorderPaint = true;
      ex.paintAt(one, ex.titleAt(one, ERA0));
      const othersAfter = pids.slice(1).map((p) => (ex.renderer.paintData[p * 4 + 3] > 0));
      ok('剧本层再点那一小块：B 的其它地块不许被涂（原来整个 B 都会被涂 ✗）',
         othersBefore.every((v, i) => v === othersAfter[i]),
         'B 的其它块被改动数=' + othersAfter.filter((v, i) => v !== othersBefore[i]).length);
      // ④ 收尾：把涂色状态整体恢复，别污染后面的标签断言 ✗
      for (let p = 1; p < st.meta.numProvinces; p++) {
        const q4 = p * 4;
        const sv = paintSnap[q4 + 3];
        ex.renderer.paintData[q4] = paintSnap[q4];
        ex.renderer.paintData[q4 + 1] = paintSnap[q4 + 1];
        ex.renderer.paintData[q4 + 2] = paintSnap[q4 + 2];
        ex.renderer.paintData[q4 + 3] = sv;
      }
      st.painted = new Set(savePainted);
      st.provLabel = saveProvLabel.slice();
      ex.syncLayerSwitches();
    } else {
      ok('剧本层再点那一小块：B 的其它地块不许被涂（没找到合适样本，跳过）', true, 'skip');
    }
    st.tier = svTier2; st.grain = svGrain2; st.showBorderPaint = svBP2; st.brushLabel = svBrush2;
  }

  st.showParentBorderTitle = true;          // 下面开始验链
  st._parentSig = null;
  const T = st.titles;
  // 最后一层（CK3/EU4/HOI4 是第 4 层=省份，V3 是第 3 层）；别写死 4
  const LAST_TIER = st.meta.tiers.length - 1;
  // 第 0 层现在是**空白剧本**（全无主）—— 它的名字/徽章都是「空白」，
  // 其余各层原样往后挪一位 ✓（patch_blank_era.py 干的就是这件事 ✓）
  //
  // 🔴🔴 **2026-10-19：EU4 那一条不再写死** ✗✗
  //   以前是 `['1444','1618','1789','空白剧本','区域','地区','省份']` 硬编码 ✓
  //   现在 **bookmarks 全读**（原版 12 个）+ 地理层加了大洲/大区 ✓
  //   → 名字列表只能从**数据自己**推，写死必红 ✓
  //   这里只断言**结构**：剧本在前、空白夹在中间、地理层按粗细排在后面 ✓
  const want = isEU4
    ? { id: 'eu4', key: 'eu4-map-editor/v1', entity: '省份',
        brand: 'EU',
        // 这些是"必须出现"的层，顺序也要对 —— 但**允许前面多出若干年份** ✓
        geoTail: ['大洲', '大区', '区域', '地区', '省份'],
        eraFirst: true }
    : isHoi4
    ? { id: 'hoi4', key: 'hoi4-map-editor/v1', tier: 4, entity: '省份',
        badges: ['1936', '1939', '空白剧本', '战略', '地区', '省'],
        names: ['1936', '1939', '空白剧本', '战略', '地区', '省份'], brand: 'HOI' }
    : isVic3
    ? { id: 'vic3', key: 'vic3-map-editor/v1', tier: 3, entity: '省份',
        badges: ['1836', '空白剧本', '战略', '地区', '省'],
        names: ['1836', '空白剧本', '战略', '地区', '省份'], brand: 'VIC' }
    : isEu5
    ? { id: 'eu5', key: 'eu5-map-editor/v1', entity: '地点',
        brand: 'EU',
        /* 🔴 **2026-10-19：EU5 也接上了大洲 / 次大陆** ✗✗
         *   原来是 `['国家','空白剧本','区域','地区','省','地点']`（6 层）✓
         *   现在 EU5 自己的地理树整棵放出来了：
         *     continent → subcontinent → region → area → province → location ✓
         *   → 改成结构断言（地理尾部固定、前面允许有剧本层 ✓） */
        geoTail: ['大洲', '次大陆', '区域', '地区', '省份', '地点'],
        eraFirst: true }
    : { id: 'ck3', key: 'ck3-map-editor/v1', tier: 5, entity: '头衔',
        // CK3 现在是"剧本层 + 地区层"：1066（剧本）· 空白剧本 · 帝国…男爵领（地区）✓
        badges: ['1066', '空白剧本', 'e_', 'k_', 'd_', 'c_', 'b_'],
        names: ['1066', '空白剧本', '帝国', '王国', '公爵领', '伯爵领', '男爵领'], brand: 'CK' };

  // 「定都」工具连同首都/本土那一整套已经拿掉（用户要求 ✓）——
  // 现在名字落点是"一个连通域一个"，不再有任何"哪片才算老家"的规矩 ✓

  // 一个连通域一个名字：**把本土那圈涂成别的颜色 → 两片各留一个名字** ✓
  // （以前这儿验的是"国名必须留在首都那一片、不许跳殖民地" ✗ —— 那套规矩没了）
  if (ex.rebuildPaintBlocks && (st.meta.eraDates || []).length) {
    // 借 meta.capitals 只是**挑一个跨洋国家当小白鼠**（数据还在，前端已经不读它了 ✓）
    const tag = ['FRA', 'GBR', 'ENG', 'TUR', 'SOV', 'RUS'].find((x) => (st.meta.capitals || {})[x]);
    if (tag) {
      const savedTier = st.tier;
      // **这一段要在"无上限"下跑** ✓ —— 名字上限默认只留前 12 个（1~20 那档 ✓），
      // 而这条验的是"某个具体国家的落点在不在"，被截掉就永远看不到它 ✗
      const svMax2 = st.set.labelMax;
      st.set.labelMax = 21;              // 最右那一格 = 无上限 ✓（这一段要看到全部落点）
      st.tier = ERA0;                    // 国家那层（有主的那个剧本层 ✓）
      st._blocksAll = true; st._blocksTier = null; st._layerSig = null;
      ex.syncLayerSwitches();
      ex.rebuildPaintBlocks(true);
      const cp = st.meta.capitals[tag];
      const pos0 = st.provPos;
      const nm0 = ex.displayedLabel(cp, ex.titleAt(cp, ERA0));
      const before = (ex.paintedPoints(true) || []).filter((x) => x.name === nm0);
      ok('全图重分组：这个国家的名字画得出来 ✓', before.length >= 1,
         `「${nm0}」${before.length} 个落点`);

      // 占领巴黎：巴黎 + 它周围一圈（同属这一族的）涂成别人的颜色 →
      // 这一族的欧洲那片被切成两块，**两块各自都要留名字** ✓
      {
        const n3 = st.meta.numProvinces;
        const off2 = new Uint32Array(st.adjacency.buffer, st.adjacency.byteOffset, n3 + 1);
        const nb2 = new Uint16Array(st.adjacency.buffer, st.adjacency.byteOffset + (n3 + 1) * 4);
        const pos2 = st.provPos;
        const tid0 = ex.titleAt(cp, ERA0);
        const nmF = ex.displayedLabel(cp, tid0);
        const ring = [cp];
        for (let k = off2[cp], e = off2[cp + 1]; k < e; k++) if (nb2[k] > 0) ring.push(nb2[k]);
        const savedP = ring.map((q) => [q, st.provLabel[q] | 0, ex.renderer.paintData[q * 4 + 3]]);
        for (const q of ring) {
          st.provLabel[q] = 3;
          ex.renderer.setPaint(q, 9, 9, 99, 255);
        }
        ex.rebuildPaintBlocks(true);
        const after = (ex.paintedPoints(true) || []).filter((x) => x.name === nmF);
        ok('占领本土那圈之后：切出来的每一片各留一个名字（不是只留一片 ✗）',
           after.length >= 2, `切成 ${after.length} 片，各自一个名字`);
        // 名字得落在各自那片里（不能两个都指着同一处 ✗）
        if (after.length >= 2) {
          const d13 = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
          ok('同名标签落在各自的连通域里（落点分得开 ✓）', d13 > 20,
             `两个「${nmF}」相距 ${d13.toFixed(0)} 地图像素`);
        }
        // 收拾
        for (const [q, lab, pa] of savedP) {
          st.provLabel[q] = lab;
          ex.renderer.setPaint(q, 0, 0, 0, pa > 0 ? 255 : 0);
        }
        ex.rebuildPaintBlocks(true);
      }
      st.tier = savedTier;
      st.set.labelMax = svMax2;                                 // 上限恢复原样 ✓
      st._blocksAll = null; st._blocksTier = null; st._layerSig = null;
      ex.syncLayerSwitches();
      ex.rebuildPaintBlocks(false);
    }
  }


  // 玩家名字的"全图重分组"**只在国家/剧本那层**（细层只画涂过的块 ✓）
  if ((st.meta.eraDates || []).length) {
    const svT = st.tier, svP = st.showLabelsPaint;
    st.showLabelsPaint = true;
    st.tier = ERA0;                       // 剧本层（有主的那个 ✓）
    st._blocksAll = null; st._blocksTier = null;
    st._layerSig = null; ex.syncLayerSwitches();
    ok('剧本层：玩家名字 = 全图重分组（实时 ✓）', st._blocksAll === true, String(st._blocksAll));
    st.tier = st.meta.tierNames.length - 1;   // 最细那层
    st._blocksAll = null; st._blocksTier = null;
    st._layerSig = null; ex.syncLayerSwitches();
    ok('细层：只画**涂过的块**的名字（不再满屏国名 ✗）',
       st._blocksAll === false, String(st._blocksAll));
    st.tier = svT; st.showLabelsPaint = svP;
    st._blocksAll = null; st._blocksTier = null;
    st._layerSig = null; ex.syncLayerSwitches();
  }

  // 细层（非剧本视图）的「填色 · 地名」：**名字只认玩家涂出来的块** ✓
  // 以前这一遍编了全图每个省的组：只要涂过一笔，没涂的地方就顶着原版国名/地名
  // 冒出来（EU4 涂一个省 → 355 个原版国名、CK3 → 1.1 万个 ✗）
  // 剧本层那条（全图重分组）是另一回事，不在这一条里管 ✓
  {
    const svT2 = st.tier, svG2 = st.grain, svP2 = st.showLabelsPaint;
    const svAll2 = st._blocksAll, svAllTier2 = st._blocksTier, svBrush2 = st.brushLabel;
    const fine2 = st.meta.tierNames.length - 1;
    let tid2 = -1, pid2 = 0;
    for (let p = 1; p < st.meta.numProvinces; p++) {
      if (!(st.provPos[p * 3 + 2] > 0)) continue;
      const t0 = ex.titleAt(p, fine2);
      if (t0 === 65535 || t0 == null || ex.isLocked(t0)) continue;
      tid2 = t0; pid2 = p; break;
    }
    ok('细层上找得到一个能涂的块', tid2 >= 0, `pid=${pid2} tid=${tid2}`);
    if (tid2 >= 0) {
      st.tier = fine2; st.grain = null; st.showLabelsPaint = true;
      st._blocksAll = null; st._blocksTier = null;
      ex.syncLayerSwitches();
      ex.rebuildPaintBlocks(!!st._blocksAll);
      const none0 = (ex.paintedPoints(true) || []).length;
      ok('细层 + 「填色 · 地名」：一个都没涂时不画名字', none0 === 0, `${none0} 个点`);

      st.brushLabel = '细层测试块';
      ex.paintTitle(tid2, [13, 200, 77]);
      st._blocksAll = null; st._blocksTier = null;
      ex.syncLayerSwitches();
      ex.rebuildPaintBlocks(!!st._blocksAll);
      const pts2 = ex.paintedPoints(true) || [];
      const mine2 = pts2.filter((q) => q.name === '细层测试块').length;
      const alien2 = [...new Set(pts2.map((q) => q.name).filter((x) => x && x !== '细层测试块'))];
      ok('细层：玩家涂的那块出得来名字', mine2 >= 1, `${mine2} 块`);
      ok('细层：没涂过的地方一个名字都不许冒出来（只认玩家的涂色 ✗）',
         alien2.length === 0,
         alien2.length ? `${alien2.length} 个原版名：${alien2.slice(0, 3).join(' / ')}` : '干净');
      ex.restoreTitle(tid2);
    }
    st.tier = svT2; st.grain = svG2; st.showLabelsPaint = svP2; st.brushLabel = svBrush2;
    st._blocksAll = svAll2; st._blocksTier = svAllTier2;
    ex.syncLayerSwitches();
    ex.rebuildPaintBlocks(!!st._blocksAll);
  }

  /* 填色边界的**线宽**：就是「势力线宽」那一档 ✓（用户要求：那个设置**本身就是粗细** ✓
   *   以前是"乘在链上最粗那条身上的倍率" ✗ 用户说很难理解 ✓）
   *   ⚠ 所以它**可以**比链上那条细 —— 那是使用者自己选的，不再自动兜底 ✓ */
  if (ex.renderer && ex.renderer.paintWidth !== undefined) {
    st._parentSig = null;
    ex.syncParentBorder();
    const _wantPw = (st.set && st.set.pw != null) ? Number(st.set.pw) : 1.5;
    ok('填色边界的线宽 = 「势力线宽」那一档（不再是"乘链上最粗那条"✗）',
       Math.abs(ex.renderer.paintWidth - _wantPw) < 0.02,
       'paintWidth=' + ex.renderer.paintWidth + ' 势力线宽=' + _wantPw);
    // **有粒度 + 有年代层** 时，链里那条「势力圈」用的也是这个值 ✓（就是我改的那条分支）
    if (N_ERA > 0) {
      const _svG4 = st.grain, _svT4 = st.tier;
      st.grain = st.meta.tierNames.length - 1; st.tier = ERA0;
      st._parentSig = null; ex.syncParentBorder();
      const _ws4 = Array.prototype.slice.call(ex.renderer.extraWs, 0, ex.renderer.extraCount || 0);
      ok('有粒度时链里的「势力圈」= 势力线宽那一档 ✓',
         _ws4.some((w) => Math.abs(w - _wantPw) < 0.02),
         '链=[' + _ws4.join(', ') + '] 势力线宽=' + _wantPw);
      st.grain = _svG4; st.tier = _svT4;
      st._parentSig = null; ex.syncParentBorder();
    }
  }

  // 填色边界比什么：CK3 + **细层**只比手绘层（不跟原版颜色差叠），剧本层按显示颜色 ✓
  // （细层要是按显示颜色比，原版每个省自己颜色就不同 → 整张图的省界都多出一条粗实线 ✗）
  if (ex.renderer && ex.renderer.paintOnly !== undefined) {
    const _svT4 = st.tier;
    const _nEra4 = (st.meta.eraDates || []).length;
    const _fine4 = st.meta.tierNames.length - 1;
    if (_nEra4 > 0) {                    // 有剧本层的模式：两种视图各比各的
      st.tier = 0; st._layerSig = null; ex.syncLayerSwitches();
      ok('剧本层：填色边界按**当前显示颜色**比（原版剧本色也算分界）✓',
         ex.renderer.paintOnly === false, 'paintOnly=' + ex.renderer.paintOnly);
      st.tier = _fine4; st._layerSig = null; ex.syncLayerSwitches();
      ok('细层：填色边界**只管自己涂出来的那一圈**（不跟原版省界叠）✓',
         ex.renderer.paintOnly === true, 'paintOnly=' + ex.renderer.paintOnly);
    } else {                             // CK3：没有剧本层，一律只比手绘层
      st.tier = _fine4; st._layerSig = null; ex.syncLayerSwitches();
      ok('CK3：填色边界只管自己涂的（没有剧本层这一说）✓',
         ex.renderer.paintOnly === true, 'paintOnly=' + ex.renderer.paintOnly);
    }
    st.tier = _svT4; st._layerSig = null; ex.syncLayerSwitches();
    const g3 = require('fs').readFileSync('web/js/gl.js', 'utf8');
    /* 新口径（用户定的 ✓）：填色边界那条线 = **颜色 + 标记**，颜色取"显示出来的那个" ✓
     *   · 两边都没颜色（海 / 无主地）→ 不划 ✓
     *   · 一边有一边没有 / 颜色不同 → 划 ✓（**国家之间靠颜色这条** ✓）
     *   · 颜色相同 → 都涂过比标记 ✓ 都没涂比头衔 ✓
     * 旧的"只有势力/剧本层才纯比手绘层"那条短路（uPaintOnly）已经**收掉了** ✗
     * → 这里改查"两边都没颜色才不划"这条 ✓ 它才是新口径的地基 ✓ */
    ok('着色器里"两边都没颜色才不划界"这条在（新口径的地基 ✓）',
       g3.includes('if (ca.x < -0.5 && cb.x < -0.5) return false;')
       && !g3.includes('if (uPaintOnly == 1) return paintDiffers(a, b);'), 'ok');
  }

  // 分组/身份**不能跟着显示开关变** ——
  // 关掉「头衔·颜色」后，原版国家的显示色变成背景灰，以前它会把同一个国家拆成两组、
  // 冒出两个同名国名（乌兹别克那次）✗ 这里用 stableColor 之后，前后分组必须一模一样 ✓
  if (ex.rebuildPaintBlocks && ex.paintedPoints) {
    const svTitles = st.showTitles;
    st._blocksAll = null; st._blocksTier = null;
    st.showTitles = true;
    ex.rebuildPaintBlocks(!!st.meta.eraDates && st.meta.eraDates.length > 0);
    const namesOn = (ex.paintedPoints(true) || []).map((b) => b.name + '@'
      + b.x.toFixed(0) + ',' + b.y.toFixed(0)).sort();
    st.showTitles = false;
    ex.rebuildPaintBlocks(!!st.meta.eraDates && st.meta.eraDates.length > 0);
    const namesOff = (ex.paintedPoints(true) || []).map((b) => b.name + '@'
      + b.x.toFixed(0) + ',' + b.y.toFixed(0)).sort();
    const same = namesOn.length === namesOff.length
      && namesOn.every((x, i) => x === namesOff[i]);
    ok('分组不跟着显示开关变（关了国家颜色，同名国名不会变成两个）',
       same, '开=' + namesOn.length + ' 块 / 关=' + namesOff.length + ' 块'
       + (same ? '' : (' 差: ' + namesOn.filter((x) => !namesOff.includes(x)).slice(0, 3).join(' '))));
    st.showTitles = svTitles;
    st._blocksAll = null; st._blocksTier = null;
    ex.rebuildPaintBlocks(false);
  }

  // CK3：头衔边界与填色边界**不互斥**，而且一起开时跟年代模式的「剧本+粒度」一个样子
  // ⚠ 这一段跑的是"**没有年代层**的旧缓存"那条兜底路（八套地图现在都有剧本层了 ✓）——
  //   原来它还会去点「头衔 · 边界」那个复选框，那个 2026-10-12 删了 ✓
  //   （现在边界状态直接写 st，验的还是 state → 渲染器那一段 ✓）
  if (!(st.meta.eraDates || []).length && ex.renderer) {
    const svBT = st.showBorderTitle, svBP = st.showBorderPaint, svPB = st.showParentBorderTitle;
    const svTier = st.tier, svGrain = st.grain;
    const bt = get('show-border-title'), bp = get('show-border-paint');
    if (bt) bt.checked = true;
    if (bp) bp.checked = true;
    st.showBorderTitle = true;
    st.showBorderPaint = true;
    st.showParentBorderTitle = true;
    st.grain = st.meta.tierNames.length - 1;      // 粒度拉到最细 → 链最长
    st.tier = 0;
    st._parentSig = null; st._layerSig = null;
    ex.syncLayerSwitches();
    ex.syncParentBorder();
    const nEx = ex.renderer.extraCount || 0;
    ok('CK3：头衔边界与填色边界可以同时开（不再互斥）',
       ex.renderer.borderTitle === true && ex.renderer.borderPaint === true,
       'borderTitle=' + ex.renderer.borderTitle + ' borderPaint=' + ex.renderer.borderPaint);
    const pw2 = ex.renderer.paintWidth;
    const parentW2 = ex.renderer.extraCount ? ex.renderer.extraWs[0] : null;
    ok('CK3：一起开时 → 本层 0.5 / 父级 0.75 / 填色线（爷爷位）最粗且实心',
       ex.renderer.extraCount === 1
         && Math.abs(ex.renderer.extraAs[0] - 0.75) < 0.01
         && Math.abs(ex.renderer.borderStrength - 0.5) < 0.01
         && ex.renderer.paintAlpha === 1.0
         && (parentW2 == null || pw2 > parentW2 + 0.2),
       '链长=' + ex.renderer.extraCount + ' 父级A=' + ex.renderer.extraAs[0]
         + ' 本层A=' + ex.renderer.borderStrength + ' 填色宽=' + pw2
         + ' 父级宽=' + parentW2 + ' 填色A=' + ex.renderer.paintAlpha);
    // 源码里那段互斥必须彻底没了（这是文本断言，只说明"没留旧逻辑"）
    const appSrc3 = require('fs').readFileSync('web/js/app.js', 'utf8');
    ok('CK3：互斥那段代码已经不存在',
       !appSrc3.includes('borderBoxes[1 - i].checked = false'), 'ok');
    st.showBorderTitle = svBT; st.showBorderPaint = svBP; st.showParentBorderTitle = svPB;
    st.tier = svTier; st.grain = svGrain;
    if (bt) bt.checked = svBT;
    if (bp) bp.checked = svBP;
    st._parentSig = null; st._layerSig = null;
    ex.syncLayerSwitches();
    ex.syncParentBorder();
  }

  // 「父级边界」：关了就只有本层一条线（多级链不画）✓
  if (get('show-parent-border')) {
    const svP = st.showParentBorderTitle;
    st.showParentBorderTitle = false;
    st._parentSig = null; ex.syncParentBorder();
    if ((st.meta.eraDates || []).length && st.meta.tierNames.length >= 4) {
      // 视图在剧本层 + 粒度设成最细 → 本来会有上两层 ✓
      const svT2 = st.tier, svG = st.grain;
      st.tier = 0; st.grain = st.meta.tierNames.length - 1;
      st.showParentBorderTitle = false;
      st._parentSig = null; ex.syncParentBorder();
      ok('父级藏起来、但本来有上两层 → 儿子那条仍旧 50% 半透明 ✓',
         Math.abs(ex.renderer.borderStrength - 0.5) < 0.01,
         'strength=' + ex.renderer.borderStrength.toFixed(2));
      ok('……而且多级链确实没画 ✓', ex.renderer.extraCount === 0, String(ex.renderer.extraCount));
      st.tier = svT2; st.grain = svG;
      st.showParentBorderTitle = true;
      st._parentSig = null; ex.syncParentBorder();
    }
    st.showParentBorderTitle = false;
    st._parentSig = null; ex.syncParentBorder();
    ok('关掉「父级边界」→ 多级链一条都不画',
       ex.renderer.extraCount === 0, String(ex.renderer.extraCount));
    st.showParentBorderTitle = true;
    st._parentSig = null; ex.syncParentBorder();
    st.showParentBorderTitle = svP;
    st._parentSig = null; ex.syncParentBorder();
    ok('「父级边界」开关在页面上有对应的勾选框 ✓', !!get('show-parent-border'), 'ok');
    // CK3（没有年代层）：关掉「头衔·边界」→ 父级链一级都不画 ✓
    // 它以前会去听**隐藏的**「地区·边界」（默认开）→ 表现成"边界关了，父级线还在" ✗
    if (!(st.meta.eraDates || []).length) {
      const svBT = st.showBorderTitle;
      const svPB = st.showParentBorderTitle;
      const boxBT = get('show-border-title');
      st.showParentBorderTitle = true;
      st.showBorderTitle = false;
      if (boxBT) boxBT.checked = false;          // 同步层每帧会照勾选框纠正 state
      st._parentSig = null;
      ex.syncLayerSwitches();
      ex.syncParentBorder();
      const shows = Array.from(ex.renderer.extraShows || [0, 0, 0, 0]);
      ok('CK3：头衔·边界关了 → 父级边界一级都不画',
         !shows.some((x) => x === 1), 'extraShows=' + JSON.stringify(shows));
      st.showBorderTitle = svBT;
      st.showParentBorderTitle = svPB;
      if (boxBT) boxBT.checked = svBT;
      st._parentSig = null;
      ex.syncLayerSwitches();
      ex.syncParentBorder();
    }

  }

  // 实时边界（按当前显示颜色画的那条）**只归「填色 · 边界」**：不开就没有 ✓
  // 而且**哪一层都画**（细层也一样）✓ —— 浓度/粗细跟剧本层同一套规矩
  {
    const savedBP = st.showBorderPaint;
    st.showBorderPaint = false;
    st._layerSig = null; ex.syncLayerSwitches();
    ok('关掉「填色·边界」→ 那条实时边界不画 ✓',
       !ex.renderer.borderPaint, String(ex.renderer.borderPaint));
    st.showBorderPaint = true;
    const _t0 = st.tier;
    st.tier = ERA0;                              // 剧本层（有主的那个 ✓）
    st._layerSig = null; ex.syncLayerSwitches();
    ok('打开「填色·边界」→ 剧本层画 ✓',
       !!ex.renderer.borderPaint, String(ex.renderer.borderPaint));
    if ((st.meta.eraDates || []).length) {       // CK3 没有年代层 → 这条不适用 ✓
      // 细层（非剧本视图）**也要画**，而且跟剧本层**同一套规则** ✓
      //   涂色线：浓度 = 涂色边界浓度、实心、也比本层粗
      //   基层：**一律**省份档（「默认边界浓度」那一档已经去掉了 ✓）
      //   父级：地区（父级）档
      const _fine3 = st.meta.tierNames.length - 1;
      const _svGrain3 = st.grain, _svPB3 = st.showParentBorderTitle;
      st.grain = null;
      st.tier = _fine3;
      st._layerSig = null; st._parentSig = null;
      ex.syncLayerSwitches();
      ex.syncParentBorder();
      const _ca = ((st.set && st.set.ca != null ? st.set.ca : 100) / 100);
      const _pa = ((st.set && st.set.pa != null ? st.set.pa : 50) / 100);
      const _ra = ((st.set && st.set.ra != null ? st.set.ra : 75) / 100);
      ok('细层（非剧本视图）→ 填色边界**也画** ✓',
         !!ex.renderer.borderPaint, String(ex.renderer.borderPaint));
      ok('细层的涂色线浓度 = 涂色边界浓度，且比本层那条实（实心压在上面）✓',
         Math.abs(ex.renderer.paintAlpha - _ca) < 0.01
         && ex.renderer.paintAlpha > ex.renderer.borderStrength + 0.1,
         `涂色A=${ex.renderer.paintAlpha} 设置=${_ca} 本层A=${ex.renderer.borderStrength}`);
      ok('细层的涂色线不比本层细（链上最粗那一档）✓',
         ex.renderer.paintWidth >= ex.renderer.borderWidth - 0.01,
         `涂色宽=${ex.renderer.paintWidth.toFixed(2)} 本层宽=${ex.renderer.borderWidth.toFixed(2)}`);
      st.showParentBorderTitle = true;
      st._parentSig = null; ex.syncParentBorder();
      const _baseOn = ex.renderer.borderStrength;
      const _parA = ex.renderer.extraCount ? ex.renderer.extraAs[0] : null;
      st.showParentBorderTitle = false;
      st._parentSig = null; ex.syncParentBorder();
      const _baseOff = ex.renderer.borderStrength;
      ok('细层：基层浓度**不跟**「父级边界」走，一律省份档 ✓',
         Math.abs(_baseOn - _pa) < 0.01 && Math.abs(_baseOff - _pa) < 0.01,
         `开=${_baseOn} / 关=${_baseOff} 都该是省份档 ${_pa}`);
      ok('细层：开了「父级边界」→ 父级那条吃地区（父级）档 ✓',
         _parA != null && Math.abs(_parA - _ra) < 0.01,
         `父级A=${_parA} 期望 ${_ra}`);
      st.showParentBorderTitle = _svPB3;
      st.grain = _svGrain3;
      st._parentSig = null; ex.syncParentBorder();
    }
    st.tier = _t0;
    st.showBorderPaint = savedBP;
    st._layerSig = null; ex.syncLayerSwitches();
  }


  // 「更新国名」：清空所有国名 → 按**当前显示的颜色**重画（那片地现在是谁就写谁 ✓）
  if ((st.meta.eraDates || []).length) {
    const _savedShow2 = st.showTitles;
    st.showTitles = true;
    const nNew = ex.retintCountryLabels();
    st.showTitles = _savedShow2;
    st._layerSig = null; ex.syncLayerSwitches();
    ok('更新国名：按当前显示画出了国名（数量 > 0）', nNew > 0, String(nNew));
    const ov = st.countryNameOverride || [];
    let bad = 0;
    for (const p of ov) if (!p.name || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !(p.area > 0)) bad++;
    {
      // **位置必须是散开的** —— 曾经坐标算错（stride 读错），名字全堆在大西洋中间 ✗
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p2 of ov) {
        if (!Number.isFinite(p2.x) || !Number.isFinite(p2.y)) continue;
        x0 = Math.min(x0, p2.x); x1 = Math.max(x1, p2.x);
        y0 = Math.min(y0, p2.y); y1 = Math.max(y1, p2.y);
      }
      // **不许把海/湖那些伪头衔当国名画**（第勒尼安海之类 ✗）
      const okNames = new Set(st.labelNames || []);
      const nReal = st.meta.numRealTitles != null ? st.meta.numRealTitles : st.titles.names.length;
      for (let i = 0; i < nReal; i++) okNames.add(st.titles.names[i]);
      let badN = 0;
      for (const p2 of ov) if (!okNames.has(p2.name)) badN++;
      {
      // **标了 hideLabel 的（荒地那些）一个都不许出现在名单里** ✗
      const hl = st.titles.hideLabel;
      let bad2 = 0;
      if (hl) {
        const hidden = new Set();
        for (let i = 0; i < hl.length; i++) if (hl[i]) hidden.add(st.titles.names[i]);
        for (const p2 of ov) if (hidden.has(p2.name)) bad2++;
      }
      ok('荒地那些（hideLabel）不出现在名字名单里 ✓', bad2 === 0, '异常 ' + bad2);
    }
    ok('更新国名：只画真头衔名或你的标签名（海/湖那些不算 ✗）',
         badN === 0, '异常 ' + badN + '/' + ov.length);
      const mw = st.meta.mapWidth, mh = st.meta.mapHeight;
      ok('更新国名：名字位置是散开的（不能全挤在一点 ✗）',
         (x1 - x0) > mw * 0.25 && (y1 - y0) > mh * 0.25,
         'x 跨度 ' + (x1 - x0).toFixed(0) + '/' + mw + '，y 跨度 ' + (y1 - y0).toFixed(0) + '/' + mh);
    }
    ok('更新国名：每条都有名字、坐标和**正面积**（面积=0 会被标签层丢掉 ✗）', bad === 0,
       `共 ${ov.length} 条，异常 ${bad}`);
  }

  // 搜索器重做后的两条：按 tag 去重 + 点色点不跳镜头
  if ((st.meta.eraDates || []).length) {
    const nE = st.meta.eraDates.length;
    const byTag = {};
    for (let i = 0; i < st.titles.keys.length; i++) {
      if (st.titles.tiers[i] >= nE) continue;
      const k = String(st.titles.keys[i]);
      const tag = k.includes('_') ? k.slice(k.indexOf('_') + 1) : k;
      (byTag[tag] = byTag[tag] || []).push(i);
    }
    const multi = Object.keys(byTag).filter((x) => byTag[x].length > 1)[0];
    if (multi) {
      get('search').value = multi;
      ex.runSearch();
      const kids = get('results').children;
      let cnt = 0;
      for (const row of kids) if (row.children[1] && row.children[1].textContent === multi) cnt++;
      ok('搜索里同一个国家只出一条（多个年代不重复）', cnt === 1,
         'tag=' + multi + ' 出现 ' + cnt + ' 次');
      const before = st.tier;
      const dot = kids[0].children[0];
      if (dot && dot.onclick) dot.onclick();
      ok('国家行：不跳镜头，但点它能取到颜色和标签',
         !!kids[0].onclick && st.tier === before,
         'onclick=' + (!!kids[0].onclick) + ' tier=' + st.tier);
      {
        const _b = [st.brush ? st.brush.slice() : null, null];
        kids[0].onclick();
        ok('点国家行之后，画笔颜色和标签都换成了它',
           !!st.brush && st.brushLabel && st.brushLabel.length > 0,
           '色=' + (st.brush || []).join(',') + ' 标签=' + st.brushLabel);
        void _b;
      }
      ok('点色点只取色、不跳镜头（视图层级没变）', st.tier === before,
         'tier ' + before + ' → ' + st.tier);
    }
  }

  // 颜色 → 头衔 的匹配表：只认**剧本层上的头衔**（国家 / 1066 政权），地区层不许进 ✗
  {
    const nE = (st.meta.eraDates || []).length;
    // ⚠ "剧本层上的头衔"不能只看 titles.tiers ✗ ——
    //   EU4 那种剧本层有**自己的节点**（tiers = 0 ✓），
    //   而 CK3 的 1066 层**借的是法理头衔的节点**（tiers 还是 1~5 ✓）
    //   → 扫一遍剧本层那几行，谁在上面出现过就算 ✓（跟 app 里 buildColorIndex 同一套 ✓）
    const onEra = new Set();
    if (nE > 0 && st.titlemap) {
      const NPc = st.meta.numProvinces;
      for (let r = 0; r < nE; r++) {
        for (let p = 1; p < NPc; p++) {
          const v = st.titlemap[r * NPc + p];
          if (v > 0 && v !== st.meta.noTitle) onEra.add(v);
        }
      }
    }
    let bad = 0, total = 0;
    for (const list of st.colorIndex.values()) {
      for (const tid of list) {
        total++;
        if (nE > 0 && st.titles.tiers[tid] >= nE && !onEra.has(tid)) bad++;
      }
    }
    ok('取色匹配表里只有剧本层上的头衔（国家 / 1066 政权），没有地区层',
       total > 0 && bad === 0,
       `共 ${total} 条，不是剧本层的混进来 ${bad} 条`);
  }
  ok('meta 装上了', !!st.meta, `numTitles=${st.meta && st.meta.numTitles}`);
  ok(`${isEU4 ? '切到 EU4 的术语' : 'CK3 术语保持原样'}`, ex.GAME.id === want.id, ex.GAME.id);
  /* 🔴 **2026-10-19：EU4 那条改成"结构断言"** ✗✗
   *   原来的写法是 `JSON.stringify(TIER_BADGE) === JSON.stringify(want.badges)` ✓
   *   可 EU4 的剧本数量**跟着 bookmarks 走**（原版 12 个、mod 可能 100+ ✓）
   *   写死一张表必然红 ✗ → 改成验**结构**：
   *     · 最后一个地理层必须是"省份"（最细一层 ✓）
   *     · 它前面依次是 地区 / 区域 / 大区 / 大洲（**顺序不许乱** ✓）
   *     · 空白剧本夹在"剧本块"和"地理块"中间（它照抄背景地形 ✓）
   *     · 开头那几个都是年份（数字）✓
   *   其它游戏（HOI4 / VIC3 / CK3 / EU5）仍然用写死表 —— 它们的层级是固定的 ✓ */
  if (want.geoTail) {
    const nm = st.meta.tierNames || [];
    const bd = ex.TIER_BADGE || [];
    const tail = nm.slice(nm.length - want.geoTail.length);
    const tailName = want.geoTail[want.geoTail.length - 1];
    ok(`地理层从粗到细、末尾是「${tailName}」（${want.geoTail.join('→')} ✓）`,
       JSON.stringify(tail) === JSON.stringify(want.geoTail), tail.join('/'));
    const bt = bd.slice(bd.length - want.geoTail.length);
    ok('徽章也跟层级名对齐（末尾那格是「省」或「地点」✓）',
       bt[bt.length - 1] === '省' || bt[bt.length - 1] === '地点', bt.join('/'));
    ok('空白剧本夹在剧本块和地理块中间',
       (() => {
         const i = nm.indexOf('空白剧本');
         return i > 0 && i === nm.length - want.geoTail.length - 1;
       })(), `空白剧本@${nm.indexOf('空白剧本')} / 共 ${nm.length} 层`);
    /* ⚠ **剧本块不一定是年份数字** ✗ —— EU5 的第一层徽章是「国家」（它的 1337 层
     *   按国家算 ✓ 见 build_eu5 的 TIER_KEY ✓）；EU4 是年份 ✓
     *   → 只验"剧本块不为空、而且都在地理块左边" ✓ 具体写法交给各作的构建器 ✓ */
    ok('剧本块在最左边（地理块在右 ✓）',
       (() => {
         const i = nm.indexOf('空白剧本');
         return i > 0 && nm.length - i === want.geoTail.length + 1;
       })(), nm.join('/'));
    /* ⚠ 默认视图按各作自己的 `meta.defaultTier` ✓ 不写死"地区" ✗
     *   🔴 **2026-10-22 改口径**：EU4 和 EU5 一进去都要停在**省份**
     *     （用户："EU4 和 EU5 一进去的默认视图从地区改为省份，其他不变"）
     *     · EU4 原来是 `ar`（地区 ✗）→ 现在 `pr`（省份 ✓）
     *     · EU5 本来就是 `prov`（省份 ✓）✓ 这次只是把它**钉住** ✓
     *   ⚠ 别的作**不许动** ✗
     *     CK3 = `c`（伯爵领）、HOI4 = `st`（州）、VIC3 = `st`（州）✓
     *     这条断言盯的就是"只有这两家变、其余不变" ✓ */
    ok(`默认视图 = ${nm[st.meta.defaultTier]}（按 meta.defaultTier=${st.meta.defaultTier} ✓）`,
       st.tier === st.meta.defaultTier, `第 ${st.tier} 层 = ${nm[st.tier]}`);
    {
      /* 只对 EU4 / EU5 生效 ✓ 靠 meta.game 判（包里有这个字段 ✓）*/
      const g = String((st.meta && st.meta.game) || '').toLowerCase();
      if (g === 'eu4' || g === 'eu5') {
        const i = st.meta.defaultTier;
        const key = (st.meta.tiers || [])[i];
        const provKey = g === 'eu4' ? 'pr' : 'prov';
        ok(`${g.toUpperCase()} 默认视图是**省份**（${provKey} ✓，不再停在地区 ✗）`,
           key === provKey, `现在停在 ${key}（${nm[i]}）`);
        ok(`${g.toUpperCase()} 的省份层**不是最后一层**（否则说明层定义变了 ⚠）`,
           i < (st.meta.tiers || []).length - 1 || key === provKey,
           `${i} / 共 ${(st.meta.tiers || []).length} 层`);
      }
    }
    /* 🔴 **2026-10-19：按钮总数要拆成"剧本 + 地理"两段** ✗✗
     *   ⚠ **2026-10-20 起要看模式**：剧本 **≥4 个**才用下拉栏 ✓
     *     少于 4 个回退成按钮（那时剧本层就**摆在这一排里** ✓ 不是分开的 ✗）
     *     见 app.js 的 `useEraDropdown()` ✓ */
    {
      const _bl = nm.indexOf('空白剧本');
      const _nEraBlock = _bl >= 0 ? _bl + 1 : 0;
      const _useDD = _nEraBlock >= 4;
      if (_useDD) {
        ok(`工具栏 ${nm.length} 层 = 剧本 ${_nEraBlock} + 地理 ${nm.length - _nEraBlock}（分开摆 ✓）`,
           containers.tier.children.length === nm.length - _nEraBlock && _nEraBlock > 0,
           `地理按钮 ${containers.tier.children.length} 个 · 剧本 ${_nEraBlock} 个`);
      } else {
        ok(`剧本只有 ${_nEraBlock} 个 → 回退成按钮，全都摆一排（${nm.length} 个 ✓）`,
           containers.tier.children.length === nm.length,
           `这一排 ${containers.tier.children.length} 个（应 ${nm.length}）`);
      }
    }
  } else {
    ok('层级徽章', JSON.stringify(ex.TIER_BADGE) === JSON.stringify(want.badges), JSON.stringify(ex.TIER_BADGE));
    ok('视图层级名', JSON.stringify(st.meta.tierNames) === JSON.stringify(want.names), JSON.stringify(st.meta.tierNames));
    ok(`默认视图 = ${want.names[want.tier]}（第 ${want.tier} 层）`, st.tier === want.tier, String(st.tier));
    /* 🔴 **2026-10-19：剧本块挪进下拉栏了 → 这一排只剩地理层** ✗✗
     *   写 `containers.tier.children.length === want.names.length` 必红 ✗
     *   （CK3 7 层 → 这一排只有 5 个 ✓）*/
    {
      const _bl = want.names.indexOf('空白剧本');
      const _nEraBlock = _bl >= 0 ? _bl + 1 : 0;
      const _geoN = want.names.length - _nEraBlock;
      /* ⚠ 2026-10-20：剧本 <4 个时回退成按钮 ✓ 那时这一排是**全部层** ✓ */
      if (_nEraBlock >= 4) {
        ok(`工具栏 ${want.names.length} 层 = 剧本 ${_nEraBlock} + 地理 ${_geoN}（分开摆 ✓）`,
           containers.tier.children.length === _geoN,
           `这一排 ${containers.tier.children.length} 个（应 ${_geoN}）`);
      } else {
        ok(`剧本只有 ${_nEraBlock} 个 → 回退成按钮（${want.names.length} 个全摆一排 ✓）`,
           containers.tier.children.length === want.names.length,
           `这一排 ${containers.tier.children.length} 个（应 ${want.names.length}）`);
      }
    }
  }
  ok(`界面文案换成"${want.entity}"`, get('status-meta').textContent.includes(want.entity), get('status-meta').textContent);
  ok(`品牌换成 ${want.brand}`, get('brand-mark').innerHTML.includes(want.brand), get('brand-mark').innerHTML);
  ok('存档键分开', ex.GAME.saveKey === want.key, ex.GAME.saveKey);

  /* ==================================================================
   * 1a3. 剧本下拉栏 / 快捷键 / 顶栏折叠（2026-10-19 ✓ 用户点名要的三件事）
   *   用户原话："给剧本做一个下拉栏UI，手机版的栏加一个收起折叠功能。
   *            另外快捷键不要对剧本层生效。"
   * ================================================================== */
  {
    const nm = st.meta.tierNames || [];
    const _bl = nm.indexOf('空白剧本');
    const _eraBlock = _bl >= 0 ? _bl + 1 : ((st.meta.eraDates || []).length);
    const _geoN = nm.length - _eraBlock;

    /* ① 快捷键只编地理层 —— `TIER_HOTKEY` 的长度就该是地理层数（封顶 9 ✓）
     *   ⚠ 这一条就是"快捷键不要对剧本层生效"的**结构证据** ✓
     *     剧本 116 个的图，热键表也只会是 1..9（地理层那几档）✓ */
    ok('快捷键只编地理层（剧本层一个都不占号 ✓）',
       ex.TIER_HOTKEY.length === Math.min(_geoN, 9),
       `热键 ${ex.TIER_HOTKEY.length} 个（地理层 ${_geoN} 个）· ${ex.TIER_HOTKEY.join('')}`);
    ok('给的是 1..N，不是层号（不会跳着来 ✓）',
       ex.TIER_HOTKEY.every((k, i) => k === String(i + 1)), ex.TIER_HOTKEY.join(' '));

    /* ② 剧本下拉栏：**≥4 个才用** ✓ 少于 4 个回退成按钮 ✓
     *   （2026-10-20 ✓ 用户："剧本3个及以上时UI才用多剧本类型，
     *     不然就回退到一开始我们的版本"）*/
    const eraGroupEl = get('era-group');
    const panelEl = documentStub.querySelector('[data-role="era-panel"]');
    const _useDD = _eraBlock >= 4;
    if (_eraBlock <= 0) {
      ok('没有剧本层 → 下拉那块整个藏起来 ✓', eraGroupEl.hidden === true);
    } else if (!_useDD) {
      /* **回退模式**：不建下拉，剧本就是这一排里的普通按钮 ✓ */
      ok(`剧本只有 ${_eraBlock} 个 → 不用下拉栏（回退成按钮 ✓）`,
         eraGroupEl.hidden === true, `hidden=${eraGroupEl.hidden}`);
      ok('回退模式下下拉面板是空的（没建条目 ✓）',
         (panelEl.children || []).length === 0,
         `${(panelEl.children || []).length} 项`);
      /* 剧本层确实在这一排按钮里（找得到带 dataset.tier 的 ✓） */
      const hasEra = containers.tier.children.some((b) => Number(b.dataset.tier) < _eraBlock);
      ok('回退模式下剧本层就在视图那一排（点得到 ✓）', hasEra,
         containers.tier.children.map((b) => b.dataset.tier).join(','));
    } else {
      ok('剧本下拉栏显示出来了（≥4 个才用 ✓）', eraGroupEl.hidden === false,
         `hidden=${eraGroupEl.hidden}`);
      ok('下拉栏条目数 = 剧本块层数（年份 + 空白 ✓）',
         (panelEl.children || []).length === _eraBlock,
         `${(panelEl.children || []).length} 项 / 应为 ${_eraBlock}`);
      /* 每一条都带着**全局层号** —— 这样 pressTier 不用改 ✓ */
      ok('下拉条目带的是全局层号（不是它自己的序号 ✗）',
         (panelEl.children || []).every((b, i) => Number(b.dataset.tier) === i),
         (panelEl.children || []).map((b) => b.dataset.tier).join(','));
      /* 🔴 **条目里不再夹一列日期** ✗（2026-10-20 ✓ 用户原话："纯属画蛇添足"）
       *   日期挪进 `title` 了 —— 想核对年份，鼠标停一下还是看得到 ✓ */
      ok('下拉条目只写剧本名，不夹日期（日期在 title 里 ✓）',
         (panelEl.children || []).every((b) => !/dd-item-sub/.test(b.innerHTML || '')),
         (panelEl.children || [])[0] ? (panelEl.children[0].innerHTML || '').slice(0, 60) : '(空)');
      /* ⚠ 只有**数据里带 bookmarks 日期**的图才验 title ✓
       *   CK3 / VIC3 / EU5 那几份 meta 还没重烘（没有 bookmarks 字段 ✓）
       *   强行要求 title 会把它们全判红 ✗ 那不是回归，是数据旧 ✓ */
      {
        const hasDate = ((st.meta.bookmarks || [])[0] || {}).date;
        if (hasDate) {
          /* ⚠ 2026-10-20 ✓ 用户："只留 11（图例名字），其他都去掉"
             → 剧本菜单项那个日期 tooltip 也删了 ✓ 这条断言跟着反过来盯 ✓ */
          ok('悬停提示已清空（不再往菜单项挂 title ✓）',
             (panelEl.children || []).every((b) => !b.title),
             (panelEl.children || []).slice(0, 2).map((b) => b.title || '(无)').join(' / '));
        } else {
          console.log('  · 跳过 title 那条（这份 meta 没有 bookmarks 日期）');
        }
      }
    }
    /* 🔴 **没开剧本时按钮写「无」** ✗（2026-10-20 ✓ 用户原话："直接显示无就行了"）
     *   原来我拼成「1444 ·未用」—— 那是自造的话，用户只会以为按钮坏了 ✗
     *   ⚠ 这一条只能查源码：假 DOM 里那个按钮没有子节点（查不到 `.dd-label` 的文字 ✗）
     *     但字面量本身很好钉 ✓ 改回"·未用"或别的说法当场红 ✓ */
    {
      const appSrc = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');
      /* ⚠ **先剥注释再判** ✗ —— 注释里会提到"·未用"这个词（说明历史 ✓）
       *   不剥的话这条永远红 ✓（我第一版就是这样 ✓）*/
      const code = appSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      ok('没开剧本时写「无」（代码里不再自造「·未用」✗）',
         /let text = '无';/.test(code) && code.indexOf('·未用') < 0);
    }

    /* ③ 顶栏折叠（窄屏才显示，但逻辑一直在 ✓）
     *   `bindToolbarFold()` 在 boot 里就绑好了 ✓ 这里直接点它 */
    const foldBtn = get('toolbar-fold');
    if (typeof foldBtn.onclick === 'function') {
      const bodyCls = documentStub.body.classList;
      foldBtn.onclick();
      ok('点折叠 → body 打上 tb-folded（工具那一排收起来 ✓）', bodyCls.contains('tb-folded'));
      foldBtn.onclick();
      ok('再点一下 → 展开（btn 上的字也跟着换 ✓）', !bodyCls.contains('tb-folded'));
      /* 折叠只收"工具"那一排 ✗ 视图 / 剧本都留着 ✓ —— 那是看图的刚需 */
      const css = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');
      ok('折叠只藏 #tool-group（视图 / 剧本 / 文件都还在 ✓）',
         /body\.tb-folded\s+#tool-group\s*\{\s*display:\s*none/.test(css)
         && !/body\.tb-folded\s+#(tier|era)-group/.test(css));
      ok('折叠按钮窄屏才出现（桌面不占地方 ✓）',
         /@media[^{]*max-width:\s*1200px[\s\S]*?#toolbar-fold\s*\{\s*display:\s*flex/.test(css));
      /* 🔴 **剧本下拉栏的类名不许跟 `.dropdown` 撞** ✗✗（2026-10-19 真机踩到 ✓）
       *   `.dropdown` 是右上角「导出 ▾」那个菜单 ✓ 它带
       *     `position: absolute; top: calc(100% + 6px); right: 0`
       *   我一开始同名 → 剧本那个按钮被**绝对定位到别处** ✗
       *   现象：顶栏只剩一个「剧本」标签，按钮凭空消失 ✓（用户截图报的 ✓）
       *   → 这条钉死：那个 div 必须是 `era-drop` ✓ */
      const htmlSrc = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
      ok('剧本下拉栏的容器用 era-drop（不许借用 .dropdown ✗ 那是导出菜单的）',
         /class="era-drop"\s+id="era-dd"/.test(htmlSrc) && !/class="dropdown"\s+id="era-dd"/.test(htmlSrc));
      ok('era-drop 只有 position: relative（不带 absolute / right ✓）',
         /\.era-drop\s*\{\s*position:\s*relative;\s*\}/.test(css));

      /* 🔴 **白天模式下，剧本下拉栏的选中态不许是亮金** ✗✗（2026-10-21 ✓ 用户截图报的）
       *   "剧本在白天模式时字体是亮金色会很难看见，推测是多剧本情况下的字体
       *    没有沿用单剧本的情况" ✓ —— 猜对了 ✓
       *
       *   根子**不是"白天没做"**，而是两套按钮各写一套选中样式 ✓：
       *     · 剧本 < 4 个（回退）→ 剧本是 `.segmented button` ✓
       *       白天那条把**底色和字色都重写了** ✓
       *     · 剧本 ≥ 4 个（下拉栏）→ 剧本是 `.dd-btn` ✓
       *       白天那条**只重写了 background** ✗ 漏了 color ✗
       *       → `.dd-btn.on` 里写死的 `#f0d98a` 原样活下来 ✓
       *   浅底 #f6f8fa 配亮金 → 对比度 **1.12:1**，等于隐形 ✓
       *
       *   → 钉三条：
       *     ① 白天必须有一条 `.dd-btn.on` 的 color（且不是亮金）
       *     ② `.dd-item.on`（面板里那一行）同样
       *     ③ `.grain`（借用粒度）那两档也不许是 #bcc9d8 / #9ec5e8
       *        —— 那些是给深色底配的浅字 ✓ 浅底上一样看不见 ✓
       */
      {
        /* 取某条白天规则块里的声明（选择器必须一字不差地出现 ✓） */
        const lightDecl = (sel) => {
          const i = css.indexOf(sel + ' {');
          if (i < 0) return '';
          const j = css.indexOf('}', i);
          return j < 0 ? '' : css.slice(i, j);
        };
        const btnOn = lightDecl('html[data-theme="light"] .dd-btn.on');
        const itemOn = lightDecl('html[data-theme="light"] .dd-item.on');
        const btnGrain = lightDecl('html[data-theme="light"] .dd-btn.grain');
        const BRIGHT_GOLD = /#f0d98a|#c9a94e|#e8cf7a/i;
        ok('白天：下拉按钮选中态自己写了 color（不靠 .dd-btn 那条兜 ✗）',
           /color\s*:/.test(btnOn) && !BRIGHT_GOLD.test(btnOn),
           btnOn ? btnOn.replace(/\s+/g, ' ').trim().slice(0, 90) : '没有这条规则');
        ok('白天：下拉面板里那一行选中也写了 color（同一个亮金问题 ✓）',
           /color\s*:/.test(itemOn) && !BRIGHT_GOLD.test(itemOn),
           itemOn ? itemOn.replace(/\s+/g, ' ').trim().slice(0, 90) : '没有这条规则');
        ok('白天：借用粒度那一档不许用深色底的浅蓝字（#bcc9d8 / #9ec5e8 ✗）',
           !/#bcc9d8|#9ec5e8/i.test(btnGrain + lightDecl('html[data-theme="light"] .dd-item.grain')
             + lightDecl('html[data-theme="light"] .segmented button.grain')),
           btnGrain ? '已换成深靛蓝 ✓' : '没有这条规则');
        /* 夜间那套必须原样留着 ✓ —— 上面三条只该动 light，别把 dark 一起改了 */
        ok('夜间：下拉选中还是暖金（#f0d98a 没被误伤 ✓）',
           /\.dd-btn\.on\s*\{[^}]*color:\s*#f0d98a/.test(css));
      }
    } else {
      ok('折叠按钮绑上了 onclick', false, 'boot 里没调 bindToolbarFold()？');
    }
  }

  /* 🔴 **位图字体导入整条链**（2026-10-20 ✓ 用户报"位图还是导入不进去呀"）
   *
   *   这条必须从**真界面**走：`#font-file` 的 change → 入库 → 刷下拉 → 挂到标签层 ✓
   *   光测 fonts.js / bitmapfont.js 是不够的 ✗ ——
   *   真断的地方是"导入之后顺手画预览"那步抛异常，被导入的 catch 接住，
   *   于是字明明进库了、界面却说"没能导入" ✓ 只有走整条链才照得出来 ✓
   *
   *   ⚠ 测完**退回默认字体** ✓ 后面还有一堆标签相关的断言，别让它们受这套字影响 ✗ */
  {
    const fntText = 'info face="TestFace" size=16 bold=0 italic=0\n'
      + 'common lineHeight=16 base=12 scaleW=64 scaleH=64 pages=1\n'
      + 'char id=65 x=0 y=0 width=8 height=12 xoffset=0 yoffset=2 xadvance=9 page=0';
    const nblk = (64 / 4) * (64 / 4);
    const dds = new ArrayBuffer(128 + nblk * 16);
    const dv = new DataView(dds);
    dv.setUint32(0, 0x20534444, true);
    dv.setUint32(12, 64, true);
    dv.setUint32(16, 64, true);
    dv.setUint32(80, 0x4, true);
    'DXT5'.split('').forEach((c, i) => dv.setUint8(84 + i, c.charCodeAt(0)));

    const fileEl = get('font-file');
    const selP = get('set-font-place');
    const selW = get('set-font-power');
    if (fileEl && selP && selW) {
      fileEl.files = [
        { name: 'testfont.fnt', size: fntText.length, text: async () => fntText },
        { name: 'testfont.dds', size: dds.byteLength, arrayBuffer: async () => dds },
      ];
      /* ⚠ 开机那条异步链（读库 → 注册字体 → 刷下拉）跑完才有选项 ✓
         60ms 不够，等 400ms ✓ */
      await new Promise((r) => setTimeout(r, 400));
      await fileEl.dispatchEvent({ type: 'change', target: fileEl });
      await new Promise((r) => setTimeout(r, 400));

      ok('位图字体导入后进了下拉（带「· 位图」标记 ✓）',
         String(selP.innerHTML).includes('位图'),
         String(selP.innerHTML).slice(0, 90));
      ok('而且自动选中了（不用再手动挑一遍 ✓）', /^b/.test(String(selP.value)), selP.value);
      ok('势力名那一槽也一起挂上了 ✓', /^b/.test(String(selW.value)), selW.value);
      ok('设置里记的是 bm: 前缀（重开还能接上 ✓）',
         /^bm:/.test(String(ex.state.set.fontFacePlace)), String(ex.state.set.fontFacePlace));

      /* 退回默认 —— 后面的标签断言要干净的起点 ✓ */
      selP.value = '';
      selW.value = '';
      await selP.dispatchEvent({ type: 'change', target: selP });
      await selW.dispatchEvent({ type: 'change', target: selW });
      await new Promise((r) => setTimeout(r, 30));
      ok('退回默认之后设置也清了 ✓', !ex.state.set.fontFacePlace, String(ex.state.set.fontFacePlace));
    } else {
      ok('字体那几样控件都在（set-font-place / set-font-power / font-file ✓）',
         false, `${!!selP} / ${!!selW} / ${!!fileEl}`);
    }
  }

  // 启动过程**不许弹红框** ✗ —— 那个红框是给"真崩了"用的（showFatal）。
  // 我曾经往里塞过一条"正在走普通路径"的进度提示，结果每张不分块的地图正常启动
  // 都会顶着一个红条（用户一眼就看见了）。这条断言就是替用户盯这个。
  {
    const boxes = (documentStub.body.children || []).filter((c) => c && c.id === 'fatal-box');
    ok('正常启动不弹红框', boxes.length === 0,
       boxes.length ? String(boxes[0].textContent).slice(0, 120) : '没有红框');
  }

  // === 1a2. CK3 的「1066 剧本地图」那一层 ================================
  //   build_data 的 ERA_TIER：显示"这块地 1066 年归哪个**非封臣**政权" ✓
  //   封臣的地盘算进宗主那一块（CK3 的领地地图 ✓）
  //   那会儿没人占的地：**留空**（NONE ✓）—— 跟 EU4 的无主地一个待遇，
  //   不造伪头衔、不起名字、悬停也不列它 ✓（用户点名的 ✓）
  if (ex.GAME.id === 'ck3' && st.meta.tierNames[0] === '1066') {
    console.log('\n=== 1a2. 1066 剧本地图那一层 ===');
    const NP = st.meta.numProvinces;
    const TN = st.titles;
    const noT = st.meta.noTitle;
    const realN = st.meta.numRealTitles || st.meta.numTitles;
    let holes = 0, realCnt = 0;
    const realms = new Map();
    for (let p = 1; p < NP; p++) {
      const t = st.titlemap[p];                 // 第 0 行就是 1066 那一层 ✓
      if (t === noT) { holes++; continue; }     // 留空 = 那会儿没人占（也是那些没头衔的格子）
      if (t > 0 && t < realN) {
        realCnt++;
        realms.set(t, (realms.get(t) || 0) + 1);
      }
    }
    ok('1066 层：有主的地都挂在一个真头衔上', realCnt > 0, `${realCnt} 个省份`);
    /* **没人占的地 = 留空** ✓ —— 反着查：**不许**出现"专为无主造的节点" ✗
     *   （我一开始给它造了个 `#unowned`、悬停还写「1066 年无主」——
     *     用户点名的：EU4 的无主地块直接没有标记，别自己发明一套 ✓）*/
    ok('1066 层：没有为"无主"发明新节点（跟 EU4 的无主地一样留空 ✓）',
       TN.keys.indexOf('#unowned') < 0 && TN.keys.indexOf('#none') < 0,
       '查了 #unowned / #none：一个都没有 ✓');
    ok('1066 层：非封臣政权数是几百个（不是把封臣也各算一块 ✗）',
       realms.size > 100 && realms.size < 2000, `${realms.size} 个政权`);
    {
      const big = Math.max(...realms.values());
      ok('1066 层：最大的政权地盘够大（说明它整个帝国算了一块 ✓）', big >= 100,
         `最大 ${big} 个省份 · 共 ${realms.size} 个政权`);
    }
    // 留空的格子 = "别的层也没头衔的" + "那会儿没人占的" ✓
    // （这一版数据里后者是 0 ✓ 萨米、撒哈拉也各有酋长/部落 ✓）
    {
      // ⚠ 对照的那一行要**现查** ✗（剧本块里现在有两层：1066 + 空白剧本 ✓
      //   写死 `NP + p` 就撞上空白剧本那一行了 —— 那行本来就全无主 ✓）
      const _eRow = st.meta.tiers.indexOf('e');
      let refHoles = 0;
      for (let p = 1; p < NP; p++) if (st.titlemap[_eRow * NP + p] === noT) refHoles++;
      ok('1066 层：留空的格子 = 没头衔的格子 + 那会儿没人占的格子',
         holes >= refHoles,
         `1066 层 ${holes} · 帝国层 ${refHoles}`
         + (holes > refHoles ? ` → ${holes - refHoles} 块是"1066 年没人占"（留空 ✓）` : '（没有无主的地 ✓）'));
    }
    // 真有头衔的陆地，1066 那一格只许是「真头衔」或「留空」——
    // 不许出现海/湖/山的节点（那就是"把陆地当水画了" ✗）
    {
      let wrong = 0, sample2 = '';
      for (let p = 1; p < NP; p++) {
        let native = -1;
        for (let r = LAST_TIER; r >= 1; r--) {
          const v = st.titlemap[r * NP + p];
          if (v > 0 && v < realN) { native = v; break; }
        }
        if (native < 0) continue;                  // 本身就是水/山/荒地：不算 ✓
        const t = st.titlemap[p];
        if (t === noT) continue;                   // 那会儿没人占：留空 ✓
        if (t > 0 && t < realN) continue;
        wrong++;
        if (!sample2) sample2 = `#${p}: ${TN.keys[t]}`;
      }
      ok('1066 层：有头衔的陆地不会挂到海/湖/山那些伪头衔上',
         wrong === 0, wrong ? `${wrong} 格，例如 ${sample2}` : '干净');
    }
    /* **归属关系**：1066 的归属，七成上下是这块地法理链上的祖辈 ✓
     *   不满足的那部分**都是历史事实**（两条）：
     *   ① **跨法理的封君**：东亚那些行政/军镇体系最明显 ——
     *      一个县的封君压根不是它法理上的上级（中国/日本那套官制 ✓）
     *      欧洲也有：萨雷马伯爵（c_osel）在 1066 是利沃尼亚公爵的封臣，
     *      法理上却不属于它 ✓
     *   ② **同一个人手里的平级头衔**：西夏那位同时拿着 k_xia 和 k_hexi ✓
     *      国号取了 k_xia → 河西那些地的归属就成了"兄弟头衔" ✗ 不是祖辈 ✓
     *   ⚠ 所以这里卡的是一条**下限（60%）**：它要拦的是"整片张冠李戴"那种错 ✗
     *     （真解析错了会掉到很低 / 或变成"每块地都是自己"那种 ✓ 另一条断言管 ✓）
     *   ⚠ 剧本层的节点是 `1066_<原头衔 key>`（它自己一个新节点 ✓ 见 build_data 5b）——
     *     比的时候要拿**它那个原头衔**去比 ✗ 别拿节点号（那样永远不是祖辈 ✓）*/
    const upTo = (node, want2) => {
      let cur = node;
      for (let g = 0; g < 10 && cur > 0; g++) {
        if (cur === want2) return true;
        cur = TN.parents[cur];
        if (!(cur > 0)) break;
      }
      return false;
    };
    const keyIdx = new Map();
    for (let i = 0; i < TN.keys.length; i++) keyIdx.set(TN.keys[i], i);
    /** 剧本节点 → 它借的那个真头衔（key 形如 `1066_k_england` ✓）*/
    const baseOfRealm = (tid) => {
      const k = String(TN.keys[tid] || '');
      if (!k.startsWith('1066_')) return tid;
      const b = keyIdx.get(k.slice(5));
      return b === undefined ? -1 : b;
    };
    let anc = 0, tot = 0, finer = 0, sample3 = '';
    for (let p = 1; p < NP; p++) {
      const t = st.titlemap[p];
      if (!(t > 0) || t >= realN) continue;      // 无主 / 地形：不算 ✓
      let native = -1;
      for (let r = LAST_TIER; r >= 1; r--) {     // 这块地法理上最细那个真头衔
        const v = st.titlemap[r * NP + p];
        if (v > 0 && v < realN) { native = v; break; }
      }
      if (native < 0) continue;
      const base = baseOfRealm(t);               // 剧本节点 → 原头衔 ✓
      // ⚠ 有些政权的顶层是 `h_`（霸权：h_china / h_india / h_roman_empire…）——
      //   它们**不在**编辑器那五级里（tiers.json 里没有 ✗ 只参与封君链 ✓）
      //   → 这种比不了"祖辈"，从分母里去掉（不然比例会被它们拖到 70% 以下 ✓）
      if (base < 0) continue;
      tot++;
      if (base > 0 && upTo(native, base)) anc++;
      // 归属不能比这块地自己**更细**（法理链只往上走 ✓）
      const bt = base > 0 ? TN.tiers[base] : TN.tiers[t];
      if (bt > TN.tiers[native]) {
        finer++;
        if (!sample3) sample3 = `#${p}: ${TN.keys[t]} 管着 ${TN.keys[native]}`;
      }
    }
    ok('1066 层：归属的层级不比这块地自己更细（法理链只往上 ✓）',
       finer === 0, finer ? `${finer} 格，例如 ${sample3}` : '全对');
    {
      const r = tot ? anc / tot : 0;
      ok('1066 层：六成以上的归属是法理祖辈（其余是跨法理的封君 / 同一个人的平级头衔 ✓）',
         r >= 0.6, `${(r * 100).toFixed(1)}% 是祖辈（${anc}/${tot}）`);
    }
  }

  console.log('\n=== 1b. 地名字号对缩放是线性的 ===');
  {
    const L = ex.labels;
    const saved = L.scale;
    L.scale = 1;
    const a = L._fontSize(40000, 0);
    L.scale = 2;
    const b = L._fontSize(40000, 0);
    L.scale = 4;
    const c = L._fontSize(40000, 0);
    L.scale = saved;
    ok('2 倍缩放 = 2 倍字', Math.abs(b - a * 2) < 1e-9, `${a} → ${b}`);
    ok('4 倍缩放 = 4 倍字', Math.abs(c - a * 4) < 1e-9, `${a} → ${c}`);
    ok('没有上限（放得越大字越大）', c > b && b > a, `${a} / ${b} / ${c}`);
    ok('字号 = 屏幕上的边长 × 0.18',
       Math.abs(a - Math.sqrt(40000) * 0.18) < 1e-9, `√40000 × 0.18 = ${a}`);
    // 细层级（伯爵领 / 男爵领）再放大两成，而且是常数倍率，线性不受影响
    L.scale = 1;
    const big4 = L._fontSize(40000, 4);
    const big3 = L._fontSize(40000, 3);
    const big0 = L._fontSize(40000, 0);
    L.scale = 2;
    const big4b = L._fontSize(40000, 4);
    L.scale = saved;
    ok('伯爵领 / 男爵领的字号大两成',
       Math.abs(big3 - big0 * 1.2) < 1e-9 && Math.abs(big4 - big0 * 1.2) < 1e-9,
       `帝国 ${big0} / 伯爵领 ${big3} / 男爵领 ${big4}`);
    ok('放大两成之后仍然线性', Math.abs(big4b - big4 * 2) < 1e-9, `${big4} → ${big4b}`);
    // **够不着 MIN_FONT 的门槛就整个不画**（返回 0），不再硬撑成最小字号 ——
    // 以前那样缩小时密密麻麻的小国名全挤在一起。
    L.scale = 0.05;
    const tiny = L._fontSize(100, 0);
    const huge = L._fontSize(1e9, 0);
    L.scale = saved;
    ok('太小的地块返回 0（整个不画，不硬撑成最小字号）', tiny === 0, String(tiny));
    ok('够得着门槛的照常给字号', huge > 0, String(huge));
  }

  console.log('\n=== 1c. 地名每帧的开销（卡不卡就看这个）===');
  {
    const L = ex.labels;
    const view = { x: 0, y: 0, w: st.meta.mapWidth, h: st.meta.mapHeight };
    // 全图视角：视口里塞得下这一层所有标签，是最费的一帧
    const scale = 1280 / view.w;
    let tier = -1, best = -1;
    for (let t = 0; t < L.byTier.length; t++) {
      if (scale * 100 < L.zoom[t]) continue;
      if (L.byTier[t].length > best) { best = L.byTier[t].length; tier = t; }
    }
    ok('全图视角下有层级要显示标签', tier >= 0,
       `缩放 ${(scale * 100).toFixed(0)}%，门槛 ${L.zoom.join('/')}`);

    // **地名门槛得跟地块大小走** ✓ —— 细层门槛那一刻，这一层的中位地块在屏幕上
    // 至少 ~45px 宽（字号 ≈ 0.18 × 屏幕跨度 ≈ 8px 起）；地块小的图门槛自然更高。
    // 以前每个游戏写死一套数：EU5 半尺寸和原尺寸这两张尺寸差 2 倍的图用同一套 ✗
    {
      const nEra = (st.meta.eraDates || []).length;
      const nCountry = nEra > 0 ? nEra : 1;
      const real = st.meta.numRealTitles || st.meta.numTitles;
      // **跟地名字号同一个来源**（labels.js 也是 blockArea 优先）—— EU5 的 area
      // 是"成员个数"不是像素，拿它算门槛会全错 ✗
      const _areaArr = st.titles.blockArea || st.titles.area;
      const buckets = st.meta.tiers.map(() => []);
      for (let i = 0; i < st.titles.tiers.length && i < real && i < _areaArr.length; i++) {
        const t = st.titles.tiers[i];
        const a = _areaArr[i];
        if (t >= 0 && t < buckets.length && a > 0) buckets[t].push(Math.sqrt(a));
      }
      const bad = [];
      let checked = 0;
      // 门槛是不是真按 ARRIVE_SPAN 那口径算的（±30% 容差：四舍五入 + 取整到 %）
      const want = ex.ARRIVE_SPAN;
      /* 🔴 **2026-10-19：只验"省份那一层及更细"，不再验整个地理块** ✗✗
       *   以前是 `for (let t = nCountry; ...)` —— 从剧本层之后**所有层**都要
       *   "中位地块 ≈ 20px" ✓ 那时地理层只有 区域/地区/省份 三层，
       *   三层的面积差距不大，勉强都满足 ✓
       *
       *   现在加了**大洲 / 次大陆**（EU5）和**大区 / 大洲**（EU4）——
       *   一个大洲的"面积"是整片大陆（几千万像素）✓ 它的标签本来就该
       *   **在很缩的时候才出现** ✓ 拿"≈20px"去卡它必然红 ✗
       *   （实测报"大洲 42px" ✓ 不是 bug，是阈值本来就不是给它的 ✓）
       *
       *   → 只验**省份层**（最细的地理层）—— 那是"中位地块 ≈ 20px"设计的对象 ✓
       *     其它层只要求"门槛单调不减"（越细越晚出现 ✓）下面单独验 ✓ */
      let provTier = -1;
      {
        const pi = st.meta.tierNames.indexOf('省份');
        const li = st.meta.tierNames.indexOf('地点');
        provTier = li >= 0 ? li : pi;          // EU5 是「地点」，其余是「省份」
      }
      for (let t = Math.max(0, provTier); t <= Math.max(0, provTier); t++) {
        const arr = buckets[t].sort((x, y) => x - y);
        if (!arr.length) continue;
        checked++;
        const screen = arr[arr.length >> 1] * L.zoom[t] / 100;
        if (!(screen >= want * 0.7 && screen <= want * 1.4)) {
          bad.push(`${st.meta.tierNames[t]} ${screen.toFixed(0)}px`);
        }
      }
      /* 新加的一条：**地理层门槛单调不减**（越细的层越晚出现 ✓）
       *   ⚠ 剧本层那段（12 / 18）不参与 —— 它们按"一进去就看见国名"定的 ✓ */
      {
        const geo = [];
        for (let t = nCountry; t < L.zoom.length; t++) geo.push([st.meta.tierNames[t], L.zoom[t]]);
        const mono = geo.every((v, i) => i === 0 || v[1] >= geo[i - 1][1]);
        ok('地理层门槛单调不减（大洲最早出现、省份最晚 ✓）', mono,
           geo.map((v) => `${v[0]}=${v[1]}`).join(' '));
      }
      ok(`细层门槛按地块大小算：到门槛时中位地块 ≈ ${want}px（±30%）`,
         bad.length === 0, bad.length ? bad.join(' / ') : `查了 ${checked} 层，都对得上`);
      const fitPct = 1280 / st.meta.mapWidth * 100;
      ok('国名层门槛不高于全图视角（缩到全图就该看见国名）',
         L.zoom[0] <= fitPct, `门槛 ${L.zoom[0]}% vs 全图 ${fitPct.toFixed(1)}%`);
    }

    // 冷帧：贴图缓存清空，等于"没有贴图缓存"的开销
    L.sprites.clear();
    resetCanvasStats();
    L.draw(view, tier, null);
    const cold = { ...canvasStats };
    const drawn = L.drawn;

    // 热帧：贴图都在，也就是平移时的常态
    resetCanvasStats();
    L.draw(view, tier, null);
    const warm = { ...canvasStats };

    // 取消保底之后，小地块的地名不画了，所以这一帧的标签数比从前少很多 ——
    // 剩下的也够跑这次基准（字号分桶、measure 缓存这些还是要验）
    ok('这一帧有标签可测', drawn >= 2, `${drawn} 个标签`);
    ok('热帧改 font 的次数 = 字号桶数，不是标签数',
       warm.font > 0 && warm.font <= 40 && warm.font <= drawn,
       `font ${warm.font} 次，标签 ${drawn} 个`);
    ok('热帧一次 measureText 都不做（量宽缓存命中）', warm.measure === 0,
       `measure ${warm.measure} 次（旧写法要 ${drawn} 次）`);
    ok('热帧不再现场栅格化文字，全走贴图',
       warm.stroke === 0 && warm.fill === 0 && warm.image === drawn,
       `stroke ${warm.stroke} / fill ${warm.fill} / drawImage ${warm.image} `
       + `（旧写法每帧 stroke+fill 各 ${drawn} 次）`);
    ok('冷帧确实栅格化了一遍（贴图就是省下的这一步）',
       cold.stroke > drawn * 0.9 && cold.stroke === cold.fill,
       `stroke ${cold.stroke} / fill ${cold.fill}（${drawn} 个标签，`
       + `同名同字号同色的会共用一张贴图）`);
    ok('每帧只读两三次视口尺寸（在循环里读会逼同步重排）',
       warm.clientW <= 3 && warm.clientH <= 2,
       `clientWidth ${warm.clientW} 次 / clientHeight ${warm.clientH} 次（旧写法各 ${drawn} 次）`);
  }

  // ⚠ EU4 的 `want` 已经没有 `names` 了（剧本数跟 bookmarks 走 ✓ 见上面那段）
  //   这一句只是打印，直接从数据取 ✓ 别依赖写死的表 ✗
  console.log(`\n=== 2. 悬停一条链条（${(want.names || st.meta.tierNames).join(' → ')}）===`);
  const W = st.meta.mapWidth;
  const ids = st.provinceIds;
  // HOI4 的 1 号省份是个湖（锁住的，链条里没东西），换科西嘉那个省来验
  // EU5 的地块号是按名字排的，1 号在图上是空的 —— 挑一个**有像素、又有名字**的
  const probeEu5 = (() => {
    for (let q = 1; q < st.meta.numProvinces; q++) {
      const t5 = ex.titleAt(q, 5);
      if (t5 !== 65535 && T.names[t5]) return q;
    }
    return 1;
  })();
  const probe = isHoi4 ? 3838 : isEu5 ? probeEu5 : 1;
  let pix = -1;
  for (let p = 0; p < ids.length; p++) if (ids[p] === probe) { pix = p; break; }
  ok(`省份图里能找到地块 ${probe}`, pix >= 0, `偏移 ${pix}`);
  const px = pix % W, py = Math.floor(pix / W);
  st.hover.pid = probe;
  st.hover.tids = Array.from({ length: st.meta.tierNames.length },
                          (_, i) => ex.titleAt(probe, i));   // 层数写成活的
  ex.renderHoverCard(probe);
  const chain = get('hover-chain').flat();
  console.log('    链条：', chain.replace(/\s+/g, ' ').slice(0, 220));
  // 剧本级（年份那几层）已按用户要求**不在悬停面板里列** ✓
  // → 期待里去掉剧本层的国家名（瑞典/法国/哥伦比亚），只留剧本下面那几层 ✓
  const wants = isEU4 ? ['东斯韦阿兰', '斯德哥尔摩']
              : isHoi4 ? ['第勒尼安海', '科西嘉', '阿雅克肖']
              : isVic3 ? ['瓜维亚雷']
              : isEu5 ? []          // 地名不写死：EU5 那 2.8 万个地块名字没法预设
              : ['e_', 'k_', 'd_', 'c_', 'b_'];
  for (const w of wants) ok(`链条里有 ${w}`, chain.includes(w));
  ok('链条徽章用的是本作的层级写法（剧本那几层已不列，只查下面几层）',
     isEU4 ? /省/.test(chain)
     : isHoi4 ? /省/.test(chain)
     : isVic3 ? /省/.test(chain)
     : isEu5 ? /地点/.test(chain)
     : (chain.includes('e_') && chain.includes('b_')));
  ok(`这个像素确实落在地块 ${probe} 上`, ids[py * W + px] === probe);

  if (isEU4) {
    console.log('\n=== 2c. 剧本层 + 地理层（层级可配，不写死层号）===');
    /* 🔴🔴 **2026-10-19 整段重写：不再写死"3 个年份 / 7 层 / 层号 0,1,2"** ✗✗
     *
     *   以前这里断言的是 `[1444, 1618, 1789, 空白剧本, 区域, 地区, 省份]` ✓
     *   可 2026-10-19 之后：
     *     · bookmarks **全部读进来**（原版 1.37 就有 12 个，不是 3 个 ✓）
     *     · 地理层加上了**大洲 / 大区**（用户点名要的 ✓）
     *   → 写死层号的断言全废 ✓ 现在一律**按年份标签 / 层名去找** ✓
     *     数据怎么变，这几条都不会假红 ✓
     */
    const names = st.meta.tierNames || [];
    const tiers = st.meta.tiers || [];
    // 年份标签 → 层号（`tiers` 里剧本层的值就是年份字符串 ✓）
    const atYear = (y) => tiers.indexOf(String(y));
    const hasYear = (y) => atYear(y) >= 0;
    const nm = (pid, y) => {
      const i = atYear(y);
      return i < 0 ? '(没有这一层)' : st.titles.names[ex.titleAt(pid, i)];
    };

    ok('剧本层不止 3 个（bookmarks 全读进来了）',
       (st.meta.eraDates || []).length > 4,
       `${(st.meta.eraDates || []).length} 个：${(st.meta.eraDates || []).join(' ')}`);
    ok('地理层里带上了大洲和大区（用户点名要的 ✓）',
       /大洲/.test(names.join('')) && /大区/.test(names.join('')),
       names.join('/'));
    ok('空白剧本还在（照抄海域 / 荒地那一层 ✓）',
       /空白剧本/.test(names.join('')), names.join('/'));

    /* 历史抽查：**按年份找层**，不按层号 ✗ —— 剧本加了多少个都不影响 ✓ */
    if (hasYear(1444) && hasYear(1618) && hasYear(1789)) {
      ok('斯德哥尔摩三个年份都是瑞典',
         nm(1, 1444) === '瑞典' && nm(1, 1618) === '瑞典' && nm(1, 1789) === '瑞典',
         `${nm(1, 1444)}/${nm(1, 1618)}/${nm(1, 1789)}`);
      ok('君士坦丁堡 1444 拜占庭，1618 起奥斯曼',
         nm(151, 1444) === '拜占庭' && nm(151, 1618) === '奥斯曼',
         `${nm(151, 1444)}/${nm(151, 1618)}`);
      ok('伦敦 1789 属于大不列颠', nm(236, 1789).indexOf('大不列颠') >= 0, nm(236, 1789));
    } else {
      console.log('  · 跳过历史抽查（这张图没有 1444/1618/1789 那三层）');
    }
    /* **剧本越多，中间过渡越清楚** ✓（这正是加剧本的意义所在）
     *   耶姆特兰：挪威 → 丹麦 → 瑞典 ✓
     *   ⚠ 但剧本**少**的图（比如 mod 只留 7 个）不一定有三段完整过渡 ✗
     *     所以只断言"如果有 1579 那层，那时该是丹麦"——
     *     按实际存在的层查，不做全链断言 ✓ */
    if (hasYear(1444)) {
      ok('耶姆特兰 1444 是挪威', nm(10, 1444) === '挪威', nm(10, 1444));
    }
    if (hasYear(1579)) {
      ok('耶姆特兰 1579 是丹麦（剧本多了才看得到的过渡 ✓）',
         nm(10, 1579) === '丹麦', nm(10, 1579));
    }
    if (hasYear(1701)) {
      ok('耶姆特兰 1701 是瑞典',
         nm(10, 1701) === '瑞典', nm(10, 1701));
    }
    ok('同一个国家在不同年份是各自独立的节点（否则涂一处会连带另一处）',
       (() => {
         const a0 = atYear(1444), a1 = atYear(1618);
         if (a0 < 0 || a1 < 0) return true;      // 没有这两年就不验 ✓
         return ex.titleAt(1, a0) !== ex.titleAt(1, a1);
       })());
    ok('第一个剧本层有不少国家节点（不是空的）',
       (() => {
         const c = st.titles.tiers.filter((x) => x === ERA0).length;
         return c > 50;
       })(),
       String(st.titles.tiers.filter((x) => x === ERA0).length));

    console.log('\n=== 2d. 标注位置一律几何中心 ===');
    {
      const pos = st.provPos;      // 每 3 个 float：质心 x、质心 y、像素数
      // 省份层下标各游戏不一样（EU4 是 5、HOI4 是 4）—— 按 p_ 前缀认，
      // 写死 4 的话 EU4 下选到的是地区层，整条断言空转
      let provTier = -1;
      for (let i2 = 0; i2 < T.keys.length; i2++) {
        if (T.keys[i2].startsWith('p_')) { provTier = T.tiers[i2]; break; }
      }
      let off = 0, n = 0;
      for (let i = 0; i < T.keys.length; i++) {
        if (T.tiers[i] !== provTier) continue;
        const pid = Number(T.keys[i].slice(2));
        n++;
        if (Math.abs(T.lx[i] - pos[pid * 3]) > 0.51 ||
            Math.abs(T.ly[i] - pos[pid * 3 + 1]) > 0.51) off++;
      }
      ok('省份层的标注点就是那个省的像素重心', off === 0,
         `查了 ${n} 个，偏的 ${off} 个`);

      // 每个真节点的标注点，必须等于"它自己那堆省份里像素最多的连通块"的重心。
      // 这里拿前端的邻接表和质心**自己重算一遍**，跟生成出来的比 ——
      // 法国本土加一个千里外的小岛时，重心会掉进大西洋，这条能抓住。
      const np = st.meta.numProvinces;
      const adj = st.adjacency;
      const co = new Uint32Array(adj.buffer, adj.byteOffset, np + 1);
      const cn = new Uint16Array(adj.buffer, adj.byteOffset + (np + 1) * 4);
      const tm = st.titlemap;
      const mem = new Map();
      for (let t = 0; t < st.meta.tiers.length; t++) {
        const row = t * np;
        for (let pid = 1; pid < np; pid++) {
          const tid = tm[row + pid];
          if (tid === 65535 || tid >= st.meta.numRealTitles) continue;
          let a = mem.get(tid);
          if (!a) { a = []; mem.set(tid, a); }
          a.push(pid);
        }
      }
      let wrong = 0;
      const worst = [];
      for (const [tid, pids] of mem) {
        const set = new Set(pids);
        const par = new Map();
        for (const p of pids) par.set(p, p);
        const find = (x) => {
          let r = x;
          while (par.get(r) !== r) r = par.get(r);
          while (par.get(x) !== r) { const nx = par.get(x); par.set(x, r); x = nx; }
          return r;
        };
        for (const p of pids) {
          for (let k = co[p], e = co[p + 1]; k < e; k++) {
            const q = cn[k];
            if (!set.has(q)) continue;
            const ra = find(p), rb = find(q);
            if (ra !== rb) par.set(ra, rb);
          }
        }
        const groups = new Map();
        for (const p of pids) {
          const r = find(p);
          let g = groups.get(r);
          if (!g) { g = [0, 0, 0]; groups.set(r, g); }
          const w = pos[p * 3 + 2] || 1;
          g[0] += pos[p * 3] * w; g[1] += pos[p * 3 + 1] * w; g[2] += w;
        }
        let best = null;
        for (const g of groups.values()) if (!best || g[2] > best[2]) best = g;
        const bx = best[0] / best[2], by = best[1] / best[2];
        // **有首都的节点**：位置该按"首都所在那一片"算（用户定规矩 ✓）
        // 所以先把它那一片的重心也算出来，命中任一个都算对 ✓
        let cx2 = bx, cy2 = by;
        const cap = (st.meta.capitals || {})[(T.keys[tid] || '').split('_').slice(1).join('_')];
        if (cap && set.has(cap)) {
          const r0 = find(cap);
          const g0 = groups.get(r0);
          if (g0 && g0[2] > 0) { cx2 = g0[0] / g0[2]; cy2 = g0[1] / g0[2]; }
        }
        // 规则②：首都自己没了 → 从首都**一圈圈向外**找到的那一片（环扩张）
        let okC = false;
        if (cap && !set.has(cap)) {
          const seen2 = new Set([cap]);
          let frontier = [cap], hit = 0;
          for (let ring = 0; ring < 12 && !hit; ring++) {
            const next = [];
            for (const q of frontier) {
              for (let k = co[q], e = co[q + 1]; k < e; k++) {
                const r = cn[k];
                if (r <= 0 || seen2.has(r)) continue;
                seen2.add(r);
                next.push(r);
                if (set.has(r)) { hit = r; break; }
              }
              if (hit) break;
            }
            frontier = next;
            if (!frontier.length) break;
          }
          if (hit) {
            const g3 = groups.get(find(hit));
            if (g3 && g3[2] > 0) {
              const cx3 = g3[0] / g3[2], cy3 = g3[1] / g3[2];
              okC = Math.abs(T.lx[tid] - cx3) <= 0.6 && Math.abs(T.ly[tid] - cy3) <= 0.6;
            }
          }
        }
        const okA = Math.abs(T.lx[tid] - bx) <= 0.6 && Math.abs(T.ly[tid] - by) <= 0.6;
        const okB = Math.abs(T.lx[tid] - cx2) <= 0.6 && Math.abs(T.ly[tid] - cy2) <= 0.6;
        if (!okA && !okB && !okC) {
          wrong++;
          if (worst.length < 4) worst.push(`${T.keys[tid]}(${T.names[tid]})`);
        }
      }
      ok('标注点 = 那一块地的重心（含首都那片／挨着首都那片／最大片 ✓）', wrong === 0,
         `查了 ${mem.size} 个节点，偏的 ${wrong} 个 ${worst.join(' ')}`);

      // 拿一个真的跨洋国家验一遍"重心会掉海里"这件事
      const spain = T.keys.indexOf('1618_SPA');
      if (spain >= 0) {
        const pids = mem.get(spain) || [];
        let sx = 0, sy = 0, sw = 0;
        for (const p of pids) { const w = pos[p * 3 + 2] || 1; sx += pos[p * 3] * w; sy += pos[p * 3 + 1] * w; sw += w; }
        const allX = sx / sw, allY = sy / sw;
        const moved = Math.hypot(T.lx[spain] - allX, T.ly[spain] - allY);
        ok('1618 西班牙：标注点故意偏离全体重心（不然会落在大西洋）', moved > 50,
           `偏了 ${moved.toFixed(0)} px，全体重心 (${allX.toFixed(0)},${allY.toFixed(0)}) → 标注 (${T.lx[spain]},${T.ly[spain]})`);
      }
    }
  }

  console.log('\n=== 2a. 作者署名（顶栏那个按钮 / 启动页那行）===');
  {
    // 链接地址从 app.js 里读出来（只有一处 AUTHOR ✓）
    const ajs = require('fs').readFileSync('web/js/app.js', 'utf8');
    const am = /const AUTHOR = \{[\s\S]{0,260}?url:\s*'([^']+)'/.exec(ajs);
    const aurl = am ? am[1] : '';
    // **实测**：页面一加载（不用等地图烘完）两个入口的 href 就该填好 ✓
    const linkEl = get('author-link'), btnEl = get('btn-author');
    ok('两个署名入口的 href 都填好了（点一下真能跳）✓',
       !!aurl && linkEl.href === aurl && btnEl.href === aurl,
       `author-link=${linkEl.href || '(空)'} / btn-author=${btnEl.href || '(空)'}`);
    ok('两处都是新标签页打开（不会把编辑器顶掉）✓',
       linkEl.target === '_blank' && btnEl.target === '_blank',
       `target=${linkEl.target || '(空)'} / ${btnEl.target || '(空)'}`);
    // 「当前颜色」的色块：boot 跑完（bindEvents 挂上）就该有 onclick ✓
    ok('色块点得动（onclick 已经挂上了）✓',
       typeof get('brush-swatch').onclick === 'function',
       typeof get('brush-swatch').onclick === 'function' ? 'ok' : 'onclick 没挂上 ✗');
  }

  // 导出图例：条目从涂色分组来 ✓、能画到导出画布上 ✓、设置页那一列刷得出来 ✓
  {
    ok('图例三个函数都挂上了 ✓',
       typeof ex.legendEntries === 'function' && typeof ex.drawLegend === 'function'
       && typeof ex.rebuildLegendPanel === 'function', typeof ex.legendEntries);
    const ents = typeof ex.legendEntries === 'function' ? ex.legendEntries() : [];
    const keys = new Set(ents.map((e) => (e.rgb || []).join(',')));
    ok('图例条目是**按颜色分组**的（同色只算一条 ✓）', ents.length === keys.size,
       `${ents.length} 条 / 去重 ${keys.size} 条`);
    // 用户定的两条：只列**图上涂出来的**颜色 ✓ 并按**涂出来的大小**排序 ✓
    const anyP = ents.some((e) => (e.painted || 0) > 0);
    ok('图例只列图上涂出来的颜色（没涂过的原版底色不进图例 ✓）',
       !anyP || ents.every((e) => (e.painted || 0) > 0),
       anyP ? `${ents.length} 条全部有涂色 ✓` : '（还没涂过色 → 走「全年份国家」兜底 ✓）');
    ok('图例按大小从大到小排序 ✓',
       ents.every((e, i) => i === 0 || (ents[i - 1].size || 0) >= (e.size || 0)),
       ents.slice(0, 3).map((e) => `${e.name}:${e.size | 0}`).join(' / ') || '（空）');
    resetCanvasStats();
    const cv = get('overlay');
    const n = typeof ex.drawLegend === 'function'
      ? ex.drawLegend(cv.getContext('2d'), 1200, 800) : 0;
    ok('能把图例画到导出画布上 ✓', n === 0 || (canvasStats.fill + canvasStats.measure + canvasStats.stroke) > 0,
       `画了 ${n} 条，画布 fill=${canvasStats.fill} measure=${canvasStats.measure} stroke=${canvasStats.stroke}`);
    let listsOk = true;
    try { ex.rebuildLegendPanel(); } catch (e) { listsOk = false; }
    ok('设置页里的图例列表刷得出来（不抛错 ✓）', listsOk,
       `列表内容长度 ${(get('legend-list').innerHTML || '').length}`);
    // 位置参数四个角落都得能算（不能因为角落算成负数就画到图外 ✗）
    let cornerOk = true;
    for (const pos of ['tl', 'tr', 'bl', 'br']) {
      st.set = st.set || {};
      st.set.legend = true; st.set.legendPos = pos; st.set.legendTitle = '测试标题';
      try { ex.drawLegend(cv.getContext('2d'), 1200, 800); } catch (e) { cornerOk = false; }
    }
    st.set.legend = false;
    ok('四个角都能画（左上/右上/左下/右下，不会越界崩 ✓）', cornerOk, 'tl/tr/bl/br');
  }

  // 新手引导：**就在编辑器里**（不另开页面 ✓），所以它得能被单文件版打包器收进去 ✓
  {
    const fs = require('fs');
    const tut = fs.existsSync('web/js/tutorial.js') ? fs.readFileSync('web/js/tutorial.js', 'utf8') : '';
    ok('引导模块在（web/js/tutorial.js）✓', tut.length > 500, `${tut.length} 字节`);
    ok('引导是普通脚本（不能用 import/export ✗ —— 打包器是直接拼文件的）✓',
       tut.length > 0 && !/^\s*(import|export)\b/m.test(tut), '无 import/export');
    const appSrc = fs.readFileSync('web/js/app.js', 'utf8');
    ok('app 里挂了初始化（window.initTutorial）✓', appSrc.includes('window.initTutorial'));
    const htmlSrc = fs.readFileSync('web/index.html', 'utf8');
    ok('顶栏有「教程」按钮 ✓', htmlSrc.includes('id="btn-tutorial"'), 'btn-tutorial');
    /* 🔴 **教程内容要跟上界面** ✗✗（2026-10-20 ✓ 用户："教程过时不知道多久了"）
     *
     *   教程最容易腐烂：文案里写的按钮名/位置，界面一改就变成**教错** ✗
     *   而且它不影响任何功能，坏了没人报 ✓ 所以只能靠断言钉住 ✓
     *   这里钉两件事：
     *     ① 该讲的**新东西**讲了（剧本下拉 / 地理层级 / 撤销 / 搜索）
     *     ② **过时的说法**不许留（「导出 ▾」这个名字 2026-10 改成了「文件 ▾」✗）*/
    {
      const need = [
        ['剧本', /剧本/],
        ['地理层级（大洲/区域/省份）', /大洲[\s\S]{0,80}省份|区域[\s\S]{0,40}省份/],
        ['撤销', /撤销|Ctrl\+Z/],
        ['搜索', /搜索/],
        ['「文件 ▾」这个新名字', /文件 ▾/],
      ];
      const miss = need.filter(([, re]) => !re.test(tut)).map(([n]) => n);
      ok('桌面教程覆盖了 v1.10 的新界面（剧本 / 层级 / 撤销 / 搜索 / 文件 ▾）',
         miss.length === 0, miss.length ? `缺：${miss.join('、')}` : '都讲了 ✓');
      /* ⚠ 剥掉注释再判 ✗ —— 注释里会提到「导出 ▾」这个旧名（说明改名历史 ✓）
       *   不剥的话永远红 ✓（跟"没开剧本写无"那条一个坑 ✓）*/
      const tutCode = tut
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      ok('桌面教程不再喊「导出 ▾」这个旧名（现在叫「文件 ▾」✗）',
         tutCode.indexOf('导出 ▾') < 0);
      /* 步骤数：老版 8 步，重写后 11 步 ✓ 太少说明又被砍回去了
       * ⚠ 缩进是 8 个空格 ✓ 写死 6 个会数出 0 步（我第一次就数成 0 ✓）*/
      const nStep = (tutCode.match(/^\s{6,}title: '/gm) || []).length;
      ok('桌面教程步骤数 ≥ 10（老版 8 步，v1.10 加了层级/剧本/撤销/搜索 ✓）',
         nStep >= 10, `${nStep} 步`);
      /* 剧本那一步的文案是**函数**（下拉 / 按钮两套说法 ✓）—— 写死一种就会教错 */
      ok('「挑个剧本」的文案按界面分流（下拉 vs 按钮两套 ✓）',
         /typeof st\.text === 'function'/.test(tut) && /hasEraDropdown\(\)/.test(tut));
      /* 🔴 **统一叫「势力名」，不许写「国名」** ✗✗（2026-10-20 ✓ 用户原话：
       *   "国名就是势力名，统一用势力名这个称呼"）
       *   界面上早就是「势力名称」了（见 index.html 那段注释 ✓）——
       *   只有教程里还混着"国名、势力名"并列着写 ✓ 看着像两种东西 ✓
       *   ⚠ 剥注释再判 ✓ 注释里讲历史会提到「国名」✓ */
      ok('桌面教程统一用「势力名」（不写「国名」✗）',
         tutCode.indexOf('国名') < 0,
         tutCode.indexOf('国名') < 0 ? '干净 ✓' : '仍有「国名」字样 ✗');
      /* 🔴 **教程文案不许用破折号** ✗✗（2026-10-20 ✓ 用户："不要破折号"）
       *   破折号在这类一句一卡的卡片里会把句子**拦腰截断** ✓ 读着费劲 ✓
       *   改成逗号 / 句号，一句话说完再下一句 ✓
       *   ⚠ 只查**用户看得到的字符串**（`text:` 那些）✗ 注释里随便 ✗ */
      {
        const texts = [...tutCode.matchAll(/text:\s*'([^']*)'/g)].map((m) => m[1]);
        const bad = texts.filter((s) => s.indexOf('——') >= 0);
        ok('教程卡片文案里没有破折号（读着更顺 ✓）', bad.length === 0,
           bad.length ? bad[0].slice(0, 40) : `查了 ${texts.length} 句 ✓`);
      }
      /* 🔴 **语气要萌，但不许过分口语化** ✗✗（2026-10-20 ✓ 用户：
       *   "保证有二次元的萌感，同时避免单字词和过分口语化"）
       *
       *   萌感靠的是**语气词**（哦 / 呢 / 啦 / 呀）和可爱的比喻（乖乖、悄悄、清清爽爽 ✓）
       *   不是靠拖长音和网络口语 ✗ 下面这几个都是老版里被换掉的：
       *     波浪号「~」（拖长音，看着像卖萌过度 ✓）
       *     滚滚 / 溜进 / 折腾（太随意，跟界面气质不搭 ✓）
       *   ⚠ 这条只看**卡片文案**，不看注释 ✓ */
      {
        const texts = [...tutCode.matchAll(/text:\s*'([^']*)'/g)].map((m) => m[1])
          .concat([...tutCode.matchAll(/\+\s*'([^']*)'/g)].map((m) => m[1]));
        const slang = ['~', '嘛', '滚滚', '溜进', '折腾'];
        const hit = [];
        for (const s of texts) for (const w of slang) if (s.indexOf(w) >= 0) hit.push(`${w} @ ${s.slice(0, 24)}`);
        ok('教程文案没有过度口语化的词（波浪号 / 滚滚 / 溜进 / 折腾 ✗）',
           hit.length === 0, hit.length ? hit[0] : `查了 ${texts.length} 段 ✓`);
        /* 萌感得还在：语气词至少出现几次（不然就成了冷冰冰的说明书 ✗） */
        const cuteN = texts.reduce((n, s) => n + (s.match(/哦|呢|啦|呀|吧/g) || []).length, 0);
        ok('教程还留着萌感（语气词够数 ✓）', cuteN >= 6, `${cuteN} 个语气词`);
      }
    }
    /* **"是不是水"必须精确匹配颜色** ✓（用户报的 HOI4 三个省份 ✓）
     *   以前阈值 0.02 ✗ —— HOI4 的省份色是技术色，`p_3511` 那类跟 #lake 只差
     *   0.0147~0.0184，全被判成湖水、边界走了水域那一趟 ✗
     *   真水的 LUT 色跟 uSeaCol/uLakeCol 是同一份数据 → 距离 0 ✓ 阈值 0.004 足够 ✓ */
    /* **地名跟着粒度走** ✓（用户定的：选成地区 / 州 / 战略区时，地名也得出来 ✓）
     *   以前剧本视图下只放行"最细的两层"✗ → 粒度选"地区"就一个地名都没有 ✓（用户报的 ✓）
     *   但**剧本层本身不算地名** ✗（那是国家/势力，归势力名那套管 ✓）*/
    ok('地名层 = 当前粒度层（不再只放行最细两层 ✗）',
       /* ⚠ **判据要跟着实现走** ✗✗ —— 这条老账盯的是两轮前的写法
        *   （`const nameTier = isCountryView ? _et : viewTier;` 那个 `_et` 中间变量 ✓
        *    早被 `editTier()` 直接替掉了 ✗）→ 一直红着 ✓
        *   现在按**真实现**量三件事 ✓：
        *     ① `nameTier` 在剧本视图取**编辑层（粒度）**、地理视图取视图层 ✓
        *     ② 别再把门槛写死成 `nameTier >= 0`（那等于"哪层都放行"✗）✓
        *     ③ 外闸是「地块·名称 **或** 水域·名称 **或** 荒地·名称」✓
        *        （水名 / 荒名两个独立闸 ✓ 见 handover §3.1 ✓
        *          ⚠ 2026-10-17 起荒地也有自己的名称开关了，外闸必须把它算进来 ✓
        *            不然"只勾荒地名"时整段都不跑 = 那根开关是死的 ✓）*/
       (function () {
         const s = fs.readFileSync('web/js/app.js', 'utf8');
         return /const nameTier = isCountryView \? editTier\(\) : viewTier;/.test(s)
           && !/nameTier >= 0/.test(s)
           && /if \(\(state\.showLabelsTitle \|\| state\.showWaterName \|\| state\.showWasteName\)/
             .test(s);
       })());
    /* **水岸线跟填色那趟合并成一次扫描** ✓（用户要求"合并那几趟射线"✓）
     *   以前水岸线单独一趟（`rayDistWater` × 4 方向 ✗），而它判的"这一侧是不是水"
     *   填色那趟的 `_terrainSeam` 本来就在判 ✗ —— 同一件事每帧算两遍 ✓
     *   现在 `rayDistPaint` 一次吐三个距离（.x 填色、.y 水岸线、.z 荒地边 ✓）→ 四趟变两趟 ✓ */
    /* **三条线（填色 / 水岸线 / 荒地边）现在都由掩码一趟给全** ✓
     *   老路径那套（`rayDistPaint` 吐 vec3 + `_w0.._w3`）已经没有调用点了 ✓ */
    /* **三条线各走各的那一趟** ✓
     *   老版本这里是"合并成一趟"（`rayDistPaint` 一次吐 vec3 三个距离 ⚠️）——
     *   2026-10-16/17 又**拆回去了** ✗：用户给水域 / 荒地各要了一条**独立开关**
     *   （"水域边界负责且仅负责水域之间的边界"✓"给荒地也加一条"✓），
     *   两条各自有粗细 / 浓度 / 开与关 → 各成一趟才管得清 ✓
     *   ⚠ 所以这条现在钉的是**新不变量**（别再拿"合并那趟"去要求它 ✗）：
     *     · 三趟都在，而且**每一趟都有自己的 MAXR 硬上界**
     *       （防手机驱动把"上界不是常量"的循环判成不合规 → 编译不过 ✓）
     *     · 水 / 荒地那两趟的判据 = **对面是水（荒地）** ✚ **头衔不同** ✓
     *       （缺后半句 = 一整片荒地内部每格都画线 → 密密麻麻网格 ✓ 用户报过 ✓）*/
    {
      const _g = fs.readFileSync('web/js/gl.js', 'utf8');
      const _fn = (name) => {
        const s = _g.indexOf('float ' + name + '(ivec2 ip');
        if (s < 0) return '';
        let d = 0, out = [], started = false;
        for (let i = s; i < _g.length; i++) {
          const ch = _g[i];
          out.push(ch);
          if (ch === '{') { d++; started = true; }
          else if (ch === '}') { d--; if (started && d === 0) break; }
        }
        return out.join('');
      };
      const rp = _fn('rayDistPaint'), rw = _fn('rayDistWater'), rq = _fn('rayDistWaste');
      const hasBound = (s) => /for \(int k = 1; k <= MAXR; k\+\+\)/.test(s) && /if \(_d > R\) break;/.test(s);
      ok('填色 / 水 / 荒地三条线各一趟，且每趟都有 MAXR 硬上界',
         !!rp && !!rw && !!rq && hasBound(rp) && hasBound(rw) && hasBound(rq),
         'paint/water/waste=' + [!!rp, !!rw, !!rq].join('/')
         + ' · 上界=' + [hasBound(rp), hasBound(rw), hasBound(rq)].join('/'));
      ok('水 / 荒地那两趟的判据 = 对面是它 **且** 两侧头衔不同（少一个就变密密麻麻网格 ✗）',
         /if \(!waterIs\(q\)\) continue;/.test(rw)
         && /titleAt\(pidAt\(q\), uEditTier\) != t/.test(rw)
         && /if \(!wasteIs\(q\)\) continue;/.test(rq)
         && /titleAt\(pidAt\(q\), uEditTier\) != t/.test(rq),
         'water=' + /if \(!waterIs\(q\)\) continue;/.test(rw)
         + ' waste=' + /if \(!wasteIs\(q\)\) continue;/.test(rq));
    }
    /* **荒地身份必须按"编辑层"取** ✗（用户报的"不可通行区变成密密麻麻网格"就是它 ✓）
     *   `cellViewOf` / 那两趟射线里取的都必须是 `uEditTier` ✓
     *   ⚠ 2026-10-17 起身份判据收进了 `wasteIs()` / `waterIs()` 两个助手 ✗ ——
     *     所以下一条钉的是"**这两个助手自己**取的是 uEditTier" ✓
     *     （别在别处又写一份 `kindOf == 6` ✗ 判据只许有一处 ✓）*/
    ok('荒地身份按 uEditTier 取（不是 uTier ✗ —— 会让不可通行区变网格）',
       /* ⚠ 2026-10-19：取数从 `texelFetch(uKindTex…)` 换成了 `u8At(uKindTex…)` ✗
        *   —— 整数纹理退役、R8 归一化解码（见 gl.js 的 u8At ✓）
        *   这条钉的是**"读的是身份标、而且那格取的是编辑层"**，不是取数写法 ✓ */
       /bool wasteIs\(ivec2 q\)[\s\S]{0,400}u8At\(uKindTex/.test(fs.readFileSync('web/js/gl.js', 'utf8'))
       && /v\.tid = titleAt\(v\.pid, uEditTier\)/.test(fs.readFileSync('web/js/gl.js', 'utf8'))
       && !/v\.waste = wasteAlphaOf\(titleAt\(pidAt\(ip\), uTier\)\)/.test(fs.readFileSync('web/js/gl.js', 'utf8')));
    /* **GLSL 里的声明/定义不许重复** ✗（我脚本化改代码时插了两遍 → 编译失败 → 白屏 ✓ 踩过 ✓）
     *   JS 语法检查抓不到（都在模板字符串里 ✗）、桩也不真编译 GLSL ✗ 所以只能数出现次数 ✓ */
    {
      const _g = fs.readFileSync('web/js/gl.js', 'utf8');
      const _cnt = (pat) => (_g.match(new RegExp(pat, 'g')) || []).length;
      const _dupes = [];
      for (const pat of ['bool viewsDiffer\\(', 'CellView cellViewOf\\(']) {
        if (_cnt(pat) !== 1) _dupes.push(pat + '×' + _cnt(pat));
      }
      ok('GLSL 声明 / 定义不重复（重复 = 编译失败 = 白屏 ✗）',
         _dupes.length === 0, _dupes.length ? _dupes.join(' · ') : '都只有一份 ✓');
    }
    /* **开图那次的层号兜底** ✗（用户报的"边界全没了"根因之一 ✓）
     *   boot 早期 `state.tier` 是 **-1** ✗ 而我第一版兜底写成 `state.tier || 0` ✓
     *   —— **-1 是 truthy**，`|| 0` 拦不住 → `tm[-1*n+p]` 负索引 → 身份全空 → 掩码一片 0 ✓
     * ⚠ 而且 boot 里只该有**一次** true 调用 ✗（收尾那次 ✓）
     *   早期那次层号还是 -1、算出来是空的，而距离场一张 44MB、算一遍近一秒 ✓
     *   多算一次就是白跑（实测 EU4 那张白跑了两遍 ✓）*/
    /* 🔴 **防抖待办不许被每帧取消**（用户报"边界全画成 1444 剧本的"就是这个 ✓）
     *   `syncParentBorder` 是**每帧**跑的 ✗ 而 `clearTimeout` 原来写在函数最上面 ✓
     *   → 第二帧就把第一帧排的那次重算取消掉，紧接着又因"签名已记过"直接 return ✓
     *   → **重算永远不执行**，掩码一直停在 boot 那次（那时 state.tier 还是 -1 → 兜底成 0 = 1444）✓
     *   现在：先查签名，只在**真要重算**时才 clearTimeout ✓ */
    /* **多级链也进掩码了**（用户点破的：多级边界没有新增边界 ✓ 它画的就是"某一层的头衔缝"✓）
     *   实测过"能不能只记一个层号"✗：地理层内部嵌套（区域⊆地区⊆省份 ✓）
     *   但**剧本层是三套互不包含的国界**（1444/1618/1789 ✓）→ 只能逐层存位 ✓
     *   32 位刚好塞满：0-3 填色 · 4-7 水 · 8-11 荒地 · 12-15 本层 · 16-31 链上四环 ✓
     *   ⚠ 第 7 组落在 2^31 那位 ✗ 而 JS 位运算是 32 位**带符号**的（8<<28 会变负 ✓）
     *     → CPU 侧必须用**加法**写进去 ✓ */
    /* **恢复默认要当场落盘**（用户报：点了恢复默认、刷新之后还是改过的值 ✓）
     *   原来只重置内存（state.set）没写盘 → 存的那份还是改过的值 → 刷新又被读回来 ✓
     *   ⚠ 也不能只用 scheduleSave() ✗ 它是 800ms 防抖，点完立刻刷新就还没写下去 ✓ */
    ok('恢复默认会当场落盘（刷新后不会又变回改过的值 ✓）',
       (() => {
         const a = fs.readFileSync('web/js/app.js', 'utf8');
         const i = a.indexOf("$('set-reset').onclick");
         if (i < 0) return false;
         const seg = a.slice(i, i + 1600);   // confirm 文案占了地方 ✓ 窗口放大 ✓
         return /state\.set = Object\.assign\(\{\}, SET_DEFAULTS\);/.test(seg)
           && /saveMapPrefs\(\)/.test(seg);
       })(),
       '重置内存 + 同步写一次 ✓');
    /* 🔴 **"让路"必须确认有人接**（用户报：荒地↔荒地的缝缩小看得见、放大整条消失 ✓）
     *   荒地边那一组判的是 `isJ[p] !== isJ[q]`（荒地**状态不同** ✓）
     *     · 荒地↔国家：状态不同 → 那组会画 → 头衔线让开是对的 ✓
     *     · 荒地↔荒地：两边都不是"非荒地" → 那组判它**不是缝** ✗
     *       而头衔线要是也无条件让 → **两个组都不画 = 整条消失** ✓
     *   ⚠ 跟"闸门比门框窄"是同一类错：改一处口径，得把对接口径一起看 ✓ */
    /* 🔴 **着色器里的声明顺序**（用户报白屏：`_useEdges` undeclared identifier ✓）
     *   我把"距离场"那段插到了 `_useEdges` 声明**之前** ✗ 而它用了 `_useEdges` ✓
     *   → GLSL 编译失败 = 整屏黑 ✓
     *   ⚠ **桩里没有真的 WebGL2** ✗ 所以 check_standalone 那句"着色器没编译失败"是空话 ✓
     *     这类错**只能在真机浏览器上暴露** ✓ 所以更要靠静态守卫盯住 ✓
     *   这里只钉住最关键的一条：用 _useEdges 的东西必须在它**之后** ✓ */
    /* **边界宽度不再层层加粗**（用户定的：父级链 / 涂色边界那个 1.25、1.5 取消掉 ✓）
     *   以前本层 1.0× / 父层 1.25× / 填色 1.5× —— 都是拿「地方边界宽度」再乘一遍 ✗
     *   于是设置里拉 1，画出来却有三档粗细 ✓ 跟设置对不上 ✓
     *   ⚠ 涂色边界走的是「势力边界宽度」设置（_pwW ✓ 那个 1.5 是设置值本身、不是倍率 ✓）*/
    /* **粗筛位图**（用户定的：多余像素不需要每帧采样，加载时标记它们就行 ✓
     *   她后来一句话点破了本质：**问题的核心就是排除"一辈子画不了线"的像素** ✓
     *   实测 EU4：需要承担边界的只有 **8.6%** ✗ 其余 91.4% 取一位就退出 ✓
     *   ⚠ **不参与画线** ✗ 只当守门员 —— 算不准最多多跑几趟射线，线的样子不会变 ✓ */
    /* **GLSL 里的 const 必须是编译期常量** ✗（我踩过：拿它接运行时函数 →
     *   `'=': assigning non-constant to 'const bool'` → 整个着色器编不过 → **画面全白** ✓）
     *   桩里的 WebGL 是假的、编译不了 GLSL ✗ 所以只能静态盯：
     *   shader 里**只许那三个全局常量**带 const，函数体里一个都不许有 ✗ */
    {
      const _gl = fs.readFileSync('web/js/gl.js', 'utf8');
      const _s = _gl.indexOf('const FRAG =');       // 从 **它之后** 开始扫 ✓（它本身是 JS ✗）
      const _e = _gl.indexOf('}`;', _s);
      const _bad = (_gl.slice(_s + 20, _e).match(/^\s*const\s+\S.*$/gm) || [])
        .map((x) => x.trim())
        .filter((x) => !/^const (uint NONE|vec3 OUTSIDE|int MAXR|int PRESCREEN_MIN_R)\b/.test(x));
      ok('GLSL 里只有那三个全局常量用 const（函数体里用会编不过 ✗）',
         _bad.length === 0, _bad.length ? _bad.join(' | ') : '干净 ✓');
      /* **画布像素总数封顶** ✓（用户报"电脑版非常卡"✓ 这条是主因）
       *   dpr 上限原来写死 2 ✗ → 4K 屏 / Windows 缩放 125%~150% 时
       *   画布到三千多万像素（手机才 260 万 ✗ 差十几倍 ✓）
       *   现在按总量封顶，超了自动降 dpr，并顺手关掉那 4 点超采样 ✓
       *   普通 1080p（≈200 万）在限额内 → 一点不受影响 ✓ */
      ok('画布总像素封顶（超了自动降 dpr + 关 4 点超采样 ✓）',
         /const MAX_CANVAS_PX = 2\.6e6/.test(_gl)
         && /if \(px > MAX_CANVAS_PX\)/.test(_gl)
         && /this\.lowRes = true/.test(_gl)
         && /this\.noAA \|\| this\.lowRes/.test(_gl),
         (fs.readFileSync('web/js/gl.js', 'utf8').match(/MAX_CANVAS_PX = ([\d.e]+)/) || [])[1] || '?');
    }
    /* **顶栏布局**（用户定的 ✓）：
     *   教程 + 署名在**左侧工具栏右边**；**「文件」收尾在最右**（导入 / 导出都在它菜单里 ✓）
     *   🔴 2026-10-17：**清除搬到左栏「显示」区**（用户："文件栏的清除按钮放在显示区"✓），
     *   文件菜单里只剩导入 / 导出 ✓
     * ⚠ 两个容器 id 必须留着：`author-row`（手机版搬它）、`export-row` + `export-menu`
     *   （手机版搬前者、并把后者的子项摊平 ✓）—— 所以电脑版怎么排都不许改这两个名字 ✗ */
    ok('顶栏布局：工具 → 教程 → 署名 → … → 文件（最右，收着导入/导出）✓',
       /id="tool-group"[\s\S]*?id="help-row"[\s\S]*?id="btn-tutorial"[\s\S]*?id="author-row"[\s\S]*?id="btn-author"[\s\S]*?id="export-row"[\s\S]*?id="btn-export"[\s\S]*?id="btn-import"[\s\S]*?<\/header>/.test(htmlSrc)
       && htmlSrc.indexOf('id="btn-tutorial"') < htmlSrc.indexOf('id="btn-author"')
       && htmlSrc.indexOf('id="btn-author"') < htmlSrc.indexOf('id="export-row"')
       // 「文件」那个菜单里得同时有导入 / 导出 ✓（清除已经搬走 ✗）
       && /id="export-menu"[\s\S]*?id="btn-import"[\s\S]*?id="btn-png"[\s\S]*?id="btn-project"[\s\S]*?id="btn-log"/.test(htmlSrc)
       // 「显示」区里得同时有「清除全部」和「清除荒地」✓
       && /id="display-panel"[\s\S]*?id="btn-reset"[\s\S]*?id="btn-clear-waste"/.test(htmlSrc),
       '教程在署名左边、文件收在 header 最后、清除在显示区 ✓');
    ok('页面里加载了引导脚本 ✓', htmlSrc.includes('src="js/tutorial.js"'), 'script 标签');
    const buildSrc = fs.readFileSync('build_standalone.py', 'utf8');
    ok('打包清单里有 tutorial.js（单文件版才带得上 ✓）',
       /MODULES\s*=\s*\([^)]*"tutorial\.js"/.test(buildSrc), 'MODULES');
  }

  /* 三份"要拍平的模块清单"必须对得上 ------------------------------------------
   * 它们是：build_standalone.py（烤单文件）· tools/lib/browser_stub.js（桩）
   *         · 本文件（自己搭的沙箱）。
   * **漏一个的表现是"某个功能悄悄没了"**，不是隔壁那行报错 ✗ ——
   * 加"导入式地图"那回就踩了两遍：
   *   ① 本文件这份漏了 packstore.js → 一启动就 `packStoreMode is not defined`
   *   ② perf_compare 拿旧快照按新清单拍 → ENOENT
   * 所以这条盯着"清单"本身，而不是盯着某个功能 ✓ */
  {
    const fs2 = require('fs');
    const pickJs = (s) => [...s.matchAll(/'([A-Za-z0-9_]+\.js)'|"([A-Za-z0-9_]+\.js)"/g)]
      .map((m) => m[1] || m[2]);
    const grab = (src, re) => { const m = src.match(re); return m ? m[0] : ''; };
    const stubList = pickJs(grab(fs2.readFileSync('tools/lib/browser_stub.js', 'utf8'),
      /MODULES = \[[^\]]*\]/));
    const buildList = pickJs(grab(fs2.readFileSync('build_standalone.py', 'utf8'),
      /MODULES = \([\s\S]*?\)/));
    /* ⚠ 自引用要用 `__filename` ✗ —— 裸 `'test_modes.js'` 是按**工作目录**解析的，
     *   而这个脚本搬进 tools/ 之后工作目录是仓库根 → 会去找根目录那份 ✗
     *   （我就是这么炸的：ENOENT …\test_modes.js ✓）*/
    const selfList = pickJs(grab(fs2.readFileSync(__filename, 'utf8'),
      /const MODULES = \[[^\]]*\]/));
    const show = (a) => a.join(' ');

    ok('烤单文件的清单和桩的清单完全一样（含顺序 ✓）',
       buildList.length > 0 && JSON.stringify(buildList) === JSON.stringify(stubList),
       `build_standalone ${buildList.length} 个 / 桩 ${stubList.length} 个`);
    /* 本文件这份**故意**少 log.js（报错日志是普通脚本，由桩自己处理）和 tutorial.js
       （引导是另一个 <script>）—— 除此之外必须一个不差、顺序也一样 ✓ */
    const want = buildList.filter((n) => n !== 'log.js' && n !== 'tutorial.js');
    ok('自测这份清单 = 单文件版清单去掉 log / tutorial（少一个都会"功能悄悄没了" ✗）',
       selfList.length > 0 && JSON.stringify(selfList) === JSON.stringify(want),
       JSON.stringify(selfList) === JSON.stringify(want)
         ? `一致（${show(selfList)}）`
         : `自测 ${selfList.length} 个：${show(selfList)} ｜ 应该是：${show(want)}`);
  }

  // 剧本层的国名 = 「填色 · 名称」那份全图重分组 ✓
  // （原来还有个「势力 · 名称」开关，画的是**同一批点**，所以删了 ✓
  //   这里守两件事：① 没涂色也得给每个国家一个点 ② 点的位置/字号就是那份分组给的 ✓）
  {
    const nEra0 = (st.meta.eraDates || []).length;
    if (!nEra0) {
      console.log('  （这一局没有年份层，跳过剧本层国名检查）');
    } else {
      const view = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 };   // 视口拉满，别把点筛掉 ✓
      // 只读检查：动过的状态跑完原样还回去 ✓
      const keep = { tier: st.tier, paint: st.showLabelsPaint, ovr: st.countryNameOverride };
      st.tier = ERA0;                              // 一个有主的剧本层 ✓（空白层本来就没国名 ✓）
      st.countryNameOverride = null;
      st.showLabelsPaint = true;
      ex.rebuildPaintBlocks(true);                  // 剧本层：全图重分组 ✓
      const got = [];
      const orig = ex.labels.drawPoints;
      ex.labels.drawPoints = (list) => { for (const p of list) got.push(p); };
      try { ex.drawLabels(view); } finally { ex.labels.drawPoints = orig; }
      const named = got.filter((p) => p.name);
      ok('剧本层开「填色 · 名称」= 每个国家一个点（没涂色也要有 ✓）',
         named.length > 0,
         `画了 ${named.length} 个国名（真值来自 paintBlocks，全图重分组 ✓）`);
      // 每个点都得有有效坐标；跨度 w 可以有 0（单省色块的自然值），但不许是 NaN ✓
      ok('这些国名点的坐标都有效、跨度也不是 NaN ✓',
         named.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w || 0)),
         `${named.filter((p) => (p.w || 0) > 0).length}/${named.length} 个有非零跨度（其余是单省色块 ✓）`);
      // 还回去 ✓
      st.tier = keep.tier;
      st.showLabelsPaint = keep.paint;
      st.countryNameOverride = keep.ovr;
      ex.rebuildPaintBlocks(!!(st.meta.eraDates && st.meta.eraDates.length) && st.tier < nEra0);

      // ---- 回归：**粒度开着**时，剧本层国名还得是国家名，不能变成省名、也不能吞掉半个地图 ----
      // （改坏过一次：细层身份跟着粒度走 → 一整片同色的海并成 960 万像素的巨块 →
      //   名字取到海边第一个省名"百慕大"，字号按整片海算 → 糊满全屏 ✗）
      {
        const keepG = { grain: st.grain, tier: st.tier, paint: st.showLabelsPaint };
        let mapPx = 0;
        for (let i = 1; i < st.meta.numProvinces; i++) mapPx += st.provPos[i * 3 + 2] || 0;
        for (const g of [null, st.meta.tierNames.length - 1]) {
          st.grain = g;
          st.tier = 0;
          st.showLabelsPaint = true;
          ex.rebuildPaintBlocks(true);
          const got2 = [];
          const o2 = ex.labels.drawPoints;
          ex.labels.drawPoints = (list) => { for (const p of list) got2.push(p); };
          try { ex.drawLabels(view); } finally { ex.labels.drawPoints = o2; }
          const namedOnly = got2.filter((p) => p.name);
          const big2 = namedOnly.filter((p) => (p.area || 0) > mapPx * 0.4);
          ok(`粒度=${g == null ? '关' : st.meta.tierNames[g]}：剧本层没有"吞掉半个地图"的巨块名字 ✓`,
             big2.length === 0,
             big2.length
               ? `有 ${big2.length} 个：${big2.slice(0, 2).map((p) => `${p.name}=${p.area | 0}px`).join('、')}`
               : `最大的名字 ${Math.round(namedOnly.reduce((m, p) => Math.max(m, p.area || 0), 0))} px / 全图 ${Math.round(mapPx)} px`);
        }
        st.grain = keepG.grain; st.tier = keepG.tier; st.showLabelsPaint = keepG.paint;
        ex.rebuildPaintBlocks(!!(st.meta.eraDates && st.meta.eraDates.length) && st.tier < nEra0);
      }

      /* 🔴🔴 **「水域 · 名称」那个独立闸** ✗✗（2026-10-16 ✓ handover §3.4 第 7 步 / 第 9 步 ✓）
       *
       *  用户原话："水域名称开关同理" + "同时受管理的这些东西**不再受地区名称的管理**"✓
       *  → 所以要量的是**两件事**，缺一件这个开关就是假的 ✗：
       *    ① 关掉水名 → `drawLabels` 吐出来的点里**一个水点都没有** ✓
       *    ② 但**陆地名字一个都不许少** ✓（把陆地名一起带走 = 接错了闸 ✓）
       *    ③ 反过来：把「地区 · 名称」关掉、水名开着 → **水名还在** ✓（这才是"独立"✓）
       *
       *  ⚠ 怎么认"水点" ✗：不能看 `p.name`（"波罗的海"也可能碰巧是个陆地省名 ✓）
       *    只能看它那个 tid 在**当前层**的键 —— 跟 app 里同一个判据（isWaterKey ✓）
       *  ⚠ 视口拉满（同上面那段 ✓）否则点会被 `_cull` 筛掉、数量对不上 ✓ */
      {
        const _keep = {
          tier: st.tier, grain: st.grain, showLabelsTitle: st.showLabelsTitle,
          showWaterName: st.showWaterName, showLabelsPaint: st.showLabelsPaint,
        };
        const _fine = st.meta.tierNames.length - 1;
        const _gather = () => {
          const got = [];
          const orig = ex.labels.drawPoints;
          ex.labels.drawPoints = (list) => { for (const p of list) got.push(p); };
          try { ex.drawLabels(view); } finally { ex.labels.drawPoints = orig; }
          return got;
        };
        /* 那些**没有头衔**的点（老包水名 / 荒地名 ✓ `tid: null` ✓）单独算一类 ✓
         * 它们走的是 ②′ 那条路，跟 ① 那条"连通域地名"不是一回事 ✓ 两边都得量 ✓
         * 🔴 **判据必须跟应用同一个出处** ✗✗（2026-10-16 现场栽过两次 ✓）
         *   栽法一：我按**键前缀**（`#sea_` 那套）认水 ✗ ——
         *     结果 **EU5 的水键压根不带 `#`**（`chukchi_sea` / `siberian_lakes_1` ✓）
         *     → "水点 0 个"、后面几条全判错 ✓
         *   栽法二：改成调 `waterKindByPid` 之后，我**只按最细层**建那张 tid 表 ✗ ——
         *     可水片**每一层都有自己的片** ✓（EU5 各层的水 tid 数是
         *     `reg=121 · area=373 · prov=925 · loc=5709` ✓ 见 probe_water_allsets ✓）
         *     而应用那边收的是**所有层的并集** ✓ → 我这张表小了 → 又判错 ✓
         *   → 正解：**跟应用一字不差** —— 直接读它自己产出的
         *     `state.waterKindSet`（`buildWaterKindMask()` 那一趟出的 ✓ 同样是并集 ✓）✓
         *   ⚠ 为什么这样最稳：那个 Set 就是**应用真正用的那张** ✓
         *     测试另建一张 = 迟早漂移 ✗（这次就漂了 ✓）*/
        /* ⚠ **别读 `state.waterKindSet` 了** ✗✗ —— 那张表 2026-10-17 拆了 ✓
         *   用户原话：「既然是如何判别水，那不是还有现成的东西嘛」✓
         *   现成的就是 `kindOfTid(tid)`（走 `kindTidMap()` ✓ 扫每一层 +
         *   老包退回键前缀 ✓ 自带缓存 ✓）——**判据仍然收在应用那一处** ✓ */
        /* ⚠ **顺序必须跟应用里那道闸一样** ✗✗ —— 键先说、键说不出话才问身份标 ✓
         *   （应用那边是 `_isWaterLabel` ✓ 见它那段：CK3 有 2 块地键写着 lake、
         *     身份标却是 6 ✓ 只按身份标判就会把它们当陆地 ✓）*/
        const _kOf = (tid) => {
          const _key = String(((st.titles && st.titles.keys) || [])[tid] || '');
          if (ex.isWaterKey ? ex.isWaterKey(_key) : /^#(impassable_sea|sea|lake|river)/.test(_key)) return 1;
          const k = ex.kindOfTid(tid);
          return (k >= 2 && k <= 5) ? k : 0;
        };
        /* 🔴🔴 **每张图的每个最低单位都得带"身份标"** ✗✗（2026-10-16 迁移 ✓ 用户点名要的 ✓）
         *   用户原话："我记得开发一开始就给每个地图每个最低等级都加上了相应的标记"✓
         *   —— 他记得对：`build_tier_pieces.kind_mask()` 早就写好了 ✓
         *     可**只有 CK2 / EU5 两家构建脚本在调它** ✗，另外四家一直靠"`#` 键名前缀"推 ✓
         *   → 2026-10-16 给 `build_data.py`(CK3) / `build_eu4.py` / `build_hoi4.py` /
         *     `build_vic3.py` 全接上了 ✓ 这一条是**防回退**：
         *     哪家又变回"推出来的"，当场红 ✓
         *   ⚠ **CK3 那枚老 `waterMask` 不算数** ✗ —— 只有 0/1（"是不是水"），
         *     分不出海 / 湖 / 河 / 不可通行海域 ✓ 而且是 2026-10-15 退役的遗留 ✓
         *     `kindOfPid` 读的是 `kindMask` ✓ 所以这条只认它 ✓ */
        ok('每张图的每个最低单位都带 kindMask（不再靠 `#` 键名推 ✗）',
           !!st.kindMask && st.kindMask.length === (st.meta.numProvinces | 0),
           st.kindMask
             ? `kindMask ${st.kindMask.length} 字节（= numProvinces ✓）`
             : (st.waterMask ? '✗ 只有老 waterMask（0/1，分不出类别 ✗）' : '✗ 两样都没有 → 在靠键名推'));
        {
          /* 顺带盯一眼"那枚标不许有空洞" ✗ —— 0 号一格空位、其余 1~6 全有值 ✓
           *   构建期已经 assert 过一次 ✓ 这里是**消费端**再看一眼：
           *   前端拿它当唯一判据 ✓ 有空洞 = 某几块地没身份 ✓ */
          let _holes = 0;
          const _km = st.kindMask;
          if (_km) for (let p = 1; p < _km.length; p++) if (!_km[p]) _holes++;
          ok('kindMask 没有空洞（1 号之后每一格都有身份 ✓）',
             !!_km && _holes === 0, _km ? `${_holes} 格没身份` : '没有那枚标');
        }
        ok('应用的判别口能认出「这个头衔是水」（`kindOfTid` ✓ 标签闸的地基 ✓）',
           typeof ex.kindOfTid === 'function'
           && (st.kindMask || null) != null
           && (() => {
             for (let _p = 1; _p < st.meta.numProvinces; _p++) {
               if (!(st.waterKindArr && st.waterKindArr[_p])) continue;
               const _t = ex.titleAt(_p, (st.meta.tiers || []).length - 1);
               if (_t == null || _t < 0 || _t === 65535) continue;
               return _kOf(_t) !== 0;      // 找到一块水就够 ✓
             }
             return false;
           })());
        /* 🔴🔴 **这张表必须是"所有层的并集"** ✗✗（2026-10-16 21:4x ✓ 刚踩过 ✓）
         *   水片**每一层都有自己的片** ✓（EU5：`reg` 121 · `area` 373 · `prov` 925 · `loc` 5709 ✓）
         *   ⚠ 只收最细层 → 中间层的水名被判成陆地 ✗
         *     表现：关掉水名开关还剩一堆水名点 ✓（EU5 5709 那次的真凶就是这个 ✓）
         *   ⚠ 还有个更阴的变体（同一场踩的）：层数读 `TIER_COUNT`（模块变量 ✓ 初值 5 ✗）
         *     而它在 `buildWaterKindMask` 跑的那一步**还没被 meta.tiers 更新** ✓
         *     → 差 1~2 层 → 同样漏 ✓（打印出来才看见：`TIER_COUNT=5` 而 `meta.tiers=6/7` ✓）
         *   → 这条断言直接量"**最细层每一个水 tid 都在表里**" ✓
         *     层数读 `meta.tiers.length`（权威 ✓ 不是模块变量 ✓）*/
        {
          const _nT = (st.meta.tiers || []).length;
          const _NONE = (st.meta.noTitle != null) ? st.meta.noTitle : 65535;
          const _miss = [];
          for (let _t = 0; _t < _nT; _t++) {
            let _m = 0;
            for (let _p = 1; _p < st.meta.numProvinces; _p++) {
              if (!(st.waterKindArr && st.waterKindArr[_p])) continue;
              const _tt = ex.titleAt(_p, _t);
              /* ⚠ **无主地块不算** ✗ —— 有些层（EU5 的 `1337` / `blank` ✓）整层都是无主 ✓
               *   它们拿到的是 NONE（65535 ✓ 不是合法 tid ✗）
               *   建表时那句 `tt >= 0 && tt !== NO_TITLE` 本来就把它们挡掉了 ✓
               *   → 断言数它们 = 假红 ✓（我第一版就这么报的："层0 漏 5709 块" ✓）*/
              if (_tt == null || _tt < 0 || _tt === _NONE) continue;
              if (!_kOf(_tt)) _m++;
            }
            if (_m) _miss.push(`层${_t}(${st.meta.tiers[_t]}) 漏 ${_m} 块`);
          }
          ok('每一层的水片，应用那道闸都认（键先说 → `kindOfTid` ✓）',
             _miss.length === 0,
             _miss.length ? _miss.join(' · ')
               : `${_nT} 层全命中 ✓（最细层 ${st.meta.tiers[_nT - 1]} ✓ 无主那几层本来就不收 ✓）`);
        }
        const _isWaterPt = (p) => (p.tid == null
          ? !!p.sea && !p.waste
          : (_kOf(p.tid) !== 0));
        st.grain = null;
        st.tier = _fine;                   // 细层视图：地名真出得来的那一档 ✓
        st.showLabelsTitle = true;
        st.showLabelsPaint = false;        // 别让色块名混进来 ✓
        st.showWaterName = true;
        const _on = _gather();
        st.showWaterName = false;
        const _off = _gather();
        const _wOn = _on.filter(_isWaterPt).length;
        const _wOff = _off.filter(_isWaterPt).length;
        const _lOn = _on.filter((p) => !_isWaterPt(p)).length;
        const _lOff = _off.filter((p) => !_isWaterPt(p)).length;
        /* ⚠ **先看这一局到底有没有水名可出** ✗✗（2026-10-16 现场量出来的 ✓）
         *  CK3：786 个水组件**全被"类名闸"挡住**（它的键是 `#impassable_sea_b_66`、
         *   名字是 `#12764` 那种占位 ✓ 见 `isPseudoCategoryName` / 占位 `#` 那两道 ✓）
         *  → 按 `NAME_POLICY` 的口径，**CK3 本来就一个水名都不出** ✓
         *    （handover §3.2 也写着："CK3 那些水节点本来只有类名，被挡也出不来字"✓）
         *  所以这一局量"开关有没有用"是**量不出来的** ✗ —— 正例天然为空 ✓
         *  → 没得量就**明说跳过**，别硬编一个绿 ✗（那才是自欺 ✓）
         *  ⚠ 但**反面**（关掉之后一个不剩 / 别把陆地名字带走）**照量不误** ✓
         *    那两条在 CK3 上也是有意义的（0 → 0、11297 → 11297 都得成立 ✓）*/
        const _noWaterHere = (_wOn === 0);
        if (_noWaterHere) {
          console.log('  （这一局按名字方案就不出水名（CK3 的海 / 湖只有类名 ✓）'
            + '—— 正例那两条跳过 ✓）');
        } else {
          ok('「水域 · 名称」开着时，地图上**真有**水名点 ✓（否则这个开关是假的 ✗）',
             _wOn > 0, `水点 ${_wOn} 个 / 全部 ${_on.length} 个`);
        }
        ok('关掉「水域 · 名称」→ 水名点**一个都不剩** ✓',
           _wOff === 0, `关着时还剩 ${_wOff} 个（该是 0 ✓）`);
        ok('关水名**不会把陆地名字一起带走** ✓（接错闸就是这条红 ✓）',
           _lOff === _lOn && _lOn > 0,
           `陆地/荒地/河那批：开 ${_lOn} → 关 ${_lOff}`);
        /* ③ 独立：**关掉「地区 · 名称」**，水名开着 → 水名还得在 ✓ */
        st.showLabelsTitle = false;
        st.showWaterName = true;
        const _onlyWater = _gather();
        const _w3 = _onlyWater.filter(_isWaterPt).length;
        const _l3 = _onlyWater.filter((p) => !_isWaterPt(p)).length;
        if (_noWaterHere) {
          ok('「地区 · 名称」关 → 地名点全没了 ✓（这一局没有水名，所以是空 ✓）',
             _onlyWater.length === 0, String(_onlyWater.length) + ' 个');
        } else {
          ok('「地区 · 名称」关 + 「水域 · 名称」开 → **只剩水名** ✓（真独立 ✓）',
             _w3 > 0 && _w3 === _wOn && _l3 === 0,
             `水点 ${_w3}（开着水名时是 ${_wOn}）/ 其余 ${_l3} 个（该是 0 ✓）`);
        }
        /* ④ 两边都关 → 一个地名都不出 ✓（别留"漏网"的点 ✗） */
        st.showWaterName = false;
        const _none = _gather();
        ok('两个都关 → 一个地名点都不出 ✓',
           _none.length === 0, String(_none.length) + ' 个');
        st.tier = _keep.tier; st.grain = _keep.grain;
        st.showLabelsTitle = _keep.showLabelsTitle;
        st.showWaterName = _keep.showWaterName;
        st.showLabelsPaint = _keep.showLabelsPaint;
      }

      // ---- 回归：细层里挑「最后一层年份才有的 tag」的颜色+标签，只涂一小块 ----      // 以前细层里"没涂的邻居"按 cTier = 最后一层年份（EU4 是 1789）算身份 ✗
      // → 颜色+标签撞上某个 1789 tag 时，整块 1789 的地会被并进来 →
      //   国名显示成整个国家的大小和位置，而不是跟着涂色实时变 ✗（用户报的 bug）
      {
        const fineT = st.meta.tierNames.length - 1;
        const T = st.titles;
        // 找一个大一点的「最后一层年份」的头衔（EU4 = 1789）
        let big = -1;
        for (let i = 0; i < T.keys.length; i++) {
          if ((T.tiers[i] | 0) !== nEra0 - 1) continue;
          if ((T.area[i] || 0) > (big < 0 ? 0 : (T.area[big] || 0))) big = i;
        }
        // 找一块属于它的地（在最细层）
        let pid = -1;
        for (let i = 1; i < st.meta.numProvinces; i++) {
          if (ex.titleAt(i, nEra0 - 1) === big) { pid = i; break; }
        }
        if (big >= 0 && pid > 0) {
          const keep2 = { tier: st.tier, grain: st.grain, brush: st.brush.slice(),
                          label: st.brushLabel, paint: st.showLabelsPaint };
          st.grain = null;
          st.tier = fineT;                        // 细层视图（真是用户编辑时最常待的地方）
          st.showLabelsPaint = true;
          st.brush = (T.colors[big] || [200, 30, 90]).slice();   // 挑"那个 tag"的颜色
          st.brushLabel = T.names[big];                          // 和它的标签
          ex.rebuildPaintBlocks(false);
          ex.paintAt(pid, ex.titleAt(pid, fineT));
          ex.rebuildPaintBlocks(false);
          const pArea = st.provPos[pid * 3 + 2] || 0;
          const bs = st.paintBlocks || [];
          const biggest = bs.reduce((m, b) => Math.max(m, b.area || 0), 0);
          ok('细层：拿「最后一层年份的 tag」的颜色+标签涂一小块，不许把整块并进来 ✓',
             bs.length > 0 && biggest < pArea * 4,
             `最大色块 ${Math.round(biggest)} px / 涂的那块 ${Math.round(pArea)} px`
             + `（整块 ${T.names[big]} 是 ${Math.round(T.area[big] || 0)} px，并进来就会是那个量级 ✗）`);
          if (ex.restoreTitle) ex.restoreTitle(ex.titleAt(pid, fineT), true);
          st.tier = keep2.tier; st.grain = keep2.grain; st.brush = keep2.brush;
          st.brushLabel = keep2.label; st.showLabelsPaint = keep2.paint;
          ex.rebuildPaintBlocks(!!(st.meta.eraDates && st.meta.eraDates.length) && st.tier < nEra0);
        }
      }
    }
  }

  console.log('\n=== 2b. 名字语种与搜索 ===');
  if (isHoi4) {
    // —— 临时测量（只打印）：涂完两省之后账本里到底写了什么 ——
    {
      const histLen0 = st.history.undo.length;
      const stT = st.meta.tierNames.indexOf('地区');
      const prT = st.meta.tierNames.indexOf('省份');
      const n2 = st.meta.numProvinces;
      let sTid = -1; const pids = [], pTids = [];
      for (let pid2 = 1; pid2 < n2 && pids.length < 2; pid2++) {
        const s2 = ex.titleAt(pid2, stT), q2 = ex.titleAt(pid2, prT);
        if (s2 === 65535 || q2 === 65535 || s2 === 0 || q2 === 0) continue;
        if (st.provTitle && st.provTitle[pid2] >= 0) continue;
        if (sTid === -1) sTid = s2;
        if (s2 === sTid && q2 !== s2) { pids.push(pid2); pTids.push(q2); }
      }
      console.log('  [量] 州tid=', sTid, ' 两个省tid=', pTids, ' pid=', pids,
                  ' provTitle数组存在=', !!st.provTitle);
      const C = [11, 222, 33];
      for (const q2 of pTids) { ex.paintTitle(q2, C); }
      console.log('  [量] 涂完两省后 provTitle=', pids.map((x) => st.provTitle[x]),
                  ' painted=', pTids.map((q2) => st.painted.has(q2)));
      ex.paintTitle(sTid, C);
      console.log('  [量] 涂完州后 provTitle=', pids.map((x) => st.provTitle[x]));
      const last = st.history.undo[st.history.undo.length - 1] || {};
      const ps = last.patches || [];
      console.log('  [量] 历史栈=', st.history.undo.length, ' 末笔 patches=', ps.length,
                  ' 其中涉及这两个 pid 的=', JSON.stringify(ps.filter((x) => pids.includes(x.pid))));
      // 量完收拾干净：撤涂色、把测量产生的历史截回去 —— 别把残留带进后面的断言
      for (const q2 of pTids) { if (st.painted.has(q2)) ex.restoreTitle(q2, true); }
      if (st.painted.has(sTid)) ex.restoreTitle(sTid, true);
      st.history.undo.length = histLen0;
    }

  } else {

    console.log('\n=== 2d. 标注位置：名字必须落在自家地盘上（取最大连通域的重心）===');
    {
      // 口径（用户定的）：标注点 = **像素最多的那块连通域的重心** ✓
      // 所以这里按邻接表把每个头衔拆成连通块、自己算一遍最大块的重心，
      // 跟数据里的 lx/ly 对齐。抽查每层前 200 个（全量太慢，抽查足够抓"跑偏"）。
      // ↑ 旧 EU5 会大面积红：它的标注位置是在另一张图上算的，
      //   波利尼西亚那种横跨接缝的直接掉到地图正中 ✗
      const pos = st.provPos;
      const NP = st.meta.numProvinces;
      const real = st.meta.numRealTitles || st.meta.numTitles;
      const adj = st.adjacency;
      if (!adj) {
        ok('有邻接表可以核对标注位置', false, '没有 adjacency');
      } else {
        const offsets = new Uint32Array(adj.buffer, adj.byteOffset, NP + 1);
        const neighbors = new Uint16Array(adj.buffer, adj.byteOffset + (NP + 1) * 4);
        // **年份层（国名）不查** ✓ —— 那是"国家"（V3 的 1836 / EU4 的三个年份 /
        // EU5 的 1337 / HOI4 的 1936·1939），名字有它自己那套规矩。
        // CK3 没有年份层：五层全是法理地区（含帝国/王国 ✓）都要按这个规矩来 ✓
        // ⚠ 但 CK3 现在最上面是「1066 剧本地图」✗ —— 那一层**借的是法理头衔的节点** ✓
        //   （一个独立君主就显示成他那个头衔 ✓）所以同一个节点会在两层出现 ✗
        //   而标注位置是**一个节点一个位置**、按它"自己那一层"的地盘算的 ✓
        //   → 这里只查**这个节点自己那一层**（titles.tiers[tid]）✓
        //     不然会拿"1066 年的地盘"去要求"按法理算出来的位置" ✗ 冤枉它 ✓
        const _nCountry = (st.meta.eraDates || []).length;
        const Tn = st.titles;
        let checked = 0, miss = 0, worst = 0, worstName = '';
        for (let tier = _nCountry; tier < st.meta.tiers.length; tier++) {
          const row = tier * NP;
          const byTitle = new Map();
          for (let p = 1; p < NP; p++) {
            const t = st.titlemap[row + p];
            if (t <= 0 || t >= real) continue;
            if (Tn.tiers[t] !== tier) continue;      // 不是它自己那一层 → 跳过 ✓
            let a = byTitle.get(t);
            if (!a) { a = []; byTitle.set(t, a); }
            a.push(p);
          }
          let k = 0;
          for (const [t, pids] of byTitle) {
            if (k >= 200) break;
            if (T.lx[t] == null || T.ly[t] == null) continue;
            k++;
            const parent = new Map();
            for (const p of pids) parent.set(p, p);
            const find = (x) => {
              let r = x;
              while (parent.get(r) !== r) r = parent.get(r);
              while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
              return r;
            };
            const inset = new Set(pids);
            for (const p of pids) {
              for (let q = offsets[p], e = offsets[p + 1]; q < e; q++) {
                const v = neighbors[q];
                if (!inset.has(v)) continue;
                const ra = find(p), rb = find(v);
                if (ra !== rb) parent.set(ra, rb);
              }
            }
            const blocks = new Map();
            for (const p of pids) {
              const r = find(p);
              let g = blocks.get(r);
              if (!g) { g = [0, 0, 0]; blocks.set(r, g); }
              const a = pos[p * 3 + 2] || 1;
              g[0] += pos[p * 3] * a;
              g[1] += pos[p * 3 + 1] * a;
              g[2] += a;
            }
            let big = null;
            for (const g of blocks.values()) if (!big || g[2] > big[2]) big = g;
            if (!big || !(big[2] > 0)) continue;
            const d = Math.hypot(T.lx[t] - big[0] / big[2], T.ly[t] - big[1] / big[2]);
            checked++;
            if (d > 1.5) {
              miss++;
              if (d > worst) { worst = d; worstName = String(T.names[t] || t); }
            }
          }
        }
        ok('标注点 = 最大连通域的重心（每层抽查 200 个）', miss === 0,
           `查了 ${checked} 个，不对的 ${miss} 个`
           + (worst ? `（最差 ${worst.toFixed(1)}px：${worstName}）` : ''));
      }
    }


    console.log('\n=== 2f. 男爵领地名：放到最大得看得见 ===');
    {
      // 以前 MAX_LABELS 是在视口裁剪**之前**截的，等于"只考虑面积最大的 4000 个"。
      // CK3 有 11295 个男爵领 —— 放到最大、视口里明明有三十几个，
      // 却可能一个都进不了候选，看起来就是"男爵领名字放多大都看不见"。
      // 最细的**真实**层，别写死 4 ✗ —— V3 只有 4 层(0~3)，写 4 会一个都挑不到；
      // EU5 的第 4 层是"锁住"的那批粗层节点，也不是地名该看的那层。
      const FINE = (ex.state.meta.tierNames.length || 5) - 1;
      const bar = [];
      // **只算有名字的** ✗ —— 应用里"没名字的直接跳过"（无名地块本来就不该有地名：
      // V3 最细层四万多个节点里只有两千多个有城市名）。挑视口时把这个算进去，
      // 否则会挑到一整片无名村庄，断言就变成"为什么一个都不画"。
      for (let i = 0; i < T.tiers.length; i++) {
        if (T.tiers[i] === FINE && T.names[i]) bar.push(i);
      }
      bar.sort((a, b) => T.area[a] - T.area[b]);

      // 挑一个男爵领最密的位置当视口中心（面积有并列，取"中位那块"不保险）
      const sc = 6;
      const vw = 1280 / sc, vh = 820 / sc;
      let mid = bar[0], visible = 0;
      for (let s = 0; s < 300; s++) {
        const i = bar[Math.floor(s * bar.length / 300)];
        const x0 = T.lx[i] - vw / 2, y0 = T.ly[i] - vh / 2;
        let c = 0;
        for (const j of bar) {
          if (T.lx[j] != null && T.ly[j] != null && T.lx[j] >= x0 && T.lx[j] <= x0 + vw &&
              T.ly[j] >= y0 && T.ly[j] <= y0 + vh) c++;
        }
        if (c > visible) { visible = c; mid = i; }
      }
      const view = { x: T.lx[mid] - vw / 2, y: T.ly[mid] - vh / 2, w: vw, h: vh };
      ok('这个视口里男爵领够多，能验出问题', visible >= 15, `视口里 ${visible} 个`);

      ex.labels.scale = sc;
      ex.labels.draw(view, FINE, null);
      ok('最大缩放下男爵领地名基本都画出来了（不再只认最大的 4000 个）',
         ex.labels.drawn >= visible * 0.8,
         `画了 ${ex.labels.drawn} 个 / 视口里 ${visible} 个`);

      // 候选放开到上万个之后，量宽必须还在粗筛**之后** ——
      // 不然一帧要对 11295 个标签逐个 measureText
      resetCanvasStats();
      ex.labels.draw(view, FINE, null);
      resetCanvasStats();
      ex.labels.draw(view, FINE, null);
      const warmB = { ...canvasStats };
      ok('上万个候选之下每帧仍不做 measureText、不现场栅格化',
         warmB.measure === 0 && warmB.stroke === 0 && warmB.fill === 0
         && warmB.image >= visible * 0.8,
         `measure ${warmB.measure} / stroke ${warmB.stroke} / fill ${warmB.fill} `
         + `/ drawImage ${warmB.image}`);
    }
  }

  console.log('\n=== 2g. 搜索定位 ===');
  {
    const T2 = st.titles;
    let idx = -1;
    const _eraN2 = (st.meta.eraDates || []).length;
    for (let i = 0; i < T2.keys.length; i++) {
      // 国家/剧本那几层不参与地区搜索（跟着 app 的规矩走）
      if (_eraN2 > 0 && T2.tiers[i] < _eraN2) continue;
      if (T2.names[i] && T2.lx[i] != null
          && T2.tiers[i] < st.meta.tierNames.length && (T2.area[i] || 0) > 0) { idx = i; break; }
    }
    ok('挑得到一个能搜的节点', idx >= 0, String(idx));
    get('search').value = T2.names[idx];
    ex.runSearch();
    const rows = get('results').children;
    ok('搜名字搜得出结果', rows.length > 0, `${rows.length} 行`);
    const hit = ex.searchHits[0];
    ok('第一条就是同一个名字的节点',
       hit != null && T2.names[hit].toLowerCase().includes(T2.names[idx].toLowerCase()),
       `${T2.names[hit]} / 搜的是 ${T2.names[idx]}`);
    const camBefore = { cx: st.cam.cx, cy: st.cam.cy };
    // 直接走定位那条：搜索结果第一行现在可能是**国家行**（点它只取色、不跳 ✓）
    ex.jumpToResult(hit);
    ok('点结果会飞过去（相机落在节点坐标上）',
       Math.abs(st.cam.cx - T2.lx[hit]) < 1.5 && Math.abs(st.cam.cy - T2.ly[hit]) < 1.5,
       `相机 ${st.cam.cx.toFixed(1)},${st.cam.cy.toFixed(1)} vs 节点 ${T2.lx[hit]},${T2.ly[hit]}`);
    ok('会短暂高亮它', st.focus === hit, String(st.focus));
    ok('相机确实动了（不是原来那儿）',
       camBefore.cx !== st.cam.cx || camBefore.cy !== st.cam.cy,
       `${camBefore.cx.toFixed(1)},${camBefore.cy.toFixed(1)} → ${st.cam.cx.toFixed(1)},${st.cam.cy.toFixed(1)}`);

    // 缩放按地盘大小算：小地盘飞得更近，且一律夹在合法区间（以前写死 0.35）
    let big = -1, small = -1;
    for (let i = 0; i < T2.keys.length; i++) {
      if (T2.tiers[i] >= st.meta.tierNames.length || T2.lx[i] == null) continue;
      if (big < 0 || (T2.area[i] || 0) > (T2.area[big] || 0)) big = i;
      if (T2.area[i] > 0 && (small < 0 || (T2.area[i] || 0) < (T2.area[small] || 0))) small = i;
    }
    const sBig = ex.searchJumpScale(big), sSmall = ex.searchJumpScale(small);
    ok('搜索定位：小地盘飞得更近（缩放按地盘算，不是写死 0.35）', sSmall > sBig,
       `小 ${sSmall.toFixed(2)} vs 大 ${sBig.toFixed(2)}`);
    ok('搜索定位的缩放夹在合法区间里',
       sBig > 0 && sBig <= 12 && sSmall > 0 && sSmall <= 12,
       `${sBig.toFixed(2)} / ${sSmall.toFixed(2)}`);
    get('search').value = '';
    ex.runSearch();
    ok('清空搜索后候选也清空', ex.searchHits.length === 0, String(ex.searchHits.length));

    // 搜索框上的键盘：**回车跳第一条、Esc 清空** ✓
    // （searchHits 本来就是为"回车跳第一条"存的，可那条路径一直没接线 ——
    //   变量只写不读，笔记里那句"回车跳第一条"在代码里根本不存在 ✗）
    {
      const ks = get('search')._listeners.keydown || [];
      ok('搜索框接上了 keydown', ks.length > 0, `${ks.length} 个监听`);
      get('search').value = T2.names[idx];
      ex.runSearch();
      const first = ex.searchHits[0];
      const camB = { cx: st.cam.cx, cy: st.cam.cy };
      if (ks.length) ks[0]({ key: 'Enter', preventDefault() {} });
      ok('回车 → 跳到第一条结果（高亮 + 相机落在它上面）✓',
         first != null && st.focus === first
         && Math.abs(st.cam.cx - T2.lx[first]) < 1.5
         && Math.abs(st.cam.cy - T2.ly[first]) < 1.5,
         `第一条 #${first} / focus=${st.focus} / 相机 ${camB.cx.toFixed(1)},${camB.cy.toFixed(1)}`
         + ` → ${st.cam.cx.toFixed(1)},${st.cam.cy.toFixed(1)}（节点 ${T2.lx[first]},${T2.ly[first]}）`);
      if (ks.length) ks[0]({ key: 'Escape', preventDefault() {} });
      ok('Esc → 清空搜索框并清掉候选 ✓',
         get('search').value === '' && ex.searchHits.length === 0,
         `value="${get('search').value}" 候选 ${ex.searchHits.length}`);
      ex.runSearch();
    }

    // ---- 「搜索有时出不来结果」的三个复现（2026-10-05 修）----
    const listText = () => String(get('results').flat()).toLowerCase();
    const _low2 = (v) => String(v == null ? '' : v).toLowerCase();
    if (st.meta.countryTags) {
      const allText = T2.names.concat(T2.namesEn || [], T2.keys)
        .map(_low2).join('\n');
      // ① 只有 tag 表里才有、节点里一个都没有的国家（当前年代没地盘的）。
      //    以前 tag 表那段排在「!hits.length → 没找到」之后，这类国家整类搜不出来 ✗
      const onlyTags = [];
      for (const tag of Object.keys(st.meta.countryTags)) {
        const nm = (st.meta.countryTags[tag] || {}).n || tag;
        const q2 = _low2(nm);
        if (q2 && !q2.includes('\n') && !allText.includes(q2)) onlyTags.push({ tag, nm });
        if (onlyTags.length >= 8) break;
      }
      ok('找得到「只有 tag 表里才有」的国名（复现要用）', onlyTags.length > 0,
         onlyTags.map((x) => `${x.tag}="${x.nm}"`).join(' / ') || '这局数据里没有');
      const bad1 = [];
      for (const x of onlyTags) {
        get('search').value = x.nm;
        ex.runSearch();
        if (!listText().includes(_low2(x.nm))) bad1.push(x.nm);
      }
      ok('搜「只有 tag 表里才有」的国名出得来结果（以前直接说没找到 ✗）',
         bad1.length === 0, bad1.length ? ('搜不到：' + bad1.join(', ')) : `查了 ${onlyTags.length} 个`);

      // ② 图上名字 ≠ tag 表名字的国家（V3：1836_FIN 图上叫「芬兰大公国」、表里叫「芬兰」）。
      //    以前 era 那一层被「countryTags 里存在这个 tag 就跳过」整个吞掉 ✗
      const diffNames = [];
      const _nEraS = (st.meta.eraDates || []).length;
      for (let i = 0; i < T2.keys.length && diffNames.length < 12; i++) {
        if (_nEraS <= 0 || T2.tiers[i] >= _nEraS || !T2.names[i]) continue;
        const k2 = String(T2.keys[i]);
        const tg2 = k2.includes('_') ? k2.slice(k2.indexOf('_') + 1) : k2;
        const e2 = st.meta.countryTags[tg2];
        if (e2 && e2.n && e2.n !== T2.names[i]) diffNames.push({ tag: tg2, nm: T2.names[i], cnm: e2.n });
      }
      console.log(`    （图上名字 ≠ tag 表名字的国家：${diffNames.length} 个`
                  + `${diffNames.length ? '' : ' —— 这局没有，② 跳过'}）`);
      if (diffNames.length) {
        const bad2 = [];
        for (const x of diffNames) {
          get('search').value = x.nm;
          ex.runSearch();
          if (!listText().includes(_low2(x.nm))) bad2.push(`${x.tag}「${x.nm}」`);
        }
        ok('搜图上显示的那个国名出得来结果（以前被 tag 表吞掉 ✗）',
           bad2.length === 0, bad2.length ? ('搜不到：' + bad2.join(', ')) : `查了 ${diffNames.length} 个`);
      }
    }
    // ③ 命中很广的子串：以前按节点序号「收满 200 就停」，名额被靠前的国家/剧本层
    //    吃光 → 计数写着 200+、列表一行都没有 ✗
    get('search').value = '_';
    ex.runSearch();
    {
      const rowN = get('results').children.length;
      ok('命中很广的子串也出得来东西（不再「计数 200+、列表空着」）', rowN > 0, `${rowN} 行`);
      const cnt = String(get('search-count').textContent);
      ok('计数跟列表行数对得上（不再写死 200+）',
         cnt === String(rowN) || cnt === String(rowN) + '+', `计数 "${cnt}" / 列表 ${rowN} 行`);
    }
    // ④ 数据里个别名字/统计数是空的：不许抛 —— 一抛就是整块面板空着（外面看就是「搜了没反应」）
    {
      const keepNm = T2.names[0];
      const keepPc = T2.provCount ? T2.provCount[0] : undefined;
      let threw = null;
      T2.names[0] = null;
      if (T2.provCount) T2.provCount[0] = null;
      try { ex.runSearch(); } catch (e) { threw = e; }
      ok('名字/统计数有空洞时不抛异常（一抛整块面板就空着 ✗）', !threw,
         threw ? String(threw && threw.message) : '不抛');
      ok('有空洞时照样出结果', get('results').children.length > 0,
         `${get('results').children.length} 行`);
      T2.names[0] = keepNm;
      if (T2.provCount) T2.provCount[0] = keepPc;
    }
    get('search').value = '';
    ex.runSearch();
  }

  // 荒地 UI：有荒地的模式显示；VIC3 / HOI4 这种没有荒地设定的，显示区和设置区都不许出现
  {
    const hasWaste = !!(st.meta.wasteland && st.meta.wasteland.length);
    const wg = get('waste-group');
    const wsub = get('set-waste-sub');
    const cw = get('btn-clear-waste');
    ok('荒地 UI 跟地图走：没有荒地设定的模式（VIC3 / HOI4）不显示荒地组 / 荒地设置 / 清除荒地',
       hasWaste
         ? (!wg || wg.style.display !== 'none')
           && (!wsub || wsub.style.display !== 'none')
           && (!cw || cw.style.display !== 'none')
         : !!wg && wg.style.display === 'none'
           && !!wsub && wsub.style.display === 'none'
           && (!cw || cw.style.display === 'none'),
       `荒地 ${st.meta.wasteland ? st.meta.wasteland.length : 0} 块 · 显示区=${wg && wg.style.display} · 设置区=${wsub && wsub.style.display}`);
  }

  // 荒地（不可通行）：只有真烘过 wasteland 数据的模式才跑
  if (st.meta.wasteland && st.meta.wasteland.length) {
    console.log('\n=== 2h. 荒地：可涂 + 自动上色（2026-10-17 重做） ===');
    {
      const T3 = st.titles;
      const fine = st.meta.tierNames.length - 1;
      const lutOf = (t2) => (t2 >= 0 ? Array.from(ex.renderer.lutData.slice(t2 * 4, t2 * 4 + 3)) : []);
      const baseOf = (t2) => (t2 >= 0 ? Array.from(T3.colors[t2]) : []);
      // **荒地"没上色"的样子 = 荒地灰** ✓ —— 不是数据里那个 colors[]
      // （EU5 的荒地节点在数据里是给 provinces.bmp 用的技术色：1818/1819 块五颜六色，
      //   连同一个"代赫纳沙漠"的两块都不一样；CK3/EU4 那份数据本来就写的是灰 ✓）
      const wasteGreyOf = () => (((st.set && st.set.impass) || [94, 94, 94]).slice());
      const restOf = (t2) => ((st.meta.wasteland || []).indexOf(t2) >= 0 ? wasteGreyOf() : baseOf(t2));
      const isColoured = (t2) => JSON.stringify(lutOf(t2)) !== JSON.stringify(restOf(t2));
      const colouredN = () => st.meta.wasteland.filter((t2) => isColoured(t2)).length;

      // 共享的那个灰伪头衔：找**键以 '#' 开头**的那个荒地节点 ✓
      //   ⚠ 不能拿"meta.wasteland 里第一个 >= numRealTitles 的"当它 ✗ ——
      //     EU5 的荒地现在**全是**伪头衔了（patch_waste_pseudo.py 把它们挪到尾 ✓），
      //     那样 grp 抓到的是一个**陆地荒地**节点，跟下面那个 wtid 撞车 ✗
      //     （测试当场报过「pid=43 tid=33548 / 灰节点=33548」✓ 逮住了 ✓）
      let grp = -1;
      for (const _t of st.meta.wasteland) {
        if (String((st.titles.keys || [])[_t] || '').charAt(0) === '#') { grp = _t; break; }
      }
      let wpid = -1;
      for (let pid = 1; pid < st.meta.numProvinces; pid++) {
        if (st.meta.wasteland.indexOf(ex.titleAt(pid, fine)) >= 0) { wpid = pid; break; }
      }
      const wtid = wpid > 0 ? ex.titleAt(wpid, fine) : -1;

      ok('细层里每块荒地有自己的节点（不再共用共享灰节点）',
         wpid > 0 && wtid !== grp, `pid=${wpid} tid=${wtid} / 灰节点=${grp}`);
      /* 🔴 **2026-10-19：把"第 0 层"换成"最细层"** ✗✗
       *   第 0 层现在是**1444 剧本层** ✓ 那里荒地是 `#wasteland_all_1444` 那种
       *   "整类一片"的伪头衔（见 build_tier_pieces 的 script_tiers ✓）——
       *   拿它跟最细层的逐块节点比，**必然不等** ✗ 老断言必红 ✓
       *   这条真正想验的是"**同一块地在各层指向的节点要能对上**"✓
       *   → 剧本层指向整类片、地理层指向它自己那块 ✓ 两者都对 ✓
       *     所以改成验：**最细层那个节点确实归这块地**（自洽 ✓） */
      ok('最细层那块荒地指向它自己的节点（悬停/取色/涂色自洽 ✓）',
         wpid > 0 && wtid >= 0 && ex.titleAt(wpid, fine) === wtid,
         `pid=${wpid} fine层=${fine} tid=${wtid}`);
      ok('荒地不再锁死（可以单独涂）', wtid >= 0 && !ex.isLocked(wtid), String(wtid));

      const alphaOf = (t2) => (t2 >= 0 ? ex.renderer.lutData[t2 * 4 + 3] : -1);
      /* 🔴🔴 **LUT 的 alpha = "这一格固定显示自己那份色"** ✗✗（2026-10-17 ✓ 用户定的 ✓）
       *   原话："**荒地不管什么视图都是荒地颜色**，就这样"✓
       *
       *   ⚠ 旧语义是 `setWasteland()` 打的"这是不是荒地" ✓
       *     那个方法 **2026-10-14 就退役了、没人调** ✓ 所以这里一直是 0 ✓（空断言 ✓）
       *   ⚠ 新语义：开图时 `setWasteFixed()` 把所有**荒地节点**打上 255 ✓
       *     着色器在 `tid == NONE` 那道早退**之前**先查它 ✓
       *     （剧本层荒地永远没归属 → 不查就被 `uUnpainted`(150,150,150) 盖掉 ✗
       *       —— 用户报的"剧本模式把荒地颜色覆盖了，明明画好了却还是 150,150,150"✓）
       *   验三样：荒地 255 ✓ / **不在名单里的一个都没打**（不误伤 ✓）/
       *           走一遍 `applySettings` 仍在 ✓
       *   ⚠ 不误伤那条**别拿 `plainTid`** ✗ —— 它在下面十几行才定义 ✓
       *     （外层 `let` 的 TDZ：这里读到的是 -1 ✓ 断言当场假红 ✓ 栽过一次 ✓）
       *     改成"**全表扫一遍**：带标记的必须**正好**是 `meta.wasteland` 那批" ✓
       *     这比挑一块地更硬 ✓ 而且不依赖下面那些变量 ✓ */
      {
        const wl = st.meta.wasteland || [];
        let aW = -1, aAfter = -1, markedN = 0, stray = 0;
        try {
          aW = alphaOf(wtid);
          ex.applySettings();
          aAfter = alphaOf(wtid);
          const inList = new Set(wl);
          const n = Math.floor(ex.renderer.lutData.length / 4);
          for (let t = 0; t < n; t++) {
            if (ex.renderer.lutData[t * 4 + 3] > 0.5) {
              markedN++;
              if (!inList.has(t)) stray++;
            }
          }
        } catch (err) { /* ✓ */ }
        ok('荒地不管什么视图都显示荒地色（标记正好 = 荒地名单 ✓ 不误伤 ✓）',
           aW === 255 && aAfter === 255 && markedN === wl.length && stray === 0,
           `荒地=${aW} applySettings后=${aAfter} 带标记=${markedN}/${wl.length} 误伤=${stray}`);
      }
      let plainTid = -1;
      for (let i = 0; i < T3.keys.length; i++) {
        if (T3.tiers[i] === fine && st.meta.wasteland.indexOf(i) < 0 && T3.names[i]) {
          plainTid = i;
          break;
        }
      }
      ok('普通地块没有这个标记', alphaOf(plainTid) === 0, `${plainTid} → ${alphaOf(plainTid)}`);
      ok('荒地的地名一律不显示（hideLabel 打了标记）',
         !!T3.hideLabel && T3.hideLabel[wtid] === true,
         String(T3.hideLabel ? T3.hideLabel[wtid] : '没有 hideLabel'));

      // UI：一个开关 + 两个按钮
      ok('「荒漠 · 涂色」开关还在', !!get('show-waste'), get('show-waste') ? '在' : '不在');
      const bAuto = get('waste-auto');
      // 假 DOM 不解析标签名，这里只验"在不在"
      ok('「自动」是个开关（不是按钮）', !!bAuto, bAuto ? '在' : '不在');
      ok('「自动上色」默认关闭（开图不自动改荒地色 ✓）',
         st.wasteAuto === false && (!bAuto || bAuto.checked !== true),
         `state=${st.wasteAuto} · 勾=${bAuto ? bAuto.checked : '-'}`);

      /* 🔴 **荒地自动上色重做**（2026-10-17 ✓）
       *   验四件事：周长表建出来了 / 最细层层号传给了渲染器 /
       *   过半的邻居颜色能写进最细节点 / 关掉开关回退荒地灰 ✓ */
      {
        ok('荒地自动上色：周长表建出来了（每块荒地都能查到邻居与边长）',
           !!st.wastePidList && st.wastePidList.length > 0
             && !!st.wastePerim && st.wastePerim.size > 0,
           `荒地块 ${st.wastePidList ? st.wastePidList.length : 0} · 周长表 ${st.wastePerim ? st.wastePerim.size : 0}`);

        const _fine = st.meta.tiers.length - 1;
        ok('荒地自动上色：渲染器知道最细层层号（着色器按 uFineTier 读 ✓）',
           ex.renderer.fineTier === _fine, `${ex.renderer.fineTier} vs ${_fine}`);

        /* 静态守卫：着色器里必须真的按 uFineTier 取荒地那份色 ✓
         *   （只把 uniform 传进去、着色器不读 = 画面一点变化都没有 ✗）*/
        {
          const glsrc = fs.readFileSync(path.join(ROOT, 'web', 'js', 'gl.js'), 'utf8');
          ok('荒地自动上色：着色器按 uFineTier 取色（不是 uTier / uEditTier ✗）',
             /titleAt\(pid, uFineTier\)/.test(glsrc) && /_fc\.a > 0\.5/.test(glsrc));
          /* 🔴 **顺序守卫** ✗✗（2026-10-17 用户报的 CK3 问题 ✓）
           *   CK3 的荒地底层身份是 kind = 6 → 必须**先**查荒地的 alpha 标记，
           *   再走 kind >= 2 那条类色；反了的话画面永远显示荒地灰 ✓
           *   （CPU 侧的 displayedColor / 取色不受影响 → 所以"取色说成功了、画面没变" ✓）*/
          const iWaste = glsrc.indexOf('titleAt(pid, uFineTier)');
          const iKind = glsrc.indexOf('int _kind = kindOf(pid)');
          ok('荒地自动上色：着色器的荒地取色排在 kind >= 2 之前（CK3 kind=6 ✓）',
             iWaste > 0 && iKind > iWaste, `荒地@${iWaste} · kind@${iKind}`);
        }

        /* 挑一块"有一个陆地邻居占它周长严格过半"的荒地 ✓
         *   ⚠ 那个邻居必须**不是荒地** ✗ —— 荒地邻居第一圈还没颜色，投不出票 ✓ */
        let wp = -1, nb = -1;
        for (const pid of (st.wastePidList || [])) {
          const per = st.wastePerim.get(pid);
          if (!per || !per.length) continue;
          let tot = 0;
          for (const p of per) tot += p[1];
          const top = per[0];
          if (top && top[1] * 2 > tot && !(st.wastePidFlag && st.wastePidFlag[top[0]])) {
            wp = pid; nb = top[0]; break;
          }
        }
        if (wp > 0) {
          const tid = st.wasteFineTid[wp];
          const lutOf = () => Array.from(ex.renderer.lutData.slice(tid * 4, tid * 4 + 3));
          const savedPaint = Array.from(ex.renderer.paintData.slice(nb * 4, nb * 4 + 4));
          const savedFlags = [st.showPaint, st.showPowerColor, st.showRegionColor, st.wasteAuto, st.tier, st.grain];
          try {
            st.showPaint = true;
            st.showPowerColor = false;
            st.showRegionColor = false;
            st.wasteAuto = true;
            st.grain = null;
            ex.renderer.setPaint(nb, 17, 201, 99, 255);
            st._wasteSig = null;
            ex.refreshWasteAuto();
            ok('荒地自动上色：周长过半的玩家涂色写进了这块荒地的最细节点',
               JSON.stringify(lutOf()) === JSON.stringify([17, 201, 99]),
               `pid=${wp} 邻居=${nb} → ${JSON.stringify(lutOf())}`);

            st.wasteAuto = false;
            st._wasteSig = null;
            ex.refreshWasteAuto();
            const grey = ((st.set && st.set.impass) || [94, 94, 94]).slice();
            ok('荒地自动上色：关掉开关 → 回退「不可通行区域」那个色',
               JSON.stringify(lutOf()) === JSON.stringify(grey),
               `${JSON.stringify(lutOf())} vs ${JSON.stringify(grey)}`);
          } finally {
            ex.renderer.setPaint(nb, savedPaint[0], savedPaint[1], savedPaint[2], savedPaint[3]);
            [st.showPaint, st.showPowerColor, st.showRegionColor, st.wasteAuto, st.tier, st.grain] = savedFlags;
            st._wasteSig = null;
            try { ex.refreshWasteAuto(); } catch (err) { /* ✓ */ }
          }
        } else {
          ok('荒地自动上色：过半邻居取色（找不到单邻居过半的荒地，跳过）', true, 'skip');
        }

        /* 🔴 **「清除荒地」按钮**（2026-10-17 用户要的 ✓）
         *   干两件事：清掉荒地块上的手绘色 + 关掉自动上色（否则下一帧又算回来）
         *   ⚠ 只挑一块荒地手绘，别把整张图的测试状态搅乱 ✓ */
        {
          const wp2 = (st.wastePidList || [])[0] || 0;
          if (wp2 > 0) {
            const savedAuto2 = st.wasteAuto;
            const savedPx2 = Array.from(ex.renderer.paintData.slice(wp2 * 4, wp2 * 4 + 4));
            try {
              ex.renderer.setPaint(wp2, 12, 34, 56, 255);
              st.wasteAuto = true;
              const bAuto2 = get('waste-auto');
              if (bAuto2) bAuto2.checked = true;
              ex.clearWastePaint();
              const pd2 = ex.renderer.paintData;
              ok('「清除荒地」：清掉荒地手绘色 + 自动上色一起关掉 ✓',
                 pd2[wp2 * 4 + 3] === 0 && st.wasteAuto === false
                 && (!bAuto2 || bAuto2.checked === false),
                 `pid=${wp2} alpha=${pd2[wp2 * 4 + 3]} · auto=${st.wasteAuto}`);
            } finally {
              ex.renderer.setPaint(wp2, savedPx2[0], savedPx2[1], savedPx2[2], savedPx2[3]);
              st.wasteAuto = savedAuto2;
              const bAuto3 = get('waste-auto');
              if (bAuto3) bAuto3.checked = savedAuto2;
              st._wasteSig = null;
              try { ex.refreshWasteAuto(); } catch (err) { /* ✓ */ }
              st.history.undo.length = 0;
              st.history.redo.length = 0;
            }
          } else {
            ok('「清除荒地」：这张图没有荒地，跳过', true, 'skip');
          }
        }

        /* 🔴 **剧本模式开启时不再检查地区颜色** ✗✗（2026-10-17 用户追加 ✓）
         *   把视图停在「空白剧本」（全无主）+ 粒度开到地理层 + 地区颜色打开：
         *   剧本没归属、也没涂色 → 一个颜色来源都没有 → 所有荒地必须回灰 ✓
         *   ⚠ 改之前这里会拿粒度层的地区色投票，能染上一片五颜六色 ✓ */
        {
          const nEra = (st.meta.eraDates || []).length;
          if (nEra > 0) {
            const fineT = st.meta.tiers.length - 1;
            const saved = [st.tier, st.grain, st.showPaint, st.showPowerColor,
                           st.showRegionColor, st.wasteAuto];
            try {
              st.tier = nEra - 1;              // 空白剧本（全无主）
              st.grain = fineT;                // 粒度开到最细的地理层
              st.showPaint = false;
              st.showPowerColor = true;        // 剧本色开着，但这一层没归属
              st.showRegionColor = true;       // 地区色开着 —— 新口径下**不该被检查**
              st.wasteAuto = true;
              st._wasteSig = null;
              ex.refreshWasteAuto();
              const grey = ((st.set && st.set.impass) || [94, 94, 94]);
              let colored = 0;
              for (const pid of st.wastePidList) {
                const tid = st.wasteFineTid[pid];
                if (tid < 0) continue;
                const c = [ex.renderer.lutData[tid * 4], ex.renderer.lutData[tid * 4 + 1],
                           ex.renderer.lutData[tid * 4 + 2]];
                if (c[0] !== grey[0] || c[1] !== grey[1] || c[2] !== grey[2]) colored++;
              }
              ok('荒地自动上色：剧本视图里不检查地区颜色（空白剧本 + 地区色开 → 全灰 ✓）',
                 colored === 0, `染上地区色的荒地 ${colored} / ${st.wastePidList.length}`);
            } finally {
              [st.tier, st.grain, st.showPaint, st.showPowerColor,
               st.showRegionColor, st.wasteAuto] = saved;
              st._wasteSig = null;
              try { ex.refreshWasteAuto(); } catch (err) { /* ✓ */ }
            }
          }
        }
      }



      // 取色 = 画面上此刻的颜色（跟着开关走）
      {
        const saved = [st.showWaste, st.showPaint, st.showTitles];
        const ownTid = ex.titleAt(wpid, fine);
        // ① 「荒漠 · 涂色」关着：荒地显示原版灰，取色就该取到灰
        st.showWaste = false;
        st.showPaint = false;
        /* 🔴 **取色跟画面必须是同一个口径** ✗（用户报：空白剧本下涂了色却取不到 ✓）
       *   着色器 colorOfPid：手绘 → 荒地灰 → 无归属 → 头衔色 ✓
       *   而 displayedColor（取色用）以前是"荒地灰 → 手绘" ✗ **反的** ✓
       *   → 涂过的地块：画面显示你的涂色、吸管吸出来却是灰的 ✓
       *   ⚠ 这个坑在着色器那边修过一次，取色这边漏了 → 两份实现口径分岔 ✓
       *   场景就用**空白剧本 + 无主地块**（用户报的那个组合 ✓）：
       *     那种地 tid = NONE，旧顺序会落到"固定灰 150"那条 ✗
       *     正确行为是**先看手绘**→ 返回涂色 ✓ */
      {
        const svP = st.showPaint, svT = st.tier;
        st.showPaint = true;
        // 挑一块"当前层没有归属"的地（空白剧本里满地都是 ✓）
        let np = 0;
        for (let p = 1; p < st.meta.numProvinces; p++) {
          if (ex.titleAt(p, st.tier) === 0) { np = p; break; }
        }
        if (!np) { for (let p = 1; p < st.meta.numProvinces; p++) { if (ex.titleAt(p, st.tier) == null) { np = p; break; } } }
        const pd2 = ex.renderer && ex.renderer.paintData;
        if (np && pd2) {
          pd2[np * 4] = 12; pd2[np * 4 + 1] = 200; pd2[np * 4 + 2] = 240; pd2[np * 4 + 3] = 255;
          const c2 = ex.displayedColor(np, ex.titleAt(np, st.tier));
          ok("涂过的无主地：取色取到涂色（不是那条无归属灰 ✓）",
             c2 && c2[1] > 150 && c2[2] > 200 && c2[0] < 60,
             "取到 " + JSON.stringify(c2) + "（该是 [12,200,240] ✓）");
        }
        st.showPaint = svP; st.tier = svT;
      }
      /* 🔴 **空白剧本下取色必须能用** ✗（用户报了两轮 ✓）
       *   根因**不是**颜色口径 ✗ 而是前面那道闸：
       *     pickAt / actAt 里 `if (isLocked(tid)) return;` ✓
       *   而空白剧本那层的地几乎全是**无主地**（tid = NONE ✓）
       *   而 isLocked(NONE) = true ✗ → 整个取色被拦死 ✓
       *     （其他层 tid 是真实头衔 → 所以**只有空白剧本坏** ✓）
       *   修法：取色不做这道拦截 ✓（取色只是把画面颜色吸走、不改数据 ✓）
       *   ⚠ 这条要**行为**测到 ✗ 只写静态检查的话，下一个人换个位置拦还是坏 ✓ */
      {
        const svT = st.tier, svP = st.showPaint, svTool = st.tool, svBrush = st.brush;
        /* **按层名找"空白剧本"** ✗ —— 不能瞎猜层号 ✓
         *   （我第一版取 eraN-1，而 EU4 那几个剧本层**全都是有主的** ✓
         *     → 一块无主地都找不到 → 断言根本没跑 ✓ 等于没测 ✓）*/
        const names = st.meta.tierNames || [];
        let tz = names.findIndex((n) => /空白/.test(String(n)));
        if (tz < 0) tz = Math.max(0, ((st.meta.eraDates && st.meta.eraDates.length) || 1) - 1);
        st.tier = tz;
        st.showPaint = true;
        /* ⚠ 判据用 **isLocked** ✗ 别去找 tid === 0 ✓
         *   实测 EU4 空白剧本那层：tid 一律是 **65535（NO_TITLE）** ✓
         *     → 找 0 一个都找不到 → 断言一直没跑 ✓ 等于没测 ✓（我踩过 ✓）*/
        let np = 0;
        for (let p = 1; p < st.meta.numProvinces; p++) {
          if (ex.isLocked(ex.titleAt(p, tz))) { np = p; break; }  // 锁住的 ✓
        }
        if (!np) {                                              // 这层恰好全有主 → 换最细层找
          for (let p = 1; p < st.meta.numProvinces; p++) { if (ex.titleAt(p, names.length - 1) === 0) { np = p; break; } }
        }
        const pdz = ex.renderer && ex.renderer.paintData;
        if (np && pdz) {
          const tidz = ex.titleAt(np, st.tier);
          ok("无主地在这一层确实是锁住的（这就是被拦的原因 ✓）",
             ex.isLocked(tidz) === true, "isLocked(" + tidz + ")=true");
          pdz[np * 4] = 12; pdz[np * 4 + 1] = 200; pdz[np * 4 + 2] = 240; pdz[np * 4 + 3] = 255;
          ex.pickTitle(tidz, true, np);          // 真实取色动作 ✓
          const bz = String(st.brush);
          ok("空白剧本：锁住的地照样取得出玩家涂的色 ✓",
             /12/.test(bz) && /200/.test(bz) && /240/.test(bz), "brush=" + bz);
        }
        /* ⚠ **必须把现场收拾干净** ✗ —— 我第一版没擦掉假涂色、也没还原画笔和工具 ✓
         *   结果后面的用例看到了那一块被涂过的地 → **EU5 挂了一条** ✓（踩过 ✓）*/
        if (np && pdz) { pdz[np * 4 + 3] = 0; }
        st.tier = svT; st.showPaint = svP; st.tool = svTool; st.brush = svBrush;
      }
      /* 静态：取色那条路不许被 isLocked 挡 ✗（防有人再把闸挪回来 ✓）*/
      {
        const a = fs.readFileSync(path.join(ROOT, "web", "js", "app.js"), "utf8");
        const pa = a.slice(a.indexOf("function pickAt"), a.indexOf("function needsRestore"));
        ok("pickAt 里没有裸的 isLocked 拦截 ✓",
           !/if \(isLocked\(tid\)\) return;/.test(pa),
           /isLocked/.test(pa) ? "还有 isLocked（看是不是带条件的 ✓）" : "干净");
      }
      /* 静态顺序：displayedColor 里"手绘"必须在"荒地自动色"**前面** ✓
       *   （2026-10-17 重做：荒地不再走旧 `showWaste` 那条，改成读最细层 LUT ✓）*/
      {
        const a = fs.readFileSync(path.join(ROOT, "web", "js", "app.js"), "utf8");
        const fn = a.slice(a.indexOf("function displayedColor"), a.indexOf("function stableColor"));
        const iPaint = fn.indexOf("state.showPaint && pd && pid");
        const iWaste = fn.indexOf("isWastelandTid(own) && renderer");
        ok("displayedColor 的顺序：手绘层在荒地自动色之前（跟 colorOfPid 对齐 ✓）",
           iPaint > 0 && iWaste > 0 && iPaint < iWaste,
           "手绘@" + iPaint + " · 荒地@" + iWaste);
      }
      ok('「荒漠 · 涂色」关着时，取色取到那块灰（不是底下的色）',
           JSON.stringify(ex.displayedColor(wpid, ownTid)) === JSON.stringify([94, 94, 94]),
           JSON.stringify(ex.displayedColor(wpid, ownTid)));
        // ② 荒漠涂色开着、但「填色 · 颜色」关着：手绘层看不见 ——
        //    命题是"**不取玩家涂的色**"；画面显示头衔色还是背景色，
        //    取决于「头衔 · 颜色」开没开（EU5 默认关 → 透明 → 看到背景 150 灰）
        st.showWaste = true;
        ex.renderer.setPaint(wpid, 11, 22, 33, 255);
        st.showPaint = false;
        ok('「填色 · 颜色」关着时，取色不取玩家涂的色（画面看不到它）',
           JSON.stringify(ex.displayedColor(wpid, ownTid)) !== JSON.stringify([11, 22, 33]),
           `${JSON.stringify(ex.displayedColor(wpid, ownTid))}`
           + ` vs 自己节点的色 ${JSON.stringify(Array.from(T3.colors[ownTid]))}`);
        // ③ 两者都开着：取色就是涂的颜色
        st.showPaint = true;
        ok('开着「填色 · 颜色」时，取色取的就是涂的颜色',
           JSON.stringify(ex.displayedColor(wpid, ownTid)) === JSON.stringify([11, 22, 33]),
           `${JSON.stringify(ex.displayedColor(wpid, ownTid))}`
           + ` （手绘alpha=${ex.renderer.paintData[wpid * 4 + 3]} showPaint=${st.showPaint}）`);
        ex.renderer.setPaint(wpid, 0, 0, 0, 0);
        st.showWaste = saved[0];
        st.showPaint = saved[1];
        st.showTitles = saved[2];
      }

    }
  }

  /* 显示面板的收放：八套地图**现在都一样**了 —— 有年代层就显示「势力/地区」，
     没有的（旧缓存）才收起来 ✓
     ⚠ 原来这里还验过「头衔」那一组（非 CK3 收掉、CK3 显示）——
     那一组 2026-10-12 删掉了：CK3 后来也有剧本层，`_hasEra` 在**每一个**模式里都成立，
     那组开关永远是藏着的 = 纯死 UI ✗ 见 app.js 里 syncLayerSwitches 上面那段注释 */
  {
    const hasEra = !!((st.meta.eraDates || []).length);
    const vis = (id) => { const el = get(id); return el ? el.style.display !== 'none' : false; };
    /* ⚠ 「元素还在不在」要扫**源码** ✗ —— 假 DOM 的 getElementById 找不到会现造一个，
       所以"删掉了没"在桩里永远测不出（同一条防线见上面"代码里取的元素都在页面上" ✓） */
    const gone = ['titles-group', 'show-titles', 'show-border-title', 'show-labels',
      'show-parent-border-ck3'].filter((id) => new RegExp(`id="${id}"`)
      .test(require('fs').readFileSync('web/index.html', 'utf8')));
    ok('「头衔」那组显示开关已经删干净（index.html 里不该再有那几个 id）',
       gone.length === 0, gone.length ? ('还留着：' + gone.join('、')) : '一个都不剩 ✓');
    /* 🔴 **2026-10-17：「剧本」那组整组删了** ✓（用户："三个开关已经没什么用了"✓）
     *   ⚠ 假 DOM 会现造元素 ✗ → 删没删必须扫源码 ✓ */
    {
      const _html = require('fs').readFileSync('web/index.html', 'utf8');
      const _ids = ['power-group', 'show-power-border', 'show-power-names', 'show-power-color'];
      const _left = _ids.filter((id) => new RegExp(`id="${id}"`).test(_html));
      ok('「剧本」那组的三个开关已经删干净（颜色 / 边界 / 名称 ✓）',
         _left.length === 0, _left.length ? ('还留着：' + _left.join('、')) : '一个都不剩 ✓');
      ok('显示区里「填色」这个组名改成了「势力」✓',
         /<span class="group-label">势力<\/span>/.test(_html)
         && !/<span class="group-label">填色<\/span>/.test(_html),
         '找 group-label = 势力 / 填色');
    }
    ok(hasEra ? '有年代层：显示「地块」组'
              : '没有年代层的旧缓存：「地块」组收起来',
       hasEra ? vis('region-group') : !vis('region-group'),
       `地块=${vis('region-group')} 有年代层=${hasEra}`);
  }

  // **剧本 + 地区/省份粒度**这个组合（用户报的三条都在这里）
  if ((st.meta.eraDates || []).length && get('show-power-color')) {
    const fineG = st.meta.tierNames.length - 1;
    const provG = Math.max(0, fineG - 1);
    const S1 = [st.tier, st.grain, st.showRegionBorder, st.showPowerBorder,
                st.showRegionName, st.showLabelsTitle,
                st._layerSig, st._parentSig];
    const push = () => {
      st._layerSig = null; st._parentSig = null;
      ex.syncLayerSwitches(); ex.syncParentBorder();
    };

    st.tier = ERA0;           // 看剧本的配色
    st.grain = provG;         // 按省份粒度改
    st.showRegionName = false; st.showRegionBorder = false;
    push();
    ok('剧本+粒度：关「地区·名称」→ 地区名关', st.showLabelsTitle === false,
       String(st.showLabelsTitle));
    ok('剧本+粒度：关「地区·边界」→ 细层边界关', ex.renderer.borderTitle === false,
       String(ex.renderer.borderTitle));
    st.showPowerBorder = false; push();
    ok('剧本+粒度：关「势力·边界」→ 国家那条关', ex.renderer.parentShow === 0,
       String(ex.renderer.parentShow));
    ok('剧本+粒度：关「势力·边界」会把画面标脏（不然旧图留着，看着关不掉）',
       ex.renderer.dirty === true, String(ex.renderer.dirty));

    [st.tier, st.grain, st.showRegionBorder, st.showPowerBorder,
     st.showRegionName, st.showLabelsTitle, st._layerSig, st._parentSig] = S1;
    push();
  }

  // 势力 / 地区 那几个开关逐个体检：每个都必须真的改到渲染器/标签（接错字段 = 死开关 ✗）
  // （「势力 · 名称」已经删掉了 ✓ —— 剧本层国名现在由「填色 · 名称」统一负责 ✓）
  if ((st.meta.eraDates || []).length && get('show-power-color')) {
    const fineS = st.meta.tierNames.length - 1;
    const S0 = [st.tier, st.grain, st.showPowerColor, st.showPowerBorder,
                st.showRegionColor, st.showRegionBorder, st.showRegionName,
                st.showLabelsTitle, st._layerSig, st._parentSig];
    const push = () => {
      st._layerSig = null; st._parentSig = null;
      ex.syncLayerSwitches(); ex.syncParentBorder();
    };

    st.grain = null;
    st.tier = ERA0;                    // 剧本层 → 势力那组
    st.showPowerColor = true; st.showRegionColor = false; push();
    ok('势力·颜色 开 → 原版色显示', ex.renderer.showTitles === true, String(ex.renderer.showTitles));
    st.showPowerColor = false; push();
    ok('势力·颜色 关 → 不上色', ex.renderer.showTitles === false, String(ex.renderer.showTitles));
    st.showPowerBorder = false; push();
    ok('势力·边界 关 → 国家边界关', ex.renderer.borderTitle === false, String(ex.renderer.borderTitle));
    st.showPowerBorder = true;

    // 「势力 · 边界」= 国家/tag 那一层：**统一吃「涂色边界浓度」** ✓
    //   （以前在剧本视图里吃「省份/默认」，跑到链上当父辈时又吃「涂色」→ 同一根线两种浓淡 ✗）
    {
      const svG2 = st.grain, svPB2 = st.showParentBorderTitle, svT3 = st.tier;
      const ca = (st.set && st.set.ca != null ? st.set.ca : 100) / 100;
      st.grain = null;                       // 没有粒度 → 本层就是势力层 ✓
      st.tier = 0;
      st.showParentBorderTitle = false;
      ex.syncParentBorder();
      ok('剧本视图：势力边界的浓度 = 「涂色边界浓度」✓',
         Math.abs(ex.renderer.borderStrength - ca) < 0.01,
         `本层A=${ex.renderer.borderStrength} / 涂色档=${ca}`);
      st.showParentBorderTitle = true;
      ex.syncParentBorder();
      ok('剧本视图 + 父级边界：势力边界仍旧是涂色档（不再降到省份档）✓',
         Math.abs(ex.renderer.borderStrength - ca) < 0.01,
         `本层A=${ex.renderer.borderStrength} / 涂色档=${ca}`);
      st.grain = fineS;                      // 开了粒度 → 本层变成粒度那层，不该再吃涂色档 ✓
      ex.syncParentBorder();
      ok('剧本 + 粒度：本层是粒度层（不是势力层）→ 一律省份档 ✓',
         Math.abs(ex.renderer.borderStrength - 0.5) < 0.01,
         `本层A=${ex.renderer.borderStrength}`);
      st.grain = svG2; st.showParentBorderTitle = svPB2; st.tier = svT3;
      ex.syncParentBorder();
    }

    st.tier = fineS;                   // 细层 → 地区那组
    st.showRegionColor = true; st.showPowerColor = false; push();
    ok('地区·颜色 开 → 细层上色', ex.renderer.showTitles === true, String(ex.renderer.showTitles));
    st.showRegionColor = false; push();
    ok('地区·颜色 关 → 细层不上色', ex.renderer.showTitles === false, String(ex.renderer.showTitles));
    st.showRegionBorder = false; push();
    ok('地区·边界 关 → 细层边界关', ex.renderer.borderTitle === false, String(ex.renderer.borderTitle));
    st.showRegionBorder = true;
    st.showRegionName = false; push();
    ok('地区·名称 关 → 地名关（真字段是 showLabelsTitle）',
       st.showLabelsTitle === false, String(st.showLabelsTitle));
    st.showRegionName = true; push();
    ok('地区·名称 开 → 地名开', st.showLabelsTitle === true, String(st.showLabelsTitle));

    [st.tier, st.grain, st.showPowerColor, st.showPowerBorder,
     st.showRegionColor, st.showRegionBorder, st.showRegionName,
     st.showLabelsTitle, st._layerSig, st._parentSig] = S0;
    push();
  }

  // 边界开关各归各家（脚本 + 地区粒度时最容易串）
  if ((st.meta.eraDates || []).length && get('show-power-border')) {
    const fineB = st.meta.tierNames.length - 1;
    const saved = [st.tier, st.grain, st.showPowerBorder, st.showRegionBorder,
                   st._layerSig, st._parentSig];
    st.tier = ERA0;              // 看剧本配色
    st.grain = fineB;            // 按更细的一层改（粒度）
    st.showRegionBorder = false; // 地区·边界 关
    st.showPowerBorder = true;   // 势力·边界 开
    st._layerSig = null; st._parentSig = null;
    ex.syncLayerSwitches(); ex.syncParentBorder();
    ok('细层（粒度那层）边界听「地区·边界」', ex.renderer.borderTitle === false,
       `borderTitle=${ex.renderer.borderTitle}`);
    ok('关「地区·边界」：只有地区那条关，国家那条还在',
       ex.renderer.extraShows[0] === 0
       && ex.renderer.extraShows[ex.renderer.extraCount - 1] === 1,
       `shows=${Array.from(ex.renderer.extraShows)}`);
    st.showPowerBorder = false;
    st._parentSig = null; ex.syncParentBorder();
    ok('关掉「势力·边界」，国家那条才消失',
       ex.renderer.extraShows[ex.renderer.extraCount - 1] === 0,
       `shows=${Array.from(ex.renderer.extraShows)}`);
    [st.tier, st.grain, st.showPowerBorder, st.showRegionBorder,
     st._layerSig, st._parentSig] = saved;
    ex.syncLayerSwitches(); ex.syncParentBorder();
  }

  // 势力 / 地区 两组开关：按"当前视图属于哪一类"解析
  if ((st.meta.eraDates || []).length && get('show-power-color')) {
    const fine2 = st.meta.tierNames.length - 1;
    const saved = [st.tier, st.showPowerColor, st.showRegionColor, st._layerSig];
    const push = () => { st._layerSig = null; ex.syncLayerSwitches(); };

    st.tier = 0; st.showPowerColor = true; st.showRegionColor = false; push();
    ok('「势力 · 颜色」管剧本（国家）那层', ex.renderer.showTitles === true,
       `showTitles=${ex.renderer.showTitles}`);

    st.tier = fine2; st.showPowerColor = false; st.showRegionColor = true; push();
    ok('「地区 · 颜色」管更细的那几层', ex.renderer.showTitles === true,
       `showTitles=${ex.renderer.showTitles}`);

    st.showRegionColor = false; push();
    ok('「地区 · 颜色」关掉，细层就不上色了', ex.renderer.showTitles === false,
       `showTitles=${ex.renderer.showTitles}`);

    st.tier = 0; st.showPowerColor = false; push();
    ok('回到剧本层，又是「势力」那组说了算', ex.renderer.showTitles === false,
       `showTitles=${ex.renderer.showTitles}`);

    [st.tier, st.showPowerColor, st.showRegionColor, st._layerSig] = saved;
    ex.syncLayerSwitches();
  } else {
    ok('CK3（没有年代层）不拆 势力/地区：仍旧「头衔」一组', true, '✓');
  }

  /* 🔴 **2026-10-17：用户又要了一个「清除荒地」按钮** ✗（id `btn-clear-waste`）——
   *   它跟 2026-10-14 退役的旧按钮不是同一个：新按钮 = 清荒地块手绘色 + 关自动上色，
   *   断言在「荒地自动上色」那一段（`clearWastePaint`）✓
   *   ⚠ 旧的「清除荒地填色」按钮（`waste-clear`）仍然是退役状态 ✗ 别把它加回来 ✓ */

  // 最细那层额外描父级边界（CK3 男爵领→伯爵领 / EU5 地块→省份 / 其他省份→地区）
  if (st.meta.tierNames && st.meta.tierNames.length > 1) {
    const fine = st.meta.tierNames.length - 1;
    const savedT = st.tier;
    const savedGrain = st.grain;
    st.grain = null;              // 别让它走"剧本 + 粒度"那条分支
    st.tier = fine;
    ex.syncParentBorder();
    ok(`最细那层（${st.meta.tierNames[fine]}）会额外描上一层（${st.meta.tierNames[fine - 1]}）的边界`,
       ex.renderer.parentBorder === 1 && ex.renderer.parentTier === fine - 1,
       `parentTier=${ex.renderer.parentTier} 宽=${ex.renderer.parentWidth.toFixed(2)}`);
    ok('最细那层的边界是半透明，父级那条是实心',
       ex.renderer.borderStrength < ex.renderer.parentAlpha,
       `本层 ${ex.renderer.borderStrength} / 父级 ${ex.renderer.parentAlpha}`);
    // 第二细那层也要描（CK3 伯爵领→公爵领 / EU4 地区→上一层 / EU5 省份→地区 …）
    if (fine >= 2) {
      st.tier = fine - 1;
      ex.syncParentBorder();
      ok(`第二细那层（${st.meta.tierNames[fine - 1]}）也描上一层（${st.meta.tierNames[fine - 2]}）`,
         ex.renderer.parentBorder === 1 && ex.renderer.parentTier === fine - 2,
         `parentTier=${ex.renderer.parentTier}`);
    }
    st.tier = fine - 2 >= 0 ? fine - 2 : 0;
    ex.syncParentBorder();
    if ((st.meta.tiers || []).indexOf('loc') < 0 || st.tier !== fine - 1) {
      ok('换到别的层级就不描了', ex.renderer.parentBorder === 0, String(ex.renderer.parentTier));
    } else {
      ok('（这一层本来就要描，跳过"不描"的检查）', true, '-');
    }
    ok('离开最细那层：浓度一律省份档 50（不再分"有没有链" ✓）',
       Math.abs(ex.renderer.borderStrength - 0.5) < 0.01,
       'borderStrength=' + ex.renderer.borderStrength + ' 父级=' + st.showParentBorderTitle);
    // 「默认边界浓度」（da）这一档已经整个去掉了 ✓（用户定的 ✓）
    //   子级那条**任何时候**都吃省份档；旧存档里残留的 da 不许再影响它 ✓
    {
      let _hadDa = false, _svDa;
      if (st.set) { _hadDa = 'da' in st.set; _svDa = st.set.da; st.set.da = 40; }
      st._parentSig = null; ex.syncParentBorder();
      const _aDa = ex.renderer.borderStrength;
      if (st.set) { if (_hadDa) st.set.da = _svDa; else delete st.set.da; }
      st._parentSig = null; ex.syncParentBorder();
      const _h = require('fs').readFileSync('web/index.html', 'utf8');
      const _a = require('fs').readFileSync('web/js/app.js', 'utf8');
      ok('「默认边界浓度」去掉后：残留的 da 不再影响本层（仍省份档 50）✓',
         Math.abs(_aDa - 0.5) < 0.01, `borderStrength=${_aDa}`);
      ok('设置页与代码里都没有这一档了 ✓（控件、字段、绑定全撤 ✓）',
         !_h.includes('set-da') && !_h.includes('默认边界浓度')
         && !_a.includes('set.da') && !_a.includes("'set-da'"),
         `page=${_h.includes('set-da')} code=${_a.includes('set.da')}`);
    }
    // 剧本 + 粒度：边界也该调淡（画面是剧本配色，低级单位只是描边参考）
    {
      const savedG = st.grain;
      const savedT2 = st.tier;
      const savedPB = st.showParentBorderTitle;
      st.showParentBorderTitle = true;    // 开了父级才有链 → 子级吃「省份」档 ✓
      st.tier = ERA0;                    // 剧本/年代那一层
      st.grain = fine;                   // 粒度落在低级单位上
      ex.syncParentBorder();
      ok('剧本 + 粒度：本层浓度一律省份档（跟「父级边界」无关 ✓）',
         st.grain != null && Math.abs(ex.renderer.borderStrength - 0.5) < 0.01,
         `grain=${st.grain} 浓度=${ex.renderer.borderStrength} 父级=${st.showParentBorderTitle}`);
      if ((st.meta.eraDates || []).length) {
        ok('开粒度时链只有两条：上一层 + 剧本那一层（中间层不画）',
           ex.renderer.extraCount === 2
           && ex.renderer.extraTiers[0] === fine - 1
           && ex.renderer.extraTiers[1] === st.tier,
           `count=${ex.renderer.extraCount} tiers=${Array.from(ex.renderer.extraTiers)}`);
        ok('填色边界用链上最粗那条的粗细、且实心（吃「涂色」档）',
           Math.abs(ex.renderer.paintWidth - ex.renderer.extraWs[ex.renderer.extraCount - 1]) < 0.01
           && ex.renderer.paintAlpha === 1.0,
           'paintW=' + ex.renderer.paintWidth.toFixed(2) + ' 上两层='
           + ex.renderer.extraWs[ex.renderer.extraCount - 1].toFixed(2)
           + ' alpha=' + ex.renderer.paintAlpha);
        ok('链上各环的 alpha：剧本层=涂色档 1.0、其余父辈=地区档 0.75（链空则跳过）',
         (() => {
           const n = ex.renderer.extraCount || 0;
           if (!n) return true;                       // 没链就不适用 ✓
           const as = Array.from(ex.renderer.extraAs).slice(0, n);
           const nEra = (st.meta.eraDates || []).length;
           return as.every((v, k) => {
             const isEra = nEra > 0 && ex.renderer.extraTiers[k] < nEra;
             return Math.abs(v - (isEra ? 1.0 : 0.75)) < 0.01;
           });
         })(),
         'alphas=' + Array.from(ex.renderer.extraAs).slice(0, ex.renderer.extraCount || 0).join(','));
        ok('越往上越粗（国家比地区粗一档）',
           ex.renderer.extraWs[0] < ex.renderer.extraWs[ex.renderer.extraCount - 1],
           `${ex.renderer.extraWs[0].toFixed(2)} < `
           + `${ex.renderer.extraWs[ex.renderer.extraCount - 1].toFixed(2)}`);
        /* 🔴🔴 **2026-10-16 重写** ✗✗（handover §3.4 第 6 步 ✓）
         *  原文量的字段叫 `renderer.waterW` / `waterA` ✓ —— 那一套**早退役了** ✗
         *  现在这条通道的字段是 **`waterBorderW` / `waterBorderA`** ✓
         *  （名字跟 uniform `uWaterBorderW/A` 对齐 ✓ 别跟"填色那条"混 ✓）
         *  要量的三件事一条都没变 ✓：
         *    · 粗细 = 设置里那个格数（**不跟链、不跟本层那条线** ✓）
         *    · 不跟「基准线宽 / 地区宽度」缩放 ✓
         *    · 改设置立刻跟着变 ✓
         *  ⚠ **荒地那一对（wasteW/wasteA）不再量** ✗ —— 它整对退役了 ✓
         *    用户 2026-10-16 只点名了水域（handover §3.4："只加水域那两条滑条"✓）*/
        {
          const _svW = st.set ? st.set.w : undefined;
          const _svWRegion = st.set ? st.set.wRegion : undefined;
          const _svWW = st.set ? st.set.waterW : undefined;
          const _svWA = st.set ? st.set.waterA : undefined;
          if (st.set) { st.set.w = 2; st.set.wRegion = 2; st.set.waterW = 1; st.set.waterA = 100; }
          ex.syncParentBorder();
          const _w1 = ex.renderer.waterBorderW;
          const _a1 = ex.renderer.waterBorderA;
          if (st.set) { st.set.w = 4; st.set.wRegion = 4; }   // 基准 / 地区宽度拉两倍 → **不该影响它** ✓
          ex.syncParentBorder();
          const _w2 = ex.renderer.waterBorderW;
          if (st.set) st.set.waterW = 2.5;                    // 直接改「水域边界宽度」→ 它才跟着变 ✓
          ex.syncParentBorder();
          const _w3 = ex.renderer.waterBorderW;
          if (st.set) st.set.waterA = 50;                     // 浓度同理 ✓
          ex.syncParentBorder();
          const _a3 = ex.renderer.waterBorderA;
          if (st.set) {
            if (_svW === undefined) delete st.set.w; else st.set.w = _svW;
            if (_svWRegion === undefined) delete st.set.wRegion; else st.set.wRegion = _svWRegion;
            if (_svWW === undefined) delete st.set.waterW; else st.set.waterW = _svWW;
            if (_svWA === undefined) delete st.set.waterA; else st.set.waterA = _svWA;
          }
          ex.syncParentBorder();
          ok('水域边界：粗细 = 设置里那个格数（不跟链、不跟本层那条线 ✓）',
             Math.abs(_w1 - 1) < 0.001,
             `waterBorderW=${_w1} 链上最粗=${ex.renderer.extraWs[ex.renderer.extraCount - 1].toFixed(2)}`
             + ` 本层=${ex.renderer.borderWidth.toFixed(2)}`);
          ok('水域边界：不再跟「基准线宽 / 地区宽度」缩放，只认「水域边界宽度」那一档 ✓',
             Math.abs(_w2 - 1) < 0.001 && Math.abs(_w3 - 2.5) < 0.001,
             `基准/地区拉两倍后=${_w2}（应仍是 1）  改水域宽度=2.5 → ${_w3}`);
          ok('水域边界：浓度也吃自己那一档（100% → 1.0、50% → 0.5 ✓ 实心默认 ✓）',
             Math.abs(_a1 - 1.0) < 0.001 && Math.abs(_a3 - 0.5) < 0.001,
             `默认=${_a1}（应 1.0）  改成 50% → ${_a3}`);
          ok('荒地那对字段仍然退役（这次只请回水域 ✓）',
             ex.renderer.wasteW === undefined && ex.renderer.wasteA === undefined,
             `wasteW=${ex.renderer.wasteW} wasteA=${ex.renderer.wasteA}`);
        }
        {
          // 换个状态再看一遍：剧本层 + 没粒度（本层那条线这时是 1.5 的势力线 ✓）也不许动
          const _svG2 = st.grain, _svT3 = st.tier;
          st.grain = null; st.tier = ERA0;
          ex.syncParentBorder(); ex.syncLayerSwitches();
          ok('水域边界：换成"剧本层 + 没粒度"（本层 1.5）也还是 1 格 ✓',
             Math.abs(ex.renderer.waterBorderW - 1) < 0.001,
             `waterBorderW=${ex.renderer.waterBorderW}`
             + ` 本层=${ex.renderer.borderWidth.toFixed(2)}`);
          st.grain = _svG2; st.tier = _svT3;
          ex.syncParentBorder(); ex.syncLayerSwitches();
        }
      } else {
        ok('CK3（头衔体系）：地理链只描父级一层（"爷爷"是填色的线，不是地理单位）',
           ex.renderer.extraCount === 1 && ex.renderer.extraTiers[0] === fine - 1,
           `count=${ex.renderer.extraCount} tiers=${Array.from(ex.renderer.extraTiers)}`);
      }
      st.grain = savedG;
      st.tier = savedT2;
      st.showParentBorderTitle = savedPB;
      ex.syncParentBorder();
    }
    st.tier = savedT;
    st.grain = savedGrain;
    st._parentSig = null;
    ex.syncParentBorder();
  }

  if (isEU4 || isHoi4) {
  console.log('\n=== 2e. 年份视图的粒度：视图那一排兼作粒度开关 ===');
  {
    // 年份层有几个由数据决定（EU4 三个、HOI4 两个），下面一律用 n 说话
    const n = st.meta.eraDates.length;
    // 第 0 层是**空白剧本** ✓ —— 年份按钮从 ERA0 起，细层跟着往后挪一位 ✓
    const T_ERA = ERA0;            // 第一个**有主**的年份（EU4 1444 / HOI4 1936）
    const T_Y2 = ERA0 + 1;         // 紧接着的第二个年份（EU4 1618 / HOI4 1939）
    /* 🔴 **2026-10-19：第一级地理层不是"年份数"了** ✗✗
     *   年份层后面还夹着**空白剧本**那一层 ✓ 它也算剧本块 ✓
     *   → 地理层从 `年份数 + 1` 开始（EU4 是 13 层「大洲」✓）
     *   ⚠ 写 `N_ERA` 会指到空白层 ✗ 那条断言验的是"按一下就换粒度"，
     *     空白层是个剧本层 → 行为完全不同 → 红得莫名其妙 ✓（我已经踩过一次 ✓）*/
    {
      const _bl = st.meta.tierNames.indexOf('空白剧本');
      var _ERA_BLOCK0 = (_bl === N_ERA) ? N_ERA + 1 : N_ERA;
    }
    const T_A = _ERA_BLOCK0;       // 年份块之后第一级（EU4 大洲 / HOI4 战略）
    const T_B = _ERA_BLOCK0 + 1;   // 再下一级（EU4 大区 / HOI4 地区）
    /* 🔴 **2026-10-19：剧本收进下拉栏了，按钮查找要分家** ✗✗
     *   剧本块（年份 + 空白）在 `[data-role="era-panel"]` 的 `.dd-item` 里 ✓
     *   地理层在 `containers.tier.children` 里 ✓
     *   ⚠ 剧本块的层数 = 有主年份数 + （紧跟其后的空白层）✓ 不是 ERA 数 ✗
     *     （跟 app.js 的 `eraBlockCount()` 同一口径 ✓）*/
    const ERA_N = N_ERA;                                     // 有主的年份层数（模块级 ✓）
    const BLANK_N = st.meta.tierNames.indexOf('空白剧本');
    const ERA_BLOCK = (BLANK_N === ERA_N) ? ERA_N + 1 : ERA_N;
    /* ⚠ **2026-10-20：剧本 ≥4 个才收进下拉栏** ✓ 少于 4 个回退成按钮 ✓
     *   HOI4 是 3 层（1936 / 1939 / 空白）→ 改阈值后落到**回退模式** ✓
     *   那时剧本就是这一排里的普通按钮 ✓ 查找方式也得跟着换 ✗ */
    const USE_DD = ERA_BLOCK >= 4;
    const panelEl = documentStub.querySelector('[data-role="era-panel"]');
    const btnOf = (i) => ((USE_DD && i < ERA_BLOCK)
      ? (panelEl.children || []).find((b) => Number(b.dataset.tier) === i)
      : containers.tier.children.find((b) => Number(b.dataset.tier) === i));
    const isOn = (i) => !!(btnOf(i) && btnOf(i).classList.contains('on'));
    const isGrain = (i) => !!(btnOf(i) && btnOf(i).classList.contains('grain'));

    ex.setTier(T_ERA);                               // 切到第一个有主的年份
    const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    ok('没有多出来的那一排按钮（视图那一排就够）',
       containers.tier.children.length === (USE_DD
         ? st.meta.tierNames.length - ERA_BLOCK : st.meta.tierNames.length)
       && !html.includes('grain-group'),
       `这一排 ${containers.tier.children.length} 个（${USE_DD ? '应 ' + (st.meta.tierNames.length - ERA_BLOCK) : '回退模式，应 ' + st.meta.tierNames.length}）`
       + ` · 下拉栏 ${(panelEl.children || []).length} 个`);
    ok(USE_DD ? '剧本全在下拉栏里（不占视图那一排 ✓）' : '剧本只有 3 个 → 就在这一排里（回退 ✓）',
       (panelEl.children || []).length === (USE_DD ? ERA_BLOCK : 0),
       `下拉栏 ${(panelEl.children || []).length} 项 / 剧本块 ${ERA_BLOCK} 层`);
    ok('默认按国家：编辑层 = 视图层', ex.editTier() === T_ERA, String(ex.editTier()));
    ok('只有一个亮着', isOn(T_ERA) && !isGrain(T_ERA) && !isOn(T_B) && !isGrain(T_B),
       `年份 on=${isOn(T_ERA)} grain=${isGrain(T_ERA)} / 下一级 on=${isOn(T_B)} grain=${isGrain(T_B)}`);

    // 按一下"地区" —— 一步就够，不该还要去别处勾
    ex.pressTier(T_A);
    ok('按一下下一级就换到那一级粒度', ex.editTier() === T_A, String(ex.editTier()));
    ok('渲染器跟上了', ex.renderer.editTier === T_A, String(ex.renderer.editTier));
    ok('视图没动，画面还是年份那一层的配色',
       ex.renderer.tier === T_ERA && st.tier === T_ERA,
       `tier=${ex.renderer.tier} editTier=${ex.renderer.editTier}`);
    ok('两个按钮一起亮，主次分得开（视图金色、粒度弱一档）',
       isOn(T_ERA) && isGrain(T_A) && !isOn(T_A),
       `年份 on=${isOn(T_ERA)} / 下一级 on=${isOn(T_A)} grain=${isGrain(T_A)}`);

    // 换成省份粒度
    ex.pressTier(T_B);
    ok('按更细那一级 = 整档换成它', ex.editTier() === T_B && isGrain(T_B) && !isGrain(T_A),
       `edit=${ex.editTier()} 细 grain=${isGrain(T_B)} 上一级 grain=${isGrain(T_A)}`);

    // 再按一下同一级 = 取消，回到按国家（每个按钮都是开/关）
    ex.pressTier(T_B);
    ok('再按一下它 = 取消粒度，回到按国家', ex.editTier() === T_ERA && !isGrain(T_B),
       `edit=${ex.editTier()} 细 grain=${isGrain(T_B)}`);
    ok('取消之后仍旧只有视图一个亮着', isOn(T_ERA) && !isGrain(T_ERA) && !isOn(T_B),
       `年份 on=${isOn(T_ERA)} / 细 on=${isOn(T_B)} grain=${isGrain(T_B)}`);

    ex.pressTier(T_A);
    ex.pressTier(T_A);
    ok('那一级也是按一下开、再按一下关', ex.editTier() === T_ERA && !isGrain(T_A),
       `edit=${ex.editTier()} 那一级 grain=${isGrain(T_A)}`);

    ex.pressTier(T_B);
    // 再按一下当前年份 = 取消
    ex.pressTier(T_ERA);
    ok('再按一下当前年份 = 取消，年份配色退掉、落到细层视图',
       st.tier === T_B && ex.editTier() === T_B && ex.renderer.tier === T_B,
       `tier=${st.tier} edit=${ex.editTier()}`);
    ok('取消之后只剩一个亮着', isOn(T_B) && !isGrain(T_B) && !isOn(T_ERA),
       `细 on=${isOn(T_B)} grain=${isGrain(T_B)}`);

    // 反方向：从省份模式按年份，配成一对（年份配色 + 省份粒度）
    ex.pressTier(T_Y2);                                // 细层视图上按第二个年份
    ok('细层视图上按年份 = 那年配色 + 细层粒度',
       st.tier === T_Y2 && ex.editTier() === T_B,
       `tier=${st.tier} edit=${ex.editTier()}`);
    ok('两个按钮都亮：年份金色、细层弱蓝',
       isOn(T_Y2) && isGrain(T_B) && !isOn(T_B),
       `1618 on=${isOn(1)} / 省份 on=${isOn(4)} grain=${isGrain(4)}`);
    ok('配色层跟着那一年走', ex.renderer.tier === T_Y2 && ex.renderer.editTier === T_B,
       `tier=${ex.renderer.tier} editTier=${ex.renderer.editTier}`);
    ex.pressTier(T_Y2);
    ok('再按一下那一年 = 拆开，退回细层视图',
       st.tier === T_B && ex.editTier() === T_B && !isGrain(T_B),
       `tier=${st.tier} edit=${ex.editTier()} 省 grain=${isGrain(4)}`);

    // 配好之后换个年份，粒度跟着走（"另一个年份"= 最后一个年份层，别写死 2）
    ex.pressTier(T_ERA);
    ex.pressTier(n - 1);
    ok('配对之后换个年份，粒度还是那一级',
       st.tier === n - 1 && ex.editTier() === T_B && isOn(n - 1) && isGrain(T_B),
       `tier=${st.tier} edit=${ex.editTier()}`);
    ex.pressTier(T_ERA);
    ok('从另一个年份 + 细层 按第一个年份：换配色，粒度不动',
       st.tier === T_ERA && ex.editTier() === T_B && isOn(T_ERA) && isGrain(T_B),
       `tier=${st.tier} edit=${ex.editTier()}`);
    ex.pressTier(T_B);
    ok('按一下粒度那一级 = 拆开，回到年份的整国粒度',
       st.tier === T_ERA && ex.editTier() === T_ERA && !isGrain(T_B),
       `tier=${st.tier} edit=${ex.editTier()}`);

    // 回到年份视图，粒度是干净的
    ex.pressTier(T_ERA);
    ok('重新进年份视图，粒度回到按国家', ex.editTier() === T_ERA && !isGrain(T_B),
       `edit=${ex.editTier()} 省 grain=${isGrain(4)}`);
    ex.pressTier(T_Y2);
    ok('换个年份：粒度保持按国家、视图跟着换',
       st.tier === T_Y2 && ex.editTier() === T_Y2 && isOn(T_Y2));

    // 端到端：按省份粒度真的只涂到那一个省份
    // **粒度要落在这一作的「省份」层上** ✓ —— EU4 是 5、HOI4/V3 是 4：
    // 写死 4 的话 EU4 选到的是「地区」层，下面那条"隔壁省份没被连坐"
    // 就变成"隔壁地区"，是测试自己错了 ✗（产品行为一直是对的）
    const _provTier = st.meta.tierNames.indexOf('省份');
    const _provT = _provTier >= 0 ? _provTier : LAST_TIER;
    ex.pressTier(T_ERA);
    ex.pressTier(_provT);
    const W = st.meta.mapWidth, H = st.meta.mapHeight, NP = st.meta.numProvinces;
    const tm = st.titlemap;
    // 拿一块**在图上、且没锁**的地当锚：HOI4 的 1 号省是个湖，不能用
    const anchor = isHoi4 ? 3838 : 1;
    const country = ex.titleAt(anchor, T_ERA);
    let target = -1, mate = -1;
    for (let p = 1; p < NP; p++) {
      // 同一国家、且**省份节点**跟锚点不同的两块地（同一层比才有意义 ✓）
      if (tm[T_ERA * NP + p] !== country || tm[_provT * NP + p] === ex.titleAt(anchor, _provT)) continue;
      if (target < 0) target = p; else { mate = p; break; }
    }
    ok('找得到同国但不同省份的两块地', target > 0 && mate > 0, `#${target} / #${mate}`);

    // 屏幕坐标 → 地图坐标走的是 screenToMap（$('stage') + 相机），把它倒过来。
    // 取像素**正中**（+0.5），不然浮点误差会把结果推到前一个像素去。
    const stg = get('stage');
    const vw = stg.clientWidth / st.cam.scale;
    const vh = stg.clientHeight / st.cam.scale;
    const vx = st.cam.cx - vw / 2;
    const vy = st.cam.cy - vh / 2;
    const toClient = (mx, my) => [(mx + 0.5 - vx) / vw * stg.clientWidth,
                                  (my + 0.5 - vy) / vh * stg.clientHeight];

    let ax = -1, ay = -1;
    for (let y = 0; y < H && ay < 0; y += 3) {
      for (let x = 0; x < W; x += 3) {
        if (st.provinceIds[y * W + x] === target) { ax = x; ay = y; break; }
      }
    }
    ok('找得到那块地的一个像素', ax >= 0 && ay >= 0, `${ax},${ay}`);
    const back = ex.screenToMap(...toClient(ax, ay));
    ok('屏幕坐标反过来能落回同一个地块',
       Math.abs(back[0] - (ax + 0.5)) < 0.51 && Math.abs(back[1] - (ay + 0.5)) < 0.51,
       `${ax},${ay} → ${back.map((v) => v.toFixed(3)).join(',')}`);

    // 取色统一取"画面上这一刻的颜色"：配色层永远是视图那一层，
    // 所以粒度换到省份时，吸管吸的仍然是 1444 的国色。（趁这块还没被涂过先验）
    {
      // 原版配色现在**默认关**（各模式的新默认）—— 这几条验的是"吸到的是显示色"，
      // 先把头衔色打开，屏幕上显示的和拾取到的就该是同一个色 ✓
      st.showTitles = true;
      ex.renderer.setShowTitles(true);
      const cty = ex.titleAt(target, T_ERA);
      const provTid = ex.titleAt(target, LAST_TIER);
      ok('两个色本来就不一样，下面那条断言才有意义',
         JSON.stringify(st.titles.colors[cty]) !== JSON.stringify(st.titles.colors[provTid]),
         `1444 国色 ${st.titles.colors[cty]} vs 省份色 ${st.titles.colors[provTid]}`);
      ex.setTool('pick');
      ex.setBrush([1, 2, 3], true);
      ex.actAt(...toClient(ax, ay));
      ok('粒度是省份时，吸管吸的是 1444 的国色',
         JSON.stringify(st.brush) === JSON.stringify(st.titles.colors[cty]),
         `吸到 ${st.brush}`);
      ok('吸到的标记也是 1444 那个国家的名字',
         st.brushLabel === st.titles.names[cty],
         `${st.brushLabel} / ${st.titles.names[cty]}`);
      ex.pickAt(...toClient(ax, ay));       // 右键取色走的是同一条规则
      ok('右键取色也一样取 1444 的国色',
         JSON.stringify(st.brush) === JSON.stringify(st.titles.colors[cty]),
         `吸到 ${st.brush}`);
    }

    ex.setTool('paint');
    ex.setBrush([12, 200, 90], true);
    ex.actAt(...toClient(ax, ay));

    const ti = target * 4, mi = mate * 4;
    ok('落笔涂到的是那个省份自己',
       ex.renderer.paintData[ti + 3] > 0 && ex.renderer.paintData[ti] === 12,
       [...ex.renderer.paintData.slice(ti, ti + 4)].join(','));
    ok('同一国家的隔壁省份没被连坐（粒度就是这件事）',
       ex.renderer.paintData[mi + 3] === 0,
       [...ex.renderer.paintData.slice(mi, mi + 4)].join(','));

    // 换成按国家，同一个位置应该整国一起变
    // **新规则**（用户给的）：指着**涂过**的地时，目标同时认两样 ——
    //   涂过的那些按"**填色归属**"（同色同标记 ✓）、
    //   没涂过的那些按"**剧本归属名字**"✓
    // 所以这一国里**没涂过的邻省也会被一起涂上**（标记名用这一国的名字就必然对得上 ✓）
    ex.setGrain(null);
    st.brushLabel = String(st.titles.names[ex.titleAt(target, ERA0)] || '');
    st.brush = [200, 12, 90];
    ex.actAt(...toClient(ax, ay));
    ok('换回按国家之后：这一国没涂过的邻省也一起涂上（剧本归属名字对得上 ✓ 用户规则 ②）',
       ex.renderer.paintData[mi + 3] > 0,
       [...ex.renderer.paintData.slice(mi, mi + 4)].join(','));

    // 擦干净，别影响后面几组
    ex.restoreTitle(country);
    ex.restoreTitle(ex.titleAt(target, LAST_TIER));
    ok('这一组涂完擦干净了（后面几组看的是干净状态）',
       ex.renderer.paintData[ti + 3] === 0 && ex.renderer.paintData[mi + 3] === 0,
       `${[...ex.renderer.paintData.slice(ti, ti + 4)].join(',')} / `
       + `${[...ex.renderer.paintData.slice(mi, mi + 4)].join(',')}`);

    // 离开年份视图 / 从细层级按年份
    ex.setTier(T_A);
    ok('离开年份视图，编辑层就跟视图一致', ex.editTier() === T_A, String(ex.editTier()));
    ex.setGrain(T_B);
    ok('非年份视图里设粒度不生效', ex.editTier() === T_A, String(ex.editTier()));
    ex.pressTier(T_ERA);
    ok('从细层视图按年份 = 那年配色 + 细层粒度（跟当前这一层配对，不是残留的粒度）',
       st.tier === T_ERA && ex.editTier() === T_A
       && ex.renderer.tier === T_ERA && ex.renderer.editTier === T_A,
       `tier=${st.tier} edit=${ex.editTier()} 渲染 ${ex.renderer.tier}/${ex.renderer.editTier}`);

    // 悬停卡片那几行走 gotoLevel：点谁就是按谁编辑，不配对也不取消
    ex.setGrain(null);
    ex.gotoLevel(T_A);
    ok('年份视图里点细层是换粒度，不切视图',
       st.tier === T_ERA && ex.editTier() === T_A, `tier=${st.tier} edit=${ex.editTier()}`);
    ex.gotoLevel(T_ERA);
    ok('点回年份那一层 = 回到按国家', ex.editTier() === T_ERA, String(ex.editTier()));

    ex.setTier(st.meta.defaultTier);
    ex.setGrain(null);
  }
  }

  if (isVic3) {
    // V3 只有一个开局（1836.1.1），年份层只有一层 —— 但"按一下更细的层 =
    // 换粒度"这套逻辑照样成立（细层级 = 战略 / 地区 / 省份）
    console.log('\n=== 2e. V3 单开局下也有粒度 ===');
    const V_ERA = ERA0;                     // 1836 那一层（空白剧本之后 ✓）
    const V_ST = tierOf('地区');             // V3 的「地区」= 州（STATE ✓）
    ex.setTier(V_ERA);                                // 先到 1836 那一层
    ok('默认按国家：编辑层 = 视图层', ex.editTier() === V_ERA, String(ex.editTier()));
    ex.pressTier(V_ST);
    ok('按一下"地区"就换到州粒度', ex.editTier() === V_ST && st.tier === V_ERA,
       `tier=${st.tier} edit=${ex.editTier()}`);
    ok('配色层没动（还是 1836 的国家色）', ex.renderer.tier === V_ERA && ex.renderer.editTier === V_ST,
       `tier=${ex.renderer.tier} editTier=${ex.renderer.editTier}`);
    ex.pressTier(V_ST);
    ok('再按一下取消，回到按国家', ex.editTier() === V_ERA, String(ex.editTier()));
    // 从"地区"视图按 1836 = 配成一对（年份出配色、细层级出边界和笔刷）
    ex.setTier(V_ST);
    ex.pressTier(V_ERA);
    ok('从地区视图按 1836 = 配成一对', st.tier === V_ERA && ex.editTier() === V_ST,
       `tier=${st.tier} edit=${ex.editTier()}`);
    ex.pressTier(V_ERA);
    ok('再按一下 1836 = 拆开，退回地区视图', st.tier === V_ST && ex.editTier() === V_ST,
       `tier=${st.tier} edit=${ex.editTier()}`);
    ex.setTier(st.meta.defaultTier);
    ex.setGrain(null);
  }

  const tid = ex.titleAt(probe, LAST_TIER);
  const orig = st.titles.colors[tid].slice();
  // 取色 = 取**此刻看到的颜色**。这条规则要分两种状态各验一次才算完整：
  //   原版配色关着（各模式的新默认）→ 画面是底色灰，取到就该是灰；
  //   打开配色 → 才是头衔原色。
  // （这块要是之前被涂过，手绘层优先级最高，灰色那条就不适用，跳过它。）
  const probePainted = ex.renderer.paintData[probe * 4 + 3] > 0;
  st.showTitles = false;
  ex.renderer.setShowTitles(false);
  ok('原版配色关着时，取色取到的是底色灰',
     probePainted || JSON.stringify(ex.displayedColor(probe, tid)) === JSON.stringify([150, 150, 150]),
     probePainted ? '这块涂过，跳过' : JSON.stringify(ex.displayedColor(probe, tid)));
  st.showTitles = true;
  ex.renderer.setShowTitles(true);
  ok('取色取的是当前显示色', JSON.stringify(ex.displayedColor(probe, tid)) === JSON.stringify(orig),
     JSON.stringify(orig));

  ex.paintTitle(tid, [12, 200, 90]);
  const p4 = probe * 4;
  ok('涂色写进了手绘层', ex.renderer.paintData[p4 + 3] > 0 &&
     ex.renderer.paintData[p4] === 12 && ex.renderer.paintData[p4 + 1] === 200,
     [...ex.renderer.paintData.slice(p4, p4 + 4)].join(','));
  ok('取色现在拿的是涂过的色',
     JSON.stringify(ex.displayedColor(probe, tid)) === JSON.stringify([12, 200, 90]),
     JSON.stringify(ex.displayedColor(probe, tid)));
  ok('需要还原', ex.needsRestore(tid) === true);

  ex.saveProject();
  const save = JSON.parse(store.get(want.key) || '{}');
  const tkey = st.titles.keys[tid];
  ok('刷新后涂色不留下来（要用「导出涂色」存文件）',
       !store.get(want.key), String(store.get(want.key)));
  const other = isEU4 ? 'ck3-map-editor/v1' : 'eu4-map-editor/v1';
  ok(`没碰 ${other} 的槽`, !store.has(other), [...store.keys()].join(','));

  ex.restoreTitle(tid);
  ok('还原回到游戏原色',
     JSON.stringify(st.titles.colors[tid]) === JSON.stringify(orig),
     JSON.stringify(st.titles.colors[tid]));
  ok('还原后手绘层擦掉了', ex.renderer.paintData[p4 + 3] === 0);
  ok('还原后不需要再还原', ex.needsRestore(tid) === false);

    // 涂一个「跟原色一模一样」的颜色，也必须擦得掉 ——
    // 还原的判据是"玩家涂过没有"，不是"颜色跟原色一不一样"。
    // （以前按后者判，于是玩家吸自己的色再涂回同一块地，就永远擦不掉了）
    {
      const same = st.titles.colors[tid].slice();
      ex.paintTitle(tid, same);
      ok('涂成原色也算涂过，还原工具认它', ex.needsRestore(tid) === true);
      ex.restoreTitle(tid);
      ok('涂成原色的那种也能擦掉', ex.needsRestore(tid) === false);
    }

  console.log('\n=== 3b. 涂色是「新建玩家填色区」，不改头衔色 ===');
  {
    // 玩家填色以前是**同时**改头衔色和手绘层的，于是关掉填色那层之后，
    // 底下那份改过的头衔色还在 LUT 里顶着 —— 填色永远藏不掉。
    const w = st.meta.colorLutWidth || 256;
    const lutAt = (t) => {
      const i = (Math.floor(t / w) * w + (t % w)) * 4;
      return [...ex.renderer.lutData.slice(i, i + 3)];
    };
    const orig = st.titles.colors[tid].slice();
    // 这个头衔名下的第一格（问"涂的色记在哪"时落到地块上 ✓）
    const _firstPid = (() => {
      const nn = st.meta.numProvinces, tmm = st.titlemap, t0 = st.titles.tiers[tid];
      for (let q = 1; q < nn; q++) if (tmm[t0 * nn + q] === tid) return q;
      return 0;
    })();
    ex.paintTitle(tid, [12, 200, 90]);
    ok('涂色之后 LUT 里还是游戏原色（头衔色没被改）',
       JSON.stringify(lutAt(tid)) === JSON.stringify(st.titles.colors[tid]),
       JSON.stringify(lutAt(tid)));
    ok('头衔色表也没动',
       JSON.stringify(st.titles.colors[tid]) === JSON.stringify(st.titles.colors[tid]),
       JSON.stringify(st.titles.colors[tid]));
    ok('涂的色记在手绘层里',
       !!(_firstPid > 0 && ex.renderer.paintData[_firstPid * 4 + 3] > 0
          && ex.renderer.paintData[_firstPid * 4] === 12
          && ex.renderer.paintData[_firstPid * 4 + 1] === 200
          && ex.renderer.paintData[_firstPid * 4 + 2] === 90),
       _firstPid > 0 ? [...ex.renderer.paintData.slice(_firstPid * 4, _firstPid * 4 + 4)].join(',') : '没找到地块');

    const cb = get('show-paint');
    const fire = (v) => { cb.checked = v; for (const fn of cb._listeners.change || []) fn({ target: cb }); };

    fire(false);
    ok('关掉填色，LUT 回到游戏原色（画面才真的没被涂过）',
       JSON.stringify(lutAt(tid)) === JSON.stringify(orig),
       `${JSON.stringify(lutAt(tid))} vs 原色 ${JSON.stringify(orig)}`);
    ok('关掉填色时头衔色本来就是原色（压根没改过）',
       JSON.stringify(st.titles.colors[tid]) === JSON.stringify(orig),
       JSON.stringify(st.titles.colors[tid]));
    ok('手绘层也还在，只是不显示',
       ex.renderer.paintData[probe * 4 + 3] > 0,
       [...ex.renderer.paintData.slice(probe * 4, probe * 4 + 4)].join(','));

    fire(true);
    ok('再打开填色，涂的色又露出来（LUT 还是原色）',
       JSON.stringify(ex.displayedColor(probe, tid)) === JSON.stringify([12, 200, 90]),
       JSON.stringify(ex.displayedColor(probe, tid)));
    ex.restoreTitle(tid);
    ok('这一组擦干净了', JSON.stringify(lutAt(tid)) === JSON.stringify(orig),
       JSON.stringify(lutAt(tid)));
  }

  console.log('\n=== 3c. 同色的相邻色块，标记不一样就得各标各的名字 ===');
  {
    // 找一对**相邻的、属于不同头衔的**陆地省份
    const NP = st.meta.numProvinces;
    const adj = st.adjacency;
    const off = new Uint32Array(adj.buffer, adj.byteOffset, NP + 1);
    const nb = new Uint16Array(adj.buffer, adj.byteOffset + (NP + 1) * 4);
    let a = -1, b = -1;
    for (let p = 1; p < NP && a < 0; p++) {
      const ta = ex.titleAt(p, LAST_TIER);
      if (ta === 65535 || ex.isLocked(ta)) continue;
      for (let k = off[p], e = off[p + 1]; k < e; k++) {
        const q = nb[k];
        if (q <= 0 || q >= NP) continue;
        const tq = ex.titleAt(q, LAST_TIER);
        if (tq === 65535 || ex.isLocked(tq) || tq === ta) continue;
        a = p; b = q; break;
      }
    }
    ok('找得到一对相邻的、不同头衔的陆地省份', a > 0 && b > 0, `#${a} / #${b}`);

    const C = [200, 30, 90];
    st.brushLabel = '甲';
    ex.paintTitle(ex.titleAt(a, LAST_TIER), C);
    st.brushLabel = '乙';
    ex.paintTitle(ex.titleAt(b, LAST_TIER), C);

    st.showTitles = false;      // 常规模式（头衔关、手绘开）才画色块名
    st.showPaint = true;
    ex.rebuildPaintBlocks();
    // 现在**全图每个国家都带名字进 paintBlocks** ✓（没涂过的用原版名 ✓）
    // → 这几条断言只看测试自己涂的那几族（甲/乙/丙/丁 ✓）
    const mine = (s) => (s.paintBlocks || []).filter((p) => ['甲', '乙', '丙', '丁'].indexOf(p.name) >= 0);
    const names = mine(st).map((p) => p.name).sort();
    ok('两个相邻色块各留一个名字（颜色一样、标记不一样）',
       mine(st).length === 2 && names.join('/') === '乙/甲',
       `${mine(st).length} 块：${names.join(' / ')}`);
    // 顺便量一下这两个名字画在什么位置、多大 —— 离太近就会糊成一个
    {
      const L = ex.labels;
      const saved = L.scale;
      L.scale = 2;
      const info = mine(st).map((p) => ({
        name: p.name, x: Math.round(p.x), y: Math.round(p.y),
        font: Math.round(L._fontSize(p.area)),
      }));
      L.scale = saved;
      const d = Math.hypot(info[0].x - info[1].x, info[0].y - info[1].y);
      console.log(`    位置：${info.map((i) => `${i.name}(${i.x},${i.y}) ${i.font}px`).join('  ')}`);
      console.log(`    两点相距 ${d.toFixed(0)} 地图像素`);
    }

    // 反过来：同一支笔铺的相邻两块**应该**并成一块
    st.brushLabel = '丙';
    ex.paintTitle(ex.titleAt(a, LAST_TIER), C);
    ex.paintTitle(ex.titleAt(b, LAST_TIER), C);
    ex.rebuildPaintBlocks();
    ok('同一支笔的相邻两块并成一块（免得一个名字标两遍）',
       mine(st).length === 1 && mine(st)[0].name === '丙',
       `${mine(st).length} 块：${mine(st).map((p) => p.name).join(' / ')}`);

    // 同色同标记铺成两块**互不相邻**的地方：**每一块各露一个名字** ✓
    // （本轮的规矩：一个连通域一个名字 —— 以前是"只留最大那块" ✗）
    {
      ex.restoreTitle(ex.titleAt(a, LAST_TIER));       // 先把上一段的丙擦掉
      ex.restoreTitle(ex.titleAt(b, LAST_TIER));
      const far = [];
      for (let p = 1; p < NP && far.length < 1; p++) {
        const t = ex.titleAt(p, LAST_TIER);
        if (t === 65535 || ex.isLocked(t) || p === a) continue;
        let touches = false;
        for (let k = off[a], e = off[a + 1]; k < e; k++) if (nb[k] === p) touches = true;
        if (!touches) far.push(p);
      }
      st.brushLabel = '丁';
      ex.paintTitle(ex.titleAt(a, LAST_TIER), C);
      ex.paintTitle(ex.titleAt(far[0], LAST_TIER), C);
      ex.rebuildPaintBlocks();
      ok('同一个标记铺在互不相邻的两块上：**两块各露一个名字** ✓',
         mine(st).length === 2 && mine(st).every((x) => x.name === '丁'),
         `${mine(st).length} 块：${mine(st).map((p) => p.name).join(' / ')}`);

      // 两块之间得**各是自己那一块**的中心（不能都指着最大那块 ✗）
      {
        const pts = mine(st).filter((x) => x.name === '丁');
        const d2 = pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
        ok('两个同名标签落在各自的连通域里（落点分得开 ✓）', pts.length === 2 && d2 > 20,
           pts.length === 2 ? `相距 ${d2.toFixed(0)} 地图像素` : `只找到 ${pts.length} 个`);
      }

      // **同一个标记 + 另一种颜色 → 仍旧是一家**（名字优先于颜色）✓
      // 以前这里算"另一组"，于是同一个国家名会冒出两个 ——
      // 你那次就是这个：第二笔是在「国家颜色关掉」的灰底上吸的色 ✗
      st.brushLabel = '丁';
      ex.paintTitle(ex.titleAt(far[0], LAST_TIER), [20, 200, 40]);
      ex.rebuildPaintBlocks();
      const names2 = mine(st).map((p) => p.name).sort().join('/');
      // 规则已于本次改成：**同颜色 + 同标签**才算一族 ✓
      // → 同标记换了颜色 = **两族**，各自留一个名字（以前是"名字优先于颜色" ✗）
      ok('同标记换了颜色 = 两族（各留一个名字）',
         mine(st).length === 2 && names2 === '丁/丁',
         `${mine(st).length} 块：${names2}`);

      ex.restoreTitle(ex.titleAt(far[0], LAST_TIER));
      ex.restoreTitle(ex.titleAt(a, LAST_TIER));
    }

    // 同色换标记重涂：要走 actAt 的完整流程才知道涂不涂得动
    // （早先颜色一样就直接 return，标记永远改不掉）
    {
      const stg = get('stage');
      const vw = stg.clientWidth / st.cam.scale;
      const vh = stg.clientHeight / st.cam.scale;
      const vx = st.cam.cx - vw / 2, vy = st.cam.cy - vh / 2;
      const toClient = (mx, my) => [(mx + 0.5 - vx) / vw * stg.clientWidth,
                                    (my + 0.5 - vy) / vh * stg.clientHeight];
      let ax2 = -1, ay2 = -1;
      for (let y = 0; y < st.meta.mapHeight && ay2 < 0; y += 3) {
        for (let x = 0; x < st.meta.mapWidth; x += 3) {
          if (st.provinceIds[y * st.meta.mapWidth + x] === a) { ax2 = x; ay2 = y; break; }
        }
      }
      // actAt 是按**编辑层**解析头衔的，这里得用同一层的 tid 去比
      const ta = ex.titleAt(a, ex.editTier());
      st.brushLabel = '甲';
      ex.paintTitle(ta, C);
      // 标记名从**那一格自己**问（不再查头衔级的账 ✗）
      const labelAt2 = (q) => {
        const lid = st.provLabel ? st.provLabel[q] : -1;
        return lid >= 0 ? String(st.labelNames[lid] || '') : '';
      };
      const fillAt2 = (q) => {
        const pd2 = ex.renderer.paintData;
        return pd2[q * 4 + 3] > 0 ? [pd2[q * 4], pd2[q * 4 + 1], pd2[q * 4 + 2]] : null;
      };
      ok('先铺上「甲」', labelAt2(a) === '甲', labelAt2(a));

      st.brushLabel = '乙';
      ex.setTool('paint');
      ex.setBrush(C, true);            // 同一个颜色
      ex.actAt(...toClient(ax2, ay2));
      ok('同色换个标记再点一下，标记改得掉（以前点了没反应）',
         labelAt2(a) === '乙',
         labelAt2(a) + '（编辑层 ' + ex.editTier() + '，tid ' + ta + '）');
      // 颜色断言要放在描边纹理那段**之前** —— 那段会 restore 掉 a/b，
      // 而 EU4 的编辑层就是第 4 层，pa2 跟 ta 恰好是同一个 tid，顺序反了会被擦掉
      ok('颜色还是那个颜色（记在手绘层，头衔色没动）',
         JSON.stringify(fillAt2(a) || []) === JSON.stringify(C)
         && JSON.stringify(st.titles.colors[ta]) === JSON.stringify(st.titles.colors[ta]),
         '手绘 ' + JSON.stringify(fillAt2(a) || []) + ' 期望 ' + JSON.stringify(C));

      // 描边纹理：同色不同标记的两块，编号必须不一样（着色器就是比这个）
      {
        const pa2 = ex.titleAt(a, LAST_TIER), pb2 = ex.titleAt(b, LAST_TIER);
        st.brushLabel = '戊';
        ex.paintTitle(pa2, C);
        st.brushLabel = '己';
        ex.paintTitle(pb2, C);
        const la = ex.renderer.paintLabelData[a];
        const lb = ex.renderer.paintLabelData[b];
        ok('同色不同标记：相邻两块在标记纹理里编号不同（描边才画得出来）',
           la > 0 && lb > 0 && la !== lb, `${la} / ${lb}`);

        st.brushLabel = '庚';
        ex.paintTitle(pa2, C);
        ex.paintTitle(pb2, C);
        ok('同一个标记：两块编号相同（这种情况中间不该有线）',
           ex.renderer.paintLabelData[a] === ex.renderer.paintLabelData[b],
           `${ex.renderer.paintLabelData[a]} / ${ex.renderer.paintLabelData[b]}`);

        ex.restoreTitle(pa2);
        ex.restoreTitle(pb2);
        ok('擦掉之后标记编号归零',
           ex.renderer.paintLabelData[a] === 0 && ex.renderer.paintLabelData[b] === 0,
           `${ex.renderer.paintLabelData[a]} / ${ex.renderer.paintLabelData[b]}`);
      }
      ex.restoreTitle(ta);
    }

    st.showTitles = true;
    ex.restoreTitle(ex.titleAt(a, LAST_TIER));
    ex.restoreTitle(ex.titleAt(b, LAST_TIER));
    ex.rebuildPaintBlocks();
  }

  // ==== 3c-3. 用户给的三个例子（剧本层那套判断，判据是**解析出来的归属信息**）====
  // 大前提：剧本视图 + 没开粒度。规则（用户给的）：
  //  ① 「势力 · 边界」开着 → 按**剧本归属**整块来
  //     例：巴黎在 1936 剧本里属法国、却被涂成德国色 —— 指着巴黎 → **整个法国** ✓
  //  ② 否则（填色那条）→ **涂过的看填色归属、没涂过的看剧本归属**：
  //     指着涂成德国色的巴黎 → 涂成德国的那些 + 没涂过且剧本属德国的 = 整个德国 ✓
  //     指着没涂过的里昂     → 涂成法国的那些 + 没涂过且剧本属法国的 = 除了巴黎之外的整个法国 ✓
  if ((st.meta.eraDates || []).length) {
    const LAST4 = st.meta.tiers.length - 1;
    const NP4 = st.meta.numProvinces;
    const N_ERA4 = st.meta.eraDates.length;
    const BLANK4 = st.meta.tiers.indexOf('blank');
    let ERA4 = 0;
    for (let i = 0; i < N_ERA4; i++) if (i !== BLANK4) { ERA4 = i; break; }
    const svT4 = st.tier, svG4 = st.grain, svBP4 = st.showBorderPaint;
    const svPB4 = st.showPowerBorder, svB4 = st.brushLabel;
    st.tier = ERA4; st.grain = null;
    const pd4 = ex.renderer.paintData;
    const nReal4 = st.meta.numRealTitles != null ? st.meta.numRealTitles : 1e9;

    // 找 A（地最多的国家）
    const cntA = new Map();
    for (let q = 1; q < NP4; q++) {
      if (!(st.provPos[q * 3 + 2] > 0)) continue;
      const t = ex.titleAt(q, ERA4);
      if (t == null || t === st.meta.noTitle || t >= nReal4) continue;
      if (ex.isLocked(t)) continue;
      cntA.set(t, (cntA.get(t) || 0) + 1);
    }
    let A = -1, bestA = 0;
    for (const [t, c] of cntA) if (c > bestA) { bestA = c; A = t; }
    const aPids = [];
    const nbTags = new Set();
    const off4 = new Uint32Array(st.adjacency.buffer, st.adjacency.byteOffset, NP4 + 1);
    const nb4 = new Uint16Array(st.adjacency.buffer, st.adjacency.byteOffset + (NP4 + 1) * 4);
    for (let q = 1; q < NP4; q++) {
      if (ex.titleAt(q, ERA4) !== A) continue;
      aPids.push(q);
      for (let k = off4[q], e = off4[q + 1]; k < e; k++) {
        const r = nb4[k];
        if (r <= 0) continue;
        const tr = ex.titleAt(r, ERA4);
        if (tr != null && tr !== st.meta.noTitle && tr !== A && cntA.has(tr)) nbTags.add(tr);
      }
    }
    let B = -1;
    for (const t of nbTags) { B = t; break; }
    // P = 属于 A、且挨着 B 的某个省（"巴黎"）
    let P = 0;
    for (const q of aPids) {
      for (let k = off4[q], e = off4[q + 1]; k < e; k++) {
        const r = nb4[k];
        if (r > 0 && ex.titleAt(r, ERA4) === B) { P = q; break; }
      }
      if (P) break;
    }
    const L4 = aPids.find((q) => q !== P && pd4[q * 4 + 3] === 0);
    if (A >= 0 && B >= 0 && P && L4) {
      const nameA = String(st.titles.names[A] || '');
      const nameB = String(st.titles.names[B] || '');
      const colB = st.titles.colors[B] || [10, 20, 30];
      const lit4 = (q) => pd4[q * 4 + 3] > 0;
      const inList = (arr, q) => arr.indexOf(q) >= 0;
      // 把 P 涂成 B 的颜色 + B 的标记名（"巴黎涂成德国色" ✓）
      st.brushLabel = nameB;
      ex.paintTitle(ex.titleAt(P, LAST4), colB);
      ex.recomputePainted();

      // ⚠ 2026-10-17：「剧本 · 边界」删了 → "① 按整个 A" 那条不再测 ✓
      //    现在只剩「势力 · 边界」（填色那条）✓
      // ② 填色那条，指着 P（涂成 B 色）→ 整个 B
      st.showBorderPaint = true; st.showPowerBorder = false;
      ex.syncLayerSwitches();
      const t2 = ex.paintTargetsAt(P) || [];
      const bPids = [];
      for (let q = 1; q < NP4; q++) if (ex.titleAt(q, ERA4) === B) bPids.push(q);
      const bFree = bPids.filter((q) => !lit4(q));
      const hasP2 = inList(t2, P);
      const bFreeMiss = bFree.filter((q) => !inList(t2, q)).length;
      const aFreeExtra = t2.filter((q) => ex.titleAt(q, ERA4) === A && !lit4(q) && q !== P).length;
      ok(`② 填色：指着涂成「${nameB}」色的巴黎 → 整个「${nameB}」（没涂过的那些也算 ✓）`,
         hasP2 && bFreeMiss === 0,
         `目标 ${t2.length} 个：含巴黎=${hasP2}，B 没涂过的缺 ${bFreeMiss} / ${bFree.length}`);
      ok(`② 填色：目标名字是「${nameB}」，所以「${nameA}」那边没涂过的地**不算** ✓`,
         aFreeExtra === 0, `混进来 ${aFreeExtra} 个`);

      // ③ 填色那条，指着 L（没涂过、属 A）→ 除了巴黎之外的整个 A
      const t3 = ex.paintTargetsAt(L4) || [];
      const hasL3 = inList(t3, L4);
      const hasP3 = inList(t3, P);
      const aFreeMiss3 = aPids.filter((q) => q !== P && !lit4(q) && !inList(t3, q)).length;
      ok(`③ 填色：指着没涂过的里昂 → 除了巴黎之外的整个「${nameA}」✓`,
         hasL3 && !hasP3 && aFreeMiss3 === 0,
         `目标 ${t3.length} 个：含里昂=${hasL3}，含巴黎=${hasP3}（该 false），A 里缺 ${aFreeMiss3}`);

      // 收尾
      ex.restoreTitle(ex.titleAt(P, LAST4));
      ex.recomputePainted();
    } else {
      console.log(`  （这一局凑不出"相邻的两个国家" —— 跳过：A=${A} B=${B} P=${P} L=${L4}）`);
    }
    st.tier = svT4; st.grain = svG4; st.showBorderPaint = svBP4;
    st.showPowerBorder = svPB4; st.brushLabel = svB4;
    ex.syncLayerSwitches();
  }

  // ==== 3f-2. **按省份算的"边掩码 + 深度图"**（最终方案 ✓）====
  //   用户点破的：边界就是"把一部分格子的**边框**点亮"✓ 所以缝就是**格子的边** ✓
  //   边掩码：每格 32 位 = 8 组 × 4 位（1 左 2 右 4 上 8 下 ✓）组序见 app.js 的 buildBorderEdges ✓
  //   深度图：每格 1 字节 = "到最近那条缝的距离"（格 ✓）只当粗筛守门员，不参与画线 ✓
  {
    /* **粗筛位图**（用户点的三件事全在这儿 ✓）
     *   ① 任何层的边界都落在**省界**上 → 只跟省份图形状有关 ✓
     *   ② 不需要距离 → 1 位/格（"值不值得看一眼" ✓）
     *   ③ 加载时算一次 → 换层/涂色都不重算 ✓ */
    const bd = ex.buildBorderDepth ? ex.buildBorderDepth() : null;
    ok('粗筛位图能算出来（1 位/格 · 8 格 1 字节 ✓）',
       !!bd && bd.bits instanceof Uint8Array
       && bd.bits.length === Math.ceil(st.meta.mapWidth / 8) * st.meta.mapHeight,
       bd ? bd.w + "×" + bd.h + " · " + (bd.bits.length / 1048576).toFixed(1) + "MB · "
         + bd.ms.toFixed(0) + "ms" : "没算出来 ✗");
    if (bd) {
      // 置位数 = "在省界 ±2 格内"的格 ✓ 该是少数（其余一辈子画不到线 ✓）
      let _on = 0;
      for (let i = 0; i < bd.bits.length; i++) { let b = bd.bits[i]; while (b) { _on += b & 1; b >>= 1; } }
      const _tot = bd.w * bd.h;
      ok('粗筛位图：只有少数格需要细算（其余一次取位就退出 ✓）',
         _on > 0 && _on / _tot < 0.6,
         "需细算 " + (_on / _tot * 100).toFixed(1) + "% · 直接退出 "
         + (100 - _on / _tot * 100).toFixed(1) + "%");
    }
  }  // ==== 3g. **每国**名字上限（**每个国家**按连通域面积从大到小各留 N 个 ✓）====
  // ⚠ 是"同一个国家的不同地区最多 N 个" ✗ **不是**"全世界只留 N 个" ✓（用户澄清过 ✓）
  //   拉满（21）= 无上限 ✓（不用单独一个勾选框 —— 用户要求省空间）
  {
    const svMax = st.set.labelMax, svBP = st.showBorderPaint;
    st.showBorderPaint = false;
    ex.syncLayerSwitches();
    st.set.labelMax = 21;                      // 最右那一格 = 无上限：先看总量 ✓
    st._blocksAll = null; st._blocksTier = null; st._layerSig = null;
    ex.rebuildPaintBlocks(true, true);
    const all = (st.paintBlocks || []).length;
    const topArea = all ? st.paintBlocks[0].area : 0;
    ok('名字上限拉满 = 无上限 ✓', ex.labelMaxValue() === 0, 'labelMaxValue=' + ex.labelMaxValue());
    st.set.labelMax = 3;
    ex.rebuildPaintBlocks(true, true);
    const cut = st.paintBlocks || [];
    /* **留下的要比"每族 3 个"允许的更多** ✗ —— 因为**每个国家**都能留 3 个 ✓
     *  （全局取前 3 的话这儿就该正好 3 ✗ 那是我第一版的错 ✓）*/
    ok('名字上限：**每国**各留 3 个（总数远多于 3 ✓）',
       all > 3 && cut.length > 3 && cut.length < all,
       `无上限 ${all} 个 → 每国 3 个：${cut.length} 个`);
    // 每一族都不超过 3 个 ✓
    {
      const cnt = new Map();
      for (const b of cut) {
        const k = (b.rgb ? b.rgb.join(',') : '') + '|' + (b.name || '');
        cnt.set(k, (cnt.get(k) || 0) + 1);
      }
      const over = [...cnt.entries()].filter(([, n]) => n > 3);
      ok('每一族都不超过上限（没有哪国留下 4 个 ✓）',
         over.length === 0,
         over.length ? over.slice(0, 3).map(([k, n]) => k + '×' + n).join(' / ') : `族数 ${cnt.size}`);
    }
    ok('名字上限：留的都比"全局前 N"多（证明是按族分的 ✓）',
       cut.length > 3,
       `每国 3 个 → 一共 ${cut.length} 个（全局取前 3 的话只能是 3 ✗）`);
    // 再拉满 → 数量回到原样 ✓（设置能来回调）
    st.set.labelMax = 21;
    ex.rebuildPaintBlocks(true, true);
    ok('再拉满 → 数量回到原样 ✓', (st.paintBlocks || []).length === all,
       `${(st.paintBlocks || []).length} / ${all}`);
    // 滑杆就该是 1~20，而且**满格那个值就是"无上限"** ✓（跟 JS 里的常量必须对得上）
    ok('「名字上限」滑杆是 1~21（21 = 无上限 ✓）',
       /id="set-labelmax"[^>]*min="1"[^>]*max="21"/.test(HTML)
       && !/id="set-labelmax-off"/.test(HTML),
       'min=1 max=21，勾选框已经省掉 ✓');
    st.set.labelMax = svMax;
    ex.rebuildPaintBlocks(true);
    st.showBorderPaint = svBP;
    ex.syncLayerSwitches();
  }

  /* ==== 3h. **地名上限**（每个头衔按连通域面积从大到小各留 N 个 ✓）====
   *  2026-10-16：地名也改成"**每个连通域一个标**"了 ✓ 所以它另有一根上限 ✓
   *  ⚠ 本段量的是**运行时的 app 函数** ✗ —— 它们得先在**本文件顶部那份
   *    `return {…}` 导出清单**里 ✓ 忘了加就是 `ex.xxx is not a function` ✓
   *    所以先挡一道：不在就**判失败 + 跳过** ✓
   *    （不这么挡的话整段炸掉，**后面所有用例都跑不到** —— 我栽过一次 ✓）*/
  if (typeof ex.buildPlaceComponents !== 'function' || typeof ex.placePointsFor !== 'function') {
    ok('产物里有 buildPlaceComponents / placePointsFor（新探针函数要加进导出清单 ✓）', false,
       'ex 上没有这两个 —— 把 buildPlaceComponents / placePointsFor 加进本文件顶部那份 return 清单');
  } else {
    const svPM = st.set.labelPlaceMax;
    const fine = st.meta.tiers.length - 1;
    // 挑"连通域数 > 头衔数"的那一层最能看出差别；没有就退回最细层 ✓
    let tier = fine;
    for (let t = 0; t < fine; t++) {
      const pts = ex.buildPlaceComponents(t);
      const s = new Set();
      for (const p of pts) s.add(p.tid);
      if (pts.length > s.size) { tier = t; break; }
    }
    st.set.labelPlaceMax = 21;                 // 拉满 = 无上限
    const allPts = ex.placePointsFor(tier);
    const tids = new Set();
    for (const p of allPts) tids.add(p.tid);
    ok('地名取点：一个连通域一个标（点数 ≥ 不同头衔数 ✓）',
       tids.size > 0 && allPts.length >= tids.size,
       `层${tier}：连通域 ${allPts.length} 个 / 头衔 ${tids.size} 个（多出 ${allPts.length - tids.size} 枚）`);
    ok('地名上限拉满 = 无上限 ✓', ex.labelPlaceMaxValue() === 0,
       'labelPlaceMaxValue=' + ex.labelPlaceMaxValue());
    /* **跨接缝的海照样左右都有** ✓ —— 没有 `wrapLabel` 也出得来 ✓
     *  ⚠ 别拿"裂得最碎"那个当头 ✗（EU4 上那是 `#sea`，187 枚但全在左半 ✓）——
     *    要**按"同一 tid 的标分处图中线两侧"去找**，找不到就只报一声不判失败 ✓ */
    {
      const byTid = new Map();
      for (const p of allPts) {
        let r = byTid.get(p.tid);
        if (!r) { r = { n: 0, lo: Infinity, hi: -Infinity }; byTid.set(p.tid, r); }
        r.n++;
        if (p.x < r.lo) r.lo = p.x;
        if (p.x > r.hi) r.hi = p.x;
      }
      const W = st.meta.mapWidth || 0;
      let cross = null, most = null;
      for (const [tid, r] of byTid) {
        if (!most || r.n > most.n) most = { tid, n: r.n, lo: r.lo, hi: r.hi };
        if (r.n >= 2 && r.lo < W / 2 && r.hi > W / 2 && (!cross || r.n > cross.n)) {
          cross = { tid, n: r.n, lo: r.lo, hi: r.hi };
        }
      }
      const _nmOf = (t) => `「${(st.titles.names || [])[t]}」`;
      if (cross) {
        ok('跨 180° 经线的那片：同一个 tid 左右各有一枚标（没有 wrapLabel 也出得来 ✓）',
           true,
           `${_nmOf(cross.tid)}${cross.n} 枚 · x ${cross.lo.toFixed(0)} ~ ${cross.hi.toFixed(0)}`
           + `（图中线 ${W / 2}）`);
      } else {
        console.log('  （这张图上没有"分处左右两头"的头衔 —— 本项跳过 ✓）');
      }
      console.log(`    裂得最碎的：${_nmOf(most.tid)}${most.n} 枚`
        + `（旧那枚单点 titles.lx=${st.titles.lx ? st.titles.lx[most.tid] : '—'}）`);
    }
    st.set.labelPlaceMax = 2;                  // 每个头衔各留 2 个
    const cutPts = ex.placePointsFor(tier);
    {
      const cnt = new Map();
      for (const p of cutPts) cnt.set(p.tid, (cnt.get(p.tid) || 0) + 1);
      const over = [...cnt.entries()].filter(([, n]) => n > 2);
      ok('地名上限：每个**头衔**各留 2 个（没有一个留 3 个 ✓）',
         over.length === 0,
         over.length ? over.slice(0, 3).map(([k, n]) => k + '×' + n).join(' / ') : `头衔数 ${cnt.size}`);
      ok('地名上限：留的比"全局前 N"多（证明是按头衔分的 ✓）',
         cutPts.length > 2, `每个头衔 2 个 → 一共 ${cutPts.length} 个`);
    }
    st.set.labelPlaceMax = 21;
    ok('地名上限再拉满 → 回到原样 ✓', ex.placePointsFor(tier).length === allPts.length,
       `${ex.placePointsFor(tier).length} / ${allPts.length}`);
    /* 两根上限**互不干扰** ✓ —— 动地名那根，势力名那份一个不差 ✓ */
    {
      const svMax2 = st.set.labelMax;
      st._blocksAll = true; st._blocksTier = null;
      st.set.labelMax = 21; ex.rebuildPaintBlocks(true);
      const nA = (st.paintBlocks || []).length;
      st.set.labelPlaceMax = 2;                // 只动地名那根
      ex.rebuildPaintBlocks(true);
      ok('两根上限互不干扰（动地名那根，势力名那份一个不差 ✓）',
         (st.paintBlocks || []).length === nA,
         `势力名无上限 ${nA} 个 → 动完地名那根还是 ${(st.paintBlocks || []).length} 个`);
      st.set.labelMax = svMax2;
      ex.rebuildPaintBlocks(!!st._blocksAll);
    }
    st.set.labelPlaceMax = svPM;
    ex.placePointsFor(tier);                   // 让缓存回到用户原来的档位 ✓
  }

  /* ==== 3i. 剧本层 + 无粒度：**对涂出来的色块动手 = 整块** ✓ ====
   *  2026-10-16 用户报的：**空白剧本那一层全是无主** ✗ ——
   *  以前"无主 → 单格"那一刀对每一格都成立，于是涂出来的色块永远只能动一格 ✓
   *  定的优先级（用户原话）：
   *    · 「势力 · 边界」**关着** → 先看**所指处的填色** → 再剧本 → 再最低粒度 ✓
   *    · 「势力 · 边界」**开着** → 先剧本 → 再最低粒度，**不看填色** ✓ */
  {
    const _nEra0 = (st.meta.eraDates || []).length;
    if (_nEra0 <= 0 || typeof ex.paintTargetsAt !== 'function') {
      console.log('  （没有剧本层 / 产物是旧的 —— 本段跳过 ✓）');
    } else {
      const svT = st.tier, svG = st.grain, svBL = st.brushLabel, svBrush = st.brush;
      const svBP = st.showBorderPaint, svPB = st.showPowerBorder;
      const fine0 = st.meta.tiers.length - 1;
      st.tier = _nEra0 - 1;                    // 空白剧本 = 剧本块最右那一格 ✓
      st.grain = null;
      st.showPowerBorder = false; st.showBorderPaint = true;   // 填色那条路 ✓
      const pd0 = ex.renderer.paintData;
      const pids = [];
      for (let q = 1; q < st.meta.numProvinces && pids.length < 3; q++) {
        const t = ex.titleAt(q, fine0);
        if (t == null || t === 65535 || ex.isLocked(t, q)) continue;
        if (st.provPos[q * 3 + 2] < 5) continue;
        if ((st.meta.wasteland || []).indexOf(t) >= 0) continue;
        if (pd0 && pd0[q * 4 + 3] > 0) continue;                // 只用没涂过的 ✓
        pids.push(q);
      }
      if (pids.length < 3) {
        console.log('  （挑不出 3 块干净的陆地 —— 本段跳过 ✓）');
      } else {
        st.brushLabel = '测试色块';
        ex.setBrush([12, 200, 77], false);
        for (const q of pids) ex.paintAt(q, ex.titleAt(q, fine0));
        const tgt = ex.paintTargetsAt(pids[0]) || [];
        ok('空白剧本 + 无粒度：点涂出来的色块 → **整块涂色**（不再是单格 ✗）',
           pids.every((q) => tgt.indexOf(q) >= 0),
           `涂了 ${pids.length} 块 · 目标 ${tgt.length} 块`);
        // ⚠ 2026-10-17：「剧本 · 边界」那个勾删了 → "先剧本、不看填色"那条不再有入口 ✓
        //    这里只验剩下的填色范围 ✓
        ex.setBrush(svBrush, false);
      }
      st.tier = svT; st.grain = svG; st.brushLabel = svBL;
      st.showBorderPaint = svBP; st.showPowerBorder = svPB;
    }
  }

  console.log('\n=== 3d. 导入带 clearEraNames 的配色之后，剧本层国名不能空 ===');
  // 有一类导入件是**按省**涂的：key 是 p_236 这种省份层 key，名字在 labels 里，
  // 并且声明 clearEraNames 要求清掉原版那三套国名。
  // 原版名清掉是**文件要求的**，但"涂过的地"名字在标签层（导入文件里的 labels）——
  // 导入之后剧本层必须照旧把国名画出来 ✗
  // 以前 rebuildPaintBlocks 的 all 分支拿 titles.names 当门槛：原版名一空，
  // 连**涂过的地也一起跳过** → 导入后剧本层一个国名都没有 ✗
  {
    const nEra0 = (st.meta.eraDates || []).length;
    if (nEra0 <= 0) {
      console.log('  （CK3 没有年代层 / 剧本层，这条不适用 —— 跳过）');
    } else {
      const fine0 = st.meta.tiers.length - 1;
      // 造一份这样的导入件：十几个省 + 每省一个名字
      const keys0 = [], tids0 = [];
      for (let p = 1; p < st.meta.numProvinces && keys0.length < 12; p++) {
        if (!(st.provPos[p * 3 + 2] > 0)) continue;
        const t0 = ex.titleAt(p, fine0);
        if (t0 === 65535 || t0 == null || ex.isLocked(t0)) continue;
        const k0 = st.titles.keys[t0];
        if (!k0 || keys0.indexOf(k0) >= 0) continue;
        keys0.push(k0); tids0.push(t0);
      }
      const titles0 = {}, labels0 = {};
      keys0.forEach((k0, i) => { titles0[k0] = [20 + i * 6, 80, 40]; labels0[k0] = '试国' + i; });

      // 这一段会动到的东西先存下来（导入清名字是**真的改数据**，必须还回去）
      const svTier0 = st.tier, svGrain0 = st.grain;
      const svPaintMode0 = st.showLabelsPaint, svTitles0 = st.showTitles, svShowPaint0 = st.showPaint;
      const svEraNames = new Map();
      for (let i = 0; i < st.titles.names.length; i++) {
        if (st.titles.tiers[i] < nEra0) svEraNames.set(i, st.titles.names[i]);
      }

      const nIn = ex.applyProject({ version: 1, clearEraNames: true, titles: titles0, labels: labels0 });
      ok('导入一份 clearEraNames 的配色认得出来', nIn === keys0.length, `${nIn}/${keys0.length}`);
      let left0 = 0;
      for (let i = 0; i < st.titles.names.length; i++) {
        if (st.titles.tiers[i] < nEra0 && st.titles.names[i]) left0++;
      }
      ok('原版国家级国名按声明清空了（这一步是文件要求的 ✓）', left0 === 0, '还剩 ' + left0);

      // 切到剧本层 —— 国名就是从这一层画的
      st.tier = ERA0; st.grain = null; st.showLabelsPaint = true;
      ex.syncLayerSwitches();
      ex.rebuildPaintBlocks(!!st._blocksAll);
      const names0 = (ex.paintedPoints(true) || []).map((q) => q.name).filter(Boolean);
      const mine0 = names0.filter((x) => x.indexOf('试国') === 0);
      const alien0 = names0.filter((x) => x.indexOf('试国') !== 0);
      ok('剧本层上导入的国名画得出来（原版名被清空也不许把涂过的地一起吞 ✗）',
         mine0.length > 0,
         `${names0.length} 个名字，其中导入的 ${mine0.length} 个：${[...new Set(names0)].slice(0, 3).join(' / ') || '（一个都没有）'}`);
      ok('剧本层上没有原版国名漏回来', alien0.length === 0,
         alien0.length ? alien0.slice(0, 3).join(' / ') : '干净');

      // 还原
      for (const [i, nm] of svEraNames) st.titles.names[i] = nm;
      for (const t0 of tids0) ex.restoreTitle(t0);
      st.tier = svTier0; st.grain = svGrain0;
      st.showLabelsPaint = svPaintMode0; st.showTitles = svTitles0; st.showPaint = svShowPaint0;
      ex.syncLayerSwitches();
      ex.rebuildPaintBlocks(!!st._blocksAll);
    }
  }

  // ==== 3e. 导入带 clearEraNames 的配色：这一族的国名**不能空** ====
  // 这类导入件是照着"每个省的原版国家"上色的（名字就是那个国家的名字），
  // 而 clearEraNames 把原版国名整层清掉了 —— 清完之后这一族还认不认得出自己的名字？
  // （以前这儿盯的是"名字要落到首都那片"✗ —— 首都那套拿掉之后，
  //   只剩一件真要紧的事：**名字还在** ✓）
  {
    const nEra5 = (st.meta.eraDates || []).length;
    if (nEra5 <= 0) {
      console.log('  （这一局没有年代层 —— 跳过）');
    } else {
      const fine5 = st.meta.tierNames.length - 1;
      let pick = null;
      // 挑一个"地够多、有名字"的年份层国家当小白鼠 ✓
      // （以前是按 meta.capitals 挑"首都在自己地里"的 —— 首都那套没了，
      //   而且 EU5 的 meta 里根本没有 capitals ✗ 会直接炸）
      for (let t5 = 0; t5 < st.titles.keys.length && !pick; t5++) {
        if (st.titles.tiers[t5] >= nEra5) continue;
        if (!st.titles.names[t5]) continue;
        const pids5 = [];
        for (let p = 1; p < st.meta.numProvinces && pids5.length < 600; p++) {
          if (!(st.provPos[p * 3 + 2] > 0)) continue;
          if (ex.titleAt(p, ERA0) !== t5) continue;
          pids5.push(p);
        }
        if (pids5.length < 3) continue;
        pick = { t: t5, pids: pids5, nm: st.titles.names[t5] };
      }
      ok('找得到一个地够多的年份层国家（复现要用）', !!pick,
         pick ? `#${pick.t}「${pick.nm}」，地 ${pick.pids.length} 块` : '这局没有');
      if (pick) {
        const titles5 = {}, labels5 = {};
        for (const p of pick.pids) {
          const t5b = ex.titleAt(p, fine5);
          if (t5b === 65535 || t5b == null) continue;
          const pk = st.titles.keys[t5b];
          if (!pk) continue;
          titles5[pk] = [40, 120, 200];
          labels5[pk] = pick.nm;      // 名字直接用**国家本名**（按省上色的导入件就是这么写的）
        }
        const svT5 = st.tier, svG5 = st.grain, svL5 = st.showLabelsPaint;
        const svN5 = st._blocksAll, svNT5 = st._blocksTier;
        const svEra5 = new Map();
        for (let i = 0; i < st.titles.names.length; i++) {
          if (st.titles.tiers[i] < nEra5) svEra5.set(i, st.titles.names[i]);
        }
        ex.applyProject({ version: 1, clearEraNames: true, titles: titles5, labels: labels5 });
        st.tier = ERA0; st.grain = null; st.showLabelsPaint = true;
        st._blocksAll = null; st._blocksTier = null;
        ex.syncLayerSwitches();
        ex.rebuildPaintBlocks(!!st._blocksAll);
        const blks = (st.paintBlocks || []).filter((b) => b.name === pick.nm);
        ok('导入 clearEraNames 的配色之后，这一族的国名照样画得出来 ✓',
           blks.length >= 1,
           blks.length ? `「${pick.nm}」${blks.length} 个落点`
                       : `没找到「${pick.nm}」这一族`);
        // 落点得在**这一族自己的地盘**里（不能跑到别人家去 ✗）
        if (blks.length) {
          const xs = pick.pids.map((p) => st.provPos[p * 3]);
          const ys = pick.pids.map((p) => st.provPos[p * 3 + 1]);
          const pad = 400;      // 地盘跨度本来就大，给点余量（重心可能落在包围盒边上 ✓）
          const inside = blks.filter((b) => b.x >= Math.min(...xs) - pad && b.x <= Math.max(...xs) + pad
                                         && b.y >= Math.min(...ys) - pad && b.y <= Math.max(...ys) + pad);
          ok('每个落点都摆在这一族自己的地盘里 ✓', inside.length === blks.length,
             `${inside.length}/${blks.length} 个在包围盒内`);
        }
        // 还原：名字 + 涂色 + 层级
        for (const [i, nm] of svEra5) st.titles.names[i] = nm;
        for (const p of pick.pids) {
          const t5c = ex.titleAt(p, fine5);
          if (t5c !== 65535 && t5c != null) ex.restoreTitle(t5c);
        }
        st.tier = svT5; st.grain = svG5; st.showLabelsPaint = svL5;
        st._blocksAll = svN5; st._blocksTier = svNT5;
        ex.syncLayerSwitches();
        ex.rebuildPaintBlocks(!!st._blocksAll);
      }
    }
  }

  // ==== 3f. 导出涂色 = **逐最细层单位**（不是"按头衔"）====
  // 手绘层的真相是"每一格自己的颜色 + 标记 + 归属" ✓ 所以导出必须逐格存 ——
  // 同一个头衔下的地块可以各是各的色（1936 那半壁法国），按头衔存就丢信息 ✗
  // 这条走一遍完整往返：涂两个不同色 → 导出 → 清空 → 导入 → **逐格比颜色**
  {
    const LAST3 = st.meta.tiers.length - 1;
    const NP3 = st.meta.numProvinces;
    const pd3 = ex.renderer.paintData;
    const clear3 = () => {
      // **按"这一格有没有颜色"清**（以 paintData 为准 ✓）——
      // 前面那些测试直接改过手绘纹理，账本可能跟它脱节；只按账本清会留下残留 ✗
      for (let q = 1; q < NP3; q++) {
        if (pd3[q * 4 + 3] > 0) {
          ex.renderer.setPaint(q, 0, 0, 0, 0);
          ex.renderer.setPaintLabel(q, 0);
          if (st.provTitle) st.provTitle[q] = -1;
          if (st.provLabel) st.provLabel[q] = -1;
        }
      }
      ex.recomputePainted();
    };
    const pick3 = [];
    for (let q = 1; q < NP3 && pick3.length < 2; q++) {
      const t = ex.titleAt(q, LAST3);
      if (t == null || t === st.meta.noTitle || ex.isLocked(t)) continue;
      if (st.provPos[q * 3 + 2] <= 0) continue;
      pick3.push(q);
    }
    if (pick3.length < 2) {
      console.log('  （这一局凑不出两个可涂的地块 —— 跳过）');
    } else {
      clear3();
      ex.paintTitle(ex.titleAt(pick3[0], LAST3), [200, 30, 30], true);
      ex.paintTitle(ex.titleAt(pick3[1], LAST3), [30, 30, 200], true);
      ex.recomputePainted();
      const data3 = ex.projectData();
      // ① 导出的 key 必须都是**最细层**头衔
      const badKey = Object.keys(data3.titles).filter((k) => {
        const tid = st.titles.index ? st.titles.index[k] : null;
        return tid == null || st.titles.tiers[tid] !== LAST3;
      });
      ok('导出的每一笔都是"最细层单位"的 key ✓（不是按头衔整块存 ✗）',
         badKey.length === 0, badKey.slice(0, 3).join(',') || `${Object.keys(data3.titles).length} 条全对`);
      // ② 往返：清空 → 导入 → 逐格比颜色
      const before3 = [];
      for (let q = 1; q < NP3; q++) {
        before3.push(pd3[q * 4 + 3] > 0 ? [pd3[q * 4], pd3[q * 4 + 1], pd3[q * 4 + 2]].join() : '');
      }
      clear3();
      ex.applyProject(JSON.parse(JSON.stringify(data3)));
      let bad3 = 0;
      for (let q = 1; q < NP3; q++) {
        const cur = pd3[q * 4 + 3] > 0 ? [pd3[q * 4], pd3[q * 4 + 1], pd3[q * 4 + 2]].join() : '';
        if (cur !== before3[q - 1]) bad3++;
      }
      ok('导出 → 清空 → 导入：逐格一模一样（两色都不丢 ✓）', bad3 === 0,
         bad3 ? `差 ${bad3} 格` : `${NP3 - 1} 格全对`);
      clear3();
    }
  }

  console.log('\n=== 4. 锁住的地块 ===');
  // EU5 没有伪头衔：海/湖/荒地是**无名节点**（各占一个地块号），不叫 #sea ——
  // 所以这里给空清单，那几条断言自然跳过
  //
  // 🔴 **2026-10-19：EU4 的伪头衔是"按层分片"命名的** ✗✗
  //   原来是 `#sea` / `#lake` / `#wasteland` 三个共享节点（一个名字全世界共用 ✓）
  //   现在是 `#sea_ct_0` / `#sea_pr_2264` / `#lake_all_1792` 这种
  //   （**每一层、每一片各自一个节点** ✓ 这样每片海能有自己的名字 ✓）
  //   → 精确查 `#sea` 永远是 -1 ✓ 改成**按前缀找第一个** ✓
  //     下面那几条断言验的是"伪头衔锁不锁"，找哪一片都一样 ✓
  const firstByPrefix = (pfx) => st.titles.keys.findIndex((k) => String(k).startsWith(pfx));
  const pseudo = isEu5 ? []
    : isEU4 ? ['#sea', '#lake', '#wasteland'].map((pfx) => {
        const k = st.titles.keys[firstByPrefix(pfx)];
        return k === undefined ? pfx : k;         // 找不到就退回原字面量 → 断言会红 ✓
      })
    : isHoi4 ? ['#sea', '#lake']
    : isVic3 ? ['#sea', '#lake']
    : ['#sea', '#lake', '#river', '#impassable'];   // 海域分组已删，海回到共享 #sea ✓
  if (WHICH === 'CK3') {
    const si = st.titles.keys.indexOf('#sea');
    ok('CK3 的海回到共享伪头衔 #sea（海域分组已按要求删除）', si >= 0, '#' + si);
    // 「不可通行海域」是**水**：开着「荒漠·允许」也不给涂（用户要求 ✓）
    // 「不可通行陆地」（#impassable）照旧放行 —— 这两条别被同一句放行一起放掉 ✗
    const _seaT = st.titles.keys.indexOf('#impassable_sea');
    const _landT = st.titles.keys.indexOf('#impassable');
    const _svW0 = st.showWaste;
    st.showWaste = true;
    ok('不可通行海域：开着「允许」也锁住', _seaT >= 0 && ex.isLocked(_seaT), `序号 ${_seaT}`);
    ok('不可通行陆地：开着「允许」能涂（别一起锁掉 ✗）', _landT >= 0 && !ex.isLocked(_landT),
       `序号 ${_landT}`);
    st.showWaste = _svW0;
  }
  const _svWaste = st.showWaste;
    st.showWaste = false;
    for (const name of pseudo) {
    const i = st.titles.keys.indexOf(name);
    /* 🔴 **2026-10-19：判据改成"是伪头衔 + 它管的地块不许涂"** ✗✗
     *   `isLocked(tid)` **不带 pid 时只判"有没有头衔"** ✓
     *   —— 那是 2026-10-16 用户改的口径：**锁不锁看地块身份（kindMask），不看头衔** ✓
     *   （"河流 / 海洋 / 不可通行海域 / 湖泊禁止上色" ✓ 见 app.js 的 isPaintable ✓）
     *   所以老断言 `isLocked(tid)` 对伪头衔恒 false ✗ 不是 bug，是口径变了 ✓
     *   → 现在验两件事：① 它确实是伪头衔（`#` 开头）② **它下面那块地涂不了** ✓
     *     第二件才是用户真正在意的（海不能涂 ✓） */
    ok(`${name} 是伪头衔（锁住）`,
       i >= 0 && ex.isSpecialTid(i) && (() => {
         /* 找一个归它管的地块，验涂不了 —— 找不到就只验"是伪头衔" ✓ */
         const NP = st.meta.numProvinces;
         for (let p = 1; p < NP; p++) {
           if (ex.titleAt(p, st.tier) === i) return ex.isLocked(i, p);
         }
         return true;
       })(), `序号 ${i}`);
  }
  ok('地图上确实有锁住的地块', ids.some((p) => ex.isSpecialTid(ex.titleAt(p, st.tier))));
    st.showWaste = _svWaste;

  // （原来这儿有一节「导出 EU4 mod」的测试 —— v1.6 把"导出 mod"这条路整个取消了 ✓
  //   provinces.bmp / definition.csv 的生成、descriptor.mod、zip 结构这些断言一起撤掉）

  // 这条是上几轮被我误删的（原本在 CK3 分支里），按等价逻辑补回来
  if (WHICH === 'CK3') {
    ok('CK3 的名字本来就是中文', T.names.some((n) => n && /[\u4e00-\u9fff]/.test(n)));
  }

  // ---- 跨模式对照（数据级）：CK3 那份缓存里"不该有 / 该有"的几样东西 ----
  // 这几条原本是拿 CK3 数据集在测试壳里跑的；改成直接读文件 —— 它们本来就是
  // 数据层面的事，不需要再开一个应用实例，反而更硬。
  {
    const fs2 = require('fs');
    const ckT = JSON.parse(fs2.readFileSync('data/titles.json', 'utf8'));
    const ckM = JSON.parse(fs2.readFileSync('data/meta.json', 'utf8'));
    ok('CK3 缓存里没有 namesEn（不需要）', !ckT.namesEn);
    // 公爵领以上（0~2 层）的标注点必须**落在自家地盘的包围盒里** ✓
    // （早先这一层会把名字改标到**法理首都**上；后来按整块地盘算。
    //   现在口径是"像素最多的那块连通域的重心"，所以不该再拿它跟
    //   全体重心 gx/gy 比 —— 多块地盘的头衔两者本来就不等 ✓
    //   真正要守住的是：名字别跑到自家地盘之外（大洋中间那种 ✗））
    {
      const zlib = require('zlib');
      const n2 = ckM.numProvinces, rows2 = ckM.tiers.length;
      const tmb = zlib.inflateSync(fs2.readFileSync('data/titlemap.bin'));
      const tm2 = new Uint16Array(tmb.buffer, tmb.byteOffset, rows2 * n2);
      const ppb = zlib.inflateSync(fs2.readFileSync('data/prov_pos.bin'));
      const pp2 = new Float32Array(ppb.buffer, ppb.byteOffset, ppb.byteLength / 4);
      const box = new Map();
      // **所有层取并集** ✓ —— 荒地那种"逐块节点"在粗层里挂的是共享节点
      // （#不可通行 之类），只扫 0~2 层会把它自己的地块漏掉 ✗
      for (let lv = 0; lv < rows2; lv++) {
        const row = lv * n2;
        for (let p = 1; p < n2; p++) {
          const t = tm2[row + p];
          if (!t) continue;
          const x = pp2[p * 3], y = pp2[p * 3 + 1];
          const b = box.get(t);
          if (!b) box.set(t, [x, y, x, y]);
          else {
            if (x < b[0]) b[0] = x;
            if (y < b[1]) b[1] = y;
            if (x > b[2]) b[2] = x;
            if (y > b[3]) b[3] = y;
          }
        }
      }
      let out = 0, tot = 0, worst = '', worstD = 0;
      for (const [t, b] of box) {
        if (ckT.lx[t] == null || ckT.ly[t] == null) continue;
        // **伪头衔不看** ✓（编号 ≥ numRealTitles：海洋/湖泊/荒地那种）——
        // 它们的地块在图层里挂得散、位置是另一套算法，本来也不当"地区名字"画 ✓
        if (t >= (ckM.numRealTitles || ckM.numTitles)) continue;
        if (String((ckT.keys[t] || '')).startsWith('#')) continue;
        tot++;
        const m = 64;        // 容差：包围盒是按地块**中心点**算的，边上留点余地；
                             // 要抓的是"跑到大洋/别的洲"（那种偏离上千像素 ✗）
        const d = Math.max(b[0] - m - ckT.lx[t], ckT.lx[t] - b[2] - m,
                           b[1] - m - ckT.ly[t], ckT.ly[t] - b[3] - m);
        if (d > 0) {
          out++;
          if (d > worstD) {
            worstD = d;
            worst = `${ckT.names[t]} #${t} 标 (${ckT.lx[t].toFixed(0)},${ckT.ly[t].toFixed(0)})`
                    + ` 盒 x${b[0].toFixed(0)}~${b[2].toFixed(0)} y${b[1].toFixed(0)}~${b[3].toFixed(0)}`
                    + ` 出 ${d.toFixed(0)}px`;
          }
        }
      }
      ok('公爵领以上的名字都落在自家地盘范围内（不再钉在法理首都 ✓）',
         out === 0 && tot > 1000, `${tot} 个里头，出界的 ${out} 个${worst ? `：${worst}` : ''}`);
    }
    /* CK3 现在**也有剧本层了** ✓（1066 + 空白剧本 ✓ 见 build_data 的 eraDates 那段）——
     * 用户点名的"取消 CK3 的特立独行、和其他模式一样"：
     * 帝国/王国/…/男爵领全是**地区级**，1066 与空白剧本是**剧本** ✓ */
    ok('CK3 有剧本层：1066 + 空白剧本（eraDates 两条，第一层就叫「1066」）',
       (ckM.eraDates || []).length === 2 && ckM.eraDates[0] === '1066.9.15'
       && ckM.tiers[0] === '1066' && ckM.tierNames[0] === '1066'
       && ckM.tiers[1] === 'blank' && ckM.tierNames[1] === '空白剧本',
       `eraDates=${JSON.stringify(ckM.eraDates || [])} · tiers[0..1]=${ckM.tiers.slice(0, 2)}`);
    ok('CK3 的 1066 层有自己的节点（1066_<原头衔> ✓ 不是借法理头衔的）',
       ckT.keys.filter((k) => k.startsWith('1066_')).length > 500
       && ckT.tiers.filter((x) => x === 0).length > 500,
       `${ckT.keys.filter((k) => k.startsWith('1066_')).length} 个 1066 节点`);
    const _fineTier = ckM.tiers.length - 1;      // 男爵领那一层（别写死 4 ✗）
    const baronies = ckT.tiers.filter((x) => x === _fineTier).length;
    ok('男爵领比 MAX_LABELS 多得多（所以这条才要紧）', baronies > 1000, `${baronies} 个`);
  }


  console.log('\n' + '='.repeat(58));
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  ✘ ' + f)); process.exitCode = 1; }
})().catch((e) => { console.error('测试本身炸了：', e); process.exitCode = 2; });

// ---------------------------------------------------------------- 解 zip

function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 zip 中央目录');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('中央目录条目坏了 @' + p);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = Buffer.from(buf.slice(p + 46, p + 46 + nlen)).toString('utf8');
    // 本地头
    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    const raw = buf.slice(start, start + csize);
    out[name] = method === 8 ? new Uint8Array(zlib.inflateRawSync(Buffer.from(raw))) : raw;
    if (out[name].length !== usize) throw new Error(`${name} 解出来大小不对`);
    p += 46 + nlen + elen + clen;
  }
  return out;
}
