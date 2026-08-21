# /projects

**Responsibility (frozen):** Projects as the primary WorkflowOS container for a development effort.

This directory is a frozen backend module boundary (spec/architecture.md §6).
Cross-module communication must go through `index.ts`; `internal/` is private.
