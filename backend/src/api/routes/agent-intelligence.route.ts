/**
 * WORK-047: Agent-intelligence routes — the bounded READ-ONLY HTTP surface
 * for the advisory intelligence layer:
 *
 *   GET /projects/:projectId/work-items/:workItemId/agent-intelligence/execution
 *        → the advisory execution recommendation: the intelligence
 *          re-ranking of the routing result's eligible set + the ordered
 *          fallback strategy + full provenance (no mutation, ever).
 *   GET /projects/:projectId/work-items/:workItemId/agent-intelligence/delegation
 *        → the advisory delegation decomposition: the WORK-046-shaped unit
 *          structure the caller submits through the EXISTING delegation
 *          plan boundary (intelligence never creates a plan).
 *
 * All routes are backend-authorized within the caller's project context
 * (project.read — the recommendation computes but mutates NOTHING; the
 * caller dispatches through the existing execution authority, which carries
 * its own authorization). The Work Item must belong to the project
 * (server-side resolution through the authoritative chain — caller-
 * controlled scope is impossible by construction, mirroring the
 * delegation/routing routes).
 *
 * SECURITY: no route returns credentials, tokens, or packages. The optional
 * benchmarkMode override is VALIDATED against the WORK-043 contract (an
 * unknown mode is a client error, never a silent pass-through — mirroring
 * the execution-routing route).
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { AgentIntelligenceService } from '../../agent-intelligence/index.js';
import { AgentIntelligenceError } from '../../agent-intelligence/index.js';
import type { BenchmarkMode } from '../../execution-policy/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

export interface AgentIntelligenceRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  workItemRepository: WorkItemRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  /** WORK-047: the advisory agent-intelligence service. */
  agentIntelligenceService: AgentIntelligenceService;
}

const VALID_BENCHMARK_MODES: readonly BenchmarkMode[] = [
  'maximum_capability',
  'controlled_comparison',
  'cost_constrained',
  'latency_constrained',
  'subscription_constrained',
  'privacy_constrained',
];

/** Map the typed AgentIntelligenceError code to an HTTP status (never parse strings). */
const ERROR_STATUS: Record<string, number> = {
  'agent-intelligence-ineligible-candidate': 422,
  'agent-intelligence-unknown-role': 422,
  'agent-intelligence-invalid-signal': 422,
  'agent-intelligence-routing-input-invalid': 422,
};

export async function agentIntelligenceRoutes(app: FastifyInstance, deps: AgentIntelligenceRouteDeps): Promise<void> {
  /** Resolve the Work Item's project (server-side — callers cannot spoof scope). */
  const resolveProjectForWorkItem = async (
    workItemId: string,
  ): Promise<string | null> => {
    const wi = await deps.workItemRepository.findById(workItemId);
    if (!wi) return null;
    const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
    if (!version) return null;
    const arch = await deps.architectureRepository.findById(version.architectureId);
    return arch?.projectId ?? null;
  };

  const handle = (
    reply: { code: (n: number) => { send: (b: unknown) => void } },
    err: unknown,
  ): void => {
    if (err instanceof AgentIntelligenceError) {
      const status = ERROR_STATUS[err.code] ?? 422;
      reply.code(status).send({ error: err.code.replace(/^agent-intelligence-/, 'agent-intelligence-'), message: err.message });
      return;
    }
    // Pass through the consumed WORK-043/WORK-044 error vocabulary with the
    // established status mapping (the router consumed recommend(); its
    // conflicts surface — mirroring the execution-routing route).
    const msg = (err as Error).message;
    if (msg.includes('execution-policy-invalid-mode-constraint')) {
      reply.code(400).send({ error: 'invalid-mode-constraint', message: msg });
      return;
    }
    if (msg.includes('execution-policy-frozen-mode')) {
      reply.code(409).send({ error: 'policy-frozen-mode', message: msg });
      return;
    }
    if (msg.includes('execution-policy-snapshot-stale')) {
      reply.code(409).send({ error: 'policy-snapshot-stale', message: msg });
      return;
    }
    reply.code(500).send({ error: 'agent-intelligence-internal-error', message: msg });
  };

  // --- the advisory execution recommendation (read-only) ---------------------

  app.get('/projects/:projectId/work-items/:workItemId/agent-intelligence/execution', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, workItemId } = req.params as { projectId: string; workItemId: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;

      const actualProjectId = await resolveProjectForWorkItem(workItemId);
      if (!actualProjectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      if (actualProjectId !== projectId) {
        return reply.code(403).send({ error: 'work-item-not-in-project' });
      }

      const benchmarkMode = parseBenchmarkMode(req.query, reply);
      if (benchmarkMode === 'invalid') return;

      try {
        const result = await deps.agentIntelligenceService.recommendExecution({
          projectId,
          workItemId,
          userId: user.id,
          benchmarkMode,
        });
        return { intelligence: serializeExecutionRecommendation(result) };
      } catch (err) {
        return handle(reply, err);
      }
    });
  });

  // --- the advisory delegation decomposition (read-only) ----------------------

  app.get('/projects/:projectId/work-items/:workItemId/agent-intelligence/delegation', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, workItemId } = req.params as { projectId: string; workItemId: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;

      const actualProjectId = await resolveProjectForWorkItem(workItemId);
      if (!actualProjectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      if (actualProjectId !== projectId) {
        return reply.code(403).send({ error: 'work-item-not-in-project' });
      }

      const benchmarkMode = parseBenchmarkMode(req.query, reply);
      if (benchmarkMode === 'invalid') return;

      try {
        const result = await deps.agentIntelligenceService.recommendDelegation({
          projectId,
          workItemId,
          userId: user.id,
          benchmarkMode,
        });
        return { intelligence: serializeDelegationRecommendation(result) };
      } catch (err) {
        return handle(reply, err);
      }
    });
  });
}

/** Parse + VALIDATE the optional benchmark mode override (the WORK-043 contract). */
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

// ---------------------------------------------------------------------------
// serialization (dates ISO; the wire shape mirrors the contract)
// ---------------------------------------------------------------------------

type Rec<T> = T extends Date ? string : T extends (infer U)[] ? Rec<U>[] : T extends object ? { [K in keyof T]: Rec<T[K]> } : T;

function iso(d: Date): string {
  return d.toISOString();
}

function serializeContribution(c: import('../../agent-intelligence/index.js').EvidenceContribution): Record<string, unknown> {
  return {
    cell: c.cell,
    kind: c.kind,
    attempts: c.attempts,
    succeeded: c.succeeded,
    successRate: c.successRate,
    firstObservedAt: iso(c.firstObservedAt),
    lastObservedAt: iso(c.lastObservedAt),
  };
}

function serializeRanked(r: import('../../agent-intelligence/index.js').IntelligenceRankedCandidate): Record<string, unknown> {
  return {
    identity: r.identity,
    score: r.score,
    components: r.components,
    historicalSignal: {
      ...r.historicalSignal,
      lastObservedAt: r.historicalSignal.lastObservedAt ? iso(r.historicalSignal.lastObservedAt) : null,
    },
    eligibility: r.eligibility,
    routingRank: r.routingRank,
  };
}

function serializeExecutionRecommendation(
  r: import('../../agent-intelligence/index.js').IntelligenceExecutionRecommendation,
): Record<string, unknown> {
  return {
    mode: r.mode,
    projectId: r.projectId,
    workItemId: r.workItemId,
    recommended: r.recommended ? serializeRanked(r.recommended) : null,
    ranked: r.ranked.map(serializeRanked),
    fallbacks: r.fallbacks.map(serializeRanked),
    rejectedAlternatives: r.rejectedAlternatives,
    provenance: {
      ...r.provenance,
      contributingEvidence: r.provenance.contributingEvidence.map(serializeContribution),
    },
    evidence: {
      ...r.evidence,
      executionCells: r.evidence.executionCells.map((c) => ({
        ...c,
        firstObservedAt: iso(c.firstObservedAt),
        lastObservedAt: iso(c.lastObservedAt),
      })),
      roleCells: r.evidence.roleCells.map((c) => ({
        ...c,
        firstObservedAt: iso(c.firstObservedAt),
        lastObservedAt: iso(c.lastObservedAt),
      })),
    },
    warnings: r.warnings,
  };
}

function serializeDelegationRecommendation(
  r: import('../../agent-intelligence/index.js').IntelligenceDelegationRecommendation,
): Record<string, unknown> {
  return {
    mode: r.mode,
    projectId: r.projectId,
    workItemId: r.workItemId,
    planKey: r.planKey,
    units: r.units.map((u) => ({
      ...u,
      roleHistory: u.roleHistory ? serializeContribution(u.roleHistory) : null,
    })),
    rejectedRoles: r.rejectedRoles,
    execution: serializeExecutionRecommendation(r.execution),
    evidence: {
      ...r.evidence,
      executionCells: r.evidence.executionCells.map((c) => ({
        ...c,
        firstObservedAt: iso(c.firstObservedAt),
        lastObservedAt: iso(c.lastObservedAt),
      })),
      roleCells: r.evidence.roleCells.map((c) => ({
        ...c,
        firstObservedAt: iso(c.firstObservedAt),
        lastObservedAt: iso(c.lastObservedAt),
      })),
    },
    warnings: r.warnings,
    submissionPath: r.submissionPath,
  };
}

// Keep the recursive type helper referenced (documents the wire contract).
export type { Rec };
