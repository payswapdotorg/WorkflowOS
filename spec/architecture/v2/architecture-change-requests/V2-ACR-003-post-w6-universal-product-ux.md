# V2-ACR-003 — Post-W6 Universal Product UX Surface

**Status:** PROPOSED / governed product-layer evolution
**Related Work Order:** `V2-017`
**Design authority:** `docs/superpowers/specs/2026-09-03-workflowos-universal-ux-design.md`

## Reason
V2-CTRL-002 intentionally closed the original V2 implementation roadmap after W6/IG-005. The merged V2 architecture now exposes a broad product surface that needs a coherent human-facing UX layer. This evolution is presentation/information-architecture work and does not change workflow semantics or execution authority.

## Decision
Authorize one post-W6 product-layer Work Order, V2-017, to compose the human-facing UX over existing V2 authorities. Extend roadmap/state only enough to make that Work Order governable and independently verifiable.

## Preserved invariants
- WorkflowIR remains the semantic source of truth.
- WorkflowVersion remains immutable.
- Run, Deployment, Node, Capability, authorization, placement, evidence, attestation and proof remain owned by their existing authorities.
- Marketplace entitlement remains distinct from execution authority.
- Teaching remains derived from the same WorkflowVersion.
- Optimization remains version-producing and approval-controlled.
- No second workflow protocol, workflow engine, evidence authority, verification authority or execution authority.
- No platform-specific workflow semantics.
- The existing developer/engineering control plane remains available as an expert workspace.

## Product UX
The approved design organizes the human-facing experience around MAKE / DO / LEARN / SHARE / IMPROVE; Home / Workflows / Explore / Activity; Search / Ask / Create; Run / Teach Me / Edit; and progressive disclosure from DO → UNDERSTAND → CONTROL → INSPECT.

## Boundary
User-facing terminology may translate architectural concepts but may not alter semantics. Conversation is an input mechanism, not a durable workflow format or authority. UI logic must not fabricate state when an authority read fails. Cryptographic authenticity must never be presented as automatic proof of a physical side effect.

## Stop condition
If implementation requires changing a frozen semantic or authority contract, V2-017 must stop and raise a separate governed architecture change.
