// DjVu -> PDF: Seiten verlustarm übernehmen, Textebene und Inhaltsverzeichnis erhalten
import { PDFDocument, native, getFont, baseName, UserError } from './core.js';

const L = window.PDFLib;

function djvuWorker() {
  const w = new Worker(new URL('workers/djvu.js', document.baseURI));
  let seq = 0;
  const pending = new Map();
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
  };
  w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'DjVu Fehler')); pending.clear(); };
  const call = (msg, transfer) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id }, transfer || []);
  });
  return { call, terminate: () => w.terminate() };
}

function addOutline(doc, items, pageRefs) {
  const ctx = doc.context;
  const { PDFName, PDFNumber, PDFHexString, PDFNull } = L;
  const valid = (list) => list.filter((it) => it.title && (it.page || (it.children && it.children.length)));
  const build = (list, parentRef) => {
    const entries = valid(list);
    const refs = entries.map(() => ctx.nextRef());
    let total = 0;
    entries.forEach((it, i) => {
      const dict = ctx.obj({});
      dict.set(PDFName.of('Title'), PDFHexString.fromText(it.title.trim()));
      dict.set(PDFName.of('Parent'), parentRef);
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      const target = it.page ? pageRefs[Math.min(pageRefs.length, Math.max(1, it.page)) - 1] : null;
      if (target) dict.set(PDFName.of('Dest'), ctx.obj([target, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]));
      const child = build(it.children || [], refs[i]);
      if (child.first) {
        dict.set(PDFName.of('First'), child.first);
        dict.set(PDFName.of('Last'), child.last);
        dict.set(PDFName.of('Count'), PDFNumber.of(-child.count)); // eingeklappt
      }
      ctx.assign(refs[i], dict);
      total += 1;
    });
    return { first: refs[0], last: refs[refs.length - 1], count: total };
  };
  const rootRef = ctx.nextRef();
  const r = build(items, rootRef);
  if (!r.first) return;
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: r.first, Last: r.last, Count: r.count }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/**
 * opts: { quality: 'high' | 'small', textLayer: true, ocr: false, outline: true }
 */
export async function djvuToPdf(file, opts = {}, progress = () => {}) {
  const w = djvuWorker();
  try {
    const baseUrl = null; // im Browser gibt es keinen Zugriff auf Nachbardateien
    progress(`„${file.name}“ wird geöffnet …`);
    let info;
    try {
      info = await w.call({ cmd: 'open', buffer: file.data.slice().buffer, baseUrl });
    } catch (e) {
      throw new UserError(`„${file.name}“ konnte nicht gelesen werden. Mehrteilige DjVu-Dokumente (index.djvu mit Einzeldateien) lassen sich im Browser nicht öffnen, bitte eine gebündelte .djvu-Datei verwenden. (${e.message})`);
    }
    if (!info.pages) throw new UserError(`„${file.name}“ enthält keine Seiten.`);
    const doc = await PDFDocument.create();
    doc.setTitle(baseName(file.name));
    doc.setProducer('PDF Editor');
    doc.setCreator('PDF Editor (DjVu Konvertierung)');
    const pageRefs = [];
    const pagesWithoutText = [];
    // Schrift für die unsichtbare Textebene erst bei Bedarf laden
    // Eingebettete Unicode-Schrift (Teilmenge): funktioniert für alle Sprachen und bleibt bei der Optimierung erhalten
    let layerFont = null;
    const fontFor = async () => (layerFont = layerFont || await getFont(doc, 'Helvetica', { text: 'Ж' }));

    for (let n = 1; n <= info.pages; n++) {
      progress(`Seite ${n} von ${info.pages} wird umgewandelt …`, (n - 1) / info.pages);
      const pg = await w.call({ cmd: 'page', n, quality: opts.quality || 'high' });
      const dpi = pg.dpi > 0 ? pg.dpi : 300;
      // Unrotierte Seite in Punkt; Drehung über /Rotate
      const W = (pg.width * 72) / dpi, H = (pg.height * 72) / dpi;
      const page = doc.addPage([W, H]);
      if (pg.rotation) page.setRotation(L.degrees(pg.rotation));
      pageRefs.push(page.ref);
      let imgRef;
      if (pg.image.type === 'jpeg') {
        const img = await doc.embedJpg(pg.image.data);
        await img.embed();
        imgRef = img.ref;
      } else if (pg.image.type === 'ccitt') {
        const dict = { Type: 'XObject', Subtype: 'Image', Width: pg.image.width, Height: pg.image.height, ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'CCITTFaxDecode',
          DecodeParms: { K: -1, Columns: pg.image.width, Rows: pg.image.height, BlackIs1: false } };
        imgRef = doc.context.register(doc.context.stream(pg.image.data, dict));
      } else {
        const dict = { Type: 'XObject', Subtype: 'Image', Width: pg.image.width, Height: pg.image.height, ColorSpace: 'DeviceGray', BitsPerComponent: pg.image.bpc, Filter: 'FlateDecode' };
        imgRef = doc.context.register(doc.context.stream(pg.image.data, dict));
      }
      const xName = page.node.newXObject('Im', imgRef);
      page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(W, 0, 0, H, 0, 0), L.drawObject(xName), L.popGraphicsState());

      // Unsichtbare Textebene (durchsuchbar, kopierbar)
      const zones = (pg.zones || []).filter((z) => z.text && z.text.trim() && z.width > 0 && z.height > 0);
      if (opts.textLayer !== false && zones.length) {
        const s = 72 / dpi;
        const ops = [L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
        let currentFont = null;
        for (const z of zones) {
          const text = z.text.replace(/[\u0000-\u001f]/g, ' ').trim();
          if (!text) continue;
          const font = await fontFor(text);
          let encoded;
          try { encoded = font.encodeText(text); } catch (_) { continue; }
          const size = Math.max(1, z.height * s * 0.9);
          const natural = font.widthOfTextAtSize(text, size) || 1;
          const scale = Math.max(1, Math.min(1000, ((z.width * s) / natural) * 100));
          if (currentFont !== font) {
            const fName = page.node.newFontDictionary(font.name, font.ref);
            ops.push(L.setFontAndSize(fName, size));
            currentFont = font;
            currentFont._key = fName;
          } else ops.push(L.setFontAndSize(currentFont._key, size));
          ops.push(L.setCharacterSqueeze(scale));
          // DjVu-Zonen haben den Ursprung unten links (wie PDF); Grundlinie leicht über der Unterkante
          ops.push(L.setTextMatrix(1, 0, 0, 1, z.x * s, z.y * s + z.height * s * 0.2));
          // Leerzeichen nach jedem Wort, damit kopierter Text Wortabstände hat
          let spaced = encoded;
          try { spaced = font.encodeText(text + ' '); } catch (_) {}
          ops.push(L.showText(spaced));
        }
        ops.push(L.endText(), L.popGraphicsState());
        page.pushOperators(...ops);
      } else pagesWithoutText.push(n - 1);
    }
    if (opts.outline !== false && info.contents && info.contents.length) {
      try { addOutline(doc, info.contents, pageRefs); } catch (e) { console.warn('Inhaltsverzeichnis', e); }
    }
    progress('PDF wird gespeichert …');
    let data = await doc.save({ useObjectStreams: true });
    let ocrPages = 0;
    if (opts.ocr && pagesWithoutText.length) {
      const skip = [...Array(info.pages).keys()].filter((i) => !pagesWithoutText.includes(i));
      const r = await native.ocr(data, { langs: (opts.langs || 'deu+eng').split('+'), skipPages: skip, dpi: 300 });
      data = r.data;
      ocrPages = r.processed;
    }
    return { data, pages: info.pages, withText: info.pages - pagesWithoutText.length, ocrPages, bookmarks: (info.contents || []).length };
  } finally {
    w.terminate();
  }
}
