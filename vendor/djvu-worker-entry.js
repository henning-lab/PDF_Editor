// Web Worker: dekodiert DjVu-Seiten (djvu.js, GPL v2) und bereitet sie für die PDF-Erstellung auf.
import DjVuDocument from './djvujs/src/DjVuDocument';
import { encodeG4 } from './ccitt-g4.js';

let doc = null;

// Bild klassifizieren: 'bitonal' (nur Schwarz/Weiß), 'gray' oder 'color'
function classify(data) {
  let colorPx = 0, nonBinary = 0;
  const n = data.length / 4;
  const step = n > 4e6 ? 3 : 1; // bei sehr großen Seiten Stichprobe
  let sampled = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sampled++;
    if (Math.abs(r - g) > 14 || Math.abs(g - b) > 14 || Math.abs(r - b) > 14) colorPx++;
    else if (r > 12 && r < 243) nonBinary++;
  }
  if (colorPx / sampled > 0.002) return 'color';
  if (nonBinary / sampled < 0.0005) return 'bitonal';
  return 'gray';
}

async function deflate(u8) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([u8]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function packGray(data, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  return out;
}

function g4FromImageData(data, w, h) {
  const row = new Uint8Array(w);
  let rows = [new Uint8Array(w), new Uint8Array(w)], k = 0;
  return encodeG4(w, h, (y) => {
    const r = rows[k ^= 1];
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) r[x] = data[i] + data[i + 1] + data[i + 2] <= 382 ? 1 : 0;
    return r;
  });
}

// Für „Kleinere Datei“: Farb- und Graustufenseiten auf max. 200 dpi verkleinern
async function maybeDownscale(imageData, dpi, quality) {
  if (quality !== 'small' || dpi <= 210) return { img: imageData, dpi };
  const f = 200 / dpi;
  const w = Math.max(1, Math.round(imageData.width * f)), h = Math.max(1, Math.round(imageData.height * f));
  const src = new OffscreenCanvas(imageData.width, imageData.height);
  src.getContext('2d').putImageData(imageData, 0, 0);
  const dst = new OffscreenCanvas(w, h);
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return { img: ctx.getImageData(0, 0, w, h), dpi: 200 };
}

async function encodeJpeg(imageData, quality) {
  const c = new OffscreenCanvas(imageData.width, imageData.height);
  c.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

function resolveContents(items) {
  if (!items) return [];
  return items.map((b) => {
    let page = null;
    try { page = doc.getPageNumberByUrl(b.url); } catch (_) {}
    if (!page) { const m = /^#?(\d+)$/.exec(b.url || ''); if (m) page = +m[1]; }
    return { title: b.description || '', page, children: resolveContents(b.children) };
  });
}

const handlers = {
  async open({ buffer, baseUrl }) {
    doc = new DjVuDocument(buffer, { baseUrl: baseUrl || null });
    if (!doc.isBundled()) doc = await doc.bundle();
    const sizes = doc.getPagesSizes();
    let contents = [];
    try { contents = resolveContents(doc.getContents()); } catch (_) {}
    return { pages: doc.getPagesQuantity(), sizes, contents };
  },

  async page({ n, quality = 'high' }) {
    const page = await doc.getPage(n);
    const dpi = page.getDpi() || 300;
    const rotation = page.getRotation() || 0;
    const img = page.getImageData(false); // ungedreht, Drehung kommt als /Rotate ins PDF
    const w = img.width, h = img.height;
    const kind = classify(img.data);
    let image;
    if (kind === 'bitonal') {
      // Verlustfrei mit CCITT G4: gestochen scharf und klein
      image = { type: 'ccitt', width: w, height: h, data: g4FromImageData(img.data, w, h) };
    } else {
      const { img: im2 } = await maybeDownscale(img, dpi, quality);
      if (kind === 'gray') {
        const flate = await deflate(packGray(im2.data, im2.width, im2.height));
        const jpg = await encodeJpeg(im2, quality === 'small' ? 0.72 : 0.9);
        image = flate.length <= jpg.length * 1.6 && quality !== 'small' ? { type: 'flate', bpc: 8, width: im2.width, height: im2.height, data: flate } : { type: 'jpeg', data: jpg };
      } else {
        image = { type: 'jpeg', data: await encodeJpeg(im2, quality === 'small' ? 0.72 : 0.9) };
      }
    }
    // Textebene (Koordinaten in Pixel, Ursprung oben links, bezogen auf die ungedrehte Seite)
    let zones = null;
    try { zones = page.getNormalizedTextZones(); } catch (_) {}
    return { width: w, height: h, dpi, rotation, kind, image, zones: zones || [] };
  },
};

self.onmessage = async ({ data }) => {
  try {
    const r = await handlers[data.cmd](data);
    const transfer = r && r.image ? [r.image.data.buffer] : [];
    self.postMessage({ id: data.id, ok: true, result: r }, transfer);
  } catch (e) {
    self.postMessage({ id: data.id, ok: false, error: String((e && (e.message || e.code)) || e) });
  }
};
