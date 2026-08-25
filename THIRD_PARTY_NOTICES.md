# Third-party notices

## Reviewed repositories and incorporated PR 3 algorithms

PR 0 reviewed the repositories below. PR 3 subsequently approved selective adaptation of two pure algorithm subsets from `CookSleep/gpt_image_playground`: Mask target/coverage logic and viewport transform math. No donor UI, pages, components, CSS, Store, icons, media, or visual assets are incorporated. The other repositories remain reference-only.

| Repository | Reviewed revision | License |
| --- | --- | --- |
| [`CookSleep/gpt_image_playground`](https://github.com/CookSleep/gpt_image_playground) | [`997d79b35e60406d6ab6da26d0a9179a724820c7`](https://github.com/CookSleep/gpt_image_playground/commit/997d79b35e60406d6ab6da26d0a9179a724820c7) | MIT |
| [`lidge-jun/ima2-gen`](https://github.com/lidge-jun/ima2-gen) | [`b7369f8a4c042249dcaa282270421d0faa7ed4fe`](https://github.com/lidge-jun/ima2-gen/commit/b7369f8a4c042249dcaa282270421d0faa7ed4fe) | MIT |
| [`alasano/sora-2-playground`](https://github.com/alasano/sora-2-playground) | [`54d746350c2e0705bbfcec65cf27048aa6cbe556`](https://github.com/alasano/sora-2-playground/commit/54d746350c2e0705bbfcec65cf27048aa6cbe556) | MIT |

### CookSleep/gpt_image_playground MIT notice

The following notice applies to the selectively adapted PR 3 algorithm portions identified in `docs/third-party/reuse-audit.md` and their file-level source headers:

```text
MIT License

Copyright (c) 2026 CookSleep

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependency notice policy

Imagine Media Studio uses third-party packages installed from the exact versions in `pnpm-lock.yaml`. The table below records the direct browser runtime dependencies introduced or used by the PR 1 interface. It is an inventory, not a replacement for the complete license text distributed with each package.

| Package | Version | License |
| --- | --- | --- |
| `@radix-ui/react-dialog` | `1.1.23` | MIT |
| `@radix-ui/react-popover` | `1.1.23` | MIT |
| `@radix-ui/react-tooltip` | `1.2.16` | MIT |
| `@tanstack/react-query` | `5.102.3` | MIT |
| `@tanstack/react-virtual` | `3.14.10` | MIT |
| `lucide-react` | `1.34.0` | ISC |
| `react` | `19.2.8` | MIT |
| `react-dom` | `19.2.8` | MIT |
| `react-router-dom` | `7.18.2` | MIT |
| `workbox-window` | `7.4.1` | MIT |
| `zustand` | `5.0.15` | MIT |

Before a release artifact is published, the release process must derive a complete production dependency inventory from the frozen lockfile and retain each applicable package copyright and full license text in the distributed notices. Transitive dependencies are included by that release inventory even though this source-level summary lists only direct browser dependencies. Package metadata and the license files shipped in the installed package remain authoritative.

The Lucide icons used by the interface are imported from `lucide-react` and are covered by its ISC license; they are not copied from Grok or a reviewed donor project. PR 1 Mock media is project-authored and documented separately in [`docs/third-party/pr1-asset-provenance.md`](docs/third-party/pr1-asset-provenance.md).

### PR 2 server media dependencies

The PR 2 server foundation adds the following exact direct runtime dependencies. Sharp's platform package dynamically uses the prebuilt libvips distribution selected by pnpm for the target operating system, so that library is recorded separately.

| Package | Version | License |
| --- | --- | --- |
| `@fastify/multipart` | `10.1.1` | MIT |
| `file-type` | `22.0.2` | MIT |
| `ipaddr.js` | `2.5.0` | MIT |
| `p-queue` | `9.3.3` | MIT |
| `range-parser` | `1.3.0` | MIT |
| `sharp` | `0.35.3` | Apache-2.0 |
| `undici` | `8.10.0` | MIT |
| `@img/sharp-libvips-*` | `1.3.2` | LGPL-3.0-or-later |

The release notice generator must include the exact platform-specific Sharp/libvips packages present in the published image and retain the corresponding complete license texts. Nothing in this inventory changes the MIT license of project-authored source code.

## Gate for future reuse

Before any code, tests, fixtures, or assets from a reviewed repository are copied, substantially rewritten, linked, bundled, or distributed by this project, the implementing change must:

1. pin and re-verify the exact upstream revision and license;
2. update [`docs/third-party/reuse-audit.md`](docs/third-party/reuse-audit.md) with the upstream file, target file, reuse mode, material changes, tests, and copyright-header decision;
3. add the complete applicable upstream copyright and MIT permission notice to this file;
4. retain file-level attribution where needed for clear traceability;
5. verify that no prohibited upstream UI, styling, branding, or visual assets have entered the project.

Mere review or architectural comparison does not authorize reuse.
