// Baut die statische Web-App nach docs/ (wird von GitHub Pages ausgeliefert).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const dev = process.argv.includes('--dev');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };

// ---------- App (ES-Module, nachladbare Teile) ----------
const common = {
  bundle: true, minify: !dev, sourcemap: dev, target: ['es2020', 'safari15', 'firefox115', 'chrome100'], logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  legalComments: 'none',
};
const app = await build({
  ...common,
  entryPoints: { app: path.join(root, 'src/js/app.js') },
  outdir: path.join(out, 'assets'),
  format: 'esm', splitting: true, metafile: true,
  entryNames: '[name]-[hash]', chunkNames: 'c-[hash]',
  external: ['../vendor/pdfjs/*', 'fs', 'path', 'crypto', 'stream', 'os', 'zlib', 'util', 'events', 'http', 'https', 'url', 'node:*'],
  alias: { 'pngjs/browser': path.join(root, 'vendor/stubs/pngjs.js'), buffer: nm('buffer/index.js') },
  inject: [path.join(root, 'vendor/stubs/buffer-global.js')],
});
const appFile = Object.keys(app.metafile.outputs).find((f) => /assets\/app-[^/]+\.js$/.test(f));

// ---------- Worker ----------
await build({
  ...common,
  entryPoints: { engine: path.join(root, 'src/workers/engine-worker.js') },
  outdir: path.join(out, 'workers'), format: 'esm',
  external: ['module', 'fs', 'path', 'url', 'crypto'],
  alias: { 'gs-wasm': nm('@okathira/ghostpdl-wasm/dist/gs.js'), 'qpdf-wasm': nm('@jspawn/qpdf-wasm/qpdf.js') },
});
await build({
  ...common,
  entryPoints: { djvu: path.join(root, 'vendor/djvu-worker-entry.js') },
  outdir: path.join(out, 'workers'), format: 'iife',
  alias: { 'pngjs/browser': path.join(root, 'vendor/stubs/pngjs.js') },
});

// ---------- Statische Dateien ----------
copy(nm('@okathira/ghostpdl-wasm/dist/gs.wasm'), path.join(out, 'wasm/gs.wasm'));
copy(nm('@jspawn/qpdf-wasm/qpdf.wasm'), path.join(out, 'wasm/qpdf.wasm'));
copy(nm('pdf-lib/dist/pdf-lib.min.js'), path.join(out, 'vendor/pdf-lib.min.js'));
copy(nm('@pdf-lib/fontkit/dist/fontkit.umd.min.js'), path.join(out, 'vendor/fontkit.umd.min.js'));
copy(nm('diff/dist/diff.min.js'), path.join(out, 'vendor/diff.min.js'));
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) copy(nm('pdfjs-dist/legacy/build', f), path.join(out, 'vendor/pdfjs/build', f));
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) copy(nm('pdfjs-dist', d), path.join(out, 'vendor/pdfjs', d));
// Texterkennung
copy(nm('tesseract.js/dist/worker.min.js'), path.join(out, 'vendor/tesseract/worker.min.js'));
for (const f of fs.readdirSync(nm('tesseract.js-core'))) {
  if (/-lstm\.wasm\.js$/.test(f)) copy(nm('tesseract.js-core', f), path.join(out, 'vendor/tesseract/core', f));
}
for (const l of ['deu', 'eng', 'fra', 'spa', 'ita']) copy(nm(`@tesseract.js-data/${l}/4.0.0/${l}.traineddata.gz`), path.join(out, `vendor/tesseract/lang/${l}.traineddata.gz`));
// Schriften
copy(path.join(root, 'src/fonts'), path.join(out, 'fonts'));
copy(path.join(root, 'src/styles.css'), path.join(out, 'styles.css'));
for (const f of ['favicon.svg', 'social.png']) if (fs.existsSync(path.join(root, 'src', f))) copy(path.join(root, 'src', f), path.join(out, f));

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8')
  .replace('%APP%', 'assets/' + path.basename(appFile))
  .replaceAll('%V%', version);
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

let total = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
walk(out);
console.log(`docs/ gebaut: ${(total / 1e6).toFixed(1)} MB, App ${path.basename(appFile)}`);
