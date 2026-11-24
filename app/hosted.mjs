// Hosted mode (CAPCUT_DESK_HOSTED=1): the desktop UI served to many visitors, each isolated in DIR/v/<hash of cookie>/. Local prototype: see ../HOSTED.md.
// Env: CAPCUT_DESK_KEY (64 hex chars, AES-256-GCM key for tokens), DESK_DIR (required: never the real ~/.capcut-desk), PORT (default 8787), CAPCUT_DESK_HOSTS (allowed Host headers, default 127.0.0.1:PORT,localhost:PORT), DRY=1 (fake engine).
import {fileURLToPath} from 'node:url'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import {createEngine} from './engine.mjs'; import {createFake} from './fake-engine.mjs'; import {createQueue,MODELS,RATIOS,checkSpec} from './queue.mjs';
export const parseKey=k=>{if(!/^[0-9a-f]{64}$/i.test(k||''))throw new Error('CAPCUT_DESK_KEY is missing or wrong: it must be 64 hex characters (make one with: openssl rand -hex 32)'); return Buffer.from(k,'hex');};
export const sealer=key=>({ // text -> "v1:" + base64(iv 12 | tag 16 | ciphertext); a wrong key or a changed byte throws
  seal(t){const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',key,iv), ct=Buffer.concat([c.update(t,'utf8'),c.final()]); return 'v1:'+Buffer.concat([iv,c.getAuthTag(),ct]).toString('base64');},
  unseal(t){if(!t.startsWith('v1:'))throw new Error('token file is not encrypted'); const b=Buffer.from(t.slice(3),'base64'), d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12)); d.setAuthTag(b.subarray(12,28)); return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}});
export const LIMITS={maxBody:20000,visitorJobs:10,globalJobs:100,maxVisitors:1000,loginPerHour:10,loginGlobalPerHour:100,reqPerMin:240};
const ACTIVE=['queued','running','needs_approval'], DONE=['done','failed','cancelled'], SID=/^[0-9a-f]{64}$/;
const fail=(m,code=400)=>Object.assign(new Error(m),{code});

export function createHosted({root,key,makeEngine,html,hostOk,limits={},now=Date.now}){
  const L={...LIMITS,...limits}, K=parseKey(key), sl=sealer(K), V=path.join(root,'v'), sessions=new Map(), hits=new Map();
  fs.mkdirSync(V,{recursive:true,mode:0o700});
  const hit=(k,max,ms)=>{const t=now(), a=(hits.get(k)||[]).filter(x=>x>t-ms); if(a.length>=max){hits.set(k,a);return false;} a.push(t); hits.set(k,a); return true;}; // ponytail: in-memory, per process, never pruned for idle keys; use a proxy/redis limiter if public
  const dirOf=sid=>path.join(V,crypto.createHash('sha256').update(sid).digest('hex').slice(0,32));
  const csrfOf=sid=>crypto.createHmac('sha256',K).update('csrf'+sid).digest('hex');
  function open(sid){let s=sessions.get(sid); if(s)return s; const dir=dirOf(sid); if(!fs.existsSync(dir))return null;
    const engine=makeEngine(dir,sl), out=path.join(dir,'out'); s={sid,dir,out,engine,q:createQueue({engine,file:path.join(dir,'jobs.json'),outDir:out}),csrf:csrfOf(sid)}; sessions.set(sid,s); s.q.start(); return s;}
  function create(){if(fs.readdirSync(V).length>=L.maxVisitors)throw fail('The site is full right now. Try again later.',503); const sid=crypto.randomBytes(32).toString('hex'); fs.mkdirSync(dirOf(sid),{mode:0o700}); return open(sid);}
  const active=s=>s.q.jobs().filter(j=>ACTIVE.includes(j.status)).length;
  async function wipe(s){for(const j of s.q.jobs())if(!DONE.includes(j.status))await s.q.cancel(j.id).catch(()=>{}); sessions.delete(s.sid); const rm=()=>fs.rmSync(s.dir,{recursive:true,force:true}); rm(); s.q.idle().then(rm);} // second rm: a worker that was mid-write may have recreated the folder
  const json=(res,code,o,h={})=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...h});res.end(JSON.stringify(o));};
  const cookie=(sid,req,age=2592000)=>`desk_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${req.headers['x-forwarded-proto']==='https'?'; Secure':''}`;
  const body=req=>new Promise((ok,no)=>{let b='',n=0; req.on('data',c=>{if((n+=c.length)>L.maxBody){no(fail('Request too big.',413));b='';n=-1e12;}else if(n>0)b+=c;}); /* ponytail: oversize bodies are drained, not cut off; a proxy should cap the size too */ req.on('end',()=>{try{ok(b?JSON.parse(b):{});}catch{no(fail('Bad request.'));}}); req.on('error',no);});
  async function account(s){const e=s.engine; if(!e.status().connected)return {connected:false}; const a=e.active(); try{return {connected:true,id:a.id,...await e.profile()};}catch(x){return {connected:true,id:a.id,nickname:a.nickname,error:String(x.message).slice(0,120)};}}
  function serve(req,res,f){const st=fs.statSync(f), r=(req.headers.range||'').match(/bytes=(\d*)-(\d*)/); let a=0,b=st.size-1,code=200; const h={'content-type':'video/mp4','accept-ranges':'bytes','x-content-type-options':'nosniff'};
    if(r&&(r[1]||r[2])){code=206; if(r[1]){a=+r[1];if(r[2])b=Math.min(+r[2],b);}else a=Math.max(0,st.size-+r[2]); h['content-range']=`bytes ${a}-${b}/${st.size}`;} h['content-length']=Math.max(0,b-a+1); res.writeHead(code,h); fs.createReadStream(f,{start:a,end:b}).pipe(res);}
  const mine=(s,id)=>{const j=s.q.jobs().find(x=>x.id===id); if(!j)throw fail('No such job.',404); return j;}; // only this visitor's queue is ever searched
  const login=s=>{if(!hit('login:'+s.sid,L.loginPerHour,36e5)||!hit('login:*',L.loginGlobalPerHour,36e5))throw fail('Too many sign-in attempts. Wait a while and try again.',429);};
  const friendly=e=>/different sign-in attempt/.test(e.message)?'That address is from an older sign-in attempt. Press Connect again and use the newest link, then paste the address that fails to load.':e.code==='ENOENT'?'Press Connect first, then paste the address.':e.message;

  async function handler(req,res){
    try{
      if(!hostOk(req.headers.host))return json(res,403,{error:'bad host'});
      const u=new URL(req.url,'http://x'), p=u.pathname, sid=(/(?:^|; )desk_sid=([0-9a-f]+)/.exec(req.headers.cookie||'')||[])[1];
      let s=sid&&SID.test(sid)?open(sid):null;
      if(req.method==='GET'&&p==='/'){const fresh=!s; s=s||create(); res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',...(fresh?{'set-cookie':cookie(s.sid,req)}:{})}); return res.end(html.replace('__TOKEN__',s.csrf));}
      if(!s)return json(res,401,{error:'No session. Reload the page.'});
      if(!hit('req:'+s.sid,L.reqPerMin,6e4))return json(res,429,{error:'Slow down a little.'});
      if(req.method==='GET'){
        if(p==='/api/ping')return json(res,200,{ok:true});
        if(p==='/api/state')return json(res,200,{hosted:true,dry:false,models:MODELS,ratios:RATIOS,account:await account(s),accounts:s.engine.accounts(),jobs:s.q.jobs().map(({generate_id,unique_key,files,...j})=>({...j,...(files?{files:files.map(f=>path.basename(f))}:{})})),creditsUsed:s.q.creditsUsed(),out:''});
        const m=p.match(/^\/api\/jobs\/(\w+)\/file\/(\d+)$/);
        if(m){const f=s.q.jobs().find(j=>j.id===m[1])?.files?.[+m[2]]; let real; try{real=fs.realpathSync(f);}catch{}
          if(!real||!real.startsWith(fs.realpathSync(s.out)+path.sep))return json(res,404,{error:'no file'}); return serve(req,res,real);}
        return json(res,404,{error:'not found'});}
      const origin=req.headers.origin; if(req.method!=='POST'||req.headers['x-desk-token']!==s.csrf||(origin&&new URL(origin).host!==req.headers.host))return json(res,403,{error:'forbidden'});
      const b=await body(req);
      if(p==='/api/quote'){checkSpec(b.spec);return json(res,200,await s.engine.quote(b.spec));}
      if(p==='/api/jobs'){
        const prompts=(b.prompts||[]).map(x=>String(x).trim()).filter(Boolean); if(!prompts.length)throw fail('no prompts');
        if(active(s)+prompts.length>L.visitorJobs)throw fail(`You can have at most ${L.visitorJobs} videos waiting or running. Wait for some to finish.`,429);
        if([...sessions.values()].reduce((n,x)=>n+active(x),0)+prompts.length>L.globalJobs)throw fail('The site is busy. Try again in a few minutes.',503);
        for(const pr of prompts)checkSpec({...b.spec,prompt:pr});
        let ceiling=+b.ceiling; if(!(ceiling>=0&&b.ceiling!=null))ceiling=(await s.engine.quote({...b.spec,prompt:prompts[0]})).credits;
        return json(res,200,prompts.map((pr,i)=>s.q.add({name:prompts.length>1?`${b.name||'Batch'} ${i+1}`:b.name,spec:{...b.spec,prompt:pr},ceiling})));} // one queue per visitor = one generation at a time per visitor
      let m=p.match(/^\/api\/jobs\/(\w+)\/(cancel|approve|retry)$/);
      if(m){mine(s,m[1]); return json(res,200,m[2]==='cancel'?await s.q.cancel(m[1]):m[2]==='retry'?s.q.retry(m[1]):s.q.approve(m[1],b.ceiling));}
      if(p==='/api/connect/start'){login(s); return json(res,200,{url:await s.engine.beginLogin(b.reconnect)});}
      if(p==='/api/connect/finish'){login(s); let a=String(b.address||'').trim().slice(0,4000); if(/^(code|state)=/.test(a))a='?'+a;
        try{await s.engine.finishLogin(a);}catch(e){throw fail(friendly(e));} return json(res,200,{ok:true});}
      if(p==='/api/accounts/switch'){s.engine.switchAccount(b.account);return json(res,200,{ok:true});}
      if(p==='/api/accounts/remove'){s.engine.removeAccount(b.account);return json(res,200,{ok:true});}
      if(p==='/api/hosted/signout')return json(res,200,{ok:true},{'set-cookie':cookie('',req,0)});
      if(p==='/api/hosted/delete'){await wipe(s); return json(res,200,{ok:true},{'set-cookie':cookie('',req,0)});}
      json(res,404,{error:'not found'});
    }catch(e){json(res,e.code>=400&&e.code<600?e.code:400,{error:String(e.message||e).slice(0,300)});}
  }
  return {handler,sessions};
}

export async function startHosted(env=process.env){
  const PORT=+env.PORT||8787, DIR=env.DESK_DIR; if(!DIR)throw new Error('Hosted mode needs DESK_DIR (a folder for visitor data, not your real ~/.capcut-desk).'); if(PORT===38917)throw new Error('Port 38917 belongs to the desktop app.');
  const ROOT=path.dirname(fileURLToPath(import.meta.url)), hosts=(env.CAPCUT_DESK_HOSTS||`127.0.0.1:${PORT},localhost:${PORT}`).split(',');
  const makeEngine=env.DRY?()=>createFake():(dir,{seal,unseal})=>createEngine(dir,undefined,{seal,unseal});
  const {handler}=createHosted({root:DIR,key:env.CAPCUT_DESK_KEY,makeEngine,html:fs.readFileSync(path.join(ROOT,'index.html'),'utf8'),hostOk:h=>hosts.includes(h)});
  http.createServer(handler).listen(PORT,'127.0.0.1',()=>console.log(`CapCut Desk HOSTED prototype on http://127.0.0.1:${PORT}`));
}
