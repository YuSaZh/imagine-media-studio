# Custom Provider examples

These files are safe, placeholder-only starting points for the PR 6 Custom
Provider workflow. They are not live Provider configurations, and they do not
contain an endpoint, API key, access token, or result URL.

## Declarative HTTP

The declarative examples can be imported from the Settings page under
Providers -> Manage adapter:

- [`sync-image.json`](./sync-image.json) demonstrates a synchronous image
  result, JSON request body, a required `style` request-schema field,
  capability limits, and a Base64 result path.
- [`async-video.yaml`](./async-video.yaml) demonstrates an asynchronous video
  submit/poll pair, form request body, encoded remote-job path, status and
  progress mappings, capability limits, and a result URL path.
- [`multipart-image-edit.json`](./multipart-image-edit.json) demonstrates a
  multipart image edit with role-selected source and mask files.

Configure the Provider Base URL separately in the application. The `apiKey`
name is only a `secretRef`; enter the write-only secret through Provider
settings. Never add a secret or credential-bearing query parameter to an
example file. The Dry Run, redacted request preview, simulated response,
path test, and capability preview can be used before saving a revision.

## Trusted JavaScript

The [`trusted-js/`](./trusted-js/) pair demonstrates the administrator-only
Trusted JavaScript boundary:

- [`manifest.json`](./trusted-js/manifest.json) declares the revision digest,
  capabilities, exact placeholder host allowlist, required secret name, and
  worker resource limits.
- [`adapter.mjs`](./trusted-js/adapter.mjs) is intentionally dependency-free
  trusted server-side code. It uses only the host-injected `SafeHttpPort`; it
  does not import packages, dynamically install npm dependencies, access
  process globals, or perform direct network I/O.

Install Trusted JavaScript only after reviewing the source, allowed hosts,
secret names, and limits. It is trusted application code, not a sandbox for
untrusted scripts. The manifest digest must match the exact source bytes; the
example test checks this before the file is used.

The hostname `api.provider.invalid` is reserved as a documentation placeholder
and must be replaced with the exact hostname of the Provider before use. The
examples intentionally leave response payloads and actual media URLs to the
Provider-specific integration.

See [`PR 6 verification`](../../docs/architecture/pr6-verification.md),
[`adapter runtime notes`](../../apps/server/src/adapters/README.md), and the
repository [security rules](../../AGENTS.md) for the runtime boundary.
