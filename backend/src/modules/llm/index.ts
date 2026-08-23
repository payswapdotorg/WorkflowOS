/**
 * llm module — public interface.
 *
 * Canonical name: /llm
 * Responsibility (spec/architecture.md): LLM Gateway, architect role execution,
 * Work-order generation.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-013: implements the provider-independent LLM Gateway (LLM-001..005).
 * Provider-specific SDK code stays inside internal/. Credentials via
 * SecretStore (SEC-001). The gateway owns: provider/model selection, retry
 * policy, usage recording, error normalization.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  LlmError,
  LlmErrorType,
  LlmGateway,
  LlmExecutionRecord,
  LlmExecutionStatus,
  LlmExecutionRecordRepository,
} from './internal/llm.types.js';
// WORK-014: Architect Service types.
export type {
  ArchitectContext,
  ArchitectRequirementSummary,
  ArchitectCriterionSummary,
  ArchitectRepositoryEvidence,
  ArchitectVerificationEvidence,
  ArchitectExecutionRequest,
  ArchitectExecutionResult,
  WorkOrderCandidate,
  ArchitectService,
} from './internal/architect.types.js';

// WORK-025: Conversational Architect types.
export type {
  ArchitectMessage,
  ArchitectRevision,
  ArchitectParsedPlan,
  ArchitectSession,
  ArchitectSessionRepository,
  ConversationalArchitectResult,
  ConversationalArchitectService,
  ProviderConfig,
} from './internal/conversational-architect.types.js';

// WORK-025: Atomic plan applier.
export type {
  ApplyPlanResult,
  RepositoryFactories,
  ArchitectPlanApplier,
  ArchitectPlanInput,
  ArchitectPlanIntegrityError,
} from './internal/architect-plan-applier.js';

/**
 * Public capabilities exposed by the /llm module to other modules.
 */
export interface LlmModuleApi {
  // future: additional LLM-domain methods consumed by other modules
}

/**
 * Frozen module contract for /llm.
 */
export const llmModule: ModuleContract & LlmModuleApi = {
  name: '/llm',
};

export default llmModule;
