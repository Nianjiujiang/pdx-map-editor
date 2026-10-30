/**
 * 手机版单文件自检。
 *
 *   node tools/check_mobile.js
 *   node tools/check_mobile.js path/to/pdx-map-editor-mobile.html
 *
 * 手机版 = 同一套源码 + `mobile/*.txt` 那三块补丁，烤成一个单文件 ✓
 * 所以验它要比验电脑版多两件事：
 *   ① 那个补丁**打进去了没有**（#mob-ui 在 CSS 里、bindMobile 在 JS 里、那段注释在 HTML 里）
 *   ② **打进去之后还跑不跑得起来** —— 补丁是在 app.js 的 `bindEvents()` 前面插一大段 +
 *      在启动流程里插一句 `bindMobile()`，插歪了就是一启动就抛，白屏
 *
 * 做法：把单文件里那个 `<script>` 整段抠出来（**里面已经含着打完补丁的 app.js**），
 * 原样喂给同一套假 DOM 跑一遍 boot() ✓ —— 不是"重打一遍补丁来近似"，是验真产物。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const HTML = process.argv[2] || path.join(H.ROOT, 'pdx-map-editor-mobile.html');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

/** 把单文件的 <script> 里那段拍平源码抠出来（含打完补丁的 app.js） */
function readScript(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const at = html.indexOf('window.__CK3_EMBEDDED__=');
  if (at < 0) return { html, js: '', embedded: null };
  const open = html.lastIndexOf('<script>', at);
  const close = html.indexOf('</script>', at);
  const body = html.slice(open + 8, close);
  const endPayload = body.indexOf('}};', at - open);
  const stmt = body.slice(0, endPayload + 3);
  const js = body.slice(endPayload + 3);
  const embedded = new Function('window', stmt + '\nreturn window.__CK3_EMBEDDED__;')({});
  return { html, js, embedded };
}

(async () => {
  console.log(`\n===== 手机版自检：${path.relative(H.ROOT, HTML)} =====`);
  if (!fs.existsSync(HTML)) { console.log('  ✘ 文件不存在（先跑 python mobile/build.py）'); process.exit(1); }
  console.log(`  文件 ${(fs.statSync(HTML).size / 1048576).toFixed(2)} MB`);

  const { html, js, embedded } = readScript(HTML);
  ok('内嵌数据在', !!embedded, embedded ? Object.keys(embedded.maps || {}).length + ' 套地图' : '没有 ✗');

  // ① 补丁痕迹 —— 三块都要在
  ok('CSS 补丁打进去了（#mob-ui）', html.includes('#mob-ui'));
  /* 滚动条统一暗色 ✓（用户 2026-10-12："手机版剧本太多冒出来的那条滑块是白的" ✗）
     —— 这条盯着"别哪天把这几行删了、白条又回来" ✓ */
  ok('滚动条染成暗色（不是浏览器那根白条 ✓）',
     /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*#2b3542/i.test(html)
     && /scrollbar-color:\s*#2b3542/.test(html),
     /::-webkit-scrollbar-thumb/i.test(html) ? 'webkit 那条在 ✓' : '暗色滚动条那几行没找到 ✗');
  ok('JS 补丁打进去了（function bindMobile）', js.includes('function bindMobile'));
  /* 手机上的文件过滤整个放开 ✓（用户 2026-10-12 报的"pdxmap 选不了"：
     `.pdxmap` 类型是 octet-stream，安卓/iOS 的选择器按 MIME 过滤就把它灰掉 ✗）*/
  ok('手机上把选文件的 MIME 过滤放开了（不然 .pdxmap 灰着点不动 ✗）',
     /pack-file'\)[\s\S]{0,80}?accept = '\*\/\*'/.test(js),
     /accept = '\*\/\*'/.test(js) ? "accept = '*/*' ✓" : '没找到放开过滤那两行 ✗');
  ok('JS 补丁的启动挂点也在（bindMobile() 的调用）',
     /bindEvents\(\);\s*\n\s*bindMobile\(\)/.test(js));
  ok('HTML 那段注释也打了（手机版界面说明）', html.includes('手机版的界面'));
  /* 🔴 **小输入弹窗别铺满全屏** ✗（2026-10-27 用户："保存地图等输入框会占满全屏"）
   *   改名窗早就是居中卡片了 ✓ 保存地图窗漏了 ✓
   *   这里验**烤出来的产物**里三条都在：居中 / 卡片自适应高度 / hidden 压得住 ✓ */
  ok('小输入弹窗是居中卡片（保存地图不再铺满全屏 ✓）',
     /#rename, #save-map(?:, #export-map)?\s*\{[^}]*align-items:\s*center/.test(html)
     && /#save-map \.modal-box[^{}]*\{[^}]*height:\s*auto/.test(html)
     && /#save-map\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/.test(html),
     /#save-map \.modal-box[^{}]*\{[^}]*height:\s*auto/.test(html) ? '小卡片 ✓' : '还是全屏 ✗');
  /* 2026-10-27：导出整图也用小卡片，别在手机上又铺满一屏 ✓ */
  ok('导出整图弹窗在手机上是居中卡片（规格/范围/进度不铺满 ✓）',
     /#export-map\s*\{[^}]*align-items:\s*center/.test(html)
     && /#export-map \.modal-box[^{}]*\{[^}]*max-width:\s*410px/.test(html)
     && /#export-map\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/.test(html),
     /#export-map\s*\{[^}]*align-items:\s*center/.test(html) ? '居中卡片 ✓' : '没找到导出弹窗样式 ✗');
  /* 2026-10-27：范围只留「全图 / 框选」，旧提示和「在图上框选」按钮都撤掉 ✓ */
  ok('导出范围只剩全图 / 框选（旧提示和按钮都撤了 ✓）',
     /id="export-range"[\s\S]*>全图<[\s\S]*>框选</.test(html)
     && !/class="export-note"/.test(html)
     && !/id="export-rect"/.test(html)
     && !/id="export-pick"/.test(html),
     /id="export-rect"/.test(html) ? '旧范围提示还在 ✗' : '干净 ✓');
  /* 2026-10-27：框选三键要大到手指按得住 ✓ */
  ok('框选三键够大且是「取消 / 重选 / 确定」',
     /\.export-pick-bar \.btn\s*\{[^}]*height:\s*46px[^}]*min-width:\s*82px/.test(html)
     && /id="export-pick-cancel"[^>]*>取消[\s\S]*id="export-pick-redo"[^>]*>重选[\s\S]*id="export-pick-ok"[^>]*>确定/.test(html),
     /id="export-pick-ok"[^>]*>确定/.test(html) ? '46px 大字 ✓' : '按钮字还没换 ✗');
  /* 🔴 **剧本 + 下级层级两颗都得亮** ✗（2026-10-27 用户："省份按钮仅仅是颜色变了一点点"）
   *   手机版那套玻璃按钮会把桌面的 `.grain` 底/边盖掉 ✓
   *   → 产物里必须有手机专属的蓝底 + 内圈，而且日间版也得在 ✓ */
  ok('「借用粒度」有手机专属的选中态（蓝底 + 蓝圈 ✓）',
     /#mob-sheet \.segmented button\.grain:not\(\.on\)[^{]*\{[^}]*background:/.test(html)
     && /#mob-sheet \.segmented button\.grain:not\(\.on\)[^{]*\{[^}]*box-shadow:/.test(html)
     && /html\[data-theme="light"\] #mob-sheet \.segmented button\.grain:not\(\.on\)[^{]*\{[^}]*color:\s*#2b5f85/.test(html),
     /button\.grain:not\(\.on\)/.test(html) ? '蓝玻璃选中态 ✓' : '没有 grain 规则 ✗');
  /* 2026-10-27 用户："缩放三个小按钮怎么跑到左边了" */
  ok('缩放条贴右边（`left:auto` 把桌面的 left:12px 放开 ✓）',
     /\.zoom-box\s*\{[^}]*left:\s*auto[^}]*right:\s*10px/.test(html),
     /\.zoom-box\s*\{[^}]*left:\s*auto/.test(html) ? '贴右 ✓' : '还是会跑到左边 ✗');
  /* 2026-10-27 用户："「更高」按钮样式和晨昏按钮不一样" */
  {
    const m = /#mob-sheet \.mob-tallbtn\s*\{([^}]*)\}/.exec(html);
    const tail = m ? m[1] : '';
    ok('「更高」小按钮跟晨昏按钮同一套玻璃胶囊',
       /min-height:\s*34px/.test(tail) && /padding:\s*0 16px/.test(tail)
       && /border-radius:\s*17px/.test(tail) && /rgba\(255,\s*255,\s*255,\s*\.07\)/.test(tail)
       && /backdrop-filter\s*:\s*blur/.test(tail),
       m ? '34px 胶囊 + 玻璃 ✓' : '没找到 .mob-tallbtn ✗');
  }
  /* 2026-10-27 用户："恢复默认那块莫名其妙是更灰色的底" */
  ok('设置底栏在手机面板里是透明底（不再沿用电脑版的灰板 ✓）',
     /\.mob-set-foot\s*\{[^}]*background:\s*transparent\s*!important/.test(html),
     /\.mob-set-foot\s*\{[^}]*background:\s*transparent/.test(html) ? '透明 ✓' : '还是灰底 ✗');

  /* 🔴 **手机版教程内容要跟上界面** ✗✗（2026-10-20 ✓ 用户："手机版和电脑版教程重新做一下"）
   *
   *   老文案写的是「底下四个按钮」✗ —— 实际是**五个**（颜色/工具/视图/设置/文件），
   *   而且把「文件」整个漏了 → 用户照着找导出，找不着 ✓
   *   还说「视图：换年份剧本，或者切到地区、省份」✗ ——
   *   v1.10 之后视图页分两级：上面剧本折叠栏、下面才是地理层级 ✓
   */
  {
    const need = [
      ['底下五个按钮', /底下五个按钮/],
      ['剧本折叠栏（两级说明）', /剧本[\s\S]{0,40}折叠|折叠栏/],
      ['地理层级那几个词', /大洲[\s\S]{0,80}省份/],
      ['长按取色', /长按/],
      ['双指缩放', /双指|两根手指/],
    ];
    const miss = need.filter(([, re]) => !re.test(js)).map(([n]) => n);
    ok('手机版教程覆盖了现在的界面（五个按钮 / 剧本折叠 / 地理层级 / 长按 / 双指）',
       miss.length === 0, miss.length ? `缺：${miss.join('、')}` : '都讲了 ✓');
    /* ⚠ 剥掉注释再判 ✗ —— 注释里会提到旧的「四个」说法（记历史 ✓）
     *   不剥的话永远红 ✓（跟桌面教程那条一个坑 ✓）*/
    const jsCode = js
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    ok('手机版教程不再说「底下四个按钮」（现在是五个 ✗）',
       jsCode.indexOf('底下四个按钮') < 0);
    /* 🔴 **统一叫「势力名」** ✗✗（2026-10-20 ✓ 用户："国名就是势力名"）
     *   ⚠ 剥注释再判 ✓ 注释里讲历史会提到「国名」✓ */
    ok('手机版教程统一用「势力名」（不写「国名」✗）',
       jsCode.indexOf('国名') < 0,
       jsCode.indexOf('国名') < 0 ? '干净 ✓' : '仍有「国名」字样 ✗');
    /* 🔴 **介绍窗里也不许用破折号** ✗✗（2026-10-20 ✓ 用户："不要破折号"）
     *   那几句是一段一段读的 ✓ 破折号把句子拦腰截断，手机上更难读 ✓ */
    {
      /* ⚠ 别用 `/const introHTML =([\s\S]*?);/` 那种 ✗
       *   正文里有分号和引号拼接，非贪婪会在第一个分号就停 ✓（我第一版就只截到半句 ✓）
       *   → 直接按**两个锚点**切：`const introHTML` 到 `const showIntro` ✓ */
      const a = jsCode.indexOf('const introHTML');
      const b = jsCode.indexOf('const showIntro');
      const block = (a >= 0 && b > a) ? jsCode.slice(a, b) : '';
      ok('手机版教程里没有破折号 ✓',
         block.length > 100 && block.indexOf('——') < 0,
         block ? (block.indexOf('——') < 0 ? `${block.length} 字符 · 干净 ✓` : '仍有破折号 ✗')
               : '没找到 introHTML ✗');
      /* 2026-10-27 用户："涂错了就点「文件 → 撤销」改成点「撤销」" */
      ok('教程撤销文案不再写「文件 → 撤销」',
         block.indexOf('文件 → 撤销') < 0 && block.indexOf('点「撤销」') >= 0,
         block.indexOf('文件 → 撤销') < 0 ? '改成「点撤销」✓' : '还是旧的「文件 → 撤销」✗');
    }
  }

  // ② 补丁**没有**漏进源码本该干净的地方：单文件里 app.js 只该有一份
  const nBind = (js.match(/function bindMobile\s*\(/g) || []).length;
  ok('bindMobile 只有一份（没重复打补丁）', nBind === 1, String(nBind));

  // **面板宽度分档** ✓（用户定的）：工具 / 视图 / 文件里面就几个字 → 窄；
  // 设置 / 颜色是一排排的开关和输入框 → 摊到接近整屏 ✓
  ok('「文件」面板跟工具 / 视图同宽（不再单独一档 220 ✓）',
     /WANT = \{ tool: 148, view: 148, io: 148 \}/.test(js),
     /io: 148/.test(js) ? 'io=148 ✓' : '文件那档还是旧的 ✗');
  ok('「设置」「颜色」面板摊到接近整屏（a.width - 16 ✓）',
     /const FULL = \{ display: 1, color: 1 \}/.test(js) && /FULL\[key\] \? \(a\.width - 16\)/.test(js));

  // ③ 真跑一遍
  console.log('\n---- 真跑一遍（补丁后的 app.js）----');
  const env = H.makeEnv({ embedded, root: H.ROOT });
  const ex = H.instantiate(js, env);
  const b = ex.boot();
  for (let i = 0; i < 4000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  let cards = env.get('map-pick-list').children;
  /* 轻量版（2026-10-12 起单文件默认不内嵌地图）这里会是 0 张 ——
     那就**先导一个包**，走玩家第一次用的那条路 ✓ */
  const keys = Object.keys(embedded.maps || {});
  if (!cards.length && keys.length === 0) {
    let packPath = null;
    for (const d of [path.join(H.ROOT, 'packs'), path.join(H.ROOT, '_local', 'packs')]) {
      for (const n of ['pdx-eu4-vanilla.pdxmap', 'eu4-vanilla.pdxmap', 'eu4-vanilla-test.pdxmap']) {
        const p = path.join(d, n);
        if (fs.existsSync(p)) { packPath = p; break; }
      }
      if (packPath) break;
    }
    if (packPath) {
      const fi = env.get('pack-file');
      fi.files = [new Blob([fs.readFileSync(packPath)])];
      await fi.onchange();
      for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) {
        await new Promise((r) => setImmediate(r));
      }
      cards = env.get('map-pick-list').children;
      ok('轻量版：导进一个地图包之后选单里有卡片了', cards.length === 1, cards.length + ' 张');
    } else {
      console.log('  （没有 _local/packs/ 里的测试包，轻量版这条跳过）');
    }
  }
  ok('启动选单出来了（有内嵌地图，或者导进来一个包）', cards.length > 0, cards.length + ' 张');
  /* 导入式地图这套手机版也带（同一套源码 ✓）——
     补丁只碰界面结构，但选图界面那个导入入口是**新加的节点**，
     手机版补丁要是把它搬没了、或者拍平漏了 packstore.js，这条会响 ✓ */
  ok('手机版选图界面也有「导入地图包」', !!env.get('map-import'));
  ok('校验器 / 仓库都拼进手机版了（拍平清单没有漏）',
     /function validatePack/.test(js) && /function importPack/.test(js));
  if (cards.length) cards[0].onclick();
  await b;
  const step = (env.get('boot-step') || {}).textContent || '';
  ok('boot 跑到就绪（补丁没把启动弄崩）', /就绪/.test(step), step || '（没走到）');
  ok('渲染器建起来了', !!ex.renderer);
  ok('标签层建起来了', !!ex.labels);
  ok('手机版国名层也没有缩放门槛（0 = 一直画 ✓）',
     !!(ex.labels && ex.state.meta && ex.state.meta.labelZoom)
     && ex.labels.zoom[0] === 0 && ex.state.meta.labelZoom[0] === 0,
     ex.labels ? `zoom[0]=${ex.labels.zoom[0]}` : '没有标签层 ✗');
  ok('meta / 头衔表都装上了', !!(ex.state.meta && ex.state.titles),
     ex.state.meta ? `${ex.state.meta.numProvinces} 地块 / ${ex.GAME.name}` : '');
  /* 2026-10-27 用户："开局颜色的标记应该不能留空，改成真正的「请输入文本」五个字" */
  {
    const bl = env.get('brush-label');
    ok('开局「标记」不是空的（写着「请输入文本」五个字 ✓）',
       ex.state.brushLabel === '请输入文本' && (!bl || bl.value === '请输入文本'),
       `state="${ex.state.brushLabel}" · input="${bl ? bl.value : '(没有)'}"`);
  }

  // 报错日志：手机版跟电脑版共用同一套源码 ✓ —— 补丁只碰界面，
  // 日志该在也得在（漏拼了 log.js 的话手机版玩家出事就没现场可发 ✗）
  const log = env.sandbox && env.sandbox.window && env.sandbox.window.PDXLOG;
  ok('报错日志模块也在（手机版同一套源码 ✓）', !!(log && typeof log.text === 'function'),
     log && typeof log.text === 'function' ? 'PDXLOG 有了' : '没有 ✗');

  // ④ 手机版特有：bindMobile 跑过之后应该造出 #mob-ui 那些节点
  const mobUi = env.get('mob-ui');
  const madeIt = !!mobUi && (mobUi.children.length > 0 || String(mobUi.className || '').includes('mob'));
  ok('bindMobile() 造出了手机版界面节点', madeIt,
     mobUi ? `#mob-ui 子节点 ${mobUi.children.length} 个` : '没造出来 ✗');

  // ⑤ 手机切后台再回来 —— 黑屏那条路。
  //    手机把 WebGL 上下文整个收走（省显存 ✓）回来时必须把数据重喂一遍 ✓
  //    笔迹在 CPU 那份里，重喂**不许擦掉** ✓（这正是"切个后台回来，涂的全没了" ✓）
  console.log('\n---- 切后台再回来（丢上下文）----');
  {
    const cv2 = env.get('map');
    const r2 = ex.renderer;
    /* ⚠ 地块号**从数据里现取** ✗ —— 测试包换一张（省份数不同）就换个号：
       写死 11 的话，只有 9 个省份的小包一测就是越界 → rgba 全 undefined 误报 ✗ */
    const paintPid = Math.max(1, Math.min(11, (ex.state.meta.numProvinces || 2) - 2));
    r2.setPaint(paintPid, 200, 30, 40, 255);
    cv2.dispatchEvent({ type: 'webglcontextlost', preventDefault() {} });
    const stopped = r2.ctxLost === true && r2.dirty === false;
    ok('丢上下文时停画（不然那几帧全是白费 + 搅浑 GL 错误）', stopped);
    cv2.dispatchEvent({ type: 'webglcontextrestored' });
    for (let i = 0; i < 400 && !r2.provTex; i++) await new Promise((res) => setImmediate(res));
    ok('回来：地图数据重新喂进去了', !!(r2.provTex && r2.titleTex && r2.paintTex),
       `prov=${!!r2.provTex} paint=${!!r2.paintTex}`);
    ok('**笔迹没丢**（颜色 + alpha 都在）',
       r2.paintData[paintPid * 4] === 200 && r2.paintData[paintPid * 4 + 3] === 255,
       `rgba=${r2.paintData[paintPid * 4]},${r2.paintData[paintPid * 4 + 1]},`
       + `${r2.paintData[paintPid * 4 + 2]},${r2.paintData[paintPid * 4 + 3]}`);
    r2.dirty = false;
    env.documentStub.hidden = false;
    env.dispatchDocument('visibilitychange');
    ok('回到前台：强制重画一帧', r2.dirty === true);
  }

  /* ==================================================================
   * ④ **界面结构：桌面有的，手机版搬到了没有**（2026-10-21 加）
   *
   *   这一节是这次重构的验收标准 ✓
   *   起因：桌面 2026-10-20 把设置改成 `data-group` 分页、把 `<h3>` 全删了 ✗
   *     而手机版还按 h3 的中文标题正则认页 ✓ → 一条都匹配不上 →
   *     **设置页除了「显示」之外全是空的** ✓（用户："设置什么的其实根本没跟上"）
   *   这种"静默失配"不会抛错、不会崩，只有打开那个面板才看得见 ✓
   *   → 所以必须从**真跑完的 DOM** 上验，不能只看源码 ✓
   *
   *   静态那一半在 tools/check_mobile_parity.js（秒出 ✓ 盯"代码里点了名没有"）
   *   这里验的是**搬完之后 DOM 里到底有什么** ✓
   * ================================================================== */
  console.log('\n---- 界面结构：设置页 / 顶栏 ----');
  {
    /* ⚠ **从 `#mob-ui` 往下查** ✗ 别用 `env.documentStub.querySelector` ✓
     *   documentStub 那个 querySelector 是个**特判桩**（只认 tier / tool / data-role ✓
     *   见 browser_stub.js）✓ 它不会去翻整棵树 ✓
     *   而面板挂在 `#app → #mob-ui → #mob-sheet → #mob-sheet-body → .mob-group` ✓
     *   → 必须从**真·挂载点** `#mob-ui` 上查 ✓（Element 的 querySelector 是真遍历 ✓）*/
    const ui = env.get('mob-ui');
    const disp = ui ? ui.querySelector('.mob-group[data-group="display"]') : null;
    ok('「设置」面板建出来了', !!disp, disp ? '有 ✓' : '没有 ✗');

    if (disp) {
      const panes = disp.querySelectorAll('.mob-pane');
      ok('设置面板里有五个页', panes.length === 5,
         `${panes.length} 个：${panes.map((p) => p.getAttribute('data-pane')).join(' / ')}`);

      /* 🔴 核心那条：桌面的每个 data-group 都得有个**非空**的页 ✓
       *   ⚠ 判据是"页里有东西"（子节点 > 0）✗ 不是"页存在" ✓
       *     空页 = 搬失败了 ✓ 正是用户报的那个毛病 ✓ */
      const deskGroups = [...fs.readFileSync(path.join(H.ROOT, 'web', 'index.html'), 'utf8')
        .matchAll(/<section class="set-col" data-group="([^"]+)"/g)].map((m) => m[1]);
      for (const g of deskGroups) {
        const pane = disp.querySelector(`.mob-pane[data-pane="${g}"]`);
        const n = pane ? (pane.children || []).length : -1;
        ok(`桌面分组「${g}」搬进手机版了、而且不是空的`,
           !!pane && n > 0, pane ? `${n} 个子节点` : '没有这一页 ✗');
      }

      /* 那四页里最关键的一个控件：确认**真的搬到了**（不是只有个空 shell）
       *   取一个每页各一个、id 好认的 ✓ */
      const MUST = [
        ['set-bg', 'color', '底图背景色'],
        ['set-pa', 'border', '省份边界浓度'],
        ['set-font-place', 'label', '地块名字体'],
        ['set-legend-title', 'legend', '图例标题'],
      ];
      for (const [id, pane, label] of MUST) {
        const el = env.get(id);
        let owner = null;
        for (let n = el; n; n = n.parentNode) {
          if (n.getAttribute && n.getAttribute('data-pane')) { owner = n.getAttribute('data-pane'); break; }
        }
        ok(`「${label}」落在「${pane}」页里`, !!el && owner === pane,
           el ? `在 ${owner || '(不在任何页)'} 页` : '元素都没了 ✗');
      }

      /* **搬进来的分栏不许还是 hidden** ✗✗
       *   桌面分页会把非当前页的 `.set-col` 设成 hidden ✓ 搬过来必须清掉 ✓
       *   不清的话：节点在了、但**看不见** ✓ 跟没搬一样 ✓ */
      const hiddenCols = [];
      for (const col of disp.querySelectorAll('.set-col')) {
        if (col.hidden) hiddenCols.push(col.getAttribute('data-group'));
      }
      ok('搬进来的设置分栏都不是隐藏的（hidden 已清 ✓）',
         hiddenCols.length === 0, hiddenCols.length ? `还藏着：${hiddenCols.join(',')}` : '都显出来了 ✓');

      /* 底栏（已改动 / 恢复默认）也得搬 ✓ */
      const foot = disp.querySelector('.mob-set-foot');
      ok('设置底栏（已改动 · 恢复默认）搬进来了', !!foot,
         foot ? '有 ✓' : '没搬 ✗ 手机上够不着「恢复默认」');
      if (foot) {
        ok('底栏里那个「全部恢复默认」还在', env.get('set-reset') && !!foot.querySelector
           ? !!env.get('set-reset') : false);
      }
    }

    /* 🔴 **主题开关：在「设置面板」的顶部** ✗✗
     *   （2026-10-21 ✓ 用户两次纠正：
     *     "晨昏按钮放在设置的【其他】页面" → 然后又改成
     *     "晨昏按钮还是放设置顶部吧（**不是屏幕顶部**）"）
     *
     *   最终位置：`#mob-sheet-body` 里那个 `.mob-theme-bar` ✓
     *     · 在 `.mob-tabs` **前面**（标签上面 ✓ 一开面板就看得到）
     *     · 在 `.mob-panes` **外面**（跟着换页滚走的就不对了 ✗）
     *     · **不是顶栏** ✗（那是"屏幕顶部"✓ 用户明确否掉了）
     *
     *   ⚠ 判据要**两件事同时成立**：
     *     ① 它在一个 `.mob-theme-bar` 里，而那根 bar 的父级是 `#mob-sheet-body`
     *     ② 它**不在**任何 `.mob-pane` / `.mob-panes` 里（否则换页就没了）
     */
    const top = env.get('mob-topbar');
    const th = env.get('btn-theme');
    ok('白天/黑夜开关还在（没在搬家的路上丢掉 ✓）', !!th, th ? '有 ✓' : '按钮没了 ✗');
    if (th) {
      let bar = null;
      for (let n = th.parentNode; n; n = n.parentNode) {
        if (n.classList && n.classList.contains('mob-theme-bar')) { bar = n; break; }
      }
      ok('主题开关在设置面板顶部的 `.mob-theme-bar` 里',
         !!bar, bar ? '有那一行 ✓' : '没在 bar 里 ✗');

      /* 那根 bar 得挂在 `#mob-sheet-body` 下（面板自己的顶部 ✓ 不滚 ✓）*/
      let barInBody = false;
      for (let n = bar; n; n = n.parentNode) {
        if (n.id === 'mob-sheet-body') { barInBody = true; break; }
      }
      ok('那一行挂在面板 body 里（不是某一页里 ✓ 换页不会消失）', barInBody,
         barInBody ? '在 body 里 ✓' : '挂错地方了 ✗');

      /* 不在任何 .mob-pane / .mob-panes 里 ✓ */
      let inPane = false;
      for (let n = th; n; n = n.parentNode) {
        if (n.classList && (n.classList.contains('mob-pane') || n.classList.contains('mob-panes'))) {
          inPane = true; break;
        }
      }
      ok('主题按钮不在任何一页里（跟着换页滚走就不对了 ✗）', !inPane,
         inPane ? '在某一页里 ✗' : '在页外面 ✓');

      ok('主题按钮不在顶栏里（用户明确说"不是屏幕顶部" ✗）',
         !th.parentNode || th.parentNode !== top,
         th.parentNode === top ? '还在顶栏 ✗' : '不在顶栏 ✓');

      /* ⚠ 位置顺序：bar 必须在 `.mob-tabs` 之前 ✓
       *   ⚠ 别用补丁里的 `gDisp` ✗ 那是 `bindMobile` 的局部变量 ✓
       *     测试里根本没有它 ✓（我第一版就写了它 → ReferenceError ✓）
       *   → 从 `bar.parentNode` 拿父级 ✓ 那才是面板本身 ✓ */
      const host = bar ? bar.parentNode : null;
      const tabsEl = host && host.querySelector ? host.querySelector('.mob-tabs') : null;
      if (bar && tabsEl && host.children) {
        const kids = host.children;
        const iBar = Array.prototype.indexOf.call(kids, bar);
        const iTabs = Array.prototype.indexOf.call(kids, tabsEl);
        ok('那一行在标签行上面（一开面板就看得到 ✓）',
           iBar >= 0 && iTabs >= 0 && iBar < iTabs, `bar@${iBar} / tabs@${iTabs}`);
      } else {
        ok('那一行在标签行上面（一开面板就看得到 ✓）', false, '找不到 bar 或 tabs ✗');
      }

      /* onclick 得还在 —— 搬元素不会丢监听 ✓ 但万一哪天改成 cloneNode 就会丢 ✓ */
      ok('主题按钮的点击处理还在（搬来搬去没丢 onclick ✓）',
         typeof th.onclick === 'function', typeof th.onclick === 'function' ? '在 ✓' : '丢了 ✗');
      /* 点一下真能翻主题 ✓ */
      const rootEl = env.sandbox.document.documentElement;
      const before = rootEl ? rootEl.getAttribute('data-theme') : null;
      if (typeof th.onclick === 'function' && rootEl) {
        th.onclick();
        const after = rootEl.getAttribute('data-theme');
        const flipped = (before === 'light') !== (after === 'light');
        ok('点它真的能切白天/黑夜（手机上不再是永远夜间 ✓）', flipped,
           `${before || '夜间'} → ${after || '夜间'}`);
        th.onclick();     // 复原，别影响后面的断言 ✓
      }
      /* 全页只能有一颗 ✗ 两颗的话另一颗点了没反应 ✓ */
      let nTh = 0;
      const walk = (n) => {
        if (!n) return;
        if (n.id === 'btn-theme') nTh++;
        for (const c of (n.children || [])) walk(c);
      };
      walk(ui);
      ok('手机上只有一个主题按钮（两颗的话有一颗点了没反应 ✗）', nTh === 1, `${nTh} 个`);
    }

    /* 底栏四个入口一个不少 ✓ */
    const dock = env.get('mob-dock');
    ok('底部四个入口都在（设置 / 颜色 / 工具 / 视图）',
       !!dock && dock.children.length === 4, dock ? `${dock.children.length} 个` : '没有 ✗');
  }

  /* ================================================================== */
  /* 🎨 颜色页：取消二级菜单，调色板 / 最近使用搬到底部 ✓（2026-10-27 用户） */
  {
    const ui2 = env.get('mob-ui');
    const colorGrp = ui2 && ui2.querySelector('.mob-group[data-group="color"]');
    const kit = colorGrp && colorGrp.querySelector('.mob-color-kit');
    const inKit = (id) => {
      let n = env.get(id);
      while (n) { if (n === kit) return true; n = n.parentNode; }
      return false;
    };
    ok('颜色页底部搬出了「调色板 / 最近使用」',
       !!kit && inKit('palette-fav') && inKit('palette'),
       kit ? '有 .mob-color-kit ✓' : '没有（还藏在二级菜单里 ✗）');
    ok('色块的二级菜单在手机上收起了', !!(env.get('brush-menu') && env.get('brush-menu').hidden));
    /* 点大色块 = 改颜色（系统取色器），不是再弹二级菜单 ✓ */
    {
      const sw = env.get('brush-swatch');
      const bc = env.get('brush-color');
      let fired = false;
      if (bc && typeof bc.addEventListener === 'function') bc.addEventListener('click', () => { fired = true; });
      if (sw && typeof sw.onclick === 'function') sw.onclick();
      ok('点大色块 = 打开系统取色器（改颜色 ✓）', fired,
         fired ? '取色器被点开了 ✓' : '还是没走改颜色 ✗');
    }
    ok('长按删色的手势接上了（手机没有右键 ✓）',
       /bindLongDelete/.test(js) && /paletteRemoveAt/.test(js),
       /bindLongDelete/.test(js) ? '有长按逻辑 ✓' : '没有长按 ✗');
  }

  /* 🛠 「全部恢复默认」：2026-10-27 用户："手机和电脑的恢复默认都没用" */
  {
    const sr = env.get('set-reset');
    /* ⚠ 用 range 控件验"界面也回填了" ✗ —— `set-labelap` 是步进/分段控件，
     *   测试桩的设置骨架里没造它（`_steps` 空），验不到界面那半 ✓
     *   `set-pa` 是 range，桩里有真 value ✓ 正好能验 `_fill()` 有没有跑 ✓ */
    const pa = env.get('set-pa');
    if (sr && typeof sr.onclick === 'function') {
      ex.state.set.pa = 12;
      if (pa) pa.value = '12';
      let err = null;
      try { sr.onclick(); } catch (e) { err = e; }
      ok('「全部恢复默认」不再抛错（旧 `_open()` 已换成 `_fill()` ✓）',
         !err, err ? String(err.message || err) : '跑通 ✓');
      ok('恢复默认后 state 和控件都回出厂值',
         ex.state.set.pa === 50 && (!pa || Number(pa.value) === 50),
         `state=${ex.state.set.pa} · ui=${pa ? pa.value : '(没有控件)'}`);
    } else {
      ok('「全部恢复默认」按钮接了点击处理', false, '找不到 onclick ✗');
    }
  }

  /* 剧本 + 下级层级：**两颗都得挂上对应的 class** ✓（2026-10-27 用户：
   *   "同时选中剧本和某个下级层级（比如省份）时，省份按钮仅仅是颜色变了一点点"）
   *
   * ⚠ 这里只验**行为**：选剧本 → 再点省份，省份按钮要挂 `.grain` ✓
   *   视觉（手机专属蓝底 + 蓝圈）在 `check_mobile_parity.js` 和上面的产物断言里验 ✓
   *   两条合起来才完整：class 对但样式被盖掉 = 用户看到的"没选中" ✗ */
  {
    const nEra = ex.eraTierCount();
    const nTier = (ex.state.meta.tiers || []).length;
    const tierBox = env.documentStub.querySelector('[data-role="tier"]');
    const tierBtns = (tierBox && tierBox.children || [])
      .filter((b) => String(b.tagName || '').toLowerCase() === 'button');
    /* ⚠ 剧本 <4 个时走的是**回退模式**（剧本层就是 tier 那一排的按钮）✗
     *   这时根本没有下拉按钮 —— 老断言只认 `[data-role="era-btn"]`，
     *   在真 CK3（1066 + 空白 = 2 个剧本块）上必红 ✓（2026-10-30）
     *   → 按 app 自己的判据（eraBlockCount ≥ 4）挑按钮 ✓ */
    const blankIdx = (ex.state.meta.tiers || []).indexOf('blank');
    const eraBlocks = (nEra > 0 && blankIdx === nEra) ? nEra + 1 : nEra;
    const eraBtn = eraBlocks >= 4
      ? env.documentStub.querySelector('[data-role="era-btn"]')
      : tierBtns.find((b) => Number(b.dataset && b.dataset.tier) === 0);
    if (nEra > 0 && nTier > nEra && tierBtns.length) {
      const prevTier = ex.state.tier, prevGrain = ex.state.grain;
      /* 先回到"第一级地理层、没有粒度"的状态，再按剧本 → 省份 ✓
       * ⚠ 别直接从省份起步 ✗ —— 从省份按剧本会把省份顺手设成 grain ✓
       *   再按省份就变成"拆开"了（pressTier 的开关语义 ✓） */
      ex.setGrain(null);
      ex.setTier(nEra);
      ex.pressTier(0);                 // 选一个剧本
      ex.pressTier(nTier - 1);         // 再点最细那一级（省份）
      const prov = tierBtns.find((b) => Number(b.dataset && b.dataset.tier) === nTier - 1);
      ok('剧本 + 省份：省份按钮挂上 grain（不是只换字色 ✓）',
         !!prov && prov.classList.contains('grain') && !prov.classList.contains('on'),
         prov ? `class="${prov.className}"` : '找不到省份按钮 ✗');
      ok('剧本 + 省份：剧本按钮还是金色 on ✓',
         !!eraBtn && eraBtn.classList.contains('on'),
         eraBtn ? `class="${eraBtn.className}"` : '找不到剧本按钮 ✗');
      ex.setGrain(prevGrain);          // 复原，别影响别处 ✓
      ex.setTier(prevTier);
    } else {
      console.log('  （这张图没有剧本层，跳过「剧本 + 省份」行为检查）');
    }
  }

  /* 🔴 **手机宽度下整图导出也要带国名** ✗✗（2026-10-27 用户：
   *   "手机版导出地图好像没有附赠名字"）
   *
   *   根因：`paintLabelsForExport()` 原来按 `labels.cssW`（**当前屏幕宽**）算门槛 ✓
   *   手机 ~390px → gate 6.9% → 国名层门槛（按 1600px 视口算）~20% → 一个都不画 ✓
   *   电脑 ~1600px → gate 28% → 正常 ✓（所以只有手机版报）
   *
   *   这条把屏幕宽**故意设成 390**，再走真实导出路径量名字数 ✓
   *   ⚠ 测试末尾恢复层级 / 开关，别影响别的断言 ✓ */
  {
    const prevTier = ex.state.tier;
    const prevPaint = ex.state.showLabelsPaint;
    const prevTitle = ex.state.showLabelsTitle;
    const prevCssW = ex.labels ? ex.labels.cssW : null;
    const cv = env.sandbox.document.createElement('canvas');
    const ctx = cv.getContext('2d');
    let n = 0, err = null;
    try {
      ex.state.showLabelsPaint = true;
      ex.state.showLabelsTitle = true;
      ex.setTier(0);                       // 剧本层：国名最全 ✓
      ex.rebuildPaintBlocks(true);
      if (ex.labels) ex.labels.cssW = 390; // 模拟手机屏宽 ✓
      n = ex.paintLabelsForExport(ctx, 1) | 0;
    } catch (e) { err = e; }
    if (ex.labels && prevCssW != null) ex.labels.cssW = prevCssW;
    ex.state.showLabelsPaint = prevPaint;
    ex.state.showLabelsTitle = prevTitle;
    ex.setTier(prevTier);
    ex.rebuildPaintBlocks(!!ex.state._blocksAll);
    ok('手机宽度下整图导出也带国名（不再按屏幕宽砍掉 ✓）',
       !err && n > 0, err ? String(err.message || err) : `${n} 个名字`);
  }

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✘ ' + f);
    process.exit(1);
  }
  // 手机端补丁里有 setInterval（胶囊状态那 0.4 秒一刷）→ 不显式退，Node 不会自己结束
  process.exit(0);
})().catch((e) => { console.error('自检自己崩了：', e); process.exit(1); });
