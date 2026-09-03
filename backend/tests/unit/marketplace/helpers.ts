/**
 * V2-012 — shared unit-test support (NOT a test file).
 *
 * Deterministic test doubles for the consumed authority ports (the REAL
 * V2-002 repository service satisfies the version-reader port structurally
 * in the integration battery; the unit battery uses a faithful in-memory
 * stub of its READ-ONLY semantics — V2-002's visibility policy verbatim:
 * private = owner only, organization = owner + members, public = anyone),
 * a membership stub, and the REAL V2-003 workflow fixtures (authored
 * through the merged builder so every pinned version carries a real
 * WorkflowIR document with real digests).
 *
 * The payment adapter used by the unit battery is the module's OWN
 * deterministic in-memory reference adapter (imported from the barrel —
 * no provider, no network, no clock).
 */
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  InMemoryPaymentAdapter,
  InMemoryMarketplaceStore,
  DefaultMarketplaceService,
  createSequentialIdFactory,
  createSteppingClock,
  type CreateOfferInput,
  type MarketplaceMembershipResolver,
  type MarketplacePaymentAdapter,
  type MarketplacePrincipal,
  type MarketplaceService,
  type MarketplaceStore,
  type MarketplaceVersionFacts,
  type MarketplaceVersionReader,
  type MarketplaceWorkflowFacts,
} from '../../../src/marketplace/index.js';

export {
  InMemoryPaymentAdapter,
  InMemoryMarketplaceStore,
  DefaultMarketplaceService,
  createSequentialIdFactory,
  createSteppingClock,
};

export type { MarketplaceService, MarketplaceStore, MarketplaceVersionReader };

// ============================================================================
// The principal fixtures
// ============================================================================

export const PUBLISHER_OWNER = 'unit-publisher-owner';
export const PUBLISHER_MEMBER = 'unit-publisher-member';
export const CUSTOMER_OWNER = 'unit-customer-owner';
export const OUTSIDER = 'unit-outsider';

export const PUBLISHER_ORG = 'org-publisher';
export const CUSTOMER_ORG = 'org-customer';
export const OTHER_ORG = 'org-other';

export const publisherPrincipal: MarketplacePrincipal = { userId: PUBLISHER_OWNER };
export const publisherMemberPrincipal: MarketplacePrincipal = { userId: PUBLISHER_MEMBER };
export const customerPrincipal: MarketplacePrincipal = { userId: CUSTOMER_OWNER };
export const outsiderPrincipal: MarketplacePrincipal = { userId: OUTSIDER };

/** Deterministic stepping-clock base for the unit battery. */
export const UNIT_CLOCK_BASE_MS = 1789500000000;
export const UNIT_CLOCK_STEP_MS = 1000;

// ============================================================================
// The REAL V2-003 workflow fixtures (merged builder — real documents)
// ============================================================================

/**
 * The digest-report fixture (the V2-011/IG-004 family shape): three
 * deterministic_api / agentic / human steps. Required capabilities:
 * github.repository.read (ordinary) + messaging.send (V2-008 SENSITIVE).
 */
export function authorDigestDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_tickets',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'scan_board',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Scan the repository board and summarize the open ticket digest.',
      },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'digest', type: { kind: 'string' } },
        { name: 'openCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'scan_board', output: 'digest' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addEdge({ from: 'fetch_tickets', to: 'scan_board', on: 'success' })
    .addEdge({ from: 'scan_board', to: 'send_digest', on: 'success' })
    .build();
}

/**
 * The EQUIVALENT maintenance update: the same public surface (inputs/
 * outputs unchanged), an internal change only (the scan task text), and an
 * honest 'equivalent' compatibility declaration → V2-003 negotiation
 * 'accept' (public-surface-unchanged).
 */
export function authorEquivalentUpdateDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_tickets',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'scan_board',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Scan the repository board and summarize the ticket digest, maintenance release 2.',
      },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'digest', type: { kind: 'string' } },
        { name: 'openCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'scan_board', output: 'digest' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addEdge({ from: 'fetch_tickets', to: 'scan_board', on: 'success' })
    .addEdge({ from: 'scan_board', to: 'send_digest', on: 'success' })
    .build();
}

/**
 * The BREAKING update: the workflow input surface GAINS a new REQUIRED
 * input (ticketQuery2) with an honest 'incompatible' declaration → V2-003
 * negotiation 'reject' (breaking-change). A distinct version requiring an
 * explicit customer transition — never a silent maintenance update.
 */
export function authorBreakingUpdateDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowInput({ name: 'ticketQuery2', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .withCompatibility({
      compatibilityLevel: 'incompatible',
      inputSurfaceChange: 'breaking',
      outputSurfaceChange: 'none',
    })
    .addNode({
      id: 'fetch_tickets',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'scan_board',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Scan the repository board and summarize the open ticket digest.',
      },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'digest', type: { kind: 'string' } },
        { name: 'openCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'scan_board', output: 'digest' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addEdge({ from: 'fetch_tickets', to: 'scan_board', on: 'success' })
    .addEdge({ from: 'scan_board', to: 'send_digest', on: 'success' })
    .build();
}

/** The version content exactly as the repository stores it (opaque JSON). */
export function versionContentOf(document: WorkflowIrDocument): Record<string, unknown> {
  return JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>;
}

// ============================================================================
// The faithful fake V2-002 read boundary (visibility policy verbatim)
// ============================================================================

/** A uniform not-found shaped like the authority's typed denial. */
export class FakeRepositoryDenial extends Error {
  readonly code: 'WORKFLOW_NOT_FOUND' | 'WORKFLOW_VERSION_NOT_FOUND';

  constructor(code: 'WORKFLOW_NOT_FOUND' | 'WORKFLOW_VERSION_NOT_FOUND', message: string) {
    super(message);
    this.name = 'WorkflowRepositoryError';
    this.code = code;
  }
}

interface FakeWorkflowSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly slug: string;
  readonly visibility: 'private' | 'organization' | 'public';
  readonly forkedFromWorkflowId?: string | null;
  readonly forkedFromVersionId?: string | null;
}

interface FakeVersionSeed {
  readonly id: string;
  readonly workflowId: string;
  readonly versionNumber: number;
  readonly content: Record<string, unknown>;
}

/**
 * The faithful in-memory stand-in for the REAL V2-002 repository service's
 * READ surface (getWorkflow/getVersion): V2-002's visibility policy
 * verbatim (private = owner only; organization = owner + members;
 * public = anyone), uniform typed not-founds, version-of-workflow
 * enforcement, and deterministic content digests.
 */
export class FakeVersionReader {
  private readonly workflows = new Map<string, MarketplaceWorkflowFacts>();
  private readonly versions = new Map<string, MarketplaceVersionFacts>();

  constructor(
    private readonly memberships: { isMember(userId: string, organizationId: string): Promise<boolean> },
  ) {}

  seedWorkflow(seed: FakeWorkflowSeed): void {
    this.workflows.set(seed.id, {
      id: seed.id,
      organizationId: seed.organizationId,
      ownerUserId: seed.ownerUserId,
      slug: seed.slug,
      visibility: seed.visibility,
      forkedFromWorkflowId: seed.forkedFromWorkflowId ?? null,
      forkedFromVersionId: seed.forkedFromVersionId ?? null,
      headVersionId: null,
    });
  }

  /** The digest is a deterministic stand-in for V2-002's content digest. */
  seedVersion(seed: FakeVersionSeed): void {
    const digest = `digest-${seed.workflowId}-${seed.id}`;
    this.versions.set(seed.id, {
      id: seed.id,
      workflowId: seed.workflowId,
      versionNumber: seed.versionNumber,
      contentDigest: digest,
      protocol: { irSchemaVersion: 'test-ir-1' },
      content: seed.content,
    });
    const workflow = this.workflows.get(seed.workflowId);
    if (workflow) {
      this.workflows.set(seed.workflowId, { ...workflow, headVersionId: seed.id });
    }
  }

  async getWorkflow(
    principal: MarketplacePrincipal,
    workflowId: string,
  ): Promise<MarketplaceWorkflowFacts> {
    const workflow = this.workflows.get(workflowId);
    if (workflow === undefined) {
      throw new FakeRepositoryDenial('WORKFLOW_NOT_FOUND', `workflow-repository: ${workflowId} not found`);
    }
    if (!(await this.visible(principal, workflow))) {
      throw new FakeRepositoryDenial('WORKFLOW_NOT_FOUND', `workflow-repository: ${workflowId} not found`);
    }
    return workflow;
  }

  async getVersion(
    principal: MarketplacePrincipal,
    workflowId: string,
    versionId: string,
  ): Promise<MarketplaceVersionFacts> {
    const workflow = await this.getWorkflow(principal, workflowId);
    const version = this.versions.get(versionId);
    if (version === undefined || version.workflowId !== workflow.id) {
      throw new FakeRepositoryDenial('WORKFLOW_VERSION_NOT_FOUND', `workflow-repository: ${versionId} not found`);
    }
    return version;
  }

  private async visible(
    principal: MarketplacePrincipal,
    workflow: MarketplaceWorkflowFacts,
  ): Promise<boolean> {
    if (principal.userId === workflow.ownerUserId) {
      return true;
    }
    switch (workflow.visibility) {
      case 'public':
        return true;
      case 'organization':
        return await this.memberships.isMember(principal.userId, workflow.organizationId);
      case 'private':
      default:
        return false;
    }
  }
}

// ============================================================================
// The membership stub + the composition factory
// ============================================================================

/** Membership stub: a set of `userId@organizationId` pairs. */
export class FakeMembershipResolver implements MarketplaceMembershipResolver {
  private readonly pairs = new Set<string>();

  assign(userId: string, organizationId: string): void {
    this.pairs.add(`${userId}@${organizationId}`);
  }

  async isMember(userId: string, organizationId: string): Promise<boolean> {
    return this.pairs.has(`${userId}@${organizationId}`);
  }
}

export interface UnitHarness {
  readonly service: MarketplaceService;
  readonly store: InMemoryMarketplaceStore;
  readonly reader: FakeVersionReader;
  readonly memberships: FakeMembershipResolver;
  readonly payments: InMemoryPaymentAdapter;
  readonly ids: () => string;
}

/**
 * The unit composition: the DEFAULT service over the faithful fake
 * repository reader + the module's own in-memory store and payment adapter
 * + deterministic sequential ids + a stepping clock. Every unit test
 * builds a FRESH harness (full isolation).
 */
export function buildUnitHarness(options?: {
  readonly failingChargeReferences?: readonly string[];
  readonly failingRefundReferences?: readonly string[];
}): UnitHarness {
  const memberships = new FakeMembershipResolver();
  memberships.assign(PUBLISHER_OWNER, PUBLISHER_ORG);
  memberships.assign(PUBLISHER_MEMBER, PUBLISHER_ORG);
  memberships.assign(CUSTOMER_OWNER, CUSTOMER_ORG);
  const reader = new FakeVersionReader(memberships);
  const store = new InMemoryMarketplaceStore();
  const payments = new InMemoryPaymentAdapter({
    failingChargeReferences: options?.failingChargeReferences ?? [],
    failingRefundReferences: options?.failingRefundReferences ?? [],
  });
  const ids = createSequentialIdFactory('mkt');
  const clock = createSteppingClock(UNIT_CLOCK_BASE_MS, UNIT_CLOCK_STEP_MS);
  const service = new DefaultMarketplaceService({
    store,
    versionReader: reader,
    memberships,
    payments,
    idFactory: ids,
    clock,
  });
  return { service, store, reader, memberships, payments, ids };
}

/**
 * The standard publisher fixture: one public workflow in the publisher org
 * (owner PUBLISHER_OWNER), version 1 pinning the digest document, plus a
 * FREE + ONE-TIME + SUBSCRIPTION offer set.
 */
export const WORKFLOW_ID = 'wfw_unit_publisher';
export const VERSION_1_ID = 'wfv_unit_publisher_1';

export interface SeededPublisher {
  readonly workflowId: string;
  readonly version1Id: string;
  readonly version2Id: string;
  readonly version2BreakingId: string;
}

export async function seedPublisherWorkflow(
  harness: UnitHarness,
): Promise<SeededPublisher> {
  harness.reader.seedWorkflow({
    id: WORKFLOW_ID,
    organizationId: PUBLISHER_ORG,
    ownerUserId: PUBLISHER_OWNER,
    slug: 'digest-report',
    visibility: 'public',
    forkedFromWorkflowId: null,
    forkedFromVersionId: null,
  });
  harness.reader.seedVersion({
    id: VERSION_1_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    content: versionContentOf(authorDigestDocument()),
  });
  const version2Id = 'wfv_unit_publisher_2';
  harness.reader.seedVersion({
    id: version2Id,
    workflowId: WORKFLOW_ID,
    versionNumber: 2,
    content: versionContentOf(authorEquivalentUpdateDocument()),
  });
  const version2BreakingId = 'wfv_unit_publisher_2b';
  harness.reader.seedVersion({
    id: version2BreakingId,
    workflowId: WORKFLOW_ID,
    versionNumber: 3,
    content: versionContentOf(authorBreakingUpdateDocument()),
  });
  return { workflowId: WORKFLOW_ID, version1Id: VERSION_1_ID, version2Id, version2BreakingId };
}

/** The standard free offer declaration. */
export function freeOffer(): CreateOfferInput {
  return { model: 'free', terms: { model: 'free' } };
}

/** A one-time purchase offer declaration. */
export function oneTimeOffer(
  updatePolicy: 'pinned_only' | 'compatible_updates' = 'pinned_only',
): CreateOfferInput {
  return {
    model: 'one_time_purchase',
    terms: {
      model: 'one_time_purchase',
      amount: '19.99',
      currency: 'USD',
      updatePolicy,
    },
  };
}

/** A maintenance-subscription offer declaration. */
export function subscriptionOffer(): CreateOfferInput {
  return {
    model: 'maintenance_subscription',
    terms: {
      model: 'maintenance_subscription',
      amount: '4.50',
      currency: 'USD',
    },
  };
}

/** Create + publish the standard listing (free + one-time + subscription). */
export async function createPublishedListing(
  harness: UnitHarness,
  seeded: SeededPublisher,
  offers?: readonly CreateOfferInput[],
): Promise<string> {
  const created = await harness.service.createListing(publisherPrincipal, {
    organizationId: PUBLISHER_ORG,
    workflowId: seeded.workflowId,
    versionId: seeded.version1Id,
    name: 'Digest Report',
    description: 'The unit fixture listing',
    offers: offers ?? [freeOffer(), oneTimeOffer(), subscriptionOffer()],
  });
  const listingId = created.listing.id;
  await harness.service.publishListing(publisherPrincipal, { listingId });
  return listingId;
}

export type { MarketplacePaymentAdapter };
