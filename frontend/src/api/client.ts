/**
 * API client for the WorkflowOS backend (WORK-022).
 *
 * The frontend is a CONSUMER — it never owns authoritative state.
 * All data comes from backend API responses.
 *
 * WORK-023: all API calls are prefixed with `/api` so the nginx reverse proxy
 * (production) and the Vite dev proxy (development) can distinguish API
 * requests from SPA client-side routes. Both proxies strip the `/api` prefix
 * before forwarding to the backend (whose routes are at the root:
 * /projects/:id, /health, etc.).
 *
 * WORK-022 product UI: the client surface has been extended to cover the
 * full WorkflowOS lifecycle (organizations, projects, repositories,
 * architectures + versions + ADRs + change requests, requirements +
 * criteria, work items + work orders + PR associations + dependencies,
 * workflow convergence + signals, verification runs + evidence + mappings,
 * reviews + findings, agent runs, audit, notifications). Every mutating
 * call delegates to a backend route — the frontend never derives state,
 * evaluates evidence, or decides authorization.
 *
 * UI2-AC-01 (PR #21 correction): the verification surface fetches ACTUAL
 * VerificationRun + Evidence records from /verification, NOT workflow-convergence
 * metadata. The previous implementation substituted the convergence status
 * endpoint for verification data, which did not satisfy UI2-AC-01.
 */

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'same-origin' });
  if (res.status === 401) {
    // The backend is the authority: a 401 transitions the whole app to
    // unauthenticated (the canonical auth-state source observes it).
    auth.handleUnauthorized();
    throw new ApiError(401, 'Authentication required');
  }
  if (res.status === 403) {
    throw new ApiError(403, 'Not authorized');
  }
  if (res.status === 404) {
    throw new ApiError(404, 'Not found');
  }
  if (res.status === 409) {
    const body = await res.json();
    throw new ApiError(409, body.reason || body.error || 'Conflict');
  }
  if (res.status >= 400) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || body.reason || `Error ${res.status}`);
  }
  return res;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
  // Some 202/204 responses may have empty bodies.
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: 'PATCH',
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

// --- Auth (WORK-074: session-based; the ONE canonical frontend auth-state source) ---

/**
 * The canonical auth-state source (the WORK-022/WORK-072 state-ownership
 * pattern carrying WORK-074's real login). ONE observable client holds the
 * auth state; every consumer — including the App shell — observes the SAME
 * state synchronously, so a successful sign-in makes the protected routes
 * visible WITHOUT a manual reload.
 *
 * State-ownership discipline (WORK-063 / WORK-074):
 *   - the frontend state is a CACHE of "who is signed in" as reported by the
 *     backend (`GET /auth/session`) — it is NEVER an authorization decision
 *     (the WORK-022 invariant holds: a 401/403 from the backend is the
 *     authority, and a 401 transitions the state to unauthenticated);
 *   - the session token lives ONLY in an HttpOnly cookie — no JS-readable
 *     storage ever holds credential material;
 *   - there is NO second auth store (the old per-instance `useState` API-key
 *     pattern and the demo-key localStorage path are retired).
 */
export interface SessionUser {
  id: string;
  displayName: string;
  email: string | null;
}

export interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  user: SessionUser | null;
}

export interface LoginProviderInfo {
  id: 'google' | 'github';
  configured: boolean;
}

type AuthListener = () => void;

class AuthClient {
  private state: AuthState = { status: 'loading', user: null };
  private readonly listeners = new Set<AuthListener>();

  /** useSyncExternalStore subscription. */
  subscribe = (listener: AuthListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** useSyncExternalStore snapshot (stable identity until the state changes). */
  getSnapshot = (): AuthState => this.state;

  private setState(next: AuthState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /**
   * Read the session from the backend (whoami). Called once at app mount:
   * after a full page reload the protected routes remain visible when a valid
   * session cookie exists (refresh persistence).
   */
  async fetchSession(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/auth/session`, { credentials: 'same-origin' });
      if (res.ok) {
        const body = (await res.json()) as { user: SessionUser };
        this.setState({ status: 'authenticated', user: body.user });
        return;
      }
    } catch {
      // Network failure → unauthenticated (the login page is the honest state).
    }
    this.setState({ status: 'unauthenticated', user: null });
  }

  async loginWithPassword(email: string, password: string): Promise<SessionUser> {
    const res = await fetch(`${API_BASE}/auth/password/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === 'invalid-credentials') {
        throw new ApiError(401, 'Invalid email or password.');
      }
      throw new ApiError(res.status, body.error ?? `Error ${res.status}`);
    }
    const body = (await res.json()) as { user: SessionUser };
    this.setState({ status: 'authenticated', user: body.user });
    return body.user;
  }

  async registerWithPassword(email: string, password: string, displayName?: string): Promise<SessionUser> {
    const res = await fetch(`${API_BASE}/auth/password/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, password, displayName }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      const messages: Record<string, string> = {
        'email-taken': 'An account with this email already exists. Try signing in.',
        'weak-password': 'The password must be at least 8 characters.',
        'invalid-email': 'That email address does not look valid.',
      };
      throw new ApiError(res.status, messages[body.error ?? ''] ?? body.message ?? body.error ?? `Error ${res.status}`);
    }
    const body = (await res.json()) as { user: SessionUser };
    this.setState({ status: 'authenticated', user: body.user });
    return body.user;
  }

  /** Which human login providers are configured (the UI renders the honest state). */
  async fetchProviders(): Promise<LoginProviderInfo[]> {
    const body = await apiGet<{ providers: LoginProviderInfo[] }>('/auth/providers');
    return body.providers ?? [];
  }

  /** Begin the OAuth journey: returns the provider's authorization URL to redirect to. */
  async startOAuth(provider: 'google' | 'github', redirectTo = '/'): Promise<string> {
    const body = await apiGet<{ authorizeUrl: string }>(
      `/auth/oauth/${provider}/start?redirectTo=${encodeURIComponent(redirectTo)}`,
    );
    return body.authorizeUrl;
  }

  /** Logout: revoke the server-side session and clear the cookie. */
  async logout(): Promise<void> {
    try {
      await fetch(`${API_BASE}/auth/session/logout`, {
        method: 'POST',
        credentials: 'same-origin',
      });
    } finally {
      this.clearLocalSession();
    }
  }

  /** The backend is the authority: a 401 from ANY api call lands here. */
  handleUnauthorized(): void {
    if (this.state.status !== 'unauthenticated') {
      this.clearLocalSession();
    }
  }

  private clearLocalSession(): void {
    // Best-effort cookie cleanup for stale cookies — the server has already
    // revoked the session; the HttpOnly cookie is cleared server-side too.
    document.cookie = 'wfos_session=; Path=/; Max-Age=0';
    this.setState({ status: 'unauthenticated', user: null });
  }
}

export const auth = new AuthClient();

// --- Organizations ---

export interface Organization {
  id: string;
  name: string;
  /** Caller's role on this org (returned by GET /organizations). Optional —
   *  absent when fetched by id rather than via the list-for-user endpoint. */
  roleId?: string;
  createdAt?: string;
}

export const organizations = {
  listForUser: async (): Promise<Organization[]> => {
    const body = await apiGet<{ organizations: Organization[] }>(`/organizations`);
    return body.organizations ?? [];
  },
};

// --- V2 product reads (consume-only: existing public routes) ---
// T2 (V2-017): the workflow-first Home reads the organization's workflows
// (the V2-002 repository route) and runs (the V2-005 runs route). These are
// READS of existing public authorities — no second workflow model, no
// client-side authority, no mutation surface. Failed reads throw (the
// honest-error contract); the caller decides how to present each state.

export interface ProductWorkflow {
  id: string;
  organizationId: string;
  ownerUserId: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: string;
  headVersionId: string | null;
  forkedFromWorkflowId: string | null;
  forkedFromVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductWorkflowRun {
  id: string;
  organizationId: string;
  workflowId: string;
  versionId: string;
  installationId: string | null;
  trigger: unknown;
  triggeredByUserId: string | null;
  inputCommitments: string[];
  inputDigest: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export const workflowRuns = {
  /** The organization's runs (V2-005 read — the tenant's run list). */
  listForOrganization: async (organizationId: string): Promise<ProductWorkflowRun[]> => {
    const body = await apiGet<{ runs: ProductWorkflowRun[] }>(
      `/organizations/${organizationId}/workflow-runs/runs`,
    );
    return body.runs ?? [];
  },
};

// T3 (V2-017): the workflow library reads the tenant's installations with
// their pinned versions (the V2-002 repository route) plus the deployments
// and per-deployment trigger subscriptions (the workflow-deployments routes
// — placement/environment, enable state, schedule/event facts). These are
// READS of existing public authorities — consume-only, no second workflow
// model, no mutation surface. Failed reads throw (the honest-error
// contract); the caller aggregates with all-or-error semantics.

/** One installation with its pinned version resolved (the V2-002 detail). */
export interface ProductInstallation {
  id: string;
  organizationId: string;
  workflowId: string;
  versionId: string;
  installedByUserId: string;
  status: string;
  installedAt: string;
  updatedAt: string;
}

/** The immutable version an installation pins (never auto-updates). */
export interface ProductPinnedVersion {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  protocol: unknown;
}

export interface ProductInstallationDetail {
  installation: ProductInstallation;
  pinnedVersion: ProductPinnedVersion;
}

/** The execution placement policy (V2-004's contracts, consumed verbatim). */
export interface ProductPlacementPolicy {
  placement: { required: string; fallbackOrder?: string[] };
  privacy: { localOnly: boolean };
}

export interface ProductDeployment {
  id: string;
  organizationId: string;
  workflowId: string;
  versionId: string;
  installationId: string | null;
  name: string;
  description: string | null;
  placement: ProductPlacementPolicy;
  enabled: boolean;
  enabledAt: string | null;
  disabledAt: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** One trigger subscription attached to a deployment (schedule or event). */
export interface ProductTriggerSubscription {
  id: string;
  organizationId: string;
  deploymentId: string;
  kind: string;
  schedule: unknown;
  eventPattern: unknown;
  deliveryPolicy: unknown;
  enabled: boolean;
  cursor: unknown;
  createdAt: string;
  updatedAt: string;
}

export const workflowRepository = {
  /** The organization's workflows visible to the caller (V2-002 read). */
  listForOrganization: async (organizationId: string): Promise<ProductWorkflow[]> => {
    const body = await apiGet<{ workflows: ProductWorkflow[] }>(
      `/organizations/${organizationId}/workflow-repository/workflows`,
    );
    return body.workflows ?? [];
  },

  /** One workflow (visibility-checked; the V2-002 read). */
  get: async (workflowId: string): Promise<ProductWorkflow> => {
    const body = await apiGet<{ workflow: ProductWorkflow }>(
      `/workflow-repository/workflows/${workflowId}`,
    );
    return body.workflow;
  },

  /** The workflow's immutable versions in stable order (V2-002 read). */
  listVersionsForWorkflow: async (workflowId: string): Promise<ProductWorkflowVersion[]> => {
    const body = await apiGet<{ versions: ProductWorkflowVersion[] }>(
      `/workflow-repository/workflows/${workflowId}/versions`,
    );
    return body.versions ?? [];
  },

  /** The tenant's installations with their pinned versions (V2-002 read). */
  listInstallationsForOrganization: async (
    organizationId: string,
  ): Promise<ProductInstallationDetail[]> => {
    const body = await apiGet<{ installations: ProductInstallationDetail[] }>(
      `/organizations/${organizationId}/workflow-repository/installations`,
    );
    return body.installations ?? [];
  },
};

/** An immutable workflow version (the V2-002 wire shape). */
export interface ProductWorkflowVersion {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: unknown;
  protocol: unknown;
  parentVersionId: string | null;
  createdByUserId: string;
  createdAt: string;
}

export const workflowDeployments = {
  /** The organization's deployments — placement and enable state (read). */
  listForOrganization: async (organizationId: string): Promise<ProductDeployment[]> => {
    const body = await apiGet<{ deployments: ProductDeployment[] }>(
      `/organizations/${organizationId}/workflow-deployments/deployments`,
    );
    return body.deployments ?? [];
  },

  /** One deployment's trigger subscriptions (schedule/event facts). */
  listSubscriptionsForDeployment: async (
    deploymentId: string,
  ): Promise<ProductTriggerSubscription[]> => {
    const body = await apiGet<{ subscriptions: ProductTriggerSubscription[] }>(
      `/workflow-deployments/deployments/${deploymentId}/subscriptions`,
    );
    return body.subscriptions ?? [];
  },
};

// --- Projects ---

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  state: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  /** Set by GET /projects/:projectId — the user that fetched the record. */
  accessedBy?: string;
}

export interface ProjectRepositoryAssociation {
  id: string;
  projectId: string;
  provider: string;
  externalId: string;
  canonicalRef: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export const projects = {
  listForUser: async (): Promise<Project[]> => {
    const body = await apiGet<{ projects: Project[] }>(`/projects`);
    return body.projects ?? [];
  },
  get: (id: string) => apiGet<Project>(`/projects/${id}`),
  create: (organizationId: string, input: { name: string; metadata?: Record<string, unknown> }) =>
    apiPost<Project>(`/organizations/${organizationId}/projects`, input),
  update: (id: string, input: { name?: string; metadata?: Record<string, unknown> }) =>
    apiPatch<Project>(`/projects/${id}`, input),
  transition: (id: string, to: string) =>
    apiPost<{ projectId: string; from: string; to: string }>(`/projects/${id}/transition`, { to }),
  connectRepository: (
    projectId: string,
    input: { provider: string; externalId: string; canonicalRef: string; metadata?: Record<string, unknown> },
  ) => apiPost<ProjectRepositoryAssociation>(`/projects/${projectId}/repositories`, input),
  listRepositories: async (projectId: string): Promise<ProjectRepositoryAssociation[]> => {
    const body = await apiGet<{ repositories: ProjectRepositoryAssociation[] }>(`/projects/${projectId}/repositories`);
    return body.repositories ?? [];
  },
};

// --- Architecture ---

export interface Architecture {
  id: string;
  projectId: string;
  name: string;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ArchitectureVersion {
  id: string;
  architectureId: string;
  versionNumber?: number;
  state: string;
  contentInline: string | null;
  storageKey?: string | null;
  storageProvider?: string | null;
  contentLength?: number;
  contentType?: string | null;
  digestSha256?: string | null;
  metadata?: Record<string, unknown>;
  frozenAt?: string | null;
  frozenBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ArchitectureDecisionRecord {
  id: string;
  versionId: string;
  adrNumber?: number;
  title: string;
  content: string;
  status: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ArchitectureChangeRequest {
  id: string;
  architectureId: string;
  affectedVersionId?: string | null;
  requesterId?: string | null;
  reason: string;
  requestedChange: string;
  status: string;
  approverId?: string | null;
  approvedAt?: string | null;
  replacementVersionId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateArchitectureVersionInput {
  contentInline?: string;
  storageKey?: string;
  storageProvider?: string;
  contentLength?: number;
  contentType?: string;
  digestSha256?: string;
  metadata?: Record<string, unknown>;
}

// Backend wraps list responses in objects (`{ architectures: [...] }`,
// `{ versions: [...] }`, `{ requirements: [...] }`, `{ criteria: [...] }`).
// The frontend unwraps them here so page components receive plain arrays.
export const architecture = {
  listForProject: async (projectId: string): Promise<Architecture[]> => {
    const body = await apiGet<{ architectures: Architecture[] }>(`/projects/${projectId}/architectures`);
    return body.architectures ?? [];
  },
  get: (id: string) => apiGet<Architecture>(`/architectures/${id}`),
  create: (
    projectId: string,
    input: { name: string; description?: string },
  ) => apiPost<Architecture>(`/projects/${projectId}/architectures`, input),
  listVersions: async (architectureId: string): Promise<ArchitectureVersion[]> => {
    const body = await apiGet<{ versions: ArchitectureVersion[] }>(`/architectures/${architectureId}/versions`);
    return body.versions ?? [];
  },
  createVersion: (architectureId: string, input: CreateArchitectureVersionInput) =>
    apiPost<ArchitectureVersion>(`/architectures/${architectureId}/versions`, input),
  freezeVersion: (versionId: string) =>
    apiPost<ArchitectureVersion>(`/architecture-versions/${versionId}/freeze`, {}),
  listDecisions: async (versionId: string): Promise<ArchitectureDecisionRecord[]> => {
    const body = await apiGet<{ decisions: ArchitectureDecisionRecord[] }>(`/architecture-versions/${versionId}/decisions`);
    return body.decisions ?? [];
  },
  createDecision: (
    versionId: string,
    input: { title: string; content: string; status?: string },
  ) => apiPost<ArchitectureDecisionRecord>(`/architecture-versions/${versionId}/decisions`, input),
  listChangeRequests: async (architectureId: string): Promise<ArchitectureChangeRequest[]> => {
    const body = await apiGet<{ changeRequests: ArchitectureChangeRequest[] }>(`/architectures/${architectureId}/change-requests`);
    return body.changeRequests ?? [];
  },
  createChangeRequest: (
    architectureId: string,
    input: { affectedVersionId?: string; reason: string; requestedChange: string },
  ) => apiPost<ArchitectureChangeRequest>(`/architectures/${architectureId}/change-requests`, input),
  approveChangeRequest: (crId: string, input: CreateArchitectureVersionInput) =>
    apiPost<{ newVersion: ArchitectureVersion; changeRequest: ArchitectureChangeRequest }>(`/change-requests/${crId}/approve`, input),
  rejectChangeRequest: (crId: string) =>
    apiPost<ArchitectureChangeRequest>(`/change-requests/${crId}/reject`, {}),
};

// --- Requirements ---

export interface Requirement {
  id: string;
  architectureVersionId: string;
  requirementId: string;
  title: string;
  status: string;
  description: string | null;
  verificationRequirement?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface AcceptanceCriterion {
  id: string;
  requirementId: string;
  criterionId: string;
  description: string;
  status: string;
  verificationExpectation?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface EvidenceReference {
  id: string;
  criterionId: string;
  evidenceType: string;
  evidenceRef: string;
  source: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export const requirements = {
  listForVersion: async (versionId: string): Promise<Requirement[]> => {
    const body = await apiGet<{ requirements: Requirement[] }>(`/architecture-versions/${versionId}/requirements`);
    return body.requirements ?? [];
  },
  get: (id: string) => apiGet<Requirement>(`/requirements/${id}`),
  create: (
    versionId: string,
    input: { requirementId: string; title: string; description?: string; verificationRequirement?: string },
  ) => apiPost<Requirement>(`/architecture-versions/${versionId}/requirements`, input),
  update: (id: string, input: { title?: string; description?: string; verificationRequirement?: string; status?: string }) =>
    apiPatch<Requirement>(`/requirements/${id}`, input),
  listCriteria: async (requirementId: string): Promise<AcceptanceCriterion[]> => {
    const body = await apiGet<{ criteria: AcceptanceCriterion[] }>(`/requirements/${requirementId}/criteria`);
    return body.criteria ?? [];
  },
  createCriterion: (
    requirementId: string,
    input: { criterionId: string; description: string; verificationExpectation?: string; status?: string },
  ) => apiPost<AcceptanceCriterion>(`/requirements/${requirementId}/criteria`, input),
  updateCriterion: (criterionId: string, input: { description?: string; verificationExpectation?: string; status?: string }) =>
    apiPatch<AcceptanceCriterion>(`/criteria/${criterionId}`, input),
  listEvidenceReferences: async (criterionId: string): Promise<EvidenceReference[]> => {
    const body = await apiGet<{ evidenceReferences: EvidenceReference[] }>(`/criteria/${criterionId}/evidence-references`);
    return body.evidenceReferences ?? [];
  },
  addEvidenceReference: (
    criterionId: string,
    input: { evidenceType: string; evidenceRef: string; source?: string },
  ) => apiPost<EvidenceReference>(`/criteria/${criterionId}/evidence-references`, input),
};

// --- Work Items ---

export interface WorkItem {
  id: string;
  architectureVersionId: string;
  /**
   * WORK-050: the work item's PROJECT — present on the single-work-item GET
   * (resolved server-side through the authoritative traceability chain), so
   * consumers can address the project-scoped read surfaces (the WORK-047
   * intelligence + WORK-046 delegation reads). Never a client-supplied scope.
   */
  projectId?: string;
  workItemId: string;
  title: string;
  objective?: string | null;
  scope?: string | null;
  outOfScope?: string | null;
  architectureConstraints?: string | null;
  assignee?: string | null;
  executionMetadata?: Record<string, unknown>;
  completed: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkOrder {
  id: string;
  workItemId: string;
  projectId: string;
  architectureVersionId: string;
  state: string;
  scope: string | null;
  outOfScope?: string | null;
  architectureConstraints?: string | null;
  requirementIds?: string[];
  criterionIds?: string[];
  implementationContext?: Record<string, unknown>;
  verificationRequirements?: unknown[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface PrAssociation {
  id: string;
  workItemId: string;
  externalPrId: string;
  status: string;
  provider?: string;
  repositoryRef?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  headCommit?: string | null;
  createdAt?: string;
}

export interface WorkItemDependency {
  id: string;
  workItemId: string;
  dependsOnId: string;
  createdAt?: string;
}

export interface CreateWorkItemInput {
  workItemId: string;
  title: string;
  objective?: string;
  scope?: string;
  outOfScope?: string;
  architectureConstraints?: string;
  assignee?: string;
}

export interface CreateWorkOrderInput {
  requirementIds?: string[];
  criterionIds?: string[];
  architectureConstraints?: string;
  implementationContext?: Record<string, unknown>;
  scope?: string;
  outOfScope?: string;
  verificationRequirements?: unknown[];
}

export interface CreatePrAssociationInput {
  externalPrId: string;
  provider?: string;
  repositoryRef?: string;
  branch?: string;
  baseBranch?: string;
  headCommit?: string;
}

// The backend wraps list responses in objects (`{ workOrders: [...] }`,
// `{ prAssociations: [...] }`, `{ agentRuns: [...] }`). The frontend unwraps
// them here so page components receive plain arrays — but the authority is
// still the backend response, not client-side derivation.
export const workItems = {
  get: (id: string) => apiGet<WorkItem>(`/work-items/${id}`),
  listForVersion: async (versionId: string): Promise<WorkItem[]> => {
    const body = await apiGet<{ workItems: WorkItem[] }>(`/architecture-versions/${versionId}/work-items`);
    return body.workItems ?? [];
  },
  create: (versionId: string, input: CreateWorkItemInput) =>
    apiPost<WorkItem>(`/architecture-versions/${versionId}/work-items`, input),
  listWorkOrders: async (workItemId: string): Promise<WorkOrder[]> => {
    const body = await apiGet<{ workOrders: WorkOrder[] }>(`/work-items/${workItemId}/work-orders`);
    return body.workOrders ?? [];
  },
  createWorkOrder: (workItemId: string, input: CreateWorkOrderInput) =>
    apiPost<WorkOrder>(`/work-items/${workItemId}/work-orders`, input),
  listPrAssociations: async (workItemId: string): Promise<PrAssociation[]> => {
    const body = await apiGet<{ prAssociations: PrAssociation[] }>(`/work-items/${workItemId}/pr-associations`);
    return body.prAssociations ?? [];
  },
  createPrAssociation: (workItemId: string, input: CreatePrAssociationInput) =>
    apiPost<PrAssociation>(`/work-items/${workItemId}/pr-associations`, input),
  listDependencies: async (workItemId: string): Promise<WorkItemDependency[]> => {
    const body = await apiGet<{ dependencies: WorkItemDependency[] }>(`/work-items/${workItemId}/dependencies`);
    return body.dependencies ?? [];
  },
  addDependency: (workItemId: string, dependsOnId: string) =>
    apiPost<WorkItemDependency>(`/work-items/${workItemId}/dependencies`, { dependsOnId }),
  associateRequirement: (workItemId: string, requirementId: string) =>
    apiPost<{ id: string }>(`/work-items/${workItemId}/requirements`, { requirementId }),
  associateCriterion: (workItemId: string, criterionId: string) =>
    apiPost<{ id: string }>(`/work-items/${workItemId}/criteria`, { criterionId }),
};

// --- Workflow ---

export interface WorkflowExecution {
  id: string;
  workItemId: string;
  currentState: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkflowTransition {
  id: string;
  fromState: string;
  toState: string;
  actor: string | null;
  executionId: string | null;
  transitionType?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MergeGateResult {
  ready: boolean;
  currentState: string | null;
  hasApprovedReview: boolean;
  hasActivePrAssociation: boolean;
  verificationSatisfied: boolean;
  dependenciesSatisfied: boolean;
  reasons: string[];
}

export const workflow = {
  getState: (workItemId: string) => apiGet<WorkflowExecution>(`/work-items/${workItemId}/workflow`),
  getHistory: async (workItemId: string): Promise<WorkflowTransition[]> => {
    const body = await apiGet<{ transitions: WorkflowTransition[] }>(`/work-items/${workItemId}/workflow/history`);
    return body.transitions ?? [];
  },
  transition: (workItemId: string, toState: string) =>
    apiPost<{ success: boolean; reason?: string }>(`/work-items/${workItemId}/workflow/transitions`, { toState }),
  converge: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean }>(`/work-items/${workItemId}/workflow/converge`, {}),
  beginVerification: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean; verificationRunId: string }>(`/work-items/${workItemId}/workflow/begin-verification`, {}),
  completeVerification: (workItemId: string, verificationRunId: string) =>
    apiPost<{ signalId: string; accepted: boolean }>(`/work-items/${workItemId}/workflow/complete-verification`, { verificationRunId }),
  beginArchitectReview: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean; reviewId: string }>(`/work-items/${workItemId}/workflow/begin-architect-review`, {}),
  requestMerge: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean; mergeReady: boolean; gates: MergeGateResult }>(`/work-items/${workItemId}/workflow/request-merge`, {}),
  submitPrMerged: (workItemId: string, prAssociationId: string) =>
    apiPost<{ signalId: string; accepted: boolean }>(`/work-items/${workItemId}/workflow/submit-pr-merged`, { prAssociationId }),
  getMergeReadiness: (workItemId: string) => apiGet<MergeGateResult>(`/work-items/${workItemId}/workflow/merge-readiness`),
  getConvergence: (workItemId: string) => apiGet<unknown>(`/work-items/${workItemId}/workflow/convergence`),
  advanceToVerified: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean; verified: boolean; reason?: string }>(`/work-items/${workItemId}/workflow/advance-to-verified`, {}),
  getNextWorkItem: (projectId: string) => apiGet<{ nextWorkItemId: string | null }>(`/projects/${projectId}/workflow/next-work-item`),
  // WORK-026 (SUB-I): autonomous-implementation entry point. Builds + persists
  // the ImplementationContext for the work item (validates that the workflow
  // state is 'ready' or 'changes_requested' server-side), and optionally fans
  // out a submission to the AgentGateway when the startImplementationService
  // is wired by the composition root. The response carries the persisted
  // context summary (id / revision / kind) and the agentRunId when an agent
  // run was started. The FULL ImplementationContextContent is not returned
  // (a dedicated GET /work-items/:id/implementation-context route is not
  // implemented — see worklog SUB-H note at line 3594).
  startImplementation: (workItemId: string) =>
    apiPost<StartImplementationResponse>(
      `/work-items/${workItemId}/start-implementation`,
      {},
    ),
};

// --- Agent Runs ---
//
// Backend wraps the list response as `{ agentRuns: [...] }`. The frontend
// unwraps it here.

export interface AgentRun {
  id: string;
  executionId: string;
  workItemId: string;
  workOrderId?: string | null;
  provider: string;
  status: string;
  commitRef: string | null;
  pullRequestRef: string | null;
  branch: string | null;
  repositoryRef?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export const agentRuns = {
  listForWorkItem: async (workItemId: string): Promise<AgentRun[]> => {
    const body = await apiGet<{ agentRuns: AgentRun[] }>(`/work-items/${workItemId}/agent-runs`);
    return body.agentRuns ?? [];
  },
  create: (
    workItemId: string,
    input: { provider: string; input: string; workOrderId: string; configuration?: Record<string, unknown>; repositoryRef?: string; branch?: string },
  ) => apiPost<{ accepted: boolean; executionId: string }>(`/work-items/${workItemId}/agent-runs`, input),
};

// --- Reviews ---

export interface Review {
  id: string;
  workItemId: string;
  status: string;
  outcome: string | null;
  summary: string | null;
  source: string;
  reviewer: string | null;
  workOrderId?: string | null;
  pullRequestAssociationId?: string | null;
  architectExecutionId?: string | null;
  architectureVersionId?: string;
  executionId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReviewFinding {
  id: string;
  reviewId: string;
  severity: string;
  title: string;
  description: string;
  disposition: string;
  requirementId?: string | null;
  criterionId?: string | null;
  evidenceRef?: string | null;
  affectedScope?: string | null;
  requiredCorrection?: string | null;
  verificationRequirement?: string | null;
  causedByFindingId?: string | null;
  createdAt?: string;
}

export const reviews = {
  // Backend returns the array directly for /work-items/:id/reviews.
  listForWorkItem: (workItemId: string) => apiGet<Review[]>(`/work-items/${workItemId}/reviews`),
  get: (reviewId: string) => apiGet<Review>(`/reviews/${reviewId}`),
  create: (
    workItemId: string,
    input: { source: 'architect-llm' | 'manual' | 'agent'; reviewer?: string; summary?: string; workOrderId?: string; pullRequestAssociationId?: string; reviewInput?: Record<string, unknown> },
  ) => apiPost<Review>(`/work-items/${workItemId}/reviews`, input),
  listFindings: (reviewId: string) => apiGet<ReviewFinding[]>(`/reviews/${reviewId}/findings`),
  addFinding: (
    reviewId: string,
    input: { severity?: 'blocker' | 'major' | 'minor' | 'info'; title: string; description: string; affectedScope?: string; requirementId?: string; criterionId?: string; evidenceRef?: string; requiredCorrection?: string; verificationRequirement?: string },
  ) => apiPost<ReviewFinding>(`/reviews/${reviewId}/findings`, input),
  finalize: (
    reviewId: string,
    input: { outcome: 'approve' | 'reject' | 'changes_requested' | 'approved' | 'rejected'; summary?: string },
  ) => apiPost<Review>(`/reviews/${reviewId}/finalize`, input),
  getResult: (reviewId: string) => apiGet<unknown>(`/reviews/${reviewId}/result`),
};

// --- Verification (UI2-AC-01 correction) ---
//
// The verification surface renders ACTUAL VerificationRun + Evidence records
// persisted by the /verification module. It does NOT substitute workflow
// convergence metadata for verification data (PR #21 issue 3).
//
// Backend endpoints:
//   GET /work-items/:workItemId/verification-runs           → VerificationRun[]
//   GET /verification-runs/:runId                           → VerificationRun
//   GET /verification-runs/:runId/evidence                  → Evidence[]
//   GET /verification-runs/:runId/evidence-mappings         → CriterionEvidenceMapping[]
//   GET /verification-runs/:runId/evaluation                 → evaluation result (read-only)
//   POST /work-items/:workItemId/verification-runs           → VerificationRun
//   POST /verification-runs/:runId/evidence                  → Evidence (manual path → claim authority)
//   POST /verification-runs/:runId/ci-evidence               → attach CI evidence (authoritative)
//   POST /verification-runs/:runId/evidence-mappings         → CriterionEvidenceMapping
//   POST /verification-runs/:runId/evaluate                  → persists evaluations + sets run to 'completed'

export interface VerificationRun {
  id: string;
  projectId: string;
  workItemId: string;
  workOrderId: string | null;
  architectureVersionId: string;
  source: string;
  sourceRef: string | null;
  status: string;
  executionId: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: Record<string, unknown> | null;
  errorMetadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationEvidence {
  id: string;
  projectId: string;
  verificationRunId: string;
  evidenceType: string;
  authority: string;
  provider: string;
  externalRef: string | null;
  headSha: string | null;
  result: string;
  contentSummary: string | null;
  storageKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CriterionEvidenceMapping {
  id: string;
  verificationRunId: string;
  evidenceId: string;
  criterionId: string;
  relevance: string;
  status: string;
  createdAt: string;
}

export interface CriterionEvaluation {
  criterionId: string;
  requirementId: string;
  derivedStatus: string;
  evidenceRefs: string[];
  rationale: string;
}

export interface RequirementDerivation {
  requirementId: string;
  derivedStatus: string;
  rationale: string;
}

export interface VerificationEvaluation {
  run: VerificationRun;
  criteria: CriterionEvaluation[];
  requirements: RequirementDerivation[];
}

export const verification = {
  listRunsForWorkItem: (workItemId: string) =>
    apiGet<VerificationRun[]>(`/work-items/${workItemId}/verification-runs`),
  getRun: (runId: string) =>
    apiGet<VerificationRun>(`/verification-runs/${runId}`),
  createRun: (
    workItemId: string,
    input: { source: string; sourceRef?: string; workOrderId?: string },
  ) => apiPost<VerificationRun>(`/work-items/${workItemId}/verification-runs`, input),
  listEvidence: (runId: string) =>
    apiGet<VerificationEvidence[]>(`/verification-runs/${runId}/evidence`),
  attachEvidence: (
    runId: string,
    input: { evidenceType: string; provider: string; externalRef?: string; headSha?: string; result?: 'pass' | 'fail' | 'blocked' | 'unknown'; contentSummary?: string },
  ) => apiPost<VerificationEvidence>(`/verification-runs/${runId}/evidence`, input),
  attachCiEvidence: (runId: string, ciEvidenceId: string) =>
    apiPost<VerificationEvidence>(`/verification-runs/${runId}/ci-evidence`, { ciEvidenceId }),
  listMappings: (runId: string) =>
    apiGet<CriterionEvidenceMapping[]>(`/verification-runs/${runId}/evidence-mappings`),
  mapEvidence: (
    runId: string,
    input: { evidenceId: string; criterionId: string; relevance?: 'proves' | 'supports' | 'contradicts' | 'blocks'; source?: string },
  ) => apiPost<CriterionEvidenceMapping>(`/verification-runs/${runId}/evidence-mappings`, input),
  evaluate: (runId: string) =>
    apiPost<unknown>(`/verification-runs/${runId}/evaluate`, {}),
  getEvaluation: (runId: string) =>
    apiGet<VerificationEvaluation>(`/verification-runs/${runId}/evaluation`),
};

// --- Audit ---

export interface AuditEvent {
  id: string;
  organizationId?: string | null;
  projectId?: string | null;
  eventType: string;
  actor: string;
  source: string;
  resourceType: string;
  resourceId: string;
  executionId: string | null;
  correlationId?: string | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  workItemId?: string | null;
  workOrderId?: string | null;
  architectureVersionId?: string | null;
  reviewId?: string | null;
  verificationRunId?: string | null;
  agentRunId?: string | null;
  pullRequestAssociationId?: string | null;
  createdAt: string;
}

export const audit = {
  listForProject: (projectId: string, opts?: { eventTypes?: string[]; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.eventTypes && opts.eventTypes.length > 0) qs.set('eventTypes', opts.eventTypes.join(','));
    if (opts?.limit) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return apiGet<AuditEvent[]>(`/projects/${projectId}/audit${q ? `?${q}` : ''}`);
  },
  listForWorkItem: (workItemId: string) => apiGet<AuditEvent[]>(`/work-items/${workItemId}/audit`),
};

// --- Notifications ---

export interface NotificationRequest {
  id: string;
  notificationType: string;
  eventType: string;
  recipient: string;
  status: string;
  subject: string | null;
  createdAt: string;
}

export const notifications = {
  listForProject: (projectId: string) => apiGet<NotificationRequest[]>(`/projects/${projectId}/notifications`),
  listForWorkItem: (workItemId: string) => apiGet<NotificationRequest[]>(`/work-items/${workItemId}/notifications`),
};

// --- Architect (WORK-025) ---

export interface ParsedArchitecture {
  architecture?: { name: string; content: string; constraints?: string[] };
  requirements?: Array<{
    requirementId: string;
    title: string;
    description?: string;
    criteria?: Array<{ criterionId: string; description: string }>;
  }>;
  workItems?: Array<{
    workItemId: string;
    title: string;
    objective?: string;
    scope?: string;
    requirementIds?: string[];
    criterionIds?: string[];
    dependencies?: string[];
  }>;
  summary?: string;
}

export interface ArchitectProvider {
  name: string;
  provider: string;
  model: string;
  status: 'ready' | 'not-configured';
}

export interface ArchitectRevisionData {
  id: string;
  sessionId: string;
  revisionNumber: number;
  userPrompt: string;
  architectResponse: string;
  parsedPlan: ParsedArchitecture | null;
  createdAt: string;
}

export interface ArchitectSession {
  id: string;
  messages: Array<{ role: string; content: string }>;
  parsed_plan: Record<string, unknown> | null;
  revision_count: number;
  provider: string;
  model: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ArchitectConverseResponse {
  executionId: string;
  content: string;
  parsed: Record<string, unknown> | null;
  usage: Record<string, unknown>;
}

export interface ArchitectApplyResponse {
  architectureId: string;
  architectureVersionId: string;
  requirements: Array<{ id: string; requirementId: string }>;
  criteria: Array<{ id: string; criterionId: string }>;
  workItems: Array<{ id: string; workItemId: string }>;
}

export const architect = {
  converse: (projectId: string, body: {
    prompt: string;
    conversation?: Array<{ role: 'user' | 'assistant'; content: string }>;
    provider?: string;
    model?: string;
  }) => apiPost<ArchitectConverseResponse>(`/projects/${projectId}/architect/converse`, body),

  apply: (projectId: string, body: Record<string, unknown>) =>
    apiPost<ArchitectApplyResponse>(`/projects/${projectId}/architect/apply`, body),

  getProviders: (projectId: string) =>
    apiGet<{ providers: ArchitectProvider[] }>(`/projects/${projectId}/architect/providers`),

  getSession: (projectId: string) =>
    apiGet<{ session: ArchitectSession | null; revisions: ArchitectRevisionData[] }>(`/projects/${projectId}/architect/session`),

  getRevisions: (projectId: string) =>
    apiGet<{ revisions: ArchitectRevisionData[] }>(`/projects/${projectId}/architect/revisions`),

  saveSession: (projectId: string, body: {
    messages?: Array<{ role: string; content: string }>;
    parsedPlan?: Record<string, unknown>;
    provider?: string;
    model?: string;
  }) => apiPost<{ sessionId: string }>(`/projects/${projectId}/architect/session`, body),
};

// --- WORK-026: Runtime / GitHub provisioning / Agent providers ---
//
// These namespaces consume the SUB-F routes. The frontend never makes direct
// GitHub/Vercel API calls — every operation goes through the WorkflowOS
// backend so secrets stay inside the adapter boundary (the static-architecture
// check `frontend has no provider secrets` + `no direct GitHub/Vercel API from
// frontend` enforces this).

// Runtime — provider-independent deployment / preview environment boundary.
// Backed by /runtime routes (runtime.route.ts). The runtime status response is
// an aggregation of github + vercel + architect + agent dimensions produced by
// the DefaultRuntimeStatusService (composed in app.ts).

export type RuntimeProviderStatus =
  | 'connected'
  | 'not-configured'
  | 'error'
  | 'test-mode';

export interface RuntimeIntegration {
  id: string;
  projectId: string;
  provider: string;
  projectExternalId: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface Deployment {
  id: string;
  integrationId: string;
  externalId: string;
  status: string;
  previewUrl: string | null;
  commitSha: string | null;
  branch: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface RuntimeProviderHealth {
  name: string;
  status: RuntimeProviderStatus;
}

export interface ProjectRuntimeStatus {
  github: {
    status: RuntimeProviderStatus;
    owner?: string;
    repository?: string;
    defaultBranch?: string | null;
  };
  vercel: {
    status: RuntimeProviderStatus;
    projectId?: string;
    previewUrl?: string | null;
    latestDeployment?: Deployment | null;
  };
  architect: {
    status: RuntimeProviderStatus;
    providers: Array<{
      name: string;
      provider: string;
      model: string;
      status: 'ready' | 'not-configured';
    }>;
  };
  agent: {
    status: RuntimeProviderStatus;
    providers: Array<{
      name: string;
      provider: string;
      model: string;
      status: 'ready' | 'not-configured';
    }>;
  };
}

export interface CreateRuntimeIntegrationInput {
  provider: string;
  projectExternalId: string;
  metadata?: Record<string, unknown>;
}

export interface RecordDeploymentInput {
  provider: string;
  externalId: string;
  commitSha?: string;
  branch?: string;
  previewUrl?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export const runtime = {
  getStatus: (projectId: string) =>
    apiGet<ProjectRuntimeStatus>(`/projects/${projectId}/runtime`),
  listIntegrations: async (projectId: string): Promise<RuntimeIntegration[]> => {
    const body = await apiGet<{ integrations: RuntimeIntegration[] }>(
      `/projects/${projectId}/runtime/integrations`,
    );
    return body.integrations ?? [];
  },
  createIntegration: (projectId: string, input: CreateRuntimeIntegrationInput) =>
    apiPost<RuntimeIntegration>(`/projects/${projectId}/runtime/integrations`, input),
  removeIntegration: (projectId: string, integrationId: string) =>
    apiFetch(`/projects/${projectId}/runtime/integrations/${integrationId}`, {
      method: 'DELETE',
    }).then(() => undefined),
  listDeployments: async (projectId: string): Promise<Deployment[]> => {
    const body = await apiGet<{ deployments: Deployment[] }>(
      `/projects/${projectId}/runtime/deployments`,
    );
    return body.deployments ?? [];
  },
  recordDeployment: (projectId: string, input: RecordDeploymentInput) =>
    apiPost<Deployment>(`/projects/${projectId}/runtime/deployments`, input),
  getLatestDeployment: (projectId: string) =>
    apiGet<{ deployment: Deployment | null }>(
      `/projects/${projectId}/runtime/deployments/latest`,
    ),
  listProviders: async (projectId: string): Promise<RuntimeProviderHealth[]> => {
    const body = await apiGet<{ providers: RuntimeProviderHealth[] }>(
      `/projects/${projectId}/runtime/providers`,
    );
    return body.providers ?? [];
  },
};

// GitHub provisioning — surface GitHub App repository-provisioning capability.
// Backed by /github routes (github-provisioning.route.ts). The route never
// accepts the GitHub App private key — it delegates to the adapter (the only
// @octokit caller, wired by the composition root via the SecretStore).

export interface ProjectGitHubRepositoryLink {
  id: string;
  projectId: string;
  installationId: string;
  owner: string;
  repository: string;
  defaultBranch: string;
  linkType: 'created' | 'linked';
  externalRepoId: string | null;
  metadata?: Record<string, unknown>;
  linkedAt?: string;
  createdAt?: string;
}

export interface CreateGitHubRepositoryInput {
  owner: string;
  repository: string;
  visibility?: 'public' | 'private';
  description?: string;
  defaultBranch?: string;
  installationId: string;
}

export interface LinkGitHubRepositoryInput {
  owner: string;
  repository: string;
  installationId: string;
  defaultBranch?: string;
}

export interface CreateGitHubRepositoryResult {
  repository: ProjectGitHubRepositoryLink;
  github: {
    owner: string;
    repository: string;
    url: string;
    defaultBranch: string;
    installationId: string;
    externalRepoId?: string;
  };
}

export interface LinkGitHubRepositoryResult {
  repository: ProjectGitHubRepositoryLink;
}

export const githubProvisioning = {
  getRepository: (projectId: string) =>
    apiGet<{ repository: ProjectGitHubRepositoryLink | null }>(
      `/projects/${projectId}/github/repository`,
    ),
  createRepository: (projectId: string, input: CreateGitHubRepositoryInput) =>
    apiPost<CreateGitHubRepositoryResult>(
      `/projects/${projectId}/github/repository`,
      input,
    ),
  linkRepository: (projectId: string, input: LinkGitHubRepositoryInput) =>
    apiPost<LinkGitHubRepositoryResult>(
      `/projects/${projectId}/github/link`,
      input,
    ),
  getHealth: (projectId: string) =>
    apiGet<{ status: RuntimeProviderStatus }>(
      `/projects/${projectId}/github/health`,
    ),
};

// Agent providers — readiness surface for the implementation agent gateway.
// Backed by /agents routes (agent.route.ts). The `secretRef` field accepted by
// POST /projects/:id/agents/providers is the NAME of the env var, NOT the
// value — the route never accepts the secret value in the request body.

export interface AgentProviderConfig {
  name: string;
  provider: string;
  model: string;
  status: 'ready' | 'not-configured';
}

export interface AgentProviderConfigRecord {
  id: string;
  projectId: string;
  provider: string;
  model: string;
  /** SecretStore key name (e.g. env var name) — NEVER the secret value. */
  secretRef: string;
  metadata?: Record<string, unknown>;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateAgentProviderConfigInput {
  provider: string;
  model: string;
  /** SecretStore key name (e.g. env var name) — NEVER the secret value. */
  secretRef: string;
  metadata?: Record<string, unknown>;
  isDefault?: boolean;
}

export const agentProviders = {
  listGlobal: async (): Promise<AgentProviderConfig[]> => {
    const body = await apiGet<{ providers: AgentProviderConfig[] }>(
      `/agents/providers`,
    );
    return body.providers ?? [];
  },
  listForProject: async (projectId: string): Promise<AgentProviderConfig[]> => {
    const body = await apiGet<{ providers: AgentProviderConfig[] }>(
      `/projects/${projectId}/agents/providers`,
    );
    return body.providers ?? [];
  },
  createForProject: (
    projectId: string,
    input: CreateAgentProviderConfigInput,
  ) =>
    apiPost<AgentProviderConfigRecord>(
      `/projects/${projectId}/agents/providers`,
      input,
    ),
};

// --- WORK-026: workflow start-implementation + implementation-context view ---
//
// The POST /work-items/:workItemId/start-implementation route is the
// autonomous-implementation entry point. It builds + persists the
// ImplementationContext (revision + kind) and, when wired by the composition
// root, fans out a submission to the AgentGateway. The response carries the
// persisted context summary (id / revision / kind) — the FULL content is not
// returned (a dedicated GET /work-items/:workItemId/implementation-context
// route is NOT implemented; see worklog SUB-H note at line 3594).
//
// `getImplementationContext` is intentionally ABSENT from this namespace:
// calling a non-existent endpoint would 404. The frontend renders whatever
// summary fields the start-implementation response carries + the
// ImplementationContextViewer component (which accepts an
// ImplementationContextContent prop) is reusable for a future GET endpoint.

export interface StartImplementationResponse {
  implementationContextId: string;
  workItemId: string;
  revision: number;
  kind: 'initial' | 'correction';
  agentRunId?: string;
}

/**
 * Reusable shape for the ImplementationContext content payload (mirrors the
 * backend `ImplementationContextContent` interface declared in
 * `backend/src/modules/work-items/internal/implementation-context.types.ts`).
 * Used by the ImplementationContextViewer component — currently populated by
 * the start-implementation response summary only (the full content stays
 * server-side until a dedicated GET route is added).
 */
export interface ImplementationContextContent {
  objective: string | null;
  scope: string | null;
  outOfScope: string | null;
  architectureConstraints: string | null;
  projectId: string;
  architectureVersionId: string;
  workItemId: string;
  workOrderId: string | null;
  requirements: Array<{
    requirementId: string;
    title: string;
    description: string | null;
    criteria: Array<{ criterionId: string; description: string }>;
  }>;
  dependencies: Array<{ workItemId: string; title: string }>;
  repository: {
    owner: string | null;
    repository: string | null;
    defaultBranch: string | null;
    implementationBranch: string | null;
    currentPullRequest: {
      number: number;
      url: string;
      headSha: string;
    } | null;
  };
  expectedTests: string[];
  verificationRequirements: string[];
  browserTestRequirements: string[];
  priorAgentRuns: Array<{
    executionId: string;
    provider: string;
    model: string;
    status: string;
    commitRef: string | null;
    pullRequestRef: string | null;
    createdAt: string;
  }>;
  priorReviewFindings: Array<{
    reviewId: string;
    verdict: string;
    summary: string;
    findings: string[];
    createdAt: string;
  }>;
  instructions: string[];
  architectureContent: string | null;
  architectureName: string | null;
}

// --- WORK-027: execution provider abstraction (native vs external) ---
//
// One Work Order, two execution modes behind POST /work-items/:id/execution:
//   native   → ExecutionService → NativeExecutionProvider → AgentGateway
//   external → ExecutionService → ExternalExecutionProvider → deterministic,
//              secret-free handoff package retrieved ONLY via a one-time,
//              short-lived token (x-handoff-token header — never a URL).
//
// The frontend is a CONSUMER: no provider secrets, no workflow state machines,
// no provider-specific (Z.ai/ChatGPT/Claude) adapters or URLs — the Companion
// extension integration belongs to WORK-028/029.

export type ExecutionMode = 'native' | 'external';

export type ExecutionStatus =
  | 'created' | 'queued' | 'running' | 'handoff_ready' | 'submitted'
  | 'completed' | 'failed' | 'cancelled' | 'expired';

/** WORK-030 (PR #33 review): provider surface capabilities. */
export type ProviderSurfaceKind = 'conversational-chat' | 'coding-agent';
export type SurfaceReadiness = 'ready' | 'unverified' | 'not-available';

export interface ProviderSurfaceCapabilities {
  conversationalChat: SurfaceReadiness;
  codingAgent: SurfaceReadiness;
  implementationSurface: ProviderSurfaceKind;
}

export interface ExecutionProviderInfo {
  name: string;
  provider: string;
  model: string;
  nativeApi: 'ready' | 'not-configured';
  externalUi: 'available' | 'not-supported';
  /** Surface capabilities (conversational Chat vs the coding agent). */
  capabilities?: ProviderSurfaceCapabilities;
}

export interface StartExecutionResponse {
  executionId: string;
  mode: ExecutionMode;
  provider: string;
  model: string | null;
  status: ExecutionStatus;
  agentRunId: string | null;
  repository: string | null;
  branch: string | null;
  implementationContextId: string;
  revision: number;
  kind: 'initial' | 'correction';
  expiresAt: string | null;
}

export interface ExecutionSummary {
  executionId: string;
  /** WORK-048: present on the project-wide workbench rollup (the record's own work-item reference). */
  workItemId?: string;
  mode: ExecutionMode;
  provider: string;
  model: string | null;
  status: ExecutionStatus;
  agentRunId: string | null;
  externalSessionRef: string | null;
  repository: string | null;
  branch: string | null;
  promptDigest: string;
  benchmarkMetadata: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalExecutionPackageView {
  executionId: string;
  mode: 'external';
  projectId: string;
  workItemId: string;
  workItemLabel: string;
  workOrderId: string;
  implementationContextId: string;
  provider: string;
  model: string | null;
  repository: {
    owner: string | null;
    name: string | null;
    url: string | null;
    defaultBranch: string | null;
  };
  branch: string;
  prompt: string;
  structuredInstructions: string[];
  verificationRequirements: string[];
  expectedOutputs: string[];
  browserTestRequirements: string[];
  returnCallback: {
    eventsPath: string;
    eventTypes: string[];
    auth: string;
    note: string;
  };
  expiration: string;
}

/**
 * PR #30 review fix #2: preparing an external session issues BOTH (a) the
 * ONE-TIME package handoff token and (b) a scoped event-ingestion callback
 * token — the ONLY credential the future Companion extension needs. It never
 * holds or obtains the user's general WorkflowOS API key. Both raw tokens are
 * returned here exactly once (hashes are stored server-side) and must live in
 * memory only.
 */
export interface IssuedHandoff {
  executionId: string;
  handoffToken: string;
  expiresAt: string;
  callbackToken: string;
  callbackExpiresAt: string;
}

export const execution = {
  /** Start an execution (native or external) for a Work Item. */
  start: (workItemId: string, input: { mode: ExecutionMode; provider?: string; model?: string }) =>
    apiPost<StartExecutionResponse>(`/work-items/${workItemId}/execution`, input),

  /** List safe execution metadata for a Work Item. */
  listForWorkItem: async (workItemId: string): Promise<ExecutionSummary[]> => {
    const body = await apiGet<{ executions: ExecutionSummary[] }>(
      `/work-items/${workItemId}/executions`,
    );
    return body.executions ?? [];
  },

  /** Fetch one execution (safe metadata). */
  get: async (executionId: string): Promise<ExecutionSummary> => {
    const body = await apiGet<{ execution: ExecutionSummary }>(`/execution/${executionId}`);
    return body.execution;
  },

  /** Issue a ONE-TIME, short-lived handoff token (project.write). */
  prepareHandoff: (executionId: string) =>
    apiPost<IssuedHandoff>(`/execution/${executionId}/handoff`, {}),

  /**
   * Redeem a one-time handoff token for the full external package. The token
   * travels in the x-handoff-token HEADER (never a URL) and is consumed by
   * this call — a replay throws 409.
   */
  getPackage: async (
    executionId: string,
    handoffToken: string,
  ): Promise<{ executionId: string; status: ExecutionStatus; package: ExternalExecutionPackageView }> => {
    const res = await apiFetch(`/execution/${executionId}/package`, {
      method: 'GET',
      headers: { 'x-handoff-token': handoffToken },
    });
    return res.json();
  },
};

export const executionProviders = {
  /** Global execution-capability list (native readiness + external UI). */
  listGlobal: async (): Promise<ExecutionProviderInfo[]> => {
    const body = await apiGet<{ providers: ExecutionProviderInfo[] }>(
      `/agents/execution-providers`,
    );
    return body.providers ?? [];
  },
  /** Project-scoped execution-capability list. */
  listForProject: async (projectId: string): Promise<ExecutionProviderInfo[]> => {
    const body = await apiGet<{ providers: ExecutionProviderInfo[] }>(
      `/projects/${projectId}/agents/execution-providers`,
    );
    return body.providers ?? [];
  },
};

// --- WORK-032: Native vs External Execution Benchmark ---
//
// The benchmark harness measures Native API execution vs External Companion
// execution against the SAME engineering task snapshot. The frontend is a
// CONSUMER — it never derives integrity, computes scores, or picks winners.
// It only renders backend-supplied experiment/trial/metric/comparison state
// and surfaces backend-supplied recommendations (always evidence-backed).
// All routes authenticate through the session cookie (credentials: 'same-origin' — WORK-074).

export type BenchmarkExperimentStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'invalidated';

export type BenchmarkTrialStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unavailable';

export type BenchmarkFailureKind = 'infrastructure' | 'engineering' | 'configuration';

export type BenchmarkExecutionMode = 'native' | 'external';

export type BenchmarkExportFormat = 'json' | 'csv';

export type BenchmarkFindingSeverity = 'blocker' | 'major' | 'minor' | 'info';

export type BenchmarkConfidence = 'low' | 'medium' | 'high';

/** A frozen, immutable snapshot of the exact task to benchmark (§4). */
export interface BenchmarkTaskSnapshot {
  id: string;
  organizationId: string;
  projectId: string;
  architectureVersionId: string;
  workItemId: string;
  workOrderId: string;
  implementationContextId: string;
  requirementIds: string[];
  criterionIds: string[];
  repository: string;
  baseCommit: string;
  targetBranchPrefix: string;
  promptDigest: string;
  promptVersion: string;
  verificationRequirements: unknown[];
  snapshotHash: string;
  harnessVersion: string;
  scoringVersion: string;
  createdAt: string;
}

/** A snapshot preview (§44) — canonical prompt + digest before freezing. */
export interface BenchmarkSnapshotPreview {
  projectId: string;
  workItemId: string;
  workItemLabel: string;
  architectureVersionId: string;
  requirementIds: string[];
  criterionIds: string[];
  repository: string;
  baseCommit: string;
  /** PR #35 review fix #1: `null` for previews (read-only path persists nothing). */
  implementationContextId: string | null;
  promptDigest: string;
  promptVersion: string;
  verificationRequirements: unknown[];
  snapshotHash: string;
  harnessVersion: string;
  scoringVersion: string;
  promptExcerpt: string;
}

/** Input to freeze a snapshot from a template work item (§4, §44). */
export interface CreateBenchmarkSnapshotInput {
  projectId: string;
  workItemId: string;
  name: string;
  description?: string;
  targetBranchPrefix?: string;
}

/** An experiment: one or more trials against a single snapshot (§5). */
export interface BenchmarkExperiment {
  id: string;
  organizationId: string;
  projectId: string;
  benchmarkTaskSnapshotId: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  status: BenchmarkExperimentStatus;
  randomizationSeed: string | null;
  repetitions: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** A trial cell definition (provider × mode × repetition) (§5). */
export interface BenchmarkTrialSpec {
  provider: string;
  model?: string | null;
  mode: BenchmarkExecutionMode;
  repetitions?: number;
}

/** Input to create an experiment (§44).
 *  PR #35 review fix #5: `createdBy` is NOT sent by the frontend — the
 *  backend derives it from the authenticated identity (`user.id`). */
export interface CreateBenchmarkExperimentInput {
  projectId: string;
  benchmarkTaskSnapshotId: string;
  name: string;
  description?: string;
  trials: BenchmarkTrialSpec[];
  randomizeOrder?: boolean;
  randomizationSeed?: string;
  repetitions?: number;
}

/** A trial: one execution of one (provider, mode, rep) cell (§5, §6). */
export interface BenchmarkTrial {
  id: string;
  experimentId: string;
  benchmarkTaskSnapshotId: string;
  organizationId: string;
  projectId: string;
  provider: string;
  model: string | null;
  executionMode: BenchmarkExecutionMode;
  repetitionIndex: number;
  executionOrder: number;
  randomizationSeed: string | null;
  status: BenchmarkTrialStatus;
  trialBranch: string;
  baselineCommit: string;
  promptDigest: string;
  workItemId: string | null;
  executionId: string | null;
  agentRunId: string | null;
  pullRequestAssociationId: string | null;
  workOrderId: string | null;
  implementationContextId: string | null;
  failureKind: BenchmarkFailureKind | null;
  failureReason: string | null;
  humanInterventionCount: number;
  interventionDurationMs: number | null;
  // §17 external mode metadata
  companionVersion: string | null;
  providerAdapterVersion: string | null;
  browser: string | null;
  providerSurface: string | null;
  externalSessionRef: string | null;
  handoffIssuedAt: string | null;
  handoffRedeemedAt: string | null;
  // §18 native mode metadata
  adapterVersion: string | null;
  modelConfigurationVersion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The full metric row for a trial (§10). */
export interface BenchmarkTrialMetrics {
  trialId: string;
  // §10 Execution
  queueTimeMs: number | null;
  startLatencyMs: number | null;
  executionDurationMs: number | null;
  // §10 Engineering
  filesChanged: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  commits: number | null;
  pullRequests: number | null;
  // §15 CI
  ciRuns: number | null;
  ciFailures: number | null;
  ciFirstPass: boolean | null;
  totalCiDurationMs: number | null;
  ciFailureCategories: Record<string, number> | null;
  // §14 Verification
  verificationRuns: number | null;
  criteriaPassed: number | null;
  criteriaFailed: number | null;
  verificationFirstPass: boolean | null;
  finalPass: boolean | null;
  totalCriteria: number | null;
  // §13 Review
  reviewCount: number | null;
  requestChangesCount: number | null;
  approvalCount: number | null;
  severityCounts: Record<string, number> | null;
  // §12 Correction
  correctionCycles: number | null;
  agentRuns: number | null;
  // §10 Completion time
  timeToPrMs: number | null;
  timeToApprovedMs: number | null;
  timeToMergedMs: number | null;
  timeToVerifiedMs: number | null;
  // §11 Derived score (versioned)
  engineeringQualityScore: number | null;
  scoreVersion: string | null;
  // §16 Timestamps
  executionStartedAt: string | null;
  executionCompletedAt: string | null;
  prCreatedAt: string | null;
  ciStartedAt: string | null;
  ciCompletedAt: string | null;
  verificationStartedAt: string | null;
  verificationCompletedAt: string | null;
  reviewStartedAt: string | null;
  reviewCompletedAt: string | null;
  mergedAt: string | null;
  verifiedAt: string | null;
  collectedAt: string;
}

/** A per-trial review finding projection (§13). */
export interface BenchmarkReviewFinding {
  id: string;
  trialId: string;
  reviewId: string | null;
  severity: BenchmarkFindingSeverity;
  category: string | null;
  file: string | null;
  line: number | null;
  description: string;
  createdAt: string;
}

/** The integrity record for an experiment (§32). */
export interface BenchmarkIntegrityRecord {
  id: string;
  experimentId: string;
  snapshotHash: string;
  promptDigest: string;
  baselineCommit: string;
  scoringVersion: string;
  harnessVersion: string;
  valid: boolean;
  validatedAt: string;
  invalidationReason: string | null;
}

/** Aggregated statistics for a (provider, mode) cell across N repetitions (§22, §23). */
export interface BenchmarkCellStatistics {
  provider: string;
  mode: BenchmarkExecutionMode;
  trialCount: number;
  completed: number;
  failed: number;
  unavailable: number;
  correctionCycles: {
    mean: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
  };
  timeToVerifiedMs: {
    mean: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
  };
  ciFirstPassRate: number | null;
  verificationFirstPassRate: number | null;
  engineeringQualityScore: {
    mean: number | null;
    median: number | null;
    min: number | null;
    max: number | null;
  };
}

/** A side-by-side comparison of two or more trials (§26). */
export interface BenchmarkComparison {
  benchmarkTaskSnapshotId: string;
  promptDigest: string;
  baselineCommit: string;
  trials: BenchmarkTrial[];
  metrics: Record<string, BenchmarkTrialMetrics>;
  cells: BenchmarkCellStatistics[];
  integrityValid: boolean;
}

/** §42: Optional explicit recommendation helper. */
export interface BenchmarkRecommendation {
  experimentId: string;
  recommendedProvider: string | null;
  recommendedMode: BenchmarkExecutionMode | null;
  reason: string;
  evidence: {
    metric: string;
    value: string;
    cell: string;
  }[];
  sampleSize: number;
  confidence: BenchmarkConfidence;
}

export const benchmarks = {
  // --- Snapshots (§4, §44) ---

  snapshots: {
    /** Preview a snapshot WITHOUT persisting (§44 creation flow). */
    preview: (projectId: string, workItemId: string) =>
      apiPost<{ preview: BenchmarkSnapshotPreview }>(`/benchmarks/snapshots/preview`, {
        projectId,
        workItemId,
      }).then((b) => b.preview),

    /** Freeze a snapshot from a template work item. */
    create: (input: CreateBenchmarkSnapshotInput) =>
      apiPost<{ snapshot: BenchmarkTaskSnapshot }>(`/benchmarks/snapshots`, input).then(
        (b) => b.snapshot,
      ),

    /** List snapshots for a project (paginated). */
    list: async (
      projectId: string,
      opts?: { limit?: number; offset?: number },
    ): Promise<{ snapshots: BenchmarkTaskSnapshot[]; total: number }> => {
      const params = new URLSearchParams({ projectId });
      if (opts?.limit != null) params.set('limit', String(opts.limit));
      if (opts?.offset != null) params.set('offset', String(opts.offset));
      return apiGet<{ snapshots: BenchmarkTaskSnapshot[]; total: number }>(
        `/benchmarks/snapshots?${params.toString()}`,
      );
    },

    /** Get a snapshot by id. */
    get: async (id: string): Promise<BenchmarkTaskSnapshot> => {
      const body = await apiGet<{ snapshot: BenchmarkTaskSnapshot }>(`/benchmarks/snapshots/${id}`);
      return body.snapshot;
    },
  },

  // --- Experiments (§5, §45) ---

  /** List experiments for a project (paginated, §49). */
  list: async (
    projectId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ experiments: BenchmarkExperiment[]; total: number }> => {
    const params = new URLSearchParams({ projectId });
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    return apiGet<{ experiments: BenchmarkExperiment[]; total: number }>(
      `/benchmarks?${params.toString()}`,
    );
  },

  /** Create an experiment (§44). */
  create: (input: CreateBenchmarkExperimentInput) =>
    apiPost<{ experiment: BenchmarkExperiment }>(`/benchmarks`, input).then(
      (b) => b.experiment,
    ),

  /** Get an experiment by id. */
  get: async (id: string): Promise<BenchmarkExperiment> => {
    const body = await apiGet<{ experiment: BenchmarkExperiment }>(`/benchmarks/${id}`);
    return body.experiment;
  },

  /** §45: Start an experiment (runs queued trials synchronously — may take a while). */
  start: (id: string) =>
    apiPost<{ experiment: BenchmarkExperiment }>(`/benchmarks/${id}/start`, {}).then(
      (b) => b.experiment,
    ),

  /** §45: Pause a running experiment. */
  pause: (id: string) =>
    apiPost<{ experiment: BenchmarkExperiment }>(`/benchmarks/${id}/pause`, {}).then(
      (b) => b.experiment,
    ),

  /** §45: Cancel an experiment. */
  cancel: (id: string) =>
    apiPost<{ experiment: BenchmarkExperiment }>(`/benchmarks/${id}/cancel`, {}).then(
      (b) => b.experiment,
    ),

  // --- Trials (§25) ---

  /** List trials for an experiment (paginated, §49). */
  listTrials: async (
    experimentId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ trials: BenchmarkTrial[]; total: number }> => {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return apiGet<{ trials: BenchmarkTrial[]; total: number }>(
      `/benchmarks/${experimentId}/trials${qs ? `?${qs}` : ''}`,
    );
  },

  /** Get a trial by id (§25 detail view). */
  getTrial: async (trialId: string): Promise<BenchmarkTrial> => {
    const body = await apiGet<{ trial: BenchmarkTrial }>(`/benchmarks/trials/${trialId}`);
    return body.trial;
  },

  /** Get trial metrics (§25). */
  getTrialMetrics: async (trialId: string): Promise<BenchmarkTrialMetrics | null> => {
    const body = await apiGet<{ metrics: BenchmarkTrialMetrics | null }>(
      `/benchmarks/trials/${trialId}/metrics`,
    );
    return body.metrics ?? null;
  },

  /** Get trial review findings (§13). */
  listTrialFindings: async (trialId: string): Promise<BenchmarkReviewFinding[]> => {
    const body = await apiGet<{ findings: BenchmarkReviewFinding[] }>(
      `/benchmarks/trials/${trialId}/findings`,
    );
    return body.findings ?? [];
  },

  // --- Comparison (§26) ---

  /** Side-by-side comparison of two or more trials. */
  compare: (trialIds: string[]) =>
    apiPost<{ comparison: BenchmarkComparison }>(`/benchmarks/compare`, { trialIds }).then(
      (b) => b.comparison,
    ),

  // --- Integrity (§32) ---

  /** Integrity record for an experiment. */
  getIntegrity: async (experimentId: string): Promise<BenchmarkIntegrityRecord | null> => {
    const body = await apiGet<{ integrity: BenchmarkIntegrityRecord | null }>(
      `/benchmarks/${experimentId}/integrity`,
    );
    return body.integrity ?? null;
  },

  // --- Recommendation (§42) ---

  /** Optional explicit, evidence-backed recommendation. */
  recommend: async (experimentId: string): Promise<BenchmarkRecommendation | null> => {
    const body = await apiGet<{ recommendation: BenchmarkRecommendation | null }>(
      `/benchmarks/${experimentId}/recommend`,
    );
    return body.recommendation ?? null;
  },

  // --- Export (§40) ---

  /**
   * Export experiment results as a Blob (file download). Uses raw fetch + res.blob()
   * because the response body is not JSON — it's a JSON or CSV file attachment.
   */
  exportExperiment: async (
    experimentId: string,
    format: BenchmarkExportFormat,
  ): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/benchmarks/${experimentId}/export?format=${format}`,
      { credentials: 'same-origin' },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(
        res.status,
        body.error || body.reason || `Export failed: ${res.status}`,
      );
    }
    return res.blob();
  },
};

// --- WORK-033: Execution Policy & Fair Benchmarking ---
//
// The execution-policy layer is an APPLICATION-LAYER ORCHESTRATOR on the
// backend (lives at `backend/src/execution-policy/` — mirrors the §34
// benchmark pattern; it is NOT the 18th frozen module). It produces
// evidence-backed recommendations, persists project/user policy + preference
// CRUD, freezes policies when benchmark experiments start, and records
// append-only decision audit rows.
//
// The frontend is a pure consumer (§34): every verdict (eligibility, score,
// recommendation, "why") is computed backend-side. The frontend never
// derives canonical workflow states, never stores credentials, and never
// bypasses ExecutionService.submit — the ExecutionPolicyDialog still calls
// `execution.start()` with the user-selected {mode, provider, model}; the
// policy dialog only surfaces the recommendation to INFORM selection.
//
// All routes are backend-authorized; the server derives `actor`/`userId`
// from the authenticated `requireProjectAuthorization` user — the request
// body never carries actor/userId (PR #35 fix #5 pattern). Date fields are
// JSON-serialized ISO strings (the existing convention in this module).

/** §6 normalized surface/capability profile (composed from ExecutionProviderInfo). */
export type CapabilityReadiness = 'supported' | 'ready' | 'unverified' | 'unavailable';

/** §23 normalized provider runtime readiness. */
export type ProviderAvailability =
  | 'ready'
  | 'unverified'
  | 'unavailable'
  | 'subscription_blocked'
  | 'capability_blocked'
  | 'policy_blocked'
  | 'configuration_missing';

/** §3 eligibility is a HARD filter — quality never makes an ineligible candidate eligible. */
export type ExecutionEligibilityStatus =
  | 'eligible'
  | 'unavailable'
  | 'subscription_blocked'
  | 'capability_blocked'
  | 'unknown_constrained'
  | 'policy_blocked'
  | 'privacy_blocked'
  | 'project_policy_blocked'
  | 'configuration_missing'
  | 'provider_temporarily_unavailable'
  /** WORK-043 (§33.3) — the new constraint families. */
  | 'quota_exhausted'
  | 'rate_limited'
  | 'security_blocked'
  | 'agent_policy_blocked';

/** §4 hard constraint categories that compose the eligibility verdict. */
export type ExecutionConstraintCategory =
  | 'capability'
  | 'user'
  | 'project'
  | 'organization'
  | 'availability'
  | 'subscription'
  | 'privacy'
  | 'evidence'
  /** WORK-043 (§33.3) — the new constraint families. */
  | 'quota'
  | 'rate_limit'
  | 'security'
  | 'agent_policy';

/** WORK-043 (§33.3) — the security classification ladder (standard < confidential < restricted). */
export type SecurityClassification = 'standard' | 'confidential' | 'restricted';

/** §10 capability requirement kinds feeding the eligibility filter. */
export type CapabilityRequirement =
  | 'coding_agent'
  | 'browser'
  | 'repository_access'
  | 'terminal'
  | 'private_network'
  | 'native_api'
  | 'external_ui';

/** §8 benchmark mode — selects which dimension is held fixed vs free. */
export type BenchmarkMode =
  | 'maximum_capability'
  | 'controlled_comparison'
  | 'cost_constrained'
  | 'latency_constrained'
  | 'subscription_constrained'
  | 'privacy_constrained';

/** §12 privacy level. */
export type PrivacyLevel = 'standard' | 'private' | 'local_only' | 'regulated';

/** §13/§16 recommendation reason dimension. */
export type RecommendationDimension =
  | 'hard_eligibility'
  | 'user_project_org_policy'
  | 'required_capability'
  | 'benchmark_evidence'
  | 'cost'
  | 'latency'
  | 'user_preferences';

/** §24 cost confidence — never fabricated. */
export type CostConfidence = 'known' | 'estimated' | 'unknown';

/** §9: the policy-status snapshot at evaluation time (mirrors ExecutionEligibilityStatus). */
export type PolicyStatus = ExecutionEligibilityStatus;

export interface ContextWindow {
  tokens: number | null;
  source: 'provider_doc' | 'user_configured' | 'unknown';
}

export interface ProviderCapabilityProfile {
  conversational: CapabilityReadiness;
  codingAgent: CapabilityReadiness;
  browser: CapabilityReadiness;
  repositoryAccess: CapabilityReadiness;
  terminal: CapabilityReadiness;
  nativeApi: CapabilityReadiness;
  externalUi: CapabilityReadiness;
  streaming: CapabilityReadiness;
  toolUse: CapabilityReadiness;
  maxContext: ContextWindow;
  supportedExecutionModes: ExecutionMode[];
}

/** §5 user-configured subscription capability profile (or 'unknown'). */
export interface ProviderAccessProfile {
  provider: string;
  plan: string | null;
  codingAgent: CapabilityReadiness;
  externalUi: CapabilityReadiness;
  nativeApi: CapabilityReadiness;
  statusSource: 'verified' | 'user_configured' | 'unknown';
}

export interface EligibilityBlock {
  category: ExecutionConstraintCategory;
  constraint: string;
  reason: string;
}

export interface ExecutionEligibilityResult {
  status: ExecutionEligibilityStatus;
  eligible: boolean;
  /** Empty iff eligible. Each reason is human-readable + structured. */
  blockingReasons: EligibilityBlock[];
  /** For eligible candidates, the constraints satisfied (transparency). */
  satisfiedConstraints: string[];
}

export interface ToolPolicy {
  /** §10 controlled comparison keeps tool CLASS fixed but persists impl differences. */
  toolClassFixed: boolean;
  /** §11 maximum-capability mode — each candidate uses its strongest config. */
  maximumCapability: boolean;
  /** §21 NEVER artificially cap a provider's tools solely for fairness. */
  noArtificialCaps: boolean;
}

export interface HumanInterventionPolicy {
  allowed: boolean;
  /** If false, external strategies that require user confirmation become ineligible (§26). */
  blockIfRequired: boolean;
}

/** §9 the immutable-on-freeze benchmark policy snapshot. */
export interface BenchmarkPolicy {
  benchmarkMode: BenchmarkMode;
  maxCostCents: number | null;
  maxDurationMs: number | null;
  requiredCapabilities: CapabilityRequirement[];
  allowedProviders: string[];
  allowedModes: ExecutionMode[];
  privacyRequirements: PrivacyConstraints;
  subscriptionRequirement: SubscriptionConstraints;
  toolPolicy: ToolPolicy;
  humanInterventionPolicy: HumanInterventionPolicy;
  policyVersion: number;
  /** §9 set true when a benchmark experiment starts; thereafter immutable. */
  frozen: boolean;
}

export interface PrivacyConstraints {
  level: PrivacyLevel;
  approvedLocations: string[];
}

export interface SubscriptionConstraints {
  /** §5 candidates whose subscription capability is 'unknown' default to blocked. */
  blockUnknownSubscription: boolean;
  requiredCodingAgentProviders: string[];
}

/** §10 controlled-comparison dimension display. */
export interface ControlledComparisonDimensions {
  sameTask: boolean;
  sameArchitecture: boolean;
  sameBaseline: boolean;
  sameImplementationContext: boolean;
  sameVerification: boolean;
  comparableToolClass: boolean;
  differingSurfaces: boolean;        // native vs external ≠
  differingContextWindow: boolean;   // provider context ≠
  differingToolImplementation: boolean; // provider tool impl ≠
}

export interface CostEstimate {
  cents: number | null;
  confidence: CostConfidence;
  currency: string;
}

export interface LatencyEstimate {
  estimatedMs: number | null;
  confidence: CostConfidence;
  source: 'historical_observed' | 'estimated' | 'unknown';
}

/** §14 historical performance evidence (may be insufficient — never treat 1 run as definitive). */
export interface HistoricalPerformance {
  sampleSize: number;
  sufficient: boolean;
  observedQuality: number | null;
  ciFirstPassRate: number | null;
  verificationFirstPassRate: number | null;
  medianCorrectionCycles: number | null;
  medianTimeToVerifiedMs: number | null;
  humanInterventionCount: number | null;
  /** §22 which (provider, mode) cells backed this (audit trail). */
  evidenceCells: BenchmarkCellStatistics[];
}

/** §15 derived task profile feeding eligibility + recommendation. */
export interface ExecutionTaskProfile {
  language: string | null;
  framework: string | null;
  repositorySize: 'small' | 'medium' | 'large' | 'unknown';
  complexity: 'low' | 'medium' | 'high' | 'unknown';
  architectureSensitivity: 'low' | 'medium' | 'high';
  securitySensitivity: 'low' | 'medium' | 'high';
  browserRequired: boolean;
  terminalRequired: boolean;
  repositoryAccess: boolean;
  externalExecutionAllowed: boolean;
  nativeExecutionAllowed: boolean;
  requiredCapabilities: CapabilityRequirement[];
  humanInterventionLikely: boolean;
}

/** §2 a candidate execution strategy under evaluation — metadata only, NEVER carries secrets. */
export interface ExecutionCandidate {
  provider: string;
  name: string;
  model: string;
  executionMode: ExecutionMode;
  capabilities: ProviderCapabilityProfile;
  accessProfile: ProviderAccessProfile | null;
  availability: ProviderAvailability;
  eligibility: ExecutionEligibilityResult;
  estimatedCost: CostEstimate;
  estimatedLatency: LatencyEstimate;
  historicalPerformance: HistoricalPerformance;
  policyStatus: PolicyStatus;
  /** §13 normalized recommendation score [0..1]. Eligible candidates only. */
  recommendationScore: number;
}

export interface RecommendationReason {
  dimension: RecommendationDimension;
  satisfied: boolean;
  detail: string;
}

/** §19 "Why?" explanation — structured, never "AI chose this". */
export interface RecommendationWhy {
  recommendedCandidateId: string | null;
  headline: string;
  reasons: RecommendationReason[];
  /** §17 eligible candidates the user could select instead. */
  alternatives: string[];
}

/** §16 the recommendation response returned by GET /work-items/:id/execution/recommendation. */
export interface ExecutionRecommendation {
  workItemId: string;
  recommendedCandidate: ExecutionCandidate | null;
  eligibleCandidates: ExecutionCandidate[];
  excludedCandidates: ExecutionCandidate[];
  why: RecommendationWhy;
  benchmarkEvidence: HistoricalPerformance;
  policy: BenchmarkPolicy;
  taskProfile: ExecutionTaskProfile;
  /** §22 immutable decision record id (append-only audit). */
  decisionId: string;
}

/** §31 project execution policy (per-project). */
export interface ProjectPolicyRecord {
  id: string;
  organizationId: string;
  projectId: string;
  defaultBenchmarkMode: BenchmarkMode;
  externalExecutionAllowed: boolean;
  nativeExecutionAllowed: boolean;
  maxCostPerTaskCents: number | null;
  maxCostPerTrialCents: number | null;
  maxTimeToPrMs: number | null;
  humanInterventionAllowed: boolean;
  privacyLevel: PrivacyLevel;
  allowedProviders: string[];
  deniedProviders: string[];
  allowedModes: ExecutionMode[];
  /** WORK-043 (§33.3) — quota / rate-limit / security constraint columns. */
  maxExecutionsPerMonth: number | null;
  maxExecutionsPerDay: number | null;
  rateLimitMaxRequests: number | null;
  rateLimitWindowSeconds: number | null;
  securityClassification: SecurityClassification;
  externalSecurityCeiling: SecurityClassification | null;
  frozen: boolean;
  policyVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** §12 user preferences (advisory; never override hard constraints). */
export interface UserPreferenceRecord {
  id: string;
  organizationId: string;
  userId: string;
  qualityWeight: number;
  costWeight: number;
  latencyWeight: number;
  privacyWeight: number;
  preferredMode: ExecutionMode | null;
  externalPreferred: boolean;
  nativePreferred: boolean;
  defaultBenchmarkMode: BenchmarkMode;
  createdAt: string;
  updatedAt: string;
}

/** §5 user-scoped provider access profile record (DB row). */
export interface ProviderAccessProfileRecord extends ProviderAccessProfile {
  id: string;
  organizationId: string;
  userId: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** §22 append-only decision record (audit). */
export interface ExecutionPolicyDecisionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  workItemId: string;
  requestedBy: string | null;
  policyVersion: number;
  benchmarkMode: BenchmarkMode;
  taskProfile: ExecutionTaskProfile;
  eligibleCandidates: ExecutionCandidate[];
  excludedCandidates: ExecutionCandidate[];
  recommendedCandidate: ExecutionCandidate | null;
  whyExplanation: string;
  scores: Record<string, number>;
  benchmarkEvidence: HistoricalPerformance;
  createdAt: string;
}

/** §31 input for PATCH /projects/:projectId/execution-policy. */
export interface UpdateProjectPolicyInput {
  defaultBenchmarkMode?: BenchmarkMode;
  externalExecutionAllowed?: boolean;
  nativeExecutionAllowed?: boolean;
  maxCostPerTaskCents?: number | null;
  maxCostPerTrialCents?: number | null;
  maxTimeToPrMs?: number | null;
  humanInterventionAllowed?: boolean;
  privacyLevel?: PrivacyLevel;
  allowedProviders?: string[];
  deniedProviders?: string[];
  allowedModes?: ExecutionMode[];
  /** WORK-043 (§33.3) — quota / rate-limit / security constraint fields. */
  maxExecutionsPerMonth?: number | null;
  maxExecutionsPerDay?: number | null;
  rateLimitMaxRequests?: number | null;
  rateLimitWindowSeconds?: number | null;
  securityClassification?: SecurityClassification;
  externalSecurityCeiling?: SecurityClassification | null;
}

/** §12 input for PATCH /projects/:projectId/execution-preferences. */
export interface UpdateUserPreferencesInput {
  qualityWeight?: number;
  costWeight?: number;
  latencyWeight?: number;
  privacyWeight?: number;
  preferredMode?: ExecutionMode | null;
  externalPreferred?: boolean;
  nativePreferred?: boolean;
  defaultBenchmarkMode?: BenchmarkMode;
}

/** §5 input for POST /projects/:projectId/provider-access-profiles. */
export interface UpsertAccessProfileInput {
  provider: string;
  plan?: string | null;
  codingAgent?: CapabilityReadiness;
  externalUi?: CapabilityReadiness;
  nativeApi?: CapabilityReadiness;
  statusSource?: 'verified' | 'user_configured' | 'unknown';
  notes?: string | null;
}

/**
 * WORK-033 execution-policy API namespace. Mirrors the routes registered in
 * `backend/src/api/routes/execution-policy.route.ts`. All routes are
 * backend-authorized; the authenticated user.id is the server-side actor.
 */
export const executionPolicy = {
  // --- §16/§22/§10 work-item-scoped ---

  recommendation: {
    /** §16 produce a recommendation for a Work Item. */
    get: async (workItemId: string): Promise<ExecutionRecommendation> => {
      const body = await apiGet<{ recommendation: ExecutionRecommendation }>(
        `/work-items/${workItemId}/execution/recommendation`,
      );
      return body.recommendation;
    },
  },

  decisions: {
    /** §22 list historical policy decisions for a Work Item (audit). */
    list: async (workItemId: string): Promise<ExecutionPolicyDecisionRecord[]> => {
      const body = await apiGet<{ decisions: ExecutionPolicyDecisionRecord[] }>(
        `/work-items/${workItemId}/execution/decisions`,
      );
      return body.decisions ?? [];
    },
  },

  /** §10 controlled-comparison dimension display. */
  controlledComparison: async (
    workItemId: string,
  ): Promise<ControlledComparisonDimensions> => {
    const body = await apiGet<{ dimensions: ControlledComparisonDimensions }>(
      `/work-items/${workItemId}/execution/controlled-comparison`,
    );
    return body.dimensions;
  },

  // --- §31 project policy ---

  policy: {
    /** §31 get the project execution policy (null if not yet created). */
    get: async (projectId: string): Promise<ProjectPolicyRecord | null> => {
      const body = await apiGet<{ policy: ProjectPolicyRecord | null }>(
        `/projects/${projectId}/execution-policy`,
      );
      return body.policy ?? null;
    },

    /** §31 get-or-create the project default policy. */
    ensure: (projectId: string) =>
      apiPost<{ policy: ProjectPolicyRecord }>(
        `/projects/${projectId}/execution-policy`,
        {},
      ).then((b) => b.policy),

    /** §31 update the project policy (409 if frozen — §9). */
    update: (projectId: string, input: UpdateProjectPolicyInput) =>
      apiPatch<{ policy: ProjectPolicyRecord }>(
        `/projects/${projectId}/execution-policy`,
        input,
      ).then((b) => b.policy),

    /** §9 freeze the project policy (called when a benchmark experiment starts). */
    freeze: (projectId: string) =>
      apiPost<{ policy: ProjectPolicyRecord }>(
        `/projects/${projectId}/execution-policy/freeze`,
        {},
      ).then((b) => b.policy),
  },

  // --- §12 user preferences (project-scoped for tenant context) ---

  preferences: {
    /** §12 get the user preference profile (null if not yet created). */
    get: async (projectId: string): Promise<UserPreferenceRecord | null> => {
      const body = await apiGet<{ preferences: UserPreferenceRecord | null }>(
        `/projects/${projectId}/execution-preferences`,
      );
      return body.preferences ?? null;
    },

    /** §12 get-or-create the user default preferences. */
    ensure: (projectId: string) =>
      apiPost<{ preferences: UserPreferenceRecord }>(
        `/projects/${projectId}/execution-preferences`,
        {},
      ).then((b) => b.preferences),

    /** §12 update the user preference profile. */
    update: (projectId: string, input: UpdateUserPreferencesInput) =>
      apiPatch<{ preferences: UserPreferenceRecord }>(
        `/projects/${projectId}/execution-preferences`,
        input,
      ).then((b) => b.preferences),
  },

  // --- §5 provider access profiles (user-scoped, project-tenant context) ---

  accessProfiles: {
    /** §5 list the user's provider access profiles. */
    list: async (projectId: string): Promise<ProviderAccessProfileRecord[]> => {
      const body = await apiGet<{ profiles: ProviderAccessProfileRecord[] }>(
        `/projects/${projectId}/provider-access-profiles`,
      );
      return body.profiles ?? [];
    },

    /** §5 upsert a user provider access profile. */
    upsert: (projectId: string, input: UpsertAccessProfileInput) =>
      apiPost<{ profile: ProviderAccessProfileRecord }>(
        `/projects/${projectId}/provider-access-profiles`,
        input,
      ).then((b) => b.profile),
  },
};

// --- WORK-048: Developer Workbench read model ---------------------------------
//
// The workbench is a CONSUMER of backend authorities: every method below is a
// READ (apiGet only — never a mutation). The work graph, the project rollups,
// the maintenance/planning reads, and the advisory recommendation reads all
// come from backend endpoints that authorize server-side within the caller's
// project context. The frontend never derives authoritative state from them.

/** A work-graph node — the authoritative WorkItem fields + the live graph facts. */
export interface WorkGraphNode {
  id: string;
  architectureVersionId: string;
  workItemId: string;
  title: string;
  objective?: string | null;
  scope?: string | null;
  outOfScope?: string | null;
  architectureConstraints?: string | null;
  assignee?: string | null;
  executionMetadata?: Record<string, unknown>;
  completed: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  /** Current workflow state from the backend WorkflowEngine (null before the first transition). */
  currentState: string | null;
  /** Dependency ids NOT yet satisfied (from the backend dependency authority). */
  unsatisfiedDependencies: string[];
}

/** A directed dependency edge: `workItemId` depends on `dependsOnId`. */
export interface WorkGraphEdge {
  workItemId: string;
  dependsOnId: string;
}

/** The project engineering graph (WORK-048 read model). */
export interface WorkGraph {
  projectId: string;
  nodes: WorkGraphNode[];
  edges: WorkGraphEdge[];
}

export const workbench = {
  /** The project engineering graph (nodes + edges + per-node facts). READ-ONLY. */
  getWorkGraph: async (projectId: string): Promise<WorkGraph> => {
    const body = await apiGet<{ workGraph: WorkGraph }>(`/projects/${projectId}/work-graph`);
    return body.workGraph;
  },
  /** The project execution rollup (SAFE shape — no prompt/package). READ-ONLY. */
  listExecutions: async (projectId: string, limit?: number): Promise<ExecutionSummary[]> => {
    const q = limit ? `?limit=${limit}` : '';
    const body = await apiGet<{ executions: ExecutionSummary[] }>(`/projects/${projectId}/executions${q}`);
    return body.executions ?? [];
  },
  /** The project changes rollup (authoritative GitHub-derived PR identities). READ-ONLY. */
  listPrAssociations: async (projectId: string, limit?: number): Promise<PrAssociation[]> => {
    const q = limit ? `?limit=${limit}` : '';
    const body = await apiGet<{ prAssociations: PrAssociation[] }>(`/projects/${projectId}/pr-associations${q}`);
    return body.prAssociations ?? [];
  },
  /** The project verification rollup (the /verification authority's own runs). READ-ONLY. */
  listVerificationRuns: async (projectId: string, limit?: number): Promise<VerificationRun[]> => {
    const q = limit ? `?limit=${limit}` : '';
    const body = await apiGet<{ verificationRuns: VerificationRun[] }>(`/projects/${projectId}/verification-runs${q}`);
    return body.verificationRuns ?? [];
  },
  /** The project review rollup (the /reviews authority's own records). READ-ONLY. */
  listReviews: async (projectId: string, limit?: number): Promise<Review[]> => {
    const q = limit ? `?limit=${limit}` : '';
    const body = await apiGet<{ reviews: Review[] }>(`/projects/${projectId}/reviews${q}`);
    return body.reviews ?? [];
  },
};

// --- WORK-041 maintenance reads (consumed by the Workbench Maintenance section) ---

/** A maintenance signal — a planner-originated work item carrying maintenance metadata. */
export interface MaintenanceSignalItem {
  workItemId: string;
  workItemHumanId: string;
  title: string;
  objective: string | null;
  scope: string | null;
  completed: boolean;
  planner: {
    source: string;
    priority: string;
    rationale: string;
    whyNow: string;
    expectedImpact: string;
    maintenance?: {
      category: string;
      severity?: string;
      advisoryId?: string;
      affectedCount?: number;
      detectorSource?: string;
    };
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface MaintenanceHealth {
  architectureVersionId: string;
  totalSignals: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  signals: MaintenanceSignalItem[];
}

export const maintenance = {
  /** The project maintenance health summary (requires the architecture version). READ-ONLY. */
  getHealth: (projectId: string, architectureVersionId: string) =>
    apiGet<MaintenanceHealth>(
      `/projects/${projectId}/maintenance/health?architectureVersionId=${architectureVersionId}`,
    ),
};

// --- WORK-040 planning reads (consumed by the Workbench "what's next") ----------

/** A planner-originated work item recommendation (the planner authority's record). */
export interface PlanningRecommendationItem {
  workItemId: string;
  workItemHumanId: string;
  title: string;
  objective: string | null;
  scope: string | null;
  completed: boolean;
  planner: {
    source: string;
    priority: string;
    rationale: string;
    whyNow: string;
    expectedImpact: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export const planning = {
  /** The planner's recommendations for the version (planner-originated work items). READ-ONLY. */
  listRecommendations: async (
    projectId: string,
    architectureVersionId: string,
  ): Promise<PlanningRecommendationItem[]> => {
    const body = await apiGet<{ recommendations: PlanningRecommendationItem[] }>(
      `/projects/${projectId}/planning/recommendations?architectureVersionId=${architectureVersionId}`,
    );
    return body.recommendations ?? [];
  },
};

// --- WORK-044 / WORK-047 advisory reads (RECOMMENDATIONS — never decisions) ----
//
// These mirror the advisory endpoints. The workbench renders them strictly as
// RECOMMENDATIONS ("Agent Intelligence recommends X"): an authoritative
// execution decision exists only when an execution record says so — the
// frontend NEVER converts a recommendation into a selection.

/** The WORK-047 agent-intelligence execution recommendation (advisory). */
export interface AgentIntelligenceRecommendation {
  mode: string;
  projectId?: string;
  workItemId?: string;
  recommended: {
    identity: { provider: string; model: string; executionMode: string };
    score: number;
    routingRank?: number;
  } | null;
  ranked: Array<{
    identity: { provider: string; model: string; executionMode: string };
    score: number;
  }>;
  fallbacks: Array<{ provider: string; model: string; executionMode: string }>;
  provenance: {
    headline: string;
    reasons: Array<{ dimension: string; detail: string }>;
    rejectedAlternatives: Array<{ provider: string; model: string; executionMode: string; reason: string }>;
    confidence?: string;
  };
  warnings: string[];
}

export const agentIntelligence = {
  /** The WORK-047 execution recommendation. ADVISORY — never a decision. READ-ONLY. */
  getExecutionRecommendation: async (
    projectId: string,
    workItemId: string,
  ): Promise<AgentIntelligenceRecommendation> => {
    const body = await apiGet<{ intelligence: AgentIntelligenceRecommendation }>(
      `/projects/${projectId}/work-items/${workItemId}/agent-intelligence/execution`,
    );
    return body.intelligence;
  },
};

/** The WORK-044 routing recommendation (advisory — the ranked eligible set). */
export interface RoutingRecommendation {
  mode: string;
  ranked: Array<{
    identity: { provider: string; model: string; executionMode: string };
    score: number;
  }>;
  selected: {
    identity: { provider: string; model: string; executionMode: string };
    score: number;
  } | null;
  explanation: {
    selectionReason: string;
    methodology: string;
    eligibleCount: number;
    excluded: Array<{
      identity: { provider: string; model: string; executionMode: string };
    }>;
    tieBreakDecided: boolean;
  };
  decisionId?: string;
}

export const executionRouting = {
  /**
   * The WORK-044 routing recommendation. ADVISORY — never a decision; the
   * authoritative selection happens only when an execution is actually
   * submitted through the execution boundary. READ-ONLY.
   */
  getRecommendation: async (workItemId: string): Promise<RoutingRecommendation> => {
    const body = await apiGet<{ routing: RoutingRecommendation }>(
      `/work-items/${workItemId}/execution/routing/recommendation`,
    );
    return body.routing;
  },
};

// --- WORK-050: the unified execution UX read surfaces -------------------------
//
// Two READ-ONLY endpoints exposing authoritative facts the frontend could not
// otherwise reach: the WORK-042 cross-mode handoff log row (the handoff state)
// and the WORK-046 delegation plans list. Both consume existing authorities —
// the frontend renders their own values verbatim; it never derives handoff or
// delegation state of its own.

/** The safe (secret-free) WORK-042 cross-mode handoff log row. */
export interface CrossModeHandoffView {
  id: string;
  executionId: string;
  fromMode: 'native' | 'external';
  toMode: 'native' | 'external';
  reason: string | null;
  actor: string | null;
  source: string | null;
  previousStatus: string;
  resultingStatus: string;
  authorized: boolean;
  policyDecision: string | null;
  idempotencyKey: string;
  createdAt: string;
}

/** A WORK-046 delegation plan unit (the authority's own values, verbatim). */
export interface DelegationUnitView {
  id: string;
  unitKey: string;
  role: { roleId: string; roleRevision: string };
  mode: 'native' | 'external';
  provider: string;
  model: string | null;
  dependsOn: string[];
  status: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A WORK-046 delegation plan with its units (serialized plan shape). */
export interface DelegationPlanView {
  id: string;
  workItemId: string;
  planKey: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  units: DelegationUnitView[];
}

export const crossModeHandoff = {
  /**
   * The WORK-042 handoff record for an execution. `{ handoff: null }` is the
   * authority's GENUINE empty answer (the execution never handed off) — a
   * failed read throws (the api client surfaces the backend error), never a
   * fabricated null. READ-ONLY.
   */
  getForExecution: async (
    executionId: string,
  ): Promise<CrossModeHandoffView | null> => {
    const body = await apiGet<{ handoff: CrossModeHandoffView | null }>(
      `/execution/${executionId}/cross-mode-handoff`,
    );
    return body.handoff ?? null;
  },
};

export const delegationPlans = {
  /**
   * ALL delegation plans (with units) for a Work Item — the WORK-046
   * authority's own records. `[]` is a GENUINE empty answer. READ-ONLY: the
   * drive/retry/interrupt mutations stay behind their own explicit boundaries
   * (never called from the unified execution view).
   */
  listForWorkItem: async (
    projectId: string,
    workItemId: string,
  ): Promise<DelegationPlanView[]> => {
    const body = await apiGet<{ plans: DelegationPlanView[] }>(
      `/projects/${projectId}/work-items/${workItemId}/delegation-plans`,
    );
    return body.plans ?? [];
  },
};
