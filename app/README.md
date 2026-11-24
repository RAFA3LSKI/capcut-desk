# CapCut Desk
Free local app: generates video through CapCut's official connector with your own account and credits.
Run: `node app/server.mjs` then open http://127.0.0.1:38917 (try `DRY=1 node app/server.mjs`: fake engine, nothing charged). Needs Node 20+. Tests: `node --test app/`.
Data: `~/.capcut-desk/` (token.json, jobs.json). Clips: `~/CapCut Desk/YYYY-MM-DD/`.
Reference images/video/audio: "Add reference files" in the form, or `--ref/--first/--last` in the CLI. Files are saved in `~/.capcut-desk/refs/` and uploaded with CapCut's own uploader (`vendor/`, runs as a child process). Limits per model are in `LIMITS` in queue.mjs.
Not in v1: image generation, several accounts, installers, licence keys.
Package for buyers: `packaging/build.sh` (needs bun) makes dist/CapCut-Desk-{mac-arm64,mac-x64,windows-x64}.zip: a bun single executable plus index.html and vendor/ beside it, and a buyer README.txt. Double-click opens the browser; `NO_BROWSER=1` or `--no-browser` disables that; `--dry` = DRY mode. A second copy on the same port just opens the page and exits.
