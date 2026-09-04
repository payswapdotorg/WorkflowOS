# Resident Worker Dispatch Template

Use this as the structure for the durable GitHub dispatch comment on every resident-worker implementation run.

```text
ARCHITECT — DURABLE Z.AI DISPATCH

Work Item: <task>
PR: <PR number once implementation PR exists>
Exact base SHA: <live main SHA verified immediately before dispatch>
Work Order: <path>

Authority verified:
- repository: <owner/name>
- task eligible: <yes + evidence>
- dependencies merged: <list + merge SHAs>
- Work Order frozen: <path>

Owned surface:
- <paths / behaviors>

Forbidden surface:
- <paths / behaviors>

Required verification:
- <commands>
- <browser/system dogfooding>

Worker rules:
- verify the exact base SHA against live main before editing;
- implement exactly one bounded task;
- write RED first for behavior changes;
- use the same PR for every review iteration;
- publish durable checkpoints with exact head SHA and evidence;
- remain resident at WAITING_FOR_ARCHITECT after review-ready checkpoints;
- consume REQUEST_CHANGES findings verbatim;
- never merge, self-approve, rewrite frozen authority, create a replacement PR, or invent successor work.

Recovery:
- resume from the latest same-PR GitHub checkpoint and review packet;
- a new provider session is disposable runtime state;
- if the branch/base/task is contradictory, stop and escalate.
```

This template is procedural guidance only. A populated dispatch comment on the live implementation PR or handoff issue is the actual durable dispatch event.
