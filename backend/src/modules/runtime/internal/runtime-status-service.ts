/**
 * WORK-026: Default {@link RuntimeStatusService} — aggregates GitHub +
 * Vercel + Architect + Agent status for a single WorkflowOS project.
 *
 * Boundary design (PLAN-1 Decision F):
 *   - This service MUST NOT import from `/github`, `/llm`, or `/agents`
 *     internal/. Reading their state would force a circular module dependency
 *     and break the static-architecture invariants (PLAT-AC-02).
 *   - Instead, the composition root injects optional resolver callbacks. Each
 *     resolver returns the per-dimension status for a project. If a resolver
 *     is absent, the corresponding dimension reports `'not-configured'`. If a
 *     resolver throws, the dimension reports `'error'` (for github/vercel) or
 *     `'not-configured'` (for architect/agent — the ProjectRuntimeStatus
 *     shape does not permit 'error' there).
 *
 * This keeps the boundary clean: /runtime stays the SINGLE owner of the
 * `ProjectRuntimeStatus` aggregation; the other modules stay owners of their
 * own state. Secrets never cross this boundary — resolvers return readiness
 * metadata only.
 *
 * This file is private to /runtime (PLAT-AC-02).
 */
import type { Logger } from '@platform/logger.js';
import type {
  Deployment,
  ProjectRuntimeStatus,
  RuntimeStatusService,
} from './runtime.types.js';

// ---------------------------------------------------------------------------
// Resolver contracts — mirror the sub-shapes of ProjectRuntimeStatus so the
// composition root can pass typed callbacks without /runtime depending on
// /github, /llm, or /agents internals.
// ---------------------------------------------------------------------------

export interface GithubRuntimeStatus {
  status: 'connected' | 'not-configured' | 'error' | 'test-mode';
  owner?: string;
  repository?: string;
  defaultBranch?: string | null;
}

export interface VercelRuntimeStatus {
  status: 'connected' | 'not-configured' | 'error' | 'test-mode';
  projectId?: string;
  previewUrl?: string | null;
  latestDeployment?: Deployment | null;
}

export interface ProviderRuntimeStatus {
  name: string;
  provider: string;
  model: string;
  status: 'ready' | 'not-configured';
}

export interface ArchitectRuntimeStatus {
  status: 'connected' | 'not-configured' | 'test-mode';
  providers: ProviderRuntimeStatus[];
}

export interface AgentRuntimeStatus {
  status: 'connected' | 'not-configured' | 'test-mode';
  providers: ProviderRuntimeStatus[];
}

export interface RuntimeStatusResolvers {
  resolveGithub?(projectId: string): Promise<GithubRuntimeStatus>;
  resolveVercel?(projectId: string): Promise<VercelRuntimeStatus>;
  resolveArchitect?(projectId: string): Promise<ArchitectRuntimeStatus>;
  resolveAgent?(projectId: string): Promise<AgentRuntimeStatus>;
}

const NOT_CONFIGURED_GITHUB: GithubRuntimeStatus = { status: 'not-configured' };
const NOT_CONFIGURED_VERCEL: VercelRuntimeStatus = {
  status: 'not-configured',
  latestDeployment: null,
};
const NOT_CONFIGURED_ARCHITECT: ArchitectRuntimeStatus = {
  status: 'not-configured',
  providers: [],
};
const NOT_CONFIGURED_AGENT: AgentRuntimeStatus = {
  status: 'not-configured',
  providers: [],
};

export class DefaultRuntimeStatusService implements RuntimeStatusService {
  constructor(
    private readonly resolvers: RuntimeStatusResolvers,
    private readonly logger: Logger,
  ) {}

  async getStatus(projectId: string): Promise<ProjectRuntimeStatus> {
    const [github, vercel, architect, agent] = await Promise.all([
      this.resolveGithub(projectId),
      this.resolveVercel(projectId),
      this.resolveArchitect(projectId),
      this.resolveAgent(projectId),
    ]);
    return { github, vercel, architect, agent };
  }

  // -------------------------------------------------------------------

  private async resolveGithub(projectId: string): Promise<GithubRuntimeStatus> {
    if (!this.resolvers.resolveGithub) return NOT_CONFIGURED_GITHUB;
    try {
      return await this.resolvers.resolveGithub(projectId);
    } catch (err) {
      this.logger.warn('runtime.status.github-error', {
        projectId,
        error: (err as Error).message,
      });
      return { status: 'error' };
    }
  }

  private async resolveVercel(projectId: string): Promise<VercelRuntimeStatus> {
    if (!this.resolvers.resolveVercel) return NOT_CONFIGURED_VERCEL;
    try {
      return await this.resolvers.resolveVercel(projectId);
    } catch (err) {
      this.logger.warn('runtime.status.vercel-error', {
        projectId,
        error: (err as Error).message,
      });
      return { status: 'error', latestDeployment: null };
    }
  }

  private async resolveArchitect(
    projectId: string,
  ): Promise<ArchitectRuntimeStatus> {
    if (!this.resolvers.resolveArchitect) return NOT_CONFIGURED_ARCHITECT;
    try {
      return await this.resolvers.resolveArchitect(projectId);
    } catch (err) {
      // ProjectRuntimeStatus.architect does not permit 'error'; degrade to
      // 'not-configured' with an empty provider list.
      this.logger.warn('runtime.status.architect-error', {
        projectId,
        error: (err as Error).message,
      });
      return NOT_CONFIGURED_ARCHITECT;
    }
  }

  private async resolveAgent(projectId: string): Promise<AgentRuntimeStatus> {
    if (!this.resolvers.resolveAgent) return NOT_CONFIGURED_AGENT;
    try {
      return await this.resolvers.resolveAgent(projectId);
    } catch (err) {
      this.logger.warn('runtime.status.agent-error', {
        projectId,
        error: (err as Error).message,
      });
      return NOT_CONFIGURED_AGENT;
    }
  }
}
