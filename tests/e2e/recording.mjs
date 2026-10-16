// End-to-end: real recording (MP4) and live HLS stream through LiveKit Egress.
// Needs: running app (VERIFICATION_DEV_MODE=true, RECORDINGS_DIR or S3_*), LiveKit
// server with webhook to the app, an Egress worker, and DATABASE_URL to grant a
// paid plan to the test host.
//   BASE_URL=... CHROMIUM_PATH=... DATABASE_URL=... node tests/e2e/recording.mjs
import { chromium } from "playwright-core";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctxOpts = { permissions: ["camera", "microphone"], baseURL: BASE };
const host = await (await browser.newContext(ctxOpts)).newPage();
const viewer = await (await browser.newContext(ctxOpts)).newPage();
const outsider = await (await browser.newContext(ctxOpts)).newPage();
const step = (s) => console.log(`✔ ${s}`);
const api = (page, path, body, method) =>
  page.evaluate(
    async ([path, body, method]) => {
      const r = await fetch(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, type: r.headers.get("content-type"), length: text.length, text: text.slice(0, 300) };
    },
    [path, body, method],
  );
const until = async (fn, ms, label) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out: ${label}`);
};

try {
  await host.goto("/");
  const email = `rec-${Date.now()}@example.com`;
  const s = await api(host, "/api/auth/start", { channel: "email", destination: email });
  await api(host, "/api/auth/verify", { challengeId: s.json.challengeId, code: s.json.devCode, displayName: "Rita Recorder" });
  const m = await api(host, "/api/meetings", { title: "Recording test", accessPolicy: "anyone_with_link", mode: "broadcast" });
  const code = m.json.meeting.code;
  await db.query(
    "INSERT INTO billing_accounts (user_id, plan_id) SELECT id, 'pro' FROM users WHERE email = $1 ON CONFLICT (user_id) DO UPDATE SET plan_id = 'pro'",
    [email],
  );
  step(`host on Pro plan, meeting ${code}`);

  await host.goto(`/m/${code}`);
  await host.getByRole("button", { name: /join as host/i }).click();
  await host.locator(".lk-participant-tile").first().waitFor({ timeout: 20000 });
  await host.waitForTimeout(2000);
  step("host publishing fake camera/mic");

  // ---- Recording ----
  const start = await api(host, `/api/meetings/${code}/recording`, { action: "start" });
  if (start.status !== 200) throw new Error(`start recording: ${start.status} ${start.text}`);
  await until(async () => (await api(host, `/api/meetings/${code}`)).json.meeting.recordingActive, 30000, "recording active");
  await until(async () => (await db.query("SELECT recording_state FROM meetings WHERE code = $1", [code])).rows[0].recording_state === "active", 45000, "egress active");
  step("recording active (egress started, webhook received)");
  await host.waitForTimeout(10000);
  await api(host, `/api/meetings/${code}/recording`, { action: "stop" });
  const art = await until(async () => {
    const r = await api(host, `/api/meetings/${code}/artifacts`);
    return r.json.artifacts.find((a) => a.type === "recording" && (a.status === "ready" || a.status === "failed"));
  }, 90000, "recording ready");
  if (art.status !== "ready") throw new Error(`recording failed: ${art.error}`);
  const file = await api(host, `/api/meetings/${code}/artifacts/${art.id}`);
  if (file.status !== 200 || !file.type?.includes("video/mp4") || file.length < 20000) throw new Error(`bad recording download ${file.status} ${file.type} ${file.length}`);
  step(`recording ready: ${(art.durationMs / 1000).toFixed(1)}s, ${(art.sizeBytes / 1024).toFixed(0)} KB, served as video/mp4`);
  await outsider.goto("/");
  const denied = await api(outsider, `/api/meetings/${code}/artifacts/${art.id}`);
  if (denied.status !== 403) throw new Error(`outsider got recording: ${denied.status}`);
  step("outsider refused the recording (403)");

  // ---- Live HLS stream ----
  await viewer.goto("/");
  const j = await api(viewer, `/api/meetings/${code}/join`, { name: "Victor Viewer", method: "name" });
  if (j.json.request.status !== "admitted") throw new Error("viewer not admitted");
  const st = await api(host, `/api/meetings/${code}/stream-control`, { action: "start" });
  if (st.status !== 200) throw new Error(`start stream: ${st.status} ${st.text}`);
  const playlist = await until(async () => {
    const r = await api(viewer, `/api/meetings/${code}/stream/${st.json.artifactId}/live.m3u8`);
    return r.status === 200 && r.text.includes("#EXTINF") ? r : null;
  }, 90000, "live playlist with segments");
  step(`viewer receives live HLS playlist (${playlist.text.split("\n").filter((l) => l.startsWith("#EXTINF")).length} segment(s))`);
  const seg = playlist.text.split("\n").find((l) => l && !l.startsWith("#"));
  const segRes = await api(viewer, `/api/meetings/${code}/stream/${st.json.artifactId}/${seg.trim()}`);
  if (segRes.status !== 200) throw new Error(`segment fetch ${segRes.status}`);
  step(`viewer fetched segment ${seg.trim()} (${segRes.type})`);
  const out = await api(outsider, `/api/meetings/${code}/stream/${st.json.artifactId}/live.m3u8`);
  if (out.status !== 403) throw new Error(`outsider got stream ${out.status}`);
  step("outsider refused the live stream (403)");

  // The watch page loads the stream with hls.js. Playwright's open-source Chromium has
  // no H.264 decoder, so where decoding is unavailable we assert manifest + segment
  // loading and validate the media itself with ffprobe below.
  await viewer.goto(`/m/${code}/watch`);
  const h264 = await viewer.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'));
  if (h264) {
    await viewer.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 2 && v.videoWidth > 0; }, null, { timeout: 45000 });
    step("watch page decodes and plays the live stream");
  } else {
    await viewer.waitForFunction(() => document.querySelector("video")?.dataset.manifestLoaded === "1", null, { timeout: 45000 });
    const why = await viewer.evaluate(() => document.querySelector("video")?.dataset.hlsError ?? "none");
    step(`watch page fetched the live manifest via hls.js (this Chromium build has no H.264 decoder; hls.js reported: ${why})`);
  }
  if (process.env.RECORDINGS_DIR) {
    const { execFileSync } = await import("node:child_process");
    const probe = (f) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", f]).toString().trim();
    const mid = (await db.query("SELECT id FROM meetings WHERE code = $1", [code])).rows[0].id;
    step(`ffprobe recording: ${probe(`${process.env.RECORDINGS_DIR}/${mid}/rec-${art.id}.mp4`)}`);
    step(`ffprobe live segment: ${probe(`${process.env.RECORDINGS_DIR}/${mid}/stream-${st.json.artifactId}/${seg.trim()}`)}`);
  }

  await api(host, `/api/meetings/${code}/stream-control`, { action: "stop" });
  await until(async () => (await db.query("SELECT stream_state FROM meetings WHERE code = $1", [code])).rows[0].stream_state === "off", 60000, "stream stopped");
  step("stream stopped and finalized");
  console.log("\nE2E RECORDING/STREAM PASSED");
} catch (err) {
  console.error("\nE2E RECORDING/STREAM FAILED:", err.message);
  await host.screenshot({ path: "/tmp/rec-fail-host.png" }).catch(() => {});
  await viewer.screenshot({ path: "/tmp/rec-fail-viewer.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  // Never leave an egress job running (it holds a worker until the room empties).
  await db.query("SELECT code FROM meetings WHERE stream_state <> 'off' OR recording_state <> 'off'").then(async (r) => {
    for (const { code } of r.rows) {
      await api(host, `/api/meetings/${code}/stream-control`, { action: "stop" }).catch(() => {});
      await api(host, `/api/meetings/${code}/recording`, { action: "stop" }).catch(() => {});
    }
  }).catch(() => {});
  await browser.close();
  await db.end();
}
