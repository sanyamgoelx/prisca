// Prisca: the Print job (Print mode).
// Files to print (PDFs, pictures, this scan batch, an earlier job), the pages
// picked from each, and "Print again" (a PDF of every printed job, with its settings).
'use strict';

const Job = (() => {
  const HISTORY_KEEP = 20;
  const J = { files: [], seq: 0, tab: 'job', thumbs: new Map() };
  const el = (id) => document.getElementById(id);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  const short = (name) => name.replace(/\.[a-z0-9]{2,4}$/i, '');

  // ---------- Files ----------
  function entry(name, kind, pages, extra = {}) {
    return { id: ++J.seq, name, kind, pages, picked: pages.map(() => true), turns: pages.map(() => 0), open: false, ...extra };
  }
  function rememberRecent(path) {
    if (!path || /^mock:/.test(path) && !window.PRISCA_MOCK_RECENT) return;
    settings.recentFiles = [path, ...settings.recentFiles.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 8);
    saveSettings();
  }
  // opts.label: name to show instead of the file name; opts.temporary: don't list under recent files.
  async function addPaths(paths, opts = {}) {
    const added = [];
    for (const path of paths) {
      const name = opts.label || fileName(path);
      let bytes = null;
      if (!isPdfName(path)) {
        try { bytes = await Backend.readFile(path); } catch (e) { toast(e.error || `Couldn’t read ${name}.`, { bad: true }); continue; }
      }
      if (isPdfName(path) || isPdfBytes(bytes)) {
        const r = await pdfToPages(path, name);
        if (!r) continue;
        const f = entry(name, 'PDF', r.pages, { path: opts.temporary ? '' : path, note: pdfMore(r) });
        J.files.push(f);
        added.push(f);
      } else {
        try {
          const bitmap = await createImageBitmap(new Blob([bytes]));
          const ext = (name.match(/\.([a-z0-9]+)$/i) || [, 'IMG'])[1].toUpperCase();
          const f = entry(name, ext, [docPage(bitmap, 200, { picture: true })], { path: opts.temporary ? '' : path });
          J.files.push(f);
          added.push(f);
        } catch {
          toast(`Couldn’t open ${name}. Use a PDF, PNG, JPG, BMP, WebP or GIF.`, { bad: true });
          continue;
        }
      }
      if (!opts.temporary) rememberRecent(path);
    }
    changed();
    return added;
  }
  function addScans() {
    const pages = state.pages.filter((p) => !p.dropped);
    if (!pages.length) { toast('No scans yet: switch to Scan (Ctrl+2) and scan some pages.'); return; }
    J.files.push(entry(`Scans (${plural(pages.length, 'page')})`, 'SCAN', pages.slice()));
    changed();
  }
  function keepOnly(files) {
    J.files = J.files.filter((f) => files.includes(f));
    changed();
  }
  let removed = null;
  function remove(f) {
    const i = J.files.indexOf(f);
    if (i < 0) return;
    J.files.splice(i, 1);
    removed = { f, i };
    changed();
    toast(`Removed ${f.name} from the print job.`, { action: 'Undo', onAction: () => { if (removed) { J.files.splice(removed.i, 0, removed.f); removed = null; changed(); } } });
  }
  function clear() {
    if (!J.files.length) return;
    const old = J.files;
    J.files = [];
    changed();
    toast('Print job cleared.', { action: 'Undo', onAction: () => { J.files = old; changed(); } });
  }
  function move(f, d) {
    const i = J.files.indexOf(f), j = i + d;
    if (i < 0 || j < 0 || j >= J.files.length) return;
    [J.files[i], J.files[j]] = [J.files[j], J.files[i]];
    changed();
  }

  // ---------- What gets printed ----------
  // A page turned in the job (not in the batch): a copy with the extra quarter turns.
  const turned = (page, t) => (t ? { ...page, rot: page.rot + 90 * t } : page);
  // One group per file (picked pages only, in order), each page with its size in mm.
  function groups() {
    return J.files.map((f) => {
      const out = [];
      f.pages.forEach((pg, i) => {
        if (!f.picked[i] || pg.dropped) return;
        const ref = turned(pg, f.turns[i]);
        out.push({ ...PrintPanel.pageMM(ref), ref, index: i, label: `${short(f.name)} p${i + 1}` });
      });
      return out;
    }).filter((g) => g.length);
  }
  const pickedCount = () => J.files.reduce((n, f) => n + f.picked.filter((x, i) => x && !f.pages[i].dropped).length, 0);
  const breaks = () => (settings.print.fileBreak === 'flow' ? 'flow' : 'new');

  function changed() {
    render();
    PrintPanel.refresh();
  }

  // ---------- Drawing ----------
  function range(f) {
    const out = [];
    for (let i = 0; i < f.picked.length;) {
      if (!f.picked[i]) { i++; continue; }
      let j = i;
      while (j + 1 < f.picked.length && f.picked[j + 1]) j++;
      out.push(i === j ? String(i + 1) : `${i + 1}–${j + 1}`);
      i = j + 1;
    }
    if (!out.length) return 'none';
    return out.length === 1 && out[0] === `1–${f.picked.length}` ? 'All' : out.join(', ');
  }
  function thumb(page, t) {
    const key = `${page.id}:${t}:${prepKey(page)}`;
    if (J.thumbs.has(key)) return J.thumbs.get(key);
    const c = Imaging.render(turned(page, t), 180);
    const url = c.toDataURL('image/jpeg', 0.75);
    c.width = c.height = 0;
    J.thumbs.set(key, url);
    return url;
  }
  const btn = (cls, label, title, fn, html) => {
    const b = document.createElement('button');
    b.className = cls;
    if (html) b.innerHTML = html; else b.textContent = label;
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    b.onclick = fn;
    return b;
  };
  const ICON = {
    x: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    up: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 15l6-6 6 6"/></svg>',
    turn: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  };

  function render() {
    if (!el('prJob')) return;
    const n = pickedCount();
    const nf = J.files.filter((f) => f.picked.some(Boolean)).length;
    el('jobLine').textContent = J.files.length ? `${plural(n, 'page')} from ${plural(nf, 'file')}` : '';
    for (const b of el('jobTabs').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === J.tab));
    el('jobList').hidden = J.tab !== 'job';
    el('jobHistory').hidden = J.tab !== 'history';
    el('jobFoot').hidden = J.tab !== 'job';
    if (J.tab === 'history') { renderHistory(); return; }

    const list = el('jobList');
    list.innerHTML = '';
    if (!J.files.length) {
      const e = document.createElement('div');
      e.className = 'job-empty';
      e.innerHTML = '<strong>Nothing to print yet</strong><span>Add PDFs or pictures, or your scans. You can also drop files here, right-click a PDF › Print with Prisca, or print to the Prisca printer from any app.</span>';
      list.appendChild(e);
    }
    J.files.forEach((f, idx) => {
      const count = f.picked.filter(Boolean).length;
      const card = document.createElement('div');
      card.className = 'job-card' + (count ? '' : ' none');
      const top = document.createElement('div');
      top.className = 'job-top';
      const th = document.createElement('img');
      th.className = 'job-thumb';
      th.alt = '';
      th.src = thumb(f.pages[0], f.turns[0]);
      const info = document.createElement('div');
      info.className = 'job-info';
      const nm = document.createElement('span');
      nm.className = 'job-name';
      nm.textContent = f.name;
      nm.title = f.path || f.name;
      const meta = document.createElement('span');
      meta.className = 'job-meta';
      meta.textContent = f.pages.length === 1 ? `${f.kind} · 1 page` : `${f.kind} · ${f.pages.length} pages · ${count} picked${f.note || ''}`;
      const rg = document.createElement('span');
      rg.className = 'job-range';
      rg.innerHTML = '<small>Pages</small>';
      const code = document.createElement('code');
      code.textContent = range(f);
      rg.appendChild(code);
      info.append(nm, meta, rg);
      const tools = document.createElement('div');
      tools.className = 'job-tools';
      tools.append(
        btn('job-icon', '', `Remove ${f.name}`, () => remove(f), ICON.x),
        btn('job-icon', '', `Move ${f.name} up`, () => move(f, -1), ICON.up),
      );
      tools.lastChild.disabled = idx === 0;
      top.append(th, info, tools);
      card.appendChild(top);
      if (f.pages.length > 1 || f.open) {
        card.appendChild(btn('job-link', f.open ? 'Hide pages' : 'Choose pages', '', () => { f.open = !f.open; render(); }));
      } else {
        card.appendChild(btn('job-link', 'Turn', `Turn ${f.name} a quarter turn`, () => { f.turns[0] = (f.turns[0] + 1) % 4; changed(); }));
      }
      if (f.open) {
        const quick = document.createElement('div');
        quick.className = 'job-quick';
        for (const [label, fn] of [['All', () => true], ['None', () => false], ['Odd', (i) => i % 2 === 0], ['Even', (i) => i % 2 === 1]]) {
          quick.appendChild(btn('job-chip', label, '', () => { f.picked = f.picked.map((_, i) => fn(i)); changed(); }));
        }
        const grid = document.createElement('div');
        grid.className = 'job-grid';
        f.pages.forEach((pg, i) => {
          const tile = document.createElement('div');
          tile.className = 'job-page' + (f.picked[i] ? ' on' : '');
          const pick = btn('job-pick', '', `${f.picked[i] ? 'Leave out' : 'Include'} page ${i + 1} of ${f.name}`, () => { f.picked[i] = !f.picked[i]; changed(); });
          const im = document.createElement('img');
          im.alt = '';
          im.loading = 'lazy';
          im.src = thumb(pg, f.turns[i]);
          pick.appendChild(im);
          const num = document.createElement('span');
          num.className = 'job-num';
          num.textContent = String(i + 1);
          pick.appendChild(num);
          const tick = document.createElement('i');
          pick.appendChild(tick);
          const turn = btn('job-turn', '', `Turn page ${i + 1} a quarter turn`, () => { f.turns[i] = (f.turns[i] + 1) % 4; changed(); }, ICON.turn);
          tile.append(pick, turn);
          grid.appendChild(tile);
        });
        card.append(quick, grid);
      }
      list.appendChild(card);
    });
    // Footer
    const scans = state.pages.filter((p) => !p.dropped).length;
    el('jobScans').textContent = scans ? `+ Scans (${plural(scans, 'page')})` : '+ Scans';
    el('jobScans').disabled = !scans;
    el('jobClear').disabled = !J.files.length;
    el('jobSavePdf').disabled = !n || J.saving;
    const rec = el('jobRecentFiles');
    rec.innerHTML = '';
    const recent = settings.recentFiles.filter((p) => !J.files.some((f) => f.path && f.path.toLowerCase() === p.toLowerCase())).slice(0, 4);
    if (recent.length) {
      const lab = document.createElement('span');
      lab.textContent = 'Recent:';
      rec.appendChild(lab);
      for (const p of recent) rec.appendChild(btn('job-recent', fileName(p), `Add ${p}`, () => addRecent(p)));
    }
  }
  async function addRecent(path) {
    if (!(await Backend.exists(path))) {
      settings.recentFiles = settings.recentFiles.filter((p) => p !== path);
      saveSettings();
      render();
      toast(`${fileName(path)} isn’t there any more (moved or deleted).`, { bad: true });
      return;
    }
    await addPaths([path]);
  }

  // ---------- Save the picked pages as one PDF ----------
  async function savePdf() {
    const gs = groups();
    const pages = gs.flat();
    if (!pages.length || J.saving) return;
    J.saving = true;
    render();
    try {
      const parts = [], refs = [];
      for (let i = 0; i < pages.length; i++) {
        toast(`Preparing page ${i + 1} of ${pages.length}…`, { sticky: true });
        await nextFrame();
        const ref = pages[i].ref;
        const c = Imaging.render(ref, Infinity);
        const img = await pageImage(c, ref);
        const dpi = c.width / (pages[i].w / 25.4);
        parts.push({ ...img, width: c.width, height: c.height, dpi });
        refs.push(ref);
        c.width = c.height = 0;
      }
      const first = short(J.files.find((f) => f.picked.some(Boolean)).name);
      const wanted = cleanName(J.files.length > 1 ? `${first} and ${J.files.length - 1} more ${today()}` : `${first} ${today()}`);
      const folder = saveFolder(wanted);
      const base = await freeBase(wanted, 'pdf', false, folder);
      let pdf = PdfWriter.build(parts, base);
      let note = '';
      if (settings.sizeLimit && pdf.length > settings.sizeLimit * 1000) {
        const r = await shrinkPdf(refs, parts, base, settings.sizeLimit * 1000);
        pdf = r.pdf;
        note = r.note;
      }
      const path = await Backend.saveFile(joinPath(`${base}.pdf`, folder), pdf);
      let copied = '';
      if (settings.copyAfterSave) {
        try { await Backend.copyFiles([path]); copied = ' Copied: paste it into WhatsApp, an email or a folder (Ctrl+V).'; } catch {}
      }
      toast(`Saved ${plural(pages.length, 'page')} as ${base}.pdf.${note}${copied}`, { action: 'Show in folder', onAction: () => Backend.reveal(path), duration: 8000 });
    } catch (e) {
      toast((e && e.error) || (e && e.message) || 'Couldn’t save the PDF.', { bad: true });
    } finally {
      J.saving = false;
      render();
    }
  }

  // ---------- Print again ----------
  // After each print: a PDF of exactly what was sent (the prepared pictures, in
  // order) and the settings, so it can be printed again in one go.
  const history = () => (Array.isArray(settings.print.history) ? settings.print.history : (settings.print.history = []));
  async function record({ title, pages, sheets, printer, opts }) {
    try {
      if (!pages.length) return;
      const dir = await Backend.historyDir();
      const at = Date.now();
      const path = joinPath(`job-${at}.pdf`, dir);
      await Backend.saveFile(path, PdfWriter.build(pages, title));
      const list = history();
      list.unshift({ id: at, at, title, pages: pages.length, sheets, printer, opts, path });
      for (const old of list.splice(HISTORY_KEEP)) Backend.historyDelete(old.path);
      saveSettings();
      if (J.tab === 'history') render();
    } catch (e) { console.warn('Couldn’t keep this job for Print again', e); }
  }
  function when(at) {
    const d = new Date(at), now = new Date();
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === now.toDateString()) return `Today ${time}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
    return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${time}`;
  }
  function renderHistory() {
    const box = el('jobHistory');
    box.innerHTML = '';
    const list = history();
    if (!list.length) {
      box.innerHTML = '<div class="job-empty"><strong>Nothing printed yet</strong><span>Every job you print is kept here (the last 20), with its pages and settings, to print again in one click.</span></div>';
      return;
    }
    for (const h of list) {
      const row = document.createElement('div');
      row.className = 'job-card hist';
      const info = document.createElement('div');
      info.className = 'job-info';
      const nm = document.createElement('span');
      nm.className = 'job-name';
      nm.textContent = h.title;
      const meta = document.createElement('span');
      meta.className = 'job-meta';
      meta.textContent = `${when(h.at)} · ${plural(h.pages, 'page')} · ${plural(h.sheets, 'sheet')} · ${h.printer}`;
      info.append(nm, meta);
      const go = btn('job-again', 'Print again', `Load ${h.title} with its settings`, () => again(h));
      const x = btn('job-icon', '', `Forget ${h.title}`, () => forget(h), ICON.x);
      const top = document.createElement('div');
      top.className = 'job-top';
      top.append(info, go, x);
      row.appendChild(top);
      box.appendChild(row);
    }
  }
  async function again(h) {
    if (!(await Backend.exists(h.path))) { toast('That job’s copy is gone, so it can’t be printed again.', { bad: true }); forget(h, true); return; }
    const r = await pdfToPages(h.path, h.title);
    if (!r) return;
    J.files = [entry(h.title, 'JOB', r.pages, { path: '' })];
    J.tab = 'job';
    PrintPanel.useSettings(h.printer, h.opts);
    changed();
    toast(`Loaded ${h.title} with the settings it was printed with. Check the preview, then Print.`);
  }
  function forget(h, quiet = false) {
    const list = history();
    const i = list.indexOf(h);
    if (i >= 0) list.splice(i, 1);
    Backend.historyDelete(h.path);
    saveSettings();
    render();
    if (!quiet) toast(`Forgot ${h.title}.`);
  }

  // ---------- Controls ----------
  function wire() {
    el('jobTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { J.tab = b.dataset.v; render(); } });
    el('jobAdd').onclick = async () => addPaths(await Backend.pickImages());
    el('jobScans').onclick = addScans;
    el('jobClear').onclick = clear;
    el('jobSavePdf').onclick = savePdf;
  }
  wire();

  return {
    addPaths, addScans, keepOnly, groups, breaks, render, record, clear,
    count: () => J.files.length, title: () => (J.files.length ? (J.files.length > 1 ? `${short(J.files[0].name)} and ${J.files.length - 1} more` : short(J.files[0].name)) : 'Print job'),
    _J: J,
  };
})();
