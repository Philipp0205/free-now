# Calendar export and feed

Hangry can put plans into a calendar app in two ways:

1. **Add to calendar**: a one-time `.ics` file for one plan.
2. **Calendar feed**: a private link that a calendar app subscribes to. It keeps updating.

Both use the same event shape and the same UID, so a plan does not show up twice when someone uses both.

## Add to calendar (one-time file)

- Where: the ⋯ menu on an open plan card, right after Remind friends.
- Endpoint: `GET /api/plans/:id/calendar.ics` with the normal `Authorization: Bearer` session.
- Who: anyone who is currently a member of a circle the plan is shared with. A stranger, someone in an unlinked circle, or a guest the host removed gets `404`. An ended plan, or one on a past day, gets `410`.
- The client fetches the file with the session header and saves it as a download named after the plan title (for example `sushi-night.ics`). The URL is never shared or opened directly.
- Toast: "Saved to your calendar file. It will not update if the plan changes."
- The file is a snapshot. Later edits, ends, or reply changes do not reach it. That is the main limitation, and why the feed exists.

## Calendar feed (subscription)

- Where: You tab, "Calendar feed" panel.
- Management (session auth):
  - `GET /api/me/calendar-feed` returns `{ active, createdAt }`. It never returns the link.
  - `POST /api/me/calendar-feed` creates a token, or replaces the existing one, and returns `{ active, createdAt, url, webcalUrl }`. This is the only time the link leaves the server.
  - `DELETE /api/me/calendar-feed` revokes the feed and returns `204`.
- Feed: `GET /cal/<token>.ics`. Public, no session, because calendar servers cannot send one.
- Token: 32 random bytes, base64url (43 characters). Only its SHA-256 hash is stored (`calendar_feeds`: `user_id` primary key, `token_hash` unique, `created_at`). One feed per person.
- UI: the link shows once, right after Turn on or Reset link, with Copy link and Open in calendar (`webcal://`). After you leave the You tab, only "On since <date>" is shown. Reset link (rotate) and Turn off (revoke) both ask for confirmation first.
- An unknown, revoked, or malformed token gets a bare `404` with an empty body. It does not say whether the token ever existed.
- Response headers: `text/calendar; charset=utf-8`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `nosniff`. The service worker never caches `/cal/`.
- Rate limit: 120 requests per minute per client address. This is loose on purpose, because Google and Apple fetch from shared addresses.

### What is in the feed

A plan is included when **both** are true at fetch time:

- the person is currently a member of at least one circle the plan is shared with, and
- they host it, **or** their reply is in (coming) or maybe, and the host has not removed them.

Declined, never answered, and removed are left out. If you leave a circle, the host unlinks it, or you change to "can't", the plan drops out on the next fetch.

Window: plans from 30 days ago and everything ahead. At most 200 events: upcoming plans first (soonest first), then recent past plans (newest first) in the room that is left.

## Event semantics

| Field | Value |
| --- | --- |
| `UID` | `<planId>@<host>`. The host is the hostname of `PUBLIC_BASE_URL`, or `hangry` when it is unset. The same UID is used in the file and the feed. |
| `SUMMARY` | Plan title. |
| `DESCRIPTION` | "Hosted by <host name>", the plan description if there is one, then for a timed plan "Hangry plans have no end time, so this shows 2 hours." (plus a note when the time does not exist that day, see Time zones), then "Hangry: <app link>". |
| `LOCATION` | The place text only. No coordinates. |
| `URL` | `<origin>/?plan=<id>`, which opens the plan in the app. |
| `DTSTART` / `DTEND` | With a time: UTC instants, start plus 2 hours. With no time (TBD): all day, `VALUE=DATE`, ending the next day. |
| `STATUS` | Host or in: `CONFIRMED`. Maybe: `TENTATIVE`. Ended: `CANCELLED`, same UID, so a subscribed calendar marks it instead of keeping a stale copy. |
| `SEQUENCE` | `0` until the first change. After that, seconds between creation and the last change (at least 1). It only grows. |
| `LAST-MODIFIED` | Last change, or creation time. |
| `DTSTAMP` | Time of the request, UTC. |

A "change" means the title, place text, day, time, or description changed, or the plan was ended (first end only). Moving only the pin, or changing linked circles, does not bump `SEQUENCE`. Replies do not either. They only change `STATUS` for that one person.

Never included: other guests' names, emails, attendees, chat, invite codes, share links (`/p/...`), or coordinates.

### Calendar wrapper

`VERSION:2.0`, `PRODID:-//Hangry//Calendar 1.0//EN`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-TIMEZONE:<APP_TZ>`. The feed also sets `X-WR-CALNAME:Hangry`. Lines end in CRLF and are folded at 75 octets, counting UTF-8 bytes and never splitting a character. TEXT values escape `\`, `;`, `,` and newlines.

## Time zones

Plan times are wall-clock times in `APP_TZ`. They are turned into UTC instants with the same rule the app uses, so they are correct across daylight saving changes without a `VTIMEZONE` block. `X-WR-TIMEZONE` is only a display hint.

Daylight saving edge cases follow RFC 5545 (section 3.3.5), and the app's own clock rule (`zonedDateTime` in `src/time.ts`) gives the same instant:

- **Time that does not exist** (spring forward, for example 02:30 on 2026-03-29 in Europe/Berlin): it is read with the offset from before the gap, so it lands at 03:30 local (`DTSTART:20260329T013000Z`). Because that is not what the host typed, `DESCRIPTION` adds: "Planned for 02:30, a time that does not exist on this day because clocks move forward. Shown at 03:30." The note is added whenever the start, turned back into wall time in `APP_TZ`, differs from the plan's time.
- **Time that happens twice** (fall back, for example 02:30 on 2026-10-25 in Europe/Berlin): the first occurrence is used, which is still summer time (`DTSTART:20261025T003000Z`, 02:30 CEST). No note is added, since the wall time is what the host typed.

## Limitations

- **Refresh is up to the calendar app.** Your calendar app decides how often it checks for changes, which can take hours. Hangry cannot push updates.
- **The one-time file never updates.** Use the feed for that.
- **Revoking does not wipe copies.** After Reset link or Turn off, calendars keep showing what they last fetched until the subscription is removed there. The old link just returns 404.
- **Removed plans just disappear.** A plan you lose access to is dropped, not sent as `CANCELLED`. Some clients only notice on their next full refresh.
- **Fixed length.** Hangry plans have no end time, so every timed plan shows 2 hours. Each timed event says so in its description.
- **Anyone with the link can read the feed.** Treat it like a password. Reset it if it leaks.
- **The token is in the URL path.** Calendar servers cannot send a header, so the secret is part of `/cal/<token>.ics`. That means the hosting platform's HTTP access logs (for example Railway's request logs) and the calendar provider that fetches the feed both see it. Hangry itself never logs the feed URL: an error while serving `/cal/` is logged as "feed error" with the token replaced by `[token]`. If the link may have leaked, use Reset link (or Turn off). The old token stops working at once.
- **Plans older than the 90-day history are deleted from Hangry,** and they are already outside the 30-day window anyway.
