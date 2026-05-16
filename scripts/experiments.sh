#!/usr/bin/env bash
#
# Runs the five experiments required by the course spec (Section 10) and
# saves raw terminal output to report/screenshots/ for inclusion in the
# final report.
#
# Prereq: the stack must be running. From the repo root:
#     docker compose up -d
#     ./scripts/experiments.sh
#
# Outputs land in report/screenshots/expN_<name>.txt — one file per
# experiment — and are also tee'd to stdout so you can watch them run.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
OUT_DIR="report/screenshots"
mkdir -p "$OUT_DIR"

stamp()  { date '+%Y-%m-%d %H:%M:%S'; }
header() { printf '=== %s ===\n%s\nTarget: %s\n\n' "$1" "$(stamp)" "$BASE_URL"; }

# Sanity: stack must be reachable.
if ! curl -sf "$BASE_URL/health" >/dev/null 2>&1; then
    printf 'ERROR: %s/health not reachable. Run `docker compose up -d` first.\n' "$BASE_URL"
    exit 1
fi

# --- Experiment 1: Load distribution --------------------------------------

{
    header "Experiment 1: Load distribution (30 requests through nginx)"
    echo "Expectation: nginx default round-robin gives ~10 hits per replica."
    echo
    for _ in $(seq 1 30); do
        curl -sS -D - -o /dev/null "$BASE_URL/" | grep -i "^x-server-id:"
    done | sort | uniq -c
} | tee "$OUT_DIR/exp1_load_distribution.txt"
echo

# --- Experiment 2: Local vs global state ----------------------------------

{
    header "Experiment 2: Local vs global state (6 GET / requests)"
    echo "Expectation: local_count grows within a single replica (atomic.Int64,"
    echo "per-replica) while global_count rises monotonically across the cluster"
    echo "(Redis INCR, shared)."
    echo
    for _ in $(seq 1 6); do
        body=$(curl -sS "$BASE_URL/")
        sid=$(printf '%s' "$body" | grep -oE '"server_id":"[^"]*"' | head -n1)
        printf '%s  %s\n' "$sid" "$body"
    done
} | tee "$OUT_DIR/exp2_local_vs_global.txt"
echo

# --- Experiment 3: Shared Redis store -------------------------------------

{
    header "Experiment 3: Shared Redis store (/store on one replica, /get from others)"
    echo "Expectation: value written once is readable from any replica."
    echo
    echo "STORE:"
    curl -sS -D - "$BASE_URL/store?key=cmpe476&value=distributed-systems"
    echo
    echo "GET /get?key=cmpe476 (6 times — should land on different replicas):"
    for _ in $(seq 1 6); do
        body=$(curl -sS "$BASE_URL/get?key=cmpe476")
        sid=$(printf '%s' "$body" | grep -oE '"server_id":"[^"]*"' | head -n1)
        printf '%s  %s\n' "$sid" "$body"
    done
} | tee "$OUT_DIR/exp3_shared_redis.txt"
echo

# --- Experiment 4: Backend failure ----------------------------------------

{
    header "Experiment 4: Backend failure (stop app2; >=90% success on 20 reqs)"
    echo "Stopping app2..."
    docker compose stop app2
    echo
    echo "Running 20 requests:"
    ok=0; fail=0
    for _ in $(seq 1 20); do
        code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
        if [ "$code" = "200" ]; then ok=$((ok+1)); else fail=$((fail+1)); fi
    done
    printf 'Result: ok=%d / 20  fail=%d  (spec target >=18/20)\n' "$ok" "$fail"
    echo
    echo "Restarting app2..."
    docker compose start app2
    echo "Waiting 15s for healthcheck to flip + nginx fail_timeout (10s) to expire..."
    sleep 15
    echo
    echo "Distribution after restart (15 requests; all three replicas should reappear):"
    for _ in $(seq 1 15); do
        curl -sS -D - -o /dev/null "$BASE_URL/" | grep -i "^x-server-id:"
    done | sort | uniq -c
} | tee "$OUT_DIR/exp4_backend_failure.txt"
echo

# --- Experiment 5: Concurrent /slow requests ------------------------------

{
    header "Experiment 5: 5 concurrent /slow?seconds=3 requests"
    echo "Expectation: nginx round-robins to different replicas in parallel, so"
    echo "wall time is ~3-4 s (parallel) instead of ~15 s (serial)."
    echo
    tmpdir=$(mktemp -d)
    start=$(date +%s)
    for i in $(seq 1 5); do
        (curl -sS -D - -o /dev/null "$BASE_URL/slow?seconds=3" \
            | grep -i "^x-server-id:" \
            | head -n1 \
            | tr -d '\r' > "$tmpdir/$i") &
    done
    wait
    end=$(date +%s)
    echo "Per-request replica:"
    for i in $(seq 1 5); do
        printf '  #%d: %s\n' "$i" "$(cat "$tmpdir/$i")"
    done
    rm -rf "$tmpdir"
    echo
    printf 'Total wall time: %d seconds\n' "$((end - start))"
} | tee "$OUT_DIR/exp5_concurrent_slow.txt"
echo

printf 'All experiments captured. Files in %s:\n' "$OUT_DIR"
ls -la "$OUT_DIR/"
