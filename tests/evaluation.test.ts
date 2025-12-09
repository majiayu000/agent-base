import { describe, it, expect, beforeEach } from 'bun:test';
import {
  Evaluator,
  createEvaluator,
  createDefaultEvaluator,
  Monitor,
  createMonitor,
  lengthCriteria,
  relevanceCriteria,
  completenessCriteria,
  formatCriteria,
  builtinCriteria,
} from '../src/patterns/evaluation.js';
import type { EvaluationCriteria } from '../src/patterns/evaluation.js';

describe('Evaluation & Monitoring Pattern', () => {
  describe('Evaluator', () => {
    let evaluator: Evaluator;

    beforeEach(() => {
      evaluator = createEvaluator({ passThreshold: 0.7 });
    });

    describe('createEvaluator', () => {
      it('should create evaluator with default config', () => {
        const e = createEvaluator();
        expect(e).toBeInstanceOf(Evaluator);
      });

      it('should create evaluator with custom threshold', () => {
        const e = createEvaluator({ passThreshold: 0.9 });
        expect(e).toBeInstanceOf(Evaluator);
      });
    });

    describe('addCriteria', () => {
      it('should add evaluation criteria', () => {
        const criteria: EvaluationCriteria = {
          id: 'test',
          name: 'Test Criteria',
          description: 'Test',
          weight: 1.0,
          evaluate: () => 1.0,
        };

        evaluator.addCriteria(criteria);
        expect(evaluator.getCriteria()).toHaveLength(1);
      });

      it('should support chaining', () => {
        const result = evaluator
          .addCriteria(lengthCriteria)
          .addCriteria(relevanceCriteria);

        expect(result).toBe(evaluator);
        expect(evaluator.getCriteria()).toHaveLength(2);
      });

      it('should add multiple criteria at once', () => {
        evaluator.addCriteriaList([lengthCriteria, relevanceCriteria, formatCriteria]);
        expect(evaluator.getCriteria()).toHaveLength(3);
      });
    });

    describe('removeCriteria', () => {
      it('should remove criteria by id', () => {
        evaluator.addCriteria(lengthCriteria);
        const removed = evaluator.removeCriteria('length');

        expect(removed).toBe(true);
        expect(evaluator.getCriteria()).toHaveLength(0);
      });

      it('should return false for non-existent criteria', () => {
        const removed = evaluator.removeCriteria('non-existent');
        expect(removed).toBe(false);
      });
    });

    describe('evaluate', () => {
      beforeEach(() => {
        evaluator.addCriteriaList(builtinCriteria);
      });

      it('should evaluate output against criteria', async () => {
        const result = await evaluator.evaluate(
          'What is TypeScript?',
          'TypeScript is a strongly typed programming language that builds on JavaScript. It adds static typing and other features to help catch errors early.'
        );

        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeLessThanOrEqual(1);
        expect(result.criteriaScores).toBeDefined();
        expect(result.timestamp).toBeDefined();
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      });

      it('should pass when score meets threshold', async () => {
        evaluator.addCriteria({
          id: 'always-pass',
          name: 'Always Pass',
          description: 'Always returns 1.0',
          weight: 1.0,
          evaluate: () => 1.0,
        });

        const result = await evaluator.evaluate('input', 'output');
        expect(result.passed).toBe(true);
      });

      it('should fail when score below threshold', async () => {
        const strictEvaluator = createEvaluator({ passThreshold: 0.9 });
        strictEvaluator.addCriteria({
          id: 'low-score',
          name: 'Low Score',
          description: 'Returns low score',
          weight: 1.0,
          evaluate: () => 0.5,
        });

        const result = await strictEvaluator.evaluate('input', 'output');
        expect(result.passed).toBe(false);
      });

      it('should provide feedback', async () => {
        const result = await evaluator.evaluate('question', 'short');
        expect(result.feedback.length).toBeGreaterThan(0);
      });

      it('should handle async evaluation functions', async () => {
        evaluator.addCriteria({
          id: 'async-test',
          name: 'Async Test',
          description: 'Async evaluation',
          weight: 1.0,
          evaluate: async () => {
            await new Promise((r) => setTimeout(r, 10));
            return 0.8;
          },
        });

        const result = await evaluator.evaluate('input', 'output');
        expect(result.criteriaScores['async-test']).toBe(0.8);
      });

      it('should weight criteria appropriately', async () => {
        const weightedEvaluator = createEvaluator();
        weightedEvaluator.addCriteria({
          id: 'high-weight',
          name: 'High Weight',
          description: '',
          weight: 0.9,
          evaluate: () => 1.0,
        });
        weightedEvaluator.addCriteria({
          id: 'low-weight',
          name: 'Low Weight',
          description: '',
          weight: 0.1,
          evaluate: () => 0.0,
        });

        const result = await weightedEvaluator.evaluate('input', 'output');
        // Weighted average: (1.0 * 0.9 + 0.0 * 0.1) / (0.9 + 0.1) = 0.9
        expect(result.score).toBe(0.9);
      });
    });

    describe('evaluateBatch', () => {
      it('should evaluate multiple items', async () => {
        evaluator.addCriteria(lengthCriteria);

        const results = await evaluator.evaluateBatch([
          { input: 'q1', output: 'Answer 1 with enough content to pass length check' },
          { input: 'q2', output: 'Answer 2 also with sufficient length for testing' },
        ]);

        expect(results).toHaveLength(2);
      });
    });

    describe('history and stats', () => {
      beforeEach(async () => {
        evaluator.addCriteria(lengthCriteria);
        await evaluator.evaluate('q1', 'Long enough answer for the test');
        await evaluator.evaluate('q2', 'Another sufficiently long response');
      });

      it('should track evaluation history', () => {
        const history = evaluator.getHistory();
        expect(history).toHaveLength(2);
      });

      it('should provide statistics', () => {
        const stats = evaluator.getStats();

        expect(stats.totalEvaluations).toBe(2);
        expect(stats.passRate).toBeGreaterThanOrEqual(0);
        expect(stats.averageScore).toBeGreaterThan(0);
        expect(stats.criteriaAverages).toBeDefined();
      });

      it('should clear history', () => {
        evaluator.clearHistory();
        expect(evaluator.getHistory()).toHaveLength(0);
      });
    });

    describe('createDefaultEvaluator', () => {
      it('should create evaluator with built-in criteria', () => {
        const e = createDefaultEvaluator();
        expect(e.getCriteria().length).toBeGreaterThan(0);
      });
    });
  });

  describe('Built-in Criteria', () => {
    describe('lengthCriteria', () => {
      it('should score based on output length', async () => {
        const shortScore = await lengthCriteria.evaluate('q', 'short');
        const longScore = await lengthCriteria.evaluate('q', 'a'.repeat(100));

        expect(shortScore).toBeLessThan(longScore);
      });
    });

    describe('relevanceCriteria', () => {
      it('should score based on keyword overlap', async () => {
        const relevantScore = await relevanceCriteria.evaluate(
          'TypeScript programming',
          'TypeScript is a programming language'
        );
        const irrelevantScore = await relevanceCriteria.evaluate(
          'TypeScript programming',
          'The weather is nice today'
        );

        expect(relevantScore).toBeGreaterThan(irrelevantScore);
      });
    });

    describe('completenessCriteria', () => {
      it('should detect incomplete responses', async () => {
        const completeScore = await completenessCriteria.evaluate('q', 'This is a complete answer.');
        const incompleteScore = await completenessCriteria.evaluate('q', 'This is incomplete...');

        expect(completeScore).toBeGreaterThan(incompleteScore);
      });
    });

    describe('formatCriteria', () => {
      it('should reward structured content', async () => {
        const structuredScore = await formatCriteria.evaluate('q', '- Item 1\n- Item 2\n- Item 3');
        const plainScore = await formatCriteria.evaluate('q', 'Just plain text');

        expect(structuredScore).toBeGreaterThanOrEqual(plainScore);
      });
    });
  });

  describe('Monitor', () => {
    let monitor: Monitor;

    beforeEach(() => {
      monitor = createMonitor();
    });

    describe('createMonitor', () => {
      it('should create monitor with default config', () => {
        const m = createMonitor();
        expect(m).toBeInstanceOf(Monitor);
      });

      it('should create monitor with custom config', () => {
        const m = createMonitor({
          enabled: true,
          retentionMs: 3600000,
        });
        expect(m).toBeInstanceOf(Monitor);
      });
    });

    describe('record', () => {
      it('should record metrics', () => {
        monitor.record('test_metric', 42);
        const metrics = monitor.getMetrics('test_metric');

        expect(metrics).toHaveLength(1);
        expect(metrics[0].value).toBe(42);
      });

      it('should record with labels', () => {
        monitor.record('requests', 1, { labels: { endpoint: '/api' } });
        const metrics = monitor.getMetrics('requests', { labels: { endpoint: '/api' } });

        expect(metrics).toHaveLength(1);
      });

      it('should record with unit', () => {
        monitor.record('latency', 100, { unit: 'ms' });
        const metrics = monitor.getMetrics('latency');

        expect(metrics[0].unit).toBe('ms');
      });

      it('should not record when disabled', () => {
        monitor.setEnabled(false);
        monitor.record('test', 1);

        expect(monitor.getMetrics('test')).toHaveLength(0);
      });
    });

    describe('convenience methods', () => {
      it('should record latency', () => {
        monitor.recordLatency('api_latency', 150);
        const metrics = monitor.getMetrics('api_latency');

        expect(metrics[0].value).toBe(150);
        expect(metrics[0].unit).toBe('ms');
      });

      it('should record count', () => {
        monitor.recordCount('requests');
        monitor.recordCount('requests', 5);

        const metrics = monitor.getMetrics('requests');
        expect(metrics).toHaveLength(2);
        expect(metrics[0].value).toBe(1);
        expect(metrics[1].value).toBe(5);
      });

      it('should record gauge', () => {
        monitor.recordGauge('active_connections', 10);
        const metrics = monitor.getMetrics('active_connections');

        expect(metrics[0].unit).toBe('gauge');
      });
    });

    describe('startTimer', () => {
      it('should measure duration', async () => {
        const stop = monitor.startTimer('operation');
        await new Promise((r) => setTimeout(r, 50));
        const duration = stop();

        expect(duration).toBeGreaterThanOrEqual(40);

        const metrics = monitor.getMetrics('operation');
        expect(metrics).toHaveLength(1);
      });
    });

    describe('alerts', () => {
      it('should trigger alert when threshold exceeded', () => {
        const alerts: { metric: string; value: number }[] = [];

        const alertMonitor = createMonitor({
          alertThresholds: { error_rate: { max: 0.1 } },
          onAlert: (metric, value) => alerts.push({ metric, value }),
        });

        alertMonitor.record('error_rate', 0.2);

        expect(alerts).toHaveLength(1);
        expect(alerts[0].metric).toBe('error_rate');
      });

      it('should trigger alert when below minimum', () => {
        const alerts: string[] = [];

        const alertMonitor = createMonitor({
          alertThresholds: { availability: { min: 0.99 } },
          onAlert: (metric) => alerts.push(metric),
        });

        alertMonitor.record('availability', 0.95);

        expect(alerts).toContain('availability');
      });

      it('should set alert threshold dynamically', () => {
        const alerts: string[] = [];
        monitor = createMonitor({
          onAlert: (metric) => alerts.push(metric),
        });

        monitor.setAlertThreshold('cpu', { max: 80 });
        monitor.record('cpu', 90);

        expect(alerts).toContain('cpu');
      });
    });

    describe('getMetrics', () => {
      it('should filter by time', () => {
        monitor.record('test', 1);

        const future = new Date(Date.now() + 10000);
        const metrics = monitor.getMetrics('test', { since: future });

        expect(metrics).toHaveLength(0);
      });

      it('should filter by labels', () => {
        monitor.record('requests', 1, { labels: { env: 'prod' } });
        monitor.record('requests', 1, { labels: { env: 'dev' } });

        const prodMetrics = monitor.getMetrics('requests', { labels: { env: 'prod' } });
        expect(prodMetrics).toHaveLength(1);
      });
    });

    describe('getMetricNames', () => {
      it('should return unique metric names', () => {
        monitor.record('metric_a', 1);
        monitor.record('metric_b', 2);
        monitor.record('metric_a', 3);

        const names = monitor.getMetricNames();
        expect(names).toHaveLength(2);
        expect(names).toContain('metric_a');
        expect(names).toContain('metric_b');
      });
    });

    describe('getStats', () => {
      beforeEach(() => {
        monitor.record('latency', 100);
        monitor.record('latency', 200);
        monitor.record('latency', 150);
      });

      it('should calculate statistics', () => {
        const stats = monitor.getStats();

        expect(stats.totalMetrics).toBe(3);
        expect(stats.metricCounts['latency']).toBe(3);
        expect(stats.averages['latency']).toBe(150);
        expect(stats.mins['latency']).toBe(100);
        expect(stats.maxs['latency']).toBe(200);
        expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
      });
    });

    describe('getPercentile', () => {
      it('should calculate percentiles', () => {
        for (let i = 1; i <= 100; i++) {
          monitor.record('values', i);
        }

        const p50 = monitor.getPercentile('values', 50);
        const p99 = monitor.getPercentile('values', 99);

        expect(p50).toBeGreaterThanOrEqual(45);
        expect(p50).toBeLessThanOrEqual(55);
        expect(p99).toBeGreaterThanOrEqual(95);
      });

      it('should return undefined for empty metrics', () => {
        const p50 = monitor.getPercentile('non_existent', 50);
        expect(p50).toBeUndefined();
      });
    });

    describe('clear', () => {
      it('should clear all metrics', () => {
        monitor.record('test', 1);
        monitor.clear();

        expect(monitor.getStats().totalMetrics).toBe(0);
      });
    });

    describe('export', () => {
      it('should export metrics as JSON', () => {
        monitor.record('test', 42);
        const exported = monitor.export();

        expect(exported).toContain('test');
        expect(exported).toContain('42');
      });
    });

    describe('onMetric callback', () => {
      it('should call callback on each metric', () => {
        const recorded: number[] = [];
        const callbackMonitor = createMonitor({
          onMetric: (metric) => recorded.push(metric.value),
        });

        callbackMonitor.record('test', 1);
        callbackMonitor.record('test', 2);

        expect(recorded).toEqual([1, 2]);
      });
    });
  });
});
