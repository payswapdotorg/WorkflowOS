/**
 * WORK-042 (PR #46 round 8): the DURABLE PROVIDER-OPERATION LEDGER —
 * PostgreSQL persistence for the keyed external dispatch boundary
 * (`wfos_execution_provider_operations` — migration 0048).
 *
 * THE ROUND-8 CORRECTION. The round-7 "durable provider idempotency registry"
 * was actually an in-memory `Map` inside the ExternalExecutionProvider:
 * convergence existed only for the lifetime of that particular provider
 * instance, so a process/provider-instance loss between `submit(K)` and the
 * outcome left NOTHING durable remembering that K already owned an operation
 * — the reclaiming actor's new instance re-submitted K and started a SECOND
 * provider operation. The round-8 review's acceptable architecture:
 *
 *     stable dispatch key
 *            ↓
 *     durable provider-operation ledger
 *            ↓
 *     PENDING / COMPLETED / FAILED + provider operation/result
 *            ↓
 *     same key always resolves to the same operation
 *
 * This repository IS that ledger's persistence. The ROW is the provider
 * operation: `idempotency_key` is the PRIMARY KEY (ONE row per key — there is
 * structurally no second operation record for the same key), `state` is the
 * operation lifecycle, and `submission_json` is the operation's RESULT (the
 * stored `ExecutionSubmission` — replayed by every later same-key submit).
 *
 * THE STATE MACHINE (mirrors the obligation-gate discipline of rounds 4-6 —
 * CAS-only transitions, no read-check-write):
 *
 *   register(key):
 *     1. INSERT ... ON CONFLICT (idempotency_key) DO NOTHING — a FRESH key
 *        OPENS the operation (state 'pending', generation 1).
 *     2. Otherwise UPDATE ... WHERE state = 'failed' — a TERMINALLY FAILED
 *        operation is RE-ARMED by the next dispatch attempt (generation + 1:
 *        retry liveness on the SAME row, never a second row — exactly the
 *        obligation gate's monotonic take-over arm).
 *     3. Otherwise the row is 'pending' (in flight — converge/await) or
 *        'completed' (terminal — replay): return it to the caller.
 *
 *   complete(key, submission): the RESOLUTION CAS —
 *     UPDATE ... SET state = 'completed', submission_json = ... WHERE
 *     state = 'pending'. Exactly ONE driver's result becomes the operation's
 *     result: concurrent drivers (an original owner + a take-over after
 *     process loss) and a LATE dead driver's completion all funnel through
 *     this single CAS — the losers affect 0 rows and replay the winner's
 *     stored submission. The result is terminal: a completed row is never
 *     re-armed, so the same key always resolves to the same result.
 *
 *   fail(key, error): the symmetric resolution CAS ('pending' → 'failed',
 *     error stored). The first resolution wins — a racing driver that
 *     succeeds anyway converges by re-reading the row (see the provider).
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

/** The provider-operation lifecycle states (migration 0048's CHECK). */
export type ProviderOperationState = 'pending' | 'completed' | 'failed';

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
  /** The number of drive attempts on THIS row (1 = the original drive). */
  readonly generation: number;
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
 * The register/complete/fail transitions are CAS-only (single conditional
 * statements) — the concurrency safety lives in PostgreSQL, not in the
 * caller's check-then-act discipline.
 */
export interface ExecutionProviderOperationStore {
  /**
   * Register the operation for the key: open a FRESH row, or RE-ARM a
   * terminally FAILED row (the next dispatch attempt's retry), or return the
   * existing row for convergence. `opened === true` means the caller OWNS the
   * drive of the operation (it must run the operation body + resolve the row
   * through complete/fail); `opened === false` means the row already exists
   * (converge: 'completed' → replay `submission`; 'pending' → await/take
   * over; 'failed' → the stored error).
   */
  register(
    input: RegisterProviderOperationInput,
  ): Promise<{ opened: boolean; existing: ProviderOperationRecord | null }>;

  /**
   * Resolve the operation with a successful result — the RESOLUTION CAS
   * ('pending' → 'completed'). Returns `completed === false` when the CAS
   * lost (another driver resolved the row first — a take-over racing the
   * original, or a late dead driver after a take-over); `current` then holds
   * the winner's row for convergence.
   */
  complete(
    idempotencyKey: string,
    submission: ExecutionSubmission,
  ): Promise<{ completed: boolean; current: ProviderOperationRecord | null }>;

  /**
   * Resolve the operation with a failure — the symmetric CAS ('pending' →
   * 'failed'). A CAS loss (another driver already resolved the row) is a
   * benign no-op: the row's recorded resolution stands.
   */
  fail(idempotencyKey: string, error: string): Promise<void>;

  /**
   * PR #46 round 8 (the process-loss recovery): TAKE OVER the drive of a
   * PENDING row — the recovery drive of the SAME row (never a second row):
   * the generation counter is incremented (the row records how many drives
   * it has had) while the state stays 'pending'. The CAS means exactly one
   * actor can take over a given pending row per invocation — if it loses
   * (the row resolved while the caller's await window elapsed), the caller
   * converges to the recorded outcome instead of driving.
   */
  takeOver(
    idempotencyKey: string,
  ): Promise<{ tookOver: boolean; existing: ProviderOperationRecord | null }>;

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
  };
}

const SELECT_COLUMNS = `idempotency_key, provider, execution_id, mode, state,
  submission_json::text AS submission_json, error_message, generation`;

export class PgExecutionProviderOperationRepository
  implements ExecutionProviderOperationStore
{
  constructor(private readonly db: DatabaseClient) {}

  async register(
    input: RegisterProviderOperationInput,
  ): Promise<{ opened: boolean; existing: ProviderOperationRecord | null }> {
    // 1. A FRESH key OPENS the operation (ONE row per key — the PK).
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
    // 2. A TERMINALLY FAILED operation is RE-ARMED by this dispatch attempt
    //    (the SAME row — retry liveness without a second operation record;
    //    the CAS means exactly one concurrent re-arm wins, the others see
    //    'pending' and converge).
    const reArmed = await this.db.query<{ idempotency_key: string }>(
      `UPDATE wfos_execution_provider_operations
          SET state = 'pending',
              submission_json = NULL,
              error_message = NULL,
              generation = generation + 1,
              updated_at = NOW(),
              completed_at = NULL
        WHERE idempotency_key = $1
          AND state = 'failed'
       RETURNING idempotency_key`,
      [input.idempotencyKey],
    );
    if (reArmed.rows.length > 0) {
      return { opened: true, existing: null };
    }
    // 3. The row exists as 'pending' (in flight — converge/await/take over)
    //    or 'completed' (terminal — replay the stored result).
    const existing = await this.get(input.idempotencyKey);
    return { opened: false, existing };
  }

  async complete(
    idempotencyKey: string,
    submission: ExecutionSubmission,
  ): Promise<{ completed: boolean; current: ProviderOperationRecord | null }> {
    const result = await this.db.query<{ idempotency_key: string }>(
      `UPDATE wfos_execution_provider_operations
          SET state = 'completed',
              submission_json = $2::jsonb,
              error_message = NULL,
              updated_at = NOW(),
              completed_at = NOW()
        WHERE idempotency_key = $1
          AND state = 'pending'
       RETURNING idempotency_key`,
      [idempotencyKey, serializeSubmission(submission)],
    );
    if (result.rows.length > 0) {
      return { completed: true, current: null };
    }
    // The CAS lost — another driver resolved the row. Return the winner's
    // record for convergence (the caller replays it instead of returning its
    // own losing result).
    return { completed: false, current: await this.get(idempotencyKey) };
  }

  async fail(idempotencyKey: string, error: string): Promise<void> {
    // The symmetric resolution CAS. A CAS loss (another driver already
    // resolved the row) is a benign no-op — the row's recorded resolution
    // stands; the provider re-reads the row and converges when needed.
    await this.db.query(
      `UPDATE wfos_execution_provider_operations
          SET state = 'failed',
              error_message = $2,
              updated_at = NOW(),
              completed_at = NOW()
        WHERE idempotency_key = $1
          AND state = 'pending'`,
      [idempotencyKey, error],
    );
  }

  async takeOver(
    idempotencyKey: string,
  ): Promise<{ tookOver: boolean; existing: ProviderOperationRecord | null }> {
    // The recovery drive of the SAME row: the generation counter records the
    // drive (the row IS the operation — a take-over never creates a second
    // row); the state stays 'pending' (the outcome is still unresolved). The
    // CAS serializes concurrent take-overs + rejects a row that resolved
    // while the caller's await window elapsed (the caller converges instead
    // of driving).
    const result = await this.db.query<{ idempotency_key: string }>(
      `UPDATE wfos_execution_provider_operations
          SET generation = generation + 1,
              updated_at = NOW()
        WHERE idempotency_key = $1
          AND state = 'pending'
       RETURNING idempotency_key`,
      [idempotencyKey],
    );
    if (result.rows.length > 0) {
      return { tookOver: true, existing: null };
    }
    // The CAS lost — the row resolved while the window elapsed: converge to
    // the recorded outcome (replay the stored result / surface the failure).
    return { tookOver: false, existing: await this.get(idempotencyKey) };
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
