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

[The simulator workflow](../.github/workflows/simulator.yml) runs tests and a build
on simulator PRs. On main, it uploads the static artifact and deploys with official
GitHub Pages actions pinned to immutable revisions. Configure the repository Pages
source as GitHub Actions once eligibility is confirmed. PRs have only contents-read
permission; only the main deployment job receives pages-write and OIDC permissions.

After deployment, verify the project URL directly, asset responses, model/notices
links, and all four experiments. No root-site fallback or client routing is needed:
the simulator has a single entry page and no deep-link routes.
