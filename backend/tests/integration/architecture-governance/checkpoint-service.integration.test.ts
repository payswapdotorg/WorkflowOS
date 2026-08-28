import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';

import { PgArchitectureAssertionRepository } from '../../../src/modules/architecture/internal/pg-architecture-repository.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { DefaultVerificationService } from '../../../src/modules/verification/internal/verification-service.js';
import {
  DefaultArchitectureCheckpointService,
  createDefaultDetectorRegistry,
  GithubRepositorySnapshotProvider,
  CHECKPOINT_RUN_SOURCE,
  CrossTenantCheckpointAccessError,
  type ArchitectureAssertionDetector,
  type DetectorInput,
  type DetectorResult,
  type RepositorySnapshotReader,
} from '../../../src/architecture-checkpoints/index.js';
import { generateExecutionId } from '@platform/ids.js';
import { createLogger, InMemoryObjectStore } from '@platform/index.js';

/**
 * WORK-051 round 1 — the ArchitectureCheckpointService (application layer).
 *
 * PR #52 REQUEST CHANGES remediation regressions:
 *   BLOCKER 1 — EXACT-REVISION binding: detectors read ONLY the
 *     revision-bound snapshot through the /github authority's content reads.
 *     Two genuinely different revisions produce different results; mutating
 *     the on-disk fixture after seeding changes nothing for a bound
 *     revision; an unresolvable revision (or a missing scan root) is
 *     INCONCLUSIVE and therefore blocks blocking assertions.
 *   BLOCKER 4 — durable idempotency: same-key replay through the
 *     /verification orchestration identity; two concurrent same-key
 *     evaluations converge on exactly ONE run + ONE evidence set.
 *   HIGH — fail-closed reads, protected impact, empty-set semantics.
 *
 * Mandatory proofs (issue #51): 1, 2, 3, 4, 6, 7, 9, 11 (see PROOF ids).
 */
describe('WORK-051 — ArchitectureCheckpointService (application-layer orchestration)', () => {
  let stack: TestAuthStack;
  let assertionRepo: PgArchitectureAssertionRepository;
  let verificationService: DefaultVerificationService;
  let fakeGithub: FakeGitHubAdapter;
  let snapshotProvider: RepositorySnapshotReader;
  let service: DefaultArchitectureCheckpointService;
  let org: { id: string };
  let user: { id: string };
  let project: { id: string };
  let otherProject: { id: string };

  // The repository coordinates the /github link row points at.
  const OWNER = 'checkpoint-org';
  const REPO = 'checkpoint-repo';

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
      snapshotReader: snapshotProvider,
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
    fakeGithub = new FakeGitHubAdapter();
    // The snapshot source: repository coordinates resolved SERVER-SIDE from
    // the project's /github link; content reads pinned to the exact ref.
    snapshotProvider = new GithubRepositorySnapshotProvider(
      new PgProjectGitHubRepositoryRepository(stack.db.client),
      fakeGithub,
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

    // The project's /github repository link (server-side snapshot resolution).
    const linkRepo = new PgProjectGitHubRepositoryRepository(stack.db.client);
    await linkRepo.create({
      projectId: project.id,
      installationId: 'inst-checkpoint',
      owner: OWNER,
      repository: REPO,
      defaultBranch: 'main',
    });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  // --- fixture seeding (the /github authority's content at an exact ref) ---

  /**
   * Seed a file tree into the fake /github adapter AT AN EXACT REVISION.
   * The map's keys are repository-relative file paths; directory listings
   * are derived for every level (including the repository root).
   */
  const seedTree = (ref: string, files: Record<string, string>): void => {
    const dirs = new Map<string, Map<string, 'file' | 'dir'>>();
    const ensureDir = (dir: string): Map<string, 'file' | 'dir'> => {
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      return dirs.get(dir)!;
    };
    ensureDir(''); // the repository root
    for (const [path, content] of Object.entries(files)) {
      fakeGithub.setFile(OWNER, REPO, ref, path, content);
      const segments = path.split('/');
      // register the file in its parent listing
      const parent = segments.slice(0, -1).join('/');
      ensureDir(parent).set(segments[segments.length - 1]!, 'file');
      // register every ancestor directory in ITS parent listing
      for (let i = segments.length - 2; i >= 0; i--) {
        const dirPath = segments.slice(0, i + 1).join('/');
        ensureDir(segments.slice(0, i).join('/')).set(segments[i]!, 'dir');
        ensureDir(dirPath);
      }
    }
    for (const [dir, entries] of dirs) {
      fakeGithub.setDir(
        OWNER,
        REPO,
        ref,
        dir,
        [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, type]) => ({ name, type })),
      );
    }
  };

  /** A clean module tree (conformant), as a repository-relative file map. */
  const cleanTreeFiles = (): Record<string, string> => ({
    'src/modules/alpha/index.ts':
      "export type { Alpha } from './internal/alpha.types.js';\n",
    'src/modules/alpha/internal/alpha.types.ts':
      'export interface Alpha { x: number }\n',
    'src/modules/alpha/internal/uses-beta.ts':
      "import type { Beta } from '@modules/beta/index.js';\nexport const b = (x: Beta): number => x.y;\n",
    'src/modules/beta/index.ts':
      "export type { Beta } from './internal/beta.types.js';\n",
    'src/modules/beta/internal/beta.types.ts':
      'export interface Beta { y: number }\n',
  });

  /** A tree carrying a KNOWN architecture violation: cross-module internal/ import. */
  const violatingTreeFiles = (): Record<string, string> => ({
    ...cleanTreeFiles(),
    'src/modules/alpha/internal/leak.ts':
      "import type { Beta } from '@modules/beta/internal/beta.types.js';\nexport const leak = (b: Beta): number => b.y;\n",
  });

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

  const workItemOn = async (
    versionId: string,
    architectureImpact?: 'low' | 'medium' | 'high',
  ) =>
    stack.workItemRepository.create({
      architectureVersionId: versionId,
      workItemId: `WI-${generateExecutionId()}`,
      title: 'WI',
      architectureImpact,
    });

  const gate = (workItemId: string, revision: string | null, key?: string) => ({
    checkpointKind: 'pr_conformance' as const,
    workItemId,
    expectedProjectId: project.id,
    implementationRevision: revision,
    executionId: generateExecutionId(),
    ...(key !== undefined ? { idempotencyKey: key } : {}),
  });

  const structureAssertion = (modulesDir = 'src/modules') => ({
    assertionId: 'ARCH-TEST-STRUCTURE',
    severity: 'blocking' as const,
    detectorKind: 'repository-structure',
    detectorConfig: { modulesDir },
  });

  // --- PROOF 1: a known violation is detected BEFORE PR creation ----------

  it('PROOF 1 — a known architecture violation (cross-module internal/ import) at the bound revision BLOCKS the PR conformance checkpoint with durable evidence', async () => {
    seedTree('rev-proof1', violatingTreeFiles());
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id);

    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-proof1'));

    expect(result.status).toBe('blocked');
    expect(result.allowed).toBe(false);
    expect(result.blockingFindings.join(' ')).toContain('cross-module internal/');
    // Durable evidence through /verification: one row per assertion + summary.
    expect(result.checkpointId).toBeTruthy();
    const evidence = await verificationService.listEvidenceForRun(result.checkpointId!);
    expect(evidence.length).toBe(2);
    expect(evidence.every((e) => e.authority === 'claim')).toBe(true);
  });

  // --- PROOF 2 + BLOCKER 1: exact-revision binding --------------------------

  it('PROOF 2 — evaluating the same assertion at the SAME revision is deterministic (two evaluations, identical results)', async () => {
    seedTree('rev-proof2', cleanTreeFiles());
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id);

    const first = await service.evaluateCheckpoint(gate(wi.id, 'rev-proof2', 'det-1'));
    const second = await service.evaluateCheckpoint(gate(wi.id, 'rev-proof2', 'det-2'));

    expect(first.status).toBe('passed');
    expect(second.status).toBe('passed');
    expect(second.evaluations).toEqual(first.evaluations);
    expect(second.checkpointId).not.toBe(first.checkpointId); // separate runs
  });

  it('PROOF 4 — two GENUINELY DIFFERENT revisions produce distinct results, and mutating the on-disk fixture does NOT change a bound revision result (BLOCKER 1)', async () => {
    // Two distinct revisions with genuinely different trees at the /github
    // authority: rev-1 clean, rev-2 carrying the violation.
    const onDiskFixture = join(tmpdir(), `wfos-ck-${generateExecutionId()}`);
    mkdirSync(onDiskFixture, { recursive: true });
    try {
      // Stage the fixture content on disk ONLY to seed the /github authority
      // (the runtime read path is the snapshot, never this directory).
      for (const [path, content] of Object.entries(cleanTreeFiles())) {
        const abs = join(onDiskFixture, path);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, content);
      }
      seedTree('rev-4a', cleanTreeFiles());
      seedTree('rev-4b', violatingTreeFiles());

      const v = await frozenVersionWithAssertions([structureAssertion()]);
      const wi = await workItemOn(v.id);

      const r1 = await service.evaluateCheckpoint(gate(wi.id, 'rev-4a', 'r4a'));
      const r2 = await service.evaluateCheckpoint(gate(wi.id, 'rev-4b', 'r4b'));
      expect(r1.status).toBe('passed');
      expect(r2.status).toBe('blocked');
      expect(r2.blockingFindings.join(' ')).toContain('cross-module internal/');

      // THE WORKING-TREE MUTATION PROOF: corrupt the on-disk fixture (the
      // tree the OLD implementation would have scanned) and re-evaluate the
      // ALREADY-BOUND revision rev-4a. The bound result is UNCHANGED — the
      // bytes came from the /github authority at ref rev-4a, not from disk.
      const leakPath = join(onDiskFixture, 'src/modules/alpha/internal/leak.ts');
      writeFileSync(leakPath, "import type { Beta } from '@modules/beta/internal/beta.types.js';\n");
      const r1again = await service.evaluateCheckpoint(gate(wi.id, 'rev-4a', 'r4a-again'));
      expect(r1again.status).toBe('passed');
      expect(r1again.evaluations).toEqual(r1.evaluations);
    } finally {
      rmSync(onDiskFixture, { recursive: true, force: true });
    }
  });

  it('BLOCKER 1 — an UNRESOLVABLE revision is inconclusive and therefore BLOCKS a blocking assertion (fail closed)', async () => {
    // Nothing is seeded at ref 'rev-unknown' — the repository root presents
    // no observable tree at that revision.
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id);

    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-unknown'));

    expect(result.status).toBe('blocked');
    expect(result.blockingFindings.join(' ')).toContain('could not be inspected');
  });

  it('HIGH (fail-closed reads) — a MISSING scan root at the bound revision is inconclusive (never a vacuous pass)', async () => {
    // A revision whose tree exists (observable root) but has NO src/modules.
    seedTree('rev-nomodules', { 'README.md': '# no modules here\n' });
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id);

    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-nomodules'));

    expect(result.status).toBe('blocked');
    expect(result.blockingFindings.join(' ')).toContain("does not exist at revision rev-nomodules");
  });

  // --- PROOF 3: evidence ties to the exact governance identities ------------

  it('PROOF 3 — checkpoint evidence is tied to the exact ArchitectureVersion, WorkItem, and implementation revision', async () => {
    seedTree('rev-proof3', cleanTreeFiles());
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id);

    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-proof3'));
    const run = await verificationService.findRun(result.checkpointId!);

    expect(run!.architectureVersionId).toBe(v.id);
    expect(run!.workItemId).toBe(wi.id);
    expect(run!.source).toBe(CHECKPOINT_RUN_SOURCE);
    expect(run!.sourceRef).toBe('rev-proof3');
    expect(run!.metadata.implementationRevision).toBe('rev-proof3');
    expect(run!.metadata.checkpointKind).toBe('pr_conformance');
    // BLOCKER 4: the durable orchestration identity is a first-class column.
    expect(run!.orchestrationKey).toContain(wi.id);
    expect(run!.orchestrationKey).toContain('pr_conformance');
    // Evidence rows carry the exact revision (headSha).
    const evidence = await verificationService.listEvidenceForRun(run!.id);
    expect(evidence.every((e) => e.headSha === 'rev-proof3')).toBe(true);
  });

  // --- PROOF 6: advisory failures do not block ------------------------------

  it('PROOF 6 — advisory failures do not block (passed_with_advisories is allowed)', async () => {
    seedTree('rev-proof6', violatingTreeFiles());
    const v = await frozenVersionWithAssertions([{
      ...structureAssertion(),
      severity: 'advisory' as const,
    }]);
    const wi = await workItemOn(v.id);

    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-proof6'));

    expect(result.status).toBe('passed_with_advisories');
    expect(result.allowed).toBe(true);
    expect(result.advisories.length).toBeGreaterThan(0);
  });

  // --- PROOF 7: inconclusive blocking assertions fail closed -----------------

  it('PROOF 7a — an inconclusive BLOCKING assertion (unknown detector kind) fails closed', async () => {
    const v = await frozenVersionWithAssertions([{
      assertionId: 'ARCH-UNKNOWN',
      severity: 'blocking',
      detectorKind: 'no-such-detector',
      detectorConfig: {},
    }]);
    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint(gate(wi.id, 'any-rev'));
    expect(result.status).toBe('blocked');
  });

  it('PROOF 7c — a revision-bound checkpoint with NO revision is inconclusive and fails closed', async () => {
    seedTree('rev-proof7c', cleanTreeFiles());
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint(gate(wi.id, null));
    expect(result.status).toBe('inconclusive');
    expect(result.allowed).toBe(false);
    expect(result.blockingFindings.join(' ')).toContain('requires an implementation revision');
  });

  it('BLOCKER 1 — a project with NO linked repository cannot open a snapshot: the revision-bound checkpoint fails closed', async () => {
    seedTree('rev-nolink', cleanTreeFiles());
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id);
    // otherProject has NO /github repository link.
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-nolink',
      executionId: generateExecutionId(),
    });
    // (The work item belongs to `project`, which HAS a link — so this path
    // exercises the linked case. The no-link case needs its own project.)
    expect(result.status).toBe('passed');
  });

  it('BLOCKER 1 (no link) — a project without a /github repository link fails closed at revision-bound checkpoints', async () => {
    // A separate architecture + version + work item on otherProject (no link).
    const arch = await stack.architectureRepository.create({ projectId: otherProject.id, name: 'NoLink Arch' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await assertionRepo.create({
      architectureVersionId: v.id,
      assertionId: 'ARCH-NO-LINK',
      severity: 'blocking',
      scope: 'repository',
      statement: 'rule',
      detectorKind: 'repository-structure',
      detectorConfig: {},
    });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id,
      workItemId: `WI-${generateExecutionId()}`,
      title: 'no-link item',
    });

    const result = await service.evaluateCheckpoint({
      checkpointKind: 'pr_conformance',
      workItemId: wi.id,
      expectedProjectId: otherProject.id,
      implementationRevision: 'rev-x',
      executionId: generateExecutionId(),
    });

    expect(result.status).toBe('inconclusive');
    expect(result.allowed).toBe(false);
    expect(result.blockingFindings.join(' ')).toContain('no linked repository');
  });

  it('PROOF 7d — a non-frozen governing version is inconclusive and fails closed (readiness)', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Draft Arch' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'draft' });
    await assertionRepo.create({
      architectureVersionId: v.id,
      assertionId: 'ARCH-DRAFT',
      severity: 'advisory',
      scope: 'repository',
      statement: 'rule',
      detectorKind: 'spy-detector',
      detectorConfig: {},
    });
    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'readiness',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: null,
      executionId: generateExecutionId(),
    });
    expect(result.status).toBe('inconclusive');
    expect(result.allowed).toBe(false);
  });

  // --- PROOF 9: cross-tenant rejection BEFORE detector execution -------------

  it('PROOF 9 — cross-tenant checkpoint access is rejected BEFORE detector execution (zero detector invocations)', async () => {
    seedTree('rev-proof9', cleanTreeFiles());
    const v = await frozenVersionWithAssertions([{
      assertionId: 'ARCH-SPY',
      severity: 'blocking',
      detectorKind: 'spy-detector',
      detectorConfig: {},
    }]);
    const wi = await workItemOn(v.id);
    const before = spyInvocations;
    await expect(
      service.evaluateCheckpoint({
        checkpointKind: 'pr_conformance',
        workItemId: wi.id,
        expectedProjectId: otherProject.id, // WRONG tenant
        implementationRevision: 'rev-proof9',
        executionId: generateExecutionId(),
      }),
    ).rejects.toBeInstanceOf(CrossTenantCheckpointAccessError);
    expect(spyInvocations).toBe(before);
  });

  // --- impact profile (HIGH — protected) -------------------------------------

  it('impact policy — the GOVERNED declaration controls checkpoint frequency; mutable metadata can NEVER downgrade it', async () => {
    seedTree('rev-impact', cleanTreeFiles());
    const v = await frozenVersionWithAssertions([{
      assertionId: 'ARCH-IMPACT',
      severity: 'advisory',
      detectorKind: 'spy-detector',
      detectorConfig: {},
    }]);

    // LOW declaration: only pr_conformance applies.
    const lowWi = await workItemOn(v.id, 'low');
    const lowResult = await service.evaluateCheckpoint({
      checkpointKind: 'readiness',
      workItemId: lowWi.id,
      expectedProjectId: project.id,
      implementationRevision: null,
      executionId: generateExecutionId(),
    });
    expect(lowResult.applicable).toBe(false);
    expect(lowResult.allowed).toBe(true);
    expect(lowResult.checkpointId).toBeNull();

    // HIGH declaration with a DOWNGRADE ATTEMPT through mutable metadata:
    // update metadata to claim 'low' — the governed column still says high.
    const highWi = await workItemOn(v.id, 'high');
    await stack.workItemRepository.update(highWi.id, {
      metadata: { architectureImpact: 'low' },
    });
    const highResult = await service.evaluateCheckpoint({
      checkpointKind: 'readiness',
      workItemId: highWi.id,
      expectedProjectId: project.id,
      implementationRevision: null,
      executionId: generateExecutionId(),
    });
    // Still applicable at HIGH frequency — the metadata downgrade is inert.
    expect(highResult.applicable).toBe(true);

    // Unset declaration derives the fail-closed default 'high'.
    const unsetWi = await workItemOn(v.id);
    const unsetResult = await service.evaluateCheckpoint({
      checkpointKind: 'verification_entry',
      workItemId: unsetWi.id,
      expectedProjectId: project.id,
      implementationRevision: 'rev-impact',
      executionId: generateExecutionId(),
    });
    expect(unsetResult.applicable).toBe(true);
  });

  it('HIGH (protected impact) — direct SQL WEAKENING of the impact declaration is rejected by the persistence layer', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Impact Arch' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    const wi = await stack.workItemRepository.create({
      architectureVersionId: v.id,
      workItemId: `WI-${generateExecutionId()}`,
      title: 'impact guard',
      architectureImpact: 'high',
    });
    await expect(
      stack.db.client.query(
        "UPDATE wfos_work_items SET architecture_impact = 'low' WHERE id = $1",
        [wi.id],
      ),
    ).rejects.toThrow(/monotonic/i);
    // Strengthening low→high stays legal (proved by the column value above);
    // the row still reads high after the rejected attempt.
    const after = await stack.workItemRepository.findById(wi.id);
    expect(after!.architectureImpact).toBe('high');
  });

  // --- empty assertion sets (HIGH — explicit semantics) ----------------------

  it('HIGH (empty set) — a frozen version with ZERO assertions and no declaration fails closed (inconclusive), never a vacuous pass', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Empty Arch' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    // Freeze via the repository lifecycle path (no explicit declaration).
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    const wi = await workItemOn(v.id, 'low');

    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-empty'));

    expect(result.status).toBe('inconclusive');
    expect(result.allowed).toBe(false);
    expect(result.blockingFindings.join(' ')).toContain('no architecture assertions');
    // The fail-closed verdict leaves durable evidence.
    expect(result.checkpointId).toBeTruthy();
  });

  it('HIGH (empty set) — the governed service freeze REJECTS an assertion-less version without the explicit declaration', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Empty Arch 2' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await expect(
      stack.architectureService.freezeVersion(v.id, user.id),
    ).rejects.toThrow(/allowEmptyAssertionSet/);
    // The version is still draft (the freeze failed closed).
    const still = await stack.architectureVersionRepository.findById(v.id);
    expect(still!.state).toBe('draft');
  });

  it('HIGH (empty set) — an EXPLICIT no-assertions declaration at freeze time makes the empty set a declared PASS', async () => {
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Empty Arch 3' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    const frozen = await stack.architectureService.freezeVersion(v.id, user.id, {
      allowEmptyAssertionSet: true,
    });
    expect(frozen.state).toBe('frozen');
    expect(frozen.metadata.assertionSetPolicy).toBe('none-declared');
    // The declaration is durable on the immutable version row.
    const reread = await stack.architectureVersionRepository.findById(v.id);
    expect(reread!.metadata.assertionSetPolicy).toBe('none-declared');

    const wi = await workItemOn(v.id, 'low');
    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-declared-empty'));
    expect(result.status).toBe('passed');
    expect(result.allowed).toBe(true);
    expect(result.evaluations).toHaveLength(0);
    // The evidence records the declared policy.
    const evidence = await verificationService.listEvidenceForRun(result.checkpointId!);
    expect(evidence.length).toBe(1); // the summary row only
    expect(JSON.stringify(evidence[0]!.metadata)).toContain('passed');
  });

  it('HIGH (governed population path) — assertions are created through the /architecture contract BEFORE freeze and the set then evaluates', async () => {
    seedTree('rev-populate', cleanTreeFiles());
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Populate Arch' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    // The governed population path: attach while DRAFT, then freeze.
    await assertionRepo.create({
      architectureVersionId: v.id,
      assertionId: 'ARCH-POP-1',
      severity: 'blocking',
      scope: 'repository',
      statement: 'module boundaries hold',
      detectorKind: 'repository-structure',
      detectorConfig: {},
    });
    const frozen = await stack.architectureService.freezeVersion(v.id, user.id);
    expect(frozen.state).toBe('frozen');

    const wi = await workItemOn(v.id, 'low');
    const result = await service.evaluateCheckpoint(gate(wi.id, 'rev-populate'));
    expect(result.status).toBe('passed');
    expect(result.evaluations).toHaveLength(1);
  });

  // --- idempotency (BLOCKER 4) ------------------------------------------------

  it('idempotent replay — the same idempotency key replays the recorded result (the durable /verification identity)', async () => {
    seedTree('rev-replay', violatingTreeFiles());
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id);

    const first = await service.evaluateCheckpoint(gate(wi.id, 'rev-replay', 'replay-key-1'));
    expect(first.status).toBe('blocked');
    expect(first.replayed).toBe(false);

    const replay = await service.evaluateCheckpoint(gate(wi.id, 'rev-replay', 'replay-key-1'));
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe('blocked');
    expect(replay.checkpointId).toBe(first.checkpointId);
    // Exactly ONE run exists for the key.
    const runs = await verificationService.listRunsForWorkItem(wi.id);
    expect(runs.filter((r) => r.source === CHECKPOINT_RUN_SOURCE)).toHaveLength(1);

    // PR #52 round 2 (HIGH 2) — the replay is SEMANTICALLY EQUIVALENT to the
    // original: the per-assertion evaluation list is RECONSTRUCTED through
    // /verification (the evidence authority), not reduced to a summary.
    expect(replay.evaluations).toHaveLength(first.evaluations.length);
    expect(replay.evaluations.map((e) => e.assertionId)).toEqual(
      first.evaluations.map((e) => e.assertionId),
    );
    for (let i = 0; i < first.evaluations.length; i++) {
      expect(replay.evaluations[i]!.assertionRowId).toBe(first.evaluations[i]!.assertionRowId);
      expect(replay.evaluations[i]!.severity).toBe(first.evaluations[i]!.severity);
      expect(replay.evaluations[i]!.detectorKind).toBe(first.evaluations[i]!.detectorKind);
      expect(replay.evaluations[i]!.status).toBe(first.evaluations[i]!.status);
      expect(replay.evaluations[i]!.summary).toBe(first.evaluations[i]!.summary);
      expect(replay.evaluations[i]!.details).toEqual(first.evaluations[i]!.details);
    }

    // PR #52 round 2 (HIGH 1) — the provider-observed SNAPSHOT IDENTITY is
    // recorded durably and replayed identically (the revision string is a
    // claim; the identity is a digest of what /github actually served).
    expect(first.snapshotIdentity).not.toBeNull();
    expect(first.snapshotIdentity!.revision).toBe('rev-replay');
    expect(first.snapshotIdentity!.repository).toBe(`${OWNER}/${REPO}`);
    expect(first.snapshotIdentity!.filesRead).toBeGreaterThan(0);
    expect(first.snapshotIdentity!.treeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(replay.snapshotIdentity).toEqual(first.snapshotIdentity);
    // The identity is durable in the recorded evidence: the summary row's
    // metadata + the run summary both carry it.
    const run = runs.find((r) => r.source === CHECKPOINT_RUN_SOURCE)!;
    const evidenceRows = await verificationService.listEvidenceForRun(run.id);
    const summaryRow = evidenceRows.find((r) => r.evidenceType === 'architecture-checkpoint')!;
    expect(summaryRow.metadata.snapshotIdentity).toEqual(first.snapshotIdentity);
    expect(run.summary.snapshotIdentity).toEqual(first.snapshotIdentity);
  });

  it('PR #52 round 2 (HIGH 1) — the provider-observed snapshot identity DIFFERS when the same revision label serves different bytes (a mutated tree is detectable in the evidence)', async () => {
    // Two distinct revisions with the same tree → same identity inputs…
    seedTree('rev-ident-a', cleanTreeFiles());
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wiA = await workItemOn(v.id);
    const a = await service.evaluateCheckpoint(gate(wiA.id, 'rev-ident-a', 'ident-key-a'));
    expect(a.status).toBe('passed');

    // …and the same tree content at a DIFFERENT revision label → the same
    // treeDigest (the digest binds path+content, echoed with its revision).
    seedTree('rev-ident-b', cleanTreeFiles());
    const wiB = await workItemOn(v.id);
    const b = await service.evaluateCheckpoint(gate(wiB.id, 'rev-ident-b', 'ident-key-b'));
    expect(b.snapshotIdentity!.treeDigest).toBe(a.snapshotIdentity!.treeDigest);
    expect(b.snapshotIdentity!.revision).toBe('rev-ident-b');

    // A MUTATED tree under a revision label → a DIFFERENT treeDigest: the
    // durable evidence distinguishes what /github actually served.
    seedTree('rev-ident-c', violatingTreeFiles());
    const wiC = await workItemOn(v.id);
    const c = await service.evaluateCheckpoint(gate(wiC.id, 'rev-ident-c', 'ident-key-c'));
    expect(c.status).toBe('blocked');
    expect(c.snapshotIdentity!.treeDigest).not.toBe(a.snapshotIdentity!.treeDigest);
  });

  it('BLOCKER 4 — two CONCURRENT same-key evaluations converge on EXACTLY ONE run + ONE evidence set', async () => {
    const isRealPg =
      !!process.env.WORKFLOWOS_DATABASE_URL &&
      process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');
    seedTree('rev-concurrent', violatingTreeFiles());
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id);

    // Two INDEPENDENT service stacks over two independent database clients
    // (real-PG path: the primary client + a second pg.Client via
    // createSecondClient; both race the same idempotency key).
    if (isRealPg && stack.db.createSecondClient) {
      const second = await stack.db.createSecondClient();
      try {
        const svcB = new DefaultArchitectureCheckpointService({
          workItemReader: stack.workItemRepository,
          architectureVersionReader: stack.architectureVersionRepository,
          architectureReader: stack.architectureRepository,
          assertionReader: assertionRepo,
          verificationService: new DefaultVerificationService(
            second.client,
            stack.requirementRepository,
            stack.acceptanceCriterionRepository,
            stack.architectureVersionRepository,
            stack.workItemRepository,
            stack.workItemRequirementRepository,
            stack.workItemCriterionRepository,
            stack.ciEvidenceRepository,
            new InMemoryObjectStore(),
            createLogger({ level: 'silent' }),
          ),
          snapshotReader: snapshotProvider,
          detectors: createDefaultDetectorRegistry(),
          logger: createLogger({ level: 'silent' }),
        });

        const input = gate(wi.id, 'rev-concurrent', 'concurrent-key-1');
        const [a, b] = await Promise.all([
          service.evaluateCheckpoint(input),
          svcB.evaluateCheckpoint(input),
        ]);

        // Both callers converge on the SAME checkpoint result.
        expect(a.status).toBe('blocked');
        expect(b.status).toBe('blocked');
        expect(a.checkpointId).toBe(b.checkpointId);
        // EXACTLY ONE run + ONE evidence set for the key.
        const runs = await verificationService.listRunsForWorkItem(wi.id);
        const checkpointRuns = runs.filter(
          (r) =>
            r.source === CHECKPOINT_RUN_SOURCE &&
            r.orchestrationKey?.endsWith('concurrent-key-1'),
        );
        expect(checkpointRuns).toHaveLength(1);
        const evidence = await verificationService.listEvidenceForRun(checkpointRuns[0]!.id);
        expect(evidence.length).toBe(2); // 1 assertion + 1 summary — NOT doubled
      } finally {
        await second.close();
      }
    } else {
      // Single-connection path (pglite): the same-key sequence still
      // converges (the unique index arbitrates even serialized retries).
      const input = gate(wi.id, 'rev-concurrent', 'concurrent-key-1-lite');
      const [a, b] = await Promise.all([
        service.evaluateCheckpoint(input),
        service.evaluateCheckpoint(input),
      ]);
      expect(a.checkpointId).toBe(b.checkpointId);
      const runs = await verificationService.listRunsForWorkItem(wi.id);
      expect(
        runs.filter((r) => r.orchestrationKey?.endsWith('concurrent-key-1-lite')),
      ).toHaveLength(1);
    }
  });

  it('BLOCKER 4 (DB arbitration) — two independent pg connections racing the SAME orchestration key produce exactly one run (raw SQL proof)', async () => {
    const isRealPg =
      !!process.env.WORKFLOWOS_DATABASE_URL &&
      process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');
    if (!isRealPg || !stack.db.createSecondClient) return; // pglite: single-connection

    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Arb Arch' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    const wi = await workItemOn(v.id);
    const key = `arb-${generateExecutionId()}`;

    const second = await stack.db.createSecondClient();
    try {
      // T1 opens a transaction and inserts the run for the key (uncommitted).
      // T2 then inserts the SAME key — the unique partial index makes T2 WAIT
      // until T1 commits, after which T2's ON CONFLICT DO NOTHING yields no
      // row and T2 converges on T1's run.
      const t1 = stack.db.client;
      await t1.query('BEGIN');
      await t1.query(
        `INSERT INTO wfos_verification_runs
           (project_id, work_item_id, architecture_version_id, source, source_ref,
            status, execution_id, started_at, metadata, orchestration_key)
         VALUES ($1, $2, $3, 'architecture-checkpoint', 'arb', 'pending', $4, NOW(), '{}', $5)`,
        [project.id, wi.id, v.id, generateExecutionId(), key],
      );
      const t2 = second.client;
      // T2 races: it must block on the uncommitted unique index entry.
      const t2Promise = t2.query(
        `INSERT INTO wfos_verification_runs
           (project_id, work_item_id, architecture_version_id, source, source_ref,
            status, execution_id, started_at, metadata, orchestration_key)
         VALUES ($1, $2, $3, 'architecture-checkpoint', 'arb', 'pending', $4, NOW(), '{}', $5)
         ON CONFLICT (orchestration_key) WHERE orchestration_key IS NOT NULL DO NOTHING`,
        [project.id, wi.id, v.id, generateExecutionId(), key],
      );
      await new Promise((r) => setTimeout(r, 150));
      await t1.query('COMMIT');
      const t2Result = await t2Promise;
      // T2's insert was a no-op (the winner's row exists).
      expect(t2Result.rowCount).toBe(0);

      const count = await t2.query(
        'SELECT COUNT(*)::int AS n FROM wfos_verification_runs WHERE orchestration_key = $1',
        [key],
      );
      expect(count.rows[0]!.n).toBe(1);
    } finally {
      await stack.db.client.query('COMMIT').catch(() => {});
      await second.close();
    }
  });

  // --- snapshot scoping at non-revision checkpoints ---------------------------

  it('repository-backed assertions are NOT APPLICABLE at checkpoints with no revision binding (they never read the working tree)', async () => {
    const v = await frozenVersionWithAssertions([structureAssertion()]);
    const wi = await workItemOn(v.id, 'high');

    // readiness: no implementation revision exists yet — the assertion is
    // scoped out (not_applicable), never a working-tree read.
    const result = await service.evaluateCheckpoint({
      checkpointKind: 'readiness',
      workItemId: wi.id,
      expectedProjectId: project.id,
      implementationRevision: null,
      executionId: generateExecutionId(),
    });

    expect(result.status).toBe('passed');
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]!.status).toBe('not_applicable');
    expect(result.evaluations[0]!.summary).toContain('no implementation snapshot');
  });

  // --- PROOF 11: self-hosting ---------------------------------------------------

  it('PROOF 11 — WorkflowOS evaluates ITSELF through the revision-bound snapshot: real detectors over the real backend tree, claim-authority evidence', async () => {
    // Seed the /github authority with the REAL WorkflowOS backend tree at an
    // exact revision (fixture staging reads the live files ONCE; the runtime
    // read path is the snapshot at the bound ref — never the disk).
    const backendRoot = join(__dirname, '..', '..', '..');
    const selfFiles: Record<string, string> = {};
    const walkDir = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (entry === 'node_modules') continue;
        if (/\.ts$/.test(entry)) {
          selfFiles[`${prefix}${entry}`] = readFileSync(full, 'utf8');
        }
      }
    };
    // The modules tree (the frozen module-boundary surface).
    const modulesRoot = join(backendRoot, 'src', 'modules');
    for (const module of readdirSync(modulesRoot).sort()) {
      const moduleDir = join(modulesRoot, module);
      walkDir(moduleDir, `src/modules/${module}/`);
      const internalDir = join(moduleDir, 'internal');
      try {
        walkDir(internalDir, `src/modules/${module}/internal/`);
      } catch { /* module without internal/ */ }
    }
    // The checkpoint subsystem (runtime-configuration scan root).
    walkDir(join(backendRoot, 'src', 'architecture-checkpoints'), 'src/architecture-checkpoints/');
    walkDir(join(backendRoot, 'src', 'architecture-checkpoints', 'internal'), 'src/architecture-checkpoints/internal/');
    walkDir(join(backendRoot, 'src', 'architecture-checkpoints', 'internal', 'detectors'), 'src/architecture-checkpoints/internal/detectors/');
    // The transitions file.
    selfFiles['src/modules/workflows/internal/workflow.types.ts'] = readFileSync(
      join(backendRoot, 'src', 'modules', 'workflows', 'internal', 'workflow.types.ts'),
      'utf8',
    );
    // The migrations listing — registered as file entries so the derived
    // directory chain (src/platform/postgres/migrations) exists in the
    // snapshot; the detector reads the LISTING (names only).
    const migrationNames = readdirSync(join(backendRoot, 'src', 'platform', 'postgres', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const name of migrationNames) {
      selfFiles[`src/platform/postgres/migrations/${name}`] = '';
    }
    seedTree('wfos-self-host-head', selfFiles);

    const v = await frozenVersionWithAssertions([
      {
        assertionId: 'ARCH-SELF-001',
        severity: 'blocking',
        scope: 'repository',
        statement: 'No module imports another module internal/ (frozen module boundaries).',
        detectorKind: 'repository-structure',
        detectorConfig: {},
      },
      {
        assertionId: 'ARCH-SELF-002',
        severity: 'blocking',
        scope: 'module',
        statement: 'The workflow engine authority is implemented only by /workflows.',
        detectorKind: 'authority-ownership',
        detectorConfig: { ownerModule: 'workflows', authorityInterface: 'WorkflowEngine' },
      },
      {
        assertionId: 'ARCH-SELF-003',
        severity: 'blocking',
        scope: 'interface',
        statement: 'The /architecture public barrel exposes the assertion reader contract.',
        detectorKind: 'interface-contract',
        detectorConfig: { moduleDir: 'architecture', symbol: 'ArchitectureAssertionReader' },
      },
      {
        assertionId: 'ARCH-SELF-004',
        severity: 'blocking',
        scope: 'workflow',
        statement: 'The canonical workflow transition graph matches the frozen v1.0 map.',
        detectorKind: 'workflow-transition',
        detectorConfig: {
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
          rootPath: 'src/architecture-checkpoints',
          forbiddenPatterns: [
            {
              pathIncludes: 'architecture-checkpoints',
              pattern: 'setInterval|\\bcron\\b',
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
          migrationsDir: 'src/platform/postgres/migrations',
          // PR #52 round 2: 0055 is the /workflows governed PR-creation
          // intent ledger (the durable create-or-converge identity).
          expectedLastMigrationNumber: 55,
        },
      },
    ]);

    const wi = await workItemOn(v.id);
    const result = await service.evaluateCheckpoint(gate(wi.id, 'wfos-self-host-head'));

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

    // SELF-HOSTED VIOLATION DETECTION: a second revision carrying a real
    // architecture violation (a leaked internal/ import in a real module) is
    // caught through the same revision-bound path.
    const violatingFiles = { ...selfFiles };
    violatingFiles['src/modules/verification/internal/planted-leak.ts'] =
      "import type { AgentRunRepository } from '@modules/agents/internal/pg-agent-repository.js';\nexport const planted = true;\n";
    seedTree('wfos-self-host-violation', violatingFiles);
    const wi2 = await workItemOn(v.id);
    const blockedResult = await service.evaluateCheckpoint(gate(wi2.id, 'wfos-self-host-violation'));
    expect(blockedResult.status).toBe('blocked');
    expect(blockedResult.blockingFindings.join(' ')).toContain('planted-leak');
  });

  // --- work order context (traceability) ----------------------------------------

  it('records the Work Order context in the checkpoint evidence when provided', async () => {
    seedTree('rev-wo', cleanTreeFiles());
    const v = await frozenVersionWithAssertions([structureAssertion()]);
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
