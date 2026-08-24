# Third-party notices

## PR 0 review status

As of PR 0, this project has only reviewed the following upstream repositories. It has not copied, rewritten, linked, bundled, or distributed any code, tests, UI, visual assets, or other artifacts from them.

Consequently, no code or assets from these reviewed repositories are incorporated into the product, and no attribution notice for incorporated material from them is currently required. This section records review provenance only; it is not a claim that upstream software is part of this project.

| Repository | Reviewed revision | License |
| --- | --- | --- |
| [`CookSleep/gpt_image_playground`](https://github.com/CookSleep/gpt_image_playground) | [`997d79b35e60406d6ab6da26d0a9179a724820c7`](https://github.com/CookSleep/gpt_image_playground/commit/997d79b35e60406d6ab6da26d0a9179a724820c7) | MIT |
| [`lidge-jun/ima2-gen`](https://github.com/lidge-jun/ima2-gen) | [`b7369f8a4c042249dcaa282270421d0faa7ed4fe`](https://github.com/lidge-jun/ima2-gen/commit/b7369f8a4c042249dcaa282270421d0faa7ed4fe) | MIT |
| [`alasano/sora-2-playground`](https://github.com/alasano/sora-2-playground) | [`54d746350c2e0705bbfcec65cf27048aa6cbe556`](https://github.com/alasano/sora-2-playground/commit/54d746350c2e0705bbfcec65cf27048aa6cbe556) | MIT |

## Gate for future reuse

Before any code, tests, fixtures, or assets from a reviewed repository are copied, substantially rewritten, linked, bundled, or distributed by this project, the implementing change must:

1. pin and re-verify the exact upstream revision and license;
2. update [`docs/third-party/reuse-audit.md`](docs/third-party/reuse-audit.md) with the upstream file, target file, reuse mode, material changes, tests, and copyright-header decision;
3. add the complete applicable upstream copyright and MIT permission notice to this file;
4. retain file-level attribution where needed for clear traceability;
5. verify that no prohibited upstream UI, styling, branding, or visual assets have entered the project.

Mere review or architectural comparison does not authorize reuse.
