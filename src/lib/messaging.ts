import { config } from "./config";
import { HttpError } from "./errors";

export type Channel = "phone" | "email";
export type ChannelMode = "provider" | "dev" | "unavailable";

/** How each verification channel will behave with the current configuration. */
export function channelModes(): Record<Channel, ChannelMode> {
  const dev = config.verificationDevMode;
  return {
    phone: config.twilio ? "provider" : dev ? "dev" : "unavailable",
    email: config.resend ? "provider" : dev ? "dev" : "unavailable",
  };
}

async function sendSms(to: string, body: string): Promise<void> {
  const t = config.twilio!;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${t.accountSid}:${t.authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: t.from, Body: body }),
  });
  if (!res.ok) {
    console.error("[messaging] SMS provider rejected send", res.status);
    throw new HttpError(502, "delivery_failed", "We couldn't send a text message to that number.");
  }
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const r = config.resend!;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${r.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: r.from, to: [to], subject, text }),
  });
  if (!res.ok) {
    console.error("[messaging] email provider rejected send", res.status);
    throw new HttpError(502, "delivery_failed", "We couldn't send an email to that address.");
  }
}

/**
 * Sends a one-time code. Returns "dev" when no provider is configured and dev
 * mode is on: in that case NOTHING is sent and the caller must surface the code
 * with an explicit dev-mode label.
 */
export async function deliverCode(channel: Channel, destination: string, code: string): Promise<"provider" | "dev"> {
  const mode = channelModes()[channel];
  if (mode === "unavailable") {
    throw new HttpError(
      503,
      "channel_unavailable",
      channel === "phone" ? "Phone verification is not configured on this server." : "Email verification is not configured on this server.",
    );
  }
  if (mode === "dev") return "dev";
  const text = `Your MeetSphere code is ${code}. It expires in 10 minutes. Don't share it with anyone.`;
  if (channel === "phone") await sendSms(destination, text);
  else await sendEmail(destination, `MeetSphere code: ${code}`, text);
  return "provider";
}
