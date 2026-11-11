// Kleine UI-Bausteine
import { icon } from './icons.js';
import { openPdf, renderPage } from './pdf.js';
import { ext, formatBytes, decrypt, isEncrypted, isWrongPassword, repair, native, UserError } from './core.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export function ic(name, size) {
  const s = document.createElement('span');
  s.style.display = 'inline-flex';
  s.innerHTML = icon(name, size);
  return s;
}

// ---------- Overlay / Fortschritt ----------
const overlay = () => document.getElementById('overlay');
export function busy(text = 'Wird verarbeitet …', value = null) {
  overlay().classList.remove('hidden');
  document.getElementById('overlayText').textContent = text;
  const bar = document.getElementById('overlayBar');
  const prog = bar.parentElement;
  if (value === null || value === undefined) prog.classList.add('indeterminate');
  else { prog.classList.remove('indeterminate'); bar.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`; }
}
export function idle() {
  overlay().classList.add('hidden');
}

export function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3200);
}

// ---------- Modal ----------
export function modal({ title, body, buttons = [], wide = false, onClose }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', key); onClose && onClose(v); resolve(v); };
    const foot = h('div', { class: 'modal-foot' });
    for (const b of buttons) {
      foot.append(h('button', { class: `btn ${b.primary ? 'primary' : ''}`, onclick: async () => {
        if (b.validate && !(await b.validate())) return;
        close(typeof b.value === 'function' ? b.value() : b.value);
      } }, b.label));
    }
    const key = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); foot.querySelector('.btn.primary').click(); }
      }
    };
    document.addEventListener('keydown', key);
    back.append(h('div', { class: `modal ${wide ? 'wide' : ''}` }, h('div', { class: 'modal-head' }, title), h('div', { class: 'modal-body' }, body), buttons.length ? foot : null));
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    document.body.append(back);
    setTimeout(() => { const i = back.querySelector('input,textarea'); if (i) i.focus(); }, 30);
  });
}

export async function askPassword(fileName, wrong = false) {
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Passwort' });
  return modal({
    title: 'Passwort erforderlich',
    body: h('div', {},
      h('p', {}, `„${fileName}“ ist mit einem Passwort geschützt.`),
      wrong ? h('div', { class: 'error-box' }, 'Das Passwort ist falsch. Bitte erneut versuchen.') : null,
      input),
    buttons: [{ label: 'Abbrechen', value: null }, { label: 'Öffnen', primary: true, value: () => input.value }],
  });
}

// ---------- Dateien ----------
export const ACCEPT = {
  pdf: ['pdf'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'svg', 'avif', 'ico'],
  word: ['doc', 'docx', 'odt', 'rtf', 'pages', 'docm', 'dotx', 'wpd'],
  excel: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'numbers', 'tsv'],
  ppt: ['ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key'],
  html: ['html', 'htm', 'xhtml'],
  text: ['txt', 'md', 'log', 'json', 'xml', 'csv', 'eml'],
  epub: ['epub'],
  djvu: ['djvu', 'djv'],
};
ACCEPT.any = [...new Set([...ACCEPT.pdf, ...ACCEPT.image, ...ACCEPT.word, ...ACCEPT.excel, ...ACCEPT.ppt, ...ACCEPT.html, ...ACCEPT.text, ...ACCEPT.epub, ...ACCEPT.djvu])];

export function acceptList(kind) {
  if (Array.isArray(kind)) return [...new Set(kind.flatMap((k) => ACCEPT[k] || [k]))];
  return ACCEPT[kind] || ACCEPT.pdf;
}

export function makeFile(name, data, path = '') {
  return { id: Math.random().toString(36).slice(2), name, path, data: data instanceof Uint8Array ? data : new Uint8Array(data), size: data.byteLength ?? data.length };
}

export async function filesFromDrop(dt) {
  const out = [];
  for (const f of dt.files) {
    const data = new Uint8Array(await f.arrayBuffer());
    out.push(makeFile(f.name, data, native.pathForFile(f)));
  }
  return out;
}

export async function pickFiles(kind, multiple = true) {
  const exts = acceptList(kind);
  const r = await native.openFiles({ multiple, filters: [{ name: 'Unterstützte Dateien', extensions: exts }] });
  return r.map((f) => makeFile(f.name, f.data, f.path));
}

// Bereitet eine PDF vor: entsperrt (mit Passwortabfrage) und repariert bei Bedarf
export async function preparePdf(file) {
  if (ext(file.name) !== 'pdf' && !(file.data[0] === 0x25 && file.data[1] === 0x50)) return file;
  let enc;
  try { enc = await isEncrypted(file.data); }
  catch (_) {
    // beschädigt -> reparieren
    try {
      const fixed = await repair(file.data);
      file.data = fixed; file.size = fixed.length; file.repaired = true;
      enc = await isEncrypted(fixed);
    } catch (e) {
      throw new UserError(`„${file.name}“ ist keine gültige PDF-Datei oder beschädigt.`);
    }
  }
  if (!enc) return file;
  // Verschlüsselt: erst ohne Passwort (nur Berechtigungsschutz) versuchen
  try {
    const d = await decrypt(file.data, '');
    file.data = d; file.size = d.length; file.unlocked = true;
    return file;
  } catch (e) {
    if (!isWrongPassword(e)) throw new UserError(`„${file.name}“ konnte nicht geöffnet werden: ${e.message}`);
  }
  let wrong = false;
  for (;;) {
    idle();
    const pw = await askPassword(file.name, wrong);
    if (pw === null) throw new UserError(`„${file.name}“ wurde nicht geöffnet (kein Passwort).`);
    busy('Datei wird entsperrt …');
    try {
      const d = await decrypt(file.data, pw);
      file.data = d; file.size = d.length; file.unlocked = true; file.password = pw;
      return file;
    } catch (e) {
      if (!isWrongPassword(e)) throw new UserError(e.message);
      wrong = true;
    }
  }
}

// ---------- Vorschaubilder ----------
const docCache = new WeakMap();
export async function getPdfDoc(file) {
  let p = docCache.get(file.data);
  if (!p) { p = openPdf(file.data); docCache.set(file.data, p); }
  return p;
}

export async function thumbnailInto(container, file, pageIndex = 0, maxSize = 150, extraRotation = 0) {
  container.innerHTML = '';
  const e = ext(file.name);
  if (ACCEPT.image.includes(e) && !['heic', 'heif', 'tif', 'tiff'].includes(e)) {
    const url = URL.createObjectURL(new Blob([file.data]));
    const img = h('img', { src: url });
    container.append(img);
    return;
  }
  if (e !== 'pdf') {
    const iconName = ACCEPT.word.includes(e) ? 'file-text' : ACCEPT.excel.includes(e) ? 'sheet' : ACCEPT.ppt.includes(e) ? 'presentation' : ACCEPT.html.includes(e) ? 'code' : ACCEPT.djvu.includes(e) ? 'book-open' : 'file';
    container.append(h('div', { style: { textAlign: 'center' } }, ic(iconName, 40), h('div', { style: { fontSize: '12px', fontWeight: 650, marginTop: '4px' } }, e.toUpperCase())));
    return;
  }
  try {
    const doc = await getPdfDoc(file);
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1, rotation: (page.rotate + extraRotation) % 360 });
    const scale = (maxSize * (window.devicePixelRatio || 1)) / Math.max(vp.width, vp.height);
    const { canvas } = await renderPage(doc, pageIndex, scale, { extraRotation });
    canvas.style.width = `${canvas.width / (window.devicePixelRatio || 1)}px`;
    container.append(canvas);
  } catch (err) {
    container.append(h('div', { class: 'muted' }, 'Keine Vorschau'));
  }
}

export function fileMeta(file) {
  return formatBytes(file.size);
}

// ---------- Formular-Steuerelemente ----------
export function renderOptions(container, options, values, onChange) {
  container.innerHTML = '';
  const rows = [];
  const update = () => { for (const r of rows) r.el.classList.toggle('hidden', r.opt.showIf ? !r.opt.showIf(values) : false); };
  for (const opt of options) {
    if (!(opt.id in values) && opt.default !== undefined) values[opt.id] = typeof opt.default === 'function' ? opt.default() : opt.default;
    const field = h('div', { class: 'field' });
    const set = (v) => { values[opt.id] = v; update(); onChange && onChange(opt.id, v); };
    if (opt.type === 'checkbox') {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !!values[opt.id];
      cb.addEventListener('change', () => set(cb.checked));
      field.append(h('label', { class: 'check' }, cb, opt.label));
    } else {
      if (opt.label) field.append(h('div', { class: 'label' }, opt.label));
      if (opt.type === 'seg' || opt.type === 'radio') {
        const seg = h('div', { class: `seg ${opt.vertical ? 'vertical' : ''}` });
        for (const c of opt.choices) {
          const b = h('button', { type: 'button', class: values[opt.id] === c.value ? 'on' : '' }, c.label, c.help ? h('small', {}, c.help) : null);
          b.addEventListener('click', () => { seg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); set(c.value); });
          seg.append(b);
        }
        field.append(seg);
      } else if (opt.type === 'select') {
        const s = h('select', { class: 'input' }, ...opt.choices.map((c) => h('option', { value: c.value }, c.label)));
        s.value = values[opt.id];
        s.addEventListener('change', () => set(s.value));
        field.append(s);
      } else if (opt.type === 'range') {
        const r = h('input', { type: 'range', min: opt.min, max: opt.max, step: opt.step || 1 });
        r.value = values[opt.id];
        const val = h('span', { class: 'val' }, (opt.format || ((x) => x))(values[opt.id]));
        r.addEventListener('input', () => { val.textContent = (opt.format || ((x) => x))(+r.value); set(+r.value); });
        field.append(h('div', { class: 'range-row' }, r, val));
      } else if (opt.type === 'textarea') {
        const t = h('textarea', { class: 'input', placeholder: opt.placeholder || '' });
        t.value = values[opt.id] || '';
        t.addEventListener('input', () => set(t.value));
        field.append(t);
      } else if (opt.type === 'position') {
        const grid = h('div', { class: 'pos-grid' });
        for (const p of ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']) {
          if (opt.only && !opt.only.includes(p)) { grid.append(h('span')); continue; }
          const b = h('button', { type: 'button', class: values[opt.id] === p ? 'on' : '', title: p });
          b.addEventListener('click', () => { grid.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); set(p); });
          grid.append(b);
        }
        field.append(grid);
      } else if (opt.type === 'file') {
        const name = h('span', { class: 'hint' }, values[opt.id] ? values[opt.id].name : 'Keine Datei gewählt');
        const btn = h('button', { class: 'btn small', type: 'button' }, ic('upload', 16), 'Datei wählen');
        btn.addEventListener('click', async () => {
          const f = await pickFiles(opt.accept || 'pdf', false);
          if (f[0]) {
            try { busy('Datei wird geladen …'); if (opt.accept === 'pdf' || !opt.accept) await preparePdf(f[0]); name.textContent = f[0].name; set(f[0]); }
            catch (e) { toast(e.message, 'error'); }
            finally { idle(); }
          }
        });
        field.append(h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, btn, name));
      } else {
        const i = h('input', { class: 'input', type: opt.type || 'text', placeholder: opt.placeholder || '', min: opt.min, max: opt.max, step: opt.step });
        if (opt.type === 'password') i.autocomplete = 'new-password';
        i.value = values[opt.id] ?? '';
        i.addEventListener('input', () => set(opt.type === 'number' ? (i.value === '' ? '' : +i.value) : i.value));
        field.append(i);
      }
    }
    if (opt.help) field.append(h('div', { class: 'help' }, opt.help));
    container.append(field);
    rows.push({ el: field, opt });
  }
  update();
}
