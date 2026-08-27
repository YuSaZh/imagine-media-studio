# Hold

This file records non-blocking work that cannot currently be proven or completed without external evidence or a later phase. It must not contain secrets.

## Open

### PR 6 GitHub Actions incident evidence

- **Affects:** PR 6 remote verification evidence.
- **Incident windows:** [GitHub incident `y1t7p9fzrlj2`](https://www.githubstatus.com/incidents/y1t7p9fzrlj2) reports that on 2026-08-26 from 15:02 to 15:45 UTC Actions jobs failed to start; delayed starts continued until 17:40 UTC. [GitHub incident `kfspvrz14xr0`](https://www.githubstatus.com/incidents/kfspvrz14xr0) reports Actions workflow runs triggered by pull requests from 22:56 UTC on 2026-08-26, with full recovery beginning at 23:58 UTC on 2026-08-26.
- **Repository impact:** PR 6 commits had been pushed, but their associated Actions runs were not generated (`failed-to-trigger`), so no PR 6 run or job result is available to cite.
- **Current handling:** Keep the PR 6 matrix limited to local checks and placeholders. After the incident windows have passed, trigger a fresh verification run and replace the placeholders; remove this hold after remote acceptance is recorded.

### Authenticated Grok Imagine reference package

- **Affects:** PR 1 final visual classification and PR 7 cross-device polish.
- **Status:** The private authenticated screenshot/video package is unavailable. Public unauthenticated evidence cannot prove strict L3/L4 parity for authenticated Gallery, Viewer, Saved, Collections, settings, task states, or mobile keyboard behavior.
- **Current handling:** Keep the implemented UI and existing visual evidence; do not claim strict L3/L4 completion until the reference package is supplied and reviewed.

### Live external Provider acceptance

- **Affects:** PR 4 real image Providers and PR 5 real video Providers.
- **Status:** No production API credentials or user-approved live endpoints are available in the repository or environment, and secrets must not be requested in source files or logs.
- **Current handling:** PR 4/PR 5 protocol fixtures, injected transports, deterministic Mock workflows, and the remote single-container smoke are accepted without live credentials. Record live credentialed smoke tests as pending unless a safe external test endpoint is explicitly provided.

### Production bundle advisory

- **Affects:** PR 7 performance polish.
- **Status:** The production entry chunk remains above Vite's 500 kB advisory threshold (571.55 kB in the final PR 5 remote quality build); the PR 3 editor route is already split.
- **Current handling:** Defer broader route/vendor splitting to PR 7 and keep the warning non-blocking for PR 5.

### PR 8 provider-output cleanup reconciliation

- **Affects:** PR 8 media consistency and repair.
- **Status:** Provider result manifests are cleared after successful materialization and normal terminal paths perform best-effort cleanup. A process crash after the terminal database commit but before filesystem cleanup can leave temporary provider-result files that are not represented by a durable cleanup queue.
- **Current handling:** Add terminal cleanup reconciliation to the PR 8 media consistency/backup audit. Do not weaken current atomic output handling to hide the gap.

### Dynamic model catalog pagination

- **Affects:** PR 4 live model refresh and future large Provider catalogs.
- **Status:** OpenAI, Gemini, and xAI refresh their live model catalog through the safe Provider transport, but the current refresh consumes one bounded response page. Providers with paginated catalogs larger than the first page require profile-specific pagination support.
- **Current handling:** Keep manual model creation available and add pagination when an official Provider fixture demonstrates a multi-page catalog.

### Static settings controls

- **Affects:** PR 7 PWA polish and PR 8 maintenance settings.
- **Status:** Existing Storage retention and update-notification controls in the Settings shell are not yet wired to durable settings.
- **Current handling:** Connect update behavior in PR 7 and media retention/maintenance behavior in PR 8.

## Resolved

- Default Provider HTTP remains HTTPS-only unless the dedicated, explicit `ALLOW_INSECURE_PROVIDER_HTTP` switch is enabled.
- Provider stage retry budgets are durable across SQLite close/reopen recovery.
