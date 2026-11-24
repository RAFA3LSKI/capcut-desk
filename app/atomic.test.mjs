// Token and account files are written tmp + rename: no .tmp left behind, content always valid JSON.
import assert from 'node:assert'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {createAccounts} from './accounts.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'atomic-')), A=createAccounts(dir);
const id=A.add('t'); A.update(id,{status:'expired'});
assert.deepStrictEqual(fs.readdirSync(dir).filter(f=>f.endsWith('.tmp')),[]);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir,'accounts.json'),'utf8')).accounts[0].status,'expired');
fs.rmSync(dir,{recursive:true}); console.log('atomic ok');
