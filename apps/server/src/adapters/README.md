# Trusted JavaScript adapters

This directory contains the server-side kernel for administrator-installed adapter code. An installed adapter is trusted application code, not an untrusted sandbox. `worker_threads`, resource limits, source preflight, and output limits reduce accidental damage but cannot provide a security boundary against a malicious script. Installation must therefore remain behind the existing administrator authorization gate.

An adapter is stored as exactly `/data/adapters/<id>/manifest.json` and `/data/adapters/<id>/adapter.mjs`. The source is loaded into a fresh worker for each call. The worker receives only a bounded provider view, the manifest-declared secrets, request metadata, and verified input bytes. It has no database handle, storage path, file descriptor, or environment view supplied by the host.

Production uses the emitted `worker-entry.js` from the server build (`tsc` output). Tests and future packaging may inject an explicit `workerEntryUrl` through `createAdapterWorkerFactory`; the runtime entry must be supplied by the host and is never resolved through `tsx` or a development loader.

Network access is an RPC to the injected `SafeHttpPort`. The host checks the manifest's exact HTTPS host allowlist and bounded headers/body before calling that port. The port remains responsible for central network policy, DNS pinning, redirect-target revalidation, and response parsing.

The source preflight rejects common imports and runtime escape tokens as a best-effort policy. It is intentionally not described as a sandbox and does not replace code review, administrator authorization, or a future process/container isolation design.

Worker result envelopes are local contract-like values. `resultExpiresAt` is an ISO-8601 string at this boundary and must be converted to the shared `Date` form by the integration wrapper before persistence; completed results must contain at least one bounded asset.
