// Hosted mode. No network, no real home folder, no CapCut: temp dirs, a stubbed fetch, a local server on an ephemeral port (never 38917).
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import crypto from 'node:crypto';
import {createEngine} from './engine.mjs'; import {createHosted,parseKey,sealer,startHosted} from './hosted.mjs';
const KEY=crypto.randomBytes(32).toString('hex'), realFetch=globalThis.fetch, tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'desk-host-'));
const bearers=[]; let n=0;
// fake CapCut: authorization code X -> access token AT_X; tools answer by name; downloads return text
globalThis.fetch=async(url,o={})=>{url=String(url); if(/^http:\/\/127\.0\.0\.1:/.test(url))return realFetch(url,o);
  if(url.endsWith('/oauth/register'))return Response.json({client_id:'c'});
  if(url.endsWith('/oauth/token')){const b=new URLSearchParams(o.body); return Response.json({access_token:'AT_'+b.get('code'),refresh_token:'RT_'+b.get('code')});}
  if(url.startsWith('https://cdn.test/'))return new Response('VIDEO '+url);
  const m=JSON.parse(o.body); if(m.id===undefined)return new Response(''); bearers.push(o.headers.authorization); const a=m.params?.arguments||{}, nm=m.params?.name; let r={};
  if(m.method==='tools/call')r={structuredContent:nm==='capcut_get_profile'?{nickname:'nick-'+o.headers.authorization.slice(10)}:nm==='capcut_estimate_generation_credits'?{estimated_credits:3}:nm==='start_stdraft_session'?{session_id:'d'}
    :nm==='capcut_video_generate'?(a.confirmed?{task_id:'T'+(++n)}:{code:'CONFIRMATION_REQUIRED',generate_id:'g'+(++n),unique_key:'k'+n,confirmation_card:{input:{credits_amount:3}}})
    :nm==='capcut_generation_poll'?{status:'succeeded',actual_credits:3,resources:[{url:'https://cdn.test/'+a.task_id+'.mp4'}]}:{}};
  return Response.json({jsonrpc:'2.0',id:m.id,result:r},{headers:{'mcp-session-id':'s'}});};
const spec={model:'seedance2_mini',ratio:'9:16',resolution:'720p',duration_ms:5000,count:1};
async function boot(limits={},key=KEY){const root=tmp(), html='<html>__TOKEN__</html>', h=createHosted({root,key,html,hostOk:()=>true,limits,makeEngine:(d,s)=>createEngine(d,undefined,s)});
  const srv=http.createServer(h.handler); await new Promise(r=>srv.listen(0,'127.0.0.1',r)); const base='http://127.0.0.1:'+srv.address().port; test.after(()=>srv.close());
  const visitor=async()=>{const r=await fetch(base+'/'); const ck=r.headers.get('set-cookie').split(';')[0], csrf=(await r.text()).match(/<html>(\w+)<\/html>/)[1];
    const v={ck,csrf,raw:(p,b,hd={})=>fetch(base+p,b===undefined?{headers:{cookie:ck,...hd}}:{method:'POST',headers:{cookie:ck,'x-desk-token':csrf,...hd},body:typeof b==='string'?b:JSON.stringify(b)}),
      async get(p){const r=await v.raw(p); return [r.status,await r.json()];}, async post(p,b){const r=await v.raw(p,b); return [r.status,await r.json()];},
      async connect(code,addr){const [,{url}]=await v.post('/api/connect/start',{}); const st=new URL(url).searchParams.get('state'); return v.post('/api/connect/finish',{address:addr?addr(st):`?code=${code}&state=${st}`});},
      async done(id){for(let i=0;i<100;i++){const [,s]=await v.get('/api/state'); const j=s.jobs.find(x=>x.id===id); if(j.status==='done')return j; await new Promise(r=>setTimeout(r,50));} throw new Error('job never finished');}}; return v;};
  return {root,base,h,visitor,srv};}
const allFiles=d=>fs.readdirSync(d,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>path.join(e.parentPath,e.name));

test('encryption: round trip, wrong key, tampering, plaintext, bad key refuses to start',async()=>{
  const a=sealer(parseKey(KEY)), b=sealer(parseKey(crypto.randomBytes(32).toString('hex'))), t=a.seal('{"access_token":"secret"}');
  assert.equal(a.unseal(t),'{"access_token":"secret"}'); assert.ok(!t.includes('secret')); assert.notEqual(a.seal('x'),a.seal('x'));
  assert.throws(()=>b.unseal(t)); assert.throws(()=>a.unseal(t.slice(0,-4)+(t.endsWith('AAAA')?'BBBB':'AAAA'))); assert.throws(()=>a.unseal('{"access_token":"secret"}'));
  for(const k of [undefined,'','abc','z'.repeat(64)])assert.throws(()=>parseKey(k),/CAPCUT_DESK_KEY/);
  assert.throws(()=>createHosted({root:tmp(),key:undefined,html:'',hostOk:()=>true,makeEngine:()=>{}}),/CAPCUT_DESK_KEY/);
  await assert.rejects(startHosted({CAPCUT_DESK_KEY:KEY}),/DESK_DIR/); await assert.rejects(startHosted({DESK_DIR:tmp()}),/CAPCUT_DESK_KEY/); await assert.rejects(startHosted({DESK_DIR:tmp(),PORT:'38917',CAPCUT_DESK_KEY:KEY}),/38917/);
});

test('two visitors never see each other: jobs, files, tokens, traversal',async()=>{
  const {root,visitor,h}=await boot(), A=await visitor(), B=await visitor(); assert.notEqual(A.ck,B.ck);
  assert.equal((await A.connect('codeA'))[0],200); assert.equal((await B.connect('codeB'))[0],200);
  const [,[ja]]=await A.post('/api/jobs',{prompts:['a beach'],spec,ceiling:10}); const doneA=await A.done(ja.id);
  const [,[jb]]=await B.post('/api/jobs',{prompts:['a forest'],spec,ceiling:10}); await B.done(jb.id);
  const [,sa]=await A.get('/api/state'), [,sb]=await B.get('/api/state');
  assert.deepEqual(sa.jobs.map(j=>j.id),[ja.id]); assert.deepEqual(sb.jobs.map(j=>j.id),[jb.id]); assert.equal(sa.account.nickname,'nick-codeA'); assert.equal(sb.account.nickname,'nick-codeB');
  assert.ok(!JSON.stringify(sa).includes(root)&&!JSON.stringify(sa).includes('AT_')); // no server paths or tokens in the page data
  const fa=await A.raw(`/api/jobs/${ja.id}/file/0`); assert.equal(fa.status,200); assert.match(await fa.text(),/VIDEO/);
  for(const [S,id] of [[B,ja.id],[A,jb.id]]){assert.equal((await S.raw(`/api/jobs/${id}/file/0`)).status,404); for(const act of ['cancel','approve','retry'])assert.equal((await S.post(`/api/jobs/${id}/${act}`,{}))[0],404);}
  for(const bad of ['..%2f..%2fetc%2fpasswd','%2e%2e','x%00','..'])assert.equal((await B.raw(`/api/jobs/${bad}/file/0`)).status,404);
  assert.equal((await B.raw('/api/jobs/'+ja.id+'/file/0',undefined,{cookie:B.ck})).status,404);
  // even a tampered job record cannot point outside the visitor's own clips folder
  const sessA=[...h.sessions.values()].find(s=>s.q.jobs().some(j=>j.id===ja.id)), sessB=[...h.sessions.values()].find(s=>s!==sessA);
  for(const f of [path.join(sessB.dir,'accounts.json'),path.join(sessA.dir,'accounts.json'),path.join(sessB.out,'x/../../accounts.json'),'/etc/hosts']){sessA.q.jobs()[0].files=[f]; assert.equal((await A.raw(`/api/jobs/${ja.id}/file/0`)).status,404,f);}
  // tokens: encrypted at rest, A's never in B's folder, and each visitor's calls used only their own bearer
  for(const f of allFiles(root))assert.ok(!/AT_code|RT_code/.test(fs.readFileSync(f,'utf8')),'plaintext token in '+f);
  assert.ok(allFiles(sessA.dir).some(f=>/token-1\.json$/.test(f))); assert.ok(!allFiles(sessB.dir).join().includes(path.basename(sessA.dir)));
  assert.ok(bearers.includes('Bearer AT_codeA')&&bearers.includes('Bearer AT_codeB'));
});

test('requests without a session or a valid token are refused',async()=>{
  const {base,visitor}=await boot(), A=await visitor(), B=await visitor();
  assert.equal((await fetch(base+'/api/state')).status,401); assert.equal((await fetch(base+'/api/state',{headers:{cookie:'desk_sid='+'a'.repeat(64)}})).status,401); assert.equal((await fetch(base+'/api/state',{headers:{cookie:'desk_sid=../..'}})).status,401);
  assert.equal((await fetch(base+'/api/quote',{method:'POST',headers:{cookie:A.ck},body:'{}'})).status,403); // no csrf token
  assert.equal((await fetch(base+'/api/quote',{method:'POST',headers:{cookie:A.ck,'x-desk-token':B.csrf},body:'{}'})).status,403); // another visitor's token
  assert.equal((await fetch(base+'/api/quote',{method:'POST',headers:{cookie:A.ck,'x-desk-token':A.csrf,origin:'http://evil.example'},body:'{}'})).status,403);
  const forged=await fetch(base+'/',{headers:{cookie:'desk_sid='+'a'.repeat(64)}}); assert.notEqual(forged.headers.get('set-cookie').split(';')[0],'desk_sid='+'a'.repeat(64)); // unknown id is replaced, not adopted
  const ck=A.ck; assert.match((await fetch(base+'/')).headers.get('set-cookie'),/HttpOnly; SameSite=Lax/); assert.match((await fetch(base+'/',{headers:{'x-forwarded-proto':'https'}})).headers.get('set-cookie'),/; Secure/); assert.ok(ck);
});

test('paste the address: full URL, query with and without ?, wrong state, no attempt started',async()=>{
  const {visitor}=await boot({loginPerHour:100}), A=await visitor();
  assert.match((await A.post('/api/connect/finish',{address:'?code=x&state=y'}))[1].error,/Press Connect first/);
  const forms=[st=>`http://localhost:38917/callback?code=c1&state=${st}`,st=>`  http://127.0.0.1:38917/callback?code=c2&state=${st}\n`,st=>`?code=c3&state=${st}`,st=>`code=c4&state=${st}`,st=>`/callback?state=${st}&code=c5`];
  for(const [i,f] of forms.entries()){const r=await A.connect('x',f); assert.equal(r[0],200,JSON.stringify(r));}
  const [,s]=await A.get('/api/state'); assert.equal(s.accounts.accounts.length,forms.length); assert.equal(s.account.nickname,'nick-c5');
  const [,{url:u1}]=await A.post('/api/connect/start',{}); await A.post('/api/connect/start',{}); // newer attempt replaces the first
  const r=await A.post('/api/connect/finish',{address:'?code=z&state='+new URL(u1).searchParams.get('state')}); assert.equal(r[0],400); assert.match(r[1].error,/older sign-in attempt/);
  assert.equal((await A.connect('q',st=>`?state=${st}`))[0],400); // no code
});

test('delete my data wipes tokens, jobs and clips; sign out only drops the cookie',async()=>{
  const {root,base,visitor,h}=await boot(), A=await visitor(), B=await visitor(); await A.connect('codeA'); await B.connect('codeB');
  const [,[ja]]=await A.post('/api/jobs',{prompts:['x'],spec,ceiling:10}); await A.done(ja.id); const dirA=[...h.sessions.values()].find(s=>s.q.jobs().some(j=>j.id===ja.id)).dir; assert.ok(allFiles(dirA).length>3);
  const so=await A.raw('/api/hosted/signout',{}); assert.equal(so.status,200); assert.match(so.headers.get('set-cookie'),/Max-Age=0/); assert.ok(fs.existsSync(dirA)); // data stays
  const del=await A.raw('/api/hosted/delete',{}); assert.equal(del.status,200); assert.match(del.headers.get('set-cookie'),/Max-Age=0/);
  assert.ok(!fs.existsSync(dirA)); assert.equal((await A.get('/api/state'))[0],401); assert.equal((await B.get('/api/state'))[0],200); assert.equal((await B.get('/api/state'))[1].jobs.length,0); // B untouched
  const A2=await visitor(); assert.deepEqual((await A2.get('/api/state'))[1].jobs,[]); assert.equal((await A2.get('/api/state'))[1].account.connected,false);
  assert.equal(fs.readdirSync(path.join(root,'v')).length,2);
});

test('caps: queued jobs per visitor and global, body size, login rate, visitors',async()=>{
  const {visitor,base}=await boot({visitorJobs:2,globalJobs:3,loginPerHour:3,maxBody:2000}), A=await visitor(), B=await visitor(); await A.connect('codeA'); await B.connect('codeB'); // 2 of 3 login tries used; ceiling 0 parks jobs in needs_approval = still counted
  const hold=(V,k)=>V.post('/api/jobs',{prompts:Array.from({length:k},(_,i)=>'p'+i),spec,ceiling:0});
  assert.equal((await hold(A,3))[0],429); assert.equal((await hold(A,2))[0],200); assert.equal((await hold(A,1))[0],429);
  assert.equal((await hold(B,2))[0],503); assert.equal((await hold(B,1))[0],200); // global 3
  const big=await A.raw('/api/quote',JSON.stringify({spec:{...spec,prompt:'x'.repeat(5000)}})); assert.equal(big.status,413);
  assert.equal((await A.post('/api/connect/start',{}))[0],200); assert.equal((await A.post('/api/connect/start',{}))[0],429); // A's 4th login try
  const C=await boot({maxVisitors:1}); await C.visitor(); assert.equal((await fetch(C.base+'/')).status,503);
  const D=await boot({loginGlobalPerHour:2}), d1=await D.visitor(), d2=await D.visitor(); await d1.post('/api/connect/start',{}); await d2.post('/api/connect/start',{}); assert.equal((await d1.post('/api/connect/start',{}))[0],429); // global login limit
});
