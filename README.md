# Spontaco

Spontaco is a small, installable web app for an invite-only circle of friends. Tap once when you're free. Everyone in the circle gets a push. They tap Join, and you hear about it.

It is a PWA: home-screen install on Android and on iPhone (iOS 16.4+), no app store. The server, the SQLite database, and the web push setup all live in this repo. The repo and the npm package are named `free-now`. The name people see is Spontaco (it used to be Hangry, and the domain and some internal identifiers still say hangry). The public site is whatever you set in `PUBLIC_BASE_URL`. Requests that still arrive on the previous Railway hostname are redirected there.

## Run it locally

One command, from a clean checkout:

```bash
npm install && npm start
```

Then open <http://localhost:3000>.

No VAPID keys are required for this. Notifications show up inside the app (a banner, plus the bell), which is enough to try the whole circle with two browsers. `npm run dev` is the same server with a file watcher.

### Two people, by hand

Use two browser profiles, or a normal window and a private window. They do not share site data, so each one is a different friend.

1. Profile A: open <http://localhost:3000>. Enter a name (Alex) and create a circle. The invite code is on the home screen until someone joins, and on the compass tab after that.
2. Profile A: tap **Share invite**. The link looks like `/join/CODE`. **New invite link** retires the old one. A link also expires 14 days after it was created or last renewed.
3. Profile B: open that link. The page names the circle. One button creates their account and joins, then the install sheet and the notification reminder follow in that order.
4. Profile A: tap the glowing circle. Leave it on **Now**, or choose **Later today** (in 1 hour, 18:00, or a time today). Add a place if you want. Press **I'm free**.
5. Profile B: the banner is `Alex is free now`, or `Alex is free from 18:00 – meet at Café X` when there is a time and a place. Tap **Join**, **On my way** (5, 10, or 20 minutes), or **Can't make it**.
6. Profile A: the card lists who is coming, with ETAs, and who declined. A later social reminds only the people who joined or are on the way, when it starts, and then runs for about two hours.

Plans use **Plan** (or the **+** button). Pick today, tomorrow, or any date up to a year ahead. Friends join those the same way. A social that is free now ends on its own after about two hours (change `SOCIAL_TTL_MS`), or the creator can end it early. A social posted for later today lasts about two hours from that start time.

Real phone push is a separate step. Generate VAPID keys, set them in the environment, restart, then follow [Install on your phone](#install-on-your-phone). The same guide is in the app, on the welcome screen and under You → notifications.

## Tests

```bash
npm test
```

The main test signs up two users, joins a circle, subscribes both to push, creates a social, and checks that a push is handed to the friend. The push sender is a fake. The friend joins, the creator is handed `"Rooftop coffee??"` / `Veit joined your social!`, and the social disappears after the two-hour window. A second test covers the buzzer endpoint.

## How accounts work

There are no passwords. The first screen creates a user and stores a device token in the browser. A second secret, shown on the You tab, does two jobs:

- `POST /api/buzz/<token>` starts "I'm free now" (the arcade-button endpoint).
- The same secret is the recovery code. If you clear the site, enter it on the first screen to sign back in. That issues a new device token and signs the old browser out.

Losing both the browser data and the recovery code means that user cannot be recovered. Create a new one and rejoin the circle.

## Assistant tokens

An assistant (an AI agent or a script) can act for you with its own token. You create it on the You tab. It is shown once, and you can revoke it any time. The assistant sends it as `Authorization: Bearer <token>`.

An assistant token can only call the routes listed in `/api/openapi.json`. Any other route returns 403. `/llms.txt` is the same guide in plain text. Your friends see what the assistant does as you.

## Buzzer

Each user has a secret URL. A Flic button, an ESP32, or `curl` can hit it. No session header.

```bash
curl -X POST http://localhost:3000/api/buzz/YOUR_TOKEN \
  -H 'content-type: application/json' \
  -d '{"note":"Rooftop coffee??"}'
```

A POST with an empty body is also fine — the note is optional. The token is on the You tab. Pressing it again refreshes the two-hour timer. The same note will not push more than once every 30 seconds, so a bouncy button does not spam the circle. Changing the note can notify again after 15 seconds.

One circle needs no extra argument. With more than one circle, a buzz that does not name a circle posts to the circle you joined last, unless you mapped that press to a circle (below). `?circle=<id>` always wins, and a circle you are not in is a 404.

Add `?press=single|double|hold` to say which Flic click this is. No `press` means `single`, so older links keep working. Any other value is a 400. You can map each press to a circle with `PUT /api/me/buzz-circles` and a body like `{"single":"<id>","double":"<id>","hold":null}` (`null` or a missing press means the default circle). It answers `{"buzzCircles":{...}}`, and a circle you are not in is a 404 that saves nothing. If you later leave a mapped circle, that press answers 404 and posts nowhere.

`DELETE` on the same URL ends the live social in the circle a POST of the same press would post to. It answers 204 even when nothing is live.

### Flic button

With one circle, the You tab shows one link under **Set up a Flic button**. With two or more it shows a row for **Single click**, **Double click** and **Hold**, each with a circle picker, its own link (`?press=...`) and a Copy button.

1. In the Flic app, open the button and choose **Push**.
2. Under **Click** and **Double click**, add the **Internet Request** action. Paste that row's link as the URL, set the method to POST, and save. Leave the body empty, or send `{"note":"Rooftop coffee??"}` with content type `application/json`.
3. Under **Hold**, add the Hold row's link with the method DELETE. Holding the button then ends the social in that circle.

Each press also stamps the social with `buzzedAt` (set only by this link, never by the app). Open apps in the circle, and the presser's own, play a full-screen buzzer animation for it, cycling through four. **Test buzzer** in the same panel plays the next one locally without sending anything.

Without a Flic Hub, the request is sent by the phone the button is paired with, so that phone has to be in Bluetooth range and online.

The token is a bearer secret. Anyone with it can start a social as that user. It is stored in SQLite so the You tab can show it again; keep the database file private.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. Railway sets this; the server binds `0.0.0.0`. |
| `DB_PATH` | `./data/free-now.sqlite` | SQLite file. Point it at the volume in production. |
| `PUBLIC_BASE_URL` | request host | Public origin for invite links. Set this to the custom domain once it exists, for example `https://hangry.example`. No trailing slash needed. |
| `VAPID_PUBLIC_KEY` | unset | Web Push public key. Unset means in-app alerts only. |
| `VAPID_PRIVATE_KEY` | unset | Web Push private key. Set both, or neither. |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | Contact URL sent to the push service. `mailto:` or `https:`. |
| `SOCIAL_TTL_MS` | `7200000` | How long a social stays active (2 hours). |
| `APP_TZ` | `Europe/Berlin` | Timezone that decides what "tomorrow" means. Override it if the circle lives elsewhere. |
| `MAP_TILE_URL` | Esri World Street Map | HTTPS tile template with `{z}`, `{x}`, and `{y}`. `{s}` is a subdomain and `{r}` is retina when the template contains them. |
| `MAP_TILE_ATTRIBUTION` | `Powered by Esri | © Esri, HERE, Garmin, USGS, OpenStreetMap contributors` | Shown on the map. Change this whenever you change the tiles. |
| `MAP_PMTILES_PATH` | unset | Absolute path to a local PMTiles v3 basemap (for example on `/data`). Checked at startup (magic, version, bounds, zoom); a bad or missing file is logged and ignored. Served at `/tiles/basemap.pmtiles` in byte ranges of at most 16 MiB. The dark vector map shows only where the view is inside the archive bounds and zoom range; everywhere else the raster tiles above are used. |
| `MAP_PMTILES_URL` | unset | Optional `https://` URL of the PMTiles file, so production can fill `MAP_PMTILES_PATH` without an SSH upload. Redirects are followed (GitHub release assets redirect), every hop must be https, and no auth headers are sent unless `MAP_PMTILES_TOKEN` is set. Needs `MAP_PMTILES_PATH` and `MAP_PMTILES_SHA256`. When the file at the path is missing, not a valid v3 archive, or has the wrong sha256, the server downloads it in the background after it starts listening: into a temp file in the same directory (created if needed), capped at 1 GiB, then sha256 and header checks, then an atomic rename. The vector map turns on without a restart; until then, and if all 4 attempts (2 s, 4 s, 8 s backoff) fail, only the raster map is used. Logs show origin and path only, never the query string. |
| `MAP_PMTILES_SHA256` | unset | Expected sha256 (64 hex characters) of the archive. Required with `MAP_PMTILES_URL`. When set, an existing file is hashed in the background at startup and used only if it matches, so the vector map appears a moment after boot rather than immediately. |
| `MAP_PMTILES_TOKEN` | unset | Optional bearer token for `MAP_PMTILES_URL`, for private GitHub release assets (a fine-grained token with read access to the repo's contents). Sent as `Authorization: Bearer …` on the first request only; when a redirect moves to another host (GitHub sends the bytes from a signed `objects.githubusercontent.com` URL) it is dropped and not sent again. For a private asset use the API URL `https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`; requests to `api.github.com` ask for `Accept: application/octet-stream`. The token is never logged or put in a URL. Ignored without a usable `MAP_PMTILES_URL`. |
| `ADMIN_TOKEN` | unset | Bearer secret for operator routes. `POST /api/admin/query` and `GET /api/admin/schema` stay read-only. `POST /api/admin/circles/:id/delete` deletes a circle. `POST /api/admin/circles/:id/members/:userId/admin` with `{"admin":true}` or `{"admin":false}` sets that member's admin flag. `POST /api/admin/users/:userId/buzz-animation` with `{"buzzAnimation":"birthday"}` or `{"buzzAnimation":null}` sets or clears the special animation everyone sees for that person's Flic press (other values are 400, an unknown user is 404). `GET /api/admin/feedback` lists feedback newest first (optional `?status=`), and `POST /api/admin/feedback/:id` with `{"status","prUrl","note"}` updates one. Unset, or shorter than 32 characters, those paths stay hidden and answer 404. A bad token is also 404. Send `Authorization: Bearer <token>`. It is not shown in the app. Do not commit it. |
| `CALENDAR_SYNC_KEY` | random key stored in the database | Encrypts calendar links, owner-only event titles, and the Google refresh token (AES-256-GCM). 64 hex characters or base64 of 32 bytes, for example `openssl rand -hex 32`. Unset, a random key is made once and kept in the database. Changing it makes stored links and tokens unreadable, and people see "Reconnect your calendar". Do not commit it. |
| `GOOGLE_CLIENT_ID` | unset | OAuth client id (Web application) for Connect Google Calendar. The button appears only when both this and `GOOGLE_CLIENT_SECRET` are set; with one or neither, the feature is off and the pasted-link import is unchanged. Spontaco asks for the `https://www.googleapis.com/auth/calendar.freebusy` scope alone, so it receives busy blocks and never event titles or details. |
| `GOOGLE_CLIENT_SECRET` | unset | OAuth client secret. Set both, or the feature stays off. Never logged. Do not commit it. |
| `GOOGLE_OAUTH_AUTH_URL`, `GOOGLE_OAUTH_TOKEN_URL`, `GOOGLE_OAUTH_FREEBUSY_URL`, `GOOGLE_OAUTH_REVOKE_URL` | the real Google endpoints | Test-only overrides (`https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`, `https://www.googleapis.com/calendar/v3/freeBusy`, `https://oauth2.googleapis.com/revoke`) so tests can point at a fake server. Leave unset in production. |

Google Calendar: in Google Cloud, create an OAuth client of type Web application and add the authorized redirect URI `$PUBLIC_BASE_URL/api/calendar/google/callback` (for production this is `https://imhangry.app/api/calendar/google/callback`). Set `PUBLIC_BASE_URL` so that URI is stable, and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment; do not commit them. A signed-in person starts with `GET /api/calendar/google/start`, which returns `{ "url" }` for Google's consent page. Google then returns the browser to the callback, which lands on `/?calendar=google` when connected or `/?calendar=google-error` when not. Only the refresh token is stored, encrypted. Disconnecting revokes it at Google.

The only scope Spontaco requests is `https://www.googleapis.com/auth/calendar.freebusy`. In the Google Cloud Data Access picker this scope is marked non-sensitive, so Spontaco does not need [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification). While the OAuth consent screen is in Testing, only listed test users can connect, with a cap of 100 ([OAuth app state](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)). Publishing the consent screen to production lifts that cap. No client id or secret belongs in the repo; both come from the environment.

A wrong admin token is counted per client, eight failures in 60 seconds, and further wrong tokens from that address stay hidden. A correct token is accepted even during that window. Behind Railway the address is the rightmost `X-Forwarded-For` hop, the one the proxy appends; anything to the left is the caller's own header and is ignored. A direct connection uses the socket address. Each query runs in its own process and is killed after one second. A timeout is HTTP 408 `{ "error": "timeout" }`. When a result is cut at 500 rows the body includes `"truncated": true`.

See `.env.example`. Real environment variables override a `.env` file — this server does not load `.env` itself. Export them, or use Docker / Railway.

### Map data credits

For the dark vector map (`MAP_PMTILES_PATH`):

- Protomaps basemap: code BSD-3-Clause, style design CC0. The renderer, protomaps-leaflet (BSD-3-Clause), is vendored in `public/vendor/protomaps-leaflet/` with its `LICENSE`.
- Data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright). Full builds also contain Natural Earth (public domain) at z0–5 and Daylight landcover at z0–7 (source: https://docs.protomaps.com/basemaps/layers).
- The in-map attribution reads "Protomaps © OpenStreetMap".
- The 1.2 MB test fixture is z12–15 and OSM-only; see `test/fixtures/README.md`.
- The usual production archive is one file covering the Stuttgart and Zürich regions and the area between them (bounds 8.3 to 9.95 E, 47.15 to 49.15 N, zoom 0 to 15, about 513 MiB). It is not in the repo. Outside those bounds the raster map is used.
- No fonts are bundled. Labels are drawn on canvas with system fonts.

The 16 MiB cap on a single range is our own defensive limit, not a PMTiles rule. The PMTiles spec only guarantees that the header and root directory fit in the first 16 KiB; metadata, leaf directories, and tiles have no size bound in the spec. A request over the cap gets 416, and the client falls back to the raster map.

### App icon

Taco emoji by Twemoji (jdecked/twemoji), CC-BY 4.0.

## Generate VAPID keys

```bash
npm run vapid
```

Put the printed lines in the environment and restart. Then, on a phone:

1. Open the site over HTTPS (localhost is the only HTTP exception).
2. Install it and allow notifications, using the steps below.
3. You → **Send a test push** to confirm the phone actually receives one.

## Install on your phone

Spontaco notifies a phone only after it is installed and notification permission is allowed. The in-app guide (welcome screen, and You → notifications) shows these steps for the phone you are on. The icon is a soft pink-to-red glow on black.

### iPhone (Safari, iOS 16.4 or newer)

Notifications do not work in a Safari tab, or in an in-app browser such as Instagram or WhatsApp. Open the link in Safari first.

1. Open Spontaco in Safari.
2. Tap the Share button, then **Add to Home Screen**.
3. Open Spontaco from the home-screen icon.
4. Tap **Enable notifications**.
5. Tap **Allow**.

If you previously tapped Don't Allow: open iPhone Settings → Notifications → Spontaco and turn **Allow Notifications** on. If Spontaco is not listed, add it to the Home Screen and open it from the icon, then try Enable notifications again.

### Android (Chrome or Firefox)

Chrome, Edge, and Samsung Internet:

1. Install Spontaco. Tap the install prompt if Chrome shows one. Otherwise open the three-dot menu **⋮** and choose **Install app** or **Add to Home screen**.
2. Open Spontaco from the home-screen icon.
3. Tap **Enable notifications**.
4. Tap **Allow**.

Firefox for Android uses the same reminder, with its own install path:

1. Open the menu **⋮**.
2. Tap **Install**. Older versions say **Add to Home screen**. Confirm.
3. Open Spontaco from the home-screen icon, tap **Enable notifications**, then **Allow**.

If a push never arrives, check both of these:

- The site's notification permission is Allow. In Chrome, tap the lock icon → Permissions → Notifications, or menu **⋮** → Settings → Site settings → Notifications.
- Spontaco is allowed to notify you. Android Settings → Apps → Spontaco → Notifications, then set Battery to **Unrestricted**.

### Troubleshooting

- **Opened from Instagram or WhatsApp.** Those in-app browsers cannot install Spontaco or receive its pushes. Use the menu and open the link in Safari (iPhone) or Chrome (Android).
- **Opened in a browser that cannot install the app.** In-app browsers, Firefox Focus, DuckDuckGo, and similar shells cannot install Spontaco. Copy the link and open it in Chrome or Firefox, then install from there. Firefox itself can install Spontaco and receive pushes.
- **Still looking at a Safari tab.** iOS only delivers Web Push to the Home Screen app, and only on iOS 16.4 or newer.
- **The install prompt never appears.** On Android Chrome, use the three-dot menu **⋮** → Install app or Add to Home screen. In Firefox, the menu says **Install** (older versions say **Add to Home screen**). The site has to be HTTPS (localhost is the only exception).
- **Don't Allow.** Follow the re-enable steps for that phone above. The Enable button cannot override a blocked permission.
- **Android goes quiet after a day.** Battery optimisation paused the app. Set Spontaco to Unrestricted, and confirm the site permission is still Allow.
- **No phone push at all, on any device.** The server has no VAPID keys, so alerts stay inside the app. Run `npm run vapid`, set the three variables, and restart.
- **Changed the domain.** Old push subscriptions belong to the previous origin. Open the new URL, install again if needed, and tap Enable notifications.

## Docker

```bash
docker compose up --build
```

SQLite is stored in the `free-now-data` volume at `/data/free-now.sqlite`. The image listens on `PORT` (3000 in the compose file).

To turn on real push, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in `docker-compose.yml` and recreate the container.

## Deploy on Railway

The repo has a `Dockerfile` and `railway.json`. Railway should build with the Dockerfile (the config file asks for that). Health check: `GET /api/health`.

SQLite on Railway only survives deploys if it sits on a volume, and only if you run **one** replica. Two instances would each write a different database, or corrupt one file.

1. Create a Railway project from this repo. Confirm the service uses the Dockerfile.
2. Add a volume mounted at `/data`.
3. Set variables:
   - `DB_PATH=/data/free-now.sqlite`
   - `APP_TZ=Europe/Berlin` (or wherever the circle lives)
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
   - `PUBLIC_BASE_URL` — add this after the custom domain works, as `https://your-domain`
4. Railway sets `PORT`. Do not pin it unless you know you need to.
5. Deploy. Open the `*.up.railway.app` URL, create a circle, and confirm a restart still has your data.
6. Do not scale this service past one instance.

`PUBLIC_BASE_URL` is what invite links copy. Set it to the public HTTPS origin, not the internal Railway hostname, once the custom domain is live.

## Point an IONOS domain at Railway

Web Push needs HTTPS. Localhost is the only place HTTP works. Railway terminates TLS once DNS is in place; you do not buy a certificate.

The hostname is not decided yet. When it is, point it at Railway like this:

1. In the Railway service, open **Settings → Networking → Custom Domain** and add that hostname.
2. Railway shows the DNS record to create. Copy the target from that screen. It is usually a CNAME to a `*.up.railway.app` host, and the exact target can change.
3. In IONOS: **Domains → your domain → DNS**. For a subdomain such as `www`, add a CNAME whose host is `www` and whose target is the Railway hostname only, with no `https://`.
4. The zone apex (`example.com` with no subdomain) often cannot be a CNAME. If IONOS offers an ALIAS or ANAME record, point the apex at the Railway target. Otherwise serve Spontaco on `www` and redirect the apex to it.
5. Wait until Railway reports the domain as verified. It will request a Let's Encrypt certificate. HTTPS is not optional for installability or push.
6. Set `PUBLIC_BASE_URL` to that exact origin and redeploy so copied invite links use it.
7. Open the site from the new origin, install the PWA, and turn notifications on. Old push subscriptions from a different origin do not carry over.

## iOS push, specifically

- Requires iOS or iPadOS **16.4 or newer**.
- The app must be added to the Home Screen and opened from that icon. A Safari tab can load the UI and can register a service worker, but it will not show Web Push.
- Permission has to be granted from a tap inside the installed app (You → Enable notifications). iOS ignores permission requests that are not from a user gesture.
- Apple can delay or drop pushes if the installed app has not been opened for a while.
- Notification actions, images, and vibration are more limited than on Android.
- There is no App Store build. That is the point of the PWA.

## Layout

```
src/            server.ts, app.ts (HTTP API), config.ts, db.ts (SQLite)
  calendar/     calendar feeds, ICS, Google free/busy
  chat/         plan chat, colors, reply push
  push/         Web Push, reminders, VAPID keys
  social/       plans, socials, status, join codes
  map/          geocoding, PMTiles basemap
  admin/        admin queries, feedback, agent tokens, OpenAPI
  lib/          time, rate limit, client key, avatars
public/         the PWA sources
  js/           client modules (app.js and helpers), bundled by Vite
  css/          styles.css (bundled), welcome.css (copied)
  icons/ backgrounds/ vendor/
                images and third-party files, copied as they are
                HTML pages, manifest and whats-new.json stay at the root
sw/             sw.js, the service worker source (push, fetch rules, ack retry)
vite.config.ts  client build: bundles public/ into dist/client and generates the worker
dist/           `npm run build` output: the server (dist/*.js) and the client (dist/client)
test/           unit tests by area (calendar, chat, push, social, map, admin, lib),
                shared helpers (http.ts, fake-google.ts, fixtures/) and ui/ specs
Dockerfile      Railway and docker compose
railway.json    Dockerfile builder and health check
```

`POST /api/buzz/<token>` is the only unauthenticated write, and the token is the credential. Everything else uses `Authorization: Bearer <device token>`.

`/welcome` is a static public page about Spontaco (`public/welcome.html`, `public/css/welcome.css`). It has no script and no account data. Its buttons go to `/`, which is still the app, and nothing redirects to it. Its example map is 15 fixed OpenStreetMap tiles of central Stuttgart (`tile.openstreetmap.org`, loaded lazily by the visitor's browser, with OSM attribution) and four pink free-now pins for made-up friends at real squares. It does not use the app's map code or `MAP_TILE_URL`.

Google Search Console verification uses `public/googlee48df27048aaa965.html`, served at `/googlee48df27048aaa965.html`, and a `google-site-verification` meta tag in `public/index.html`. Leave both in place. Google re-checks them. The service worker does not intercept that file, and `public/robots.txt` allows it and the homepage. `/privacy` is the public privacy policy (`public/privacy.html`), a static page like `/welcome`.

## Location

Going free starts with nowhere. **Where?** can stay empty, use the phone's current location, or name a meetup. Search (a place or address) and a pin on a small map both come from OpenStreetMap, through the server, and a typed name is fine with no pin at all. Current location is one reading, rounded to about 100 metres. A place someone picked keeps that spot's coordinates. Spontaco does not watch location in the background. The meetup name and its coordinates are cleared as soon as the social expires. A plan's typed place name stays after that plan's day; only its pin is cleared. If location is denied, the social or plan is still created.

The push says who is free and, when there is a meetup, where: `Alex is free – meet at Café Einstein`. It never includes coordinates. Tapping it opens that social.

A card with a place does not embed a map. It shows a short line — the place name, or "nearby" — plus the distance when this phone has already allowed location, and an Open in Maps action.

The Events tab (formerly Map) opens on a month calendar of plans and hangouts; its Map / Calendar switch remembers your last pick (`hangry-events-view-v2`). Map shows the same places on a Leaflet map. The default basemap is Esri World Street Map: labelled streets and districts, no API key, readable at city zoom on a phone. CARTO Voyager and CARTO Dark Matter (`rastertiles/voyager` and `dark_all`) currently answer with an API-key watermark, so they are not the default. Set `MAP_TILE_URL` and `MAP_TILE_ATTRIBUTION` together to switch later. The attribution has to match the tiles. The map stops at zoom 19, which is the last level that still has street tiles here. Pink pins are friends who are free. Yellow pins are plans. Tap a pin for the name, note, time, Join, and Open in Maps. The map centers on you only if this device has already allowed location; otherwise it fits the pins. With no pins, the tab just says there is nothing to show. Open in Maps uses Apple Maps on iPhone and a `geo:` link on Android.

Place search goes through the server to Photon, then Nominatim, with a Hangry user-agent and about one request a second. When this phone has a location, or the map has been moved, results prefer places within about 30 km and put bars, cafés, and other meeting spots ahead of streets and regions. Each hit shows the distance and a short address.

## Feedback

**Send feedback** on the You tab opens a sheet with one text box, up to 2000 characters. `POST /api/feedback` with `{"text","circleId","appVersion"}` stores it with the sender, the circle they had open (only if they are a member), and the build label. It answers `201 {"ok":true,"id":"…"}`. Empty or over-long text is `400`. Each client may send five in ten minutes, then `429`. Feedback stays when its circle is deleted; the circle is cleared from it.

Operators read it with the admin token:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_BASE_URL/api/admin/feedback?status=new"
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"status":"done","prUrl":"https://github.com/Philipp0205/free-now/pulls","note":"Shipped"}' \
  "$PUBLIC_BASE_URL/api/admin/feedback/<id>"
```

`status` is one of `new`, `planned`, `in_progress`, `done`, `rejected`. A bad status is `400`, an unknown id is `404`, and like every operator route a missing or wrong token is also `404`. The list returns at most 500 rows, each with `id`, `userId`, `userName`, `circleId`, `circleName`, `text`, `appVersion`, `createdAt`, `status`, `prUrl`, `note`.

### When feedback is marked done

The first time a row moves to `done`, the server adds one in-app alert for the person who sent it, and only them: **Your suggestion is live**, with a short single-line quote of their text. Tapping it opens What's new. It is a personal alert (no circle), so it shows in whichever circle they open, and still reaches them after they leave the circle they sent it from. No phone push is sent for it in this version. The response carries `doneAlert`: `sent`, `already` (sent before, or the row was done before this feature), `no-user` (the sender no longer exists), or `none` (not a done write).

It is sent at most once per row. `feedback.done_alert` records it in the same transaction as the status change, and it is never cleared, so retries, repeat `done` writes, and reopening then `done` again do not send a second one. Rows that were already `done` when this column was added are marked `legacy` and never send, not at startup and not after a reopen.

**Operator rule:** the app cannot tell whether a change is deployed. Mark feedback `done` only after you have checked that the change is live in production. Not when the PR is opened, and not when it is merged.

## Changelog

The changelog lives in [`public/whats-new.json`](public/whats-new.json). The app shows it as **What's new**: once as a popup after an update, and any time from the You tab.

**Every merged PR that changes something people can see adds an entry.** Put it at the top. The list is newest first.

```json
{
  "id": "2026-11-05-short-name",
  "date": "2026-11-05",
  "title": "Short headline",
  "bullets": ["Two to four short lines.", "Say what changed for the person using the app."]
}
```

- `id` is lowercase letters, digits, and dashes, at most 64 characters, and never reused. The popup compares against the newest id each person has seen, stored on the phone (`fn_whats_new_seen`) and on the account (`users.whats_new_seen`, sent as `user.whatsNewSeen` from `/api/me`, set with `POST /api/me/whats-new {"id"}`).
- The popup shows only the entries above the one they last saw. New accounts start with the newest entry marked seen.
- Do not reorder or delete old entries. A seen id that is no longer in the file shows nothing new.
- Bump `APP_VERSION` in `public/js/app.js` in the same PR. The service worker and its precache list come from the Vite build, so there is no cache name to bump.

## Limitations

- One circle per person. Joining another means leaving the first. The last person to leave deletes the circle.
- Run a single server process. SQLite on a Railway volume is not a multi-instance database.
- Socials last two hours unless `SOCIAL_TTL_MS` says otherwise. Plans stay through their calendar day in `APP_TZ`, then drop off.
- Repeating the same note is quiet for 30 seconds. A changed note can notify again after 15 seconds.
- Without VAPID keys, nothing reaches the phone's notification tray. The in-app banner is the stand-in, on purpose, so two browsers can be tested on a laptop.
- With VAPID keys, push is still best-effort. A dead subscription (HTTP 404 or 410) is deleted. Other failures are logged and the social is still created.
- The buzzer token and recovery code are the same secret, stored in the database so it can be shown again. Protect the SQLite file.
- Clearing site data without saving that secret signs you out for good.
- Invite codes are unguessable enough for a circle of friends and are not rate-limited.
- "Tomorrow" follows `APP_TZ` (Europe/Berlin unless you set it), not each phone's timezone.
- A meetup is optional. Current location is rounded to about 100 metres; a chosen place can keep its coordinates. The social's place and pin are cleared as soon as it expires. There is no background tracking.
