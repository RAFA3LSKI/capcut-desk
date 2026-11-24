---
name: generate-media
description: Generate images and videos with CapCut from text or uploaded references. Use for still-image creation, Seedance video generation, model and parameter selection, generation-card follow-ups, credit confirmation, status polling, cancellation, and displaying generated results. Do not use for editing existing footage into a finished cut or generation with another provider.
---

# Generate CapCut Images and Videos

Use the CapCut plugin as the authoritative provider. Start new requests with the appropriate parameter card, submit its confirmed selection, poll the logical task until billing settles, and display every successful result.

## Route the Request

Choose by the requested output, not the attachment type. An image used to create a moving scene belongs to video generation; a poster or storyboard frame belongs to image generation.

| Request | Read when needed | Parameter card | Protected generation tool |
| --- | --- | --- | --- |
| Still images, including text-to-image and image references | [Image generation](references/images.md) | `prepare_for_image_generation` | `capcut_image_generate` |
| Videos from text, keyframes, or Omni image/video/audio references | [Video generation](references/videos.md) | `prepare_for_video_generation` | `capcut_video_generate` |

Read only the reference for the current output type. If the user requests both types, handle them sequentially with separate tasks; show only the current type's card in this turn and read the other reference when starting that part. If neither the request nor existing card context establishes an output type, clarify only whether the user wants images or video. Cutting or packaging existing footage belongs to the sibling [video-editing](../video-editing/SKILL.md) skill.

For an existing workflow, use its saved `media_type`, exact card binding, `generation_request.tool_name`, or task/key from the conversation. An “Add references in chat” follow-up continues that card; `operation:"generate"` submits its selection; `operation:"confirm_generation_credits"` continues its exact quote. Do not treat these as new requests or reopen parameter selection.

## Provider and Tool Discovery

Resolve only needed plugin tools by exact name suffix; call directly available tools without rediscovering them:

- The parameter card and protected generation tool from the selected route.
- Account-bound `capcut_generation_poll` and authenticated `generation_result` for completion.
- Identity-free `billing_confirmation` when the protected tool requires credit confirmation.
- Account-bound `capcut_generation_cancel` only on explicit cancellation.
- The sibling [capcut-upload](../capcut-upload/SKILL.md) skill when preparing or adding references; resolve `capcut_asset_upload_credential` and `capcut_get_generation_card` as required by that upload or replacement-card workflow.

If a protected `capcut_creation` tool is missing after native discovery, follow the sibling [mcp-auth](../mcp-auth/SKILL.md) skill to distinguish account authorization from a stale task tool list. If the account is connected, execute New-Task Handoff without waiting for a separate request to fork: fork, send the generation goal and progress, and open the fork. For a missing identity-free renderer, use that same handoff after one native discovery attempt without starting account OAuth; only the exact stale-refresh error naming `capcut_creation_resource` enters its resource-server recovery. For connector-level HTTP 502 without a tool result, follow `mcp-auth`'s HTTP 502 branch before any retry.

Before uploading references, creating a draft session, or submitting generation, confirm that this task can natively call and display the selected `prepare_for_image_generation` or `prepare_for_video_generation` card. If the selected parameter card, a required `billing_confirmation` card, or `generation_result` is unavailable here, follow `mcp-auth` New-Task Handoff before the dependent operation. Carry the original prompt and attachment references. If a flow already has a card, quote, `generate_id`, `unique_key`, draft session, or task ID, preserve those exact bindings so the new task continues rather than repeats the request. Never replace a missing card with a text summary or submit a paid operation to test rendering.

Do not use another generator, CapCut desktop/web automation, Computer Use, or browser automation as a generation fallback. Automatic browser actions here are limited to OAuth through `mcp-auth`, the returned paywall workflow below, and opening or reusing the session's editor after a successful draft save through [web-collaborative-editing](../web-collaborative-editing/SKILL.md).

## Prepare and Show the Parameter Card

A request to generate an image or video is enough to open its card, even without a subject, style, or prompt. Do not ask content questions first. Preserve available creative requirements, including text and continuity; organize the prompt without materially changing the concept. Leave `prompt` empty or omitted when no content was supplied. Every image and video generation submission requires a non-empty prompt, including requests with reference images, videos, audio, or keyframes. If no prompt was supplied, let the user fill it in on the parameter card before submitting; do not invent a prompt merely to satisfy validation.

1. Extract explicit settings into the card fields described in the selected reference. Normalize unambiguous model names and values; show `adaptive` as **Fit**. Preserve valid explicit choices. Omit missing or ambiguous choices for defaults; if no model was specified, let the renderer choose its compatible default. Omit invalid or explicitly model-incompatible values and briefly explain the conflict before rendering the card.
2. For already attached references, follow `capcut-upload` before opening the first card. Reuse successful uploads; preserve attachment order and each original base `file_name`. Use image ImageX URIs and public-finalized video/audio VIDs according to the selected reference. Never substitute a local path, attachment handle, public URL, workspace ID, or workspace asset ID. `file_name` is card metadata only and must be omitted from generation specs. Report failed or incompatible files and preserve successful identifiers; do not silently drop references or change models.
3. Render the selected parameter card once for every new request, even when all settings are explicit. Include available prompt, settings, and references with their file names. Do not ask for the same attachments again. With no content, settings, or references, call the card with `{}`.
4. After a successful render, end the turn without any assistant text: no summary, upload confirmation, parameter recap, or instructions to click Generate. The single card is the complete response. Do not render another parameter card in this turn; wait for the card follow-up. This also applies to a replacement card after reference uploads. Report upload failures or parameter conflicts before rendering; if the card cannot be invoked or displayed in this task, follow `mcp-auth` New-Task Handoff with the current card bindings. Report a definite tool result error normally. Rendering the card consumes no credits and does not submit generation.

An “Add references in chat” follow-up is not approval to generate. Follow `capcut-upload`'s replacement-card workflow using the exact `generation_card` binding, reserved next version, and complete updated reference list. The new card restores saved settings; incompatible references remain visible for adjustment. Show it once, then end the turn without assistant text and wait for its generation follow-up.

## Submit the Selected Request

The generation follow-up's structured model context carries `operation:"generate"` and `generation_request` with `tool_name` and exact `input`. Submit that input unchanged, always supplying `draft_session_id` through the session workflow below. Initial requests use `confirmed:false` and omit `unique_key` and `dont_ask_again`. Do not show another parameter card. The card-wide `submitted` flag means parameter confirmation, not Matrix submission; if a generation task/key already exists, continue it instead of resubmitting.

Never invent `unique_key`. Preserve the server-issued key, spec, count, and draft session across credit-confirmation retries. The card estimate and protected quote already cover the whole selection; do not multiply by result count or calculate/withhold credits client-side. The selected reference explains the image task or independent video batch behavior.

Before submitting generation, follow [web-collaborative-editing](../web-collaborative-editing/SKILL.md) to select or create a session and supply its ID as `draft_session_id`. Preserve it across retries and credit confirmation.

## Benefits and Credit Confirmation

Dispatch only on the protected tool's response:

1. **Queued:** Limited-free benefits or the account's saved **Don't ask again** preference cover the request. It may consume credits; no extra confirmation is needed. Save the logical `task_id` and returned `unique_key`, then poll. Do not claim submission until a normal response provides a non-empty logical `task_id`.
2. **`PAYWALL_REQUIRED`:** Prioritize `paywall_reason` over the generic `message` and explain it in the user’s language: for `membership_upgrade`, say the current membership does not cover this generation and requires an upgrade; for `credits_purchase`, say the account has insufficient credits and requires a credit purchase. Do not combine known reasons into “insufficient benefits or credits”. If the reason is omitted, explain the returned message without guessing the cause. Follow the purchase-page workflow below. When `benefit_check_label` and `benefit_check_url` are returned, this turn’s final reply must include their clickable Markdown link without waiting for the user to ask. Translate only the reason explanation; preserve the label even if its language differs from the conversation. The parameter-card silence rule does not apply to this paywall response. Wait for the user to complete the purchase before retrying.
3. **`CONFIRMATION_REQUIRED`:** The exact total quote is `confirmation_card.input.credits_amount`. Call `confirmation_card.render_tool_name` once with `confirmation_card.input` unchanged, then wait for explicit user approval. If a changed quote returns another confirmation card, render it and wait again.

The credit-confirmation follow-up carries `operation:"confirm_generation_credits"` and `credit_confirmation`. Match its `tool_name`, `unique_key`, and `credits_amount` to the displayed quote. Retry that exact generation tool with the preceding arguments unchanged except `confirmed:true` and the checkbox choice. Forward `dont_ask_again:true` only when the user checked **Don't ask again** and confirmed; otherwise omit it or pass false. Never approve charges on the user's behalf or reuse a key for changed parameters.

The saved preference applies to the current CapCut account across image and video generation. Later new requests still start with `confirmed:false`, no `unique_key`, and no `dont_ask_again`; the server decides whether to skip the credit-confirmation card. Shortfalls still require the purchase-page workflow. Generation submission, withholding, compensation, and settlement remain server responsibilities.

### Purchase Page

The server calls `RequestBenefitCheck` with the actual benefit list and `draft_session_id`. Inspect the current task's in-app browser pages and match the URL's `session` parameter to `draft_session_id`; reuse only that session's open CapCut Web page without navigating or reloading it. Otherwise, automatically open the exact returned `benefit_check_url` in Codex's in-app browser without another confirmation, using the browser tools below.

This turn’s final reply must include a direct Markdown link using the returned `benefit_check_label` verbatim and the exact `benefit_check_url`, whether the page was opened, reused, or failed to open. This is required on the first paywall response, not only after a request for a purchase link. The tool's text result also provides this link for reuse. Never translate or rephrase the label, even when it is in a different language from the conversation, or replace the link with a statement that the page is open. The server provides the Starling translation or the configured English fallback:

```text
[<benefit_check_label>](<benefit_check_url>)
```

Replace the placeholders with the returned values. This link must open the URL directly, without a follow-up prompt, automatic chat message, another model turn, or a second confirmation. Do not use `codex-followup` for this link. Direct link clicks follow Codex's browser preference; do not claim that a Markdown link forces the in-app browser. If the label is omitted because the reason is unknown, explain the returned message without inventing a purchase action label; still follow the automatic opening workflow.

Before ending the turn, verify that the final reply contains the rendered link with the returned label, not only the purchase explanation or browser-opening status. A Japanese label stays Japanese in a Chinese reply; do not substitute a Chinese purchase label. A link shown only in a tool result or progress update does not fulfill this requirement.

When a new purchase-page tab is needed, call `mcp__codex_app__open_in_codex` with `target={"type":"browser","url":<benefit_check_url>}`. If only Computer Use is available, use `cua.createBrowserTab("iab", benefit_check_url, { visible: true })` under that tool's instructions. For an explicit request to open the purchase link again, navigate the matching tab to the exact returned purchase URL, or open it if absent. If no in-app browser is available or opening fails, report that the page could not be opened in Codex; do not fall back to the system browser. Opening the purchase page must not resubmit generation.

Preserve the complete purchase URL, including `codex_benefit_triple_id`; the page uses it to retrieve this interception’s benefit list. Do not replace it with the ordinary editor URL. If the link expires, explain that the original operation must be retried to obtain a new link.

The page handles the membership or credit purchase prompt. Opening it neither approves a purchase nor proves payment succeeded. Wait for the user to complete the purchase before retrying generation. Report tool failures without inventing a purchase URL.

## Polling, Cancellation, and Settlement

Poll `capcut_generation_poll` with the exact logical `task_id`, not a downstream Matrix ID. A video batch uses one logical task for all children.

- While `next_action=poll_generation`, wait at least `next_poll_after_ms`, then poll the same task. Do not impose a client-side poll limit or resubmit because polling is slow.
- Show available wait estimates on the first poll response, meaningful estimate changes, or stage changes. Do not display percentage progress. Convert `estimated_remaining_time_ms` to an approximate duration such as “about 2 minutes remaining”; it includes queue wait and generation, but excludes billing settlement. If only `estimated_queue_time_ms` is available, say “about 1 minute in queue”, without implying a completion time. Batch estimates already cover all unfinished videos; do not add them together or multiply by count. When estimates are absent, show the task status only, such as “queued” or “generating”. Do not infer an ETA from `next_poll_after_ms`, promise a precise countdown, or narrate empty polls.
- Treat `queued`, `running`, and `unknown` as non-terminal while polling is requested. Even a terminal media status can still require billing settlement; continue until `next_action=none`.
- On a poll transport failure, retry the same logical task. On explicit cancellation, call `capcut_generation_cancel` once and follow its `next_action` until task and billing are terminal; a cancellation acknowledgement alone is not completion.
- On settled `failed` or `canceled`, report the safe error or cancellation without claiming successful media. For `partial_succeeded`, preserve every successful resource and report the partial result.

## Display Every Result

After `status=succeeded` or `status=partial_succeeded`, `next_action=none`, and settled billing:

1. Preserve every returned resource in array order (child-task order for video batches).
2. Call authenticated `generation_result` once with only the settled `task_id`. The renderer reads owned results and settled billing itself; do not pass resources or reconstruct billing inputs.
3. If rendering fails with `generation_result_url_invalid`, report the preview failure and retain the task ID and all successful resources' stable identifiers. `capcut_batch_media_url` does not update the task snapshot, so resolving URLs separately cannot repair this card. Do not invent URLs, repeat generation, or claim the card was displayed. Continue the draft workflow below with the returned stable media references.
4. Include `actual_credits` from the settled poll in the response text. Never infer the charge from the estimate or a balance change. Preserve all successful results, including a partially successful video batch.

Use the editor links returned by a successful draft save, following the draft delivery workflow below; do not fabricate CapCut links. Never expose cookies, OAuth tokens, access keys, upload credentials, request headers, Matrix task IDs, raw downstream responses, signed reference URLs, or paywall internals beyond the safe reason and URL. Parameter cards, confirmation cards, and paywalls are not successful generation results.

## Add Results to the Session's Draft

Generated media belongs on the user's timeline, not only in the result card. Every successful result from this generation goes into the draft, in the returned resource order. This generation was already submitted with a `draft_session_id`, so the target draft is settled — do not select or create another session here.

1. **Take the baseline** through [web-collaborative-editing](../web-collaborative-editing/SKILL.md)'s edit round. An empty `server_package_id` means this session has no draft yet; the first push creates it.

2. **Append the results in returned resource order** with [capcut-stdraft-builder](../capcut-stdraft-builder/SKILL.md)'s `apply_video`, passing `meta_type="photo"` for images. Compute each `start_ms` so the clip follows the last segment on the main track: with the time range already taken, the builder stacks the clip as picture-in-picture instead, which is not what appending means here. Reference the media by the identifier the result already carries — `vid://<vid>` for video, `tos://<uri>` for images — and let the push copy them into the user's workspace. An image holds a single frame and carries no duration of its own, so give each one 5000 ms.

3. **Push and deliver** through the same edit round, ending with its Deliver steps.
