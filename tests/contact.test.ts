import { describe, expect, it } from "vitest";
import { maskContact, normalizeEmail, normalizeName, normalizePhone } from "@/lib/contact";
import { parseInvitationCsv } from "@/lib/invitations";

describe("contact normalization", () => {
  it("normalizes phones to E.164", () => {
    expect(normalizePhone("+44 7911 123456")).toBe("+447911123456");
    expect(normalizePhone("0170 1234567", "DE")).toBe("+491701234567");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("not a phone")).toBeNull();
  });
  it("lower-cases emails but keeps dots and plus tags", () => {
    expect(normalizeEmail("  Ada.Lovelace+x@Example.COM ")).toBe("ada.lovelace+x@example.com");
    expect(normalizeEmail("nope")).toBeNull();
  });
  it("normalizes names for weak matching", () => {
    expect(normalizeName("  Ada   LOVELACE ")).toBe("ada lovelace");
  });
  it("masks contacts", () => {
    expect(maskContact("+491701234567")).toBe("+49•••••••567");
    expect(maskContact("ada@example.com")).toBe("a••@example.com");
    expect(maskContact(null)).toBeNull();
  });
});

describe("parseInvitationCsv", () => {
  it("parses flexible headers and reports bad rows with line numbers", () => {
    const csv = "Full Name,Mobile,E-mail\nAda Lovelace,+44 7911 123456,ada@example.com\nBob,,BOB@EXAMPLE.COM\n,+447911123457,\nEve,12,\n";
    const { rows, errors } = parseInvitationCsv(csv);
    expect(rows).toEqual([
      { expected_name: "Ada Lovelace", normalized_phone: "+447911123456", normalized_email: "ada@example.com" },
      { expected_name: "Bob", normalized_phone: null, normalized_email: "bob@example.com" },
    ]);
    expect(errors.map((e) => e.line)).toEqual([4, 5]);
  });
  it("uses a default country for local numbers", () => {
    const { rows } = parseInvitationCsv("name,phone\nKlaus,0170 1234567\n", "DE");
    expect(rows[0].normalized_phone).toBe("+491701234567");
  });
  it("requires a name column", () => {
    expect(() => parseInvitationCsv("phone\n+447911123456\n")).toThrow(/name/);
  });
});
