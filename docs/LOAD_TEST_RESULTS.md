# Load-test results

Measured with `lk load-test` (LiveKit CLI 2.12.9) against LiveKit server 1.10.1.

**Setup and its limits:** one 4-vCPU / 16 GB Linux VM ran *everything* — the
LiveKit server, the load generator (which simulates every publisher and
subscriber, including encoding/decoding), Postgres, the app and an idle Egress
worker. Loopback networking, so no real-world loss, jitter or bandwidth caps.
These numbers show the server handles the load with headroom; they are **not**
a capacity claim for production. Re-run on your production topology per
[LOAD_TEST_PLAN.md](LOAD_TEST_PLAN.md) before advertising any limit.

| Scenario | Publishers | Subscribers | Layout | Tracks delivered | Aggregate bitrate | Packet loss | LiveKit CPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Interactive | 10 (medium video) | 10 | speaker (6 visible) | 60 / 60 expected | 13.0 Mbps | 0% | — |
| Interactive | 20 | 20 | speaker (6 visible) | 120 / 120 expected | 24.9 Mbps | 0% | ~37% of 1 core |
| Gallery (worst case) | 20 | 20 | 5×5 (all visible) | 400 / 400 | 63.5 Mbps | 0% | ~32% of 1 core |
| Presentation | 2 | 200 | speaker | 400 / 400 | 105.5 Mbps | 0% | ~46% of 1 core |

"Tracks delivered" counts what subscribers actually received; the speaker
layout subscribes to 6 tiles at a time (adaptive stream), as the real UI does.

## Lesson learned: UDP port range

The first presentation runs stalled at ~49 connected viewers. The cause was the
test server's ICE port range (100 UDP ports; each participant uses roughly two).
`deploy/livekit.yaml` opens 50000–60000. **Size the range and firewall for at
least 2× your peak participants per node.**

## Larger events

Beyond what one SFU node handles, use the HLS live stream (presentation mode →
"Go live"): viewers fetch segments from storage/CDN and the SFU only carries
the presenters. HLS delivery scale is then a CDN question, not a media-server
one. Not load-tested here: thousands of HLS viewers, multi-node LiveKit, real
mobile networks (scenarios 4–8 in the plan).
