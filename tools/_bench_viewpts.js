// 视口取舍：分桶+全排序 vs 直接线性扫（都保持"面积降序"这个输出契约）
const N = 23000, W = 8192, H = 3616, CELL = 512;
const pts = [];
for (let i = 0; i < N; i++) {
  pts.push({ x: (i * 7919) % W, y: (i * 6151) % H, area: 1e6 - i, tid: i, name: 'x' });
}
pts.sort((a, b) => b.area - a.area);

function bucketQuery(view, pad) {
  const map = new Map();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const k = ((p.x / CELL) | 0) + ',' + ((p.y / CELL) | 0);
    let a = map.get(k); if (!a) map.set(k, a = []); a.push(p);
  }
  const x0 = Math.floor((view.x - pad) / CELL), x1 = Math.floor((view.x + view.w + pad) / CELL);
  const y0 = Math.floor((view.y - pad) / CELL), y1 = Math.floor((view.y + view.h + pad) / CELL);
  const out = [];
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    const a = map.get(cx + ',' + cy); if (a) for (let i = 0; i < a.length; i++) out.push(a[i]);
  }
  out.sort((a, b) => (b.area || 0) - (a.area || 0));
  return out;
}

function linearQuery(view, pad) {
  const x0 = view.x - pad, x1 = view.x + view.w + pad;
  const y0 = view.y - pad, y1 = view.y + view.h + pad;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push(p);
  }
  return out;   // pts 本身是面积降序 → out 天然保持 ✓ 不用 sort
}

const cases = [
  ['整图 (scale 0.18, pad 5000)', { x: 0, y: 0, w: 9000, h: 7000 }, 5000],
  ['半图 (scale 0.35, pad 2571)', { x: 2000, y: 800, w: 4000, h: 2500 }, 2571],
  ['近景 (scale 1.2, pad 750)', { x: 3000, y: 1500, w: 1400, h: 900 }, 750],
  ['特写 (scale 4, pad 225)', { x: 3000, y: 1500, w: 400, h: 260 }, 225],
];
function time(fn, arg, n) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(arg[0], arg[1]);
  return Number(process.hrtime.bigint() - t0) / 1e6 / n;
}
for (const [label, view, pad] of cases) {
  for (let i = 0; i < 5; i++) { bucketQuery(view, pad); linearQuery(view, pad); }
  const a = time(bucketQuery, [view, pad], 30), b = time(linearQuery, [view, pad], 30);
  const cnt = linearQuery(view, pad).length;
  const sortedA = bucketQuery(view, pad)[0] === linearQuery(view, pad)[0];
  console.log(`${label.padEnd(28)} 命中 ${String(cnt).padStart(6)}  分桶+排序 ${a.toFixed(3)}ms  线性 ${b.toFixed(3)}ms  首项一致 ${sortedA}`);
}
