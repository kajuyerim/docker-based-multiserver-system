# Multiserver educational model

This browser-only model teaches mechanisms in the NGINX → Go replicas → Redis architecture. Its capacities are synthetic teaching values, not benchmark measurements. It is neither an emulator nor a production monitor. Implementation is in progress; this document grows with each verified phase.

## Time and reproducibility

The model uses integer microseconds and 20 ms outer ticks. Events within a tick execute at their actual scheduled times. At equal timestamps, operator commands run before service completion/delivery, then deadlines, then arrivals; insertion order breaks remaining ties. An acknowledgment delivered at its deadline wins. A crash scheduled at a commit timestamp wins over the commit.

The seeded integer hash uses separate streams keyed by logical request ID for arrival jitter and request type. Routing, retries, and rendering do not consume workload randomness. A stable seed and the same traffic recipe therefore preserve the offered stream across capacity changes.

Playback supports pause, resume, a single 20 ms step, and 0.25×–4× speed. Wall time only determines the number of steps consumed. A compute budget retains unprocessed steps rather than discarding model work. The browser will pause when hidden.

## Proposed supported bounds

The configuration contract currently permits 1–8 replicas, 5–200 CPU work units/s per replica, 0–500 offered requests/s, 0–100% slow requests, and 0–10 s sleep. A root uses 1 CPU work unit; a slow request uses 0.1 plus independent sleep. Synthetic in-flight admission limits are configurable from 1–256 per backend (default 128). These are teaching abstractions, not Go worker-pool limits.

Redis defaults: 2 ms INCR execution, 1 ms PUBLISH execution, 4 ms network round trip. Execution costs range from 0.1–100 ms; network delay from 0–2000 ms. Network waits do not occupy the Redis execution resource. The default successful-root shared capacity bound is approximately 1 / (0.002 + 0.001) = 333 requests/s, conditional on successful publication and no other limiting resource.

Storage bounds: 2048 pending logical requests, separately 2048 accepted Redis operations, 600 recent semantic events, 100 recent request traces with at most 64 entries each, and 4096 recorded operator commands. Final supported browser limits require measurement in the visualization phase.

## Deliberate boundaries

The capacity sandbox omits the real root per-IP rate limiter (10 requests/s plus burst). Only root and slow requests are planned. Redis client internal retries, durable persistence, replication, Sentinel, real WebSocket delivery, Kubernetes scheduling, TLS, authentication, packet loss, and real network connections are outside this model. PUBLISH cost is included in root processing because the actual root handler performs it.

Source contracts: [root and slow handlers](../app/server.go), [NGINX](../nginx/default.conf), [shutdown](../app/main.go). The detailed [design](../docs/plans/simulator-design.md) distinguishes confirmed product choices from implementation proposals.
