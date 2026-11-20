# iOS Safari audit (Hangry v132 / origin/main 88fd8b2)

Auditor: Playwright WebKit with `devices['iPhone SE']` (320x568, dpr 2, touch, isMobile), `devices['iPhone 13']` (390x664, dpr 3), `devices['iPhone 15 Pro Max']` (430x739, dpr 3), dark and light. Comparison: Chromium phone at 390x844, touch, isMobile, dark and light.

No real iOS device was available. Playwright WebKit reports `env(safe-area-inset-*)` as 0, so notch / home-indicator magnitudes cannot be verified here. Audit date: 2026-11-20, Europe/Berlin. Screenshots: `/workspace/shots-feat/ios-safari/audit/`. Runtime metrics: `/workspace/shots-feat/ios-safari/audit/metrics.json`.

Walkthrough covered: welcome / login-invite gate (name + email focus), Now cards and compact, map, event create (Now + Plan for another day), event detail, event chat (composer focus, keyboard-ish viewport shrink, GIF sheet), Circle tab, You / Profile / Availability, What's New (menu + first-load popup), bottom nav. Pull-to-refresh, event-edit, Chat-tab circle chat, and emoji rain were not separately screenshotted (the tour timed out at the end clicking Now, with a `Send` button intercepting the tab). Event chat already exercises the same `#chat-input` composer.

## Fix these (evidenced)

### F1. Default iOS tap highlight on non-button controls

- **File:** `public/css/styles.css` (html/body around lines 107-109 have no `-webkit-tap-highlight-color`; buttons already set it transparent at line 2614 via `:where(button, [role="button"], [role="menuitem"], a.map-link, label.chip)`).
- **Evidence:** computed `html` / `body` `-webkit-tap-highlight-color` is the WebKit default `rgba(0, 0, 0, 0.4)` on every WebKit and Chromium-phone tour (see metrics.json, `htmlTap`).
- **Why it matters on iOS:** gray flash on tap. Clickable nodes that are not in that `:where(...)` list still inherit the default: `.card-bg` / `.card-body` are `div`s with `onclick` (`public/js/cards.js`), and `.gate-about` is an `<a>` (`public/js/render.js` ~310, login gate).
- **Screens:** Now cards, login gate. Examples: `iphone-13-dark-now-cards.png`, `iphone-13-dark-login-focus.png`.
- **Devices:** all three iPhones, dark and light. Same computed value on Chromium phone, but the flash is the classic iOS Safari quirk.
- **Fix:** set `-webkit-tap-highlight-color: transparent` on `html` (or `html, body`). Do not add `touch-action: manipulation` on `html` (styles.css lines 97-100 warn that it steals caret taps and closes the iOS keyboard).

### F2. Welcome page is missing Apple web-app meta tags

- **File:** `public/welcome.html` lines 4-14 (has `viewport-fit=cover` and `theme-color`, no `apple-mobile-web-app-capable` or `apple-mobile-web-app-status-bar-style`).
- **Contrast:** `public/index.html` lines 9-12 already set `apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-status-bar-style=black-translucent`, and `apple-mobile-web-app-title=Hangry`.
- **Screen / shot:** welcome. `iphone-13-dark-welcome.png` (also SE, 15 Pro Max, light, Chromium).
- **Why it matters on iOS:** Add to Home Screen from the marketing page will not get the translucent status bar the app already asks for.
- **Fix:** add the same three Apple meta tags as `index.html`. Visual result needs a real device / Home Screen. Emulation can only assert the tags exist.

### F3. Leftover `40vh` max-heights (stale on iOS when the URL bar or keyboard moves)

- **Files:**
  - `public/css/styles.css:1963` `textarea.sheet-control { max-height: 40vh; }`
  - `public/css/styles.css:2870` `.sheet-extra { max-height: 40vh; }`
- **Contrast:** nearby rules already use dynamic units, e.g. line 1573 `max-height: min(240px, 40dvh, calc(var(--vv-height, 100dvh) * 0.4))` and line 1874 similarly.
- **Evidence:** on short WebKit viewports the Plan sheet's description textarea is tall enough that Date and Time sit below the fold under the "Add plan" dock, with no hint they exist until you scroll.
  - iPhone SE dark: Date and Time not in view. `iphone-se-dark-create-plan.png`
  - iPhone 13 dark: Date visible, Time clipped to a sliver under the dock. `iphone-13-dark-create-plan.png`
  - iPhone 15 Pro Max dark: Date and Time fully visible. `iphone-15-pro-max-dark-create-plan.png`
- **Devices:** worst on SE and 13; 15 Pro Max is fine in this audit. Same layout math would apply on a short Chromium phone; `40vh` is still the iOS-classic pitfall (vh does not follow the visual viewport).
- **Fix:** switch those two `40vh` caps to the same `dvh` / `--vv-height` pattern used at lines 1573 and 1874. Do not restyle the sheet. The sheet already scrolls (`.sheet-scroll`); this only stops the textarea eating the short viewport.

### F4. Unguarded `:hover` on two controls (sticky hover after a tap)

- **Files:** `public/css/styles.css:145` `.gate-about:hover`; lines 701 and 703 `.map-card-close:hover` (the close button also has `:active`).
- **Contrast:** chat hovers are already behind `@media (hover: hover)` (e.g. lines 1268-1296, 1391).
- **Screen:** login gate (What is Hangry? / Privacy), map card close.
- **Devices:** all touch devices. Not visually reproduced as a stuck hover in this emulation (Playwright does not leave a real iOS sticky-hover state).
- **Fix:** wrap those hover-only color/background changes in `@media (hover: hover)`, and keep `:active` (and `:focus-visible` if useful) for touch.

### F5. `input[type="date"]` is missing from the global 16px text-field rule

- **File:** `public/css/styles.css:1158` `input[type="text"], input[type="email"], input[type="url"], input[type="time"]` sets `font-size: 16px`. `type="date"` is not in the list.
- **Current instances are safe:** `#plan-date` and `#status-until` use `class="sheet-control"`, and `input.sheet-control` is 16px (line 1938+). Audit measured `#plan-date` at 16px on every device (`metrics.json`, create-plan).
- **Risk:** a future date field inside `label.field` (font-size 13px, line 1145) with `font: inherit` would compute below 16px and zoom the page on iOS focus. Status editor width rules at line 913 also omit a font-size.
- **Fix:** add `input[type="date"]` to the 16px type list (and keep the existing iOS date appearance rules at lines 1992-1995). Tests should assert computed font-size >= 16px on text, email, url, search, time, date, textarea, and select in the gate, plan sheet, chat composer, GIF search, and availability.

## Already fine (do not "fix"; lock with tests)

- App `viewport` includes `viewport-fit=cover` and `interactive-widget=resizes-content` (`public/index.html:5`). Status bar meta is present on the app document.
- Heights use `100svh` / `100dvh` and `--vv-height: 100dvh`. Do not edit `public/app-kit` leftover `100vh` rules that already have a `100dvh` fallback.
- Safe-area is already wired: `--tab: calc(64px + env(safe-area-inset-bottom))` (line 37); `.phone` padding uses `safe-area-inset-top` and `--tab` (line 126); `.tabbar` is `position: fixed; bottom: 0` with `padding-bottom: env(safe-area-inset-bottom)` (line 1199); chat compose and sheet padding include the insets; map min-height subtracts `--tab` and the top inset. In this audit every inset computed to 0 and `--tab` became `calc(64px + 0px)`. Tests can assert the CSS uses `env(safe-area-inset-*)`. Magnitudes need a real notched device.
- Text, email, url, time, search, textarea, and date.sheet-control all computed to 16px on WebKit and Chromium. Login/gate fields look correctly sized (`iphone-13-dark-login-focus.png`). A 15px *checkbox* on the plan sheet is not an iOS focus-zoom issue; leave it.
- No horizontal overflow (`overflowX = 0`) on any audited screen, any device, dark or light.
- Tabbar and several surfaces already set both `backdrop-filter` and `-webkit-backdrop-filter`, with an opaque `@supports not` fallback (lines 1204-1210).
- Chat long-press already sets `-webkit-touch-callout` and `user-select` under `@media (hover: none)` (around line 1298-1301).
- `html.kb-open .tabbar` hides the tab bar. Viewport is `interactive-widget=resizes-content`. After a keyboard-ish resize to ~55% height, the event-chat composer stayed fully on screen and usable on SE and 13 (`iphone-se-dark-event-chat-kb.png`, `iphone-13-dark-event-chat-kb.png`). `kb-open` did not flip in emulation (no real iOS keyboard).
- Compact list, map, GIF sheet, What's New, and login gate looked correct in WebKit. Translucent tabbar overlapping mid-scroll cards (e.g. `iphone-13-dark-now-cards.png`, also on Chromium `phone-chrome-dark-now-cards.png`) is the frosted bar over a scrollable list, not an iOS-only bug; `.phone` already has `padding-bottom: var(--tab)`.

## Not reproducible in this emulation / needs a real device

- Safe-area inset magnitudes (notch, home indicator) on fixed headers, bottom nav, sheets, and chat compose. CSS is present; computed insets were 0.
- Real iOS keyboard covering `position: fixed` composers or sheets, and whether `html.kb-open` / `--kb-offset` / `visualViewport` match a physical keyboard. The shrink-viewport check is only an approximation.
- Rubber-band overscroll of the document vs inner scrollers; `html.sheet-open` already sets `overscroll-behavior: none`.
- Sticky `:hover` after tap (F4 was found in CSS, not as a screenshot).
- Welcome / app status bar when launched from the Home Screen (F2).
- Native `input[type="date"]` / `time` wheel styling beyond the existing `appearance` rules (lines 1992-1995). Measured font-size is 16px; the control still looks like a text row in WebKit (`iphone-15-pro-max-dark-create-plan.png`).
- `-webkit-overflow-scrolling` / momentum inside overflow containers, and rubber-banding behind the translucent tabbar.

## Out of scope / not a Hangry bug

- `public/app-kit` `100vh` with `100dvh` fallback. Do not hand-edit `public/app-kit`.
- Checkbox computed 15px (see F5 / already fine).
- Audit-script timeout: after What's New, clicking the Now tab was interceptable by a `Send` button. Treat as a script issue unless a leftover composer is proven on a real path.

## Suggested test coverage (new `iphone-webkit` project)

Playwright project `iphone-webkit` must launch **WebKit** (update `launchBrowser` in `test/ui/harness.ts`; today only `desktop-webkit` / `desktop-firefox` leave Chrome) with `devices['iPhone 13']` (touch, isMobile). It should run only `test/ui/ios-safari.spec.ts`. The existing `phone` project must ignore that file so `check.sh` time stays flat.

The spec should cover the fixes and the invariants:

- Visible text/email/url/search/date/time/textarea/select in gate, plan sheet, chat composer, GIF search, and availability have computed font-size >= 16px.
- `.tabbar`, `.sheet`, `.chat-compose`, `.phone` computed styles include the safe-area env (padding or height uses it; values may be 0 in emulation).
- No horizontal overflow on welcome, gate, Now cards, compact, map, create sheet, event chat, You, availability.
- Plan/create sheet remains usable after a keyboard-ish viewport shrink: dock and focused field stay in the visual viewport, Date/Time can be reached.
- `welcome.html` has the Apple web-app meta tags after F2.
- `html` (or body) `-webkit-tap-highlight-color` is transparent after F1.
