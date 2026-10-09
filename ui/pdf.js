// Prisca PDF writer: one JPEG per page, page size from the scan resolution.
'use strict';

const PdfWriter = (() => {
  const enc = new TextEncoder();

  // pages: [{ jpeg: Uint8Array, width, height (pixels), dpi }]
  function build(pages, title) {
    const chunks = [];
    let length = 0;
    const offsets = [];
    const push = (data) => {
      const b = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(b);
      length += b.length;
    };
    const obj = (n, body, stream) => {
      offsets[n] = length;
      push(`${n} 0 obj\n${body}\n`);
      if (stream) {
        push('stream\n');
        push(stream);
        push('\nendstream\n');
      }
      push('endobj\n');
    };

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    // 1 catalog, 2 pages, 3 info, then 3 objects per page: page, image, content;
    // last, the font for the invisible text layer (searchable PDFs).
    const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
    const fontN = 4 + pages.length * 3;
    const hasText = pages.some((p) => p.words && p.words.length);
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `D:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    obj(3, `<< /Title ${pdfString(title || 'Scan')} /Producer (Prisca) /Creator (Prisca) /CreationDate (${date}) >>`);

    pages.forEach((p, i) => {
      const pageN = 4 + i * 3, imgN = pageN + 1, contentN = pageN + 2;
      const dpi = p.dpi > 0 ? p.dpi : 200;
      // Picture size in points; the page is that, or a paper size it is fitted into.
      const iw = (p.width * 72) / dpi, ih = (p.height * 72) / dpi;
      const W = round2(p.pageW || iw), H = round2(p.pageH || ih);
      const fit = Math.min(W / iw, H / ih);
      const dw = iw * fit, dh = ih * fit, ox = (W - dw) / 2, oy = (H - dh) / 2;
      const font = hasText ? ` /Font << /F1 ${fontN} 0 R >>` : '';
      obj(pageN, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${imgN} 0 R >>${font} /ProcSet [/PDF /Text /ImageC /ImageB] >> /Contents ${contentN} 0 R >>`);
      obj(imgN, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
      const content = latin1(`q ${round2(dw)} 0 0 ${round2(dh)} ${round2(ox)} ${round2(oy)} cm /Im0 Do Q` + textLayer(p.words, (72 / dpi) * fit, ox, oy, p.height));
      obj(contentN, `<< /Length ${content.length} >>`, content);
    });

    if (hasText) obj(fontN, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

    const xref = length;
    const count = 4 + pages.length * 3 + (hasText ? 1 : 0);
    let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n++) x += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(x);
    push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  // WinAnsi text: every character here is already below 256.
  function latin1(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  // Helvetica glyph widths (1/1000 em) for ASCII 32..126.
  const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];

  // Invisible text (render mode 3) laid over each word, so the PDF can be
  // searched and copied. words: [{ t, l (line), x, y, w, h }] in page pixels.
  // Each word is stretched to its box; the gap to the next word on the line
  // gets a real space, so copied text keeps its spaces.
  function textLayer(words, s, ox, oy, imgH) {
    if (!words || !words.length) return '';
    let out = '\nBT 3 Tr';
    const put = (t, x, y, width, fs) => {
      const natural = (t.em / 1000) * fs;
      const tz = Math.min(500, Math.max(5, (width / natural) * 100));
      out += `\n/F1 ${round2(fs)} Tf ${round2(tz)} Tz 1 0 0 1 ${round2(x)} ${round2(y)} Tm (${t.esc}) Tj`;
    };
    const space = { esc: ' ', em: 278 };
    for (let i = 0; i < words.length; i++) {
      const wd = words[i];
      const t = pdfText(wd.t);
      if (!t.em || wd.w <= 0 || wd.h <= 0) continue;
      const fs = Math.max(1, wd.h * s);
      const y = oy + (imgH - (wd.y + wd.h)) * s + fs * 0.18;
      put(t, ox + wd.x * s, y, wd.w * s, fs);
      const next = words[i + 1];
      if (next && next.l === wd.l) {
        const gap = (next.x - (wd.x + wd.w)) * s;
        put(space, ox + (wd.x + wd.w) * s, y, Math.max(gap, fs * 0.1), fs);
      }
    }
    return out + '\nET';
  }

  // WinAnsi-safe, escaped text and its width in 1/1000 em.
  function pdfText(s) {
    const map = { '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u00a0': ' ' };
    let esc = '', em = 0;
    for (const ch of String(s)) {
      const c = map[ch] || ch;
      for (const k of c) {
        const code = k.charCodeAt(0);
        if (code < 32 || (code > 126 && code < 160) || code > 255) continue;
        esc += k === '(' || k === ')' || k === '\\' ? '\\' + k : k;
        em += code <= 126 ? HELV[code - 32] : 556;
      }
    }
    return { esc, em };
  }

  // UTF-16BE string so any file name works as the title.
  function pdfString(s) {
    let hex = 'FEFF';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
      } else hex += cp.toString(16).padStart(4, '0');
    }
    return `<${hex.toUpperCase()}>`;
  }

  // Page size in points for a picture of w×h pixels at dpi.
  // paper: 'auto' (A4 or Letter when the scan is close to one), 'a4', 'letter', 'actual'.
  const PAPERS = { a4: [595.28, 841.89], letter: [612, 792] };
  function pageSize(w, h, dpi, paper) {
    const iw = (w * 72) / dpi, ih = (h * 72) / dpi;
    const land = iw > ih;
    const orient = (wh) => (land ? [wh[1], wh[0]] : wh);
    if (paper === 'a4' || paper === 'letter') return orient(PAPERS[paper]);
    if (paper === 'auto') {
      for (const key of ['a4', 'letter']) {
        const [pw, ph] = orient(PAPERS[key]);
        if (Math.abs(iw / pw - 1) < 0.07 && Math.abs(ih / ph - 1) < 0.07) return [pw, ph];
      }
    }
    return [iw, ih];
  }

  return { build, pageSize };
})();
