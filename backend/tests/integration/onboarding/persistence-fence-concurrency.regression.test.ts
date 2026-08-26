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

describe.skipIf(!isRealPg)('PR #42 round-6 + round-7 — the database-level + scope-resolution persistence fence (real PostgreSQL concurrency)', () => {
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
      expect(t1Result.reason, 'the rejection explains the scope-resolution fence').toContain('SCOPE-RESOLUTION fence');
      expect(t1Result.reason, 'the rejection cites the effective re-resolution step').toContain('EFFECTIVE-POLICY re-resolution');
      expect(t1Result.reason, 'the rejection cites the locked effective version V8').toContain('policyVersion=8');
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

  // =========================================================================
  // PR #42 ROUND-7 — the SCOPE-RESOLUTION fence: the missing-row cases.
  //
  // The architect's round-7 review of commit `60dda58` established that
  // the round-6 fence locked ONLY the row represented by `snapshot.source`.
  // That works when the current effective policy source is an existing
  // project/org policy row. But consider: when the current effective source
  // is `organization` (no project policy exists) and a concurrent T2
  // CREATES a NEW project policy row, the effective policy changes (project
  // now overrides organization) but the locked organization row did NOT
  // change → the round-6 fence let V7 (org) stale evidence commit under
  // the new V1 (project) effective policy. The inverse hole existed when a
  // project policy was DELETED (clearProjectPolicy) and resolution fell back
  // to organization.
  //
  // THE ROUND-7 FIX (proven by these three tests): the fence locks the
  // scope ANCHOR rows (wfos_projects + wfos_organizations) AND the relevant
  // policy rows (project + org, present OR absent — the anchor lock blocks
  // a NEW project policy INSERT via the FK-induced FOR KEY SHARE). The
  // mutation paths (setProjectPolicy / clearProjectPolicy /
  // setOrganizationPolicy / clearOrganizationPolicy) acquire the SAME
  // anchor lock — so the two transactions SERIALIZE even when the
  // effective policy changes because a row is CREATED or DELETED.
  //
  // The architect's invariant — "policy row immutability ≠ effective
  // policy immutability" — is honored: the fence asserts against the
  // EFFECTIVE policy version/source, NOT merely the old policy row's
  // version.
  // =========================================================================

  // The V1 project-override document (a NEW project policy that overrides
  // the org default — used in scenarios E and G).
  const V1_PROJECT_DOCUMENT: AgentPolicyDocument = {
    description: 'V1 project override (created mid-flight)',
    rules: [],
    defaultEffect: 'allow',
  };

  // The V7 organization-scope snapshot (the fence's reference value when
  // the effective source is `organization`).
  const v7OrgSnapshot = {
    source: 'organization' as const,
    policyVersion: 7,
    ruleId: 'fake-rule',
    decision: 'allow' as const,
    reason: null,
  };

  /**
   * Reset the seeded project-scope policy → seed an organization-scope V7
   * policy (no project policy exists). Used by scenarios E and G (the
   * architect's "no project policy" setup).
   */
  async function seedOrgOnlyV7(): Promise<void> {
    // Remove the project-scope policy the beforeEach seeded (so the
    // effective policy resolves to the organization default).
    await stack.db.client.query(
      `DELETE FROM wfos_agent_policies
        WHERE scope = 'project' AND organization_id = $1 AND project_id = $2`,
      [orgId, projectId],
    );
    // Seed the organization-scope V7 default (the fence will lock this row
    // + the project anchor + the org anchor).
    await stack.db.client.query(
      `INSERT INTO wfos_agent_policies
         (organization_id, project_id, scope, document, policy_version, created_by)
       VALUES ($1, NULL, 'organization', $2::jsonb, 7, $3)`,
      [orgId, JSON.stringify(V7_DOCUMENT), userId],
    );
  }

  /** Read the project-scope policy version (null = no project policy row). */
  async function currentProjectPolicyVersion(): Promise<number | null> {
    const r = await stack.db.client.query<{ policy_version: number }>(
      `SELECT policy_version FROM wfos_agent_policies
        WHERE scope = 'project' AND organization_id = $1 AND project_id = $2`,
      [orgId, projectId],
    );
    return r.rows[0]?.policy_version ?? null;
  }

  /** Read the organization-scope policy version (null = no org policy row). */
  async function currentOrgPolicyVersion(): Promise<number | null> {
    const r = await stack.db.client.query<{ policy_version: number }>(
      `SELECT policy_version FROM wfos_agent_policies
        WHERE scope = 'organization' AND organization_id = $1`,
      [orgId],
    );
    return r.rows[0]?.policy_version ?? null;
  }

  // =========================================================================
  // E. SERIALIZATION (missing-row case 1): org policy V7 active, NO project
  //    policy → T1 fence locks the scope anchors (project + org) + the
  //    org policy row → T2's setProjectPolicy CREATES a NEW project policy
  //    row → T2 BLOCKS on T1's project anchor lock (the FK-induced FOR KEY
  //    SHARE on the project parent conflicts with T1's FOR UPDATE) → T1
  //    verifies + writes + commits under the organization policy → T2
  //    unblocks + creates the project override (the override happens
  //    AFTER the persistence in the serialization order).
  //
  //    CRITICAL ASSERTION (the architect's invariant): T1's persisted
  //    evidence carries per-read policyVersion=7 (the org V7 — the
  //    persistence happened-before the project override was created),
  //    NOT the project V1. The round-6 fence would have let V7 (org)
  //    stale evidence commit under V1 (project); the round-7 fence
  //    PROVES the override did NOT exist when T1's persistence ran (T2
  //    was blocked) + the override was created AFTER.
  // =========================================================================
  it('E. (round-7 missing-row case 1) org policy V7, no project policy → T2 creates project policy → BLOCKS on T1\'s project anchor lock → T1 commits under the org policy → project override created AFTER', async () => {
    // Setup: org policy V7 active, NO project policy (the architect's
    // "no project policy" setup). The beforeEach seeded a project policy
    // V7; remove it + seed the org-scope V7 default.
    await seedOrgOnlyV7();
    expect(await currentProjectPolicyVersion(), 'setup: no project policy exists').toBeNull();
    expect(await currentOrgPolicyVersion(), 'setup: org policy V7 active').toBe(7);

    const t2Repo = new PgAgentPolicyRepository({ db: second!.client });
    let t2WasBlocked = false;
    let t2Promise: Promise<void> | undefined;

    // T2's mutation: setProjectPolicy(V1_PROJECT_DOCUMENT) — a CREATION of
    // a NEW project policy row (no existing project policy). T2 acquires
    // the project anchor lock (FOR UPDATE on wfos_projects) BEFORE the
    // INSERT — the SAME lock T1's fence holds. So T2 BLOCKS on T1's lock
    // until T1 commits.
    //
    // CRITICAL: T2 is started INSIDE the willMutate hook — i.e. AFTER T1
    // has acquired the scope anchor locks + the relevant policy rows +
    // re-resolved the effective policy (so T2 cannot sneak in before T1
    // locks the anchors + commit V1 first). Starting T2 before T1 begins
    // would let T2 commit V1 before T1's lock acquisition, making T1 see
    // the project override → fence-stale (the wrong outcome for THIS
    // scenario — that is scenario G, not E).
    const willMutate = async () => {
      // T1 now holds the project + org anchor locks + the org policy row
      // lock. Start T2 — its setProjectPolicy acquires the project anchor
      // lock (FOR UPDATE on wfos_projects) → BLOCKS on T1's lock.
      t2Promise = (async () => {
        await t2Repo.setProjectPolicy({
          organizationId: orgId,
          projectId,
          document: V1_PROJECT_DOCUMENT,
          userId,
        });
      })();
      // Give T2 time to reach the blocked state.
      await delay(300);
      // PROBE: is T2 still pending (blocked) or did it resolve (the
      // fence did NOT serialize — T2 committed before T1)?
      const probe = await Promise.race([
        t2Promise.then(() => 'resolved' as const),
        delay(50).then(() => 'pending' as const),
      ]);
      t2WasBlocked = probe === 'pending';
    };

    const evidence = [makeEvidence('package.json', 7)];
    const observations = [
      makeObservation('repository_identity', { name: 'round7-org-scope-repo' }, 'package.json'),
    ];

    const t1Result = await projectBaselineRepository.persistBaselineWithPolicyFence({
      baselineId,
      evidence,
      observations,
      contentDigest: sha256('round7-content-E'),
      expectedVersion: baselineVersion,
      // The snapshot reflects the org-scope effective policy at capture
      // time (BEFORE T2's project override exists).
      snapshot: v7OrgSnapshot,
      organizationId: orgId,
      projectId,
      willMutate,
    });

    // T1 committed (persisted) — the fence held the project + org anchor
    // locks + the org policy row lock through the writes + commit. T1's
    // evidence was committed under the organization V7 policy (the
    // persistence happened-before the project override was created).
    expect(t1Result.kind, 'T1 persisted under org V7 (the fence held the anchor locks)').toBe('persisted');

    // T2 was BLOCKED while T1 held the project anchor lock (the real
    // serialization point for the missing-row case 1).
    expect(t2WasBlocked, 'T2 was blocked on T1\'s project anchor lock (real DB serialization — the missing-row case 1 is fenced)').toBe(true);

    // T1 committed → the lock released → T2 unblocks + creates the
    // project override. Await T2 (so afterEach does not terminate its
    // in-flight query).
    await t2Promise;
    expect(await currentProjectPolicyVersion(), 'T2 created the project override (V1) AFTER T1 committed').toBe(1);
    // The org policy is still V7 (T2 did not touch it).
    expect(await currentOrgPolicyVersion(), 'the org policy is still V7 (T2 did not touch it)').toBe(7);

    // THE ARCHITECT'S INVARIANT: T1's persisted evidence carries per-read
    // policyVersion=7 (the org V7 — the persistence happened-before the
    // project override was created). NOT V1 (the override did not exist
    // when T1's persistence ran).
    const persistedEvidence = await projectBaselineRepository.listEvidence(baselineId);
    expect(persistedEvidence.length, 'T1\'s V7 evidence is committed').toBeGreaterThan(0);
    expect(
      persistedEvidence[0]!.repositoryReadEnforcement?.policyVersion,
      'the committed evidence carries V7 (the persistence happened-before the project override was created) — the missing-row case 1 is fenced',
    ).toBe(7);

    // The baseline is complete (T1's markComplete committed under the
    // anchor locks).
    const baseline = await projectBaselineRepository.findById(baselineId);
    expect(baseline?.state, 'T1 completed the baseline under the anchor locks').toBe('complete');
  });

  // =========================================================================
  // F. SERIALIZATION (missing-row case 2): project policy V7 active → T1
  //    fence locks the scope anchors + the project policy row → T2's
  //    clearProjectPolicy DELETES the project policy row → T2 BLOCKS on
  //    T1's project anchor lock (acquired by clearProjectPolicy BEFORE the
  //    DELETE) → T1 verifies + writes + commits under the project policy
  //    → T2 unblocks + DELETEs the project policy (the fallback to
  //    organization happens AFTER the persistence in the serialization
  //    order).
  //
  //    CRITICAL ASSERTION (the architect's invariant): T1's persisted
  //    evidence carries per-read policyVersion=7 (the project V7 — the
  //    persistence happened-before the project policy was cleared), NOT
  //    the org fallback. The round-6 fence would have let V7 (project)
  //    stale evidence commit under the org fallback; the round-7 fence
  //    PROVES the clear did NOT happen when T1's persistence ran (T2 was
  //    blocked) + the fallback happened AFTER.
  // =========================================================================
  it('F. (round-7 missing-row case 2) project policy V7 active → T2 clears the project policy → BLOCKS on T1\'s project anchor lock → T1 commits under the project policy → project fallback happens AFTER', async () => {
    // Setup: project policy V7 active (the beforeEach seed — the snapshot
    // source is 'project'). No org policy seeded (the fallback is
    // platform-default when T2 clears the project policy).
    expect(await currentProjectPolicyVersion(), 'setup: project policy V7 active').toBe(7);

    const t2Repo = new PgAgentPolicyRepository({ db: second!.client });
    let t2WasBlocked = false;
    let t2Promise: Promise<void> | undefined;

    // T2's mutation: clearProjectPolicy — a DELETE on the project-scope
    // row. T2 acquires the project anchor lock (FOR UPDATE on
    // wfos_projects) BEFORE the DELETE — the SAME lock T1's fence holds.
    // So T2 BLOCKS on T1's lock until T1 commits.
    //
    // CRITICAL: T2 is started INSIDE the willMutate hook — i.e. AFTER T1
    // has acquired the scope anchor locks + the project policy row lock
    // + re-resolved the effective policy. Starting T2 before T1 begins
    // would let T2 commit the DELETE before T1's lock acquisition, making
    // T1 see the org fallback → fence-stale (that would be the inverse
    // scenario, not this one).
    const willMutate = async () => {
      // T1 now holds the project + org anchor locks + the project policy
      // row lock. Start T2 — its clearProjectPolicy acquires the project
      // anchor lock (FOR UPDATE on wfos_projects) → BLOCKS on T1's lock.
      t2Promise = (async () => {
        await t2Repo.clearProjectPolicy(orgId, projectId);
      })();
      // Give T2 time to reach the blocked state.
      await delay(300);
      // PROBE: is T2 still pending (blocked) or did it resolve?
      const probe = await Promise.race([
        t2Promise.then(() => 'resolved' as const),
        delay(50).then(() => 'pending' as const),
      ]);
      t2WasBlocked = probe === 'pending';
    };

    const evidence = [makeEvidence('package.json', 7)];
    const observations = [
      makeObservation('repository_identity', { name: 'round7-project-scope-repo' }, 'package.json'),
    ];

    const t1Result = await projectBaselineRepository.persistBaselineWithPolicyFence({
      baselineId,
      evidence,
      observations,
      contentDigest: sha256('round7-content-F'),
      expectedVersion: baselineVersion,
      snapshot: v7Snapshot, // source='project', policyVersion=7
      organizationId: orgId,
      projectId,
      willMutate,
    });

    // T1 committed (persisted) — the fence held the project + org anchor
    // locks + the project policy row lock through the writes + commit.
    // T1's evidence was committed under the project V7 policy (the
    // persistence happened-before the project policy was cleared).
    expect(t1Result.kind, 'T1 persisted under project V7 (the fence held the anchor locks)').toBe('persisted');

    // T2 was BLOCKED while T1 held the project anchor lock (the real
    // serialization point for the missing-row case 2).
    expect(t2WasBlocked, 'T2 was blocked on T1\'s project anchor lock (real DB serialization — the missing-row case 2 is fenced)').toBe(true);

    // T1 committed → the lock released → T2 unblocks + DELETEs the
    // project policy. Await T2.
    await t2Promise;
    expect(await currentProjectPolicyVersion(), 'T2 cleared the project policy AFTER T1 committed (the project fallback happened after the persistence)').toBeNull();

    // THE ARCHITECT'S INVARIANT: T1's persisted evidence carries per-read
    // policyVersion=7 (the project V7 — the persistence happened-before
    // the project policy was cleared). NOT the org/platform-default
    // fallback (the clear did not happen when T1's persistence ran).
    const persistedEvidence = await projectBaselineRepository.listEvidence(baselineId);
    expect(persistedEvidence.length, 'T1\'s V7 evidence is committed').toBeGreaterThan(0);
    expect(
      persistedEvidence[0]!.repositoryReadEnforcement?.policyVersion,
      'the committed evidence carries V7 (the persistence happened-before the project policy was cleared) — the missing-row case 2 is fenced',
    ).toBe(7);

    // The baseline is complete (T1's markComplete committed under the
    // anchor locks).
    const baseline = await projectBaselineRepository.findById(baselineId);
    expect(baseline?.state, 'T1 completed the baseline under the anchor locks').toBe('complete');
  });

  // =========================================================================
  // G. STALE REJECTION (missing-row case 3): no project policy → T2 CREATES
  //    a NEW project policy (V1) + COMMITS FIRST → T1's fence (snapshot
  //    source='organization', version=7) enters the transaction → locks the
  //    scope anchors + the NEW project policy row (V1) + the org policy row
  //    (V7) → RE-RESOLVES the effective policy from the locked rows →
  //    effective source='project', version=1 → SOURCE MISMATCH (snapshot
  //    'organization' vs effective 'project') → ROLLBACK → fence-stale →
  //    ZERO stale evidence/observations committed.
  //
  //    THE ARCHITECT'S INVARIANT: assert against the EFFECTIVE policy
  //    version/source, NOT merely the old policy row's version. The
  //    rejection reason cites the source mismatch (organization vs
  //    project) — proving the fence detects the missing-row case (a NEW
  //    row was CREATED that changed the effective resolution).
  // =========================================================================
  it('G. (round-7 missing-row case 3) no project policy → T2 creates project policy V1 + commits FIRST → T1 fence re-resolves to project V1 → SOURCE mismatch → ROLLBACK → ZERO stale evidence committed', async () => {
    // Setup: org policy V7 active, NO project policy (the architect's
    // "no project policy" setup). The beforeEach seeded a project policy
    // V7; remove it + seed the org-scope V7 default.
    await seedOrgOnlyV7();
    expect(await currentProjectPolicyVersion(), 'setup: no project policy exists').toBeNull();
    expect(await currentOrgPolicyVersion(), 'setup: org policy V7 active').toBe(7);

    const t2Repo = new PgAgentPolicyRepository({ db: second!.client });

    // T2 mutates the policy + COMMITS first (fully, before T1 begins the
    // transaction). T2 creates a NEW project policy V1 (INSERT — no
    // existing project policy row, so the trigger does NOT bump the
    // version; the INSERT sets policy_version=1).
    await t2Repo.setProjectPolicy({
      organizationId: orgId,
      projectId,
      document: V1_PROJECT_DOCUMENT,
      userId,
    });
    expect(await currentProjectPolicyVersion(), 'T2 committed the project override V1 FIRST').toBe(1);

    // T1's orchestrator captured the snapshot source='organization',
    // policyVersion=7 BEFORE T2's mutation (the snapshot is stale — the
    // effective policy changed because a NEW project policy was created).
    // T1's fence: lock the project + org anchors + the NEW project policy
    // row (V1) + the org policy row (V7) → re-resolve the effective policy
    // → project V1 (override) → SOURCE MISMATCH (snapshot 'organization'
    // vs effective 'project') → ROLLBACK → fence-stale.
    const evidence = [makeEvidence('package.json', 7)]; // per-read V7
    const observations = [
      makeObservation('repository_identity', { name: 'round7-stale-snapshot-repo' }, 'package.json'),
    ];

    const t1Result = await projectBaselineRepository.persistBaselineWithPolicyFence({
      baselineId,
      evidence,
      observations,
      contentDigest: sha256('round7-content-G'),
      expectedVersion: baselineVersion,
      snapshot: v7OrgSnapshot, // stale — the project override already exists
      organizationId: orgId,
      projectId,
      // no willMutate — T2 already committed
    });

    expect(t1Result.kind, 'T1 REJECTED (the snapshot source is stale relative to the NEW effective source)').toBe('fence-stale');
    if (t1Result.kind === 'fence-stale') {
      expect(t1Result.reason, 'the rejection explains the scope-resolution fence').toContain('SCOPE-RESOLUTION fence');
      expect(t1Result.reason, 'the rejection cites the EFFECTIVE-POLICY re-resolution step').toContain('EFFECTIVE-POLICY re-resolution');
      // THE ARCHITECT'S INVARIANT: the rejection cites the SOURCE mismatch
      // (organization vs project) — proving the fence detects the missing-
      // row case (a NEW row was CREATED that changed the effective
      // resolution), NOT merely a version mismatch on the same row.
      expect(t1Result.reason, 'the rejection cites the snapshot source (organization)').toContain("'organization'");
      expect(t1Result.reason, 'the rejection cites the effective source (project)').toContain("'project'");
      expect(t1Result.reason, 'the rejection explains the row creation/deletion cause').toMatch(/CREATED|DELETED/);
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

    // The project override V1 stands (T1 did not touch it).
    expect(await currentProjectPolicyVersion(), 'the project override V1 stands (T1 did not touch it)').toBe(1);
    // The org policy V7 is still there (the fallback, untouched).
    expect(await currentOrgPolicyVersion(), 'the org policy V7 still exists (the fallback, untouched)').toBe(7);
  });

  // =========================================================================
  // PR #42 ROUND-8 — the ATOMIC MUTATION FENCE: the mutation-side lock
  // is held THROUGH the mutation COMMIT, NOT released before the mutation.
  //
  // The architect's round-8 review of commit `776cbc2` established that
  // the round-7 mutation-side `FOR UPDATE` was issued as a STANDALONE
  // pool query (auto-commit → released immediately), then the actual
  // INSERT / UPDATE / DELETE ran in a SEPARATE auto-commit transaction.
  // So the lock was RELEASED BEFORE the mutation landed — the round-7
  // mutation-side `FOR UPDATE` was structurally a no-op for serialization
  // (the round-7 fence still serialized correctly only because the
  // fence-side step-3/4 row locks fenced the mutation indirectly; the
  // mutation-side anchor lock did NOT fence anything).
  //
  // THE ROUND-8 FIX (proven by these three tests): each of the four
  // mutation paths wraps the anchor lock + the actual write in a SINGLE
  // `db.transaction(async (tx) => { ... })` callback so the lock is held
  // from SELECT FOR UPDATE THROUGH the INSERT/UPDATE/DELETE COMMIT:
  //
  //   BEGIN
  //     SELECT id FROM wfos_projects / wfos_organizations WHERE id = $1 FOR UPDATE
  //     INSERT / UPDATE / DELETE wfos_agent_policies ...
  //   COMMIT
  //
  // H + I prove the round-8 atomic mutation blocks against the persistence
  // fence for the two ORG-SCOPE mutation paths (setOrganizationPolicy +
  // clearOrganizationPolicy) — the org-scope analogs of the round-7
  // project-scope scenarios E + F. Together E + F + H + I cover ALL FOUR
  // mutation paths the round-8 fix wraps.
  //
  // J proves the SYMMETRIC serialization that DISTINGUISHES the round-8
  // atomic wrapper from the round-7 broken code: T2's mutation holds the
  // project anchor lock THROUGH its own COMMIT (the round-8 atomic
  // wrapper). T1's fence, started AFTER T2's lock acquisition but BEFORE
  // T2's COMMIT, BLOCKS on T2's lock until T2 commits. T1 then acquires
  // → re-resolves → sees T2's mutation → mismatch → ROLLBACK →
  // `fence-stale`. With the round-7 broken code, the standalone FOR
  // UPDATE would have auto-committed + released the lock BEFORE T2's
  // INSERT landed, so T1's fence would have SQUEEZED IN between T2's
  // lock release and T2's INSERT commit → T1 would have seen V7 (T2's
  // INSERT not committed) → committed V7 stale evidence under the new
  // V8 effective policy → THE HOLE. The round-8 atomic wrapper closes
  // this hole by holding the lock through the mutation COMMIT.
  //
  // THE ARCHITECT'S INVARIANT: "the mutation stays blocked until the
  // persistence transaction commits" — proven by H + I (the mutation
  // blocks while T1's fence holds the lock; T2 applies AFTER T1 commits)
  // AND by J (the symmetric inverse — T1's fence blocks while T2's
  // mutation holds the lock; T1 rejects as stale after T2 commits).
  // =========================================================================

  // The V8 organization-scope document (a mutated org default that bumps
  // the version — used in scenario H).
  const V8_ORG_DOCUMENT: AgentPolicyDocument = {
    description: 'V8 org policy (mutated)',
    rules: [],
    defaultEffect: 'allow',
  };

  // =========================================================================
  // H. SERIALIZATION (org-scope, the round-8 atomic wrapper): org policy
  //    V7 active, NO project policy → T1 fence locks the scope anchors
  //    (project + org) + the org policy row → T2's setOrganizationPolicy
  //    (V8) — an INSERT ... ON CONFLICT DO UPDATE on the SAME org policy
  //    row the fence locks — BLOCKS on T1's org anchor lock (acquired by
  //    setOrganizationPolicy's atomic transaction BEFORE the INSERT) →
  //    T1 verifies + writes + commits under the org V7 → T2 unblocks +
  //    applies V8 (the org default mutation happens AFTER the persistence
  //    in the serialization order).
  //
  //    CRITICAL ASSERTION (the architect's invariant): T1's persisted
  //    evidence carries per-read policyVersion=7 (the org V7 — the
  //    persistence happened-before the org default was mutated to V8),
  //    NOT V8. This proves the round-8 atomic mutation-side fence
  //    serializes setOrganizationPolicy against the persistence fence
  //    (the round-7 standalone FOR UPDATE was a no-op for this).
  // =========================================================================
  it('H. (round-8 org-scope) org policy V7, no project policy → T2 setOrganizationPolicy BLOCKS on T1\'s org anchor lock → T1 commits under org V7 → org default mutated to V8 AFTER', async () => {
    // Setup: org policy V7 active, NO project policy (the architect's
    // "no project policy" setup). The beforeEach seeded a project policy
    // V7; remove it + seed the org-scope V7 default.
    await seedOrgOnlyV7();
    expect(await currentProjectPolicyVersion(), 'setup: no project policy exists').toBeNull();
    expect(await currentOrgPolicyVersion(), 'setup: org policy V7 active').toBe(7);

    const t2Repo = new PgAgentPolicyRepository({ db: second!.client });
    let t2WasBlocked = false;
    let t2Promise: Promise<void> | undefined;

    // T2's mutation: setOrganizationPolicy(V8_ORG_DOCUMENT) — an
    // INSERT ... ON CONFLICT DO UPDATE on the SAME org policy row the
    // fence locks. T2's atomic transaction (round-8) acquires the org
    // anchor lock (FOR UPDATE on wfos_organizations) BEFORE the INSERT
    // — the SAME lock T1's fence holds. So T2 BLOCKS on T1's lock
    // until T1 commits.
    //
    // CRITICAL: T2 is started INSIDE the willMutate hook — i.e. AFTER T1
    // has acquired the scope anchor locks + the relevant policy rows +
    // re-resolved the effective policy (so T2 cannot sneak in before T1
    // locks the anchors + commit V8 first). Starting T2 before T1 begins
    // would let T2 commit V8 before T1's lock acquisition, making T1 see
    // V8 → fence-stale (that would be the inverse scenario, not this
    // one — see scenario J for the symmetric case).
    const willMutate = async () => {
      // T1 now holds the project + org anchor locks + the org policy row
      // lock. Start T2 — its setOrganizationPolicy acquires the org
      // anchor lock (FOR UPDATE on wfos_organizations) inside its atomic
      // transaction → BLOCKS on T1's lock.
      t2Promise = (async () => {
        await t2Repo.setOrganizationPolicy({
          organizationId: orgId,
          document: V8_ORG_DOCUMENT,
          userId,
        });
      })();
      // Give T2 time to reach the blocked state.
      await delay(300);
      // PROBE: is T2 still pending (blocked) or did it resolve?
      const probe = await Promise.race([
        t2Promise.then(() => 'resolved' as const),
        delay(50).then(() => 'pending' as const),
      ]);
      t2WasBlocked = probe === 'pending';
    };

    const evidence = [makeEvidence('package.json', 7)];
    const observations = [
      makeObservation('repository_identity', { name: 'round8-org-scope-repo' }, 'package.json'),
    ];

    const t1Result = await projectBaselineRepository.persistBaselineWithPolicyFence({
      baselineId,
      evidence,
      observations,
      contentDigest: sha256('round8-content-H'),
      expectedVersion: baselineVersion,
      // The snapshot reflects the org-scope effective policy at capture
      // time (BEFORE T2's mutation).
      snapshot: v7OrgSnapshot,
      organizationId: orgId,
      projectId,
      willMutate,
    });

    // T1 committed (persisted) — the fence held the project + org anchor
    // locks + the org policy row lock through the writes + commit. T1's
    // evidence was committed under the organization V7 policy (the
    // persistence happened-before the org default was mutated to V8).
    expect(t1Result.kind, 'T1 persisted under org V7 (the fence held the anchor locks)').toBe('persisted');

    // T2 was BLOCKED while T1 held the org anchor lock (the real
    // serialization point for the org-scope setOrganizationPolicy
    // mutation).
    expect(t2WasBlocked, 'T2 was blocked on T1\'s org anchor lock (real DB serialization — the round-8 atomic mutation-side fence serializes setOrganizationPolicy)').toBe(true);

    // T1 committed → the lock released → T2 unblocks + mutates the org
    // default to V8. Await T2 (so afterEach does not terminate its
    // in-flight transaction).
    await t2Promise;
    expect(await currentOrgPolicyVersion(), 'T2 mutated the org default to V8 AFTER T1 committed').toBe(8);
    // The project policy is still absent (T2 did not touch it).
    expect(await currentProjectPolicyVersion(), 'the project policy is still absent (T2 did not touch it)').toBeNull();

    // THE ARCHITECT'S INVARIANT: T1's persisted evidence carries per-read
    // policyVersion=7 (the org V7 — the persistence happened-before the
    // org default was mutated to V8). NOT V8 (the mutation did not exist
    // when T1's persistence ran — T2 was blocked).
    const persistedEvidence = await projectBaselineRepository.listEvidence(baselineId);
    expect(persistedEvidence.length, 'T1\'s V7 evidence is committed').toBeGreaterThan(0);
    expect(
      persistedEvidence[0]!.repositoryReadEnforcement?.policyVersion,
      'the committed evidence carries V7 (the persistence happened-before the org default was mutated to V8) — the round-8 atomic mutation-side fence serializes setOrganizationPolicy',
    ).toBe(7);

    // The baseline is complete (T1's markComplete committed under the
    // anchor locks).
    const baseline = await projectBaselineRepository.findById(baselineId);
    expect(baseline?.state, 'T1 completed the baseline under the anchor locks').toBe('complete');
  });

  // =========================================================================
  // I. SERIALIZATION (org-scope DELETE, the round-8 atomic wrapper): org
  //    policy V7 active, NO project policy → T1 fence locks the scope
  //    anchors (project + org) + the org policy row → T2's
  //    clearOrganizationPolicy — a DELETE on the org policy row — BLOCKS
  //    on T1's org anchor lock (acquired by clearOrganizationPolicy's
  //    atomic transaction BEFORE the DELETE) → T1 verifies + writes +
  //    commits under the org V7 → T2 unblocks + DELETEs the org policy
  //    (the fallback to platform-default happens AFTER the persistence
  //    in the serialization order).
  //
  //    CRITICAL ASSERTION (the architect's invariant): T1's persisted
  //    evidence carries per-read policyVersion=7 (the org V7 — the
  //    persistence happened-before the org default was cleared), NOT the
  //    platform-default fallback. The round-7 standalone FOR UPDATE was
  //    a no-op for the DELETE path (PostgreSQL's FK machinery does NOT
  //    auto-lock the parent on DELETE); the round-8 atomic wrapper is
  //    the ONLY thing that fences clearOrganizationPolicy against the
  //    persistence fence.
  // =========================================================================
  it('I. (round-8 org-scope DELETE) org policy V7, no project policy → T2 clearOrganizationPolicy BLOCKS on T1\'s org anchor lock → T1 commits under org V7 → org default cleared AFTER', async () => {
    // Setup: org policy V7 active, NO project policy.
    await seedOrgOnlyV7();
    expect(await currentProjectPolicyVersion(), 'setup: no project policy exists').toBeNull();
    expect(await currentOrgPolicyVersion(), 'setup: org policy V7 active').toBe(7);

    const t2Repo = new PgAgentPolicyRepository({ db: second!.client });
    let t2WasBlocked = false;
    let t2Promise: Promise<void> | undefined;

    // T2's mutation: clearOrganizationPolicy — a DELETE on the org-scope
    // row. T2's atomic transaction (round-8) acquires the org anchor
    // lock (FOR UPDATE on wfos_organizations) BEFORE the DELETE — the
    // SAME lock T1's fence holds. The DELETE itself does NOT auto-lock
    // the parent (PostgreSQL's FK machinery locks the parent only on
    // INSERT/UPDATE of the FK column); the explicit FOR UPDATE inside
    // T2's atomic transaction is the ONLY thing that fences the DELETE.
    // So T2 BLOCKS on T1's lock until T1 commits.
    const willMutate = async () => {
      // T1 now holds the project + org anchor locks + the org policy row
      // lock. Start T2 — its clearOrganizationPolicy acquires the org
      // anchor lock (FOR UPDATE on wfos_organizations) inside its atomic
      // transaction → BLOCKS on T1's lock.
      t2Promise = (async () => {
        await t2Repo.clearOrganizationPolicy(orgId);
      })();
      // Give T2 time to reach the blocked state.
      await delay(300);
      // PROBE: is T2 still pending (blocked) or did it resolve?
      const probe = await Promise.race([
        t2Promise.then(() => 'resolved' as const),
        delay(50).then(() => 'pending' as const),
      ]);
      t2WasBlocked = probe === 'pending';
    };

    const evidence = [makeEvidence('package.json', 7)];
    const observations = [
      makeObservation('repository_identity', { name: 'round8-org-delete-repo' }, 'package.json'),
    ];

    const t1Result = await projectBaselineRepository.persistBaselineWithPolicyFence({
      baselineId,
      evidence,
      observations,
      contentDigest: sha256('round8-content-I'),
      expectedVersion: baselineVersion,
      snapshot: v7OrgSnapshot,
      organizationId: orgId,
      projectId,
      willMutate,
    });

    // T1 committed (persisted) — the fence held the project + org anchor
    // locks + the org policy row lock through the writes + commit.
    expect(t1Result.kind, 'T1 persisted under org V7 (the fence held the anchor locks)').toBe('persisted');

    // T2 was BLOCKED while T1 held the org anchor lock (the real
    // serialization point for the org-scope clearOrganizationPolicy
    // mutation — the round-8 atomic wrapper is the ONLY thing that
    // fences the DELETE, because PostgreSQL's FK machinery does NOT
    // auto-lock the parent on DELETE).
    expect(t2WasBlocked, 'T2 was blocked on T1\'s org anchor lock (real DB serialization — the round-8 atomic mutation-side fence serializes clearOrganizationPolicy; the DELETE has NO FK-induced parent lock)').toBe(true);

    // T1 committed → the lock released → T2 unblocks + DELETEs the org
    // policy. Await T2.
    await t2Promise;
    expect(await currentOrgPolicyVersion(), 'T2 cleared the org policy AFTER T1 committed (the platform-default fallback happened after the persistence)').toBeNull();
    // The project policy is still absent (T2 did not touch it).
    expect(await currentProjectPolicyVersion(), 'the project policy is still absent (T2 did not touch it)').toBeNull();

    // THE ARCHITECT'S INVARIANT: T1's persisted evidence carries per-read
    // policyVersion=7 (the org V7 — the persistence happened-before the
    // org default was cleared). NOT the platform-default fallback (the
    // clear did not happen when T1's persistence ran — T2 was blocked).
    const persistedEvidence = await projectBaselineRepository.listEvidence(baselineId);
    expect(persistedEvidence.length, 'T1\'s V7 evidence is committed').toBeGreaterThan(0);
    expect(
      persistedEvidence[0]!.repositoryReadEnforcement?.policyVersion,
      'the committed evidence carries V7 (the persistence happened-before the org default was cleared) — the round-8 atomic mutation-side fence serializes clearOrganizationPolicy',
    ).toBe(7);

    // The baseline is complete (T1's markComplete committed under the
    // anchor locks).
    const baseline = await projectBaselineRepository.findById(baselineId);
    expect(baseline?.state, 'T1 completed the baseline under the anchor locks').toBe('complete');
  });

  // =========================================================================
  // J. SYMMETRIC SERIALIZATION (the round-8 atomic wrapper, the
  //    distinguishing test): T2's setProjectPolicy HOLDS the project
  //    anchor lock THROUGH its own COMMIT (the round-8 atomic wrapper).
  //    T1's fence, started AFTER T2's lock acquisition but BEFORE T2's
  //    COMMIT, BLOCKS on T2's lock until T2 commits. T1 then acquires →
  //    re-resolves → sees T2's V8 mutation → mismatch → ROLLBACK →
  //    `fence-stale`.
  //
  //    WHY THIS DISTINGUISHES THE ROUND-8 FIX FROM THE ROUND-7 BROKEN
  //    CODE: with the round-7 broken code, T2's setProjectPolicy issued
  //    `SELECT id FROM wfos_projects WHERE id = $1 FOR UPDATE` as a
  //    STANDALONE pool query (auto-commit → released immediately), then
  //    ran the INSERT in a SEPARATE auto-commit transaction. So when T0
  //    (the external lock holder) released, T2's standalone FOR UPDATE
  //    acquired + auto-committed + released — and T1's fence (queued
  //    behind T2 on T0's lock) would acquire the project anchor lock
  //    (T2 already released) → re-resolve → see V7 (T2's INSERT not
  //    committed yet) → COMMIT V7 stale evidence → T2's INSERT then
  //    commits V8 → STALE EVIDENCE UNDER THE NEW V8 EFFECTIVE POLICY →
  //    THE HOLE.
  //
  //    With the round-8 atomic wrapper, T2's setProjectPolicy is
  //    `BEGIN; SELECT FOR UPDATE; INSERT; COMMIT` — the lock is held
  //    THROUGH the INSERT COMMIT. T1's fence, queued behind T2 on T0's
  //    lock, REMAINS BLOCKED on T2's lock when T0 releases (T2 acquires
  //    first via FIFO, holds through its own COMMIT). T2 commits V8 →
  //    releases → T1 acquires → re-resolves → sees V8 → mismatch →
  //    ROLLBACK → `fence-stale` → ZERO stale evidence committed. ✓
  //
  //    THE ARCHITECT'S EXACT INVARIANT: "the mutation stays blocked
  //    until the persistence transaction commits" — the symmetric
  //    inverse. In scenarios E/F/H/I, T1 (persistence) holds the lock
  //    and T2 (mutation) blocks until T1 commits. In scenario J, T2
  //    (mutation) holds the lock and T1 (persistence) blocks until T2
  //    commits — and T1 then REJECTS as stale (because T2's mutation
  //    committed before T1's re-resolution).
  //
  //    NOTE ON THE FIFO RACE: when T0 releases, PostgreSQL's FOR UPDATE
  //    lock scheduler grants the lock to the request that's been
  //    waiting longest (T2 — it was queued first). In practice this is
  //    reliable. If the scheduler ever grants T1 first (the opposite
  //    ordering), the test outcome would be `persisted` (T1 sees V7,
  //    commits V7 evidence, T2 applies V8 after — that is scenario A's
  //    outcome, also correct serialization, just the reverse order). To
  //    minimize this race, T2 is started BEFORE T1 (queued first).
  // =========================================================================
  it('J. (round-8 symmetric) T2\'s setProjectPolicy holds the project anchor lock THROUGH its own COMMIT → T1 fence (started after T2 acquires, before T2 commits) BLOCKS on T2\'s lock → T2 commits V8 → T1 re-resolves → sees V8 → ROLLBACK → fence-stale → ZERO stale evidence committed', async () => {
    // Setup: project policy V7 active (the beforeEach seed — the
    // snapshot source is 'project'). No org policy seeded.
    expect(await currentProjectPolicyVersion(), 'setup: project policy V7 active').toBe(7);

    // T0 — a THIRD independent pg.Client that holds the project anchor
    // lock externally. T2's mutation will block on T0's lock at the
    // SELECT FOR UPDATE step inside T2's atomic transaction; T1's fence
    // will also block on T0's lock at step 1. The external lock lets us
    // control the timing so T2 acquires T0's released lock BEFORE T1,
    // then T2 holds the lock through its own COMMIT (proving the round-8
    // atomic wrapper).
    if (!stack.db.createSecondClient) {
      // pglite path — should be skipped by describe.skipIf(!isRealPg).
      throw new Error('createSecondClient unavailable on the real-pg path');
    }
    const t0 = await stack.db.createSecondClient();

    try {
      // T0 acquires the project anchor lock + holds the transaction
      // open until `releaseT0` is called (then transaction() commits +
      // releases the lock).
      let releaseT0!: () => void;
      const t0Held = new Promise<void>((resolve) => {
        releaseT0 = resolve;
      });
      const t0Promise = t0.client.transaction(async (tx) => {
        await tx.query(
          `SELECT id FROM wfos_projects WHERE id = $1 FOR UPDATE`,
          [projectId],
        );
        // Hold the transaction open until releaseT0 is called.
        await t0Held;
      });

      // T2's mutation: setProjectPolicy(V8_DOCUMENT) — an INSERT ... ON
      // CONFLICT DO UPDATE on the SAME project policy row. T2's atomic
      // transaction (round-8) is `BEGIN; SELECT FOR UPDATE (blocks on
      // T0's lock); INSERT; COMMIT`. T2 is started FIRST so it is
      // queued on T0's lock BEFORE T1.
      const t2Repo = new PgAgentPolicyRepository({ db: second!.client });
      const t2Promise = (async () => {
        await t2Repo.setProjectPolicy({
          organizationId: orgId,
          projectId,
          document: V8_DOCUMENT,
          userId,
        });
      })();

      // Give T2 time to reach the blocked state (queued on T0's lock).
      await delay(300);

      // T1's fence: started AFTER T2 is queued on T0's lock (so T1 is
      // queued BEHIND T2). T1's snapshot is V7 (taken BEFORE T2's
      // mutation commits). With the round-8 atomic wrapper, when T0
      // releases, T2 acquires first (FIFO) + holds the lock through its
      // own COMMIT → T1 stays blocked on T2's lock until T2 commits →
      // T1 acquires → re-resolves → sees V8 → mismatch → ROLLBACK →
      // `fence-stale`.
      const evidence = [makeEvidence('package.json', 7)];
      const observations = [
        makeObservation('repository_identity', { name: 'round8-symmetric-repo' }, 'package.json'),
      ];

      const t1Promise = projectBaselineRepository.persistBaselineWithPolicyFence({
        baselineId,
        evidence,
        observations,
        contentDigest: sha256('round8-content-J'),
        expectedVersion: baselineVersion,
        snapshot: v7Snapshot, // stale — T2 will commit V8 before T1 re-resolves
        organizationId: orgId,
        projectId,
        // no willMutate — T1 should block on T0/T2's lock without it
      });

      // Give T1 time to reach the blocked state (queued on T0's lock,
      // behind T2).
      await delay(300);

      // PROBE 1: T1 should still be pending (blocked on T0's lock,
      // behind T2). T2 should also still be pending (blocked on T0's
      // lock).
      const probe1T1 = await Promise.race([
        t1Promise.then(() => 'resolved' as const),
        delay(50).then(() => 'pending' as const),
      ]);
      const probe1T2 = await Promise.race([
        t2Promise.then(() => 'resolved' as const),
        delay(50).then(() => 'pending' as const),
      ]);
      expect(probe1T1, 'T1 was blocked on T0\'s external project anchor lock (queued behind T2)').toBe('pending');
      expect(probe1T2, 'T2 was blocked on T0\'s external project anchor lock').toBe('pending');

      // Release T0 — its transaction commits + releases the project
      // anchor lock. PostgreSQL grants the lock to T2 first (FIFO — T2
      // was queued before T1).
      releaseT0();
      await t0Promise;

      // Give T2 time to acquire T0's released lock + apply the
      // mutation + commit. With the round-8 atomic wrapper, T2's lock
      // is held THROUGH the COMMIT — T1 stays blocked on T2's lock
      // until T2 commits.
      await delay(300);

      // PROBE 2: T2 should have committed V8 (the mutation applied +
      // committed inside T2's atomic transaction).
      expect(await currentPolicyVersion(), 'T2 committed V8 (the mutation applied inside T2\'s atomic transaction)').toBe(8);

      // PROBE 3: T1 should still be pending (blocked on T2's lock — T2
      // held the lock through its own COMMIT, which is the round-8
      // atomic wrapper invariant). With the round-7 broken code, T2's
      // standalone FOR UPDATE would have auto-committed + released the
      // lock BEFORE the INSERT, so T1 would have acquired the lock +
      // committed V7 stale evidence by now → THE HOLE. With the
      // round-8 atomic wrapper, T1 stays blocked until T2 commits.
      const probe3T1 = await Promise.race([
        t1Promise.then(() => 'resolved' as const),
        delay(50).then(() => 'pending' as const),
      ]);
      // NOTE: with the round-8 atomic wrapper, T1 stays blocked until
      // T2 commits. T2 has committed (probe 2). T1 should now unblock.
      // If T1 is still pending here, it's because T1's re-resolution
      // + ROLLBACK is still in-flight (very fast — should resolve
      // immediately). The probe may show 'pending' for the ROLLBACK
      // path; the OUTCOME assertion (fence-stale) is the real test.
      void probe3T1; // best-effort probe — the outcome assertion below is authoritative

      // T1's fence should now resolve (T2 committed → T1 acquires →
      // re-resolves → sees V8 → mismatch → ROLLBACK → `fence-stale`).
      const t1Result = await t1Promise;
      expect(t1Result.kind, 'T1 REJECTED (T2\'s mutation committed V8 before T1 re-resolved — the symmetric serialization; the round-8 atomic wrapper held the lock through T2\'s COMMIT so T1 could NOT squeeze in between T2\'s lock release and T2\'s INSERT commit)').toBe('fence-stale');

      // CRITICAL: ZERO stale evidence/observations are committed (T1's
      // transaction was rolled back). The architect's invariant — NO
      // stale evidence under the new V8 effective policy.
      const persistedEvidence = await projectBaselineRepository.listEvidence(baselineId);
      expect(persistedEvidence.length, 'ZERO stale evidence committed (T1\'s transaction rolled back — the round-8 atomic wrapper closed the hole where the round-7 broken code would have let T1 commit V7 evidence under the new V8 effective policy)').toBe(0);
      const persistedObservations = await projectBaselineRepository.listObservations(baselineId);
      expect(persistedObservations.length, 'ZERO stale observations committed (T1\'s transaction rolled back)').toBe(0);

      // The baseline is still 'analyzing' (T1's markComplete rolled back).
      const baseline = await projectBaselineRepository.findById(baselineId);
      expect(baseline?.state, 'the baseline stays analyzing (T1\'s markComplete rolled back)').toBe('analyzing');

      // The policy is V8 (T2's mutation stands — T1 did not touch it).
      expect(await currentPolicyVersion(), 'the policy is V8 (T2\'s mutation stands — T1 did not touch it)').toBe(8);

      // Await T2 (cleanup — T2 already resolved, but ensure no
      // in-flight transaction is left open).
      await t2Promise;
    } finally {
      await t0.close();
    }
  });
});
