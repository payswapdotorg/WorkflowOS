/**
 * WORK-033: Execution-policy routes — the HTTP surface for the policy layer.
 *
 * All routes are backend-authorized. The frontend is a consumer, never an
 * authority (§34). Routes NEVER accept `actor`/`userId`/`createdBy` from the
 * request body — they are derived server-side from the authenticated
 * `requireProjectAuthorization` user (§27, PR #35 fix #5 pattern).
 *
 * Routes:
 *   GET   /work-items/:workItemId/execution/recommendation          — §16 recommendation
 *   GET   /work-items/:workItemId/execution/decisions               — §22 audit
 *   GET   /work-items/:workItemId/execution/controlled-comparison   — §10 dimensions
 *   GET   /projects/:projectId/execution-policy                    — §31 get policy
 *   POST  /projects/:projectId/execution-policy                     — ensure default
 *   PATCH /projects/:projectId/execution-policy                     — update (§9 frozen-reject)
 *   POST  /projects/:projectId/execution-policy/freeze              — §9 EXPLICIT early freeze
 *   GET   /projects/:projectId/execution-preferences                — §12 user prefs
 *   PATCH /projects/:projectId/execution-preferences                — update prefs
 *   GET   /projects/:projectId/provider-access-profiles            — §5 list
 *   POST  /projects/:projectId/provider-access-profiles            — §5 upsert
 *
 * §9 NOTE (PR #37 review fix): the §9 invariant — a policy is immutable
 * once any benchmark experiment in its project is RUNNING — is enforced
 * AUTOMATICALLY by migration 0032's database triggers on the authoritative
 * start transition (created|paused → running). The /freeze endpoint above
 * is an optional EXPLICIT pre-freeze; it is NOT load-bearing for §9.
 *
 * SECURITY: no route ever returns credentials, callback tokens, handoff
 * tokens, or cookies. The ExecutionCandidate is metadata only (§2).
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { ArchitectureVersionRepository, ArchitectureRepository } from '@modules/architecture/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  ExecutionPolicyService,
  BenchmarkMode,
  UpdateProjectPolicyInput,
  UpdateUserPreferencesInput,
  UpsertAccessProfileInput,
} from '../../execution-policy/index.js';
import {
  requireProjectAuthorization,
  requireUser,
  runAuthed,
} from '../plugins/auth.plugin.js';

export interface ExecutionPolicyRouteDeps {
  authorizationService: AuthorizationService;
  executionPolicyService: ExecutionPolicyService;
  /** Resolve WorkItem → project (+ org) for the work-item-scoped routes. */
  workItemRepository: WorkItemRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  architectureRepository: ArchitectureRepository;
  projectRepository: ProjectRepository;
}

export async function executionPolicyRoutes(app: FastifyInstance, deps: ExecutionPolicyRouteDeps): Promise<void> {
  const { executionPolicyService } = deps;

  // --- §16/§22/§10 work-item-scoped ---

  app.get('/work-items/:workItemId/execution/recommendation', async (req, reply) => {
    return runAuthed(req, async () => {
      const workItemId = (req.params as { workItemId?: string } | null)?.workItemId ?? '';
      const ctx = await resolveOrgAndProjectForWorkItem(deps, workItemId);
      if (!ctx) return reply.code(404).send({ error: 'not-found', reason: 'work-item-or-chain-missing' });
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId: ctx.projectId });
      if (!user) return;
      const benchmarkMode = (req.query as { benchmarkMode?: string } | null)?.benchmarkMode as BenchmarkMode | undefined;
      try {
        const rec = await executionPolicyService.recommend({
          organizationId: ctx.organizationId,
          projectId: ctx.projectId,
          workItemId,
          userId: user.id,
          benchmarkMode,
        });
        return { recommendation: rec };
      } catch (err) {
        return reply.code(500).send({ error: 'execution-policy-recommend-failed', message: (err as Error).message });
      }
    });
  });

  app.get('/work-items/:workItemId/execution/decisions', async (req, reply) => {
    return runAuthed(req, async () => {
      const workItemId = (req.params as { workItemId?: string } | null)?.workItemId ?? '';
      const ctx = await resolveOrgAndProjectForWorkItem(deps, workItemId);
      if (!ctx) return reply.code(404).send({ error: 'not-found', reason: 'work-item-or-chain-missing' });
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId: ctx.projectId });
      if (!user) return;
      const decisions = await executionPolicyService.listDecisions(workItemId);
      return { decisions };
    });
  });

  app.get('/work-items/:workItemId/execution/controlled-comparison', async (req, reply) => {
    return runAuthed(req, async () => {
      const workItemId = (req.params as { workItemId?: string } | null)?.workItemId ?? '';
      const ctx = await resolveOrgAndProjectForWorkItem(deps, workItemId);
      if (!ctx) return reply.code(404).send({ error: 'not-found', reason: 'work-item-or-chain-missing' });
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId: ctx.projectId });
      if (!user) return;
      return { dimensions: executionPolicyService.controlledComparisonDimensions() };
    });
  });

  // --- §31 project policy ---

  app.get('/projects/:projectId/execution-policy', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId });
      if (!user) return;
      const policy = await executionPolicyService.getProjectPolicy(projectId);
      return { policy };
    });
  });

  app.post('/projects/:projectId/execution-policy', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.write', projectId });
      if (!user) return;
      const org = await resolveOrgForProject(deps, projectId);
      if (!org) return reply.code(404).send({ error: 'not-found', reason: 'project-missing' });
      const policy = await executionPolicyService.ensureProjectPolicy(org, projectId);
      return { policy };
    });
  });

  app.patch('/projects/:projectId/execution-policy', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.write', projectId });
      if (!user) return;
      const input = (req.body as Partial<UpdateProjectPolicyInput> | null) ?? {};
      try {
        const policy = await executionPolicyService.updateProjectPolicy(projectId, input);
        return { policy };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('frozen')) return reply.code(409).send({ error: 'policy-frozen', message: msg });
        return reply.code(404).send({ error: 'not-found', message: msg });
      }
    });
  });

  app.post('/projects/:projectId/execution-policy/freeze', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.write', projectId });
      if (!user) return;
      try {
        const policy = await executionPolicyService.freezeProjectPolicy(projectId);
        return { policy };
      } catch (err) {
        return reply.code(404).send({ error: 'not-found', message: (err as Error).message });
      }
    });
  });

  // --- §12 user preferences (project-scoped for tenant context) ---

  app.get('/projects/:projectId/execution-preferences', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId });
      if (!user) return;
      const prefs = await executionPolicyService.getUserPreferences(user.id);
      return { preferences: prefs };
    });
  });

  app.patch('/projects/:projectId/execution-preferences', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.write', projectId });
      if (!user) return;
      const input = (req.body as Partial<UpdateUserPreferencesInput> | null) ?? {};
      try {
        const prefs = await executionPolicyService.updateUserPreferences(user.id, input);
        return { preferences: prefs };
      } catch (err) {
        return reply.code(404).send({ error: 'not-found', message: (err as Error).message });
      }
    });
  });

  app.post('/projects/:projectId/execution-preferences', async (req, reply) => {
    // ensure (get-or-create defaults)
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.write', projectId });
      if (!user) return;
      const org = await resolveOrgForProject(deps, projectId);
      if (!org) return reply.code(404).send({ error: 'not-found', reason: 'project-missing' });
      const prefs = await executionPolicyService.ensureUserPreferences(org, user.id);
      return { preferences: prefs };
    });
  });

  // --- §5 provider access profiles (user-scoped, project-tenant context) ---

  app.get('/projects/:projectId/provider-access-profiles', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.read', projectId });
      if (!user) return;
      const profiles = await executionPolicyService.listAccessProfiles(user.id);
      return { profiles };
    });
  });

  app.post('/projects/:projectId/provider-access-profiles', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, { permission: 'project.write', projectId });
      if (!user) return;
      const org = await resolveOrgForProject(deps, projectId);
      if (!org) return reply.code(404).send({ error: 'not-found', reason: 'project-missing' });
      const input = (req.body as UpsertAccessProfileInput | null) ?? { provider: '' };
      if (!input.provider) return reply.code(400).send({ error: 'bad-request', reason: 'provider-required' });
      try {
        const profile = await executionPolicyService.upsertAccessProfile(org, user.id, input);
        return { profile };
      } catch (err) {
        return reply.code(400).send({ error: 'bad-request', message: (err as Error).message });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// resolution helpers (WorkItem → project + org)
// ---------------------------------------------------------------------------

interface WorkItemContext { organizationId: string; projectId: string; }

async function resolveOrgAndProjectForWorkItem(
  deps: ExecutionPolicyRouteDeps,
  workItemId: string,
): Promise<WorkItemContext | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  if (!arch?.projectId) return null;
  const org = await resolveOrgForProject(deps, arch.projectId);
  if (!org) return null;
  return { organizationId: org, projectId: arch.projectId };
}

async function resolveOrgForProject(deps: ExecutionPolicyRouteDeps, projectId: string): Promise<string | null> {
  const project = await deps.projectRepository.findById(projectId);
  return project?.organizationId ?? null;
}

// `requireUser` re-export keeps the auth-plugin import surface stable for
// future user-scoped (non-project) routes. Currently unused — exported for
// tree-shaking stability.
export { requireUser };
