/**
 * WORK-041: InMemoryAdvisorySource — a test/seeded implementation of the
 * AdvisorySource interface. It holds a fixed set of AdvisoryRecords in memory +
 * answers queryAdvisories by filtering on (ecosystem, packageName).
 *
 * This is the ONLY concrete AdvisorySource in V1. Production advisory ingestion
 * (real OSV/GHSA adapters) is declared future work — the AdvisorySource
 * interface is the contract; a real adapter is a separate capability. The
 * maintenance capability NEVER imports a security-advisory SDK directly.
 *
 * Honest scope: the InMemoryAdvisorySource is for tests + a minimal
 * demonstration of the detection pipeline. A real adapter would query
 * osv.dev / GitHub Security Advisories API at runtime; that is GREENFIELD
 * (no advisory surface exists in the codebase today) + is NOT fabricated here.
 */

import type {
  AdvisoryEcosystem,
  AdvisoryRecord,
  AdvisorySource,
} from '../maintenance.types.js';

/**
 * Minimal SemVer-ish version comparison. Parses "major.minor.patch" (ignoring
 * pre-release tags for simplicity — the advisory detector is a best-effort
 * matcher, NOT a full SemVer implementation). Returns -1 / 0 / 1.
 *
 * HONEST LIMITATION: this handles numeric "major.minor.patch" only. Pre-release
 * tags (e.g. "4.17.21-beta.1") are stripped before comparison. A full SemVer
 * implementation is a declared future-work item; V1 uses this simple comparator
 * because the InMemoryAdvisorySource test data uses simple numeric versions.
 */
export function compareVersions(a: string, b: string): number {
  const parseVer = (v: string): [number, number, number] => {
    const core = v.split('-')[0]?.split('+')[0] ?? '0';
    const raw = core.split('.').map((p) => {
      const n = parseInt(p, 10);
      return Number.isNaN(n) ? 0 : n;
    });
    const major = raw[0] ?? 0;
    const minor = raw[1] ?? 0;
    const patch = raw[2] ?? 0;
    return [major, minor, patch];
  };
  const pa = parseVer(a);
  const pb = parseVer(b);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i]!; // tuple index 0-2 is safe (length 3).
    const bi = pb[i]!;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

/**
 * Minimal SemVer range satisfaction check. Supports the operators
 * <, <=, >, >=, = (and bare version = exact). Compound ranges (e.g.
 * ">=2.0.0 <3.0.0") are AND-ed. HONEST LIMITATION: does NOT support `~`, `^`,
 * `||`, or pre-release tags. The InMemoryAdvisorySource test data uses simple
 * ranges this checker handles correctly.
 */
export function satisfiesVersion(version: string, range: string): boolean {
  const parts = range.trim().split(/\s+/);
  for (const part of parts) {
    const m = part.match(/^(<=|>=|<|>|=)?(.+)$/);
    if (!m) continue;
    const op = m[1] ?? '=';
    const target = m[2] ?? '0';
    const cmp = compareVersions(version, target);
    let ok = false;
    switch (op) {
      case '<':
        ok = cmp < 0;
        break;
      case '<=':
        ok = cmp <= 0;
        break;
      case '>':
        ok = cmp > 0;
        break;
      case '>=':
        ok = cmp >= 0;
        break;
      case '=':
        ok = cmp === 0;
        break;
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * An in-memory AdvisorySource seeded with a fixed set of AdvisoryRecords.
 * Used by tests + the AdvisoryDetector when no production advisory adapter is
 * configured. The sourceName is 'in-memory' so the detector can record it in
 * metadata.planner.maintenance.detectorSource honestly.
 */
export class InMemoryAdvisorySource implements AdvisorySource {
  readonly sourceName = 'in-memory';
  private readonly records: readonly AdvisoryRecord[];

  constructor(records: readonly AdvisoryRecord[]) {
    this.records = records;
  }

  async queryAdvisories(
    ecosystem: AdvisoryEcosystem,
    packageName: string,
    _version: string,
  ): Promise<readonly AdvisoryRecord[]> {
    // Return ALL advisories for (ecosystem, packageName) — the AdvisoryDetector
    // applies satisfiesVersion(version, record.vulnerableRange) to decide which
    // apply to the resolved version. This mirrors how a real adapter (OSV/GHSA)
    // would return all advisories for a package + let the caller match.
    return this.records.filter(
      (r) => r.ecosystem === ecosystem && r.packageName === packageName,
    );
  }
}
