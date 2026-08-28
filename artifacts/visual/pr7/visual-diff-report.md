# PR7 visual diff report

These screenshots capture the approved PR7 viewports with animations disabled. The viewport captures use the fixed PR1 Mock fixture to keep the responsive workspace deterministic. This report records functional and layout evidence only. No baseline image comparison or pixel diff was run; pixel-level parity is unassessed.

## Viewport captures

| Viewport | Screenshot | State | Pixel diff |
| --- | --- | --- | --- |
| desktop-1920x1080 | [PNG](./desktop-1920x1080.png) | Responsive workspace/gallery, fixed PR1 Mock fixture | Not run |
| desktop-1440x900 | [PNG](./desktop-1440x900.png) | Responsive workspace/gallery, fixed PR1 Mock fixture | Not run |
| desktop-1280x800 | [PNG](./desktop-1280x800.png) | Responsive workspace/gallery, fixed PR1 Mock fixture | Not run |
| tablet-1024x1366 | [PNG](./tablet-1024x1366.png) | Responsive workspace/gallery, fixed PR1 Mock fixture | Not run |
| tablet-834x1194 | [PNG](./tablet-834x1194.png) | Responsive workspace/gallery, fixed PR1 Mock fixture | Not run |
| mobile-430x932 | [PNG](./mobile-430x932.png) | Responsive workspace/gallery, fixed PR1 Mock fixture | Not run |
| mobile-390x844 | [PNG](./mobile-390x844.png) | Responsive workspace/gallery, fixed PR1 Mock fixture | Not run |
| mobile-360x800 | [PNG](./mobile-360x800.png) | Responsive workspace/gallery, fixed PR1 Mock fixture | Not run |

## Production representative flow

The production representative flow runs against the built application and persistent in-process server with the deterministic Mock Provider. The cold-offline gallery flow and unknown-marker fail-closed check run on all eight PR7 viewport projects. Install, Settings, and responsive visual checks also run on all eight projects.

The flow verifies that an authenticated gallery can create and display a local Mock asset, that the production Service Worker controls the page, and that the Composer draft, gallery snapshot, and derived thumbnail survive an offline reload. While offline, generation remains disabled with no job POST, browser state contains no serialized credentials, and reconnecting triggers the expected auth and jobs refresh. It also verifies the fail-closed state for an unknown offline marker with no gallery snapshot.
