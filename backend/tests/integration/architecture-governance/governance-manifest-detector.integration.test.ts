import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgArchitectureAssertionRepository } from '../../../src/modules/architecture/internal/pg-architecture-repository.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import {
  DefaultArchitectureCheckpointService,
  GithubRepositorySnapshotProvider,
  type RepositorySnapshot,
  type ArchitectureAssertionDetector,
  type DetectorInput,
  type DetectorResult,
  type SnapshotDirEntry,
} from '../../../src/architecture-checkpoints/index.js';
import { GovernanceManifestDetector } from '../../../src/architecture-checkpoints/internal/detectors/governance-manifest.detector.js';
import { SnapshotReadError } from '../../../src/architecture-checkpoints/types.js';
import { generateExecutionId } from '@platform/ids.js';
import { createLogger, InMemoryObjectStore } from '@platform/index.js';

/**
 * WORK-052 — the `governance-manifest` detector (ADR-0006): the
 * development-governance state evaluated AT THE BOUND REVISION through the
 * existing checkpoint substrate, with durable /verification evidence —
 * WorkflowOS checking its own control plane. Runs on real PostgreSQL
 * (buildAuthStack) exactly like the WORK-051 checkpoint suite.
 */
describe('WORK-052 — the governance-manifest detector (self-hosting boundary at the checkpoint substrate)', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const GOVERNANCE_DIR = join(REPO_ROOT, 'spec', 'development-state');
  const REAL_MODEL_TEXT = readFileSync(join(GOVERNANCE_DIR, 'governance-model.json'), 'utf8');
  const REAL_PROGRAM_TEXT = readFileSync(join(GOVERNANCE_DIR, 'program-state.json'), 'utf8');

  let stack: TestAuthStack;
  let assertionRepo: PgArchitectureAssertionRepository;
  let verificationService: DefaultVerificationService;
  let fakeGithub: FakeGitHubAdapter;
  let service: DefaultArchitectureCheckpointService;
  let org: { id: string };
  let user: { id: string };
  let project: { id: string };
  let otherProject: { id: string };

  const OWNER = 'gov-manifest-org';
  const REPO = 'gov-manifest-repo';
  const OTHER_REPO = 'gov-manifest-other-repo';

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
    fakeGithub = new FakeGitHubAdapter();
    service = new DefaultArchitectureCheckpointService({
      workItemReader: stack.workItemRepository,
      architectureVersionReader: stack.architectureVersionRepository,
      architectureReader: stack.architectureRepository,
      assertionReader: assertionRepo,
      verificationService,
      snapshotReader: new GithubRepositorySnapshotProvider(
        new PgProjectGitHubRepositoryRepository(stack.db.client),
        fakeGithub,
      ),
      detectors: new Map([['governance-manifest', new GovernanceManifestDetector()]]),
      logger: createLogger({ level: 'silent' }),
    });

    org = await stack.organizationRepository.create({ name: 'Governance Manifest Org' });
    user = await stack.userRepository.upsertByExternalId({ externalId: 'gov-manifest-user', displayName: 'User' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Governed Project' });
    otherProject = await stack.projectRepository.create({ organizationId: org.id, name: 'Other Governed Project' });

    const linkRepo = new PgProjectGitHubRepositoryRepository(stack.db.client);
    await linkRepo.create({ projectId: project.id, installationId: 'inst-gov', owner: OWNER, repository: REPO, defaultBranch: 'main' });
    await linkRepo.create({ projectId: otherProject.id, installationId: 'inst-gov', owner: OWNER, repository: OTHER_REPO, defaultBranch: 'main' });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  // --- fixture seeding ---------------------------------------------------------

  const seedManifest = (repo: string, ref: string, modelText: string, programText: string): void => {
    fakeGithub.setFile(OWNER, repo, ref, 'spec/development-state/governance-model.json', modelText);
    fakeGithub.setFile(OWNER, repo, ref, 'spec/development-state/program-state.json', programText);
    // The enforcement-referenced files must exist at the revision too: seed a
    // minimal representative tree so the FULL validation (including reference
    // existence + markers) runs. We seed the real marker files' content.
    const model = JSON.parse(modelText) as { checkpointContracts?: Array<{ enforcement?: Array<{ file?: string; marker?: string }> }> };
    const seeded = new Set<string>(['spec/development-state/governance-model.json', 'spec/development-state/program-state.json']);
    for (const contract of model.checkpointContracts ?? []) {
      for (const ref2 of contract.enforcement ?? []) {
        if (!ref2.file || seeded.has(ref2.file)) continue;
        const marker = ref2.marker ?? '';
        // Seed a file whose content CONTAINS the marker (the real file does;
        // for the fixture we only need the marker present — the validation
        // checks existence + marker containment, not full fidelity).
        let content = `// fixture enforcement artifact for ${ref2.file}\n`;
        try {
          const real = readFileSync(join(REPO_ROOT, ref2.file), 'utf8');
          if (real.includes(marker)) content = real;
          else content += `${marker}\n`;
        } catch {
          content += `${marker}\n`;
        }
        fakeGithub.setFile(OWNER, repo, ref, ref2.file, content);
        seeded.add(ref2.file);
      }
    }
    // Root + directory listings for the seeded paths (snapshot walks).
    const dirs = new Map<string, Map<string, 'file' | 'dir'>>();
    const ensureDir = (dir: string): Map<string, 'file' | 'dir'> => {
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      return dirs.get(dir)!;
    };
    ensureDir('');
    for (const path of seeded) {
      const segments = path.split('/');
      ensureDir(segments.slice(0, -1).join('/')).set(segments[segments.length - 1]!, 'file');
      for (let i = segments.length - 2; i >= 0; i--) {
        const dirPath = segments.slice(0, i + 1).join('/');
        ensureDir(segments.slice(0, i).join('/')).set(segments[i]!, 'dir');
        ensureDir(dirPath);
      }
    }
    for (const [dir, entries] of dirs) {
      fakeGithub.setDir(OWNER, repo, ref, dir, [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, type]) => ({ name, type })));
    }
  };

  const frozenVersionWithGovernanceAssertion = async (projectId: string, detectorConfig: Record<string, unknown> = {}) => {
    const arch = await stack.architectureRepository.create({ projectId, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    await assertionRepo.create({
      architectureVersionId: v.id,
      assertionId: 'ARCH-052-001',
      severity: 'blocking',
      scope: 'repository',
      statement: 'the repository-resident development-governance state is present and valid (WORK-052 §34.1; ADR-0004)',
      detectorKind: 'governance-manifest',
      detectorConfig,
    });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    return v;
  };

  const workItemOn = async (_projectId: string, versionId: string) =>
    stack.workItemRepository.create({
      architectureVersionId: versionId,
      workItemId: `WI-${generateExecutionId()}`,
      title: 'Governed WI',
      architectureImpact: 'high',
    });

  const gate = (workItemId: string, revision: string) => ({
    checkpointKind: 'pr_conformance' as const,
    workItemId,
    expectedProjectId: project.id,
    implementationRevision: revision,
    executionId: generateExecutionId(),
    idempotencyKey: `gov-manifest-${generateExecutionId()}`,
  });

  // --- W052-AC09: the detector through the substrate (real PG evidence) --------

  it('W052-AC09 — a valid governance manifest at the bound revision PASSES with durable /verification evidence', async () => {
    seedManifest(REPO, 'rev-valid', REAL_MODEL_TEXT, REAL_PROGRAM_TEXT);
    const version = await frozenVersionWithGovernanceAssertion(project.id);
    const wi = await workItemOn(project.id, version.id);
    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-valid'));
    expect(result.status).toBe('passed');
    expect(result.allowed).toBe(true);
    expect(result.checkpointId, 'durable /verification evidence run').toBeTruthy();
    const evidence = await verificationService.listEvidenceForRun(result.checkpointId!);
    const assertionRows = evidence.filter((e) => e.evidenceType === 'architecture-assertion');
    expect(assertionRows.length).toBe(1);
    expect(assertionRows[0]!.externalRef).toBe('ARCH-052-001');
    expect(assertionRows[0]!.result).toBe('pass');
    // The snapshot identity is recorded: the bytes came from /github at the ref.
    expect(result.snapshotIdentity?.revision).toBe('rev-valid');
    expect(result.snapshotIdentity?.repository).toBe(`${OWNER}/${REPO}`);
    expect(result.snapshotIdentity?.filesRead).toBeGreaterThan(0);
  });

  it('W052-AC09 — DISCRIMINATION: a WEAKENED boundary at the bound revision FAILS the checkpoint (durable evidence)', async () => {
    const model = JSON.parse(REAL_MODEL_TEXT) as { selfHostingBoundary: { coreProhibitions: string[]; mayNot: string[] } };
    model.selfHostingBoundary.coreProhibitions = model.selfHostingBoundary.coreProhibitions.slice(0, 4);
    const weakened = JSON.stringify(model, null, 2);
    seedManifest(REPO, 'rev-weakened', weakened, REAL_PROGRAM_TEXT);
    const version = await frozenVersionWithGovernanceAssertion(project.id);
    const wi = await workItemOn(project.id, version.id);
    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-weakened'));
    expect(result.status).toBe('blocked');
    expect(result.allowed).toBe(false);
    expect(result.blockingFindings.join('\n')).toMatch(/core prohibition REMOVED|violates \d+ invariant/);
    expect(result.checkpointId).toBeTruthy();
    const evidence = await verificationService.listEvidenceForRun(result.checkpointId!);
    expect(evidence.filter((e) => e.evidenceType === 'architecture-assertion')[0]!.result).toBe('fail');
  });

  it('W052-AC09 — a MISSING manifest at the bound revision is INCONCLUSIVE per ADR-0006 (a blocking assertion then blocks — fail closed)', async () => {
    // No governance files seeded at this ref at all. ADR-0006: missing/
    // unreadable/parses-failing manifests are INCONCLUSIVE — the governed state
    // could not be ESTABLISHED; the blocking gate denies (the post-merge
    // correction, BLOCKER 3: the code must match the accepted ADR).
    const version = await frozenVersionWithGovernanceAssertion(project.id);
    const wi = await workItemOn(project.id, version.id);
    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-missing'));
    expect(result.status).toBe('blocked');
    expect(result.allowed).toBe(false);
    expect(result.evaluations[0]!.status).toBe('inconclusive');
    expect(result.blockingFindings.join('\n')).toMatch(/ABSENT|development-governance state/);
    expect(result.blockingFindings.join('\n')).toMatch(/ADR-0006/);
  });

  it('W052-AC09 — DISCRIMINATION (post-merge correction, BLOCKER 3): a manifest that does not PARSE is INCONCLUSIVE per ADR-0006 (never a vacuous pass; a blocking assertion then blocks)', async () => {
    // The model parses; the program state is BROKEN JSON at the bound
    // revision. ADR-0006: parses-failing manifests are INCONCLUSIVE — and the
    // fail-closed behavior lives DOWNSTREAM: the blocking assertion blocks.
    // The old code returned 'fail' here, contradicting the accepted ADR.
    seedManifest(REPO, 'rev-unparseable', REAL_MODEL_TEXT, '{ this is not JSON');
    const version = await frozenVersionWithGovernanceAssertion(project.id);
    const wi = await workItemOn(project.id, version.id);
    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-unparseable'));
    expect(result.status).toBe('blocked');
    expect(result.allowed).toBe(false);
    expect(result.evaluations[0]!.status).toBe('inconclusive');
    expect(result.evaluations[0]!.summary).toMatch(/does not PARSE/);
    expect(result.evaluations[0]!.summary).toMatch(/ADR-0006/);
    // And DIRECTLY on the detector: the parse-failure arm is inconclusive,
    // never 'fail' — 'fail' is reserved for ESTABLISHED validation violations.
    const detector = new GovernanceManifestDetector();
    const readableSnapshot: RepositorySnapshot = {
      revision: 'rev-unparseable',
      repository: `${OWNER}/${REPO}`,
      async listDir(): Promise<readonly SnapshotDirEntry[]> { return []; },
      async readFile(path: string): Promise<string | null> {
        return path.endsWith('program-state.json') ? '{ this is not JSON' : REAL_MODEL_TEXT;
      },
      async dirExists(): Promise<boolean> { return true; },
      identity: () => ({ revision: 'rev-unparseable', repository: `${OWNER}/${REPO}`, filesRead: 2, treeDigest: null }),
    };
    const direct = await detector.evaluate({
      assertion: {
        id: 'a1', architectureVersionId: 'v1', assertionId: 'ARCH-052-001', severity: 'blocking', scope: 'repository',
        statement: 's', detectorKind: 'governance-manifest', detectorConfig: {}, createdAt: new Date(),
      },
      checkpointKind: 'pr_conformance',
      snapshot: readableSnapshot,
      context: { projectId: 'p1', workItemId: 'w1', architectureVersionId: 'v1', implementationRevision: 'rev-unparseable', workOrderId: null },
    });
    expect(direct.status).toBe('inconclusive');
    expect(direct.summary).toMatch(/does not PARSE/);
  });

  it('W052-AC09 — a CYCLIC program state at the bound revision fails (the DAG invariant through the substrate)', async () => {
    const program = JSON.parse(REAL_PROGRAM_TEXT) as { workOrders: Array<{ id: string; dependencies: string[] }> };
    const w051 = program.workOrders.find((w) => w.id === 'WORK-051')!;
    w051.dependencies = [...w051.dependencies, 'WORK-052'];
    seedManifest(REPO, 'rev-cyclic', REAL_MODEL_TEXT, JSON.stringify(program, null, 2));
    const version = await frozenVersionWithGovernanceAssertion(project.id);
    const wi = await workItemOn(project.id, version.id);
    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-cyclic'));
    expect(result.status).toBe('blocked');
    expect(result.blockingFindings.join('\n')).toMatch(/CYCLE/);
  });

  it('W052-AC09 — requirePresent=false: a repository without governance state is not_applicable', async () => {
    seedManifest(REPO, 'rev-none', REAL_MODEL_TEXT, REAL_PROGRAM_TEXT);
    // Point the detector at a path that does not exist in this revision, with
    // requirePresent=false: the assertion is not applicable (never a pass).
    const version = await frozenVersionWithGovernanceAssertion(project.id, {
      modelPath: 'spec/development-state/does-not-exist.json',
      requirePresent: false,
    });
    const wi = await workItemOn(project.id, version.id);
    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-none'));
    expect(result.evaluations[0]!.status).toBe('not_applicable');
    expect(result.status).toBe('passed'); // the single assertion is not applicable — no vacuous claim
  });

  it('W052-AC09 — an unresolvable/errored snapshot read is INCONCLUSIVE (never a vacuous pass)', async () => {
    // The detector invoked DIRECTLY against a stub snapshot whose reads fail:
    // a blocking assertion then fails closed at the gate (PROOF 7a pattern).
    const detector = new GovernanceManifestDetector();
    const failingSnapshot: RepositorySnapshot = {
      revision: 'rev-error',
      repository: `${OWNER}/${REPO}`,
      async listDir(): Promise<readonly SnapshotDirEntry[]> {
        throw new SnapshotReadError('unreadable', 'simulated transport failure');
      },
      async readFile(): Promise<string | null> {
        throw new SnapshotReadError('unreadable', 'simulated transport failure');
      },
      async dirExists(): Promise<boolean> {
        throw new SnapshotReadError('unreadable', 'simulated transport failure');
      },
      identity: () => ({ revision: 'rev-error', repository: `${OWNER}/${REPO}`, filesRead: 0, treeDigest: null }),
    };
    const input: DetectorInput = {
      assertion: {
        id: 'a1', architectureVersionId: 'v1', assertionId: 'ARCH-052-001', severity: 'blocking', scope: 'repository',
        statement: 's', detectorKind: 'governance-manifest', detectorConfig: {}, createdAt: new Date(),
      },
      checkpointKind: 'pr_conformance',
      snapshot: failingSnapshot,
      context: { projectId: 'p1', workItemId: 'w1', architectureVersionId: 'v1', implementationRevision: 'rev-error', workOrderId: null },
    };
    const result = await detector.evaluate(input);
    expect(result.status).toBe('inconclusive');
    expect(result.summary).toMatch(/could not be read/);
  });

  it('W052-AC09 — a non-revision-bound checkpoint makes the governance assertion not_applicable (no working-tree read, ever)', async () => {
    seedManifest(REPO, 'rev-readiness', REAL_MODEL_TEXT, REAL_PROGRAM_TEXT);
    const version = await frozenVersionWithGovernanceAssertion(project.id);
    const wi = await workItemOn(project.id, version.id);
    // readiness is NOT revision-bound: no snapshot opens; the repository-backed
    // assertion is not_applicable (the WORK-051 contract).
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'readiness',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: null,
      executionId: generateExecutionId(),
      idempotencyKey: `gov-readiness-${generateExecutionId()}`,
    });
    expect(result.evaluations[0]!.status).toBe('not_applicable');
  });

  it('W052-AC09 — snapshot isolation: the detector reads only the bound project snapshot (no cross-project leakage)', async () => {
    // Project A (project): the REAL valid manifests. Project B (otherProject):
    // a WEAKENED boundary. Evaluating A must pass regardless of B's state —
    // the two projects' snapshots are disjoint repositories.
    seedManifest(REPO, 'rev-iso-a', REAL_MODEL_TEXT, REAL_PROGRAM_TEXT);
    const weakenedModel = JSON.parse(REAL_MODEL_TEXT) as { selfHostingBoundary: { coreProhibitions: string[] } };
    weakenedModel.selfHostingBoundary.coreProhibitions = [];
    seedManifest(OTHER_REPO, 'rev-iso-b', JSON.stringify(weakenedModel, null, 2), REAL_PROGRAM_TEXT);

    const versionA = await frozenVersionWithGovernanceAssertion(project.id);
    const wiA = await workItemOn(project.id, versionA.id);
    const resultA = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wiA.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-iso-a',
      executionId: generateExecutionId(),
      idempotencyKey: `gov-iso-a-${generateExecutionId()}`,
    });
    expect(resultA.status, "project A passes on ITS OWN snapshot — otherProject's weakened state cannot leak in").toBe('passed');
    expect(resultA.snapshotIdentity?.repository).toBe(`${OWNER}/${REPO}`);

    // And B, on its own snapshot, fails its own checkpoint.
    const versionB = await frozenVersionWithGovernanceAssertion(otherProject.id);
    const wiB = await workItemOn(otherProject.id, versionB.id);
    const resultB = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wiB.id,
      expectedProjectId: otherProject.id,
      implementationRevision: 'rev-iso-b',
      executionId: generateExecutionId(),
      idempotencyKey: `gov-iso-b-${generateExecutionId()}`,
    });
    expect(resultB.status).toBe('blocked');
    expect(resultB.snapshotIdentity?.repository).toBe(`${OWNER}/${OTHER_REPO}`);
  });

  it('W052-AC09 — the detector is registered in the CLOSED default registry (exactly the seven kinds)', async () => {
    const { createDefaultDetectorRegistry } = await import('../../../src/architecture-checkpoints/index.js');
    const registry = createDefaultDetectorRegistry();
    expect(registry.size).toBe(7);
    expect(registry.has('governance-manifest')).toBe(true);
    expect(registry.get('governance-manifest')).toBeInstanceOf(GovernanceManifestDetector);
  });

  it('W052-AC09 — an unknown detector kind on a governance assertion stays fail-closed (PROOF 7a applies unchanged)', async () => {
    seedManifest(REPO, 'rev-unknown', REAL_MODEL_TEXT, REAL_PROGRAM_TEXT);
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch-${generateExecutionId()}` });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    await assertionRepo.create({
      architectureVersionId: v.id,
      assertionId: 'ARCH-052-002',
      severity: 'blocking',
      scope: 'repository',
      statement: 'an assertion naming an unregistered detector kind',
      detectorKind: 'governance-manifest-typo',
      detectorConfig: {},
    });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id,
      workItemId: `WI-${generateExecutionId()}`,
      title: 'WI',
      architectureImpact: 'high',
    });
    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-unknown'));
    expect(result.status).toBe('blocked');
    expect(result.evaluations[0]!.status).toBe('inconclusive');
  });

  // A spy over the registry composition: proves the default registry entry is
  // the same class this suite exercises (no shadow implementation).
  it('W052-AC09 — the detector implements the ArchitectureAssertionDetector contract (structural)', () => {
    const detector: ArchitectureAssertionDetector = new GovernanceManifestDetector();
    expect(detector.detectorKind).toBe('governance-manifest');
    expect(typeof detector.evaluate).toBe('function');
    const result: DetectorResult = { status: 'pass', summary: 'typecheck only' };
    expect(result.status).toBe('pass');
  });
});
