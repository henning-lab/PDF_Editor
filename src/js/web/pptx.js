// PowerPoint (PPTX) → HTML. Jede Folie wird als absolut positionierte Fläche nachgebaut
// (Platzhalter mit Vererbung aus Layout und Master, Designfarben, Textformate, Aufzählungen,
// Bilder, Tabellen, Formen, Gruppen, Hintergründe). Anschließend setzt dom2pdf daraus Vektor-PDF.
import JSZip from 'jszip';

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU = 9525; // EMU je CSS-Pixel
const px = (emu) => (+emu || 0) / EMU;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- XML-Hilfen ----------
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
const path = (el, ...names) => { let e = el; for (const n of names) { e = kid(e, n); if (!e) return null; } return e; };
const attr = (el, n) => (el ? el.getAttribute(n) : null);
const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');
function resolvePath(base, rel) {
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = base.split('/'); parts.pop();
  for (const p of rel.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); }
  return parts.join('/');
}

// ---------- Farben ----------
function hexToRgb(h) { return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255); }
function rgbToHex(c) { return c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join(''); }
function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', navy: '000080' };

class Ctx {
  constructor(zip, theme, clrMap) { this.zip = zip; this.theme = theme; this.clrMap = clrMap || {}; this.media = new Map(); }
  scheme(name) {
    const mapped = this.clrMap[name] || name;
    return this.theme.colors[mapped] || this.theme.colors[name] || '000000';
  }
  /** Liefert { hex, a } aus einem Element, das eine Farbe enthält (srgbClr, schemeClr, …) */
  color(el, phClr) {
    if (!el) return null;
    const c = [...el.children].find((x) => /^(srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr)$/.test(x.localName));
    if (!c) return null;
    let hex;
    if (c.localName === 'srgbClr') hex = attr(c, 'val');
    else if (c.localName === 'schemeClr') hex = attr(c, 'val') === 'phClr' && phClr ? phClr : this.scheme(attr(c, 'val'));
    else if (c.localName === 'sysClr') hex = attr(c, 'lastClr') || (attr(c, 'val') === 'window' ? 'FFFFFF' : '000000');
    else if (c.localName === 'prstClr') hex = PRESET[attr(c, 'val')] || '000000';
    else if (c.localName === 'scrgbClr') hex = rgbToHex(['r', 'g', 'b'].map((k) => (+attr(c, k) || 0) / 100000));
    else hex = '000000';
    let rgb = hexToRgb(hex || '000000'); let a = 1;
    for (const m of c.children) {
      const v = (+attr(m, 'val') || 0) / 100000;
      switch (m.localName) {
        case 'lumMod': { const hsl = rgbToHsl(rgb); hsl[2] *= v; rgb = hslToRgb(hsl); break; }
        case 'lumOff': { const hsl = rgbToHsl(rgb); hsl[2] = Math.min(1, hsl[2] + v); rgb = hslToRgb(hsl); break; }
        case 'tint': rgb = rgb.map((x) => fromLin(toLin(x) * v + (1 - v))); break;
        case 'shade': rgb = rgb.map((x) => fromLin(toLin(x) * v)); break;
        case 'alpha': a = v; break;
        case 'satMod': { const hsl = rgbToHsl(rgb); hsl[1] = Math.min(1, hsl[1] * v); rgb = hslToRgb(hsl); break; }
        default: break;
      }
    }
    return { hex: rgbToHex(rgb), a };
  }
  css(col) { if (!col) return null; return col.a < 1 ? `rgba(${hexToRgb(col.hex).map((v) => Math.round(v * 255)).join(',')},${col.a.toFixed(3)})` : '#' + col.hex; }
  font(typeface) {
    if (!typeface) return null;
    if (typeface === '+mj-lt' || typeface === '+mj-ea') return this.theme.major;
    if (typeface === '+mn-lt' || typeface === '+mn-ea') return this.theme.minor;
    return typeface;
  }
  async image(partPath, rid, rels) {
    const target = rels[rid];
    if (!target) return null;
    const p = resolvePath(partPath, target);
    if (this.media.has(p)) return this.media.get(p);
    const f = this.zip.file(p);
    if (!f) { this.media.set(p, null); return null; }
    const ext = (p.split('.').pop() || '').toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' }[ext];
    if (!mime) { this.media.set(p, null); return null; } // EMF/WMF können Browser nicht darstellen
    const url = `data:${mime};base64,${await f.async('base64')}`;
    this.media.set(p, url);
    return url;
  }
}

async function readRelsTyped(zip, partPath) {
  const dir = partPath.split('/'); const file = dir.pop();
  const f = zip.file([...dir, '_rels', file + '.rels'].join('/'));
  const out = {};
  if (!f) return out;
  const x = parse(await f.async('string'));
  for (const r of x.getElementsByTagName('Relationship')) out[r.getAttribute('Id')] = { target: r.getAttribute('Target'), type: r.getAttribute('Type') };
  return out;
}

function readTheme(xml) {
  const colors = {}; let major = 'Calibri Light', minor = 'Calibri';
  if (xml) {
    const cs = xml.getElementsByTagNameNS(NS_A, 'clrScheme')[0];
    if (cs) for (const c of cs.children) {
      const v = c.children[0];
      if (!v) continue;
      colors[c.localName] = v.localName === 'sysClr' ? (attr(v, 'lastClr') || (attr(v, 'val') === 'window' ? 'FFFFFF' : '000000')) : attr(v, 'val');
    }
    const mj = xml.getElementsByTagNameNS(NS_A, 'majorFont')[0], mn = xml.getElementsByTagNameNS(NS_A, 'minorFont')[0];
    if (mj && kid(mj, 'latin')) major = attr(kid(mj, 'latin'), 'typeface') || major;
    if (mn && kid(mn, 'latin')) minor = attr(kid(mn, 'latin'), 'typeface') || minor;
  }
  const d = { dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72' };
  return { colors: { ...d, ...colors }, major, minor };
}
function readClrMap(el) {
  const m = {};
  if (el) for (const a of el.attributes) m[a.name] = a.value;
  return { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', ...m };
}

// ---------- Platzhalter und Vererbung ----------
function phOf(sp) {
  const nv = kid(sp, 'nvSpPr') || kid(sp, 'nvPicPr') || kid(sp, 'nvGraphicFramePr');
  const ph = nv && path(nv, 'nvPr', 'ph');
  if (!ph) return null;
  return { type: attr(ph, 'type') || 'obj', idx: attr(ph, 'idx') };
}
const phGroup = (t) => (t === 'ctrTitle' || t === 'title' ? 'title' : t === 'subTitle' || t === 'body' || t === 'obj' ? 'body' : t);
function findPh(tree, ph) {
  if (!tree || !ph) return null;
  const shapes = [...tree.getElementsByTagNameNS(NS_P, 'sp')];
  let byIdx = null, byType = null;
  for (const s of shapes) {
    const p = phOf(s);
    if (!p) continue;
    if (ph.idx && p.idx === ph.idx && !byIdx) byIdx = s;
    if (!byType && (p.type === ph.type || phGroup(p.type) === phGroup(ph.type))) byType = s;
  }
  if (byIdx && (!byType || ph.type === 'obj' || phGroup(phOf(byIdx).type) === phGroup(ph.type))) return byIdx;
  return byType || byIdx;
}

// Stufen-Eigenschaften (lvlNpPr) aus einem lstStyle oder txStyles-Eintrag
function levelProps(listEl, lvl) {
  if (!listEl) return null;
  return kid(listEl, `lvl${lvl + 1}pPr`);
}

// Zusammengeführte Absatz-/Zeicheneigenschaften entlang der Vererbungskette
function mergeP(chain) {
  const out = { rPr: {} };
  for (const p of chain) {
    if (!p) continue;
    for (const a of ['algn', 'marL', 'indent', 'rtl']) if (p.hasAttribute(a)) out[a] = attr(p, a);
    for (const n of ['lnSpc', 'spcBef', 'spcAft']) { const e = kid(p, n); if (e) out[n] = e; }
    for (const n of ['buNone', 'buChar', 'buAutoNum', 'buBlip']) if (kid(p, n)) { out.bu = kid(p, n); }
    if (kid(p, 'buClr')) out.buClr = kid(p, 'buClr');
    if (kid(p, 'buSzPct')) out.buSzPct = +attr(kid(p, 'buSzPct'), 'val') / 100000;
    if (kid(p, 'buFont')) out.buFont = attr(kid(p, 'buFont'), 'typeface');
    const d = kid(p, 'defRPr'); if (d) mergeR(out.rPr, d);
  }
  return out;
}
function mergeR(target, r) {
  if (!r) return target;
  for (const a of ['sz', 'b', 'i', 'u', 'strike', 'baseline', 'cap', 'spc']) if (r.hasAttribute(a)) target[a] = attr(r, a);
  const fill = kid(r, 'solidFill'); if (fill) target.fill = fill;
  if (kid(r, 'noFill')) target.fill = 'none';
  const lat = kid(r, 'latin'); if (lat) target.latin = attr(lat, 'typeface');
  return target;
}

// ---------- Rendern ----------
class SlideRenderer {
  constructor(ctx, parts) { this.ctx = ctx; this.parts = parts; }

  fillCss(spPr, style, part) {
    const c = this.ctx;
    if (spPr) {
      if (kid(spPr, 'noFill')) return { css: '' };
      const sf = kid(spPr, 'solidFill'); if (sf) return { css: `background:${c.css(c.color(sf))};` };
      const gf = kid(spPr, 'gradFill');
      if (gf) {
        const stops = kids(path(gf, 'gsLst'), 'gs').map((g) => ({ pos: +attr(g, 'pos') / 1000, col: c.css(c.color(g)) })).sort((a, b) => a.pos - b.pos);
        if (stops.length) return { css: `background:${stops[0].col};`, grad: stops };
      }
      const bf = kid(spPr, 'blipFill'); if (bf) return { blip: bf, part };
    }
    const ref = style && kid(style, 'fillRef');
    if (ref && +attr(ref, 'idx') > 0) { const col = c.color(ref); if (col) return { css: `background:${c.css(col)};` }; }
    return { css: '' };
  }

  lineCss(spPr, style) {
    const c = this.ctx;
    const ln = spPr && kid(spPr, 'ln');
    if (ln && kid(ln, 'noFill')) return null;
    let col = ln && kid(ln, 'solidFill') ? c.color(kid(ln, 'solidFill')) : null;
    let w = ln && ln.hasAttribute('w') ? px(attr(ln, 'w')) : null;
    if (!col) { const ref = style && kid(style, 'lnRef'); if (ref && +attr(ref, 'idx') > 0) { col = c.color(ref); if (w === null) w = 0.75 * (+attr(ref, 'idx')) * 1.333; } }
    if (!col) return null;
    if (w === null) w = 1;
    const dash = ln && kid(ln, 'prstDash') ? attr(kid(ln, 'prstDash'), 'val') : 'solid';
    return { w: Math.max(0.5, w), color: c.css(col), style: /dash/.test(dash) ? 'dashed' : /dot/.test(dash) ? 'dotted' : 'solid' };
  }

  xfrm(el, inherited) {
    const x = path(el, 'spPr', 'xfrm') || path(el, 'grpSpPr', 'xfrm') || kid(el, 'xfrm');
    if (x && kid(x, 'off') && kid(x, 'ext')) {
      return { x: +attr(kid(x, 'off'), 'x'), y: +attr(kid(x, 'off'), 'y'), w: +attr(kid(x, 'ext'), 'cx'), h: +attr(kid(x, 'ext'), 'cy'), flipH: attr(x, 'flipH') === '1', flipV: attr(x, 'flipV') === '1', rot: +attr(x, 'rot') || 0 };
    }
    for (const s of inherited) { const r = s && this.xfrm(s, []); if (r) return r; }
    return null;
  }

  // Text eines Formelements
  async text(sp, ph, inheritedShapes, box) {
    const c = this.ctx;
    const body = kid(sp, 'txBody');
    if (!body) return '';
    const paras = kids(body, 'p');
    if (!paras.some((p) => (p.textContent || '').trim()) ) return '';
    // bodyPr mit Vererbung
    const bodyPrs = [kid(body, 'bodyPr'), ...inheritedShapes.map((s) => path(s, 'txBody', 'bodyPr'))].filter(Boolean);
    const bp = (n) => { for (const b of bodyPrs) if (b.hasAttribute(n)) return attr(b, n); return null; };
    const anchor = bp('anchor') || 't';
    const ins = { l: px(bp('lIns') ?? 91440), r: px(bp('rIns') ?? 91440), t: px(bp('tIns') ?? 45720), b: px(bp('bIns') ?? 45720) };
    let fontScale = 1, lnRed = 0;
    for (const b of bodyPrs) { const na = kid(b, 'normAutofit'); if (na) { fontScale = (+attr(na, 'fontScale') || 100000) / 100000; lnRed = (+attr(na, 'lnSpcReduction') || 0) / 100000; break; } }
    const wrap = bp('wrap') !== 'none';
    const vert = bp('vert');
    // Listenstile: Form → Layout/Master-Platzhalter → Master-txStyles
    const lstChain = [kid(body, 'lstStyle'), ...inheritedShapes.map((s) => path(s, 'txBody', 'lstStyle'))];
    const group = ph ? phGroup(ph.type) : null;
    const master = this.parts.masterXml;
    const txStyles = master && master.getElementsByTagNameNS(NS_P, 'txStyles')[0];
    const masterList = !txStyles ? null : group === 'title' ? kid(txStyles, 'titleStyle') : group === 'body' ? kid(txStyles, 'bodyStyle') : kid(txStyles, 'otherStyle');
    const fontRef = path(sp, 'style', 'fontRef');
    const fontRefColor = fontRef ? c.color(fontRef) : null;
    const out = [];
    const autoNums = {};
    for (const p of paras) {
      const pPr = kid(p, 'pPr');
      const lvl = +(attr(pPr, 'lvl') || 0);
      const chain = [levelProps(masterList, lvl), ...[...lstChain].reverse().map((l) => levelProps(l, lvl)), pPr];
      // defaults aus master otherStyle für Nicht-Platzhalter
      const P = mergeP(chain);
      const endR = kid(p, 'endParaRPr');
      const runs = [...p.children].filter((x) => /^(r|br|fld)$/.test(x.localName));
      const align = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[P.algn || 'l'] || 'left';
      const baseR = { ...P.rPr };
      const sizeOf = (r) => ((+(r.sz || 1800)) / 100) * fontScale;
      const runCss = (r) => {
        const css = [];
        const size = sizeOf(r);
        css.push(`font-size:${size.toFixed(2)}pt`);
        const fam = c.font(r.latin) || (group === 'title' ? c.theme.major : c.theme.minor);
        css.push(`font-family:"${fam.replace(/"/g, '')}"`);
        if (r.b === '1' || r.b === 'true') css.push('font-weight:700');
        if (r.i === '1' || r.i === 'true') css.push('font-style:italic');
        const deco = []; if (r.u && r.u !== 'none') deco.push('underline'); if (r.strike && r.strike !== 'noStrike') deco.push('line-through');
        if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
        let col = r.fill && r.fill !== 'none' ? c.color(r.fill) : null;
        if (!col) col = fontRefColor || { hex: c.scheme('tx1'), a: 1 };
        css.push(`color:${c.css(col)}`);
        if (r.baseline && +r.baseline) css.push(`vertical-align:${+r.baseline > 0 ? 'super' : 'sub'};font-size:${(size * 0.65).toFixed(2)}pt`);
        if (r.cap === 'all') css.push('text-transform:uppercase');
        if (r.spc) css.push(`letter-spacing:${(+r.spc / 100).toFixed(2)}pt`);
        return css.join(';');
      };
      let html = '';
      let firstR = null;
      for (const r of runs) {
        if (r.localName === 'br') { html += '<br>'; continue; }
        const rp = mergeR({ ...baseR }, kid(r, 'rPr'));
        if (!firstR) firstR = rp;
        const t = (kid(r, 't')?.textContent || '').replace(/\t/g, '    ');
        html += `<span style="${runCss(rp)}">${esc(t)}</span>`;
      }
      const endProps = mergeR({ ...baseR }, endR);
      const ref = firstR || endProps;
      const size = sizeOf(ref);
      // Zeilenabstand
      let lh = 1.2;
      if (P.lnSpc) { const pct = path(P.lnSpc, 'spcPct'); const pts = path(P.lnSpc, 'spcPts'); if (pct) lh = 1.2 * (+attr(pct, 'val') / 100000); else if (pts) lh = (+attr(pts, 'val') / 100) / size; }
      lh = Math.max(0.6, lh * (1 - lnRed));
      const spc = (e) => { if (!e) return 0; const pct = kid(e, 'spcPct'); const pts = kid(e, 'spcPts'); return pct ? (size * +attr(pct, 'val') / 100000) : pts ? (+attr(pts, 'val') / 100) : 0; };
      const marL = px(P.marL || 0), indent = px(P.indent || 0);
      let bullet = '';
      if (P.bu && P.bu.localName !== 'buNone' && runs.some((r) => r.localName !== 'br' && (r.textContent || '').trim())) {
        let ch = '';
        if (P.bu.localName === 'buChar') ch = attr(P.bu, 'char') || '•';
        else if (P.bu.localName === 'buAutoNum') {
          const key = `${lvl}`; autoNums[key] = (autoNums[key] || (+attr(P.bu, 'startAt') || 1) - 1) + 1;
          for (const k of Object.keys(autoNums)) if (+k > lvl) delete autoNums[k];
          const n = autoNums[key]; const type = attr(P.bu, 'type') || 'arabicPeriod';
          const alpha = (x) => { let s = ''; while (x > 0) { x--; s = String.fromCharCode(97 + (x % 26)) + s; x = Math.floor(x / 26); } return s; };
          const roman = (x) => { const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [v, r] of t) while (x >= v) { s += r; x -= v; } return s; };
          let s = /alphaLc/.test(type) ? alpha(n) : /alphaUc/.test(type) ? alpha(n).toUpperCase() : /romanLc/.test(type) ? roman(n) : /romanUc/.test(type) ? roman(n).toUpperCase() : String(n);
          ch = /Paren(R|Both)/.test(type) ? (/ParenBoth/.test(type) ? `(${s})` : `${s})`) : /Period/.test(type) ? s + '.' : s;
        } else ch = '•';
        const wingdings = /wingdings|symbol/i.test(P.buFont || '');
        if (wingdings) { const map = { '§': '▪', 'Ø': '➢', 'ü': '✓', 'q': '❑', 'v': '❖', 'n': '■', 'l': '●', 'o': '○', 'Ÿ': '•', '·': '•' }; ch = map[ch] || (ch.charCodeAt(0) >= 0xF000 ? '•' : ch); }
        const bcol = P.buClr ? c.css(c.color(P.buClr)) : null;
        const bsz = size * (P.buSzPct || 1);
        const bw = Math.max(-indent, 0);
        bullet = `<span style="display:inline-block;width:${bw}px;min-width:${bw ? 0 : 0.6 * size}px;text-indent:0;font-size:${bsz.toFixed(2)}pt;${bcol ? `color:${bcol};` : runCss(ref).split(';').filter((x) => x.startsWith('color')).join(';') + ';'}font-family:${wingdings || P.bu.localName === 'buChar' ? '"DejaVu Sans"' : `"${(c.font(ref.latin) || c.theme.minor).replace(/"/g, '')}"`}">${esc(ch)}</span>`;
      }
      if (!html) html = `<span style="${runCss(endProps)}">&#8203;</span>`;
      out.push(`<div style="text-align:${align};padding-left:${marL}px;text-indent:${indent}px;line-height:${lh.toFixed(3)};margin-top:${spc(P.spcBef).toFixed(2)}pt;margin-bottom:${spc(P.spcAft).toFixed(2)}pt;font-size:${size.toFixed(2)}pt;">${bullet}${html}</div>`);
    }
    const just = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start';
    const vertical = vert && vert !== 'horz' ? 'writing-mode:vertical-rl;' : '';
    return `<div style="position:absolute;left:0;top:0;width:${box.w}px;height:${box.h}px;box-sizing:border-box;padding:${ins.t}px ${ins.r}px ${ins.b}px ${ins.l}px;display:flex;flex-direction:column;justify-content:${just};${wrap ? '' : 'white-space:nowrap;'}${vertical}overflow:visible;"><div>${out.join('')}</div></div>`;
  }

  async shape(sp, partPath, rels, off, layer) {
    const c = this.ctx;
    const ph = phOf(sp);
    const inherited = [];
    if (ph && layer === 'slide') { const l = findPh(this.parts.layoutTree, ph); if (l) inherited.push(l); const m = findPh(this.parts.masterTree, ph); if (m) inherited.push(m); }
    if (ph && layer === 'layout') { const m = findPh(this.parts.masterTree, ph); if (m) inherited.push(m); }
    // Platzhalter aus Layout/Master ohne eigenen Text nicht zeichnen (nur Hilfsrahmen)
    if (ph && layer !== 'slide') return '';
    const xf = this.xfrm(sp, inherited);
    if (!xf) return '';
    const box = { x: off.mapX(xf.x), y: off.mapY(xf.y), w: off.mapW(xf.w), h: off.mapH(xf.h) };
    const spPr = kid(sp, 'spPr');
    const style = kid(sp, 'style');
    const geom = path(spPr, 'prstGeom') ? attr(path(spPr, 'prstGeom'), 'prst') : (path(spPr, 'custGeom') ? 'cust' : 'rect');
    const fill = this.fillCss(spPr, style, partPath);
    const ln = this.lineCss(spPr, style);
    const out = [];
    const isLine = /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test(geom) || sp.localName === 'cxnSp';
    if (isLine) {
      if (ln) {
        if (box.h < 1 || box.w < 1) out.push(`<div style="position:absolute;left:${box.x}px;top:${box.y + (box.h < 1 ? -ln.w / 2 : 0)}px;width:${Math.max(box.w, ln.w)}px;height:${Math.max(box.h, ln.w)}px;background:${ln.color};"></div>`);
        else { // schräge Linie als SVG
          const [x1, y1, x2, y2] = [xf.flipH ? box.w : 0, xf.flipV ? box.h : 0, xf.flipH ? 0 : box.w, xf.flipV ? 0 : box.h];
          out.push(`<svg style="position:absolute;left:${box.x}px;top:${box.y}px;overflow:visible" width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ln.color}" stroke-width="${ln.w}"/></svg>`);
        }
      }
      return out.join('');
    }
    let radius = '';
    if (geom === 'roundRect') { const adj = path(spPr, 'prstGeom', 'avLst'); const g = adj && kid(adj, 'gd'); const v = g ? +(/val\s+(\d+)/.exec(attr(g, 'fmla') || '') || [])[1] || 16667 : 16667; radius = `border-radius:${(Math.min(box.w, box.h) * v) / 100000}px;`; }
    if (geom === 'ellipse') radius = 'border-radius:50%;';
    let bg = fill.css || '';
    if (fill.grad) bg = `background:linear-gradient(${fill.grad.map((s) => `${s.col} ${s.pos}%`).join(',')});`;
    const border = ln ? `border:${ln.w}px ${ln.style} ${ln.color};` : '';
    const simple = /^(rect|roundRect|ellipse|snip1Rect|flowChartProcess|flowChartAlternateProcess|textRect|cust)$/.test(geom) || !geom;
    if (fill.blip) {
      const rid = attr(kid(fill.blip, 'blip'), 'r:embed') || attr(kid(fill.blip, 'blip'), 'embed');
      const url = rid && await c.image(partPath, rid, rels);
      if (url) out.push(`<img src="${url}" style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;object-fit:fill;${radius}">`);
    } else if (bg || border) {
      if (simple || geom === 'cust') out.push(`<div style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;box-sizing:border-box;${bg}${border}${radius}"></div>`);
      else out.push(this.presetSvg(geom, box, fill, ln));
    }
    const txt = await this.text(sp, ph, inherited, box);
    if (txt) out.push(`<div style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;">${txt}</div>`);
    return out.join('');
  }

  presetSvg(geom, box, fill, ln) {
    const w = box.w, h = box.h;
    const col = /background:([^;]+)/.exec(fill.css || '')?.[1] || (fill.grad ? fill.grad[0].col : 'none');
    let d;
    switch (geom) {
      case 'triangle': d = `M${w / 2} 0 L${w} ${h} L0 ${h} Z`; break;
      case 'rtTriangle': d = `M0 0 L${w} ${h} L0 ${h} Z`; break;
      case 'diamond': d = `M${w / 2} 0 L${w} ${h / 2} L${w / 2} ${h} L0 ${h / 2} Z`; break;
      case 'parallelogram': d = `M${w * 0.25} 0 L${w} 0 L${w * 0.75} ${h} L0 ${h} Z`; break;
      case 'trapezoid': d = `M${w * 0.25} 0 L${w * 0.75} 0 L${w} ${h} L0 ${h} Z`; break;
      case 'pentagon': case 'homePlate': d = `M0 0 L${w - h / 2} 0 L${w} ${h / 2} L${w - h / 2} ${h} L0 ${h} Z`; break;
      case 'chevron': d = `M0 0 L${w - h / 2} 0 L${w} ${h / 2} L${w - h / 2} ${h} L0 ${h} L${h / 2} ${h / 2} Z`; break;
      case 'rightArrow': d = `M0 ${h * 0.25} L${w - h / 2} ${h * 0.25} L${w - h / 2} 0 L${w} ${h / 2} L${w - h / 2} ${h} L${w - h / 2} ${h * 0.75} L0 ${h * 0.75} Z`; break;
      case 'leftArrow': d = `M${w} ${h * 0.25} L${h / 2} ${h * 0.25} L${h / 2} 0 L0 ${h / 2} L${h / 2} ${h} L${h / 2} ${h * 0.75} L${w} ${h * 0.75} Z`; break;
      case 'hexagon': d = `M${w * 0.25} 0 L${w * 0.75} 0 L${w} ${h / 2} L${w * 0.75} ${h} L${w * 0.25} ${h} L0 ${h / 2} Z`; break;
      default: d = `M0 0 H${w} V${h} H0 Z`;
    }
    return `<svg style="position:absolute;left:${box.x}px;top:${box.y}px;overflow:visible" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="${col}" ${ln ? `stroke="${ln.color}" stroke-width="${ln.w}"` : ''}/></svg>`;
  }

  async picture(pic, partPath, rels, off) {
    const xf = this.xfrm(pic, []);
    if (!xf) return '';
    const blip = path(pic, 'blipFill', 'blip');
    const rid = blip && (blip.getAttributeNS(NS_R, 'embed') || attr(blip, 'r:embed'));
    const url = rid && await this.ctx.image(partPath, rid, rels);
    if (!url) return '';
    const box = { x: off.mapX(xf.x), y: off.mapY(xf.y), w: off.mapW(xf.w), h: off.mapH(xf.h) };
    const src = path(pic, 'blipFill', 'srcRect');
    if (src && [...src.attributes].some((a) => +a.value)) {
      const l = (+attr(src, 'l') || 0) / 100000, r = (+attr(src, 'r') || 0) / 100000, t = (+attr(src, 't') || 0) / 100000, b = (+attr(src, 'b') || 0) / 100000;
      const iw = box.w / (1 - l - r), ih = box.h / (1 - t - b);
      return `<div style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;overflow:hidden"><canvas data-crop="1" data-src="${url}" data-l="${l}" data-t="${t}" data-r="${r}" data-b="${b}" width="${Math.round(box.w * 2)}" height="${Math.round(box.h * 2)}" style="width:${box.w}px;height:${box.h}px;display:block"></canvas></div>`.replace('data-src', `data-iw="${iw}" data-ih="${ih}" data-src`);
    }
    const ln = this.lineCss(kid(pic, 'spPr'), kid(pic, 'style'));
    const geom = path(pic, 'spPr', 'prstGeom') ? attr(path(pic, 'spPr', 'prstGeom'), 'prst') : 'rect';
    return `<img src="${url}" style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;box-sizing:border-box;${ln ? `border:${ln.w}px ${ln.style} ${ln.color};` : ''}${geom === 'ellipse' ? 'border-radius:50%;' : ''}">`;
  }

  async table(gf, tbl, off) {
    const c = this.ctx;
    const xf = this.xfrm(gf, []);
    if (!xf) return '';
    const box = { x: off.mapX(xf.x), y: off.mapY(xf.y), w: off.mapW(xf.w) };
    const cols = kids(path(tbl, 'tblGrid'), 'gridCol').map((g) => off.mapW(+attr(g, 'w')));
    const tp = kid(tbl, 'tblPr');
    const firstRow = attr(tp, 'firstRow') === '1', bandRow = attr(tp, 'bandRow') === '1', firstCol = attr(tp, 'firstCol') === '1';
    const styleId = tp && kid(tp, 'tableStyleId') ? kid(tp, 'tableStyleId').textContent : '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';
    const hasStyle = !!styleId && styleId !== '{2D5ABB26-0587-4C30-8999-92F81FD0307C}'; // „Kein Format“
    const accent = hexToRgb(c.scheme('accent1'));
    const mix = (k) => '#' + rgbToHex(accent.map((v) => v + (1 - v) * k));
    const rows = kids(tbl, 'tr');
    let html = `<table style="position:absolute;left:${box.x}px;top:${box.y}px;width:${cols.reduce((a, b) => a + b, 0)}px;border-collapse:collapse;table-layout:fixed"><colgroup>${cols.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`;
    let bodyIdx = 0;
    for (let ri = 0; ri < rows.length; ri++) {
      const tr = rows[ri];
      const isHead = firstRow && ri === 0;
      const h = off.mapH(+attr(tr, 'h'));
      html += `<tr style="height:${h}px">`;
      let ci = 0;
      for (const tc of kids(tr, 'tc')) {
        if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') { ci++; continue; }
        const span = `${attr(tc, 'gridSpan') ? ` colspan="${attr(tc, 'gridSpan')}"` : ''}${attr(tc, 'rowSpan') ? ` rowspan="${attr(tc, 'rowSpan')}"` : ''}`;
        const tcPr = kid(tc, 'tcPr');
        let bg = '';
        let color = '#' + c.scheme('tx1'), bold = false;
        if (hasStyle) {
          if (isHead) { bg = '#' + c.scheme('accent1'); color = '#' + c.scheme('lt1'); bold = true; } else bg = bandRow && bodyIdx % 2 === 0 ? mix(0.74) : mix(0.88);
          if (firstCol && ci === 0 && !isHead) bold = true;
        }
        if (tcPr && kid(tcPr, 'solidFill')) bg = c.css(c.color(kid(tcPr, 'solidFill')));
        if (tcPr && kid(tcPr, 'noFill')) bg = '';
        const borders = [];
        for (const [tag, side] of [['lnL', 'left'], ['lnR', 'right'], ['lnT', 'top'], ['lnB', 'bottom']]) {
          const l = tcPr && kid(tcPr, tag);
          if (l && !kid(l, 'noFill') && kid(l, 'solidFill')) borders.push(`border-${side}:${Math.max(0.5, px(attr(l, 'w') || 12700))}px solid ${c.css(c.color(kid(l, 'solidFill')))}`);
          else if (hasStyle && !l) borders.push(`border-${side}:1px solid #ffffff`);
        }
        const mar = (n, d) => px(attr(tcPr, n) ?? d);
        const anchor = attr(tcPr, 'anchor');
        const paras = kids(kid(tc, 'txBody'), 'p').map((p) => {
          const algn = attr(kid(p, 'pPr'), 'algn');
          const runs = [...p.children].filter((x) => /^(r|br|fld)$/.test(x.localName)).map((r) => {
            if (r.localName === 'br') return '<br>';
            const rp = mergeR({}, kid(r, 'rPr'));
            const col = rp.fill && rp.fill !== 'none' ? c.css(c.color(rp.fill)) : color;
            const b = rp.b !== undefined ? (rp.b === '1') : bold;
            return `<span style="font-size:${(+(rp.sz || 1800) / 100).toFixed(1)}pt;color:${col};${b ? 'font-weight:700;' : ''}${rp.i === '1' ? 'font-style:italic;' : ''}font-family:&quot;${(c.font(rp.latin) || c.theme.minor).replace(/"/g, '')}&quot;">${esc(kid(r, 't')?.textContent || '')}</span>`;
          }).join('');
          return `<div style="text-align:${{ ctr: 'center', r: 'right', just: 'justify' }[algn] || 'left'};line-height:1.2">${runs || '&#8203;'}</div>`;
        }).join('');
        html += `<td${span} style="${bg ? `background:${bg};` : ''}${borders.join(';')};padding:${mar('marT', 45720)}px ${mar('marR', 91440)}px ${mar('marB', 45720)}px ${mar('marL', 91440)}px;vertical-align:${anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top'};overflow:hidden">${paras}</td>`;
        ci++;
      }
      html += '</tr>';
      if (!isHead) bodyIdx++;
    }
    return html + '</table>';
  }

  async tree(tree, partPath, rels, off, layer) {
    if (!tree) return '';
    const out = [];
    for (const el of tree.children) {
      switch (el.localName) {
        case 'sp': case 'cxnSp': out.push(await this.shape(el, partPath, rels, off, layer)); break;
        case 'pic': out.push(await this.picture(el, partPath, rels, off)); break;
        case 'grpSp': {
          const x = path(el, 'grpSpPr', 'xfrm');
          if (!x || !kid(x, 'off')) { out.push(await this.tree(el, partPath, rels, off, layer)); break; }
          const o = { x: +attr(kid(x, 'off'), 'x'), y: +attr(kid(x, 'off'), 'y'), w: +attr(kid(x, 'ext'), 'cx'), h: +attr(kid(x, 'ext'), 'cy') };
          const co = kid(x, 'chOff') ? { x: +attr(kid(x, 'chOff'), 'x'), y: +attr(kid(x, 'chOff'), 'y') } : { x: o.x, y: o.y };
          const ce = kid(x, 'chExt') ? { w: +attr(kid(x, 'chExt'), 'cx') || o.w, h: +attr(kid(x, 'chExt'), 'cy') || o.h } : { w: o.w, h: o.h };
          const sx = ce.w ? o.w / ce.w : 1, sy = ce.h ? o.h / ce.h : 1;
          const inner = {
            mapX: (v) => off.mapX(o.x + (v - co.x) * sx), mapY: (v) => off.mapY(o.y + (v - co.y) * sy),
            mapW: (v) => off.mapW(v * sx), mapH: (v) => off.mapH(v * sy),
          };
          out.push(await this.tree(el, partPath, rels, inner, layer));
          break;
        }
        case 'graphicFrame': {
          const gd = path(el, 'graphic', 'graphicData');
          const tbl = gd && kid(gd, 'tbl');
          if (tbl) out.push(await this.table(el, tbl, off));
          break;
        }
        case 'AlternateContent': {
          const fb = kid(el, 'Fallback') || kid(el, 'Choice');
          if (fb) out.push(await this.tree(fb, partPath, rels, off, layer));
          break;
        }
        default: break;
      }
    }
    return out.join('');
  }

  async background(parts) {
    const c = this.ctx;
    for (const [xml, partPath, rels] of parts) {
      const bg = xml && xml.getElementsByTagNameNS(NS_P, 'bg')[0];
      if (!bg) continue;
      const pr = kid(bg, 'bgPr');
      if (pr) {
        const f = this.fillCss(pr, null, partPath);
        if (f.blip) {
          const blip = kid(f.blip, 'blip');
          const rid = blip && (blip.getAttributeNS(NS_R, 'embed') || attr(blip, 'r:embed'));
          const url = rid && await c.image(partPath, rid, rels);
          if (url) return `<img src="${url}" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover">`;
        }
        if (f.grad) return `<div style="position:absolute;inset:0;background:linear-gradient(${f.grad.map((s) => `${s.col} ${s.pos}%`).join(',')})"></div>`;
        if (f.css) return `<div style="position:absolute;inset:0;${f.css}"></div>`;
      }
      const ref = kid(bg, 'bgRef');
      if (ref) { const col = c.color(ref); if (col) return `<div style="position:absolute;inset:0;background:${c.css(col)}"></div>`; }
    }
    return '';
  }
}

/** Liefert { width, height (px), slides: [html], hidden } */
export async function pptxToHtml(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) throw new Error('Keine PowerPoint-Präsentation (presentation.xml fehlt)');
  const pres = parse(await presFile.async('string'));
  const presRels = await readRelsTyped(zip, 'ppt/presentation.xml');
  const sz = pres.getElementsByTagNameNS(NS_P, 'sldSz')[0];
  const W = px(attr(sz, 'cx') || 9144000), H = px(attr(sz, 'cy') || 6858000);
  const ids = [...pres.getElementsByTagNameNS(NS_P, 'sldId')];
  const cache = new Map();
  const load = async (p) => { if (!cache.has(p)) { const f = zip.file(p); cache.set(p, f ? parse(await f.async('string')) : null); } return cache.get(p); };
  const slides = [];
  const identity = { mapX: px, mapY: px, mapW: px, mapH: px };
  for (const sid of ids) {
    const rid = sid.getAttributeNS(NS_R, 'id') || attr(sid, 'r:id');
    const rel = presRels[rid];
    if (!rel) continue;
    const slidePath = resolvePath('ppt/presentation.xml', rel.target);
    const slide = await load(slidePath);
    if (!slide) continue;
    if (attr(slide.documentElement, 'show') === '0') continue; // ausgeblendete Folie
    const sRels = await readRelsTyped(zip, slidePath);
    const layoutPath = resolvePath(slidePath, Object.values(sRels).find((r) => r.type.endsWith('/slideLayout'))?.target || '');
    const layout = await load(layoutPath);
    const lRels = await readRelsTyped(zip, layoutPath);
    const masterPath = resolvePath(layoutPath, Object.values(lRels).find((r) => r.type.endsWith('/slideMaster'))?.target || '');
    const master = await load(masterPath);
    const mRels = await readRelsTyped(zip, masterPath);
    const themePath = resolvePath(masterPath, Object.values(mRels).find((r) => r.type.endsWith('/theme'))?.target || '');
    const theme = readTheme(await load(themePath));
    const masterMap = readClrMap(master && master.getElementsByTagNameNS(NS_P, 'clrMap')[0]);
    const ovr = slide.getElementsByTagNameNS(NS_A, 'overrideClrMapping')[0] || (layout && layout.getElementsByTagNameNS(NS_A, 'overrideClrMapping')[0]);
    const ctx = new Ctx(zip, theme, ovr ? readClrMap(ovr) : masterMap);
    const plain = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.target]));
    const tree = (x) => x && x.getElementsByTagNameNS(NS_P, 'spTree')[0];
    const parts = { layoutTree: tree(layout), masterTree: tree(master), masterXml: master };
    const r = new SlideRenderer(ctx, parts);
    const showMaster = (x) => !x || attr(x.documentElement, 'showMasterSp') !== '0';
    let html = await r.background([[slide, slidePath, plain(sRels)], [layout, layoutPath, plain(lRels)], [master, masterPath, plain(mRels)]]);
    if (!html) html = `<div style="position:absolute;inset:0;background:#${ctx.scheme('bg1')}"></div>`;
    if (showMaster(slide) && showMaster(layout)) html += await r.tree(parts.masterTree, masterPath, plain(mRels), identity, 'master');
    if (showMaster(slide)) html += await r.tree(parts.layoutTree, layoutPath, plain(lRels), identity, 'layout');
    html += await r.tree(tree(slide), slidePath, plain(sRels), identity, 'slide');
    slides.push(html);
  }
  return { width: W, height: H, slides };
}

/** Zugeschnittene Bilder in den Canvas-Platzhaltern zeichnen */
export async function paintCrops(doc) {
  for (const cv of doc.querySelectorAll('canvas[data-crop]')) {
    const img = new Image(); img.src = cv.dataset.src;
    try { await img.decode(); } catch (_) { continue; }
    const l = +cv.dataset.l, t = +cv.dataset.t, r = +cv.dataset.r, b = +cv.dataset.b;
    const sx = img.naturalWidth * l, sy = img.naturalHeight * t, sw = img.naturalWidth * (1 - l - r), sh = img.naturalHeight * (1 - t - b);
    cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  }
}

