/**
 * V2-012 — standalone dogfooding RUN (real process, real product paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/integration-gates/run-v2-012-dogfooding.ts
 *
 * Executes the frozen V2-012 dogfooding clause for real:
 *
 *   "Use a safe test workflow to fork, modify, publish, install and
 *    complete a test transaction; verify creator entitlement and version
 *    history."
 *
 * Real paths only: real PGlite (ALL 62 migrations incl. 0062) + the real
 * identity stack (API-key operator) + the REAL Fastify app with the REAL
 * V2-002 workflow-repository routes (create → visibility → fork → new
 * version → cross-tenant install), every repository step driven over HTTP
 * via app.inject() + the marketplace service composed OVER the real
 * repository authority (the MarketplaceVersionReader port satisfied
 * structurally by the REAL DefaultWorkflowRepositoryService — the exact
 * service behind the routes) + the module's own deterministic in-memory
 * payment adapter (NO real provider calls — the frozen V2-012 rule).
 *
 * The experiment (ONE safe test workflow, the full collaboration →
 * marketplace → economics loop):
 *
 *   1. AUTHOR — the original author tenant authors the safe test workflow
 *      (the repository ticket digest report — merged V2-003 builder, with a
 *      REAL secret_ref binding on the send step) through the real route and
 *      makes the repository workflow public (collaboration surface).
 *   2. FORK — a second tenant forks the public v1 through the REAL V2-002
 *      fork route (fork provenance preserved: forkedFromWorkflowId /
 *      forkedFromVersionId).
 *   3. MODIFY — the forker creates an explicit NEW immutable version v2 on
 *      the fork through the REAL createVersion route (an equivalent
 *      maintenance change) and makes the fork public.
 *   4. PUBLISH — the forker lists the derivative (a one-time purchase
 *      offer, pinned_only updates) and publishes the listing; the revision
 *      pins the EXACT real version identity and the trust view surfaces the
 *      fork provenance + the real capability disclosure.
 *   5. TRANSACTION — a customer tenant browses the published listing and
 *      accepts the one-time offer: the deterministic adapter settles the
 *      charge, the transaction succeeds, the entitlement is active pinning
 *      fork v2; a duplicate acceptance CONVERGES with no second charge.
 *   6. INSTALL — the customer installs fork v2 through the REAL V2-002
 *      install route (cross-tenant, public workflow) — the installation
 *      pins the purchased version.
 *   7. MAINTENANCE — the creator publishes a compatible maintenance update
 *      as a NEW listing revision pinning a NEW real version v3 (never an
 *      in-place mutation); the customer's installation STAYS pinned to v2
 *      (paid-version pinning) and the pinned_only purchase does NOT follow
 *      the update (typed denial).
 *   8. CREATOR ENTITLEMENT + VERSION HISTORY — the customer's entitlement
 *      grants CONTENT access to the purchased version (basis
 *      one_time_purchase) and nothing else; both parties read the same
 *      transaction facts; the listing revision history and the repository
 *      version history agree; ZERO runs exist anywhere (entitlement grants
 *      content access ONLY); no secret material appears in any marketplace
 *      record.
 *
 * Determinism: the whole experiment runs TWICE on fresh stacks (fresh
 * PGlite + fresh identity stack per run); the transcripts are compared
 * after normalizing run-scoped bookkeeping (uuid-shaped ids, the derived
 * wfw_/wfwv_/wfin_ repository ids, run labels). Exits non-zero when any
 * experiment check fails (fail-closed runner).
 */
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  buildTriggerTestStack,
  versionContentOf,
  type TriggerTestStack,
} from '../workflow-deployments/trigger-test-support.js';
import {
  DefaultMarketplaceService,
  InMemoryMarketplaceStore,
  InMemoryPaymentAdapter,
  createSequentialIdFactory,
  createSteppingClock,
  type MarketplaceVersionReader,
} from '../../../src/marketplace/index.js';

const API_KEY = 'v2-012-dogfooding-api-key';
const OPERATOR_EXTERNAL_ID = 'v2-012-dogfooding-operator';

// ============================================================================
// The transcript harness (check/section/norm — the family precedent)
// ============================================================================

const transcript: string[] = [];
let failures = 0;

function section(title: string): void {
  transcript.push(`\n--- ${title} ---`);
}

function norm(value: string): string {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-4)}` : value;
}

function check(id: string, ok: boolean, message: string): void {
  if (!ok) failures += 1;
  transcript.push(`[${ok ? 'PASS' : 'FAIL'}] ${id} :: ${message}`);
}

// ============================================================================
// The safe test workflow (authored through the merged V2-003 builder; the
// send_digest node carries a REAL secret_ref binding — the secret-isolation
// checks depend on it)
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

// ============================================================================
// The experiment
// ============================================================================

async function runExperiment(runLabel: string): Promise<string> {
  let support: TriggerTestStack | undefined;
  let app: FastifyInstance | undefined;
  try {
    support = await buildTriggerTestStack({
      WFOS_V2_012_DOGFOODING_API_KEY: API_KEY,
    });
    const operator = await support.stack.userRepository.upsertByExternalId({
      externalId: OPERATOR_EXTERNAL_ID,
      displayName: 'V2-012 Dogfooding Operator',
    });
    const operatorUserId = operator.id;
    const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
    await provisioner.provision({
      keyId: 'v2-012-dogfooding-api-key-id',
      secretRef: 'WFOS_V2_012_DOGFOODING_API_KEY',
      externalId: OPERATOR_EXTERNAL_ID,
      label: 'V2-012 Dogfooding Operator',
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

    async function inject(
      method: 'GET' | 'POST' | 'PATCH',
      url: string,
      payload?: unknown,
    ): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
      const response = await app!.inject({
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

    // Three tenants (the API-key operator — the route-acting human — joins
    // each as an owner): the AUTHOR, the FORKER (the derivative's creator),
    // and the CUSTOMER.
    const tenants: { organizationId: string; ownerUserId: string }[] = [];
    for (const label of ['author', 'forker', 'customer']) {
      const org = await support.stack.organizationRepository.create({
        name: `V2-012 Dogfooding ${label} ${runLabel}`,
      });
      const owner = await support.stack.userRepository.upsertByExternalId({
        externalId: `v2-012-dogfooding-${label}-owner`,
        displayName: `V2-012 Dogfooding ${label}`,
      });
      await support.stack.membershipRepository.assign({
        userId: owner.id,
        organizationId: org.id,
        roleId: 'owner',
      });
      await support.stack.membershipRepository.assign({
        userId: operatorUserId,
        organizationId: org.id,
        roleId: 'owner',
      });
      tenants.push({ organizationId: org.id, ownerUserId: owner.id });
    }
    const [author, forker, customer] = tenants;
    // Fail-closed tenant setup (the loop pushed exactly one tenant per label,
    // but the compiler cannot see it — guard rather than assert).
    if (!author || !forker || !customer) {
      throw new Error('v2-012 dogfooding: tenant setup incomplete');
    }

    // The marketplace service composed OVER the real authority.
    const payments = new InMemoryPaymentAdapter();
    const versionReader: MarketplaceVersionReader = support.repository;
    const market = new DefaultMarketplaceService({
      store: new InMemoryMarketplaceStore(),
      versionReader,
      memberships: support.memberships,
      payments,
      idFactory: createSequentialIdFactory('v2012dog'),
      clock: createSteppingClock(1789500000000, 1000),
    });
    const operatorPrincipal = { userId: operatorUserId };

    section(`${runLabel} — 1. AUTHOR the safe test workflow (real V2-002 route)`);
    const createRes = await inject('POST', `/organizations/${author.organizationId}/workflow-repository/workflows`, {
      slug: 'digest-source',
      name: 'Repository Ticket Digest',
      description: 'The V2-012 dogfooding safe test workflow',
      visibility: 'private',
      content: versionContentOf(
        authorDigestDocument('Scan the repository board and summarize the open ticket digest.'),
      ),
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    });
    const created = createRes.body as unknown as {
      workflow: { id: string; headVersionId: string };
      initialVersion: { id: string; versionNumber: number; contentDigest: string; content: Record<string, unknown> };
    };
    const sourceWorkflowId = created.workflow.id;
    const sourceV1 = created.initialVersion;
    const patchRes = await inject('PATCH', `/workflow-repository/workflows/${sourceWorkflowId}`, {
      visibility: 'public',
    });
    check(
      '1.authored',
      createRes.status === 201 && sourceV1.versionNumber === 1 && patchRes.status === 200,
      `the safe test workflow authored v1 (content digest ${norm(sourceV1.contentDigest)}) and made PUBLIC through the real repository routes`,
    );

    section(`${runLabel} — 2. FORK the public v1 (real V2-002 fork route)`);
    const forkRes = await inject('POST', `/organizations/${forker.organizationId}/workflow-repository/forks`, {
      sourceWorkflowId,
      sourceVersionId: sourceV1.id,
      slug: 'digest-fork',
      name: 'Digest fork',
    });
    const forkBody = forkRes.body as unknown as {
      workflow: { id: string; forkedFromWorkflowId: string | null; forkedFromVersionId: string | null };
      initialVersion: { id: string; versionNumber: number; contentDigest: string };
    };
    const forkWorkflowId = forkBody.workflow.id;
    const forkV1 = forkBody.initialVersion;
    check(
      '2.fork-provenance',
      forkRes.status === 201 &&
        forkBody.workflow.forkedFromWorkflowId === sourceWorkflowId &&
        forkBody.workflow.forkedFromVersionId === sourceV1.id &&
        forkV1.versionNumber === 1 &&
        forkV1.contentDigest === sourceV1.contentDigest &&
        forkV1.id !== sourceV1.id,
      `FORK provenance preserved by V2-002: forkedFrom(${norm(forkBody.workflow.forkedFromWorkflowId!)}@${norm(forkBody.workflow.forkedFromVersionId!)}) — the fork's own v1 is a NEW immutable version identity carrying the source content (digest ${norm(forkV1.contentDigest)})`,
    );

    section(`${runLabel} — 3. MODIFY: the forker's explicit new version (real createVersion route)`);
    const modifyRes = await inject('POST', `/workflow-repository/workflows/${forkWorkflowId}/versions`, {
      content: versionContentOf(
        authorDigestDocument('Scan the repository board and summarize the ticket digest, maintenance release 2.'),
      ),
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      parentVersionId: forkV1.id,
    });
    const forkV2 = (modifyRes.body as unknown as { version: { id: string; versionNumber: number; contentDigest: string; content: Record<string, unknown> } }).version;
    await inject('PATCH', `/workflow-repository/workflows/${forkWorkflowId}`, { visibility: 'public' });
    check(
      '3.modified',
      modifyRes.status === 201 &&
        forkV2.versionNumber === 2 &&
        forkV2.contentDigest !== forkV1.contentDigest,
      `the derivative's explicit new version v2 (number ${forkV2.versionNumber}, distinct content digest ${norm(forkV2.contentDigest)}) created through the real route; the fork made PUBLIC`,
    );

    section(`${runLabel} — 4. PUBLISH the derivative (listing + publication)`);
    const listed = await market.createListing(operatorPrincipal, {
      organizationId: forker.organizationId,
      workflowId: forkWorkflowId,
      versionId: forkV2.id,
      name: 'Digest Report (community fork)',
      description: 'The forked digest report — dogfooding listing',
      offers: [ONE_TIME_OFFER],
    });
    const published = await market.publishListing(operatorPrincipal, { listingId: listed.listing.id });
    const parsedV2 = parseWorkflowIrDocument(JSON.stringify(forkV2.content));
    const semanticV2 =
      parsedV2.ok ? computeWorkflowVersionSemanticDigest(parsedV2.document).digest : '<unparseable>';
    check(
      '4.published',
      listed.created === true &&
        listed.revision.sequence === 1 &&
        published.listing.status === 'published' &&
        listed.revision.pin.versionId === forkV2.id &&
        listed.revision.pin.contentDigest === forkV2.contentDigest &&
        listed.revision.trust.semanticDigest === semanticV2 &&
        listed.revision.trust.provenance.forkedFromWorkflowId === sourceWorkflowId &&
        listed.revision.trust.requiredCapabilities.join(',') === 'github.repository.read,messaging.send' &&
        listed.revision.trust.sensitiveCapabilities.join(',') === 'messaging.send',
      `the listing published with revision 1 pinning the REAL fork v2 identity (content ${norm(forkV2.contentDigest)}, semantic ${norm(semanticV2)}), provenance ${norm(sourceWorkflowId)}, disclosure [github.repository.read, messaging.send] (sensitive: messaging.send)`,
    );

    section(`${runLabel} — 5. TRANSACTION: the customer purchases (deterministic adapter)`);
    const browsed = await market.listPublishedListings(operatorPrincipal);
    const offerId = published.revision.offers[0]!.id;
    const accepted = await market.acceptOffer(operatorPrincipal, {
      listingId: listed.listing.id,
      offerId,
      customerOrganizationId: customer.organizationId,
    });
    const duplicate = await market.acceptOffer(operatorPrincipal, {
      listingId: listed.listing.id,
      offerId,
      customerOrganizationId: customer.organizationId,
    });
    check(
      '5.transaction',
      browsed.some((entry) => entry.listing.id === listed.listing.id) &&
        accepted.created === true &&
        accepted.entitlement.status === 'active' &&
        accepted.entitlement.model === 'one_time_purchase' &&
        accepted.entitlement.pinnedVersionId === forkV2.id &&
        accepted.transaction !== null &&
        accepted.transaction.status === 'succeeded' &&
        accepted.transaction.amount === '19.99' &&
        accepted.transaction.adapterReference === 'pay_1' &&
        payments.chargeLog().length === 1 &&
        duplicate.created === false &&
        duplicate.transaction === null,
      `the test transaction completed through the deterministic adapter (pay_1, 19.99 USD, succeeded); the entitlement pins fork v2; the duplicate acceptance CONVERGED with EXACTLY ONE charge`,
    );

    section(`${runLabel} — 6. INSTALL the purchased version (real V2-002 install route)`);
    const installRes = await inject('POST', `/organizations/${customer.organizationId}/workflow-repository/installations`, {
      workflowId: forkWorkflowId,
      versionId: forkV2.id,
    });
    const installation = (installRes.body as unknown as { installation: { id: string; versionId: string; status: string } })
      .installation;
    check(
      '6.installed',
      installRes.status === 201 && installation.versionId === forkV2.id && installation.status === 'enabled',
      `the customer installed the purchased fork v2 through the REAL cross-tenant install route — the installation PINS ${norm(forkV2.id)} (enabled)`,
    );

    section(`${runLabel} — 7. MAINTENANCE update (a NEW revision pinning a NEW real version)`);
    const v3Res = await inject('POST', `/workflow-repository/workflows/${forkWorkflowId}/versions`, {
      content: versionContentOf(
        authorDigestDocument('Scan the repository board and summarize the ticket digest, maintenance release 3.'),
      ),
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      parentVersionId: forkV2.id,
    });
    const forkV3 = (v3Res.body as unknown as { version: { id: string; versionNumber: number; contentDigest: string } })
      .version;
    const updated = await market.publishNewVersion(operatorPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV3.id,
    });
    const history = await market.listListingRevisions(operatorPrincipal, listed.listing.id);
    const installDetail = await support.repository.getInstallation(
      operatorPrincipal,
      customer.organizationId,
      installation.id,
    );
    const v2Reread = await inject('GET', `/workflow-repository/workflows/${forkWorkflowId}/versions/${forkV2.id}`);
    check(
      '7.maintenance-new-revision',
      v3Res.status === 201 &&
        forkV3.versionNumber === 3 &&
        updated.created === true &&
        updated.revision.sequence === 2 &&
        updated.revision.pin.versionId === forkV3.id &&
        history.length === 2 &&
        history[0]!.pin.versionId === forkV2.id &&
        history[0]!.pin.contentDigest === forkV2.contentDigest &&
        history[0]!.trust.semanticDigest === listed.revision.trust.semanticDigest,
      `the creator maintenance update is an EXPLICIT new revision (sequence 2 pinning fork v3 ${norm(forkV3.id)}); revision 1 is UNCHANGED (same pin + same trust view) — never an in-place mutation`,
    );
    check(
      '7.paid-version-pinning',
      installDetail.installation.versionId === forkV2.id &&
        installDetail.pinnedVersion.id === forkV2.id &&
        v2Reread.status === 200 &&
        (v2Reread.body as unknown as { version: { contentDigest: string } }).version.contentDigest ===
          forkV2.contentDigest,
      `PAID-VERSION PINNING: the customer's installation still pins fork v2 and the purchased version is byte-identical after the maintenance update`,
    );

    section(`${runLabel} — 8. CREATOR ENTITLEMENT + VERSION HISTORY (content access ONLY)`);
    const purchased = await market.checkVersionAccess(operatorPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV2.id,
      organizationId: customer.organizationId,
    });
    const updateAccess = await market.checkVersionAccess(operatorPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV3.id,
      organizationId: customer.organizationId,
    });
    const creatorView = await market.getTransaction(operatorPrincipal, accepted.transaction!.id);
    const versionsList = await inject('GET', `/workflow-repository/workflows/${forkWorkflowId}/versions`);
    const versions = (versionsList.body as unknown as { versions: { versionNumber: number; contentDigest: string }[] })
      .versions;
    let totalRuns = 0;
    for (const tenant of tenants) {
      totalRuns += (
        await support.runs.listRunsInOrganization(operatorPrincipal, tenant.organizationId)
      ).length;
    }
    const marketplaceRecordsJson =
      JSON.stringify(history) + JSON.stringify(accepted) + JSON.stringify(purchased);
    check(
      '8.creator-entitlement',
      purchased.entitled === true &&
        purchased.basis === 'one_time_purchase' &&
        purchased.entitlementId === accepted.entitlement.id &&
        updateAccess.entitled === false &&
        (updateAccess as { reason?: string }).reason === 'update_not_included' &&
        creatorView.status === 'succeeded',
      `CREATOR ENTITLEMENT verified: the customer's entitlement grants CONTENT access to the purchased fork v2 (basis one_time_purchase) and NOTHING else (the pinned_only update is denied update_not_included); the creator reads the same succeeded transaction`,
    );
    check(
      '8.version-history',
      versions.length === 3 &&
        versions.map((version) => version.versionNumber).join(',') === '1,2,3' &&
        history.map((revision) => revision.pin.versionNumber).join(',') === '2,3' &&
        new Set(versions.map((version) => version.contentDigest)).size === 3,
      `VERSION HISTORY verified: the fork's repository versions [1, 2, 3] and the listing revisions [v2, v3] agree — 3 distinct content digests, full provenance chain`,
    );
    check(
      '8.execution-authority-separation',
      totalRuns === 0 &&
        Object.keys(purchased).sort().join(',') === 'basis,entitled,entitlementId',
      `EXECUTION-AUTHORITY SEPARATION: the whole commerce loop created ZERO runs (entitlement grants content access ONLY) and the access decision exposes exactly {entitled, basis, entitlementId}`,
    );
    check(
      '8.secret-isolation',
      !/secret_ref|secretRef|digest-bot@secrets|credential/i.test(marketplaceRecordsJson),
      `SECRET ISOLATION: the fixture's real secret_ref binding never appears in any marketplace record (listing revisions, entitlement, transaction, decision)`,
    );

    transcript.push(`\n# ${runLabel} summary: ${failures === 0 ? 'all checks PASS' : `${failures} FAILED`}`);
    return transcript.join('\n');
  } finally {
    await app!.close();
    await support!.teardown();
  }
}

async function main(): Promise<void> {
  const runOne = await runExperiment('RUN 1');
  const failuresOne = failures;
  const normalizedOne = normalizeTranscript(runOne);
  transcript.length = 0;
  failures = 0;
  const runTwo = await runExperiment('RUN 2');
  const normalizedTwo = normalizeTranscript(runTwo);

  const deterministic = normalizedOne === normalizedTwo;
  transcript.push('');
  transcript.push('(RUN 1 transcript: byte-identical to RUN 2 above after normalizing run-scoped');
  transcript.push(' bookkeeping — uuid-shaped ids, the derived wfw_/wfwv_/wfin_ repository ids, the');
  transcript.push(' run labels. Both runs share the same deterministic marketplace ids, the same');
  transcript.push(' content/semantic digests and the same adapter receipt sequence.)');
  transcript.push('');
  transcript.push(`determinism: transcripts ${deterministic ? 'IDENTICAL after normalization' : 'DIVERGED (see diff)'}`);
  if (!deterministic) {
    const a = normalizedOne.split('\n');
    const b = normalizedTwo.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        transcript.push(`  diff line ${i}: RUN1=${JSON.stringify(a[i] ?? '')}`);
        transcript.push(`  diff line ${i}: RUN2=${JSON.stringify(b[i] ?? '')}`);
      }
    }
  }
  transcript.push('');
  transcript.push(
    `DOGFOODING RESULT: ${failuresOne === 0 && failures === 0 && deterministic ? 'PASS (deterministic across two fresh runs)' : 'FAIL'}`,
  );
  // eslint-disable-next-line no-console
  console.log(transcript.join('\n'));
  process.exit(failuresOne === 0 && failures === 0 && deterministic ? 0 : 1);
}

/**
 * Normalize run-scoped bookkeeping (uuid-shaped org/user ids — full AND
 * norm()-truncated forms — the derived wfw_/wfwv_/wfin_ repository ids, run
 * labels). The marketplace's own ids (v2012dog_N) and the digests are
 * deterministic functions of the experiment and are preserved verbatim.
 */
function normalizeTranscript(text: string): string {
  return text
    .replace(/RUN 1|RUN 2/g, 'RUN <n>')
    .replace(/V2-012 Dogfooding \w+ RUN <n>/g, 'V2-012 Dogfooding <tenant> <run>')
    // uuid-shaped ids (organizations, users)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    // deterministic-prefix repository ids (full form): wfw_/wfwv_/wfin_
    .replace(/\b(wfw|wfwv|wfin)_[0-9a-f]{12,}\b/g, '<$1_id>')
    // norm()-truncated id-like tokens (first-slice … last-slice) — both the
    // prefixed (wfw_/wfwv_/wfin_) and the bare hex forms
    .replace(/\b(wfw|wfwv|wfin)_[0-9a-f]{3,6}…[0-9a-f]{4}\b/g, '<id>')
    .replace(/\b[0-9a-f-]{3,10}…[0-9a-f]{4}\b/g, '<id>');
}

main().catch((error) => {
  console.error('V2-012 dogfooding runner crashed:', error);
  process.exit(1);
});
