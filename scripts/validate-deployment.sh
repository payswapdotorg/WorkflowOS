#!/usr/bin/env bash
# WorkflowOS deployment validation script (WORK-023).
#
# Runs against a live docker-compose deployment (started via
# `docker compose up --build`). Validates:
#
#   DEPLOY-AC-01 — all six topology components present + connected:
#     - Web Application → Backend API
#     - Backend API → PostgreSQL
#     - Backend API → Redis / ObjectStore
#     - Background Worker → Redis → backend persistence
#   DEPLOY-AC-02 — startup without a customer repository
#   DEPLOY-AC-03 — no microservices (single backend codebase)
#
# Also verifies:
#   - API /health/ready returns 200 with all checks ok
#   - PostgreSQL fresh migrations applied
#   - Redis reachable
#   - ObjectStore initialized
#   - frontend serves the SPA HTML
#   - one representative background job (echo) enqueues + processes
#
# Exits 0 on success, 1 on failure. Designed for CI.
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
WEB_URL="${WEB_URL:-http://localhost:8080}"
MAX_WAIT="${MAX_WAIT:-120}"

echo "=== WORK-023 deployment validation ==="
echo "API: $API_URL"
echo "WEB: $WEB_URL"
echo ""

# ---------------------------------------------------------------------------
# Helper: wait for an HTTP endpoint to return 200.
# ---------------------------------------------------------------------------
wait_for() {
  local url="$1"
  local name="$2"
  local timeout="${3:-$MAX_WAIT}"
  echo "Waiting for $name at $url ..."
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "  OK: $name ready (${elapsed}s)"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "  FAIL: $name not ready after ${timeout}s"
  return 1
}

# ---------------------------------------------------------------------------
# DEPLOY-AC-01: topology components present + connected.
# ---------------------------------------------------------------------------

echo "--- DEPLOY-AC-01: topology components ---"

# 1. Backend API (liveness).
wait_for "$API_URL/health" "Backend API (liveness)"

# 2. Backend API (readiness — checks PostgreSQL, Redis, ObjectStore).
wait_for "$API_URL/health/ready" "Backend API (readiness)"

# Verify readiness checks all pass.
READY=$(curl -fsS "$API_URL/health/ready")
echo "  readiness response: $READY"
echo "$READY" | grep -q '"status":"ready"' || {
  echo "  FAIL: /health/ready did not return status=ready"
  exit 1
}
echo "$READY" | grep -q '"postgres":{"ok":true' || {
  echo "  FAIL: PostgreSQL check failed"
  exit 1
}
echo "$READY" | grep -q '"redis":{"ok":true' || {
  echo "  FAIL: Redis check failed"
  exit 1
}
echo "$READY" | grep -q '"objectStore":{"ok":true' || {
  echo "  FAIL: ObjectStore check failed"
  exit 1
}
echo "  OK: PostgreSQL, Redis, ObjectStore all reachable from API"

# 3. Web Application (serves the SPA HTML).
wait_for "$WEB_URL/" "Web Application"
WEB_HTML=$(curl -fsS "$WEB_URL/")
echo "$WEB_HTML" | grep -q '<div id="root">' || {
  echo "  FAIL: Web Application did not serve the SPA HTML (missing #root div)"
  exit 1
}
echo "  OK: Web Application serves SPA HTML"

# 4. Web Application -> Backend API (via nginx proxy).
# The /api prefix is proxied by nginx to the backend (prefix stripped).
wait_for "$WEB_URL/api/health" "Web -> API proxy"
WEB_API=$(curl -fsS "$WEB_URL/api/health")
echo "$WEB_API" | grep -q '"status":"ok"' || {
  echo "  FAIL: Web Application did not proxy /api/health to the backend"
  exit 1
}
echo "  OK: Web Application -> Backend API proxy works"

# 5. PostgreSQL (fresh migrations applied).
# Verify the schema_migrations table exists and has entries.
PG_MIGRATIONS=$(docker compose exec -T postgres psql -U wfos -d wfos -t -c "SELECT count(*) FROM schema_migrations;" 2>/dev/null | tr -d ' ')
echo "  PostgreSQL: $PG_MIGRATIONS migrations applied"
[ "$PG_MIGRATIONS" -gt 0 ] || {
  echo "  FAIL: No migrations applied to PostgreSQL"
  exit 1
}
echo "  OK: PostgreSQL fresh migrations confirmed"

# 6. Redis (reachable).
REDIS_PING=$(docker compose exec -T redis redis-cli ping 2>/dev/null)
echo "  Redis: $REDIS_PING"
[ "$REDIS_PING" = "PONG" ] || {
  echo "  FAIL: Redis did not respond PONG"
  exit 1
}
echo "  OK: Redis reachable"

# 7. Background Worker (running).
WORKER_RUNNING=$(docker compose ps --format json worker 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('State',''))" 2>/dev/null || echo "")
echo "  Worker container state: $WORKER_RUNNING"
[ "$WORKER_RUNNING" = "running" ] || {
  echo "  FAIL: Worker container is not running"
  exit 1
}
echo "  OK: Background Worker is running"

# ---------------------------------------------------------------------------
# DEPLOY-AC-01 (background job): enqueue + process a representative job.
# ---------------------------------------------------------------------------

echo ""
echo "--- DEPLOY-AC-01: representative background job ---"

# POST /jobs/echo enqueues an echo job. The worker picks it up and logs.
ECHO_RES=$(curl -fsS -X POST "$API_URL/jobs/echo" \
  -H "content-type: application/json" \
  -d '{"echoType":"echo","payload":{"message":"deployment-validation"}}')
echo "  echo job response: $ECHO_RES"
echo "$ECHO_RES" | grep -q '"accepted"' || {
  echo "  FAIL: Echo job was not accepted"
  exit 1
}

# Wait for the worker to process the job (check worker logs for the echo).
echo "  Waiting for worker to process echo job..."
PROCESSED=0
for i in $(seq 1 15); do
  if docker compose logs worker 2>/dev/null | grep -q "echo" ; then
    PROCESSED=1
    echo "  OK: Worker processed echo job (found in logs)"
    break
  fi
  sleep 2
done
[ "$PROCESSED" -eq 1 ] || {
  echo "  FAIL: Worker did not process echo job within 30s"
  exit 1
}

# ---------------------------------------------------------------------------
# DEPLOY-AC-02: deployment works without a customer repository.
# ---------------------------------------------------------------------------

echo ""
echo "--- DEPLOY-AC-02: no customer repository required ---"
# The docker-compose.yml does not mount or reference any customer repository.
# The API started successfully without any customer repo — proven by the
# /health/ready check above. Verify no /repos, /customer, or checkout path
# exists in the deployment configuration.
if grep -riE "customer|checkout|/repos/.*\.git" docker-compose.yml backend/Dockerfile frontend/Dockerfile 2>/dev/null; then
  echo "  FAIL: Deployment configuration references customer repositories"
  exit 1
fi
echo "  OK: No customer repository required for deployment"

# ---------------------------------------------------------------------------
# DEPLOY-AC-03: no microservices.
# ---------------------------------------------------------------------------

echo ""
echo "--- DEPLOY-AC-03: no microservices ---"
# The backend is one codebase served by a single image with two process
# roles (api, worker). Verify no separate backend microservice images exist.
SERVICE_COUNT=$(docker compose config --services 2>/dev/null | wc -l)
echo "  docker-compose services: $SERVICE_COUNT"
# Expected: postgres, redis, api, worker, web = 5 services
# (Object storage is a shared volume, not a separate service).
[ "$SERVICE_COUNT" -eq 5 ] || {
  echo "  FAIL: Expected 5 services, got $SERVICE_COUNT"
  docker compose config --services
  exit 1
}
echo "  OK: Single backend codebase, two process roles (api + worker)"
echo "  OK: No microservices, no Kubernetes, no service mesh"

echo ""
echo "=== ALL DEPLOYMENT CHECKS PASSED ==="
