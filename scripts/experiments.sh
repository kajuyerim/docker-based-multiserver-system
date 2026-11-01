#!/usr/bin/env bash
#
# Captures the five original behavior experiments plus Redis replication
# and persistence checks in report/screenshots/.
#
# Prereq: the stack must be running. From the repo root:
#     docker compose up -d
#     ./scripts/experiments.sh
#
# Outputs land in report/screenshots/expN_<name>.txt — one file per
# experiment — and are also tee'd to stdout so you can watch them run.

set -uo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/http.sh
source "$script_dir/lib/http.sh"
cd "$script_dir/.." || exit 1
BASE_URL="${BASE_URL:-http://localhost:8080}"
CURL_TLS_FLAG=''
if [[ "$BASE_URL" == https://* ]]; then
    CURL_TLS_FLAG=-k
fi
case "$BASE_URL" in
    http://localhost:8080|http://127.0.0.1:8080|http://\[::1\]:8080|https://localhost:8443|https://127.0.0.1:8443|https://\[::1\]:8443) ;;
    *) printf 'ERROR: experiments require this local Compose stack on port 8080 or 8443.\n' >&2; exit 1 ;;
esac
OUT_DIR="report/screenshots"
mkdir -p "$OUT_DIR"
run_id="$(date +%s)-$$"
experiment_key="experiment-$run_id"
experiment_value="distributed-systems-$run_id"
app2_stopped=0

cleanup() {
    local status=$?
    if [ "$app2_stopped" -eq 1 ]; then
        if ! docker compose start app2 >/dev/null 2>&1 && [ "$status" -eq 0 ]; then
            status=1
        fi
    fi
    docker compose exec -T redis redis-cli DEL "$experiment_key" >/dev/null 2>&1 || true
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stamp()  { date '+%Y-%m-%d %H:%M:%S'; }
header() { printf '=== %s ===\n%s\nTarget: %s\n\n' "$1" "$(stamp)" "$BASE_URL"; }

# Sanity: stack must be reachable.
if ! http_curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 5 -sf "$BASE_URL/health" >/dev/null 2>&1; then
    printf 'ERROR: %s/health not reachable. Start the stack with docker compose up -d first.\n' "$BASE_URL"
    exit 1
fi

# --- Experiment 1: Load distribution --------------------------------------

{
    header "Experiment 1: Load distribution (30 requests through nginx)"
    echo "Expectation: nginx default round-robin gives ~10 hits per replica."
    echo
    for _ in $(seq 1 30); do
        http_curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 5 -sS -D - -o /dev/null "$BASE_URL/" | grep -i "^x-server-id:"
        sleep 0.12
    done | sort | uniq -c
} | tr -d '\r' | tee "$OUT_DIR/exp1_load_distribution.txt"
echo

# --- Experiment 2: Local vs global state ----------------------------------

{
    header "Experiment 2: Local vs global state (6 GET / requests)"
    echo "Expectation: local_count grows within a single replica (atomic.Int64,"
    echo "per-replica) while global_count rises monotonically across the cluster"
    echo "(Redis INCR, shared)."
    echo
    for _ in $(seq 1 6); do
        body=$(http_curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 5 -sS "$BASE_URL/")
        sid=$(printf '%s' "$body" | grep -oE '"server_id":"[^"]*"' | head -n1)
        printf '%s  %s\n' "$sid" "$body"
        sleep 0.12
    done
} | tr -d '\r' | tee "$OUT_DIR/exp2_local_vs_global.txt"
echo

# --- Experiment 3: Shared Redis store -------------------------------------

{
    header "Experiment 3: Shared Redis store (/store on one replica, /get from others)"
    echo "Expectation: value written to the primary becomes readable through any backend after replication."
    echo
    echo "STORE:"
    http_curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 5 -fsS -D - \
        "$BASE_URL/store?key=$experiment_key&value=$experiment_value"
    echo
    read_deadline=$((SECONDS + 10))
    while :; do
        body=$(http_curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 1 -fsS \
            "$BASE_URL/get?key=$experiment_key") || body=''
        if grep -Fq "\"value\":\"$experiment_value\"" <<< "$body"; then
            break
        fi
        if [ "$SECONDS" -ge "$read_deadline" ]; then
            printf 'ERROR: shared-store value did not replicate within 10s.\n' >&2
            exit 1
        fi
        sleep 0.1
    done
    printf 'GET /get?key=%s (6 times — should land on different replicas):\n' "$experiment_key"
    for _ in $(seq 1 6); do
        body=$(http_curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 1 -fsS "$BASE_URL/get?key=$experiment_key")
        sid=$(printf '%s' "$body" | grep -oE '"server_id":"[^"]*"' | head -n1)
        printf '%s  %s\n' "$sid" "$body"
        sleep 0.12
    done
} | tr -d '\r' | tee "$OUT_DIR/exp3_shared_redis.txt" || exit 1
echo

# --- Experiment 4: Backend failure ----------------------------------------

app2_stopped=1
{
    header "Experiment 4: Backend failure (stop app2; >=90% success on 20 reqs)"
    echo "Stopping app2..."
    docker compose stop app2 || exit 1
    echo
    echo "Running 20 requests:"
    ok=0; fail=0
    for _ in $(seq 1 20); do
        code=$(http_curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 5 -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
        if [ "$code" = "200" ]; then ok=$((ok+1)); else fail=$((fail+1)); fi
        sleep 0.12
    done
    printf 'Result: ok=%d / 20  fail=%d  (spec target >=18/20)\n' "$ok" "$fail"
    echo
    echo "Restarting app2..."
    docker compose start app2 || exit 1
    echo "Waiting 15s for healthcheck to flip + nginx fail_timeout (10s) to expire..."
    sleep 15
    echo
    echo "Distribution after restart (15 requests; all three replicas should reappear):"
    for _ in $(seq 1 15); do
        http_curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 5 -sS -D - -o /dev/null "$BASE_URL/" | grep -i "^x-server-id:"
        sleep 0.12
    done | sort | uniq -c
} | tr -d '\r' | tee "$OUT_DIR/exp4_backend_failure.txt" || exit 1
app2_stopped=0
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
        (http_curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 10 -sS -D - -o /dev/null "$BASE_URL/slow?seconds=3" \
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
} | tr -d '\r' | tee "$OUT_DIR/exp5_concurrent_slow.txt"
echo

if ! {
    header "Experiment 6: Redis replication, failure recovery, and persistence"
    BASE_URL="$BASE_URL" "$script_dir/test-redis.sh"
} | tr -d '\r' | tee "$OUT_DIR/exp6_redis_persistence.txt"; then
    exit 1
fi
echo

printf 'All experiments captured. Files in %s:\n' "$OUT_DIR"
ls -la "$OUT_DIR/"
