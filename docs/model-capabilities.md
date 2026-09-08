# Built-in media model capabilities

Reviewed on 2026-09-08. This table documents local templates, not capabilities returned by a gateway's `/models` endpoint or live acceptance by every account. Saved model edits take precedence. The server model library resolves the same static adapter catalogs for recognition, automatic configuration and copying. Vendor-like names alone do not grant capabilities.

## Images

Mask support in this table means native protocol support. Image-input models without native masks can use the editor’s translucent-overlay fallback; pure text-to-image models cannot receive that image. The server preserves the original `supportsMask` capability flag.

| Model IDs | Generate / edit | Reference configuration / mask | Resolution template |
| --- | --- | --- | --- |
| `gpt-image-2` | Both | 16 references / mask supported | Pixels: multiple of 16, longest edge ≤3840, 655360–8294400 pixels, aspect ratio ≤3:1 |
| `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini` | Both | 16 references / mask supported | auto, 1024x1024, 1536x1024, 1024x1536 |
| `gemini-3.1-flash-image` | Both | 14 references / no mask | Native 512, 1K, 2K, 4K |
| `gemini-3.1-flash-lite-image` | Both | 14 references / no mask | Native 1K |
| `gemini-3-pro-image` | Both | 14 references / no mask | Native 1K, 2K, 4K |
| `gemini-2.5-flash-image` | Both | 3 references / no mask | Native 1K |
| `grok-imagine-image-2.0` | Both | Source + 4 references / no mask | Native 1k / 2k, quality low / medium |
| `grok-imagine-image`, `grok-imagine-image-quality` | Both | Source + 3 references / no mask | Native 1k / 2k; retained compatibility templates |

Gemini supports Generate Content and Interactions profiles. Chat-compatible Gemini templates use Chat image configuration and a conservative four-reference default; they do not promise native-endpoint parity through every gateway. Editing does not imply mask support. Counts remain independent application jobs.

Sources: [OpenAI](https://developers.openai.com/api/docs/guides/image-generation), [GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2), [Gemini](https://ai.google.dev/gemini-api/docs/image-generation), [xAI generation](https://docs.x.ai/developers/model-capabilities/images/generation), [xAI editing](https://docs.x.ai/developers/model-capabilities/imagine).

## Videos

| Model IDs | Operations | Resolution / duration | Continuation restrictions |
| --- | --- | --- | --- |
| `sora-2`, `sora-2-pro` | Text, first frame, edit, extend | Per-model pixel sizes; generation 4/8/12/16/20 seconds | Same-connection/model video ID; uploaded editing requires explicit opt-in; extension adds at most 20 seconds |
| `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview` | Text, first/last frames, references, extend | 720p / 1080p / 4k; 4/6/8 seconds | High resolution and reference generation require 8 seconds; extension requires a live same-connection Veo source, 720p, 16:9 or 9:16, ≤141 seconds |
| `veo-3.1-lite-generate-preview` | Text, first frame | 720p / 1080p; 4/6/8 seconds | No extension or reference mode |
| `gemini-omni-1.1-flash`, `gemini-omni-flash-preview` | Text, first/last frames, references, edit, extend | Stable model: 360p / 720p / 1080p / 4k; prompt-controlled duration | Uploaded source ≤10 seconds; same-connection live interaction IDs support continued editing without re-upload |
| `grok-imagine-video` | Text, first frame, edit, extend | Generation 480p / 720p, 1–15 seconds | Edit source ≤8.7 seconds; extension source 2–15 seconds and added duration 2–10 seconds; inherited ratio/resolution, output ≤720p |
| `grok-imagine-video-1.5` | Text, first frame, references | 480p / 720p / 1080p, 1–15 seconds; reference mode ≤720p | Does not automatically inherit base-model edit/extend operations |

Per-operation policies hide and reject unsupported generation parameters. Configured application byte limits still apply. Veo extensions require an unexpired generated source; an arbitrary upload cannot impersonate one. Sora and Veo remote IDs are server-owned and scoped to the originating connection. New results link to their source asset, and jobs preserve the submitted policy through recovery.

Sora's official API is deprecated with a published shutdown date of 2026-09-24. Compatibility profiles remain configurable for gateways; user models are not deleted or disabled. Historical xAI names remain explicit compatibility records.

Sources: [Sora](https://developers.openai.com/api/docs/guides/video-generation), [Veo](https://ai.google.dev/gemini-api/docs/veo), [Omni](https://ai.google.dev/gemini-api/docs/omni), [xAI generation](https://docs.x.ai/developers/model-capabilities/video/generation), [editing](https://docs.x.ai/developers/model-capabilities/video/editing), [extension](https://docs.x.ai/developers/model-capabilities/video/extension).

## Aliases and maintenance

- Google's `models/` prefix is normalized for lookup. The configured remote ID remains intact.
- Reviewed image aliases: `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`, `gemini-2.5-flash-image-preview`, `gpt-image-2-2026-04-21`.
- Reviewed Sora aliases: `sora-2-2025-10-06`, `sora-2-2025-12-08`, `sora-2-pro-2025-10-06`.
- Add entries with official sources, payload/rejection cases and recognition-to-template consistency tests. Never widen unknown models from a prefix match.
- Catalog discovery is read-only. Explicit loading/copying changes the draft, and saving persists it. Delayed automatic loads cannot replace a newer selection or edit.

## MAI, Seedream and Seedance compatibility templates

Reviewed on 2026-09-08. These entries configure **existing OpenAI Images / Videos compatible channels**. They do not implement Microsoft Foundry, ModelArk or LAS native endpoints. A channel must implement the selected compatible request shape; a native-only API URL is insufficient. This review used documentation and injected transports, not paid generation requests. Recognition never changes an existing saved model.

### Image templates

| Canonical ID | Enabled operations / maximum references | Output constraints |
| --- | --- | --- |
| `MAI-Image-2`, `MAI-Image-2e` | Text generation / 0 | PNG, each edge ≥768, total ≤1,048,576 pixels |
| `MAI-Image-2.5`, `MAI-Image-2.5-Pro`, `MAI-Image-2.5-Flash`, `MAI-Image-2.6`, `MAI-Image-2.6-Flash` | Text generation, single-image editing / 1 | PNG, each edge ≥768, total ≤1,048,576 pixels |
| `doubao-seedream-4-0-250828` | Text generation, image editing / 14 | JPEG, 921,600–16,777,216 pixels |
| `doubao-seedream-4-5-251128` | Text generation, image editing / 14 | JPEG, 3,686,400–16,777,216 pixels |
| `doubao-seedream-5-0-260128` (5.0 Lite) | Text generation, image editing / 14 | PNG/JPEG, 3,686,400–16,777,216 pixels |
| `dola-seedream-5-0-pro-260628` | Text generation, image editing / 10 | PNG/JPEG, 921,600–4,624,220 pixels |

Reference counts in the table include the source image. The editable template keeps that total for the UI and declares an operation-specific additional-reference limit (total minus one); the server checks it before loading inputs. Templates send pixel sizes through the Images compatibility profile. Seedream permits a longest/shortest-edge ratio up to 16; the UI offers common ratios and custom dimensions within the declared pixel budget. MAI offers auto, square and 4:3/3:4. An omitted size lets the channel choose. No masks, streaming, sequential multi-image output, web search, watermark controls or native-only tools are enabled. The application still creates one independent job per requested output. Seedream reference inputs are bounded to 30 MiB and 36 million pixels each; application upload limits also apply. Channel-specific restrictions can be configured by editing/copying the template.

Sources: [Microsoft Foundry MAI Image](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image), [MAI Image 2 Efficient](https://microsoft.ai/news/mai-image-2-efficient/), [Seedream image API and model differences](https://docs.byteplus.com/api/docs/ModelArk/1824121).

### Video templates

| Canonical ID | Enabled inputs | Resolution / duration |
| --- | --- | --- |
| `doubao-seedance-1-0-pro-250528`, `bytedance-seedance-1-0-pro-fast-251015` | Text or single first frame | 480p/720p/1080p, 2–12 seconds |
| `doubao-seedance-1-0-lite-t2v-250428` | Text only | 480p/720p, 2–12 seconds |
| `doubao-seedance-1-0-lite-i2v-250428` | Single first frame only | 480p/720p, 2–12 seconds |
| `doubao-seedance-1-5-pro-251215` | Text or single first frame | 480p/720p, 4–12 seconds |
| `dreamina-seedance-2-0-260128` | Text or single first frame | 480p/720p/1080p, 4–15 seconds |
| `dreamina-seedance-2-0-fast-260128`, `dreamina-seedance-2-0-mini-260615` | Text or single first frame | 480p/720p, 4–15 seconds |
| `dreamina-seedance-2-5-260628` | Text or single first frame | 480p/720p, 4–30 seconds |

These are conservative subsets of the documented native/enhanced-service capabilities: no audio, multi-reference, first/last-frame pairs, editing or extension is enabled. LAS 4K enhancement is not treated as native model output. First-frame inputs accept JPEG/PNG/WebP, at most 30 MiB and 6000 pixels per edge; the application checks its own input limits too. Regional/historical 1.0 IDs remain templates even where an official service has retired them; availability must be checked with the chosen channel.

The existing Videos wire format remains `/videos`, JSON or `input_reference` multipart, string `seconds`, pixel `size`, and asynchronous polling. Named resolutions map by short edge and selected ratio (for example 1080p + 16:9 → 1920x1080). Custom models with saved capabilities use those size/duration constraints, including during recovery and upstream-result validation. Models without declared capabilities retain conservative defaults. Saved policy snapshots are server-derived; a request cannot enlarge limits by supplying its own policy.

Sources: [Seedance enhanced service and model comparison](https://docs.byteplus.com/en/docs/byteplus_las/video_gen_enhanced), [Seedance 1.0 Pro](https://docs.byteplus.com/en/docs/ModelArk/1587798), [regional lifecycle notices](https://docs.byteplus.com/en/docs/ModelArk/1350667), [Volcengine video model IDs](https://www.volcengine.com/docs/6492/2389898?lang=en).

### Compatibility identity maintenance

The finite identity/alias list is maintained in [compatible-models.ts](../packages/shared/src/compatible-models.ts); server constraints live in [compatible-model-catalog.ts](../apps/server/src/providers/compatible-model-catalog.ts). Upper/lowercase MAI spellings and explicitly listed regional/version IDs resolve to one template, but the original configured wire ID is preserved. No wildcard admits future MAI, Seedream or Seedance versions. Directory recognition, display names, automatic loading and copying use this same list.
