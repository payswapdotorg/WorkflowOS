/**
 * WORK-041: ArchitectureDriftDetector — detects architecture drift by comparing
 * ArchitectureVersion.digestSha256 across versions of the same architecture.
 *
 * Detection logic:
 *   1. architectureRepository.findByProject(projectId) → all architectures.
 *   2. For each architecture, architectureVersionRepository.findByArchitecture(id)
 *      → all versions, sorted by versionNumber.
 *   3. If >= 2 versions exist, compare the latest version's digestSha256 vs the
 *      previous version's digestSha256.
 *   4. Same digest → no drift (skip).
 *   5. Different digest (or one is null) → drift. Produce a PlanningSignal
 *      (kind=architecture-observation, provenance=inferred, evidence refs to
 *      both version ids, maintenance metadata with category=architecture-drift).
 *
 * HONEST SCOPE: this detector surfaces drift via digest comparison ONLY. A
 * structured per-component/boundary diff (which boundary changed, what was
 * added/removed) is GREENFIELD — the ArchitectureVersionRepository has no
 * diffVersions method today. The detector records the two version ids as
 * evidence so a human can inspect the diff manually. The detector does NOT
 * fabricate a structured diff.
 *
 * The detector NEVER auto-freezes versions, NEVER creates versions, NEVER
 * mutates architecture state. It reads ArchitectureVersionRepository +
 * ArchitectureRepository (read-only).
 */

import type {
  MaintenanceContext,
  MaintenanceDetectInput,
} from '../../maintenance.types.js';
import type {
  PlanningSignal,
  MaintenanceSignalMetadata,
} from '@development-planner/index.js';
import type { MaintenanceDetector } from '../../maintenance.types.js';

export class ArchitectureDriftDetector implements MaintenanceDetector {
  readonly name = 'architecture-drift-detector';

  async detect(
    input: MaintenanceDetectInput,
    ctx: MaintenanceContext,
  ): Promise<readonly PlanningSignal[]> {
    const signals: PlanningSignal[] = [];
    const architectures = await ctx.architectureRepository.findByProject(
      input.projectId,
    );
    if (architectures.length === 0) return signals;

    for (const arch of architectures) {
      const versions =
        await ctx.architectureVersionRepository.findByArchitecture(arch.id);
      if (versions.length < 2) continue; // need >= 2 versions to compare
      // Sort by versionNumber ascending (the repository may return them in any order).
      const sorted = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);
      const latest = sorted[sorted.length - 1]!; // length >= 2 checked above; safe.
      const previous = sorted[sorted.length - 2]!; // safe.
      // Same digest → no drift. Different digest (or null) → drift.
      const latestDigest = latest.digestSha256;
      const prevDigest = previous.digestSha256;
      if (
        latestDigest &&
        prevDigest &&
        latestDigest === prevDigest
      ) {
        continue; // no drift
      }
      // Drift detected. Produce a signal.
      const canonicalGoal = `Investigate architecture drift on "${arch.name}" (version ${previous.versionNumber} → ${latest.versionNumber})`;
      const maintenance: MaintenanceSignalMetadata = {
        category: 'architecture-drift',
        severity: 'medium',
        detectorSource: this.name,
      };
      signals.push({
        kind: 'architecture-observation',
        canonicalGoal,
        provenance: 'inferred',
        evidenceRefs: [
          {
            kind: 'architecture-observation',
            ref: latest.id,
            detail: `latest version ${latest.versionNumber} (digest: ${latestDigest ?? 'null'})`,
          },
          {
            kind: 'architecture-observation',
            ref: previous.id,
            detail: `previous version ${previous.versionNumber} (digest: ${prevDigest ?? 'null'})`,
          },
        ],
        maintenance,
      });
    }
    return signals;
  }
}
