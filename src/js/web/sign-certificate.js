// Signaturzertifikat: die Nachweis-Seite, die an ein digital signiertes Dokument angehängt wird.
// Gestaltet als eigenständiges, professionelles Zertifikat (A4) mit eingebetteten Schriften.
const { PDFDocument, rgb, LineCapStyle } = window.PDFLib;

const fontCache = {};
export async function loadFont(file) {
  if (!fontCache[file]) fontCache[file] = fetch(new URL(`fonts/${file}`, document.baseURI)).then((r) => { if (!r.ok) throw new Error(`Schrift ${file} fehlt`); return r.arrayBuffer(); }).then((b) => new Uint8Array(b));
  return fontCache[file];
}

const C = {
  navy: rgb(0.059, 0.106, 0.275), blue: rgb(0.145, 0.388, 0.922), blueDark: rgb(0.114, 0.306, 0.847), ink: rgb(0.067, 0.094, 0.153),
  gray: rgb(0.42, 0.447, 0.502), light: rgb(0.612, 0.639, 0.686), line: rgb(0.886, 0.906, 0.941), panel: rgb(0.969, 0.976, 0.992),
  green: rgb(0.086, 0.502, 0.239), greenBg: rgb(0.906, 0.965, 0.929), white: rgb(1, 1, 1), sky: rgb(0.725, 0.792, 0.953), gold: rgb(0.773, 0.624, 0.294),
};

const fmtLong = (d) => d.toLocaleString('de-DE', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const fmtDate = (s) => new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const group = (hex, n = 4) => hex.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().match(new RegExp(`.{1,${n}}`, 'g')).join(' ');

/**
 * info: { fileName, pages, docHash (hex), docId, now (Date), signer: { name, email, organization }, reason, location,
 *         cert: { issuer, selfSigned, notBefore, notAfter, serial, fingerprint, keyBits }, tsaHost, signatureImage (PNG) }
 */
export async function addCertificatePage(pdfBytes, info) {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  doc.registerFontkit(window.fontkit);
  const [fr, fb, fi, fm] = await Promise.all([
    loadFont('LiberationSans-Regular.ttf'), loadFont('LiberationSans-Bold.ttf'), loadFont('LiberationSans-Italic.ttf'), loadFont('LiberationMono-Regular.ttf'),
  ]);
  const F = {
    r: await doc.embedFont(fr, { subset: true }), b: await doc.embedFont(fb, { subset: true }),
    i: await doc.embedFont(fi, { subset: true }), m: await doc.embedFont(fm, { subset: true }),
  };
  const W = 595.28, H = 841.89;
  const page = doc.addPage([W, H]);
  const M = 44; // Seitenrand
  const top = (t) => H - t;

  // ---------- Hilfen ----------
  const text = (t, x, yTop, { font = F.r, size = 10, color = C.ink, spacing = 0, maxWidth } = {}) => {
    let s = String(t ?? '');
    if (maxWidth) { while (s.length > 3 && font.widthOfTextAtSize(s, size) + spacing * s.length > maxWidth) s = s.slice(0, -2).trimEnd() + '…'; }
    if (spacing) {
      let cx = x;
      for (const ch of s) { page.drawText(ch, { x: cx, y: top(yTop) - size * 0.76, size, font, color }); cx += font.widthOfTextAtSize(ch, size) + spacing; }
      return cx - x;
    }
    page.drawText(s, { x, y: top(yTop) - size * 0.76, size, font, color });
    return font.widthOfTextAtSize(s, size);
  };
  const wrap = (t, font, size, maxWidth, sep = ' ') => {
    const words = String(t ?? '').split(sep);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + sep + w : w;
      if (font.widthOfTextAtSize(next, size) > maxWidth && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const rrectPath = (x, y, w, h, r) => `M ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
  // Abgerundetes Rechteck, Koordinaten von oben links
  const box = (x, yTop, w, h, { fill, stroke, r = 7, strokeWidth = 0.7 } = {}) => {
    page.drawSvgPath(rrectPath(0, 0, w, h, r), { x, y: top(yTop), color: fill, borderColor: stroke, borderWidth: stroke ? strokeWidth : 0 });
  };
  const hline = (x1, x2, yTop, color = C.line, thickness = 0.6) => page.drawLine({ start: { x: x1, y: top(yTop) }, end: { x: x2, y: top(yTop) }, thickness, color });
  const shield = (cx, cyTop, s, fill, check) => {
    const k = s / 24;
    page.drawSvgPath('M 12 2.2 L 19.6 5.2 L 19.6 12 C 19.6 16.6 16.5 20 12 21.8 C 7.5 20 4.4 16.6 4.4 12 L 4.4 5.2 Z', { x: cx - s / 2, y: top(cyTop - s / 2), scale: k, color: fill });
    page.drawSvgPath('M 8.4 12.1 L 11 14.7 L 15.8 9.4', { x: cx - s / 2, y: top(cyTop - s / 2), scale: k, borderColor: check, borderWidth: 1.9, borderLineCap: LineCapStyle.Round });
  };
  const sectionTitle = (t, x, yTop) => { text(t.toUpperCase(), x, yTop, { font: F.b, size: 7.4, color: C.blueDark, spacing: 0.9 }); };

  // ---------- Hintergrund: feiner Rahmen ----------
  page.drawRectangle({ x: 16, y: 16, width: W - 32, height: H - 32, borderColor: C.line, borderWidth: 0.8 });
  page.drawRectangle({ x: 19.5, y: 19.5, width: W - 39, height: H - 39, borderColor: C.line, borderWidth: 0.35 });

  // ---------- Kopf ----------
  const headH = 112;
  page.drawRectangle({ x: 16.4, y: top(16.4 + headH), width: W - 32.8, height: headH, color: C.navy });
  // dezente Linienstruktur im Kopf
  for (let k = 0; k < 9; k++) {
    page.drawSvgPath(`M 0 ${20 + k * 9} C 140 ${-10 + k * 9} 300 ${70 + k * 9} 563 ${10 + k * 7}`, { x: 16.4, y: top(16.4), borderColor: rgb(0.11, 0.17, 0.4), borderWidth: 0.5 });
  }
  page.drawRectangle({ x: 16.4, y: top(16.4 + headH + 3), width: W - 32.8, height: 3, color: C.blue });
  text('SIGNATURZERTIFIKAT', M, 44, { font: F.b, size: 8, color: C.sky, spacing: 2.2 });
  text('Nachweis der digitalen Signatur', M, 60, { font: F.b, size: 22, color: C.white });
  text('Dieses Zertifikat ist Bestandteil des signierten Dokuments und durch die Signatur geschützt.', M, 92, { size: 8.8, color: C.sky });
  // Siegel
  const sx = W - M - 36, sy = 16.4 + headH / 2;
  const pts = [];
  for (let k = 0; k < 40; k++) { const a = (k / 40) * Math.PI * 2, r = k % 2 ? 33 : 36.5; pts.push(`${k ? 'L' : 'M'} ${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`); }
  page.drawSvgPath(pts.join(' ') + ' Z', { x: sx, y: top(sy), color: C.blue });
  page.drawCircle({ x: sx, y: top(sy), size: 28.5, borderColor: C.white, borderWidth: 0.9, color: C.blue });
  page.drawCircle({ x: sx, y: top(sy), size: 25.5, borderColor: rgb(0.62, 0.75, 1), borderWidth: 0.4 });
  shield(sx, sy, 30, C.white, C.blue);

  // ---------- Status ----------
  let y = 16.4 + headH + 22;
  const status = 'Digital signiert und versiegelt';
  const sw = F.b.widthOfTextAtSize(status, 9.5) + 34;
  box(M, y, sw, 22, { fill: C.greenBg, r: 11 });
  page.drawCircle({ x: M + 12, y: top(y + 11), size: 5.6, color: C.green });
  page.drawSvgPath('M -2.6 0.2 L -0.8 2 L 2.7 -1.9', { x: M + 12, y: top(y + 11), borderColor: C.white, borderWidth: 1.2, borderLineCap: LineCapStyle.Round });
  text(status, M + 23, y + 6.2, { font: F.b, size: 9.5, color: C.green });
  const when = fmtLong(info.now);
  text(when, W - M - F.r.widthOfTextAtSize(when, 9.5), y + 6.2, { size: 9.5, color: C.gray });
  y += 40;

  // ---------- Unterzeichner + Unterschrift ----------
  const colGap = 14, leftW = 300, rightW = W - 2 * M - leftW - colGap, cardH = 128;
  box(M, y, leftW, cardH, { fill: C.white, stroke: C.line });
  box(M + leftW + colGap, y, rightW, cardH, { fill: C.panel, stroke: C.line });
  sectionTitle('Unterzeichner', M + 16, y + 15);
  text(info.signer.name, M + 16, y + 32, { font: F.b, size: 15.5, maxWidth: leftW - 32 });
  let ly = y + 54;
  const small = (label, value) => {
    if (!value) return;
    text(label, M + 16, ly, { size: 8.2, color: C.gray });
    text(value, M + 86, ly, { size: 8.8, maxWidth: leftW - 102 });
    ly += 15;
  };
  small('E-Mail', info.signer.email);
  small('Organisation', info.signer.organization);
  small('Grund', info.reason);
  small('Ort', info.location);
  // Unterschrift
  const rx = M + leftW + colGap;
  sectionTitle('Unterschrift', rx + 14, y + 15);
  const sigTop = y + 30, sigH = cardH - 30 - 30, sigW = rightW - 28;
  let drewImage = false;
  if (info.signatureImage) {
    try {
      const img = await doc.embedPng(info.signatureImage);
      const sc = Math.min(sigW / img.width, sigH / img.height);
      page.drawImage(img, { x: rx + 14 + (sigW - img.width * sc) / 2, y: top(sigTop + sigH) + (sigH - img.height * sc) / 2, width: img.width * sc, height: img.height * sc });
      drewImage = true;
    } catch (_) { /* dann ohne Bild */ }
  }
  if (!drewImage) {
    const nm = info.signer.name;
    let fs = 20; while (fs > 9 && F.i.widthOfTextAtSize(nm, fs) > sigW) fs -= 0.5;
    text(nm, rx + 14 + (sigW - F.i.widthOfTextAtSize(nm, fs)) / 2, sigTop + sigH / 2 - fs / 2, { font: F.i, size: fs, color: C.navy });
  }
  hline(rx + 14, rx + rightW - 14, y + cardH - 26, C.light, 0.6);
  text('Digital signiert', rx + 14, y + cardH - 20, { size: 7.4, color: C.gray });
  const idShort = info.cert.fingerprint.replace(/:/g, '').slice(0, 16);
  const idTxt = `ID ${group(idShort)}`;
  text(idTxt, rx + rightW - 14 - F.m.widthOfTextAtSize(idTxt, 6.8), y + cardH - 19.6, { font: F.m, size: 6.8, color: C.gray });
  y += cardH + 16;

  // ---------- Tabellen-Karte ----------
  const rowsCard = (title, rows) => {
    const labelW = 128, valW = W - 2 * M - labelW - 32;
    const laid = rows.filter((r) => r[1]).map(([k, v, mono]) => {
      const font = mono ? F.m : F.r, size = mono ? 8 : 9.2;
      const lines = mono ? wrap(v, font, size, valW, ' ') : wrap(v, font, size, valW);
      return { k, lines, font, size };
    });
    const h = 30 + laid.reduce((s, r) => s + Math.max(1, r.lines.length) * 12.2 + 6.4, 0) + 4;
    box(M, y, W - 2 * M, h, { fill: C.white, stroke: C.line });
    sectionTitle(title, M + 16, y + 15);
    let ry = y + 34;
    laid.forEach((r, idx) => {
      if (idx) hline(M + 16, W - M - 16, ry - 5.2, C.line, 0.4);
      text(r.k, M + 16, ry, { size: 8.2, color: C.gray });
      r.lines.forEach((l, li) => text(l, M + 16 + labelW, ry + li * 12.2 - (r.font === F.m ? -0.6 : 0.4), { font: r.font, size: r.size }));
      ry += Math.max(1, r.lines.length) * 12.2 + 6.4;
    });
    y += h + 14;
  };
  rowsCard('Dokument', [
    ['Dateiname', info.fileName],
    ['Umfang', `${info.pages} ${info.pages === 1 ? 'Seite' : 'Seiten'} zuzüglich dieses Zertifikats`],
    ['Dokument-ID', info.docId, true],
    ['Prüfsumme (SHA-256)', group(info.docHash, 8), true],
  ]);
  rowsCard('Zertifikat', [
    ['Ausgestellt für', info.signer.name + (info.signer.email ? `  ·  ${info.signer.email}` : '')],
    ['Ausgestellt von', info.cert.selfSigned ? `${info.cert.issuer} (selbst ausgestelltes Zertifikat)` : info.cert.issuer],
    ['Gültigkeit', `${fmtDate(info.cert.notBefore)} bis ${fmtDate(info.cert.notAfter)}`],
    ['Seriennummer', group(info.cert.serial, 4), true],
    ['Fingerabdruck (SHA-256)', group(info.cert.fingerprint, 4), true],
  ]);

  // ---------- Verfahren: drei Kacheln ----------
  const tiles = [
    ['Signaturformat', 'PAdES', 'ETSI EN 319 142 · CAdES detached'],
    ['Kryptografie', `RSA ${info.cert.keyBits || 3072} · SHA-256`, 'Schlüssel bleibt beim Unterzeichner'],
    ['Zeitstempel', info.tsaHost ? 'RFC 3161' : 'Gerätezeit', info.tsaHost ? info.tsaHost : 'ohne externen Zeitstempeldienst'],
  ];
  const tw = (W - 2 * M - 2 * 10) / 3, th = 58;
  tiles.forEach(([k, v, d], i) => {
    const x = M + i * (tw + 10);
    box(x, y, tw, th, { fill: C.panel, stroke: C.line });
    text(k.toUpperCase(), x + 12, y + 11, { font: F.b, size: 6.6, color: C.gray, spacing: 0.8 });
    text(v, x + 12, y + 24, { font: F.b, size: 11.5, color: C.navy, maxWidth: tw - 24 });
    text(d, x + 12, y + 41, { size: 7.4, color: C.gray, maxWidth: tw - 24 });
  });
  y += th + 18;

  // ---------- Echtheit prüfen ----------
  sectionTitle('Echtheit prüfen', M, y);
  y += 16;
  const steps = [
    'PDF in Adobe Acrobat Reader öffnen und das Fenster „Unterschriften“ einblenden, oder im PDF Editor das Werkzeug „Signatur prüfen“ verwenden.',
    'Die Signatur muss als gültig und das Dokument als unverändert angezeigt werden. Jede Änderung nach dem Signieren macht die Signatur ungültig.',
    'Den oben genannten Fingerabdruck mit dem Fingerabdruck vergleichen, den der Unterzeichner mitgeteilt hat.',
  ];
  steps.forEach((s, i) => {
    page.drawCircle({ x: M + 7, y: top(y + 5.4), size: 7, color: C.navy });
    const num = String(i + 1);
    text(num, M + 7 - F.b.widthOfTextAtSize(num, 7.6) / 2, y + 1.9, { font: F.b, size: 7.6, color: C.white });
    const lines = wrap(s, F.r, 8.6, W - 2 * M - 26);
    lines.forEach((l, li) => text(l, M + 22, y + 1 + li * 11.4, { size: 8.6, color: C.ink }));
    y += lines.length * 11.4 + 7;
  });

  // ---------- Fuß ----------
  const fy = H - 52;
  hline(M, W - M, fy, C.line, 0.6);
  shield(M + 7, fy + 15, 14, C.blue, C.white);
  text('PDF Editor', M + 19, fy + 10, { font: F.b, size: 8.4, color: C.navy });
  const legal = 'Elektronische Signatur gemäß Verordnung (EU) Nr. 910/2014 (eIDAS)';
  text(legal, M + 19 + F.b.widthOfTextAtSize('PDF Editor', 8.4) + 10, fy + 10.6, { size: 7.4, color: C.gray });
  const idFoot = info.docId;
  text(idFoot, W - M - F.m.widthOfTextAtSize(idFoot, 6.6), fy + 11.2, { font: F.m, size: 6.6, color: C.light });

  return doc.save({ useObjectStreams: false });
}
