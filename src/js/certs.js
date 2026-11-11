// Zertifikate verwalten und Signaturen prüfen
import { h, ic, modal, toast, pickFiles, busy, idle, renderOptions } from './ui.js';
import { icon } from './icons.js';
import { native, UserError } from './core.js';

const fmtDate = (s) => new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDateTime = (s) => new Date(s).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'medium' });

export async function listCerts() {
  return native.certs.list();
}

// ---------- Zertifikat erstellen ----------
export async function createCertDialog() {
  const v = { country: 'DE', years: 3 };
  try {
    const last = JSON.parse(localStorage.getItem('pdfeditor.certdefaults') || '{}');
    Object.assign(v, last);
  } catch (_) {}
  const box = h('div');
  renderOptions(box, [
    { id: 'name', label: 'Vor- und Nachname *', type: 'text', placeholder: 'Max Mustermann' },
    { id: 'email', label: 'E-Mail *', type: 'email', placeholder: 'name@beispiel.de' },
    { id: 'organization', label: 'Firma / Organisation', type: 'text' },
    { id: 'city', label: 'Ort', type: 'text' },
    { id: 'password', label: 'Passwort für das Zertifikat *', type: 'password', help: 'Schützt deinen privaten Schlüssel. Mindestens 6 Zeichen.' },
    { id: 'password2', label: 'Passwort wiederholen *', type: 'password' },
    { id: 'years', label: 'Gültigkeit', type: 'seg', choices: [{ value: 1, label: '1 Jahr' }, { value: 3, label: '3 Jahre' }, { value: 5, label: '5 Jahre' }] },
  ], v);
  const err = h('div', { class: 'error-box hidden' });
  const body = h('div', {},
    h('p', {}, 'Dein persönliches Signaturzertifikat wird nur in diesem Browser auf deinem Gerät gespeichert und nie ins Internet übertragen. Lege danach über „Sichern“ eine Kopie (.p12) an, denn beim Löschen der Browserdaten geht es sonst verloren.'),
    err, box);
  const ok = await modal({
    title: 'Neues Signaturzertifikat', body, buttons: [
      { label: 'Abbrechen', value: null },
      { label: 'Zertifikat erstellen', primary: true, value: true, validate: () => {
        const e = !v.name || !v.name.trim() ? 'Bitte Namen eingeben.'
          : !v.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email) ? 'Bitte eine gültige E-Mail eingeben.'
            : !v.password || v.password.length < 6 ? 'Das Passwort muss mindestens 6 Zeichen haben.'
              : v.password !== v.password2 ? 'Die Passwörter stimmen nicht überein.' : null;
        if (e) { err.textContent = e; err.classList.remove('hidden'); return false; }
        return true;
      } },
    ],
  });
  if (!ok) return null;
  busy('Schlüsselpaar wird erzeugt (RSA 3072) …');
  try {
    const id = await native.certs.create({ name: v.name.trim(), email: v.email.trim(), organization: (v.organization || '').trim(), city: (v.city || '').trim(), country: 'DE', password: v.password, years: +v.years });
    localStorage.setItem('pdfeditor.certdefaults', JSON.stringify({ name: v.name, email: v.email, organization: v.organization, city: v.city }));
    toast('Zertifikat erstellt.');
    return id;
  } finally { idle(); }
}

export async function importCertDialog() {
  const f = (await pickFiles(['p12', 'pfx'], false))[0];
  if (!f) return null;
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Passwort der Zertifikatsdatei' });
  const err = h('div', { class: 'error-box hidden' });
  for (;;) {
    const pw = await modal({ title: 'Zertifikat importieren', body: h('div', {}, h('p', {}, `„${f.name}“`), err, input), buttons: [{ label: 'Abbrechen', value: null }, { label: 'Importieren', primary: true, value: () => input.value }] });
    if (pw === null) return null;
    try {
      busy('Zertifikat wird importiert …');
      const id = await native.certs.import(f.data, pw);
      toast('Zertifikat importiert.');
      return id;
    } catch (e) {
      err.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      err.classList.remove('hidden');
    } finally { idle(); }
  }
}

// Passwort abfragen
export async function unlockCert(cert) {
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Zertifikatspasswort' });
  const err = h('div', { class: 'error-box hidden' });
  for (;;) {
    const pw = await modal({
      title: 'Mit Zertifikat signieren',
      body: h('div', {}, h('p', {}, `Signieren als ${cert.name}${cert.email ? ` <${cert.email}>` : ''}`), err, input),
      buttons: [{ label: 'Abbrechen', value: null }, { label: 'Signieren', primary: true, value: () => input.value }],
    });
    if (pw === null) return null;
    const r = await native.certs.checkPassword(cert.id, pw);
    if (r.ok) return { password: pw };
    err.textContent = r.wrongPassword ? 'Das Passwort ist falsch.' : r.error;
    err.classList.remove('hidden');
    input.value = '';
  }
}

function certCard(c, onChange) {
  const expired = new Date(c.notAfter) < new Date();
  return h('div', { class: 'cert-card' },
    h('div', { class: 'cert-icon', html: icon(c.selfSigned ? 'shield-check' : 'file-check', 22) }),
    h('div', { class: 'cert-main' },
      h('div', { class: 'cert-name' }, c.name, c.email ? h('span', { class: 'muted' }, ` · ${c.email}`) : null),
      h('div', { class: 'cert-meta' },
        c.organization ? `${c.organization} · ` : '',
        c.selfSigned ? 'Selbst ausgestellt' : `Ausgestellt von ${c.issuer}`,
        ` · gültig bis ${fmtDate(c.notAfter)}`,
        expired ? h('span', { style: { color: 'var(--danger)' } }, ' (abgelaufen)') : null),
      h('div', { class: 'cert-fp', title: 'SHA-256 Fingerabdruck' }, c.fingerprint)),
    h('div', { class: 'cert-actions' },
      h('button', { class: 'btn small', title: 'Öffentliches Zertifikat (.cer) für Empfänger exportieren', onclick: async () => {
        const u = await unlockCert(c); if (!u) return;
        const p = await native.certs.exportPublic(c.id, u.password); if (p) toast('Öffentliches Zertifikat gespeichert.');
      } }, ic('download', 15), '.cer'),
      h('button', { class: 'btn small', title: 'Sicherungskopie inkl. privatem Schlüssel (.p12)', onclick: async () => { const p = await native.certs.exportP12(c.id); if (p) toast('Sicherung gespeichert.'); } }, ic('archive', 15), 'Sichern'),
      h('button', { class: 'btn small danger', onclick: async () => {
        const ok = await modal({ title: 'Zertifikat löschen?', body: h('p', {}, `Das Zertifikat „${c.name}“ wird aus diesem Browser entfernt. Bereits signierte Dokumente bleiben gültig. Ohne Sicherung (.p12) kann es nicht wiederhergestellt werden.`), buttons: [{ label: 'Abbrechen', value: false }, { label: 'Löschen', primary: true, value: true }] });
        if (ok) { await native.certs.remove(c.id); onChange(); }
      } }, ic('trash-2', 15))));
}

export function legalInfo() {
  return h('div', { class: 'info-box legal' },
    h('strong', {}, 'Rechtlicher Rahmen (eIDAS-Verordnung): '),
    'Die Signatur ist eine kryptografische PAdES-Signatur (ETSI EN 319 142) mit SHA-256, RSA 3072 und RFC 3161 Zeitstempel. Sie ist eindeutig dem Zertifikat zugeordnet, und jede spätere Änderung am Dokument wird erkannt. ',
    'Mit einem selbst erstellten Zertifikat ist das eine elektronische Signatur, die in der EU rechtswirksam ist und vor Gericht als Beweis zugelassen werden muss (Art. 25 eIDAS). Sie genügt für alle formfreien Verträge und für die Textform (z. B. Maklervertrag nach § 656a BGB). ',
    'Die qualifizierte elektronische Signatur (QES), die die gesetzliche Schriftform ersetzt, kann keine App selbst erzeugen: Dafür braucht es eine Identitätsprüfung und ein qualifiziertes Zertifikat eines EU-Vertrauensdiensteanbieters (z. B. D-Trust, Swisscom, Namirial), dessen Schlüssel in einer zertifizierten Signaturerstellungseinheit liegt. Zertifikate solcher Anbieter (.p12) kannst du hier importieren, dann ist auch die Identität durch die Stelle bestätigt.');
}

// ---------- Seite: Zertifikate verwalten ----------
export async function mountCertsPage(root) {
  const main = h('div', { class: 'tool-main' });
  root.append(main);
  const wrap = h('div', { style: { maxWidth: '860px', margin: '0 auto' } });
  main.append(wrap);
  async function draw() {
    const list = await listCerts();
    wrap.innerHTML = '';
    wrap.append(h('div', { class: 'list-toolbar' },
      h('div', { class: 'hint' }, `${list.length} ${list.length === 1 ? 'Zertifikat' : 'Zertifikate'} in diesem Browser`), h('div', { class: 'grow' }),
      h('button', { class: 'btn small', onclick: async () => { if (await importCertDialog()) draw(); } }, ic('upload', 15), 'Importieren (.p12)'),
      h('button', { class: 'btn primary small', onclick: async () => { if (await createCertDialog()) draw(); } }, ic('plus', 15), 'Neues Zertifikat')));
    if (!list.length) wrap.append(h('div', { class: 'dropzone', style: { minHeight: '200px' } }, h('div', { class: 'dz-icon', html: icon('shield-check', 30) }), h('h3', {}, 'Noch kein Zertifikat'), h('p', {}, 'Erstelle dein persönliches Signaturzertifikat, um PDFs digital zu signieren.')));
    for (const c of list) wrap.append(certCard(c, draw));
    wrap.append(legalInfo());
    wrap.append(h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Tipp: Gib Empfängern dein öffentliches Zertifikat (.cer) oder den Fingerabdruck. Damit können sie in Adobe Acrobat deine Identität dauerhaft als vertrauenswürdig markieren.'));
  }
  draw();
}

// ---------- Seite: Signatur prüfen ----------
export async function mountVerify(root, api) {
  const f = api.files[0];
  const main = h('div', { class: 'tool-main' });
  root.append(main);
  const wrap = h('div', { style: { maxWidth: '860px', margin: '0 auto' } });
  main.append(wrap);
  wrap.append(h('div', { class: 'list-toolbar' }, h('div', { class: 'hint' }, f.name), h('div', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => { api.files.length = 0; api.render(); } }, 'Andere Datei prüfen')));
  busy('Signaturen werden geprüft …');
  let results;
  try { results = await native.verifyPdf(f.data); } finally { idle(); }
  if (!results.length) {
    wrap.append(h('div', { class: 'verify-card neutral' }, h('div', { class: 'vc-head' }, h('span', { class: 'vc-icon', html: icon('info', 26) }), h('div', {}, h('h3', {}, 'Keine digitale Signatur gefunden'), h('p', {}, 'Dieses Dokument enthält keine kryptografische Signatur. Eine nur eingefügte Unterschrift (Bild) kann nicht auf Echtheit geprüft werden.')))));
    return;
  }
  const allOk = results.every((r) => r.ok);
  const last = results[results.length - 1];
  wrap.append(h('div', { class: `verify-summary ${allOk ? 'good' : 'bad'}` },
    h('span', { html: icon(allOk ? 'shield-check' : 'x', 22) }),
    allOk ? (last.changesAfter === 'modified' ? 'Signaturen gültig, aber das Dokument wurde nach der letzten Signatur verändert.' : `${results.length === 1 ? 'Die Signatur ist' : `Alle ${results.length} Signaturen sind`} gültig. Das Dokument wurde seit dem Signieren nicht verändert.`)
      : 'Achtung: Mindestens eine Signatur ist ungültig. Das Dokument wurde nach dem Signieren verändert oder die Signatur ist beschädigt.'));
  results.forEach((r, i) => {
    const s = r.signer || {};
    const rows = [];
    const row = (k, v, cls = '') => rows.push(h('div', { class: 'vrow' }, h('div', { class: 'vk' }, k), h('div', { class: `vv ${cls}` }, v)));
    row('Unterzeichner', `${s.name || '–'}${s.email ? ` <${s.email}>` : ''}`);
    if (s.organization) row('Organisation', s.organization);
    row('Dokument unverändert', r.integrity ? 'Ja, der signierte Inhalt ist unverändert (SHA-256 stimmt)' : 'Nein, der Inhalt wurde verändert', r.integrity ? 'good' : 'bad');
    row('Kryptografische Signatur', r.signatureValid ? 'Gültig' : 'Ungültig', r.signatureValid ? 'good' : 'bad');
    if (r.timestamp && !r.timestamp.error) row('Zeitstempel', `${fmtDateTime(r.timestamp.time)} · ${r.timestamp.tsa || 'Zeitstempeldienst'} · ${r.timestamp.imprintOk && r.timestamp.signatureOk ? 'bestätigt' : 'nicht bestätigt'}`, r.timestamp.imprintOk && r.timestamp.signatureOk ? 'good' : 'bad');
    else row('Zeitpunkt', r.pdfDate ? `${pdfDateToLocal(r.pdfDate)} (Angabe des Unterzeichners, kein unabhängiger Zeitstempel)` : 'unbekannt', 'warn');
    row('Zertifikat', `${s.selfSigned ? 'Selbst ausgestellt' : `Ausgestellt von ${s.issuer}`} · gültig ${fmtDate(s.notBefore)} bis ${fmtDate(s.notAfter)}${r.certValidAtSigning ? '' : ' · beim Signieren NICHT gültig'}`, r.certValidAtSigning ? '' : 'bad');
    if (r.trust) row('Vertrauen', r.trust.trusted ? 'Zertifikat ist von einer vertrauenswürdigen Stelle ausgestellt' : s.selfSigned ? 'Identität nicht von einer Zertifizierungsstelle bestätigt. Fingerabdruck mit dem Unterzeichner abgleichen.' : 'Ausstellende Stelle ist nicht als vertrauenswürdig hinterlegt', r.trust.trusted ? 'good' : 'warn');
    else if (s.selfSigned) row('Identität', 'Selbst ausgestellt: Fingerabdruck mit dem Unterzeichner abgleichen.', 'warn');
    row('Fingerabdruck SHA-256', h('code', {}, s.fingerprint || '–'));
    row('Format', `${r.subFilter || '–'}${r.pades ? ' · PAdES konform' : ''}`);
    row('Spätere Änderungen', r.changesAfter === 'none' ? 'Keine, die Signatur deckt das gesamte Dokument ab' : r.changesAfter === 'signatures' ? 'Danach wurden weitere Signaturen hinzugefügt' : 'Das Dokument wurde nach dieser Signatur verändert', r.changesAfter === 'modified' ? 'warn' : '');
    if (r.problems && r.problems.length) row('Hinweise', r.problems.join('; '), 'bad');
    wrap.append(h('div', { class: `verify-card ${r.ok ? 'good' : 'bad'}` },
      h('div', { class: 'vc-head' }, h('span', { class: 'vc-icon', html: icon(r.ok ? 'shield-check' : 'x', 26) }),
        h('div', {}, h('h3', {}, `Signatur ${i + 1}: ${r.ok ? 'gültig' : 'UNGÜLTIG'}`), h('p', {}, s.name || ''))),
      h('div', { class: 'vrows' }, rows)));
  });
}

function pdfDateToLocal(d) {
  const m = /D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(d);
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6]}` : d;
}

void UserError;
