# WorkflowOS V2 — Free-Tier-First Cost Baseline

Provider pricing is volatile and must be rechecked before provisioning. The following is the current architecture baseline as of 2026-09-06.

| Provider | Current free/entry allowance | V2 use |
|---|---|---|
| Vercel Hobby | $0; documented free frontend/edge allowances | frontend/previews |
| Neon Free | $0; 100 CU-hours/project/month, 0.5 GB/project | PostgreSQL |
| Cloudflare R2 | 10 GB-month storage, 1M Class A, 10M Class B, free egress | objects |
| Upstash Redis Free | 256 MB, 10 GB bandwidth, 500K commands/month | queue/locks/cache |
| Railway | $5 one-time trial, then $1/month free credit | initial API/Worker compute |
| Cloudflare Turnstile Free | unlimited challenges; up to 20 widgets/account | abuse protection |
| Better Stack Free | limited uptime/logs/traces/metrics/errors | observability |
| Resend Free | 3,000 emails/month, 100/day | transactional email |

V2 must treat these as cost-optimization baselines, not availability guarantees. Billing alerts and explicit provider exit conditions are required before production traffic is admitted.

## Economic rule

Never optimize infrastructure cost by weakening authoritative-state durability, environment isolation, security, backup/restore, migration safety, or observability.

The cheapest acceptable production deployment is the one that preserves WorkflowOS authority boundaries and can be upgraded without rewriting domain logic.
