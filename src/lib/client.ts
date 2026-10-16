"use client";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: opts.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g. proxy error page)
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? "http_error", data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const BADGE_LABELS: Record<string, string> = {
  name_entered: "Name entered (unverified)",
  contact_verified: "Contact verified",
  invited: "Invited",
  host_approved: "Host approved",
  host: "Host",
};
