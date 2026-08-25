-- WORK-038 PR #42 round-3: the governed repository-read boundary made real.
--
-- The architect's round-3 review identified the single remaining architectural
-- blocker: the "governed read" was NOT actually governed at the operation
-- boundary. The round-2 path was a check-then-act window —
--     PolicyGate.decideForProjectScope()            (decision at T1)
--       -> if allow/constrained
--         -> GitHubAdapter.getFileContent/listDir()  (read at T2 > T1)
-- with NOTHING atomic tying the authorization decision to the actual read,
-- and `constrained` having no concrete enforcement effect (the same GitHub
-- request happened regardless of allow vs constrained). Worse, because the
-- round-2 evidence row recorded BOTH tool_invocation_id=NULL (correct — not a
-- Tool Runtime invocation) AND policy_decision=NULL (correct — reserved for
-- host tool run), the decision that actually governed the read was not
-- recorded anywhere on the evidence row at all.
--
-- The round-3 fix introduces a DISTINCT `GovernedRepositoryReadPolicy`
-- boundary for /github reads (the architect's sanctioned alternative path,
-- made real). It REUSES the WORK-037 decideForProjectScope engine (no
-- parallel engine) but presents ONE atomic operation method that captures the
-- decision, enforces it (deny/ask/path-not-allowed -> no read), performs the
-- read under the captured decision, applies the `constrained` enforcement
-- (maxOutputBytes truncation + path-allowlist + read-only), and returns the
-- bound decision+effect+content. There is NO caller-interleavable check-then-
-- act gap at the boundary API.
--
-- This migration records the actual decision + the actual enforcement effect on
-- the evidence row, in DISTINCT columns that do NOT masquerade as a Tool
-- Runtime invocation:
--   * repository_read_decision  — the WORK-037 decideForProjectScope decision
--     (allow/constrained/deny/ask) that governed THIS /github read. NULL for
--     evidence rows that did not come from a governed repository read (none
--     currently exist — all evidence rows come from governed reads — but the
--     column is nullable for future non-read evidence sources).
--   * repository_read_enforcement — a jsonb record of the concrete
--     enforcement effect: { policyVersion, ruleId, performed, truncated,
--     maxOutputBytes, truncatedAtBytes, pathAllowed, reason }. This makes
--     `constrained` OBSERVABLE: a later auditor can verify the content was
--     read under decision X (policy version V), that maxOutputBytes truncated
--     it to N bytes, that the path was in the candidate allowlist, etc.
--
-- The round-2 invariants are PRESERVED:
--   * tool_invocation_id stays NULL for /github reads (NOT a Tool Runtime
--     invocation — do not manufacture toolInvocationIds for operations that
--     never went through Tool Runtime).
--   * policy_decision stays NULL for /github reads (reserved for "host tool
--     run" audit trail — the /github read is NOT a host tool run).
-- The decision + effect now live in their OWN columns — "record the actual
-- decision/effect without pretending it was a Tool Runtime invocation."

ALTER TABLE wfos_project_baseline_evidence
  ADD COLUMN IF NOT EXISTS repository_read_decision TEXT
    CHECK (repository_read_decision IS NULL
           OR repository_read_decision IN ('allow', 'constrained', 'deny', 'ask')),
  -- The bound enforcement effect (jsonb). NULL when the evidence row did not
  -- come from a governed repository read. The shape (consumed by the pg
  -- repository mapper + the onboarding boundary) is:
  --   { "policyVersion": number|null, "ruleId": string|null,
  --     "performed": boolean, "truncated": boolean,
  --     "maxOutputBytes": number|null, "truncatedAtBytes": number|null,
  --     "pathAllowed": boolean, "reason": string|null }
  ADD COLUMN IF NOT EXISTS repository_read_enforcement JSONB;

-- Index for forensic queries: "show me every read that was denied / constrained
-- under policy version V" (the drift-detection + audit surface).
CREATE INDEX IF NOT EXISTS wfos_project_baseline_evidence_read_decision_idx
  ON wfos_project_baseline_evidence (baseline_id, repository_read_decision)
  WHERE repository_read_decision IS NOT NULL;
