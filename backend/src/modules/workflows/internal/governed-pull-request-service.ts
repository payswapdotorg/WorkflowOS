/**
 * WORK-051 round 2 (PR #52 review, BLOCKER 2) — the durable, crash-safe,
 * idempotent governed PR-creation protocol.
 *
 * PR #52 round 4 (review, BLOCKER 2) — ONE durable identity boundary for
 * BOTH governed PR paths:
 *
 *   CREATE — the governed convergence path creates the implementation PR
 *     through the port (the ONLY PR-creation capability), after the
 *     pr_conformance checkpoint allows it;
 *   ADOPT — an externally observed PR (a human / out-of-band tool opened it)
 *     is resolved to its AUTHORITATIVE head commit through /github, gated at
 *     that exact revision, and then CONVERGED onto the SAME durable identity
 *     the creation path uses (association only; no creation side effect).
 *
 * Both paths share the key (work_item_id, head_revision) — the logical Work
 * Item + the EXACT implementation revision the architecture checkpoint
 * gated on — and serialize through the same `wfos_pull_request_intents` row
 * (SELECT … FOR UPDATE). The invariant proven at the persistence layer:
 *
 *   For one (work item, authoritative head commit), all governed paths —
 *   create and adopt — converge on EXACTLY ONE PR identity/association.
 *
 * A path arriving with a DIFFERENT PR identity for an already-recorded key
 * throws {@link GovernedPrIdentityConflictError} (fail closed — never a
 * silent second association). The `origin` column records which path
 * recorded the identity ('created' | 'adopted').
 *
 * THE CREATE PROTOCOL (create-or-converge on the durable identity):
 *
 *   key = (work_item_id, head_revision)
 *   The key is durable (migration 0055, UNIQUE; migration 0056 adds origin)
 *   and the head branch is a pure function of it (governedHeadBranch).
 *
 *   1. BEGIN; SELECT the intent row FOR UPDATE (lock-or-insert via
 *      INSERT ... ON CONFLICT DO NOTHING + re-lock) — concurrent callers
 *      with the same key SERIALIZE here (create AND adopt alike).
 *   2. status = 'created' → COMMIT and return the RECORDED PR identity.
 *      ZERO external calls: the duplicate re-drive is a pure convergence.
 *   3. status = 'pending' (a previous attempt crashed mid-flight, or this
 *      transaction just inserted it):
 *      a. CONVERGENCE READ — findExistingPullRequest(key): the external
 *         authority may already hold the PR from the crashed attempt
 *         (identified by the deterministic head branch); the read VALIDATES
 *         the branch AND the authoritative head SHA (round 4, BLOCKER 3);
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
 * THE ADOPT PROTOCOL (converge on the observed identity — no side effect):
 *
 *   adopt(key, observed PR identity) — same lock-or-insert; 'created' with
 *   the SAME identity → converged (idempotent re-observation); 'created'
 *   with a DIFFERENT identity → typed conflict (fail closed); 'pending' →
 *   CAS to 'created' with origin 'adopted'. A crash before COMMIT rolls
 *   back and the re-drive re-adopts — there is no external side effect to
 *   guard. A later CREATE re-drive of the same key returns the ADOPTED
 *   identity (zero external calls) — the paths cross-converge.
 *
 * Concurrency: the FOR UPDATE row lock serializes same-key callers — the
 * loser blocks until the winner commits, then observes 'created' and
 * returns the recorded identity with ZERO external calls of its own. The
 * unique constraint is the durable backstop for every interleaving.
 *
 * Authority: /workflows owns this ledger (it owns lifecycle transitions and
 * PR associations); /github remains the sole external PR authority (the
 * create, the convergence read, AND the adoption resolution all flow
 * through the PullRequestCreationPort → GitHubAdapter); no second workflow
 * or PR engine exists.
 */

import type { DatabaseClient } from '@platform/index.js';
import type {
  CreatedPullRequest,
  PullRequestCreationPort,
  ResolvedExternalPullRequest,
} from './convergence.types.js';
import { GovernedPrIdentityConflictError } from './convergence.types.js';

interface IntentRow {
  id: string;
  status: 'pending' | 'created';
  external_pr_id: string | null;
  head_commit: string | null;
  origin: 'created' | 'adopted';
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
      // calls. This is the duplicate-signal / re-drive convergence. (The
      // recorded identity may itself have been recorded by the ADOPT path —
      // round 4: both paths converge through this same ledger.)
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
        await this.markCreated(tx, intent.id, existing, 'created');
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
      await this.markCreated(tx, intent.id, created, 'created');
      return created;
    });
  }

  /**
   * PR #52 round 4 (review, BLOCKER 2) — ADOPT an externally observed PR
   * through the SAME durable identity boundary the creation path uses.
   *
   * The caller (the orchestrator) has already resolved the observation to
   * its AUTHORITATIVE identity through /github
   * (resolveExternalPullRequest) and gated the pr_conformance checkpoint at
   * that exact head revision. This method converges the observation onto
   * the durable (workItemId, headRevision) intent row:
   *
   *   - key already 'created' with the SAME PR identity → CONVERGED
   *     (idempotent re-observation; zero writes);
   *   - key already 'created' with a DIFFERENT PR identity → typed
   *     {@link GovernedPrIdentityConflictError} — one (work item,
   *     authoritative head commit) holds exactly one PR identity (fail
   *     closed; no association, no PR_OPEN);
   *   - key 'pending' (no identity recorded yet) → CAS to 'created' with
   *     origin 'adopted'.
   *
   * No external side effect exists to guard (adoption is association-only),
   * so a crash before COMMIT simply rolls back and the re-drive re-adopts.
   * A subsequent CREATE re-drive of the same key returns the ADOPTED
   * identity with zero external calls — the two governed paths
   * cross-converge on exactly one PR.
   */
  async adopt(input: {
    projectId: string;
    workItemId: string;
    /** The EXACT implementation revision the pr_conformance checkpoint gated on — MUST equal the observed PR's authoritative head commit. */
    headRevision: string;
    /** The canonical external PR identity (e.g. 'github:owner/repo#12'). */
    externalPrId: string;
    /** The observed PR's AUTHORITATIVE head commit SHA (from /github). */
    headCommit: string;
  }): Promise<CreatedPullRequest> {
    if (!input.workItemId || !input.headRevision || !input.externalPrId || !input.headCommit) {
      throw new Error(
        'governed-pr-adoption: workItemId, headRevision, externalPrId and headCommit are required — ' +
          'the adoption identity must be complete (fail closed)',
      );
    }
    if (input.headCommit !== input.headRevision) {
      // The durable key IS the authoritative head commit; an observation
      // whose head differs from the gated revision is a provenance
      // violation — it can never enter the identity boundary.
      throw new Error(
        `governed-pr-adoption: the observed PR ${input.externalPrId} has authoritative head ` +
          `${input.headCommit}, but the checkpoint gated revision ${input.headRevision} — ` +
          'the adoption key must be the PR\'s authoritative head commit (fail closed)',
      );
    }
    void input.projectId; // repository coordinates are resolved server-side by the port
    return this.db.transaction(async (tx) => {
      // (1) The SAME lock-or-insert as the create path — same-key create and
      // adopt callers SERIALIZE through this row.
      const intent = await this.lockOrInsertIntent(
        tx,
        input.workItemId,
        input.headRevision,
      );

      // (2) Terminal intent: converge on the RECORDED identity.
      if (intent.status === 'created' && intent.external_pr_id) {
        if (intent.external_pr_id === input.externalPrId) {
          // Idempotent re-observation of the SAME PR — pure convergence.
          return {
            externalPrId: intent.external_pr_id,
            headCommit: intent.head_commit,
          };
        }
        // A DIFFERENT PR claiming an already-recorded key — the durable
        // ledger is the authority: exactly one identity per key, ever.
        throw new GovernedPrIdentityConflictError({
          workItemId: input.workItemId,
          headRevision: input.headRevision,
          recordedExternalPrId: intent.external_pr_id,
          claimedExternalPrId: input.externalPrId,
        });
      }

      // (3) Pending intent — record the observed identity (origin
      // 'adopted'; no external side effect to guard).
      const observed: CreatedPullRequest = {
        externalPrId: input.externalPrId,
        headCommit: input.headCommit,
      };
      await this.markCreated(tx, intent.id, observed, 'adopted');
      return observed;
    });
  }

  /**
   * PR #52 round 3 (review, BLOCKER 3) — the ADOPTION RESOLUTION read:
   * resolve an externally observed PR reference to its AUTHORITATIVE
   * identity (the PR's real head commit SHA) through the /github boundary.
   *
   * NOT part of the create-or-converge protocol (no DB state, no side
   * effects — a pure read through the external boundary port), but the same
   * boundary: the orchestrator calls this BEFORE the pr_conformance gate
   * whenever only an external PR observation is available, because only the
   * RESOLVED COMMIT SHA may enter the checkpoint binding and the
   * governed-creation identity — never the raw PR reference.
   *
   * Returns null when the authority holds no such PR; throws on malformed
   * references, missing links, foreign repositories, and transport
   * failures — every unresolvable shape fails closed at the caller.
   */
  async resolveExternalPullRequest(input: {
    projectId: string;
    externalPrRef: string;
  }): Promise<ResolvedExternalPullRequest | null> {
    return this.port.resolveExternalPullRequest(input);
  }

  /**
   * The durable intent row (if any) for a convergence key — test/ops read.
   * `origin` records which governed path recorded the identity ('created' —
   * the platform created the PR; 'adopted' — the platform converged on an
   * externally observed PR).
   */
  async findIntent(
    workItemId: string,
    headRevision: string,
  ): Promise<{
    status: 'pending' | 'created';
    externalPrId: string | null;
    headCommit: string | null;
    origin: 'created' | 'adopted';
  } | null> {
    const result = await this.db.query<IntentRow>(
      `SELECT id, status, external_pr_id, head_commit, origin
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
      origin: row.origin,
    };
  }

  /**
   * Lock-or-insert the intent row: SELECT ... FOR UPDATE, and when absent,
   * INSERT ... ON CONFLICT DO NOTHING then re-lock. Two concurrent callers
   * serialize: the loser's insert conflicts (unique key), and its re-lock
   * blocks until the winner's transaction commits — after which it observes
   * the winner's terminal state instead of creating again. The SAME
   * serialization applies to create-vs-adopt and adopt-vs-adopt callers
   * (round 4: both governed paths share this durable identity boundary).
   */
  private async lockOrInsertIntent(
    tx: Parameters<Parameters<DatabaseClient['transaction']>[0]>[0],
    workItemId: string,
    headRevision: string,
  ): Promise<IntentRow> {
    const lockQuery = () =>
      tx.query<IntentRow>(
        `SELECT id, status, external_pr_id, head_commit, origin
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
   * identity with a different one. `origin` records which governed path
   * recorded the identity (round 4: 'created' | 'adopted').
   */
  private async markCreated(
    tx: Parameters<Parameters<DatabaseClient['transaction']>[0]>[0],
    intentId: string,
    pr: CreatedPullRequest,
    origin: 'created' | 'adopted',
  ): Promise<void> {
    await tx.query(
      `UPDATE wfos_pull_request_intents
         SET status = 'created', external_pr_id = $2, head_commit = $3,
             origin = $4, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [intentId, pr.externalPrId, pr.headCommit, origin],
    );
  }
}
