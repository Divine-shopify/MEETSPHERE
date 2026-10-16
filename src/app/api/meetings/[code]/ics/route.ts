import { config } from "@/lib/config";
import { one } from "@/lib/db";
import { route } from "@/lib/http";
import { meetingIcs } from "@/lib/ics";
import { requireMeeting } from "@/lib/meetings";

type P = { code: string };

// Contains only what the link already reveals: title, time, link, host name.
export const GET = route<P>(async (_ctx, { code }) => {
  const m = await requireMeeting(code);
  const host = await one<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [m.host_user_id]);
  const dialIn = m.dialin_enabled && m.dialin_pin && process.env.DIALIN_NUMBER ? `${process.env.DIALIN_NUMBER}, PIN ${m.dialin_pin}#` : null;
  const body = meetingIcs(m, { link: `${config.baseUrl}/m/${m.code}`, hostName: host?.display_name ?? "Host", dialIn });
  return new Response(body, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="${m.code}.ics"` },
  });
});
