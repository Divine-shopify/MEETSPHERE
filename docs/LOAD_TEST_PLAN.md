# Load-test plan

First results on a single 4-vCPU box: [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md).

No capacity number may be advertised until the relevant scenario below has
passed on the production configuration (same region, same LiveKit plan/nodes).

## Tools

- LiveKit `lk load-test` (simulated publishers/subscribers against a room).
- Headless Chromium fleet (`tests/e2e/smoke.mjs` as a template) for realistic join + admission flow.
- k6 or autocannon against the HTTP API (join, poll, token endpoints).
- Network shaping: `tc netem` or Chromium's network emulation (3G/4G profiles, 1–5% loss).

## Scenarios and pass criteria

| # | Scenario | Load | Network | Pass if |
| --- | --- | --- | --- | --- |
| 1 | Small interactive meeting | 10 publishers (720p cam + mic), 10 subscribers | 4G, 1% loss | p95 glass-to-glass latency < 400 ms; < 2% frozen-video time; join < 5 s |
| 2 | Class | 1 presenter + screen share, 49 participants (camera off, mic muted) | mixed 3G/4G | Presenter video ≥ 360p for 95% of viewers; audio MOS ≥ 3.5 |
| 3 | Plan cap | `FREE_MAX_PARTICIPANTS` + 5 joiners | lab | Exactly the cap connect; the rest get a clear "room full" error |
| 4 | Join burst | 300 join requests in 60 s to one meeting | lab | API p95 < 300 ms; no 5xx; per-meeting limit returns 429 cleanly; host panel stays responsive |
| 5 | OTP abuse | 1,000 OTP starts from 50 IPs to random numbers | lab, provider in test mode | ≤ allowed sends delivered; spend stays within daily cap |
| 6 | Reconnect | 20 participants, drop network 5–20 s | lab | ≥ 95% resume without re-admission; no duplicate participants |
| 7 | Presentation (current SFU path) | 5 speakers, N subscribe-only viewers, step N = 50, 100, 200 | 4G | Find the N where scenario 1 criteria break; publish limit at 70% of that |
| 8 | HLS live stream + CDN | 2 presenters, 1k → 10k viewers via HLS/CDN | mixed | Viewer latency < 10 s (HLS) or < 2 s (WebRTC fan-out), < 1% rebuffer |

## What to record per run

Concurrent publishers/subscribers, CPU/memory/bandwidth per LiveKit node,
packet loss/jitter/RTT from client stats, API latency percentiles, DB CPU and
connections, error rates, cost per participant-minute observed.

## Known bottlenecks to watch

- Server-sent events: each connected browser holds one HTTP connection to an app instance; plan ~10k per instance and scale horizontally.
- Single Postgres; rate-limit writes on every OTP/join.
- One LiveKit room per meeting on a single node until LiveKit is deployed multi-node.
