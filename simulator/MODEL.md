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

PixiJS consumes frozen snapshots and never advances the model. Movement is illustrative: up to 200 pooled markers represent sampled transport events, stretched to a 400 ms visual journey. Their positions and counts are not latency or throughput measurements. CPU queueing, execution, sleep and Redis queueing/execution use separate exact text counts rather than indistinguishable local trips. The request console records actual simulated timestamps and attempt/operation identities, including detached Redis commits. Canvas selection has an equivalent native component selector and buttons. State names, queue counts, and the text summary supplement colors. Reduced motion removes moving markers while preserving the model and controls.

### Following one request

Free-running exploration is the default. Console Inspect/Latest request or selecting
a flow marker enables Follow request. Previous event, Next event, the event list and
Latest event provide native keyboard controls. A fixed historical cursor stays on
its event as new records arrive; Latest event follows the newest retained record.
Stop following removes the reserved scene path without changing the experiment.

The selected request has a separate static path and amber event-component outline,
outside the 200-marker pool, also present with reduced motion. Its background markers
are suppressed to avoid overlapping animated interpretations. Path edges accumulate
only through the inspected event and do not encode travel duration. Inspection does
not pan the camera automatically; Inspect event component selects its available
current component, and Focus selected is an explicit navigation action.

Every event detail says **historical**, displays its absolute and request-relative
timestamp, and shows current system time separately. Current pressure is never
rewound: no historical queue snapshot is implied. Backend counters/labels distinguish
CPU queued, CPU active, sleeping and Redis-waiting requests. Redis shows queued,
executing and in-transport operations; transport combines outbound commands and
returning replies. Detached is a subset across those phases, not another additive
phase. All displayed occupancy counts are exact; background markers remain sampled.
Metric buttons link to their component and cohort/count explanation.
Map labels omit zero occupancy details to keep idle/stopped labels compact; their
accessible names, the Inspector and trace detail retain all exact current counts.

Events preserve request, attempt, operation and originating backend/incarnation;
Redis commands preserve command kind and the result of each INCR. An interleaved
later update cannot replace an earlier operation's result. PUBLISH execution is
distinct from INCR updating in memory, disk durability and browser delivery. Client
termination does not erase accepted Redis work: a trace can record a later command
execution after its client failed. Retries retain the same offered request identity.

One selected trace remains pinned beyond the recent 100-request buffer. Each trace
keeps its first 64 events and reports any later omitted-event count. Unretained
requests explicitly report unavailable history; the view does not reconstruct it.
An old process is not highlighted on a restarted or removed backend: its recorded
identity remains visible with a location warning. Redis-side evidence can still be
shown at Redis. All navigation/projection is observational and excluded from the
command log, scheduler and random stream.

The view fills the viewport. A shared DOM layout measures the header, workload,
playback and active panel rectangles, then fits the actual component/path bounds
into an unobscured scene rectangle. Opening a secondary panel collapses the previous
one; it does not change the selected component or its controls. The experiment can
be collapsed and reopened through Details without restarting it. Resizing and
opening panels never advance or reset the model.

Component labels are native buttons with a 12 CSS-pixel minimum for names and
state text. A followed event has first priority, then selection and stopped/queueing/draining
components; other labels show names and use a 22% scene-area budget. Priority labels
can relocate into nearby free space, with connector lines for distant placement.
The selected building's footprint is reserved against all label placement.
Secondary labels that cannot be placed without overlap are omitted rather than shrunk, and every
component remains available through Inspect component. Selected labels include
state and queue/in-flight details. The label layout measures actual text boxes.

At widths up to 1024 px, one compact panel leaves at least half the viewport area
available for ordinary phone/tablet exploration, including short landscape screens
with a side column. Desktop Console/Compare use a bounded bottom sheet. Read details opens an explicit
reading view with Return to map; expanded workload settings similarly provide a
Return to map action. Escape also leaves an expanded reading view. Inner scrolling
keeps controls reachable; opening or closing reading views preserves playback and
settings. The optional console exposes topology, failures, replica distribution,
counters and traces without relying on canvas interpretation. Hiding the tab pauses
the model. Reset clears queues/counters and recreates the run's initial recipe;
Run current settings starts a fresh run from applied controls. A saved comparison
baseline survives either reset until explicitly cleared or the page reloads.

All buildings, paths, and markers are original procedural geometry. System fonts require no remote font request. PGSimCity informed the scene-first layout and contextual inspection approach; no game assets, branding, or source were copied. The build includes dependency licenses in `notices.txt`.

### Map navigation

Scale/translation, active pointers and focus animation are presentation state. They
never enter the engine, command history or workload RNG. Navigation works while
paused. Primary/middle drag crosses a 5 CSS-pixel threshold; a drag or any two-finger
gesture suppresses associated selections. The map captures pointers and clears them
on release, cancellation, lost capture, blur and disposal. Extra contacts are ignored
instead of replacing either pinch contact. Panels own gestures that start on them.

Wheel deltas use pixels, 16 pixels per line, or the scene height per page. Each event
is capped at ±120 pixels before exponential scaling, avoiding a large single jump.
Ctrl/Cmd wheel remains browser-owned. Inputs convert client coordinates to local CSS
pixels without multiplying by device pixel ratio. Cursor/pinch world anchors are
preserved to floating-point precision in the geometry tests (browser interpretation
allows 1 CSS pixel), except when a scale or translation bound applies. Zoom buttons
use the measured unobscured scene center.

Zoom is limited to 0.75–4× the current topology's fit scale. Smaller maps center in
the available area; larger maps allow bounded exploration. At least one component
center stays 32 CSS pixels inside the scene (or a quarter of a very small scene).
Manual framing preserves the world point beneath the old scene center through a
resize/panel change, adjusted for necessary scale/translation bounds. Topology
changes use the same rule; overview mode instead refits all active components.
Only components intersecting the visible scene receive labels; Inspect component
and Focus selected recover any offscreen selection. Visible text remains 12 px.

Focus selected frames the inspected component with a 160 ms presentation transition.
Direct input interrupts it at its current position; reduced motion applies it
immediately. Fit map/Home returns to overview. Keyboard arrows and +/− are scoped
to the native map-navigation region, leaving form keys and browser shortcuts alone.
Rendering is coalesced to at most one update per input frame, reusing scene objects.

The viewport exposes save/restore operations for #52's later component interiors;
restoration preserves the prior campus framing, subject to changed bounds. The
current UI only has the campus. S2 must call these operations on entry/Back and make
Fit map/Home exit its interior. No interior navigation is claimed in this slice.

## Performance evidence

On an Apple M5 Pro (macOS arm64, Node 22.23.1), the optional 15-minute model benchmark offered 450,009 requests at 500/s with eight replicas. It alternated default Redis service, extreme Redis execution/transport delays, and 100% ten-second slow requests. The run took 8.92 seconds of wall time, with 1.89 ms p95 for snapshot creation plus metrics. Peak retained state was 2,048 requests, 2,048 operations, 600 events, 100 traces, 4,108 scheduled events, and 4,093 rolling completions. All pending requests and operations drained after arrivals stopped. This is a model/runtime check on one machine, not a claim about real NGINX or Redis capacity or all devices.
