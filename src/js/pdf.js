// pdf.js: Anzeigen, Rendern und Text auslesen
import * as pdfjsLib from '../vendor/pdfjs/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/build/pdf.worker.min.mjs', document.baseURI).href;
export { pdfjsLib };

const BASE = new URL('vendor/pdfjs/', document.baseURI).href;

export async function openPdf(bytes, password) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(), // pdf.js übernimmt den Puffer, daher Kopie
    password,
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/',
    iccUrl: BASE + 'iccs/',
    isEvalSupported: false,
  });
  return task.promise;
}

// Rendert eine Seite in ein Canvas. scale 1 = 72 dpi
export async function renderPage(doc, pageIndex, scale = 1, opts = {}) {
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale, rotation: (page.rotate + (opts.extraRotation || 0)) % 360 });
  const canvas = opts.canvas || document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport, annotationMode: opts.annotationMode ?? pdfjsLib.AnnotationMode.ENABLE }).promise;
  return { canvas, viewport, page };
}

export function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((res) => canvas.toBlob(res, type, quality));
}
export async function canvasToBytes(canvas, type = 'image/png', quality = 0.92) {
  const b = await canvasToBlob(canvas, type, quality);
  return new Uint8Array(await b.arrayBuffer());
}

// Text einer Seite mit Positionen (Darstellungskoordinaten in Punkt, Ursprung oben links)
export async function pageTextItems(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]) || Math.abs(it.transform[3]) || 10;
    const vertical = Math.abs(tx[1]) > Math.abs(tx[0]);
    const width = it.width * (viewport.scale || 1);
    const style = tc.styles[it.fontName] || {};
    items.push({
      str: it.str, x: tx[4], y: tx[5] - fontHeight * 0.85, baseline: tx[5], width, height: fontHeight,
      fontSize: fontHeight, fontName: it.fontName, family: style.fontFamily || '', vertical, hasEOL: it.hasEOL,
    });
  }
  return { items, width: viewport.width, height: viewport.height };
}

export async function pageHasText(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1);
  const tc = await page.getTextContent();
  return tc.items.some((i) => i.str && i.str.trim().length > 0);
}

// Text zu Zeilen gruppieren
export function groupLines(items) {
  const sorted = items.filter((i) => i.str.length && !i.vertical).sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.baseline - it.baseline) < Math.max(2, it.height * 0.35)) last.items.push(it);
    else lines.push({ baseline: it.baseline, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    const cells = [{ x: l.items[0].x, text: '' }];
    for (const it of l.items) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        if (gap > Math.max(it.height * 2, 14) && it.str.trim()) cells.push({ x: it.x, text: '' });
        else if (gap > it.height * 0.18 && !cells[cells.length - 1].text.endsWith(' ') && !it.str.startsWith(' ')) cells[cells.length - 1].text += ' ';
        if (gap > it.height * 0.18 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      }
      text += it.str;
      cells[cells.length - 1].text += it.str;
      if (it.str.trim()) prevEnd = it.x + it.width;
      else if (prevEnd === null) prevEnd = it.x;
    }
    l.text = text.replace(/\s+$/, '');
    l.cells = cells.map((c) => ({ x: c.x, text: c.text.trim() })).filter((c) => c.text);
    l.x = l.items[0].x;
    l.right = prevEnd;
    l.size = Math.max(...l.items.map((i) => i.height));
    l.top = l.baseline - l.size;
    l.bold = l.items.some((i) => /bold|black|heavy|semibold/i.test(i.fontName + ' ' + i.family));
  }
  return lines;
}

export async function documentText(doc) {
  const pages = [];
  for (let i = 0; i < doc.numPages; i++) {
    const { items } = await pageTextItems(doc, i);
    pages.push(groupLines(items).map((l) => l.text).join('\n'));
  }
  return pages;
}

// Eingebettete Bilder einer Seite
// Eingebettete Bilder einer Seite inkl. Position (Darstellungskoordinaten in Punkt, oben links)
export async function pageImages(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const found = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform && args && args.length === 6) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); const m = args && args[0]; if (m && m.length === 6) ctm = mul(ctm, Array.from(m)); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat || fn === OPS.paintInlineImageXObject) {
      const m = mul(viewport.transform, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      found.push({ ref: fn === OPS.paintInlineImageXObject ? { inline: args[0] } : args[0], rect });
    }
  }
  const out = [];
  for (const f of found) {
    let img;
    if (typeof f.ref === 'object' && f.ref && f.ref.inline) img = f.ref.inline;
    else if (typeof f.ref === 'string') {
      img = await new Promise((resolve) => {
        const store = f.ref.startsWith('g_') ? page.commonObjs : page.objs;
        try { store.get(f.ref, resolve); } catch (_) { resolve(null); }
        setTimeout(() => resolve(null), 4000);
      });
    }
    if (!img) continue;
    out.push({ key: typeof f.ref === 'string' ? f.ref : null, img, rect: f.rect });
  }
  return out;
}

export function imageObjectToCanvas(img) {
  const w = img.width, h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (img.bitmap) { ctx.drawImage(img.bitmap, 0, 0); return canvas; }
  if (!img.data) return null;
  const id = ctx.createImageData(w, h);
  const src = img.data, dst = id.data;
  const kind = img.kind; // 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  if (kind === 3) dst.set(src.subarray(0, dst.length));
  else if (kind === 2) {
    for (let i = 0, j = 0; j < dst.length; i += 3, j += 4) { dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; dst[j + 3] = 255; }
  } else if (kind === 1) {
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const v = bit ? 255 : 0, j = (y * w + x) * 4;
      dst[j] = dst[j + 1] = dst[j + 2] = v; dst[j + 3] = 255;
    }
  } else return null;
  ctx.putImageData(id, 0, 0);
  return canvas;
}
