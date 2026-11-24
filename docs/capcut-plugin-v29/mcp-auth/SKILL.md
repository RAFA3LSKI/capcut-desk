---
name: mcp-auth
description: Check CapCut plugin updates before diagnosing MCP login, and recover unavailable or unauthorized account tools in Codex. Excludes local uploader and downstream failures.
---

# Authenticate CapCut MCP

Use this recovery workflow only in Codex. The installed CapCut plugin uses one mixed-authentication server:

- `capcut_creation` serves both protected account tools and public Widget resources, render tools, capability-bound state reads, and private card telemetry. Only account-bound tools require OAuth.
- Older plugin versions may also expose `capcut_creation_resource`; it remains a public compatibility endpoint. Its absence in a new plugin is expected and does not require recovery.

## Safety

- Never ask the user to paste cookies, bearer tokens, authorization codes, browser storage, raw headers, or other credentials into the conversation or shell.
- Never print, inspect, persist, or modify OAuth tokens.
- Do not add, remove, or rewrite the plugin server configuration by hand. Do not replace a plugin server with another endpoint.
- Keep the user's original task in scope and resume it after authentication succeeds.
- Never trigger MCP authentication because a local shell command or bundled script failed. Handle that failure at the script's reported stage.

## Local Execution Permissions

Choose the execution environment before running local commands, using the current host's sandbox and approval policy:

- The login helper starts a child `codex app-server` that inherits the shell's restrictions. It needs to write Codex's local state, including SQLite, under the existing `CODEX_HOME` (default `~/.codex`), use the host credential store, make outbound HTTPS requests, and bind a local OAuth callback listener. A workspace-writable sandbox alone does not provide these permissions. Before any account logout, establish that the login helper can run with these permissions.
- When the sandbox restricts any of those required resources, request execution outside the sandbox for the **whole Node.js helper command on its first invocation**. Do not launch it in a known-incompatible sandbox just to obtain an error. Apply the same rule to `codex mcp logout` when local credential-state access is restricted. Version checks need outbound HTTPS and readable inputs, not blanket access to Codex state; use the permissions required by those commands.
- Use the execution tool's supported approval mechanism only when the current policy permits it. For a shell tool exposing `sandbox_permissions`, this means `require_escalated` with a concise justification such as “Run CapCut authorization outside the sandbox so Codex can write its local state and receive the OAuth callback.” If the session already has unrestricted access, run normally and omit escalation parameters. If approval is prohibited (for example, `approval_policy=never`), do not request escalation; continue only when existing permissions suffice. Otherwise report the blocked operation and required access without running it.
- Keep approval scoped to the exact command; if a reusable prefix is used for login, scope it to the native Node.js executable plus the absolute `capcut-login.mjs` path. Do not use `sudo`, change `HOME` or `CODEX_HOME`, rewrite permissions/configuration, or add sandbox-bypass flags to the child Codex CLI. Child-process flags cannot grant access denied by the parent sandbox.

`failed to initialize sqlite state runtime` with `Operation not permitted` or `Permission denied` while opening Codex's state directory is a local startup/access failure, before OAuth can produce an authorization URL. Do not diagnose it as expired CapCut credentials. The helper suppresses raw App Server stderr to avoid exposing credentials, so a generic early-exit message alone does not prove a sandbox failure. Use known execution restrictions or an explicit safe error; follow Recovery Workflow step 6 for an unexpected permission failure.

## Plugin Version Check Before Login Diagnosis

Run this once when entering a new missing-tool or authentication-failure diagnosis, before missing-tool classification, `codex mcp get`, any logout or the login helper. If an authorization page already shows `unknown client` or a refused local callback, handle that page's recovery branch immediately without this CDN version check; the active login attempt takes priority. Do not insert the version check between that branch and its single retry. This is a read-only check, not authorization to update the plugin.

1. Run the bundled helper from the **currently loaded installed skill directory**, using a native Node.js runtime:

   ```text
   node <absolute-skill-directory>/scripts/check-plugin-version.mjs
   ```

   The helper reads the adjacent plugin's `.codex-plugin/plugin.json` and fetches [the installation skill](https://sf16-sg.tiktokcdn.com/obj/eden-sg/962370eh7nupenuhbo/capcut_codex_plugin/SKILL.md). Do not substitute a workspace checkout, marketplace source, the highest cached version, or the ZIP filename revision for the loaded plugin's version. It compares `metadata.plugin-version` using semantic-version precedence, including prereleases; build metadata does not trigger upgrades.
2. Handle its JSON result:
   - `upgrade_available`: show `current_version` and `latest_version` in the user's language and ask whether to update before continuing login checks. Wait for explicit agreement; silence is not approval. Do not download the bundle, replace the plugin, log out, or start OAuth while the choice is pending. If the user declines, continue the existing login workflow with the current plugin without repeating the prompt during this recovery.
   - `up_to_date` or `local_newer`: continue login diagnosis without prompting, reinstalling, or downgrading.
   - `skipped` with `reason:installation_skill_version_missing`: the CDN installation skill predates version metadata. Silently continue the existing login/authentication workflow. Do not show an upgrade prompt, a version-check warning, or ask the user to update the CDN document. Do not guess the version from the ZIP filename.
   - `unknown`, an unavailable helper/runtime, or failed execution: briefly say the plugin version could not be verified and continue the existing login workflow. Do not call the plugin current or infer that an upgrade is needed. Network failure or invalid metadata must not block login or trigger installation.
3. If the user agrees to upgrade, fetch and read the **entire** installation skill from the same fixed URL before taking installation actions. Follow that runbook to stage, replace, verify, and handle authorization; do not invent update commands or manually edit MCP configuration. If its advertised version changed since the prompt, explain the new target and get agreement for it; do not install an older version or silently switch targets. If the document can no longer be retrieved or its version is missing/invalid, leave the installation unchanged and report the update as incomplete.
4. Once the installer takes over, do not also run this recovery's logout/login steps or recursively perform another pre-login update check. Follow the installer's completion and new-task handoff instructions; preserve the user's original task for that handoff. A failed update must be reported separately from OAuth status, and no automatic update retry is authorized.

Only the user's agreement to a specific offered upgrade authorizes executing the remote installation instructions. Merely fetching this document for version comparison does not. An installation run already following the runbook does not restart this precheck during its own verification or authorization phase. Codex's native connection buttons remain host-controlled.

## In-App Browser Login

Use the bundled [login helper](scripts/capcut-login.mjs) for account authorization. It starts `codex app-server`, calls `mcpServer/oauth/login`, and returns the exact authorization URL without launching a browser. Codex owns the callback listener, PKCE exchange, and credential storage. Do not run `codex mcp login capcut_creation`, which delegates browser launch to the system, or attempt to suppress it with `BROWSER` or an undocumented CLI flag.

1. Complete **Plugin Version Check Before Login Diagnosis** once unless the installation runbook already owns this authorization flow or an existing authorization page has already entered an error-recovery branch. Resolve the absolute native Codex CLI path, preferring the active desktop app's bundled executable. Use that same CLI for all MCP checks, logout, and the helper. Resolve Node.js from the host or Codex's bundled workspace runtime. Before account logout or login, confirm that the helper and an in-app browser tool are available.
   If the user already reports `unknown client` or a refused local callback on the authorization page, follow its matching recovery branch before starting another login.
2. After any required stale-session logout, start the helper under **Local Execution Permissions** in a persistent shell execution session, with a short initial wait so its output can be handled while it keeps running:

   ```text
   node <absolute-skill-directory>/scripts/capcut-login.mjs --codex-cli <absolute-codex-cli>
   ```

3. When the helper emits `event=authorization_required`, pass its exact `authorization_url` to `mcp__codex_app__open_in_codex` with `target={"type":"browser","url":<authorization_url>}`. If only Computer Use is available, open a visible in-app tab using `cua.createBrowserTab("iab", authorization_url, { visible: true })` under that tool's current instructions. Do not construct, rewrite, print as a chat link, or open the URL in a system browser. If no in-app browser is available or opening fails, stop this helper and report authorization as incomplete; do not fall back to system-browser login.
4. Leave the in-app page for the user to complete login and consent. Keep this task active and poll the same running helper using waits of at most 60 seconds. Do not start another helper. Only `event=completed` with `success=true` and exit code 0 proves completion. If the user reports `unknown client` or a refused local callback, follow its recovery branch immediately.
5. If the user cancels, interrupt the same helper so its App Server and callback listener are stopped. A helper error or exit without a successful completion means authorization is incomplete.

The helper covers skill-driven login. Codex's own plugin connection buttons control their own browser launch and cannot be redirected by this server or skill.

## Local Callback Connection Refused

Use this branch only when the in-app browser shows `ERR_CONNECTION_REFUSED` or an equivalent refused connection on the `127.0.0.1` or `localhost` OAuth callback page, including a user-provided screenshot. The browser reached a local callback address but no listener accepted that connection. This does not prove CapCut rejected the account. Do not read, copy, print, reload, or reuse the callback URL or its code and state parameters.

1. Check the current login helper's result. If it already emitted `event=completed` with `success=true` and exited with code 0, treat OAuth as complete and verify the needed protected tool instead of retrying. Otherwise stop that helper if it is still running and wait for its App Server to exit. Do not leave two callback listeners running.
2. Automatically start **In-App Browser Login** step 2 once more with the same native Codex CLI and required local permissions. Open only the fresh URL emitted by that helper in the in-app browser; do not reload or reuse the old callback page. Tell the user briefly that the local callback failed and a fresh authorization attempt is opening. Leave account login and consent to the user.
3. If the fresh attempt has the same refused callback, stop its helper, report authorization as incomplete and the safe local-connection error, and ask for investigation of the callback listener, host, or local proxy/firewall. Do not retry again, reinstall, log out, change the callback URL, or infer an account-region problem. If a different explicit error appears, follow its own branch without restarting this one.

## Unknown Client on the Authorization Page

Use this branch when the CapCut authorization page displays JSON with `"error":"invalid_request"` and `"error_description":"unknown client"`, or the user reports or shows that page. The in-app browser can retain a CapCut website login; a mismatch between the current exit IP region and that account's registered region (数字户口) can cause this error. Treat this as a possible cause, not a confirmed diagnosis. Do not dismiss the page as a generic authorization-service failure or send the user straight to plugin settings before trying the website account recovery below.

1. Stop any login helper started by this workflow and wait for it to exit before retrying. Explain the possible retained website login to the user.
2. Guide the user to sign out of the current CapCut account in the in-app browser, then sign in with a region-matching CapCut account. Explicitly tell the user: when the current exit IP is in the US, the CapCut account's registered region must also be the US; when the exit IP is outside the US, the account's registered region must be outside the US. The relevant IP is the current network exit, which can differ from the user's physical location. Do not guess the IP or account region, require an IP lookup, or ask for credentials. Continue only after the user confirms the browser account change. Do not inspect or manually edit cookies or browser storage.
3. After the website account change, retry authorization once from **In-App Browser Login** step 2 and open only the new authorization URL emitted by the helper. Leave consent to the user and apply the same completion checks. Do not repeat the version check or reinstall the plugin.
4. If the same error persists after this attempt, stop and report the safe error and that website account recovery did not resolve it. Further investigation of account-region routing or OAuth client registration is needed; do not loop through sign-out/login or claim a confirmed root cause. If the browser is unavailable or the website account change is not completed, report authorization as incomplete and the remaining website step.

## HTTP 502 Handling

If the Codex host or connector explicitly reports HTTP transport status 502 for `capcut_creation` or `capcut_creation_resource` without receiving an MCP tool result, preserve the safe error, report that the CapCut service is temporarily unavailable, and stop. Do not retry or start account logout or OAuth. A tool result or `isError` message that merely mentions 502 belongs to the owning tool workflow.

## When to Recover

Start this workflow when any of these conditions is observed:

- Tool discovery cannot find a required CapCut tool after searching by its exact suffix.
- No protected tools from the plugin-provided `capcut_creation` server are visible.
- A CapCut tool reports unauthenticated, unauthorized, forbidden, OAuth required, expired credentials, or an equivalent authentication failure.
- The user explicitly asks to switch the CapCut account connected to `capcut_creation`, even if the connection status is `connected`.
- The CapCut authorization page reports `unknown client`; use the website sign-out recovery branch above.
- The local OAuth callback page reports `ERR_CONNECTION_REFUSED`; use the single fresh-authorization retry above.
- The presentation server reports `failed to refresh OAuth tokens for server capcut_creation_resource`, which indicates accidental OAuth state on the identity-free server.

After **Plugin Version Check Before Login Diagnosis**, for a missing tool, attempt one correct discovery pass using its exact suffix before classifying the failure:

- If another protected tool from `capcut_creation` is visible but the required tool is absent, do not run login or logout solely for that absence. Follow Recovery Workflow step 4 to check the account connection, including its unverified-state branch.
- If no protected `capcut_creation` tools are visible, continue with the account-server checks below; authentication recovery may be required.
- A tool that returned an explicit OAuth error requires authentication recovery regardless of whether other protected tools remain visible. Do not repeatedly call a tool that already returned an authentication error.

Do not start MCP authentication recovery for local file errors, invalid script arguments, sandbox or network failures from local scripts or downstream requests, upload failures, expired short-lived upload sessions, or video-finalize failures. This remains true when a script reports `unauthorized`, `forbidden`, `InvalidAuthorization`, HTTP 401, or HTTP 403: those errors belong to the script's downstream request or short-lived capability, not the MCP OAuth session. Follow the owning skill's retry or failure instructions instead. The only local permission failure handled in this workflow is one raised while invoking the login helper after recovery has already started, including an execution-tool denial before the process launches; follow step 6 for that case.

## Recovery Workflow

1. Tell the user briefly what Codex is checking and complete **Plugin Version Check Before Login Diagnosis** once before a new MCP login diagnosis. For token-expiry recovery, keep the unfinished CapCut request and stable task/card IDs; do not reduce the goal to login alone or require an installation prompt to be repeated. If the user or visible browser page already shows `unknown client` or a refused local callback, enter the matching branch above immediately and skip this version check for that recovery. Resolve the native Codex CLI under **In-App Browser Login** and substitute that absolute executable for `codex` in the commands below. For `capcut_creation`, check the helper and in-app browser prerequisites before any account logout. For `capcut_creation_resource`, explain that only stale local OAuth state will be cleared. Continue the workflow instead of asking the user to find or run a command.
2. If the exact failure names `capcut_creation_resource`, clear only its accidental OAuth state and retry discovery once:

   ```bash
   codex mcp logout capcut_creation_resource
   ```

   Do not run OAuth login for `capcut_creation_resource`; it is intentionally identity-free. If the presentation tool remains unavailable after one correct discovery attempt, follow **New-Task Handoff** directly.
3. Check the protected plugin server:

   ```bash
   codex mcp get capcut_creation
   ```

4. Interpret the result:
   - If `capcut_creation` exists and is enabled, an explicit MCP OAuth error takes precedence over status checks: continue to step 5 for an invalid or expired grant, or step 6 for a login-required challenge. An explicit account-switch request continues to step 5; an explicit sign-in request continues to step 6. Do not run the status probe to override these instructions.
   - For missing protected tools without an explicit authentication error or login request, if a successful protected tool result is available from this task, reuse it and follow **New-Task Handoff**; otherwise run `node <absolute-skill-directory>/scripts/check-connection.mjs --codex-cli <absolute-codex-cli>` under **Local Execution Permissions**. `status=connected` means the host reports both `runtimeStatus=connected` and `authStatus=oAuth`; follow **New-Task Handoff** without starting OAuth. `status=login_required` continues to step 6. A mixed server can connect anonymously, so transport connectivity or visible tool definitions alone do not confirm account authorization. This status check does not prove a stored grant is still valid.
   - For `status=unknown`, a missing helper, or a failed status check, keep authorization unverified. If no successful protected call is available, discover `capcut_get_profile` once and call it with empty arguments when available, unless this check already failed in the current diagnosis. Success confirms the protected connection; continue the original task or follow **New-Task Handoff** if its required tool remains missing. An explicit MCP authentication error follows the first branch above. If the tool is unavailable or fails for another reason, report the safe check failure and the unresolved authorization state; stop authentication recovery without login, logout, reinstalling, or handoff as an authenticated account. A local startup failure, timeout, unavailable runtime state, or unsupported auth status alone is not evidence that OAuth is needed. Preserve the original task and any existing session for resumption after the check failure is resolved.
   - If it exists but is disabled, ask the user to enable the installed CapCut plugin, then stop. Do not create a duplicate server.
   - If it does not exist, follow the CapCut installation skill. After installation, follow **New-Task Handoff** for missing protected tools only when authorization is confirmed; otherwise retain the installer's unverified or incomplete authorization outcome. Do not run `codex mcp add`.
5. If the exact failure names `capcut_creation` and confirms its OAuth grant is invalid or expired (including `invalid_grant`, `login session expired`, or an MCP bearer-authentication 401), or the user explicitly asks to switch the connected CapCut account, clear that account session once. A downstream tool or upload 401 does not qualify. For account switching, a `connected` status does not establish which CapCut account is connected:

   ```bash
   codex mcp logout capcut_creation
   ```

6. Tell the user that authorization will open in Codex's in-app browser, then follow **In-App Browser Login**. Keep the same helper running while the user completes CapCut authorization. Request shell or browser permission only when the current tool requires it. Do not ask the user to copy commands or return credentials.

   If this login process exits with an explicit MCP endpoint HTTP 502 or Bad Gateway error, preserve that safe error, report that the CapCut service is temporarily unavailable, and stop authentication recovery.

   For an unexpected permission failure only: after the first invocation has definitively failed, either because the execution tool rejected it before launch or because the process exited, if the error explicitly identifies a local sandbox or network-permission denial and that invocation did not use the required permission, follow **Local Execution Permissions** to rerun the exact same command outside the sandbox once when policy permits. Do not use this retry for DNS, TLS, timeout, HTTP, remote-service, or OAuth protocol or configuration failures, or a generic CLI early exit. If approval is prohibited, unavailable or denied, or the single retry still fails, report the specific safe error and stop further authentication actions. Do not retry again, change endpoints, reinstall the plugin, or inspect credentials.
7. Treat only the helper's successful completion event and exit code 0 as completed authentication. After handling **Local Callback Connection Refused**, **Unknown Client on the Authorization Page**, or the local permission case in step 6 when applicable, if Codex reports that OAuth is unsupported, unavailable, or misconfigured, stop and report that exact safe error; do not retry, change endpoints, or fall back to manual credentials.
8. After successful login, retry the originally required protected CapCut tool once in the current task. For an account-switch request without an unfinished tool call, make one read-only `search_capcut_material` call to verify that the protected connection is callable; do not claim this check proves which account was selected. If the call again reports an OAuth authentication failure, stop without another logout or login:
   - If the tool is callable, resume the original workflow immediately. A successful OAuth login can become usable without restarting the task.
   - When checking availability, use the direct MCP tool namespace or the supported tool-discovery mechanism. Do not infer absence from an executor-local tool inventory, because it may omit directly exposed MCP tools.
   - If the tool remains absent after one correct discovery attempt, follow **New-Task Handoff** directly. Do not repeat OAuth login in the same task.

## New-Task Handoff

When the account is connected but a required protected tool remains unavailable after one correct native discovery attempt, or an identity-free presentation tool cannot be called or displayed here, **you MUST fork this Codex task, send the original request and progress to the fork, and open it before ending this turn.** This applies during installation, later use in the stale installation task, and reauthorization with an unfinished request. Start the fork without asking for a separate handoff confirmation or requiring the latest user message to mention forking. Earlier direct user instructions to send and open a fork remain effective throughout this conversation, including after login. Do not start OAuth for a missing presentation tool, repeat successful OAuth for a stale tool list, or stop at a copyable prompt before attempting the host tools.

Before handoff, preserve the original goal, confirmed authorization state, relevant assets and workspace, submitted task IDs, search IDs, generation IDs, event cursors, card bindings, and the exact unfinished step. Do not repeat a submitted operation or use a paid operation to test card support. For a template request, follow the sibling `search-templates` skill; its result requires the native preview card.

1. Discover `fork_thread`, `send_message_to_thread`, and `navigate_to_codex_page` through the host's deferred-tool discovery even when absent from the initial tool list. Do not infer that forking is impossible from an initial tool list, a stale CapCut tool list, the absence of a source `threadId`, or the absence of a special handoff phrase in the user's latest message.
2. Call `fork_thread` with a same-directory environment and no `threadId` to fork the calling task. A fork carries this task's history and workspace. Send a concise follow-up prompt to its returned child `threadId`: restate the original CapCut goal, confirmed authorization, completed progress and exact next step; ask it to discover the required native tools and resume without repeating submitted work. Mark this as a CapCut handoff fork. After the send succeeds, call `navigate_to_codex_page` to open that child. The inherited history alone does not submit the continuation prompt.
3. **Completion gate:** Do not finish with a success report until the child contains the continuation prompt and has been opened. Correct definite argument or target-validation errors when possible, but do not blindly repeat a fork or send call whose outcome is unknown. If a child was created but a later step fails, recover that child rather than forking again. In the fork, discover the required native tools again and resume the original request. If they remain unavailable, check the actual plugin and connection state before reporting a persistent capability failure; do not repeatedly fork without new evidence. If `fork_thread` is unavailable or definitively fails before creating a child, state the failed step and give the complete continuation prompt, explicitly directing the user to create a new Codex chat and send that prompt. Include the original goal, authorization state, completed progress, stable IDs, and next action. If a child exists but sending or opening fails, identify that existing child when possible and help the user continue it; do not misstate this as a fork failure or create a duplicate.

## Result

Report authentication as successful only after the helper receives `mcpServer/oauthLogin/completed` for `capcut_creation` with `success=true` and exits with code 0. Never claim the original CapCut operation succeeded until its own tool result proves it.
