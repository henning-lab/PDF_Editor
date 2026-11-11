// PDF Kernfunktionen (pdf-lib, Ghostscript, qpdf)
const { PDFDocument, StandardFonts, rgb, degrees, PageSizes, PDFName, PDFNumber } = window.PDFLib;
export { PDFDocument, StandardFonts, rgb, degrees, PageSizes };

import { native } from './native.js';
export { native };

export class UserError extends Error {}

export function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}
export function ext(name) {
  const m = /\.([^.]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / 1024 / 1024).toFixed(2).replace('.', ',')} MB`;
}
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// "1-3, 5, 8-" -> [0,1,2,4,7,...]
export function parseRanges(input, total, { allowEmpty = false } = {}) {
  const s = String(input || '').trim();
  if (!s) {
    if (allowEmpty) return [];
    throw new UserError('Bitte Seiten angeben, z. B. 1-3, 5');
  }
  const out = [];
  for (const partRaw of s.split(/[,;]+/)) {
    const part = partRaw.trim().toLowerCase();
    if (!part) continue;
    if (part === 'gerade' || part === 'even') { for (let i = 2; i <= total; i += 2) out.push(i - 1); continue; }
    if (part === 'ungerade' || part === 'odd') { for (let i = 1; i <= total; i += 2) out.push(i - 1); continue; }
    const m = part.match(/^(\d+|z|ende|last)?\s*(?:-\s*(\d+|z|ende|last)?)?$/);
    if (!m || (!m[1] && !m[2] && !part.includes('-'))) throw new UserError(`Ungültige Seitenangabe: „${partRaw.trim()}“`);
    const val = (v, d) => (v === undefined ? d : /^(z|ende|last)$/.test(v) ? total : parseInt(v, 10));
    const a = val(m[1], 1);
    const b = part.includes('-') ? val(m[2], total) : a;
    if (a < 1 || b < 1 || a > total || b > total) throw new UserError(`Seite außerhalb des Bereichs (1–${total}): „${partRaw.trim()}“`);
    if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1);
    else for (let i = a; i >= b; i--) out.push(i - 1);
  }
  return out;
}

export async function loadDoc(bytes) {
  return PDFDocument.load(bytes, { updateMetadata: false });
}
export async function saveDoc(doc, opts = {}) {
  return doc.save({ useObjectStreams: opts.objectStreams !== false });
}

// ---------- Engines ----------
export async function qpdf(args, inBytes, outName = 'out.pdf') {
  const r = await native.engine('qpdf', args, inBytes ? { 'in.pdf': inBytes } : {});
  // qpdf: 0 = ok, 3 = ok mit Warnungen
  if ((r.code === 0 || r.code === 3) && r.outFiles[outName]) return { data: r.outFiles[outName], log: r.log, code: r.code };
  const err = new Error(r.log.trim() || `qpdf Fehler ${r.code}`);
  err.code = r.code;
  err.log = r.log;
  throw err;
}

export async function gs(args, inBytes, outName = 'out.pdf', extraFiles = {}) {
  const r = await native.engine('gs', ['-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER', ...args], { ...(inBytes ? { 'in.pdf': inBytes } : {}), ...extraFiles });
  if (r.code === 0 && (outName === null || r.outFiles[outName])) return { data: outName ? r.outFiles[outName] : null, files: r.outFiles, log: r.log };
  throw new Error('Ghostscript: ' + (r.log.trim() || `Fehler ${r.code}`));
}

export function isWrongPassword(e) {
  return /invalid password|password.*incorrect|wrong password/i.test(String(e && (e.log || e.message)));
}

// Entfernt Verschlüsselung (mit oder ohne Passwort)
export async function decrypt(bytes, password = '') {
  const args = ['--decrypt'];
  if (password) args.push(`--password=${password}`);
  args.push('in.pdf', 'out.pdf');
  return (await qpdf(args, bytes)).data;
}

export async function isEncrypted(bytes) {
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
    return false;
  } catch (e) {
    if (/encrypted/i.test(e.message)) return true;
    throw e;
  }
}

export async function repair(bytes) {
  try {
    const r = await qpdf(['in.pdf', 'out.pdf'], bytes);
    await PDFDocument.load(r.data, { updateMetadata: false });
    return r.data;
  } catch (_) {
    const r = await gs(['-sDEVICE=pdfwrite', '-dPDFSETTINGS=/default', '-sOutputFile=out.pdf', 'in.pdf'], bytes);
    return r.data;
  }
}

// ---------- Seiten ----------
export async function pickPages(bytes, indices, rotations = {}) {
  const src = await loadDoc(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p, k) => {
    const extra = rotations[indices[k]] || 0;
    if (extra) p.setRotation(degrees((((p.getRotation().angle + extra) % 360) + 360) % 360));
    out.addPage(p);
  });
  copyInfo(src, out);
  return saveDoc(out);
}

export function copyInfo(src, out) {
  try {
    const t = src.getTitle(); if (t) out.setTitle(t);
    const a = src.getAuthor(); if (a) out.setAuthor(a);
  } catch (_) {}
  out.setProducer('PDF Editor');
}

export async function merge(list) {
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const src = await loadDoc(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  out.setProducer('PDF Editor');
  return saveDoc(out);
}

export async function pageCount(bytes) {
  return (await loadDoc(bytes)).getPageCount();
}

// Darstellungsgröße & Transformation (berücksichtigt /Rotate und CropBox)
export function displayBox(page) {
  const crop = page.getCropBox();
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  return { crop, rot, width: swap ? crop.height : crop.width, height: swap ? crop.width : crop.height };
}

// Legt ein eingebettetes Blatt (in Darstellungsgröße) aufrecht auf die Seite
export function drawUpright(page, embedded, { below = false } = {}) {
  const { crop, rot } = displayBox(page);
  const W = crop.width, H = crop.height;
  let o;
  if (rot === 0) o = { x: crop.x, y: crop.y, width: W, height: H };
  else if (rot === 90) o = { x: crop.x + W, y: crop.y, width: H, height: W, rotate: degrees(90) };
  else if (rot === 180) o = { x: crop.x + W, y: crop.y + H, width: W, height: H, rotate: degrees(180) };
  else o = { x: crop.x, y: crop.y + H, width: H, height: W, rotate: degrees(270) };
  page.drawPage(embedded, o);
  if (below) moveLastContentToFront(page);
}

// Verschiebt den zuletzt hinzugefügten Inhaltsstrom an den Anfang (= Hintergrund)
function moveLastContentToFront(page) {
  const node = page.node;
  const contents = node.Contents();
  if (!contents || !contents.asArray) return;
  const arr = contents.asArray();
  if (arr.length < 2) return;
  const last = arr[arr.length - 1];
  const newArr = node.context.obj([last, ...arr.slice(0, -1)]);
  node.set(PDFName.of('Contents'), newArr);
}

// Erstellt ein Overlay-PDF, auf dem in Darstellungskoordinaten gezeichnet wird, und legt es auf die Seite
export async function stampPages(doc, indices, drawFn, { below = false } = {}) {
  for (const i of indices) {
    const page = doc.getPage(i);
    const { width, height } = displayBox(page);
    const tmp = await PDFDocument.create();
    const tp = tmp.addPage([width, height]);
    const drew = await drawFn(tp, { width, height, index: i, tmpDoc: tmp });
    if (drew === false) continue;
    const bytes = await tmp.save();
    const [emb] = await doc.embedPdf(bytes, [0]);
    drawUpright(page, emb, { below });
  }
}

// ---------- Schriften ----------
let dejavu = null, dejavuBold = null;
async function loadFontBytes(file) {
  const r = await fetch(new URL(`fonts/${file}`, document.baseURI));
  return new Uint8Array(await r.arrayBuffer());
}
export function needsUnicodeFont(text) {
  // WinAnsi deckt Deutsch ab; alles andere -> DejaVu
  return /[^\u0000-ÿ€–—‘’‚“”„•…‰‹›ŒœŠšŸŽžƒˆ˜™]/.test(text);
}
export async function getFont(doc, family = 'Helvetica', { bold = false, italic = false, text = '' } = {}) {
  if (needsUnicodeFont(text)) {
    doc.registerFontkit(window.fontkit);
    if (bold) { dejavuBold = dejavuBold || await loadFontBytes('DejaVuSans-Bold.ttf'); return doc.embedFont(dejavuBold, { subset: true }); }
    dejavu = dejavu || await loadFontBytes('DejaVuSans.ttf');
    return doc.embedFont(dejavu, { subset: true });
  }
  const map = {
    Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
    Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
    Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
  };
  const f = map[family] || map.Helvetica;
  return doc.embedFont(f[(bold ? 1 : 0) + (italic ? 2 : 0)]);
}

// ---------- Bilder ----------
export async function imageToPng(bytes, mime) {
  const blob = new Blob([bytes], { type: mime || 'image/*' });
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const b = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await b.arrayBuffer());
}

export async function reencodeJpeg(bytes, quality = 0.93) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  return new Uint8Array(await b.arrayBuffer());
}

export function sniffImage(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  return null;
}

// JPEG mit EXIF-Drehung korrekt einlesen -> immer über Canvas normalisieren wenn nötig
function jpegOrientation(bytes) {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 2;
    while (off < v.byteLength) {
      const marker = v.getUint16(off);
      if (marker === 0xffe1) {
        const exifStart = off + 4;
        if (v.getUint32(exifStart) !== 0x45786966) return 1;
        const tiff = exifStart + 6;
        const little = v.getUint16(tiff) === 0x4949;
        const ifd = tiff + v.getUint32(tiff + 4, little);
        const n = v.getUint16(ifd, little);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little);
        }
        return 1;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + v.getUint16(off + 2);
    }
  } catch (_) {}
  return 1;
}

export async function embedImageAny(doc, file) {
  let bytes = file.data;
  let kind = sniffImage(bytes);
  const e = ext(file.name);
  if (['heic', 'heif', 'tif', 'tiff'].includes(e) && !kind) {
    try {
      bytes = await native.heicToJpeg({ name: file.name, data: bytes });
      kind = 'jpg';
    } catch (_) {}
  }
  if (kind === 'jpg' && jpegOrientation(bytes) !== 1) {
    bytes = await reencodeJpeg(bytes); // Browser wendet EXIF-Drehung an, Foto bleibt JPEG (klein)
  }
  if (!kind) {
    try { bytes = await imageToPng(bytes); kind = 'png'; } catch (_) { throw new UserError(`Bildformat von „${file.name}“ wird nicht unterstützt`); }
  }
  return kind === 'jpg' ? doc.embedJpg(bytes) : doc.embedPng(bytes);
}

export const PAGE_SIZES = {
  A3: [841.89, 1190.55], A4: [595.28, 841.89], A5: [419.53, 595.28], Letter: [612, 792], Legal: [612, 1008],
};

export async function imagesToPdf(files, { pageSize = 'A4', orientation = 'auto', margin = 0, fit = 'fit' } = {}) {
  const doc = await PDFDocument.create();
  for (const f of files) {
    const img = await embedImageAny(doc, f);
    if (pageSize === 'image') {
      const w = (img.width * 72) / 96, h = (img.height * 72) / 96; // 96 dpi Annahme
      const p = doc.addPage([w + 2 * margin, h + 2 * margin]);
      p.drawImage(img, { x: margin, y: margin, width: w, height: h });
      continue;
    }
    let [W, H] = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
    const landscape = orientation === 'landscape' || (orientation === 'auto' && img.width > img.height);
    if (landscape) [W, H] = [H, W];
    const p = doc.addPage([W, H]);
    const aw = W - 2 * margin, ah = H - 2 * margin;
    let s = fit === 'fill' ? Math.max(aw / img.width, ah / img.height) : Math.min(aw / img.width, ah / img.height);
    if (fit === 'original') s = Math.min(72 / 96, aw / img.width, ah / img.height);
    const w = img.width * s, h = img.height * s;
    p.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  }
  doc.setProducer('PDF Editor');
  return saveDoc(doc);
}

// ---------- Kompression & Co. ----------
export async function compress(bytes, { preset = 'ebook', dpi, quality, gray = false } = {}) {
  const args = ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-dSubsetFonts=true'];
  if (preset !== 'custom') args.push(`-dPDFSETTINGS=/${preset}`);
  if (dpi) {
    args.push('-dDownsampleColorImages=true', '-dDownsampleGrayImages=true', '-dDownsampleMonoImages=true',
      '-dColorImageDownsampleType=/Bicubic', '-dGrayImageDownsampleType=/Bicubic',
      `-dColorImageResolution=${dpi}`, `-dGrayImageResolution=${dpi}`, `-dMonoImageResolution=${Math.max(dpi * 2, 150)}`,
      '-dColorImageDownsampleThreshold=1.0', '-dGrayImageDownsampleThreshold=1.0');
  }
  if (quality) {
    // JPEG Qualität 0-100 -> QFactor
    const q = Math.max(5, Math.min(100, quality));
    const qf = (100 - q) / 50 + 0.05;
    args.push('-dAutoFilterColorImages=false', '-dAutoFilterGrayImages=false', '-dColorImageFilter=/DCTEncode', '-dGrayImageFilter=/DCTEncode',
      '-c', `<< /ColorImageDict << /QFactor ${qf.toFixed(2)} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >> /GrayImageDict << /QFactor ${qf.toFixed(2)} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >> >> setdistillerparams`, '-f');
  }
  if (gray) args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
  // Reihenfolge: Optionen, dann -sOutputFile, dann (ggf. -c ... -f) und Eingabe
  const fIdx = args.indexOf('-c');
  const head = fIdx >= 0 ? args.slice(0, fIdx) : args;
  const tail = fIdx >= 0 ? args.slice(fIdx) : [];
  const r = await gs([...head, '-sOutputFile=out.pdf', ...tail, 'in.pdf'], bytes);
  return r.data;
}

export async function grayscale(bytes) {
  return (await gs(['-sDEVICE=pdfwrite', '-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray', '-dCompatibilityLevel=1.5', '-sOutputFile=out.pdf', 'in.pdf'], bytes)).data;
}

// PDF/A braucht einen OutputIntent mit ICC-Profil (sRGB aus Ghostscript)
const PDFA_DEF = `%!
/ICCProfile (%rom%iccprofiles/srgb.icc) def
[ /_objdef {icc_PDFA} /type /stream /OBJ pdfmark
[{icc_PDFA} << /N 3 >> /PUT pdfmark
[{icc_PDFA} ICCProfile (r) file /PUT pdfmark
[ /_objdef {OutputIntent_PDFA} /type /dict /OBJ pdfmark
[{OutputIntent_PDFA} << /Type /OutputIntent /S /GTS_PDFA1 /DestOutputProfile {icc_PDFA} /OutputConditionIdentifier (sRGB IEC61966-2.1) /Info (sRGB IEC61966-2.1) >> /PUT pdfmark
[{Catalog} << /OutputIntents [ {OutputIntent_PDFA} ] >> /PUT pdfmark
`;
export async function toPdfA(bytes, level = 2) {
  return (await gs([`-dPDFA=${level}`, '-dPDFACompatibilityPolicy=1', '-sDEVICE=pdfwrite', '-sColorConversionStrategy=RGB', '-dProcessColorModel=/DeviceRGB', '-sOutputFile=out.pdf', 'PDFA_def.ps', 'in.pdf'], bytes, 'out.pdf', { 'PDFA_def.ps': new TextEncoder().encode(PDFA_DEF) })).data;
}

export async function linearize(bytes) {
  return (await qpdf(['--linearize', '--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', 'in.pdf', 'out.pdf'], bytes)).data;
}

export async function encrypt(bytes, { userPassword, ownerPassword, allowPrint = true, allowModify = false, allowCopy = false, allowAnnotate = false, allowForms = true }) {
  const owner = ownerPassword || userPassword + '#' + Math.random().toString(36).slice(2, 10);
  const args = ['--encrypt', userPassword || '', owner, '256',
    `--print=${allowPrint ? 'full' : 'none'}`, `--modify=${allowModify ? 'all' : allowAnnotate ? 'annotate' : allowForms ? 'form' : 'none'}`,
    `--extract=${allowCopy ? 'y' : 'n'}`, `--annotate=${allowAnnotate ? 'y' : 'n'}`, `--form=${allowForms ? 'y' : 'n'}`,
    '--', 'in.pdf', 'out.pdf'];
  return (await qpdf(args, bytes)).data;
}

export async function flattenAnnotations(bytes) {
  return (await qpdf(['--generate-appearances', '--flatten-annotations=all', 'in.pdf', 'out.pdf'], bytes)).data;
}

// Rendert Seiten als Bilder über Ghostscript (für OCR, leere Seiten usw.)
export async function renderWithGs(bytes, { dpi = 72, device = 'pnggray', first, last } = {}) {
  const args = [`-sDEVICE=${device}`, `-r${dpi}`, '-dUseCropBox'];
  if (first) args.push(`-dFirstPage=${first}`);
  if (last) args.push(`-dLastPage=${last}`);
  args.push('-sOutputFile=p%05d.png', 'in.pdf');
  const r = await gs(args, bytes, null);
  return Object.keys(r.files).filter((n) => /^p\d+\.png$/.test(n)).sort().map((n) => r.files[n]);
}
