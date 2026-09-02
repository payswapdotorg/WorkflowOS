-- V2-009 — Scheduling + Events + Placement (W4).
--
-- The durable deployment/subscription/event-inbox/trigger-delivery layer
-- (spec/architecture/v2/work-orders/V2-009.md; constitution §2 hierarchy:
-- WorkflowDeployment = the version-to-execution binding — the SAME immutable
-- version identity V2-002 pins; §11 events and triggers with stable
-- event/trigger correlation and idempotent duplicate delivery; §12 locality
-- as a correctness constraint; §19 forbidden drift).
--
--   WorkflowDeployment (this migration — the constitution §2 anchor)
--          └── TriggerSubscription          (schedule / event patterns)
--                 └── TriggerDelivery       (fire records: idempotency,
--                                          retry, placement resolution,
--                                          event/run correlation)
--   InboundEvent (the deduplicated per-tenant event inbox)
--
-- Invariants enforced HERE (survive a buggy application caller):
--
--   1. DEPLOYMENT PINNING: a deployment pins the EXACT (workflow, version)
--      tuple through the same composite foreign key discipline as the run
--      and installation pins. The placement policy columns are IMMUTABLE
--      after creation (a placement change is a new deployment).
--
--   2. CONVERGENCE SURFACES: deployment identity is deterministic over
--      (organization, workflow, version, name); subscription identity over
--      (deployment, kind, canonical spec); the event inbox over
--      (organization, source, event_id); delivery identity over
--      (subscription, trigger key). UNIQUE over exactly those inputs makes
--      duplicate submissions structurally converge — divergent duplicate
--      rows are unrepresentable.
--
--   3. DELIVERY STATE MACHINE: terminal states (delivered/converged/
--      missed/superseded/skipped_disabled/failed) are lifecycle-IMMUTABLE
--      (a BEFORE UPDATE trigger rejects transitions out of terminal); the
--      attempt list is append-only by trigger (the only sanctioned UPDATE
--      fills state/attempts/retry/placement/correlation columns — the
--      identity and trigger-key columns are immutable). DELETE is rejected
--      everywhere (durable history).
--
--   4. NO RUN ROWS: this migration never creates run state — every run is
--      created through the merged V2-005 boundary (wfos_v2_runs). The
--      delivery's run_id column is the event/run CORRELATION (deliberately
--      not an FK: a rejected delivery has no run; the run row is owned by
--      another module's table and referenced by identity only).
--
--   5. PRIVACY: the event inbox stores the one-way payload commitment ONLY
--      (never raw payloads); subscriptions store the typed match values
--      they declared (the user's own configuration, not event data).
--
-- V2 BOUNDARY NOTES (explicit, never silent):
--   - PostgreSQL is the authority (the work order): no in-memory trigger
--     state is a source of truth; PGlite is the Postgres-compatible
--     test/dev implementation of the same single persistence boundary.
--   - Event types/trigger types/placement ids are the FROZEN V2-CTRL-003
--     registry identifiers, verbatim (CHECK constraints here + the module's
--     no-drift vocabulary snapshot).
--   - WorkflowRun lifecycle is V2-005's: this migration stores only the
--     correlation surface.
--
-- Naming: the wfos_v2_ prefix marks the V2 generation tables; no V1 table is
-- touched — this migration is purely additive.

CREATE TABLE wfos_v2_deployments (
  -- Deterministic identity: application-derived from (organization,
  -- workflow, version, name) — authoritative inputs only.
  id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  -- The pinned EXACT immutable version (composite tuple integrity — the pin;
  -- the same discipline as wfos_v2_runs / wfos_v2_workflow_installations).
  workflow_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  -- The V2-002 installation pin when the deployment is installation-backed.
  installation_id TEXT REFERENCES wfos_v2_workflow_installations(id),
  name TEXT NOT NULL CHECK (name ~ '^[^\s].{0,127}$'),
  description TEXT,
  -- The execution placement policy (V2-004's contracts, stored verbatim).
  placement JSONB NOT NULL,
  privacy JSONB NOT NULL,
  min_trust_tier TEXT,
  -- User-visible enable/disable state (a disabled deployment never fires).
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_by_user_id UUID NOT NULL REFERENCES wfos_users(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  -- Convergence: duplicate create converges on the pin surface.
  CONSTRAINT wfos_v2_deployments_pin_uidx
    UNIQUE (organization_id, workflow_id, version_id, name),
  -- TUPLE INTEGRITY: the (workflow, version) pair must be a REAL version row
  -- of EXACTLY that workflow.
  CONSTRAINT wfos_v2_deployments_version_fk
    FOREIGN KEY (workflow_id, version_id)
    REFERENCES wfos_v2_workflow_versions (workflow_id, id)
);

CREATE INDEX wfos_v2_deployments_org_idx ON wfos_v2_deployments (organization_id);
CREATE INDEX wfos_v2_deployments_workflow_idx ON wfos_v2_deployments (workflow_id);

CREATE TABLE wfos_v2_trigger_subscriptions (
  -- Deterministic identity: application-derived from (deployment, kind,
  -- canonical spec).
  id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  deployment_id TEXT NOT NULL REFERENCES wfos_v2_deployments(id),
  -- schedule | event (manual launch needs no subscription).
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'event')),
  -- The validated schedule spec (schedule subscriptions; canonical JSON).
  schedule JSONB,
  -- The validated typed event pattern (event subscriptions; canonical JSON).
  event_pattern JSONB,
  -- The delivery policy (retry + missed-window; canonical JSON).
  delivery_policy JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- The schedule cursor: the last occurrence instant CONSIDERED (UTC ISO).
  cursor TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  -- Convergence: duplicate subscription create converges.
  CONSTRAINT wfos_v2_trigger_subscriptions_spec_uidx
    UNIQUE (deployment_id, kind, schedule, event_pattern)
);

CREATE INDEX wfos_v2_trigger_subscriptions_deployment_idx
  ON wfos_v2_trigger_subscriptions (deployment_id);
CREATE INDEX wfos_v2_trigger_subscriptions_org_kind_idx
  ON wfos_v2_trigger_subscriptions (organization_id, kind);

CREATE TABLE wfos_v2_inbound_events (
  -- Deterministic identity: application-derived from (organization, source,
  -- external event id) — the event dedup surface.
  id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  -- The producer-supplied event identity (with source, the idempotency key).
  event_id TEXT NOT NULL CHECK (event_id <> ''),
  -- Canonical registry event name (verbatim — no minted names).
  event_type TEXT NOT NULL CHECK (event_type LIKE '%.%'),
  -- The event source identity (idempotency key part 1).
  source TEXT NOT NULL CHECK (source <> ''),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  -- sha-256 over the canonical typed payload (PRIVACY: no raw persistence).
  payload_commitment TEXT NOT NULL CHECK (payload_commitment ~ '^[0-9a-f]{64}$'),
  -- Duplicate delivery converges on the producer identity surface.
  CONSTRAINT wfos_v2_inbound_events_source_uidx
    UNIQUE (organization_id, source, event_id)
);

CREATE INDEX wfos_v2_inbound_events_org_type_idx
  ON wfos_v2_inbound_events (organization_id, event_type);

CREATE TABLE wfos_v2_trigger_deliveries (
  -- Deterministic identity: application-derived from (subscription, trigger
  -- key) — the fire idempotency surface.
  id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES wfos_organizations(id),
  deployment_id TEXT NOT NULL REFERENCES wfos_v2_deployments(id),
  subscription_id TEXT NOT NULL REFERENCES wfos_v2_trigger_subscriptions(id),
  -- schedule | event (mirrors the subscription kind).
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'event')),
  -- schedule occurrence instant (ISO) | inbound event id.
  trigger_key TEXT NOT NULL,
  -- pending | delivered | converged | missed | superseded |
  -- skipped_disabled | failed.
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'converged', 'missed',
                     'superseded', 'skipped_disabled', 'failed')),
  -- The scheduled occurrence instant (schedule deliveries only).
  scheduled_at TIMESTAMPTZ,
  -- normal | gap_shifted | ambiguous_first (honest DST record).
  schedule_resolution TEXT
    CHECK (schedule_resolution IN ('normal', 'gap_shifted', 'ambiguous_first')),
  -- skip | catch_up_run_now (the missed-window policy applied, when it was).
  missed_window_applied TEXT CHECK (missed_window_applied IN ('skip', 'catch_up_run_now')),
  -- Append-only attempt audit (every attempt, in order).
  attempts JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(attempts) = 'array'),
  -- When the next retry is due (pending deliveries only).
  retry_at TIMESTAMPTZ,
  -- The placement resolution (V2-004 matcher output — consumed verbatim).
  resolved_node_id TEXT,
  resolved_placement TEXT,
  placement_rank INT,
  -- EVENT/RUN CORRELATION: the run created (or converged on). Deliberately
  -- NOT a foreign key: the run row belongs to V2-005's table and a
  -- rejected delivery has none — the correlation is by identity.
  run_id TEXT,
  -- The typed terminal failure (failed deliveries only).
  failure_code TEXT CHECK (failure_code IN (
    'TRIGGER_PLACEMENT_UNAVAILABLE', 'TRIGGER_RUN_REQUEST_REJECTED',
    'TRIGGER_DELIVERY_EXHAUSTED')),
  failure_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  -- Fire idempotency: one delivery per (subscription, trigger key).
  CONSTRAINT wfos_v2_trigger_deliveries_key_uidx
    UNIQUE (subscription_id, trigger_key)
);

CREATE INDEX wfos_v2_trigger_deliveries_deployment_idx
  ON wfos_v2_trigger_deliveries (deployment_id);
CREATE INDEX wfos_v2_trigger_deliveries_subscription_idx
  ON wfos_v2_trigger_deliveries (subscription_id);
CREATE INDEX wfos_v2_trigger_deliveries_pending_idx
  ON wfos_v2_trigger_deliveries (state, retry_at) WHERE state = 'pending';

-- The delivery lifecycle: terminal states are immutable, and no delivery is
-- ever deleted (durable trigger history).
CREATE OR REPLACE FUNCTION wfos_v2_trigger_delivery_lifecycle_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trigger deliveries are durable history (delete rejected)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state IN ('delivered', 'converged', 'missed', 'superseded',
                     'skipped_disabled', 'failed')
       AND NEW.state <> OLD.state THEN
      RAISE EXCEPTION 'terminal trigger delivery state % is immutable', OLD.state;
    END IF;
    IF NEW.state = 'pending' AND OLD.state <> 'pending' THEN
      RAISE EXCEPTION 'a terminal trigger delivery cannot return to pending';
    END IF;
    -- The identity surface is immutable by trigger.
    IF NEW.subscription_id <> OLD.subscription_id
       OR NEW.trigger_key <> OLD.trigger_key
       OR NEW.kind <> OLD.kind THEN
      RAISE EXCEPTION 'trigger delivery identity columns are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wfos_v2_trigger_deliveries_lifecycle
  BEFORE UPDATE OR DELETE ON wfos_v2_trigger_deliveries
  FOR EACH ROW EXECUTE FUNCTION wfos_v2_trigger_delivery_lifecycle_guard();
