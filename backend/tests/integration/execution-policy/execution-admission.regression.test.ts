import { describe, expect, it, vi } from 'vitest';
import { DefaultExecutionAdmissionService } from '../../../src/execution-policy/internal/default-execution-admission-service.js';

describe('WORK-043 execution admission boundary', () => {
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

  it('fails closed without authoritative organization scope', async () => {
    const evaluateCandidateEligibility = vi.fn();
    const service = new DefaultExecutionAdmissionService({
      executionPolicyService: { evaluateCandidateEligibility } as never,
      organizationResolver: { getOrganizationId: async () => null },
      logger,
    });
    const result = await service.admit({ projectId: 'p', executionId: 'e' } as never);
    expect(result.admitted).toBe(false);
    expect(evaluateCandidateEligibility).not.toHaveBeenCalled();
  });

  it('passes authoritative organization scope into current eligibility', async () => {
    const evaluateCandidateEligibility = vi.fn().mockResolvedValue({
      eligibility: {
        eligible: false,
        status: 'quota_exhausted',
        blockingReasons: [{ category: 'quota', constraint: 'daily', reason: 'exhausted' }],
      },
      policyVersion: 4,
    });
    const service = new DefaultExecutionAdmissionService({
      executionPolicyService: { evaluateCandidateEligibility } as never,
      organizationResolver: { getOrganizationId: async () => 'org-a' },
      logger,
    });
    const result = await service.admit({
      projectId: 'p', executionId: 'e', workItemId: 'w', provider: 'fake', model: 'm', mode: 'native',
    } as never);
    expect(result.admitted).toBe(false);
    expect(evaluateCandidateEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a' }),
    );
  });

  it('admits an eligible current hard-constraint verdict', async () => {
    const evaluateCandidateEligibility = vi.fn().mockResolvedValue({
      eligibility: { eligible: true, status: 'eligible', blockingReasons: [] },
      policyVersion: 9,
    });
    const service = new DefaultExecutionAdmissionService({
      executionPolicyService: { evaluateCandidateEligibility } as never,
      organizationResolver: { getOrganizationId: async () => 'org-a' },
      logger,
    });
    const result = await service.admit({
      projectId: 'p', executionId: 'e', workItemId: 'w', provider: 'fake', model: 'm', mode: 'native',
    } as never);
    expect(result.admitted).toBe(true);
    expect(result.policyVersion).toBe(9);
  });
});
