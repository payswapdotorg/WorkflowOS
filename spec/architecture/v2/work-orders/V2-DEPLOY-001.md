# V2-DEPLOY-001 — WorkflowOS V2 Productionization Program Charter

**Status:** GOVERNED PROGRAM CHARTER — not a single implementation packet
**Program:** WorkflowOS V2 productionization
**Roadmap:** `spec/architecture/v2/deployment-roadmap.md`
**Execution graph:** `spec/architecture/v2/V2-AUTONOMOUS-DELIVERY-ROADMAP.md`
**Execution protocol:** `spec/architecture/v2/AUTONOMOUS-DELIVERY-PROTOCOL.md`
**Hard precondition:** V2-REALITY-AUDIT-001 accepted, all release-blocking reality repairs merged, and R6 repeat audit passed.

## Purpose

This file is the governing umbrella for productionization. The actual implementation work is deliberately decomposed into bounded Work Orders `DEP-001` through `DEP-012` so a long-running autonomous orchestrator can execute independent packets concurrently without creating one oversized branch or one ambiguous PR.

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

## Bounded packet registry

| Packet | Work Order | Execution class | Dependencies |
|---|---|---|---|
| Architecture foundation | `DEP-001` | SERIAL FOUNDATION | reality gate + R6 |
| Configuration | `DEP-002` | PARALLEL AFTER DEP-001 | DEP-001 |
| PostgreSQL | `DEP-003` | PARALLEL AFTER DEP-002 | DEP-002 |
| Redis | `DEP-004` | PARALLEL AFTER DEP-002 | DEP-002 |
| R2 | `DEP-005` | PARALLEL AFTER DEP-002 | DEP-002 |
| API + Worker | `DEP-006` | SERIALIZED RUNTIME FOUNDATION | 003,004,005 |
| Frontend | `DEP-007` | PARALLEL AFTER DEP-002 | DEP-002 |
| Edge | `DEP-008` | PARALLEL AFTER API + frontend | 002,006,007 |
| CI/CD | `DEP-009` | PARALLEL AFTER DEP-006 | 002,003,006 |
| Observability | `DEP-010` | PARALLEL AFTER DEP-006/edge | 002,006,008 |
| Production dogfooding | `DEP-011` | FINAL GATE | 003–010 as declared |
| Architect acceptance | `DEP-012` | FINAL AUTHORITY GATE | DEP-011 |

The complete dependency graph is canonicalized in `V2-AUTONOMOUS-DELIVERY-ROADMAP.md`.

## Hard boundaries

- PostgreSQL remains authoritative application state.
- Redis remains non-authoritative.
- R2 stores objects/artifacts and does not become an application database.
- API and Worker remain process roles of the existing modular monolith.
- No microservice decomposition is introduced by productionization.
- No cloud provider becomes a WorkflowOS workflow, execution, verification, evidence or governance authority.
- Staging and production state are isolated.
- Credentials and secrets never enter the repository.
- Preview environments never access production state.
- Provider-specific configuration is contained behind existing environment/configuration boundaries.
- V2-017 UX semantics remain closed.
- Productionization cannot bypass the reality-audit gate.

## Program completion

The productionization program is complete only after all bounded packets are merged, DEP-011 production dogfooding passes, evidence and the exact production revision are persisted, and DEP-012 Architect acceptance is recorded. A defect discovered during deployment that is outside the active packet becomes a new bounded Work Order rather than drive-by scope expansion.
