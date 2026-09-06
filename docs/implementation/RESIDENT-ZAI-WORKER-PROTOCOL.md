# Resident Z.ai Worker Protocol

**Status:** FROZEN OPERATING PROTOCOL

**Purpose:** Define how WorkflowOS uses a resident Z.ai implementation worker for governed work without making the Z.ai session, a local runtime, or conversation history authoritative.

## Core model

WorkflowOS remains the sole durable authority for architecture, requirements, Work Orders, dependencies, task eligibility, and completion.

GitHub is the durable execution/evidence surface for implementation branches, pull requests, review findings, CI, and merge history.

The Z.ai session is disposable worker runtime state. A session may implement, test, checkpoint, wait, resume, or be replaced, but it never becomes the source of truth for progress or completion.

The durable identity of an implementation run is:

`Work Item/Task + branch + PR + exact base SHA + latest head SHA`

A Z.ai provider session identifier is a carried runtime reference only. It is never the authority for task identity, completion, or recovery.

## Worker lifecycle

```text
DISPATCH_AUTHORIZED
        ↓
WORKER_ACTIVE
        ↓
CHECKPOINTED
        ↓
WAITING_FOR_ARCHITECT
        ↓
   ┌────┴─────────────┐
   │                  │
   ↓                  ↓
CHANGES_REQUESTED   APPROVED
   ↓                  ↓
WORKER_ACTIVE       MERGING
   │                  ↓
   └────────────→   MERGED
                      ↓
                RECONCILING
                      ↓
                   COMPLETE
```

Operational exception classifications are `STALE_BASE`, `SUSPECTED_HANG`, `WAITING_FOR_CAPACITY`, and `ESCALATE`. They do not override canonical task state.

## Durable dispatch

Before implementation begins, the Architect/operator posts a durable dispatch request on the implementation PR/issue surface containing:

- repository identity;
- V2-017 task/work-item identity;
- exact implementation base SHA;
- governing Work Order and architecture references;
- completed dependencies and their merge identities;
- owned implementation surface;
- forbidden implementation surface;
- required tests, CI, browser/system dogfooding, and evidence;
- one-PR requirement;
- explicit prohibition on merge, self-approval, architecture/roadmap mutation, and successor-task work.

The worker must re-read these facts from the repository and live GitHub before changing code. A dispatch message never overrides repository authority.

## Implementation checkpoint

The worker must create a durable checkpoint when the implementation reaches a meaningful stable point. A checkpoint consists of:

- a pushed commit;
- the exact current head SHA;
- the same branch and PR identity;
- validation evidence;
- truthful worker status;
- any known blocker or limitation.

The PR is the durable implementation checkpoint. The worker must not create a replacement PR merely because its session changed, context was exhausted, or a review iteration occurred.

## Architect review emission

When the exact PR head satisfies the complete Architect review prerequisites, the persistent Z.ai orchestrator must emit the review event to the **same GitHub PR conversation**. This is an operational requirement, not an optional notification.

Use the repository helper:

```text
scripts/emit-architect-review-trigger.sh
```

The helper verifies the PR is open, targets `main`, the supplied PR head SHA is still exact, and the supplied `main` SHA is still current. It de-duplicates the same Work Order/head pair. Z.ai must not report the Architect as notified until the GitHub comment succeeds.

The comment contains the durable machine-readable event and the exact trigger line:

```text
ARCHITECT REVIEW: WorkflowOS PR #<N>, Work Order <WO>, head <SHA>
```

After successful emission, the worker may enter `WAITING_FOR_ARCHITECT`. If emission fails or the exact head has moved, the worker remains active/non-awaiting, re-verifies, and retries or escalates according to the failure cause.

## Resident waiting mode

After submitting a review-ready checkpoint and successfully emitting the GitHub review trigger, the worker enters resident `WAITING_FOR_ARCHITECT` mode rather than treating a textual response as termination.

While resident:

1. periodically re-read repository authority and the same PR;
2. detect whether the reviewed head changed;
3. inspect new Architect findings;
4. resume implementation only from durable findings on the same PR;
5. checkpoint before context/quota/runtime exhaustion;
6. never invent downstream work while waiting.

Silence is not proof of failure. Long-running work is not a hang merely because no new commit has appeared yet.

## Architect review packet

Each `REQUEST_CHANGES` decision is a durable packet tied to an exact PR head and base. It must contain:

```yaml
work_item: T2
pr: 178
head_sha: <exact reviewed head>
base_sha: <exact intended base>
iteration: <integer>
decision: REQUEST_CHANGES
findings:
  - id: V2-017-T2-F01
    severity: HIGH
    path: frontend/src/pages/HomePage.tsx
    criterion: <governing acceptance criterion>
    required_change: <specific required action>
```

Finding IDs remain stable for the life of the review finding. A worker resolves the finding on the same PR and publishes a new checkpoint with a new head SHA and complete validation evidence.

## Recovery

When a resident session disconnects, exhausts context/quota, or becomes unrecoverable, the replacement worker must start from durable repository evidence:

```text
current main
   ↓
canonical development state
   ↓
selected Work Order
   ↓
program/dependency map
   ↓
same implementation PR
   ↓
latest committed head
   ↓
latest review packet
   ↓
latest validation/dogfooding evidence
```

A fresh Z.ai session may continue the same task only when the live branch/PR/base/head still satisfy the governing task contract. It must never create a replacement implementation PR solely because the previous session ended.

The replacement worker must explicitly state the recovery point it verified before implementation continues.

## Watchdog rules

The external Architect/operator watchdog may classify the resident worker as:

- `ACTIVE_PROGRESS` — new commit, durable checkpoint, or explicit worker activity exists;
- `SUSPECTED_HANG` — no durable progress for a material interval and activity cannot be confirmed;
- `WAITING_FOR_ARCHITECT` — implementation checkpoint is review-ready and no new finding exists;
- `WAITING_FOR_CAPACITY` — provider/session capacity prevents continued execution;
- `ESCALATE` — architecture, authority, identity, base, or repository state is contradictory.

A suspected hang must be checked before restarting. Automatic restarts are bounded. Repeated identical restart/failure conditions escalate instead of looping.

## Safety boundaries

The resident worker may inspect the repository, modify its assigned task surface, run tests, update its branch, update the same PR, and respond to Architect findings.

The resident worker may not:

- merge or self-approve its PR;
- change frozen architecture or Work Order acceptance criteria;
- activate or implement a successor task;
- create a second implementation PR for the same task;
- treat conversation history as authority;
- treat its own session state as durable progress state;
- fabricate evidence or convert unavailable reads into successful empty results;
- create a second WorkflowOS workflow/protocol/execution/verification authority.

## Completion boundary

Worker completion means `review-ready` only. Task completion means the governed acceptance gate has passed, the Architect has authorized merge, the actual Git merge exists, and canonical post-merge reconciliation records that merge.

A green CI result, a worker statement, a PR being open, or a Z.ai session ending does not establish completion.
