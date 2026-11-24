// Account store: DIR/accounts.json {active, accounts:[{id,nickname,addedAt,status}]}; each account's tokens live in DIR/token-<id>.json (0600).
// A pre-accounts install (DIR/token.json) becomes account 1 on first start; the old file is kept as token.json.bak-migrated.
import fs from 'node:fs'; import path from 'node:path';
export function createAccounts(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const F=path.join(dir,'accounts.json'), OLD=path.join(dir,'token.json'), file=id=>path.join(dir,`token-${id}.json`);
  const write=(f,o)=>fs.writeFileSync(f,JSON.stringify(o,null,1),{mode:0o600});
  const read=()=>{try{return JSON.parse(fs.readFileSync(F,'utf8'));}catch{return {active:null,accounts:[]};}};
  const patch=fn=>{const s=read(); fn(s); write(F,s); return s;}; // re-reads accounts.json every time: another copy of the app may have changed it
  if(!fs.existsSync(F)&&fs.existsSync(OLD)){ // order: token copy, then the index, then the rename; a crash in between just repeats the steps
    write(file(1),JSON.parse(fs.readFileSync(OLD,'utf8'))); write(F,{active:'1',accounts:[{id:'1',nickname:'Account 1',addedAt:new Date().toISOString(),status:'connected'}]}); fs.renameSync(OLD,OLD+'.bak-migrated');}
  return {
    file, list:read, active:()=>{const s=read(); return s.accounts.find(a=>a.id===s.active);},
    add(nickname){let id; patch(s=>{id=String(Math.max(0,...s.accounts.map(a=>+a.id))+1); s.accounts.push({id,nickname:nickname||'Account '+id,addedAt:new Date().toISOString(),status:'connected'}); s.active=id;}); return id;},
    update(id,p){patch(s=>Object.assign(s.accounts.find(a=>a.id===id)||{},p));},
    setActive(id){if(!read().accounts.some(a=>a.id===id))throw new Error('unknown account'); patch(s=>{s.active=id;});},
    find:key=>read().accounts.find(a=>a.id===String(key)||a.nickname.toLowerCase()===String(key).toLowerCase()),
    remove(id){fs.rmSync(file(id),{force:true}); patch(s=>{s.accounts=s.accounts.filter(a=>a.id!==id); if(s.active===id)s.active=s.accounts[0]?.id??null;});},
  };
}
