# /github

**Responsibility (frozen):** GitHub App, GitHub webhooks, Pull Requests, CI integration.

This directory is a frozen backend module boundary (spec/architecture.md §6).
Cross-module communication must go through `index.ts`; `internal/` is private.
