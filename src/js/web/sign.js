// Digitale Signaturen im Browser: Zertifikate verwalten, signieren, prüfen.
import { CertStore, signPdf as coreSign, verifyPdf as coreVerify, existingSignatureCount, randomUUID, createHash, requestTimestamp } from './signing-core.js';
import { addCertificatePage, loadFont } from './sign-certificate.js';
import { native } from '../native.js';
import forge from 'node-forge';

const store = new CertStore();
const toU8 = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d));

// Zeitstempeldienste, die Anfragen direkt aus dem Browser erlauben (CORS)
const TSA_DEFAULT = ['https://timestamp.sigstore.dev/api/v1/timestamp', 'https://rfc3161.ai.moda'];
function tsaList() {
  const custom = (() => { try { return localStorage.getItem('pdfeditor.tsa') || ''; } catch (_) { return ''; } })();
  return custom ? [custom, ...TSA_DEFAULT] : TSA_DEFAULT;
}
const timedFetch = (ms) => (url, init) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...init, signal: ac.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }).finally(() => clearTimeout(t));
};
// Prüft vorab, welcher Dienst erreichbar ist (mit einem Zufallswert, nicht mit Dokumentdaten)
async function findTsa() {
  for (const url of tsaList()) {
    try {
      await requestTimestamp(url, crypto.getRandomValues(new Uint8Array(32)), timedFetch(7000));
      return url;
    } catch (_) { /* nächsten Dienst versuchen */ }
  }
  return null;
}

export const certsList = async () => store.publicList();
export const certsCreate = async (info) => store.create(info);
export const certsImport = async (data, password) => store.import(toU8(data), password);
export const certsRemove = async (id) => store.remove(id);
export async function certsExportP12(id) {
  const meta = store.describeById(id);
  return native.saveFile(`${meta ? meta.name : 'Zertifikat'}.p12`, store.exportP12(id));
}
export async function certsExportPublic(id, password) {
  const pem = store.exportPublic(id, password);
  const meta = store.describeById(id);
  return native.saveFile(`${meta ? meta.name : 'Zertifikat'} (öffentlich).cer`, pem);
}
export async function certsCheckPassword(id, password) {
  try { store.unlock(id, password); return { ok: true }; } catch (e) { return { ok: false, wrongPassword: !!e.wrongPassword, needPassword: !!e.needPassword, error: e.message }; }
}

export const hasSignatures = async (data) => existingSignatureCount(toU8(data));

export async function signPdf(data, opts) {
  const { key, cert, chain, meta } = store.unlock(opts.certId, opts.password);
  let bytes = toU8(data);
  const now = new Date();
  const docId = randomUUID().toUpperCase();
  const tsaUrl = opts.timestamp ? await findTsa() : null;
  const tsaHost = tsaUrl ? new URL(tsaUrl).host : null;
  if (opts.protocol && existingSignatureCount(bytes) === 0) {
    const { PDFDocument } = window.PDFLib;
    const pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
    bytes = await addCertificatePage(bytes, {
      fileName: opts.fileName || 'Dokument.pdf', pages, docId, now,
      docHash: createHash('sha256').update(bytes).digest().toString('hex'),
      signer: { name: meta.name, email: meta.email, organization: meta.organization },
      reason: opts.reason, location: opts.location,
      cert: { ...meta, keyBits: key.n.bitLength() },
      tsaHost, signatureImage: opts.visible && opts.visible.image ? opts.visible.image : null,
    });
  }
  const fonts = opts.visible ? { regular: await loadFont('LiberationSans-Regular.ttf'), bold: await loadFont('LiberationSans-Bold.ttf') } : null;
  const base = { key, cert, chain, date: now, name: meta.name, reason: opts.reason, location: opts.location, contact: meta.email, visible: opts.visible, fonts };
  let result = await coreSign(bytes, { ...base, tsaUrl, fetch: timedFetch(15000) });
  let timestamp = null;
  if (opts.timestamp) timestamp = result.timestamp && !result.timestamp.error ? result.timestamp : { error: tsaUrl ? (result.timestamp && result.timestamp.error) || 'Zeitstempel fehlgeschlagen' : 'Kein Zeitstempeldienst erreichbar' };
  return { data: result.data, timestamp, docId, signer: meta.name };
}

export const verifyPdf = async (data) => coreVerify(toU8(data));
void forge;
