/* 临时探针：验证 readJSONBox / writeJSONBox 的坏档恢复（跑完可删 ✓） */
const fs = require('fs');
const src = fs.readFileSync('web/js/app.js', 'utf8');

function cut(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  const m = /^}/m.exec(src.slice(i));
  return src.slice(i, i + m.index + 1);
}

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const sandbox = { localStorage, JSON, console };
const code = cut('readJSONBox') + '\n' + cut('writeJSONBox') + '\nreturn { readJSONBox, writeJSONBox };';
const { readJSONBox, writeJSONBox } = new Function('localStorage', 'return (function(){' + code.replace('return { readJSONBox', 'return { readJSONBox') + '})()')(localStorage);

let bad = 0;
const ok = (name, cond, extra) => { if (!cond) bad++; console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? '  → ' + extra : '')); };

// 1. 正常读写
store.set('K', JSON.stringify({ a: 1 }));
ok('正常读回对象', readJSONBox('K', {}).a === 1);
ok('写回成功', writeJSONBox('K', { a: 2 }) === true && JSON.parse(store.get('K')).a === 2);

// 2. 缺键 → 用兜底
ok('缺键给兜底', readJSONBox('NOPE', { z: 1 }).z === 1);
ok('缺键给数组兜底', Array.isArray(readJSONBox('NOPE', [])));

// 3. 坏档 → 挪到 .broken、正本清掉、返回兜底
store.set('BAD', '{"a":1,,');
const r = readJSONBox('BAD', {});
ok('坏档返回兜底', Object.keys(r).length === 0);
ok('坏档挪到 .broken', store.get('BAD.broken') === '{"a":1,,');
ok('坏档正本已清', store.has('BAD') === false);

// 4. 坏档之后能重新写进去（"自己就好了"）
store.set('BAD2', 'oops');
readJSONBox('BAD2', {});
ok('坏档之后能写回', writeJSONBox('BAD2', { ok: 1 }) === true && JSON.parse(store.get('BAD2')).ok === 1);

// 5. 不是对象（null / 数字 / 字符串）→ 兜底
for (const v of ['null', '42', '"s"']) {
  store.set('T', v);
  ok('非对象 ' + v + ' 给兜底', readJSONBox('T', { d: 9 }).d === 9);
}

// 6. 写不进去（配额满）返回 false，不抛
const boom = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => {} };
const w = new Function('localStorage', 'return (function(){' + cut('readJSONBox') + '\n' + cut('writeJSONBox') + '\nreturn writeJSONBox; })()')(boom);
ok('配额满返回 false', w('K', {}) === false);

// 7. 隐私模式（读就抛）也不炸
const priv = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => {} };
const rp = new Function('localStorage', 'return (function(){' + cut('readJSONBox') + '\nreturn readJSONBox; })()')(priv);
ok('隐私模式读返回兜底', rp('K', { p: 1 }).p === 1);

console.log(bad ? '\n失败 ' + bad + ' 条' : '\n全过 ✓');
process.exit(bad ? 1 : 0);
