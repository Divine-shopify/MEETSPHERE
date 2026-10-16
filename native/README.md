# MeetSphere native apps (Android & iOS)

Thin [Capacitor](https://capacitorjs.com) shells that load your hosted MeetSphere
site, so the apps always run the same code and the same server-side admission
rules as the web app. The web app is already installable as a PWA; use these
when you need store presence or native distribution.

> **Status:** projects are generated and configured (camera/microphone
> permissions, allowed origin), but they have **not been compiled, run on a
> device, or submitted** — that needs Android Studio / Xcode, signing keys and
> developer accounts, which weren't available where this was built.

## Build

```bash
cd native
npm ci
MEETSPHERE_URL=https://meet.yourdomain.com MEETSPHERE_APP_ID=com.yourco.meetsphere npx cap sync

# Android: needs Android Studio + SDK 35
npx cap open android      # Build > Generate Signed Bundle (AAB) for Google Play

# iOS: needs macOS + Xcode 16
npx cap open ios          # set your Team, then Product > Archive for App Store Connect
```

## What to check on a device before release

- Camera/mic permission prompts appear and video works (WKWebView needs iOS 14.3+).
- Screen sharing: not available inside iOS WKWebView; Android WebView support varies. Hosts who need to share their screen should use a desktop browser.
- Live captions use the browser's speech recognition; availability inside WebViews varies by OS version.
- Audio routes to the speaker (not the earpiece) on phones.
- App Store review: Apple may reject apps that are "just a website" (guideline 4.2). Plan native touches (push notifications for "the host let you in", CallKit) if that happens.
