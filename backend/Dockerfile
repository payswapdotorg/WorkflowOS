# WorkflowOS backend Docker image (WORK-023).
#
# A single image serves both logical process roles:
#
#   - api    — Fastify HTTP server (WORKFLOWOS_ROLE=api)
#   - worker — WorkerHost polling the Redis-backed queue (WORKFLOWOS_ROLE=worker)
#
# Both roles share the same codebase, the same TypeScript sources, the same
# migrations, and the same module boundaries. The modular monolith is NOT
# split into separate services — only the process entrypoint differs.
#
# The image uses Bun as the runtime (the repository's package manager).
# Bun natively runs TypeScript, so we use `bun src/index.ts` directly instead
# of `tsx src/index.ts` (tsx has a CJS resolution issue inside the Docker
# container: `Cannot find module './cjs/index.cjs'`). The existing `start:api`
# / `start:worker` scripts (which use tsx) remain available for local dev and
# CI test runs — only the Docker entrypoint uses `bun` directly.

FROM oven/bun:1.3.14

WORKDIR /app

# Install dependencies first (layer cache: only re-runs when lockfile changes).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the rest of the backend source (including SQL migrations — the
# migration runner reads them from disk at startup).
COPY . .

# The API listens on PORT (default 3001). The worker does not listen on HTTP.
ENV PORT=3001
EXPOSE 3001

# Default: run the API role. The role is selected by WORKFLOWOS_ROLE env var
# (set in docker-compose.yml). `bun` runs the TypeScript directly — no tsx
# needed in the container.
CMD ["bun", "src/index.ts"]
