import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  ArchitectureRepository,
  ArchitectureVersionRepository,
  ArchitectureDecisionRepository,
  ArchitectureChangeRequestRepository,
  ArchitectureService,
  ArchitectureAssertionRepository,
} from '@modules/architecture/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * Protected architecture routes demonstrating WORK-005 contracts.
 *
 * All routes are backend-authorized via the reusable {@link AuthorizationService}
 * (reused from WORK-002). Read operations require `project.read`; privileged
 * operations (freeze, approve/reject change requests) require `project.admin`.
 * No new permission system is introduced.
 *
 * The architecture domain is project-owned and tenant-scoped; cross-tenant
 * access is denied through the existing authorization boundary.
 */
export interface ArchitectureRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  architectureDecisionRepository: ArchitectureDecisionRepository;
  architectureChangeRequestRepository: ArchitectureChangeRequestRepository;
  architectureService: ArchitectureService;
  /**
   * WORK-051: the assertion store owned by /architecture (append-only;
   * attach is DRAFT-version-only, persistence-enforced by the migration-0052
   * trigger — the governed population path for a version's assertion set
   * BEFORE freeze).
   */
  architectureAssertionRepository: ArchitectureAssertionRepository;
}

export async function architectureRoutes(
  app: FastifyInstance,
  deps: ArchitectureRouteDeps,
): Promise<void> {
  // --- Architecture CRUD ---

  app.post('/projects/:projectId/architectures', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as { name?: string; description?: string };
      if (!body?.name) {
        return reply.code(400).send({ error: 'name required' });
      }
      const arch = await deps.architectureRepository.create({
        projectId,
        name: body.name,
        description: body.description,
      });
      return reply.code(201).send(arch);
    });
  });

  app.get('/projects/:projectId/architectures', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const list = await deps.architectureRepository.findByProject(projectId);
      return { architectures: list };
    });
  });

  app.get('/architectures/:architectureId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { architectureId } = req.params as { architectureId: string };
      const arch = await deps.architectureRepository.findById(architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: arch.projectId,
      });
      return arch;
    });
  });

  // --- Architecture Versions ---

  app.post('/architectures/:architectureId/versions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { architectureId } = req.params as { architectureId: string };
      const arch = await deps.architectureRepository.findById(architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: arch.projectId,
      });
      const body = req.body as {
        contentInline?: string;
        storageKey?: string;
        storageProvider?: string;
        contentLength?: number;
        contentType?: string;
        digestSha256?: string;
        metadata?: Record<string, unknown>;
      };
      const version = await deps.architectureVersionRepository.create({
        architectureId,
        contentInline: body?.contentInline,
        storageKey: body?.storageKey,
        storageProvider: body?.storageProvider,
        contentLength: body?.contentLength,
        contentType: body?.contentType,
        digestSha256: body?.digestSha256,
        metadata: body?.metadata,
      });
      return reply.code(201).send(version);
    });
  });

  app.get('/architectures/:architectureId/versions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { architectureId } = req.params as { architectureId: string };
      const arch = await deps.architectureRepository.findById(architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: arch.projectId,
      });
      const versions = await deps.architectureVersionRepository.findByArchitecture(architectureId);
      return { versions };
    });
  });

  // --- Freeze a version (privileged: project.admin) ---

  app.post('/architecture-versions/:versionId/freeze', async (req, reply) => {
    return runAuthed(req, async () => {
      const { versionId } = req.params as { versionId: string };
      const version = await deps.architectureVersionRepository.findById(versionId);
      if (!version) return reply.code(404).send({ error: 'not-found' });
      const arch = await deps.architectureRepository.findById(version.architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.admin',
        projectId: arch.projectId,
      });
      // WORK-051 round 1 (HIGH — empty-set semantics): the explicit
      // no-assertions declaration. Freezing a version with ZERO assertions
      // fails closed without it.
      const body = req.body as { allowEmptyAssertionSet?: boolean } | undefined;
      try {
        const frozen = await deps.architectureService.freezeVersion(versionId, user.id, {
          allowEmptyAssertionSet: body?.allowEmptyAssertionSet === true,
        });
        return frozen;
      } catch (err) {
        return reply.code(409).send({ error: 'invalid-transition', message: (err as Error).message });
      }
    });
  });

  // --- Architecture Assertions (WORK-051 — the governed population path) ---
  //
  // Assertions are version-scoped architectural rules owned by /architecture.
  // They may be attached ONLY while the version is DRAFT (the repository +
  // the persistence-layer trigger both enforce it); once the version is
  // FROZEN the assertion set is closed — intentional change follows the
  // Architecture Change Request → new immutable version path.

  app.post('/architecture-versions/:versionId/assertions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { versionId } = req.params as { versionId: string };
      const version = await deps.architectureVersionRepository.findById(versionId);
      if (!version) return reply.code(404).send({ error: 'not-found' });
      const arch = await deps.architectureRepository.findById(version.architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: arch.projectId,
      });
      const body = req.body as {
        assertionId?: string;
        severity?: string;
        scope?: string;
        statement?: string;
        detectorKind?: string;
        detectorConfig?: Record<string, unknown>;
      };
      if (!body?.assertionId || !body?.statement || !body?.detectorKind) {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'assertionId, statement, and detectorKind are required',
        });
      }
      if (body.severity !== 'blocking' && body.severity !== 'advisory') {
        return reply.code(400).send({
          error: 'invalid-request',
          message: "severity must be 'blocking' or 'advisory'",
        });
      }
      try {
        const validScopes = [
          'repository', 'module', 'interface', 'data', 'workflow',
          'security', 'execution', 'other',
        ];
        const scope = typeof body.scope === 'string' && validScopes.includes(body.scope)
          ? (body.scope as import('@modules/architecture/index.js').ArchitectureAssertionScope)
          : 'repository';
        const assertion = await deps.architectureAssertionRepository.create({
          architectureVersionId: versionId,
          assertionId: body.assertionId,
          severity: body.severity,
          scope,
          statement: body.statement,
          detectorKind: body.detectorKind,
          detectorConfig: body.detectorConfig ?? {},
        });
        return reply.code(201).send(assertion);
      } catch (err) {
        // Non-draft version (or duplicate assertionId) — the set is closed.
        return reply.code(409).send({ error: 'assertion-set-closed', message: (err as Error).message });
      }
    });
  });

  app.get('/architecture-versions/:versionId/assertions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { versionId } = req.params as { versionId: string };
      const version = await deps.architectureVersionRepository.findById(versionId);
      if (!version) return reply.code(404).send({ error: 'not-found' });
      const arch = await deps.architectureRepository.findById(version.architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: arch.projectId,
      });
      const assertions = await deps.architectureAssertionRepository.listForVersion(versionId);
      return { assertions };
    });
  });

  // --- Architecture Decision Records (ADRs) ---

  app.post('/architecture-versions/:versionId/decisions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { versionId } = req.params as { versionId: string };
      const version = await deps.architectureVersionRepository.findById(versionId);
      if (!version) return reply.code(404).send({ error: 'not-found' });
      const arch = await deps.architectureRepository.findById(version.architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: arch.projectId,
      });
      const body = req.body as { title?: string; content?: string; status?: string };
      if (!body?.title || !body?.content) {
        return reply.code(400).send({ error: 'title and content required' });
      }
      const adr = await deps.architectureDecisionRepository.create({
        versionId,
        title: body.title,
        content: body.content,
        status: body.status,
      });
      return reply.code(201).send(adr);
    });
  });

  app.get('/architecture-versions/:versionId/decisions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { versionId } = req.params as { versionId: string };
      const version = await deps.architectureVersionRepository.findById(versionId);
      if (!version) return reply.code(404).send({ error: 'not-found' });
      const arch = await deps.architectureRepository.findById(version.architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: arch.projectId,
      });
      const decisions = await deps.architectureDecisionRepository.listForVersion(versionId);
      return { decisions };
    });
  });

  // --- Architecture Change Requests ---

  app.post('/architectures/:architectureId/change-requests', async (req, reply) => {
    return runAuthed(req, async () => {
      const { architectureId } = req.params as { architectureId: string };
      const arch = await deps.architectureRepository.findById(architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId: arch.projectId,
      });
      const body = req.body as {
        affectedVersionId?: string;
        reason?: string;
        requestedChange?: string;
      };
      if (!body?.reason || !body?.requestedChange) {
        return reply.code(400).send({ error: 'reason and requestedChange required' });
      }
      const cr = await deps.architectureChangeRequestRepository.create({
        architectureId,
        affectedVersionId: body.affectedVersionId,
        requesterId: user.id,
        reason: body.reason,
        requestedChange: body.requestedChange,
      });
      return reply.code(201).send(cr);
    });
  });

  app.get('/architectures/:architectureId/change-requests', async (req, reply) => {
    return runAuthed(req, async () => {
      const { architectureId } = req.params as { architectureId: string };
      const arch = await deps.architectureRepository.findById(architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId: arch.projectId,
      });
      const list = await deps.architectureChangeRequestRepository.listForArchitecture(architectureId);
      return { changeRequests: list };
    });
  });

  // --- Approve a Change Request + create replacement version (privileged: project.admin) ---
  // This is the ONLY path to create a replacement version (ARCH4-AC-02/03).

  app.post('/change-requests/:crId/approve', async (req, reply) => {
    return runAuthed(req, async () => {
      const { crId } = req.params as { crId: string };
      const cr = await deps.architectureChangeRequestRepository.findById(crId);
      if (!cr) return reply.code(404).send({ error: 'not-found' });
      const arch = await deps.architectureRepository.findById(cr.architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.admin',
        projectId: arch.projectId,
      });
      const body = req.body as {
        contentInline?: string;
        storageKey?: string;
        storageProvider?: string;
        contentLength?: number;
        contentType?: string;
        digestSha256?: string;
        metadata?: Record<string, unknown>;
      };
      try {
        const result = await deps.architectureService.approveChangeAndCreateReplacement(
          crId,
          user.id,
          body ?? {},
        );
        return reply.code(201).send(result);
      } catch (err) {
        return reply.code(409).send({ error: 'approval-failed', message: (err as Error).message });
      }
    });
  });

  // --- Reject a Change Request (privileged: project.admin) ---

  app.post('/change-requests/:crId/reject', async (req, reply) => {
    return runAuthed(req, async () => {
      const { crId } = req.params as { crId: string };
      const cr = await deps.architectureChangeRequestRepository.findById(crId);
      if (!cr) return reply.code(404).send({ error: 'not-found' });
      const arch = await deps.architectureRepository.findById(cr.architectureId);
      if (!arch) return reply.code(404).send({ error: 'not-found' });
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.admin',
        projectId: arch.projectId,
      });
      try {
        const rejected = await deps.architectureService.rejectChangeRequest(crId, user.id);
        return rejected;
      } catch (err) {
        return reply.code(409).send({ error: 'reject-failed', message: (err as Error).message });
      }
    });
  });
}
