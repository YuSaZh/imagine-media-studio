# Automation Agent Guide

Read the [root guide](../AGENTS.md), [RELEASE.md](../RELEASE.md), and the relevant
workflow plus scripts before changing CI or publishing behavior.

- CI validates lint, types, unit/contracts, production build, eight browser
  viewports, and isolated Docker smoke. Keep checks available to pull requests
  without production credentials. Do not weaken acceptance to work around a failure.
- Keep local and GitHub commands, tool versions, test coverage, and runtime setup
  aligned through shared scripts. Follow the [CI parity rules](../CONTRIBUTING.md#local-and-github-ci-parity);
  ordinary changes need affected-area checks, while a release requires complete
  local CI on the final prepared source before pushing the release commit and
  tag. Filtered regressions must not be reported as complete CI acceptance.
- Test Image is manually dispatched on `main` and requires successful CI for the
  same commit. Build a unique multi-architecture candidate, smoke its immutable
  digest, then attach `test` and `test-sha-*` to that verified digest.
- Test publication must not update stable tags. Keep test attestation storage in
  GitHub (`push-to-registry: false`) so it does not add a second tagged GHCR entry.
  BuildKit provenance/SBOM and the actual image remain enabled.
- A stable tag starts release validation and calls CI for quality and all eight
  browser viewports on that same commit. Require the commit to be on `main` and
  validate package versions and CHANGELOG before building. After complete local
  CI passes, push the release source and tag without a separate wait for remote
  branch CI.
- The release CI call skips its source Docker build because release smoke tests
  the single multi-architecture candidate by digest. Regular branch/PR CI keeps
  Docker smoke enabled. Promote that verified digest and create GitHub Release
  only after all required gates pass; never rebuild during promotion.
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
