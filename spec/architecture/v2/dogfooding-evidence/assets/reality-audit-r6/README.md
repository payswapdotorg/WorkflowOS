V2-REALITY-AUDIT-001-R6 audit artifacts — produced by the orchestrator's
run of the R6 full-matrix runner at the exact merged main head
`5ec0a49` (all nine REALITY-REPAIRS merged):
journey.json (the complete 48-journey matrix transcript — one record
per journey with id/journey/expected/observed/status plus every
screenshot's sha-256 digest) + the numbered screenshots (the
persona journey legs: the real-entry probe, the fresh-user signup and
onboarding, the marketplace purchase/install/fork, the installed
cross-org detail, the run lifecycle approval loop, the schedule save,
the teaching journey, the version banner / human-readable diff /
approve-update, the activity timeline, the expert surfaces, the mobile
responsive pass, the offline degradation + recovery, and the companion
handoff bridge).
Runner: backend/tests/integration/deployment/run-reality-audit-r6-browser-smoke.ts
(the runner clears this directory of .png/.json before each run).
Status until the orchestrator's run: this README + the evidence document
are the only committed artifacts; the journey.json and screenshots land
here when the orchestrator executes the runner at the exact head.
