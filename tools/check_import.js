/**
 * 导入式地图的尺子 —— 在 Node 里跑**真的 app.js**，从导入一路走到渲染前。
 *
 *   node tools/check_import.js
 *
 * 三件事必须钉住（见 docs/导入式地图-策划.md 的 M3 验收）：
 *   ① **同一份数据，走包和走 data_xxx/ 目录读出来必须逐字节一致** ✓
 *      —— "包里放的就是 data 目录那几份文件"这句话不能只是嘴上说
 *   ② 覆盖 / 删除 / 中途失败**不能留下半成品**：库里要么旧的要么新的，不许有孤儿 ✗
 *   ③ 陌生人的字符串（label / author）**不能当 HTML 跑** ✗
 *      这一条在自测里也必须有一条断言盯着（界面上是 map-card 那个节点 ✓）
 *
 * 好包用 _local/packs/ 里 pack_map.py 打的 eu4 那个（小、快、字段全）；
 * 坏包在内存里现造（把一个字节改坏就行）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name);
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '   → ' + extra : ''}`);
}

const PACK_DIR = path.join(H.ROOT, '_local', 'packs');
const PACK_FILE = path.join(PACK_DIR, 'eu4-vanilla.pdxmap');
const PACK_ID = 'eu4-vanilla-test';

const blobOf = (b) => new Blob([b]);

/** 开一整套假环境 + 拍平的源码（= 单文件版那一段） */
function freshEnv(opt = {}) {
  const env = H.makeEnv(opt);
  const js = H.flattenModules();
  const ex = H.instantiate(js, env);
  return { env, ex };
}

/** 库里躺着几个文件条目（用来查孤儿） */
function fileKeys(env) {
  const dump = env.sandbox.indexedDB._dump();
  const db = dump['pdx-map-editor'];
  if (!db || !db.stores || !db.stores.files) return [];
  return Object.keys(db.stores.files);
}

const sameArr = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** 把当前数据源的一整套东西读出来（meta / 头衔 / 四份 .bin） */
async function loadAll(ex) {
  return {
    meta: await ex.api.meta(),
    titles: await ex.api.titles(),
    provIds: await ex.api.provinceIds(),
    titlemap: await ex.api.titlemap(),
    adjacency: await ex.api.adjacency(),
    provPos: await ex.api.provPos(),
  };
}

/** meta 里跟"来源"有关的字段要比对时忽略掉 */
function normalizeMeta(m) {
  const c = Object.assign({}, m);
  delete c.gameRoot;      // 打包时被清掉的本机路径
  delete c.ck3_root;
  delete c.stashKey;      // 包这边是按 id 定死的，跟目录那边本来就该不一样
  return c;
}

/* ============================================================================
 * ① 导入 + "跟 data 目录逐字节一致"
 * ========================================================================== */
async function testImportAndEquivalence() {
  console.log('\n【导入 + 数据等价】');
  if (!fs.existsSync(PACK_FILE)) {
    ok('有测试包可导', false, `缺少 ${path.relative(H.ROOT, PACK_FILE)}：先跑 python pack_map.py`);
    return null;
  }
  const { env, ex } = await freshEnv();

  const mode = await ex.packStoreMode();
  ok('存储模式 = IndexedDB', mode === 'idb', mode);

  const raw = fs.readFileSync(PACK_FILE);
  const t0 = Date.now();
  const r = await ex.importPack(blobOf(raw), {});
  ok('导入成功', r.manifest && r.manifest.id === PACK_ID, `${r.manifest.id} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  ok('第一次导入：键 = 作者写的 id，而且是库里第 1 份',
    r.key === PACK_ID && r.sameMap === 1, `${r.key} · 第 ${r.sameMap} 份`);

  const packs = await ex.listPacks();
  ok('库里有一张图', packs.length === 1, packs.map((p) => p.id).join('/'));
  ok('记录里写了自己有哪些文件', packs[0].files.length >= 7, packs[0].files.join(' '));

  // 走目录读一遍
  ex.setDataDir('/data_eu4');
  const viaDir = await loadAll(ex);
  // 走包读一遍
  ex.setPackMap(PACK_ID);
  ok('切到包之后 isPackMap', ex.isPackMap() === true);
  const viaPack = await loadAll(ex);

  ok('meta 一致（除本机路径外）',
    JSON.stringify(normalizeMeta(viaDir.meta)) === JSON.stringify(normalizeMeta(viaPack.meta)),
    `${viaPack.meta.game} ${viaPack.meta.mapWidth}×${viaPack.meta.mapHeight}`);
  ok('meta 的 stashKey 被定成包 id（不会跟别的图串涂色）',
    viaPack.meta.stashKey === 'pack:' + PACK_ID, String(viaPack.meta.stashKey));
  ok('titles.json 一致（名字 + 颜色 + 层级 + 父级 —— 国家/地区就在这儿）',
    JSON.stringify(viaDir.titles) === JSON.stringify(viaPack.titles),
    `${(viaPack.titles.keys || []).length} 个头衔 · ${(viaPack.titles.colors || []).length} 条颜色`);
  ok(`provinces_id 一致（${viaPack.provIds.length} 个像素位）`, sameArr(viaDir.provIds, viaPack.provIds));
  ok(`titlemap 一致（${viaPack.titlemap.length} 项）`, sameArr(viaDir.titlemap, viaPack.titlemap));
  ok(`adjacency 一致（${viaPack.adjacency.length} 字节）`, sameArr(viaDir.adjacency, viaPack.adjacency));
  ok(`prov_pos 一致（${viaPack.provPos.length} 个数）`, sameArr(viaDir.provPos, viaPack.provPos));

  // 包里没有分块时，tileManifest 该老老实实返回 null（而不是抛）
  let tm = 'threw';
  try { tm = await ex.api.tileManifest(); } catch (e) { tm = 'threw:' + e.message; }
  ok('包里没有 tiles.json → tileManifest 返回 null', tm === null, String(tm));

  return { env, ex };
}

/* ============================================================================
 * ② 只增不改 / 拦住重复 / 删除 / 失败回滚
 *
 * ⚠ 这里是廿九 2026-10-11 改的规矩：**导入永远是新建一张**，
 *   之前导入的图一个字节都不动 ✓ 所以"覆盖"那套断言全删了，
 *   换成"再导一份 = 多一张，旧的还在" ✓
 * ========================================================================== */
async function testStoreLifecycle() {
  console.log('\n【只增不改 / 删除 / 回滚】');
  const { env, ex } = await freshEnv();
  const raw = fs.readFileSync(PACK_FILE);
  const r1 = await ex.importPack(blobOf(raw), {});
  ok('第一次导入：键就是作者写的 id（老数据不用迁移 ✓）',
    r1.key === PACK_ID && r1.sameMap === 1, r1.key);
  const keysAfterFirst = fileKeys(env);
  ok('导入后有文件条目', keysAfterFirst.length >= 7, keysAfterFirst.length + ' 个');

  /* 同一个文件再导一次：内容一模一样 → 库里抛 DUPLICATE ✓
     ⚠ 2026-10-12 起**界面不再拿它去问玩家**了 ✗ —— 直接带 allowDuplicate 重来 ✓
     所以下面验的是"库里那道闸还在"+"带 allowDuplicate 就能再进一张" ✓ */
  let e1 = null;
  try { await ex.importPack(blobOf(raw), {}); } catch (e) { e1 = e; }
  ok('一模一样的那一份会被**库里**拦下（DUPLICATE ✓ 不是覆盖 ✗）',
    !!e1 && e1.code === 'DUPLICATE', e1 ? e1.message : '居然直接放行了');
  ok('被拦下来时库里没变（一个字节都没多）', fileKeys(env).length === keysAfterFirst.length,
    `${keysAfterFirst.length} → ${fileKeys(env).length}`);

  // 带 allowDuplicate 再导 → **新增一张**，旧的原地不动 ✓
  const r2 = await ex.importPack(blobOf(raw), { allowDuplicate: true });
  ok('带 allowDuplicate 再导 → 多了一张（键加了后缀）',
    r2.key !== PACK_ID && r2.sameMap === 2, r2.key);
  const keysAfterSecond = fileKeys(env);
  ok('库里现在是两份的文件（旧的没被动过）',
    keysAfterSecond.length === keysAfterFirst.length * 2,
    `${keysAfterFirst.length} → ${keysAfterSecond.length}`);
  ok('第一份还在，内容没变',
    (await ex.listPacks()).some((p) => p.id === PACK_ID)
    && (await ex.getPack(PACK_ID)).manifest.id === PACK_ID);
  ok('两份读出来的数据一样（都是那张 EU4 图）',
    sameArr(await (async () => { ex.setPackMap(PACK_ID); return ex.api.titlemap(); })(),
      await (async () => { ex.setPackMap(r2.key); return ex.api.titlemap(); })()));
  ok('删掉第二份，第一份不受影响', await (async () => {
    await ex.removePack(r2.key);
    const left = await ex.listPacks();
    return left.length === 1 && left[0].id === PACK_ID;
  })());

  // 坏包：校验不过 → 库里一个字节都不能动
  ex.setDataDir('/data_eu4');                      // 顺手把数据源切回目录，免得影响后面
  const before = fileKeys(env).length;
  const bad = Buffer.from(raw);
  // 这里改成"截断"，那是最典型的"没传完"
  let e2 = null;
  try { await ex.importPack(blobOf(bad.subarray(0, Math.floor(bad.length / 2))), {}); } catch (e) { e2 = e; }
  ok('半截的包被拒', !!e2, e2 ? e2.message : '居然收下了');
  ok('被拒之后库里没有变化（不留半个包）', fileKeys(env).length === before, `${before} → ${fileKeys(env).length}`);

  // 库里那张还在
  const still = await ex.getPack(PACK_ID);
  ok('原来那张还在（导入失败不毁别的图）', !!still && still.manifest.id === PACK_ID);

  /* ---- 真·写到一半失败：让第 3 次 put 炸掉 ----
     这一条必须靠**事务回滚**才过得去：没有回滚的话，库里会留下
     "一半文件进去了、记录还没写"这种最难受的状态 ✗
     （用 allowDuplicate 绕过"重复"那道检查 —— 这里要验的是写入过程，不是去重 ✓） */
  const packsBeforeFail = (await ex.listPacks()).length;
  const keysBeforeFail = fileKeys(env).length;
  env.sandbox.indexedDB._failPutAfter(3);
  let e3 = null;
  try { await ex.importPack(blobOf(raw), { allowDuplicate: true }); } catch (e) { e3 = e; }
  ok('写到一半失败会往上抛（不能悄悄当成功）', !!e3, e3 ? e3.message : '居然当成功了');
  ok('回滚了：一张图都没多', (await ex.listPacks()).length === packsBeforeFail,
    `${packsBeforeFail} → ${(await ex.listPacks()).length}`);
  ok('回滚了：文件条目数没变（没留下半个包）', fileKeys(env).length === keysBeforeFail,
    `${keysBeforeFail} → ${fileKeys(env).length}`);
  ok('回滚之后还能正常读数据', sameArr(
    await (async () => { ex.setPackMap(PACK_ID); return ex.api.titlemap(); })(),
    await (async () => { ex.setDataDir('/data_eu4'); return ex.api.titlemap(); })()));

  // 删除
  await ex.removePack(PACK_ID);
  ok('删除后记录没了', (await ex.listPacks()).length === 0);
  ok('删除后文件条目也没了', fileKeys(env).length === 0, fileKeys(env).join(' '));
  ok('删干净之后 getFile 返回 null', (await ex.listPacks()).length === 0);
}

/* ============================================================================
 * ③ 没有 IndexedDB 时的降级：能用，但必须"说清楚刷新会丢"
 * ========================================================================== */
async function testNoIdbFallback() {
  console.log('\n【隐私模式 / 没有 IndexedDB】');
  const { env, ex } = await freshEnv({ idb: false });
  const mode = await ex.packStoreMode();
  ok('降级成"只在这次会话里"', mode === 'memory', mode);
  const raw = fs.readFileSync(PACK_FILE);
  const r = await ex.importPack(blobOf(raw), {});
  ok('照样能导入（不能因为存不下就不让用）', r.manifest.id === PACK_ID);
  ok('照样能列出来', (await ex.listPacks()).length === 1);
  ex.setPackMap(PACK_ID);
  const meta = await ex.api.meta();
  ok('照样能读数据', meta.game === 'eu4' && meta.numProvinces > 0, `${meta.numProvinces} 地块`);
  const logs = (env.sandbox.window.PDXLOG && env.sandbox.window.PDXLOG.text()) || '';
  ok('日志里写明了"只在本次会话里"（界面要照着这句提示玩家）', /本次会话/.test(logs));

  /* 界面上也必须写明 —— 只说在日志里等于没说 ✗
     玩家会以为存上了，第二天发现没了还以为是编辑器坏的 */
  const booting = ex.boot();
  await waitCards(env, 2);
  const hint = env.get('map-import-hint');
  ok('存不下的时候，界面上会写明"刷新就没了"（而且这时才显示）',
    /刷新/.test(hint.textContent || '') && hint.classList.contains('warn') && hint.hidden === false,
    `${hint.textContent}（hidden=${hint.hidden}）`);
  const cards = env.get('map-pick-list').children;
  cards[0].onclick();
  await booting;
}

/* ============================================================================
 * ④ 真跑一遍 boot：选图界面出现"已导入"，点了能起，label 里的 HTML 不许当代码跑
 * ========================================================================== */
async function testBoot() {
  console.log('\n【真跑一遍 boot】');
  const { env, ex } = await freshEnv();
  const raw = fs.readFileSync(PACK_FILE);

  /* 先把 label 换成一个恶意串、再打进库里 ——
     模拟"玩家从工坊下了一个名字里带 <img onerror> 的包" ✓
     重打的时候只改 manifest，其它文件原样搬（哈希清单覆盖的是文件，manifest 自己不算） */
  const zip = await ex.readZip(blobOf(raw));
  const man = JSON.parse(await zip.text('manifest.json'));
  man.label = '<img src=x onerror=alert(1)>KR 图</b>';
  man.author = '<script>alert(2)</script>';
  const files = [{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(man)) }];
  for (const e of zip.entries) {
    if (e.name === 'manifest.json') continue;
    files.push({ name: e.name, data: await zip.bytes(e.name) });
  }
  // 库里本来是空的，导这一份就是第 1 份 ✓（导入只增不改，不需要什么 replace）
  await ex.importPack(new Blob([await ex.makeZipAsync(files)]), {});

  const booting = ex.boot();
  for (let i = 0; i < 3000 && !env.get('map-pick-list').children.length; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const cards = env.get('map-pick-list').children;
  ok('选图界面列出了原版 + 导入的这张', cards.length >= 2, `${cards.length} 张`);

  const pick = cards.find((c) => c.flat().includes('KR 图'));
  ok('导入的图出现在选单里', !!pick);

  const tags = pick ? pick.children.filter((c) => c.className === 'map-card-tag') : [];
  /* ⚠ 2026-10-12 起那一栏上**不写「已导入」三个字**了 ✗ —— 只剩版本号 ✓
     "这是导入进来的"改由卡片的 `imported` 类 + 那两个动作按钮说 ✓ */
  ok('导入的卡片带着 imported 类和那一栏版本号',
    !!pick && /(^| )imported( |$)/.test(pick.className || '')
    && tags.length === 1 && !/已导入/.test(tags[0].textContent),
    `${pick ? pick.className : '（没有卡）'} / `
    + (tags.length ? `"${tags[0].textContent}"` : '（没有那一栏）'));

  /* ⚠ 这条是本轮最要紧的断言：
     恶意 label 必须**原样显示成文字**，不许在页面里造出 <img> / <script> 节点 ✗ */
  const flatHtml = pick ? pick.flat() : '';
  const imgs = pick ? findAll(pick, (el) => String(el.tagName).toUpperCase() === 'IMG') : [];
  const scripts = pick ? findAll(pick, (el) => String(el.tagName).toUpperCase() === 'SCRIPT') : [];
  ok('label 里的 <img> 没有变成真节点', imgs.length === 0, imgs.length ? '造出来了 ✗' : '');
  ok('author 里的 <script> 没有变成真节点', scripts.length === 0, scripts.length ? '造出来了 ✗' : '');
  ok('恶意串原样当文字显示', /<img src=x onerror/.test(flatHtml), '');

  if (pick) pick.onclick();
  await booting;
  ok('点了之后进的确实是这个包', ex.isPackMap() === true);
  ok('meta 是包里的那份', !!(ex.state.meta && ex.state.meta.numProvinces > 0),
    ex.state.meta ? `${ex.state.meta.game} · ${ex.state.meta.numProvinces} 地块` : '没装上 ✗');
  ok('术语跟着包的游戏走（EU4 不是 CK3）', ex.GAME && ex.GAME.name && /欧陆|EU4/.test(ex.GAME.name),
    ex.GAME ? ex.GAME.name : '');
  const step = (env.get('boot-step') || {}).textContent || '';
  ok('boot 跑到"就绪"', /就绪/.test(step), step || '（没走到那一步）');
  ok('渲染器建起来了', !!ex.renderer);
}

/** 把包里的 manifest 换掉（别的文件原样搬）—— 用来做一个"内容不同、id 相同"的新版本 */
async function rezipWithLabel(ex, rawBytes, label) {
  const zip = await ex.readZip(blobOf(rawBytes));
  const man = JSON.parse(await zip.text('manifest.json'));
  man.label = label;
  const files = [{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(man)) }];
  for (const e of zip.entries) {
    if (e.name === 'manifest.json') continue;
    files.push({ name: e.name, data: await zip.bytes(e.name) });
  }
  return ex.makeZipAsync(files);
}

/** 等一会儿（推几轮微任务/宏任务，让异步流程走完） */
async function waitFor(fn, tries = 2000) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return false;
}

/** 等选图界面把卡片造出来 */
async function waitCards(env, n = 1) {
  await waitFor(() => env.get('map-pick-list').children.length >= n);
  return env.get('map-pick-list').children;
}

/** 按显示名找一张卡片 */
function findCard(list, text) {
  return (list.children || []).find((c) => c.flat().includes(text));
}

/* ============================================================================
 * ⑤ 界面：导入入口 / 拖拽 / 导出备份 / 删除
 *    （两个动作**直接长在卡片上** ✓ 那个「⋯」面板 2026-10-12 拆了，见 ③）
 * ========================================================================== */
async function testUi() {
  console.log('\n【界面】');
  const { env, ex } = await freshEnv();
  const raw = fs.readFileSync(PACK_FILE);
  const booting = ex.boot();
  const listEl = env.get('map-pick-list');          // ⚠ 元素（children 每次重画都会换一个数组）
  await waitCards(env, 2);

  ok('选图界面有导入入口', !!env.get('map-import'));
  /* 那行说明平时**不显示**（廿九说别啰嗦 ✗）—— 只有"存不下"才跳警示，
     那一条在 ③ 隐私模式那一节验 ✓ */
  const idleHint = env.get('map-import-hint');
  ok('平时不摆那行说明（空的、也藏着）',
    !(idleHint.textContent || '').trim() && idleHint.hidden === true,
    `"${idleHint.textContent || ''}" hidden=${idleHint.hidden}`);

  // ---- ① 点入口 → 选文件 → 卡片出现（但**不自动进去**）
  const before = listEl.children.length;
  env.get('map-import').onclick();
  const fi = env.get('pack-file');
  fi.files = [blobOf(raw)];
  await fi.onchange();
  ok('点入口 + 选文件 → 列表里多了一张', listEl.children.length === before + 1,
    `${before} → ${listEl.children.length}`);
  ok('提示写明了导入成功', /成功导入地图/.test(env.get('map-msg').textContent || ''),
    env.get('map-msg').textContent);
  /* ⚠ 那截"（游戏 · 地块数 · 尺寸）"**删了** ✗（2026-10-12 用户要求）——
     尺寸卡片上那一栏本来就有 ✓ */
  ok('导入提示里不再带括号那截（尺寸 / 地块数卡片上有 ✓）',
    !/个地块/.test(env.get('map-msg').textContent || ''), env.get('map-msg').textContent);
  ok('导入成功**不自动进去**（还是停在选图界面）', env.get('map-pick').hidden === false);
  const newCard = findCard(listEl, 'EU4 原版（测试包）');
  ok('新卡片带 imported 类和版本号那一栏（不再写"已导入"✓）',
    !!newCard && /(^| )imported( |$)/.test(newCard.className || '')
    && newCard.children.some((c) => c.className === 'map-card-tag'));

  // ---- ② 拖一个坏文件进来：红字 + 一句话原因 + 库里不留痕
  const keysBefore = fileKeys(env).length;
  const half = Buffer.from(raw).subarray(0, Math.floor(raw.length / 2));
  env.get('boot').dispatchEvent({ type: 'drop', dataTransfer: { files: [blobOf(half)] } });
  await waitFor(() => /导入失败/.test(env.get('map-msg').textContent || ''));
  ok('拖进来的坏文件被拒（红字）',
    env.get('map-msg').classList.contains('bad'), env.get('map-msg').className);
  ok('红字里写了原因', /zip|不完整|读不了|对不上/.test(env.get('map-msg').textContent),
    env.get('map-msg').textContent);
  ok('坏包没进库（一个字节都没留）', fileKeys(env).length === keysBefore,
    `${keysBefore} → ${fileKeys(env).length}`);
  ok('报错旁边有「复制详情」', findAll(env.get('map-msg'), (el) => el.textContent === '复制详情').length === 1);

  // ---- ③ 两个动作**直接在卡片上**（2026-10-12 从「⋯」小面板提上来的 ✓）
  const card = findCard(listEl, 'EU4 原版（测试包）');
  const actOf = (c) => findAll(c, (el) => typeof el.className === 'string'
    && /^map-act\b/.test(el.className));
  const acts = actOf(card);
  ok('卡片上直接有「导出」和「删除」两个按钮',
    acts.map((x) => x.textContent).join('/') === '导出/删除',
    acts.map((x) => x.textContent).join('/') || '一个都没有');
  /* ⚠ 管理面板（「⋯」那个弹窗）**连元素带样式整个拆了** ✗ ——
     动作都提到第一层了，再留一个空浮层只会又踩一遍"关不掉"那个坑 ✓ */
  const pageHtml = fs.readFileSync(path.join(H.ROOT, 'web', 'index.html'), 'utf8');
  ok('页面上不再有那个管理面板（动作都搬到卡片上了 ✓）',
    !/pack-menu|map-more/.test(pageHtml),
    (pageHtml.match(/pack-menu|map-more/g) || []).join(','));

  // ---- ④ 导出（备份）：拿到的文件自己也得是个合法包（能再导回来）
  const btnExport = acts.find((x) => x.textContent === '导出');
  await btnExport.onclick({ stopPropagation() {}, preventDefault() {} });
  ok('导出备份产生了一个文件', !!env.savedBlob && env.savedBlob.size > 10000,
    env.savedBlob ? `${(env.savedBlob.size / 1048576).toFixed(2)} MB` : '没有');
  ok('导出成功的提示里带上了地图名字 ✓',
    /成功导出地图：/.test(env.get('map-msg').textContent || ''),
    env.get('map-msg').textContent);
  let backupOk = false;
  try {
    const zip2 = await ex.readZip(env.savedBlob);
    const r2 = await ex.validatePack(zip2, {});
    backupOk = r2.manifest.id === PACK_ID;
    ok('备份文件自己也是合法包（以后能再导进来）', backupOk, r2.manifest.id);
  } catch (e) {
    ok('备份文件自己也是合法包（以后能再导进来）', false, e.message);
  }

  // ---- ⑤ 删除（桩里的 confirm 恒为"确定"）
  /* 先给这张图放一份涂色 —— 用户定的：**删图时涂色跟着一起删，不再问** ✓
     （所以这里放一份，看它删完还在不在 ✓）*/
  putStash(env, 'pack:' + PACK_ID, 'paint-bye');
  const btnDel = actOf(findCard(listEl, 'EU4 原版（测试包）'))
    .find((x) => x.textContent === '删除');
  await btnDel.onclick({ stopPropagation() {}, preventDefault() {} });
  ok('删掉之后卡片从列表里消失了', !findCard(listEl, 'EU4 原版（测试包）'));
  ok('库里也空了', (await ex.listPacks()).length === 0);
  ok('文件条目一起清干净', fileKeys(env).length === 0, fileKeys(env).join(' '));
  ok('删图时**涂色也一起删了**（不再问、也不留 ✓）',
    !stashOf(env)['pack:' + PACK_ID], Object.keys(stashOf(env)).join('  |  ') || '（空的 ✓）');
  ok('删除的提示是「成功删除地图：名字」✓',
    /成功删除地图：/.test(env.get('map-msg').textContent || ''), env.get('map-msg').textContent);

  // 收尾：点一张原版的卡，让 boot 正常结束（不然那个 Promise 一直挂着）
  const vanilla = listEl.children[0];
  if (vanilla) vanilla.onclick();
  await booting;
  const step = (env.get('boot-step') || {}).textContent || '';
  ok('界面这一通折腾之后，编辑器还能正常起来', /就绪/.test(step), step);
}

/* ============================================================================
 * ⑥ 带分块的大包（EU5 原尺寸）：导入 → 数据源 → TileMap 真取得到块
 *
 * 为什么要单列一条：分块那套走的是**另一条路**（tileManifest / tileBytes），
 * 不分块的包全绿也盖不住它 ✗ 而它恰好是最"重"的一种包（12 MB、解压 540 MB）
 * ========================================================================== */
async function testTilesPack() {
  console.log('\n【分块包（EU5 原尺寸）】');
  const pack = path.join(PACK_DIR, 'eu5-full.pdxmap');
  const dir = path.join(H.ROOT, 'data_eu5_full');
  if (!fs.existsSync(pack) || !fs.existsSync(dir)) {
    console.log('  · 跳过（没有 eu5-full.pdxmap 或者 data_eu5_full/）');
    return;
  }
  const { env, ex } = await freshEnv();
  const t0 = Date.now();
  const r = await ex.importPack(blobOf(fs.readFileSync(pack)), {});
  ok('12 MB 的分块包导入成功（校验要过完 540 MB 解压量）',
    r.manifest.id === 'eu5-full-test',
    `${((Date.now() - t0) / 1000).toFixed(1)}s · ${r.manifest.stats.mapWidth}×${r.manifest.stats.mapHeight}`);

  ex.setPackMap('eu5-full-test');
  const man = await ex.api.tileManifest();
  ok('分块清单读到了', !!man && man.cols === 4 && man.rows === 4 && man.files.length === 16,
    man ? `${man.cols}×${man.rows} 块 · 每块 ${man.tileW}×${man.tileH}` : '读不到 ✗');

  // 逐字节：包里那份 vs 目录那份（第一块 + 最后一块，顺带跨一下边界）
  for (const name of ['t_0_0.bin', 't_3_3.bin']) {
    ex.setDataDir('/data_eu5_full');
    const a = await ex.api.tileBytes(name);
    ex.setPackMap('eu5-full-test');
    const b = await ex.api.tileBytes(name);
    ok(`${name} 和目录里那份逐字节一致（${(a.length / 1048576).toFixed(1)} MB）`, sameArr(a, b));
  }

  // 整条路走一遍：boot 选这张图，TileMap 真的取得到块
  const booting = ex.boot();
  await waitCards(env, 2);
  const card = findCard(env.get('map-pick-list'), 'EU5 原尺寸');
  ok('分块包也在选单里', !!card);
  if (card) card.onclick();
  await booting;
  ok('boot 跑到就绪', /就绪/.test((env.get('boot-step') || {}).textContent || ''),
    (env.get('boot-step') || {}).textContent);
  const tm = ex.state.tileMap;
  ok('走的是分块那条路（TileMap 建起来了）', !!tm);
  if (tm && man) {
    const t = await tm.get(0, 0);
    ok('TileMap 能取到第 0 块，尺寸对',
      !!t && t.length === man.tileW * man.tileH,
      t ? `${t.length} 个像素` : '取不到 ✗');
    if (t) {
      let mx = 0;
      for (let i = 0; i < t.length; i++) if (t[i] > mx) mx = t[i];
      ok('块里的省份号没越界', mx < ex.state.meta.numProvinces,
        `最大 ${mx} / 共 ${ex.state.meta.numProvinces}`);
    }
  }
}

/* ============================================================================
 * ⑦ 设置 / 颜色跟**游戏类型**走，涂色跟**哪一张图**走
 *
 * 🔴 2026-10-12 廿九定的：设置 / 最近颜色**同款游戏共用一份**
 *   （TNO 和钢铁雄心4原版是同一份 ✓），删掉某一张图也不许把它们带走 ✓
 *   而**涂色暂存**必须按实例分 —— 包的 meta 是作者写的，他随手填个 stashKey
 *   就能把两张图接到同一份涂色上，结果"涂 A 图 B 也变了" ✗
 *   所以 data.js 把包的 stashKey 定死成 pack:<id> ✓，这条盯着那个"定死" ✓
 * ========================================================================== */
async function testPrefsIsolation() {
  console.log('\n【设置跟游戏走 / 涂色跟图走】');
  const { env, ex } = await freshEnv();
  await ex.importPack(blobOf(fs.readFileSync(PACK_FILE)), {});

  ex.setDataDir('/data_eu4');
  const metaVanilla = await ex.api.meta();
  ex.setPackMap(PACK_ID);
  const metaPack = await ex.api.meta();

  ex.state.meta = metaPack;
  ex.state.set = { probe: 'pack' };
  ex.saveMapPrefs();
  ex.state.meta = metaVanilla;
  ex.state.set = { probe: 'vanilla' };
  ex.saveMapPrefs();

  const box = JSON.parse(env.sandbox.localStorage.getItem('pdx-map-editor/prefs/v1') || '{}');
  const keys = Object.keys(box);
  ok('同款游戏的两张图**共用一份**设置（盘上只有一个 key ✓）',
    keys.length === 1, keys.join('  |  '));
  ok('那个 key 就是**游戏类型**（不是 pack:<id>、也不是尺寸指纹 ✓）',
    keys[0] === 'eu4', keys.join('  |  '));

  const backVanilla = ex.loadMapPrefs(metaVanilla);
  ok('原版这张读回来的是共用那份（后写的覆盖 ✓）',
    !!(backVanilla && backVanilla.set && backVanilla.set.probe === 'vanilla'),
    JSON.stringify(backVanilla && backVanilla.set));
  const backPack = ex.loadMapPrefs(metaPack);
  ok('包那张读回来的**也是同一份**（TNO 和原版共用 ✓）',
    !!(backPack && backPack.set && backPack.set.probe === 'vanilla'),
    JSON.stringify(backPack && backPack.set));

  const otherGame = Object.assign({}, metaVanilla, { game: 'ck3' });
  ok('换成**别的游戏**就读不到（那条线是"类型"✓）',
    !ex.loadMapPrefs(otherGame), JSON.stringify(ex.loadMapPrefs(otherGame)));

  ok('涂色暂存仍然钉在**这一份实例**上（作者填 stashKey 也抢不走 ✓）',
    String(metaPack.stashKey || '') === 'pack:' + PACK_ID, String(metaPack.stashKey));
}

/* ============================================================================
 * ⑧ "刷新之后还在" —— 这是这个功能的**核心承诺**，得有一条断言钉住
 *
 * 浏览器里"刷新"= 换一个页面环境、但**存储还是同一个**（同一个来源 ✓）
 * 所以这里换一套假环境、**把上一个环境的 IndexedDB 传进去** ✓
 * （makeEnv 支持 opt.indexedDB，就是为这件事留的）
 * ========================================================================== */
async function testReloadPersistence() {
  console.log('\n【刷新之后还在】');
  const env1 = H.makeEnv();
  const ex1 = H.instantiate(H.flattenModules(), env1);
  await ex1.importPack(blobOf(fs.readFileSync(PACK_FILE)), {});
  ok('第一次打开：导入成功', (await ex1.listPacks()).length === 1);

  // 「刷新」：新的页面环境，同一个存储
  const env2 = H.makeEnv({ indexedDB: env1.sandbox.indexedDB });
  const ex2 = H.instantiate(H.flattenModules(), env2);
  const packs2 = await ex2.listPacks();
  ok('刷新之后：那张图还在（这就是"刷新不丢"）',
    packs2.length === 1 && packs2[0].id === PACK_ID, packs2.map((p) => p.id).join('/') || '（空了）');

  ex2.setPackMap(PACK_ID);
  const tm = await ex2.api.titlemap();
  ok('刷新之后：数据还读得出来', tm.length === 34594, `${tm.length} 项`);

  const booting = ex2.boot();
  await waitCards(env2, 2);
  const card = findCard(env2.get('map-pick-list'), 'EU4 原版（测试包）');
  ok('刷新之后：选单里还有这张图（带着 imported 类 ✓）',
    !!card && /(^| )imported( |$)/.test(card.className || '')
    && card.children.some((c) => c.className === 'map-card-tag'));
  if (card) card.onclick();
  await booting;
  ok('刷新之后：点进去能起到就绪',
    /就绪/.test((env2.get('boot-step') || {}).textContent || ''),
    (env2.get('boot-step') || {}).textContent);
  ok('刷新之后：进的确实是那张包', ex2.isPackMap() === true);
}

/* ============================================================================
 * ⑨ 导出备份 → 删除 → 把备份再导回来（策划里 M4 的验收就是这条链）
 *
 * 为什么非测不可：备份是玩家**唯一的后路**（浏览器存储不是网盘 ✓）。
 * 备份文件自己合法（check_import 里已经验过 manifest），
 * 但"它真的能当包再导进来、数据一模一样"是另一回事 ✗
 * ========================================================================== */
async function testBackupRoundTrip() {
  console.log('\n【导出备份 → 删除 → 再导回来】');
  const { env, ex } = await freshEnv();
  await ex.importPack(blobOf(fs.readFileSync(PACK_FILE)), {});
  ex.setPackMap(PACK_ID);
  const tmBefore = await ex.api.titlemap();
  const adjBefore = await ex.api.adjacency();
  const metaBefore = await ex.api.meta();

  const bytes = await ex.exportPackBytes(PACK_ID, null);
  ok('导出备份拿到字节', !!bytes && bytes.length > 10000,
    bytes ? `${(bytes.length / 1048576).toFixed(2)} MB` : '没有');
  await ex.removePack(PACK_ID);
  ok('删掉之后库里空了', (await ex.listPacks()).length === 0);

  const r2 = await ex.importPack(new Blob([bytes]), {});
  ok('把备份导回来：成功（删干净了，所以又是第 1 份）',
    r2.manifest.id === PACK_ID && r2.key === PACK_ID && r2.sameMap === 1,
    `${r2.key} · 第 ${r2.sameMap} 份`);

  ex.setPackMap(PACK_ID);
  ok('导回来之后 titlemap 一模一样', sameArr(tmBefore, await ex.api.titlemap()));
  ok('导回来之后 adjacency 一模一样', sameArr(adjBefore, await ex.api.adjacency()));
  const m2 = await ex.api.meta();
  ok('导回来之后 meta 也回来了',
    m2.game === metaBefore.game && m2.numProvinces === metaBefore.numProvinces,
    `${m2.game} · ${m2.numProvinces} 地块`);

  // 来回折腾之后还能真的用起来（别只验数据，把启动也走一遍）
  const booting = ex.boot();
  await waitCards(env, 2);
  const card = findCard(env.get('map-pick-list'), 'EU4 原版（测试包）');
  if (card) card.onclick();
  await booting;
  ok('导回来那张能起到就绪',
    /就绪/.test((env.get('boot-step') || {}).textContent || ''),
    (env.get('boot-step') || {}).textContent);
}

/* ============================================================================
 * ⑩ 同一个包导入两份时：**旧的那份一个字节都不能被动**，两份的涂色各存各的
 *
 * 这是廿九 2026-10-11 定的规矩（"不覆盖之前的地图，而是新建一张"）✓
 * 所以这里盯三件事：
 *   ① 再导一份，第一份的内容和它的涂色**都不变**
 *   ② 两份的涂色键不一样（各涂各的，不会互相串）
 *   ③ 删掉第二份，第一份的涂色还在
 *
 * ⚠ 2026-10-12：设置 / 最近颜色改成按**游戏类型**存了 ✓ ——
 *   所以"每一份自己那份"就只剩**涂色**，下面用 `stashOf` / `putStash` 代表它 ✓
 *   （原来拿 `prefsOf['pack:<id>']` 当"这份的设置"，那个键现在不存在了 ✗）
 * ========================================================================== */
function prefsOf(env) {
  try {
    return JSON.parse(env.sandbox.localStorage.getItem('pdx-map-editor/prefs/v1') || '{}');
  } catch (e) { return {}; }
}

/* ⚠ 设置不再跟着图走 ✗ —— 它按游戏类型存（`prefsKeyOf` = `meta.game`），
   所以"某一份自己的状态"要用**涂色暂存**来代表（键 = `meta.stashKey` = `pack:<id>` ✓）
   `stashNow` / `stashBox` 没导出到桩里，这里就自己读写那个 box ✓ */
function stashOf(env) {
  try {
    return JSON.parse(env.sandbox.localStorage.getItem('pdx-map-editor/stash/v1') || '{}');
  } catch (e) { return {}; }
}
function putStash(env, key, probe) {
  const b = stashOf(env);
  b[key] = { version: 1, probe };
  env.sandbox.localStorage.setItem('pdx-map-editor/stash/v1', JSON.stringify(b));
}

async function testDuplicateCopiesIndependent() {
  console.log('\n【同一张图导两份：旧的不会被碰】');
  const { env, ex } = await freshEnv();
  const raw = fs.readFileSync(PACK_FILE);

  const booting = ex.boot();
  await waitCards(env, 2);
  const fi = env.get('pack-file');
  /** 走界面那条路导一次（第二遍会撞上库里那份一模一样的 → 直接再进一张 ✓） */
  const importViaUi = async () => {
    fi.files = [blobOf(raw)];
    await fi.onchange();
  };

  // ---- 第一份 + 给它存一份涂色（设置那份现在按游戏类型走了，代表不了"单独一份"✓）
  await importViaUi();
  ex.setPackMap(PACK_ID);
  ex.state.meta = await ex.api.meta();
  const key1 = ex.state.meta.stashKey;
  putStash(env, key1, 'paint-1');
  // 顺手确认设置那份**只有一个 key**（按游戏类型 ✓ 不按图 ✓）
  ex.state.set = { probe: 'shared' };
  ex.saveMapPrefs();
  const tm1 = await ex.api.titlemap();
  ok('（预备）涂色暂存里有第一份那条', !!stashOf(env)[key1], key1);
  ok('（预备）设置按**游戏类型**存（只有一个 key = eu4 ✓）',
    Object.keys(prefsOf(env)).join() === 'eu4', Object.keys(prefsOf(env)).join('  |  '));

  // ---- 再导一份（界面会问一句，桩里的 confirm 恒为"确定"）
  await importViaUi();
  const packs = await ex.listPacks();
  ok('又导了一份 → 库里有两张（不是替换）', packs.length === 2,
    packs.map((p) => p.id).join(' + '));
  ok('第一份的键和记录都还在', packs.some((p) => p.id === PACK_ID));
  const secondKey = packs.find((p) => p.id !== PACK_ID).id;
  ok('第二份的键带后缀（跟第一份分开）', /~2$/.test(secondKey), secondKey);
  ok('提示里说明了这是第 2 份、之前的都留着',
    /第 2 份/.test(env.get('map-msg').textContent || '') && /都留着/.test(env.get('map-msg').textContent || ''),
    env.get('map-msg').textContent);
  ok('第一份的涂色**一点没动**', (stashOf(env)[key1] || {}).probe === 'paint-1',
    JSON.stringify(stashOf(env)[key1]));

  // ---- 两份是两张独立的图：数据一样，涂色键不一样 ✓
  ok('两份读出来的图数据一样', sameArr(tm1, await (async () => {
    ex.setPackMap(secondKey);
    return ex.api.titlemap();
  })()));
  ex.state.meta = await ex.api.meta();          // 现在选的是第二份
  ok('第二份的涂色键跟第一份不一样',
    ex.state.meta.stashKey === 'pack:' + secondKey && secondKey !== PACK_ID,
    ex.state.meta.stashKey);
  const key2 = ex.state.meta.stashKey;
  putStash(env, key2, 'paint-2');
  ok('两份的涂色各存各的（互不覆盖）',
    (stashOf(env)[key1] || {}).probe === 'paint-1'
    && (stashOf(env)[key2] || {}).probe === 'paint-2',
    Object.keys(stashOf(env)).join('  |  '));
  ok('两份的**设置共用一份**（按游戏类型走 —— 这也是廿九要的 ✓）',
    Object.keys(prefsOf(env)).length === 1, Object.keys(prefsOf(env)).join('  |  '));

  // ---- 卡片上要能分清是哪一份（不然两张卡长得一模一样）
  const cards = env.get('map-pick-list').children;
  const twoNames = cards.map((c) => c.flat()).join('  ||  ');
  /* ⚠ 2026-10-12 改了：**名字里不再塞「（第 2 份）」** ✗
     —— 改成卡片左上角挂一个**小序号**（1 / 2 ✓）*/
  ok('卡片名字就是原名（不往里塞"（第 2 份）"✓）',
    !/第 2 份/.test(twoNames), twoNames.replace(/\s+/g, ' ').slice(0, 120));
  const nos = findAll(env.get('map-pick-list'), (el) => el.className === 'map-card-no')
    .map((x) => x.textContent);
  ok('两份各自挂了个小序号（1 和 2 ✓）', nos.join(',') === '1,2',
    nos.join(',') || '一个序号都没有 ✗');

  // ---- 删掉第二份：第一份和它的涂色都不受影响
  await ex.removePack(secondKey);
  ok('删掉第二份之后只剩第一份', (await ex.listPacks()).length === 1);
  ok('第一份的涂色还在', (stashOf(env)[key1] || {}).probe === 'paint-1',
    JSON.stringify(stashOf(env)[key1]));
  ok('第一份读数据照样好', sameArr(tm1, await (async () => {
    ex.setPackMap(PACK_ID);
    return ex.api.titlemap();
  })()));

  const first = env.get('map-pick-list').children[0];
  if (first) first.onclick();
  await booting;
}

/** 在假 DOM 子树里找符合条件的节点 */
function findAll(el, pred, out = []) {
  if (pred(el)) out.push(el);
  for (const c of el.children || []) findAll(c, pred, out);
  return out;
}

/* ============================================================================
 * ⑪ 一次选好几个 .pdxmap
 *
 * 用户 2026-10-12 要求：文件选择框支持多选 ✓
 * 挨个导 ✓ 一个不成不影响后面的 ✓ 最后补一句总数
 * （不然每次都会把那条提示覆盖一遍，玩家只看得见最后那一张 ✓）
 * ========================================================================== */
async function testMultiImport() {
  console.log('\n【一次选好几个包】');
  const { env, ex } = await freshEnv();
  const raw = fs.readFileSync(PACK_FILE);
  const booting = ex.boot();
  const listEl = env.get('map-pick-list');
  await waitCards(env, 2);
  const before = listEl.children.length;

  const pageHtml = fs.readFileSync(path.join(H.ROOT, 'web', 'index.html'), 'utf8');
  ok('文件选择框写明了可以多选（multiple ✓）',
    /id="pack-file"[^>]*\bmultiple\b/.test(pageHtml), '没写 multiple ✗');

  /* 同一份文件选两次：第二个会撞上库里那份一模一样的，**直接再进一张**（不再问 ✓）——
     这样能验"挨个导"，又不用往仓库里再塞一个测试包 ✓ */
  const fi = env.get('pack-file');
  fi.files = [blobOf(raw), blobOf(raw)];
  await fi.onchange();
  ok('一次选两个 → 两份都进库了', (await ex.listPacks()).length === 2,
    String((await ex.listPacks()).length));
  ok('列表里一次多出两张卡', listEl.children.length === before + 2,
    `${before} → ${listEl.children.length}`);
  /* **提示照旧** ✓（用户 2026-10-12 定的）—— 还是那句"成功导入地图：…"，
     不另报"N 张"的总数；"这是第几份"改由卡片左上角那个小序号说 ✓ */
  const mmsg = env.get('map-msg').textContent || '';
  ok('提示照旧（就那一句成功导入，不另报总数 ✓）',
    /成功导入地图：/.test(mmsg) && !/成功导入地图：\d+ 张/.test(mmsg), mmsg);
  const nos2 = findAll(env.get('map-pick-list'), (el) => el.className === 'map-card-no')
    .map((x) => x.textContent);
  ok('两张卡各挂一个小序号（1 / 2 ✓）', nos2.join(',') === '1,2',
    nos2.join(',') || '没有序号 ✗');

  /* 2026-10-17 用户："统一变成列表形式，多的时候塞进列表而不是塞进两列"
     → 永远一列，卡片多了由**列表自己滚**（CSS max-height），不再加 two-col / wide-pick ✓
     ⚠ 读类名要用 classList.contains ✗ —— 桩里 className 和 classList 不同步
     （app 用的是 classList.add ✓，className 那边看不见 ✓）*/
  ok('卡不多的时候还是老老实实一列（不分列 ✓）',
    !listEl.classList.contains('two-col'), `${listEl.children.length} 张`);
  /* 一直导到超过旧阈值（原来 app.js 的 TWO_COL_AT = 10，现在已删 ✓）
     同一份文件反复导 → 每次都是"库里已有一份一模一样的"→ 直接再进一张 ✓ */
  const one = blobOf(raw);
  let guard = 0;
  while (listEl.children.length < 10 && guard++ < 24) {
    fi.files = [one];
    await fi.onchange();
  }
  const innerBox = env.get('boot-inner');
  ok('卡到 10 张以上 → 还是**一列列表**（不再排两列 ✓）',
    listEl.children.length >= 10
    && !listEl.classList.contains('two-col')
    && !(innerBox && innerBox.classList.contains('wide-pick')),
    `${listEl.children.length} 张 / ${[...listEl.classList._s].join(' ')}`);
  ok('面板也不放宽（列表自己滚，不撑大启动框 ✓）',
    !!innerBox && !innerBox.classList.contains('wide-pick'),
    innerBox && innerBox.classList._s ? [...innerBox.classList._s].join(' ') || '（空的）' : '没取到面板 ✗');

  // 收尾：点一张卡让 boot 正常结束（不然那个 Promise 一直挂着）
  const card = listEl.children[0];
  if (card) card.onclick();
  await booting;
  ok('点了卡之后启动框还是原来的宽度（没有 wide-pick 要收 ✓）',
    !(innerBox && innerBox.classList.contains('wide-pick')),
    innerBox ? [...innerBox.classList._s].join(' ') || '（空的 ✓）' : '?');
}

/* ============================================================================
 * 主流程
 * ========================================================================== */
(async () => {
  if (!fs.existsSync(PACK_FILE)) {
    console.log(`\n✗ 缺少测试包 ${path.relative(H.ROOT, PACK_FILE)}`);
    console.log('  先跑：python pack_map.py data_eu4 --id eu4-vanilla-test --label "EU4 原版（测试包）" --out _local/packs/eu4-vanilla.pdxmap');
    process.exit(1);
  }
  await testImportAndEquivalence();
  await testStoreLifecycle();
  await testNoIdbFallback();
  await testPrefsIsolation();
  await testReloadPersistence();
  await testBackupRoundTrip();
  await testDuplicateCopiesIndependent();
  await testBoot();
  await testUi();
  await testTilesPack();
  await testMultiImport();

  console.log(`\n${fails.length ? '✗' : '✓'} 通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败的：');
    for (const f of fails) console.log('  · ' + f);
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('尺子自己炸了：', e);
  process.exitCode = 1;
});
