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
| Only ~50 people can join a room | UDP port range too small (≈2 ports per participant) | Widen `rtc.port_range_*` in livekit.yaml and the firewall |
| "Couldn't start recording" / Egress timed out | No free Egress worker (each job ≈2 vCPU) | Add Egress capacity; stop finished recordings/streams |
| Egress records a black or empty file | Egress Chrome can't reach LiveKit (only loopback ICE candidates) | Set `rtc.node_ip` / `use_external_ip` so candidates are reachable from the Egress container |
| Live stream page says "This browser can't play the stream" | Browser without H.264 (some Linux Chromium builds) | Use Chrome, Edge, Safari or Firefox |
| Live stream starts ~10–20 s behind | HLS buffering (4 s segments × 3) | Expected; interactive viewers should join the WebRTC room instead |
| Captions don't appear for someone | They declined consent, their mic is off, or their browser lacks speech recognition (e.g. Firefox) | Expected; others still see captions |
| SSO says "sign-in link expired" | The flow was started in another browser/tab or took > 10 min | Start again from the same browser |
| SSO "email domain isn't allowed" | IdP account email isn't in the configured domains | Add the domain under Organization → Single sign-on |
| Webhook endpoint rejected as "private network address" | URL resolves to a private IP | Use a public URL (or `ALLOW_PRIVATE_OUTBOUND=true` in development only) |
| Stripe upgrade paid but plan didn't change | Webhook not reaching the app or wrong secret | Check Stripe → Webhooks delivery logs; `STRIPE_WEBHOOK_SECRET` |
| "This host has used this month's free participant-minutes" | Fair-use cap on the free plan | Upgrade or raise `FREE_MONTHLY_PARTICIPANT_MINUTES`; running meetings are unaffected |
| Real-time updates stop behind a proxy | Proxy buffers or times out `text/event-stream` | Disable buffering for `/api/meetings/*/events`; the UI falls back to slow polling |
