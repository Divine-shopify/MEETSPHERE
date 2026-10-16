import { describe, expect, it } from "vitest";
import * as authStart from "@/app/api/auth/start/route";
import * as authVerify from "@/app/api/auth/verify/route";
import * as meetings from "@/app/api/meetings/route";
import * as meeting from "@/app/api/meetings/[code]/route";
import * as settings from "@/app/api/meetings/[code]/settings/route";
import * as lock from "@/app/api/meetings/[code]/lock/route";
import * as verifyStart from "@/app/api/meetings/[code]/verify/start/route";
import * as verifyCheck from "@/app/api/meetings/[code]/verify/check/route";
import * as join from "@/app/api/meetings/[code]/join/route";
import * as token from "@/app/api/meetings/[code]/token/route";
import * as requests from "@/app/api/meetings/[code]/requests/route";
import * as action from "@/app/api/meetings/[code]/requests/[id]/[action]/route";
import * as invitations from "@/app/api/meetings/[code]/invitations/route";
import * as importCsv from "@/app/api/meetings/[code]/invitations/import/route";
import * as auditRoute from "@/app/api/meetings/[code]/audit/route";
import { pool } from "@/lib/db";
import { Browser, decodeJwt, uniqueEmail, uniquePhone } from "./helpers";

async function signIn(b: Browser, name = "Hana Host") {
  const email = uniqueEmail();
  const start = await b.call(authStart.POST, { body: { channel: "email", destination: email } });
  expect(start.status).toBe(200);
  expect(start.body.delivery).toBe("dev");
  const v = await b.call(authVerify.POST, { body: { challengeId: start.body.challengeId, code: start.body.devCode, displayName: name } });
  expect(v.status).toBe(200);
  return v.body.user;
}

async function hostWithMeeting(overrides: Record<string, unknown> = {}) {
  const host = new Browser();
  await signIn(host);
  const res = await host.call(meetings.POST, { body: { title: "Team sync", ...overrides } });
  expect(res.status).toBe(201);
  return { host, code: res.body.meeting.code as string };
}

async function verifyContact(b: Browser, code: string, channel: "phone" | "email", destination: string) {
  const s = await b.call(verifyStart.POST, { params: { code }, body: { channel, destination } });
  expect(s.status).toBe(200);
  const c = await b.call(verifyCheck.POST, { params: { code }, body: { challengeId: s.body.challengeId, code: s.body.devCode } });
  expect(c.status).toBe(200);
}

describe("meeting creation and authorization boundaries", () => {
  it("requires sign-in to create a meeting", async () => {
    const anon = new Browser();
    expect((await anon.call(meetings.POST, { body: { title: "x" } })).status).toBe(401);
  });

  it("lets a host create a meeting with a shareable code", async () => {
    const { code } = await hostWithMeeting();
    expect(code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    const pub = await new Browser().call(meeting.GET, { params: { code } });
    expect(pub.status).toBe(200);
    expect(pub.body.meeting.title).toBe("Team sync");
    expect(pub.body.host).toBeNull();
  });

  it("hides every host endpoint from other signed-in users and guests", async () => {
    const { code } = await hostWithMeeting();
    const other = new Browser();
    await signIn(other, "Mallory");
    const guest = new Browser();
    const fakeId = "00000000-0000-0000-0000-000000000000";
    for (const b of [other, guest]) {
      const expected = b === other ? 404 : 401;
      expect((await b.call(requests.GET, { params: { code } })).status).toBe(expected);
      expect((await b.call(settings.PATCH, { method: "PATCH", params: { code }, body: { accessPolicy: "anyone_with_link" } })).status).toBe(expected);
      expect((await b.call(lock.POST, { params: { code }, body: { locked: false } })).status).toBe(expected);
      expect((await b.call(invitations.GET, { params: { code } })).status).toBe(expected);
      expect((await b.call(auditRoute.GET, { params: { code } })).status).toBe(expected);
      expect((await b.call(action.POST, { params: { code, id: fakeId, action: "approve" }, body: {} })).status).toBe(expected);
    }
  });

  it("blocks cross-site POSTs (CSRF)", async () => {
    const host = new Browser();
    await signIn(host);
    const res = await host.call(meetings.POST, { body: { title: "x" }, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("name-only requests and host approval", () => {
  it("puts a name-only guest in the waiting room with no media token until approved", async () => {
    const { host, code } = await hostWithMeeting();
    const guest = new Browser();
    const r = await guest.call(join.POST, { params: { code }, body: { name: "Gus Guest", method: "name" } });
    expect(r.status).toBe(200);
    expect(r.body.request.status).toBe("pending");
    expect(r.body.request.verified).toBe(false);
    expect(r.body.request.badges).toEqual(["name_entered"]);

    expect((await guest.call(token.POST, { params: { code }, body: {} })).status).toBe(403);

    const list = await host.call(requests.GET, { params: { code } });
    const id = list.body.requests[0].id;
    expect((await host.call(action.POST, { params: { code, id, action: "approve" }, body: {} })).status).toBe(200);

    const t = await guest.call(token.POST, { params: { code }, body: {} });
    expect(t.status).toBe(200);
    const claims = decodeJwt(t.body.token);
    expect(claims.sub).toBe(`jr:${id}`);
    expect(claims.video.roomJoin).toBe(true);
    expect(claims.video.roomAdmin).toBe(false);
    expect(claims.video.canUpdateOwnMetadata).toBe(false);
  });

  it("keeps a rejection sticky for the same session", async () => {
    const { host, code } = await hostWithMeeting();
    const guest = new Browser();
    await guest.call(join.POST, { params: { code }, body: { name: "Gus", method: "name" } });
    const id = (await host.call(requests.GET, { params: { code } })).body.requests[0].id;
    expect((await host.call(action.POST, { params: { code, id, action: "reject" }, body: {} })).status).toBe(200);

    const again = await guest.call(join.POST, { params: { code }, body: { name: "Gus Again", method: "name" } });
    expect(again.body.request.status).toBe("rejected");
    expect((await guest.call(token.POST, { params: { code }, body: {} })).status).toBe(403);
  });

  it("refuses name-only requests when the host disabled them", async () => {
    const { code } = await hostWithMeeting({ allowNameOnlyRequests: false });
    const r = await new Browser().call(join.POST, { params: { code }, body: { name: "Gus", method: "name" } });
    expect(r.status).toBe(403);
  });

  it("refuses a phone method claim without a verified phone", async () => {
    const { code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const r = await new Browser().call(join.POST, { params: { code }, body: { name: "Gus", method: "phone" } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("verification_required");
  });

  it("never lets a host token be minted for a guest", async () => {
    const { code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const guest = new Browser();
    await guest.call(join.POST, { params: { code }, body: { name: "Hana Host", method: "name" } });
    const t = await guest.call(token.POST, { params: { code }, body: {} });
    expect(t.status).toBe(200);
    expect(t.body.role).toBe("participant");
    expect(decodeJwt(t.body.token).video.roomAdmin).toBe(false);
  });
});

describe("verification and the expected-attendee list", () => {
  it("auto-admits a verified invitee and keeps a same-name stranger as a weak match", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "invited_only" });
    const phone = uniquePhone();
    const add = await host.call(invitations.POST, { params: { code }, body: { name: "Ivy Invitee", phone } });
    expect(add.status).toBe(201);

    const ivy = new Browser();
    await verifyContact(ivy, code, "phone", phone);
    const r = await ivy.call(join.POST, { params: { code }, body: { name: "Ivy", method: "phone" } });
    expect(r.body.request.status).toBe("admitted");
    expect(r.body.request.badges).toEqual(["contact_verified", "invited"]);

    const impostor = new Browser();
    const i = await impostor.call(join.POST, { params: { code }, body: { name: "ivy  INVITEE", method: "name" } });
    expect(i.body.request.status).toBe("pending");
    expect(i.body.request.badges).toEqual(["name_entered"]);
    const hostList = (await host.call(requests.GET, { params: { code } })).body.requests;
    expect(hostList.find((x: any) => x.name === "ivy  INVITEE").matchState).toBe("weak_name_match");
  });

  it("does not expose invitee contact details to attendees", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "invited_only" });
    const email = uniqueEmail();
    await host.call(invitations.POST, { params: { code }, body: { name: "Secret Sam", email } });
    const guest = new Browser();
    await verifyContact(guest, code, "email", uniqueEmail());
    const snapshots = [
      await guest.call(meeting.GET, { params: { code } }),
      await guest.call(join.POST, { params: { code }, body: { name: "Gus", method: "email" } }),
      await guest.call(join.GET, { params: { code } }),
    ];
    for (const s of snapshots) {
      expect(JSON.stringify(s.body)).not.toContain(email);
      expect(JSON.stringify(s.body)).not.toContain("Secret Sam");
    }
    // The host sees verified contacts masked in the waiting room.
    const hostList = (await host.call(requests.GET, { params: { code } })).body.requests;
    expect(hostList[0].maskedContact).toMatch(/•/);
  });

  it("stores only hashed OTP codes, limits attempts and rate-limits sends", async () => {
    const { code } = await hostWithMeeting();
    const b = new Browser();
    const phone = uniquePhone();
    const s = await b.call(verifyStart.POST, { params: { code }, body: { channel: "phone", destination: phone } });
    const { rows } = await pool().query("SELECT code_hash FROM verification_challenges WHERE id = $1", [s.body.challengeId]);
    expect(rows[0].code_hash.toString()).not.toContain(s.body.devCode);

    const wrong = s.body.devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await b.call(verifyCheck.POST, { params: { code }, body: { challengeId: s.body.challengeId, code: wrong } });
      expect(r.status).toBe(400);
    }
    // Correct code after the attempt cap is still refused.
    const late = await b.call(verifyCheck.POST, { params: { code }, body: { challengeId: s.body.challengeId, code: s.body.devCode } });
    expect(late.status).toBe(400);

    // Immediate resend to the same number hits the cooldown.
    const resend = await b.call(verifyStart.POST, { params: { code }, body: { channel: "phone", destination: phone } });
    expect(resend.status).toBe(429);
  });

  it("binds a challenge to the browser session that requested it", async () => {
    const { code } = await hostWithMeeting();
    const a = new Browser();
    const s = await a.call(verifyStart.POST, { params: { code }, body: { channel: "email", destination: uniqueEmail() } });
    const thief = new Browser();
    await thief.call(join.GET, { params: { code } });
    await thief.call(verifyStart.POST, { params: { code }, body: { channel: "email", destination: uniqueEmail() } });
    const r = await thief.call(verifyCheck.POST, { params: { code }, body: { challengeId: s.body.challengeId, code: s.body.devCode } });
    expect(r.status).toBe(400);
  });

  it("imports a CSV and reports invalid rows", async () => {
    const { host, code } = await hostWithMeeting();
    const csv = `name,phone,email\nAda,${uniquePhone()},\nBob,,${uniqueEmail()}\nBad,123,\n`;
    const r = await host.call(importCsv.POST, { params: { code }, body: { csv } });
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(2);
    expect(r.body.errorCount).toBe(1);
    const list = await host.call(invitations.GET, { params: { code } });
    expect(list.body.invitations).toHaveLength(2);
  });
});

describe("lock, remove and block", () => {
  it("locks out new people but lets admitted people reconnect", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const early = new Browser();
    await early.call(join.POST, { params: { code }, body: { name: "Early", method: "name" } });
    await host.call(lock.POST, { params: { code }, body: { locked: true } });

    const late = await new Browser().call(join.POST, { params: { code }, body: { name: "Late", method: "name" } });
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe("locked");
    expect((await early.call(token.POST, { params: { code }, body: {} })).status).toBe(200);
  });

  it("revokes access on removal and blocks the verified contact across sessions", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "verified_only" });
    const email = uniqueEmail();
    const bad = new Browser();
    await verifyContact(bad, code, "email", email);
    const r = await bad.call(join.POST, { params: { code }, body: { name: "Bad Actor", method: "email" } });
    expect(r.body.request.status).toBe("admitted");
    expect((await bad.call(token.POST, { params: { code }, body: {} })).status).toBe(200);

    await host.call(action.POST, { params: { code, id: r.body.request.id, action: "block" }, body: {} });
    expect((await bad.call(token.POST, { params: { code }, body: {} })).status).toBe(403);

    // Fresh browser, same email (after the resend cooldown): still blocked.
    await pool().query("DELETE FROM rate_limits WHERE key LIKE 'otp:cooldown:%'");
    const again = new Browser();
    await verifyContact(again, code, "email", email);
    const r2 = await again.call(join.POST, { params: { code }, body: { name: "Totally New", method: "email" } });
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe("blocked");
  });

  it("records an audit trail of admission and moderation", async () => {
    const { host, code } = await hostWithMeeting();
    const g = new Browser();
    await g.call(join.POST, { params: { code }, body: { name: "Gus", method: "name" } });
    const id = (await host.call(requests.GET, { params: { code } })).body.requests[0].id;
    await host.call(action.POST, { params: { code, id, action: "approve" }, body: {} });
    await host.call(action.POST, { params: { code, id, action: "remove" }, body: { reason: "test" } });
    await host.call(lock.POST, { params: { code }, body: { locked: true } });
    const events = (await host.call(auditRoute.GET, { params: { code } })).body.events.map((e: any) => e.action);
    expect(events).toEqual(expect.arrayContaining(["meeting_created", "join_requested", "approved", "removed", "meeting_locked"]));
  });
});

describe("media permissions", () => {
  it("issues subscribe-only tokens to broadcast audience and strips screen share when disabled", async () => {
    const { host, code } = await hostWithMeeting({ mode: "broadcast", accessPolicy: "anyone_with_link" });
    const viewer = new Browser();
    await viewer.call(join.POST, { params: { code }, body: { name: "Viewer", method: "name" } });
    const t = decodeJwt((await viewer.call(token.POST, { params: { code }, body: {} })).body.token);
    expect(t.video.canPublish).toBe(false);
    expect(t.video.canSubscribe).toBe(true);

    const { host: h2, code: c2 } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    await h2.call(settings.PATCH, { method: "PATCH", params: { code: c2 }, body: { allowScreenShare: false, chatEnabled: false } });
    const p = new Browser();
    await p.call(join.POST, { params: { code: c2 }, body: { name: "P", method: "name" } });
    const pt = decodeJwt((await p.call(token.POST, { params: { code: c2 }, body: {} })).body.token);
    expect(pt.video.canPublishSources).toEqual(["camera", "microphone"]);
    expect(pt.video.canPublishData).toBe(false);

    const ht = decodeJwt((await host.call(token.POST, { params: { code }, body: {} })).body.token);
    expect(ht.video.roomAdmin).toBe(true);
    expect(ht.video.canPublish).toBe(true);
  });
});
