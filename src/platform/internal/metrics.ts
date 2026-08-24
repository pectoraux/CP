// /platform/internal/metrics.ts
// Provider-neutral metrics interface (architecture §28). WORK-001 provides
// the interface boundary plus a no-op default; concrete telemetry backends
// are wired later without changing the contract.

export interface Counter {
  inc(value?: number, tags?: Record<string, string>): void;
}
export interface Histogram {
  observe(value: number, tags?: Record<string, string>): void;
}
export interface Gauge {
  set(value: number, tags?: Record<string, string>): void;
}

export interface Meter {
  counter(name: string, description?: string): Counter;
  histogram(
    name: string,
    description?: string,
    unit?: string,
    buckets?: readonly number[],
  ): Histogram;
  gauge(name: string, description?: string): Gauge;
}

const noopCounter: Counter = {
  inc: () => {},
};
const noopHistogram: Histogram = {
  observe: () => {},
};
const noopGauge: Gauge = {
  set: () => {},
};

/** Default no-op meter. Safe to use when no telemetry backend is configured. */
export const noopMeter: Meter = {
  counter: () => noopCounter,
  histogram: () => noopHistogram,
  gauge: () => noopGauge,
};
