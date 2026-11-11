(async () => {
  const R = { ok: [], fail: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ui = window.__app.ui; const native = window.__app.native;
  const load = async (n) => ui.makeFile(n, await testApi.read(n));
  const shot = async (n, fn) => { try { await fn(); await sleep(900); await testApi.shot(n + '.png'); R.ok.push({ label: n }); } catch (e) { R.fail.push({ label: n, err: String(e.stack || e) }); } };
  await shot('home-full', async () => window.__go('home'));
  await shot('converter', async () => window.__go('converter'));
  await shot('merge-empty', async () => window.__go('merge'));
  await shot('merge-files', async () => { const f = await load('doc.pdf'); const p = await load('doc_v2.pdf'); await ui.preparePdf(f); await ui.preparePdf(p); window.__go('merge', [f, p]); await sleep(1500); });
  await shot('certs', async () => { if (!(await native.certs.list()).length) await native.certs.create({ name: 'Henning Köpchen', email: 'info@example.com', organization: 'Köpchen Immobilien', password: 'geheim1', years: 3 }); window.__go('certs'); });
  await shot('digisign', async () => { const f = await load('doc.pdf'); window.__go('digisign', [f]); await sleep(2500); });
  await shot('sign-typed', async () => { const b = [...document.querySelectorAll('.editor-toolbar button')].find((x) => x.textContent.includes('Unterschrift')); b && b.click(); await sleep(500); const t = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.includes('Tippen')); t && t.click(); await sleep(300); const i = document.querySelector('.modal input.input'); if (i) { i.value = 'Henning Köpchen'; i.dispatchEvent(new Event('input')); } await document.fonts.ready; await sleep(500); });
  await shot('web2pdf', async () => { document.querySelector('.modal-back')?.remove(); window.__go('web2pdf'); });
  await shot('verify', async () => window.__go('verify'));
  await testApi.done(R);
})().catch((e) => testApi.done({ fatal: String(e && e.stack || e) }));
