---
name: capcut-upload
description: Upload local videos, audio, and images to CapCut with an authorized upload ticket and the bundled uploader, returning reusable media IDs.
---

# Upload Media to CapCut

Upload local videos, audio files, or images in one mixed batch. Return a public-ready video/audio `vid` or image `uri` for each successful item.

## Execution Boundary

- Use only the plugin MCP upload authorization tool and bundled local uploader for this workflow.
- Do not launch or control the CapCut desktop app, open or navigate the CapCut website, use Computer Use, use an in-app or system browser, or run shell commands that launch those interfaces for upload. This applies even when CapCut is installed, already open, or signed in.
- The only permitted automatic browser opening is an OAuth flow explicitly initiated by the sibling `mcp-auth` skill. If the upload credential tool remains unavailable after native discovery and account authorization is confirmed, execute `mcp-auth` New-Task Handoff without waiting for a separate request to fork: fork this task, send the original upload request and completed media IDs, and open the fork. Report a blocker only after the host handoff tools have actually been discovered and attempted; never switch to a desktop or web interface.

## Upload Workflow

Load and follow [references/codex-local.md](references/codex-local.md) for the complete batch. Every source must have a readable local path, and the tool whose name ends with `capcut_asset_upload_credential` must be available.

If the credential tool is unavailable after one correct discovery attempt, follow the sibling `mcp-auth` skill to check account authorization. If login is needed, complete its recovery and retry native discovery once. If the account is connected and the tool remains unavailable here, follow New-Task Handoff before uploading bytes. Carry the original file paths and goal, confirm that the new task can read those paths, and preserve completed VIDs or image URIs so they are not uploaded twice. If a source has no readable local path, report that local file access is required; do not fabricate another upload route.

## Invariants

- Preserve input order and upload mixed video/audio/image inputs in one batch.
- Treat video or audio as successful only when it has a non-empty `vid` and `setPublic.success:true`.
- Treat an image as successful only when it has a non-empty `uri`.
- Preserve successful identifiers from partial failures and never re-upload an item that already has a `vid`, `uri`, or `uploadSuccess:true`.
- Use the uploader's private result file and verify every file-to-identifier mapping from it; terminal progress and summary output are not the source of truth.
- Delete the private result file and temporary directory after their identifiers and failure states have been passed to the next operation or prepared for the final response; keep them only while recovery is needed.
- Request `version:2` and pass only the exact `upload_ticket` to the uploader; never truncate, reconstruct, or repair a ticket. Full credentials are fetched by the script and must not pass through the model.
- Never request or expose cookies, OAuth bearer tokens, permanent credentials, raw headers, signing material, or complete short-lived upload sessions.
- If the Codex MCP connector reports HTTP transport status 502 without a tool result, load and follow the sibling `mcp-auth` skill's HTTP 502 handling before any retry or OAuth action. Do not apply that branch to a tool result or `isError` message that merely mentions 502, or to uploader/finalize script failures.
- If an upload tool returns an authentication error in Codex, stop retrying it and follow the sibling `mcp-auth` skill before resuming the upload.
- After an upload MCP tool succeeds, treat every bundled uploader or finalize script failure as a script-stage failure. Do not follow `mcp-auth` or run `codex mcp login`, including when the script reports an authorization-like status.

## Result Contract

### Prefill the first generation card

When a new image/video-generation request already includes reference attachments, upload them before rendering its first parameter card, even if the prompt is empty. Reuse successful uploads, preserve attachment order, and pass each image URI or public video/audio VID with its original base `file_name`. Include all known generation settings from the request and omit unknown settings for defaults. Use `role:"reference"` unless the user explicitly assigned an image as a first or last frame. Report failed files before rendering while retaining successful references. Render one card for the batch without `resume_from`, then end the turn without assistant text. An existing attachment does not need another “Add references in chat” round trip.

### Show a new card after chat uploads

An “Add references in chat” follow-up carries `generation_card` in its structured model context: `card_id`, `state_capability`, and the reserved next `version`. Use that exact binding, not whichever card was rendered most recently. If the user has not attached files yet, ask them to attach files in chat and wait. Adding references is optional; it is not approval to generate.

The follow-up also carries `reference_requirements` for the selected model and mode. Before uploading, compare available local media types, counts and video/audio durations with these requirements (use local media metadata inspection when available). Point out incompatible files immediately; do not wait for a generation confirmation. Do not silently trim files, drop references, or change models. If files have already been uploaded, preserve their identifiers and show the replacement card so the user can remove them or switch models; its inline validation runs before confirmation.

After the upload batch finishes, call `capcut_get_generation_card` with the binding. If `submitted` is true or `latest_version` is greater than the requested version, do not resume the old request. A lower returned version means its snapshot is not visible yet; retry the same read, never substitute an older snapshot or create an unrelated card.

Append successful image URIs and public video/audio VIDs to the snapshot's ordered `reference_assets`, avoiding duplicates and preserving existing roles and `file_name` values. Include each upload's original base file name (with extension) as `file_name` in parameter-card references, including when opening the first card; take it from the uploader's `file` path, never from the URI/VID. The card shows image thumbnails or video/audio icons alongside these names. `file_name` is card metadata only: omit it from direct image/video generation specs. Use `role:"reference"` for new items unless the user explicitly assigned an image as `first_frame` or `last_frame`. Call `prepare_for_image_generation` or `prepare_for_video_generation` according to the saved `media_type`, with only `resume_from` set to the exact binding and `reference_assets` set to the complete updated list. The renderer restores the saved prompt and model settings; do not reconstruct or override them.

Report failed items before rendering and retain successful identifiers so a retry does not upload them again. Render exactly one replacement card after the batch, then end the turn without assistant text, including upload confirmations or instructions to click Generate. The old form stays retired; do not update it or start generation. If the user cancels adding references, render the reserved next version with the snapshot's existing references unchanged. If the exact binding is unavailable, ask which request to continue rather than guessing.

For standalone uploads only, return reusable identifiers together with concise per-file success or failure status. When an upload continues image/video generation, retain identifiers internally and use the single parameter card as the complete response. For VOD finalize failures, preserve the Vid and report the `set_public` stage; do not upload the bytes again.
