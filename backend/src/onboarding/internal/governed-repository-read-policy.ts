/**
 * WORK-038 PR #42 round-3: DefaultGovernedRepositoryReadPolicy — the governed
 * repository-read boundary made real.
 *
 * THE BOUNDARY (the architect's round-3 sanctioned alternative path):
 *
 *   governedRead(request, ctx)
 *     -> capture the WORK-037 decideForProjectScope decision (+ policy
 *        version snapshot + matched rule id — for drift detection + forensic
 *        provenance)
 *     -> enforce it:
 *          * operation must be 'read' | 'list' (read-only — refuse others)
 *          * path must be in the candidate allowlist (the boundary refuses
 *            arbitrary paths even on an 'allow' decision)
 *          * deny | ask -> NO read (blocked; the decision is recorded)
 *     -> perform the read under the captured decision (immediately, in the
 *        SAME method — there is no caller-interleavable check-then-act gap)
 *     -> apply the `constrained` enforcement:
 *          * maxOutputBytes -> truncate the observed content to N bytes,
 *            flag truncated=true, truncatedAtBytes=N, recompute the
 *            contentDigest on the TRUNCATED content (the digest reflects
 *            what was actually observed)
 *          * (path-allowlist + read-only are enforced BEFORE the decision is
 *            even consulted — they are boundary-level enforcement that
 *            applies regardless of the policy decision)
 *     -> return the bound decision+effect+content (one atomic outcome)
 *
 * WHY THIS IS NOT THE TOOL RUNTIME (the architect's preferred path, rejected
 * here with rationale): the frozen WORK-036 `DefaultToolRuntime.invoke()` is
 * structurally coupled to ExecutionSession (must be 'running') + Workspace
 * (must be 'ready') + WorktreeMaterializer (host-path re-resolution) + a
 * family ToolExecutor. Onboarding is NOT a Work Item execution — it has NO
 * wfos_executions row, NO ExecutionSession, NO Workspace, NO host worktree.
 * Routing onboarding reads through `invoke()` would require manufacturing a
 * synthetic session/workspace/worktree — exactly the "fake toolInvocationId"
 * smell the architect already rejected in round-2 (manufacturing the
 * execution context IS manufacturing the invocation). Adapting the frozen
 * WORK-036 boundary to support a session-less, workspace-less, worktree-less
 * read path is a substantial refactor of a FROZEN boundary, out of scope for
 * WORK-038. This boundary REUSES the WORK-037 decideForProjectScope engine
 * (no parallel engine — same matcher, same document, same decision
 * vocabulary) but presents a DISTINCT, atomic operation boundary for /github
 * reads. The evidence row records the decision + effect in its OWN columns
 * (repository_read_decision + repository_read_enforcement) — NOT in the
 * Tool Runtime columns (tool_invocation_id + policy_decision stay NULL).
 *
 * POLICY DRIFT PREVENTION (the architect's round-3 requirement):
 *   * the decision is captured at the START of governedRead() and IS the
 *     authorization for THAT read (the read happens immediately under it,
 *     in the same method — no caller can change policy between a separate
 *     decide() call and a separate read() call, because there is no
 *     separate call).
 *   * the policy version is snapshotted into RepositoryReadGovernance.
 *     policyVersion (surfaced from the WORK-037 engine — additive, the
 *     frozen ToolPolicyGate.decide() seam is untouched) so a later auditor
 *     can verify "this content was read under policy version V" — drift
 *     made OBSERVABLE, not just prevented-by-construction.
 *
 * `CONSTRAINED` ENFORCEMENT (made concrete + verifiable — the architect's
 * round-3 requirement: "define what `constrained` means for this direct-
 * read operation"):
 *   * maxOutputBytes — the observed content is truncated to N bytes; the
 *     contentDigest is recomputed on the TRUNCATED content (so the digest
 *     reflects the OBSERVED evidence, not the pre-truncation content); the
 *     enforcement record carries truncated=true + truncatedAtBytes=N. This
 *     is a REAL, verifiable effect: a constrained read returns DIFFERENT
 *     content (and a different digest) than an unconstrained read of the
 *     same path.
 *   * path-allowlist — the boundary only admits reads of paths in the
 *     declared candidate set (CANDIDATE_READS); an arbitrary path ->
 *     pathAllowed=false, performed=false, decision='deny' (the boundary
 *     refuses even on an allow policy). This is boundary-level enforcement
 *     that applies regardless of the policy decision.
 *   * read-only — the boundary only supports read/list operations; any
 *     other operation is refused (performed=false, decision='deny').
 *
 * Boundary: src/onboarding/internal/ — application capability, NOT a module,
 * NOT an authority. No provider SDKs, no credentials, no DB access. Imports
 * ONLY the onboarding types (the policy gate + the content port + the
 * candidate set) — never /github internal/, never provider SDKs.
 */
import { createHash } from 'node:crypto';
import type { Logger } from '@platform/logger.js';
import type { ToolPolicyRequest } from '@modules/agents/index.js';
import type { RepositoryReadEnforcement } from '@modules/projects/index.js';
import type {
  AnalysisContext,
  GovernedReadRequest,
  GovernedReadOutcome,
  GovernedRepositoryReadPolicy,
  ProjectScopedPolicyGate,
  RepositoryContentPort,
  RepositoryReadGovernance,
} from '../onboarding.types.js';
import { OnboardingAnalysisError } from '../onboarding.types.js';

/** The operations the boundary supports (read-only — the rest are refused). */
const SUPPORTED_OPERATIONS = new Set(['read', 'list']);

/** sha256 hex of a string. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface DefaultGovernedRepositoryReadPolicyDeps {
  /**
   * The WORK-037 project-scoped policy gate (reused — NO parallel engine).
   * The boundary calls decideForProjectScope() ONCE per governedRead(), at
   * the START of the method, and binds the returned decision (+ policy
   * version snapshot + matched rule id) to the read that follows.
   */
  readonly policyGate: ProjectScopedPolicyGate;
  /**
   * The repository content port (the /github read path). The boundary reads
   * through it ONLY when the decision is allow/constrained AND the path is
   * in the candidate allowlist AND the operation is read-only. The port's
   * contract: null/[] = expected-missing (the boundary continues with
   * content=null + performed=true); throw = infrastructure failure (the
   * boundary propagates as a typed OnboardingAnalysisError — PR #42 round-2
   * Blocker B, preserved).
   */
  readonly contentPort: RepositoryContentPort;
  /**
   * The candidate-path allowlist (the boundary refuses reads of paths
   * outside this set, even on an 'allow' decision). The composition root
   * passes the SAME candidate set the analyzer iterates — the analyzer
   * cannot read an arbitrary path through this boundary.
   */
  readonly candidateAllowlist: ReadonlySet<string>;
  readonly logger: Logger;
}

/**
 * The governed repository-read boundary implementation. ONE atomic method
 * (governedRead) ties the WORK-037 authorization decision to the actual
 * /github read + the `constrained` enforcement + the bound record. There is
 * NO check-then-act window at this API (PR #42 round-3).
 */
export class DefaultGovernedRepositoryReadPolicy implements GovernedRepositoryReadPolicy {
  constructor(private readonly deps: DefaultGovernedRepositoryReadPolicyDeps) {}

  async governedRead(
    request: GovernedReadRequest,
    ctx: AnalysisContext,
  ): Promise<GovernedReadOutcome> {
    // ---- 1. BOUNDARY-LEVEL ENFORCEMENT (applies regardless of the policy
    // decision; the boundary refuses before the policy gate is even
    // consulted, so the read NEVER happens for a refused path/operation).
    if (!SUPPORTED_OPERATIONS.has(request.operation)) {
      // read-only: the boundary supports ONLY 'read' | 'list'. A mutating
      // operation is refused outright — the boundary is structurally
      // read-only (this IS the `readOnly` constraint made concrete at the
      // boundary level, regardless of the policy decision).
      return this.blockedOutcome(request, {
        decision: 'deny',
        reason: `repository-read-boundary: operation '${request.operation}' is not supported (the boundary is read-only: 'read' | 'list')`,
        policyVersion: null,
        ruleId: null,
        pathAllowed: false,
      });
    }
    if (!this.deps.candidateAllowlist.has(request.path)) {
      // path-allowlist: the boundary admits reads of the declared candidate
      // set ONLY. An arbitrary path is refused even on an 'allow' decision
      // (the boundary is structurally scoped to the analyzer's candidate
      // set). This is a REAL enforcement effect: the boundary cannot be
      // used to read outside the candidate set, regardless of policy.
      return this.blockedOutcome(request, {
        decision: 'deny',
        reason: `repository-read-boundary: path '${request.path}' is not in the candidate allowlist (the boundary refuses reads outside the declared candidate set)`,
        policyVersion: null,
        ruleId: null,
        pathAllowed: false,
      });
    }

    // ---- 2. CAPTURE THE WORK-037 DECISION (the authorization for this
    // read). The decision is fetched ONCE, at the START of governedRead(),
    // and IS the authorization for the read that follows. The policy
    // version + the matched rule id are snapshotted into the governance
    // record (drift detection + forensic provenance). There is no separate
    // decide() call the caller could interleave a policy change between.
    const invocationId = `${ctx.analysisRunId}:${request.operation}:${request.path}`;
    const policyRequest: ToolPolicyRequest = {
      invocationId,
      executionId: `onboarding:${ctx.baselineId}`,
      sessionId: ctx.analysisRunId,
      workspaceId: `onboarding:${ctx.baselineId}`,
      family: request.family,
      operation: request.operation,
      input: { path: request.path, mode: request.operation } as Record<string, unknown>,
    };
    let decision;
    try {
      decision = await this.deps.policyGate.decideForProjectScope(
        policyRequest,
        ctx.projectId,
        ctx.organizationId,
      );
    } catch (err) {
      // The policy gate itself failed (the engine throws — not the content
      // port). Fail CLOSED: refuse the read (a policy-gate failure must NOT
      // become an implicit allow). The decision is recorded as 'deny' with
      // the failure reason; the read did not happen.
      this.deps.logger.error('repository-read.policy-gate-failed', {
        invocationId,
        path: request.path,
        error: (err as Error).message,
      });
      return this.blockedOutcome(request, {
        decision: 'deny',
        reason: `repository-read-boundary: the project-scoped policy gate failed to resolve a decision (${(err as Error).message}) — failing closed`,
        policyVersion: null,
        ruleId: null,
        pathAllowed: true,
      });
    }

    const policyVersion = decision.policyVersion ?? null;
    const ruleId = decision.ruleId ?? null;
    const reason = decision.reason ?? null;

    // ---- 3. ENFORCE THE DECISION. deny | ask -> NO read (blocked; the
    // decision is recorded; the read did not happen). The round-2 invariant
    // (the analyzer refuses to proceed on deny/ask) is preserved — but now
    // the decision ITSELF is durably recorded on the evidence row (in
    // repository_read_decision), not just consulted at runtime.
    if (decision.decision === 'deny' || decision.decision === 'ask') {
      return this.blockedOutcome(request, {
        decision: decision.decision,
        reason,
        policyVersion,
        ruleId,
        pathAllowed: true,
      });
    }

    // ---- 4. PERFORM THE READ under the captured decision (immediately, in
    // the SAME method — no caller-interleavable check-then-act gap). The
    // content port's contract: null/[] = expected-missing (the boundary
    // continues with content=null + performed=true); throw = infrastructure
    // failure (the boundary propagates as a typed OnboardingAnalysisError —
    // PR #42 round-2 Blocker B, preserved).
    const isConstrained = decision.decision === 'constrained';
    const maxOutputBytes = isConstrained
      ? decision.constraints?.maxOutputBytes ?? null
      : null;

    let rawContent: { content: string; contentDigest: string } | null = null;
    try {
      if (request.operation === 'list') {
        const entries = await this.deps.contentPort.listDir(
          ctx.repositoryOwner,
          ctx.repositoryName,
          ctx.baselineCommitSha,
          request.path,
          ctx.installationId,
        );
        if (entries.length > 0) {
          const listing = entries.map((e) => `${e.type}:${e.name}`).sort().join('\n');
          rawContent = { content: listing, contentDigest: sha256(listing) };
        }
      } else {
        rawContent = await this.deps.contentPort.readFile(
          ctx.repositoryOwner,
          ctx.repositoryName,
          ctx.baselineCommitSha,
          request.path,
          ctx.installationId,
        );
      }
    } catch (err) {
      // Infrastructure / content-provider failure (GitHub unavailable,
      // authentication failure, API failure, content retrieval infrastructure
      // failure). Propagate as a typed OnboardingAnalysisError so the
      // orchestrator can markFailed the baseline — the baseline must NEVER
      // reach 'complete' on a content-provider failure (PR #42 round-2
      // Blocker B, preserved). The governance record (decision + version +
      // rule + performed=false) is attached to the error context so the
      // failure carries the bound authorization even though no observation
      // row is persisted (the orchestrator's markFailed records the
      // failure_stage='repository-content-unavailable' forensic).
      this.deps.logger.error('repository-read.content-read-infrastructure-failed', {
        path: request.path,
        operation: request.operation,
        decision: decision.decision,
        policyVersion,
        error: (err as Error).message,
      });
      throw new OnboardingAnalysisError(
        'repository-content-unavailable',
        `repository-content-unavailable: the repository content provider threw an infrastructure failure reading '${request.path}' (${request.operation}) at revision ${ctx.baselineCommitSha} for ${ctx.repositoryOwner}/${ctx.repositoryName} — the read was authorized by decision '${decision.decision}' (policyVersion=${policyVersion ?? 'not-surfaced'}) but the content provider is unavailable — ${(err as Error).message}`,
        {
          failingLocator: request.path,
          cause: err,
          context: {
            owner: ctx.repositoryOwner,
            repository: ctx.repositoryName,
            commitSha: ctx.baselineCommitSha,
            path: request.path,
            operation: request.operation,
            decision: decision.decision,
            policyVersion,
            ruleId,
            underlyingError: (err as Error).message,
          },
        },
      );
    }

    // ---- 5. APPLY THE `constrained` ENFORCEMENT (maxOutputBytes). This is
    // the CONCRETE effect: a constrained read returns DIFFERENT content
    // (truncated) than an unconstrained read of the same path. The
    // contentDigest is recomputed on the TRUNCATED content so the evidence
    // row's reproducibility fingerprint reflects the OBSERVED evidence
    // (not the pre-truncation content). A later auditor comparing the
    // digest to a re-read under the same constraint converges; an
    // unconstrained re-read would NOT converge (the constraint changed
    // the observation) — the enforcement is REAL, not cosmetic.
    let truncated = false;
    let truncatedAtBytes: number | null = null;
    let content = rawContent;
    if (rawContent && maxOutputBytes !== null && rawContent.content.length > maxOutputBytes) {
      const truncatedContent = rawContent.content.slice(0, maxOutputBytes);
      truncated = true;
      truncatedAtBytes = maxOutputBytes;
      content = {
        content: truncatedContent,
        contentDigest: sha256(truncatedContent),
      };
    }

    // ---- 6. RETURN THE BOUND OUTCOME. The decision + the policy version +
    // the rule id + the enforcement effect + the (possibly truncated)
    // content are returned by ONE method — the authorization decision and
    // the actual read are bound in a single atomic outcome. There is no
    // check-then-act window at this API.
    const enforcement: RepositoryReadEnforcement = {
      policyVersion,
      ruleId,
      performed: true, // the read was performed (content may be null = path absent)
      truncated,
      maxOutputBytes,
      truncatedAtBytes,
      pathAllowed: true,
      reason,
    };
    const governance: RepositoryReadGovernance = {
      decision: decision.decision,
      reason,
      policyVersion,
      ruleId,
      performed: true,
      enforcement,
    };
    return { request, content, governance };
  }

  /**
   * Build a blocked outcome (the read did not happen). The decision +
   * reason + policyVersion + ruleId are still recorded honestly — the
   * evidence row will carry repository_read_decision + the enforcement
   * record (performed=false) so a later auditor sees WHY the read was
   * blocked AND under which policy version.
   */
  private blockedOutcome(
    request: GovernedReadRequest,
    args: {
      decision: 'allow' | 'constrained' | 'deny' | 'ask';
      reason: string | null;
      policyVersion: number | null;
      ruleId: string | null;
      pathAllowed: boolean;
    },
  ): GovernedReadOutcome {
    const enforcement: RepositoryReadEnforcement = {
      policyVersion: args.policyVersion,
      ruleId: args.ruleId,
      performed: false,
      truncated: false,
      maxOutputBytes: null,
      truncatedAtBytes: null,
      pathAllowed: args.pathAllowed,
      reason: args.reason,
    };
    const governance: RepositoryReadGovernance = {
      decision: args.decision,
      reason: args.reason,
      policyVersion: args.policyVersion,
      ruleId: args.ruleId,
      performed: false,
      enforcement,
    };
    return { request, content: null, governance };
  }
}
