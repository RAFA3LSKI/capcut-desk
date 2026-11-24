# Codex Local Upload

Use this workflow only when the tool whose name ends with `capcut_asset_upload_credential` is available, every source has a readable local path, and Node.js 18 or newer is available.

`SKILL_ROOT` is the directory containing the parent `SKILL.md`. The bundled uploader is `<SKILL_ROOT>/scripts/capcut-upload.mjs` and uses Node.js built-ins only.

## Security Model

- Call `capcut_asset_upload_credential` with `version:2` to authorize this batch under the current OAuth identity. Retain `upload_ticket` and `expires_at`; do not request or reconstruct STS credentials.
- Pass only the exact short ticket through `--upload-ticket-stdin`. It is a bearer capability: never log it, persist it, or put it in command arguments. The script reads file metadata itself and exchanges the ticket at its fixed HTTPS endpoint.
- Credentials and mandatory video/audio finalize capabilities stay in script memory. Neither exchange retries nor repeated redemption extend the original expiry or issue new credentials.
- The server still returns legacy credentials when `version` is omitted or `1`. Legacy script inputs remain supported for older callers; this workflow always uses version 2. If a server ignores version 2 and returns credentials instead of a ticket, report a server/plugin version mismatch; do not forward that JSON to the script.

## Local File and Network Permissions

The uploader automatically reads only `x-tt-env` and `x-use-ppe` from this installed plugin's `.mcp.json` and forwards them only to the fixed CapCut credential and finalize endpoints, keeping script callbacks in the same lane as the tool. Do not manually copy headers or change the API path to work around a 404. These routing fields are never sent to VOD/ImageX upload hosts. Missing configuration preserves standalone production behavior; malformed configuration is an explicit script error.

The local uploader requires outbound HTTPS and read access to the selected source files, including files outside the workspace. It does not start Codex App Server or require writes to Codex state. Before collecting file metadata or starting upload/finalize, check the current execution policy for the required file and network access. When the sandbox restricts that access, use the execution tool's supported approval mechanism on the first attempt. For Codex shell tools that expose this option and permit escalation, set `sandbox_permissions` to `require_escalated` and provide a concise user-facing justification describing the selected files and upload.

If current permissions already suffice, including in an unrestricted session, run normally without escalation parameters. If approval requests are prohibited (for example, `approval_policy=never`), do not request escalation; stop the blocked local operation if existing access is insufficient. Do not run the uploader in a known-restricted sandbox merely to observe an expected failure. Keep any reusable approval prefix scoped to the native Node.js executable plus the absolute `capcut-upload.mjs` path, and never include the upload ticket or other sensitive arguments in the approval justification or prefix. If required escalation is unavailable or denied, report the missing file or network permission; do not change sandbox settings or trigger OAuth recovery. After an unexpected permission failure, apply **Interpret Results** before retrying so uploaded items are not submitted twice.

## Upload Workflow

1. Resolve each absolute path and collect its base file name and byte size.
2. Call `capcut_asset_upload_credential` once with metadata for the complete batch:

```json
{
  "version": 2,
  "files": [
    {"file_name": "clip.mp4", "size_bytes": 123456},
    {"file_name": "voice.mp3", "size_bytes": 34567},
    {"file_name": "cover.png", "size_bytes": 23456}
  ]
}
```

Do not send `client_id`, kind, extension, MIME type, user identity, or VOD space fields. Retain the returned `upload_ticket` unchanged; never shorten, repair, or regenerate it.

3. Create a fresh private temporary directory in a writable location and choose an unused absolute path inside it for the result file. Start the uploader once for the complete batch with a PTY and yield early so the shell tool returns a live session ID:

```bash
node "<SKILL_ROOT>/scripts/capcut-upload.mjs" \
  --files '[{"client_id":"video-1","file":"<ABSOLUTE_VIDEO_PATH>"},{"client_id":"audio-1","file":"<ABSOLUTE_AUDIO_PATH>"},{"client_id":"image-1","file":"<ABSOLUTE_IMAGE_PATH>"}]' \
  --upload-ticket-stdin \
  --json --result-file "<NEW_RESULT_FILE_ABSOLUTE_PATH>"
```

Set `tty:true`. Once the process is running, send only the exact `upload_ticket` string followed by `\n` through the shell session's stdin writer. Do not send JSON, quotes, or the complete tool response. The uploader disables TTY echo while reading.

The script creates the result file with mode `0600` before uploading. It refuses an existing path, so use a fresh path for each run, including retries. The terminal prints only `{success,result_file,result_count}`; the per-file identifiers and statuses are in the result file, without raw downstream responses. Read it programmatically and inspect `clientId`, `file`, `success`, `vid`/`uri`, `uploadSuccess`, `setPublic.success`, `stage`, and `error` in input order. Verify that the result count and file mapping match the requested batch before continuing. Do not paste the full JSON or long progress log into the model context. After passing the identifiers and failure states to the next operation or preparing them for the final response, delete the result file and its private temporary directory. If recovery is still needed, retain them only until recovery is complete, then delete them. If the file is missing, empty, or invalid, treat completed uploads as uncertain and do not automatically re-upload them.

Do not use `--upload-ticket` in Codex: command arguments can expose the capability in process listings or tool traces. Do not start a non-TTY command and write afterward; stdin may already be closed.

For one file, this form is also supported:

```bash
node "<SKILL_ROOT>/scripts/capcut-upload.mjs" \
  --file "<ABSOLUTE_PATH>" \
  --client-id "media-1" \
  --upload-ticket-stdin \
  --json --result-file "<NEW_RESULT_FILE_ABSOLUTE_PATH>"
```

The local `client_id` is only a result label. Do not pass individual credential fields or legacy credential options.

## Interpret Results

- Batch success: result file contains `{"success":true,"results":[...]}`, exit code `0`.
- Partial/total failure: result file contains `{"success":false,"results":[...]}`, exit code `1`; preserve successful identifiers.
- Invalid arguments/ticket/session: exit code `2`.
- A successful video requires upload success plus `setPublic.success:true`.

The result-file option does not change upload or finalize behavior. The legacy full stdout JSON remains available only when `--result-file` is omitted. A result-file write failure is an error even if uploads may have completed; inspect known identifiers before deciding whether any retry is safe.

Any nonzero uploader exit is local-script or downstream-upload failure, not evidence that the plugin MCP OAuth session failed. Do not run `codex mcp login` for script errors, including `InvalidAuthorization`, HTTP 401/403, expired upload credentials, or rejected finalize capabilities. Apply the retry rules below or report the failing script stage.

If video upload succeeds but finalize fails, preserve the Vid and retry only finalize while the same ticket remains valid:

```bash
node "<SKILL_ROOT>/scripts/capcut-upload.mjs" \
  --finalize-vid "<VID>" --file "<ORIGINAL_ABSOLUTE_PATH>" \
  --client-id "video-1" \
  --upload-ticket-stdin \
  --json --result-file "<NEW_RESULT_FILE_ABSOLUTE_PATH>"
```

Use the same PTY handoff and send the same still-valid ticket followed by `\n`. The original file supplies metadata for authorization only; its bytes are not uploaded again.
Finalize-only results contain the known `vid` and `clientId` but no `file` field. Verify those identifiers against the original upload result and require `setPublic.success:true` before treating the media as ready.

Never re-upload video or audio whose result contains `uploadSuccess:true` or a non-empty `vid`. If the ticket expires after upload, report that the VOD media could not be authorized and made public.

For partial batch failures, keep successful results and retry only entries with no resource identifier and no upload-success marker. The same valid ticket accepts a subset of the original batch, including duplicate-count checks. Network errors and transient exchange statuses are retried inside the script with a fixed bound. An invalid or expired ticket or file mismatch stops immediately; never guess a replacement ticket. For files not yet uploaded, collect current metadata and request a new version 2 ticket if needed. Do not invent or fall back to another upload route.
