# Automation Agent Guide

Read the [root guide](../AGENTS.md), [RELEASE.md](../RELEASE.md), and the relevant
workflow plus scripts before changing CI or publishing behavior.

- CI validates lint, types, unit/contracts, production build, eight browser
  viewports, and isolated Docker smoke. Keep checks available to pull requests
  without production credentials. Do not weaken acceptance to work around a failure.
- Test Image is manually dispatched on `main` and requires successful CI for the
  same commit. Build a unique multi-architecture candidate, smoke its immutable
  digest, then attach `test` and `test-sha-*` to that verified digest.
- Test publication must not update stable tags. Keep test attestation storage in
  GitHub (`push-to-registry: false`) so it does not add a second tagged GHCR entry.
  BuildKit provenance/SBOM and the actual image remain enabled.
- Stable release validates a semantic version tag and package versions, publishes
  a candidate, verifies its digest, then promotes stable tags and GitHub Release.
  Never rebuild during promotion or publish success before the required gates.
- Preserve minimum per-job permissions, secret handling, serialized publication,
  and cleanup on failure. Pin new or updated publishing actions to reviewed full
  commit SHAs. Keep dependency/action upgrades separately reviewable.
- Shell input is code: quote variables and validate tags/digests. Do not interpolate
  untrusted PR text into shell commands or expose secrets through diagnostics.
- Docker smoke must use unique projects, data, and ports. Never run smoke scripts
  with the default Compose namespace against a maintainer's deployment.
- Use `pnpm test:release` for publishing/script changes and `bash -n` for changed
  shell scripts. Validate workflow YAML; run the affected isolated smoke for actual
  runtime changes. Update operator guidance when tags or upgrade behavior change.
- Pushing source, dispatching Test Image, tagging a release, and deploying are
  distinct actions. Execute only those covered by the maintainer's authorization.
