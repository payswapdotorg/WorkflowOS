/**
 * WORK-051 — the schema/migration invariant detector
 * (`detectorKind: 'schema-migration'`).
 *
 * Evaluates the integrity of the PostgreSQL migration sequence: unique,
 * numeric, and (optionally) pinned to an expected latest number — the exact
 * revision binding for schema state (design §7 "schema/migration invariant
 * detector").
 *
 * detectorConfig:
 *   migrationsDir: string (required) — directory containing NNNN_*.sql files
 *   expectedLastMigrationNumber: number (optional) — when present, the
 *     highest migration number must equal exactly this value (a pinned
 *     expectation; drift in EITHER direction fails).
 *
 * Deterministic: violations are derived solely from the directory listing.
 */

import { readdirSync } from 'node:fs';
import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';

export class SchemaMigrationDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'schema-migration';

  async evaluate(input: DetectorInput): Promise<DetectorResult> {
    const cfg = input.assertion.detectorConfig ?? {};
    const migrationsDir = typeof cfg.migrationsDir === 'string' ? cfg.migrationsDir : null;
    if (!migrationsDir) {
      return {
        status: 'inconclusive',
        summary: 'detectorConfig.migrationsDir is missing — cannot evaluate schema invariants',
      };
    }

    let entries: string[];
    try {
      entries = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    } catch {
      return {
        status: 'inconclusive',
        summary: `migrations directory ${migrationsDir} is unreadable — cannot evaluate schema invariants`,
      };
    }

    const violations: string[] = [];
    const numbers: number[] = [];
    for (const entry of entries) {
      const m = /^(\d+)_.+\.sql$/.exec(entry);
      if (!m) {
        violations.push(`${entry}: migration filename does not match NNNN_name.sql`);
        continue;
      }
      numbers.push(Number(m[1]!));
    }

    // Duplicate numbers break the sequence.
    const seen = new Set<number>();
    for (const n of numbers.sort((a, b) => a - b)) {
      if (seen.has(n)) violations.push(`migration number ${n} is used more than once`);
      seen.add(n);
    }

    // Optional pinned expectation.
    const expected =
      typeof cfg.expectedLastMigrationNumber === 'number'
        ? cfg.expectedLastMigrationNumber
        : null;
    if (expected !== null) {
      const max = numbers.length > 0 ? Math.max(...numbers) : null;
      if (max !== expected) {
        violations.push(
          `latest migration is ${max ?? 'none'} but the architecture pins ${expected}`,
        );
      }
    }

    if (violations.length > 0) {
      return {
        status: 'fail',
        summary: `${violations.length} migration-sequence violation(s)`,
        details: { violations, migrationCount: entries.length },
      };
    }
    return {
      status: 'pass',
      summary: `migration sequence is valid (${entries.length} migrations${
        expected !== null ? `, latest pinned at ${expected}` : ''
      })`,
    };
  }
}
