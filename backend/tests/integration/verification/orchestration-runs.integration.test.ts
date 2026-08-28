import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { createLogger, InMemoryObjectStore } from '@platform/index.js';

import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import { generateExecutionId } from '@platform/ids.js';

/**
 * WORK-051 round 1 (PR #52 review, BLOCKER 4 + crash safety) — the
 * /verification-owned ORCHESTRATION RECORD contract:
 *
 *   - the durable orchestration identity (UNIQUE indexed column — one run
 *     per key, persistence-enforced);
 *   - recordOrchestrationRun: the ATOMIC record (run + evidence + terminal
 *     finalization in ONE transaction — a crash leaves nothing);
 *   - the convergence semantics (same key → the existing run returned
 *     unchanged, nothing appended);
 *   - the legacy-partial ADOPTION path (a non-terminal run for the key is
 *     reconciled in one atomic step);
 *   - finalizeOrchestrationRun as a CAS transition (exactly-once).
 */
describe('WORK-051 round 1 — /verification orchestration runs (durable identity + atomic record)', () => {
  let stack: TestAuthStack;
  let service: DefaultVerificationService;
  let org: { id: string };
  let user: { id: string };
  let project: { id: string };
  let versionId: string;
  let workItemId: string;

  beforeAll(async () => {
    stack = await buildAuthStack({});
    service = new DefaultVerificationService(
      stack.db.client,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.workItemRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.ciEvidenceRepository,
      new InMemoryObjectStore(),
      createLogger({ level: 'silent' }),
    );
    org = await stack.organizationRepository.create({ name: 'Orch Run Org' });
    user = await stack.userRepository.upsertByExternalId({ externalId: 'orch-run-user', displayName: 'User' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Orch Run Project' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Orch Run Arch' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    versionId = v.id;
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionId,
      workItemId: `WI-${generateExecutionId()}`,
      title: 'orchestration run fixture',
    });
    workItemId = wi.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  const recordInput = (key: string) => ({
    run: {
      projectId: project.id,
      workItemId,
      architectureVersionId: versionId,
      source: 'architecture-checkpoint',
      sourceRef: 'rev-orch',
      executionId: generateExecutionId(),
      metadata: { checkpointKind: 'pr_conformance' },
      orchestrationKey: key,
    },
    evidence: [
      {
        evidenceType: 'architecture-assertion',
        provider: 'architecture-checkpoint',
        externalRef: 'ARCH-ORCH-1',
        headSha: 'rev-orch',
        result: 'fail' as const,
        contentSummary: 'fail: violation',
        metadata: { assertionId: 'ARCH-ORCH-1' },
      },
      {
        evidenceType: 'architecture-checkpoint',
        provider: 'architecture-checkpoint',
        externalRef: 'pr_conformance',
        headSha: 'rev-orch',
        result: 'fail' as const,
        contentSummary: 'blocked: 1 blocking',
        metadata: { status: 'blocked' },
      },
    ],
    finalize: {
      status: 'completed' as const,
      summary: { checkpointKind: 'pr_conformance', status: 'blocked', allowed: false },
    },
  });

  it('recordOrchestrationRun — creates the run + evidence + terminal state ATOMICALLY (created: true)', async () => {
    const input = recordInput(`orch-atomic-${generateExecutionId()}`);
    const { run, created } = await service.recordOrchestrationRun(input);

    expect(created).toBe(true);
    expect(run.status).toBe('completed');
    expect(run.orchestrationKey).toBe(input.run.orchestrationKey);
    expect(run.finishedAt).toBeTruthy();

    // The evidence set: every row attached, claim authority (the orchestration
    // path is NEVER authoritative evidence).
    const evidence = await service.listEvidenceForRun(run.id);
    expect(evidence.length).toBe(2);
    expect(evidence.every((e) => e.authority === 'claim')).toBe(true);
  });

  it('convergence — a SECOND record with the SAME key returns the existing terminal run UNCHANGED (nothing appended)', async () => {
    const key = `orch-converge-${generateExecutionId()}`;
    const first = await service.recordOrchestrationRun(recordInput(key));
    expect(first.created).toBe(true);

    const second = await service.recordOrchestrationRun(recordInput(key));
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    // The evidence set is NOT doubled.
    const evidence = await service.listEvidenceForRun(second.run.id);
    expect(evidence.length).toBe(2);
  });

  it('findOrchestrationRun — the durable identity lookup (no metadata scanning)', async () => {
    const key = `orch-find-${generateExecutionId()}`;
    const { run } = await service.recordOrchestrationRun(recordInput(key));
    const found = await service.findOrchestrationRun(key);
    expect(found?.id).toBe(run.id);
    expect(found?.orchestrationKey).toBe(key);
    expect(await service.findOrchestrationRun(`missing-${generateExecutionId()}`)).toBeNull();
  });

  it('UNIQUE identity — a second run with the SAME key is impossible even via direct SQL (persistence-enforced)', async () => {
    const key = `orch-unique-${generateExecutionId()}`;
    await service.recordOrchestrationRun(recordInput(key));
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_verification_runs
           (project_id, work_item_id, architecture_version_id, source, source_ref, status,
            execution_id, started_at, metadata, orchestration_key)
         VALUES ($1, $2, $3, 'architecture-checkpoint', 'rev-orch', 'pending', $4, NOW(), '{}', $5)`,
        [project.id, workItemId, versionId, generateExecutionId(), key],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('adoption — a NON-TERMINAL legacy run for the key is reconciled atomically (evidence + finalization)', async () => {
    const key = `orch-adopt-${generateExecutionId()}`;
    // Simulate a pre-transactional-era partial: a pending run row with the
    // key but NO evidence and NO terminal state.
    await stack.db.client.query(
      `INSERT INTO wfos_verification_runs
         (project_id, work_item_id, architecture_version_id, source, source_ref, status,
          execution_id, started_at, metadata, orchestration_key)
       VALUES ($1, $2, $3, 'architecture-checkpoint', 'rev-orch', 'pending', $4, NOW(), '{}', $5)`,
      [project.id, workItemId, versionId, generateExecutionId(), key],
    );
    const partial = await service.findOrchestrationRun(key);
    expect(partial?.status).toBe('pending');

    // The atomic record ADOPTS the partial: attaches evidence + finalizes.
    const { run, created } = await service.recordOrchestrationRun(recordInput(key));
    expect(created).toBe(false);
    expect(run.id).toBe(partial!.id);
    expect(run.status).toBe('completed');
    const evidence = await service.listEvidenceForRun(run.id);
    expect(evidence.length).toBe(2);
  });

  it('crash safety — a record whose evidence insert FAILS leaves NOTHING (the whole transaction aborts)', async () => {
    const key = `orch-crash-${generateExecutionId()}`;
    const input = recordInput(key);
    // Poison one evidence row so the insert fails mid-transaction.
    const poisoned = {
      ...input,
      evidence: [
        input.evidence[0]!,
        {
          ...input.evidence[1]!,
          // An invalid result value violates the closed CHECK constraint —
          // the transaction aborts AFTER the run row insert.
          result: 'bogus-result' as never,
        },
      ],
    };
    await expect(service.recordOrchestrationRun(poisoned)).rejects.toThrow();

    // NOTHING persisted: no run for the key (no pending row, no evidence).
    const orphan = await service.findOrchestrationRun(key);
    expect(orphan).toBeNull();
  });

  it('finalizeOrchestrationRun — a CAS terminal transition: exactly-once, re-finalization rejected', async () => {
    // Create a pending run directly through createRun (the legacy path).
    const pending = await service.createRun({
      projectId: project.id,
      workItemId,
      architectureVersionId: versionId,
      source: 'architecture-checkpoint',
      sourceRef: 'rev-orch',
      executionId: generateExecutionId(),
      metadata: {},
    });
    expect(pending.status).toBe('pending');

    const finalized = await service.finalizeOrchestrationRun({
      verificationRunId: pending.id,
      status: 'completed',
      summary: { checkpointKind: 'pr_conformance', status: 'passed' },
    });
    expect(finalized.status).toBe('completed');

    // Exactly once: the second finalization is rejected (immutable history).
    await expect(
      service.finalizeOrchestrationRun({
        verificationRunId: pending.id,
        status: 'failed',
        summary: {},
      }),
    ).rejects.toThrow(/finalized exactly once/i);
    // The original terminal summary survives.
    const reread = await service.findRun(pending.id);
    expect(reread!.status).toBe('completed');
    expect(reread!.summary.status).toBe('passed');

    // A MISSING run id is a typed error.
    await expect(
      service.finalizeOrchestrationRun({
        verificationRunId: '00000000-0000-0000-0000-000000000000',
        status: 'completed',
        summary: {},
      }),
    ).rejects.toThrow(/not found/i);
  });
});
