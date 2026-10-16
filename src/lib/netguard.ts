import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function privateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? privateV4(mapped[1]) : false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return privateV4(ip);
  if (kind === 6) return privateV6(ip);
  return true;
}

/**
 * Guards server-side requests to user-supplied URLs (webhooks, OIDC issuers)
 * against SSRF into the private network. Set ALLOW_PRIVATE_OUTBOUND=true only
 * for local development.
 */
export async function assertPublicUrl(raw: string, opts: { requireHttps?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  const allowPrivate = process.env.ALLOW_PRIVATE_OUTBOUND === "true" && process.env.NODE_ENV !== "production";
  if (url.protocol !== "https:" && (opts.requireHttps ?? process.env.NODE_ENV === "production") && !allowPrivate) {
    throw new Error("URL must use https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("URL must use http(s)://");
  if (url.username || url.password) throw new Error("URL must not contain credentials");
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new Error("URL host does not resolve");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error("URL points to a private network address");
  return url;
}
