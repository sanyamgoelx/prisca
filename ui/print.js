// Prisca: the Print panel.
// Prisca lays out every sheet itself (margins in mm, size, anchor, pages per
// sheet) and the helper prints exactly that rectangle with Windows' own
// printing, so the preview, the warnings and the paper all come from the same
// numbers (PrintLayout.sheets).
'use strict';

// ---------- Layout maths (no DOM; also used by the tests) ----------
const PrintLayout = (() => {
  const GUTTER = 6; // mm between pages when several share a sheet
  const ANCHORS = ['Top left', 'Top centre', 'Top right', 'Middle left', 'Centre', 'Middle right', 'Bottom left', 'Bottom centre', 'Bottom right'];

  // The edge the printer can't reach, for a sheet turned to landscape.
  // Windows turns landscape pages a quarter turn anticlockwise. Printing itself
  // uses the offsets the driver reports for the real orientation; this is only
  // for the preview and the warnings.
  function hardFor(hard, landscape) {
    return landscape ? { t: hard.r, r: hard.b, b: hard.l, l: hard.t } : { ...hard };
  }

  function scaleFor(o, pg, cw, ch) {
    if (o.mode === 'fit') return Math.min(cw / pg.w, ch / pg.h);
    if (o.mode === 'fill') return Math.max(cw / pg.w, ch / pg.h);
    if (o.mode === 'custom') return o.pct / 100;
    return 1; // true size
  }

  // pages: [{ w, h } in mm, + anything else, passed through as item.page]
  // o: print options; paper: { w, h } mm (portrait); hard: { t, r, b, l } mm (portrait)
  const PACK_GAP = 4; // mm between packed pages (where you cut)
  // Several small pages (receipts, cards) at their real size, as many as fit, row by
  // row in order, with dashed cut lines between them. The block sits at the anchor.
  function packSheets(pages, o, paper, hard) {
    const land = o.orient === 'land';
    const P = { w: Math.min(paper.w, paper.h), h: Math.max(paper.w, paper.h) };
    const pw = land ? P.h : P.w, ph = land ? P.w : P.h;
    const m = o.m;
    const area = { x: m.l, y: m.t, w: pw - m.l - m.r, h: ph - m.t - m.b };
    const sc = o.mode === 'custom' ? o.pct / 100 : 1;
    const ax = (o.anchor % 3) / 2, ay = Math.floor(o.anchor / 3) / 2;
    const out = [];
    let rows = [], row = null, y = 0, shrunk = 0;
    const flush = () => {
      if (!rows.length) return;
      const bw = Math.max(...rows.map((r) => r.w)), bh = rows.reduce((s2, r, i) => s2 + r.h + (i ? PACK_GAP : 0), 0);
      const ox = area.x + (area.w - bw) * ax + o.offX, oy = area.y + (area.h - bh) * ay + o.offY;
      const items = [], lines = [];
      let yy = 0;
      rows.forEach((r, ri) => {
        let xx = 0;
        r.items.forEach((it, ii) => {
          const x = ox + xx, yv = oy + yy;
          items.push({ page: it.pg, scale: it.s, x, y: yv, w: it.w, h: it.h, clip: { x, y: yv, w: it.w, h: it.h }, anchor: null });
          if (ii) lines.push([x - PACK_GAP / 2, oy + yy, x - PACK_GAP / 2, oy + yy + r.h]);
          xx += it.w + PACK_GAP;
        });
        if (ri) lines.push([ox, oy + yy - PACK_GAP / 2, ox + bw, oy + yy - PACK_GAP / 2]);
        yy += r.h + PACK_GAP;
      });
      // Cut lines around the whole block too.
      const g = PACK_GAP / 2;
      lines.push([ox - g, oy - g, ox + bw + g, oy - g], [ox - g, oy + bh + g, ox + bw + g, oy + bh + g], [ox - g, oy - g, ox - g, oy + bh + g], [ox + bw + g, oy - g, ox + bw + g, oy + bh + g]);
      if (items.length) items[0].anchor = { x: area.x + area.w * ax + o.offX, y: area.y + area.h * ay + o.offY };
      out.push({ landscape: land, pw, ph, hard: hardFor(hard, land), area, items, lines, packed: true, valid: area.w >= 5 && area.h >= 5 });
      rows = []; row = null; y = 0;
    };
    for (const pg of pages) {
      let s2 = sc, w = pg.w * s2, h = pg.h * s2;
      // Bigger than the space inside the margins: just that page shrinks to fit.
      if (w > area.w || h > area.h) { s2 = Math.min(area.w / pg.w, area.h / pg.h) * 0.999; w = pg.w * s2; h = pg.h * s2; shrunk++; }
      if (row && row.w + PACK_GAP + w > area.w + 1e-6) { y += row.h + PACK_GAP; row = null; }
      if (!row && y > 0 && y + h > area.h + 1e-6) flush();
      if (!row) { row = { items: [], w: 0, h: 0 }; rows.push(row); }
      row.items.push({ pg, s: s2, w, h });
      row.w += (row.items.length > 1 ? PACK_GAP : 0) + w;
      row.h = Math.max(row.h, h);
    }
    flush();
    if (out.length) out[0].shrunk = shrunk;
    return out;
  }

  function sheets(pages, o, paper, hard) {
    if (o.nup === 'pack') return packSheets(pages, o, paper, hard);
    const per = o.nup === 4 ? 4 : o.nup === 2 ? 2 : 1;
    const P = { w: Math.min(paper.w, paper.h), h: Math.max(paper.w, paper.h) };
    const out = [];
    for (let s = 0; s * per < pages.length; s++) {
      const group = pages.slice(s * per, s * per + per);
      let land;
      if (o.orient === 'land') land = true;
      else if (o.orient === 'port') land = false;
      else if (per === 2) land = true;
      else if (per === 4) land = false;
      else land = group[0].w > group[0].h;
      const pw = land ? P.h : P.w, ph = land ? P.w : P.h;
      const m = o.m;
      const area = { x: m.l, y: m.t, w: pw - m.l - m.r, h: ph - m.t - m.b };
      const cols = per === 1 ? 1 : 2, rows = per === 4 ? 2 : 1;
      const gut = per > 1 ? GUTTER : 0;
      const cw = (area.w - gut * (cols - 1)) / cols, ch = (area.h - gut * (rows - 1)) / rows;
      const ax = (o.anchor % 3) / 2, ay = Math.floor(o.anchor / 3) / 2;
      const items = group.map((pg, i) => {
        const cx = area.x + (i % cols) * (cw + gut) + o.offX;
        const cy = area.y + Math.floor(i / cols) * (ch + gut) + o.offY;
        const sc = scaleFor(o, pg, cw, ch);
        const w = pg.w * sc, h = pg.h * sc;
        return {
          page: pg,
          scale: sc,
          x: cx + (cw - w) * ax, y: cy + (ch - h) * ay, w, h,
          clip: { x: cx, y: cy, w: cw, h: ch },
          anchor: { x: cx + cw * ax, y: cy + ch * ay },
        };
      });
      out.push({ landscape: land, pw, ph, hard: hardFor(hard, land), area, items, valid: cw >= 5 && ch >= 5 });
    }
    return out;
  }

  // What won't come out as shown: trimmed by the margins, or lost at the edge
  // the printer can't reach (or off the paper).
  function check(list) {
    let trimmed = 0, lost = 0, valid = true;
    for (const sh of list) {
      if (!sh.valid) valid = false;
      for (const it of sh.items) {
        const c = it.clip;
        trimmed = Math.max(trimmed, c.x - it.x, c.y - it.y, it.x + it.w - (c.x + c.w), it.y + it.h - (c.y + c.h));
        const x0 = Math.max(it.x, c.x), y0 = Math.max(it.y, c.y);
        const x1 = Math.min(it.x + it.w, c.x + c.w), y1 = Math.min(it.y + it.h, c.y + c.h);
        if (x1 <= x0 || y1 <= y0) continue;
        const hd = sh.hard;
        lost = Math.max(lost, hd.l - x0, hd.t - y0, x1 - (sh.pw - hd.r), y1 - (sh.ph - hd.b));
      }
    }
    return { trimmed: Math.max(0, trimmed), lost: Math.max(0, lost), valid };
  }

  // "All", "" or "1-3, 5" → 0-based page indexes (null when it doesn't make sense).
  function parsePages(text, n) {
    const t = String(text || '').trim().toLowerCase();
    if (!t || t === 'all') return Array.from({ length: n }, (_, i) => i);
    const out = new Set();
    for (const part of t.split(/[,;]+/)) {
      const p = part.trim();
      if (!p) continue;
      const m = p.match(/^(\d+)\s*(?:-|–|to)\s*(\d+)$/) || p.match(/^(\d+)$/);
      if (!m) return null;
      const a = Number(m[1]), b = Number(m[2] || m[1]);
      if (a < 1 || b < 1 || a > n || b > n) return null;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i - 1);
    }
    return out.size ? [...out].sort((x, y) => x - y) : null;
  }

  // Sheets in the order they go through the printer. Without "both sides" the
  // printer makes the copies (collated). With it, each copy is padded to an
  // even number of sheets so every copy starts on a front; fronts go first,
  // then the backs (reversed when the stack goes back in upside down).
  function passes(list, copies, duplex, reverse) {
    // One sheet has nothing to put on a back: print it one-sided.
    if (!duplex || list.length < 2) return { fronts: list, backs: [], copies, paper: list.length * copies, blanks: 0, oneSided: duplex };
    const all = [];
    let blanks = 0;
    for (let c = 0; c < copies; c++) {
      all.push(...list);
      if (list.length % 2) { all.push(null); blanks++; }
    }
    const fronts = all.filter((_, i) => i % 2 === 0);
    let backs = all.filter((_, i) => i % 2 === 1);
    if (reverse) backs = backs.reverse();
    return { fronts, backs, copies: 1, paper: fronts.length, blanks };
  }

  return { ANCHORS, GUTTER, PACK_GAP, sheets, check, parsePages, passes, hardFor };
})();

// ---------- The panel ----------
const PrintPanel = typeof document === 'undefined' ? null : (() => {
  const DEFAULTS = {
    paper: 9, paperName: 'A4', orient: 'auto',
    m: { t: 10, r: 10, b: 10, l: 10 }, linked: true,
    mode: 'fit', pct: 100, anchor: 4, offX: 0, offY: 0,
    nup: 1, ink: 'colour', copies: 1, duplex: false, reverse: true,
  };
  // What a named setup remembers (not the printer, copies or both sides).
  const PROFILE_KEYS = ['paper', 'paperName', 'orient', 'm', 'linked', 'mode', 'pct', 'anchor', 'nup', 'ink'];
  const STARTERS = [
    { name: 'Receipt on A4', opts: { paper: 9, paperName: 'A4', orient: 'port', m: { t: 10, r: 10, b: 10, l: 10 }, linked: true, mode: 'actual', pct: 100, anchor: 1, nup: 1, ink: 'colour' } },
    { name: 'ID card copy', opts: { paper: 9, paperName: 'A4', orient: 'port', m: { t: 25, r: 10, b: 10, l: 10 }, linked: false, mode: 'actual', pct: 100, anchor: 1, nup: 1, ink: 'colour' } },
    { name: 'Receipts packed', opts: { paper: 9, paperName: 'A4', orient: 'port', m: { t: 10, r: 10, b: 15, l: 10 }, linked: false, mode: 'actual', pct: 100, anchor: 0, nup: 'pack', ink: 'grey' } },
    { name: 'On letterhead', opts: { paper: 9, paperName: 'A4', orient: 'port', m: { t: 45, r: 20, b: 25, l: 20 }, linked: false, mode: 'fit', pct: 100, anchor: 1, nup: 1, ink: 'colour' } },
  ];
  const STATE_TEXT = { offline: 'Offline. Windows keeps the job until the printer is on.', nopaper: 'Windows says it’s out of paper.', jam: 'Windows says paper is jammed.', door: 'Windows says a cover is open.', error: 'Windows reports a problem with this printer.', printing: 'Printing something else right now.' };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const num = (v, d = 0) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : d; };
  const r1 = (n) => String(Math.round(n * 10) / 10);
  const cleanOpts = (o) => {
    const x = { ...clone(DEFAULTS), ...(o || {}) };
    x.m = { ...DEFAULTS.m, ...((o && o.m) || {}) };
    for (const k of ['t', 'r', 'b', 'l']) x.m[k] = Math.max(0, Math.min(200, num(x.m[k], 10)));
    if (!['auto', 'port', 'land'].includes(x.orient)) x.orient = 'auto';
    if (!['fit', 'fill', 'actual', 'custom'].includes(x.mode)) x.mode = 'fit';
    if (![1, 2, 4, 'pack'].includes(x.nup)) x.nup = 1;
    if (!['colour', 'grey', 'draft'].includes(x.ink)) x.ink = 'colour';
    x.pct = Math.max(10, Math.min(400, Math.round(num(x.pct, 100))));
    x.anchor = Math.max(0, Math.min(8, Math.round(num(x.anchor, 4))));
    x.offX = Math.max(-50, Math.min(50, num(x.offX))); x.offY = Math.max(-50, Math.min(50, num(x.offY)));
    x.copies = Math.max(1, Math.min(99, Math.round(num(x.copies, 1))));
    x.duplex = !!x.duplex; x.reverse = x.reverse !== false; x.linked = !!x.linked;
    return x;
  };

  // settings.print: { printer, byPrinter: { name: opts }, profiles: [{ name, opts }] }
  function store() {
    const s = settings.print && typeof settings.print === 'object' ? settings.print : {};
    if (!s.byPrinter || typeof s.byPrinter !== 'object') s.byPrinter = {};
    if (!Array.isArray(s.profiles)) s.profiles = clone(STARTERS);
    if (typeof s.printer !== 'string') s.printer = '';
    settings.print = s;
    return s;
  }

  const P = {
    open: false, busy: false, printers: [], printer: '', info: null, infoCache: new Map(),
    opts: cleanOpts(), profile: '', pagesText: 'All', sheet: 0, step: null, naming: false, mode: 'batch', queue: [], queueOpen: false,
    previews: new Map(),
  };
  const el = (id) => document.getElementById(id);

  // ---------- Printers ----------
  async function loadPrinters() {
    try { P.printers = await Backend.printers(); } catch (e) { P.printers = []; toast(e.error || 'Couldn’t list the printers.', { bad: true }); }
    // Prisca's own printer only hands jobs back to Prisca: never print to it from here.
    P.printers = P.printers.filter((p) => p.name !== 'Prisca');
    return P.printers;
  }
  function pickPrinter() {
    const s = store();
    const names = P.printers.map((p) => p.name);
    if (names.includes(s.printer)) return s.printer;
    const def = P.printers.find((p) => p.default);
    return def ? def.name : names[0] || '';
  }
  async function infoFor(name, paper) {
    const key = name + '|' + (paper || 0);
    if (P.infoCache.has(key)) return P.infoCache.get(key);
    const info = await Backend.printerInfo(name, paper || 0);
    info.sizes = Array.isArray(info.sizes) ? info.sizes : info.sizes ? [info.sizes] : [];
    P.infoCache.set(key, info);
    P.infoCache.set(name + '|' + info.paper, info);
    return info;
  }
  // The paper to use on this printer: the saved one if it has it (by kind, then by name), else A4, else its default.
  function matchPaper(info, o) {
    const sizes = info.sizes;
    const byKind = (k) => sizes.find((s) => s.kind === k);
    return byKind(o.paper) || sizes.find((s) => s.name === o.paperName) || byKind(9) || byKind(info.paper) || sizes[0] || null;
  }
  async function usePrinter(name) {
    P.printer = name;
    P.queue = [];
    if (P.open) setTimeout(loadQueue, 0);
    P.info = null;
    P.infoError = '';
    P.opts = cleanOpts(store().byPrinter[name] || DEFAULTS);
    render();
    if (!name) return;
    try {
      let info = await infoFor(name, P.opts.paper);
      const size = matchPaper(info, P.opts);
      if (size && size.kind !== info.paper) info = await infoFor(name, size.kind);
      if (P.printer !== name) return;
      P.info = info;
      if (size) { P.opts.paper = size.kind; P.opts.paperName = size.name; }
    } catch (e) {
      if (P.printer === name) P.infoError = e.error || `Couldn’t read the settings of ${name}.`;
    }
    render();
  }
  async function usePaper(kind) {
    const size = P.info && P.info.sizes.find((s) => s.kind === kind);
    if (!size) return;
    P.opts.paper = kind; P.opts.paperName = size.name;
    changed();
    try {
      const info = await infoFor(P.printer, kind);
      if (P.opts.paper === kind) { P.info = info; render(); }
    } catch (e) { toast(e.error || 'Couldn’t read that paper size.', { bad: true }); }
  }

  // ---------- Saving ----------
  function changed({ keepProfile = false } = {}) {
    if (!keepProfile) P.profile = '';
    const s = store();
    if (P.printer) { s.printer = P.printer; s.byPrinter[P.printer] = clone(P.opts); }
    saveSettings();
    render();
  }

  // ---------- Pages ----------
  // Physical size of a finished page in mm (from its resolution).
  function pageMM(p) {
    const q = ((p.rot % 360) + 360) % 360;
    const W = q === 90 || q === 270 ? p.bitmap.height : p.bitmap.width;
    const H = q === 90 || q === 270 ? p.bitmap.width : p.bitmap.height;
    const dpi = p.dpi > 0 ? p.dpi : 200;
    return { w: (p.crop.w * W * 25.4) / dpi, h: (p.crop.h * H * 25.4) / dpi };
  }
  function selection(list) {
    const pages = list || state.pages;
    const idx = list ? pages.map((_, i) => i) : PrintLayout.parsePages(P.pagesText, pages.length);
    if (!idx) return null;
    return idx.map((i) => ({ ...pageMM(pages[i]), index: i, ref: pages[i], label: `page ${i + 1}` }));
  }
  // Pages to print, in groups that each start on a new sheet: the batch (one group),
  // or the Print job (one group per file, or one for all when files run on).
  function groupsFor(list) {
    if (!list && P.mode === 'job') {
      const gs = Job.groups();
      return Job.breaks() === 'flow' && gs.length ? [gs.flat()] : gs;
    }
    const sel = selection(list);
    return sel ? [sel] : null;
  }
  function paperOf(info, o) {
    const size = info && info.sizes.find((s) => s.kind === o.paper);
    return size ? { w: size.w, h: size.h } : { w: 210, h: 297 };
  }
  const hardOf = (info) => (info && info.hard) || { t: 0, r: 0, b: 0, l: 0 };
  function plan(list, o = P.opts, info = P.info) {
    const gs = groupsFor(list);
    if (!gs) return null;
    const sel = gs.flat();
    if (!sel.length) return null;
    const sheets = gs.flatMap((g) => PrintLayout.sheets(g, o, paperOf(info, o), hardOf(info)));
    return { sel, sheets, check: PrintLayout.check(sheets) };
  }

  function preview(p) {
    const key = prepKey(p);
    const hit = P.previews.get(p.id);
    if (hit && hit.key === key) return hit.url;
    const c = Imaging.render(p, 900);
    const url = c.toDataURL('image/jpeg', 0.85);
    c.width = c.height = 0;
    P.previews.set(p.id, { key, url });
    return url;
  }

  // ---------- Drawing ----------
  function seg(id, value) {
    for (const b of el(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(value)));
  }
  function render() {
    if (!P.open) return;
    const o = P.opts, info = P.info;
    // Printer
    const sel = el('prPrinter');
    sel.innerHTML = P.printers.length ? '' : '<option value="">No printer found</option>';
    for (const p of P.printers) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name + (p.default ? ' (Windows default)' : '');
      sel.appendChild(opt);
    }
    sel.value = P.printer;
    const pr = P.printers.find((p) => p.name === P.printer);
    el('prPrinterState').textContent = !P.printers.length
      ? 'Add a printer in Windows Settings › Bluetooth & devices › Printers & scanners, then open this again.'
      : P.infoError ? `${P.infoError} Pick another printer or open this again.`
      : pr && STATE_TEXT[pr.state] ? STATE_TEXT[pr.state] : info ? 'Every change is saved for this printer.' : 'Reading the printer’s paper sizes…';
    el('prPrinterState').classList.toggle('warn', !!P.infoError || !!(pr && STATE_TEXT[pr.state] && pr.state !== 'printing'));
    // Profiles
    const wrap = el('prProfiles');
    wrap.innerHTML = '';
    store().profiles.forEach((pf, i) => {
      const chip = document.createElement('span');
      chip.className = 'pr-chip';
      chip.setAttribute('aria-pressed', String(P.profile === pf.name));
      const b = document.createElement('button');
      b.textContent = pf.name;
      b.title = 'Use this setup';
      b.onclick = () => applyProfile(pf);
      const x = document.createElement('button');
      x.className = 'pr-chip-x';
      x.setAttribute('aria-label', `Remove ${pf.name}`);
      x.title = 'Remove this setup';
      x.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      x.onclick = () => removeProfile(i);
      chip.append(b, x);
      wrap.appendChild(chip);
    });
    el('prSaveProfile').hidden = P.naming;
    el('prProfileForm').hidden = !P.naming;
    // Paper
    const ps = el('prPaper');
    ps.innerHTML = '';
    for (const s of info ? info.sizes : []) {
      const opt = document.createElement('option');
      opt.value = String(s.kind);
      opt.textContent = `${s.name} · ${r1(s.w)}×${r1(s.h)}`;
      ps.appendChild(opt);
    }
    if (!info) ps.innerHTML = `<option>${o.paperName}</option>`;
    ps.value = String(o.paper);
    ps.disabled = !info;
    seg('prOrient', o.orient);
    // Margins
    for (const k of ['t', 'r', 'b', 'l']) {
      const inp = el('prM' + k.toUpperCase());
      if (document.activeElement !== inp) inp.value = r1(o.m[k]);
    }
    el('prLink').setAttribute('aria-pressed', String(o.linked));
    el('prLinkLabel').textContent = o.linked ? 'linked' : 'separate';
    for (const b of el('prMPresets').querySelectorAll('button')) {
      const v = Number(b.dataset.v);
      b.setAttribute('aria-pressed', String(['t', 'r', 'b', 'l'].every((k) => o.m[k] === v)));
    }
    // Size
    seg('prMode', o.mode);
    el('prPctRow').hidden = o.mode !== 'custom';
    if (document.activeElement !== el('prPct')) el('prPct').value = o.pct;
    el('prPctRange').value = Math.min(200, o.pct);
    // Anchor
    el('prAnchor').querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === o.anchor)));
    el('prAnchorName').textContent = 'Anchored: ' + PrintLayout.ANCHORS[o.anchor].toLowerCase();
    if (document.activeElement !== el('prOffX')) el('prOffX').value = r1(o.offX);
    if (document.activeElement !== el('prOffY')) el('prOffY').value = r1(o.offY);
    // Sheet
    seg('prNup', o.nup);
    seg('prInk', o.ink);
    el('prInk').querySelector('[data-v="colour"]').title = info && !info.color ? 'This printer prints in black only' : '';
    if (document.activeElement !== el('prCopies')) el('prCopies').value = o.copies;
    if (document.activeElement !== el('prPages')) el('prPages').value = P.pagesText;
    el('prPagesField').hidden = P.mode === 'job';
    el('prBreakRow').hidden = P.mode !== 'job';
    seg('prBreak', store().fileBreak === 'flow' ? 'flow' : 'new');
    el('printPanel').classList.toggle('job', P.mode === 'job');
    renderQueue();
    renderAlign();
    el('prDuplex').setAttribute('aria-checked', String(o.duplex));
    el('prDuplexNote').textContent = info && info.duplex
      ? 'This printer can print both sides itself, but Prisca turns the stack by hand: it prints the fronts, then shows how to put the stack back.'
      : 'This printer can’t turn paper over. Prisca prints the fronts, then shows how to put the stack back.';
    el('prReverseRow').hidden = !o.duplex;
    el('prReverse').checked = o.reverse;

    const pl = plan();
    drawSheet(pl);
    // Summary + button
    const go = el('prGo');
    const n = state.pages.length;
    if (!pl) {
      el('prGoLabel').textContent = 'Print';
      el('prSub').textContent = P.mode === 'job' ? (Job.count() ? 'No pages picked' : 'Add files to print') : n ? 'Pages: use numbers like 1-3, 5' : 'Nothing to print';
      go.disabled = true;
    } else {
      const pass = PrintLayout.passes(pl.sheets, o.copies, o.duplex, o.reverse);
      el('prGoLabel').textContent = o.duplex && pass.backs.length
        ? `Print the fronts · ${pass.fronts.length} ${pass.fronts.length === 1 ? 'sheet' : 'sheets'}`
        : `Print ${pass.paper} ${pass.paper === 1 ? 'sheet' : 'sheets'}`;
      const pages = pl.sel.length;
      el('prSub').textContent = `${pages} ${pages === 1 ? 'page' : 'pages'} · ${o.nup === 'pack' ? 'packed' : `${o.nup} per sheet`} · ${o.copies} ${o.copies === 1 ? 'copy' : 'copies'}${pass.oneSided ? ' · one sheet, so no backs' : o.duplex ? ` · both sides on ${pass.paper} ${pass.paper === 1 ? 'sheet' : 'sheets'}` : ''}`;
      go.disabled = P.busy || !info || !P.printer || !pl.check.valid || !!P.step || !!P.align;
    }
    el('prStep').hidden = !P.step;
    if (P.step) {
      el('prStepText').textContent = P.step.text;
      el('prBacks').textContent = `Print the backs · ${P.step.backs.length} ${P.step.backs.length === 1 ? 'sheet' : 'sheets'}`;
      el('prBacks').disabled = P.busy;
    }
  }

  function drawSheet(pl) {
    const stage = el('prStage'), sheetEl = el('prSheet');
    const strip = el('prSheets');
    strip.innerHTML = '';
    el('prWarn').innerHTML = '';
    if (!pl) {
      sheetEl.hidden = true;
      el('prPaperLine').textContent = '';
      if (P.mode === 'job') addWarn(Job.count() ? 'No pages picked: choose some pages to print.' : 'Add files on the left (or drop them here) to print them.', !!Job.count());
      else addWarn(state.pages.length ? 'Pages: use numbers like 1-3, 5 (this batch has ' + state.pages.length + ').' : 'Nothing to print.', true);
      return;
    }
    sheetEl.hidden = false;
    P.sheet = Math.max(0, Math.min(P.sheet, pl.sheets.length - 1));
    const sh = pl.sheets[P.sheet], o = P.opts;
    const size = P.info && P.info.sizes.find((s) => s.kind === o.paper);
    el('prPaperLine').textContent = `${size ? size.name : o.paperName} ${sh.landscape ? 'landscape' : 'portrait'} · ${r1(sh.pw)}×${r1(sh.ph)} mm · inside margins ${r1(Math.max(0, sh.area.w))}×${r1(Math.max(0, sh.area.h))}`;
    // Sheet strip
    if (pl.sheets.length > 1) {
      pl.sheets.forEach((s, i) => {
        const b = document.createElement('button');
        b.className = 'pr-sheet-btn';
        b.setAttribute('aria-pressed', String(i === P.sheet));
        const labels = s.items.map((it) => it.page.label || `page ${it.page.index + 1}`);
        b.innerHTML = `<span class="mono">Sheet ${i + 1}</span><small></small>`;
        b.lastChild.textContent = labels.length > 1 ? `${labels[0]} – ${labels[labels.length - 1]}` : labels[0];
        b.title = labels.join(', ');
        b.onclick = () => { P.sheet = i; render(); };
        strip.appendChild(b);
      });
    }
    // Warnings: what won't come out as shown.
    const c = pl.check;
    if (!c.valid) addWarn('The margins leave no room for the page. Make them smaller.', true);
    if (c.lost > 0.2) addWarn(`The printer can’t reach the hatched edge, so ${r1(c.lost)} mm of the page won’t print there. Raise that margin, move the anchor or use Fit.`, true);
    if (c.trimmed > 0.2) addWarn(o.mode === 'fill' ? `Fill trims up to ${r1(c.trimmed)} mm off the page’s edges to cover the margins.` : `The page is bigger than the space inside your margins: up to ${r1(c.trimmed)} mm is cut off. Use Fit or a smaller size.`, o.mode !== 'fill');
    const small = [];
    const hd0 = hardOf(P.info);
    if (P.info) for (const [k, name] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']]) if (o.m[k] < hd0[k] - 0.05) small.push(`${name} ${r1(hd0[k])}`);
    if (small.length && c.lost <= 0.2) addWarn(`Some margins are smaller than this printer can print (${small.join(', ')} mm), but nothing on the page lands there.`, false);
    if (o.nup === 'pack') {
      const shrunk = pl.sheets.reduce((n, x) => n + (x.shrunk || 0), 0);
      addWarn(shrunk ? `Packed at ${o.mode === 'custom' ? o.pct + '%' : 'true size'} with cut lines; ${shrunk} too big for the space ${shrunk === 1 ? 'was' : 'were'} made smaller to fit.` : `Packed at ${o.mode === 'custom' ? o.pct + '%' : 'true size'}, ${pl.sel.length} on ${pl.sheets.length} ${pl.sheets.length === 1 ? 'sheet' : 'sheets'}, with dashed lines to cut along. Fit and Fill don’t apply here.`, false);
    }
    const pictures = pl.sel.some((s) => s.ref.picture);
    if ((o.mode === 'actual' || o.mode === 'custom') && pictures) addWarn('Added pictures have no real size; True size treats them as 200 dpi.', false);
    else if (o.mode === 'actual' && c.valid && c.lost <= 0.2 && c.trimmed <= 0.2) addWarn('True size: 1 cm on the original is 1 cm on paper.', false);
    // Sized after the strip and warnings are in, so the sheet fits what's left.
    const k = Math.min((stage.clientWidth - 56) / sh.pw, (stage.clientHeight - 56) / sh.ph);
    const px = (mm) => `${(mm * k).toFixed(2)}px`;
    sheetEl.style.width = px(sh.pw);
    sheetEl.style.height = px(sh.ph);
    sheetEl.innerHTML = '';
    const box = (cls, x, y, w, h) => {
      const d = document.createElement('div');
      d.className = cls;
      Object.assign(d.style, { left: px(x), top: px(y), width: px(Math.max(0, w)), height: px(Math.max(0, h)) });
      sheetEl.appendChild(d);
      return d;
    };
    const filter = o.ink === 'grey' ? 'grayscale(1)' : o.ink === 'draft' ? 'grayscale(1) contrast(0.55) brightness(1.3)' : 'none';
    for (const it of sh.items) {
      const clip = box('pr-clip', it.clip.x, it.clip.y, it.clip.w, it.clip.h);
      const img = new Image();
      img.alt = '';
      img.src = preview(it.page.ref);
      Object.assign(img.style, { left: px(it.x - it.clip.x), top: px(it.y - it.clip.y), width: px(it.w), height: px(it.h), filter });
      clip.appendChild(img);
    }
    const hd = sh.hard;
    box('pr-hard', 0, 0, sh.pw, hd.t);
    box('pr-hard', 0, sh.ph - hd.b, sh.pw, hd.b);
    box('pr-hard', 0, hd.t, hd.l, sh.ph - hd.t - hd.b);
    box('pr-hard', sh.pw - hd.r, hd.t, hd.r, sh.ph - hd.t - hd.b);
    box('pr-margin', sh.area.x + o.offX, sh.area.y + o.offY, sh.area.w, sh.area.h);
    for (const ln of sh.lines || []) {
      const [x1, y1, x2, y2] = ln;
      const d = document.createElement('div');
      d.className = y1 === y2 ? 'pr-cut h' : 'pr-cut v';
      Object.assign(d.style, { left: px(Math.min(x1, x2)), top: px(Math.min(y1, y2)), width: px(Math.abs(x2 - x1)), height: px(Math.abs(y2 - y1)) });
      sheetEl.appendChild(d);
    }
    for (const it of sh.items) {
      if (!it.anchor) continue;
      const d = document.createElement('div');
      d.className = 'pr-dot';
      Object.assign(d.style, { left: px(it.anchor.x), top: px(it.anchor.y) });
      sheetEl.appendChild(d);
    }
  }
  function addWarn(text, bad) {
    const d = document.createElement('div');
    d.className = 'pr-warn' + (bad ? ' bad' : '');
    d.textContent = text;
    el('prWarn').appendChild(d);
  }

  // ---------- Profiles ----------
  function applyProfile(pf) {
    const keep = { copies: P.opts.copies, duplex: P.opts.duplex, reverse: P.opts.reverse, offX: P.opts.offX, offY: P.opts.offY };
    const next = cleanOpts({ ...P.opts, ...clone(pf.opts), ...keep });
    const paperChanged = next.paper !== P.opts.paper;
    P.opts = next;
    P.profile = pf.name;
    if (paperChanged && P.info) {
      const size = matchPaper(P.info, next);
      if (size) { P.opts.paper = size.kind; P.opts.paperName = size.name; usePaper(size.kind).then(() => { P.profile = pf.name; render(); }); }
    }
    changed({ keepProfile: true });
  }
  function saveProfile(name) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) return;
    const s = store();
    const opts = {};
    for (const k of PROFILE_KEYS) opts[k] = clone(P.opts[k]);
    const at = s.profiles.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (at >= 0) s.profiles[at] = { name, opts }; else s.profiles.push({ name, opts });
    P.profile = name;
    P.naming = false;
    saveSettings();
    render();
    toast(`Saved “${name}”.`);
  }
  let removed = null;
  function removeProfile(i) {
    const s = store();
    removed = { i, pf: s.profiles[i] };
    s.profiles.splice(i, 1);
    if (P.profile === removed.pf.name) P.profile = '';
    saveSettings();
    render();
    toast(`Removed “${removed.pf.name}”.`, { action: 'Undo', onAction: () => { if (removed) { store().profiles.splice(removed.i, 0, removed.pf); removed = null; saveSettings(); render(); } } });
  }

  // ---------- Printing ----------
  // Renders the pages a set of sheets needs (each once, sharp enough for its
  // biggest use: about 300 dots per inch on paper, never more than the scan has).
  async function stagePages(sheetLists, ink, label) {
    const need = new Map();
    for (const list of sheetLists) for (const sh of list) if (sh) for (const it of sh.items) {
      const px = (Math.max(it.w, it.h) / 25.4) * 300;
      const cur = need.get(it.page.ref);
      need.set(it.page.ref, Math.max(cur || 0, px));
    }
    const staged = new Map();
    let i = 0;
    for (const [page, px] of need) {
      i++;
      toast(`${label}: preparing page ${i} of ${need.size}…`, { sticky: true });
      await nextFrame();
      const c = Imaging.render(page, Math.max(600, Math.round(px)));
      if (ink !== 'colour') inkify(c, ink);
      const bytes = new Uint8Array(await (await Imaging.toBlob(c, 'image/jpeg', 0.92)).arrayBuffer());
      staged.set(page, { path: await Backend.stagePrint(bytes), bytes, w: c.width, h: c.height });
      c.width = c.height = 0;
    }
    return staged;
  }
  function inkify(c, ink) {
    const g = c.getContext('2d', { willReadFrequently: true });
    const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
    const light = ink === 'draft';
    for (let i = 0; i < d.length; i += 4) {
      let v = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      if (light) v = 255 - (255 - v) * 0.55;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(img, 0, 0);
  }
  // Each sheet as the helper draws it, shifted by this printer's measured offset (alignment check).
  function jobSheets(list, paths, printer) {
    const cal = calFor(printer);
    return list.map((sh) => {
      if (!sh) return { landscape: false, items: [], lines: [] };
      const d = Align.shiftFor(cal, sh.landscape);
      return {
        landscape: sh.landscape,
        items: sh.items.map((it) => ({ path: paths.get(it.page.ref).path, x: it.x + d.x, y: it.y + d.y, w: it.w, h: it.h, cx: it.clip.x + d.x, cy: it.clip.y + d.y, cw: it.clip.w, ch: it.clip.h })),
        lines: (sh.lines || []).map(([x1, y1, x2, y2]) => [x1 + d.x, y1 + d.y, x2 + d.x, y2 + d.y]),
      };
    });
  }
  const calFor = (printer) => (store().align && store().align[printer]) || null;
  async function send(printer, info, o, list, copies, paths, title) {
    const job = {
      printer, paper: o.paper, color: o.ink === 'colour' && !!info.color, draft: o.ink === 'draft',
      copies, title: `Prisca ${title}`, sheets: jobSheets(list, paths, printer),
    };
    return Backend.print(job);
  }
  const discardAll = (paths) => { for (const p of paths.values()) Backend.discard(p.path); };
  // What the job is called (Windows' queue, Print again).
  const jobTitle = (list) => (!list && P.mode === 'job' ? Job.title() : (($('fileName') && $('fileName').value) || 'Scans'));
  // Keep exactly what was sent, for Print again.
  function keep(pl, staged, printer, o, sheets, title) {
    const seen = new Set(), pages = [];
    for (const s of pl.sel) {
      const st = staged.get(s.ref);
      if (!st || seen.has(s.ref)) continue;
      seen.add(s.ref);
      pages.push({ jpeg: st.bytes, width: st.w, height: st.h, dpi: st.w / (s.w / 25.4) });
    }
    Job.record({ title, pages, sheets, printer, opts: clone(o) });
  }

  async function run(list, o, printer, info, { closeAfter = true, test = false, title: forceTitle = '' } = {}) {
    const pl = plan(list, o, info);
    if (!pl) return false;
    if (!pl.check.valid) { toast('The margins leave no room for the page.', { bad: true }); return false; }
    const pass = PrintLayout.passes(pl.sheets, o.copies, o.duplex, o.reverse);
    P.busy = true; render();
    let paths = new Map();
    const title = forceTitle || jobTitle(list);
    try {
      paths = await stagePages([pass.fronts, pass.backs], o.ink, 'Printing');
      toast(`Sending to ${printer}…`, { sticky: true });
      const r = await send(printer, info, o, pass.fronts, pass.copies, paths, title);
      const sent = (r && r.sheets) || pass.fronts.length;
      if (!test) keep(pl, paths, printer, o, pass.paper, title);
      if (o.duplex && pass.backs.length) {
        P.step = {
          backs: pass.backs, paths, printer, info, o: clone(o), title,
          text: `Fronts sent (${sent} ${sent === 1 ? 'sheet' : 'sheets'}). When they’re out, put the whole stack back in the paper tray so the blank sides get printed, tops going in first as before${o.reverse ? ', without re-sorting it' : ''}.${pass.blanks ? (pass.blanks > 1 ? ' The last sheet of each copy keeps a blank back so the stack stays in step.' : ' The last sheet keeps a blank back so the stack stays in step.') : ''} First time with this printer? Try it with 2 sheets.`,
        };
        $('toast').hidden = true;
        return true;
      }
      discardAll(paths);
      const copiesNote = pass.copies > 1 ? ` × ${pass.copies} copies` : '';
      if (test) { $('toast').hidden = true; return true; }
      toast(`Sent ${sent} ${sent === 1 ? 'sheet' : 'sheets'}${copiesNote} to ${printer}.`, { action: 'Show the queue', onAction: () => { if (P.open) { P.queueOpen = true; loadQueue(); } } });
      if (closeAfter && P.mode === 'batch') close();
      else loadQueue();
      return true;
    } catch (e) {
      discardAll(paths);
      toast(e.error || 'Couldn’t print.', { bad: true });
      return false;
    } finally {
      P.busy = false; render();
    }
  }
  async function printBacks() {
    const st = P.step;
    if (!st || P.busy) return;
    P.busy = true; render();
    try {
      toast(`Sending the backs to ${st.printer}…`, { sticky: true });
      const r = await send(st.printer, st.info, st.o, st.backs, 1, st.paths, st.title);
      const sent = (r && r.sheets) || st.backs.length;
      discardAll(st.paths);
      P.step = null;
      toast(`Sent ${sent} ${sent === 1 ? 'back' : 'backs'} to ${st.printer}.`);
      if (P.mode === 'batch') close();
    } catch (e) {
      toast(e.error || 'Couldn’t print the backs.', { bad: true });
    } finally { P.busy = false; render(); }
  }
  function cancelStep() {
    if (!P.step) return;
    discardAll(P.step.paths);
    P.step = null;
    toast('Backs not printed.');
    render();
  }

  // ---------- Open / close / quick print ----------
  // The scan batch (Ctrl+P in Scan). opts.pages: preselect those pages ("4"); opts.profile: use that setup.
  async function open(opts = {}) {
    if (P.open) return;
    if (!state.pages.length) { toast('Scan or add a page first.'); return; }
    if (state.scanning || state.saving) return;
    if (state.cropping) finishCrop();
    P.mode = 'batch';
    P.tempPages = !!opts.pages;
    if (opts.pages) P.pagesText = opts.pages;
    await show();
    const pf = opts.profile && store().profiles.find((x) => x.name === opts.profile);
    if (pf && P.open) applyProfile(pf);
  }
  // Print mode: the Print job, always open until you switch to Scan.
  async function openJob() {
    if (P.open && P.mode === 'job') return;
    if (P.open) close();
    P.mode = 'job';
    await show();
  }
  async function show() {
    P.open = true; P.sheet = 0; P.naming = false;
    el('printPanel').hidden = false;
    document.body.classList.add('printing');
    if (P.mode === 'job') Job.render();
    render();
    await loadPrinters();
    if (!P.open) return;
    await usePrinter(pickPrinter());
    startQueueWatch();
  }
  function close() {
    if (!P.open) return;
    if (P.step) cancelStep();
    P.open = false;
    if (P.tempPages) { P.tempPages = false; P.pagesText = 'All'; }
    P.mode = 'batch';
    clearInterval(P.queueTimer);
    el('printPanel').hidden = true;
    el('printPanel').classList.remove('job');
    document.body.classList.remove('printing');
  }
  // Print again: that printer (when it's still there) and the settings the job was printed with.
  async function useSettings(printer, opts) {
    if (!P.printers.length) await loadPrinters();
    const name = P.printers.some((p) => p.name === printer) ? printer : P.printer || pickPrinter();
    if (name !== P.printer) await usePrinter(name);
    P.opts = cleanOpts({ ...opts, duplex: opts.duplex, copies: opts.copies });
    if (P.info) { const size = matchPaper(P.info, P.opts); if (size && size.kind !== P.opts.paper) await usePaper(size.kind); }
    changed();
  }

  // ---------- Alignment check: a guided walk-through over the preview ----------
  // Print a test page, scan it back, and Prisca corrects every print from then on.
  // P.align: null, or { stage, paper, printer, before, result, error, confirm }
  //   stage: 'intro' → 'printing' → 'printed' → 'place' → 'scanning' → 'done'
  const GLASS_SVG = `<svg viewBox="0 0 290 200" width="290" height="200" aria-hidden="true">
    <rect x="10" y="20" width="200" height="170" rx="6" fill="#0b0c0d" stroke="#3a3c42" stroke-width="2"/>
    <text x="110" y="14" text-anchor="middle" font-size="10" fill="#8d8b85">scanner glass (lid open)</text>
    <rect x="22" y="52" width="176" height="150" fill="#f4f1ea"/>
    <circle cx="44" cy="74" r="5" fill="#2a2a2a"/><circle cx="58" cy="74" r="2.5" fill="#2a2a2a"/><circle cx="176" cy="74" r="5" fill="#2a2a2a"/>
    <path d="M110 22v28" stroke="#f2b544" stroke-width="2" stroke-dasharray="3 3"/>
    <path d="M104 28l6-6 6 6M104 44l6 6 6-6" stroke="#f2b544" stroke-width="2" fill="none"/>
    <text x="118" y="40" font-size="11" fill="#f6d48d">about 2 cm</text>
    <path d="M12 120h8" stroke="#f2b544" stroke-width="2"/>
    <text x="216" y="104" font-size="10" fill="#a4a29c">a side</text><text x="216" y="116" font-size="10" fill="#a4a29c">edge clear</text>
    <path d="M200 120h12" stroke="#f2b544" stroke-width="2"/>
    <text x="110" y="140" text-anchor="middle" font-size="11" fill="#6b6a66">face down</text>
  </svg>`;

  function startAlign() {
    if (!P.info) return;
    const size = P.info.sizes.find((x) => x.kind === P.opts.paper) || { w: 210, h: 297, name: 'A4' };
    P.align = { stage: 'intro', paper: { w: size.w, h: size.h, name: size.name }, printer: P.printer, confirm: false };
    render();
  }
  function closeAlign() { P.align = null; render(); }
  async function printTest() {
    const a = P.align;
    if (!a || P.busy) return;
    a.stage = 'printing'; a.error = ''; render();
    const canvas = Align.makePage(a.paper.w, a.paper.h, 300, a.printer);
    const page = docPage(await createImageBitmap(canvas), 300);
    canvas.width = canvas.height = 0;
    // The page exactly as drawn: no margins, true size, from the paper's corner (plus the current correction).
    const o = cleanOpts({ ...P.opts, m: { t: 0, r: 0, b: 0, l: 0 }, mode: 'actual', anchor: 0, offX: 0, offY: 0, nup: 1, orient: 'port', ink: 'grey', copies: 1, duplex: false });
    a.before = calFor(a.printer) ? { ...calFor(a.printer) } : null;
    const ok = await run([page], o, a.printer, P.info, { closeAfter: false, test: true, title: 'Alignment test page' });
    if (P.align !== a) return;
    a.stage = ok ? 'printed' : 'intro';
    if (!ok) a.error = 'The test page didn’t go to the printer. Check it’s on and has paper, then try again.';
    render();
  }
  async function scanTest() {
    const a = P.align;
    if (!a || P.busy) return;
    a.stage = 'scanning'; a.error = '';
    P.busy = true; render();
    try {
      const { bitmap, dpi } = await scanRaw(300, 'Scanning the test page. Don’t move it');
      a.measuring = true; render();
      await nextFrame();
      const r = Align.analyse(bitmap, dpi, a.paper.w, a.paper.h);
      if (bitmap.close) bitmap.close();
      if (!r.ok) { a.stage = 'place'; a.error = r.reason; return; }
      // The page was printed with the old correction; what's left over adds to it.
      const b = a.before || { dx: 0, dy: 0 };
      const cal = { dx: b.dx + r.dx, dy: b.dy + r.dy, skew: r.skew, at: Date.now(), paper: a.paper.name };
      const st = store();
      if (!st.align) st.align = {};
      st.align[a.printer] = cal;
      saveSettings();
      a.result = { measured: r, cal };
      a.stage = 'done';
    } catch (e) {
      a.stage = 'place';
      a.error = e.error || 'Couldn’t scan the test page.';
    } finally { a.measuring = false; P.busy = false; render(); }
  }
  function resetAlign() {
    const st = store();
    if (st.align) delete st.align[P.printer];
    saveSettings();
    P.align = null;
    render();
    toast(`${P.printer}: no alignment correction now.`);
  }

  // The status line under the printer, and the guide over the preview.
  function renderAlign() {
    const box = el('prAlign'), guide = el('prGuide');
    if (!box || !guide) return;
    box.innerHTML = '';
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const button = (text, fn, cls = 'ghost') => { const b = mk('button', cls, text); b.onclick = fn; b.disabled = P.busy; return b; };
    const a = P.align && P.align.printer === P.printer ? P.align : null;
    if (P.printer) {
      const cal = calFor(P.printer);
      const line = mk('div', 'pr-align-line');
      const date = cal ? new Date(cal.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
      line.appendChild(mk('span', '', a ? 'Alignment check in progress: follow the steps on the left.'
        : cal ? `Alignment corrected (${date}): prints landed ${Align.describe(cal.dx, cal.dy)}; Prisca shifts them back.`
          : 'Alignment: not checked. Prints may sit a millimetre or two off.'));
      if (!a) {
        const links = mk('div', 'pr-align-links');
        links.appendChild(button(cal ? 'Check again' : 'Check alignment', startAlign, 'pr-link'));
        if (cal) links.appendChild(button('Turn off', resetAlign, 'pr-link'));
        line.appendChild(links);
      }
      box.appendChild(line);
    }
    guide.hidden = !a;
    guide.innerHTML = '';
    if (!a) return;

    const steps = [['Print', ['intro', 'printing', 'printed']], ['Place', ['place']], ['Scan', ['scanning']], ['Done', ['done']]];
    const cur = steps.findIndex(([, st]) => st.includes(a.stage));
    const head = mk('div', 'gd-head');
    head.appendChild(mk('h2', '', 'Line up the printer'));
    const bar = mk('ol', 'gd-steps');
    steps.forEach(([label], i) => bar.appendChild(mk('li', i < cur ? 'done' : i === cur ? 'on' : '', `${i + 1} ${label}`)));
    head.appendChild(bar);
    const close = button('', closeAlign, 'gd-close');
    close.setAttribute('aria-label', 'Close the alignment check');
    close.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    head.appendChild(close);
    guide.appendChild(head);

    const body = mk('div', 'gd-body');
    const text = (t, cls = 'gd-text') => body.appendChild(mk('p', cls, t));
    const list = (items) => { const ul = mk('ul', 'gd-list'); for (const t of items) ul.appendChild(mk('li', '', t)); body.appendChild(ul); };
    const actions = mk('div', 'gd-actions');
    const scanner = state.devicesLoaded && currentDevice();
    const name = a.printer;
    switch (a.stage) {
      case 'intro':
        body.appendChild(mk('h3', '', `Prisca will find out exactly where ${name} puts things on the page.`));
        text('Most printers print a millimetre or two off to one side. Prisca prints a test page with five dots, you scan it back, and Prisca measures how far off the dots landed against the paper’s edges. From then on every print is shifted back by that amount.');
        list([`Put a plain sheet of ${a.paper.name} in the printer.`, scanner ? `Your scanner (${scanner.name}) needs to be on: it reads the page back.` : 'Switch your scanner on: it reads the page back.', 'It takes about a minute.']);
        if (!scanner) text('No scanner found yet. You can print the test page now and scan it once the scanner is on.', 'gd-note');
        actions.append(button('Print the test page', printTest, 'pr-go'), button('Not now', closeAlign));
        break;
      case 'printing':
        body.appendChild(mk('h3', '', 'Printing the test page…'));
        text(`Sending it to ${name}. Wait for the page to come out.`);
        body.appendChild(mk('div', 'gd-spin'));
        break;
      case 'printed':
        body.appendChild(mk('h3', '', 'Take the page out of the printer.'));
        text('It has four big dots near the corners, one small dot beside the top-left one, and a ruler in the middle.');
        list(['Missing a dot or smudged? Print it again.', 'Nothing came out? Check the printer’s lights and paper, then print again.']);
        actions.append(button('It’s out, next', () => { a.stage = 'place'; render(); }, 'pr-go'), button('Print it again', printTest));
        break;
      case 'place': {
        body.appendChild(mk('h3', '', 'Put it on the scanner like this.'));
        const row = mk('div', 'gd-place');
        const pic = mk('div', 'gd-pic');
        pic.innerHTML = GLASS_SVG;
        const how = mk('ol', 'gd-how');
        for (const t of ['Face down on the glass. Any way round is fine.', 'Slide it about 2 cm away from the top edge of the glass (or the bottom), so the paper’s edge shows.', 'Keep one side edge off the glass edge too.', 'Leave the lid open: the dark around the paper lets Prisca see its edges.']) how.appendChild(mk('li', '', t));
        row.append(pic, how);
        body.appendChild(row);
        if (a.error) { const e = mk('div', 'gd-error'); e.appendChild(mk('strong', '', 'That didn’t work. ')); e.appendChild(document.createTextNode(a.error)); body.appendChild(e); }
        if (!scanner) text('No scanner found. Switch it on; Prisca notices on its own.', 'gd-note');
        const go = button(a.error ? 'Scan again' : 'Scan the test page', scanTest, 'pr-go');
        go.disabled = P.busy || !scanner;
        actions.append(go, button('Back', () => { a.stage = 'printed'; a.error = ''; render(); }));
        break;
      }
      case 'scanning':
        body.appendChild(mk('h3', '', a.measuring ? 'Measuring…' : 'Scanning the test page…'));
        text(a.measuring ? 'Finding the dots and the paper’s edges.' : 'Don’t move the page or close the lid until it’s done.');
        body.appendChild(mk('div', 'gd-spin'));
        break;
      case 'done': {
        const m = a.result.measured, c = a.result.cal;
        const small = Math.abs(m.dx) < 0.3 && Math.abs(m.dy) < 0.3;
        body.appendChild(mk('h3', '', a.confirm ? (small ? 'Spot on. The correction works.' : 'Nearly there: one more adjustment made.') : 'Done. Prisca has lined up this printer.'));
        const big = mk('div', 'gd-result');
        big.appendChild(mk('span', 'gd-num', Align.describe(m.dx, m.dy)));
        big.appendChild(mk('span', '', a.confirm ? 'off on this check' : `is where ${name} printed`));
        body.appendChild(big);
        text(`From now on every print on ${name} is shifted back by ${Align.describe(c.dx, c.dy)}. You don’t need to do anything else.`);
        if (Math.abs(m.skew) > 0.4) text(`The paper also went in ${Align.fmt(Math.abs(m.skew))}° crooked. Push the printer’s paper guide gently against the stack.`, 'gd-note');
        if (!a.confirm && !small) text('Want proof? Check it worked: Prisca prints and scans the test page once more; it should come out within 0.3 mm.');
        actions.append(button('Done', closeAlign, 'pr-go'));
        if (!small || !a.confirm) actions.append(button('Check it worked', () => { a.confirm = true; a.stage = 'intro'; printTest(); }));
        break;
      }
    }
    guide.append(body, actions);
  }

  // ---------- The printer's queue (what Windows is holding) ----------
  async function loadQueue() {
    if (!P.printer || P.busy) return;
    const name = P.printer;
    try {
      const jobs = await Backend.printQueue(name);
      if (P.printer === name) { P.queue = jobs; P.queueError = ''; }
    } catch (e) { P.queueError = e.error || 'Couldn’t read the printer’s queue.'; }
    renderQueue();
  }
  function startQueueWatch() {
    clearInterval(P.queueTimer);
    loadQueue();
    P.queueTimer = setInterval(() => { if (P.open && !document.hidden) loadQueue(); }, 4000);
  }
  async function cancelQueue(id) {
    try {
      const r = await Backend.printQueueCancel(P.printer, id);
      P.queue = r.jobs || [];
      toast(r.failed
        ? `Cancelled ${r.cancelled}; ${r.failed} couldn’t be cancelled (someone else’s job needs administrator rights).`
        : `Cancelled ${r.cancelled} ${r.cancelled === 1 ? 'job' : 'jobs'}.`, { bad: !!r.failed });
    } catch (e) { toast(e.error || 'Couldn’t cancel.', { bad: true }); }
    renderQueue();
  }
  function renderQueue() {
    const box = el('prQueue');
    if (!box) return;
    box.innerHTML = '';
    if (!P.printer) return;
    const q = P.queue || [];
    const head = document.createElement('button');
    head.className = 'pr-queue-head';
    const stuck = q.some((j) => /error|paused|blocked|offline|deleting/i.test(j.status));
    head.textContent = P.queueError ? 'Queue: couldn’t read it' : q.length ? `${q.length} ${q.length === 1 ? 'job' : 'jobs'} waiting${stuck ? ' · stuck' : ''} · ${P.queueOpen ? 'Hide' : 'Show'}` : 'Nothing waiting in the queue';
    head.classList.toggle('warn', stuck);
    head.disabled = !q.length;
    head.onclick = () => { P.queueOpen = !P.queueOpen; renderQueue(); };
    box.appendChild(head);
    if (!q.length || !P.queueOpen) return;
    for (const j of q) {
      const row = document.createElement('div');
      row.className = 'pr-queue-row';
      const t = document.createElement('span');
      t.textContent = j.name || 'Untitled';
      t.title = `${j.name} · ${j.owner || ''}`;
      const m = document.createElement('small');
      m.textContent = `${j.status || 'Waiting'}${j.pages ? ` · ${j.printed || 0}/${j.pages} pages` : ''}${j.at ? ` · ${j.at}` : ''}`;
      const info = document.createElement('div');
      info.append(t, m);
      const c = document.createElement('button');
      c.className = 'ghost';
      c.textContent = 'Cancel';
      c.onclick = () => cancelQueue(j.id);
      row.append(info, c);
      box.appendChild(row);
    }
    if (q.length > 1) {
      const all = document.createElement('button');
      all.className = 'ghost pr-queue-all';
      all.textContent = `Cancel all ${q.length}`;
      all.onclick = () => cancelQueue(0);
      box.appendChild(all);
    }
  }
  // Ctrl+Shift+P and Copy: print straight away with this printer's saved settings.
  async function quick(list) {
    if (P.busy || state.scanning && !list || state.saving) return;
    const pages = list || state.pages;
    if (!pages.length) { toast('Scan or add a page first.'); return; }
    const s = store();
    const o = cleanOpts(s.byPrinter[s.printer] || DEFAULTS);
    if (o.duplex) { toast('Both sides is on: choose Print to turn the stack by hand.', { action: 'Print…', onAction: open }); return; }
    if (!P.printers.length) await loadPrinters();
    const printer = pickPrinter();
    if (!printer) { toast('No printer found. Add one in Windows Settings › Printers & scanners.', { bad: true }); return; }
    try {
      const info = await infoFor(printer, o.paper);
      const size = matchPaper(info, o);
      if (!size) throw { error: `${printer} lists no paper sizes.` };
      o.paper = size.kind; o.paperName = size.name;
      const info2 = size.kind === info.paper ? info : await infoFor(printer, size.kind);
      await run(list || state.pages, o, printer, info2, { closeAfter: false });
    } catch (e) { toast(e.error || 'Couldn’t print.', { bad: true }); }
  }

  // ---------- Controls ----------
  function wire() {
    el('prClose').onclick = close;
    el('prPrinter').onchange = (e) => { usePrinter(e.target.value); store().printer = e.target.value; saveSettings(); };
    el('prPaper').onchange = (e) => usePaper(Number(e.target.value));
    const segs = { prOrient: 'orient', prMode: 'mode', prNup: 'nup', prInk: 'ink' };
    for (const [id, key] of Object.entries(segs)) {
      el(id).addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        P.opts[key] = key === 'nup' ? (b.dataset.v === 'pack' ? 'pack' : Number(b.dataset.v)) : b.dataset.v;
        P.sheet = 0;
        changed({ keepProfile: key === 'ink' });
      });
    }
    for (const k of ['t', 'r', 'b', 'l']) {
      el('prM' + k.toUpperCase()).addEventListener('input', (e) => {
        if (e.target.value === '') return;
        const v = Math.max(0, Math.min(200, num(e.target.value, P.opts.m[k])));
        if (P.opts.linked) { for (const s of ['t', 'r', 'b', 'l']) P.opts.m[s] = v; } else P.opts.m[k] = v;
        changed();
      });
      el('prM' + k.toUpperCase()).addEventListener('blur', () => render());
    }
    el('prLink').onclick = () => {
      P.opts.linked = !P.opts.linked;
      if (P.opts.linked) { const v = P.opts.m.t; for (const s of ['t', 'r', 'b', 'l']) P.opts.m[s] = v; }
      changed();
    };
    el('prMPresets').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const v = Number(b.dataset.v);
      for (const s of ['t', 'r', 'b', 'l']) P.opts.m[s] = v;
      changed();
    });
    const pct = (v) => { P.opts.pct = Math.max(10, Math.min(400, Math.round(num(v, P.opts.pct)))); changed(); };
    el('prPct').addEventListener('input', (e) => { if (e.target.value !== '') pct(e.target.value); });
    el('prPct').addEventListener('blur', () => render());
    el('prPctRange').addEventListener('input', (e) => pct(e.target.value));
    el('prAnchor').querySelectorAll('button').forEach((b, i) => { b.onclick = () => { P.opts.anchor = i; changed(); }; });
    for (const [id, key] of [['prOffX', 'offX'], ['prOffY', 'offY']]) {
      el(id).addEventListener('input', (e) => { if (e.target.value === '' || e.target.value === '-') return; P.opts[key] = Math.max(-50, Math.min(50, num(e.target.value))); changed({ keepProfile: true }); });
      el(id).addEventListener('blur', () => render());
    }
    el('prCopies').addEventListener('input', (e) => { if (e.target.value === '') return; P.opts.copies = Math.max(1, Math.min(99, Math.round(num(e.target.value, 1)))); changed({ keepProfile: true }); });
    el('prCopies').addEventListener('blur', () => render());
    el('prPages').addEventListener('input', (e) => { P.pagesText = e.target.value; P.sheet = 0; render(); });
    el('prBreak').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      store().fileBreak = b.dataset.v;
      saveSettings();
      P.sheet = 0;
      render();
    });
    el('prDuplex').onclick = () => { P.opts.duplex = !P.opts.duplex; changed({ keepProfile: true }); };
    el('prReverse').onchange = (e) => { P.opts.reverse = e.target.checked; changed({ keepProfile: true }); };
    el('prGo').onclick = () => run(null, P.opts, P.printer, P.info);
    el('prBacks').onclick = printBacks;
    el('prStepCancel').onclick = cancelStep;
    el('prSaveProfile').onclick = () => { P.naming = true; render(); el('prProfileName').value = ''; el('prProfileName').focus(); };
    el('prProfileForm').onsubmit = (e) => { e.preventDefault(); saveProfile(el('prProfileName').value); };
    el('prProfileCancel').onclick = () => { P.naming = false; render(); };
    window.addEventListener('resize', () => { if (P.open) render(); });
  }

  // Keys while the panel is open (the main window's keys are off).
  function key(e) {
    const k = e.key;
    const t = document.activeElement;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT');
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'p') {
      e.preventDefault();
      if (P.step) printBacks(); else if (!el('prGo').disabled) el('prGo').click();
      return;
    }
    if (k === 'Escape') {
      e.preventDefault();
      if (P.naming) { P.naming = false; render(); return; }
      if (inField && t.id !== 'prGo') { t.blur(); return; }
      if (P.mode === 'batch') close();
      return;
    }
    if (inField) return;
    if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); P.sheet--; render(); }
    if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); P.sheet++; render(); }
  }

  wire();
  return {
    open, openJob, close, quick, key, useSettings, pageMM,
    refresh: () => { if (P.open) render(); },
    isOpen: () => P.open, isJob: () => P.open && P.mode === 'job', _P: P, _plan: plan,
  };
})();
if (typeof module !== 'undefined') module.exports = { PrintLayout };
