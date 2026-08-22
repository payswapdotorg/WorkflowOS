import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { DefaultLlmGateway, FakeLlmAdapter } from '../../../src/modules/llm/internal/llm-gateway.js';
import { DefaultArchitectService } from '../../../src/modules/llm/internal/architect-service.js';
import { PgWorkOrderRepository } from '../../../src/modules/work-items/internal/pg-work-item-repository.js';
import type {
  WorkOrder,
  WorkOrderRepository,
  WorkOrderState,
  CreateWorkOrderInput,
} from '@modules/work-items/index.js';
import type { ArchitectExecutionResult } from '@modules/llm/index.js';
import type { User } from '@modules/users/index.js';

/**
 * Regression: PR #13 architect review — generated Work Orders must flow through
 * the existing /work-items `WorkOrderRepository` contract, NOT be written
 * directly to `wfos_work_orders` through `DatabaseClient`.
 *
 * The frozen architecture (WORK-014 §3, §11, §17, §23) requires:
 *
 *   /llm (Architect Service)
 *       → WorkOrderRepository contract
 *       → /work-items persistence (wfos_work_orders)
 *
 * This test enforces that boundary by wrapping the real `PgWorkOrderRepository`
 * in a capturing spy. If the Architect Service is ever refactored back to
 * writing raw `INSERT INTO wfos_work_orders` SQL, the spy's call log will be
 * empty and this test will fail — proving the boundary was bypassed.
 */
class CapturingWorkOrderRepository implements WorkOrderRepository {
  readonly createCalls: CreateWorkOrderInput[] = [];
  readonly updateStateCalls: { id: string; state: WorkOrderState }[] = [];

  constructor(private readonly inner: WorkOrderRepository) {}

  async create(input: CreateWorkOrderInput): Promise<WorkOrder> {
    this.createCalls.push(input);
    return this.inner.create(input);
  }

  async findById(id: string): Promise<WorkOrder | null> {
    return this.inner.findById(id);
  }

  async listForWorkItem(workItemId: string): Promise<WorkOrder[]> {
    return this.inner.listForWorkItem(workItemId);
  }

  async updateState(id: string, state: WorkOrderState): Promise<WorkOrder | null> {
    this.updateStateCalls.push({ id, state });
    return this.inner.updateState(id, state);
  }
}

describe('WORK-014 regression — Work Order generation must go through WorkOrderRepository', () => {
  let stack: TestAuthStack;
  let architectService: DefaultArchitectService;
  let capturingRepo: CapturingWorkOrderRepository;
  let fakeLlm: FakeLlmAdapter;
  let orgA: { id: string };
  let userA: User;
  let projectA: { id: string };
  let versionA: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-arch-boundary-a',
    });
    orgA = await stack.organizationRepository.create({ name: 'Arch Boundary Org A' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'arch-boundary-user-a', displayName: 'User A' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Arch Boundary Project A' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Arch Boundary Arch A' });
    versionA = await stack.architectureVersionRepository.create({
      architectureId: archA.id,
      contentInline: 'Arch boundary constraints v1',
    });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

    fakeLlm = new FakeLlmAdapter();
    const llmGateway = new DefaultLlmGateway(stack.db.client, stack.db.logger, [fakeLlm], 3);
    capturingRepo = new CapturingWorkOrderRepository(new PgWorkOrderRepository(stack.db.client));
    architectService = new DefaultArchitectService(
      stack.db.client,
      llmGateway,
      capturingRepo,
      stack.db.logger,
    );
  });

  afterAll(async () => {
    await stack.teardown();
  });

  async function executeAndGenerate(
    executionId: string,
    workItemId: string,
    candidate: NonNullable<ArchitectExecutionResult['workOrderCandidate']>,
  ): Promise<{ workOrderId: string; architectExecutionId: string }> {
    fakeLlm.setResponse(JSON.stringify({
      verdict: 'approve',
      summary: 'boundary regression',
      reasoning: '',
      risks: [],
      constraints: [],
      corrections: [],
      architectureChangeRequired: false,
      workOrder: {
        scope: candidate.scope,
        outOfScope: candidate.outOfScope,
        constraints: candidate.architectureConstraints,
        requirementIds: candidate.requirementIds,
        criterionIds: candidate.criterionIds,
        verificationRequirements: candidate.verificationRequirements,
        implementationContext: candidate.implementationContext,
      },
    }));
    const archResult = await architectService.execute({
      projectId: projectA.id,
      architectureVersionId: versionA.id,
      workItemId,
      task: 'Boundary regression',
      executionId,
      provider: 'fake',
      model: 'test-model',
    });
    return architectService.generateWorkOrder(
      {
        projectId: projectA.id,
        architectureVersionId: versionA.id,
        workItemId,
        task: 'Boundary regression',
        executionId,
        provider: 'fake',
        model: 'test-model',
      },
      archResult,
    );
  }

  it('routes Work Order creation through WorkOrderRepository.create()', async () => {
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: 'BOUNDARY-001',
      title: 'Boundary regression work item',
    });
    const baselineCreateCalls = capturingRepo.createCalls.length;
    const result = await executeAndGenerate('arch-boundary-001', wi.id, {
      scope: 'Implement boundary-safe flow',
      outOfScope: 'No raw SQL',
      architectureConstraints: 'Reuse /work-items repository',
      requirementIds: [],
      criterionIds: [],
      verificationRequirements: ['repository-boundary test'],
      implementationContext: { branch: 'feat/boundary' },
    });

    // Exactly one create() call must have been made through the repository.
    expect(capturingRepo.createCalls.length).toBe(baselineCreateCalls + 1);
    const createCall = capturingRepo.createCalls[capturingRepo.createCalls.length - 1]!;
    expect(createCall.workItemId).toBe(wi.id);
    expect(createCall.projectId).toBe(projectA.id);
    expect(createCall.architectureVersionId).toBe(versionA.id);
    expect(createCall.scope).toBe('Implement boundary-safe flow');
    expect(createCall.outOfScope).toBe('No raw SQL');
    expect(createCall.architectureConstraints).toBe('Reuse /work-items repository');
    expect(createCall.requirementIds).toEqual([]);
    expect(createCall.criterionIds).toEqual([]);
    expect(createCall.verificationRequirements).toEqual(['repository-boundary test']);

    // Traceability: the architect execution ID is recorded on the Work Order.
    // implementationContext is optional on CreateWorkOrderInput but is always
    // supplied by the Architect Service, so we assert via a non-null coercion.
    const implContext = createCall.implementationContext ?? {};
    expect(implContext.architectExecutionId).toBe('arch-boundary-001');
    expect(implContext.architectProvider).toBe('fake');
    expect(implContext.architectModel).toBe('test-model');
    expect(implContext.branch).toBe('feat/boundary');

    // The persisted Work Order is retrievable via the /work-items repository —
    // proof the mutation reached /work-items persistence, not a /llm-local
    // table or transient state.
    const persisted = await stack.workOrderRepository.findById(result.workOrderId);
    expect(persisted).not.toBeNull();
    expect(persisted!.id).toBe(result.workOrderId);
    expect(persisted!.workItemId).toBe(wi.id);
    expect(persisted!.projectId).toBe(projectA.id);
    expect(persisted!.architectureVersionId).toBe(versionA.id);
  });

  it('routes the draft → generated transition through WorkOrderRepository.updateState()', async () => {
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: 'BOUNDARY-002',
      title: 'Boundary state regression work item',
    });
    const baselineUpdateCalls = capturingRepo.updateStateCalls.length;
    const result = await executeAndGenerate('arch-boundary-002', wi.id, {
      scope: 'Implement state boundary',
      outOfScope: 'No state mutation outside repo',
      architectureConstraints: 'Use updateState()',
      requirementIds: [],
      criterionIds: [],
      verificationRequirements: [],
      implementationContext: {},
    });

    // Exactly one updateState() call transitioning to 'generated' must have
    // been made through the repository. This proves the state transition is
    // NOT performed via raw `UPDATE wfos_work_orders SET state = 'generated'`.
    expect(capturingRepo.updateStateCalls.length).toBe(baselineUpdateCalls + 1);
    const updateCall = capturingRepo.updateStateCalls[capturingRepo.updateStateCalls.length - 1]!;
    expect(updateCall.id).toBe(result.workOrderId);
    expect(updateCall.state).toBe('generated');

    // And the persisted Work Order really is in 'generated' state.
    const persisted = await stack.workOrderRepository.findById(result.workOrderId);
    expect(persisted!.state).toBe('generated');
  });

  it('preserves existing project / Work Item / ArchitectureVersion integrity protections', async () => {
    // The /work-items persistence trigger
    // (wfos_check_work_order_integrity) enforces that a Work Order's
    // architecture_version_id matches its Work Item's architecture_version_id
    // and that project_id matches the architecture version → architecture →
    // project chain. The Architect Service must not bypass these by writing
    // raw SQL — it must go through the repository, which still hits the
    // trigger. We prove that by attempting to generate a Work Order with a
    // mismatched architecture version: the repository must reject it at the
    // persistence layer (not the service layer).
    const archOther = await stack.architectureRepository.create({
      projectId: projectA.id,
      name: 'Arch Boundary Arch Other (different version)',
    });
    const versionOther = await stack.architectureVersionRepository.create({
      architectureId: archOther.id,
      contentInline: 'Other version content',
    });
    await stack.architectureVersionRepository.transitionState(versionOther.id, 'frozen', userA.id);

    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: 'BOUNDARY-003',
      title: 'Integrity protection regression work item',
    });

    // The work item belongs to versionA, but the architect request claims
    // versionOther. This must be rejected by the persistence-layer trigger
    // because the WorkOrderRepository.create() call goes through the same
    // wfos_work_orders_integrity_check trigger that catches raw SQL.
    fakeLlm.setResponse(JSON.stringify({
      verdict: 'approve',
      summary: 'integrity regression',
      reasoning: '',
      risks: [],
      constraints: [],
      corrections: [],
      architectureChangeRequired: false,
      workOrder: {
        scope: 'Attempt mismatched version',
        outOfScope: '',
        constraints: '',
        requirementIds: [],
        criterionIds: [],
        verificationRequirements: [],
        implementationContext: {},
      },
    }));
    const archResult = await architectService.execute({
      projectId: projectA.id,
      architectureVersionId: versionA.id,
      workItemId: wi.id,
      task: 'Integrity regression',
      executionId: 'arch-boundary-003',
      provider: 'fake',
      model: 'test-model',
    });

    // Force a mismatched-version generation request. The request claims
    // versionOther (different from the work item's versionA). The
    // persistence-layer trigger must reject this even though it flows through
    // the WorkOrderRepository contract.
    await expect(
      architectService.generateWorkOrder(
        {
          projectId: projectA.id,
          architectureVersionId: versionOther.id,
          workItemId: wi.id,
          task: 'Integrity regression',
          executionId: 'arch-boundary-003',
          provider: 'fake',
          model: 'test-model',
        },
        archResult,
      ),
    ).rejects.toThrow();

    // And no Work Order for the mismatched request should exist.
    const list = await stack.workOrderRepository.listForWorkItem(wi.id);
    const mismatched = list.filter((wo) => wo.architectureVersionId === versionOther.id);
    expect(mismatched).toEqual([]);
  });
});
