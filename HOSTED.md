# CapCut Desk hosted prototype (option C), local only

The desktop UI served to many visitors, so a buyer needs no download. Off by default: only `CAPCUT_DESK_HOSTED=1` turns it on; the desktop app is unchanged.

## Run locally
```
CAPCUT_DESK_HOSTED=1 DESK_DIR=/some/empty/folder PORT=8799 CAPCUT_DESK_KEY=$(openssl rand -hex 32) node app/main.mjs
```
- `CAPCUT_DESK_KEY`: 64 hex chars, AES-256-GCM key for token files. Without it the server refuses to start. Lose the key = every visitor must reconnect.
- `DESK_DIR`: required (so it can never touch the real `~/.capcut-desk`). Visitors live in `DESK_DIR/v/<hash>/`.
- `PORT`: default 8787; 38917 is refused (desktop app). `CAPCUT_DESK_HOSTS`: allowed Host headers, default `127.0.0.1:PORT,localhost:PORT`. `DRY=1`: fake engine, no CapCut.
- Listens on 127.0.0.1 only. Open `http://127.0.0.1:PORT`.

## Buyer flow
Connect -> open the CapCut link -> sign in (phone QR or email), approve -> the page that fails to load (CapCut only allows localhost redirects) -> copy its address -> paste into the box -> connected. A pasted address may be the full URL, `?code=..&state=..`, or `code=..&state=..`. A stale attempt gets a clear error.

## Before any public hosting (Raf's call)
- Terms: CapCut/Dreamina terms bar automated access and integration into other products. Check them, or ask CapCut. Every buyer's calls come from this server's single IP, so one abuse flag hits all buyers.
- HTTPS only (a reverse proxy sets `x-forwarded-proto: https`, which makes the cookie `Secure`); set `CAPCUT_DESK_HOSTS` to the public name; the proxy must also cap request size and rate per IP.
- Key management: key in a secret store, backups, rotation plan (none built).
- Privacy text and terms for buyers: what is stored (tokens encrypted, prompts and clips in plain files), how long, how to delete (Delete my data button).
- A buyer on a machine already running the desktop app on port 38917 would hit that app with the redirect: tell buyers to close it.

## NOT done
- Prompts/jobs and clips are not encrypted at rest (only tokens and the pending login).
- No retention or cleanup: no expiry of old visitors, no disk quota per visitor, no eviction of loaded sessions from memory; the visitor cap counts folders.
- Queued jobs of a visitor resume only when that visitor's browser visits again after a restart.
- Rate limits and caps are in memory per process (single instance only). Per-visitor 10 active jobs, global 100, 10 sign-in calls per visitor and 100 total per hour, 240 requests per minute per visitor, 20 KB request bodies.
- Reference-file upload, AI assistants, remote link, open-folder and update check are off in hosted mode.
- Delete my data cancels running jobs, then wipes; a worker mid-write is cleaned by a second wipe, not locked.
- Not tested against the real CapCut, real browsers or real HTTPS. No terms/privacy pages.
