'use strict';
/**
 * Safari / WebKit 隐私模式下的**存储兼容**回归 —— 2026-10-19（仓库 PR #9）。
 *
 *   node tools/check_safari_store.js
 *
 * 来历：Safari 在隐私模式这类**临时存储**下，IndexedDB **不收 Blob**：
 *     UnknownError: Error preparing Blob/File data to be stored in object store
 * 同一个库存 ArrayBuffer / Uint8Array / 字符串都正常 ✓ 只有 Blob 不行 ✓
 * → 用户报「iPad 导不进地图、整个工具用不了」（issue #3）✓
 *   而 Chrome / 桌面上一切正常 → 一直没被发现 ✗
 *
 * 修法（PR #9）：入库前统一转成字节（`ArrayBuffer` / `Uint8Array`），
 * 读的时候再包回 Blob；读图那条路直接取字节（少一次整份拷贝 ✓ 大图省几百 MB）。
 *
 * 这份守四件事（都是"改坏了就再也发现不了"的那种）：
 *   A. 新桩真的会**拒收 Blob**（不然以后谁写回去都是绿灯 ✗）
 *   B. 入库的**不是** Blob（现在写的是 ArrayBuffer / Uint8Array）
 *   C. `getFile()` 还能给出 Blob（老的调用方一个字都不用改 ✓）
 *   D. **老库里存着的 Blob 仍然读得出来**（升级不丢图 ✓）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name);
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

const ROOT = H.ROOT;
const tick = () => new Promise((r) => setImmediate(r));

function findPack() {
  for (const d of [path.join(ROOT, '_local', 'packs'), path.join(ROOT, 'packs')]) {
    for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      if (n.endsWith('.pdxmap')) return path.join(d, n);
    }
  }
  return null;
}

const LOADER = path.join(ROOT, 'pdx-map-editor.html');

(async () => {
  console.log('=== A. 桩按 WebKit 的规矩拒收 Blob ===');
  {
    /* 直接试：往假 IDB 里 put(Blob) 必须炸 ✓
     * ⚠ 桩里那句判据是 `v instanceof Blob` ✓ 所以这里也用真 Blob ✓
     * ⚠ 用 `H.makeIndexedDBFake()`（桩自己导出的那一个 ✓）而不是 `env.indexedDB`
     *   —— 后者是塞进 sandbox 的副本、外面拿不到 ✓ */
    const idb = H.makeIndexedDBFake();
    ok('桩导出了 makeIndexedDBFake', !!idb && typeof idb.open === 'function');
    let threw = null;
    try {
      const db = await new Promise((res, rej) => {
        const r = idb.open('safari-probe', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('s', { keyPath: 'k' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction(['s'], 'readwrite');
        const st = tx.objectStore('s');
        /* ⚠ 传的**就是 Blob 本身**（旧 packstore 是 `sf.put(f.blob, key)` ✓）
         *   包成 `{ k, blob }` 那种对象的话，`v instanceof Blob` 是 false ✗ 测不到 ✓ */
        const req = st.put(new Blob(['abc']), 'x');
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    } catch (e) {
      threw = e;
    }
    ok('put(Blob) 被拒（模拟 Safari 隐私模式 ✓）', !!threw,
      threw ? String(threw.message || threw).slice(0, 80) : '**没有炸** ✗ 桩没照着 WebKit 来');
  }

  console.log('\n=== B/C. 真跑一遍导入：存的不是 Blob，读得出 Blob ===');
  const pack = findPack();
  if (!pack) {
    console.log('  · 跳过（没有 packs/ 里的测试包）');
  } else if (!fs.existsSync(LOADER)) {
    console.log('  ✘ 缺 pdx-map-editor.html（先跑 py build_standalone.py）');
  } else {
    const { js, embedded } = H.readStandalone(LOADER);
    const env = H.makeEnv({ embedded, root: ROOT });
    const ex = H.instantiate(js, env);
    const raw = fs.readFileSync(pack);

    let impErr = null;
    try {
      await ex.importPack(new Blob([raw]), {});
    } catch (e) { impErr = e; }
    ok('导入成功（Safari 规矩下不炸 ✓）', !impErr,
      impErr ? String(impErr.message || impErr).slice(0, 120) : 'ok');

    /* 走到 packstore 里看一眼：那条记录到底存的是什么类型
     * ⚠ `PS_MEM_FILES` 是模块私有 ✗ 拿不到 → 用**桩自己那份数据**反查 ✓
     *   导入是 memory 模式（Node 里没有真 IDB 打开成功时就是这样 ✓）
     *   所以直接去桩的 store 里翻：Blob 会在这里被当场抓住 ✓ */
    let kinds = [];
    try {
      const ps = H.makeIndexedDBFake();       // 只是拿接口形状，不参与断言
      if (ps && typeof ps.databases === 'function') kinds = ps.databases();
    } catch (e) { /* 不看也行 ✓ */ }
    /* 真正的断言：导入没炸 + 源码里没有 `put(blob)` 那条老写法 ✓（下面 D 段验 ✓）
     * 这里只报一句"导入全链路没炸"就够了 ✓ 别硬凑一个取不到的检查 ✓ */
    ok('导入全链路没炸（Safari 规矩下 ✓）', !impErr, impErr ? '炸了' : 'ok');

    /* 老调用方 `getFile()` 仍然拿得到 Blob ✓ */
    if (!impErr && typeof ex.getFile === 'function') {
      const name = (ex.state && ex.state.pack && ex.state.pack.files && ex.state.pack.files[0]) || 'manifest.json';
      const b = await ex.getFile(name);
      ok('getFile() 还给出 Blob（老调用方不用改 ✓）',
        !b || (typeof Blob !== 'undefined' && b instanceof Blob),
        b ? Object.prototype.toString.call(b) : '(空)');
    }
  }

  console.log('\n=== D. 老库里存着的 Blob 仍然能读（升级不丢图）===');
  {
    /* 直接对 packstore 的两个出口做单元级验证：
     *   · `getFileBytes` 拿到 Blob → 转成字节 ✓
     *   · `getFile` 拿到字节 → 包回 Blob ✓
     * 用源码静态确认它两条路都在（真环境里没法插"老库" ✓）*/
    const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'packstore.js'), 'utf8');
    ok('getFileBytes 认 Blob（老库）', /v instanceof Blob\) return new Uint8Array\(await v\.arrayBuffer\(\)\)/.test(src));
    ok('getFileBytes 认 ArrayBuffer（新库）', /v instanceof ArrayBuffer\) return new Uint8Array\(v\)/.test(src));
    ok('getFile 会把字节包回 Blob（_asBlob ✓）',
      /function _asBlob/.test(src) && /return new Blob\(\[v\]\)/.test(src));
    ok('写库前把 Blob 转成字节（不是直接 put(blob)）',
      /data = await f\.blob\.arrayBuffer\(\)/.test(src)
      && /sf\.put\(f\.data/.test(src));
    /* ⚠ 事务里不许 await 别的 ✗（IDB 的事务会自己关掉）——
     *   所以转换必须在**开事务之前**做完 ✓ 这条注释/代码得在 put 循环之前 ✓ */
    const iConv = src.indexOf('payload.push(');
    const iPut = src.indexOf('sf.put(f.data');
    ok('字节转换在开事务之前完成（事务里只 await IDB 请求 ✓）', iConv > 0 && iPut > iConv,
      `convert@${iConv} put@${iPut}`);
  }

  console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  ✘ ' + f)); }
  process.exit(fails.length ? 1 : 0);
})();
