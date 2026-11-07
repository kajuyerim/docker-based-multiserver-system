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

Latest status: implementation and local acceptance for #15–#19 are complete. PR #43 passed simulator and full repository CI on `26bea2f`. The user explicitly approved public hosting and then publication of the whole repository. The repository is now public and Pages is enabled with the GitHub Actions source. Release documentation checks, merge, deployment, live verification, and #20 closure remain.

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

## Pass 4 — guided experiments and baseline comparison

Implemented all four experiments with observation-based completion and negative cases. Revisited PGSimCity's `src/sim/scenarios.ts`: each lesson starts from a specific configuration and explains the current mechanism. Our lessons use state predicates rather than timed narration as completion evidence.

Implemented one session baseline, a fixed 5–20 s measurement window after warmup, replayed common interventions (including later-created backend targets), candidate pause at 20 s, explicit changed settings/actions, cohort counts, and mismatch rejection. Baseline survives reset; replacing/clearing it is explicit. Invalid actions are now recorded in the command log so comparisons cannot silently ignore a failed intervention.

Browser evidence: scaling recovered to roughly 120 successful requests/s and zero queue after adding two backends; its scenario displayed Verified. Saved a baseline with 1,922 completed samples and two scale-out interventions. An unchanged 4× candidate reproduced every displayed measurement with zero deltas and paused at exactly 20.00 s. A candidate changing 120→121 offered requests/s was explicitly rejected as incomparable and showed the added 0.02 s traffic intervention. Fixed feedback that incorrectly reported catch-up after comparison auto-pause.

Automated validation: **56 tests and production build passed**, including the regression for a gap in a zero-traffic recording. Still outstanding: all-scenario browser matrix, complete accessibility/responsive and maximum-load performance audit, source/asset/model documentation audit, isolated CI/Pages deployment and live checks, PR/review/merge, issue closure.

## Pass 5 — scene, independent review, and acceptance

Rechecked PGSimCity's `src/styles/labels.css` for readable world labels. Component names and states now sit on compact opaque labels, with stronger building/path contrast. State text remains visible at eight backends; flow markers render beneath buildings and labels. Narrow layouts place the two traffic controls above the scene. Checked 1280×720 desktop, the app's 701×853 viewport, and a 390×844 narrow viewport. No page-width overflow; narrow metrics and inspector content scroll within their own regions.

Browser interaction evidence: native inspection and keyboard Enter operated pause, stop, restart, and one 20 ms step. Closing the inspector returned focus to its opener. Reduced motion preserved metrics/controls; console exposed the topology, process states, counters, and the full request timeline. All four scenarios displayed Verified after the relevant intervention: outage 59.6 successful/s with zero failures; drain 30.6/s with zero failures; Redis recovery 250.2/s and one queued command; scaling recovery 120.2/s and one queued request. The latter two late interventions retained and disclosed earlier overload failures rather than erasing them.

The independent source/model audit reproduced and fixed four regressions: removal while retries connect could strand requests; detached Redis events could inherit a newer attempt ID; comparison diffs hid same-tick action ordering; and scenario completion could use pre-intervention throughput. All regressions failed before their fixes. The quick suite now has **61 passing tests**, with one opt-in performance test skipped by default. Production type-check/build passes. No backend files changed.

Maximum-load evidence: the production browser preview at eight backends and 500 offered/s remained operable at 1× and 4× playback, with observed steady readings around 54–71 fps on the M5 Pro. Startup shader preparation can briefly lower that reading; the clock preserves work while catching up and reports recovery. No browser error/warning logs appeared in the production check. The separate 900 s model test offered 450,009 requests in 8.92 wall seconds; snapshot+metrics p95 was 1.89 ms. State stayed bounded and all work drained after traffic stopped (details in MODEL.md).

## Pass 6 — static delivery preparation

Added a separate Simulator workflow with tests/build for PRs and official, revision-pinned Pages artifact/deployment actions for main. Only `simulator/dist` is uploaded. Model text and dependency licenses are bundled so visitors do not need private-source access. All 20 production files were served through the repository base path and matched local SHA-256 hashes; no source maps are included. The hosting requirement is documented before enablement.

Pending: PR CI and final review; specific approval to enable public Pages while retaining the private repository; hosting eligibility response; successful deployment, direct live smoke, README live-link activation, issue and milestone closure. The milestone is not complete yet.

## Pass 7 — final interaction review

Independent UI review found three issues: a pinned older trace could be selected by Latest, reset left the request-number input stale, and periodic comparison rendering collapsed its disclosure and lost keyboard focus. Fixed all three. Browser checks reproduced the old Latest behavior, then selected request 1,702 after history rotation and reset the input to 1. With a completed candidate, the expanded comparison details and focused summary survived resumed playback from 22 to 81 simulated seconds. Utilization changes now use percentage points. Compact world labels fit narrow scenes.

A useful matched comparison was also verified in the production browser: with 120 offered requests/s, adding two backends increased successful throughput from 50.5 to 119.9/s and reduced failures from 1,041 to zero during the same 5–20 s window (1,799 completed samples in each run). Average latency fell from 1,076.5 to 46.1 ms; p95 fell from 2,560.4 to 48.7 ms. These are teaching-model measurements, not deployment benchmarks.

The final targeted source review found no further issues. Local validation remains 61 passing tests, one intentionally skipped opt-in performance test, and a successful type-check/production build. Draft PR #43 contains the implementation; publication remains pending the approval and eligibility gates above.

## Pass 8 — public release preparation

The final implementation commit `26bea2f` passed Simulator CI `41926165052` (61 tests and production build) and full repository CI `41926165049` (Kubernetes, security gates, race tests, integrations, and sustained HTTPS load). The load run completed 68,770 iterations with zero unexpected errors or consistency failures and 100% functional checks.

On 5 November 2026 the user explicitly approved public hosting. GitHub rejected Pages for the private repository because of the account plan. The user then explicitly authorized making the entire portfolio repository public. Before changing visibility, checked all 18 README revisions for academic identifiers, the historical submission template for real values, and tracked files for credential patterns. No academic IDs or credential-pattern matches were found; the older local handoff note about README IDs was stale. Local metadata and submission files remain untracked/ignored.

Repository publication and Pages enablement succeeded. The configured URL is `https://kajuyerim.github.io/docker-based-multiserver-system/`, with `build_type=workflow` and public access. The release documentation now links that destination. Deployment and direct live acceptance will be verified after merge.

## S1 / #44 — production browser acceptance (7 November 2026)

Added a renderer/UI-ready signal, pinned Playwright, a production-preview suite at
the repository base path, and a bounded Chromium CI job that gates Pages deployment.
Local Node 22.23.1 validation: 61 model tests passed (one opt-in benchmark skipped),
type-check/build passed, 19 Chromium checks passed with zero retries in 45.5 seconds,
and WebKit desktop/emulated-phone smoke both passed. All four guided experiments
reached Verified through normal controls; an unchanged candidate reproduced the
baseline measurement window. Delayed renderer loading, missing built JavaScript,
covered controls and incorrect focus were rejected by the relevant guards.

The 1/3/8-replica matrix covers 390×844, 768×1024 and 1280×720 plus orientation
changes, with actual panel actions and retained screenshots. Inspected desktop,
tablet and phone screenshots confirm the existing component occlusion tracked by
#45; this first gate verifies control journeys and does not claim that issue fixed.
Reduced motion and a simulated hidden-page lifecycle event preserve usable controls.
WebKit phone input/viewport and tab visibility are emulated, not physical-device or
manual tab-switch evidence. Failure artifacts include runtime errors, focus/UI
state, trace, screenshot, revision and source/bundle/lock hashes. PR CI and fresh
independent review are required before merge.

Fresh review found and corrected two weak assertions: the smoke test now opens
the rendered documentation links, and unchanged comparison requires all 13 matching
measurement rows with zero deltas and no error result. The first hosted run exposed
software-rendering contention and bounded waits expiring during continued progress.
One-worker explicit SwiftShader and action/DOM traces without per-frame screenshots
retain the same assertions and zero retries. The updated 19-test local Chromium run
passed in 45.1 s; updated WebKit link/control checks passed 2/2. Hosted CI and review
are being rerun. An existing x/net scanner finding is addressed in a separate
prerequisite PR rather than suppressed here.

## S1 / #45 — panel-aware scene and readable labels (7 November 2026)

The scene now fits component/path bounds into space measured from the actual DOM
panels. One secondary sheet is active at a time. Compact phone/tablet sheets leave
at least half the viewport for exploration; explicit Read details / Return to map
views provide room for longer controls. Workload settings and Escape also have a
return path. Desktop Console/Compare no longer consume almost the entire scene.
Collapsed experiments stay collapsed while running, and panel changes preserve
selection and expanded inspector disclosures. Action feedback remains visible in
the workload panel and all metrics are reachable by horizontal scrolling.

Labels use native 12 px buttons, selected/attention priority, a 22% secondary-label
budget, measured placement, and the selected building's reserved footprint. Priority
labels can relocate with connector lines; all eight stopped-backend labels remain
available on a phone. The component selector provides access to omitted secondary
labels. Scene readiness now waits for its first measured layout.

Local validation: 64 model/geometry tests passed (one opt-in benchmark skipped),
typecheck/production build passed, and the complete 31-test Chromium suite passed
without retries. After the final label-footprint/metric/feedback adjustments, all
13 affected geometry/lifecycle/smoke checks passed in 27.5 s and WebKit desktop/phone
smoke passed 2/2. The matrix selects every component with 1/3/8 replicas at 390×844,
768×1024 and 1280×720, switches panels, rotates/resizes, and verifies half-area compact
framing, visibility, minimum label size, focus and unchanged paused time/counters.

Inspected the nine viewport/replica Redis-inspector screenshots and matched earlier
desktop/tablet/phone layout states: Redis and its connections are now beside the
panels. The eight-stopped-backend screenshot was also inspected. These are emulated
viewports, not physical-device performance claims. Reports retain source/bundle/lock
hashes; local evidence is in /tmp/s1-45-verified-chromium and /tmp/s1-45-final-layout.
CI and a fresh independent PR review remain required before merge. No model engine,
Go handler, proxy, container or deployment semantics changed; pitfall review passed.

Independent review of head 3f526013 repeated the full 31-test Chromium suite and
WebKit 2/2 successfully. Hosted run 42409039541 reached the old 300 s suite deadline
after 22 passes, with nine checks unstarted and no assertion failures. The verified
artifact hashes match that source. The expanded suite now has a 600 s overall bound
and a 15-minute job bound for setup/artifact overhead. Individual test/action/assertion
timeouts, one worker, assertions and zero retries are unchanged. A complete fresh
hosted pass and review of the updated head remain required before merge.

## S1 / #55 — map navigation (7 November 2026)

Added a presentation-only viewport and shared gesture coordinator: primary/middle
pan, cursor-centered wheel zoom, one-finger pan, moving-centroid pinch, native
zoom/focus/fit controls and scoped keyboard navigation. Drag and multi-touch suppress
selection. Capture loss, cancellation, blur and disposal clear active gestures.
Manual framing survives panel/size/topology changes within documented limits; focus
is interruptible and reduced motion removes its transition. Labels follow the view,
retain 12 px text, and omit offscreen components recoverable through the selector.
Save/restore operations are ready for S2 interiors; interiors themselves remain S2.

Validation: 75 model/view/gesture/lifecycle tests passed (one opt-in benchmark
skipped), production build/typecheck passed, and the complete 35-test Chromium run
passed in 107.7 s without retries. The nine viewport/replica journeys add pan, zoom,
selection, an operational change, focus, fit and orientation/panel changes. A matched
baseline/candidate comparison remains identical with navigation input during the
candidate. Browser-emulated touch covers pinch, contact changes and cancellation;
keyboard/form/modified-wheel checks and panel scrolling preserve native behavior.
WebKit desktop/phone navigation smoke passed 2/2 in 3.3 s. Settled-focus screenshots
were subsequently captured by a passing nine-case matrix run (50.6 s).

Real Chromium tab zoom at 200% exposed a short-landscape layout gap; extending that
layout to 540 px kept controls and focused components visible at 640×360 CSS pixels.
The full browser also exposed a missing implicit favicon request; the site now serves
an original SVG icon. A temporary-profile test extension drives the browser's zoom
API and verifies the factor/viewport; it is not part of the published bundle.
Phone toolbar rows are fixed so Pause/Resume label widths cannot consume the map's
reserved half-area. Native browser zoom is verified; touchscreen checks are emulated,
not physical-device claims. Pure geometry tests also cover coordinate conversion,
anchor precision, bounds, lifecycle cleanup and interruption. Input rendering is
coalesced and reuses the scene's existing objects.

Inspected the nine focus screenshots plus the settled crowded phone/tablet/desktop
views and real 200% zoom capture. Reports/screenshots are under
/tmp/s1-55-full-chromium, /tmp/s1-55-webkit and /tmp/s1-55-settled-focus with source,
bundle and lock hashes. The final 16 expanded experiment-panel, scroll, layout and
input journeys also passed without retries. Fresh PR review and hosted CI remain
the delivery gates. The diff does not change engine
scheduling, backend handlers, proxy or containers; pitfall review passed.

The first hosted #55 browser run exposed continuous WebGL drawing while paused:
tablet traces showed 2–8 fps and 4–5.6 s captures before three test/action timeouts
and the suite limit. Artifact 13589644524 was SHA-256 verified and its source,
bundle and lock hashes matched the locally tested head. An independent controlled
profile observed 448 draw calls in two paused seconds; suppressing unchanged paused
frames reduced that to zero and capture from 521 ms to 78 ms, with unchanged model
time/zoom. Campus now skips an unchanged display time (and unchanging reduced-motion
frames), with explicit invalidation for snapshots and viewport changes. A real
WebGL draw-call regression checks idle stability and redraw after zoom, focus, fit
and model Step. Test/assertion/job limits and zero retries remain unchanged.
The revised production bundle passed all 38 browser checks (36 Chromium and two
WebKit), plus 75 unit checks and build/typecheck. The draw-call regression also
covers selection, topology changes, reduced-motion changes, reset and resume.

## S1 / #46 — request inspection, event evidence

Phase 1 preserves Redis operation origin (request, attempt, backend incarnation),
command kind and each INCR result through execution and acknowledgment. Terminal
outcomes are typed and trace truncation has an explicit omitted-event count. No
service cost, scheduler deadline or workload rule changes. Detached/restarted-origin
and interleaved-INCR fixtures verify that later shared counts cannot replace an
earlier reply's result. All 76 tests and typecheck passed; the opt-in benchmark was
skipped. Pitfall review passed: real backend/proxy/container contracts are untouched.

Phase 2 adds the observational request cursor, persistent static path outside the
background pool, historical event/component explanation, exact current pressure,
and metric-to-component links. Native event buttons are retained across updates so
keyboard focus survives new evidence. Old process identities do not map onto new
incarnations or removed buildings. Model results, workload and commands match an
uninspected run; a separate fixture fills all 200 background transport markers while
the pinned request path survives. All 84 unit/view checks and build/typecheck pass.

Ten targeted desktop/phone journeys passed, covering root, slow, retry, update before
client failure, and queue growth/recovery. The existing layout/zoom checks exposed
overlong zero-occupancy labels; omitting zero details from map text restored eight
stopped phone labels and the real 200% zoom journey. Full exact counts remain in
accessible labels, Inspector and trace text; metric buttons also expose current
readings as accessible descriptions. The final complete browser run and fresh PR
review remain required. No real backend/proxy/container changes; pitfall review PASS.

Phase 3 completes all 48 production-browser checks (46 Chromium and two WebKit)
in 171.413 s, zero retries/flaky results, after the 84 unit/view checks and
production build/typecheck. Inspected actual desktop/phone request evidence and
scene captures: queue growth/recovery, retry, retained INCR and selected paths.
The initial full run passed 47/48; mobile WebKit reported a non-finite value
inside Playwright's injected hit-target listener while mouse-clicking Step after
a focused range adjustment. Protocol click coordinates were finite and the click
subsequently succeeded; the precise native-event cause was not captured. The
touch-enabled smoke now activates through native taps (including trial hit checks),
while desktop keeps clicks and both retain keyboard checks. Three focused native-
tap runs and the full suite passed. Assertions, limits and fatal error collection
are unchanged. Evidence: /tmp/s1-46-full/results.json and its screenshot/report
artifacts, with source/bundle/lock SHA-256 provenance. Touch is browser emulation.
Fresh exact-head PR review and hosted CI remain the merge gates.

Fresh review of initial PR #60 found a pending-connection restart edge case:
release removed the Attempt before retry/terminal evidence read its incarnation,
so the current backend's newer incarnation could replace the original identity.
The logical request now retains its current attempt's captured incarnation through
release; Redis operation origin still takes precedence. Scheduling/event order is
unchanged. A regression first reproduced the bug, then passed for retries enabled
and disabled, including historical warnings and absent old-process path segments.
All 85 unit/view checks, build/typecheck, and seven targeted retry/INCR/Chromium/
WebKit browser checks pass. A new fresh review is required on the corrected head.

Hosted browser run 42415780253 passed 45/46 checks but timed out capturing the
recovered queue scene after all state assertions passed. Its downloaded artifact
13590918960 matched GitHub's SHA-256 and the reviewed source/bundle/lock hashes.
The trace showed 199 synchronous Step actions in 825 ms, a WebGL queue warning,
and subsequent rendering delay. A controlled unchanged-bundle comparison at 4×
CPU throttling performed the same 2,266 draw calls and produced identical final
evidence; yielding between steps allowed 199 animation frames instead of zero and
reduced the maximum observed frame gap from 3.7 s to 0.9 s. The eight-second CI
capture timeout was not reproduced locally, so the precise cause remains inferred.
The test helper now yields one animation frame after every public Step click; no
model work, rendering, assertions, timeouts or retries are skipped or changed. All
ten request journeys and typecheck passed after this harness-only correction.
Full repository CI 42415780219 passed on the unchanged application source. A new
fresh exact-head review and browser CI are required before merge.

A fresh full run of the paced head passed all 46 Chromium checks and WebKit phone,
but desktop WebKit reported an intermittent injected hit-target exception while
closing the scrolled workload disclosure. Functional assertions completed; three
unchanged diagnostic repetitions passed, so that did not establish a clean full
run. The smoke journey now uses the existing explicit Return to map button and
asserts both disclosure closure and summary focus. Three desktop and three phone
WebKit runs passed with error collection intact, plus typecheck. No application
source changed. A clean complete run and fresh exact-head review remain required.
