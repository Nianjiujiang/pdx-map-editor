/**
 * 电脑版两件事：
 *   ① 「教程」按钮 → 弹**介绍窗**（不是老的逐步引导）
 *   ② 「主菜单」按钮删掉，只留 Esc
 *
 *   node tools/check_desktop_intro.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require(path.join(__dirname, 'lib', 'browser_stub.js'));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, i) => {
  if (c) { pass++; console.log(`  ✔ ${n}${i ? '  → ' + i : ''}`); }
  else { fail++; console.log(`  ✘ ${n}${i ? '  → ' + i : ''}`); }
};

(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'pdx-map-editor.html'), 'utf8');
  const at = html.indexOf('window.__CK3_EMBEDDED__=');
  const open = html.lastIndexOf('<script>', at);
  const close = html.indexOf('</script>', at);
  const body = html.slice(open + 8, close);
  const end = body.indexOf('}};', at - open);
  const js = body.slice(end + 3);
  const embedded = new Function('window', body.slice(0, end + 3) + '\nreturn window.__CK3_EMBEDDED__;')({});

  const env = H.makeEnv({ embedded, root: ROOT });
  const ex = H.instantiate(js, env);
  const b = ex.boot();
  for (let i = 0; i < 4000 && !env.get('map-pick-list').children.length; i++) await new Promise((r) => setImmediate(r));
  let cards = env.get('map-pick-list').children;
  if (!cards.length) {
    let p = null;
    for (const d of [path.join(ROOT, 'packs'), path.join(ROOT, '_local', 'packs')]) {
      if (!fs.existsSync(d)) continue;
      for (const n of fs.readdirSync(d)) if (n.endsWith('.pdxmap')) { p = path.join(d, n); break; }
      if (p) break;
    }
    if (p) {
      const fi = env.get('pack-file');
      fi.files = [new Blob([fs.readFileSync(p)])];
      await fi.onchange();
      for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) await new Promise((r) => setImmediate(r));
      cards = env.get('map-pick-list').children;
    }
  }
  if (cards.length) cards[0].onclick();
  await b;
  await new Promise((r) => setTimeout(r, 300));

  console.log('\n===== ① 教程按钮 = 介绍窗 =====');
  const tut = env.get('btn-tutorial');
  ok('「教程」按钮还在', !!tut);
  if (tut) {
    /* ⚠ **不能用 `getElementById` 探"点之前有没有"** ✗
     *   模拟 DOM 的 getElementById 是**找不到就懒建** ✓ 一探就"有了" ✓
     *   → 改成数 `#app` 的子节点 ✓ 那个不会凭空长东西 ✓ */
    const appEl = env.get('app');
    const kidsBefore = appEl ? appEl.children.length : 0;
    tut.dispatchEvent({ type: 'click', target: tut, preventDefault() {} });
    const kidsAfter = appEl ? appEl.children.length : 0;
    ok('点一下 → `#app` 底下多了一个节点（介绍窗建出来了 ✓）',
       kidsAfter > kidsBefore, `${kidsBefore} → ${kidsAfter}`);

    const box = env.get('app-intro');
    ok('介绍窗是显示状态', !!box && box.hidden === false, box ? `hidden=${box.hidden}` : '没有 ✗');
    if (box) {
      const bodyEl = box.querySelector('.mi-body');
      ok('里面有 `.mi-body` 正文区', !!bodyEl);
      /* ⚠ 桩的 `innerHTML` 只**建子节点**、不留纯文本 ✗
       *   → `.mi-body.innerHTML` 是空串 ✓ 但它的 `children` 是有的 ✓
       *   判"有没有内容"要看**子节点数** ✓ 别拿字符串长度判 ✓ */
      const kids = (bodyEl && bodyEl.children) || [];
      ok('正文区里有内容（子节点不为空 ✓）', kids.length >= 5, `${kids.length} 个子节点`);
      /* 标签级校验看**整段源码**：外层节点的 `_html` 才是那串原文 ✓ */
      const raw = box._html || '';
      ok('源码里有 `.mi-lead` 导语', /mi-lead/.test(raw));
      ok('源码里有小标题 `<h4>`', /<h4>/.test(raw));
      ok('正文有实际文字（不是空壳 ✓）', raw.length > 800, `${raw.length} 字符`);
      /* ⚠ 老教程是"逐步引导"，它的记号是 tut-ring / tut-card / 第 N 步 ✗ */
      ok('**没有**老教程那套逐步引导（没有 tut-ring / 第 1 步 ✗）',
         !/tut-ring|tut-card|第\s*1\s*步/.test(raw));

      /* 关掉：直接调那个按钮的 click 监听 */
      const cb = box.querySelector('#app-intro-close');
      ok('有「知道啦」按钮', !!cb);
      if (cb) {
        cb.dispatchEvent({ type: 'click', target: cb, preventDefault() {} });
        ok('点「知道啦」能关掉', box.hidden === true, `hidden=${box.hidden}`);
      }
    }
    /* ⚠ 老教程模块必须**还在**（用户："原来的教程注释但是别删就行"）*/
    ok('老教程模块 `tutorial.js` 还在（initTutorial 仍可调用 ✓）',
       typeof env.sandbox.window.initTutorial === 'function');
  }

  console.log('\n===== ② 主菜单按钮 =====');
  /* ⚠ 同样不能拿 `env.get('btn-home')` 判 ✗ 懒建会让它永远"存在" ✓
   *   → 直接查**发布产物** ✓ 但**必须先去掉注释** ✗✗
   *     我在 `index.html` 里留了一句注释写着 `<button id="btn-home">` ✓
   *     直接搜字符串会把注释也算进去 ✓ 误报"还在" ✓（第一次就踩了）
   *   → 剥掉 `<!-- -->` 之后，只认**真的标签** ✓ */
  const htmlNoComment = html.replace(/<!--[\s\S]*?-->/g, '');
  ok('「主菜单」按钮已从页面里删掉（真的标签里没有 ✓）',
     !/<button[^>]*id="btn-home"/.test(htmlNoComment),
     /id="btn-home"/.test(htmlNoComment) ? '还能搜到 ✗' : '没了 ✓');
  ok('「文件」按钮还在（别误删 ✓）', /<button[^>]*id="btn-export"/.test(htmlNoComment)
     || /id="export-row"/.test(htmlNoComment));
  /* Esc 那条逻辑必须还在 ✓ 删按钮不等于删功能 ✓ */
  ok('Esc 回主菜单的逻辑还在（`goHome` + Escape 监听 ✓）',
     /const goHome = /.test(html) && /Escape/.test(html));

  console.log('\n===== ③ 设置按钮 = 齿轮 =====');
  /* 🔴 2026-10-21 ✓ 用户："电脑版的设置按钮也改成一个齿轮样式吧"
   *   ⚠ 只剩图标了 → **`title` 和 `aria-label` 必须有** ✗
   *     没有的话鼠标悬停不知道是什么、读屏软件也念不出来 ✓
   *   ⚠ 齿轮得写成 `&#x2699;&#xFE0E;` ✗
   *     后面那个 U+FE0E 是"文字呈现"选择符 ✓
   *     不加会被当成 emoji、渲染成**彩色大图标** ✓ 跟顶栏那排无色图标不搭 ✓ */
  {
    const noComment = html.replace(/<!--[\s\S]*?-->/g, '');
    /* ⚠ 要取**整个元素**（含内容）✗ 齿轮字形是按钮的文本、不在开标签里 ✓ */
    const m = noComment.match(/<button[^>]*id="btn-settings"[\s\S]*?<\/button>/);
    const el = m ? m[0] : '';
    const tag = (el.match(/<button[^>]*>/) || [''])[0];
    ok('设置按钮还在', !!el);
    ok('用的是齿轮样式（`gear-btn` 类 ✓）', /gear-btn/.test(tag));
    ok('里面有齿轮字形且带 U+FE0E（防 emoji 彩色渲染 ✓）',
       /&#x2699;&#xFE0E;/.test(el) || /⚙︎/.test(el),
       /&#x2699;/.test(el) ? '有 ⚙ ✓' : '没有 ✗');
    ok('**没有**残留原来那两个字（「设置」不再是按钮文字 ✗）',
       !/>\s*设置\s*</.test(el));
    ok('有无障碍名（`aria-label="设置"` ✓）', /aria-label="设置"/.test(tag));
    ok('有悬停提示（`title` ✓）', /title="[^"]+"/.test(tag));
    /* 开合状态那条配色得还在 ✓ 齿轮开着时变金（日间是靛蓝 ✓ 靠 --gold 变量翻）*/
    ok('齿轮的"开着"状态配色还在（`aria-expanded="true"` ✓）',
       /#btn-settings\[aria-expanded="true"\]/.test(html));
  }

  console.log(`\n  通过 ${pass} 条，失败 ${fail} 条\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
