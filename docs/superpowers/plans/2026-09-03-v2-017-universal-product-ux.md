# V2-017 Universal Product UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the default WorkflowOS human-facing experience around MAKE / DO / LEARN / SHARE / IMPROVE while preserving every frozen V2 authority and the existing developer workspace.

**Architecture:** This is a frontend composition layer over existing backend authorities. No new workflow semantics, execution authority, or evidence authority is introduced; the UI maps canonical backend facts into a compact human mental model and progressively discloses advanced technical detail.

**Tech Stack:** React 18, TypeScript, Vite, React Router, Tailwind CSS 4, Radix UI, Vitest, Testing Library, Playwright/browser E2E.

**Spec:** `docs/superpowers/specs/2026-09-03-workflowos-universal-ux-design.md`

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

- [ ] Write failing route/navigation tests for Home, Workflows, Explore, Activity, Create, and expert workspace access.
- [ ] Verify the focused tests fail for the new navigation contract.
- [ ] Implement the smallest shell/navigation change preserving existing protected and expert routes.
- [ ] Add progressive-disclosure entry to expert/developer surfaces without making them primary navigation.
- [ ] Run focused tests, typecheck, and lint.
- [ ] Commit.

### Task 2: Workflow-first Home

**Files:** Home page and focused home components/tests.

- [ ] Test creation/search entry plus successful/empty/error read-state distinctions.
- [ ] Implement “What do you want to get done?” with recent workflows and attention.
- [ ] Keep failed reads explicitly unavailable.
- [ ] Verify existing APIs are reused.
- [ ] Commit.

### Task 3: Workflow library

**Files:** Workflows page, workflow card/filter components, tests.

- [ ] Test My Workflows / Installed / Shared / Drafts / Archived and attention filters.
- [ ] Render purpose, state, last run, schedule, environment and attention state.
- [ ] Keep IDs/digests secondary.
- [ ] Verify empty/error distinction.
- [ ] Commit.

### Task 4: Workflow detail

**Files:** workflow detail page/components and tests.

- [ ] Test Run / Teach Me / Edit / Schedule, status, what it does, when/where it runs, activity, version and access/safety.
- [ ] Implement the human-facing hierarchy.
- [ ] Expose advanced inspection as a secondary path.
- [ ] Verify version/pin facts are authoritative responses.
- [ ] Commit.

### Task 5: Tell / Show / Tell + Show creation

**Files:** new creation page and create-flow components/tests.

- [ ] Test Tell, Show and hybrid entry states.
- [ ] Reuse existing authoring/public contracts; create no alternate workflow representation.
- [ ] Add semantic understanding preview and correction before commitment.
- [ ] Verify transient UI state is never treated as durable workflow truth.
- [ ] Commit.

### Task 6: Run / approval / where-it-runs

**Files:** run preview, location chooser, run status components/tests.

- [ ] Test consequential-action preview, location availability, explicit unavailable reasons and authorization language.
- [ ] Implement human-readable environment selection.
- [ ] Preserve authoritative Run command semantics.
- [ ] Implement Ready / Running / Waiting for you / Paused / Needs attention / Couldn't complete / Unavailable states.
- [ ] Commit.

### Task 7: Failure / recovery / takeover

**Files:** recovery and human-takeover components/tests.

- [ ] Test known/unknown/unavailable failure facts.
- [ ] Implement Take over / Try again / Edit workflow / Stop.
- [ ] Preserve Run identity and authority during takeover/resume.
- [ ] Verify failed operations cannot render as success.
- [ ] Commit.

### Task 8: Scheduling and events

**Files:** “When” editor and trigger components/tests.

- [ ] Test manual, scheduled, event and workflow-completion triggers.
- [ ] Implement natural-language trigger presentation.
- [ ] Preserve canonical event/trigger semantics.
- [ ] Hide deduplication/timezone/missed-window details until needed.
- [ ] Commit.

### Task 9: Teach Me / reverse teaching

**Files:** teaching/reverse-teaching presentation components/tests.

- [ ] Test version binding, progress/resume, checkpoints, evidence separation and missing-information disclosure.
- [ ] Put Teach Me beside Run.
- [ ] Keep human learning separate from execution evidence.
- [ ] Verify no invented procedure details.
- [ ] Commit.

### Task 10: Activity and “How do you know?”

**Files:** Activity page/components, evidence/trust components/tests.

- [ ] Test completed, failed, approval, update and device events.
- [ ] Implement concise evidence first and advanced verification on demand.
- [ ] Never equate signature/digest/attestation with physical side-effect proof.
- [ ] Preserve exact Run/attestation bindings.
- [ ] Commit.

### Task 11: Versions, updates and optimization

**Files:** update/version/proposal components/tests.

- [ ] Test immutable installed-version display and explicit adoption.
- [ ] Implement update comparison.
- [ ] Implement optimization proposals as new versions with trade-offs.
- [ ] Verify no silent activation/mutation.
- [ ] Commit.

### Task 12: Sharing / marketplace / install

**Files:** Explore and marketplace/share components/tests.

- [ ] Test entitlement vs installation vs execution presentation.
- [ ] Implement listing metadata, install, Share and Make my own/fork.
- [ ] Preserve provenance and publisher-data/secret isolation.
- [ ] Verify purchase cannot render as execution authorization.
- [ ] Commit.

### Task 13: Expert/developer workspace

**Files:** existing developer navigation only as needed; regression tests.

- [ ] Prove existing developer workspace routes remain reachable.
- [ ] Add intentional Expert / Developer entry.
- [ ] Remove implementation vocabulary from default surfaces without deleting expert functionality.
- [ ] Verify no developer authority moves into the consumer shell.
- [ ] Commit.

### Task 14: Responsive/mobile adaptation

**Files:** shared shell and responsive components/tests.

- [ ] Test mobile navigation and primary action accessibility.
- [ ] Adapt hierarchy rather than shrinking desktop layouts.
- [ ] Verify semantic equivalence across surfaces.
- [ ] Commit.

### Task 15: Full verification and dogfooding

**Files:** relevant E2E specs and persisted UX dogfooding evidence.

- [ ] Run frontend typecheck.
- [ ] Run frontend lint.
- [ ] Run frontend unit/component suite.
- [ ] Run relevant browser E2E.
- [ ] Run architecture/static checks.
- [ ] Run real browser journey covering create → review → run → outcome → recovery/takeover or completion → Teach Me → version/update.
- [ ] Persist evidence and honest limitations.
- [ ] Verify all 16 V2-017 acceptance criteria line-by-line.
- [ ] Verify final diff contains only approved UX/product-layer surfaces.
- [ ] Commit.

### Task 16: PR and architect gate

- [ ] Verify exact approved base SHA after V2-017 activation.
- [ ] Open implementation PR with requirement → implementation → test → dogfooding mapping.
- [ ] Do not merge until architect review is complete.
- [ ] Re-run exact-head CI and repository-first review before merge.
