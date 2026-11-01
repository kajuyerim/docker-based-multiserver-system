import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const profile = __ENV.LOAD_PROFILE || 'full';
if (!['full', 'smoke'].includes(profile)) throw new Error('LOAD_PROFILE must be full or smoke');
const baseURL = (__ENV.BASE_URL || 'https://nginx:443').replace(/\/$/, '');
if (!/^https:\/\/(nginx:443|localhost:8443|127\.0\.0\.1:8443)$/.test(baseURL)) {
    throw new Error('BASE_URL must target the local TLS NGINX endpoint');
}
const runID = __ENV.LOAD_RUN_ID || '';
if (!/^[a-f0-9]{16,64}$/.test(runID)) throw new Error('LOAD_RUN_ID must be a fresh 16-64 character hexadecimal ID');
const holdSeconds = profile === 'full' ? 60 : 2;
const rampSeconds = profile === 'full' ? 5 : 1;
const levels = [1, 10, 50, 100];
const scheduledSeconds = levels.length * (rampSeconds + holdSeconds) + rampSeconds;
const authorization = __ENV.AUTH_TOKEN ? { Authorization: `Bearer ${__ENV.AUTH_TOKEN}` } : {};
const rootExpected = http.expectedStatuses(200, 429);
const normalExpected = http.expectedStatuses(200);
const functionalChecks = new Rate('load_functional_checks');
const consistencyFailures = new Counter('load_consistency_failures');
const startedIterations = new Counter('load_started_iterations');
const completedIterations = new Counter('load_completed_iterations');

function metricSet(prefix) {
    return {
        all: new Counter(`${prefix}_all_requests`),
        accepted: new Counter(`${prefix}_accepted_requests`),
        limited: new Counter(`${prefix}_rate_limited_requests`),
        errors: new Counter(`${prefix}_errors`),
        allLatency: new Trend(`${prefix}_all_latency_ms`, true),
        acceptedLatency: new Trend(`${prefix}_accepted_latency_ms`, true),
        rootAccepted: new Counter(`${prefix}_root_accepted`),
        storeAccepted: new Counter(`${prefix}_store_accepted`),
        getAccepted: new Counter(`${prefix}_get_accepted`),
        starts: new Trend(`${prefix}_request_started_seconds`),
    };
}
const metrics = { all: metricSet('load_all') };
for (const level of levels) metrics[String(level)] = metricSet(`load_${level}`);
const thresholds = {
    load_functional_checks: ['rate==1'],
    load_consistency_failures: ['count==0'],
    load_all_errors: ['count==0'],
};
for (const level of levels) {
    thresholds[`load_${level}_accepted_requests`] = ['count>0'];
    thresholds[`load_${level}_errors`] = ['count==0'];
}
if (profile === 'full') thresholds.load_100_rate_limited_requests = ['count>0'];

export const options = {
    insecureSkipTLSVerify: true,
    summaryTrendStats: ['min', 'max', 'med', 'p(95)', 'p(99)', 'count'],
    systemTags: ['status', 'method', 'name', 'scenario', 'expected_response', 'tls_version'],
    scenarios: {
        mixed: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                ...levels.flatMap((target) => [
                    { duration: `${rampSeconds}s`, target },
                    { duration: `${holdSeconds}s`, target },
                ]),
                { duration: `${rampSeconds}s`, target: 0 },
            ],
            gracefulRampDown: '15s',
            gracefulStop: '15s',
        },
    },
    thresholds,
};

function stageAt(startedSeconds) {
    for (let i = 0; i < levels.length; i++) {
        const start = i * (rampSeconds + holdSeconds) + rampSeconds;
        if (startedSeconds >= start && startedSeconds < start + holdSeconds) return String(levels[i]);
    }
    return 'ramp';
}

function header(response, name) {
    const key = Object.keys(response.headers).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? response.headers[key] : '';
}

function jsonBody(response) {
    try { return response.json(); } catch (_) { return null; }
}

function record(set, response, endpoint, stage, startedSeconds, unexpected) {
    const identity = header(response, 'X-Server-Id');
    const tags = {
        endpoint,
        stage,
        server_id: ['app1', 'app2', 'app3'].includes(identity) ? identity : response.status === 429 ? 'nginx' : 'unexpected',
    };
    set.all.add(1, tags);
    set.accepted.add(response.status === 200 ? 1 : 0, tags);
    set.limited.add(endpoint === 'root' && response.status === 429 ? 1 : 0, tags);
    set.errors.add(unexpected ? 1 : 0, tags);
    set.allLatency.add(response.timings.duration, tags);
    if (response.status === 200) set.acceptedLatency.add(response.timings.duration, tags);
    set.rootAccepted.add(endpoint === 'root' && response.status === 200 ? 1 : 0, tags);
    set.storeAccepted.add(endpoint === 'store' && response.status === 200 ? 1 : 0, tags);
    set.getAccepted.add(endpoint === 'get' && response.status === 200 ? 1 : 0, tags);
    set.starts.add(startedSeconds, tags);
}

function request(endpoint, path, validate) {
    const startedSeconds = (Date.now() - exec.scenario.startTime) / 1000;
    const stage = stageAt(startedSeconds);
    const response = http.get(baseURL + path, {
        headers: authorization,
        timeout: endpoint === 'get' ? '1s' : '3s',
        redirects: 0,
        responseCallback: endpoint === 'root' ? rootExpected : normalExpected,
        tags: { name: endpoint, endpoint, stage },
    });
    const body = jsonBody(response);
    const identity = header(response, 'X-Server-Id');
    let valid = header(response, 'Content-Type') === 'application/json' && Boolean(header(response, 'X-Request-Id'));
    if (endpoint === 'root' && response.status === 429) {
        valid = valid && body && body.error === 'rate limit exceeded' && header(response, 'Retry-After') === '1';
    } else {
        valid = valid && response.status === 200 && ['app1', 'app2', 'app3'].includes(identity) && Boolean(body) && validate(body);
    }
    functionalChecks.add(Boolean(valid));
    record(metrics.all, response, endpoint, stage, startedSeconds, !valid);
    if (stage !== 'ramp') record(metrics[stage], response, endpoint, stage, startedSeconds, !valid);
    return { response, body, valid };
}

export default function () {
    startedIterations.add(1);
    consistencyFailures.add(0);
    const key = `load-${runID}-${exec.vu.idInTest}`;
    const value = `value-${runID}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`;
    request('root', '/', (body) => Number.isInteger(body.global_count) && Number.isInteger(body.local_count));
    const stored = request('store', `/store?key=${key}&value=${value}`,
        (body) => body.stored === true && body.key === key && body.value === value);
    if (stored.valid) {
        const deadline = Date.now() + 10000;
        let matched = false;
        do {
            const read = request('get', `/get?key=${key}`, (body) => body.key === key && (body.value === null || typeof body.value === 'string'));
            if (!read.valid) break;
            if (read.body.value === value) { matched = true; break; }
            if (Date.now() < deadline) sleep(0.05);
        } while (Date.now() < deadline);
        functionalChecks.add(matched);
        consistencyFailures.add(matched ? 0 : 1);
    }
    completedIterations.add(1);
    sleep(0.1);
}

export function handleSummary(data) {
    const output = {
        load_test: {
            profile,
            run_id: runID,
            base_url: baseURL,
            scheduled_seconds: scheduledSeconds,
            hold_seconds: holdSeconds,
            ramp_seconds: rampSeconds,
            levels,
            latency_unit: 'ms',
            latency_measure: 'k6 HTTP send/wait/receive duration; TLS setup measured separately by built-in metrics',
        },
        k6: data,
    };
    return {
        '/results/load_summary.json': JSON.stringify(output, null, 2) + '\n',
        stdout: `Load profile ${profile} completed; raw metrics saved to /results/load_summary.json.\n`,
    };
}
