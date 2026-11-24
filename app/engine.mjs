// Real engine for CapCut's official connector (MCP over HTTP + OAuth/PKCE). Logic moved from ../capcut.mjs. No dependencies.
// Interface (the fake implements the same): status() beginLogin() finishLogin(addr) logout() profile() quote(spec)
//   upload(filePath)->reference_asset  generate(spec, confirm?) poll(taskId) cancel(taskId) download(res, dest)
//   accounts() active() switchAccount(idOrNickname) removeAccount(id); beginLogin(reconnectId?) finishLogin adds an account, or renews reconnectId's token
import crypto from 'node:crypto'; import {spawn} from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import {createAccounts} from './accounts.mjs';
const MCP='https://www.capcut.com/api/external_mcp', OA=MCP+'/oauth', PORT=38917, REDIRECT=`http://127.0.0.1:${PORT}/callback`;
const b64=b=>b.toString('base64url');
const EXPIRED='Your CapCut sign-in expired. Open Account and press Reconnect. Nothing was charged.';
export const NO_CREDITS='This account is out of credits. Add new account: your history stays.';
const sc=r=>r.structuredContent??(()=>{try{return JSON.parse(r.content?.[0]?.text)}catch{return {text:r.content?.[0]?.text}}})();
const form=async(u,o)=>{const r=await fetch(u,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(o)});const t=await r.text();if(!r.ok)throw new Error(`${new URL(u).pathname} ${r.status}`);return JSON.parse(t);};

const KINDS={image:'png jpg jpeg webp bmp gif heic',video:'mp4 mov m4v webm avi',audio:'mp3 wav m4a aac ogg flac'};
export const kindOf=f=>{const e=path.extname(f).slice(1).toLowerCase(); return Object.keys(KINDS).find(k=>KINDS[k].split(' ').includes(e));};
export const BAD_KIND='This file type is not supported. Use images (PNG, JPG, WEBP), videos (MP4, MOV, WEBM) or audio (MP3, WAV, M4A).';
// uploader = path to CapCut's own capcut-upload.mjs, run as a child process (process.execPath: node, or this same bun executable via BUN_BE_BUN)
export function createEngine(dir=path.join(os.homedir(),'.capcut-desk'),uploader,{seal,unseal}={}){ // seal/unseal: hosted mode encrypts token and pending files at rest (see hosted.mjs)
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const A=createAccounts(dir), PEND=path.join(dir,'pending.json');
  const save=(f,o)=>fs.writeFileSync(f,seal?seal(JSON.stringify(o)):JSON.stringify(o,null,1),{mode:0o600}); const load=f=>{const t=fs.readFileSync(f,'utf8'); return JSON.parse(unseal?unseal(t):t);};
  const TOK=id=>A.file(id), has=()=>{const a=A.active(); return !!a&&fs.existsSync(TOK(a.id));};
  let mcpSid=null, n=0, draft=null;
  // Silent refresh: the server kills an access token at ~70 h although expires_in says 72 h, and the refresh token rotates on every use.
  // So refresh when the token is older than 12 h, and once more if CapCut answers "invalid token". Re-read the file first: another copy of the app may have refreshed already.
  // Per account: the id is captured by the caller, so a refresh only ever reads and writes that account's token file.
  async function refresh(id,seen){const t=load(TOK(id)); if(t.at!==seen&&t.at>Date.now()-6e4)return t.access_token; // ponytail: no file lock, a simultaneous refresh from 2 copies can still lose; add a lock if it shows up
    const dead=()=>{A.update(id,{status:'expired'}); return new Error(EXPIRED);};
    if(!t.refresh_token)throw dead(); let x; try{x=await form(OA+'/token',{grant_type:'refresh_token',refresh_token:t.refresh_token,client_id:t.client_id});}catch{throw dead();} save(TOK(id),{...t,...x,at:Date.now()}); return x.access_token;}
  async function token(){if(!has())throw new Error('No CapCut account is connected. Open Account and press Add account.'); const id=A.active().id, t=load(TOK(id)); return t.refresh_token&&Date.now()>t.at+12*36e5?refresh(id,t.at):t.access_token;}
  async function rpc(method,params,notify=false){
    const h={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+await token()}; if(mcpSid)h['mcp-session-id']=mcpSid;
    const r=await fetch(MCP,{method:'POST',headers:h,body:JSON.stringify(notify?{jsonrpc:'2.0',method,params}:{jsonrpc:'2.0',id:++n,method,params})});
    mcpSid=r.headers.get('mcp-session-id')||mcpSid; const t=await r.text(); if(notify)return;
    if(!r.ok)throw new Error(method+' '+r.status+' '+t.slice(0,200));
    const line=t.includes('data:')?t.split('\n').filter(l=>l.startsWith('data:')).pop().slice(5):t; const j=JSON.parse(line); if(j.error)throw new Error(JSON.stringify(j.error)); return j.result;}
  async function call(name,args={},again=true){
    if(!mcpSid){await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'capcut-desk',version:'0.1'}});await rpc('notifications/initialized',{},true);}
    const r=sc(await rpc('tools/call',{name,arguments:args}));
    if(again&&/invalid token/i.test(JSON.stringify(r))){const id=A.active().id; await refresh(id,load(TOK(id)).at-1); mcpSid=null; draft=null; return call(name,args,false);} // refresh() sees "newer" file only if another copy did it
    return r;}
  async function session(){ if(draft)return draft; const s=await call('start_stdraft_session',{platform:'desktop'}); draft=s.session_id||s.draft_session_id||s.id; if(!draft&&/login/i.test(JSON.stringify(s)))throw new Error('CapCut asks this account to sign in again. Open Account and press Reconnect. Nothing was charged.'); if(!draft)throw new Error('no draft session: '+JSON.stringify(s).slice(0,150)); return draft;}
  const specOf=s=>({prompt:s.prompt,model:s.model,ratio:s.ratio,resolution:s.resolution,duration_ms:s.duration_ms,count:s.count,...(s.reference_assets?.length?{reference_assets:s.reference_assets.map(({file_name,...a})=>a)}:{})}); // file_name is card-only: not allowed in generation specs
  const reset=()=>{mcpSid=null; draft=null;}; // MCP session and draft belong to one account
  return {
    status:()=>({connected:has()}), accounts:A.list, active:()=>A.active(),
    switchAccount(key){const a=A.find(key); if(!a)throw new Error('No account called '+key); A.setActive(a.id); reset(); return a;},
    removeAccount(id){A.remove(String(id)); reset();}, // token only: jobs and clips stay
    async beginLogin(reconnect){ // returns the approval link; approval may happen on another device
      const rr=await fetch(OA+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'CapCut Desk',redirect_uris:[REDIRECT],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:'capcut:mcp'})});
      if(!rr.ok)throw new Error('register '+rr.status); const client=await rr.json();
      const verifier=b64(crypto.randomBytes(32)), challenge=b64(crypto.createHash('sha256').update(verifier).digest()), state=b64(crypto.randomBytes(12));
      save(PEND,{client_id:client.client_id,verifier,state,...(reconnect?{reconnect:String(reconnect)}:{})});
      return OA+'/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:REDIRECT,scope:'capcut:mcp',state,code_challenge:challenge,code_challenge_method:'S256',resource:MCP});},
    async finishLogin(addr){ // addr = the 127.0.0.1 callback address (full URL, or just ?code=..&state=..)
      const p=load(PEND), u=new URL(String(addr).trim(),REDIRECT);
      if(u.searchParams.get('state')!==p.state)throw new Error('this address belongs to a different sign-in attempt');
      const code=u.searchParams.get('code'); if(!code)throw new Error('no code in that address');
      const t=await form(OA+'/token',{grant_type:'authorization_code',code,redirect_uri:REDIRECT,client_id:p.client_id,code_verifier:p.verifier,resource:MCP});
      const tgt=p.reconnect&&A.find(p.reconnect), fresh={client_id:p.client_id,...t,at:Date.now()};
      if(!tgt){const id=A.add(); save(TOK(id),fresh); A.update(id,{status:'connected'}); A.setActive(id); fs.rmSync(PEND,{force:true}); reset(); return;}
      const prevTok=load(TOK(tgt.id)), prevNick=tgt.nickname; save(TOK(tgt.id),fresh); A.update(tgt.id,{status:'connected'}); A.setActive(tgt.id); fs.rmSync(PEND,{force:true}); reset();
      // Reconnect renews THIS account, unless the person who signed in is someone else (a seller reconnecting with a new buyer's account): then keep the old one untouched and add a new account.
      let nm=null; try{const r=await call('capcut_get_profile',{}); nm=r.nickname||r.name||null;}catch{} // ponytail: a failed profile call counts as "same account"; the name check needs a real nickname on both sides
      if(nm&&prevNick&&!/^Account \d+$/.test(prevNick)&&nm!==prevNick){const id=A.add(nm); save(TOK(id),fresh); save(TOK(tgt.id),prevTok); A.update(tgt.id,{nickname:prevNick}); A.setActive(id); reset();}},
    async profile(){const p=await call('capcut_get_profile',{}), nickname=p.nickname||p.name||null; if(nickname)A.update(A.active().id,{nickname}); return {nickname};},
    async quote(s){ // read-only: costs nothing
      const r=await call('capcut_estimate_generation_credits',{media_type:'video',parameters:{...specOf(s),reference_assets:undefined},reference_assets:s.reference_assets||[]});
      if(r.estimated_credits==null)throw new Error('no quote: '+JSON.stringify(r).slice(0,200));
      return {credits:r.estimated_credits,insufficient:!!r.insufficient_credits};},
    async upload(file){ // reference file -> the reference_asset object the connector expects. Not a generation: costs no credits.
      const kind=kindOf(file); if(!kind)throw new Error(BAD_KIND); const name=path.basename(file), size=fs.statSync(file).size; if(!size)throw new Error('That file is empty.');
      const c=await call('capcut_asset_upload_credential',{version:2,files:[{file_name:name,size_bytes:size}],platform:'desktop'});
      if(!c.upload_ticket)throw new Error('CapCut did not allow this upload: '+String(c.message||c.text||c.code||'no upload ticket').slice(0,150));
      const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'desk-up-')), rf=path.join(tmp,'result.json');
      try{
        const err=await new Promise((ok,no)=>{const ch=spawn(process.execPath,[uploader,'--file',file,'--client-id','f1','--upload-ticket-stdin','--json','--result-file',rf],{env:{...process.env,BUN_BE_BUN:'1'},stdio:['pipe','ignore','pipe']}); let e=''; ch.stderr.on('data',d=>e+=d); ch.on('error',no); ch.on('close',()=>ok(e)); ch.stdin.end(c.upload_ticket+'\n');}); // ticket goes via stdin only
        let r; try{const j=JSON.parse(fs.readFileSync(rf,'utf8')); r=j.results?.[0]??j;}catch{} // single --file writes the item itself, batches write {results}
        if(!r)throw new Error('The upload did not finish. '+err.replace(/\s+/g,' ').slice(-250));
        const id=kind==='image'?r.uri:r.vid;
        if(!r.success||!id||(kind!=='image'&&!r.setPublic?.success))throw new Error(`CapCut could not take this file (${r.stage||'upload'}: ${String(r.error||'unknown error').slice(0,120)})`);
        return {role:'reference',media_type:kind,...(kind==='image'?{uri:id}:{vid:id}),file_name:name};
      }finally{fs.rmSync(tmp,{recursive:true,force:true});}},
    // no confirm -> {confirm:{credits,generate_id,unique_key}} (nothing charged yet); with confirm -> {task_id}
    async generate(s,confirm){
      const a={draft_session_id:await session(),spec:specOf(s),platform:'desktop'}; if(confirm)Object.assign(a,{generate_id:confirm.generate_id,unique_key:confirm.unique_key,confirmed:true});
      const r=await call('capcut_video_generate',a);
      if(r.code==='CONFIRMATION_REQUIRED')return {confirm:{credits:r.confirmation_card?.input?.credits_amount,generate_id:r.generate_id,unique_key:r.unique_key}};
      if(r.task_id)return {task_id:r.task_id};
      if(/insufficient|not enough|no credits/i.test(JSON.stringify(r)))throw new Error(NO_CREDITS);
      throw new Error(r.message||r.text||r.code||'generate failed');},
    async poll(taskId){
      const p=await call('capcut_generation_poll',{task_id:taskId,platform:'desktop'}); const st=String(p.status||'');
      const status=/succe/i.test(st)?'succeeded':/fail|error/i.test(st)?'failed':/cancel/i.test(st)?'cancelled':'running';
      return {status,credits:p.actual_credits,urls:(p.resources||[]).map(x=>x.url).filter(Boolean),waitMs:p.next_poll_after_ms||0,error:status==='failed'?(p.error?.message||p.error||p.message||'generation failed'):undefined};},
    cancel:id=>call('capcut_generation_cancel',{task_id:id,platform:'desktop'}),
    async download(url,dest){const r=await fetch(url); if(!r.ok)throw new Error('download '+r.status); fs.writeFileSync(dest,Buffer.from(await r.arrayBuffer()));},
  };
}
