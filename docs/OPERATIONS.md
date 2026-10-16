# Operations runbook

## Monitoring

- `GET /api/health` — 200 when the database is reachable; reports media and storage status. Use for load balancer checks.
- `GET /api/metrics` (Bearer `METRICS_TOKEN`) — Prometheus gauges: live meetings, media sessions, phone sessions, waiting requests, active recordings/streams, webhook backlog, open abuse reports, usage in the last hour.
- LiveKit and Egress expose their own Prometheus metrics; alert on node CPU > 80%, packet loss, and Egress "no available workers".

Suggested alerts: health non-200 for 2 min · webhook backlog > 500 · open abuse reports > 0 for 1 h · OTP sends in last hour > 3× normal · media sessions dropping to 0 during business hours.

## Routine

- Hourly: `POST /api/cron/cleanup` (sessions, OTP challenges, rate limits, retention, webhook retries). The compose stack runs it automatically.
- Daily: verify backups restore; review `/admin` abuse queue.
- Monthly: review top hosts by usage in `/admin` for abuse or upgrade candidates.

## Support playbook

| Request | Action |
| --- | --- |
| "I can't get in" | Ask for the meeting code. Host checks Manage → Safety (denials by reason) and the audit trail. Common causes: meeting locked, invited-only and wrong contact, blocked. |
| "No code arrived" | Check provider dashboards; rate limits (30 s per number, 5/hour). Offer email instead of SMS. |
| "Video freezes on my phone" | Switch to Low data or Audio only in the room; check UDP is allowed on the network (or enable TURN/TLS). |
| Enterprise contract | `/admin` → Set a plan manually (org slug → enterprise). |
| Data deletion request | The user can delete their own account under Account → Your data; otherwise delete via SQL `DELETE FROM users WHERE id = …` (cascades) after exporting with the same code path. |
| Abuse report | `/admin` → review, contact the host, mark reviewed/actioned. For illegal content, preserve the audit trail and recordings before retention deletes them. |

## Incident: unexpected join burst / "Zoom bombing"

1. Host: Lock (one click in the room, or Manage). Safety alert shows in the host panel automatically.
2. Switch policy to Invited only or Host approval; block offenders (blocks cover their device, verified contact and phone line).
3. For future sessions, create a new meeting link.
