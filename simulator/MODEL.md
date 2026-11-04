# Multiserver educational model

This browser-only model teaches mechanisms in the NGINX → Go replicas → Redis architecture. Its capacities are synthetic teaching values, not benchmark measurements. It is neither an emulator nor a production monitor. No visitor request reaches Docker, Redis, or a backend service.

## Time and reproducibility

The model uses integer microseconds and 20 ms outer ticks. Events within a tick execute at their actual scheduled times. At equal timestamps, operator commands run before service completion/delivery, then deadlines, then arrivals; insertion order breaks remaining ties. An acknowledgment delivered at its deadline wins. A crash scheduled at a commit timestamp wins over the commit.

The seeded integer hash uses separate streams keyed by logical request ID for arrival jitter and request type. Routing, retries, and rendering do not consume workload randomness. A stable seed and the same traffic recipe therefore preserve the offered stream across capacity changes.

Playback supports pause, resume, a single 20 ms step, and 0.25×–4× speed. Wall time only determines the number of steps consumed. A compute budget retains unprocessed steps rather than discarding model work. The browser will pause when hidden.

## Supported bounds

The configuration contract currently permits 1–8 replicas, 5–200 CPU work units/s per replica, 0–500 offered requests/s, 0–100% slow requests, and 0–10 s sleep. A root uses 1 CPU work unit; a slow request uses 0.1 plus independent sleep. Synthetic in-flight admission limits are configurable from 1–256 per backend (default 128). These are teaching abstractions, not Go worker-pool limits.

Redis defaults: 2 ms INCR execution, 1 ms PUBLISH execution, 4 ms network round trip. Execution costs range from 0.1–100 ms; network delay from 0–2000 ms. Network waits do not occupy the Redis execution resource. The default successful-root shared capacity bound is approximately 1 / (0.002 + 0.001) = 333 requests/s, conditional on successful publication and no other limiting resource.

Storage bounds: 2048 pending logical requests, separately 2048 accepted Redis operations, 600 recent semantic events, 100 recent request traces with at most 64 entries each, and 4096 recorded operator commands. One selected trace can be retained in addition to the rolling 100. Rejections at synthetic admission bounds remain visible in client outcomes; the workload generator never silently drops offered traffic.

## Deliberate boundaries

The capacity sandbox omits the real root per-IP rate limiter (10 requests/s plus burst). Only root and slow requests are modeled. Redis client internal retries, durable persistence, replication, Sentinel, real WebSocket delivery, Kubernetes scheduling, TLS, authentication, packet loss, and real network connections are outside this model. PUBLISH cost is included in root processing because the actual root handler performs it.

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

## Metrics and guided experiments

Live metrics use up to five seconds of simulated time; the actual window is displayed. Successful throughput counts successful logical requests. Error fraction is failed terminal requests divided by all terminal requests in the window. Retries do not create extra client completions. Mean and nearest-rank p95 latency use the same completed cohort, including failures; no completed samples means no latency or error fraction. Pending count and oldest pending age show work excluded from that cohort.

CPU utilization is busy processor time divided by configured processor-slot time, including stopped slots. Redis utilization counts execution time, excluding transport. Queue depth is runnable CPU work plus queued Redis commands; sleeping and dependency-waiting requests remain separately visible. Queue averages integrate depth over simulated time. The chart retains 301 samples at 200 ms intervals (one minute); manual stepping can shorten that visible span. Snapshot histories retain only cumulative metric boundaries. One explicitly selected trace is retained in addition to the 100 recent traces.

Each guided experiment has an initial configuration, a suggested intervention, and evidence predicates:

- Scaling first observes a CPU queue above 20, then requires at least three running backends, more than 110 successful requests/s, and fewer than 10 queued requests.
- Outage requires app2 stopped, at least one retry decision, retries enabled, no client failures, and more than 55 successful requests/s.
- Drain must first observe admitted work on a draining app2, then its withdrawn/stopped state with no in-flight requests, no client failures, and ongoing service above 20 requests/s.
- Redis first observes more than 60 queued commands and over 90% execution utilization. Recovery requires shorter command costs, more than 200 successful requests/s, and fewer than 20 queued Redis commands.

All completion predicates require at least four seconds of metric observations and 50 terminal samples, with the entire measured window after the relevant intervention state. Healthy traffic before an outage cannot satisfy the recovery observation. Completion records that the mechanism was observed; later interventions can still break the system. Tests include a positive reproducible run and an uncompleted counterexample for every experiment.

## One matched baseline

The first five seconds warm the model; the observation interval is `(5 s, 20 s]`. Saving before completion waits for the full recording. Saving later explicitly captures that first observation window, not the most recent screen. One baseline lives in memory and survives experiment resets; replacement/clearing is explicit, and reloading clears it.

Preparing a candidate recreates the baseline's clean initial configuration and schedules its common interventions at the same ticks. The candidate starts paused so the user can add an operating change. It pauses at 20 seconds. Settings and interventions are listed with before/after measurements. Seed, traffic recipe (including timed traffic changes), model version, and observation boundaries must match; offered-stream hashes provide an additional deterministic check. Rejected intervention targets make the run invalid. Mismatches produce an explanation instead of a numerical comparison.

Comparison uses every terminal latency sample in the observation window, the exact integrated average queue and busy-time deltas, the maximum observed 200 ms queue sample, pending/oldest age at the end, and local/global counter increments during the window. Increment totals can differ because work entered or committed on opposite sides of the warmup boundary. Utilization differences are percentage points. Empty cohorts remain empty. The fixed maximum workload, finite pending admission limit, and 15-second observation bound the recorded latency sample array.

## View and accessibility

PixiJS consumes frozen snapshots and never advances the model. Movement is illustrative: up to 200 pooled markers represent sampled semantic events, stretched to a 400 ms visual journey. Their positions and counts are not latency or throughput measurements. The request console records actual simulated timestamps and attempt/operation identities, including detached Redis commits. Canvas selection has an equivalent native component selector and buttons. State names, queue counts, and the text summary supplement colors. Reduced motion removes moving markers while preserving the model and controls.

The view fills the viewport. Desktop controls surround the scene; narrow layouts put traffic controls above it, with scrollable metric and inspector regions. The optional console exposes topology, failures, replica distribution, counters, and traces without relying on canvas interpretation. Hiding the tab pauses the model. Reset clears queues/counters and recreates the run's initial recipe; Run current settings starts a fresh run from the applied controls. A saved comparison baseline survives either reset until explicitly cleared or the page reloads.

All buildings, paths, and markers are original procedural geometry. System fonts require no remote font request. PGSimCity informed the scene-first layout and contextual inspection approach; no game assets, branding, or source were copied. The build includes dependency licenses in `notices.txt`.

## Performance evidence

On an Apple M5 Pro (macOS arm64, Node 22.23.1), the optional 15-minute model benchmark offered 450,009 requests at 500/s with eight replicas. It alternated default Redis service, extreme Redis execution/transport delays, and 100% ten-second slow requests. The run took 8.92 seconds of wall time, with 1.89 ms p95 for snapshot creation plus metrics. Peak retained state was 2,048 requests, 2,048 operations, 600 events, 100 traces, 4,108 scheduled events, and 4,093 rolling completions. All pending requests and operations drained after arrivals stopped. This is a model/runtime check on one machine, not a claim about real NGINX or Redis capacity or all devices.
