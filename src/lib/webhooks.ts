import { createHmac } from "node:crypto";
import { one, query, pool } from "./db";
import type { Meeting } from "./meetings";
import { assertPublicUrl } from "./netguard";
import { planForMeeting } from "./plans";

export const WEBHOOK_EVENTS = [
  "meeting.started",
  "meeting.ended",
  "participant.admitted",
  "participant.removed",
  "recording.ready",
  "stream.started",
  "stream.ended",
  "transcript.updated",
  "summary.ready",
  "question.asked",
  "poll.closed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 8;

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Queues an event for every matching endpoint owned by the meeting's host or organization. */
export async function emitWebhook(m: Meeting, event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  try {
    const endpoints = await query<{ id: string }>(
      `SELECT id FROM webhook_endpoints
        WHERE active AND $3 = ANY(events)
          AND ((org_id IS NOT NULL AND org_id = $1) OR (owner_user_id IS NOT NULL AND owner_user_id = $2))`,
      [m.org_id ?? null, m.host_user_id, event],
    );
    if (endpoints.length === 0) return;
    if (!(await planForMeeting(m)).webhooks) return;
    const payload = {
      event,
      createdAt: new Date().toISOString(),
      meeting: { id: m.id, code: m.code, title: m.title },
      data,
    };
    for (const e of endpoints) {
      await pool().query("INSERT INTO webhook_deliveries (endpoint_id, event, payload) VALUES ($1, $2, $3)", [e.id, event, JSON.stringify(payload)]);
    }
    // Deliver promptly without blocking the caller; the cron job retries failures.
    void deliverDue(20).catch(() => {});
  } catch (err) {
    console.warn("[webhooks] emit failed", (err as Error).message);
  }
}

export async function deliverDue(limit = 50): Promise<{ delivered: number; failed: number }> {
  const due = await query<{ id: string; event: string; payload: unknown; attempts: number; url: string; secret: string }>(
    `UPDATE webhook_deliveries d SET attempts = d.attempts + 1, next_attempt_at = now() + interval '5 minutes'
      WHERE d.id IN (
        SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.event, d.payload, d.attempts,
        (SELECT url FROM webhook_endpoints e WHERE e.id = d.endpoint_id) AS url,
        (SELECT secret FROM webhook_endpoints e WHERE e.id = d.endpoint_id) AS secret`,
    [limit],
  );
  let delivered = 0;
  let failed = 0;
  for (const d of due) {
    const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
    const ts = Math.floor(Date.now() / 1000);
    try {
      await assertPublicUrl(d.url);
      const res = await fetch(d.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "MeetSphere-Webhooks/1",
          "X-MeetSphere-Event": d.event,
          "X-MeetSphere-Delivery": d.id,
          "X-MeetSphere-Signature": `t=${ts},v1=${signPayload(d.secret, ts, body)}`,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pool().query("UPDATE webhook_deliveries SET status = 'delivered', last_error = NULL WHERE id = $1", [d.id]);
      delivered++;
    } catch (err) {
      const giveUp = d.attempts >= MAX_ATTEMPTS;
      await pool().query(
        `UPDATE webhook_deliveries SET status = $2, last_error = $3,
           next_attempt_at = now() + make_interval(mins => $4) WHERE id = $1`,
        [d.id, giveUp ? "failed" : "pending", (err as Error).message.slice(0, 300), 2 ** Math.min(d.attempts, 10)],
      );
      failed++;
    }
  }
  return { delivered, failed };
}

export async function endpointOwnerCheck(id: string, owner: { userId?: string; orgIds?: string[] }) {
  return one<{ id: string }>(
    "SELECT id FROM webhook_endpoints WHERE id = $1 AND (owner_user_id = $2 OR org_id = ANY($3::uuid[]))",
    [id, owner.userId ?? null, owner.orgIds ?? []],
  );
}
