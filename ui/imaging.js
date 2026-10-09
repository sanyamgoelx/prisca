// Prisca image processing: straighten, crop, levels, adjustments.
// Everything works on canvases in the window; no libraries.
'use strict';

const Imaging = (() => {
  const DEG = Math.PI / 180;

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // Size of the picture after the quarter turns.
  function turnedSize(src, rot) {
    const q = ((rot % 360) + 360) % 360;
    return q === 90 || q === 270 ? { w: src.height, h: src.width } : { w: src.width, h: src.height };
  }

  // Draws the source turned by rot (quarter turns) + skew (degrees), cropped to
  // crop (0..1 of the turned frame), scaled so the long side is at most maxDim.
  function geometry(src, { rot = 0, skew = 0, crop = null, maxDim = Infinity }) {
    const T = turnedSize(src, rot);
    const c = crop || { x: 0, y: 0, w: 1, h: 1 };
    const cw = c.w * T.w, ch = c.h * T.h;
    const s = Math.min(1, maxDim / Math.max(cw, ch));
    const out = makeCanvas(cw * s, ch * s);
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(-c.x * T.w * s, -c.y * T.h * s);
    ctx.translate((T.w * s) / 2, (T.h * s) / 2);
    ctx.rotate((rot + skew) * DEG);
    ctx.scale(s, s);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return out;
  }

  function luminance(data) {
    const n = data.length / 4;
    const L = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      L[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    }
    return L;
  }

  function greyOf(canvas) {
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    return { L: luminance(d.data), w: canvas.width, h: canvas.height };
  }

  // ---------- Straighten ----------
  // Finds the angle that makes text lines horizontal (projection profile).
  // Pages without text (photos, cards) fall back to their long edges.
  function detectSkew(src) {
    const g = greyOf(geometry(src, { maxDim: 900 }));
    const { L, w, h } = g;
    const bx = Math.round(w * 0.03), by = Math.round(h * 0.03);
    let sum = 0, cnt = 0;
    for (let y = by; y < h - by; y += 2) for (let x = bx; x < w - bx; x += 2) { sum += L[y * w + x]; cnt++; }
    const mean = sum / Math.max(1, cnt);
    const thr = Math.min(mean - 50, 140);
    let xs = [], ys = [];
    for (let y = by; y < h - by; y++) {
      for (let x = bx; x < w - bx; x++) {
        if (L[y * w + x] < thr) { xs.push(x - w / 2); ys.push(y - h / 2); }
      }
    }
    const text = xs.length >= 300 ? profileAngle(xs, ys, w, h, 1.04) : null;
    if (text !== null) return text;
    // Edges: points where brightness steps up or down vertically (horizontal edges).
    const B = blur3(L, w, h);
    xs = []; ys = [];
    for (let y = by; y < h - by; y++) {
      for (let x = bx; x < w - bx; x++) {
        const i = y * w + x;
        if (Math.abs(B[i + w] - B[i - w]) > 30) { xs.push(x - w / 2); ys.push(y - h / 2); }
      }
    }
    if (xs.length < 200) return 0;
    const edge = profileAngle(xs, ys, w, h, 1.08);
    return edge === null ? 0 : edge;
  }

  // Angle (degrees, to turn the picture by) at which the points line up best
  // in rows; null when no angle is clearly better than leaving it.
  function profileAngle(xs, ys, w, h, minGain) {
    const step = Math.max(1, Math.floor(xs.length / 60000));
    const diag = Math.ceil(Math.hypot(w, h));
    const bins = new Float64Array(diag * 2 + 2);
    const score = (deg) => {
      bins.fill(0);
      const a = deg * DEG, sn = Math.sin(a), cs = Math.cos(a);
      for (let i = 0; i < xs.length; i += step) bins[Math.round(xs[i] * sn + ys[i] * cs) + diag]++;
      let s = 0;
      for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i];
      return s;
    };
    let best = 0, bestScore = -1;
    for (let d = -8; d <= 8.001; d += 0.5) { const s = score(d); if (s > bestScore) { bestScore = s; best = d; } }
    const coarse = best;
    for (let d = coarse - 0.5; d <= coarse + 0.501; d += 0.05) { const s = score(d); if (s > bestScore) { bestScore = s; best = d; } }
    const flat = score(0);
    if (bestScore < flat * minGain) return null;
    if (Math.abs(best) < 0.1) return 0;
    return Math.round(best * 100) / 100;
  }

  // ---------- Crop ----------
  // Finds the page on the scanner bed: the box around every clear edge
  // (paper edge shadow, text, pictures), ignoring the bed's own borders.
  function detectCrop(src, rot, skew) {
    const g = greyOf(geometry(src, { rot, skew, maxDim: 700 }));
    const { L, w, h } = g;
    // Where the bed picture lies after turning (dark = inside), so the turned
    // picture's own borders don't count as edges.
    const solid = makeCanvas(src.width, src.height);
    const sctx = solid.getContext('2d');
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, solid.width, solid.height);
    const M = greyOf(geometry(solid, { rot, skew, maxDim: 700 })).L;
    const bx = Math.max(2, Math.round(w * 0.012)), by = Math.max(2, Math.round(h * 0.012));
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && M[y * w + x] < 128;
    const rowHits = new Uint32Array(h), colHits = new Uint32Array(w);
    for (let y = by; y < h - by; y++) {
      for (let x = bx; x < w - bx; x++) {
        const i = y * w + x;
        if (!(inside(x - bx, y) && inside(x + bx, y) && inside(x, y - by) && inside(x, y + by))) continue;
        const gx = Math.abs(L[i + 1] - L[i - 1]);
        const gy = Math.abs(L[i + w] - L[i - w]);
        if (gx + gy > 36) { rowHits[y]++; colHits[x]++; }
      }
    }
    const minHits = 2;
    let top = -1, bottom = -1, left = -1, right = -1;
    for (let y = 0; y < h; y++) if (rowHits[y] >= minHits) { top = y; break; }
    for (let y = h - 1; y >= 0; y--) if (rowHits[y] >= minHits) { bottom = y; break; }
    for (let x = 0; x < w; x++) if (colHits[x] >= minHits) { left = x; break; }
    for (let x = w - 1; x >= 0; x--) if (colHits[x] >= minHits) { right = x; break; }
    const full = { x: 0, y: 0, w: 1, h: 1 };
    if (top < 0 || left < 0) return full;

    // Paper edges: often only a few levels brighter or darker than the lid,
    // below the noise pixel by pixel, but straight and long (the page is already
    // straightened). Summing the signed step along each column/row brings them out.
    // A side with no edge means the paper reaches the bed edge (or can't be told
    // apart): keep the bed there rather than cut the page.
    const B = blur3(L, w, h);
    const colSum = new Float64Array(w), colN = new Uint32Array(w);
    const rowSum = new Float64Array(h), rowN = new Uint32Array(h);
    const k = 2;
    const m2 = 4; // the bed's own border artefacts are thin
    for (let y = m2 + k; y < h - m2 - k; y++) {
      for (let x = m2 + k; x < w - m2 - k; x++) {
        if (!(inside(x - m2 - k, y) && inside(x + m2 + k, y) && inside(x, y - m2 - k) && inside(x, y + m2 + k))) continue;
        const i = y * w + x;
        colSum[x] += B[i + k] - B[i - k]; colN[x]++;
        rowSum[y] += B[i + k * w] - B[i - k * w]; rowN[y]++;
      }
    }
    // Normalise by the full length so a short streak can't pass for a page edge.
    const colSig = (x) => Math.abs(colSum[x]) / Math.max(1, h);
    const rowSig = (y) => Math.abs(rowSum[y]) / Math.max(1, w);
    const T = 1.1, gap = Math.round(Math.max(w, h) * 0.006);
    const peak = (from, to, sig) => {
      let best = -1, bestV = T;
      const a = Math.min(from, to), b = Math.max(from, to);
      for (let v = a; v <= b; v++) { const s = sig(v); if (s > bestV) { bestV = s; best = v; } }
      return best;
    };
    const edgeL = peak(0, left - gap, colSig), edgeR = peak(right + gap, w - 1, colSig);
    const edgeT = peak(0, top - gap, rowSig), edgeB = peak(bottom + gap, h - 1, rowSig);
    // No faint edge outside the content: if the content itself has a solid
    // border (a photo, a dark card), that border is the edge; otherwise
    // (text on paper) the paper reaches further, so keep the bed.
    const median = (x0, x1, y0, y1) => {
      const hist = new Uint32Array(256);
      let n = 0;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { if (!inside(x, y)) continue; hist[L[y * w + x]]++; n++; }
      if (!n) return -1;
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) return v; }
      return 255;
    };
    const s = Math.max(4, Math.round(Math.max(w, h) * 0.02));
    const isSolid = (a, b) => a >= 0 && b >= 0 && Math.abs(a - b) > 22;
    const cL = left, cR = right, cT = top, cB = bottom;
    // Bed borders often carry a dark strip: step past it when the page runs to the edge.
    const lineMean = (isCol, v) => {
      let s2 = 0, n2 = 0;
      const len = isCol ? h : w;
      for (let u = 0; u < len; u += 2) {
        const x = isCol ? v : u, y = isCol ? u : v;
        if (!inside(x, y)) continue;
        s2 += L[y * w + x]; n2++;
      }
      return n2 ? s2 / n2 : -1;
    };
    const ref = median(cL, cR, cT, cB);
    const pastStrip = (isCol, from, dir) => {
      const lim = Math.round((isCol ? w : h) * 0.025);
      for (let d = 0; d < lim; d++) {
        const v = from + dir * d;
        const m = lineMean(isCol, v);
        if (m >= 0 && m > ref - 25) return v;
      }
      return from;
    };
    left = edgeL >= 0 ? edgeL : isSolid(median(cL + 2, cL + 2 + s, cT, cB), median(cL - 2 - s, cL - 2, cT, cB)) ? cL : pastStrip(true, 0, 1);
    right = edgeR >= 0 ? edgeR : isSolid(median(cR - 2 - s, cR - 2, cT, cB), median(cR + 2, cR + 2 + s, cT, cB)) ? cR : pastStrip(true, w - 1, -1);
    top = edgeT >= 0 ? edgeT : isSolid(median(cL, cR, cT + 2, cT + 2 + s), median(cL, cR, cT - 2 - s, cT - 2)) ? cT : pastStrip(false, 0, 1);
    bottom = edgeB >= 0 ? edgeB : isSolid(median(cL, cR, cB - 2 - s, cB - 2), median(cL, cR, cB + 2, cB + 2 + s)) ? cB : pastStrip(false, h - 1, -1);
    const bw = right - left, bh = bottom - top;
    if (bw * bh < w * h * 0.03) return full;
    const pad = 1;
    const x0 = Math.max(0, left - pad), y0 = Math.max(0, top - pad);
    const x1 = Math.min(w, right + pad + 1), y1 = Math.min(h, bottom + pad + 1);
    // Nearly the whole bed: keep the whole bed.
    if ((x1 - x0) * (y1 - y0) > w * h * 0.995) return full;
    return { x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
  }

  function blur3(L, w, h) {
    const out = new Uint8Array(L.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        out[i] = (L[i - w - 1] + L[i - w] + L[i - w + 1] + L[i - 1] + L[i] + L[i + 1] + L[i + w - 1] + L[i + w] + L[i + w + 1]) / 9;
      }
    }
    return out;
  }

  // ---------- Levels ----------
  // Black and white points for auto-enhance. Documents push the paper to white;
  // photos only stretch the ends.
  function detectLevels(canvas, kind) {
    const { L } = greyOf(canvas);
    const hist = new Uint32Array(256);
    for (let i = 0; i < L.length; i++) hist[L[i]]++;
    const pct = (p) => {
      const target = L.length * p;
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
      return 255;
    };
    let lo, hi;
    if (kind === 'photo') { lo = pct(0.005); hi = pct(0.995); }
    else {
      lo = pct(0.01);
      // Paper is the brightest big peak; aim just under it.
      let peak = 128, peakCount = 0;
      for (let v = 128; v < 256; v++) if (hist[v] > peakCount) { peakCount = hist[v]; peak = v; }
      hi = Math.max(pct(0.6), peak - 6);
    }
    // A nearly flat picture (blank sheet, empty glass): keep it light, not stretched to black.
    if (hi - lo < 60) { lo = Math.max(0, hi - 120); }
    const out = { lo, hi };
    if (kind !== 'photo') {
      // Paper colour per channel, so cream or grey paper turns white in colour scans.
      const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
      const hc = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      for (let j = 0; j < d.length; j += 4) {
        if (((d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8) < peakOf(hist) - 12) continue;
        hc[0][d[j]]++; hc[1][d[j + 1]]++; hc[2][d[j + 2]]++;
      }
      out.paper = hc.map((hh) => { let pk = 128, pc = 0; for (let v = 128; v < 256; v++) if (hh[v] > pc) { pc = hh[v]; pk = v; } return pc ? Math.max(lo + 60, pk - 6) : hi; });
    }
    return out;
  }

  function peakOf(hist) {
    let peak = 128, c = 0;
    for (let v = 128; v < 256; v++) if (hist[v] > c) { c = hist[v]; peak = v; }
    return peak;
  }

  // ---------- Tone ----------
  function buildLut(adj, levels, hiOverride) {
    const lut = new Uint8ClampedArray(256);
    const C = adj.contrast * 2.55;
    const f = (259 * (C + 255)) / (255 * (259 - C));
    const lo = adj.auto && levels ? levels.lo : 0;
    const hi = adj.auto && levels ? (hiOverride || levels.hi) : 255;
    for (let v = 0; v < 256; v++) {
      let x = ((v - lo) * 255) / Math.max(1, hi - lo);
      x += adj.brightness * 1.28;
      x = f * (x - 128) + 128;
      lut[v] = x;
    }
    return lut;
  }

  // Applies colour mode, levels, brightness/contrast, sharpening and threshold in place.
  function tone(canvas, adj, levels) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width, h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const lut = buildLut(adj, levels);
    const grey = adj.mode !== 'color';
    const amount = (adj.sharpness / 100) * 1.2;

    if (grey) {
      let L = luminance(d);
      for (let i = 0; i < L.length; i++) L[i] = lut[L[i]];
      if (amount > 0.01) L = sharpen1(L, w, h, amount);
      if (adj.mode === 'bw') {
        const t = Math.round(40 + (adj.threshold / 100) * 180);
        for (let i = 0; i < L.length; i++) L[i] = L[i] < t ? 0 : 255;
      }
      for (let i = 0, j = 0; i < L.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = L[i]; d[j + 3] = 255; }
    } else {
      const paper = adj.auto && levels && levels.paper;
      const lr = paper ? buildLut(adj, levels, paper[0]) : lut;
      const lg = paper ? buildLut(adj, levels, paper[1]) : lut;
      const lb = paper ? buildLut(adj, levels, paper[2]) : lut;
      for (let j = 0; j < d.length; j += 4) { d[j] = lr[d[j]]; d[j + 1] = lg[d[j + 1]]; d[j + 2] = lb[d[j + 2]]; }
      if (amount > 0.01) sharpenRGBA(d, w, h, amount);
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function sharpen1(L, w, h, a) {
    const out = new Uint8ClampedArray(L.length);
    const c = 1 + 4 * a;
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : y;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : x;
        const i = y * w + x;
        out[i] = c * L[i] - a * (L[y0 * w + x] + L[y1 * w + x] + L[y * w + x0] + L[y * w + x1]);
      }
    }
    return out;
  }

  function sharpenRGBA(d, w, h, a) {
    const src = new Uint8ClampedArray(d);
    const c = 1 + 4 * a;
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : y;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : x;
        const i = (y * w + x) * 4, n = (y0 * w + x) * 4, s = (y1 * w + x) * 4, wv = (y * w + x0) * 4, e = (y * w + x1) * 4;
        for (let k = 0; k < 3; k++) {
          d[i + k] = c * src[i + k] - a * (src[n + k] + src[s + k] + src[wv + k] + src[e + k]);
        }
      }
    }
  }

  // The finished page at a given size (Infinity = full resolution).
  function render(page, maxDim) {
    const c = geometry(page.bitmap, { rot: page.rot, skew: page.skew, crop: page.crop, maxDim });
    return tone(c, page.adj, page.levels);
  }

  function refreshLevels(page) {
    const c = geometry(page.bitmap, { rot: page.rot, skew: page.skew, crop: page.crop, maxDim: 600 });
    page.levels = detectLevels(c, page.kind);
  }

  // Straighten + crop + levels for a new page.
  function analyse(page, { autoCrop = true } = {}) {
    page.skew = detectSkew(page.bitmap);
    page.autoSkew = page.skew;
    page.crop = autoCrop ? detectCrop(page.bitmap, page.rot, page.skew) : { x: 0, y: 0, w: 1, h: 1 };
    refreshLevels(page);
  }

  function toBlob(canvas, type, quality) {
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the page'))), type, quality));
  }

  // A sheet with (almost) nothing on it: the back of a one-sided page.
  function isBlank(page) {
    const c = geometry(page.bitmap, { rot: page.rot, skew: page.skew, crop: page.crop, maxDim: 500 });
    tone(c, { mode: 'grey', auto: true, brightness: 0, contrast: 0, sharpness: 0, threshold: 50 }, page.levels);
    const { L, w, h } = greyOf(c);
    // Ignore a margin: shadows and holes at the edges aren't content.
    const mx = Math.round(w * 0.06), my = Math.round(h * 0.06);
    let dark = 0, n = 0;
    for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) { n++; if (L[y * w + x] < 140) dark++; }
    return n > 0 && dark / n < 0.002;
  }

  // Where the ink is on the finished page, blurred to a coarse grid: two scans
  // of the same sheet (not swapped in time) correlate almost perfectly; two
  // different pages of the same layout differ in where their words fall.
  function inkMap(page) {
    const c = geometry(page.bitmap, { rot: page.rot, skew: page.skew, crop: page.crop, maxDim: 240 });
    tone(c, { mode: 'grey', auto: true, brightness: 0, contrast: 0, sharpness: 0, threshold: 50 }, page.levels);
    const s = makeCanvas(48, 64);
    const g = s.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, 48, 64);
    const L = luminance(g.getImageData(0, 0, 48, 64).data);
    return Float64Array.from(L, (v) => 255 - v);
  }
  function samePage(a, b) {
    const x = inkMap(a), y = inkMap(b);
    const n = x.length;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    if (sxx < 1e-6 && syy < 1e-6) return true; // both empty
    const r = sxy / Math.sqrt(sxx * syy + 1e-9);
    return r > 0.975;
  }

  return { isBlank, samePage, geometry, turnedSize, detectSkew, detectCrop, detectLevels, refreshLevels, analyse, render, tone, toBlob, makeCanvas };
})();
