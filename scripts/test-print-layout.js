// Checks Prisca's print layout maths (ui/print.js): node scripts/test-print-layout.js
'use strict';
const assert = require('assert');
const { PrintLayout: L } = require('../ui/print.js');

const A4 = { w: 210, h: 297 };
const none = { t: 0, r: 0, b: 0, l: 0 };
const base = { m: { t: 10, r: 10, b: 10, l: 10 }, mode: 'fit', pct: 100, anchor: 4, offX: 0, offY: 0, nup: 1, orient: 'auto' };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('true size receipt, top centre', () => {
  const [sh] = L.sheets([{ w: 80, h: 200 }], { ...base, mode: 'actual', anchor: 1 }, A4, none);
  const it = sh.items[0];
  near(it.w, 80, 'w'); near(it.h, 200, 'h');
  near(it.x, 10 + (190 - 80) / 2, 'x centred'); near(it.y, 10, 'y at top margin');
  assert.strictEqual(sh.landscape, false);
});

t('fit keeps the anchor; every anchor', () => {
  for (let a = 0; a < 9; a++) {
    const [sh] = L.sheets([{ w: 100, h: 100 }], { ...base, anchor: a }, A4, none);
    const it = sh.items[0];
    near(it.w, 190, 'fit width');
    const ay = Math.floor(a / 3) / 2;
    near(it.y, 10 + (277 - 190) * ay, 'y for anchor ' + a);
    near(it.x, 10, 'x (fills width)');
  }
});

t('custom % grows from the anchor point', () => {
  const o = { ...base, mode: 'custom', anchor: 4 };
  const s50 = L.sheets([{ w: 100, h: 100 }], { ...o, pct: 50 }, A4, none)[0].items[0];
  const s80 = L.sheets([{ w: 100, h: 100 }], { ...o, pct: 80 }, A4, none)[0].items[0];
  near(s50.x + s50.w / 2, s80.x + s80.w / 2, 'same centre x');
  near(s50.y + s50.h / 2, s80.y + s80.h / 2, 'same centre y');
  const b50 = L.sheets([{ w: 100, h: 100 }], { ...o, pct: 50, anchor: 8 }, A4, none)[0].items[0];
  near(b50.x + b50.w, 200, 'bottom right: right edge on the margin');
  near(b50.y + b50.h, 287, 'bottom right: bottom edge on the margin');
});

t('margins in mm, separate', () => {
  const [sh] = L.sheets([{ w: 210, h: 297 }], { ...base, m: { t: 30, r: 5, b: 15, l: 25 }, anchor: 0 }, A4, none);
  near(sh.area.x, 25, 'area x'); near(sh.area.y, 30, 'area y'); near(sh.area.w, 180, 'area w'); near(sh.area.h, 252, 'area h');
  const it = sh.items[0];
  assert.ok(it.x >= 25 - 1e-9 && it.y >= 30 - 1e-9 && it.x + it.w <= 205 + 1e-9 && it.y + it.h <= 282 + 1e-9, 'inside margins');
});

t('auto orientation, 2 and 4 per sheet', () => {
  assert.strictEqual(L.sheets([{ w: 300, h: 200 }], base, A4, none)[0].landscape, true);
  const two = L.sheets([{ w: 210, h: 297 }, { w: 210, h: 297 }, { w: 210, h: 297 }], { ...base, nup: 2 }, A4, none);
  assert.strictEqual(two.length, 2); assert.strictEqual(two[0].landscape, true); assert.strictEqual(two[0].items.length, 2);
  const it = two[0].items;
  assert.ok(it[0].x + it[0].w <= it[1].x - L.GUTTER + 1e-9, 'side by side with a gap');
  const four = L.sheets(Array(5).fill({ w: 210, h: 297 }), { ...base, nup: 4 }, A4, none);
  assert.strictEqual(four.length, 2); assert.strictEqual(four[0].landscape, false); assert.strictEqual(four[1].items.length, 1);
});

t('nudge moves page and clip together', () => {
  const a = L.sheets([{ w: 50, h: 50 }], { ...base, mode: 'actual' }, A4, none)[0].items[0];
  const b = L.sheets([{ w: 50, h: 50 }], { ...base, mode: 'actual', offX: 2, offY: -1.5 }, A4, none)[0].items[0];
  near(b.x - a.x, 2, 'x'); near(b.y - a.y, -1.5, 'y'); near(b.clip.x - a.clip.x, 2, 'clip x');
});

t('warnings: unreachable edge and trimming', () => {
  const hp = { t: 3, r: 3.2, b: 12.7, l: 3.2 };
  const ok = L.check(L.sheets([{ w: 100, h: 100 }], base, A4, hp));
  assert.strictEqual(ok.lost, 0); assert.strictEqual(ok.trimmed, 0);
  const low = L.check(L.sheets([{ w: 210, h: 297 }], { ...base, m: { t: 0, r: 0, b: 0, l: 0 } }, A4, hp));
  near(low.lost, 12.7, 'bottom edge lost');
  const big = L.check(L.sheets([{ w: 210, h: 297 }], { ...base, mode: 'actual' }, A4, none));
  near(big.trimmed, 10, 'true-size A4 inside 10 mm margins is trimmed 10 mm');
  assert.strictEqual(L.check(L.sheets([{ w: 10, h: 10 }], { ...base, m: { t: 150, r: 10, b: 150, l: 10 } }, A4, none)).valid, false);
});

t('landscape turns the unreachable edge', () => {
  assert.deepStrictEqual(L.hardFor({ t: 1, r: 2, b: 3, l: 4 }, true), { t: 2, r: 3, b: 4, l: 1 });
});

t('pages field', () => {
  assert.deepStrictEqual(L.parsePages('All', 4), [0, 1, 2, 3]);
  assert.deepStrictEqual(L.parsePages('', 2), [0, 1]);
  assert.deepStrictEqual(L.parsePages('1-3, 5', 6), [0, 1, 2, 4]);
  assert.deepStrictEqual(L.parsePages('3-1', 3), [0, 1, 2]);
  assert.strictEqual(L.parsePages('7', 3), null);
  assert.strictEqual(L.parsePages('abc', 3), null);
});

t('both sides by hand', () => {
  const s = ['a', 'b', 'c'];
  const p = L.passes(s, 2, true, true);
  assert.deepStrictEqual(p.fronts, ['a', 'c', 'a', 'c']);
  assert.deepStrictEqual(p.backs, [null, 'b', null, 'b']);
  assert.strictEqual(p.paper, 4); assert.strictEqual(p.copies, 1); assert.strictEqual(p.blanks, 2);
  const q = L.passes(['a', 'b'], 1, true, false);
  assert.deepStrictEqual(q.fronts, ['a']); assert.deepStrictEqual(q.backs, ['b']);
  const one = L.passes(['a'], 3, true, true);
  assert.deepStrictEqual(one.backs, []); assert.strictEqual(one.copies, 3); assert.strictEqual(one.oneSided, true);
  const plain = L.passes(s, 2, false, true);
  assert.strictEqual(plain.paper, 6); assert.strictEqual(plain.copies, 2);
});

t('pack: real size, rows, cut lines, new sheet when full', () => {
  const receipts = Array.from({ length: 7 }, (_, i) => ({ w: 80, h: 150 + (i % 3) * 20 }));
  const out = L.sheets(receipts, { ...base, nup: 'pack', mode: 'actual', anchor: 0 }, A4, none);
  assert.strictEqual(out.length, 4);
  assert.deepStrictEqual(out.map((s) => s.items.length), [2, 2, 2, 1]);
  const [a, b] = out[0].items;
  near(a.w, 80, 'true size'); near(a.x, 10, 'top-left anchor'); near(b.x, 10 + 80 + L.PACK_GAP, 'gap between');
  assert.ok(out[0].lines.length >= 5, 'cut lines');
  const cards = L.sheets(Array(10).fill({ w: 85.6, h: 54 }), { ...base, nup: 'pack', mode: 'actual', anchor: 0 }, A4, none);
  assert.deepStrictEqual(cards.map((s) => s.items.length), [8, 2]); // 2 across, 4 down inside 10 mm margins
  const big = L.sheets([{ w: 300, h: 400 }], { ...base, nup: 'pack', mode: 'actual' }, A4, none);
  assert.strictEqual(big[0].shrunk, 1); assert.ok(big[0].items[0].w <= 190 + 1e-6);
});

console.log(`${n} print layout checks passed`);
