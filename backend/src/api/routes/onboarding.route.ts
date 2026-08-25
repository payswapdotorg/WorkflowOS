import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository, ProjectBaselineRepository } from '@modules/projects/index.js';
import type {
  OnboardingService,
} from '@onboarding/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * WORK-038: onboarding routes — surface the existing-project-onboarding
 * capability over HTTP.
 *
 *   POST   /projects/:projectId/onboard
 *     — connect + analyze a repository revision at its exact commit SHA.
 *       Idempotent per (project, repo, exact commit). Requires project.write.
 *   GET    /projects/:projectId/baselines
 *     — list the project's baselines. Requires project.read.
 *   GET    /projects/:projectId/baselines/:baselineId
 *     — read a baseline + its observations + evidence. Requires project.read.
 *   POST   /projects/:projectId/baselines/:baselineId/observations/:observationId/confirm
 *     — the AUTHORIZED CONFIRMATION PATH: transition an inferred/proposed
 *       observation to confirmed (sets confirmed_by/at to the calling user).
 *       Requires project.admin. This is the ONLY way provenance becomes
 *       'confirmed' (no silent promotion).
 *
 * Every route is backend-authorized via the reusable AuthorizationService
 * (AUTHZ-AC-01..03). A repository or baseline UUID is NOT an authorization
 * credential — every mutation resolves the resource, verifies authorization
 * server-side, then mutates.
 *
 * The route is THIN: it delegates to the OnboardingService (the orchestrator
 * that composes /github + /agents + /projects) and the ProjectBaselineRepository
 * (the /projects storage authority). No GitHub SDK, no credentials, no DB
 * access here.
 */
export interface OnboardingRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  projectBaselineRepository: ProjectBaselineRepository;
  onboardingService: OnboardingService;
}

export async function onboardingRoutes(
  app: FastifyInstance,
  deps: OnboardingRouteDeps,
): Promise<void> {
  // POST /projects/:projectId/onboard — connect + analyze a repository revision.
  // Body: { ref?, analysisMode? }. Returns the baseline header. Idempotent per
  // (project, repo, exact commit): re-onboarding the same revision returns the
  // SAME baseline (analyzed=false).
  app.post('/projects/:projectId/onboard', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as { ref?: string; analysisMode?: 'native' | 'external' } | undefined;
      try {
        const result = await deps.onboardingService.onboard({
          projectId,
          ref: body?.ref,
          analysisMode: body?.analysisMode,
        });
        return reply.code(201).send(result);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('project-not-found')) {
          return reply.code(404).send({ error: 'project-not-found', projectId });
        }
        if (msg.includes('no-repository-link')) {
          return reply.code(409).send({
            error: 'no-repository-link',
            hint: 'Link a GitHub repository to this project first via POST /projects/:projectId/github/link',
          });
        }
        if (msg.includes('revision-unresolvable')) {
          return reply.code(502).send({
            error: 'revision-unresolvable',
            message: msg.slice(0, 500),
          });
        }
        return reply.code(500).send({ error: 'onboarding-failed', message: msg.slice(0, 500) });
      }
    });
  });

  // GET /projects/:projectId/baselines — list the project's baselines.
  app.get('/projects/:projectId/baselines', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const baselines = await deps.projectBaselineRepository.listForProject(projectId);
      return { baselines };
    });
  });

  // GET /projects/:projectId/baselines/:baselineId — read a baseline + its
  // observations + evidence. The baseline must belong to the authorized
  // project (server-side ownership check — no UUID-as-credential).
  app.get('/projects/:projectId/baselines/:baselineId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, baselineId } = req.params as {
        projectId: string;
        baselineId: string;
      };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const baseline = await deps.projectBaselineRepository.findById(baselineId);
      if (!baseline || baseline.projectId !== projectId) {
        return reply.code(404).send({ error: 'not-found' });
      }
      const [observations, evidence] = await Promise.all([
        deps.projectBaselineRepository.listObservations(baselineId),
        deps.projectBaselineRepository.listEvidence(baselineId),
      ]);
      return { baseline, observations, evidence };
    });
  });

  // POST /projects/:projectId/baselines/:baselineId/observations/:observationId/confirm
  // — the AUTHORIZED CONFIRMATION PATH. Transitions an inferred/proposed
  // observation to confirmed (sets confirmed_by to the calling user). This is
  // the ONLY way provenance becomes 'confirmed' (no silent promotion — the DB
  // trigger + the repository method enforce it). Requires project.admin.
  app.post(
    '/projects/:projectId/baselines/:baselineId/observations/:observationId/confirm',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId, baselineId, observationId } = req.params as {
          projectId: string;
          baselineId: string;
          observationId: string;
        };
        const user = await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.admin',
          projectId,
        });
        // Ownership check: the baseline must belong to the authorized project.
        const baseline = await deps.projectBaselineRepository.findById(baselineId);
        if (!baseline || baseline.projectId !== projectId) {
          return reply.code(404).send({ error: 'not-found' });
        }
        try {
          const confirmed = await deps.projectBaselineRepository.confirmObservation(
            baselineId,
            observationId,
            user.id,
          );
          return reply.code(200).send(confirmed);
        } catch (err) {
          const msg = (err as Error).message ?? '';
          if (msg.includes('not-found')) {
            return reply.code(404).send({ error: 'observation-not-found' });
          }
          if (msg.includes('confirmation-inconsistent')) {
            return reply.code(409).send({
              error: 'confirmation-inconsistent',
              message: 'Only inferred/proposed observations can be confirmed; observed/confirmed observations cannot be promoted.',
            });
          }
          return reply.code(500).send({ error: 'confirmation-failed', message: msg.slice(0, 500) });
        }
      });
    },
  );
}
