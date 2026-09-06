# PR 8 Security Hardening

Historical security milestone. The optional-password interstitial described
below predates the current account authentication. Use the
[current architecture](./overview.md) and [RELEASE.md](../../RELEASE.md) for
current access and deployment guidance.

Status: **Local and GitHub Actions acceptance passed.**

This record covers the first PR 8 security-hardening milestone. It does not
claim completion of backup, SQLite integrity, media repair, release, or the
remaining PR 8 acceptance boundary.

## Cloud metadata boundary

`NetworkPolicy` keeps known cloud metadata targets forbidden even when a
deployment explicitly enables private-network or loopback access.

| Provider | Address | Source |
| --- | --- | --- |
| AWS, Google Cloud, Microsoft Azure | `169.254.169.254` | [AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html), [Google Cloud](https://cloud.google.com/compute/docs/metadata/overview), [Microsoft Azure](https://learn.microsoft.com/en-us/azure/virtual-machines/instance-metadata-service) |
| AWS EC2 IMDS IPv6 | `fd00:ec2::254` | [AWS EC2 documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html) |
| Google Compute Metadata IPv6 | `fd20:ce::254` | [Google Cloud documentation](https://cloud.google.com/compute/docs/metadata/overview) |

Addresses are canonicalized with `ipaddr.js`, so IPv4-mapped IPv6 cannot evade
the IPv4 rule. Validation rejects a literal target, any matching address in a
DNS answer set, and a matching redirect destination before opening the next
connection. Errors retain a stable code without echoing the rejected URL.

## Public access warning

When `APP_PASSWORD` is absent, `/internal/auth/status` classifies the request
hostname as local or potentially public on the server. Localhost, loopback,
RFC 1918 addresses, and IPv6 unique-local addresses do not trigger the warning;
public IP addresses and non-IP hostnames do.

The browser shows a startup security interstitial for a potentially public
host. It tells the operator to set `APP_PASSWORD` and restart, while preserving
the plan's optional-password semantics through an explicit **Continue without
password** action. Acknowledgement lasts only for the current `AuthGate` mount.
It does not grant authentication, change API authorization, expose the request
host, or persist a bypass in browser storage.

## Existing controls retained

- DNS answers are fully classified and the selected address is pinned for the
  connection.
- Redirect destinations are validated on every hop and cross-origin credentials
  are removed.
- Provider HTTP, remote media, and Trusted Adapter HTTP use the same bounded
  transport policy with their explicit configuration boundaries.
- Same-origin write checks, HttpOnly/SameSite cookies, CSP, redacted DTOs/logs,
  and PWA cache exclusions remain unchanged.

## Local evidence

- Full workspace unit suite: 110 test files / 938 tests passed.
- Workspace lint, typecheck, and production build passed.
- E2E TypeScript compilation and `git diff --check` passed.
- Dedicated tests cover private-network opt-in, literal and DNS metadata
  addresses, IPv4-mapped IPv6, redirect revalidation, public/local host status,
  schema backward compatibility, interstitial acknowledgement, offline status,
  authentication-required status, accessibility semantics, and warning styles.

## GitHub Actions evidence

Commit `20f2921` passed all 13 jobs in [GitHub Actions run
33179394160](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33179394160),
including quality/build, the single-container Docker smoke, the base browser
suite, all eight PR 7 regression viewports, and both representative
axe/performance jobs.
