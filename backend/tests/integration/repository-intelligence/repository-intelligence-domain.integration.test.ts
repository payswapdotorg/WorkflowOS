/**
 * WORK-039: Repository and Context Intelligence — integration coverage.
 *
 * Covers the 16 frozen WORK-039 test requirements (deterministic context
 * identity; idempotent indexing; distinct revisions; revision identity
 * retained; provenance survives; redacted stays redacted; tenant isolation;
 * stale detection; concurrent convergence; crash/retry no duplication;
 * architecture/requirements remain references; ranking never promotes
 * provenance; Tool Runtime policy respected; no fabricated tool evidence;
 * explainable reason; no workflow/execution/verification/review authority
 * duplicated).
 *
 * The test wires the REAL repository-intelligence orchestrator
 * (DefaultRepositoryIntelligenceService) + the REAL deterministic ranker
 * (DeterministicContextRanker) + the REAL baseline-context source
 * (BaselineContextSource) + the REAL /projects context-index storage
 * (PgProjectContextIndexRepository) on top of a real PostgreSQL test database
 * (pglite locally / real pg in CI). The baseline is produced by the REAL
 * WORK-038 onboarding pipeline (DefaultOnboardingService + the governed
 * analyzer + the FakeGitHubAdapter's deterministic file tree).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { PgProjectBaselineRepository } from '../../../src/modules/projects/internal/pg-project-baseline-repository.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import { PgProjectContextIndexRepository } from '../../../src/modules/projects/internal/pg-project-context-index-repository.js';
import { DefaultOnboardingService } from '../../../src/onboarding/internal/default-onboarding-service.js';
import { GovernedFilesystemAnalyzer, GOVERNED_FILESYSTEM_CANDIDATE_ALLOWLIST } from '../../../src/onboarding/internal/governed-filesystem-analyzer.js';
import { DefaultGovernedRepositoryReadPolicy } from '../../../src/onboarding/internal/governed-repository-read-policy.js';
import { DefaultRepositoryIntelligenceService } from '../../../src/repository-intelligence/internal/default-repository-intelligence-service.js';
import { DeterministicContextRanker } from '../../../src/repository-intelligence/internal/deterministic-context-ranker.js';
import { BaselineContextSource } from '../../../src/repository-intelligence/internal/baseline-context-source.js';
import { RepositoryIntelligenceError } from '@modules/projects/index.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import type { RepositoryContentPort, ProjectScopedPolicyGate } from '@onboarding/index.js';
import type { ContextResolutionContext, ContextIndexQuery, ContextQueryTerms, GovernedHostInspector, HostInspectionResult, ContextItemKind } from '@repository-intelligence/index.js';
import type { ToolPolicyRequest } from '@modules/agents/index.js';

function hashOf(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** A configurable in-memory repository content provider (mirrors WORK-038). */
class InMemoryContentPort implements RepositoryContentPort {
  private files = new Map<string, string>();
  private dirs = new Map<string, { name: string; type: 'file' | 'dir' }[]>();
  setFile(path: string, content: string): this { this.files.set(path, content); return this; }
  setDir(path: string, entries: { name: string; type: 'file' | 'dir' }[]): this { this.dirs.set(path, entries); return this; }
  async readFile(_o: string, _r: string, _s: string, path: string, _i: string) {
    const content = this.files.get(path);
    if (content === undefined) return null;
    return { content, contentDigest: hashOf(content) };
  }
  async listDir(_o: string, _r: string, _s: string, path: string, _i: string) {
    return this.dirs.get(path) ?? [];
  }
}

/** A configurable project-scoped policy gate (defaults to allow). */
class FakePolicyGate implements ProjectScopedPolicyGate {
  async decideForProjectScope(_req: ToolPolicyRequest, _projectId: string, _orgId: string) {
    // Mirrors the WORK-038 onboarding test fake: scopeSource='platform-default'
    // (the fake gate does NOT back its claim with a real wfos_agent_policies
    // row — the honest source is 'platform-default'; the round-7 fence then
    // skips the row lock since there's nothing to lock). A real
    // AgentPolicyEngine surfaces these from evaluateCore against the DB.
    return { decision: 'allow' as const, reason: 'test-allow', policyVersion: 1, ruleId: 'test-allow', scopeSource: 'platform-default' as const };
  }
}

/** A fake governed host inspector that returns HONEST toolInvocationIds + observations. */
class FakeHostInspector implements GovernedHostInspector {
  constructor(
    readonly observations: { toolInvocationId: string; kind: ContextItemKind; locator: string; matchText: string }[],
  ) {}
  async inspect(): Promise<HostInspectionResult> {
    return {
      observations: this.observations.map((o) => ({ ...o, contentDigest: null, redacted: false })),
      toolInvocationIds: this.observations.map((o) => o.toolInvocationId),
    };
  }
}

describe('WORK-039 — Repository and Context Intelligence (context index + repository-intelligence capability)', () => {
  let stack: TestAuthStack;
  let githubAdapter: FakeGitHubAdapter;
  let contentPort: InMemoryContentPort;
  let policyGate: FakePolicyGate;
  let projectBaselineRepository: PgProjectBaselineRepository;
  let projectGitHubRepositoryRepository: PgProjectGitHubRepositoryRepository;
  let projectContextIndexRepository: PgProjectContextIndexRepository;
  let onboardingService: DefaultOnboardingService;
  let riService: DefaultRepositoryIntelligenceService;
  let capture: CaptureStream;
  let logger: ReturnType<typeof createLogger>;

  let orgId: string;
  let projectId: string;
  let userId: string;
  let repoLinkRowId: string;
  let baselineId: string;
  let baselineCommitSha: string;

  beforeEach(async () => {
    stack = await buildAuthStack();
    capture = new CaptureStream();
    logger = createLogger({ level: 'warn', destination: capture });
    githubAdapter = new FakeGitHubAdapter();
    contentPort = new InMemoryContentPort();
    policyGate = new FakePolicyGate();
    projectBaselineRepository = new PgProjectBaselineRepository(stack.db.client);
    projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(stack.db.client);
    projectContextIndexRepository = new PgProjectContextIndexRepository(stack.db.client);

    const governedReadPolicy = new DefaultGovernedRepositoryReadPolicy({
      policyGate,
      contentPort,
      candidateAllowlist: GOVERNED_FILESYSTEM_CANDIDATE_ALLOWLIST,
      logger,
    });
    const analyzer = new GovernedFilesystemAnalyzer({ governedReadPolicy, logger });
    onboardingService = new DefaultOnboardingService({
      projectRepository: stack.projectRepository,
      projectBaselineRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      analyzer,
      governedReadPolicy,
      logger,
    });

    // Repository-intelligence service.
    const source = new BaselineContextSource(logger);
    const ranker = new DeterministicContextRanker();
    riService = new DefaultRepositoryIntelligenceService({ ranker, source, logger });

    const org = await stack.organizationRepository.create({ name: 'Test Org' });
    orgId = org.id;
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'test-user', email: 'owner@test.example', displayName: 'Owner' });
    userId = user.id;
    await stack.membershipRepository.assign({ organizationId: orgId, userId, roleId: 'owner' });
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'RI Project' });
    projectId = project.id;
    await stack.projectAccessRepository.grant({ userId, projectId, roleId: 'owner' });

    await stack.db.client.exec(`INSERT INTO wfos_github_installations (project_id, installation_id, account_login, metadata) VALUES ('${projectId}', '12345', 'test-org', '{}')`);
    const repoLink = await projectGitHubRepositoryRepository.create({ projectId, installationId: '12345', owner: 'test-org', repository: 'ri-repo', defaultBranch: 'main', linkType: 'linked' });
    repoLinkRowId = repoLink.id;

    contentPort
      .setFile('package.json', JSON.stringify({ name: 'ri-repo', version: '1.0.0', scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' }, dependencies: { next: '^14.0.0' } }))
      .setFile('README.md', '# RI Repo\nA test repository.')
      .setDir('.github/workflows', [{ name: 'ci.yml', type: 'file' }])
      .setFile('Dockerfile', 'FROM node:20\nWORKDIR /app\nCOPY . .');

    // Produce a complete baseline via the WORK-038 onboarding pipeline.
    const result = await onboardingService.onboard({ projectId });
    baselineId = result.baseline.id;
    baselineCommitSha = result.baseline.baselineCommitSha;
  });

  afterEach(async () => { await stack.teardown(); });

  function buildCtx(): ContextResolutionContext {
    return {
      organizationId: orgId,
      projectGithubRepositoryId: repoLinkRowId,
      baselineCommitSha,
      repositoryOwner: 'test-org',
      repositoryName: 'ri-repo',
      installationId: '12345',
      projectBaselineRepository,
      projectContextIndexRepository,
      projectGitHubRepositoryRepository,
      githubAdapter,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      requirementRepository: stack.requirementRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      workItemRepository: stack.workItemRepository,
      workItemRequirementRepository: stack.workItemRequirementRepository,
      workItemCriterionRepository: stack.workItemCriterionRepository,
    };
  }

  function buildQuery(terms: Partial<ContextQueryTerms> = {}): ContextIndexQuery {
    return {
      projectId,
      baselineId,
      kind: 'work_item',
      queryRef: 'wi-test-1',
      queryTerms: {
        workItemTerms: terms.workItemTerms ?? ['ri-repo', 'package'],
        architectureRefs: terms.architectureRefs,
        requirementRefs: terms.requirementRefs,
        testPatterns: terms.testPatterns ?? ['test'],
        dependencyRefs: terms.dependencyRefs,
        freeformTerms: terms.freeformTerms,
      } as ContextQueryTerms,
    };
  }

  it('1. same baseline revision produces deterministic context identity', async () => {
    const query = buildQuery();
    const ctx = buildCtx();
    const r1 = await riService.buildIndex(query, ctx);
    const r2 = await riService.buildIndex(query, ctx);
    expect(r1.kind).toBe('complete');
    expect(r2.kind).toBe('complete');
    expect(r1.index.id).toBe(r2.index.id);
    expect(r1.index.contentDigest).toBe(r2.index.contentDigest);
    expect(r1.index.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('2. same indexing request is idempotent (no duplicate items)', async () => {
    const query = buildQuery();
    const ctx = buildCtx();
    const r1 = await riService.buildIndex(query, ctx);
    expect(r1.kind).toBe('complete');
    const items1 = await projectContextIndexRepository.listItems(r1.index.id);
    const r2 = await riService.buildIndex(query, ctx);
    expect(r2.kind).toBe('complete');
    const items2 = await projectContextIndexRepository.listItems(r2.index.id);
    expect(r1.index.id).toBe(r2.index.id);
    expect(items1.length).toBeGreaterThan(0);
    expect(items2.length).toBe(items1.length);
    const locators = items2.map((i) => `${i.source}|${i.kind}|${i.locator}`);
    expect(new Set(locators).size).toBe(locators.length);
  });

  it('3. different revisions remain distinct', async () => {
    contentPort.setFile('package.json', JSON.stringify({ name: 'ri-repo', version: '2.0.0' }));
    (githubAdapter as unknown as { advanceSha: () => void }).advanceSha?.();
    const r2 = await onboardingService.onboard({ projectId });
    expect(r2.baseline.baselineCommitSha).not.toBe(baselineCommitSha);
    const q1 = { ...buildQuery(), baselineId };
    const q2 = { ...buildQuery(), baselineId: r2.baseline.id };
    const ctx1 = { ...buildCtx(), baselineId, baselineCommitSha };
    const ctx2 = { ...buildCtx(), baselineId: r2.baseline.id, baselineCommitSha: r2.baseline.baselineCommitSha };
    const i1 = await riService.buildIndex(q1, ctx1);
    const i2 = await riService.buildIndex(q2, ctx2);
    expect(i1.kind).toBe('complete');
    expect(i2.kind).toBe('complete');
    expect(i1.index.baselineCommitSha).not.toBe(i2.index.baselineCommitSha);
    expect(i1.index.contentDigest).not.toBe(i2.index.contentDigest);
    expect(i1.index.id).not.toBe(i2.index.id);
  });

  it('4. context retains baseline/repository/revision identity', async () => {
    const query = buildQuery();
    const ctx = buildCtx();
    const r = await riService.buildIndex(query, ctx);
    expect(r.kind).toBe('complete');
    expect(r.index.baselineId).toBe(baselineId);
    expect(r.index.baselineCommitSha).toBe(baselineCommitSha);
    expect(r.index.projectId).toBe(projectId);
    expect(r.index.organizationId).toBe(orgId);
    const items = await projectContextIndexRepository.listItems(r.index.id);
    for (const item of items) {
      expect(item.baselineId).toBe(baselineId);
      expect(item.projectId).toBe(projectId);
      expect(item.organizationId).toBe(orgId);
    }
  });

  it('5. provenance survives indexing/retrieval', async () => {
    const query = buildQuery();
    const ctx = buildCtx();
    const r = await riService.buildIndex(query, ctx);
    expect(r.kind).toBe('complete');
    const items = await projectContextIndexRepository.listItems(r.index.id);
    const obsItems = items.filter((i) => i.source === 'baseline_observation');
    expect(obsItems.length).toBeGreaterThan(0);
    for (const item of obsItems) {
      expect(['observed', 'inferred', 'confirmed', 'proposed']).toContain(item.provenance);
    }
    const provenances = new Set(obsItems.map((i) => i.provenance));
    expect(provenances.has('observed')).toBe(true);
  });

  it('6. redacted content stays redacted (no reversal)', async () => {
    const ev = await stack.db.client.query<{ id: string }>(
      `INSERT INTO wfos_project_baseline_evidence (baseline_id, source, locator, content_digest, redacted)
       VALUES ($1, 'config', 'secrets.env', 'redacted-digest', true) RETURNING id`,
      [baselineId],
    );
    const evidenceId = ev.rows[0]!.id;
    const query = buildQuery({ freeformTerms: ['secrets'] });
    const ctx = buildCtx();
    const r = await riService.buildIndex(query, ctx);
    expect(r.kind).toBe('complete');
    const items = await projectContextIndexRepository.listItems(r.index.id);
    const secretItem = items.find((i) => i.locator === 'secrets.env');
    expect(secretItem, 'the redacted evidence produced a context item').toBeDefined();
    expect(secretItem!.redacted).toBe(true);
    expect(secretItem!.evidenceRef).toContain(evidenceId);
  });

  it('7. tenant isolation works (cross-project retrieve → not found)', async () => {
    const org2 = await stack.organizationRepository.create({ name: 'Other Org' });
    const project2 = await stack.projectRepository.create({ organizationId: org2.id, name: 'Other Project' });
    const query = buildQuery();
    const r = await riService.buildIndex(query, buildCtx());
    expect(r.kind).toBe('complete');
    const crossIndex = await projectContextIndexRepository.findByQuery(project2.id, query.kind, query.queryRef);
    expect(crossIndex).toBeNull();
    const byId = await projectContextIndexRepository.findById(r.index.id);
    expect(byId!.projectId).toBe(projectId);
  });

  it('8. stale context is detectable + never silently presented as current', async () => {
    const query = buildQuery();
    const r = await riService.buildIndex(query, buildCtx());
    expect(r.kind).toBe('complete');
    const report1 = await riService.detectStale(query, buildCtx());
    expect(report1.stale).toBe(false);
    expect(report1.baselineCommitSha).toBe(baselineCommitSha);
    expect(report1.currentHeadSha).toBe(baselineCommitSha);
    (githubAdapter as unknown as { advanceSha: () => void }).advanceSha?.();
    const report2 = await riService.detectStale(query, buildCtx());
    expect(report2.stale).toBe(true);
    expect(report2.baselineCommitSha).toBe(baselineCommitSha);
    expect(report2.currentHeadSha).not.toBe(baselineCommitSha);
    const sel = await riService.retrieve(query, buildCtx());
    expect(sel.index.baselineCommitSha).toBe(baselineCommitSha);
  });

  it('9. concurrent indexing converges safely (no duplicate items)', async () => {
    const query = buildQuery();
    const ctx = buildCtx();
    const [r1, r2] = await Promise.all([
      riService.buildIndex(query, ctx),
      riService.buildIndex(query, ctx),
    ]);
    const kinds = [r1.kind, r2.kind].sort();
    expect(kinds).toContain('complete');
    const id1 = (r1 as { index: { id: string } }).index.id;
    const id2 = (r2 as { index: { id: string } }).index.id;
    expect(id1).toBe(id2);
    const items = await projectContextIndexRepository.listItems(id1);
    const locators = items.map((i) => `${i.source}|${i.kind}|${i.locator}`);
    expect(new Set(locators).size).toBe(locators.length);
  });

  it('10. crash/retry does not duplicate context', async () => {
    const stale = await projectContextIndexRepository.ensureIndex({
      projectId, organizationId: orgId, projectGithubRepositoryId: repoLinkRowId,
      baselineId, baselineCommitSha, queryKind: 'work_item', queryRef: 'wi-crash',
      queryTermsJson: {}, indexingRunId: 'crashed-run', toolInvocationIds: [],
    });
    expect(stale.kind).toBe('created');
    expect(stale.index.state).toBe('indexing');
    const reclaimed = await projectContextIndexRepository.reclaimStaleIndexing(stale.index.id, 'new-run', stale.index.version);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.indexingRunId).toBe('new-run');
    const query: ContextIndexQuery = { projectId, baselineId, kind: 'work_item', queryRef: 'wi-crash-recovered', queryTerms: { workItemTerms: ['package'] } as ContextQueryTerms };
    const ctx = buildCtx();
    const r = await riService.buildIndex(query, ctx);
    expect(r.kind).toBe('complete');
    const items = await projectContextIndexRepository.listItems(r.index.id);
    expect(items.length).toBeGreaterThan(0);
    const locators = items.map((i) => `${i.source}|${i.kind}|${i.locator}`);
    expect(new Set(locators).size).toBe(locators.length);
  });

  it('11. architecture/requirements relationships remain references (not duplicated)', async () => {
    const query = buildQuery();
    const ctx = buildCtx();
    const r = await riService.buildIndex(query, ctx);
    expect(r.kind).toBe('complete');
    const items = await projectContextIndexRepository.listItems(r.index.id);
    const archItems = items.filter((i) => i.source === 'architecture');
    for (const a of archItems) {
      expect(a.authorityRef.architectureVersionId).toBeDefined();
    }
    expect(archItems.every((a) => typeof a.authorityRef.architectureVersionId === 'string')).toBe(true);
  });

  it('12. ranking never promotes provenance', async () => {
    const query = buildQuery({ workItemTerms: ['package', 'ri-repo'] });
    const ctx = buildCtx();
    const r = await riService.buildIndex(query, ctx);
    expect(r.kind).toBe('complete');
    const items = await projectContextIndexRepository.listItems(r.index.id);
    const obsItems = items.filter((i) => i.source === 'baseline_observation');
    const highObs = obsItems.filter((i) => i.provenance === 'observed' && i.relevanceScore > 0);
    expect(highObs.length).toBeGreaterThan(0);
    for (const h of highObs) {
      expect(h.provenance).toBe('observed');
    }
    const confirmed = items.filter((i) => i.provenance === 'confirmed');
    expect(confirmed.length).toBe(0);
  });

  it('13 + 14. Tool Runtime policy respected + no fabricated tool evidence', async () => {
    const query = buildQuery();
    const ctx = buildCtx();
    const r1 = await riService.buildIndex(query, ctx);
    expect(r1.kind).toBe('complete');
    expect(r1.index.toolInvocationIds).toEqual([]);
    const fakeInspector = new FakeHostInspector([
      { toolInvocationId: 'real-inv-1', kind: 'file' as ContextItemKind, locator: 'src/index.ts', matchText: 'src index' },
    ]);
    const riWithInspector = new DefaultRepositoryIntelligenceService({
      ranker: new DeterministicContextRanker(),
      source: new BaselineContextSource(logger),
      hostInspector: fakeInspector,
      logger,
    });
    const q2: ContextIndexQuery = { ...query, queryRef: 'wi-host-inspection' };
    const r2 = await riWithInspector.buildIndex(q2, ctx);
    expect(r2.kind).toBe('complete');
    expect(r2.index.toolInvocationIds).toEqual(['real-inv-1']);
  });

  it('15. context selection provides an explainable reason', async () => {
    const query = buildQuery({ workItemTerms: ['package', 'ri-repo'] });
    const r = await riService.buildIndex(query, buildCtx());
    expect(r.kind).toBe('complete');
    const items = await projectContextIndexRepository.listItems(r.index.id);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.relevanceReason.length).toBeGreaterThan(0);
    }
    const reasonMentions = items.some((i) =>
      /term_overlap|architecture_ref|requirement_ref|work_item_ref|dependency_ref|baseline_observation|test_relationship|repository_structure/.test(i.relevanceReason),
    );
    expect(reasonMentions).toBe(true);
  });

  it('16. no workflow/execution/verification/review authority is duplicated', async () => {
    const query = buildQuery();
    const r = await riService.buildIndex(query, buildCtx());
    expect(r.kind).toBe('complete');
    const idx = r.index;
    expect((idx as unknown as Record<string, unknown>).workflowState).toBeUndefined();
    expect((idx as unknown as Record<string, unknown>).executionId).toBeUndefined();
    expect((idx as unknown as Record<string, unknown>).verificationRunId).toBeUndefined();
    expect((idx as unknown as Record<string, unknown>).reviewId).toBeUndefined();
  });

  it('rejects indexing a non-complete baseline (the evidence backbone must be complete)', async () => {
    const analyzing = await stack.db.client.query<{ id: string }>(
      `INSERT INTO wfos_project_baselines (project_id, organization_id, project_github_repository_id, repository_owner, repository_name, baseline_commit_sha, revision_ref, state, analysis_mode)
       VALUES ($1, $2, $3, 'test-org', 'ri-repo', 'analyzingsha', 'main', 'analyzing', 'native') RETURNING id`,
      [projectId, orgId, repoLinkRowId],
    );
    const query: ContextIndexQuery = { projectId, baselineId: analyzing.rows[0]!.id, kind: 'work_item', queryRef: 'wi-x', queryTerms: {} as ContextQueryTerms };
    await expect(riService.buildIndex(query, buildCtx())).rejects.toThrow(RepositoryIntelligenceError);
  });

  it('retrieve builds when missing + returns the selection', async () => {
    const query = buildQuery();
    const sel = await riService.retrieve(query, buildCtx());
    expect(sel.items.length).toBeGreaterThan(0);
    expect(sel.freshlyBuilt).toBe(true);
    const sel2 = await riService.retrieve(query, buildCtx());
    expect(sel2.freshlyBuilt).toBe(false);
    expect(sel2.index.id).toBe(sel.index.id);
  });
});
