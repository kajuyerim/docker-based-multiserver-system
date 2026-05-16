#!/usr/bin/env bash
#
# Smoke test for the multiserver stack. Exercises every endpoint via nginx
# on host port 8080 and verifies status codes, response headers, JSON body
# fields, and round-robin distribution across the three replicas.
#
# Exits 0 on full pass, 1 on any failure. Override the target with:
#     BASE_URL=http://host:port ./scripts/test.sh

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"

pass=0
fail=0
failures=()

# --- helpers --------------------------------------------------------------

# Run a request and stash status, headers, body into globals.
hit() {
    local path="$1"
    local tmp; tmp=$(mktemp)
    BODY=$(curl -sS -D "$tmp" -o - "$BASE_URL$path" 2>/dev/null) || true
    STATUS=$(awk 'NR==1 {print $2}' "$tmp")
    HEADERS=$(cat "$tmp")
    rm -f "$tmp"
}

ok()  { pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
bad() { fail=$((fail+1)); failures+=("$1"); printf '  FAIL  %s — %s\n' "$1" "$2"; }

assert_status() {
    if [ "$STATUS" = "$2" ]; then
        ok "$1 (status=$2)"
    else
        bad "$1" "want status $2, got '$STATUS'"
    fi
}

assert_header_present() {
    if grep -i -q "^$2:" <<< "$HEADERS"; then
        ok "$1 ($2 present)"
    else
        bad "$1" "header '$2' missing"
    fi
}

assert_header_equals() {
    local got
    got=$(grep -i "^$2:" <<< "$HEADERS" | head -n1 \
        | sed -E 's/^[^:]+:[[:space:]]*//; s/[[:space:]\r]+$//')
    if [ "$got" = "$3" ]; then
        ok "$1 ($2: $3)"
    else
        bad "$1" "header '$2' expected '$3', got '$got'"
    fi
}

assert_body_contains() {
    if grep -q -- "$2" <<< "$BODY"; then
        ok "$1"
    else
        bad "$1" "body lacks '$2'; body=$BODY"
    fi
}

# --- readiness probe ------------------------------------------------------

printf '== smoke tests against %s ==\n' "$BASE_URL"
printf 'waiting for /health to respond...\n'
for i in $(seq 1 30); do
    if curl -sf "$BASE_URL/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
if ! curl -sf "$BASE_URL/health" >/dev/null 2>&1; then
    printf 'ERROR: %s/health not reachable after 30s. Is the stack up?\n' "$BASE_URL"
    exit 1
fi

# --- /health --------------------------------------------------------------

hit "/health"
assert_status "GET /health" 200
assert_header_equals "GET /health" "Content-Type" "application/json"
assert_header_present "GET /health" "X-Server-Id"
assert_body_contains "GET /health body has status:ok" '"status":"ok"'

# --- / counter -----------------------------------------------------------

hit "/"
g1=$(grep -oE '"global_count":[0-9]+' <<< "$BODY" | head -n1 | grep -oE '[0-9]+$' || echo 0)
assert_status "GET / (1)" 200
hit "/"
g2=$(grep -oE '"global_count":[0-9]+' <<< "$BODY" | head -n1 | grep -oE '[0-9]+$' || echo 0)
assert_status "GET / (2)" 200
if [ "${g2:-0}" -gt "${g1:-0}" ]; then
    ok "global_count is strictly increasing ($g1 -> $g2)"
else
    bad "global_count" "expected strictly increasing; got $g1 -> $g2"
fi

# --- /store + /get round-trip --------------------------------------------

hit "/store?key=smoke&value=fixture"
assert_status "GET /store" 200
assert_body_contains "GET /store echoes value" '"value":"fixture"'

hit "/get?key=smoke"
assert_status "GET /get (existing)" 200
assert_body_contains "GET /get returns stored value" '"value":"fixture"'

# --- /get on missing key returns JSON null --------------------------------

hit "/get?key=ghost-$$"
assert_status "GET /get (missing)" 200
assert_body_contains "GET /get returns null for missing key" '"value":null'

# --- 400 paths -----------------------------------------------------------

hit "/store?key=onlykey"
assert_status "GET /store missing value" 400

hit "/get"
assert_status "GET /get missing param" 400

hit "/slow"
assert_status "GET /slow missing param" 400

# --- /slow happy path ----------------------------------------------------

hit "/slow?seconds=1"
assert_status "GET /slow?seconds=1" 200
assert_body_contains "GET /slow returns slept:1" '"slept":1'

# --- /slow clamping (10s sleep) ------------------------------------------

printf '  ... /slow?seconds=99 (10s clamp; will block ~10s)\n'
hit "/slow?seconds=99"
assert_status "GET /slow?seconds=99" 200
assert_body_contains "GET /slow clamps to slept:10" '"slept":10'

# --- distribution: 30 requests should hit all 3 replicas -----------------

printf '  ... 30 requests to / for round-robin check\n'
distinct=$(for i in $(seq 1 30); do
    curl -sS -D - -o /dev/null "$BASE_URL/" \
        | grep -i "^x-server-id:" | head -n1
done | sort -u | wc -l | tr -d ' ')
if [ "$distinct" = "3" ]; then
    ok "30 requests hit 3 distinct backends"
else
    bad "round-robin distribution" "expected 3 distinct backends, got $distinct"
fi

# --- summary --------------------------------------------------------------

printf '\n== summary: %d pass, %d fail ==\n' "$pass" "$fail"

if [ "$fail" -ne 0 ]; then
    printf 'failures:\n'
    for f in "${failures[@]}"; do
        printf '  - %s\n' "$f"
    done
    exit 1
fi
printf 'ALL PASS\n'
exit 0
