# Third-party reference remotes

Audit date: 2026-08-25 (Asia/Tokyo)

These remotes are review inputs, not product dependencies. Do not merge their branches, track their UI, copy their repository trees, or push to them. Review exact commits without checking out upstream code over the project worktree.

## Registry

| Local remote name | Role | URL | Default branch | Reviewed HEAD | License |
| --- | --- | --- | --- | --- | --- |
| `donor-gpt-image` | Possible non-visual image-logic donor | `https://github.com/CookSleep/gpt_image_playground.git` | `main` | `997d79b35e60406d6ab6da26d0a9179a724820c7` | MIT |
| `reference-ima2` | Architecture/behavior reference only | `https://github.com/lidge-jun/ima2-gen.git` | `main` | `b7369f8a4c042249dcaa282270421d0faa7ed4fe` | MIT |
| `reference-sora` | Async-video behavior reference only | `https://github.com/alasano/sora-2-playground.git` | `master` | `54d746350c2e0705bbfcec65cf27048aa6cbe556` | MIT |

The authoritative audit, permitted topics, exclusions, and license obligations are in [`reuse-audit.md`](./reuse-audit.md).

## Optional local setup

Adding a remote does not make it truly read-only, so set a deliberately unusable push URL as a local safeguard:

```bash
git remote add donor-gpt-image https://github.com/CookSleep/gpt_image_playground.git
git remote set-url --push donor-gpt-image DISABLED

git remote add reference-ima2 https://github.com/lidge-jun/ima2-gen.git
git remote set-url --push reference-ima2 DISABLED

git remote add reference-sora https://github.com/alasano/sora-2-playground.git
git remote set-url --push reference-sora DISABLED
```

Remote configuration is local metadata and must not be treated as proof of the reviewed revision. Fetch and inspect the pinned commits explicitly:

```bash
git fetch --no-tags donor-gpt-image 997d79b35e60406d6ab6da26d0a9179a724820c7
git fetch --no-tags reference-ima2 b7369f8a4c042249dcaa282270421d0faa7ed4fe
git fetch --no-tags reference-sora 54d746350c2e0705bbfcec65cf27048aa6cbe556

git show --no-ext-diff --stat 997d79b35e60406d6ab6da26d0a9179a724820c7
git show --no-ext-diff --stat b7369f8a4c042249dcaa282270421d0faa7ed4fe
git show --no-ext-diff --stat 54d746350c2e0705bbfcec65cf27048aa6cbe556
```

Use `git show <sha>:<path>` for a narrowly scoped review. Do not add an upstream branch to local application code, and do not run upstream install/build scripts in this repository.

## Refresh procedure

Default branches move. A later PR may review a newer revision only when it:

1. records the new full SHA and its review date in both third-party documents;
2. rechecks the license file at that exact SHA;
3. reviews the diff from the previously pinned SHA;
4. updates candidate files, risks, tests, and attribution decisions;
5. keeps UI, visual assets, and excluded product architecture out of this repository.

PR 0 status: **remotes are documented for inspection only; no upstream source has been imported.**
