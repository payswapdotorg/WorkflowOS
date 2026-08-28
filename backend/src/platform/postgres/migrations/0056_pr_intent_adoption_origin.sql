-- WORK-051 round 4 (PR #52 review, BLOCKER 2) — the explicit durable
-- ADOPTION identity on the governed PR-intent ledger.
--
-- Round 3 left the external-PR ADOPTION path (resolve external PR →
-- checkpoint → associate → PR_OPEN) OUTSIDE the wfos_pull_request_intents
-- ledger: only the CREATION path was durably keyed by (work_item_id,
-- head_revision). Two concurrent agent_run_completed signals carrying the
-- same external PR could both pass the read-then-associate check and race
-- into two association attempts, and — more fundamentally — the external
-- observation was not represented by the same durable (work item,
-- authoritative head revision) identity the creation path uses.
--
-- Round 4 unifies them: BOTH governed paths converge through THE SAME
-- durable identity boundary. `origin` records WHICH path recorded the
-- identity, making the adoption durable and observable:
--
--   origin = 'created' — the platform CREATED the PR through the governed
--                        port (the create-or-converge protocol);
--   origin = 'adopted' — the platform CONVERGED on an externally observed
--                        PR (association-only; no creation side effect),
--                        keyed by the /github-resolved authoritative head
--                        commit SHA.
--
-- The invariant both paths now prove at the persistence layer:
--
--   For one (work item, authoritative head commit), all governed paths —
--   create and adopt — converge on EXACTLY ONE PR identity/association.
--
-- Same-key callers (create vs adopt, adopt vs adopt, create vs create)
-- serialize through the intent row (SELECT ... FOR UPDATE inside the
-- protocol transaction); a DIFFERENT PR identity claiming the same key is
-- a typed conflict that fails closed — never a silent second association.

ALTER TABLE wfos_pull_request_intents
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'created'
  CHECK (origin IN ('created', 'adopted'));
