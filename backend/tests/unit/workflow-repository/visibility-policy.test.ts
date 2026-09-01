/**
 * V2-002 — repository visibility policy (pure decision function, no DB).
 *
 * The policy consumes the canonical registry visibility identifiers
 * (`private` | `organization` | `public` — V2-CTRL-003, no aliases) and the
 * identity authority's membership fact, and decides READ access for a
 * principal. Fail-closed: unknown/invalid visibility denies.
 */
import { describe, it, expect } from 'vitest';
import { decideWorkflowReadAccess } from '../../../src/workflow-repository/internal/visibility-policy.js';

describe('V2-002 — decideWorkflowReadAccess (private | organization | public)', () => {
  const base = {
    userId: 'user-reader',
    ownerUserId: 'user-owner',
    organizationId: 'org-home',
  };

  it('private: ONLY the owner may read', () => {
    expect(
      decideWorkflowReadAccess({ ...base, visibility: 'private', isOrganizationMember: false }),
    ).toEqual({ allowed: false, deniedReason: 'not-visible' });
    expect(
      decideWorkflowReadAccess({ ...base, visibility: 'private', isOrganizationMember: true }),
    ).toEqual({ allowed: false, deniedReason: 'not-visible' });
    expect(
      decideWorkflowReadAccess({
        ...base,
        userId: 'user-owner',
        visibility: 'private',
        isOrganizationMember: false,
      }),
    ).toEqual({ allowed: true });
  });

  it('organization: the owner AND organization members may read', () => {
    expect(
      decideWorkflowReadAccess({ ...base, visibility: 'organization', isOrganizationMember: true }),
    ).toEqual({ allowed: true });
    expect(
      decideWorkflowReadAccess({ ...base, visibility: 'organization', isOrganizationMember: false }),
    ).toEqual({ allowed: false, deniedReason: 'not-visible' });
    expect(
      decideWorkflowReadAccess({
        ...base,
        userId: 'user-owner',
        visibility: 'organization',
        isOrganizationMember: false,
      }),
    ).toEqual({ allowed: true });
  });

  it('public: ANY authenticated principal may read (owner or not, member or not)', () => {
    expect(
      decideWorkflowReadAccess({ ...base, visibility: 'public', isOrganizationMember: false }),
    ).toEqual({ allowed: true });
    expect(
      decideWorkflowReadAccess({ ...base, visibility: 'public', isOrganizationMember: true }),
    ).toEqual({ allowed: true });
  });

  it('denies fail-closed on non-canonical visibility (no invented identifiers)', () => {
    expect(
      decideWorkflowReadAccess({
        ...base,
        visibility: 'team' as never,
        isOrganizationMember: true,
      }),
    ).toEqual({ allowed: false, deniedReason: 'not-visible' });
    expect(
      decideWorkflowReadAccess({
        ...base,
        visibility: 'PRIVATE' as never,
        isOrganizationMember: true,
      }),
    ).toEqual({ allowed: false, deniedReason: 'not-visible' });
  });
});
