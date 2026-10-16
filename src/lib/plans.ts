import { config } from "./config";

export interface PlanLimits {
  name: string;
  /** null = no duration cutoff in MeetSphere's own logic. Provider quotas still apply. */
  maxDurationMinutes: number | null;
  maxParticipants: number;
  maxInvitations: number;
  otpSendsPerHostPerDay: number;
  recording: boolean;
  aiProcessing: boolean;
  telephony: boolean;
  /** Preview: speakers/audience split on the SFU. Not the scalable viewer path. */
  broadcastMode: boolean;
}

export function planFor(_userId: string): PlanLimits {
  // Paid plans are not implemented yet; every host is on the free plan.
  const free = config.freePlan;
  return {
    name: "free",
    maxDurationMinutes: null,
    maxParticipants: free.maxParticipants,
    maxInvitations: free.maxInvitations,
    otpSendsPerHostPerDay: free.otpSendsPerHostPerDay,
    recording: false,
    aiProcessing: false,
    telephony: false,
    broadcastMode: true,
  };
}
