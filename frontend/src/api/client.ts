/**
 * API client for the WorkflowOS backend.
 *
 * The frontend is a consumer — it never owns authoritative state.
 * All data comes from backend API responses.
 */

const API_BASE = '';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function getApiKey(): string | null {
  return localStorage.getItem('wfos_api_key');
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const apiKey = getApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401) {
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
  return res.json() as Promise<T>;
}

// --- Auth ---

export const auth = {
  setApiKey(key: string): void {
    localStorage.setItem('wfos_api_key', key);
  },
  clearApiKey(): void {
    localStorage.removeItem('wfos_api_key');
  },
  hasApiKey(): boolean {
    return !!getApiKey();
  },
};

// --- Projects ---

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  state: string;
}

export const projects = {
  get: (id: string) => apiGet<Project>(`/projects/${id}`),
};

// --- Architecture ---

export interface Architecture {
  id: string;
  projectId: string;
  name: string;
}

export interface ArchitectureVersion {
  id: string;
  architectureId: string;
  state: string;
  contentInline: string | null;
}

export const architecture = {
  listForProject: (projectId: string) => apiGet<Architecture[]>(`/projects/${projectId}/architectures`),
  get: (id: string) => apiGet<Architecture>(`/architectures/${id}`),
  listVersions: (architectureId: string) => apiGet<ArchitectureVersion[]>(`/architectures/${architectureId}/versions`),
};

// --- Requirements ---

export interface Requirement {
  id: string;
  requirementId: string;
  title: string;
  status: string;
  description: string | null;
}

export interface AcceptanceCriterion {
  id: string;
  criterionId: string;
  description: string;
  status: string;
}

export const requirements = {
  listForVersion: (versionId: string) => apiGet<Requirement[]>(`/architecture-versions/${versionId}/requirements`),
  listCriteria: (requirementId: string) => apiGet<AcceptanceCriterion[]>(`/requirements/${requirementId}/criteria`),
};

// --- Work Items ---

export interface WorkItem {
  id: string;
  architectureVersionId: string;
  workItemId: string;
  title: string;
  completed: boolean;
}

export interface WorkOrder {
  id: string;
  workItemId: string;
  projectId: string;
  architectureVersionId: string;
  state: string;
  scope: string | null;
}

export interface PrAssociation {
  id: string;
  workItemId: string;
  externalPrId: string;
  status: string;
}

export const workItems = {
  get: (id: string) => apiGet<WorkItem>(`/work-items/${id}`),
  listWorkOrders: (workItemId: string) => apiGet<WorkOrder[]>(`/work-items/${workItemId}/work-orders`),
  listPrAssociations: (workItemId: string) => apiGet<PrAssociation[]>(`/work-items/${workItemId}/pr-associations`),
};

// --- Workflow ---

export interface WorkflowExecution {
  id: string;
  workItemId: string;
  currentState: string;
}

export interface WorkflowTransition {
  id: string;
  fromState: string;
  toState: string;
  actor: string | null;
  executionId: string | null;
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
  getHistory: (workItemId: string) => apiGet<{ transitions: WorkflowTransition[] }>(`/work-items/${workItemId}/workflow/history`),
  transition: (workItemId: string, toState: string) =>
    apiPost<{ success: boolean; reason?: string }>(`/work-items/${workItemId}/workflow/transitions`, { toState }),
  converge: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean }>(`/work-items/${workItemId}/workflow/converge`, {}),
  beginVerification: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean; verificationRunId: string }>(`/work-items/${workItemId}/workflow/begin-verification`, {}),
  beginArchitectReview: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean; reviewId: string }>(`/work-items/${workItemId}/workflow/begin-architect-review`, {}),
  requestMerge: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean; mergeReady: boolean; gates: MergeGateResult }>(`/work-items/${workItemId}/workflow/request-merge`, {}),
  getMergeReadiness: (workItemId: string) => apiGet<MergeGateResult>(`/work-items/${workItemId}/workflow/merge-readiness`),
  advanceToVerified: (workItemId: string) =>
    apiPost<{ signalId: string; accepted: boolean; verified: boolean; reason?: string }>(`/work-items/${workItemId}/workflow/advance-to-verified`, {}),
  getConvergence: (workItemId: string) => apiGet<{ workflowState: string | null; signals: unknown[] }>(`/work-items/${workItemId}/workflow/convergence`),
  getNextWorkItem: (projectId: string) => apiGet<{ nextWorkItemId: string | null }>(`/projects/${projectId}/workflow/next-work-item`),
};

// --- Agent Runs ---

export interface AgentRun {
  id: string;
  executionId: string;
  workItemId: string;
  provider: string;
  status: string;
  commitRef: string | null;
  pullRequestRef: string | null;
}

export const agentRuns = {
  listForWorkItem: (workItemId: string) => apiGet<AgentRun[]>(`/work-items/${workItemId}/agent-runs`),
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
}

export interface ReviewFinding {
  id: string;
  reviewId: string;
  severity: string;
  title: string;
  description: string;
  disposition: string;
}

export const reviews = {
  listForWorkItem: (workItemId: string) => apiGet<Review[]>(`/work-items/${workItemId}/reviews`),
  get: (reviewId: string) => apiGet<Review>(`/reviews/${reviewId}`),
  listFindings: (reviewId: string) => apiGet<ReviewFinding[]>(`/reviews/${reviewId}/findings`),
};

// --- Verification ---

export interface VerificationRun {
  id: string;
  workItemId: string;
  status: string;
  source: string;
}

export const verification = {
  // The backend doesn't have a list endpoint for verification runs per work item,
  // but we can use the convergence status to find the latest run.
  getConvergence: (workItemId: string) => workflow.getConvergence(workItemId),
};

// --- Audit ---

export interface AuditEvent {
  id: string;
  eventType: string;
  actor: string;
  source: string;
  resourceType: string;
  resourceId: string;
  executionId: string | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  createdAt: string;
}

export const audit = {
  listForProject: (projectId: string) => apiGet<AuditEvent[]>(`/projects/${projectId}/audit`),
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
};
