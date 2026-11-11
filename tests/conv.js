(async()=>{const R={ok:[],fail:[]};const FX='';
const {TOOLS}=window.__app.tools;const ui=window.__app.ui;
const load=async(n)=>{const d=await testApi.read(FX+n);const f=ui.makeFile(n,d,FX+n);if(n.endsWith('.pdf'))await ui.preparePdf(f);return f;};
const opt=(tool,files,o)=>{const v={};const list=typeof tool.options==='function'?tool.options(files,v):(tool.options||[]);for(const x of list)if(x.default!==undefined)v[x.id]=x.default;return Object.assign(v,o);};
async function t(label,id,names,o={}){const tool=TOOLS.find(x=>x.id===id);try{const files=[];for(const n of names)files.push(await load(n));let r=await tool.run({files,opts:opt(tool,files,o),progress:()=>{}});if(Array.isArray(r))r={files:r};for(const f of r.files)await testApi.write(label+'__'+f.name,f.data);R.ok.push({label,msg:r.message||'',n:r.files.map(f=>f.name+':'+f.data.length)});}catch(e){R.fail.push({label,err:String(e&&e.stack||e)})}}
await t('epub','epub2pdf',['test.epub']);
await t('md','txt2pdf',['test.md']);
await t('txt','txt2pdf',['test.txt']);
await t('csv','excel2pdf',['test.csv']);
await t('wide','excel2pdf',['wide.xlsx']);
await t('xlsx','excel2pdf',['test.xlsx']);
await t('docx','word2pdf',['test.docx']);
await t('pptx','ppt2pdf',['test.pptx']);
await t('exif','img2pdf',['rotated_exif.jpg']);
await t('p2w','pdf2word',['doc.pdf']);
await t('p2h','pdf2html',['doc.pdf']);
await t('pdfa','pdfa',['doc.pdf']);
await t('compress_ocr','compress',['/tmp/claude-0/-home-claude/69a98cbe-c044-53ca-8f53-cc947082589d/scratchpad/out/../fx/scan.pdf'.split('/').pop()]);
await testApi.done(R);})().catch(e=>testApi.done({fatal:String(e.stack||e)}));
