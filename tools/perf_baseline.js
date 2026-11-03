/**
 * 性能回归护栏 —— 把 bench_core 那套指标存成基线，改完代码一比就知道有没有退。
 *
 *   node tools/perf_baseline.js --save          # 用当前代码量一遍，覆盖基线
 *   node tools/perf_baseline.js --check         # 跟基线比，超红线就红字 + 退出码 1
 *   node tools/perf_baseline.js                 # 只量、只打印，不写文件也不判红
 *   node tools/perf_baseline.js --check --maps EU5,VIC3
 *
 * 为什么要它：这个仓库的性能优化是"这里改快一点、那里悄悄慢回来"的拉锯战 ✓。
 * 2026-11-03 那次 rebuildPaintBlocks 优化之前，没人能一眼看出
 * "这次改动让 drawLabels 从 1.7ms 涨到 2.4ms" —— 因为每次都是新跑一遍、
 * 看几个数字、觉得"差不多" ✗。有基线之后，数字对不上就是红，不靠眼睛 ✓。
 *
 * ⚠ 量什么、怎么量**只写在 `tools/bench_core.js`** ✓，这里只负责存 / 比 / 印。
 *   别在这份文件里再抄一遍指标表 ✗（抄两份一定会漂）。
 *
 * ⚠ 红线公式：`现在 > max(基线 × 系数, 基线 + 毫秒下限)` 才算红 ✓
 *   单纯按比例会在"基线本来就是 0.02ms"的小指标上天天误报（+0.01ms = +50%）✗；
 *   单纯按绝对差又会在 boot 这种毫秒级大指标上放过 30% 的退化 ✗。两个都要 ✓。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { measure, MAP_KEYS } = require('./bench_core.js');

const FILE = path.join(__dirname, 'perf_baseline.json');
const DEFAULT_MAPS = ['EU4', 'EU5', 'VIC3'];

/* 每档指标的宽容度：{factor: 比例, floor: 绝对毫秒下限}
 * - 默认 1.25 倍 / 1.5ms —— 够宽容到不误报（Node 里同一函数来回跑本来就有 ±10%），
 *   又严到能抓住"真慢了一截"（比如 drawLabels 1.7 → 2.4）✓
 * - boot 是**只量一次**的墙钟（含读盘 / 解压 / 建纹理），噪声比别的都大，
 *   而且它天生就慢，1.25 倍等于放 200ms —— 用 1.6 倍 + 80ms 下限 ✓
 * - provInfo 是 ×1000 的批量，绝对值本来就几百毫秒，比例就够 ✓ */
const TOLERANCE = {
  boot: { factor: 1.6, floor: 80 },
};
const TOL_DEFAULT = { factor: 1.25, floor: 1.5 };

const C = process.stdout.isTTY
  ? { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
      dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` }
  : { red: (s) => s, green: (s) => s, dim: (s) => s, bold: (s) => s };

// ---------------------------------------------------------------- 命令行参数
function parseArgs(argv) {
  const out = { save: false, check: false, maps: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--save') out.save = true;
    else if (a === '--check') out.check = true;
    else if (a === '--one') out.one = String(argv[++i] || '').toUpperCase();
    else if (a === '--maps') out.maps = String(argv[++i] || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.maps = [a.toUpperCase()];
    else {
      console.error(`不认识这个参数：${a}\n  --save / --check / --maps EU5,VIC3`);
      process.exit(2);
    }
  }
  return out;
}

function usage() {
  console.log(`
性能回归护栏

  node tools/perf_baseline.js --save              用当前代码量一遍，覆盖基线
  node tools/perf_baseline.js --check             跟基线比，超红线退出码 1
  node tools/perf_baseline.js                     只量、只打印
  node tools/perf_baseline.js --check --maps EU5,VIC3

  能跑的地图：${MAP_KEYS.join('、')}（不加 --maps 时跑 ${DEFAULT_MAPS.join('、')}）
  基线文件：  tools/perf_baseline.json（跟着仓库走，别塞进 .gitignore）

红线公式：现在 > max(基线 × 1.25, 基线 + 1.5ms) 算退化
          boot 例外：基线 × 1.6 / +80ms（只量一次，噪声大）
`);
}

// ---------------------------------------------------------------- 存 / 读
function loadBaseline() {
  if (!fs.existsSync(FILE)) {
    console.error(`⚠ 还没有基线文件：${path.relative(process.cwd(), FILE)}\n`
      + '  先跑一次 `node tools/perf_baseline.js --save` 把它落下来 ✓');
    process.exit(2);
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error(`✗ 基线文件不是合法 JSON：${FILE}\n  ${e.message}\n`
      + '  怎么修：删掉它重跑 --save（别手改，量一遍就有了）');
    process.exit(2);
  }
  if (!json || json.version !== 1 || !json.maps) {
    console.error(`✗ 基线文件格式不对（要 version: 1 + maps）：${FILE}\n`
      + '  怎么修：删掉它重跑 --save');
    process.exit(2);
  }
  return json;
}

function saveBaseline(runs) {
  const maps = {};
  for (const run of runs) maps[run.map] = { card: run.card, meta: run.meta, metrics: run.results };
  const json = {
    version: 1,
    //: 这三行只是留个"什么环境量的"，**比对时不看** ✓（换机器不该因此变红）
    savedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    tol: { default: TOL_DEFAULT, overrides: TOLERANCE },
    maps,
  };
  fs.writeFileSync(FILE, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  console.log(`\n✓ 基线已写入 ${path.relative(process.cwd(), FILE)}`
    + `（${Object.keys(maps).length} 张图 · ${Object.values(maps)
      .reduce((n, m) => n + Object.keys(m.metrics).length, 0)} 项指标）`);
}

// ---------------------------------------------------------------- 量（一张一张单独开进程）
/* 🔴 **为什么要在子进程里量**（2026-11-03 实测打脸）
 *   三张图在同一个 node 进程里连着量时，**后跑的会被前一张的堆压力拖慢**：
 *     EU5 单跑 rebuildPaintBlocks 6.19~6.35ms（基线 6.41 ✓ 全绿），
 *     三图同进程跑就变成 8.4 ✗；
 *     VIC3 单跑 10.55，三图同进程 9.40~12.61（40% 的抖动）。
 *   拿**改前的树**同样三图连着跑，也会红 ⇒ 红的是"量法"，不是代码 ✗
 *   → 每张图单独 `spawn` 一个 node：量完就退，堆跟着进程一起没 ✓
 *   → 只量一张图时（--maps EU5 / 命令行给一个图名）不折腾，直接在本进程量 ✓
 */
const ONE_MARK = '@@PDX_ONE@@';
let _spawnBlocked = false;     // 这台机器不许开子进程（沙箱 / 权限）→ 退回本进程量 ✓
function measureInChild(map) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [__filename, '--one', map], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout || '');
  const at = out.indexOf(ONE_MARK);
  if (at < 0) {
    /* 开不了子进程（EPERM / 被沙箱拦）不是"量不下去"✗ —— 换回本进程量就是了 ✓
       （隔离开不成，数字会差一点，但总比整个护栏跑不了强 ✓） */
    const errTxt = String((r.error && r.error.message) || '');
    if (!r.status && !out.trim() && /EPERM|EACCES|spawn/i.test(errTxt)) {
      _spawnBlocked = true;
      return measure(map, { quiet: true });
    }
    const msg = String(r.stderr || '').trim() || out.trim() || `子进程没有回报（退出码 ${r.status}）`;
    throw new Error(msg);
  }
  const line = out.slice(at + ONE_MARK.length).split('\n')[0];
  return JSON.parse(line);
}
async function measureOne(map, total) {
  if (total <= 1 || _spawnBlocked) return measure(map, { quiet: true });
  const one = await measureInChild(map);
  /* 一张量完就催一次 GC：同进程连着量三张时，上一张的堆不放手会把下一张拖慢 ✓
     没开 `--expose-gc` 时这步是空操作，只提示一句（不影响结果的对错，只影响干净程度 ✓） */
  if (typeof global.gc === 'function') { try { global.gc(); global.gc(); } catch (_) {} }
  return one;
}

// ---------------------------------------------------------------- 比对 + 打印


function tolOf(key, base) {
  const t = TOLERANCE[key] || (base && base.tol && base.tol.overrides && base.tol.overrides[key]) || TOL_DEFAULT;
  return t;
}

/** @returns {boolean} 是否有超标项 */
function report(check, runs, base) {
  let anyRed = 0;
  let anyGreen = 0;
  let anyNew = 0;

  for (const run of runs) {
    const old = base && base.maps && base.maps[run.map];
    console.log(`\n${C.bold(run.card)}  ${C.dim(`地块 ${run.meta.provinces} · 头衔 ${run.meta.titles}`)}`);
    if (check && !old) {
      console.log(`  ${C.red('⚠ 基线里没有这张图')}（基线是 ${Object.keys(base.maps).join('、') || '空'}）`
        + ' —— 换图了就先 --save 一次 ✓');
      anyNew++;
      continue;
    }
    if (check) {
      console.log(`  ${'指标'.padEnd(36)}${'基线'.padStart(9)}${'现在'.padStart(9)}${'变化'.padStart(9)}  判定`);
    }
    for (const key of Object.keys(run.results)) {
      const cur = run.results[key];
      if (!check) {
        console.log(`  ${cur.label.padEnd(36)}${cur.med.toFixed(2).padStart(9)} ms`);
        continue;
      }
      const b = old.metrics[key];
      if (!b) {
        console.log(`  ${cur.label.padEnd(36)}${'—'.padStart(9)}${cur.med.toFixed(2).padStart(9)}`
          + `${'新指标'.padStart(9)}  ${C.dim('（--save 后纳入）')}`);
        anyNew++;
        continue;
      }
      const t = tolOf(key, base);
      const limit = Math.max(b.med * t.factor, b.med + t.floor);
      const worse = cur.med > limit;
      const diff = cur.med - b.med;
      const pct = b.med > 0 ? (diff / b.med) * 100 : 0;
      const sign = diff >= 0 ? '+' : '';
      const line = `  ${cur.label.padEnd(36)}${b.med.toFixed(2).padStart(9)}`
        + `${cur.med.toFixed(2).padStart(9)}${(sign + pct.toFixed(0) + '%').padStart(9)}`;
      if (worse) {
        anyRed++;
        console.log(`${line}  ${C.red(`✗ 超红线（上限 ${limit.toFixed(2)} ms）`)}`);
      } else {
        anyGreen++;
        console.log(`${line}  ${diff < -Math.max(b.med * 0.15, 0.3) ? C.green('✓ 变快了') : C.green('✓')}`);
      }
    }
  }

  if (!check) return false;
  console.log('');
  if (anyRed) {
    console.log(C.red(`✗ ${anyRed} 项超出红线`) + (anyGreen ? ` · ${anyGreen} 项正常` : '')
      + (anyNew ? ` · ${anyNew} 项新指标` : ''));
    console.log('  怎么读：只在**这次改动碰过**的指标上认账 ✓；'
      + '全都涨了一点点，多半是机器忙 / 后台在跑别的东西，重跑一次再看。');
    console.log('  确实是有意慢下来（比如换实现换清晰度），跑 --save 更新基线并在提交信息里写清楚为什么 ✓');
    return true;
  }
  console.log(C.green(`✓ ${anyGreen} 项全部在红线内`) + (anyNew ? ` · ${anyNew} 项新指标待 --save` : ''));
  return false;
}

// ---------------------------------------------------------------- 主流程
(async () => {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }
  /* 内部用：给"一张一张开子进程"那条路量单张图，量完把这行 JSON 打给父进程 ✓
     正常用户不会碰它（--one 不出现在用法里，也不写文档）✓ */
  if (args.one) {
    if (!MAP_KEYS.includes(args.one)) {
      console.error(`✗ 不认识的地图：${args.one}\n  能跑的是：${MAP_KEYS.join('、')}`);
      process.exit(2);
    }
    const run = await measure(args.one, { quiet: true });
    process.stdout.write(`\n${ONE_MARK}${JSON.stringify(run)}\n`);
    return;
  }
  if (args.save && args.check) {
    console.error('✗ --save 和 --check 不能一起用：一个是"记下来"，一个是"拿来比" ✓');
    process.exit(2);
  }
  const keys = (args.maps && args.maps.length ? args.maps : DEFAULT_MAPS).filter((k) => MAP_KEYS.includes(k));
  const bad = (args.maps || []).filter((k) => !MAP_KEYS.includes(k));
  if (bad.length) {
    console.error(`✗ 不认识的地图：${bad.join('、')}\n  能跑的是：${MAP_KEYS.join('、')}`);
    process.exit(2);
  }
  if (!keys.length) { console.error('✗ 一张图都没选'); process.exit(2); }

  const base = args.check ? loadBaseline() : (fs.existsSync(FILE) && !args.save ? loadBaseline() : null);

  console.log(`量 ${keys.join(' / ')} …（每张图要重新 boot 一次，慢是正常的）`);
  const runs = [];
  for (const k of keys) {
    try {
      runs.push(await measureOne(k, keys.length));
    } catch (e) {
      console.error(`\n✗ 「${k}」量不下去：${e && e.message ? e.message : e}\n`
        + '  这类崩通常是源码本身起不来（先跑 node tools/test_modes.js ' + k + ' 确认功能没坏）');
      process.exit(1);
    }
  }

  if (args.save) { saveBaseline(runs); return; }
  //: 不带 --check 时，有基线就顺手比一下（纯参考），没基线就只打印
  const red = report(!!args.check || !!base, runs, base);
  if (red) process.exit(1);
})().catch((e) => { console.error('崩了：', e); process.exit(1); });
