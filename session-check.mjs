// Free check: can the account connected in CapCut Desk still start a generation session? (a quote can't tell, see HANDOFF)
// Usage: node session-check.mjs    Spends nothing.
import fs from 'node:fs'; import os from 'node:os';
import {createEngine} from './app/engine.mjs';
const MCP='https://www.capcut.com/api/external_mcp'; const D=os.homedir()+'/.capcut-desk', tokFile=()=>{const a=JSON.parse(fs.readFileSync(D+'/accounts.json','utf8')); return D+'/token-'+a.active+'.json';}; // active account's token (multi-account)
let t=JSON.parse(fs.readFileSync(tokFile(),'utf8'));
await createEngine().profile().catch(()=>{}); // same code path as the app: refreshes the token if older than 12 h and saves it
t=JSON.parse(fs.readFileSync(tokFile(),'utf8'));
let sid, n=0;
const rpc=async(method,params,id=true)=>{const h={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+t.access_token}; if(sid)h['mcp-session-id']=sid;
  const r=await fetch(MCP,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',...(id?{id:++n}:{}),method,params})}); sid=r.headers.get('mcp-session-id')||sid; return r.text();};
await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'capcut-desk',version:'0.1'}}); await rpc('notifications/initialized',{},false);
const out=await rpc('tools/call',{name:'start_stdraft_session',arguments:{platform:'desktop'}});
const ok=/session_id|draft_session_id/.test(out)&&!/login error/i.test(out);
console.log(new Date().toISOString().slice(0,16), ok?'SESSION OK':'SESSION FAILED: '+out.replace(/\s+/g,' ').slice(0,200));
console.log('sign-in age h:',((Date.now()-t.at)/36e5).toFixed(1));
