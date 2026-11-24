// One-click "add CapCut Desk to my AI assistant": Claude Code, Codex (their own CLIs) and Claude Desktop (its config file).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {execFile} from 'node:child_process';
const H=os.homedir(), NAME='capcut-desk', win=process.platform==='win32';
const find=n=>[...(process.env.PATH||'').split(path.delimiter),path.join(H,'.local/bin'),path.join(H,'.claude/local'),'/opt/homebrew/bin','/usr/local/bin',path.join(H,'.npm-global/bin'),path.join(H,'.bun/bin')].flatMap(d=>win?[path.join(d,n+'.cmd'),path.join(d,n+'.exe')]:[path.join(d,n)]).find(f=>{try{return fs.statSync(f).isFile();}catch{return false;}});
const q=s=>/[^\w./:-]/.test(s)?`"${s}"`:s; // shell:true on Windows joins args unquoted, so quote paths with spaces
const run=(f,a)=>new Promise((ok,no)=>execFile(win?q(f):f,win?a.map(q):a,{timeout:20000,shell:win},(e,o,er)=>e?no(new Error((er||o||e.message).trim().slice(0,200))):ok(o)));
const read=f=>{try{return fs.readFileSync(f,'utf8');}catch{return '';}}, sh=a=>a.map(s=>/[^\w./:-]/.test(s)?`"${s}"`:s).join(' ');
const deskCfg=win?path.join(process.env.APPDATA||H,'Claude','claude_desktop_config.json'):path.join(H,'Library/Application Support/Claude/claude_desktop_config.json');
export function assistants(cmd){ // cmd: [executable, ...args] that starts the MCP bridge
  const cc=find('claude'), cx=find('codex'); let ccAdded=false, dAdded=false; try{ccAdded=!!JSON.parse(read(path.join(H,'.claude.json'))||'{}').mcpServers?.[NAME];}catch{} try{dAdded=!!JSON.parse(read(deskCfg)||'{}').mcpServers?.[NAME];}catch{}
  return [
   {id:'claude-code',name:'Claude Code',found:!!cc,added:ccAdded,manual:`claude mcp add -s user ${NAME} -- ${sh(cmd)}`,note:'Then start a new Claude Code session.',
    add:async()=>{if(!cc)throw new Error('Claude Code was not found on this computer. Use the command below in a terminal.'); await run(cc,['mcp','remove','-s','user',NAME]).catch(()=>{}); await run(cc,['mcp','add','-s','user',NAME,'--',...cmd]);}},
   {id:'claude-desktop',name:'Claude desktop app',found:fs.existsSync(path.dirname(deskCfg)),added:dAdded,manual:`Add to ${deskCfg} under "mcpServers":\n"${NAME}": ${JSON.stringify({command:cmd[0],args:cmd.slice(1)})}`,note:'Then quit and reopen Claude.',
    add:async()=>{const t=read(deskCfg), j=t.trim()?JSON.parse(t):{}; fs.mkdirSync(path.dirname(deskCfg),{recursive:true}); if(t&&!fs.existsSync(deskCfg+'.before-capcut-desk'))fs.writeFileSync(deskCfg+'.before-capcut-desk',t); // keep the user's original once
      (j.mcpServers??={})[NAME]={command:cmd[0],args:cmd.slice(1)}; fs.writeFileSync(deskCfg,JSON.stringify(j,null,2));}},
   {id:'codex',name:'Codex',found:!!cx,added:read(path.join(H,'.codex/config.toml')).includes(`[mcp_servers.${NAME}]`),manual:`codex mcp add ${NAME} -- ${sh(cmd)}`,note:'Then start a new Codex session.',
    add:async()=>{if(!cx)throw new Error('Codex was not found on this computer. Use the command below in a terminal.'); await run(cx,['mcp','remove',NAME]).catch(()=>{}); await run(cx,['mcp','add',NAME,'--',...cmd]);}},
  ];}
