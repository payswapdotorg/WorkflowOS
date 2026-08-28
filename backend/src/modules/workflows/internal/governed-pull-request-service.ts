/**
 * WORK-051 round 2 (PR #52 review, BLOCKER 2) — the durable, crash-safe,
 * idempotent governed PR-creation protocol.
 *
 * The governed path is: checkpoint → CREATE PR (external GitHub mutation) →
 * record the association → PR_OPEN. The external mutation can NEVER be part
 * of a database transaction, so a process death between "GitHub created the
 * PR" and "the creation is durably recorded" would, on retry, invoke
 * createPullRequest AGAIN — a second PR for the same logical change.
 * WorkflowOS's convergence model explicitly assumes reprocessing after
 * failure/restart, so the protocol must make the EXTERNAL side effect
 * idempotent, not just the internal record.
 *
 * THE PROTOCOL (create-or-converge on a DURABLE identity):
 *
 *   key = (work_item_id, head_revision)   — the logical Work Item + the
 *   EXACT implementation revision the architecture checkpoint gated on.
 *   The key is durable (migration 0055, UNIQUE) and the head branch is a
 *   pure function of it (governedHeadBranch).
 *
 *   1. BEGIN; SELECT the intent row FOR UPDATE (lock-or-insert via
 *      INSERT ... ON CONFLICT DO NOTHING + re-lock) — concurrent callers
 *      with the same key SERIALIZE here.
 *   2. status = 'created' → COMMIT and return the RECORDED PR identity.
 *      ZERO external calls: the duplicate re-drive is a pure convergence.
 *   3. status = 'pending' (a previous attempt crashed mid-flight, or this
 *      transaction just inserted it):
 *      a. CONVERGENCE READ — findExistingPullRequest(key): the external
 *         authority may already hold the PR from the crashed attempt
 *         (identified by the deterministic head branch);
 *      b. found → CAS the intent to 'created' with that identity → same PR,
 *         NO create call (the crash-after-create interleaving converges);
 *      c. not found → CREATE through the port (the ONLY PR-creation
 *         capability), then record 'created' with the result IN THE SAME
 *         TRANSACTION.
 *   4. COMMIT. A crash at ANY point before commit rolls the whole intent
 *      back (or leaves it pending), and the retry re-runs the protocol —
 *      the create side effect is guarded by the convergence read, so the
 *      retry converges on the existing PR instead of creating a second one.
 *
 * Concurrency: the FOR UPDATE row lock serializes same-key callers — the
 * loser blocks until the winner commits, then observes 'created' and
 * returns the recorded identity with ZERO external calls of its own. The
 * unique constraint is the durable backstop for every interleaving.
 *
 * Authority: /workflows owns this ledger (it owns lifecycle transitions and
 * PR associations); /github remains the sole external PR authority (both the
 * create AND the convergence read flow through the PullRequestCreationPort
 * → GitHubAdapter); no second workflow or PR engine exists.
 */

import type { DatabaseClient } from '@platform/index.js';
import type { CreatedPullRequest, PullRequestCreationPort } from './convergence.types.js';

interface IntentRow {
  id: string;
  status: 'pending' | 'created';
  external_pr_id: string | null;
  head_commit: string | null;
}

export interface GovernedPullRequestInput {
  projectId: string;
  workItemId: string;
  /** The EXACT implementation revision the pr_conformance checkpoint gated on. */
  headRevision: string;
  title: string;
  body?: string | null;
}

export class GovernedPullRequestService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly port: PullRequestCreationPort,
  ) {}

  /**
   * Create-or-converge the governed PR for (workItemId, headRevision).
   * Idempotent + crash-safe: returns THE one PR for that key, creating it
   * at most once no matter how many times it is called (including across
   * process death between the external create and the durable record).
   */
  async open(input: GovernedPullRequestInput): Promise<CreatedPullRequest> {
    if (!input.workItemId || !input.headRevision) {
      throw new Error(
        'governed-pr-creation: workItemId and headRevision are required — the convergence key must be complete (fail closed)',
      );
    }
    return this.db.transaction(async (tx) => {
      // (1) Lock-or-insert the durable intent row — the convergence key.
      const intent = await this.lockOrInsertIntent(
        tx,
        input.workItemId,
        input.headRevision,
      );

      // (2) Terminal intent: return the RECORDED identity — zero external
      // calls. This is the duplicate-signal / re-drive convergence.
      if (intent.status === 'created' && intent.external_pr_id) {
        return {
          externalPrId: intent.external_pr_id,
          headCommit: intent.head_commit,
        };
      }

      // (3) Pending intent — we hold the row lock. The convergence read
      // FIRST: a crashed previous attempt may have created the external PR
      // without recording it (its transaction rolled back or died).
      const existing = await this.port.findExistingPullRequest({
        projectId: input.projectId,
        workItemId: input.workItemId,
        headRevision: input.headRevision,
      });
      if (existing) {
        await this.markCreated(tx, intent.id, existing);
        return existing;
      }

      // (4) No existing PR: create through the port — the ONLY PR-creation
      // capability — and record the result durably IN THE SAME TRANSACTION
      // (still under the row lock, so no concurrent same-key create can
      // interleave).
      const created = await this.port.createPullRequest({
        projectId: input.projectId,
        workItemId: input.workItemId,
        headRevision: input.headRevision,
        title: input.title,
        body: input.body,
      });
      await this.markCreated(tx, intent.id, created);
      return created;
    });
  }

  /** The durable intent row (if any) for a convergence key — test/ops read. */
  async findIntent(
    workItemId: string,
    headRevision: string,
  ): Promise<{ status: 'pending' | 'created'; externalPrId: string | null; headCommit: string | null } | null> {
    const result = await this.db.query<IntentRow>(
      `SELECT id, status, external_pr_id, head_commit
       FROM wfos_pull_request_intents
       WHERE work_item_id = $1 AND head_revision = $2`,
      [workItemId, headRevision],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    return {
      status: row.status,
      externalPrId: row.external_pr_id,
      headCommit: row.head_commit,
    };
  }

  /**
   * Lock-or-insert the intent row: SELECT ... FOR UPDATE, and when absent,
   * INSERT ... ON CONFLICT DO NOTHING then re-lock. Two concurrent callers
   * serialize: the loser's insert conflicts (unique key), and its re-lock
   * blocks until the winner's transaction commits — after which it observes
   * the winner's terminal state instead of creating again.
   */
  private async lockOrInsertIntent(
    tx: Parameters<Parameters<DatabaseClient['transaction']>[0]>[0],
    workItemId: string,
    headRevision: string,
  ): Promise<IntentRow> {
    const lockQuery = () =>
      tx.query<IntentRow>(
        `SELECT id, status, external_pr_id, head_commit
         FROM wfos_pull_request_intents
         WHERE work_item_id = $1 AND head_revision = $2
         FOR UPDATE`,
        [workItemId, headRevision],
      );

    let locked = await lockQuery();
    if (locked.rows.length === 0) {
      // No durable identity yet — insert one (ON CONFLICT DO NOTHING: a
      // concurrent winner may have committed between our SELECT and INSERT).
      await tx.query(
        `INSERT INTO wfos_pull_request_intents
           (work_item_id, head_revision, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (work_item_id, head_revision) DO NOTHING`,
        [workItemId, headRevision],
      );
      // Re-lock: either our fresh pending row, or the concurrent winner's
      // committed row (blocks until their transaction ends).
      locked = await lockQuery();
    }
    if (locked.rows.length === 0) {
      // Unreachable: the insert + unique constraint guarantee a row exists.
      throw new Error(
        `governed-pr-creation: intent row for (${workItemId}, ${headRevision}) vanished under lock — impossible`,
      );
    }
    return locked.rows[0]!;
  }

  /**
   * CAS the intent to 'created' with the authoritative PR identity — the
   * same statement that makes the winner's outcome durable. Guarded by
   * status = 'pending' so a stale writer can never overwrite a recorded
   * identity with a different one.
   */
  private async markCreated(
    tx: Parameters<Parameters<DatabaseClient['transaction']>[0]>[0],
    intentId: string,
    pr: CreatedPullRequest,
  ): Promise<void> {
    await tx.query(
      `UPDATE wfos_pull_request_intents
         SET status = 'created', external_pr_id = $2, head_commit = $3,
             updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [intentId, pr.externalPrId, pr.headCommit],
    );
  }
}
