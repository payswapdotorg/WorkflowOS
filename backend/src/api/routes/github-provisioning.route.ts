import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  GitHubAdapter,
  GitHubInstallationRepository,
  ProjectGitHubRepository,
  ProjectGitHubRepositoryRepository,
  CreateRepositoryResult,
} from '@modules/github/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * WORK-026 (SUB-F): /github provisioning routes — surface the GitHub App
 * repository-provisioning capability (SUB-C) over HTTP.
 *
 * Route surface (PLAN-1 §3.4):
 *   POST /projects/:projectId/github/repository — create a GitHub repo (project.write)
 *   POST /projects/:projectId/github/link        — link an existing repo (project.write)
 *   GET  /projects/:projectId/github/repository  — read the association (project.read)
 *   GET  /projects/:projectId/github/health     — githubAdapter.health() (project.read)
 *
 * The route is THIN: it delegates to `githubAdapter.createRepository()` (the
 * ONLY GitHub SDK caller — enforced by the SUB-C static-architecture check)
 * and persists the association via `projectGitHubRepositoryRepository.create()`.
 * Secrets never cross this boundary — the GitHub App private key stays inside
 * the adapter (resolved by the composition root via the SecretStore).
 *
 * Failure modes:
 *   - 'github-not-configured' (502): the production adapter throws because
 *     GITHUB_APP_PRIVATE_KEY is not set. The route returns 502 with a clear
 *     hint so the operator can wire the credentials.
 *   - 'github-provider-error' (503): the adapter threw a non-configuration
 *     error (e.g. rate limit, network). The route surfaces the message.
 *   - 'installation-not-found' (400): the supplied installationId is not
 *     linked to the project (no row in wfos_github_installations).
 */
export interface GithubProvisioningRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  githubAdapter: GitHubAdapter;
  projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository;
  /** Used to validate the supplied installationId belongs to the project. */
  githubInstallationRepository: GitHubInstallationRepository;
}

/**
 * Map a GitHub adapter error to an HTTP status code + a public-facing error
 * payload (the secret is stripped — only the message classification surfaces).
 */
function classifyGithubError(err: Error): {
  code: number;
  body: Record<string, unknown>;
} {
  const msg = err.message ?? '';
  if (msg.includes('github-not-configured')) {
    return {
      code: 502,
      body: {
        error: 'github-not-configured',
        hint: 'Set GITHUB_APP_PRIVATE_KEY + GITHUB_APP_ID + GITHUB_INSTALLATION_ID env vars to enable GitHub write operations',
      },
    };
  }
  return {
    code: 503,
    body: {
      error: 'github-provider-error',
      message: msg.slice(0, 500),
    },
  };
}

export async function githubProvisioningRoutes(
  app: FastifyInstance,
  deps: GithubProvisioningRouteDeps,
): Promise<void> {
  // POST /projects/:projectId/github/repository — create a GitHub repository.
  // Body: { owner, repository, visibility, description?, defaultBranch?,
  // installationId }.
  //
  // Flow:
  //   1. Resolve the installation for the project (validate it exists).
  //   2. Call githubAdapter.createRepository() — the only GitHub SDK caller.
  //   3. Persist the association via projectGitHubRepositoryRepository.create()
  //      with linkType: 'created'.
  //   4. Return { repository, github } where `github` is the CreateRepositoryResult.
  app.post('/projects/:projectId/github/repository', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        owner?: string;
        repository?: string;
        visibility?: 'public' | 'private';
        description?: string;
        defaultBranch?: string;
        installationId?: string;
      };
      if (!body?.owner || !body?.repository || !body?.installationId) {
        return reply.code(400).send({
          error: 'owner, repository, and installationId required',
        });
      }
      const project = await deps.projectRepository.findById(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'project-not-found' });
      }
      // Verify the installation belongs to this project (defensive — the
      // adapter itself does not enforce the project/installation link).
      const installations =
        await deps.githubInstallationRepository.findByProject(projectId);
      const installation = installations.find(
        (i) => i.installationId === body.installationId,
      );
      if (!installation) {
        return reply.code(400).send({
          error: 'installation-not-found',
          installationId: body.installationId,
          projectId,
        });
      }
      let githubResult: CreateRepositoryResult;
      try {
        githubResult = await deps.githubAdapter.createRepository({
          owner: body.owner,
          repository: body.repository,
          visibility: body.visibility ?? 'private',
          description: body.description,
          defaultBranch: body.defaultBranch,
          installationId: body.installationId,
        });
      } catch (err) {
        const { code, body: errBody } = classifyGithubError(err as Error);
        return reply.code(code).send(errBody);
      }
      // Persist the association. linkType: 'created' indicates WorkflowOS
      // provisioned the repo. Idempotent on (project, installation, owner,
      // repository) — re-POSTing returns the existing row.
      const record: ProjectGitHubRepository =
        await deps.projectGitHubRepositoryRepository.create({
          projectId,
          installationId: body.installationId,
          owner: githubResult.owner,
          repository: githubResult.repository,
          defaultBranch: githubResult.defaultBranch,
          linkType: 'created',
          externalRepoId: githubResult.externalRepoId,
          metadata: {
            url: githubResult.url,
            description: body.description ?? null,
            visibility: body.visibility ?? 'private',
          },
        });
      return reply.code(201).send({
        repository: record,
        github: githubResult,
      });
    });
  });

  // POST /projects/:projectId/github/link — link an existing GitHub repo.
  // Body: { owner, repository, installationId, defaultBranch? }.
  //
  // Same as the create flow but does NOT call the GitHub adapter — it just
  // records the association (linkType: 'linked'). Used when the operator has
  // created the repo out-of-band and wants to attach it to the project.
  app.post('/projects/:projectId/github/link', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        owner?: string;
        repository?: string;
        installationId?: string;
        defaultBranch?: string;
      };
      if (!body?.owner || !body?.repository || !body?.installationId) {
        return reply.code(400).send({
          error: 'owner, repository, and installationId required',
        });
      }
      const project = await deps.projectRepository.findById(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'project-not-found' });
      }
      // Verify the installation belongs to the project.
      const installations =
        await deps.githubInstallationRepository.findByProject(projectId);
      const installation = installations.find(
        (i) => i.installationId === body.installationId,
      );
      if (!installation) {
        return reply.code(400).send({
          error: 'installation-not-found',
          installationId: body.installationId,
          projectId,
        });
      }
      const record: ProjectGitHubRepository =
        await deps.projectGitHubRepositoryRepository.create({
          projectId,
          installationId: body.installationId,
          owner: body.owner,
          repository: body.repository,
          defaultBranch: body.defaultBranch,
          linkType: 'linked',
        });
      return reply.code(201).send({ repository: record });
    });
  });

  // GET /projects/:projectId/github/repository — read the association.
  // Returns the (first) GitHub repo link for the project, or null when none.
  app.get('/projects/:projectId/github/repository', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const repository =
        await deps.projectGitHubRepositoryRepository.findByProject(projectId);
      return { repository };
    });
  });

  // GET /projects/:projectId/github/health — calls githubAdapter.health().
  // Returns { status: 'connected' | 'not-configured' | 'error' | 'test-mode' }.
  app.get('/projects/:projectId/github/health', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const status = await deps.githubAdapter.health();
      return { status };
    });
  });
}
