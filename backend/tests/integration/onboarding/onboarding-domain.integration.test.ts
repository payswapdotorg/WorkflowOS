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
import { GovernedFilesystemAnalyzer, GOVERNED_FILESYSTEM_CANDIDATE_ALLOWLIST } from '../../../src/onboarding/internal/governed-filesystem-analyzer.js';
import { DefaultGovernedRepositoryReadPolicy } from '../../../src/onboarding/internal/governed-repository-read-policy.js';
// PR #42 (Blocker 1) fix: the PRODUCTION RepositoryContentPort wiring (delegates
// to the /github GitHubAdapter — the only SDK caller). Exercised end-to-end
// against the FakeGitHubAdapter's in-memory content tree.
import { GitHubRepositoryContentPort } from '../../../src/onboarding/internal/github-content-port.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import type { RepositoryContentPort, ProjectScopedPolicyGate } from '@onboarding/index.js';
import type { ToolPolicyConstraints, ToolPolicyRequest } from '@modules/agents/index.js';

/**
 * Wires the REAL governed repository-read boundary (PR #42 round-3) around
 * the test's content port + policy gate + the analyzer's candidate
 * allowlist, then constructs the analyzer on top of it. The integration
 * suite exercises the real boundary end-to-end (the boundary IS the unit
 * under test for the round-3 invariants — atomic decide+enforce+read+
 * record; constrained truncation; path-allowlist; honest evidence).
 */
function buildGovernedAnalyzer(
  contentPort: RepositoryContentPort,
  policyGate: ProjectScopedPolicyGate,
  logger: ReturnType<typeof createLogger>,
): GovernedFilesystemAnalyzer {
  const governedReadPolicy = new DefaultGovernedRepositoryReadPolicy({
    policyGate,
    contentPort,
    candidateAllowlist: GOVERNED_FILESYSTEM_CANDIDATE_ALLOWLIST,
    logger,
  });
  return new GovernedFilesystemAnalyzer({ governedReadPolicy, logger });
}

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

/**
 * PR #42 round-2 (Blocker B): a content port that ALWAYS throws on reads —
 * simulates a /github-authority infrastructure failure (GitHub unavailable,
 * authentication failure, API failure, content retrieval infrastructure
 * failure). The analyzer must propagate this as a typed
 * OnboardingAnalysisError so the orchestrator can markFailed the baseline
 * (the baseline must NEVER reach 'complete' on a content-provider failure).
 */
class FailingContentPort implements RepositoryContentPort {
  constructor(private readonly failureCode: string = 'github-not-configured') {}
  async readFile(
    _owner: string,
    _repo: string,
    _sha: string,
    path: string,
    _installationId: string,
  ): Promise<{ readonly content: string; readonly contentDigest: string } | null> {
    throw new Error(`${this.failureCode}: simulated infrastructure failure reading file '${path}'`);
  }
  async listDir(
    _owner: string,
    _repo: string,
    _sha: string,
    path: string,
    _installationId: string,
  ): Promise<readonly { readonly name: string; readonly type: 'file' | 'dir' }[]> {
    throw new Error(`${this.failureCode}: simulated infrastructure failure listing dir '${path}'`);
  }
}

/** A configurable project-scoped policy gate (defaults to allow). */
class FakePolicyGate implements ProjectScopedPolicyGate {
  private denied = new Set<string>();
  private constrained: { readonly paths: Set<string>; readonly constraints: ToolPolicyConstraints } | null = null;
  private nextPolicyVersion = 1;
  denyPath(path: string): this {
    this.denied.add(path);
    return this;
  }
  /** PR #42 round-3: constrain a set of paths with the given constraints (maxOutputBytes truncation effect). */
  constrainPaths(paths: string[], constraints: ToolPolicyConstraints): this {
    this.constrained = { paths: new Set(paths), constraints };
    return this;
  }
  async decideForProjectScope(
    request: ToolPolicyRequest,
    _projectId: string,
    _organizationId: string,
  ) {
    const path = request.input.path as string;
    // PR #42 round-3: the fake surfaces policyVersion + ruleId + scopeSource
    // so the governed boundary can record them on the evidence row (drift
    // detection + forensic provenance). The real AgentPolicyEngine surfaces
    // these from evaluateCore; the fake simulates them deterministically.
    const base = { policyVersion: this.nextPolicyVersion, ruleId: 'fake-rule', scopeSource: 'project' as const };
    if (this.denied.has(path)) {
      return { ...base, decision: 'deny' as const, reason: 'denied by test policy' };
    }
    if (this.constrained && this.constrained.paths.has(path)) {
      return { ...base, decision: 'constrained' as const, constraints: this.constrained.constraints, reason: 'constrained by test policy' };
    }
    return { ...base, decision: 'allow' as const };
  }
}

/**
 * PR #42 round-4: a policy gate that starts at V7/allow and can be mutated
 * mid-read to V8/allow (version + ruleId change, decision stays allow) —
 * simulates a concurrent policy mutation committing DURING a read (between
 * the capture and the revalidation). The fence must DETECT the stale
 * snapshot (the version changed) and DISCARD the read result (zero evidence
 * + zero observation for that path). The decision stays 'allow' so the
 * SUBSEQUENT reads (which capture + revalidate V8) are NOT stale and DO
 * produce evidence — this isolates the fence's behavior: only the read whose
 * snapshot drifted is discarded; the other reads succeed under the new
 * version.
 */
class MutatingPolicyGate implements ProjectScopedPolicyGate {
  private policyVersion = 7;
  private decision: 'allow' | 'deny' = 'allow';
  private ruleId = 'fake-rule-v7';
  private mutated = false;
  /** Mutate the policy to V8 (version + ruleId change; decision stays allow so subsequent reads succeed). */
  mutateToV8(): void {
    this.policyVersion = 8;
    this.ruleId = 'fake-rule-v8';
    this.mutated = true;
  }
  wasMutated(): boolean {
    return this.mutated;
  }
  async decideForProjectScope(
    _request: ToolPolicyRequest,
    _projectId: string,
    _organizationId: string,
  ) {
    return {
      decision: this.decision,
      policyVersion: this.policyVersion,
      ruleId: this.ruleId,
      scopeSource: 'project' as const,
      reason: this.mutated ? 'allowed by V8 (mutated)' : 'allowed by V7',
    };
  }
}

/**
 * PR #42 round-4: a content port that fires a hook on the FIRST read call
 * (readFile or listDir) — the hook mutates the gate mid-read (between the
 * capture and the revalidation). This is the test hook the architect's
 * regression spec requires: "test hook mutates policy to v8 while read is in
 * flight." The hook fires ONLY on the first read so the SUBSEQUENT reads
 * capture + revalidate the same (mutated) version — they are not stale
 * (the policy did not change again between their capture and revalidation).
 */
class HookedContentPort implements RepositoryContentPort {
  private files = new Map<string, string>();
  private dirs = new Map<string, { name: string; type: 'file' | 'dir' }[]>();
  private hookFired = false;
  constructor(private readonly onFirstRead: () => void) {}
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
    if (!this.hookFired) {
      this.hookFired = true;
      this.onFirstRead();
    }
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
    if (!this.hookFired) {
      this.hookFired = true;
      this.onFirstRead();
    }
    return this.dirs.get(path) ?? [];
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

    const analyzer = buildGovernedAnalyzer(contentPort, policyGate, logger);
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

  it('14-15. analysis respects the WORK-037 policy gate (deny blocks the read; the /github read is NOT a tool invocation — no fake toolInvocationId on the evidence)', async () => {
    // PR #42 round-2 (Blocker A): the /github read path is NOT a
    // ToolRuntime invocation. The evidence row honestly records NULL
    // tool_invocation_id (no ToolRuntime invocation happened) and NULL
    // policy_decision (no host tool run — the schema reserves
    // policy_decision for "host tool run" audit trail). The WORK-037
    // project-scoped gate IS still consulted at runtime (the analyzer
    // refuses to proceed on deny/ask); that consultation is a runtime
    // invariant, not an evidence-row claim.
    policyGate.denyPath('package.json');
    const result = await onboardingService.onboard({ projectId });
    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);
    const pkgEvidence = evidence.find((e) => e.locator === 'package.json');
    expect(pkgEvidence, 'package.json evidence exists (the read was attempted)').toBeDefined();
    // The evidence row honestly records NO tool invocation and NO host
    // tool run policy decision (the /github read path is not a
    // ToolRuntime invocation).
    expect(pkgEvidence!.toolInvocationId).toBeNull();
    expect(pkgEvidence!.policyDecision).toBeNull();
    // deny blocked the read → no content observed.
    expect(pkgEvidence!.contentDigest).toBeNull();
    // PR #42 round-3: the ACTUAL decision that governed the read is now
    // RECORDED on the evidence row (in repository_read_decision — its OWN
    // column, NOT masquerading as a Tool Runtime invocation). The round-2
    // path recorded policy_decision=NULL AND tool_invocation_id=NULL, so the
    // decision was not recorded at all. The round-3 boundary records it.
    expect(pkgEvidence!.repositoryReadDecision, 'the deny decision IS recorded on the evidence row').toBe('deny');
    expect(pkgEvidence!.repositoryReadEnforcement, 'the enforcement record is present').not.toBeNull();
    expect(pkgEvidence!.repositoryReadEnforcement!.performed, 'deny -> performed=false (the read did not happen)').toBe(false);
    expect(pkgEvidence!.repositoryReadEnforcement!.pathAllowed, 'package.json is in the candidate allowlist').toBe(true);
    // The package_managers observation is absent (deny blocked the
    // derived observation — the runtime invariant: a denied read cannot
    // contribute observed/inferred facts).
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const pkg = observations.find((o) => o.kind === 'package_managers');
    expect(pkg, 'package_managers observation absent (deny blocked the read)').toBeUndefined();
    // A non-blocked read (README.md) still produces content (the gate's
    // 'allow' decision is respected at runtime — content is read). The
    // evidence row still honestly records NULL tool_invocation_id and
    // NULL policy_decision (the /github read is NOT a tool invocation).
    const readmeEvidence = evidence.find((e) => e.locator === 'README.md');
    expect(readmeEvidence!.contentDigest).not.toBeNull();
    expect(readmeEvidence!.toolInvocationId).toBeNull();
    expect(readmeEvidence!.policyDecision).toBeNull();
    // PR #42 round-3: the allow decision IS recorded on the README evidence row.
    expect(readmeEvidence!.repositoryReadDecision).toBe('allow');
    expect(readmeEvidence!.repositoryReadEnforcement!.performed, 'allow -> performed=true (the read happened)').toBe(true);
    expect(readmeEvidence!.repositoryReadEnforcement!.pathAllowed).toBe(true);
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
    const productionAnalyzer = buildGovernedAnalyzer(productionContentPort, policyGate, logger);
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
    // PR #42 round-2 (Blocker A): the evidence row honestly records NO
    // tool invocation (tool_invocation_id IS NULL — the /github read path
    // is NOT a ToolRuntime invocation) and NO host tool run policy
    // decision (policy_decision IS NULL — the schema reserves
    // policy_decision for "host tool run" audit trail). The content
    // digest is non-null because content WAS read through the production
    // port (the GitHubAdapter's setFile content). The WORK-037
    // project-scoped gate IS still consulted at runtime (the analyzer
    // refuses to proceed on deny/ask); that is a runtime invariant, not
    // an evidence-row claim.
    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);
    const pkgEvidence = evidence.find((e) => e.locator === 'package.json');
    expect(pkgEvidence, 'package.json evidence exists').toBeDefined();
    expect(pkgEvidence!.toolInvocationId, 'no fake toolInvocationId (no ToolRuntime invocation)').toBeNull();
    expect(pkgEvidence!.policyDecision, 'no host tool run policy_decision (the /github read is not a tool invocation)').toBeNull();
    expect(pkgEvidence!.contentDigest, 'content was read through the production port').not.toBeNull();
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

  // =========================================================================
  // PR #42 round-2 review fixes (the two new blockers the architect
  // identified on the 48c4612 diff):
  //   Blocker A — repository analysis is still not actually using the Tool
  //     Runtime (the analyzer manufactured tool_invocation_id + policy_decision
  //     for /github-authority reads that never went through Tool Runtime).
  //   Blocker B — a complete baseline could be produced with no repository
  //     content (the analyzer's per-candidate try/catch swallowed
  //     infrastructure failures, so a GitHub-unavailable baseline reached
  //     'complete' with only metadata observations).
  // =========================================================================

  it('26. PR #42 r2 (Blocker B): missing package.json → still a valid complete analysis (expected-missing is graceful)', async () => {
    // The architect's PR #42 round-2 Blocker B required: distinguish
    // expected-missing (file absent / directory absent — the analyzer
    // continues, the baseline still completes) from infrastructure failure
    // (GitHub unavailable — the analyzer propagates, the baseline fails).
    // This test exercises the expected-missing path: the InMemoryContentPort
    // returns null for package.json (no setup) → the analyzer continues →
    // the baseline still completes (with the observations it could derive
    // from the other candidates).
    //
    // Use a UNIQUE ref so this creates a fresh baseline (the main-sha
    // baseline may already be complete from earlier tests).
    const ref = 'missing-package-json-branch';
    const branch = await githubAdapter.getBranch({
      owner: 'test-org',
      repository: 'existing-repo',
      branchName: ref,
      installationId: '12345',
    });
    // Construct an analyzer with a content port that returns null for
    // package.json (file absent) and [] for .github/workflows (dir absent),
    // but DOES return README.md + Dockerfile content (the other candidates).
    const partialContentPort = new InMemoryContentPort()
      .setFile('README.md', '# Missing Package Repo\nNo package.json here.')
      .setFile('Dockerfile', 'FROM node:20');
    // Do NOT set package.json (file absent → null). Do NOT set .github/workflows
    // (dir absent → []). Do NOT set docker-compose.yml or prisma/schema.prisma.
    const partialAnalyzer = buildGovernedAnalyzer(partialContentPort, policyGate, logger);
    const partialService = new DefaultOnboardingService({
      projectRepository: stack.projectRepository,
      projectBaselineRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      analyzer: partialAnalyzer,
      logger,
    });
    const result = await partialService.onboard({ projectId, ref });
    // Expected-missing is graceful: the baseline STILL completes (it derives
    // observations from README.md + Dockerfile; the package_managers /
    // frameworks / languages observations are absent because package.json
    // was absent).
    expect(result.baseline.state, 'expected-missing is graceful — baseline completes').toBe('complete');
    expect(result.baseline.baselineCommitSha).toBe(branch.sha);
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    // The package_managers observation is ABSENT (no package.json content).
    const pkg = observations.find((o) => o.kind === 'package_managers');
    expect(pkg, 'no package_managers observation (package.json was absent)').toBeUndefined();
    // The deployment observation IS present (Dockerfile was read).
    const deployment = observations.find((o) => o.kind === 'deployment');
    expect(deployment, 'deployment observation present (Dockerfile was read)').toBeDefined();
    // The CI observation is ABSENT (.github/workflows dir was absent).
    const ci = observations.find((o) => o.kind === 'ci');
    expect(ci, 'no ci observation (.github/workflows was absent)').toBeUndefined();
    // The repository_identity observation IS present (always observed from
    // the context metadata, regardless of content reads).
    const repoId = observations.find((o) => o.kind === 'repository_identity');
    expect(repoId, 'repository_identity observation always present').toBeDefined();
  });

  it('27. PR #42 r2 (Blocker B): GitHub / content provider unavailable → the baseline is NOT complete (infrastructure failure propagates → markFailed)', async () => {
    // The architect's PR #42 round-2 Blocker B required: distinguish
    // expected-missing (continue) from infrastructure failure (the content
    // provider throws — GitHub unavailable, authentication failure, API
    // failure, content retrieval infrastructure failure). The latter must
    // propagate so the orchestrator markFailed the baseline — the baseline
    // must NEVER reach 'complete' when the required repository analysis
    // could not actually inspect the repository.
    //
    // The previous implementation's per-candidate try/catch swallowed
    // GitHub-unavailable failures and produced a false 'complete' baseline
    // with only metadata observations. This test proves that loophole is
    // closed.
    const ref = 'github-unavailable-branch';
    const branch = await githubAdapter.getBranch({
      owner: 'test-org',
      repository: 'existing-repo',
      branchName: ref,
      installationId: '12345',
    });
    // The FailingContentPort throws on EVERY read — simulates GitHub
    // unavailable (the production DefaultGitHubAdapter throws
    // 'github-not-configured' until credentials are wired; this fake
    // reproduces that infrastructure-failure mode).
    const failingContentPort = new FailingContentPort('github-not-configured');
    const failingAnalyzer = buildGovernedAnalyzer(failingContentPort, policyGate, logger);
    const failingService = new DefaultOnboardingService({
      projectRepository: stack.projectRepository,
      projectBaselineRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      analyzer: failingAnalyzer,
      logger,
    });
    const result = await failingService.onboard({ projectId, ref });
    // The baseline is NOT complete — it is FAILED (the orchestrator caught
    // the typed OnboardingAnalysisError and markFailed with the
    // 'repository-content-unavailable' failure stage).
    expect(result.baseline.state, 'GitHub-unavailable → failed (not complete)').toBe('failed');
    expect(result.baseline.baselineCommitSha).toBe(branch.sha);
    expect(result.baseline.failureStage, 'failure_stage is the forensic provenance').toBe('repository-content-unavailable');
    // The baseline carries NO content-derived observations (only the
    // repository_identity observation may have been persisted — but since
    // the analyzer threw BEFORE the orchestrator's persist step, even
    // repository_identity is absent).
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    expect(observations.length, 'no observations persisted (analysis threw before persist)').toBe(0);
  });

  it('28. PR #42 r2 (Blocker B): partial candidate failure according to the frozen requirement (some candidates expected-missing, others succeed → baseline still completes)', async () => {
    // The architect's PR #42 round-2 regression-coverage list includes
    // "partial candidate failure according to the frozen requirement" — the
    // analyzer gracefully handles per-candidate EXPECTED-missing (file
    // absent, dir absent, unparseable JSON) without aborting. The baseline
    // completes with whatever observations could be derived.
    //
    // This is the WORK-038 frozen-requirement behavior: package.json
    // present but unparseable → record nothing (the observed read still
    // produced evidence; the inference is skipped); file absent → continue;
    // directory absent → continue. None of these abort the baseline.
    const ref = 'partial-candidate-failure-branch';
    const branch = await githubAdapter.getBranch({
      owner: 'test-org',
      repository: 'existing-repo',
      branchName: ref,
      installationId: '12345',
    });
    // A content port where:
    //   * package.json is present but UNPARSEABLE (malformed JSON) — the
    //     analyzer's try { JSON.parse } catch handles it gracefully (the
    //     observed read still produced evidence; the inference is skipped);
    //   * README.md is present + parseable (a normal read);
    //   * .github/workflows dir is absent (returns []) — the analyzer
    //     continues (no ci observation);
    //   * Dockerfile is present (a normal read);
    //   * docker-compose.yml + prisma/schema.prisma are absent (return null)
    //     — the analyzer continues.
    const partialContentPort = new InMemoryContentPort()
      .setFile('package.json', '{ this is not valid JSON ((((')
      .setFile('README.md', '# Partial Repo\nSome candidates are missing.')
      .setFile('Dockerfile', 'FROM node:20');
    const partialAnalyzer = buildGovernedAnalyzer(partialContentPort, policyGate, logger);
    const partialService = new DefaultOnboardingService({
      projectRepository: stack.projectRepository,
      projectBaselineRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      analyzer: partialAnalyzer,
      logger,
    });
    const result = await partialService.onboard({ projectId, ref });
    // Partial candidate failure (expected-missing + unparseable) is graceful
    // — the baseline STILL completes (it derives observations from the
    // candidates that DID have content; the unparseable/absent candidates
    // contribute no observations).
    expect(result.baseline.state, 'partial expected-failure is graceful — baseline completes').toBe('complete');
    expect(result.baseline.baselineCommitSha).toBe(branch.sha);
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    // The package_managers observation is ABSENT (package.json was
    // unparseable — JSON.parse threw, the analyzer skipped the inference).
    const pkg = observations.find((o) => o.kind === 'package_managers');
    expect(pkg, 'no package_managers observation (package.json was unparseable)').toBeUndefined();
    // The deployment observation IS present (Dockerfile was read).
    const deployment = observations.find((o) => o.kind === 'deployment');
    expect(deployment, 'deployment observation present (Dockerfile was read)').toBeDefined();
    // The CI observation is ABSENT (.github/workflows dir was absent).
    const ci = observations.find((o) => o.kind === 'ci');
    expect(ci, 'no ci observation (.github/workflows was absent)').toBeUndefined();
    // The evidence row for package.json is STILL persisted (the read
    // succeeded; the content was unparseable, but the evidence row records
    // the content_digest of the raw (unparseable) content).
    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);
    const pkgEvidence = evidence.find((e) => e.locator === 'package.json');
    expect(pkgEvidence, 'package.json evidence row persisted (the read was attempted)').toBeDefined();
    expect(pkgEvidence!.contentDigest, 'content_digest is the raw (unparseable) content fingerprint').not.toBeNull();
    // PR #42 round-2 (Blocker A): the evidence row honestly records NO
    // tool invocation and NO host tool run policy decision.
    expect(pkgEvidence!.toolInvocationId).toBeNull();
    expect(pkgEvidence!.policyDecision).toBeNull();
  });

  it('29. PR #42 r2 (Blocker A): no fake tool invocation / evidence for reads that never executed through Tool Runtime', async () => {
    // The architect's PR #42 round-2 Blocker A: the production path is
    //   Onboarding → GovernedFilesystemAnalyzer → ToolPolicyGate.decideForProjectScope
    //     → GitHubRepositoryContentPort → GitHubAdapter.getFileContent/listDir
    // The policy gate is consulted, but the actual repository read is
    // performed directly by /github. There is NO ToolRuntime invocation,
    // NO real tool claim, NO tool observation. The evidence row must NOT
    // manufacture a tool_invocation_id for operations that never went
    // through Tool Runtime. The policy_decision must NOT imply a host tool
    // run occurred (the schema reserves policy_decision for "host tool
    // run" audit trail — the /github read is NOT a host tool run).
    //
    // This test asserts: EVERY evidence row produced by the governed
    // analyzer has tool_invocation_id IS NULL and policy_decision IS NULL
    // (the /github read path is NOT a ToolRuntime invocation). The WORK-037
    // gate IS still consulted at runtime (the analyzer refuses to proceed
    // on deny/ask — verified by test 14-15); that consultation is a runtime
    // invariant, not an evidence-row claim.
    const result = await onboardingService.onboard({ projectId });
    expect(result.baseline.state).toBe('complete');
    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);
    expect(evidence.length, 'evidence rows exist').toBeGreaterThan(0);
    // EVERY evidence row honestly records NO tool invocation and NO host
    // tool run policy decision (the /github read path is NOT a
    // ToolRuntime invocation — do not manufacture tool_invocation_ids for
    // operations that never went through Tool Runtime).
    for (const ev of evidence) {
      expect(ev.toolInvocationId, `evidence row ${ev.locator}: tool_invocation_id must be NULL (no ToolRuntime invocation)`).toBeNull();
      expect(ev.policyDecision, `evidence row ${ev.locator}: policy_decision must be NULL (no host tool run)`).toBeNull();
    }
    // PR #42 round-3: the ACTUAL decision + enforcement ARE recorded on EVERY
    // evidence row (in repository_read_decision + repository_read_enforcement
    // — their OWN columns, NOT masquerading as a Tool Runtime invocation).
    // The round-2 path left the decision unrecorded (policy_decision=NULL +
    // tool_invocation_id=NULL); the round-3 boundary records it honestly.
    for (const ev of evidence) {
      expect(ev.repositoryReadDecision, `evidence row ${ev.locator}: repository_read_decision is recorded`).not.toBeNull();
      expect(ev.repositoryReadEnforcement, `evidence row ${ev.locator}: repository_read_enforcement is recorded`).not.toBeNull();
      expect(ev.repositoryReadEnforcement!.policyVersion, `evidence row ${ev.locator}: policyVersion snapshot recorded (drift detection)`).not.toBeNull();
      expect(ev.repositoryReadEnforcement!.pathAllowed, `evidence row ${ev.locator}: path was in the candidate allowlist`).toBe(true);
    }
    // The observation→evidence linkage uses the LOCATOR (the path), not a
    // manufactured toolInvocationId. The orchestrator resolves locator→
    // evidence id by the composite (source, locator) key.
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    const withEvidence = observations.filter((o) => o.evidenceRef.length > 0);
    expect(withEvidence.length, 'some observations reference evidence').toBeGreaterThan(0);
    const evidenceIds = new Set(evidence.map((e) => e.id));
    for (const obs of withEvidence) {
      for (const ref of obs.evidenceRef) {
        expect(evidenceIds.has(ref), `evidence ref ${ref} exists`).toBe(true);
      }
    }
  });

  // =========================================================================
  // PR #42 round-3 (the governed repository-read boundary made real).
  // The architect's round-3 review: the round-2 path was a check-then-act
  // authorization window (PolicyGate.decideForProjectScope -> if allow/
  // constrained -> GitHubAdapter.getFileContent) with NOTHING atomic tying
  // the authorization decision to the actual read, and `constrained` having
  // no concrete enforcement effect. The round-3 fix introduces a DISTINCT
  // GovernedRepositoryReadPolicy boundary (src/onboarding/internal/
  // governed-repository-read-policy.ts) whose governedRead() atomically
  // captures the decision, enforces it, performs the read under the
  // captured decision, applies the `constrained` enforcement, and returns
  // the bound decision+effect+content.
  // =========================================================================

  it('30. PR #42 r3: `constrained` has a CONCRETE enforcement effect — maxOutputBytes truncates the observed content + recomputes the digest', async () => {
    // The architect's round-3 requirement: "define what `constrained` means
    // for this direct-read operation." The boundary implements maxOutputBytes:
    // the observed content is truncated to N bytes; the contentDigest is
    // recomputed on the TRUNCATED content (the digest reflects what was
    // ACTUALLY observed, not the pre-truncation content); the enforcement
    // record carries truncated=true + truncatedAtBytes=N. This is a REAL,
    // verifiable effect: a constrained read returns DIFFERENT content (and
    // a different digest) than an unconstrained read of the same path.
    const ref = 'constrained-truncation-branch';
    // A large package.json (well over the 64-byte maxOutputBytes constraint).
    const largeContent = JSON.stringify({
      name: 'constrained-truncation-repo',
      version: '9.9.9',
      description: 'a large package.json that exceeds the maxOutputBytes constraint',
      scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    });
    expect(largeContent.length, 'the test content exceeds 64 bytes').toBeGreaterThan(64);
    const constrainedPort = new InMemoryContentPort().setFile('package.json', largeContent);
    // Constrain package.json to 64 bytes max.
    const constrainedGate = new FakePolicyGate().constrainPaths(['package.json'], { maxOutputBytes: 64 });
    const constrainedAnalyzer = buildGovernedAnalyzer(constrainedPort, constrainedGate, logger);
    const constrainedService = new DefaultOnboardingService({
      projectRepository: stack.projectRepository,
      projectBaselineRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      analyzer: constrainedAnalyzer,
      logger,
    });
    const result = await constrainedService.onboard({ projectId, ref });
    expect(result.baseline.state, 'constrained baseline still completes (truncation is not a failure)').toBe('complete');
    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);
    const pkgEvidence = evidence.find((e) => e.locator === 'package.json')!;
    // The decision is 'constrained' (recorded in its OWN column).
    expect(pkgEvidence.repositoryReadDecision).toBe('constrained');
    // The enforcement effect: truncated=true, truncatedAtBytes=64, maxOutputBytes=64.
    expect(pkgEvidence.repositoryReadEnforcement!.truncated, 'the content WAS truncated').toBe(true);
    expect(pkgEvidence.repositoryReadEnforcement!.maxOutputBytes).toBe(64);
    expect(pkgEvidence.repositoryReadEnforcement!.truncatedAtBytes).toBe(64);
    expect(pkgEvidence.repositoryReadEnforcement!.performed).toBe(true);
    // The content_digest is the digest of the TRUNCATED content (64 bytes),
    // NOT the digest of the full content. Prove this by computing both and
    // asserting the evidence matches the truncated one.
    const truncatedContent = largeContent.slice(0, 64);
    const truncatedDigest = createHash('sha256').update(truncatedContent, 'utf8').digest('hex');
    const fullDigest = createHash('sha256').update(largeContent, 'utf8').digest('hex');
    expect(pkgEvidence.contentDigest, 'the digest is of the TRUNCATED content (what was actually observed)').toBe(truncatedDigest);
    expect(pkgEvidence.contentDigest, 'the digest is NOT of the full pre-truncation content').not.toBe(fullDigest);
    // The package_managers observation is ABSENT — the truncated content is
    // not valid JSON (it was cut mid-object), so JSON.parse threw and the
    // inference was skipped (the analyzer's graceful-unparseable path).
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    expect(observations.find((o) => o.kind === 'package_managers'), 'no package_managers observation (truncated content was unparseable)').toBeUndefined();
  });

  it('31. PR #42 r3: the candidate-allowlist refuses reads outside the declared set (even on an allow decision) — the boundary is structurally scoped', async () => {
    // The architect's round-3 requirement: the boundary is a DISTINCT
    // authorization boundary for /github reads, not just a policy check.
    // The path-allowlist is boundary-level enforcement: the boundary refuses
    // reads of paths outside the declared candidate set (the analyzer's
    // CANDIDATE_READS), even when the policy decision is 'allow'. This is a
    // REAL effect: the analyzer cannot read an arbitrary path through the
    // boundary, regardless of policy. (The analyzer only ever issues
    // candidate-set reads in practice — this test exercises the boundary
    // directly to prove the enforcement is structural, not coincidental.)
    const ref = 'path-allowlist-branch';
    const branch = await githubAdapter.getBranch({
      owner: 'test-org',
      repository: 'existing-repo',
      branchName: ref,
      installationId: '12345',
    });
    const port = new InMemoryContentPort()
      .setFile('package.json', JSON.stringify({ name: 'allowlist-repo' }))
      .setFile('secret.env', 'SUPER_SECRET=value'); // NOT in the candidate allowlist
    const gate = new FakePolicyGate(); // allow-all
    const boundary = new DefaultGovernedRepositoryReadPolicy({
      policyGate: gate,
      contentPort: port,
      candidateAllowlist: GOVERNED_FILESYSTEM_CANDIDATE_ALLOWLIST,
      logger,
    });
    const ctx = {
      baselineId: '00000000-0000-0000-0000-000000000000',
      projectId,
      organizationId: orgId,
      repositoryOwner: 'test-org',
      repositoryName: 'existing-repo',
      installationId: '12345',
      baselineCommitSha: branch.sha,
      revisionRef: ref,
      analysisRunId: 'allowlist-test',
      analysisMode: 'native' as const,
    };
    // A path IN the allowlist: allow + content read.
    const allowed = await boundary.governedRead(
      { path: 'package.json', family: 'filesystem', operation: 'read' }, ctx,
    );
    expect(allowed.governance.decision).toBe('allow');
    expect(allowed.governance.enforcement.pathAllowed).toBe(true);
    expect(allowed.governance.enforcement.performed).toBe(true);
    expect(allowed.content, 'the allowlisted path was read').not.toBeNull();
    // A path NOT in the allowlist: the boundary refuses (deny +
    // pathAllowed=false + performed=false), even though the policy gate
    // would 'allow' it. The read NEVER happens.
    const refused = await boundary.governedRead(
      { path: 'secret.env', family: 'filesystem', operation: 'read' }, ctx,
    );
    expect(refused.governance.decision, 'path-not-allowed -> deny (the boundary refuses)').toBe('deny');
    expect(refused.governance.enforcement.pathAllowed).toBe(false);
    expect(refused.governance.enforcement.performed, 'the read did NOT happen').toBe(false);
    expect(refused.content).toBeNull();
    expect(refused.governance.reason).toContain('not in the candidate allowlist');
    // A mutating operation: the boundary refuses (read-only structural enforcement).
    const refusedOp = await boundary.governedRead(
      { path: 'package.json', family: 'filesystem', operation: 'write' }, ctx,
    );
    expect(refusedOp.governance.decision, 'non-read operation -> deny (the boundary is read-only)').toBe('deny');
    expect(refusedOp.governance.enforcement.performed).toBe(false);
    expect(refusedOp.governance.reason).toContain("not supported");
  });

  it('32. PR #42 r3: the decision + the policy version are bound to the read (drift made OBSERVABLE) — no check-then-act window at the boundary API', async () => {
    // The architect's round-3 requirement: "prevent policy drift between
    // decision and read" + "record the actual decision/effect." The boundary
    // captures the decision (+ the policy version snapshot + the matched
    // rule id) at the START of governedRead() and IS the authorization for
    // THAT read (the read happens immediately under it, in the same method
    // — no caller-interleavable gap). The policy version is recorded on the
    // evidence row so a later auditor can verify "this content was read
    // under policy version V" — drift made OBSERVABLE, not just
    // prevented-by-construction.
    const ref = 'policy-version-branch';
    const port = new InMemoryContentPort().setFile('package.json', JSON.stringify({ name: 'drift-repo' }));
    const gate = new FakePolicyGate(); // surfaces policyVersion=1, ruleId='fake-rule', scopeSource='project'
    const analyzer = buildGovernedAnalyzer(port, gate, logger);
    const service = new DefaultOnboardingService({
      projectRepository: stack.projectRepository,
      projectBaselineRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      analyzer,
      logger,
    });
    const result = await service.onboard({ projectId, ref });
    expect(result.baseline.state).toBe('complete');
    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);
    const pkgEvidence = evidence.find((e) => e.locator === 'package.json')!;
    // The policy version snapshot IS recorded on the evidence row (drift
    // detection — a later auditor can verify which policy version
    // authorized this read).
    expect(pkgEvidence.repositoryReadEnforcement!.policyVersion, 'the policy version snapshot is recorded').toBe(1);
    expect(pkgEvidence.repositoryReadEnforcement!.ruleId, 'the matched rule id is recorded').toBe('fake-rule');
    // The decision + the version are bound in ONE outcome (the boundary
    // method returned them together — there was no separate decide() call
    // the caller could interleave a policy change between).
    expect(pkgEvidence.repositoryReadDecision).toBe('allow');
    expect(pkgEvidence.repositoryReadEnforcement!.performed).toBe(true);
  });

  // =========================================================================
  // PR #42 ROUND-4: the snapshot/fencing protocol (end-to-end through the
  // real analyzer + orchestrator + DB).
  //
  // The architect's round-4 review identified that the round-3 boundary
  // claimed atomicity but was still a check-then-act window with respect to
  // POLICY CHANGES: decideForProjectScope() (V7) and the GitHub read are two
  // separate async operations against two different authorities, and a
  // concurrent policy update CAN commit between them. The round-4 fix is an
  // explicit snapshot/fencing protocol: capture → read → REVALIDATE →
  // discard-if-stale. The invariant: "a repository-read result is persisted
  // only if the policy snapshot that authorized it is still current when the
  // result is committed."
  //
  // This test exercises the fence END-TO-END: a MutatingPolicyGate (starts
  // at V7/allow) + a HookedContentPort (mutates the gate to V8/deny on the
  // FIRST read, which is package.json). The first read (package.json)
  // captures V7, the read triggers the mutation to V8, the revalidation
  // sees V8 → STALE → the package.json evidence row + the package-derived
  // observations are NOT persisted. The subsequent reads (README.md, CI,
  // Dockerfile, etc.) capture + revalidate V8 (no further mutation) → not
  // stale → their evidence IS persisted. The baseline still completes.
  // =========================================================================

  it('33. PR #42 r4: the snapshot/fencing protocol — a mid-read policy mutation (v7 capture -> v8 revalidation) -> the stale read result is DISCARDED (zero evidence + zero observation for that path); the baseline still completes with the other reads', async () => {
    // The architect's round-4 regression spec:
    //   initial version = 7
    //     ↓
    //   governedRead captures v7
    //     ↓
    //   test hook mutates policy to v8 while read is in flight
    //     ↓
    //   read completes
    //     ↓
    //   governedRead rejects the stale result
    //     ↓
    //   zero baseline evidence/observation is persisted (for THAT path)
    const ref = 'fencing-branch';
    // The hooked content port: the FIRST read (package.json — the first
    // candidate) triggers the mutation to V8. Subsequent reads do NOT fire
    // the hook (they capture + revalidate V8 — not stale).
    const gate = new MutatingPolicyGate(); // starts at V7/allow/rule-v7
    const port = new HookedContentPort(() => gate.mutateToV8())
      .setFile('package.json', JSON.stringify({ name: 'fenced-repo', version: '1.0.0' }))
      .setFile('README.md', '# Fenced Repo')
      .setDir('.github/workflows', [{ name: 'ci.yml', type: 'file' }])
      .setFile('Dockerfile', 'FROM node:20');
    const analyzer = buildGovernedAnalyzer(port, gate, logger);
    const service = new DefaultOnboardingService({
      projectRepository: stack.projectRepository,
      projectBaselineRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      analyzer,
      logger,
    });
    const result = await service.onboard({ projectId, ref });
    expect(gate.wasMutated(), 'the gate was mutated mid-read').toBe(true);

    // The baseline STILL COMPLETES — a stale read is NOT an infrastructure
    // failure (the read happened, the result was discarded by the fence, the
    // baseline continues with the other reads' evidence).
    expect(result.baseline.state, 'the baseline completes (stale is not a failure)').toBe('complete');

    const evidence = await projectBaselineRepository.listEvidence(result.baseline.id);

    // CRITICAL: the package.json evidence row is ABSENT — the stale read
    // result was DISCARDED by the fence (zero evidence for that path). The
    // architect's invariant: "a repository-read result is persisted only if
    // the policy snapshot that authorized it is still current when the
    // result is committed." package.json was authorized under V7 but V8
    // superseded it before the result could be committed → DISCARDED.
    expect(
      evidence.find((e) => e.locator === 'package.json'),
      'package.json evidence is ABSENT (the stale read was discarded by the fence)',
    ).toBeUndefined();

    // The OTHER reads (README.md, .github/workflows, Dockerfile, etc.)
    // captured + revalidated V8 (the mutated state — no further mutation)
    // → not stale → their evidence IS persisted. The boundary called
    // decideForProjectScope TWICE per read (capture + revalidation).
    const readmeEvidence = evidence.find((e) => e.locator === 'README.md');
    expect(readmeEvidence, 'README.md evidence IS persisted (not stale)').toBeDefined();
    expect(readmeEvidence!.repositoryReadDecision).toBe('allow');
    // The fence metadata on the persisted (non-stale) rows:
    expect(readmeEvidence!.repositoryReadEnforcement!.stale, 'not stale').toBe(false);
    expect(readmeEvidence!.repositoryReadEnforcement!.revalidated, 'the fence ran').toBe(true);
    expect(readmeEvidence!.repositoryReadEnforcement!.performed).toBe(true);
    // The snapshot version (V8 — captured after the mutation) and the
    // revalidation version (V8 — no further mutation) match.
    expect(readmeEvidence!.repositoryReadEnforcement!.policyVersion).toBe(8);
    expect(readmeEvidence!.repositoryReadEnforcement!.ruleId).toBe('fake-rule-v8');
    expect(readmeEvidence!.repositoryReadEnforcement!.revalidatedPolicyVersion).toBe(8);
    expect(readmeEvidence!.repositoryReadEnforcement!.revalidatedRuleId).toBe('fake-rule-v8');

    const ciEvidence = evidence.find((e) => e.locator === '.github/workflows');
    expect(ciEvidence, '.github/workflows evidence IS persisted').toBeDefined();
    expect(ciEvidence!.repositoryReadEnforcement!.stale).toBe(false);
    expect(ciEvidence!.repositoryReadEnforcement!.revalidated).toBe(true);

    const dockerfileEvidence = evidence.find((e) => e.locator === 'Dockerfile');
    expect(dockerfileEvidence, 'Dockerfile evidence IS persisted').toBeDefined();
    expect(dockerfileEvidence!.repositoryReadEnforcement!.stale).toBe(false);

    // The observations derived from package.json content are ABSENT — the
    // stale read's content was discarded, so the analyzer never had
    // package.json content to derive from. The package_managers /
    // build_commands / frameworks / languages observations are NOT produced.
    const observations = await projectBaselineRepository.listObservations(result.baseline.id);
    expect(
      observations.find((o) => o.kind === 'package_managers'),
      'package_managers observation is ABSENT (package.json content was discarded)',
    ).toBeUndefined();
    expect(
      observations.find((o) => o.kind === 'build_commands'),
      'build_commands observation is ABSENT',
    ).toBeUndefined();
    expect(
      observations.find((o) => o.kind === 'frameworks'),
      'frameworks observation is ABSENT (inference had no package.json to reason from)',
    ).toBeUndefined();
    expect(
      observations.find((o) => o.kind === 'languages'),
      'languages observation is ABSENT',
    ).toBeUndefined();

    // The observations NOT derived from package.json ARE present:
    // repository_identity (metadata-observed), ci (from .github/workflows),
    // deployment (from Dockerfile), architecture (proposed).
    expect(
      observations.find((o) => o.kind === 'repository_identity'),
      'repository_identity observation IS present (metadata-observed, not content-read)',
    ).toBeDefined();
    expect(
      observations.find((o) => o.kind === 'ci'),
      'ci observation IS present (.github/workflows read succeeded under V8)',
    ).toBeDefined();
    expect(
      observations.find((o) => o.kind === 'deployment'),
      'deployment observation IS present (Dockerfile read succeeded under V8)',
    ).toBeDefined();
    expect(
      observations.find((o) => o.kind === 'architecture'),
      'architecture observation IS present (proposed, no evidence dependency)',
    ).toBeDefined();

    // The fence log was emitted (forensic audit of the discarded read).
    const logOutput = capture.raw();
    expect(logOutput, 'the fence logged the stale snapshot').toContain('policy-snapshot-stale');
    expect(logOutput, 'the log records the snapshot version V7').toContain('"snapshotVersion":7');
    expect(logOutput, 'the log records the revalidation version V8').toContain('"revalidatedVersion":8');
  });
});
