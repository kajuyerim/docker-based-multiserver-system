import { describe, expect, it } from 'vitest';
import { Engine } from '../src/model/engine';
import { MetricsHistory } from '../src/metrics/metrics';
import { Experiment, SCENARIOS } from '../src/scenarios/scenarios';
import type { Config } from '../src/model/config';
import type { ScenarioId } from '../src/scenarios/scenarios';

function run(id: ScenarioId, act: boolean, overrides: Partial<Config> = {}) {
  const experiment = new Experiment(id);
  const engine = new Engine({ ...experiment.definition.config, ...overrides });
  const history = new MetricsHistory();
  history.observe(engine.snapshot());
  let acted = false;
  let progress;
  for (let i = 0; i < 150; i++) {
    engine.runFor(0.2);
    const snapshot = engine.snapshot();
    progress = experiment.observe(snapshot, history.observe(snapshot));
    if (act && !acted && progress.canAct) {
      for (const command of experiment.actions(snapshot)) engine.command(command);
      acted = true;
    }
    if (progress.complete) break;
  }
  return { progress: progress!, snapshot: engine.snapshot(), acted };
}

describe('guided experiments', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.title}: the stated intervention produces the intended evidence`, () => {
      const first = run(scenario.id, true);
      const second = run(scenario.id, true);
      expect(first.acted).toBe(true);
      expect(first.progress.complete).toBe(true);
      expect(first.progress.evidence).not.toBe('');
      expect(first).toEqual(second);
    });
    it(`${scenario.title}: time alone cannot complete the observation`, () => {
      expect(run(scenario.id, false).progress.complete).toBe(false);
    });
  }
  it('does not claim retry protection with retry disabled', () => {
    const result = run('outage', true, { retry: false });
    expect(result.progress.complete).toBe(false);
    expect(result.snapshot.totals.failed).toBeGreaterThan(0);
  });
  it('does not claim a removed shared bottleneck when one never existed', () => {
    expect(run('redis', true, { redisIncrMs: 2, redisPublishMs: 1 }).progress.complete).toBe(false);
  });

  it('requires a post-outage observation window instead of reusing healthy baseline throughput', () => {
    const experiment = new Experiment('outage');
    const engine = new Engine(experiment.definition.config);
    const history = new MetricsHistory();
    history.observe(engine.snapshot());
    const observe = () => {
      engine.runFor(0.2);
      const snapshot = engine.snapshot();
      return experiment.observe(snapshot, history.observe(snapshot));
    };
    for (let i = 0; i < 50; i++) observe();
    engine.command({ type: 'stop', backend: 2 });
    expect(observe().complete).toBe(false);
    expect(engine.snapshot().totals.retried).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) expect(observe().complete).toBe(false);
    let progress;
    for (let i = 0; i < 5; i++) progress = observe();
    expect(progress!.complete).toBe(true);
  });
});
