# /auth

**Responsibility (frozen):** Authentication, WorkflowOS user identity boundary (paired with /users).

This directory is a frozen backend module boundary (spec/architecture.md §6).
Cross-module communication must go through `index.ts`; `internal/` is private.
