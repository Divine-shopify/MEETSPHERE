import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The native apps are thin shells around the hosted web app: one codebase,
 * instant updates, and the same server-side admission rules. Set
 * MEETSPHERE_URL to your production origin before `npx cap sync`.
 */
const url = process.env.MEETSPHERE_URL ?? "https://meet.example.com";

const config: CapacitorConfig = {
  appId: process.env.MEETSPHERE_APP_ID ?? "com.example.meetsphere",
  appName: "MeetSphere",
  webDir: "www", // offline fallback page only
  server: {
    url,
    cleartext: false,
    allowNavigation: [new URL(url).host],
  },
  ios: {
    contentInset: "automatic",
    // Required for camera/mic inside WKWebView.
    allowsLinkPreview: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
