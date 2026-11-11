// Web Worker: führt Ghostscript oder qpdf (WebAssembly) aus, damit die Oberfläche nie einfriert.
import gsFactory from 'gs-wasm';
import qpdfFactory from 'qpdf-wasm';

self.onmessage = async ({ data }) => {
  const { engine, args, inFiles, wasm } = data;
  try {
    let log = '';
    const factory = engine === 'gs' ? gsFactory : qpdfFactory;
    const m = await factory({
      noInitialRun: true,
      print: (s) => { log += s + '\n'; },
      printErr: (s) => { log += s + '\n'; },
      instantiateWasm: (imports, cb) => {
        WebAssembly.instantiate(wasm, imports).then((inst) => cb(inst, wasm));
        return {};
      },
    });
    m.FS.mkdir('/work');
    m.FS.chdir('/work');
    const inputNames = new Set();
    for (const [name, bytes] of Object.entries(inFiles || {})) {
      m.FS.writeFile(name, bytes);
      inputNames.add(name);
    }
    let code = 0;
    // Ghostscript-WASM stürzt beim Banding (clist) ab: Seiten immer komplett im Speicher rendern
    const finalArgs = engine === 'gs' ? ['-dMaxBitmap=2000000000', '-dBufferSpace=100000000', ...args] : args;
    try {
      code = m.callMain(finalArgs);
    } catch (e) {
      code = typeof e.status === 'number' ? e.status : 1;
      if (typeof e.status !== 'number') log += String(e && e.message ? e.message : e) + '\n';
    }
    const outFiles = {};
    const transfer = [];
    for (const name of m.FS.readdir('/work')) {
      if (name === '.' || name === '..' || inputNames.has(name)) continue;
      const bytes = m.FS.readFile(name).slice();
      outFiles[name] = bytes;
      transfer.push(bytes.buffer);
    }
    self.postMessage({ code, log, outFiles }, transfer);
  } catch (e) {
    self.postMessage({ code: 1, log: String(e && e.stack ? e.stack : e), outFiles: {} });
  }
};
