#!/usr/bin/env python3
"""Verify live NGINX -> Go -> Redis trace propagation and data minimization."""
import json
import os
import re
import secrets
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = os.environ.get("BASE_URL", "https://localhost:8443").rstrip("/")
TOKEN = os.environ.get("AUTH_TOKEN", "")
CONTEXT = ssl._create_unverified_context()
TRACE_ID = re.compile(r"^[0-9a-f]{32}$")
FORBIDDEN_ATTRIBUTES = {"db.statement", "url.query", "url.full", "http.target", "db.query.text"}


def primary(*args):
    return subprocess.check_output(
        ["docker", "compose", "exec", "-T", "redis", "timeout", "2", "redis-cli", "--raw", *args],
        text=True, timeout=5, cwd=ROOT,
    ).strip()


def counter():
    return int(primary("GET", "global_count") or "0")


def fetch(path, traceparent=None, expected=200):
    headers = {}
    if TOKEN and not path.startswith("/jaeger/"):
        headers["Authorization"] = "Bearer " + TOKEN
    if traceparent is not None:
        headers["traceparent"] = traceparent
    request = urllib.request.Request(BASE + path, headers=headers)
    try:
        response = urllib.request.urlopen(request, context=CONTEXT, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read().decode()
        assert response.status == expected, f"expected HTTP {expected} for {path.split('?')[0]}, observed {response.status}"
        return body, response.headers


def tags(items):
    return {item["key"]: item.get("value") for item in items}


def process(trace, span):
    return trace["processes"][span["processID"]]


def service(trace, span):
    return process(trace, span)["serviceName"]


def child_of(span, parent_id):
    return any(reference["refType"] == "CHILD_OF" and reference["spanID"] == parent_id
               for reference in span.get("references", []))


def assert_private(trace, forbidden_values):
    serialized = json.dumps(trace)
    assert all(value not in serialized for value in forbidden_values if value), "trace contains a sensitive fixture or credential"

    def inspect(value):
        if isinstance(value, dict):
            assert value.get("key") not in FORBIDDEN_ATTRIBUTES, "trace contains a forbidden query/statement attribute"
            for child in value.values():
                inspect(child)
        elif isinstance(value, list):
            for child in value:
                inspect(child)
    inspect(trace)


def validate_chain(trace, trace_id, parent_id, request_id, server_id, route, operation=None, address=None):
    spans = trace["spans"]
    assert spans, "trace has no spans"
    assert all(span["traceID"] == trace_id for span in spans), "trace contains mismatched IDs"
    nginx = [span for span in spans if service(trace, span) == "nginx"
             and tags(span.get("tags", [])).get("span.kind") == "server"]
    if parent_id:
        nginx = [span for span in nginx if child_of(span, parent_id)]
    else:
        nginx = [span for span in nginx if not any(reference["refType"] == "CHILD_OF"
                                                  for reference in span.get("references", []))]
    assert len(nginx) == 1, "expected one native NGINX server span under the supplied parent"
    nginx = nginx[0]
    backends = [span for span in spans if service(trace, span) == "multiserver-backend"
                and span["operationName"] == "GET " + route
                and tags(span.get("tags", [])).get("span.kind") == "server"
                and child_of(span, nginx["spanID"])]
    assert len(backends) == 1, "expected one Go server span directly under NGINX"
    backend = backends[0]
    backend_tags = tags(backend.get("tags", []))
    assert backend_tags.get("http.route") == route, "backend route attribute is missing or unbounded"
    assert tags(process(trace, backend).get("tags", [])).get("service.instance.id") == server_id, "trace instance does not match X-Server-Id"
    for span in spans:
        if service(trace, span) in ("nginx", "multiserver-backend"):
            assert tags(span.get("tags", [])).get("request.id") == request_id, "span correlation differs from X-Request-Id"
    if operation:
        redis = [span for span in spans if service(trace, span) == "multiserver-backend"
                 and span["operationName"].lower() == operation.lower()
                 and tags(span.get("tags", [])).get("span.kind") == "client"
                 and tags(span.get("tags", [])).get("db.system") == "redis"
                 and child_of(span, backend["spanID"])]
        assert redis, f"expected Redis {operation} CLIENT span directly under Go"
        if address:
            assert any(tags(span.get("tags", [])).get("server.address") == address for span in redis), "Redis operation used the wrong primary/replica endpoint"
    return trace


def eventually(check, description, seconds=30):
    deadline = time.monotonic() + seconds
    last = "no observation"
    while time.monotonic() < deadline:
        try:
            result = check()
            assert result, "empty result"
            print("PASS:", description)
            return result
        except (AssertionError, urllib.error.URLError, KeyError, ValueError) as error:
            last = str(error)
            time.sleep(1)
    raise AssertionError(f"{description}: timed out after {seconds}s; last observation={last}")


def exported_trace(trace_id, parent_id, request_id, server_id, route, forbidden_values, operation=None, address=None):
    def check():
        body, _ = fetch("/jaeger/api/traces/" + trace_id)
        payload = json.loads(body)
        matches = [trace for trace in payload.get("data", []) if trace.get("traceID") == trace_id]
        assert len(matches) == 1, "trace has not reached Jaeger"
        trace = matches[0]
        assert_private(trace, forbidden_values)
        return validate_chain(trace, trace_id, parent_id, request_id, server_id, route, operation, address)
    description = f"expected client -> NGINX -> Go{(' -> Redis ' + operation) if operation else ''} for GET {route}; observed matching parents, request IDs, and replica identity"
    return eventually(check, description)


def traced_request(path):
    trace_id, parent_id = secrets.token_hex(16), secrets.token_hex(8)
    body, headers = fetch(path, f"00-{trace_id}-{parent_id}-01")
    assert headers.get("Content-Type") == "application/json", "expected JSON API response"
    assert headers.get("X-Trace-Id") == trace_id, "NGINX did not preserve the supplied trace ID"
    request_id, server_id = headers.get("X-Request-Id"), headers.get("X-Server-Id")
    assert request_id, "missing X-Request-Id"
    assert server_id in ("app1", "app2", "app3"), "unexpected X-Server-Id"
    return json.loads(body), (trace_id, parent_id, request_id, server_id)


def main():
    assert BASE in ("https://localhost:8443", "https://127.0.0.1:8443",
                    "http://localhost:8080", "http://127.0.0.1:8080"), "use the local Compose stack"
    print("Tracing integration checks against", BASE)
    print("Keep other application traffic stopped during counter checks.")
    suffix = secrets.token_hex(12)
    key, value = "tracing-" + suffix, "sensitive-marker-" + suffix
    forbidden_values = (key, value, TOKEN)
    try:
        before = counter()
        stored, store_context = traced_request("/store?" + urllib.parse.urlencode({"key": key, "value": value}))
        assert stored.get("stored") is True, "store was not acknowledged"
        assert stored.get("key") == key and stored.get("value") == value, "store response differs from fixture"
        store_trace = exported_trace(*store_context, "/store", forbidden_values, "SET", "redis")

        deadline = time.monotonic() + 10
        while True:
            read, read_context = traced_request("/get?" + urllib.parse.urlencode({"key": key}))
            if read.get("value") == value:
                break
            assert time.monotonic() < deadline, "replica did not return the exact new value within 10s"
            time.sleep(0.1)
        exported_trace(*read_context, "/get", forbidden_values, "GET", "redis-replica")
        print("PASS: expected exact write/read through primary/replica; observed SET on redis and GET on redis-replica")

        fetch("/health")
        metrics, _ = fetch("/metrics")
        assert "multiserver_http_requests_total" in metrics, "metrics endpoint regressed"
        malformed = "00-invalid-client-context-0000000000000000-01"
        body, headers = fetch("/slow?seconds=0", malformed)
        assert json.loads(body).get("slept") == 0, "malformed context changed normal endpoint behavior"
        replacement = headers.get("X-Trace-Id", "")
        assert TRACE_ID.fullmatch(replacement) and replacement != "0" * 32, "malformed context did not produce a valid new trace ID"
        assert headers.get("X-Request-Id"), "missing request correlation after malformed context"
        exported_trace(replacement, None, headers["X-Request-Id"], headers["X-Server-Id"], "/slow", forbidden_values)
        print("PASS: expected malformed traceparent to start a fresh trace; observed valid replacement and normal HTTP 200")
        assert counter() == before, "store/get/health/metrics/slow requests changed the global counter"
        print("PASS: expected tracing and non-root routes to preserve business counters; observed unchanged primary counter")

        counted, root_context = traced_request("/")
        assert counted.get("global_count") == before + 1, "traced root request did not increment exactly once"
        exported_trace(*root_context, "/", forbidden_values, "INCR", "redis")
        assert counter() == before + 1, "tracing produced an extra primary increment"
        print("PASS: expected one traced root INCR; observed exact counter increment")
        output = os.environ.get("TRACE_OUTPUT")
        if output:
            destination = Path(output)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps({"data": [store_trace]}, indent=2) + "\n")
            print("PASS: saved sanitized representative trace to", destination)
        print("ALL PASS: real NGINX/Go/Redis propagation, replica routing, correlation, malformed context, privacy, and counter safety")
    finally:
        primary("DEL", key)


if __name__ == "__main__":
    main()
