// Testumgebung: startet einen lokalen Server für docs/, öffnet die App in Chromium (Playwright)
// und stellt den Testskripten window.testApi bereit (Dateien lesen/schreiben, Screenshots).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', wasm: 'application/wasm', svg: 'image/svg+xml', json: 'application/json', png: 'image/png', ttf: 'font/ttf', woff2: 'font/woff2', gz: 'application/gzip', pdf: 'application/pdf' };

export function startServer({ dir = path.join(root, 'docs'), outDir, port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__read') {
      const p = u.searchParams.get('p');
      const file = path.isAbsolute(p) ? p : path.join(root, 'tests/fixtures', p);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
    if (u.pathname === '/__write' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, path.basename(u.searchParams.get('n'))), Buffer.concat(chunks)); res.writeHead(200); res.end('ok'); });
      return;
    }
    if (u.pathname === '/__tsa' && req.method === 'POST') { // Weiterleitung an einen lokalen Test-Zeitstempeldienst
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try { const r = await fetch(process.env.TEST_TSA || 'http://127.0.0.1:8318/', { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: Buffer.concat(chunks) }); res.writeHead(r.status, { 'Content-Type': 'application/timestamp-reply' }); res.end(Buffer.from(await r.arrayBuffer())); }
        catch (e) { res.writeHead(502); res.end(String(e)); }
      });
      return;
    }
    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).slice(1)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

const SHIM = `window.testApi = {
  read: async (p) => { const r = await fetch('/__read?p=' + encodeURIComponent(p)); if (!r.ok) throw new Error('Fixture fehlt: ' + p); return new Uint8Array(await r.arrayBuffer()); },
  write: async (n, d) => { await fetch('/__write?n=' + encodeURIComponent(n), { method: 'POST', body: d }); return n; },
  shot: (n) => window.__shot(n),
  done: (r) => window.__done(JSON.stringify(r)),
};`;

/** Führt ein Testskript (Text) in der App aus und liefert dessen Bericht. */
export async function runInApp(script, { outDir, timeout = 900000, viewport = { width: 1400, height: 950 }, hash = '', quiet = false, isMobile = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, url } = await startServer({ outDir });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const logs = [];
  try {
    const ctx = await browser.newContext({ viewport, acceptDownloads: true, isMobile, hasTouch: isMobile, deviceScaleFactor: isMobile ? 2 : 1, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`.slice(0, 500)); });
    page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e.stack || e).slice(0, 800)));
    page.on('requestfailed', (r) => logs.push('[requestfailed] ' + r.url() + ' ' + (r.failure()?.errorText || '')));
    page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    await page.exposeFunction('__shot', async (n) => { await page.screenshot({ path: path.join(outDir, n), fullPage: /full/.test(n) }); return true; });
    await page.exposeFunction('__done', (json) => resolveDone(JSON.parse(json)));
    await page.addInitScript(SHIM);
    await page.goto(url + hash);
    await page.waitForFunction(() => window.__app && document.querySelector('.tool-card, .tool-page'), null, { timeout: 30000 });
    page.evaluate(script).catch((e) => resolveDone({ fatal: 'evaluate: ' + String(e) }));
    const report = await Promise.race([done, new Promise((r) => setTimeout(() => r({ fatal: 'Zeitüberschreitung' }), timeout))]);
    report.logs = logs;
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    if (!quiet && logs.length) console.log(logs.slice(0, 30).join('\n'));
    return report;
  } finally {
    await browser.close();
    server.close();
  }
}

export function printReport(name, r) {
  const ok = (r.ok || []).length, fail = (r.fail || []).length;
  console.log(`${name}: ${r.fatal ? 'ABBRUCH ' + r.fatal : ''} ok ${ok} fail ${fail}`);
  for (const f of r.fail || []) console.log('  FAIL', f.label || f.n, String(f.err).slice(0, 600));
  return !r.fatal && fail === 0;
}
