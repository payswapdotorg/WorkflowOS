/**
 * WORK-041: AdvisoryDetector — detects dependency vulnerabilities + security
 * advisories by matching the project's package manifest (the `package_managers`
 * BaselineObservation) against a pluggable AdvisorySource.
 *
 * Detection logic:
 *   1. Resolve the baseline (input.baselineId if provided; otherwise
 *      projectBaselineRepository.listForProject(projectId) → latest by version).
 *   2. listObservations(baselineId) → find the `package_managers` observation.
 *   3. Parse its `claim` (the redacted package.json) → extract dependencies +
 *      devDependencies as { name: versionRange }.
 *   4. For each (name, range): extract the resolved version (strip ^/~/>=/> etc.),
 *      query advisorySource.queryAdvisories('npm', name, resolvedVersion).
 *   5. For each advisory: check satisfiesVersion(resolvedVersion, advisory.vulnerableRange).
 *   6. If vulnerable: produce a PlanningSignal (kind=dependency-observation,
 *      provenance=observed, evidence ref to advisory id, maintenance metadata
 *      with category=vulnerability, severity from advisory, advisoryId).
 *
 * HONEST SCOPE (V1):
 *   * NPM ONLY. The WORK-038 governed-filesystem-analyzer's CANDIDATE_READS
 *     allowlist covers package.json only (no requirements.txt / go.mod / Cargo.toml /
 *     Gemfile / pyproject.toml / pom.xml). Supporting other ecosystems requires
 *     extending the analyzer's allowlist (a WORK-038 change, NOT fabricated here).
 *   * The AdvisorySource is a PLUGGABLE interface. The InMemoryAdvisorySource is
 *     for tests. Production advisory ingestion (real OSV/GHSA adapter) is
 *     declared future work — the interface is the contract; a real adapter is a
 *     separate capability. The detector produces NO signals if no AdvisorySource
 *     is configured (honest — does NOT fabricate advisories).
 *   * The version resolution strips leading ^/~/>=/>, etc. + takes the numeric
 *     prefix. This is a best-effort match, NOT a full SemVer resolver. Pre-release
 *     tags are stripped. A full SemVer resolver is declared future work.
 *
 * The detector NEVER imports a security-advisory SDK directly, NEVER mutates the
 * baseline, NEVER calls GitHubAdapter. It reads
 * ProjectBaselineRepository.listObservations (read-only) + queries the
 * AdvisorySource (pluggable). The revision-bound baselineCommitSha is the
 * baseline's baselineCommitSha (the commit the manifest was observed at).
 */

import type {
  AdvisoryEcosystem,
  MaintenanceContext,
  MaintenanceDetectInput,
} from '../../maintenance.types.js';
import type {
  PlanningSignal,
  MaintenanceSignalMetadata,
} from '@development-planner/index.js';
import type { MaintenanceDetector } from '../../maintenance.types.js';
import { satisfiesVersion } from '../advisory-source.js';

/**
 * Extract a "resolved version" from a package.json version range by stripping
 * leading ^/~/>=/>, <=, <, =, * + taking the numeric prefix. HONEST LIMITATION:
 * this is NOT a full SemVer resolver — it does NOT resolve ranges to the latest
 * matching version, does NOT handle `||`/`-`/`x`/`*` wildcards, + strips
 * pre-release tags. A full resolver is declared future work.
 */
function extractResolvedVersion(range: string): string {
  let v = range.trim();
  // Strip leading range operators.
  v = v.replace(/^[~^>=<]*\s*/, '');
  // Strip pre-release + build tags.
  v = (v.split('-')[0] ?? '').split('+')[0] ?? '';
  return v;
}

export class AdvisoryDetector implements MaintenanceDetector {
  readonly name = 'advisory-detector';

  async detect(
    input: MaintenanceDetectInput,
    ctx: MaintenanceContext,
  ): Promise<readonly PlanningSignal[]> {
    const signals: PlanningSignal[] = [];
    if (!ctx.advisorySource) {
      // No advisory source configured — produce NO signals (honest; do NOT fabricate).
      return signals;
    }
    // Resolve the baseline.
    let baselineId = input.baselineId;
    let baselineCommitSha = input.baselineCommitSha;
    if (!baselineId) {
      const baselines = await ctx.projectBaselineRepository.listForProject(
        input.projectId,
      );
      if (baselines.length === 0) return signals;
      // Pick the latest by version (fall back to createdAt if version is equal).
      const sorted = [...baselines].sort((a, b) => {
        if (a.version !== b.version) return b.version - a.version;
        const aT = a.createdAt?.getTime() ?? 0;
        const bT = b.createdAt?.getTime() ?? 0;
        return bT - aT;
      });
      const latest = sorted[0]!; // baselines.length > 0 checked above; safe.
      baselineId = latest.id;
      baselineCommitSha = baselineCommitSha ?? latest.baselineCommitSha;
    }
    // Read the package_managers observation.
    const observations =
      await ctx.projectBaselineRepository.listObservations(baselineId);
    const pkgManagers = observations.find((o) => o.kind === 'package_managers');
    if (!pkgManagers) return signals;
    // Parse the claim (the redacted package.json). Extract dependencies + devDependencies.
    const claim = pkgManagers.claim as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(claim.dependencies ?? {}), ...(claim.devDependencies ?? {}) };
    const ecosystem: AdvisoryEcosystem = 'npm';
    // For each dependency, query the advisory source + match.
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== 'string') continue;
      const resolvedVersion = extractResolvedVersion(range);
      if (!resolvedVersion) continue;
      const advisories = await ctx.advisorySource.queryAdvisories(
        ecosystem,
        name,
        resolvedVersion,
      );
      for (const advisory of advisories) {
        if (satisfiesVersion(resolvedVersion, advisory.vulnerableRange)) {
          // Vulnerable. Produce a signal.
          const fixedNote = advisory.fixedVersion
            ? ` (fixed in ${advisory.fixedVersion})`
            : '';
          const canonicalGoal = `Upgrade dependency ${name} from ${resolvedVersion} to resolve ${advisory.advisoryId}${fixedNote}`;
          const maintenance: MaintenanceSignalMetadata = {
            category: 'vulnerability',
            severity: advisory.severity,
            advisoryId: advisory.advisoryId,
            affectedCount: 1,
            detectorSource: this.name,
          };
          signals.push({
            kind: 'dependency-observation',
            canonicalGoal,
            provenance: 'observed',
            evidenceRefs: [
              {
                kind: 'advisory-evidence',
                ref: advisory.advisoryId,
                detail: `${advisory.summary ?? advisory.advisoryId}; vulnerable range: ${advisory.vulnerableRange}; severity: ${advisory.severity}${fixedNote}`,
              },
            ],
            baselineCommitSha,
            maintenance,
          });
        }
      }
    }
    return signals;
  }
}
