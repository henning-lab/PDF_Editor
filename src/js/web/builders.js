// Erstellt Word-, PowerPoint-, Excel- und ZIP-Dateien direkt im Browser.
const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

export async function buildDocx(model) {
  const { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, PageBreak, LineRuleType, Table, TableRow, TableCell, WidthType, BorderStyle } = await import('docx');
  const first = model.pages[0] || { width: 595, height: 842 };
  const children = [];
  const alignMap = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED, left: AlignmentType.LEFT };
  const contentWidthPt = first.width - 2 * 54;
  model.pages.forEach((page, pi) => {
    for (const b of page.blocks) {
      if (b.type === 'image') {
        const maxW = contentWidthPt * (96 / 72);
        let w = b.width * (96 / 72), h = b.height * (96 / 72);
        const maxH = (first.height - 2 * 54) * (96 / 72) - 20;
        if (w > maxW) { h = (h * maxW) / w; w = maxW; }
        if (h > maxH) { w = (w * maxH) / h; h = maxH; }
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120, line: 240, lineRule: LineRuleType.AUTO }, children: [new ImageRun({ type: b.imgType === 'jpg' ? 'jpg' : 'png', data: toU8(b.data), transformation: { width: Math.round(w), height: Math.round(h) } })] }));
      } else if (b.type === 'table') {
        const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFC5CF' };
        const cols = Math.max(...b.rows.map((r) => r.length));
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map((r, ri) => new TableRow({ children: Array.from({ length: cols }, (_, ci) => new TableCell({
            borders: { top: border, bottom: border, left: border, right: border },
            children: [new Paragraph({ children: [new TextRun({ text: r[ci] || '', size: Math.round((b.size || 10) * 2), bold: ri === 0 })] })],
          })) })),
        }));
        children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
      } else {
        children.push(new Paragraph({
          alignment: alignMap[b.align] || AlignmentType.LEFT,
          spacing: { after: Math.round((b.spaceAfter ?? 4) * 20), before: Math.round((b.spaceBefore ?? 0) * 20), line: 264, lineRule: LineRuleType.AUTO },
          indent: b.indent ? { left: Math.round(b.indent * 20) } : undefined,
          children: b.runs.map((r) => new TextRun({ text: r.text, size: Math.max(2, Math.round((r.size || 11) * 2)), bold: !!r.bold, italics: !!r.italic, font: r.font || undefined, color: r.color || undefined })),
        }));
      }
    }
    if (pi < model.pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  });
  const doc = new Document({
    creator: 'PDF Editor',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { line: 264, lineRule: LineRuleType.AUTO } } } } },
    sections: [{
      properties: { page: { size: { width: Math.round(first.width * 20), height: Math.round(first.height * 20) }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      children: children.length ? children : [new Paragraph('')],
    }],
  });
  return toU8(await (await Packer.toBlob(doc)).arrayBuffer());
}

export async function buildPptx(model) {
  const mod = await import('pptxgenjs');
  const PptxGenJS = mod.default || mod;
  const pptx = new PptxGenJS();
  const first = model.slides[0] || { width: 960, height: 540 };
  const wIn = first.width / 72, hIn = first.height / 72;
  pptx.defineLayout({ name: 'PDF', width: wIn, height: hIn });
  pptx.layout = 'PDF';
  for (const s of model.slides) {
    const slide = pptx.addSlide();
    // Seiten mit abweichendem Format proportional einpassen
    const scale = Math.min(wIn / (s.width / 72), hIn / (s.height / 72));
    const w = (s.width / 72) * scale, h = (s.height / 72) * scale;
    slide.addImage({ data: `data:image/jpeg;base64,${b64(toU8(s.image))}`, x: (wIn - w) / 2, y: (hIn - h) / 2, w, h });
    if (s.notes) slide.addNotes(s.notes);
  }
  return toU8(await pptx.write({ outputType: 'arraybuffer' }));
}

export async function buildXlsx(model) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  model.sheets.forEach((s, i) => {
    const ws = XLSX.utils.aoa_to_sheet(s.rows.length ? s.rows : [['']]);
    const widths = [];
    for (const row of s.rows) row.forEach((c, j) => { widths[j] = Math.min(60, Math.max(widths[j] || 6, String(c ?? '').length + 2)); });
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, (s.name || `Seite ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  });
  return toU8(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

export async function buildZip(files) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const used = new Set();
  for (const f of files) {
    let name = f.name, i = 1;
    while (used.has(name)) { const dot = f.name.lastIndexOf('.'); name = dot > 0 ? `${f.name.slice(0, dot)} (${i++})${f.name.slice(dot)}` : `${f.name} (${i++})`; }
    used.add(name);
    zip.file(name, toU8(f.data));
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
