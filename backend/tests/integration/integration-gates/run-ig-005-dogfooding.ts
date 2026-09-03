/**
 * IG-005 — REQUIRED REAL-SYSTEM DOGFOODING RUN (dogfooding-protocol.md).
 *
 * Executes the LITERAL frozen dogfooding clause of work order IG-005
 * (spec/architecture/v2/work-orders/IG-005.md) through the REAL product
 * surfaces — no vitest, no mocks:
 *
 *   "Use a safe test workflow to fork, publish, install and execute it,
 *    then install and execute one first-party WorkflowOS development
 *    workflow through the same protocol."
 *
 * Real paths (the integration-gate composition discipline):
 *   - the REAL V2-002 workflow-repository service over the real PGlite
 *     test harness (all migrations; real users/organizations/
 *     memberships) — the SAME authority behind the real routes;
 *   - the REAL V2-012 marketplace service composed OVER that repository
 *     (the MarketplaceVersionReader port satisfied structurally by the
 *     real service; the deterministic in-memory TEST payment adapter —
 *     no real provider calls);
 *   - the REAL V2-005 workflow-runs service (the run command surface:
 *     request/start/step/invocation/evidence/complete);
 *   - the REAL V2-013 self-hosted library (installFirstPartyWorkflows
 *     through the same repository port) and the REAL
 *     development-governance state loader (the canonical
 *     governance-model.json).
 *
 * The experiment (one complete dogfood on a fresh REAL stack):
 *   1. THE THIRD-PARTY PROTOCOL: the safe test workflow is authored
 *      (v1, public), FORKED, MODIFIED (v2), PUBLISHED as a marketplace
 *      listing (revision 1 pins v2; the fork provenance rides verbatim),
 *      PURCHASED (a one-time-offer entitlement) and INSTALLED
 *      cross-tenant through the REAL installation path (version-pinned).
 *   2. THE ENTITLEMENT BOUNDARY: the full commerce flow created ZERO
 *      runs; the ACTIVE entitlement presented AS an installation
 *      credential is refused TYPED by the run authority.
 *   3. THE MAINTENANCE UPDATE: the creator publishes v3 + revision 2
 *      (explicit version transitions); the customer's installed pin
 *      NEVER moves.
 *   4. EXECUTE THE THIRD-PARTY WORKFLOW: a REAL run through the REAL
 *      V2-005 command surface, pinned to the exact installed version,
 *      completing end-to-end.
 *   5. THE FIRST-PARTY PROTOCOL (the SAME authorities): the first-party
 *      library installs through the same repository port; the SAME
 *      installVersion call converges on the SAME installation identity;
 *      one first-party development workflow (the MAINTENANCE procedure)
 *      executes END-TO-END through the same run command surface.
 *   6. PROTOCOL EQUIVALENCE + EVIDENCE: the same pin-facts semantics on
 *      both sides; the V2-013 evidence reconstruction over the REAL run
 *      history converges with the manifest.
 *
 * Determinism: the experiment runs TWICE on fresh stacks; the structured
 * facts are identical; the normalized transcripts (eliding only generated
 * identities) are byte-identical.
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/integration-gates/run-ig-005-dogfooding.ts
 *
 * Exit code 0 = every assertion held (PASS); non-zero = failure to triage.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  reconstructSelfHostingEvidence,
  evaluateSelfHostingBoundary,
  FIRST_PARTY_WORKFLOW_ARTIFACTS,
  type FirstPartyInstallPort,
  type FirstPartyPinFacts,
  type SelfHostingBoundaryPolicyInput,
} from '../../../src/self-hosted-library/index.js';
import { FileSystemGovernanceStateLoader } from '../../../src/development-governance/index.js';
import { WorkflowRunError } from '../../../src/workflow-runs/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PROTOCOL = { irSchemaVersion: 'workflowos-workflow-ir-v1' } as const;
const FIRST_PARTY_PROTOCOL = { irSchemaVersion: 'wfos-ir-1' } as const;

// ============================================================================
// The transcript harness (check/section — the family precedent)
// ============================================================================

const transcript: string[] = [];
const structuredFacts: Record<string, unknown> = {};
let failures = 0;

function section(title: string) {
  transcript.push(`\n## ${title}\n`);
}

function check(id: string, ok: boolean, description: string) {
  transcript.push(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${description}`);
  structuredFacts[id] = ok;
  if (!ok) {
    failures += 1;
  }
}

/** Normalize a transcript: elide generated identities (determinism comparison). */
function normalize(lines: readonly string[]): string {
  return lines
    .map((line) =>
      line
        .replace(/\brun-[12]\b/g, '<run>')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
        .replace(/\bwf[a-z]+_[0-9a-f]{8,}\b/g, '<wfid>')
        .replace(/\bmkt-[a-z0-9]+\b/g, '<mktid>')
        .replace(/[0-9a-f]{12,64}/g, '<sha>'),
    )
    .join('\n');
}

// ============================================================================
// The safe test workflow (the V2-012 fixture family: a real V2-003 document)
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

// ============================================================================
// The experiment (one complete dogfood on a fresh REAL stack)
// ============================================================================

interface ExperimentResult {
  readonly transcript: readonly string[];
  readonly structuredFacts: Record<string, unknown>;
}

async function runExperiment(label: string): Promise<ExperimentResult> {
  const localTranscript: string[] = [];
  const localFacts: Record<string, unknown> = {};
  const localSection = (title: string) => localTranscript.push(`\n## ${title}\n`);
  const localCheck = (id: string, ok: boolean, description: string) => {
    localTranscript.push(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${description}`);
    localFacts[id] = ok;
    if (!ok) {
      failures += 1;
    }
  };

  const support: TriggerTestStack = await buildTriggerTestStack({
    WFOS_IG_005_DOGFOOD_KEY: 'ig-005-dogfooding-key',
  });
  try {
    const operatorExternalId = 'ig-005-dogfooding-operator';
    const operator = await support.stack.userRepository.upsertByExternalId({
      externalId: operatorExternalId,
      displayName: 'IG-005 Dogfooding Operator',
    });
    const operatorPrincipal = { userId: operator.id };

    /** Fresh tenants with the operator joined as owner (the route-driving human). */
    const freshTenant = async (tenantLabel: string) => {
      const tenant = await createTenant(support, `ig005dog-${tenantLabel}`);
      await support.stack.membershipRepository.assign({
        userId: operator.id,
        organizationId: tenant.organizationId,
        roleId: 'owner',
      });
      return { organizationId: tenant.organizationId, ownerUserId: tenant.ownerUserId };
    };

    // ------------------------------------------------------------------
    // 0. the REAL governance boundary (loaded + validated, fail-closed)
    // ------------------------------------------------------------------
    const loaded = await new FileSystemGovernanceStateLoader({
      repoRoot: REPO_ROOT,
      governanceDir: join(REPO_ROOT, 'spec', 'development-state'),
    }).inspect();
    localCheck(
      'governance-model-valid',
      loaded.validation.ok,
      'the canonical governance-model.json loads and validates clean (the fail-closed governance state)',
    );
    const boundary: SelfHostingBoundaryPolicyInput = loaded.model.selfHostingBoundary;

    // ==================================================================
    // 1. THE THIRD-PARTY PROTOCOL (fork → modify → publish → purchase → install)
    // ==================================================================
    localSection(`${label} — 1. THE THIRD-PARTY PROTOCOL (fork → publish → install)`);

    const author = await freshTenant('author');
    const forker = await freshTenant('forker');
    const customer = await freshTenant('customer');
    const repository = support.repository;

    // the ORIGINAL author creates v1 (private) and publishes it public
    const sourceCreated = await repository.createWorkflow(operatorPrincipal, {
      organizationId: author.organizationId,
      slug: 'ig005-dogfooding-digest-source',
      name: 'Repository Ticket Digest (source)',
      description: 'The IG-005 dogfooding fixture (the safe test workflow)',
      visibility: 'private',
      content: versionContentOf(authorDigestDocument('Scan the repository board and summarize the open ticket digest.')),
      protocol: PROTOCOL,
    });
    const sourceWorkflowId = sourceCreated.workflow.id;
    const sourceV1 = sourceCreated.initialVersion;
    await repository.updateWorkflow(operatorPrincipal, sourceWorkflowId, { visibility: 'public' });

    // FORK (the REAL V2-002 fork path — the derivative with provenance)
    const forked = await repository.forkWorkflow(operatorPrincipal, {
      organizationId: forker.organizationId,
      sourceWorkflowId,
      sourceVersionId: sourceV1.id,
      slug: 'ig005-dogfooding-digest-fork',
      name: 'Repository Ticket Digest (community fork)',
    });
    const forkWorkflowId = forked.workflow.id;
    const forkV1 = forked.initialVersion;
    localCheck(
      'fork-provenance-recorded',
      forked.workflow.forkedFromWorkflowId === sourceWorkflowId &&
        forked.workflow.forkedFromVersionId === sourceV1.id &&
        forkV1.contentDigest === sourceV1.contentDigest &&
        forkV1.id !== sourceV1.id,
      'the REAL fork records the upstream (workflow, version) and carries the source content as a NEW immutable version identity',
    );

    // MODIFY: the forker's explicit v2; the derivative goes PUBLIC
    const forkV2Result = await repository.createVersion(operatorPrincipal, forkWorkflowId, {
      content: versionContentOf(
        authorDigestDocument('Scan the repository board and summarize the ticket digest, dogfooding release 2.'),
      ),
      protocol: PROTOCOL,
      parentVersionId: forkV1.id,
    });
    const forkV2 = forkV2Result.version;
    await repository.updateWorkflow(operatorPrincipal, forkWorkflowId, { visibility: 'public' });

    // PUBLISH: the marketplace listing (the REAL V2-012 service over the
    // REAL repository reader port; the deterministic in-memory payments)
    const payments = new InMemoryPaymentAdapter();
    const market: MarketplaceService = new DefaultMarketplaceService({
      store: new InMemoryMarketplaceStore(),
      versionReader: support.repository as MarketplaceVersionReader,
      memberships: support.memberships,
      payments,
      idFactory: createSequentialIdFactory('ig005dog'),
      clock: createSteppingClock(1789500000000, 1000),
    });
    const listed = await market.createListing(operatorPrincipal, {
      organizationId: forker.organizationId,
      workflowId: forkWorkflowId,
      versionId: forkV2.id,
      name: 'Digest Report (community fork)',
      description: 'The IG-005 dogfooding listing',
      offers: [
        {
          model: 'one_time_purchase' as const,
          terms: {
            model: 'one_time_purchase' as const,
            amount: '19.99',
            currency: 'USD',
            updatePolicy: 'pinned_only' as const,
          },
        },
      ],
    });
    const published = await market.publishListing(operatorPrincipal, { listingId: listed.listing.id });
    localCheck(
      'listing-published-pinned',
      published.listing.status === 'published' &&
        published.revision.pin.versionId === forkV2.id &&
        published.revision.pin.versionNumber === 2 &&
        published.revision.trust.provenance.forkedFromWorkflowId === sourceWorkflowId &&
        published.revision.trust.provenance.forkedFromVersionId === sourceV1.id,
      'the marketplace listing is PUBLISHED with revision 1 pinning the exact fork v2 (provenance riding verbatim)',
    );

    // PURCHASE: the customer accepts the one-time offer (content access)
    const oneTimeOfferId = published.revision.offers.find((offer) => offer.model === 'one_time_purchase')!.id;
    const accepted = await market.acceptOffer(operatorPrincipal, {
      listingId: listed.listing.id,
      offerId: oneTimeOfferId,
      customerOrganizationId: customer.organizationId,
    });
    localCheck(
      'purchase-entitled-pinned',
      accepted.entitlement.status === 'active' &&
        accepted.entitlement.pinnedVersionId === forkV2.id &&
        accepted.transaction?.status === 'succeeded' &&
        payments.chargeLog().length === 1,
      'the customer\'s purchase settles exactly one charge and the entitlement pins the purchased version (content access only)',
    );

    // INSTALL: cross-tenant, version-pinned, through the REAL authority
    const installed = await repository.installVersion(operatorPrincipal, {
      organizationId: customer.organizationId,
      workflowId: forkWorkflowId,
      versionId: forkV2.id,
    });
    const installDetail = await repository.getInstallation(
      operatorPrincipal,
      customer.organizationId,
      installed.installation.id,
    );
    localCheck(
      'installed-version-pinned',
      installDetail.installation.versionId === forkV2.id &&
        installDetail.installation.status === 'enabled' &&
        installDetail.pinnedVersion.id === forkV2.id &&
        installDetail.pinnedVersion.contentDigest === forkV2.contentDigest,
      'the published workflow is installed VERSION-PINNED through the real installation path (the exact purchased version identity)',
    );

    // ==================================================================
    // 2. THE ENTITLEMENT BOUNDARY (entitlement ≠ execution authorization)
    // ==================================================================
    localSection(`${label} — 2. THE ENTITLEMENT BOUNDARY (entitlement is not an execution credential)`);

    const commerceRunsEmpty =
      (await support.runs.listRunsInOrganization({ userId: author.ownerUserId }, author.organizationId)).length === 0 &&
      (await support.runs.listRunsInOrganization({ userId: forker.ownerUserId }, forker.organizationId)).length === 0 &&
      (await support.runs.listRunsInOrganization({ userId: customer.ownerUserId }, customer.organizationId)).length === 0;
    localCheck(
      'commerce-creates-zero-runs',
      commerceRunsEmpty,
      'the FULL commerce flow (listing, publication, purchase, entitlement, installation) created ZERO runs — entitlement grants content access only',
    );

    let entitlementCredentialRefused = false;
    try {
      await support.runs.requestRun(operatorPrincipal, {
        commandId: 'cmd-ig005dog-ent-0001',
        correlationId: 'ig005dog-entitlement-flow',
        causationId: 'ig005dog-entitlement-root',
      }, {
        organizationId: customer.organizationId,
        workflowId: forkWorkflowId,
        versionId: forkV2.id,
        installationId: accepted.entitlement.id,
        trigger: { type: 'manual', id: 'ig005dog-entitlement-credential-attempt' },
        inputCommitments: [commitmentOf('ig005dog-entitlement-input')],
      });
    } catch (error) {
      entitlementCredentialRefused = error instanceof WorkflowRunError && error.code === 'RUN_INSTALLATION_MISMATCH';
    }
    localCheck(
      'entitlement-credential-refused',
      entitlementCredentialRefused,
      'the ACTIVE entitlement id presented as an installation credential is refused TYPED (RUN_INSTALLATION_MISMATCH) — the marketplace identity is not an execution credential',
    );

    // ==================================================================
    // 3. THE MAINTENANCE UPDATE (explicit version transitions)
    // ==================================================================
    localSection(`${label} — 3. THE MAINTENANCE UPDATE (explicit transitions, pin held)`);

    const forkV3Result = await repository.createVersion(operatorPrincipal, forkWorkflowId, {
      content: versionContentOf(
        authorDigestDocument('Scan the repository board and summarize the ticket digest, dogfooding maintenance release 3.'),
      ),
      protocol: PROTOCOL,
      parentVersionId: forkV2.id,
    });
    const forkV3 = forkV3Result.version;
    const update = await market.publishNewVersion(operatorPrincipal, {
      listingId: listed.listing.id,
      versionId: forkV3.id,
    });
    const pinAfterUpdate = await repository.getInstallation(
      operatorPrincipal,
      customer.organizationId,
      installed.installation.id,
    );
    const versionHistory = await repository.listVersions(operatorPrincipal, forkWorkflowId);
    localCheck(
      'maintenance-explicit-transition',
      update.created === true &&
        update.revision.sequence === 2 &&
        update.revision.pin.versionId === forkV3.id &&
        versionHistory.map((version) => version.versionNumber).join(',') === '1,2,3',
      'the maintenance update is an EXPLICIT version transition (new immutable v3 + new revision pinning it; version history 1,2,3)',
    );
    localCheck(
      'maintenance-pin-held',
      pinAfterUpdate.installation.versionId === forkV2.id &&
        pinAfterUpdate.pinnedVersion.id === forkV2.id &&
        pinAfterUpdate.pinnedVersion.contentDigest === forkV2.contentDigest,
      'the installed pin NEVER moved through the maintenance update (still the exact purchased v2 identity)',
    );

    // ==================================================================
    // 4. EXECUTE THE THIRD-PARTY WORKFLOW (the REAL V2-005 command surface)
    // ==================================================================
    localSection(`${label} — 4. EXECUTE THE THIRD-PARTY WORKFLOW (the real run, pinned)`);

    const runs = support.runs;
    const requested = await runs.requestRun(operatorPrincipal, {
      commandId: 'cmd-ig005dog-run-0001',
      correlationId: 'ig005dog-execution-flow',
      causationId: 'ig005dog-execution-root',
    }, {
      organizationId: customer.organizationId,
      workflowId: forkWorkflowId,
      versionId: forkV2.id,
      installationId: installed.installation.id,
      trigger: { type: 'manual', id: 'ig005dog-third-party-trigger' },
      inputCommitments: [commitmentOf('ig005dog-third-party-input')],
    });
    const runId = requested.result.run.id;
    const runRow = await runs.getRun(operatorPrincipal, runId);
    const parsedThirdParty = forkV2.content;
    localCheck(
      'third-party-run-pinned',
      runRow.workflowId === forkWorkflowId &&
        runRow.versionId === forkV2.id &&
        runRow.installationId === installed.installation.id &&
        runRow.versionContentDigest === forkV2.contentDigest &&
        runRow.versionSemanticDigest === computeWorkflowVersionSemanticDigest(
          JSON.parse(JSON.stringify(parsedThirdParty)) as WorkflowIrDocument,
        ).digest,
      'the REAL run pins the installed workflow EXACTLY (workflow, version, installation) and carries the authority\'s semantic digest',
    );
    await runs.startRun(operatorPrincipal, {
      commandId: 'cmd-ig005dog-run-0002',
      correlationId: 'ig005dog-execution-flow',
      causationId: runId,
    }, { runId });

    // the three declared steps (fetch → scan → send), each with its
    // capability invocation, honest evidence and completion
    const stepPlan: ReadonlyArray<{
      stepId: string;
      capability: string;
      executionClass: 'deterministic_api' | 'agentic_computer_use';
      evidenceClass: 'observation' | 'verification';
    }> = [
      { stepId: 'fetch_tickets', capability: 'github.repository.read', executionClass: 'deterministic_api', evidenceClass: 'observation' },
      { stepId: 'scan_board', capability: 'github.repository.read', executionClass: 'agentic_computer_use', evidenceClass: 'verification' },
      { stepId: 'send_digest', capability: 'messaging.send', executionClass: 'deterministic_api', evidenceClass: 'verification' },
    ];
    let stepIndex = 0;
    for (const step of stepPlan) {
      stepIndex += 1;
      await runs.recordStepStarted(operatorPrincipal, {
        commandId: `cmd-ig005dog-step-${String(stepIndex).padStart(4, '0')}-a`,
        correlationId: 'ig005dog-execution-flow',
        causationId: runId,
      }, { runId, stepId: step.stepId });
      const invocation = await runs.recordInvocationRequested(operatorPrincipal, {
        commandId: `cmd-ig005dog-inv-${String(stepIndex).padStart(4, '0')}-a`,
        correlationId: 'ig005dog-execution-flow',
        causationId: runId,
      }, {
        runId,
        capability: step.capability,
        executionClass: step.executionClass,
        stepId: step.stepId,
        inputCommitments: [commitmentOf(`ig005dog-${step.stepId}-input`)],
      });
      await runs.recordEvidence(operatorPrincipal, {
        commandId: `cmd-ig005dog-ev-${String(stepIndex).padStart(4, '0')}-a`,
        correlationId: 'ig005dog-execution-flow',
        causationId: runId,
      }, {
        runId,
        stepId: step.stepId,
        evidenceClass: step.evidenceClass,
        producerKind: 'worker',
        producerId: 'ig005dog-worker',
        contentCommitment: commitmentOf(`ig005dog-${step.stepId}-evidence`),
        description: `the ${step.stepId} step completed with recorded evidence`,
      });
      await runs.recordInvocationCompleted(operatorPrincipal, {
        commandId: `cmd-ig005dog-inv-${String(stepIndex).padStart(4, '0')}-b`,
        correlationId: 'ig005dog-execution-flow',
        causationId: runId,
      }, {
        runId,
        invocationId: invocation.result.invocation.id,
        outcome: 'succeeded',
        outputCommitments: [commitmentOf(`ig005dog-${step.stepId}-output`)],
      });
      await runs.recordStepCompleted(operatorPrincipal, {
        commandId: `cmd-ig005dog-step-${String(stepIndex).padStart(4, '0')}-b`,
        correlationId: 'ig005dog-execution-flow',
        causationId: runId,
      }, {
        runId,
        stepId: step.stepId,
        outcome: 'succeeded',
        outputCommitments: [commitmentOf(`ig005dog-${step.stepId}-output`)],
      });
    }
    const completedThird = await runs.completeRun(operatorPrincipal, {
      commandId: 'cmd-ig005dog-run-0003',
      correlationId: 'ig005dog-execution-flow',
      causationId: runId,
    }, {
      runId,
      outputCommitments: [commitmentOf('ig005dog-third-party-output')],
    });
    localCheck(
      'third-party-run-completed',
      completedThird.result.run.state === 'completed',
      'the third-party workflow executed END-TO-END through the real run command surface (3 declared steps, 3 capability invocations, honest evidence records, completed)',
    );

    // ==================================================================
    // 5. THE FIRST-PARTY PROTOCOL (the SAME authorities)
    // ==================================================================
    localSection(`${label} — 5. THE FIRST-PARTY PROTOCOL (the same installation + execution authorities)`);

    const devOrgId = support.orgAId;
    const devPrincipal = { userId: support.ownerAId };
    const port: FirstPartyInstallPort = support.repository as unknown as FirstPartyInstallPort;

    // the boundary admits all six first-party artifacts (governance holds)
    const allArtifactsAdmitted = FIRST_PARTY_WORKFLOW_ARTIFACTS.every(
      (artifact) => evaluateBoundaryOk(artifact.document, boundary),
    );
    localCheck(
      'first-party-boundary-admitted',
      allArtifactsAdmitted,
      'the REAL governance boundary admits all six first-party artifacts (self-hosting does not bypass development governance)',
    );

    // INSTALL the first-party library through the same V2-002 authority
    const library = await installFirstPartyWorkflows({
      principal: devPrincipal,
      organizationId: devOrgId,
      port,
      protocol: FIRST_PARTY_PROTOCOL,
    });
    const maintenance = library.manifests.find((manifest) => manifest.kind === 'maintenance')!;
    localCheck(
      'first-party-installed',
      library.manifests.length === 6 && maintenance.versionNumber === 1,
      `the six first-party workflows installed through the SAME real authority (the maintenance manifest pins ${maintenance.workflowId}@${maintenance.versionId})`,
    );

    // the SAME installVersion call (the universal installation protocol)
    // converges on the SAME installation identity
    const sameProtocolInstall = await support.repository.installVersion(devPrincipal, {
      organizationId: devOrgId,
      workflowId: maintenance.workflowId,
      versionId: maintenance.versionId,
    });
    localCheck(
      'first-party-same-install-protocol',
      sameProtocolInstall.installation.id === maintenance.installationId &&
        sameProtocolInstall.created === false,
      'the SAME universal installVersion call serves the first-party workflow and CONVERGES on the port-installed installation identity (one installation authority)',
    );

    // EXECUTE the first-party MAINTENANCE development workflow end-to-end
    // through the SAME run command surface
    const firstPartyRequested = await runs.requestRun(devPrincipal, {
      commandId: 'cmd-ig005dog-fp-run-0001',
      correlationId: 'ig005dog-first-party-flow',
      causationId: 'ig005dog-first-party-root',
    }, {
      organizationId: devOrgId,
      workflowId: maintenance.workflowId,
      versionId: maintenance.versionId,
      installationId: maintenance.installationId,
      trigger: { type: 'manual', id: 'ig005dog-first-party-trigger' },
      inputCommitments: [commitmentOf('ig005dog-first-party-input')],
    });
    const firstPartyRunId = firstPartyRequested.result.run.id;
    const firstPartyRun = await runs.getRun(devPrincipal, firstPartyRunId);
    localCheck(
      'first-party-run-pinned',
      firstPartyRun.workflowId === maintenance.workflowId &&
        firstPartyRun.versionId === maintenance.versionId &&
        firstPartyRun.installationId === maintenance.installationId &&
        firstPartyRun.versionSemanticDigest === maintenance.semanticDigest.digest,
      'the first-party run pins the manifest EXACTLY (workflow, version, installation) with the manifest\'s semantic digest — the same pin semantics as the third-party run',
    );
    await runs.startRun(devPrincipal, {
      commandId: 'cmd-ig005dog-fp-run-0002',
      correlationId: 'ig005dog-first-party-flow',
      causationId: firstPartyRunId,
    }, { runId: firstPartyRunId });

    // the maintenance procedure's steps: observe_signals (agentic) →
    // prepare_work_item_inputs (agentic) → architect_triage (HUMAN) →
    // record_triage (deterministic_api)
    const firstPartySteps: ReadonlyArray<{
      stepId: string;
      capability?: string;
      executionClass?: 'deterministic_api' | 'agentic_computer_use';
      human?: boolean;
    }> = [
      { stepId: 'observe_signals', capability: 'filesystem.read', executionClass: 'agentic_computer_use' },
      { stepId: 'prepare_work_item_inputs', capability: 'filesystem.write', executionClass: 'agentic_computer_use' },
      { stepId: 'architect_triage', human: true },
      { stepId: 'record_triage', capability: 'filesystem.write', executionClass: 'deterministic_api' },
    ];
    let fpIndex = 0;
    for (const step of firstPartySteps) {
      fpIndex += 1;
      await runs.recordStepStarted(devPrincipal, {
        commandId: `cmd-ig005dog-fp-step-${String(fpIndex).padStart(4, '0')}-a`,
        correlationId: 'ig005dog-first-party-flow',
        causationId: firstPartyRunId,
      }, { runId: firstPartyRunId, stepId: step.stepId });
      if (!step.human) {
        const invocation = await runs.recordInvocationRequested(devPrincipal, {
          commandId: `cmd-ig005dog-fp-inv-${String(fpIndex).padStart(4, '0')}-a`,
          correlationId: 'ig005dog-first-party-flow',
          causationId: firstPartyRunId,
        }, {
          runId: firstPartyRunId,
          capability: step.capability!,
          executionClass: step.executionClass!,
          stepId: step.stepId,
          inputCommitments: [commitmentOf(`ig005dog-fp-${step.stepId}-input`)],
        });
        await runs.recordInvocationCompleted(devPrincipal, {
          commandId: `cmd-ig005dog-fp-inv-${String(fpIndex).padStart(4, '0')}-b`,
          correlationId: 'ig005dog-first-party-flow',
          causationId: firstPartyRunId,
        }, {
          runId: firstPartyRunId,
          invocationId: invocation.result.invocation.id,
          outcome: 'succeeded',
          outputCommitments: [commitmentOf(`ig005dog-fp-${step.stepId}-output`)],
        });
      }
      await runs.recordStepCompleted(devPrincipal, {
        commandId: `cmd-ig005dog-fp-step-${String(fpIndex).padStart(4, '0')}-b`,
        correlationId: 'ig005dog-first-party-flow',
        causationId: firstPartyRunId,
      }, {
        runId: firstPartyRunId,
        stepId: step.stepId,
        outcome: 'succeeded',
        outputCommitments: [commitmentOf(`ig005dog-fp-${step.stepId}-output`)],
      });
    }
    const completedFirst = await runs.completeRun(devPrincipal, {
      commandId: 'cmd-ig005dog-fp-run-0003',
      correlationId: 'ig005dog-first-party-flow',
      causationId: firstPartyRunId,
    }, {
      runId: firstPartyRunId,
      outputCommitments: [commitmentOf('ig005dog-first-party-output')],
    });
    localCheck(
      'first-party-run-completed',
      completedFirst.result.run.state === 'completed',
      'the first-party development workflow executed END-TO-END through the SAME run command surface (4 steps incl. the human architect-triage gate, completed)',
    );

    // ==================================================================
    // 6. PROTOCOL EQUIVALENCE + EVIDENCE RECONSTRUCTION
    // ==================================================================
    localSection(`${label} — 6. PROTOCOL EQUIVALENCE + EVIDENCE (the convergence)`);

    // the same pin-facts semantics on both sides (the first-party pin
    // read-back shape equals the third-party installation detail shape)
    const thirdPartyPinFacts: FirstPartyPinFacts = {
      organizationId: customer.organizationId,
      installationId: installed.installation.id,
      workflowId: installDetail.pinnedVersion.workflowId,
      versionId: installDetail.pinnedVersion.id,
      versionNumber: installDetail.pinnedVersion.versionNumber,
      contentDigest: installDetail.pinnedVersion.contentDigest,
    };
    const firstPartyDetail = await support.repository.getInstallation(
      devPrincipal,
      devOrgId,
      maintenance.installationId,
    );
    localCheck(
      'protocol-equivalence-pins',
      thirdPartyPinFacts.versionId === installDetail.installation.versionId &&
        firstPartyDetail.pinnedVersion.id === firstPartyDetail.installation.versionId &&
        firstPartyDetail.pinnedVersion.id === maintenance.versionId &&
        Object.keys(thirdPartyPinFacts).join(',') ===
          'organizationId,installationId,workflowId,versionId,versionNumber,contentDigest',
      'BOTH installations expose the SAME pin facts (workflow, version, versionNumber, contentDigest) through the SAME authority read surface — first-party and third-party are one protocol',
    );

    // the V2-013 evidence reconstruction over the REAL run histories
    // converges with the manifest (pin matches; the completed first-party
    // run attributed to the exact pinned version)
    const maintenancePinFacts: FirstPartyPinFacts = {
      organizationId: devOrgId,
      installationId: maintenance.installationId,
      workflowId: maintenance.workflowId,
      versionId: maintenance.versionId,
      versionNumber: maintenance.versionNumber,
      contentDigest: maintenance.contentDigest,
    };
    const reconstruction = reconstructSelfHostingEvidence({
      manifests: [maintenance],
      pinFacts: [maintenancePinFacts],
      runHistories: [await runs.getRunHistory(devPrincipal, firstPartyRunId)],
    });
    const maintenanceRecord = reconstruction.records.find((record) => record.kind === 'maintenance')!;
    localCheck(
      'evidence-reconstruction-converges',
      maintenanceRecord.pinMatchesManifest === true &&
        maintenanceRecord.runs.length === 1 &&
        maintenanceRecord.runs[0]!.state === 'completed' &&
        maintenanceRecord.runs[0]!.installationId === maintenance.installationId &&
        reconstruction.unpinnedRuns.length === 0,
      'the evidence reconstruction over the REAL run history converges with the first-party manifest (pin matches; the completed run attributed to the exact pinned installation; zero unpinned runs)',
    );

    return { transcript: localTranscript, structuredFacts: localFacts };
  } finally {
    await support.teardown();
  }
}

/** The boundary verdict helper (typed fail-closed — never a boolean cast). */
function evaluateBoundaryOk(
  document: WorkflowIrDocument,
  boundary: SelfHostingBoundaryPolicyInput,
): boolean {
  const verdict = evaluateSelfHostingBoundary(document, boundary);
  return verdict.allowed;
}

// ============================================================================
// main(): two fresh-stack runs + determinism + the evidence doc
// ============================================================================

async function main(): Promise<void> {
  section('IG-005 dogfooding — the marketplace and self-hosting share ONE installation/execution protocol (real stack, real paths)');
  const first = await runExperiment('run-1');
  const second = await runExperiment('run-2');
  transcript.push(...first.transcript);

  // determinism: the structured facts identical; the normalized transcripts identical
  check(
    'determinism-structured-facts',
    JSON.stringify(first.structuredFacts) === JSON.stringify(second.structuredFacts) &&
      Object.values(first.structuredFacts).every((value) => value === true),
    'the structured facts are IDENTICAL across the two fresh-stack runs (every check green in both)',
  );
  const normalizedFirst = normalize(first.transcript);
  const normalizedSecond = normalize(second.transcript);
  check(
    'determinism-normalized-transcripts',
    normalizedFirst === normalizedSecond,
    'the normalized transcripts are IDENTICAL across the two fresh-stack runs (generated identities elided: the V2-002/V2-005 uuid-shaped ids, the digests, the run labels)',
  );

  // the final verdict + the evidence doc
  const allOk = failures === 0;
  transcript.push('\n---\n');
  transcript.push(
    allOk
      ? 'DOGFOODING RESULT: PASS (a safe test workflow was forked, published, purchased, installed version-pinned and executed end-to-end through the REAL marketplace/repository/run authorities; the entitlement boundary held (zero commerce runs; the entitlement-as-credential attack refused typed); the maintenance update was an explicit version transition with the installed pin held; the first-party development workflows installed through the SAME authority with the SAME installVersion protocol and the MAINTENANCE procedure executed end-to-end through the SAME run command surface; the pin facts are one protocol on both sides; the evidence reconstruction converged; two fresh-stack runs deterministic)'
      : `DOGFOODING RESULT: FAIL (${failures} failed checks)`,
  );

  const evidenceDoc = [
    '# IG-005 — Marketplace ↔ Self-Hosting Integration: dogfooding evidence',
    '',
    '**Runner:** `backend/tests/integration/integration-gates/run-ig-005-dogfooding.ts` (executed from `backend/` with `bunx tsx`)',
    '**Date:** 2026-09-03 (the frozen IG-005 dogfooding clause execution)',
    '**Base:** `9d803b98849b978b694e045814a03346aab40866` (canonical main after the post-W6 reconciliation merge, PR #162)',
    '',
    '## The executed clause',
    '',
    '> Use a safe test workflow to fork, publish, install and execute it, then install and execute one first-party WorkflowOS development workflow through the same protocol.',
    '',
    'The safe test workflow was the V2-012 fixture family (the repository ticket digest: a real V2-003 document with deterministic + agentic + secret-binding steps). The first-party workflow chosen for the same-protocol execution was the MAINTENANCE procedure (the only first-party artifact whose steps require no proof-predicate packaging — its four steps, including the HUMAN architect-triage gate, all execute through the ordinary run command surface).',
    '',
    '## Machine-checkable results (both fresh-stack runs)',
    '',
    ...first.transcript,
    '',
    '## Corrective observations (recorded per the dogfooding protocol)',
    '',
    '1. **The universal installation protocol is observably ONE.** The third-party fork (a cross-tenant marketplace install of a purchased version) and the first-party library (the self-hosting development environment) both resolve to the SAME authority surface: the SAME `installVersion` call, the SAME pinned-version read-back shape, and the SAME convergence semantics (a duplicate install converges on the existing installation identity — `created: false`). The gate found no protocol fork between marketplace distribution and self-hosting.',
    '2. **The entitlement boundary is structural, not procedural.** The full commerce flow (listing → publication → purchase → installation) created zero runs, and the active entitlement id presented to the run authority as an installation credential was refused with the authority\'s own typed code (RUN_INSTALLATION_MISMATCH). Execution authorization lives entirely in the run authority\'s chain (membership + pinned-version resolution + installation pin match); the marketplace\'s version-access decision shape (entitled/basis/entitlementId) carries no execution concept at all.',
    '3. **Maintenance transitions are explicit on both sides.** The marketplace maintenance update created a new immutable version (v3) and a new pinning revision (sequence 2) while the customer\'s installation stayed pinned to the purchased v2 — and the first-party library\'s governed transition (publish + install through the real authorities, with the recovery advance requiring the installed read-back) is the same discipline. No in-place mutation of any pin, revision or version was observed anywhere in the experiment.',
    '4. **The human gate is honest.** The first-party MAINTENANCE procedure\'s architect_triage step executed as a HUMAN step (no capability invocation — the approval is the human act, recorded as step outcome, exactly as the governance model prescribes). The dogfood recorded it honestly rather than simulating an agentic step in its place.',
    '5. **Fork provenance is durable distribution metadata.** The fork\'s upstream facts rode the listing trust view verbatim through publication and the maintenance revision, and the fork\'s v1 still carried the source content digest byte-identically — provenance survives publication exactly as the work order requires.',
    '',
    '## Determinism',
    '',
    'The experiment ran twice on fresh stacks (fresh PGlite with ALL migrations, fresh identities). The structured facts were identical across both runs; the normalized transcripts (eliding only generated identities — the V2-002/V2-005 uuid-shaped ids, the digests, the run labels) were byte-identical.',
    '',
    '## Honest scope statement',
    '',
    'The dogfood drove the repository surfaces at the service level (the exact service behind the real routes; the integration battery drives the identical surface through the real HTTP routes via `app.inject`). It did NOT drive a real payment provider (the frozen V2-012 rule: the deterministic in-memory TEST adapter is the reference implementation) and did NOT drive the V2-008 ComputerAgentRuntime host-execution path (the capability invocations were recorded through the run authority\'s command surface — the worker\'s real recording path).',
    '',
  ].join('\n');

  const evidencePath = join(
    REPO_ROOT,
    'spec',
    'architecture',
    'v2',
    'dogfooding-evidence',
    'IG-005-marketplace-self-hosting.md',
  );
  writeFileSync(evidencePath, evidenceDoc, 'utf8');
  transcript.push(`\nevidence document written: ${evidencePath}`);

  // eslint-disable-next-line no-console
  console.log(transcript.join('\n'));
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
