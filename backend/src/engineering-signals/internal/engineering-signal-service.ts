/**
 * WORK-067 — the default EngineeringSignalService: the ADVISORY
 * correlation layer (the composition root constructs it and exposes it on
 * AppDeps).
 *
 * The canonical flow (spec/work-orders/WORK-067.md):
 *
 *   raw observation
 *     → normalize + preserve provenance (the TEMPORARY seam)
 *     → Engineering Signal (typed, provenance-preserving)
 *     → deduplicate (the keyed identity convergence)
 *     → correlate to release(s) (the RECORDED release contexts)
 *     → assess likely regression (ADVISORY)
 *     → the signal remains ADVISORY — future governed consumers (WORK-068
 *       feedback conversion, WORK-070 architecture fitness) decide what
 *       happens next through THEIR authorities.
 *
 * The service NEVER:
 *   - creates verification evidence/runs/verdicts (/verification owns them);
 *   - transitions Work Items or workflow state (/work-items + /workflows);
 *   - mutates architecture or review state;
 *   - modifies code;
 *   - schedules or executes validations (WORK-066/WORK-065);
 *   - discards or softens a failure (no-silent-healthy — a failure ALWAYS
 *     becomes a recorded occurrence; an unavailable assessment is NULL,
 *     never a false healthy).
 *
 * Determinism: the clock is INJECTED (deps.now — required, no implicit
 * global time); observation times are RECORDED source values; identities
 * and occurrence ids are pure sha256 derivations (no randomness).
 *
 * Idempotency: the repository PORT is the dedup boundary — the same
 * logical observation re-delivered is `duplicate-suppressed` (nothing
 * appended); the same logical failure at a new time/source is
 * `occurrence-appended` to the ONE signal.
 */
import type { ContinuousValidationService } from '../../continuous-validation/index.js';
import type { Logger } from '@platform/logger.js';
import { EngineeringSignalError } from '../types.js';
import type {
  CorrelateReleaseInput,
  EngineeringSignal,
  EngineeringSignalRepository,
  EngineeringSignalService,
  IngestObservationResult,
  IngestValidationRunInput,
  IngestValidationRunResult,
  RawObservationInput,
} from '../types.js';
import { normalizeObservation } from './observation-normalization.js';
import { deriveSignalIdentity, compareOccurrences } from './signal-identity.js';
import { correlateSignalToReleases } from './release-correlation.js';
import { assessRegression, deriveSignalTimelineAttributes } from './regression-assessment.js';
import { validationRunToObservationInputs } from './validation-source-adapter.js';

/** The service dependencies (all supplied by existing modules/composition). */
export interface EngineeringSignalServiceDeps {
  /** The signal persistence port (the in-memory adapter in this Work Order). */
  readonly signalRepository: EngineeringSignalRepository;
  /**
   * The EXISTING WORK-064 continuous-validation authority — CONSUMED (never
   * duplicated) for validation-run ingestion. Required in the real
   * composition; a pure unit composition may omit it, in which case
   * `ingestValidationRun` fails closed (the typed dependency-unavailable
   * rejection — never a silent no-op).
   */
  readonly continuousValidationService?: ContinuousValidationService;
  /** Observability only — never authority. */
  readonly logger?: Logger;
  /** The REQUIRED injected clock (no implicit global time in the domain path). */
  readonly now: () => Date;
}

/** The default service implementation (pure composition of the correlation layer). */
export class DefaultEngineeringSignalService implements EngineeringSignalService {
  constructor(private readonly deps: EngineeringSignalServiceDeps) {}

  async ingestObservation(input: RawObservationInput): Promise<IngestObservationResult> {
    const now = input.now ?? this.deps.now;
    // 1. The deterministic logical identity (the dedup key — scope +
    //    classification; fail-closed validation inside the derivation).
    const identity = deriveSignalIdentity({
      tenantId: input.tenantId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      logicalFailureKey: input.logicalFailureKey,
    });
    // 2. The provenance-preserving normalization (fail-closed on the closed
    //    vocabularies, the recorded time, the reference, the raw payload).
    const occurrence = normalizeObservation(input, identity, now);

    // 3. The dedup convergence at the persistence boundary.
    const existing = await this.deps.signalRepository.findByIdentityFingerprint(identity.identityFingerprint);
    if (existing === null) {
      const timestamp = now().toISOString();
      const signal: EngineeringSignal = {
        signalId: identity.signalId,
        identityFingerprint: identity.identityFingerprint,
        tenantId: input.tenantId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        logicalFailureKey: input.logicalFailureKey,
        sources: [occurrence.source],
        occurrences: [occurrence],
        firstObservedAt: occurrence.observedAt,
        lastObservedAt: occurrence.observedAt,
        latestSeverity: occurrence.severity,
        releaseCorrelation: [],
        regression: {
          status: 'unavailable',
          reason:
            'release correlation has not been performed for this signal yet (no release context supplied — the assessment is explicitly unavailable, never a silent healthy)',
          perRelease: [],
          likelyRegression: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const stored = await this.deps.signalRepository.save(signal);
      this.deps.logger?.info('engineering-signals.created', {
        signalId: stored.signalId,
        source: occurrence.source,
        projectId: stored.projectId,
      });
      return { outcome: 'signal-created', signal: stored, occurrenceId: occurrence.occurrenceId };
    }

    // The exact same observation re-delivered → idempotent suppression.
    const duplicate = existing.occurrences.some((o) => o.occurrenceId === occurrence.occurrenceId);
    if (duplicate) {
      this.deps.logger?.info('engineering-signals.duplicate-suppressed', {
        signalId: existing.signalId,
        occurrenceId: occurrence.occurrenceId,
      });
      return { outcome: 'duplicate-suppressed', signal: existing, occurrenceId: occurrence.occurrenceId };
    }

    // A new observation of the SAME logical failure → append + converge.
    const occurrences = [...existing.occurrences, occurrence].sort(compareOccurrences);
    const attributes = deriveSignalTimelineAttributes(occurrences);
    const updated: EngineeringSignal = {
      ...existing,
      occurrences,
      ...attributes,
      // The correlation/assessment state is intentionally NOT recomputed
      // here (no hidden side effects): correlateToReleases is the explicit
      // re-computation point (re-runnable, deterministic).
      updatedAt: now().toISOString(),
    };
    const stored = await this.deps.signalRepository.save(updated);
    this.deps.logger?.info('engineering-signals.occurrence-appended', {
      signalId: stored.signalId,
      occurrenceId: occurrence.occurrenceId,
      occurrences: occurrences.length,
    });
    return { outcome: 'occurrence-appended', signal: stored, occurrenceId: occurrence.occurrenceId };
  }

  async ingestValidationRun(input: IngestValidationRunInput): Promise<IngestValidationRunResult> {
    const authority = this.deps.continuousValidationService;
    if (authority === undefined) {
      throw new EngineeringSignalError(
        'SIGNAL_DEPENDENCY_UNAVAILABLE',
        'the WORK-064 continuous-validation authority is not bound to this service (validation-run ingestion fails closed — never a silent no-op)',
      );
    }
    const run = await authority.findRun(input.runId);
    if (run === null) {
      throw new EngineeringSignalError(
        'SIGNAL_VALIDATION_RUN_NOT_FOUND',
        `validation run '${input.runId}' was not found in the WORK-064 authority (never a fabricated run)`,
      );
    }
    // The deterministic adapter (fail-closed on un-completed runs and
    // scope mismatches; a healthy run yields NO observations — the honest
    // no-signal case; every failure yields one observation).
    const observations = validationRunToObservationInputs(run, {
      projectId: input.projectId,
      tenantId: input.tenantId,
    });
    const results: IngestObservationResult[] = [];
    for (const observation of observations) {
      results.push(await this.ingestObservation({ ...observation, now: input.now }));
    }
    return { results, run };
  }

  async correlateToReleases(input: CorrelateReleaseInput): Promise<EngineeringSignal> {
    const now = input.now ?? this.deps.now;
    const signal = await this.deps.signalRepository.findById(input.signalId);
    if (signal === null) {
      throw new EngineeringSignalError('SIGNAL_NOT_FOUND', `signal '${input.signalId}' was not found (never a fabricated signal)`);
    }
    // The deterministic correlation + advisory assessment (fail-closed on
    // invalid contexts; explicit typed entries for every decision).
    const entries = correlateSignalToReleases(signal, input.releaseContexts);
    const regression = assessRegression(signal, entries);
    const updated: EngineeringSignal = {
      ...signal,
      releaseCorrelation: entries,
      regression,
      updatedAt: now().toISOString(),
    };
    const stored = await this.deps.signalRepository.save(updated);
    this.deps.logger?.info('engineering-signals.correlated', {
      signalId: stored.signalId,
      contexts: input.releaseContexts.length,
      correlated: entries.filter((e) => e.correlated).length,
      likelyRegression: regression.likelyRegression,
    });
    return stored;
  }

  async findSignal(signalId: string): Promise<EngineeringSignal | null> {
    return this.deps.signalRepository.findById(signalId);
  }

  async listSignalsForProject(projectId: string): Promise<readonly EngineeringSignal[]> {
    return this.deps.signalRepository.listByProject(projectId);
  }
}
