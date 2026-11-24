// No network, no real home folder: every test uses its own temp dir and a stubbed fetch.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {createEngine,NO_CREDITS} from './engine.mjs'; import {createFake} from './fake-engine.mjs'; import {createQueue} from './queue.mjs';
const spec={prompt:'a beach',model:'seedance2_mini',ratio:'9:16',resolution:'720p',duration_ms:5000,count:1};
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'desk-acct-')), rd=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const old=Date.now()-20*36e5; // older than the 12 h refresh threshold
const tokenFile=(d,id,o)=>fs.writeFileSync(path.join(d,`token-${id}.json`),JSON.stringify({client_id:'c'+id,access_token:'AT'+id,refresh_token:'RT'+id,at:old,...o}));
const realFetch=globalThis.fetch;
// fake CapCut: records bearer tokens; refresh_token RT<n> -> AT<n>x/RT<n>x unless listed in dead; tool answers come from tools[name]
function stubFetch({dead=[],tools={}}={}){const seen=[]; globalThis.fetch=async(url,o={})=>{url=String(url);
  if(url.endsWith('/oauth/register'))return Response.json({client_id:'cnew'});
  if(url.endsWith('/oauth/token')){const b=new URLSearchParams(o.body), g=b.get('grant_type'); if(g==='authorization_code')return Response.json({access_token:'ATnew',refresh_token:'RTnew'});
    const rt=b.get('refresh_token'); return dead.includes(rt)?new Response('no',{status:400}):Response.json({access_token:rt.replace('RT','AT')+'x',refresh_token:rt+'x'});}
  const m=JSON.parse(o.body); seen.push([m.method,o.headers.authorization]); if(m.id===undefined)return new Response('');
  const r=m.method==='tools/call'?{structuredContent:tools[m.params.name]||{}}:{}; return Response.json({jsonrpc:'2.0',id:m.id,result:r},{headers:{'mcp-session-id':'s'}});}; return seen;}
test.afterEach(()=>{globalThis.fetch=realFetch;});

test('migration: an old single token.json becomes account 1, old jobs are kept and tagged',()=>{
  const d=tmp(), oldTok={client_id:'c',access_token:'AT',refresh_token:'RT',at:1}; fs.writeFileSync(path.join(d,'token.json'),JSON.stringify(oldTok));
  const jobs=[{id:'j1',name:'a',spec,ceiling:5,status:'done',files:['/x/a 1.mp4'],credits:5},{id:'j2',name:'b',spec,ceiling:5,status:'failed',error:'boom'}]; fs.writeFileSync(path.join(d,'jobs.json'),JSON.stringify(jobs));
  const e=createEngine(d);
  assert.deepEqual(rd(path.join(d,'token-1.json')),oldTok); assert.ok(fs.existsSync(path.join(d,'token.json.bak-migrated'))); assert.ok(!fs.existsSync(path.join(d,'token.json')));
  assert.equal(fs.statSync(path.join(d,'token-1.json')).mode&0o777,0o600); assert.equal(e.accounts().active,'1'); assert.equal(e.accounts().accounts.length,1); assert.equal(e.status().connected,true);
  const q=createQueue({engine:e,file:path.join(d,'jobs.json'),outDir:path.join(d,'out')});
  assert.deepEqual(q.jobs().map(j=>[j.id,j.status,j.files,j.error,j.accountId]),[['j1','done',['/x/a 1.mp4'],undefined,'1'],['j2','failed',undefined,'boom','1']]);
  createEngine(d); assert.equal(rd(path.join(d,'accounts.json')).accounts.length,1); // second start migrates nothing again
});
test('add, reconnect, switch and remove; each account keeps its own token file; removing keeps jobs',async()=>{
  const d=tmp(); tokenFile(d,'1',{}); fs.renameSync(path.join(d,'token-1.json'),path.join(d,'token.json')); const e=createEngine(d); stubFetch();
  const login=async re=>{const u=new URL(await e.beginLogin(re)); await e.finishLogin('?code=x&state='+u.searchParams.get('state'));};
  await login(); let s=e.accounts(); assert.equal(s.accounts.length,2); assert.equal(s.active,'2'); assert.equal(rd(path.join(d,'token-2.json')).access_token,'ATnew'); assert.equal(rd(path.join(d,'token-1.json')).access_token,'AT1');
  const q=createQueue({engine:e,file:path.join(d,'jobs.json'),outDir:path.join(d,'out'),sleep:async()=>{},minPoll:0}); const j1=q.jobs().length;
  e.switchAccount('account 1'); assert.equal(e.accounts().active,'1'); assert.throws(()=>e.switchAccount('nobody'),/No account/);
  await login('1'); assert.equal(e.accounts().accounts.length,2); assert.equal(rd(path.join(d,'token-1.json')).access_token,'ATnew'); // reconnect renews THAT account, adds none
  e.removeAccount('2'); assert.equal(e.accounts().accounts.length,1); assert.ok(!fs.existsSync(path.join(d,'token-2.json'))); assert.equal(q.jobs().length,j1);
  e.removeAccount('1'); assert.equal(e.status().connected,false); assert.equal(e.accounts().active,null);
});
test('refresh is per account: rotated tokens land only in the active account file, a dead one is marked expired alone',async()=>{
  const d=tmp(); tokenFile(d,'1'); tokenFile(d,'2'); fs.writeFileSync(path.join(d,'accounts.json'),JSON.stringify({active:'2',accounts:[1,2].map(i=>({id:String(i),nickname:'N'+i,addedAt:'x',status:'connected'}))}));
  const e=createEngine(d), t1=fs.readFileSync(path.join(d,'token-1.json'),'utf8'), seen=stubFetch({dead:['RT1'],tools:{capcut_estimate_generation_credits:{estimated_credits:5}}}),
    bearers=()=>seen.filter(x=>x[0]==='tools/call'||x[0]==='initialize').map(x=>x[1]);
  await e.quote(spec); assert.equal(bearers()[0],'Bearer AT2x'); assert.equal(rd(path.join(d,'token-2.json')).refresh_token,'RT2x'); assert.equal(fs.readFileSync(path.join(d,'token-1.json'),'utf8'),t1);
  e.switchAccount('N1'); await assert.rejects(e.quote(spec),/sign-in expired/);
  assert.deepEqual(e.accounts().accounts.map(a=>a.status),['expired','connected']); assert.equal(rd(path.join(d,'token-2.json')).refresh_token,'RT2x');
});
test('job tagging: new jobs carry the active account, history keeps the old tag after a switch',async()=>{
  const d=tmp(), e=createFake(), q=createQueue({engine:e,file:path.join(d,'jobs.json'),outDir:path.join(d,'out'),sleep:async()=>{},minPoll:0});
  q.add({name:'a',spec,ceiling:99}); await q.idle(); await e.finishLogin(); q.add({name:'b',spec,ceiling:99}); await q.idle();
  assert.deepEqual(q.jobs().map(j=>[j.accountId,j.nickname,j.status]),[['1','demo-user','done'],['2','demo-user 2','done']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d,'jobs.json'),'utf8')).map(j=>j.accountId),['1','2']);
});
test('insufficient credits: quote flags it, generate fails with the add-account message (fake and real engine)',async()=>{
  const e=createFake(), p={...spec,prompt:'NOCREDITS'}; assert.equal((await e.quote(p)).insufficient,true);
  const d=tmp(), q=createQueue({engine:e,file:path.join(d,'jobs.json'),outDir:path.join(d,'out'),sleep:async()=>{},minPoll:0}); q.add({spec:p,ceiling:99}); await q.idle();
  assert.equal(q.jobs()[0].status,'failed'); assert.equal(q.jobs()[0].error,'This account is out of credits. Add new account: your history stays.'); assert.equal(NO_CREDITS,q.jobs()[0].error);
  const d2=tmp(); tokenFile(d2,'1',{at:Date.now()}); fs.renameSync(path.join(d2,'token-1.json'),path.join(d2,'token.json'));
  stubFetch({tools:{start_stdraft_session:{session_id:'s1'},capcut_video_generate:{code:'INSUFFICIENT_CREDITS'}}});
  await assert.rejects(createEngine(d2).generate(spec),e=>e.message===NO_CREDITS);
});

test('reconnect by a DIFFERENT CapCut user keeps the old account untouched and adds a new one; same user renews in place',async()=>{
  const d=tmp(); tokenFile(d,'1'); fs.writeFileSync(path.join(d,'accounts.json'),JSON.stringify({active:'1',accounts:[{id:'1',nickname:'Tax',addedAt:'x',status:'expired'}]}));
  const e=createEngine(d), t1=fs.readFileSync(path.join(d,'token-1.json'),'utf8'); stubFetch({tools:{capcut_get_profile:{nickname:'Raf'}}});
  const login=async re=>{const u=new URL(await e.beginLogin(re)); await e.finishLogin('?code=x&state='+u.searchParams.get('state'));};
  await login('1'); const s=e.accounts(); assert.equal(s.accounts.length,2); assert.equal(s.active,'2'); assert.deepEqual(s.accounts.map(a=>a.nickname),['Tax','Raf']);
  assert.deepEqual(rd(path.join(d,'token-1.json')),JSON.parse(t1)); assert.equal(rd(path.join(d,'token-2.json')).access_token,'ATnew');
  stubFetch({tools:{capcut_get_profile:{nickname:'Raf'}}}); await login('2'); assert.equal(e.accounts().accounts.length,2); // same user: renewed in place
});
