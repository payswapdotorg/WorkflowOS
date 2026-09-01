# V2-CTRL-000 — V2 Implementation Authorization

**Architecture generation:** WorkflowOS 2.0  
**Architecture status:** PROPOSED generation, **APPROVED FOR IMPLEMENTATION**  
**Governing V1:** v1.0 remains frozen and authoritative for V1 behavior.  
**Governance refinement:** `V2-ACR-002-governance-control-plane-refinement.md` refines state ownership and post-merge recording without changing merge authority.

The product owner has accepted the V2 architecture direction and optimized execution model. V2 Work Orders may therefore be implemented from the repository-resident contracts without conversational approval for each item.

This authorization does **not** silently freeze every proposed detail as immutable forever. The constitution remains the normative anti-drift authority. A concept is frozen for implementation when it is explicitly marked normative there or in a later approved V2 architecture revision. Material reinterpretation requires a governed architecture change before implementation proceeds.

## Sole architect/reviewer

WorkflowOS has one architect/reviewer for this development process. There is no required external architect or second review authority. The sole architect controls architectural interpretation, merge approval, and governed changes.

## Fresh-agent rule

A fresh agent must treat this repository package as sufficient context. It must not require chat history, prior model memory, or an implementation report to determine what to build next.

The authoritative reading path is `spec/architecture/v2/fresh-architect-bootstrap.md`, which points to the constitution, control plane, governance refinement, conformance checklist, roadmap lock, canonical development state, Work Order, and supporting V2 specifications.

## V2 versus V1

V2 is the forward product roadmap. Remaining V1 roadmap items are deferred unless a V2 state record explicitly reactivates one for a concrete dependency, compatibility/security need, or architectural decision. Existing V1 authorities retain their semantics until a governed transition replaces them.

## State ownership

The development control plane distinguishes:

- **authoritative facts** — Architect decisions, Work Order scope/dependencies, verification/dogfooding evidence, and Git merge history;
- **operational implementation state** — branch, base SHA, PR binding, last verified SHA, unresolved findings and next mechanical action;
- **derived projections** — eligibility, frontier, checkpoint summaries and navigation fields.

Derived projections are never an alternate authority and cannot authorize work, approve architecture, merge a PR, or redefine completion.

## Post-merge recording

The Architect's merge remains the sole completion event. A post-merge recorder may automatically or deterministically reconcile canonical state from authoritative Git evidence because that operation records an already-established fact; it does not constitute a second approval.

## Quality ratchet

Speed improvements are allowed only through:

- true parallelism with independent mergeability;
- narrower scopes that preserve complete contracts;
- integration gates after independent merges;
- automation of evidence and state validation/recording;
- earlier dogfooding.

Speed may never come from reduced verification, weakened safety invariants, omitted dogfooding, ignored failures, or semantic shortcuts.
