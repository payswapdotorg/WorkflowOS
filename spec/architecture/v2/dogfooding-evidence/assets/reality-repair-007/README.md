# REALITY-REPAIR-007 smoke artifacts (orchestrator-owned)

This directory is where the REALITY-REPAIR-007 real-topology browser
smoke writes its evidence when the ORCHESTRATOR runs it (port
discipline: the `:3001` REAL deployment entry and the `:5188` ACTUAL
Vite SPA belong to the orchestrator; the implementation worker commits
the runner and never runs it).

Runner: `backend/tests/integration/deployment/run-reality-repair-007-browser-smoke.ts`
(run: `cd backend && bunx tsx tests/integration/deployment/run-reality-repair-007-browser-smoke.ts`;
exit code 0 = every leg passed).

Expected artifacts on a run:

- `journey.json` — the transcript (one entry per leg with PASS/FAIL,
  timing, and detail) + the sha-256 digests and byte sizes of every
  screenshot;
- `01-consumer-org-created.png` … `08-typed-rejection-honest.png` — the
  leg screenshots the evidence document
(`../REALITY-REPAIR-007-run-lifecycle-controls.md` §5) references.

The runner clears stale `.png`/`.json` files from this directory before
each run, so a fresh run leaves exactly its own artifacts here.
