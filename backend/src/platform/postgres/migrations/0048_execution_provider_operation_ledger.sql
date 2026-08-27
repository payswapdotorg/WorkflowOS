-- WORK-042 (PR #46 round 8): the DURABLE PROVIDER-OPERATION LEDGER for the
-- keyed external dispatch — the correction of the round-7 in-memory registry.
--
-- The round-8 review found the round-7 "durable provider idempotency
-- registry" was actually:
--
--     private readonly operations =
--       new Map<string, Promise<ExecutionSubmission>>();
--
-- inside ExternalExecutionProvider — convergence existed only for the
-- lifetime of that particular provider instance. Migration 0047 persisted
-- dispatch_idempotency_key on the obligation row, but NOTHING durable
-- remembered that the key ALREADY OWNS a provider operation:
--
--     T1    submit(K)
--             ↓
--           provider operation starts
--             ↓
--           provider process dies
--
--     T2    reclaim handoff
--             ↓
--           new ExternalExecutionProvider instance
--             ↓
--           submit(K)
--             ↓
--           Map is empty
--             ↓
--           SECOND provider operation
--
-- The database remembered K, but nothing durable remembered that K already
-- owned an operation. That directly contradicted the PR's claim of
-- Stripe-style idempotency-key semantics, and the R6-#2 proof was
-- insufficient for the same reason: the harness SHARED the provider instance
-- (and therefore the Map) between T1 and T2, so it only proved the in-memory
-- Map converges — never the architect's actual requirement:
--
--     provider instance A
--         ↓
--     operation K starts
--         ↓
--     instance A disappears
--         ↓
--     provider instance B
--         ↓
--     submit K
--         ↓
--     SAME operation
--
-- The round-8 correction implements the architect's acceptable architecture:
--
--     stable dispatch key
--            ↓
--     durable provider-operation ledger
--            ↓
--     PENDING / COMPLETED / FAILED + provider operation/result
--            ↓
--     same key always resolves to the same operation
--
-- This table IS that ledger for the EXTERNAL provider boundary:
--
--   - idempotency_key is the PRIMARY KEY: ONE row per key — the ROW is the
--     provider operation. There is structurally no second operation record
--     for the same key, and the registry (the key → operation mapping) is
--     DURABLE — it survives provider-instance loss, process loss, and
--     reclaim-driven re-dispatch by any other actor.
--   - state is the operation lifecycle: PENDING (opened — the operation is
--     in flight at the original submitter, or that submitter died mid-flight
--     with the outcome uncertain), COMPLETED (terminal — submission_json
--     holds the operation's RESULT; every later same-key submit REPLAYS it),
--     FAILED (terminal attempt — error_message holds the failure; the next
--     dispatch attempt re-arms the SAME row, mirroring the obligation gate's
--     monotonic take-over arm: retry liveness without a second operation
--     record).
--   - generation counts the drive attempts on the row (1 = the original).
--     A PENDING row whose driver died is RESOLVED THROUGH THE SAME ROW by
--     the recovering actor (the await-then-take-over in the provider): the
--     completion is a state CAS ('pending' → 'completed'), so concurrent or
--     late drivers CONVERGE to the one stored result — a dead driver's late
--     completion affects 0 rows and it replays the winner's submission.
--   - A future non-pure external provider (WORK-028/029 real platforms)
--     satisfies the same contract by forwarding the SAME key to the
--     platform's idempotency mechanism; this ledger remains the durable
--     WorkflowOS-side record of the operation identity + result.
--
-- THE NATIVE ARM (the explicit definition the round-8 review requires): the
-- durable NATIVE provider-operation ledger is wfos_agent_runs (migration
-- 0011) — the run row IS the native provider operation (creation + the
-- adapter execution), `execution_id TEXT NOT NULL UNIQUE` IS the
-- operation-key uniqueness (the keyed native dispatch derives its operation
-- identity from the durable execution identity), and the run's status/refs
-- ARE the operation result. Process-loss recovery on the native path is
-- converge-on-the-existing-run: a keyed submit whose run already exists
-- NEVER reaches the gateway (no second run creation, no second adapter
-- invocation). No new native table is needed — 0011 already IS the ledger;
-- the crash boundary around run creation / adapter invocation is proven by
-- the R8-#2 regression.
--
-- The rows are durable EXECUTION STATE (like the 0044 claim columns, the
-- 0045 epoch, the 0046 gate, the 0047 key): freely mutable through the
-- ledger state machine. NO immutability trigger applies (0043's trigger
-- guards only the handoff log's recorded intent).
--
-- Tenant scoping: NOT needed — the key is globally unique by construction
-- (`cross-mode-dispatch-<handoffId>` over UUID handoff ids; the handoff log
-- itself carries the project/tenant linkage via its execution record).

CREATE TABLE IF NOT EXISTS wfos_execution_provider_operations (
  idempotency_key TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  execution_id    TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'external',
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'completed', 'failed')),
  submission_json JSONB,
  error_message   TEXT,
  generation      INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wfos_execution_provider_operations_execution_idx
  ON wfos_execution_provider_operations (execution_id);
