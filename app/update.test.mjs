// node app/update.test.mjs
import assert from 'node:assert'; import {newer,checkUpdate} from './update.mjs'; import {VERSION} from './version.mjs';
assert(newer('v0.1.1','0.1.0')); assert(newer('0.2.0','0.1.9')); assert(newer('1.0.0','0.9.9')); assert(!newer('0.1.0','0.1.0')); assert(!newer('0.1.0','0.1.1')); assert(newer('0.1.10','0.1.9'));
const fake=tag=>async()=>({ok:true,json:async()=>({tag_name:tag,html_url:'https://x/r'})});
const a=await checkUpdate(fake('v99.0.0')); assert(a.update&&a.latest==='99.0.0'&&a.url==='https://x/r'&&a.current===VERSION);
console.log('update.test ok');
