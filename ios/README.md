# Hangry for iOS

A native shell around the live Hangry site. It ships no web code: the app opens `https://hangry.up.railway.app/` in a full-screen web view, so every change to the web app shows up without a new build.

Nothing outside this folder depends on it. The only other file is `codemagic.yaml` in the repo root, which builds this folder and uploads it to TestFlight. Delete both to remove the iOS app.

## What is in here

- `project.yml` — the XcodeGen spec. `xcodegen generate` creates `Hangry.xcodeproj` and `Hangry/Info.plist` from it; neither is checked in.
- `Hangry/HangryApp.swift` — app entry point.
- `Hangry/WebViewController.swift` — the web view. The site URL is `AppConfig.home` at the top.
- `Hangry/Assets.xcassets` — app icon (scaled up from `public/icons/icon-512.png`) and the black launch background.

## What the shell does on top of the site

- Tells the page it is already installed, so the Add to Home Screen and Web Push reminders stay quiet.
- Opens links to other sites, maps, and `mailto:` outside the app.
- Shows native dialogs for `window.confirm`, which a bare web view ignores.
- Shows a retry screen when the site cannot be reached.

## Not yet

Phone notifications. Web Push does not exist inside an app's web view, so alerts only appear while the app is open. Real push needs APNs on the server.

## Build

Codemagic runs the `ios-testflight` workflow from `codemagic.yaml`. It needs:

- an App Store Connect API key added under Integrations, named `hangry`
- a variable group `hangry_ios` with `CERTIFICATE_PRIVATE_KEY`

The bundle ID is `io.kurrle.hangry`.
