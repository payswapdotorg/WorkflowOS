/**
 * WORK-038: Existing Project Onboarding — integration coverage.
 *
 * Covers the 22 frozen WORK-038 test requirements (connect + analyze a precise
 * revision; provenance observed/inferred/confirmed/proposed; no silent
 * promotion; existing authoritative architecture never overwritten;
 * idempotency; concurrent convergence; distinguishable revisions; CI via
 * /github; governed tooling; WORK-037 policy respect; secrets redaction;
 * tenant isolation; evidence references; failed analysis no false-confirmed;
 * crash recovery; native/external parity; no workflow/verification/review
 * mutation).
 *
 * The test wires the REAL onboarding orchestrator (DefaultOnboardingService)
 * + the REAL governed analyzer (GovernedFilesystemAnalyzer) + the REAL
 * /projects baseline storage (PgProjectBaselineRepository) on top of a real
 * PostgreSQL test database (pglite locally / real pg in CI). The /github
 * adapter is the sanctioned FakeGitHubAdapter (deterministic getBranch SHA);
 * the repository content port is an in-memory provider (deterministic file
 * tree); the policy gate is a configurable fake (to exercise allow/deny).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { PgProjectBaselineRepository } from '../../../src/modules/projects/internal/pg-project-baseline-repository.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import { DefaultOnboardingService } from '../../../src/onboarding/internal/default-onboarding-service.js';
import { GovernedFilesystemAnalyzer } from '../../../src/onboarding/internal/governed-filesystem-analyzer.js';
// PR #42 (Blocker 1) fix: the PRODUCTION RepositoryContentPort wiring (delegates
// to the /github GitHubAdapter — the only SDK caller). Exercised end-to-end
// against the FakeGitHubAdapter's in-memory content tree.
import { GitHubRepositoryContentPort } from '../../../src/onboarding/internal/github-content-port.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import type { RepositoryContentPort, ProjectScopedPolicyGate } from '@onboarding/index.js';
import type { ToolPolicyDecision, ToolPolicyRequest } from '@modules/agents/index.js';

/** A configurable in-memory repository content provider. */
class InMemoryContentPort implements RepositoryContentPort {
  private files = new Map<string, string>();
  private dirs = new Map<string, { name: string; type: 'file' | 'dir' }[]>();

  setFile(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }
  setDir(path: string, entries: { name: string; type: 'file' | 'dir' }[]): this {
    this.dirs.set(path, entries);
    return this;
  }

  async readFile(
    _owner: string,
    _repo: string,
    _sha: string,
    path: string,
    _installationId: string,
  ) {
    const content = this.files.get(path);
    if (content === undefined) return null;
    return { content, contentDigest: createHash('sha256').update(content, 'utf8').digest('hex') };
  }
  async listDir(
    _owner: string,
    _repo: string,
    _sha: string,
    path: string,
    _installationId: string,
  ) {
    return this.dirs.get(path) ?? [];
  }
}

/** A configurable project-scoped policy gate (defaults to allow). */
class FakePolicyGate implements ProjectScopedPolicyGate {
  private denied = new Set<string>();
  denyPath(path: string): this {
    this.denied.add(path);
    return this;
  }
  async decideForProjectScope(
    request: ToolPolicyRequest,
    _projectId: string,
    _organizationId: string,
  ): Promise<ToolPolicyDecision> {
    if (this.denied.has(request.input.path as string)) {
      return { decision: 'deny', reason: 'denied by test policy' };
    }
    return { decision: 'allow' };
  }
}

describe('WORK-038 — Existing Project Onboarding (Project Baseline + onboarding capability)', () => {
  let stack: TestAuthStack;
  let githubAdapter: FakeGitHubAdapter;
  let contentPort: InMemoryContentPort;
  let policyGate: FakePolicyGate;
  let projectBaselineRepository: PgProjectBaselineRepository;
  let projectGitHubRepositoryRepository: PgProjectGitHubRepositoryRepository;
  let onboardingService: DefaultOnboardingService;
  let capture: CaptureStream;
  let logger: ReturnType<typeof createLogger>;

  let orgId: string;
  let projectId: string;
  let userId: string;
  let repoLinkRowId: string;

  beforeEach(async () => {
    stack = await buildAuthStack();
    capture = new CaptureStream();
    logger = createLogger({ level: 'info', destination: capture });
    githubAdapter = new FakeGitHubAdapter();
    contentPort = new InMemoryContentPort();
    policyGate = new FakePolicyGate();
    projectBaselineRepository = new PgProjectBaselineRepository(stack.db.client);
    projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(stack.db.client);

    const analyzer = new GovernedFilesystemAnalyzer({
      contentPort,
      policyGate,
      logger,
    });
    onboardingService = new DefaultOnboardingService({
      projectRepository: stack.projectRepository,
      projectBaselineRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      analyzer,
      logger,
    });

    const org = await stack.organizationRepository.create({ name: 'Test Org' });
    orgId = org.id;
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'test-user',
      email: 'owner@test.example',
      displayName: 'Owner',
    });
    userId = user.id;
    await stack.membershipRepository.assign({ organizationId: orgId, userId, roleId: 'owner' });
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'Existing Project' });
    projectId = project.id;
    await stack.projectAccessRepository.grant({ userId, projectId, roleId: 'owner' });

    await stack.db.client.exec(`
      INSERT INTO wfos_github_installations (project_id, installation_id, account_login, metadata)
      VALUES ('${projectId}', '12345', 'test-org', '{}')
    `);
    const repoLink = await projectGitHubRepositoryRepository.create({
      projectId,
      installationId: '12345',
      owner: 'test-org',
      repository: 'existing-repo',
      defaultBranch: 'main',
      linkType: 'linked',
    });
    repoLinkRowId = repoLink.id;

    contentPort
      .setFile('package.json', JSON.stringify({
        name: 'existing-repo',
        version: '1.0.0',
        scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
        devDependencies: { typescript: '^5.0.0' },
      }))
      .setFile('README.md', '# Existing Repo\nA test repository.')
      .setDir('.github/workflows', [{ name: 'ci.yml', type: 'file' }])
      .setFile('Dockerfile', 'FROM node:20\nWORKDIR /app\nCOPY . .\nCMD ["node", "index.js"]');
  });

  afterEach(async () => {
    await stack.teardown();
  });

  it('1-3. connects an existing repo, analyzes a precise revision, and records the exact commit SHA', async () => {
    const result = await onboardingService.onboard({ projectId });
    expect(result.baseline.state).toBe('complete');
    expect(result.baseline.analysisMode).toBe('native');
    const branch = await githubAdapter.getBranch({
      owner: 'test-org',
      repository: 'existing-repo',
      branchName: 'main',
      installationId: '12345',
    });
    expect(result.baseline.baselineCommitSha).toBe(branch.sha);
    expect(result.baseline.baselineCommitSha).toMatch(/^fakesha/);
    expect(result.baseline.revisionRef).toBe('main');
  });

  it('4-5. marks direct file-content facts OBSERVED + derived facts INFERRED', async () => {
    const result = await onboardingService.onboard({ projectId });
    const baseline = await projectBaselineRepository.findById(result.baseline.id);
    expect(baseline!.state).toBe('complete');
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const observed = observations.filter((o) => o.provenance === 'observed');
    const inferred = observations.filter((o) => o.provenance === 'inferred');
    expect(observed.length, 'has observed facts').toBeGreaterThan(0);
    expect(inferred.length, 'has inferred facts').toBeGreaterThan(0);
    const repoIdentity = observed.find((o) => o.kind === 'repository_identity');
    expect(repoIdentity, 'repository_identity is observed').toBeDefined();
    const pkg = observed.find((o) => o.kind === 'package_managers');
    expect(pkg, 'package_managers is observed').toBeDefined();
    expect((pkg!.claim as { name: string }).name).toBe('existing-repo');
    const frameworks = inferred.find((o) => o.kind === 'frameworks');
    expect(frameworks, 'frameworks is inferred').toBeDefined();
    expect((frameworks!.claim as { frameworks: string[] }).frameworks).toContain('next');
  });

  it('6. marks the reconstructed architecture PROPOSED (never authoritative)', async () => {
    const result = await onboardingService.onboard({ projectId });
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const arch = observations.find((o) => o.kind === 'architecture');
    expect(arch, 'architecture observation exists').toBeDefined();
    expect(arch!.provenance).toBe('proposed');
    expect((arch!.claim as { authority: string }).authority).toMatch(/Requires user confirmation/);
  });

  it('7-8. confirms an inferred observation only through the authorized path (no silent promotion)', async () => {
    const result = await onboardingService.onboard({ projectId });
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const inferred = observations.find((o) => o.provenance === 'inferred')!;
    expect(inferred.provenance).toBe('inferred');
    expect(inferred.confirmedBy).toBeNull();
    const confirmed = await projectBaselineRepository.confirmObservation(
      result.baseline.id,
      inferred.id,
      userId,
    );
    expect(confirmed.provenance).toBe('confirmed');
    expect(confirmed.confirmedBy).toBe(userId);
    expect(confirmed.confirmedAt).not.toBeNull();
  });

  it('8b. an observed observation CANNOT be promoted to confirmed (no provenance rewrite)', async () => {
    const result = await onboardingService.onboard({ projectId });
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const observed = observations.find((o) => o.provenance === 'observed')!;
    await expect(
      projectBaselineRepository.confirmObservation(result.baseline.id, observed.id, userId),
    ).rejects.toThrow(/confirmation-inconsistent|inferred\/proposed -> confirmed/);
  });

  it('9. onboarding NEVER auto-freezes architecture (existing authoritative architecture is never overwritten)', async () => {
    const before = await stack.db.client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM wfos_architecture_versions`,
    );
    const beforeCount = before.rows[0]!.n;
    await onboardingService.onboard({ projectId });
    const after = await stack.db.client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM wfos_architecture_versions`,
    );
    expect(after.rows[0]!.n).toBe(beforeCount);
    const baselines = await projectBaselineRepository.listForProject(projectId);
    const obs = await projectBaselineRepository.listObservations(baselines[0]!.id);
    const arch = obs.find((o) => o.kind === 'architecture');
    expect(arch!.provenance).toBe('proposed');
  });

  it('10. re-onboarding the same revision is idempotent (no second baseline, no duplicate observations)', async () => {
    const first = await onboardingService.onboard({ projectId });
    const second = await onboardingService.onboard({ projectId });
    expect(second.baseline.id).toBe(first.baseline.id);
    expect(second.analyzed).toBe(false);
    const baselines = await projectBaselineRepository.listForProject(projectId);
    expect(baselines.length).toBe(1);
    const observations = await projectBaselineRepository.listObservations(first.baseline.id);
    const kinds = observations.map((o) => o.kind);
    const duplicates = kinds.filter((k, i) => kinds.indexOf(k) !== i);
    expect(duplicates, 'no duplicate observation kinds').toEqual([]);
  });

  it('11. concurrent onboarding requests converge safely (one baseline, CAS convergence)', async () => {
    const [a, b] = await Promise.all([
      onboardingService.onboard({ projectId }),
      onboardingService.onboard({ projectId }),
    ]);
    expect(a.baseline.id).toBe(b.baseline.id);
    expect(a.baseline.state).toBe('complete');
    expect(b.baseline.state).toBe('complete');
    const baselines = await projectBaselineRepository.listForProject(projectId);
    expect(baselines.length).toBe(1);
  });

  it('12. different repository revisions create distinguishable baselines', async () => {
    const mainResult = await onboardingService.onboard({ projectId, ref: 'main' });
    const otherResult = await onboardingService.onboard({ projectId, ref: 'feature-branch' });
    expect(otherResult.baseline.id).not.toBe(mainResult.baseline.id);
    expect(otherResult.baseline.baselineCommitSha).not.toBe(mainResult.baseline.baselineCommitSha);
    const baselines = await projectBaselineRepository.listForProject(projectId);
    expect(baselines.length).toBe(2);
  });

  it('13. the baseline revision is resolved through the /github authority + CI observations are recorded', async () => {
    const result = await onboardingService.onboard({ projectId });
    const branch = await githubAdapter.getBranch({
      owner: 'test-org',
      repository: 'existing-repo',
      branchName: 'main',
      installationId: '12345',
    });
    expect(result.baseline.baselineCommitSha).toBe(branch.sha);
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const ci = observations.find((o) => o.kind === 'ci');
    expect(ci, 'ci observation exists').toBeDefined();
    expect(ci!.provenance).toBe('observed');
  });

  it('14-15. analysis uses governed tooling + respects the WORK-037 policy gate (deny blocks the read)', async () => {
    policyGate.denyPath('package.json');
    const result = await onboardingService.onboard({ projectId });
    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);
    const pkgEvidence = evidence.find((e) => e.locator === 'package.json');
    expect(pkgEvidence, 'package.json evidence exists (the read was gated)').toBeDefined();
    expect(pkgEvidence!.policyDecision).toBe('deny');
    expect(pkgEvidence!.contentDigest).toBeNull();
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const pkg = observations.find((o) => o.kind === 'package_managers');
    expect(pkg, 'package_managers observation absent (deny blocked the read)').toBeUndefined();
    const readmeEvidence = evidence.find((e) => e.locator === 'README.md');
    expect(readmeEvidence!.policyDecision).toBe('allow');
  });

  it('16. secret-shaped values are redacted before persistence (secrets are not stored)', async () => {
    contentPort.setFile('package.json', JSON.stringify({
      name: 'leaky-repo',
      secret: 'super-secret-value-12345',
      dependencies: { react: '^18.0.0' },
    }));
    const result = await onboardingService.onboard({ projectId });
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const serialized = JSON.stringify(observations);
    expect(serialized, 'the raw secret value is not persisted').not.toContain('super-secret-value-12345');
    const pkg = observations.find((o) => o.kind === 'package_managers');
    if (pkg) {
      expect((pkg.claim as { secret?: string }).secret).toBe('[REDACTED]');
    }
  });

  it('17. tenant A cannot access tenant B’s baseline (cross-tenant access is denied)', async () => {
    const resultA = await onboardingService.onboard({ projectId });
    const orgB = await stack.organizationRepository.create({ name: 'Org B' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Project B' });
    await stack.db.client.exec(`
      INSERT INTO wfos_github_installations (project_id, installation_id, account_login, metadata)
      VALUES ('${projectB.id}', '99999', 'org-b', '{}')
    `);
    await projectGitHubRepositoryRepository.create({
      projectId: projectB.id,
      installationId: '99999',
      owner: 'org-b',
      repository: 'repo-b',
      defaultBranch: 'main',
      linkType: 'linked',
    });
    const baselinesForB = await projectBaselineRepository.listForProject(projectB.id);
    expect(baselinesForB.find((b) => b.id === resultA.baseline.id)).toBeUndefined();
    const aBaseline = await projectBaselineRepository.findById(resultA.baseline.id);
    expect(aBaseline!.projectId).toBe(projectId);
    expect(aBaseline!.organizationId).toBe(orgId);
    expect(projectB.organizationId).not.toBe(orgId);
  });

  it('18. baseline observations reference evidence (the traceability chain)', async () => {
    const result = await onboardingService.onboard({ projectId });
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);
    expect(evidence.length, 'evidence rows exist').toBeGreaterThan(0);
    const withEvidence = observations.filter((o) => o.evidenceRef.length > 0);
    expect(withEvidence.length, 'some observations reference evidence').toBeGreaterThan(0);
    const evidenceIds = new Set(evidence.map((e) => e.id));
    for (const obs of withEvidence) {
      for (const ref of obs.evidenceRef) {
        expect(evidenceIds.has(ref), `evidence ref ${ref} exists`).toBe(true);
      }
    }
  });

  it('19. a baseline with a confirmed observation cannot be marked failed (no false confirmed)', async () => {
    const result = await onboardingService.onboard({ projectId });
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const inferred = observations.find((o) => o.provenance === 'inferred')!;
    await projectBaselineRepository.confirmObservation(result.baseline.id, inferred.id, userId);
    await expect(
      projectBaselineRepository.markFailed(result.baseline.id, 'forced-fail', result.baseline.version),
    ).rejects.toThrow();
  });

  it('20. partial/crashed analysis is recoverable (an analyzing baseline is re-driven by a re-onboard)', async () => {
    const branch = await githubAdapter.getBranch({
      owner: 'test-org',
      repository: 'existing-repo',
      branchName: 'main',
      installationId: '12345',
    });
    const partial = await projectBaselineRepository.ensureBaseline({
      projectId,
      organizationId: orgId,
      projectGithubRepositoryId: repoLinkRowId,
      repositoryOwner: 'test-org',
      repositoryName: 'existing-repo',
      baselineCommitSha: branch.sha,
      revisionRef: 'main',
      analysisMode: 'native',
      analysisRunId: `onboarding:${projectId}:${repoLinkRowId}:${branch.sha}`,
    });
    expect(partial.state).toBe('analyzing');
    const result = await onboardingService.onboard({ projectId });
    expect(result.baseline.id).toBe(partial.id);
    expect(result.baseline.state).toBe('complete');
    expect(result.analyzed).toBe(true);
    const observations = await projectBaselineRepository.listObservations(partial.id);
    expect(observations.length, 'observations populated after recovery').toBeGreaterThan(0);
  });

  it('21. native and external onboarding preserve the same project identity (same baseline schema)', async () => {
    const nativeResult = await onboardingService.onboard({ projectId, analysisMode: 'native' });
    expect(nativeResult.baseline.analysisMode).toBe('native');
    const externalResult = await onboardingService.onboard({ projectId, analysisMode: 'external', ref: 'external-branch' });
    expect(externalResult.baseline.analysisMode).toBe('external');
    expect(nativeResult.baseline.id).not.toBe(externalResult.baseline.id);
    const nativeBaseline = await projectBaselineRepository.findById(nativeResult.baseline.id);
    const externalBaseline = await projectBaselineRepository.findById(externalResult.baseline.id);
    expect(nativeBaseline!.projectId).toBe(projectId);
    expect(externalBaseline!.projectId).toBe(projectId);
    const nativeObs = await projectBaselineRepository.listObservations(nativeResult.baseline.id);
    const externalObs = await projectBaselineRepository.listObservations(externalResult.baseline.id);
    for (const o of [...nativeObs, ...externalObs]) {
      expect(['observed', 'inferred', 'confirmed', 'proposed']).toContain(o.provenance);
    }
  });

  it('22. onboarding does not mutate workflow / verification / review state', async () => {
    const wfBefore = await stack.db.client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wfos_workflow_executions`);
    const verBefore = await stack.db.client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wfos_work_item_criteria`);
    const reviewBefore = await stack.db.client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wfos_reviews`);
    await onboardingService.onboard({ projectId });
    const wfAfter = await stack.db.client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wfos_workflow_executions`);
    const verAfter = await stack.db.client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wfos_work_item_criteria`);
    const reviewAfter = await stack.db.client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wfos_reviews`);
    expect(wfAfter.rows[0]!.n).toBe(wfBefore.rows[0]!.n);
    expect(verAfter.rows[0]!.n).toBe(verBefore.rows[0]!.n);
    expect(reviewAfter.rows[0]!.n).toBe(reviewBefore.rows[0]!.n);
  });

  // =========================================================================
  // PR #42 review fixes (three blockers the architect identified).
  // =========================================================================

  it('23. PR #42 (Blocker 1): the production RepositoryContentPort wiring reads repository files through the /github GitHubAdapter', async () => {
    // The architect's PR #42 Blocker 1: the production analyzer had NO
    // RepositoryContentPort — onboarding never inspected repository files
    // (only metadata-derived observations); the tests used an in-memory
    // provider and so did not exercise the production wiring. This test
    // constructs a SECOND onboarding service that uses the PRODUCTION
    // GitHubRepositoryContentPort (delegating to the FakeGitHubAdapter's
    // in-memory content tree) instead of the in-memory InMemoryContentPort,
    // and proves the production wiring reads repository files end-to-end
    // through the /github GitHubAdapter.
    //
    // Use a UNIQUE ref so this creates a fresh baseline (the main-sha
    // baseline may already be complete from earlier tests, which would make
    // onboard return early without re-running the analyzer).
    const ref = 'production-port-branch';
    const branch = await githubAdapter.getBranch({
      owner: 'test-org',
      repository: 'existing-repo',
      branchName: ref,
      installationId: '12345',
    });
    // Set content on the FakeGitHubAdapter — the production port reads
    // through it (the GitHubAdapter is the only SDK caller in production;
    // the fake provides the deterministic content tree here).
    githubAdapter.setFile(
      'test-org', 'existing-repo', branch.sha, 'package.json',
      JSON.stringify({
        name: 'production-wired-repo',
        version: '2.0.0',
        scripts: { build: 'tsc', test: 'vitest' },
        dependencies: { next: '^14.0.0' },
      }),
    );
    githubAdapter.setDir(
      'test-org', 'existing-repo', branch.sha, '.github/workflows',
      [{ name: 'ci.yml', type: 'file' }],
    );
    githubAdapter.setFile(
      'test-org', 'existing-repo', branch.sha, 'Dockerfile', 'FROM node:20',
    );

    // The PRODUCTION content port (delegates to the GitHubAdapter).
    const productionContentPort = new GitHubRepositoryContentPort(githubAdapter);
    const productionAnalyzer = new GovernedFilesystemAnalyzer({
      contentPort: productionContentPort,
      policyGate,
      logger,
    });
    const productionService = new DefaultOnboardingService({
      projectRepository: stack.projectRepository,
      projectBaselineRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      analyzer: productionAnalyzer,
      logger,
    });

    const result = await productionService.onboard({ projectId, ref });
    expect(result.baseline.state).toBe('complete');
    expect(result.analyzed).toBe(true);
    expect(result.baseline.baselineCommitSha).toBe(branch.sha);
    // The package_managers observation reflects the content read THROUGH the
    // production port (the GitHubAdapter's setFile content), proving the
    // production wiring inspects repository files.
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const pkg = observations.find((o) => o.kind === 'package_managers');
    expect(pkg, 'package_managers observation produced via the production content port').toBeDefined();
    expect((pkg!.claim as { name: string }).name).toBe('production-wired-repo');
    // The evidence records the governed read (the policy decision + the
    // content digest from the GitHubAdapter — non-null because content was read).
    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);
    const pkgEvidence = evidence.find((e) => e.locator === 'package.json');
    expect(pkgEvidence, 'package.json evidence exists').toBeDefined();
    expect(pkgEvidence!.policyDecision).toBe('allow');
    expect(pkgEvidence!.contentDigest).not.toBeNull();
    // The CI observation was derived from the .github/workflows listing the
    // production port returned through the GitHubAdapter.
    const ci = observations.find((o) => o.kind === 'ci');
    expect(ci, 'ci observation produced via the production content port').toBeDefined();
    expect((ci!.claim as { workflows: string[] }).workflows).toContain('ci.yml');
  });

  it('24. PR #42 (Blocker 2): a direct DELETE on an observation is forbidden (append-only); the CASCADE from baseline deletion still works', async () => {
    // The architect's PR #42 Blocker 2: the migration's DELETE trigger
    // explicitly permitted deletion (`RETURN OLD`) despite describing
    // observations as append-only historical evidence. The fix: a direct
    // DELETE is forbidden (the parent baseline still exists); the ONLY
    // legitimate removal path is the CASCADE from baseline deletion (the
    // parent baseline is already gone when the observation DELETE trigger
    // fires — PERFORM returns NOT FOUND, so the trigger allows it).
    const result = await onboardingService.onboard({ projectId });
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const obs = observations[0]!;
    // A DIRECT DELETE on an observation is forbidden. Wrap in a transaction
    // so the RAISE EXCEPTION aborts only this transaction (the helper issues
    // ROLLBACK; the session stays clean for the CASCADE verification below).
    await expect(
      stack.db.client.transaction(async (tx) => {
        await tx.query(
          'DELETE FROM wfos_project_baseline_observations WHERE id = $1',
          [obs.id],
        );
      }),
    ).rejects.toThrow(/append-only/);
    // The observation still exists (the forbidden DELETE was rolled back).
    const stillThere = await projectBaselineRepository.listObservations(result.baseline.id);
    expect(stillThere.find((o) => o.id === obs.id), 'the observation survives the forbidden direct DELETE').toBeDefined();
    // The CASCADE from baseline deletion still works (the parent baseline is
    // already gone when the observation DELETE trigger fires — PERFORM
    // returns NOT FOUND, so the trigger allows the CASCADE).
    await stack.db.client.query(
      'DELETE FROM wfos_project_baselines WHERE id = $1',
      [result.baseline.id],
    );
    const gone = await projectBaselineRepository.listObservations(result.baseline.id);
    expect(gone.length, 'observations cascade-deleted with the baseline').toBe(0);
    const baselineGone = await projectBaselineRepository.findById(result.baseline.id);
    expect(baselineGone, 'the baseline is gone').toBeNull();
  });

  it('25. PR #42 (Blocker 3): a failed baseline cannot have an observation confirmed (failed → confirmed is forbidden)', async () => {
    // The architect's PR #42 Blocker 3: confirmObservation did not check the
    // parent baseline state, allowing failed → confirmed. The invariant
    // (migration 0038): "a failed baseline NEVER carries a confirmed
    // observation (failed analysis cannot produce a false confirmed
    // baseline)." markFailed enforces the symmetric side (refuses when a
    // confirmed observation exists); confirmObservation must enforce THIS
    // side — refuse when the parent baseline is already failed.
    //
    // Use a UNIQUE ref so this creates a fresh 'analyzing' baseline (the
    // main-sha baseline may already be complete/failed from earlier tests).
    const ref = 'failed-confirmation-branch';
    const branch = await githubAdapter.getBranch({
      owner: 'test-org',
      repository: 'existing-repo',
      branchName: ref,
      installationId: '12345',
    });
    const partial = await projectBaselineRepository.ensureBaseline({
      projectId,
      organizationId: orgId,
      projectGithubRepositoryId: repoLinkRowId,
      repositoryOwner: 'test-org',
      repositoryName: 'existing-repo',
      baselineCommitSha: branch.sha,
      revisionRef: ref,
      analysisMode: 'native',
      analysisRunId: `onboarding:${projectId}:${repoLinkRowId}:${branch.sha}`,
    });
    expect(partial.state).toBe('analyzing');
    // Insert an inferred observation on the analyzing baseline.
    const inferredClaim = { frameworks: ['next'], inferredFrom: 'test' };
    await projectBaselineRepository.upsertObservations(partial.id, [
      {
        kind: 'frameworks',
        provenance: 'inferred',
        claim: inferredClaim,
        claimDigest: createHash('sha256').update(JSON.stringify(inferredClaim)).digest('hex'),
        evidenceRef: [],
      },
    ]);
    // markFailed succeeds (no confirmed observation exists).
    const failed = await projectBaselineRepository.markFailed(partial.id, 'forced-fail', 0);
    expect(failed, 'markFailed must succeed (no confirmed observation exists)').not.toBeNull();
    expect(failed!.state).toBe('failed');
    // confirmObservation must refuse — the baseline is failed (a failed
    // baseline must never carry a confirmed observation).
    const obs = await projectBaselineRepository.listObservations(partial.id);
    const inferred = obs.find((o) => o.provenance === 'inferred')!;
    await expect(
      projectBaselineRepository.confirmObservation(partial.id, inferred.id, userId),
    ).rejects.toThrow(/no-confirmed-on-failed|failed/);
    // The observation remains inferred (no silent promotion — the
    // confirmation path is the only way to 'confirmed', and it is refused).
    const after = await projectBaselineRepository.listObservations(partial.id);
    const stillInferred = after.find((o) => o.id === inferred.id)!;
    expect(stillInferred.provenance).toBe('inferred');
    expect(stillInferred.confirmedBy).toBeNull();
  });
});
