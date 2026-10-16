import { one, query } from "./db";
import { publish } from "./events";
import { audit } from "./audit";
import type { Meeting } from "./meetings";

const BURST_5M = Number(process.env.SAFETY_JOIN_BURST ?? 25);
const DENIED_15M = Number(process.env.SAFETY_DENIED_BURST ?? 15);
const OTP_60M = Number(process.env.SAFETY_OTP_BURST ?? 60);

export interface SafetyAlert {
  level: "warning" | "critical";
  code: string;
  message: string;
  suggestion: string;
}

export async function safetySnapshot(m: Meeting) {
  const row = await one<{
    join5: string; join60: string; pending: string; denied15: string; kicked60: string; otp60: string; reports: string; connected: string;
  }>(
    `SELECT
       (SELECT count(*) FROM join_requests WHERE meeting_id = $1 AND requested_at > now() - interval '5 minutes') AS join5,
       (SELECT count(*) FROM join_requests WHERE meeting_id = $1 AND requested_at > now() - interval '60 minutes') AS join60,
       (SELECT count(*) FROM join_requests WHERE meeting_id = $1 AND status = 'pending') AS pending,
       (SELECT count(*) FROM moderation_events WHERE meeting_id = $1 AND action = 'join_denied' AND created_at > now() - interval '15 minutes') AS denied15,
       (SELECT count(*) FROM moderation_events WHERE meeting_id = $1 AND action = 'unauthorized_media_join_kicked' AND created_at > now() - interval '60 minutes') AS kicked60,
       (SELECT coalesce(sum(quantity), 0) FROM usage_events WHERE meeting_id = $1 AND kind IN ('otp_sms', 'otp_email') AND created_at > now() - interval '60 minutes') AS otp60,
       (SELECT count(*) FROM abuse_reports WHERE meeting_id = $1 AND status = 'open') AS reports,
       (SELECT count(DISTINCT identity) FROM participant_sessions WHERE meeting_id = $1 AND left_at IS NULL) AS connected`,
    [m.id],
  );
  const n = (k: keyof NonNullable<typeof row>) => Number(row?.[k] ?? 0);
  const denials = await query<{ reason: string; n: string }>(
    `SELECT reason, count(*) AS n FROM moderation_events WHERE meeting_id = $1 AND action = 'join_denied'
       AND created_at > now() - interval '60 minutes' GROUP BY reason ORDER BY n DESC`,
    [m.id],
  );
  const alerts: SafetyAlert[] = [];
  if (n("join5") >= BURST_5M) {
    alerts.push({
      level: "critical",
      code: "join_burst",
      message: `${n("join5")} join requests in the last 5 minutes.`,
      suggestion: m.locked_at ? "The meeting is locked." : "If you weren't expecting this, lock the meeting and switch to invited-only.",
    });
  }
  if (n("denied15") >= DENIED_15M) {
    alerts.push({ level: "warning", code: "denied_burst", message: `${n("denied15")} denied join attempts in 15 minutes.`, suggestion: "Someone may be probing the link. Consider a new meeting link for future sessions." });
  }
  if (n("otp60") >= OTP_60M) {
    alerts.push({ level: "warning", code: "otp_burst", message: `${n("otp60")} verification codes sent for this meeting in the last hour.`, suggestion: "Possible SMS abuse. Lock the meeting or disable phone verification." });
  }
  if (n("kicked60") > 0) {
    alerts.push({ level: "warning", code: "unauthorized_media", message: `${n("kicked60")} unauthorized room connection(s) were blocked.`, suggestion: "No action needed; they were removed automatically." });
  }
  if (n("reports") > 0) {
    alerts.push({ level: "warning", code: "abuse_reports", message: `${n("reports")} open abuse report(s) from participants.`, suggestion: "Review them below." });
  }
  const reports = await query<{ id: string; reason: string; details: string | null; target_name: string | null; created_at: string; status: string }>(
    `SELECT a.id, a.reason, a.details, a.status, a.created_at, jr.submitted_name AS target_name
       FROM abuse_reports a LEFT JOIN join_requests jr ON jr.id = a.target_request_id
      WHERE a.meeting_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
    [m.id],
  );
  return {
    locked: m.locked_at !== null,
    metrics: {
      joinRequests5m: n("join5"),
      joinRequests60m: n("join60"),
      waiting: n("pending"),
      denied15m: n("denied15"),
      unauthorizedMediaBlocked60m: n("kicked60"),
      otpSends60m: n("otp60"),
      openReports: n("reports"),
      connected: n("connected"),
    },
    denialsByReason: denials.map((d) => ({ reason: d.reason, count: Number(d.n) })),
    alerts,
    reports,
  };
}

/** Called after each join request; alerts moderators once when a burst threshold is crossed. */
export async function checkJoinBurst(m: Meeting): Promise<void> {
  const r = await one<{ n: string }>(
    "SELECT count(*) AS n FROM join_requests WHERE meeting_id = $1 AND requested_at > now() - interval '5 minutes'",
    [m.id],
  );
  if (Number(r?.n) === BURST_5M) {
    await audit({ meetingId: m.id, action: "safety_alert", reason: "join_burst", metadata: { count: BURST_5M } });
    await publish({ meetingId: m.id, type: "safety_alert", audience: "moderators", data: { code: "join_burst", count: BURST_5M } });
  }
}
