// Pure admission rules. No I/O so the rules are easy to reason about and test.

export type AccessPolicy = "anyone_with_link" | "invited_only" | "verified_only" | "host_approval";
export type IdentityMethod = "phone" | "email" | "name";
export type MatchState = "none" | "weak_name_match" | "verified_contact_match";

export interface MeetingRules {
  access_policy: AccessPolicy;
  allow_name_only_requests: boolean;
  auto_admit_verified_invitees: boolean;
  locked: boolean;
  ended: boolean;
}

export interface Applicant {
  method: IdentityMethod;
  /** True only when the server verified a phone/email OTP on this session. */
  verified: boolean;
  match: MatchState;
  blocked: boolean;
  isHost: boolean;
}

export type Decision =
  | { outcome: "admit"; reason: string }
  | { outcome: "wait"; reason: string }
  | { outcome: "deny"; reason: string; code: string };

export const POLICY_LABELS: Record<AccessPolicy, string> = {
  anyone_with_link: "Anyone with the link",
  invited_only: "Invited attendees only",
  verified_only: "Verified phone/email only",
  host_approval: "Everyone waits for host approval",
};

/** Which join methods the join page should offer for this meeting. */
export function allowedMethods(rules: Pick<MeetingRules, "access_policy" | "allow_name_only_requests">): IdentityMethod[] {
  const verifiedMethods: IdentityMethod[] = ["phone", "email"];
  if (rules.access_policy === "anyone_with_link") return ["name", ...verifiedMethods];
  if (rules.allow_name_only_requests) return [...verifiedMethods, "name"];
  return verifiedMethods;
}

export function evaluateAdmission(m: MeetingRules, a: Applicant): Decision {
  if (a.isHost) return { outcome: "admit", reason: "Meeting host" };
  if (m.ended) return { outcome: "deny", code: "meeting_ended", reason: "This meeting has ended." };
  if (a.blocked) return { outcome: "deny", code: "blocked", reason: "The host has removed you from this meeting." };
  if (m.locked) return { outcome: "deny", code: "locked", reason: "The host has locked this meeting. No one new can join." };

  // A name typed by the user is never treated as identity.
  if (a.method !== "name" && !a.verified) {
    return { outcome: "deny", code: "verification_required", reason: "Verify your phone number or email first." };
  }

  const verifiedInvitee = a.verified && a.match === "verified_contact_match";
  const nameOnlyAllowed = m.access_policy === "anyone_with_link" || m.allow_name_only_requests;
  const manualReview = { outcome: "wait", reason: "Waiting for the host to let you in." } as const;

  switch (m.access_policy) {
    case "anyone_with_link":
      return { outcome: "admit", reason: "Meeting is open to anyone with the link" };

    case "host_approval":
      if (a.method === "name" && !nameOnlyAllowed) {
        return { outcome: "deny", code: "name_only_disabled", reason: "The host requires a verified phone number or email." };
      }
      return manualReview;

    case "verified_only":
      if (a.verified) {
        return { outcome: "admit", reason: verifiedInvitee ? "Verified invited attendee" : "Verified contact" };
      }
      return nameOnlyAllowed
        ? manualReview
        : { outcome: "deny", code: "verification_required", reason: "This meeting requires a verified phone number or email." };

    case "invited_only":
      if (verifiedInvitee) {
        return m.auto_admit_verified_invitees ? { outcome: "admit", reason: "Verified invited attendee" } : manualReview;
      }
      // Unrecognised contacts and name-only requests may ask for manual review if the host allows it.
      if (nameOnlyAllowed) return manualReview;
      return a.verified
        ? { outcome: "deny", code: "not_invited", reason: "That contact isn't on this meeting's invite list." }
        : { outcome: "deny", code: "verification_required", reason: "Verify the phone number or email the host invited." };
  }
}

/** Human-readable identity badge shown to the host and in the participant list. */
export type IdentityBadge = "name_entered" | "contact_verified" | "invited" | "host_approved";

export function identityBadges(r: {
  verification_state: "verified" | "unverified";
  match_state: MatchState;
  status: string;
  decided_by: string | null;
}): IdentityBadge[] {
  const badges: IdentityBadge[] = [];
  badges.push(r.verification_state === "verified" ? "contact_verified" : "name_entered");
  if (r.match_state === "verified_contact_match") badges.push("invited");
  if (r.status === "admitted" && r.decided_by === "host") badges.push("host_approved");
  return badges;
}
