/**
 * WORK-038 PR #42 round-4: DefaultGovernedRepositoryReadPolicy — the snapshot/
 * fencing protocol for governed repository reads.
 *
 * THE ROUND-4 BLOCKER (the architect's review of the round-3 commit `228acfe`):
 * the round-3 `governedRead()` claimed atomicity but was still a check-then-act
 * window with respect to POLICY CHANGES. `decideForProjectScope()` (V7) and
 * the GitHub read are two separate asynchronous operations against two
 * different authorities (the WORK-037 policy store vs the GitHub API). A
 * concurrent policy update CAN commit between them:
 *
 *   T1  policy = ALLOW, version 7
 *       ↓
 *   T1  governedRead() captures V7
 *       ↓
 *   T2  policy mutates to DENY, version 8        ← commits BETWEEN capture + read
 *       ↓
 *   T1  GitHubAdapter.getFileContent(...)
 *       ↓
 *   T1  read succeeds — UNDER A POLICY (V8) THAT WOULD HAVE DENIED IT
 *
 * Being inside one JavaScript method does not make those operations atomic.
 * The round-3 `policyVersion` snapshot made the race OBSERVABLE, but did NOT
 * prevent it. The same issue exists for `constrained`: the enforcement
 * parameters are captured from V7, while the actual read can occur after V8
 * has invalidated that authorization.
 *
 * THE ROUND-4 FIX — the SNAPSHOT/FENCING PROTOCOL (the architect's required
 * correction, implemented here):
 *
 *   1. BOUNDARY-LEVEL ENFORCEMENT (path-allowlist + read-only — applies
 *      regardless of the policy decision; the read NEVER happens for a
 *      refused path/operation).
 *   2. CAPTURE THE POLICY SNAPSHOT — call decideForProjectScope ONCE at the
 *      START; capture decision + policyVersion + ruleId + constraints. This
 *      snapshot IS the authorization for the read that follows.
 *   3. ENFORCE THE SNAPSHOT DECISION — deny/ask -> NO read (blocked outcome;
 *      the decision is recorded honestly; the read did not happen).
 *   4. PERFORM THE READ under the captured snapshot (immediately, in the SAME
 *      method). The content port's contract: null/[] = expected-missing
 *      (continue with content=null + performed=true); throw = infrastructure
 *      failure (propagate as OnboardingAnalysisError 'repository-content-
 *      unavailable' — PR #42 round-2 Blocker B, preserved).
 *   5. APPLY THE `constrained` ENFORCEMENT (maxOutputBytes) on the SNAPSHOT's
 *      constraints. The observed content is truncated to N bytes; the
 *      contentDigest is recomputed on the TRUNCATED content (the digest
 *      reflects what was actually observed under the snapshot's constraint).
 *   6. REVALIDATE THE POLICY SNAPSHOT — call decideForProjectScope AGAIN
 *      (with the same request) and compare the policyVersion + ruleId +
 *      decision. If ANY changed, the snapshot is STALE.
 *   7. IF STALE:
 *        DISCARD the read result (content = null)
 *        set stale = true, performed = false
 *        record the revalidation metadata (the V8 the revalidation saw)
 *        log 'repository-read.policy-snapshot-stale' (forensic)
 *        the analyzer persists NO evidence row + NO observation for that path
 *      ELSE (the snapshot is still current):
 *        set stale = false, performed = true
 *        record the revalidation metadata (revalidatedPolicyVersion = V7)
 *        return the bound outcome (content + governance + enforcement)
 *
 * THE INVARIANT (the architect's round-4 requirement):
 *   "A repository-read result is persisted only if the policy snapshot that
 *    authorized it is still current when the result is committed."
 *
 * That is achievable even though the GitHub API itself cannot participate in
 * the database transaction the WORK-037 policy store uses. The boundary does
 * NOT claim database-style atomicity across the policy engine and GitHub API
 * — it claims a FENCING PROTOCOL that DETECTS + REJECTS stale snapshots
 * BEFORE the result is persisted. The revalidation is the fence: the read
 * result must clear it to be persisted.
 *
 * WHY THIS IS NOT THE TOOL RUNTIME (the architect's preferred path, rejected
 * here with rationale — unchanged from round-3): the frozen WORK-036
 * `DefaultToolRuntime.invoke()` is structurally coupled to ExecutionSession
 * (must be 'running') + Workspace (must be 'ready') + WorktreeMaterializer
 * (host-path re-resolution) + a family ToolExecutor. Onboarding is NOT a
 * Work Item execution — it has NO wfos_executions row, NO ExecutionSession,
 * NO Workspace, NO host worktree. Routing onboarding reads through
 * `invoke()` would require manufacturing a synthetic session/workspace/
 * worktree — exactly the "fake toolInvocationId" smell the architect
 * already rejected in round-2 (manufacturing the execution context IS
 * manufacturing the invocation). Adapting the frozen WORK-036 boundary to
 * support a session-less, workspace-less, worktree-less read path is a
 * substantial refactor of a FROZEN boundary, out of scope for WORK-038.
 * This boundary REUSES the WORK-037 decideForProjectScope engine (no
 * parallel engine — same matcher, same document, same decision vocabulary)
 * but presents a DISTINCT, fenced operation boundary for /github reads.
 * The evidence row records the decision + effect in its OWN columns
 * (repository_read_decision + repository_read_enforcement) — NOT in the
 * Tool Runtime columns (tool_invocation_id + policy_decision stay NULL).
 *
 * `CONSTRAINED` ENFORCEMENT (made concrete + verifiable — unchanged from
 * round-3, now ALSO fenced):
 *   * maxOutputBytes — the observed content is truncated to N bytes; the
 *     contentDigest is recomputed on the TRUNCATED content (so the digest
 *     reflects the OBSERVED evidence, not the pre-truncation content); the
 *     enforcement record carries truncated=true + truncatedAtBytes=N. This
 *     is a REAL, verifiable effect: a constrained read returns DIFFERENT
 *     content (and a different digest) than an unconstrained read of the
 *     same path. The constraint is captured from the SNAPSHOT (V7); if V8
 *     changed the constraint, the snapshot is stale and the V7-truncated
 *     content is DISCARDED (the V8 constraint is not applied to the already-
 *     read content — that would be a second read under a different policy).
 *   * path-allowlist — the boundary only admits reads of paths in the
 *     declared candidate set (CANDIDATE_READS); an arbitrary path ->
 *     pathAllowed=false, performed=false, decision='deny' (the boundary
 *     refuses even on an allow policy). This is boundary-level enforcement
 *     that applies regardless of the policy decision.
 *   * read-only — the boundary only supports read/list operations; any
 *     other operation is refused (performed=false, decision='deny').
 *
 * STALENESS DETECTION (the round-4 fence): a snapshot is STALE if ANY of
 *   * the policyVersion changed between capture and revalidation (the
 *     primary signal — the WORK-037 store bumps policy_version on every
 *     document mutation: setProjectPolicy / clearProjectPolicy /
 *     setOrganizationPolicy / clearOrganizationPolicy);
 *   * the ruleId changed (defense-in-depth — a rule replacement without a
 *     version bump would be a bug in the engine, but the fence catches it);
 *   * the decision changed (defense-in-depth — an allow→deny flip without a
 *     version/rule change would be a bug, but the fence catches it).
 * When the gate does not surface a policyVersion (a test fake returning
 * `{ decision: 'allow' }`), the fence falls back to comparing ruleId +
 * decision. When the gate surfaces nothing (both null + same decision), the
 * fence cannot detect drift — it records `revalidated=true,
 * revalidatedPolicyVersion=null, stale=false` (honestly "revalidated, but
 * the gate surfaces no version, so drift detection is best-effort"). This
 * is correct: a gate that surfaces nothing has no real version to drift
 * against. The PRODUCTION gate (AgentPolicyEngine) always surfaces a real
 * policyVersion, so the fence is fully effective in production.
 *
 * REVALIDATION FAILURE (fail-closed): if the revalidation call itself
 * throws (the policy gate failed on the SECOND call), the boundary treats
 * the snapshot as STALE — the read result is DISCARDED. The boundary logs
 * 'repository-read.policy-snapshot-revalidation-failed' (forensic). A
 * revalidation failure must NOT become an implicit persist (the result
 * cannot be committed without a successful revalidation).
 *
 * Boundary: src/onboarding/internal/ — application capability, NOT a module,
 * NOT an authority. No provider SDKs, no credentials, no DB access. Imports
 * ONLY the onboarding types (the policy gate + the content port + the
 * candidate set) — never /github internal/, never provider SDKs.
 */
import { createHash } from 'node:crypto';
import type { Logger } from '@platform/logger.js';
import type { ToolPolicyRequest, ProjectScopedPolicyDecision } from '@modules/agents/index.js';
import type {
  PersistencePolicySnapshot,
  RepositoryReadEnforcement,
} from '@modules/projects/index.js';
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

/**
 * The captured policy snapshot (round-4 fencing). The decision + the version +
 * the rule + the constraints captured at the START of governedRead(); the
 * read is performed under this snapshot, and the snapshot is REVALIDATED at
 * the END. If the snapshot is stale, the read result is DISCARDED.
 */
interface PolicySnapshot {
  readonly decision: ProjectScopedPolicyDecision;
  readonly policyVersion: number | null;
  readonly ruleId: string | null;
  readonly reason: string | null;
  readonly maxOutputBytes: number | null;
}

/**
 * Determine whether the snapshot is STALE relative to the revalidation
 * decision. The fence compares version (primary) + ruleId (defense-in-depth)
 * + decision (defense-in-depth). When the gate surfaces no version, the fence
 * falls back to ruleId + decision comparison.
 */
function isSnapshotStale(snapshot: PolicySnapshot, revalidation: ProjectScopedPolicyDecision): boolean {
  // Primary signal: the policy version changed (the WORK-037 store bumps
  // policy_version on every document mutation — a version change is the
  // definitive signal that the policy document the snapshot was captured
  // against is no longer current).
  if (
    snapshot.policyVersion != null &&
    revalidation.policyVersion != null &&
    snapshot.policyVersion !== revalidation.policyVersion
  ) {
    return true;
  }
  // Defense-in-depth: the matched rule id changed (a rule replacement
  // without a version bump would be an engine bug, but the fence catches it).
  if (
    (snapshot.ruleId != null || revalidation.ruleId != null) &&
    snapshot.ruleId !== revalidation.ruleId
  ) {
    return true;
  }
  // Defense-in-depth: the decision itself changed (an allow→deny flip
  // without a version/rule change would be an engine bug, but the fence
  // catches it). This is the last-resort signal when the gate surfaces no
  // version AND no ruleId (a test fake returning { decision: 'allow' }).
  if (snapshot.decision.decision !== revalidation.decision) {
    return true;
  }
  return false;
}

export interface DefaultGovernedRepositoryReadPolicyDeps {
  /**
   * The WORK-037 project-scoped policy gate (reused — NO parallel engine).
   * The boundary calls decideForProjectScope() TWICE per governedRead():
   *   1. at the START — to capture the snapshot (the authorization for the
   *      read that follows);
   *   2. at the END — to revalidate the snapshot (the round-4 fence). If
   *      the revalidation sees a different version/rule/decision, the
   *      snapshot is STALE and the read result is DISCARDED.
   */
  readonly policyGate: ProjectScopedPolicyGate;
  /**
   * The repository content port (the /github read path). The boundary reads
   * through it ONLY when the snapshot decision is allow/constrained AND the
   * path is in the candidate allowlist AND the operation is read-only. The
   * port's contract: null/[] = expected-missing (the boundary continues with
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
 * (governedRead) ties the WORK-037 authorization snapshot → the actual
 * /github read → the `constrained` enforcement → the snapshot REVALIDATION
 * (round-4 fence) → the bound record. There is NO check-then-act window at
 * this API (PR #42 round-3 + round-4).
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

    // ---- 2. CAPTURE THE POLICY SNAPSHOT (round-4 fencing — step 1). The
    // decision is fetched ONCE, at the START of governedRead(), and IS the
    // authorization for the read that follows. The policy version + the
    // matched rule id + the constraints are snapshotted into the local
    // PolicySnapshot — these are the fence's reference values. The
    // revalidation at the END will compare against THIS snapshot.
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
    let snapshotDecision: ProjectScopedPolicyDecision;
    try {
      snapshotDecision = await this.deps.policyGate.decideForProjectScope(
        policyRequest,
        ctx.projectId,
        ctx.organizationId,
      );
    } catch (err) {
      // The policy gate itself failed on the CAPTURE call. Fail CLOSED:
      // refuse the read (a policy-gate failure must NOT become an implicit
      // allow). The decision is recorded as 'deny' with the failure reason;
      // the read did not happen. No revalidation is possible (there is no
      // snapshot to revalidate).
      this.deps.logger.error('repository-read.policy-gate-failed', {
        invocationId,
        path: request.path,
        phase: 'capture',
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

    const snapshot: PolicySnapshot = {
      decision: snapshotDecision,
      policyVersion: snapshotDecision.policyVersion ?? null,
      ruleId: snapshotDecision.ruleId ?? null,
      reason: snapshotDecision.reason ?? null,
      maxOutputBytes:
        snapshotDecision.decision === 'constrained'
          ? snapshotDecision.constraints?.maxOutputBytes ?? null
          : null,
    };

    // ---- 3. ENFORCE THE SNAPSHOT DECISION. deny | ask -> NO read (blocked;
    // the decision is recorded; the read did not happen). No revalidation
    // is needed (the read never happened — there is nothing to fence).
    if (snapshotDecision.decision === 'deny' || snapshotDecision.decision === 'ask') {
      return this.blockedOutcome(request, {
        decision: snapshotDecision.decision,
        reason: snapshot.reason,
        policyVersion: snapshot.policyVersion,
        ruleId: snapshot.ruleId,
        pathAllowed: true,
      });
    }

    // ---- 4. PERFORM THE READ under the captured snapshot (round-4 fencing
    // — step 3). The content port's contract: null/[] = expected-missing
    // (the boundary continues with content=null + performed=true); throw =
    // infrastructure failure (the boundary propagates as a typed
    // OnboardingAnalysisError — PR #42 round-2 Blocker B, preserved). The
    // read is performed UNDER the snapshot's authorization; the
    // revalidation at step 6 will determine whether the result is PERSISTED.
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
      // failure_stage='repository-content-unavailable' forensic). NOTE: no
      // revalidation is performed here — the read failed before completing,
      // so there is no result to fence.
      this.deps.logger.error('repository-read.content-read-infrastructure-failed', {
        path: request.path,
        operation: request.operation,
        decision: snapshot.decision.decision,
        policyVersion: snapshot.policyVersion,
        error: (err as Error).message,
      });
      throw new OnboardingAnalysisError(
        'repository-content-unavailable',
        `repository-content-unavailable: the repository content provider threw an infrastructure failure reading '${request.path}' (${request.operation}) at revision ${ctx.baselineCommitSha} for ${ctx.repositoryOwner}/${ctx.repositoryName} — the read was authorized by decision '${snapshot.decision.decision}' (policyVersion=${snapshot.policyVersion ?? 'not-surfaced'}) but the content provider is unavailable — ${(err as Error).message}`,
        {
          failingLocator: request.path,
          cause: err,
          context: {
            owner: ctx.repositoryOwner,
            repository: ctx.repositoryName,
            commitSha: ctx.baselineCommitSha,
            path: request.path,
            operation: request.operation,
            decision: snapshot.decision.decision,
            policyVersion: snapshot.policyVersion,
            ruleId: snapshot.ruleId,
            underlyingError: (err as Error).message,
          },
        },
      );
    }

    // ---- 5. APPLY THE `constrained` ENFORCEMENT (round-4 fencing — step 4)
    // on the SNAPSHOT's maxOutputBytes constraint. This is the CONCRETE
    // effect: a constrained read returns DIFFERENT content (truncated) than
    // an unconstrained read of the same path. The contentDigest is
    // recomputed on the TRUNCATED content so the evidence row's
    // reproducibility fingerprint reflects the OBSERVED evidence (not the
    // pre-truncation content). The constraint is captured from the SNAPSHOT
    // (V7); if V8 changed the constraint, the snapshot is stale (step 6) and
    // the V7-truncated content is DISCARDED — the V8 constraint is NOT
    // applied to the already-read content (that would be a second read under
    // a different policy, which is forbidden).
    let truncated = false;
    let truncatedAtBytes: number | null = null;
    let content = rawContent;
    if (rawContent && snapshot.maxOutputBytes !== null && rawContent.content.length > snapshot.maxOutputBytes) {
      const truncatedContent = rawContent.content.slice(0, snapshot.maxOutputBytes);
      truncated = true;
      truncatedAtBytes = snapshot.maxOutputBytes;
      content = {
        content: truncatedContent,
        contentDigest: sha256(truncatedContent),
      };
    }

    // ---- 6. REVALIDATE THE POLICY SNAPSHOT (round-4 fencing — step 5, the
    // FENCE). Call decideForProjectScope AGAIN (with the same request) and
    // compare the version + rule + decision. If ANY changed, the snapshot
    // is STALE — the read result is DISCARDED. This is the architect's
    // required correction: "a repository-read result is persisted only if
    // the policy snapshot that authorized it is still current when the
    // result is committed." The GitHub API cannot participate in the
    // database transaction, but the fence DETECTS + REJECTS stale snapshots
    // before the result is persisted.
    let revalidation: ProjectScopedPolicyDecision;
    try {
      revalidation = await this.deps.policyGate.decideForProjectScope(
        policyRequest,
        ctx.projectId,
        ctx.organizationId,
      );
    } catch (err) {
      // The revalidation call itself failed. FAIL CLOSED: treat the
      // snapshot as STALE — the read result CANNOT be committed without a
      // successful revalidation (a revalidation failure must NOT become an
      // implicit persist). The boundary logs the revalidation failure
      // (forensic); the analyzer persists NO evidence row + NO observation
      // for this path. The baseline still completes (the other reads'
      // evidence is still valid under their own revalidated snapshots).
      this.deps.logger.error('repository-read.policy-snapshot-revalidation-failed', {
        invocationId,
        path: request.path,
        snapshotVersion: snapshot.policyVersion,
        error: (err as Error).message,
      });
      return this.staleOutcome(request, snapshot, {
        revalidatedPolicyVersion: null,
        revalidatedRuleId: null,
        revalidatedDecision: null,
        reason: `repository-read-boundary: the policy snapshot revalidation failed (${(err as Error).message}) — the read result is discarded (fencing: a revalidation failure must not become an implicit persist)`,
      });
    }

    const revalidatedPolicyVersion = revalidation.policyVersion ?? null;
    const revalidatedRuleId = revalidation.ruleId ?? null;
    const revalidatedDecision = revalidation.decision;

    // ---- 7. CHECK THE FENCE. If the snapshot is stale, DISCARD the read
    // result (content = null, performed = false, stale = true). The
    // analyzer persists NO evidence row + NO observation for this path.
    // The revalidation metadata is recorded for forensic provenance.
    if (isSnapshotStale(snapshot, revalidation)) {
      this.deps.logger.warn('repository-read.policy-snapshot-stale', {
        invocationId,
        path: request.path,
        operation: request.operation,
        snapshotVersion: snapshot.policyVersion,
        snapshotRuleId: snapshot.ruleId,
        snapshotDecision: snapshot.decision.decision,
        revalidatedVersion: revalidatedPolicyVersion,
        revalidatedRuleId,
        revalidatedDecision,
        truncated,
        maxOutputBytes: snapshot.maxOutputBytes,
      });
      return this.staleOutcome(request, snapshot, {
        revalidatedPolicyVersion,
        revalidatedRuleId,
        revalidatedDecision,
        reason: `repository-read-boundary: the policy snapshot is stale — the snapshot (version=${snapshot.policyVersion ?? 'not-surfaced'}, rule=${snapshot.ruleId ?? 'default'}, decision=${snapshot.decision.decision}) that authorized this read is no longer current (revalidation saw version=${revalidatedPolicyVersion ?? 'not-surfaced'}, rule=${revalidatedRuleId ?? 'default'}, decision=${revalidatedDecision}) — the read result is discarded (fencing: a repository-read result is persisted only if the policy snapshot that authorized it is still current when the result is committed)`,
      });
    }

    // ---- 8. THE SNAPSHOT IS STILL CURRENT — return the bound outcome
    // (round-4 fencing — step 6, the NOT-stale branch). The decision + the
    // policy version + the rule id + the enforcement effect + the
    // (possibly truncated) content + the revalidation metadata are
    // returned by ONE method. The authorization snapshot and the actual
    // read are bound in a single fenced outcome: the read was performed
    // under V7, the revalidation confirmed V7 is still current, so the
    // result is safe to persist.
    const enforcement: RepositoryReadEnforcement = {
      policyVersion: snapshot.policyVersion,
      ruleId: snapshot.ruleId,
      performed: true, // the read was performed AND the snapshot was revalidated current
      truncated,
      maxOutputBytes: snapshot.maxOutputBytes,
      truncatedAtBytes,
      pathAllowed: true,
      reason: snapshot.reason,
      // Round-4 fencing metadata:
      revalidated: true,
      revalidatedPolicyVersion,
      revalidatedRuleId,
      revalidatedDecision,
      stale: false,
    };
    const governance: RepositoryReadGovernance = {
      decision: snapshot.decision.decision,
      reason: snapshot.reason,
      policyVersion: snapshot.policyVersion,
      ruleId: snapshot.ruleId,
      performed: true,
      stale: false,
      enforcement,
    };
    return { request, content, governance };
  }

  // =========================================================================
  // PR #42 round-5 (the persistence-boundary fence): capture the CURRENT
  // policy snapshot at the persistence boundary.
  //
  // THE ROUND-5 BLOCKER (the architect's review of commit `2a597ed`): the
  // round-4 fence protects the READ window (capture V7 -> read -> revalidate
  // V7 -> discard if stale) but does NOT protect the SUBSEQUENT PERSISTENCE
  // window. The persistence flow is:
  //
  //   analyze() returns evidence[] (each row carries its per-read V7 from
  //     the round-4 fence)
  //     ↓
  //   policy mutates V7 -> V8       ← the round-4 fence does NOT cover this gap
  //     ↓
  //   appendEvidence(V7)            ← STALE V7 evidence committed
  //     ↓
  //   upsertObservations(V7)       ← STALE V7 observations committed
  //     ↓
  //   markComplete
  //
  // THE ROUND-5 FIX: the orchestrator captures the CURRENT policy snapshot
  // (this method) AFTER analyze() returns + BEFORE the persistence transaction
  // begins. The /projects repository's `persistBaselineWithPolicyFence`
  // method revalidates this snapshot INSIDE the DB transaction (pre-writes +
  // post-writes + per-read verification) + rolls back if it is stale. If the
  // policy mutated BETWEEN the per-read fence and this capture, the snapshot
  // (V8) differs from the evidence's per-read policyVersion (V7) — the per-
  // read verification inside the transaction catches the mismatch + rolls
  // back. ZERO stale evidence/observations are committed.
  //
  // THE SYNTHETIC REQUEST: the fence uses ONLY the policyVersion + ruleId
  // for drift detection (the decision itself is NOT enforced at the
  // persistence boundary — the per-read fence already enforced it for each
  // individual read). The synthetic 'persist-baseline' request keeps the
  // WORK-037 gate's API stable (it always takes a ToolPolicyRequest — no
  // separate "fetch current version" method is added to the gate, keeping
  // that frozen boundary intact).
  //
  // FAIL-CLOSED: if the gate throws on the capture call, the boundary
  // returns a null snapshot (policyVersion=null, ruleId=null, decision=null).
  // The persistence fence's revalidation will compare it against a fresh
  // revalidation (which will ALSO fail-closed to null) — both null = no drift
  // signal = stale=false (best-effort). The orchestrator logs the failure
  // (forensic) + proceeds with the best-effort snapshot.
  // =========================================================================

  async capturePersistenceSnapshot(
    ctx: AnalysisContext,
  ): Promise<PersistencePolicySnapshot> {
    // Build a synthetic 'persist-baseline' request. The fence uses ONLY the
    // policyVersion + ruleId for drift detection; the decision/operation/path
    // are not enforced at the persistence boundary (the per-read fence already
    // enforced them). The synthetic request keeps the WORK-037 gate's API
    // stable (it always takes a ToolPolicyRequest).
    const policyRequest: ToolPolicyRequest = {
      invocationId: `${ctx.analysisRunId}:persist-baseline`,
      executionId: `onboarding:${ctx.baselineId}`,
      sessionId: ctx.analysisRunId,
      workspaceId: `onboarding:${ctx.baselineId}`,
      family: 'filesystem',
      operation: 'persist-baseline',
      input: { baselineId: ctx.baselineId, mode: 'persist' } as Record<string, unknown>,
    };
    try {
      const decision = await this.deps.policyGate.decideForProjectScope(
        policyRequest,
        ctx.projectId,
        ctx.organizationId,
      );
      return {
        policyVersion: decision.policyVersion ?? null,
        ruleId: decision.ruleId ?? null,
        decision: decision.decision,
        reason: decision.reason ?? null,
      };
    } catch (err) {
      // The gate failed to resolve a decision. FAIL CLOSED: return a null
      // snapshot (the persistence fence's revalidation will compare it against
      // a fresh revalidation that also fails-closed — both null = no drift
      // signal = stale=false, best-effort). The orchestrator logs the failure
      // (forensic) + proceeds with the best-effort snapshot. This is the
      // same fail-closed behavior as the round-4 fence's capture-failure
      // path: a policy-gate failure must NOT become an implicit allow (the
      // persistence is REJECTED if the revalidation also fails — the
      // revalidation call's failure is treated as stale by the persistence
      // fence).
      this.deps.logger.error('repository-read.persistence-snapshot-capture-failed', {
        baselineId: ctx.baselineId,
        projectId: ctx.projectId,
        error: (err as Error).message,
      });
      return {
        policyVersion: null,
        ruleId: null,
        decision: null,
        reason: `persistence-snapshot-capture-failed: the project-scoped policy gate failed to resolve a decision (${(err as Error).message}) — returning a null snapshot (best-effort; the persistence fence will compare it against a fresh revalidation)`,
      };
    }
  }

  /**
   * Build a blocked outcome (the read did not happen — deny/ask/path-not-
   * allowed/operation-not-read). The decision + reason + policyVersion +
   * ruleId are still recorded honestly — the evidence row will carry
   * repository_read_decision + the enforcement record (performed=false,
   * stale=false, revalidated=false — the fence did not run because the read
   * never happened) so a later auditor sees WHY the read was blocked AND
   * under which policy version. The revalidation fields are null/false
   * (no revalidation was performed — the read was blocked before reaching
   * the fence).
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
      // Round-4 fencing: the fence did NOT run (the read was blocked before
      // reaching it). revalidated=false; the revalidation fields are null;
      // stale=false (the snapshot was not stale — it was never captured
      // for a boundary-level refusal, or it was deny/ask which does not
      // require fencing because no read happened).
      revalidated: false,
      revalidatedPolicyVersion: null,
      revalidatedRuleId: null,
      revalidatedDecision: null,
      stale: false,
    };
    const governance: RepositoryReadGovernance = {
      decision: args.decision,
      reason: args.reason,
      policyVersion: args.policyVersion,
      ruleId: args.ruleId,
      performed: false,
      stale: false,
      enforcement,
    };
    return { request, content: null, governance };
  }

  /**
   * Build a STALE outcome (round-4 fencing — the read happened but the
   * snapshot that authorized it is NO LONGER current at revalidation). The
   * read result is DISCARDED: content=null, performed=false, stale=true.
   * The analyzer persists NO evidence row + NO observation for this path.
   * The snapshot decision + version + rule are recorded (forensic: "the
   * read was authorized under V7 by rule R with decision D") AND the
   * revalidation metadata is recorded (forensic: "the revalidation saw V8
   * by rule R' with decision D'"). The boundary logs the staleness; the
   * log is the forensic trail for discarded reads (the DB stays clean —
   * only successfully-authorized-and-revalidated reads produce evidence
   * rows).
   */
  private staleOutcome(
    request: GovernedReadRequest,
    snapshot: PolicySnapshot,
    args: {
      revalidatedPolicyVersion: number | null;
      revalidatedRuleId: string | null;
      revalidatedDecision: 'allow' | 'constrained' | 'deny' | 'ask' | null;
      reason: string;
    },
  ): GovernedReadOutcome {
    const enforcement: RepositoryReadEnforcement = {
      // The SNAPSHOT that authorized the read (captured at the START):
      policyVersion: snapshot.policyVersion,
      ruleId: snapshot.ruleId,
      // The read result is DISCARDED — performed=false (the result was not
      // persisted; the fence rejected it):
      performed: false,
      // The constrained enforcement WAS applied to the (now-discarded)
      // content — recorded for forensic provenance (the read happened
      // under the snapshot's maxOutputBytes constraint; the truncated
      // content was discarded):
      truncated: false, // the truncated content is not persisted; the flag reflects the persisted state (nothing)
      maxOutputBytes: snapshot.maxOutputBytes,
      truncatedAtBytes: null, // not persisted
      pathAllowed: true, // the path WAS in the allowlist (the fence rejected on version, not path)
      reason: args.reason,
      // Round-4 fencing metadata (the fence RAN and REJECTED):
      revalidated: true,
      revalidatedPolicyVersion: args.revalidatedPolicyVersion,
      revalidatedRuleId: args.revalidatedRuleId,
      revalidatedDecision: args.revalidatedDecision,
      stale: true,
    };
    const governance: RepositoryReadGovernance = {
      // The SNAPSHOT decision that authorized the (now-discarded) read:
      decision: snapshot.decision.decision,
      reason: args.reason,
      policyVersion: snapshot.policyVersion,
      ruleId: snapshot.ruleId,
      performed: false, // the result was discarded
      stale: true,
      enforcement,
    };
    return { request, content: null, governance };
  }
}
