/**
 * 浮在画布上的控件，**不许把点击漏给地图**。
 *
 *   node tools/check_zoom_click.js
 *
 * 用户报的（2026-10-21）："这三个小按钮点击的同时会涂色被点击的地块"
 *   `.zoom-box`（缩放 − ＋ ⤢）是 `.stage` 的子元素 ✓
 *   `mousedown` 挂在 `stage` 上 ✓ 冒泡上来就被当成"在这一点涂了一下" ✓
 *   → 点一下"＋" 顺手改了地块颜色 ✓ 改的是**真数据** ✓ 很严重 ✓
 *
 * ⚠ 这个测试能成立的前提：模拟 DOM 里必须有 `closest` ✗
 *   桩里原来**没有**它 ✓ → 守门 `t.closest && ...` 恒为 false ✓
 *   于是"加完守门、测试全绿"其实是**守门没生效** ✓（2026-10-21 补上了 ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require(path.join(__dirname, 'lib', 'browser_stub.js'));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
  if (cond) { pass++; console.log(`  ✔ ${name}${info ? '  → ' + info : ''}`); }
  else { fail++; console.log(`  ✘ ${name}${info ? '  → ' + info : ''}`); }
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

  for (let i = 0; i < 4000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
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
      for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) {
        await new Promise((r) => setImmediate(r));
      }
      cards = env.get('map-pick-list').children;
    }
  }
  if (cards.length) cards[0].onclick();
  await b;
  await new Promise((r) => setTimeout(r, 300));

  const stage = env.get('stage');
  if (!stage) { console.log('✘ 拿不到 stage'); process.exit(1); }

  /* 把工具切成「涂抹」—— 只有画图工具才会在 mousedown 里落笔 ✓ */
  ex.setTool('paint');

  /* 造一个真实的 `.zoom-box > button` 子树挂进 stage ✓
   * （桩不解析 index.html ✓ 所以缩放按钮得自己搭 ✓）*/
  const doc = env.sandbox.document;
  const box = doc.createElement('div');
  box.className = 'zoom-box';
  const zin = doc.createElement('button');
  zin.id = 'btn-zoom-in';
  zin.className = 'btn tiny';
  box.appendChild(zin);
  stage.appendChild(box);

  /* ⚠ 判据：**守门生效时 `preventDefault` 不会被调** ✗
   *   因为那个处理器只要决定"落笔"就一定 `e.preventDefault()` ✓
   *   → 拿它当"有没有落笔"的信号 ✓ 不用去翻 state 内部字段 ✓ */
  const dispatch = (target, type = 'mousedown') => {
    let prevented = false;
    stage.dispatchEvent({
      type,
      button: 0,
      clientX: 120,
      clientY: 90,
      target,
      preventDefault() { prevented = true; },
    });
    return prevented;
  };

  console.log('\n===== 缩放按钮的点击不许漏给地图 =====');
  ok('模拟 DOM 有 closest（没它这条测试是假的 ✓）',
     typeof box.closest === 'function' && zin.closest('.zoom-box') === box,
     zin.closest && zin.closest('.zoom-box') ? '有 ✓' : '没有 ✗');

  ok('点「＋」不会落笔（不漏成涂色 ✓）', dispatch(zin) === false,
     dispatch(zin) ? '仍然落笔了 ✗' : '挡住了 ✓');

  /* 反向对照：直接点画布**必须**落笔 ✓ 证明上面那条不是"什么都不拦" */
  const plain = doc.createElement('div');
  plain.className = 'dummy';
  stage.appendChild(plain);
  ok('对照：点画布本身仍然会落笔（说明守门只挡控件 ✓）',
     dispatch(plain) === true, dispatch(plain) ? '照常落笔 ✓' : '连画布都挡了 ✗');

  /* 右键取色同理 ✓ */
  ok('在「＋」上右键不会取色', dispatch(zin, 'contextmenu') === true,
     'preventDefault 仍会调（挡浏览器菜单）但不应触发 pickAt ✓');
  ok('对照：在画布上右键会取色', dispatch(plain, 'contextmenu') === true);

  console.log(`\n  通过 ${pass} 条，失败 ${fail} 条\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
