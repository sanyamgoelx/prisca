// Prisca: printer alignment check.
// Print a test page with five dots at known places, scan it back, and measure
// where the dots really landed against the paper's own edges in the scan (so the
// scanner's own offset cancels out). The difference is this printer's offset;
// Prisca shifts every print by it from then on.
'use strict';

const Align = (() => {
  const M = 30;          // dots sit 30 mm in from the edges
  const DOT = 6;         // dot diameter, mm
  const MARK = 3;        // the small dot that marks the top-left corner
  const MARK_GAP = 14;   // mm from the top-left dot to the small one
  const MAX_SHIFT = 8;   // anything bigger isn't a printer offset

  const targets = (W, H) => ({ tl: [M, M], tr: [W - M, M], bl: [M, H - M], br: [W - M, H - M], mark: [M + MARK_GAP, M] });

  // ---------- The test page ----------
  function makePage(W, H, dpi, printer) {
    const k = dpi / 25.4;
    const c = Imaging.makeCanvas(Math.round(W * k), Math.round(H * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    const t = targets(W, H);
    const dot = ([x, y], d) => { g.beginPath(); g.arc(x * k, y * k, (d / 2) * k, 0, Math.PI * 2); g.fill(); };
    for (const key of ['tl', 'tr', 'bl', 'br']) dot(t[key], DOT);
    dot(t.mark, MARK);
    // Words and a ruler in the middle only: the strips between the dots and the edges stay blank.
    const text = (s, y, size, weight = 400) => { g.font = `${weight} ${size * k}px sans-serif`; g.textAlign = 'center'; g.fillText(s, (W / 2) * k, y * k); };
    text('Prisca alignment check', 70, 8, 600);
    text(printer || '', 82, 4.5);
    text('1. Put this page face down on the scanner glass, any way round.', 104, 4.2);
    text('2. Keep one top or bottom edge about 2 cm in from the edge of the glass,', 112, 4.2);
    text('   and one side edge clear of the glass edge too.', 119, 4.2);
    text('3. Leave the lid OPEN, so the paper’s edges show against the dark.', 127, 4.2);
    text('4. In Prisca, press Scan the test page.', 135, 4.2);
    // A 100 mm ruler, for people.
    const rx = W / 2 - 50, ry = 160;
    g.lineWidth = 0.25 * k;
    g.strokeStyle = '#000';
    g.beginPath(); g.moveTo(rx * k, ry * k); g.lineTo((rx + 100) * k, ry * k);
    for (let i = 0; i <= 100; i++) { const len = i % 10 === 0 ? 5 : i % 5 === 0 ? 3.5 : 2; g.moveTo((rx + i) * k, ry * k); g.lineTo((rx + i) * k, (ry + len) * k); }
    g.stroke();
    g.font = `${3 * k}px sans-serif`;
    for (let i = 0; i <= 100; i += 10) g.fillText(String(i / 10), (rx + i) * k, (ry + 10) * k);
    text('cm', ry + 16, 3);
    text(`Each dot is ${M} mm from the paper's edges when the printer is spot on.`, 200, 3.5);
    return c;
  }

  // ---------- Reading the scan ----------
  function grey(bitmap) {
    const c = Imaging.makeCanvas(bitmap.width, bitmap.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const L = new Uint8Array(c.width * c.height);
    for (let i = 0, j = 0; i < L.length; i++, j += 4) L[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    c.width = c.height = 0;
    return { L, w: bitmap.width, h: bitmap.height };
  }

  // Dark blobs that don't touch the border (the dark background with the lid open does).
  function blobs(img, dark = 110) {
    const { L, w, h } = img;
    const lab = new Int32Array(w * h);
    const out = [];
    const stack = new Int32Array(w * h);
    let next = 1;
    for (let s = 0; s < L.length; s++) {
      if (lab[s] || L[s] >= dark) continue;
      let sp = 0, area = 0, sx = 0, sy = 0, wsum = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, edge = false;
      stack[sp++] = s; lab[s] = next;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p - x) / w;
        // Weighted by darkness, for a sub-pixel centre.
        const wt = dark - L[p];
        area++; sx += x * wt; sy += y * wt; wsum += wt;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        if (area > 200000) edge = true;
        if (x > 0 && !lab[p - 1] && L[p - 1] < dark) { lab[p - 1] = next; stack[sp++] = p - 1; }
        if (x < w - 1 && !lab[p + 1] && L[p + 1] < dark) { lab[p + 1] = next; stack[sp++] = p + 1; }
        if (y > 0 && !lab[p - w] && L[p - w] < dark) { lab[p - w] = next; stack[sp++] = p - w; }
        if (y < h - 1 && !lab[p + w] && L[p + w] < dark) { lab[p + w] = next; stack[sp++] = p + w; }
      }
      next++;
      if (edge || area < 20) continue;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      out.push({ area, x: sx / wsum, y: sy / wsum, fill: area / (bw * bh), aspect: bw / bh });
    }
    return out;
  }

  function sample(img, x, y) {
    const { L, w, h } = img;
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return -1;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (L[i] * (1 - fx) + L[i + 1] * fx) * (1 - fy) + (L[i + w] * (1 - fx) + L[i + w + 1] * fx) * fy;
  }
  const median = (a) => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };

  // Distance (px) from a point along dir to where white paper meets the dark background.
  // null when the paper runs off the scan (that edge isn't visible).
  function edgeAlong(img, from, dir, k) {
    const step = 0.5, start = 5 * k, end = 70 * k;
    const prof = [];
    for (let t = 0; t <= end; t += step) {
      const v = sample(img, from[0] + dir[0] * t, from[1] + dir[1] * t);
      if (v < 0) break;
      prof.push(v);
    }
    const i0 = Math.round(start / step), i1 = Math.round((12 * k) / step);
    if (prof.length <= i1) return null;
    const paper = median(prof.slice(i0, i1));
    if (!(paper > 140)) return null;
    const thr = paper * 0.55;
    const run = Math.max(2, Math.round(k / step)); // dark for at least 1 mm
    for (let i = i0; i + run < prof.length; i++) {
      if (prof[i] >= thr && prof[i + 1] < thr) {
        let dark = true;
        for (let j = 1; j <= run; j++) if (prof[i + j] >= thr) { dark = false; break; }
        if (!dark) continue;
        const f = (prof[i] - thr) / (prof[i] - prof[i + 1]);
        return (i + f) * step;
      }
    }
    return null;
  }
  // The same edge along a few parallel lines (the median), so a speck of dust can't fool it.
  function edge(img, from, dir, k) {
    const perp = [-dir[1], dir[0]];
    const hits = [];
    for (const off of [-8, -4, 0, 4, 8]) {
      const d = edgeAlong(img, [from[0] + perp[0] * off * k, from[1] + perp[1] * off * k], dir, k);
      if (d != null) hits.push(d);
    }
    return hits.length >= 3 ? median(hits) : null;
  }

  const sub = (a, b) => [a.x - b.x, a.y - b.y];
  const len = (v) => Math.hypot(v[0], v[1]);
  const unit = (v) => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };

  // bitmap: the raw scan; dpi: its resolution; W, H: the paper (mm) it was printed on.
  function analyse(bitmap, dpi, W, H) {
    const k = dpi / 25.4;
    const img = grey(bitmap);
    const found = blobs(img).filter((b) => b.fill > 0.6 && b.fill < 0.92 && b.aspect > 0.75 && b.aspect < 1.33);
    const aBig = Math.PI * ((DOT / 2) * k) ** 2, aSmall = Math.PI * ((MARK / 2) * k) ** 2;
    const bigs = found.filter((b) => b.area > aBig * 0.55 && b.area < aBig * 1.6);
    const smalls = found.filter((b) => b.area > aSmall * 0.45 && b.area < aSmall * 1.8);
    const fail = (reason) => ({ ok: false, reason });
    if (bigs.length < 2) return fail('Couldn’t find the test page’s dots. Is it the Prisca test page, face down on the glass?');
    // The top-left dot has the small one 14 mm away.
    let tl = null, mark = null;
    for (const s of smalls) for (const b of bigs) {
      const d = len(sub(s, b)) / k;
      if (Math.abs(d - MARK_GAP) < MARK_GAP * 0.25 && (!tl || Math.abs(d - MARK_GAP) < Math.abs(len(sub(mark, tl)) / k - MARK_GAP))) { tl = b; mark = s; }
    }
    if (!tl) return fail('Couldn’t find the corner mark on the test page. Make sure the top-left corner of the page is on the glass.');
    let u = unit(sub(mark, tl));
    const near = (want, dir, dist) => bigs.find((b) => b !== tl && Math.abs(len(sub(b, tl)) / k - dist) < dist * 0.04 && (() => { const v = unit(sub(b, tl)); return v[0] * dir[0] + v[1] * dir[1] > 0.995; })());
    const tr = near('tr', u, W - 2 * M);
    if (tr) u = unit(sub(tr, tl));
    const v = [-u[1], u[0]]; // down the page (a face-down page is never mirrored)
    const bl = near('bl', v, H - 2 * M);
    const br = tr && bl ? bigs.find((b) => b !== tr && b !== bl && Math.abs(len(sub(b, tl)) / k - Math.hypot(W - 2 * M, H - 2 * M)) < 2) : null;
    const neg = (d) => [-d[0], -d[1]];
    const at = (b) => [b.x, b.y];
    // Where each dot is from each visible edge, turned into "how far off" (mm, + = right / down).
    const dx = [], dy = [], skews = [];
    const left = [], top = [];
    for (const [b, which] of [[tl, 'tl'], [bl, 'bl']]) if (b) { const d = edge(img, at(b), neg(u), k); if (d != null) { dx.push(d / k - M); left.push({ d, b }); } }
    for (const [b, which] of [[tr, 'tr'], [br, 'br']]) if (b) { const d = edge(img, at(b), u, k); if (d != null) dx.push(M - d / k); }
    for (const [b] of [[tl], [tr]]) if (b) { const d = edge(img, at(b), neg(v), k); if (d != null) { dy.push(d / k - M); top.push({ d, b }); } }
    for (const [b] of [[bl], [br]]) if (b) { const d = edge(img, at(b), v, k); if (d != null) dy.push(M - d / k); }
    if (left.length === 2) skews.push(Math.atan2(left[1].d - left[0].d, len(sub(left[1].b, left[0].b))) * 180 / Math.PI);
    if (top.length === 2) skews.push(Math.atan2(top[0].d - top[1].d, len(sub(top[1].b, top[0].b))) * 180 / Math.PI);
    if (!dx.length && !dy.length) return fail('Couldn’t see the paper’s edges. Scan with the lid open, with the page’s top edge about 2 cm in from the edge of the glass.');
    if (!dx.length) return fail('Couldn’t see either side edge of the paper. Slide the page so one side is clear of the glass edge, lid open, and scan again.');
    if (!dy.length) return fail('Couldn’t see the top or bottom edge of the paper. Move the page about 2 cm in from the edge of the glass, lid open, and scan again.');
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const r = {
      ok: true, dx: mean(dx), dy: mean(dy), skew: skews.length ? mean(skews) : 0,
      edges: { sides: dx.length, tops: dy.length }, spread: Math.max(spreadOf(dx), spreadOf(dy)),
    };
    if (Math.abs(r.dx) > MAX_SHIFT || Math.abs(r.dy) > MAX_SHIFT) return fail(`That reads as ${fmt(r.dx)} / ${fmt(r.dy)} mm off, more than a printer drifts. Check it’s this printer’s test page and scan again.`);
    return r;
  }
  const spreadOf = (a) => (a.length > 1 ? Math.max(...a) - Math.min(...a) : 0);
  const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);

  // The correction for one sheet: shift everything the other way. Landscape sheets are
  // turned a quarter turn anticlockwise on the paper (as Windows does).
  function shiftFor(cal, landscape) {
    if (!cal) return { x: 0, y: 0 };
    return landscape ? { x: -cal.dy, y: cal.dx } : { x: -cal.dx, y: -cal.dy };
  }
  // "0.8 mm right, 1.1 mm up" (where prints landed before the correction).
  function describe(dx, dy) {
    const part = (n, pos, neg) => (Math.abs(n) < 0.05 ? '' : `${fmt(Math.abs(n))} mm ${n > 0 ? pos : neg}`);
    return [part(dx, 'right', 'left'), part(dy, 'low', 'high')].filter(Boolean).join(', ') || 'spot on';
  }

  return { M, DOT, MARK, MARK_GAP, targets, makePage, analyse, shiftFor, describe, fmt, _blobs: blobs };
})();
if (typeof module !== 'undefined') module.exports = { Align };
