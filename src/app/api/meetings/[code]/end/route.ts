import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { allRooms, deleteRoom } from "@/lib/media";
import { endMeeting, hostView } from "@/lib/meetings";
import { stopRecording, stopStream } from "@/lib/recording";
import { emitWebhook } from "@/lib/webhooks";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const actor = { userId: user.id, sessionId: null };
  // Finalize recordings/streams first so their files are complete.
  if (meeting.recording_state !== "off") await stopRecording(meeting, actor).catch(() => {});
  if (meeting.stream_state !== "off") await stopStream(meeting, actor).catch(() => {});
  const ended = await endMeeting(meeting, user.id);
  // Deleting the rooms disconnects everyone, including breakout rooms and phone callers.
  for (const room of await allRooms(ended)) await deleteRoom(room);
  await emitWebhook(ended, "meeting.ended", {});
  return { meeting: hostView(ended) };
});
