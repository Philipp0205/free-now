# Hangry

Hangry is a small, installable web app for an invite-only circle of friends. Tap once when you're free. Everyone in the circle gets a push. They tap Join, and you hear about it.

It is a PWA: home-screen install on Android and on iPhone (iOS 16.4+), no app store. The server, the SQLite database, and the web push setup all live in this repo. The repo and the npm package are named `free-now`. The name people see is Hangry. The public site is whatever you set in `PUBLIC_BASE_URL`. The custom domain is not chosen yet.

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
2. Profile B: open <http://localhost:3000>. Enter a name (Veit) and join with that code. An invite link (`/join/CODE`) skips the code box after they choose a name.
3. Profile A: tap the glowing circle, type `Rooftop coffee??`, and press **I'm free**.
4. Profile B: a banner appears — `"Rooftop coffee??"` / `Alex is free now`. The social is on the Now screen. Tap **Join**.
5. Profile A: the banner says `"Rooftop coffee??"` / `Veit joined your social!`

Tomorrow plans use the **+** button. Friends join those the same way. A social ends on its own after about two hours (change `SOCIAL_TTL_MS`), or the creator can end it early.

Real phone push is a separate step. Generate VAPID keys, set them in the environment, restart, and use **Turn on notifications** in the You tab. On an iPhone that button only works after the app is on the Home Screen.

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

## Buzzer

Each user has a secret URL. An ESP32 (or `curl`) can hit it. No session header.

```bash
curl -X POST http://localhost:3000/api/buzz/YOUR_TOKEN \
  -H 'content-type: application/json' \
  -d '{"note":"Rooftop coffee??"}'
```

A POST with an empty body is also fine — the note is optional. The token is on the You tab, inside the same curl snippet. Pressing it again refreshes the two-hour timer. The same note will not push more than once every 30 seconds, so a bouncy button does not spam the circle. Changing the note can notify again after 15 seconds.

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
| `APP_TZ` | `UTC` | Timezone that decides what "tomorrow" means. Example: `Europe/Berlin`. |
| `MAP_TILE_URL` | Esri World Dark Gray | HTTPS tile template with `{z}`, `{x}`, and `{y}`. `{s}` is a subdomain and `{r}` is retina when the template contains them. |
| `MAP_TILE_ATTRIBUTION` | `© Esri, HERE, Garmin, OpenStreetMap contributors` | Shown on the map. Change this whenever you change the tiles. |

See `.env.example`. Real environment variables override a `.env` file — this server does not load `.env` itself. Export them, or use Docker / Railway.

## Generate VAPID keys

```bash
npm run vapid
```

Put the printed lines in the environment and restart. Then, on a phone:

1. Open the site over HTTPS (localhost is the only HTTP exception).
2. Install it (below).
3. You → **Turn on notifications**. Allow the prompt.
4. **Send a test push** to confirm the phone actually receives one.

## Install the app

The manifest, icons, and service worker are served by the same Node process.

- **Android (Chrome):** the browser offers install, or use the menu → Install app / Add to Home screen. Push works in the browser tab too, but the home-screen icon is the one that matches the product.
- **iPhone (Safari, iOS 16.4 or newer):** tap Share → Add to Home Screen, then open Hangry from that icon. The app shows this hint on iPhones that are still inside Safari. iOS will not deliver Web Push to a normal Safari tab.

The icon is a soft pink-to-red glow on black.

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
4. The zone apex (`example.com` with no subdomain) often cannot be a CNAME. If IONOS offers an ALIAS or ANAME record, point the apex at the Railway target. Otherwise serve Hangry on `www` and redirect the apex to it.
5. Wait until Railway reports the domain as verified. It will request a Let's Encrypt certificate. HTTPS is not optional for installability or push.
6. Set `PUBLIC_BASE_URL` to that exact origin and redeploy so copied invite links use it.
7. Open the site from the new origin, install the PWA, and turn notifications on. Old push subscriptions from a different origin do not carry over.

## iOS push, specifically

- Requires iOS or iPadOS **16.4 or newer**.
- The app must be added to the Home Screen and opened from that icon. A Safari tab can load the UI and can register a service worker, but it will not show Web Push.
- Permission has to be granted from a tap inside the installed app (You → Turn on notifications). iOS ignores permission requests that are not from a user gesture.
- Apple can delay or drop pushes if the installed app has not been opened for a while.
- Notification actions, images, and vibration are more limited than on Android.
- There is no App Store build. That is the point of the PWA.

## Layout

```
src/            HTTP API, SQLite, Web Push
public/         the PWA (HTML, CSS, service worker, manifest, icons)
test/           circle → social → push → join → expiry
Dockerfile      Railway and docker compose
railway.json    Dockerfile builder and health check
```

`POST /api/buzz/<token>` is the only unauthenticated write, and the token is the credential. Everything else uses `Authorization: Bearer <device token>`.

## Location

Sharing a place is off until someone turns on **Share where I am** when going free, or **Use my location** on a tomorrow plan. The device remembers that choice. While it is on, Hangry takes one reading at the moment you publish. It does not watch your location in the background. The coordinates are rounded to about 100 metres and deleted with the social or plan when it expires. If location is denied, the social or plan is still created.

A tomorrow plan can also name a place in words. A push may include that name. It never includes coordinates.

A card with a place does not embed a map. It shows a short line — the place name, or "nearby" — plus the distance when this phone has already allowed location, and an Open in Maps action.

The Map tab (not a switch on Now) shows the same places on a Leaflet map. The default basemap is Esri World Dark Gray: a dark street map with no API key. CARTO Dark Matter (`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`) now answers with an API-key watermark, so it is not the default. Set `MAP_TILE_URL` and `MAP_TILE_ATTRIBUTION` together to switch later, for example to CARTO or Stadia once you have a key. The attribution has to match the tiles. Pink pins are friends who are free. Yellow pins are plans. Tap a pin for the name, note, time, Join, and Open in Maps. The map centers on you only if this device has already allowed location; otherwise it fits the pins. With no pins, the tab just says there is nothing to show. Open in Maps uses Apple Maps on iPhone and a `geo:` link on Android.

## Limitations

- One circle per person. Joining another means leaving the first. The last person to leave deletes the circle.
- Run a single server process. SQLite on a Railway volume is not a multi-instance database.
- Socials last two hours unless `SOCIAL_TTL_MS` says otherwise. Tomorrow plans stay through that calendar day in `APP_TZ`, then drop off.
- Repeating the same note is quiet for 30 seconds. A changed note can notify again after 15 seconds.
- Without VAPID keys, nothing reaches the phone's notification tray. The in-app banner is the stand-in, on purpose, so two browsers can be tested on a laptop.
- With VAPID keys, push is still best-effort. A dead subscription (HTTP 404 or 410) is deleted. Other failures are logged and the social is still created.
- The buzzer token and recovery code are the same secret, stored in the database so it can be shown again. Protect the SQLite file.
- Clearing site data without saving that secret signs you out for good.
- Invite codes are unguessable enough for a circle of friends and are not rate-limited.
- "Tomorrow" follows `APP_TZ`, not each phone's timezone.
- Location is optional, rounded to about 100 metres, and removed when the social or plan expires. There is no background tracking.
