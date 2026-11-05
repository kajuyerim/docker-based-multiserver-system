# Open issue implementation plans

Prepared on 4 November 2026 for all 18 open issues in the [project tracker](https://github.com/kajuyerim/docker-based-multiserver-system/issues). These plans turn the acceptance criteria into small implementation phases, checks, and useful preparation. They are future work proposals; implementation has not started.

The source baseline is `3e48671fe031e977125cd5cd0f585b22c7739e1e`. The completed v0.2–v0.5 stack remains the foundation. Refresh the selected issue and repository state when starting, because requirements and tool versions may change.

For a deeper simulator proposal, read the [interactive simulator design](simulator-design.md). It develops the PGSimCity inspiration into controls, a causal model, worked experiments, browser architecture, and validation rules, with changing settings and observing consequences as the priority.

## Choose a work stream

| Work stream | Plans | What you will have |
| --- | --- | --- |
| v1.0 Interactive simulator | [Issues 15–20](v1.0-simulator.md) | A browser demonstration of distributed systems behavior |
| v1.1 Reproducible and secure delivery | [Issues 31–33](v1.1-delivery.md) | Safer CI, verifiable releases, and a reproducible local lab |
| v1.2 Local Kubernetes platform | [Issues 34–37](v1.2-platform.md) | GitOps, isolation, secret rotation, and Kubernetes telemetry |
| v1.3 Reliability and disaster recovery | [Issues 38–42](v1.3-reliability.md) | Measured scaling, alerts, recovery, backups, and a case study |

For the visual portfolio, follow **15 → 16 → 17 → 18 → 19 → 20**. For DevOps practice, follow **31 → 32 → 33 → 34 → 35 → 36 → 37 → 39 → 38 → 41 → 42 → 40**. Issue 33 can start independently of 31–32. Issue 39 comes before 38 in the suggested sequence so the disruption work can reuse the alerting and runbooks. Issue 40 is a stretch exercise; publish the first case study before it, then add Sentinel evidence later.

The simulator and platform streams do not depend on each other. Finish one issue at a time, including its evidence, rather than opening all four milestones together.

## Dependency and readiness index

Dependencies below reflect the live issue requirements. A suggested ordering adds convenience, not an extra acceptance gate.

| Issue and plan | Required earlier work | Preparation or decision |
| --- | --- | --- |
| [15 Model](v1.0-simulator.md#issue-15-deterministic-cluster-model) | Completed v0.5 | Understand a fixed-step clock and queueing; settle model units |
| [16 Visualization](v1.0-simulator.md#issue-16-interactive-2d-visualization) | 15 | Set a visual vocabulary and supported rendering limits |
| [17 Controls](v1.0-simulator.md#issue-17-operational-controls) | 15, 16 | Define stop, restart, removal, and drain semantics |
| [18 Metrics and scenarios](v1.0-simulator.md#issue-18-metrics-and-guided-scenarios) | 15, 16, 17 | Define measurement windows and scenario success conditions |
| [19 Accessibility](v1.0-simulator.md#issue-19-accessibility-and-model-boundaries) | Stable interactions, practically 16–18 | Choose browser, keyboard, screen-reader, and viewport checks |
| [20 Pages](v1.0-simulator.md#issue-20-github-pages-publication) | 15–19 | Resolve hosting eligibility and public-export scope |
| [31 CI trust](v1.1-delivery.md#issue-31-ci-trust-and-dependency-maintenance) | Completed v0.5 | Separate untrusted PR checks from release privileges |
| [32 Releases](v1.1-delivery.md#issue-32-verifiable-oci-releases) | 31 | Select a local registry and signing trust root |
| [33 OpenTofu lab](v1.1-delivery.md#issue-33-reproducible-opentofu-lab) | Completed v0.5 | Set resource budget and resource ownership |
| [34 Flux](v1.2-platform.md#issue-34-flux-gitops-delivery) | 32, 33 | Choose Git source and data-retention behavior |
| [35 Isolation](v1.2-platform.md#issue-35-network-isolation-and-workload-security) | 33, 34 | Select a compatible policy-enforcing CNI |
| [36 Secrets](v1.2-platform.md#issue-36-secret-and-certificate-rotation) | 34, 35 | Choose key backup location and rotation interruption budget |
| [37 Telemetry](v1.2-platform.md#issue-37-kubernetes-observability) | 34, 35, 36 | Set retention and telemetry resource budget |
| [38 Scaling](v1.3-reliability.md#issue-38-autoscaling-and-disruption-tests) | 34, 35, 37 | Find a workload that demonstrably drives backend CPU |
| [39 SLOs](v1.3-reliability.md#issue-39-client-facing-slos-and-local-alerts) | 37 | Define eligible traffic, targets, and low-traffic behavior |
| [40 Sentinel](v1.3-reliability.md#issue-40-redis-sentinel-stretch-lab) | 35, 36, 37, 39 | Choose topology, replica-read policy, and write rejection policy |
| [41 Restore](v1.3-reliability.md#issue-41-backup-and-fresh-cluster-restore) | 34, 36, 37 | Choose backup retention and recovery targets |
| [42 Case study](v1.3-reliability.md#issue-42-operations-game-day-and-case-study) | 32–39, 41 | Choose the story, export scope, and license with both owners |

## Shared implementation workflow

1. Read the live issue, its plan, and applicable repository instructions. Agree on the issue's open decisions and success thresholds. New tool versions should be checked and pinned when implementation starts; these plans intentionally do not prescribe future version numbers.
2. Create an issue branch such as `codex/15-simulator-model`. Complete one numbered phase, run its focused checks, review the diff, and make a Conventional Commit. Phase boundaries below are proposed commit boundaries.
3. Prefer pure tests for model logic, render/schema checks for manifests, and real integration tests for wiring and failure behavior. Use the existing smoke, auth, race, WebSocket, metrics, and tracing checks where their contracts apply.
4. Before an implementation PR, map each acceptance criterion to a file, check, or captured result. Apply the repository pitfall review for backend, proxy, Compose, and Dockerfile changes. Keep Helm and `k8s/multiserver.yaml` synchronized through `scripts/check-k8s.sh` when the default chart changes.
5. Follow the authorization in the implementation session for publishing and merging. This planning request does not start the milestones or authorize deployment. Retain the established local-check → review → PR CI sequence when those actions are requested.

The proposed paths in the plans are implementation targets, not files or commands that already exist. Start with the listed small set; introduce shared helpers only after genuine reuse appears.

## Existing work to reuse

| Existing area | Reuse |
| --- | --- |
| `app/server.go`, `app/events.go`, `app/metrics.go` | Endpoint semantics, counters, WebSocket behavior, stable metric names |
| `nginx/default.conf`, `nginx/nginx.conf` | Retry, root rate limit, authentication pass-through, tracing |
| `helm/multiserver/`, `k8s/` | Application packaging, probes, HPA, persistence, simple kind deployment |
| `.github/workflows/ci.yml` | Existing acceptance and security gates |
| `monitoring/`, `scripts/test-metrics.py`, `scripts/test-tracing.py` | Dashboard definitions and telemetry assertions |
| `bench/`, `scripts/run-load.sh`, `scripts/chaos.sh` | Workload validation, timestamped evidence, cleanup patterns |
| `README.md`, `ARCHITECTURE.md` | Design rationale and the eventual user entry point |

Runtime work is unnecessary for planning. The completed lab is shut down; start the container runtime only when an implementation phase needs it. Preserve retained data and unrelated volumes.

## Evidence to collect as you work

For each real experiment, capture the source commit and dirty-tree status; image and configuration digests; tool versions and architecture; topology and resource limits; workload and seed where applicable; start/end timestamps; thresholds declared before the run; raw observations; pass/fail summary; and cleanup result. Keep credentials, signing keys, decrypted files, private kubeconfigs, state, and personal academic information out of published evidence.

Use a fresh run directory. A failed run remains useful evidence; fix the cause and rerun rather than rewriting results or lowering a threshold after seeing it fail. Record both client outcomes and infrastructure events for failure exercises. Simulated metrics belong to a separate category from measurements of the real stack.

## Decisions that matter early

**Pages eligibility.** The repository is private. GitHub documents free Pages for public repositories, with private-repository Pages available on eligible paid plans. Check the actual account and repository settings before issue 20. Do not purchase a plan or change repository visibility automatically. A reviewed public demo repository is an option requiring an explicit choice; a local static bundle can be prepared meanwhile but does not complete the deployment criterion. [GitHub Pages availability](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).

**Public export.** The current README credits both authors and says no license is claimed. Review relevant history and evidence as well as current files before any export. Preserve credit and settle licensing with the owners; a clean current README alone is not a history audit.

**Local resource budget.** The platform issues require local open-source tooling and no paid service. Measure a small profile first. Multi-worker, full telemetry, and Sentinel profiles remain opt-in; none proves resilience to losing the physical laptop.

**Future decisions.** Hosting, licensing, acceptable rotation interruption, resource ceilings, SLO targets, and retention are decisions to make at the relevant phase. They do not block writing these plans.

## Start a future session

Use a request such as: “Start issue 15 using docs/plans/v1.0-simulator.md. Re-read the live acceptance criteria, resolve the phase 1 decisions with me, and implement one phase at a time with checks and commits.” Add explicit PR and merge instructions if you want those actions included.
