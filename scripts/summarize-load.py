#!/usr/bin/env python3
"""Validate k6 load evidence and write a report with separate accepted traffic."""
import json
import math
import os
import re
import sys
from pathlib import Path


class InvalidResults(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidResults(message)


def metric_map(summary):
    """Accept the pinned k6 machine summary and its legacy map representation."""
    result = {}

    def inspect(node):
        if isinstance(node, dict):
            if isinstance(node.get("metrics"), dict):
                result.update(node["metrics"])
            if isinstance(node.get("name"), str) and isinstance(node.get("values"), dict) and node.get("type") in ("counter", "rate", "gauge", "trend"):
                result[node["name"]] = node
            for value in node.values():
                inspect(value)
        elif isinstance(node, list):
            for value in node:
                inspect(value)
    inspect(summary)
    require(result, "summary has no recognizable metric records")
    return result


def number(value, description):
    require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value), f"{description} must be finite")
    return value


def value(metrics, name, field):
    require(name in metrics, f"missing metric: {name}")
    require(field in metrics[name].get("values", {}), f"missing {field} for {name}")
    return number(metrics[name]["values"][field], f"{name}.{field}")


def duration_seconds(summary):
    state = summary.get("state", {})
    if "testRunDurationMs" in state:
        return number(state["testRunDurationMs"], "test duration") / 1000
    config = summary.get("config", {})
    require("duration" in config, "missing actual k6 duration")
    return number(config["duration"], "test duration")


def failed_thresholds(node):
    failed = []
    if isinstance(node, dict):
        for name, threshold in node.get("thresholds", {}).items() if isinstance(node.get("thresholds"), dict) else []:
            if isinstance(threshold, dict) and threshold.get("ok") is False:
                failed.append(name)
        for child in node.values():
            failed.extend(failed_thresholds(child))
    elif isinstance(node, list):
        for child in node:
            failed.extend(failed_thresholds(child))
    return failed


def counts_and_latency(metrics, prefix):
    counts = {name: value(metrics, f"{prefix}_{name}", "count") for name in (
        "all_requests", "accepted_requests", "rate_limited_requests", "errors", "root_accepted", "store_accepted", "get_accepted",
    )}
    require(all(count >= 0 and int(count) == count for count in counts.values()), f"{prefix} has invalid counts")
    require(counts["all_requests"] > 0 and counts["accepted_requests"] > 0, f"{prefix} has no traffic")
    require(counts["errors"] == 0, f"{prefix} contains unexpected responses or functional failures")
    require(counts["all_requests"] == counts["accepted_requests"] + counts["rate_limited_requests"], f"{prefix} traffic accounting is incomplete")
    require(counts["accepted_requests"] == counts["root_accepted"] + counts["store_accepted"] + counts["get_accepted"], f"{prefix} accepted endpoint accounting is incomplete")
    latencies = {}
    for population, count_name in (("all", "all_requests"), ("accepted", "accepted_requests")):
        metric = f"{prefix}_{population}_latency_ms"
        values = [value(metrics, metric, stat) for stat in ("med", "p(95)", "p(99)")]
        require(0 <= values[0] <= values[1] <= values[2], f"{metric} has invalid percentile ordering")
        require(value(metrics, metric, "count") == counts[count_name], f"{metric} count differs from request count")
        latencies[population] = values
    return counts, latencies


def report(payload):
    config = payload.get("load_test", {})
    profile = config.get("profile")
    require(profile in ("full", "smoke"), "unknown or missing load profile")
    run_id = config.get("run_id", "")
    require(isinstance(run_id, str) and re.fullmatch(r"[a-f0-9]{16,64}", run_id), "missing or invalid run ID")
    if os.environ.get("LOAD_RUN_ID"):
        require(run_id == os.environ["LOAD_RUN_ID"], "summary run ID differs from the requested run")
    if os.environ.get("LOAD_PROFILE"):
        require(profile == os.environ["LOAD_PROFILE"], "summary profile differs from the requested profile")
    expected_hold, expected_ramp = (60, 5) if profile == "full" else (2, 1)
    require(config.get("levels") == [1, 10, 50, 100], "required VU levels are missing")
    require(config.get("hold_seconds") == expected_hold and config.get("ramp_seconds") == expected_ramp, "profile durations were changed or incomplete")
    expected_duration = 4 * (expected_hold + expected_ramp) + expected_ramp
    require(config.get("scheduled_seconds") == expected_duration, "scheduled profile duration is incorrect")
    require(config.get("latency_unit") == "ms", "expected latency measurements in milliseconds")
    summary = payload.get("k6", {})
    elapsed = duration_seconds(summary)
    require(elapsed >= expected_duration - 0.1, f"profile ended early ({elapsed:.2f}s / {expected_duration}s)")
    metrics = metric_map(summary)
    require(not failed_thresholds(summary), "k6 reports failed thresholds")
    require(value(metrics, "load_functional_checks", "rate") == 1, "one or more functional checks failed")
    require(value(metrics, "load_consistency_failures", "count") == 0, "replication read deadline or exact-value verification failed")
    started = value(metrics, "load_started_iterations", "count")
    completed = value(metrics, "load_completed_iterations", "count")
    require(started == completed and completed > 0, "iterations were interrupted or missing")
    overall, overall_latency = counts_and_latency(metrics, "load_all")
    lines = [
        "k6 mixed HTTPS load results",
        f"Profile: {profile}" + (" — FULL ACCEPTANCE" if profile == "full" else " — SMOKE VALIDATION ONLY; not performance acceptance"),
        f"Target: {config.get('base_url', 'unknown')}",
        f"Scheduled: {expected_duration}s; observed: {elapsed:.2f}s; each plateau: {expected_hold}s; ramps: {expected_ramp}s",
        "Workload: root, store, exact replica read; fresh per-iteration values; 0.1s think time; one shared client IP",
        "Root policy: 10 req/s per IP with burst 20; expected JSON 429 is reported separately from accepted HTTP 200",
        "429 percentages: share of ALL HTTP requests and rejection share of ROOT attempts (root 200 + root 429)",
        "Latency: HTTP send/wait/receive duration in milliseconds; excludes connection/TLS setup",
        "Plateau rates divide requests STARTED inside each steady window by its complete duration; ramps excluded",
        "",
        "VUs | Seconds | All req/s | Accepted 200 req/s | Root 429 count (% all requests) | Root rejection % | Accepted p50/p95/p99 ms | All p50/p95/p99 ms",
    ]
    plateau_totals = {key: 0 for key in overall}
    routes = []
    for index, level in enumerate(config["levels"]):
        prefix = f"load_{level}"
        counts, latencies = counts_and_latency(metrics, prefix)
        first = value(metrics, f"{prefix}_request_started_seconds", "min")
        last = value(metrics, f"{prefix}_request_started_seconds", "max")
        window_start = index * (expected_ramp + expected_hold) + expected_ramp
        window_end = window_start + expected_hold
        require(window_start <= first <= last < window_end, f"{level} VU observations fall outside their configured request-start window")
        span = last - first
        require(span >= expected_hold - (3 if profile == "full" else 1), f"{level} VU plateau lacks full-window observations")
        require(counts["root_accepted"] > 0 and counts["store_accepted"] > 0 and counts["get_accepted"] > 0, f"{level} VU plateau did not exercise every endpoint")
        if profile == "full" and level == 100:
            require(counts["rate_limited_requests"] > 0, "100 VU plateau did not observe the active root limiter")
        for key, count in counts.items():
            plateau_totals[key] += count
        accepted = "/".join(f"{latency:.2f}" for latency in latencies["accepted"])
        all_latency = "/".join(f"{latency:.2f}" for latency in latencies["all"])
        limited_percent = 100 * counts["rate_limited_requests"] / counts["all_requests"]
        root_attempts = counts["root_accepted"] + counts["rate_limited_requests"]
        root_rejection = 100 * counts["rate_limited_requests"] / root_attempts
        lines.append(f"{level:3d} | {expected_hold:7d} | {counts['all_requests']/expected_hold:9.2f} | {counts['accepted_requests']/expected_hold:18.2f} | {int(counts['rate_limited_requests']):7d} ({limited_percent:.2f}%) | {root_rejection:.2f}% | {accepted} | {all_latency}")
        routes.append(f"{level:3d} VUs: root={int(counts['root_accepted'])}, store={int(counts['store_accepted'])}, get={int(counts['get_accepted'])}")
    require(all(count <= overall[key] for key, count in plateau_totals.items()), "plateau totals exceed overall traffic")
    lines.extend([
        "",
        "Accepted HTTP 200 counts by endpoint:", *routes,
        "",
        f"Overall including ramps: requests={int(overall['all_requests'])}, accepted200={int(overall['accepted_requests'])}, root429={int(overall['rate_limited_requests'])}",
        f"Overall accepted throughput: {overall['accepted_requests']/elapsed:.2f} req/s; all traffic: {overall['all_requests']/elapsed:.2f} req/s",
        "Overall accepted p50/p95/p99 ms: " + "/".join(f"{latency:.2f}" for latency in overall_latency["accepted"]),
        "Overall all-traffic p50/p95/p99 ms: " + "/".join(f"{latency:.2f}" for latency in overall_latency["all"]),
        f"Completed iterations: {int(completed)}; unexpected errors: 0; consistency failures: 0; functional checks: 100%",
        "PASS: complete profile, all four measured plateaus, finite percentiles, endpoint mix, and functional gates",
    ])
    return "\n".join(lines) + "\n"


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: summarize-load.py RAW_JSON OUTPUT_TXT")
    destination = Path(sys.argv[2])
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        text = report(json.loads(Path(sys.argv[1]).read_text()))
    except (InvalidResults, KeyError, TypeError, json.JSONDecodeError, OSError) as error:
        text = f"FAIL: load evidence is incomplete or invalid: {error}\n"
        destination.write_text(text)
        print(text, end="", file=sys.stderr)
        return 1
    destination.write_text(text)
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
