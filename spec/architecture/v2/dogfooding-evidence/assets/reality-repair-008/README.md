# REALITY-REPAIR-008 smoke artifacts

This directory receives the artifacts of the REALITY-REPAIR-008
real-topology browser smoke
(`backend/tests/integration/deployment/run-reality-repair-008-browser-smoke.ts`),
when the **orchestrator** runs it (port discipline: the runner owns `:3001`
for the REAL deployment entry and `:5188` for the ACTUAL Vite SPA; the
worker committed the runner and never executed it):

- `journey.json` — the full transcript (per-leg PASS/FAIL with timings,
  exit code, duration) + the sha-256 digests + byte sizes of every
  screenshot;
- `01-learner-installed.png` — LEG3: the learner's entitled free install
  (Version 1 pinned into the learner org);
- `02-practice-scoped-feedback.png` — LEG6: the practice moment — the
  send_report attempt's verbatim feedback scoped to its own question,
  the collect_posts question carrying NO send_report feedback;
- `03-collect-feedback-names-collect.png` — LEG7: the known case — the
  collect_posts question's feedback names `collect_posts`, not
  `send_report` (the Work Order's required regression, in the real DOM);
- `04-lesson-complete.png` — LEG8: Lesson complete + the teaching-evidence
  separation surface (all lesson/assessment evidence unchanged).

The evidence document referencing them is
`spec/architecture/v2/dogfooding-evidence/REALITY-REPAIR-008-teaching-feedback-step-reference.md`
(§5 records the smoke exit code as PENDING ORCHESTRATOR RUN until the
orchestrator's execution).
