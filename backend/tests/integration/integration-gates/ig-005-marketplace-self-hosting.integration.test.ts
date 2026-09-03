/**
 * IG-005 — Marketplace ↔ Self-Hosting Integration (the W6+ composition gate).
 *
 * Work order: spec/architecture/v2/work-orders/IG-005.md (frozen).
 * Scope: INTEGRATION TESTS ONLY — no production source is touched; V2-012
 * and V2-013 semantics are consumed exactly as merged.
 *
 * The gate proves the work order's six required facts on the REAL stack —
 * the marketplace domain and the self-hosted library composed OVER the
 * SAME real authorities:
 *
 *   - the REAL V2-002 workflow-repository service behind the REAL Fastify
 *     routes (every repository mutation flows through `app.inject`: create
 *     → visibility → FORK → modify → maintenance version → cross-tenant
 *     INSTALL — the identical product path third-party workflows use);
 *   - the REAL V2-005 workflow-runs service (the run command surface —
 *     request/start/complete — with its OWN authorization chain:
 *     organization membership, pinned-version resolution, installation
 *     pin matching);
 *   - the REAL V2-012 marketplace service (DefaultMarketplaceService over
 *     the real repository as the MarketplaceVersionReader port, the
 *     deterministic in-memory payment adapter — no real provider calls);
 *   - the REAL V2-013 self-hosted library (installFirstPartyWorkflows,
 *     publishFirstPartyVersion, evaluateSelfHostingBoundary) over the same
 *     repository port, and the REAL development-governance state loader
 *     reading the canonical spec/development-state governance model.
 *
 * Required proof (the frozen work-order checklist, proven HERE):
 *   1. published workflow installation remains version-pinned — the
 *      marketplace install pins the exact purchased version; a maintenance
 *      update (a NEW revision pinning a NEW version) NEVER moves it; the
 *      first-party install holds the identical pin semantics;
 *   2. entitlement does not bypass execution authorization — the full
 *      commerce flow creates ZERO runs; an ACTIVE entitlement is not an
 *      execution credential (typed RUN_INSTALLATION_MISMATCH when abused
 *      as one); execution requires the run authority's own chain
 *      (membership + pin match), exactly as for first-party workflows;
 *   3. fork provenance survives publication — the listing revision trust
 *      carries the fork facts verbatim through publish, purchase and
 *      maintenance updates (every revision, never rewritten);
 *   4. first-party WorkflowOS workflows use the same protocol as
 *      third-party workflows — the SAME install route, the SAME pin
 *      facts, the SAME immutability, the SAME run command surface;
 *   5. self-hosting cannot bypass development governance — the REAL
 *      boundary model admits the six artifacts; a weakened model is
 *      fail-closed; forged merge-gate / out-of-allowlist capabilities are
 *      typed denials;
 *   6. maintenance updates create explicit version transitions — a NEW
 *      immutable version + a NEW pinning revision (never an in-place
 *      mutation) on the marketplace side; a NEW version through
 *      publishFirstPartyVersion with the installed pin held, and the
 *      recovery advance requires the target to be proven INSTALLED
 *      (published-but-not-installed → blocked, typed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import {
  buildTriggerTestStack,
  createTenant,
  versionContentOf,
  commitmentOf,
  type TriggerTestStack,
} from '../workflow-deployments/trigger-test-support.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  DefaultMarketplaceService,
  InMemoryMarketplaceStore,
  InMemoryPaymentAdapter,
  createSequentialIdFactory,
  createSteppingClock,
  type MarketplaceService,
  type MarketplaceVersionReader,
} from '../../../src/marketplace/index.js';
import {
  installFirstPartyWorkflows,
  publishFirstPartyVersion,
  evaluateSelfHostingBoundary,
  validateBoundaryModel,
  planFailedWorkflowRecovery,
  artifactByKind,
  FIRST_PARTY_WORKFLOW_ARTIFACTS,
  type FirstPartyInstallPort,
  type FirstPartyPinFacts,
  type FirstPartyInstallOutcome,
  type SelfHostingBoundaryPolicyInput,
  type FirstPartyTargetVersionFacts,
} from '../../../src/self-hosted-library/index.js';
import { FileSystemGovernanceStateLoader } from '../../../src/development-governance/index.js';
import type { FastifyInstance } from 'fastify';

const API_KEY = 'ig-005-api-test-key';
const OPERATOR_EXTERNAL_ID = 'ig-005-api-operator';
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
}

let support: TriggerTestStack;
/** The REAL Fastify app: the V2-002 workflow-repository routes (inject-driven). */
let app: FastifyInstance;
let operatorUserId: string;
/** The development environment (org A) — the self-hosting tenant. */
let devOrgId: string;
let devUserId: string;
/** The REAL repository service — also the structural first-party install port. */
let port: FirstPartyInstallPort;
/** The REAL governance boundary (from the canonical governance model). */
let realBoundary: SelfHostingBoundaryPolicyInput;

beforeAll(async () => {
  support = await buildTriggerTestStack({
    WFOS_IG_005_API_TEST_KEY: API_KEY,
  });
  devOrgId = support.orgAId;
  devUserId = support.ownerAId;
  port = support.repository as unknown as FirstPartyInstallPort;
  const operator = await support.stack.userRepository.upsertByExternalId({
    externalId: OPERATOR_EXTERNAL_ID,
    displayName: 'IG-005 API Operator',
  });
  operatorUserId = operator.id;
  const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
  await provisioner.provision({
    keyId: 'ig-005-api-test-key-id',
    secretRef: 'WFOS_IG_005_API_TEST_KEY',
    externalId: OPERATOR_EXTERNAL_ID,
    label: 'IG-005 API Operator',
    rawKey: API_KEY,
  });
  const authProvider = new ApiKeyAuthProvider(support.stack.db.client, new EnvSecretStore());
  app = await buildServer({
    queue: new InMemoryQueue(),
    logger: createLogger({ level: 'silent' }),
    auth: { authProvider, userRepository: support.stack.userRepository },
    workflowRepository: { workflowRepositoryService: support.repository },
  });
  await app.ready();
  const loaded = await new FileSystemGovernanceStateLoader({
    repoRoot: REPO_ROOT,
    governanceDir: join(REPO_ROOT, 'spec', 'development-state'),
  }).inspect();
  expect(loaded.validation.ok, loaded.validation.violations.join('\n')).toBe(true);
  realBoundary = loaded.model.selfHostingBoundary;
});

afterAll(async () => {
  await app.close();
  await support.teardown();
});

// ============================================================================
// The real HTTP surface (the product path — every repository mutation is inject)
// ============================================================================

async function injectJson(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers:
      payload === undefined
        ? { authorization: `Bearer ${API_KEY}` }
        : { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    payload: payload as Record<string, unknown> | undefined,
  });
  return {
    status: response.statusCode,
    body: (response.json() ?? {}) as Record<string, unknown>,
    raw: response.body,
  };
}

/** A fresh tenant with the API-key operator joined as owner (route driver). */
async function freshTenant(label: string, memberExternalId: string) {
  const tenant = await createTenant(support, `ig005-${label}`);
  const member = await support.stack.userRepository.upsertByExternalId({
    externalId: memberExternalId,
    displayName: `IG-005 ${label}`,
  });
  await support.stack.membershipRepository.assign({
    userId: member.id,
    organizationId: tenant.organizationId,
    roleId: 'member',
  });
  await support.stack.membershipRepository.assign({
    userId: operatorUserId,
    organizationId: tenant.organizationId,
    roleId: 'owner',
  });
  return {
    organizationId: tenant.organizationId,
    ownerUserId: tenant.ownerUserId,
    memberUserId: member.id,
    operatorUserId,
  };
}

// ============================================================================
// The safe test workflow (real V2-003 builder; the send_digest node carries a
// real secret_ref binding — the secret-isolation witness)
// ============================================================================

function authorDigestDocument(scanTask: string): WorkflowIrDocument {
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
      spec: { class: 'agentic_computer_use', task: scanTask },
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
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addEdge({ from: 'fetch_tickets', to: 'scan_board', on: 'success' })
    .addEdge({ from: 'scan_board', to: 'send_digest', on: 'success' })
    .build();
}

const ONE_TIME_OFFER = {
  model: 'one_time_purchase' as const,
  terms: {
    model: 'one_time_purchase' as const,
    amount: '19.99',
    currency: 'USD',
    updatePolicy: 'pinned_only' as const,
  },
};

/** Create a workflow (born private) through the REAL V2-002 routes. */
async function createWorkflow(
  t: { organizationId: string; ownerUserId: string },
  slug: string,
  scanTask: string,
): Promise<{ workflowId: string; version: VersionPayload }> {
  const res = await injectJson('POST', `/organizations/${t.organizationId}/workflow-repository/workflows`, {
    slug,
    name: 'Repository Ticket Digest',
    description: 'The IG-005 integration fixture',
    visibility: 'private',
    content: versionContentOf(authorDigestDocument(scanTask)),
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  });
  expect(res.status, res.raw).toBe(201);
  const created = res.body as unknown as {
    workflow: { id: string; headVersionId: string };
    initialVersion: VersionPayload;
  };
  return { workflowId: created.workflow.id, version: created.initialVersion };
}

/** Flip a workflow's repository visibility through the REAL route. */
async function setVisibility(
  workflowId: string,
  visibility: 'private' | 'organization' | 'public',
): Promise<void> {
  const res = await injectJson('PATCH', `/workflow-repository/workflows/${workflowId}`, { visibility });
  expect(res.status, res.raw).toBe(200);
}

/** Create a NEW immutable version through the REAL V2-002 route. */
async function createVersion(
  workflowId: string,
  parentVersionId: string,
  scanTask: string,
): Promise<VersionPayload> {
  const res = await injectJson('POST', `/workflow-repository/workflows/${workflowId}/versions`, {
    content: versionContentOf(authorDigestDocument(scanTask)),
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId,
  });
  expect(res.status, res.raw).toBe(201);
  return (res.body as unknown as { version: VersionPayload }).version;
}

/** Read one exact version through the REAL route. */
async function readVersion(workflowId: string, versionId: string): Promise<VersionPayload> {
  const res = await injectJson('GET', `/workflow-repository/workflows/${workflowId}/versions/${versionId}`);
  expect(res.status, res.raw).toBe(200);
  return (res.body as unknown as { version: VersionPayload }).version;
}

/** The marketplace service composed OVER the real authority. */
function makeMarket(): { market: MarketplaceService; payments: InMemoryPaymentAdapter } {
  const payments = new InMemoryPaymentAdapter();
  const store = new InMemoryMarketplaceStore();
  const versionReader: MarketplaceVersionReader = support.repository;
  const market = new DefaultMarketplaceService({
    store,
    versionReader,
    memberships: support.memberships,
    payments,
    idFactory: createSequentialIdFactory('ig005mkt'),
    clock: createSteppingClock(1789500000000, 1000),
  });
  return { market, payments };
}

// ============================================================================
// The integrated market world (fork → modify → publish → purchase → install)
// ============================================================================

interface MarketWorld {
  market: MarketplaceService;
  payments: InMemoryPaymentAdapter;
  author: { organizationId: string; ownerUserId: string; memberUserId: string };
  forker: { organizationId: string; ownerUserId: string; memberUserId: string };
  customer: { organizationId: string; ownerUserId: string; memberUserId: string };
  sourceWorkflowId: string;
  sourceV1: VersionPayload;
  fork: { id: string };
  forkV1: VersionPayload;
  forkV2: VersionPayload;
  listingId: string;
  entitlementId: string;
  transactionId: string;
  installationId: string;
}

/**
 * The full third-party protocol through the REAL stack: the original author
 * publishes v1; the forker forks, modifies (v2), lists and publishes; the
 * customer accepts the one-time offer and installs the EXACT purchased pin
 * cross-tenant through the REAL install route.
 */
async function buildMarketWorld(label: string): Promise<MarketWorld> {
  const { market, payments } = makeMarket();
  const author = await freshTenant(`${label}-author`, `ig005-${label}-author-member`);
  const forker = await freshTenant(`${label}-forker`, `ig005-${label}-forker-member`);
  const customer = await freshTenant(`${label}-customer`, `ig005-${label}-customer-member`);
  const operatorPrincipal = { userId: operatorUserId };

  // 0. the ORIGINAL author creates v1 (private) and makes it public
  const { workflowId: sourceWorkflowId, version: sourceV1 } = await createWorkflow(
    author,
    `digest-source-${label}`,
    'Scan the repository board and summarize the open ticket digest.',
  );
  await setVisibility(sourceWorkflowId, 'public');

  // 1. FORK through the REAL V2-002 fork route
  const forkRes = await injectJson('POST', `/organizations/${forker.organizationId}/workflow-repository/forks`, {
    sourceWorkflowId,
    sourceVersionId: sourceV1.id,
    slug: `digest-fork-${label}`,
    name: 'Digest fork',
  });
  expect(forkRes.status, forkRes.raw).toBe(201);
  const forkBody = forkRes.body as unknown as {
    workflow: { id: string; forkedFromWorkflowId: string | null; forkedFromVersionId: string | null };
    initialVersion: VersionPayload;
  };
  const fork = { id: forkBody.workflow.id };
  const forkV1 = forkBody.initialVersion;

  // 2. MODIFY: the forker's explicit new version; the derivative goes public
  const forkV2 = await createVersion(
    fork.id,
    forkV1.id,
    'Scan the repository board and summarize the ticket digest, release 2.',
  );
  await setVisibility(fork.id, 'public');

  // 3. PUBLISH: the forker lists + publishes the derivative
  const listed = await market.createListing(operatorPrincipal, {
    organizationId: forker.organizationId,
    workflowId: fork.id,
    versionId: forkV2.id,
    name: 'Digest Report (community fork)',
    description: 'The forked digest report',
    offers: [ONE_TIME_OFFER],
  });
  const published = await market.publishListing(operatorPrincipal, {
    listingId: listed.listing.id,
  });
  expect(published.listing.status).toBe('published');

  // 4. TRANSACTION: the customer accepts the one-time offer
  const oneTimeOfferId = published.revision.offers.find((offer) => offer.model === 'one_time_purchase')!.id;
  const accepted = await market.acceptOffer(operatorPrincipal, {
    listingId: listed.listing.id,
    offerId: oneTimeOfferId,
    customerOrganizationId: customer.organizationId,
  });
  expect(accepted.entitlement.status).toBe('active');
  expect(accepted.entitlement.pinnedVersionId).toBe(forkV2.id);

  // 5. INSTALL through the REAL V2-002 route (cross-tenant, pinned)
  const installRes = await injectJson('POST', `/organizations/${customer.organizationId}/workflow-repository/installations`, {
    workflowId: fork.id,
    versionId: forkV2.id,
  });
  expect(installRes.status, installRes.raw).toBe(201);
  const installation = (installRes.body as unknown as {
    installation: { id: string; versionId: string; status: string };
  }).installation;

  return {
    market,
    payments,
    author,
    forker,
    customer,
    sourceWorkflowId,
    sourceV1,
    fork,
    forkV1,
    forkV2,
    listingId: listed.listing.id,
    entitlementId: accepted.entitlement.id,
    transactionId: accepted.transaction!.id,
    installationId: installation.id,
  };
}

// ============================================================================
// The first-party world (the self-hosting development environment)
// ============================================================================

async function installLibrary(): Promise<FirstPartyInstallOutcome> {
  return installFirstPartyWorkflows({
    principal: { userId: devUserId },
    organizationId: devOrgId,
    port,
    protocol: { irSchemaVersion: 'wfos-ir-1' },
  });
}

async function pinFactsOf(installationId: string): Promise<FirstPartyPinFacts> {
  const detail = await support.repository.getInstallation({ userId: devUserId }, devOrgId, installationId);
  return {
    organizationId: devOrgId,
    installationId,
    workflowId: detail.pinnedVersion.workflowId,
    versionId: detail.pinnedVersion.id,
    versionNumber: detail.pinnedVersion.versionNumber,
    contentDigest: detail.pinnedVersion.contentDigest,
  };
}

/** A maintenance-revision document for the TESTING artifact (task prose mutated). */
function testingMaintenanceDocument(): WorkflowIrDocument {
  const artifact = artifactByKind('testing')!;
  const cloned = JSON.parse(JSON.stringify(artifact.document)) as WorkflowIrDocument;
  const node = cloned.ir.nodes.find((candidate) => candidate.id === 'run_battery')!;
  (node.spec as { task: string }).task =
    'Run the affected test batteries on the exact change revision (maintenance revision 2)';
  return cloned;
}

// ============================================================================
// PROOF 1 + 6 (third-party): pinning + explicit maintenance transitions
// ============================================================================

describe('IG-005 — published workflow installation remains version-pinned; maintenance updates are explicit version transitions', () => {
  it('a forked, published, purchased and installed workflow holds its exact pin across a creator maintenance update (new version + new revision, never a pin move)', async () => {
    const world = await buildMarketWorld('pin');
    const operatorPrincipal = { userId: operatorUserId };

    // The installation pins the EXACT purchased version (v2), with the
    // authority's own pin facts.
    const installDetail = await support.repository.getInstallation(
      operatorPrincipal,
      world.customer.organizationId,
      world.installationId,
    );
    expect(installDetail.installation.versionId).toBe(world.forkV2.id);
    expect(installDetail.installation.status).toBe('enabled');
    expect(installDetail.pinnedVersion.id).toBe(world.forkV2.id);
    expect(installDetail.pinnedVersion.versionNumber).toBe(2);
    expect(installDetail.pinnedVersion.contentDigest).toBe(world.forkV2.contentDigest);

    // --- the creator's maintenance update: an explicit NEW version + revision --
    const forkV3 = await createVersion(
      world.fork.id,
      world.forkV2.id,
      'Scan the repository board and summarize the ticket digest, maintenance release 3.',
    );
    expect(forkV3.versionNumber).toBe(3);
    expect(forkV3.contentDigest).not.toBe(world.forkV2.contentDigest);
    const update = await world.market.publishNewVersion(operatorPrincipal, {
      listingId: world.listingId,
      versionId: forkV3.id,
    });
    expect(update.created).toBe(true);
    expect(update.revision.sequence).toBe(2);
    expect(update.revision.pin.versionId).toBe(forkV3.id);
    expect(update.revision.pin.versionNumber).toBe(3);

    // PROOF 1: the customer's installation STILL pins v2 — the maintenance
    // update NEVER moved the installed pin.
    const afterUpdate = await support.repository.getInstallation(
      operatorPrincipal,
      world.customer.organizationId,
      world.installationId,
    );
    expect(afterUpdate.installation.versionId).toBe(world.forkV2.id);
    expect(afterUpdate.pinnedVersion.id).toBe(world.forkV2.id);
    expect(afterUpdate.pinnedVersion.versionNumber).toBe(2);
    expect(afterUpdate.pinnedVersion.contentDigest).toBe(world.forkV2.contentDigest);

    // PROOF 6: the transition was EXPLICIT — a NEW immutable version in the
    // workflow's version history [1, 2, 3]; revision 1 is byte-identical
    // (never an in-place mutation of pin or trust).
    const versionsRes = await injectJson('GET', `/workflow-repository/workflows/${world.fork.id}/versions`);
    expect(versionsRes.status, versionsRes.raw).toBe(200);
    const versions = (versionsRes.body as unknown as { versions: VersionPayload[] }).versions;
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2, 3]);
    const history = await world.market.listListingRevisions(operatorPrincipal, world.listingId);
    expect(history.map((revision) => revision.pin.versionId)).toEqual([world.forkV2.id, forkV3.id]);
    expect(history[0]!.pin.contentDigest).toBe(world.forkV2.contentDigest);
    expect(history[0]!.pin.versionNumber).toBe(2);
    // the REAL v2 record is untouched (the authority's immutability)
    const forkV2Reread = await readVersion(world.fork.id, world.forkV2.id);
    expect(forkV2Reread.contentDigest).toBe(world.forkV2.contentDigest);
    expect(forkV2Reread.content).toEqual(world.forkV2.content);

    // the purchased pin stays ENTITLED; the update (v3) is NOT included
    // (pinned_only one-time purchase — the customer's explicit transition
    // decision, never a silent move).
    const updateAccess = await world.market.checkVersionAccess(operatorPrincipal, {
      listingId: world.listingId,
      versionId: forkV3.id,
      organizationId: world.customer.organizationId,
    });
    expect(updateAccess).toEqual({ entitled: false, reason: 'update_not_included' });
    const stillPurchased = await world.market.checkVersionAccess(operatorPrincipal, {
      listingId: world.listingId,
      versionId: world.forkV2.id,
      organizationId: world.customer.organizationId,
    });
    expect(stillPurchased).toEqual({
      entitled: true,
      basis: 'one_time_purchase',
      entitlementId: world.entitlementId,
    });
  });
});

// ============================================================================
// PROOF 2: entitlement does not bypass execution authorization
// ============================================================================

describe('IG-005 — entitlement does not bypass execution authorization', () => {
  it('the full commerce flow creates ZERO runs; an active entitlement is NOT an execution credential; execution requires the run authority’s own chain (membership + pin match)', async () => {
    const world = await buildMarketWorld('entitlement');
    const operatorPrincipal = { userId: operatorUserId };

    // (a) STRUCTURAL SEPARATION: the commerce flow — listing, publication,
    // purchase, entitlement, installation — created ZERO runs in every
    // involved organization (entitlement grants CONTENT access only).
    for (const tenant of [world.author, world.forker, world.customer]) {
      const runs = await support.runs.listRunsInOrganization(
        { userId: tenant.ownerUserId },
        tenant.organizationId,
      );
      expect(runs).toEqual([]);
    }

    // (b) the entitlement DECISION is a content-access decision: its shape
    // carries no run, capability-grant or execution concept.
    const decision = await world.market.checkVersionAccess(operatorPrincipal, {
      listingId: world.listingId,
      versionId: world.forkV2.id,
      organizationId: world.customer.organizationId,
    });
    expect(Object.keys(decision).sort()).toEqual(['basis', 'entitled', 'entitlementId']);

    // (c) the entitlement ID is NOT an installation credential: presenting
    // the marketplace durable identity to the run authority's installation
    // pin check is a TYPED denial — the marketplace surface cannot act as
    // an execution credential.
    await expect(
      support.runs.requestRun(operatorPrincipal, {
        commandId: 'cmd-ig005-ent-credential-0001',
        correlationId: 'ig005-entitlement-flow',
        causationId: 'ig005-entitlement-root',
      }, {
        organizationId: world.customer.organizationId,
        workflowId: world.fork.id,
        versionId: world.forkV2.id,
        installationId: world.entitlementId,
        trigger: { type: 'manual', id: 'ig005-entitlement-credential-attempt' },
        inputCommitments: [commitmentOf('ig005-entitlement-input')],
      }),
    ).rejects.toMatchObject({ code: 'RUN_INSTALLATION_MISMATCH' });

    // (d) an installation pinning a DIFFERENT version than requested is a
    // TYPED mismatch (the customer's installation pins v2; v3 is requested).
    const forkV3 = await createVersion(
      world.fork.id,
      world.forkV2.id,
      'Scan the repository board and summarize the ticket digest, entitlement release 3.',
    );
    await expect(
      support.runs.requestRun(operatorPrincipal, {
        commandId: 'cmd-ig005-ent-skew-0001',
        correlationId: 'ig005-entitlement-flow',
        causationId: 'ig005-entitlement-root',
      }, {
        organizationId: world.customer.organizationId,
        workflowId: world.fork.id,
        versionId: forkV3.id,
        installationId: world.installationId,
        trigger: { type: 'manual', id: 'ig005-entitlement-skew-attempt' },
        inputCommitments: [commitmentOf('ig005-entitlement-input')],
      }),
    ).rejects.toMatchObject({ code: 'RUN_INSTALLATION_MISMATCH' });

    // (e) a principal who is NOT a member of the target organization is a
    // TYPED membership denial — even one whose organization holds an ACTIVE
    // entitlement elsewhere (user B is org B's owner; org B never purchased).
    await expect(
      support.runs.requestRun({ userId: support.userBId }, {
        commandId: 'cmd-ig005-ent-member-0001',
        correlationId: 'ig005-entitlement-flow',
        causationId: 'ig005-entitlement-root',
      }, {
        organizationId: world.customer.organizationId,
        workflowId: world.fork.id,
        versionId: world.forkV2.id,
        installationId: world.installationId,
        trigger: { type: 'manual', id: 'ig005-entitlement-member-attempt' },
        inputCommitments: [commitmentOf('ig005-entitlement-input')],
      }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_ORGANIZATION_MEMBER' });

    // (f) THE AUTHORIZED POSITIVE PATH: a member of the customer
    // organization, with the real installation pinning the exact version —
    // the run authority's OWN chain admits the run, pinned to the exact
    // purchased/installed version identity. (The entitlement played no
    // role in this authorization: the installation pin + membership did.)
    const requested = await support.runs.requestRun(operatorPrincipal, {
      commandId: 'cmd-ig005-ent-positive-0001',
      correlationId: 'ig005-entitlement-flow',
      causationId: 'ig005-entitlement-root',
    }, {
      organizationId: world.customer.organizationId,
      workflowId: world.fork.id,
      versionId: world.forkV2.id,
      installationId: world.installationId,
      trigger: { type: 'manual', id: 'ig005-entitlement-authorized-run' },
      inputCommitments: [commitmentOf('ig005-entitlement-authorized-input')],
    });
    expect(requested.result.created).toBe(true);
    const run = await support.runs.getRun(operatorPrincipal, requested.result.run.id);
    expect(run.workflowId).toBe(world.fork.id);
    expect(run.versionId).toBe(world.forkV2.id);
    expect(run.installationId).toBe(world.installationId);
    expect(run.versionContentDigest).toBe(world.forkV2.contentDigest);
    // the run carries the SAME semantic digest as the marketplace trust
    // view (V2-003's digest of the exact pinned version)
    const parsed = parseWorkflowIrDocument(JSON.stringify(world.forkV2.content));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(run.versionSemanticDigest).toBe(computeWorkflowVersionSemanticDigest(parsed.document).digest);

    // the authorized run completes through the real lifecycle (and the
    // commerce-only assertion above stays true for the pre-run window).
    await support.runs.startRun(operatorPrincipal, {
      commandId: 'cmd-ig005-ent-positive-0002',
      correlationId: 'ig005-entitlement-flow',
      causationId: requested.result.run.id,
    }, { runId: requested.result.run.id });
    const completed = await support.runs.completeRun(operatorPrincipal, {
      commandId: 'cmd-ig005-ent-positive-0003',
      correlationId: 'ig005-entitlement-flow',
      causationId: requested.result.run.id,
    }, {
      runId: requested.result.run.id,
      outputCommitments: [commitmentOf('ig005-entitlement-authorized-output')],
    });
    expect(completed.result.run.state).toBe('completed');
  });
});

// ============================================================================
// PROOF 3: fork provenance survives publication
// ============================================================================

describe('IG-005 — fork provenance survives publication', () => {
  it('the fork facts ride every listing revision verbatim (draft → publish → purchase → maintenance update), matching the authority’s own records', async () => {
    const world = await buildMarketWorld('provenance');
    const operatorPrincipal = { userId: operatorUserId };

    // the authority's own fork record (the V2-002 facts)
    const forkWorkflow = await support.repository.getWorkflow(operatorPrincipal, world.fork.id);
    expect(forkWorkflow.forkedFromWorkflowId).toBe(world.sourceWorkflowId);
    expect(forkWorkflow.forkedFromVersionId).toBe(world.sourceV1.id);

    // revision 1 (the publication) carried the provenance verbatim
    const history = await world.market.listListingRevisions(operatorPrincipal, world.listingId);
    expect(history).toHaveLength(1);
    expect(history[0]!.trust.provenance.forkedFromWorkflowId).toBe(world.sourceWorkflowId);
    expect(history[0]!.trust.provenance.forkedFromVersionId).toBe(world.sourceV1.id);
    const provenanceParsed = parseWorkflowIrDocument(JSON.stringify(world.forkV2.content));
    expect(provenanceParsed.ok).toBe(true);
    if (!provenanceParsed.ok) throw new Error('unreachable');
    expect(history[0]!.trust.semanticDigest).toBe(
      computeWorkflowVersionSemanticDigest(provenanceParsed.document).digest,
    );

    // a maintenance update: revision 2 STILL carries the same provenance
    const forkV3 = await createVersion(
      world.fork.id,
      world.forkV2.id,
      'Scan the repository board and summarize the ticket digest, provenance release 3.',
    );
    await world.market.publishNewVersion(operatorPrincipal, {
      listingId: world.listingId,
      versionId: forkV3.id,
    });
    const historyAfter = await world.market.listListingRevisions(operatorPrincipal, world.listingId);
    expect(historyAfter).toHaveLength(2);
    for (const revision of historyAfter) {
      expect(revision.trust.provenance.forkedFromWorkflowId).toBe(world.sourceWorkflowId);
      expect(revision.trust.provenance.forkedFromVersionId).toBe(world.sourceV1.id);
    }

    // the published listing view surfaces the same provenance (the browsing
    // customer sees the fork origin — disclosure, never a grant)
    const browsed = await world.market.listPublishedListings(operatorPrincipal);
    const entry = browsed.find((candidate) => candidate.listing.id === world.listingId)!;
    expect(entry.revision.trust.provenance.forkedFromWorkflowId).toBe(world.sourceWorkflowId);
    expect(entry.revision.trust.provenance.forkedFromVersionId).toBe(world.sourceV1.id);

    // the fork's derivation is ALSO visible in the authority's version
    // history: the fork's v1 carries the source content byte-identically.
    const forkV1Reread = await readVersion(world.fork.id, world.forkV1.id);
    expect(forkV1Reread.contentDigest).toBe(world.sourceV1.contentDigest);
  });
});

// ============================================================================
// PROOF 4: first-party workflows use the same protocol as third-party
// ============================================================================

describe('IG-005 — first-party WorkflowOS workflows use the same protocol as third-party workflows', () => {
  it('the SAME install route, the SAME pin facts and the SAME run command surface serve both; a first-party maintenance version never moves the installed pin', async () => {
    const operatorPrincipal = { userId: operatorUserId };
    // The operator joins the development environment (org A) to drive the
    // REAL routes there (the gate composition pattern).
    await support.stack.membershipRepository.assign({
      userId: operatorUserId,
      organizationId: devOrgId,
      roleId: 'owner',
    });

    // --- the third-party side of the witness (through the same route) ------
    const world = await buildMarketWorld('protocol');
    const thirdPartyInstallDetail = await support.repository.getInstallation(
      operatorPrincipal,
      world.customer.organizationId,
      world.installationId,
    );

    // --- the first-party side: the six artifacts through the REAL authority -
    const library = await installLibrary();
    expect(library.manifests.map((manifest) => manifest.kind)).toEqual([
      'implementation', 'review', 'testing', 'release', 'maintenance', 'dogfooding',
    ]);
    const testing = library.manifests.find((manifest) => manifest.kind === 'testing')!;

    // PROOF 4 (a): the SAME HTTP install route serves the first-party
    // workflow (identical payload shape; the route CONVERGES on the
    // port-installed installation identity — `created: false` — because the
    // route and the self-hosting port are ONE authority).
    const routeInstall = await injectJson('POST', `/organizations/${devOrgId}/workflow-repository/installations`, {
      workflowId: testing.workflowId,
      versionId: testing.versionId,
    });
    expect([200, 201], routeInstall.raw).toContain(routeInstall.status);
    expect(routeInstall.body.created).toBe(false);
    const routeInstallation = (routeInstall.body as unknown as {
      installation: { id: string; versionId: string; status: string };
    }).installation;
    expect(routeInstallation.id).toBe(testing.installationId);
    expect(routeInstallation.versionId).toBe(testing.versionId);
    expect(routeInstallation.status).toBe('enabled');

    // PROOF 4 (b): the SAME pin-facts shape and semantics on both sides —
    // the first-party read-back equals the third-party read-back structurally.
    const firstPartyDetail = await support.repository.getInstallation(
      operatorPrincipal,
      devOrgId,
      testing.installationId,
    );
    expect(firstPartyDetail.pinnedVersion.id).toBe(testing.versionId);
    expect(firstPartyDetail.pinnedVersion.versionNumber).toBe(testing.versionNumber);
    expect(firstPartyDetail.pinnedVersion.contentDigest).toBe(testing.contentDigest);
    expect(firstPartyDetail.pinnedVersion.id).toBe(firstPartyDetail.installation.versionId);
    expect(thirdPartyInstallDetail.pinnedVersion.id).toBe(thirdPartyInstallDetail.installation.versionId);

    // PROOF 4 (c): the SAME run command surface — a first-party run pins the
    // manifest exact, with the same envelope/pin requirements as the
    // third-party run.
    const requested = await support.runs.requestRun({ userId: devUserId }, {
      commandId: 'cmd-ig005-protocol-first-0001',
      correlationId: 'ig005-protocol-flow',
      causationId: 'ig005-protocol-root',
    }, {
      organizationId: devOrgId,
      workflowId: testing.workflowId,
      versionId: testing.versionId,
      installationId: testing.installationId,
      trigger: { type: 'manual', id: 'ig005-protocol-first-run' },
      inputCommitments: [commitmentOf('ig005-protocol-first-input')],
    });
    expect(requested.result.created).toBe(true);
    const run = await support.runs.getRun({ userId: devUserId }, requested.result.run.id);
    expect(run.workflowId).toBe(testing.workflowId);
    expect(run.versionId).toBe(testing.versionId);
    expect(run.installationId).toBe(testing.installationId);
    expect(run.versionContentDigest).toBe(testing.contentDigest);
    expect(run.versionSemanticDigest).toBe(testing.semanticDigest.digest);

    // PROOF 4 (d) + PROOF 1 (first-party): a first-party maintenance update
    // (publishFirstPartyVersion — the EXPLICIT governed transition) creates a
    // NEW immutable version; the installed pin NEVER moves.
    const v2 = await publishFirstPartyVersion(
      port,
      { userId: devUserId },
      testing.workflowId,
      testingMaintenanceDocument(),
      { irSchemaVersion: 'wfos-ir-1' },
    );
    expect(v2.versionNumber).toBe(2);
    expect(v2.contentDigest).not.toBe(testing.contentDigest);
    expect(v2.created).toBe(true);
    const pinAfterUpdate = await support.repository.getInstallation(
      operatorPrincipal,
      devOrgId,
      testing.installationId,
    );
    expect(pinAfterUpdate.pinnedVersion.id).toBe(testing.versionId);
    expect(pinAfterUpdate.pinnedVersion.versionNumber).toBe(1);
    expect(pinAfterUpdate.pinnedVersion.contentDigest).toBe(testing.contentDigest);
    // the version history records the explicit transition [1, 2]
    const versionsRes = await injectJson('GET', `/workflow-repository/workflows/${testing.workflowId}/versions`);
    const versions = (versionsRes.body as unknown as { versions: VersionPayload[] }).versions;
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);
  });
});

// ============================================================================
// PROOF 5 + 6 (first-party): governance boundary + governed transitions
// ============================================================================

describe('IG-005 — self-hosting cannot bypass development governance; maintenance transitions are governed', () => {
  it('the REAL boundary model admits the six artifacts; a WEAKENED model and forged capabilities are fail-closed typed denials', () => {
    // the REAL model (loaded from the canonical governance model) admits
    // all six first-party artifacts
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      const verdict = evaluateSelfHostingBoundary(artifact.document, realBoundary);
      expect(verdict.allowed, JSON.stringify(verdict)).toBe(true);
    }

    // a WEAKENED model is fail-closed: dropping the architect merge-gate
    // prohibition invalidates the model itself (typed, code-pinned floor).
    const weakened = {
      may: realBoundary.may,
      mayNot: realBoundary.mayNot.filter((entry) => !entry.includes('merge its own governing PR')),
      coreProhibitions: realBoundary.coreProhibitions.filter(
        (entry) => !entry.includes('merge its own governing PR'),
      ),
    };
    const weakenedVerdict = evaluateSelfHostingBoundary(
      artifactByKind('implementation')!.document,
      weakened,
    );
    expect(weakenedVerdict.allowed).toBe(false);
    if (!weakenedVerdict.allowed) {
      expect(weakenedVerdict.failure.code).toBe('SELF_HOSTING_BOUNDARY_MODEL_INVALID');
    }
    expect(validateBoundaryModel(weakened)?.code).toBe('SELF_HOSTING_BOUNDARY_MODEL_INVALID');
    expect(validateBoundaryModel(undefined)?.code).toBe('SELF_HOSTING_BOUNDARY_MODEL_INVALID');

    // a forged first-party document claiming the ARCHITECT MERGE GATE
    // capability is a typed denial — self-hosting never merges its own
    // governing PR (the architect's review is the only merge gate).
    const forgedMergeDocument = createWorkflowIrBuilder()
      .withStart('merge_the_pr')
      .addNode({
        id: 'merge_the_pr',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'github.pull_request.merge' },
        capabilityRequirements: ['github.pull_request.merge'],
        placement: 'device_local',
        inputs: [],
        outputs: [{ name: 'done', type: { kind: 'boolean' } }],
        failurePolicy: { strategy: 'fail_workflow' },
        completionEvidence: 'observation',
      })
      .build();
    const mergeVerdict = evaluateSelfHostingBoundary(forgedMergeDocument, realBoundary);
    expect(mergeVerdict.allowed).toBe(false);
    if (!mergeVerdict.allowed) {
      expect(mergeVerdict.failure.code).toBe('SELF_HOSTING_MERGE_GATE_VIOLATION');
      expect(mergeVerdict.failure.stepId).toBe('merge_the_pr');
    }

    // a capability OUTSIDE the first-party allowlist (messaging.send — a
    // canonical registry name, but not a first-party development surface)
    // is a typed denial.
    const forgedCapabilityDocument = createWorkflowIrBuilder()
      .withStart('send_a_message')
      .addNode({
        id: 'send_a_message',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'messaging.send' },
        capabilityRequirements: ['messaging.send'],
        placement: 'device_local',
        inputs: [],
        outputs: [{ name: 'done', type: { kind: 'boolean' } }],
        failurePolicy: { strategy: 'fail_workflow' },
        completionEvidence: 'observation',
      })
      .build();
    const capabilityVerdict = evaluateSelfHostingBoundary(forgedCapabilityDocument, realBoundary);
    expect(capabilityVerdict.allowed).toBe(false);
    if (!capabilityVerdict.allowed) {
      expect(capabilityVerdict.failure.code).toBe('SELF_HOSTING_CAPABILITY_NOT_ALLOWED');
    }
  });

  it('the governed maintenance transition: a published-but-NOT-installed first-party version is a TYPED blocked advance (publication alone never authorizes a pin transition)', async () => {
    const library = await installLibrary();
    const testing = library.manifests.find((manifest) => manifest.kind === 'testing')!;
    const runs = support.runs;
    const principal = { userId: devUserId };

    // a REAL failed run pinned to the manifest (the recovery trigger)
    const requested = await runs.requestRun(principal, {
      commandId: 'cmd-ig005-recovery-0001',
      correlationId: 'ig005-recovery-flow',
      causationId: 'ig005-recovery-root',
    }, {
      organizationId: devOrgId,
      workflowId: testing.workflowId,
      versionId: testing.versionId,
      installationId: testing.installationId,
      trigger: { type: 'manual', id: 'ig005-recovery-trigger' },
      inputCommitments: [commitmentOf('ig005-recovery-input')],
    });
    const runId = requested.result.run.id;
    await runs.startRun(principal, {
      commandId: 'cmd-ig005-recovery-0002',
      correlationId: 'ig005-recovery-flow',
      causationId: runId,
    }, { runId });
    await runs.failRun(principal, {
      commandId: 'cmd-ig005-recovery-0003',
      correlationId: 'ig005-recovery-flow',
      causationId: runId,
    }, { runId, reason: 'the dev worker lost the sandbox' });

    // the maintenance update EXISTS in the authority (published v2) …
    const v2 = await publishFirstPartyVersion(
      port,
      principal,
      testing.workflowId,
      testingMaintenanceDocument(),
      { irSchemaVersion: 'wfos-ir-1' },
    );
    expect(v2.versionNumber).toBe(2);
    // … but it is NOT installed: the development environment's installation
    // still pins v1 (the only pin that exists).
    const pinFacts = await pinFactsOf(testing.installationId);
    expect(pinFacts.versionId).toBe(testing.versionId);

    // PROOF: the advance to the published-but-uninstalled v2 is BLOCKED,
    // typed — publication alone is not transition-readiness. The plan is
    // data: its executor must still publish and install through the real
    // authorities (the governed transition discipline).
    const plan = planFailedWorkflowRecovery({
      manifest: testing,
      failedRun: {
        runId,
        workflowId: testing.workflowId,
        versionId: testing.versionId,
        state: 'failed',
      },
      pinFacts,
      boundary: realBoundary,
      artifact: artifactByKind('testing')!,
      request: {
        action: 'advance_version',
        toVersionId: v2.versionId,
        // deliberately NO installation read-back: well-formed version facts
        // alone (published but not installed) — the residual hole's shape.
        targetVersion: {
          version: {
            id: v2.versionId,
            workflowId: testing.workflowId,
            versionNumber: v2.versionNumber,
            contentDigest: v2.contentDigest,
          },
        } as unknown as FirstPartyTargetVersionFacts,
      },
    });
    expect(plan.kind).toBe('blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED');
      expect(plan.failure.detail).toContain('published-but-NOT-installed');
    }

    // the negative control: installing the target through the REAL route and
    // reading it back unblocks the SAME advance (the governed transition
    // completes only through the authority's own installation path).
    const installRes = await injectJson('POST', `/organizations/${devOrgId}/workflow-repository/installations`, {
      workflowId: testing.workflowId,
      versionId: v2.versionId,
    });
    expect(installRes.status, installRes.raw).toBe(201);
    const targetInstallation = (installRes.body as unknown as {
      installation: { id: string; versionId: string };
    }).installation;
    const targetDetail = await support.repository.getInstallation(principal, devOrgId, targetInstallation.id);
    const unblockedPlan = planFailedWorkflowRecovery({
      manifest: testing,
      failedRun: {
        runId,
        workflowId: testing.workflowId,
        versionId: testing.versionId,
        state: 'failed',
      },
      pinFacts,
      boundary: realBoundary,
      artifact: artifactByKind('testing')!,
      request: {
        action: 'advance_version',
        toVersionId: v2.versionId,
        targetVersion: {
          version: {
            id: v2.versionId,
            workflowId: testing.workflowId,
            versionNumber: v2.versionNumber,
            contentDigest: v2.contentDigest,
          },
          installation: {
            organizationId: devOrgId,
            installationId: targetInstallation.id,
            workflowId: targetDetail.pinnedVersion.workflowId,
            versionId: targetDetail.pinnedVersion.id,
            versionNumber: targetDetail.pinnedVersion.versionNumber,
            contentDigest: targetDetail.pinnedVersion.contentDigest,
          },
        },
      },
    });
    expect(unblockedPlan.kind).toBe('advance_version');
  });
});

// ============================================================================
// The secret-isolation witness (structural, rides the fixture)
// ============================================================================

describe('IG-005 — the marketplace surface never carries secret material', () => {
  it('no listing/entitlement/transaction record contains the fixture’s real secret_ref binding', async () => {
    const world = await buildMarketWorld('secrets');
    const operatorPrincipal = { userId: operatorUserId };
    const history = await world.market.listListingRevisions(operatorPrincipal, world.listingId);
    const entitlement = await world.market.getEntitlement(operatorPrincipal, world.entitlementId);
    const transaction = await world.market.getTransaction(operatorPrincipal, world.transactionId);
    const allRecords = JSON.stringify({ history, entitlement, transaction });
    expect(allRecords).not.toMatch(/secret_ref|secretRef|digest-bot@secrets|credentials/i);
  });
});
