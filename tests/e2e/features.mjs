// UI-level end-to-end test of in-meeting features with real WebRTC.
//   BASE_URL=... CHROMIUM_PATH=... DATABASE_URL=... node tests/e2e/features.mjs
// DATABASE_URL is used only to put the test host on a paid plan (recording).
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SHOTS = process.env.SCREENSHOT_DIR ?? "e2e-screenshots";
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const desktop = { viewport: { width: 1280, height: 800 }, permissions: ["camera", "microphone"], baseURL: BASE };
const phone = { viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"], baseURL: BASE, isMobile: true, hasTouch: true };
const host = await (await browser.newContext(desktop)).newPage();
const ana = await (await browser.newContext(phone)).newPage();
const ben = await (await browser.newContext(desktop)).newPage();
const step = (s) => console.log(`✔ ${s}`);
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png` });
const api = (page, path, body) =>
  page.evaluate(async ([path, body]) => {
    const r = await fetch(path, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, body]);
const openPanel = async (page, name) => {
  const btn = page.locator(".room-top button", { hasText: name }).first();
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
};

try {
  // Host
  await host.goto("/");
  const email = `feat-${Date.now()}@example.com`;
  const s = await api(host, "/api/auth/start", { channel: "email", destination: email });
  await api(host, "/api/auth/verify", { challengeId: s.json.challengeId, code: s.json.devCode, displayName: "Hana Host" });
  if (process.env.DATABASE_URL) {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query("INSERT INTO billing_accounts (user_id, plan_id) SELECT id, 'pro' FROM users WHERE email = $1 ON CONFLICT (user_id) DO UPDATE SET plan_id = 'pro'", [email]);
    await db.end();
  }
  const m = await api(host, "/api/meetings", { title: "Feature tour", accessPolicy: "anyone_with_link", qaModerated: false });
  const code = m.json.meeting.code;
  await host.goto(`/m/${code}`);
  await host.getByRole("button", { name: /join as host/i }).click();
  await host.locator(".lk-participant-tile").first().waitFor({ timeout: 20000 });
  step(`host in meeting ${code}`);

  for (const [p, name] of [[ana, "Ana"], [ben, "Ben"]]) {
    await p.goto(`/m/${code}`);
    await p.getByRole("button", { name: "Just my name" }).click();
    await p.getByLabel("Your name").fill(name);
    await p.getByRole("button", { name: "Ask to join" }).click();
    await p.getByRole("button", { name: "Join now" }).click({ timeout: 15000 });
    await p.locator(".lk-participant-tile").first().waitFor({ timeout: 20000 });
  }
  step("Ana (phone) and Ben (desktop) joined");

  // Q&A: live updates both ways over server-sent events.
  await openPanel(ana, "Q&A");
  await ana.getByPlaceholder("Ask a question…").fill("Will the slides be shared?");
  await ana.getByRole("button", { name: "Ask", exact: true }).click();
  await openPanel(host, "Q&A");
  await host.getByText("Will the slides be shared?").waitFor({ timeout: 10000 });
  await openPanel(ben, "Q&A");
  await ben.getByRole("button", { name: /Upvote/ }).click();
  await host.getByRole("button", { name: "Upvote (1)" }).waitFor({ timeout: 10000 });
  await host.getByRole("button", { name: "Mark answered" }).click();
  await ana.getByRole("button", { name: "Answered" }).click();
  await ana.getByText("Will the slides be shared?").waitFor({ timeout: 10000 });
  await shot(ana, "10-phone-qa");
  step("Q&A: ask, live upvote, mark answered (pushed to all)");

  // Polls
  await openPanel(host, "Polls");
  await host.getByRole("button", { name: "New poll" }).click();
  await host.getByLabel("Question").fill("Next session?");
  await host.getByLabel("Option 1").fill("Tuesday");
  await host.getByLabel("Option 2").fill("Thursday");
  await host.getByRole("button", { name: "Launch now" }).click();
  await openPanel(ben, "Polls");
  await ben.getByLabel("Thursday").check({ timeout: 10000 });
  await ben.getByRole("button", { name: "Vote" }).click();
  await host.getByText("1 vote", { exact: true }).waitFor({ timeout: 10000 });
  await host.getByRole("button", { name: "Share results" }).click();
  await ben.locator(".bar").first().waitFor({ timeout: 10000 });
  await shot(host, "11-host-polls");
  step("Polls: launch, vote, share results");

  // Captions with per-person consent.
  await openPanel(host, "Host");
  await host.getByRole("button", { name: /^CC on/ }).click();
  // Everyone is asked, the host included.
  await host.getByRole("button", { name: "Allow my speech" }).click({ timeout: 10000 });
  await ana.getByRole("dialog").getByText("Captions and transcript are on").waitFor({ timeout: 10000 });
  await shot(ana, "12-phone-caption-consent");
  await ana.getByRole("button", { name: "Allow my speech" }).click();
  await ben.getByRole("button", { name: "Don't transcribe me" }).click({ timeout: 10000 });
  // Headless Chromium has no speech engine; send what the browser would have recognized.
  const cap = await api(ana, `/api/meetings/${code}/captions`, { text: "Thanks everyone for joining" });
  if (cap.status !== 200) throw new Error(`caption ${cap.status}`);
  const blocked = await api(ben, `/api/meetings/${code}/captions`, { text: "should not appear" });
  if (blocked.status !== 403) throw new Error("non-consenting speaker was transcribed");
  await host.locator(".captions", { hasText: "Thanks everyone for joining" }).waitFor({ timeout: 10000 });
  await shot(host, "13-host-captions");
  step("Captions: consent dialog, consented speech captioned live, non-consenting speaker refused");

  // Whiteboard: Ben draws, host's board shows it.
  await openPanel(ben, "Board");
  const board = ben.locator('canvas.wb-canvas[data-ready="1"]');
  await board.waitFor();
  const box = await board.boundingBox();
  await ben.mouse.move(box.x + 40, box.y + 40);
  await ben.mouse.down();
  for (let i = 1; i <= 10; i++) await ben.mouse.move(box.x + 40 + i * 20, box.y + 40 + i * 12);
  await ben.mouse.up();
  await openPanel(host, "Board");
  const strokes = await host.waitForFunction(async (code) => {
    const r = await fetch(`/api/meetings/${code}/whiteboard`).then((r) => r.json());
    return r.strokes.length;
  }, code, { timeout: 10000 });
  const inked = await host.locator("canvas.wb-canvas").evaluate((c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  if (!inked) throw new Error("host whiteboard is blank");
  await shot(host, "14-host-whiteboard");
  step(`Whiteboard: stroke shared (${await strokes.jsonValue()} stroke, ${inked} inked pixels on host canvas)`);

  // Breakout rooms: participants are moved automatically and brought back.
  await openPanel(host, "Rooms");
  await host.getByRole("button", { name: "Create rooms" }).click();
  await host.getByRole("button", { name: "Assign everyone randomly" }).click();
  await host.getByRole("combobox", { name: "Room for Ana" }).waitFor();
  await host.waitForFunction(() => [...document.querySelectorAll(".room-side select")].every((s) => s.value), null, { timeout: 10000 });
  await host.getByRole("button", { name: "Open rooms" }).click();
  await host.getByRole("button", { name: /Close rooms/ }).waitFor({ timeout: 10000 });
  await ana.getByText("You're in a breakout room").waitFor({ timeout: 20000 });
  await ben.getByText("You're in a breakout room").waitFor({ timeout: 20000 });
  await ana.locator(".lk-participant-tile").first().waitFor({ timeout: 20000 });
  await host.getByPlaceholder("Message to all rooms").fill("5 minutes left");
  await host.getByRole("button", { name: "Send" }).click();
  await ana.locator(".toast", { hasText: "5 minutes left" }).waitFor({ timeout: 10000 });
  await shot(ana, "15-phone-breakout");
  await host.getByRole("button", { name: /Close rooms/ }).click();
  await ana.getByText("You're in a breakout room").waitFor({ state: "detached", timeout: 20000 });
  await ben.getByText("You're in a breakout room").waitFor({ state: "detached", timeout: 20000 });
  // Phone grids paginate, so count people rather than visible tiles.
  await ana.locator(".room-top button", { hasText: "People 3" }).waitFor({ timeout: 20000 });
  step("Breakouts: auto-assign, auto-move into rooms, broadcast message, everyone back in main room");

  // Recording notice for participants.
  await openPanel(host, "Host");
  const rec = await api(host, `/api/meetings/${code}/recording`, { action: "start" });
  if (rec.status === 200) {
    await ana.getByRole("dialog").getByText("This meeting is being recorded").waitFor({ timeout: 15000 });
    await shot(ana, "16-phone-recording-notice");
    await ana.getByRole("button", { name: "Continue" }).click();
    await ana.locator(".banner", { hasText: "being recorded" }).waitFor();
    await api(host, `/api/meetings/${code}/recording`, { action: "stop" });
    step("Recording: participants get a notice they must acknowledge, with a persistent banner");
  } else {
    step(`Recording skipped: ${rec.json?.error?.code}`);
  }

  // Abuse report reaches the host.
  await openPanel(ben, "People");
  await ben.getByRole("button", { name: "Report a problem" }).click();
  await ben.getByLabel("What's wrong?").selectOption("spam");
  await ben.getByRole("button", { name: "Send report" }).click();
  await ben.getByText("The host and the MeetSphere safety team have been notified").waitFor();
  await host.getByText("A participant reported abuse").waitFor({ timeout: 10000 });
  await shot(host, "17-host-safety-alert");
  step("Abuse report: confirmed to reporter, alert shown to host");

  console.log("\nE2E FEATURES PASSED");
} catch (err) {
  console.error("\nE2E FEATURES FAILED:", err.message.split("\n").slice(0, 4).join(" | "));
  await Promise.all([shot(host, "fail-host"), shot(ana, "fail-ana"), shot(ben, "fail-ben")]).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
