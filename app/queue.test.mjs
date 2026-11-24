import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {createQueue,checkSpec} from './queue.mjs';
const spec={prompt:'a beach',model:'seedance2_mini',ratio:'9:16',resolution:'720p',duration_ms:5000,count:1};
// stub engine that records every call
function stub({credits=15,polls=[{status:'succeeded',credits:15,urls:['u1']}]}={}){
  const calls=[]; let i=0;
  return {calls,
    generate:async(s,c)=>{calls.push(['generate',c]); return c?{task_id:'gen_1'}:{confirm:{credits,generate_id:'G1',unique_key:'K1'}};},
    poll:async id=>{calls.push(['poll',id]); return polls[Math.min(i++,polls.length-1)];},
    cancel:async()=>{}, download:async(u,d)=>fs.writeFileSync(d,'x')};
}
const mk=(engine,file)=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'desk-'));return createQueue({engine,file:file||path.join(d,'jobs.json'),outDir:path.join(d,'out'),sleep:async()=>{},minPoll:0});};

test('confirm reuses generate_id and unique_key',async()=>{
  const e=stub(),q=mk(e); q.add({name:'a',spec,ceiling:15}); await q.idle();
  const g=e.calls.filter(c=>c[0]==='generate'); assert.equal(g.length,2);
  assert.deepEqual(g[1][1],{generate_id:'G1',unique_key:'K1'}); assert.equal(q.jobs()[0].status,'done'); assert.equal(q.creditsUsed(),15);
});
test('restart with a task_id polls and does not resubmit',async()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'desk-')),file=path.join(d,'jobs.json');
  fs.writeFileSync(file,JSON.stringify([{id:'j1',name:'a',spec,ceiling:15,status:'running',generate_id:'G1',unique_key:'K1',task_id:'gen_1'}]));
  const e=stub(),q=createQueue({engine:e,file,outDir:path.join(d,'out'),sleep:async()=>{},minPoll:0}); q.start(); await q.idle();
  assert.equal(e.calls.filter(c=>c[0]==='generate').length,0); assert.deepEqual(e.calls[0],['poll','gen_1']); assert.equal(q.jobs()[0].status,'done');
});
test('charge above the approved ceiling stops as needs_approval',async()=>{
  const e=stub({credits:200}),q=mk(e); q.add({name:'a',spec,ceiling:15}); await q.idle();
  assert.equal(q.jobs()[0].status,'needs_approval'); assert.ok(!e.calls.some(c=>c[0]==='generate'&&c[1]),'must not confirm');
  q.approve(q.jobs()[0].id,200); await q.idle(); assert.equal(q.jobs()[0].status,'done');
  assert.deepEqual(e.calls.filter(c=>c[0]==='generate').at(-1)[1],{generate_id:'G1',unique_key:'K1'});
});
test('failed job keeps its error',async()=>{
  const e=stub({polls:[{status:'running'},{status:'failed',error:'content rejected'}]}),q=mk(e); q.add({name:'a',spec,ceiling:15}); await q.idle();
  assert.equal(q.jobs()[0].status,'failed'); assert.equal(q.jobs()[0].error,'content rejected');
});
test('download failure can be retried without a second charge', async()=>{
  const e=stub(); let fail=true; e.download=async(u,d)=>{if(fail)throw new Error('network');fs.writeFileSync(d,'x');};
  const q=mk(e); const j=q.add({spec,ceiling:15}); await q.idle();
  assert.equal(j.status,'failed'); assert.equal(j.task_id,'gen_1');
  fail=false; q.retry(j.id); await q.idle();
  assert.equal(j.status,'done'); assert.equal(e.calls.filter(c=>c[0]==='generate').length,2); // quote + one confirm, never a third
});

const img={role:'reference',media_type:'image',uri:'u/1',file_name:'a.png'}, vid={role:'reference',media_type:'video',vid:'v1',file_name:'a.mp4'}, aud={role:'reference',media_type:'audio',vid:'v2',file_name:'a.mp3'};
const withRefs=(model,reference_assets)=>({...spec,model,reference_assets});
test('limits table accepts valid and rejects over-limit / mixed / invalid reference jobs',()=>{
  checkSpec(withRefs('seedance2_mini',[img,vid,aud])); checkSpec(withRefs('seedance2.5',Array(30).fill(img)));
  checkSpec(withRefs('seedance1_fast',[{...img,role:'first_frame'},{...img,role:'last_frame'}]));
  const bad=(s,re)=>assert.throws(()=>checkSpec(s),re);
  bad(withRefs('seedance2_mini',Array(10).fill(img)),/at most 9 reference images/);
  bad(withRefs('seedance2.5',Array(31).fill(img)),/at most 30/);
  bad(withRefs('seedance2',[...Array(8).fill(img),vid,vid,aud,aud,aud]),/at most 12 reference files in total/);
  bad(withRefs('seedance2_mini',[aud]),/needs at least one reference image or video/);
  bad(withRefs('seedance1_fast',[img]),/no reference files/);
  bad(withRefs('seedance2_mini',[img,{...img,role:'first_frame'}]),/cannot be mixed/);
  bad(withRefs('seedance2_mini',[{...img,role:'first_frame'},{...img,role:'first_frame'}]),/at most one first frame/);
  bad(withRefs('seedance2_mini',[{...vid,role:'first_frame'}]),/only images/);
});
test('reference_assets reach the first generate call and the confirm call unchanged',async()=>{
  const e=stub(),specs=[],g=e.generate; e.generate=async(s,c)=>{specs.push(s);return g(s,c);};
  const refs=[img,{...vid},{...aud}], q=mk(e); q.add({name:'a',spec:withRefs('seedance2_mini',refs),ceiling:15}); await q.idle();
  assert.equal(specs.length,2); assert.deepEqual(specs[0].reference_assets,refs); assert.deepEqual(specs[1].reference_assets,refs); assert.equal(q.jobs()[0].status,'done');
});
