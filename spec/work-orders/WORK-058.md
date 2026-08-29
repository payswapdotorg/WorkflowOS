# WORK-058 — Adaptive Assurance Engine

Status: planned.

Objective: Select deterministic assurance depth for simple, complex, and critical changes without changing authority semantics.

Dependencies: WORK-053, WORK-055, WORK-046, WORK-051, WORK-052.

Scope: assurance classification, checkpoint/evidence requirement selection, escalation and fail-closed unknown handling.

Required invariants: LIGHT/STANDARD/HIGH_ASSURANCE/CRITICAL vocabulary is closed; unknown classifications fail closed; deeper assurance never permits forbidden behavior or reduces mandatory proofs.

Required proof: deterministic classification, mutation tests for lowered assurance, boundary coverage for schema/security/concurrency/external-side-effect changes.

Definition of done: every Work Order can receive a deterministic assurance profile and corresponding proof contract.
