// Einige Bibliotheken (docx, pptxgenjs, exceljs) erwarten ein globales Buffer wie in Node.
import { Buffer } from 'buffer';
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
export { Buffer };
