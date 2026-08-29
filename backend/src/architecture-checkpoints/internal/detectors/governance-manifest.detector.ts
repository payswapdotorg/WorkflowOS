/**
 * WORK-052 — the governance-manifest detector
 * (`detectorKind: 'governance-manifest'`; ADR-0006).
 *
 * Evaluates the repository-resident development-governance state
 * (`spec/development-state/governance-model.json` + `program-state.json`,
 * ADR-0001) AT THE BOUND REVISION through the existing revision-bound
 * `RepositorySnapshot` — never the working tree. This is WorkflowOS checking
 * its own control plane: the SELF-HOSTING-BOUNDARY and
 * IMPLEMENTATION-COMPLETENESS checkpoint contracts become executable at any
 * revision through the standard substrate, with durable /verification
 * evidence and no new authority.
 *
 * It reuses the ONE fail-closed validation engine
 * (`internal/governance-validation.ts`) that the application-layer control
 * plane also uses — the substrate and the control plane can never disagree
 * about what a valid governed state is.
 *
 * detectorConfig:
 *   modelPath: string (default 'spec/development-state/governance-model.json')
 *   programPath: string (default 'spec/development-state/program-state.json')
 *   requirePresent: boolean (default true) — a governed repository MUST carry
 *     its development state; when false, a missing manifest is 'not_applicable'
 *     (repos that do not declare the governance artifacts).
 *
 * Semantics (fail closed; ADR-0006):
 *   - no snapshot bound → 'not_applicable' (revision-bound assertions only)
 *   - a read FAILURE (unreadable revision content) → 'inconclusive'
 *   - missing manifest with requirePresent → 'inconclusive' (the governed
 *     state could not be ESTABLISHED; a blocking assertion then blocks —
 *     ADR-0006: missing/unreadable/parses-failing manifests are inconclusive)
 *   - JSON parse failure → 'inconclusive' (the same ADR-0006 rule — the
 *     post-merge review, BLOCKER 3: the code must match the accepted ADR)
 *   - any validation violation → 'fail' with the violation list (the
 *     boundary was weakened, the DAG went cyclic, a completion lost its
 *     evidence, …) — 'fail' is reserved for ESTABLISHED violations
 *   - otherwise → 'pass'
 */

import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';
import { SnapshotReadError } from '../../types.js';
import {
  validateGovernanceState,
  type GovernanceModel,
  type GovernanceValidationResult,
  type ProgramState,
} from '../governance-validation.js';

export class GovernanceManifestDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'governance-manifest';

  async evaluate(input: DetectorInput): Promise<DetectorResult> {
    const snapshot = input.snapshot;
    if (!snapshot) {
      return {
        status: 'not_applicable',
        summary:
          `no implementation snapshot is bound at the ${input.checkpointKind} checkpoint — ` +
          'this assertion applies to revision-bound checkpoints only',
      };
    }
    const cfg = input.assertion.detectorConfig ?? {};
    const modelPath =
      typeof cfg.modelPath === 'string' && cfg.modelPath.length > 0
        ? cfg.modelPath
        : 'spec/development-state/governance-model.json';
    const programPath =
      typeof cfg.programPath === 'string' && cfg.programPath.length > 0
        ? cfg.programPath
        : 'spec/development-state/program-state.json';
    const requirePresent = typeof cfg.requirePresent === 'boolean' ? cfg.requirePresent : true;

    // Read both manifests THROUGH the snapshot (exact-revision binding).
    let modelText: string | null;
    let programText: string | null;
    try {
      modelText = await snapshot.readFile(modelPath);
      programText = await snapshot.readFile(programPath);
    } catch (err) {
      return {
        status: 'inconclusive',
        summary:
          `the governance manifests could not be read at revision ${snapshot.revision} — ` +
          (err instanceof SnapshotReadError
            ? `${err.reason}: ${err.message}`
            : String(err instanceof Error ? err.message : err)),
      };
    }

    if (modelText === null || programText === null) {
      if (requirePresent) {
        const missing = [modelPath, programPath].filter((p) =>
          (p === modelPath ? modelText : programText) === null,
        );
        return {
          status: 'inconclusive',
          summary:
            `the development-governance state is ABSENT at revision ${snapshot.revision} ` +
            `(missing: ${missing.join(', ')}) — a governed repository must carry its ` +
            'repository-resident state (WORK-052 §34.1; ADR-0001); ADR-0006: ' +
            'missing/unreadable/parses-failing manifests are INCONCLUSIVE (a blocking assertion then blocks)',
        };
      }
      return {
        status: 'not_applicable',
        summary:
          `no development-governance state is declared at revision ${snapshot.revision} ` +
          '(requirePresent=false)',
      };
    }

    let model: unknown;
    let program: unknown;
    try {
      model = JSON.parse(modelText);
      program = JSON.parse(programText);
    } catch (err) {
      return {
        status: 'inconclusive',
        summary:
          `the development-governance state does not PARSE at revision ${snapshot.revision} — ` +
          `${String(err instanceof Error ? err.message : err)}; ADR-0006: ` +
          'missing/unreadable/parses-failing manifests are INCONCLUSIVE (a blocking assertion then blocks)',
      };
    }

    let result: GovernanceValidationResult;
    try {
      // Enforcement references are validated against the SAME revision: the
      // reader goes through the snapshot (a referenced file missing at this
      // revision is a validation violation, not a silent pass).
      result = await validateGovernanceState(
        model as GovernanceModel,
        program as ProgramState,
        async (path) => snapshot.readFile(path),
        // The work-order identity surface is validated AT THE SAME REVISION:
        // duplicate WORK-NNN identity claims at the bound revision are a
        // 'fail' (duplicate identifiers are duplicate authorities — the
        // 2026-08-29 identity resolution); a listing failure propagates to
        // the catch below (inconclusive, fail closed).
        async (path) => (await snapshot.listDir(path)).map((e) => e.name),
      );
    } catch (err) {
      return {
        status: 'inconclusive',
        summary:
          `the governance state could not be fully validated at revision ${snapshot.revision} ` +
          `(a referenced artifact could not be read — ${String(err instanceof Error ? err.message : err)}); ` +
          'fail closed',
      };
    }

    if (!result.ok) {
      return {
        status: 'fail',
        summary:
          `the development-governance state at revision ${snapshot.revision} violates ` +
          `${result.violations.length} invariant(s): ${result.violations.slice(0, 5).join(' | ')}` +
          (result.violations.length > 5 ? ` (+${result.violations.length - 5} more)` : ''),
        details: { violations: result.violations, revision: snapshot.revision },
      };
    }
    return {
      status: 'pass',
      summary:
        `the development-governance state at revision ${snapshot.revision} is valid: ` +
        'boundary intact, DAG acyclic, statuses evidence-backed, assurance profiles dominant, ' +
        'enforcement references present',
    };
  }
}
