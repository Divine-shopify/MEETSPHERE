// Organization single sign-on via OpenID Connect (authorization code + PKCE).
// Works with Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak, etc.
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { config } from "./config";
import { normalizeEmail } from "./contact";
import { randomToken } from "./crypto";
import { one, pool, tx } from "./db";
import { badRequest, forbidden, HttpError, notFound } from "./errors";
import { assertPublicUrl } from "./netguard";
import { claimMemberships, type Org } from "./orgs";
import { planForOwner } from "./plans";
import { open, seal } from "./secretbox";
import { rotateSessionToken, type Session } from "./session";

export const ssoConfigSchema = z.object({
  issuer: z.string().url().max(500),
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().trim().min(1).max(500).optional(),
  emailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(20),
  enabled: z.boolean(),
});

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();

export async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.doc;
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  await assertPublicUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!res.ok) throw badRequest(`Couldn't load the identity provider's configuration (${res.status}).`, "sso_discovery_failed");
  const doc = (await res.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw badRequest("The identity provider's configuration is incomplete.");
  if (doc.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) throw badRequest("The identity provider's issuer doesn't match.");
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(uri: string) {
  let s = jwksCache.get(uri);
  if (!s) jwksCache.set(uri, (s = createRemoteJWKSet(new URL(uri))));
  return s;
}

interface SsoConfigRow {
  org_id: string;
  issuer: string;
  client_id: string;
  client_secret_enc: string;
  email_domains: string[];
  enabled: boolean;
}

export async function getSsoConfig(orgId: string) {
  const r = await one<SsoConfigRow>("SELECT * FROM sso_configs WHERE org_id = $1", [orgId]);
  return r ? { issuer: r.issuer, clientId: r.client_id, emailDomains: r.email_domains, enabled: r.enabled, hasSecret: true } : null;
}

export async function saveSsoConfig(org: Org, input: z.infer<typeof ssoConfigSchema>) {
  if (!(await planForOwner({ orgId: org.id })).sso) throw new HttpError(402, "plan_required", "Single sign-on is available on the Enterprise plan.");
  await discover(input.issuer); // fail fast on a bad issuer
  const existing = await one<SsoConfigRow>("SELECT * FROM sso_configs WHERE org_id = $1", [org.id]);
  if (!existing && !input.clientSecret) throw badRequest("Client secret is required.");
  const secret = input.clientSecret ? seal(input.clientSecret) : existing!.client_secret_enc;
  await pool().query(
    `INSERT INTO sso_configs (org_id, issuer, client_id, client_secret_enc, email_domains, enabled) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id) DO UPDATE SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc,
       email_domains = EXCLUDED.email_domains, enabled = EXCLUDED.enabled, updated_at = now()`,
    [org.id, input.issuer.replace(/\/$/, ""), input.clientId, secret, input.emailDomains, input.enabled],
  );
}

export const redirectUri = () => `${config.baseUrl}/api/auth/sso/callback`;

/** Returns the identity provider URL to redirect the browser to. */
export async function startSso(org: Org, session: Session, next: string): Promise<string> {
  const cfg = await one<SsoConfigRow>("SELECT * FROM sso_configs WHERE org_id = $1 AND enabled", [org.id]);
  if (!cfg) throw notFound("Single sign-on isn't set up for this organization.");
  const d = await discover(cfg.issuer);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await pool().query(
    "INSERT INTO sso_states (state, org_id, session_id, code_verifier, nonce, next_path) VALUES ($1, $2, $3, $4, $5, $6)",
    [state, org.id, session.id, verifier, nonce, next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard"],
  );
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.client_id,
    redirect_uri: redirectUri(),
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function finishSso(session: Session, state: string, code: string): Promise<{ next: string; token: string; userId: string }> {
  const st = await one<{ org_id: string; session_id: string; code_verifier: string; nonce: string; next_path: string; fresh: boolean }>(
    "DELETE FROM sso_states WHERE state = $1 RETURNING org_id, session_id, code_verifier, nonce, next_path, created_at > now() - interval '10 minutes' AS fresh",
    [state],
  );
  // Bound to the browser that started the flow (stops login CSRF / code injection).
  if (!st || !st.fresh || st.session_id !== session.id) throw forbidden("This sign-in link expired. Start again.");
  const cfg = (await one<SsoConfigRow>("SELECT * FROM sso_configs WHERE org_id = $1 AND enabled", [st.org_id]))!;
  if (!cfg) throw forbidden("Single sign-on is no longer enabled for this organization.");
  const d = await discover(cfg.issuer);
  await assertPublicUrl(d.token_endpoint);
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: cfg.client_id,
      client_secret: open(cfg.client_secret_enc),
      code_verifier: st.code_verifier,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw forbidden("The identity provider rejected the sign-in.");
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw forbidden("The identity provider didn't return an ID token.");

  let claims: JWTPayload & { email?: string; email_verified?: boolean; name?: string; nonce?: string };
  try {
    ({ payload: claims } = await jwtVerify(tokens.id_token, jwks(d.jwks_uri), { issuer: d.issuer, audience: cfg.client_id, clockTolerance: 60 }));
  } catch {
    throw forbidden("The identity provider's token couldn't be verified.");
  }
  if (claims.nonce !== st.nonce) throw forbidden("Sign-in response didn't match this request.");
  const email = claims.email ? normalizeEmail(claims.email) : null;
  if (!email || claims.email_verified === false) throw forbidden("Your identity provider didn't share a verified email address.");
  if (cfg.email_domains.length && !cfg.email_domains.includes(email.split("@")[1])) {
    throw forbidden("That account's email domain isn't allowed for this organization.");
  }
  const subject = `${cfg.issuer}|${claims.sub}`;
  const name = (claims.name ?? email.split("@")[0]).slice(0, 80);

  return tx(async (db) => {
    let user = await one<{ id: string }>("SELECT id FROM users WHERE sso_subject = $1", [subject], db);
    if (!user) {
      user = await one<{ id: string }>(
        `INSERT INTO users (display_name, email, email_verified_at, sso_subject) VALUES ($1, $2, now(), $3)
         ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET sso_subject = coalesce(users.sso_subject, EXCLUDED.sso_subject),
           email_verified_at = coalesce(users.email_verified_at, now())
         RETURNING id`,
        [name, email, subject],
        db,
      );
    }
    await db.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [st.org_id, user!.id]);
    await claimMemberships(user!.id, email, db);
    await db.query("UPDATE sessions SET user_id = $1, verified_email = $2, email_verified_at = now() WHERE id = $3", [user!.id, email, session.id]);
    const token = await rotateSessionToken(session.id, db);
    return { next: st.next_path, token, userId: user!.id };
  });
}
