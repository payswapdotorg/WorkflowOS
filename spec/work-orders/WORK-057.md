# WORK-057 — Change Programs and Change Sets

Status: planned.

Objective: Govern large system-state transitions by grouping dependent Work Items into Change Programs and coherent Change Sets while retaining atomic Work Item semantics.

Dependencies: WORK-053, WORK-054, WORK-046, WORK-047.

Scope: program/set model, dependency-aware decomposition, parallelization metadata, cross-item acceptance/proof relationships.

Required invariants: one Work Item remains the atomic execution/review unit; no second workflow engine; no silent cross-tenant references; dependency graph remains acyclic; parallel execution requires dependency eligibility plus protected-surface compatibility.

Required proof: concurrent scheduling discrimination, DAG validation, cross-program identity isolation, partial-failure/recovery semantics.

Definition of done: very large changes can be decomposed and executed safely without weakening existing Work Item authority.
