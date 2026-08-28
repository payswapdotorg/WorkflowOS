/**
 * WORK-051 — the detector registry. Maps `detectorKind` (the assertion's
 * declared detector class) to its deterministic implementation.
 *
 * The six initial detector classes (issue #51 "Detector boundary"; design
 * §7) are registered here and NOWHERE else — a single, enumerable seam the
 * static architecture invariants can pin:
 *
 *   repository-structure  — static repository structure/import rules
 *   schema-migration      — schema/migration invariants
 *   authority-ownership   — authority ownership (no second authority)
 *   interface-contract    — interface/contract presence in public barrels
 *   workflow-transition   — the frozen workflow transition graph as data
 *   runtime-configuration — forbidden runtime patterns (e.g. no scheduler)
 *
 * Unknown detectorKind ⇒ the checkpoint evaluates that assertion as
 * 'inconclusive' (fail-closed for blocking assertions) — an assertion can
 * never silently pass because its detector is missing.
 */

import type { ArchitectureAssertionDetector } from '../types.js';
import { RepositoryStructureDetector } from './detectors/repository-structure.detector.js';
import { SchemaMigrationDetector } from './detectors/schema-migration.detector.js';
import { AuthorityOwnershipDetector } from './detectors/authority-ownership.detector.js';
import { InterfaceContractDetector } from './detectors/interface-contract.detector.js';
import { WorkflowTransitionDetector } from './detectors/workflow-transition.detector.js';
import { RuntimeConfigurationDetector } from './detectors/runtime-configuration.detector.js';

/** The complete, closed set of initial detector kinds (design §7). */
export const INITIAL_DETECTOR_KINDS: readonly string[] = [
  'repository-structure',
  'schema-migration',
  'authority-ownership',
  'interface-contract',
  'workflow-transition',
  'runtime-configuration',
];

export function createDefaultDetectorRegistry(): Map<string, ArchitectureAssertionDetector> {
  const detectors: ArchitectureAssertionDetector[] = [
    new RepositoryStructureDetector(),
    new SchemaMigrationDetector(),
    new AuthorityOwnershipDetector(),
    new InterfaceContractDetector(),
    new WorkflowTransitionDetector(),
    new RuntimeConfigurationDetector(),
  ];
  const registry = new Map<string, ArchitectureAssertionDetector>();
  for (const d of detectors) {
    registry.set(d.detectorKind, d);
  }
  return registry;
}
