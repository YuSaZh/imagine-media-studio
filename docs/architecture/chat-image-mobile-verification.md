# Chat Image Compatibility and Mobile Controls

Verified on 2026-09-06 for the post-release image provider and mobile Composer fixes.

## Deployment Evidence

Read-only, filtered diagnostics of the existing deployments found:

- Sub01 CPA `gemini-3.1-flash-image`: `gemini-interactions-image-v1` failed with `gemini_http_404`.
- Sub01 NINI_API Images: HTTP 500 with an explicit rejection that image generation only supports Imagen models. Its Responses attempt returned no image.
- HPServer CPA: `/v1/interactions` returned 404. A recorded `/v1beta/models/gemini-3.1-flash-image:generateContent` call returned 200 with `inlineData`, `image/jpeg`, and `STOP`.

No deployment credentials were extracted, no live generation was submitted, and no existing service was restarted or changed. CPA request and response protocol shapes were checked against the upstream translators recorded in `docs/third-party/reuse-audit.md`.

## Behavior

- `openai-chat-image-v1` is available in model protocol selection. It submits `messages`, image/text `modalities`, reference image parts, and optional `image_config` through the existing protected HTTP transport.
- JSON `choices[].message.images`, structured image content, and complete SSE `delta.images` are normalized through the existing image validation pipeline. Text-only, incomplete, filtered, excess, malformed, and credential-bearing outputs are rejected.
- Shared connections retry another image protocol after HTTP 404, 405, 415, or 501, or an explicit protocol/model incompatibility message accompanying 400, 422, 500, or 502. Each protocol is tried at most once, at the same configured connection, with the same cancellation signal.
- Gemini image fallback order prioritizes Chat Completions, then Generate Content, Images, and Responses, excluding the initial protocol. Other image models try Images, Chat Completions, and Responses. Unsupported parameter or input combinations are skipped without dropping their values. Mask edits never silently lose the mask.
- Authentication errors, quota/rate limits, timeouts, ambiguous upstream failures, and successful responses without images do not trigger protocol fallback. Video submission is unchanged.
- Mobile image/video mode buttons use icons only. Aspect ratio remains available with normal or visible managed aspect-ratio rules and uses configured choices instead of free text. Width/height editing remains a separate size control.
- Selecting a ratio preserves named resolutions such as 2K, while replacing explicit pixel dimensions. Both ratio and named resolution reach the server.
- Mobile upload, settings, and submit buttons keep their dimensions and bottom positions across modes. Video input choices occupy their own row above those buttons, and status text has a fixed height with overflow handling.

## Verification

- Lint, TypeScript checks, unit tests, release-workflow checks, and production build passed. Focused provider tests cover the deployed 404 and explicit 500 rejections, protected headers, input preservation, cancellation, and no-replay cases.
- Browser checks cover 1920, 1440, 1280, 1024, 834, 430, 390, and 360 pixel widths, including real local Mock generation/editing, model rules, persistence, PWA, accessibility, and screenshots. The new geometry test compares exact button coordinates and dimensions across mobile modes.
- A combined local matrix encountered a stale in-flight 401 after an account password change. That full viewport suite passed with fresh isolated data, matching CI's per-project execution. The combined run was later stopped when a rebuild invalidated its static server's cached asset list; affected 390 and 360 suites passed in new server processes. These interrupted checks are not counted as a clean combined matrix run.
- A separate browser submission check confirmed that selecting 16:9 after 2K retains both parameters in the outgoing request.
- Isolated Docker build and `.github/scripts/docker-smoke.sh` passed, including migration, generation, editing, video, adapters, backup/restore, and persistence. Task-owned containers, network, image, data, and port 14374 were removed afterwards.
- GitHub Actions on the pushed commit remains the remote acceptance gate. The existing Sub01 deployment requires a separately published image and deployment update before these changes take effect there.
