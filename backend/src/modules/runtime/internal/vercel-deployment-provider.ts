/**
 * WORK-026: Vercel deployment provider adapter.
 *
 * Concrete {@link DeploymentProvider} that talks to the Vercel REST API via
 * the global `fetch()` (Node 24 ships it natively — no SDK dependency).
 *
 * Activation rules:
 *   - When `apiToken` is present (constructor arg or `VERCEL_API_TOKEN` env),
 *     `health()` reports `'connected'` and all write/read methods perform
 *     real HTTP calls against `${baseUrl}` (default: `https://api.vercel.com`).
 *   - When `apiToken` is absent, `health()` reports `'not-configured'`, and
 *     write methods (`createProject`, `linkRepository`) throw
 *     `Error('vercel-not-configured')`. Read methods (`getDeployment`,
 *     `getPreviewUrl`, `getDeploymentStatus`) return `null` (the caller —
 *     typically the runtime status service — interprets `null` as
 *     "no deployment recorded").
 *
 * Secrets never cross this boundary: the token stays inside this adapter; it
 * is only used to set the `Authorization` header for outbound requests.
 *
 * All HTTP errors are caught and rethrown as `Error('vercel-error: ...')` so
 * the deployment service / composition root can normalize provider failures
 * without leaking the underlying fetch implementation.
 *
 * This file is private to /runtime (PLAT-AC-02). No `@octokit/*` /
 * `@vercel/*` SDK may be imported here (static-architecture test enforces).
 */
import type {
  Deployment,
  DeploymentProvider,
  DeploymentStatus,
  GetDeploymentInput,
  LinkRepositoryInput,
} from './runtime.types.js';

export interface VercelDeploymentProviderOptions {
  /** Vercel API token. Defaults to `process.env.VERCEL_API_TOKEN`. */
  apiToken?: string;
  /** Vercel team id (scopes all requests to a team). Defaults to `VERCEL_TEAM_ID`. */
  teamId?: string;
  /** Vercel API base URL. Defaults to `https://api.vercel.com`. */
  baseUrl?: string;
}

interface VercelProjectResponse {
  id?: string;
  name?: string;
  accountId?: string;
  framework?: string | null;
  [k: string]: unknown;
}

interface VercelDeploymentResponse {
  uid?: string;
  id?: string;
  name?: string;
  url?: string;
  readyState?: string;
  state?: string;
  status?: string;
  meta?: {
    githubCommitSha?: string;
    githubCommitRef?: string;
    [k: string]: unknown;
  };
  createdAt?: number;
  ready?: boolean;
  [k: string]: unknown;
}

interface VercelDeploymentsListResponse {
  deployments?: VercelDeploymentResponse[];
  [k: string]: unknown;
}

const DEFAULT_BASE_URL = 'https://api.vercel.com';

export class VercelDeploymentProvider implements DeploymentProvider {
  readonly name = 'vercel';
  private readonly apiToken: string | undefined;
  private readonly teamId: string | undefined;
  private readonly baseUrl: string;

  constructor(opts: VercelDeploymentProviderOptions = {}) {
    this.apiToken = opts.apiToken ?? process.env.VERCEL_API_TOKEN;
    this.teamId = opts.teamId ?? process.env.VERCEL_TEAM_ID;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  async health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'> {
    return this.apiToken ? 'connected' : 'not-configured';
  }

  async createProject(input: {
    projectId: string;
    name: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ projectExternalId: string; metadata: Record<string, unknown> }> {
    if (!this.apiToken) throw new Error('vercel-not-configured');
    const body: Record<string, unknown> = {
      name: input.name,
      ...(input.metadata ?? {}),
    };
    const data = await this.request<VercelProjectResponse>(
      'POST',
      '/v13/projects',
      body,
    );
    if (!data.id) {
      throw new Error('vercel-error: createProject response missing id');
    }
    return {
      projectExternalId: data.id,
      metadata: {
        ...(input.metadata ?? {}),
        vercel: data,
        projectId: input.projectId,
        name: input.name,
      },
    };
  }

  async linkRepository(
    input: LinkRepositoryInput,
  ): Promise<{ projectExternalId: string; metadata: Record<string, unknown> }> {
    if (!this.apiToken) throw new Error('vercel-not-configured');
    // Create a new Vercel project with the GitHub repo linked at creation
    // time (POST /v13/projects with a `link` payload). The LinkRepositoryInput
    // interface carries no projectExternalId — by Vercel API design, repo
    // linking at project-creation time is the canonical flow. The runtime
    // integration row is then created by the DeploymentService.
    const projectName = input.repositoryRef.split('/')[1] ?? input.projectId.slice(0, 8);
    const link: Record<string, unknown> = {
      type: 'github',
      repo: input.repositoryRef,
    };
    if (input.branch) link['target'] = input.branch;
    const body: Record<string, unknown> = {
      name: projectName,
      link,
      ...(input.metadata ?? {}),
    };
    const data = await this.request<VercelProjectResponse>(
      'POST',
      '/v13/projects',
      body,
    );
    if (!data.id) {
      throw new Error('vercel-error: linkRepository response missing id');
    }
    return {
      projectExternalId: data.id,
      metadata: {
        ...(input.metadata ?? {}),
        vercel: data,
        projectId: input.projectId,
        linkedRepo: input.repositoryRef,
        branch: input.branch ?? null,
      },
    };
  }

  async getDeployment(input: GetDeploymentInput): Promise<Deployment | null> {
    if (!this.apiToken) return null;
    const query: Record<string, string> = { limit: '1' };
    if (input.commitSha) query['sha'] = input.commitSha;
    if (input.branch) query['branch'] = input.branch;
    const data = await this.request<VercelDeploymentsListResponse>(
      'GET',
      '/v6/deployments',
      undefined,
      query,
    );
    const first = data.deployments?.[0];
    if (!first) return null;
    return mapVercelDeployment(first, input);
  }

  async getPreviewUrl(input: {
    projectId: string;
    commitSha?: string;
    branch?: string;
  }): Promise<string | null> {
    const dep = await this.getDeployment(input);
    return dep?.previewUrl ?? null;
  }

  async getDeploymentStatus(input: GetDeploymentInput): Promise<DeploymentStatus | null> {
    const dep = await this.getDeployment(input);
    return dep?.status ?? null;
  }

  // ---------------------------------------------------------------------
  // Internal HTTP helper.
  // ---------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (this.teamId) url.searchParams.set('teamId', this.teamId);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(url.toString(), init);
    } catch (err) {
      throw new Error(`vercel-error: network: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new Error(
        `vercel-error: HTTP ${res.status}: ${errorBody.slice(0, 500)}`,
      );
    }
    if (res.status === 204) return undefined as unknown as T;
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new Error(`vercel-error: invalid JSON: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapVercelDeployment(
  v: VercelDeploymentResponse,
  input: GetDeploymentInput,
): Deployment {
  const uid = v.uid ?? v.id ?? 'unknown';
  const rawState = (v.readyState ?? v.state ?? v.status ?? '').toUpperCase();
  const createdAt = v.createdAt
    ? new Date(typeof v.createdAt === 'number' ? v.createdAt : Date.parse(String(v.createdAt)))
    : new Date(0);
  const previewUrl = v.url ? `https://${v.url}` : null;
  const commitSha = v.meta?.githubCommitSha ?? input.commitSha ?? null;
  const branch = v.meta?.githubCommitRef ?? input.branch ?? null;
  return {
    id: uid,
    // The provider layer does not know the DB integration id; callers that
    // need the persisted integration id should use DeploymentRepository. This
    // is a transient lookup view (used by getPreviewUrl/getDeploymentStatus).
    integrationId: '',
    externalId: uid,
    status: mapVercelStatus(rawState),
    previewUrl,
    commitSha,
    branch,
    metadata: { vercel: v, source: 'vercel-provider-lookup' },
    createdAt,
    updatedAt: createdAt,
  };
}

function mapVercelStatus(rawState: string): DeploymentStatus {
  switch (rawState) {
    case 'QUEUED':
      return 'queued';
    case 'BUILDING':
    case 'INITIALIZING':
      return 'building';
    case 'NORMAL':
    case 'READY':
      return 'ready';
    case 'ERROR':
    case 'FAILED':
      return 'error';
    case 'CANCELED':
    case 'CANCELLED':
      return 'canceled';
    default:
      return 'building';
  }
}
