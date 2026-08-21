# /architecture

**Responsibility (frozen):** Architecture Management, ADRs, Architecture Change Requests, Architecture Versions.

This directory is a frozen backend module boundary (spec/architecture.md §6).
Cross-module communication must go through `index.ts`; `internal/` is private.
