import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Metric types supported by the collector
 */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'timer';

/**
 * A single metric entry
 */
interface MetricEntry {
  name: string;
  type: MetricType;
  value: number;
  labels: Record<string, string>;
  timestamp: Date;
}

/**
 * Timer handle for measuring duration
 */
interface TimerHandle {
  name: string;
  labels: Record<string, string>;
  startTime: number;
}

/**
 * MetricsCollector - Collects and aggregates performance metrics
 * 
 * Tracks:
 * - Request latency
 * - Agent execution time
 * - Error rates
 * - Memory operations
 * - Token usage
 */
export class MetricsCollector {
  private logger: Logger;
  private metrics: Map<string, MetricEntry[]> = new Map();
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histogramBuckets: number[] = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

  constructor(logLevel: string = 'info') {
    this.logger = createLogger(logLevel, 'metrics-collector');
  }

  /**
   * Increment a counter
   */
  incrementCounter(name: string, labels: Record<string, string> = {}, value: number = 1): void {
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);

    this.recordMetric({
      name,
      type: 'counter',
      value: current + value,
      labels,
      timestamp: new Date(),
    });
  }

  /**
   * Set a gauge value
   */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.getMetricKey(name, labels);
    this.gauges.set(key, value);

    this.recordMetric({
      name,
      type: 'gauge',
      value,
      labels,
      timestamp: new Date(),
    });
  }

  /**
   * Record a histogram value
   */
  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    this.recordMetric({
      name,
      type: 'histogram',
      value,
      labels,
      timestamp: new Date(),
    });

    // Also increment bucket counters
    for (const bucket of this.histogramBuckets) {
      if (value <= bucket) {
        this.incrementCounter(`${name}_bucket`, { ...labels, le: bucket.toString() });
      }
    }
    this.incrementCounter(`${name}_bucket`, { ...labels, le: '+Inf' });
    this.incrementCounter(`${name}_count`, labels);
  }

  /**
   * Start a timer
   */
  startTimer(name: string, labels: Record<string, string> = {}): TimerHandle {
    return {
      name,
      labels,
      startTime: performance.now(),
    };
  }

  /**
   * End a timer and record the duration
   */
  endTimer(handle: TimerHandle): number {
    const duration = performance.now() - handle.startTime;
    
    this.recordMetric({
      name: handle.name,
      type: 'timer',
      value: duration,
      labels: handle.labels,
      timestamp: new Date(),
    });

    // Also record as histogram
    this.recordHistogram(`${handle.name}_duration_ms`, duration, handle.labels);

    return duration;
  }

  /**
   * Record a metric entry
   */
  private recordMetric(entry: MetricEntry): void {
    const entries = this.metrics.get(entry.name) || [];
    entries.push(entry);
    
    // Keep only last 1000 entries per metric
    if (entries.length > 1000) {
      entries.shift();
    }
    
    this.metrics.set(entry.name, entries);
  }

  /**
   * Generate a unique key for a metric with labels
   */
  private getMetricKey(name: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  /**
   * Get all counter values
   */
  getCounters(): Map<string, number> {
    return new Map(this.counters);
  }

  /**
   * Get all gauge values
   */
  getGauges(): Map<string, number> {
    return new Map(this.gauges);
  }

  /**
   * Get histogram percentiles for a metric
   */
  getPercentiles(name: string, percentiles: number[] = [50, 90, 95, 99]): Map<number, number> {
    const entries = this.metrics.get(name) || [];
    const values = entries.map(e => e.value).sort((a, b) => a - b);
    
    const result = new Map<number, number>();
    
    if (values.length === 0) {
      return result;
    }

    for (const p of percentiles) {
      const index = Math.ceil((p / 100) * values.length) - 1;
      const value = values[Math.max(0, index)];
      if (value !== undefined) {
        result.set(p, value);
      }
    }

    return result;
  }

  /**
   * Get metric statistics
   */
  getStats(name: string): {
    count: number;
    min: number;
    max: number;
    avg: number;
    sum: number;
  } | null {
    const entries = this.metrics.get(name);
    
    if (!entries || entries.length === 0) {
      return null;
    }

    const values = entries.map(e => e.value);
    const sum = values.reduce((a, b) => a + b, 0);

    return {
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: sum / values.length,
      sum,
    };
  }

  /**
   * Export all metrics in Prometheus format
   */
  exportPrometheus(): string {
    const lines: string[] = [];

    // Export counters
    for (const [key, value] of this.counters) {
      lines.push(`# TYPE ${key.split('{')[0]} counter`);
      lines.push(`${key} ${value}`);
    }

    // Export gauges
    for (const [key, value] of this.gauges) {
      lines.push(`# TYPE ${key.split('{')[0]} gauge`);
      lines.push(`${key} ${value}`);
    }

    return lines.join('\n');
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics.clear();
    this.counters.clear();
    this.gauges.clear();
    this.logger.info('Metrics reset');
  }

  // Convenience methods for common metrics

  /**
   * Record a request
   */
  recordRequest(success: boolean, agentType: string, durationMs: number): void {
    this.incrementCounter('xorng_requests_total', {
      status: success ? 'success' : 'error',
      agent_type: agentType,
    });
    this.recordHistogram('xorng_request_duration_ms', durationMs, {
      agent_type: agentType,
    });
  }

  /**
   * Record an agent invocation
   */
  recordAgentInvocation(agentId: string, agentType: string, durationMs: number, success: boolean): void {
    this.incrementCounter('xorng_agent_invocations_total', {
      agent_id: agentId,
      agent_type: agentType,
      status: success ? 'success' : 'error',
    });
    this.recordHistogram('xorng_agent_duration_ms', durationMs, {
      agent_id: agentId,
      agent_type: agentType,
    });
  }

  /**
   * Record a memory operation
   */
  recordMemoryOperation(operation: 'read' | 'write' | 'search', memoryType: string, durationMs: number): void {
    this.incrementCounter('xorng_memory_operations_total', {
      operation,
      memory_type: memoryType,
    });
    this.recordHistogram('xorng_memory_operation_duration_ms', durationMs, {
      operation,
      memory_type: memoryType,
    });
  }

  /**
   * Update active connections gauge
   */
  setActiveConnections(count: number): void {
    this.setGauge('xorng_active_connections', count);
  }

  /**
   * Update memory usage gauge
   */
  setMemoryUsage(heapUsed: number, heapTotal: number): void {
    this.setGauge('xorng_memory_heap_used_bytes', heapUsed);
    this.setGauge('xorng_memory_heap_total_bytes', heapTotal);
  }
}
