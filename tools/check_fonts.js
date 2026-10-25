'use strict';
/**
 * 导入字体 —— 回归自检（2026-10-20 ✓ 用户要求）
 *
 *   node tools/check_fonts.js
 *
 * 用户原话："给地名或势力名允许导入并选择字体。导入的字体存在本地，要用的时候随时切换"
 *
 * 这份盯四件事：
 *  A. **入库一定是 ArrayBuffer** ✗ Blob 在 Safari 隐私模式下会被 IndexedDB 拒收
 *     （2026-10-19 真机踩过：Error preparing Blob/File data ... ✓ 见 PR #9）
 *  B. 存进去 / 读出来 / 删掉，都真的能过
 *  C. 标签层的**缓存键要带字体** —— 不然换字体之后画面还是旧字形，
 *     看着就像"导入了没生效" ✗
 *  D. 界面上那五样（两个下拉 + 导入 + 删除 + 隐藏的 file input）都在，
 *     而且 app 里真的接上了 ✓
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/browser_stub.js');

const ROOT = H.ROOT;
const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name);
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

const SRC_FONTS = fs.readFileSync(path.join(ROOT, 'web', 'js', 'fonts.js'), 'utf8');
const SRC_LABELS = fs.readFileSync(path.join(ROOT, 'web', 'js', 'labels.js'), 'utf8');
const SRC_APP = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.js'), 'utf8');
const SRC_HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const SRC_BUILD = fs.readFileSync(path.join(ROOT, 'build_standalone.py'), 'utf8');

/** 把 fonts.js 当普通脚本跑起来（拍平：去掉 export ✓）—— 跟单文件版一个路数 */
function loadFonts(opt) {
  const o = opt || {};
  const body = SRC_FONTS.split('\n').map((l) => l.replace(/^export\s+/, '')).join('\n');
  const idb = H.makeIndexedDBFake();
  /* 🔴 **要能造一个"有 FontFace 的浏览器"** ✗✗（2026-10-20 ✓）
   *   默认（`new FontFace` 不存在）时 `_register` 第一行就返回 false ✓
   *   于是"注册那一段"永远跑不到 —— 里面写错个函数名也发现不了 ✓
   *   用户真机上就是这么炸的：`ReferenceError: familyOf is not defined` ✓
   *   所以这支自检要能把假 FontFace 递进去，逼那段代码真的跑一遍 ✓ */
  let FontFaceImpl = undefined;
  const fakeFonts = { _set: new Set(), add(f) { this._set.add(f); }, delete(f) { this._set.delete(f); } };
  const fakeDoc = { fonts: o.withFontFace ? fakeFonts : null };
  if (o.withFontFace) {
    FontFaceImpl = class FakeFontFace {
      constructor(family, src) { this.family = family; this.src = src; this.status = 'unloaded'; }
      async load() { this.status = 'loaded'; return this; }
    };
  }
  const fn = new Function('indexedDB', 'document', 'FontFace', body + `
    return { fontLibList, fontLibAdd, fontLibAddBitmap, fontLibRecord, fontLibRemove,
             fontLibFamily, fontLibLoadAll, fontLibReady, _resetForTest };`);
  const api = fn(idb, fakeDoc, FontFaceImpl);
  api._fakeFonts = fakeFonts;
  return api;
}

/** bitmapfont.js 单独跑一份（它不依赖 DOM 也能解析 / 解码 ✓） */
function loadBitmap() {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'bitmapfont.js'), 'utf8');
  const body = src.split('\n').map((l) => l.replace(/^export\s+/, '')).join('\n');
  return new Function(body + '\nreturn { parseFnt, ddsInfo, decodeRect, decodeDDS, BitmapFont, layoutRun };')();
}

(async () => {
  console.log('=== A. 入库只收 ArrayBuffer（Blob 在 Safari 上会炸）===');
  {
    ok('fonts.js 里明确写着"不要 Blob"（注释留了来历 ✓）',
      /Blob/.test(SRC_FONTS) && /UnknownError|privacy|隐私/.test(SRC_FONTS));
    ok('入库前检查了 `bytes instanceof ArrayBuffer`',
      /if \(!\(bytes instanceof ArrayBuffer\)\)/.test(SRC_FONTS));
    /* 老记录是 Blob 的话也要读得出来 ✓（升级兼容） */
    ok('读的时候兼容老的 Blob 记录 ✓',
      /rec\.bytes instanceof Blob/.test(SRC_FONTS) && /arrayBuffer\(\)/.test(SRC_FONTS));
  }

  console.log('\n=== B. 存 / 读 / 删（假 IndexedDB 上真跑一遍）===');
  {
    const F = loadFonts();
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer;

    /* 传 Blob 必须当场拒 ✗（这条就是防 Safari 那个坑）*/
    let threw = null;
    try { await F.fontLibAdd('坏字体', new Blob([bytes])); } catch (e) { threw = e; }
    ok('拿 Blob 去入库会被挡下来（不然 Safari 上丢图 ✓）', !!threw,
      threw ? String(threw.message).slice(0, 50) : '居然收了 ✗');

    const rec = await F.fontLibAdd('测试字体', bytes);
    ok('ArrayBuffer 入库成功', !!rec && !!rec.id, rec && rec.id);
    ok('族名格式对（PDX-Font-xxx，别跟系统字体撞 ✓）',
      rec && F.fontLibFamily(rec.id) === 'PDX-Font-' + rec.id, rec && F.fontLibFamily(rec.id));
    ok('没有 FontFace 的环境下不炸（老浏览器 ✓）', rec && rec.ok === false);

    const list = await F.fontLibList();
    ok('列表里能看到它', list.length === 1 && list[0].id === rec.id,
      list.map((x) => x.name + '/' + x.size).join(','));

    /* 🔴 **位图字体也要能存能读**（2026-10-20 ✓ 用户："位图字体根本无法导入"）
     *   一份 fnt 文本 + 一份 dds 字节，两个都得进库、读回来还是原样 ✓ */
    const fntText = [
      'info face="TestFace" size=16 bold=0 italic=0',
      'common lineHeight=16 base=12 scaleW=64 scaleH=64 pages=1',
      'char id=65 x=0 y=0 width=8 height=12 xoffset=0 yoffset=2 xadvance=9 page=0',
    ].join('\n');
    const nblk = (64 / 4) * (64 / 4);
    const dds = new ArrayBuffer(128 + nblk * 16);
    const dvv = new DataView(dds);
    dvv.setUint32(0, 0x20534444, true);
    dvv.setUint32(12, 64, true);
    dvv.setUint32(16, 64, true);
    dvv.setUint32(80, 0x4, true);
    'DXT5'.split('').forEach((c, i) => dvv.setUint8(84 + i, c.charCodeAt(0)));

    const brec = await F.fontLibAddBitmap('位图测试', fntText, dds);
    ok('位图字体入库成功', !!brec && !!brec.id, brec && brec.id);
    const blist = await F.fontLibList();
    const bItem = blist.find((x) => x.id === brec.id);
    ok('列表里标着 kind=bitmap（别当成 TTF ✗）', !!bItem && bItem.kind === 'bitmap',
      bItem && bItem.kind);

    const got = await F.fontLibRecord(brec.id);
    ok('能把整条记录读回来（fnt 文本 + dds 字节 ✓）',
      !!got && typeof got.fnt === 'string' && got.fnt === fntText
      && got.bytes instanceof ArrayBuffer && got.bytes.byteLength === dds.byteLength,
      got ? `${got.fnt ? got.fnt.length : 0} 字符 / ${got.bytes ? got.bytes.byteLength : 0} 字节` : '没有');

    /* 拿读回来的记录造字体 —— 这步过了，"导入 → 能用"整条链就是通的 ✓ */
    const BM = loadBitmap();
    const bf2 = new BM.BitmapFont(got.fnt, got.bytes);
    ok('读回来就能直接造出可用字体 ✓', bf2.ok === true, String(bf2.ok));
    ok('dds 头认对了（64×64 / DXT5 ✓）',
      !!bf2.info && bf2.info.width === 64 && bf2.info.format === 'DXT5',
      bf2.info ? `${bf2.info.width}×${bf2.info.height} ${bf2.info.format}` : '没有');

    let threwBm = null;
    try { await F.fontLibAddBitmap('缺一半', fntText, new Blob([dds])); } catch (e) { threwBm = e; }
    ok('位图字体的 dds 拿 Blob 也会当场被拒 ✓', !!threwBm,
      threwBm ? String(threwBm.message).slice(0, 40) : '居然收了 ✗');

    await F.fontLibRemove(brec.id);

    await F.fontLibRemove(rec.id);
    const list2 = await F.fontLibList();
    ok('删掉之后列表空了', list2.length === 0, `${list2.length} 个`);

    let threw2 = null;
    try { await F.fontLibLoadAll(); } catch (e) { threw2 = e; }
    ok('空库 loadAll 不炸 ✓', !threw2, threw2 ? String(threw2.message) : 'ok');
  }

  console.log('\n=== B2. 真注册一遍（有 FontFace 的浏览器）===')
  {
    /* 🔴 这一段是补上一个**漏网之鱼**（2026-10-20 真机炸的）：
     *   `_register()` 里当时还写着改名前的 `familyOf(id)` →
     *   一走到那就 ReferenceError，所有 TTF 都注册不上 ✓
     *   可默认那支自检里没有 FontFace，`_register` 第一行就返回了 ✗
     *   → 这里造一个假 FontFace，逼那段代码真的执行 ✓ */
    const F2 = loadFonts({ withFontFace: true });
    const bytes = new Uint8Array([0, 1, 2, 3]).buffer;
    let err = null, rec = null;
    try { rec = await F2.fontLibAdd('真字体', bytes); } catch (e) { err = e; }
    ok('有 FontFace 时入库不炸（改名后内部调用没跟着改的坑 ✓）', !err,
      err ? String(err.message) : 'ok');
    ok('注册成功了（ok=true ✓）', rec && rec.ok === true, rec && String(rec.ok));
    ok('document.fonts 里真的多了那一套 ✓',
      F2._fakeFonts._set.size === 1, `${F2._fakeFonts._set.size} 套`);
    const face = [...F2._fakeFonts._set][0];
    ok('注册用的族名 = fontLibFamily(id) ✓',
      face && face.family === F2.fontLibFamily(rec.id), face && face.family);
    ok('fontLibReady() 认得出它 ✓', F2.fontLibReady(rec.id) === true);

    /* 删掉之后要从 document.fonts 里撤走 ✓（不然重导同名会拿到旧的） */
    await F2.fontLibRemove(rec.id);
    ok('删掉之后 document.fonts 也撤了 ✓', F2._fakeFonts._set.size === 0,
      `${F2._fakeFonts._set.size} 套`);
  }

  console.log('\n=== C. 换字体之后缓存不能串（否则看着像没生效）===');
  {
    ok('fontFor 按「字号 + 哪一类」缓存（两套字体各一份 ✓）',
      /function fontFor\(size, kind\)/.test(SRC_LABELS) && /size\.toFixed\(1\) \+ '\|' \+ \(kind/.test(SRC_LABELS));
    /* 🔴 2026-10-20 用户报"字体选择根本没生效" —— 根因就是**键里只有 kind、没有字体本身** ✗
     *   现在统一走 fontTag(kind)，把族名 / 位图实例号都编进去了 ✓ */
    ok('有个 fontTag() 专门产「字体身份」（族名 + 位图实例号 ✓）',
      /function fontTag\(kind\)/.test(SRC_LABELS)
      && /FONT_FACE\[k\]/.test(SRC_LABELS) && /'b' \+ bf\.uid/.test(SRC_LABELS));
    ok('量宽的缓存键带上了字体身份 ✓',
      /const key = size\.toFixed\(1\) \+ '\\u0000' \+ fontTag\(kind\)/.test(SRC_LABELS));
    ok('字形贴图的缓存键也带上了字体身份 ✓', /const fk = fontTag\(kind\);/.test(SRC_LABELS));
    ok('两类各存各的（`FONT_FACE.place` / `.power` ✓）',
      /FONT_FACE = \{ place: '', power: '' \}/.test(SRC_LABELS));
    ok('默认字体栈还在（导入的字体缺字时会退回去 ✓）',
      /function stackOf\(kind\)/.test(SRC_LABELS) && /FONT_STACK/.test(SRC_LABELS));
    /* 绘制时按"每个标自己的类别"分：国名 / 玩家名 → 势力名，其余 → 地块名 ✓
     * ⚠ 2026-10-22 起不再只看桶键里的层 ✗ —— 年份层的国名是从"普通头衔点"
     *   那条路来的（层号是 0，跟地名一样 ✓），只看层号会把国名当成地块名 ✓
     *   现在 `_kind[]` 按 `tier < nEra || layer === 2` 记，画的时候直接取 ✓ */
    ok('绘制时按每个标自己的类别挑字体（`_kind` ✓）',
      /const kind = KINDS\[k\] \|\| \(layer >= 1 \? 'power' : 'place'\)/.test(SRC_LABELS)
      && /KINDS\[n\] = kind;/.test(SRC_LABELS));
  }

  console.log('\n=== D. 界面和接线 ===');
  {
    for (const id of ['set-font-place', 'set-font-power', 'btn-font-import', 'btn-font-del', 'font-file']) {
      ok(`页面上有 #${id}`, SRC_HTML.includes(`id="${id}"`));
    }
    ok('file input 只收字体格式（ttf/otf/woff/woff2 ✓）',
      /id="font-file"[\s\S]{0,200}accept="[^"]*\.ttf/.test(SRC_HTML));
    ok('app 里接了 bindFontPicker ✓', /bindFontPicker\(\)/.test(SRC_APP));
    ok('选完字体真的推到标签层（setLabelFont ✓）',
      /setLabelFont\('place'/.test(SRC_APP) && /setLabelFont\('power'/.test(SRC_APP));
    ok('选择会落盘（fontFacePlace / fontFacePower 进了设置 ✓）',
      /fontFacePlace: ''/.test(SRC_APP) && /fontFacePower: ''/.test(SRC_APP) && /scheduleSave\(\)/.test(SRC_APP));
    ok('导入时取的是 arrayBuffer（不是把 File 直接塞进库 ✗）',
      /await g\.other\.arrayBuffer\(\)/.test(SRC_APP) && /await (g|o)\.dds\.arrayBuffer\(\)/.test(SRC_APP));
    /* 🔴 **多页字体**（2026-10-20 ✓ 用户：CN_mapfont_0/1 要合一起才全） */
    ok('同一个 face 的几页会合并成一个字体 ✓',
      /_faceOf/.test(SRC_APP) && /pages\.push\(\{ fnt: t, dds:/.test(SRC_APP));
    ok('库记录里存 pages 数组（老的单页字段也留着 ✓）',
      /kind: 'bitmap', pages,/.test(SRC_FONTS) && /fnt: pages\[0\]\.fnt, bytes: pages\[0\]\.dds/.test(SRC_FONTS));
    ok('BitmapFont 能跨页找字（_find ✓）',
      (() => { const bm = require('fs').readFileSync('web/js/bitmapfont.js', 'utf8');
        return /this\.pages = \[\]/.test(bm) && /for \(const pg of this\.pages\)/.test(bm); })());

    ok('字体名拼进 innerHTML 前转义了（用户给的文件名 ✓）',
      /const esc = \(s\) =>/.test(SRC_APP));
    ok('打包清单里有 fonts.js（单文件版才带得上 ✓）',
      /MODULES\s*=\s*\([^)]*"fonts\.js"/.test(SRC_BUILD));
  }

  console.log('\n=== E. 位图字体（EU4 汉化那种 .fnt + .dds）===');
  {
    const SRC_BM = fs.readFileSync(path.join(ROOT, 'web', 'js', 'bitmapfont.js'), 'utf8');
    ok('位图字体模块在（web/js/bitmapfont.js）✓', SRC_BM.length > 2000, `${SRC_BM.length} 字节`);
    ok('解析的是 BMFont 文本格式（info / common / char 三段 ✓）',
      /line\.startsWith\('info '\)/.test(SRC_BM) && /line\.startsWith\('char '\)/.test(SRC_BM));
    ok('认 DXT1 / DXT5 块压缩 ✓',
      /fourCC === 'DXT1'/.test(SRC_BM) && /fourCC === 'DXT5'/.test(SRC_BM));
    /* 🔴 **DXT3 也要认** ✗✗（2026-10-20 真机报的："字体里面那个选中会退回默认"）
     *   字体库里「简中地图字体-颜真卿多宝塔碑体」就是 DXT3（6400×4800）
     *   只写 DXT1/DXT5 的话，`ddsInfo` 返回 null → 一选中就退回默认 ✓ */
    ok('认 DXT3（BC2，每像素 4 位 alpha ✓）',
      /fourCC === 'DXT3'/.test(SRC_BM) && /isDXT3/.test(SRC_BM) && /nib \* 17/.test(SRC_BM));

    /* 造一块 DXT3 真解一遍：alpha 半字节 0xF → 255，0x0 → 0 ✓ */
    {
      const bm = loadBitmap();
      const bytes = new ArrayBuffer(128 + 16);
      const dv2 = new DataView(bytes);
      dv2.setUint32(0, 0x20534444, true);
      dv2.setUint32(12, 4, true);
      dv2.setUint32(16, 4, true);
      dv2.setUint32(80, 0x4, true);
      'DXT3'.split('').forEach((c, i) => dv2.setUint8(84 + i, c.charCodeAt(0)));
      // alpha 8 字节：前 4 个像素全亮(0xF)，后 4 个全灭(0x0)
      dv2.setUint8(128, 0xFF);
      dv2.setUint8(129, 0xFF);
      dv2.setUint8(130, 0x00);
      dv2.setUint8(131, 0x00);
      for (let i = 132; i < 136; i++) dv2.setUint8(i, 0);
      const info3 = bm.ddsInfo(bytes);
      ok('DXT3 的头认得出来（ddsInfo 不再返回 null ✓）',
        !!info3 && info3.format === 'DXT3' && info3.blockBytes === 16,
        info3 ? info3.format : 'null');
      const r3 = bm.decodeRect(bytes, info3, 0, 0, 4, 4);
      ok('DXT3 的 alpha 解对了（0xF→255、0x0→0 ✓）',
        !!r3 && r3.rgba[3] === 255 && r3.rgba[(4 * 2 + 0) * 4 + 3] === 0,
        r3 ? `${r3.rgba[3]} / ${r3.rgba[(4 * 2) * 4 + 3]}` : 'null');
    }
    /* 🔴 最要紧的一条：**不许整张解码** —— 地图字体整解 187 MB ✗ */
    ok('按字懒解（decodeRect 只解盖住那块的那些块 ✓）',
      /export function decodeRect/.test(SRC_BM) && /bx0 = Math\.floor\(rx \/ 4\)/.test(SRC_BM));
    ok('字形在 alpha 通道（DXT5 的 alpha 那一块 ✓）',
      /alpha\[i\] = aPal\[v & 7\]/.test(SRC_BM));
    ok('每个字只铸一次小 canvas（_glyphs 缓存 ✓）',
      /this\._glyphs = new Map\(\)/.test(SRC_BM));
    /* 🔴 **描边必须是 alpha 膨胀，不是把字形复制几遍** ✗✗
     *   2026-10-20 ✓ 用户："他的描边方式是把字的每个偏旁复制到原本位置的上下左右，非常诡异"
     *   老版就是偏移 4 次各画一遍 —— 笔画挨着的地方立刻变成四条重影 ✓
     *   新版：邻域取最大 alpha 长出实心外扩，再用描边色填 ✓ */
    ok('描边走 alpha 膨胀（_outlineFor ✓）',
      /_outlineFor\(g, strokeColor, r\)/.test(SRC_BM) && /邻域取最大 alpha/.test(SRC_BM));
    ok('老的「偏移 4 次」那套已经拆掉了 ✓',
      !/const offs = \[\[-1, 0\], \[1, 0\], \[0, -1\], \[0, 1\]\]/.test(SRC_BM));
    ok('膨胀半径按**字形像素**算，且取一半（跟"偏移 4 次"视觉粗细对齐 ✓）',
      /Math\.ceil\(outline \/ Math\.max\(scale, 0\.001\) \/ 2/.test(SRC_BM));
    ok('描边层比字形大一圈（往外扩 r，绘制原点也挪 r ✓）',
      /\(g\.w \+ r \* 2\) \* scale/.test(SRC_BM) && /\(g\.xoff - r\) \* scale/.test(SRC_BM));
    /* 🔴 逐字贴（版图贴合）那条路也**必须**走同一个换算 ✗✗
     *   2026-10-23 用户："导入的 TFR 字体，放大之后描边放大 N 多倍" ——
     *   `drawGlyph` 当时直接拿屏幕像素当半径，放大后每个字变成一块黑方砖 ✓ */
    const _radUses = (SRC_BM.match(/_outlineRadius\(scale, outline\)/g) || []).length;
    ok('逐字贴也用同一套半径换算（drawGlyph → _outlineRadius ✓）', _radUses >= 2,
      _radUses + ' 处');

    /* 真渲染：拿一段字排版，核对落点 / 前进宽度 ✓ 不碰 canvas */
    const F = new Function(
      SRC_BM.split('\n').map((l) => l.replace(/^export\s+/, '')).join('\n')
      + '\nreturn { parseFnt, ddsInfo, decodeRect, BitmapFont, layoutRun };')();

    const fnt = [
      'info face="TestFace" size=16 bold=0 italic=0',
      'common lineHeight=16 base=12 scaleW=64 scaleH=64 pages=1',
      'char id=65 x=0 y=0 width=8 height=12 xoffset=0 yoffset=2 xadvance=9 page=0',
      'char id=66 x=16 y=0 width=8 height=12 xoffset=0 yoffset=2 xadvance=9 page=0',
    ].join('\n');
    /* 造一张 64×64 的 DXT5 空白图集：只验证排版，不管像素 ✓ */
    const blocks = (64 / 4) * (64 / 4);
    const dds = new ArrayBuffer(128 + blocks * 16);
    const dv = new DataView(dds);
    dv.setUint32(0, 0x20534444, true);
    dv.setUint32(12, 64, true);
    dv.setUint32(16, 64, true);
    dv.setUint32(80, 0x4, true);
    'DXT5'.split('').forEach((c, i) => dv.setUint8(84 + i, c.charCodeAt(0)));

    const bf = new F.BitmapFont(fnt, dds);
    ok('造出一套可用字体（ok = 元数据 + 图集都认 ✓）', bf.ok === true, String(bf.ok));
    ok('行高取的是 fnt 里的 lineHeight（判缩放用 ✓）', bf.lineHeight === 16, String(bf.lineHeight));
    ok('量宽 = 各字 xadvance 之和（不用 measureText ✓）',
      Math.abs(bf.measure('AB', 16) - 18) < 0.01, String(bf.measure('AB', 16)));
    ok('放大到 32px 宽度翻倍（按 lineHeight 线性缩放 ✓）',
      Math.abs(bf.measure('AB', 32) - 36) < 0.01, String(bf.measure('AB', 32)));

    const lay = F.layoutRun(bf, 'AB', 16);
    ok('排版给出 2 个字形的位置', lay.length === 2, `${lay.length} 个`);
    ok('逐字前进 9px（xadvance ✓）',
      lay.length === 2 && Math.abs((lay[1].x - lay[0].x) - 9) < 0.01,
      lay.length === 2 ? String(lay[1].x - lay[0].x) : '');
    ok('整段是**居中**排的（左边是负的 ✓ 跟 fillText 那套对齐）',
      lay.length === 2 && lay[0].x < 0, lay.length ? String(lay[0].x.toFixed(1)) : '');
    ok('缺字不炸（没这个字就不占位 ✓）', F.layoutRun(bf, 'A\u4E2D', 16).length === 1);
  }

  console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败项：');
    fails.forEach((f) => console.log('  ✘ ' + f));
  }
  process.exit(fails.length ? 1 : 0);
})();
