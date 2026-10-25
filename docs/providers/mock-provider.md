# Mock Provider

The built-in Mock adapter is a zero-network test fixture, not a model or proof
of live Provider compatibility. Enable it explicitly with
`MOCK_PROVIDER_ENABLED=true`; production defaults to false. When disabled,
stored Mock connections/models are excluded from catalog pagination and cannot
execute. Existing assets, history and configuration remain stored.

## Current capabilities

| Model | Operations | Declared controls and output |
| --- | --- | --- |
| `mock-image-v1` | `image.generate`, `image.edit` | Square images, up to four reference images, native mask support; a fixed PNG fixture completes synchronously |
| `mock-video-v1` | `video.generate`, `video.image_to_video`, `video.reference_to_video` | 16:9 / 9:16 / 1:1, 720p, 1 / 5 / 10 seconds, up to four references; a fixed MP4 fixture follows a simulated asynchronous lifecycle |

These controls exercise validation and workspace state. They do not imply that
the fixed fixture's pixels, size or duration change to match the prompt or every
selected control. Neither model supports an upstream multi-output batch. The
application may fan out a count of 1–32 into separate durable jobs, each requesting
one output.

Video test scenarios cover success, failure, transient errors and expiry.
The adapter accepts an injected clock; its synthetic remote ID carries enough
state for polling/recovery without network access. Progress and cancellation
exercise the JobRunner contract. Do not describe video IDs/timing as the
wall-clock-independent synchronous behavior of the original PR 0 image fixture.

## Runtime and verification

The JobRunner owns status transitions, retries, local media processing,
persistence and restart recovery. Mock must not call remote services, store its
own database or introduce another application process. Source tests are in
[the adapter tests](../../apps/server/src/providers/mock-provider.test.ts),
[runner tests](../../apps/server/src/jobs/job-runner.test.ts) and server/browser
integration suites. The implementation's capability and validation methods are
the source of truth for detailed input limits.

Use the [contributor setup](../../CONTRIBUTING.md#getting-started) for an isolated
Mock-backed local instance and the [verification matrix](../../CONTRIBUTING.md#verification)
for checks. Mock evidence is separate from paid generation and physical-device
PWA acceptance. The [original PR 0 record](./pr0-mock-provider.md) is retained
only as historical design evidence.
