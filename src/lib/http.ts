import { ZodError, type ZodType } from "zod";
import { config } from "./config";
import { badRequest, forbidden, HttpError, unauthorized } from "./errors";
import {
  clearSessionCookie,
  createSession,
  findSessionByToken,
  getUser,
  SESSION_COOKIE,
  sessionCookie,
  type Session,
  type User,
} from "./session";

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Per-request helper: lazy session loading and cookie bookkeeping. */
export class RequestContext {
  private loaded = false;
  private current: Session | null = null;
  private setCookies: string[] = [];

  constructor(public readonly req: Request) {}

  async session(): Promise<Session | null> {
    if (!this.loaded) {
      const token = parseCookies(this.req.headers.get("cookie"))[SESSION_COOKIE];
      this.current = token ? await findSessionByToken(token) : null;
      this.loaded = true;
    }
    return this.current;
  }

  async ensureSession(): Promise<Session> {
    const existing = await this.session();
    if (existing) return existing;
    const { session, token } = await createSession();
    this.current = session;
    this.setCookies.push(sessionCookie(token));
    return session;
  }

  async requireUser(): Promise<{ session: Session; user: User }> {
    const session = await this.session();
    if (!session?.user_id) throw unauthorized();
    const user = await getUser(session.user_id);
    if (!user) throw unauthorized();
    return { session, user };
  }

  replaceSessionToken(token: string, session: Session) {
    this.current = session;
    this.loaded = true;
    this.setCookies.push(sessionCookie(token));
  }

  clearSession() {
    this.current = null;
    this.loaded = true;
    this.setCookies.push(clearSessionCookie());
  }

  ip(): string {
    // Assumes a trusted reverse proxy sets X-Forwarded-For. See docs/DEPLOYMENT.md.
    const fwd = this.req.headers.get("x-forwarded-for");
    return (fwd?.split(",")[0] ?? this.req.headers.get("x-real-ip") ?? "local").trim();
  }

  async json<T>(schema: ZodType<T>): Promise<T> {
    const ct = this.req.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) throw badRequest("Expected application/json");
    let body: unknown;
    try {
      body = await this.req.json();
    } catch {
      throw badRequest("Invalid JSON body");
    }
    return schema.parse(body);
  }

  apply(res: Response): Response {
    for (const c of this.setCookies) res.headers.append("Set-Cookie", c);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}

/** CSRF defence for cookie-authenticated mutations: reject cross-site origins. */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") throw forbidden("Cross-site request blocked");
  if (!origin) return; // non-browser clients; browsers always send Origin on POST
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(config.baseUrl).origin);
  } catch {}
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
    allowed.add(`${proto}://${host}`);
  }
  if (!allowed.has(origin)) throw forbidden("Cross-site request blocked");
}

type Handler<P> = (ctx: RequestContext, params: P) => Promise<Response | object>;

export function route<P = Record<string, never>>(fn: Handler<P>, opts: { skipOriginCheck?: boolean } = {}) {
  return async (req: Request, segment?: { params: Promise<P> }): Promise<Response> => {
    const ctx = new RequestContext(req);
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !opts.skipOriginCheck) assertSameOrigin(req);
      const params = segment ? await segment.params : ({} as P);
      const out = await fn(ctx, params);
      return ctx.apply(out instanceof Response ? out : Response.json(out));
    } catch (err) {
      return ctx.apply(errorResponse(err));
    }
  };
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return Response.json(
      { error: { code: "invalid_input", message: `${where}${first?.message ?? "Invalid input"}` } },
      { status: 400 },
    );
  }
  console.error("[api] unhandled error", err instanceof Error ? err.message : err);
  return Response.json({ error: { code: "internal", message: "Something went wrong" } }, { status: 500 });
}
