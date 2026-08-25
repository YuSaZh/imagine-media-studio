# OpenAI PR4 Fixtures

`openai-images-v1` and `openai-responses-image-v1` are synchronous image profiles in PR4. They do not expose a provider-side poll operation, so their required `poll-running.json`, `poll-completed.json`, and `poll-failed.json` files are explicit `not_applicable` fixtures. Streaming cases live in each profile's `stream.sse` fixture.

Responses connection probes use the `/models` endpoint and the profile keeps its own success and unauthorized fixtures.
Each profile also includes a bounded `/models` catalog fixture covering known image models, an unknown compatible image model, and a non-image model that must be filtered.
