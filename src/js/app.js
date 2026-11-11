// PDF Editor – Oberfläche
import { icon } from './icons.js';
import { h, ic, busy, idle, toast, modal, pickFiles, filesFromDrop, preparePdf, thumbnailInto, fileMeta, renderOptions, acceptList, makeFile, getPdfDoc } from './ui.js';
import { TOOLS, CATEGORIES, FEATURED } from './tools.js';
import * as uiModule from './ui.js';
import * as pdfModule from './pdf.js';
import * as coreModule from './core.js';
import { ext, formatBytes, native, UserError, baseName } from './core.js';

const view = document.getElementById('view');
const searchInput = document.getElementById('search');
document.getElementById('searchIcon').innerHTML = icon('search', 16);

let current = null; // aktuelle Werkzeugseite

// ---------- Navigation ----------
// Die Adresse (#werkzeug) spiegelt das geöffnete Werkzeug: Links lassen sich teilen, „Zurück“ im Browser funktioniert.
function setHash(id) {
  const want = id && id !== 'home' ? `#${id}` : '';
  if (location.hash === want || (!want && !location.hash)) return;
  history.pushState(null, '', want || location.pathname + location.search);
}
export function go(toolId, files = [], { push = true } = {}) {
  searchInput.value = '';
  const tool = toolId && toolId !== 'home' ? TOOLS.find((t) => t.id === toolId && !t.hidden) : null;
  if (push) setHash(tool ? tool.id : 'home');
  if (!tool) return renderHome();
  current = new ToolPage(tool, files);
  window.__page = current;
  current.mount();
}
window.__go = go;
// Für automatische Tests
window.__app = { tools: { TOOLS }, ui: uiModule, pdf: pdfModule, core: coreModule, native, convert: () => import('./web/convert.js') };
window.addEventListener('popstate', () => go(location.hash.slice(1) || 'home', [], { push: false }));

document.getElementById('homeBtn').addEventListener('click', () => go('home'));

searchInput.addEventListener('input', () => {
  if (current) { current = null; }
  renderHome(searchInput.value);
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !current) { e.preventDefault(); searchInput.focus(); }
});

// ---------- Startseite ----------
function toolCard(t) {
  return h('button', { class: 'tool-card', onclick: () => go(t.id) },
    h('span', { class: 'tool-icon', style: { '--c': t.color }, html: icon(t.icon, 22) }),
    h('span', { class: 'name' }, t.name),
    h('span', { class: 'desc' }, t.desc));
}

function renderHome(query = '') {
  current = null;
  view.innerHTML = '';
  const home = h('div', { class: 'home' });
  const q = query.trim().toLowerCase();
  if (q) {
    const hits = TOOLS.filter((t) => !t.hidden && (t.name + ' ' + t.desc + ' ' + (t.keywords || '')).toLowerCase().includes(q));
    home.append(h('div', { class: 'section-title', style: { marginTop: 0 } }, `Suchergebnisse für „${query.trim()}“`));
    home.append(hits.length ? h('div', { class: 'tool-grid' }, hits.map(toolCard)) : h('div', { class: 'empty-search' }, 'Kein passendes Werkzeug gefunden.'));
    view.append(home);
    return;
  }
  home.append(h('div', { class: 'home-hero' },
    h('h1', {}, 'Was möchtest du mit deinen PDFs machen?'),
    h('p', {}, 'Alle Werkzeuge laufen direkt in deinem Browser. Deine Dateien werden nicht hochgeladen und verlassen nie dein Gerät.')));
  home.append(h('div', { class: 'tool-grid' }, FEATURED.map((id) => TOOLS.find((t) => t.id === id)).filter(Boolean).map(toolCard)));
  for (const cat of CATEGORIES) {
    const list = TOOLS.filter((t) => t.cat === cat.id && !t.hidden && !FEATURED.includes(t.id));
    if (!list.length) continue;
    home.append(h('div', { class: 'section-title' }, cat.name));
    home.append(h('div', { class: 'tool-grid' }, list.map(toolCard)));
  }
  view.append(home);
  view.scrollTop = 0;
}

// Dateien, die per Drag & Drop auf die Startseite gezogen werden
async function handleIncomingFiles(files) {
  if (!files.length) return;
  if (current && current.acceptsDrop) { current.addFiles(files); return; }
  const e = ext(files[0].name);
  const fitting = TOOLS.filter((t) => !t.hidden && !t.noInput && acceptList(t.accept || 'pdf').includes(e));
  const grid = h('div', { class: 'tool-grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' } });
  const p = modal({ title: `Was möchtest du mit ${files.length > 1 ? `${files.length} Dateien` : `„${files[0].name}“`} machen?`, body: grid, wide: true, buttons: [{ label: 'Abbrechen', value: null }] });
  for (const t of fitting) {
    const card = toolCard(t);
    card.onclick = () => { document.querySelector('.modal-back')?.remove(); go(t.id, files); };
    grid.append(card);
  }
  await p;
}

// Globales Drag & Drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; document.body.classList.add('drop-active'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('drop-active'); });
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  dragDepth = 0; document.body.classList.remove('drop-active');
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const files = await filesFromDrop(e.dataTransfer);
  handleIncomingFiles(files);
});

// ---------- Werkzeugseite ----------
class ToolPage {
  constructor(tool, files) {
    this.tool = tool;
    this.files = [];
    this.values = {};
    this.results = null;
    this.acceptsDrop = !tool.noInput;
    this.initialFiles = files;
  }

  async mount() {
    const t = this.tool;
    view.innerHTML = '';
    this.root = h('div', { class: 'tool-page' });
    this.head = h('div', { class: 'tool-head' },
      h('button', { class: 'back-btn', title: 'Zurück zur Übersicht', onclick: () => go('home'), html: icon('arrow-left', 18) }),
      h('span', { class: 'tool-icon', style: { '--c': t.color }, html: icon(t.icon, 22) }),
      h('div', {}, h('h2', {}, t.name), h('p', {}, t.desc)));
    this.body = h('div', { class: 'tool-body' });
    this.root.append(this.head, this.body);
    view.append(this.root);
    if (this.initialFiles.length) await this.addFiles(this.initialFiles);
    else this.render();
  }

  api() {
    return {
      tool: this.tool, page: this, files: this.files, values: this.values,
      addFiles: (f) => this.addFiles(f), pick: () => this.pick(), render: () => this.render(),
      showResult: (r, extra) => this.showResult(r, extra), run: (fn, text) => this.exec(fn, text), go: (id, files) => go(id, files),
    };
  }

  async pick() {
    const f = await pickFiles(this.tool.accept || 'pdf', this.tool.multiple !== false);
    if (f.length) await this.addFiles(f);
  }

  async addFiles(newFiles) {
    if (this.results) { this.results = null; }
    const allowed = acceptList(this.tool.accept || 'pdf');
    const ok = [], bad = [];
    for (const f of newFiles) (allowed.includes(ext(f.name)) ? ok : bad).push(f);
    if (bad.length) toast(`Nicht unterstützt: ${bad.map((b) => b.name).join(', ')}`, 'error');
    if (!ok.length) return this.render();
    const accepted = [];
    for (const f of ok) {
      try {
        if (ext(f.name) === 'pdf' && !this.tool.raw) {
          busy(`„${f.name}“ wird geöffnet …`);
          await preparePdf(f);
        }
        accepted.push(f);
      } catch (e) {
        idle();
        toast(e.message, 'error');
      }
    }
    idle();
    if (accepted.length) {
      if (this.tool.multiple === false) this.files.splice(0, this.files.length, accepted[0]);
      else this.files.push(...accepted);
    }
    this.render();
  }

  render() {
    this.body.innerHTML = '';
    const t = this.tool;
    if (this.results) return this.renderResult();
    if (t.custom && (this.files.length || t.noInput)) {
      t.custom(this.body, this.api());
      return;
    }
    if (!this.files.length && !t.noInput) {
      const main = h('div', { class: 'tool-main' });
      const dz = h('div', { class: 'dropzone' },
        h('div', { class: 'dz-icon', style: { '--c': t.color }, html: icon(t.icon, 32) }),
        h('h3', {}, t.multiple === false ? 'Datei hierher ziehen' : 'Dateien hierher ziehen'),
        h('p', {}, t.acceptLabel || 'oder vom Gerät auswählen'),
        h('button', { class: 'btn primary', onclick: () => this.pick() }, ic('folder-open', 18), t.multiple === false ? 'Datei auswählen' : 'Dateien auswählen'));
      main.append(dz);
      this.body.append(main);
      return;
    }
    // Standard: Dateiliste + Optionen
    const main = h('div', { class: 'tool-main' });
    const side = h('div', { class: 'tool-side' });
    this.renderFileList(main);
    const scroll = h('div', { class: 'side-scroll' });
    const opts = typeof t.options === 'function' ? t.options(this.files, this.values) : (t.options || []);
    if (t.info) scroll.append(h('div', { class: 'info-box' }, typeof t.info === 'function' ? t.info(this.files) : t.info));
    if (opts.length) { scroll.append(h('div', { class: 'side-title' }, 'Optionen')); const box = h('div'); renderOptions(box, opts, this.values); scroll.append(box); }
    else if (!t.info) scroll.append(h('div', { class: 'hint' }, 'Keine weiteren Einstellungen nötig.'));
    const runBtn = h('button', { class: 'btn primary big', onclick: () => this.start() }, t.action || 'Starten');
    side.append(scroll, h('div', { class: 'side-foot' }, runBtn));
    this.body.append(main, side);
  }

  renderFileList(main) {
    const t = this.tool;
    const toolbar = h('div', { class: 'list-toolbar' },
      h('div', { class: 'hint' }, `${this.files.length} ${this.files.length === 1 ? 'Datei' : 'Dateien'}${t.sortable ? ' · Reihenfolge per Drag & Drop ändern' : ''}`),
      h('div', { class: 'grow' }),
      t.sortable ? h('button', { class: 'btn small', onclick: () => { this.files.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true })); this.render(); } }, ic('arrow-down-a-z', 16), 'Nach Name') : null,
      t.multiple !== false ? h('button', { class: 'btn small', onclick: () => this.pick() }, ic('plus', 16), 'Hinzufügen') : h('button', { class: 'btn small', onclick: () => this.pick() }, ic('folder-open', 16), 'Andere Datei'),
      h('button', { class: 'btn small ghost', onclick: () => { this.files.length = 0; this.render(); } }, 'Alle entfernen'));
    main.append(toolbar);
    const list = h('div', { class: 'file-list' });
    this.files.forEach((f, i) => {
      const thumb = h('div', { class: 'thumb' });
      const card = h('div', { class: 'file-card', draggable: t.sortable ? 'true' : null },
        t.sortable ? h('span', { class: 'badge' }, i + 1) : null,
        thumb,
        f.unlocked ? h('span', { class: 'lockbadge' }, 'entsperrt') : null,
        h('div', { class: 'fname', title: f.name }, f.name),
        h('div', { class: 'fmeta' }, fileMeta(f), h('span', { class: 'pc' })),
        h('button', { class: 'remove', title: 'Entfernen', html: icon('x', 14), onclick: () => { this.files.splice(this.files.indexOf(f), 1); this.render(); } }));
      thumbnailInto(thumb, f);
      if (ext(f.name) === 'pdf') getPdfDoc(f).then((d) => { card.querySelector('.pc').textContent = ` · ${d.numPages} ${d.numPages === 1 ? 'Seite' : 'Seiten'}`; }).catch(() => {});
      if (t.sortable) this.makeSortable(card, f);
      list.append(card);
    });
    if (t.multiple !== false) list.append(h('button', { class: 'add-card', onclick: () => this.pick() }, ic('plus', 26), 'Dateien hinzufügen'));
    main.append(list);
  }

  makeSortable(card, f) {
    card.addEventListener('dragstart', (e) => { this.dragging = f; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.id); });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); this.dragging = null; });
    card.addEventListener('dragover', (e) => {
      if (!this.dragging) return;
      e.preventDefault(); e.stopPropagation();
      const r = card.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      card.classList.toggle('drop-after', after); card.classList.toggle('drop-before', !after);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-after', 'drop-before'));
    card.addEventListener('drop', (e) => {
      if (!this.dragging) return;
      e.preventDefault(); e.stopPropagation();
      const after = card.classList.contains('drop-after');
      card.classList.remove('drop-after', 'drop-before');
      const from = this.files.indexOf(this.dragging);
      this.files.splice(from, 1);
      let to = this.files.indexOf(f) + (after ? 1 : 0);
      this.files.splice(to, 0, this.dragging);
      this.dragging = null;
      this.render();
    });
  }

  async start() {
    const t = this.tool;
    if ((t.min || 1) > this.files.length && !t.noInput) { toast(t.minMessage || `Bitte mindestens ${t.min} Dateien hinzufügen.`, 'error'); return; }
    await this.exec(() => t.run({ files: this.files, opts: this.values, progress: (text, v) => busy(text, v) }));
  }

  async exec(fn, text = 'Wird verarbeitet …') {
    busy(text);
    const off = native.onProgress((p) => busy(p.text, p.value));
    try {
      const r = await fn();
      if (r) this.showResult(r);
    } catch (e) {
      console.error(e);
      if (e instanceof UserError) toast(e.message, 'error');
      else modal({ title: 'Das hat nicht geklappt', body: h('div', { class: 'error-box' }, String(e && e.message ? e.message : e)), buttons: [{ label: 'OK', primary: true, value: true }] });
    } finally {
      off();
      idle();
    }
  }

  showResult(r) {
    this.results = Array.isArray(r) ? { files: r } : r;
    this.render();
  }

  renderResult() {
    const r = this.results;
    const main = h('div', { class: 'tool-main' });
    const wrap = h('div', { class: 'result' });
    const total = r.files.reduce((s, f) => s + f.data.length, 0);
    wrap.append(h('div', { class: 'ok-icon', html: icon('check', 32) }), h('h3', {}, r.title || 'Fertig!'),
      h('p', { class: 'sub' }, r.message || (r.files.length === 1 ? 'Deine Datei ist bereit.' : `${r.files.length} Dateien sind bereit.`)));
    if (r.stats) wrap.append(h('div', { class: 'stat' }, r.stats));
    const list = h('div', { class: 'result-files' });
    for (const f of r.files) {
      list.append(h('div', { class: 'result-file' },
        h('span', { class: 'rf-icon', html: icon(ext(f.name) === 'pdf' ? 'file-check' : /png|jpe?g|webp|gif/.test(ext(f.name)) ? 'file-image' : ext(f.name) === 'zip' ? 'file-archive' : 'file-down', 18) }),
        h('span', { class: 'rf-name', title: f.name }, f.name),
        h('span', { class: 'rf-size' }, formatBytes(f.data.length)),
        r.files.length > 1 ? h('button', { class: 'btn small', onclick: () => this.saveOne(f, note) }, 'Herunterladen') : null));
    }
    if (r.files.length) wrap.append(list);
    const note = h('div', { class: 'saved-note hidden' });
    const actions = h('div', { class: 'result-actions' });
    if (r.files.length === 1) actions.append(h('button', { class: 'btn primary', onclick: () => this.saveOne(r.files[0], note) }, ic('download', 18), 'Herunterladen'));
    else if (r.files.length > 1) {
      const zip = async () => {
        busy('ZIP wird erstellt …');
        try { const z = await native.buildZip(r.files); idle(); this.saveOne({ name: `${r.zipName || 'PDF Editor'}.zip`, data: z }, note); } finally { idle(); }
      };
      actions.append(h('button', { class: 'btn primary', onclick: zip }, ic('file-archive', 18), 'Alle als ZIP herunterladen'));
      if (native.canPickFolder) actions.append(h('button', { class: 'btn', onclick: () => this.saveAll(r.files, note) }, ic('folder-open', 18), 'In Ordner speichern'));
    }
    actions.append(h('button', { class: 'btn', onclick: () => { this.results = null; if (!this.tool.keepFilesAfter) this.files.length = 0; this.render(); } }, ic('rotate-ccw', 18), this.tool.keepFilesAfter ? 'Zurück' : 'Neu beginnen'));
    wrap.append(actions, note);
    // Weiter bearbeiten (wie bei PDF24)
    const pdfs = r.files.filter((f) => ext(f.name) === 'pdf');
    if (pdfs.length === 1) {
      const chips = h('div', { class: 'chips' });
      for (const id of ['digisign', 'compress', 'merge', 'edit', 'sign', 'ocr', 'encrypt', 'rotate', 'sortpages', 'watermark', 'pagenumbers', 'pdf2img', 'split']) {
        const t = TOOLS.find((x) => x.id === id);
        if (!t || t.id === this.tool.id) continue;
        chips.append(h('button', { class: 'chip', onclick: () => go(t.id, [makeFile(pdfs[0].name, pdfs[0].data)]) }, h('span', { class: 'tool-icon', style: { '--c': t.color }, html: icon(t.icon, 14) }), t.name));
      }
      wrap.append(h('div', { class: 'continue' }, h('h4', {}, 'Weiter bearbeiten mit'), chips));
    }
    main.append(wrap);
    this.body.append(main);
  }

  async saveOne(f, note) {
    const p = await native.saveFile(f.name, f.data);
    if (!p) return;
    note.classList.remove('hidden');
    note.innerHTML = '';
    note.append(`Heruntergeladen: ${f.name}`);
    if (/^(pdf|png|jpe?g|webp|gif|txt|html)$/.test(ext(f.name))) note.append(' · ', h('a', { onclick: () => native.openPath(p) }, 'Im Browser öffnen'));
  }

  async saveAll(files, note) {
    const r = await native.saveFiles(files);
    if (!r) return;
    note.classList.remove('hidden');
    note.innerHTML = '';
    note.append(`${r.files.length} Dateien im Ordner „${r.dir}“ gespeichert.`);
  }
}

// Start
go(location.hash.slice(1) || 'home', [], { push: false });

export { ToolPage };
