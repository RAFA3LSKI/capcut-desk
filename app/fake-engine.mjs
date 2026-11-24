// Same interface as engine.mjs, no network, nothing is charged. A prompt containing FAIL makes the job fail; NOCREDITS answers out of credits.
import fs from 'node:fs'; import path from 'node:path'; import {kindOf,BAD_KIND,NO_CREDITS} from './engine.mjs';
const RATE={'seedance2.5':37,seedance2:17,seedance2_fast:5,seedance2_mini:3,seedance1_fast:3}; // credits per second, rough
export function createFake(){
  let n=0, pend=null, accts=[{id:'1',nickname:'demo-user',addedAt:new Date().toISOString(),status:'connected'}], act='1'; const tasks=new Map(), keys=new Map();
  const cost=s=>Math.round((RATE[s.model]||5)*s.duration_ms/1000*s.count);
  return {
    status:()=>({connected:!!act}), accounts:()=>({active:act,accounts:accts}), active:()=>accts.find(a=>a.id===act),
    switchAccount(k){const a=accts.find(a=>a.id===String(k)||a.nickname===k); if(!a)throw new Error('No account called '+k); act=a.id; return a;},
    removeAccount(id){accts=accts.filter(a=>a.id!==String(id)); if(act===String(id))act=accts[0]?.id??null;},
    async beginLogin(re){pend=re?String(re):null; return '/callback?code=fake&state=fake';},
    async finishLogin(){const a=pend&&accts.find(a=>a.id===pend); if(a)a.status='connected'; else{const id=String(Math.max(0,...accts.map(a=>+a.id))+1); accts.push({id,nickname:'demo-user '+id,addedAt:new Date().toISOString(),status:'connected'}); act=id;}},
    async profile(){return {nickname:accts.find(a=>a.id===act)?.nickname||null};},
    async upload(f){const kind=kindOf(f); if(!kind)throw new Error(BAD_KIND); const id='fake-'+path.basename(f); return {role:'reference',media_type:kind,...(kind==='image'?{uri:id}:{vid:id}),file_name:path.basename(f)};},
    async quote(s){return {credits:cost(s),insufficient:/NOCREDITS/.test(s.prompt)};},
    async generate(s,confirm){
      if(/NOCREDITS/.test(s.prompt))throw new Error(NO_CREDITS);
      if(!confirm){const c={credits:cost(s),generate_id:'g'+(++n),unique_key:'k'+n}; keys.set(c.generate_id,c.unique_key); return {confirm:c};}
      if(keys.get(confirm.generate_id)!==confirm.unique_key)throw new Error('unknown generate_id/unique_key');
      const id='gen_fake_'+confirm.generate_id; tasks.set(id,{polls:0,s}); return {task_id:id};},
    async poll(id){const t=tasks.get(id)||{polls:0,s:{prompt:'',model:'seedance2_mini',duration_ms:5000,count:1}}; tasks.set(id,t); t.polls++;
      if(t.polls<3)return {status:t.polls===1?'queued':'running',waitMs:0};
      if(/FAIL/.test(t.s.prompt))return {status:'failed',error:'fake: content rejected',waitMs:0};
      return {status:'succeeded',credits:cost(t.s),urls:Array.from({length:t.s.count},(_,i)=>`fake://${id}/${i}`),waitMs:0};},
    async cancel(){},
    async download(url,dest){fs.writeFileSync(dest,'DRY MODE placeholder, not a real video\n'+url);},
  };
}
