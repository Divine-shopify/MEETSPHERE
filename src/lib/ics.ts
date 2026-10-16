import type { Meeting } from "./meetings";

const RRULE: Record<string, string | null> = {
  none: null,
  daily: "FREQ=DAILY",
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekly: "FREQ=WEEKLY",
  biweekly: "FREQ=WEEKLY;INTERVAL=2",
  monthly: "FREQ=MONTHLY",
};

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 text escaping. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets must be folded. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function meetingIcs(m: Meeting, opts: { link: string; hostName: string; dialIn?: string | null }): string {
  const start = m.scheduled_at ? new Date(m.scheduled_at) : new Date();
  const end = new Date(start.getTime() + m.duration_minutes * 60000);
  const host = new URL(opts.link).host;
  const description = [
    `Join: ${opts.link}`,
    opts.dialIn ? `Dial in: ${opts.dialIn}` : null,
    `Hosted by ${opts.hostName} on MeetSphere.`,
  ]
    .filter(Boolean)
    .join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MeetSphere//Meetings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${m.id}@${host}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    RRULE[m.recurrence] ? `RRULE:${RRULE[m.recurrence]}` : null,
    `SUMMARY:${esc(m.title)}`,
    `DESCRIPTION:${esc(description)}`,
    `URL:${opts.link}`,
    `LOCATION:${esc(opts.link)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean) as string[];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function googleCalendarUrl(m: Meeting, link: string): string {
  const start = m.scheduled_at ? new Date(m.scheduled_at) : new Date();
  const end = new Date(start.getTime() + m.duration_minutes * 60000);
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: m.title,
    dates: `${stamp(start)}/${stamp(end)}`,
    details: `Join: ${link}`,
    location: link,
  });
  if (RRULE[m.recurrence]) p.set("recur", `RRULE:${RRULE[m.recurrence]}`);
  return `https://calendar.google.com/calendar/render?${p}`;
}
