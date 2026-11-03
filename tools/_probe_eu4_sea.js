const fs = require('fs');
const zlib = require('zlib');
const D = 'data_eu4/';
const meta = JSON.parse(fs.readFileSync(D + 'meta.json', 'utf8'));
const n = meta.numProvinces | 0;
const tm = new Uint16Array(zlib.inflateSync(fs.readFileSync(D + 'titlemap.bin')).buffer.slice(0));
const titles = JSON.parse(fs.readFileSync(D + 'titles.json', 'utf8'));
const names = titles.names || titles.titles || [];
const keys = titles.keys || null;
console.log('tiers', meta.tiers.length, 'n', n, 'tm.len', tm.length, 'names', names.length);
const tiers = { ct: 13, sr: 14, rg: 15, ar: 16, pr: 17 };
const nameOf = (tid) => (tid === 65535 || tid < 0) ? '(NO_TITLE)' : (names[tid] || ('#' + tid));

// 找海域 pid：pr 层名字以 #sea 开头
const sea = [];
for (let p = 1; p < n; p++) {
  const t = tm[17 * n + p];
  const nm = String(nameOf(t));
  if (/^#?sea/i.test(nm) || /海$/.test(nm)) sea.push(p);
}
console.log('sea pids(pr 名字带 sea/海):', sea.length);

const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
for (const tk of Object.keys(tiers)) {
  const t = tiers[tk];
  const stat = { numeric: 0, sea: 0, other: 0, none: 0 };
  const samples = [];
  for (const p of sea) {
    const tid = tm[t * n + p];
    if (tid === 65535) { stat.none++; continue; }
    const nm = String(nameOf(tid));
    if (/^\d+$/.test(nm) || /^省份\s*\d+$/.test(nm)) stat.numeric++;
    else if (/^#?sea/i.test(nm) || /海/.test(nm)) stat.sea++;
    else stat.other++;
    if (samples.length < 8) samples.push(p + '→' + (tid === 65535 ? 'NO_TITLE' : nm));
  }
  console.log(tk.padEnd(3), JSON.stringify(stat), '|', samples.join(' , '));
}

// 再看陆地：随便挑几个陆 pid
const land = [];
for (let p = 1; p < n && land.length < 5; p++) {
  const nm = String(nameOf(tm[17 * n + p]));
  if (!/^#?sea/i.test(nm) && !/海/.test(nm) && !/^\d+$/.test(nm)) land.push(p);
}
console.log('\n陆地样本：');
for (const p of land) {
  const row = Object.entries(tiers).map(([k, t]) => k + '=' + nameOf(tm[t * n + p])).join(' ');
  console.log(p, row);
}
console.log('\n海域样本明细：');
for (const p of sea.slice(0, 12)) {
  const row = Object.entries(tiers).map(([k, t]) => k + '=' + nameOf(tm[t * n + p])).join(' ');
  console.log(p, row);
}
