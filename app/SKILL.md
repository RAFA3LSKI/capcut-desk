---
name: capcut-desk
description: Queue AI video generation in the user's running CapCut Desk app and read back the finished clips. Use when asked to make, generate or queue a video/clip with CapCut or Seedance.
---
CapCut Desk must be running (`node app/server.mjs`). Use `node app/cli.mjs` (alias `capcut-desk`):

- `add "<prompt>" ["<prompt 2>" ...] [--model seedance2_mini] [--res 720p] [--ratio 9:16] [--secs 5] [--count 1] [--name "..."] [--max N] [--ref file]... [--first img] [--last img]` queues one job per prompt. `--ref` (repeatable, image/video/audio) adds reference files to every prompt; `--first`/`--last` are keyframe images (cannot be mixed with `--ref`). Files are uploaded to CapCut first (no credits). Limits: seedance2.5 30 images/10 videos/10 audio; seedance2, _fast, _mini 9/3/3, 12 in total, audio needs an image or video; seedance1_fast keyframes only.
- `status [id]` shows the account, credits used and jobs. `list` shows jobs only.

Rules:
- Credits are real money for the user. Without `--max` the ceiling is the server's quote for one clip; a job that would cost more stops as `needs_approval` and only the user can approve it in the app. Never raise it yourself.
- Never re-add a job that already exists or is running; a duplicate is charged twice. Poll `status <id>` instead (every 10+ seconds).
- Models: seedance2.5 (480p-1080p, 4-30 s), seedance2 (480p-4K, 4-15 s), seedance2_fast and seedance2_mini (480p/720p, 4-15 s), seedance1_fast (480p/720p, 2-12 s). Ratios adaptive, 21:9, 16:9, 9:16, 4:3, 1:1, 3:4. Count 1-4. Cheapest: seedance2_mini.
- A finished job lists the file paths under `~/CapCut Desk/YYYY-MM-DD/`. Do not remove the "Ai" label or any provenance data from results.
