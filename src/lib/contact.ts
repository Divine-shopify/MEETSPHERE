import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/** Returns an E.164 phone number, or null when the input is not a valid number. */
export function normalizePhone(input: string, defaultCountry?: CountryCode): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 32) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Lower-cases and trims an email address. Deliberately does NOT strip dots or
 * "+tags": those rules are provider-specific and stripping them could match the
 * wrong person to an invitation.
 */
export function normalizeEmail(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) return null;
  return v;
}

export function normalizeName(input: string): string {
  return input.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** "+491701234567" -> "+49•••••••567", "ada@example.com" -> "a••@example.com". */
export function maskContact(contact: string | null): string | null {
  if (!contact) return null;
  if (contact.startsWith("+")) {
    const keep = contact.slice(-3);
    const prefix = contact.slice(0, 3);
    return `${prefix}${"•".repeat(Math.max(contact.length - 6, 1))}${keep}`;
  }
  const [local, domain] = contact.split("@");
  if (!domain) return "•••";
  return `${local[0] ?? ""}${"•".repeat(Math.min(Math.max(local.length - 1, 1), 6))}@${domain}`;
}
