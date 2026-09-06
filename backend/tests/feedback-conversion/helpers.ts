/**
 * WORK-068 test helpers — deterministic fixtures for the feedback→governed
 * Work Item conversion suite. No wall-clock reads: every clock is injected;
 * every observation time is a recorded fixture value.
 *
 * The signal fixtures are built through the REAL WORK-067 service (the
 * consumed authority's public surface — never a fabricated signal record),
 * and the WorkItemRepository fake honestly simulates the EXISTING
 * UNIQUE(architecture_version_id, work_item_id) DB constraint (the
 * persistence-level dedup fence) by throwing a 23505-coded error.
 */
import {
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
  type EngineeringSignalService,
  type RawObservationInput,
} from '../../src/engineering-signals/index.js';
import {
  DefaultFeedbackConversionService,
  type ConversionContext,
  type FeedbackConversionService,
} from '../../src/feedback-conversion/index.js';
import type { WorkItem, WorkItemRepository, CreateWorkItemInput, UpdateWorkItemInput } from '@modules/work-items/index.js';
import type {
  Architecture,
  ArchitectureRepository,
  ArchitectureVersion,
  ArchitectureVersionRepository,
} from '@modules/architecture/index.js';
import type { Logger } from '@platform/index.js';

/** A fixed, deterministic clock (the injected-time discipline). */
export function fixedClock(startIso: string, stepMs = 0): () => Date {
  let current = Date.parse(startIso);
  return () => {
    const now = new Date(current);
    current += stepMs;
    return now;
  };
}

/** The silent logger fixture (never a console read/write). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

/** A raw observation fixture (fully-specified; override per test). */
export function observationFixture(overrides: Partial<RawObservationInput> = {}): RawObservationInput {
  return {
    source: 'validation',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    environmentId: 'env-prod-1',
    logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-total',
    severity: 'high',
    observedAt: '2026-09-02T12:00:00Z',
    observationRef: {
      kind: 'validation-run',
      ref: 'run-1',
      detail: 'failure: step-pay/expectation-total',
    },
    raw: { failedStepId: 'step-pay', expected: 'total is 3 items', actual: null },
    releaseRef: null,
    ...overrides,
  };
}

/** Build a REAL WORK-067 signal service (fresh in-memory store). */
export function buildSignalService(): EngineeringSignalService {
  return new DefaultEngineeringSignalService({
    signalRepository: new InMemoryEngineeringSignalRepository(),
    logger: silentLogger,
    now: fixedClock('2026-09-02T00:00:00Z'),
    // continuousValidationService is optional: observation ingestion needs
    // no validation authority (only ingestValidationRun does — not used here).
  });
}

/**
 * The in-memory WorkItemRepository fake — the EXISTING /work-items intake
 * contract with the UNIQUE(architecture_version_id, work_item_id)
 * constraint honestly simulated (a duplicate create throws the 23505
 * unique-violation, exactly like the PG adapter).
 */
export class InMemoryWorkItemRepository implements WorkItemRepository {
  private readonly records = new Map<string, WorkItem>();
  private seq = 0;

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    for (const record of this.records.values()) {
      if (
        record.architectureVersionId === input.architectureVersionId &&
        record.workItemId === input.workItemId
      ) {
        const err = new Error(
          `duplicate key value violates unique constraint "wfos_work_items_architecture_version_id_work_item_id_key"`,
        );
        (err as { code?: unknown }).code = '23505';
        throw err;
      }
    }
    this.seq += 1;
    const id = `wi-${this.seq.toString().padStart(4, '0')}`;
    const record: WorkItem = {
      id,
      architectureVersionId: input.architectureVersionId,
      workItemId: input.workItemId,
      title: input.title,
      objective: input.objective ?? null,
      scope: input.scope ?? null,
      outOfScope: input.outOfScope ?? null,
      architectureConstraints: input.architectureConstraints ?? null,
      assignee: input.assignee ?? null,
      executionMetadata: input.executionMetadata ?? {},
      completed: false,
      metadata: input.metadata ?? {},
      architectureImpact: input.architectureImpact ?? null,
      createdAt: new Date('2026-09-03T00:00:00Z'),
      updatedAt: new Date('2026-09-03T00:00:00Z'),
    };
    this.records.set(id, record);
    return record;
  }

  async findById(id: string): Promise<WorkItem | null> {
    return this.records.get(id) ?? null;
  }

  async findByArchitectureVersion(architectureVersionId: string): Promise<WorkItem[]> {
    return [...this.records.values()].filter(
      (record) => record.architectureVersionId === architectureVersionId,
    );
  }

  async listForProject(_projectId: string): Promise<WorkItem[]> {
    return [...this.records.values()];
  }

  async update(id: string, input: UpdateWorkItemInput): Promise<WorkItem | null> {
    const record = this.records.get(id);
    if (!record) return null;
    const updated: WorkItem = {
      ...record,
      title: input.title ?? record.title,
      objective: input.objective ?? record.objective,
      scope: input.scope ?? record.scope,
      outOfScope: input.outOfScope ?? record.outOfScope,
      architectureConstraints: input.architectureConstraints ?? record.architectureConstraints,
      assignee: input.assignee ?? record.assignee,
      executionMetadata: input.executionMetadata ?? record.executionMetadata,
      metadata: input.metadata ?? record.metadata,
    };
    this.records.set(id, updated);
    return updated;
  }

  /** Test-only: force the completion flag (the internal completion seam). */
  forceCompleted(id: string, completed: boolean): void {
    const record = this.records.get(id);
    if (record) this.records.set(id, { ...record, completed });
  }

  /** Test-only: the write journal (the mutation-detection seam). */
  journal: CreateWorkItemInput[] = [];
}

/**
 * A recording wrapper around the WorkItemRepository fake — the
 * mutation-detection seam: every create call is journaled (the
 * discrimination proofs rely on it).
 */
export class RecordingWorkItemRepository extends InMemoryWorkItemRepository {
  constructor(private readonly inner: InMemoryWorkItemRepository) {
    super();
  }

  override async create(input: CreateWorkItemInput): Promise<WorkItem> {
    this.journal.push(structuredClone(input));
    return this.inner.create(input);
  }

  override async findById(id: string): Promise<WorkItem | null> {
    return this.inner.findById(id);
  }

  override async findByArchitectureVersion(architectureVersionId: string): Promise<WorkItem[]> {
    return this.inner.findByArchitectureVersion(architectureVersionId);
  }

  override async listForProject(projectId: string): Promise<WorkItem[]> {
    return this.inner.listForProject(projectId);
  }

  override async update(id: string, input: UpdateWorkItemInput): Promise<WorkItem | null> {
    return this.inner.update(id, input);
  }
}

/** The minimal /architecture read fakes (the ownership-validation seam). */
export class FakeArchitectureVersionRepository implements ArchitectureVersionRepository {
  constructor(private readonly versions: ArchitectureVersion[]) {}
  async findById(id: string): Promise<ArchitectureVersion | null> {
    return this.versions.find((version) => version.id === id) ?? null;
  }
  async findByArchitecture(architectureId: string): Promise<ArchitectureVersion[]> {
    return this.versions.filter((version) => version.architectureId === architectureId);
  }
  async findLatest(architectureId: string): Promise<ArchitectureVersion | null> {
    const matches = this.versions.filter((version) => version.architectureId === architectureId);
    return matches.length > 0 ? matches[matches.length - 1]! : null;
  }
  async create(): Promise<ArchitectureVersion> {
    throw new Error('not-implemented (the conversion domain never creates architecture versions)');
  }
  async transitionState(): Promise<ArchitectureVersion> {
    throw new Error('not-implemented (the conversion domain never transitions architecture versions)');
  }
}

export class FakeArchitectureRepository implements ArchitectureRepository {
  constructor(private readonly architectures: Architecture[]) {}
  async findById(id: string): Promise<Architecture | null> {
    return this.architectures.find((architecture) => architecture.id === id) ?? null;
  }
  async findByProject(_projectId: string): Promise<Architecture[]> {
    return this.architectures;
  }
  async create(): Promise<Architecture> {
    throw new Error('not-implemented (the conversion domain never creates architectures)');
  }
}

/** The canonical fixture stack: one architecture (project-1) + version v1. */
export function architectureFixtures(): {
  versions: ArchitectureVersion[];
  architectures: Architecture[];
} {
  const architecture: Architecture = {
    id: 'arch-1',
    projectId: 'project-1',
    name: 'The Product Architecture',
    description: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  };
  const version: ArchitectureVersion = {
    id: 'archver-1',
    architectureId: 'arch-1',
    versionNumber: 1,
    state: 'frozen',
    contentInline: null,
    storageKey: null,
    storageProvider: null,
    contentLength: 0,
    contentType: null,
    digestSha256: null,
    metadata: {},
    frozenAt: new Date('2026-08-01T00:00:00Z'),
    frozenBy: 'architect-fixture',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  };
  return { architectures: [architecture], versions: [version] };
}

/** Build the conversion context over the REAL WORK-067 signal service. */
export function buildConversionContext(overrides: {
  signalService?: EngineeringSignalService;
  workItemRepository?: InMemoryWorkItemRepository;
}): ConversionContext {
  const { architectures, versions } = architectureFixtures();
  return {
    organizationId: 'org-1',
    projectId: 'project-1',
    engineeringSignalService: overrides.signalService ?? buildSignalService(),
    workItemRepository: overrides.workItemRepository ?? new InMemoryWorkItemRepository(),
    architectureVersionRepository: new FakeArchitectureVersionRepository(versions),
    architectureRepository: new FakeArchitectureRepository(architectures),
    logger: silentLogger,
  };
}

/** Build the conversion service (deterministic injected clock). */
export function buildConversionService(clockIso = '2026-09-03T09:00:00Z'): FeedbackConversionService {
  return new DefaultFeedbackConversionService({
    logger: silentLogger,
    now: fixedClock(clockIso),
  });
}
