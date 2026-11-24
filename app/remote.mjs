// Remote link: lets an assistant that runs in the cloud (claude.ai, ChatGPT in a browser or on a phone) reach this app.
// A second tiny server answers ONLY POST /mcp/<secret>; a tunnel gives it a public https address. The main app port is never exposed.
// ponytail: the secret address is the only lock, and the address is new on every start (Cloudflare quick tunnel, no account).
// Upgrade path: OAuth on this endpoint + a fixed address (Cloudflare named tunnel on our own domain) once the service has a name.
import http from 'node:http'; import crypto from 'node:crypto'; import {spawn} from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import {handle} from './mcp.mjs';
const exe=process.platform==='win32'?'cloudflared.exe':'cloudflared';
// the copy shipped inside the app first, then one installed on the computer
const findBin=root=>[path.join(root,'vendor',exe),...(process.env.PATH||'').split(path.delimiter).map(d=>path.join(d,exe)),'/opt/homebrew/bin/cloudflared','/usr/local/bin/cloudflared'].find(f=>{try{return fs.statSync(f).isFile();}catch{return false;}});
let srv=null, tun=null, watch=null, st={on:false,url:'',error:''};
export const remoteStatus=()=>st;
export function remoteOff(){clearInterval(watch); tun?.kill(); srv?.close(); tun=srv=null; st={on:false,url:'',error:''}; return st;}
// The tunnel tool sometimes quits on its first start (seen 2026-11-15); one quiet retry saves the user a second click.
export async function remoteOn(root){let s=await start(root); if(!s.on&&!tun&&!/missing/.test(s.error)){await new Promise(r=>setTimeout(r,3000)); s=await start(root);} return s;}
async function start(root){ if(st.on||tun)return st; const bin=findBin(root); if(!bin){st={on:false,url:'',error:'The tunnel tool (cloudflared) is missing from this copy of the app.'};return st;} const secret=crypto.randomBytes(24).toString('base64url');
  srv=http.createServer((req,res)=>{const end=(c,b,h={})=>{res.writeHead(c,{'cache-control':'no-store',...h});res.end(b);};
    if(req.url!==`/mcp/${secret}`)return end(404,'not found'); if(req.method!=='POST')return end(405,'',{allow:'POST'});
    let b=''; req.on('data',c=>{b+=c; if(b.length>2e5)req.destroy();}); req.on('end',async()=>{let m; try{m=JSON.parse(b);}catch{return end(400,'bad json');}
      const one=x=>handle(x,true), r=Array.isArray(m)?(await Promise.all(m.map(one))).filter(Boolean):await one(m);
      (Array.isArray(r)?r.length:r)?end(200,JSON.stringify(r),{'content-type':'application/json'}):end(202,'');});});
  await new Promise((ok,no)=>srv.listen(0,'127.0.0.1',ok).on('error',no)); const port=srv.address().port;
  tun=spawn(bin,['tunnel','--no-autoupdate','--url',`http://127.0.0.1:${port}`],{stdio:['ignore','pipe','pipe']});
  const t=tun; let log='', found='', host='';
  const ping=async url=>{try{return (await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":0,"method":"ping"}',signal:AbortSignal.timeout(8000)})).ok;}catch{return false;}}; const seen=d=>{log=log.slice(-200)+d; const m=/https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log); if(m)host=m[0]; if(host&&/Registered tunnel connection/i.test(log))found=`${host}/mcp/${secret}`;};
  t.stdout.on('data',seen); t.stderr.on('data',seen); t.on('error',e=>{if(tun===t){remoteOff();st.error='Could not start the link: '+e.message;}});
  t.on('exit',()=>{if(tun===t){remoteOff();st.error='The remote link stopped. Turn it on again to get a new address.';}});
  for(let i=0;i<120&&!found&&tun===t;i++)await new Promise(r=>setTimeout(r,250));
  // A new address takes a few seconds to exist on the internet. Looking it up too early makes the computer remember "no such address"
  // for a while, so wait first, then only say "on" once it really answers.
  if(found)await new Promise(r=>setTimeout(r,5000));
  for(let i=0;i<25&&found&&tun===t&&!st.on;i++){if(await ping(found))st={on:true,url:found,error:''}; else await new Promise(r=>setTimeout(r,2000));}
  if(!st.on&&tun===t){remoteOff();st.error='The remote link did not come up. Check the internet connection and try again.';}
  if(st.on){let miss=0; const url=st.url; // the app checks its own public address, so a dead link never shows as on
    watch=setInterval(async()=>{const ok=await ping(url);
      miss=ok?0:miss+1; if(miss>=3&&tun===t){remoteOff();st.error='The remote link stopped answering. Turn it on again to get a new address.';}},60000); watch.unref?.();}
  return st;}
