/**
 * Metrics integration point (OBS-001).
 *
 * The frozen architecture requires application and workflow/job metrics but
 * does NOT mandate a specific vendor. This module defines the shared
 * abstraction that domain code uses. A concrete sink is plugged in at process
 * startup; the default {@link NoopMetricsSink} discards values safely.
 *
 * Future work items (e.g. an observability hardening work item) may register a
 * real sink (prom-client, OpenTelemetry, etc.) WITHOUT changing call sites in
 * domain modules.
 */
export interface MetricsSink {
  counter(name: string, value?: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  timing(name: string, durationMs: number, tags?: Record<string, string>): void;
}

class NoopMetricsSink implements MetricsSink {
  counter(): void {}
  gauge(): void {}
  timing(): void {}
}

let current: MetricsSink = new NoopMetricsSink();

/**
 * Install a concrete metrics sink. Called once at process startup.
 */
export function setMetricsSink(sink: MetricsSink): void {
  current = sink;
}

/**
 * Returns the active metrics sink. Domain modules call this through
 * `metrics()` rather than importing a concrete implementation, preserving the
 * integration point.
 */
export function metrics(): MetricsSink {
  return current;
}
