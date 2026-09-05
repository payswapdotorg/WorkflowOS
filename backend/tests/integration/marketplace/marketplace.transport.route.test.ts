import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
} from '../../../src/workflow-repository/index.js';
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import { DefaultWorkflowRunService } from '../../../src/workflow-runs/index.js';
import { formatUtcTimestamp } from '../../../src/workflow-runs/internal/run-clock.js';
import { createSequentialIdFactory, createSteppingClock } from '../../../src/marketplace/index.js';
import { InMemoryPaymentAdapter } from '../../../src/marketplace/index.js';
import type { FastifyInstance } from 'fastify';

/**
 * V2-017 T12 — the marketplace TRANSPORT routes (the §21/§22/§23 surface)
 * over the REAL V2-012 authority + the REAL V2-002 repository.
 *
 * The real paths: the merged V2-002 workflow-repository through its real
 * Fastify routes (app.inject) over a real PGlite database with all
 * migrations — a real authored WorkflowIR workflow (ordinary + sensitive
 * capabilities for the trust view) is published public — and the T12
 * marketplace routes:
 *
 *   - browse / detail / revision history (visibility-checked, uniform
 *     typed 404 — no existence leak);
 *   - create-or-converge + publish (fail-closed: a non-member of the
 *     publisher org 403; publishing a private workflow 409; convergence
 *     answers created=false with the EXISTING listing);
 *   - offer acceptance → entitlement (+ the settled transaction), converge
 *     (no double charge), the version-access DECISION, customer
 *     cancellation;
 *   - the frozen commerce boundary: installation happens ONLY through the
 *     V2-002 authority's OWN route with the EXACT pin, and the whole
 *     commerce flow creates ZERO runs (entitlement is content access,
 *     never execution authorization);
 *   - payment failure is an honest typed 402 that grants NOTHING (a fresh
 *     failing adapter server for the regression).
 */

const PUBLISHER_KEY = 'raw-key-v2-017-t12-publisher';
const CUSTOMER_KEY = 'raw-key-v2-017-t12-customer';
const OUTSIDER_KEY = 'raw-key-v2-017-t12-outsider';
const PUBLISHER_ID = 'v2-017-t12-publisher';
const CUSTOMER_ID = 'v2-017-t12-customer';
const OUTSIDER_ID = 'v2-017-t12-outsider';

interface ListingPayload {
  listing: {
    id: string;
    publisherOrganizationId: string;
    workflowId: string;
    name: string;
    status: string;
    currentRevisionId: string;
  };
  revision: {
    id: string;
    sequence: number;
    pin: { workflowId: string; versionId: string; versionNumber: number; contentDigest: string };
    offers: { id: string; model: string; terms: Record<string, unknown> }[];
    trust: {
      requiredCapabilities: string[];
      sensitiveCapabilities: string[];
      placements: string[];
      semanticDigest: string;
    };
  };
  created?: boolean;
}

interface EntitlementPayload {
  entitlement: {
    id: string;
    customerOrganizationId: string;
    listingId: string;
    model: string;
    status: string;
    pinnedVersionId: string;
    transactionId: string | null;
  };
  transaction: {
    id: string;
    status: string;
    amount: string;
    currency: string;
    failureCode: string | null;
  } | null;
  created?: boolean;
}

/**
 * A real authored workflow with an ordinary capability
 * (github.repository.read) AND a V2-008-sensitive one (messaging.send) —
 * the trust view's disclosure facts — plus distinct placements.
 */
function authorMarketplaceWorkflow(seed: string): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('collect_posts')
    .addWorkflowInput({ name: 'weekQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'reportId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_report', output: 'messageId' },
    })
    .addNode({
      id: 'collect_posts',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'weekQuery' } },
      ],
      outputs: [{ name: 'posts', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'send_report',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'collect_posts', output: 'posts' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addEdge({ from: 'collect_posts', to: 'send_report', on: 'success' })
    .withProvenance({ origin: 'authored' })
    .withPresentation({
      title: `Weekly social media report ${seed}`,
      nodeLabels: {
        collect_posts: 'Collect the week’s posts',
        send_report: 'Email the weekly report',
      },
    })
    .build();
}

let stack: TestAuthStack;
let server: FastifyInstance;
let failureServer: FastifyInstance;

let publisherOrgId: string;
let customerOrgId: string;
let outsiderOrgId: string;
let publisherKey: string;
let customerKey: string;
let outsiderKey: string;

async function provisionIdentity(): Promise<void> {
  const org = await stack.organizationRepository.create({ name: 'T12 Publisher Org' });
  const customerOrg = await stack.organizationRepository.create({ name: 'T12 Customer Org' });
  const outsiderOrg = await stack.organizationRepository.create({ name: 'T12 Outsider Org' });
  const publisher = await stack.userRepository.upsertByExternalId({
    externalId: PUBLISHER_ID,
    displayName: 'T12 Publisher',
  });
  const customer = await stack.userRepository.upsertByExternalId({
    externalId: CUSTOMER_ID,
    displayName: 'T12 Customer',
  });
  const outsider = await stack.userRepository.upsertByExternalId({
    externalId: OUTSIDER_ID,
    displayName: 'T12 Outsider',
  });
  await stack.membershipRepository.assign({ userId: publisher.id, organizationId: org.id, roleId: 'owner' });
  await stack.membershipRepository.assign({ userId: customer.id, organizationId: customerOrg.id, roleId: 'owner' });
  await stack.membershipRepository.assign({ userId: outsider.id, organizationId: outsiderOrg.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'v2-017-t12-publisher-key', secretRef: 'WFOS_TEST_KEY_V2_017_T12_PUBLISHER', externalId: PUBLISHER_ID,
    label: 'T12 Publisher', rawKey: PUBLISHER_KEY,
  });
  await stack.apiKeyProvisioner.provision({
    keyId: 'v2-017-t12-customer-key', secretRef: 'WFOS_TEST_KEY_V2_017_T12_CUSTOMER', externalId: CUSTOMER_ID,
    label: 'T12 Customer', rawKey: CUSTOMER_KEY,
  });
  await stack.apiKeyProvisioner.provision({
    keyId: 'v2-017-t12-outsider-key', secretRef: 'WFOS_TEST_KEY_V2_017_T12_OUTSIDER', externalId: OUTSIDER_ID,
    label: 'T12 Outsider', rawKey: OUTSIDER_KEY,
  });
  publisherOrgId = org.id;
  customerOrgId = customerOrg.id;
  outsiderOrgId = outsiderOrg.id;
  publisherKey = PUBLISHER_KEY;
  customerKey = CUSTOMER_KEY;
  outsiderKey = OUTSIDER_KEY;

}

/** Author + publish a public workflow through the REAL V2-002 routes. */
async function authorPublicWorkflow(
  key: string,
  slug: string,
): Promise<{ workflowId: string; versionId: string }> {
  const createRes = await server.inject({
    method: 'POST',
    url: `/organizations/${publisherOrgId}/workflow-repository/workflows`,
    headers: { 'x-api-key': key },
    payload: {
      slug,
      name: `Weekly social media report ${slug}`,
      description: 'Automatically creates and sends your weekly social report.',
      visibility: 'public',
      content: JSON.parse(
        serializeWorkflowIrDocument(authorMarketplaceWorkflow(slug)),
      ) as Record<string, unknown>,
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    },
  });
  expect(createRes.statusCode).toBe(201);
  const created = createRes.json() as {
    workflow: { id: string; headVersionId: string };
    initialVersion: { id: string };
  };
  return { workflowId: created.workflow.id, versionId: created.initialVersion.id };
}

beforeAll(async () => {
  stack = await buildAuthStack({
    WFOS_TEST_KEY_V2_017_T12_PUBLISHER: PUBLISHER_KEY,
    WFOS_TEST_KEY_V2_017_T12_CUSTOMER: CUSTOMER_KEY,
    WFOS_TEST_KEY_V2_017_T12_OUTSIDER: OUTSIDER_KEY,
  });
  await provisionIdentity();

  const memberships: OrganizationMembershipResolver = {
    isMember: async (userId, organizationId) =>
      (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
  };
  const repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });
  // The real V2-005 run service (the zero-runs commerce-boundary read).
  const runService = new DefaultWorkflowRunService({
    db: stack.db.client,
    memberships,
    workflowRepository: repository,
    clock: { now: () => formatUtcTimestamp(Date.now()) },
    currentEpoch: 1,
  });

  server = await buildServer({
    queue: stack.db.client as never,
    logger: stack.db.logger,
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
    workflowRepository: { workflowRepositoryService: repository },
    workflowRuns: { workflowRunService: runService },
    marketplace: {
      workflowRepositoryService: repository,
      memberships,
      idFactory: createSequentialIdFactory('t12mkt'),
      clock: createSteppingClock(1789500000000, 1000),
    },
  });
  await server.ready();

  // The payment-failure server: the SAME real authorities, an adapter
  // configured to fail every charge (the processor-outage regression).
  failureServer = await buildServer({
    queue: stack.db.client as never,
    logger: stack.db.logger,
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
    workflowRepository: { workflowRepositoryService: repository },
    marketplace: {
      workflowRepositoryService: repository,
      memberships,
      payments: new InMemoryPaymentAdapter({ failingChargeReferences: ['*'] }),
      idFactory: createSequentialIdFactory('t12fail'),
      clock: createSteppingClock(1789501000000, 1000),
    },
  });
  await failureServer.ready();
});

afterAll(async () => {
  await server.close();
  await failureServer.close();
});

describe('V2-017 T12 — listing lifecycle through the transport routes', () => {
  it('browse is empty before anything is published (the honest empty read)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/marketplace/listings',
      headers: { 'x-api-key': customerKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ listings: [] });
  });

  it('create converges on (publisher, workflow); publish requires a PUBLIC workflow (fail-closed 409)', async () => {
    // A PRIVATE workflow first (the honest precondition failure).
    const privateCreate = await server.inject({
      method: 'POST',
      url: `/organizations/${publisherOrgId}/workflow-repository/workflows`,
      headers: { 'x-api-key': publisherKey },
      payload: {
        slug: 'private-social-report',
        name: 'Private social report',
        visibility: 'private',
        content: JSON.parse(
          serializeWorkflowIrDocument(authorMarketplaceWorkflow('private')),
        ) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      },
    });
    expect(privateCreate.statusCode).toBe(201);
    const privateWorkflow = privateCreate.json() as {
      workflow: { id: string };
      initialVersion: { id: string };
    };

    const listingRes = await server.inject({
      method: 'POST',
      url: '/marketplace/listings',
      headers: { 'x-api-key': publisherKey },
      payload: {
        organizationId: publisherOrgId,
        workflowId: privateWorkflow.workflow.id,
        versionId: privateWorkflow.initialVersion.id,
        name: 'Private social report',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      },
    });
    // The draft listing itself may be created (publisher-private)…
    expect(listingRes.statusCode).toBe(201);
    const draft = listingRes.json() as ListingPayload;

    // …but publication of the private workflow fails closed.
    const publishRes = await server.inject({
      method: 'POST',
      url: `/marketplace/listings/${draft.listing.id}/publish`,
      headers: { 'x-api-key': publisherKey },
    });
    expect(publishRes.statusCode).toBe(409);
    expect(publishRes.json()).toMatchObject({ code: 'MARKETPLACE_WORKFLOW_NOT_PUBLIC' });

    // The public workflow: create → 201, converge → 200 created=false.
    const { workflowId, versionId } = await authorPublicWorkflow(
      publisherKey,
      'social-report-main',
    );
    const first = await server.inject({
      method: 'POST',
      url: '/marketplace/listings',
      headers: { 'x-api-key': publisherKey },
      payload: {
        organizationId: publisherOrgId,
        workflowId,
        versionId,
        name: 'Weekly social media report',
        description: 'Automatically creates and sends your weekly social report.',
        offers: [
          {
            model: 'one_time_purchase',
            terms: {
              model: 'one_time_purchase',
              amount: '19.00',
              currency: 'USD',
              updatePolicy: 'pinned_only',
            },
          },
          {
            model: 'maintenance_subscription',
            terms: { model: 'maintenance_subscription', amount: '5.00', currency: 'USD' },
          },
        ],
      },
    });
    expect(first.statusCode).toBe(201);
    const listing = first.json() as ListingPayload;

    const converge = await server.inject({
      method: 'POST',
      url: '/marketplace/listings',
      headers: { 'x-api-key': publisherKey },
      payload: {
        organizationId: publisherOrgId,
        workflowId,
        versionId,
        name: 'Weekly social media report',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      },
    });
    expect(converge.statusCode).toBe(200);
    const converged = converge.json() as ListingPayload;
    expect(converged.created).toBe(false);
    expect(converged.listing.id).toBe(listing.listing.id);

    const published = await server.inject({
      method: 'POST',
      url: `/marketplace/listings/${listing.listing.id}/publish`,
      headers: { 'x-api-key': publisherKey },
    });
    expect(published.statusCode).toBe(200);
    expect((published.json() as ListingPayload).listing.status).toBe('published');

    // The trust view derives from the REAL document: the ordinary and the
    // V2-008-sensitive capabilities, both placements, the semantic digest.
    const trust = (published.json() as ListingPayload).revision.trust;
    expect(trust.requiredCapabilities).toEqual(['github.repository.read', 'messaging.send']);
    expect(trust.sensitiveCapabilities).toEqual(['messaging.send']);
    expect(trust.placements).toEqual(['cloud_allowed', 'cloud_preferred']);
    expect(typeof trust.semanticDigest).toBe('string');
    expect(trust.semanticDigest.length).toBeGreaterThan(0);
  });

  it('a non-member of the publisher organization cannot create a listing (fail-closed 403)', async () => {
    const { workflowId, versionId } = await authorPublicWorkflow(
      publisherKey,
      'social-report-nonmember',
    );
    const res = await server.inject({
      method: 'POST',
      url: '/marketplace/listings',
      headers: { 'x-api-key': customerKey },
      payload: {
        organizationId: publisherOrgId,
        workflowId,
        versionId,
        name: 'Hijacked listing',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'MARKETPLACE_NOT_ORGANIZATION_MEMBER' });
  });

  it('browse / detail / revisions are visibility-checked with the uniform typed 404 (no existence leak)', async () => {
    // Author + publish a listing for the browse assertions.
    const { workflowId, versionId } = await authorPublicWorkflow(
      publisherKey,
      'social-report-browse',
    );
    const created = await server.inject({
      method: 'POST',
      url: '/marketplace/listings',
      headers: { 'x-api-key': publisherKey },
      payload: {
        organizationId: publisherOrgId,
        workflowId,
        versionId,
        name: 'Invoice collector',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      },
    });
    const listing = created.json() as ListingPayload;
    await server.inject({
      method: 'POST',
      url: `/marketplace/listings/${listing.listing.id}/publish`,
      headers: { 'x-api-key': publisherKey },
    });

    // A CUSTOMER (different org) sees exactly the published listings.
    const browse = await server.inject({
      method: 'GET',
      url: '/marketplace/listings',
      headers: { 'x-api-key': customerKey },
    });
    expect(browse.statusCode).toBe(200);
    const listings = (browse.json() as { listings: ListingPayload[] }).listings;
    const names = listings.map((entry) => entry.listing.name);
    expect(names).toContain('Invoice collector');
    expect(names).not.toContain('Private social report');

    // Detail + revisions for a visible listing.
    const detail = await server.inject({
      method: 'GET',
      url: `/marketplace/listings/${listing.listing.id}`,
      headers: { 'x-api-key': customerKey },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as ListingPayload).revision.pin.versionId).toBe(versionId);

    const revisions = await server.inject({
      method: 'GET',
      url: `/marketplace/listings/${listing.listing.id}/revisions`,
      headers: { 'x-api-key': customerKey },
    });
    expect(revisions.statusCode).toBe(200);
    const revisionList = (revisions.json() as { revisions: { sequence: number }[] }).revisions;
    expect(revisionList.map((r) => r.sequence)).toEqual([1]);

    // Unknown listing: the uniform typed 404 (never an existence leak).
    const unknown = await server.inject({
      method: 'GET',
      url: '/marketplace/listings/lst-does-not-exist',
      headers: { 'x-api-key': customerKey },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'MARKETPLACE_LISTING_NOT_FOUND' });
  });
});

describe('V2-017 T12 — the purchase flow and the frozen commerce boundary', () => {
  let listingId: string;
  let oneTimeOfferId: string;
  let maintenanceOfferId: string;
  let pinVersionId: string;
  let workflowId: string;

  beforeAll(async () => {
    const authored = await authorPublicWorkflow(publisherKey, 'social-report-commerce');
    workflowId = authored.workflowId;
    pinVersionId = authored.versionId;
    const created = await server.inject({
      method: 'POST',
      url: '/marketplace/listings',
      headers: { 'x-api-key': publisherKey },
      payload: {
        organizationId: publisherOrgId,
        workflowId,
        versionId: pinVersionId,
        name: 'Weekly social media report',
        offers: [
          {
            model: 'one_time_purchase',
            terms: {
              model: 'one_time_purchase',
              amount: '19.00',
              currency: 'USD',
              updatePolicy: 'pinned_only',
            },
          },
          {
            model: 'maintenance_subscription',
            terms: { model: 'maintenance_subscription', amount: '5.00', currency: 'USD' },
          },
        ],
      },
    });
    const payload = created.json() as ListingPayload;
    listingId = payload.listing.id;
    oneTimeOfferId = payload.revision.offers.find((o) => o.model === 'one_time_purchase')!.id;
    maintenanceOfferId = payload.revision.offers.find((o) => o.model === 'maintenance_subscription')!.id;
    await server.inject({
      method: 'POST',
      url: `/marketplace/listings/${listingId}/publish`,
      headers: { 'x-api-key': publisherKey },
    });
  });

  it('the version-access DECISION before purchase: honest denials, never a grant', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${customerOrgId}/marketplace/listings/${listingId}/version-access?versionId=${pinVersionId}`,
      headers: { 'x-api-key': customerKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      decision: { entitled: false, reason: 'no_free_offering' },
    });
  });

  it('accepting the one-time offer settles a real transaction and grants the entitlement; converge never re-charges', async () => {
    const accept = await server.inject({
      method: 'POST',
      url: `/marketplace/listings/${listingId}/offers/${oneTimeOfferId}/accept`,
      headers: { 'x-api-key': customerKey },
      payload: { customerOrganizationId: customerOrgId },
    });
    expect(accept.statusCode).toBe(201);
    const accepted = accept.json() as EntitlementPayload;
    expect(accepted.entitlement.model).toBe('one_time_purchase');
    expect(accepted.entitlement.status).toBe('active');
    expect(accepted.entitlement.pinnedVersionId).toBe(pinVersionId);
    expect(accepted.transaction?.status).toBe('succeeded');
    expect(accepted.transaction?.amount).toBe('19.00');

    // The duplicate acceptance converges — no second charge.
    const again = await server.inject({
      method: 'POST',
      url: `/marketplace/listings/${listingId}/offers/${oneTimeOfferId}/accept`,
      headers: { 'x-api-key': customerKey },
      payload: { customerOrganizationId: customerOrgId },
    });
    expect(again.statusCode).toBe(200);
    const converged = again.json() as EntitlementPayload;
    expect(converged.created).toBe(false);
    expect(converged.entitlement.id).toBe(accepted.entitlement.id);
    expect(converged.transaction).toBeNull();

    // An outsider org has no access path (no entitlement, no free offering).
    const outsider = await server.inject({
      method: 'GET',
      url: `/organizations/${outsiderOrgId}/marketplace/listings/${listingId}/version-access?versionId=${pinVersionId}`,
      headers: { 'x-api-key': outsiderKey },
    });
    expect(outsider.json()).toEqual({
      decision: { entitled: false, reason: 'no_free_offering' },
    });

    // The customer org IS entitled to the exact pinned version.
    const entitled = await server.inject({
      method: 'GET',
      url: `/organizations/${customerOrgId}/marketplace/listings/${listingId}/version-access?versionId=${pinVersionId}`,
      headers: { 'x-api-key': customerKey },
    });
    expect(entitled.json()).toEqual({
      decision: {
        entitled: true,
        basis: 'one_time_purchase',
        entitlementId: accepted.entitlement.id,
      },
    });
  });

  it('installation happens ONLY through the V2-002 authority route with the EXACT pin', async () => {
    // The customer installs the listed version through the EXISTING
    // repository command — the marketplace grants content access, the
    // repository owns the installation pin.
    const install = await server.inject({
      method: 'POST',
      url: `/organizations/${customerOrgId}/workflow-repository/installations`,
      headers: { 'x-api-key': customerKey },
      payload: { workflowId, versionId: pinVersionId },
    });
    expect(install.statusCode).toBe(201);
    const installation = install.json() as {
      installation: { id: string; workflowId: string; versionId: string; status: string };
    };
    expect(installation.installation.versionId).toBe(pinVersionId);
    expect(installation.installation.workflowId).toBe(workflowId);
    expect(installation.installation.status).toBe('enabled');

    // The pin is readable back through the tenant's installation read.
    const list = await server.inject({
      method: 'GET',
      url: `/organizations/${customerOrgId}/workflow-repository/installations`,
      headers: { 'x-api-key': customerKey },
    });
    const installations = (list.json() as {
      installations: { installation: { versionId: string }; pinnedVersion: { versionNumber: number } }[];
    }).installations;
    expect(installations.some((i) => i.installation.versionId === pinVersionId)).toBe(true);
  });

  it('the whole commerce flow creates ZERO runs — entitlement is never execution authorization', async () => {
    const runs = await server.inject({
      method: 'GET',
      url: `/organizations/${customerOrgId}/workflow-runs/runs`,
      headers: { 'x-api-key': customerKey },
    });
    expect(runs.statusCode).toBe(200);
    expect((runs.json() as { runs: unknown[] }).runs).toEqual([]);
  });

  it('cancellation: the maintenance subscription cancels; the pinned version stays accessible; one-time cannot cancel (409)', async () => {
    const accept = await server.inject({
      method: 'POST',
      url: `/marketplace/listings/${listingId}/offers/${maintenanceOfferId}/accept`,
      headers: { 'x-api-key': customerKey },
      payload: { customerOrganizationId: customerOrgId },
    });
    expect(accept.statusCode).toBe(201);
    const entitlementId = (accept.json() as EntitlementPayload).entitlement.id;

    // Canceling a one-time entitlement is a typed state error.
    const oneTimeEntitlement = await server.inject({
      method: 'GET',
      url: `/organizations/${customerOrgId}/marketplace/listings/${listingId}/version-access?versionId=${pinVersionId}`,
      headers: { 'x-api-key': customerKey },
    });
    const oneTimeId = (oneTimeEntitlement.json() as {
      decision: { entitled: boolean; entitlementId: string | null };
    }).decision.entitlementId;
    expect(oneTimeId).toBeTruthy();
    const badCancel = await server.inject({
      method: 'POST',
      url: `/marketplace/entitlements/${oneTimeId}/cancel`,
      headers: { 'x-api-key': customerKey },
    });
    expect(badCancel.statusCode).toBe(409);
    expect(badCancel.json()).toMatchObject({ code: 'MARKETPLACE_ENTITLEMENT_STATE_INVALID' });

    // The maintenance subscription cancels cleanly.
    const cancel = await server.inject({
      method: 'POST',
      url: `/marketplace/entitlements/${entitlementId}/cancel`,
      headers: { 'x-api-key': customerKey },
    });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { entitlement: { status: string } }).entitlement.status).toBe('canceled');

    // The customer org still accesses the pinned version (through the
    // one-time purchase) — cancellation never rewrites history.
    const still = await server.inject({
      method: 'GET',
      url: `/organizations/${customerOrgId}/marketplace/listings/${listingId}/version-access?versionId=${pinVersionId}`,
      headers: { 'x-api-key': customerKey },
    });
    const decision = (still.json() as { decision: { entitled: boolean } }).decision;
    expect(decision.entitled).toBe(true);
  });
});

describe('V2-017 T12 — payment failure grants nothing (the frozen regression)', () => {
  it('a failing charge answers typed 402 and creates NO entitlement (never a silent success)', async () => {
    // A paid listing on the failure server (its own transport store).
    const authored = await authorPublicWorkflow(publisherKey, 'social-report-payment-failure');
    const created = await failureServer.inject({
      method: 'POST',
      url: '/marketplace/listings',
      headers: { 'x-api-key': publisherKey },
      payload: {
        organizationId: publisherOrgId,
        workflowId: authored.workflowId,
        versionId: authored.versionId,
        name: 'Paid listing (processor outage)',
        offers: [
          {
            model: 'one_time_purchase',
            terms: {
              model: 'one_time_purchase',
              amount: '49.00',
              currency: 'USD',
              updatePolicy: 'pinned_only',
            },
          },
        ],
      },
    });
    const payload = created.json() as ListingPayload;
    await failureServer.inject({
      method: 'POST',
      url: `/marketplace/listings/${payload.listing.id}/publish`,
      headers: { 'x-api-key': publisherKey },
    });
    const offerId = payload.revision.offers[0]!.id;

    const accept = await failureServer.inject({
      method: 'POST',
      url: `/marketplace/listings/${payload.listing.id}/offers/${offerId}/accept`,
      headers: { 'x-api-key': customerKey },
      payload: { customerOrganizationId: customerOrgId },
    });
    expect(accept.statusCode).toBe(402);
    expect(accept.json()).toMatchObject({ code: 'MARKETPLACE_PAYMENT_FAILED' });

    // No entitlement was created: the access decision stays denied.
    const access = await failureServer.inject({
      method: 'GET',
      url: `/organizations/${customerOrgId}/marketplace/listings/${payload.listing.id}/version-access?versionId=${authored.versionId}`,
      headers: { 'x-api-key': customerKey },
    });
    expect(access.json()).toEqual({
      decision: { entitled: false, reason: 'no_entitlement' },
    });
  });
});
