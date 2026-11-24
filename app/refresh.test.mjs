// Parallel calls on a >12 h old token must trigger ONE refresh (rotated refresh token is single-use); a network error must not mark the account expired.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert';
import {createEngine} from './engine.mjs'; import {createAccounts} from './accounts.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ccd-')); const A=createAccounts(dir); const id=A.add('t');
fs.writeFileSync(A.file(id),JSON.stringify({access_token:'old',refresh_token:'r1',client_id:'c',at:Date.now()-13*36e5}));
let refreshes=0, down=false; const real=globalThis.fetch;
globalThis.fetch=async(u,o)=>{u=String(u);
  if(u.endsWith('/oauth/token')){refreshes++; await new Promise(r=>setTimeout(r,50)); if(down)throw new TypeError('network'); return new Response(JSON.stringify({access_token:'new'+refreshes,refresh_token:'r'+(refreshes+1)}));}
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{structuredContent:{ok:true,session_id:'s'}}}),{headers:{'mcp-session-id':'x'}});};
const e=createEngine(dir);
await Promise.all([1,2,3,4,5].map(()=>e.call?.('ping').catch(()=>{})??e.profile()));
assert.strictEqual(refreshes,1,'expected exactly 1 refresh, got '+refreshes);
// network failure keeps the account connected
fs.writeFileSync(A.file(id),JSON.stringify({access_token:'old',refresh_token:'r9',client_id:'c',at:Date.now()-13*36e5})); down=true;
await e.profile().catch(()=>{}); assert.notStrictEqual(A.active().status,'expired','network error must not expire the account');
globalThis.fetch=real; console.log('refresh.test ok');
