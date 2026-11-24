// Minimal client for CapCut's official connector (MCP over HTTP + OAuth with PKCE). No dependencies.
// usage: node capcut.mjs login | node capcut.mjs tools | node capcut.mjs call <tool> '<json args>'
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs'; import {execFile} from 'node:child_process';
const MCP='https://www.capcut.com/api/external_mcp', OA=MCP+'/oauth', TOK=new URL('./.capcut-token.json',import.meta.url).pathname;
const b64=b=>b.toString('base64url'); const save=o=>fs.writeFileSync(TOK,JSON.stringify(o,null,1),{mode:0o600}); const load=()=>JSON.parse(fs.readFileSync(TOK,'utf8'));
const form=async(u,o)=>{const r=await fetch(u,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(o)});const t=await r.text();if(!r.ok)throw new Error(`${u} ${r.status} ${t.slice(0,300)}`);return JSON.parse(t);};
async function login(){
  const port=38917, redirect=`http://127.0.0.1:${port}/callback`;
  const rr=await fetch(OA+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'CapCut Desk',redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:'capcut:mcp'})});
  const rt=await rr.text(); if(!rr.ok) throw new Error('register '+rr.status+' '+rt.slice(0,300)); const client=JSON.parse(rt);
  const verifier=b64(crypto.randomBytes(32)), challenge=b64(crypto.createHash('sha256').update(verifier).digest()), state=b64(crypto.randomBytes(12));
  const url=OA+'/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:redirect,scope:'capcut:mcp',state,code_challenge:challenge,code_challenge_method:'S256',resource:MCP});
  const code=await new Promise((res,rej)=>{const s=http.createServer((q,a)=>{const u=new URL(q.url,redirect);if(u.pathname!=='/callback'){a.end();return;}
      a.end('CapCut connected. You can close this tab.');s.close();u.searchParams.get('state')===state&&u.searchParams.get('code')?res(u.searchParams.get('code')):rej(new Error('callback: '+u.search));}).listen(port,'127.0.0.1',()=>{console.log('OPEN '+url);if(!process.env.NO_OPEN)execFile('open',[url]);});
    setTimeout(()=>{s.close();rej(new Error('timeout waiting for approval'));},+(process.env.WAIT||300)*1000);});
  const t=await form(OA+'/token',{grant_type:'authorization_code',code,redirect_uri:redirect,client_id:client.client_id,code_verifier:verifier,resource:MCP});
  save({client_id:client.client_id,...t,at:Date.now()}); console.log('signed in; token saved');
}
async function token(){const t=load(); if(t.expires_in&&Date.now()>t.at+(t.expires_in-120)*1000&&t.refresh_token){const n=await form(OA+'/token',{grant_type:'refresh_token',refresh_token:t.refresh_token,client_id:t.client_id});save({...t,...n,at:Date.now()});return n.access_token;} return t.access_token;}

// Two-step sign-in for when the approval happens in a browser on another computer:
// `start` prints the link; the approving browser lands on a dead 127.0.0.1 page whose address holds the code; `finish <that address>` completes it here.
const PEND=new URL('./.capcut-pending.json',import.meta.url).pathname;
async function start(){const redirect='http://127.0.0.1:38917/callback';
  const rr=await fetch(OA+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'CapCut Desk',redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:'capcut:mcp'})});
  if(!rr.ok)throw new Error('register '+rr.status); const client=await rr.json();
  const verifier=b64(crypto.randomBytes(32)), challenge=b64(crypto.createHash('sha256').update(verifier).digest()), state=b64(crypto.randomBytes(12));
  fs.writeFileSync(PEND,JSON.stringify({client_id:client.client_id,verifier,state,redirect}),{mode:0o600});
  console.log(OA+'/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:redirect,scope:'capcut:mcp',state,code_challenge:challenge,code_challenge_method:'S256',resource:MCP}));}
async function finish(cb){const p=JSON.parse(fs.readFileSync(PEND,'utf8')), u=new URL(cb.trim());
  if(u.searchParams.get('state')!==p.state)throw new Error('this address belongs to a different sign-in attempt'); const code=u.searchParams.get('code'); if(!code)throw new Error('no code in address: '+u.search.slice(0,120));
  const t=await form(OA+'/token',{grant_type:'authorization_code',code,redirect_uri:p.redirect,client_id:p.client_id,code_verifier:p.verifier,resource:MCP});
  save({client_id:p.client_id,...t,at:Date.now()}); fs.rmSync(PEND); console.log('signed in; token saved');}
let sid=null,n=0;
async function rpc(method,params,notify=false){const h={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+await token()}; if(sid)h['mcp-session-id']=sid;
  const r=await fetch(MCP,{method:'POST',headers:h,body:JSON.stringify(notify?{jsonrpc:'2.0',method,params}:{jsonrpc:'2.0',id:++n,method,params})}); sid=r.headers.get('mcp-session-id')||sid; const t=await r.text(); if(notify)return;
  if(!r.ok)throw new Error(method+' '+r.status+' '+t.slice(0,300)); const line=t.includes('data:')?t.split('\n').filter(l=>l.startsWith('data:')).pop().slice(5):t; const j=JSON.parse(line); if(j.error)throw new Error(JSON.stringify(j.error)); return j.result;}
export async function connect(){await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'capcut-desk',version:'0.1'}});await rpc('notifications/initialized',{},true);}
export const tools=async()=>(await rpc('tools/list',{})).tools; export const call=(name,args={})=>rpc('tools/call',{name,arguments:args});
const isMain=process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop());
const [cmd,a,b]=isMain?process.argv.slice(2):[];
if(cmd==='login')await login();
else if(cmd==='start')await start();
else if(cmd==='finish')await finish(a);
else if(cmd==='tools'){await connect();for(const t of await tools())console.log(t.name+' :: '+(t.description||'').replace(/\s+/g,' ').slice(0,110));}
else if(cmd==='call'){await connect();console.log(JSON.stringify(await call(a,b?JSON.parse(b):{}),null,1));}
