#!/usr/bin/env bash
# Interrupts Redis services to verify replication, read failures, and recovery.
# Run against this Compose stack without other application traffic.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/http.sh
source "$script_dir/lib/http.sh"
cd "$script_dir/.."
BASE_URL="${BASE_URL:-https://localhost:8443}"
BASE_URL="${BASE_URL%/}"
case "$BASE_URL" in
    http://localhost:8080|http://127.0.0.1:8080|'http://[::1]:8080'|\
    https://localhost:8443|https://127.0.0.1:8443|'https://[::1]:8443') ;;
    *) printf 'FAIL: BASE_URL must target this local Compose stack on HTTP :8080 or HTTPS :8443\n' >&2; exit 1 ;;
esac
tls_flag=''
if [[ "$BASE_URL" == https://* ]]; then tls_flag=-k; fi
services=(redis redis-replica app1 app2 app3 nginx)
backends=(app1 app2 app3)
marker="issue6-$(date +%s)-$$-$RANDOM"
keys=("$marker" "$marker-stopped" "$marker-paused" "$marker-readonly")
workdir=$(mktemp -d)
replica_interrupted=0
primary_interrupted=0
pass=0

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$*"; }
section() { printf '\n--- %s ---\n' "$*"; }

container_id() { docker compose ps -aq "$1"; }
healthy() {
    local id state
    id=$(container_id "$1") || return 1
    [ -n "$id" ] || return 1
    state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id") || return 1
    [ "$state" = 'running healthy' ]
}
wait_healthy() {
    local deadline=$((SECONDS + 30)) service ready
    while [ "$SECONDS" -lt "$deadline" ]; do
        ready=1
        for service in "$@"; do
            if ! healthy "$service"; then ready=0; break; fi
        done
        if [ "$ready" -eq 1 ]; then return 0; fi
        sleep 0.2
    done
    return 1
}
redis_command() {
    local service="$1"
    shift
    docker compose exec -T "$service" timeout 2 redis-cli --raw "$@" | tr -d '\r'
}
primary_volume() {
    docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}} {{.Name}}{{end}}{{end}}' "$(container_id redis)"
}
backend_fingerprints() {
    local service
    for service in "${backends[@]}"; do
        docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$(container_id "$service")"
    done
}
cleanup() {
    local result=$?
    trap - EXIT
    set +e
    if [ "$replica_interrupted" -eq 1 ] || [ "$primary_interrupted" -eq 1 ]; then
        docker compose unpause redis-replica >/dev/null 2>&1
        docker compose up -d --no-deps redis redis-replica >/dev/null 2>&1
        if ! wait_healthy redis redis-replica; then
            printf 'FAIL: cleanup could not restore healthy Redis services\n' >&2
            if [ "$result" -eq 0 ]; then result=1; fi
        fi
    fi
    if healthy redis; then
        if ! redis_command redis DEL "${keys[@]}" >/dev/null; then
            printf 'FAIL: cleanup could not remove test-owned keys\n' >&2
            if [ "$result" -eq 0 ]; then result=1; fi
        fi
    fi
    if [ "$result" -ne 0 ]; then
        docker compose ps -a >&2
        docker compose logs --tail=20 redis redis-replica app1 app2 app3 nginx >&2
    fi
    rm -rf "$workdir"
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

request() {
    local metadata
    CURL_OK=1
    if ! metadata=$(http_curl ${tls_flag:+"$tls_flag"} -sS --max-time "$2" \
        -D "$workdir/headers" -o "$workdir/body" \
        -w '%{http_code} %{time_total}' "$BASE_URL$1" 2>"$workdir/curl-error"); then
        CURL_OK=0
    fi
    STATUS=${metadata%% *}
    ELAPSED=${metadata#* }
    BODY=$(cat "$workdir/body" 2>/dev/null || true)
}
header() {
    awk -v key="$1" 'tolower($1) == tolower(key ":") {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$workdir/headers"
}
assert_response() {
    [ "$CURL_OK" -eq 1 ] && [ "$STATUS" = "$1" ] \
        || fail "expected HTTP $1; observed status=$STATUS elapsed=${ELAPSED}s body=$BODY"
    [ "$(header Content-Type)" = application/json ] \
        || fail "expected application/json; observed $(header Content-Type)"
    case "$(header X-Server-Id)" in app1|app2|app3) ;; *) fail 'missing or unexpected backend identity';; esac
    [ -n "$(header X-Request-Id)" ] || fail 'missing request identity'
}
store() {
    request "/store?key=$1&value=$2" 5
    assert_response 200
    printf '%s\n' "$BODY" | grep -Fq '"stored":true' || fail "store was not acknowledged: $BODY"
    printf '%s\n' "$BODY" | grep -Fq "\"value\":\"$2\"" || fail "store returned wrong value: $BODY"
}
wait_value() {
    local key="$1" value="$2" deadline=$((SECONDS + 10))
    while [ "$SECONDS" -lt "$deadline" ]; do
        request "/get?key=$key" 1
        if [ "$CURL_OK" -eq 1 ] && [ "$STATUS" = 200 ] \
            && printf '%s\n' "$BODY" | grep -Fq "\"value\":\"$value\""; then
            assert_response 200
            return 0
        fi
        sleep 0.2
    done
    fail "expected /get value=$value within 10s; observed status=$STATUS body=$BODY"
}
wait_replica_value() {
    local key="$1" value="$2" observed='' deadline=$((SECONDS + 10))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if observed=$(redis_command redis-replica GET "$key" 2>&1) \
            && [ "$observed" = "$value" ]; then return 0; fi
        sleep 0.2
    done
    fail "expected replica value=$value within 10s; observed $observed"
}
assert_read_failure() {
    request "/get?key=$marker" 5
    assert_response 500
    printf '%s\n' "$BODY" | grep -Fq '"error":"redis get failed"' || fail "expected Redis JSON error; observed $BODY"
    awk -v elapsed="$ELAPSED" 'BEGIN {exit !(elapsed < 5)}' || fail "read took ${ELAPSED}s; expected under 5s"
    ok "expected JSON 500 in under 5s; observed HTTP $STATUS in ${ELAPSED}s"
}
increment() {
    request / 5
    assert_response 200
    COUNT=$(printf '%s\n' "$BODY" | sed -nE 's/.*"global_count":([0-9]+).*/\1/p')
    [[ "$COUNT" =~ ^[0-9]+$ ]] || fail "missing numeric global counter: $BODY"
}
assert_persistence() {
    local expected_count="$1" expected_value="$2" actual
    wait_healthy redis || fail 'primary did not recover within 30s'
    actual=$(redis_command redis GET "$marker")
    [ "$actual" = "$expected_value" ] || fail "primary lost marker: expected=$expected_value observed=$actual"
    actual=$(redis_command redis GET global_count)
    [ "$actual" = "$expected_count" ] || fail "primary lost counter: expected=$expected_count observed=$actual"
    increment
    [ "$COUNT" -eq "$((expected_count + 1))" ] || fail "counter continuity: expected=$((expected_count + 1)) observed=$COUNT"
    wait_healthy redis-replica || fail 'replica did not resynchronize within 30s'
    wait_value "$marker" "$expected_value"
    ok "direct primary marker=$expected_value restored; global_count continued $expected_count -> $COUNT"
}

printf 'Redis integration checks against %s\n' "$BASE_URL"
printf 'This run interrupts Redis services. Keep other application traffic stopped.\n'
command -v docker >/dev/null || fail 'docker is required'
command -v curl >/dev/null || fail 'curl is required'

section 'Startup, durability, replication, and isolation'
[ "$(docker compose config --services | wc -l | tr -d ' ')" -eq 6 ] || fail 'expected exactly six Compose services'
wait_healthy "${services[@]}" || fail 'expected six healthy services within 30s'
ok 'expected six healthy services; observed redis, redis-replica, app1, app2, app3, nginx healthy'
docker compose exec -T redis sh -ec 'command -v timeout >/dev/null' || fail 'Redis image requires timeout for bounded checks'
[ "$(redis_command redis CONFIG GET appendonly | tail -n1)" = yes ] || fail 'AOF is not enabled'
[ "$(redis_command redis CONFIG GET appendfsync | tail -n1)" = everysec ] || fail 'appendfsync is not everysec'
persistence=$(redis_command redis INFO persistence)
for field in aof_enabled:1 aof_last_write_status:ok; do
    printf '%s\n' "$persistence" | grep -qx "$field" || fail "primary persistence missing $field"
done
volume_before=$(primary_volume)
[[ "$volume_before" == 'volume '* ]] || fail "expected named /data volume; observed $volume_before"
volume_name=${volume_before#volume }
[ "$(docker volume inspect --format '{{index .Labels "com.docker.compose.volume"}}' "$volume_name")" = redis-data ] \
    || fail "expected Compose volume redis-data; observed $volume_name"
ok "expected AOF yes/everysec and named storage; observed /data=$volume_name"
redis_command redis INFO replication | grep -qx 'role:master' || fail 'redis is not the primary'
replication=$(redis_command redis-replica INFO replication)
for field in role:slave master_link_status:up master_sync_in_progress:0; do
    printf '%s\n' "$replication" | grep -qx "$field" || fail "replica missing $field"
done
[ "$(redis_command redis-replica CONFIG GET replica-serve-stale-data | tail -n1)" = no ] || fail 'replica may serve stale data'
for service in redis redis-replica app1 app2 app3; do
    published=$(docker inspect --format '{{range .HostConfig.PortBindings}}{{range .}}{{.HostPort}}{{end}}{{end}}' "$(container_id "$service")")
    [ -z "$published" ] || fail "$service publishes host port $published"
done
for service in "${backends[@]}"; do
    environment=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(container_id "$service")")
    printf '%s\n' "$environment" | grep -qx 'REDIS_READ_ADDR=redis-replica:6379' || fail "$service is not configured to read from the replica"
done
published=$(docker inspect --format '{{range .HostConfig.PortBindings}}{{range .}}{{.HostPort}}{{end}}{{end}}' "$(container_id nginx)")
[ -n "$published" ] || fail 'nginx publishes no host ports'
readonly=$(redis_command redis-replica SET "${keys[3]}" forbidden)
[[ "$readonly" == READONLY* ]] || fail "expected READONLY; observed $readonly"
ok 'expected synchronized read-only replica, all backends using it, and only NGINX host ports; observed all checks pass'
fingerprints_before=$(backend_fingerprints)

section 'Initial and updated replication through every backend'
store "$marker" initial
[ "$(redis_command redis GET "$marker")" = initial ] || fail 'primary did not store initial value'
wait_replica_value "$marker" initial
wait_value "$marker" initial
ok 'expected initial marker on primary, replica, and HTTPS /get; observed initial on all three'
store "$marker" updated
wait_replica_value "$marker" updated
wait_value "$marker" updated
seen=' '
for _ in $(seq 1 30); do
    request "/get?key=$marker" 1
    assert_response 200
    printf '%s\n' "$BODY" | grep -Fq '"value":"updated"' || fail "read returned stale value: $BODY"
    sid=$(header X-Server-Id)
    if [[ "$seen" != *" $sid "* ]]; then seen="$seen$sid "; fi
done
for service in "${backends[@]}"; do
    [[ "$seen" == *" $service "* ]] || fail "did not observe $service; observed:$seen"
done
ok "expected latest value through app1/app2/app3; observed updated via:$seen"

section 'Stopped replica: failed reads, primary availability, automatic recovery'
replica_interrupted=1
docker compose stop redis-replica
assert_read_failure
store "${keys[1]}" during-stop
increment
ok "expected primary writes and increments during replica stop; observed stored=true global_count=$COUNT"
docker compose start redis-replica
wait_healthy redis-replica || fail 'stopped replica did not recover within 30s'
wait_value "${keys[1]}" during-stop
replica_interrupted=0
ok 'expected write made during stop to replicate after recovery; observed during-stop'

section 'Paused replica: bounded reads and recovery'
replica_interrupted=1
docker compose pause redis-replica
assert_read_failure
store "${keys[2]}" during-pause
increment
ok "expected primary writes and increments during replica pause; observed stored=true global_count=$COUNT"
docker compose unpause redis-replica
wait_healthy redis-replica || fail 'paused replica did not recover within 30s'
wait_value "${keys[2]}" during-pause
replica_interrupted=0
ok 'expected write made during pause to replicate after recovery; observed during-pause'

section 'Primary restart retains marker and global counter'
saved_count=$(redis_command redis GET global_count)
primary_interrupted=1
docker compose restart redis
assert_persistence "$saved_count" updated
primary_interrupted=0

section 'Primary replacement retains the same named storage'
id_before=$(container_id redis)
saved_count=$(redis_command redis GET global_count)
primary_interrupted=1
docker compose up -d --no-deps --force-recreate redis
[ "$(container_id redis)" != "$id_before" ] || fail 'primary container ID did not change'
[ "$(primary_volume)" = "$volume_before" ] || fail 'primary storage changed during replacement'
assert_persistence "$saved_count" updated
primary_interrupted=0
ok "expected changed primary container and same volume; observed new ID with $volume_name"
[ "$(backend_fingerprints)" = "$fingerprints_before" ] || fail 'a backend restarted during Redis recovery'
wait_healthy "${services[@]}" || fail 'stack was not healthy after recovery'
ok 'expected automatic reconnect without backend restarts; observed all backend IDs/start times unchanged and six healthy services'
printf '\nALL PASS: %d Redis integration checks\n' "$pass"
