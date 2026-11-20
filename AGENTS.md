# Hangry (free-now)

Invite-only friends PWA. Product name Hangry; npm name `free-now`.

## Workflow

- Work on an `oc/<topic>` branch cut from current `origin/main`.
- Never push to `main`. Never merge. Leave the PR unmerged until the human says yes.

## Gates

Before reporting a change done, run all three from the repo root and report pass, fail, and skip counts. Expect 0 skipped.

- `npm run typecheck`
- `npm test` runs `node:test` via tsx on `test/**/*.test.ts`. It talks to a real Hangry server with in-memory SQLite (`withApp` in `test/http.ts`, or `openDb(":memory:")`).
- `npm run test:ui` runs `@playwright/test` (`playwright.config.ts`) with per-file parallelism: `fullyParallel: false`, `workers: 4`, `retries: 0`. Each spec file gets its own app, in-memory db and Chrome from `useHangry`, so files run side by side. Tests inside one file share that db and server, so they stay serial; do not turn on `fullyParallel` or raise `workers` as a casual tweak (more load on the box makes timing-sensitive specs flaky). `useHangry` in `test/ui/harness.ts` registers `test.beforeAll` / `test.afterAll`, starts the real app on `127.0.0.1` with a random port and an in-memory db, then launches headless system Chrome through `playwright-core` (Chrome channel, else `/usr/bin/google-chrome`; no downloaded browser). Specs seed fake users through the real API, log in, and drive the UI at `SIZES` 320x568, 360x640 and 412x915, plus 1280x800 when the desktop layout matters.

Full `scripts/check.sh` takes about 8 to 10 minutes with 4 workers, mostly `test:ui`.

- Run it once, after your last edit, with a bash timeout of at least 2700000 ms (45 min).
- If it fails, fix the cause and rerun only the failing file (`npx playwright test test/ui/<name>.spec.ts` or `npx tsx --test test/<name>.test.ts`) until it passes. Then run the full check one final time.
- If the full run is red only on UI specs that pass alone without changes (one or several), report each as a flake with its name and size, and stop. Start another full run only after you changed code to fix a real failure.
- Once the full check is green after your last edit, stop testing. Do not rerun it or its parts just to re-confirm.

## Tools

- Search code and logs with the grep tool, find files with the glob tool, and view files with the read tool (use offset/limit for long logs). Do not use `rg`, `grep`, `cat`, `sed -n`, `head`, `tail` or `ls -R` in bash to read or search files. Trimming a command's own output (`scripts/check.sh 2>&1 | tail -80`) is fine.
- Bash is for running commands (`scripts/check.sh`, `npm`, `npx tsx --test`, git). Keep grep tool searches to `src/` or `test/` paths; searching `dist/` or log files can fail on minified lines over 64 KB.
- Create new files with the write tool. Never `cat > file`, heredocs or `echo >` into repo files, also not behind `cd ... &&`.

## UI specs and screenshots

Every UI change needs a `test/ui/*.spec.ts` that asserts visible behavior and writes screenshots to gitignored `test/ui/screenshots/<feature>/`. Use fake data only: no real names, tokens, recovery codes, or production data. Mask secrets in shots (the calendar specs mask the feed URL). Read the PNGs before claiming the UI is done.

## Push

`useHangry` defaults to `createNoopPushSender()`. `withApp` records into a stub. Real push delivery is only verified on production, never from these runs.

## Version and What's New

For user-facing changes:

- Bump `export const APP_VERSION` in `public/js/app.js` to the next `hangry-vN` label. It is the only build label, and feedback sends it. There is no `CACHE` constant and no hand-maintained `SHELL` list: the service worker source is `sw/sw.js`, and Vite (`vite.config.ts`, vite-plugin-pwa `injectManifest`) builds it into `dist/client/sw.js` with a Workbox precache of the app shell, bundled JS and CSS, `/whats-new.json`, icons, manifest and vendor files. A new build gets new precache revisions, and on activate the worker deletes old `hangry-vN` caches.
- Add a newest-first entry to `public/whats-new.json`: `id` matching `^[a-z0-9-]{1,64}$` (usually `YYYY-MM-DD-short-slug`), `date` as `YYYY-MM-DD`, `title` of at most 60 characters, and 2 to 4 bullets of at most 140 characters each. No em dashes. Add or update a test in `test/whats-new.test.ts` for the new entry, and keep older entries. `test/whats-new.test.ts` also checks `APP_VERSION` and that the built worker precaches `/whats-new.json`.
- `npm run build` runs `tsc` (server, `dist/`) then `vite build` (client, `dist/client/`). The server serves `dist/client` when it exists and raw `public/` otherwise. Tests that read the built worker or bundle need the build first. `scripts/check.sh` runs `npm ci`, typecheck, build, `npm test` and `npm run test:ui` in that order, so a partial test run after a source change needs `npm run build` first.

Docs-only or test-only changes do not bump the version or add a What's New entry. Internal folder moves that change public URLs bump `APP_VERSION` but do not add a What's New entry.

## Style

- Never use em dashes in code comments, copy, commits, or PR text.
- Mobile first. Match existing styles. Prefer fixing within existing sheets and components over new chrome.
- No secrets, tokens, or recovery codes in output, screenshots, commits, or PR text.

## Code rules

- Keep functions short. Split anything that grows past roughly 40-50 lines. `render()`, `view()`, `welcome()`, `boot()`, and `refresh()` are already too long; do not grow them.
- Give key functions a one-line comment saying what they do, especially `render`, `view`, `shell`, `el`, and similar helpers.
- Domain folders in `public/js`, not one flat level: `accounts`, `circles`, `free-now` / plans / events, `chat`, `map-places`, `calendar`, `money`, `notifications`, `buzzer`, `app-meta` (install guide, What's New, feedback, admin API, welcome and privacy). New files go in their domain folder. Moving existing files is a separate refactor PR.
- UI copy (user-facing strings, such as the friendly messages in `session.js`) lives outside logic files, in a copy or strings module per domain.
- Keep logic and UI separate. Pure logic modules (state, rules, calculations) do not touch the DOM. UI modules render and call logic. `bills.js` mixing both is the counter-example.
- No unused folders or dead files. `docs/` is currently unused.

## Production

Never touch production, Railway, env vars, or real data. Do not hit the live app from agent runs.
