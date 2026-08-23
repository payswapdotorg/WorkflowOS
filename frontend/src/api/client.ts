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
  getApiKeyPrefix(): string {
    const k = getApiKey();
    if (!k) return '';
    return k.length > 10 ? `${k.slice(0, 6)}…${k.slice(-3)}` : '••••';
  },
};

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
