// Browser-Schicht: alles, was in der Mac-App der Hauptprozess erledigt hat, läuft hier direkt im Browser.
// Schwere Teile (Ghostscript, OCR, Office-Bibliotheken, Signatur) werden erst bei Bedarf nachgeladen.

const asset = (p) => new URL(p, document.baseURI).href;
const toU8 = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d));

// ---------- Fortschritt ----------
const progressListeners = new Set();
export function emitProgress(p) { for (const cb of progressListeners) { try { cb(p); } catch (_) {} } }

// ---------- Ghostscript / qpdf ----------
const wasmModules = {};
function wasmModule(engine) {
  if (!wasmModules[engine]) {
    const url = asset(`wasm/${engine}.wasm`);
    wasmModules[engine] = (WebAssembly.compileStreaming
      ? WebAssembly.compileStreaming(fetch(url)).catch(() => fetch(url).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)))
      : fetch(url).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)))
      .catch((e) => { delete wasmModules[engine]; throw new Error(`Die Komponente „${engine}“ konnte nicht geladen werden. Bitte Internetverbindung prüfen und Seite neu laden. (${e.message})`); });
  }
  return wasmModules[engine];
}

async function engine(name, args, inFiles) {
  const wasm = await wasmModule(name);
  return new Promise((resolve) => {
    const w = new Worker(asset('workers/engine.js'), { type: 'module' });
    let done = false;
    const finish = (r) => { if (done) return; done = true; w.terminate(); resolve(r); };
    w.onmessage = ({ data }) => finish(data);
    w.onerror = (e) => finish({ code: 1, log: `Verarbeitung fehlgeschlagen: ${e.message || 'unbekannter Fehler'}`, outFiles: {} });
    w.postMessage({ engine: name, args, inFiles, wasm });
  });
}

// ---------- Dateien öffnen / speichern ----------
function openFiles(opts = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!opts.multiple;
    const exts = (opts.filters || []).flatMap((f) => f.extensions || []);
    if (exts.length) input.accept = exts.map((e) => '.' + e).join(',');
    input.style.display = 'none';
    document.body.append(input);
    let settled = false;
    const finish = async () => {
      if (settled) return; settled = true;
      const out = [];
      for (const f of input.files || []) out.push({ name: f.name, path: '', data: new Uint8Array(await f.arrayBuffer()) });
      input.remove();
      resolve(out);
    };
    input.addEventListener('change', finish);
    input.addEventListener('cancel', finish);
    input.click();
  });
}

const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', txt: 'text/plain;charset=utf-8', html: 'text/html;charset=utf-8',
  zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', p12: 'application/x-pkcs12', cer: 'application/x-x509-ca-cert',
};
const mimeOf = (name) => MIME[(/\.([^.]+)$/.exec(name) || [])[1]?.toLowerCase()] || 'application/octet-stream';

let lastUrl = null;
function saveFile(name, data) {
  const blob = new Blob([toU8(data)], { type: mimeOf(name) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  if (lastUrl) { const old = lastUrl; setTimeout(() => URL.revokeObjectURL(old), 60000); }
  lastUrl = url;
  return Promise.resolve(url);
}

async function saveFiles(files) {
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (_) { return null; }
  const written = [];
  for (const f of files) {
    const fh = await dir.getFileHandle(f.name, { create: true });
    const ws = await fh.createWritable();
    await ws.write(toU8(f.data));
    await ws.close();
    written.push(f.name);
  }
  return { dir: dir.name, files: written };
}

// ---------- Nachladbare Module ----------
const lazy = {
  convert: () => import('./web/convert.js'),
  ocr: () => import('./web/ocr.js'),
  builders: () => import('./web/builders.js'),
  images: () => import('./web/images.js'),
  sign: () => import('./web/sign.js'),
};
const call = (mod, fn) => async (...args) => (await lazy[mod]())[fn](...args);

export const native = {
  platform: 'web',
  canPickFolder: typeof window.showDirectoryPicker === 'function',
  engine,
  openFiles,
  saveFile,
  saveFiles,
  openPath: (url) => { window.open(url, '_blank', 'noopener'); },
  openExternal: (url) => { if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener'); },
  pathForFile: () => '',
  allowDir: async () => true,
  onProgress: (cb) => { progressListeners.add(cb); return () => progressListeners.delete(cb); },

  documentToPdf: call('convert', 'documentToPdf'),
  htmlToPdf: call('convert', 'htmlToPdf'),
  officeStatus: async () => ({ web: true }),
  heicToJpeg: call('images', 'heicToJpeg'),
  ocr: call('ocr', 'ocrPdf'),
  buildDocx: call('builders', 'buildDocx'),
  buildPptx: call('builders', 'buildPptx'),
  buildXlsx: call('builders', 'buildXlsx'),
  buildZip: call('builders', 'buildZip'),

  certs: {
    list: call('sign', 'certsList'),
    create: call('sign', 'certsCreate'),
    import: call('sign', 'certsImport'),
    remove: call('sign', 'certsRemove'),
    forget: async () => {},
    exportP12: call('sign', 'certsExportP12'),
    exportPublic: call('sign', 'certsExportPublic'),
    checkPassword: call('sign', 'certsCheckPassword'),
  },
  hasSignatures: call('sign', 'hasSignatures'),
  signPdf: call('sign', 'signPdf'),
  verifyPdf: call('sign', 'verifyPdf'),
};
