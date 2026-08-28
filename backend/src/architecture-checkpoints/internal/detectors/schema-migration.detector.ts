/**
 * WORK-051 — the schema/migration invariant detector
 * (`detectorKind: 'schema-migration'`).
 *
 * Evaluates the integrity of the PostgreSQL migration sequence AT THE BOUND
 * REVISION: unique, numeric, and (optionally) pinned to an expected latest
 * number — the exact revision binding for schema state (design §7
 * "schema/migration invariant detector").
 *
 * detectorConfig:
 *   migrationsDir: string (required) — repository-relative directory
 *     containing NNNN_*.sql files. Must EXIST at the bound revision —
 *     otherwise the result is inconclusive (fail closed; a missing
 *     migrations directory is never "zero migrations ⇒ vacuous pass").
 *   expectedLastMigrationNumber: number (optional) — when present, the
 *     highest migration number must equal exactly this value (a pinned
 *     expectation; drift in EITHER direction fails).
 *
 * Deterministic: violations are derived solely from the revision-bound
 * snapshot directory listing (PR #52 round 1, BLOCKER 1).
 */

import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';
import { listRequiredDir, snapshotFailureMessage } from './snapshot-tree.js';

export class SchemaMigrationDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'schema-migration';

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
    const migrationsDir = typeof cfg.migrationsDir === 'string' ? cfg.migrationsDir : null;
    if (!migrationsDir) {
      return {
        status: 'inconclusive',
        summary: 'detectorConfig.migrationsDir is missing — cannot evaluate schema invariants',
      };
    }

    let entries: readonly string[];
    try {
      const listing = await listRequiredDir(snapshot, migrationsDir);
      entries = listing
        .filter((e) => e.type === 'file' && e.name.endsWith('.sql'))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      return {
        status: 'inconclusive',
        summary:
          `the governed tree could not be inspected — ${snapshotFailureMessage(err, migrationsDir, snapshot.revision)}`,
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
      summary: `migration sequence is valid at revision ${snapshot.revision} (${entries.length} migrations${
        expected !== null ? `, latest pinned at ${expected}` : ''
      })`,
    };
  }
}
