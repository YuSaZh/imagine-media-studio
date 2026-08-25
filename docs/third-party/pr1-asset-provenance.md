# PR 1 Asset Provenance

## Scope

This record covers the neutral Mock media distributed from `apps/web/public/mock-media/` for the PR 1 UI Shell. These files are product fixtures, not Provider output, visual-reference captures, or third-party demonstration media.

## Creation Record

- Created for this repository on 2026-08-25.
- Generated locally with ImageMagick `6.9.12-98 Q16` using geometric drawing and raster compositing operations.
- Inputs were project-authored shapes, layout instructions, and color values only.
- No photograph, illustration, font file, donor-project asset, Grok asset, third-party image, or user media was supplied as an input.
- The private/public Grok reference captures were used only to document high-level layout relationships. Their pixels were not copied, transformed, traced, or embedded in these fixtures.
- The fixtures are released with this repository under its MIT license. No separate upstream copyright notice applies.

## Inventory

The dimensions and SHA-256 values below describe the files present at the time of this record.

| File | Pixel dimensions | SHA-256 |
| --- | --- | --- |
| `study-01-portrait.png` | 832x1248 | `0a537b1218c0c15491aabf05444127f0b0151536eb7c28cf13f701054fe17514` |
| `study-02-landscape.png` | 1200x800 | `0f664cf8be21dd779624b083d69bf18b6cdfac4c28fe1f9a572746b2f6439f0a` |
| `study-03-square.png` | 1024x1024 | `6a97233441951b22a4b5f887efb955627a27858e514fd1b9316c1328fc92f223` |
| `study-04-portrait.png` | 832x1248 | `7b8d7500d6ac9634ade41a098942521a892c97b62897b3136f0e682369df2e95` |
| `study-05-wide.png` | 1536x864 | `ee9aa50299a9ff4d21d5db39f68134e5ef73e07daf140ed04747b765d73cea22` |
| `study-06-portrait.png` | 832x1248 | `c30a6ad35467980dcd9682d6f73e7f79a69af8070ad3cb3ada7d8c4117db191d` |
| `study-07-square.png` | 1024x1024 | `dfab2191e7926a03b00e3630303068f6329fedaae5db515b5d49d1fb80e6ba1b` |
| `study-08-landscape.png` | 1200x800 | `f620c0c13db67ce68f6439b9fa7cdf034a317a738e7632012438d47a16753da5` |
| `study-09-portrait.png` | 832x1248 | `66ec647a4085f8706c591281a03fa0e4dfe4b6608eebc42198826bbeb749375b` |
| `study-10-wide.png` | 1536x864 | `74e461332f1623532980caa6f2948bf8864b27488e8b43d52936029f2e70b352` |
| `study-11-square.png` | 1024x1024 | `ed1d5125bfafa4cd09b2414dd1f74803129cb78f1eef4bb5cf18a6361beab29b` |
| `study-12-portrait.png` | 832x1248 | `bbcd5bcfb4bb90ff9def57c59f0d216b55aaddf218ac8591678ad80e78426936` |
| `study-13-vertical.png` | 900x1600 | `14cd8082c3422703187a951803e647d515888700e9f6e389823ab6a49883e493` |

If a fixture is regenerated or optimized, update this table in the same change. The inventory can be refreshed without opening the images:

```bash
identify -format '%f|%wx%h\n' apps/web/public/mock-media/*.png
sha256sum apps/web/public/mock-media/*.png
```

## Delivery Boundary

- Fixture paths are deterministic and contain no remote URL or credential.
- The same PNG may act as an image preview or a video Poster in PR 1; it is not represented as a playable video.
- Mock media and PWA screenshots are excluded from Workbox precache. Runtime media caching is deferred to PR 7.
- Runtime library licenses and the notice-retention policy are recorded in the repository-root `THIRD_PARTY_NOTICES.md`.
