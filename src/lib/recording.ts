// Recording (MP4) and live streaming (HLS) via LiveKit Egress.
import { randomUUID } from "node:crypto";
import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptionsPreset,
  SegmentedFileOutput,
  SegmentedFileProtocol,
  type EgressInfo,
} from "livekit-server-sdk";
import { audit } from "./audit";
import { one, query, pool } from "./db";
import { conflict, HttpError } from "./errors";
import { publish } from "./events";
import { livekitHttpUrl, lk, roomName } from "./media";
import { getMeetingById, type Meeting } from "./meetings";
import { planForMeeting } from "./plans";
import { egressPath, egressS3Upload, requireStorage, storageMode } from "./storage";
import { recordUsage } from "./usage";
import { emitWebhook } from "./webhooks";

export interface Artifact {
  id: string;
  meeting_id: string;
  type: "recording" | "stream" | "transcript" | "notes" | "export";
  storage_key: string | null;
  storage: "local" | "s3" | null;
  status: "pending" | "processing" | "ready" | "failed" | "deleted";
  egress_id: string | null;
  size_bytes: string | null;
  duration_ms: string | null;
  error: string | null;
  consent_state: string;
  retention_until: string | null;
  created_at: string;
  ended_at: string | null;
}

function egress(): EgressClient {
  const c = lk();
  return new EgressClient(livekitHttpUrl(), c.apiKey, c.apiSecret);
}

export const recordingKey = (meetingId: string, artifactId: string) => `${meetingId}/rec-${artifactId}.mp4`;
export const streamPrefix = (meetingId: string, artifactId: string) => `${meetingId}/stream-${artifactId}`;

async function retentionFor(m: Meeting): Promise<Date | null> {
  const org = m.org_id ? await one<{ retention_days: number | null }>("SELECT retention_days FROM organizations WHERE id = $1", [m.org_id]) : null;
  const days = m.retention_days ?? org?.retention_days ?? null;
  return days ? new Date(Date.now() + days * 86400_000) : null;
}

type Actor = { userId: string | null; sessionId: string | null };

export async function startRecording(m: Meeting, actor: Actor): Promise<Artifact> {
  const plan = await planForMeeting(m);
  if (!plan.recording) throw new HttpError(402, "plan_required", "Recording is available on paid plans.");
  const mode = requireStorage();
  if (m.recording_state !== "off") throw conflict("Recording is already running.", "already_recording");
  const id = randomUUID();
  const key = recordingKey(m.id, id);
  // Claim the state first so two clicks can't start two egresses.
  const claimed = await pool().query("UPDATE meetings SET recording_state = 'starting' WHERE id = $1 AND recording_state = 'off'", [m.id]);
  if (!claimed.rowCount) throw conflict("Recording is already running.", "already_recording");
  try {
    await pool().query(
      `INSERT INTO meeting_artifacts (id, meeting_id, type, storage_key, storage, status, consent_state, retention_until)
       VALUES ($1, $2, 'recording', $3, $4, 'pending', 'requested', $5)`,
      [id, m.id, key, mode, await retentionFor(m)],
    );
    const output = new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath: egressPath(key) });
    const s3 = egressS3Upload();
    if (s3) output.output = { case: "s3", value: s3 };
    const info = await egress().startRoomCompositeEgress(roomName(m), { file: output }, { layout: "grid", encodingOptions: EncodingOptionsPreset.H264_720P_30 });
    await pool().query("UPDATE meeting_artifacts SET egress_id = $2, status = 'processing' WHERE id = $1", [id, info.egressId]);
    await pool().query("UPDATE meetings SET recording_egress_id = $2 WHERE id = $1", [m.id, info.egressId]);
  } catch (err) {
    await pool().query("UPDATE meetings SET recording_state = 'off', recording_egress_id = NULL WHERE id = $1", [m.id]);
    await pool().query("UPDATE meeting_artifacts SET status = 'failed', error = $2 WHERE id = $1", [id, (err as Error).message.slice(0, 300)]);
    throw new HttpError(502, "egress_failed", `Couldn't start recording: ${(err as Error).message}`);
  }
  await audit({ meetingId: m.id, action: "recording_started", actorUserId: actor.userId, actorSessionId: actor.sessionId, targetId: id });
  // Everyone is told immediately; clients show a persistent "Recording" notice and ask for consent.
  await publish({ meetingId: m.id, type: "recording_changed", audience: "all", data: { state: "starting" } });
  return (await one<Artifact>("SELECT * FROM meeting_artifacts WHERE id = $1", [id]))!;
}

export async function stopRecording(m: Meeting, actor: Actor): Promise<void> {
  if (!m.recording_egress_id || m.recording_state === "off") throw conflict("Recording isn't running.", "not_recording");
  await pool().query("UPDATE meetings SET recording_state = 'stopping' WHERE id = $1", [m.id]);
  try {
    await egress().stopEgress(m.recording_egress_id);
  } catch (err) {
    // Egress may already be gone (e.g. room closed): reset state so the host isn't stuck.
    await pool().query("UPDATE meetings SET recording_state = 'off', recording_egress_id = NULL WHERE id = $1", [m.id]);
    console.warn("[egress] stop failed", (err as Error).message);
  }
  await audit({ meetingId: m.id, action: "recording_stopped", actorUserId: actor.userId, actorSessionId: actor.sessionId });
  await publish({ meetingId: m.id, type: "recording_changed", audience: "all", data: { state: "stopping" } });
}

export async function startStream(m: Meeting, actor: Actor): Promise<Artifact> {
  const plan = await planForMeeting(m);
  if (!plan.hlsStreaming) throw new HttpError(402, "plan_required", "Large-audience streaming is available on paid plans.");
  const mode = requireStorage();
  const claimed = await pool().query("UPDATE meetings SET stream_state = 'starting' WHERE id = $1 AND stream_state = 'off'", [m.id]);
  if (!claimed.rowCount) throw conflict("A stream is already running.", "already_streaming");
  const id = randomUUID();
  const prefix = streamPrefix(m.id, id);
  try {
    await pool().query(
      `INSERT INTO meeting_artifacts (id, meeting_id, type, storage_key, storage, status, consent_state, retention_until)
       VALUES ($1, $2, 'stream', $3, $4, 'pending', 'requested', $5)`,
      [id, m.id, prefix, mode, await retentionFor(m)],
    );
    const output = new SegmentedFileOutput({
      protocol: SegmentedFileProtocol.HLS_PROTOCOL,
      filenamePrefix: egressPath(`${prefix}/seg`),
      playlistName: "index.m3u8",
      livePlaylistName: "live.m3u8",
      segmentDuration: 4,
    });
    const s3 = egressS3Upload();
    if (s3) output.output = { case: "s3", value: s3 };
    // Speaker layout: presenters fill the frame; the audience never publishes.
    const info = await egress().startRoomCompositeEgress(roomName(m), { segments: output }, { layout: "speaker", encodingOptions: EncodingOptionsPreset.H264_720P_30 });
    await pool().query("UPDATE meeting_artifacts SET egress_id = $2, status = 'processing' WHERE id = $1", [id, info.egressId]);
    await pool().query("UPDATE meetings SET stream_egress_id = $2, stream_artifact_id = $3 WHERE id = $1", [m.id, info.egressId, id]);
  } catch (err) {
    await pool().query("UPDATE meetings SET stream_state = 'off', stream_egress_id = NULL, stream_artifact_id = NULL WHERE id = $1", [m.id]);
    await pool().query("UPDATE meeting_artifacts SET status = 'failed', error = $2 WHERE id = $1", [id, (err as Error).message.slice(0, 300)]);
    throw new HttpError(502, "egress_failed", `Couldn't start the stream: ${(err as Error).message}`);
  }
  await audit({ meetingId: m.id, action: "stream_started", actorUserId: actor.userId, actorSessionId: actor.sessionId, targetId: id });
  await publish({ meetingId: m.id, type: "stream_changed", audience: "all", data: { state: "starting" } });
  return (await one<Artifact>("SELECT * FROM meeting_artifacts WHERE id = $1", [id]))!;
}

export async function stopStream(m: Meeting, actor: Actor): Promise<void> {
  if (!m.stream_egress_id || m.stream_state === "off") throw conflict("No stream is running.", "not_streaming");
  await pool().query("UPDATE meetings SET stream_state = 'stopping' WHERE id = $1", [m.id]);
  try {
    await egress().stopEgress(m.stream_egress_id);
  } catch (err) {
    await pool().query("UPDATE meetings SET stream_state = 'off', stream_egress_id = NULL WHERE id = $1", [m.id]);
    console.warn("[egress] stop failed", (err as Error).message);
  }
  await audit({ meetingId: m.id, action: "stream_stopped", actorUserId: actor.userId, actorSessionId: actor.sessionId });
  await publish({ meetingId: m.id, type: "stream_changed", audience: "all", data: { state: "stopping" } });
}

/** Applies an Egress lifecycle update from the LiveKit webhook. Idempotent. */
export async function handleEgressUpdate(info: EgressInfo): Promise<void> {
  const art = await one<Artifact>("SELECT * FROM meeting_artifacts WHERE egress_id = $1", [info.egressId]);
  if (!art) return;
  const m = await getMeetingById(art.meeting_id);
  if (!m) return;
  const isStream = art.type === "stream";
  const stateCol = isStream ? "stream_state" : "recording_state";
  const egressCol = isStream ? "stream_egress_id" : "recording_egress_id";
  const event = isStream ? "stream_changed" : "recording_changed";

  if (info.status === EgressStatus.EGRESS_ACTIVE) {
    await pool().query(`UPDATE meetings SET ${stateCol} = 'active' WHERE id = $1 AND ${egressCol} = $2`, [m.id, info.egressId]);
    await publish({ meetingId: m.id, type: event, audience: "all", data: { state: "active" } });
    if (isStream) await emitWebhook(m, "stream.started", { artifactId: art.id });
    return;
  }

  const done = [EgressStatus.EGRESS_COMPLETE, EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED, EgressStatus.EGRESS_LIMIT_REACHED];
  if (!done.includes(info.status)) return;
  if (art.status === "ready" || art.status === "failed") return;

  const ok = info.status === EgressStatus.EGRESS_COMPLETE || info.status === EgressStatus.EGRESS_LIMIT_REACHED;
  const file = info.fileResults?.[0];
  const seg = info.segmentResults?.[0];
  const durationMs = Number((file?.duration ?? seg?.duration ?? BigInt(0)) / BigInt(1_000_000));
  const size = Number(file?.size ?? seg?.size ?? BigInt(0));
  await pool().query(
    `UPDATE meeting_artifacts SET status = $2, size_bytes = $3, duration_ms = $4, error = $5, ended_at = now() WHERE id = $1`,
    [art.id, ok && (file || seg) ? "ready" : "failed", size || null, durationMs || null, ok ? null : (info.error || "Egress failed").slice(0, 300)],
  );
  await pool().query(
    `UPDATE meetings SET ${stateCol} = 'off', ${egressCol} = NULL ${isStream ? ", stream_artifact_id = NULL" : ""} WHERE id = $1 AND ${egressCol} = $2`,
    [m.id, info.egressId],
  );
  const minutes = Math.ceil(durationMs / 60000);
  if (minutes > 0) {
    await recordUsage({ kind: isStream ? "stream_minutes" : "recording_minutes", quantity: minutes, hostUserId: m.host_user_id, orgId: m.org_id, meetingId: m.id });
  }
  await publish({ meetingId: m.id, type: event, audience: "all", data: { state: "off" } });
  if (ok) await emitWebhook(m, isStream ? "stream.ended" : "recording.ready", { artifactId: art.id, durationMs });
}

export async function listArtifacts(meetingId: string): Promise<Artifact[]> {
  return query<Artifact>(
    "SELECT * FROM meeting_artifacts WHERE meeting_id = $1 AND type IN ('recording', 'stream') AND status <> 'deleted' ORDER BY created_at DESC",
    [meetingId],
  );
}

export function recordingConfigured(): boolean {
  return storageMode() !== null;
}
