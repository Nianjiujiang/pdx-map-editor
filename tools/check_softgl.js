'use strict';
/**
 * 「软件渲染」识别的回归 —— 2026-10-18 用户报的那份 VIC3 报告。
 *
 *   node tools/check_softgl.js
 *
 * 现象：Windows + Edge 155，VIC3 8192×3616，报「着色器链接失败（驱动没给日志）」，
 * 而且「上传到显卡 → 失败」花了 **92377 ms** —— 这是 SwiftShader 在拿 CPU 啃着色器。
 * 报告里只有一句 `渲染器 WebKit WebGL`（没有 unmasked 显卡名），光看报告分不出来。
 *
 * 这份守两件事：
 *   ① detectSoftwareGL 认得出软件渲染，且**不误伤**真显卡；
 *   ② 错误屏在这条路上给的是"去开硬件加速"，而不是"更新驱动 / 换浏览器"那套废话。
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

/** 从拍平的源码里抠出 detectSoftwareGL（纯函数，不依赖 DOM） */
function loadDetect() {
  const js = H.flattenModules();
  const m = js.match(/function detectSoftwareGL\(gl\)\s*\{[\s\S]*?\n\}/);
  if (!m) throw new Error('源码里找不到 detectSoftwareGL');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '; return detectSoftwareGL;')();
}

/** 造一个假的 gl */
function fakeGL({ unmasked = '', base = 'WebKit WebGL' } = {}) {
  return {
    getExtension: (n) => (n === 'WEBGL_debug_renderer_info'
      ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
    getParameter: (p) => (p === 0x9246 ? unmasked : base),
  };
}

const detect = loadDetect();

// ---- ① 认得出来 ----
ok('SwiftShader 认得出', detect(fakeGL({ unmasked: 'Google SwiftShader' })) === true);
ok('llvmpipe 认得出', detect(fakeGL({ unmasked: 'llvmpipe (LLVM 15.0.7)' })) === true);
ok('Microsoft Basic Render 认得出',
  detect(fakeGL({ unmasked: 'Microsoft Basic Render Driver' })) === true);
ok('拿不到 unmasked 名字 + 原生 WebKit WebGL → 当软件渲染',
  detect(fakeGL({ unmasked: '', base: 'WebKit WebGL' })) === true);

// ---- ② 不误伤真显卡 ----
ok('NVIDIA 不算软件渲染',
  detect(fakeGL({ unmasked: 'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11)' })) === false);
ok('Intel 核显不算软件渲染',
  detect(fakeGL({ unmasked: 'ANGLE (Intel, Intel(R) UHD Graphics 620)' })) === false);
ok('AMD 不算软件渲染',
  detect(fakeGL({ unmasked: 'ANGLE (AMD Radeon RX 580)' })) === false);
ok('Adreno 不算软件渲染',
  detect(fakeGL({ unmasked: 'ANGLE (Qualcomm, Adreno (TM) 616)' })) === false);

// ---- ③ 错误屏的文案分流 ----
const src = fs.readFileSync(path.join(H.ROOT, 'web', 'js', 'app.js'), 'utf8');
const start = src.indexOf('if (d.softwareGL)');
ok('describeRendererFailure 里有 softwareGL 分支', start >= 0);
if (start >= 0) {
  // 从 if 那一行往后截一段（到下一处 shader-link 的 return 为止）
  const seg = src.slice(start, start + 2000);
  ok('软件渲染那条提到「使用图形加速」', /使用图形加速|硬件加速/.test(seg));
  ok('软件渲染那条提到 edge://gpu 或 chrome://gpu', /edge:\/\/gpu|chrome:\/\/gpu/.test(seg));
  ok('软件渲染那条说明了「不是地图坏了」', /不是地图坏了/.test(seg));
}

// ---- ④ 报告里要带软件渲染和链接耗时 ----
ok('_glFacts 记了 softwareGL', /out\.softwareGL = detectSoftwareGL\(gl\)/.test(src.replace(/\s+/g, ' ') + '' ) ||
  fs.readFileSync(path.join(H.ROOT, 'web', 'js', 'gl.js'), 'utf8').includes('out.softwareGL = detectSoftwareGL(gl)'));
ok('链接耗时会进 detail', /linkMs/.test(fs.readFileSync(path.join(H.ROOT, 'web', 'js', 'gl.js'), 'utf8')));

console.log(`\n通过 ${oks.length} 条，失败 ${fails.length} 条`);
process.exit(fails.length ? 1 : 0);
