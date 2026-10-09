// Prisca: the window.
'use strict';

const $ = (id) => document.getElementById(id);

// ---------- Presets and settings ----------
const PRESETS = {
  doc: { label: 'Document', kind: 'doc', dpi: 200, adj: { mode: 'grey', auto: true, brightness: 0, contrast: 10, sharpness: 20, threshold: 50 } },
  receipt: { label: 'Receipt', kind: 'doc', dpi: 300, adj: { mode: 'bw', auto: true, brightness: 0, contrast: 10, sharpness: 30, threshold: 55 } },
  photo: { label: 'Photo', kind: 'photo', dpi: 300, adj: { mode: 'color', auto: true, brightness: 0, contrast: 0, sharpness: 10, threshold: 50 } },
};
const DPIS = [100, 150, 200, 300, 600];
const MODE_NAME = { color: 'Colour', grey: 'Grey', bw: 'B&W' };
const STORE_KEY = 'prisca.settings.v1';

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch {}
  const presets = {};
  for (const [k, p] of Object.entries(PRESETS)) {
    const saved = (s.presets && s.presets[k]) || {};
    presets[k] = { dpi: saved.dpi || p.dpi, adj: { ...p.adj, ...(saved.adj || {}) } };
  }
  return {
    preset: PRESETS[s.preset] ? s.preset : 'doc',
    deviceId: s.deviceId || '',
    folder: s.folder || '',
    format: ['pdf', 'jpg', 'png'].includes(s.format) ? s.format : 'pdf',
    source: s.source === 'feeder' ? 'feeder' : 'flatbed',
    searchable: s.searchable !== false,
    paper: ['auto', 'a4', 'letter', 'actual'].includes(s.paper) ? s.paper : 'auto',
    auto: !!s.auto,
    upright: s.upright !== false,
    cast: s.cast && typeof s.cast === 'object' ? s.cast : {},
    layout: ['page', 'items', 'book'].includes(s.layout) ? s.layout : 'page',
    smartName: s.smartName !== false,
    autoDelay: [3, 5, 8, 12].includes(s.autoDelay) ? s.autoDelay : 5,
    presets,
  };
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch {}
}

// ---------- State ----------
const state = {
  pages: [],
  current: -1,
  devices: [],
  devicesLoaded: false,
  scanning: false,
  saving: false,
  cropping: false,
  nameEdited: false,
};
let pageSeq = 0;
const cur = () => state.pages[state.current] || null;

// ---------- Top bar ----------
function renderPresets() {
  const wrap = $('presets');
  wrap.innerHTML = '';
  for (const [k, p] of Object.entries(PRESETS)) {
    const s = settings.presets[k];
    const b = document.createElement('button');
    b.className = 'preset';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.preset === k));
    b.innerHTML = `${p.label}<small>${MODE_NAME[s.adj.mode]} ${s.dpi}dpi</small>`;
    b.onclick = () => { settings.preset = k; saveSettings(); renderPresets(); };
    wrap.appendChild(b);
  }
  const sel = $('dpi');
  sel.innerHTML = DPIS.map((d) => `<option value="${d}">${d} dpi</option>`).join('');
  sel.value = String(settings.presets[settings.preset].dpi);
}
$('dpi').onchange = (e) => {
  settings.presets[settings.preset].dpi = Number(e.target.value);
  saveSettings();
  renderPresets();
};
$('source').onchange = (e) => { settings.source = e.target.value; saveSettings(); updateScanBar(); };
$('layout').value = settings.layout;
$('layout').onchange = (e) => { settings.layout = e.target.value; saveSettings(); updateScanBar(); };

function currentDevice() {
  return state.devices.find((d) => d.id === settings.deviceId) || state.devices[0] || null;
}

function renderDevice() {
  const dot = $('deviceDot'), text = $('deviceText');
  dot.className = 'dot';
  const d = currentDevice();
  if (state.scanning) { dot.classList.add('busy'); text.textContent = `${d ? d.name : 'Scanner'} · Scanning`; }
  else if (!state.devicesLoaded) { dot.classList.add('busy'); text.textContent = 'Looking for scanners…'; }
  else if (!d) { dot.classList.add('bad'); text.textContent = 'No scanner found'; }
  else { dot.classList.add('ok'); text.textContent = `${d.name} · Ready`; }
  const feeder = !!(d && d.feeder);
  $('sourceWrap').hidden = !feeder;
  if (!feeder && settings.source === 'feeder') settings.source = 'flatbed';
  $('source').value = settings.source;
}

async function loadDevices() {
  state.devicesLoaded = false;
  renderDevice();
  try {
    state.devices = await Backend.listDevices();
  } catch (e) {
    state.devices = [];
    toast(e.error || 'Couldn’t look for scanners.', { bad: true, action: 'Retry', onAction: loadDevices });
  }
  state.devicesLoaded = true;
  if (state.devices.length && !state.devices.some((d) => d.id === settings.deviceId)) {
    settings.deviceId = state.devices[0].id;
    saveSettings();
  }
  renderDevice();
  updateScanBar();
  // No scanner yet: keep looking quietly, so switching the printer on is enough.
  clearTimeout(devicePoll);
  if (!state.devices.length && Backend.inApp) devicePoll = setTimeout(quietRecheck, 4000);
}

let devicePoll = null;
async function quietRecheck() {
  if (state.scanning || state.devices.length) return;
  try {
    const list = await Backend.listDevices();
    if (list.length) {
      state.devices = list;
      if (!list.some((d) => d.id === settings.deviceId)) { settings.deviceId = list[0].id; saveSettings(); }
      renderDevice();
      updateScanBar();
      toast(`${currentDevice().name} is ready.`);
      return;
    }
  } catch {}
  devicePoll = setTimeout(quietRecheck, 4000);
}

// What the driver reports plus Prisca's scan log, saved next to the scans:
// enough to fix an odd scanner without guessing.
async function saveScannerReport() {
  const d = currentDevice();
  if (!d) return;
  toast('Asking the scanner about itself…', { sticky: true });
  try {
    const r = await Backend.probe(d.id, d.name);
    const report = { prisca: '0.1', when: new Date().toISOString(), device: d, log: await Backend.logPath(), probe: r.probe };
    const path = await Backend.saveFile(joinPath(`Prisca scanner report ${today()}.json`), new TextEncoder().encode(JSON.stringify(report, null, 2)));
    toast('Scanner report saved.', { action: 'Show in folder', onAction: () => Backend.reveal(path), duration: 7000 });
  } catch (e) {
    toast((e && e.error) || 'Couldn’t read the scanner’s details.', { bad: true });
  }
}

// One click: save the scanner report, then open a GitHub issue with the
// details filled in (the report file is attached by hand: GitHub can't take it from a link).
async function reportProblem(err) {
  toast('Collecting details…', { sticky: true });
  const d = currentDevice();
  let reportPath = '';
  if (d) {
    try {
      const r = await Backend.probe(d.id, d.name);
      const report = { prisca: await Backend.version(), when: new Date().toISOString(), device: d, error: err || null, probe: r.probe, log: await Backend.logTail(300) };
      reportPath = await Backend.saveFile(joinPath(`Prisca scanner report ${today()}.json`), new TextEncoder().encode(JSON.stringify(report, null, 2)));
    } catch {}
  }
  const version = await Backend.version();
  let log = (await Backend.logTail(40)) || '(empty)';
  const make = (logText) => [
    '**What happened?**',
    '<!-- What did you do, what did you expect, what happened instead? -->',
    '',
    '',
    `**Prisca** ${version} · ${navigator.userAgent.match(/Windows NT [\d.]+/)?.[0] || navigator.platform}`,
    `**Scanner** ${d ? `${d.name} (${d.manufacturer || 'unknown maker'})${d.feeder ? ', with feeder' : ''}` : 'none found'}`,
    err ? `**Error** ${err.code || ''} ${err.hresult || ''} ${err.error || ''}`.trim() : '',
    '',
    '<details><summary>Scanner log (last lines)</summary>',
    '',
    '```',
    logText,
    '```',
    '</details>',
    '',
    reportPath ? `A full scanner report was saved to \`${reportPath}\`. Please drag that file into this box.` : '',
  ].join('\n');
  let body = make(log);
  // Links over ~8000 characters don't open reliably.
  while (encodeURIComponent(body).length > 6500 && log.includes('\n')) {
    log = log.slice(log.indexOf('\n') + 1);
    body = make(log);
  }
  const title = err && err.error ? `Scanning problem: ${err.error}`.slice(0, 120) : 'Problem: ';
  const url = `https://github.com/sanyamgoelx/prisca/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  try { await Backend.openUrl(url); } catch {}
  toast(reportPath ? 'Opened a problem report on GitHub. The scanner report is saved next to your scans: drag it into the report.' : 'Opened a problem report on GitHub.', reportPath ? { action: 'Show report file', onAction: () => Backend.reveal(reportPath), duration: 12000 } : {});
}

function openDeviceMenu() {
  const m = $('deviceMenu');
  if (!m.hidden) { m.hidden = true; return; }
  m.innerHTML = '';
  for (const d of state.devices) {
    const b = document.createElement('button');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(currentDevice() === d));
    b.textContent = d.name + (d.feeder ? ' (glass + feeder)' : '');
    b.onclick = () => { settings.deviceId = d.id; saveSettings(); m.hidden = true; renderDevice(); };
    m.appendChild(b);
  }
  const r = document.createElement('button');
  r.textContent = 'Look again';
  r.onclick = () => { m.hidden = true; loadDevices(); };
  m.appendChild(r);
  if (currentDevice()) {
    const rep = document.createElement('button');
    rep.textContent = 'Save a scanner report';
    rep.onclick = () => { m.hidden = true; saveScannerReport(); };
    m.appendChild(rep);
  }
  const bug = document.createElement('button');
  bug.textContent = 'Report a problem…';
  bug.onclick = () => { m.hidden = true; reportProblem(lastError); };
  m.appendChild(bug);
  const note = document.createElement('div');
  note.className = 'menu-note';
  note.textContent = 'Prisca works with any scanner or all-in-one printer that has a Windows driver. Not listed? Install the driver from the maker’s website, check the cable or Wi-Fi, then look again.';
  m.appendChild(note);
  m.hidden = false;
}
$('deviceBtn').onclick = (e) => { e.stopPropagation(); openDeviceMenu(); };
document.addEventListener('click', (e) => { if (!$('deviceMenu').contains(e.target)) $('deviceMenu').hidden = true; });

// ---------- Pages ----------
function newPage(bitmap, dpi, presetKey) {
  const p = settings.presets[presetKey];
  return {
    id: ++pageSeq,
    bitmap,
    dpi: dpi || p.dpi,
    preset: presetKey,
    kind: PRESETS[presetKey].kind,
    scannedGrey: false,
    rot: 0,
    skew: 0,
    autoSkew: 0,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    levels: null,
    adj: { ...p.adj },
    thumbUrl: '',
  };
}

async function addBitmap(bitmap, dpi, presetKey, scannedGrey, replace = null, device = null) {
  const page = newPage(bitmap, dpi, presetKey);
  page.scannedGrey = !!scannedGrey;
  // What this scanner does to white paper (learnt from earlier document scans),
  // so pictures without much white get the same colour correction.
  page.deviceCast = device ? settings.cast[device] || KNOWN_CASTS[device] || null : null;
  Imaging.analyse(page);
  if (device && !scannedGrey && page.levels && page.levels.documentLike && page.levels.cast) learnCast(device, page.levels.cast);
  const at = replace ? state.pages.indexOf(replace) : -1;
  if (at >= 0) {
    page.adj = { ...replace.adj };
    page.rot = replace.rot;
    if (page.rot) { page.crop = Imaging.detectCrop(page.bitmap, page.rot, page.skew); Imaging.refreshLevels(page); }
    state.pages[at] = page;
    dropPage(replace);
    state.current = at;
  } else {
    state.pages.push(page);
    state.current = state.pages.length - 1;
  }
  renderThumbs();
  refreshThumb(page);
  showPage();
  if (at < 0) queueUpright(page);
  return page;
}

// ---------- Several items / book pages ----------
// One scan becomes several pages: items cut out separately, or the two halves
// of a book spread. Each piece is straightened, cropped and turned upright on
// its own.
async function addPieces(bitmap, dpi, presetKey, scannedGrey, device, layout) {
  let parts = [bitmap];
  try {
    parts = layout === 'items' ? await Imaging.splitItems(bitmap) : layout === 'book' ? await Imaging.splitBook(bitmap) : [bitmap];
  } catch (e) { console.warn('split failed', e); parts = [bitmap]; }
  // Halves side by side ('v' gutter) keep the full height; stacked ones the full width.
  const pair = layout === 'book' && parts.length === 2 ? { id: ++pageSeq, axis: parts[0].width < bitmap.width ? 'v' : 'h' } : null;
  if (parts.length > 1 && bitmap.close) bitmap.close();
  const pages = [];
  for (let i = 0; i < parts.length; i++) {
    const page = await addBitmap(parts[i], dpi, presetKey, scannedGrey, null, device);
    if (pair) page.pair = { ...pair, idx: i };
    pages.push(page);
  }
  if (layout === 'items' && parts.length === 1) toast('Only one item found on the glass. Leave a gap between items so Prisca can tell them apart.');
  return pages;
}

// After both halves of a spread are turned upright, the left page goes first
// (a spread laid sideways on the glass can come out bottom page first).
function orderPair(page) {
  if (!page.pair) return;
  const other = state.pages.find((q) => q !== page && q.pair && q.pair.id === page.pair.id);
  if (!other || !other.uprightDone || !page.uprightDone) return;
  const first = page.pair.idx === 0 ? page : other, second = first === page ? other : page;
  const t = (first.autoTurned || second.autoTurned || 0) / 90;
  const reverse = page.pair.axis === 'v' ? t === 2 : t === 1;
  const i = state.pages.indexOf(first), j = state.pages.indexOf(second);
  if (reverse && j === i + 1) {
    state.pages[i] = second; state.pages[j] = first;
    const c = cur();
    renderThumbs();
    state.current = state.pages.indexOf(c);
    showPage();
  }
}

// Split the page you're looking at: into items if there are several, else into two book pages.
let lastSplit = null;
async function splitCurrent() {
  const p = cur();
  if (!p || state.scanning) return;
  if (state.cropping) finishCrop();
  let parts = await Imaging.splitItems(p.bitmap);
  let layout = 'items';
  if (parts.length < 2) { parts = await Imaging.splitBook(p.bitmap); layout = 'book'; }
  if (parts.length < 2) { toast('Couldn’t find anything to split on this page.'); return; }
  const index = state.pages.indexOf(p);
  if (lastSplit) { dropPage(lastSplit.page); lastSplit = null; }
  state.pages.splice(index, 1);
  const added = [];
  const pair = layout === 'book' ? { id: ++pageSeq, axis: parts[0].width < p.bitmap.width ? 'v' : 'h' } : null;
  for (let i = 0; i < parts.length; i++) {
    const page = newPage(parts[i], p.dpi, p.preset);
    page.adj = { ...p.adj };
    page.deviceCast = p.deviceCast;
    page.scannedGrey = p.scannedGrey;
    Imaging.analyse(page);
    if (pair) page.pair = { ...pair, idx: i };
    state.pages.splice(index + i, 0, page);
    added.push(page);
  }
  lastSplit = { page: p, index, added };
  state.current = index;
  renderThumbs();
  for (const page of added) { refreshThumb(page); queueUpright(page); }
  showPage();
  toast(layout === 'items' ? `Split into ${parts.length} items.` : 'Split into two book pages.', { action: 'Undo', onAction: undoSplit });
}
function undoSplit() {
  if (!lastSplit) return;
  const { page, index, added } = lastSplit;
  lastSplit = null;
  for (const a of added) { const i = state.pages.indexOf(a); if (i >= 0) state.pages.splice(i, 1); dropPage(a); }
  state.pages.splice(Math.min(index, state.pages.length), 0, page);
  state.current = state.pages.indexOf(page);
  renderThumbs();
  showPage();
}

// Colour shifts of scanners we have measured, so their very first scan is
// corrected too (others are learnt from their first document scan).
const KNOWN_CASTS = {
  'HP Deskjet 1510 series': [3, -10, 7],
};

function learnCast(device, cast) {
  const old = settings.cast[device];
  settings.cast[device] = old ? old.map((v, k) => Math.round((v * 0.7 + cast[k] * 0.3) * 10) / 10) : cast.slice();
  saveSettings();
}

function selectPage(i) {
  if (i < 0 || i >= state.pages.length) return;
  if (state.cropping) finishCrop();
  state.current = i;
  renderThumbs();
  showPage();
  const el = $('thumbs').children[i];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

let lastRemoved = null;
function removePage(i, { undoable = true } = {}) {
  const p = state.pages[i];
  if (!p) return;
  if (state.cropping) finishCrop();
  if (lastRemoved && lastRemoved.page !== p) dropPage(lastRemoved.page);
  lastRemoved = null;
  if (undoable) {
    lastRemoved = { page: p, index: i };
    toast(`Page ${i + 1} removed.`, { action: 'Undo', onAction: undoRemove });
  } else dropPage(p);
  state.pages.splice(i, 1);
  if (state.current >= state.pages.length) state.current = state.pages.length - 1;
  renderThumbs();
  showPage();
}

function dropPage(p) {
  p.dropped = true;
  clearTimeout(thumbTimers.get(p.id));
  clearTimeout(prepTimers.get(p.id));
  if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
  if (p.bitmap.close) p.bitmap.close();
}

function undoRemove() {
  if (!lastRemoved) return;
  const { page, index } = lastRemoved;
  lastRemoved = null;
  state.pages.splice(Math.min(index, state.pages.length), 0, page);
  state.current = state.pages.indexOf(page);
  renderThumbs();
  showPage();
  $('toast').hidden = true;
}

function renderThumbs() {
  const wrap = $('thumbs');
  wrap.innerHTML = '';
  state.pages.forEach((p, i) => {
    const b = document.createElement('div');
    b.className = 'thumb';
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', `Page ${i + 1}`);
    b.setAttribute('aria-current', String(i === state.current));
    b.dataset.index = i;
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    if (p.thumbUrl) img.src = p.thumbUrl;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1).padStart(2, '0');
    const x = document.createElement('button');
    x.className = 'x';
    x.setAttribute('aria-label', `Remove page ${i + 1}`);
    x.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    x.onclick = (e) => { e.stopPropagation(); removePage(i); };
    b.append(img, num, x);
    b.addEventListener('pointerdown', (e) => thumbPointerDown(e, i));
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectPage(i); });
    wrap.appendChild(b);
  });
  const slot = document.createElement('div');
  slot.className = 'slot' + (state.scanning ? ' busy' : '');
  slot.textContent = state.scanning ? 'Scanning…' : 'Next scan lands here';
  wrap.appendChild(slot);
  $('pageCount').textContent = `${state.pages.length} page${state.pages.length === 1 ? '' : 's'}`;
  updateScanBar();
  updateSaveLabel();
}

// Drag a thumbnail to reorder (pointer events: HTML drag and drop is off in the app window).
function thumbPointerDown(e, from) {
  if (e.button !== 0 || e.target.closest('.x')) return;
  const startY = e.clientY;
  let dragging = false, target = from;
  const thumbs = () => [...$('thumbs').querySelectorAll('.thumb')];
  const move = (ev) => {
    if (!dragging && Math.abs(ev.clientY - startY) > 6) { dragging = true; thumbs()[from].classList.add('dragging'); }
    if (!dragging) return;
    const els = thumbs();
    target = els.length;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { target = i; break; }
    }
    els.forEach((el, i) => el.classList.toggle('drop-before', i === target && target !== from && target !== from + 1));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!dragging) { selectPage(from); return; }
    let to = target > from ? target - 1 : target;
    if (to !== from) {
      const [p] = state.pages.splice(from, 1);
      state.pages.splice(to, 0, p);
      state.current = to;
    }
    renderThumbs();
    showPage();
    maybeSmartName();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------- Getting pages ready to save in the background ----------
// Each page's full-size JPEG (and its text, for searchable PDFs) is made while
// you scan the next one, so Save only has to write the file.
const prepTimers = new Map();
let prepQueue = Promise.resolve();
const prepKey = (p) => JSON.stringify([p.rot, p.skew, p.crop, p.adj, p.levels, settings.searchable]);
function schedulePrep(page, delay = 1500) {
  clearTimeout(prepTimers.get(page.id));
  prepTimers.set(page.id, setTimeout(() => { prepQueue = prepQueue.then(() => prepare(page)).catch(() => {}); }, delay));
}
async function prepare(page) {
  if (page.dropped || !state.pages.includes(page) || state.saving) return;
  const key = prepKey(page);
  if (page.prepared && page.prepared.key === key) return;
  await nextFrame();
  const c = Imaging.render(page, Infinity);
  const img = await pageImage(c, page);
  let words = null;
  if (settings.searchable) { try { words = await recognise(c, true); } catch {} }
  const ready = { key, ...img, width: c.width, height: c.height, words, ocrTried: settings.searchable };
  c.width = c.height = 0;
  // Only keep it if nothing changed meanwhile.
  if (prepKey(page) === key) page.prepared = ready;
  if (page === state.pages[0]) maybeSmartName();
}

// The page as it goes into a PDF: true black and white for B&W pages (much
// smaller), a JPEG otherwise.
async function pageImage(c, page) {
  if (page.adj.mode === 'bw') return { bits: await PdfWriter.bitsFrom(c) };
  return { jpeg: new Uint8Array(await (await Imaging.toBlob(c, 'image/jpeg', 0.85)).arrayBuffer()) };
}

const thumbTimers = new Map();
function refreshThumb(page, delay = 0) {
  schedulePrep(page);
  clearTimeout(thumbTimers.get(page.id));
  thumbTimers.set(page.id, setTimeout(async () => {
    if (page.dropped) return;
    const c = Imaging.render(page, 260);
    const blob = await Imaging.toBlob(c, 'image/jpeg', 0.82);
    if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
    page.thumbUrl = URL.createObjectURL(blob);
    const i = state.pages.indexOf(page);
    const el = $('thumbs').children[i];
    if (el) el.querySelector('img').src = page.thumbUrl;
  }, delay));
}

// ---------- Viewer ----------
const view = $('view');
let viewCache = { key: '', canvas: null };
let renderQueued = false;

function showPage() {
  const p = cur();
  $('empty').hidden = !!p;
  $('canvasWrap').hidden = !p;
  for (const id of ['rotL', 'rotR', 'cropBtn', 'deletePage', 'rescanBtn', 'splitBtn']) $(id).disabled = !p;
  document.querySelector('.panel').classList.toggle('disabled', !p);
  syncPanel();
  updateMeta();
  scheduleRender();
}

function updateMeta() {
  const p = cur();
  if (!p) { $('pageMeta').textContent = ''; return; }
  const T = Imaging.turnedSize(p.bitmap, p.rot);
  const w = Math.round(T.w * p.crop.w), h = Math.round(T.h * p.crop.h);
  const skew = Math.abs(p.skew) >= 0.05 ? ` · straightened ${Math.abs(p.skew).toFixed(1)}°` : '';
  const took = (p.autoTurned ? ' · turned upright' : '') + (p.scanMs ? ` · scanned in ${(p.scanMs / 1000).toFixed(1)} s` : '');
  $('pageMeta').textContent = `Page ${state.current + 1} · ${w}×${h} · ${p.dpi} dpi${skew}${took}`;
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; drawView(); });
}

function drawView() {
  const p = cur();
  if (!p) return;
  const box = $('viewer').getBoundingClientRect();
  const availW = Math.max(100, box.width - 64), availH = Math.max(100, box.height - 64);
  const T = Imaging.turnedSize(p.bitmap, p.rot);
  const crop = state.cropping ? { x: 0, y: 0, w: 1, h: 1 } : p.crop;
  const cw = T.w * crop.w, ch = T.h * crop.h;
  const scale = Math.min(availW / cw, availH / ch);
  const dispW = Math.max(1, Math.floor(cw * scale)), dispH = Math.max(1, Math.floor(ch * scale));
  const dpr = window.devicePixelRatio || 1;
  const maxDim = Math.ceil(Math.max(dispW, dispH) * dpr);
  const key = [p.id, p.rot, p.skew, crop.x, crop.y, crop.w, crop.h, maxDim].join('|');
  if (viewCache.key !== key) {
    viewCache = { key, canvas: Imaging.geometry(p.bitmap, { rot: p.rot, skew: p.skew, crop, maxDim }) };
  }
  const g = viewCache.canvas;
  const work = Imaging.makeCanvas(g.width, g.height);
  work.getContext('2d').drawImage(g, 0, 0);
  Imaging.tone(work, p.adj, p.levels);
  view.width = work.width;
  view.height = work.height;
  view.style.width = dispW + 'px';
  view.style.height = dispH + 'px';
  view.getContext('2d').drawImage(work, 0, 0);
  const cb = $('cropBox');
  cb.hidden = !state.cropping;
  if (state.cropping) placeCropBox();
}
window.addEventListener('resize', scheduleRender);

// ---------- Crop ----------
function placeCropBox() {
  const p = cur();
  const cb = $('cropBox');
  const W = view.clientWidth, H = view.clientHeight;
  cb.style.left = p.crop.x * W + 'px';
  cb.style.top = p.crop.y * H + 'px';
  cb.style.width = p.crop.w * W + 'px';
  cb.style.height = p.crop.h * H + 'px';
}

function startCrop() {
  if (!cur()) return;
  state.cropping = true;
  $('cropTools').hidden = false;
  $('cropBtn').hidden = true;
  $('skew').value = String(cur().skew);
  $('skewVal').textContent = `${cur().skew.toFixed(1)}°`;
  scheduleRender();
}

function finishCrop() {
  const p = cur();
  state.cropping = false;
  $('cropTools').hidden = true;
  $('cropBtn').hidden = false;
  if (p) {
    Imaging.refreshLevels(p);
    refreshThumb(p);
    updateMeta();
  }
  scheduleRender();
}

$('cropBtn').onclick = startCrop;
$('cropDone').onclick = finishCrop;
$('cropAuto').onclick = () => {
  const p = cur(); if (!p) return;
  p.skew = p.autoSkew = Imaging.detectSkew(p.bitmap);
  p.crop = Imaging.detectCrop(p.bitmap, p.rot, p.skew);
  $('skew').value = String(p.skew);
  $('skewVal').textContent = `${p.skew.toFixed(1)}°`;
  scheduleRender();
};
$('cropFull').onclick = () => { const p = cur(); if (!p) return; p.crop = { x: 0, y: 0, w: 1, h: 1 }; scheduleRender(); };
$('skew').oninput = (e) => {
  const p = cur(); if (!p) return;
  p.skew = Number(e.target.value);
  $('skewVal').textContent = `${p.skew.toFixed(1)}°`;
  scheduleRender();
};

$('cropBox').addEventListener('pointerdown', (e) => {
  const p = cur(); if (!p) return;
  e.preventDefault();
  const handle = e.target.dataset.h || 'move';
  const W = view.clientWidth, H = view.clientHeight;
  const start = { ...p.crop }, sx = e.clientX, sy = e.clientY;
  const MIN = 0.04;
  const move = (ev) => {
    const dx = (ev.clientX - sx) / W, dy = (ev.clientY - sy) / H;
    let { x, y, w, h } = start;
    let x2 = x + w, y2 = y + h;
    if (handle === 'move') {
      x = Math.min(Math.max(0, x + dx), 1 - w);
      y = Math.min(Math.max(0, y + dy), 1 - h);
      x2 = x + w; y2 = y + h;
    } else {
      if (handle.includes('w')) x = Math.min(Math.max(0, x + dx), x2 - MIN);
      if (handle.includes('e')) x2 = Math.max(Math.min(1, x2 + dx), x + MIN);
      if (handle.includes('n')) y = Math.min(Math.max(0, y + dy), y2 - MIN);
      if (handle.includes('s')) y2 = Math.max(Math.min(1, y2 + dy), y + MIN);
    }
    p.crop = { x, y, w: x2 - x, h: y2 - y };
    placeCropBox();
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ---------- Rotate / remove ----------
function rotate(dir) {
  const p = cur(); if (!p) return;
  p.userRotated = true;
  rotatePage(p, dir);
}
function rotatePage(p, dir) {
  const c = p.crop;
  p.crop = dir > 0
    ? { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w }
    : { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
  p.rot = (p.rot + (dir > 0 ? 90 : 270)) % 360;
  refreshThumb(p);
  if (p === cur()) { updateMeta(); scheduleRender(); }
}

// ---------- Turning pages upright ----------
// Reads the page at each quarter turn (Windows OCR, in the background helper)
// and keeps the turn where real words come out. Runs before the page is
// prepared for saving; never overrides a turn you made yourself.
let uprightUnavailable = false;
function queueUpright(page) {
  if (!settings.upright || uprightUnavailable || !Backend.inApp && !window.PRISCA_MOCK_UPRIGHT) { page.uprightDone = true; return; }
  prepQueue = prepQueue.then(() => uprightPage(page)).catch(() => {});
}
async function uprightPage(page) {
  try { await uprightInner(page); } finally {
    page.uprightDone = true;
    if (!page.dropped) { orderPair(page); maybeSmartName(); }
  }
}
async function uprightInner(page) {
  if (page.dropped || page.userRotated || !state.pages.includes(page)) return;
  const base = Imaging.geometry(page.bitmap, { rot: page.rot, skew: page.skew, crop: page.crop, maxDim: 1600 });
  Imaging.tone(base, { mode: 'grey', auto: true, brightness: 0, contrast: 10, sharpness: 0, threshold: 50 }, page.levels);
  const scores = [];
  for (const turn of [0, 1, 2, 3]) {
    const c = turnCanvas(base, turn);
    const jpeg = new Uint8Array(await (await Imaging.toBlob(c, 'image/jpeg', 0.85)).arrayBuffer());
    let r = null;
    try { r = await Backend.ocr(jpeg); } catch { r = null; }
    if (!r || !r.available) { uprightUnavailable = !r || !r.available; return; }
    scores.push(wordScore(r));
    // Clearly upright already: no need to try the other turns.
    if (turn === 0 && scores[0] >= 40) break;
  }
  if (page.dropped || page.userRotated) return;
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  console.info(`[Prisca] upright scores ${scores.join('/')} -> turn ${best * 90}`);
  if (best === 0 || scores[best] < 5 || scores[best] < scores[0] * 2 + 2) return;
  for (let i = 0; i < best; i++) rotatePage(page, 1);
  page.autoTurned = best * 90;
  if (page === cur()) updateMeta();
}
function turnCanvas(src, turn) {
  if (!turn) return src;
  const w = turn % 2 ? src.height : src.width, h = turn % 2 ? src.width : src.height;
  const c = Imaging.makeCanvas(w, h);
  const g = c.getContext('2d');
  g.translate(w / 2, h / 2);
  g.rotate((turn * Math.PI) / 2);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
// Real words: three or more letters (upside-down or sideways text reads as junk).
function wordScore(r) {
  const lines = Array.isArray(r.lines) ? r.lines : r.lines ? [r.lines] : [];
  let n = 0;
  for (const line of lines) {
    const ws = Array.isArray(line.words) ? line.words : line.words ? [line.words] : [];
    for (const w of ws) if (/^[A-Za-z][a-z]{2,}$|^[A-Z]{3,}$/.test(String(w.t).replace(/[.,:;!?)(]+$/g, ''))) n++;
  }
  return n;
}
$('splitBtn').onclick = () => splitCurrent();
$('rotL').onclick = () => rotate(-1);
$('rotR').onclick = () => rotate(1);
$('deletePage').onclick = () => removePage(state.current);

// ---------- Adjust panel ----------
function syncPanel() {
  const p = cur();
  const adj = p ? p.adj : settings.presets[settings.preset].adj;
  for (const b of $('modeSeg').children) b.setAttribute('aria-checked', String(b.dataset.v === adj.mode));
  $('autoSwitch').setAttribute('aria-checked', String(!!adj.auto));
  for (const inp of document.querySelectorAll('[data-adj]')) {
    const k = inp.dataset.adj;
    inp.value = String(adj[k]);
    const v = adj[k];
    document.querySelector(`[data-out="${k}"]`).textContent = (inp.min < 0 && v > 0 ? '+' : '') + v;
  }
  $('thresholdRow').hidden = adj.mode !== 'bw';
  $('modeNote').hidden = !(p && p.scannedGrey && adj.mode === 'color');
}

function changeAdj(patch) {
  const p = cur(); if (!p) return;
  Object.assign(p.adj, patch);
  // New scans with this preset start from the same settings.
  settings.presets[p.preset].adj = { ...p.adj };
  saveSettings();
  renderPresets();
  syncPanel();
  scheduleRender();
  refreshThumb(p, 200);
}

for (const b of $('modeSeg').children) b.onclick = () => changeAdj({ mode: b.dataset.v });
$('autoSwitch').onclick = () => { const p = cur(); if (p) changeAdj({ auto: !p.adj.auto }); };
for (const inp of document.querySelectorAll('[data-adj]')) {
  inp.addEventListener('input', () => changeAdj({ [inp.dataset.adj]: Number(inp.value) }));
}
$('resetBtn').onclick = () => { const p = cur(); if (p) changeAdj({ ...PRESETS[p.preset].adj }); };
$('applyAllBtn').onclick = () => {
  const p = cur(); if (!p) return;
  for (const q of state.pages) if (q !== p) { q.adj = { ...p.adj }; refreshThumb(q, 50); }
  toast(`Applied to all ${state.pages.length} pages.`);
};

// ---------- Scanning ----------
function updateScanBar() {
  const btn = $('scanBtn');
  const n = state.pages.length + 1;
  btn.classList.toggle('cancel', state.scanning);
  if (state.scanning) {
    $('scanLabel').textContent = 'Cancel scan';
    btn.querySelector('.key').textContent = 'Esc';
  } else if (autoTimer) {
    $('scanLabel').textContent = `Next scan in ${autoLeft} s`;
    btn.querySelector('.key').textContent = 'Space: now';
  } else {
    $('scanLabel').textContent = settings.source === 'feeder' ? 'Scan feeder' : `Scan page ${n}`;
    btn.querySelector('.key').textContent = 'Space';
  }
  btn.disabled = state.saving || (!state.scanning && state.devicesLoaded && !currentDevice() && Backend.inApp);
  $('copyBtn').disabled = state.scanning || state.saving || (state.devicesLoaded && !currentDevice() && Backend.inApp);
  const auto = $('autoBtn');
  auto.setAttribute('aria-checked', String(settings.auto));
  auto.hidden = settings.source === 'feeder';
  $('autoDelay').textContent = `${settings.autoDelay} s`;
  $('scanHint').textContent = settings.auto && settings.source !== 'feeder'
    ? 'Auto: after each scan, swap the page — the next scan starts by itself. Esc stops.'
    : 'Place the next page and press Space. Crop, straighten and your adjustments apply automatically.';
}

let scanClock = null, lastError = null;
async function scan({ replace = null, copy = false } = {}) {
  if (state.scanning || state.saving) return;
  stopAuto();
  const d = currentDevice();
  if (!d) {
    toast('No scanner found. Check it is on and connected.', { bad: true, action: 'Look again', onAction: loadDevices });
    return;
  }
  if (state.cropping) finishCrop();
  const presetKey = settings.preset;
  const ps = settings.presets[presetKey];
  const intent = ps.adj.mode === 'color' ? 'color' : 'grey';
  state.scanning = true;
  $('scanning').hidden = false;
  const started = Date.now();
  const what = replace ? `Scanning page ${state.pages.indexOf(replace) + 1} again` : (settings.source === 'feeder' ? 'Scanning the feeder' : 'Scanning');
  $('scanningText').textContent = `${what}…`;
  clearInterval(scanClock);
  scanClock = setInterval(() => { $('scanningText').textContent = `${what}… ${Math.round((Date.now() - started) / 1000)} s`; }, 1000);
  clearTimeout(releaseTimer);
  renderDevice();
  renderThumbs();
  const source = copy ? 'flatbed' : settings.source;
  let files = null, r = null;
  const done = () => {
    clearInterval(scanClock);
    state.scanning = false;
    $('scanning').hidden = true;
    renderDevice();
    renderThumbs();
    // Keep the scanner connected for the next page; let go after a quiet spell.
    releaseTimer = setTimeout(() => Backend.releaseScanner(), 120000);
  };
  try {
    r = await Backend.scan({ device: d.id, deviceName: d.name, dpi: ps.dpi, intent, source });
    if (!r.pages.length) throw { code: 'empty', error: 'The scanner sent no pages.' };
    files = [];
    for (const pg of r.pages) {
      files.push({ bytes: await Backend.readFile(pg.path), dpi: pg.dpi });
      Backend.discard(pg.path);
    }
  } catch (e) {
    done();
    if (e && e.code === 'cancelled') toast('Scan cancelled.');
    else {
      lastError = e || null;
      const odd = !e || ['unknown', 'driver', 'crashed', 'timeout', 'helper', 'unsupported', 'setting', 'general'].includes(e.code);
      toast((e && e.error) || 'Scanning failed.', odd
        ? { bad: true, action: 'Report a problem', onAction: () => reportProblem(e) }
        : { bad: true, action: 'Try again', onAction: scan });
      if (e && (e.code === 'notfound' || e.code === 'offline')) loadDevices();
    }
    return;
  }
  // The scanner is free again: the next scan can start while this page is processed.
  const scanMs = Date.now() - started;
  done();
  const t1 = performance.now();
  let blank = 0;
  const added = [];
  for (const f of files) {
    const bitmap = await createImageBitmap(new Blob([f.bytes]));
    const target = replace && state.pages.includes(replace) && files.length === 1 ? replace : null;
    const layout = target || copy || source === 'feeder' ? 'page' : settings.layout;
    const pieces = layout === 'page'
      ? [await addBitmap(bitmap, f.dpi || r.dpi || ps.dpi, presetKey, intent !== 'color' && !r.simple, target, d.name)]
      : await addPieces(bitmap, f.dpi || r.dpi || ps.dpi, presetKey, intent !== 'color' && !r.simple, d.name, layout);
    for (const page of pieces) {
      page.scanMs = scanMs;
      // Feeder batches: drop blank sheets (backs of one-sided pages).
      if (source === 'feeder' && Imaging.isBlank(page)) { removePage(state.pages.indexOf(page), { undoable: false }); blank++; continue; }
      added.push(page);
    }
  }
  updateMeta();
  console.info(`[Prisca] scan ${scanMs} ms (scanner helper ${r.totalMs} ms, of which setup ${r.setupMs} ms, warm ${r.warm}); processing ${Math.round(performance.now() - t1)} ms`);
  if (blank) toast(`Skipped ${blank} blank page${blank === 1 ? '' : 's'}.`);
  if (copy && added.length) { await printPages(added); return; }
  if (!replace && source === 'flatbed' && autoRunning) afterAutoScan(added[0], added.length);
}

// ---------- Hands-free: scan again after a countdown ----------
// With Auto on, each scan starts the next one after a few seconds: swap the
// page and keep going. Stops on Esc, on an empty glass, or when the same page
// comes back (not swapped in time).
let autoTimer = null, autoLeft = 0, autoRunning = false, releaseTimer = null;
function afterAutoScan(page, count = 1) {
  if (!page) return;
  if (count > 1) { startCountdown(); return; }
  const i = state.pages.indexOf(page);
  if (Imaging.isBlank(page)) {
    removePage(i, { undoable: false });
    autoRunning = false;
    toast('Nothing on the glass, so Auto stopped.');
    return;
  }
  const prev = state.pages[i - 1];
  if (prev && Imaging.samePage(prev, page)) {
    autoRunning = false;
    toast('That looks like the same page again, so Auto paused. Put the next page on and press Space.', {
      action: 'Remove it', duration: 10000, onAction: () => removePage(state.pages.indexOf(page)),
    });
    return;
  }
  startCountdown();
}
function startCountdown() {
  clearInterval(autoTimer);
  autoLeft = settings.autoDelay;
  autoTimer = setInterval(() => {
    autoLeft--;
    if (autoLeft <= 0) { clearInterval(autoTimer); autoTimer = null; scan(); return; }
    updateScanBar();
  }, 1000);
  updateScanBar();
}
function stopAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  updateScanBar();
}

function cancelScan() {
  if (state.scanning) Backend.cancel();
}

function scanFromUser(opts) {
  autoRunning = settings.auto && settings.source !== 'feeder';
  scan(opts);
}
$('scanBtn').onclick = () => (state.scanning ? cancelScan() : scanFromUser());
$('autoBtn').onclick = (e) => {
  // Clicking the seconds cycles the delay; clicking the rest switches Auto.
  if (e.target.closest('#autoDelay')) {
    const steps = [3, 5, 8, 12];
    settings.autoDelay = steps[(steps.indexOf(settings.autoDelay) + 1) % steps.length];
  } else {
    settings.auto = !settings.auto;
    if (!settings.auto) { autoRunning = false; stopAuto(); }
  }
  saveSettings();
  updateScanBar();
};
$('copyBtn').onclick = () => { if (!state.scanning) scan({ copy: true }); };
$('rescanBtn').onclick = () => { if (cur()) scan({ replace: cur() }); };

// ---------- Importing pictures ----------
async function importBytes(list) {
  let added = 0;
  for (const { bytes, name } of list) {
    try {
      const bitmap = await createImageBitmap(new Blob([bytes]));
      if (settings.layout === 'page') await addBitmap(bitmap, 200, settings.preset, false);
      else await addPieces(bitmap, 200, settings.preset, false, null, settings.layout);
      added++;
    } catch {
      toast(`Couldn’t open ${name}. Use PNG, JPG, BMP, WebP or GIF.`, { bad: true });
    }
  }
  return added;
}
async function importPaths(paths) {
  const list = [];
  for (const path of paths) {
    try { list.push({ bytes: await Backend.readFile(path), name: path.split(/[\\/]/).pop() }); }
    catch (e) { toast(e.error || `Couldn’t read ${path}`, { bad: true }); }
  }
  await importBytes(list);
}
$('importBtn').onclick = async () => importPaths(await Backend.pickImages());
Backend.onFileDrop((paths) => { $('dropVeil').hidden = true; importPaths(paths); });
if (window.__TAURI__ && window.__TAURI__.event) {
  window.__TAURI__.event.listen('tauri://drag-enter', () => { $('dropVeil').hidden = false; });
  window.__TAURI__.event.listen('tauri://drag-leave', () => { $('dropVeil').hidden = true; });
} else {
  // Browser preview: normal file drops.
  window.addEventListener('dragover', (e) => { e.preventDefault(); $('dropVeil').hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('dropVeil').hidden = true; });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    $('dropVeil').hidden = true;
    const list = [];
    for (const f of e.dataTransfer.files) list.push({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
    importBytes(list);
  });
}

// ---------- Saving ----------
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function suggestName() {
  state.smartFor = null;
  state.smartNamed = false;
  const prefix = `Scan ${today()}`;
  let n = 1;
  try { n = await Backend.nextNumber(settings.folder, prefix); } catch {}
  $('fileName').value = `${prefix} ${String(n).padStart(3, '0')}`;
  state.nameEdited = false;
}
$('fileName').addEventListener('input', () => { state.nameEdited = true; });
$('smartName').checked = settings.smartName;
$('smartName').onchange = (e) => { settings.smartName = e.target.checked; saveSettings(); if (settings.smartName) maybeSmartName(); else if (!state.nameEdited) suggestName(); };

// ---------- Names from the page's text ----------
// Reads the first page (the same text recognition as searchable PDFs) and
// suggests e.g. "Invoice 1043 2026-10-09". Never replaces a name you typed.
let smartBusy = false;
async function maybeSmartName() {
  const page = state.pages[0];
  if (!settings.smartName || state.nameEdited || !page || smartBusy) return;
  if (state.smartFor === page.id) return;
  if (!page.uprightDone) return; // wait until it's the right way up
  smartBusy = true;
  try {
    const ready = page.prepared && page.prepared.key === prepKey(page) ? page.prepared : null;
    let words = ready ? ready.words : null, height = ready ? ready.height : 0;
    if (!words) {
      const c = Imaging.render(page, 2200);
      try { words = await recognise(c, true); } catch { words = null; }
      height = c.height;
      c.width = c.height = 0;
    }
    if (state.nameEdited || state.pages[0] !== page) return;
    const name = nameFromWords(words || [], height);
    state.smartFor = page.id;
    if (name) { $('fileName').value = `${name} ${today()}`; state.smartNamed = true; }
    else if (state.smartNamed) { state.smartNamed = false; await suggestName(); }
  } finally {
    smartBusy = false;
    // The first page may have changed meanwhile.
    if (state.pages[0] && state.smartFor !== state.pages[0].id) setTimeout(maybeSmartName, 0);
  }
}

const DOC_TYPES = [
  [/\btax\s+invoice\b|\binvoice\b/i, 'Invoice'],
  [/\bcredit\s+note\b/i, 'Credit Note'],
  [/\bpurchase\s+order\b/i, 'Purchase Order'],
  [/\bdelivery\s+(?:note|challan)\b|\bchallan\b/i, 'Challan'],
  [/\b(?:pay|salary)\s*slip\b/i, 'Payslip'],
  [/\bquotation\b|\bquote\b/i, 'Quotation'],
  [/\bestimate\b/i, 'Estimate'],
  [/\bstatement\b/i, 'Statement'],
  [/\breceipt\b/i, 'Receipt'],
  [/\bcash\s+memo\b|\bbill\b/i, 'Bill'],
  [/\border\b/i, 'Order'],
];
// words: [{ t, l (line), x, y, w, h }] from recognise().
function nameFromWords(words, imageHeight = 0) {
  if (!words.length) return null;
  const lines = [];
  for (const w of words) {
    let L = lines[w.l];
    if (!L) L = lines[w.l] = { words: [], y: Infinity, hs: [] };
    L.words.push(w); L.y = Math.min(L.y, w.y); L.hs.push(w.h);
  }
  const list = lines.filter(Boolean).map((L) => {
    L.hs.sort((a, b) => a - b);
    return { text: L.words.map((w) => w.t).join(' '), y: L.y, h: L.hs[L.hs.length >> 1], words: L.words.map((w) => w.t) };
  }).sort((a, b) => a.y - b.y);
  const pageH = imageHeight || Math.max(...words.map((w) => w.y + w.h));
  const isDate = (s) => /^\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}$/.test(s);
  const isNumber = (s) => /\d.*\d/.test(s) && /^[A-Za-z]{0,5}[\-\/#]?[A-Za-z0-9][A-Za-z0-9\-\/]{1,18}$/.test(s) && !isDate(s) && !/^\d+[.,]\d{2}$/.test(s);
  // A document type near the top, with its number.
  for (let i = 0; i < Math.min(list.length, 30); i++) {
    const L = list[i];
    if (L.y > pageH * 0.6) break;
    const hit = DOC_TYPES.find(([re]) => re.test(L.text));
    if (!hit) continue;
    let number = null;
    for (const cand of [L, list[i + 1], list[i + 2]].filter(Boolean)) {
      const toks = cand.words.map((s) => s.replace(/[:,;]+$/, '').replace(/^[#:]+/, ''));
      const k = toks.findIndex((s, j) => j > 0 && /^(no\.?|number|num|#)$/i.test(toks[j - 1]) && isNumber(s));
      number = k >= 0 ? toks[k] : toks.find(isNumber) || null;
      if (number) break;
    }
    return clean(number ? `${hit[1]} ${number}` : hit[1]);
  }
  // Otherwise the biggest heading in the top part of the page.
  const heads = list.filter((L) => L.y < pageH * 0.45 && (L.text.match(/[A-Za-z]{2,}/g) || []).length >= 1);
  if (!heads.length) return null;
  const big = heads.reduce((a, b) => (b.h > a.h * 1.05 ? b : a));
  const median = list.map((L) => L.h).sort((a, b) => a - b)[list.length >> 1];
  if (big.h < median * 1.25 && list.length > 3) return null; // no real heading
  let words2 = big.words.filter((s) => /[A-Za-z]/.test(s)).slice(0, 6);
  if (!words2.length) return null;
  if (words2.every((s) => s === s.toUpperCase())) words2 = words2.map((s) => s.charAt(0) + s.slice(1).toLowerCase());
  return clean(words2.join(' '));

  function clean(s) {
    return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 50) || null;
  }
}

function renderFormat() {
  for (const b of $('formatSeg').children) b.setAttribute('aria-checked', String(b.dataset.v === settings.format));
  $('searchableRow').hidden = settings.format !== 'pdf';
  $('paperRow').hidden = settings.format !== 'pdf';
  $('paper').value = settings.paper;
  $('searchable').checked = settings.searchable;
  updateSaveLabel();
}
$('paper').onchange = (e) => { settings.paper = e.target.value; saveSettings(); };
$('upright').checked = settings.upright;
$('upright').onchange = (e) => { settings.upright = e.target.checked; saveSettings(); };
$('searchable').onchange = (e) => { settings.searchable = e.target.checked; saveSettings(); };

// Text on a page via Windows OCR, as words in the page's own pixels. Null if unavailable.
let ocrMissingTold = false;
async function recognise(canvas, quiet = false) {
  const maxSide = 3000;
  const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  let src = canvas;
  if (k < 1) {
    src = Imaging.makeCanvas(canvas.width * k, canvas.height * k);
    const g = src.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, src.width, src.height);
  }
  const jpeg = new Uint8Array(await (await Imaging.toBlob(src, 'image/jpeg', 0.9)).arrayBuffer());
  if (src !== canvas) src.width = src.height = 0;
  const r = await Backend.ocr(jpeg);
  if (!r || !r.available) {
    if (Backend.inApp && !ocrMissingTold && !quiet) {
      ocrMissingTold = true;
      toast('Text recognition isn’t set up in Windows (Settings › Time & language › Language › add a language with OCR). Saved without searchable text.', { bad: true });
    }
    return null;
  }
  const lines = Array.isArray(r.lines) ? r.lines : r.lines ? [r.lines] : [];
  const words = [];
  lines.forEach((line, l) => {
    const ws = Array.isArray(line.words) ? line.words : line.words ? [line.words] : [];
    for (const w of ws) words.push({ t: w.t, l, x: w.x / k, y: w.y / k, w: w.w / k, h: w.h / k });
  });
  return words;
}
for (const b of $('formatSeg').children) b.onclick = () => { settings.format = b.dataset.v; saveSettings(); renderFormat(); };

function updateSaveLabel() {
  const n = state.pages.length;
  const what = { pdf: n > 1 ? 'one PDF' : 'PDF', jpg: n > 1 ? 'JPGs' : 'JPG', png: n > 1 ? 'PNGs' : 'PNG' }[settings.format];
  $('saveLabel').textContent = n ? `Save ${n} page${n === 1 ? '' : 's'} as ${what}` : 'Save';
  $('saveBtn').disabled = !n || state.saving || state.scanning;
  $('saveNewBtn').disabled = !n || state.saving || state.scanning;
  $('printBtn').disabled = !n || state.saving || state.scanning;
}

function renderFolder() { $('folderText').textContent = settings.folder; $('folderBtn').title = settings.folder; }
$('folderBtn').onclick = async () => {
  const f = await Backend.pickFolder(settings.folder);
  if (f) {
    settings.folder = f;
    saveSettings();
    renderFolder();
    if (!state.nameEdited) suggestName();
  }
};

const sep = () => (settings.folder.includes('\\') || !settings.folder.includes('/') ? '\\' : '/');
const joinPath = (name) => settings.folder.replace(/[\\/]+$/, '') + sep() + name;
const cleanName = (s) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').trim() || `Scan ${today()}`;

async function freeBase(base, ext, multi) {
  for (let k = 1; k < 1000; k++) {
    const b = k === 1 ? base : `${base} (${k})`;
    const probe = multi ? `${b} p01.${ext}` : `${b}.${ext}`;
    if (!(await Backend.exists(joinPath(probe)))) return b;
  }
  return `${base} ${Date.now()}`;
}

async function save(startNew) {
  if (!state.pages.length || state.saving || state.scanning) return;
  if (state.cropping) finishCrop();
  state.saving = true;
  updateSaveLabel();
  updateScanBar();
  const fmt = settings.format;
  const pages = state.pages.slice();
  const n = pages.length;
  let firstPath = '';
  try {
    const base = await freeBase(cleanName($('fileName').value), fmt, fmt !== 'pdf' && n > 1);
    if (fmt === 'pdf') {
      const parts = [];
      for (let i = 0; i < n; i++) {
        const ready = pages[i].prepared;
        if (ready && ready.key === prepKey(pages[i]) && (ready.words || ready.ocrTried || !settings.searchable)) {
          const [pageW, pageH] = PdfWriter.pageSize(ready.width, ready.height, pages[i].dpi, settings.paper);
          parts.push({ jpeg: ready.jpeg, bits: ready.bits, width: ready.width, height: ready.height, dpi: pages[i].dpi, words: ready.words, pageW, pageH });
          continue;
        }
        toast(`Preparing page ${i + 1} of ${n}…`, { sticky: true });
        await nextFrame();
        const c = Imaging.render(pages[i], Infinity);
        const img = await pageImage(c, pages[i]);
        let words = null;
        if (settings.searchable) {
          toast(`Reading the text on page ${i + 1} of ${n}…`, { sticky: true });
          try { words = await recognise(c); } catch (e) { console.warn('OCR failed', e); }
        }
        const [pageW, pageH] = PdfWriter.pageSize(c.width, c.height, pages[i].dpi, settings.paper);
        parts.push({ ...img, width: c.width, height: c.height, dpi: pages[i].dpi, words, pageW, pageH });
        c.width = c.height = 0;
      }
      toast('Writing PDF…', { sticky: true });
      await nextFrame();
      const pdf = PdfWriter.build(parts, base);
      firstPath = await Backend.saveFile(joinPath(`${base}.pdf`), pdf);
    } else {
      const type = fmt === 'png' ? 'image/png' : 'image/jpeg';
      for (let i = 0; i < n; i++) {
        toast(`Saving page ${i + 1} of ${n}…`, { sticky: true });
        await nextFrame();
        const c = Imaging.render(pages[i], Infinity);
        const bytes = new Uint8Array(await (await Imaging.toBlob(c, type, 0.92)).arrayBuffer());
        c.width = c.height = 0;
        const name = n > 1 ? `${base} p${String(i + 1).padStart(2, '0')}.${fmt}` : `${base}.${fmt}`;
        const saved = await Backend.saveFile(joinPath(name), bytes);
        if (!firstPath) firstPath = saved;
      }
    }
    const where = fmt === 'pdf' ? `${base}.pdf` : (n > 1 ? `${n} ${fmt.toUpperCase()}s` : `${base}.${fmt}`);
    toast(`Saved ${n} page${n === 1 ? '' : 's'}: ${where}`, { action: 'Show in folder', onAction: () => Backend.reveal(firstPath), duration: 7000 });
    if (startNew) {
      while (state.pages.length) removePage(0, { undoable: false });
      if (lastRemoved) { dropPage(lastRemoved.page); lastRemoved = null; }
      if (lastSplit) { dropPage(lastSplit.page); lastSplit = null; }
      await suggestName();
    }
  } catch (e) {
    toast((e && e.error) || (e && e.message) || 'Couldn’t save.', { bad: true });
  } finally {
    state.saving = false;
    updateSaveLabel();
    updateScanBar();
  }
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- Printing ----------
async function printPages(list) {
  const pages = Array.isArray(list) ? list : state.pages;
  if (!pages.length || state.saving || state.scanning) return;
  if (state.cropping) finishCrop();
  const area = $('printArea');
  clearPrint();
  toast('Preparing to print…', { sticky: true });
  for (const p of pages) {
    await nextFrame();
    const c = Imaging.render(p, 2600);
    const url = URL.createObjectURL(await Imaging.toBlob(c, 'image/jpeg', 0.9));
    c.width = c.height = 0;
    const div = document.createElement('div');
    div.className = 'print-page';
    const img = new Image();
    img.src = url;
    img.alt = '';
    div.appendChild(img);
    area.appendChild(div);
    await img.decode().catch(() => {});
  }
  $('toast').hidden = true;
  window.print();
}
function clearPrint() {
  const area = $('printArea');
  for (const img of area.querySelectorAll('img')) URL.revokeObjectURL(img.src);
  area.innerHTML = '';
}
window.addEventListener('afterprint', () => setTimeout(clearPrint, 500));
$('printBtn').onclick = () => printPages();
$('saveBtn').onclick = () => save(false);
$('saveNewBtn').onclick = () => save(true);

// ---------- Toast ----------
let toastTimer = null;
function toast(text, { bad = false, action = '', onAction = null, sticky = false, duration = 4000 } = {}) {
  const t = $('toast');
  $('toastText').textContent = text;
  t.classList.toggle('bad', bad);
  const a = $('toastAction');
  a.hidden = !action;
  a.textContent = action;
  a.onclick = () => { t.hidden = true; if (onAction) onAction(); };
  t.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { t.hidden = true; }, bad ? Math.max(duration, 7000) : duration);
}

// ---------- Keyboard ----------
const isTyping = (el) => el && (el.tagName === 'INPUT' && el.type === 'text');
window.addEventListener('keydown', (e) => {
  const typing = isTyping(document.activeElement);
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'p') {
    e.preventDefault();
    printPages();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 's') {
    e.preventDefault();
    save(e.shiftKey);
    return;
  }
  if (typing) {
    if (k === 'Escape' || k === 'Enter') document.activeElement.blur();
    return;
  }
  if (k === ' ') {
    e.preventDefault();
    if (!e.repeat && !state.scanning) {
      if (e.shiftKey && cur()) scan({ replace: cur() });
      else scanFromUser();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); undoRemove(); return; }
  if (k === 'Escape') {
    if (autoTimer || autoRunning) { autoRunning = false; stopAuto(); }
    if (state.scanning) cancelScan();
    else if (state.cropping) finishCrop();
    $('deviceMenu').hidden = true;
    return;
  }
  const onRange = document.activeElement && document.activeElement.type === 'range';
  const onSelect = document.activeElement && document.activeElement.tagName === 'SELECT';
  if (onRange || onSelect) return;
  if (k === 'Enter' && state.cropping) { e.preventDefault(); finishCrop(); return; }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removePage(state.current); return; }
  if (k === 'r' || k === 'R') { rotate(e.shiftKey ? -1 : 1); return; }
  if (k === 'c' || k === 'C') { state.cropping ? finishCrop() : startCrop(); return; }
  if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); selectPage(state.current - 1); return; }
  if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); selectPage(state.current + 1); return; }
});
// Space must never "click" whichever button has focus.
window.addEventListener('keyup', (e) => { if (e.key === ' ' && !isTyping(document.activeElement)) e.preventDefault(); });
document.addEventListener('pointerup', (e) => {
  const b = e.target.closest && e.target.closest('button');
  if (b) setTimeout(() => b.blur(), 0);
});
window.addEventListener('contextmenu', (e) => { if (!isTyping(e.target)) e.preventDefault(); });

// ---------- Start ----------
(async function init() {
  if (!settings.folder) {
    try { settings.folder = await Backend.defaultFolder(); } catch { settings.folder = ''; }
    saveSettings();
  }
  renderPresets();
  renderFormat();
  renderFolder();
  renderThumbs();
  showPage();
  await suggestName();
  loadDevices();
  setTimeout(checkForUpdate, 4000);
})();

// ---------- Updates ----------
async function checkForUpdate() {
  const u = await Backend.checkUpdate();
  if (!u) return;
  toast(`Prisca ${u.version} is available.`, {
    action: 'Update and restart',
    duration: 20000,
    onAction: async () => {
      if (state.pages.length && !confirmLeave()) return;
      toast(`Downloading Prisca ${u.version}…`, { sticky: true });
      try {
        await u.downloadAndInstall();
        await Backend.relaunch();
      } catch (e) {
        toast(`Couldn’t update: ${(e && e.message) || e}`, { bad: true });
      }
    },
  });
}
// Unsaved pages would be lost by a restart.
function confirmLeave() {
  return window.confirm(`You have ${state.pages.length} unsaved page${state.pages.length === 1 ? '' : 's'}. Update anyway?`);
}

window.Prisca = { state, settings, scan, save, importBytes };
