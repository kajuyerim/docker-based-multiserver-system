import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';

const success = new Rate('chaos_success');
const requests = new Counter('chaos_requests');
const thresholds = {
    chaos_success: ['rate>=0.95'],
    chaos_requests: ['count>=2400'],
    dropped_iterations: ['count==0'],
};
for (let window = 0; window < 10; window++) {
    thresholds[`chaos_success{window:${window}}`] = ['rate>=0.95'];
    thresholds[`chaos_requests{window:${window}}`] = ['count>=230'];
}
export const options = {
    insecureSkipTLSVerify: true,
    scenarios: {
        traffic: { executor: 'constant-arrival-rate', rate: 8, timeUnit: '1s',
            duration: '5m', preAllocatedVUs: 30, maxVUs: 30, gracefulStop: '5s' },
    },
    thresholds,
};
export function setup() {
    const response = http.get('https://nginx:443/health', {
        headers: __ENV.AUTH_TOKEN ? { Authorization: `Bearer ${__ENV.AUTH_TOKEN}` } : {},
        timeout: '3s', redirects: 0,
    });
    if (response.status !== 200) throw new Error('Health/authentication preflight failed');
}
export default function () {
    if (exec.scenario.iterationInTest === 0) {
        console.log(`CHAOS_START=${Math.floor(exec.scenario.startTime / 1000)}`);
    }
    const window = Math.min(9, Math.floor((Date.now() - exec.scenario.startTime) / 30000));
    const response = http.get('https://nginx:443/', {
        headers: __ENV.AUTH_TOKEN ? { Authorization: `Bearer ${__ENV.AUTH_TOKEN}` } : {},
        timeout: '3s', redirects: 0,
    });
    let valid = false;
    try {
        const body = response.json();
        valid = response.status === 200 && Number.isInteger(body.global_count)
            && Number.isInteger(body.local_count) && ['app1', 'app2', 'app3'].includes(body.server_id)
            && response.headers['X-Server-Id'] === body.server_id
            && Boolean(response.headers['X-Request-Id']);
    } catch (_) { /* Non-JSON and failed responses count against the SLO. */ }
    success.add(valid, { window: String(window) });
    requests.add(1, { window: String(window) });
}
export function handleSummary(data) {
    return { '/results/chaos_summary.json': JSON.stringify(data, null, 2) + '\n' };
}
