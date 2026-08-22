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
# The image uses Bun as the runtime (the repository's package manager and
# TS runner). `tsx` is included so the existing `start:api` / `start:worker`
# scripts work unchanged. No compilation step is needed — the backend runs
# TypeScript directly via tsx, exactly as it does in development and CI.

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

# Default: run the API role. Override with --role=worker for the worker.
# WORKFLOWOS_ROLE selects the process behaviour (see src/config.ts).
CMD ["bun", "run", "start:api"]
