# Server Agent Guide

Read the [root guide](../../AGENTS.md) and
[current architecture](../../docs/architecture/overview.md).

## Requests and Providers

- Keep routes thin: validate inputs with shared schemas, enforce account/admin
  authorization, use existing services/repositories, and return redacted DTOs.
  Asset, job, collection, settings, media, and SSE paths must preserve ownership.
- Use the central HTTP client/transport for Providers and remote media. Preserve
  address validation, DNS pinning, redirect checks, credential stripping,
  response-size limits, timeouts, and explicit private-network/HTTP opt-ins.
  Cloud metadata addresses remain forbidden.
- Keep protocol selection, payload mapping, result normalization, and fallback
  inside adapters. Catalog or connection success is not generation acceptance.
- Alternative image protocols may be tried only for classified incompatibility
  responses, with bounded attempts and compatible inputs. Never treat every
  error as permission to resubmit; ambiguous submission, timeout, authentication,
  quota, rate-limit, and server errors require their existing distinct handling.
- Derive capabilities and wire protocol from stored model policy on the server,
  and snapshot them for durable jobs. Client input cannot override locked policy.
- Trusted JavaScript remains administrator-installed trusted code, not a sandbox
  for hostile scripts. Preserve immutable revisions, lifecycle references,
  bounded worker calls, injected HTTP, and secret minimization. Read the
  [adapter runtime guide](./src/adapters/README.md) before changing this boundary.

## Jobs, Storage, and Recovery

- SQLite is authoritative. Commit job transitions and outbox events before
  notifying clients; retain revision checks and durable retry budgets.
- Keep submit, poll, download, and processing work bounded. Resume known remote
  jobs after restart; do not blindly resubmit uncertain work without idempotency.
- Add migrations instead of editing shipped SQL. Update `migrations/manifest.json`
  for new entries; preserve existing checksums and test upgrade from old data.
- Persist relative media paths. Keep traversal/symlink checks, bounded streaming,
  signature/MIME validation, atomic publication, original downloads, and Range
  support. Do not rely on expiring upstream URLs as permanent asset storage.
- Backup/restore and repair must retain ownership checks and runtime exclusion.
  Preserve ambiguous files and locks; never automatically replace live data or
  delete unknown orphans. Follow the relevant archive/integrity/media guides
  linked from the architecture overview.

## Verification

Use temporary databases and injected transports/fixtures by default. Cover the
changed failure path, account isolation, cancellation, and recovery as relevant.
Protocol changes need request/response contract cases, including rejection of
unsafe or unsupported fallback. Database changes need migration/integrity tests;
runtime/storage changes need isolated restart/archive/media smoke where affected.
Use the [verification matrix](../../CONTRIBUTING.md#verification). Record the
scope of any explicitly authorized live Provider test without exposing secrets.
