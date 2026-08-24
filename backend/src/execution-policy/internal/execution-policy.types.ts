/**
 * WORK-033 — internal contracts + persistence interface.
 *
 * Boundary (mirrors the §34 benchmark pattern): the execution-policy domain
 * lives at `src/execution-policy/` (NOT src/modules/). It CONSUMES the 17
 * frozen modules via their public barrels (`@modules/*`) + `@platform/*`.
 * It NEVER imports any module's `/internal/`. It NEVER stores credentials.
 * It NEVER mutates workflow state.
 */
import type { DatabaseClient } from '@platform/postgres/database-client.js';
import type { Logger } from '@platform/logger.js';
import type {
  ExecutionPolicyDecisionRecord,
  ProjectPolicyRecord,
  UserPreferenceRecord,
  ProviderAccessProfileRecord,
  UpdateProjectPolicyInput,
  UpdateUserPreferencesInput,
  UpsertAccessProfileInput,
} from '../types.js';

/**
 * Append-only + project/user policy persistence. Hand-written parameterized
 * SQL (the WorkflowOS convention — no ORM). Tenant scoping enforced by
 * organization_id / project_id / user_id on every row.
 */
export interface ExecutionPolicyRepository {
  // --- project policy ---
  getProjectPolicy(projectId: string): Promise<ProjectPolicyRecord | null>;
  /** Insert a default policy (externalExecutionAllowed=true, nativeExecutionAllowed=true, ...). */
  insertDefaultProjectPolicy(organizationId: string, projectId: string): Promise<ProjectPolicyRecord>;
  updateProjectPolicy(projectId: string, input: UpdateProjectPolicyInput): Promise<ProjectPolicyRecord | null>;
  freezeProjectPolicy(projectId: string): Promise<ProjectPolicyRecord | null>;

  // --- user preferences ---
  getUserPreferences(userId: string): Promise<UserPreferenceRecord | null>;
  insertDefaultUserPreferences(organizationId: string, userId: string): Promise<UserPreferenceRecord>;
  updateUserPreferences(userId: string, input: UpdateUserPreferencesInput): Promise<UserPreferenceRecord | null>;

  // --- provider access profiles ---
  listAccessProfiles(userId: string): Promise<ProviderAccessProfileRecord[]>;
  upsertAccessProfile(organizationId: string, userId: string, input: UpsertAccessProfileInput): Promise<ProviderAccessProfileRecord>;

  // --- append-only decision audit (§22) ---
  insertDecision(organizationId: string, projectId: string, workItemId: string, requestedBy: string | null, row: DecisionRow): Promise<ExecutionPolicyDecisionRecord>;
  listDecisions(workItemId: string, limit?: number): Promise<ExecutionPolicyDecisionRecord[]>;
}

export interface DecisionRow {
  policyVersion: number;
  benchmarkMode: string;
  taskProfile: unknown;
  eligibleCandidates: unknown;
  excludedCandidates: unknown;
  recommendedCandidate: unknown;
  whyExplanation: string;
  scores: Record<string, number>;
  benchmarkEvidence: unknown;
}

export interface DefaultExecutionPolicyServiceDeps {
  readonly db: DatabaseClient;
  readonly logger: Logger;
  readonly repository: ExecutionPolicyRepository;
  /** §3: the HARD filter. */
  readonly eligibilityService: ExecutionEligibilityServiceLike;
  /** §13: ordered scoring (preserves capability ceiling). */
  readonly recommendationService: ExecutionRecommendationServiceLike;
  /** §15: derives ExecutionTaskProfile from a Work Item (no new authority). */
  readonly taskProfileBuilder: ExecutionTaskProfileBuilderLike;
  /** §6: provider capability source — @modules/agents AgentProviderRegistryService. */
  readonly agentProviderRegistry: AgentProviderRegistryLike;
  /** §14: historical performance evidence from WORK-032 benchmark. */
  readonly benchmarkEvidenceProvider: BenchmarkEvidenceProviderLike;
  /** §31/§32: org-policy resolver (deferred persistence — §32). */
  readonly orgPolicyResolver?: OrgPolicyResolverLike;
}

// Local structural interfaces so this file does NOT import the service files
// (avoid a cycle: service files import these types). They are structurally
// compatible with the public service interfaces in ../types.ts.

export interface ExecutionEligibilityServiceLike {
  evaluate(input: import('../types.js').EligibilityEvaluationInput): import('../types.js').ExecutionEligibilityResult;
}

export interface ExecutionRecommendationServiceLike {
  rank(input: import('../types.js').RankInput): import('../types.js').RankResult;
}

export interface ExecutionTaskProfileBuilderLike {
  build(workItemId: string): Promise<import('../types.js').ExecutionTaskProfile>;
}

export interface AgentProviderRegistryLike {
  getExecutionProviders(projectId?: string): Promise<readonly {
    name: string;
    provider: string;
    model: string;
    nativeApi: 'ready' | 'not-configured';
    externalUi: 'available' | 'not-supported';
    capabilities?: {
      conversationalChat: 'ready' | 'unverified' | 'not-available';
      codingAgent: 'ready' | 'unverified' | 'not-available';
      implementationSurface: 'conversational-chat' | 'coding-agent';
    };
  }[]>;
  isExternalProviderSupported(provider: string, projectId?: string): Promise<boolean>;
}

export interface BenchmarkEvidenceProviderLike {
  /** §14: aggregate historical performance for a (provider, mode) cell across experiments. */
  historicalPerformanceForCell(projectId: string, provider: string, mode: 'native' | 'external'): Promise<import('../types.js').HistoricalPerformance>;
  /** §14: aggregate across all eligible cells for a project (for the overall recommendation evidence). */
  aggregateForProject(projectId: string): Promise<import('../types.js').HistoricalPerformance>;
}

/** §32: resolved org policy (persistence deferred; resolved via composition root). */
export interface ResolvedOrgPolicy {
  readonly allowedProviders: readonly string[];
  readonly allowedExecutionModes: readonly ('native' | 'external')[];
  readonly externalExecutionAllowed: boolean;
  readonly maximumCostCents: number | null;
  readonly requiredPrivacyLevel: string | null;
}

export interface OrgPolicyResolverLike {
  resolve(organizationId: string): Promise<ResolvedOrgPolicy>;
}
