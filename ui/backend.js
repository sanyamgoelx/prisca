// Prisca backend calls. Inside the app they go to Rust; opened in a plain
// browser (for design work and tests) a stand-in scanner makes fake pages.
'use strict';

const Backend = (() => {
  const T = window.__TAURI__;
  const inApp = !!(T && T.core);

  function parseError(e) {
    const text = typeof e === 'string' ? e : (e && e.message) || String(e);
    try {
      const j = JSON.parse(text);
      if (j && j.error) return j;
    } catch {}
    return { code: 'unknown', error: text };
  }

  async function call(cmd, args, opts) {
    try {
      return await T.core.invoke(cmd, args, opts);
    } catch (e) {
      throw parseError(e);
    }
  }

  const real = {
    inApp: true,
    listDevices: async () => {
      const r = await call('list_devices');
      return toArray(r.devices);
    },
    scan: async (o) => {
      const r = await call('scan', { device: o.device || '', deviceName: o.deviceName || '', dpi: o.dpi, intent: o.intent, source: o.source });
      return { pages: toArray(r.pages), dpi: r.dpi, simple: !!r.simple };
    },
    cancel: () => call('cancel_scan').catch(() => {}),
    probe: (device, deviceName) => call('probe_scanner', { device, deviceName }),
    logPath: () => call('scanner_log_path'),
    ocr: (jpeg) => call('ocr_page', jpeg),
    readFile: async (path) => new Uint8Array(await call('read_file', { path })),
    discard: (path) => call('discard_scan', { path }).catch(() => {}),
    saveFile: (path, bytes) => call('save_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } }),
    defaultFolder: () => call('default_folder'),
    nextNumber: (folder, prefix) => call('next_number', { folder, prefix }),
    exists: (path) => call('path_exists', { path }),
    pickFolder: async (current) => {
      const r = await T.dialog.open({ directory: true, defaultPath: current || undefined, title: 'Save scans in' });
      return typeof r === 'string' ? r : null;
    },
    pickImages: async () => {
      const r = await T.dialog.open({
        multiple: true,
        title: 'Add pictures',
        filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif', 'tif', 'tiff'] }],
      });
      return r ? (Array.isArray(r) ? r : [r]) : [];
    },
    reveal: (path) => T.opener.revealItemInDir(path).catch(() => {}),
    // A newer published version, or null (also null when updates aren't set up).
    checkUpdate: async () => {
      try { return T.updater ? await T.updater.check() : null; } catch { return null; }
    },
    relaunch: () => T.process.relaunch(),
    onFileDrop: (fn) => {
      T.event.listen('tauri://drag-drop', (e) => fn((e.payload && e.payload.paths) || []));
    },
  };

  function toArray(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
  }

  // ---------- Stand-in for browser previews ----------
  const files = new Map();
  let cancelled = false;
  const mock = {
    inApp: false,
    listDevices: async () => [{ id: 'mock', name: 'HP Deskjet 1510 series (preview)', manufacturer: 'HP', feeder: false, flatbed: true }],
    scan: async (o) => {
      cancelled = false;
      await new Promise((r) => setTimeout(r, window.PRISCA_MOCK_DELAY ?? 1200));
      if (cancelled) throw { code: 'cancelled', error: 'Scanning was cancelled.' };
      const path = `mock://scan-${Date.now()}.png`;
      files.set(path, await fakeScan(o.dpi, o.intent));
      return { pages: [{ path }], dpi: o.dpi };
    },
    cancel: async () => { cancelled = true; },
    probe: async () => ({ probe: { mock: true } }),
    logPath: async () => '',
    ocr: async () => window.PRISCA_MOCK_OCR || { available: false, lines: [] },
    readFile: async (path) => files.get(path),
    discard: async (path) => files.delete(path),
    saveFile: async (path, bytes) => {
      window.PRISCA_SAVED = window.PRISCA_SAVED || [];
      window.PRISCA_SAVED.push({ path, size: bytes.length, bytes });
      return path;
    },
    defaultFolder: async () => 'C:\\Users\\you\\Documents\\Prisca',
    nextNumber: async () => 1,
    exists: async () => false,
    pickFolder: async () => null,
    pickImages: async () => [],
    reveal: async () => {},
    checkUpdate: async () => window.PRISCA_MOCK_UPDATE || null,
    relaunch: async () => { window.RELAUNCHED = true; },
    onFileDrop: () => {},
  };

  let fakeCount = 0;
  async function fakeScan(dpi, intent) {
    const s = dpi / 100;
    const W = Math.round(850 * s), H = Math.round(1169 * s); // A4-ish flatbed
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#e4e3df';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#5a5a58';
    g.fillRect(0, 0, W, 3 * s);
    fakeCount++;
    const angle = [1.6, -2.2, 0.7, -1.1][fakeCount % 4];
    const pw = 600 * s, ph = 820 * s;
    g.save();
    g.translate(60 * s + pw / 2, 70 * s + ph / 2);
    g.rotate((angle * Math.PI) / 180);
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 3 * s;
    g.fillStyle = intent === 'color' ? '#f3ecd9' : '#efeeea';
    g.fillRect(-pw / 2, -ph / 2, pw, ph);
    g.shadowColor = 'transparent';
    g.translate(-pw / 2, -ph / 2);
    g.fillStyle = '#26303f';
    g.font = `600 ${22 * s}px sans-serif`;
    g.fillText(`Invoice ${1000 + fakeCount}`, 40 * s, 70 * s);
    g.fillStyle = '#b44a2c';
    g.beginPath(); g.arc(pw - 80 * s, 60 * s, 26 * s, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#444';
    g.font = `${11 * s}px sans-serif`;
    const words = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'.split(' ');
    let y = 120 * s;
    for (let l = 0; l < 34; l++) {
      if (l % 9 === 8) { y += 14 * s; continue; }
      let line = '';
      for (let k = 0; k < 9; k++) line += words[(l * 7 + k * 3) % words.length] + ' ';
      g.fillText(line, 40 * s, y);
      y += 18 * s;
    }
    g.restore();
    return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
  }

  return inApp ? real : mock;
})();
