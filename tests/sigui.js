(async () => {
  const FX=''; const R={ok:[],fail:[]};
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const ui=window.__app.ui; const native=window.__app.native;
  const load=async(n)=>{const d=await testApi.read(FX+n);return ui.makeFile(n,d,FX+n);};
  const btn=(t,root=document)=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim().includes(t));
  const click=async(t,root)=>{const b=btn(t,root); if(!b) throw new Error('Button fehlt: '+t); b.click(); await sleep(350);};
  const waitFor=async(fn,ms=30000)=>{const t0=Date.now();while(Date.now()-t0<ms){const v=fn();if(v)return v;await sleep(150);}throw new Error('Timeout');};
  const ptr=(el,type,x,y)=>el.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:y,button:0,bubbles:true,pointerId:1,isPrimary:true}));
  const drag=async(el,x1,y1,x2,y2)=>{ptr(el,'pointerdown',x1,y1);for(let k=1;k<=5;k++){ptr(el,'pointermove',x1+(x2-x1)*k/5,y1+(y2-y1)*k/5);await sleep(20);}ptr(el,'pointerup',x2,y2);await sleep(150);};
  async function step(label,fn){try{const v=await fn();R.ok.push({label,v});}catch(e){R.fail.push({label,err:String(e&&e.stack||e)});try{await testApi.shot(label+'-fail.png');}catch(_){}} }
  let signed=null;
  await step('certs-page',async()=>{ for(const c of await native.certs.list()) await native.certs.remove(c.id);
    await native.certs.create({name:'Henning Köpchen',email:'test@example.com',organization:'Koepchen Immobilien',city:'Hannover',password:'geheim1',years:3});
    window.__go('certs');await sleep(800);await testApi.shot('s-certs.png');return (await native.certs.list()).length;});
  await step('digisign',async()=>{
    window.__go('digisign',[await load('doc.pdf')]);await sleep(2500);
    await click('Unterschrift',document.querySelector('.editor-toolbar'));await sleep(400);
    await click('Tippen',document.querySelector('.modal'));await sleep(200);
    const inp=document.querySelector('.modal input.input');inp.value='Henning Köpchen';inp.dispatchEvent(new Event('input'));
    await click('Einfügen',document.querySelector('.modal'));await sleep(600);
    const sig=document.querySelector('.obj.signature');const before=sig.getBoundingClientRect();
    // Größe über Ecke links oben ändern
    const hnw=sig.querySelector('.handle.nw');const r=hnw.getBoundingClientRect();
    ptr(hnw,'pointerdown',r.left+5,r.top+5);const layer=sig.parentElement;for(let k=1;k<=5;k++){ptr(layer,'pointermove',r.left+5-k*12,r.top+5-k*4);await sleep(20);}ptr(layer,'pointerup',r.left-55,r.top-15);await sleep(300);
    const after=sig.getBoundingClientRect();
    await click('Groß',document.querySelector('.editor-side'));await sleep(200);
    const lbl=document.querySelector('.editor-side .label .val').textContent;
    await testApi.shot('s-editor.png');
    await click('Digital signieren',document.querySelector('.editor-side'));await sleep(500);
    await testApi.shot('s-pw.png');
    const pw=document.querySelector('.modal input[type=password]');pw.value='falsch';await click('Signieren',document.querySelector('.modal'));await sleep(600);
    const err=document.querySelector('.modal .error-box:not(.hidden)')?.textContent;
    pw.value='geheim1';await click('Signieren',document.querySelector('.modal'));
    const res=await waitFor(()=>window.__page.results,60000);signed=res.files[0];await testApi.write('s_signed.pdf',signed.data);await testApi.shot('s-result.png');
    return {before:[before.width|0,before.height|0],after:[after.width|0,after.height|0],lbl,err,msg:res.message};});
  await step('verify',async()=>{window.__go('verify',[ui.makeFile('s_signed.pdf',signed.data)]);await sleep(3000);await testApi.shot('s-verify.png');return document.querySelector('.verify-summary')?.textContent;});
  await step('verify-tampered',async()=>{const d=new Uint8Array(signed.data);const t=new TextDecoder('latin1').decode(d);const i=t.indexOf('Kapitel 1');d[i+8]=0x39;window.__go('verify',[ui.makeFile('t.pdf',d)]);await sleep(3000);await testApi.shot('s-verify-bad.png');return document.querySelector('.verify-summary')?.textContent;});
  await step('second-signer',async()=>{await native.certs.create({name:'Käufer Test',email:'k@test.de',password:'abcdef'});window.__go('digisign',[ui.makeFile('s_signed.pdf',signed.data)]);await sleep(2500);
    const sel=document.querySelector('.digital-box select');sel.value=[...sel.options].find(o=>o.textContent.includes('Käufer')).value;sel.dispatchEvent(new Event('change'));
    await click('Datum');const layer=document.querySelector('.epage .layer');const r=layer.getBoundingClientRect();ptr(layer,'pointerdown',r.left+100,r.top+300);await sleep(300);
    await click('Digital signieren',document.querySelector('.editor-side'));await sleep(400);const pw=document.querySelector('.modal input[type=password]');pw.value='abcdef';await click('Signieren',document.querySelector('.modal'));await sleep(1500);
    const toastTxt=document.querySelector('.toast')?.textContent;
    // Datum löschen, nur Stempel
    document.querySelector('.obj.text').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:r.left+101,clientY:r.top+300,pointerId:1}));await sleep(200);
    await click('Objekt löschen');await sleep(200);
    await click('Digital signieren',document.querySelector('.editor-side'));await sleep(400);const pw2=document.querySelector('.modal input[type=password]');pw2.value='abcdef';await click('Signieren',document.querySelector('.modal'));
    const res=await waitFor(()=>window.__page.results,60000);await testApi.write('s_two.pdf',res.files[0].data);return toastTxt;});
  await step('verify-two',async()=>{const d=await testApi.read('OUT:s_two.pdf');window.__go('verify',[ui.makeFile('s_two.pdf',d)]);await sleep(3000);await testApi.shot('s-verify-two.png');return document.querySelector('.verify-summary')?.textContent;});
  await testApi.done(R);
})().catch(e=>testApi.done({fatal:String(e&&e.stack||e)}));
