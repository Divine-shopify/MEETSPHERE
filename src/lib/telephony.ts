// Phone access through LiveKit SIP: dial-in with a meeting PIN, and dial-out
// ("call this person") from the host.
import { randomInt } from "node:crypto";
import { SipClient } from "livekit-server-sdk";
import { audit } from "./audit";
import { normalizePhone } from "./contact";
import { one, pool } from "./db";
import { badRequest, HttpError } from "./errors";
import { publish } from "./events";
import { livekitHttpUrl, lk, roomName } from "./media";
import type { Meeting } from "./meetings";
import { planForMeeting } from "./plans";

export function telephonyConfig() {
  const inboundTrunk = process.env.LIVEKIT_SIP_INBOUND_TRUNK_ID?.trim();
  const outboundTrunk = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID?.trim();
  const number = process.env.DIALIN_NUMBER?.trim();
  return {
    dialIn: inboundTrunk && number ? { trunkId: inboundTrunk, number } : null,
    dialOut: outboundTrunk ? { trunkId: outboundTrunk } : null,
  };
}

function sip(): SipClient {
  const c = lk();
  return new SipClient(livekitHttpUrl(), c.apiKey, c.apiSecret);
}

async function uniquePin(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const pin = String(randomInt(10_000_000, 99_999_999));
    const taken = await one("SELECT 1 FROM meetings WHERE dialin_pin = $1", [pin]);
    if (!taken) return pin;
  }
  throw new Error("Could not allocate a dial-in PIN");
}

async function requireTelephony(m: Meeting) {
  if (!(await planForMeeting(m)).telephony) throw new HttpError(402, "plan_required", "Phone dial-in is available on the Business plan.");
}

export async function enableDialIn(m: Meeting, actorUserId: string): Promise<{ pin: string; number: string }> {
  await requireTelephony(m);
  const cfg = telephonyConfig().dialIn;
  if (!cfg) throw new HttpError(503, "telephony_not_configured", "Phone dial-in is not configured (LIVEKIT_SIP_INBOUND_TRUNK_ID, DIALIN_NUMBER).");
  if (m.dialin_enabled && m.dialin_pin) return { pin: m.dialin_pin, number: cfg.number };
  const pin = await uniquePin();
  const rule = await sip().createSipDispatchRule(
    { type: "direct", roomName: roomName(m), pin },
    { name: `meetsphere-${m.code}`, trunkIds: [cfg.trunkId], metadata: JSON.stringify({ meetingId: m.id }) },
  );
  await pool().query("UPDATE meetings SET dialin_enabled = true, dialin_pin = $2, dialin_rule_id = $3 WHERE id = $1", [m.id, pin, rule.sipDispatchRuleId]);
  await audit({ meetingId: m.id, action: "settings_changed", actorUserId, metadata: { dialin: "enabled" } });
  await publish({ meetingId: m.id, type: "settings_changed", audience: "all" });
  return { pin, number: cfg.number };
}

export async function disableDialIn(m: Meeting, actorUserId: string): Promise<void> {
  if (m.dialin_rule_id) {
    try {
      await sip().deleteSipDispatchRule(m.dialin_rule_id);
    } catch (err) {
      console.warn("[sip] delete rule failed", (err as Error).message);
    }
  }
  await pool().query("UPDATE meetings SET dialin_enabled = false, dialin_pin = NULL, dialin_rule_id = NULL WHERE id = $1", [m.id]);
  await audit({ meetingId: m.id, action: "settings_changed", actorUserId, metadata: { dialin: "disabled" } });
  await publish({ meetingId: m.id, type: "settings_changed", audience: "all" });
}

/** Host calls someone's phone and brings them straight into the meeting. */
export async function dialOut(m: Meeting, actor: { userId: string | null; sessionId: string | null }, rawNumber: string, name: string) {
  await requireTelephony(m);
  const cfg = telephonyConfig().dialOut;
  if (!cfg) throw new HttpError(503, "telephony_not_configured", "Calling out is not configured (LIVEKIT_SIP_OUTBOUND_TRUNK_ID).");
  const number = normalizePhone(rawNumber);
  if (!number) throw badRequest("Enter a valid phone number including country code.");
  const identity = `sip_out_${number.replace("+", "")}`;
  // The host chose to call this number, so the callee is admitted by the host.
  await pool().query(
    `INSERT INTO join_requests (meeting_id, sip_identity, submitted_name, identity_method, verified_contact, verification_state, match_state, status, decided_by, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, 'dialin', $4, 'verified', 'none', 'admitted', 'host', $5, now())
     ON CONFLICT (meeting_id, sip_identity) WHERE sip_identity IS NOT NULL
     DO UPDATE SET status = 'admitted', decided_by = 'host', reviewed_at = now()`,
    [m.id, identity, name.trim().slice(0, 80) || "Phone guest", number, actor.userId],
  );
  await sip().createSipParticipant(cfg.trunkId, number, roomName(m), { participantIdentity: identity, participantName: name || "Phone guest" });
  await audit({ meetingId: m.id, action: "dialout", actorUserId: actor.userId, actorSessionId: actor.sessionId, metadata: { name } });
  await publish({ meetingId: m.id, type: "requests_changed", audience: "moderators" });
}
