// Unterschrift erstellen: zeichnen, tippen oder Bild
import { h, ic, modal, pickFiles, toast } from './ui.js';
import { native, ext } from './core.js';

const STORE = 'pdfeditor.signatures';
function loadSaved() { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (_) { return []; } }
function saveSaved(list) { try { localStorage.setItem(STORE, JSON.stringify(list.slice(0, 6))); } catch (_) {} }

// Schneidet transparente/weiße Ränder ab
function trimCanvas(src, pad = 8) {
  const ctx = src.getContext('2d');
  const { width: w, height: hgt } = src;
  const d = ctx.getImageData(0, 0, w, hgt).data;
  let minX = w, minY = hgt, maxX = -1, maxY = -1;
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(hgt - 1, maxY + pad);
  const c = document.createElement('canvas');
  c.width = maxX - minX + 1; c.height = maxY - minY + 1;
  c.getContext('2d').drawImage(src, minX, minY, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}
async function canvasToResult(c) {
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const data = new Uint8Array(await blob.arrayBuffer());
  return { data, width: c.width, height: c.height, url: c.toDataURL('image/png') };
}
async function dataUrlToResult(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return canvasToResult(c);
}

export async function createSignature() {
  let tab = 'draw';
  let color = '#0b1f66';
  const body = h('div');
  const tabs = h('div', { class: 'seg sig-tabs' });
  const content = h('div');
  const saved = loadSaved();
  let result = null; // Funktion, die das Ergebnis liefert
  const savedBox = h('div');

  function renderTabs() {
    tabs.innerHTML = '';
    for (const [id, label] of [['draw', 'Zeichnen'], ['type', 'Tippen'], ['image', 'Bild']]) {
      tabs.append(h('button', { type: 'button', class: tab === id ? 'on' : '', onclick: () => { tab = id; renderTabs(); renderContent(); } }, label));
    }
  }
  const colorRow = () => h('div', { class: 'seg', style: { marginTop: '10px', maxWidth: '260px' } },
    ...[['#0b1f66', 'Blau'], ['#111111', 'Schwarz'], ['#b91c1c', 'Rot']].map(([c, l]) => h('button', { type: 'button', class: color === c ? 'on' : '', onclick: (e) => { color = c; e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); onColor && onColor(); } }, h('span', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: c, marginRight: '6px' } }), l)));
  let onColor = null;

  function renderContent() {
    content.innerHTML = '';
    onColor = null;
    if (tab === 'draw') {
      const canvas = h('canvas', { class: 'sig-pad' });
      const dpr = window.devicePixelRatio || 1;
      let strokes = [];
      let cur = null;
      const ctx = canvas.getContext('2d');
      const resize = () => { canvas.width = canvas.clientWidth * dpr * 2; canvas.height = canvas.clientHeight * dpr * 2; redraw(); };
      const redraw = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const s of strokes) {
          if (s.length < 2) { ctx.beginPath(); ctx.fillStyle = color; ctx.arc(s[0][0], s[0][1], 2.6 * dpr * 2 / 2, 0, Math.PI * 2); ctx.fill(); continue; }
          ctx.lineWidth = 3.2 * dpr;
          ctx.beginPath(); ctx.moveTo(s[0][0], s[0][1]);
          for (let i = 1; i < s.length - 1; i++) { const mx = (s[i][0] + s[i + 1][0]) / 2, my = (s[i][1] + s[i + 1][1]) / 2; ctx.quadraticCurveTo(s[i][0], s[i][1], mx, my); }
          ctx.lineTo(s[s.length - 1][0], s[s.length - 1][1]); ctx.stroke();
        }
      };
      const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)]; };
      canvas.addEventListener('pointerdown', (e) => { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} cur = [pos(e)]; strokes.push(cur); redraw(); });
      canvas.addEventListener('pointermove', (e) => { if (!cur) return; cur.push(pos(e)); redraw(); });
      canvas.addEventListener('pointerup', () => { cur = null; });
      onColor = redraw;
      content.append(canvas, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, colorRow(), h('button', { class: 'btn small', style: { marginTop: '10px' }, onclick: () => { strokes = []; redraw(); } }, 'Löschen')));
      requestAnimationFrame(resize);
      result = async () => { if (!strokes.length) return null; const t = trimCanvas(canvas, 6); return t ? canvasToResult(t) : null; };
    } else if (tab === 'type') {
      const fonts = [['Great Vibes', 'Elegant'], ['Dancing Script', 'Schwungvoll'], ['Allura', 'Klassisch'], ['Sacramento', 'Fein'], ['Mr Dafoe', 'Kräftig'], ['Homemade Apple', 'Handschrift'], ['Caveat', 'Locker']];
      let font = (() => { try { return localStorage.getItem('pdfeditor.sigfont') || fonts[0][0]; } catch (_) { return fonts[0][0]; } })();
      if (!fonts.some(([f]) => f === font)) font = fonts[0][0];
      const input = h('input', { class: 'input', placeholder: 'Dein Name', value: (() => { try { return localStorage.getItem('pdfeditor.signame') || ''; } catch (_) { return ''; } })() });
      const grid = h('div', { class: 'sig-font-grid' });
      const upd = () => {
        const name = input.value.trim() || 'Unterschrift';
        grid.innerHTML = '';
        for (const [f, label] of fonts) {
          grid.append(h('button', { type: 'button', class: 'sig-font' + (f === font ? ' active' : ''), onclick: () => { font = f; upd(); } },
            h('span', { class: 'sig-font-sample', style: { fontFamily: `"${f}", cursive`, color } }, name),
            h('span', { class: 'sig-font-label' }, label)));
        }
      };
      input.addEventListener('input', upd);
      onColor = upd;
      content.append(h('div', { class: 'field' }, input), grid, colorRow());
      upd();
      setTimeout(() => input.focus(), 50);
      result = async () => {
        const text = input.value.trim();
        if (!text) return null;
        try { localStorage.setItem('pdfeditor.signame', text); localStorage.setItem('pdfeditor.sigfont', font); } catch (_) {}
        const c = document.createElement('canvas');
        const size = 140;
        try { await document.fonts.load(`${size}px "${font}"`, text); } catch (_) {}
        const ctx = c.getContext('2d');
        ctx.font = `${size}px "${font}", cursive`;
        const w = Math.ceil(ctx.measureText(text).width) + size;
        c.width = w; c.height = size * 2;
        const ctx2 = c.getContext('2d');
        ctx2.font = `${size}px "${font}", cursive`;
        ctx2.fillStyle = color; ctx2.textBaseline = 'middle';
        ctx2.fillText(text, size / 2, size);
        const t = trimCanvas(c, 10);
        return t ? canvasToResult(t) : null;
      };
    } else {
      let loaded = null;
      const removeBg = h('input', { type: 'checkbox', checked: true });
      const prev = h('div', { class: 'sig-type-preview', style: { height: '150px' } }, 'Noch kein Bild gewählt');
      const btn = h('button', { class: 'btn', onclick: async () => {
        const f = (await pickFiles('image', false))[0];
        if (!f) return;
        let data = f.data;
        if (['heic', 'heif', 'tif', 'tiff'].includes(ext(f.name))) data = await native.heicToJpeg({ name: f.name, data });
        const bmp = await createImageBitmap(new Blob([data]));
        loaded = bmp;
        draw();
      } }, ic('upload', 16), 'Bild auswählen');
      const out = document.createElement('canvas');
      const draw = () => {
        if (!loaded) return;
        const s = Math.min(1, 1600 / loaded.width);
        out.width = Math.round(loaded.width * s); out.height = Math.round(loaded.height * s);
        const ctx = out.getContext('2d');
        ctx.clearRect(0, 0, out.width, out.height);
        ctx.drawImage(loaded, 0, 0, out.width, out.height);
        if (removeBg.checked) {
          const id = ctx.getImageData(0, 0, out.width, out.height);
          const d = id.data;
          for (let i = 0; i < d.length; i += 4) {
            const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
            if (l > 215) d[i + 3] = 0; else if (l > 160) d[i + 3] = Math.round(d[i + 3] * (215 - l) / 55);
          }
          ctx.putImageData(id, 0, 0);
        }
        prev.innerHTML = '';
        const img = h('img', { src: out.toDataURL(), style: { maxWidth: '100%', maxHeight: '140px' } });
        prev.append(img);
      };
      removeBg.addEventListener('change', draw);
      content.append(btn, h('label', { class: 'check', style: { margin: '10px 0' } }, removeBg, 'Weißen Hintergrund entfernen'), prev);
      result = async () => { if (!loaded) return null; const t = removeBg.checked ? trimCanvas(out, 4) : out; return t ? canvasToResult(t) : null; };
    }
  }

  function renderSaved() {
    savedBox.innerHTML = '';
    const list = loadSaved();
    if (!list.length) return;
    savedBox.append(h('div', { class: 'label', style: { marginTop: '16px', fontWeight: 600, fontSize: '12.5px' } }, 'Gespeicherte Unterschriften'));
    const row = h('div', { class: 'sig-saved' });
    list.forEach((url, i) => {
      row.append(h('button', { type: 'button', title: 'Verwenden (Rechtsklick: löschen)', onclick: async () => { picked = await dataUrlToResult(url); document.querySelector('.modal-back .btn.primary').click(); },
        oncontextmenu: (e) => { e.preventDefault(); const l = loadSaved(); l.splice(i, 1); saveSaved(l); renderSaved(); } }, h('img', { src: url })));
    });
    savedBox.append(row);
  }
  let picked = null;
  renderTabs(); renderContent(); renderSaved();
  const remember = h('input', { type: 'checkbox', checked: true });
  body.append(tabs, content, h('label', { class: 'check', style: { marginTop: '12px' } }, remember, 'Unterschrift für später merken'), savedBox);
  void saved;
  const r = await modal({ title: 'Unterschrift erstellen', body, wide: true, buttons: [{ label: 'Abbrechen', value: null }, { label: 'Einfügen', primary: true, value: 'ok' }] });
  if (r !== 'ok') return null;
  if (picked) return picked;
  const res = await result();
  if (!res) { toast('Keine Unterschrift erstellt.', 'error'); return null; }
  if (remember.checked) { const l = loadSaved(); if (!l.includes(res.url)) { l.unshift(res.url); saveSaved(l); } }
  return res;
}
