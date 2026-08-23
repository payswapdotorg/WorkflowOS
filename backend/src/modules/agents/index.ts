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
} from './internal/agent-provider-registry.types.js';

export interface AgentsModuleApi {}

export const agentsModule: ModuleContract & AgentsModuleApi = { name: '/agents' };
export default agentsModule;
