(async () => {
  const R = { ok: [], fail: [] };
  const { TOOLS } = window.__app.tools; const ui = window.__app.ui;
  const load = async (n, raw) => { const d = await testApi.read(n); const f = ui.makeFile(n, d); if (n.endsWith('.pdf') && !raw) await ui.preparePdf(f); return f; };
  const opt = (tool, files, o) => { const v = {}; const list = typeof tool.options === 'function' ? tool.options(files, v) : (tool.options || []); for (const x of list) if (x.default !== undefined) v[x.id] = x.default; return Object.assign(v, o); };
  async function t(label, id, names, o = {}) {
    const tool = TOOLS.find((x) => x.id === id); const t0 = performance.now();
    try { const files = []; for (const n of names) files.push(await load(n, tool.raw));
      let r = await tool.run({ files, opts: opt(tool, files, o), progress: () => {} }); if (Array.isArray(r)) r = { files: r };
      for (const f of r.files) await testApi.write(label + '__' + f.name, f.data);
      R.ok.push({ label, ms: Math.round(performance.now() - t0), msg: r.message || r.stats || '' });
    } catch (e) { R.fail.push({ label, err: String(e && e.stack || e) }); }
  }
  await t('merge', 'merge', ['doc.pdf', 'photo.jpg']);
  await t('compress', 'compress', ['doc.pdf']);
  await t('encrypt', 'encrypt', ['doc_v2.pdf'], { pw: 'abc', pw2: 'abc' });
  await t('unlock', 'unlock', ['enc_user.pdf'], { pw: 'geheim123' });
  await t('ocr', 'ocr', ['scan.pdf'], { langs: 'deu', dpi: 200 });
  await t('pdf2word', 'pdf2word', ['doc.pdf']);
  await t('pdf2ppt', 'pdf2ppt', ['doc_v2.pdf']);
  await t('pdf2excel', 'pdf2excel', ['doc.pdf']);
  await testApi.shot('home.png');
  await testApi.done(R);
})().catch((e) => testApi.done({ fatal: String(e && e.stack || e) }));
