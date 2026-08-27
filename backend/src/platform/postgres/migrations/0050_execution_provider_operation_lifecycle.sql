-- WORK-042 (PR #46 round 10): the EXPLICIT PROVIDER-OPERATION LIFECYCLE —
-- the correction of the round-9 attach-before-body protocol.
--
-- The round-9 review verdict (REQUEST CHANGES) found the round-9 protocol's
-- central assertion INVALID:
--
--     openOperation()
--         ↓
--     attachOperation()   ← durable commit
--         ↓
--     generate()          ← the operation body
--
-- There is an unavoidable crash window between the attach commit and the
-- operation body: T1 attaches handle H, DIES, and generate() NEVER RUNS. The
-- durable row then claims providerOperationHandle = H, and every recovery
-- driver takes the resolve-by-identity branch and NEVER executes the body —
-- the operation can remain permanently unexecuted while the ledger proceeds
-- as though an operation exists. A recorded LOCAL identity persisted BEFORE
-- the provider call proves NOTHING about the provider operation:
--
--     THE DATABASE MUST NEVER INFER THAT AN IRREVERSIBLE PROVIDER OPERATION
--     HAPPENED MERELY BECAUSE WORKFLOWOS PERSISTED AN INTENDED IDENTITY.
--
-- THE ROUND-10 CORRECTION (the review's preferred shape — the provider
-- boundary itself is idempotent):
--
--     durable operation key
--         ↓
--     provider-specific start/submit(key)     ← IDEMPOTENT BY KEY (the contract)
--         ↓
--     provider returns durable operation identity
--         ↓
--     attach (pending → started)              ← recorded AFTER the confirmation
--         ↓
--     resolve(key/identity) → one terminal result
--
--   - startOperation(key) is the SUBMISSION seam. Its CONTRACT is
--     idempotency-by-key: invoking it again for a key that already owns a
--     provider operation MUST CONVERGE onto that ONE operation (returning
--     its identity), NEVER start a second one — exactly like a platform
--     idempotency key. This guarantee makes EVERY crash point safe:
--       * crash BEFORE the provider accepted → re-submission performs the
--         FIRST execution;
--       * crash AFTER the provider accepted, BEFORE the ledger attach →
--         re-submission CONVERGES onto the operation the crash interrupted
--         (the PROVIDER's key→operation mapping is the authority, never the
--         ledger row).
--     A local UUID/derived string written to PostgreSQL before the provider
--     call establishes NEITHER guarantee — which is why the identity is now
--     recorded only AFTER the provider confirmed it.
--   - state 'pending' means the submission is NOT durably confirmed on the
--     row (the operation may or may not exist at the provider — the
--     idempotent submission makes BOTH states safe to re-drive). It carries
--     NO handle: the ledger makes NO claim about the provider.
--   - state 'started' means the provider CONFIRMED the ONE operation exists
--     (startOperation returned its identity at some generation; the handle
--     was attached after that). Recovery resolves the CONFIRMED operation by
--     its identity (resolveOperation — a status fetch for a platform
--     provider; re-derivation for the PURE default provider, justified by
--     its declared purity).
--   - complete() requires state = 'started': a terminal SUCCESS is only
--     recordable for a CONFIRMED operation — the database structurally
--     cannot record a terminal success for an operation it never observed
--     starting. fail() accepts pending OR started (a failed submission or
--     resolution may terminally fail the key from either non-terminal state).
--   - takeOver() accepts pending OR started (both are non-terminal,
--     unresolved) and still returns the new generation token (the round-9
--     fencing is retained: a stale generation is structurally incapable of
--     resolving the operation).
--
-- LEGACY ROWS: round-9 semantics could leave state = 'pending' WITH a
-- provider_operation_handle (the attach-before-body ordering). Such a handle
-- was an UNPROVEN intended identity — the exact inference this migration
-- removes. In-flight legacy rows are reset to the honest 'pending' state with
-- the handle cleared: recovery re-submits under the idempotent-by-key
-- contract, which is safe whether or not the operation ever started (for the
-- current pure provider the identity is key-derived and re-submission
-- re-derives the same value; a platform provider re-fetches the same
-- operation). TERMINAL rows are untouched (their handles are immaterial).
--
-- The rows are durable EXECUTION STATE (like the 0044 claim columns, the
-- 0045 epoch, the 0046 gate, the 0047 key, the 0048 ledger, the 0049
-- columns): freely mutable through the ledger state machine. NO immutability
-- trigger applies (0043's trigger guards only the handoff log's recorded
-- intent).
--
-- THE NATIVE ARM (unchanged by round 10 in its ledger identity — AgentRun is
-- the durable native operation ledger — but CORRECTED in its convergence
-- semantics): an existing run row is the durable record that the ONE native
-- operation exists, but EXISTING ≠ COMPLETED. wfos_agent_runs.status is a
-- lifecycle (pending | in_progress | success | failed | cancelled); the
-- native convergence maps ONLY terminal statuses (success → completed,
-- failed/cancelled → failed) and a NON-TERMINAL existing run is
-- AWAITED/RECONCILED until terminal — a keyed submit NEVER manufactures
-- ExecutionSubmission.status = 'completed' from the mere existence of the
-- ledger row, and NEVER starts a second run (the execution_id UNIQUE is the
-- ledger authority).

ALTER TABLE wfos_execution_provider_operations
  DROP CONSTRAINT IF EXISTS wfos_execution_provider_operations_state_check;

ALTER TABLE wfos_execution_provider_operations
  ADD CONSTRAINT wfos_execution_provider_operations_state_check
    CHECK (state IN ('pending', 'started', 'completed', 'failed'));

-- The legacy reset: a round-9 'pending' row WITH a handle carries an UNPROVEN
-- intended identity (attach preceded the body). Clear it — the row makes NO
-- claim about the provider; recovery re-submits (idempotent by key).
UPDATE wfos_execution_provider_operations
   SET provider_operation_handle = NULL,
       operation_attached_at = NULL,
       updated_at = NOW()
 WHERE state = 'pending'
   AND provider_operation_handle IS NOT NULL;
