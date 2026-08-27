/**
 * WORK-051 — the interface/contract detector
 * (`detectorKind: 'interface-contract'`).
 *
 * Asserts that a frozen module's public barrel exposes a required symbol —
 * the machine-checkable form of "the public contract still contains X"
 * (design §7 "interface/contract detector").
 *
 * detectorConfig:
 *   modulesDir: string (default 'src/modules')
 *   moduleDir: string (required) — the module whose barrel is asserted
 *   symbol: string (required) — the export name that must be present
 *
 * Deterministic: a pure read of the barrel source AT THE BOUND REVISION
 * (PR #52 round 1, BLOCKER 1). An unreadable or absent barrel is
 * 'inconclusive' (fail closed) — never a pass.
 */

import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';
import { readRequiredFile, snapshotFailureMessage } from './snapshot-tree.js';

export class InterfaceContractDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'interface-contract';

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
    const moduleDir = typeof cfg.moduleDir === 'string' ? cfg.moduleDir : null;
    const symbol = typeof cfg.symbol === 'string' ? cfg.symbol : null;
    if (!moduleDir || !symbol) {
      return {
        status: 'inconclusive',
        summary: 'detectorConfig requires moduleDir and symbol',
      };
    }
    const modulesDir = typeof cfg.modulesDir === 'string' ? cfg.modulesDir : 'src/modules';
    const barrelPath = `${modulesDir.replace(/^\/+|\/+$/g, '')}/${moduleDir}/index.ts`;

    let source: string;
    try {
      source = await readRequiredFile(snapshot, barrelPath);
    } catch (err) {
      return {
        status: 'inconclusive',
        summary: `the governed tree could not be inspected — ${snapshotFailureMessage(err, barrelPath, snapshot.revision)}`,
      };
    }

    // The symbol must appear in an export statement (type or value export).
    const exportRe = new RegExp(
      `export\\s+(?:type\\s+)?(?:const|class|function|interface|type)?[^{;]*\\{[^}]*\\b${symbol}\\b`,
    );
    if (!exportRe.test(source)) {
      return {
        status: 'fail',
        summary: `the /${moduleDir} public barrel at revision ${snapshot.revision} no longer exports ${symbol}`,
      };
    }
    return {
      status: 'pass',
      summary: `the /${moduleDir} public barrel at revision ${snapshot.revision} exports ${symbol}`,
    };
  }
}
