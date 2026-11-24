// "Update available" check: public GitHub releases API, no token. Checked at most every 6 h; any failure just means "no update shown".
import {VERSION} from './version.mjs';
const REPO='RAFA3LSKI/capcut-desk';
export const newer=(a,b)=>{const p=s=>String(s).replace(/^v/,'').split('.').map(n=>parseInt(n)||0); const x=p(a),y=p(b); for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0);} return false;};
let cache=null;
export async function checkUpdate(fetchFn=fetch){
  if(cache&&Date.now()-cache.at<6*36e5)return cache.v;
  let v={current:VERSION,update:false};
  try{const r=await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`,{headers:{accept:'application/vnd.github+json','user-agent':'capcut-desk'},signal:AbortSignal.timeout(8000)});
    if(r.ok){const j=await r.json(); if(newer(j.tag_name,VERSION))v={current:VERSION,update:true,latest:String(j.tag_name).replace(/^v/,''),url:j.html_url};}}catch{}
  cache={at:Date.now(),v}; return v;}
