import { randomUUID } from "node:crypto";

type Handler = (req: Request, seg: { params: Promise<any> }) => Promise<Response>;

/** Minimal browser stand-in: keeps cookies and a stable IP between calls. */
export class Browser {
  cookies = new Map<string, string>();
  ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

  async call(
    handler: Handler | undefined,
    opts: { method?: string; params?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any }> {
    if (!handler) throw new Error("handler not exported");
    const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { "x-forwarded-for": this.ip, host: "localhost:3000", ...opts.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const req = new Request("http://localhost:3000/api/test", {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      if (v) this.cookies.set(k, v);
      else this.cookies.delete(k);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

export const uniquePhone = () => `+4479${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
export const uniqueEmail = () => `user-${randomUUID().slice(0, 8)}@example.com`;

export function decodeJwt(token: string): any {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

import * as authStart from "@/app/api/auth/start/route";
import * as authVerify from "@/app/api/auth/verify/route";
import * as meetingsRoute from "@/app/api/meetings/route";
import * as joinRoute from "@/app/api/meetings/[code]/join/route";
import * as verifyStart from "@/app/api/meetings/[code]/verify/start/route";
import * as verifyCheck from "@/app/api/meetings/[code]/verify/check/route";
import { pool } from "@/lib/db";

export async function signIn(b: Browser, name = "Hana Host", email = uniqueEmail()) {
  const start = await b.call(authStart.POST, { body: { channel: "email", destination: email } });
  if (start.status !== 200) throw new Error(`signin start ${start.status} ${JSON.stringify(start.body)}`);
  const v = await b.call(authVerify.POST, { body: { challengeId: start.body.challengeId, code: start.body.devCode, displayName: name } });
  if (v.status !== 200) throw new Error(`signin verify ${v.status}`);
  return { ...v.body.user, email };
}

export async function hostWithMeeting(overrides: Record<string, unknown> = {}) {
  const host = new Browser();
  const user = await signIn(host);
  const res = await host.call(meetingsRoute.POST, { body: { title: "Team sync", ...overrides } });
  if (res.status !== 201) throw new Error(`create meeting ${res.status} ${JSON.stringify(res.body)}`);
  return { host, user, code: res.body.meeting.code as string, meetingId: res.body.meeting.id as string };
}

/** Joins as a name-only guest in an open meeting, or waits if not open. */
export async function joinAs(code: string, name: string, b = new Browser()) {
  const r = await b.call(joinRoute.POST, { params: { code }, body: { name, method: "name" } });
  return { b, request: r.body.request, status: r.status };
}

export async function verifyContact(b: Browser, code: string, channel: "phone" | "email", destination: string) {
  const s = await b.call(verifyStart.POST, { params: { code }, body: { channel, destination } });
  if (s.status !== 200) throw new Error(`verify start ${s.status}`);
  const c = await b.call(verifyCheck.POST, { params: { code }, body: { challengeId: s.body.challengeId, code: s.body.devCode } });
  if (c.status !== 200) throw new Error(`verify check ${c.status}`);
}

export async function setPlan(userId: string, plan: string) {
  await pool().query(
    `INSERT INTO billing_accounts (user_id, plan_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`,
    [userId, plan],
  );
}
