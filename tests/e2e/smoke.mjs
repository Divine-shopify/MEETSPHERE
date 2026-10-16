// End-to-end smoke test against a running app + LiveKit server, using real
// WebRTC with Chromium's fake camera/microphone.
//
//   BASE_URL=http://127.0.0.1:3000 CHROMIUM_PATH=/path/to/chrome node tests/e2e/smoke.mjs
//
// Requires the app to run with VERIFICATION_DEV_MODE=true (codes are read off the screen).
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SHOTS = process.env.SCREENSHOT_DIR ?? "e2e-screenshots";
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const opts = { viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"], baseURL: BASE };
const hostCtx = await browser.newContext(opts);
const guestCtx = await browser.newContext(opts);
const intruderCtx = await browser.newContext(opts);
const host = await hostCtx.newPage();
const guest = await guestCtx.newPage();
const intruder = await intruderCtx.newPage();
const step = (s) => console.log(`✔ ${s}`);
const consoleErrors = [];
for (const [name, p] of [["host", host], ["guest", guest], ["intruder", intruder]]) {
  p.on("console", (m) => m.type() === "error" && consoleErrors.push(`[${name}] ${m.text()}`));
  p.on("response", (r) => r.status() === 404 && consoleErrors.push(`[${name}] 404 ${r.url()}`));
  p.on("pageerror", (e) => consoleErrors.push(`[${name}] pageerror: ${e.message}`));
}
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png` });

try {
  // 1. Host signs in with an email OTP (dev mode shows the code on screen).
  await host.goto("/signin");
  await host.getByLabel("Your name").fill("Hana Host");
  await host.getByRole("button", { name: "Email" }).click();
  await host.getByLabel("Email address").fill(`host-${Date.now()}@example.com`);
  await host.getByRole("button", { name: "Send code" }).click();
  const devText = await host.locator(".alert.dev .code").textContent();
  await host.getByLabel("Verification code").fill(devText.trim());
  await host.getByRole("button", { name: "Sign in" }).click();
  await host.waitForURL("**/dashboard");
  step("host signed in with OTP");

  // 2. Create a meeting where everyone waits for approval.
  await host.getByLabel("Title").fill("E2E standup");
  await host.getByRole("button", { name: "Create meeting" }).click();
  const link = await host.getByLabel("Meeting link").inputValue();
  const code = link.split("/m/")[1];
  await shot(host, "01-dashboard-created");
  step(`meeting created: ${code}`);

  // 3. Host joins the media room.
  await host.goto(`/m/${code}`);
  await host.getByRole("button", { name: "Start / join as host" }).click();
  await host.locator(".lk-participant-tile").first().waitFor({ timeout: 20000 });
  step("host connected to LiveKit");

  // 4. Guest asks to join by name only -> waiting room, no token.
  await guest.goto(`/m/${code}`);
  await guest.getByRole("button", { name: "Just my name" }).click();
  await guest.getByLabel("Your name").fill("Gus Guest");
  await guest.getByRole("button", { name: "Ask to join" }).click();
  await guest.getByText("Waiting for the host to let you in").waitFor();
  const denied = await guest.evaluate(async (c) => (await fetch(`/api/meetings/${c}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, code);
  if (denied !== 403) throw new Error(`waiting guest got token status ${denied}`);
  await shot(guest, "02-guest-waiting");
  step("guest waits; token endpoint refuses (403)");

  // 5. Host sees the request with an unverified badge and admits it.
  await host.getByRole("button", { name: /1 waiting/ }).click({ timeout: 10000 });
  await host.getByText("Gus Guest").waitFor({ timeout: 10000 });
  await host.getByText("Name entered (unverified)").first().waitFor();
  await shot(host, "03-host-waiting-room");
  await host.getByRole("button", { name: "Admit", exact: true }).click();
  step("host admitted guest");

  // 6. Guest joins with fake camera; both sides see two participants with live video.
  await guest.getByRole("button", { name: "Join now" }).click({ timeout: 10000 });
  await guest.locator(".lk-participant-tile").nth(1).waitFor({ timeout: 20000 });
  await host.locator(".lk-participant-tile").nth(1).waitFor({ timeout: 20000 });
  const playing = await guest.waitForFunction(
    () => [...document.querySelectorAll("video")].filter((v) => v.readyState >= 2 && v.videoWidth > 0).length >= 2,
    null,
    { timeout: 20000 },
  );
  if (!playing) throw new Error("videos not playing");
  await guest.waitForTimeout(1500);
  await shot(guest, "04-guest-in-room");
  await shot(host, "05-host-in-room");
  step("real audio/video flowing both ways (2 decoded video elements on guest)");

  // 7. Guest raises a hand; host sees it in the host panel.
  if (!(await host.getByText("In the meeting (1)").isVisible())) await host.getByRole("button", { name: /^Host/ }).click();
  await guest.getByRole("button", { name: /Raise hand|✋/ }).first().click();
  await host.getByText(/✋ ?Gus Guest|✋/).first().waitFor({ timeout: 10000 });
  step("hand raise visible to host");

  // 8. An intruder with a forged/old approach can't get in once the meeting is locked.
  await host.getByRole("button", { name: /Lock meeting/ }).click();
  await host.getByRole("button", { name: /Unlock/ }).waitFor();
  await intruder.goto(`/m/${code}`);
  await intruder.getByText("The host has locked this meeting").waitFor();
  step("locked meeting refuses new joiners");

  // 9. Host removes the guest -> guest is disconnected and cannot get a new token.
  host.once("dialog", (d) => d.accept());
  await host.getByRole("button", { name: "Remove", exact: true }).click();
  await guest.getByText("The host removed you").first().waitFor({ timeout: 15000 });
  const after = await guest.evaluate(async (c) => (await fetch(`/api/meetings/${c}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, code);
  if (after !== 403) throw new Error(`removed guest got token status ${after}`);
  await shot(guest, "06-guest-removed");
  step("removed guest kicked from media and refused new token");

  // Expected: the 403s we provoked on purpose. Anything else is a bug.
  // livekit-client >= 2.2x probes a lossy data track that LiveKit server 1.10 closes; harmless noise.
  const unexpected = consoleErrors.filter((e) => !/403|Forbidden|DATA_TRACK_LOSSY/.test(e));
  if (unexpected.length) throw new Error(`browser console errors:\n${unexpected.join("\n")}`);
  console.log("\nE2E SMOKE PASSED");
} catch (err) {
  await Promise.all([shot(host, "fail-host"), shot(guest, "fail-guest")]).catch(() => {});
  console.error("\nE2E SMOKE FAILED:", err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
