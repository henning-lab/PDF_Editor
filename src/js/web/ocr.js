// Texterkennung (OCR) mit Tesseract im Browser: legt eine unsichtbare, durchsuchbare Textebene über gescannte Seiten.
import { emitProgress } from '../native.js';
import { openPdf, renderPage } from '../pdf.js';

const { PDFDocument, degrees } = window.PDFLib;
const asset = (p) => new URL(p, document.baseURI).href;

export async function ocrPdf(pdfBytes, opts = {}) {
  const langs = (opts.langs && opts.langs.length ? opts.langs : ['deu', 'eng']);
  const dpi = opts.dpi || 300;
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const todo = pages.map((_, i) => i).filter((i) => !(opts.skipPages || []).includes(i));
  if (!todo.length) return { data: await doc.save(), processed: 0 };

  emitProgress({ text: 'Texterkennung wird geladen …', value: null });
  const Tesseract = (await import('tesseract.js')).default;
  const view = await openPdf(pdfBytes);
  const worker = await Tesseract.createWorker(langs, 1, {
    workerPath: asset('vendor/tesseract/worker.min.js'),
    corePath: asset('vendor/tesseract/core/'),
    langPath: asset('vendor/tesseract/lang/'),
    gzip: true,
    workerBlobURL: false,
  });
  try {
    let n = 0;
    for (const i of todo) {
      emitProgress({ text: `Texterkennung Seite ${i + 1} von ${pages.length}`, value: n / todo.length });
      // Große Seiten begrenzen, damit auch schwächere Geräte nicht aussteigen
      const page = await view.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      let scale = dpi / 72;
      const maxPx = 26e6;
      if (base.width * base.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (base.width * base.height));
      const { canvas } = await renderPage(view, i, scale, { annotationMode: 0 });
      const res = await Promise.race([
        worker.recognize(canvas, { pdfTitle: 'OCR', pdfTextOnly: true }, { pdf: true, text: false, blocks: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Texterkennung auf Seite ${i + 1} hat zu lange gedauert`)), 300000)),
      ]);
      canvas.width = canvas.height = 0;
      const textPdf = await PDFDocument.load(new Uint8Array(res.data.pdf));
      const [emb] = await doc.embedPdf(textPdf, [0]);
      const p = pages[i];
      const crop = p.getCropBox();
      const rot = ((p.getRotation().angle % 360) + 360) % 360;
      // Darstellung (gerendert) -> Benutzerkoordinaten
      if (rot === 0) p.drawPage(emb, { x: crop.x, y: crop.y, width: crop.width, height: crop.height });
      else if (rot === 90) p.drawPage(emb, { x: crop.x + crop.width, y: crop.y, width: crop.height, height: crop.width, rotate: degrees(90) });
      else if (rot === 180) p.drawPage(emb, { x: crop.x + crop.width, y: crop.y + crop.height, width: crop.width, height: crop.height, rotate: degrees(180) });
      else p.drawPage(emb, { x: crop.x, y: crop.y + crop.height, width: crop.height, height: crop.width, rotate: degrees(270) });
      n++;
    }
    emitProgress({ text: 'Speichere Ergebnis', value: 1 });
    return { data: await doc.save(), processed: n };
  } finally {
    await worker.terminate();
  }
}
