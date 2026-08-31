import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the deduplication proofs.
 *
 * Proof matrix §C: sequential duplicate; repeated delivery; cross-source
 * convergence; the tenant/project/environment discrimination; restart
 * behavior appropriate to the actual persistence model (the in-memory
 * adapter: a restart is a fresh composition — signals are re-derivable
 * deterministically from re-delivered observations, which is the
 * documented non-durable boundary; the durable ACR binding point is the
 * port).
 */
import { observationFixture, ciObservationFixture, buildService, fixedClock } from './helpers.js';
import { EngineeringSignalError } from '../../src/engineering-signals/index.js';

describe('WORK-067 — deduplication convergence', () => {
  it('sequential duplicate: the same logical failure observed twice (two runs) → ONE signal identity, TWO occurrences', async () => {
    const { service } = buildService();
    const first = await service.ingestObservation(
      observationFixture({ observationRef: { kind: 'validation-run', ref: 'run-1' }, observedAt: '2026-09-01T12:00:00Z' }),
    );
    const second = await service.ingestObservation(
      observationFixture({ observationRef: { kind: 'validation-run', ref: 'run-2' }, observedAt: '2026-09-01T15:00:00Z' }),
    );
    expect(first.outcome).toBe('signal-created');
    expect(second.outcome).toBe('occurrence-appended');
    expect(second.signal.signalId).toBe(first.signal.signalId);
    expect(second.signal.occurrences).toHaveLength(2);
    // no duplicate LOGICAL signal exists
    const listed = await service.listSignalsForProject('project-1');
    expect(listed).toHaveLength(1);
  });

  it('repeated delivery: the EXACT same observation delivered twice → duplicate-suppressed (nothing appended)', async () => {
    const { service } = buildService();
    const observation = observationFixture({ observationRef: { kind: 'validation-run', ref: 'run-1' }, observedAt: '2026-09-01T12:00:00Z' });
    const first = await service.ingestObservation(observation);
    const second = await service.ingestObservation(observation);
    expect(first.outcome).toBe('signal-created');
    expect(second.outcome).toBe('duplicate-suppressed');
    expect(second.signal.occurrences).toHaveLength(1);
    expect(second.occurrenceId).toBe(first.occurrenceId);
  });

  it('cross-source convergence: the same logical failure observed by validation AND CI sources → ONE signal, occurrences from both sources, sources=[both]', async () => {
    const { service } = buildService();
    const validationObservation = observationFixture({
      logicalFailureKey: 'checkout-payment-failure',
      observationRef: { kind: 'validation-run', ref: 'run-1' },
      observedAt: '2026-09-01T12:00:00Z',
    });
    const ciObservation = ciObservationFixture({
      logicalFailureKey: 'checkout-payment-failure',
      observationRef: { kind: 'ci-evidence', ref: 'row-42' },
      observedAt: '2026-09-01T13:00:00Z',
    });
    const first = await service.ingestObservation(validationObservation);
    const second = await service.ingestObservation(ciObservation);
    expect(second.signal.signalId).toBe(first.signal.signalId);
    expect(second.signal.occurrences).toHaveLength(2);
    expect(new Set(second.signal.sources)).toEqual(new Set(['validation', 'ci']));
  });

  it('different tenant → TWO signals (no cross-tenant collapse)', async () => {
    const { service } = buildService();
    await service.ingestObservation(observationFixture({ tenantId: 'tenant-1', logicalFailureKey: 'failure-x' }));
    await service.ingestObservation(observationFixture({ tenantId: 'tenant-2', logicalFailureKey: 'failure-x' }));
    const listed = await service.listSignalsForProject('project-1');
    expect(listed).toHaveLength(2);
    const tenants = new Set(listed.map((s) => s.tenantId));
    expect(tenants).toEqual(new Set(['tenant-1', 'tenant-2']));
  });

  it('different project → TWO signals (no cross-project collapse)', async () => {
    const { service } = buildService();
    await service.ingestObservation(observationFixture({ projectId: 'project-1', logicalFailureKey: 'failure-x' }));
    await service.ingestObservation(observationFixture({ projectId: 'project-2', logicalFailureKey: 'failure-x' }));
    const forProject1 = await service.listSignalsForProject('project-1');
    const forProject2 = await service.listSignalsForProject('project-2');
    expect(forProject1).toHaveLength(1);
    expect(forProject2).toHaveLength(1);
    expect(forProject1[0]!.signalId).not.toBe(forProject2[0]!.signalId);
  });

  it('different environment → TWO signals (preview and production are distinct signals)', async () => {
    const { service } = buildService();
    await service.ingestObservation(observationFixture({ environmentId: 'env-prod-1', logicalFailureKey: 'failure-x' }));
    await service.ingestObservation(observationFixture({ environmentId: 'env-preview-9', logicalFailureKey: 'failure-x' }));
    const listed = await service.listSignalsForProject('project-1');
    expect(listed).toHaveLength(2);
  });

  it('different logical failure → TWO signals (no failure collapse)', async () => {
    const { service } = buildService();
    await service.ingestObservation(observationFixture({ logicalFailureKey: 'failure-x' }));
    await service.ingestObservation(observationFixture({ logicalFailureKey: 'failure-y' }));
    const listed = await service.listSignalsForProject('project-1');
    expect(listed).toHaveLength(2);
  });

  it('restart behavior (the in-memory model): a fresh composition re-derives the SAME signal identity from re-delivered observations (deterministic identities; the non-durable boundary is the documented port)', async () => {
    const observation = observationFixture({ observationRef: { kind: 'validation-run', ref: 'run-1' }, observedAt: '2026-09-01T12:00:00Z' });
    const first = buildService(fixedClock('2026-09-02T00:00:00Z'));
    const result1 = await first.service.ingestObservation(observation);
    // "restart" — a fresh composition (the in-memory adapter is per-process):
    const second = buildService(fixedClock('2026-09-03T00:00:00Z'));
    const result2 = await second.service.ingestObservation({ ...observation });
    expect(result2.signal.signalId).toBe(result1.signal.signalId);
    expect(result2.signal.occurrences.map((o) => o.occurrenceId)).toEqual(result1.signal.occurrences.map((o) => o.occurrenceId));
  });

  it('deterministic identities under DIFFERENT injected clocks: the signal + occurrence ids are clock-independent (the clock governs only bookkeeping)', async () => {
    const observation = observationFixture({ observationRef: { kind: 'validation-run', ref: 'run-1' }, observedAt: '2026-09-01T12:00:00Z' });
    const a = buildService(fixedClock('2026-09-02T00:00:00Z'));
    const b = buildService(fixedClock('2027-01-01T00:00:00Z'));
    const resultA = await a.service.ingestObservation(observation);
    const resultB = await b.service.ingestObservation(observation);
    expect(resultA.signal.signalId).toBe(resultB.signal.signalId);
    expect(resultA.occurrenceId).toBe(resultB.occurrenceId);
  });
});

describe('WORK-067 — ingestion fail-closed vocabulary', () => {
  it('an unknown source fails closed (typed SIGNAL_SOURCE_UNKNOWN)', async () => {
    const { service } = buildService();
    await expect(
      service.ingestObservation(observationFixture({ source: 'carrier-pigeon' as never })),
    ).rejects.toThrowError(EngineeringSignalError);
    // nothing was recorded (fail-closed — no partial state)
    expect(await service.listSignalsForProject('project-1')).toHaveLength(0);
  });

  it('an unknown severity fails closed (typed SIGNAL_SEVERITY_UNKNOWN)', async () => {
    const { service } = buildService();
    await expect(
      service.ingestObservation(observationFixture({ severity: 'catastrophic' as never })),
    ).rejects.toThrowError(EngineeringSignalError);
    expect(await service.listSignalsForProject('project-1')).toHaveLength(0);
  });

  it('a missing raw payload fails closed (no free-floating signals)', async () => {
    const { service } = buildService();
    await expect(service.ingestObservation(observationFixture({ raw: undefined }))).rejects.toThrowError(
      /raw observation payload is required/,
    );
  });

  it('an invalid observation time fails closed (the recorded-time discipline)', async () => {
    const { service } = buildService();
    await expect(service.ingestObservation(observationFixture({ observedAt: 'yesterday-ish' }))).rejects.toThrowError(
      /ISO-8601/,
    );
  });

  it('a missing observation reference fails closed (the provenance anchor)', async () => {
    const { service } = buildService();
    await expect(
      service.ingestObservation(observationFixture({ observationRef: { kind: '', ref: 'run-1' } })),
    ).rejects.toThrowError(/reference requires a non-empty kind/);
  });
});
