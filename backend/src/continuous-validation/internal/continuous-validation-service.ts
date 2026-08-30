/**
 * WORK-064 Task 9 — the domain service composed through the existing
 * application composition (buildApp), exposed for FUTURE consumers
 * (WORK-065 browser agent, WORK-066 scheduler — NOT implemented here).
 *
 * The service is the small domain-facing surface: admission → persistence,
 * finalization → persistence, and evidence mapping through the EXISTING
 * /verification authority. It exposes NO browser execution APIs, NO
 * scheduling, NO persistence internals — only the domain operations later
 * Work Orders consume.
 */
import type { VerificationService } from '@modules/verification/index.js';
import type {
  ValidationRun,
  ValidationRunRepository,
} from '../types.js';
import { ValidationDomainError } from '../types.js';
import { admitValidationRun } from './run-admission.js';
import type {
  ValidationRunAdmission,
  ValidationRunRequest,
} from './run-admission.js';
import { finalizeValidationRun } from './outcome.js';
import type { FinalizeValidationRunInput } from './outcome.js';
import {
  mapValidationOutcomeToVerification,
} from './evidence-mapping.js';
import type {
  MapValidationOutcomeToVerificationInput,
  ValidationEvidenceReference,
} from './evidence-mapping.js';

/** The domain-facing service contract for future Work Orders. */
export interface ContinuousValidationService {
  /** Admit a validation run; the admitted run is persisted on admission. */
  admitRun(request: ValidationRunRequest): Promise<ValidationRunAdmission>;
  /** Read a run by id (null when absent — never fabricated). */
  findRun(id: string): Promise<ValidationRun | null>;
  /** Finalize an admitted run and persist the completion (the one transition). */
  completeRun(input: FinalizeValidationRunInput): Promise<ValidationRun>;
  /** Map a completed run's outcome into the EXISTING /verification evidence. */
  mapOutcomeToVerification(
    input: MapValidationOutcomeToVerificationInput,
  ): Promise<ValidationEvidenceReference>;
}

/** The service dependencies (all supplied by existing modules/composition). */
export interface ContinuousValidationServiceDeps {
  /** The validation-run persistence port (in-memory adapter in this Work Order). */
  readonly runRepository: ValidationRunRepository;
  /** The EXISTING /verification authority (consumed, never duplicated). */
  readonly verificationService: VerificationService;
}

/** The default service implementation (pure composition of the domain). */
export class DefaultContinuousValidationService implements ContinuousValidationService {
  constructor(private readonly deps: ContinuousValidationServiceDeps) {}

  async admitRun(request: ValidationRunRequest): Promise<ValidationRunAdmission> {
    const admission = admitValidationRun(request);
    if (admission.admitted && admission.run !== null) {
      // Only ADMITTED runs are persisted — a rejected admission leaves no record.
      await this.deps.runRepository.create(admission.run);
    }
    return admission;
  }

  async findRun(id: string): Promise<ValidationRun | null> {
    return this.deps.runRepository.getById(id);
  }

  async completeRun(input: FinalizeValidationRunInput): Promise<ValidationRun> {
    // Only a run THIS service admitted (and persisted) can be completed here.
    const existing = await this.deps.runRepository.getById(input.run.id);
    if (existing === null) {
      throw new ValidationDomainError(
        'FINALIZE_RUN_ALREADY_COMPLETED',
        `run ${input.run.id} was not admitted through this service (only admitted runs are completed here)`,
      );
    }
    if (existing.status !== 'admitted') {
      throw new ValidationDomainError(
        'FINALIZE_RUN_ALREADY_COMPLETED',
        `run ${input.run.id} is already ${existing.status} — a run is finalized exactly once`,
      );
    }
    const completed = finalizeValidationRun(input);
    await this.deps.runRepository.create(completed);
    return completed;
  }

  async mapOutcomeToVerification(
    input: MapValidationOutcomeToVerificationInput,
  ): Promise<ValidationEvidenceReference> {
    return mapValidationOutcomeToVerification(input, this.deps.verificationService);
  }
}
