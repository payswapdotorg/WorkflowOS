/**
 * WORK-051 — the detector registry. Maps `detectorKind` (the assertion's
 * declared detector class) to its deterministic implementation.
 *
 * The initial six detector classes (issue #51 "Detector boundary"; design
 * §7) plus the WORK-052 seventh (ADR-0006) are registered here and NOWHERE
 * else — a single, enumerable seam the static architecture invariants can
 * pin:
 *
 *   repository-structure  — static repository structure/import rules
 *   schema-migration      — schema/migration invariants
 *   authority-ownership   — authority ownership (no second authority)
 *   interface-contract    — interface/contract presence in public barrels
 *   workflow-transition   — the frozen workflow transition graph as data
 *   runtime-configuration — forbidden runtime patterns (e.g. no scheduler)
 *   governance-manifest   — the repository-resident development-governance
 *                           state (WORK-052 §34; the self-hosting boundary)
 *
 * Unknown detectorKind ⇒ the checkpoint evaluates that assertion as
 * 'inconclusive' (fail-closed for blocking assertions) — an assertion can
 * never silently pass because its detector is missing.
 *
 * The set remains CLOSED: advancing it (6→7 in WORK-052) is a deliberate,
 * ADR-recorded, reviewable event — the closed-set static invariant is
 * advanced in the same change (docs/adr/ADR-0006-governance-manifest-detector.md).
 */

import type { ArchitectureAssertionDetector } from '../types.js';
import { RepositoryStructureDetector } from './detectors/repository-structure.detector.js';
import { SchemaMigrationDetector } from './detectors/schema-migration.detector.js';
import { AuthorityOwnershipDetector } from './detectors/authority-ownership.detector.js';
import { InterfaceContractDetector } from './detectors/interface-contract.detector.js';
import { WorkflowTransitionDetector } from './detectors/workflow-transition.detector.js';
import { RuntimeConfigurationDetector } from './detectors/runtime-configuration.detector.js';
import { GovernanceManifestDetector } from './detectors/governance-manifest.detector.js';

/** The complete, closed set of detector kinds (WORK-051 §7 + WORK-052 ADR-0006). */
export const INITIAL_DETECTOR_KINDS: readonly string[] = [
  'repository-structure',
  'schema-migration',
  'authority-ownership',
  'interface-contract',
  'workflow-transition',
  'runtime-configuration',
  'governance-manifest',
];

export function createDefaultDetectorRegistry(): Map<string, ArchitectureAssertionDetector> {
  const detectors: ArchitectureAssertionDetector[] = [
    new RepositoryStructureDetector(),
    new SchemaMigrationDetector(),
    new AuthorityOwnershipDetector(),
    new InterfaceContractDetector(),
    new WorkflowTransitionDetector(),
    new RuntimeConfigurationDetector(),
    new GovernanceManifestDetector(),
  ];
  const registry = new Map<string, ArchitectureAssertionDetector>();
  for (const d of detectors) {
    registry.set(d.detectorKind, d);
  }
  return registry;
}
