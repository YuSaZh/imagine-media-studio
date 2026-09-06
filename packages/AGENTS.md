# Shared Package Agent Guide

Read the [root guide](../AGENTS.md). These packages define boundaries used by
both the browser and server, not a separate application or runtime service.

- `shared` owns Zod schemas, internal request/response shapes, generation/model
  policies, and pure reusable helpers. Keep it portable between browser and Node;
  do not introduce server credentials, filesystem access, or React state here.
- `provider-contract` owns adapter interfaces and normalized capabilities,
  requests, results, and errors. Keep vendor payloads in server adapters.
- `testkit` supplies deterministic reusable fixtures/helpers. Use synthetic
  secrets and local fixtures, never production credentials or live HTTP defaults.
- Reuse the canonical schema/type instead of mirroring it in an app. Update
  parsers, DTOs, adapters, persistence, and UI consumers together when a contract
  changes. Check stored jobs/settings and configuration import compatibility.
- Runtime validation must agree with TypeScript types. Preserve bounds, finite
  numbers, allowed fields, and safe handling of malformed external data.
- Preserve source attribution for adapted pure algorithms. Record new reuse in
  the root audit before implementation.
- Test changed contracts and affected consumers, then run workspace typecheck,
  tests, and build per [CONTRIBUTING.md](../CONTRIBUTING.md#verification).
  An exported type or schema change can affect both apps even if only one caller
  is visible in the edited file. Read each app's guide before editing its code.
