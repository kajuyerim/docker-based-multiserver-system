#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
for dependency in docker python3; do
    command -v "$dependency" >/dev/null || { printf 'ERROR: %s is required\n' "$dependency" >&2; exit 1; }
done
mkdir -p report/screenshots
exec > >(tee report/screenshots/chaos_results.txt) 2>&1
workdir=$(mktemp -d)
export LOAD_OUTPUT_DIR="$workdir"
export LOAD_UID
export LOAD_GID
LOAD_UID=$(id -u)
LOAD_GID=$(id -g)
load_container="multiserver-chaos-$(date +%s)-$$"
killed=''
cycles=0

# shellcheck disable=SC2329
cleanup() {
    local status=$?
    trap - EXIT
    set +e
    if docker inspect "$load_container" >/dev/null 2>&1; then
        docker logs "$load_container"
        docker rm -f "$load_container" >/dev/null || status=1
    fi
    if [ -n "$killed" ]; then
        docker compose start --wait --wait-timeout 60 "$killed" || status=1
    fi
    if [ -f "$workdir/chaos_summary.json" ]; then
        cp "$workdir/chaos_summary.json" report/screenshots/chaos_summary.json || status=1
    fi
    docker compose ps --format '{{.Service}} {{.Health}}'
    printf '\nCompleted fault cycles: %s/9. Result: %s. Existing data and volumes retained.\n' "$cycles" "$status"
    rm -rf "$workdir"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Chaos acceptance — %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'Five minutes, 8 HTTPS root requests/sec, 30-second failure intervals, 10-second outages.\n'
printf 'Each response must be HTTP 200 with valid counters and matching backend identity; 429 is a failure.\n'
if [ -n "${AUTH_TOKEN:-}" ]; then printf 'Authentication: configured bearer token (withheld).\n'; else printf 'Authentication: disabled.\n'; fi
printf 'Revision: %s\n' "$(git describe --always --dirty)"
docker image inspect multiserver-app:local --format 'Backend image: {{.Id}}'
python3 - <<'PY'
from pathlib import Path
import hashlib
for name in ('scripts/chaos.sh', 'bench/chaos.js'):
    print('SHA256', name, hashlib.sha256(Path(name).read_bytes()).hexdigest())
PY
docker compose ps --format '{{.Service}} {{.Health}}' > "$workdir/services"
for service in redis redis-replica app1 app2 app3 jaeger prometheus grafana nginx; do
    grep -qx "$service healthy" "$workdir/services" || { printf 'FAIL: %s must be healthy\n' "$service"; exit 1; }
done
rm -f report/screenshots/chaos_summary.json
docker compose --profile load run -d --no-deps --name "$load_container" loadgen \
    run --quiet --log-format raw --no-usage-report /scripts/chaos.js >/dev/null
started=''
for _ in $(seq 1 50); do
    started=$(docker logs "$load_container" 2>&1 | sed -n 's/^CHAOS_START=\([0-9]*\)$/\1/p')
    [ -z "$started" ] || break
    sleep 0.2
done
[[ "$started" =~ ^[0-9]+$ ]] || { printf 'FAIL: generator did not start\n'; exit 1; }
services=(app1 app2 app3)
for cycle in $(seq 1 9); do
    delay=$((started + cycle * 30 - $(date +%s)))
    [ "$delay" -le 0 ] || sleep "$delay"
    [ "$(docker inspect --format '{{.State.Running}}' "$load_container")" = true ] || { printf 'FAIL: generator exited before fault cycle\n'; exit 1; }
    killed=${services[$((RANDOM % 3))]}
    printf 't=%ss: SIGKILL %s\n' "$(($(date +%s) - started))" "$killed"
    docker compose kill --signal SIGKILL "$killed"
    container=$(docker compose ps -aq "$killed")
    [ "$(docker inspect --format '{{.State.Running}}' "$container")" = false ] || { printf 'FAIL: backend did not stop\n'; exit 1; }
    sleep 10
    [ "$(docker inspect --format '{{.State.Running}}' "$container")" = false ] || { printf 'FAIL: backend restarted before the outage ended\n'; exit 1; }
    printf 't=%ss: restart %s\n' "$(($(date +%s) - started))" "$killed"
    docker compose start --wait --wait-timeout 20 "$killed"
    killed=''
    cycles=$((cycles + 1))
done
result=$(docker wait "$load_container")
[ "$result" = 0 ] || { printf 'FAIL: k6 exited %s\n' "$result"; exit 1; }
python3 - "$workdir/chaos_summary.json" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    report = json.load(stream)
metrics = report['metrics']
duration = report['state']['testRunDurationMs'] / 1000
assert duration >= 300, f'test was truncated: {duration:.3f}s'
count = metrics['chaos_requests']['values']['count']
assert count >= 2400, 'missing scheduled requests'
assert metrics['dropped_iterations']['values']['count'] == 0, 'dropped iterations'
for name in ['chaos_success'] + [f'chaos_success{{window:{i}}}' for i in range(10)]:
    value = metrics[name]['values']
    assert value['rate'] >= .95, (name, value)
    print(f"PASS: {name}: {value['passes']}/{value['passes']+value['fails']} = {value['rate']:.2%}")
for metric in metrics.values():
    assert all(result['ok'] for result in metric.get('thresholds', {}).values()), 'k6 threshold failed'
print(f'PASS: full {duration:.3f}s, {count} requests, zero dropped iterations.')
PY
