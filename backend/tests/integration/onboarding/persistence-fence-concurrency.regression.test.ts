/**
 * PR #42 round-6 — the database-level persistence fence: REAL PostgreSQL
 * concurrency regression.
 *
 * The architect's round-6 review of commit `f229641` established that the
 * round-5 application-level `revalidate()` callback (an independent policy-
 * engine call — a PLAIN `SELECT` on `wfos_agent_policies`) is NOT a real
 * fence: it leaves a TOCTOU window between the final revalidation read and
 * COMMIT, because the database transaction does not lock or condition its
 * commit on the policy row remaining at the snapshot's version.
 *
 * The round-6 fix makes the persistence transaction ACQUIRE the row lock on
 * the authoritative `wfos_agent_policies` row INSIDE the same PostgreSQL
 * transaction (`SELECT ... FOR UPDATE`), held from the version check
 * THROUGH commit. This file proves the serialization is REAL by exercising
 * TWO concurrent `pg.Client` connections against the same schema:
 *
 *   A. T1 (the fence) holds the FOR UPDATE row lock → T2 (the policy
 *      mutator: `PgAgentPolicyRepository.setProjectPolicy`) BLOCKS → T1
 *      verifies the snapshot + writes + commits → T2 unblocks + applies the
 *      mutation (the persistence happened-before the mutation in the
 *      serialization order). Proves the fence SERIALIZES against the policy
 *      mutation path.
 *
 *   B. The inverse: T2 mutates the policy V7→V8 + COMMITS first → T1's fence
 *      (snapshot V7) does a locked read → READ COMMITTED semantics return
 *      the NEWEST committed row (V8) → the version predicate rejects →
 *      ROLLBACK → `fence-stale` → ZERO stale evidence/observations are
 *      committed. This is the architect's exact invariant.
 *
 *   C. The normal path (no mutation): T1 locks V7, verifies V7==V7, writes,
 *      commits → `persisted` (evidence + observations committed). Proves the
 *      fence is transparent when there is no drift.
 *
 *   D. Check B (per-read snapshot verification): the DB row is V7 (matches
 *      the persistence snapshot V7) BUT an evidence row carries a per-read
 *      policyVersion=6 (stale relative to the persistence snapshot) →
 *      ROLLBACK → `fence-stale` → ZERO stale evidence committed. Proves the
 *      per-read verification (retained from round-5) catches intra-evidence
 *      staleness independent of the DB row.
 *
 * A fake mutating policy gate is INSUFFICIENT for this invariant (the
 * architect's round-6 words): the problem is now specifically database
 * transaction serialization, so the regression must use REAL PostgreSQL
 * concurrency. The suite SKIPS on pglite (single-threaded WASM cannot
 * demonstrate true blocking) — it runs only when `WORKFLOWOS_DATABASE_URL`
 * is set (CI with a real postgres service).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgProjectBaselineRepository } from '../../../src/modules/projects/internal/pg-project-baseline-repository.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import { PgAgentPolicyRepository } from '../../../src/modules/agents/internal/pg-agent-policy-repository.js';
import type { DatabaseClient } from '@platform/postgres/database-client.js';
import type { NewBaselineEvidence, NewBaselineObservation } from '@modules/projects/index.js';
import type { AgentPolicyDocument } from '@modules/agents/index.js';

const isRealPg = !!process.env.WORKFLOWOS_DATABASE_URL && process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

/** sha256 hex of a string (for content digests + claim digests). */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The V7 policy document (allow-by-default, no rules). */
const V7_DOCUMENT: AgentPolicyDocument = {
  description: 'V7 test policy',
  rules: [],
  defaultEffect: 'allow',
};

/** The V8 policy document (allow-by-default, no rules — a material change that bumps the version). */
const V8_DOCUMENT: AgentPolicyDocument = {
  description: 'V8 test policy (mutated)',
  rules: [],
  defaultEffect: 'allow',
};

/**
 * Build a minimal governed-read evidence row for a file `path`, carrying the
 * given per-read `policyVersion` (recorded on `repositoryReadEnforcement`).
 */
function makeEvidence(path: string, perReadPolicyVersion: number): NewBaselineEvidence {
  const content = `content of ${path}`;
  return {
    source: 'filesystem',
    locator: path,
    contentDigest: sha256(content),
    redacted: false,
    // PR #42 round-2 invariant: NULL for /github-authority reads.
    toolInvocationId: null,
    policyDecision: null,
    // PR #42 round-3: the actual governed-read decision + enforcement.
    repositoryReadDecision: 'allow',
    repositoryReadEnforcement: {
      policyVersion: perReadPolicyVersion,
      ruleId: 'fake-rule',
      performed: true,
      truncated: false,
      maxOutputBytes: null,
      truncatedAtBytes: null,
      pathAllowed: true,
      reason: 'allowed by test policy',
      // Round-4 fencing fields (the per-read fence captured + revalidated V).
      revalidated: true,
      revalidatedPolicyVersion: perReadPolicyVersion,
      revalidatedRuleId: 'fake-rule',
      revalidatedDecision: 'allow',
      stale: false,
    },
  };
}

/** Build a minimal observed observation referencing the given evidence locator. */
function makeObservation(
  kind: 'repository_identity' | 'package_managers',
  claim: Record<string, unknown>,
  evidenceLocator: string,
): NewBaselineObservation {
  const canonical = JSON.stringify(claim);
  return {
    kind,
    provenance: 'observed',
    claim,
    claimDigest: sha256(canonical),
    // The fence resolves evidence-ref by LOCATOR (round-2 Blocker A).
    evidenceRef: [evidenceLocator],
  };
}

describe.skipIf(!isRealPg)('PR #42 round-6 — the database-level persistence fence (real PostgreSQL concurrency)', () => {
  let stack: TestAuthStack;
  let orgId: string;
  let projectId: string;
  let userId: string;
  let baselineId: string;
  let baselineVersion: number;
  let repoLinkRowId: string;
  let projectBaselineRepository: PgProjectBaselineRepository;
  let projectGitHubRepositoryRepository: PgProjectGitHubRepositoryRepository;
  let second: { client: DatabaseClient; close: () => Promise<void> } | undefined;

  beforeAll(() => {
    // Real-PG only; pglite cannot demonstrate true blocking.
  });

  beforeEach(async () => {
    stack = await buildAuthStack();
    projectBaselineRepository = new PgProjectBaselineRepository(stack.db.client);
    projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(stack.db.client);

    const org = await stack.organizationRepository.create({ name: 'Round-6 Concurrency Org' });
    orgId = org.id;
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'round6-user',
      email: 'owner@round6.example',
      displayName: 'Owner',
    });
    userId = user.id;
    await stack.membershipRepository.assign({ organizationId: orgId, userId, roleId: 'owner' });
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'Round-6 Project' });
    projectId = project.id;
    await stack.projectAccessRepository.grant({ userId, projectId, roleId: 'owner' });

    await stack.db.client.exec(`
      INSERT INTO wfos_github_installations (project_id, installation_id, account_login, metadata)
      VALUES ('${projectId}', '99999', 'round6-org', '{}')
    `);
    const repoLink = await projectGitHubRepositoryRepository.create({
      projectId,
      installationId: '99999',
      owner: 'round6-org',
      repository: 'round6-repo',
      defaultBranch: 'main',
      linkType: 'linked',
    });
    repoLinkRowId = repoLink.id;

    // Seed a baseline in the 'analyzing' state (the fence's CAS target).
    const baseline = await projectBaselineRepository.ensureBaseline({
      projectId,
      organizationId: orgId,
      projectGithubRepositoryId: repoLinkRowId,
      repositoryOwner: 'round6-org',
      repositoryName: 'round6-repo',
      baselineCommitSha: 'fakesha-round6',
      revisionRef: 'main',
      analysisMode: 'native',
      analysisRunId: 'round6-run',
    });
    baselineId = baseline.id;
    baselineVersion = baseline.version;

    // Seed the authoritative wfos_agent_policies row at V7 (the fence locks
    // this row). The trigger bumps policy_version only on UPDATE; the INSERT
    // sets it to 7 directly.
    await stack.db.client.query(
      `INSERT INTO wfos_agent_policies
         (organization_id, project_id, scope, document, policy_version, created_by)
       VALUES ($1, $2, 'project', $3::jsonb, 7, $4)`,
      [orgId, projectId, JSON.stringify(V7_DOCUMENT), userId],
    );

    // Open the SECOND independent pg.Client (T2) against the same schema.
    second = stack.db.createSecondClient ? await stack.db.createSecondClient() : undefined;
  });

  afterEach(async () => {
    if (second) await second.close();
    await stack.teardown();
  });

  afterAll(async () => {
    // nothing extra (the schema is dropped in stack.teardown).
  });

  // The V7 persistence snapshot (the fence's reference value).
  const v7Snapshot = {
    source: 'project' as const,
    policyVersion: 7,
    ruleId: 'fake-rule',
    decision: 'allow' as const,
    reason: null,
  };

  /** Read the current policy_version of the project-scope row. */
  async function currentPolicyVersion(): Promise<number | null> {
    const r = await stack.db.client.query<{ policy_version: number }>(
      `SELECT policy_version FROM wfos_agent_policies
        WHERE scope = 'project' AND organization_id = $1 AND project_id = $2`,
      [orgId, projectId],
    );
    return r.rows[0]?.policy_version ?? null;
  }

  // =========================================================================
  // A. SERIALIZATION: T1 fence holds the FOR UPDATE lock → T2 mutator BLOCKS
  //    → T1 verifies + writes + commits → T2 unblocks + applies V8.
  // =========================================================================
  it('A. T1 holds the FOR UPDATE row lock → T2 policy mutation BLOCKS → T1 commits → T2 applies (real serialization)', async () => {
    const t2Repo = new PgAgentPolicyRepository({ db: second!.client });
    let t2WasBlocked = false;
    let t2Promise: Promise<void> | undefined;

    // T2's mutation: setProjectPolicy(V8_DOC) — an INSERT ... ON CONFLICT DO
    // UPDATE on the SAME wfos_agent_policies row the fence locks. It MUST
    // block on T1's FOR UPDATE row lock.
    //
    // CRITICAL: T2 is started INSIDE the willMutate hook — i.e. AFTER T1 has
    // acquired the FOR UPDATE row lock + verified the snapshot (so T2 cannot
    // sneak in before T1 locks the row + commit V8 first). Starting T2 before
    // T1 begins would let T2 commit V8 before T1's SELECT FOR UPDATE, making
    // T1 see V8 → fence-stale (the wrong outcome for THIS scenario — that is
    // scenario B, not A).
    const willMutate = async () => {
      // T1 now holds the FOR UPDATE row lock. Start T2 — its INSERT ... ON
      // CONFLICT DO UPDATE will block on T1's lock.
      t2Promise = (async () => {
        await t2Repo.setProjectPolicy({
          organizationId: orgId,
          projectId,
          document: V8_DOCUMENT,
          userId,
        });
      })();
      // Give T2 time to reach the blocked state.
      await delay(300);
      // PROBE: is T2 still pending (blocked) or did it resolve (the fence did
      // NOT serialize — T2 committed before T1)?
      const probe = await Promise.race([
        t2Promise.then(() => 'resolved' as const),
        delay(50).then(() => 'pending' as const),
      ]);
      t2WasBlocked = probe === 'pending';
    };

    const evidence = [makeEvidence('package.json', 7)];
    const observations = [
      makeObservation('repository_identity', { name: 'round6-repo' }, 'package.json'),
    ];

    const t1Result = await projectBaselineRepository.persistBaselineWithPolicyFence({
      baselineId,
      evidence,
      observations,
      contentDigest: sha256('round6-content'),
      expectedVersion: baselineVersion,
      snapshot: v7Snapshot,
      organizationId: orgId,
      projectId,
      willMutate,
    });

    // T1 committed (persisted) — the fence held the lock through the writes +
    // commit, so its own evidence was committed under V7.
    expect(t1Result.kind, 'T1 persisted under V7 (the fence held the lock)').toBe('persisted');

    // T2 was BLOCKED while T1 held the lock (the real serialization point).
    expect(t2WasBlocked, 'T2 was blocked on T1\'s FOR UPDATE row lock (real DB serialization)').toBe(true);

    // T1 committed → the lock released → T2 unblocks + applies V8. Await T2
    // (so afterEach does not terminate its in-flight query).
    await t2Promise;
    expect(await currentPolicyVersion(), 'T2 applied V8 after T1 committed').toBe(8);

    // T1's evidence was committed under V7 (the serialization order:
    // persistence happened-before the mutation).
    const persistedEvidence = await projectBaselineRepository.listEvidence(baselineId);
    expect(persistedEvidence.length, 'T1\'s V7 evidence is committed').toBeGreaterThan(0);
    expect(
      persistedEvidence[0]!.repositoryReadEnforcement?.policyVersion,
      'the committed evidence carries V7 (the persistence happened-before the V8 mutation)',
    ).toBe(7);

    // The baseline is complete (T1's markComplete committed under the lock).
    const baseline = await projectBaselineRepository.findById(baselineId);
    expect(baseline?.state, 'T1 completed the baseline under the lock').toBe('complete');
  });

  // =========================================================================
  // B. STALE REJECTION: T2 mutates V7→V8 + COMMITS first → T1's fence reads
  //    the NEWEST committed version (V8) → rejects (fence-stale) → ZERO stale
  //    evidence/observations committed. (The architect's exact invariant.)
  // =========================================================================
  it('B. T2 mutates V7→V8 + commits FIRST → T1 fence reads V8 → rejects (fence-stale) → ZERO stale evidence/observations committed', async () => {
    const t2Repo = new PgAgentPolicyRepository({ db: second!.client });

    // T2 mutates the policy + COMMITS first (fully, before T1 begins).
    await t2Repo.setProjectPolicy({
      organizationId: orgId,
      projectId,
      document: V8_DOCUMENT,
      userId,
    });
    expect(await currentPolicyVersion(), 'T2 committed V8 first').toBe(8);

    // T1's orchestrator captured V7 BEFORE T2's mutation (the snapshot is
    // stale). T1's fence: SELECT ... FOR UPDATE → READ COMMITTED returns the
    // NEWEST committed row (V8) → version predicate rejects → ROLLBACK.
    const evidence = [makeEvidence('package.json', 7)];
    const observations = [
      makeObservation('repository_identity', { name: 'round6-repo' }, 'package.json'),
    ];

    const t1Result = await projectBaselineRepository.persistBaselineWithPolicyFence({
      baselineId,
      evidence,
      observations,
      contentDigest: sha256('round6-content'),
      expectedVersion: baselineVersion,
      snapshot: v7Snapshot, // stale — the policy already moved to V8
      organizationId: orgId,
      projectId,
      // no willMutate — T2 already committed
    });

    expect(t1Result.kind, 'T1 REJECTED (the snapshot is stale relative to the NEWEST committed V8)').toBe('fence-stale');
    if (t1Result.kind === 'fence-stale') {
      expect(t1Result.reason, 'the rejection explains the database-level fence').toContain('DATABASE-LEVEL fence');
      expect(t1Result.reason, 'the rejection cites the locked version V8').toContain('policy_version=8');
      expect(t1Result.reason, 'the rejection cites the snapshot version V7').toContain('policyVersion=7');
    }

    // CRITICAL: ZERO stale evidence/observations are committed (the
    // transaction was rolled back). The architect's invariant.
    const persistedEvidence = await projectBaselineRepository.listEvidence(baselineId);
    expect(persistedEvidence.length, 'ZERO stale evidence committed (the transaction rolled back)').toBe(0);
    const persistedObservations = await projectBaselineRepository.listObservations(baselineId);
    expect(persistedObservations.length, 'ZERO stale observations committed (the transaction rolled back)').toBe(0);

    // The baseline is still 'analyzing' (markComplete was rolled back).
    const baseline = await projectBaselineRepository.findById(baselineId);
    expect(baseline?.state, 'the baseline stays analyzing (markComplete rolled back)').toBe('analyzing');

    // The policy is V8 (T2's mutation stands — T1 did not touch it).
    expect(await currentPolicyVersion(), 'the policy is V8 (T2\'s mutation stands)').toBe(8);
  });

  // =========================================================================
  // C. NORMAL PATH: no mutation → T1 locks V7, verifies V7==V7, writes, commits
  //    → persisted (evidence + observations committed). The fence is
  //    transparent when there is no drift.
  // =========================================================================
  it('C. NORMAL (no mutation) → T1 locks V7 + verifies V7==V7 → writes → COMMIT → persisted', async () => {
    const evidence = [makeEvidence('package.json', 7), makeEvidence('README.md', 7)];
    const observations = [
      makeObservation('repository_identity', { name: 'round6-repo' }, 'package.json'),
      makeObservation('package_managers', { name: 'round6-repo' }, 'package.json'),
    ];

    const t1Result = await projectBaselineRepository.persistBaselineWithPolicyFence({
      baselineId,
      evidence,
      observations,
      contentDigest: sha256('round6-content'),
      expectedVersion: baselineVersion,
      snapshot: v7Snapshot,
      organizationId: orgId,
      projectId,
      // no willMutate, no T2 — no drift
    });

    expect(t1Result.kind, 'T1 persisted (no drift)').toBe('persisted');

    // Evidence + observations committed.
    const persistedEvidence = await projectBaselineRepository.listEvidence(baselineId);
    expect(persistedEvidence.length, 'evidence committed').toBe(2);
    expect(persistedEvidence.find((e) => e.locator === 'package.json'), 'package.json evidence committed').toBeDefined();
    expect(persistedEvidence.find((e) => e.locator === 'README.md'), 'README.md evidence committed').toBeDefined();
    const persistedObservations = await projectBaselineRepository.listObservations(baselineId);
    expect(persistedObservations.length, 'observations committed').toBeGreaterThan(0);

    // The baseline is complete.
    const baseline = await projectBaselineRepository.findById(baselineId);
    expect(baseline?.state, 'baseline complete').toBe('complete');

    // The policy is still V7 (no mutation).
    expect(await currentPolicyVersion(), 'policy still V7 (no mutation)').toBe(7);
  });

  // =========================================================================
  // D. CHECK B (per-read snapshot verification): the DB row is V7 (matches the
  //    persistence snapshot V7) BUT an evidence row carries a per-read
  //    policyVersion=6 (stale relative to the persistence snapshot) → ROLLBACK
  //    → fence-stale → ZERO stale evidence committed. Proves the per-read
  //    verification (retained from round-5) catches intra-evidence staleness
  //    independent of the DB row lock.
  // =========================================================================
  it('D. Check B — per-read mismatch: DB row V7 (== snapshot V7) BUT evidence per-read V6 → ROLLBACK → fence-stale → ZERO stale evidence committed', async () => {
    // The DB row is V7 (matches the persistence snapshot V7 — the
    // database-level fence PASSES). But the evidence row carries a per-read
    // policyVersion=6 (stale relative to the persistence snapshot V7) —
    // Check B catches the intra-evidence mismatch → ROLLBACK.
    const evidence = [makeEvidence('package.json', 6)]; // per-read V6
    const observations = [
      makeObservation('repository_identity', { name: 'round6-repo' }, 'package.json'),
    ];

    const t1Result = await projectBaselineRepository.persistBaselineWithPolicyFence({
      baselineId,
      evidence,
      observations,
      contentDigest: sha256('round6-content'),
      expectedVersion: baselineVersion,
      snapshot: v7Snapshot, // persistence snapshot V7
      organizationId: orgId,
      projectId,
    });

    expect(t1Result.kind, 'T1 REJECTED at Check B (per-read mismatch)').toBe('fence-stale');
    if (t1Result.kind === 'fence-stale') {
      expect(t1Result.reason, 'the rejection explains the per-read verification').toContain('PER-READ snapshot verification');
    }

    // ZERO evidence/observations committed.
    const persistedEvidence = await projectBaselineRepository.listEvidence(baselineId);
    expect(persistedEvidence.length, 'ZERO stale evidence committed').toBe(0);
    const persistedObservations = await projectBaselineRepository.listObservations(baselineId);
    expect(persistedObservations.length, 'ZERO stale observations committed').toBe(0);

    // The baseline is still 'analyzing' (markComplete rolled back).
    const baseline = await projectBaselineRepository.findById(baselineId);
    expect(baseline?.state, 'baseline stays analyzing').toBe('analyzing');

    // The policy is still V7 (no mutation — the DB row was never the issue).
    expect(await currentPolicyVersion(), 'policy still V7 (no mutation)').toBe(7);
  });
});
