/**
 * Error-tracking integration point (OBS-001).
 *
 * The frozen architecture requires error tracking but does NOT mandate a
 * specific vendor. Domain modules report errors through this shared
 * abstraction; a concrete tracker (e.g. Sentry, OTLP exporter) can be plugged
 * in at process startup without coupling domain code to a provider.
 */
export interface ErrorTracker {
  capture(error: Error, context?: Record<string, unknown>): void;
}

class NoopErrorTracker implements ErrorTracker {
  capture(): void {}
}

let current: ErrorTracker = new NoopErrorTracker();

/**
 * Install a concrete error tracker. Called once at process startup.
 */
export function setErrorTracker(tracker: ErrorTracker): void {
  current = tracker;
}

/**
 * Returns the active error tracker. Domain modules call this through
 * `errorTracker()` rather than importing a concrete provider.
 */
export function errorTracker(): ErrorTracker {
  return current;
}
