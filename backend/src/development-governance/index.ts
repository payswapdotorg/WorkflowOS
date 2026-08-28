/**
 * WORK-052 — Development Governance & Self-Hosting Control Plane (public barrel).
 *
 * The application-layer control plane over the repository-resident development
 * state (`spec/development-state/`). It is a PURE, QUERY-ONLY consumer:
 *
 *   - no SQL / no database / no new tables (ADR-0001);
 *   - no mutation ports over any frozen authority (W052-AC08);
 *   - no workflow states, no second engines of any kind;
 *   - validation is fail-closed and shared with the checkpoint substrate
 *     through the architecture-checkpoints barrel (ADR-0004).
 *
 * Run `bun run governance:status` from `backend/` for the control-plane summary.
 */

export * from './types.js';

export {
  FileSystemGovernanceStateLoader,
  DEFAULT_GOVERNANCE_DIR,
  GOVERNANCE_MODEL_FILE,
  GOVERNANCE_PROGRAM_FILE,
} from './internal/governance-state-loader.js';
export type {
  LoadedGovernanceState,
  FileSystemGovernanceStateLoaderOptions,
} from './internal/governance-state-loader.js';

export { DefaultDevelopmentGovernanceService } from './internal/default-development-governance-service.js';
export type { DefaultDevelopmentGovernanceServiceDeps } from './internal/default-development-governance-service.js';

export {
  auditMergedFinalization,
  collectMergeEvidenceFromLines,
  collectMergeEvidenceFromRepository,
  MergeEvidenceUnavailableError,
} from './internal/merged-finalization.js';
export type {
  MergeEvidence,
  MergedFinalizationAudit,
} from './internal/merged-finalization.js';
