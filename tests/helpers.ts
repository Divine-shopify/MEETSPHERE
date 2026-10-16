import { randomUUID } from "node:crypto";

type Handler = (req: Request, seg?: { params: Promise<Record<string, string>> }) => Promise<Response>;

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
