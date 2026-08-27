import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';

import { PgArchitectureAssertionRepository } from '../../../src/modules/architecture/internal/pg-architecture-repository.js';
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import {
  DefaultArchitectureCheckpointService,
  createDefaultDetectorRegistry,
  CHECKPOINT_RUN_SOURCE,
  CrossTenantCheckpointAccessError,
  type ArchitectureAssertionDetector,
  type DetectorInput,
  type DetectorResult,
  type ArchitectureCheckpointResult,
} from '../../../src/architecture-checkpoints/index.js';
import { generateExecutionId } from '@platform/ids.js';
import { createLogger, InMemoryObjectStore } from '@platform/index.js';

/**
 * WORK-051 — the ArchitectureCheckpointService (application-layer).
 *
 * Mandatory proofs (issue #51):
 *   1  a known architecture violation is detected BEFORE PR creation;
 *   2  evaluating the same assertion against the same revision is deterministic;
 *   3  checkpoint evidence is tied to exact ArchitectureVersion, WorkItem, and
 *      implementation revision;
 *   4  later revisions create DISTINCT immutable checkpoint results (a prior
 *      result is never overwritten);
 *   6  advisory failures do not block;
 *   7  inconclusive blocking assertions fail closed;
 *   9  cross-tenant checkpoint access is rejected BEFORE detector execution;
 *   11 WorkflowOS can evaluate ITSELF without gaining unchecked authority
 *      (self-hosting: real detectors over the real backend tree; checkpoint
 *      evidence is claim-authority, never authoritative criterion evidence).
 */
describe('WORK-051 — ArchitectureCheckpointService (application-layer orchestration)', () => {
  let stack: TestAuthStack;
  let assertionRepo: PgArchitectureAssertionRepository;
  let verificationService: DefaultVerificationService;
  let service: DefaultArchitectureCheckpointService;
  let org: { id: string };
  let user: { id: string };
  let project: { id: string };
  let otherProject: { id: string };

  // Counting detector — proves invocation counts (proof 9).
  let spyInvocations: number;
  const spyDetector: ArchitectureAssertionDetector = {
    detectorKind: 'spy-detector',
    async evaluate(_input: DetectorInput): Promise<DetectorResult> {
      spyInvocations++;
      return { status: 'pass', summary: 'spy pass' };
    },
  };

  const makeService = (detectors?: Map<string, ArchitectureAssertionDetector>) =>
    new DefaultArchitectureCheckpointService({
      workItemReader: stack.workItemRepository,
      architectureVersionReader: stack.architectureVersionRepository,
      architectureReader: stack.architectureRepository,
      assertionReader: assertionRepo,
      verificationService,
      detectors: detectors ?? createDefaultDetectorRegistry(),
      logger: createLogger({ level: 'silent' }),
    });

  beforeAll(async () => {
    stack = await buildAuthStack({});
    assertionRepo = new PgArchitectureAssertionRepository(stack.db.client);
    verificationService = new DefaultVerificationService(
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
    spyInvocations = 0;
    service = makeService(
      new Map([...createDefaultDetectorRegistry(), ['spy-detector', spyDetector]]),
    );

    org = await stack.organizationRepository.create({ name: 'Checkpoint Org' });
    user = await stack.userRepository.upsertByExternalId({ externalId: 'checkpoint-user', displayName: 'User' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Checkpoint Project' });
    otherProject = await stack.projectRepository.create({ organizationId: org.id, name: 'Other Project' });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  // --- helpers -----------------------------------------------------------

  const tempRoots: string[] = [];
  const makeTempTree = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'wfos-checkpoint-'));
    tempRoots.push(root);
    return root;
  };
  afterAll(() => {
    for (const r of tempRoots) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  /** A clean module tree (conformant). */
  const writeCleanTree = (root: string): void => {
    mkdirSync(join(root, 'src', 'modules', 'alpha', 'internal'), { recursive: true });
    mkdirSync(join(root, 'src', 'modules', 'beta', 'internal'), { recursive: true });
    writeFileSync(join(root, 'src', 'modules', 'alpha', 'index.ts'),
      "export type { Alpha } from './internal/alpha.types.js';\n");
    writeFileSync(join(root, 'src', 'modules', 'alpha', 'internal', 'alpha.types.ts'),
      'export interface Alpha { x: number }\n');
    writeFileSync(join(root, 'src', 'modules', 'beta', 'index.ts'),
      "export type { Beta } from './internal/beta.types.js';\n");
    writeFileSync(join(root, 'src', 'modules', 'beta', 'internal', 'beta.types.ts'),
      'export interface Beta { y: number }\n');
    // Legal cross-module import: alpha consumes beta's PUBLIC barrel.
    writeFileSync(join(root, 'src', 'modules', 'alpha', 'internal', 'uses-beta.ts'),
      "import type { Beta } from '@modules/beta/index.js';\nexport const b = (x: Beta): number => x.y;\n");
  };

  /** A tree carrying a KNOWN architecture violation: cross-module internal/ import. */
  const writeViolatingTree = (root: string): void => {
    writeCleanTree(root);
    writeFileSync(join(root, 'src', 'modules', 'alpha', 'internal', 'leak.ts'),
      "import type { Beta } from '@modules/beta/internal/beta.types.js';\nexport const leak = (b: Beta): number => b.y;\n");
  };

  const frozenVersionWithAssertions = async (
    assertions: Array<{
      assertionId: string;
      severity: 'blocking' | 'advisory';
      detectorKind: string;
      detectorConfig: Record<string, unknown>;
      scope?: 'repository' | 'module' | 'interface' | 'data' | 'workflow' | 'security' | 'execution' | 'other';
      statement?: string;
    }>,
  ): Promise<{ id: string }> => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    for (const a of assertions) {
      await assertionRepo.create({
        architectureVersionId: v.id,
        assertionId: a.assertionId,
        severity: a.severity,
        scope: a.scope ?? 'repository',
        statement: a.statement ?? `rule ${a.assertionId}`,
        detectorKind: a.detectorKind,
        detectorConfig: a.detectorConfig,
      });
    }
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    return v;
  };

  const workItemOn = async (versionId: string, metadata?: Record<string, unknown>) =>
    stack.workItemRepository.create({
      architectureVersionId: versionId,
      workItemId: `WI-${generateExecutionId()}`,
      title: 'WI',
      metadata,
    });

  // --- PROOF 1: a known violation is detected BEFORE PR creation ----------

  it('PROOF 1 — a known architecture violation (cross-module internal/ import) is detected at the PR conformance checkpoint, before any PR_OPEN transition', async () => {
    const badRoot = makeTempTree();
    writeViolatingTree(badRoot);
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-STRUCT',
        severity: 'blocking',
        detectorKind: 'repository-structure',
        detectorConfig: { rootDir: badRoot },
      },
    ]);
    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'deadbeef',
      executionId: generateExecutionId(),
    });
    expect(result.status).toBe('blocked');
    expect(result.allowed).toBe(false);
    expect(result.blockingFindings.join('\n')).toMatch(/leak\.ts: imports @modules\/beta\/internal/);
    expect(result.checkpointId).toBeTruthy();
  });

  // --- PROOF 2: determinism -------------------------------------------------

  it('PROOF 2 — evaluating the same assertion against the same revision is deterministic (two evaluations, deep-equal results)', async () => {
    const cleanRoot = makeTempTree();
    writeCleanTree(cleanRoot);
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-DET',
        severity: 'blocking',
        detectorKind: 'repository-structure',
        detectorConfig: { rootDir: cleanRoot },
      },
      {
        assertionId: 'ARCH-TEST-DET-2',
        severity: 'advisory',
        detectorKind: 'schema-migration',
        detectorConfig: { migrationsDir: join(cleanRoot, 'migrations') },
      },
    ]);
    const wi = await workItemOn(v.id);
    const input = {
      checkpointKind: 'pr_conformance' as const,
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'cafe1234',
      executionId: generateExecutionId(),
    };
    const a = await service.evaluateCheckpoint(input);
    const b = await service.evaluateCheckpoint(input);
    // The deterministic projection: status, per-assertion verdicts, findings.
    const projection = (r: ArchitectureCheckpointResult) => ({
      status: r.status,
      allowed: r.allowed,
      evaluations: r.evaluations.map((e) => ({
        assertionId: e.assertionId,
        status: e.status,
        summary: e.summary,
      })),
      blockingFindings: r.blockingFindings,
      advisories: r.advisories,
    });
    expect(projection(a)).toEqual(projection(b));
    expect(a.status).toBe('passed_with_advisories'); // advisory: no migrations dir ⇒ inconclusive advisory
  });

  // --- PROOF 3: evidence binding -------------------------------------------

  it('PROOF 3 — checkpoint evidence is tied to the exact ArchitectureVersion, WorkItem, and implementation revision', async () => {
    const cleanRoot = makeTempTree();
    writeCleanTree(cleanRoot);
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-BIND',
        severity: 'blocking',
        detectorKind: 'repository-structure',
        detectorConfig: { rootDir: cleanRoot },
      },
    ]);
    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'revision-sha-0001',
      executionId: generateExecutionId(),
    });
    expect(result.checkpointId).toBeTruthy();

    // The /verification run carries the full binding.
    const run = await verificationService.findRun(result.checkpointId!);
    expect(run).toBeTruthy();
    expect(run!.workItemId).toBe(wi.id);
    expect(run!.architectureVersionId).toBe(v.id);
    expect(run!.source).toBe(CHECKPOINT_RUN_SOURCE);
    expect(run!.sourceRef).toBe('revision-sha-0001');
    expect(run!.status).toBe('completed');
    expect(run!.metadata.checkpointKind).toBe('pr_conformance');

    // The evidence rows carry the revision + the assertion identity.
    const evidence = await verificationService.listEvidenceForRun(result.checkpointId!);
    const assertionEvidence = evidence.filter((e) => e.evidenceType === 'architecture-assertion');
    const summaryEvidence = evidence.filter((e) => e.evidenceType === 'architecture-checkpoint');
    expect(assertionEvidence).toHaveLength(1);
    expect(assertionEvidence[0]!.headSha).toBe('revision-sha-0001');
    expect(assertionEvidence[0]!.externalRef).toBe('ARCH-TEST-BIND');
    expect(assertionEvidence[0]!.metadata.architectureVersionId).toBe(v.id);
    expect(assertionEvidence[0]!.result).toBe('pass');
    expect(summaryEvidence).toHaveLength(1);
    expect(summaryEvidence[0]!.headSha).toBe('revision-sha-0001');
    expect(summaryEvidence[0]!.metadata.status).toBe('passed');

    // Frozen evidence hierarchy: machine-produced conformance evidence is
    // CLAIM authority — never authoritative criterion evidence.
    expect(assertionEvidence[0]!.authority).toBe('claim');
    expect(summaryEvidence[0]!.authority).toBe('claim');
  });

  // --- PROOF 4: later revisions create distinct immutable results ----------

  it('PROOF 4 — later revisions create DISTINCT immutable checkpoint results (the prior result is never overwritten)', async () => {
    const cleanRoot = makeTempTree();
    writeCleanTree(cleanRoot);
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-REV',
        severity: 'blocking',
        detectorKind: 'repository-structure',
        detectorConfig: { rootDir: cleanRoot },
      },
    ]);
    const wi = await workItemOn(v.id);

    const first = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-1',
      executionId: generateExecutionId(),
    });
    // Drift: the tree now carries a violation at rev-2.
    writeViolatingTree(cleanRoot);
    const second = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-2',
      executionId: generateExecutionId(),
    });

    expect(first.checkpointId).not.toBe(second.checkpointId);
    expect(first.status).toBe('passed');
    expect(second.status).toBe('blocked');

    // The FIRST result is immutable: the completed run rejects re-finalization
    // and its recorded evidence still reflects rev-1's pass.
    await expect(
      verificationService.finalizeOrchestrationRun({
        verificationRunId: first.checkpointId!,
        status: 'completed',
        summary: { tampered: true },
      }),
    ).rejects.toThrow(/already completed/);
    const firstRun = await verificationService.findRun(first.checkpointId!);
    expect(firstRun!.summary.status).toBe('passed');
    const firstEvidence = await verificationService.listEvidenceForRun(first.checkpointId!);
    expect(firstEvidence.every((e) => e.headSha === 'rev-1')).toBe(true);

    // Both revision-bound results persist (append-only history).
    const runs = await verificationService.listRunsForWorkItem(wi.id);
    const checkpointRuns = runs.filter((r) => r.source === CHECKPOINT_RUN_SOURCE);
    expect(checkpointRuns).toHaveLength(2);
    expect(new Set(checkpointRuns.map((r) => r.sourceRef))).toEqual(new Set(['rev-1', 'rev-2']));
  });

  // --- PROOF 6: advisory failures do not block ------------------------------

  it('PROOF 6 — advisory failures do not block (passed_with_advisories is allowed)', async () => {
    const badRoot = makeTempTree();
    writeViolatingTree(badRoot);
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-ADVISORY',
        severity: 'advisory',
        detectorKind: 'repository-structure',
        detectorConfig: { rootDir: badRoot },
      },
    ]);
    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-adv',
      executionId: generateExecutionId(),
    });
    expect(result.status).toBe('passed_with_advisories');
    expect(result.allowed).toBe(true);
    expect(result.advisories.join('\n')).toMatch(/leak\.ts/);
  });

  // --- PROOF 7: inconclusive blocking assertions fail closed ----------------

  it('PROOF 7a — an inconclusive BLOCKING assertion (unknown detector kind) fails closed', async () => {
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-UNKNOWN-KIND',
        severity: 'blocking',
        detectorKind: 'does-not-exist-detector',
        detectorConfig: {},
      },
    ]);
    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-unk',
      executionId: generateExecutionId(),
    });
    expect(result.status).toBe('blocked');
    expect(result.allowed).toBe(false);
    expect(result.blockingFindings.join('\n')).toMatch(/no detector is registered/);
  });

  it('PROOF 7b — an inconclusive BLOCKING assertion (misconfigured detector) fails closed', async () => {
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-BADCFG',
        severity: 'blocking',
        detectorKind: 'repository-structure',
        detectorConfig: {}, // rootDir missing
      },
    ]);
    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-badcfg',
      executionId: generateExecutionId(),
    });
    expect(result.status).toBe('blocked');
    expect(result.blockingFindings.join('\n')).toMatch(/rootDir is missing/);
  });

  it('PROOF 7c — a revision-bound checkpoint with NO revision is inconclusive and fails closed', async () => {
    const cleanRoot = makeTempTree();
    writeCleanTree(cleanRoot);
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-NOREV',
        severity: 'blocking',
        detectorKind: 'repository-structure',
        detectorConfig: { rootDir: cleanRoot },
      },
    ]);
    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: null,
      executionId: generateExecutionId(),
    });
    expect(result.status).toBe('inconclusive');
    expect(result.allowed).toBe(false);
  });

  it('PROOF 7d — a non-frozen governing version is inconclusive and fails closed (readiness)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const draft = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'still draft' });
    const wi = await workItemOn(draft.id);
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'readiness',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: null,
      executionId: generateExecutionId(),
    });
    expect(result.status).toBe('inconclusive');
    expect(result.allowed).toBe(false);
    expect(result.blockingFindings.join('\n')).toMatch(/not frozen/);
  });

  // --- PROOF 9: cross-tenant rejection BEFORE detector execution -------------

  it('PROOF 9 — cross-tenant checkpoint access is rejected BEFORE detector execution (zero detector invocations)', async () => {
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-TENANT',
        severity: 'blocking',
        detectorKind: 'spy-detector',
        detectorConfig: {},
      },
    ]);
    const wi = await workItemOn(v.id);
    const before = spyInvocations;
    await expect(
      service.evaluateCheckpoint({
        checkpointKind: 'pr_conformance',
        workItemId: wi.id,
        expectedProjectId: otherProject.id, // WRONG project context
        implementationRevision: 'rev-tenant',
        executionId: generateExecutionId(),
      }),
    ).rejects.toThrow(CrossTenantCheckpointAccessError);
    expect(spyInvocations).toBe(before); // ZERO detectors ran
  });

  // --- impact policy ---------------------------------------------------------

  it('impact policy — LOW runs the PR checkpoint only; HIGH (and the default) run all kinds; frequency never weakens severity', async () => {
    const badRoot = makeTempTree();
    writeViolatingTree(badRoot);
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-IMPACT',
        severity: 'blocking',
        detectorKind: 'repository-structure',
        detectorConfig: { rootDir: badRoot },
      },
    ]);

    // LOW impact: readiness/work_order/verification_entry are not applicable.
    const lowWi = await workItemOn(v.id, { architectureImpact: 'low' });
    for (const kind of ['readiness', 'work_order', 'verification_entry'] as const) {
      const r = await service.evaluateCheckpoint({
        checkpointKind: kind,
        workItemId: lowWi.id,
        expectedProjectId: project.id,
        implementationRevision: null,
        executionId: generateExecutionId(),
      });
      expect(r.applicable).toBe(false);
      expect(r.allowed).toBe(true);
      expect(r.checkpointId).toBeNull(); // no evidence for skipped checkpoints
    }
    // ...but the PR checkpoint still applies WITH full severity.
    const lowPr = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: lowWi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-low',
      executionId: generateExecutionId(),
    });
    expect(lowPr.applicable).toBe(true);
    expect(lowPr.status).toBe('blocked'); // the blocking assertion still blocks

    // HIGH impact (and the fail-closed default): all four kinds apply.
    const highWi = await workItemOn(v.id, { architectureImpact: 'high' });
    const defaultWi = await workItemOn(v.id); // no metadata → default high
    for (const wi of [highWi, defaultWi]) {
      for (const kind of ['readiness', 'work_order'] as const) {
        const r = await service.evaluateCheckpoint({
          checkpointKind: kind,
          workItemId: wi.id,
          expectedProjectId: project.id,
          implementationRevision: null,
          executionId: generateExecutionId(),
        });
        expect(r.applicable).toBe(true);
        expect(r.status).toBe('blocked'); // the blocking assertion runs at full severity
      }
    }
  });

  // --- idempotent replay -------------------------------------------------------

  it('idempotent replay — the same idempotency key replays the recorded result without re-evaluating', async () => {
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-REPLAY',
        severity: 'blocking',
        detectorKind: 'spy-detector',
        detectorConfig: {},
      },
    ]);
    const wi = await workItemOn(v.id);
    const key = `replay-${generateExecutionId()}`;
    const before = spyInvocations;

    const first = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-replay',
      executionId: generateExecutionId(),
      idempotencyKey: key,
    });
    expect(first.replayed).toBe(false);
    expect(spyInvocations).toBe(before + 1);

    const replayed = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-replay',
      executionId: generateExecutionId(),
      idempotencyKey: key,
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.checkpointId).toBe(first.checkpointId);
    expect(replayed.status).toBe(first.status);
    expect(replayed.allowed).toBe(first.allowed);
    expect(spyInvocations).toBe(before + 1); // detector did NOT run again
  });

  // --- PROOF 11: self-hosting ----------------------------------------------------

  it('PROOF 11 — WorkflowOS evaluates ITSELF: real detectors over the real backend tree pass, with claim-authority evidence and no architecture mutation path', async () => {
    const backendRoot = join(__dirname, '..', '..', '..');
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-SELF-001',
        severity: 'blocking',
        scope: 'repository',
        statement: 'No module imports another module internal/ (frozen module boundaries).',
        detectorKind: 'repository-structure',
        detectorConfig: { rootDir: backendRoot },
      },
      {
        assertionId: 'ARCH-SELF-002',
        severity: 'blocking',
        scope: 'module',
        statement: 'The workflow engine authority is implemented only by /workflows.',
        detectorKind: 'authority-ownership',
        detectorConfig: {
          rootDir: backendRoot,
          ownerModule: 'workflows',
          authorityInterface: 'WorkflowEngine',
        },
      },
      {
        assertionId: 'ARCH-SELF-003',
        severity: 'blocking',
        scope: 'interface',
        statement: 'The /architecture public barrel exposes the assertion reader contract.',
        detectorKind: 'interface-contract',
        detectorConfig: {
          rootDir: backendRoot,
          moduleDir: 'architecture',
          symbol: 'ArchitectureAssertionReader',
        },
      },
      {
        assertionId: 'ARCH-SELF-004',
        severity: 'blocking',
        scope: 'workflow',
        statement: 'The canonical workflow transition graph matches the frozen v1.0 map.',
        detectorKind: 'workflow-transition',
        detectorConfig: {
          rootDir: backendRoot,
          transitionsFile: 'src/modules/workflows/internal/workflow.types.ts',
          expectedTransitions: {
            draft: ['ready'],
            ready: ['assigned'],
            assigned: ['implementing', 'implementation_blocked'],
            implementing: ['pr_open', 'implementation_blocked'],
            pr_open: ['verifying'],
            verifying: ['verification_failed', 'architect_review', 'implementation_blocked'],
            verification_failed: ['implementing'],
            architect_review: ['changes_requested', 'architecture_change_required', 'approved'],
            changes_requested: ['implementing'],
            architecture_change_required: ['architecture_change_request'],
            architecture_change_request: [],
            implementation_blocked: ['implementing'],
            approved: ['merged'],
            merged: ['verified'],
            verified: [],
          },
        },
      },
      {
        assertionId: 'ARCH-SELF-005',
        severity: 'blocking',
        scope: 'security',
        statement: 'The checkpoint subsystem declares no scheduler in the initial increment.',
        detectorKind: 'runtime-configuration',
        detectorConfig: {
          rootDir: backendRoot,
          forbiddenPatterns: [
            {
              pathIncludes: 'architecture-checkpoints',
              pattern: 'setInterval|setTimeout\\(|\\bcron\\b',
              description: 'scheduler-driven checkpoint execution',
            },
          ],
        },
      },
      {
        assertionId: 'ARCH-SELF-006',
        severity: 'blocking',
        scope: 'data',
        statement: 'The migration sequence is intact and pinned at the current head.',
        detectorKind: 'schema-migration',
        detectorConfig: {
          migrationsDir: join(backendRoot, 'src', 'platform', 'postgres', 'migrations'),
          expectedLastMigrationNumber: 52,
        },
      },
    ]);

    const wi = await workItemOn(v.id, { architectureImpact: 'high' });
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'self-hosting-rev',
      executionId: generateExecutionId(),
    });

    // The real WorkflowOS tree conforms to its own frozen architecture.
    expect(result.status).toBe('passed');
    expect(result.allowed).toBe(true);
    expect(result.evaluations).toHaveLength(6);
    for (const e of result.evaluations) {
      expect(e.status, `${e.assertionId}: ${e.summary}`).toBe('pass');
    }

    // The evidence is claim-authority (machine conformance evidence is
    // traceable context — it can never masquerade as authoritative criterion
    // evidence; the self-hosted loop cannot self-certify).
    const evidence = await verificationService.listEvidenceForRun(result.checkpointId!);
    expect(evidence.length).toBe(7); // 6 assertions + 1 summary
    expect(evidence.every((e) => e.authority === 'claim')).toBe(true);
  });

  // --- work order context (traceability) ------------------------------------------

  it('records the Work Order context in the checkpoint evidence when provided', async () => {
    const cleanRoot = makeTempTree();
    writeCleanTree(cleanRoot);
    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-TEST-WO',
        severity: 'blocking',
        detectorKind: 'repository-structure',
        detectorConfig: { rootDir: cleanRoot },
      },
    ]);
    const wi = await workItemOn(v.id);
    const wo = await stack.workOrderRepository.create({
      workItemId: wi.id,
      projectId: project.id,
      architectureVersionId: v.id,
    });
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'work_order',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: null,
      executionId: generateExecutionId(),
      workOrderId: wo.id,
    });
    expect(result.status).toBe('passed');
    const run = await verificationService.findRun(result.checkpointId!);
    expect(run!.workOrderId).toBe(wo.id);
    expect(run!.metadata.workOrderId).toBe(wo.id);
  });
});
