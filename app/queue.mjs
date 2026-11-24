// Job store + worker. Pure logic: the engine is injected. One job at a time.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
export const MODELS={ // the one table: UI and server both use it
  'seedance2.5':{res:['480p','720p','1080p'],dur:[4,30]}, seedance2:{res:['480p','720p','1080p','4K'],dur:[4,15]},
  seedance2_fast:{res:['480p','720p'],dur:[4,15]}, seedance2_mini:{res:['480p','720p'],dur:[4,15]}, seedance1_fast:{res:['480p','720p'],dur:[2,12]}};
// Reference limits per model (docs/capcut-plugin-v29/generate-media/references/videos.md). Keyframes (first/last_frame) are always max 1+1 and never mix with references.
const R30={image:30,video:10,audio:10}, R12={image:9,video:3,audio:3,total:12,audioNeedsVisual:true};
export const LIMITS={'seedance2.5':R30,seedance2:R12,seedance2_fast:R12,seedance2_mini:R12,seedance1_fast:{image:0,video:0,audio:0}};
export const RATIOS=['adaptive','21:9','16:9','9:16','4:3','1:1','3:4'];
const DONE=new Set(['done','failed','cancelled']);
export function checkRefs(model,refs=[]){
  if(!Array.isArray(refs))throw new Error('reference_assets must be a list'); if(refs.length>50)throw new Error('at most 50 reference files');
  const L=LIMITS[model], n={image:0,video:0,audio:0}; let first=0,last=0,plain=0;
  for(const a of refs){
    if(!n.hasOwnProperty(a?.media_type))throw new Error('reference must be an image, video or audio');
    if(a.media_type==='image'?!a.uri:!a.vid)throw new Error(`a ${a.media_type} reference is missing its ${a.media_type==='image'?'uri':'vid'}`);
    if(a.role==='first_frame'||a.role==='last_frame'){if(a.media_type!=='image')throw new Error('only images can be a first or last frame'); a.role==='first_frame'?first++:last++;}
    else if(a.role==='reference'){plain++;n[a.media_type]++;} else throw new Error('role must be reference, first_frame or last_frame');}
  if(first>1||last>1)throw new Error('use at most one first frame and one last frame');
  if(first+last&&plain)throw new Error('first/last frames cannot be mixed with reference files');
  if(plain&&!L.image&&!L.video&&!L.audio)throw new Error(`${model} takes no reference files, only a first and/or last frame image`);
  for(const k of ['image','video','audio'])if(n[k]>L[k])throw new Error(`${model} allows at most ${L[k]} reference ${k}${L[k]===1?'':'s'} (you have ${n[k]})`);
  if(L.total&&plain>L.total)throw new Error(`${model} allows at most ${L.total} reference files in total (you have ${plain})`);
  if(L.audioNeedsVisual&&n.audio&&!n.image&&!n.video)throw new Error(`${model} needs at least one reference image or video when you add audio`);}
export function checkSpec(s){
  const m=MODELS[s.model]; if(!m)throw new Error('unknown model');
  if(!m.res.includes(s.resolution))throw new Error(`${s.model} supports ${m.res.join(', ')}`);
  const sec=s.duration_ms/1000; if(!Number.isInteger(sec)||sec<m.dur[0]||sec>m.dur[1])throw new Error(`${s.model} supports ${m.dur[0]}-${m.dur[1]} seconds`);
  if(!RATIOS.includes(s.ratio))throw new Error('unknown ratio'); if(!Number.isInteger(s.count)||s.count<1||s.count>4)throw new Error('count must be 1-4');
  checkRefs(s.model,s.reference_assets);
  if(typeof s.prompt!=='string'||!s.prompt.trim()||s.prompt.length>5000)throw new Error('prompt must be 1-5000 characters');}

export function createQueue({engine,file,outDir,sleep=ms=>new Promise(r=>setTimeout(r,ms)),minPoll=5000,now=()=>new Date()}){
  let jobs=[]; try{jobs=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const tag=()=>{const a=engine.active?.(); return a?{accountId:a.id,nickname:a.nickname}:{};};
  const first=engine.accounts?.().accounts.find(a=>a.id==='1'); // jobs from before accounts existed belong to account 1 (or to an unnamed earlier account if it is gone)
  for(const j of jobs)if(!j.accountId)Object.assign(j,first?{accountId:'1',nickname:first.nickname}:{accountId:'0',nickname:'earlier account'});
  for(const j of jobs)if(j.status==='running')j.status='queued'; // restart: keeps task_id, so it resumes polling and never resubmits
  const persist=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(jobs,null,1),{mode:0o600});fs.renameSync(file+'.tmp',file);};
  const set=(j,p)=>{Object.assign(j,p);persist();};
  let pumping=null;
  const free=(day,name)=>{fs.mkdirSync(path.join(outDir,day),{recursive:true}); let i=1; return ()=>{let f; do f=path.join(outDir,day,`${name} ${i++}.mp4`); while(fs.existsSync(f)); return f;};};

  async function run(j){
    set(j,{status:'running',error:undefined,...(j.task_id?{}:tag())}); // not yet submitted: it runs, and is tagged, under the account active now. ponytail: a job polling under another account than it was submitted with needs per-call accountId
    try{
      if(!j.task_id){
        if(!j.generate_id){const r=await engine.generate(j.spec); if(!r.confirm)throw new Error('connector did not ask for confirmation'); set(j,{generate_id:r.confirm.generate_id,unique_key:r.confirm.unique_key,quoted:r.confirm.credits});}
        if(!(j.quoted<=j.ceiling))return set(j,{status:'needs_approval'});
        const r=await engine.generate(j.spec,{generate_id:j.generate_id,unique_key:j.unique_key}); // same ids every time
        if(!r.task_id)throw new Error('no task_id after confirm'); set(j,{task_id:r.task_id});
      }
      for(let bad=0;;){
        let p; try{p=await engine.poll(j.task_id);bad=0;}catch(e){if(++bad>=20)throw e; await sleep(minPoll); continue;}
        if(j.status==='cancelled')return;
        if(p.status==='succeeded'){
          const day=now().toLocaleDateString('en-CA'), next=free(day,j.name), files=[];
          for(const u of p.urls){const f=next(); await engine.download(u,f); files.push(f);}
          return set(j,{status:'done',credits:p.credits,files,finishedAt:now().toISOString()});}
        if(p.status==='failed')return set(j,{status:'failed',error:p.error||'generation failed'});
        if(p.status==='cancelled')return set(j,{status:'cancelled'});
        await sleep(Math.max(minPoll,p.waitMs||0));
      }
    }catch(e){ if(j.status!=='cancelled')set(j,{status:'failed',error:String(e.message||e).slice(0,300)}); }
  }
  function pump(){ if(pumping)return pumping; return pumping=(async()=>{await null; for(let j;(j=jobs.find(x=>x.status==='queued'));)await run(j);})().finally(()=>{pumping=null;}); } // await null: finally can never run before the assignment
  return {
    jobs:()=>jobs, idle:()=>pumping||Promise.resolve(), start:pump,
    add({name,spec,ceiling}){checkSpec(spec); const j={id:crypto.randomUUID().slice(0,8),name:(String(name||spec.prompt.slice(0,30)).replace(/[\\/:*?"<>|\x00-\x1f]/g,' ').trim()||'clip').slice(0,60),spec,ceiling:+ceiling||0,status:'queued',createdAt:now().toISOString(),...tag()}; jobs.push(j);persist();pump();return j;},
    approve(id,ceiling){const j=jobs.find(x=>x.id===id); if(j?.status!=='needs_approval')throw new Error('job is not waiting for approval'); set(j,{ceiling:+ceiling,status:'queued'});pump();return j;},
    retry(id){const j=jobs.find(x=>x.id===id); if(j?.status!=='failed'||!j.task_id)throw new Error('only a failed job that CapCut already accepted can be retried'); set(j,{status:'queued'});pump();return j;}, // keeps task_id: polls and downloads again, no new charge
    async cancel(id){const j=jobs.find(x=>x.id===id); if(!j||DONE.has(j.status))throw new Error('job is already finished'); const t=j.task_id; set(j,{status:'cancelled'}); if(t)await engine.cancel(t).catch(()=>{}); return j;},
    creditsUsed:()=>jobs.reduce((a,j)=>a+(j.status==='done'?j.credits||0:0),0),
  };
}
