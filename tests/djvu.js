(async()=>{const R={ok:[],fail:[]};const D='/tmp/claude-0/-home-claude/69a98cbe-c044-53ca-8f53-cc947082589d/scratchpad/djvu/';
const {TOOLS}=window.__app.tools;const ui=window.__app.ui;
const tool=TOOLS.find(t=>t.id==='djvu2pdf');
const names=['DjVu3Spec.djvu','boy.djvu','boy_jb2_rotate90.djvu','boy_jb2_rotate270.djvu','colorbook.djvu','czech.djvu','deutsch.djvu','irish.djvu','navm_fgbz.djvu','big-scanned-page.djvu','carte.djvu','DjVu3Spec_indirect/index.djvu','vega.djvu','malliavin.djvu','history.djvu','problem_page.djvu','ccitt_2.djvu','chicken.djvu','happy_birthday.djvu'];
for(const n of names){const t0=performance.now();try{const d=await testApi.read(D+n);const f=ui.makeFile(n.replace('/','_'),d,D+n);
 const r=await tool.run({files:[f],opts:{quality:'high',textLayer:true,outline:true,ocr:false},progress:()=>{}});
 await testApi.write('dj_'+r.files[0].name,r.files[0].data);R.ok.push({n,ms:Math.round(performance.now()-t0),size:r.files[0].data.length,msg:r.message});}catch(e){R.fail.push({n,err:String(e&&e.stack||e)})}}
await testApi.done(R);})().catch(e=>testApi.done({fatal:String(e.stack||e)}));
