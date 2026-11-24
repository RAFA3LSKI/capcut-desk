# Image Generation

Use this reference for still-image requests and image-specific parameter or result handling. The parent [generate-media skill](../SKILL.md) owns discovery, parameter-card follow-ups, billing, polling, and result rendering.

## Model Contract

| Model | Resolution | Ratios | Quality | Maximum references |
| --- | --- | --- | --- | --- |
| `seedream5pro` | `1K` (default), `2K` | common ratios + `21:9` | omit | 10 |
| `gpt_image_2` | `1K` (default), `2K` | common ratios | `low`, `medium` (default), `high` | 4 |
| `seedream5` | `2K` | common ratios | omit | 4 |
| `seedream4.3` | `2K` (default), `4K` | common ratios | omit | 4 |
| `nano_banana_pro` | `2K` (default), `4K` | common ratios + `21:9` | omit | 4 |

Common ratios are `adaptive` (Fit), `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, and `9:16`. Only `seedream5pro` and `nano_banana_pro` additionally support `21:9`. Every model supports text-to-image and optional reference images. Result count defaults to four and accepts 1–10. A non-empty prompt is required for every image generation, including requests with reference images. The parameter card may open with an empty prompt, but the user must fill it in before submitting; do not invent a prompt merely to satisfy validation.

When no ratio is explicitly requested, omit `ratio`: reference images default to `adaptive` (Fit), while requests without references default to `16:9`. Preserve explicit ratio choices.

Map unambiguous model names: Seedream 5.0 Pro → `seedream5pro`, GPT Image 2 → `gpt_image_2`, Seedream 5.0 → `seedream5`, Seedream 4.3 → `seedream4.3`, Nano Banana Pro → `nano_banana_pro`. Normalize clearly stated resolutions such as “2k” to `2K`. Do not add `quality` for an explicitly selected non-GPT model.

## Prompt and Card Fields

Preserve the user's subject, style, composition, lighting, camera, text, and continuity requirements. Prefill `prepare_for_image_generation` with the available `prompt`, explicit valid `model`, `resolution`, `ratio`, `quality`, `count`, and uploaded `reference_assets`.

For example, “generate two 2K 1:1 watercolor cats with GPT Image 2” supplies:

```json
{
  "prompt": "a cat in watercolor style",
  "model": "gpt_image_2",
  "count": 2,
  "resolution": "2K",
  "ratio": "1:1"
}
```

Quality uses its default. The submitted card maps GPT quality into `spec.model_options.quality`; keep its exact `generation_request.input` when calling `capcut_image_generate`.

## References

Image generation accepts image references only. Report unsupported video/audio attachments instead of silently dropping or mislabeling them. Follow the sibling [capcut-upload](../../capcut-upload/SKILL.md) skill before the first card or when adding chat references. Add every successful image in attachment order using its ImageX URI and original base file name:

```json
{
  "role": "reference",
  "media_type": "image",
  "uri": "bucket/path",
  "file_name": "reference.png"
}
```

`file_name` is for card display only and is omitted from the generation spec. All image-generation references use `role:"reference"`; video keyframe roles do not apply.

## Task and Results

`capcut_image_generate` submits one logical task for the requested image count. The quote and withholding cover the requested count. If fewer images succeed, the task returns `partial_succeeded`, preserves every successful image, and settles only the delivered count; the unused portion is returned by the billing service. Use the settled `actual_credits` as the final charge.

Follow the parent skill's settled `generation_result` workflow, including its preview-failure handling and actual credit reporting. Preserve every successful image's ImageX URI and result order for the draft workflow.
