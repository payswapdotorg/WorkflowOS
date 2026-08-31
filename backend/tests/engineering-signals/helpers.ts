/**
 * WORK-067 test helpers — deterministic fixtures for the engineering
 * signal correlation suite. No wall-clock reads: every clock is injected;
 * every observation time is a recorded fixture value.
 */
import {
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
} from '../../src/engineering-signals/index.js';
import type {
  EngineeringSignalService,
  RawObservationInput,
  ReleaseCorrelationContext,
  SignalObservationReference,
} from '../../src/engineering-signals/index.js';

/** A fixed, deterministic clock (the injected-time discipline). */
export function fixedClock(startIso: string, stepMs = 0): () => Date {
  let current = Date.parse(startIso);
  return () => {
    const now = new Date(current);
    current += stepMs;
    return now;
  };
}

/** A raw observation fixture (fully-specified; override per test). */
export function observationFixture(overrides: Partial<RawObservationInput> = {}): RawObservationInput {
  return {
    source: 'validation',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    environmentId: 'env-prod-1',
    logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-total',
    severity: 'high',
    observedAt: '2026-09-01T12:00:00Z',
    observationRef: {
      kind: 'validation-run',
      ref: 'run-1',
      detail: 'failure: step-pay/expectation-total',
    },
    raw: { failedStepId: 'step-pay', expected: 'total is 3 items', actual: null },
    releaseRef: null,
    ...overrides,
  };
}

/** A CI-source observation fixture (a heterogeneous-source example). */
export function ciObservationFixture(overrides: Partial<RawObservationInput> = {}): RawObservationInput {
  return observationFixture({
    source: 'ci',
    logicalFailureKey: 'ci:workflow:backend-tests',
    severity: 'high',
    observedAt: '2026-09-01T13:00:00Z',
    observationRef: {
      kind: 'ci-evidence',
      ref: 'wfos_github_ci_evidence:42',
      detail: 'workflow backend-tests conclusion=failure',
    },
    raw: { workflowName: 'backend-tests', conclusion: 'failure', headSha: 'abc123' },
    ...overrides,
  });
}

/** A release correlation context fixture (the RECORDED release identity). */
export function releaseContextFixture(overrides: Partial<ReleaseCorrelationContext> = {}): ReleaseCorrelationContext {
  return {
    releaseRef: 'release-2026.09.01',
    releasedAt: '2026-09-01T12:30:00Z',
    projectId: 'project-1',
    recordedVia: 'caller-declared',
    ...overrides,
  };
}

/** Build the service with the in-memory repository + an injected clock. */
export function buildService(clock: () => Date = fixedClock('2026-09-02T00:00:00Z')): {
  service: EngineeringSignalService;
  repository: InMemoryEngineeringSignalRepository;
  clock: () => Date;
} {
  const repository = new InMemoryEngineeringSignalRepository();
  const service = new DefaultEngineeringSignalService({
    signalRepository: repository,
    logger: undefined,
    now: clock,
  });
  return { service, repository, clock };
}

/** A reference fixture for provenance-preservation assertions. */
export function refFixture(overrides: Partial<SignalObservationReference> = {}): SignalObservationReference {
  return { kind: 'validation-run', ref: 'run-9', ...overrides };
}
