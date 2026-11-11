// Lokaler Server für docs/ (http://127.0.0.1:8080/)
import { startServer } from '../tests/harness.mjs';
const { url } = await startServer({ port: +(process.env.PORT || 8080), outDir: 'tests/out' });
console.log('PDF Editor läuft unter ' + url);
