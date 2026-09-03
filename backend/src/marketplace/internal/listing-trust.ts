/**
 * V2-012 — the frozen listing-trust derivation (PURE).
 *
 * Derives one listing revision's trust metadata from the pinned version's
 * REAL WorkflowIR document (consumed through the merged V2-003 barrel: the
 * parser + the semantic digest — never re-implemented here) and the V2-008
 * sensitive-capability classification (consumed read-only). Fork provenance
 * is surfaced verbatim from the V2-002 workflow facts.
 *
 * The view is DISCLOSURE, never authorization: required capabilities and
 * their sensitivity are facts the customer inspects BEFORE installing (the
 * marketplace-economics safety requirement); publication, volume, ranking,
 * reviews or badges never enter this derivation and can never be
 * interpreted as authorization or execution proof.
 */
import {
  parseWorkflowIrDocument,
  computeWorkflowVersionSemanticDigest,
} from '../../workflow-ir/index.js';
import { capabilitySensitivityOf } from '../../computer-agent/index.js';
import { MarketplaceError } from '../types.js';
import type {
  ListingDependencyNode,
  ListingTrustMetadata,
  MarketplaceVersionFacts,
  MarketplaceWorkflowFacts,
} from '../types.js';

export function deriveListingTrust(input: {
  readonly version: MarketplaceVersionFacts;
  readonly workflow: MarketplaceWorkflowFacts;
  readonly publisherOrganizationId: string;
  readonly publisherUserId: string;
}): ListingTrustMetadata {
  // The marketplace only distributes parseable WorkflowIR versions: the
  // trust view (capabilities, placements, dependencies, digests) is
  // DERIVED from the real document, so an unparseable one is a typed,
  // fail-closed distribution refusal.
  const parsed = parseWorkflowIrDocument(JSON.stringify(input.version.content));
  if (!parsed.ok) {
    throw new MarketplaceError(
      'MARKETPLACE_VERSION_CONTENT_NOT_PARSEABLE',
      `version ${input.version.id} content is not a parseable WorkflowIR document`,
    );
  }
  const document = parsed.document;
  const semantic = computeWorkflowVersionSemanticDigest(document);

  const capabilities = new Set<string>();
  const placements = new Set<string>();
  const dependencies: ListingDependencyNode[] = [];
  for (const node of document.ir.nodes) {
    for (const capability of node.capabilityRequirements) {
      capabilities.add(capability);
    }
    placements.add(node.placement);
    if (node.spec.class === 'subworkflow') {
      dependencies.push({
        nodeId: node.id,
        dependencyRef: `${node.spec.subworkflow.workflowId}@${node.spec.subworkflow.versionRef}`,
      });
    }
  }

  const requiredCapabilities = [...capabilities].sort();
  const sensitiveCapabilities = requiredCapabilities.filter(
    (capability) => capabilitySensitivityOf(capability) === 'sensitive',
  );

  return {
    publisherOrganizationId: input.publisherOrganizationId,
    publisherUserId: input.publisherUserId,
    workflowId: input.version.workflowId,
    versionId: input.version.id,
    versionNumber: input.version.versionNumber,
    contentDigest: input.version.contentDigest,
    semanticDigest: semantic.digest,
    requiredCapabilities,
    sensitiveCapabilities,
    placements: [...placements].sort(),
    dependencyGraph: dependencies,
    provenance: {
      forkedFromWorkflowId: input.workflow.forkedFromWorkflowId,
      forkedFromVersionId: input.workflow.forkedFromVersionId,
    },
  };
}
