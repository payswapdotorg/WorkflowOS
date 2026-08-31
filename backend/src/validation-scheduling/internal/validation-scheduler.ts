/**
 * WORK-066 — the default ValidationScheduler: the scheduling/trigger DECISION
 * layer (the composition root constructs it and exposes it on AppDeps).
 *
 * The control flow (the intended architecture — the scheduler DECIDES, the
 * existing authorities GOVERN):
 *
 *   trigger event (from an existing authority surface)
 *     → WORK-066: classification + eligibility + assurance-aware selection
 *       + dedup claim + deterministic identity
 *     → WORK-064: admission (admitRun — THE validation gate)
 *     → the admitted ValidationRun IS the scheduled validation
 *     → (browser execution is WORK-065's separate boundary — the scheduler
 *        imports NOTHING from the browser domain and executes nothing)
 *
 * The scheduler NEVER:
 *   - re-implements the WORK-064 admission/policy/identity logic (it calls
 *     the service through its public barrel);
 *   - transitions Work Items, creates PRs, or merges (the /workflows +
 *     /github authorities own those);
 *   - evaluates validation health (WORK-064 owns outcome semantics);
 *   - creates verification evidence (/verification owns evidence);
 *   - touches a browser (WORK-065 owns execution);
 *   - runs timers/loops/queues (CONTINUOUS runs happen only under explicit
 *     configuration, invoked by an explicit scheduling request).
 *
 * Determinism: the clock is INJECTED (deps.now — required, no default) and
 * the identities/run ids are derived by pure sha256 (no randomness). For
 * identical (project, journey, environment, revision, trigger, schedule
 * state, clock) the decision is byte-identical.
 *
 * Idempotency: the claim-store PORT is the dedup boundary — actor A and
 * actor B concurrently scheduling the same logical event produce ONE logical
 * scheduled validation (the loser receives the typed duplicate echo).
 */
import type {
  JourneySchedulingDecision,
  ModeLegDecision,
  ScheduleValidationTriggerInput,
  SchedulingDecisionResult,
  ScheduledTriggerClaim,
  ScheduledTriggerDecisionRecord,
  ValidationScheduler,
  ValidationSchedulerDeps,
  ValidationTrigger,
  AssuranceProfile,
  SchedulingOutcome,
} from '../types.js';
import { ValidationSchedulingError } from '../types.js';
import { deriveSchedulingIdentity } from './scheduling-identity.js';
import { classifyTrigger } from './trigger-classification.js';
import { requireAssuranceProfile, requireJourneyRegistry, selectJourneysForTrigger } from './assurance-selection.js';

/** The default scheduler implementation (pure composition of the decision layer over the WORK-064 authority). */
export class DefaultValidationScheduler implements ValidationScheduler {
  constructor(private readonly deps: ValidationSchedulerDeps) {}

  async scheduleValidationTrigger(input: ScheduleValidationTriggerInput): Promise<SchedulingDecisionResult> {
    const now = input.now ?? this.deps.now;
    const evaluatedAt = now().toISOString();
    try {
      return await this.decide(input, now, evaluatedAt);
    } catch (error) {
      if (error instanceof ValidationSchedulingError) {
        // Typed eligibility failure — an explicit scheduling outcome, NEVER a
        // healthy validation.
        this.deps.logger.warn('validation-scheduling.rejected', { code: error.code, reason: error.message });
        return {
          outcome: 'rejected',
          code: error.code,
          reason: error.message,
          // The trigger/project echo (best effort — the vocabulary checks may
          // have failed before these were known-valid).
          trigger: (typeof input.trigger === 'string' ? input.trigger : 'UNKNOWN') as ValidationTrigger,
          projectId: typeof input.projectId === 'string' ? input.projectId : '',
          assurance: (typeof input.assurance === 'string' ? input.assurance : 'UNKNOWN') as AssuranceProfile,
          legs: [],
          evaluatedAt,
        };
      }
      throw error;
    }
  }

  async findSchedulingDecision(schedulingId: string): Promise<ScheduledTriggerClaim | null> {
    return this.deps.claimStore.find(schedulingId);
  }

  private async decide(
    input: ScheduleValidationTriggerInput,
    now: () => Date,
    evaluatedAt: string,
  ): Promise<SchedulingDecisionResult> {
    // 1. Validate the assurance profile + the journey registry (fail closed).
    const assurance = requireAssuranceProfile(input.assurance);
    requireJourneyRegistry(input.journeys);

    // 2. Classify the trigger + resolve the mode legs (the closed vocabulary
    //    + the normative TRIGGER_MODE_BINDING; every required authority
    //    binding fails closed when absent).
    const classification = classifyTrigger(input, now);

    // 3. Per-leg: the assurance-aware journey selection → identity → claim →
    //    WORK-064 admission.
    const legDecisions: ModeLegDecision[] = [];
    let anyConflict = false;
    let anyAdmissionRejected = false;
    let attempted = 0;
    let duplicates = 0;
    let admittedCount = 0;

    for (const leg of classification.legs) {
      const selection = selectJourneysForTrigger({
        ...input,
        assurance,
        mode: leg.mode,
      });
      const selectedJourneys = selection.filter((s) => s.selected);
      if (selectedJourneys.length === 0) {
        // The leg is SKIPPED with an explicit reason (recorded — never
        // silent). All legs skipped → the request is rejected below.
        legDecisions.push({
          mode: leg.mode,
          environmentId: leg.environment.id,
          reference: leg.reference,
          scheduled: false,
          legSkipReason: `no journey is eligible for ${assurance} × ${leg.mode} (the profile × mode allowance selects nothing among the declared journeys)`,
          journeys: selection.map((s) => this.notAttemptedDecision(s.journey.id, s.journey.name, s.selectionReason)),
        });
        continue;
      }

      const journeyDecisions: JourneySchedulingDecision[] = [];
      for (const s of selection) {
        if (!s.selected) {
          journeyDecisions.push(this.notAttemptedDecision(s.journey.id, s.journey.name, s.selectionReason));
          continue;
        }
        attempted += 1;

        // The deterministic scheduling identity (the logical event's
        // identity for this leg × journey).
        const identity = deriveSchedulingIdentity({
          trigger: classification.trigger,
          projectId: input.projectId,
          journeyId: s.journey.id,
          environmentId: leg.environment.id,
          mode: leg.mode,
          reference: leg.reference,
          assurance,
        });

        // The dedup claim (the idempotency boundary).
        const claim = await this.deps.claimStore.claim({
          schedulingId: identity.schedulingId,
          contentFingerprint: identity.contentFingerprint,
        });
        if (claim.status === 'duplicate') {
          duplicates += 1;
          journeyDecisions.push({
            journeyId: s.journey.id,
            journeyName: s.journey.name,
            selected: true,
            selectionReason: s.selectionReason,
            schedulingId: identity.schedulingId,
            contentFingerprint: identity.contentFingerprint,
            // The run that EXISTS is the original decision's run (the
            // idempotent echo — never a fabricated new one):
            runId: claim.original?.decision?.runId ?? null,
            outcome: 'duplicate',
            admission: null,
            originalDecision: claim.original?.decision ?? null,
          });
          continue;
        }
        if (claim.status === 'conflict') {
          anyConflict = true;
          this.deps.logger.warn('validation-scheduling.conflict', {
            schedulingId: identity.schedulingId,
          });
          journeyDecisions.push({
            journeyId: s.journey.id,
            journeyName: s.journey.name,
            selected: true,
            selectionReason: s.selectionReason,
            schedulingId: identity.schedulingId,
            contentFingerprint: identity.contentFingerprint,
            runId: identity.runId,
            outcome: 'conflict',
            admission: null,
            originalDecision: claim.original?.decision ?? null,
          });
          continue;
        }

        // 'claimed' — this actor owns the scheduling decision. Request
        // admission through the WORK-064 authority (THE gate — the scheduler
        // never admits, finalizes, or evaluates anything itself).
        let admission: { admitted: boolean; code: string; reason: string };
        try {
          const decision = await this.deps.continuousValidationService.admitRun({
            journey: s.journey,
            identitySource: input.identitySource,
            environment: leg.environment,
            mode: leg.mode,
            trigger: classification.trigger,
            releaseRef: leg.releaseRef,
            continuousConfigured: leg.continuousConfigured,
            runId: identity.runId,
            now,
          });
          admission = {
            admitted: decision.admitted,
            code: decision.code,
            reason: decision.reason,
          };
        } catch (error) {
          // The admission service itself failed (dependency unavailable) —
          // release the incomplete claim (the re-drive retries) and surface
          // the typed scheduling failure.
          await this.deps.claimStore.release(identity.schedulingId);
          const reason = error instanceof Error ? error.message : 'the WORK-064 admission service failed';
          this.deps.logger.warn('validation-scheduling.dependency-unavailable', {
            schedulingId: identity.schedulingId,
            reason,
          });
          throw new ValidationSchedulingError(
            'SCHEDULING_DEPENDENCY_UNAVAILABLE',
            `the WORK-064 admission dependency is unavailable for journey ${s.journey.id}: ${reason}`,
          );
        }

        // Record the decision with the claim (the resumable linkage:
        // trigger → project → journey → environment → reference → decision → run).
        const record: ScheduledTriggerDecisionRecord = {
          outcome: admission.admitted ? 'scheduled' : 'rejected',
          code: admission.code,
          reason: admission.reason,
          trigger: classification.trigger,
          projectId: input.projectId,
          journeyId: s.journey.id,
          environmentId: leg.environment.id,
          mode: leg.mode,
          reference: leg.reference,
          // The run id is recorded ONLY when the run EXISTS (an admission
          // rejection leaves no run — never a fabricated id):
          runId: admission.admitted ? identity.runId : null,
          admitted: admission.admitted,
        };
        await this.deps.claimStore.record(identity.schedulingId, record);

        if (admission.admitted) {
          admittedCount += 1;
          this.deps.logger.info('validation-scheduling.scheduled', {
            schedulingId: identity.schedulingId,
            runId: identity.runId,
            journeyId: s.journey.id,
            mode: leg.mode,
          });
        } else {
          anyAdmissionRejected = true;
        }
        journeyDecisions.push({
          journeyId: s.journey.id,
          journeyName: s.journey.name,
          selected: true,
          selectionReason: s.selectionReason,
          schedulingId: identity.schedulingId,
          contentFingerprint: identity.contentFingerprint,
          runId: admission.admitted ? identity.runId : null,
          outcome: admission.admitted ? 'scheduled' : 'admission_rejected',
          admission,
          originalDecision: null,
        });
      }

      legDecisions.push({
        mode: leg.mode,
        environmentId: leg.environment.id,
        reference: leg.reference,
        scheduled: journeyDecisions.some((d) => d.outcome === 'scheduled'),
        legSkipReason: null,
        journeys: journeyDecisions,
      });
    }

    // 4. The top-level outcome (explicit — never silent, never
    // healthy-by-default). The dominance rule: a conflict is surfaced even
    // when other journeys scheduled (fail-closed anomaly); admission
    // rejections dominate duplicates (the rejection is the actionable
    // signal — the per-journey details carry both).
    const outcome: SchedulingOutcome = anyConflict
      ? 'conflict'
      : admittedCount > 0
        ? 'scheduled'
        : anyAdmissionRejected
          ? 'rejected'
          : duplicates > 0
            ? 'duplicate'
            : 'rejected';
    if (attempted === 0) {
      // Every leg was skipped: the explicit no-eligible-journeys rejection.
      return {
        outcome: 'rejected',
        code: 'SCHEDULING_NO_ELIGIBLE_JOURNEYS',
        reason: `no journey is eligible for trigger ${classification.trigger} at ${assurance} assurance (every mode leg selected nothing — the scheduling decision is recorded, nothing was silently skipped)`,
        trigger: classification.trigger,
        projectId: input.projectId,
        assurance,
        legs: legDecisions,
        evaluatedAt,
      };
    }
    const code =
      outcome === 'conflict'
        ? 'SCHEDULING_CONFLICT'
        : outcome === 'scheduled'
          ? 'SCHEDULED'
          : outcome === 'duplicate'
            ? 'DUPLICATE_SUPPRESSED'
            : 'SCHEDULING_ADMISSION_REJECTED';
    const reason =
      outcome === 'conflict'
        ? 'the same scheduling identity was presented with different logical content (the same logical event cannot warrant two different classifications)'
        : outcome === 'scheduled'
          ? `${admittedCount} validation run(s) admitted through the WORK-064 gate for trigger ${classification.trigger} (${duplicates} duplicate(s) suppressed)`
          : outcome === 'duplicate'
            ? `the logical trigger event was already scheduled (all ${duplicates} scheduling unit(s) are duplicates — the original linkage is echoed)`
            : 'the WORK-064 admission gate rejected every selected journey (the per-journey admission codes are recorded)';
    return {
      outcome,
      code,
      reason,
      trigger: classification.trigger,
      projectId: input.projectId,
      assurance,
      legs: legDecisions,
      evaluatedAt,
    };
  }

  private notAttemptedDecision(journeyId: string, journeyName: string, reason: string): JourneySchedulingDecision {
    return {
      journeyId,
      journeyName,
      selected: false,
      selectionReason: reason,
      schedulingId: null,
      contentFingerprint: null,
      runId: null,
      outcome: 'not_attempted',
      admission: null,
      originalDecision: null,
    };
  }
}
