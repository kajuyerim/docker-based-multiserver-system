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
