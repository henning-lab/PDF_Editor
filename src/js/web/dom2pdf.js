// DOM → PDF: zeichnet ein im Browser gesetztes HTML-Dokument als echte Vektor-PDF
// (Text bleibt markierbar und durchsuchbar, Schriften werden eingebettet).
// Das Layout übernimmt der Browser, gezeichnet wird mit pdf-lib an exakt den gemessenen Positionen.
const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, setCharacterSpacing } = window.PDFLib;

// ---------- Schriften ----------
const FAMILIES = {
  sans: ['LiberationSans-Regular', 'LiberationSans-Bold', 'LiberationSans-Italic', 'LiberationSans-BoldItalic'],
  serif: ['LiberationSerif-Regular', 'LiberationSerif-Bold', 'LiberationSerif-Italic', 'LiberationSerif-BoldItalic'],
  mono: ['LiberationMono-Regular', 'LiberationMono-Bold', 'LiberationMono-Italic', 'LiberationMono-BoldItalic'],
  carlito: ['Carlito-Regular', 'Carlito-Bold', 'Carlito-Italic', 'Carlito-BoldItalic'],
  caladea: ['Caladea-Regular', 'Caladea-Bold', 'Caladea-Italic', 'Caladea-BoldItalic'],
  dejavu: ['DejaVuSans', 'DejaVuSans-Bold', 'DejaVuSans', 'DejaVuSans-Bold'],
};
const fontBytes = {};
function loadFontFile(name) {
  if (!fontBytes[name]) {
    fontBytes[name] = fetch(new URL(`fonts/${name}.ttf`, document.baseURI)).then((r) => { if (!r.ok) throw new Error(`Schrift ${name} konnte nicht geladen werden`); return r.arrayBuffer(); })
      .catch((e) => { delete fontBytes[name]; throw e; });
  }
  return fontBytes[name];
}

const SERIF = /^(times|times new roman|georgia|garamond|palatino|palatino linotype|book antiqua|bookman old style|century|century schoolbook|constantia|baskerville|didot|hoefler text|minion pro|liberation serif|dejavu serif|noto serif|serif|ui-serif|charter|iowan old style|sitka text|perpetua|rockwell|cochin)$/;
const MONO = /^(courier|courier new|consolas|monaco|menlo|lucida console|andale mono|sf mono|source code pro|fira code|liberation mono|dejavu sans mono|monospace|ui-monospace|roboto mono|ubuntu mono)$/;
function classify(family) {
  const first = String(family || '').split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (first.startsWith('d2p-')) return first.slice(4);
  if (/^(calibri|calibri light|carlito|candara|corbel)$/.test(first)) return 'carlito';
  if (/^(cambria|cambria math|caladea)$/.test(first)) return 'caladea';
  if (SERIF.test(first) || (/serif/.test(first) && !/sans/.test(first))) return 'serif';
  if (MONO.test(first) || /mono/.test(first)) return 'mono';
  if (/^(symbol|wingdings|wingdings 2|wingdings 3|webdings|zapf dingbats|dejavu sans|segoe ui symbol|arial unicode ms)$/.test(first)) return 'dejavu';
  return 'sans';
}
const isSymbolFont = (family) => /^["']?(symbol|wingdings|wingdings 2|wingdings 3|webdings)/i.test(String(family || '').trim());
// Zeichen aus Symbolschriften (Aufzählungszeichen aus Word) auf Unicode abbilden
const SYMBOLS = { 0xF0B7: '•', 0xF0A7: '▪', 0xF0D8: '➢', 0xF0FC: '✓', 0xF076: '❖', 0xF0A8: '◆', 0xF06E: '■', 0xF06F: '□', 0xF071: '❑', 0xF0E0: '→', 0xF0FB: '✗', 0xF02D: '–', 0xF0B0: '°', 0xF0E8: '➔', 0xF09F: '•', 0xF0A0: '▫', 0xF077: '◆', 0xF0FE: '☑', 0xF0A1: '○', 0xF06C: '●', 0x00B7: '•', 0x00A7: '▪', 0x006F: '○', 0x006E: '■', 0x00FC: '✓', 0x00D8: '➢', 0x0076: '❖' };
function mapSymbols(text, pua) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xF000 && cp <= 0xF0FF) out += SYMBOLS[cp] || (pua ? '•' : String.fromCharCode(cp - 0xF000));
    else if (pua && SYMBOLS[cp] && cp < 0x100 && !/\s/.test(ch)) out += SYMBOLS[cp];
    else out += ch;
  }
  return out;
}

// ---------- Hilfen ----------
function parseColor(str) {
  if (!str) return null;
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(str);
  if (!m) {
    const s = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(str);
    if (s) return { r: +s[1], g: +s[2], b: +s[3], a: s[4] === undefined ? 1 : +s[4] };
    return null;
  }
  let a = 1;
  if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
  return { r: m[1] / 255, g: m[2] / 255, b: m[3] / 255, a };
}
const px = (v) => parseFloat(v) || 0;
const BASE_CSS = `
html, body { margin: 0; padding: 0; background: #fff; }
*, *::before, *::after { font-kerning: none !important; font-variant-ligatures: none !important; font-feature-settings: "kern" 0, "liga" 0, "clig" 0, "calt" 0 !important; text-rendering: geometricPrecision !important; -webkit-text-size-adjust: none; hyphens: manual !important; }
[data-d2p-nb]::before, [data-d2p-na]::after { content: none !important; display: none !important; }
`;

/** Lädt HTML in einen unsichtbaren, skriptfreien Rahmen und ruft fn(doc, win) auf. */
export async function withFrame(html, widthPx, fn) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin'); // keine Skripte aus fremden Dokumenten
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${Math.ceil(widthPx)}px;height:800px;border:0;opacity:0;pointer-events:none;`;
  const loaded = new Promise((res) => frame.addEventListener('load', res, { once: true }));
  frame.srcdoc = html;
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument, win = frame.contentWindow;
    const st = doc.createElement('style');
    st.textContent = BASE_CSS;
    (doc.head || doc.documentElement).prepend(st);
    return await fn(doc, win, frame);
  } finally { frame.remove(); }
}

const nextFrame = () => new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(f); setTimeout(f, 80); });

async function waitImages(doc) {
  const imgs = [...doc.images];
  await Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 8000); }))));
}

// ---------- ::before / ::after in echte Elemente verwandeln (inkl. CSS-Zählern) ----------
function roman(n, upper) {
  if (n <= 0 || n >= 4000) return String(n);
  const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = ''; for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return upper ? s.toUpperCase() : s;
}
function alpha(n, upper) {
  if (n <= 0) return String(n);
  let s = ''; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return upper ? s.toUpperCase() : s;
}
function fmtCounter(n, style) {
  switch ((style || 'decimal').trim()) {
    case 'lower-alpha': case 'lower-latin': return alpha(n, false);
    case 'upper-alpha': case 'upper-latin': return alpha(n, true);
    case 'lower-roman': return roman(n, false);
    case 'upper-roman': return roman(n, true);
    case 'decimal-leading-zero': return n < 10 ? '0' + n : String(n);
    case 'disc': return '•'; case 'circle': return '◦'; case 'square': return '▪'; case 'none': return '';
    default: return String(n);
  }
}
const PSEUDO_PROPS = ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'min-width', 'max-width', 'height', 'min-height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'float', 'clear', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-align',
  'vertical-align', 'white-space', 'letter-spacing', 'text-indent', 'text-transform', 'text-decoration-line', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-sizing', 'opacity', 'z-index', 'transform', 'flex', 'align-self', 'overflow'];

function materializePseudo(doc, win, root) {
  const counters = {};
  const applyCounters = (cs) => {
    const each = (val, fn, def) => {
      if (!val || val === 'none') return;
      const parts = val.trim().split(/\s+/);
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i];
        let n = def;
        if (i + 1 < parts.length && /^-?\d+$/.test(parts[i + 1])) { n = +parts[i + 1]; i++; }
        fn(name, n);
      }
    };
    each(cs.counterReset, (n, v) => { counters[n] = v; }, 0);
    each(cs.counterSet, (n, v) => { counters[n] = v; }, 0);
    each(cs.counterIncrement, (n, v) => { counters[n] = (counters[n] || 0) + v; }, 1);
  };
  const resolve = (content, el) => {
    let out = '', ok = false;
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|counters?\(([^)]*)\)|attr\(([^)]*)\)|url\([^)]*\)|[a-z-]+/gi;
    let m;
    while ((m = re.exec(content))) {
      if (m[1] !== undefined || m[2] !== undefined) {
        out += (m[1] !== undefined ? m[1] : m[2]).replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hx) => String.fromCodePoint(parseInt(hx, 16))).replace(/\\(.)/g, '$1'); ok = true;
      } else if (m[3] !== undefined) {
        const args = m[3].split(',').map((s) => s.trim());
        const isMulti = /^counters/i.test(m[0]);
        out += fmtCounter(counters[args[0]] || 0, isMulti ? args[2] : args[1]); ok = true;
      } else if (m[4] !== undefined) { out += el.getAttribute(m[4].trim().split(/[\s,]/)[0]) || ''; ok = true; }
    }
    return ok ? out : null;
  };
  const jobs = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let el = root; el; el = walker.nextNode()) {
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none') continue;
    applyCounters(cs);
    for (const which of ['::before', '::after']) {
      const pcs = win.getComputedStyle(el, which);
      const c = pcs.content;
      if (!c || c === 'none' || c === 'normal') continue;
      if (pcs.display === 'none') continue;
      applyCounters(pcs);
      const text = resolve(c, el);
      if (text === null) continue;
      const hasBox = parseColor(pcs.backgroundColor)?.a > 0 || px(pcs.borderTopWidth) + px(pcs.borderBottomWidth) + px(pcs.borderLeftWidth) + px(pcs.borderRightWidth) > 0;
      if (text === '' && !hasBox) continue;
      const style = PSEUDO_PROPS.map((p) => `${p}:${pcs.getPropertyValue(p)}`).join(';');
      jobs.push({ el, which, text, style });
    }
  }
  for (const j of jobs) {
    const span = doc.createElement('span');
    span.setAttribute('style', j.style);
    span.setAttribute('data-d2p-pseudo', '');
    span.textContent = j.text;
    if (j.which === '::before') { j.el.setAttribute('data-d2p-nb', ''); j.el.prepend(span); } else { j.el.setAttribute('data-d2p-na', ''); j.el.append(span); }
  }
}

// ---------- Schriften im Dokument auf die mitgelieferten Schriften umstellen ----------
async function prepareFonts(doc, win, root) {
  const used = new Set(['dejavu']);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const jobs = [];
  for (let el = root; el; el = walker.nextNode()) {
    const cs = win.getComputedStyle(el);
    const fam = cs.fontFamily;
    const cls = classify(fam);
    const parentFam = el !== root && el.parentElement ? win.getComputedStyle(el.parentElement).fontFamily : null;
    if (isSymbolFont(fam)) jobs.push({ el, cls: 'dejavu', symbol: true });
    else if (el === root || fam !== parentFam) jobs.push({ el, cls });
    used.add(isSymbolFont(fam) ? 'dejavu' : cls);
  }
  for (const j of jobs) {
    j.el.style.setProperty('font-family', `"d2p-${j.cls}", "d2p-dejavu"`, 'important');
    if (j.symbol) for (const n of j.el.childNodes) if (n.nodeType === 3) n.data = mapSymbols(n.data, true);
  }
  // Private-Use-Zeichen außerhalb von Symbolschriften
  const tw = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (/[-]/.test(n.data)) n.data = mapSymbols(n.data, false);

  const faces = [];
  for (const fam of used) {
    FAMILIES[fam].forEach((file, i) => {
      if (fam === 'dejavu' && i > 1) return;
      faces.push(loadFontFile(file).then((buf) => {
        const ff = new win.FontFace(`d2p-${fam}`, buf.slice(0), { weight: i % 2 ? '700' : '400', style: fam !== 'dejavu' && i > 1 ? 'italic' : 'normal' });
        doc.fonts.add(ff);
        return ff.load();
      }));
    });
  }
  await Promise.all(faces);
  await doc.fonts.ready;
  return used;
}

// ---------- Elemente einsammeln ----------
function collect(doc, win, flow, ctx) {
  const items = [];
  const avoid = []; // Bereiche, die nicht zerschnitten werden sollen [oben, unten]
  const forced = []; // erzwungene Umbrüche (y)
  const root = flow.el;
  const range = doc.createRange();
  const ascentCache = new Map();
  const canvas = doc.createElement('canvas').getContext('2d');
  const ascentRatio = (fam, bold, italic) => {
    const key = `${fam}|${bold}|${italic}`;
    if (!ascentCache.has(key)) {
      canvas.font = `${italic ? 'italic ' : ''}${bold ? '700' : '400'} 100px "d2p-${fam}"`;
      const m = canvas.measureText('Hg');
      const a = m.fontBoundingBoxAscent, d = m.fontBoundingBoxDescent;
      ascentCache.set(key, a + d > 0 ? a / (a + d) : 0.8);
    }
    return ascentCache.get(key);
  };
  const decoCache = new WeakMap();
  const decoOf = (el) => {
    if (decoCache.has(el)) return decoCache.get(el);
    let u = false, s = false, color = null;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = win.getComputedStyle(e);
      const l = cs.textDecorationLine || '';
      if (l.includes('underline')) { u = true; color = color || cs.textDecorationColor; }
      if (l.includes('line-through')) { s = true; color = color || cs.textDecorationColor; }
      if (e === root || /^(inline-block|inline-table|table-cell)$/.test(cs.display) || cs.position === 'absolute' || cs.float !== 'none') break;
    }
    const r = { u, s, color };
    decoCache.set(el, r);
    return r;
  };

  const addText = (str, r, st, deco, prevRef) => {
    const baseline = r.top + r.height * ascentRatio(st.fam, st.bold, st.italic);
    const it = { t: 'text', str, x: r.left, y: r.top, h: r.height, w: r.width, baseline, ...st };
    if (deco.u || deco.s) {
      it.deco = deco;
      const prev = prevRef.prev;
      if (prev && Math.abs(prev.y - it.y) < 1 && it.x >= prev.x) prev.decoW = it.x - prev.x; // Linie bis zum nächsten Wort durchziehen
      prevRef.prev = it;
    }
    items.push(it);
    avoid.push([r.top, r.bottom]);
    return it;
  };

  const textNode = (tn, parent, pcs, alpha) => {
    const data = tn.data;
    if (!/\S/.test(data)) return;
    const col = parseColor(pcs.color) || { r: 0, g: 0, b: 0, a: 1 };
    if (col.a * alpha <= 0.01) return;
    const size = px(pcs.fontSize);
    if (size < 0.5) return;
    const st = { fam: classify(pcs.fontFamily), bold: (parseInt(pcs.fontWeight, 10) || 400) >= 600, italic: /italic|oblique/.test(pcs.fontStyle), size, color: col, alpha: col.a * alpha, ls: px(pcs.letterSpacing) };
    const tt = pcs.textTransform;
    const tr = (s) => (tt === 'uppercase' ? s.toUpperCase() : tt === 'lowercase' ? s.toLowerCase() : tt === 'capitalize' ? s.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()) : s);
    const deco = decoOf(parent);
    const prevRef = { prev: null };
    const collapse = !/^pre/.test(pcs.whiteSpace);
    const re = /\S+/g;
    let m;
    while ((m = re.exec(data))) {
      const a = m.index, b = a + m[0].length;
      range.setStart(tn, a); range.setEnd(tn, b);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) continue;
      const trail = collapse && b < data.length ? ' ' : '';
      if (rects.length === 1) { addText(tr(m[0]) + trail, rects[0], st, deco, prevRef); continue; }
      // Wort wurde umbrochen: zeichenweise messen und pro Zeile zusammenfassen
      let cur = null;
      for (let i = a; i < b;) {
        const cp = data.codePointAt(i); const len = cp > 0xFFFF ? 2 : 1;
        range.setStart(tn, i); range.setEnd(tn, i + len);
        const r = range.getClientRects()[0];
        if (r && r.width > 0) {
          if (cur && Math.abs(cur.r.top - r.top) < 1 && r.left >= cur.r.left) { cur.str += data.substr(i, len); cur.r = { left: cur.r.left, top: cur.r.top, height: cur.r.height, bottom: cur.r.bottom, width: r.right - cur.r.left }; } else { if (cur) addText(tr(cur.str), cur.r, st, deco, prevRef); cur = { str: data.substr(i, len), r: { left: r.left, top: r.top, height: r.height, bottom: r.bottom, width: r.width } }; }
        }
        i += len;
      }
      if (cur) addText(tr(cur.str) + trail, cur.r, st, deco, prevRef);
    }
  };

  const borderSide = (cs, side) => {
    const w = px(cs[`border${side}Width`]); const style = cs[`border${side}Style`];
    if (w <= 0 || style === 'none' || style === 'hidden') return null;
    const c = parseColor(cs[`border${side}Color`]);
    if (!c || c.a <= 0.01) return null;
    return { w, style, c };
  };

  const listMarker = (el, cs, rect, firstTextIndex) => {
    const type = cs.listStyleType;
    if (cs.display !== 'list-item' || type === 'none') return;
    let label;
    if (/^(disc|circle|square)$/.test(type)) label = fmtCounter(0, type);
    else {
      let n = 1;
      const list = el.parentElement;
      if (list) {
        n = list.tagName === 'OL' && list.hasAttribute('start') ? parseInt(list.getAttribute('start'), 10) || 1 : 1;
        for (const sib of list.children) { if (sib === el) break; if (sib.tagName === 'LI') { if (sib.hasAttribute('value')) n = (parseInt(sib.getAttribute('value'), 10) || n); n++; } }
        if (el.hasAttribute('value')) n = parseInt(el.getAttribute('value'), 10) || n;
      }
      label = fmtCounter(n, type) + '.';
    }
    if (!label) return;
    const size = px(cs.fontSize);
    const col = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    const first = items.slice(firstTextIndex).find((i) => i.t === 'text');
    const fam = classify(cs.fontFamily), bold = (parseInt(cs.fontWeight, 10) || 400) >= 600, italic = /italic/.test(cs.fontStyle);
    let baseline;
    if (first && first.y < rect.top + px(cs.paddingTop) + size * 2.5) baseline = first.baseline;
    else { const lh = cs.lineHeight === 'normal' ? size * 1.2 : px(cs.lineHeight); baseline = rect.top + px(cs.borderTopWidth) + px(cs.paddingTop) + (lh - size * 1.15) / 2 + size * 0.92; }
    const bullet = /^(disc|circle|square)$/.test(type);
    items.push({ t: 'text', marker: true, str: label, right: rect.left + px(cs.borderLeftWidth) + px(cs.paddingLeft) - size * (bullet ? 0.55 : 0.4), y: baseline - size, h: size * 1.2, baseline, fam: bullet ? 'dejavu' : fam, bold: bullet ? false : bold, italic: bullet ? false : italic, size: bullet ? size * 0.8 : size, color: col, alpha: col.a, ls: 0 });
  };

  const element = (el, alphaIn) => {
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none') return;
    const tag = el.tagName.toUpperCase();
    if (/^(SCRIPT|STYLE|HEAD|META|LINK|TITLE|NOSCRIPT|TEMPLATE)$/.test(tag)) return;
    const alpha = alphaIn * (cs.opacity === '' ? 1 : +cs.opacity);
    const visible = cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && alpha > 0.01;
    const rects = [...el.getClientRects()];
    const box = rects.length ? el.getBoundingClientRect() : null;
    if (box && visible && el !== root) {
      if (/^(page|always|left|right)$/.test(cs.breakBefore)) forced.push(box.top);
      if (/^(page|always|left|right)$/.test(cs.breakAfter)) forced.push(box.bottom);
      if (/^avoid/.test(cs.breakInside) || tag === 'TR' || tag === 'FIGURE') avoid.push([box.top, box.bottom]);
      if (/^H[1-6]$/.test(tag)) { const nx = el.nextElementSibling; if (nx) { const nb = nx.getBoundingClientRect(); if (nb.height > 0) avoid.push([box.top, Math.min(nb.bottom, nb.top + 36)]); } }
    }
    if (visible && el !== flow.skipBox) {
      const bg = parseColor(cs.backgroundColor);
      const radius = px(cs.borderTopLeftRadius);
      const sides = { Top: borderSide(cs, 'Top'), Right: borderSide(cs, 'Right'), Bottom: borderSide(cs, 'Bottom'), Left: borderSide(cs, 'Left') };
      const bgImg = cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage : null;
      let gradColor = null;
      if (bgImg && /gradient\(/.test(bgImg)) { const g = /rgba?\([^)]*\)/.exec(bgImg); gradColor = g ? parseColor(g[0]) : null; }
      for (const r of rects) {
        if (r.width <= 0 || r.height <= 0) continue;
        const fill = gradColor && gradColor.a > 0.01 ? gradColor : bg && bg.a > 0.01 ? bg : null;
        if (fill && !(el === root && fill.r === 1 && fill.g === 1 && fill.b === 1)) items.push({ t: 'rect', x: r.left, y: r.top, w: r.width, h: r.height, color: fill, alpha: fill.a * alpha, radius });
        const { Top: T, Right: R, Bottom: B, Left: L } = sides;
        if (T || R || B || L) {
          const same = T && R && B && L && [R, B, L].every((s) => s.w === T.w && s.style === T.style && s.c.r === T.c.r && s.c.g === T.c.g && s.c.b === T.c.b && s.c.a === T.c.a);
          if (same && (radius > 0 || T.style === 'dashed' || T.style === 'dotted')) items.push({ t: 'frame', x: r.left + T.w / 2, y: r.top + T.w / 2, w: r.width - T.w, h: r.height - T.w, bw: T.w, color: T.c, alpha: T.c.a * alpha, radius: Math.max(0, radius - T.w / 2), style: T.style });
          else {
            const line = (s, x, y, w, h, horiz) => { if (s) items.push({ t: 'bline', x, y, w, h, color: s.c, alpha: s.c.a * alpha, style: s.style, horiz }); };
            line(T, r.left, r.top, r.width, T ? T.w : 0, true);
            line(B, r.left, r.bottom - (B ? B.w : 0), r.width, B ? B.w : 0, true);
            line(L, r.left, r.top, L ? L.w : 0, r.height, false);
            line(R, r.right - (R ? R.w : 0), r.top, R ? R.w : 0, r.height, false);
          }
        }
      }
    }
    if (tag === 'IMG' || tag === 'CANVAS' || tag === 'SVG' || tag === 'VIDEO') {
      if (visible && box && box.width > 0.5 && box.height > 0.5) {
        const bl = px(cs.borderLeftWidth) + px(cs.paddingLeft), bt = px(cs.borderTopWidth) + px(cs.paddingTop);
        const w = box.width - bl - px(cs.borderRightWidth) - px(cs.paddingRight), h = box.height - bt - px(cs.borderBottomWidth) - px(cs.paddingBottom);
        if (w > 0.5 && h > 0.5) { items.push({ t: 'image', el, tag, x: box.left + bl, y: box.top + bt, w, h, alpha, fit: cs.objectFit }); if (h < ctx.maxAvoid) avoid.push([box.top, box.bottom]); }
      }
      return;
    }
    if (tag === 'BR' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED' || tag === 'AUDIO') return;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      const val = tag === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent : '') : /^(checkbox|radio|hidden|file|button|submit|image|range|color)$/.test(type) ? (/^(button|submit)$/.test(type) ? el.value : '') : (el.value || '');
      if (visible && box && val) {
        const size = px(cs.fontSize); const col = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
        const fam = classify(cs.fontFamily);
        const top = box.top + px(cs.borderTopWidth) + px(cs.paddingTop);
        items.push({ t: 'text', str: String(val).split('\n')[0].slice(0, 300), x: box.left + px(cs.borderLeftWidth) + px(cs.paddingLeft) + 1, y: top, h: size * 1.2, baseline: tag === 'TEXTAREA' ? top + size : box.top + box.height / 2 + size * 0.34, fam, bold: false, italic: false, size, color: col, alpha: col.a * alpha, ls: 0, maxRight: box.right - 2 });
      }
      return;
    }
    const firstIdx = items.length;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { if (visible) textNode(n, el, cs, alpha); } else if (n.nodeType === 1) element(n, alpha);
    }
    if (visible && box && tag === 'LI') listMarker(el, cs, box, firstIdx);
  };
  element(root, 1);
  return { items, avoid, forced };
}

// ---------- Bilder ----------
async function imageBytes(item, win) {
  const el = item.el;
  const toPng = async (source, w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    const g = c.getContext('2d');
    g.drawImage(source, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { type: 'png', data: new Uint8Array(await blob.arrayBuffer()) };
  };
  if (item.tag === 'CANVAS') { const blob = await new Promise((r) => el.toBlob(r, 'image/png')); return { type: 'png', data: new Uint8Array(await blob.arrayBuffer()) }; }
  if (item.tag === 'SVG') {
    const clone = el.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', item.w); clone.setAttribute('height', item.h);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    try { const img = new Image(); img.src = url; await img.decode(); return await toPng(img, item.w * 3, item.h * 3); } finally { URL.revokeObjectURL(url); }
  }
  if (item.tag !== 'IMG' || !el.naturalWidth) return null;
  const src = el.currentSrc || el.src;
  let blob = null;
  try { blob = await (await fetch(src)).blob(); } catch (_) { /* dann über Canvas */ }
  if (blob) {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const isJpg = head[0] === 0xFF && head[1] === 0xD8, isPng = head[0] === 0x89 && head[1] === 0x50;
    const maxW = Math.max(item.w * 4.2, 600);
    if (isJpg && el.naturalWidth <= maxW * 1.6) return { type: 'jpg', data: new Uint8Array(await blob.arrayBuffer()) };
    if (isPng && el.naturalWidth <= maxW && blob.size < 3e6) return { type: 'png', data: new Uint8Array(await blob.arrayBuffer()) };
    const scale = Math.min(1, maxW / el.naturalWidth);
    if (isJpg) {
      const c = document.createElement('canvas'); c.width = Math.round(el.naturalWidth * scale); c.height = Math.round(el.naturalHeight * scale);
      c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
      const jb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      return { type: 'jpg', data: new Uint8Array(await jb.arrayBuffer()) };
    }
    const isSvg = /svg/.test(blob.type) || /\.svg($|\?)/i.test(src);
    return toPng(el, isSvg ? item.w * 3 : el.naturalWidth * scale, isSvg ? item.h * 3 : el.naturalHeight * scale);
  }
  return toPng(el, el.naturalWidth, el.naturalHeight);
}

// ---------- Seitenumbrüche ----------
function paginate(startY, endY, sliceH, avoid, forced) {
  const merged = [];
  for (const [a, b] of avoid.filter(([a, b]) => b - a < sliceH * 0.92 && b > a).sort((p, q) => p[0] - q[0])) {
    const last = merged[merged.length - 1];
    if (last && a < last[1] - 0.25) { if (b - last[0] < sliceH * 0.92) last[1] = Math.max(last[1], b); else merged.push([Math.max(a, last[1]), b]); } else merged.push([a, b]);
  }
  const f = [...new Set(forced.map((y) => Math.round(y * 4) / 4))].filter((y) => y > startY + 1 && y < endY - 1).sort((a, b) => a - b);
  const breaks = [startY];
  let y = startY;
  let guard = 0;
  while (endY - y > sliceH + 0.5 || f.some((v) => v > y + 1)) {
    if (guard++ > 5000) break;
    let target = y + sliceH;
    const nf = f.find((v) => v > y + 1);
    if (nf !== undefined && nf <= target + 0.5) { y = nf; breaks.push(y); continue; }
    if (endY - y <= sliceH + 0.5) break;
    // größtes sicheres y <= target
    let cand = target;
    for (let k = 0; k < 50; k++) {
      const hit = merged.find(([a, b]) => cand > a + 0.25 && cand < b - 0.25);
      if (!hit) break;
      cand = hit[0];
    }
    if (cand <= y + sliceH * 0.08) cand = target; // nichts Sinnvolles gefunden: hart schneiden
    y = cand; breaks.push(y);
  }
  breaks.push(endY);
  return breaks;
}

/**
 * Wandelt vorbereitete Bereiche in eine PDF um.
 * flows: [{ el, pageW, pageH, k (pt je px), left, top, bottom (pt), startY, endY (px, optional), fixed (eine Seite, kein Umbruch), repeat: [{ el, at: 'top'|'bottom' }] }]
 */
export async function flowsToPdf(doc, win, flows, { title, onProgress } = {}) {
  const body = doc.body;
  materializePseudo(doc, win, body);
  await waitImages(doc);
  await prepareFonts(doc, win, body);
  await nextFrame();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(window.fontkit);
  if (title) pdf.setTitle(title);
  pdf.setProducer('PDF Editor'); pdf.setCreator('PDF Editor');
  const fonts = new Map();
  const getFont = async (fam, bold, italic) => {
    const file = FAMILIES[fam][(bold ? 1 : 0) + (italic ? 2 : 0)];
    if (!fonts.has(file)) {
      const f = await pdf.embedFont(await loadFontFile(file), { subset: true, features: { liga: false, clig: false, kern: false, calt: false, dlig: false } });
      fonts.set(file, { font: f, set: new Set(f.getCharacterSet()) });
    }
    return fonts.get(file);
  };
  const imgCache = new Map();
  const col = (c) => rgb(Math.min(1, c.r), Math.min(1, c.g), Math.min(1, c.b));
  let pageCount = 0;

  for (let fi = 0; fi < flows.length; fi++) {
    const flow = flows[fi];
    const k = flow.k || 0.75;
    const base = flow.el.getBoundingClientRect();
    const startY = flow.startY !== undefined ? flow.startY : base.top;
    let endY = flow.endY !== undefined ? flow.endY : base.bottom;
    const sliceH = flow.fixed ? Math.max(1, endY - startY) : (flow.pageH - flow.top - flow.bottom) / k;
    const { items, avoid, forced } = collect(doc, win, flow, { maxAvoid: sliceH * 0.9 });
    const repeats = (flow.repeat || []).map((r) => ({ ...r, ...collect(doc, win, { el: r.el }, { maxAvoid: 1e9 }), box: r.el.getBoundingClientRect() }));
    if (!flow.fixed && flow.endY === undefined) {
      // unten leeren Raum abschneiden
      let maxB = startY;
      for (const it of items) if (it.t !== 'rect' || it.h < sliceH) maxB = Math.max(maxB, it.y + (it.h || 0));
      endY = Math.min(endY, Math.max(maxB + 1, startY + 1));
    }
    const breaks = flow.fixed ? [startY, endY] : paginate(startY, endY, sliceH, avoid, forced);

    // Bilder vorbereiten
    for (const it of [...items, ...repeats.flatMap((r) => r.items)]) {
      if (it.t !== 'image') continue;
      const key = it.tag === 'IMG' ? (it.el.currentSrc || it.el.src) : it.el;
      if (!imgCache.has(key)) {
        let emb = null;
        try { const b = await imageBytes(it, win); if (b) emb = b.type === 'jpg' ? await pdf.embedJpg(b.data) : await pdf.embedPng(b.data); } catch (_) { emb = null; }
        imgCache.set(key, emb);
      }
      it.img = imgCache.get(key);
    }

    const drawItems = async (page, list, ox, oyTop, y0) => {
      // ox: pt-Verschiebung x, oyTop: pt-Abstand der Scheibenoberkante vom Seitenkopf
      const X = (xpx) => ox + (xpx - base.left) * k;
      const Y = (ypx) => flow.pageH - oyTop - (ypx - y0) * k;
      for (const it of list) {
        if (it.t === 'rect') {
          if (it.radius > 0.5) { const r = Math.min(it.radius, it.w / 2, it.h / 2) * k, w = it.w * k, h = it.h * k; page.drawSvgPath(`M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`, { x: X(it.x), y: Y(it.y), color: col(it.color), opacity: it.alpha, borderWidth: 0 }); } else page.drawRectangle({ x: X(it.x), y: Y(it.y + it.h), width: it.w * k, height: it.h * k, color: col(it.color), opacity: it.alpha, borderWidth: 0 });
        } else if (it.t === 'frame') {
          const r = Math.min(it.radius, it.w / 2, it.h / 2) * k, w = it.w * k, h = it.h * k;
          const dash = it.style === 'dashed' ? [it.bw * 3 * k, it.bw * 2 * k] : it.style === 'dotted' ? [it.bw * k, it.bw * k] : undefined;
          const path = r > 0.2 ? `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z` : `M 0 0 H ${w} V ${h} H 0 Z`;
          page.drawSvgPath(path, { x: X(it.x), y: Y(it.y), borderColor: col(it.color), borderWidth: it.bw * k, borderOpacity: it.alpha, borderDashArray: dash });
        } else if (it.t === 'bline') {
          if (it.style === 'dashed' || it.style === 'dotted') {
            const t = (it.horiz ? it.h : it.w) * k;
            const dash = it.style === 'dashed' ? [t * 3, t * 2] : [t, t];
            if (it.horiz) page.drawLine({ start: { x: X(it.x), y: Y(it.y + it.h / 2) }, end: { x: X(it.x + it.w), y: Y(it.y + it.h / 2) }, thickness: t, color: col(it.color), opacity: it.alpha, dashArray: dash });
            else page.drawLine({ start: { x: X(it.x + it.w / 2), y: Y(it.y) }, end: { x: X(it.x + it.w / 2), y: Y(it.y + it.h) }, thickness: t, color: col(it.color), opacity: it.alpha, dashArray: dash });
          } else if (it.style === 'double' && (it.horiz ? it.h : it.w) >= 3) {
            const t = (it.horiz ? it.h : it.w) / 3;
            if (it.horiz) { page.drawRectangle({ x: X(it.x), y: Y(it.y + t), width: it.w * k, height: t * k, color: col(it.color), opacity: it.alpha, borderWidth: 0 }); page.drawRectangle({ x: X(it.x), y: Y(it.y + it.h), width: it.w * k, height: t * k, color: col(it.color), opacity: it.alpha, borderWidth: 0 }); } else { page.drawRectangle({ x: X(it.x), y: Y(it.y + it.h), width: t * k, height: it.h * k, color: col(it.color), opacity: it.alpha, borderWidth: 0 }); page.drawRectangle({ x: X(it.x + it.w - t), y: Y(it.y + it.h), width: t * k, height: it.h * k, color: col(it.color), opacity: it.alpha, borderWidth: 0 }); }
          } else page.drawRectangle({ x: X(it.x), y: Y(it.y + it.h), width: it.w * k, height: it.h * k, color: col(it.color), opacity: it.alpha, borderWidth: 0 });
        } else if (it.t === 'image') {
          if (!it.img) continue;
          let { x, y, w, h } = it;
          if (it.fit === 'contain' || it.fit === 'scale-down') { const s = Math.min(w / it.img.width, h / it.img.height); const nw = it.img.width * s, nh = it.img.height * s; x += (w - nw) / 2; y += (h - nh) / 2; w = nw; h = nh; }
          page.drawImage(it.img, { x: X(x), y: Y(y + h), width: w * k, height: h * k, opacity: it.alpha });
        } else if (it.t === 'text') {
          const size = it.size * k;
          const primary = await getFont(it.fam, it.bold, it.italic);
          // Zeichen, die die Schrift nicht kennt, mit der Ersatzschrift zeichnen
          const runs = [];
          let clean = '';
          for (const ch of it.str) { const cp = ch.codePointAt(0); if (cp === 0xAD || cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0xFEFF || cp === 0x2060 || cp < 0x20) continue; clean += cp === 0xA0 ? ' ' : ch; }
          if (!clean) continue;
          let fb = null;
          for (const ch of clean) {
            const cp = ch.codePointAt(0);
            let f = primary;
            if (!primary.set.has(cp)) { fb = fb || await getFont('dejavu', it.bold, false); f = fb.set.has(cp) ? fb : null; }
            const last = runs[runs.length - 1];
            const chOut = f ? ch : '';
            if (last && last.f === (f || last.f)) last.s += chOut; else if (f) runs.push({ f, s: chOut });
          }
          let x = it.marker ? X(it.right) - runs.reduce((s, r) => s + r.f.font.widthOfTextAtSize(r.s, size), 0) : X(it.x);
          const y = Y(it.baseline);
          if (it.ls) page.pushOperators(setCharacterSpacing(it.ls * k));
          for (const r of runs) {
            if (!r.s) continue;
            let s = r.s;
            if (it.maxRight) { while (s.length > 1 && x + r.f.font.widthOfTextAtSize(s, size) > X(it.maxRight)) s = s.slice(0, -1); }
            page.drawText(s, { x, y, size, font: r.f.font, color: col(it.color), opacity: it.alpha });
            x += r.f.font.widthOfTextAtSize(s, size) + (it.ls ? it.ls * k * [...s].length : 0);
          }
          if (it.ls) page.pushOperators(setCharacterSpacing(0));
          if (it.deco) {
            const w = (it.decoW || it.w) * k; const th = Math.max(0.4, size / 16);
            const dc = parseColor(it.deco.color) || it.color;
            if (it.deco.u) page.drawRectangle({ x: X(it.x), y: y - size * 0.13 - th / 2, width: w, height: th, color: col(dc), opacity: it.alpha, borderWidth: 0 });
            if (it.deco.s) page.drawRectangle({ x: X(it.x), y: y + size * 0.27, width: w, height: th, color: col(dc), opacity: it.alpha, borderWidth: 0 });
          }
        }
      }
    };

    for (let p = 0; p + 1 < breaks.length; p++) {
      const y0 = breaks[p], y1 = breaks[p + 1];
      const list = items.filter((it) => { const top = it.y, bottom = it.y + (it.h || 0); return bottom > y0 + 0.2 && top < y1 - 0.2; });
      if (!flow.fixed && p > 0 && !list.some((it) => it.t === 'text' || it.t === 'image')) continue; // keine leeren Folgeseiten
      const page = pdf.addPage([flow.pageW, flow.pageH]);
      pageCount++;
      const top = flow.fixed ? 0 : flow.top;
      const h = (y1 - y0) * k;
      page.pushOperators(pushGraphicsState(), rectangle(0, flow.pageH - top - h - 0.6, flow.pageW, h + 1.2), clip(), endPath());
      await drawItems(page, list, flow.left || 0, top, y0);
      page.pushOperators(popGraphicsState());
      for (const r of repeats) {
        // Kopf- und Fußzeilen auf jeder Seite wiederholen
        const oy = r.at === 'top' ? (r.offset || 0) : flow.pageH - (r.offset || 0) - r.box.height * k;
        await drawItems(page, r.items, flow.left || 0, oy, r.box.top);
      }
      if (onProgress && pageCount % 5 === 0) { onProgress(pageCount); await new Promise((r) => setTimeout(r)); }
    }
  }
  if (!pdf.getPageCount()) pdf.addPage([595.28, 841.89]);
  return pdf.save();
}

export const PAGE_SIZES = { A4: [595.28, 841.89], A3: [841.89, 1190.55], A5: [419.53, 595.28], Letter: [612, 792], Legal: [612, 1008] };

/** Einfache HTML-Seite mit Rändern als PDF setzen. */
export async function htmlToPdfBytes(html, { pageSize = 'A4', landscape = false, margin = 42.5, scale = 1, title, viewportWidth, onProgress } = {}) {
  let [pw, ph] = Array.isArray(pageSize) ? pageSize : PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
  if (landscape) [pw, ph] = [ph, pw];
  const m = Array.isArray(margin) ? margin : [margin, margin, margin, margin];
  const contentPt = pw - m[1] - m[3];
  const k = viewportWidth ? contentPt / viewportWidth : 0.75 * scale;
  const widthPx = contentPt / k;
  return withFrame(html, widthPx, async (doc, win) => {
    doc.documentElement.style.width = `${widthPx}px`;
    doc.body.style.width = 'auto';
    await nextFrame();
    return flowsToPdf(doc, win, [{ el: doc.documentElement, pageW: pw, pageH: ph, k, left: m[3], top: m[0], bottom: m[2], startY: 0, skipBox: null }], { title, onProgress });
  });
}
