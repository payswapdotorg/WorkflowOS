/**
 * V2-013 — internal/failed-workflow recovery (typed plans).
 *
 * The typed NEXT governed action for a failed first-party run. The plan
 * is DATA — this module never drives the run lifecycle (V2-005 stays the
 * Run authority; the caller executes the plan through the real
 * authorities).
 *
 * Fail-closed rules (the frozen work-order regressions):
 *   - only a terminal FAILED run is recoverable (never in-progress);
 *   - the failed run must belong to the manifest's workflow AND exact
 *     pinned version (scope match);
 *   - `retry_same_pin` targets the SAME pinned version as a NEW run —
 *     the failed run is never resurrected in place, and the pin NEVER
 *     moves silently (a drifted installation pin blocks the retry and
 *     demands an explicit advance);
 *   - `advance_version` is ONLY an explicit governed transition to a
 *     DIFFERENT version of the SAME workflow — PROVEN by authoritative
 *     target facts read back from the REAL V2-002 authority: BOTH the
 *     version record (the existence/publication/same-workflow proof —
 *     the PR #160 Blocker-2 correction) AND the target's installation
 *     read-back in the SAME development environment whose pinned
 *     (workflowId, versionId, versionNumber, contentDigest) EXACTLY
 *     matches the target version (the PR #160 residual Blocker-2
 *     correction: a published-but-NOT-installed target is never an
 *     advance; publish + install the new pin first; the failed run
 *     stays failed — durable history);
 *   - the self-hosting permission boundary is re-evaluated at recovery
 *     time (governance preserved: a weakened model or an out-of-boundary
 *     artifact blocks the recovery).
 */

import type {
  FailedWorkflowRecoveryPlan,
  FirstPartyPinFacts,
  FirstPartyTargetVersionFacts,
  PlanFailedWorkflowRecoveryInput,
} from '../types.js';
import { evaluateSelfHostingBoundary } from './boundary.js';

/** Plan the recovery for one failed first-party run. */
export function planFailedWorkflowRecovery(input: PlanFailedWorkflowRecoveryInput): FailedWorkflowRecoveryPlan {
  // 1. the boundary holds at recovery time (fail-closed)
  const verdict = evaluateSelfHostingBoundary(input.artifact.document, input.boundary);
  if (!verdict.allowed) {
    return {
      kind: 'blocked',
      failure: {
        code: 'SELF_HOSTING_BOUNDARY_DENIED',
        detail: `the self-hosting permission boundary denied the recovery: ${verdict.failure.code} — ${verdict.failure.detail}`,
      },
    };
  }

  // 2. the run is terminally failed (never in-progress, never resurrected)
  if (input.failedRun.state !== 'failed') {
    return {
      kind: 'blocked',
      failure: {
        code: 'SELF_HOSTING_RUN_NOT_FAILED',
        detail: `the run ${input.failedRun.runId} is in state "${input.failedRun.state}" — only a terminal FAILED run is recoverable (a run is never resurrected in place)`,
      },
    };
  }

  // 3. the run belongs to the manifest's exact pinned scope
  if (input.failedRun.workflowId !== input.manifest.workflowId || input.failedRun.versionId !== input.manifest.versionId) {
    return {
      kind: 'blocked',
      failure: {
        code: 'SELF_HOSTING_RUN_SCOPE_MISMATCH',
        detail: `the failed run ${input.failedRun.runId} belongs to ${input.failedRun.workflowId}@${input.failedRun.versionId}, not the manifest's ${input.manifest.workflowId}@${input.manifest.versionId}`,
      },
    };
  }

  // 4. the requested action
  if (input.request.action === 'retry_same_pin') {
    // the CURRENT installed pin must still be the manifest's pin — a
    // drifted pin makes retry-same-pin invalid (an explicit advance or
    // reinstall decision is required; never a silent move)
    const pinStillMatches =
      input.pinFacts.installationId === input.manifest.installationId &&
      input.pinFacts.workflowId === input.manifest.workflowId &&
      input.pinFacts.versionId === input.manifest.versionId &&
      input.pinFacts.versionNumber === input.manifest.versionNumber &&
      input.pinFacts.contentDigest === input.manifest.contentDigest;
    if (!pinStillMatches) {
      return {
        kind: 'blocked',
        failure: {
          code: 'SELF_HOSTING_RECOVERY_ADVANCE_INVALID',
          detail: `the installation pin has moved (the authority reports ${input.pinFacts.workflowId}@${input.pinFacts.versionId}, the manifest pins ${input.manifest.workflowId}@${input.manifest.versionId}) — retry-same-pin is invalid; publish and install an explicit new version (advance_version) instead`,
        },
      };
    }
    return {
      kind: 'retry_same_pin',
      workflowId: input.manifest.workflowId,
      versionId: input.manifest.versionId,
      installationId: input.manifest.installationId,
      failedRunId: input.failedRun.runId,
    };
  }

  // advance_version: an EXPLICIT governed transition to a DIFFERENT version
  // of the SAME workflow — PROVEN by authoritative version facts (never a
  // redirect in place; never a synthetic target)
  if (input.request.action === 'advance_version') {
    if (input.request.toVersionId === input.manifest.versionId) {
      return {
        kind: 'blocked',
        failure: {
          code: 'SELF_HOSTING_RECOVERY_ADVANCE_INVALID',
          detail: `the recovery advance targets the manifest's own version ${input.request.toVersionId} — an advance must be a DIFFERENT version (an explicit governed transition)`,
        },
      };
    }
    // the PR #160 Blocker-2 correction: the advance target must be PROVEN
    // by authoritative version facts read back from the REAL V2-002
    // repository authority — the typed input requires the facts (the
    // structural read-back of V2-002's immutable WorkflowVersion), and the
    // runtime re-validates them fail-closed (absent/malformed facts, facts
    // proving a different version, or facts of a foreign workflow all
    // block the plan; a synthetic target is never an advance)
    const target = (input.request as { readonly targetVersion?: unknown }).targetVersion;
    if (!isWellFormedTargetVersionFacts(target)) {
      return {
        kind: 'blocked',
        failure: {
          code: 'SELF_HOSTING_RECOVERY_TARGET_UNPROVEN',
          detail: `the advance target "${input.request.toVersionId}" carries NO well-formed authoritative version facts — the target must be read back from the REAL V2-002 repository authority (a synthetic/unproven target is never an advance; fail-closed)`,
        },
      };
    }
    if (target.version.id !== input.request.toVersionId) {
      return {
        kind: 'blocked',
        failure: {
          code: 'SELF_HOSTING_RECOVERY_TARGET_UNPROVEN',
          detail: `the supplied version facts prove "${target.version.id}", not the requested advance target "${input.request.toVersionId}" — the facts must bind the exact requested version (fail-closed)`,
        },
      };
    }
    if (target.version.workflowId !== input.manifest.workflowId) {
      return {
        kind: 'blocked',
        failure: {
          code: 'SELF_HOSTING_RECOVERY_TARGET_UNPROVEN',
          detail: `the advance target "${target.version.id}" belongs to workflow ${target.version.workflowId}, not the manifest's ${input.manifest.workflowId} — an advance is a governed transition within the SAME workflow, never across workflows (fail-closed)`,
        },
      };
    }
    // the PR #160 residual Blocker-2 correction (review 5102958519): the
    // version facts are necessary but NOT sufficient — the target must
    // ALSO be proven INSTALLED through the real V2-002 installation path
    // in the SAME development environment. The typed input requires the
    // installation read-back (the FirstPartyPinFacts shape — the
    // installation record's own read surface), and the runtime
    // re-validates fail-closed: the installation must exist (well-formed
    // facts), must belong to the manifest's current environment tenant
    // (the same development environment — the pinFacts carry its
    // organizationId), and its pinned (workflowId, versionId,
    // versionNumber, contentDigest) must EXACTLY match the target version
    // facts. A published-but-uninstalled (or wrongly-pinned) target is
    // never an advance — install the target pin first.
    if (!isWellFormedTargetInstallationFacts(target.installation)) {
      return {
        kind: 'blocked',
        failure: {
          code: 'SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED',
          detail: `the advance target "${input.request.toVersionId}" carries NO well-formed installation read-back — the target version must be installed through the REAL V2-002 installation path in this development environment and read back before an advance (a published-but-NOT-installed target is never an advance; fail-closed)`,
        },
      };
    }
    if (target.installation.organizationId !== input.pinFacts.organizationId) {
      return {
        kind: 'blocked',
        failure: {
          code: 'SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED',
          detail: `the target installation ${target.installation.installationId} belongs to environment ${target.installation.organizationId}, not the manifest's current environment ${input.pinFacts.organizationId} — an advance is proven installed in the SAME development environment only (fail-closed)`,
        },
      };
    }
    if (
      target.installation.workflowId !== target.version.workflowId ||
      target.installation.versionId !== target.version.id ||
      target.installation.versionNumber !== target.version.versionNumber ||
      target.installation.contentDigest !== target.version.contentDigest
    ) {
      return {
        kind: 'blocked',
        failure: {
          code: 'SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED',
          detail: `the installation ${target.installation.installationId} pins ${target.installation.workflowId}@${target.installation.versionId} (v${target.installation.versionNumber}, digest ${target.installation.contentDigest}), which does NOT exactly match the target version ${target.version.workflowId}@${target.version.id} (v${target.version.versionNumber}, digest ${target.version.contentDigest}) — the installation read-back must pin the EXACT target version identity (fail-closed; a wrongly-pinned installation is never an advance proof)`,
        },
      };
    }
    return {
      kind: 'advance_version',
      workflowId: input.manifest.workflowId,
      fromVersionId: input.manifest.versionId,
      toVersionId: input.request.toVersionId,
      failedRunId: input.failedRun.runId,
    };
  }

  // unreachable by the input type; kept fail-closed for malformed runtime data
  return {
    kind: 'blocked',
    failure: {
      code: 'SELF_HOSTING_RECOVERY_ADVANCE_INVALID',
      detail: `the recovery request action "${String((input.request as { readonly action?: unknown }).action)}" is not a governed recovery action (fail-closed)`,
    },
  };
}

// ============================================================================
// The advance-target validation (the PR #160 Blocker-2 correction)
// ============================================================================

/**
 * The structural shape check for authoritative target-version facts
 * (fail-closed on ANY malformed shape — the typed input carries the facts,
 * but runtime data may be cast/malformed; the recovery never crashes on
 * the advance path, it blocks typed). The `installation` leg (the residual
 * Blocker-2 correction) is validated by its own guard below.
 */
function isWellFormedTargetVersionFacts(value: unknown): value is { readonly version: FirstPartyTargetVersionFacts['version']; readonly installation?: unknown } {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const version = (value as { readonly version?: unknown }).version;
  if (version === null || typeof version !== 'object') {
    return false;
  }
  const { id, workflowId, versionNumber, contentDigest } = version as {
    readonly id?: unknown;
    readonly workflowId?: unknown;
    readonly versionNumber?: unknown;
    readonly contentDigest?: unknown;
  };
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof workflowId === 'string' &&
    workflowId.length > 0 &&
    typeof versionNumber === 'number' &&
    Number.isInteger(versionNumber) &&
    versionNumber >= 1 &&
    typeof contentDigest === 'string' &&
    contentDigest.length > 0
  );
}

/**
 * The structural shape check for the target's installation read-back (the
 * FirstPartyPinFacts shape; fail-closed on ANY malformed shape — the
 * recovery never crashes on the advance path, it blocks typed).
 */
function isWellFormedTargetInstallationFacts(value: unknown): value is FirstPartyPinFacts {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const { organizationId, installationId, workflowId, versionId, versionNumber, contentDigest } = value as {
    readonly organizationId?: unknown;
    readonly installationId?: unknown;
    readonly workflowId?: unknown;
    readonly versionId?: unknown;
    readonly versionNumber?: unknown;
    readonly contentDigest?: unknown;
  };
  return (
    typeof organizationId === 'string' &&
    organizationId.length > 0 &&
    typeof installationId === 'string' &&
    installationId.length > 0 &&
    typeof workflowId === 'string' &&
    workflowId.length > 0 &&
    typeof versionId === 'string' &&
    versionId.length > 0 &&
    typeof versionNumber === 'number' &&
    Number.isInteger(versionNumber) &&
    versionNumber >= 1 &&
    typeof contentDigest === 'string' &&
    contentDigest.length > 0
  );
}
