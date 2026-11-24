// CapCut Desk server: 127.0.0.1 only. DRY=1 uses the fake engine. Env: PORT, DESK_DIR (data), DESK_OUT (clips), NO_BROWSER=1 or --no-browser (do not open the browser).
if(process.env.CAPCUT_DESK_HOSTED==='1'){await (await import('./hosted.mjs')).startHosted(); await new Promise(()=>{});} // hosted prototype: own server, the desktop code below never runs
import {fileURLToPath} from 'node:url'; import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto'; import {execFile} from 'node:child_process';
import {checkUpdate} from './update.mjs'; import {assistants} from './assistants.mjs'; import {remoteOn,remoteOff,remoteStatus} from './remote.mjs';
import {createEngine,kindOf,BAD_KIND} from './engine.mjs'; import {createFake} from './fake-engine.mjs'; import {createQueue,MODELS,RATIOS,checkSpec} from './queue.mjs';
const PORT=+process.env.PORT||38917, DRY=!!process.env.DRY||process.argv.includes('--dry'), DIR=process.env.DESK_DIR||path.join(os.homedir(),'.capcut-desk',DRY?'dry':''), OUT=process.env.DESK_OUT||path.join(os.homedir(),'CapCut Desk',DRY?'DRY':'');
fs.mkdirSync(DIR,{recursive:true,mode:0o700});
// ROOT holds index.html and vendor/. In a bun single executable the source is virtual, so they ship beside the executable.
const ROOT=/\$bunfs|~BUN/.test(import.meta.url)?path.dirname(process.execPath):path.dirname(fileURLToPath(import.meta.url));
const UPLOADER=path.join(ROOT,'vendor/capcut-upload/scripts/capcut-upload.mjs');
const openUrl=u=>{if(process.env.NO_BROWSER||process.argv.includes('--no-browser'))return; const w=process.platform==='win32'; execFile(w?'cmd':process.platform==='darwin'?'open':'xdg-open',w?['/c','start','',u]:[u],()=>{});};
const engine=DRY?createFake():createEngine(DIR,UPLOADER), q=createQueue({engine,file:path.join(DIR,'jobs.json'),outDir:OUT});
const TOKEN=crypto.randomBytes(24).toString('hex'); // per run; the page gets it injected, the CLI reads it from run.json (mode 0600)
const MCP_CMD=/\$bunfs|~BUN/.test(import.meta.url)?[process.execPath,'--mcp']:[process.execPath,path.join(ROOT,'mcp.mjs')]; // how an AI assistant starts the bridge (see mcp.mjs)
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8').replace('__TOKEN__',TOKEN);
const hostOk=h=>h===`127.0.0.1:${PORT}`||h===`localhost:${PORT}`;
const send=(res,code,body,type='application/json')=>{res.writeHead(code,{'content-type':type,'cache-control':'no-store'});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
const body=req=>new Promise((ok,no)=>{let b='';req.on('data',c=>{b+=c;if(b.length>1e6){req.destroy();no(new Error('too big'));}});req.on('end',()=>{try{ok(b?JSON.parse(b):{});}catch(e){no(e);}});});
const view=()=>q.jobs().map(({generate_id,unique_key,...j})=>j);
async function account(){const s=engine.status(); if(!s.connected)return {connected:false}; const a=engine.active(); try{return {connected:true,id:a.id,...await engine.profile()};}catch(e){return {connected:true,id:a.id,nickname:a.nickname,error:String(e.message).slice(0,120)};}}

let lastHit=Date.now();
const server=http.createServer(async(req,res)=>{
  try{ lastHit=Date.now();
    if(!hostOk(req.headers.host))return send(res,403,{error:'bad host'});
    const u=new URL(req.url,'http://x'), p=u.pathname;
    if(req.method==='GET'){
      if(p==='/')return send(res,200,html,'text/html; charset=utf-8');
      if(p==='/callback'){ // CapCut sends the approving browser here
        try{await engine.finishLogin(req.url);return send(res,200,'CapCut connected. You can close this tab.','text/plain; charset=utf-8');}catch(e){return send(res,400,'Sign-in failed: '+e.message,'text/plain; charset=utf-8');}}
      if(p==='/api/ping')return send(res,200,{ok:true});
      if(p==='/api/update')return send(res,200,await checkUpdate());
      if(p==='/api/remote')return send(res,200,remoteStatus());
      if(p==='/api/assistants')return send(res,200,assistants(MCP_CMD).map(({add,...a})=>a));
      if(p==='/api/state')return send(res,200,{dry:DRY,models:MODELS,ratios:RATIOS,account:await account(),accounts:engine.accounts(),jobs:view(),creditsUsed:q.creditsUsed(),out:OUT});
      const m=p.match(/^\/api\/jobs\/(\w+)\/file\/(\d+)$/); // gallery playback; only paths recorded on a job are served
      if(m){const f=q.jobs().find(j=>j.id===m[1])?.files?.[+m[2]]; if(!f||!fs.existsSync(f))return send(res,404,{error:'no file'});
        const st=fs.statSync(f), r=(req.headers.range||'').match(/bytes=(\d*)-(\d*)/); let a=0,b=st.size-1,code=200; const h={'content-type':'video/mp4','accept-ranges':'bytes'};
        if(r&&(r[1]||r[2])){code=206; if(r[1]){a=+r[1];if(r[2])b=Math.min(+r[2],b);}else a=Math.max(0,st.size-+r[2]); h['content-range']=`bytes ${a}-${b}/${st.size}`;}
        h['content-length']=Math.max(0,b-a+1); res.writeHead(code,h); return fs.createReadStream(f,{start:a,end:b}).pipe(res);}
      return send(res,404,{error:'not found'});
    }
    // everything below changes state or costs a request: needs the run token and a local Origin
    const origin=req.headers.origin; if(req.method!=='POST'||req.headers['x-desk-token']!==TOKEN||(origin&&!hostOk(new URL(origin).host)))return send(res,403,{error:'forbidden'});
    if(p==='/api/upload'){ // raw file body, name in x-file-name: saved under DIR/refs, then uploaded to CapCut -> reference_asset
      const name=path.basename(decodeURIComponent(String(req.headers['x-file-name']||''))).replace(/[\x00-\x1f]/g,'')||'file'; if(!kindOf(name))throw new Error(BAD_KIND);
      const dir=path.join(DIR,'refs'); fs.mkdirSync(dir,{recursive:true,mode:0o700}); const f=path.join(dir,crypto.randomBytes(4).toString('hex')+'-'+name); let n=0;
      await new Promise((ok,no)=>{const w=fs.createWriteStream(f,{mode:0o600}); req.on('data',c=>{if((n+=c.length)>1e9){req.destroy();w.destroy();no(new Error('That file is too big (limit 1 GB).'));}}); req.pipe(w); w.on('finish',ok); w.on('error',no); req.on('error',no);});
      return send(res,200,await engine.upload(f));}
    const b=await body(req);
    if(p==='/api/quote'){checkSpec(b.spec);return send(res,200,await engine.quote(b.spec));}
    if(p==='/api/jobs'){ // b: {prompts:[..], spec (without prompt), name, ceiling (per job, the quote the user saw)}
      const prompts=(b.prompts||[]).map(s=>String(s).trim()).filter(Boolean); if(!prompts.length)throw new Error('no prompts');
      for(const pr of prompts)checkSpec({...b.spec,prompt:pr}); // validate all before queuing any
      let ceiling=+b.ceiling; if(!(ceiling>=0&&b.ceiling!=null))ceiling=(await engine.quote({...b.spec,prompt:prompts[0]})).credits;
      return send(res,200,prompts.map((pr,i)=>q.add({name:prompts.length>1?`${b.name||'Batch'} ${i+1}`:b.name,spec:{...b.spec,prompt:pr},ceiling}))); }
    let m=p.match(/^\/api\/jobs\/(\w+)\/(cancel|approve|retry)$/);
    if(m)return send(res,200,m[2]==='cancel'?await q.cancel(m[1]):m[2]==='retry'?q.retry(m[1]):q.approve(m[1],b.ceiling));
    m=p.match(/^\/api\/jobs\/(\w+)\/folder$/); if(m){const f=q.jobs().find(j=>j.id===m[1])?.files?.[0]; if(!f)throw new Error('no files yet'); process.platform==='win32'?execFile('explorer',['/select,'+f],()=>{}):execFile('open',['-R',f]); return send(res,200,{ok:true});}
    if(p==='/api/remote')return send(res,200,b.on?await remoteOn(ROOT):remoteOff());
    if(p==='/api/open-folder'){fs.mkdirSync(OUT,{recursive:true}); execFile(process.platform==='win32'?'explorer':'open',[OUT],()=>{}); return send(res,200,{ok:true});}
    m=p.match(/^\/api\/assistants\/([\w-]+)$/); if(m){const a=assistants(MCP_CMD).find(a=>a.id===m[1]); if(!a)throw new Error('unknown assistant'); await a.add(); return send(res,200,{ok:true});}
    if(p==='/api/connect/start')return send(res,200,{url:await engine.beginLogin(b.reconnect)});
    if(p==='/api/connect/finish'){await engine.finishLogin(b.address);return send(res,200,{ok:true});}
    if(p==='/api/accounts/switch'){engine.switchAccount(b.account);return send(res,200,{ok:true});}
    if(p==='/api/accounts/remove'){engine.removeAccount(b.account);return send(res,200,{ok:true});} // token only, history stays
    send(res,404,{error:'not found'});
  }catch(e){send(res,400,{error:String(e.message||e).slice(0,300)});}
});
server.on('error',e=>{if(e.code!=='EADDRINUSE')throw e; console.log(`CapCut Desk is already running on port ${PORT}.`); if(!DRY)openUrl(`http://127.0.0.1:${PORT}`); process.exit(0);}); // second double-click: just show the running copy
for(const sig of ['SIGTERM','SIGINT','SIGHUP'])process.on(sig,()=>{remoteOff();process.exit(0);}); // never leave a tunnel behind
// A copy started in the background by an assistant (mcp.mjs sets DESK_IDLE_EXIT) stops itself after 10 quiet minutes: no window polling, no jobs, no remote link.
if(process.env.DESK_IDLE_EXIT)setInterval(()=>{if(Date.now()-lastHit>6e5&&!remoteStatus().on&&!q.jobs().some(j=>j.status==='queued'||j.status==='running')){remoteOff();process.exit(0);}},6e4).unref?.();
server.listen(PORT,'127.0.0.1',()=>{fs.writeFileSync(path.join(DIR,'run.json'),JSON.stringify({port:PORT,token:TOKEN}),{mode:0o600});
  const url=`http://127.0.0.1:${PORT}`; console.log(`CapCut Desk on ${url}${DRY?'  (DRY MODE, nothing is charged)':''}`);q.start(); if(!DRY)openUrl(url);});
