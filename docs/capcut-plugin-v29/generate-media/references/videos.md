# Video Generation

Use this reference for video requests and video-specific parameter or result handling. The parent [generate-media skill](../SKILL.md) owns discovery, parameter-card follow-ups, billing, polling, and result rendering.

## Model Contract

| Model | Resolution | Duration | Omni references |
| --- | --- | --- | --- |
| `seedance2.5` | `480p`, `720p` (default), `1080p` | 4–30s, default 5s | images ≤30, videos ≤10, audio ≤10; video total ≤30s; audio total ≤30s; audio-only allowed |
| `seedance2` | `480p`, `720p` (default), `1080p`, `4K` | 4–15s, default 5s | images ≤9, videos ≤3, audio ≤3, total ≤12; video total ≤15s; audio total ≤15s; audio requires image or video |
| `seedance2_fast` | `480p`, `720p` (default) | 4–15s, default 5s | same reference limits as `seedance2` |
| `seedance2_mini` | `480p`, `720p` (default) | 4–15s, default 5s | same reference limits as `seedance2` |
| `seedance1_fast` | `480p` (default), `720p` | 2–12s, default 5s | unsupported; text-only or keyframe images |

All models default to `16:9` and accept `adaptive`, `21:9`, `16:9`, `9:16`, `4:3`, `1:1`, and `3:4`. Durations use whole seconds in `duration_ms`. Result count defaults to one and accepts 1–4 independent video generations. Native output audio is enabled for 2.x models and disabled for Seedance 1.0 Fast; it is not a selectable parameter.

Keyframes accept at most one first-frame and one last-frame image and cannot mix with Omni references. Keyframes preserve the selected model-supported ratio; an omitted ratio still defaults to `16:9`.

Map unambiguous model names: Seedance 2.5 → `seedance2.5`, Seedance 2.0 → `seedance2`, Seedance 2.0 Fast → `seedance2_fast`, Seedance 2.0 Mini → `seedance2_mini`, Seedance 1.0 Fast → `seedance1_fast`. Convert seconds to `duration_ms` (10 seconds → `10000`) and clearly stated resolutions to canonical spelling.

## Prompt and Card Fields

A non-empty prompt is required for every video generation, including requests with reference images, videos, audio, or keyframes. The parameter card may open with an empty prompt, but the user must fill it in before submitting. Do not invent a prompt merely to satisfy validation.

Preserve subject, motion, shot, timing, style, camera, text, audio, and continuity requirements. Prefill `prepare_for_video_generation` with the available `prompt`, explicit valid `model`, `duration_ms`, `resolution`, `ratio`, `count`, `reference_mode`, and uploaded `reference_assets`.

For example, “generate two 10-second 720p 9:16 seaside sunset videos with Seedance 2.0 Fast” supplies:

```json
{
  "prompt": "a seaside sunset video",
  "model": "seedance2_fast",
  "duration_ms": 10000,
  "resolution": "720p",
  "ratio": "9:16",
  "count": 2
}
```

## References and Generation Mode

Follow the sibling [capcut-upload](../../capcut-upload/SKILL.md) skill for attached image/video/audio references before the first card or when adding chat references. Upload mixed media together; require public finalization for video/audio, reuse successful identifiers, and preserve attachment order and original base file names. Card references use these forms:

```json
[
  {"role":"reference","media_type":"image","uri":"bucket/path","file_name":"reference.png"},
  {"role":"reference","media_type":"video","vid":"v...","file_name":"reference.mp4"},
  {"role":"reference","media_type":"audio","vid":"v...","file_name":"reference.mp3"}
]
```

`file_name` is for card display only and is omitted from generation specs. For Seedance 1.0 Fast, use only `first_frame`/`last_frame` image roles and Keyframes mode. For other models, use `role:"reference"` unless the user assigned an image as `first_frame` or `last_frame`. Select `reference_mode:"keyframes"` for explicit frame images or `reference_mode:"omni_reference"` for general image/video/audio references. When neither mode nor references are given, omit the mode for the card default. Preserve an explicit mode and display incompatible references for adjustment instead of silently dropping files or changing models.

Matrix behavior and commercial pricing use different rules:

- Matrix uses Keyframes with no references or `first_frame`/`last_frame` images, and Omni reference behavior for assets with role `reference`.
- Commercial r2v pricing applies only when an Omni asset has `role:"reference"`, `media_type:"video"`, and a non-empty public VOD VID.
- Text-only, keyframe, image-only Omni, and audio-only Omni requests use the commercial i2v bucket.

The protected tool derives both modes from the final references. Do not add an i2v/r2v field to the public request or copy the card-only `reference_mode` into the generation spec; submit the exact card-provided `generation_request.input`.

## Batch and Results

Call `capcut_video_generate` once for the requested `count`. The server quotes the whole batch once; each child has its own withholding, Matrix task, and settlement. Save the single logical batch `task_id` and server-issued `unique_key`. `capcut_generation_poll` polls every child and returns the batch status, available wait estimates, and successful resources in child order. Display wait estimates according to the parent skill; do not display percentage progress.

`partial_succeeded` means all children are terminal and at least one succeeded. Continue while `next_action` requires polling so billing settles, then render all successful resources and clearly report the partial result.

Follow the parent skill's settled `generation_result` workflow, including its preview-failure handling and actual credit reporting. Preserve every successful video's public VOD VID and child order for the draft workflow.
