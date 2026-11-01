#!/usr/bin/env bash
#
# Smoke test for the multiserver stack. Exercises every endpoint over TLS via
# nginx on host port 8443. Prints the actual response (status, key headers, body)
# next to each assertion so the reader can see what the system did, not just
# whether the test passed.
#
# Exits 0 on full pass, 1 on any failure. Override the target with:
#     BASE_URL=http://host:port ./scripts/test.sh

set -uo pipefail

BASE_URL="${BASE_URL:-https://localhost:8443}"
CURL_TLS_FLAG=''
if [[ "$BASE_URL" == https://* ]]; then
    CURL_TLS_FLAG=-k
fi

pass=0
fail=0
failures=()
run_id="$(date +%s)-$$"
smoke_key="smoke-$run_id"
smoke_value="fixture-$run_id"

# --- helpers --------------------------------------------------------------

# Run a request and stash status, headers, body into globals.
hit() {
    local path="$1"
    local tmp; tmp=$(mktemp)
    BODY=$(curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time "${2:-15}" \
        -sS -D "$tmp" -o - "$BASE_URL$path" 2>/dev/null) || true
    STATUS=$(awk 'NR==1 {print $2}' "$tmp")
    HEADERS=$(cat "$tmp")
    rm -f "$tmp"
}

# Extract a header value (case-insensitive on the key).
hdr() {
    grep -i "^$1:" <<< "$HEADERS" | head -n1 \
        | sed -E 's/^[^:]+:[[:space:]]*//; s/[[:space:]\r]+$//'
}

# Print the last response: status + key headers + body.
show() {
    printf '  -> %s %s  X-Server-Id=%s  X-Request-Id=%s\n' \
        "$STATUS" "$(hdr Content-Type)" "$(hdr X-Server-Id)" "$(hdr X-Request-Id)"
    printf '     body: %s\n' "$BODY"
}

section() { printf '\n--- %s ---\n' "$1"; }

ok()  { pass=$((pass+1)); printf '  PASS: %s\n' "$1"; }
bad() { fail=$((fail+1)); failures+=("$1"); printf '  FAIL: %s -- %s\n' "$1" "$2"; }

# --- readiness probe ------------------------------------------------------

printf '====== smoke tests against %s ======\n\n' "$BASE_URL"
printf 'waiting for /health to respond...'
for _ in $(seq 1 30); do
    if curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 1 -sf "$BASE_URL/health" >/dev/null 2>&1; then
        printf ' ready\n'
        break
    fi
    printf '.'
    sleep 1
done
if ! curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 1 -sf "$BASE_URL/health" >/dev/null 2>&1; then
    printf '\nERROR: %s/health not reachable after 30s. Is the stack up?\n' "$BASE_URL"
    exit 1
fi

# --- /health --------------------------------------------------------------

section '/health (liveness + replica identity)'
printf 'GET /health\n'
hit "/health"
show

if [ "$STATUS" = "200" ] \
   && [ "$(hdr Content-Type)" = "application/json" ] \
   && [ -n "$(hdr X-Server-Id)" ] \
   && grep -q '"status":"ok"' <<< "$BODY"; then
    ok '/health: 200, Content-Type=application/json, X-Server-Id present, body has status:"ok"'
else
    bad '/health' 'one of: status=200 / Content-Type / X-Server-Id / status:"ok" missing'
fi

# --- / counter ------------------------------------------------------------

section 'counter increment (local atomic.Int64 + Redis INCR)'

printf 'GET / (1st)\n'
hit "/"
show
g1=$(grep -oE '"global_count":[0-9]+' <<< "$BODY" | head -n1 | grep -oE '[0-9]+$' || echo 0)
l1=$(grep -oE '"local_count":[0-9]+'  <<< "$BODY" | head -n1 | grep -oE '[0-9]+$' || echo 0)
sid1=$(hdr X-Server-Id); s1=$STATUS

printf 'GET / (2nd)\n'
hit "/"
show
g2=$(grep -oE '"global_count":[0-9]+' <<< "$BODY" | head -n1 | grep -oE '[0-9]+$' || echo 0)
l2=$(grep -oE '"local_count":[0-9]+'  <<< "$BODY" | head -n1 | grep -oE '[0-9]+$' || echo 0)
sid2=$(hdr X-Server-Id); s2=$STATUS

printf '  observed: served by %s then %s; local_count=%s,%s; global_count=%s -> %s\n' \
    "$sid1" "$sid2" "$l1" "$l2" "$g1" "$g2"

if [ "$s1" = "200" ] && [ "$s2" = "200" ] && [ "${g2:-0}" -gt "${g1:-0}" ]; then
    ok "global_count strictly increased ($g1 -> $g2). local_count differs by replica as expected."
else
    bad 'counter increment' "expected 200/200 and g2>g1; got status=$s1,$s2 g=$g1,$g2"
fi

# --- /store + /get round-trip --------------------------------------------

section '/store + /get round-trip (shared Redis backing store)'

printf 'GET /store?key=%s&value=%s\n' "$smoke_key" "$smoke_value"
hit "/store?key=$smoke_key&value=$smoke_value"
show
store_status=$STATUS; store_sid=$(hdr X-Server-Id); store_body=$BODY

printf 'GET /get?key=%s (allowing replication to catch up)\n' "$smoke_key"
read_deadline=$((SECONDS + 10))
while :; do
    hit "/get?key=$smoke_key" 1
    if [ "$STATUS" = "200" ] && grep -Fq "\"value\":\"$smoke_value\"" <<< "$BODY"; then
        break
    fi
    [ "$SECONDS" -ge "$read_deadline" ] && break
    sleep 0.1
done
show
get_status=$STATUS; get_sid=$(hdr X-Server-Id)

if [ "$store_status" = "200" ] && [ "$get_status" = "200" ] \
   && grep -q '"stored":true' <<< "$store_body" \
   && grep -Fq "\"value\":\"$smoke_value\"" <<< "$BODY"; then
    ok "round-trip OK: stored on $store_sid, read back via $get_sid -- shared Redis works"
else
    bad '/store + /get' "round-trip failed (store=$store_status get=$get_status)"
fi

# --- /get on missing key returns JSON null --------------------------------

section '/get on missing key -> JSON null (not 404, not empty string)'
ghost_key="ghost-$run_id"
printf 'GET /get?key=%s\n' "$ghost_key"
hit "/get?key=$ghost_key"
show

if [ "$STATUS" = "200" ] && grep -q '"value":null' <<< "$BODY"; then
    ok '/get for missing key returns 200 with "value":null'
else
    bad '/get missing key' 'expected 200 with "value":null'
fi

# --- 400 validation paths ------------------------------------------------

section '400 validation paths'

for case in 'store?key=onlykey' 'get' 'slow'; do
    printf 'GET /%s\n' "$case"
    hit "/$case"
    show
    if [ "$STATUS" = "400" ]; then
        ok "/$case returned 400 as expected"
    else
        bad "/$case" "expected 400, got $STATUS"
    fi
done

# --- /slow happy path ----------------------------------------------------

section '/slow happy path (1 second sleep)'
printf 'GET /slow?seconds=1\n'
hit "/slow?seconds=1"
show

if [ "$STATUS" = "200" ] && grep -q '"slept":1' <<< "$BODY"; then
    ok '/slow?seconds=1 returned 200 with slept:1'
else
    bad '/slow?seconds=1' "expected 200 with slept:1"
fi

# --- /slow clamping (10s sleep) ------------------------------------------

section '/slow clamping (seconds=99 -> max 10 per spec)'
printf 'GET /slow?seconds=99 (will block ~10s)\n'
hit "/slow?seconds=99"
show

if [ "$STATUS" = "200" ] && grep -q '"slept":10' <<< "$BODY"; then
    ok 'seconds=99 silently clamped to slept:10'
else
    bad '/slow?seconds=99' "expected 200 with slept:10"
fi

# --- round-robin distribution --------------------------------------------

section 'round-robin distribution (30 requests through nginx)'
printf 'firing 30 sequential GET / requests...\n'

dist=$(for _ in $(seq 1 30); do
    curl ${CURL_TLS_FLAG:+"$CURL_TLS_FLAG"} --connect-timeout 1 --max-time 5 -sS -D - -o /dev/null "$BASE_URL/" \
        | grep -i "^x-server-id:" | head -n1
done | sort | uniq -c)

printf '  observed:\n'
printf '%s\n' "$dist" | sed 's/^/    /'

distinct=$(printf '%s\n' "$dist" | wc -l | tr -d ' ')
if [ "$distinct" = "3" ]; then
    ok 'all three replicas hit (nginx round-robin working)'
else
    bad 'round-robin distribution' "expected 3 distinct backends, got $distinct"
fi

# --- summary --------------------------------------------------------------

printf '\n====== summary: %d pass, %d fail ======\n' "$pass" "$fail"

if [ "$fail" -ne 0 ]; then
    printf 'failures:\n'
    for f in "${failures[@]}"; do
        printf '  - %s\n' "$f"
    done
    exit 1
fi
printf 'ALL PASS\n'
exit 0
