/**
 * WorkflowOS backend process entrypoint.
 *
 * A single codebase serves two logical roles (selected by WORKFLOWOS_ROLE):
 *
 * - `api`    — Fastify server that accepts HTTP traffic. Enqueues background
 *              jobs and returns immediately (PLAT-AC-03). Does NOT run the
 *              worker host.
 * - `worker` — Runs the {@link WorkerHost} polling the queue. Does NOT serve
 *              HTTP traffic.
 * - `all`    — Runs both in a single process (local dev / integration tests).
 *
 * The shared composition lives in {@link buildApp}; this entrypoint only wires
 * the Fastify server when the role requires it.
 */
import { buildApp } from './app.js';
import { buildServer } from './api/server.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config, { startWorker: config.role !== 'api' });

  let server: Awaited<ReturnType<typeof buildServer>> | undefined;

  if (config.role === 'api' || config.role === 'all') {
    server = await buildServer({
      queue: app.deps.queue,
      logger: app.deps.logger,
    });
    await server.listen({ host: config.host, port: config.port });
    app.deps.logger.info('app.api.listening', {
      host: config.host,
      port: config.port,
      role: config.role,
    });
  }

  await app.start();

  const shutdown = async (signal: string): Promise<void> => {
    app.deps.logger.info('app.shutdown', { signal });
    await app.stop();
    if (server) await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
