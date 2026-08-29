# WorkflowOS v1.1 Architecture

## 1. Engineering Control Loop

The system is modeled as a closed loop:

SENSE → UNDERSTAND → PLAN → CHECK → EXECUTE → VERIFY → REVIEW → RELEASE → OBSERVE → LEARN → SENSE.

Each stage uses existing authoritative boundaries. The loop is connective governance, not a new workflow engine.

## 2. Complexity-adaptive engineering

Work Item remains the atomic governed change. Change Programs and Change Sets may contain many Work Items. Assurance depth is selected deterministically from declared impact/surface characteristics:

LIGHT → STANDARD → HIGH_ASSURANCE → CRITICAL.

The assurance profile can increase checkpoint/evidence depth but cannot reduce security, tenancy, authority, verification, provenance, identity, idempotency, or concurrency guarantees.

## 3. System Model

A derived System Model captures components, interfaces, dependencies, data flows, deployments, ownership/context, runtime boundaries, and quality-attribute relationships. Facts have provenance and never overwrite authoritative domain state.

## 4. Quality attributes and fitness

Important systems may define measured attributes including reliability, availability, latency, throughput, scalability, security, modifiability, operability, cost, usability, resilience, and delivery risk. Fitness observations compare measured evidence with baselines/targets/thresholds and may create governed Work Items or Architecture Change Requests.

## 5. Engineering signals

Raw observations from repository, CI, runtime, incidents, security, dependencies, performance, user feedback and business/product signals become provenance-preserving Engineering Signals. Signals inform planning; they do not directly mutate authoritative workflow, architecture, verification, or review state.

## 6. Large change orchestration

A Change Program represents a desired system-state transition. A Change Set groups a coherent subset of Work Items. Dependency-aware scheduling may execute independent Work Items concurrently. Each Work Item retains its existing Work Order, verification, review, and PR semantics.

## 7. Transformation completeness

For migrations/refactors, behavioral correctness and requested-transformation completeness are separate proofs. A completed change may require structural audits showing obsolete paths are removed and intended migration coverage is complete.

## 8. Operational/release governance

Where applicable, release governance may use SLOs, error budgets, progressive rollout, rollback strategy and post-release validation. These remain subordinate to `/workflows`, `/github`, `/verification`, and runtime authorities.

## 9. Architecture evolution

Architecture fitness and conformance may produce an Architecture Change Request. Approval creates a new immutable ArchitectureVersion. A self-hosted agent cannot change the governing architecture in place.

## 10. Self-hosting

WorkflowOS may use its own Work Items, Work Orders, execution, verification, review, GitHub and maintenance lifecycle to modify WorkflowOS. The same authorities and safeguards apply to internal and customer systems.
