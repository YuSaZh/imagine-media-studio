# Hold

This file records non-blocking work that cannot currently be proven or completed without external evidence or a later phase. It must not contain secrets.

## Open

### Authenticated Grok Imagine reference package

- **Affects:** PR 1 final visual classification and PR 7 cross-device polish.
- **Status:** The private authenticated screenshot/video package is unavailable. Public unauthenticated evidence cannot prove strict L3/L4 parity for authenticated Gallery, Viewer, Saved, Collections, settings, task states, or mobile keyboard behavior.
- **Current handling:** Keep the implemented UI and existing visual evidence; do not claim strict L3/L4 completion until the reference package is supplied and reviewed.

### Live external Provider acceptance

- **Affects:** PR 4 real image Providers and PR 5 real video Providers.
- **Status:** No production API credentials or user-approved live endpoints are available in the repository or environment, and secrets must not be requested in source files or logs.
- **Current handling:** Implement adapters against official protocols with deterministic contract fixtures and local mock HTTP servers. Record live credentialed smoke tests as pending unless a safe external test endpoint is explicitly provided.

### Production bundle advisory

- **Affects:** PR 7 performance polish.
- **Status:** The production entry chunk remains above Vite's 500 kB advisory threshold (564.46 kB in the final PR 4 build); the PR 3 editor route is already split.
- **Current handling:** Defer broader route/vendor splitting to PR 7 and keep the warning non-blocking for PR 4.

### Provider terminal cleanup compensation

- **Affects:** PR 8 media consistency and repair.
- **Status:** Provider result manifests are cleared after successful materialization and normal terminal paths perform best-effort cleanup. A process crash after the terminal database commit but before filesystem cleanup can leave temporary provider-result files that are not represented by a durable cleanup queue.
- **Current handling:** Add terminal cleanup reconciliation to the PR 8 media consistency/backup audit. Do not weaken current atomic output handling to hide the gap.

### Dynamic model catalog pagination

- **Affects:** PR 4 live model refresh and future large Provider catalogs.
- **Status:** OpenAI, Gemini, and xAI refresh their live model catalog through the safe Provider transport, but the current refresh consumes one bounded response page. Providers with paginated catalogs larger than the first page require profile-specific pagination support.
- **Current handling:** Keep manual model creation available and add pagination when an official Provider fixture demonstrates a multi-page catalog.

### Advanced Provider diagnostics and import

- **Affects:** PR 6 custom Provider management.
- **Status:** PR 4 provides profile selection, Base URL, write-only API key/custom headers, configuration JSON, connection test, live model refresh, and manual Capability overrides. Declarative import, redacted request preview, dry run, simulated response, and advanced debugging belong to the PR 6 custom Adapter workflow.
- **Current handling:** Implement these controls with the declarative/JavaScript Adapter boundary in PR 6 rather than exposing incomplete controls in PR 4.

### Static settings controls

- **Affects:** PR 7 PWA polish and PR 8 maintenance settings.
- **Status:** Existing Storage retention and update-notification controls in the Settings shell are not yet wired to durable settings.
- **Current handling:** Connect update behavior in PR 7 and media retention/maintenance behavior in PR 8.

## Resolved

- Default Provider HTTP remains HTTPS-only unless the dedicated, explicit `ALLOW_INSECURE_PROVIDER_HTTP` switch is enabled.
- Provider stage retry budgets are durable across SQLite close/reopen recovery.
