#!/usr/bin/env node
// capcut-desk add "<prompt>" [--model m --res 720p --ratio 9:16 --secs 5 --count 1 --name n --max credits --ref file (repeatable) --first img --last img] | status [id] | list
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir=process.env.DESK_DIR||path.join(os.homedir(),'.capcut-desk',process.env.DRY?'dry':'');
let run; try{run=JSON.parse(fs.readFileSync(path.join(dir,'run.json'),'utf8'));}catch{console.error('CapCut Desk is not running. Start it first: node app/server.mjs');process.exit(1);}
const api=async(p,b)=>{const r=await fetch(`http://127.0.0.1:${run.port}${p}`,b?{method:'POST',headers:{'x-desk-token':run.token,'content-type':'application/json'},body:JSON.stringify(b)}:{});const j=await r.json();if(!r.ok)throw new Error(j.error);return j;};
const [cmd,...rest]=process.argv.slice(2), o={}, pos=[]; for(let i=0;i<rest.length;i++)if(rest[i].startsWith('--')){const k=rest[i].slice(2),v=rest[++i]; k==='ref'?(o.ref??=[]).push(v):o[k]=v;}else pos.push(rest[i]);
const line=j=>`${j.id}  ${j.status}${j.error?' ('+j.error+')':''}  ${j.name}  credits:${j.credits??j.quoted??'?'}  ${(j.files||[]).join(' | ')}`;
try{
  if(cmd==='add'){ if(!pos.length)throw new Error('give a prompt');
    const refs=[]; for(const [f,role] of [...(o.ref||[]).map(f=>[f,'reference']),...(o.first?[[o.first,'first_frame']]:[]),...(o.last?[[o.last,'last_frame']]:[])]){ // each file goes to the server, which saves + uploads it
      const r=await fetch(`http://127.0.0.1:${run.port}/api/upload`,{method:'POST',headers:{'x-desk-token':run.token,'x-file-name':encodeURIComponent(path.basename(f))},body:fs.readFileSync(f)}); const a=await r.json(); if(!r.ok)throw new Error(`${f}: ${a.error}`); refs.push({...a,role}); console.log(`uploaded ${f} as ${role}`);}
    const spec={model:o.model||'seedance2_mini',resolution:o.res||'720p',ratio:o.ratio||'9:16',duration_ms:(+o.secs||5)*1000,count:+o.count||1,...(refs.length?{reference_assets:refs}:{})};
    const jobs=await api('/api/jobs',{prompts:pos,spec,name:o.name,ceiling:o.max!=null?+o.max:undefined}); jobs.forEach(j=>console.log(line(j)));}
  else if(cmd==='status'){const s=await api('/api/state'); console.log(`account: ${s.account.nickname||(s.account.connected?'connected':'NOT connected')}  credits used: ${s.creditsUsed}${s.dry?'  (DRY MODE)':''}`); s.jobs.filter(j=>!pos[0]||j.id===pos[0]).forEach(j=>console.log(line(j)));}
  else if(cmd==='list'){(await api('/api/state')).jobs.forEach(j=>console.log(line(j)));}
  else console.log('usage: capcut-desk add "<prompt>"... [--model --res --ratio --secs --count --name --max --ref f --first f --last f] | status [id] | list');
}catch(e){console.error('error: '+e.message);process.exit(1);}
