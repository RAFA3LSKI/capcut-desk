import {connect,tools} from './capcut.mjs'; import fs from 'node:fs';
await connect(); const t=await tools(); fs.writeFileSync('docs/tools-full.json',JSON.stringify(t,null,1));
for(const n of ['capcut_estimate_generation_credits','capcut_video_generate','capcut_generation_poll']){const x=t.find(y=>y.name===n);console.log('## '+n+'\n'+JSON.stringify(x.inputSchema).slice(0,1500)+'\n');}
