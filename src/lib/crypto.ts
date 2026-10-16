import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Keyed digest so a database leak alone does not reveal OTP codes. */
export function hmac(value: string): Buffer {
  return createHmac("sha256", config.appSecret).update(value).digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

const CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyz"; // no "l" to avoid 1/l confusion

/** Meeting code like "abc-defg-hij" (~1.5e14 combinations). */
export function generateMeetingCode(): string {
  const pick = (n: number) => Array.from({ length: n }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join("");
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}
