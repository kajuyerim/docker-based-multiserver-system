export const MODEL_VERSION = '1.0.0';
export const LIMITS = {
  replicas: 8,
  requests: 2048,
  redisOperations: 2048,
  events: 600,
  traces: 100,
  traceEvents: 64,
  commands: 4096,
} as const;

export interface Config {
  seed: number;
  replicas: number;
  capacity: number;
  rate: number;
  slowPercent: number;
  slowSeconds: number;
  jitter: number;
  inFlightLimit: number;
  redisIncrMs: number;
  redisPublishMs: number;
  redisRttMs: number;
  redisOnline: boolean;
  retry: boolean;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  seed: 476, replicas: 3, capacity: 50, rate: 30, slowPercent: 0,
  slowSeconds: 2, jitter: 0.15, inFlightLimit: 128,
  redisIncrMs: 2, redisPublishMs: 1, redisRttMs: 4,
  redisOnline: true, retry: true,
});

export const RANGES = {
  seed: [1, 0xffffffff], replicas: [1, 8], capacity: [5, 200], rate: [0, 500],
  slowPercent: [0, 100], slowSeconds: [0, 10], jitter: [0, 0.5], inFlightLimit: [1, 256],
  redisIncrMs: [0.1, 100], redisPublishMs: [0.1, 100], redisRttMs: [0, 2000],
} as const;

export function validateConfig(config: Config): void {
  for (const [key, range] of Object.entries(RANGES)) {
    const value = config[key as keyof typeof RANGES];
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['seed', 'replicas', 'inFlightLimit'] as const) {
    if (!Number.isInteger(config[key])) throw new Error(`${key} must be an integer`);
  }
  if (typeof config.redisOnline !== 'boolean' || typeof config.retry !== 'boolean') throw new Error('Invalid switch');
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  validateConfig(config);
  return config;
}

// Stateless random streams keep retries and drawing independent of offered traffic.
export function random(seed: number, id: number, stream: number): number {
  let value = (seed ^ Math.imul(id, 0x9e3779b9) ^ Math.imul(stream, 0x85ebca6b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}
