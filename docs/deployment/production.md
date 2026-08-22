# Production Deployment — WorkflowOS

This document covers the complete production deployment of WorkflowOS to
Vercel (frontend) + Railway (backend API + worker) + Neon (PostgreSQL) +
Railway Redis + Cloudflare R2 (object storage) + GitHub App (webhooks).

## Architecture

```
Vercel (frontend SPA)
   ↓ HTTPS
Railway API (Fastify, WORKFLOWOS_ROLE=api)
   ↓
Neon PostgreSQL (authoritative)
   ↓
Railway Redis (queue/locks/cache, non-authoritative)
   ↓
Cloudflare R2 (object storage)
   ↓
GitHub App (webhooks → /webhooks/github)
   ↓
Railway Worker (WorkerHost, WORKFLOWOS_ROLE=worker)
```

## Prerequisites

Before starting, you need accounts on:
- [Neon](https://neon.tech) — PostgreSQL
- [Railway](https://railway.app) — backend container hosting + Redis
- [Cloudflare](https://dash.cloudflare.com) — R2 object storage
- [GitHub](https://github.com) — GitHub App for webhooks
- [Vercel](https://vercel.com) — frontend hosting

## 1. Neon PostgreSQL

1. Create a Neon project → select your region.
2. Create a database (e.g. `workflowos`).
3. Copy the **pooled** connection string from the Neon dashboard.
4. Save it as `DATABASE_URL` — you'll set it in Railway.

```text
DATABASE_URL=postgresql://USER:PASSWORD@...pooler...neon.tech/workflowos?sslmode=require
```

## 2. Railway — backend + Redis

1. Create a Railway project.
2. **Add Redis**: + Add → Database → Redis. Railway gives you a `REDIS_URL`.
3. **Deploy the API service**:
   - + Add → GitHub Repo → select `pectoraux/WorkflowOS`
   - Root directory: `backend`
   - Railway detects `backend/Dockerfile`
   - Set `WORKFLOWOS_ROLE=api`
   - Set environment variables (see below)
   - Railway assigns a public URL (e.g. `https://workflowos-api.up.railway.app`)
4. **Deploy the Worker service**:
   - + Add → GitHub Repo → same repo
   - Root directory: `backend`
   - Same Dockerfile
   - Set `WORKFLOWOS_ROLE=worker`
   - Same env vars (DATABASE_URL, REDIS_URL, etc.)
   - The worker does NOT need a public URL

### Railway environment variables (API + Worker)

```text
DATABASE_URL=<Neon pooled connection string>
REDIS_URL=<Railway Redis internal URL>
OBJECT_STORAGE_DIR=/data/objects
WORKFLOWOS_ROLE=api   # or worker
PORT=3001             # API only
HOST=0.0.0.0
LOG_LEVEL=info
CORS_ORIGIN=https://app.yourdomain.com
WORKFLOWOS_GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
```

## 3. Cloudflare R2 — object storage

1. Cloudflare Dashboard → R2 → Overview → Create bucket (e.g. `workflowos-prod`).
2. Manage API Tokens → Create API Token → Object Read & Write → scope to bucket.
3. Save:
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_ACCOUNT_ID`
   - `R2_BUCKET_NAME`
   - `R2_ENDPOINT` = `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

> **Note:** The current production deployment uses filesystem object storage
> (`OBJECT_STORAGE_DIR=/data/objects`). To use R2, set `OBJECT_STORAGE_PROVIDER=s3`
> + the R2 credentials. The S3-compatible adapter is on the roadmap.

## 4. GitHub App

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Configure:
   - Homepage: `https://app.yourdomain.com`
   - Webhook URL: `https://api.yourdomain.com/webhooks/github`
   - Webhook secret: generate a secure random string
   - Repository permissions: Contents (Read), Pull requests (Read), Checks (Read)
   - Subscribe to events: `pull_request`, `check_run`, `workflow_run`, `push`
3. Save the App ID.
4. Generate a private key (PEM) → save securely.
5. Install the App into your repository/org.

### GitHub env vars (set in Railway)

```text
WORKFLOWOS_GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
GITHUB_APP_ID=<app-id>
GITHUB_PRIVATE_KEY=<pem-content>
```

## 5. Vercel — frontend

The frontend is already deployed to Vercel. Update its environment:

1. Vercel → your `frontend` project → Settings → Environment Variables.
2. Set:
   ```text
   BACKEND_URL=https://api.yourdomain.com
   ```
3. Redeploy: `vercel --prod --token=<vercel-token>` from the `frontend/` directory.

## 6. Custom domains

### API domain (Railway)
1. Railway → API service → Settings → Networking → Generate Domain.
2. Add your custom domain: `api.yourdomain.com`.
3. Add the CNAME record Railway gives you to your DNS provider.

### Frontend domain (Vercel)
1. Vercel → your frontend project → Settings → Domains.
2. Add `app.yourdomain.com`.
3. Add the DNS record Vercel gives you.

## 7. CORS

The backend is configured to accept CORS from the `CORS_ORIGIN` env var.
Set it to your Vercel frontend URL:

```text
CORS_ORIGIN=https://app.yourdomain.com
```

Do NOT use `*` for authenticated production APIs.

## 8. Migrations

The API role runs migrations on startup (the worker skips them to avoid races).
When you deploy for the first time, the API will apply all 16 migrations
automatically. To verify:

```bash
# After the API is running
curl https://api.yourdomain.com/health/ready
# Should return {"status":"ready","checks":{"postgres":{"ok":true},...}}
```

## 9. Bootstrap owner

After the first deployment, provision the initial admin:

```bash
DATABASE_URL=<neon-url> \
WORKFLOWOS_BOOTSTRAP_API_KEY=<your-secure-key> \
bun scripts/bootstrap-production.ts
```

This creates:
- An organization
- An owner user
- An API key (printed to stdout)
- A project

Use the API key to log in to the frontend.

## 10. Health / readiness validation

```bash
# Liveness
curl https://api.yourdomain.com/health
# → {"status":"ok"}

# Readiness (checks PostgreSQL, Redis, ObjectStore)
curl https://api.yourdomain.com/health/ready
# → {"status":"ready","checks":{...}}
```

Railway should use `/health/ready` for deployment probes.

## 11. Smoke test

After deployment, verify the full stack:

```bash
API=https://api.yourdomain.com
KEY=<bootstrap-api-key>
PROJECT=<bootstrap-project-id>

# Health
curl -sS $API/health

# Readiness
curl -sS $API/health/ready

# Auth — project access
curl -sS -H "x-api-key: $KEY" $API/projects/$PROJECT

# Architecture
curl -sS -H "x-api-key: $KEY" $API/projects/$PROJECT/architectures

# Work items
curl -sS -H "x-api-key: $KEY" $API/work-items/$PROJECT/work-orders

# Workflow state
curl -sS -H "x-api-key: $KEY" $API/projects/$PROJECT/workflow/next-work-item

# Audit history
curl -sS -H "x-api-key: $KEY" $API/projects/$PROJECT/audit
```

## 12. Rollback strategy

- **Frontend (Vercel)**: Vercel keeps every deployment. Roll back via the
  dashboard → Deployments → Promote previous.
- **Backend (Railway)**: Railway keeps every deployment. Roll back via the
  dashboard → Deployments → Redeploy previous.
- **Database (Neon)**: Neon supports point-in-time recovery. Use the
  Neon dashboard to restore to a previous timestamp if needed.

## 13. Secret rotation

### API key
1. Run the bootstrap script with a new `WORKFLOWOS_BOOTSTRAP_API_KEY`.
2. The old key remains valid (you can revoke it from the database if needed).

### GitHub webhook secret
1. Generate a new secret.
2. Update the GitHub App's webhook secret in the GitHub UI.
3. Update `WORKFLOWOS_GITHUB_WEBHOOK_SECRET` in Railway.
4. Redeploy the API + worker.

### R2 credentials
1. Cloudflare → R2 → Manage API Tokens → Create new token.
2. Update the R2 env vars in Railway.
3. Redeploy.
4. Revoke the old token.

### Neon database password
1. Neon → Reset password.
2. Update `DATABASE_URL` in Railway.
3. Redeploy.

## Environment variables summary

| Variable | Where | Description |
|---|---|---|
| `DATABASE_URL` | Railway (API + Worker) | Neon PostgreSQL connection string |
| `REDIS_URL` | Railway (API + Worker) | Railway Redis internal URL |
| `OBJECT_STORAGE_DIR` | Railway (API + Worker) | `/data/objects` |
| `WORKFLOWOS_ROLE` | Railway | `api` or `worker` |
| `PORT` | Railway (API) | `3001` |
| `HOST` | Railway | `0.0.0.0` |
| `LOG_LEVEL` | Railway | `info` |
| `CORS_ORIGIN` | Railway (API) | `https://app.yourdomain.com` |
| `WORKFLOWOS_GITHUB_WEBHOOK_SECRET` | Railway (API + Worker) | GitHub webhook secret |
| `BACKEND_URL` | Vercel | `https://api.yourdomain.com` |
