import { describe, expect, it } from "vitest";
import { allowedMethods, evaluateAdmission, identityBadges, type Applicant, type MeetingRules } from "@/lib/policy";

const rules = (o: Partial<MeetingRules> = {}): MeetingRules => ({
  access_policy: "host_approval",
  allow_name_only_requests: true,
  auto_admit_verified_invitees: true,
  locked: false,
  ended: false,
  ...o,
});
const nameOnly: Applicant = { method: "name", verified: false, match: "none", blocked: false, isHost: false };
const weakName: Applicant = { ...nameOnly, match: "weak_name_match" };
const verified: Applicant = { method: "phone", verified: true, match: "none", blocked: false, isHost: false };
const invitee: Applicant = { ...verified, match: "verified_contact_match" };

describe("evaluateAdmission", () => {
  it("never admits on a typed name alone outside open meetings", () => {
    for (const p of ["invited_only", "verified_only", "host_approval"] as const) {
      expect(evaluateAdmission(rules({ access_policy: p }), weakName).outcome).not.toBe("admit");
      expect(evaluateAdmission(rules({ access_policy: p }), nameOnly).outcome).not.toBe("admit");
    }
  });

  it("denies name-only requests when the host disabled them", () => {
    for (const p of ["invited_only", "verified_only", "host_approval"] as const) {
      const d = evaluateAdmission(rules({ access_policy: p, allow_name_only_requests: false }), weakName);
      expect(d.outcome).toBe("deny");
    }
  });

  it("rejects a phone/email method claim without server verification", () => {
    const d = evaluateAdmission(rules({ access_policy: "anyone_with_link" }), { ...verified, verified: false });
    expect(d).toMatchObject({ outcome: "deny", code: "verification_required" });
  });

  it("admits anyone in open meetings", () => {
    expect(evaluateAdmission(rules({ access_policy: "anyone_with_link" }), nameOnly).outcome).toBe("admit");
  });

  it("host_approval makes even verified invitees wait", () => {
    expect(evaluateAdmission(rules(), invitee).outcome).toBe("wait");
  });

  it("invited_only auto-admits verified invitees only when enabled", () => {
    expect(evaluateAdmission(rules({ access_policy: "invited_only" }), invitee).outcome).toBe("admit");
    expect(evaluateAdmission(rules({ access_policy: "invited_only", auto_admit_verified_invitees: false }), invitee).outcome).toBe("wait");
  });

  it("invited_only denies verified strangers unless manual review is allowed", () => {
    expect(evaluateAdmission(rules({ access_policy: "invited_only", allow_name_only_requests: false }), verified)).toMatchObject({
      outcome: "deny",
      code: "not_invited",
    });
    expect(evaluateAdmission(rules({ access_policy: "invited_only" }), verified).outcome).toBe("wait");
  });

  it("verified_only admits any verified contact", () => {
    expect(evaluateAdmission(rules({ access_policy: "verified_only" }), verified).outcome).toBe("admit");
  });

  it("lock, block and end override every policy but the host", () => {
    const open = rules({ access_policy: "anyone_with_link" });
    expect(evaluateAdmission({ ...open, locked: true }, invitee)).toMatchObject({ outcome: "deny", code: "locked" });
    expect(evaluateAdmission(open, { ...invitee, blocked: true })).toMatchObject({ outcome: "deny", code: "blocked" });
    expect(evaluateAdmission({ ...open, ended: true }, invitee)).toMatchObject({ outcome: "deny", code: "meeting_ended" });
    expect(evaluateAdmission({ ...open, locked: true }, { ...nameOnly, isHost: true }).outcome).toBe("admit");
  });
});

describe("allowedMethods", () => {
  it("hides name-only joins when disabled", () => {
    expect(allowedMethods({ access_policy: "invited_only", allow_name_only_requests: false })).toEqual(["phone", "email"]);
    expect(allowedMethods({ access_policy: "invited_only", allow_name_only_requests: true })).toContain("name");
  });
});

describe("identityBadges", () => {
  it("labels typed names as 'name_entered', never verified", () => {
    const b = identityBadges({ verification_state: "unverified", match_state: "weak_name_match", status: "admitted", decided_by: "host" });
    expect(b).toEqual(["name_entered", "host_approved"]);
    expect(b).not.toContain("invited");
  });
  it("labels verified invitees", () => {
    expect(
      identityBadges({ verification_state: "verified", match_state: "verified_contact_match", status: "admitted", decided_by: "policy" }),
    ).toEqual(["contact_verified", "invited"]);
  });
});
