/**
 * WORK-032 §35: Benchmark fixture task — a small but meaningful engineering
 * task used by the benchmark integration tests.
 *
 * The fixture is safe to run repeatedly (idempotent setup, deterministic
 * outcomes via the deterministic benchmark providers). It contains:
 *   - architecture (frozen version)
 *   - requirements + acceptance criteria
 *   - work item + work order (scope, constraints, verification requirements)
 *   - project↔GitHub repository link (fake — the FakeGitHubAdapter)
 *
 * This is NOT a trivial "hello world" — it models a real Work Item with
 * real requirements, criteria, and a Work Order that produces a deterministic
 * ImplementationContext + promptDigest.
 */
import type { TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';

export interface BenchmarkFixture {
  readonly stack: TestAuthStack;
  readonly organizationId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly architectureVersionId: string;
  readonly workItemId: string;
  readonly workOrderId: string;
  readonly requirementIds: string[];
  readonly criterionIds: string[];
  readonly apiKey: string;
}

export async function buildBenchmarkFixture(
  stack: TestAuthStack,
  apiKey: string,
  secretRef: string,
): Promise<BenchmarkFixture> {
  const org = await stack.organizationRepository.create({ name: 'Benchmark Org' });
  const user = await stack.userRepository.upsertByExternalId({
    externalId: 'benchmark-user',
    displayName: 'Benchmark User',
  });
  await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
  const project = await stack.projectRepository.create({ organizationId: org.id, name: 'Benchmark Project' });
  await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'benchmark-key',
    secretRef,
    externalId: 'benchmark-user',
    label: 'Benchmark User',
    rawKey: apiKey,
  });

  const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Benchmark Architecture' });
  const version = await stack.architectureVersionRepository.create({
    architectureId: arch.id,
    contentInline: '# Benchmark Architecture\n\nA modular monolith with clear boundaries.',
  });
  await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);

  const req = await stack.requirementRepository.create({
    architectureVersionId: version.id,
    requirementId: 'REQ-BENCH-001',
    title: 'Calculator supports addition',
    description: 'The calculator service must add two integers and return the sum.',
  });
  const criterion = await stack.acceptanceCriterionRepository.create({
    requirementId: req.id,
    criterionId: 'AC-BENCH-001',
    description: 'add(2, 3) returns 5',
    verificationExpectation: 'unit-test',
  });

  // Work item with metadata.baseCommit so the snapshot service can resolve
  // the baseline even when the FakeGitHubAdapter.getBranch fails (test mode).
  const workItem = await stack.workItemRepository.create({
    architectureVersionId: version.id,
    workItemId: 'WORK-BENCH-001',
    title: 'Implement calculator addition',
    objective: 'Add a calculator service that supports integer addition.',
    scope: 'src/calculator.ts + tests/calculator.test.ts',
    outOfScope: 'subtraction, multiplication, division',
    architectureConstraints: 'No external dependencies. Pure TypeScript.',
    metadata: { baseCommit: 'abc123baselinecommit0000000000000000000001' },
  });
  await stack.workItemRequirementRepository.associate(workItem.id, req.id);
  await stack.workItemCriterionRepository.associate(workItem.id, criterion.id);

  const workOrder = await stack.workOrderRepository.create({
    workItemId: workItem.id,
    projectId: project.id,
    architectureVersionId: version.id,
    requirementIds: [req.id],
    criterionIds: [criterion.id],
    architectureConstraints: 'No external dependencies. Pure TypeScript.',
    scope: 'src/calculator.ts + tests/calculator.test.ts',
    outOfScope: 'subtraction, multiplication, division',
    verificationRequirements: ['unit-test: add(2,3)===5', 'typecheck: tsc --noEmit passes'],
  });

  // Project↔GitHub repository link (so the snapshot service can resolve the
  // repository owner/name; the FakeGitHubAdapter handles branch operations).
  const projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(stack.db.client);
  await projectGitHubRepositoryRepository.create({
    projectId: project.id,
    installationId: 'test-installation',
    owner: 'benchmark-org',
    repository: 'benchmark-repo',
    defaultBranch: 'main',
    linkType: 'linked',
  });

  return {
    stack,
    organizationId: org.id,
    userId: user.id,
    projectId: project.id,
    architectureVersionId: version.id,
    workItemId: workItem.id,
    workOrderId: workOrder.id,
    requirementIds: [req.id],
    criterionIds: [criterion.id],
    apiKey,
  };
}
