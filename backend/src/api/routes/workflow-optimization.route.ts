/**
 * V2-017 T11 — the workflow-optimization TRANSPORT routes.
 *
 * Transport ONLY (the T9 route family pattern): every optimization
 * decision — analysis, opportunity detection, proposal provenance, the
 * unsafe guard, the owner approval gate, the candidate derivation, the
 * deterministic comparison — stays V2-011's frozen
 * `DefaultWorkflowOptimizationService`. The consumer §19/§20 surface
 * composes the authority over HTTP (V2-017 rule 9).
 *
 * DOCUMENT RESOLUTION IS SERVER-SIDE (the T9 resolvePin precedent): the
 * client passes identifiers only; the route reads the version through the
 * authoritative V2-002 `getVersion` and parses it through V2-003 — the
 * client never supplies documents.
 *
 * THE MATERIALIZER PORT: V2-011 creates candidate versions only through
 * `CandidateVersionMaterializer`, satisfied in composition by the REAL
 * V2-002 `createVersion` (the integration-test recipe). The adapter must
 * run as the AUTHENTICATED owner (createVersion is owner-only), so this
 * route file owns the service composition with a REQUEST-LOCAL principal
 * channel: the authenticated owner rides the request's own async context
 * (`node:async_hooks` AsyncLocalStorage — the same mechanism the platform
 * execution-context uses), NEVER a shared mutable variable, so a concurrent
 * request can never overwrite another request's principal (the PR #203
 * architect gate). The created candidate version merely EXISTS — nothing is
 * activated, installed or deployed (the §20 rule).
 *
 * The in-memory proposal store is transport state (the V2-011 reference
 * store; durable proposal persistence is a separately-owned concern).
 */
import type { FastifyInstance } from 'fastify';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DefaultWorkflowOptimizationService,
  InMemoryOptimizationProposalStore,
  WorkflowOptimizationError,
  type WorkflowOptimizationErrorCode,
  type WorkflowOptimizationService,
} from '../../workflow-optimization/index.js';
import type { WorkflowRepositoryService } from '../../workflow-repository/index.js';
import type { WorkflowIrDocument } from '../../workflow-ir/index.js';
import { parseWorkflowIrDocument } from '../../workflow-ir/index.js';
import { requireUser, runAuthed } from '../plugins/auth.plugin.js';

export interface WorkflowOptimizationRouteDeps {
  /** The V2-002 repository: the authoritative version reads + the materializer's createVersion. */
  workflowRepositoryService: WorkflowRepositoryService;
  /** Optional deterministic identity source for tests (default: crypto.randomUUID). */
  idFactory?: () => string;
  /** Optional deterministic clock for tests (default: Date.now). */
  clock?: () => number;
}

/** Typed error code → HTTP status (never parse message strings). */
const ERROR_STATUS: Record<WorkflowOptimizationErrorCode, number> = {
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_ALREADY_DECIDED: 409,
  PROPOSAL_ALREADY_MATERIALIZED: 409,
  APPROVAL_REQUIRED: 409,
  PROPOSAL_NOT_APPROVED: 409,
  OWNER_MISMATCH: 403,
  OPPORTUNITY_NOT_FOUND: 400,
  UNSAFE_OPTIMIZATION: 409,
  REUSE_TARGET_REQUIRED: 400,
  REUSE_TARGET_INVALID: 400,
  IR_DOCUMENT_INVALID: 400,
  MATERIALIZER_FAILED: 502,
  OPTIMIZATION_INPUT_INVALID: 400,
};

/** Typed error code → the stable wire identifier (kebab-case). */
function errorIdentifier(code: WorkflowOptimizationErrorCode): string {
  return `workflow-optimization-${code.toLowerCase().replace(/_/g, '-')}`;
}

/** A structurally-typed reply (the workflow-runs route precedent). */
type ReplyLike = { code: (n: number) => { send: (b: unknown) => void } };

function sendError(reply: ReplyLike, err: unknown): void {
  if (err instanceof WorkflowOptimizationError) {
    reply.code(ERROR_STATUS[err.code]).send({
      error: errorIdentifier(err.code),
      code: err.code,
      message: err.message,
    });
    return;
  }
  reply.code(500).send({ error: 'workflow-optimization-internal', message: String(err) });
}

function invalidRequest(reply: ReplyLike, message: string): void {
  reply.code(400).send({
    error: 'workflow-optimization-optimization-input-invalid',
    code: 'OPTIMIZATION_INPUT_INVALID',
    message,
  });
}

/** The honest unresolvable-version reply (never an empty success). */
function versionUnresolvable(): { ok: false; status: number; body: unknown } {
  return {
    ok: false,
    status: 404,
    body: {
      error: 'workflow-optimization-version-not-found',
      code: 'OPTIMIZATION_INPUT_INVALID',
      message: 'the workflow version to analyze or compare was not found',
    },
  };
}

/**
 * The honest unresolvable-workflow reply (the V2-002 convention: denied
 * reads are typed 404s — no existence leak; never an empty success).
 */
function workflowUnresolvable(): { ok: false; status: number; body: unknown } {
  return {
    ok: false,
    status: 404,
    body: {
      error: 'workflow-optimization-workflow-not-found',
      code: 'OPTIMIZATION_INPUT_INVALID',
      message: 'the workflow whose proposals were requested was not found',
    },
  };
}

/**
 * The canonical V2-002 workflow authorization gate (the architect finding
 * V2-017-T11-F01): `getWorkflow` is the repository's visibility-checked
 * read — THE visibility/ownership authority. The transport route composes
 * that authority over HTTP; it never re-implements (and never invents a
 * second) authorization rule. Any denial (unknown, not visible, not a
 * member) fails closed as the SAME typed 404 — no existence leak.
 */
async function authorizeWorkflowRead(
  repository: WorkflowRepositoryService,
  userId: string,
  workflowId: string,
): Promise<{ ok: false; status: number; body: unknown } | { ok: true }> {
  try {
    await repository.getWorkflow({ userId }, workflowId);
  } catch {
    return workflowUnresolvable();
  }
  return { ok: true };
}

/**
 * The server-side document resolution (the T9 resolvePin precedent): the
 * authoritative V2-002 visibility-checked version read + the V2-003 parse.
 */
async function resolveDocument(
  repository: WorkflowRepositoryService,
  userId: string,
  workflowId: string,
  versionId: string,
): Promise<{ ok: false; status: number; body: unknown } | { ok: true; document: WorkflowIrDocument }> {
  let versionContent: unknown;
  try {
    const version = await repository.getVersion({ userId }, workflowId, versionId);
    versionContent = version.content;
  } catch {
    return versionUnresolvable();
  }
  const parsed = parseWorkflowIrDocument(JSON.stringify(versionContent));
  if (!parsed.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'workflow-optimization-ir-document-invalid',
        code: 'IR_DOCUMENT_INVALID',
        message: 'the version content is not a parseable WorkflowIR document',
      },
    };
  }
  return { ok: true, document: parsed.document };
}

/**
 * The wire projection of an analysis: the deterministic identity,
 * opportunities and typed rejections. The deep-frozen embedded DOCUMENT
 * (the derivation input, provenance evidence) is not carried — the route
 * resolved it server-side and the client already holds the version
 * content. A projection, never a re-definition.
 */
function serializeAnalysis(analysis: {
  analysisId: string;
  rulesVersion: string;
  opportunities: readonly unknown[];
  rejected: readonly unknown[];
}): Record<string, unknown> {
  return {
    analysisId: analysis.analysisId,
    rulesVersion: analysis.rulesVersion,
    opportunities: analysis.opportunities,
    rejected: analysis.rejected,
  };
}

/**
 * The wire projection of a proposal: the full lifecycle state, provenance,
 * rationale and comparison. The deep-frozen baseline/candidate DOCUMENTS
 * are not carried (provenance evidence; the materialized version content
 * arrives through the authoritative V2-002 version reads).
 */
function serializeProposal(proposal: Record<string, unknown>): Record<string, unknown> {
  const { baselineDocument: _baseline, candidateDocument: _candidate, ...rest } = proposal;
  return rest;
}

export async function workflowOptimizationRoutes(
  app: FastifyInstance,
  deps: WorkflowOptimizationRouteDeps,
): Promise<void> {
  const repository = deps.workflowRepositoryService;

  // The REQUEST-LOCAL principal channel for the materializer port: the
  // adapter runs V2-002 createVersion as the AUTHENTICATED owner. The
  // principal rides the REQUEST'S OWN async context — established by
  // materializePrincipalContext.run() around each materialization — so it
  // is request-local by construction and a concurrent request can never
  // overwrite it (no shared mutable state; the PR #203 architect gate).
  const materializePrincipalContext = new AsyncLocalStorage<{ userId: string }>();
  const service: WorkflowOptimizationService = new DefaultWorkflowOptimizationService({
    idFactory: deps.idFactory ?? (() => `opt_${crypto.randomUUID()}`),
    clock: deps.clock ?? (() => Date.now()),
    store: new InMemoryOptimizationProposalStore(),
    materializer: {
      createCandidateVersion: async (input) => {
        const principal = materializePrincipalContext.getStore();
        if (principal === undefined) {
          throw new Error(
            'workflow-optimization: materializer invoked outside the authenticated request context that owns the proposal',
          );
        }
        const result = await repository.createVersion(principal, input.workflowId, {
          content: input.content,
          protocol: { irSchemaVersion: input.protocol.irSchemaVersion },
          parentVersionId: input.parentVersionId,
        });
        return { versionId: result.version.id };
      },
    },
  });

  // --- analysis (the §20 "found N improvements" telemetry) ------------------

  app.post('/workflow-optimization/analyze', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.workflowId !== 'string' ||
        typeof body.versionId !== 'string' ||
        body.workflowId.length === 0 ||
        body.versionId.length === 0
      ) {
        invalidRequest(reply, 'workflowId and versionId are required');
        return reply;
      }
      const resolved = await resolveDocument(repository, user.id, body.workflowId, body.versionId);
      if (!resolved.ok) {
        reply.code(resolved.status).send(resolved.body);
        return reply;
      }
      try {
        const analysis = service.analyzeWorkflow(resolved.document);
        return reply.code(200).send({ analysis: serializeAnalysis(analysis) });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  // --- the proposal lifecycle (§20: recommendation → approval → new version)

  app.post('/workflow-optimization/proposals', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.workflowId !== 'string' ||
        typeof body.versionId !== 'string' ||
        typeof body.opportunityNodeId !== 'string' ||
        body.workflowId.length === 0 ||
        body.versionId.length === 0 ||
        body.opportunityNodeId.length === 0
      ) {
        invalidRequest(reply, 'workflowId, versionId and opportunityNodeId are required');
        return reply;
      }
      if (body.reuseTarget !== undefined && body.reuseTarget !== null) {
        const target = body.reuseTarget as Record<string, unknown>;
        if (typeof target.workflowId !== 'string' || typeof target.versionRef !== 'string') {
          invalidRequest(reply, 'reuseTarget requires workflowId and versionRef');
          return reply;
        }
      }
      const resolved = await resolveDocument(repository, user.id, body.workflowId, body.versionId);
      if (!resolved.ok) {
        reply.code(resolved.status).send(resolved.body);
        return reply;
      }
      try {
        const proposal = service.createProposal({
          ownerId: user.id,
          workflowId: body.workflowId,
          versionId: body.versionId,
          document: resolved.document,
          opportunityNodeId: body.opportunityNodeId,
          reuseTarget: (body.reuseTarget ?? null) as never,
        });
        return reply.code(201).send({ proposal: serializeProposal(proposal as never) });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  app.get('/workflow-optimization/proposals', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const query = req.query as { workflowId?: string };
      // The proposal listing is a WORKFLOW-scoped read (the §20 converge
      // read). The workflowId scope is REQUIRED — an unscoped listing would
      // enumerate proposal state across workflows with nothing to authorize
      // against — and the workflow itself must pass the canonical V2-002
      // visibility/ownership gate BEFORE the proposal store is read (the
      // architect finding V2-017-T11-F01; no second authorization authority).
      if (typeof query.workflowId !== 'string' || query.workflowId.length === 0) {
        invalidRequest(reply, 'workflowId is required');
        return reply;
      }
      const gate = await authorizeWorkflowRead(repository, user.id, query.workflowId);
      if (!gate.ok) {
        reply.code(gate.status).send(gate.body);
        return reply;
      }
      try {
        const proposals = service.listProposals({ workflowId: query.workflowId });
        return reply.code(200).send({
          proposals: proposals.map((p) => serializeProposal(p as never)),
        });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });

  const proposalAction = (action: 'approve' | 'reject') => {
    return async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      return runAuthed(req, async () => {
        const user = await requireUser(req, reply);
        const { proposalId } = req.params as { proposalId: string };
        const body = req.body as Record<string, unknown> | null;
        try {
          const proposal =
            action === 'approve'
              ? service.approveProposal({ proposalId, ownerId: user.id })
              : service.rejectProposal({
                  proposalId,
                  ownerId: user.id,
                  note: typeof body?.note === 'string' ? body.note : undefined,
                });
          return reply.code(200).send({ proposal: serializeProposal(proposal as never) });
        } catch (err) {
          sendError(reply, err);
          return reply;
        }
      });
    };
  };

  app.post('/workflow-optimization/proposals/:proposalId/approve', proposalAction('approve'));
  app.post('/workflow-optimization/proposals/:proposalId/reject', proposalAction('reject'));

  // --- materialization (the ONLY version-creation path; never an activation)

  app.post('/workflow-optimization/proposals/:proposalId/materialize', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { proposalId } = req.params as { proposalId: string };
      // REQUEST-LOCAL principal: this request's async context carries the
      // authenticated owner through the whole materialization chain (across
      // every await inside V2-011's materializeProposal and V2-002's
      // createVersion). A concurrent request's context is separate by
      // construction — the principal cannot be overwritten.
      return materializePrincipalContext.run({ userId: user.id }, async () => {
        try {
          const result = await service.materializeProposal({ proposalId, ownerId: user.id });
          return reply.code(200).send({
            proposal: serializeProposal(result.proposal as never),
            materialization: result.materialization,
          });
        } catch (err) {
          sendError(reply, err);
          return reply;
        }
      });
    });
  });

  // --- the deterministic comparison (§19 "What changed") ---------------------

  app.post('/workflow-optimization/compare', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.workflowId !== 'string' ||
        typeof body.baselineVersionId !== 'string' ||
        typeof body.candidateVersionId !== 'string' ||
        body.workflowId.length === 0 ||
        body.baselineVersionId.length === 0 ||
        body.candidateVersionId.length === 0
      ) {
        invalidRequest(reply, 'workflowId, baselineVersionId and candidateVersionId are required');
        return reply;
      }
      const baseline = await resolveDocument(
        repository,
        user.id,
        body.workflowId,
        body.baselineVersionId,
      );
      if (!baseline.ok) {
        reply.code(baseline.status).send(baseline.body);
        return reply;
      }
      const candidate = await resolveDocument(
        repository,
        user.id,
        body.workflowId,
        body.candidateVersionId,
      );
      if (!candidate.ok) {
        reply.code(candidate.status).send(candidate.body);
        return reply;
      }
      try {
        const comparison = service.compareVersions(baseline.document, candidate.document);
        return reply.code(200).send({ comparison });
      } catch (err) {
        sendError(reply, err);
        return reply;
      }
    });
  });
}
