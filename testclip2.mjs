import {connect,call} from './capcut.mjs'; import fs from 'node:fs';
const log=(k,v)=>{fs.appendFileSync('out/testclip.log',`\n## ${k}\n${JSON.stringify(v,null,1)}\n`);};
const sc=r=>r.structuredContent??(()=>{try{return JSON.parse(r.content?.[0]?.text)}catch{return {text:r.content?.[0]?.text}}})();
const st=JSON.parse(fs.readFileSync('out/testclip-state.json','utf8'));
await connect();
let r;
if(!st.task){ r=sc(await call('capcut_video_generate',{draft_session_id:st.sid,spec:st.spec,generate_id:st.r.generate_id,unique_key:st.r.unique_key,confirmed:true,platform:'desktop'})); log('generate2',r);
  console.log('generate2',JSON.stringify(r).slice(0,500)); st.task=r.task_id; fs.writeFileSync('out/testclip-state.json',JSON.stringify({...st,r2:r},null,1)); }
if(!st.task){process.exit(1);}
for(let i=0;i<40;i++){ const p=sc(await call('capcut_generation_poll',{task_id:st.task,platform:'desktop'})); log('poll'+i,p);
  const s=p.status||p.state||p.code; console.log('poll',i,s,p.estimated_wait_ms??p.next_poll_after_ms??'');
  if(/succe|complete|fail|cancel|done|error/i.test(String(s))){console.log(JSON.stringify(p).slice(0,1400));break;}
  await new Promise(z=>setTimeout(z,Math.min(Math.max(p.next_poll_after_ms||10000,5000),20000))); }
