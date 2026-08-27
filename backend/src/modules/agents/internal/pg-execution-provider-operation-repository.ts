/**
 * WORK-042 (PR #46 round 9 + round 10): the GENERATION-FENCED,
 * LIFECYCLE-EXPLICIT provider-operation ledger — PostgreSQL persistence for
 * the keyed external dispatch boundary (`wfos_execution_provider_operations`
 * — migrations 0048 + 0049 + 0050).
 *
 * THE ROUND-10 CORRECTION. The round-9 protocol recorded the operation
 * identity (attachOperation) BEFORE the operation body ran and inferred
 * "handle recorded ⇒ the operation started". That inference is INVALID —
 * the crash window between the durable attach and the body left a row whose
 * recorded identity pointed at an operation that never existed, and every
 * recovery driver then resolved by that identity FOREVER without ever
 * executing the body. The round-10 protocol makes the lifecycle EXPLICIT and
 * moves the authority to the PROVIDER BOUNDARY:
 *
 *     durable operation key
 *        ↓
 *     startOperation(key, task)      ← the IDEMPOTENT-BY-KEY submission
 *        ↓                               (the provider contract: a re-call
 *        ↓                                CONVERGES onto the ONE operation,
 *        ↓                                never a second one)
 *     attachOperation(key, gen, H)   ← CAS: 'pending' → 'started', recorded
 *        ↓                               ONLY AFTER the provider confirmed
 *     resolveOperation(H, task) → one terminal result
 *
 * THE STATE MACHINE (CAS-only, like the obligation-gate discipline of rounds
 * 4-6 — single conditional statements, no read-check-write):
 *
 *   register(key): INSERT ... ON CONFLICT (idempotency_key) DO NOTHING — a
 *     FRESH key OPENS the operation (state 'pending', generation 1, NO
 *     handle — the row makes NO claim about the provider). An EXISTING row
 *     is returned as-is for convergence. THE KEY IS IMMUTABLE: COMPLETED and
 *     FAILED are BOTH terminal — register NEVER re-arms (round 9).
 *
 *   attachOperation(key, generation, handle): the PROVIDER-CONFIRMED-START
 *     CAS — 'pending' @ THIS generation → 'started', recording the identity
 *     the provider RETURNED from the idempotent submission. The database
 *     NEVER infers a start: 'started' is written only after startOperation
 *     confirmed the ONE operation exists; the FIRST recorded handle is
 *     immutable for the operation.
 *
 *   complete(key, generation, submission): the GENERATION-FENCED RESOLUTION
 *     CAS — 'started' @ THIS generation → 'completed' (+ the stored result).
 *     Requiring 'started' is the lifecycle gate: a terminal SUCCESS is only
 *     recordable for a CONFIRMED operation — the database structurally cannot
 *     record a terminal success for an operation it never observed starting
 *     (round 10 — the architect's "no silent skip of a merely-prepared
 *     operation"). Only the ACTIVE driver's generation can resolve.
 *
 *   fail(key, generation, error): the symmetric generation-fenced CAS
 *     ('pending' OR 'started' @ THIS generation → 'failed', error stored) —
 *     a failed submission attempt (never confirmed) or a failed resolution
 *     (confirmed) may each terminally fail the key. A CAS loss is a benign
 *     no-op: the row's recorded resolution stands.
 *
 *   takeOver(key): the process-loss recovery CAS — 'pending' OR 'started' →
 *     same state @ generation + 1, RETURNING the NEW GENERATION TOKEN (the
 *     fencing token the recovering driver must present to complete/fail —
 *     round 9's fencing is retained in full). Both non-terminal states are
 *     recoverable: a 'pending' row is RE-SUBMITTED (idempotent by key); a
 *     'started' row is RESOLVED BY ITS CONFIRMED IDENTITY.
 *
 * All statements are single-statement conditional UPDATEs/INSERTs (pglite +
 * real PG portable; no multi-statement queries). The rows are durable
 * execution state — no immutability trigger applies (0043's trigger guards
 * only the handoff log).
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  ExecutionMode,
  ExecutionSubmission,
  ExternalExecutionPackage,
} from './execution.types.js';

/**
 * The provider-operation lifecycle states (migrations 0048 + 0050's CHECK).
 *
 * PR #46 round 10 — the EXPLICIT lifecycle (the round-9 attach-before-body
 * inference removed):
 *   - 'pending': the operation row exists; the provider submission is NOT
 *     durably confirmed on the row — NO handle, the row makes NO claim about the provider (the operation may or may not exist there; the
 *     idempotent-by-key submission contract makes BOTH states safe to
 *     re-drive);
 *   - 'started': the provider CONFIRMED the ONE operation exists
 *     (startOperation returned its identity; the handle was attached AFTER
 *     that confirmation) — recovery resolves it BY IDENTITY;
 *   - 'completed' / 'failed': terminal (the key is immutable — round 9).
 */
export type ProviderOperationState = 'pending' | 'started' | 'completed' | 'failed';

/** A ledger row — the durable provider operation for one idempotency key. */
export interface ProviderOperationRecord {
  readonly idempotencyKey: string;
  readonly provider: string;
  readonly executionId: string;
  readonly mode: ExecutionMode;
  readonly state: ProviderOperationState;
  /** COMPLETED: the operation's stored result (the registered submission). */
  readonly submission: ExecutionSubmission | null;
  /** FAILED: the stored failure of the terminal attempt. */
  readonly errorMessage: string | null;
  /**
   * The number of drive attempts on THIS row (1 = the original drive). The
   * generation is the FENCING TOKEN: complete/fail are CAS-fenced against it
   * (round 9), so exactly ONE generation — the ACTIVE driver — can resolve
   * the operation.
   */
  readonly generation: number;
  /**
   * The durable provider-side identity of the ONE operation (round 9 /
   * migration 0049; round 10 semantics): recorded by attachOperation ONLY
   * AFTER the provider confirmed the operation (the idempotent-by-key
   * startOperation submission returned this identity). Present (with state
   * 'started') ⇒ the provider CONFIRMED the operation exists — a recovery
   * driver resolves it BY IDENTITY. Absent (state 'pending') ⇒ the row makes
   * NO claim about the provider — a recovery driver re-submits under the
   * idempotent-by-key contract. The database NEVER infers a start from a
   * persisted identity.
   */
  readonly providerOperationHandle: string | null;
}

export interface RegisterProviderOperationInput {
  readonly idempotencyKey: string;
  readonly provider: string;
  readonly executionId: string;
  readonly mode: ExecutionMode;
}

/**
 * The durable provider-operation ledger port (implemented by
 * {@link PgExecutionProviderOperationRepository}).
 *
 * Every transition is a CAS (a single conditional statement) — the
 * concurrency safety lives in PostgreSQL, not in the caller's
 * check-then-act discipline. PR #46 round 9: the RESOLUTION transitions
 * (complete/fail) are fenced by the DRIVER GENERATION — the token
 * {@link ExecutionProviderOperationStore.takeOver} returns.
 */
export interface ExecutionProviderOperationStore {
  /**
   * Register the operation for the key: open a FRESH row (generation 1), or
   * return the EXISTING row for convergence. `opened === true` means the
   * caller OWNS the generation-1 drive of the operation (it must attach the
   * operation identity, run the operation body + resolve the row through the
   * generation-fenced complete/fail); `opened === false` means the row
   * already exists (converge: 'completed' → REPLAY `submission`; 'failed' →
   * the stored terminal failure; 'pending' → await / take over).
   *
   * PR #46 round 9 (KEY IMMUTABILITY): a terminally FAILED row is returned
   * as-is — it is NEVER re-armed. One key identifies ONE logical operation
   * invocation with ONE terminal result; retryability is the driver
   * mechanics' concern (the await → take-over → resolve-by-identity
   * recovery), never a second operation under the same key.
   */
  register(
    input: RegisterProviderOperationInput,
  ): Promise<{ opened: boolean; existing: ProviderOperationRecord | null }>;

  /**
   * Record the PROVIDER-CONFIRMED operation identity (the durable provider-
   * side identity of the ONE operation — migration 0049) on the row: the
   * PROVIDER-CONFIRMED-START CAS ('pending' @ the CALLER's generation →
   * 'started', recording the handle the IDEMPOTENT-BY-KEY submission
   * returned). PR #46 round 10: the attach happens ONLY AFTER the provider
   * confirmed the operation — the database NEVER infers a start from a
   * persisted identity. The CAS requires the row to be 'pending' at the
   * CALLER's generation with the handle not yet recorded: a stale generation
   * cannot attach, and the FIRST recorded handle is IMMUTABLE for the
   * operation (later recovery drivers resolve by it — they never re-attach).
   * Returns false when the CAS lost (another driver already recorded the
   * identity, the generation moved on, or the row resolved — the caller
   * re-reads and converges/resolves accordingly).
   */
  attachOperation(
    idempotencyKey: string,
    generation: number,
    providerOperationHandle: string,
  ): Promise<boolean>;

  /**
   * Resolve the operation with a successful result — the GENERATION-FENCED
   * RESOLUTION CAS ('started' @ `generation` → 'completed', the submission
   * stored as the operation's ONE terminal result). PR #46 round 10: the CAS
   * requires 'started' — a terminal SUCCESS is only recordable for an
   * operation the PROVIDER CONFIRMED (the lifecycle gate: the database can
   * never record a terminal success for a merely-prepared operation that was
   * never observed starting). Returns `completed === false` when the CAS lost
   * — the caller's generation is STALE (superseded by a take-over), the row
   * was never 'started', or the row already resolved — and `current` then
   * holds the winner's row for convergence: a stale generation is
   * STRUCTURALLY INCAPABLE of resolving the operation, for a success AND for
   * a failure alike.
   */
  complete(
    idempotencyKey: string,
    generation: number,
    submission: ExecutionSubmission,
  ): Promise<{ completed: boolean; current: ProviderOperationRecord | null }>;

  /**
   * Resolve the operation with a failure — the symmetric GENERATION-FENCED
   * CAS ('pending' OR 'started' @ `generation` → 'failed', the error stored).
   * A failed SUBMISSION attempt (never confirmed — 'pending') or a failed
   * RESOLUTION (confirmed — 'started') may each terminally fail the key. A
   * CAS loss (the generation is stale, or another driver resolved the row) is
   * a benign no-op: the row's recorded resolution stands; the stale driver's
   * failure is structurally DISCARDED (it can never defeat the active
   * generation).
   */
  fail(idempotencyKey: string, generation: number, error: string): Promise<void>;

  /**
   * PR #46 round 9 (the process-loss recovery; round 10: BOTH non-terminal
   * states are recoverable): TAKE OVER the drive of a 'pending' OR 'started'
   * row — the recovery drive of the SAME row (never a second row): the
   * generation counter is incremented and the NEW GENERATION TOKEN is
   * RETURNED (the fencing token the recovering driver must present to
   * complete/fail — the previous generations become structurally incapable
   * of resolving the operation). The state is unchanged (the outcome is
   * still unresolved: a taken-over 'pending' row is RE-SUBMITTED under the
   * idempotent-by-key contract; a taken-over 'started' row is RESOLVED BY
   * ITS CONFIRMED IDENTITY). The CAS rejects a row that resolved while the
   * caller's await window elapsed (the caller converges to the recorded
   * outcome instead of driving).
   */
  takeOver(
    idempotencyKey: string,
  ): Promise<{
    tookOver: boolean;
    generation: number | null;
    existing: ProviderOperationRecord | null;
  }>;

  /** Read the ledger row for the key (the durable operation record). */
  get(idempotencyKey: string): Promise<ProviderOperationRecord | null>;
}

interface OperationRow {
  idempotency_key: string;
  provider: string;
  execution_id: string;
  mode: string;
  state: ProviderOperationState;
  submission_json: string | null;
  error_message: string | null;
  generation: number;
  provider_operation_handle: string | null;
}

/** Serialize a submission for durable storage (dates → ISO strings). */
function serializeSubmission(submission: ExecutionSubmission): string {
  return JSON.stringify(submission);
}

/**
 * Deserialize the stored submission — revives the date fields
 * (`startedAt` / `completedAt` / `expiresAt`) that JSON.stringify turned into
 * ISO strings, so a REPLAYED submission is value-identical to the original
 * (the convergence proof compares them).
 */
function deserializeSubmission(raw: string): ExecutionSubmission {
  const parsed = JSON.parse(raw) as Omit<ExecutionSubmission, 'startedAt' | 'completedAt' | 'expiresAt'> & {
    startedAt?: string;
    completedAt?: string;
    expiresAt?: string;
  };
  const submission: {
    executionId: string;
    provider: string;
    mode: ExecutionMode;
    status: ExecutionSubmission['status'];
    agentRunId?: string;
    externalSessionRef?: string | null;
    commitRef?: string | null;
    pullRequestRef?: string | null;
    startedAt?: Date;
    completedAt?: Date;
    package?: ExternalExecutionPackage;
    expiresAt?: Date;
  } = {
    executionId: parsed.executionId,
    provider: parsed.provider,
    mode: parsed.mode,
    status: parsed.status,
  };
  if (parsed.agentRunId !== undefined) submission.agentRunId = parsed.agentRunId;
  if (parsed.externalSessionRef !== undefined) {
    submission.externalSessionRef = parsed.externalSessionRef;
  }
  if (parsed.commitRef !== undefined) submission.commitRef = parsed.commitRef;
  if (parsed.pullRequestRef !== undefined) {
    submission.pullRequestRef = parsed.pullRequestRef;
  }
  if (parsed.startedAt !== undefined && parsed.startedAt !== null) {
    submission.startedAt = new Date(parsed.startedAt);
  }
  if (parsed.completedAt !== undefined && parsed.completedAt !== null) {
    submission.completedAt = new Date(parsed.completedAt);
  }
  if (parsed.package !== undefined && parsed.package !== null) {
    submission.package = parsed.package;
  }
  if (parsed.expiresAt !== undefined && parsed.expiresAt !== null) {
    submission.expiresAt = new Date(parsed.expiresAt);
  }
  return submission;
}

function toRecord(row: OperationRow): ProviderOperationRecord {
  return {
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    executionId: row.execution_id,
    mode: row.mode as ExecutionMode,
    state: row.state,
    submission:
      row.submission_json != null
        ? deserializeSubmission(row.submission_json)
        : null,
    errorMessage: row.error_message,
    generation: Number(row.generation),
    providerOperationHandle: row.provider_operation_handle,
  };
}

const SELECT_COLUMNS = `idempotency_key, provider, execution_id, mode, state,
  submission_json::text AS submission_json, error_message, generation,
  provider_operation_handle`;

export class PgExecutionProviderOperationRepository
  implements ExecutionProviderOperationStore
{
  constructor(private readonly db: DatabaseClient) {}

  async register(
    input: RegisterProviderOperationInput,
  ): Promise<{ opened: boolean; existing: ProviderOperationRecord | null }> {
    // A FRESH key OPENS the operation (ONE row per key — the PK). An
    // EXISTING row is returned as-is: 'pending' → await/take over;
    // 'completed' → replay; 'failed' → the stored terminal failure.
    //
    // PR #46 round 9 (KEY IMMUTABILITY): there is NO re-arm. The round-8
    // register conditionally re-armed a terminally FAILED row (generation +
    // 1, back to 'pending'), which let ONE key resolve to FAILED/result-A
    // and later COMPLETED/result-B — the key did not identify one immutable
    // operation. A true idempotency key identifies the LOGICAL OPERATION
    // INVOCATION: COMPLETED and FAILED are BOTH terminal, and retryability
    // is the driver mechanics' concern (await → take-over → resolve), never
    // a second operation silently opened under the same key.
    const inserted = await this.db.query<{ idempotency_key: string }>(
      `INSERT INTO wfos_execution_provider_operations
         (idempotency_key, provider, execution_id, mode)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [input.idempotencyKey, input.provider, input.executionId, input.mode],
    );
    if (inserted.rows.length > 0) {
      return { opened: true, existing: null };
    }
    const existing = await this.get(input.idempotencyKey);
    return { opened: false, existing };
  }

  async attachOperation(
    idempotencyKey: string,
    generation: number,
    providerOperationHandle: string,
  ): Promise<boolean> {
    // The PROVIDER-CONFIRMED-START CAS (PR #46 round 10): durably records the
    // identity the IDEMPOTENT-BY-KEY submission returned — 'pending' @ the
    // CALLER's generation → 'started' (the provider CONFIRMED the ONE
    // operation exists; the handle was NOT persisted before the provider
    // call — the database never infers a start from an intended identity).
    // The FIRST recorded handle is immutable for the operation (a later
    // recovery driver resolves by the recorded identity — it never
    // re-attaches).
    const result = await this.db.query<{ idempotency_key: string }>(
      `UPDATE wfos_execution_provider_operations
          SET provider_operation_handle = $3,
              operation_attached_at = NOW(),
              state = 'started',
              updated_at = NOW()
        WHERE idempotency_key = $1
          AND state = 'pending'
          AND generation = $2
          AND provider_operation_handle IS NULL
       RETURNING idempotency_key`,
      [idempotencyKey, generation, providerOperationHandle],
    );
    return result.rows.length > 0;
  }

  async complete(
    idempotencyKey: string,
    generation: number,
    submission: ExecutionSubmission,
  ): Promise<{ completed: boolean; current: ProviderOperationRecord | null }> {
    // The GENERATION-FENCED RESOLUTION CAS ('started' @ THIS generation →
    // 'completed'). PR #46 round 10: requiring 'started' is the LIFECYCLE
    // GATE — a terminal SUCCESS is only recordable for an operation the
    // PROVIDER CONFIRMED (the database can never record a terminal success
    // for a merely-prepared operation that was never observed starting).
    // Only the ACTIVE driver's generation can resolve the operation:
    // concurrent drivers (an original owner + a take-over after process
    // loss) and a LATE stale driver's completion all funnel through this
    // single CAS — the losers affect 0 rows and replay the winner's stored
    // submission. PR #46 round 9: the `AND generation = $2` fence is the fix
    // for the round-8 stale-owner race (a stale generation could previously
    // resolve the row merely because it raced the recovery generation to the
    // CAS — for a success AND, worse, for a FAILURE that defeated the
    // recovery driver's later success).
    const result = await this.db.query<{ idempotency_key: string }>(
      `UPDATE wfos_execution_provider_operations
          SET state = 'completed',
              submission_json = $3::jsonb,
              error_message = NULL,
              updated_at = NOW(),
              completed_at = NOW()
        WHERE idempotency_key = $1
          AND state = 'started'
          AND generation = $2
       RETURNING idempotency_key`,
      [idempotencyKey, generation, serializeSubmission(submission)],
    );
    if (result.rows.length > 0) {
      return { completed: true, current: null };
    }
    // The CAS lost — the caller's generation is stale or another driver
    // resolved the row. Return the winner's record for convergence (the
    // caller replays it instead of returning its own losing result).
    return { completed: false, current: await this.get(idempotencyKey) };
  }

  async fail(
    idempotencyKey: string,
    generation: number,
    error: string,
  ): Promise<void> {
    // The symmetric GENERATION-FENCED CAS ('pending' OR 'started' @ THIS
    // generation → 'failed'). PR #46 round 10: a failed SUBMISSION attempt
    // (never confirmed — 'pending') or a failed RESOLUTION (confirmed —
    // 'started') may each terminally fail the key. A CAS loss is a benign
    // no-op — the row's recorded resolution stands; a STALE generation's
    // failure is structurally DISCARDED (it can never defeat the active
    // recovery generation: the round-8 review's blocking interleaving
    // "takeover → stale FAIL → new generation SUCCESS" is impossible by
    // construction).
    await this.db.query(
      `UPDATE wfos_execution_provider_operations
          SET state = 'failed',
              error_message = $3,
              updated_at = NOW(),
              completed_at = NOW()
        WHERE idempotency_key = $1
          AND state IN ('pending', 'started')
          AND generation = $2`,
      [idempotencyKey, generation, error],
    );
  }

  async takeOver(
    idempotencyKey: string,
  ): Promise<{
    tookOver: boolean;
    generation: number | null;
    existing: ProviderOperationRecord | null;
  }> {
    // The recovery drive of the SAME row: the generation counter records the
    // drive (the row IS the operation — a take-over never creates a second
    // row) and the NEW GENERATION TOKEN is returned — the fencing token the
    // recovering driver must present to complete/fail. Every PREVIOUS
    // generation becomes structurally incapable of resolving the operation
    // from this CAS onward. PR #46 round 10: BOTH non-terminal states are
    // recoverable ('pending' → re-submit under the idempotent-by-key
    // contract; 'started' → resolve by the CONFIRMED identity) — the state is
    // unchanged by the take-over (the outcome is still unresolved); the CAS
    // serializes concurrent take-overs and rejects a row that resolved while
    // the caller's await window elapsed (the caller converges instead of
    // driving).
    const result = await this.db.query<{ generation: number }>(
      `UPDATE wfos_execution_provider_operations
          SET generation = generation + 1,
              updated_at = NOW()
        WHERE idempotency_key = $1
          AND state IN ('pending', 'started')
       RETURNING generation`,
      [idempotencyKey],
    );
    if (result.rows.length > 0) {
      return { tookOver: true, generation: Number(result.rows[0]!.generation), existing: null };
    }
    // The CAS lost — the row resolved while the window elapsed: converge to
    // the recorded outcome (replay the stored result / surface the failure).
    return { tookOver: false, generation: null, existing: await this.get(idempotencyKey) };
  }

  async get(idempotencyKey: string): Promise<ProviderOperationRecord | null> {
    const result = await this.db.query<OperationRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM wfos_execution_provider_operations
        WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }
}
