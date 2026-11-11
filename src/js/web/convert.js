// Umwandlung von Dokumenten in PDF, vollständig im Browser.
// Word (DOCX), Excel (XLSX, XLS, ODS, CSV), PowerPoint (PPTX), HTML, Markdown, Text und EPUB.
import JSZip from 'jszip';
import { withFrame, flowsToPdf, htmlToPdfBytes, PAGE_SIZES } from './dom2pdf.js';
import { UserError } from '../core.js';
import { emitProgress } from '../native.js';

const extOf = (name) => ((/\.([^.]+)$/.exec(name) || [])[1] || '').toLowerCase();
const baseOf = (name) => name.replace(/\.[^.]+$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toU8 = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d));
const progress = (text, value) => emitProgress({ text, value });

function decodeText(bytes) {
  const u8 = toU8(bytes);
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (_) { return new TextDecoder('windows-1252').decode(u8); }
}

const DOC_CSS = `
body { font-family: "Liberation Sans", Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1f2328; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 .5em; font-weight: 700; break-after: avoid; }
h1 { font-size: 22pt; } h2 { font-size: 17pt; } h3 { font-size: 14pt; } h4 { font-size: 12pt; }
h1:first-child, h2:first-child { margin-top: 0; }
p { margin: 0 0 .75em; }
a { color: #0b57d0; text-decoration: underline; }
ul, ol { margin: 0 0 .75em; padding-left: 1.6em; }
li { margin: .2em 0; }
blockquote { margin: 0 0 .75em; padding: .2em 1em; border-left: 3px solid #d0d7de; color: #57606a; }
code { font-family: "Liberation Mono", monospace; font-size: .9em; background: #f3f4f6; padding: .1em .3em; border-radius: 3px; }
pre { font-family: "Liberation Mono", monospace; font-size: 9pt; line-height: 1.45; background: #f6f8fa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: 0 0 1em; max-width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 5px 9px; text-align: left; vertical-align: top; }
th { background: #f3f4f6; font-weight: 700; }
tr { break-inside: avoid; }
img { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.5em 0; }
`;

// ---------- Text, Markdown, HTML ----------
async function textToPdf(bytes, name) {
  const txt = decodeText(bytes).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const code = /^(json|xml|log|eml)$/.test(extOf(name));
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:${code ? '"Liberation Mono",monospace' : '"Liberation Sans",sans-serif'};font-size:${code ? '9pt' : '11pt'};line-height:1.45;color:#111;white-space:pre-wrap;overflow-wrap:anywhere;}</style><body>${esc(txt)}</body>`;
  return htmlToPdfBytes(html, { title: baseOf(name) });
}

async function markdownToPdf(bytes, name) {
  const { marked } = await import('marked');
  const body = marked.parse(decodeText(bytes), { gfm: true, breaks: false });
  return htmlToPdfBytes(`<!doctype html><meta charset="utf-8"><style>${DOC_CSS}</style><body>${body}</body>`, { title: baseOf(name) });
}

function cleanHtml(html) {
  // Skripte und Ereignisattribute entfernen (werden im Rahmen ohnehin nicht ausgeführt)
  return html.replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

export async function htmlToPdf(html, opts = {}) {
  return htmlToPdfBytes(cleanHtml(String(html)), opts);
}

async function htmlFileToPdf(bytes, name) {
  let html = cleanHtml(decodeText(bytes));
  const hasStyle = /<style|style=|<link[^>]+stylesheet/i.test(html);
  if (!hasStyle) html = html.replace(/<head[^>]*>/i, (m) => `${m}<style>${DOC_CSS}</style>`) || html;
  if (!hasStyle && !/<head/i.test(html)) html = `<style>${DOC_CSS}</style>` + html;
  return htmlToPdfBytes(html, { title: baseOf(name), viewportWidth: 794 });
}

// ---------- Word (DOCX) ----------
async function docxToPdf(bytes, name) {
  const docx = await import('docx-preview');
  progress('Word-Dokument wird gesetzt …');
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff"><div id="styles"></div><div id="root"></div></body></html>';
  return withFrame(html, 1400, async (doc, win) => {
    const root = doc.getElementById('root');
    await docx.renderAsync(toU8(bytes), root, doc.getElementById('styles'), {
      className: 'docx', inWrapper: false, ignoreWidth: false, ignoreHeight: false, ignoreFonts: true, breakPages: true, ignoreLastRenderedPageBreak: true,
      experimental: true, trimXmlDeclaration: true, useBase64URL: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderComments: false, debug: false,
    });
    // „Keinen Abstand zwischen Absätzen gleicher Formatvorlage“ (contextualSpacing) nachbilden
    try {
      const zip = await JSZip.loadAsync(toU8(bytes));
      const stylesXml = zip.file('word/styles.xml') ? await zip.file('word/styles.xml').async('string') : '';
      const ctxStyles = new Set();
      for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
        if (/<w:contextualSpacing(?!\s+w:val="(0|false)")/.test(m[2])) ctxStyles.add('docx_' + m[1].replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase());
      }
      if (ctxStyles.size) {
        for (const p of root.querySelectorAll('p')) {
          const cls = [...p.classList].find((c) => ctxStyles.has(c));
          const next = p.nextElementSibling;
          if (cls && next && next.tagName === 'P' && next.classList.contains(cls)) { p.style.marginBottom = '0'; next.style.marginTop = '0'; }
        }
      }
    } catch (_) { /* nur Feinschliff */ }
    const extra = doc.createElement('style');
    extra.textContent = 'section.docx{box-shadow:none!important;margin:0 0 40px 0!important;overflow:visible!important;} .docx-wrapper{background:#fff!important;padding:0!important;}';
    doc.head.append(extra);
    const sections = [...root.querySelectorAll('section.docx')];
    if (!sections.length) throw new UserError('Das Word-Dokument enthält keine darstellbaren Inhalte.');
    const flows = [];
    for (const sec of sections) {
      const cs = win.getComputedStyle(sec);
      const wPx = parseFloat(cs.width) || 794;
      const article = sec.querySelector(':scope > article') || sec;
      const header = sec.querySelector(':scope > header');
      const footer = sec.querySelector(':scope > footer');
      flows.push({ sec, cs, wPx, hPx: parseFloat(cs.minHeight) || 0, pt: parseFloat(cs.paddingTop), pb: parseFloat(cs.paddingBottom), pl: cs.paddingLeft, pr: cs.paddingRight, article, header, footer });
    }
    // Kopf- und Fußzeilen aus dem Fluss nehmen, sie werden auf jeder Seite wiederholt
    for (const f of flows) {
      for (const hf of [f.header, f.footer]) if (hf) { hf.style.position = 'absolute'; hf.style.left = f.pl; hf.style.right = f.pr; hf.style.top = '0'; hf.style.margin = '0'; }
      f.sec.style.position = 'relative';
      f.sec.style.minHeight = '0';
    }
    await new Promise((r) => setTimeout(r, 50));
    const out = [];
    for (const f of flows) {
      const k = 0.75;
      const pageW = f.wPx * k;
      const pageH = (f.hPx > 0 ? f.hPx : 1123) * k;
      const pt = f.pt, pb = f.pb;
      const secBox = f.sec.getBoundingClientRect();
      const art = f.article.getBoundingClientRect();
      const repeat = [];
      if (f.header && f.header.textContent.trim() + f.header.querySelectorAll('img,svg').length) repeat.push({ el: f.header, at: 'top', offset: Math.max(18, pt * k * 0.45) });
      if (f.footer && f.footer.textContent.trim() + f.footer.querySelectorAll('img,svg').length) repeat.push({ el: f.footer, at: 'bottom', offset: Math.max(18, pb * k * 0.45) });
      out.push({ el: f.sec, pageW, pageH: pageH > 100 ? pageH : 841.89, k, left: 0, top: pt * k, bottom: pb * k, startY: art.top, endY: Math.max(art.bottom, art.top + 1), skipBox: f.sec, repeat, _sec: secBox });
    }
    // Seitenhöhe aus den Dokumenteinstellungen übernehmen
    return flowsToPdf(doc, win, out, { title: baseOf(name), onProgress: (n) => progress(`Seite ${n} wird erstellt …`) });
  });
}

// ---------- Excel ----------
const THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99', '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];
function tint(hex, t) {
  if (!t) return hex;
  const c = [0, 2, 4].map((i) => parseInt(hex.substr(i, 2), 16));
  const r = c.map((v) => Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t));
  return r.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}
function xColor(c) {
  if (!c) return null;
  if (c.argb) { const a = c.argb.length === 8 ? c.argb.slice(2) : c.argb; return '#' + a; }
  if (c.theme !== undefined) return '#' + tint(THEME[c.theme] || '000000', c.tint);
  if (c.indexed !== undefined) return c.indexed === 64 || c.indexed === 65 ? null : '#' + (INDEXED[c.indexed] || '000000');
  return null;
}
const BORDER = { thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', dotted: '1px dotted', double: '3px double', mediumDashed: '2px dashed', dashDot: '1px dashed', mediumDashDot: '2px dashed', dashDotDot: '1px dotted', slantDashDot: '2px dashed' };
const COMMA_DECIMAL = (1.5).toLocaleString().includes(',');

export function sheetHtml(XLSX, ws, xws) {
  if (!ws || !ws['!ref']) return null;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const styled = (r, c) => { if (!xws) return false; const cell = xws.findCell(r + 1, c + 1); if (!cell) return false; const s = cell.style || {}; return !!((s.fill && s.fill.type === 'pattern' && s.fill.pattern !== 'none' && xColor(s.fill.fgColor)) || (s.border && Object.values(s.border).some((b) => b && b.style))); };
  // Benutzten Bereich bestimmen (leere Ränder abschneiden)
  let maxR = range.s.r, maxC = range.s.c, minR = range.e.r, minC = range.e.c, any = false;
  for (let r = range.s.r; r <= range.e.r; r++) for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if ((cell && cell.v !== undefined && cell.v !== null && String(cell.w ?? cell.v) !== '') || styled(r, c)) { any = true; maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); minR = Math.min(minR, r); minC = Math.min(minC, c); }
  }
  if (!any) return null;
  for (const m of ws['!merges'] || []) { if (m.s.r <= maxR && m.s.c <= maxC) { maxR = Math.max(maxR, m.e.r); maxC = Math.max(maxC, m.e.c); } }
  minR = Math.min(minR, range.s.r === 0 ? 0 : minR); minC = Math.min(minC, range.s.c === 0 ? 0 : minC);
  minR = Math.max(0, Math.min(minR, 0)); minC = Math.max(0, Math.min(minC, 0));
  const merges = new Map(); const covered = new Set();
  for (const m of ws['!merges'] || []) {
    merges.set(`${m.s.r},${m.s.c}`, m);
    for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(`${r},${c}`);
  }
  const cols = ws['!cols'] || [];
  const rowsMeta = ws['!rows'] || [];
  let widthPx = 0;
  const colW = [];
  for (let c = minC; c <= maxC; c++) {
    let w = 64;
    const xc = xws && xws.getColumn(c + 1);
    if (xc && xc.hidden) w = 0;
    else if (xc && xc.width) w = Math.round(xc.width * 7 + 5);
    else if (cols[c] && (cols[c].wpx || cols[c].wch)) w = cols[c].wpx || Math.round(cols[c].wch * 7 + 5);
    if (cols[c] && cols[c].hidden) w = 0;
    colW.push(w); widthPx += w;
  }
  const out = [`<table class="sheet" style="width:${widthPx}px"><colgroup>${colW.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`];
  for (let r = minR; r <= maxR; r++) {
    const xr = xws && xws.getRow(r + 1);
    if ((xr && xr.hidden) || (rowsMeta[r] && rowsMeta[r].hidden)) continue;
    const hpt = (xr && xr.height) || (rowsMeta[r] && rowsMeta[r].hpt) || 15;
    out.push(`<tr style="height:${(hpt * 4) / 3}px">`);
    for (let c = minC; c <= maxC; c++) {
      if (covered.has(`${r},${c}`)) continue;
      if (colW[c - minC] === 0) continue;
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      const m = merges.get(`${r},${c}`);
      const span = m ? ` colspan="${m.e.c - m.s.c + 1}" rowspan="${m.e.r - m.s.r + 1}"` : '';
      const css = [];
      let text = cell ? (cell.w !== undefined ? cell.w : cell.v !== undefined && cell.v !== null ? String(cell.v) : '') : '';
      if (cell && cell.t === 'e') text = cell.w || '#FEHLER';
      if (cell && cell.t === 'n' && COMMA_DECIMAL && !/[dmyhs]/i.test(String(cell.z || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''))) text = text.replace(/[.,]/g, (ch) => (ch === '.' ? ',' : '.'));
      let align = cell && (cell.t === 'n' || cell.t === 'd') ? 'right' : cell && cell.t === 'b' ? 'center' : 'left';
      let wrap = false;
      const xc = xws && xws.findCell(r + 1, c + 1);
      if (xc && xc.style) {
        const s = xc.style;
        if (s.font) {
          if (s.font.bold) css.push('font-weight:700');
          if (s.font.italic) css.push('font-style:italic');
          if (s.font.underline) css.push('text-decoration:underline');
          if (s.font.strike) css.push('text-decoration:line-through');
          if (s.font.size) css.push(`font-size:${s.font.size}pt`);
          if (s.font.name) css.push(`font-family:'${String(s.font.name).replace(/['"<>]/g, '')}'`);
          const fc = xColor(s.font.color); if (fc) css.push(`color:${fc}`);
        }
        if (s.fill && s.fill.type === 'pattern' && s.fill.pattern && s.fill.pattern !== 'none') { const bc = xColor(s.fill.fgColor) || xColor(s.fill.bgColor); if (bc) css.push(`background:${bc}`); }
        if (s.fill && s.fill.type === 'gradient' && s.fill.stops && s.fill.stops[0]) { const bc = xColor(s.fill.stops[0].color); if (bc) css.push(`background:${bc}`); }
        if (s.alignment) {
          const ha = s.alignment.horizontal;
          if (ha === 'center' || ha === 'centerContinuous') align = 'center'; else if (ha === 'right') align = 'right'; else if (ha === 'left') align = 'left'; else if (ha === 'justify' || ha === 'distributed') align = 'justify';
          const va = s.alignment.vertical; css.push(`vertical-align:${va === 'top' ? 'top' : va === 'middle' || va === 'center' ? 'middle' : 'bottom'}`);
          if (s.alignment.wrapText) wrap = true;
          if (s.alignment.indent) css.push(`padding-left:${3 + s.alignment.indent * 9}px`);
        }
        if (s.border) for (const [side, prop] of [['top', 'border-top'], ['right', 'border-right'], ['bottom', 'border-bottom'], ['left', 'border-left']]) {
          const b = s.border[side];
          if (b && b.style) css.push(`${prop}:${BORDER[b.style] || '1px solid'} ${xColor(b.color) || '#000'}`);
        }
      }
      css.push(`text-align:${align}`);
      if (wrap) css.push('white-space:pre-wrap'); else css.push('white-space:pre');
      out.push(`<td${span} style="${css.join(';')}">${esc(text)}</td>`);
    }
    out.push('</tr>');
  }
  out.push('</table>');
  return { html: out.join(''), widthPx };
}

const SHEET_CSS = `
body { margin: 0; font-family: "Calibri", sans-serif; font-size: 11pt; color: #000; }
.page { break-after: page; }
.title { font: 700 10pt "Liberation Sans", sans-serif; color: #475569; margin: 0 0 6px; letter-spacing: .02em; }
table.sheet { border-collapse: collapse; table-layout: fixed; }
table.sheet td { padding: 1px 3px; overflow: hidden; vertical-align: bottom; line-height: 1.2; }
table.sheet tr { break-inside: avoid; }
`;

async function sheetToPdf(bytes, name) {
  const XLSX = await import('xlsx');
  const e = extOf(name);
  progress('Tabelle wird gelesen …');
  let wb;
  if (e === 'csv' || e === 'tsv') {
    const txt = decodeText(bytes);
    const sep = e === 'tsv' ? '\t' : (() => { const line = txt.split(/\r?\n/, 1)[0]; const counts = [';', ',', '\t', '|'].map((s) => [s, line.split(s).length]); counts.sort((a, b) => b[1] - a[1]); return counts[0][0]; })();
    wb = XLSX.read(txt, { type: 'string', FS: sep, raw: false, cellDates: true });
  } else {
    try { wb = XLSX.read(toU8(bytes), { type: 'array', cellDates: true, cellNF: true, cellStyles: true }); } catch (err) { throw new UserError(`Die Tabelle konnte nicht gelesen werden (${err.message}).`); }
  }
  let xwb = null;
  if (/^(xlsx|xlsm)$/.test(e)) {
    try { const ExcelJS = (await import('exceljs')).default; xwb = new ExcelJS.Workbook(); await xwb.xlsx.load(toU8(bytes).slice().buffer); } catch (err) { console.warn('Excel-Formate konnten nicht gelesen werden:', err); xwb = null; }
  }
  const sheets = [];
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    if (wb.Workbook && wb.Workbook.Sheets) { const meta = wb.Workbook.Sheets.find((s) => s.name === sn); if (meta && meta.Hidden) continue; }
    const xws = xwb ? xwb.getWorksheet(sn) : null;
    const r = sheetHtml(XLSX, ws, xws);
    if (r) sheets.push({ name: sn, ...r, landscape: xws && xws.pageSetup && xws.pageSetup.orientation === 'landscape' });
  }
  if (!sheets.length) throw new UserError('Die Tabelle ist leer.');
  const multi = sheets.length > 1;
  const html = `<!doctype html><meta charset="utf-8"><style>${SHEET_CSS}</style><body>${sheets.map((s, i) => `<div class="page" id="s${i}">${multi ? `<div class="title">${esc(s.name)}</div>` : ''}${s.html}</div>`).join('')}</body>`;
  const maxW = Math.max(...sheets.map((s) => s.widthPx));
  return withFrame(html, Math.max(1100, maxW + 40), async (doc, win) => {
    const flows = sheets.map((s, i) => {
      const portraitW = PAGE_SIZES.A4[0] - 2 * 36;
      const landscape = s.landscape || s.widthPx * 0.75 > portraitW;
      const [pw, ph] = landscape ? [PAGE_SIZES.A4[1], PAGE_SIZES.A4[0]] : PAGE_SIZES.A4;
      const content = pw - 2 * 36;
      const k = Math.min(0.75, content / Math.max(1, s.widthPx));
      const el = doc.getElementById('s' + i);
      return { el, pageW: pw, pageH: ph, k: Math.max(k, 0.2), left: 36, top: 36, bottom: 36 };
    });
    return flowsToPdf(doc, win, flows, { title: baseOf(name), onProgress: (n) => progress(`Seite ${n} wird erstellt …`) });
  });
}

// ---------- PowerPoint (PPTX) ----------
async function pptxToPdf(bytes, name) {
  const { pptxToHtml, paintCrops } = await import('./pptx.js');
  progress('Präsentation wird gelesen …');
  const deck = await pptxToHtml(toU8(bytes));
  if (!deck.slides.length) throw new UserError('Die Präsentation enthält keine (sichtbaren) Folien.');
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:"Calibri",sans-serif;} .slide{position:relative;width:${deck.width}px;height:${deck.height}px;overflow:hidden;margin:0 0 40px 0;background:#fff;} .slide *{box-sizing:border-box;}</style><body>${deck.slides.map((s) => `<div class="slide">${s}</div>`).join('')}</body>`;
  return withFrame(html, deck.width + 20, async (doc, win) => {
    await paintCrops(doc);
    const pageW = deck.width * 0.75, pageH = deck.height * 0.75;
    const flows = [...doc.querySelectorAll('.slide')].map((el) => ({ el, pageW, pageH, k: 0.75, left: 0, top: 0, bottom: 0, fixed: true, skipBox: el }));
    return flowsToPdf(doc, win, flows, { title: baseOf(name), onProgress: (n) => progress(`Folie ${n} wird erstellt …`) });
  });
}

// ---------- EPUB ----------
async function epubToPdf(bytes, name) {
  const zip = await JSZip.loadAsync(toU8(bytes));
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = container && (/full-path="([^"]+)"/.exec(container) || [])[1];
  if (!opfPath || !zip.file(opfPath)) throw new UserError('Das E-Book ist beschädigt (keine Inhaltsangabe gefunden).');
  const opf = new DOMParser().parseFromString(await zip.file(opfPath).async('string'), 'application/xml');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const resolve = (base, rel) => { const parts = (base + rel).split('/'); const out = []; for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); } return decodeURIComponent(out.join('/')); };
  const manifest = {};
  for (const it of opf.getElementsByTagName('item')) manifest[it.getAttribute('id')] = { href: resolve(dir, it.getAttribute('href')), type: it.getAttribute('media-type') };
  const spine = [...opf.getElementsByTagName('itemref')].map((r) => manifest[r.getAttribute('idref')]).filter(Boolean);
  const title = opf.getElementsByTagName('dc:title')[0]?.textContent || baseOf(name);
  const mime = (p) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[extOf(p)] || 'application/octet-stream');
  const dataUrl = async (path) => { const f = zip.file(path); if (!f) return null; const b64 = await f.async('base64'); return `data:${mime(path)};base64,${b64}`; };
  const css = [];
  for (const m of Object.values(manifest)) if (m.type === 'text/css' && zip.file(m.href)) css.push((await zip.file(m.href).async('string')).replace(/@import[^;]+;/g, '').replace(/url\([^)]*\)/g, 'none'));
  const parts = [];
  for (let i = 0; i < spine.length; i++) {
    const item = spine[i];
    if (!/html|xml/.test(item.type || '') || !zip.file(item.href)) continue;
    progress(`E-Book wird gelesen (${i + 1}/${spine.length}) …`);
    const src = await zip.file(item.href).async('string');
    const d = new DOMParser().parseFromString(src, /xhtml|xml/.test(item.type) ? 'application/xhtml+xml' : 'text/html');
    const body = d.body || d.getElementsByTagName('body')[0];
    if (!body) continue;
    const base = item.href.includes('/') ? item.href.slice(0, item.href.lastIndexOf('/') + 1) : '';
    for (const img of [...body.querySelectorAll('img, image')]) {
      const attr = img.tagName.toLowerCase() === 'image' ? (img.getAttribute('xlink:href') || img.getAttribute('href')) : img.getAttribute('src');
      if (!attr || /^data:/.test(attr)) continue;
      const u = await dataUrl(resolve(base, attr.split('#')[0]));
      if (!u) continue;
      if (img.tagName.toLowerCase() === 'image') { img.setAttribute('href', u); img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u); } else img.setAttribute('src', u);
    }
    for (const s of [...body.querySelectorAll('script')]) s.remove();
    parts.push(`<section class="chapter">${new XMLSerializer().serializeToString(body).replace(/^<body[^>]*>|<\/body>$/g, '')}</section>`);
  }
  if (!parts.length) throw new UserError('Das E-Book enthält keine lesbaren Kapitel.');
  const html = `<!doctype html><meta charset="utf-8"><style>${DOC_CSS} body{font-family:"Liberation Serif",serif;font-size:11.5pt;line-height:1.55;text-align:justify;} .chapter{break-before:page;} .chapter:first-child{break-before:auto;} img,svg{max-width:100%;height:auto;} </style><style>${css.join('\n')}</style><body>${parts.join('')}</body>`;
  return htmlToPdfBytes(html, { pageSize: 'A5', margin: [48, 42, 52, 42], title, scale: 0.92, onProgress: (n) => progress(`Seite ${n} wird erstellt …`) });
}

// ---------- iWork und alte Formate ----------
async function iworkToPdf(bytes, name) {
  try {
    const zip = await JSZip.loadAsync(toU8(bytes));
    const pdf = Object.keys(zip.files).find((p) => /preview\.pdf$/i.test(p));
    if (pdf) return { data: await zip.file(pdf).async('uint8array'), engine: 'Vorschau aus der Datei' };
  } catch (_) { /* kein ZIP */ }
  throw new UserError(`„${name}“ kann im Browser nicht umgewandelt werden. Bitte die Datei in ${{ pages: 'Pages', numbers: 'Numbers', key: 'Keynote' }[extOf(name)]} über „Ablage > Exportieren > PDF“ oder als Word/Excel/PowerPoint exportieren.`);
}

const LEGACY = {
  doc: 'Word 97–2003 (.doc)', ppt: 'PowerPoint 97–2003 (.ppt)', pps: 'PowerPoint 97–2003 (.pps)', odt: 'OpenDocument Text (.odt)', odp: 'OpenDocument Präsentation (.odp)', rtf: 'RTF', wpd: 'WordPerfect',
};

/** file: { name, data } → { data, engine } */
export async function documentToPdf(file) {
  const name = file.name || 'Dokument';
  const e = extOf(name);
  const data = toU8(file.data);
  try {
    if (/^(docx|docm|dotx)$/.test(e)) return { data: await docxToPdf(data, name), engine: 'Word-Konverter' };
    if (/^(xlsx|xlsm|xls|ods|csv|tsv)$/.test(e)) return { data: await sheetToPdf(data, name), engine: 'Tabellen-Konverter' };
    if (/^(pptx|ppsx)$/.test(e)) return { data: await pptxToPdf(data, name), engine: 'Präsentations-Konverter' };
    if (/^(html|htm|xhtml)$/.test(e)) return { data: await htmlFileToPdf(data, name), engine: 'HTML-Konverter' };
    if (e === 'md') return { data: await markdownToPdf(data, name), engine: 'Markdown-Konverter' };
    if (/^(txt|log|json|xml|eml)$/.test(e)) return { data: await textToPdf(data, name), engine: 'Text-Konverter' };
    if (e === 'epub') return { data: await epubToPdf(data, name), engine: 'E-Book-Konverter' };
    if (/^(pages|numbers|key)$/.test(e)) return iworkToPdf(data, name);
  } catch (err) {
    if (err instanceof UserError) throw err;
    console.error(err);
    throw new UserError(`„${name}“ konnte nicht umgewandelt werden: ${err.message || err}`);
  }
  if (LEGACY[e]) throw new UserError(`Das Format ${LEGACY[e]} kann im Browser nicht umgewandelt werden. Bitte die Datei in Word, PowerPoint oder LibreOffice öffnen und als ${/^(ppt|pps|odp)$/.test(e) ? '.pptx' : '.docx'} oder direkt als PDF speichern.`);
  throw new UserError(`Das Dateiformat .${e} wird nicht unterstützt.`);
}
