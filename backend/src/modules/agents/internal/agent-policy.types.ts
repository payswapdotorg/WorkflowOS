/**
 * WORK-037: Agent Policy and Permissions — the durable execution-policy
 * authority BEHIND the WORK-036 ToolPolicyGate seam.
 *
 * THE INVARIANT (the one-way dependency the static-architecture checks
 * enforce):
 *
 *   Auth / Project Authorization
 *             ↓
 *        Execution Policy          ← this engine (agent-capability policy)
 *             ↓
 *        Tool Runtime              ← WORK-036 (frozen; unchanged by WORK-037)
 *             ↓
 *   Sandboxed Tool Executor        ← WORK-036 process sandbox
 *
 *   NO reverse dependency: the engine never imports workflow, verification,
 *   review, github, work-items, or authorization modules. Only the ROUTE
 *   layer calls requireProjectAuthorization — to gate WHICH USERS may
 *   resolve approvals / mutate policy documents (project authorization,
 *   WORK-002). The engine decides WHAT AGENTS MAY DO (execution-specific
 *   policy). These are two separate concerns; the engine is the second.
 *
 * THE DECISION VOCABULARY (frozen by WORK-036; reused, NOT extended):
 *   allow       — execute.
 *   deny        — refuse; the runtime observes a durable 'blocked' record.
 *   ask         — not executable without human approval; the engine ensures
 *                 a pending approval (idempotent on execution+subject) and
 *                 the runtime observes 'blocked'. A later invocation of the
 *                 SAME subject resolves to allow ONLY when an approved
 *                 (unexpired) approval exists; otherwise it stays ask.
 *                 NEVER silently allow.
 *   constrained — execute under tighter limits (timeoutMs / maxOutputBytes)
 *                 or read-only (mutating families blocked). The runtime's
 *                 applyConstraints() + isMutating() enforce this against
 *                 the existing ToolExecutorContext — NO second permission
 *                 system, NO executor changes.
 *
 * THE FOUR CONTROL DOMAINS (the rule subjects):
 *   tool        — family + operation (filesystem/terminal/git/package/
 *                 http/browser). The finest selector.
 *   network     — outbound network invocations (http.*, browser.*). An
 *                 optional hostGlob refines the match
 *                 (e.g. '*.github.com' matches 'api.github.com').
 *   secrets     — credential-bearing invocations (the redacted input
 *                 contains the [REDACTED] marker — the gate sees only the
 *                 REDACTED input, never raw secrets; detection is by
 *                 presence of the marker, structural, no denylist).
 *   deployment  — structurally identifiable publication actions: git
 *                 remote-mutating subcommands (push/pull/fetch/clone/
 *                 remote/…) and package 'publish' commands. Terminal
 *                 argv is NOT classifiable (documented honestly — control
 *                 terminal via tool-domain rules, not deployment-class).
 *   external    — external handoff eligibility (evaluated at handoff
 *                 issuance, NOT during native invocation). A native
 *                 invocation never matches an 'external' rule; an external
 *                 rule never matches a native tool rule.
 *
 * EVALUATION (DETERMINISTIC, documented):
 *   1. Tag the invocation: which domains it touches (always 'tool';
 *      'network' for http/browser; 'secrets' if redacted-marker present;
 *      'deployment' if structurally identifiable publication).
 *   2. Walk the document rules IN ORDER. FIRST match decides (the policy
 *      author owns precedence — no hidden deny/allow override semantics).
 *   3. No match → document.defaultEffect (∈ {allow, deny, ask}).
 *   4. If the decision is 'ask': resolve approvals for
 *      (execution_id, subject_key) —
 *        approved + unexpired → 'allow' (reason cites the approval id +
 *          resolver);
 *        denied → 'deny' (a human denial is durable for that subject;
 *          reason cites the denial);
 *        pending → 'ask' (the existing pending row; idempotent — no
 *          duplicate pending request under concurrent asks);
 *        absent → create a pending row (idempotent under the partial
 *          unique index) → 'ask'.
 *   5. FAIL CLOSED: any repository error or unresolvable scope → 'deny'
 *      with reason 'agent-policy-unavailable' / 'agent-policy-scope-
 *      unresolvable'. The runtime records the blocked observation + audits.
 *      NEVER silently allow.
 *
 * Every decision reason carries the policy version + matched rule id (or
 * 'default') so the durable observation record (policy:{decision,reason})
 * is self-describing audit evidence: 'agent-policy v12/secrets-ask:
 * credential-bearing invocation requires approval (apr_…)'.
 *
 * SCOPE RESOLUTION + PRECEDENCE:
 *   execution → project → organization. The effective document is the
 *   PROJECT override if present, else the ORGANIZATION default, else the
 *   PLATFORM DEFAULT document (version 0 — the safe out-of-box posture).
 *
 * PERSISTENCE (migration 0037):
 *   wfos_agent_policies         — versioned documents (org/project scope).
 *   wfos_agent_policy_approvals — the durable ask interaction.
 *   Decisions are NOT duplicated into a new table — they are durable
 *   evidence in the EXISTING ExecutionSession observation records
 *   (policy:{decision,reason}) — no parallel tool-decision store.
 *
 * NOT IN SCOPE (explicitly):
 *   - WORK-038+ (existing-project onboarding) — the engine is ready; the
 *     ingestion of external tool observations lands when those flows exist.
 *   - WORK-043 (execution eligibility/constraint engine) — that is
 *     execution-candidate eligibility (provider selection); this is
 *     agent-capability policy. They compose; they do not overlap.
 *   - WORK-046 (multi-agent delegation) — the engine is per-execution;
 *     delegation composes per-delegate execution policies later.
 *   - No workflow-state mutation, no second ExecutionService, no provider
 *     SDK branches, no GitHub authority, no credential storage.
 */
import type { ToolFamily } from '@platform/tools/tool-contracts.js';
import type {
  ToolPolicyConstraints,
  ToolPolicyDecisionValue,
} from './tool-runtime.types.js';

// ============================================================================
// §domains — the four control domains + the external-handoff subject
// ============================================================================

export type AgentPolicyDomain = 'tool' | 'network' | 'secrets' | 'deployment' | 'external';

export const AGENT_POLICY_DOMAINS: readonly AgentPolicyDomain[] = [
  'tool',
  'network',
  'secrets',
  'deployment',
  'external',
] as const;

// ============================================================================
// §document — the versioned policy configuration
// ============================================================================

/**
 * A single policy rule. Exactly one selector domain (the rule matches
 * invocations tagged with that domain); family / operations / hostGlob are
 * optional refinements.
 *
 *   tool-domain rule:        family + optional operations
 *   network-domain rule:    optional hostGlob (no hostGlob = all network)
 *   secrets-domain rule:    matches any credential-bearing invocation
 *   deployment-domain rule: matches structurally identifiable publication
 *   external-domain rule:  matches external-handoff eligibility evaluation
 *
 * Evaluation is FIRST-MATCH-WINS over the ordered rules list — the policy
 * author owns precedence (no hidden deny/allow override semantics).
 */
export interface AgentPolicyRule {
  /** Stable rule id (audit/reason reference); [a-z0-9-]{1,64}; unique in the document. */
  readonly id: string;
  readonly domain: AgentPolicyDomain;
  /** tool-domain refinement (the family). Ignored for non-tool domains unless also set. */
  readonly family?: ToolFamily;
  /** Operation-label refinement (e.g. 'terminal.exec', 'http.POST', 'git.push'). */
  readonly operations?: readonly string[];
  /** network-domain refinement: a host glob ('*' = any label, '*.github.com' = subdomain). */
  readonly hostGlob?: string;
  readonly effect: ToolPolicyDecisionValue;
  /** Required for 'constrained' (validated); ignored otherwise. */
  readonly constraints?: ToolPolicyConstraints;
  readonly reason?: string;
}

/**
 * A policy document. The unit of configuration persisted per scope
 * (organization default OR project override).
 */
export interface AgentPolicyDocument {
  readonly description?: string;
  /** Ordered; FIRST match decides. Bounded (≤ 100 rules). */
  readonly rules: readonly AgentPolicyRule[];
  /** Applied when NO rule matches. Required (the author owns the fail posture). */
  readonly defaultEffect: 'allow' | 'deny' | 'ask';
}

/** Where the effective document came from (audit provenance). */
export type AgentPolicyScopeSource = 'project' | 'organization' | 'platform-default';

export interface AgentPolicyResolution {
  readonly source: AgentPolicyScopeSource;
  readonly document: AgentPolicyDocument;
  /** 0 for the platform default; otherwise the persisted policy_version. */
  readonly policyVersion: number;
  readonly organizationId: string;
  readonly projectId: string | null;
}

// ============================================================================
// §approvals — the durable ASK interaction
// ============================================================================

export type AgentPolicyApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface AgentPolicyApproval {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly executionId: string;
  readonly subjectDomain: AgentPolicyDomain;
  readonly subjectFamily: string | null;
  readonly subjectOperation: string | null;
  readonly subjectHost: string | null;
  readonly subjectKey: string;
  readonly ruleId: string;
  readonly policyVersion: number;
  readonly status: AgentPolicyApprovalStatus;
  readonly requestedAt: string;
  readonly requestedReason: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  readonly expiresAt: string | null;
}

/** The resolved scope for an execution (read-only resolution). */
export interface AgentPolicyScope {
  readonly organizationId: string;
  readonly projectId: string;
}

// ============================================================================
// §repository — the persistence port (pg implementation internal)
// ============================================================================

export interface AgentPolicyRepository {
  /** Resolve (organizationId, projectId) for an execution (execution→project→org). */
  resolveScope(executionId: string): Promise<AgentPolicyScope | null>;
  /** The effective document + scope source (project override → org → platform default). */
  getEffectivePolicy(organizationId: string, projectId: string): Promise<AgentPolicyResolution | null>;
  getProjectPolicy(organizationId: string, projectId: string): Promise<AgentPolicyResolution | null>;
  getOrganizationPolicy(organizationId: string): Promise<AgentPolicyResolution | null>;
  /** Upsert the project override; bumps policy_version. Returns the new resolution. */
  setProjectPolicy(input: {
    organizationId: string;
    projectId: string;
    document: AgentPolicyDocument;
    userId: string;
  }): Promise<AgentPolicyResolution>;
  clearProjectPolicy(organizationId: string, projectId: string): Promise<boolean>;
  setOrganizationPolicy(input: {
    organizationId: string;
    document: AgentPolicyDocument;
    userId: string;
  }): Promise<AgentPolicyResolution>;
  clearOrganizationPolicy(organizationId: string): Promise<boolean>;
  /** The latest approval for (execution, subject) — any status. */
  getLatestApproval(executionId: string, subjectKey: string): Promise<AgentPolicyApproval | null>;
  /** A single approval by id (for the resolve-endpoint authorization check). */
  getApproval(approvalId: string): Promise<AgentPolicyApproval | null>;
  /** Idempotent pending creation (partial unique index on pending). Returns the row (existing or new). */
  ensurePendingApproval(input: {
    organizationId: string;
    projectId: string;
    executionId: string;
    subjectDomain: AgentPolicyDomain;
    subjectFamily: string | null;
    subjectOperation: string | null;
    subjectHost: string | null;
    subjectKey: string;
    ruleId: string;
    policyVersion: number;
    requestedReason: string | null;
    expiresAt: string | null;
  }): Promise<AgentPolicyApproval>;
  /** List approvals (optionally filtered by status) for a project. */
  listApprovals(projectId: string, status?: AgentPolicyApprovalStatus): Promise<readonly AgentPolicyApproval[]>;
  /** Resolve (approve/deny) a pending approval; idempotent — a resolved approval is terminal. */
  resolve(input: {
    approvalId: string;
    action: 'approve' | 'deny';
    userId: string;
    note?: string;
  }): Promise<AgentPolicyApproval>;
  /** Lazily flip an expired approval to 'expired' (called when a row is past expiresAt). */
  markExpired(approvalId: string): Promise<void>;
}

// ============================================================================
// §engine — the ToolPolicyGate implementation + the management surface
// ============================================================================

/** The external-handoff eligibility decision (advisory to the route/decorator). */
export interface AgentPolicyExternalDecision {
  readonly decision: ToolPolicyDecisionValue;
  readonly reason: string;
  readonly policyVersion: number;
  readonly scopeSource: AgentPolicyScopeSource;
  readonly constraints?: ToolPolicyConstraints;
  /** The approval id referenced (for 'ask' — the pending row; for 'allow' after approval — the approved row). */
  readonly approvalId?: string;
}

export interface AgentPolicyEngineDeps {
  readonly repository: AgentPolicyRepository;
  readonly auditWriter?: Pick<import('@modules/audit/index.js').AuditEventWriter, 'write'>;
  readonly logger: import('@platform/logger.js').Logger;
  /** Approval TTL ms (default 24h; 0 = no expiry). */
  readonly approvalTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

// ============================================================================
// §service — the route-facing management surface (the engine implements it)
// ============================================================================
//
// The api layer may not import from modules/agents/internal (PLAT-AC-02).
// This interface is the sanctioned route-facing surface: the route depends
// on the INTERFACE (exported from the @modules/agents barrel, types only);
// the composition root (app.ts) injects the concrete AgentPolicyEngine,
// which satisfies the interface structurally. The engine class itself
// stays internal — wired only by app.ts (the composition root is exempt
// from the api-layer internal-import rule).
export interface AgentPolicyService {
  getEffectivePolicy(organizationId: string, projectId: string): Promise<AgentPolicyResolution>;
  getProjectPolicy(organizationId: string, projectId: string): Promise<AgentPolicyResolution | null>;
  getOrganizationPolicy(organizationId: string): Promise<AgentPolicyResolution | null>;
  setProjectPolicy(input: {
    organizationId: string;
    projectId: string;
    document: AgentPolicyDocument;
    userId: string;
  }): Promise<AgentPolicyResolution>;
  clearProjectPolicy(organizationId: string, projectId: string, userId: string): Promise<boolean>;
  setOrganizationPolicy(input: {
    organizationId: string;
    document: AgentPolicyDocument;
    userId: string;
  }): Promise<AgentPolicyResolution>;
  clearOrganizationPolicy(organizationId: string, userId: string): Promise<boolean>;
  getApproval(approvalId: string): Promise<AgentPolicyApproval | null>;
  listApprovals(projectId: string, status?: AgentPolicyApprovalStatus): Promise<readonly AgentPolicyApproval[]>;
  resolveApproval(input: {
    approvalId: string;
    action: 'approve' | 'deny';
    userId: string;
    note?: string;
  }): Promise<AgentPolicyApproval>;
}

// ============================================================================
// §errors — the stable error hierarchy (WORK-034/035 discriminated-class pattern)
// ============================================================================

export const AGENT_POLICY_ERROR_CODES = [
  'agent-policy-invalid-document',
  'agent-policy-approval-not-found',
  'agent-policy-approval-already-resolved',
  'agent-policy-approval-not-pending',
  'agent-policy-scope-unresolvable',
] as const;

export type AgentPolicyErrorCode = (typeof AGENT_POLICY_ERROR_CODES)[number];

export class AgentPolicyError extends Error {
  readonly code: AgentPolicyErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  constructor(
    code: AgentPolicyErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AgentPolicyError';
    this.code = code;
    this.context = context;
  }
}

// ============================================================================
// §platform-default — the safe out-of-box posture
// ============================================================================
//
// The sandbox (WORK-036) already provides the kernel boundary (worktree
// confinement, no network for processes, no host access). This policy layer
// is ORGANIZATIONAL/EXECUTION control on top of that. The platform default
// is permissive for read-oriented + worktree-confined development and
// conservative for credential-bearing, network-mutating, and
// publication-class actions. Orgs/projects override per their posture.
//
// Version 0 (the platform default is never persisted; its version is 0).
export const PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT: AgentPolicyDocument = Object.freeze({
  description: 'platform-default agent policy (version 0) — safe out-of-box posture',
  rules: Object.freeze([
    Object.freeze({
      id: 'platform-secrets-ask',
      domain: 'secrets',
      effect: 'ask',
      reason: 'credential-bearing tool invocations require approval by default',
    }),
    Object.freeze({
      id: 'platform-deployment-deny',
      domain: 'deployment',
      effect: 'deny',
      reason:
        'publication/remote-mutating actions are not permitted for agents by default — remote authority stays with the /github module',
    }),
    Object.freeze({
      id: 'platform-network-mutating-ask',
      domain: 'network',
      operations: ['http.POST', 'http.PUT', 'http.PATCH', 'http.DELETE', 'browser.click', 'browser.type'],
      effect: 'ask',
      reason: 'mutating outbound network actions require approval by default',
    }),
    Object.freeze({
      id: 'platform-terminal-constrained',
      domain: 'tool',
      family: 'terminal',
      effect: 'constrained',
      constraints: { timeoutMs: 120_000 },
      reason: 'terminal invocations run under a bounded timeout by default',
    }),
    Object.freeze({
      id: 'platform-package-constrained',
      domain: 'tool',
      family: 'package',
      effect: 'constrained',
      constraints: { timeoutMs: 300_000 },
      reason: 'package/test invocations run under a bounded timeout by default',
    }),
  ]),
  defaultEffect: 'allow',
});

// Re-export the seam types the engine implements (so consumers import from
// one place) — without mutating the frozen seam.
export type {
  ToolPolicyGate,
  ToolPolicyRequest,
  ToolPolicyDecision,
  ToolPolicyDecisionValue,
  ToolPolicyConstraints,
} from './tool-runtime.types.js';
