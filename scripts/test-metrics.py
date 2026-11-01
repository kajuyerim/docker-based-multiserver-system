#!/usr/bin/env python3
"""Verify live Prometheus scrapes and the provisioned Grafana dashboard."""
import base64
import json
import math
import os
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

os.chdir(Path(__file__).resolve().parent.parent)
base = os.environ.get("BASE_URL", "https://localhost:8443").rstrip("/")
assert base in ("https://localhost:8443", "https://127.0.0.1:8443", "http://localhost:8080", "http://127.0.0.1:8080"), "use the local Compose stack"
context = ssl._create_unverified_context()
token = os.environ.get("AUTH_TOKEN", "")
credentials = "admin:" + os.environ.get("GRAFANA_ADMIN_PASSWORD", "local-grafana-admin")
grafana_auth = "Basic " + base64.b64encode(credentials.encode()).decode()


def fetch(path, grafana=False, expected=200, payload=None):
    headers = {}
    if grafana:
        headers["Authorization"] = grafana_auth
    elif token and not path.startswith("/prometheus/"):
        headers["Authorization"] = "Bearer " + token
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, headers=headers, data=data)
    try:
        response = urllib.request.urlopen(req, context=context, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read().decode()
        assert response.status == expected, (path, response.status, body)
        return body


def primary(*args):
    return subprocess.check_output(["docker", "compose", "exec", "-T", "redis", "redis-cli", "--raw", *args], text=True, timeout=5).strip()


def query(expression):
    data = json.loads(fetch("/prometheus/api/v1/query?" + urllib.parse.urlencode({"query": expression})))
    assert data["status"] == "success", data
    return data["data"]["result"]


def eventually(check, description, seconds=40):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            result = check()
            assert result, description
            print("PASS:", description)
            return result
        except (AssertionError, urllib.error.URLError, KeyError) as error:
            last = error
            time.sleep(1)
    raise AssertionError(f"{description}: timed out; last observation={last}")


print("Metrics integration checks against", base)
key = f"metrics-{time.time_ns()}"
try:
    fetch("/store?" + urllib.parse.urlencode({"key": key, "value": "observed"}))
    fetch("/get", expected=400)
    fetch("/slow?seconds=1")
    before = primary("GET", "global_count")
    for _ in range(6):
        exposition = fetch("/metrics")
        assert "# HELP multiserver_http_requests_total" in exposition
        assert "multiserver_global_count_scrape_success" in exposition
    assert primary("GET", "global_count") == before, "scrapes changed the global counter"
    print("PASS: metrics exposition is present and scrapes do not increment counters")

    def targets_ready():
        targets = json.loads(fetch("/prometheus/api/v1/targets"))["data"]["activeTargets"]
        observed = {item["labels"]["instance"] for item in targets if item["health"] == "up" and not item["lastError"]}
        return {"app1:8080", "app2:8080", "app3:8080"} <= observed

    eventually(targets_ready, "Prometheus successfully scrapes all three replicas")
    # Establish a scrape baseline, then create counter deltas for rate queries.
    time.sleep(6)
    for _ in range(12):
        fetch("/get", expected=400)
        fetch("/slow?seconds=0")
        time.sleep(0.1)
    for expression in [
        'multiserver_http_requests_total{route="/get",status="400"}',
        'multiserver_http_request_duration_seconds_count{route="/slow",status="200"}',
        "multiserver_local_count", "multiserver_in_flight_requests",
        "multiserver_global_count_scrape_success == 1",
    ]:
        eventually(lambda e=expression: query(e), "query returns samples: " + expression)
    eventually(lambda: len(query("multiserver_global_count")) == 3, "global counter is exported by each replica")
    assert all(int(float(item["value"][1])) == int(before or "0") for item in query("multiserver_global_count"))

    health = json.loads(fetch("/grafana/api/health", grafana=True))
    assert health["database"] == "ok", health
    datasource = json.loads(fetch("/grafana/api/datasources/uid/prometheus", grafana=True))
    assert datasource["type"] == "prometheus" and datasource["url"] == "http://prometheus:9090", datasource
    dashboard = json.loads(fetch("/grafana/api/dashboards/uid/multiserver", grafana=True))["dashboard"]
    expressions = [target["expr"] for panel in dashboard["panels"] for target in panel.get("targets", []) if target.get("expr")]
    assert len(expressions) >= 7, expressions
    for expression in expressions:
        expression = expression.replace("$__rate_interval", "1m").replace("$__interval", "5s")
        def finite_samples(e=expression):
            values = query(e)
            return values and all(math.isfinite(float(item["value"][1])) for item in values)
        eventually(finite_samples, "dashboard query returns finite data: " + expression)

        def grafana_samples(e=expression):
            now = int(time.time() * 1000)
            data = json.loads(fetch("/grafana/api/ds/query", grafana=True, payload={
                "queries": [{"refId": "A", "datasource": {"type": "prometheus", "uid": "prometheus"},
                             "expr": e, "instant": True, "range": False, "format": "time_series",
                             "intervalMs": 5000, "maxDataPoints": 1000}],
                "from": str(now - 60000), "to": str(now),
            }))["results"]["A"]
            assert not data.get("error"), data
            numbers = [value for frame in data.get("frames", [])
                       for field, values in zip(frame["schema"]["fields"], frame["data"]["values"])
                       if field["type"] == "number" for value in values if value is not None]
            return numbers and all(math.isfinite(float(value)) for value in numbers)
        eventually(grafana_samples, "Grafana datasource executes dashboard query: " + expression)
    print("ALL PASS: metrics, scrape targets, primary counter safety, Grafana provisioning, and dashboard queries")
finally:
    primary("DEL", key)
