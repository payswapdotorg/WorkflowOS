import type { FastifyInstance } from 'fastify';

/**
 * Health check route. Returns `{ status: 'ok' }`. Used for deployment probes
 * and as a smoke test in the integration test suite.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return { status: 'ok' };
  });
}
