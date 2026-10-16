# Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Audio/video is not configured on this server" | `LIVEKIT_*` env vars missing | Set all three and restart |
| Room shows "Connecting…" forever | Browser can't reach LiveKit (wrong `LIVEKIT_URL`, `ws://` from an `https://` page, firewall blocking UDP) | Use `wss://` in production; open LiveKit's UDP range or enable TURN/TLS on 443 |
| Camera/mic error "permission was blocked" | User denied permission, or page not on HTTPS | Allow in site settings; serve over HTTPS (localhost is exempt) |
| "No camera or microphone was found" / "in use by another app" | Hardware missing or held by Zoom/Teams | Close other apps, or join with camera/mic off |
| "Phone/Email verification is not configured" | No Twilio/Resend credentials and not in dev mode | Configure the provider, or for local dev set `VERIFICATION_DEV_MODE=true` |
| Dev-mode codes don't appear in production | By design: dev mode is disabled when `NODE_ENV=production` | Configure a real provider |
| "Too many codes requested" | Rate limits (30 s per destination, 5/h per destination) | Wait; check for abuse in `usage_events` |
| SMS not arriving | Sender not registered for the destination country, geo-permissions, carrier filtering | Check Twilio logs; register sender (e.g. A2P 10DLC in the US) |
| Guest stuck "Waiting for the host" | Host hasn't opened the meeting or the host panel | Host sees "N waiting" on the Host button in the room, or uses Manage |
| Guest says "The host declined your request" after host changed mind | Decisions stick to the browser session | Host clicks "Let back in" under "Declined or removed" in the room's host panel; the guest's page updates on its own |
| Removed person reconnects | Webhook not configured and their client reconnected within the token TTL | Configure the LiveKit webhook (see DEPLOYMENT.md). Kicks also revoke prior tokens |
| `APP_SECRET must be set` on start | Production requires a 32+ char secret | Set `APP_SECRET` |
| Tests fail with `ECONNREFUSED 5432` | No test database | `createdb meetsphere_test`, set `TEST_DATABASE_URL` |
| `CREATE EXTENSION pgcrypto` permission error | Managed Postgres without superuser | Enable pgcrypto in the provider console (it's allow-listed on most) |
