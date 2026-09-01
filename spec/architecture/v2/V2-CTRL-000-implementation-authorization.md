# V2-CTRL-000 — V2 Implementation Authorization

**Architecture generation:** WorkflowOS 2.0  
**Architecture status:** PROPOSED generation, **APPROVED FOR IMPLEMENTATION**  
**Governing V1:** v1.0 remains frozen and authoritative for V1 behavior.

The product owner has accepted the V2 architecture direction and optimized execution model. V2 Work Orders may therefore be implemented from the repository-resident contracts without conversational approval for each item.

This authorization does **not** silently freeze every proposed detail as immutable forever. The constitution remains the normative anti-drift authority. A concept is frozen for implementation when it is explicitly marked normative there or in a later approved V2 architecture revision. Material reinterpretation requires a governed architecture change before implementation proceeds.

## Sole architect/reviewer

WorkflowOS has one architect/reviewer for this development process. There is no required external architect or second review authority. The sole architect controls architectural interpretation, merge approval, and governed changes.

## Fresh-agent rule

A fresh agent must treat this repository package as sufficient context. It must not require chat history, prior model memory, or an implementation report to determine what to build next.

The authoritative reading path is `spec/architecture/v2/fresh-architect-bootstrap.md`, which points to the constitution, control plane, conformance checklist, roadmap lock, machine-readable state, Work Order, and supporting V2 specifications.

## V2 versus V1

V2 is the forward product roadmap. Remaining V1 roadmap items are deferred unless a V2 state record explicitly reactivates one for a concrete dependency, compatibility/security need, or architectural decision. Existing V1 authorities retain their semantics until a governed transition replaces them.

## Quality ratchet

Speed improvements are allowed only through:

- true parallelism with independent mergeability;
- narrower scopes that preserve complete contracts;
- integration gates after independent merges;
- automation of evidence and state validation;
- earlier dogfooding.

Speed may never come from reduced verification, weakened safety invariants, omitted dogfooding, ignored failures, or semantic shortcuts.
