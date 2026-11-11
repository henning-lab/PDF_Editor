// Aufruf: node tests/run.mjs [name ...]   (ohne Namen: alle Testreihen)
import fs from 'node:fs';
import path from 'node:path';
import { runInApp, printReport, root } from './harness.mjs';

const all = ['runall', 'ui', 'sigui', 'conv', 'convweb', 'sign'];
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outBase = process.env.TEST_OUT || path.join(root, 'tests/out');
let okAll = true;
for (const name of names.length ? names : all) {
  const file = fs.existsSync(name) ? name : path.join(root, 'tests', name + '.js');
  const outDir = path.join(outBase, path.basename(file, '.js'));
  fs.rmSync(outDir, { recursive: true, force: true });
  const t0 = Date.now();
  const mobile = process.env.MOBILE === '1';
  const report = await runInApp(fs.readFileSync(file, 'utf8').replaceAll('OUT:', outDir + '/'), { outDir, viewport: mobile ? { width: 390, height: 844 } : undefined, isMobile: mobile });
  okAll = printReport(`${path.basename(file, '.js')} (${Math.round((Date.now() - t0) / 1000)} s)`, report) && okAll;
}
process.exit(okAll ? 0 : 1);
