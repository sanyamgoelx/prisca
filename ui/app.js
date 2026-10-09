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

async function addBitmap(bitmap, dpi, presetKey, scannedGrey, replace = null) {
  const page = newPage(bitmap, dpi, presetKey);
  page.scannedGrey = !!scannedGrey;
  Imaging.analyse(page);
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
  return page;
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
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

const thumbTimers = new Map();
function refreshThumb(page, delay = 0) {
  clearTimeout(thumbTimers.get(page.id));
  thumbTimers.set(page.id, setTimeout(async () => {
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
  for (const id of ['rotL', 'rotR', 'cropBtn', 'deletePage', 'rescanBtn']) $(id).disabled = !p;
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
  $('pageMeta').textContent = `Page ${state.current + 1} · ${w}×${h} · ${p.dpi} dpi${skew}`;
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
  const c = p.crop;
  p.crop = dir > 0
    ? { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w }
    : { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
  p.rot = (p.rot + (dir > 0 ? 90 : 270)) % 360;
  refreshThumb(p);
  updateMeta();
  scheduleRender();
}
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
  } else {
    $('scanLabel').textContent = settings.source === 'feeder' ? 'Scan feeder' : `Scan page ${n}`;
    btn.querySelector('.key').textContent = 'Space';
  }
  btn.disabled = state.saving || (!state.scanning && state.devicesLoaded && !currentDevice() && Backend.inApp);
  $('copyBtn').disabled = state.scanning || state.saving || (state.devicesLoaded && !currentDevice() && Backend.inApp);
}

let scanClock = null;
async function scan({ replace = null, copy = false } = {}) {
  if (state.scanning || state.saving) return;
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
  renderDevice();
  renderThumbs();
  try {
    const source = copy ? 'flatbed' : settings.source;
    const r = await Backend.scan({ device: d.id, deviceName: d.name, dpi: ps.dpi, intent, source });
    if (!r.pages.length) throw { code: 'empty', error: 'The scanner sent no pages.' };
    let blank = 0;
    const added = [];
    for (const pg of r.pages) {
      const bytes = await Backend.readFile(pg.path);
      Backend.discard(pg.path);
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const target = replace && state.pages.includes(replace) && r.pages.length === 1 ? replace : null;
      const page = await addBitmap(bitmap, pg.dpi || r.dpi || ps.dpi, presetKey, intent !== 'color' && !r.simple, target);
      // Feeder batches: drop blank sheets (backs of one-sided pages).
      if (source === 'feeder' && Imaging.isBlank(page)) { removePage(state.pages.indexOf(page), { undoable: false }); blank++; continue; }
      added.push(page);
    }
    if (blank) toast(`Skipped ${blank} blank page${blank === 1 ? '' : 's'}.`);
    if (copy && added.length) {
      state.scanning = false;
      $('scanning').hidden = true;
      await printPages(added);
    }
  } catch (e) {
    if (e && e.code === 'cancelled') toast('Scan cancelled.');
    else {
      toast((e && e.error) || 'Scanning failed.', { bad: true, action: 'Try again', onAction: scan });
      if (e && (e.code === 'notfound' || e.code === 'offline')) loadDevices();
    }
  } finally {
    clearInterval(scanClock);
    state.scanning = false;
    $('scanning').hidden = true;
    renderDevice();
    renderThumbs();
  }
}

function cancelScan() {
  if (state.scanning) Backend.cancel();
}

$('scanBtn').onclick = () => (state.scanning ? cancelScan() : scan());
$('copyBtn').onclick = () => { if (!state.scanning) scan({ copy: true }); };
$('rescanBtn').onclick = () => { if (cur()) scan({ replace: cur() }); };

// ---------- Importing pictures ----------
async function importBytes(list) {
  let added = 0;
  for (const { bytes, name } of list) {
    try {
      const bitmap = await createImageBitmap(new Blob([bytes]));
      await addBitmap(bitmap, 200, settings.preset, false);
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
  const prefix = `Scan ${today()}`;
  let n = 1;
  try { n = await Backend.nextNumber(settings.folder, prefix); } catch {}
  $('fileName').value = `${prefix} ${String(n).padStart(3, '0')}`;
  state.nameEdited = false;
}
$('fileName').addEventListener('input', () => { state.nameEdited = true; });

function renderFormat() {
  for (const b of $('formatSeg').children) b.setAttribute('aria-checked', String(b.dataset.v === settings.format));
  $('searchableRow').hidden = settings.format !== 'pdf';
  $('paperRow').hidden = settings.format !== 'pdf';
  $('paper').value = settings.paper;
  $('searchable').checked = settings.searchable;
  updateSaveLabel();
}
$('paper').onchange = (e) => { settings.paper = e.target.value; saveSettings(); };
$('searchable').onchange = (e) => { settings.searchable = e.target.checked; saveSettings(); };

// Text on a page via Windows OCR, as words in the page's own pixels. Null if unavailable.
let ocrMissingTold = false;
async function recognise(canvas) {
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
    if (Backend.inApp && !ocrMissingTold) {
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
        toast(`Preparing page ${i + 1} of ${n}…`, { sticky: true });
        await nextFrame();
        const c = Imaging.render(pages[i], Infinity);
        const jpeg = new Uint8Array(await (await Imaging.toBlob(c, 'image/jpeg', pages[i].adj.mode === 'bw' ? 0.9 : 0.85)).arrayBuffer());
        let words = null;
        if (settings.searchable) {
          toast(`Reading the text on page ${i + 1} of ${n}…`, { sticky: true });
          try { words = await recognise(c); } catch (e) { console.warn('OCR failed', e); }
        }
        const [pageW, pageH] = PdfWriter.pageSize(c.width, c.height, pages[i].dpi, settings.paper);
        parts.push({ jpeg, width: c.width, height: c.height, dpi: pages[i].dpi, words, pageW, pageH });
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
    if (!e.repeat && !state.scanning) scan(e.shiftKey && cur() ? { replace: cur() } : {});
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); undoRemove(); return; }
  if (k === 'Escape') {
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
