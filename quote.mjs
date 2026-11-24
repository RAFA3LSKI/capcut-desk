import {connect,call} from './capcut.mjs';
await connect();
const cases=[['seedance2.5','720p',5000],['seedance2.5','720p',10000],['seedance2.5','1080p',10000],['seedance2','720p',10000],['seedance2_fast','720p',10000],['seedance2_mini','720p',10000]];
for(const [model,resolution,duration_ms] of cases){
  try{const r=await call('capcut_estimate_generation_credits',{media_type:'video',parameters:{prompt:'a calm beach at sunset, slow push in',model,resolution,ratio:'9:16',count:1,duration_ms},reference_assets:[]});
    console.log(model,resolution,duration_ms/1000+'s =>',JSON.stringify(r.structuredContent??r.content?.[0]?.text).slice(0,420));}
  catch(e){console.log(model,resolution,'ERR',String(e.message).slice(0,300));}
}
