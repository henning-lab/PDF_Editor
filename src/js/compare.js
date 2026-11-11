// Zwei PDFs vergleichen (Text und visuell)
import { h, ic, toast, getPdfDoc, busy, idle } from './ui.js';
import { icon } from './icons.js';
import { renderPage, documentText } from './pdf.js';

export async function mountCompare(root, api) {
  const files = api.files;
  const main = h('div', { class: 'tool-main' });
  root.append(main);
  if (files.length < 2) {
    const slot = (f, label) => h('div', { class: 'file-card', style: { padding: '18px', alignItems: 'center', textAlign: 'center', minHeight: '180px', justifyContent: 'center' } },
      h('div', { class: 'hint' }, label),
      f ? h('div', { class: 'fname', style: { maxWidth: '100%' } }, f.name) : h('button', { class: 'btn primary', onclick: () => api.pick() }, ic('folder-open', 16), 'PDF auswählen'));
    main.append(h('div', { style: { maxWidth: '640px', margin: '30px auto' } },
      h('p', { class: 'hint', style: { textAlign: 'center', marginBottom: '18px' } }, 'Wähle zwei PDF-Dateien, die verglichen werden sollen.'),
      h('div', { class: 'compare-wrap' }, slot(files[0], 'Original'), slot(files[1], 'Geänderte Version'))));
    return;
  }
  const [a, b] = files;
  const v = api.values;
  v.view = v.view || 'text';
  const bar = h('div', { class: 'list-toolbar' });
  const seg = h('div', { class: 'seg', style: { width: '320px' } });
  for (const [id, label] of [['text', 'Textunterschiede'], ['visual', 'Visueller Vergleich']]) {
    seg.append(h('button', { class: v.view === id ? 'on' : '', onclick: () => { v.view = id; api.render(); } }, label));
  }
  bar.append(seg, h('div', { class: 'grow' }),
    h('button', { class: 'btn small', onclick: () => { files.reverse(); api.render(); } }, ic('arrow-left-right', 15), 'Tauschen'),
    h('button', { class: 'btn small ghost', onclick: () => { files.length = 0; api.render(); } }, 'Andere Dateien'));
  main.append(bar);
  const content = h('div');
  main.append(content);

  busy('Dateien werden verglichen …');
  try {
    const da = await getPdfDoc(a), db = await getPdfDoc(b);
    if (v.view === 'text') {
      const ta = await documentText(da), tb = await documentText(db);
      const diff = window.Diff.diffWordsWithSpace(ta.map((t, i) => `[[Seite ${i + 1}]]\n${t}`).join('\n\n'), tb.map((t, i) => `[[Seite ${i + 1}]]\n${t}`).join('\n\n'));
      let added = 0, removed = 0;
      const box = h('div', { class: 'diff-text' });
      for (const part of diff) {
        const words = part.value.trim() ? part.value.trim().split(/\s+/).length : 0;
        const segs = part.value.split(/(\[\[Seite \d+\]\])/);
        for (const s of segs) {
          if (!s) continue;
          const m = s.match(/^\[\[Seite (\d+)\]\]$/);
          if (m && !part.added && !part.removed) { box.append(h('div', { class: 'diff-page-h' }, `Seite ${m[1]}`)); continue; }
          if (m) continue;
          box.append(part.added ? h('ins', {}, s) : part.removed ? h('del', {}, s) : document.createTextNode(s));
        }
        if (part.added) added += words;
        if (part.removed) removed += words;
      }
      content.append(h('div', { class: 'legend', style: { margin: '0 0 12px' } },
        h('span', {}, h('i', { style: { background: '#c9f2d4' } }), `${added} Wörter hinzugefügt`),
        h('span', {}, h('i', { style: { background: '#fbd0d0' } }), `${removed} Wörter entfernt`),
        h('span', { class: 'muted' }, `„${a.name}“ → „${b.name}“`)));
      if (!added && !removed) content.append(h('div', { class: 'info-box' }, ta.join('').trim() || tb.join('').trim() ? 'Der Text beider Dateien ist identisch.' : 'Die Dateien enthalten keinen Text. Nutze den visuellen Vergleich oder vorher OCR.'));
      content.append(box);
    } else {
      content.append(h('div', { class: 'legend', style: { margin: '0 0 12px' } }, h('span', {}, h('i', { style: { background: '#ff2d2d' } }), 'Abweichende Bereiche sind rechts rot hervorgehoben')));
      const wrap = h('div', { class: 'compare-wrap' });
      const colA = h('div', { class: 'compare-col' }, h('h4', {}, a.name));
      const colB = h('div', { class: 'compare-col' }, h('h4', {}, b.name));
      wrap.append(colA, colB);
      content.append(wrap);
      const n = Math.max(da.numPages, db.numPages);
      let diffPages = 0;
      for (let i = 0; i < n; i++) {
        busy(`Seite ${i + 1} von ${n} wird verglichen …`, i / n);
        const ra = i < da.numPages ? await renderPage(da, i, 1.3) : null;
        const rb = i < db.numPages ? await renderPage(db, i, 1.3) : null;
        if (ra) colA.append(h('div', { class: 'compare-page' }, ra.canvas)); else colA.append(h('div', { class: 'compare-page info-box' }, `Seite ${i + 1} fehlt`));
        if (rb) {
          if (ra) {
            const cb = rb.canvas, ca = ra.canvas;
            const w = Math.min(ca.width, cb.width), hh = Math.min(ca.height, cb.height);
            const A = ca.getContext('2d').getImageData(0, 0, w, hh).data;
            const ctxB = cb.getContext('2d');
            const imgB = ctxB.getImageData(0, 0, w, hh);
            const B = imgB.data;
            let changed = 0;
            for (let k = 0; k < A.length; k += 4) {
              const d = Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2]);
              if (d > 60) { B[k] = 255; B[k + 1] = Math.round(B[k + 1] * 0.25); B[k + 2] = Math.round(B[k + 2] * 0.25); changed++; }
            }
            ctxB.putImageData(imgB, 0, 0);
            if (changed > 0 || ca.width !== cb.width || ca.height !== cb.height) diffPages++;
          } else diffPages++;
          colB.append(h('div', { class: 'compare-page' }, rb.canvas));
        } else { diffPages++; colB.append(h('div', { class: 'compare-page info-box' }, `Seite ${i + 1} fehlt`)); }
      }
      content.prepend(h('div', { class: diffPages ? 'info-box' : 'info-box' }, diffPages ? `${diffPages} von ${n} Seiten unterscheiden sich.` : 'Beide Dateien sehen identisch aus.'));
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally { idle(); }
  void icon;
}
