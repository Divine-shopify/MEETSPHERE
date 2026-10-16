import { forbidden } from "@/lib/errors";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { canViewReplay } from "@/lib/replay";
import { getTranscript, transcriptAsText, transcriptAsVtt } from "@/lib/transcripts";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  if (!(await canViewReplay(ctx, meeting))) throw forbidden("You don't have access to this transcript.");
  const rows = await getTranscript(meeting);
  const format = new URL(ctx.req.url).searchParams.get("format");
  if (format === "txt" || format === "vtt") {
    return new Response(format === "txt" ? transcriptAsText(rows) : transcriptAsVtt(rows), {
      headers: {
        "Content-Type": format === "txt" ? "text/plain; charset=utf-8" : "text/vtt; charset=utf-8",
        "Content-Disposition": `attachment; filename="${meeting.code}-transcript.${format}"`,
      },
    });
  }
  return { segments: rows };
});
