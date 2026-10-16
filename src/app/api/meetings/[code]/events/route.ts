import { canReceive, subscribe, type MeetingEvent } from "@/lib/events";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { enforce } from "@/lib/ratelimit";
import { viewerFor } from "@/lib/viewer";

type P = { code: string };

export const dynamic = "force-dynamic";

/**
 * Server-sent events for one meeting. Waiting guests receive updates about
 * their own request; participants receive meeting-wide events; moderators
 * receive everything. Events carry small payloads, clients refetch details.
 */
export const GET = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  const v = await viewerFor(ctx, meeting);
  const ownKey = v.key ?? (v.request ? `jr:${v.request.id}` : null);
  const participant = v.kind !== "none";
  await enforce(`sse:${v.session?.id ?? ctx.ip()}`, 120, 600);

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send(`retry: 3000\n: connected\n\n`);
      const unsubscribe = await subscribe(meeting.id, (e: MeetingEvent) => {
        // People who aren't in the meeting only hear about their own request.
        if (!participant && e.audience !== `jr:${v.request?.id}`) return;
        if (!canReceive(e.audience, { moderator: v.moderator, key: ownKey })) return;
        send(`event: ${e.type}\ndata: ${JSON.stringify(e.data ?? {})}\n\n`);
      });
      const heartbeat = setInterval(() => send(`: ping\n\n`), 25000);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      ctx.req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
