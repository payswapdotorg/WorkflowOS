/**
 * WORK-037: AgentPolicyEngine — the permission engine behind the WORK-036
 * ToolPolicyGate seam. Implements ToolPolicyGate.decide() (native
 * invocations) + evaluateExternalHandoff() (external handoff eligibility)
 * + the durable ASK interaction + versioned document CRUD.
 *
 * SEE agent-policy.types.ts for the invariant, the decision vocabulary,
 * the four control domains, and the evaluation contract. This file is the
 * implementation.
 *
 * The runtime (DefaultToolRuntime) is UNCHANGED: it calls decide() before
 * any executor; deny/ask → blocked; constrained → applyConstraints +
 * readOnly. The engine slots in via the composition root (app.ts wires it
 * as the runtime's policyGate; DefaultToolPolicyGate is no longer wired in
 * production).
 *
 * FAIL CLOSED: any repository error or unresolvable scope → 'deny' with a
 * reason that names the failure. The runtime records the blocked
 * observation + audits. NEVER silently allow.
 */
import type { ToolFamily } from '@platform/tools/tool-contracts.js';
import { REDACTED } from '@platform/tools/observation-redaction.js';
// WORK-037 PR-#41 FIX: the CANONICAL git argv classifier — ONE vocabulary
// shared by the policy engine (here, deployment-domain tagging) and the
// process executor (remote-network rejection). Git permits global/config
// options BEFORE the effective subcommand (e.g. `git -c k=v push`), so a
// positional args[0] check could misclassify a remote mutation as ordinary
// `tool` activity → allow/constrained instead of the required deployment
// deny. The classifier skips git's global options to find the effective
// subcommand. Lives in @platform/tools (the correct one-way dependency
// direction: Execution Policy → Tool Runtime).
import { isGitDeploymentInvocation } from '@platform/tools/git-argv.js';
// WORK-037 PR-#41 FIX (round 2): the CANONICAL package-command classifier —
// the package-family twin of the git argv classifier. Package runners
// (npm/pnpm/yarn/bun) permit global/config options BEFORE the effective
// subcommand (e.g. `npm --registry=<url> publish`), so a positional
// args[0] check could misclassify a REGISTRY publication as ordinary
// `tool` activity → allow/constrained instead of the required deployment
// deny. The classifier skips the runner's global options to find the
// effective subcommand + fails-closed on ambiguity. ONE vocabulary shared
// with the process executor (publish-rejection governance gate) — a
// mismatch would let policy-allow what the executor rejects, or vice
// versa. Lives in @platform/tools (the same one-way dependency direction).
import { isPackageDeploymentInvocation } from '@platform/tools/package-argv.js';
import type {
  AgentPolicyApproval,
  AgentPolicyApprovalStatus,
  AgentPolicyDocument,
  AgentPolicyDomain,
  AgentPolicyEngineDeps,
  AgentPolicyExternalDecision,
  AgentPolicyRepository,
  AgentPolicyResolution,
  AgentPolicyRule,
  AgentPolicyScopeSource,
} from './agent-policy.types.js';
import {
  AGENT_POLICY_DOMAINS,
  AgentPolicyError,
  PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT,
} from './agent-policy.types.js';
import type {
  ToolPolicyConstraints,
  ToolPolicyDecision,
  ToolPolicyDecisionValue,
  ToolPolicyGate,
  ToolPolicyRequest,
} from './tool-runtime.types.js';

const TOOL_FAMILIES: readonly ToolFamily[] = [
  'filesystem',
  'terminal',
  'git',
  'package',
  'http',
  'browser',
];

// Git deployment classification is OWNED by the canonical classifier in
// @platform/tools/git-argv.ts (isGitDeploymentInvocation) — shared with the
// WORK-036 process executor's remote-network rejection. There is NO local
// copy of the deployment-subcommand set here (a mismatch would let policy
// tag deployment where the executor would NOT reject, or vice versa).

const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const RULE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const MAX_RULES = 100;
const MAX_DESC = 500;
const MAX_REASON = 500;

/** The invocation tags the matcher inspects (computed from the redacted input). */
interface InvocationTags {
  readonly family: ToolFamily | undefined;
  readonly operation: string;
  readonly domains: ReadonlySet<AgentPolicyDomain>;
  readonly host: string | null;
  readonly secretBearing: boolean;
}

/** The synthetic external-handoff tags (domain 'external' only). */
const EXTERNAL_TAGS: InvocationTags = {
  family: undefined,
  operation: '',
  domains: new Set<AgentPolicyDomain>(['external']),
  host: null,
  secretBearing: false,
};

interface MatchResult {
  readonly effect: ToolPolicyDecisionValue | AgentPolicyApprovalStatus; // the rule effect or the document default
  readonly rule: AgentPolicyRule | null;
  readonly ruleDomain: AgentPolicyDomain | null;
  readonly defaultMatched: boolean;
}

export class AgentPolicyEngine implements ToolPolicyGate {
  private readonly approvalTtlMs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: AgentPolicyEngineDeps) {
    this.approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.now = deps.now ?? (() => new Date());
  }

  // ====================================================================
  // ToolPolicyGate.decide — the native invocation seam
  // ====================================================================

  async decide(request: ToolPolicyRequest): Promise<ToolPolicyDecision> {
    try {
      const scope = await this.deps.repository.resolveScope(request.executionId);
      if (!scope) {
        return this.failClosed(
          'agent-policy-scope-unresolvable',
          `execution ${request.executionId} has no resolvable project/organization scope — the policy gate cannot determine authority`,
          { executionId: request.executionId, invocationId: request.invocationId },
        );
      }
      const resolution = await this.deps.repository.getEffectivePolicy(
        scope.organizationId,
        scope.projectId,
      );
      const document = resolution?.document ?? PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT;
      const version = resolution?.policyVersion ?? 0;
      const tags = tagInvocation(request);
      const match = matchDocument(document, tags);

      if (match.effect === 'ask') {
        return this.resolveAsk(scope, request, tags, match, version, document);
      }
      if (match.effect === 'constrained') {
        const constraints: ToolPolicyConstraints = match.rule?.constraints ?? {};
        return {
          decision: 'constrained',
          constraints,
          reason: reasonFor(version, match, 'constrained by policy'),
        };
      }
      return {
        decision: match.effect as 'allow' | 'deny',
        reason: reasonFor(version, match, undefined),
      };
    } catch (err) {
      this.deps.logger.warn('agent-policy.decide-failed', {
        executionId: request.executionId,
        invocationId: request.invocationId,
        error: (err as Error).message,
      });
      return this.failClosed(
        'agent-policy-unavailable',
        `the policy gate could not resolve a decision (${(err as Error).message}) — failing closed`,
        { executionId: request.executionId, invocationId: request.invocationId },
      );
    }
  }

  // ====================================================================
  // External handoff eligibility (advisory to the handoff decorator)
  // ====================================================================

  async evaluateExternalHandoff(input: { executionId: string }): Promise<AgentPolicyExternalDecision> {
    try {
      const scope = await this.deps.repository.resolveScope(input.executionId);
      if (!scope) {
        return this.failClosedExternal(
          'agent-policy-scope-unresolvable',
          `execution ${input.executionId} has no resolvable scope — external handoff denied (fail-closed)`,
        );
      }
      const resolution = await this.deps.repository.getEffectivePolicy(
        scope.organizationId,
        scope.projectId,
      );
      const document = resolution?.document ?? PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT;
      const version = resolution?.policyVersion ?? 0;
      const source = resolution?.source ?? 'platform-default';
      const match = matchDocument(document, EXTERNAL_TAGS);

      if (match.effect === 'ask') {
        const subjectKey = subjectKeyFor('external', EXTERNAL_TAGS);
        const approval = await this.consultApproval(scope, input.executionId, subjectKey, 'external', match, version);
        if (approval && approval.status === 'approved' && !this.isExpired(approval)) {
          return {
            decision: 'allow',
            reason: reasonFor(version, match, `external handoff approved by ${approval.resolvedBy ?? 'unknown'} (approval ${approval.id})`),
            policyVersion: version,
            scopeSource: source,
            approvalId: approval.id,
          };
        }
        if (approval && approval.status === 'denied') {
          return {
            decision: 'deny',
            reason: reasonFor(version, match, `external handoff denied by ${approval.resolvedBy ?? 'unknown'} (approval ${approval.id})`),
            policyVersion: version,
            scopeSource: source,
            approvalId: approval.id,
          };
        }
        // pending or absent → ensure pending, return ask
        const pending =
          approval && approval.status === 'pending'
            ? approval
            : await this.ensurePending(scope, input.executionId, subjectKey, 'external', match, version, null);
        await this.auditExternal(input.executionId, scope, version, 'ask', pending.id);
        return {
          decision: 'ask',
          reason: reasonFor(version, match, `external handoff requires approval (approval ${pending.id} pending — resolve via /api/projects/:projectId/agent-policy/approvals/:id/resolve)`),
          policyVersion: version,
          scopeSource: source,
          approvalId: pending.id,
        };
      }
      if (match.effect === 'constrained') {
        return {
          decision: 'constrained',
          reason: reasonFor(version, match, 'external handoff under constraints'),
          policyVersion: version,
          scopeSource: source,
          constraints: match.rule?.constraints ?? {},
        };
      }
      await this.auditExternal(input.executionId, scope, version, match.effect as string, undefined);
      return {
        decision: match.effect as 'allow' | 'deny',
        reason: reasonFor(version, match, undefined),
        policyVersion: version,
        scopeSource: source,
      };
    } catch (err) {
      this.deps.logger.warn('agent-policy.evaluate-external-failed', {
        executionId: input.executionId,
        error: (err as Error).message,
      });
      return this.failClosedExternal(
        'agent-policy-unavailable',
        `the policy gate could not evaluate external handoff eligibility (${(err as Error).message}) — failing closed`,
      );
    }
  }

  // ====================================================================
  // The ASK resolution + pending-creation path (shared by native + external)
  // ====================================================================

  private async resolveAsk(
    scope: { organizationId: string; projectId: string },
    request: ToolPolicyRequest,
    tags: InvocationTags,
    match: MatchResult,
    version: number,
    _document: AgentPolicyDocument,
  ): Promise<ToolPolicyDecision> {
    const subjectDomain: AgentPolicyDomain = match.rule ? (match.ruleDomain ?? 'tool') : 'tool';
    const subjectKey = subjectKeyFor(subjectDomain, tags);
    const approval = await this.consultApproval(scope, request.executionId, subjectKey, subjectDomain, match, version);

    if (approval && approval.status === 'approved' && !this.isExpired(approval)) {
      return {
        decision: 'allow',
        reason: reasonFor(
          version,
          match,
          `approved by ${approval.resolvedBy ?? 'unknown'} (approval ${approval.id})`,
        ),
      };
    }
    if (approval && approval.status === 'denied') {
      return {
        decision: 'deny',
        reason: reasonFor(
          version,
          match,
          `denied by ${approval.resolvedBy ?? 'unknown'} (approval ${approval.id}) — a human denial is durable for this subject`,
        ),
      };
    }
    // pending or absent (or expired-but-still-pending-lazily) → ensure pending
    const pending =
      approval && approval.status === 'pending' && !this.isExpired(approval)
        ? approval
        : await this.ensurePending(scope, request.executionId, subjectKey, subjectDomain, match, version, tags.host);
    return {
      decision: 'ask',
      reason: reasonFor(
        version,
        match,
        `approval ${pending.id} pending — resolve via /api/projects/:projectId/agent-policy/approvals/:id/resolve (action: approve | deny)`,
      ),
    };
  }

  /** Look up the latest approval for a subject; enforce the binding contract. */
  private async consultApproval(
    scope: { organizationId: string; projectId: string },
    executionId: string,
    subjectKey: string,
    _subjectDomain: AgentPolicyDomain,
    match: MatchResult,
    version: number,
  ): Promise<AgentPolicyApproval | null> {
    void scope;
    const latest = await this.deps.repository.getLatestApproval(executionId, subjectKey);
    if (!latest) return null;
    // TTL expiry (the lazy path for pending/approved past expiresAt). The
    // markExpired UPDATE is CAS-guarded on status IN ('pending','approved')
    // AND expires_at < NOW(); idempotent under concurrent consults.
    if (this.isExpired(latest) && (latest.status === 'pending' || latest.status === 'approved')) {
      await this.deps.repository.markExpired(latest.id);
      // Treat as absent — a NEW pending will be created (the unique index
      // slot is freed by the CAS flip to 'expired').
      return null;
    }
    // THE APPROVAL-BINDING CONTRACT (architect's PR-#41 review):
    // an approval authorizes the CURRENT invocation ONLY when its
    // (policyVersion, ruleId) match the policy decision the engine just
    // produced. A material policy change (rule replacement, version bump,
    // default-posture change) supersedes prior approvals for the same
    // subject — the engine re-asks under the new policy rather than
    // silently carrying a stale approval across the change.
    const expectedRuleId = match.rule?.id ?? 'default';
    if (latest.policyVersion !== version || latest.ruleId !== expectedRuleId) {
      // Stale evidence under a prior policy. For a stale PENDING, supersede
      // it so the partial unique index on (execution_id, subject_key) WHERE
      // status='pending' frees the slot for the NEW (version, ruleId)
      // pending the engine is about to create. The CAS predicate
      // (status='pending') makes concurrent supersedes idempotent.
      // Approved/denied stale rows are NOT mutated — they are terminal
      // evidence under the prior policy; the engine treats them as
      // not-authoritative for this invocation but does not rewrite their
      // status (the audit history of the prior resolution stays intact).
      if (latest.status === 'pending') {
        await this.deps.repository.supersedePendingApproval(latest.id);
      }
      return null;
    }
    return latest;
  }

  private async ensurePending(
    scope: { organizationId: string; projectId: string },
    executionId: string,
    subjectKey: string,
    subjectDomain: AgentPolicyDomain,
    match: MatchResult,
    version: number,
    host: string | null,
  ): Promise<AgentPolicyApproval> {
    const expiresAt = this.approvalTtlMs > 0 ? new Date(this.now().getTime() + this.approvalTtlMs).toISOString() : null;
    const { approval, created } = await this.deps.repository.ensurePendingApproval({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      executionId,
      subjectDomain,
      subjectFamily: match.rule ? inferFamilyFromSubject(subjectDomain, match.rule) : null,
      subjectOperation: match.rule?.operations?.[0] ?? null,
      subjectHost: host,
      subjectKey,
      ruleId: match.rule?.id ?? 'default',
      policyVersion: version,
      requestedReason: match.rule?.reason ?? null,
      expiresAt,
    });
    // The architect's PR-#41 review: only the CREATOR of the pending row
    // emits the 'agent-policy.approval-requested' audit event. A concurrent
    // ask that found the existing pending (created=false) does NOT emit a
    // duplicate — exactly ONE audit evidence row per pending DB row.
    if (created) {
      await this.auditApprovalEvent('agent-policy.approval-requested', scope, approval);
    } else {
      this.deps.logger.debug('agent-policy.pending-reused', {
        executionId,
        subjectKey,
        approvalId: approval.id,
      });
    }
    return approval;
  }

  // ====================================================================
  // Document CRUD (the management surface; delegates + validates)
  // ====================================================================

  async getEffectivePolicy(organizationId: string, projectId: string): Promise<AgentPolicyResolution> {
    const res = await this.deps.repository.getEffectivePolicy(organizationId, projectId);
    if (res) return res;
    return {
      source: 'platform-default',
      document: PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT,
      policyVersion: 0,
      organizationId,
      projectId,
    };
  }

  async setProjectPolicy(input: {
    organizationId: string;
    projectId: string;
    document: AgentPolicyDocument;
    userId: string;
  }): Promise<AgentPolicyResolution> {
    validateDocument(input.document);
    const res = await this.deps.repository.setProjectPolicy(input);
    await this.auditDocEvent('agent-policy.document-updated', res, input.userId, 'project');
    return res;
  }

  async clearProjectPolicy(organizationId: string, projectId: string, userId: string): Promise<boolean> {
    const removed = await this.deps.repository.clearProjectPolicy(organizationId, projectId);
    if (removed) {
      await this.auditDocEvent(
        'agent-policy.document-removed',
        { source: 'project', document: PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT, policyVersion: 0, organizationId, projectId },
        userId,
        'project',
      );
    }
    return removed;
  }

  async setOrganizationPolicy(input: {
    organizationId: string;
    document: AgentPolicyDocument;
    userId: string;
  }): Promise<AgentPolicyResolution> {
    validateDocument(input.document);
    const res = await this.deps.repository.setOrganizationPolicy(input);
    await this.auditDocEvent('agent-policy.document-updated', res, input.userId, 'organization');
    return res;
  }

  async clearOrganizationPolicy(organizationId: string, userId: string): Promise<boolean> {
    const removed = await this.deps.repository.clearOrganizationPolicy(organizationId);
    if (removed) {
      await this.auditDocEvent(
        'agent-policy.document-removed',
        { source: 'organization', document: PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT, policyVersion: 0, organizationId, projectId: null },
        userId,
        'organization',
      );
    }
    return removed;
  }

  async getProjectPolicy(organizationId: string, projectId: string): Promise<AgentPolicyResolution | null> {
    return this.deps.repository.getProjectPolicy(organizationId, projectId);
  }

  async getOrganizationPolicy(organizationId: string): Promise<AgentPolicyResolution | null> {
    return this.deps.repository.getOrganizationPolicy(organizationId);
  }

  async getApproval(approvalId: string): Promise<AgentPolicyApproval | null> {
    return this.deps.repository.getApproval(approvalId);
  }

  async listApprovals(
    projectId: string,
    status?: AgentPolicyApprovalStatus,
  ): Promise<readonly AgentPolicyApproval[]> {
    return this.deps.repository.listApprovals(projectId, status);
  }

  async resolveApproval(input: {
    approvalId: string;
    action: 'approve' | 'deny';
    userId: string;
    note?: string;
  }): Promise<AgentPolicyApproval> {
    const resolved = await this.deps.repository.resolve(input);
    await this.auditApprovalEvent(
      `agent-policy.approval-${resolved.status}`,
      { organizationId: resolved.organizationId, projectId: resolved.projectId },
      resolved,
    );
    return resolved;
  }

  // ====================================================================
  // helpers
  // ====================================================================

  private isExpired(approval: AgentPolicyApproval): boolean {
    if (!approval.expiresAt) return false;
    return this.now().getTime() >= new Date(approval.expiresAt).getTime();
  }

  private failClosed(code: string, message: string, context: Record<string, unknown>): ToolPolicyDecision {
    void context;
    this.deps.logger.warn('agent-policy.fail-closed', { code, message });
    return { decision: 'deny', reason: `agent-policy v0/${code}: ${message}` };
  }

  private failClosedExternal(code: string, message: string): AgentPolicyExternalDecision {
    this.deps.logger.warn('agent-policy.fail-closed', { code, message });
    return {
      decision: 'deny',
      reason: `agent-policy v0/${code}: ${message}`,
      policyVersion: 0,
      scopeSource: 'platform-default',
    };
  }

  private async auditApprovalEvent(
    eventType: string,
    scope: { organizationId: string; projectId: string },
    approval: AgentPolicyApproval,
  ): Promise<void> {
    if (!this.deps.auditWriter) return;
    try {
      await this.deps.auditWriter.write({
        eventType,
        actor: 'agent-policy',
        source: 'agents/agent-policy',
        resourceType: 'agent_policy_approval',
        resourceId: approval.id,
        projectId: scope.projectId,
        executionId: approval.executionId,
        metadata: {
          subjectDomain: approval.subjectDomain,
          subjectFamily: approval.subjectFamily,
          subjectOperation: approval.subjectOperation,
          subjectHost: approval.subjectHost,
          subjectKey: approval.subjectKey,
          ruleId: approval.ruleId,
          policyVersion: approval.policyVersion,
          status: approval.status,
          resolvedBy: approval.resolvedBy,
          expiresAt: approval.expiresAt,
        },
      });
    } catch (err) {
      this.deps.logger.warn('agent-policy.audit-failed', { error: (err as Error).message });
    }
  }

  private async auditDocEvent(
    eventType: string,
    res: AgentPolicyResolution,
    userId: string,
    scope: 'project' | 'organization',
  ): Promise<void> {
    if (!this.deps.auditWriter) return;
    try {
      await this.deps.auditWriter.write({
        eventType,
        actor: 'agent-policy',
        source: 'agents/agent-policy',
        resourceType: 'agent_policy_document',
        resourceId: res.organizationId,
        projectId: res.projectId,
        metadata: {
          scope,
          policyVersion: res.policyVersion,
          source: res.source,
          userId,
          ruleCount: res.document.rules.length,
          defaultEffect: res.document.defaultEffect,
        },
      });
    } catch (err) {
      this.deps.logger.warn('agent-policy.audit-failed', { error: (err as Error).message });
    }
  }

  private async auditExternal(
    executionId: string,
    scope: { organizationId: string; projectId: string },
    version: number,
    decision: string,
    approvalId: string | undefined,
  ): Promise<void> {
    if (!this.deps.auditWriter) return;
    try {
      await this.deps.auditWriter.write({
        eventType: 'agent-policy.external-handoff-evaluated',
        actor: 'agent-policy',
        source: 'agents/agent-policy',
        resourceType: 'execution',
        resourceId: executionId,
        projectId: scope.projectId,
        executionId,
        metadata: { decision, policyVersion: version, approvalId },
      });
    } catch (err) {
      this.deps.logger.warn('agent-policy.audit-failed', { error: (err as Error).message });
    }
  }
}

// ============================================================================
// §tagging — compute the invocation's domains from the redacted input
// ============================================================================

function tagInvocation(request: ToolPolicyRequest): InvocationTags {
  const domains = new Set<AgentPolicyDomain>(['tool']);
  let host: string | null = null;
  const secretBearing = containsRedacted(request.input);
  if (secretBearing) domains.add('secrets');

  const family = request.family as ToolFamily | undefined;
  if (family === 'http' || family === 'browser') {
    domains.add('network');
    const urlStr = typeof request.input?.url === 'string' ? (request.input.url as string) : null;
    if (urlStr) {
      try {
        host = new URL(urlStr).hostname.toLowerCase();
      } catch {
        host = null;
      }
    }
  }

  if (family === 'git') {
    // WORK-037 PR-#41 FIX: classify the EFFECTIVE git subcommand via the
    // CANONICAL classifier (shared with the executor). Git permits global
    // / config options BEFORE the effective subcommand (`git -c k=v push`,
    // `git --no-pager push`, `git -C /path push`, `git --git-dir=/foo push`),
    // so a positional args[0] check could classify a REMOTE mutation as
    // ordinary `tool` activity → allow/constrained instead of the required
    // deployment deny. The classifier skips git's global options to find
    // the effective subcommand + fails-closed on ambiguity. This is the
    // POLICY authorization decision (the authority); the sandbox's network
    // isolation is valuable defense-in-depth but does NOT replace it.
    const args = Array.isArray(request.input?.args) ? (request.input.args as readonly string[]) : [];
    if (isGitDeploymentInvocation(args)) domains.add('deployment');
  } else if (family === 'package') {
    // WORK-037 PR-#41 FIX (round 2): classify the EFFECTIVE package
    // subcommand via the CANONICAL classifier (shared with the executor).
    // Package runners (npm/pnpm/yarn/bun) permit global/config options
    // BEFORE the effective subcommand (`npm --registry=<url> publish`,
    // `npm --silent publish`, `pnpm --filter <pkg> publish`,
    // `pnpm -C /path publish`, `yarn --cwd /path publish`), so a positional
    // args[0] check could classify a REGISTRY publication as ordinary
    // `tool` activity → allow/constrained instead of the required
    // deployment deny. The classifier skips the runner's global options to
    // find the effective subcommand + fails-closed on ambiguity. This is
    // the POLICY authorization decision (the authority); the sandbox's
    // network isolation is valuable defense-in-depth but does NOT replace
    // it. The runner gate (publish-capable only) lets non-publish-capable
    // runners (node/npx/tsx/vitest/jest/tsc/…) run `publish` as a script
    // arg without a false deployment-deny.
    const input = request.input as { runner?: unknown; args?: unknown } | undefined;
    const runner = typeof input?.runner === 'string' ? input.runner : '';
    const args = Array.isArray(input?.args) ? (input!.args as readonly string[]) : [];
    if (isPackageDeploymentInvocation(runner, args)) domains.add('deployment');
  }

  return { family, operation: request.operation, domains, host, secretBearing };
}

/** Structural credential-bearing detection: the REDACTED marker is present anywhere in the input. */
function containsRedacted(value: unknown): boolean {
  if (value === REDACTED) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (containsRedacted(v)) return true;
    }
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (containsRedacted(v)) return true;
  }
  return false;
}

// ============================================================================
// §matching — first-match-wins over the ordered rules
// ============================================================================

function matchDocument(document: AgentPolicyDocument, tags: InvocationTags): MatchResult {
  for (const rule of document.rules) {
    if (matchRule(rule, tags)) {
      return {
        effect: rule.effect,
        rule,
        ruleDomain: rule.domain,
        defaultMatched: false,
      };
    }
  }
  return {
    effect: document.defaultEffect,
    rule: null,
    ruleDomain: null,
    defaultMatched: true,
  };
}

function matchRule(rule: AgentPolicyRule, tags: InvocationTags): boolean {
  if (!tags.domains.has(rule.domain)) return false;
  // external-domain rules match the synthetic external tags only (never native).
  if (rule.domain === 'external' && !tags.domains.has('external')) return false;
  if (rule.family && rule.family !== tags.family) return false;
  if (rule.operations && rule.operations.length > 0) {
    if (!tags.operation || !rule.operations.includes(tags.operation)) return false;
  }
  if (rule.hostGlob) {
    if (!tags.host) return false;
    if (!hostGlobMatch(rule.hostGlob, tags.host)) return false;
  }
  return true;
}

/** Simple host glob: '*' matches any single label; '*.github.com' matches 'api.github.com'. */
function hostGlobMatch(glob: string, host: string): boolean {
  const g = glob.toLowerCase();
  const h = host.toLowerCase();
  if (g === h) return true;
  if (g === '*') return true;
  if (g.startsWith('*.')) {
    const suffix = g.slice(1); // '.github.com'
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return false;
}

// ============================================================================
// §subject-key — the stable approval identity
// ============================================================================

function subjectKeyFor(domain: AgentPolicyDomain, tags: InvocationTags): string {
  return `${domain}:${tags.family ?? ''}:${tags.operation ?? ''}:${tags.host ?? ''}`;
}

function inferFamilyFromSubject(_domain: AgentPolicyDomain, rule: AgentPolicyRule): string | null {
  return rule.family ?? null;
}

// ============================================================================
// §reason — every decision reason carries version + rule id (audit evidence)
// ============================================================================

function reasonFor(version: number, match: MatchResult, suffix?: string): string {
  const ruleId = match.rule?.id ?? 'default';
  const base = `agent-policy v${version}/${ruleId}`;
  const ruleReason = match.rule?.reason;
  const parts = [base];
  if (ruleReason) parts.push(ruleReason);
  if (suffix) parts.push(suffix);
  return parts.join(' · ');
}

// ============================================================================
// §validation — the document shape contract (reject before persistence)
// ============================================================================

function validateDocument(doc: unknown): asserts doc is AgentPolicyDocument {
  if (!doc || typeof doc !== 'object') {
    throw new AgentPolicyError('agent-policy-invalid-document', 'document must be an object');
  }
  const d = doc as Record<string, unknown>;
  if (d.description !== undefined && (typeof d.description !== 'string' || d.description.length > MAX_DESC)) {
    throw new AgentPolicyError('agent-policy-invalid-document', `description must be a string ≤ ${MAX_DESC} chars`);
  }
  if (!Array.isArray(d.rules) || d.rules.length > MAX_RULES) {
    throw new AgentPolicyError('agent-policy-invalid-document', `rules must be an array of ≤ ${MAX_RULES} rules`);
  }
  if (d.defaultEffect !== 'allow' && d.defaultEffect !== 'deny' && d.defaultEffect !== 'ask') {
    throw new AgentPolicyError('agent-policy-invalid-document', "defaultEffect must be 'allow' | 'deny' | 'ask'");
  }
  const ids = new Set<string>();
  d.rules.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}] must be an object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !RULE_ID_PATTERN.test(r.id)) {
      throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].id must match [a-z0-9-]{1,64}`);
    }
    if (ids.has(r.id)) {
      throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].id '${r.id}' is duplicated`);
    }
    ids.add(r.id);
    if (!AGENT_POLICY_DOMAINS.includes(r.domain as AgentPolicyDomain)) {
      throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].domain must be one of ${AGENT_POLICY_DOMAINS.join('|')}`);
    }
    const effect = r.effect as string;
    if (effect !== 'allow' && effect !== 'deny' && effect !== 'ask' && effect !== 'constrained') {
      throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].effect must be allow|deny|ask|constrained`);
    }
    if (r.family !== undefined && !TOOL_FAMILIES.includes(r.family as ToolFamily)) {
      throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].family must be a valid ToolFamily`);
    }
    if (r.operations !== undefined) {
      if (!Array.isArray(r.operations) || !r.operations.every((o) => typeof o === 'string' && o.length > 0)) {
        throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].operations must be an array of non-empty strings`);
      }
    }
    if (r.hostGlob !== undefined) {
      if (typeof r.hostGlob !== 'string' || r.hostGlob.length === 0 || /\s/.test(r.hostGlob)) {
        throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].hostGlob must be a non-empty whitespace-free string`);
      }
    }
    if (r.reason !== undefined && (typeof r.reason !== 'string' || r.reason.length > MAX_REASON)) {
      throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].reason must be a string ≤ ${MAX_REASON} chars`);
    }
    // external-domain rules are scope-only (no family/operations/hostGlob).
    if (r.domain === 'external' && (r.family !== undefined || r.operations !== undefined || r.hostGlob !== undefined)) {
      throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}] domain 'external' cannot carry family/operations/hostGlob`);
    }
    if (effect === 'constrained') {
      const c = r.constraints as Record<string, unknown> | undefined;
      if (!c || typeof c !== 'object') {
        throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}] effect 'constrained' requires constraints`);
      }
      if (c.timeoutMs !== undefined && (typeof c.timeoutMs !== 'number' || c.timeoutMs <= 0 || !Number.isFinite(c.timeoutMs))) {
        throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].constraints.timeoutMs must be a positive finite number`);
      }
      if (c.maxOutputBytes !== undefined && (typeof c.maxOutputBytes !== 'number' || c.maxOutputBytes <= 0 || !Number.isFinite(c.maxOutputBytes))) {
        throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].constraints.maxOutputBytes must be a positive finite number`);
      }
      if (c.readOnly !== undefined && typeof c.readOnly !== 'boolean') {
        throw new AgentPolicyError('agent-policy-invalid-document', `rule[${i}].constraints.readOnly must be boolean`);
      }
    }
  });
}

// Expose the repository type for composition-root wiring + tests.
export type { AgentPolicyRepository, AgentPolicyScopeSource };
