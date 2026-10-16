import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as authStart from "@/app/api/auth/start/route";
import * as ssoStart from "@/app/api/auth/sso/start/route";
import * as ssoCallback from "@/app/api/auth/sso/callback/route";
import * as breakouts from "@/app/api/meetings/[code]/breakouts/route";
import * as token from "@/app/api/meetings/[code]/token/route";
import * as whiteboard from "@/app/api/meetings/[code]/whiteboard/route";
import * as wbClear from "@/app/api/meetings/[code]/whiteboard/clear/route";
import * as transcription from "@/app/api/meetings/[code]/transcription/route";
import * as consent from "@/app/api/meetings/[code]/consent/route";
import * as captions from "@/app/api/meetings/[code]/captions/route";
import * as transcript from "@/app/api/meetings/[code]/transcript/route";
import * as settings from "@/app/api/meetings/[code]/settings/route";
import * as recording from "@/app/api/meetings/[code]/recording/route";
import * as summarize from "@/app/api/meetings/[code]/notes/summarize/route";
import * as notes from "@/app/api/meetings/[code]/notes/route";
import * as search from "@/app/api/search/route";
import * as dialin from "@/app/api/meetings/[code]/dialin/route";
import * as end from "@/app/api/meetings/[code]/end/route";
import * as accountWebhooks from "@/app/api/account/webhooks/route";
import * as stripeWebhook from "@/app/api/billing/webhook/route";
import * as orgs from "@/app/api/orgs/route";
import * as org from "@/app/api/orgs/[slug]/route";
import * as orgMembers from "@/app/api/orgs/[slug]/members/route";
import * as orgSso from "@/app/api/orgs/[slug]/sso/route";
import * as admin from "@/app/api/admin/route";
import * as cron from "@/app/api/cron/cleanup/route";
import { admitSipCaller } from "@/lib/admission";
import { pool } from "@/lib/db";
import { getMeetingByCode } from "@/lib/meetings";
import { verifyStripeSignature } from "@/lib/billing";
import { deliverDue, signPayload } from "@/lib/webhooks";
import { Browser, decodeJwt, hostWithMeeting, joinAs, setPlan, signIn, uniqueEmail } from "./helpers";

describe("breakout rooms", () => {
  it("assigns people, moves their media token into the breakout, and brings them back", async () => {
    const { host, code, meetingId } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const people = await Promise.all(["A", "B", "C", "D"].map((n) => joinAs(code, n)));
    expect((await people[0].b.call(breakouts.POST, { params: { code }, body: { action: "create", count: 2 } })).status).toBe(404);

    await host.call(breakouts.POST, { params: { code }, body: { action: "create", count: 2 } });
    const assigned = await host.call(breakouts.POST, { params: { code }, body: { action: "auto_assign" } });
    expect(assigned.body.rooms.map((r: any) => r.members.length)).toEqual([2, 2]);

    // Before opening: still the main room.
    expect(decodeJwt((await people[0].b.call(token.POST, { params: { code }, body: {} })).body.token).video.room).toBe(meetingId);
    await host.call(breakouts.POST, { params: { code }, body: { action: "open" } });
    const mine = await people[0].b.call(breakouts.GET, { params: { code } });
    const t = await people[0].b.call(token.POST, { params: { code }, body: {} });
    expect(decodeJwt(t.body.token).video.room).toBe(`${meetingId}~${mine.body.myBreakoutId}`);
    // Participants only see their own room's members.
    expect(mine.body.rooms.filter((r: any) => r.members).length).toBe(1);

    // A participant can't pick a different room; the host can visit any.
    const other = mine.body.rooms.find((r: any) => r.id !== mine.body.myBreakoutId).id;
    expect(decodeJwt((await people[0].b.call(token.POST, { params: { code }, body: { room: other } })).body.token).video.room).toBe(`${meetingId}~${mine.body.myBreakoutId}`);
    expect(decodeJwt((await host.call(token.POST, { params: { code }, body: { room: other } })).body.token).video.room).toBe(`${meetingId}~${other}`);

    await host.call(breakouts.POST, { params: { code }, body: { action: "close" } });
    expect(decodeJwt((await people[0].b.call(token.POST, { params: { code }, body: {} })).body.token).video.room).toBe(meetingId);
  });
});

describe("whiteboard", () => {
  it("shares strokes with participants and only lets moderators clear", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const { b } = await joinAs(code, "Drawer");
    const stroke = { color: "#ff0000", width: 3, points: [[0.1, 0.1], [0.5, 0.5]] };
    expect((await b.call(whiteboard.POST, { params: { code }, body: stroke })).status).toBe(200);
    expect((await b.call(whiteboard.POST, { params: { code }, body: { ...stroke, points: [[2, 2]] } })).status).toBe(400);
    expect((await host.call(whiteboard.GET, { params: { code } })).body.strokes).toHaveLength(1);
    expect((await b.call(wbClear.POST, { params: { code }, body: {} })).status).toBe(404);
    await host.call(wbClear.POST, { params: { code }, body: {} });
    expect((await b.call(whiteboard.GET, { params: { code } })).body.strokes).toHaveLength(0);
    await host.call(settings.PATCH, { method: "PATCH", params: { code }, body: { whiteboardEnabled: false } });
    expect((await b.call(whiteboard.POST, { params: { code }, body: stroke })).status).toBe(403);
  });
});

describe("captions and transcripts", () => {
  it("only transcribes people who consented, and enforces replay visibility", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const { b: yes } = await joinAs(code, "Yolanda");
    const { b: no } = await joinAs(code, "Nils");
    expect((await yes.call(captions.POST, { params: { code }, body: { text: "hello" } })).status).toBe(409);
    expect((await yes.call(transcription.POST, { params: { code }, body: { on: true } })).status).toBe(404);
    await host.call(transcription.POST, { params: { code }, body: { on: true } });

    expect((await yes.call(captions.POST, { params: { code }, body: { text: "hello" } })).status).toBe(403);
    await yes.call(consent.POST, { params: { code }, body: { kind: "transcription", granted: true } });
    await no.call(consent.POST, { params: { code }, body: { kind: "transcription", granted: false } });
    expect((await yes.call(captions.POST, { params: { code }, body: { text: "The budget is approved" } })).status).toBe(200);
    expect((await no.call(captions.POST, { params: { code }, body: { text: "secret" } })).status).toBe(403);

    const t = await host.call(transcript.GET, { params: { code } });
    expect(t.body.segments.map((s: any) => s.text)).toEqual(["The budget is approved"]);
    // Replay visibility defaults to host only.
    expect((await yes.call(transcript.GET, { params: { code } })).status).toBe(403);
    await host.call(settings.PATCH, { method: "PATCH", params: { code }, body: { replayVisibility: "attendees" } });
    expect((await yes.call(transcript.GET, { params: { code } })).status).toBe(200);
    expect((await new Browser().call(transcript.GET, { params: { code } })).status).toBe(403);

    const vtt = await transcript.GET(
      new Request("http://localhost:3000/x?format=vtt", { headers: { cookie: [...host.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } }),
      { params: Promise.resolve({ code }) },
    );
    expect(await vtt.text()).toMatch(/^WEBVTT[\s\S]*<v Yolanda>The budget is approved/);

    // Searchable by the host.
    const s = await host.call(search.GET.bind(null) as any, {});
    expect(s.status).toBe(200);
    const found = await search.GET(
      new Request("http://localhost:3000/api/search?q=budget", { headers: { cookie: [...host.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } }),
      { params: Promise.resolve({}) },
    );
    const body = await found.json();
    expect(body.results[0]).toMatchObject({ code, kind: "transcript" });
  });
});

describe("plan entitlements", () => {
  it("gates paid features by plan and reports missing infrastructure honestly", async () => {
    const { host, user, code } = await hostWithMeeting();
    expect((await host.call(recording.POST, { params: { code }, body: { action: "start" } })).status).toBe(402);
    expect((await host.call(summarize.POST, { params: { code }, body: {} })).status).toBe(402);
    expect((await host.call(dialin.POST, { params: { code }, body: { enabled: true } })).status).toBe(402);
    expect((await host.call(accountWebhooks.POST, { body: { url: "https://example.com/hook", events: ["meeting.started"] } })).status).toBe(402);

    await setPlan(user.id, "business");
    // Paid, but this server has no storage / AI key / SIP trunk configured.
    expect((await host.call(recording.POST, { params: { code }, body: { action: "start" } })).body.error.code).toBe("storage_not_configured");
    expect((await host.call(summarize.POST, { params: { code }, body: {} })).body.error.code).toBe("ai_not_configured");
    expect((await host.call(dialin.POST, { params: { code }, body: { enabled: true } })).body.error.code).toBe("telephony_not_configured");
  });

  it("applies the monthly fair-use cap only to new connections, never to a running meeting", async () => {
    const { host, user, code, meetingId } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    await pool().query("INSERT INTO usage_events (host_user_id, kind, quantity) VALUES ($1, 'participant_minutes', 999999)", [user.id]);
    expect((await host.call(token.POST, { params: { code }, body: {} })).status).toBe(402);
    // Someone is already connected: the meeting keeps working.
    await pool().query("INSERT INTO participant_sessions (meeting_id, room, identity) VALUES ($1, $2, 'jr:x')", [meetingId, meetingId]);
    expect((await host.call(token.POST, { params: { code }, body: {} })).status).toBe(200);
  });
});

describe("AI notes", () => {
  it("stores host notes for moderators only", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const { b } = await joinAs(code, "P");
    expect((await host.call(notes.PUT, { method: "PUT", params: { code }, body: { hostNotes: "Agreed: ship Friday" } })).status).toBe(200);
    expect((await b.call(notes.PUT, { method: "PUT", params: { code }, body: { hostNotes: "x" } })).status).toBe(404);
    expect((await b.call(notes.GET, { params: { code } })).status).toBe(403);
  });
});

describe("outgoing webhooks", () => {
  let server: Server;
  const received: Array<{ headers: Record<string, string>; body: string }> = [];
  let url = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers as Record<string, string>, body });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("delivers signed events to the host's endpoint", async () => {
    const { host, user, code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    await setPlan(user.id, "pro");
    const ep = await host.call(accountWebhooks.POST, { body: { url, events: ["participant.admitted", "meeting.ended"] } });
    expect(ep.status).toBe(201);
    await joinAs(code, "Webhook Wanda");
    await host.call(end.POST, { params: { code }, body: {} });
    await deliverDue();
    await new Promise((r) => setTimeout(r, 200));
    await deliverDue();
    const events = received.map((r) => JSON.parse(r.body).event);
    expect(events).toEqual(expect.arrayContaining(["participant.admitted", "meeting.ended"]));
    const r0 = received[0];
    const [, t, v1] = r0.headers["x-meetsphere-signature"].match(/t=(\d+),v1=([0-9a-f]+)/)!;
    expect(v1).toBe(signPayload(ep.body.secret, Number(t), r0.body));
  });

  it("refuses private-network URLs when not in dev mode", async () => {
    process.env.ALLOW_PRIVATE_OUTBOUND = "false";
    try {
      const { host, user } = await hostWithMeeting();
      await setPlan(user.id, "pro");
      const r = await host.call(accountWebhooks.POST, { body: { url: "http://169.254.169.254/latest", events: ["meeting.ended"] } });
      expect(r.status).toBe(400);
    } finally {
      process.env.ALLOW_PRIVATE_OUTBOUND = "true";
    }
  });
});

describe("Stripe billing", () => {
  const secret = "whsec_test_123";
  const sign = (payload: string, t = Math.floor(Date.now() / 1000)) =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
  const post = async (event: unknown, sig?: string) => {
    const payload = JSON.stringify(event);
    const res = await stripeWebhook.POST(
      new Request("http://localhost:3000/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": sig ?? sign(payload) } }),
      { params: Promise.resolve({}) },
    );
    return res.status;
  };

  it("verifies signatures with replay protection", () => {
    const p = '{"a":1}';
    expect(verifyStripeSignature(p, sign(p), secret)).toBe(true);
    expect(verifyStripeSignature(p, sign(p).replace(/v1=./, "v1=0"), secret)).toBe(false);
    expect(verifyStripeSignature(p, sign(p, Math.floor(Date.now() / 1000) - 3600), secret)).toBe(false);
  });

  it("upgrades and downgrades plans from webhook events, idempotently", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    process.env.STRIPE_PRICE_PRO = "price_pro";
    try {
      const { user } = await hostWithMeeting();
      const acct = (await pool().query("INSERT INTO billing_accounts (user_id) VALUES ($1) RETURNING id", [user.id])).rows[0].id;
      expect(await post({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } }, "t=1,v1=bad")).toBe(403);
      const done = { id: "evt_2", type: "checkout.session.completed", data: { object: { client_reference_id: acct, customer: "cus_1", subscription: "sub_1", metadata: { plan: "pro" } } } };
      expect(await post(done)).toBe(200);
      expect(await post(done)).toBe(200); // replay is a no-op
      let row = (await pool().query("SELECT plan_id, status FROM billing_accounts WHERE id = $1", [acct])).rows[0];
      expect(row).toEqual({ plan_id: "pro", status: "active" });

      await post({ id: "evt_3", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "past_due", metadata: { billing_account_id: acct }, items: { data: [{ price: { id: "price_pro" } }] }, current_period_end: 1900000000 } } });
      row = (await pool().query("SELECT plan_id, status FROM billing_accounts WHERE id = $1", [acct])).rows[0];
      expect(row).toEqual({ plan_id: "pro", status: "past_due" });

      await post({ id: "evt_4", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { billing_account_id: acct } } } });
      row = (await pool().query("SELECT plan_id, status FROM billing_accounts WHERE id = $1", [acct])).rows[0];
      expect(row).toEqual({ plan_id: "free", status: "canceled" });
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.STRIPE_PRICE_PRO;
    }
  });
});

describe("organizations and SSO", () => {
  let server: Server;
  let issuer = "";
  let privateKey: CryptoKey;
  const codes = new Map<string, { nonce: string; email: string; challenge: string }>();

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    privateKey = kp.privateKey as CryptoKey;
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    server = createServer(async (req, res) => {
      const u = new URL(req.url!, issuer);
      if (u.pathname === "/.well-known/openid-configuration") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
      }
      if (u.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
      if (u.pathname === "/token") {
        let body = "";
        for await (const c of req) body += c;
        const p = new URLSearchParams(body);
        const entry = codes.get(p.get("code")!);
        const { createHash } = await import("node:crypto");
        if (!entry || p.get("client_secret") !== "s3cret" || createHash("sha256").update(p.get("code_verifier")!).digest("base64url") !== entry.challenge) {
          res.statusCode = 400;
          return res.end("{}");
        }
        const idToken = await new SignJWT({ email: entry.email, email_verified: true, name: "Sso User", nonce: entry.nonce })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(issuer)
          .setAudience("client-1")
          .setSubject(`sub-${entry.email}`)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ id_token: idToken, access_token: "x" }));
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("runs the full OIDC flow, joins the org, and enforces SSO for the domain", async () => {
    const owner = new Browser();
    const me = await signIn(owner, "Olga Owner");
    const created = await owner.call(orgs.POST, { body: { name: "Acme Corp", slug: "acme" } });
    expect(created.status).toBe(201);
    // SSO requires Enterprise.
    const cfg = { issuer, clientId: "client-1", clientSecret: "s3cret", emailDomains: ["acme.test"], enabled: true };
    expect((await owner.call(orgSso.PUT, { method: "PUT", params: { slug: "acme" }, body: cfg })).status).toBe(402);
    await pool().query("UPDATE billing_accounts SET plan_id = 'enterprise' WHERE org_id = $1", [created.body.org.id]);
    expect((await owner.call(orgSso.PUT, { method: "PUT", params: { slug: "acme" }, body: cfg })).status).toBe(200);
    // The secret is never returned.
    expect(JSON.stringify((await owner.call(orgSso.GET, { params: { slug: "acme" } })).body)).not.toContain("s3cret");

    const emp = new Browser();
    const start = await ssoStart.GET(new Request("http://localhost:3000/api/auth/sso/start?org=acme&next=/dashboard"), { params: Promise.resolve({}) });
    expect(start.status).toBe(302);
    // Re-run start with a cookie jar so the state is bound to this browser.
    const startReq = await emp.call(ssoStart.GET, {});
    void startReq;
    const res = await ssoStart.GET(
      new Request("http://localhost:3000/api/auth/sso/start?org=acme&next=/dashboard", { headers: { cookie: "" } }),
      { params: Promise.resolve({}) },
    );
    const cookie = res.headers.getSetCookie()[0].split(";")[0];
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(issuer);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    codes.set("authcode", { nonce: loc.searchParams.get("nonce")!, email: "eve@acme.test", challenge: loc.searchParams.get("code_challenge")! });

    // A different browser can't complete someone else's flow.
    const stolen = await ssoCallback.GET(new Request(`http://localhost:3000/x?state=${loc.searchParams.get("state")}&code=authcode`, { headers: { cookie: "ms_session=nope" } }), { params: Promise.resolve({}) });
    expect(stolen.headers.get("location")).toContain("sso_error");

    const cb = await ssoCallback.GET(
      new Request(`http://localhost:3000/x?state=${loc.searchParams.get("state")}&code=authcode`, { headers: { cookie } }),
      { params: Promise.resolve({}) },
    );
    expect(cb.headers.get("location")).toBe("http://localhost:3000/dashboard");
    const signedIn = new Browser();
    signedIn.cookies.set("ms_session", cb.headers.getSetCookie()[0].split(";")[0].split("=")[1]);
    const orgView = await signedIn.call(org.GET, { params: { slug: "acme" } });
    expect(orgView.body.role).toBe("member");

    // State is single-use.
    const replay = await ssoCallback.GET(new Request(`http://localhost:3000/x?state=${loc.searchParams.get("state")}&code=authcode`, { headers: { cookie } }), { params: Promise.resolve({}) });
    expect(replay.headers.get("location")).toContain("sso_error");

    // With SSO enforced, email codes are refused for the org's domain.
    await owner.call(org.PATCH, { method: "PATCH", params: { slug: "acme" }, body: { ssoEnforced: true } });
    const otp = await new Browser().call(authStart.POST, { body: { channel: "email", destination: "frank@acme.test" } });
    expect(otp.status).toBe(403);
    expect(otp.body.error.code).toBe("sso_required");
    void me;
  });

  it("adds members by email and claims pending invites on sign-in", async () => {
    const owner = new Browser();
    await signIn(owner, "Owner");
    await owner.call(orgs.POST, { body: { name: "Beta Org", slug: "beta-org" } });
    const email = uniqueEmail();
    const add = await owner.call(orgMembers.POST, { params: { slug: "beta-org" }, body: { email, role: "admin" } });
    expect(add.body).toEqual({ added: false, pending: true });
    const newbie = new Browser();
    await signIn(newbie, "Newbie", email);
    expect((await newbie.call(org.GET, { params: { slug: "beta-org" } })).body.role).toBe("admin");
    // Non-members get 404.
    const stranger = new Browser();
    await signIn(stranger, "Stranger");
    expect((await stranger.call(org.GET, { params: { slug: "beta-org" } })).status).toBe(404);
  });
});

describe("phone callers (SIP)", () => {
  it("admits PIN callers only when dial-in is on, and honors lock and block", async () => {
    const { code } = await hostWithMeeting();
    let m = (await getMeetingByCode(code))!;
    expect((await admitSipCaller(m, "sip_+15550001", "+15550001")).allowed).toBe(false);
    await pool().query("UPDATE meetings SET dialin_enabled = true, dialin_pin = '12345678' WHERE id = $1", [m.id]);
    m = (await getMeetingByCode(code))!;
    expect((await admitSipCaller(m, "sip_+15550001", "+15550001")).allowed).toBe(true);
    const jr = (await pool().query("SELECT submitted_name, identity_method, verification_state FROM join_requests WHERE sip_identity = 'sip_+15550001'")).rows[0];
    expect(jr).toMatchObject({ identity_method: "dialin", verification_state: "unverified" });
    expect(jr.submitted_name).not.toContain("5550001"); // number masked for other participants
    await pool().query("UPDATE meetings SET locked_at = now() WHERE id = $1", [m.id]);
    m = (await getMeetingByCode(code))!;
    expect((await admitSipCaller(m, "sip_+15550002", null)).allowed).toBe(false);
    expect((await admitSipCaller(m, "sip_+15550001", null)).allowed).toBe(true); // already admitted, may reconnect
  });
});

describe("operations", () => {
  it("restricts the platform admin console and runs retention cleanup", async () => {
    const { host, user, code, meetingId } = await hostWithMeeting({ accessPolicy: "anyone_with_link", retentionDays: 1 });
    expect((await host.call(admin.GET, {})).status).toBe(403);
    await pool().query("UPDATE users SET platform_admin = true WHERE id = $1", [user.id]);
    expect((await host.call(admin.GET, {})).body.totals.meetings).toBe(1);

    await joinAs(code, "Private Person");
    await pool().query("UPDATE meetings SET status = 'ended', ended_at = now() - interval '3 days' WHERE id = $1", [meetingId]);
    process.env.CRON_SECRET = "cron-secret";
    const call = (auth: string) =>
      cron.POST(new Request("http://localhost:3000/api/cron/cleanup", { method: "POST", headers: { authorization: auth } }), { params: Promise.resolve({}) });
    expect((await call("Bearer wrong")).status).toBe(403);
    const ok = await call("Bearer cron-secret");
    expect((await ok.json()).cleanup.meetingsScrubbed).toBe(1);
    const names = (await pool().query("SELECT submitted_name FROM join_requests WHERE meeting_id = $1", [meetingId])).rows;
    expect(names.every((r) => r.submitted_name === "Removed (retention)")).toBe(true);
  });
});
