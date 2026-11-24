# CapCut Desk — build spec (2026-11-14)

A small desktop app Raf gives free to buyers of his CapCut accounts. It runs on the buyer's own computer and
generates video through CapCut's OFFICIAL connector with the buyer's own account and credits.

Read first: `docs/findings-2026-11-14.md` (what was proven today), `docs/tools-full.json` (exact input schema of
every connector action), `docs/capcut-plugin-v29/generate-media/` (CapCut's own usage rules for generation),
`capcut.mjs` (working engine: registration, sign-in, connect, call), `testclip.mjs` + `testclip2.mjs` (the exact
call sequence that produced a real clip), `out/testclip.log` (real responses).

## Hard rules
- NEVER spend credits. The builder may call only `capcut_get_profile` and `capcut_estimate_generation_credits`
  on the live connector. Everything else is exercised through the fake engine (DRY mode).
- Never resubmit a job that already has a `task_id`, and always reuse the same `generate_id` + `unique_key` when
  confirming. A double submit is a double charge.
- Auto-confirm a charge only when the server's `credits_amount` is <= the ceiling the user approved when they
  queued the job (the quote they saw). Otherwise the job stops as `needs_approval`.
- Server binds 127.0.0.1 only. Token file mode 0600. Never log tokens, codes or full signed URLs.
- State-changing API routes require a per-run random token (injected into the page) and a local Origin/Host,
  so no website can drive the app.
- Do not remove, crop or hide the "Ai" label or any provenance data on results.
- Zero npm dependencies. Node 20+ built-ins only (http, fs, crypto, node:test). No build step. Few files.

## Layout
```
app/
  server.mjs      http server on 127.0.0.1:38917 (same port as the OAuth redirect; serves /callback itself)
  engine.mjs      real engine (moved from ../capcut.mjs: register, sign-in, token refresh, connect, call)
  fake-engine.mjs same interface, no network: quotes, CONFIRMATION_REQUIRED, queued->running->succeeded, a tiny local mp4/placeholder
  queue.mjs       job store + worker (pure logic, engine injected)
  index.html      the whole UI, one file, no framework
  cli.mjs         `capcut-desk add|status|list` talking to the local server (for Claude/Codex)
  SKILL.md        how an AI assistant uses cli.mjs
  queue.test.mjs  node:test
```
Data dir: `~/.capcut-desk/` (token.json, jobs.json). Output: `~/CapCut Desk/YYYY-MM-DD/<job name> <n>.mp4`.

## Engine sequence (proven)
1. `start_stdraft_session {platform:'desktop'}` -> session id (once per app run; reuse).
2. `capcut_estimate_generation_credits {media_type:'video', parameters:{prompt,model,resolution,ratio,count,duration_ms}, reference_assets:[]}` -> `estimated_credits`, `insufficient_credits`.
3. `capcut_video_generate {draft_session_id, spec, platform:'desktop'}` -> `code: CONFIRMATION_REQUIRED`, `generate_id`, `unique_key`, `confirmation_card.input.credits_amount`.
4. Same call again + `generate_id`, `unique_key`, `confirmed:true` -> `task_id`, `status: queued`.
5. `capcut_generation_poll {task_id, platform:'desktop'}` every `next_poll_after_ms` (floor 5 s) until `succeeded`/failed -> `resources[].url`, `actual_credits`.
6. Download each `resources[].url` straight away (links expire).
Models: seedance2.5 (480p/720p/1080p, 4-30 s), seedance2 (480p-4K, 4-15 s), seedance2_fast, seedance2_mini (480p/720p, 4-15 s), seedance1_fast (480p/720p, 2-12 s). Ratios: adaptive, 21:9, 16:9, 9:16, 4:3, 1:1, 3:4. Count 1-4.

## Features (v1)
- Connect: button opens CapCut's approval page; status shows the account nickname. Also a "approve on another
  device" path: show the link, accept the pasted 127.0.0.1 callback address (see `start`/`finish` in capcut.mjs).
  Disconnect button deletes the token.
- New job: prompt, model, resolution, ratio, duration, count, name. Live quote under the form. Model limits
  enforced in the form from one table.
- Batch: paste many prompts (one per line) with shared settings -> one job each; show the total quote before queuing.
- Queue: runs one job at a time (ponytail: sequential; parallel only if throughput becomes a real problem).
  States: queued, running, needs_approval, done, failed, cancelled. Cancel uses `capcut_generation_cancel`.
  Survives restart: jobs with a `task_id` resume polling, never resubmit.
- Gallery: finished clips newest first, playable, with prompt, settings, credits charged, "open folder",
  "queue again". Running total of credits used. There is no balance action in the connector, so show credits
  used and the `insufficient_credits` flag from the quote, not a balance.
- CLI + SKILL.md so Claude/Codex can queue jobs and read results through the running app.
- `DRY=1` starts the app on the fake engine with a visible "DRY MODE — nothing is charged" banner.

## Not in v1 (say so in the README, do not build)
- Reference images/video/audio (needs `capcut_asset_upload_credential` + CapCut's uploader; next version).
- Images, several accounts, packaging into a Mac/Windows installer, licence keys.

## Done means
1. `node --test app/` passes, covering: confirm reuses generate_id + unique_key; restart with a task_id polls
   and does not resubmit; charge above the approved ceiling stops as needs_approval; failed job keeps its error.
2. `DRY=1 node app/server.mjs` serves the UI; a batch of 3 jobs goes queued -> done and shows in the gallery
   (verify by HTTP calls to the API, report the JSON).
3. Against the live connector: profile nickname and one quote come back through the app's own API
   (the token already exists at `../.capcut-token.json`; copy it to the data dir for the test). No generation.
Report: files written, test output, the three checks with evidence, and anything that did not work.
