# /runtime module

WORK-026 — Provider-independent deployment / preview environment boundary.

Owns the integration link between a WorkflowOS project and an external
deployment provider (Vercel, fake, future), plus per-commit deployment
records (preview URL, status, commit sha).

## Public surface

See `index.ts` — types only, no concrete implementations.

## Internal

`internal/` contains:
- `runtime.types.ts` — interfaces
- `pg-runtime-repository.ts` — PostgreSQL persistence
- `vercel-deployment-provider.ts` — real Vercel adapter (activated by VERCEL_API_TOKEN)
- `fake-deployment-provider.ts` — deterministic adapter for CI/tests
- `deployment-service.ts` — provider-independent facade
- `runtime-status-service.ts` — aggregates GitHub+Vercel+Architect+Agent status

## Boundaries enforced

- No provider SDK in the domain layer (only in adapter implementations).
- Secrets never cross this boundary.
- No direct GitHub API (that's /github's responsibility).
- No workflow state mutation.
