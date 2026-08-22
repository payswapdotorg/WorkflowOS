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
 * WORK-010: implements the provider-independent LLM Gateway (LLM-001..005).
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
