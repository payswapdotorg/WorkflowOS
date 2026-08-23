/**
 * agents module — public interface.
 *
 * Canonical name: /agents
 * Responsibility (spec/architecture.md): Agent Gateway and Agent Runs.
 *
 * WORK-012: implements the provider-independent Agent Gateway (AGENT-001,
 * AGENT-002). Provider-specific code stays inside internal/. Credentials via
 * SecretStore. Agent output is claim/evidence input only — it must NOT
 * directly mutate workflow state.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  AgentStatus, AgentErrorType, AgentRequest, AgentExecutionResult,
  AgentTestReport, AgentBlockerReport, AgentError, AgentGateway, AgentRun,
  AgentRunRepository,
} from './internal/agent.types.js';
// WORK-026: Agent Provider Registry — provider-independent readiness surface
// (mirrors the /llm ProviderRegistry pattern). Used by routes that need to
// list configured agent providers / validate (provider, model) combinations
// without exposing secret values.
export type {
  AgentProviderConfig,
  AgentProviderRegistry,
  AgentProviderConfigRepository,
  AgentProviderConfigRecord,
  ExecutionProviderInfo,
} from './internal/agent-provider-registry.types.js';
// WORK-027: Execution provider abstraction — the provider-independent boundary
// for executing a Work Order either NATIVELY (via the existing AgentGateway)
// or EXTERNALLY (via a secure, one-time, short-lived handoff package for the
// future Companion extension). Concrete implementations stay in internal/;
// this barrel exposes the contract types only.
export type {
  ExecutionMode,
  ExecutionState,
  ExecutionTask,
  ExecutionSubmission,
  ExecutionProvider,
  ExternalExecutionPackage,
  ExecutionRecord,
  CreateExecutionRecordInput,
  UpdateExecutionStatusInput,
  ExecutionRecordRepository,
  ExecutionEventRecord,
  AppendExecutionEventInput,
  ExecutionEventRepository,
  ExecutionHandoffRecord,
  ExecutionHandoffRepository,
  IssuedExecutionHandoff,
  RedeemedExecutionPackage,
  ExecutionHandoffService,
  // WORK-027 (PR #30 review fix #2): scoped execution callback credentials.
  ExecutionCallbackRecord,
  ExecutionCallbackRepository,
  IssuedExecutionCallback,
  ValidatedExecutionCallback,
  ExecutionCallbackService,
  IngestExecutionEventInput,
  IngestedExecutionEvent,
  ExecutionEventIngestionService,
  ExecutionSubmitResult,
  ExecutionService,
} from './internal/execution.types.js';

export interface AgentsModuleApi {}

export const agentsModule: ModuleContract & AgentsModuleApi = { name: '/agents' };
export default agentsModule;
