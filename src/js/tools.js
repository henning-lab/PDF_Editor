// Alle Werkzeuge
import { h, ic, busy, idle, toast, modal, makeFile, getPdfDoc, pickFiles, preparePdf, renderOptions, ACCEPT, askPassword } from './ui.js';
import { icon } from './icons.js';
import {
  PDFDocument, rgb, degrees, StandardFonts, native, UserError, baseName, ext, formatBytes, hexToRgb, parseRanges,
  loadDoc, saveDoc, merge, pickPages, imagesToPdf, compress, grayscale, toPdfA, linearize, encrypt, decrypt, isEncrypted,
  isWrongPassword, flattenAnnotations, repair, stampPages, displayBox, drawUpright, getFont, embedImageAny, PAGE_SIZES,
} from './core.js';
import { openPdf, renderPage, canvasToBytes, pageTextItems, groupLines, pageImages, imageObjectToCanvas, pageHasText } from './pdf.js';
import { mountOrganizer } from './organizer.js';
import { mountEditor } from './editor.js';
import { mountCompare } from './compare.js';
import { mountCertsPage, mountVerify } from './certs.js';
import { djvuToPdf } from './djvu.js';

const C = {
  blue: '#2563eb', indigo: '#4f46e5', violet: '#7c3aed', pink: '#db2777', red: '#dc2626', orange: '#ea580c',
  amber: '#d97706', green: '#16a34a', teal: '#0d9488', cyan: '#0891b2', slate: '#475569', sky: '#0284c7',
};

export const CATEGORIES = [
  { id: 'organize', name: 'Organisieren' },
  { id: 'convert', name: 'In PDF umwandeln' },
  { id: 'convertFrom', name: 'Aus PDF umwandeln' },
  { id: 'edit', keepFilesAfter: true, name: 'Bearbeiten' },
  { id: 'optimize', name: 'Optimieren' },
  { id: 'security', name: 'Sicherheit' },
];

export const FEATURED = ['merge', 'split', 'compress', 'edit', 'sign', 'digisign', 'verify', 'converter', 'img2pdf', 'pdf2img', 'extractimages', 'encrypt', 'unlock',
  'rotate', 'deletepages', 'extractpages', 'sortpages', 'web2pdf', 'ocr', 'watermark', 'pagenumbers', 'overlay', 'compare', 'optimize', 'redact', 'create'];

// ---------- Hilfen ----------
const out = (name, data) => ({ name, data: data instanceof Uint8Array ? data : new Uint8Array(data) });
const pdfName = (file, suffix) => `${baseName(file.name)}${suffix ? '-' + suffix : ''}.pdf`;
const pct = (a, b) => (a > 0 ? Math.round((1 - b / a) * 100) : 0);

async function fileToPdfBytes(f) {
  const e = ext(f.name);
  if (e === 'pdf') return f.data;
  if (ACCEPT.image.includes(e)) return imagesToPdf([f], { pageSize: 'image' });
  if (ACCEPT.djvu.includes(e)) return (await djvuToPdf(f, {}, (t, v) => busy(t, v))).data;
  const r = await native.documentToPdf({ name: f.name, data: f.data });
  return r.data;
}

function pageRangeIndices(value, total) {
  if (!value || !String(value).trim()) return [...Array(total).keys()];
  return [...new Set(parseRanges(value, total))].sort((a, b) => a - b);
}

function fontOptions(prefix = '') {
  return [
    { id: prefix + 'font', label: 'Schrift', type: 'select', default: 'Helvetica', choices: [{ value: 'Helvetica', label: 'Helvetica' }, { value: 'Times', label: 'Times' }, { value: 'Courier', label: 'Courier' }] },
    { id: prefix + 'bold', label: 'Fett', type: 'checkbox', default: false },
  ];
}

function posXY(pos, W, H, w, h, margin) {
  const col = pos[1], row = pos[0];
  const x = col === 'l' ? margin : col === 'r' ? W - margin - w : (W - w) / 2;
  const y = row === 't' ? H - margin - h : row === 'b' ? margin : (H - h) / 2; // PDF-Koordinaten (unten)
  return { x, y };
}

async function convertDocsRun({ files }) {
  const results = [];
  const engines = new Set();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    busy(`„${f.name}“ wird umgewandelt (${i + 1}/${files.length}) …`);
    const e = ext(f.name);
    if (ACCEPT.image.includes(e)) { results.push(out(pdfName(f), await imagesToPdf([f], { pageSize: 'A4', margin: 20 }))); continue; }
    if (e === 'pdf') { results.push(out(f.name, f.data)); continue; }
    if (ACCEPT.djvu.includes(e)) { results.push(out(pdfName(f), (await djvuToPdf(f, {}, (t, v) => busy(t, v))).data)); engines.add('DjVu'); continue; }
    const r = await native.documentToPdf({ name: f.name, data: f.data });
    engines.add(r.engine);
    results.push(out(pdfName(f), r.data));
  }
  return { files: results, message: engines.size ? `Umgewandelt mit: ${[...engines].join(', ')}` : undefined, zipName: 'Umgewandelt' };
}

function officeInfo() {
  return h('div', {}, 'Die Umwandlung läuft vollständig in deinem Browser, deine Dateien werden nicht hochgeladen. Unterstützt: DOCX, XLSX, XLS, ODS, CSV, PPTX, HTML, Markdown, Text und EPUB. Ältere Formate (.doc, .ppt, .odt) bitte vorher als DOCX bzw. PPTX speichern.');
  return box;
}

// ---------- PDF -> strukturierter Text (für Word/HTML/Excel) ----------
async function pdfStructure(file, progress) {
  const doc = await openPdf(file.data);
  const pages = [];
  for (let i = 0; i < doc.numPages; i++) {
    progress && progress(`Seite ${i + 1} von ${doc.numPages} wird analysiert …`, i / doc.numPages);
    const { items, width, height } = await pageTextItems(doc, i);
    const lines = groupLines(items);
    pages.push({ width, height, lines, items });
  }
  return { doc, pages };
}

function linesToParagraphs(allLines, pageWidth) {
  // Aufeinanderfolgende Zeilen mit mehreren Spalten werden zu Tabellen
  const lines = [];
  for (let k = 0; k < allLines.length; k++) {
    const l = allLines[k];
    if (l.cells && l.cells.length >= 2) {
      const group = [l];
      while (k + 1 < allLines.length && allLines[k + 1].cells && allLines[k + 1].cells.length >= 2 && allLines[k + 1].top - group[group.length - 1].baseline < l.size * 2.2) group.push(allLines[++k]);
      if (group.length >= 2) {
        const xs = [];
        for (const g of group) for (const c of g.cells) xs.push(c.x);
        xs.sort((a, b) => a - b);
        const cols = [];
        for (const x of xs) if (!cols.length || x - cols[cols.length - 1] > 12) cols.push(x);
        const rows = group.map((g) => {
          const row = cols.map(() => '');
          for (const c of g.cells) { let best = 0; cols.forEach((cx, ci) => { if (Math.abs(cx - c.x) < Math.abs(cols[best] - c.x)) best = ci; }); row[best] = row[best] ? row[best] + ' ' + c.text : c.text; }
          return row;
        });
        lines.push({ ...group[0], table: rows, text: rows.map((r) => r.join('\t')).join('\n'), baseline: group[group.length - 1].baseline });
        continue;
      }
    }
    lines.push(l);
  }
  const paras = [];
  let cur = null;
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 11;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (!l.text.trim()) continue;
    const prev = lines[k - 1];
    if (l.table) { paras.push({ table: l.table, text: l.text, size: l.size, top: l.top, x: l.x }); cur = null; continue; }
    const gap = prev ? l.top - prev.baseline : 0;
    const center = Math.abs((l.x + l.right) / 2 - pageWidth / 2) < pageWidth * 0.04 && l.x > pageWidth * 0.18;
    const newPara = !cur || (prev && prev.table) || gap > l.size * 0.9 || Math.abs(l.size - cur.size) > 1.2 || l.bold !== cur.bold || center !== cur.center || Math.abs(l.x - cur.x) > l.size * 1.5 || /^([•\-–▪●◦*]|\d+[.)])\s/.test(l.text);
    if (newPara) {
      cur = { text: l.text, size: l.size, bold: l.bold, x: l.x, center, top: l.top, spaceBefore: prev ? Math.max(0, Math.min(18, gap - l.size * 0.3)) : 0 };
      paras.push(cur);
    } else if (/[a-zäöüß]-$/.test(cur.text) && /^[a-zäöüß]/.test(l.text)) {
      cur.text = cur.text.slice(0, -1) + l.text; // Silbentrennung am Zeilenende aufheben
    } else {
      cur.text += (cur.text.endsWith('-') ? '' : ' ') + l.text;
    }
  }
  return paras.map((p) => ({ ...p, heading: p.size > body * 1.25 }));
}

// ---------- Werkzeuge ----------
export const TOOLS = [
  // ===== Organisieren =====
  {
    id: 'merge', name: 'PDF zusammenfügen', desc: 'Mehrere PDFs und Bilder zu einer PDF kombinieren', icon: 'combine', color: C.red, cat: 'organize',
    accept: ['pdf', 'image', 'djvu'], multiple: true, sortable: true, min: 2, minMessage: 'Bitte mindestens 2 Dateien hinzufügen.', action: 'Zusammenfügen', keywords: 'kombinieren verbinden merge',
    acceptLabel: 'PDFs und Bilder, die Reihenfolge kannst du danach festlegen',
    async run({ files, progress }) {
      const list = [];
      for (let i = 0; i < files.length; i++) { progress(`Datei ${i + 1} von ${files.length} …`, i / files.length); list.push(await fileToPdfBytes(files[i])); }
      progress('Wird zusammengefügt …');
      const data = await merge(list);
      return { files: [out(`${baseName(files[0].name)}-zusammengefuegt.pdf`, data)], message: `${files.length} Dateien wurden zu einer PDF zusammengefügt.` };
    },
  },
  {
    id: 'split', name: 'PDF trennen', desc: 'Seiten einer PDF in mehrere einzelne PDFs aufteilen', icon: 'scissors', color: C.orange, cat: 'organize',
    multiple: false, action: 'Trennen', keywords: 'aufteilen splitten teilen',
    options: [
      { id: 'mode', label: 'Aufteilen', type: 'seg', vertical: true, default: 'each', choices: [
        { value: 'each', label: 'Jede Seite einzeln', help: 'Jede Seite wird eine eigene PDF' },
        { value: 'every', label: 'Alle N Seiten', help: 'Feste Anzahl Seiten pro Datei' },
        { value: 'ranges', label: 'Nach Seitenbereichen', help: 'z. B. 1-3, 4-8, 9-' },
        { value: 'size', label: 'Nach Dateigröße', help: 'Teile mit maximaler Größe' }] },
      { id: 'n', label: 'Seiten pro Datei', type: 'number', default: 2, min: 1, showIf: (v) => v.mode === 'every' },
      { id: 'ranges', label: 'Bereiche (jeder Bereich = eine Datei)', type: 'text', placeholder: '1-3, 4-6, 7-', default: '', showIf: (v) => v.mode === 'ranges' },
      { id: 'maxMb', label: 'Maximale Größe pro Teil (MB)', type: 'number', default: 5, min: 0.1, step: 0.5, showIf: (v) => v.mode === 'size' },
    ],
    async run({ files, opts, progress }) {
      const f = files[0];
      const src = await loadDoc(f.data);
      const total = src.getPageCount();
      let groups = [];
      if (opts.mode === 'each') groups = [...Array(total).keys()].map((i) => [i]);
      else if (opts.mode === 'every') { const n = Math.max(1, Math.floor(opts.n || 1)); for (let i = 0; i < total; i += n) groups.push([...Array(Math.min(n, total - i)).keys()].map((k) => i + k)); }
      else if (opts.mode === 'ranges') {
        if (!String(opts.ranges || '').trim()) throw new UserError('Bitte Seitenbereiche angeben, z. B. 1-3, 4-6');
        groups = String(opts.ranges).split(/[,;]+/).filter((s) => s.trim()).map((r) => parseRanges(r, total));
      } else if (opts.mode === 'size') {
        const max = (opts.maxMb || 5) * 1024 * 1024;
        let cur = [];
        for (let i = 0; i < total; i++) {
          progress(`Seite ${i + 1} von ${total} …`, i / total);
          const test = await pickPages(f.data, [...cur, i]);
          if (test.length > max && cur.length) { groups.push(cur); cur = [i]; } else cur.push(i);
        }
        if (cur.length) groups.push(cur);
      }
      const res = [];
      const pad = String(groups.length).length;
      for (let g = 0; g < groups.length; g++) {
        progress(`Teil ${g + 1} von ${groups.length} …`, g / groups.length);
        const idx = groups[g];
        const label = opts.mode === 'each' ? `Seite-${String(idx[0] + 1).padStart(pad, '0')}` : `Teil-${String(g + 1).padStart(pad, '0')}`;
        res.push(out(pdfName(f, label), await pickPages(f.data, idx)));
      }
      return { files: res, message: `Die PDF wurde in ${res.length} Dateien aufgeteilt.`, zipName: `${baseName(f.name)}-getrennt` };
    },
  },
  {
    id: 'rotate', keepFilesAfter: true, name: 'PDF Seiten drehen', desc: 'Einzelne oder alle Seiten einer PDF drehen', icon: 'rotate-cw', color: C.amber, cat: 'organize',
    multiple: false, keywords: 'drehen rotieren', custom: (root, api) => mountOrganizer(root, api, 'rotate'),
  },
  {
    id: 'deletepages', keepFilesAfter: true, name: 'PDF Seiten löschen', desc: 'Seiten aus einer PDF entfernen', icon: 'trash-2', color: C.red, cat: 'organize',
    multiple: false, keywords: 'entfernen löschen seiten', custom: (root, api) => mountOrganizer(root, api, 'delete'),
  },
  {
    id: 'extractpages', keepFilesAfter: true, name: 'PDF Seiten extrahieren', desc: 'Ausgewählte Seiten als neue PDF speichern', icon: 'file-output', color: C.teal, cat: 'organize',
    multiple: false, keywords: 'auswählen herauslösen', custom: (root, api) => mountOrganizer(root, api, 'extract'),
  },
  {
    id: 'sortpages', keepFilesAfter: true, name: 'PDF Seiten sortieren', desc: 'Seiten per Drag & Drop neu anordnen, leere Seiten einfügen', icon: 'arrow-down-up', color: C.violet, cat: 'organize',
    multiple: false, keywords: 'reihenfolge anordnen umkehren', custom: (root, api) => mountOrganizer(root, api, 'sort'),
  },
  {
    id: 'nup', name: 'Mehrere Seiten pro Blatt', desc: '2, 4, 6, 9 oder 16 Seiten auf ein Blatt bringen', icon: 'layout-grid', color: C.indigo, cat: 'organize',
    multiple: false, action: 'Erstellen', keywords: 'n-up nup drucken handout',
    options: [
      { id: 'n', label: 'Seiten pro Blatt', type: 'seg', default: 4, choices: [2, 4, 6, 9, 16].map((n) => ({ value: n, label: String(n) })) },
      { id: 'size', label: 'Blattgröße', type: 'select', default: 'A4', choices: Object.keys(PAGE_SIZES).map((k) => ({ value: k, label: k })) },
      { id: 'border', label: 'Rahmen um jede Seite', type: 'checkbox', default: false },
      { id: 'margin', label: 'Abstand (pt)', type: 'number', default: 12, min: 0 },
    ],
    async run({ files, opts }) {
      const f = files[0];
      const src = await loadDoc(f.data);
      const outDoc = await PDFDocument.create();
      const n = +opts.n;
      const grid = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 16: [4, 4] }[n];
      let [W, H] = PAGE_SIZES[opts.size] || PAGE_SIZES.A4;
      // Bei 2 und 6 im Querformat
      if (n === 2 || n === 6) [W, H] = [H, W];
      const [cols, rows] = n === 2 || n === 6 ? grid : [grid[0], grid[1]];
      const m = Math.max(0, +opts.margin || 0);
      const cellW = (W - m * (cols + 1)) / cols, cellH = (H - m * (rows + 1)) / rows;
      const total = src.getPageCount();
      const embedded = await outDoc.embedPdf(f.data, [...Array(total).keys()]);
      for (let i = 0; i < total; i += n) {
        const p = outDoc.addPage([W, H]);
        for (let k = 0; k < n && i + k < total; k++) {
          const e = embedded[i + k];
          const srcPage = src.getPage(i + k);
          const rot = ((srcPage.getRotation().angle % 360) + 360) % 360;
          const ew = rot % 180 ? e.height : e.width, eh = rot % 180 ? e.width : e.height;
          const s = Math.min(cellW / ew, cellH / eh);
          const c = k % cols, r = Math.floor(k / cols);
          const cx = m + c * (cellW + m), cy = H - m - (r + 1) * cellH - r * m;
          const w = ew * s, hh = eh * s;
          const x = cx + (cellW - w) / 2, y = cy + (cellH - hh) / 2;
          if (rot === 0) p.drawPage(e, { x, y, width: e.width * s, height: e.height * s });
          else if (rot === 90) p.drawPage(e, { x: x + w, y, width: e.width * s, height: e.height * s, rotate: degrees(90) });
          else if (rot === 180) p.drawPage(e, { x: x + w, y: y + hh, width: e.width * s, height: e.height * s, rotate: degrees(180) });
          else p.drawPage(e, { x, y: y + hh, width: e.width * s, height: e.height * s, rotate: degrees(270) });
          if (opts.border) p.drawRectangle({ x, y, width: w, height: hh, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
        }
      }
      return [out(pdfName(f, `${n}-pro-Blatt`), await saveDoc(outDoc))];
    },
  },

  // ===== Konvertieren =====
  {
    id: 'converter', name: 'PDF Converter', desc: 'Dateien in PDF umwandeln und PDFs in andere Formate', icon: 'arrow-left-right', color: C.blue, cat: 'convert',
    noInput: true, keywords: 'umwandeln konvertieren',
    custom(root) {
      const main = h('div', { class: 'tool-main' });
      const wrap = h('div', { class: 'home', style: { padding: '8px 0' } });
      const section = (title, ids) => {
        wrap.append(h('div', { class: 'section-title' }, title));
        wrap.append(h('div', { class: 'tool-grid' }, ids.map((id) => TOOLS.find((t) => t.id === id)).map((t) => h('button', { class: 'tool-card', onclick: () => window.__go(t.id) },
          h('span', { class: 'tool-icon', style: { '--c': t.color }, html: icon(t.icon, 22) }), h('span', { class: 'name' }, t.name), h('span', { class: 'desc' }, t.desc)))));
      };
      section('In PDF umwandeln', ['create', 'word2pdf', 'excel2pdf', 'ppt2pdf', 'img2pdf', 'djvu2pdf', 'html2pdf', 'txt2pdf', 'epub2pdf', 'web2pdf']);
      section('Aus PDF umwandeln', ['pdf2word', 'pdf2excel', 'pdf2ppt', 'pdf2img', 'pdf2txt', 'pdf2html', 'pdfa', 'extractimages']);
      main.append(wrap);
      root.append(main);
    },
  },
  {
    id: 'create', name: 'PDF erstellen', desc: 'PDF aus Word, Excel, PowerPoint, Bildern, Text und mehr erstellen', icon: 'file-plus', color: C.green, cat: 'convert',
    accept: 'any', multiple: true, sortable: true, action: 'PDF erstellen', keywords: 'erstellen erzeugen dokument',
    acceptLabel: 'Word, Excel, PowerPoint, Bilder, DjVu, Text, HTML, EPUB oder PDF',
    info: () => officeInfo(),
    options: (files) => [
      { id: 'combine', label: 'Ausgabe', type: 'seg', default: 'one', choices: [{ value: 'one', label: 'Eine PDF' }, { value: 'each', label: 'Je Datei eine PDF' }], showIf: () => files.length > 1 },
    ],
    async run({ files, opts }) {
      const r = await convertDocsRun({ files });
      if (files.length > 1 && (opts.combine || 'one') === 'one') {
        busy('Wird zusammengefügt …');
        return { files: [out(`${baseName(files[0].name)}.pdf`, await merge(r.files.map((x) => x.data)))], message: r.message };
      }
      return r;
    },
  },
  ...[
    ['word2pdf', 'Word in PDF', 'Word-Dokumente (DOCX) in PDF umwandeln', 'file-text', C.blue, 'word', 'word docx doc'],
    ['excel2pdf', 'Excel in PDF', 'XLSX, XLS, ODS und CSV in PDF umwandeln', 'sheet', C.green, 'excel', 'excel xlsx tabelle'],
    ['ppt2pdf', 'PowerPoint in PDF', 'PowerPoint-Präsentationen (PPTX) in PDF umwandeln', 'presentation', C.orange, 'ppt', 'powerpoint präsentation folien'],
    ['html2pdf', 'HTML in PDF', 'HTML-Dateien in PDF umwandeln', 'code', C.slate, 'html', 'html webseite datei'],
    ['txt2pdf', 'Text in PDF', 'Textdateien in PDF umwandeln', 'type', C.slate, 'text', 'txt text'],
    ['epub2pdf', 'EPUB in PDF', 'E-Books (EPUB) in PDF umwandeln', 'book-open', C.violet, 'epub', 'ebook epub'],
  ].map(([id, name, desc, ic_, color, accept, keywords]) => ({
    id, name, desc, icon: ic_, color, cat: 'convert', accept, multiple: true, action: 'In PDF umwandeln', keywords,
    info: ['word', 'excel', 'ppt'].includes(accept) ? () => officeInfo() : undefined,
    run: convertDocsRun,
  })),
  {
    id: 'img2pdf', name: 'Bilder in PDF', desc: 'PDFs aus JPG, PNG, HEIC und anderen Bildern erstellen', icon: 'image-plus', color: C.pink, cat: 'convert',
    accept: 'image', multiple: true, sortable: true, action: 'PDF erstellen', keywords: 'jpg png heic foto bild',
    acceptLabel: 'JPG, PNG, HEIC, WEBP, GIF, TIFF, BMP',
    options: [
      { id: 'pageSize', label: 'Seitengröße', type: 'select', default: 'A4', choices: [{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'US Letter' }, { value: 'A3', label: 'A3' }, { value: 'A5', label: 'A5' }, { value: 'image', label: 'Wie Bild' }] },
      { id: 'orientation', label: 'Ausrichtung', type: 'seg', default: 'auto', choices: [{ value: 'auto', label: 'Automatisch' }, { value: 'portrait', label: 'Hoch' }, { value: 'landscape', label: 'Quer' }], showIf: (v) => v.pageSize !== 'image' },
      { id: 'margin', label: 'Rand', type: 'seg', default: 0, choices: [{ value: 0, label: 'Kein' }, { value: 18, label: 'Klein' }, { value: 40, label: 'Groß' }] },
      { id: 'fit', label: 'Bildgröße', type: 'seg', default: 'fit', choices: [{ value: 'fit', label: 'Einpassen' }, { value: 'fill', label: 'Füllen' }, { value: 'original', label: 'Original' }], showIf: (v) => v.pageSize !== 'image' },
      { id: 'each', label: 'Jedes Bild als eigene PDF', type: 'checkbox', default: false },
    ],
    async run({ files, opts, progress }) {
      const o = { pageSize: opts.pageSize, orientation: opts.orientation, margin: +opts.margin, fit: opts.fit };
      if (opts.each) {
        const res = [];
        for (let i = 0; i < files.length; i++) { progress(`Bild ${i + 1} von ${files.length} …`, i / files.length); res.push(out(pdfName(files[i]), await imagesToPdf([files[i]], o))); }
        return { files: res, zipName: 'Bilder-PDF' };
      }
      progress('PDF wird erstellt …');
      return [out(files.length === 1 ? pdfName(files[0]) : `${baseName(files[0].name)}-Bilder.pdf`, await imagesToPdf(files, o))];
    },
  },
  {
    id: 'djvu2pdf', name: 'DjVu in PDF', desc: 'DjVu-Dokumente und -Bücher in gut lesbare PDFs umwandeln', icon: 'book-open', color: C.teal, cat: 'convert',
    accept: 'djvu', multiple: true, action: 'In PDF umwandeln', keywords: 'djvu djv buch scan ebook',
    acceptLabel: 'DjVu-Dateien (.djvu, .djv), auch mehrteilige Dokumente (index.djvu)',
    options: [
      { id: 'quality', label: 'Qualität', type: 'seg', vertical: true, default: 'high', choices: [
        { value: 'high', label: 'Originalqualität', help: 'Volle Auflösung, Text-Scans verlustfrei und gestochen scharf' },
        { value: 'small', label: 'Kleinere Datei', help: 'Farbige und graue Seiten stärker komprimiert' }] },
      { id: 'textLayer', label: 'Textebene übernehmen (durchsuchbar und kopierbar)', type: 'checkbox', default: true },
      { id: 'outline', label: 'Inhaltsverzeichnis als Lesezeichen übernehmen', type: 'checkbox', default: true },
      { id: 'ocr', label: 'Seiten ohne Text per OCR durchsuchbar machen (langsamer)', type: 'checkbox', default: false },
      { id: 'langs', label: 'OCR-Sprache', type: 'select', default: 'deu+eng', choices: [{ value: 'deu+eng', label: 'Deutsch + Englisch' }, { value: 'deu', label: 'Deutsch' }, { value: 'eng', label: 'Englisch' }, { value: 'fra', label: 'Französisch' }, { value: 'spa', label: 'Spanisch' }, { value: 'ita', label: 'Italienisch' }], showIf: (v) => v.ocr },
      { id: 'combine', label: 'Alle Dateien zu einer PDF zusammenfügen', type: 'checkbox', default: false },
    ],
    async run({ files, opts, progress }) {
      const res = [];
      const notes = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const r = await djvuToPdf(f, opts, (t, v) => progress(files.length > 1 ? `${f.name}: ${t}` : t, v));
        res.push(out(pdfName(f), r.data));
        notes.push(`${r.pages} ${r.pages === 1 ? 'Seite' : 'Seiten'}${r.withText ? `, ${r.withText} mit Textebene` : ''}${r.ocrPages ? `, ${r.ocrPages} per OCR erkannt` : ''}${r.bookmarks && opts.outline !== false ? ', Inhaltsverzeichnis übernommen' : ''}`);
      }
      if (opts.combine && res.length > 1) {
        progress('Wird zusammengefügt …');
        return { files: [out(`${baseName(files[0].name)}-zusammengefuegt.pdf`, await merge(res.map((r) => r.data)))], message: notes.join(' · ') };
      }
      return { files: res, message: notes.join(' · '), zipName: 'DjVu-PDF' };
    },
  },
  {
    id: 'web2pdf', name: 'Webseite in PDF', desc: 'Eine Webseite per URL in eine PDF umwandeln', icon: 'globe', color: C.sky, cat: 'convert',
    noInput: true, keywords: 'url internet website link',
    custom(root, api) {
      const main = h('div', { class: 'tool-main' });
      const v = api.values;
      const box = h('div', { style: { maxWidth: '620px', margin: '20px auto' } });
      const url = h('input', { class: 'input', placeholder: 'https://www.beispiel.de', style: { height: '44px', fontSize: '15px' } });
      url.value = v.url || '';
      url.addEventListener('input', () => { v.url = url.value; });
      const optsBox = h('div', { style: { marginTop: '18px' } });
      renderOptions(optsBox, [
        { id: 'pageSize', label: 'Seitengröße', type: 'seg', default: 'A4', choices: [{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'Letter' }, { value: 'A3', label: 'A3' }] },
        { id: 'landscape', label: 'Querformat', type: 'checkbox', default: false },
        { id: 'viewport', label: 'Darstellung', type: 'seg', default: 1280, choices: [{ value: 1280, label: 'Desktop' }, { value: 820, label: 'Tablet' }, { value: 400, label: 'Smartphone' }] },
        { id: 'noMargins', label: 'Ohne Seitenränder', type: 'checkbox', default: false },
      ], v);
      const help = h('div', { class: 'info-box hidden', style: { marginTop: '16px', textAlign: 'left' } });
      const showHelp = (reason) => {
        help.innerHTML = '';
        help.append(h('strong', {}, reason), h('p', { style: { margin: '8px 0 6px' } }, 'Aus Sicherheitsgründen darf eine Webseite im Browser keine fremden Seiten abrufen. So klappt es trotzdem in wenigen Sekunden:'),
          h('ol', { style: { margin: '0 0 8px', paddingLeft: '20px', lineHeight: '1.6' } },
            h('li', {}, 'Die Webseite in einem neuen Tab öffnen.'),
            h('li', {}, 'Drucken wählen (Mac: ⌘ + P, Windows: Strg + P).'),
            h('li', {}, 'Als Ziel „Als PDF sichern“ bzw. „Als PDF speichern“ auswählen.')),
          h('div', { class: 'size-row' },
            h('button', { class: 'btn small', onclick: () => { const t = (url.value || '').trim(); if (t) native.openExternal(/^https?:/.test(t) ? t : 'https://' + t); } }, ic('external-link', 15), 'Webseite öffnen'),
            h('button', { class: 'btn small', onclick: () => api.go('html2pdf') }, ic('code', 15), 'Gespeicherte HTML-Datei umwandeln')));
        help.classList.remove('hidden');
      };
      const go = async () => {
        const u = (url.value || '').trim();
        if (!u) { toast('Bitte eine Webadresse eingeben.', 'error'); return; }
        const full = /^https?:\/\//i.test(u) ? u : 'https://' + u;
        let html = null;
        busy('Webseite wird geladen …');
        try {
          const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 15000);
          const res = await fetch(full, { mode: 'cors', credentials: 'omit', signal: ac.signal }); clearTimeout(tm);
          if (res.ok && /html/.test(res.headers.get('content-type') || 'text/html')) html = await res.text();
        } catch (_) { html = null; } finally { idle(); }
        if (!html) { showHelp('Diese Webseite erlaubt keinen direkten Abruf.'); return; }
        help.classList.add('hidden');
        await api.run(async () => {
          busy('Webseite wird umgewandelt …');
          const page = html.replace(/<head([^>]*)>/i, `<head$1><base href="${full.replace(/"/g, '')}">`);
          const data = await native.htmlToPdf(page, { pageSize: v.pageSize, landscape: v.landscape, margin: v.noMargins ? 0 : 28, viewportWidth: +v.viewport });
          let host = 'Webseite';
          try { host = new URL(full).hostname.replace(/^www\./, ''); } catch (_) {}
          return [out(`${host}.pdf`, data)];
        });
      };
      url.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      box.append(h('div', { class: 'field' }, h('div', { class: 'label' }, 'Webadresse (URL)'), url), optsBox,
        h('button', { class: 'btn primary big', onclick: go }, ic('globe', 18), 'In PDF umwandeln'),
        help, h('p', { class: 'hint', style: { marginTop: '12px' } }, 'Funktioniert direkt nur bei Webseiten, die einen Abruf erlauben. Sonst zeigt PDF Editor dir den schnellen Weg über die Druckfunktion des Browsers.'));
      main.append(box);
      root.append(main);
      setTimeout(() => url.focus(), 50);
    },
  },
  {
    id: 'pdf2word', name: 'PDF in Word', desc: 'PDF in ein bearbeitbares Word-Dokument (DOCX) umwandeln', icon: 'file-text', color: C.blue, cat: 'convertFrom',
    multiple: true, action: 'In Word umwandeln', keywords: 'docx word bearbeitbar',
    options: [
      { id: 'mode', label: 'Umwandlung', type: 'seg', vertical: true, default: 'textimg', choices: [
        { value: 'textimg', label: 'Text und Bilder', help: 'Bearbeitbarer Text, Bilder an ihrer Stelle im Dokument' },
        { value: 'text', label: 'Nur Text', help: 'Text mit Absätzen und Überschriften' },
        { value: 'image', label: 'Originalgetreu (Seitenbilder)', help: 'Jede Seite als Bild, Layout bleibt exakt' }] },
    ],
    info: 'Seiten ohne Text (z. B. Scans) werden als Bild übernommen. Für bearbeitbaren Text aus Scans vorher „Text per OCR erkennen“ nutzen.',
    async run({ files, opts, progress }) {
      const res = [];
      for (const f of files) {
        const { doc, pages } = await pdfStructure(f, progress);
        const model = { pages: [] };
        for (let i = 0; i < pages.length; i++) {
          progress(`Seite ${i + 1} von ${pages.length} wird übertragen …`, i / pages.length);
          const p = pages[i];
          const blocks = [];
          const hasText = p.lines.some((l) => l.text.trim());
          if (opts.mode === 'image' || !hasText) {
            const { canvas } = await renderPage(doc, i, 2);
            blocks.push({ type: 'image', data: await canvasToBytes(canvas, 'image/jpeg', 0.9), imgType: 'jpg', width: p.width, height: p.height });
          } else {
            const items = linesToParagraphs(p.lines, p.width).map((para) => ({ top: para.top, block: para.table
              ? { type: 'table', rows: para.table, size: Math.round(Math.min(20, Math.max(6, para.size)) * 2) / 2 }
              : { type: 'para', align: para.center ? 'center' : 'left', spaceBefore: para.spaceBefore, spaceAfter: 4, runs: [{ text: para.text, size: Math.round(Math.min(40, Math.max(6, para.size)) * 2) / 2, bold: para.bold || para.heading }] } }));
            if (opts.mode === 'textimg') {
              const imgs = (await pageImages(doc, i)).filter((im) => im.rect.w >= 18 && im.rect.h >= 18);
              if (imgs.length) {
                // Bildbereich aus der gerenderten Seite ausschneiden: zeigt genau, was im PDF sichtbar ist
                const scale = 2;
                const { canvas } = await renderPage(doc, i, scale, { annotationMode: 0 });
                for (const im of imgs) {
                  const r = im.rect;
                  const x = Math.max(0, r.x), y = Math.max(0, r.y), w = Math.min(p.width, r.x + r.w) - x, hh = Math.min(p.height, r.y + r.h) - y;
                  if (w < 18 || hh < 18) continue;
                  const c = document.createElement('canvas');
                  c.width = Math.round(w * scale); c.height = Math.round(hh * scale);
                  c.getContext('2d').drawImage(canvas, x * scale, y * scale, w * scale, hh * scale, 0, 0, c.width, c.height);
                  const photo = im.img && im.img.kind !== 1 && (im.img.width * im.img.height > 90000);
                  items.push({ top: y, block: { type: 'image', data: await canvasToBytes(c, photo ? 'image/jpeg' : 'image/png', 0.9), imgType: photo ? 'jpg' : 'png', width: w, height: hh } });
                }
              }
            }
            items.sort((a, b) => a.top - b.top);
            for (const it of items) blocks.push(it.block);
          }
          model.pages.push({ width: p.width, height: p.height, blocks });
        }
        progress('Word-Datei wird geschrieben …');
        res.push(out(`${baseName(f.name)}.docx`, await native.buildDocx(model)));
      }
      return { files: res, zipName: 'Word' };
    },
  },
  {
    id: 'pdf2excel', name: 'PDF in Excel', desc: 'Tabellen und Text aus PDFs in Excel (XLSX) übernehmen', icon: 'sheet', color: C.green, cat: 'convertFrom',
    multiple: true, action: 'In Excel umwandeln', keywords: 'xlsx tabelle excel',
    options: [{ id: 'sheets', label: 'Tabellenblätter', type: 'seg', default: 'page', choices: [{ value: 'page', label: 'Je Seite ein Blatt' }, { value: 'one', label: 'Alles auf ein Blatt' }] }],
    async run({ files, opts, progress }) {
      const res = [];
      for (const f of files) {
        const { pages } = await pdfStructure(f, progress);
        const sheets = [];
        const all = [];
        pages.forEach((p, i) => {
          // Spaltengrenzen aus allen Zeilen ermitteln
          const rows = [];
          for (const l of p.lines) {
            const cells = [];
            let cur = null;
            for (const it of l.items) {
              if (!it.str.trim() && !cur) continue;
              if (cur && it.x - cur.end < Math.max(it.height * 0.9, 6)) { cur.text += (it.x - cur.end > it.height * 0.18 ? ' ' : '') + it.str; cur.end = it.x + it.width; }
              else { cur = { x: it.x, end: it.x + it.width, text: it.str }; cells.push(cur); }
            }
            rows.push(cells.filter((c) => c.text.trim()));
          }
          const xs = [];
          for (const r of rows) for (const c of r) xs.push(c.x);
          xs.sort((a, b) => a - b);
          const cols = [];
          for (const x of xs) if (!cols.length || x - cols[cols.length - 1] > 14) cols.push(x);
          const colOf = (x) => { let best = 0; for (let k = 0; k < cols.length; k++) if (Math.abs(cols[k] - x) < Math.abs(cols[best] - x)) best = k; return best; };
          const grid = rows.filter((r) => r.length).map((r) => {
            const line = [];
            for (const c of r) {
              let k = colOf(c.x);
              while (line[k] !== undefined) k++;
              const t = c.text.trim();
              const num = /^-?[\d.]+(,\d+)?$/.test(t) ? Number(t.replace(/\./g, '').replace(',', '.')) : NaN;
              line[k] = Number.isFinite(num) && t.length < 16 ? num : t;
            }
            for (let k = 0; k < line.length; k++) if (line[k] === undefined) line[k] = '';
            return line;
          });
          if (opts.sheets === 'one') { if (all.length) all.push([]); all.push(...grid); }
          else sheets.push({ name: `Seite ${i + 1}`, rows: grid });
        });
        if (opts.sheets === 'one') sheets.push({ name: baseName(f.name).slice(0, 31) || 'PDF', rows: all });
        res.push(out(`${baseName(f.name)}.xlsx`, await native.buildXlsx({ sheets })));
      }
      return { files: res, zipName: 'Excel' };
    },
  },
  {
    id: 'pdf2ppt', name: 'PDF in PowerPoint', desc: 'Jede PDF-Seite wird eine Folie (PPTX)', icon: 'presentation', color: C.orange, cat: 'convertFrom',
    multiple: true, action: 'In PowerPoint umwandeln', keywords: 'pptx folien präsentation',
    options: [{ id: 'dpi', label: 'Qualität', type: 'seg', default: 150, choices: [{ value: 110, label: 'Normal' }, { value: 150, label: 'Hoch' }, { value: 220, label: 'Sehr hoch' }] }],
    async run({ files, opts, progress }) {
      const res = [];
      for (const f of files) {
        const doc = await openPdf(f.data);
        const slides = [];
        for (let i = 0; i < doc.numPages; i++) {
          progress(`Folie ${i + 1} von ${doc.numPages} …`, i / doc.numPages);
          const { canvas, viewport } = await renderPage(doc, i, (+opts.dpi || 150) / 72);
          slides.push({ image: await canvasToBytes(canvas, 'image/jpeg', 0.9), width: viewport.width / ((+opts.dpi || 150) / 72), height: viewport.height / ((+opts.dpi || 150) / 72) });
        }
        res.push(out(`${baseName(f.name)}.pptx`, await native.buildPptx({ slides })));
      }
      return { files: res, zipName: 'PowerPoint' };
    },
  },
  {
    id: 'pdf2img', name: 'PDF in Bilder', desc: 'Seiten einer PDF in JPG, PNG oder WEBP umwandeln', icon: 'images', color: C.pink, cat: 'convertFrom',
    multiple: true, action: 'In Bilder umwandeln', keywords: 'jpg png jpeg bild foto pdf zu jpg pdf zu png',
    options: [
      { id: 'format', label: 'Format', type: 'seg', default: 'jpg', choices: [{ value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WEBP' }] },
      { id: 'dpi', label: 'Auflösung', type: 'seg', default: 150, choices: [{ value: 72, label: '72 dpi' }, { value: 150, label: '150 dpi' }, { value: 300, label: '300 dpi' }, { value: 600, label: '600 dpi' }] },
      { id: 'quality', label: 'Qualität', type: 'range', min: 30, max: 100, default: 90, format: (x) => `${x} %`, showIf: (v) => v.format !== 'png' },
      { id: 'pages', label: 'Seiten (leer = alle)', type: 'text', placeholder: 'z. B. 1-3, 5', default: '' },
    ],
    async run({ files, opts, progress }) {
      const res = [];
      const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[opts.format];
      for (const f of files) {
        const doc = await openPdf(f.data);
        const idx = pageRangeIndices(opts.pages, doc.numPages);
        const pad = String(doc.numPages).length;
        for (const i of idx) {
          progress(`${f.name}: Seite ${i + 1} von ${doc.numPages} …`, idx.indexOf(i) / idx.length);
          let scale = (+opts.dpi) / 72;
          const page = await doc.getPage(i + 1);
          const vp = page.getViewport({ scale });
          const maxSide = 14000, maxArea = 160e6;
          if (Math.max(vp.width, vp.height) > maxSide) scale *= maxSide / Math.max(vp.width, vp.height);
          if (vp.width * vp.height > maxArea) scale *= Math.sqrt(maxArea / (vp.width * vp.height));
          const { canvas } = await renderPage(doc, i, scale);
          res.push(out(`${baseName(f.name)}-Seite-${String(i + 1).padStart(pad, '0')}.${opts.format}`, await canvasToBytes(canvas, mime, (opts.quality || 90) / 100)));
          canvas.width = canvas.height = 0;
        }
      }
      return { files: res, zipName: `${baseName(files[0].name)}-Bilder` };
    },
  },
  {
    id: 'extractimages', name: 'Bilder extrahieren', desc: 'Alle eingebetteten Bilder aus PDF-Dateien speichern', icon: 'image-down', color: C.cyan, cat: 'convertFrom',
    multiple: true, action: 'Bilder extrahieren', keywords: 'bilder fotos herausholen',
    options: [
      { id: 'format', label: 'Format', type: 'seg', default: 'png', choices: [{ value: 'png', label: 'PNG (verlustfrei)' }, { value: 'jpg', label: 'JPG' }] },
      { id: 'minSize', label: 'Kleine Bilder ignorieren (unter 32 px)', type: 'checkbox', default: true },
    ],
    async run({ files, opts, progress }) {
      const res = [];
      for (const f of files) {
        const doc = await openPdf(f.data);
        const seen = new Set();
        let n = 0;
        for (let i = 0; i < doc.numPages; i++) {
          progress(`${f.name}: Seite ${i + 1} von ${doc.numPages} …`, i / doc.numPages);
          for (const im of await pageImages(doc, i)) {
            const sig = im.key ? im.key + ':' + im.img.width + 'x' + im.img.height : null;
            if (sig && seen.has(sig)) continue;
            if (sig) seen.add(sig);
            if (opts.minSize && (im.img.width < 32 || im.img.height < 32)) continue;
            const c = imageObjectToCanvas(im.img);
            if (!c) continue;
            n++;
            if (opts.format === 'jpg') {
              const c2 = document.createElement('canvas'); c2.width = c.width; c2.height = c.height;
              const x = c2.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c2.width, c2.height); x.drawImage(c, 0, 0);
              res.push(out(`${baseName(f.name)}-Bild-${String(n).padStart(3, '0')}.jpg`, await canvasToBytes(c2, 'image/jpeg', 0.95)));
            } else res.push(out(`${baseName(f.name)}-Bild-${String(n).padStart(3, '0')}.png`, await canvasToBytes(c, 'image/png')));
          }
        }
      }
      if (!res.length) throw new UserError('In der PDF wurden keine eingebetteten Bilder gefunden.');
      return { files: res, message: `${res.length} Bilder gefunden.`, zipName: `${baseName(files[0].name)}-Bilder` };
    },
  },
  {
    id: 'pdf2txt', name: 'PDF in Text', desc: 'Den gesamten Text einer PDF als TXT-Datei speichern', icon: 'type', color: C.slate, cat: 'convertFrom',
    multiple: true, action: 'Text extrahieren', keywords: 'txt text kopieren',
    options: [{ id: 'sep', label: 'Seitentrenner einfügen', type: 'checkbox', default: true }],
    async run({ files, opts, progress }) {
      const res = [];
      for (const f of files) {
        const { pages } = await pdfStructure(f, progress);
        const txt = pages.map((p, i) => (opts.sep ? `--- Seite ${i + 1} ---\n` : '') + p.lines.map((l) => l.text).join('\n')).join(opts.sep ? '\n\n' : '\n\f\n');
        if (!txt.replace(/--- Seite \d+ ---/g, '').trim()) toast(`„${f.name}“ enthält keinen Text. Tipp: Zuerst „Text per OCR erkennen“.`, 'error');
        res.push(out(`${baseName(f.name)}.txt`, new TextEncoder().encode(txt)));
      }
      return { files: res, zipName: 'Text' };
    },
  },
  {
    id: 'pdf2html', name: 'PDF in HTML', desc: 'PDF als Webseite (HTML) speichern', icon: 'code', color: C.slate, cat: 'convertFrom',
    multiple: true, action: 'In HTML umwandeln', keywords: 'html webseite',
    options: [{ id: 'mode', label: 'Inhalt', type: 'seg', vertical: true, default: 'text', choices: [{ value: 'text', label: 'Text (Absätze und Überschriften)' }, { value: 'image', label: 'Seitenbilder (originalgetreu)' }] }],
    async run({ files, opts, progress }) {
      const res = [];
      const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      for (const f of files) {
        const { doc, pages } = await pdfStructure(f, progress);
        let body = '';
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          body += `<section class="page" id="seite-${i + 1}">`;
          if (opts.mode === 'image' || !p.lines.some((l) => l.text.trim())) {
            const { canvas } = await renderPage(doc, i, 1.6);
            const bytes = await canvasToBytes(canvas, 'image/jpeg', 0.85);
            let s = ''; for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
            body += `<img src="data:image/jpeg;base64,${btoa(s)}" alt="Seite ${i + 1}">`;
          } else {
            const items = linesToParagraphs(p.lines, p.width).map((para) => {
              if (para.table) return { top: para.top, html: `<table>${para.table.map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table>` };
              const tag = para.heading ? (para.size > 20 ? 'h1' : 'h2') : 'p';
              return { top: para.top, html: `<${tag}${para.center ? ' style="text-align:center"' : ''}>${para.bold && tag === 'p' ? `<strong>${esc(para.text)}</strong>` : esc(para.text)}</${tag}>` };
            });
            const imgs = (await pageImages(doc, i)).filter((im) => im.rect.w >= 18 && im.rect.h >= 18);
            if (imgs.length) {
              const { canvas } = await renderPage(doc, i, 2, { annotationMode: 0 });
              for (const im of imgs) {
                const r = im.rect;
                const x = Math.max(0, r.x), y = Math.max(0, r.y), w = Math.min(p.width, r.x + r.w) - x, hh = Math.min(p.height, r.y + r.h) - y;
                if (w < 18 || hh < 18) continue;
                const c = document.createElement('canvas');
                c.width = Math.round(w * 2); c.height = Math.round(hh * 2);
                c.getContext('2d').drawImage(canvas, x * 2, y * 2, w * 2, hh * 2, 0, 0, c.width, c.height);
                const bytes = await canvasToBytes(c, 'image/jpeg', 0.88);
                let bin = ''; for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
                items.push({ top: y, html: `<figure><img src="data:image/jpeg;base64,${btoa(bin)}" style="max-width:${Math.round((w / p.width) * 100)}%" alt=""></figure>` });
              }
            }
            items.sort((a, b) => a.top - b.top);
            body += items.map((it) => it.html).join('');
          }
          body += '</section>';
        }
        const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(baseName(f.name))}</title><style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:860px;margin:30px auto;padding:0 18px;line-height:1.55;color:#1b1b1b;background:#f4f4f4}.page{background:#fff;padding:36px 44px;margin-bottom:24px;box-shadow:0 1px 4px rgba(0,0,0,.12)}.page img{width:100%;display:block}figure{margin:12px 0;text-align:center}table{border-collapse:collapse;margin:10px 0}td,th{border:1px solid #ccd;padding:4px 8px;text-align:left}th{background:#f2f4f7}figure img{display:inline-block !important;width:auto !important}</style></head><body>${body}</body></html>`;
        res.push(out(`${baseName(f.name)}.html`, new TextEncoder().encode(html)));
      }
      return { files: res, zipName: 'HTML' };
    },
  },
  {
    id: 'pdfa', name: 'PDF in PDF/A', desc: 'PDFs ins Archivformat PDF/A umwandeln', icon: 'archive', color: C.slate, cat: 'convertFrom',
    multiple: true, action: 'In PDF/A umwandeln', keywords: 'archiv langzeitarchivierung pdfa',
    options: [{ id: 'level', label: 'Version', type: 'seg', default: 2, choices: [{ value: 1, label: 'PDF/A-1b' }, { value: 2, label: 'PDF/A-2b' }, { value: 3, label: 'PDF/A-3b' }] }],
    async run({ files, opts, progress }) {
      const res = [];
      for (let i = 0; i < files.length; i++) { progress(`„${files[i].name}“ wird umgewandelt …`, i / files.length); res.push(out(pdfName(files[i], 'PDFA'), await toPdfA(files[i].data, +opts.level))); }
      return { files: res, zipName: 'PDFA' };
    },
  },

  // ===== Bearbeiten =====
  {
    id: 'edit', name: 'PDF bearbeiten', desc: 'Text, Bilder, Formen, Markierungen und Zeichnungen einfügen', icon: 'file-pen-line', color: C.indigo, cat: 'edit',
    multiple: false, keywords: 'editor text einfügen zeichnen markieren kommentieren annotieren', custom: (root, api) => mountEditor(root, api, 'edit'),
  },
  {
    id: 'sign', keepFilesAfter: true, name: 'PDF unterschreiben', desc: 'Unterschrift zeichnen, tippen oder als Bild einfügen', icon: 'signature', color: C.blue, cat: 'edit',
    multiple: false, keywords: 'signieren unterschrift signatur', custom: (root, api) => mountEditor(root, api, 'sign'),
  },
  {
    id: 'digisign', keepFilesAfter: true, name: 'PDF digital signieren', desc: 'Fälschungssicher signieren mit Zertifikat und Zeitstempel (PAdES)', icon: 'shield-check', color: C.indigo, cat: 'security',
    multiple: false, keywords: 'digitale signatur zertifikat pades eidas qes elektronisch rechtssicher docusign', custom: (root, api) => mountEditor(root, api, 'sign'),
  },
  {
    id: 'verify', name: 'Signatur prüfen', desc: 'Echtheit und Unverändertheit signierter PDFs prüfen', icon: 'file-check', color: C.green, cat: 'security',
    multiple: false, raw: true, keepFilesAfter: true, keywords: 'signatur prüfen echtheit validieren fälschung', custom: (root, api) => mountVerify(root, api),
  },
  {
    id: 'certs', name: 'Zertifikate verwalten', desc: 'Signaturzertifikate erstellen, importieren und sichern', icon: 'lock', color: C.slate, cat: 'security',
    noInput: true, keywords: 'zertifikat p12 pfx schlüssel signatur', custom: (root) => mountCertsPage(root),
  },
  {
    id: 'watermark', name: 'Wasserzeichen einfügen', desc: 'Text oder Bild als Wasserzeichen auf PDF-Seiten', icon: 'stamp', color: C.cyan, cat: 'edit',
    multiple: true, action: 'Wasserzeichen einfügen', keywords: 'stempel vertraulich entwurf',
    options: [
      { id: 'type', label: 'Art', type: 'seg', default: 'text', choices: [{ value: 'text', label: 'Text' }, { value: 'image', label: 'Bild' }] },
      { id: 'text', label: 'Text', type: 'text', default: 'VERTRAULICH', showIf: (v) => v.type === 'text' },
      { id: 'image', label: 'Bild', type: 'file', accept: 'image', showIf: (v) => v.type === 'image' },
      { id: 'imgScale', label: 'Bildgröße', type: 'range', min: 5, max: 100, default: 40, format: (x) => `${x} %`, showIf: (v) => v.type === 'image' },
      ...fontOptions().map((o) => ({ ...o, showIf: (v) => v.type === 'text' })),
      { id: 'size', label: 'Schriftgröße', type: 'range', min: 10, max: 160, default: 60, format: (x) => `${x} pt`, showIf: (v) => v.type === 'text' },
      { id: 'color', label: 'Farbe', type: 'color', default: '#d32f2f', showIf: (v) => v.type === 'text' },
      { id: 'opacity', label: 'Deckkraft', type: 'range', min: 5, max: 100, default: 25, format: (x) => `${x} %` },
      { id: 'rotation', label: 'Drehung', type: 'seg', default: 45, choices: [{ value: 0, label: '0°' }, { value: 45, label: '45°' }, { value: -45, label: '−45°' }, { value: 90, label: '90°' }] },
      { id: 'layout', label: 'Anordnung', type: 'seg', default: 'center', choices: [{ value: 'center', label: 'Mitte' }, { value: 'tile', label: 'Gekachelt' }, { value: 'pos', label: 'Position' }] },
      { id: 'pos', label: 'Position', type: 'position', default: 'bc', showIf: (v) => v.layout === 'pos' },
      { id: 'below', label: 'Hinter den Inhalt legen', type: 'checkbox', default: false },
      { id: 'pages', label: 'Seiten (leer = alle)', type: 'text', default: '', placeholder: 'z. B. 1, 3-5' },
    ],
    async run({ files, opts, progress }) {
      if (opts.type === 'text' && !String(opts.text || '').trim()) throw new UserError('Bitte einen Wasserzeichen-Text eingeben.');
      if (opts.type === 'image' && !opts.image) throw new UserError('Bitte ein Bild für das Wasserzeichen wählen.');
      const res = [];
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        progress(`„${f.name}“ …`, fi / files.length);
        const doc = await loadDoc(f.data);
        const idx = pageRangeIndices(opts.pages, doc.getPageCount());
        const op = (+opts.opacity || 25) / 100;
        const rot = +opts.rotation || 0;
        await stampPages(doc, idx, async (p, { width: W, height: H, tmpDoc }) => {
          let w, hh, draw;
          if (opts.type === 'image') {
            const img = await embedImageAny(tmpDoc, opts.image);
            const s = (Math.min(W, H) * (opts.imgScale / 100)) / Math.max(img.width, img.height);
            w = img.width * s; hh = img.height * s;
            draw = (x, y) => p.drawImage(img, { x, y, width: w, height: hh, opacity: op, rotate: degrees(rot) });
          } else {
            const font = await getFont(tmpDoc, opts.font, { bold: opts.bold, text: opts.text });
            const size = +opts.size || 60;
            w = font.widthOfTextAtSize(opts.text, size); hh = font.heightAtSize(size, { descender: false });
            draw = (x, y) => p.drawText(opts.text, { x, y, size, font, color: hexToRgb(opts.color || '#d32f2f'), opacity: op, rotate: degrees(rot) });
          }
          const rad = (rot * Math.PI) / 180;
          // Mittelpunkt -> Ursprung (unten links des gedrehten Objekts)
          const place = (cx, cy) => draw(cx - (w / 2) * Math.cos(rad) + (hh / 2) * Math.sin(rad), cy - (w / 2) * Math.sin(rad) - (hh / 2) * Math.cos(rad));
          if (opts.layout === 'tile') {
            const stepX = Math.abs(w * Math.cos(rad)) + Math.abs(hh * Math.sin(rad)) + 60;
            const stepY = Math.abs(w * Math.sin(rad)) + Math.abs(hh * Math.cos(rad)) + 60;
            for (let y = stepY / 2, r = 0; y < H + stepY; y += stepY, r++) for (let x = (r % 2 ? stepX / 2 : 0); x < W + stepX; x += stepX) place(x, y);
          } else if (opts.layout === 'pos') {
            const bw = Math.abs(w * Math.cos(rad)) + Math.abs(hh * Math.sin(rad)), bh = Math.abs(w * Math.sin(rad)) + Math.abs(hh * Math.cos(rad));
            const { x, y } = posXY(opts.pos || 'bc', W, H, bw, bh, 30);
            place(x + bw / 2, y + bh / 2);
          } else place(W / 2, H / 2);
        }, { below: !!opts.below });
        res.push(out(pdfName(f, 'Wasserzeichen'), await saveDoc(doc)));
      }
      return { files: res, zipName: 'Wasserzeichen' };
    },
  },
  {
    id: 'pagenumbers', name: 'Seitenzahlen einfügen', desc: 'Seitennummern in PDF-Dateien einfügen', icon: 'list-ordered', color: C.teal, cat: 'edit',
    multiple: true, action: 'Seitenzahlen einfügen', keywords: 'nummerieren paginierung',
    options: [
      { id: 'pos', label: 'Position', type: 'position', default: 'bc', only: ['tl', 'tc', 'tr', 'bl', 'bc', 'br'] },
      { id: 'format', label: 'Format', type: 'select', default: '{n}', choices: [
        { value: '{n}', label: '1' }, { value: 'Seite {n}', label: 'Seite 1' }, { value: 'Seite {n} von {total}', label: 'Seite 1 von 9' },
        { value: '{n} / {total}', label: '1 / 9' }, { value: '- {n} -', label: '- 1 -' }, { value: 'custom', label: 'Eigenes Format …' }] },
      { id: 'custom', label: 'Eigenes Format', type: 'text', default: 'S. {n}/{total}', help: '{n} = Seitenzahl, {total} = Gesamtzahl', showIf: (v) => v.format === 'custom' },
      { id: 'start', label: 'Erste Zahl', type: 'number', default: 1 },
      { id: 'from', label: 'Ab Seite nummerieren', type: 'number', default: 1, min: 1 },
      ...fontOptions(),
      { id: 'size', label: 'Schriftgröße', type: 'range', min: 6, max: 36, default: 11, format: (x) => `${x} pt` },
      { id: 'color', label: 'Farbe', type: 'color', default: '#000000' },
      { id: 'margin', label: 'Abstand zum Rand (pt)', type: 'number', default: 28, min: 0 },
      { id: 'mirror', label: 'Gerade/ungerade spiegeln (für Druck)', type: 'checkbox', default: false },
    ],
    async run({ files, opts, progress }) {
      const res = [];
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        progress(`„${f.name}“ …`, fi / files.length);
        const doc = await loadDoc(f.data);
        const total = doc.getPageCount();
        const from = Math.max(1, Math.floor(+opts.from || 1)) - 1;
        const fmt = opts.format === 'custom' ? (opts.custom || '{n}') : opts.format;
        const numbered = total - from;
        const idx = [...Array(total).keys()].filter((i) => i >= from);
        await stampPages(doc, idx, async (p, { width: W, height: H, index, tmpDoc }) => {
          const n = (+opts.start || 1) + (index - from);
          const lastN = (+opts.start || 1) + numbered - 1;
          const text = fmt.replace(/\{n\}/g, n).replace(/\{total\}/g, lastN);
          const font = await getFont(tmpDoc, opts.font, { bold: opts.bold, text });
          const size = +opts.size || 11;
          const w = font.widthOfTextAtSize(text, size), hh = font.heightAtSize(size, { descender: false });
          let pos = opts.pos || 'bc';
          if (opts.mirror && (index - from) % 2 === 1) pos = pos.replace('l', 'X').replace('r', 'l').replace('X', 'r');
          const { x, y } = posXY(pos, W, H, w, hh, +opts.margin || 28);
          p.drawText(text, { x, y, size, font, color: hexToRgb(opts.color || '#000000') });
        });
        res.push(out(pdfName(f, 'nummeriert'), await saveDoc(doc)));
      }
      return { files: res, zipName: 'Seitenzahlen' };
    },
  },
  {
    id: 'headerfooter', name: 'Kopf- und Fußzeile', desc: 'Text oben und unten auf jeder Seite einfügen', icon: 'panel-top', color: C.indigo, cat: 'edit',
    multiple: true, action: 'Einfügen', keywords: 'kopfzeile fußzeile header footer datum',
    options: [
      { id: 'hl', label: 'Kopfzeile links', type: 'text', default: '' },
      { id: 'hc', label: 'Kopfzeile Mitte', type: 'text', default: '' },
      { id: 'hr', label: 'Kopfzeile rechts', type: 'text', default: '{date}' },
      { id: 'fl', label: 'Fußzeile links', type: 'text', default: '{file}' },
      { id: 'fc', label: 'Fußzeile Mitte', type: 'text', default: '' },
      { id: 'fr', label: 'Fußzeile rechts', type: 'text', default: 'Seite {n} von {total}', help: 'Platzhalter: {n} {total} {date} {file}' },
      ...fontOptions(),
      { id: 'size', label: 'Schriftgröße', type: 'range', min: 6, max: 24, default: 9, format: (x) => `${x} pt` },
      { id: 'color', label: 'Farbe', type: 'color', default: '#444444' },
      { id: 'margin', label: 'Abstand zum Rand (pt)', type: 'number', default: 24, min: 0 },
    ],
    async run({ files, opts }) {
      const res = [];
      const date = new Date().toLocaleDateString('de-DE');
      for (const f of files) {
        const doc = await loadDoc(f.data);
        const total = doc.getPageCount();
        await stampPages(doc, [...Array(total).keys()], async (p, { width: W, height: H, index, tmpDoc }) => {
          const size = +opts.size || 9, m = +opts.margin || 24;
          const fill = (s) => String(s || '').replace(/\{n\}/g, index + 1).replace(/\{total\}/g, total).replace(/\{date\}/g, date).replace(/\{file\}/g, baseName(f.name));
          let any = false;
          for (const [key, pos] of [['hl', 'tl'], ['hc', 'tc'], ['hr', 'tr'], ['fl', 'bl'], ['fc', 'bc'], ['fr', 'br']]) {
            const text = fill(opts[key]);
            if (!text.trim()) continue;
            any = true;
            const font = await getFont(tmpDoc, opts.font, { bold: opts.bold, text });
            const w = font.widthOfTextAtSize(text, size), hh = font.heightAtSize(size, { descender: false });
            const { x, y } = posXY(pos, W, H, w, hh, m);
            p.drawText(text, { x, y, size, font, color: hexToRgb(opts.color || '#444444') });
          }
          return any;
        });
        res.push(out(pdfName(f, 'Kopf-Fusszeile'), await saveDoc(doc)));
      }
      return { files: res };
    },
  },
  {
    id: 'overlay', name: 'PDFs übereinanderlegen', desc: 'PDFs überlagern, z. B. mit einem Briefpapier verbinden', icon: 'layers', color: C.violet, cat: 'edit',
    multiple: true, action: 'Überlagern', keywords: 'briefpapier briefbogen hintergrund vorlage overlay',
    acceptLabel: 'Zuerst die Inhalts-PDF(s) wählen, das Briefpapier danach in den Optionen',
    options: [
      { id: 'stationery', label: 'Überlagerungs-PDF (z. B. Briefpapier)', type: 'file', accept: 'pdf' },
      { id: 'mode', label: 'Überlagerung', type: 'seg', default: 'below', choices: [{ value: 'below', label: 'Als Hintergrund' }, { value: 'above', label: 'Im Vordergrund' }] },
      { id: 'repeat', label: 'Seitenzuordnung', type: 'select', default: 'first', choices: [
        { value: 'first', label: 'Erste Seite auf alle Seiten' }, { value: 'firstlast', label: 'Seite 1 auf Seite 1, Seite 2 auf alle folgenden' },
        { value: 'match', label: 'Seite für Seite (danach letzte wiederholen)' }, { value: 'cycle', label: 'Seite für Seite (zyklisch)' }, { value: 'firstonly', label: 'Nur auf erster Seite' }] },
      { id: 'fit', label: 'Auf Seitengröße skalieren', type: 'checkbox', default: true },
    ],
    async run({ files, opts, progress }) {
      if (!opts.stationery) throw new UserError('Bitte in den Optionen eine Überlagerungs-PDF (z. B. Briefpapier) wählen.');
      const res = [];
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        progress(`„${f.name}“ …`, fi / files.length);
        const doc = await loadDoc(f.data);
        const st = await loadDoc(opts.stationery.data);
        const sc = st.getPageCount();
        const total = doc.getPageCount();
        for (let i = 0; i < total; i++) {
          let k;
          if (opts.repeat === 'first') k = 0;
          else if (opts.repeat === 'firstonly') { if (i > 0) continue; k = 0; }
          else if (opts.repeat === 'firstlast') k = i === 0 ? 0 : Math.min(1, sc - 1);
          else if (opts.repeat === 'match') k = Math.min(i, sc - 1);
          else k = i % sc;
          const page = doc.getPage(i);
          const { width: W, height: H } = displayBox(page);
          const tmp = await PDFDocument.create();
          const tp = tmp.addPage([W, H]);
          const [e] = await tmp.embedPdf(opts.stationery.data, [k]);
          if (opts.fit) tp.drawPage(e, { x: 0, y: 0, width: W, height: H });
          else tp.drawPage(e, { x: 0, y: H - e.height });
          const [emb] = await doc.embedPdf(await tmp.save(), [0]);
          drawUpright(page, emb, { below: opts.mode === 'below' });
        }
        res.push(out(pdfName(f, 'ueberlagert'), await saveDoc(doc)));
      }
      return { files: res };
    },
  },
  {
    id: 'crop', name: 'PDF zuschneiden', desc: 'Ränder von PDF-Seiten abschneiden, auch automatisch', icon: 'crop', color: C.amber, cat: 'edit',
    multiple: true, action: 'Zuschneiden', keywords: 'ränder beschneiden trimmen',
    options: [
      { id: 'mode', label: 'Modus', type: 'seg', default: 'auto', choices: [{ value: 'auto', label: 'Weiße Ränder automatisch' }, { value: 'manual', label: 'Ränder in mm' }] },
      { id: 'padding', label: 'Zusätzlicher Rand (mm)', type: 'number', default: 3, min: 0, showIf: (v) => v.mode === 'auto' },
      { id: 'top', label: 'Oben (mm)', type: 'number', default: 10, min: 0, showIf: (v) => v.mode === 'manual' },
      { id: 'bottom', label: 'Unten (mm)', type: 'number', default: 10, min: 0, showIf: (v) => v.mode === 'manual' },
      { id: 'left', label: 'Links (mm)', type: 'number', default: 10, min: 0, showIf: (v) => v.mode === 'manual' },
      { id: 'right', label: 'Rechts (mm)', type: 'number', default: 10, min: 0, showIf: (v) => v.mode === 'manual' },
      { id: 'pages', label: 'Seiten (leer = alle)', type: 'text', default: '' },
    ],
    async run({ files, opts, progress }) {
      const mm = 72 / 25.4;
      const res = [];
      for (const f of files) {
        const doc = await loadDoc(f.data);
        const pdf = opts.mode === 'auto' ? await openPdf(f.data) : null;
        const idx = pageRangeIndices(opts.pages, doc.getPageCount());
        for (const i of idx) {
          progress(`Seite ${i + 1} …`, idx.indexOf(i) / idx.length);
          const page = doc.getPage(i);
          const crop = page.getCropBox();
          const rot = ((page.getRotation().angle % 360) + 360) % 360;
          // Ränder in Darstellungsrichtung
          let t, b, l, r;
          if (opts.mode === 'auto') {
            const scale = 1.5;
            const { canvas } = await renderPage(pdf, i, scale, { annotationMode: 0 });
            const ctx = canvas.getContext('2d');
            const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
            for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
              const k = (y * canvas.width + x) * 4;
              if (d[k] < 245 || d[k + 1] < 245 || d[k + 2] < 245) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
            }
            if (maxX < 0) continue; // leere Seite
            const pad = (+opts.padding || 0) * mm;
            l = Math.max(0, minX / scale - pad); t = Math.max(0, minY / scale - pad);
            r = Math.max(0, (canvas.width - maxX - 1) / scale - pad); b = Math.max(0, (canvas.height - maxY - 1) / scale - pad);
          } else { t = (+opts.top || 0) * mm; b = (+opts.bottom || 0) * mm; l = (+opts.left || 0) * mm; r = (+opts.right || 0) * mm; }
          // in Benutzerkoordinaten übertragen
          let L, R, T, B;
          if (rot === 0) [L, R, T, B] = [l, r, t, b];
          else if (rot === 90) [L, R, T, B] = [t, b, r, l];
          else if (rot === 180) [L, R, T, B] = [r, l, b, t];
          else [L, R, T, B] = [b, t, l, r];
          const w = crop.width - L - R, hh = crop.height - T - B;
          if (w < 10 || hh < 10) throw new UserError('Die Ränder sind größer als die Seite.');
          page.setCropBox(crop.x + L, crop.y + B, w, hh);
          page.setMediaBox(crop.x + L, crop.y + B, w, hh);
          try { page.setTrimBox(crop.x + L, crop.y + B, w, hh); page.setBleedBox(crop.x + L, crop.y + B, w, hh); } catch (_) {}
        }
        res.push(out(pdfName(f, 'zugeschnitten'), await saveDoc(doc)));
      }
      return { files: res };
    },
  },
  {
    id: 'resize', name: 'Seitenformat ändern', desc: 'PDF-Seiten auf A4, A3, Letter und mehr skalieren', icon: 'scaling', color: C.sky, cat: 'edit',
    multiple: true, action: 'Format ändern', keywords: 'a4 skalieren größe papierformat',
    options: [
      { id: 'size', label: 'Neues Format', type: 'select', default: 'A4', choices: Object.keys(PAGE_SIZES).map((k) => ({ value: k, label: k })) },
      { id: 'orientation', label: 'Ausrichtung', type: 'seg', default: 'auto', choices: [{ value: 'auto', label: 'Wie Original' }, { value: 'portrait', label: 'Hoch' }, { value: 'landscape', label: 'Quer' }] },
      { id: 'margin', label: 'Rand (mm)', type: 'number', default: 0, min: 0 },
    ],
    async run({ files, opts }) {
      const res = [];
      for (const f of files) {
        const src = await loadDoc(f.data);
        const outDoc = await PDFDocument.create();
        const n = src.getPageCount();
        const emb = await outDoc.embedPdf(f.data, [...Array(n).keys()]);
        const m = (+opts.margin || 0) * (72 / 25.4);
        for (let i = 0; i < n; i++) {
          const sp = src.getPage(i);
          const { width: dw, height: dh, rot } = displayBox(sp);
          let [W, H] = PAGE_SIZES[opts.size] || PAGE_SIZES.A4;
          const land = opts.orientation === 'landscape' || (opts.orientation === 'auto' && dw > dh);
          if (land) [W, H] = [H, W];
          const p = outDoc.addPage([W, H]);
          const s = Math.min((W - 2 * m) / dw, (H - 2 * m) / dh);
          const w = dw * s, hh = dh * s, x = (W - w) / 2, y = (H - hh) / 2;
          const e = emb[i];
          if (rot === 0) p.drawPage(e, { x, y, width: e.width * s, height: e.height * s });
          else if (rot === 90) p.drawPage(e, { x: x + w, y, width: e.width * s, height: e.height * s, rotate: degrees(90) });
          else if (rot === 180) p.drawPage(e, { x: x + w, y: y + hh, width: e.width * s, height: e.height * s, rotate: degrees(180) });
          else p.drawPage(e, { x, y: y + hh, width: e.width * s, height: e.height * s, rotate: degrees(270) });
        }
        res.push(out(pdfName(f, opts.size), await saveDoc(outDoc)));
      }
      return { files: res };
    },
  },
  {
    id: 'forms', keepFilesAfter: true, name: 'PDF Formular ausfüllen', desc: 'Formularfelder in PDFs ausfüllen und speichern', icon: 'text-cursor-input', color: C.green, cat: 'edit',
    multiple: false, keywords: 'formular felder ausfüllen', custom: (root, api) => mountForms(root, api),
  },
  {
    id: 'metadata', keepFilesAfter: true, name: 'Metadaten bearbeiten', desc: 'Titel, Autor, Betreff und Stichwörter ändern oder entfernen', icon: 'info', color: C.slate, cat: 'edit',
    multiple: false, keywords: 'eigenschaften titel autor metadaten entfernen', custom: (root, api) => mountMetadata(root, api),
  },
  {
    id: 'flatten', name: 'PDF reduzieren (flatten)', desc: 'Formulare und Kommentare fest in die Seiten einbetten', icon: 'layers-2', color: C.slate, cat: 'edit',
    multiple: true, action: 'Reduzieren', keywords: 'flatten fixieren formular kommentare einbetten',
    async run({ files }) {
      const res = [];
      for (const f of files) {
        let data = f.data;
        try {
          const doc = await loadDoc(data);
          const form = doc.getForm();
          if (form.getFields().length) { form.updateFieldAppearances(); form.flatten(); data = await saveDoc(doc); }
        } catch (_) {}
        data = await flattenAnnotations(data);
        res.push(out(pdfName(f, 'reduziert'), data));
      }
      return { files: res };
    },
  },

  // ===== Optimieren =====
  {
    id: 'compress', name: 'PDF komprimieren', desc: 'PDF-Dateien verkleinern und Speicherplatz sparen', icon: 'minimize-2', color: C.green, cat: 'optimize',
    multiple: true, action: 'Komprimieren', keywords: 'verkleinern dateigröße reduzieren',
    options: [
      { id: 'preset', label: 'Komprimierung', type: 'seg', vertical: true, default: 'ebook', choices: [
        { value: 'screen', label: 'Stark', help: 'Kleinste Datei, 72 dpi, für Bildschirm' },
        { value: 'ebook', label: 'Empfohlen', help: 'Gute Qualität, 150 dpi' },
        { value: 'printer', label: 'Gering', help: 'Hohe Qualität, 300 dpi, für Druck' },
        { value: 'custom', label: 'Eigene Einstellung', help: 'Auflösung und Bildqualität wählen' }] },
      { id: 'dpi', label: 'Bildauflösung', type: 'range', min: 36, max: 300, step: 6, default: 120, format: (x) => `${x} dpi`, showIf: (v) => v.preset === 'custom' },
      { id: 'quality', label: 'Bildqualität', type: 'range', min: 10, max: 100, default: 70, format: (x) => `${x} %`, showIf: (v) => v.preset === 'custom' },
      { id: 'gray', label: 'In Graustufen umwandeln', type: 'checkbox', default: false },
    ],
    async run({ files, opts, progress }) {
      const res = [];
      let before = 0, after = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        progress(`„${f.name}“ wird komprimiert (${i + 1}/${files.length}) …`, files.length > 1 ? i / files.length : null);
        let data = await compress(f.data, opts.preset === 'custom' ? { preset: 'custom', dpi: +opts.dpi, quality: +opts.quality, gray: opts.gray } : { preset: opts.preset, gray: opts.gray });
        try { const lin = await linearize(data); if (lin.length < data.length) data = lin; } catch (_) {}
        if (data.length >= f.data.length && !opts.gray) data = f.data;
        before += f.data.length; after += data.length;
        res.push(out(pdfName(f, 'komprimiert'), data));
      }
      const saved = pct(before, after);
      return { files: res, stats: `${formatBytes(before)} → ${formatBytes(after)} · ${saved > 0 ? `${saved} % kleiner` : 'bereits optimal komprimiert'}`, zipName: 'komprimiert' };
    },
  },
  {
    id: 'optimize', name: 'PDF optimieren', desc: 'PDF für schnelle Anzeige im Web optimieren (linearisieren)', icon: 'zap', color: C.amber, cat: 'optimize',
    multiple: true, action: 'Optimieren', keywords: 'web schnell linearisieren fast web view',
    async run({ files }) {
      const res = [];
      let before = 0, after = 0;
      for (const f of files) { const d = await linearize(f.data); before += f.data.length; after += d.length; res.push(out(pdfName(f, 'optimiert'), d)); }
      return { files: res, stats: `${formatBytes(before)} → ${formatBytes(after)} · für schnelle Webanzeige optimiert` };
    },
  },
  {
    id: 'grayscale', name: 'PDF in Graustufen', desc: 'Farbige PDFs in Schwarz-Weiß umwandeln', icon: 'contrast', color: C.slate, cat: 'optimize',
    multiple: true, action: 'Umwandeln', keywords: 'schwarz weiß grau farbe entfernen',
    async run({ files, progress }) {
      const res = [];
      for (let i = 0; i < files.length; i++) { progress(`„${files[i].name}“ …`, i / files.length); res.push(out(pdfName(files[i], 'graustufen'), await grayscale(files[i].data))); }
      return { files: res };
    },
  },
  {
    id: 'removeblank', name: 'Leere Seiten entfernen', desc: 'Leere Seiten (z. B. aus Scans) automatisch löschen', icon: 'file-x', color: C.red, cat: 'optimize',
    multiple: true, action: 'Leere Seiten entfernen', keywords: 'leer weiß scan seiten löschen',
    options: [{ id: 'tolerance', label: 'Empfindlichkeit', type: 'range', min: 1, max: 30, default: 8, format: (x) => (x < 8 ? 'streng' : x > 15 ? 'großzügig' : 'normal'), help: 'Großzügig erkennt auch Seiten mit wenigen Flecken als leer.' }],
    async run({ files, opts, progress }) {
      const res = [];
      let removed = 0;
      for (const f of files) {
        const pdf = await openPdf(f.data);
        const keep = [];
        for (let i = 0; i < pdf.numPages; i++) {
          progress(`Seite ${i + 1} von ${pdf.numPages} wird geprüft …`, i / pdf.numPages);
          const { canvas } = await renderPage(pdf, i, 0.5);
          const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let dark = 0;
          for (let k = 0; k < d.length; k += 4) if ((d[k] + d[k + 1] + d[k + 2]) / 3 < 200) dark++;
          const ratio = (dark / (d.length / 4)) * 1000; // Promille
          if (ratio > (+opts.tolerance || 8) / 4) keep.push(i);
        }
        removed += pdf.numPages - keep.length;
        if (!keep.length) throw new UserError(`In „${f.name}“ sind alle Seiten leer.`);
        res.push(out(pdfName(f, 'ohne-leere-Seiten'), await pickPages(f.data, keep)));
      }
      return { files: res, stats: removed ? `${removed} leere ${removed === 1 ? 'Seite' : 'Seiten'} entfernt` : 'Keine leeren Seiten gefunden' };
    },
  },
  {
    id: 'ocr', name: 'Text per OCR erkennen', desc: 'Text in Scans erkennen und durchsuchbare PDFs erstellen', icon: 'scan-text', color: C.indigo, cat: 'optimize',
    multiple: true, accept: ['pdf', 'image'], action: 'Text erkennen', keywords: 'ocr scan texterkennung durchsuchbar',
    acceptLabel: 'Gescannte PDFs oder Bilder',
    options: [
      { id: 'langs', label: 'Sprachen im Dokument', type: 'select', default: 'deu+eng', choices: [
        { value: 'deu+eng', label: 'Deutsch + Englisch' }, { value: 'deu', label: 'Deutsch' }, { value: 'eng', label: 'Englisch' },
        { value: 'fra', label: 'Französisch' }, { value: 'spa', label: 'Spanisch' }, { value: 'ita', label: 'Italienisch' }, { value: 'deu+eng+fra+spa+ita', label: 'Alle (langsamer)' }] },
      { id: 'skip', label: 'Seiten mit vorhandenem Text überspringen', type: 'checkbox', default: true },
      { id: 'dpi', label: 'Genauigkeit', type: 'seg', default: 300, choices: [{ value: 200, label: 'Schnell' }, { value: 300, label: 'Genau' }, { value: 400, label: 'Sehr genau' }] },
    ],
    async run({ files, opts }) {
      const res = [];
      let processed = 0;
      for (const f of files) {
        busy(`„${f.name}“ wird vorbereitet …`);
        let data = ext(f.name) === 'pdf' ? f.data : await imagesToPdf([f], { pageSize: 'image' });
        const skipPages = [];
        if (opts.skip && ext(f.name) === 'pdf') {
          const pdf = await openPdf(data);
          for (let i = 0; i < pdf.numPages; i++) if (await pageHasText(pdf, i)) skipPages.push(i);
        }
        const r = await native.ocr(data, { langs: String(opts.langs || 'deu+eng').split('+'), skipPages, dpi: +opts.dpi || 300 });
        processed += r.processed;
        res.push(out(pdfName(f, 'OCR'), r.data));
      }
      return { files: res, stats: processed ? `Text auf ${processed} ${processed === 1 ? 'Seite' : 'Seiten'} erkannt` : 'Alle Seiten enthielten bereits Text' };
    },
  },
  {
    id: 'repair', name: 'PDF reparieren', desc: 'Beschädigte PDF-Dateien wiederherstellen', icon: 'wrench', color: C.orange, cat: 'optimize',
    multiple: true, raw: true, action: 'Reparieren', keywords: 'kaputt beschädigt defekt',
    async run({ files }) {
      const res = [];
      for (const f of files) res.push(out(pdfName(f, 'repariert'), await repair(f.data)));
      return { files: res };
    },
  },
  {
    id: 'compare', name: 'PDFs vergleichen', desc: 'Zwei PDFs vergleichen und die Unterschiede anzeigen', icon: 'git-compare', color: C.teal, cat: 'optimize',
    multiple: true, keywords: 'unterschiede diff vergleich', custom: (root, api) => mountCompare(root, api),
  },

  // ===== Sicherheit =====
  {
    id: 'encrypt', name: 'PDF verschlüsseln', desc: 'PDFs mit Passwort schützen und Berechtigungen setzen', icon: 'lock', color: C.red, cat: 'security',
    multiple: true, action: 'Verschlüsseln', keywords: 'passwort schützen sperren sichern',
    options: [
      { id: 'pw', label: 'Passwort zum Öffnen', type: 'password', default: '' },
      { id: 'pw2', label: 'Passwort wiederholen', type: 'password', default: '' },
      { id: 'restrict', label: 'Berechtigungen einschränken', type: 'checkbox', default: false },
      { id: 'allowPrint', label: 'Drucken erlauben', type: 'checkbox', default: true, showIf: (v) => v.restrict },
      { id: 'allowCopy', label: 'Kopieren von Text und Bildern erlauben', type: 'checkbox', default: false, showIf: (v) => v.restrict },
      { id: 'allowModify', label: 'Ändern erlauben', type: 'checkbox', default: false, showIf: (v) => v.restrict },
      { id: 'allowAnnotate', label: 'Kommentieren erlauben', type: 'checkbox', default: false, showIf: (v) => v.restrict },
      { id: 'allowForms', label: 'Formulare ausfüllen erlauben', type: 'checkbox', default: true, showIf: (v) => v.restrict },
      { id: 'owner', label: 'Berechtigungspasswort (optional)', type: 'password', default: '', help: 'Wird benötigt, um die Einschränkungen aufzuheben.', showIf: (v) => v.restrict },
    ],
    info: 'Verschlüsselung mit AES-256. Bewahre das Passwort gut auf, ohne es lässt sich die Datei nicht mehr öffnen.',
    async run({ files, opts }) {
      if (!opts.pw && !opts.restrict) throw new UserError('Bitte ein Passwort eingeben.');
      if (opts.pw !== opts.pw2) throw new UserError('Die Passwörter stimmen nicht überein.');
      const res = [];
      for (const f of files) {
        res.push(out(pdfName(f, 'geschuetzt'), await encrypt(f.data, {
          userPassword: opts.pw || '', ownerPassword: opts.owner || '',
          allowPrint: opts.restrict ? opts.allowPrint : true, allowCopy: opts.restrict ? opts.allowCopy : true,
          allowModify: opts.restrict ? opts.allowModify : true, allowAnnotate: opts.restrict ? opts.allowAnnotate : true, allowForms: opts.restrict ? opts.allowForms : true,
        })));
      }
      return { files: res, message: 'Die PDF ist jetzt mit AES-256 geschützt.' };
    },
  },
  {
    id: 'unlock', name: 'Passwortschutz entfernen', desc: 'PDF Passwort entfernen und Schutz aufheben', icon: 'lock-open', color: C.green, cat: 'security',
    multiple: true, raw: true, action: 'Passwort entfernen', keywords: 'entsperren passwort entfernen schutz aufheben unlock entschlüsseln',
    options: [{ id: 'pw', label: 'Passwort (falls zum Öffnen nötig)', type: 'password', default: '', help: 'Leer lassen, wenn die PDF nur Einschränkungen (Drucken, Kopieren) hat.' }],
    async run({ files, opts }) {
      const res = [];
      let notProtected = 0;
      for (const f of files) {
        busy(`„${f.name}“ wird entsperrt …`);
        let enc;
        try { enc = await isEncrypted(f.data); } catch (_) { enc = true; }
        if (!enc) { notProtected++; res.push(out(pdfName(f, 'entsperrt'), f.data)); continue; }
        let pw = opts.pw || '';
        let data = null;
        for (let attempt = 0; ; attempt++) {
          try { data = await decrypt(f.data, pw); break; }
          catch (e) {
            if (!isWrongPassword(e)) throw e;
            if (!pw && attempt === 0 && opts.pw) { pw = opts.pw; continue; }
            idle();
            const p = await askPassword(f.name, attempt > 0 || !!pw);
            if (p === null) throw new UserError(`Für „${f.name}“ wurde kein Passwort eingegeben.`);
            pw = p;
            busy(`„${f.name}“ wird entsperrt …`);
          }
        }
        res.push(out(pdfName(f, 'entsperrt'), data));
      }
      return { files: res, message: notProtected === files.length ? 'Die Datei war nicht geschützt.' : 'Passwort und Einschränkungen wurden entfernt.' };
    },
  },
  {
    id: 'redact', keepFilesAfter: true, name: 'PDF schwärzen', desc: 'Vertrauliche Inhalte in PDFs dauerhaft schwärzen', icon: 'eraser', color: C.slate, cat: 'security',
    multiple: false, keywords: 'schwärzen zensieren anonymisieren datenschutz', custom: (root, api) => mountEditor(root, api, 'redact'),
  },
];

// ---------- Formulare ausfüllen ----------
async function mountForms(root, api) {
  const f = api.files[0];
  const doc = await loadDoc(f.data);
  const form = doc.getForm();
  const fields = form.getFields();
  const main = h('div', { class: 'tool-main' });
  const side = h('div', { class: 'tool-side' });
  root.append(main, side);
  if (!fields.length) {
    main.append(h('div', { class: 'result' }, h('div', { class: 'ok-icon', html: icon('info', 30), style: { background: 'var(--accent-soft)', color: 'var(--accent)' } }),
      h('h3', {}, 'Keine Formularfelder gefunden'),
      h('p', { class: 'sub' }, 'Diese PDF enthält keine ausfüllbaren Felder. Du kannst Text aber frei auf die Seiten schreiben.'),
      h('button', { class: 'btn primary', onclick: () => window.__go('edit', [f]) }, ic('file-pen-line', 18), 'Mit „PDF bearbeiten“ ausfüllen')));
    side.append(h('div', { class: 'side-scroll' }, h('button', { class: 'btn', onclick: () => { api.files.length = 0; api.render(); } }, 'Andere Datei wählen')));
    return;
  }
  const list = h('div', { class: 'form-fields' });
  const getters = [];
  for (const field of fields) {
    const L = window.PDFLib;
    const type = field instanceof L.PDFTextField ? 'PDFTextField' : field instanceof L.PDFCheckBox ? 'PDFCheckBox' : field instanceof L.PDFRadioGroup ? 'PDFRadioGroup' : field instanceof L.PDFDropdown ? 'PDFDropdown' : field instanceof L.PDFOptionList ? 'PDFOptionList' : 'other';
    const name = field.getName();
    const row = h('div', { class: 'form-field-row' }, h('div', { class: 'ff-name' }, name));
    try {
      if (type === 'PDFTextField') {
        const multi = field.isMultiline();
        const i = h(multi ? 'textarea' : 'input', { class: 'input' });
        i.value = field.getText() || '';
        row.append(i);
        getters.push(() => field.setText(i.value));
      } else if (type === 'PDFCheckBox') {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = field.isChecked();
        row.append(h('label', { class: 'check' }, cb, 'Angekreuzt'));
        getters.push(() => (cb.checked ? field.check() : field.uncheck()));
      } else if (type === 'PDFRadioGroup') {
        const s = h('select', { class: 'input' }, h('option', { value: '' }, '–'), ...field.getOptions().map((o) => h('option', { value: o }, o)));
        s.value = field.getSelected() || '';
        row.append(s);
        getters.push(() => { if (s.value) field.select(s.value); else field.clear(); });
      } else if (type === 'PDFDropdown') {
        const s = h('select', { class: 'input' }, h('option', { value: '' }, '–'), ...field.getOptions().map((o) => h('option', { value: o }, o)));
        s.value = (field.getSelected() || [])[0] || '';
        row.append(s);
        getters.push(() => { if (s.value) field.select(s.value); else field.clear(); });
      } else if (type === 'PDFOptionList') {
        const s = h('select', { class: 'input', multiple: true, style: { height: '90px' } }, ...field.getOptions().map((o) => h('option', { value: o }, o)));
        const sel = field.getSelected() || [];
        for (const o of s.options) o.selected = sel.includes(o.value);
        row.append(s);
        getters.push(() => { const v = [...s.selectedOptions].map((o) => o.value); if (v.length) field.select(v); else field.clear(); });
      } else continue;
    } catch (_) { continue; }
    list.append(row);
  }
  main.append(list);
  const v = api.values;
  const box = h('div');
  renderOptions(box, [{ id: 'flatten', label: 'Formular danach fixieren (nicht mehr änderbar)', type: 'checkbox', default: false }], v);
  side.append(h('div', { class: 'side-scroll' }, h('div', { class: 'side-title' }, 'Formular'), h('div', { class: 'hint', style: { marginBottom: '14px' } }, `${fields.length} Felder gefunden`), box),
    h('div', { class: 'side-foot' }, h('button', { class: 'btn primary big', onclick: () => api.run(async () => {
      for (const g of getters) { try { g(); } catch (_) {} }
      const font = await doc.embedFont(StandardFonts.Helvetica);
      try { form.updateFieldAppearances(font); } catch (_) {}
      if (v.flatten) form.flatten();
      return [out(pdfName(f, 'ausgefuellt'), await saveDoc(doc))];
    }) }, 'Speichern')));
}

// ---------- Metadaten ----------
async function mountMetadata(root, api) {
  const f = api.files[0];
  const doc = await loadDoc(f.data);
  const v = api.values;
  const get = (fn) => { try { return fn() || ''; } catch (_) { return ''; } };
  Object.assign(v, {
    title: v.title ?? get(() => doc.getTitle()), author: v.author ?? get(() => doc.getAuthor()), subject: v.subject ?? get(() => doc.getSubject()),
    keywords: v.keywords ?? get(() => doc.getKeywords()), creator: v.creator ?? get(() => doc.getCreator()), producer: v.producer ?? get(() => doc.getProducer()),
  });
  const main = h('div', { class: 'tool-main' });
  const box = h('div', { style: { maxWidth: '620px', margin: '0 auto' } });
  renderOptions(box, [
    { id: 'title', label: 'Titel', type: 'text' }, { id: 'author', label: 'Autor', type: 'text' }, { id: 'subject', label: 'Betreff', type: 'text' },
    { id: 'keywords', label: 'Stichwörter', type: 'text', help: 'Mit Komma trennen' }, { id: 'creator', label: 'Erstellt mit (Anwendung)', type: 'text' },
    { id: 'producer', label: 'PDF-Erzeuger', type: 'text' }, { id: 'strip', label: 'Alle Metadaten entfernen (Datenschutz)', type: 'checkbox', default: false },
  ], v);
  const created = get(() => doc.getCreationDate()?.toLocaleString('de-DE'));
  const modified = get(() => doc.getModificationDate()?.toLocaleString('de-DE'));
  box.append(h('div', { class: 'hint' }, `Seiten: ${doc.getPageCount()}${created ? ` · Erstellt: ${created}` : ''}${modified ? ` · Geändert: ${modified}` : ''}`));
  main.append(box);
  const side = h('div', { class: 'tool-side' }, h('div', { class: 'side-scroll' }, h('div', { class: 'side-title' }, 'Datei'), h('div', { class: 'hint' }, f.name),
    h('button', { class: 'btn small', style: { marginTop: '12px' }, onclick: () => { api.files.length = 0; Object.keys(v).forEach((k) => delete v[k]); api.render(); } }, 'Andere Datei')),
  h('div', { class: 'side-foot' }, h('button', { class: 'btn primary big', onclick: () => api.run(async () => {
    const d = await loadDoc(f.data);
    if (v.strip) {
      const { PDFName } = window.PDFLib;
      d.setTitle(''); d.setAuthor(''); d.setSubject(''); d.setKeywords([]); d.setCreator(''); d.setProducer('');
      const info = d.context.lookup(d.context.trailerInfo.Info);
      if (info && info.keys) for (const k of info.keys()) info.delete(k);
      d.catalog.delete(PDFName.of('Metadata'));
      return [out(pdfName(f, 'ohne-Metadaten'), await d.save({ updateFieldAppearances: false }))];
    }
    d.setTitle(v.title || ''); d.setAuthor(v.author || ''); d.setSubject(v.subject || '');
    d.setKeywords(String(v.keywords || '').split(',').map((s) => s.trim()).filter(Boolean));
    d.setCreator(v.creator || ''); d.setProducer(v.producer || ''); d.setModificationDate(new Date());
    return [out(f.name, await saveDoc(d))];
  }) }, 'Speichern')));
  root.append(main, side);
}
