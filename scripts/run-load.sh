#!/usr/bin/env bash
# Run isolated Go benchmarks and the HTTPS Compose load profile.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$script_dir/.."
LOAD_PROFILE=full
if [ "${1:-}" = --smoke ]; then
    LOAD_PROFILE=smoke
elif [ "$#" -ne 0 ]; then
    printf 'Usage: %s [--smoke]\n' "$0" >&2
    exit 2
fi
for dependency in docker go python3; do
    command -v "$dependency" >/dev/null || { printf 'ERROR: %s is required\n' "$dependency" >&2; exit 1; }
done
workdir=$(mktemp -d)
export LOAD_PROFILE
export LOAD_RUN_ID
LOAD_RUN_ID=$(python3 -c 'import secrets; print(secrets.token_hex(12))')
export LOAD_UID
export LOAD_GID
LOAD_UID=$(id -u)
LOAD_GID=$(id -g)
export LOAD_OUTPUT_DIR="$workdir"
load_container="multiserver-load-$LOAD_RUN_ID"
results_dir="${LOAD_RESULTS_DIR:-$PWD/report/screenshots}"
if [ "$LOAD_PROFILE" = smoke ]; then results_dir="$workdir/smoke-results"; fi
mkdir -p "$results_dir/load"
keys_owned=0

# shellcheck disable=SC2329
cleanup() {
    local result=$? i removed name generator_stopped=1
    trap - EXIT
    set +e
    if docker inspect "$load_container" >/dev/null 2>&1; then
        if ! docker rm -f "$load_container" >/dev/null; then
            printf 'FAIL: could not stop the run-owned generator; fixture cleanup deferred.\n' >&2
            generator_stopped=0
            if [ "$result" -eq 0 ]; then result=1; fi
        fi
    fi
    if [ "$keys_owned" -eq 1 ] && [ "$generator_stopped" -eq 1 ]; then
        keys=()
        for i in $(seq 1 100); do keys+=("load-$LOAD_RUN_ID-$i"); done
        if removed=$(docker compose exec -T redis timeout 3 redis-cli --raw DEL "${keys[@]}"); then
            printf 'Cleanup: removed %s run-owned keys; existing data and volumes retained.\n' "$removed" >> "$workdir/environment.txt"
        else
            printf 'FAIL: could not remove run-owned keys.\n' >&2
            if [ "$result" -eq 0 ]; then result=1; fi
        fi
    fi
    for name in load_summary.json go_benchmarks.txt environment.txt services.txt k6_console.txt; do
        if [ -f "$workdir/$name" ]; then
            cp "$workdir/$name" "$results_dir/load/$name" || { if [ "$result" -eq 0 ]; then result=1; fi; }
        else
            rm -f "$results_dir/load/$name" || { if [ "$result" -eq 0 ]; then result=1; fi; }
        fi
    done
    if [ -f "$workdir/load_results.txt" ]; then
        cat "$workdir/load_results.txt" "$workdir/environment.txt" > "$results_dir/load_results.txt" || { if [ "$result" -eq 0 ]; then result=1; fi; }
    else
        { printf 'Load run did not produce a validated summary (exit %s).\n' "$result"; cat "$workdir/environment.txt"; } > "$results_dir/load_results.txt" || { if [ "$result" -eq 0 ]; then result=1; fi; }
    fi
    if [ -f "$workdir/go_benchmarks.txt" ]; then
        printf '\nGo microbenchmarks (direct handler + fake Redis; not real-stack capacity)\n' >> "$results_dir/load_results.txt"
        cat "$workdir/go_benchmarks.txt" >> "$results_dir/load_results.txt" || { if [ "$result" -eq 0 ]; then result=1; fi; }
    fi
    printf '\nResult: %s; report: %s\n' "$result" "$results_dir/load_results.txt"
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

{
    printf '\nEnvironment and measurement boundary\n'
    printf 'UTC: %s\nProfile: %s\nRun ID: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$LOAD_PROFILE" "$LOAD_RUN_ID"
    printf 'Workload revision: %s\n' "$(git describe --always --dirty)"
    printf 'Generator: grafana/k6:2.3.0, same Compose network, HTTPS through NGINX, development TLS verification disabled.\n'
    printf 'Application: three backends, Redis primary/replica, metrics and tracing enabled, root limit 10 requests/sec per source IP.\n'
    if [ -n "${AUTH_TOKEN:-}" ]; then printf 'Authentication: bearer token supplied (value withheld).\n'; else printf 'Authentication: disabled for this local run.\n'; fi
    uname -sm
    go version
    docker info --format 'Docker CPUs={{.NCPU}} memory_bytes={{.MemTotal}}'
    python3 - <<'PY'
from pathlib import Path
import hashlib
for filename in ('bench/load.js', 'app/benchmark_test.go'):
    print('SHA256', filename, hashlib.sha256(Path(filename).read_bytes()).hexdigest())
PY
} > "$workdir/environment.txt"

docker compose exec -T nginx nginx -t
docker compose ps --format '{{.Service}} {{.Health}}' > "$workdir/services.txt"
for service in redis redis-replica app1 app2 app3 jaeger prometheus grafana nginx; do
    grep -qx "$service healthy" "$workdir/services.txt" || { printf 'ERROR: %s must be healthy before measurement\n' "$service" >&2; exit 1; }
done
if [ "$LOAD_PROFILE" = full ]; then
    (cd app && go test -run '^$' -bench 'Benchmark(HandleRoot|ClampSlowSeconds)$' -benchmem -count=3 -benchtime=1s ./...) \
        > "$workdir/go_benchmarks.txt" 2>&1
fi
printf 'Running %s HTTPS load profile; keep other application traffic stopped.\n' "$LOAD_PROFILE"
keys_owned=1
status=0
docker compose --profile load run --rm -T --no-deps --name "$load_container" loadgen run --quiet /scripts/load.js \
    > "$workdir/k6_console.txt" 2>&1 || status=$?
cat "$workdir/k6_console.txt" || { if [ "$status" -eq 0 ]; then status=1; fi; }
summary_status=0
python3 "$script_dir/summarize-load.py" "$workdir/load_summary.json" "$workdir/load_results.txt" || summary_status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi
exit "$summary_status"
