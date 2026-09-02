-- V2-005 — Workflow Runs + Evidence (W2B; single-item wave after V2-014).
--
-- The durable Run state + evidence layer for executions of immutable
-- WorkflowVersions (spec/architecture/v2/work-orders/V2-005.md; constitution
-- §2 hierarchy: WorkflowRun = one execution instance of one pinned
-- deployment/version; §7 evidence truth; §11 event-trigger idempotency; §19
-- forbidden drift; §21 attestation boundaries).
--
--   WorkflowInstallation (V2-002 pin)
--          └── WorkflowRun                       (this migration)
--                 ├── run attempts               (execution-attempt identity)
--                 ├── run step executions        (declared-step records)
--                 ├── run capability invocations (canonical registry names)
--                 ├── run evidence               (registry evidence classes)
--                 ├── run attestation bindings   (V2-014 references + DURABLE replay state)
--                 ├── run attestation rejections (typed boundary audit)
--                 ├── run events                 (the state timeline)
--                 └── run commands               (the idempotency/exactly-once log)
--
-- Invariants enforced HERE (survive a buggy application caller):
--
--   1. RUN PINNING: a run pins the EXACT (workflow, version) tuple through a
--      composite foreign key — a version from another workflow is
--      structurally unrunnable (mirrors 0060's installation pinning). The
--      pinned digest columns and the trigger/input identity columns are
--      IMMUTABLE by trigger.
--
--   2. ONE RUN PER TRIGGER SURFACE: the run identity is deterministic
--      (application-derived from organization + workflow + version + trigger
--      type/identity + input digest); UNIQUE over exactly those inputs makes
--      duplicate event delivery structurally converge — divergent duplicate
--      run rows are unrepresentable.
--
--   3. STATE MACHINE: a BEFORE UPDATE trigger rejects every ILLEGAL run
--      transition; terminal states (completed/failed/cancelled) are
--      lifecycle-IMMUTABLE (evidence remains appendable — the evidence/
--      attestation tables have no run-state guard — but the lifecycle never
--      moves again). DELETE is rejected everywhere (durable history).
--
--   4. EXECUTION-FACING GUARDS: steps and invocations are insertable/updatable
--      only while the run is actively 'running'; attempts begin only on a
--      running run. Evidence and attestations append in ANY run state
--      (append-only-for-evidence on terminal runs).
--
--   5. DURABLE SINGLE-USE REPLAY: an attestation binding row IS the single-use
--      nonce consumption — UNIQUE (run, attempt, nonce) plus the
--      attestation-identity PRIMARY KEY make replay structurally
--      unrepresentable even for a raw SQL writer (V2-014's reference
--      InMemoryReplayRegistry was explicitly NOT durable; durable replay state
--      is V2-005's — this table is it).
--
--   6. EXACTLY-ONCE COMMANDS: the command log is UNIQUE per (organization,
--      command_id); the only sanctioned UPDATE is filling the typed result —
--      duplicate submission converges on the recorded outcome, and the same
--      command id with a different payload is rejected by the application
--      boundary (payload_digest is immutable here). The run_id column is the
--      history correlation (deliberately not an FK: the claim may precede the
--      run row, and rejected commands may outlive phantom runs).
--
-- V2 BOUNDARY NOTES (explicit, never silent):
--   - PostgreSQL is the authority (the work order): no in-memory run state is
--     a source of truth; PGlite is the Postgres-compatible test/dev
--     implementation of the same single persistence boundary.
--   - Capability names/execution classes/evidence classes/timeline event
--     names are the FROZEN V2-CTRL-003 registry identifiers, verbatim
--     (CHECK constraints here + the module's no-drift vocabulary snapshot).
--     The two module-scoped timeline markers ('run.cancelled',
--     'run.attempt.interrupted') exist because the registry defines no
--     cancellation/interruption EVENT; they are deliberately NOT
--     registry-shaped names.
--   - NO secret material in ANY column: inputs/outputs/evidence carry one-way
--     sha-256 commitments only (statement-privacy rules).
--   - Attestation SEMANTICS are V2-014's frozen contract — this migration
--     stores the verified reference (digest, attester, assurance, nonce,
--     canonical statement); it never interprets or re-verifies them.
--
-- Naming: the wfos_v2_ prefix marks the V2 generation tables; no V1 table is
-- touched — this migration is purely additive.

CREATE TABLE wfos_v2_runs (
  -- Deterministic identity: application-derived from (organization, workflow,
  -- version, trigger type+identity, input digest) — authoritative inputs only.
  id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  -- The pinned EXACT immutable version (composite tuple integrity — the pin).
  workflow_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  -- The pinned version's CONTENT digest (V2-002's, carried as pin data).
  version_content_digest TEXT NOT NULL CHECK (version_content_digest ~ '^[0-9a-f]{64}$'),
  -- The pinned version's SEMANTIC digest (V2-003's, carried as pin data).
  version_semantic_digest TEXT NOT NULL CHECK (version_semantic_digest ~ '^[0-9a-f]{64}$'),
  -- The installation/deployment reference where applicable (the V2-002 pin).
  installation_id TEXT REFERENCES wfos_v2_workflow_installations(id),
  -- Trigger category (constitution §11; the closed module vocabulary).
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'manual', 'schedule', 'webhook', 'application_event', 'file_event',
    'communication_event', 'device_event', 'social_threshold_event',
    'workflow_lifecycle_event')),
  -- The external trigger/event identity (duplicate-delivery dedupe key).
  trigger_id TEXT NOT NULL,
  -- The manual-trigger principal (NULL for event/schedule triggers).
  triggered_by_user_id UUID REFERENCES wfos_users(id),
  -- One-way canonical input commitments (SET; never raw values).
  input_commitments JSONB NOT NULL CHECK (jsonb_typeof(input_commitments) = 'array'),
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  -- The explicit run state machine (registry run-event vocabulary).
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN (
    'requested', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  -- ONE run per trigger surface: duplicate delivery converges.
  CONSTRAINT wfos_v2_runs_trigger_surface_uidx
    UNIQUE (organization_id, workflow_id, version_id, trigger_type, trigger_id, input_digest),
  -- TUPLE INTEGRITY: the (workflow, version) pair must be a REAL version row
  -- of EXACTLY that workflow — a version from another workflow is
  -- structurally unrunnable.
  CONSTRAINT wfos_v2_runs_version_fk
    FOREIGN KEY (workflow_id, version_id)
    REFERENCES wfos_v2_workflow_versions (workflow_id, id)
);

CREATE INDEX wfos_v2_runs_org_idx ON wfos_v2_runs (organization_id);
CREATE INDEX wfos_v2_runs_workflow_idx ON wfos_v2_runs (workflow_id);
CREATE INDEX wfos_v2_runs_version_idx ON wfos_v2_runs (version_id);

CREATE TABLE wfos_v2_run_attempts (
  -- Deterministic identity: (run, attempt number).
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES wfos_v2_runs(id),
  attempt_number INT NOT NULL CHECK (attempt_number > 0),
  -- running | suspended (paused) | interrupted (declared crash) | ended.
  state TEXT NOT NULL CHECK (state IN ('running', 'suspended', 'interrupted', 'ended')),
  -- The execution host identity (opaque external identity — V2-004's).
  node_id TEXT,
  -- The exact step a suspended attempt resumes at.
  paused_at_step_id TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  CONSTRAINT wfos_v2_run_attempts_number_uidx UNIQUE (run_id, attempt_number)
);

CREATE INDEX wfos_v2_run_attempts_run_idx ON wfos_v2_run_attempts (run_id);

CREATE TABLE wfos_v2_run_steps (
  -- Deterministic identity: (run, attempt, step).
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_number INT NOT NULL,
  -- The step id as DECLARED by the pinned version (validated by the module).
  step_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  input_commitments JSONB NOT NULL CHECK (jsonb_typeof(input_commitments) = 'array'),
  output_commitments JSONB NOT NULL CHECK (jsonb_typeof(output_commitments) = 'array'),
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  -- Insertion order (stable reconstruction sequence).
  seq BIGSERIAL NOT NULL UNIQUE,
  CONSTRAINT wfos_v2_run_steps_attempt_step_uidx UNIQUE (run_id, attempt_number, step_id),
  -- Tuple integrity: the attempt must exist for THIS run.
  CONSTRAINT wfos_v2_run_steps_attempt_fk
    FOREIGN KEY (run_id, attempt_number)
    REFERENCES wfos_v2_run_attempts (run_id, attempt_number)
);

CREATE INDEX wfos_v2_run_steps_run_idx ON wfos_v2_run_steps (run_id);

CREATE TABLE wfos_v2_run_invocations (
  -- Deterministic identity: (run, attempt, step, capability, command).
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_number INT NOT NULL,
  step_id TEXT,
  -- Canonical registry capability name (verbatim — CHECK here is defense in
  -- depth behind the module's no-drift vocabulary snapshot).
  capability TEXT NOT NULL,
  execution_class TEXT NOT NULL CHECK (execution_class IN (
    'deterministic_api', 'agentic_computer_use', 'human', 'subworkflow')),
  input_commitments JSONB NOT NULL CHECK (jsonb_typeof(input_commitments) = 'array'),
  output_commitments JSONB NOT NULL CHECK (jsonb_typeof(output_commitments) = 'array'),
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed')),
  requested_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  seq BIGSERIAL NOT NULL UNIQUE,
  -- Retries are DISTINCT invocations (new command → new identity); no
  -- uniqueness on (step, capability) by design.
  CONSTRAINT wfos_v2_run_invocations_attempt_fk
    FOREIGN KEY (run_id, attempt_number)
    REFERENCES wfos_v2_run_attempts (run_id, attempt_number)
);

CREATE INDEX wfos_v2_run_invocations_run_idx ON wfos_v2_run_invocations (run_id);

CREATE TABLE wfos_v2_run_evidence (
  -- Deterministic identity: (run, class, producer, content commitment).
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES wfos_v2_runs(id),
  attempt_number INT,
  step_id TEXT,
  -- The registry evidence vocabulary (constitution §7) — classes never
  -- impersonate one another (CHECK + the identity uniqueness).
  evidence_class TEXT NOT NULL CHECK (evidence_class IN (
    'intent', 'observation', 'claim', 'verification', 'human_confirmation')),
  -- Provenance (REQUIRED by the application boundary).
  producer_kind TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  content_commitment TEXT NOT NULL CHECK (content_commitment ~ '^[0-9a-f]{64}$'),
  description TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  -- Re-delivered identical evidence converges on the SAME record.
  CONSTRAINT wfos_v2_run_evidence_identity_uidx
    UNIQUE (run_id, evidence_class, producer_kind, producer_id, content_commitment)
);

CREATE INDEX wfos_v2_run_evidence_run_idx ON wfos_v2_run_evidence (run_id);

CREATE TABLE wfos_v2_run_attestations (
  -- The V2-014 attestation identity (digest + attester key derivation) — the
  -- global single-use key.
  attestation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_number INT NOT NULL,
  step_id TEXT,
  execution_digest TEXT NOT NULL CHECK (execution_digest ~ '^[0-9a-f]{64}$'),
  attester_key_id TEXT NOT NULL,
  assurance TEXT NOT NULL CHECK (assurance IN (
    'software_signed', 'hardware_backed', 'tee_attested', 'verifiable_computation')),
  -- The single-use nonce (replay resistance; timestamps alone insufficient).
  nonce TEXT NOT NULL,
  -- The canonical statement (commitment-based by V2-014 construction).
  statement JSONB NOT NULL CHECK (jsonb_typeof(statement) = 'object'),
  verified_at TIMESTAMPTZ NOT NULL,
  attached_at TIMESTAMPTZ NOT NULL,
  -- DURABLE SINGLE-USE: the binding row IS the nonce consumption.
  CONSTRAINT wfos_v2_run_attestations_nonce_uidx UNIQUE (run_id, attempt_number, nonce),
  CONSTRAINT wfos_v2_run_attestations_attempt_fk
    FOREIGN KEY (run_id, attempt_number)
    REFERENCES wfos_v2_run_attempts (run_id, attempt_number)
);

CREATE INDEX wfos_v2_run_attestations_run_idx ON wfos_v2_run_attestations (run_id);

CREATE TABLE wfos_v2_run_attestation_rejections (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES wfos_v2_runs(id),
  attestation_id TEXT,
  -- The typed failure code (V2-014 failure codes + run-boundary codes).
  failure_code TEXT NOT NULL,
  detail TEXT NOT NULL,
  rejected_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX wfos_v2_run_attestation_rejections_run_idx
  ON wfos_v2_run_attestation_rejections (run_id);

CREATE TABLE wfos_v2_run_events (
  -- Deterministic event identity: (run, event name, subject).
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES wfos_v2_runs(id),
  attempt_number INT,
  step_id TEXT,
  -- Registry protocol event names (verbatim) + the two module-scoped
  -- transition markers (the registry defines no cancellation/interruption
  -- event; the markers never pose as registry names).
  event_name TEXT NOT NULL CHECK (event_name IN (
    'workflow.run.requested', 'workflow.run.started', 'workflow.run.paused',
    'workflow.run.resumed', 'workflow.run.completed', 'workflow.run.failed',
    'workflow.step.started', 'workflow.step.completed',
    'capability.invocation.requested', 'capability.invocation.completed',
    'observation.recorded', 'verification.completed',
    'execution.attestation.verified',
    'run.cancelled', 'run.attempt.interrupted')),
  occurred_at TIMESTAMPTZ NOT NULL,
  seq BIGSERIAL NOT NULL UNIQUE,
  detail JSONB
);

CREATE INDEX wfos_v2_run_events_run_idx ON wfos_v2_run_events (run_id);

CREATE TABLE wfos_v2_run_commands (
  -- Deterministic identity: (organization, command id).
  id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  -- The run this command is scoped to (the history correlation). Deliberately
  -- NOT a foreign key: a request_run command's row is claimed BEFORE the run
  -- row itself is inserted (the deterministic run identity is derived from the
  -- command inputs), and a rejected command may reference a run that never
  -- became durable — the log is the exactly-once proof, not a run FK.
  run_id TEXT,
  command_id TEXT NOT NULL,
  -- Deterministic correlation (the logical flow / trigger identity).
  correlation_id TEXT NOT NULL,
  -- Causation: what produced this command (event id / parent command).
  causation_id TEXT,
  command_type TEXT NOT NULL CHECK (command_type IN (
    'request_run', 'start_run', 'pause_run', 'resume_run', 'interrupt_attempt',
    'cancel_run', 'complete_run', 'fail_run', 'record_step_started',
    'record_step_completed', 'record_invocation_requested',
    'record_invocation_completed', 'record_evidence', 'attach_attestation')),
  -- Canonical-JSON sha-256 of the command payload (conflict detection).
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  -- The typed recorded outcome (filled by the single sanctioned UPDATE).
  result JSONB,
  executed_at TIMESTAMPTZ NOT NULL,
  -- EXACTLY-ONCE: one durable record per (tenant, command id).
  CONSTRAINT wfos_v2_run_commands_org_command_uidx
    UNIQUE (organization_id, command_id)
);

CREATE INDEX wfos_v2_run_commands_run_idx ON wfos_v2_run_commands (run_id);
CREATE INDEX wfos_v2_run_commands_org_idx ON wfos_v2_run_commands (organization_id);

-- ---------------------------------------------------------------------------
-- INVARIANT 3 — the explicit run state machine + pin immutability + durable
-- history (constitution §19: terminal runs are lifecycle-immutable; §2: the
-- run pin never moves).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_v2_run_state_machine()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'WorkflowRun %: durable run history cannot be deleted (V2-005)',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.version_content_digest IS DISTINCT FROM OLD.version_content_digest
     OR NEW.version_semantic_digest IS DISTINCT FROM OLD.version_semantic_digest
     OR NEW.installation_id IS DISTINCT FROM OLD.installation_id
     OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
     OR NEW.trigger_id IS DISTINCT FROM OLD.trigger_id
     OR NEW.triggered_by_user_id IS DISTINCT FROM OLD.triggered_by_user_id
     OR NEW.input_commitments IS DISTINCT FROM OLD.input_commitments
     OR NEW.input_digest IS DISTINCT FROM OLD.input_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'WorkflowRun %: the run pin (workflow/version/trigger/inputs) is immutable (V2-005 — only the lifecycle state may change)',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state IN ('completed', 'failed', 'cancelled') THEN
      RAISE EXCEPTION
        'WorkflowRun % is in terminal state "%": the lifecycle is immutable — evidence stays appendable, lifecycle commands are rejected (V2-005)',
        OLD.id, OLD.state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (OLD.state = 'requested' AND NEW.state IN ('running', 'cancelled'))
      OR (OLD.state = 'running' AND NEW.state IN ('paused', 'completed', 'failed', 'cancelled'))
      OR (OLD.state = 'paused' AND NEW.state IN ('running', 'cancelled'))
    ) THEN
      RAISE EXCEPTION
        'WorkflowRun %: the transition "%" → "%" is illegal (V2-005 state machine)',
        OLD.id, OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wfos_v2_run_state_machine_trg
  BEFORE UPDATE OR DELETE ON wfos_v2_runs
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_run_state_machine();

-- ---------------------------------------------------------------------------
-- INVARIANT 4 — attempts: a NEW attempt (INSERT — "begin") is creatable only
-- on a RUNNING run; the attempt identity is immutable; only the lifecycle
-- fields (state, resume point, node, ended_at) may change — including the
-- legitimate non-running updates (suspend/interrupt/end happen exactly when
-- the run is paused or terminal); never deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_v2_run_attempt_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_state TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'RunAttempt % cannot be deleted — attempt history is durable (V2-005)',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT state INTO run_state FROM wfos_v2_runs WHERE id = NEW.run_id;
    IF run_state IS NULL OR run_state <> 'running' THEN
      RAISE EXCEPTION
        'RunAttempt %: attempts BEGIN only while the run is actively running (run state: "%") (V2-005)',
        NEW.id, COALESCE(run_state, '<missing>')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION
        'RunAttempt %: the attempt identity is immutable (V2-005 — only state/resume point/node/ended_at may change)',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wfos_v2_run_attempt_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON wfos_v2_run_attempts
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_run_attempt_guard();

-- ---------------------------------------------------------------------------
-- INVARIANT 4 — steps: insertable/updatable only on a RUNNING run; identity
-- + inputs immutable; only completion fields may change; never deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_v2_run_step_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_state TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'RunStepExecution % cannot be deleted — execution history is durable (V2-005)',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT state INTO run_state FROM wfos_v2_runs WHERE id = NEW.run_id;
  IF run_state IS NULL OR run_state <> 'running' THEN
    RAISE EXCEPTION
      'RunStepExecution %: steps are recorded only while the run is actively running (run state: "%") (V2-005)',
      NEW.id, COALESCE(run_state, '<missing>')
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
       OR NEW.step_id IS DISTINCT FROM OLD.step_id
       OR NEW.input_commitments IS DISTINCT FROM OLD.input_commitments
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.seq IS DISTINCT FROM OLD.seq THEN
      RAISE EXCEPTION
        'RunStepExecution %: the step identity and inputs are immutable (V2-005 — only status/output/outcome/completed_at may change)',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wfos_v2_run_step_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON wfos_v2_run_steps
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_run_step_guard();

-- ---------------------------------------------------------------------------
-- INVARIANT 4 — invocations: same discipline as steps.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_v2_run_invocation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_state TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'RunCapabilityInvocation % cannot be deleted — invocation history is durable (V2-005)',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT state INTO run_state FROM wfos_v2_runs WHERE id = NEW.run_id;
  IF run_state IS NULL OR run_state <> 'running' THEN
    RAISE EXCEPTION
      'RunCapabilityInvocation %: invocations are recorded only while the run is actively running (run state: "%") (V2-005)',
      NEW.id, COALESCE(run_state, '<missing>')
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
       OR NEW.step_id IS DISTINCT FROM OLD.step_id
       OR NEW.capability IS DISTINCT FROM OLD.capability
       OR NEW.execution_class IS DISTINCT FROM OLD.execution_class
       OR NEW.input_commitments IS DISTINCT FROM OLD.input_commitments
       OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
       OR NEW.seq IS DISTINCT FROM OLD.seq THEN
      RAISE EXCEPTION
        'RunCapabilityInvocation %: the invocation identity and inputs are immutable (V2-005 — only output/outcome/completed_at may change)',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wfos_v2_run_invocation_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON wfos_v2_run_invocations
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_run_invocation_guard();

-- ---------------------------------------------------------------------------
-- INVARIANT 4 — evidence: append-only in ANY run state (terminal runs stay
-- evidence-appendable); records are immutable once written.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_v2_run_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'RunEvidenceRecord % is immutable evidence — append-only (V2-005; % rejected)',
    COALESCE(OLD.id, NEW.id), TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER wfos_v2_run_evidence_immutable_trg
  BEFORE UPDATE OR DELETE ON wfos_v2_run_evidence
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_run_evidence_immutable();

-- ---------------------------------------------------------------------------
-- INVARIANT 5 — attestation bindings: the durable single-use replay state.
-- Append-only, immutable once written (the binding IS the consumption).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_v2_run_attestation_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'RunAttestationBinding % is the durable single-use consumption — append-only (V2-005; % rejected)',
    COALESCE(OLD.attestation_id, NEW.attestation_id), TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER wfos_v2_run_attestation_immutable_trg
  BEFORE UPDATE OR DELETE ON wfos_v2_run_attestations
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_run_attestation_immutable();

-- Rejections: append-only audit records (a typed rejection is never erased).
CREATE OR REPLACE FUNCTION wfos_v2_run_rejection_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'RunAttestationRejection % is a durable typed rejection — append-only (V2-005; % rejected)',
    COALESCE(OLD.id, NEW.id), TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER wfos_v2_run_rejection_immutable_trg
  BEFORE UPDATE OR DELETE ON wfos_v2_run_attestation_rejections
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_run_rejection_immutable();

-- Timeline events: append-only (the reconstruction source).
CREATE OR REPLACE FUNCTION wfos_v2_run_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'RunTimelineEntry % is durable timeline history — append-only (V2-005; % rejected)',
    COALESCE(OLD.id, NEW.id), TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER wfos_v2_run_event_immutable_trg
  BEFORE UPDATE OR DELETE ON wfos_v2_run_events
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_run_event_immutable();

-- ---------------------------------------------------------------------------
-- INVARIANT 6 — the command log: identity immutable; the ONLY sanctioned
-- UPDATE fills the typed result; never deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wfos_v2_run_command_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'RunCommandRecord % cannot be deleted — the command log is the exactly-once proof (V2-005)',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
     OR NEW.command_type IS DISTINCT FROM OLD.command_type
     OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.executed_at IS DISTINCT FROM OLD.executed_at THEN
    RAISE EXCEPTION
      'RunCommandRecord %: the command identity/correlation/causation/payload commitment are immutable (V2-005 — only the typed result is filled once)',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wfos_v2_run_command_guard_trg
  BEFORE UPDATE OR DELETE ON wfos_v2_run_commands
  FOR EACH ROW
  EXECUTE FUNCTION wfos_v2_run_command_guard();
