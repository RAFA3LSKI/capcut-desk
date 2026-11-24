---
name: install-capcut-plugin
description: Install or update the CapCut Codex plugin on macOS or Windows, then complete authorization and first use.
metadata:
  plugin-version: "0.2.9"
---

# Install CapCut Plugin

## Execution Contract

- Read this entire file before taking action, then perform the installation instead of summarizing the instructions or only returning commands.
- When the user explicitly substitutes this repository's plugin for the CDN bundle, use that source for the acquisition/staging steps and retain this runbook's installation, authorization, **First Use**, and **Finish** requirements. A generic skill installer does not replace these later phases.
- Treat this document as a standalone runbook fetched by the user's bootstrap prompt. Do not install or persist it; if a local copy is required for reading, keep it only in the unique temporary directory used for this run. Do not look for sibling scripts, references, or metadata.
- Use only the plugin bundle URL embedded below as the default plugin source. When the user explicitly names this repository's plugin as the source, use that exact local source for acquisition and staging; do not discover or substitute another build.
- Request approval for network access, writes outside the workspace, removal of the old installation, and browser launch when required.
- Preserve the current working installation until the replacement bundle has been downloaded, extracted, and staged successfully.
- Run the read-only **Existing Installation Check** before downloading. Do not run any `codex plugin` mutation command until every step under **Prepare** succeeds.
- Use the language of the user's installation request for every user-facing update, approval request, error summary, and final instruction. If the request mixes languages, use the language of the user's latest message. Do not default to English because this runbook is written in English. Keep commands, identifiers, paths, versions, URLs, and safe verbatim CLI errors unchanged.
- Treat plugin installation, OAuth authorization, and first use as separate phases. Installation ends when **Existing Installation Check** accepts the current installation or verification in step 8 under **Replace and Install** succeeds. From that point onward, always describe the plugin as installed even when authorization or first use remains pending.
- Record the exact installed plugin ID before replacement and retain it through the authorization phase. The current bundle installs as `capcut@CapCut`. An older bundle may be registered as `CapCut@CapCut` under the same marketplace key.
- Keep every downloaded file, extracted file, generated helper, and log for this run inside one unique operating-system temporary directory. The only installer artifacts outside it may be the sibling staging directory and managed-directory backup explicitly described below. Never create installer artifacts in the current working directory or user workspace.
- Execute the workflow with short host-native commands instead of designing a reusable or general-purpose installer program. Do not create ZIP inspection or validation helpers. Do not edit, test, or refactor installer code in the user's workspace.

## Published Version

`metadata.plugin-version` is the semantic version of the plugin distributed by the bundle below, not the ZIP filename revision. Keep it equal to `codex/.codex-plugin/plugin.json` in that bundle when publishing both artifacts. Version checks may read this metadata without executing this installation runbook. An upgrade discovered during MCP login recovery requires the user's explicit agreement before starting **Prepare** or changing the installation.

## Bundle Source

Download this bundle without asking the user for another URL:

```text
https://sf16-sg.tiktokcdn.com/obj/eden-sg/962370eh7nupenuhbo/capcut_codex_plugin/plugins_v29.zip
```

## Platform Setup

Confirm this task runs on the same local machine as Codex Desktop. A web or isolated remote task cannot install into the user's desktop Codex data directory; in that case, give the user a short prompt to paste into a desktop task and stop before running install commands. Then detect the host OS.

- On macOS, use the native zsh/bash environment.
- On Windows, use native PowerShell on the same Windows host as Codex Desktop, not WSL. Prefer PowerShell 7 while remaining compatible with Windows PowerShell 5.1. Pass values as arguments, use `-LiteralPath` for filesystem operations, avoid shell aliases, `Invoke-Expression`, and `&&`, and check `$LASTEXITCODE` after every Codex CLI command.
- Treat the download URL as an opaque argument so query characters, spaces, or PowerShell metacharacters are never evaluated as code.
- If a native Codex CLI belonging to the active Codex host cannot be found, stop and report that prerequisite instead of installing another CLI or changing configuration in a different host environment.

| Operation | macOS | Windows PowerShell |
| --- | --- | --- |
| Temporary directory | `mktemp -d` | Create a GUID-named directory below `[IO.Path]::GetTempPath()` |
| Download | `curl -fL --proto '=https' --proto-redir '=https'` | `Invoke-WebRequest`; add `-UseBasicParsing` only on Windows PowerShell 5.1 |
| Extract | Use `ditto -x -k` or `unzip` directly | Use `Expand-Archive` directly |
| Find Codex CLI | Prefer the executable bundled with the active desktop app, including `/Applications/ChatGPT.app/Contents/Resources/codex` or `/Applications/Codex.app/Contents/Resources/codex`; otherwise use `command -v codex` | Prefer the executable bundled with the active Codex desktop host when exposed; otherwise use `Get-Command codex` in native PowerShell |

Resolve one absolute CLI path as `<codex-cli>` before changing anything and use that exact executable for every plugin and MCP command in this run; never switch later to a bare PATH-resolved `codex`. Prefer the active desktop app's bundled CLI so its version matches the host. If only a PATH CLI is available, confirm that it belongs to the same native host; never use a WSL CLI for a Windows-hosted app. If this cannot be established, stop instead of installing with an ambiguous CLI.

Resolve the absolute Codex data directory from the existing `CODEX_HOME` value, falling back to the current user's `.codex` directory on the same host. Never overwrite `HOME`, `USERPROFILE`, or `CODEX_HOME`. Use `<codex-data>/plugin-marketplaces/CapCut` as the installer-managed marketplace directory. In every command below, replace `codex` with the resolved `<codex-cli>` absolute path.

## Local Execution Permissions

Before each local command, compare its required access with the current sandbox policy. Download commands need outbound HTTPS; staging, replacement, rollback, and plugin CLI mutations need writes under `<codex-data>`. The login helper starts a child Codex App Server, which needs writable SQLite state under `<codex-data>`, host credential-store access, outbound HTTPS, and a local callback listener. Check that the helper and an in-app browser tool are available before logging out an existing account session.

When the sandbox restricts the command's required access, use the execution tool's supported approval mechanism to run that command outside the sandbox on its first attempt. For tools exposing `sandbox_permissions`, use `require_escalated` with a specific justification; for login, apply it to the whole Node.js helper command so the child inherits the required access. Do not deliberately run in a known-incompatible sandbox first. Keep approval scoped to the exact command, never a blanket shell or CLI prefix.

If the session already has unrestricted access, run normally without escalation parameters. If the current policy prohibits approval requests (for example, `approval_policy=never`), do not request escalation; use existing permissions only. When those permissions are insufficient or approval is unavailable or denied, stop the affected phase and report the required access, preserving completed installation status. Do not use `sudo`, change home directories, rewrite sandbox settings, or add bypass flags to the child CLI.

A SQLite state initialization error with `Operation not permitted` or `Permission denied` is a local startup/access failure, not a CapCut OAuth rejection. The helper suppresses raw CLI output; a generic early exit alone does not establish a sandbox cause. Unexpected explicit permission failures during login follow Authenticate step 9; inspect the current registration state before resuming an interrupted installation mutation, rather than blindly replaying it.

## Existing Installation Check

Before any download or replacement, run `codex plugin list --marketplace CapCut --available --json` and `codex mcp get capcut_creation --json` with the selected absolute CLI. Record `was-already-installed` and the prior ID from the installed `capcut@CapCut` or legacy `CapCut@CapCut` entry. If `capcut@CapCut` is installed and enabled at `metadata.plugin-version`, its marketplace and plugin sources resolve to `<codex-data>/plugin-marketplaces/CapCut` and its `codex` child, `capcut_creation` is enabled at `https://www.capcut.com/api/external_mcp`, and both `codex/skills/mcp-auth/scripts/capcut-login.mjs` and `codex/skills/mcp-auth/scripts/check-connection.mjs` are regular files under the managed marketplace path, mark installation complete and skip **Prepare** and **Replace and Install**. Continue to **Authenticate** only when account authorization is actually needed. A missing or disabled plugin, different version, unexpected source, missing helper, or incomplete MCP registration does not qualify; continue with the replacement workflow and its rollback protections. An explicit missing MCP server is an incomplete registration, not an inventory failure. If an inventory command instead fails from a transient execution error, retry that read-only command once. If any error still leaves the current state undetermined, stop without downloading or mutating the existing installation and report the safe error.

## Prepare

1. Download the archive into the new temporary directory. Require redirects and the final response to remain on HTTPS. On a timeout, connection reset, transient DNS or TLS connection failure, or HTTP 429/5xx, retry the download up to two times with a short delay, replacing the incomplete temporary file each time. Do not retry certificate-validation or other HTTP errors. If download still fails, leave the current installation unchanged and report the network failure. Do not execute scripts or binaries from the archive.
2. Extract the archive directly into the unique temporary directory without inspecting archive entries, paths, sizes, links, hashes, signatures, or manifest contents.
3. Locate `.agents/plugins/marketplace.json`, allowing outer wrapper directories, and treat the directory containing `.agents` as the extracted marketplace root. If it cannot be found, report that the bundle layout is unusable and leave the current installation unchanged.
4. Copy that extracted root, including hidden files, to a new sibling staging directory below `<codex-data>/plugin-marketplaces`. Keep the current installation untouched through this step.

## Replace and Install

1. Inspect the installer-owned registration with `codex plugin list --marketplace CapCut --available --json`, and record whether `capcut@CapCut` or legacy `CapCut@CapCut` is installed as `was-already-installed`. Retain the exact installed ID as `<prior-plugin-id>` for removal and rollback. The `name` values from `codex plugin marketplace list --json` are manifest display identities and may repeat across differently keyed registrations; never stop merely because multiple rows display `CapCut`.
2. Classify the exact configured key `CapCut` as one of these states, comparing normalized absolute paths with host-appropriate case semantics:
   - **Managed:** Its `marketplaceSource.source` is `<codex-data>/plugin-marketplaces/CapCut` and its local plugin source is `<codex-data>/plugin-marketplaces/CapCut/codex`.
   - **Migratable local:** Its marketplace source is an existing local directory outside the managed path and the local source for the current or legacy plugin ID is inside that directory. Record that source exactly for rollback. This includes an older development or test registration using the key `CapCut`.
   - **Absent:** No configured key `CapCut` resolves.
   Stop before changing anything for a malformed entry, a non-local foreign source, multiple matching installed entries under the `CapCut` marketplace key, or paths that do not fit either accepted state.
3. Ignore and preserve every registration under a different configured key, even when its manifest also displays `CapCut`. Never remove, rename, edit, or copy from those sources.
4. Allow installation to replace an existing managed-path directory even when the exact key `CapCut` is absent or points to a migratable local source. Do not stop merely because that directory already exists. Before changing any registration, if the managed path exists, require it to be a normal directory, refuse symlinks or Windows reparse points, and rename it to a unique sibling backup. Preserve sources registered under other keys as required by step 3. Then handle the recorded registration state without removing the installed plugin yet:
   - **Managed:** Keep the existing marketplace registration, then rename the staging directory to `CapCut`.
   - **Migratable local:** Run `codex plugin marketplace remove CapCut --json` for that exact configured key and require success with the returned marketplace name exactly `CapCut`; then re-query the exact key and require that it no longer resolves. This unregisters the old source; never delete, rename, or modify the external source directory itself. Then rename the staging directory to `CapCut`.
   - **Absent:** Rename the staging directory to `CapCut`.
5. Run with the absolute persistent path, never the temporary extraction path. For **Migratable local** or **Absent**, run:

   ```text
   codex plugin marketplace add <codex-data>/plugin-marketplaces/CapCut --json
   ```

   Require success with the returned marketplace name exactly `CapCut`. For **Managed**, do not run marketplace add or remove. Re-query with `codex plugin list --marketplace CapCut --available --json` and require exactly one `capcut@CapCut` whose marketplace and plugin sources are the two managed paths before proceeding.
6. Only after the managed marketplace is ready, run `codex plugin remove <prior-plugin-id> --json` when `was-already-installed` is true. This supported command removes its configuration and cache. Never clear the whole plugin cache, remove same-named plugins from other marketplace keys, or use wildcard deletion. Then always run:

   ```text
   codex plugin add capcut@CapCut --json
   ```

7. Record the version returned by `codex plugin add` and require it to equal this document's `metadata.plugin-version`. A mismatch means the document and bundle were published inconsistently; treat it as verification failure and apply step 9.
8. Confirm from `codex plugin list --marketplace CapCut --available --json` that `capcut@CapCut` is installed, enabled, has the recorded version, and resolves to the two managed paths. Run `codex mcp get capcut_creation --json` and require `enabled` to be `true` and the transport URL to be exactly `https://www.capcut.com/api/external_mcp`. Require `codex/skills/mcp-auth/scripts/capcut-login.mjs` and `codex/skills/mcp-auth/scripts/check-connection.mjs` under the managed marketplace path to be regular files before discarding the backup. Do not parse human-readable CLI output or add a duplicate MCP server manually.

9. Track separately whether the managed directory was backed up, the staged replacement was moved into place, the old registration was removed, the new registration was created, and the old plugin was removed. If replacement or verification fails, remove only an incomplete new `capcut@CapCut`. Remove the new `CapCut` marketplace registration only when this run created it and a fresh scoped query confirms it points to the managed path. Move only this run's replacement managed directory and sibling staging directory back into this run's temporary area before restoring prior state, unless the supported marketplace removal already removed that exact managed directory. In every registration state, restore the original managed-path directory when this run backed it up. For **Managed**, keep its original registration. For **Migratable local**, re-add the exact recorded external source only when the old registration was successfully removed and the exact key is currently absent; never modify that external directory. For **Absent**, leave the exact key absent even when its original directory was restored. Reinstall the exact `<prior-plugin-id>` only when `was-already-installed` is true, the old plugin was actually removed, and its original registration has been restored. If failure occurred before old-plugin removal, preserve the existing plugin configuration and cache instead of reinstalling it. Report any rollback failure explicitly, retain any unrestored backup, and never alter registrations under other keys. Remove a managed backup only after the new plugin passes verification.

## Present Capabilities

Immediately after installation is confirmed, tell the user in their language that CapCut version `metadata.plugin-version` is installed and that account connection is being checked. Keep this progress update brief. If authorization is needed, say its page will open in Codex's in-app browser and credentials remain there. Save capability examples for **First Use**, after connection is confirmed.

## Authenticate

1. Check the account connection before opening OAuth. If an account-bound `capcut_creation` tool has already succeeded in this task, reuse that result. If the user's original request includes an available, read-only CapCut material search, run that requested search now and use its result as the connection check and first-use result. Otherwise discover `search_capcut_material` by exact name once and, if available, call it once with `type=font`, `prompt=font`, and `top_n=1`. Never start a paid generation or mutate a draft merely to test the connection. A successful protected tool result proves that the existing account connection works. Tool visibility, `codex mcp get`, and `codex mcp list` auth status alone do not prove authorization. If the lookup returns an explicit MCP authentication error, continue to step 2. If the host reports transport HTTP 502 or Bad Gateway without an MCP tool result, report the service as temporarily unavailable and do not start OAuth.

   If the protected tool is absent or its lookup failed for a reason other than MCP authentication, do not stop at installation verification or defer the authorization check merely because `was-already-installed` is true. Resolve native Node.js and run the installed `<codex-data>/plugin-marketplaces/CapCut/codex/skills/mcp-auth/scripts/check-connection.mjs --codex-cli <codex-cli>` under **Local Execution Permissions**. This read-only helper asks Codex App Server for `capcut_creation` connection status without starting OAuth or reading credentials. `status=connected` means the host reports both `runtimeStatus=connected` and `authStatus=oAuth`; report any separate lookup error and continue to **First Use**. This does not override an explicit MCP authentication error from a protected tool. `status=login_required` continues to step 2.

   For `status=unknown`, a missing helper in an older installed bundle, or a failed status check, keep authorization unverified. If no successful protected call is available, discover `capcut_get_profile` once and call it with empty arguments when available, unless this check already failed in the current diagnosis. Success continues to **First Use**; an explicit MCP authentication error continues to step 2. If the tool is unavailable or fails for another reason, report that installation is complete but authorization could not be verified, include the safe check failure and remaining verification step, and stop authentication recovery. Do not start login, logout, reinstall, or handoff as an authenticated account solely because a check was inconclusive. An explicit user request to sign in may continue to step 2 independently of an unknown check result; installation alone is not evidence that an existing session needs renewed authorization. Preserve the original task and existing session.

2. Never log in to or otherwise attach OAuth to `capcut_creation_resource`; it is identity-free.
3. Before starting login, locate `<codex-data>/plugin-marketplaces/CapCut/codex/skills/mcp-auth/scripts/capcut-login.mjs`, resolve a native Node.js runtime, and confirm that an in-app browser tool is available. If a prerequisite is missing, preserve the existing session and report authorization as unverified or incomplete according to the evidence. Clear `capcut_creation` with `codex mcp logout capcut_creation` only when an explicit invalid or expired refresh-token error requires it. Tell the user that installation is complete and authorization will open in Codex's in-app browser.
4. Run the installed helper under **Local Execution Permissions** with the same absolute CLI selected during **Platform Setup**:

   ```text
   node <codex-data>/plugin-marketplaces/CapCut/codex/skills/mcp-auth/scripts/capcut-login.mjs --codex-cli <codex-cli>
   ```

   Use a persistent shell execution session and a short initial wait. The helper starts `codex app-server` and requests `mcpServer/oauth/login`; Codex owns callback handling, PKCE, and credential storage without opening a system browser. Do not run `codex mcp login capcut_creation` or use `BROWSER` overrides. When `event=authorization_required` arrives, pass the exact `authorization_url` to `mcp__codex_app__open_in_codex` with `target={"type":"browser","url":<authorization_url>}`. If only Computer Use is available, use `cua.createBrowserTab("iab", authorization_url, { visible: true })` under that tool's current instructions. Leave login and consent to the user. If opening the in-app browser fails, stop the helper and report authorization as incomplete; do not switch to a system browser. A user report or screenshot of `invalid_request` / `unknown client` or a refused local callback triggers step 7.
5. Keep this task active and poll the same running helper with waits of at most 60 seconds, without starting another login. Do not end the turn with “finish login and tell me” while the helper is active; its App Server owns the local callback listener. Treat a poll with no new output or a polling-tool timeout only as authorization still pending. Silence is not evidence that the page is ready for login, nor of slow or failed installation, browser-opening failure, OAuth cancellation, or OAuth timeout. Every progress update during this wait must explicitly say that installation is complete and only browser authorization is pending. Never describe this phase as installation. If the user cancels, interrupt this helper to stop its App Server and callback listener.
6. Never construct, modify, or display an authorization URL as a chat link. Pass only the exact URL emitted by the helper to the in-app browser. A browser page opening does not prove authorization succeeded.
7. Never request or expose cookies, tokens, authorization codes, browser storage, or raw headers.
   If the in-app browser shows `ERR_CONNECTION_REFUSED` on the `127.0.0.1` or `localhost` OAuth callback page, read **Local Callback Connection Refused** in the installed `<codex-data>/plugin-marketplaces/CapCut/codex/skills/mcp-auth/SKILL.md` and apply it: check for an already successful helper result; otherwise stop the old helper and automatically retry once with a new helper, opening only the new URL it emits. Do not reload or reuse the callback URL, repeat installation, or ask the user to trigger the retry. If it fails again, stop and report authorization as incomplete. This is an exception to the generic no-retry rule below.
   If the CapCut authorization page reports `invalid_request` / `unknown client`, read **Unknown Client on the Authorization Page** in the installed `<codex-data>/plugin-marketplaces/CapCut/codex/skills/mcp-auth/SKILL.md` and apply that branch: stop this helper, guide the user to sign out in the in-app browser and log back in with a region-matching account, then retry authorization once with a new helper URL. Tell the user that a US exit IP requires a US-registered CapCut account, while a non-US exit IP requires a non-US-registered account. Do not presume a server fault or send the user only to plugin settings. This is an exception to the generic no-retry rule below. Keep installation marked complete, do not restart installation or the version check, and return to this runbook's completion/failure handling afterward.
8. Report authentication as successful only when the helper emits `event=completed` with `success=true` for `capcut_creation` and exits with code 0. This event reflects Codex's matching `mcpServer/oauthLogin/completed` notification. Do not infer cancellation or OAuth timeout from silence or a polling-tool timeout. Report authorization as pending only while the same helper's execution session is confirmed alive; if the helper has exited without success, report it as incomplete and handle the safe error under step 9.
9. If the login invocation definitively fails after plugin verification succeeded:
   - If that same login process's safe error explicitly identifies HTTP 502 or Bad Gateway from the MCP endpoint, do not retry it. Retain the original safe 502 error and continue with the unresolved-failure handling below.
   - For an unexpected permission failure only: when the first invocation has definitively failed, either because the execution tool rejected it before launch or because the process exited, its error explicitly identifies a local sandbox or network-permission denial, and that invocation did not use the required permission, follow **Local Execution Permissions** to rerun the exact same command outside the sandbox once when policy permits. Poll that retried process under step 5's rules. Do not use this retry for DNS, TLS, timeout, HTTP, remote-service, or OAuth protocol or configuration failures, or a generic CLI early exit.
   - If approval is prohibited, unavailable or denied, or the single retry still fails, retain the specific safe error and stop further authorization attempts. Do not retry again, change endpoints, reinstall the plugin, or inspect credentials.
   - For any other definitive invocation failure, do not retry login or reinstall the plugin in this task. Retain the exact safe error and stop further authorization attempts; do not treat a local sandbox or network-permission denial as an OAuth configuration failure.
   - In every unresolved failure case, state that the plugin remains installed and mark authorization as incomplete. Give the user the exact remaining authorization step and a ready-to-send recovery prompt; the next task should check `capcut_creation` and finish only its authorization if needed, never reinstall. Never log in to `capcut_creation_resource`.

## First Use

After authorization is confirmed, discover the tool needed for the user's original CapCut request once and continue that request in this task; reuse any requested read-only search already completed during the connection check. If an existing plugin only needed renewed authorization after token expiry, resume the original request in this task first; do not create a draft or switch to an introduction. For a newly installed plugin with no more specific CapCut goal, the first-use result is a concrete introduction with examples of template search, video editing, automatic captions, and image/video generation, followed by a question about what the user wants to make. Merely listing capability names as an installation status is not the introduction. If native tools are unavailable, fork this task, send the follow-up prompt requesting the introduction, then open the fork. If the fork or follow-up fails, give the introduction here and the exact prompt to send; do not omit either. Do not create a draft, upload assets, or initiate paid generation solely for onboarding.

Do not finish this installation task immediately after OAuth succeeds when its native CapCut catalog is stale. Complete the current-task tool attempt and, when needed, the fresh-task handoff before reporting **First use**. Do not defer this step by telling the user to ask again in the same stale task. If a later message in this installation task supplies the first specific CapCut goal, follow the same current-task attempt and handoff path with that goal.

If the required protected tool remains unavailable after one correct discovery attempt, use the installed `mcp-auth` skill to distinguish a login problem from a stale task tool list. When authorization is confirmed, follow **New-Task Handoff** directly. Do not redownload the same bundle or redo OAuth to fix a stale tool list.

For handoff after authorization is confirmed, prepare a prompt preserving the user's original CapCut goal, relevant asset references, confirmed authorization state, and any completed task IDs or card bindings. For new-install onboarding without a specific goal, ask the next task to introduce the plugin's main functions and ask what the user wants to make; do not ask it to create or open an empty draft. Do not claim a tool call succeeded unless its result proves it. Follow **New-Task Handoff** in the installed `mcp-auth` skill: **you MUST discover `fork_thread`, fork this task in the same directory without a source thread ID, send the continuation prompt to the returned child with `send_message_to_thread`, and open it with `navigate_to_codex_page`.** Do not wait for a separate handoff confirmation or require the latest user message to mention forking; start the host-tool sequence as soon as the handoff condition is met. Earlier direct instructions to send and open the fork remain effective after installation and login. If forking definitively fails before creating a child, explain the failed step, then give the complete continuation prompt and tell the user to create a new Codex chat and send it. If a child already exists, recover or direct the user to that child instead of creating a duplicate. A stale tool list is a task-loading issue, not an installation or OAuth failure.

Compose the follow-up message as a real user request in the user's language, not an internal status dump. With an original goal, begin with that goal, then say CapCut installation and authorization status, what was completed, any stable IDs to resume, and the exact next step; instruct the fork to avoid duplicate submissions. With no goal, ask it to introduce template search, video editing, automatic captions, and image/video generation with concrete examples, then ask what the user wants to create. In both cases, say that no empty draft should be created solely because installation finished. This message must be present in the fork before reporting handoff success.

## Finish

Clean up the unique temporary directory for this run and any successful-install backup, including on early failure.

Report three separate statuses:

- **Plugin installation:** Report whether installation completed and include the installed version when successful.
- **CapCut authorization:** Report `complete`, `unverified`, `pending`, or `incomplete`, with a concise safe reason when it is not complete.
- **First use:** When authorization is confirmed, report whether the user's original request continued here, this task was forked and the follow-up prompt was sent and opened, or forking failed and the complete prompt was provided with instructions to create a new Codex chat and send it. For a new installation without a creative goal, include the concrete capability introduction and ask the user's next goal in the fork or, when forking failed, in this reply. Otherwise report first use as not started. Do not call setup fully usable until a protected tool succeeded in this task or the fork confirmed it.

Follow **First Use** only after authorization is confirmed. If authorization remains unverified, report that installation is complete, explain the safe check failure and remaining verification step, and end the automatic recovery without login, logout, reinstall, or automatic handoff. For pending or incomplete authorization, follow **Authenticate** waiting or failure handling and provide the remaining step and any safe error; do not enter **First Use**.
