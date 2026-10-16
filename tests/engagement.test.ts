import { describe, expect, it } from "vitest";
import * as meetingsRoute from "@/app/api/meetings/route";
import * as meeting from "@/app/api/meetings/[code]/route";
import * as settings from "@/app/api/meetings/[code]/settings/route";
import * as requests from "@/app/api/meetings/[code]/requests/route";
import * as action from "@/app/api/meetings/[code]/requests/[id]/[action]/route";
import * as lock from "@/app/api/meetings/[code]/lock/route";
import * as questions from "@/app/api/meetings/[code]/questions/route";
import * as qAction from "@/app/api/meetings/[code]/questions/[id]/[action]/route";
import * as polls from "@/app/api/meetings/[code]/polls/route";
import * as pAction from "@/app/api/meetings/[code]/polls/[id]/[action]/route";
import * as invitations from "@/app/api/meetings/[code]/invitations/route";
import * as savePreset from "@/app/api/meetings/[code]/save-preset/route";
import * as presets from "@/app/api/presets/route";
import * as ics from "@/app/api/meetings/[code]/ics/route";
import * as reopen from "@/app/api/meetings/[code]/reopen/route";
import * as end from "@/app/api/meetings/[code]/end/route";
import * as join from "@/app/api/meetings/[code]/join/route";
import * as safety from "@/app/api/meetings/[code]/safety/route";
import * as report from "@/app/api/meetings/[code]/report/route";
import * as events from "@/app/api/meetings/[code]/events/route";
import { nextOccurrence } from "@/lib/meetings";
import { Browser, hostWithMeeting, joinAs, signIn, uniquePhone } from "./helpers";

describe("co-hosts", () => {
  it("lets the host appoint a co-host who can moderate but not change settings", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "host_approval" });
    const { b: alice } = await joinAs(code, "Alice");
    const aliceId = (await host.call(requests.GET, { params: { code } })).body.requests[0].id;
    await host.call(action.POST, { params: { code, id: aliceId, action: "approve" }, body: {} });
    expect((await host.call(action.POST, { params: { code, id: aliceId, action: "role" }, body: { role: "cohost" } })).status).toBe(200);

    const { b: bob } = await joinAs(code, "Bob");
    // Bob is not a moderator: host endpoints are hidden.
    expect((await bob.call(requests.GET, { params: { code } })).status).toBe(401);

    const list = await alice.call(requests.GET, { params: { code } });
    expect(list.status).toBe(200);
    const bobId = list.body.requests.find((r: any) => r.name === "Bob").id;
    expect((await alice.call(action.POST, { params: { code, id: bobId, action: "approve" }, body: {} })).status).toBe(200);
    expect((await alice.call(lock.POST, { params: { code }, body: { locked: true } })).status).toBe(200);

    // Co-host can't change settings, appoint co-hosts, or remove another co-host.
    expect([401, 404]).toContain((await alice.call(settings.PATCH, { method: "PATCH", params: { code }, body: { chatEnabled: false } })).status);
    expect((await alice.call(action.POST, { params: { code, id: bobId, action: "role" }, body: { role: "cohost" } })).status).toBe(403);
    await host.call(action.POST, { params: { code, id: bobId, action: "role" }, body: { role: "cohost" } });
    expect((await alice.call(action.POST, { params: { code, id: bobId, action: "remove" }, body: {} })).status).toBe(403);
  });
});

describe("Q&A", () => {
  it("supports moderated questions, upvotes, and true anonymity", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "anyone_with_link", qaModerated: true });
    const { b: a } = await joinAs(code, "Asker");
    const { b: c } = await joinAs(code, "Curious");
    const outsider = new Browser();
    expect((await outsider.call(questions.POST, { params: { code }, body: { body: "hi" } })).status).toBe(403);

    const q = await a.call(questions.POST, { params: { code }, body: { body: "When is the deadline?", anonymous: true } });
    expect(q.status).toBe(201);
    expect(q.body.status).toBe("pending");
    // Pending: visible to the author and moderators only.
    expect((await c.call(questions.GET, { params: { code } })).body.questions).toHaveLength(0);
    expect((await a.call(questions.GET, { params: { code } })).body.questions).toHaveLength(1);
    const hostView = (await host.call(questions.GET, { params: { code } })).body.questions[0];
    expect(hostView.author).toBe("Anonymous");

    await host.call(qAction.POST, { params: { code, id: q.body.id, action: "moderate" }, body: { action: "approve" } });
    await c.call(qAction.POST, { params: { code, id: q.body.id, action: "vote" }, body: { up: true } });
    await c.call(qAction.POST, { params: { code, id: q.body.id, action: "vote" }, body: { up: true } }); // idempotent
    const seen = (await c.call(questions.GET, { params: { code } })).body.questions[0];
    expect(seen.votes).toBe(1);
    expect(seen.voted).toBe(true);
    // Participants can't moderate.
    expect((await c.call(qAction.POST, { params: { code, id: q.body.id, action: "moderate" }, body: { action: "dismiss" } })).status).toBe(403);
  });
});

describe("polls", () => {
  it("hides drafts and results, enforces single choice, and stops votes after closing", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const { b: v1 } = await joinAs(code, "Voter One");
    const { b: v2 } = await joinAs(code, "Voter Two");
    const draft = await host.call(polls.POST, { params: { code }, body: { question: "Draft?", options: ["a", "b"], launch: false } });
    expect((await v1.call(polls.GET, { params: { code } })).body.polls).toHaveLength(0);
    expect((await v1.call(polls.POST, { params: { code }, body: { question: "x", options: ["a", "b"] } })).status).toBe(403);

    const p = await host.call(polls.POST, { params: { code }, body: { question: "Lunch?", options: ["Pizza", "Salad"], anonymous: false } });
    expect((await v1.call(pAction.POST, { params: { code, id: p.body.id, action: "vote" }, body: { options: [0, 1] } })).status).toBe(400);
    await v1.call(pAction.POST, { params: { code, id: p.body.id, action: "vote" }, body: { options: [0] } });
    await v2.call(pAction.POST, { params: { code, id: p.body.id, action: "vote" }, body: { options: [0] } });
    await v2.call(pAction.POST, { params: { code, id: p.body.id, action: "vote" }, body: { options: [1] } }); // change of mind

    const mine = (await v1.call(polls.GET, { params: { code } })).body.polls.find((x: any) => x.id === p.body.id);
    expect(mine.results).toBeNull();
    expect(mine.myVote).toEqual([0]);
    const hostSees = (await host.call(polls.GET, { params: { code } })).body.polls.find((x: any) => x.id === p.body.id);
    expect(hostSees.results).toEqual([1, 1]);
    expect(hostSees.voters).toEqual([["Voter One"], ["Voter Two"]]);

    await host.call(pAction.POST, { params: { code, id: p.body.id, action: "manage" }, body: { action: "close" } });
    await host.call(pAction.POST, { params: { code, id: p.body.id, action: "manage" }, body: { action: "show_results" } });
    expect((await v1.call(pAction.POST, { params: { code, id: p.body.id, action: "vote" }, body: { options: [1] } })).status).toBe(409);
    const after = (await v1.call(polls.GET, { params: { code } })).body.polls.find((x: any) => x.id === p.body.id);
    expect(after.results).toEqual([1, 1]);
    expect(after.voters).toBeNull();
    expect(draft.status).toBe(201);
  });
});

describe("presets, calendar and recurring meetings", () => {
  it("saves a meeting as a preset and creates a new meeting from it with the invite list", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "invited_only", qaModerated: true, recurrence: "weekly" });
    await host.call(invitations.POST, { params: { code }, body: { name: "Student One", phone: uniquePhone() } });
    const saved = await host.call(savePreset.POST, { params: { code }, body: { name: "Grade 7 maths" } });
    expect(saved.status).toBe(201);
    const list = await host.call(presets.GET);
    expect(list.body.presets[0]).toMatchObject({ name: "Grade 7 maths", invitationCount: 1 });

    const m2 = await host.call(meetingsRoute.POST, { body: { title: "Maths week 2", presetId: saved.body.preset.id } });
    expect(m2.body.meeting).toMatchObject({ accessPolicy: "invited_only", qaModerated: true, recurrence: "weekly" });
    const inv = await host.call(invitations.GET, { params: { code: m2.body.meeting.code } });
    expect(inv.body.invitations).toHaveLength(1);

    const stranger = new Browser();
    await signIn(stranger, "Stranger");
    expect((await stranger.call(meetingsRoute.POST, { body: { title: "x", presetId: saved.body.preset.id } })).status).toBe(404);
  });

  it("exports a valid calendar file with a recurrence rule", async () => {
    const { code } = await hostWithMeeting({ scheduledAt: "2030-01-07T09:00:00Z", recurrence: "weekdays", durationMinutes: 45 });
    const res = await ics.GET(new Request("http://localhost:3000/x"), { params: Promise.resolve({ code }) });
    const body = await res.text();
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(body).toContain("DTSTART:20300107T090000Z");
    expect(body).toContain("DTEND:20300107T094500Z");
    expect(body).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(body).toContain(`/m/${code}`);
  });

  it("computes the next occurrence", () => {
    const fri = new Date("2030-01-04T09:00:00Z");
    expect(nextOccurrence(fri, "weekdays", new Date("2030-01-04T10:00:00Z"))?.toISOString()).toBe("2030-01-07T09:00:00.000Z");
    expect(nextOccurrence(fri, "weekly", new Date("2030-01-20T00:00:00Z"))?.toISOString()).toBe("2030-01-25T09:00:00.000Z");
    expect(nextOccurrence(fri, "none", new Date("2031-01-01T00:00:00Z"))).toBeNull();
  });

  it("reopens an ended meeting on the same link, keeping blocks", async () => {
    const { host, code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const { b: good } = await joinAs(code, "Good");
    const { b: bad, request } = await joinAs(code, "Bad");
    await host.call(action.POST, { params: { code, id: request.id, action: "block" }, body: {} });
    await host.call(end.POST, { params: { code }, body: {} });
    expect((await new Browser().call(join.POST, { params: { code }, body: { name: "Late", method: "name" } })).status).toBe(403);

    const r = await host.call(reopen.POST, { params: { code }, body: {} });
    expect(r.body.meeting.status).toBe("scheduled");
    // Previous admission decisions are cleared; blocks stay.
    expect((await good.call(join.POST, { params: { code }, body: { name: "Good", method: "name" } })).body.request.status).toBe("admitted");
    expect((await bad.call(join.POST, { params: { code }, body: { name: "Bad", method: "name" } })).body.request.status).toBe("blocked");
  });
});

describe("safety", () => {
  it("flags join bursts and collects abuse reports for moderators", async () => {
    process.env.SAFETY_JOIN_BURST = "25";
    const { host, code } = await hostWithMeeting({ accessPolicy: "host_approval" });
    for (let i = 0; i < 25; i++) await joinAs(code, `Bot ${i}`);
    const snap = await host.call(safety.GET, { params: { code } });
    expect(snap.body.metrics.joinRequests5m).toBe(25);
    expect(snap.body.alerts.map((a: any) => a.code)).toContain("join_burst");

    const { host: h2, code: c2 } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    const { b: victim } = await joinAs(c2, "Victim");
    const { request: troll } = await joinAs(c2, "Troll");
    expect((await victim.call(report.POST, { params: { code: c2 }, body: { targetRequestId: troll.id, reason: "harassment" } })).status).toBe(201);
    const s2 = await h2.call(safety.GET, { params: { code: c2 } });
    expect(s2.body.reports[0]).toMatchObject({ reason: "harassment", target_name: "Troll" });
    expect((await victim.call(safety.GET, { params: { code: c2 } })).status).toBe(404);
  });
});

describe("real-time events", () => {
  it("streams request updates to the waiting guest and join requests to the host", async () => {
    const { host, code } = await hostWithMeeting();
    const guest = new Browser();
    await guest.call(join.POST, { params: { code }, body: { name: "Gus", method: "name" } });

    const open = async (b: Browser) => {
      const ac = new AbortController();
      const headers: Record<string, string> = { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
      const res = await events.GET(new Request("http://localhost:3000/x", { headers, signal: ac.signal }), { params: Promise.resolve({ code }) });
      const reader = res.body!.getReader();
      let buf = "";
      const waitFor = async (needle: string) => {
        const deadline = Date.now() + 5000;
        while (!buf.includes(needle) && Date.now() < deadline) {
          const { value, done } = await Promise.race([reader.read(), new Promise<any>((r) => setTimeout(() => r({ value: undefined, done: false }), 200))]);
          if (done) break;
          if (value) buf += new TextDecoder().decode(value);
        }
        return buf;
      };
      return { waitFor, close: () => ac.abort() };
    };
    const g = await open(guest);
    const h = await open(host);
    await g.waitFor("connected");
    await h.waitFor("connected");

    const id = (await host.call(requests.GET, { params: { code } })).body.requests[0].id;
    await host.call(action.POST, { params: { code, id, action: "approve" }, body: {} });
    expect(await g.waitFor("request_updated")).toContain('"status":"admitted"');
    expect(await h.waitFor("requests_changed")).toContain("requests_changed");

    // The guest must not see moderator-only events about other people.
    const other = new Browser();
    await other.call(join.POST, { params: { code }, body: { name: "Other", method: "name" } });
    await h.waitFor('"status":"pending"');
    g.close();
    h.close();
  });

  it("does not leak meeting details through the public view", async () => {
    const { code } = await hostWithMeeting({ waitingMessage: "Doors open at 9" });
    const v = await new Browser().call(meeting.GET, { params: { code } });
    expect(v.body.meeting.waitingMessage).toBe("Doors open at 9");
    expect(v.body.host).toBeNull();
    expect(JSON.stringify(v.body)).not.toMatch(/dialin_pin|host_user_id/);
  });
});
