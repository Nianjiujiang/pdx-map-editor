'use strict';
/**
 * 渲染器初始化失败的**分类**回归 —— 不启动整张地图，只拿假 GL 撞几种失败。
 *
 *   node tools/check_renderer_error.js
 *
 * 为什么要有它：2026-10-17 管理员报"打开就莫名其妙着色器连接失败"，
 * 结果真凶是 **WebGL 上下文丢了** —— 可 boot 里那句 `new MapRenderer` 的
 * catch 把**任何**异常都写成"着色器编译失败" ✗，把人指进了着色器源码。
 *
 * 这里直接量分类：
 *   ① 拿不到 WebGL2            → stage = no-webgl2（带浏览器给的 statusMessage）
 *   ② 上下文创建后立刻丢失     → stage = context-lost
 *   ③ 只当着色器真的编译不过   → stage = shader-compile（带驱动日志）
 *   ④ 链接失败                 → stage = shader-link
 *   ⑤ 显存不足                 → stage = out-of-memory
 *   ⑥ 贴图上限太小             → stage = texture-limit
 *   ⑦ 正常 GL                  → 不抛，能建出渲染器
 *
 * ⚠ 别把"上下文丢失"重新归到 shader-compile ✗ —— 那正是这次要防的回归。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const fails = [];
const oks = [];
function ok(name, cond, extra = '') {
  (cond ? oks : fails).push(name + (extra ? `  → ${extra}` : ''));
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  → ' + extra : ''}`);
}

// ---- 把 gl.js 的 `export` 剥掉，在 vm 里跑（跟单文件版同一个手法）
const glSrc = fs.readFileSync(path.join(ROOT, 'web', 'js', 'gl.js'), 'utf8')
  .replace(/^export /gm, '');
const sandbox = {
  console, window: {}, document: {},
  Uint8Array, Uint16Array, Int32Array, Float32Array, Float64Array,
  Map, Set, Promise, Math, Object, String, Number, Error, RegExp, Array, JSON,
  setTimeout, clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(glSrc + '\nthis.__gltest = { MapRenderer, RendererSetupError };', sandbox);
const { MapRenderer, RendererSetupError } = sandbox.__gltest;

const META = {
  mapWidth: 100, mapHeight: 100, numProvinces: 10,
  numTitles: 20, numRealTitles: 20, noTitle: 65535, colorLutWidth: 256,
};

/** 够 `_build()` 跑到失败那一步的假 GL ✓（不用真 WebGL） */
function makeGL(o = {}) {
  return {
    VERSION: 0x1F02, RENDERER: 0x1F01, VENDOR: 0x1F00, MAX_TEXTURE_SIZE: 0x0D33,
    VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
    R8: 0x8229, RED: 0x1903, UNSIGNED_BYTE: 0x1401, NEAREST: 0x2600,
    NO_ERROR: 0, OUT_OF_MEMORY: 0x0505,
    getParameter: (p) => {
      if (p === 0x0D33) return o.maxTex || 16384;
      if (p === 0x1F02) return 'WebGL 2.0 (fake)';
      if (p === 0x1F01) return 'FakeGPU';
      if (p === 0x1F00) return 'FakeVendor';
      return 0;
    },
    getExtension: () => null,
    isContextLost: () => !!o.lost,
    getError: () => o.glError || 0,
    createTexture: () => ({}), bindTexture() {}, texParameteri() {}, texImage2D() {},
    createShader: () => ({}), shaderSource() {}, compileShader() {}, deleteShader() {},
    getShaderParameter: () => o.compileOk !== false,
    getShaderInfoLog: () => o.shaderLog || '',
    createProgram: () => ({}), attachShader() {}, linkProgram() {}, deleteProgram() {},
    getProgramParameter: () => o.linkOk !== false,
    getProgramInfoLog: () => o.linkLog || '',
    getUniformLocation: () => null,
    createVertexArray: () => ({}), bindVertexArray() {},
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
    getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
    disable() {}, clearColor() {},
  };
}

/** 假 canvas：可以在拿上下文时模拟 webglcontextcreationerror ✓ */
function makeCanvas(o = {}) {
  const listeners = {};
  return {
    width: 300, height: 150,
    addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn); },
    removeEventListener(t, fn) {
      if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== fn);
    },
    dispatchEvent(ev) {
      for (const fn of (listeners[ev.type] || [])) fn(ev);
    },
    getContext() {
      if (o.creationError) {
        for (const fn of (listeners['webglcontextcreationerror'] || [])) {
          fn({ statusMessage: o.creationError, preventDefault() {} });
        }
        return null;
      }
      return o.gl || null;
    },
  };
}

function tryMake(gl, canvasOpts = {}) {
  const canvas = makeCanvas(Object.assign({ gl }, canvasOpts));
  try {
    const r = new MapRenderer(canvas, META);
    return { r, err: null };
  } catch (e) {
    return { r: null, err: e };
  }
}

function expectStage(name, gl, canvasOpts, stage) {
  const { err } = tryMake(gl, canvasOpts);
  ok(name, !!err && err.name === 'RendererSetupError' && err.stage === stage,
    err ? `${err.name}/${err.stage || '无 stage'} · ${err.message}` : '没抛（应该抛 ✗）');
  return err;
}

console.log('=== 渲染器初始化失败：分类 ===');
{
  const err = expectStage('拿不到 WebGL2 → no-webgl2',
    null, { creationError: 'GPU process unavailable' }, 'no-webgl2');
  ok('  · 浏览器给的 statusMessage 带出来了',
    !!err && /GPU process unavailable/.test(String(err.detail && err.detail.creationError)),
    err && err.detail ? String(err.detail.creationError) : '没有 detail');
  ok('  · 这条**不提**着色器编译（那是误报 ✗）',
    !!err && !/着色器编译失败/.test(err.message),
    err && err.message);
}
{
  const err = expectStage('上下文创建后立刻丢失 → context-lost', makeGL({ lost: true }), {}, 'context-lost');
  ok('  · detail 里标着"上下文已丢失"',
    !!err && err.detail && err.detail.contextLost === true,
    err && err.detail ? JSON.stringify(err.detail) : '没有 detail');
  ok('  · 这条**不提**着色器编译（管理员踩的就是它 ✗）',
    !!err && !/着色器编译失败/.test(err.message),
    err && err.message);
}
{
  const err = expectStage('着色器真的编译不过 → shader-compile',
    makeGL({ compileOk: false, shaderLog: 'ERROR: 0:12 syntax error' }), {}, 'shader-compile');
  ok('  · 驱动日志带出来了', !!err && /syntax error/.test(err.message), err && err.message);
}
{
  const err = expectStage('链接失败 → shader-link',
    makeGL({ linkOk: false, linkLog: 'LINK ERROR: too many registers' }), {}, 'shader-link');
  ok('  · 链接日志带出来了', !!err && /too many registers/.test(err.message), err && err.message);
}
expectStage('显存不足 → out-of-memory',
  makeGL({ compileOk: false, glError: 0x0505 }), {}, 'out-of-memory');
expectStage('贴图上限太小 → texture-limit',
  makeGL({ maxTex: 128 }), {}, 'texture-limit');
{
  const { r, err } = tryMake(makeGL(), {});
  ok('正常 GL → 能建出渲染器（分类逻辑不误伤 ✓）', !!r && !err,
    err ? String(err.message) : '建出来了 ✓');
}
{
  /* 真正模拟"创建时还在、编译时丢了"：getShaderParameter 那一刻把 lost 翻成 true */
  let lost = false;
  const gl = makeGL({ compileOk: false });
  gl.isContextLost = () => lost;
  gl.getShaderParameter = () => { lost = true; return false; };
  const err = expectStage('上下文在编译时丢失 → context-lost（不是 shader-compile ✗）',
    gl, {}, 'context-lost');
  ok('  · 这条是本次修复的关键回归点：先判 isContextLost、再怪着色器',
    !!err && err.stage === 'context-lost'
    && err.detail && err.detail.stageAt === 'compile'
    && !/着色器编译失败/.test(err.message),
    err && `${err.stage}@${err.detail && err.detail.stageAt} · ${err.message}`);
}

/* ------------------------------------------------------------------ *
 * 端到端：启动时拿不到 WebGL2，红字必须说人话
 *  （分类函数对了，不代表 boot 那条 catch 真的用上了 —— 这里把整条链跑一遍 ✓）
 * ------------------------------------------------------------------ */
async function e2eNoWebGL2() {
  const H = require('./lib/browser_stub.js');
  const origGetContext = H.El.prototype.getContext;
  H.El.prototype.getContext = function (kind) {
    if (kind === 'webgl2') return null;      // 模拟"这个浏览器没能创建 WebGL2"
    return origGetContext.call(this, kind);
  };
  try {
    const env = H.makeEnv({ root: H.ROOT });
    const ex = H.instantiate(H.flattenModules(), env);
    const booting = ex.boot();
    for (let i = 0; i < 800 && !env.get('map-pick-list').children.length; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const card = env.get('map-pick-list').children[0];
    ok('端到端：选图卡片出得来（能走到建渲染器那一步）', !!card, card ? '' : '没有卡片 ✗');
    if (!card) return;
    card.onclick();
    await booting;
    const text = String((env.get('fatal-text') || {}).textContent || '');
    const bootText = String((env.get('boot-step') || {}).textContent || '');
    ok('端到端：红字说"没能创建 WebGL2"（不再指着色器 ✗）',
      /WebGL2/.test(text) && /没能创建/.test(text) && !/着色器编译失败/.test(text),
      text.split('\n')[0] || '（空）');
    ok('端到端：红字框里有「刷新重试」', !!env.get('fatal-reload'),
      env.get('fatal-reload') ? '在 ✓' : '没有 ✗');
    ok('端到端：启动屏也停在可读的失败说明',
      /WebGL2|显卡/.test(bootText), bootText || '（空）');
    ok('端到端：失败状态记在 `state._rendererFail`（日志能带走）',
      !!(ex.state && ex.state._rendererFail && ex.state._rendererFail.code),
      ex.state && ex.state._rendererFail ? ex.state._rendererFail.code : '没记 ✗');
  } finally {
    H.El.prototype.getContext = origGetContext;
  }
}

(async () => {
  console.log('\n=== 渲染器初始化失败：启动链端到端 ===');
  await e2eNoWebGL2();

  console.log('\n==========================================================');
  console.log(`通过 ${oks.length} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log('失败的：');
    for (const f of fails) console.log('  · ' + f);
    process.exitCode = 1;
  }
})();
