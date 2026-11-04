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

## Implemented request and failure semantics

Each client request, proxy attempt, and Redis command has its own ID. Root requests increment local state on handler admission, perform 0.8 CPU units, send INCR, then PUBLISH, then perform 0.2 response CPU units. Slow requests perform 0.05 CPU units, sleep independently, then perform 0.05 response CPU units. Synthetic proxy connection and response travel take 1 ms each.

Backend CPU uses a FIFO runnable queue. Redis uses a separate FIFO execution queue. A capacity change accounts for CPU work already performed and reschedules the remaining work. Redis execution-cost changes affect the next command started; RTT changes affect newly sent commands. Reducing admission limits preserves admitted requests and only restricts new admissions.

NGINX routes round-robin, with at most three total attempts on distinct eligible upstreams. A refused connection, lost connection, or read timeout triggers passive exclusion for 10 seconds. The single-upstream exception ignores exclusion. Draining explicitly withdraws a backend from routing; it stays withdrawn when empty until restarted. HTTP 500 from failed INCR is terminal and is not retried. Synthetic model admission rejection is distinct from HTTP 503 and never triggers retries or passive exclusion.

The proxy's modeled 15 s read deadline spans the wait for the first response byte because modeled responses arrive as one unit. Black-holed connections, streaming response bodies, socket send timeouts, and partial client delivery are omitted. INCR has a **synthetic 3 s acknowledgment deadline**, an approximation of a single command wait, not the real client's complete retry/deadline behavior. PUBLISH uses the actual 500 ms handler deadline. Missing the PUBLISH deadline still yields HTTP 200. Accepted operations may execute after their acknowledgment deadline; unaccepted outbound operations are canceled when their caller leaves. A lost backend response can cause a retry and more than one global increment for one client request.

Redis interruption rejects new work, cancels uncommitted queued/executing work, retains committed data, and permits replies already in transit. This is not a persistence or power-loss model. Detached accepted Redis operations remain separately bounded and visible. Restart takes a synthetic 500 ms, creates a new process incarnation, and clears its local counter. Aggregate lifetime local-entry totals retain old incarnations for audit. Coordinated drain stops routing first and allows up to 12 s for admitted work before stopping. It is not an exact replay of Kubernetes propagation or Compose signals.

## Snapshot and command interface

`Engine.step()` advances one fixed tick; `runFor()` is a headless convenience in whole ticks. `command()` validates and records a typed action at a future tick (default: next tick). Commands can become invalid because an earlier action removed their target; these produce a visible `command-rejected` event. The bounded action log rejects additions when full rather than silently losing replay history.

`snapshot()` returns a deeply frozen, detached object containing configuration, process states, pending requests, cumulative counters, Redis work, the most recent five seconds of client completions, bounded traces/events, and recorded commands. No renderer or panel may mutate it. Only the core schedules events. Core files have no browser or PixiJS imports.

Request conservation is `offered = succeeded + failed + pending`. Backend attempts and detached Redis work are separate from that equation. Global state counts committed INCR operations, not successful responses. The model deliberately permits local/global/success counts to differ under failures.
