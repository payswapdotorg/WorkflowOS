# REALITY-REPAIR-009 smoke artifacts

This directory holds the artifacts of the REALITY-REPAIR-009 real-topology
browser smoke
(`backend/tests/integration/deployment/run-reality-repair-009-browser-smoke.ts`)
when the orchestrator executes it:

- `journey.json` — the full transcript (every leg's PASS/FAIL with
  timings) + the sha-256 digests of every screenshot;
- `01-consumer-org-created.png` — LEG2: the consumer's organization
  created through the real Home onboarding (the RR-002 precondition);
- `02-listing-installed.png` — LEG3: the entitled free install pinned
  version 1 into the CONSUMER organization;
- `03-equivalent-what-changed.png` — LEG6: the v2 update's What-changed —
  "Task-for-task equivalent - verified" (equivalence stays equivalence);
- `04-human-readable-what-changed.png` — LEG8: THE F-010 REPAIR — the v3
  update's What-changed renders the human-readable node/field summary
  (the step name "Collect the open tickets", "its inputs", the two
  readable values, the honest "Not equivalent" verdict) with NO raw
  internal JSON envelope.

The run is executed by the orchestrator (port discipline: the REAL
deployment entry on :3001 and the Vite SPA on :5188 belong to it); the
runner is committed and compiles clean, but is never run by the
implementation worker. Until then, the evidence document's §5 exit line
reads **PENDING ORCHESTRATOR RUN**.
