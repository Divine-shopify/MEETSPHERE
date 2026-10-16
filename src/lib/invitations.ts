import Papa from "papaparse";
import type { CountryCode } from "libphonenumber-js";
import { z } from "zod";
import { audit } from "./audit";
import { normalizeEmail, normalizeName, normalizePhone } from "./contact";
import { one, query, tx, type Db, pool } from "./db";
import { badRequest, HttpError, notFound } from "./errors";
import type { MatchState } from "./policy";
import { planFor } from "./plans";

export interface InvitationInput {
  name: string;
  phone?: string | null;
  email?: string | null;
}

export interface NormalizedInvitation {
  expected_name: string;
  normalized_phone: string | null;
  normalized_email: string | null;
}

export interface RowError {
  line: number;
  message: string;
}

export const invitationInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(32).nullish(),
  email: z.string().trim().max(254).nullish(),
});

export function normalizeInvitation(input: InvitationInput, defaultCountry?: CountryCode): NormalizedInvitation | string {
  const name = input.name?.trim().replace(/\s+/g, " ");
  if (!name) return "Name is required";
  if (name.length > 80) return "Name is longer than 80 characters";
  let phone: string | null = null;
  let email: string | null = null;
  if (input.phone && input.phone.trim()) {
    phone = normalizePhone(input.phone, defaultCountry);
    if (!phone) return `"${input.phone}" is not a valid phone number (include the country code)`;
  }
  if (input.email && input.email.trim()) {
    email = normalizeEmail(input.email);
    if (!email) return `"${input.email}" is not a valid email address`;
  }
  return { expected_name: name, normalized_phone: phone, normalized_email: email };
}

const NAME_HEADERS = ["name", "display_name", "displayname", "expected_name", "full name", "full_name"];
const PHONE_HEADERS = ["phone", "phone_number", "phone number", "mobile", "cell", "telephone"];
const EMAIL_HEADERS = ["email", "e-mail", "email_address", "email address", "mail"];

/** Parses an invite list CSV. Requires a header row with at least a name column. */
export function parseInvitationCsv(text: string, defaultCountry?: CountryCode): { rows: NormalizedInvitation[]; errors: RowError[] } {
  if (text.length > 1_000_000) throw badRequest("CSV file is too large (max 1 MB).");
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const headers = parsed.meta.fields ?? [];
  const nameCol = headers.find((h) => NAME_HEADERS.includes(h));
  const phoneCol = headers.find((h) => PHONE_HEADERS.includes(h));
  const emailCol = headers.find((h) => EMAIL_HEADERS.includes(h));
  if (!nameCol) throw badRequest('CSV needs a header row with a "name" column (optional "phone" and "email" columns).');

  const rows: NormalizedInvitation[] = [];
  const errors: RowError[] = [];
  parsed.data.forEach((rec, i) => {
    const line = i + 2; // header is line 1
    const result = normalizeInvitation(
      { name: rec[nameCol] ?? "", phone: phoneCol ? rec[phoneCol] : null, email: emailCol ? rec[emailCol] : null },
      defaultCountry,
    );
    if (typeof result === "string") errors.push({ line, message: result });
    else rows.push(result);
  });
  return { rows, errors };
}

export async function addInvitations(
  meetingId: string,
  hostUserId: string,
  rows: NormalizedInvitation[],
): Promise<{ added: number; duplicates: number }> {
  if (rows.length === 0) return { added: 0, duplicates: 0 };
  const limit = planFor(hostUserId).maxInvitations;
  return tx(async (db) => {
    // Serialize concurrent imports for the same meeting so the cap holds.
    await db.query("SELECT 1 FROM meetings WHERE id = $1 FOR UPDATE", [meetingId]);
    const countRow = await one<{ n: string }>(
      "SELECT count(*) AS n FROM invitations WHERE meeting_id = $1 AND invite_status <> 'revoked'",
      [meetingId],
      db,
    );
    const existing = Number(countRow?.n ?? 0);
    if (existing + rows.length > limit) {
      throw new HttpError(422, "plan_limit", `The free plan allows ${limit} invitations per meeting (currently ${existing}).`);
    }
    let added = 0;
    for (const r of rows) {
      const res = await db.query(
        `INSERT INTO invitations (meeting_id, expected_name, normalized_phone, normalized_email)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [meetingId, r.expected_name, r.normalized_phone, r.normalized_email],
      );
      added += res.rowCount ?? 0;
    }
    await audit({ meetingId, action: "invitations_added", actorUserId: hostUserId, metadata: { added, submitted: rows.length } }, db);
    return { added, duplicates: rows.length - added };
  });
}

export interface InvitationRow {
  id: string;
  expected_name: string;
  normalized_phone: string | null;
  normalized_email: string | null;
  invite_status: string;
  created_at: string;
}

export async function listInvitations(meetingId: string): Promise<InvitationRow[]> {
  return query<InvitationRow>(
    `SELECT id, expected_name, normalized_phone, normalized_email, invite_status, created_at
       FROM invitations WHERE meeting_id = $1 AND invite_status <> 'revoked' ORDER BY expected_name`,
    [meetingId],
  );
}

export async function revokeInvitation(meetingId: string, hostUserId: string, invitationId: string): Promise<void> {
  await tx(async (db) => {
    const res = await db.query(
      "UPDATE invitations SET invite_status = 'revoked' WHERE id = $1 AND meeting_id = $2 AND invite_status <> 'revoked'",
      [invitationId, meetingId],
    );
    if (!res.rowCount) throw notFound("Invitation not found");
    await audit({ meetingId, action: "invitation_revoked", actorUserId: hostUserId, targetId: invitationId }, db);
  });
}

/**
 * Matches an applicant to the invite list. Only a server-verified phone/email
 * can produce a real match; a matching name is recorded as a weak match and
 * never grants access on its own.
 */
export async function matchInvitation(
  meetingId: string,
  applicant: { verifiedContact: string | null; name: string },
  db: Db = pool(),
): Promise<{ match: MatchState; invitationId: string | null; expectedName: string | null }> {
  if (applicant.verifiedContact) {
    const col = applicant.verifiedContact.startsWith("+") ? "normalized_phone" : "normalized_email";
    const inv = await one<{ id: string; expected_name: string }>(
      `SELECT id, expected_name FROM invitations WHERE meeting_id = $1 AND ${col} = $2 AND invite_status <> 'revoked'`,
      [meetingId, applicant.verifiedContact],
      db,
    );
    if (inv) return { match: "verified_contact_match", invitationId: inv.id, expectedName: inv.expected_name };
  }
  const target = normalizeName(applicant.name);
  const candidates = await query<{ id: string; expected_name: string }>(
    "SELECT id, expected_name FROM invitations WHERE meeting_id = $1 AND invite_status <> 'revoked'",
    [meetingId],
    db,
  );
  const byName = candidates.find((c) => normalizeName(c.expected_name) === target);
  if (byName) return { match: "weak_name_match", invitationId: byName.id, expectedName: byName.expected_name };
  return { match: "none", invitationId: null, expectedName: null };
}

/**
 * Sends the meeting link to invitees by SMS and/or email. Without configured
 * providers nothing is sent and the caller is told so (never a fake success).
 */
export async function sendInvitations(
  m: { id: string; code: string; title: string; host_user_id: string; org_id: string | null; scheduled_at: string | null },
  hostName: string,
  opts: { invitationIds?: string[]; ics?: string | null; baseUrl: string },
): Promise<{ sms: number; email: number; skipped: number; unavailable: string[] }> {
  const { channelModes, sendEmail, sendSms } = await import("./messaging");
  const { planForMeeting } = await import("./plans");
  const { dailyUsage, recordUsage } = await import("./usage");
  const modes = channelModes();
  const targets = await query<InvitationRow>(
    `SELECT id, expected_name, normalized_phone, normalized_email, invite_status, created_at FROM invitations
      WHERE meeting_id = $1 AND invite_status <> 'revoked' ${opts.invitationIds ? "AND id = ANY($2::uuid[])" : ""}`,
    opts.invitationIds ? [m.id, opts.invitationIds] : [m.id],
  );
  const plan = await planForMeeting(m);
  const owner = { orgId: m.org_id, userId: m.host_user_id };
  let remaining = plan.inviteSendsPerDay - (await dailyUsage(owner, ["invite_sms", "invite_email"]));
  const link = `${opts.baseUrl}/m/${m.code}`;
  const when = m.scheduled_at ? ` on ${new Date(m.scheduled_at).toUTCString()}` : "";
  const text = `${hostName} invited you to "${m.title}"${when} on MeetSphere. Join from your phone or computer: ${link}`;
  const unavailable = new Set<string>();
  let sms = 0;
  let email = 0;
  let skipped = 0;

  for (const t of targets) {
    if (remaining <= 0) {
      skipped++;
      continue;
    }
    let sent = false;
    // Prefer email (cheaper) when both exist; send SMS when it's the only contact.
    if (t.normalized_email) {
      if (modes.email === "provider") {
        try {
          await sendEmail(
            t.normalized_email,
            `Invitation: ${m.title}`,
            `Hi ${t.expected_name},\n\n${text}\n\nWhen you join, verify this email address to be let in as an invited guest.`,
            opts.ics ? [{ filename: "invite.ics", content: Buffer.from(opts.ics).toString("base64") }] : [],
          );
          await recordUsage({ kind: "invite_email", hostUserId: m.host_user_id, orgId: m.org_id, meetingId: m.id });
          email++;
          sent = true;
        } catch {
          /* fall through to SMS */
        }
      } else unavailable.add("email");
    }
    if (!sent && t.normalized_phone) {
      if (modes.phone === "provider") {
        try {
          await sendSms(t.normalized_phone, text);
          await recordUsage({ kind: "invite_sms", hostUserId: m.host_user_id, orgId: m.org_id, meetingId: m.id });
          sms++;
          sent = true;
        } catch {
          /* counted as skipped */
        }
      } else unavailable.add("phone");
    }
    if (sent) {
      remaining--;
      await pool().query("UPDATE invitations SET last_sent_at = now(), send_count = send_count + 1 WHERE id = $1", [t.id]);
    } else skipped++;
  }
  await audit({ meetingId: m.id, action: "invitations_sent", actorUserId: m.host_user_id, metadata: { sms, email, skipped } });
  return { sms, email, skipped, unavailable: [...unavailable] };
}
