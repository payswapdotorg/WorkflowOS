-- WORK-051 round 2 (PR #52 review, BLOCKER 2) — the durable governed
-- PR-creation intent ledger owned by /workflows.
--
-- The governed convergence path creates the implementation PR through an
-- EXTERNAL GitHub mutation (GithubBackedPullRequestCreationPort → /github).
-- The external side effect cannot be part of the database transaction:
-- if the process dies after GitHub created the PR but before the creation
-- result is durably recorded, a naive retry invokes createPullRequest AGAIN
-- — a second PR for the same logical change. WorkflowOS's convergence model
-- explicitly assumes reprocessing after failure/restart, so this interleaving
-- is the COMMON case, not an edge case.
--
-- The fix is the standard create-or-converge pattern on a DURABLE identity:
-- the logical key is (work_item_id, head_revision) — the Work Item plus the
-- EXACT implementation revision the architecture checkpoint gated on. The
-- intent row is inserted/locked (SELECT ... FOR UPDATE) BEFORE the external
-- call, and the created PR identity is recorded IN THE SAME TRANSACTION as
-- the create. A crash before COMMIT rolls the intent back; the retry then
-- CONVERGES through the provider's PR lookup by the DETERMINISTIC head
-- branch (a pure function of the same key) instead of creating again.
--
-- /workflows owns this table (it owns lifecycle transitions and PR
-- associations); /github stays the external PR authority; /verification is
-- untouched. No second workflow or PR engine is introduced — this is the
-- durable idempotency substrate of the EXISTING PR-creation boundary.

CREATE TABLE wfos_pull_request_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The convergence key: the logical Work Item + the EXACT implementation
  -- revision the checkpoint gated on. Retry/crash/duplicate-signal re-drives
  -- of the SAME (work item, revision) converge on ONE PR; a NEW revision
  -- (e.g. a correction cycle) is a NEW key and opens a NEW PR.
  work_item_id TEXT NOT NULL,
  head_revision TEXT NOT NULL,
  -- 'pending'  — inserted, the external create is in flight (or crashed).
  -- 'created'  — the external PR exists; external_pr_id is authoritative.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'created')),
  -- The provider-independent PR identity (e.g. 'github:owner/repo#12').
  -- NULL while pending; NOT NULL once created (enforced below).
  external_pr_id TEXT,
  -- The PR head commit reported by the PR authority (NULL when unknown).
  head_commit TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ONE governed PR per (work item, implementation revision) — the durable
  -- identity that makes create-or-converge possible. Concurrent callers
  -- serialize on this row (SELECT ... FOR UPDATE inside the protocol
  -- transaction); exactly one create attempt survives per key.
  CONSTRAINT wfos_pull_request_intents_key_uidx
    UNIQUE (work_item_id, head_revision),
  CONSTRAINT wfos_pull_request_intents_created_has_pr
    CHECK (status <> 'created' OR external_pr_id IS NOT NULL)
);
