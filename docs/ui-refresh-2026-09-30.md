# EKIKOKO UI refresh — 2026-09-30

## Design intent

Rebuild the hierarchy around the actual task: identify the current station at a glance, choose a stop, or switch to a readable on-board display. The request explicitly permits departing from the previous instrument-panel and 3D signboard design.

The new interface uses a light blue-gray canvas, dark typography, flat blue actions, restrained outlines, and consistent 6–8px control corners. Welcome copy precedes the location request. The static route illustration is native SVG; no images, external fonts, or UI dependencies are introduced.

## Changes

- Replaced the layered 5,000+ line stylesheet with one coherent stylesheet, retaining the existing single-run guide diagrams.
- Rebuilt the welcome screen and added an immediately accessible Japanese/English switch.
- Kept the oversized station name, with route colors as supporting information.
- Placed the destination action above on-board and guide controls. Secondary controls adapt to one column when space or text size requires it.
- Replaced the settings console with labeled rows and clear current values.
- Unified destination, guide, and Plus sheets, with sticky titles and close buttons.
- Added collision-aware, 13px map labels, route-colored markers with a dark/light outline, and explicit selection states in search and route rows.
- Restored marker focus synchronously after a map redraw, so immediately repeated key presses are not lost.
- Fixed closing/opening reversal for settings and guarded delayed focus callbacks against stale state.
- Added descriptive GPS loading and on-board GPS failure text.
- Hid unconfigured advertising placeholders. Configured advertisements remain supported.
- Updated the app, manifest, and privacy-page initial surface colors. Fresh installations default to light/blue; saved preferences remain unchanged.
- Updated the service worker to `ekikoko-v37` using the repository cache tool.

## Preserved behavior

Vanilla HTML/CSS/JavaScript, every pre-existing HTML ID, PWA support, Japanese/English, all three accent palettes, location processing, station data, destination Plus gating, demo enable/disable, billing configuration, route filtering, arrival alerts, ride history, wake lock, and feedback/data deletion remain available.

The on-board surface remains `#000` during entry, display, and exit. Reduced-motion settings continue to be handled in CSS and JavaScript. The guide duration remains 1600ms, preserving the earlier timing correction.

## Validation

Chrome/Playwright, 390×844px, 320×740px, 1280×900px, and a short 390×520px viewport. Station success uses a simulated Shinjuku location (35.6896, 139.7006); screenshots are not evidence of live GPS accuracy.

- 28 principal-flow checks: welcome, location, settings, all accents, light/dark, on-board, Plus demo, map/search/lines, selection/confirmation, zero results, guide, keyboard focus, rapid reversal, persistence, and GPS denial.
- 16 additional checks: ID preservation, both translation dictionaries, 200% text enlargement across six surfaces, short-viewport confirmation, pointer map operations, privacy page, GPS requesting/timeout, on-board error text, and a real service-worker offline reload.
- No JavaScript runtime errors in these checks.
- JavaScript syntax and whitespace checks pass.

Stripe production checkout and an actual train journey are outside the simulated validation. Their underlying integrations are not changed.

## Review and release

Base commit: `a8d9722`, from `claude/practical-babbage-xrtvmo`.
Review branch: `codex/ekikoko-ui-refresh`.
The review branch is separate from the GitHub Pages deployment branch. Publishing requires merging the reviewed change into the deployment branch.
