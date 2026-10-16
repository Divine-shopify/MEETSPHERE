// Central, typed access to environment configuration. Secrets are only ever
// read from the environment.

function str(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function int(name: string, fallback: number): number {
  const v = str(name);
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  get baseUrl() {
    return str("APP_BASE_URL") ?? "http://localhost:3000";
  },
  get databaseUrl() {
    return str("DATABASE_URL") ?? "postgres://postgres@localhost:5432/meetsphere";
  },
  get appSecret(): string {
    const s = str("APP_SECRET");
    if (!s || s.length < 32) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("APP_SECRET must be set to at least 32 characters in production");
      }
      return "dev-only-insecure-secret-change-me-0123456789";
    }
    return s;
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
  get livekit() {
    const url = str("LIVEKIT_URL");
    const apiKey = str("LIVEKIT_API_KEY");
    const apiSecret = str("LIVEKIT_API_SECRET");
    return url && apiKey && apiSecret ? { url, apiKey, apiSecret } : null;
  },
  get twilio() {
    const accountSid = str("TWILIO_ACCOUNT_SID");
    const authToken = str("TWILIO_AUTH_TOKEN");
    const from = str("TWILIO_FROM_NUMBER");
    return accountSid && authToken && from ? { accountSid, authToken, from } : null;
  },
  get resend() {
    const apiKey = str("RESEND_API_KEY");
    const from = str("EMAIL_FROM");
    return apiKey && from ? { apiKey, from } : null;
  },
  get verificationDevMode() {
    return str("VERIFICATION_DEV_MODE") === "true" && process.env.NODE_ENV !== "production";
  },
  get freePlan() {
    return {
      maxParticipants: int("FREE_MAX_PARTICIPANTS", 50),
      maxInvitations: int("FREE_MAX_INVITATIONS", 500),
      otpSendsPerHostPerDay: int("FREE_OTP_SENDS_PER_HOST_PER_DAY", 200),
    };
  },
};
