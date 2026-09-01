import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WORK-067 — the module composition proofs: the domain is composed through
 * the EXISTING application composition (buildApp) and exposed on AppDeps
 * for the FUTURE governed consumers (WORK-068/070) — the WORK-064/065
 * precedent. The barrel exports the full public contract; the composition
 * binds the in-memory repository + the WORK-064 authority + the injected
 * clock.
 */
import {
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
  SIGNAL_SOURCES,
  SIGNAL_SEVERITIES,
  SEVERITY_ORDER,
  ENGINEERING_SIGNAL_ERROR_CODES,
  INGEST_OUTCOMES,
  type EngineeringSignalService,
} from '../../src/engineering-signals/index.js';
import { observationFixture, fixedClock } from './helpers.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const APP_TS = join(REPO_ROOT, 'backend', 'src', 'app.ts');

describe('WORK-067 — module composition', () => {
  it('the barrel exports the complete public contract (the vocabularies, the errors, the outcomes, the service + the repository adapter)', () => {
    // the closed vocabularies
    expect([...SIGNAL_SOURCES]).toHaveLength(7);
    expect([...SIGNAL_SEVERITIES]).toEqual(['critical', 'high', 'medium', 'low']);
    expect(SEVERITY_ORDER).toEqual({ low: 0, medium: 1, high: 2, critical: 3 });
    // the typed error surface (fail-closed codes)
    expect(ENGINEERING_SIGNAL_ERROR_CODES).toContain('SIGNAL_SOURCE_UNKNOWN');
    expect(ENGINEERING_SIGNAL_ERROR_CODES).toContain('SIGNAL_IDENTITY_CONFLICT');
    expect(ENGINEERING_SIGNAL_ERROR_CODES).toContain('SIGNAL_RELEASE_REF_REQUIRED');
    // the ingestion outcome vocabulary
    expect([...INGEST_OUTCOMES]).toEqual(['signal-created', 'occurrence-appended', 'duplicate-suppressed']);
    // the composition classes
    expect(typeof DefaultEngineeringSignalService).toBe('function');
    expect(typeof InMemoryEngineeringSignalRepository).toBe('function');
  });

  it('the service is constructible with the documented composition deps (the in-memory repository + the injected clock; the WORK-064 authority optional in unit composition)', async () => {
    const service: EngineeringSignalService = new DefaultEngineeringSignalService({
      signalRepository: new InMemoryEngineeringSignalRepository(),
      now: fixedClock('2026-09-02T00:00:00Z'),
    });
    const result = await service.ingestObservation(observationFixture());
    expect(result.outcome).toBe('signal-created');
    // The WORK-064-bound ingestion fails closed without the authority:
    await expect(
      service.ingestValidationRun({ runId: 'run-x', projectId: 'project-1', tenantId: 'tenant-1' }),
    ).rejects.toThrowError(/not bound to this service/);
  });

  it('app.ts composes the service (the WORK-064 authority + the in-memory repository + the injected clock) and exposes it on AppDeps', () => {
    const appTs = readFileSync(APP_TS, 'utf8');
    // The import:
    expect(appTs).toMatch(/import \{\s*\n\s*DefaultEngineeringSignalService,\s*\n\s*InMemoryEngineeringSignalRepository,\s*\n\} from '\.\/engineering-signals\/index\.js';/);
    // The AppDeps field:
    expect(appTs).toMatch(/engineeringSignalService\?: EngineeringSignalService;/);
    // The composition: the WORK-064 service + the in-memory repository + the injected clock:
    expect(appTs).toMatch(/engineeringSignalService = new DefaultEngineeringSignalService\(\{\s*\n\s*signalRepository: new InMemoryEngineeringSignalRepository\(\),\s*\n\s*continuousValidationService: continuousValidationService!,/);
    // The deps return (evolved with the WORK-069 activation: the
    // progressive-release decision service is composed immediately after
    // the engineering-signal service it consumes — the WORK-069
    // feedback-binding layer):
    expect(appTs).toMatch(/\n\s*engineeringSignalService,\s*\n\s*progressiveReleaseService,\s*\n\s*reviewService,/);
  });
});
