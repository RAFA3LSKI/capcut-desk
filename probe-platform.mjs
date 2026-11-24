// Free probe: does CapCut's connector allow video generation when the client says it is web/mobile? Never sends confirmed:true, so nothing is charged.
import {connect,call} from './capcut.mjs';
const sc=r=>r.structuredContent??(()=>{try{return JSON.parse(r.content?.[0]?.text)}catch{return {text:r.content?.[0]?.text}}})();
const pick=o=>JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k])=>/code|error|message|status|platform|supported|credits|text|next/i.test(k)))).slice(0,420);
await connect();
const spec={prompt:'A calm beach at sunset, gentle waves, no people',model:'seedance2_mini',ratio:'9:16',resolution:'720p',duration_ms:5000,count:1};
for(const platform of ['web','mobile']){
  let ses; try{ses=sc(await call('start_stdraft_session',{platform}));}catch(e){ses={error:String(e.message)};}
  const sid=ses.session_id||ses.draft_session_id||ses.id; console.log(platform,'session:',sid?'ok':pick(ses));
  try{console.log(platform,'prepare:',pick(sc(await call('prepare_for_video_generation',{platform,...(sid?{draft_session_id:sid}:{})}))));}catch(e){console.log(platform,'prepare ERR',String(e.message).slice(0,300));}
  try{console.log(platform,'generate (unconfirmed):',pick(sc(await call('capcut_video_generate',{...(sid?{draft_session_id:sid}:{}),spec,platform}))));}catch(e){console.log(platform,'generate ERR',String(e.message).slice(0,300));}
}
process.exit(0);
