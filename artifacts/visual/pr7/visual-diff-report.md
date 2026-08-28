# PR7 visual diff report

Screenshots are captured at the approved PR7 viewports with animations disabled. The responsive gallery state uses the fixed PR1 Mock fixture; the production cold-offline and unknown-marker checks run at every PR7 viewport. No pixel comparison was run locally.

Keyboard screenshots named `*-keyboard-mock.png` use an injected visualViewport and CSS safe-area mock for geometry coverage. They are not real iOS or Android keyboard/device evidence.

| Viewport | State | Baseline / diff |
| --- | --- | --- |
| desktop-1920x1080 | gallery | CI artifact only |
| desktop-1440x900 | gallery | CI artifact only |
| desktop-1280x800 | gallery | CI artifact only |
| tablet-1024x1366 | gallery | CI artifact only |
| tablet-834x1194 | gallery | CI artifact only |
| mobile-430x932 | gallery | CI artifact only |
| mobile-390x844 | gallery | CI artifact only |
| mobile-360x800 | gallery | CI artifact only |
| mobile-430x932 | keyboard + safe-area mock | CI artifact only |
| mobile-390x844 | keyboard + safe-area mock | CI artifact only |
| mobile-430x932 | mobile selection | CI artifact only |
| mobile-390x844 | mobile selection | CI artifact only |
| tablet-1024x1366 | tablet menu / selection | CI artifact only |
| tablet-834x1194 | tablet menu / selection | CI artifact only |
| mobile-430x932 | mobile image viewer / video viewer | CI artifact only |
| mobile-390x844 | mobile image viewer / video viewer | CI artifact only |
