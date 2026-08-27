/**
 * WORK-044: Execution-routing routes — the HTTP surface for the adaptive
 * execution router's two DISTINCT caller intents:
 *
 *   GET  /work-items/:workItemId/execution/routing/recommendation
 *        → RECOMMENDATION mode: the inspectable ranking + explanation
 *          (advisory; no selection commitment; no workflow mutation).
 *   POST /work-items/:workItemId/execution/routing/selection
 *        → AUTOMATIC-SELECTION mode: the SELECTED eligible candidate +
 *          why it won + the alternatives it beat (advisory: the caller
 *          dispatches via the existing execution submit authority).
 *
 * All routes are backend-authorized. The frontend is a consumer, never an
 * authority. Routes NEVER accept `actor`/`userId`/`organizationId` from the
 * request — the user is derived server-side from the authenticated
 * `requireProjectAuthorization` context, and the organization scope is
 * resolved SERVER-SIDE by the router from the authoritative project →
 * organization relation (the AR-043-04 lesson).
 *
 * Neither endpoint mutates authoritative workflow state. SECURITY: no route
 * ever returns credentials, callback tokens, handoff tokens, or cookies.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { ArchitectureVersionRepository, ArchitectureRepository } from '@modules/architecture/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  AdaptiveExecutionRouterService,
  ExecutionRoutingErrorCode,
} from '../../execution-routing/index.js';
import { ExecutionRoutingError } from '../../execution-routing/index.js';
import type { BenchmarkMode } from '../../execution-policy/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

export interface ExecutionRoutingRouteDeps {
  authorizationService: AuthorizationService;
  executionRouterService: AdaptiveExecutionRouterService;
  /** Resolve WorkItem → project for the work-item-scoped routes. */
  workItemRepository: WorkItemRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  architectureRepository: ArchitectureRepository;
  projectRepository: ProjectRepository;
}

const VALID_BENCHMARK_MODES: readonly BenchmarkMode[] = [
  'maximum_capability',
  'controlled_comparison',
  'cost_constrained',
  'latency_constrained',
  'subscription_constrained',
  'privacy_constrained',
];

export async function executionRoutingRoutes(app: FastifyInstance, deps: ExecutionRoutingRouteDeps): Promise<void> {
  const { executionRouterService } = deps;

  // --- W044-AC08: RECOMMENDATION mode (read-only, inspectable) -----------

  app.get('/work-items/:workItemId/execution/routing/recommendation', async (req, reply) => {
    return runAuthed(req, async () => {
      const workItemId = (req.params as { workItemId?: string } | null)?.workItemId ?? '';
      const ctx = await resolveProjectForWorkItem(deps, workItemId);
      if (!ctx) return reply.code(404).send({ error: 'not-found', reason: 'work-item-or-chain-missing' });
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId: ctx.projectId });
      if (!user) return;
      const benchmarkMode = parseBenchmarkMode(req.query, reply);
      if (benchmarkMode === 'invalid') return;
      try {
        const result = await executionRouterService.recommendExecution({
          projectId: ctx.projectId,
          workItemId,
          userId: user.id,
          benchmarkMode,
        });
        return { routing: result };
      } catch (err) {
        return sendRoutingError(reply, err, 'execution-routing-recommend-failed');
      }
    });
  });

  // --- W044-AC08: AUTOMATIC-SELECTION mode (explicit intent; still advisory) ---

  app.post('/work-items/:workItemId/execution/routing/selection', async (req, reply) => {
    return runAuthed(req, async () => {
      const workItemId = (req.params as { workItemId?: string } | null)?.workItemId ?? '';
      const ctx = await resolveProjectForWorkItem(deps, workItemId);
      if (!ctx) return reply.code(404).send({ error: 'not-found', reason: 'work-item-or-chain-missing' });
      // project.read: the selection computes the choice but mutates NOTHING
      // (the caller dispatches via the existing execution submit authority,
      // which carries its own authorization).
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId: ctx.projectId });
      if (!user) return;
      const benchmarkMode = parseBenchmarkMode(req.body, reply);
      if (benchmarkMode === 'invalid') return;
      try {
        const result = await executionRouterService.selectExecution({
          projectId: ctx.projectId,
          workItemId,
          userId: user.id,
          benchmarkMode,
        });
        return { routing: result };
      } catch (err) {
        return sendRoutingError(reply, err, 'execution-routing-select-failed');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface WorkItemContext { projectId: string; }

async function resolveProjectForWorkItem(
  deps: ExecutionRoutingRouteDeps,
  workItemId: string,
): Promise<WorkItemContext | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  if (!arch?.projectId) return null;
  return { projectId: arch.projectId };
}

/**
 * Parse + VALIDATE the optional benchmark mode override (the WORK-043
 * contract accepts only the six §8 modes; an unknown value is a client
 * error, never a silent pass-through).
 */
function parseBenchmarkMode(
  source: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): BenchmarkMode | undefined | 'invalid' {
  const raw = (source as { benchmarkMode?: string } | null)?.benchmarkMode;
  if (raw == null || raw === '') return undefined;
  const mode = raw as BenchmarkMode;
  if (!VALID_BENCHMARK_MODES.includes(mode)) {
    reply.code(400).send({
      error: 'invalid-benchmark-mode',
      message: `Unknown benchmark mode '${raw}' — the WORK-043 contract accepts: ${VALID_BENCHMARK_MODES.join(', ')}`,
    });
    return 'invalid';
  }
  return mode;
}

/** The typed router/policy error → HTTP mapping (fail-closed everywhere). */
function sendRoutingError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown, fallback: string): unknown {
  const e = err as ExecutionRoutingError;
  const msg = (err as Error).message;
  if (e?.name === 'ExecutionRoutingError') {
    const code: ExecutionRoutingErrorCode = e.code;
    if (code === 'execution-routing-organization-unresolved') {
      return reply.code(404).send({ error: code, message: msg });
    }
    // Inconsistent/invalid ranking input — a deterministic typed failure.
    return reply.code(422).send({ error: code, message: msg });
  }
  // Pass through the WORK-043 policy-service errors with their established
  // status mapping (the router consumed recommend(); its conflicts surface).
  if (msg.includes('execution-policy-invalid-mode-constraint')) {
    return reply.code(400).send({ error: 'invalid-mode-constraint', message: msg });
  }
  if (msg.includes('execution-policy-frozen-mode')) {
    return reply.code(409).send({ error: 'policy-frozen-mode', message: msg });
  }
  if (msg.includes('execution-policy-snapshot-stale')) {
    return reply.code(409).send({ error: 'policy-snapshot-stale', message: msg });
  }
  return reply.code(500).send({ error: fallback, message: msg });
}
