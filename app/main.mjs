// Entry for the packaged build: "CapCut Desk" runs the app, "CapCut Desk" --mcp is the assistant bridge (Claude, Codex).
if(process.argv.includes('--mcp'))await import('./mcp.mjs'); else await import('./server.mjs');
