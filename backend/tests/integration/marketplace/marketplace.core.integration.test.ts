/**
 * V2-012 — Collaboration + Marketplace + Economics: the integration battery
 * on the REAL stack.
 *
 * The marketplace domain (src/marketplace — the V2-006/V2-010/V2-011 family
 * precedent: pure application-layer module, NO routes, NO migration, NO
 * PostgreSQL store) is composed OVER the merged V2-002 workflow-repository
 * authority:
 *
 *   - the MarketplaceVersionReader port is satisfied STRUCTURALLY by the
 *     REAL DefaultWorkflowRepositoryService (the exact service behind the
 *     real routes — the module never imports it and can never create, fork,
 *     mutate or install a version);
 *   - the MarketplaceMembershipResolver port is satisfied by the same
 *     identity-membership resolver the repository service consumes;
 *   - the payment adapter is the module's own deterministic in-memory TEST
 *     adapter (NO real provider calls — the frozen V2-012 rule);
 *   - every workflow/version/installation fact flows through the REAL
 *     V2-002 routes over app.inject (create → publish-visibility → FORK →
 *     modify → maintenance version → cross-tenant INSTALL).
 *
 * Required regressions proven HERE on the real stack (their unit coverage
 * lives in tests/unit/marketplace/):
 *   - private visibility isolation THROUGH the real authority;
 *   - fork provenance (the fork records the upstream workflow/version —
 *     surfaced verbatim in the listing trust view);
 *   - concurrent version publication convergence;
 *   - entitlement enforcement (entitled vs not, over the REAL versions);
 *   - paid-version pinning (the customer's real installation stays pinned;
 *     a maintenance update never moves it);
 *   - creator maintenance updates (an explicit NEW revision pinning a NEW
 *     real version — never an in-place mutation);
 *   - execution-authority separation (the full commerce flow creates ZERO
 *     runs — entitlement grants content access only);
 *   - secret isolation (the fixture's real secret_ref binding never leaks
 *     into any marketplace record).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import {
  buildTriggerTestStack,
  createTenant,
  versionContentOf,
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
import { WorkflowRepositoryError } from '../../../src/workflow-repository/index.js';
import type { FastifyInstance } from 'fastify';

const API_KEY = 'v2-012-api-test-key';
const OPERATOR_EXTERNAL_ID = 'v2-012-api-operator';

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
/** The marketplace service composed OVER the real authority (fresh per test). */
let market: MarketplaceService;
let payments: InMemoryPaymentAdapter;
let store: InMemoryMarketplaceStore;

function makeMarket(): { market: MarketplaceService; payments: InMemoryPaymentAdapter; store: InMemoryMarketplaceStore } {
  payments = new InMemoryPaymentAdapter();
  store = new InMemoryMarketplaceStore();
  const versionReader: MarketplaceVersionReader = support.repository;
  market = new DefaultMarketplaceService({
    store,
    versionReader,
    memberships: support.memberships,
    payments,
    idFactory: createSequentialIdFactory('v2012mkt'),
    clock: createSteppingClock(1789500000000, 1000),
  });
  return { market, payments, store };
}

beforeAll(async () => {
  support = await buildTriggerTestStack({
    WFOS_V2_012_API_TEST_KEY: API_KEY,
  });
  const operator = await support.stack.userRepository.upsertByExternalId({
    externalId: OPERATOR_EXTERNAL_ID,
    displayName: 'V2-012 API Operator',
  });
  operatorUserId = operator.id;
  const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
  await provisioner.provision({
    keyId: 'v2-012-api-test-key-id',
    secretRef: 'WFOS_V2_012_API_TEST_KEY',
    externalId: OPERATOR_EXTERNAL_ID,
    label: 'V2-012 API Operator',
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
});

afterAll(async () => {
  await app.close();
  await support.teardown();
});

// ============================================================================
// The real HTTP helper (the product path — every repository call is inject)
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

/** A fresh tenant with an extra member (per-test isolation). */
async function freshTenant(label: string, memberExternalId: string) {
  const tenant = await createTenant(support, `v2012-${label}`);
  const member = await support.stack.userRepository.upsertByExternalId({
    externalId: memberExternalId,
    displayName: `V2-012 ${label}`,
  });
  await support.stack.membershipRepository.assign({
    userId: member.id,
    organizationId: tenant.organizationId,
    roleId: 'member',
  });
  // The API-key operator joins every tenant as an owner (the IG-004 gate
  // composition pattern: the operator is the human driving the REAL routes,
  // which authenticate through the API key).
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
// The fixture documents (real V2-003 builder; the send_digest node carries a
// REAL secret_ref binding — the secret-isolation regression depends on it)
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
const FREE_OFFER = { model: 'free' as const, terms: { model: 'free' as const } };

/** Create a workflow (born private) through the REAL V2-002 routes. */
async function createWorkflow(
  t: { organizationId: string; ownerUserId: string },
  slug: string,
  scanTask: string,
): Promise<{ workflowId: string; version: VersionPayload }> {
  const res = await injectJson('POST', `/organizations/${t.organizationId}/workflow-repository/workflows`, {
    slug,
    name: 'Repository Ticket Digest',
    description: 'The V2-012 integration fixture',
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

/** Read one exact version through the REAL route (byte-identity checks). */
async function readVersion(workflowId: string, versionId: string): Promise<VersionPayload> {
  const res = await injectJson('GET', `/workflow-repository/workflows/${workflowId}/versions/${versionId}`);
  expect(res.status, res.raw).toBe(200);
  return (res.body as unknown as { version: VersionPayload }).version;
}

describe('V2-012 — the marketplace over the REAL V2-002 authority (fork → modify → publish → install → transaction)', () => {
  it('the full market path: a safe test workflow forked, modified, published, installed and purchased, with creator economics and version history', async () => {
    const { market } = makeMarket();
    // Three tenants: the ORIGINAL author, the FORKER (the derivative's
    // creator/publisher), and the CUSTOMER. The operator (the API-key
    // principal — a member of every tenant) drives the REAL routes AND the
    // publisher/customer sides of the marketplace service calls.
    const author = await freshTenant('author', 'v2-012-author-member');
    const forker = await freshTenant('forker', 'v2-012-forker-member');
    const customer = await freshTenant('customer', 'v2-012-customer-member');
    const operatorPrincipal = { userId: operatorUserId };

    // --- 0. the ORIGINAL author creates v1 (private) -----------------------
    const { workflowId: sourceWorkflowId, version: sourceV1 } = await createWorkflow(author, 'digest-source', 'Scan the repository board and summarize the open ticket digest.');
    expect(sourceV1.versionNumber).toBe(1);
    await setVisibility(sourceWorkflowId, 'public');

    // --- 1. FORK through the REAL V2-002 fork route -------------------------
    const forkRes = await injectJson('POST', `/organizations/${forker.organizationId}/workflow-repository/forks`, {
      sourceWorkflowId,
      sourceVersionId: sourceV1.id,
      slug: 'digest-fork',
      name: 'Digest fork',
    });
    expect(forkRes.status, forkRes.raw).toBe(201);
    const forkBody = forkRes.body as unknown as {
      workflow: {
        id: string;
        forkedFromWorkflowId: string | null;
        forkedFromVersionId: string | null;
        organizationId: string;
      };
      initialVersion: VersionPayload & { created: boolean };
    };
    const fork = forkBody.workflow;
    expect(fork.forkedFromWorkflowId).toBe(sourceWorkflowId);
    expect(fork.forkedFromVersionId).toBe(sourceV1.id);
    expect(fork.organizationId).toBe(forker.organizationId);

    // --- 2. MODIFY: the forker's explicit new version on the fork -----------
    // (the fork's own immutable v1 — a NEW version identity carrying the
    // source content; NOT the source version id, which lives in the source
    // workflow's namespace).
    const forkV1 = forkBody.initialVersion;
    expect(forkV1.id).not.toBe(sourceV1.id);
    expect(forkV1.contentDigest).toBe(sourceV1.contentDigest);
    const forkV2 = await createVersion(fork.id, forkV1.id, 'Scan the repository board and summarize the ticket digest, maintenance release 2.');
    expect(forkV2.versionNumber).toBe(2);
    expect(forkV2.contentDigest).not.toBe(forkV1.contentDigest);
    // The derivative goes PUBLIC (repository collaboration → distribution).
    await setVisibility(fork.id, 'public');

    // --- 3. PUBLISH: the forker lists + publishes the derivative ------------
    const listed = await market.createListing(operatorPrincipal, {
      organizationId: forker.organizationId,
      workflowId: fork.id,
      versionId: forkV2.id,
      name: 'Digest Report (community fork)',
      description: 'The forked digest report',
      offers: [ONE_TIME_OFFER],
    });
    expect(listed.created).toBe(true);
    expect(listed.listing.status).toBe('draft');
    expect(listed.revision.sequence).toBe(1);
    // The revision pins the EXACT real version identity (the REAL content
    // digest of the fork's v2) and the REAL V2-003 semantic digest.
    expect(listed.revision.pin.versionId).toBe(forkV2.id);
    expect(listed.revision.pin.versionNumber).toBe(2);
    expect(listed.revision.pin.contentDigest).toBe(forkV2.contentDigest);
    const parsedForkV2 = parseWorkflowIrDocument(JSON.stringify(forkV2.content));
    expect(parsedForkV2.ok).toBe(true);
    if (!parsedForkV2.ok) throw new Error('unreachable');
    expect(listed.revision.trust.semanticDigest).toBe(
      computeWorkflowVersionSemanticDigest(parsedForkV2.document).digest,
    );
    // FORK PROVENANCE surfaced verbatim from the V2-002 facts.
    expect(listed.revision.trust.provenance.forkedFromWorkflowId).toBe(sourceWorkflowId);
    expect(listed.revision.trust.provenance.forkedFromVersionId).toBe(sourceV1.id);
    // The trust view is the real derived disclosure (capabilities +
    // sensitivity + placements), never a grant.
    expect(listed.revision.trust.requiredCapabilities).toEqual(['github.repository.read', 'messaging.send']);
    expect(listed.revision.trust.sensitiveCapabilities).toEqual(['messaging.send']);
    expect(listed.revision.trust.placements).toEqual(['cloud_allowed', 'cloud_preferred']);

    const published = await market.publishListing(operatorPrincipal, {
      listingId: listed.listing.id,
    });
    expect(published.listing.status).toBe('published');

    // --- 4. TRANSACTION: the customer browses + accepts the one-time offer --
    const browsed = await market.listPublishedListings(operatorPrincipal);
    expect(browsed.map((entry) => entry.listing.id)).toContain(listed.listing.id);
    const oneTimeOfferId = published.revision.offers.find((offer) => offer.model === 'one_time_purchase')!.id;
    const accepted = await market.acceptOffer(operatorPrincipal, {
      listingId: listed.listing.id,
      offerId: oneTimeOfferId,
      customerOrganizationId: customer.organizationId,
    });
    expect(accepted.created).toBe(true);
    expect(accepted.entitlement.status).toBe('active');
    expect(accepted.entitlement.model).toBe('one_time_purchase');
    expect(accepted.entitlement.pinnedVersionId).toBe(forkV2.id);
    expect(accepted.transaction).not.toBeNull();
    expect(accepted.transaction!.status).toBe('succeeded');
    expect(accepted.transaction!.amount).toBe('19.99');
    expect(accepted.transaction!.adapterReference).toMatch(/^pay_\d+$/);
    // The deterministic adapter settled EXACTLY one charge.
    expect(payments.chargeLog()).toHaveLength(1);

    // --- 5. ENTITLEMENT ENFORCEMENT over the real versions ------------------
    const customerPrincipal = operatorPrincipal;
    const purchased = await market.checkVersionAccess(customerPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV2.id,
      organizationId: customer.organizationId,
    });
    expect(purchased).toEqual({ entitled: true, basis: 'one_time_purchase', entitlementId: accepted.entitlement.id });
    // The OLDER fork v1 is NOT covered (not the purchase, not an update).
    const older = await market.checkVersionAccess(customerPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV1.id,
      organizationId: customer.organizationId,
    });
    expect(older).toEqual({ entitled: false, reason: 'update_not_included' });
    // An unrelated organization has NO access to a paid-only listing (the
    // current pin answers the honest no-free-offering denial; an older
    // version answers no_entitlement).
    const authorPrincipal = operatorPrincipal;
    const authorAccess = await market.checkVersionAccess(authorPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV2.id,
      organizationId: author.organizationId,
    });
    expect(authorAccess).toEqual({ entitled: false, reason: 'no_free_offering' });
    const authorOlder = await market.checkVersionAccess(authorPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV1.id,
      organizationId: author.organizationId,
    });
    expect(authorOlder).toEqual({ entitled: false, reason: 'no_entitlement' });

    // --- 6. INSTALL through the REAL V2-002 route (cross-tenant, pinned) ----
    const installRes = await injectJson('POST', `/organizations/${customer.organizationId}/workflow-repository/installations`, {
      workflowId: fork.id,
      versionId: forkV2.id,
    });
    expect(installRes.status, installRes.raw).toBe(201);
    const installation = (installRes.body as unknown as {
      installation: { id: string; versionId: string; status: string };
    }).installation;
    expect(installation.versionId).toBe(forkV2.id);
    expect(installation.status).toBe('enabled');

    // --- 7. CREATOR MAINTENANCE UPDATE: an explicit NEW version + revision --
    const forkV3 = await createVersion(fork.id, forkV2.id, 'Scan the repository board and summarize the ticket digest, maintenance release 3.');
    expect(forkV3.versionNumber).toBe(3);
    const [updateA, updateB] = await Promise.all([
      market.publishNewVersion(operatorPrincipal, { listingId: listed.listing.id, versionId: forkV3.id }),
      market.publishNewVersion({ userId: forker.memberUserId }, { listingId: listed.listing.id, versionId: forkV3.id }),
    ]);
    // REQUIRED REGRESSION — concurrent version publication converges: ONE
    // new revision, the duplicate converges on it.
    expect([updateA.created, updateB.created].sort()).toEqual([false, true]);
    expect(updateA.revision.id).toBe(updateB.revision.id);
    expect(updateA.revision.sequence).toBe(2);
    expect(updateA.revision.pin.versionId).toBe(forkV3.id);
    const history = await market.listListingRevisions(operatorPrincipal, listed.listing.id);
    expect(history.map((revision) => revision.pin.versionId)).toEqual([forkV2.id, forkV3.id]);
    // Revision 1 is UNCHANGED (byte-identical pin + trust) — never mutated.
    expect(history[0]!.pin.contentDigest).toBe(forkV2.contentDigest);
    expect(history[0]!.trust.semanticDigest).toBe(listed.revision.trust.semanticDigest);
    // The REAL fork version is untouched too (immutability of the authority).
    const forkV2Reread = await readVersion(fork.id, forkV2.id);
    expect(forkV2Reread.contentDigest).toBe(forkV2.contentDigest);
    expect(forkV2Reread.content).toEqual(forkV2.content);
    // The real fork version list: [v1, v2, v3] — full version history.
    const versionsRes = await injectJson('GET', `/workflow-repository/workflows/${fork.id}/versions`);
    expect(versionsRes.status).toBe(200);
    const versions = (versionsRes.body as unknown as { versions: VersionPayload[] }).versions;
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2, 3]);

    // --- 8. PAID-VERSION PINNING: the installation never moves --------------
    const installDetail = await support.repository.getInstallation(customerPrincipal, customer.organizationId, installation.id);
    expect(installDetail.installation.versionId).toBe(forkV2.id);
    expect(installDetail.pinnedVersion.id).toBe(forkV2.id);
    expect(installDetail.pinnedVersion.contentDigest).toBe(forkV2.contentDigest);
    // The customer's access to v3 is DENIED (pinned_only one-time purchase).
    const updateAccess = await market.checkVersionAccess(customerPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV3.id,
      organizationId: customer.organizationId,
    });
    expect(updateAccess).toEqual({ entitled: false, reason: 'update_not_included' });
    // …and the purchased v2 is STILL entitled.
    const stillPurchased = await market.checkVersionAccess(customerPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV2.id,
      organizationId: customer.organizationId,
    });
    expect(stillPurchased.entitled).toBe(true);

    // --- 9. CREATOR ECONOMICS: both parties read the same facts -------------
    const creatorTransaction = await market.getTransaction(operatorPrincipal, accepted.transaction!.id);
    expect(creatorTransaction.status).toBe('succeeded');
    const customerEntitlement = await market.getEntitlement(customerPrincipal, accepted.entitlement.id);
    expect(customerEntitlement.transactionId).toBe(accepted.transaction!.id);

    // --- 10. SECRET ISOLATION: the real secret_ref binding never leaks -----
    //  (the fixture's send_digest node binds credentials via secret_ref — no
    //  marketplace record carries any secret material.)
    const listingJson = JSON.stringify(history) + JSON.stringify(accepted);
    expect(listingJson).not.toMatch(/secret_ref|secretRef|digest-bot@secrets|credentials/i);

    // --- 11. EXECUTION-AUTHORITY SEPARATION: ZERO runs anywhere -------------
    //  (the full commerce flow — listing, purchase, entitlement, maintenance
    //  publication — never created a single run: entitlement grants CONTENT
    //  access only.)
    for (const tenant of [author, forker, customer]) {
      const runs = await support.runs.listRunsInOrganization(
        { userId: tenant.ownerUserId },
        tenant.organizationId,
      );
      expect(runs).toEqual([]);
    }
  });

  it('private visibility isolation THROUGH the real authority: a private workflow denies cross-tenant listing creation with the authority\u2019s uniform not-found; publication of a non-public workflow refuses typed', async () => {
    const { market } = makeMarket();
    const author = await freshTenant('private-author', 'v2-012-private-author-member');
    const outsider = await freshTenant('outsider', 'v2-012-outsider-member');
    const operatorPrincipal = { userId: operatorUserId };

    // A PRIVATE workflow in the author tenant (the API-key operator is the
    // route-acting owner; the outsider tenant's users are NOT members of the
    // author organization).
    const { workflowId, version: version1 } = await createWorkflow(author, 'digest-private', 'Scan the repository board and summarize the open ticket digest.');
    // The authority's own read boundary denies the outsider tenant's owner
    // (the marketplace consumes exactly this boundary through the reader
    // port).
    await expect(
      support.repository.getWorkflow({ userId: outsider.ownerUserId }, workflowId),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_VISIBLE' });

    // The marketplace listing-creation path routes through the SAME
    // authority: its own typed denial (WORKFLOW_NOT_VISIBLE for an
    // invisible workflow — the code the API layer maps to a 404) propagates
    // through the reader port untouched.
    await expect(
      market.createListing({ userId: outsider.ownerUserId }, {
        organizationId: outsider.organizationId,
        workflowId,
        versionId: version1.id,
        name: 'Leak attempt',
        offers: [FREE_OFFER],
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_VISIBLE' });
    await expect(
      market.createListing({ userId: outsider.memberUserId }, {
        organizationId: outsider.organizationId,
        workflowId,
        versionId: version1.id,
        name: 'Leak attempt',
        offers: [FREE_OFFER],
      }),
    ).rejects.toBeInstanceOf(WorkflowRepositoryError);

    // The OWNER can draft a listing for their private workflow (org-scoped
    // collaboration), but cross-tenant DISTRIBUTION requires the workflow to
    // be PUBLIC in the repository authority (the frozen publish rule).
    const drafted = await market.createListing(operatorPrincipal, {
      organizationId: author.organizationId,
      workflowId,
      versionId: version1.id,
      name: 'Private draft',
      offers: [FREE_OFFER],
    });
    expect(drafted.listing.status).toBe('draft');
    await expect(
      market.publishListing(operatorPrincipal, { listingId: drafted.listing.id }),
    ).rejects.toMatchObject({ code: 'MARKETPLACE_WORKFLOW_NOT_PUBLIC' });
    // Making the workflow public unblocks publication (the authority's own
    // visibility is the distribution gate).
    await setVisibility(workflowId, 'public');
    const published = await market.publishListing(operatorPrincipal, {
      listingId: drafted.listing.id,
    });
    expect(published.listing.status).toBe('published');
    // The FREE path on the real stack: an unentitled organization accesses
    // the CURRENT revision's pinned version under the free offer (basis
    // free_listing — content access only, never an execution grant).
    const freeAccess = await market.checkVersionAccess(
      { userId: outsider.ownerUserId },
      {
        listingId: drafted.listing.id,
        versionId: version1.id,
        organizationId: outsider.organizationId,
      },
    );
    expect(freeAccess).toEqual({ entitled: true, basis: 'free_listing', entitlementId: null });
  });
});
