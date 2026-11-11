(async () => {
  const FX=''; const R={ok:[],fail:[]};
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const ui=window.__app.ui;
  const load=async(n)=>{const d=await testApi.read(FX+n);return ui.makeFile(n,d,FX+n);};
  const btn=(t,root=document)=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim().includes(t));
  const click=async(t,root)=>{const b=btn(t,root); if(!b) throw new Error('Button fehlt: '+t); b.click(); await sleep(300);};
  const waitFor=async(fn,ms=20000)=>{const t0=Date.now();while(Date.now()-t0<ms){const v=fn();if(v)return v;await sleep(150);}throw new Error('Timeout');};
  const ptr=(el,type,x,y)=>el.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:y,button:0,bubbles:true,pointerId:1,isPrimary:true}));
  const drag=async(el,x1,y1,x2,y2)=>{ptr(el,'pointerdown',x1,y1);for(let k=1;k<=5;k++){ptr(el,'pointermove',x1+(x2-x1)*k/5,y1+(y2-y1)*k/5);await sleep(20);}ptr(el,'pointerup',x2,y2);await sleep(150);};
  async function results(label){const r=await waitFor(()=>window.__page.results,60000);const names=[];for(const f of r.files){await testApi.write(label+'__'+f.name,f.data);names.push(f.name);}await testApi.shot(label+'-result.png');return names;}
  async function step(label,fn){try{const v=await fn();R.ok.push({label,v});}catch(e){R.fail.push({label,err:String(e&&e.stack||e)});try{await testApi.shot(label+'-fail.png');}catch(_){}} document.querySelector('.modal-back')?.remove();}

  await step('rotate',async()=>{window.__go('rotate',[await load('doc.pdf')]);await sleep(1800);await click('Alle rechts');await sleep(800);await testApi.shot('rotate.png');document.querySelector('.page-tile .pt-actions button').click();await sleep(300);await click('Änderungen anwenden');return results('ui_rotate');});
  await step('delete',async()=>{window.__go('deletepages',[await load('doc.pdf')]);await sleep(1500);const t=document.querySelectorAll('.page-tile');t[1].click();await sleep(100);document.querySelectorAll('.page-tile')[5].click();await sleep(400);await testApi.shot('delete.png');await click('Seiten löschen');return results('ui_delete');});
  await step('extract',async()=>{window.__go('extractpages',[await load('doc.pdf')]);await sleep(1500);const i=document.querySelector('.tool-side input.input');i.value='1,3';await click('Übernehmen');await testApi.shot('extract.png');await click('Seiten extrahieren');return results('ui_extract');});
  await step('sort',async()=>{window.__go('sortpages',[await load('doc.pdf')]);await sleep(1500);await click('Umkehren');document.querySelectorAll('.page-tile')[0].click();await click('Leere Seite');await sleep(600);await testApi.shot('sort.png');await click('Speichern');return results('ui_sort');});
  await step('edit',async()=>{window.__go('edit',[await load('doc.pdf')]);await sleep(2500);
    const layer=document.querySelector('.epage .layer');const r=layer.getBoundingClientRect();
    await click('Text');ptr(layer,'pointerdown',r.left+80,r.top+430);await sleep(200);
    const te=document.querySelector('.obj.text.editing');te.innerText='Neuer Text Größe ✓ €';te.dispatchEvent(new Event('input'));te.blur();await sleep(200);
    await click('Rechteck');await drag(layer,r.left+60,r.top+460,r.left+260,r.top+540);
    await click('Ellipse');await drag(layer,r.left+300,r.top+460,r.left+420,r.top+540);
    await click('Pfeil');await drag(layer,r.left+60,r.top+600,r.left+300,r.top+650);
    await click('Freihand');await drag(layer,r.left+320,r.top+600,r.left+450,r.top+700);
    await click('Markieren');await drag(layer,r.left+40,r.top+52,r.left+300,r.top+70);
    await click('Abdecken');await drag(layer,r.left+40,r.top+110,r.left+400,r.top+125);
    await click('Auswählen');await sleep(300);await testApi.shot('edit.png');
    await click('Speichern',document.querySelector('.editor-side'));return results('ui_edit');});
  await step('sign',async()=>{window.__go('sign',[await load('doc_v2.pdf')]);await sleep(2500);
    await click('Unterschrift',document.querySelector('.editor-toolbar'));await sleep(500);
    const pad=document.querySelector('.sig-pad');const pr=pad.getBoundingClientRect();await drag(pad,pr.left+30,pr.top+120,pr.left+300,pr.top+60);await drag(pad,pr.left+60,pr.top+60,pr.left+200,pr.top+150);
    await testApi.shot('sign-modal.png');await click('Einfügen',document.querySelector('.modal'));await sleep(500);
    const layer=document.querySelector('.epage .layer');const r=layer.getBoundingClientRect();
    await click('Datum');ptr(layer,'pointerdown',r.left+80,r.top+300);await sleep(400);
    await testApi.shot('sign.png');await click('Speichern',document.querySelector('.editor-side'));return results('ui_sign');});
  await step('redact',async()=>{window.__go('redact',[await load('doc.pdf')]);await sleep(2500);
    const q=document.querySelector('.editor-toolbar input');q.value='IBAN DE89';await click('Alle schwärzen');await sleep(1500);
    const layer=document.querySelector('.epage .layer');const r=layer.getBoundingClientRect();
    await click('Bereich schwärzen');await drag(layer,r.left+60,r.top+100,r.left+260,r.top+115);
    await testApi.shot('redact.png');await click('Schwärzen',document.querySelector('.editor-side'));return results('ui_redact');});
  await step('compare',async()=>{window.__go('compare',[await load('doc.pdf'),await load('doc_v2.pdf')]);await sleep(2500);await testApi.shot('compare-text.png');await click('Visueller Vergleich');await sleep(3500);await testApi.shot('compare-visual.png');return document.querySelector('.info-box')?.textContent;});
  await step('forms',async()=>{window.__go('forms',[await load('form.pdf')]);await sleep(1500);const i=document.querySelector('.form-field-row input.input');i.value='Henning Köpchen';document.querySelector('.form-field-row input[type=checkbox]').checked=true;const s=document.querySelector('.form-field-row select');s.value='Hannover';await testApi.shot('forms.png');await click('Speichern');return results('ui_forms');});
  await step('metadata',async()=>{window.__go('metadata',[await load('doc.pdf')]);await sleep(1200);const i=document.querySelector('.tool-main input.input');i.value='Mein Titel';i.dispatchEvent(new Event('input'));await testApi.shot('metadata.png');await click('Speichern');return results('ui_meta');});
  await step('web2pdf',async()=>{window.__go('web2pdf');await sleep(500);const i=document.querySelector('.tool-main input.input');i.value='https://github.com';i.dispatchEvent(new Event('input'));await testApi.shot('web.png');await click('In PDF umwandeln');const t0=Date.now();while(Date.now()-t0<20000&&!document.querySelector('.tool-main .info-box:not(.hidden)'))await sleep(200);const hb=document.querySelector('.tool-main .info-box:not(.hidden)');await testApi.shot('web-help.png');if(!hb)throw new Error('Hilfe fehlt');return hb.textContent.slice(0,80);});
  await step('converter',async()=>{window.__go('converter');await sleep(500);await testApi.shot('converter.png');return 1;});
  await step('compress_page',async()=>{window.__go('compress',[await load('doc.pdf'),await load('scan.pdf')]);await sleep(2000);await testApi.shot('compress.png');await click('Komprimieren');return results('ui_compress');});
  await testApi.done(R);
})().catch(e=>testApi.done({fatal:String(e&&e.stack||e)}));
