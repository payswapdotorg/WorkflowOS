/**
 * V2-002 — the repository read-visibility policy (PURE decision function).
 *
 * Consumes the canonical registry visibility identifiers (private |
 * organization | public — V2-CTRL-003, no aliases) plus the identity
 * authority's membership fact, and decides READ access to a workflow for a
 * principal. Fail-closed: a non-canonical visibility denies.
 *
 * Denials are uniform ('not-visible') so callers can answer 404 WITHOUT
 * leaking the existence of private/organization-scoped workflows
 * (cross-scope reads, forks, and installs all route through this decision).
 */
import type { Workflow, WorkflowVisibility } from '../types.js';

export interface WorkflowReadAccessDecision {
  readonly allowed: boolean;
  readonly deniedReason?: 'not-visible';
}

export interface WorkflowReadAccessInput {
  readonly userId: string;
  readonly visibility: WorkflowVisibility;
  readonly ownerUserId: string;
  readonly organizationId: string;
  /** The identity authority's membership fact for (userId, organizationId). */
  readonly isOrganizationMember: boolean;
}

const CANONICAL_VISIBILITIES: ReadonlySet<string> = new Set([
  'private',
  'organization',
  'public',
]);

/**
 * Decide read access for a principal against one workflow's visibility.
 *
 *   private     — the owner only;
 *   organization— the owner and members of the workflow's organization;
 *   public      — any authenticated principal;
 *   anything else — DENIED fail-closed (no invented identifiers).
 */
export function decideWorkflowReadAccess(
  input: WorkflowReadAccessInput,
): WorkflowReadAccessDecision {
  if (!CANONICAL_VISIBILITIES.has(input.visibility)) {
    return { allowed: false, deniedReason: 'not-visible' };
  }
  if (input.userId === input.ownerUserId) {
    // The owner always reads their own workflow (ownership is the private
    // scope authority).
    return { allowed: true };
  }
  switch (input.visibility) {
    case 'public':
      return { allowed: true };
    case 'organization':
      return input.isOrganizationMember
        ? { allowed: true }
        : { allowed: false, deniedReason: 'not-visible' };
    case 'private':
      return { allowed: false, deniedReason: 'not-visible' };
    default:
      return { allowed: false, deniedReason: 'not-visible' };
  }
}

/** Convenience overload over a full workflow record. */
export function decideWorkflowReadAccessFor(
  principal: { userId: string },
  workflow: Pick<Workflow, 'visibility' | 'ownerUserId' | 'organizationId'>,
  isOrganizationMember: boolean,
): WorkflowReadAccessDecision {
  return decideWorkflowReadAccess({
    userId: principal.userId,
    visibility: workflow.visibility,
    ownerUserId: workflow.ownerUserId,
    organizationId: workflow.organizationId,
    isOrganizationMember,
  });
}
