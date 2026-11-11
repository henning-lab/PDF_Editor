// Seiten-Organizer: Drehen, Löschen, Extrahieren, Sortieren
import { h, ic, toast, getPdfDoc, renderOptions } from './ui.js';
import { icon } from './icons.js';
import { renderPage } from './pdf.js';
import { PDFDocument, degrees, loadDoc, saveDoc, parseRanges, baseName, UserError, copyInfo } from './core.js';

const TEXT = {
  rotate: { hint: 'Fahre über eine Seite und drehe sie einzeln oder nutze die Schaltflächen oben.', action: 'Änderungen anwenden', suffix: 'gedreht' },
  delete: { hint: 'Klicke auf die Seiten, die gelöscht werden sollen.', action: 'Seiten löschen', suffix: 'bearbeitet' },
  extract: { hint: 'Klicke auf die Seiten, die du extrahieren möchtest.', action: 'Seiten extrahieren', suffix: 'Auszug' },
  sort: { hint: 'Ziehe die Seiten an die gewünschte Position. Mit Klick auswählen, Umschalt für Bereiche.', action: 'Speichern', suffix: 'sortiert' },
};

export async function mountOrganizer(root, api, mode) {
  const file = api.files[0];
  const pdf = await getPdfDoc(file);
  const n = pdf.numPages;
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const p = await pdf.getPage(i + 1);
    const vp = p.getViewport({ scale: 1 });
    sizes.push([vp.width, vp.height]);
  }
  let items = [...Array(n).keys()].map((i) => ({ uid: 'p' + i, index: i, rot: 0, deleted: false, selected: false, blank: false, w: sizes[i][0], h: sizes[i][1] }));
  let lastClicked = null;
  let uidCounter = 0;
  const thumbCache = new Map();

  const main = h('div', { class: 'tool-main' });
  const side = h('div', { class: 'tool-side' });
  root.append(main, side);

  // ---------- Werkzeugleiste ----------
  const toolbar = h('div', { class: 'list-toolbar' });
  const countHint = h('div', { class: 'hint' });
  const btn = (iconName, label, fn, title) => h('button', { class: 'btn small', title: title || label, onclick: fn }, ic(iconName, 16), label);
  const selected = () => items.filter((x) => x.selected);
  toolbar.append(countHint, h('div', { class: 'grow' }));
  if (mode === 'rotate') {
    toolbar.append(
      btn('rotate-ccw', 'Alle links', () => { items.forEach((x) => (x.rot = (x.rot + 270) % 360)); draw(); }),
      btn('rotate-cw', 'Alle rechts', () => { items.forEach((x) => (x.rot = (x.rot + 90) % 360)); draw(); }),
      btn('rotate-cw', 'Auswahl drehen', () => { if (!selected().length) return toast('Bitte zuerst Seiten auswählen (Klick).'); selected().forEach((x) => (x.rot = (x.rot + 90) % 360)); draw(); }),
      btn('undo-2', 'Zurücksetzen', () => { items.forEach((x) => (x.rot = 0)); draw(); }));
  }
  if (mode === 'sort') {
    toolbar.append(
      btn('arrow-down-up', 'Umkehren', () => { items.reverse(); draw(); }),
      btn('plus', 'Leere Seite', () => {
        const sel = selected();
        const at = sel.length ? items.indexOf(sel[sel.length - 1]) + 1 : items.length;
        const ref = items[Math.max(0, at - 1)] || { w: 595.28, h: 841.89 };
        items.splice(at, 0, { uid: 'b' + uidCounter++, blank: true, rot: 0, w: ref.w, h: ref.h, selected: false, deleted: false });
        draw();
      }, 'Leere Seite nach der Auswahl einfügen'),
      btn('copy', 'Duplizieren', () => {
        const sel = selected();
        if (!sel.length) return toast('Bitte zuerst Seiten auswählen.');
        const at = items.indexOf(sel[sel.length - 1]) + 1;
        items.splice(at, 0, ...sel.map((x) => ({ ...x, uid: 'd' + uidCounter++, selected: false })));
        draw();
      }),
      btn('trash-2', 'Entfernen', () => { if (!selected().length) return toast('Bitte zuerst Seiten auswählen.'); items = items.filter((x) => !x.selected); draw(); }),
      btn('undo-2', 'Zurücksetzen', () => { items = [...Array(n).keys()].map((i) => ({ uid: 'p' + i, index: i, rot: 0, deleted: false, selected: false, blank: false, w: sizes[i][0], h: sizes[i][1] })); draw(); }));
  }
  if (mode === 'extract' || mode === 'rotate' || mode === 'sort') {
    toolbar.append(btn('check', 'Alle', () => { items.forEach((x) => (x.selected = true)); draw(); }), btn('x', 'Keine', () => { items.forEach((x) => (x.selected = false)); draw(); }));
  }
  if (mode === 'delete') {
    toolbar.append(btn('undo-2', 'Alle wiederherstellen', () => { items.forEach((x) => (x.deleted = false)); draw(); }));
  }
  toolbar.append(h('button', { class: 'btn small ghost', onclick: () => { api.files.length = 0; api.render(); } }, 'Andere Datei'));
  const hint = h('div', { class: 'hint', style: { margin: '-6px 0 14px' } }, TEXT[mode].hint);
  const grid = h('div', { class: 'pages-grid' });
  main.append(toolbar, hint, grid);

  // ---------- Seitenleiste ----------
  const v = api.values;
  const scroll = h('div', { class: 'side-scroll' });
  const optBox = h('div');
  const rangeInput = h('input', { class: 'input', placeholder: 'z. B. 1-3, 5, gerade' });
  const applyRange = h('button', { class: 'btn small', style: { marginTop: '8px' }, onclick: () => {
    try {
      const idx = new Set(parseRanges(rangeInput.value, items.length));
      items.forEach((x, k) => { if (mode === 'delete') x.deleted = idx.has(k); else x.selected = idx.has(k); });
      draw();
    } catch (e) { toast(e.message, 'error'); }
  } }, 'Übernehmen');
  if (mode === 'delete' || mode === 'extract' || mode === 'rotate') {
    scroll.append(h('div', { class: 'side-title' }, 'Seiten wählen'), h('div', { class: 'field' },
      h('div', { class: 'label' }, mode === 'delete' ? 'Diese Seiten löschen' : 'Diese Seiten auswählen'), rangeInput, applyRange,
      h('div', { class: 'help' }, 'Bereiche mit Komma trennen. Auch „gerade“ oder „ungerade“ möglich.')));
  }
  if (mode === 'extract') {
    renderOptions(optBox, [{ id: 'separate', label: 'Jede Seite als eigene PDF', type: 'checkbox', default: false }], v);
    scroll.append(h('div', { class: 'side-title', style: { marginTop: '10px' } }, 'Optionen'), optBox);
  }
  if (mode === 'sort') {
    const sortSel = h('select', { class: 'input' },
      h('option', { value: '' }, 'Sortieren nach …'), h('option', { value: 'orig' }, 'Ursprüngliche Reihenfolge'),
      h('option', { value: 'oddeven' }, 'Erst ungerade, dann gerade'), h('option', { value: 'interleave' }, 'Duplex-Scan zusammenführen (1, n, 2, n−1 …)'));
    sortSel.addEventListener('change', () => {
      const real = items;
      if (sortSel.value === 'orig') items.sort((a, b) => (a.blank ? 1e9 : a.index) - (b.blank ? 1e9 : b.index));
      if (sortSel.value === 'oddeven') items = [...real.filter((_, k) => k % 2 === 0), ...real.filter((_, k) => k % 2 === 1)];
      if (sortSel.value === 'interleave') {
        // Vorderseiten 1..k, Rückseiten in umgekehrter Reihenfolge angehängt
        const half = Math.ceil(real.length / 2);
        const front = real.slice(0, half), back = real.slice(half).reverse();
        items = [];
        for (let k = 0; k < half; k++) { items.push(front[k]); if (back[k]) items.push(back[k]); }
      }
      sortSel.value = '';
      draw();
    });
    scroll.append(h('div', { class: 'side-title' }, 'Anordnung'), h('div', { class: 'field' }, sortSel), h('div', { class: 'hint' }, 'Tipp: Seiten per Drag & Drop verschieben. Mit Entf werden ausgewählte Seiten entfernt.'));
  }
  if (mode === 'rotate') scroll.append(h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Die Drehung wird verlustfrei gespeichert, der Inhalt bleibt unverändert.'));
  const runBtn = h('button', { class: 'btn primary big', onclick: () => run() }, TEXT[mode].action);
  side.append(scroll, h('div', { class: 'side-foot' }, runBtn));

  // ---------- Kacheln ----------
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); paintThumb(e.target); }
  }, { root: main, rootMargin: '300px' });

  async function paintThumb(tile) {
    const it = items.find((x) => x.uid === tile.dataset.uid);
    if (!it) return;
    const box = tile.querySelector('.pt-thumb');
    if (it.blank) {
      const r = it.rot % 180 ? it.w / it.h : it.h / it.w;
      box.innerHTML = '';
      box.append(h('div', { style: { width: r > 1 ? `${100 / r}%` : '100%', aspectRatio: `${it.rot % 180 ? it.h : it.w} / ${it.rot % 180 ? it.w : it.h}`, background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,.2)', display: 'grid', placeItems: 'center', color: '#999', fontSize: '11px', maxHeight: '100%' } }, 'Leer'));
      return;
    }
    const key = `${it.index}:${it.rot}`;
    let canvas = thumbCache.get(key);
    if (!canvas) {
      const page = await pdf.getPage(it.index + 1);
      const vp = page.getViewport({ scale: 1, rotation: (page.rotate + it.rot) % 360 });
      const dpr = window.devicePixelRatio || 1;
      const scale = (140 * dpr) / Math.max(vp.width, vp.height);
      canvas = (await renderPage(pdf, it.index, scale, { extraRotation: it.rot })).canvas;
      canvas.style.width = `${canvas.width / dpr}px`;
      thumbCache.set(key, canvas);
    }
    box.innerHTML = '';
    box.append(canvas.cloneNode(false));
    box.firstChild.getContext('2d').drawImage(canvas, 0, 0);
  }

  let dragging = null;
  function draw() {
    const pos = main.scrollTop;
    grid.innerHTML = '';
    items.forEach((it, k) => {
      const tile = h('div', { class: `page-tile ${it.selected ? 'selected' : ''} ${it.deleted ? 'deleted' : ''}`, 'data-uid': it.uid, draggable: mode === 'sort' ? 'true' : null },
        h('div', { class: 'pt-thumb' }),
        h('div', { class: 'pt-label' }, it.blank ? `${k + 1} · leer` : mode === 'sort' && it.index !== k ? `${k + 1} (S. ${it.index + 1})` : `Seite ${k + 1}`),
        mode !== 'delete' ? h('span', { class: 'pt-check', html: it.selected ? icon('check', 14) : '' }) : null);
      const actions = h('div', { class: 'pt-actions' });
      if (mode === 'rotate' || mode === 'sort') {
        actions.append(h('button', { title: 'Links drehen', html: icon('rotate-ccw', 15), onclick: (e) => { e.stopPropagation(); it.rot = (it.rot + 270) % 360; draw(); } }));
        actions.append(h('button', { title: 'Rechts drehen', html: icon('rotate-cw', 15), onclick: (e) => { e.stopPropagation(); it.rot = (it.rot + 90) % 360; draw(); } }));
      }
      if (mode === 'sort') actions.append(h('button', { title: 'Entfernen', html: icon('trash-2', 15), onclick: (e) => { e.stopPropagation(); items.splice(items.indexOf(it), 1); draw(); } }));
      if (mode === 'delete') actions.append(h('button', { title: it.deleted ? 'Wiederherstellen' : 'Löschen', html: icon(it.deleted ? 'undo-2' : 'trash-2', 15), onclick: (e) => { e.stopPropagation(); it.deleted = !it.deleted; draw(); } }));
      tile.append(actions);
      tile.addEventListener('click', (e) => {
        if (mode === 'delete') { it.deleted = !it.deleted; draw(); return; }
        if (e.shiftKey && lastClicked !== null) {
          const a = items.indexOf(lastClicked), b = items.indexOf(it);
          for (let q = Math.min(a, b); q <= Math.max(a, b); q++) items[q].selected = true;
        } else it.selected = !it.selected;
        lastClicked = it;
        draw();
      });
      if (mode === 'sort') {
        tile.addEventListener('dragstart', (e) => { dragging = it; tile.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.uid); });
        tile.addEventListener('dragend', () => { dragging = null; tile.classList.remove('dragging'); });
        tile.addEventListener('dragover', (e) => {
          if (!dragging) return; e.preventDefault(); e.stopPropagation();
          const r = tile.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
          tile.classList.toggle('drop-after', after); tile.classList.toggle('drop-before', !after);
        });
        tile.addEventListener('dragleave', () => tile.classList.remove('drop-after', 'drop-before'));
        tile.addEventListener('drop', (e) => {
          if (!dragging) return; e.preventDefault(); e.stopPropagation();
          const after = tile.classList.contains('drop-after');
          const moving = dragging.selected ? items.filter((x) => x.selected) : [dragging];
          if (moving.includes(it)) { draw(); return; }
          items = items.filter((x) => !moving.includes(x));
          const at = items.indexOf(it) + (after ? 1 : 0);
          items.splice(at, 0, ...moving);
          dragging = null;
          draw();
        });
      }
      grid.append(tile);
      io.observe(tile);
    });
    const del = items.filter((x) => x.deleted).length, sel = items.filter((x) => x.selected).length;
    countHint.textContent = mode === 'delete' ? `${items.length} Seiten · ${del} zum Löschen markiert` : `${items.length} Seiten${sel ? ` · ${sel} ausgewählt` : ''}`;
    main.scrollTop = pos;
  }

  const keyHandler = (e) => {
    if (!document.body.contains(grid)) { document.removeEventListener('keydown', keyHandler); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && mode !== 'delete') { e.preventDefault(); items.forEach((x) => (x.selected = true)); draw(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && mode === 'sort' && selected().length) { items = items.filter((x) => !x.selected); draw(); }
  };
  document.addEventListener('keydown', keyHandler);

  // ---------- Ausführen ----------
  async function build(list) {
    const src = await loadDoc(file.data);
    const outDoc = await PDFDocument.create();
    const real = list.filter((x) => !x.blank).map((x) => x.index);
    const copies = real.length ? await outDoc.copyPages(src, real) : [];
    let c = 0;
    for (const it of list) {
      if (it.blank) {
        const p = outDoc.addPage([it.w, it.h]);
        if (it.rot) p.setRotation(degrees(it.rot));
        continue;
      }
      const p = copies[c++];
      if (it.rot) p.setRotation(degrees((((p.getRotation().angle + it.rot) % 360) + 360) % 360));
      outDoc.addPage(p);
    }
    copyInfo(src, outDoc);
    return saveDoc(outDoc);
  }

  async function run() {
    await api.run(async () => {
      const name = (s) => `${baseName(file.name)}-${s}.pdf`;
      if (mode === 'rotate') return [{ name: name(TEXT.rotate.suffix), data: await build(items) }];
      if (mode === 'delete') {
        const keep = items.filter((x) => !x.deleted);
        if (keep.length === items.length) throw new UserError('Bitte zuerst Seiten zum Löschen markieren.');
        if (!keep.length) throw new UserError('Es können nicht alle Seiten gelöscht werden.');
        return { files: [{ name: name(TEXT.delete.suffix), data: await build(keep) }], message: `${items.length - keep.length} ${items.length - keep.length === 1 ? 'Seite wurde' : 'Seiten wurden'} entfernt.` };
      }
      if (mode === 'extract') {
        const sel = items.filter((x) => x.selected);
        if (!sel.length) throw new UserError('Bitte zuerst Seiten auswählen.');
        if (v.separate) {
          const res = [];
          for (const it of sel) res.push({ name: name(`Seite-${it.index + 1}`), data: await build([it]) });
          return { files: res, zipName: `${baseName(file.name)}-Seiten` };
        }
        return [{ name: name(TEXT.extract.suffix), data: await build(sel) }];
      }
      if (!items.length) throw new UserError('Die PDF muss mindestens eine Seite enthalten.');
      return [{ name: name(TEXT.sort.suffix), data: await build(items) }];
    });
  }

  draw();
}
