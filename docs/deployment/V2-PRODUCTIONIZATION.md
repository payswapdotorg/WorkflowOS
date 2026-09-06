# WorkflowOS V2 — Production Deployment Baseline

This is the implementation-facing deployment baseline for V2-DEPLOY-001.

## Target stack

| Layer | Provider | Initial role |
|---|---|---|
| Web | Vercel | WorkflowOS V2 frontend |
| Edge | Cloudflare | DNS, TLS, WAF/edge controls |
| Bot protection | Cloudflare Turnstile | abuse-sensitive public flows |
| Database | Neon | authoritative PostgreSQL |
| Redis | Upstash Redis | queue, locks, cache; non-authoritative |
| Objects | Cloudflare R2 | durable artifacts/files |
| Compute | Railway | API + Worker processes, existing Docker image |
| CI/CD | GitHub Actions | verify, build, deploy, smoke test |
| Observability | Better Stack | uptime, logs, traces, alerts |
| Email | Resend | transactional email |

## Environment isolation

Development uses the repository's PGlite + in-memory Redis + local object-storage path.

Staging uses isolated managed resources.

Production uses separate production resources and secrets. Production credentials are never shared with staging or preview environments.

## Migration/portability rules

Provider integrations must be driven through environment variables and existing application abstractions. A provider hostname, bucket name, database identifier or credential must never be embedded into domain logic.

The infrastructure must be replaceable one layer at a time. PostgreSQL remains the authoritative store regardless of provider. Redis remains disposable/non-authoritative. Object storage remains an object-storage concern and cannot become application state.

## First implementation slice

DEP-001 only locks configuration boundaries and repository deployment artifacts. It must not provision production credentials, mutate application semantics, or deploy to production. Later slices perform actual provider provisioning/deployment.
