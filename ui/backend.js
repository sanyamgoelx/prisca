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
      return { pages: toArray(r.pages), dpi: r.dpi, simple: !!r.simple, setupMs: r.setupMs, totalMs: r.totalMs, warm: !!r.warm };
    },
    cancel: () => call('cancel_scan').catch(() => {}),
    probe: (device, deviceName) => call('probe_scanner', { device, deviceName }),
    releaseScanner: () => call('release_scanner').catch(() => {}),
    logPath: () => call('scanner_log_path'),
    logTail: (lines) => call('scanner_log_tail', { lines }).catch(() => ''),
    version: async () => { try { return await T.app.getVersion(); } catch { return '?'; } },
    openUrl: (url) => T.opener.openUrl(url),
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
        title: 'Add pictures or PDFs',
        filters: [{ name: 'Pictures and PDFs', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'jfif', 'bmp', 'webp', 'gif', 'tif', 'tiff'] }],
      });
      return r ? (Array.isArray(r) ? r : [r]) : [];
    },
    reveal: (path) => T.opener.revealItemInDir(path).catch(() => {}),
    // Printing: Windows' printers, a printer's paper sizes and unprintable edge, and print jobs.
    printers: async () => toArray((await call('list_printers')).printers),
    printerInfo: (name, paper) => call('printer_info', { name, paper: paper || 0 }),
    stagePrint: (bytes) => call('stage_print', bytes),
    print: (job) => call('print_job', { job }),
    // PDFs, files Prisca was opened with (right-click menu), and the Prisca printer.
    pdfPages: async (path, dpi, max) => { const r = await call('pdf_pages', { path, dpi, max }); return { ...r, pages: toArray(r.pages) }; },
    startupArgs: () => call('take_startup_args').catch(() => []),
    onArgs: (fn) => { T.event.listen('prisca://args', (e) => fn(e.payload || [])); },
    inboxTake: () => call('inbox_take').catch(() => ({ files: [], waiting: 0 })),
    printerSetupState: () => call('printer_setup_state'),
    printerSetup: (mode) => call('printer_setup', { mode }),
    contextMenu: (on) => call('context_menu', { on }),
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
      if (window.PRISCA_MOCK_IMAGE) { files.set(path, new Uint8Array(await (await fetch(window.PRISCA_MOCK_IMAGE)).arrayBuffer())); return { pages: [{ path }], dpi: o.dpi }; }
      files.set(path, window.PRISCA_MOCK_BLANK ? await blankScan(o.dpi) : window.PRISCA_MOCK_SAME && lastFake ? lastFake : (lastFake = await fakeScan(o.dpi, o.intent)));
      return { pages: [{ path }], dpi: o.dpi };
    },
    cancel: async () => { cancelled = true; },
    probe: async () => ({ probe: { mock: true } }),
    releaseScanner: async () => {},
    logPath: async () => '',
    logTail: async () => '12:00:00.000 scan: device=Mock dpi=200 intent=grey\n12:00:19.000 scan done',
    version: async () => 'preview',
    openUrl: async (url) => { window.PRISCA_OPENED = url; },
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
    printers: async () => window.PRISCA_MOCK_PRINTERS || [
      { name: 'HP Deskjet 1510 series', default: true, state: 'ready' },
      { name: 'Microsoft Print to PDF', default: false, state: 'ready' },
    ],
    printerInfo: async (name, paper) => {
      const sizes = [
        { kind: 9, name: 'A4', w: 210, h: 297 }, { kind: 1, name: 'Letter', w: 215.9, h: 279.4 },
        { kind: 5, name: 'Legal', w: 215.9, h: 355.6 }, { kind: 11, name: 'A5', w: 148, h: 210 },
        { kind: 260, name: '4x6in', w: 101.6, h: 152.4 },
      ];
      const pick = sizes.find((s) => s.kind === paper) || sizes[0];
      const hp = /HP/.test(name);
      return { sizes, paper: pick.kind, hard: hp ? { t: 3, r: 3.2, b: 12.7, l: 3.2 } : { t: 0, r: 0, b: 0, l: 0 }, color: true, duplex: false, draft: true, maxCopies: 99 };
    },
    stagePrint: async (bytes) => { const path = `mock://print-${files.size}-${Date.now()}.jpg`; files.set(path, bytes); return path; },
    pdfPages: async (path, dpi, max) => {
      if (window.PRISCA_MOCK_PDF_FAIL) throw { code: 'pdf', error: window.PRISCA_MOCK_PDF_FAIL };
      const n = window.PRISCA_MOCK_PDF_PAGES || 2, pages = [];
      for (let i = 0; i < Math.min(n, max || 150); i++) {
        const c = document.createElement('canvas');
        c.width = Math.round(8.27 * dpi); c.height = Math.round(11.69 * dpi);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#1a3a6b'; g.font = `${dpi / 3}px sans-serif`; g.fillText(`PDF page ${i + 1}`, dpi, dpi * 1.5);
        const p = `mock://pdf-${i}-${Date.now()}.png`;
        files.set(p, new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()));
        pages.push({ path: p, wIn: 8.27, hIn: 11.69, dpi });
      }
      return { pages, count: n, rendered: pages.length, dpi };
    },
    startupArgs: async () => window.PRISCA_MOCK_ARGS || [],
    onArgs: (fn) => { window.PRISCA_SEND_ARGS = fn; },
    inboxTake: async () => { const f = window.PRISCA_MOCK_INBOX || []; window.PRISCA_MOCK_INBOX = []; return { files: f, waiting: 0 }; },
    printerSetupState: async () => window.PRISCA_MOCK_PRINTER_STATE || { printer: false, task: false },
    printerSetup: async (mode) => { window.PRISCA_MOCK_PRINTER_STATE = { printer: mode !== 'remove', task: mode !== 'remove', taskError: '' }; return window.PRISCA_MOCK_PRINTER_STATE; },
    contextMenu: async (on) => { window.PRISCA_MOCK_MENU = on; return on; },
    print: async (job) => {
      if (window.PRISCA_MOCK_PRINT_FAIL) throw { code: 'print', error: window.PRISCA_MOCK_PRINT_FAIL };
      (window.PRISCA_PRINTED = window.PRISCA_PRINTED || []).push(job);
      return { sheets: job.sheets.length, copies: job.copies };
    },
    checkUpdate: async () => window.PRISCA_MOCK_UPDATE || null,
    relaunch: async () => { window.RELAUNCHED = true; },
    onFileDrop: () => {},
  };

  let fakeCount = 0, lastFake = null;
  async function blankScan(dpi) {
    const s = dpi / 100, c = document.createElement('canvas');
    c.width = Math.round(850 * s); c.height = Math.round(1169 * s);
    const g = c.getContext('2d'); g.fillStyle = '#e9e8e4'; g.fillRect(0, 0, c.width, c.height);
    return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
  }
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
    const seed = fakeCount * 7;
    let y = 120 * s;
    for (let l = 0; l < 34; l++) {
      if (l % 9 === 8) { y += 14 * s; continue; }
      let line = '';
      const len = 3 + ((l * 5 + seed) % 7);
      for (let k = 0; k < len; k++) line += words[(l * 7 + k * 3 + seed) % words.length] + ' ';
      g.fillText(line, 40 * s, y);
      y += 18 * s;
    }
    g.restore();
    return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
  }

  return inApp ? real : mock;
})();
