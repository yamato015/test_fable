# EKIKOKO UI refresh — 2026-09-30

## Design intent

Rebuild the hierarchy around the actual task: identify the current station at a glance, choose a stop, or switch to a readable on-board display. The request explicitly permits departing from the previous instrument-panel and 3D signboard design.

The new interface uses a subtly warm white canvas, ink-colored typography, restrained outlines, and task-specific layouts rather than repeated rounded cards. Welcome copy precedes the location request. The route illustration is native SVG; no images, external fonts, or UI dependencies are introduced.

## Color roles — not a full-screen brand tint

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#f7f6f2` | `#1d201d` |
| Main text | `#262723` | `#eeefe9` |
| Supporting text | `#64655f` | `#b6bbb0` |
| Sheet surface | `#fffefa` | `#242824` |
| Decorative rule | `#d9d8d0` | `#464c44` |
| Control boundary | `#83857b` | `#87917f` |
| Primary action / its text | `#292d27` / `#fcfcf7` | `#e8ebe1` / `#20231e` |
| Blue state accent | `#355f86` | `#aac3db` |

Large neutral actions, ordinary links, settings values, feature icons, and destination arrows no longer use a blue wash. The welcome route is gray, with only the current-position marker accented. Accent colors remain on current-location, selection, focus, and meaningful status indicators. Existing amber/pink preferences and official route colors are preserved; location rings retain a separate blue signal. Error status remains red.

Station measurements are separated by a thin rule, and route labels are 13px rather than 12px. Dark surfaces are charcoal rather than navy. Initial HTML, CSS, app mode colors, manifest, and privacy metadata match; early dark CSS tokens prevent a light flash while the app script loads. On-board backgrounds remain fully black.

## Typography and welcome motion refinement

- Japanese welcome headings use installed Yu Mincho / Hiragino Mincho fonts; English uses Georgia. The first line is 78% of the main line, and the second line is indented by 0.42em (0.32em in English). Main station names retain a bold Gothic/sans face for scanning, with less compressed tracking. UI labels use lighter weights rather than making every level bold.
- At 390px, the welcome main line is about 66px and the lead is about 52px. Supporting copy has an 18em measure and 1.95 line height. Existing native font fallbacks remain in place; there are no font downloads.
- Destination is a full-width ruled action, with a small outlined arrow, instead of a filled rounded card. On-board and guide controls are unboxed and have different visual weight. At narrow widths and enlarged text they stack.
- The welcome route draws over 1400ms with `cubic-bezier(.4,0,.2,1)`. The position marker travels along the actual SVG curve for 1200ms, after a 180ms delay, with `cubic-bezier(.45,0,.2,1)`. Both play once per document load, without bounce, glow, or repeating pulses. Text and controls stay fully visible throughout.
- Final state is a complete route with the marker at SVG `(152,70)`. Start click / keyboard Enter cancels the illustration immediately and begins normal location acquisition without waiting. Language changes do not restart it. Backgrounding or changing to reduced motion immediately restores the final static state; returning does not replay it. Initial reduced motion and unsupported animation APIs display the static illustration.

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
- Updated the service worker to `ekikoko-v39` using the repository cache tool.

## Preserved behavior

Vanilla HTML/CSS/JavaScript, every pre-existing HTML ID, PWA support, Japanese/English, all three accent palettes, location processing, station data, destination Plus gating, demo enable/disable, billing configuration, route filtering, arrival alerts, ride history, wake lock, and feedback/data deletion remain available.

The on-board surface remains `#000` during entry, display, and exit. Reduced-motion settings continue to be handled in CSS and JavaScript. The guide duration remains 1600ms, preserving the earlier timing correction.

## Validation

Chrome/Playwright, 390×844px, 320×740px, 1280×900px, and a short 390×520px viewport. Station success uses a simulated Shinjuku location (35.6896, 139.7006); screenshots are not evidence of live GPS accuracy.

- 28 principal-flow checks: welcome, location, settings, all accents, light/dark, on-board, Plus demo, map/search/lines, selection/confirmation, zero results, guide, keyboard focus, rapid reversal, persistence, and GPS denial.
- 16 additional checks: ID preservation, both translation dictionaries, 200% text enlargement across six surfaces, short-viewport confirmation, pointer map operations, privacy page, GPS requesting/timeout, on-board error text, and a real service-worker offline reload.
- 13 welcome checks: one-shot timing, marker trajectory, exact final state, no language-change replay, immediate start, keyboard Enter, initial and mid-animation reduced motion, background/return lifecycle, dark welcome, Japanese/English at 320px/390px and 200% text, desktop layout, and no font downloads.
- 9 palette checks: all six mode/accent combinations, PWA metadata, saved dark reload, and saved dark surface before the app script downloads. Across the six combinations, 120 token-pair checks meet at least 4.5:1 for normal text and 3:1 for control boundaries. Decorative rules and official railway colors are not treated as text; route names remain readable in the main text color.
- No JavaScript runtime errors in these checks.
- JavaScript syntax and whitespace checks pass.

Stripe production checkout and an actual train journey are outside the simulated validation. Their underlying integrations are not changed.

## Review and release

Base commit: `a8d9722`, from `claude/practical-babbage-xrtvmo`.
Review branch: `codex/ekikoko-ui-refresh`.
The review branch is separate from the GitHub Pages deployment branch. Publishing requires merging the reviewed change into the deployment branch.
