/**
 * 地图包（.pdxmap）导入端的尺子 —— 在 Node 里跑 zip.js 的读取端 + pack.js 的校验器。
 *
 *   node tools/check_pack.js
 *
 * 为什么要有它：导入端吃的是**陌生人给的文件** ✗
 *   校验器漏一条，轻则玩家导进一张坏图（画面上全是鬼东西），
 *   重则一个构造过的包把浏览器标签页直接搞崩 ✗
 *   所以每一种"坏"都要有一条断言盯着，而且**坏包在内存里现造** ✓
 *   （不往仓库里放大文件 —— 好包用 _local/packs/ 里 pack_map.py 打的那三个 ✓）
 *
 * 两段：
 *   ① 好包：pack_map.py 打出来的三个真包，必须过
 *   ② 坏包：拿一个小尺寸合成包（8×4、6 省份）逐个使坏，每一条都得被拒，
 *      而且**拒绝的话要说到点子上**（不是随便抛个错就算过 ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const H = require('./lib/browser_stub.js');

// ---------------------------------------------------------------- 沙箱
/* 只要 zip.js + pack.js：这两个模块是纯的（不碰 DOM、不碰 localStorage）✓
   拍平逻辑跟单文件版一致（import/export 那两行被剔掉）—— 顺手也验了它俩能被拍平 ✓ */
const JS = H.flattenModules(['zip.js', 'pack.js']);
const ex = new Function(
  'console', 'Blob', 'Response', 'DecompressionStream', 'TextDecoder', 'TextEncoder', 'TransformStream',
  JS + `
return { readZip, makeZip, makeZipAsync, validatePack, readManifest, Sha256, sha256Hex,
         PackError, isKnownPackFile, ZipFile,
         PACK_REQUIRED, PACK_LIMITS, PACK_GAMES, PACK_FORMAT,
         PACK_MAX_BYTES, PACK_MAX_FILE, PACK_MAX_TOTAL, PACK_MAX_ENTRIES,
         PACK_FORMAT_VERSION, PACK_SCHEMA_MIN, PACK_SCHEMA_MAX };`,
)(console, Blob, Response, DecompressionStream, TextDecoder, TextEncoder, TransformStream);

const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name);
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '   → ' + extra : ''}`);
}

const blobOf = (bytes) => new Blob([bytes]);
const u16arr = (a) => new Uint8Array(Uint8Array.from(a, (v) => v & 0xFF).buffer);
function packU16(values) {
  const out = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    out[i * 2] = values[i] & 0xFF;
    out[i * 2 + 1] = (values[i] >> 8) & 0xFF;
  }
  return out;
}

/* ============================================================================
 * ⓪ 包的规矩**同时在两个地方**：`web/js/pack.js`（收包的那头）
 *    和 `pack_map.py`（打包的那头）—— 策划里写着"改一边必须改另一边" ✓
 *    可**没有任何东西盯着它** ✗ 一边改了另一边没改，表现是
 *    "作者按脚本打的包，编辑器说格式不对"这种最让人摸不着头脑的错。
 *    所以这里把它们对一遍（都是读源码里的常量，不重写一遍规矩 ✓）
 * ========================================================================== */
function testTwoSidesAgree() {
  console.log('\n【打包脚本 vs 校验器：同一套规矩】');
  const py = fs.readFileSync(path.join(H.ROOT, 'pack_map.py'), 'utf8');
  const num = (name) => {
    const m = new RegExp('^' + name + '\\s*=\\s*([0-9][0-9\\s*]*)', 'm').exec(py);
    if (!m) return null;
    // 只允许"数字 × 数字"这种形状（别把 eval 引进来 ✓）
    return m[1].split('*').map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
  };
  const tuple = (name) => {
    const m = new RegExp(name + '\\s*=\\s*\\(([\\s\\S]*?)\\)').exec(py);
    /* ⚠ 字符类写 `[^"]` 就够 —— 别写 `[^"\\n]`：
       那是**正则字面量**，里面的 `\\n` 是"反斜杠或字母 n"，
       而 meta.json 里正好有 n → 一条都匹配不上 ✗（这条自己踩过） */
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
  };
  const dict = (name) => {
    const m = new RegExp(name + '\\s*=\\s*\\{([\\s\\S]*?)\\}').exec(py);
    if (!m) return null;
    const out = {};
    for (const x of m[1].matchAll(/"([^"]+)"\s*:\s*(\d+)/g)) out[x[1]] = Number(x[2]);
    return out;
  };

  ok('格式版本号一致（pack_map.FORMAT_VERSION = pack.js.PACK_FORMAT_VERSION）',
    num('FORMAT_VERSION') === ex.PACK_FORMAT_VERSION,
    `py ${num('FORMAT_VERSION')} / js ${ex.PACK_FORMAT_VERSION}`);
  ok('数据结构版本号在编辑器认得的范围里（pack_map.DATA_SCHEMA ∈ [MIN, MAX]）',
    num('DATA_SCHEMA') >= ex.PACK_SCHEMA_MIN && num('DATA_SCHEMA') <= ex.PACK_SCHEMA_MAX,
    `py ${num('DATA_SCHEMA')} / js ${ex.PACK_SCHEMA_MIN}~${ex.PACK_SCHEMA_MAX}`);
  /* 两边的清单**差一个 manifest.json**，这是对的 ✓：
     打包脚本那份是"要从缓存目录里搬哪些"，manifest 是它自己现写的 ✗
     校验器那份是"包里必须有什么"，manifest 当然得算 ✓
     所以比的是"js 去掉 manifest.json == py" ✓ */
  const jsReq = ex.PACK_REQUIRED.filter((n) => n !== 'manifest.json');
  ok('必需文件清单一致（包里该有的 = 打包脚本要搬的 + manifest.json）',
    JSON.stringify(tuple('REQUIRED')) === JSON.stringify(jsReq),
    `py ${(tuple('REQUIRED') || []).join(' ')} / js ${jsReq.join(' ')}`);
  ok('字段长度上限一致（LIMITS = PACK_LIMITS）',
    JSON.stringify(dict('LIMITS')) === JSON.stringify(ex.PACK_LIMITS),
    JSON.stringify(dict('LIMITS')));
  const caps = [['MAX_PACK_BYTES', ex.PACK_MAX_BYTES], ['MAX_FILE_BYTES', ex.PACK_MAX_FILE],
                ['MAX_TOTAL_RAW_BYTES', ex.PACK_MAX_TOTAL]];
  const capBad = caps.filter(([n, v]) => num(n) !== v);
  ok('体积上限一致（压缩包 / 单文件 / 合计）', capBad.length === 0,
    capBad.length ? capBad.map(([n, v]) => `${n}: py ${num(n)} vs js ${v}`).join('；')
                  : caps.map(([n]) => n).join(' · '));
}

/* ============================================================================
 * ① SHA-256 自己的尺子
 *
 * 校验器全靠它认"包是不是原来那份"。它写错了**不会报错**，
 * 只会安静地算出另一个值 → 所有包都"哈希不对" ✗ 所以先钉死它。
 * ========================================================================== */
async function testSha() {
  console.log('\n【SHA-256】');
  const vec = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ];
  for (const [input, want] of vec) {
    const got = await ex.sha256Hex(new TextEncoder().encode(input));
    ok(`sha256(${JSON.stringify(input.slice(0, 12))}${input.length > 12 ? '…' : ''})`, got === want, got.slice(0, 16) + '…');
  }
  // 一百万零个 'a'（FIPS 里的长向量）+ 分块喂 == 一次喂
  const big = new Uint8Array(1000000).fill(0x61);
  const one = new ex.Sha256().update(big).hex();
  const inc = new ex.Sha256();
  for (let i = 0; i < big.length; i += 7) inc.update(big.subarray(i, i + 7));   // 故意不对齐
  ok('sha256(1M 个 a) 对上 FIPS 向量',
    one === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0', one.slice(0, 16) + '…');
  ok('分块喂和一次喂结果相同（跨块边界）', inc.hex() === one);
  /* 导入校验优先走原生 crypto.subtle，没它才退回上面那份流式实现。
     两条路必须算出同一个值，不然同一张包在两种浏览器上一个能进一个进不去。 */
  {
    const both = await ex.sha256Hex(big);
    ok('原生 SHA-256 和自带的流式实现结果一致', both === one, both.slice(0, 16) + '…');
  }
}

/* ============================================================================
 * ② 好包：pack_map.py 打出来的真包
 * ========================================================================== */
async function testGoodPacks() {
  console.log('\n【好包：pack_map.py 打的真包】');
  const dir = path.join(H.ROOT, '_local', 'packs');
  const list = ['ck3-vanilla.pdxmap', 'eu4-vanilla.pdxmap', 'eu5-full.pdxmap'];
  let any = 0;
  for (const f of list) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) {
      console.log(`  · 跳 ${f}（没有这个文件：先跑 python pack_map.py 造一个）`);
      continue;
    }
    any++;
    const t0 = Date.now();
    try {
      const zip = await ex.readZip(blobOf(fs.readFileSync(p)));
      let lastMsg = '';
      const r = await ex.validatePack(zip, { onProgress: (m) => { lastMsg = m; } });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      ok(`${f} 通过（${r.manifest.game} · ${r.manifest.stats.numTitles} 头衔 · ${r.manifest.stats.numProvinces} 地块 · ${secs}s）`,
        !!r.manifest && r.manifest.stats.numProvinces > 0);
      ok(`${f} 读出来的是它自己的 manifest`, r.manifest.id.indexOf(f.split('.')[0]) === 0, r.manifest.id);
      ok(`${f} 头部字段解出来了`, r.meta.numProvinces === r.manifest.stats.numProvinces);
    } catch (e) {
      ok(`${f} 通过`, false, e.message);
    }
  }
  if (!any) ok('有三个测试包可验', false, '一个都没有');

  /* ---- 要发出去的那一批包（packs/，build_packs.py 打的）-------------------------
     2026-10-12 起单文件默认不内嵌地图，玩家**就是靠这些包**用的 ✓
     所以"这一批发出去的包，浏览器端每个都导得进来"得有一条尺子盯着 ✗
     （万一哪个是用旧版 pack_map.py 打的、或者半路手改过，这里会响 ✓）
     没有 packs/ 就跳过（仓库里不存这些大文件，是 build_packs.py 现打的） */
  const shipDir = path.join(H.ROOT, 'packs');
  if (fs.existsSync(shipDir)) {
    const ships = fs.readdirSync(shipDir).filter((f) => f.endsWith('.pdxmap')).sort();
    console.log(`\n【要发的包：packs/ 里 ${ships.length} 个】`);
    if (!ships.length) ok('packs/ 里有包', false, '目录是空的（跑一下 python build_packs.py）');
    for (const f of ships) {
      const p = path.join(shipDir, f);
      const t0 = Date.now();
      try {
        const zip = await ex.readZip(blobOf(fs.readFileSync(p)));
        const r = await ex.validatePack(zip, {});
        const st = r.manifest.stats;
        ok(`${f}（${(fs.statSync(p).size / 1048576).toFixed(2)} MB · ${r.manifest.game}`
          + ` · ${st.numProvinces} 地块 · ${((Date.now() - t0) / 1000).toFixed(0)}s）导得进来 ✓`,
          !!r.manifest && st.numProvinces > 0 && st.numTitles > 0);
        /* **名字和颜色也得跟着包走** ✓（2026-10-12 廿九点名要确认的：
           "国家、地区等以及他们的颜色也包含在地图包里而不是内嵌"）
           它们就在 titles.json 里 —— 每个头衔一条名字、一条颜色，条数必须跟 numTitles 对上 ✗
           颜色一律是 [r,g,b] 的 0~255 整数（量过八个缓存目录，一个例外都没有 ✓） */
        const tj = JSON.parse(await zip.text('titles.json'));
        const names = (tj.names || []).length;
        const cols = tj.colors || [];
        const badColors = cols.filter((c) => !Array.isArray(c) || c.length !== 3
          || c.some((v) => !Number.isInteger(v) || v < 0 || v > 255)).length;
        ok(`  ${f} 里带着名字 + 颜色（${names} 个名字 · ${cols.length} 条颜色）`,
          names === st.numTitles && cols.length === st.numTitles && badColors === 0,
          `名字 ${names} / 颜色 ${cols.length} / 越界颜色 ${badColors}（应该都是 ${st.numTitles}）`);
      } catch (e) {
        ok(`${f} 导得进来`, false, e.message);
      }
    }
  }
}

/* ============================================================================
 * ③ 合成包：一个 8×4 的小图，随便使坏
 * ========================================================================== */
const SYN = { W: 8, H: 4, P: 6, N: 5, T: 2 };

/**
 * 造一个合成包。over 里每一项都能把某个东西弄坏（不传就是好的）。
 * @returns {{bytes: Uint8Array, files: object}}
 */
function synth(over = {}) {
  const { W, H, P, N, T } = SYN;
  const noTitle = 65535;

  // 省份 id 图：0..P-1 轮着来
  const provIds = new Uint16Array(W * H);
  for (let i = 0; i < provIds.length; i++) provIds[i] = i % P;
  if (over.badProv) provIds[3] = over.badProv;                     // 越界的省份号

  // (省份, 层级) → 头衔号
  const tmLen = over.tmLen !== undefined ? over.tmLen : P * T;
  const titlemap = new Uint16Array(tmLen);
  for (let i = 0; i < tmLen; i++) titlemap[i] = i % N;
  if (over.badTid) titlemap[2] = over.badTid;                      // 越界的头衔号

  // 邻接表：CSR，(P+1) 个 u32 偏移 + u16 邻居
  let adjLen = (P + 1) * 4 + 4 * 2;
  if (over.adjLen !== undefined) adjLen = over.adjLen;
  const adjacency = new Uint8Array(adjLen);

  // 每省三个 float：质心 x / y / 像素数
  const posLen = over.posLen !== undefined ? over.posLen : P * 12;
  const provPos = new Uint8Array(posLen);

  const titles = {
    keys: [], tiers: [], parents: [], names: [], colors: [], provCount: [],
  };
  for (let i = 0; i < N; i++) {
    titles.keys.push('k' + i);
    titles.tiers.push(i % T);
    titles.parents.push(-1);
    titles.names.push('头衔' + i);
    titles.colors.push([10 * i, 20, 30]);
    titles.provCount.push(1);
  }
  if (over.titlesShort) titles.names.pop();                        // 少一项
  if (over.noProvCount) delete titles.provCount;                   // 少一个必需字段
  titles.provinceNames = [];
  for (let i = 0; i < P; i++) titles.provinceNames.push('p' + i);
  if (over.provNamesShort) titles.provinceNames.pop();

  const meta = {
    game: over.game || 'ck3',
    mapWidth: W, mapHeight: H,
    numProvinces: over.metaProvinces || P,
    numTitles: over.metaTitles || N,
    tiers: [], noTitle,
    generated: '2026-01-01 00:00:00',
  };
  for (let i = 0; i < T; i++) meta.tiers.push('t' + i);
  if (over.tiersLen) meta.tiers = meta.tiers.slice(0, over.tiersLen);
  if (over.metaHasRoot) meta.ck3_root = 'C:\\Steam\\steamapps\\common\\Crusader Kings III';

  const provBytes = over.provLen !== undefined ? new Uint8Array(over.provLen) : packU16(provIds);
  const tmBytes = packU16(titlemap);

  // 包里放的是**zlib 压过**的那一份（跟真包一模一样：zip 一层、zlib 一层）✓
  const bin = (raw, forceStore) => (forceStore ? raw : new Uint8Array(zlib.deflateSync(Buffer.from(raw))));

  const files = [];
  const metaText = JSON.stringify(meta);
  const titlesText = JSON.stringify(titles);
  const bins = {
    'provinces_id.bin': bin(provBytes, over.provPlain),
    'titlemap.bin': bin(tmBytes),
    'adjacency.bin': bin(adjacency),
    'prov_pos.bin': bin(provPos, over.posPlain),
  };

  // 哈希算的是**包里那一份**（zip 解完看到的字节）✓
  const hashes = {};
  const smallHash = (t) => { const h = new ex.Sha256(); h.update(new TextEncoder().encode(t)); return h.hex(); };
  const binHash = (b) => { const h = new ex.Sha256(); h.update(b); return h.hex(); };
  hashes['meta.json'] = smallHash(metaText);
  hashes['titles.json'] = smallHash(titlesText);
  for (const k of Object.keys(bins)) hashes[k] = binHash(bins[k]);

  let manifest = {
    format: over.format || ex.PACK_FORMAT,
    formatVersion: over.formatVersion || ex.PACK_FORMAT_VERSION,
    dataSchema: over.dataSchema === undefined ? ex.PACK_SCHEMA_MIN : over.dataSchema,
    id: over.id || 'synth-test',
    game: over.manifestGame || 'ck3',
    label: over.label !== undefined ? over.label : '合成测试包',
    note: '8 × 4',
    version: '1.0.0',
    author: 'test',
    license: '仅测试',
    homepage: '',
    description: '',
    stats: {
      numProvinces: over.statsProvinces || P,
      numTitles: over.statsTitles || N,
      mapWidth: W, mapHeight: H,
    },
    files: over.noHashes ? undefined : Object.assign({}, hashes),
  };
  if (over.statsMismatch) manifest.stats.numProvinces += 1;

  files.push({ name: 'meta.json', data: metaText });
  files.push({ name: 'titles.json', data: titlesText });
  for (const k of Object.keys(bins)) files.push({ name: k, data: bins[k] });

  // 分块那套（tiles.json）：几何 + 块尺寸，一条条使坏
  if (over.tiles) {
    const tw = 4, th = 2;
    const tm = {
      tileW: over.tileGeomBad ? 8 : tw, tileH: th,
      cols: over.tileColsRowsBad ? 3 : 2, rows: 2,
      mapW: W, mapH: H, files: [],
    };
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const name = `t_${r}_${c}.bin`;
        // 声明尺寸（tiles.json 里那份）和实际字节数可以分别弄坏 ✓
        const w = over.tileWrongSize && r === 1 && c === 1 ? 3 : tw;
        const rr = over.tileBadPos && r === 1 && c === 1 ? 9 : r;
        // 位置重复得**真的重复**：最后一格挪到 (1,0)，跟前面那块撞上 ✓
        const cc = over.tileDupPos && r === 1 && c === 1 ? 0 : c;
        tm.files.push({ r: rr, c: cc, name, w, h: th });
        const raw = new Uint8Array(
          over.tileDataBad && r === 1 && c === 1 ? tw * th * 2 - 2 : tw * th * 2);
        const body = bin(raw);
        files.push({ name: `tiles/${name}`, data: body });
        if (manifest.files) manifest.files[`tiles/${name}`] = binHash(body);
      }
    }
    if (over.tileUnlisted) tm.files.pop();
    if (over.tileNotInZip) tm.files.push({ r: 9, c: 9, name: 't_missing.bin', w: tw, h: th });
    const tmText = JSON.stringify(tm);
    files.push({ name: 'tiles.json', data: tmText });
    if (manifest.files) manifest.files['tiles.json'] = smallHash(tmText);
  }

  if (over.preview) {
    const body = over.preview === 'svg'
      ? new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
      : new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
    files.push({ name: 'preview.jpg', data: body });
    if (manifest.files) manifest.files['preview.jpg'] = binHash(body);
  }

  if (over.unknownFile) files.push({ name: 'evil.exe', data: 'x' });
  if (over.traversal) files.push({ name: '../evil.txt', data: 'x' });
  if (over.dupName) files.push({ name: 'meta.json', data: metaText });

  if (over.posChanged) {
    /* 顺序要紧：等哈希都算完了、**再**把内容改掉 ✓
       模拟"文件被改过，但 manifest 里的哈希还是旧的"——
       反过来的话哈希跟着一起更新，这条用例就白测了 ✗（第一版就是这么错的） */
    for (let i = 0; i < files.length; i++) {
      if (files[i].name === 'prov_pos.bin') {
        const raw = zlib.inflateSync(Buffer.from(files[i].data));
        raw[0] = (raw[0] + 1) & 0xFF;
        files[i] = { name: 'prov_pos.bin', data: new Uint8Array(zlib.deflateSync(raw)) };
      }
    }
  }

  // 有哈希清单就必须列全：这里把新加的、没进 hashes 的东西补上
  if (manifest.files && !over.leaveUnhashed) {
    for (const f of files) {
      if (f.name === 'manifest.json') continue;
      if (manifest.files[f.name] === undefined) {
        const bytes = typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data;
        manifest.files[f.name] = binHash(bytes);
      }
    }
  }
  // 故意漏 / 故意多 —— **必须在补全之后**，不然补全那一遍又给加回去了 ✗（同一条踩过两次）
  if (over.dropHash) delete manifest.files[over.dropHash];
  if (over.extraHash) manifest.files['ghost.bin'] = 'a'.repeat(64);

  /* manifest **最后**再拼进去，拼完再按 dropFile 删 ——
     先删后拼的话，删掉 manifest 那一次会被这一行又拼回来 ✗（这条踩过） */
  const all = [{ name: 'manifest.json', data: JSON.stringify(manifest) }]
    .concat(files.filter((f) => f.name !== 'manifest.json'));
  const finalFiles = over.dropFile ? all.filter((f) => f.name !== over.dropFile) : all;

  return { bytes: ex.makeZip(finalFiles), files: finalFiles };
}

/* ---------- 小型独立解析器：用来给手工坏的包打补丁（顺便交叉验 makeZip 的布局） ---------- */
function cdList(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('测试脚手架：找不到 EOCD');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const list = [];
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('测试脚手架：中央目录读不动');
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    list.push({
      name: Buffer.from(buf.subarray(p + 46, p + 46 + nlen)).toString('utf8'),
      at: p, lho: dv.getUint32(p + 42, true),
    });
    p += 46 + nlen + elen + clen;
  }
  return { list, eocd, dv };
}

function patch(bytes, fn) {
  const buf = Uint8Array.from(bytes);
  const { list, eocd, dv } = cdList(buf);
  fn(buf, dv, list, eocd);
  return buf;
}

/** 一条坏包：造 → 改 → 必须被拒，而且理由里要带上 want 里的关键词 */
async function bad(label, build, want) {
  let bytes;
  try {
    bytes = build();
  } catch (e) {
    ok(label, false, '测试自己造包就炸了：' + e.message);
    return;
  }
  try {
    const zip = await ex.readZip(blobOf(bytes));
    await ex.validatePack(zip, {});
    ok(label, false, '居然通过了（该拒的没拒）');
  } catch (e) {
    const msg = String(e && e.message || e);
    const hit = (want || []).every((w) => msg.indexOf(w) >= 0);
    ok(label, hit, (hit ? '' : '理由不对：') + msg);
  }
}

async function testBadPacks() {
  console.log('\n【坏包：一个一个使坏】');

  // 先确认合成的"好包"本身是过的 —— 不然下面全是假阳性 ✗
  {
    const zip = await ex.readZip(blobOf(synth().bytes));
    try {
      await ex.validatePack(zip, {});
      ok('合成包（不改）通过', true);
    } catch (e) {
      ok('合成包（不改）通过', false, e.message);
    }
  }

  // ---- manifest 层
  await bad('缺 manifest.json', () => synth({ dropFile: 'manifest.json' }).bytes, ['manifest']);
  await bad('format 不对', () => synth({ format: 'zipmod' }).bytes, ['format']);
  await bad('formatVersion 太新', () => synth({ formatVersion: 9 }).bytes, ['更新编辑器']);
  await bad('dataSchema 太旧', () => synth({ dataSchema: 0 }).bytes, ['dataSchema']);
  await bad('dataSchema 太新', () => synth({ dataSchema: 99 }).bytes, ['更新编辑器']);
  await bad('game 不认识', () => synth({ manifestGame: 'ck9' }).bytes, ['game']);
  await bad('id 不合法', () => synth({ id: 'KR 地图' }).bytes, ['id']);
  await bad('label 超长', () => synth({ label: 'x'.repeat(41) }).bytes, ['label', '太长']);

  // ---- 文件层
  await bad('缺 titles.json', () => synth({ dropFile: 'titles.json' }).bytes, ['titles.json']);
  await bad('缺 prov_pos.bin', () => synth({ dropFile: 'prov_pos.bin' }).bytes, ['prov_pos.bin']);
  await bad('包里混了不认识的文件', () => synth({ unknownFile: true }).bytes, ['不该有']);
  await bad('路径穿越（../evil.txt）', () => synth({ traversal: true }).bytes, ['不干净']);
  await bad('重名条目', () => synth({ dupName: true }).bytes, ['重名']);
  await bad('不是 zip', () => new TextEncoder().encode('这不是 zip，是一段话'), ['zip']);
  await bad('截断的 zip', () => synth().bytes.slice(0, 40), ['没找到结尾记录']);
  await bad('zip64 标记', () => patch(synth().bytes, (b, dv, l, eocd) => {
    dv.setUint32(eocd + 16, 0xFFFFFFFF, true);
  }), ['zip64']);
  await bad('加密条目', () => patch(synth().bytes, (b, dv, l) => {
    for (const e of l) { dv.setUint16(e.at + 8, 1, true); dv.setUint16(e.lho + 6, 1, true); }
  }), ['加密']);

  // ---- 哈希 / 一致性
  await bad('某文件内容改了一点（哈希对不上）', () => synth({ posChanged: true }).bytes, ['sha256', '对不上']);
  await bad('manifest.files 里漏了一个文件', () => synth({ dropHash: 'prov_pos.bin' }).bytes, ['漏了']);
  await bad('manifest.files 里写了不存在的文件', () => synth({ extraHash: true }).bytes, ['包里没有']);
  await bad('meta 和 manifest.stats 对不上', () => synth({ metaProvinces: SYN.P + 1 }).bytes, ['不一致']);
  await bad('meta.game 和 manifest.game 对不上', () => synth({ game: 'eu4' }).bytes, ['对不上']);

  // ---- 长度公式 / 内容范围
  await bad('provinces_id 长度不对', () => synth({ provLen: SYN.W * SYN.H * 2 - 2 }).bytes, ['provinces_id.bin']);
  await bad('provinces_id 里有越界省份号', () => synth({ badProv: 999 }).bytes, ['省份号', '999']);
  await bad('titlemap 长度不对', () => synth({ tmLen: SYN.P * SYN.T + 2 }).bytes, ['titlemap.bin']);
  await bad('titlemap 里有越界头衔号', () => synth({ badTid: 999 }).bytes, ['头衔号', '999']);
  await bad('prov_pos 长度不对', () => synth({ posLen: 10 }).bytes, ['prov_pos.bin']);
  await bad('adjacency 长度对不上 CSR', () => synth({ adjLen: (SYN.P + 1) * 4 + 3 }).bytes, ['adjacency.bin']);

  // ---- titles.json 的数组
  await bad('titles.json 少一个必需字段', () => synth({ noProvCount: true }).bytes, ['provCount']);
  await bad('titles.json 数组长度不对', () => synth({ titlesShort: true }).bytes, ['names']);
  await bad('provinceNames 长度不对', () => synth({ provNamesShort: true }).bytes, ['provinceNames']);

  // ---- 分块（tiles.json）：几何 / 块尺寸 / 位置，一条条来
  await bad('tiles.json 里列了包里没有的块', () => synth({ tiles: true, tileNotInZip: true }).bytes, ['没有']);
  await bad('包里的块没写进 tiles.json', () => synth({ tiles: true, tileUnlisted: true }).bytes, ['没写进']);
  await bad('块的声明尺寸和块尺寸不一致', () => synth({ tiles: true, tileWrongSize: true }).bytes, ['块尺寸']);
  await bad('块的实际字节数不对', () => synth({ tiles: true, tileDataBad: true }).bytes, ['字节']);
  await bad('tiles.json 的 cols×rows 和块数对不上', () => synth({ tiles: true, tileColsRowsBad: true }).bytes, ['只列了']);
  await bad('tiles.json 的块尺寸凑不出整张图', () => synth({ tiles: true, tileGeomBad: true }).bytes, ['凑不出整张图']);
  await bad('块的位置超出 cols/rows 范围', () => synth({ tiles: true, tileBadPos: true }).bytes, ['超出']);
  await bad('两块写着同一个位置', () => synth({ tiles: true, tileDupPos: true }).bytes, ['位置重复', '都写着']);
  {
    const zip = await ex.readZip(blobOf(synth({ tiles: true }).bytes));
    try {
      await ex.validatePack(zip, {});
      ok('分块包（几何都对）通过', true);
    } catch (e) {
      ok('分块包（几何都对）通过', false, e.message);
    }
  }

  // ---- 没有哈希清单的包：也要能过（只是跳过核对，并在 onNote 里说一声）
  {
    const notes = [];
    const zip = await ex.readZip(blobOf(synth({ noHashes: true }).bytes));
    try {
      await ex.validatePack(zip, { onNote: (m) => notes.push(m) });
      ok('没给 manifest.files 的包也能导入（跳过 sha256 核对）',
        notes.some((m) => /跳过 sha256/.test(m)), notes.join(' / ') || '（一句提示都没有）');
    } catch (e) {
      ok('没给 manifest.files 的包也能导入（跳过 sha256 核对）', false, e.message);
    }
    // 但"给了却漏列一个文件"必须拒（不然改个没列进去的文件就绕过这道了）
    await bad('给了哈希清单却漏列文件 → 拒', () => synth({ dropHash: 'prov_pos.bin' }).bytes, ['漏了']);
  }

  // ---- 预览图
  await bad('预览图是 SVG（冒充 jpg）', () => synth({ preview: 'svg' }).bytes, ['JPEG', 'PNG']);
  {
    const zip = await ex.readZip(blobOf(synth({ preview: 'png' }).bytes));
    try {
      await ex.validatePack(zip, {});
      ok('预览图是正常 PNG → 过', true);
    } catch (e) {
      ok('预览图是正常 PNG → 过', false, e.message);
    }
  }

  // ---- 声明值撒谎（炸弹）
  await bad('声明值大到离谱（>512 MB）', () => patch(synth().bytes, (b, dv, l) => {
    const e = l.find((x) => x.name === 'provinces_id.bin');
    dv.setUint32(e.at + 24, 600 * 1024 * 1024, true);
    dv.setUint32(e.lho + 22, 600 * 1024 * 1024, true);
  }), ['超过单文件上限']);

  /* 真·压缩炸弹：内容其实是一个膨胀到 520 MB 的 zlib 流，
     但中央目录里**谎报**成 1000 字节 —— 声明值挡不住它，必须靠流里数出来的实际值 ✓
     （520 MB 的零串，压完才几百 KB；这是唯一一条要吃内存的用例） */
  {
    const bombRaw = zlib.deflateSync(Buffer.alloc(520 * 1024 * 1024));
    const good = synth();
    // 把 prov_pos.bin 换成炸弹（长度检查在 cap 之后，所以它到不了那一步）
    const files = [];
    const { list } = cdList(good.bytes);
    for (const e of list) files.push({ name: e.name, data: readEntry(good.bytes, e) });
    const i = files.findIndex((f) => f.name === 'prov_pos.bin');
    files[i] = { name: 'prov_pos.bin', data: new Uint8Array(bombRaw) };
    await bad('压缩炸弹（谎报 1000 字节，实际 520 MB）',
      () => patch(ex.makeZip(files), (b, dv, l) => {
        const e = l.find((x) => x.name === 'prov_pos.bin');
        dv.setUint32(e.at + 24, 1000, true);
        dv.setUint32(e.lho + 22, 1000, true);
      }), ['超过上限']);
  }

  // ---- 混合：zip 里再 deflate 一层（有些打包工具会这么干）
  {
    const p = synth();
    const files = [];
    const { list } = cdList(p.bytes);
    for (const e of list) files.push({ name: e.name, data: readEntry(p.bytes, e) });
    const zip = await ex.readZip(blobOf(await ex.makeZipAsync(files)));
    try {
      // makeZipAsync 对 <4KB 还是 store，但 .bin 有 64~100 字节也走 store —— 这条只是别炸就行 ✓
      await ex.validatePack(zip, {});
      ok('重新打一遍（双层压缩的另一种组合）也能读', true);
    } catch (e) {
      ok('重新打一遍（双层压缩的另一种组合）也能读', false, e.message);
    }
  }
}

/** 从构造好的 zip 里取一条的原始字节（测试脚手架用） */
function readEntry(bytes, e) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nlen = dv.getUint16(e.lho + 26, true), elen = dv.getUint16(e.lho + 28, true);
  const csize = dv.getUint32(e.at + 20, true);
  const method = dv.getUint16(e.at + 10, true);
  const start = e.lho + 30 + nlen + elen;
  const body = bytes.subarray(start, start + csize);
  return method === 0 ? body : zlib.inflateRawSync(Buffer.from(body));
}

/* ============================================================================
 * 主流程
 * ========================================================================== */
(async () => {
  testTwoSidesAgree();
  await testSha();
  await testGoodPacks();
  await testBadPacks();

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
