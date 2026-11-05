# Hangry (free-now)

Invite-only friends PWA. Repo npm name `free-now`; product name Hangry.
Live: https://hangry.up.railway.app (Railway auto-deploys `main`). Never hit production from agent runs.

## Stack
- Server: TypeScript, Node ≥22.5, `tsx`, `node:sqlite` (`src/`)
- Client: vanilla JS/CSS PWA (`public/`), service worker `public/sw.js`
- Timezone default: `APP_TZ=Europe/Berlin`
- Tests: `node:test` via tsx — `test/*.test.ts`; UI — Playwright `playwright-core` + system Chrome in `test/ui/*.spec.ts`

## Commands (run from repo root / worktree)
- `npm run typecheck`
- `npm test`
- `npm run test:ui`  (already `--test-concurrency=1`; do not raise it)
- `npm start` / `npm run dev` for a local server with a **temp** `DB_PATH`

## Hard rules
- Fake users and temp SQLite only. No real recovery codes, no prod DB, no Railway mutate, no real push keys in tests.
- Keep it very simple. Small focused functions. UI copy in plain short sentences.
- Do not `git commit` / `git push` / open PRs unless the human prompt explicitly says so.
- Never touch Aney/Advantest repos or org settings.
- Every user-facing change: add a short entry to `public/whats-new.json` (What's New popup).
- Screenshots the agent takes for itself: 320×568, 360×640, 412×915 (and dark if colours/theme matter). Put them under `.oc/shots/` or `test/ui/screenshots/` (gitignored). **Read the PNGs** before claiming UI is done.
- Prefer fixing within existing sheets/components over new UI chrome.
- Playwright MCP is enabled for this repo (output under `.oc/shots/`). Prefer it for ad-hoc screenshots; keep automated checks in `test/ui`.

## Layout cheat-sheet
- Plans / free / chat / map / push-status: `public/app.js` + `public/styles.css`
- Server routes: `src/app.ts`; DB/migrations: `src/db.ts`
- Chat colours: `src/chat-color.ts` (per-user, stable)
