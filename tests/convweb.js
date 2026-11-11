(async () => {
  const R = { ok: [], fail: [] };
  const native = window.__app.native;
  for (const n of ['test.docx', 'test.xlsx', 'wide.xlsx', 'test.pptx', 'test.html', 'test.md', 'test.txt', 'test.csv', 'test.epub', 'vertrag.docx', 'objekte.xlsx', 'marktbericht.pptx']) {
    const t0 = performance.now();
    try { const d = await testApi.read(n); const r = await native.documentToPdf({ name: n.split('/').pop(), data: d }); await testApi.write(n.split('/').pop() + '.pdf', r.data); R.ok.push({ label: n, ms: Math.round(performance.now() - t0), msg: r.engine }); }
    catch (e) { R.fail.push({ label: n, err: String(e && e.stack || e) }); }
  }
  await testApi.done(R);
})().catch((e) => testApi.done({ fatal: String(e && e.stack || e) }));
