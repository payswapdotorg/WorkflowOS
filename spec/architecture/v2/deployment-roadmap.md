# WorkflowOS V2 — Productionization Roadmap

**Status:** GOVERNED V2 PRODUCTIZATION PLAN
**Purpose:** deploy the completed WorkflowOS V2 product as a low-cost, production-capable service using provider-neutral interfaces and free-tier-first infrastructure.
**Scope:** deployment/runtime infrastructure only. This document does not redefine WorkflowOS semantics, authorities, workflow behavior, or the V2 product model.

## Product baseline

V2-017 Universal Product UX is complete. T1–T16 are closed and the product baseline is the current `main` tree. Productionization begins from that merged baseline and must not reopen the V2-017 UX graph.

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

The initial selections are based on provider-published current pricing:

- Vercel Hobby is $0/month and includes automatic CI/CD, HTTPS/SSL, previews, CDN delivery and documented usage allowances; it is intended for personal/non-commercial use, so commercial operation may require Pro. 
- Neon Free is $0 with 100 CU-hours per project/month, 0.5 GB storage/project, scale-to-zero and branching.
- Cloudflare R2 Free includes 10 GB-month storage, 1M Class A requests, 10M Class B requests and free Internet egress each month.
- Upstash Redis Free includes 256 MB data, 10 GB monthly bandwidth and 500K commands/month.
- Railway's post-trial Free plan provides $1/month of credit, so Railway is an initial compute choice rather than a claim of indefinitely-free production hosting.
- Cloudflare Turnstile's Free plan supports most production applications with unlimited challenges and up to 20 widgets/account.
- Better Stack's Free plan includes uptime/heartbeat monitoring plus limited logs, traces, metrics and exception/session-replay allowances.
- Resend Free includes 3,000 emails/month and a 100/day sending limit.

Provider limits must be rechecked at implementation time; this document is a deployment baseline, not a promise that provider pricing will remain unchanged.

## Non-goals

- Rewriting WorkflowOS as microservices.
- Moving workflow semantics to a cloud provider.
- Replacing PostgreSQL with a hosted proprietary state model.
- Making Redis authoritative.
- Replacing GitHub as the repository/PR integration authority.
- Reopening V2-017 product UX scope.
