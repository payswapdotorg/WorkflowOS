/**
 * V2-002 — Workflow Repository routes: the HTTP surface for the Git-like
 * durable repository model (Workflow + immutable WorkflowVersion +
 * WorkflowInstallation).
 *
 * ROUTES (all backend-authorized: a resolved human principal via the auth
 * plugin's API-key/session path; repository visibility/ownership is decided
 * by the WorkflowRepositoryService, which consumes the identity authority's
 * membership facts):
 *
 *   POST   /organizations/:orgId/workflow-repository/workflows
 *          — create-or-converge a workflow (born with immutable version 1)
 *   GET    /organizations/:orgId/workflow-repository/workflows
 *          — the tenant's workflows visible to the caller
 *   POST   /workflow-repository/workflows/:workflowId/versions
 *          — create-or-converge a NEW immutable version ("edit"; owner-only)
 *   GET    /workflow-repository/workflows/:workflowId/versions
 *          — the workflow's immutable versions (stable order)
 *   GET    /workflow-repository/workflows/:workflowId/versions/:versionId
 *          — one exact immutable version
 *   GET    /workflow-repository/workflows/:workflowId
 *          — read one workflow (visibility-checked)
 *   PATCH  /workflow-repository/workflows/:workflowId
 *          — repository metadata only (name/description/visibility; owner-only)
 *   POST   /organizations/:orgId/workflow-repository/forks
 *          — fork a visible source version into the caller's tenant
 *   POST   /organizations/:orgId/workflow-repository/installations
 *          — install ONE EXACT version (the pin; create-or-converge)
 *   GET    /organizations/:orgId/workflow-repository/installations
 *          — the tenant's installations with pinned versions
 *   GET    /organizations/:orgId/workflow-repository/installations/:installationId
 *          — one installation with its pinned version resolved
 *   POST   /organizations/:orgId/workflow-repository/installations/:installationId/{enable|disable|uninstall}
 *          — the installation lifecycle (NEVER touches any version)
 *
 * R6 (API level): there is deliberately NO route that can mutate or delete a
 * WorkflowVersion — PUT/PATCH/DELETE on version paths do not exist (404), and
 * the PostgreSQL boundary additionally rejects any such mutation by trigger.
 *
 * Denied reads answer a UNIFORM 404 'workflow-not-found' so private/organization
 * scoped workflows do not leak their existence across tenants.
 */
import type { FastifyInstance } from 'fastify';
import type {
  Workflow,
  WorkflowInstallation,
  WorkflowInstallationAction,
  WorkflowInstallationDetail,
  WorkflowRepositoryErrorCode,
  WorkflowRepositoryService,
  WorkflowVersion,
} from '../../workflow-repository/index.js';
import { WorkflowRepositoryError } from '../../workflow-repository/index.js';
import { requireUser, runAuthed } from '../plugins/auth.plugin.js';

export interface WorkflowRepositoryRouteDeps {
  /** The one repository authority (V2-002 service). */
  workflowRepositoryService: WorkflowRepositoryService;
}

/** Typed error code → HTTP status (never parse message strings). */
const ERROR_STATUS: Record<WorkflowRepositoryErrorCode, number> = {
  WORKFLOW_NOT_FOUND: 404,
  // Uniform 404 for denied visibility: no existence leak across scopes.
  WORKFLOW_NOT_VISIBLE: 404,
  WORKFLOW_VERSION_NOT_FOUND: 404,
  WORKFLOW_INSTALLATION_NOT_FOUND: 404,
  WORKFLOW_NOT_OWNED: 403,
  WORKFLOW_NOT_ORGANIZATION_MEMBER: 403,
  WORKFLOW_INVALID_SLUG: 400,
  WORKFLOW_NAME_REQUIRED: 400,
  WORKFLOW_INVALID_VISIBILITY: 400,
  WORKFLOW_INVALID_CONTENT: 400,
  WORKFLOW_INVALID_PROTOCOL: 400,
  WORKFLOW_INVALID_PARENT_VERSION: 400,
};

/**
 * Typed error code → the stable wire identifier. A denied read
 * (WORKFLOW_NOT_VISIBLE) answers the SAME identifier as a missing workflow
 * so scoped workflows do not leak their EXISTENCE to other tenants.
 */
const ERROR_IDENTIFIER: Record<WorkflowRepositoryErrorCode, string> = {
  WORKFLOW_NOT_FOUND: 'workflow-not-found',
  WORKFLOW_NOT_VISIBLE: 'workflow-not-found',
  WORKFLOW_VERSION_NOT_FOUND: 'workflow-version-not-found',
  WORKFLOW_INSTALLATION_NOT_FOUND: 'workflow-installation-not-found',
  WORKFLOW_NOT_OWNED: 'workflow-not-owned',
  WORKFLOW_NOT_ORGANIZATION_MEMBER: 'workflow-not-organization-member',
  WORKFLOW_INVALID_SLUG: 'workflow-invalid-slug',
  WORKFLOW_NAME_REQUIRED: 'workflow-name-required',
  WORKFLOW_INVALID_VISIBILITY: 'workflow-invalid-visibility',
  WORKFLOW_INVALID_CONTENT: 'workflow-invalid-content',
  WORKFLOW_INVALID_PROTOCOL: 'workflow-invalid-protocol',
  WORKFLOW_INVALID_PARENT_VERSION: 'workflow-invalid-parent-version',
};

function sendRepositoryError(
  reply: { code: (n: number) => { send: (b: unknown) => void } },
  err: unknown,
): void {
  if (err instanceof WorkflowRepositoryError) {
    const status = ERROR_STATUS[err.code] ?? 400;
    reply.code(status).send({
      error: ERROR_IDENTIFIER[err.code] ?? err.code.toLowerCase().replace(/_/g, '-'),
      code: err.code,
      message: err.message,
    });
    return;
  }
  reply.code(500).send({
    error: 'workflow-repository-internal-error',
    message: (err as Error).message,
  });
}

// --- wire serializers (deterministic key order; ISO dates) -----------------

function serializeWorkflow(workflow: Workflow): Record<string, unknown> {
  return {
    id: workflow.id,
    organizationId: workflow.organizationId,
    ownerUserId: workflow.ownerUserId,
    slug: workflow.slug,
    name: workflow.name,
    description: workflow.description,
    visibility: workflow.visibility,
    headVersionId: workflow.headVersionId,
    forkedFromWorkflowId: workflow.forkedFromWorkflowId,
    forkedFromVersionId: workflow.forkedFromVersionId,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

function serializeVersion(version: WorkflowVersion): Record<string, unknown> {
  return {
    id: version.id,
    workflowId: version.workflowId,
    versionNumber: version.versionNumber,
    contentDigest: version.contentDigest,
    content: version.content,
    protocol: version.protocol,
    parentVersionId: version.parentVersionId,
    createdByUserId: version.createdByUserId,
    createdAt: version.createdAt.toISOString(),
  };
}

function serializeInstallation(
  installation: WorkflowInstallation,
): Record<string, unknown> {
  return {
    id: installation.id,
    organizationId: installation.organizationId,
    workflowId: installation.workflowId,
    versionId: installation.versionId,
    installedByUserId: installation.installedByUserId,
    status: installation.status,
    installedAt: installation.installedAt.toISOString(),
    updatedAt: installation.updatedAt.toISOString(),
  };
}

function serializeInstallationDetail(
  detail: WorkflowInstallationDetail,
): Record<string, unknown> {
  return {
    installation: serializeInstallation(detail.installation),
    pinnedVersion: {
      id: detail.pinnedVersion.id,
      workflowId: detail.pinnedVersion.workflowId,
      versionNumber: detail.pinnedVersion.versionNumber,
      contentDigest: detail.pinnedVersion.contentDigest,
      protocol: detail.pinnedVersion.protocol,
    },
  };
}

/** Structural presence checks (the service validates canonical shapes). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function workflowRepositoryRoutes(
  app: FastifyInstance,
  deps: WorkflowRepositoryRouteDeps,
): Promise<void> {
  const service = deps.workflowRepositoryService;

  // --- create a workflow (born with immutable version 1) ---------------------

  app.post('/organizations/:orgId/workflow-repository/workflows', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.slug !== 'string' ||
        typeof body.name !== 'string' ||
        typeof body.visibility !== 'string' ||
        body.content === undefined ||
        !isRecord(body.protocol)
      ) {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'slug, name, visibility, content and protocol are required',
        });
      }
      const description =
        body.description === undefined || body.description === null
          ? null
          : typeof body.description === 'string'
            ? body.description
            : null;
      try {
        const result = await service.createWorkflow({ userId: user.id }, {
          organizationId: orgId,
          slug: body.slug,
          name: body.name,
          description,
          visibility: body.visibility as never,
          content: body.content as Record<string, unknown>,
          protocol: body.protocol as never,
        });
        return reply
          .code(result.created ? 201 : 200)
          .send({
            workflow: serializeWorkflow(result.workflow),
            initialVersion: serializeVersion(result.initialVersion),
            created: result.created,
          });
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    });
  });

  // --- list the tenant's workflows --------------------------------------------

  app.get('/organizations/:orgId/workflow-repository/workflows', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      try {
        const workflows = await service.listWorkflowsInOrganization(
          { userId: user.id },
          orgId,
        );
        return { workflows: workflows.map(serializeWorkflow) };
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    });
  });

  // --- read one workflow --------------------------------------------------------

  app.get('/workflow-repository/workflows/:workflowId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { workflowId } = req.params as { workflowId: string };
      try {
        const workflow = await service.getWorkflow({ userId: user.id }, workflowId);
        return { workflow: serializeWorkflow(workflow) };
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    });
  });

  // --- update repository metadata (owner-only; never versions) ------------------

  app.patch('/workflow-repository/workflows/:workflowId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { workflowId } = req.params as { workflowId: string };
      const body = req.body as Record<string, unknown> | null;
      const patch: Record<string, unknown> = {};
      if (body?.name !== undefined) patch.name = body.name;
      if (body?.description !== undefined) patch.description = body.description;
      if (body?.visibility !== undefined) patch.visibility = body.visibility;
      try {
        const workflow = await service.updateWorkflow(
          { userId: user.id },
          workflowId,
          patch as never,
        );
        return { workflow: serializeWorkflow(workflow) };
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    });
  });

  // --- create a NEW immutable version ("edit"; owner-only) ----------------------

  app.post('/workflow-repository/workflows/:workflowId/versions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { workflowId } = req.params as { workflowId: string };
      const body = req.body as Record<string, unknown> | null;
      if (!body || body.content === undefined || !isRecord(body.protocol)) {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'content and protocol are required',
        });
      }
      const parentVersionId =
        typeof body.parentVersionId === 'string' ? body.parentVersionId : undefined;
      try {
        const result = await service.createVersion({ userId: user.id }, workflowId, {
          content: body.content as Record<string, unknown>,
          protocol: body.protocol as never,
          parentVersionId,
        });
        return reply
          .code(result.created ? 201 : 200)
          .send({ version: serializeVersion(result.version), created: result.created });
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    });
  });

  // --- list the workflow's versions ----------------------------------------------

  app.get('/workflow-repository/workflows/:workflowId/versions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { workflowId } = req.params as { workflowId: string };
      try {
        const versions = await service.listVersions({ userId: user.id }, workflowId);
        return { versions: versions.map(serializeVersion) };
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    });
  });

  // --- read one exact immutable version (NO mutation route exists — R6) ---------

  app.get(
    '/workflow-repository/workflows/:workflowId/versions/:versionId',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const user = await requireUser(req, reply);
        const { workflowId, versionId } = req.params as {
          workflowId: string;
          versionId: string;
        };
        try {
          const version = await service.getVersion(
            { userId: user.id },
            workflowId,
            versionId,
          );
          return { version: serializeVersion(version) };
        } catch (err) {
          return sendRepositoryError(reply, err);
        }
      });
    },
  );

  // --- fork a visible source version into the caller's tenant -------------------

  app.post('/organizations/:orgId/workflow-repository/forks', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.sourceWorkflowId !== 'string' ||
        typeof body.sourceVersionId !== 'string' ||
        typeof body.slug !== 'string'
      ) {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'sourceWorkflowId, sourceVersionId and slug are required',
        });
      }
      const name = typeof body.name === 'string' ? body.name : undefined;
      const description =
        typeof body.description === 'string' ? body.description : undefined;
      const visibility =
        typeof body.visibility === 'string' ? (body.visibility as never) : undefined;
      try {
        const result = await service.forkWorkflow({ userId: user.id }, {
          organizationId: orgId,
          sourceWorkflowId: body.sourceWorkflowId,
          sourceVersionId: body.sourceVersionId,
          slug: body.slug,
          name,
          description,
          visibility,
        });
        return reply
          .code(result.created ? 201 : 200)
          .send({
            workflow: serializeWorkflow(result.workflow),
            initialVersion: {
              ...serializeVersion(result.initialVersion),
              created: result.initialVersion.created,
            },
            created: result.created,
          });
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    });
  });

  // --- install ONE EXACT version (the pin) ----------------------------------------

  app.post('/organizations/:orgId/workflow-repository/installations', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.workflowId !== 'string' ||
        typeof body.versionId !== 'string'
      ) {
        return reply.code(400).send({
          error: 'invalid-request',
          message: 'workflowId and versionId are required',
        });
      }
      try {
        const result = await service.installVersion({ userId: user.id }, {
          organizationId: orgId,
          workflowId: body.workflowId,
          versionId: body.versionId,
        });
        return reply
          .code(result.created ? 201 : 200)
          .send({
            installation: serializeInstallation(result.installation),
            created: result.created,
          });
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    });
  });

  // --- list the tenant's installations (with pinned versions) ---------------------

  app.get('/organizations/:orgId/workflow-repository/installations', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { orgId } = req.params as { orgId: string };
      try {
        const installations = await service.listInstallations({ userId: user.id }, orgId);
        return { installations: installations.map(serializeInstallationDetail) };
      } catch (err) {
        return sendRepositoryError(reply, err);
      }
    });
  });

  // --- read one installation (pinned version resolved) ------------------------------

  app.get(
    '/organizations/:orgId/workflow-repository/installations/:installationId',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const user = await requireUser(req, reply);
        const { orgId, installationId } = req.params as {
          orgId: string;
          installationId: string;
        };
        try {
          const detail = await service.getInstallation(
            { userId: user.id },
            orgId,
            installationId,
          );
          return serializeInstallationDetail(detail);
        } catch (err) {
          return sendRepositoryError(reply, err);
        }
      });
    },
  );

  // --- installation lifecycle (never touches any version) ----------------------------

  const lifecycle = (action: WorkflowInstallationAction) => {
    return async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      return runAuthed(req, async () => {
        const user = await requireUser(req, reply);
        const { orgId, installationId } = req.params as {
          orgId: string;
          installationId: string;
        };
        try {
          const installation = await service.setInstallationStatus(
            { userId: user.id },
            orgId,
            installationId,
            action,
          );
          return { installation: serializeInstallation(installation) };
        } catch (err) {
          return sendRepositoryError(reply, err);
        }
      });
    };
  };

  app.post(
    '/organizations/:orgId/workflow-repository/installations/:installationId/enable',
    lifecycle('enable'),
  );
  app.post(
    '/organizations/:orgId/workflow-repository/installations/:installationId/disable',
    lifecycle('disable'),
  );
  app.post(
    '/organizations/:orgId/workflow-repository/installations/:installationId/uninstall',
    lifecycle('uninstall'),
  );
}
