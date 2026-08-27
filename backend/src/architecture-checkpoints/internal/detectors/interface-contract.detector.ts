/**
 * WORK-051 — the interface/contract detector
 * (`detectorKind: 'interface-contract'`).
 *
 * Asserts that a frozen module's public barrel exposes a required symbol —
 * the machine-checkable form of "the public contract still contains X"
 * (design §7 "interface/contract detector").
 *
 * detectorConfig:
 *   rootDir: string (required)
 *   modulesDir: string (default 'src/modules')
 *   moduleDir: string (required) — the module whose barrel is asserted
 *   symbol: string (required) — the export name that must be present
 *
 * Deterministic: a pure read of the barrel source.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';

export class InterfaceContractDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'interface-contract';

  async evaluate(input: DetectorInput): Promise<DetectorResult> {
    const cfg = input.assertion.detectorConfig ?? {};
    const rootDir = typeof cfg.rootDir === 'string' ? cfg.rootDir : null;
    const moduleDir = typeof cfg.moduleDir === 'string' ? cfg.moduleDir : null;
    const symbol = typeof cfg.symbol === 'string' ? cfg.symbol : null;
    if (!rootDir || !moduleDir || !symbol) {
      return {
        status: 'inconclusive',
        summary: 'detectorConfig requires rootDir, moduleDir, and symbol',
      };
    }
    const modulesDir = typeof cfg.modulesDir === 'string' ? cfg.modulesDir : 'src/modules';
    const barrelPath = join(
      rootDir.replace(/\/+$/, ''), modulesDir, moduleDir, 'index.ts',
    );

    let source: string;
    try {
      source = readFileSync(barrelPath, 'utf8');
    } catch {
      return {
        status: 'inconclusive',
        summary: `module barrel ${modulesDir}/${moduleDir}/index.ts is unreadable`,
      };
    }

    // The symbol must appear in an export statement (type or value export).
    const exportRe = new RegExp(
      `export\\s+(?:type\\s+)?(?:const|class|function|interface|type)?[^{;]*\\{[^}]*\\b${symbol}\\b`,
    );
    if (!exportRe.test(source)) {
      return {
        status: 'fail',
        summary: `the /${moduleDir} public barrel no longer exports ${symbol}`,
      };
    }
    return {
      status: 'pass',
      summary: `the /${moduleDir} public barrel exports ${symbol}`,
    };
  }
}
