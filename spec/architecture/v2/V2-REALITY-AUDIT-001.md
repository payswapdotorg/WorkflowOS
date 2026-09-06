# V2-REALITY-AUDIT-001 — Product Reality, Journey, and Architecture Reconciliation

**Status:** architect-authorized pre-deployment program
**Program:** WorkflowOS V2
**Precondition:** V2-017 Universal Product UX is complete through T16.
**Purpose:** exercise the real V2 product as a user, reconcile every UX journey against the already-implemented V2 operational architecture, identify wiring/composition defects versus genuine missing authority contracts, and only then authorize implementation fixes and production deployment.

## Why this program exists

WorkflowOS V2 was implemented in two major layers: the operational protocol/runtime architecture and the later human-facing V2-017 UX composition. The UX must therefore be tested against the real operational system rather than assumed to be correct because its presentation tests pass.

The key question is:

> Does every user-facing V2 intent map to an existing authoritative backend capability correctly, or has the UX invented assumptions about functions/commands/reads that the operational architecture does not expose?

This program is deliberately **before deployment**. The deployment roadmap MUST NOT be treated as complete until this reality audit has either cleared the V2 product surface or produced governed fix slices with evidence.

## Authority boundaries

- This program does not create a second verification, workflow, execution, architecture, or deployment authority.
- The real application and existing V2 backend authorities remain the system under test.
- Z.ai's browser agent is an evidence-producing test operator, not an authority over expected behavior.
- The Architect owns reconciliation of findings and approval of corrective Work Orders/PRs.
- A finding may be classified as a UX defect, frontend/backend wiring defect, adapter/composition gap, missing public authority contract, or architecture defect. The classifications MUST NOT be conflated.

## Required execution environments

Use an isolated V2 staging deployment with real backend persistence and safe fixtures. Do not run destructive actions against production. Use real authentication/session behavior, real backend APIs, real database state, and real host/browser capability discovery wherever the current product exposes them.

The browser agent MUST operate the application through the browser like a real user. Direct API calls are supplementary diagnostic evidence only and cannot substitute for the browser journey.

## Exhaustive journey inventory

The journey matrix MUST cover every reachable V2 product route, primary action, contextual action, state transition, and meaningful negative/read-state branch exposed by the V2 UX architecture.

### A. Identity and entry

1. First visit unauthenticated → login.
2. Password registration.
3. Password login.
4. Session persistence across reload.
5. Logout.
6. Invalid credentials.
7. Backend 401 transition while inside the product.
8. Configured/unconfigured OAuth provider states, where exposed.

### B. Home

9. Home with no organizations.
10. Home with organizations but no workflows.
11. Home with recent workflows.
12. Home with failed runs needing attention.
13. Home with paused runs needing attention.
14. Home read failure + retry.
15. Goal entry with text.
16. Goal entry without text.
17. Tell entry.
18. Show entry.
19. Tell + Show entry.
20. Navigation from Home into every primary destination.

### C. Creation

21. Tell capture → preview → correction.
22. Show capture → preview → correction.
23. Tell + Show capture → preview → correction.
24. Empty capture.
25. Malformed/partial capture.
26. Creation cancellation/back navigation.
27. Durable creation success path, if an authoritative route exists.
28. Durable creation rejection.
29. Creation failure after authoritative request.
30. Duplicate submit/retry behavior.
31. Capture/provenance persistence semantics.
32. Capture → WorkflowIR/authoring handoff, specifically tracing which existing operational service/route is supposed to perform it.

### D. Workflow library

33. My Workflows.
34. Installed.
35. Shared with me.
36. Drafts.
37. Archived.
38. Needs attention filter.
39. Runs automatically filter.
40. On this device filter.
41. Cloud filter.
42. Shared filter.
43. Workflow-list failure + retry.
44. Legitimate empty results versus unavailable reads.
45. Installed version pin display.
46. Disabled installation.

### E. Workflow detail

47. Open workflow detail.
48. Missing workflow.
49. Detail read failure + retry.
50. Head version rendering.
51. Version unavailable.
52. Human-readable steps.
53. Missing/invalid presentation labels.
54. Access/capability requirements.
55. Deployment/placement display.
56. Manual-run workflow.
57. Automatically triggered workflow.
58. Teach Me.
59. Share.
60. Edit → expert transition.
61. Recent activity.
62. Version/update information.

### F. Run / execution

63. Run preview.
64. Run with no installation pin.
65. Run with installation pin.
66. Approval-required run.
67. Capability unavailable.
68. Device-only placement.
69. Cloud-only placement.
70. Preferred placement.
71. Explicit fallback placement.
72. Request → authoritative Run identity → start.
73. Duplicate run request.
74. Run start rejection.
75. Running state.
76. Waiting-for-you state.
77. Paused state.
78. Completed state.
79. Failed state.
80. Cancelled state.
81. Run history unavailable.
82. Historical run deep-link.
83. Evidence disclosure.
84. Attestation/trust disclosure.
85. Advanced execution details.

### G. Recovery

86. Failed run recovery.
87. Paused run recovery.
88. Take over.
89. Try again.
90. Edit workflow from failure.
91. Stop.
92. Recovery command rejection.
93. Run identity preservation across recovery.
94. Recovery after stale/unavailable history.

### H. Scheduling and events

95. No trigger → manual-only language.
96. One-shot schedule.
97. Interval schedule.
98. Daily schedule.
99. Weekly schedule.
100. Event trigger.
101. Disabled subscription.
102. Missed window.
103. Duplicate event.
104. Event/run correlation.
105. Placement failure.
106. Offline/unavailable device case.
107. Multiple subscriptions and conflicting display facts.

### I. Teaching

108. Teach Me entry from detail.
109. Teaching session start.
110. Lesson navigation.
111. Checkpoint confirmation.
112. Practice step.
113. Incorrect practice.
114. Pause/resume teaching.
115. Missing teaching context.
116. Teaching evidence versus execution evidence.
117. Version pinning during teaching.

### J. Versions / improvement

118. Version history.
119. Compare update.
120. Installed pinned version versus newer head.
121. Explicit adoption.
122. Retired pin plus adopted pin.
123. Optimization proposal.
124. Proposal rejection.
125. Optimization adoption as a new version.
126. Semantic-equivalence/trust display where exposed.

### K. Sharing / marketplace

127. Explore with no listings.
128. Explore with listings.
129. Listing read failure.
130. Listing detail.
131. Public workflow.
132. Restricted/shared listing.
133. Price/commercial presentation.
134. Purchase/entitlement.
135. Install.
136. Install failure.
137. Exact version pin after install.
138. Fork / Make my own where exposed.
139. Publisher visibility.
140. Publication is not presented as verification.
141. Entitlement is not presented as execution authorization.

### L. Activity / trust

142. Product-wide activity.
143. Open a run from activity.
144. Historical run selection.
145. Evidence explanation.
146. Verification/attestation explanation.
147. Partial/unavailable activity sources.
148. Trust facts without overclaiming physical side effects.

### M. Expert workspace

149. Explicit consumer → expert transition.
150. Return path to consumer UX.
151. Projects.
152. Architecture.
153. Requirements.
154. Work Items.
155. Workbench.
156. Benchmarks.
157. Integrations.
158. Provider settings.
159. Execution preferences.
160. Expert-mode read failures and authorization boundaries.

### N. Cross-cutting / platform

161. Desktop browser.
162. Mobile-width browser.
163. Tablet-width browser.
164. Reload during pending read.
165. Network failure.
166. Backend restart/session recovery.
167. Concurrent user action.
168. Multiple organizations in one user session.
169. Tenant isolation.
170. Unsupported capability disclosure.
171. Accessibility-critical navigation and form flows.
172. Deep links and browser back/forward behavior.

The inventory is exhaustive for the currently exposed V2 UX surface; newly discovered routes/actions MUST be appended before closure.

## Operational architecture reconciliation matrix

The audit MUST map each journey to the actual V2 operational owner before proposing a fix.

| Product intent | Operational authority to inspect | Reconciliation question |
|---|---|---|
| Create workflow | V2-002 WorkflowRepository + V2-003 WorkflowIR + V2 authoring/public API | Does a public capture→IR authoring command actually exist? |
| Render workflow meaning | V2-003 presentation/IR contract | Is UX consuming the authoritative presentation layer? |
| Execute | V2-005 Run lifecycle + V2-008 runtime | Is UX invoking the existing command envelope and lifecycle correctly? |
| Placement | V2-004 Node/Capability + V2-009 scheduling/placement | Are UI choices derived from real placement policy, not frontend heuristics? |
| Approval | V2-003 approval semantics + V2-005 Run history | Does the UX expose actual approval state and commands? |
| Recovery | V2-005 lifecycle + V2-008 takeover/recovery | Are recovery commands existing authoritative commands? |
| Teaching | V2-006 + V2-010 | Is the UX consuming the actual teaching/reverse-teaching services? |
| Scheduling | V2-009 | Are all trigger/schedule states exposed through existing routes? |
| Versions | V2-002 | Is the UI correctly using immutable version/pin semantics? |
| Optimization | V2-011 | Does optimization already expose a proposal/version command the UX can consume? |
| Marketplace | V2-012 | Are purchase, entitlement, install, and execution authority separated correctly? |
| Trust / attestations | V2-014 + V2-005 | Does UI consume recorded evidence/bindings rather than infer trust? |
| Cross-device continuation | V2-004 + V2-008 + V2-015 | Are existing handoff contracts actually reachable from product UX? |
| Expert controls | existing project/workbench authorities | Is Edit navigating to the correct authoritative editor rather than merely the generic expert landing? |

## Known initial discrepancy hypotheses to verify, not assume

1. **Creation bridge:** V2-017 CreatePage currently performs capture and an understanding preview but explicitly refuses durable creation because it cannot transform capture into WorkflowIR. Verify whether an existing operational authoring/LLM service can already produce valid WorkflowIR but is simply not wired into the UX. The V2-007 compiler is IR→executable, so it must not be misused as capture→IR.
2. **Agent-intelligence confusion:** `backend/src/agent-intelligence/` is a deterministic evidence/ranking orchestrator for execution recommendations; it is not a natural-language workflow authoring service. Verify that the UX is not expecting it to perform authoring.
3. **Edit path:** WorkflowDetailPage's Edit action currently enters `/expert`, and ExpertPage only bridges to `/projects`. Verify whether an existing workflow authoring route/service exists deeper in the expert workspace and whether the V2 UX should route to that specific authority instead of a generic project list.
4. **Unavailable Home surfaces:** Pending approvals, Updates and Device issues are explicitly rendered as unavailable even though the operational architecture contains approval, immutable-version/update, and node/capability/placement concepts. Determine whether this is simply an intentionally incomplete product surface or a missed read composition against existing authorities.
5. **Drafts/Archived:** the UX presents sections whose current operational model may not expose draft/archived workflow states. Determine whether these are valid derived concepts, legacy UX assumptions, or should remain explicitly unavailable.
6. **Teaching route composition:** the detail page calls the real TeachExperience, but verify all session commands and progress reads against V2-006/V2-010 instead of assuming the frontend interaction is complete because the component renders.
7. **Marketplace-to-install composition:** verify that listing, entitlement, installation, version pinning and execution authorization are all composed from the actual V2-012/V2-002 contracts.
8. **Run composition:** verify that RunExperience uses all required existing commands for approval, pause/resume, cancellation and recovery, rather than implementing presentation-only affordances for commands that are absent or differently shaped.
9. **Scheduling composition:** verify every displayed human schedule state against V2-009's actual subscription/trigger model, including duplicate/missed-window/offline behavior.
10. **Cross-host product reachability:** verify whether the UX exposes already-implemented cross-device/placement/handoff capabilities or leaves operational functionality inaccessible.

These are hypotheses. Browser evidence and backend-contract inspection must decide each one.

## Phase sequence

### R0 — Repository and operational contract inventory

Architect/worker reads the complete V2 architecture package, all V2 Work Orders, current API route registry, operational module barrels, frontend API client, V2 UX components, integration gates, dogfooding evidence and exact live `main`.

Deliverable: a journey→route→service→authority inventory with exact repository paths and a list of suspected composition seams.

### R1 — Real-user browser reconnaissance

Z.ai runs the application with its Agent Browser using real user interaction. It must execute the complete journey inventory above, using safe fixtures and real backend state. It must capture:

- route and action taken;
- observed UI state;
- expected state from V2 UX architecture;
- backend/network outcome;
- exact failure/error when one occurs;
- screenshot or equivalent browser evidence;
- whether the defect is reproducible;
- whether the failure is product data, provider/configuration, frontend logic, backend command, or missing authority.

No fix is made during reconnaissance.

### R2 — Operational/UX discrepancy analysis

The worker correlates every failed or suspicious journey against the actual backend implementation. It MUST locate the existing function/route/service before declaring a missing capability.

Every finding receives exactly one primary classification:

- `UX_DEFECT`
- `WIRED_TO_WRONG_AUTHORITY`
- `WIRED_TO_WRONG_COMMAND_OR_READ`
- `MISSING_ADAPTER_OR_COMPOSITION`
- `MISSING_PUBLIC_AUTHORITY_CONTRACT`
- `TRUE_ARCHITECTURE_GAP`
- `ENVIRONMENT_OR_DEPLOYMENT_DEFECT`
- `EXPECTED_UNAVAILABLE_SURFACE`

### R3 — Worker report

Produce one durable report containing:

1. complete journey matrix;
2. pass/fail/blocked result for every journey;
3. exact evidence;
4. operational authority mapping;
5. discrepancy classification;
6. root cause;
7. proposed minimal repair;
8. architectural consequences;
9. whether the repair needs an ordinary implementation Work Order or a governed V2 architecture change;
10. regression tests and dogfooding required to close the finding.

The worker MUST NOT self-authorize architecture changes.

### R4 — Architect reconciliation

The Architect reviews the report against the actual code and architecture.

For each proposal the Architect decides:

- accept unchanged;
- revise to a smaller/safer composition fix;
- reject because existing functionality was misunderstood;
- split into multiple bounded implementation slices;
- escalate as a V2 architecture change only where an existing authority contract truly cannot satisfy the product intent.

The Architect produces the canonical repair backlog and dependency order.

### R5 — Governed repair implementation

Create bounded Work Orders/PRs from the reconciled backlog. Fix the smallest seam first. Prefer wiring the UX to existing operational authorities over creating new backend concepts.

Every repair PR must include discrimination tests where an incorrect authority/route could otherwise appear to work, and real browser verification for the affected journey.

### R6 — Full re-audit

Run the complete journey matrix again on the repaired tree. A prior pass is not durable proof after a repair. Verify that fixes did not create new authority duplication, semantic drift, or deployment-specific behavior.

### R7 — V2 release readiness gate

Only after the full matrix is green/legitimately unavailable with evidence may the Architect advance the V2 deployment roadmap to production deployment.

## Evidence requirements

The final audit package MUST contain:

- exact tested `main`/PR head SHA;
- staging environment identity (without secrets);
- browser agent run transcript/log;
- screenshots for failed and repaired critical journeys;
- journey matrix;
- backend route/service mapping;
- classification/root-cause table;
- accepted/rejected Architect proposals;
- implementation PR references;
- regression results;
- final repeat-audit results;
- unresolved findings with explicit severity and deployment disposition.

## Exit criteria

The program exits only when:

1. every exposed V2 journey has been exercised or explicitly marked impossible/unavailable with repository-backed justification;
2. every failure has an operational owner/root cause classification;
3. every proposed architectural fix has been reviewed by the Architect;
4. all accepted ordinary fixes are merged and re-audited;
5. any genuine architecture gap is governed through the V2 architecture-change mechanism;
6. no critical user journey is blocked by an undocumented UX↔operational-authority mismatch;
7. the deployment roadmap can be resumed from an evidence-backed V2 release candidate.

## Relationship to deployment

`V2-REALITY-AUDIT-001` is a required precondition to the V2 deployment roadmap. Deployment infrastructure must not be used to mask product/operational composition defects. Provider configuration can fix environmental failures; it cannot turn a missing WorkflowIR authoring authority into a functioning V2 creation product.
