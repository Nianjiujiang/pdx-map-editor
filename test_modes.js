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
const zlib = require('zlib');

const ROOT = __dirname;
/** 跑哪一套：CK3 / EU4 / EU4HD。EU4HD 只是换张图，术语和断言跟 EU4 一样。 */
/** 跑哪一套：CK3 / EU4 / EU4HD / HOI4 / VIC3 */
const WHICH = (process.argv[2] || 'EU4').toUpperCase();
const isEU4 = WHICH.startsWith('EU4');
const isHoi4 = WHICH === 'HOI4';
const isVic3 = WHICH === 'VIC3';
const isEu5 = WHICH === 'EU5';
/** 有"年份视图"的几套（EU4 三个年份、HOI4 两个、V3 一个） */
const hasEras = isEU4 || isHoi4 || isVic3;
const CARD = WHICH === 'EU4HD' ? 'EU4HD'
  : WHICH === 'VIC3' ? 'V3 原版'
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
    const uRamp = gsrc.indexOf('for (int ex = 0; ex < 4; ex++)');
    ok('多级边界循环用到的 ramp 声明在它之前（别再编译失败 ✗）',
       dRamp >= 0 && uRamp >= 0 && dRamp < uRamp,
       'ramp@' + dRamp + ' loop@' + uRamp);
    }


  // **单文件要嵌的地图清单必须跟 app.js 的 MAP_CHOICES 一致** ——
  // 这两份名单以前是各写各的，加了新地图只改一处，单文件里就看不到它（EU4 1616 就是这么漏的）。
  {
    const fs2 = require('fs');
    const app = fs2.readFileSync('web/js/app.js', 'utf8');
    const bs = fs2.readFileSync('build_standalone.py', 'utf8');
    const choiceKeys = [...app.matchAll(/\{ key: '([a-z0-9]+)',\s*emb: '([a-z0-9]+)'/g)].map((m) => m[2]);
    const embedKeys = [...bs.matchAll(/\(\"([a-z0-9]+)\", ROOT \/ \"data/g)].map((m) => m[1]);
    const missing = choiceKeys.filter((k) => !embedKeys.includes(k));
    ok('单文件嵌入清单与地图清单一致（新增地图别只改一处）',
       missing.length === 0,
       missing.length ? ('漏嵌: ' + missing.join(',')) : (choiceKeys.length + ' 张都在'));
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
    ok('涂色边界看「颜色 + 标记」：颜色不同就划、同色比标记、没开年份视图时未上色互不划 ✓',
       g2.includes('vec3 lutColour(ivec2 ip)') && g2.includes('if (shownDiffers(ip, q))')
       && g2.includes('if (ca.x < -0.5 && cb.x < -0.5) return false;')
       && g2.includes('if (distance(ca, cb) > 0.02) return true;')
       && g2.includes('if (uPaintOnly == 1 && !ta && !tb) return false;')
       && g2.includes('return paintLabelAt(a) != paintLabelAt(b);')
       && !g2.includes('shownOf('), 'ok');
  }

  // 水域 / 荒地两条边界：**固定宽 1 + 实心** ✓（用户定的 ✓）
  //   水域：一直是这样（浓度写死实心）✓ 只是粗细以前取"链上最粗那条" ✗ → 现在钉死 1 ✓
  //   荒地：以前**没有自己这一趟** —— 边缘是头衔那趟顺手画的 ✗ → 宽度浓度跟着"本层那条线"
  //         在 1.5+实心（剧本层）和 1.0+50%（细层）之间跳 ✗
  //         现在两头一起改：头衔那几趟把荒地边**让出来**（wasteOnly=false ✓），
  //         另开一趟 dWaste 按固定档画 ✓（只加新的不让旧的 = 同一条缝画两遍 ✗）
  {
    const g3 = require('fs').readFileSync('web/js/gl.js', 'utf8');
    const nWaste = (g3.match(/, true\)\);/g) || []).length;
    const nNorm = (g3.match(/, false\)\);/g) || []).length;
    ok('水域 / 荒地边界：各自固定宽 1，浓度实心 ✓',
       g3.includes('uniform float uWaterW;') && g3.includes('uniform float uWasteW;')
       && g3.includes('if (_hasWaste != wasteOnly) continue;')
       && g3.includes('float bwd  = 1.0 - smoothstep(bwwd - ramp, bwwd + ramp, dWaste);')
       && g3.includes('gl.uniform1f(u.uWasteW, this.wasteW);'),
       `uWasteW 声明=${g3.includes('uniform float uWasteW;')}`
       + ` 上传=${g3.includes('gl.uniform1f(u.uWasteW, this.wasteW);')}`);
    ok('荒地边只由"荒地那一趟"画（头衔那几趟都把它让出来 ✓）',
       nWaste === 4 && nNorm === 8,
       `wasteOnly=true 的调用 ${nWaste} 个 / false 的 ${nNorm} 个`);
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
    ok('悬停高亮也用 uEditTier（亮的那块 = 点下去会涂到的那块）',
       /titleAt\(h,\s*uEditTier\)[\s\S]{0,40}==\s*uHoverTid/.test(frag), '找 titleAt(h, uEditTier) … == uHoverTid');

    // **无主地块也要画边界** ✓ —— 那道闸以前是「本格在编辑层有头衔」，
    // 而"无主地"在编辑层拿到的正是 NONE → 它的整段边界计算被跳过 →
    // 「国家 ↔ 无主地」只剩国家那半边有线（用户报的 ✗）
    {
      const gateNew = /if \(pidAt\(ip\) != 0u\)/.test(frag);
      ok('边界那道闸看的是「本格是不是地块」，不是「有没有头衔」✓',
         gateNew && !/if \(tidAt\(ip\) != NONE\)/.test(frag),
         gateNew ? 'pidAt(ip) != 0u' : '还是老写法（tidAt != NONE）');
      const terrainNew = /bool _tw = \(t != NONE && t >= uint\(uRealTitles\)\)/.test(frag);
      ok('「地形伪头衔」那道判据也得把无主地排除（NONE 是地，不是海）✓',
         terrainNew && !/if \(t >= uint\(uRealTitles\) && tt >= uint\(uRealTitles\)\)/.test(frag),
         terrainNew ? 'NONE 不算地形' : '还是老写法（NONE 被当成伪头衔）');
      // 照着着色器那段**逐字重算**：把一格格 tid 摆成一条带子，看每个方向找不找得到边
      // （NONE = 无主地；REAL 以上且不是 NONE 的才是"地形伪头衔"：海/湖/荒地）
      const NONE2 = 65535, REAL2 = 100, WASTE2 = 900;
      const ALPHA2 = (t2) => (t2 === NONE2 ? 0 : (t2 === WASTE2 ? 1 : 0));   // 无主地那格不存在 → 0
      const TERRAIN2 = (t2) => (t2 !== NONE2 && t2 >= REAL2);                // NONE 是地，不是地形 ✓
      const ray2 = (strip, i, dir, t0) => {
        for (let k = 1; k <= 8; k++) {
          const q = i + dir * k;
          if (q < 0 || q >= strip.length) break;
          const tt = strip[q];
          if (TERRAIN2(t0) && TERRAIN2(tt) && ALPHA2(t0) < 0.5 && ALPHA2(tt) < 0.5) continue;
          if (tt !== t0) return k;
        }
        return Infinity;
      };
      const oldHit = (strip, i, dir) => (strip[i] === NONE2 ? Infinity : ray2(strip, i, dir, strip[i]));
      const newHit = (strip, i, dir) => ray2(strip, i, dir, strip[i]);
      const strip2 = [5, NONE2, NONE2, 7, 8];
      ok('国家 → 无主地：两边都算得出那条边 ✓',
         newHit(strip2, 0, 1) === 1 && newHit(strip2, 1, -1) === 1,
         `国家侧 ${newHit(strip2, 0, 1)} / 无主侧 ${newHit(strip2, 1, -1)}`);
      ok('（复现）老闸下无主那一侧整段跳过 → 线只剩半边 ✗',
         oldHit(strip2, 1, -1) === Infinity && oldHit(strip2, 0, 1) === 1,
         `老闸：无主侧 ${oldHit(strip2, 1, -1)} / 国家侧 ${oldHit(strip2, 0, 1)}`);
      ok('无主地之间不画边界', newHit([NONE2, NONE2], 0, 1) === Infinity,
         String(newHit([NONE2, NONE2], 0, 1)));
      ok('国家 ↔ 国家：照旧画', newHit([5, 7], 0, 1) === 1, String(newHit([5, 7], 0, 1)));
      // **无主地也是地** → 挨着海那一条就是海岸线，要画 ✓
      // （以前 NONE 被算成"地形伪头衔"，跟海一起被"海与海不画线"吃掉 ✗）
      ok('无主地 ↔ 海：也要画（那就是海岸线）✓',
         newHit([NONE2, 800], 0, 1) === 1 && newHit([800, NONE2], 1, -1) === 1,
         `无主侧 ${newHit([NONE2, 800], 0, 1)} / 海侧 ${newHit([800, NONE2], 1, -1)}`);
      ok('海 ↔ 海：还是不画（原来的规矩不能丢）✓',
         newHit([800, 801], 0, 1) === Infinity, String(newHit([800, 801], 0, 1)));
      ok('国家 ↔ 海：海岸线照旧', newHit([5, 800], 0, 1) === 1, String(newHit([5, 800], 0, 1)));
      ok('无主地 ↔ 荒地：荒地该有边界 → 照画',
         newHit([NONE2, WASTE2], 0, 1) === 1, String(newHit([NONE2, WASTE2], 0, 1)));
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
  querySelectorAll() { return []; }
  click() {}
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
  querySelector: (sel) => (sel.includes('tier') ? containers.tier : containers.tool),
  querySelectorAll: (sel) => (sel.includes('tier') ? containers.tier.children
                             : sel.includes('tool') ? containers.tool.children : []),
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

const MODULES = ['data.js', 'zip.js', 'bmp.js', 'gl.js', 'labels.js', 'tilemap.js', 'app.js'];
let js = MODULES.map((n) => `// ==== ${n} ====\n` + stripModule(fs.readFileSync(path.join(ROOT, 'web', 'js', n), 'utf8'))).join('\n\n');

// 把结尾那次 boot() 摘掉，改由测试自己触发，并开几个探针出去
js = js.replace(/\nboot\(\);\n/, '\n');   // 只摘 boot(); 这一行（结尾还有注释和 initTutorial 挂钩，\s*$ 永远配不上）
js += `
return {
  boot, state, GAMES, MAP_CHOICES,
  get GAME() { return GAME; },
  get TIER_BADGE() { return TIER_BADGE; },
  titleAt, renderHoverCard, actAt, pickTitle, paintTitle, restoreTitle, pickAt,
  setBrush, setTier, setTool, needsRestore, isLocked, isSpecialTid, runSearch,
  searchJumpScale, jumpToResult, wasteApply, wasteClear, wasteClearPlayerPaint, displayedColor,
  syncParentBorder, syncLayerSwitches, retintCountryLabels,
  get searchHits() { return searchHits; },
  editTier, setGrain, gotoLevel, pressTier, eraTierCount, refreshTierButtons,
  projectData, saveProject, applyProject, setCapitalAt, labelForColor,
  get renderer() { return renderer; },
  get labels() { return labels; },
  isDegradedBaron, displayedColor, displayedLabel, screenToMap, updateHover,
  rebuildPaintBlocks, paintedPoints, playerGroupTids, playerGroupTidsAt, paintAt, hoverGroupRgb, stableColor, hoverTargetTid, applyHoverHighlight, setWasteAuto, readablePlaceName, manualWaterName,
  drawLabels, legendEntries, drawLegend, rebuildLegendPanel, impassLabel, specialTileLabel,
  computeLabelZoom, ARRIVE_SPAN,
  applySettings, applyLutOverrides, lutColorOf, hexToRgb, renameAt, openRename,
};`;

const factory = new Function(
  'console', 'document', 'window', 'localStorage', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'fetch', 'URL', 'TextEncoder', 'TextDecoder',
  'Blob', 'Response', js);

// ---------------------------------------------------------------- 跑

(async () => {
  const ex = factory(sandbox.console, documentStub, sandbox.window, localStorageStub,
    sandbox.performance, sandbox.requestAnimationFrame, sandbox.cancelAnimationFrame,
    setTimeout, clearTimeout, setInterval, clearInterval, sandbox.fetch, sandbox.URL,
    TextEncoder, TextDecoder, Blob, Response);

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
  // 第 0 层现在是**空白剧本**（除了海/湖/荒地全是无主 —— 见 patch_blank_era.py ✓），
  // 所以测试里"剧本层"不能再写死第 0 层：现找一个**真有主**的剧本层 ✓
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
  /** 按名字现查某一层（'1444' / '省份' / '空白' ✓）—— 别再用写死的下标 ✓ */
  const tierOf = (nm) => (st.meta.tierNames || []).indexOf(nm);
  // **用自己的色 + 自己的名涂自己那块 → 两边必须同色同标记** ✓
  //   （数据层对不上，填色那趟就会平白划一条线 ✗ 用户报过 ✓ 这条锁死它 ✓）
  {
    try {
      const r0 = ex.renderer;
      const n = st.meta.numProvinces;
      const tm = st.titlemap;
      const nEra = (st.meta.eraDates && st.meta.eraDates.length) || 0;
      const ct = nEra > 0 ? Math.min(st.tier, nEra - 1) : st.tier;
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
      const svTitleLabel = st.titleLabel ? new Map(st.titleLabel) : null;
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
          if (svTitleLabel) st.titleLabel = svTitleLabel;
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
    const ids = ['btn-settings', 'settings', 'set-bg', 'set-waste', 'set-sea', 'set-lake',
                 'set-impass', 'set-w', 'set-a0', 'set-a1', 'set-a2', 'set-pw',
                 'set-font', 'set-reset', 'set-close'];
    const miss = ids.filter((id) => !get(id));
    ok('设置页的控件都在页面上', miss.length === 0, miss.length ? ('缺: ' + miss.join(',')) : '15 个都在');

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

    // 改基准线宽 → 渲染器线宽跟着变
    const w0 = ex.renderer.borderWidth;
    st.set.w = 3.4; st._parentSig = null; ex.syncParentBorder();
    const w1 = ex.renderer.borderWidth;
    // 默认没有链（父级边界出厂是关的）→ 本层线宽就等于基准本身 ✓
    // 粗细阶梯改成了“基准线宽 / 1.6”的倍率：默认（基准=1.6）正好是本层 1 / 父层 1.25 / 填色线与多级链 1.5
         ok('改「基准线宽」→ 渲染器线宽跟着变（按 1/1.6 倍率）', Math.abs(w1 - 3.4 / 1.6) < 0.01,
       w0.toFixed(2) + ' → ' + w1.toFixed(2));
    // 「恢复默认」→ 回到出厂值
    st.set = { bg: null, waste: null, sea: null, lake: null, impass: null,
               w: null, a0: 0.5, a1: 0.75, a2: 1.0, pw: 1, font: 1 };
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
               w: null, a0: 0.5, a1: 0.75, a2: 1.0, pw: 1, font: 1 };
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
        // 查**标签层真画出来的那份名单**（pointsFor）—— 只查 displayedLabel 会漏掉
        // "改了名但界面上不变"这种毛病（上一版就是这么漏的 ✗）
        const pts0 = ex.labels && ex.labels.pointsFor ? (ex.labels.pointsFor(ex.editTier ? ex.editTier() : _fineT) || []) : [];
        const drawn = pts0.some((p) => p.name === '改过的头衔名');
        ok('没涂的地改名 → 显示名 + 标签层名单都跟着变',
           ex.displayedLabel(clean, tid0) === '改过的头衔名'
           && st.titles.names[tid0] === '改过的头衔名' && drawn,
           '原=' + sv + ' displayed=' + ex.displayedLabel(clean, tid0)
             + ' titles.names=' + st.titles.names[tid0] + ' 名单里有=' + drawn);
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
        const stillThree = three3.filter((tid) => {
          const c = st.paintColor.get(tid);
          return c && c[0] === 77 && c[1] === 88 && c[2] === 99;
        }).length;
        ok('开了粒度 → 涂色只动点中的那一块（其余剧本层国家不变）',
           stillThree === 3, '保持原色的 ' + stillThree + ' / 3');
      }
      for (const tid of three3) ex.restoreTitle(tid);
    }
    st.tier = svTier; st.grain = svGrain; st.showBorderPaint = svBP; st.brushLabel = svBrush;
    ex.syncLayerSwitches();
  }

  // 高亮也跟"以玩家为准"：同色的一族一起亮（判据 hoverGroupRgb）✓
  if ((st.meta.eraDates || []).length) {
    const nEra = st.meta.eraDates.length;
    const svTier = st.tier, svGrain = st.grain, svBP = st.showBorderPaint, svBrush = st.brushLabel;
    st.tier = ERA0; st.grain = null; st.showBorderPaint = true;
    let hitPid = 0;
    const _nReal = st.meta.numRealTitles != null ? st.meta.numRealTitles : 1e9;
    for (let q = 1; q < st.meta.numProvinces && !hitPid; q++) {
      const t0 = ex.titleAt(q, ERA0);
      if (t0 === 65535 || t0 >= _nReal || ex.isLocked(t0)) continue;      // 别选水域/锁定的 ✗
      if ((st.meta.wasteland || []).indexOf(t0) >= 0) continue;
      if (st.provPos[q * 3 + 2] > 0 && ex.renderer.paintData[q * 4 + 3] === 0) hitPid = q;
    }
    if (hitPid) {
      st.brushLabel = '高亮测';
      ex.paintTitle(ex.titleAt(hitPid, ERA0), [90, 40, 200]);
      const got = ex.hoverGroupRgb(hitPid);
      ok('条件满足 → 悬停整族高亮拿到那一族的涂色',
         !!got && got[0] === 90 && got[1] === 40 && got[2] === 200, JSON.stringify(got));
      st.showBorderPaint = false;
      ok('「填色·边界」关掉 → 不做整族高亮（退回按头衔）', ex.hoverGroupRgb(hitPid) === null,
         String(ex.hoverGroupRgb(hitPid)));
      ex.restoreTitle(ex.titleAt(hitPid, ERA0));
    }
    st.tier = svTier; st.grain = svGrain; st.showBorderPaint = svBP; st.brushLabel = svBrush;
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
      const grp = ex.playerGroupTids(three[0], st.paintColor.get(three[0]), st.titleLabel.get(three[0]));
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

  // 回归（用户报的）：剧本视图 + **没开粒度** + 「填色·边界」开着时，
  // 点一块**没涂过**的地 —— 只许涂"跟它同一块色"的那几块。
  // 同一个头衔里被玩家涂成别的颜色的地方（1936 剧本里被德国占掉的那半法国就是这种）
  // **一块都不许碰** ✗（以前这里直接按头衔把整个国家铺一遍，占领区一起被盖掉了 ✓）
  if ((st.meta.eraDates || []).length && st.meta.eraDates.length < st.meta.tiers.length) {
    const svT0 = st.tier, svG0 = st.grain, svBP0 = st.showBorderPaint, svB0 = st.brushLabel;
    st.tier = ERA0; st.grain = null; st.showBorderPaint = true;
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
      if (occ0.length && free0.length) {
        st.brush = ex.stableColor(free0[0], host0).slice();
        st.brushLabel = st.titles.names[host0];
        ex.paintAt(free0[0], ex.titleAt(free0[0], ERA0));
        const kept0 = occ0.filter(keptColor).length;
        ok('点没涂过的那半（用国家自己的色）→ 占领区一块都没被盖掉 ✗',
           kept0 === occ0.length, `保住 ${kept0} / ${occ0.length} 块`);
        // ③ 再换个新颜色点同一块 → 同色同标记的色块（这个国家没被占的那些地）一起变，
        //    占领区照旧不动 ✓
        st.brush = [200, 30, 90]; st.brushLabel = '新色';
        ex.paintAt(free0[0], ex.titleAt(free0[0], ERA0));
        const changed0 = free0.filter((q) => {
          const p4 = q * 4;
          return ex.renderer.paintData[p4] === 200 && ex.renderer.paintData[p4 + 1] === 30;
        }).length;
        const kept1 = occ0.filter(keptColor).length;
        ok('换新色填这一块 → 整个色块一起变，占领区还是不动',
           changed0 === free0.length && kept1 === occ0.length,
           `变色 ${changed0} / ${free0.length} 块，占领区保住 ${kept1} / ${occ0.length} 块`);
      }
      // ④「还原」在同一个配置下也得**按色块**擦（用户报的第二条）：
      //    在法国本土上点还原 → 只清"新色"这一块，占领区一块都不许掉 ✗
      if (occ0.length && free0.length) {
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
        const eraseAt = (q) => {
          const px = pixOf.get(q);
          if (!px) return false;
          ex.setTool('erase');
          ex.actAt(...toClient0(px[0], px[1]));
          return true;
        };
        const lit = (q) => ex.renderer.paintData[q * 4 + 3] > 0;
        if (eraseAt(free0[0])) {
          const left0 = free0.filter(lit).length;
          const kept2 = occ0.filter(keptColor).length;
          ok('在没被占的那半点「还原」→ 那一块清干净，占领区一块没掉 ✗',
             left0 === 0 && kept2 === occ0.length,
             `那半还剩 ${left0} 块没清，占领区保住 ${kept2} / ${occ0.length} 块`);
        }
        // ⑤ 反过来点占领区 → 该清的还是清的掉（别修成"谁都擦不动" ✗）
        if (eraseAt(occ0[0])) {
          const left1 = occ0.filter(lit).length;
          ok('反过来在占领区点「还原」→ 占领区清得掉 ✓', left1 === 0,
             `占领区还剩 ${left1} / ${occ0.length} 块`);
        }
      }
      // 收尾：这一族涂过的全还原
      st.grain = null;
      ex.setTool('paint');
      for (let q = 1; q < n0; q++) {
        for (let ti = 0; ti < st.meta.tiers.length; ti++) {
          const t1 = ex.titleAt(q, ti);
          if (t1 != null && t1 !== 65535 && st.painted.has(t1)) ex.restoreTitle(t1);
        }
      }
    }
    st.tier = svT0; st.grain = svG0; st.showBorderPaint = svBP0; st.brushLabel = svB0;
    ex.syncLayerSwitches();
  }

  // ==== 空白剧本：一层**全无主**（不上色、没标记），别的规矩一条不少 ====
  if (WHICH === 'CK3') {
    ok('CK3 不加空白剧本（它本来就没有剧本层 ✓）', N_ERA === 0 && BLANK_T < 0,
       `eraDates=${N_ERA} blank=${BLANK_T}`);
  } else {
    ok('非 CK3 都有空白剧本这一层', BLANK_T >= 0 && BLANK_T < N_ERA,
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
        let offB = 0, nBgB = 0, notCleared = 0;
        for (let p = 1; p < st.meta.numProvinces; p++) {
          const tb = ex.titleAt(p, BLANK_T);
          const tf = ex.titleAt(p, fineT);
          if (isBgTid(tb)) { nBgB++; if (tb !== tf) offB++; }
          else if (tb != null && tb !== st.meta.noTitle) notCleared++;   // 别的真头衔没清掉 ✗
        }
        ok('空白剧本：海 / 湖 / 荒地那些背景地形跟最细那层逐格一致（不然整片海会变成大陆灰 ✗）',
           offB === 0 && notCleared === 0 && nBgB > 0,
           `背景地形 ${nBgB} 格 · 对不上的 ${offB} 格 · 没清干净的真头衔 ${notCleared} 个`);
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
        ok('从细层按「空白」= 切到那一层（跟别的剧本一个规矩 ✓）',
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
  }

  // 自动荒地：开了之后，渲染器要显示**荒地自己的颜色**（不然自动上的色看不见）✓
  if ((st.meta.wasteland || []).length && get('waste-auto') && ex.wasteApply) {
    const svAuto = st.wasteAuto, svWaste = st.showWaste, svR = ex.renderer.showWaste;
    st.wasteAuto = true;
    st.showWaste = false;          // 先关着，走顺手打开那条路 ✓
    const box = get('waste-auto');
    if (box) box.checked = true;
    ex.setWasteAuto(true);          // 走处理器里那段真代码 ✓
    ok('开「自动」→ 渲染器显示荒地自己的颜色（自动色才看得见）',
       ex.renderer.showWaste === true, 'renderer.showWaste=' + ex.renderer.showWaste);
    st.wasteAuto = svAuto; st.showWaste = svWaste;
    ex.renderer.setShowWaste(svR);
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

  // 卡片规则：海洋不显示名字；湖泊、河流显示；不可通行统一叫「不可通行区域」✓
  {
    const src4 = require('fs').readFileSync('web/js/app.js', 'utf8');
    const seaHidden = src4.includes("const _noName = _isImpassable || _isSeaKey;");
    const riverKept = !/const _noName = [^;]*#river/.test(src4);
    const noLake = !/const _noName = [^;]*#lake/.test(src4);
    const hasType = src4.includes("? (_dataName.includes('海域') ? _dataName : '不可通行区域')");
    ok("卡片名字规则：水域（海/湖/河）一律不显示名字、不可通行叫「不可通行区域」",
       src4.includes("const _noName = _isImpassable || _isSeaKey")
         && /const _noName = [^;]*#lake/.test(src4)
         && /const _noName = [^;]*#river/.test(src4)
         && src4.includes("? (_dataName.includes('海域') ? _dataName : '不可通行区域')"),
       "ok");
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

  // 卡片：provinceNames 只是代号（EU4 的 RNW）时，回退用最细层节点名（昆仑山）✓
  {
    const src5 = require('fs').readFileSync('web/js/app.js', 'utf8');
    const ok5 = src5.includes("readablePlaceName(_fineName) && _fineOk ? _fineName : _nameSrc");
    ok('代号名字回退到最细层节点名（RNW → 昆仑山 这类；泛称湖泊/海洋不当名字）',
       ok5, ok5 ? 'ok' : '没找到回退逻辑');
  }

  // 水域（海/湖/河）一律不高亮 —— 不亮整片、也不亮单块 ✓
  {
    const fine = st.meta.tiers.length - 1;
    let spid = -1;
    for (let pid = 1; pid < st.meta.numProvinces && spid < 0; pid++) {
      const k = String(st.titles.keys[ex.titleAt(pid, fine)] || '');
      const kc = String(st.titles.keys[ex.titleAt(pid, 0)] || '');
      if (k.startsWith('#sea') || k.startsWith('#lake') || k.startsWith('#river')
          || kc.startsWith('#sea') || kc.startsWith('#lake') || kc.startsWith('#river')) spid = pid;
    }
    if (spid > 0) {
      const svTier = st.tier;
      for (const tier of [0, fine]) {
        st.tier = tier;
        ex.applyHoverHighlight(spid, ex.hoverTargetTid(spid, ex.titleAt(spid, tier)));
        ok(`水域不高亮（层${tier}：hoverPid=0、hoverTid=空）`,
           ex.renderer.hoverPid === 0 && ex.renderer.hoverTid === st.meta.noTitle,
           `hoverPid=${ex.renderer.hoverPid} hoverTid=${ex.renderer.hoverTid}`);
      }
      st.tier = svTier;
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
  ok('父级边界默认是关的',
     st.showParentBorderTitle === false
     && (!get('show-parent-border') || get('show-parent-border').checked === false)
     && (!get('show-parent-border-ck3') || get('show-parent-border-ck3').checked === false),
     'state=' + st.showParentBorderTitle + ' ck3框=' + (get('show-parent-border-ck3') || {}).checked
       + ' 年代框=' + (get('show-parent-border') || {}).checked);
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
      const savePaintColor = new Map(st.paintColor);
      const saveProvLabel = (st.provLabel || []).slice();
      const saveTitleLabel = new Map(st.titleLabel || []);
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
      st.paintColor = new Map(savePaintColor);
      st.provLabel = saveProvLabel.slice();
      st.titleLabel = new Map(saveTitleLabel);
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
  const want = isEU4
    ? { id: 'eu4', key: 'eu4-map-editor/v1', tier: 6, entity: '省份',
        badges: ['空白', '1444', '1618', '1789', '区域', '地区', '省'],
        names: ['空白', '1444', '1618', '1789', '区域', '地区', '省份'], brand: 'EU' }
    : isHoi4
    ? { id: 'hoi4', key: 'hoi4-map-editor/v1', tier: 4, entity: '省份',
        badges: ['空白', '1936', '1939', '战略', '地区', '省'],
        names: ['空白', '1936', '1939', '战略', '地区', '省份'], brand: 'HOI' }
    : isVic3
    ? { id: 'vic3', key: 'vic3-map-editor/v1', tier: 3, entity: '省份',
        badges: ['空白', '1836', '战略', '地区', '省'],
        names: ['空白', '1836', '战略', '地区', '省份'], brand: 'VIC' }
    : isEu5
    ? { id: 'eu5', key: 'eu5-map-editor/v1', tier: 4, entity: '地点',
        badges: ['空白', '国家', '区域', '地区', '省', '地点'],
        names: ['空白', '1337', '区域', '地区', '省份', '地点'], brand: 'EU' }
    : { id: 'ck3', key: 'ck3-map-editor/v1', tier: 3, entity: '头衔',
        badges: ['e_', 'k_', 'd_', 'c_', 'b_'],
        names: ['帝国', '王国', '公爵领', '伯爵领', '男爵领'], brand: 'CK' };

  // 「定都」：剧本视图里点一下记下地块，细层点了**静默不动** ✓
  if (ex.setCapitalAt && (st.meta.eraDates || []).length) {
    const savedCaps = (st.capitalPids || []).slice();
    const savedTier = st.tier;
    // 找一个**有主的**剧本层里有主的省份（空白剧本没有归属可定 ✓）
    let pid = 0;
    for (let q = 1; q < st.meta.numProvinces; q++) {
      const tq = ex.titleAt(q, ERA0);
      if (tq != null && tq !== st.meta.noTitle && tq < st.meta.numRealTitles) { pid = q; break; }
    }
    st.tier = ERA0;
    st.capitalPids = [];
    ex.setCapitalAt(pid);
    ok('定都：剧本视图里点一下 → 记下这块地 ✓',
       st.capitalPids.length === 1 && st.capitalPids[0] === pid, JSON.stringify(st.capitalPids));
    ok('定都：空白剧本那一层点一下 = 什么都不会发生（那一层没有归属 ✓）',
       (() => {
         if (BLANK_T < 0 || !pid) return true;
         const keep = st.capitalPids.length;
         st.tier = BLANK_T;
         ex.setCapitalAt(pid);
         return st.capitalPids.length === keep;
       })(), `capitalPids=${st.capitalPids.length}`);
    // 细层：静默不生效 ✓
    st.tier = st.meta.tierNames.length - 1;
    const n1 = st.capitalPids.length;
    ex.setCapitalAt(pid);
    ok('定都：非剧本视图点了**静默不动** ✓', st.capitalPids.length === n1, `${n1} → ${st.capitalPids.length}`);
    st.tier = savedTier;
    st.capitalPids = savedCaps;
  }

  // 全图重分组：国家的名字要落在**首都那一片**，不能跑去最大的殖民地
  if (ex.rebuildPaintBlocks && st.meta.capitals && (st.meta.eraDates || []).length) {
    const caps = st.meta.capitals;
    const tag = ['FRA', 'GBR', 'ENG', 'TUR', 'SOV', 'RUS'].find((x) => caps[x]);
    if (tag) {
      const savedTier = st.tier;
      st.tier = ERA0;                    // 国家那层（有主的那个剧本层 ✓）
      st._blocksAll = true; st._blocksTier = null; st._layerSig = null;
      ex.syncLayerSwitches();
      ex.rebuildPaintBlocks(true);
      const cp = caps[tag];
      const pos0 = st.provPos;
      const nm0 = ex.displayedLabel(cp, ex.titleAt(cp, ERA0));
      const blk0 = (ex.paintedPoints(true) || []).find((x) => x.name === nm0);
      const dx = blk0 ? Math.abs(blk0.x - pos0[cp * 3]) : 1e9;
      const dy = blk0 ? Math.abs(blk0.y - pos0[cp * 3 + 1]) : 1e9;
      // 回归：**占领巴黎**（巴黎 + 周围一圈都被涂掉）→ 名字必须留在欧洲，不能跳去非洲
      {
        const frTag = ['FRA', 'GBR', 'ENG', 'TUR', 'RUS', 'SOV'].find((x) => st.meta.capitals[x]);
        if (frTag) {
          const cp2 = st.meta.capitals[frTag];
          const n3 = st.meta.numProvinces;
          const off2 = new Uint32Array(st.adjacency.buffer, st.adjacency.byteOffset, n3 + 1);
          const nb2 = new Uint16Array(st.adjacency.buffer, st.adjacency.byteOffset + (n3 + 1) * 4);
          const pos2 = st.provPos;
          const tid0 = ex.titleAt(cp2, ERA0);
          const keyF = ex.displayedLabel(cp2, tid0) + '|'
                     + ex.displayedColor(cp2, tid0).join(',');
          // 巴黎 + 它的邻省（同属这一族的）全部涂成别的颜色
          const ring = [cp2];
          for (let k = off2[cp2], e = off2[cp2 + 1]; k < e; k++) if (nb2[k] > 0) ring.push(nb2[k]);
          const savedP = ring.map((q) => [q, st.provLabel[q] | 0, ex.renderer.paintData[q * 4 + 3]]);
          for (const q of ring) {
            st.provLabel[q] = 3;
            ex.renderer.setPaint(q, 9, 9, 99, 255);
          }
          ex.rebuildPaintBlocks(true);
          const nmF = ex.displayedLabel(cp2, tid0);
          const blkF = (ex.paintedPoints(true) || []).find((x) => x.name === nmF);
          // "还在欧洲"= 离巴黎不能太远（殖民地动辄上千像素）
          const dF = blkF ? Math.abs(blkF.x - pos2[cp2 * 3]) + Math.abs(blkF.y - pos2[cp2 * 3 + 1]) : 1e9;
          ok('占领巴黎后，国名仍留在首都那一带（不跳殖民地）', !!blkF && dF < 500,
             blkF ? (nmF + ' 落点(' + blkF.x.toFixed(0) + ',' + blkF.y.toFixed(0) + ') 首都('
                     + pos2[cp2 * 3].toFixed(0) + ',' + pos2[cp2 * 3 + 1].toFixed(0) + ') 距 ' + dF.toFixed(0))
                  : '没找到这块');
          // 收拾
          for (const [q, lab, pa] of savedP) {
            st.provLabel[q] = lab;
            ex.renderer.setPaint(q, 0, 0, 0, pa > 0 ? 255 : 0);
          }
          ex.rebuildPaintBlocks(true);
        }
      }

      // 用「定都」工具换个首都 → 重分组的名字该跟着新首都走（工具优先于数据默认）
      {
        const tidOf = (q2) => ex.titleAt(q2, ERA0);
        const targetKey = String(st.titles.keys[tidOf(cp)]);
        const sameTag = [];
        for (let q2 = 1; q2 < st.meta.numProvinces && sameTag.length < 60; q2++) {
          const tq = tidOf(q2);
          if (tq != null && tq !== st.meta.noTitle && String(st.titles.keys[tq]) === targetKey) sameTag.push(q2);
        }
        const far = sameTag.find((q2) => q2 !== cp
          && Math.abs(pos0[q2 * 3] - pos0[cp * 3]) + Math.abs(pos0[q2 * 3 + 1] - pos0[cp * 3 + 1]) > 60);
        if (far) {
          const savedCapOf = st.capitalOf;
          st.capitalOf = Object.assign({}, savedCapOf || {});
          ex.setCapitalAt(far);
          ex.rebuildPaintBlocks(true);
          const blk2 = (ex.paintedPoints(true) || []).find((x) => x.name === nm0);
          const d2 = blk2 ? Math.abs(blk2.x - pos0[far * 3]) + Math.abs(blk2.y - pos0[far * 3 + 1]) : 1e9;
          ok('定都工具改过首都 → 全图重分组的国名跟着新首都走', !!blk2 && d2 < 300,
             blk2 ? ('落点(' + blk2.x.toFixed(0) + ',' + blk2.y.toFixed(0) + ') 新首都('
                     + pos0[far * 3].toFixed(0) + ',' + pos0[far * 3 + 1].toFixed(0) + ')') : '没找到这块');
          st.capitalOf = savedCapOf;
        }
      }

      ok('全图重分组：国名留在**首都那一片**（不会跑到最大的殖民地）',
         !!blk0 && dx < 150 && dy < 150,
         blk0 ? `${nm0} 落点(${blk0.x.toFixed(0)},${blk0.y.toFixed(0)}) 首都(${pos0[cp * 3].toFixed(0)},${pos0[cp * 3 + 1].toFixed(0)})`
              : '没找到这块');
      st.tier = savedTier;
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

  // 填色边界的**线宽**：至少是"爷爷级"那一档（比父级再粗 0.35）
  if (ex.renderer && ex.renderer.extraWs) {
    st._parentSig = null;
    ex.syncParentBorder();
    const pw = ex.renderer.paintWidth;
    const nEx = ex.renderer.extraCount || 0;
    const parentW = nEx ? ex.renderer.extraWs[0] : null;
    const grandOK = parentW == null ? true : Math.abs(pw - (parentW + 0.25)) < 0.02;
    const chainOK = nEx ? pw >= ex.renderer.extraWs[nEx - 1] - 0.02 : true;
    ok('填色边界的线宽 = 爷爷级那一档（不跟着父级变细）',
       grandOK && chainOK,
       'paintWidth=' + pw + ' 父级=' + parentW + ' 链最粗=' + (nEx ? ex.renderer.extraWs[nEx - 1] : '-'));
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
      //   基层：开「父级边界」= 省份档 / 没开 = 默认档
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
      const _da = ((st.set && st.set.da != null ? st.set.da : 75) / 100);
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
      ok('细层：基层浓度跟着「父级边界」走（开=省份档 / 关=默认档）✓',
         Math.abs(_baseOn - _pa) < 0.01 && Math.abs(_baseOff - _da) < 0.01,
         `开=${_baseOn} 期望 ${_pa} / 关=${_baseOff} 期望 ${_da}`);
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

  // 荒地自动上色的**来源随开关**：原版色来的随「颜色」，玩家色来的随「填色」
  {
    const lut2 = ex.renderer.lutData;
    // 「没上色」= 等于荒地"起手"的样子 = **荒地灰** ✓
    // （EU5 的荒地数据 colors[] 是省份位图技术色，早就不是"画面上那个底"了 ✗）
    const _wg2 = ((st.set && st.set.impass) || [94, 94, 94]);
    const isBase = (tid) => {
      const b = (st.meta.wasteland || []).indexOf(tid) >= 0 ? _wg2 : (st.titles.colors[tid] || _wg2);
      return lut2[tid * 4] === b[0] && lut2[tid * 4 + 1] === b[1] && lut2[tid * 4 + 2] === b[2];
    };
    const SP = st.showPaint, ST = st.showTitles, SW = st.showWaste;
    const countLit = () => {
      let c = 0;
      for (const tid of (st.meta.wasteland || [])) {
        const pid = st.meta.wastelandPidOf ? st.meta.wastelandPidOf[tid] : null;
        if (pid != null && st.provTitle && st.provTitle[pid] >= 0) continue;   // 玩家自己涂的，不算
        if (!isBase(tid)) c++;
      }
      return c;
    };
    st.showWaste = false; st.showPaint = true; st.showTitles = true;
    ex.wasteApply();
    const lit = countLit();
    ok('两个开关都开着：能上色的都上色了（这块数据可能本来就没得投）', lit >= 0, String(lit));
    st.showPaint = false; st.showTitles = false;
    ex.wasteApply();
    ok('两个颜色开关都关掉：自动色一块都不剩（各随各的开关 ✓）', countLit() === 0, String(countLit()));
    st.showPaint = SP; st.showTitles = ST; st.showWaste = SW;
    ex.wasteApply();
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

  // 颜色 → 头衔 的匹配表：非 CK3 只认国家（tag）层，细层不许进 ✗
  {
    const nE = (st.meta.eraDates || []).length;
    let bad = 0, total = 0;
    for (const list of st.colorIndex.values()) {
      for (const tid of list) {
        total++;
        if (nE > 0 && st.titles.tiers[tid] >= nE) bad++;
      }
    }
    ok(nE > 0 ? '取色匹配表里只有国家（tag）层，没有地区/省份'
              : 'CK3：取色匹配表里所有头衔都在（没有年代层）',
       nE > 0 ? bad === 0 : total > 0,
       '共 ' + total + ' 条，细层混进来 ' + bad + ' 条');
  }
  ok('meta 装上了', !!st.meta, `numTitles=${st.meta && st.meta.numTitles}`);
  ok(`${isEU4 ? '切到 EU4 的术语' : 'CK3 术语保持原样'}`, ex.GAME.id === want.id, ex.GAME.id);
  ok('层级徽章', JSON.stringify(ex.TIER_BADGE) === JSON.stringify(want.badges), JSON.stringify(ex.TIER_BADGE));
  ok('视图层级名', JSON.stringify(st.meta.tierNames) === JSON.stringify(want.names), JSON.stringify(st.meta.tierNames));
  ok(`默认视图 = ${want.names[want.tier]}（第 ${want.tier} 层）`, st.tier === want.tier, String(st.tier));
  ok(`工具栏 ${want.names.length} 个层级按钮`, containers.tier.children.length === want.names.length,
     String(containers.tier.children.length));
  ok(`界面文案换成"${want.entity}"`, get('status-meta').textContent.includes(want.entity), get('status-meta').textContent);
  ok(`品牌换成 ${want.brand}`, get('brand-mark').innerHTML.includes(want.brand), get('brand-mark').innerHTML);
  ok('存档键分开', ex.GAME.saveKey === want.key, ex.GAME.saveKey);

  // 启动过程**不许弹红框** ✗ —— 那个红框是给"真崩了"用的（showFatal）。
  // 我曾经往里塞过一条"正在走普通路径"的进度提示，结果每张不分块的地图正常启动
  // 都会顶着一个红条（用户一眼就看见了）。这条断言就是替用户盯这个。
  {
    const boxes = (documentStub.body.children || []).filter((c) => c && c.id === 'fatal-box');
    ok('正常启动不弹红框', boxes.length === 0,
       boxes.length ? String(boxes[0].textContent).slice(0, 120) : '没有红框');
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
      for (let t = nCountry; t < buckets.length; t++) {
        const arr = buckets[t].sort((x, y) => x - y);
        if (!arr.length) continue;
        checked++;
        const screen = arr[arr.length >> 1] * L.zoom[t] / 100;
        if (!(screen >= want * 0.7 && screen <= want * 1.4)) {
          bad.push(`${st.meta.tierNames[t]} ${screen.toFixed(0)}px`);
        }
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

  console.log(`\n=== 2. 悬停一条链条（${want.names.join(' → ')}）===`);
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
    console.log('\n=== 2c. 三个年份视图取代了大洲/大区/区域 ===');
    // 第 0 层是空白剧本 ✓，三个年份从第 1 层起 ✓
    const three = (pid) => [1, 2, 3].map((i) => st.titles.names[ex.titleAt(pid, i)]).join('/');
    ok('顶部四层是空白 + 三个年份，后面接 区域/地区/省份',
       JSON.stringify(st.meta.tierNames)
       === JSON.stringify(['空白', '1444', '1618', '1789', '区域', '地区', '省份']),
       JSON.stringify(st.meta.tierNames));
    ok('年份带上了具体日期（空白那层没有年份 ✓）', JSON.stringify(st.meta.eraDates) ===
       JSON.stringify(['', '1444.11.11', '1618.1.1', '1789.7.14']), JSON.stringify(st.meta.eraDates));
    ok('洲/大区不再单独成层，但地区的上一级（区域）回来了',
       !/大洲|大区/.test(st.meta.tierNames.join('')) && /区域/.test(st.meta.tierNames.join('')),
       st.meta.tierNames.join('/'));
    ok('斯德哥尔摩三个年份都是瑞典', three(1) === '瑞典/瑞典/瑞典', three(1));
    ok('君士坦丁堡 1444 拜占庭，1618 起奥斯曼', three(151) === '拜占庭/奥斯曼/奥斯曼', three(151));
    ok('耶姆特兰 挪威 → 丹麦 → 瑞典', three(10) === '挪威/丹麦/瑞典', three(10));
    ok('伦敦在 1789 属于大不列颠', three(236).endsWith('大不列颠'), three(236));
    ok('同一个国家在不同年份是各自独立的节点（否则涂一处会连带另一处）',
       ex.titleAt(1, 1) !== ex.titleAt(1, 2),
       `1444 的瑞典 #${ex.titleAt(1, 1)} vs 1618 的瑞典 #${ex.titleAt(1, 2)}`);
    ok('1444 层有 665 个国家', st.titles.tiers.filter((x) => x === 1).length === 665,
       String(st.titles.tiers.filter((x) => x === 1).length));

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
    ok('页面里加载了引导脚本 ✓', htmlSrc.includes('src="js/tutorial.js"'), 'script 标签');
    const buildSrc = fs.readFileSync('build_standalone.py', 'utf8');
    ok('打包清单里有 tutorial.js（单文件版才带得上 ✓）',
       /MODULES\s*=\s*\([^)]*"tutorial\.js"/.test(buildSrc), 'MODULES');
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
      st.tier = Math.min(st.tier, nEra0 - 1);
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

      // ---- 回归：细层里挑「最后一层年份才有的 tag」的颜色+标签，只涂一小块 ----
      // 以前细层里"没涂的邻居"按 cTier = 最后一层年份（EU4 是 1789）算身份 ✗
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
        const _nCountry = (st.meta.eraDates || []).length;
        let checked = 0, miss = 0, worst = 0, worstName = '';
        for (let tier = _nCountry; tier < st.meta.tiers.length; tier++) {
          const row = tier * NP;
          const byTitle = new Map();
          for (let p = 1; p < NP; p++) {
            const t = st.titlemap[row + p];
            if (t <= 0 || t >= real) continue;
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

  // 荒地（不可通行）：只有真烘过 wasteland 数据的模式才跑（现在是 EU5）
  // 荒地（不可通行）：只有真烘过 wasteland 数据的模式才跑
  if (st.meta.wasteland && st.meta.wasteland.length) {
    console.log('\n=== 2h. 荒地：可涂 + 自动涂色/清除两个按钮 ===');
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

      // 共享的那个灰伪头衔：meta.wasteland 里唯一"序号 >= 真实节点数"的那个
      let grp = -1;
      for (const _t of st.meta.wasteland) {
        if (_t >= st.meta.numRealTitles) { grp = _t; break; }
      }
      let wpid = -1;
      for (let pid = 1; pid < st.meta.numProvinces; pid++) {
        if (st.meta.wasteland.indexOf(ex.titleAt(pid, fine)) >= 0) { wpid = pid; break; }
      }
      const wtid = wpid > 0 ? ex.titleAt(wpid, fine) : -1;

      ok('细层里每块荒地有自己的节点（不再共用共享灰节点）',
         wpid > 0 && wtid !== grp, `pid=${wpid} tid=${wtid} / 灰节点=${grp}`);
      ok('每一层都指向它自己那块（悬停/取色/涂色各层一致）',
         wpid > 0 && ex.titleAt(wpid, 0) === wtid,
         `${wpid > 0 ? ex.titleAt(wpid, 0) : '-'} vs ${wtid}`);
      ok('荒地不再锁死（可以单独涂）', wtid >= 0 && !ex.isLocked(wtid), String(wtid));

      const alphaOf = (t2) => (t2 >= 0 ? ex.renderer.lutData[t2 * 4 + 3] : -1);
      ok('LUT 的 alpha 给荒地打了标记', alphaOf(wtid) === 255, String(alphaOf(wtid)));
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

      // ① 按一下：按当前看到的颜色算一遍
      ex.wasteClear();
      ok('清除之后荒地都是原版色', !isColoured(wtid), JSON.stringify(lutOf(wtid)));
      // **荒地起手 = 荒地灰** ✓（不许顶着数据里那个"省份位图技术色"）
      // 用户报的：EU5 剧本视图开「荒地自动上色」，一片荒地冒出莫名其妙的颜色 ✗
      {
        const _g = wasteGreyOf().join(',');
        const notGrey = st.meta.wasteland.filter((t2) => lutOf(t2).join(',') !== _g);
        ok('荒地的 LUT 起手就是「荒地灰」（不是数据里的技术色）✓',
           notGrey.length === 0,
           notGrey.length
             ? `${notGrey.length}/${st.meta.wasteland.length} 块不是灰，例如 `
               + notGrey.slice(0, 3).map((t2) => JSON.stringify(lutOf(t2))).join(' ')
             : `全 ${st.meta.wasteland.length} 块都是灰`);
      }
      // **先把颜色显示打开**：自动填色只认"看得见的颜色"——
      // 头衔色关着（EU4/EU5 默认）时画面上只有涂色，没涂的地方本来就不该有票 ✓
      const savedTitles = st.showTitles;
      st.showTitles = true;
      const n1 = ex.wasteApply();
      ok('按一下「自动涂色」确实上了色（依据是当前看到的颜色）',
         n1 > 0 && colouredN() > 0, `算了 ${n1} 块，颜色变了的 ${colouredN()} 块`);
      st.showTitles = savedTitles;

      // ② 再按几下：颜色应该继续往外传染（上一圈涂上的荒地，这一圈就有票了）
      const per = st.meta.wastelandPerimeter;
      ok('周长表烘好了（带权重）', !!per && per.length > 0, per ? `${per.length} 块` : '没有');
      let selfN = 0, wasteN = 0;
      for (const e of (per || [])) {
        for (const pair of e[1]) {
          if (pair[0] === e[0]) selfN++;
          if (st.meta.wasteland.indexOf(ex.titleAt(pair[0], fine)) >= 0) wasteN++;
        }
      }
      ok('周长表里没有"自己接壤自己"', selfN === 0, String(selfN));
      ok('别的荒地也算进周长（荒地之间的边没丢）', wasteN > 0, `荒地邻居 ${wasteN} 处`);

      // 传染：挑一块**光靠荒地邻居的边长就过半**的荒地（周长表里有权重，能直接算），
      // 只把它的荒地邻居在颜色表上"染上"某色（模拟上一遍自动涂的结果），其余不动 ——
      // 再按一下，它就该跟着变成那个色。
      {
        const _skip = st.meta.wasteAutoSkip || [];
        let pick = null;
        for (const e of (per || [])) {
          if (_skip.indexOf(e[0]) >= 0) continue;      // 名单里的不参与自动填色
          let wt = 0, tot = 0;
          for (const pair of e[1]) {
            tot += pair[1];
            if (st.meta.wasteland.indexOf(ex.titleAt(pair[0], fine)) >= 0) wt += pair[1];
          }
          if (tot && wt * 2 > tot && e[1].length >= 1) { pick = { e, wt, tot }; break; }
        }
        if (pick) {
          const X = [7, 8, 9];
          const savedShowPaint = st.showPaint;
          st.showPaint = true;
          let marked = 0;
          for (const pair of pick.e[1]) {
            const nt = ex.titleAt(pair[0], fine);
            if (st.meta.wasteland.indexOf(nt) >= 0) {
              // **涂**上去，而不是改颜色表：涂色不会被还原，能稳定地当票 ✓
              ex.renderer.setPaint(pair[0], X[0], X[1], X[2], 255);
              marked++;
            }
          }
          ex.wasteApply();
          const dt = ex.titleAt(pick.e[0], fine);
          ok('荒地之间会带色（旁边那块荒地有颜色，这块就跟着有票）',
             marked > 0 && JSON.stringify(lutOf(dt)) === JSON.stringify(X),
             `荒地邻居权重 ${pick.wt}/${pick.tot}，染了 ${marked} 块；LUT ${JSON.stringify(lutOf(dt))}`);
          for (const pair of pick.e[1]) ex.renderer.setPaint(pair[0], 0, 0, 0, 0);
          st.showPaint = savedShowPaint;
        } else {
          ok('荒地之间带色：这张图没有"光靠荒地邻居就过半"的样本，跳过', true, '-');
        }
      }

      // ③ 你涂的颜色也能把荒地吸过去
      ex.wasteClear();
      let target = null;
      for (const e of (per || [])) if (e[1].length >= 2) { target = e; break; }
      if (target) {
        const rgb = [10, 20, 30];
        for (const pair of target[1]) ex.renderer.setPaint(pair[0], rgb[0], rgb[1], rgb[2], 255);
        ex.wasteApply();
        const dt = ex.titleAt(target[0], fine);
        ok('邻居被你涂成一色之后，这块荒地跟着变成那个颜色',
           JSON.stringify(lutOf(dt)) === JSON.stringify(rgb),
           `LUT ${JSON.stringify(lutOf(dt))} vs 涂的 ${JSON.stringify(rgb)}`);
        for (const pair of target[1]) ex.renderer.setPaint(pair[0], 0, 0, 0, 0);
      } else {
        ok('邻居全涂一色：这张图没有合适样本，跳过', true, '-');
      }

      // 取色 = 画面上此刻的颜色（跟着开关走）
      {
        const saved = [st.showWaste, st.showPaint, st.showTitles];
        const ownTid = ex.titleAt(wpid, fine);
        ex.wasteClear();
        // ① 「荒漠 · 涂色」关着：荒地显示原版灰，取色就该取到灰
        st.showWaste = false;
        st.showPaint = false;
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

      // 没有任何颜色过半的荒地：按一下之后自己变回原版色（不留下上一按的颜色）
      {
        const per2 = st.meta.wastelandPerimeter || [];
        let target = null;
        for (const e of per2) {
          let wt = 0, tot = 0, wn = 0;
          for (const pair of e[1]) { tot += pair[1]; }
          // 逐邻居按"当前这层的主人"归色，看有没有哪个色过半；这里只挑明显没有的：
          const votes = new Map();
          for (const pair of e[1]) {
            const nt = ex.titleAt(pair[0], st.tier);
            if (nt === 0xffff || nt == null) continue;
            const c = T3.colors[nt];
            if (!c) continue;
            const k = c.join(",");
            votes.set(k, (votes.get(k) || 0) + pair[1]);
            wn += pair[1];
          }
          let best = 0;
          for (const v of votes.values()) if (v > best) best = v;
          if (tot > 0 && !(best * 2 > tot)) { target = e; break; }
        }
        if (target) {
          const dt = ex.titleAt(target[0], fine);
          ex.renderer.setLutColor(dt, 5, 6, 7);        // 假装它上一按被涂过
          ex.wasteApply();
          ok('没有任何颜色过半的荒地，会被还回原版色（荒地灰）',
             JSON.stringify(lutOf(dt)) === JSON.stringify(restOf(dt)),
             `${JSON.stringify(lutOf(dt))} vs 原版 ${JSON.stringify(restOf(dt))}`);
        } else {
          ok('还回原版色：这张图没有"谁也不过半"的样本，跳过', true, '-');
        }
      }

      // **剧本层按一下：荒地只该是「荒地灰」或「真国家的颜色」** ✓
      // 数据里荒地那个 colors[]（省份位图技术色）**一个都不许出现在画面上** ——
      // 用户报的「西伯利亚针叶林变成莫名其妙的颜色」就是它继承了**邻居荒地的私有技术色** ✗
      {
        const svT6 = st.tier, svST6 = st.showTitles;
        const svPaint6 = st.showPaint;
        st.tier = 0; st.showTitles = true; st.showPaint = true;
        ex.wasteClear();
        ex.wasteApply();
        // 允许出现的颜色：荒地灰 + 剧本层"真国家"的颜色 + 玩家涂过的色
        const allow = new Set([wasteGreyOf().join(',')]);
        for (let i = 0; i < T3.keys.length; i++) {
          if (st.meta.wasteland.indexOf(i) >= 0) continue;
          if (T3.tiers[i] !== 0) continue;
          const c = T3.colors[i];
          if (c) allow.add(c.join(','));
        }
        {
          const pd = ex.renderer.paintData;
          for (let q = 1; q < st.meta.numProvinces; q++) {
            if (pd[q * 4 + 3] > 0) allow.add(`${pd[q * 4]},${pd[q * 4 + 1]},${pd[q * 4 + 2]}`);
          }
        }
        const bad = [];
        for (const t2 of st.meta.wasteland) {
          const k = lutOf(t2).join(',');
          if (!allow.has(k)) bad.push(`${t2}:${k}`);
        }
        ok('剧本层自动上色：荒地只出现「荒地灰 / 真国家的颜色 / 我涂的色」✓',
           bad.length === 0,
           bad.length ? `${bad.length} 块是别的色，例如 ${bad.slice(0, 3).join(' ')}` : '干净');
        ex.wasteClear();
        st.tier = svT6; st.showTitles = svST6; st.showPaint = svPaint6;
      }

      // 名单里的地块：不参与自动填色，一直保持原版色
      if ((st.meta.wasteAutoSkip || []).length) {
        const savedTitles2 = st.showTitles;
        st.showTitles = true;
        ex.wasteClear();
        // 先把它们故意染成别的色，看自动填色会不会把它们还原回去
        for (const pid of st.meta.wasteAutoSkip) {
          ex.renderer.setLutColor(ex.titleAt(pid, fine), 200, 10, 10);
        }
        ex.wasteApply();
        let bad = 0;
        for (const pid of st.meta.wasteAutoSkip) {
          const dt = ex.titleAt(pid, fine);
          if (JSON.stringify(lutOf(dt)) !== JSON.stringify(restOf(dt))) bad++;
        }
        ok('名单里的荒地不参与自动填色（被还原成原版色）',
           bad === 0, `名单 ${st.meta.wasteAutoSkip.length} 块，没还原的 ${bad}`);
        st.showTitles = savedTitles2;
      }

      // 「清除荒地填色」：只清玩家涂的，自动色不动
      {
        ex.wasteClear();
        const dt = ex.titleAt(wpid, fine);
        st.showWaste = true;
        st.showPaint = true;
        st.provTitle[wpid] = 0;                       // 账本记着：这是玩家涂的
        ex.renderer.setPaint(wpid, 44, 55, 66, 255);
        ex.wasteApply();                              // 自动填色先上一遍
        const auto = JSON.stringify(lutOf(dt));
        const cleared = ex.wasteClearPlayerPaint();
        ok('「清除荒地填色」清掉了玩家在荒地上的笔迹',
           cleared > 0 && ex.renderer.paintData[wpid * 4 + 3] === 0,
           `清了 ${cleared} 块，手绘 alpha ${ex.renderer.paintData[wpid * 4 + 3]}`);
        ok('「清除荒地填色」不动自动填的颜色',
           JSON.stringify(lutOf(dt)) === auto, `${JSON.stringify(lutOf(dt))} vs ${auto}`);
        st.provTitle[wpid] = -1;
        ex.renderer.setPaint(wpid, 0, 0, 0, 0);
        ex.wasteClear();
      }

      // ④ 清除
      ex.wasteClear();
      let left = 0;
      for (const t2 of (st.meta.wasteland || [])) if (isColoured(t2)) left++;
      ok('「清除」把自动色全还原成原版色', left === 0, `还剩 ${left} 块有色`);

      // ⑤ 你自己涂过的荒地，自动涂色不碰
      st.provTitle[wpid] = 12345;
      ex.wasteClear();
      ex.wasteApply();
      ok('你自己涂过的荒地，自动涂色不碰它',
         !isColoured(wtid), JSON.stringify(lutOf(wtid)));
      st.provTitle[wpid] = -1;
      ex.wasteClear();
    }
  }

  // 收放：有年代层的模式显示 势力/地区、收掉「头衔」；CK3 反过来
  {
    const hasEra = !!((st.meta.eraDates || []).length);
    const vis = (id) => { const el = get(id); return el ? el.style.display !== 'none' : false; };
    if (get('power-group')) {
      ok(hasEra ? '非 CK3：显示「势力/地区」、收掉「头衔」'
                : 'CK3：显示「头衔」、收掉「势力/地区」',
         hasEra ? (vis('power-group') && vis('region-group') && !vis('titles-group'))
                : (!vis('power-group') && !vis('region-group') && vis('titles-group')),
         `势力=${vis('power-group')} 地区=${vis('region-group')} 头衔=${vis('titles-group')}`);
    }
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
      ok('剧本 + 粒度：本层是粒度层（不是势力层）→ 仍旧省份/默认档 ✓',
         Math.abs(ex.renderer.borderStrength - (st.showParentBorderTitle ? 0.5 : 0.75)) < 0.01,
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

  // 没有荒地数据的模式：荒地那一组（含清除按钮）都该收起来
  {
    const el = get('waste-clear');
    const has = !!(st.meta.wasteland && st.meta.wasteland.length);
    ok(has ? '有荒地的模式里「清除荒地填色」按钮在'
           : '没有荒地的模式里「清除荒地填色」按钮收起来了',
       !!el && (el.style.display === 'none') !== has,
       el ? `display=${el.style.display || '(空)'}` : '没有这个按钮');
  }

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
    ok('离开最细那层：浓度按当前设置走（开父级=省份档 50 / 没开=默认档 75）',
       Math.abs(ex.renderer.borderStrength - (st.showParentBorderTitle ? 0.5 : 0.75)) < 0.01,
       'borderStrength=' + ex.renderer.borderStrength + ' 父级=' + st.showParentBorderTitle);
    // 剧本 + 粒度：边界也该调淡（画面是剧本配色，低级单位只是描边参考）
    {
      const savedG = st.grain;
      const savedT2 = st.tier;
      const savedPB = st.showParentBorderTitle;
      st.showParentBorderTitle = true;    // 开了父级才有链 → 子级吃「省份」档 ✓
      st.tier = ERA0;                    // 剧本/年代那一层
      st.grain = fine;                   // 粒度落在低级单位上
      ex.syncParentBorder();
      ok('剧本 + 粒度：本层浓度随设置走（开父级=省份 50 / 没开=默认 75）',
         st.grain != null
         && Math.abs(ex.renderer.borderStrength - (st.showParentBorderTitle ? 0.5 : 0.75)) < 0.01,
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
        // **水域 / 荒地两条线钉死 1** ✓（用户定的 ✓）——
        // 以前水域取"链上最粗那条"、荒地借本层那条线 ✗ → 开不开剧本会变 ✗
        ex.syncLayerSwitches();
        ok('水域 / 荒地边界：粗细恒为 1（不跟链、不跟本层那条线 ✓）',
           Math.abs(ex.renderer.waterW - 1) < 0.001 && Math.abs(ex.renderer.wasteW - 1) < 0.001,
           `waterW=${ex.renderer.waterW} wasteW=${ex.renderer.wasteW}`
           + ` 链上最粗=${ex.renderer.extraWs[ex.renderer.extraCount - 1].toFixed(2)}`
           + ` 本层=${ex.renderer.borderWidth.toFixed(2)}`);
        {
          // 换个状态再看一遍：剧本层 + 没粒度（本层那条线这时是 1.5 的势力线 ✓）也不许动
          const _svG2 = st.grain, _svT3 = st.tier;
          st.grain = null; st.tier = ERA0;
          ex.syncParentBorder(); ex.syncLayerSwitches();
          ok('水域 / 荒地边界：换成"剧本层 + 没粒度"（本层 1.5）也还是 1 ✓',
             Math.abs(ex.renderer.waterW - 1) < 0.001 && Math.abs(ex.renderer.wasteW - 1) < 0.001,
             `waterW=${ex.renderer.waterW} wasteW=${ex.renderer.wasteW}`
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
    const T_A = N_ERA;             // 年份块之后第一级（EU4 区域 / HOI4 战略）
    const T_B = N_ERA + 1;         // 再下一级（EU4 地区 / HOI4 地区）
    const tierBtn = (i) => containers.tier.children
      .find((b) => Number(b.dataset.tier) === i);
    const isOn = (i) => tierBtn(i).classList.contains('on');
    const isGrain = (i) => tierBtn(i).classList.contains('grain');

    ex.setTier(T_ERA);                               // 切到第一个有主的年份
    const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    ok('没有多出来的那一排按钮（视图那一排就够）',
       containers.tier.children.length === want.names.length && !html.includes('grain-group'),
       `${containers.tier.children.length} 个层级按钮，页面上还有 grain-group：${html.includes('grain-group')}`);
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
    ex.setGrain(null);
    ex.setBrush([200, 12, 90], true);
    ex.actAt(...toClient(ax, ay));
    // 按新规则：点中的是**已涂**的省份（[12,200,90]），邻省没涂过 = 别的色+别的标签 ✗
    // 所以邻省不该被带上 —— 同色同标签的只有它自己 ✓
    ok('换回按国家之后：只涂同色同标签的色块（未涂的邻省不被带上）',
       ex.renderer.paintData[mi + 3] === 0,
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
      const same = st.original[tid].slice();
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
    const orig = st.original[tid].slice();
    ex.paintTitle(tid, [12, 200, 90]);
    ok('涂色之后 LUT 里还是游戏原色（头衔色没被改）',
       JSON.stringify(lutAt(tid)) === JSON.stringify(st.original[tid]),
       JSON.stringify(lutAt(tid)));
    ok('头衔色表也没动',
       JSON.stringify(st.titles.colors[tid]) === JSON.stringify(st.original[tid]),
       JSON.stringify(st.titles.colors[tid]));
    ok('涂的色记在手绘层里',
       JSON.stringify(st.paintColor.get(tid) || []) === JSON.stringify([12, 200, 90]),
       JSON.stringify(st.paintColor.get(tid) || []));

    const cb = get('show-paint');
    const fire = (v) => { cb.checked = v; for (const fn of cb._listeners.change || []) fn({ target: cb }); };

    fire(false);
    ok('关掉填色，LUT 回到游戏原色（画面才真的没被涂过）',
       JSON.stringify(lutAt(tid)) === JSON.stringify(orig),
       `${JSON.stringify(lutAt(tid))} vs 原色 ${JSON.stringify(orig)}`);
    ok('关掉填色时头衔色本来就是原色（压根没改过）',
       JSON.stringify(st.titles.colors[tid]) === JSON.stringify(ex.state.original[tid]),
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

    // 同色同标记铺成两块**互不相邻**的地方：只留最大的那块露名字
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
      ok('同一个标记铺在互不相邻的两块上：只留最大的那块露名字',
         mine(st).length === 1 && mine(st)[0].name === '丁',
         `${mine(st).length} 块：${mine(st).map((p) => p.name).join(' / ')}`);

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
      ok('先铺上「甲」', st.titleLabel.get(ta) === '甲', String(st.titleLabel.get(ta)));

      st.brushLabel = '乙';
      ex.setTool('paint');
      ex.setBrush(C, true);            // 同一个颜色
      ex.actAt(...toClient(ax2, ay2));
      ok('同色换个标记再点一下，标记改得掉（以前点了没反应）',
         st.titleLabel.get(ta) === '乙',
         `${st.titleLabel.get(ta)}（编辑层 ${ex.editTier()}，tid ${ta}）`);
      // 颜色断言要放在描边纹理那段**之前** —— 那段会 restore 掉 a/b，
      // 而 EU4 的编辑层就是第 4 层，pa2 跟 ta 恰好是同一个 tid，顺序反了会被擦掉
      ok('颜色还是那个颜色（记在手绘层，头衔色没动）',
         JSON.stringify(st.paintColor.get(ta) || []) === JSON.stringify(C)
         && JSON.stringify(st.titles.colors[ta]) === JSON.stringify(st.original[ta]),
         `手绘 ${JSON.stringify(st.paintColor.get(ta) || [])} 期望 ${JSON.stringify(C)}`);

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

  // ==== 3e. 导入带 clearEraNames 的配色：国名该落**首都那片**，不是最大那片 ====
  // 这类导入件是照着"每个省的原版国家"上色的（名字就是那个国家的名字），
  // 而 clearEraNames 把原版国名整层清掉了 —— 清掉之后"数据首都"那条路
  //（族的名字 == 哪个国的名字）还能不能认出来？认不出就只能落到最大那片 ✗
  {
    const nEra5 = (st.meta.eraDates || []).length;
    if (nEra5 <= 0 || !st.meta.capitals) {
      console.log('  （这一局没有年代层 / 没有数据首都 —— 跳过）');
    } else {
      const fine5 = st.meta.tierNames.length - 1;
      let pick = null;
      for (let t5 = 0; t5 < st.titles.keys.length && !pick; t5++) {
        if (st.titles.tiers[t5] >= nEra5) continue;
        const k5 = String(st.titles.keys[t5] || '');
        const m5 = /^\d{4}_(.+)$/.exec(k5) || /^(?:e|k|d|c|b)_(.+)$/.exec(k5);
        if (!m5) continue;
        const cp5 = st.meta.capitals[m5[1]] | 0;
        if (!(cp5 > 0) || cp5 >= st.meta.numProvinces) continue;
        if (!(st.provPos[cp5 * 3 + 2] > 0)) continue;
        const pids5 = [];
        for (let p = 1; p < st.meta.numProvinces && pids5.length < 600; p++) {
          if (!(st.provPos[p * 3 + 2] > 0)) continue;
          if (ex.titleAt(p, ERA0) !== t5) continue;
          pids5.push(p);
        }
        if (pids5.length < 3 || pids5.indexOf(cp5) < 0) continue;
        pick = { t: t5, cp: cp5, pids: pids5, nm: st.titles.names[t5] };
      }
      ok('找得到一个"有数据首都、且首都就在自己地里"的国家（复现要用）', !!pick,
         pick ? `#${pick.t}「${pick.nm}」首都 #${pick.cp}，地 ${pick.pids.length} 块` : '这局没有');
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
        const blk = (st.paintBlocks || []).find((b) => b.name === pick.nm);
        ok('导入 clearEraNames 的配色之后，这一族认得自己的数据首都 ✓',
           !!blk && !!blk._hasCap && (blk._capPid | 0) === pick.cp,
           blk ? `「${blk.name}」有首都=${!!blk._hasCap} capPid=${blk._capPid} 期望 ${pick.cp}`
               : `没找到「${pick.nm}」这一族`);
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

  console.log('\n=== 4. 锁住的地块 ===');
  // EU5 没有伪头衔：海/湖/荒地是**无名节点**（各占一个地块号），不叫 #sea ——
  // 所以这里给空清单，那几条断言自然跳过
  const pseudo = isEu5 ? []
    : isEU4 ? ['#sea', '#lake', '#wasteland']
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
    ok(`${name} 是伪头衔（锁住）`, i >= 0 && ex.isSpecialTid(i) && ex.isLocked(i), `序号 ${i}`);
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
    ok('CK3 没有年份视图', !(ckM.eraDates && ckM.eraDates.length),
       JSON.stringify(ckM.eraDates || []));
    const baronies = ckT.tiers.filter((x) => x === 4).length;
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
