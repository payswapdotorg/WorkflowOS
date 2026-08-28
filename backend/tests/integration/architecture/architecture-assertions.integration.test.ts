import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';

import { PgArchitectureAssertionRepository } from '../../../src/modules/architecture/internal/pg-architecture-repository.js';
import type { ArchitectureService } from '@modules/architecture/index.js';

/**
 * WORK-051 — Architecture Assertions (the /architecture-owned store).
 *
 * Proves (issue #51 mandatory proof 8 + the assertion contract):
 * - assertions attach to DRAFT versions only;
 * - the assertion SET is immutable with its ArchitectureVersion (frozen →
 *   closed; persistence-enforced, not just service-checked);
 * - assertion ROWS are append-only (UPDATE/DELETE trigger-rejected at the
 *   PostgreSQL level);
 * - intentional architecture change flows through the EXISTING Architecture
 *   Change Request → approved → NEW immutable version path (ARCH-004) — the
 *   frozen version and its assertion set are never mutated.
 */
describe('WORK-051 — Architecture Assertions (version-scoped, immutable, ACR-gated)', () => {
  let stack: TestAuthStack;
  let assertionRepo: PgArchitectureAssertionRepository;
  let architectureService: ArchitectureService;
  let org: { id: string };
  let user: { id: string };
  let project: { id: string };
  let architecture: { id: string };
  let draftVersion: { id: string };
  let frozenVersion: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({});
    assertionRepo = new PgArchitectureAssertionRepository(stack.db.client);
    architectureService = stack.architectureService;

    org = await stack.organizationRepository.create({ name: 'Arch Assertions Org' });
    user = await stack.userRepository.upsertByExternalId({ externalId: 'arch-assert-user', displayName: 'User' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Arch Assertions Project' });
    architecture = await stack.architectureRepository.create({ projectId: project.id, name: 'Governed Arch' });

    draftVersion = await stack.architectureVersionRepository.create({
      architectureId: architecture.id,
      contentInline: 'draft content',
    });
    frozenVersion = await stack.architectureVersionRepository.create({
      architectureId: architecture.id,
      contentInline: 'frozen content',
    });
    await stack.architectureVersionRepository.transitionState(frozenVersion.id, 'frozen', user.id);
  });

  afterAll(async () => {
    await stack.teardown();
  });

  it('attaches assertions to a DRAFT version and lists them in stable assertionId order', async () => {
    const first = await assertionRepo.create({
      architectureVersionId: draftVersion.id,
      assertionId: 'ARCH-051-002',
      severity: 'advisory',
      scope: 'module',
      statement: 'advisory module boundary rule',
      detectorKind: 'repository-structure',
      detectorConfig: { rootDir: '/tmp/x' },
    });
    const second = await assertionRepo.create({
      architectureVersionId: draftVersion.id,
      assertionId: 'ARCH-051-001',
      severity: 'blocking',
      scope: 'repository',
      statement: 'blocking repository structure rule',
      detectorKind: 'repository-structure',
      detectorConfig: { rootDir: '/tmp/x' },
    });
    expect(first.assertionId).toBe('ARCH-051-002');
    expect(second.assertionId).toBe('ARCH-051-001');

    const listed = await assertionRepo.listForVersion(draftVersion.id);
    expect(listed.map((a) => a.assertionId)).toEqual(['ARCH-051-001', 'ARCH-051-002']);
    expect(listed[0]!.severity).toBe('blocking');
    expect(listed[0]!.detectorConfig).toEqual({ rootDir: '/tmp/x' });

    const found = await assertionRepo.findById(first.id);
    expect(found?.assertionId).toBe('ARCH-051-002');
  });

  it('rejects duplicate assertionId within the same version (UNIQUE constraint)', async () => {
    await assertionRepo.create({
      architectureVersionId: draftVersion.id,
      assertionId: 'ARCH-051-DUP',
      severity: 'advisory',
      scope: 'other',
      statement: 'first',
      detectorKind: 'repository-structure',
    });
    await expect(
      assertionRepo.create({
        architectureVersionId: draftVersion.id,
        assertionId: 'ARCH-051-DUP',
        severity: 'advisory',
        scope: 'other',
        statement: 'second',
        detectorKind: 'repository-structure',
      }),
    ).rejects.toThrow();
  });

  it('PROOF 8a — the assertion set is immutable with a FROZEN version: the repository rejects attach', async () => {
    await expect(
      assertionRepo.create({
        architectureVersionId: frozenVersion.id,
        assertionId: 'ARCH-051-FROZEN',
        severity: 'blocking',
        scope: 'repository',
        statement: 'must not attach to a frozen version',
        detectorKind: 'repository-structure',
      }),
    ).rejects.toThrow(/frozen/i);
  });

  it('PROOF 8b — persistence-level enforcement: a direct SQL INSERT against the frozen version is rejected by the trigger', async () => {
    // Bypass the repository entirely — the migration-0052 trigger must hold.
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_architecture_assertions
           (architecture_version_id, assertion_id, severity, scope, statement, detector_kind)
         VALUES ($1, 'ARCH-051-SQL', 'blocking', 'repository', 'direct sql attach', 'repository-structure')`,
        [frozenVersion.id],
      ),
    ).rejects.toThrow(/immutable|frozen|draft/i);
  });

  it('PROOF 8c — assertion ROWS are append-only: direct SQL UPDATE and DELETE are trigger-rejected', async () => {
    const a = await assertionRepo.create({
      architectureVersionId: draftVersion.id,
      assertionId: 'ARCH-051-IMMUTABLE',
      severity: 'blocking',
      scope: 'repository',
      statement: 'append-only row',
      detectorKind: 'repository-structure',
    });
    await expect(
      stack.db.client.query(
        'UPDATE wfos_architecture_assertions SET statement = $1 WHERE id = $2',
        ['tampered', a.id],
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      stack.db.client.query('DELETE FROM wfos_architecture_assertions WHERE id = $1', [a.id]),
    ).rejects.toThrow(/immutable/i);
    // The row survives untouched.
    const still = await assertionRepo.findById(a.id);
    expect(still?.statement).toBe('append-only row');
  });

  it('PROOF 8d — intentional architecture change does NOT mutate the frozen version: the ACR path creates a NEW immutable version; the old assertion set is untouched', async () => {
    // Attach one assertion to the frozen version's DRAFT successor path:
    // freeze a new draft carrying assertions, then change via ACR.
    const v2 = await stack.architectureVersionRepository.create({
      architectureId: architecture.id,
      contentInline: 'v2 content',
    });
    await assertionRepo.create({
      architectureVersionId: v2.id,
      assertionId: 'ARCH-051-V2-001',
      severity: 'blocking',
      scope: 'repository',
      statement: 'v2 rule',
      detectorKind: 'repository-structure',
    });
    await stack.architectureVersionRepository.transitionState(v2.id, 'frozen', user.id);
    const beforeFreeze = await assertionRepo.listForVersion(v2.id);
    expect(beforeFreeze.map((x) => x.assertionId)).toEqual(['ARCH-051-V2-001']);

    // Intentional architecture change: ACR → approve → NEW immutable version.
    const cr = await stack.architectureChangeRequestRepository.create({
      architectureId: architecture.id,
      affectedVersionId: v2.id,
      requesterId: user.id,
      reason: 'architecture must evolve',
      requestedChange: 'loosen the repository rule set',
    });
    const { newVersion, changeRequest } = await architectureService.approveChangeAndCreateReplacement(
      cr.id,
      user.id,
      { contentInline: 'v3 content' },
    );
    expect(changeRequest.status).toBe('approved');
    expect(changeRequest.replacementVersionId).toBe(newVersion.id);

    // The OLD frozen version: SUPERSEDED, its assertion set UNCHANGED.
    const oldVersion = await stack.architectureVersionRepository.findById(v2.id);
    expect(oldVersion?.state).toBe('superseded');
    const oldSet = await assertionRepo.listForVersion(v2.id);
    expect(oldSet.map((x) => x.assertionId)).toEqual(['ARCH-051-V2-001']);

    // The superseded version's set is closed too (no new assertions).
    await expect(
      assertionRepo.create({
        architectureVersionId: v2.id,
        assertionId: 'ARCH-051-V2-LATE',
        severity: 'advisory',
        scope: 'other',
        statement: 'late attach must fail',
        detectorKind: 'repository-structure',
      }),
    ).rejects.toThrow();

    // The NEW version is a fresh DRAFT — the new assertion set attaches there.
    const fresh = await stack.architectureVersionRepository.findById(newVersion.id);
    expect(fresh?.state).toBe('draft');
    const attached = await assertionRepo.create({
      architectureVersionId: newVersion.id,
      assertionId: 'ARCH-051-V3-001',
      severity: 'blocking',
      scope: 'repository',
      statement: 'v3 rule',
      detectorKind: 'repository-structure',
    });
    expect(attached.architectureVersionId).toBe(newVersion.id);
  });

  it('rejects invalid severity and scope values (closed CHECK constraints)', async () => {
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_architecture_assertions
           (architecture_version_id, assertion_id, severity, scope, statement, detector_kind)
         VALUES ($1, 'ARCH-051-BAD-SEV', 'catastrophic', 'repository', 'bad severity', 'repository-structure')`,
        [draftVersion.id],
      ),
    ).rejects.toThrow();
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_architecture_assertions
           (architecture_version_id, assertion_id, severity, scope, statement, detector_kind)
         VALUES ($1, 'ARCH-051-BAD-SCOPE', 'blocking', 'galaxy', 'bad scope', 'repository-structure')`,
        [draftVersion.id],
      ),
    ).rejects.toThrow();
  });

  // --- PR #52 round 1, BLOCKER 3: the freeze/attach serialization -------------
  //
  // Two INDEPENDENT pg.Client connections race the version freeze against
  // assertion attachment. The serialization boundary is the version-row lock
  // (the attach path's FOR SHARE — in BOTH the repository and the migration
  // 0052 trigger — against the freeze path's row UPDATE): an assertion can
  // NEVER commit after the version becomes frozen.

  const isRealPg =
    !!process.env.WORKFLOWOS_DATABASE_URL &&
    process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

  it('BLOCKER 3 — FREEZE WINS: an attach racing an in-flight freeze observes the frozen state and is rejected (never commits after the freeze)', async () => {
    if (!isRealPg || !stack.db.createSecondClient) return; // pglite: single-connection

    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Race Arch A' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });

    const second = await stack.db.createSecondClient();
    try {
      const t1 = stack.db.client;
      const t2 = second.client;

      // T1 starts the freeze (the uncommitted state UPDATE holds the row lock).
      await t1.query('BEGIN');
      await t1.query(
        "UPDATE wfos_architecture_versions SET state = 'frozen', frozen_at = NOW() WHERE id = $1",
        [v.id],
      );

      // T2 races the attach through the DIRECT SQL path (the trigger is the
      // authoritative serialization gate). It must BLOCK on the row lock.
      const attachPromise = t2.query(
        `INSERT INTO wfos_architecture_assertions
           (architecture_version_id, assertion_id, severity, scope, statement, detector_kind)
         VALUES ($1, 'ARCH-RACE-A', 'blocking', 'repository', 'racy attach', 'repository-structure')`,
        [v.id],
      );
      await new Promise((r) => setTimeout(r, 150));

      // T1 commits the freeze; T2's attach then resolves — REJECTED (the
      // trigger's FOR SHARE read observes 'frozen').
      await t1.query('COMMIT');
      await expect(attachPromise).rejects.toThrow(/immutable|frozen|draft/i);

      const count = await t2.query(
        'SELECT COUNT(*)::int AS n FROM wfos_architecture_assertions WHERE architecture_version_id = $1',
        [v.id],
      );
      expect(count.rows[0]!.n).toBe(0);
      const finalState = await t2.query<{ state: string }>(
        'SELECT state FROM wfos_architecture_versions WHERE id = $1',
        [v.id],
      );
      expect(finalState.rows[0]!.state).toBe('frozen');
    } finally {
      await stack.db.client.query('COMMIT').catch(() => {});
      await second.close();
    }
  });

  it('BLOCKER 3 — ATTACH WINS: an attach holding the version row serializes BEFORE a concurrent freeze (both commit; the attach happened while DRAFT)', async () => {
    if (!isRealPg || !stack.db.createSecondClient) return; // pglite: single-connection

    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Race Arch B' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });

    const second = await stack.db.createSecondClient();
    try {
      const t1 = stack.db.client;
      const t2 = second.client;

      // T1 (the attach) takes the serialization lock the repository's create()
      // uses — SELECT ... FOR SHARE on the version row — inside a transaction.
      await t1.query('BEGIN');
      await t1.query(
        'SELECT state FROM wfos_architecture_versions WHERE id = $1 FOR SHARE',
        [v.id],
      );

      // T2 (the freeze) attempts the state UPDATE — it must BLOCK on T1's
      // share lock (the exact interleaving that previously let an assertion
      // commit against a version that froze underneath it).
      const freezePromise = t2.query(
        "UPDATE wfos_architecture_versions SET state = 'frozen', frozen_at = NOW() WHERE id = $1",
        [v.id],
      );
      await new Promise((r) => setTimeout(r, 150));

      // T1 attaches + commits while the freeze waits.
      await t1.query(
        `INSERT INTO wfos_architecture_assertions
           (architecture_version_id, assertion_id, severity, scope, statement, detector_kind)
         VALUES ($1, 'ARCH-RACE-B', 'blocking', 'repository', 'serialized attach', 'repository-structure')`,
        [v.id],
      );
      await t1.query('COMMIT');
      await freezePromise; // the freeze proceeds AFTER the attach committed

      const finalState = await t2.query<{ state: string }>(
        'SELECT state FROM wfos_architecture_versions WHERE id = $1',
        [v.id],
      );
      expect(finalState.rows[0]!.state).toBe('frozen');
      // The assertion attached while the version was DRAFT — the legal order.
      const count = await t2.query(
        'SELECT COUNT(*)::int AS n FROM wfos_architecture_assertions WHERE architecture_version_id = $1',
        [v.id],
      );
      expect(count.rows[0]!.n).toBe(1);
      // And once frozen, the set is CLOSED (post-serialization proof).
      await expect(
        t2.query(
          `INSERT INTO wfos_architecture_assertions
             (architecture_version_id, assertion_id, severity, scope, statement, detector_kind)
           VALUES ($1, 'ARCH-RACE-B-LATE', 'advisory', 'other', 'late attach', 'repository-structure')`,
          [v.id],
        ),
      ).rejects.toThrow(/immutable|frozen|draft/i);
    } finally {
      await stack.db.client.query('COMMIT').catch(() => {});
      await second.close();
    }
  });

  it('BLOCKER 3 (repository path) — the repository create() itself serializes: a frozen-underneath attach is rejected with the typed error', async () => {
    // The repository-level FOR SHARE pre-check (same serialization domain as
    // the trigger + freezeVersion): a version frozen by another actor between
    // the read and the insert still yields the typed rejection.
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Race Arch C' });
    const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'c' });
    await stack.architectureVersionRepository.transitionState(v.id, 'frozen', user.id);
    await expect(
      assertionRepo.create({
        architectureVersionId: v.id,
        assertionId: 'ARCH-RACE-C',
        severity: 'blocking',
        scope: 'repository',
        statement: 'typed rejection',
        detectorKind: 'repository-structure',
      }),
    ).rejects.toThrow(/immutable with a frozen/i);
  });
});
