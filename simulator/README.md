# Interactive multiserver model

A full-screen, browser-only simulation of clients → NGINX → Go replicas → Redis.
Change traffic, CPU capacity, retry behavior, and failures; inspect the resulting
queues and counters. Four experiments cover scaling, outage/retry, drain, and a
shared Redis bottleneck. One baseline can be replayed over the same seeded workload
and 5–20 second measurement window.

These are teaching values. Read [MODEL.md](MODEL.md) for formulas, limits,
failure semantics, and omissions. [PROGRESS.md](PROGRESS.md) records verification.

## Run locally

Use Node 22.23.1 and npm. From this directory:

```sh
npm ci
npm test
npm run dev
```

Open `http://127.0.0.1:5173/docker-based-multiserver-system/`.
No Docker startup, credentials, or backend connection is needed.

`npm run build` type-checks and builds `dist/`, including readable model and
dependency notices. `npm run preview` serves that production bundle locally.
`npm run benchmark` runs the optional 15-minute simulated load check; set
`SIM_BENCHMARK_REPORT=/tmp/simulator-performance.json` to save its machine-readable
report. It is separate from the quick unit suite.

## Browser acceptance

From this directory, test the actual production bundle at its repository base path:

```sh
npm ci
npx playwright install chromium webkit
npm run build
npm run test:browser
npm run test:browser:webkit
```

Chromium covers all four experiments, a saved baseline and matched candidate,
capacity/failure controls, pause/step/reset, keyboard focus return, reduced motion,
and the 1/3/8-replica matrix at 390×844, 768×1024 and 1280×720 plus orientation
changes. WebKit provides a second-engine desktop and touch-enabled phone smoke
path. Viewports/touch are browser emulation, not physical-device verification.
The visibility test dispatches a hidden-page lifecycle event; separately check a
real tab switch during manual acceptance.

The ready signal requires renderer initialization and the first scene/UI update;
an early control or loading shell is insufficient. Tests delay the renderer module
and inject representative focus/occlusion and missing-asset faults to check these guards. Browser
exceptions, console errors and failed assets fail the run. Tests use seed 476,
bounded state-based waits and zero retries, with a five-minute overall limit.
Chromium uses one worker and explicit SwiftShader software WebGL, including locally,
to avoid competing GPU contexts on hosted runners. Traces retain DOM/action snapshots;
screenshots are captured at matrix checkpoints and on failure, rather than for every
traced frame. The comparison allows up to 40 seconds per observed run on software
renderers, without changing model time or its completion conditions.

Failures retain a Playwright trace, screenshot, browser errors and UI/focus state.
The JSON/HTML reports identify the source revision, source-tree hash, built-bundle
hash and dependency-lock hash. View the report with `npx playwright show-report`.
The workflow uploads these reports and viewport screenshots for 14 days and gates
Pages deployment on the browser job as well as model tests/build.

Keep manual visual review for art quality, scene readability and device performance.
Geometry journeys also check each selected component label against the measured
unobscured scene, panel switching, reading-view return, orientation changes, and
unchanged model time/counters. Phone/tablet exploration keeps half the viewport for
the scene. Labels stay at least 12 px; use Inspect component for any omitted label.
Screenshots still need visual inspection for meaningful building/path readability.

## GitHub Pages

The project base is `/docker-based-multiserver-system/`. Open the
[published simulator](https://kajuyerim.github.io/docker-based-multiserver-system/).

The repository is public, with publication explicitly authorized for this portfolio
project. [GitHub Pages eligibility](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
allows public repositories on GitHub Free. A personal private repository requires
GitHub Pro; the initial private-repository deployment was rejected by the account's
plan. Academic identifiers are absent from the README; submission metadata stays
local and ignored.

The workflow uploads **only `simulator/dist`**, excluding root documentation,
reports, credentials, source maps, and local metadata. The generated model text and
third-party license notices are intentional public files.

[The simulator workflow](../.github/workflows/simulator.yml) runs tests, a build and browser acceptance
on simulator PRs. On main, it uploads the static artifact and deploys with official
GitHub Pages actions pinned to immutable revisions. Configure the repository Pages
source as GitHub Actions once eligibility is confirmed. PRs have only contents-read
permission; only the main deployment job receives pages-write and OIDC permissions.

After deployment, verify the project URL directly, asset responses, model/notices
links, and all four experiments. No root-site fallback or client routing is needed:
the simulator has a single entry page and no deep-link routes.
