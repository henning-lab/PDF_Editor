// PDF Editor: Bearbeiten, Unterschreiben, Schwärzen
import { h, ic, toast, getPdfDoc, pickFiles, renderOptions, busy, idle } from './ui.js';
import { icon } from './icons.js';
import { renderPage, canvasToBytes, pageTextItems, openPdf } from './pdf.js';
import { PDFDocument, rgb, degrees, loadDoc, saveDoc, stampPages, getFont, hexToRgb, baseName, ext, native, UserError, imageToPng, sniffImage, displayBox, reencodeJpeg } from './core.js';
import { createSignature } from './signature.js';
import { listCerts, createCertDialog, importCertDialog, unlockCert, legalInfo } from './certs.js';
import { modal } from './ui.js';

const FONT_CSS = { Helvetica: 'Helvetica, Arial, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };

const TOOLSETS = {
  edit: [
    ['select', 'mouse-pointer-2', 'Auswählen'], ['text', 'type', 'Text'], ['image', 'image', 'Bild'], ['signature', 'signature', 'Unterschrift'],
    ['rect', 'square', 'Rechteck'], ['ellipse', 'circle', 'Ellipse'], ['line', 'minus', 'Linie'], ['arrow', 'move-up-right', 'Pfeil'],
    ['pen', 'pencil', 'Freihand'], ['highlight', 'highlighter', 'Markieren'], ['whiteout', 'eraser', 'Abdecken'],
  ],
  sign: [['select', 'mouse-pointer-2', 'Auswählen'], ['signature', 'signature', 'Unterschrift'], ['text', 'type', 'Text'], ['date', 'list-ordered', 'Datum'], ['check', 'check', 'Häkchen'], ['image', 'image', 'Bild']],
  redact: [['select', 'mouse-pointer-2', 'Auswählen'], ['redact', 'square', 'Bereich schwärzen']],
};
const DRAW_TOOLS = ['rect', 'ellipse', 'line', 'arrow', 'pen', 'highlight', 'whiteout', 'redact'];

export async function mountEditor(root, api, mode) {
  const file = api.files[0];
  const pdf = await getPdfDoc(file);
  const N = pdf.numPages;
  const pageSizes = [];
  for (let i = 0; i < N; i++) {
    const p = await pdf.getPage(i + 1);
    const vp = p.getViewport({ scale: 1 });
    pageSizes.push({ w: vp.width, h: vp.height });
  }
  const st = api.values;
  st.objects = st.objects || [];
  st.defaults = st.defaults || {
    color: mode === 'sign' ? '#0b1f66' : '#d32f2f', fill: '#ffeb3b', fillOn: false, width: 2, opacity: 100,
    font: 'Helvetica', size: 14, textColor: '#111111', bold: false, italic: false, hlColor: '#ffeb3b', penColor: '#1e40af', penWidth: 2.5,
  };
  st.redactOpts = st.redactOpts || { secure: true, dpi: 200, stripMeta: true };
  st.digital = st.digital || { enabled: api.tool.id === 'digisign', certId: null, reason: 'Ich stimme dem Inhalt dieses Dokuments zu.', location: '', timestamp: true, protocol: true, caption: true, stamp: true };
  let certList = [];
  async function refreshCerts() {
    certList = mode === 'sign' ? await listCerts() : [];
    if (!certList.find((c) => c.id === st.digital.certId)) st.digital.certId = certList[0] ? certList[0].id : null;
  }
  await refreshCerts();
  const objects = st.objects;
  const D = st.defaults;
  let tool = 'select';
  let zoom = st.zoom || Math.min(1.6, Math.max(0.6, (root.clientWidth - 150 - 270 - 80) / Math.max(...pageSizes.map((p) => p.w))));
  let selectedId = null;
  let editingId = null;
  const undoStack = [];
  const urls = new Map();
  let curPage = 0;

  const clone = () => objects.map((o) => ({ ...o, points: o.points ? o.points.map((p) => [...p]) : undefined }));
  const pushUndo = () => { undoStack.push(clone()); if (undoStack.length > 80) undoStack.shift(); };
  const byId = (id) => objects.find((o) => o.id === id);
  const newId = () => 'o' + Math.random().toString(36).slice(2, 9);

  // ---------- Layout ----------
  const ed = h('div', { class: 'editor', style: { flex: 1, minWidth: 0 } });
  const tb = h('div', { class: `editor-toolbar ${TOOLSETS[mode].length > 7 ? 'many' : ''}` });
  const body = h('div', { class: 'editor-body' });
  const thumbs = h('div', { class: 'editor-thumbs' });
  const canvasArea = h('div', { class: 'editor-canvas' });
  const pagesEl = h('div', { class: 'editor-pages' });
  canvasArea.append(pagesEl);
  const side = h('div', { class: 'editor-side' });
  body.append(thumbs, canvasArea, side);
  ed.append(tb, body);
  root.append(ed);

  // ---------- Werkzeugleiste ----------
  const toolBtns = {};
  for (const [id, ico, label] of TOOLSETS[mode]) {
    const b = h('button', { class: 'tb-btn', title: label, onclick: () => setTool(id) }, ic(ico, 17), h('span', { class: 'tb-label' }, label));
    toolBtns[id] = b;
    tb.append(b);
  }
  tb.append(h('div', { class: 'tb-sep' }));
  tb.append(h('button', { class: 'tb-btn', title: 'Rückgängig (⌘Z)', onclick: undo }, ic('undo-2', 17)));
  tb.append(h('button', { class: 'tb-btn', title: 'Auswahl löschen (Entf)', onclick: deleteSelected }, ic('trash-2', 17)));
  tb.append(h('div', { class: 'tb-sep' }));
  const zoomLabel = h('span', { class: 'kbd', style: { minWidth: '44px', textAlign: 'center' } });
  tb.append(h('button', { class: 'tb-btn', title: 'Verkleinern', onclick: () => setZoom(zoom / 1.2) }, ic('zoom-out', 17)), zoomLabel, h('button', { class: 'tb-btn', title: 'Vergrößern', onclick: () => setZoom(zoom * 1.2) }, ic('zoom-in', 17)));
  if (mode === 'redact') {
    tb.append(h('div', { class: 'tb-sep' }));
    const q = h('input', { class: 'input', placeholder: 'Text suchen und schwärzen …', style: { width: '220px', height: '30px' } });
    const go = () => searchRedact(q.value);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    tb.append(h('div', { class: 'tb-group' }, q, h('button', { class: 'btn small', onclick: go }, ic('search', 15), 'Alle schwärzen')));
  }

  // ---------- Seitenleiste (Eigenschaften) ----------
  const sideScroll = h('div', { class: 'side-scroll' });
  const sideFoot = h('div', { class: 'side-foot' });
  side.append(sideScroll, sideFoot);
  const saveBtn = h('button', { class: 'btn primary big', onclick: save }, mode === 'redact' ? 'Schwärzen & speichern' : 'Speichern');
  sideFoot.append(saveBtn, h('button', { class: 'btn small ghost', style: { width: '100%', marginTop: '8px' }, onclick: () => { api.files.length = 0; Object.keys(st).forEach((k) => delete st[k]); api.render(); } }, 'Andere Datei öffnen'));

  function digitalPanel() {
    const d = st.digital;
    const box = h('div', { class: 'digital-box' });
    box.append(h('div', { class: 'side-title' }, 'Digitale Signatur'));
    const optBox = h('div');
    renderOptions(optBox, [{ id: 'enabled', label: 'Mit Zertifikat digital signieren (PAdES)', type: 'checkbox' }], d, () => renderProps());
    box.append(optBox);
    if (!d.enabled) {
      box.append(h('div', { class: 'help' }, 'Fälschungssicher: Jede spätere Änderung am Dokument wird erkannt, Signierende und Zeitpunkt sind nachweisbar.'));
      return box;
    }
    if (!certList.length) {
      box.append(h('div', { class: 'hint', style: { margin: '6px 0 10px' } }, 'Du hast noch kein Signaturzertifikat.'),
        h('div', { class: 'size-row' },
          h('button', { class: 'btn small primary', onclick: async () => { const id = await createCertDialog(); if (id) { await refreshCerts(); d.certId = id; renderProps(); } } }, 'Erstellen'),
          h('button', { class: 'btn small', onclick: async () => { const id = await importCertDialog(); if (id) { await refreshCerts(); d.certId = id; renderProps(); } } }, 'Importieren')));
      return box;
    }
    const sel = h('select', { class: 'input' }, ...certList.map((c) => h('option', { value: c.id }, `${c.name}${c.email ? ` (${c.email})` : ''}`)));
    sel.value = d.certId;
    sel.addEventListener('change', () => { d.certId = sel.value; });
    box.append(h('div', { class: 'field' }, h('div', { class: 'label' }, 'Zertifikat'), sel,
      h('div', { class: 'size-row' },
        h('button', { class: 'btn small', onclick: async () => { const id = await createCertDialog(); if (id) { await refreshCerts(); d.certId = id; renderProps(); } } }, 'Neu'),
        h('button', { class: 'btn small', onclick: async () => { const id = await importCertDialog(); if (id) { await refreshCerts(); d.certId = id; renderProps(); } } }, 'Importieren'))));
    const more = h('div');
    renderOptions(more, [
      { id: 'reason', label: 'Grund', type: 'text' },
      { id: 'location', label: 'Ort', type: 'text', placeholder: 'z. B. Hannover' },
      { id: 'caption', label: 'Name und Datum unter der Unterschrift', type: 'checkbox' },
      { id: 'stamp', label: 'Sichtbarer Signaturstempel, falls keine Unterschrift platziert ist', type: 'checkbox' },
      { id: 'timestamp', label: 'Zeitstempel von einem unabhängigen Zeitstempeldienst', type: 'checkbox' },
      { id: 'protocol', label: 'Signaturzertifikat als letzte Seite anhängen', type: 'checkbox' },
    ], d);
    box.append(more, h('a', { href: '#', class: 'help', style: { display: 'inline-block', color: 'var(--accent)' }, onclick: (e) => { e.preventDefault(); modal({ title: 'Rechtliche Einordnung', body: legalInfo(), wide: true, buttons: [{ label: 'OK', primary: true, value: true }] }); } }, 'Wie rechtssicher ist das?'));
    return box;
  }

  function renderProps() {
    sideScroll.innerHTML = '';
    const o = byId(selectedId);
    const kind = o ? o.type : tool;
    const add = (title, opts, target, apply) => {
      sideScroll.append(h('div', { class: 'side-title' }, title));
      const box = h('div');
      renderOptions(box, opts, target, (id, val) => { if (o) { pushUndo(); apply ? apply(id, val) : (o[id] = val); updateObj(o); } });
      sideScroll.append(box);
    };
    if (mode === 'redact') {
      sideScroll.append(h('div', { class: 'info-box' }, 'Ziehe Rechtecke über vertrauliche Stellen oder suche oben nach Text. Beim Speichern werden die markierten Bereiche dauerhaft entfernt.'));
      const box = h('div');
      renderOptions(box, [
        { id: 'secure', label: 'Sicher schwärzen (betroffene Seiten werden zu Bildern, darunterliegender Text wird entfernt)', type: 'checkbox' },
        { id: 'dpi', label: 'Bildqualität geschwärzter Seiten', type: 'seg', choices: [{ value: 150, label: 'Normal' }, { value: 200, label: 'Hoch' }, { value: 300, label: 'Sehr hoch' }], showIf: (v) => v.secure },
        { id: 'stripMeta', label: 'Metadaten (Autor, Titel …) entfernen', type: 'checkbox' },
      ], st.redactOpts);
      sideScroll.append(h('div', { class: 'side-title' }, 'Optionen'), box);
      const cnt = objects.filter((x) => x.type === 'redact').length;
      sideScroll.append(h('div', { class: 'hint' }, `${cnt} ${cnt === 1 ? 'Bereich' : 'Bereiche'} markiert`));
      return;
    }
    if (kind === 'text' || kind === 'date' || kind === 'check') {
      const target = o || D;
      const map = o ? { font: 'font', size: 'size', color: 'color', bold: 'bold', italic: 'italic' } : { font: 'font', size: 'size', color: 'textColor', bold: 'bold', italic: 'italic' };
      add(o ? 'Text' : 'Neuer Text', [
        { id: map.font, label: 'Schrift', type: 'select', choices: Object.keys(FONT_CSS).map((f) => ({ value: f, label: f })) },
        { id: map.size, label: 'Größe (pt)', type: 'number', min: 4, max: 300 },
        { id: map.color, label: 'Farbe', type: 'color' },
        { id: map.bold, label: 'Fett', type: 'checkbox' }, { id: map.italic, label: 'Kursiv', type: 'checkbox' },
      ], target);
      if (!o) sideScroll.append(h('div', { class: 'hint' }, 'Klicke auf die Seite, um Text zu schreiben. Doppelklick auf vorhandenen Text zum Bearbeiten.'));
    } else if (['rect', 'ellipse'].includes(kind)) {
      const target = o || D;
      add(o ? 'Form' : 'Neue Form', [
        { id: 'color', label: 'Rahmenfarbe', type: 'color' }, { id: 'width', label: 'Rahmenstärke', type: 'range', min: 0, max: 20, step: 0.5, format: (x) => `${x} pt` },
        { id: 'fillOn', label: 'Füllung', type: 'checkbox' }, { id: 'fill', label: 'Füllfarbe', type: 'color', showIf: (v) => v.fillOn },
        { id: 'opacity', label: 'Deckkraft', type: 'range', min: 5, max: 100, format: (x) => `${x} %` },
      ], target);
    } else if (['line', 'arrow'].includes(kind)) {
      add(o ? 'Linie' : 'Neue Linie', [{ id: 'color', label: 'Farbe', type: 'color' }, { id: 'width', label: 'Stärke', type: 'range', min: 0.5, max: 20, step: 0.5, format: (x) => `${x} pt` }, { id: 'opacity', label: 'Deckkraft', type: 'range', min: 5, max: 100, format: (x) => `${x} %` }], o || D);
    } else if (kind === 'pen') {
      const map = o ? { c: 'color', w: 'width' } : { c: 'penColor', w: 'penWidth' };
      add(o ? 'Zeichnung' : 'Freihand', [{ id: map.c, label: 'Farbe', type: 'color' }, { id: map.w, label: 'Stärke', type: 'range', min: 0.5, max: 20, step: 0.5, format: (x) => `${x} pt` }, { id: 'opacity', label: 'Deckkraft', type: 'range', min: 5, max: 100, format: (x) => `${x} %` }], o || D);
    } else if (kind === 'highlight') {
      add('Markierung', [{ id: o ? 'color' : 'hlColor', label: 'Farbe', type: 'color' }], o || D);
      if (!o) sideScroll.append(h('div', { class: 'hint' }, 'Ziehe über den Text, den du markieren möchtest.'));
    } else if (kind === 'image' || kind === 'signature') {
      if (o) {
        sideScroll.append(h('div', { class: 'side-title' }, o.type === 'signature' ? 'Unterschrift' : 'Bild'), sizeControl(o));
        const box = h('div');
        renderOptions(box, [{ id: 'opacity', label: 'Deckkraft', type: 'range', min: 5, max: 100, format: (x) => `${x} %` }], o, () => { updateObj(o); });
        sideScroll.append(box);
      }
      else sideScroll.append(h('div', { class: 'hint' }, kind === 'signature' ? 'Erstelle eine Unterschrift und ziehe sie an die richtige Stelle.' : 'Wähle ein Bild aus, es wird auf der aktuellen Seite eingefügt.'));
    } else if (kind === 'whiteout') {
      sideScroll.append(h('div', { class: 'side-title' }, 'Abdecken'), h('div', { class: 'hint' }, 'Ziehe ein Rechteck, um Inhalte weiß abzudecken. Danach kannst du z. B. neuen Text darüber schreiben.'));
    } else {
      sideScroll.append(h('div', { class: 'side-title' }, 'Bearbeiten'), h('div', { class: 'hint' },
        mode === 'sign' ? 'Klicke auf „Unterschrift“, um deine Unterschrift zu erstellen, und platziere sie auf der Seite.' : 'Wähle oben ein Werkzeug. Objekte kannst du verschieben, an den Ecken in der Größe ändern und mit Entf löschen.'));
    }
    if (o) sideScroll.append(h('button', { class: 'btn small danger', style: { marginTop: '6px' }, onclick: deleteSelected }, ic('trash-2', 15), 'Objekt löschen'));
    if (mode === 'sign') sideScroll.append(digitalPanel());
    sideScroll.append(h('div', { class: 'hint', style: { marginTop: '18px' } }, `${objects.length} ${objects.length === 1 ? 'Änderung' : 'Änderungen'} · Seite ${curPage + 1} von ${N}`));
    saveBtn.textContent = mode === 'sign' && st.digital.enabled ? 'Digital signieren & speichern' : mode === 'redact' ? 'Schwärzen & speichern' : 'Speichern';
  }

  // ---------- Seiten ----------
  const pageEls = [];
  const rendered = new Map();
  const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) paint(+e.target.dataset.i); }, { root: canvasArea, rootMargin: '600px' });
  for (let i = 0; i < N; i++) {
    const c = h('canvas', { class: 'render' });
    const layer = h('div', { class: 'layer' });
    const pe = h('div', { class: 'epage', 'data-i': i }, c, layer);
    pe._canvas = c; pe._layer = layer;
    pageEls.push(pe);
    pagesEl.append(pe);
    io.observe(pe);
    layer.addEventListener('pointerdown', (e) => onPointerDown(e, i));
    layer.addEventListener('dblclick', (e) => onDblClick(e, i));
    // Miniaturen
    const tc = h('canvas');
    const t = h('div', { class: 'et', onclick: () => pe.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, tc, h('div', {}, i + 1));
    thumbs.append(t);
    renderPage(pdf, i, 120 / Math.max(pageSizes[i].w, pageSizes[i].h) * 1.5, { canvas: tc }).catch(() => {});
  }

  async function paint(i) {
    const dpr = window.devicePixelRatio || 1;
    const want = zoom * dpr;
    if (rendered.get(i) === want) return;
    rendered.set(i, want);
    const pe = pageEls[i];
    const tmp = document.createElement('canvas');
    await renderPage(pdf, i, want, { canvas: tmp });
    if (rendered.get(i) !== want) return;
    pe._canvas.width = tmp.width; pe._canvas.height = tmp.height;
    pe._canvas.getContext('2d').drawImage(tmp, 0, 0);
  }

  function layoutPages() {
    pageEls.forEach((pe, i) => { pe.style.width = `${pageSizes[i].w * zoom}px`; pe.style.height = `${pageSizes[i].h * zoom}px`; });
    zoomLabel.textContent = `${Math.round(zoom * 100)} %`;
  }

  function setZoom(z) {
    const area = canvasArea;
    const rel = area.scrollTop / Math.max(1, area.scrollHeight);
    zoom = Math.max(0.25, Math.min(4, z));
    st.zoom = zoom;
    layoutPages();
    rendered.clear();
    for (const o of objects) updateObj(o);
    area.scrollTop = rel * area.scrollHeight;
    pageEls.forEach((pe, i) => { const r = pe.getBoundingClientRect(), a = area.getBoundingClientRect(); if (r.bottom > a.top - 600 && r.top < a.bottom + 600) paint(i); });
  }

  canvasArea.addEventListener('scroll', () => {
    const a = canvasArea.getBoundingClientRect();
    const mid = a.top + a.height / 2;
    let best = 0, bd = Infinity;
    pageEls.forEach((pe, i) => { const r = pe.getBoundingClientRect(); const d = Math.abs((r.top + r.bottom) / 2 - mid); if (d < bd) { bd = d; best = i; } });
    if (best !== curPage) {
      curPage = best;
      thumbs.querySelectorAll('.et').forEach((t, k) => t.classList.toggle('on', k === best));
    }
  });

  // ---------- Objekte (Darstellung) ----------
  function bbox(o) {
    if (o.type === 'line' || o.type === 'arrow') {
      const pad = Math.max(6, o.width * 2 + 4);
      return { x: Math.min(o.x1, o.x2) - pad, y: Math.min(o.y1, o.y2) - pad, w: Math.abs(o.x2 - o.x1) + 2 * pad, h: Math.abs(o.y2 - o.y1) + 2 * pad, pad };
    }
    if (o.type === 'pen') {
      const xs = o.points.map((p) => p[0]), ys = o.points.map((p) => p[1]);
      const pad = Math.max(4, o.width + 2);
      return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad, pad };
    }
    return { x: o.x, y: o.y, w: o.w || 0, h: o.h || 0 };
  }

  function objEl(o) {
    let el = document.getElementById(o.id);
    if (!el) {
      el = h('div', { id: o.id, class: `obj ${o.type}` });
      for (const c of ['nw', 'ne', 'sw', 'se']) el.append(h('div', { class: `handle ${c}`, 'data-c': c }));
      pageEls[o.page]._layer.append(el);
    }
    return el;
  }

  function updateObj(o) {
    const el = objEl(o);
    el.classList.toggle('selected', o.id === selectedId);
    const z = zoom;
    let handles = [...el.querySelectorAll('.handle')];
    if (handles.length !== 4) { handles.forEach((x) => x.remove()); handles = ['nw', 'ne', 'sw', 'se'].map((c) => h('div', { class: `handle ${c}`, 'data-c': c })); handles.forEach((x) => el.append(x)); }
    [...el.childNodes].forEach((c) => { if (!handles.includes(c) && !(o.type === 'text' && c.nodeType === 3)) c.remove(); });
    el.style.opacity = (o.opacity ?? 100) / 100;
    if (o.type === 'text') {
      if (editingId !== o.id) { el.textContent = o.text; handles.forEach((x) => el.append(x)); }
      Object.assign(el.style, { left: `${o.x * z}px`, top: `${o.y * z}px`, fontSize: `${o.size * z}px`, fontFamily: FONT_CSS[o.font] || FONT_CSS.Helvetica, color: o.color, fontWeight: o.bold ? '700' : '400', fontStyle: o.italic ? 'italic' : 'normal' });
      requestAnimationFrame(() => { o.w = el.offsetWidth / zoom; o.h = el.offsetHeight / zoom; });
      return;
    }
    const b = bbox(o);
    Object.assign(el.style, { left: `${b.x * z}px`, top: `${b.y * z}px`, width: `${b.w * z}px`, height: `${b.h * z}px` });
    if (o.type === 'image' || o.type === 'signature') {
      if (!urls.has(o.id)) urls.set(o.id, URL.createObjectURL(new Blob([o.data], { type: o.mime })));
      el.prepend(h('img', { src: urls.get(o.id), draggable: 'false' }));
    } else if (o.type === 'rect' || o.type === 'ellipse') {
      const sw = o.width * z;
      const svg = `<svg width="100%" height="100%" viewBox="0 0 ${b.w * z} ${b.h * z}" preserveAspectRatio="none">${o.type === 'rect'
        ? `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, b.w * z - sw)}" height="${Math.max(0, b.h * z - sw)}"`
        : `<ellipse cx="${(b.w * z) / 2}" cy="${(b.h * z) / 2}" rx="${Math.max(0, (b.w * z - sw) / 2)}" ry="${Math.max(0, (b.h * z - sw) / 2)}"`} fill="${o.fillOn ? o.fill : 'none'}" stroke="${o.width > 0 ? o.color : 'none'}" stroke-width="${sw}"/></svg>`;
      el.insertAdjacentHTML('afterbegin', svg);
    } else if (o.type === 'line' || o.type === 'arrow') {
      const x1 = (o.x1 - b.x) * z, y1 = (o.y1 - b.y) * z, x2 = (o.x2 - b.x) * z, y2 = (o.y2 - b.y) * z;
      let head = '';
      if (o.type === 'arrow') {
        const [p1, p2] = arrowHead(o.x1, o.y1, o.x2, o.y2, o.width);
        head = `<polyline points="${(p1[0] - b.x) * z},${(p1[1] - b.y) * z} ${x2},${y2} ${(p2[0] - b.x) * z},${(p2[1] - b.y) * z}" fill="none" stroke="${o.color}" stroke-width="${o.width * z}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      el.insertAdjacentHTML('afterbegin', `<svg width="100%" height="100%"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.color}" stroke-width="${o.width * z}" stroke-linecap="round"/>${head}</svg>`);
    } else if (o.type === 'pen') {
      const pts = o.points.map((p) => `${(p[0] - b.x) * z},${(p[1] - b.y) * z}`).join(' ');
      el.insertAdjacentHTML('afterbegin', `<svg width="100%" height="100%"><polyline points="${pts}" fill="none" stroke="${o.color}" stroke-width="${o.width * z}" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
    } else if (o.type === 'highlight') {
      el.style.background = o.color; el.style.mixBlendMode = 'multiply'; el.style.opacity = 0.4;
    } else if (o.type === 'whiteout') {
      el.style.background = '#fff';
    } else if (o.type === 'redact') {
      el.classList.add('preview');
    }
  }

  function arrowHead(x1, y1, x2, y2, w) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = 8 + w * 3, spread = 0.5;
    return [[x2 - len * Math.cos(ang - spread), y2 - len * Math.sin(ang - spread)], [x2 - len * Math.cos(ang + spread), y2 - len * Math.sin(ang + spread)]];
  }

  function removeObj(o) {
    const el = document.getElementById(o.id);
    if (el) el.remove();
    objects.splice(objects.indexOf(o), 1);
  }

  function select(id) {
    const prev = selectedId;
    selectedId = id;
    if (prev && byId(prev)) updateObj(byId(prev));
    if (id && byId(id)) updateObj(byId(id));
    renderProps();
  }

  function setTool(t) {
    if (t === 'image') { insertImage(); return; }
    if (t === 'signature') { insertSignature(); return; }
    tool = t;
    Object.entries(toolBtns).forEach(([k, b]) => b.classList.toggle('on', k === t));
    pageEls.forEach((pe) => { pe._layer.classList.toggle('tool-draw', DRAW_TOOLS.includes(t)); pe._layer.classList.toggle('tool-text', ['text', 'date', 'check'].includes(t)); });
    select(null);
  }

  function undo() {
    const prev = undoStack.pop();
    if (!prev) return;
    for (const o of [...objects]) removeObj(o);
    objects.push(...prev);
    selectedId = null;
    for (const o of objects) updateObj(o);
    renderProps();
  }
  function deleteSelected() {
    const o = byId(selectedId);
    if (!o) return;
    pushUndo();
    removeObj(o);
    selectedId = null;
    renderProps();
  }

  // ---------- Interaktion ----------
  const ptFromEvent = (e, i) => { const r = pageEls[i]._layer.getBoundingClientRect(); return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom]; };
  const clampPage = (i, x, y) => [Math.max(0, Math.min(pageSizes[i].w, x)), Math.max(0, Math.min(pageSizes[i].h, y))];

  function onPointerDown(e, i) {
    if (e.button !== 0) return;
    const objNode = e.target.closest('.obj');
    if (editingId) {
      if (objNode && objNode.id === editingId) return; // Textbearbeitung
      finishEditing();
    }
    if (objNode && (tool === 'select' || !DRAW_TOOLS.includes(tool) || e.target.classList.contains('handle'))) {
      const o = byId(objNode.id);
      if (!o) return;
      e.preventDefault();
      select(o.id);
      startDrag(e, o, e.target.classList.contains('handle') ? 'resize' : 'move', e.target.dataset.c || 'se');
      return;
    }
    const [x, y] = ptFromEvent(e, i);
    if (['text', 'date', 'check'].includes(tool)) {
      e.preventDefault();
      pushUndo();
      const text = tool === 'date' ? new Date().toLocaleDateString('de-DE') : tool === 'check' ? '✓' : '';
      const o = { id: newId(), type: 'text', page: i, x, y: y - D.size * 0.6, text, font: tool === 'check' ? 'Helvetica' : D.font, size: tool === 'check' ? Math.max(D.size, 18) : D.size, color: D.textColor, bold: D.bold || tool === 'check', italic: D.italic, opacity: 100 };
      objects.push(o);
      select(o.id);
      updateObj(o);
      if (tool === 'text') startEditing(o);
      else setTool('select');
      return;
    }
    if (DRAW_TOOLS.includes(tool)) {
      e.preventDefault();
      pushUndo();
      const base = { id: newId(), page: i, opacity: tool === 'highlight' ? 100 : D.opacity };
      let o;
      if (tool === 'line' || tool === 'arrow') o = { ...base, type: tool, x1: x, y1: y, x2: x, y2: y, color: D.color, width: D.width };
      else if (tool === 'pen') o = { ...base, type: 'pen', points: [[x, y]], color: D.penColor, width: D.penWidth };
      else o = { ...base, type: tool, x, y, w: 0, h: 0, color: tool === 'highlight' ? D.hlColor : D.color, width: D.width, fill: D.fill, fillOn: D.fillOn };
      objects.push(o);
      updateObj(o);
      const layer = pageEls[i]._layer;
      try { layer.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => {
        const [mx, my] = clampPage(i, ...ptFromEvent(ev, i));
        if (o.type === 'line' || o.type === 'arrow') {
          o.x2 = mx; o.y2 = my;
          if (ev.shiftKey) { const dx = mx - o.x1, dy = my - o.y1; if (Math.abs(dx) > Math.abs(dy)) o.y2 = o.y1; else o.x2 = o.x1; }
        } else if (o.type === 'pen') o.points.push([mx, my]);
        else { o.x = Math.min(x, mx); o.y = Math.min(y, my); o.w = Math.abs(mx - x); o.h = Math.abs(my - y); if (ev.shiftKey && (o.type === 'rect' || o.type === 'ellipse')) { const s = Math.max(o.w, o.h); o.w = o.h = s; } }
        updateObj(o);
      };
      const up = () => {
        layer.removeEventListener('pointermove', move);
        layer.removeEventListener('pointerup', up);
        const tiny = (o.type === 'line' || o.type === 'arrow') ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3 : o.type === 'pen' ? o.points.length < 2 : o.w < 3 || o.h < 3;
        if (tiny) {
          if (o.type === 'pen' || o.type === 'line' || o.type === 'arrow') { removeObj(o); undoStack.pop(); return; }
          // Klick ohne Ziehen: Standardgröße
          o.w = o.type === 'highlight' ? 120 : o.type === 'redact' ? 120 : 100; o.h = o.type === 'highlight' ? 16 : o.type === 'redact' ? 18 : 60;
        }
        updateObj(o);
        if (o.type !== 'pen' && o.type !== 'highlight' && o.type !== 'redact') { setTool('select'); select(o.id); }
        else renderProps();
      };
      layer.addEventListener('pointermove', move);
      layer.addEventListener('pointerup', up);
      return;
    }
    select(null);
  }

  function onDblClick(e, i) {
    const objNode = e.target.closest('.obj.text');
    if (objNode) { const o = byId(objNode.id); if (o) { select(o.id); startEditing(o); } }
    void i;
  }

  function startDrag(e, o, kind, corner = 'se') {
    const i = o.page;
    const layer = pageEls[i]._layer;
    const [sx, sy] = ptFromEvent(e, i);
    const orig = JSON.parse(JSON.stringify({ ...o, data: undefined }));
    const b0 = bbox(o);
    let moved = false;
    try { layer.setPointerCapture(e.pointerId); } catch (_) {}
    const west = corner.includes('w'), north = corner.includes('n');
    const move = (ev) => {
      const [mx, my] = ptFromEvent(ev, i);
      const dx = mx - sx, dy = my - sy;
      if (!moved && Math.hypot(dx, dy) < 1.5) return;
      if (!moved) { pushUndo(); moved = true; }
      if (kind === 'move') {
        if (o.type === 'line' || o.type === 'arrow') { o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy; o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy; }
        else if (o.type === 'pen') o.points = orig.points.map((p) => [p[0] + dx, p[1] + dy]);
        else { o.x = orig.x + dx; o.y = orig.y + dy; }
      } else {
        const pad = b0.pad || 0;
        const inner = { x: b0.x + pad, y: b0.y + pad, w: Math.max(1, b0.w - 2 * pad), h: Math.max(1, b0.h - 2 * pad) };
        let nw = Math.max(8, inner.w + (west ? -dx : dx)), nh = Math.max(8, inner.h + (north ? -dy : dy));
        // Bilder, Unterschriften und Text behalten immer ihr Seitenverhältnis
        if (o.type === 'image' || o.type === 'signature' || o.type === 'text' || ev.shiftKey) {
          const sc = Math.abs(dx) * inner.h > Math.abs(dy) * inner.w ? nw / inner.w : nh / inner.h;
          nw = inner.w * sc; nh = inner.h * sc;
        }
        const nx = west ? inner.x + inner.w - nw : inner.x;
        const ny = north ? inner.y + inner.h - nh : inner.y;
        const sxr = nw / inner.w, syr = nh / inner.h;
        if (o.type === 'text') { o.size = Math.max(4, Math.round(orig.size * syr * 2) / 2); o.x = nx; o.y = ny; }
        else if (o.type === 'line' || o.type === 'arrow') { o.x1 = nx + (orig.x1 - inner.x) * sxr; o.y1 = ny + (orig.y1 - inner.y) * syr; o.x2 = nx + (orig.x2 - inner.x) * sxr; o.y2 = ny + (orig.y2 - inner.y) * syr; }
        else if (o.type === 'pen') o.points = orig.points.map((p) => [nx + (p[0] - inner.x) * sxr, ny + (p[1] - inner.y) * syr]);
        else { o.x = nx; o.y = ny; o.w = nw; o.h = nh; }
        updateSizeLabel(o);
      }
      updateObj(o);
    };
    const up = () => { layer.removeEventListener('pointermove', move); layer.removeEventListener('pointerup', up); if (moved) renderProps(); };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
  }

  // ---------- Größe in mm (Bilder & Unterschriften) ----------
  const PT_PER_MM = 72 / 25.4;
  let sizeLabelEl = null, sizeRangeEl = null;
  function updateSizeLabel(o) {
    if (!sizeLabelEl || !(o.type === 'image' || o.type === 'signature')) return;
    const mm = Math.round(o.w / PT_PER_MM);
    sizeLabelEl.textContent = `${mm} × ${Math.round(o.h / PT_PER_MM)} mm`;
    if (sizeRangeEl) sizeRangeEl.value = mm;
  }
  function setWidthMm(o, mm, anchorCenter = true) {
    const ps = pageSizes[o.page];
    const nw = Math.max(5, mm) * PT_PER_MM;
    const nh = (o.h * nw) / o.w;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    o.w = nw; o.h = nh;
    if (anchorCenter) { o.x = cx - nw / 2; o.y = cy - nh / 2; }
    o.x = Math.max(0, Math.min(ps.w - Math.min(nw, ps.w), o.x));
    o.y = Math.max(0, Math.min(ps.h - Math.min(nh, ps.h), o.y));
    updateObj(o);
    updateSizeLabel(o);
  }
  function sizeControl(o) {
    const ps = pageSizes[o.page];
    const maxMm = Math.round(ps.w / PT_PER_MM);
    sizeLabelEl = h('span', { class: 'val', style: { width: 'auto' } });
    sizeRangeEl = h('input', { type: 'range', min: 10, max: maxMm, step: 1 });
    let undoPushed = false;
    sizeRangeEl.addEventListener('pointerdown', () => { if (!undoPushed) { pushUndo(); undoPushed = true; } });
    sizeRangeEl.addEventListener('input', () => setWidthMm(o, +sizeRangeEl.value));
    sizeRangeEl.addEventListener('change', () => { undoPushed = false; });
    const step = (f) => { pushUndo(); setWidthMm(o, (o.w / PT_PER_MM) * f); };
    const preset = (mm) => { pushUndo(); setWidthMm(o, mm); };
    const box = h('div', { class: 'field' },
      h('div', { class: 'label' }, 'Größe ', sizeLabelEl),
      h('div', { class: 'range-row' }, sizeRangeEl),
      h('div', { class: 'size-row' },
        h('button', { class: 'btn small', title: 'Kleiner (−10 %)', onclick: () => step(1 / 1.1) }, ic('minus', 15)),
        h('button', { class: 'btn small', title: 'Größer (+10 %)', onclick: () => step(1.1) }, ic('plus', 15))),
      h('div', { class: 'size-row' },
        ...(o.type === 'signature' ? [['Klein', 35], ['Mittel', 50], ['Groß', 70]] : [['Klein', 40], ['Mittel', 80], ['Groß', 140]]).map(([l, mm]) => h('button', { class: 'btn small', onclick: () => preset(mm) }, l))),
      h('div', { class: 'help' }, 'Oder an einer der vier Ecken ziehen. Das Seitenverhältnis bleibt erhalten.'));
    updateSizeLabel(o);
    return box;
  }

  function startEditing(o) {
    const el = objEl(o);
    editingId = o.id;
    el.classList.add('editing');
    el.contentEditable = 'plaintext-only';
    el.textContent = o.text;
    el.focus();
    const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    el.oninput = () => { o.text = el.innerText.replace(/\n$/, ''); o.w = el.offsetWidth / zoom; o.h = el.offsetHeight / zoom; };
    el.onblur = () => finishEditing();
  }
  function finishEditing() {
    const o = byId(editingId);
    const el = editingId && document.getElementById(editingId);
    editingId = null;
    if (el) { el.contentEditable = 'false'; el.classList.remove('editing'); el.onblur = null; el.oninput = null; }
    if (o) {
      o.text = (el ? el.innerText : o.text).replace(/\n$/, '');
      if (!o.text.trim()) { removeObj(o); if (selectedId === o.id) selectedId = null; }
      else updateObj(o);
    }
    renderProps();
  }

  const keyHandler = (e) => {
    if (!document.body.contains(ed)) { document.removeEventListener('keydown', keyHandler); return; }
    if (editingId) { if (e.key === 'Escape') { e.preventDefault(); document.getElementById(editingId)?.blur(); } return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteSelected(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Escape') { select(null); setTool('select'); }
    if (selectedId && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const o = byId(selectedId); const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      pushUndo();
      if (o.type === 'line' || o.type === 'arrow') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
      else if (o.type === 'pen') o.points = o.points.map((p) => [p[0] + dx, p[1] + dy]);
      else { o.x += dx; o.y += dy; }
      updateObj(o);
    }
  };
  document.addEventListener('keydown', keyHandler);

  // ---------- Bilder & Unterschrift ----------
  function placeImage(data, mime, width, height, type) {
    const pg = curPage;
    const ps = pageSizes[pg];
    const targetW = type === 'signature' ? Math.min(180, ps.w * 0.35) : Math.min(260, ps.w * 0.5);
    const s = targetW / width;
    const w = width * s, hh = height * s;
    const a = canvasArea.getBoundingClientRect(), r = pageEls[pg].getBoundingClientRect();
    const visTop = Math.max(0, (a.top - r.top) / zoom), visBottom = Math.min(ps.h, (a.bottom - r.top) / zoom);
    const y = Math.max(0, Math.min(ps.h - hh, (visTop + visBottom) / 2 - hh / 2));
    pushUndo();
    const o = { id: newId(), type, page: pg, x: (ps.w - w) / 2, y, w, h: hh, data, mime, opacity: 100 };
    objects.push(o);
    updateObj(o);
    setTool('select');
    select(o.id);
  }
  async function insertImage() {
    const f = (await pickFiles('image', false))[0];
    if (!f) return;
    let data = f.data;
    if (['heic', 'heif', 'tif', 'tiff'].includes(ext(f.name))) data = await native.heicToJpeg({ name: f.name, data });
    let kind = sniffImage(data);
    if (!kind) { data = await imageToPng(data); kind = 'png'; }
    const bmp = await createImageBitmap(new Blob([data]));
    // EXIF-gedrehte JPEGs normalisieren
    if (kind === 'jpg') data = await reencodeJpeg(data); // EXIF-Drehung anwenden, bleibt JPEG
    placeImage(data, kind === 'jpg' ? 'image/jpeg' : 'image/png', bmp.width, bmp.height, 'image');
  }
  async function insertSignature() {
    const s = await createSignature();
    if (s) placeImage(s.data, 'image/png', s.width, s.height, 'signature');
  }

  // ---------- Schwärzen per Suche ----------
  async function searchRedact(query) {
    const q = query.trim().toLowerCase();
    if (!q) { toast('Bitte einen Suchbegriff eingeben.'); return; }
    busy('Text wird gesucht …');
    let found = 0;
    const mctx = document.createElement('canvas').getContext('2d');
    pushUndo();
    try {
      for (let i = 0; i < N; i++) {
        const { items } = await pageTextItems(pdf, i);
        for (const it of items) {
          const s = it.str.toLowerCase();
          if (!s) continue;
          let at = s.indexOf(q);
          while (at >= 0) {
            const fam = /serif/i.test(it.family) && !/sans/i.test(it.family) ? 'Times, serif' : /mono|courier/i.test(it.family) ? 'Courier, monospace' : 'Helvetica, Arial, sans-serif';
            mctx.font = `100px ${fam}`;
            const full = mctx.measureText(it.str).width || 1;
            const x0 = it.x + (mctx.measureText(it.str.slice(0, at)).width / full) * it.width;
            const x1 = it.x + (mctx.measureText(it.str.slice(0, at + q.length)).width / full) * it.width;
            const o = { id: newId(), type: 'redact', page: i, x: x0 - 1.5, y: it.y - it.height * 0.1, w: x1 - x0 + 3, h: it.height * 1.25, opacity: 100 };
            objects.push(o); updateObj(o); found++;
            at = s.indexOf(q, at + q.length);
          }
        }
      }
    } finally { idle(); }
    if (!found) { undoStack.pop(); toast(`„${query}“ wurde nicht gefunden (Text in Scans vorher per OCR erkennen).`); }
    else toast(`${found} Treffer markiert.`);
    renderProps();
  }

  // ---------- Speichern ----------
  async function save() {
    finishEditing();
    if (!objects.length && !(mode === 'sign' && st.digital.enabled)) { toast(mode === 'redact' ? 'Bitte zuerst Bereiche zum Schwärzen markieren.' : 'Es wurden noch keine Änderungen vorgenommen.', 'error'); return; }
    if (mode === 'sign' && st.digital.enabled) return saveDigital();
    await api.run(async () => {
      busy('PDF wird gespeichert …');
      const doc = await loadDoc(file.data);
      if (mode === 'redact') return saveRedacted(doc);
      const pages = [...new Set(objects.map((o) => o.page))].sort((a, b) => a - b);
      await stampPages(doc, pages, async (p, { height: H, index, tmpDoc }) => {
        for (const o of objects.filter((x) => x.page === index)) await drawObj(tmpDoc, p, o, H);
      });
      const suffix = mode === 'sign' ? 'unterschrieben' : 'bearbeitet';
      return [{ name: `${baseName(file.name)}-${suffix}.pdf`, data: await saveDoc(doc) }];
    });
  }

  async function saveDigital() {
    const d = st.digital;
    const cert = certList.find((c) => c.id === d.certId);
    if (!cert) { toast('Bitte zuerst ein Signaturzertifikat erstellen oder importieren.', 'error'); return; }
    if (new Date(cert.notAfter) < new Date()) { toast('Das gewählte Zertifikat ist abgelaufen.', 'error'); return; }
    const unlock = await unlockCert(cert);
    if (!unlock) return;
    await api.run(async () => {
      busy('Dokument wird digital signiert …');
      let bytes = file.data;
      const existing = await native.hasSignatures(bytes);
      const visibleSig = objects.find((o) => o.type === 'signature');
      const others = objects.filter((o) => o !== visibleSig);
      if (others.length) {
        if (existing) throw new UserError('Dieses Dokument ist bereits digital signiert. Zusätzliche Texte oder Bilder würden die vorhandene Signatur ungültig machen. Füge nur deine Unterschrift hinzu.');
        const doc = await loadDoc(bytes);
        const pages = [...new Set(others.map((o) => o.page))].sort((a, b) => a - b);
        await stampPages(doc, pages, async (p, { height: H, index, tmpDoc }) => {
          for (const o of others.filter((x) => x.page === index)) await drawObj(tmpDoc, p, o, H);
        });
        bytes = await saveDoc(doc, { objectStreams: false });
      }
      const now = new Date();
      const when = now.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
      let visible = null;
      const certShort = cert.fingerprint.replace(/:/g, '').slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ');
      const common = { name: cert.name, dateText: when, certId: certShort, detail: cert.organization || cert.email || '' };
      if (visibleSig) {
        const o = visibleSig;
        const extra = d.caption ? 24 : 0;
        const w = d.caption ? Math.max(o.w, 160) : o.w;
        visible = { ...common, mode: 'signature', caption: !!d.caption, pageIndex: o.page, rect: [o.x + o.w / 2 - w / 2, o.y, w, o.h + extra], image: o.data };
      } else if (d.stamp) {
        const last = N - 1;
        const ps = pageSizes[last];
        visible = { ...common, mode: 'stamp', pageIndex: last, rect: [ps.w - 262, ps.h - 96, 226, 60] };
      }
      const r = await native.signPdf(bytes, {
        certId: cert.id, password: unlock.password, reason: d.reason, location: d.location,
        timestamp: d.timestamp, protocol: d.protocol, fileName: file.name, visible,
      });
      let message = `Digital signiert von ${cert.name}.`;
      if (d.timestamp) message += r.timestamp && !r.timestamp.error ? ` Zeitstempel: ${new Date(r.timestamp.time).toLocaleString('de-DE')}.` : ' Kein Zeitstempel (Zeitstempeldienst nicht erreichbar), die Signatur ist trotzdem gültig.';
      return { files: [{ name: `${baseName(file.name)}-signiert.pdf`, data: r.data }], message, title: 'Digital signiert' };
    });
  }

  async function drawObj(doc, p, o, H) {
    const op = (o.opacity ?? 100) / 100;
    if (o.type === 'text') {
      const font = await getFont(doc, o.font, { bold: o.bold, italic: o.italic, text: o.text });
      const size = o.size;
      const asc = font.heightAtSize(size, { descender: false }), full = font.heightAtSize(size);
      const lh = size * 1.2;
      const base = (lh - full) / 2 + asc;
      o.text.split('\n').forEach((line, k) => {
        if (line) p.drawText(line, { x: o.x, y: H - (o.y + base + k * lh), size, font, color: hexToRgb(o.color), opacity: op });
      });
    } else if (o.type === 'image' || o.type === 'signature') {
      const img = o.mime === 'image/jpeg' ? await doc.embedJpg(o.data) : await doc.embedPng(o.data);
      p.drawImage(img, { x: o.x, y: H - o.y - o.h, width: o.w, height: o.h, opacity: op });
    } else if (o.type === 'rect') {
      const sw = o.width;
      p.drawRectangle({ x: o.x + sw / 2, y: H - o.y - o.h + sw / 2, width: Math.max(0, o.w - sw), height: Math.max(0, o.h - sw), borderColor: sw > 0 ? hexToRgb(o.color) : undefined, borderWidth: sw, color: o.fillOn ? hexToRgb(o.fill) : undefined, opacity: op, borderOpacity: op });
    } else if (o.type === 'ellipse') {
      const sw = o.width;
      p.drawEllipse({ x: o.x + o.w / 2, y: H - o.y - o.h / 2, xScale: Math.max(0, (o.w - sw) / 2), yScale: Math.max(0, (o.h - sw) / 2), borderColor: sw > 0 ? hexToRgb(o.color) : undefined, borderWidth: sw, color: o.fillOn ? hexToRgb(o.fill) : undefined, opacity: op, borderOpacity: op });
    } else if (o.type === 'line' || o.type === 'arrow') {
      const c = hexToRgb(o.color);
      const L = window.PDFLib.LineCapStyle;
      p.drawLine({ start: { x: o.x1, y: H - o.y1 }, end: { x: o.x2, y: H - o.y2 }, thickness: o.width, color: c, opacity: op, lineCap: L.Round });
      if (o.type === 'arrow') {
        const [a, b] = arrowHead(o.x1, o.y1, o.x2, o.y2, o.width);
        p.drawLine({ start: { x: a[0], y: H - a[1] }, end: { x: o.x2, y: H - o.y2 }, thickness: o.width, color: c, opacity: op, lineCap: L.Round });
        p.drawLine({ start: { x: b[0], y: H - b[1] }, end: { x: o.x2, y: H - o.y2 }, thickness: o.width, color: c, opacity: op, lineCap: L.Round });
      }
    } else if (o.type === 'pen') {
      if (o.points.length < 2) return;
      const d = 'M ' + o.points.map((pt) => `${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`).join(' L ');
      p.drawSvgPath(d, { x: 0, y: H, borderColor: hexToRgb(o.color), borderWidth: o.width, borderOpacity: op, borderLineCap: window.PDFLib.LineCapStyle.Round });
    } else if (o.type === 'highlight') {
      p.drawRectangle({ x: o.x, y: H - o.y - o.h, width: o.w, height: o.h, color: hexToRgb(o.color), opacity: 0.4, blendMode: window.PDFLib.BlendMode.Multiply });
    } else if (o.type === 'whiteout') {
      p.drawRectangle({ x: o.x, y: H - o.y - o.h, width: o.w, height: o.h, color: rgb(1, 1, 1), opacity: 1 });
    }
  }

  async function saveRedacted(doc) {
    const ro = st.redactOpts;
    const pages = [...new Set(objects.filter((o) => o.type === 'redact').map((o) => o.page))].sort((a, b) => a - b);
    if (ro.secure) {
      const dpi = +ro.dpi || 200;
      for (const i of pages) {
        busy(`Seite ${i + 1} wird geschwärzt …`);
        const { canvas } = await renderPage(pdf, i, dpi / 72, { annotationMode: 0 });
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        const s = canvas.width / pageSizes[i].w;
        for (const o of objects.filter((x) => x.page === i && x.type === 'redact')) ctx.fillRect(Math.floor(o.x * s), Math.floor(o.y * s), Math.ceil(o.w * s), Math.ceil(o.h * s));
        const jpg = await canvasToBytes(canvas, 'image/jpeg', 0.9);
        const { width: W, height: Hh } = displayBox(doc.getPage(i));
        doc.removePage(i);
        const np = doc.insertPage(i, [W, Hh]);
        const img = await doc.embedJpg(jpg);
        np.drawImage(img, { x: 0, y: 0, width: W, height: Hh });
      }
    } else {
      await stampPages(doc, pages, async (p, { height: H, index }) => {
        for (const o of objects.filter((x) => x.page === index && x.type === 'redact')) p.drawRectangle({ x: o.x, y: H - o.y - o.h, width: o.w, height: o.h, color: rgb(0, 0, 0) });
      });
    }
    if (ro.stripMeta) {
      doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]); doc.setCreator(''); doc.setProducer('PDF Editor');
      doc.catalog.delete(window.PDFLib.PDFName.of('Metadata'));
    }
    const data = await saveDoc(doc);
    // Prüfen, ob Text unter geschwärzten Bereichen noch vorhanden ist (nur Hinweis bei unsicherem Modus)
    return { files: [{ name: `${baseName(file.name)}-geschwaerzt.pdf`, data }], message: ro.secure ? `${pages.length} ${pages.length === 1 ? 'Seite wurde' : 'Seiten wurden'} sicher geschwärzt.` : 'Bereiche wurden schwarz überdeckt (nicht sicher entfernt).' };
  }

  // ---------- Start ----------
  layoutPages();
  for (const o of objects) updateObj(o);
  setTool('select');
  void openPdf; void PDFDocument; void degrees; void UserError;
}
