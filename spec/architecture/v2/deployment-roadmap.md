# WorkflowOS V2 — Productionization Roadmap

**Status:** GOVERNED V2 PRODUCTIZATION PLAN
**Purpose:** deploy the completed WorkflowOS V2 product as a low-cost, production-capable service using provider-neutral interfaces and free-tier-first infrastructure.
**Scope:** deployment/runtime infrastructure only. This document does not redefine WorkflowOS semantics, authorities, workflow behavior, or the V2 product model.

## Mandatory pre-deployment gate

Productionization is **LOCKED** until `V2-REALITY-AUDIT-001 — Product Reality, Journey, and Architecture Reconciliation` is accepted by the Architect.

The audit must complete its repository-defined exit criteria: real-browser exercise of the reachable V2 journeys, UX-to-operational route/service/authority tracing, durable worker report, Architect dispositions, bounded accepted repairs where required, and a repeat audit showing no critical UX-to-operational architecture mismatch. A browser-observed defect must not be “fixed” by inventing a second workflow, execution, verification, evidence, authorization, scheduling, or governance authority.

Canonical audit artifacts:

- `spec/architecture/v2/V2-REALITY-AUDIT-001.md`
- `spec/architecture/v2/V2-REALITY-AUDIT-001-CANONICAL-DISPATCH.md`
- `docs/v2/V2-REALITY-AUDIT-001-WORKER-REPORT-TEMPLATE.md`
- `docs/v2/V2-REALITY-AUDIT-001-ARCHITECT-DISPOSITION.md`
- `spec/development-state/v2-work-order-state.json`

No DEP item may activate before this gate is satisfied. Deployment is downstream of product reality, not an alternative path around it.

## Product baseline

V2-017 Universal Product UX is complete. The product baseline is the current `main` tree. The post-UX reality audit is a separate pre-deployment gate and does not reopen the V2-017 UX graph unless the Architect explicitly authorizes a bounded corrective Work Order from audit evidence.

## Provider strategy

Default provider choices are selected for four properties: usable free/low-cost entry tier, production suitability for the current scale, simple operations, and clean migration paths.

| Concern | Initial provider | Role | Exit condition |
|---|---|---|---|
| Frontend | Vercel | V2 web application delivery | traffic/team requirements exceed Hobby |
| DNS / edge | Cloudflare | DNS, TLS, edge protection | advanced enterprise/network requirements |
| Bot protection | Cloudflare Turnstile | abuse-sensitive public flows | advanced bot-management requirement |
| PostgreSQL | Neon | authoritative relational state | sustained DB load/storage/HA/compliance needs |
| Redis | Upstash Redis | queue, locks, cache; never source of truth | sustained throughput/HA requirements |
| Object storage | Cloudflare R2 | durable object/artifact storage | storage/feature/compliance needs exceed R2 |
| API compute | Railway initially | Fastify/Bun API container | usage economics or operational needs justify alternative compute |
| Worker compute | Railway initially | WorkerHost process using same backend image | same as API compute |
| CI/CD | GitHub Actions | build, verify, deploy, smoke test | platform/reliability requirements justify change |
| Observability | Better Stack initially | uptime, logs, traces, alerts | telemetry volume/security requirements exceed free tier |
| Email | Resend initially | transactional email | volume/domain/compliance needs exceed free tier |

## Canonical deployment topology

```text
                        Cloudflare
                  DNS / TLS / edge / Turnstile
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
          Vercel                    API hostname
        V2 frontend                     │
                                        ▼
                                  Railway API
                                        │
                         ┌──────────────┼──────────────┐
                         │              │              │
                         ▼              ▼              ▼
                       Neon          Upstash           R2
                    PostgreSQL        Redis          objects
                         │              │
                         └──────┬───────┘
                                ▼
                         Railway Worker
                         same backend image

GitHub Actions controls build → verify → deploy → smoke test.
GitHub App remains the repository/webhook integration authority.
```

## Authority boundaries

- PostgreSQL is authoritative application state.
- Redis is non-authoritative coordination/queue/cache state.
- R2 is durable object storage, not relational state.
- The API and worker are two process roles of the existing modular monolith; they are not new application authorities.
- Vercel, Railway, Neon, Upstash, Cloudflare, GitHub Actions and observability providers are infrastructure providers, not WorkflowOS semantic authorities.
- Infrastructure selection must not introduce a second workflow engine, verification authority, evidence authority, release authority, or governance authority.

## Environment model

```text
Development
  PGlite + in-memory Redis + local object storage

Staging
  isolated Neon database/branch
  isolated Upstash database
  isolated R2 bucket/prefix
  Railway API + Worker
  Vercel preview/preview environment

Production
  isolated Neon project/database
  isolated Upstash database
  isolated R2 bucket
  Railway API + Worker
  Vercel production
  Cloudflare production DNS/edge configuration
```

Production and staging credentials must never be shared. Preview environments must not access production state.

## Implementation sequence

```text
V2-REALITY-AUDIT-001
   │  hard pre-deployment gate
   ▼
DEP-001  Lock deployment architecture + provider interfaces
   ↓
DEP-002  Environment/secrets/config contract
   ↓
DEP-003  Neon staging + production databases
   ↓
DEP-004  Upstash Redis staging + production
   ↓
DEP-005  R2 object-storage adapter + migration-safe configuration
   ↓
DEP-006  Railway API + Worker deployment
   ↓
DEP-007  Vercel production delivery
   ↓
DEP-008  Cloudflare DNS/TLS/edge/Turnstile
   ↓
DEP-009  GitHub Actions CI/CD + migration + rollback controls
   ↓
DEP-010  Observability + alerting + cost controls
   ↓
DEP-011  Full production smoke test + V2 dogfooding
   ↓
DEP-012  Architect production acceptance
```

Each DEP item is a bounded implementation slice with its own evidence and exact-head review. Later slices depend on merged outputs only.

## Cost principles

1. Prefer free tiers for development, staging and early production traffic.
2. Never trade away authoritative-state durability or isolation solely to remain free.
3. Put hard usage/cost alerts on every provider that can generate variable charges.
4. Keep provider access behind existing environment/configuration abstractions so compute, database, Redis and object storage can be replaced independently.
5. Do not add a provider because it bundles a capability already represented by an existing WorkflowOS authority.

## Current provider facts

The initial selections are based on provider-published current pricing and must be rechecked immediately before implementation because provider terms may change.

## Non-goals

- Rewriting WorkflowOS as microservices.
- Moving workflow semantics to a cloud provider.
- Replacing PostgreSQL with a hosted proprietary state model.
- Making Redis authoritative.
- Replacing GitHub as the repository/PR integration authority.
- Reopening V2-017 product UX scope merely because productionization is next.
