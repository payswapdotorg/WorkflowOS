# V2-DEPLOY-001 — WorkflowOS V2 Productionization

**Status:** READY
**Program:** WorkflowOS V2 productionization
**Roadmap:** `spec/architecture/v2/deployment-roadmap.md`
**Precondition:** V2-017 Universal Product UX complete on `main`.

## Objective

Establish and implement the production infrastructure required to run the completed WorkflowOS V2 product at low initial cost, prioritizing usable free tiers while preserving application portability and existing authority boundaries.

## Provider baseline

- Vercel: frontend delivery.
- Cloudflare: DNS, TLS, edge protection and optional Turnstile.
- Neon: authoritative PostgreSQL.
- Upstash Redis: non-authoritative queue, lock and cache.
- Cloudflare R2: durable object/artifact storage.
- Railway initially: API and Worker compute from the existing backend Docker image.
- GitHub Actions: CI/CD, deployment and smoke-test orchestration.
- Better Stack initially: external monitoring/logging/traces/alerts.
- Resend initially: transactional email.

These are replaceable infrastructure providers, not WorkflowOS semantic authorities.

## Required sequence

DEP-001 lock deployment architecture and provider-neutral configuration boundaries.
DEP-002 establish environment, secrets and configuration contract.
DEP-003 provision isolated Neon staging/production databases and migration process.
DEP-004 provision isolated Upstash Redis environments and validate queue/lock behavior.
DEP-005 implement and prove Cloudflare R2 object-storage adapter without changing object-storage authority semantics.
DEP-006 deploy API and Worker roles from the existing backend image.
DEP-007 deploy V2 frontend to Vercel and connect it to the production API.
DEP-008 configure Cloudflare DNS/TLS/edge controls and Turnstile where required.
DEP-009 establish deployment CI/CD, migration gating, rollback and smoke tests.
DEP-010 establish observability, alerting and provider cost controls.
DEP-011 run complete production smoke test and representative V2 product dogfooding.
DEP-012 Architect production acceptance and canonical finalization.

## Hard boundaries

- PostgreSQL remains authoritative application state.
- Redis remains non-authoritative.
- R2 stores objects/artifacts and does not become an application database.
- API and Worker remain process roles of the existing modular monolith.
- No microservice decomposition is introduced by this Work Order.
- No cloud provider becomes a WorkflowOS workflow, execution, verification, evidence or governance authority.
- Staging and production state are isolated.
- Credentials and secrets never enter the repository.
- Preview environments never access production state.
- Provider-specific configuration is contained behind existing environment/configuration boundaries so infrastructure can be replaced independently.
- V2-017 UX scope is closed and must not be reopened as part of deployment work.

## Acceptance criteria

1. A documented V2 staging and production topology exists and matches the implementation.
2. The API and Worker can run from the existing backend container without codebase decomposition.
3. Neon PostgreSQL is the sole authoritative application database in both staging and production.
4. Redis is demonstrably non-authoritative for application truth.
5. R2 can persist and retrieve the application's required object types through the existing storage abstraction, with filesystem storage retained only where explicitly required for local development.
6. Production frontend/API connectivity is HTTPS and environment-specific.
7. Production secrets are externalized and separated by environment.
8. Database migrations are gated, observable and rollback-aware.
9. Health/readiness, smoke tests, rollback paths and monitoring are documented and executable.
10. Cost/usage alerts are configured for variable-billing providers.
11. Representative V2 journeys succeed in the real deployed environment, including authentication, workflow browsing/detail, creation entry, run/recovery surfaces, teaching, version/update presentation and activity/trust surfaces as applicable to the deployed backend capabilities.
12. No deployment change introduces a second WorkflowOS authority or changes frozen V2 semantics.

## Verification obligations

- Exact base/head recorded for every bounded implementation slice.
- Provider configuration is tested against isolated staging resources before production promotion.
- Failure/discrimination tests prove Redis/object-store/provider failure does not silently rewrite authoritative application state.
- Migration tests prove the API/Worker startup roles cannot race to own schema migration.
- Health/readiness tests fail closed when required authoritative dependencies are unavailable.
- Cost-control configuration is verified from provider dashboards or APIs where available.
- Production dogfooding evidence includes URLs, timestamps, deployed revision, test transcript/results, and screenshots or equivalent durable evidence where appropriate.

## Stop conditions

Stop and raise an architecture change if the implementation requires changing WorkflowOS semantic authority, introducing a second execution/workflow/verification/evidence authority, making an infrastructure provider authoritative for application state, or reopening V2-017 semantics.

## Completion

V2-DEPLOY-001 is complete only after DEP-001 through DEP-012 are implemented/verified as applicable, the production deployment is live, representative V2 dogfooding passes, evidence is persisted, the exact production revision is recorded, and the Architect performs the final acceptance and repository-state reconciliation.
