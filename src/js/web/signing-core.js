// Digitale PDF-Signaturen nach ETSI PAdES (CAdES detached) mit RFC 3161 Zeitstempel
// Läuft komplett im Browser (WebCrypto); der private Schlüssel verlässt das Gerät nie.
import forge from 'node-forge';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { Buffer } from 'buffer';
import { sha256 as nSha256, sha384 as nSha384, sha512 as nSha512 } from '@noble/hashes/sha2.js';
import { sha1 as nSha1 } from '@noble/hashes/legacy.js';

const webcrypto = globalThis.crypto;
pkijs.setEngine('browser', new pkijs.CryptoEngine({ name: 'browser', crypto: webcrypto }));

// Kleine Entsprechungen zu den Node-Funktionen, die die Mac-App genutzt hat
const HASHES = { sha256: nSha256, sha384: nSha384, sha512: nSha512, sha1: nSha1 };
function createHash(name) {
  const h = HASHES[name].create();
  const api = { update: (d) => { h.update(d instanceof Uint8Array ? d : new Uint8Array(d)); return api; }, digest: () => Buffer.from(h.digest()) };
  return api;
}
const randomBytes = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n)));
const randomUUID = () => (webcrypto.randomUUID ? webcrypto.randomUUID() : [...randomBytes(16)].map((b, i) => (i === 4 || i === 6 || i === 8 || i === 10 ? '-' : '') + b.toString(16).padStart(2, '0')).join(''));

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  signatureTimeStamp: '1.2.840.113549.1.9.16.2.14',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  sha1: '1.3.14.3.2.26',
};
const HASH_NAME = { [OID.sha256]: 'sha256', [OID.sha384]: 'sha384', [OID.sha512]: 'sha512', [OID.sha1]: 'sha1' };
const SIG_HEX_LEN = 48000; // Platz für CMS inkl. Zertifikatskette und Zeitstempel (24 KB)

const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const sha256 = (buf) => createHash('sha256').update(buf).digest();

// ======================================================================
// Zertifikatsspeicher
// ======================================================================
const LS_META = 'pdfeditor.certs.v1';
const LS_P12 = (id) => `pdfeditor.cert.${id}`;
const b64 = (u8) => Buffer.from(u8).toString('base64');

// Zertifikate liegen verschlüsselt (PKCS#12, AES-256) im Speicher dieses Browsers
class CertStore {
  list() {
    try { return JSON.parse(localStorage.getItem(LS_META) || '[]'); } catch (_) { return []; }
  }
  _save(list) { localStorage.setItem(LS_META, JSON.stringify(list)); }
  publicList() { return this.list().map((m) => ({ ...m, remembered: false })); }
  _p12(id) {
    const v = localStorage.getItem(LS_P12(id));
    if (!v) throw new Error('Zertifikat nicht gefunden.');
    return Buffer.from(v, 'base64');
  }

  _add(p12Der, info, source) {
    const id = randomUUID();
    try {
      localStorage.setItem(LS_P12(id), b64(p12Der));
    } catch (_) { throw new Error('Das Zertifikat konnte nicht im Browser gespeichert werden (Speicher voll oder privater Modus).'); }
    const list = this.list();
    list.push({ id, source, created: new Date().toISOString(), ...info });
    this._save(list);
    return id;
  }

  async create({ name, email, organization, city, country = 'DE', password, years = 3 }) {
    if (!name || !password) throw new Error('Name und Passwort sind erforderlich.');
    const pair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
    const key = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(pkcs8.toString('binary'))));
    const pub = forge.pki.setRsaPublicKey(key.n, key.e);
    const cert = forge.pki.createCertificate();
    cert.publicKey = pub;
    cert.serialNumber = '01' + randomBytes(15).toString('hex');
    const now = new Date(Date.now() - 5 * 60 * 1000);
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getTime() + years * 365.25 * 24 * 3600 * 1000);
    const attrs = [{ name: 'commonName', value: name }];
    if (organization) attrs.push({ name: 'organizationName', value: organization });
    if (city) attrs.push({ name: 'localityName', value: city });
    if (country) attrs.push({ name: 'countryName', value: country.slice(0, 2).toUpperCase() });
    if (email) attrs.push({ name: 'emailAddress', value: email });
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    const ext = [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true },
      { name: 'extKeyUsage', emailProtection: true, '1.3.6.1.5.5.7.3.36': true, '1.2.840.113583.1.1.5': true, '1.3.6.1.4.1.311.10.3.12': true },
      { name: 'subjectKeyIdentifier' },
    ];
    if (email) ext.push({ name: 'subjectAltName', altNames: [{ type: 1, value: email }] });
    cert.setExtensions(ext);
    cert.sign(key, forge.md.sha256.create());
    const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: 'aes256', friendlyName: name });
    const der = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
    return this._add(der, this._describe(cert), 'self');
  }

  import(p12Bytes, password) {
    const { cert } = this._open(Buffer.from(p12Bytes), password);
    return this._add(Buffer.from(p12Bytes), this._describe(cert), 'import');
  }

  remove(id) {
    this._save(this.list().filter((c) => c.id !== id));
    try { localStorage.removeItem(LS_P12(id)); } catch (_) {}
  }

  exportP12(id) { return new Uint8Array(this._p12(id)); }

  exportPublic(id, password) {
    const { cert } = this.unlock(id, password);
    return Buffer.from(forge.pki.certificateToPem(cert), 'utf8');
  }

  _open(p12Der, password) {
    let p12;
    try {
      const asn = forge.asn1.fromDer(forge.util.createBuffer(p12Der.toString('binary')));
      p12 = forge.pkcs12.pkcs12FromAsn1(asn, false, password);
    } catch (e) {
      const err = new Error(/mac|password|Invalid/i.test(String(e.message)) ? 'Das Passwort für das Zertifikat ist falsch.' : `Zertifikat konnte nicht gelesen werden: ${e.message}`);
      err.wrongPassword = /mac|password|Invalid/i.test(String(e.message));
      throw err;
    }
    const keyBags = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
    ];
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    if (!keyBags.length || !keyBags[0].key) throw new Error('Die Datei enthält keinen privaten Schlüssel.');
    const key = keyBags[0].key;
    const certs = certBags.map((b) => b.cert).filter(Boolean);
    // Zum Schlüssel passendes Zertifikat finden
    const modHex = key.n.toString(16);
    const cert = certs.find((c) => c.publicKey && c.publicKey.n && c.publicKey.n.toString(16) === modHex) || certs[0];
    if (!cert) throw new Error('Die Datei enthält kein Zertifikat.');
    const chain = certs.filter((c) => c !== cert);
    return { key, cert, chain };
  }

  unlock(id, password) {
    const meta = this.list().find((c) => c.id === id);
    if (!meta) throw new Error('Zertifikat nicht gefunden.');
    if (password === null || password === undefined) { const e = new Error('Passwort erforderlich'); e.needPassword = true; throw e; }
    return { ...this._open(this._p12(id), password), meta };
  }

  _describe(cert) {
    const get = (attrs, n) => { const a = attrs.getField(n); return a ? String(a.value) : ''; };
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
    const selfSigned = cert.issuer.hash === cert.subject.hash;
    return {
      name: get(cert.subject, 'CN') || 'Unbekannt',
      email: get(cert.subject, 'E') || '',
      organization: get(cert.subject, 'O') || '',
      issuer: get(cert.issuer, 'CN') || get(cert.issuer, 'O') || '',
      selfSigned,
      serial: cert.serialNumber,
      notBefore: cert.validity.notBefore.toISOString(),
      notAfter: cert.validity.notAfter.toISOString(),
      fingerprint: sha256(der).toString('hex').toUpperCase().match(/.{2}/g).join(':'),
    };
  }
  describeById(id) { return this.publicList().find((c) => c.id === id); }
}

// ======================================================================
// CMS / PAdES
// ======================================================================
function forgeCertToPkijs(cert) {
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  return { der, cert: pkijs.Certificate.fromBER(toAB(new Uint8Array(der))) };
}

async function importKey(forgeKey) {
  const pkcs8 = forge.asn1.toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(forgeKey))).getBytes();
  return webcrypto.subtle.importKey('pkcs8', toAB(new Uint8Array(Buffer.from(pkcs8, 'binary'))), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function requestTimestamp(tsaUrl, data, fetchFn) {
  const imprint = sha256(Buffer.from(data));
  const nonce = randomBytes(8);
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: toAB(new Uint8Array(imprint)) }),
    }),
    nonce: new asn1js.Integer({ valueHex: toAB(new Uint8Array(nonce)) }),
    certReq: true,
  });
  const body = Buffer.from(req.toSchema().toBER(false));
  const res = await fetchFn(tsaUrl, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body });
  if (!res.ok) throw new Error(`Zeitstempeldienst antwortet mit ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const resp = pkijs.TimeStampResp.fromBER(toAB(buf));
  if (!resp.timeStampToken || resp.status.status > 1) throw new Error('Zeitstempeldienst hat keinen Zeitstempel geliefert');
  return resp.timeStampToken;
}

async function buildCms({ digest, key, cert, chain, tsaUrl, fetchFn }) {
  const signer = forgeCertToPkijs(cert);
  const chainP = chain.map(forgeCertToPkijs);
  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: toAB(new Uint8Array(sha256(signer.der))) }),
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({ value: [new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 4 }, value: [signer.cert.issuer.toSchema()] })] }),
          new asn1js.Integer({ valueHex: signer.cert.serialNumber.valueBlock.valueHexView.slice().buffer }),
        ],
      }),
    ],
  });
  const signedAttrs = [
    new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
    new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: toAB(new Uint8Array(digest)) })] }),
    new pkijs.Attribute({ type: OID.signingCertificateV2, values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] })] }),
  ];
  const sd = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({ issuer: signer.cert.issuer, serialNumber: signer.cert.serialNumber }),
      signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: signedAttrs }),
    })],
    certificates: [signer.cert, ...chainP.map((c) => c.cert)],
  });
  const cryptoKey = await importKey(key);
  await sd.sign(cryptoKey, 0, 'SHA-256');
  let timestamp = null;
  if (tsaUrl) {
    try {
      const sigValue = sd.signerInfos[0].signature.valueBlock.valueHexView;
      const token = await requestTimestamp(tsaUrl, sigValue, fetchFn);
      sd.signerInfos[0].unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
        type: 1,
        attributes: [new pkijs.Attribute({ type: OID.signatureTimeStamp, values: [token.toSchema()] })],
      });
      const tst = parseTstInfo(token);
      timestamp = { time: tst.genTime.toISOString(), tsa: tsaUrl };
    } catch (e) {
      timestamp = { error: e.message };
    }
  }
  const ci = new pkijs.ContentInfo({ contentType: OID.signedData, content: sd.toSchema(true) });
  return { der: Buffer.from(ci.toSchema().toBER(false)), timestamp };
}

function parseTstInfo(tokenContentInfo) {
  const sd = new pkijs.SignedData({ schema: tokenContentInfo.content });
  const eContent = sd.encapContentInfo.eContent;
  const raw = eContent.valueBlock.valueHexView && eContent.valueBlock.valueHexView.byteLength ? eContent.valueBlock.valueHexView : concatOctets(eContent);
  return pkijs.TSTInfo.fromBER(raw.slice().buffer);
}
function concatOctets(os) {
  const parts = (os.valueBlock.value || []).map((v) => new Uint8Array(v.valueBlock.valueHexView));
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ======================================================================
// Inkrementelles Update (bestehende Signaturen bleiben gültig)
// ======================================================================
function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(tz) / 60))}'${p(Math.abs(tz) % 60)}'`;
}
function pdfString(s) {
  // UTF-16BE mit BOM für Umlaute
  const buf = Buffer.alloc(2 + s.length * 2);
  buf[0] = 0xfe; buf[1] = 0xff;
  for (let i = 0; i < s.length; i++) buf.writeUInt16BE(s.charCodeAt(i), 2 + i * 2);
  return `<${buf.toString('hex').toUpperCase()}>`;
}

function lastStartXref(bytes) {
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 2048))).toString('latin1');
  const m = [...tail.matchAll(/startxref\s+(\d+)/g)];
  if (!m.length) throw new Error('PDF-Struktur (startxref) nicht gefunden');
  return +m[m.length - 1][1];
}

function serializeObject(PDFLib, obj) {
  const size = obj.sizeInBytes();
  const buf = new Uint8Array(size);
  obj.copyBytesInto(buf, 0);
  return Buffer.from(buf);
}

function existingSignatureCount(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  return (s.match(/\/ByteRange\s*\[/g) || []).length;
}

/**
 * Fügt ein Signaturfeld per inkrementellem Update hinzu und signiert.
 * visible: { pageIndex, rect: [x, y, w, h] in Darstellungskoordinaten (Punkt, oben links), image: PNG-Bytes, lines: [Text] }
 */
async function signPdf(pdfBytes, opts) {
  const PDFLib = window.PDFLib;
  const { PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFRef, PDFString, PDFHexString, StandardFonts } = PDFLib;
  const original = Buffer.from(pdfBytes);
  const doc = await PDFDocument.load(original, { updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context;
  // Objektnummern dürfen nicht mit vorhandenen (auch Objektstreams) kollidieren
  {
    const txt = original.toString('latin1');
    let maxNum = ctx.largestObjectNumber;
    for (const mm of txt.matchAll(/\/Size\s+(\d+)/g)) maxNum = Math.max(maxNum, +mm[1] - 1);
    for (const mm of txt.matchAll(/(?:^|[\r\n\s])(\d+)\s+\d+\s+obj\b/g)) maxNum = Math.max(maxNum, +mm[1]);
    ctx.largestObjectNumber = maxNum;
  }
  const largestBefore = ctx.largestObjectNumber;
  const prevXref = lastStartXref(original);
  const prevIsStream = !/^\s*xref/.test(original.subarray(prevXref, prevXref + 10).toString('latin1'));
  const modified = new Map(); // ref.toString() -> ref

  const markModified = (ref) => { if (ref && ref instanceof PDFRef) modified.set(ref.toString(), ref); };

  // ---- Seite & Rechteck ----
  const pageIndex = Math.max(0, Math.min(doc.getPageCount() - 1, opts.visible ? opts.visible.pageIndex : 0));
  const page = doc.getPage(pageIndex);
  const pageRef = page.ref;
  const crop = page.getCropBox();
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  let rect = [0, 0, 0, 0];
  let dispW = 0, dispH = 0;
  if (opts.visible) {
    const [dx, dy, dw, dh] = opts.visible.rect;
    dispW = dw; dispH = dh;
    const W = crop.width, H = crop.height;
    // Darstellung -> Benutzerkoordinaten
    let x1, y1, x2, y2;
    if (rot === 0) { x1 = dx; y1 = H - dy - dh; x2 = dx + dw; y2 = H - dy; }
    else if (rot === 90) { x1 = dy; y1 = dx; x2 = dy + dh; y2 = dx + dw; }
    else if (rot === 180) { x1 = W - dx - dw; y1 = dy; x2 = W - dx; y2 = dy + dh; }
    else { x1 = W - dy - dh; y1 = H - dx - dw; x2 = W - dy; y2 = H - dx; }
    rect = [crop.x + x1, crop.y + y1, crop.x + x2, crop.y + y2].map((v) => Math.round(v * 100) / 100);
  }

  // ---- Darstellung (Appearance) ----
  let apRef = null;
  if (opts.visible) {
    const v = opts.visible;
    const resources = ctx.obj({});
    const xobj = {};
    // Schriften: mitgelieferte Unicode-Schrift (Umlaute, Akzente, Kyrillisch) oder Standard-Helvetica
    let fReg, fBold;
    if (opts.fonts && opts.fonts.regular && window.fontkit) {
      doc.registerFontkit(window.fontkit);
      fReg = await doc.embedFont(opts.fonts.regular, { subset: true });
      fBold = await doc.embedFont(opts.fonts.bold || opts.fonts.regular, { subset: true });
    } else {
      fReg = await doc.embedFont(StandardFonts.Helvetica);
      fBold = await doc.embedFont(StandardFonts.HelveticaBold);
    }
    const n = (x) => (Math.round(x * 1000) / 1000).toString();
    const safe = (font, t) => { let o = ''; for (const ch of String(t || '')) { try { font.encodeText(ch); o += ch; } catch (_) { o += '?'; } } return o; };
    const fit = (font, raw, size, maxW) => { const t = safe(font, raw); let sz = size; while (sz > 3.5 && font.widthOfTextAtSize(t, sz) > maxW) sz -= 0.25; let txt = t; while (txt.length > 4 && font.widthOfTextAtSize(txt, sz) > maxW) txt = txt.slice(0, -2).trimEnd() + '…'; return { size: sz, text: safe(font, txt) }; };
    const text = (font, key, t, size, x, y, rgb, spacing = 0) => `BT ${rgb} rg /${key} ${n(size)} Tf ${n(spacing)} Tc ${n(x)} ${n(y)} Td ${font.encodeText(t).toString()} Tj ET\n`;
    const rrect = (x, y, w, h, r) => {
      const k = 0.5523 * r;
      return `${n(x + r)} ${n(y)} m ${n(x + w - r)} ${n(y)} l ${n(x + w - r + k)} ${n(y)} ${n(x + w)} ${n(y + r - k)} ${n(x + w)} ${n(y + r)} c ${n(x + w)} ${n(y + h - r)} l ${n(x + w)} ${n(y + h - r + k)} ${n(x + w - r + k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c ${n(x + r)} ${n(y + h)} l ${n(x + r - k)} ${n(y + h)} ${n(x)} ${n(y + h - r + k)} ${n(x)} ${n(y + h - r)} c ${n(x)} ${n(y + r)} l ${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)} c h\n`;
    };
    // Schild mit Haken (24er Raster), zentriert in einem Quadrat der Kantenlänge s
    const shield = (cx, cy, s, fillRgb, checkRgb) => {
      const k = s / 24;
      return `q ${n(k)} 0 0 ${n(-k)} ${n(cx - s / 2)} ${n(cy + s / 2)} cm ${fillRgb} rg 12 2.2 m 19.6 5.2 l 19.6 12 l 19.6 16.6 16.5 20 12 21.8 c 7.5 20 4.4 16.6 4.4 12 c 4.4 5.2 l h f ${checkRgb} RG 1.9 w 1 J 1 j 8.4 12.1 m 11 14.7 l 15.8 9.4 l S Q\n`;
    };
    const BLUE = '0.114 0.306 0.847', DARK = '0.067 0.094 0.153', GRAY = '0.42 0.447 0.502', LINE = '0.78 0.82 0.9';
    let ops = '';
    const label = safe(fReg, v.label || 'Digital signiert von');
    const name = v.name || '';
    const sub = [v.dateText, v.certId ? `ID ${v.certId}` : ''].filter(Boolean).join('  ·  ');
    if (v.mode === 'stamp') {
      // Signaturstempel: Rahmen, blaues Feld mit Schild, Name, Datum, Zertifikats-ID
      const k = Math.min(dispH / 54, dispW / 190);
      const pw = Math.min(dispH, 40 * k);
      ops += `q 1 1 1 rg ${rrect(0.4, 0.4, dispW - 0.8, dispH - 0.8, 4 * k)}f Q\n`;
      ops += `q ${rrect(0.4, 0.4, dispW - 0.8, dispH - 0.8, 4 * k)}W n ${BLUE} rg 0 0 ${n(pw)} ${n(dispH)} re f Q\n`;
      ops += shield(pw / 2, dispH / 2, Math.min(pw * 0.62, dispH * 0.6), '1 1 1', BLUE);
      ops += `q ${BLUE} RG ${n(0.8 * k)} w ${rrect(0.4, 0.4, dispW - 0.8, dispH - 0.8, 4 * k)}S Q\n`;
      const tx = pw + 8 * k, tw = dispW - tx - 6 * k;
      const l1 = fit(fBold, 'DIGITAL SIGNIERT', 5.6 * k, tw - 8 * k);
      const l2 = fit(fBold, name, 10 * k, tw);
      const l3 = fit(fReg, v.dateText || '', 6.6 * k, tw);
      const l4 = fit(fReg, v.certId ? `Zertifikat-ID ${v.certId}` : (v.detail || ''), 5.8 * k, tw);
      ops += text(fBold, 'F2', l1.text, l1.size, tx, dispH - 11.5 * k, BLUE, 0.7 * k);
      ops += text(fBold, 'F2', l2.text, l2.size, tx, dispH - 24.5 * k, DARK);
      if (l3.text) ops += text(fReg, 'F1', l3.text, l3.size, tx, dispH - 35 * k, GRAY);
      if (l4.text) ops += text(fReg, 'F1', l4.text, l4.size, tx, dispH - 44.5 * k, GRAY);
    } else {
      // Handschriftliche Unterschrift, darunter dezente Signaturzeile mit Akzentlinie
      const cap = v.caption !== false && (name || sub);
      const ch = cap ? Math.max(15, Math.min(22, dispH * 0.3)) : 0;
      const tx = cap ? 6.5 : 0;
      if (v.image) {
        const img = await doc.embedPng(v.image);
        await img.embed();
        xobj.Img1 = img.ref;
        const availW = dispW - tx, availH = dispH - ch - (cap ? 2 : 0);
        const sc = Math.min(availW / img.width, availH / img.height);
        const w = img.width * sc, h = img.height * sc;
        ops += `q ${n(w)} 0 0 ${n(h)} ${n(tx + (availW - w) / 2)} ${n(ch + (cap ? 2 : 0) + (availH - h) / 2)} cm /Img1 Do Q\n`;
      }
      if (cap) {
        const fs1 = Math.min(7.2, ch * 0.38), fs2 = fs1 * 0.86;
        ops += `q ${BLUE} rg ${rrect(0, 0, 1.8, dispH, 0.9)}f Q\n`;
        ops += `q ${LINE} RG 0.45 w ${n(tx)} ${n(ch)} m ${n(dispW)} ${n(ch)} l S Q\n`;
        const tw = dispW - tx - 1;
        const lw = fReg.widthOfTextAtSize(label + ' ', fs1);
        const nm = fit(fBold, name, fs1, Math.max(20, tw - lw));
        ops += text(fReg, 'F1', label + ' ', nm.size, tx, ch - nm.size - 2.2, GRAY);
        ops += text(fBold, 'F2', nm.text, nm.size, tx + fReg.widthOfTextAtSize(label + ' ', nm.size), ch - nm.size - 2.2, DARK);
        const s2 = fit(fReg, sub, fs2, tw);
        if (s2.text) ops += text(fReg, 'F1', s2.text, s2.size, tx, ch - nm.size - s2.size - 4.6, GRAY);
      }
    }
    await fReg.embed();
    await fBold.embed();
    resources.set(PDFName.of('Font'), ctx.obj({ F1: fReg.ref, F2: fBold.ref }));
    if (Object.keys(xobj).length) resources.set(PDFName.of('XObject'), ctx.obj(xobj));
    const matrix = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0] }[rot];
    const ap = ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, dispW, dispH], Matrix: matrix, Resources: resources });
    apRef = ctx.register(ap);
  }

  // ---- Signaturwörterbuch (wird später als Text geschrieben) ----
  const sigRef = ctx.nextRef();
  const now = opts.date || new Date();

  // ---- Widget ----
  const fieldName = `Signatur${existingSignatureCount(original) + 1}_${randomBytes(3).toString('hex')}`;
  const widgetDict = {
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: rect, V: sigRef, T: PDFString.of(fieldName), F: 132, P: pageRef,
  };
  if (apRef) widgetDict.AP = { N: apRef };
  const widget = ctx.obj(widgetDict);
  const widgetRef = ctx.register(widget);

  // Annots der Seite
  const annots = page.node.get(PDFName.of('Annots'));
  if (annots instanceof PDFRef) {
    const arr = ctx.lookup(annots, PDFArray);
    arr.push(widgetRef);
    markModified(annots);
  } else if (annots instanceof PDFArray) {
    annots.push(widgetRef);
    markModified(pageRef);
  } else {
    page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
    markModified(pageRef);
  }

  // AcroForm
  const catalog = doc.catalog;
  const rootRef = ctx.trailerInfo.Root;
  let acro = catalog.get(PDFName.of('AcroForm'));
  if (acro instanceof PDFRef) {
    const acroDict = ctx.lookup(acro, PDFDict);
    addField(acroDict, acro);
  } else if (acro instanceof PDFDict) {
    addField(acro, rootRef);
  } else {
    const acroDict = ctx.obj({ Fields: [widgetRef], SigFlags: 3 });
    const acroRef = ctx.register(acroDict);
    catalog.set(PDFName.of('AcroForm'), acroRef);
    markModified(rootRef);
  }
  function addField(dict, ownerRef) {
    const fields = dict.get(PDFName.of('Fields'));
    if (fields instanceof PDFRef) { ctx.lookup(fields, PDFArray).push(widgetRef); markModified(fields); }
    else if (fields instanceof PDFArray) { fields.push(widgetRef); markModified(ownerRef); }
    else { dict.set(PDFName.of('Fields'), ctx.obj([widgetRef])); markModified(ownerRef); }
    dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
    dict.delete(PDFName.of('NeedAppearances'));
    markModified(ownerRef);
  }

  // ---- Schreiben ----
  const chunks = [original];
  let offset = original.length;
  if (original[original.length - 1] !== 0x0a) { chunks.push(Buffer.from('\n')); offset += 1; }
  const entries = []; // [num, gen, offset]
  const write = (buf) => { chunks.push(buf); offset += buf.length; };

  const allRefs = new Map();
  for (const [k, r] of modified) allRefs.set(k, r);
  for (const [ref] of ctx.enumerateIndirectObjects()) if (ref.objectNumber > largestBefore && ref !== sigRef) allRefs.set(ref.toString(), ref);

  for (const ref of allRefs.values()) {
    const obj = ctx.lookup(ref);
    if (!obj) continue;
    entries.push([ref.objectNumber, ref.generationNumber, offset]);
    write(Buffer.from(`${ref.objectNumber} ${ref.generationNumber} obj\n`, 'latin1'));
    write(serializeObject(PDFLib, obj));
    write(Buffer.from('\nendobj\n', 'latin1'));
  }

  // Signaturwörterbuch mit Platzhaltern
  const sigOffset = offset;
  entries.push([sigRef.objectNumber, 0, sigOffset]);
  const byteRangePlaceholder = '[0 0000000000 0000000000 0000000000]';
  let sigText = `${sigRef.objectNumber} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange ${byteRangePlaceholder} /Contents <`;
  const contentsStartInSig = Buffer.byteLength(sigText, 'latin1') - 1; // Position von '<'
  sigText += '0'.repeat(SIG_HEX_LEN) + '>';
  sigText += ` /M (${pdfDate(now)})`;
  if (opts.name) sigText += ` /Name ${pdfString(opts.name)}`;
  if (opts.reason) sigText += ` /Reason ${pdfString(opts.reason)}`;
  if (opts.location) sigText += ` /Location ${pdfString(opts.location)}`;
  if (opts.contact) sigText += ` /ContactInfo ${pdfString(opts.contact)}`;
  sigText += ' /Prop_Build << /App << /Name /PDF#20Editor /REx (1.1.0) >> /Filter << /Name /Adobe.PPKLite >> >> >>\nendobj\n';
  const sigBuf = Buffer.from(sigText, 'latin1');
  write(sigBuf);

  // Querverweis
  entries.sort((a, b) => a[0] - b[0]);
  const size = Math.max(ctx.largestObjectNumber, sigRef.objectNumber) + 1;
  const trailerParts = [`/Size ${size}`, `/Root ${rootRef.toString()}`, `/Prev ${prevXref}`];
  const info = ctx.trailerInfo.Info;
  if (info) trailerParts.push(`/Info ${info.toString()}`);
  const ids = ctx.trailerInfo.ID;
  let firstId = randomBytes(16).toString('hex').toUpperCase();
  if (ids && ids.get) { try { firstId = ids.get(0).asBytes ? Buffer.from(ids.get(0).asBytes()).toString('hex').toUpperCase() : ids.get(0).toString().replace(/[<>]/g, ''); } catch (_) {} }
  trailerParts.push(`/ID [<${firstId}> <${randomBytes(16).toString('hex').toUpperCase()}>]`);

  const xrefOffset = offset;
  if (!prevIsStream) {
    let x = 'xref\n';
    for (const sec of sections(entries)) {
      x += `${sec[0][0]} ${sec.length}\n`;
      for (const e of sec) x += `${String(e[2]).padStart(10, '0')} ${String(e[1]).padStart(5, '0')} n\r\n`;
    }
    x += `trailer\n<< ${trailerParts.join(' ')} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    write(Buffer.from(x, 'latin1'));
  } else {
    // Querverweis-Stream (für PDFs, die bereits Querverweis-Streams nutzen)
    const xrefNum = size;
    entries.push([xrefNum, 0, xrefOffset]);
    entries.sort((a, b) => a[0] - b[0]);
    const secs = sections(entries);
    const data = Buffer.alloc(entries.length * 7);
    let p = 0;
    const index = [];
    for (const sec of secs) {
      index.push(sec[0][0], sec.length);
      for (const e of sec) { data[p] = 1; data.writeUInt32BE(e[2], p + 1); data.writeUInt16BE(e[1], p + 5); p += 7; }
    }
    const parts = trailerParts.map((t) => (t.startsWith('/Size') ? `/Size ${xrefNum + 1}` : t));
    const head = `${xrefNum} 0 obj\n<< /Type /XRef ${parts.join(' ')} /W [1 4 2] /Index [${index.join(' ')}] /Length ${data.length} >>\nstream\n`;
    write(Buffer.concat([Buffer.from(head, 'latin1'), data, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1')]));
  }

  const out = Buffer.concat(chunks);
  // ByteRange einsetzen
  const contentsStart = sigOffset + contentsStartInSig; // '<'
  const contentsEnd = contentsStart + SIG_HEX_LEN + 2; // nach '>'
  const br = [0, contentsStart, contentsEnd, out.length - contentsEnd];
  const brText = `[${br.map((n) => String(n)).join(' ')}]`.padEnd(byteRangePlaceholder.length, ' ');
  const brPos = out.indexOf(byteRangePlaceholder, sigOffset, 'latin1');
  out.write(brText, brPos, 'latin1');

  const digest = createHash('sha256').update(out.subarray(0, contentsStart)).update(out.subarray(contentsEnd)).digest();
  const cms = await buildCms({ digest, key: opts.key, cert: opts.cert, chain: opts.chain || [], tsaUrl: opts.tsaUrl, fetchFn: opts.fetch });
  const hex = cms.der.toString('hex').toUpperCase();
  if (hex.length > SIG_HEX_LEN) throw new Error('Signatur zu groß für den reservierten Platz');
  out.write(hex, contentsStart + 1, 'latin1');
  return { data: new Uint8Array(out), timestamp: cms.timestamp, fieldName };

  function sections(list) {
    const secs = [];
    for (const e of list) {
      const last = secs[secs.length - 1];
      if (last && last[last.length - 1][0] + 1 === e[0]) last.push(e); else secs.push([e]);
    }
    return secs;
  }
}

// ======================================================================
// Prüfen
// ======================================================================
function nameOf(rdn) {
  const map = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.7': 'L', '2.5.4.6': 'C', '1.2.840.113549.1.9.1': 'E', '2.5.4.5': 'SERIALNUMBER', '2.5.4.4': 'SN', '2.5.4.42': 'GN' };
  const o = {};
  for (const tv of rdn.typesAndValues) o[map[tv.type] || tv.type] = tv.value.valueBlock.value;
  return o;
}

async function verifyPdf(pdfBytes, opts = {}) {
  const bytes = Buffer.from(pdfBytes);
  const text = bytes.toString('latin1');
  const results = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(text))) {
    const br = m.slice(1, 5).map(Number);
    const key = br.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const r = { byteRange: br, ok: false, problems: [] };
    try {
      if (br[0] !== 0 || br[1] + br[3] > bytes.length || br[2] + br[3] > bytes.length || br[2] <= br[1]) throw new Error('Ungültiger Signaturbereich');
      const dictStart = text.lastIndexOf('<<', m.index);
      const dictText = text.slice(dictStart, Math.min(text.length, br[2] + 4000));
      const sub = /\/SubFilter\s*\/([\w.]+)/.exec(dictText);
      r.subFilter = sub ? sub[1] : '';
      const mm = /\/M\s*\((D:[^)]+)\)/.exec(text.slice(br[2], br[2] + 4000)) || /\/M\s*\((D:[^)]+)\)/.exec(dictText);
      r.pdfDate = mm ? mm[1] : '';
      const hex = text.slice(br[1] + 1, br[2] - 1).replace(/[^0-9A-Fa-f]/g, '').replace(/(00)+$/, '');
      const cmsDer = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
      const ci = pkijs.ContentInfo.fromBER(toAB(new Uint8Array(cmsDer)));
      const sd = new pkijs.SignedData({ schema: ci.content });
      const si = sd.signerInfos[0];
      const signed = Buffer.concat([bytes.subarray(br[0], br[0] + br[1]), bytes.subarray(br[2], br[2] + br[3])]);
      // Zertifikat finden
      const certs = (sd.certificates || []).filter((c) => c instanceof pkijs.Certificate);
      const signerCert = certs.find((c) => si.sid instanceof pkijs.IssuerAndSerialNumber && c.serialNumber.isEqual(si.sid.serialNumber) && c.issuer.isEqual(si.sid.issuer)) || certs[0];
      const subj = nameOf(signerCert.subject), iss = nameOf(signerCert.issuer);
      const certDer = Buffer.from(signerCert.toSchema().toBER(false));
      r.signer = { name: subj.CN || subj.O || '', email: subj.E || '', organization: subj.O || '', issuer: iss.CN || iss.O || '', selfSigned: signerCert.subject.isEqual(signerCert.issuer), notBefore: signerCert.notBefore.value.toISOString(), notAfter: signerCert.notAfter.value.toISOString(), fingerprint: sha256(certDer).toString('hex').toUpperCase().match(/.{2}/g).join(':'), serial: Buffer.from(signerCert.serialNumber.valueBlock.valueHexView).toString('hex') };
      // Hash prüfen
      const digestAlg = HASH_NAME[si.digestAlgorithm.algorithmId] || 'sha256';
      const docDigest = createHash(digestAlg).update(signed).digest();
      const mdAttr = si.signedAttrs && si.signedAttrs.attributes.find((a) => a.type === OID.messageDigest);
      const md = mdAttr ? Buffer.from(mdAttr.values[0].valueBlock.valueHexView) : null;
      r.integrity = !!md && md.equals(docDigest);
      const st = si.signedAttrs && si.signedAttrs.attributes.find((a) => a.type === OID.signingTime);
      if (st) r.signingTime = st.values[0].toDate().toISOString();
      // Kryptografische Prüfung
      let sigOk = false;
      try {
        const v = await sd.verify({ signer: 0, data: toAB(new Uint8Array(signed)), checkChain: false, extendedMode: true });
        sigOk = !!(v.signatureVerified ?? v);
      } catch (e) { r.problems.push('Signaturprüfung: ' + (e.message || e)); }
      r.signatureValid = sigOk;
      r.pades = r.subFilter === 'ETSI.CAdES.detached' && !!(si.signedAttrs && si.signedAttrs.attributes.find((a) => a.type === OID.signingCertificateV2));
      // Zeitstempel
      const tsAttr = si.unsignedAttrs && si.unsignedAttrs.attributes.find((a) => a.type === OID.signatureTimeStamp);
      if (tsAttr) {
        try {
          const tokenCi = new pkijs.ContentInfo({ schema: tsAttr.values[0] });
          const tst = parseTstInfo(tokenCi);
          const imprint = Buffer.from(tst.messageImprint.hashedMessage.valueBlock.valueHexView);
          const expected = createHash(HASH_NAME[tst.messageImprint.hashAlgorithm.algorithmId] || 'sha256').update(Buffer.from(si.signature.valueBlock.valueHexView)).digest();
          const tsd = new pkijs.SignedData({ schema: tokenCi.content });
          let tsOk = false;
          try {
            // pkijs prüft bei TSTInfo zusätzlich den Hash der zeitgestempelten Daten (= Signaturwert)
            const tv = await tsd.verify({ signer: 0, data: si.signature.valueBlock.valueHexView.slice().buffer, checkChain: false, extendedMode: true });
            tsOk = !!(tv.signatureVerified ?? tv);
          } catch (_) {}
          const tsCert = (tsd.certificates || []).find((c) => c instanceof pkijs.Certificate);
          r.timestamp = { time: tst.genTime.toISOString(), imprintOk: imprint.equals(expected), signatureOk: tsOk, tsa: tsCert ? (nameOf(tsCert.subject).CN || nameOf(tsCert.subject).O) : '' };
        } catch (e) { r.timestamp = { error: e.message }; }
      }
      r.coversWholeFile = br[2] + br[3] === bytes.length;
      r.certValidAtSigning = (() => {
        const t = new Date(r.timestamp && r.timestamp.time ? r.timestamp.time : r.signingTime || Date.now());
        return t >= signerCert.notBefore.value && t <= signerCert.notAfter.value;
      })();
      if (opts.trustCheck) r.trust = await opts.trustCheck(certDer, certs.filter((c) => c !== signerCert).map((c) => Buffer.from(c.toSchema().toBER(false))));
      r.ok = r.integrity && r.signatureValid;
    } catch (e) {
      r.problems.push(e.message || String(e));
    }
    results.push(r);
  }
  // Änderungen nach der Signatur bewerten
  const maxEnd = Math.max(0, ...results.map((r) => r.byteRange[2] + r.byteRange[3]));
  for (const r of results) {
    const end = r.byteRange[2] + r.byteRange[3];
    if (r.coversWholeFile) r.changesAfter = 'none';
    else if (results.some((o) => o !== r && o.ok && o.byteRange[2] + o.byteRange[3] === bytes.length && end < o.byteRange[2] + o.byteRange[3])) {
      r.changesAfter = maxEnd === bytes.length ? 'signatures' : 'modified';
    } else r.changesAfter = 'modified';
  }
  return results;
}

export { CertStore, signPdf, verifyPdf, existingSignatureCount, sha256, randomUUID, createHash, requestTimestamp };
