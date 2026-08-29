import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';

/**
 * WORK-046 architectural concurrency regression.
 *
 * The coordinator can legitimately hold a stale pending-unit snapshot while
 * another actor interrupts the plan. The durable-intent boundary must reject
 * an attempt allocation after the plan has committed active -> abandoned,
 * while still allowing an allocation that committed before the interruption
 * to remain in-flight and untouched.
 *
 * This test deliberately runs the allocation and interruption on TWO
 * independent PostgreSQL connections. It skips under pglite because pglite
 * cannot demonstrate the required cross-connection blocking/visibility
 * semantics.
 */
describe('WORK-046 — interruption/dispatch race guard', () => {
  let stack: TestAuthStack;
  let planId: string;
  let unitId: string;

  beforeAll(async () => {
    stack = await buildAuthStack({});

    const org = await stack.organizationRepository.create({ name: 'Delegation Race Org' });
    const user = await stack.userRepository.upsertByExternalId({
      externalId: `delegation-race-${randomUUID()}`,
      displayName: 'U',
    });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    const project = await stack.projectRepository.create({ organizationId: org.id, name: 'Delegation Race Project' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Arch-Race' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id,
      workItemId: `WI-RACE-${randomUUID().slice(0, 8)}`,
      title: 'Interruption race guard',
      objective: 'Prove abandoned plans cannot allocate new attempts',
      scope: 'Database concurrency regression',
    });

    planId = randomUUID();
    unitId = randomUUID();
    await stack.db.client.query(
      `INSERT INTO wfos_delegation_plans (id, work_item_id, plan_key, status)
       VALUES ($1, $2, 'race', 'active')`,
      [planId, workItem.id],
    );
    await stack.db.client.query(
      `INSERT INTO wfos_delegation_units
         (id, plan_id, unit_key, role_id, role_revision, mode, provider, model, depends_on, status)
       VALUES ($1, $2, 'implement', 'implementer', 'race-revision', 'native', 'fake', 'fake-model', '[]'::jsonb, 'pending')`,
      [unitId, planId],
    );
  });

  afterAll(async () => {
    await stack.teardown();
  });

  it('rejects a stale dispatch after interruption, with no partial attempt or unit-state write', async () => {
    const second = stack.db.createSecondClient;
    if (!second) return;

    const t2 = await second();
    try {
      let allocationLocked!: () => void;
      const allocationHasLocked = new Promise<void>((resolve) => {
        allocationLocked = resolve;
      });
      let allowAllocationToInsert!: () => void;
      const allowInsert = new Promise<void>((resolve) => {
        allowAllocationToInsert = resolve;
      });

      // T1 mirrors the production durable-intent transaction: lock the unit,
      // see the plan as active, then pause while the interrupt races.
      const allocation = stack.db.client.transaction(async (tx) => {
        await tx.query(
          `SELECT id FROM wfos_delegation_units WHERE id = $1 FOR UPDATE`,
          [unitId],
        );
        const status = await tx.query<{ status: string }>(
          `SELECT status FROM wfos_delegation_plans WHERE id = $1`,
          [planId],
        );
        expect(status.rows[0]!.status).toBe('active');
        allocationLocked();
        await allowInsert;

        await tx.query(
          `UPDATE wfos_delegation_units
              SET status = 'dispatched', attempt_count = attempt_count + 1, updated_at = NOW()
            WHERE id = $1 AND status = 'pending'`,
          [unitId],
        );

        // This is the exact durable-intent insert guarded by the migration
        // trigger. After T2 commits the interruption, this statement MUST fail.
        await tx.query(
          `INSERT INTO wfos_delegation_attempts
             (unit_id, attempt_no, execution_id, mode, provider, model)
           VALUES ($1, 1, $2, 'native', 'fake', 'fake-model')`,
          [unitId, `wf_${randomUUID().replace(/-/g, '')}`],
        );
      });

      await allocationHasLocked;

      // T2 interrupts the plan on an independent connection. It does not
      // need the unit lock, exactly matching the production interrupt path.
      await t2.client.query(
        `UPDATE wfos_delegation_plans SET status = 'abandoned', updated_at = NOW()
          WHERE id = $1 AND status = 'active'`,
        [planId],
      );
      const interrupted = await stack.db.client.query<{ status: string }>(
        `SELECT status FROM wfos_delegation_plans WHERE id = $1`,
        [planId],
      );
      expect(interrupted.rows[0]!.status).toBe('abandoned');

      allowAllocationToInsert();

      await expect(allocation).rejects.toBeTruthy();

      const unit = await stack.db.client.query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM wfos_delegation_units WHERE id = $1`,
        [unitId],
      );
      expect(unit.rows[0]!).toEqual({ status: 'pending', attempt_count: 0 });

      const attempts = await stack.db.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM wfos_delegation_attempts WHERE unit_id = $1`,
        [unitId],
      );
      expect(attempts.rows[0]!.n).toBe(0);
    } finally {
      await t2.close();
    }
  });
});
