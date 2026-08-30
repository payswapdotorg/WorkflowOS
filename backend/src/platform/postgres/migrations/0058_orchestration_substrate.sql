-- WORK-062 — Durable Multi-Agent Orchestration Substrate.
--
-- The substrate is the durable orchestration layer UNDERNEATH WORK-046
-- delegation (spec/work-orders/WORK-062.md): it makes every delegated
-- execution durable, convergent, and safely recoverable — across crashes,
-- restarts, coordinator loss, concurrent drivers, and external
-- (native/external) execution — WITHOUT becoming a second authority:
--
--   - NOT a second delegation authority: every row REFERENCES an existing
--     delegation plan/unit (wfos_delegation_*); delegation semantics stay in
--     WORK-046's governed surface.
--   - NOT a second execution authority: the substrate records only the
--     orchestration view (leases, fencing generations, durable dependency
--     admission, explicit partial completion); the execution identity
--     referenced here is the EXISTING one (wfos_delegation_attempts.
--     execution_id -> wfos_executions), never a new one.
--   - NOT a workflow engine: the statuses below are ORCHESTRATION
--     vocabulary, structurally disjoint from the frozen WorkflowState set
--     and from the WORK-046 coordination vocabulary.
--   - NOT Redis-backed: PostgreSQL is authoritative; Redis is never used.
--
-- Identity (durable, survives retries/restart/ownership transfer):
--   graph — ONE orchestration graph per delegation plan (UNIQUE (plan_id)):
--           the same (work_item_id, plan_key) delegation request converges
--           on ONE plan (WORK-046) and therefore ONE graph.
--   node  — ONE orchestration node per delegation unit (UNIQUE (unit_id))
--           and per (graph, node_key): the stable logical node identity.
--
-- Tenancy: every row carries project_id (resolved server-side from the Work
-- Item's project); ALL substrate queries are project-scoped. Dependencies
-- are node keys WITHIN one graph (validated at graph creation), so a
-- dependency graph can never cross a tenant boundary.
--
-- PERSISTENCE-LAYER IDENTITY/TENANT INTEGRITY (round-1 architect remediation
-- on PR #82): the relationships below are enforced as TUPLES by PostgreSQL
-- itself — composite foreign keys + the graph tenant-guard trigger — so the
-- chain
--
--   orchestration graph → exact delegation plan → exact delegation unit
--                     → the SAME Work Item / the SAME project
--
-- is STRUCTURALLY enforced and survives a buggy application caller. The
-- plain single-column FKs (which only prove the referenced row EXISTS
-- SOMEWHERE) stay; the composite constraints make the cross-references
-- consistent:
--
--   graph (plan_id, work_item_id) → delegation_plans (id, work_item_id)
--     the plan belongs to exactly that Work Item (WORK-046 P1),
--   node (unit_id, plan_id)      → delegation_units (id, plan_id)
--     the unit belongs to exactly that plan,
--   node (graph_id, plan_id)     → orchestration_graphs (id, plan_id)
--     the node's plan IS its graph's plan,
--   node (graph_id, project_id)  → orchestration_graphs (id, project_id)
--     the node's tenant IS its graph's tenant,
--   graph.project_id             = the Work Item's project (through the
--     authoritative work item → architecture version → architecture chain)
--     — enforced by wfos_orchestration_graph_tenant_guard (a BEFORE
--     trigger, the same defense-in-depth form as the dependency gate).
--
-- Concurrency invariants enforced HERE (survive a buggy application caller):
--   - lease exclusivity: ownership acquisition is a single conditional
--     UPDATE (owner free-or-expired) — at most one active owner per node,
--     even with concurrent coordinators on independent connections;
--   - fencing: every ownership change bumps `generation` (the fencing
--     token); EVERY node-state mutation is generation-fenced at the mutation
--     boundary (UPDATE ... WHERE generation = $n AND owner_id = $owner), so
--     a stale worker is STRUCTURALLY INCAPABLE of mutating a node after
--     ownership has moved elsewhere;
--   - durable dependency admission: dispatch-lease acquisition additionally
--     requires every dependency's DURABLE outcome to be 'succeeded' (the
--     NOT EXISTS gate in the repository SQL) — a dependent node cannot even
--     acquire a dispatch lease until its dependencies' durable outcomes
--     admit it.

-- ---------------------------------------------------------------------------
-- Enabling composite keys on the EXISTING delegation tables (0057). These
-- are ADDITIVE and NON-SEMANTIC — `id` is already the primary key, so the
-- tuple (id, …) is unique by construction; the composite UNIQUE constraints
-- exist purely so the orchestration tables below can reference the TUPLES
-- (a plain FK can only prove existence, never consistency). No delegation
-- semantics change: WORK-046 remains the delegation authority.
-- ---------------------------------------------------------------------------
ALTER TABLE wfos_delegation_plans
  ADD CONSTRAINT wfos_delegation_plans_id_work_item_uidx
  UNIQUE (id, work_item_id);

ALTER TABLE wfos_delegation_units
  ADD CONSTRAINT wfos_delegation_units_id_plan_uidx
  UNIQUE (id, plan_id);

CREATE TABLE wfos_orchestration_graphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TENANT scope (server-resolved; never caller-controlled).
  project_id UUID NOT NULL REFERENCES wfos_projects(id),
  -- The owning Work Item (ONE Work Item per plan — WORK-046 P1).
  work_item_id UUID NOT NULL REFERENCES wfos_work_items(id),
  -- ONE orchestration graph per EXISTING delegation plan.
  plan_id UUID NOT NULL REFERENCES wfos_delegation_plans(id) ON DELETE CASCADE,
  -- ORCHESTRATION status (NOT a WorkflowState, NOT a delegation status):
  --   orchestrating — no terminal node outcome yet
  --   partial       — EXPLICIT partial completion: >=1 terminal outcome and
  --                   not every node succeeded (3/10 is PARTIAL — never
  --                   collapsed into success or failure; observable and
  --                   resumable)
  --   converged     — every node's durable outcome is 'succeeded'
  --   abandoned     — the underlying plan was interrupted (mirror; durable
  --                   evidence is NEVER erased)
  status TEXT NOT NULL DEFAULT 'orchestrating'
    CHECK (status IN ('orchestrating', 'partial', 'converged', 'abandoned')),
  -- Durable node tally (recomputed transactionally with every fenced
  -- outcome — the explicit partial-completion record).
  total_nodes INT NOT NULL CHECK (total_nodes >= 0),
  succeeded_count INT NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count INT NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  unresolved_count INT NOT NULL DEFAULT 0 CHECK (unresolved_count >= 0),
  cancelled_count INT NOT NULL DEFAULT 0 CHECK (cancelled_count >= 0),
  -- Deterministic-reconciliation audit: how many reconcile passes have run.
  reconciliation_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The durable orchestration identity: one graph per delegation plan.
  CONSTRAINT wfos_orchestration_graphs_plan_uidx
    UNIQUE (plan_id),
  -- Tuple keys for the composite FKs below (a composite FK can only
  -- reference a unique key; these are unique by construction since id is
  -- the primary key — they exist for referential integrity, not identity).
  CONSTRAINT wfos_orchestration_graphs_id_plan_uidx
    UNIQUE (id, plan_id),
  CONSTRAINT wfos_orchestration_graphs_id_project_uidx
    UNIQUE (id, project_id),
  -- PERSISTENCE-LAYER INTEGRITY: the graph's plan IS the plan of the
  -- graph's Work Item — PostgreSQL rejects a (plan_id, work_item_id)
  -- combination that is not a real delegation plan row. A graph claiming
  -- another Work Item's plan is structurally unrepresentable.
  CONSTRAINT wfos_orchestration_graphs_plan_work_item_fk
    FOREIGN KEY (plan_id, work_item_id)
    REFERENCES wfos_delegation_plans (id, work_item_id)
    ON DELETE CASCADE
);

CREATE INDEX wfos_orchestration_graphs_project_idx ON wfos_orchestration_graphs (project_id);
CREATE INDEX wfos_orchestration_graphs_work_item_idx ON wfos_orchestration_graphs (work_item_id);

CREATE TABLE wfos_orchestration_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id UUID NOT NULL REFERENCES wfos_orchestration_graphs(id) ON DELETE CASCADE,
  -- TENANT scope (denormalized from the graph's project — every node query
  -- is project-scoped; a cross-tenant node read is structurally impossible
  -- through the substrate's scoped queries).
  project_id UUID NOT NULL REFERENCES wfos_projects(id),
  -- The owning plan (denormalized from the graph FOR tuple integrity: it is
  -- the composite-FK key that makes a node whose unit/plan/graph/project
  -- combination is structurally impossible unrepresentable in PostgreSQL).
  plan_id UUID NOT NULL,
  -- ONE node per EXISTING delegation unit (the stable delegation identity).
  unit_id UUID NOT NULL REFERENCES wfos_delegation_units(id) ON DELETE CASCADE,
  -- Mirrors the unit's key (the caller's stable logical key within the plan).
  node_key TEXT NOT NULL,
  -- The DURABLE dependency constraints (node keys WITHIN the same graph —
  -- validated at graph creation; a dependency graph cannot cross tenants).
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Ownership / lease (exclusive; deterministic semantics):
  --   owner_id        — the current owner (NULL = free)
  --   generation      — the fencing token; bumped on EVERY ownership change
  --   lease_expires_at— the lease deadline (liveness only — expiry alone
  --                     does NOT fence; TAKEOVER fences via generation)
  owner_id TEXT,
  generation INT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lease_expires_at TIMESTAMPTZ,
  -- The CURRENT delegated execution reference — the EXISTING execution
  -- identity (wfos_delegation_attempts.execution_id -> wfos_executions) and
  -- its attempt number. A cache for orchestration queries; the delegation
  -- attempt rows remain authoritative and a crash between attempt
  -- allocation and this cache converges on the next re-drive.
  execution_id TEXT,
  attempt_no INT CHECK (attempt_no IS NULL OR attempt_no > 0),
  -- The orchestration outcome (OBSERVED from the delegation attempt
  -- outcome, which observes the existing execution record — the substrate
  -- never derives outcomes from its own engine):
  --   NULL        — not terminal (pending / in flight)
  --   succeeded   — the current attempt's execution succeeded
  --   failed      — the current attempt's execution failed
  --   unresolved  — honest limbo (no provable provider side effect)
  --   cancelled   — the unit was pending at interruption (mirror)
  outcome TEXT
    CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'unresolved', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ONE node per logical unit key within the graph.
  CONSTRAINT wfos_orchestration_nodes_key_uidx
    UNIQUE (graph_id, node_key),
  -- ONE node per delegation unit (the unit identity is global).
  CONSTRAINT wfos_orchestration_nodes_unit_uidx
    UNIQUE (unit_id),
  -- PERSISTENCE-LAYER INTEGRITY (composite FKs — defense against a buggy
  -- application caller; the chain graph → plan → unit → Work Item/project
  -- cannot be corrupted even by a raw SQL writer):
  --   the node's unit belongs to the node's EXACT plan,
  CONSTRAINT wfos_orchestration_nodes_unit_plan_fk
    FOREIGN KEY (unit_id, plan_id)
    REFERENCES wfos_delegation_units (id, plan_id)
    ON DELETE CASCADE,
  --   the node's plan IS its graph's plan,
  CONSTRAINT wfos_orchestration_nodes_graph_plan_fk
    FOREIGN KEY (graph_id, plan_id)
    REFERENCES wfos_orchestration_graphs (id, plan_id)
    ON DELETE CASCADE,
  --   the node's tenant IS its graph's tenant.
  CONSTRAINT wfos_orchestration_nodes_graph_project_fk
    FOREIGN KEY (graph_id, project_id)
    REFERENCES wfos_orchestration_graphs (id, project_id)
    ON DELETE CASCADE
);

CREATE INDEX wfos_orchestration_nodes_graph_idx ON wfos_orchestration_nodes (graph_id);
CREATE INDEX wfos_orchestration_nodes_project_idx ON wfos_orchestration_nodes (project_id);

-- GRAPH TENANT GUARD (round-1 architect remediation): the graph's tenant is
-- the Work Item's project, resolved through the AUTHORITATIVE chain
-- (work item → architecture version → architecture → project) — the same
-- chain every existing route uses. A graph claiming a different project
-- than its Work Item's is structurally unrepresentable: the trigger rejects
-- the row BEFORE it is stored, regardless of which caller wrote it.
CREATE OR REPLACE FUNCTION wfos_orchestration_graph_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  wi_project UUID;
BEGIN
  SELECT a.project_id
    INTO wi_project
    FROM wfos_work_items wi
    JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
    JOIN wfos_architectures a ON a.id = av.architecture_id
   WHERE wi.id = NEW.work_item_id;

  IF wi_project IS NULL THEN
    RAISE EXCEPTION 'orchestration graph references unknown work item %',
      NEW.work_item_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF wi_project <> NEW.project_id THEN
    RAISE EXCEPTION
      'orchestration graph tenant mismatch: work item % belongs to project %, the graph claims project %',
      NEW.work_item_id, wi_project, NEW.project_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wfos_orchestration_graph_tenant_guard_trg
BEFORE INSERT OR UPDATE OF project_id, work_item_id ON wfos_orchestration_graphs
FOR EACH ROW
EXECUTE FUNCTION wfos_orchestration_graph_tenant_guard();

-- DEPENDENCY GATE INVARIANT (defense in depth): a node that has NEVER been
-- dispatched (no execution reference, no outcome) may not acquire an owner
-- while any declared dependency has a non-succeeded durable outcome. The
-- repository's dispatch-lease acquisition UPDATE enforces exactly this at
-- the mutation boundary; this trigger makes even a buggy caller
-- structurally incapable of leasing a never-dispatched node whose
-- dependencies are not durably satisfied. Retry and re-drive (an execution
-- reference or a terminal outcome already exists) are NOT gated here —
-- retry preserves the WORK-046 semantics (a unit that already ran may be
-- retried regardless of its dependencies' current state).
CREATE OR REPLACE FUNCTION wfos_orchestration_node_dependency_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  blocked INT;
BEGIN
  IF NEW.owner_id IS NOT NULL
     AND NEW.execution_id IS NULL
     AND NEW.outcome IS NULL THEN
    SELECT COUNT(*) INTO blocked
      FROM wfos_orchestration_nodes d
     WHERE d.graph_id = NEW.graph_id
       AND d.outcome IS DISTINCT FROM 'succeeded'
       AND d.node_key IN (SELECT jsonb_array_elements_text(NEW.depends_on));
    IF blocked > 0 THEN
      RAISE EXCEPTION
        'orchestration node % cannot acquire a dispatch lease: % declared dependenc(y|ies) not durably satisfied',
        NEW.node_key, blocked
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wfos_orchestration_node_dependency_gate_guard
BEFORE INSERT OR UPDATE OF owner_id ON wfos_orchestration_nodes
FOR EACH ROW
EXECUTE FUNCTION wfos_orchestration_node_dependency_gate();
