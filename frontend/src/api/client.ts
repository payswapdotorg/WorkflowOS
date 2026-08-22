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

// Backend wraps list responses in objects (`{ architectures: [...] }`,
// `{ versions: [...] }`, `{ requirements: [...] }`, `{ criteria: [...] }`).
// The frontend unwraps them here so page components receive plain arrays.
export const architecture = {
  listForProject: async (projectId: string): Promise<Architecture[]> => {
    const body = await apiGet<{ architectures: Architecture[] }>(`/projects/${projectId}/architectures`);
    return body.architectures ?? [];
  },
  get: (id: string) => apiGet<Architecture>(`/architectures/${id}`),
  listVersions: async (architectureId: string): Promise<ArchitectureVersion[]> => {
    const body = await apiGet<{ versions: ArchitectureVersion[] }>(`/architectures/${architectureId}/versions`);
    return body.versions ?? [];
  },
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
  listForVersion: async (versionId: string): Promise<Requirement[]> => {
    const body = await apiGet<{ requirements: Requirement[] }>(`/architecture-versions/${versionId}/requirements`);
    return body.requirements ?? [];
  },
  listCriteria: async (requirementId: string): Promise<AcceptanceCriterion[]> => {
    const body = await apiGet<{ criteria: AcceptanceCriterion[] }>(`/requirements/${requirementId}/criteria`);
    return body.criteria ?? [];
  },
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

// The backend wraps list responses in objects (`{ workOrders: [...] }`,
// `{ prAssociations: [...] }`, `{ agentRuns: [...] }`). The frontend unwraps
// them here so page components receive plain arrays — but the authority is
// still the backend response, not client-side derivation.
export const workItems = {
  get: (id: string) => apiGet<WorkItem>(`/work-items/${id}`),
  listWorkOrders: async (workItemId: string): Promise<WorkOrder[]> => {
    const body = await apiGet<{ workOrders: WorkOrder[] }>(`/work-items/${workItemId}/work-orders`);
    return body.workOrders ?? [];
  },
  listPrAssociations: async (workItemId: string): Promise<PrAssociation[]> => {
    const body = await apiGet<{ prAssociations: PrAssociation[] }>(`/work-items/${workItemId}/pr-associations`);
    return body.prAssociations ?? [];
  },
};

// --- Workflow ---

export interface WorkflowExecution {
  id: string;
  workItemId: string;
  currentState: string;
  version: number;
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
  getNextWorkItem: (projectId: string) => apiGet<{ nextWorkItemId: string | null }>(`/projects/${projectId}/workflow/next-work-item`),
};

// --- Agent Runs ---
//
// Backend wraps the list response as `{ agentRuns: [...] }`. The frontend
// unwraps it here.

export interface AgentRun {
  id: string;
  executionId: string;
  workItemId: string;
  provider: string;
  status: string;
  commitRef: string | null;
  pullRequestRef: string | null;
  branch: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export const agentRuns = {
  listForWorkItem: async (workItemId: string): Promise<AgentRun[]> => {
    const body = await apiGet<{ agentRuns: AgentRun[] }>(`/work-items/${workItemId}/agent-runs`);
    return body.agentRuns ?? [];
  },
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
  // Backend returns the array directly for /work-items/:id/reviews.
  listForWorkItem: (workItemId: string) => apiGet<Review[]>(`/work-items/${workItemId}/reviews`),
  get: (reviewId: string) => apiGet<Review>(`/reviews/${reviewId}`),
  listFindings: (reviewId: string) => apiGet<ReviewFinding[]>(`/reviews/${reviewId}/findings`),
};

// --- Verification (UI2-AC-01 correction) ---
//
// The verification surface renders ACTUAL VerificationRun + Evidence records
// persisted by the /verification module. It does NOT substitute workflow
// convergence metadata for verification data (PR #21 issue 3).
//
// Backend endpoints (added in this PR):
//   GET /work-items/:workItemId/verification-runs           → VerificationRun[]
//   GET /verification-runs/:runId                           → VerificationRun
//   GET /verification-runs/:runId/evidence                  → Evidence[]
//   GET /verification-runs/:runId/evidence-mappings         → CriterionEvidenceMapping[]
//   GET /verification-runs/:runId/evaluation                 → evaluation result (read-only)

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
  listEvidence: (runId: string) =>
    apiGet<VerificationEvidence[]>(`/verification-runs/${runId}/evidence`),
  listMappings: (runId: string) =>
    apiGet<CriterionEvidenceMapping[]>(`/verification-runs/${runId}/evidence-mappings`),
  getEvaluation: (runId: string) =>
    apiGet<VerificationEvaluation>(`/verification-runs/${runId}/evaluation`),
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
