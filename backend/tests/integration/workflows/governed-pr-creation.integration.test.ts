import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { generateExecutionId } from '@platform/ids.js';

import {
  GithubBackedPullRequestCreationPort,
  governedHeadBranch,
} from '../../../src/modules/workflows/internal/github-pr-creation-port.js';
import {
  GovernedPullRequestService,
} from '../../../src/modules/workflows/internal/governed-pull-request-service.js';
import type {
  CreatedPullRequest,
  PullRequestCreationPort,
  ResolvedExternalPullRequest,
} from '../../../src/modules/workflows/internal/convergence.types.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { DefaultGitHubAdapter } from '../../../src/modules/github/internal/pg-github-repository.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import {
  ScriptedGitHubApi,
  generateRsaKeyPairPem,
} from '../../helpers/scripted-github-api.js';

/**
 * WORK-051 round 2 (PR #52 review, BLOCKER 2) — the durable, crash-safe,
 * idempotent governed PR creation, proven across the EXTERNAL side effect.
 *
 * The governed path is: checkpoint → createPullRequest (EXTERNAL GitHub
 * mutation) → record → PR_OPEN. The external mutation is outside the
 * database transaction, so the essential interleavings are:
 *
 *   create succeeded → process dies → retry → SAME PR converged → NO second PR
 *   create not yet reached → process dies → retry → exactly one create
 *   two concurrent duplicate drives → exactly one create, same PR
 *   a completed key re-driven → ZERO external calls (pure convergence)
 *   a NEW implementation revision → a genuinely NEW PR (the key semantics)
 *
 * All regressions run against the PRODUCTION boundary composition — the real
 * GithubBackedPullRequestCreationPort over the FakeGitHubAdapter (whose
 * one-open-PR-per-head semantics mirror GitHub's HTTP 422) and the real
 * GovernedPullRequestService on real PostgreSQL — with PROVIDER-SIDE
 * OPERATION COUNTING (the fake counts every create + every convergence read).
 */
describe('WORK-051 round 2 — the governed PR creation is crash-safe + idempotent across the external side effect', () => {
  let stack: TestAuthStack;
  let fakeGithub: FakeGitHubAdapter;
  let linkRepo: PgProjectGitHubRepositoryRepository;
  let project: { id: string };
  let orgId: string;
  const OWNER = 'governed-org';
  const REPO = 'governed-repo';

  /**
   * A crash-injecting wrapper around the PRODUCTION port: the inner port
   * performs the real delegation; the wrapper kills the caller at the
   * requested point (before the external create, or after it — before the
   * durable record can be written). Simulates process death mid-protocol.
   */
  class CrashingPullRequestPort implements PullRequestCreationPort {
    constructor(
      private readonly inner: PullRequestCreationPort,
      private readonly mode: 'crash-before-create' | 'crash-after-create',
    ) {}

    async findExistingPullRequest(input: {
      projectId: string;
      workItemId: string;
      headRevision: string;
    }): Promise<CreatedPullRequest | null> {
      return this.inner.findExistingPullRequest(input);
    }

    async resolveExternalPullRequest(input: {
      projectId: string;
      externalPrRef: string;
    }): Promise<ResolvedExternalPullRequest | null> {
      return this.inner.resolveExternalPullRequest(input);
    }

    async createPullRequest(input: {
      projectId: string;
      workItemId: string;
      headRevision: string;
      title: string;
      body?: string | null;
    }): Promise<CreatedPullRequest> {
      if (this.mode === 'crash-before-create') {
        // Process died BEFORE the external side effect — nothing reached GitHub.
        throw new Error('simulated crash BEFORE the external PR create');
      }
      // The EXTERNAL side effect has happened (GitHub holds the PR)…
      await this.inner.createPullRequest(input);
      // …and the process dies BEFORE the durable record is written.
      throw new Error('simulated crash AFTER the external PR create (before the durable record)');
    }
  }

  const productionPort = (): GithubBackedPullRequestCreationPort =>
    new GithubBackedPullRequestCreationPort(linkRepo, fakeGithub);

  const service = (client: TestAuthStack['db']['client'] = stack.db.client): GovernedPullRequestService =>
    new GovernedPullRequestService(client, productionPort());

  const input = (workItemId: string, headRevision: string) => ({
    projectId: project.id,
    workItemId,
    headRevision,
    title: `Work item ${workItemId}`,
    body: 'governed regression',
  });

  beforeAll(async () => {
    stack = await buildAuthStack({});
    fakeGithub = new FakeGitHubAdapter();
    linkRepo = new PgProjectGitHubRepositoryRepository(stack.db.client);
    const org = await stack.organizationRepository.create({ name: 'Governed Org' });
    orgId = org.id;
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'governed-user', displayName: 'User' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Governed Project' });
    await linkRepo.create({
      projectId: project.id,
      installationId: 'inst-governed',
      owner: OWNER,
      repository: REPO,
      defaultBranch: 'main',
    });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  it('BLOCKER 2 (crash AFTER the external create) — the retry CONVERGES on the already-created PR: exactly one create, same PR, durable record', async () => {
    const wiId = `WI-${generateExecutionId()}`;
    const rev = `rev-${generateExecutionId()}`;
    const keyInput = input(wiId, rev);

    // First attempt: the external create SUCCEEDS, then the process "dies"
    // before the durable record (the whole transaction rolls back).
    const crashed = new GovernedPullRequestService(
      stack.db.client,
      new CrashingPullRequestPort(productionPort(), 'crash-after-create'),
    );
    await expect(crashed.open(keyInput)).rejects.toThrow('simulated crash AFTER');

    // The durable record rolled back — no intent row survived the crash…
    expect(await crashed.findIntent(wiId, rev)).toBeNull();
    // …but the EXTERNAL side effect DID happen: the provider created the PR.
    expect(fakeGithub.createPullRequestCalls).toHaveLength(1);
    expect(fakeGithub.createPullRequestCalls[0]).toBe(governedHeadBranch(wiId, rev));

    // The RETRY (a fresh process over the same durable state + the same
    // external authority): it must CONVERGE, never create a second PR.
    const retry = service();
    const converged = await retry.open(keyInput);
    expect(converged.externalPrId).toBe(`github:${OWNER}/${REPO}#1`);
    // EXACTLY ONE create in total across crash + retry — no second PR.
    expect(fakeGithub.createPullRequestCalls).toHaveLength(1);
    // The convergence READ is what found the crashed attempt's PR.
    expect(fakeGithub.findPullRequestByHeadCalls.length).toBeGreaterThanOrEqual(1);
    // The intent is now durably 'created' with the converged identity.
    const intent = await retry.findIntent(wiId, rev);
    expect(intent).toEqual({
      status: 'created',
      externalPrId: `github:${OWNER}/${REPO}#1`,
      headCommit: converged.headCommit,
    });

    // A THIRD drive of the same key: PURE convergence — zero external calls.
    const createsBefore = fakeGithub.createPullRequestCalls.length;
    const findsBefore = fakeGithub.findPullRequestByHeadCalls.length;
    const again = await retry.open(keyInput);
    expect(again.externalPrId).toBe(converged.externalPrId);
    expect(fakeGithub.createPullRequestCalls).toHaveLength(createsBefore);
    expect(fakeGithub.findPullRequestByHeadCalls).toHaveLength(findsBefore);
  });

  it('BLOCKER 2 (crash BEFORE the external create) — the retry creates exactly once (nothing reached GitHub from the crashed attempt)', async () => {
    const wiId = `WI-${generateExecutionId()}`;
    const rev = `rev-${generateExecutionId()}`;
    const keyInput = input(wiId, rev);

    const crashed = new GovernedPullRequestService(
      stack.db.client,
      new CrashingPullRequestPort(productionPort(), 'crash-before-create'),
    );
    await expect(crashed.open(keyInput)).rejects.toThrow('simulated crash BEFORE');

    // Nothing reached GitHub from the crashed attempt.
    const createsDuringCrash = fakeGithub.createPullRequestCalls.length;

    // The retry: no existing PR to converge on → create → record.
    const retry = service();
    const created = await retry.open(keyInput);
    expect(created.externalPrId).toMatch(new RegExp(`^github:${OWNER}/${REPO}#\\d+$`));
    // EXACTLY ONE create for this key (the crashed attempt created nothing).
    expect(fakeGithub.createPullRequestCalls).toHaveLength(createsDuringCrash + 1);
    expect(fakeGithub.createPullRequestCalls.at(-1)).toBe(governedHeadBranch(wiId, rev));
    const intent = await retry.findIntent(wiId, rev);
    expect(intent?.status).toBe('created');
    expect(intent?.externalPrId).toBe(created.externalPrId);
  });

  it('BLOCKER 2 (concurrent duplicate drives, real PostgreSQL) — two independent clients converge on ONE PR with exactly one create', async () => {
    const isRealPg =
      !!process.env.WORKFLOWOS_DATABASE_URL &&
      process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');
    if (!isRealPg || !stack.db.createSecondClient) {
      // pglite is single-connection: true cross-client interleaving is not
      // demonstrable there (the same-session serialization is covered above).
      return;
    }

    const wiId = `WI-${generateExecutionId()}`;
    const rev = `rev-${generateExecutionId()}`;
    const keyInput = input(wiId, rev);

    const second = await stack.db.createSecondClient();
    try {
      const serviceA = service(stack.db.client);
      const serviceB = service(second.client);
      const createsBefore = fakeGithub.createPullRequestCalls.length;

      // Both clients drive the SAME convergence key concurrently. The
      // FOR UPDATE serialization forces one to win: the loser observes the
      // winner's committed 'created' intent and returns the SAME PR with
      // ZERO external calls of its own.
      const [a, b] = await Promise.all([
        serviceA.open(keyInput),
        serviceB.open(keyInput),
      ]);

      expect(a.externalPrId).toBe(b.externalPrId);
      // EXACTLY ONE create across both concurrent clients.
      expect(fakeGithub.createPullRequestCalls).toHaveLength(createsBefore + 1);
      // The single durable intent is 'created' with that identity.
      const intent = await serviceA.findIntent(wiId, rev);
      expect(intent?.status).toBe('created');
      expect(intent?.externalPrId).toBe(a.externalPrId);
    } finally {
      await second.close();
    }
  });

  it('BLOCKER 2 (key semantics) — a NEW implementation revision is a NEW convergence key and opens a genuinely NEW PR', async () => {
    const wiId = `WI-${generateExecutionId()}`;
    const rev1 = `rev-${generateExecutionId()}`;
    const rev2 = `rev-${generateExecutionId()}`;
    const svc = service();

    const first = await svc.open(input(wiId, rev1));
    const second = await svc.open(input(wiId, rev2));

    expect(first.externalPrId).not.toBe(second.externalPrId);
    expect(fakeGithub.createPullRequestCalls).toContain(governedHeadBranch(wiId, rev1));
    expect(fakeGithub.createPullRequestCalls).toContain(governedHeadBranch(wiId, rev2));
    // Both keys are durably recorded — a re-drive of EITHER converges.
    expect((await svc.findIntent(wiId, rev1))?.externalPrId).toBe(first.externalPrId);
    expect((await svc.findIntent(wiId, rev2))?.externalPrId).toBe(second.externalPrId);
  });

  it('BLOCKER 2 (duplicate-key guard) — the external authority itself rejects a duplicate open PR for the same head (GitHub 422 semantics)', async () => {
    const wiId = `WI-${generateExecutionId()}`;
    const rev = `rev-${generateExecutionId()}`;
    const svc = service();
    const created = await svc.open(input(wiId, rev));

    // A path that bypassed the protocol and tried to create again on the
    // same head branch would hit the provider's duplicate rejection — the
    // last line of defense behind the durable convergence protocol.
    const link = await linkRepo.findByProject(project.id);
    expect(link).toBeTruthy();
    await expect(
      fakeGithub.createPullRequest({
        owner: link!.owner,
        repository: link!.repository,
        title: 'duplicate attempt',
        head: governedHeadBranch(wiId, rev),
        base: 'main',
        installationId: link!.installationId,
      }),
    ).rejects.toThrow(/pull request already exists/i);
    // And the converged PR identity remains the recorded one.
    expect((await svc.findIntent(wiId, rev))?.externalPrId).toBe(created.externalPrId);
  });

  it('BLOCKER 2 (fail closed) — a missing repository link is a typed failure, never a silent PR-less success', async () => {
    const orphan = await stack.projectRepository.create({
      organizationId: orgId,
      name: `No-Link-${generateExecutionId()}`,
    });
    const svc = service();
    await expect(
      svc.open({
        projectId: orphan.id,
        workItemId: `WI-${generateExecutionId()}`,
        headRevision: `rev-${generateExecutionId()}`,
        title: 'orphan',
      }),
    ).rejects.toThrow(/no linked GitHub repository/i);
  });
});

describe('WORK-051 round 3 — the collision-proof convergence marker + the PRODUCTION-shaped governed PR boundary', () => {
  // --- BLOCKER 2 (round 3): the collision-resistant digest ------------------

  it('BLOCKER 2 (round 3) — the governed head branch is a CRYPTOGRAPHIC DIGEST of the COMPLETE key: distinct keys sharing 12-char prefixes CANNOT collide', () => {
    // Two DISTINCT logical keys whose (workItemId, headRevision) components
    // BOTH share their first 12 characters — the round-2 truncation's exact
    // collision domain. Under the digest they must map to DIFFERENT branches.
    const wiA = 'WI-collisionXXXXXA'; // 12-char shared prefix 'WI-collisionXX'
    const wiB = 'WI-collisionXXXXXB';
    const revA = 'rev-collisionYYYYYA'; // 12-char shared prefix 'rev-collision'
    const revB = 'rev-collisionYYYYYB';
    expect(wiA.slice(0, 12)).toBe(wiB.slice(0, 12));
    expect(revA.slice(0, 12)).toBe(revB.slice(0, 12));

    const branchA = governedHeadBranch(wiA, revA);
    const branchB = governedHeadBranch(wiB, revB);
    expect(branchA).not.toBe(branchB);

    // The marker is a FULL 64-hex sha256 digest under a fixed governed
    // prefix — no truncated identifier participates in the identity.
    expect(branchA).toMatch(/^wfos\/governed\/[0-9a-f]{64}$/);

    // Purity: the same key always derives the same branch.
    expect(governedHeadBranch(wiA, revA)).toBe(branchA);

    // A single-character difference in EITHER component changes the digest.
    expect(governedHeadBranch(wiA, `${revA}x`)).not.toBe(branchA);
    expect(governedHeadBranch(`${wiA}x`, revA)).not.toBe(branchA);
  });

  // --- BLOCKER 1 (round 3): the PRODUCTION-shaped crash/recovery proofs ------

  let stack: TestAuthStack;
  let api: ScriptedGitHubApi;
  let linkRepo: PgProjectGitHubRepositoryRepository;
  let project: { id: string };
  const OWNER = 'prod-governed-org';
  const REPO = 'prod-governed-repo';
  let prodPrivateKey = '';

  /** The PRODUCTION boundary composition: port → DefaultGitHubAdapter → real REST wire. */
  const productionPort = (): GithubBackedPullRequestCreationPort =>
    new GithubBackedPullRequestCreationPort(
      linkRepo,
      new DefaultGitHubAdapter({
        appId: '99988877',
        privateKey: prodPrivateKey,
        apiBaseUrl: api.url,
      }),
    );

  beforeAll(async () => {
    const keyPair = await generateRsaKeyPairPem();
    prodPrivateKey = keyPair.privateKeyPem;
    api = new ScriptedGitHubApi();
    await api.start();
    stack = await buildAuthStack({});
    linkRepo = new PgProjectGitHubRepositoryRepository(stack.db.client);
    const org = await stack.organizationRepository.create({ name: 'Prod Governed Org' });
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'prod-governed-user', displayName: 'User' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Prod Governed Project' });
    await linkRepo.create({
      projectId: project.id,
      installationId: 'inst-prod-governed',
      owner: OWNER,
      repository: REPO,
      defaultBranch: 'main',
    });
  });

  afterAll(async () => {
    await stack.teardown();
    await api.stop();
  });

  const input = (workItemId: string, headRevision: string) => ({
    projectId: project.id,
    workItemId,
    headRevision,
    title: `Work item ${workItemId}`,
    body: 'production-shaped regression',
  });

  /** Count the REAL wire creates (POST /repos/{owner}/{repo}/pulls). */
  const wireCreates = (): number =>
    api.requests.filter((r) => r.method === 'POST' && r.path === `/repos/${OWNER}/${REPO}/pulls`).length;

  it('BLOCKER 1 (round 3) — crash AFTER the real REST create: the retry CONVERGES with EXACTLY ONE wire create (production adapter, real HTTP)', async () => {
    const wiId = `WI-${generateExecutionId()}`;
    const rev = `rev-${generateExecutionId()}`;

    // First attempt: the real REST create SUCCEEDS on the wire, then the
    // process dies before the durable record (the transaction rolls back).
    const crashed = new GovernedPullRequestService(
      stack.db.client,
      new CrashingProductionPort(productionPort(), 'crash-after-create'),
    );
    await expect(crashed.open(input(wiId, rev))).rejects.toThrow('simulated crash AFTER');
    // The durable record rolled back…
    expect(await crashed.findIntent(wiId, rev)).toBeNull();
    // …but the EXTERNAL side effect happened on the REAL wire: exactly one create.
    expect(wireCreates()).toBe(1);

    // The RETRY (a fresh process over the same durable state + the same
    // external authority): converge on the PR the crashed attempt created —
    // the convergence read finds it by the deterministic digest branch.
    const retry = new GovernedPullRequestService(stack.db.client, productionPort());
    const converged = await retry.open(input(wiId, rev));
    expect(converged.externalPrId).toBe(`github:${OWNER}/${REPO}#1`);
    expect(wireCreates()).toBe(1); // STILL exactly one create — no second PR
    const intent = await retry.findIntent(wiId, rev);
    expect(intent).toEqual({
      status: 'created',
      externalPrId: `github:${OWNER}/${REPO}#1`,
      headCommit: converged.headCommit,
    });

    // A THIRD drive: pure convergence — zero new wire calls of any kind.
    const requestsBefore = api.requests.length;
    const again = await retry.open(input(wiId, rev));
    expect(again.externalPrId).toBe(converged.externalPrId);
    expect(api.requests.length).toBe(requestsBefore);
  });

  it('BLOCKER 1 (round 3) — two independent clients (two processes) converge on ONE PR with exactly ONE wire create (real PostgreSQL + production adapter)', async () => {
    const isRealPg =
      !!process.env.WORKFLOWOS_DATABASE_URL &&
      process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');
    if (!isRealPg || !stack.db.createSecondClient) {
      // pglite is single-connection: true cross-client interleaving is not
      // demonstrable there (the fake-adapter suite covers the same-session
      // serialization; this production-shaped proof is real-PG-only).
      return;
    }
    const wiId = `WI-${generateExecutionId()}`;
    const rev = `rev-${generateExecutionId()}`;

    const second = await stack.db.createSecondClient();
    try {
      const serviceA = new GovernedPullRequestService(stack.db.client, productionPort());
      const serviceB = new GovernedPullRequestService(second.client, productionPort());
      const createsBefore = wireCreates();

      // Both processes drive the SAME convergence key concurrently, each
      // through its OWN production adapter instance (its own token cache —
      // both mint installation tokens). The FOR UPDATE serialization forces
      // one to win; the loser observes the winner's committed intent and
      // converges with zero external calls of its own.
      const [a, b] = await Promise.all([
        serviceA.open(input(wiId, rev)),
        serviceB.open(input(wiId, rev)),
      ]);
      expect(a.externalPrId).toBe(b.externalPrId);
      expect(wireCreates()).toBe(createsBefore + 1); // EXACTLY ONE wire create
      const intent = await serviceA.findIntent(wiId, rev);
      expect(intent?.status).toBe('created');
      expect(intent?.externalPrId).toBe(a.externalPrId);
    } finally {
      await second.close();
    }
  });

  it('BLOCKER 3 (round 3) — the PRODUCTION port resolves an external PR to its authoritative head commit through the real REST read', async () => {
    const port = productionPort();
    // An external PR (opened out-of-band) exists at the authority.
    const headSha = `extsha${generateExecutionId()}`;
    const number = api.seedExternalPullRequest({
      owner: OWNER,
      repository: REPO,
      head: 'human-branch',
      headSha,
    });
    const resolved = await port.resolveExternalPullRequest({
      projectId: project.id,
      externalPrRef: `github:${OWNER}/${REPO}#${number}`,
    });
    expect(resolved).toEqual({
      externalPrId: `github:${OWNER}/${REPO}#${number}`,
      headCommit: headSha,
      state: 'open',
      merged: false,
    });
    // The wire read was the real GET /repos/{o}/{r}/pulls/{n}.
    const read = api.requests.filter(
      (r) => r.method === 'GET' && r.path === `/repos/${OWNER}/${REPO}/pulls/${number}`,
    );
    expect(read.length).toBeGreaterThanOrEqual(1);

    // An unknown PR is an honest null — unresolvable, never fabricated.
    const missing = await port.resolveExternalPullRequest({
      projectId: project.id,
      externalPrRef: `github:${OWNER}/${REPO}#999999`,
    });
    expect(missing).toBeNull();

    // A malformed reference fails closed.
    await expect(
      port.resolveExternalPullRequest({
        projectId: project.id,
        externalPrRef: 'not-a-pr-ref',
      }),
    ).rejects.toThrow(/not a canonical GitHub PR reference/i);

    // A reference into a FOREIGN repository fails closed.
    await expect(
      port.resolveExternalPullRequest({
        projectId: project.id,
        externalPrRef: `github:other-org/${REPO}#${number}`,
      }),
    ).rejects.toThrow(/not the project's linked repository/i);
  });

  /**
   * The crash-injecting wrapper over the PRODUCTION port (same protocol as
   * the fake-adapter suite: the inner port performs the REAL REST delegation;
   * the wrapper kills the caller around the external side effect).
   */
  class CrashingProductionPort implements PullRequestCreationPort {
    constructor(
      private readonly inner: PullRequestCreationPort,
      private readonly mode: 'crash-before-create' | 'crash-after-create',
    ) {}

    async findExistingPullRequest(input: {
      projectId: string;
      workItemId: string;
      headRevision: string;
    }): Promise<CreatedPullRequest | null> {
      return this.inner.findExistingPullRequest(input);
    }

    async resolveExternalPullRequest(input: {
      projectId: string;
      externalPrRef: string;
    }): Promise<ResolvedExternalPullRequest | null> {
      return this.inner.resolveExternalPullRequest(input);
    }

    async createPullRequest(input: {
      projectId: string;
      workItemId: string;
      headRevision: string;
      title: string;
      body?: string | null;
    }): Promise<CreatedPullRequest> {
      if (this.mode === 'crash-before-create') {
        throw new Error('simulated crash BEFORE the external PR create');
      }
      await this.inner.createPullRequest(input);
      throw new Error('simulated crash AFTER the external PR create (before the durable record)');
    }
  }
});
