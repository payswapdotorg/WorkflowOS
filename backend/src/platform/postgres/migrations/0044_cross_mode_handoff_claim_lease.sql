-- WORK-042 (PR #46 round 4): durable execution claim/lease for the
-- cross-mode-handoff obligation — the concurrency-serialization fix for
-- the round-4 boot-sweep race.
--
-- The round-3 reorder (relay enqueue AFTER the mutation) closed the
-- claim-time live-worker race, but it did NOT provide OWNERSHIP of the
-- pending obligation between the caller's reserve() and the caller's
-- mutation. A boot sweep (or an already-enqueued relay job) that fires in
-- that window sees a PENDING obligation, calls reconcile, and re-mutates +
-- re-dispatches — after which the original caller performs its OWN
-- mutation + dispatch (TWO concurrent handoff drivers). The handoff-row
-- UNIQUE constraint does NOT serialize this: both actors operate on the
-- SAME already-reserved handoff row (it only fences creation of a SECOND
-- handoff row).
--
-- The fix introduces a durable execution claim/lease on the obligation row
-- itself, shared by the synchronous caller + the relay reconcile. The
-- claim is the serialization boundary — only the claim owner may perform
-- the mutation/session/dispatch critical section. A crashed owner's
-- lease auto-expires (claim_expires_at < NOW()) so the boot sweep reclaims
-- + recovers. This mirrors the conditional UPDATE...WHERE...RETURNING CAS
-- precedent already used by dischargeHandoffObligation (0043) +
-- claimToolInvocation (the WORK-034 session-event claim).
--
--     caller path (reserveAndClaim):
--       BEGIN
--         INSERT handoff log row (0042) → trigger writes obligation (0043)
--         UPDATE obligation SET claimed_at/claim_expires_at/claim_owner
--           WHERE discharged_at IS NULL
--             AND (claimed_at IS NULL OR claim_expires_at < NOW())
--       COMMIT
--       → mutate + session + dispatch + enqueue relay
--       → UPDATE obligation SET claimed_at=NULL... (release)
--
--     relay/reconcile path:
--       UPDATE obligation SET claimed_at/... WHERE <same predicate>
--       → if 0 rows (claim held by the caller) → return early (NO mutate)
--       → if 1 row (claim acquired) → re-mutate + re-dispatch + discharge
--       → release (or the discharge's discharged_at IS NULL guard no-ops)
--
--     crash reclaim:
--       the claim_expires_at < NOW() predicate makes an expired claim
--       reclaimable — a crashed caller's lease auto-expires after the lease
--       duration; the next reconcile (boot sweep / relay) reclaims + drives
--       the handoff to completion.
--
-- The new columns are FREE TO MUTATE: the 0043 immutability trigger only
-- guards handoff_id/execution_id/created_at (the recorded intent). The
-- claim columns are the durable execution state (mutable, like
-- discharged_at). NO trigger extension is needed.

ALTER TABLE wfos_cross_mode_handoff_obligations
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_owner TEXT;

-- The reclaimable-claim work list: obligations whose claim has expired
-- (a crashed owner) are reclaimable by the next sweep. Index the
-- claim_expires_at column for the WHERE-discharged predicate so the
-- sweep + the claim UPDATE both probe a small set.
CREATE INDEX IF NOT EXISTS wfos_cross_mode_handoff_obligations_claimable_idx
  ON wfos_cross_mode_handoff_obligations (claim_expires_at)
  WHERE discharged_at IS NULL;
