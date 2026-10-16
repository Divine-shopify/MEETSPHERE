import { config } from "./config";
import { one, type Db, pool } from "./db";

export type PlanId = "free" | "pro" | "business" | "enterprise";

export interface PlanLimits {
  id: PlanId;
  name: string;
  /** null = no duration cutoff in MeetSphere's own logic. Provider quotas still apply. */
  maxDurationMinutes: number | null;
  /** People who can publish audio/video in one room. */
  maxParticipants: number;
  /** Subscribe-only viewers in presentation mode (WebRTC). */
  maxAudience: number;
  maxInvitations: number;
  otpSendsPerHostPerDay: number;
  inviteSendsPerDay: number;
  /** Fair-use cap checked only when someone NEW connects; never disconnects anyone mid-meeting. */
  monthlyParticipantMinutes: number | null;
  breakoutRooms: number;
  recording: boolean;
  recordingStorageGb: number;
  hlsStreaming: boolean;
  aiSummaries: boolean;
  aiSummariesPerMonth: number;
  telephony: boolean;
  customBranding: boolean;
  webhooks: boolean;
  sso: boolean;
  priceMonthlyUsd: number | null;
}

function int(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function plans(): Record<PlanId, PlanLimits> {
  const free = config.freePlan;
  return {
    free: {
      id: "free",
      name: "Free",
      maxDurationMinutes: null,
      maxParticipants: free.maxParticipants,
      maxAudience: int("FREE_MAX_AUDIENCE", 100),
      maxInvitations: free.maxInvitations,
      otpSendsPerHostPerDay: free.otpSendsPerHostPerDay,
      inviteSendsPerDay: int("FREE_INVITE_SENDS_PER_DAY", 100),
      monthlyParticipantMinutes: int("FREE_MONTHLY_PARTICIPANT_MINUTES", 30000),
      breakoutRooms: 10,
      recording: false,
      recordingStorageGb: 0,
      hlsStreaming: false,
      aiSummaries: false,
      aiSummariesPerMonth: 0,
      telephony: false,
      customBranding: false,
      webhooks: false,
      sso: false,
      priceMonthlyUsd: 0,
    },
    pro: {
      id: "pro",
      name: "Pro",
      maxDurationMinutes: null,
      maxParticipants: int("PRO_MAX_PARTICIPANTS", 150),
      maxAudience: int("PRO_MAX_AUDIENCE", 1000),
      maxInvitations: 2000,
      otpSendsPerHostPerDay: 1000,
      inviteSendsPerDay: 1000,
      monthlyParticipantMinutes: int("PRO_MONTHLY_PARTICIPANT_MINUTES", 300000),
      breakoutRooms: 50,
      recording: true,
      recordingStorageGb: 50,
      hlsStreaming: true,
      aiSummaries: true,
      aiSummariesPerMonth: 100,
      telephony: false,
      customBranding: true,
      webhooks: true,
      sso: false,
      priceMonthlyUsd: int("PRO_PRICE_USD", 15),
    },
    business: {
      id: "business",
      name: "Business",
      maxDurationMinutes: null,
      maxParticipants: int("BUSINESS_MAX_PARTICIPANTS", 300),
      maxAudience: int("BUSINESS_MAX_AUDIENCE", 10000),
      maxInvitations: 10000,
      otpSendsPerHostPerDay: 5000,
      inviteSendsPerDay: 5000,
      monthlyParticipantMinutes: int("BUSINESS_MONTHLY_PARTICIPANT_MINUTES", 2000000),
      breakoutRooms: 100,
      recording: true,
      recordingStorageGb: 500,
      hlsStreaming: true,
      aiSummaries: true,
      aiSummariesPerMonth: 1000,
      telephony: true,
      customBranding: true,
      webhooks: true,
      sso: false,
      priceMonthlyUsd: int("BUSINESS_PRICE_USD", 49),
    },
    enterprise: {
      id: "enterprise",
      name: "Enterprise",
      maxDurationMinutes: null,
      maxParticipants: int("ENTERPRISE_MAX_PARTICIPANTS", 500),
      maxAudience: int("ENTERPRISE_MAX_AUDIENCE", 50000),
      maxInvitations: 50000,
      otpSendsPerHostPerDay: 20000,
      inviteSendsPerDay: 20000,
      monthlyParticipantMinutes: null,
      breakoutRooms: 200,
      recording: true,
      recordingStorageGb: 5000,
      hlsStreaming: true,
      aiSummaries: true,
      aiSummariesPerMonth: 10000,
      telephony: true,
      customBranding: true,
      webhooks: true,
      sso: true,
      priceMonthlyUsd: null,
    },
  };
}

/** Synchronous free-plan lookup for code paths with no billing context. */
export function planFor(_userId: string): PlanLimits {
  return plans().free;
}

export type Feature = keyof Pick<
  PlanLimits,
  "recording" | "hlsStreaming" | "aiSummaries" | "telephony" | "customBranding" | "webhooks" | "sso"
>;

/** Billing owner: the meeting's organization if it has one, otherwise the host. */
export async function planForOwner(owner: { orgId?: string | null; userId?: string | null }, db: Db = pool()): Promise<PlanLimits> {
  const row = owner.orgId
    ? await one<{ plan_id: PlanId; status: string }>("SELECT plan_id, status FROM billing_accounts WHERE org_id = $1", [owner.orgId], db)
    : owner.userId
      ? await one<{ plan_id: PlanId; status: string }>("SELECT plan_id, status FROM billing_accounts WHERE user_id = $1", [owner.userId], db)
      : null;
  const all = plans();
  // Past-due accounts keep paid limits for the grace period Stripe manages; canceled drops to free.
  if (!row || row.status === "canceled" || row.status === "incomplete") return all.free;
  return all[row.plan_id] ?? all.free;
}

export async function planForMeeting(m: { org_id?: string | null; host_user_id: string }, db: Db = pool()): Promise<PlanLimits> {
  return planForOwner({ orgId: m.org_id ?? null, userId: m.host_user_id }, db);
}
