import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  SpecificationRepository,
  SpecificationVersionRepository,
  SpecificationState,
} from '@modules/specifications/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ObjectStore } from '@platform/index.js';
import { createHash } from 'node:crypto';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * Protected specification routes demonstrating WORK-004 contracts (SPEC-AC-01..03).
 *
 * All routes are backend-authorized via the reusable {@link AuthorizationService}
 * (AUTHZ-AC-01..03). Tenant isolation is inherited through the project's
 * owning organization — a cross-tenant specification request is denied because
 * the caller has no access to the owning project.
 *
 * Large content bodies are stored via the existing ObjectStore abstraction
 * (DATA-003); only metadata + storage_key live in PostgreSQL.
 */
export interface SpecificationsRouteDeps {
  authorizationService: AuthorizationService;
  specificationRepository: SpecificationRepository;
  specificationVersionRepository: SpecificationVersionRepository;
  projectRepository: ProjectRepository;
  objectStore: ObjectStore;
}

const VALID_STATES: SpecificationState[] = ['draft', 'published', 'archived'];
const INLINE_THRESHOLD = 8 * 1024; // bodies > 8KiB use object storage

export async function specificationsRoutes(
  app: FastifyInstance,
  deps: SpecificationsRouteDeps,
): Promise<void> {
  // Create a specification in a project.
  app.post('/projects/:projectId/specifications', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as { slug?: string; title?: string };
      if (!body?.slug || !body?.title) {
        return reply.code(400).send({ error: 'slug and title required' });
      }
      const spec = await deps.specificationRepository.create({
        projectId,
        slug: body.slug,
        title: body.title,
      });
      return reply.code(201).send(spec);
    });
  });

  // Get a specification (requires project.read on the owning project).
  app.get('/projects/:projectId/specifications/:specId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, specId } = req.params as { projectId: string; specId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const spec = await deps.specificationRepository.findById(specId);
      if (!spec || spec.projectId !== projectId) {
        return reply.code(404).send({ error: 'not-found' });
      }
      return spec;
    });
  });

  // Create a new version of a specification. Large content is stored via
  // ObjectStore; small content is stored inline (SPEC-AC-03).
  app.post('/projects/:projectId/specifications/:specId/versions', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, specId } = req.params as { projectId: string; specId: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as { content?: string; contentType?: string };
      if (!body?.content) {
        return reply.code(400).send({ error: 'content required' });
      }
      const spec = await deps.specificationRepository.findById(specId);
      if (!spec || spec.projectId !== projectId) {
        return reply.code(404).send({ error: 'not-found' });
      }
      const contentBuf = Buffer.from(body.content, 'utf8');
      const contentType = body.contentType ?? 'text/plain';
      const digest = sha256Hex(contentBuf);

      // Large bodies go to object storage (DATA3-AC-02); small go inline.
      let storageKey: string | undefined;
      let storageProvider: string | undefined;
      let contentInline: string | undefined;
      if (contentBuf.length > INLINE_THRESHOLD) {
        const stored = await deps.objectStore.put({
          body: contentBuf,
          contentType,
          metadata: { specificationId: specId, source: 'work-004' },
        });
        storageKey = stored.key;
        storageProvider = stored.provider;
      } else {
        contentInline = body.content;
      }

      const version = await deps.specificationVersionRepository.create({
        specificationId: specId,
        contentInline,
        storageKey,
        storageProvider,
        contentLength: contentBuf.length,
        contentType,
        digestSha256: digest,
        createdBy: user.id,
      });
      return reply.code(201).send(version);
    });
  });

  // Get the latest version of a specification (with content resolved from
  // object storage when applicable).
  app.get('/projects/:projectId/specifications/:specId/versions/latest', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, specId } = req.params as { projectId: string; specId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const spec = await deps.specificationRepository.findById(specId);
      if (!spec || spec.projectId !== projectId) {
        return reply.code(404).send({ error: 'not-found' });
      }
      const version = await deps.specificationVersionRepository.findLatest(specId);
      if (!version) return reply.code(404).send({ error: 'no-versions' });
      // Resolve content: inline or from object storage.
      let content: string | null = null;
      if (version.contentInline) {
        content = version.contentInline;
      } else if (version.storageKey) {
        const obj = await deps.objectStore.get(version.storageKey);
        if (obj) content = obj.body.toString('utf8');
      }
      return { ...version, content };
    });
  });

  // Transition a specification's lifecycle state (SPEC-AC-02).
  app.post('/projects/:projectId/specifications/:specId/transition', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId, specId } = req.params as { projectId: string; specId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.admin',
        projectId,
      });
      const spec = await deps.specificationRepository.findById(specId);
      if (!spec || spec.projectId !== projectId) {
        return reply.code(404).send({ error: 'not-found' });
      }
      const body = req.body as { to?: string };
      if (!body?.to || !VALID_STATES.includes(body.to as SpecificationState)) {
        return reply.code(400).send({ error: 'invalid state', validStates: VALID_STATES });
      }
      try {
        const result = await deps.specificationRepository.transitionState(
          specId,
          body.to as SpecificationState,
        );
        return result;
      } catch (err) {
        return reply.code(409).send({ error: 'invalid-transition', message: (err as Error).message });
      }
    });
  });
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
