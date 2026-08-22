import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  ArchitectureRepository,
  ArchitectureVersionRepository,
} from '@modules/architecture/index.js';
import type {
  RequirementRepository,
  RequirementDependencyRepository,
  AcceptanceCriterionRepository,
  EvidenceReferenceRepository,
} from '@modules/requirements/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * Protected requirements routes demonstrating WORK-006 contracts.
 *
 * All routes are backend-authorized via the reusable {@link AuthorizationService}
 * (reused from WORK-002). Authorization resolves through the traceability chain:
 *   Requirement → ArchitectureVersion → Architecture → Project
 * The project's owning organization determines tenant scoping.
 *
 * Read operations require `project.read`; mutations require `project.write`.
 */
export interface RequirementsRouteDeps {
  authorizationService: AuthorizationService;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  requirementRepository: RequirementRepository;
  requirementDependencyRepository: RequirementDependencyRepository;
  acceptanceCriterionRepository: AcceptanceCriterionRepository;
  evidenceReferenceRepository: EvidenceReferenceRepository;
}

/** Resolve the project id for a requirement by walking the traceability chain. */
async function resolveProjectForRequirement(
  deps: RequirementsRouteDeps,
  requirementId: string,
): Promise<string | null> {
  const req = await deps.requirementRepository.findById(requirementId);
  if (!req) return null;
  const version = await deps.architectureVersionRepository.findById(req.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

/** Resolve the project id for an architecture version. */
async function resolveProjectForVersion(
  deps: RequirementsRouteDeps,
  versionId: string,
): Promise<string | null> {
  const version = await deps.architectureVersionRepository.findById(versionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

/** Resolve the project id for a criterion by walking to its requirement. */
async function resolveProjectForCriterion(
  deps: RequirementsRouteDeps,
  criterionId: string,
): Promise<string | null> {
  const criterion = await deps.acceptanceCriterionRepository.findById(criterionId);
  if (!criterion) return null;
  return resolveProjectForRequirement(deps, criterion.requirementId);
}

export async function requirementsRoutes(
  app: FastifyInstance,
  deps: RequirementsRouteDeps,
): Promise<void> {
  // --- Requirements ---

  app.post('/architecture-versions/:versionId/requirements', async (req, reply) => {
    return runAuthed(req, async () => {
      const { versionId } = req.params as { versionId: string };
      const projectId = await resolveProjectForVersion(deps, versionId);
      if (!projectId) return reply.code(404).send({ error: 'architecture-version-not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        requirementId?: string;
        title?: string;
        description?: string;
        verificationRequirement?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.requirementId || !body?.title) {
        return reply.code(400).send({ error: 'requirementId and title required' });
      }
      const requirement = await deps.requirementRepository.create({
        architectureVersionId: versionId,
        requirementId: body.requirementId,
        title: body.title,
        description: body.description,
        verificationRequirement: body.verificationRequirement,
        metadata: body.metadata,
      });
      return reply.code(201).send(requirement);
    });
  });

  app.get('/architecture-versions/:versionId/requirements', async (req, reply) => {
    return runAuthed(req, async () => {
      const { versionId } = req.params as { versionId: string };
      const projectId = await resolveProjectForVersion(deps, versionId);
      if (!projectId) return reply.code(404).send({ error: 'architecture-version-not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const list = await deps.requirementRepository.findByArchitectureVersion(versionId);
      return { requirements: list };
    });
  });

  app.get('/requirements/:requirementId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { requirementId } = req.params as { requirementId: string };
      const projectId = await resolveProjectForRequirement(deps, requirementId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const requirement = await deps.requirementRepository.findById(requirementId);
      if (!requirement) return reply.code(404).send({ error: 'not-found' });
      return requirement;
    });
  });

  app.patch('/requirements/:requirementId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { requirementId } = req.params as { requirementId: string };
      const projectId = await resolveProjectForRequirement(deps, requirementId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        title?: string;
        description?: string;
        verificationRequirement?: string;
        status?: string;
        metadata?: Record<string, unknown>;
      };
      const updated = await deps.requirementRepository.update(requirementId, {
        title: body?.title,
        description: body?.description,
        verificationRequirement: body?.verificationRequirement,
        status: body?.status as never,
        metadata: body?.metadata,
      });
      if (!updated) return reply.code(404).send({ error: 'not-found' });
      return updated;
    });
  });

  // --- Requirement dependencies ---

  app.post('/requirements/:requirementId/dependencies', async (req, reply) => {
    return runAuthed(req, async () => {
      const { requirementId } = req.params as { requirementId: string };
      const projectId = await resolveProjectForRequirement(deps, requirementId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as { dependsOnId?: string };
      if (!body?.dependsOnId) {
        return reply.code(400).send({ error: 'dependsOnId required' });
      }
      try {
        const dep = await deps.requirementDependencyRepository.add(requirementId, body.dependsOnId);
        return reply.code(201).send(dep);
      } catch (err) {
        return reply.code(400).send({ error: 'invalid-dependency', message: (err as Error).message });
      }
    });
  });

  app.get('/requirements/:requirementId/dependencies', async (req, reply) => {
    return runAuthed(req, async () => {
      const { requirementId } = req.params as { requirementId: string };
      const projectId = await resolveProjectForRequirement(deps, requirementId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const list = await deps.requirementDependencyRepository.listForRequirement(requirementId);
      return { dependencies: list };
    });
  });

  // --- Acceptance Criteria ---

  app.post('/requirements/:requirementId/criteria', async (req, reply) => {
    return runAuthed(req, async () => {
      const { requirementId } = req.params as { requirementId: string };
      const projectId = await resolveProjectForRequirement(deps, requirementId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        criterionId?: string;
        description?: string;
        verificationExpectation?: string;
        status?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.criterionId || !body?.description) {
        return reply.code(400).send({ error: 'criterionId and description required' });
      }
      const criterion = await deps.acceptanceCriterionRepository.create({
        requirementId,
        criterionId: body.criterionId,
        description: body.description,
        verificationExpectation: body.verificationExpectation,
        status: body.status as never,
        metadata: body.metadata,
      });
      return reply.code(201).send(criterion);
    });
  });

  app.get('/requirements/:requirementId/criteria', async (req, reply) => {
    return runAuthed(req, async () => {
      const { requirementId } = req.params as { requirementId: string };
      const projectId = await resolveProjectForRequirement(deps, requirementId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const list = await deps.acceptanceCriterionRepository.listForRequirement(requirementId);
      return { criteria: list };
    });
  });

  app.patch('/criteria/:criterionId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { criterionId } = req.params as { criterionId: string };
      const projectId = await resolveProjectForCriterion(deps, criterionId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        description?: string;
        verificationExpectation?: string;
        status?: string;
        metadata?: Record<string, unknown>;
      };
      const updated = await deps.acceptanceCriterionRepository.update(criterionId, {
        description: body?.description,
        verificationExpectation: body?.verificationExpectation,
        status: body?.status as never,
        metadata: body?.metadata,
      });
      if (!updated) return reply.code(404).send({ error: 'not-found' });
      return updated;
    });
  });

  // --- Evidence references ---

  app.post('/criteria/:criterionId/evidence-references', async (req, reply) => {
    return runAuthed(req, async () => {
      const { criterionId } = req.params as { criterionId: string };
      const projectId = await resolveProjectForCriterion(deps, criterionId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        evidenceType?: string;
        evidenceRef?: string;
        source?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.evidenceType || !body?.evidenceRef) {
        return reply.code(400).send({ error: 'evidenceType and evidenceRef required' });
      }
      const ref = await deps.evidenceReferenceRepository.add({
        criterionId,
        evidenceType: body.evidenceType,
        evidenceRef: body.evidenceRef,
        source: body.source,
        metadata: body.metadata,
      });
      return reply.code(201).send(ref);
    });
  });

  app.get('/criteria/:criterionId/evidence-references', async (req, reply) => {
    return runAuthed(req, async () => {
      const { criterionId } = req.params as { criterionId: string };
      const projectId = await resolveProjectForCriterion(deps, criterionId);
      if (!projectId) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const list = await deps.evidenceReferenceRepository.listForCriterion(criterionId);
      return { evidenceReferences: list };
    });
  });
}
