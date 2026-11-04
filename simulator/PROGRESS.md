# Simulator delivery evidence

Goal: complete issues #15–#20 and the confirmed campus, controls, four experiments, and saved-baseline comparison. Work branch: `codex/simulator-milestone`. The Go and deployment stacks remain independent.

## Pass 1 — workspace and timing

Added Vite/TypeScript, exact dependency lockfile, integer event scheduler, seeded workload streams, bounded configuration, and fixed-step playback. Validation covers sub-tick service timing, equal-time priorities, arbitrary cancellation, bounded scheduler storage, pause/speed/frame cadence, and configuration errors. Remaining issue #15 work: cluster resources, failures, immutable snapshots, and model contract tests.

## Remaining delivery gates

- #15: model semantics and repeatable tests.
- #16: PixiJS isometric campus, inspection, lifecycle visuals, measured performance.
- #17: reproducible operational controls and interaction matrix.
- #18: defined metrics, all four scenarios, matched-workload baseline comparison.
- #19: nonvisual interface, responsive/reduced-motion verification, accuracy and assets.
- #20: isolated CI/Pages build, publication eligibility, live smoke, README screenshot/link.

Live tracker checked 5 November 2026: all six issues open. Repository is private; Pages is not enabled. No visibility change has been made.

## Pass 2 — cluster resources and failure boundaries

Implemented root/slow request paths, round-robin routing, CPU queues, independent sleeps, Redis FIFO execution/transport, bounded admissions, passive failure knowledge, three total proxy attempts, coordinated drain/removal, process restart, and frozen snapshots. Redis accepted work remains alive when its caller disappears. Commands are recorded at tick boundaries.

Validation: `npm test` passes **32 tests**; `npm run build` passes type checking and production bundling. Tests include healthy distribution and counters, overload and scaling, CPU/transport separation, capacity changes in flight, all-down/single-upstream behavior, HTTP 500 without retry, drained routing withdrawal, repeated removal, replay equality, independent offered streams, sustained overload bounds, exact commit/deadline ordering, post-commit retry, retained replies, detached operations, and the 12 s drain budget. The drain-routing regression found during this pass is fixed and covered.

Issue #15 still needs its final acceptance audit alongside playback/reset integration; no issue has been closed yet. Initial build contains a placeholder page until the campus pass.

## Product correction — full-screen simulation

The user rejected the first scrolling dashboard preview (“Systems campus”) as generic. Current direction supersedes that presentation: the simulation occupies the whole viewport; compact instruments, traffic controls, contextual inspectors, and a bottom transport bar sit over it. No marketing header or card grid. Charts and traces live in an optional console. The light isometric model and agreed operational scope remain.

PGSimCity was rechecked at `ec4217c2534437be11d3dbe9797dbc9be7c354ef` (current main on 5 November). Inspected its live scene, `src/styles/hud.css`, `src/styles/tokens.css`, and inspector behavior in `src/ui/panel.ts`. Applied the structural lessons: scene-first composition, compact stable-width numerical instruments, restrained typography, and contextual panels. Our Pixi geometry is original: clients are terminals, NGINX is a dispatch gateway, backends are server racks, Redis is shared storage. No PGSimCity source or visual assets were copied.

## Pass 3 — initial live view and controls (in progress)

A local preview runs at `http://127.0.0.1:5173/docker-based-multiserver-system/`. Implemented PixiJS read-only rendering with a 200-marker pool, native component inspection, traffic/capacity/failure/drain/Redis controls, pause/speed/step/reset, optional introduction, reduced-motion switch, and metrics/trace console. Metrics use client completions, nearest-rank p95, exact queue/busy-time integrals, and explicit pending/oldest-age values. One selected trace survives the rolling history buffer. Chart history is bounded to 301 points; rolling metrics retain only small cumulative boundaries.

Current automated validation: **38 tests pass**, production build/type checking pass. Browser checks found and fixed a first-frame negative elapsed-time bug. Verified traffic and scale changes queue while paused, one step applies them, component inspection works, and stop/retry flow updates the view. The new full-screen composition has been visually inspected; full responsive/accessibility/performance checks are still outstanding. Scenarios and baseline comparison are not implemented yet. No simulator issues have been closed; no PR or deployment exists.
