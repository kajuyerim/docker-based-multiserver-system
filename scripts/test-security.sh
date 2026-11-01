#!/usr/bin/env bash
# Verifies optional bearer authentication and the root-only NGINX limiter.
# Run against the local Compose stack without other application traffic.
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
    *) printf 'FAIL: security checks require the local Compose stack on HTTP :8080 or HTTPS :8443\n' >&2; exit 1 ;;
esac
tls_flag=''
if [[ "$BASE_URL" == https://* ]]; then tls_flag=-k; fi
workdir=$(mktemp -d)
run_id="$(date +%s)-$$-$RANDOM"
key="security-$run_id"
value="verified-$run_id"
pass=0

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$*"; }
primary() { docker compose exec -T redis timeout 2 redis-cli --raw "$@" | tr -d '\r'; }
counter() {
    local observed
    observed=$(primary GET global_count) || return 1
    printf '%s\n' "${observed:-0}"
}
cleanup() {
    local status=$?
    trap - EXIT
    set +e
    if ! primary DEL "$key" >/dev/null; then
        printf 'FAIL: could not remove the security test fixture\n' >&2
        if [ "$status" -eq 0 ]; then status=1; fi
    fi
    rm -rf "$workdir"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

request() {
    local path="$1" mode="${2:-configured}"
    case "$mode" in
        missing) STATUS=$(AUTH_TOKEN='' http_curl ${tls_flag:+"$tls_flag"} -sS --connect-timeout 1 --max-time 5 \
            -D "$workdir/headers" -o "$workdir/body" -w '%{http_code}' "$BASE_URL$path") ;;
        wrong) STATUS=$(AUTH_TOKEN="invalid-$run_id" http_curl ${tls_flag:+"$tls_flag"} -sS --connect-timeout 1 --max-time 5 \
            -D "$workdir/headers" -o "$workdir/body" -w '%{http_code}' "$BASE_URL$path") ;;
        configured) STATUS=$(http_curl ${tls_flag:+"$tls_flag"} -sS --connect-timeout 1 --max-time 5 \
            -D "$workdir/headers" -o "$workdir/body" -w '%{http_code}' "$BASE_URL$path") ;;
        *) fail 'invalid request mode' ;;
    esac
    BODY=$(cat "$workdir/body")
}
header() {
    awk -v key="$1" 'tolower($1) == tolower(key ":") {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$workdir/headers"
}
assert_status() {
    [ "$STATUS" = "$1" ] || fail "expected HTTP $1; observed $STATUS body=$BODY"
    [ "$(header Content-Type)" = application/json ] || fail 'expected JSON response'
    [ -n "$(header X-Request-Id)" ] || fail 'expected request identity'
}

printf 'Security integration checks against %s\n' "$BASE_URL"
printf 'Keep other application traffic stopped during counter and rate checks.\n'
command -v docker >/dev/null || fail 'docker is required'
command -v curl >/dev/null || fail 'curl is required'
sleep 3
paths=(/health / "/store?key=$key&value=$value" "/get?key=$key" '/slow?seconds=0')
if [ -n "${AUTH_TOKEN:-}" ]; then
    before=$(counter)
    for path in "${paths[@]}"; do
        for mode in missing wrong; do
            request "$path" "$mode"
            assert_status 401
            printf '%s\n' "$BODY" | grep -Fq '"error":"unauthorized"' || fail 'expected JSON unauthorized error'
            [ "$(header WWW-Authenticate)" = Bearer ] || fail 'expected bearer challenge'
        done
        ok "expected missing/wrong credentials rejected on ${path%%\?*}; observed JSON 401"
    done
    [ "$(counter)" = "$before" ] || fail 'rejected requests changed the primary counter'
    [ "$(primary EXISTS "$key")" = 0 ] || fail 'rejected store request changed primary data'
    ok 'expected rejected requests to leave primary data/counter unchanged; observed no mutation'
else
    for path in "${paths[@]}"; do
        request "$path" missing
        assert_status 200
    done
    ok 'expected empty AUTH_TOKEN to preserve access to every endpoint; observed HTTP 200'
fi

for path in "${paths[@]}"; do
    request "$path"
    assert_status 200
    case "$(header X-Server-Id)" in app1|app2|app3) ;; *) fail 'missing backend identity';; esac
    if [[ "$path" == /store* ]]; then
        printf '%s\n' "$BODY" | grep -Fq '"stored":true' || fail 'authorized store was not acknowledged'
    fi
    ok "expected configured credentials to permit ${path%%\?*}; observed HTTP 200"
done
deadline=$((SECONDS + 10))
while :; do
    request "/get?key=$key"
    assert_status 200
    if printf '%s\n' "$BODY" | grep -Fq "\"value\":\"$value\""; then break; fi
    [ "$SECONDS" -lt "$deadline" ] || fail 'authorized fixture did not replicate within 10s'
    sleep 0.1
done
ok 'expected authenticated store/get to retain replica reads; observed exact fixture value'

# Start with an empty bucket before measuring the allowed burst and overflow.
sleep 3
burst_before=$(counter)
pids=()
for i in $(seq 1 20); do
    http_curl ${tls_flag:+"$tls_flag"} -sS --connect-timeout 1 --max-time 5 \
        -o "$workdir/burst-$i.body" -w '%{http_code}' "$BASE_URL/" >"$workdir/burst-$i.status" &
    pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || fail 'burst request failed'; done
for i in $(seq 1 20); do
    [ "$(cat "$workdir/burst-$i.status")" = 200 ] || fail 'allowed initial burst was rejected'
done
[ "$(counter)" -eq "$((burst_before + 20))" ] || fail 'allowed burst did not increment the primary exactly once per request'
ok 'expected burst of 20 simultaneous requests to pass; observed 20 HTTP 200 responses'

sleep 3
flood_before=$(counter)
pids=()
for i in $(seq 1 100); do
    http_curl ${tls_flag:+"$tls_flag"} -sS --connect-timeout 1 --max-time 5 \
        -D "$workdir/flood-$i.headers" -o "$workdir/flood-$i.body" \
        -w '%{http_code}' "$BASE_URL/" >"$workdir/flood-$i.status" &
    pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || fail 'flood request failed'; done
allowed=0
limited=0
for i in $(seq 1 100); do
    case "$(cat "$workdir/flood-$i.status")" in
        200) allowed=$((allowed + 1));;
        429)
            limited=$((limited + 1))
            cp "$workdir/flood-$i.headers" "$workdir/headers"
            [ "$(header Content-Type)" = application/json ] || fail 'rate limit response was not JSON'
            [ "$(header Retry-After)" = 1 ] || fail 'rate limit response missing Retry-After: 1'
            [ -n "$(header X-Request-Id)" ] || fail 'rate limit response missing request identity'
            grep -Fq '"error":"rate limit exceeded"' "$workdir/flood-$i.body" || fail 'rate limit JSON body incorrect'
            ;;
        *) fail "unexpected flood status $(cat "$workdir/flood-$i.status")";;
    esac
done
[ "$allowed" -gt 0 ] && [ "$limited" -gt 0 ] || fail "expected both allowed and limited requests; observed $allowed/$limited"
[ "$(counter)" -eq "$((flood_before + allowed))" ] || fail 'rate-limited requests changed the primary counter'
ok "expected overload to return JSON 429 and Retry-After; observed $allowed allowed, $limited limited, exact counter effect"

for path in /health "/store?key=$key&value=$value" "/get?key=$key" '/slow?seconds=0'; do
    request "$path"
    assert_status 200
done
ok 'expected health/store/get/slow to remain available during root throttling; observed HTTP 200'
sleep 3
request /
assert_status 200
ok 'expected root limiter to recover after refill; observed HTTP 200'
printf '\nALL PASS: %d security integration checks\n' "$pass"
