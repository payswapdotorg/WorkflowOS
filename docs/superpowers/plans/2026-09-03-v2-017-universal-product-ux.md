# V2-017 Universal Product UX Implementation Plan

> **For agentic workers:** This plan is repository-resident and must be executable with zero conversational history. Use the repository authority hierarchy in `docs/superpowers/plans/2026-09-04-v2-017-repository-only-execution.md`. Never use chat history, agent memory, copied reports, or PR prose as a substitute for repository state.
>
> **Required process:** use the repository's applicable implementation workflow and verify every claim against the actual repository/GitHub state before proceeding. The plan is a task checklist, not an authority source for completion status.

**Goal:** Rebuild the default WorkflowOS human-facing experience around MAKE / DO / LEARN / SHARE / IMPROVE while preserving every frozen V2 authority and the existing developer workspace.

**Architecture:** This is a frontend composition layer over existing backend authorities. No new workflow semantics, execution authority, or evidence authority is introduced; the UI maps canonical backend facts into a compact human mental model and progressively discloses advanced technical detail.

**Tech Stack:** React 18, TypeScript, Vite, React Router, Tailwind CSS 4, Radix UI, Vitest, Testing Library, Playwright/browser E2E.

**Spec:** `docs/superpowers/specs/2026-09-03-workflowos-universal-ux-design.md`

**Governing program:** `spec/architecture/v2/post-w6-product-roadmap.md`

**Repository-only execution contract:** `docs/superpowers/plans/2026-09-04-v2-017-repository-only-execution.md`

## Repository-Only Operating Rules

1. The actual GitHub repository is the only source of truth for implementation state.
2. Start every task by inspecting the current `main` revision and repository-resident governance state.
3. Determine task eligibility from `spec/development-state/`, `V2-017.md`, `V2-ACR-003`, and the V2-017 program graph. Do not infer eligibility from conversation or unchecked plan boxes.
4. Verify dependencies by authoritative Git merge evidence. An open PR, local branch, CI result, comment, or agent report does not make a dependency complete.
5. Use the exact eligible `main` SHA as the task base unless the Work Order explicitly specifies another stable base.
6. Never make an unmerged sibling V2-017 branch a dependency. Use merged `main` or a governed integration boundary.
7. Treat PR descriptions/comments and dogfooding notes as evidence/navigation only; they do not override frozen architecture, Work Order scope, canonical state, or Git history.
8. If repository artifacts disagree, stop and reconcile the governance state before implementation.
9. Do not record completion from a test count alone. Completion requires the Architect's actual Git merge and post-merge canonical reconciliation.
10. Never use this conversation as a hidden prerequisite for understanding what to implement next.

## Global Constraints

- WorkflowIR remains the sole semantic source of workflow meaning.
- WorkflowVersion remains immutable.
- Run, Deployment, Node, Capability, authorization, placement, evidence, attestation and proof authorities are unchanged.
- Conversation is input, not the durable workflow format.
- Failed reads must remain distinct from successful empty results.
- Marketplace entitlement never becomes execution authority.
- Cryptographic authenticity never becomes automatic proof of physical side effects.
- Existing developer/engineering control surfaces remain accessible.
- No second workflow engine/protocol/evidence/verification authority.
- No platform-specific workflow semantics.

---

### Task 1: Human-facing application shell

**Files:** `frontend/src/App.tsx`, `frontend/src/components/shell/AppShell.tsx`, new Home/Workflows/Explore/Activity pages, related tests.

- [ ] Read the current repository state, V2-017 Work Order, program map, and relevant current PR before implementation.
- [ ] Write failing route/navigation tests for Home, Workflows, Explore, Activity, Create, and expert workspace access.
- [ ] Verify the focused tests fail for the new navigation contract.
- [ ] Implement the smallest shell/navigation change preserving existing protected and expert routes.
- [ ] Add progressive-disclosure entry to expert/developer surfaces without making them primary navigation.
- [ ] Run focused tests, typecheck, and lint.
- [ ] Re-check the final diff against Task 1 scope and frozen UX/authority rules.
- [ ] Commit and push a normal append-only history.
- [ ] Record exact-head verification and dogfooding evidence in the PR/repository.

### Task 2: Workflow-first Home

**Dependency:** T1 must be COMPLETE by authoritative Git merge evidence.

**Files:** Home page and focused home components/tests.

- [ ] Re-read current `main`, canonical state, V2-017 graph, and the merged T1 evidence.
- [ ] Test creation/search entry plus successful/empty/error read-state distinctions.
- [ ] Implement “What do you want to get done?” with recent workflows and attention.
- [ ] Keep failed reads explicitly unavailable.
- [ ] Verify existing APIs are reused.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 3: Workflow library

**Dependency:** T1 must be COMPLETE by authoritative Git merge evidence.

**Files:** Workflows page, workflow card/filter components, tests.

- [ ] Re-read current `main` and T1 merge evidence before starting.
- [ ] Test My Workflows / Installed / Shared / Drafts / Archived and attention filters.
- [ ] Render purpose, state, last run, schedule, environment and attention state.
- [ ] Keep IDs/digests secondary.
- [ ] Verify empty/error distinction.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 4: Workflow detail

**Dependency:** T3 must be COMPLETE by authoritative Git merge evidence.

**Files:** workflow detail page/components and tests.

- [ ] Re-read current `main`, T3 merge evidence, and existing V2 workflow/version/install authorities.
- [ ] Test Run / Teach Me / Edit / Schedule, status, what it does, when/where it runs, activity, version and access/safety.
- [ ] Implement the human-facing hierarchy.
- [ ] Expose advanced inspection as a secondary path.
- [ ] Verify version/pin facts are authoritative responses.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 5: Tell / Show / Tell + Show creation

**Dependency:** T1 must be COMPLETE by authoritative Git merge evidence.

**Files:** new creation page and create-flow components/tests.

- [ ] Re-read current `main` and relevant authoring/public contracts before starting.
- [ ] Test Tell, Show and hybrid entry states.
- [ ] Reuse existing authoring/public contracts; create no alternate workflow representation.
- [ ] Add semantic understanding preview and correction before commitment.
- [ ] Verify transient UI state is never treated as durable workflow truth.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 6: Run / approval / where-it-runs

**Dependency:** T4 must be COMPLETE by authoritative Git merge evidence.

**Files:** run preview, location chooser, run status components/tests.

- [ ] Re-read current `main` and T4 merge evidence before starting.
- [ ] Test consequential-action preview, location availability, explicit unavailable reasons and authorization language.
- [ ] Implement human-readable environment selection.
- [ ] Preserve authoritative Run command semantics.
- [ ] Implement Ready / Running / Waiting for you / Paused / Needs attention / Couldn't complete / Unavailable states.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 7: Failure / recovery / takeover

**Dependency:** T6 must be COMPLETE by authoritative Git merge evidence.

**Files:** recovery and human-takeover components/tests.

- [ ] Re-read current `main` and T6 merge evidence before starting.
- [ ] Test known/unknown/unavailable failure facts.
- [ ] Implement Take over / Try again / Edit workflow / Stop.
- [ ] Preserve Run identity and authority during takeover/resume.
- [ ] Verify failed operations cannot render as success.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 8: Scheduling and events

**Dependency:** T4 must be COMPLETE by authoritative Git merge evidence.

**Files:** “When” editor and trigger components/tests.

- [ ] Re-read current `main`, T4 merge evidence, and existing scheduling/event authorities.
- [ ] Test manual, scheduled, event and workflow-completion triggers.
- [ ] Implement natural-language trigger presentation.
- [ ] Preserve canonical event/trigger semantics.
- [ ] Hide deduplication/timezone/missed-window details until needed.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 9: Teach Me / reverse teaching

**Dependency:** T4 must be COMPLETE by authoritative Git merge evidence.

**Files:** teaching/reverse-teaching presentation components/tests.

- [ ] Re-read current `main`, T4 merge evidence, and existing teaching authorities.
- [ ] Test version binding, progress/resume, checkpoints, evidence separation and missing-information disclosure.
- [ ] Put Teach Me beside Run.
- [ ] Keep human learning separate from execution evidence.
- [ ] Verify no invented procedure details.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 10: Activity and “How do you know?”

**Dependency:** T6, T7 and T9 must be COMPLETE by authoritative Git merge evidence.

**Files:** Activity page/components, evidence/trust components/tests.

- [ ] Re-read current `main` and all dependency merge evidence before starting.
- [ ] Test completed, failed, approval, update and device events.
- [ ] Implement concise evidence first and advanced verification on demand.
- [ ] Never equate signature/digest/attestation with physical side-effect proof.
- [ ] Preserve exact Run/attestation bindings.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 11: Versions, updates and optimization

**Dependency:** T4 must be COMPLETE by authoritative Git merge evidence.

**Files:** update/version/proposal components/tests.

- [ ] Re-read current `main`, T4 merge evidence, and V2-002/V2-011 authorities.
- [ ] Test immutable installed-version display and explicit adoption.
- [ ] Implement update comparison.
- [ ] Implement optimization proposals as new versions with trade-offs.
- [ ] Verify no silent activation/mutation.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 12: Sharing / marketplace / install

**Dependency:** T3, T4 and T11 must be COMPLETE by authoritative Git merge evidence.

**Files:** Explore and marketplace/share components/tests.

- [ ] Re-read current `main`, all dependency merge evidence, and V2-012 authorities.
- [ ] Test entitlement vs installation vs execution presentation.
- [ ] Implement listing metadata, install, Share and Make my own/fork.
- [ ] Preserve provenance and publisher-data/secret isolation.
- [ ] Verify purchase cannot render as execution authorization.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 13: Expert/developer workspace

**Dependency:** T1 must be COMPLETE by authoritative Git merge evidence.

**Files:** existing developer navigation only as needed; regression tests.

- [ ] Re-read current `main` and T1 merge evidence before starting.
- [ ] Prove existing developer workspace routes remain reachable.
- [ ] Add intentional Expert / Developer entry.
- [ ] Remove implementation vocabulary from default surfaces without deleting expert functionality.
- [ ] Verify no developer authority moves into the consumer shell.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 14: Responsive/mobile adaptation

**Dependency:** T1 must be COMPLETE by authoritative Git merge evidence; adapt the current merged shared shell rather than another task branch.

**Files:** shared shell and responsive components/tests.

- [ ] Re-read current `main` and the latest merged shared-shell implementation before starting.
- [ ] Test mobile navigation and primary action accessibility.
- [ ] Adapt hierarchy rather than shrinking desktop layouts.
- [ ] Verify semantic equivalence across surfaces.
- [ ] Re-check scope, run verification, commit, and persist evidence.

### Task 15: Full verification and dogfooding

**Dependency:** T2–T14 must all be COMPLETE by authoritative Git merge evidence.

**Files:** relevant E2E specs and persisted UX dogfooding evidence.

- [ ] Re-read the entire V2-017 Work Order, program map, acceptance criteria, and merged task evidence.
- [ ] Run frontend typecheck.
- [ ] Run frontend lint.
- [ ] Run frontend unit/component suite.
- [ ] Run relevant browser E2E.
- [ ] Run architecture/static checks.
- [ ] Run real browser journey covering create → review → run → outcome → recovery/takeover or completion → Teach Me → version/update.
- [ ] Persist evidence and honest limitations with exact revisions and timestamps.
- [ ] Verify all V2-017 acceptance criteria line-by-line.
- [ ] Verify final diff contains only approved UX/product-layer surfaces.
- [ ] Commit and persist final verification evidence.

### Task 16: PR and architect gate

**Dependency:** T15 must be COMPLETE by authoritative Git evidence and canonical state.

- [ ] Verify exact approved base SHA from repository state.
- [ ] Open/update the implementation PR with requirement → implementation → test → dogfooding mapping.
- [ ] Perform repository-first Architect review against actual diff, frozen UX design, Work Order, ACR and program map.
- [ ] Resolve all blocking findings with append-only corrections and fresh verification.
- [ ] Do not merge until the sole Architect gate is satisfied.
- [ ] Re-run exact-head CI and repository-first review immediately before merge.
- [ ] Merge and reconcile canonical state from authoritative Git evidence.

## Handoff rule

At every task boundary, leave enough repository-resident evidence that a fresh agent can continue without this conversation. The minimum handoff is:

```text
current main SHA
+ canonical state
+ V2-017 Work Order
+ V2-017 program map
+ task PR/merge identity
+ exact verification evidence
+ dogfooding evidence
+ known limitations/blockers
```

No agent may write “continue from our conversation” or otherwise make chat history a prerequisite for implementation.
