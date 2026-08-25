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
  // WORK-033: surface capability types re-exported so the execution-policy
  // application-layer orchestrator (src/execution-policy/) can compose a
  // ProviderCapabilityProfile from existing metadata WITHOUT inventing a
  // second provider catalog (§6 — no invented capabilities).
  ProviderSurfaceCapabilities,
  ProviderSurfaceKind,
  SurfaceReadiness,
  // WORK-033: the external-UI provider catalog (display + validation metadata
  // only — no credentials/URLs/DOM). Re-exported for the policy layer to read.
} from './internal/agent-provider-registry.types.js';
export { EXTERNAL_UI_CATALOG } from './internal/agent-provider-registry.types.js';
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
  CompanionRedeemedHandoff,
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

// WORK-034 (first slice): Persistent Session Core — the provider-independent
// session contracts. An ExecutionSession is the CONTINUATION CONTEXT for
// exactly ONE ExecutionRecord (WorkItem → WorkOrder → ExecutionRecord →
// ExecutionSession → append-only events). All state transitions are
// repository-level CAS (lost CAS → null); terminal states are immutable;
// `interrupted` is resumable; events are append-only with per-session unique
// sequences. Provider-specific session details are NOT exposed — the
// implementations live under internal/ (this slice wires nothing into the
// execution flow; later slices compose sessions with the existing
// ExecutionService.submit() path — no second engine, no second
// ExecutionService).
export type {
  ExecutionSession,
  ExecutionSessionStatus,
  ExecutionSessionEvent,
  ExecutionSessionEventType,
  ExecutionSessionRepository,
  // WORK-034 integration: the /agents-owned session lifecycle boundary
  // (idempotent ensure + CAS start/interrupt/resume/terminal with atomic
  // event emission). Provider-independent.
  ExecutionSessionService,
  SessionTransitionResult,
} from './internal/execution-session.types.js';
// The typed session-domain error: a discriminated class with a stable
// machine-readable `code` (EXECUTION_SESSION_ERROR_CODES) + structured
// context — programmatic handling never parses message strings. Concrete
// PostgreSQL error details stay internal (mapped at the repository
// boundary).
export { ExecutionSessionError, EXECUTION_SESSION_ERROR_CODES } from './internal/execution-session.types.js';
export type { ExecutionSessionErrorCode } from './internal/execution-session.types.js';

// WORK-035: Agent Workspaces and Git Worktrees — the provider-independent
// workspace contracts. A Workspace is the FILESYSTEM/REPOSITORY
// ENVIRONMENT for one logical execution (spec §33.8): it references the
// existing ExecutionRecord (never a second execution identity) + the
// existing /github repository authority row (never a GitHub authority
// itself — no PR/merge state, no credentials). Both native + external
// execution reference the same abstraction. The materializer port +
// implementations stay internal/.
export type {
  AgentWorkspace,
  AgentWorkspaceState,
  AgentWorkspaceRepository,
  AgentWorkspaceClaim,
  EnsureAgentWorkspaceInput,
  WorktreeMaterializer,
} from './internal/agent-workspace.types.js';
export { AgentWorkspaceError, AGENT_WORKSPACE_ERROR_CODES } from './internal/agent-workspace.types.js';
export type { AgentWorkspaceErrorCode } from './internal/agent-workspace.types.js';

// WORK-036: Tool Runtime — the governed tool boundary BENEATH the
// execution/session/workspace authority (spec §33.8: execution
// infrastructure, not workflow authority). Tools are CAPABILITIES: their
// outcomes are observations/evidence and never decide workflow,
// verification, review, merge, or architecture state. The runtime
// consumes the WORK-035 workspace abstraction, dispatches the frozen
// families (filesystem/terminal/git/package/http/browser) through the
// platform executor ports, and observes every outcome through the
// EXISTING ExecutionSession event vocabulary (tool_call + observation)
// plus the audit boundary — no parallel tool-event store. The policy GATE
// is the WORK-037 enforcement seam (allow/deny/ask/constrained), not a
// permission engine. Implementations stay internal/.
export type {
  ToolRuntime,
  ToolInvocationInput,
  ToolResult,
  ToolInvocationRecord,
  ToolInvocationStatus,
  ToolInvocationIdempotency,
  ToolIdentity,
  ExternalToolObservationInput,
  ToolPolicyGate,
  ToolPolicyRequest,
  ToolPolicyDecision,
  ToolPolicyDecisionValue,
  ToolPolicyConstraints,
  // The platform tool contracts re-exported through this barrel.
  ToolFamily,
  ToolFamilyRequest,
  ToolExecutionLimits,
  ToolExecutor,
  ToolExecutorContext,
  ToolExecutionOutcome,
  FilesystemToolRequest,
  FilesystemToolOperation,
  TerminalToolRequest,
  GitToolRequest,
  PackageToolRequest,
  HttpToolRequest,
  HttpToolMethod,
  BrowserToolRequest,
  BrowserToolOperation,
} from './internal/tool-runtime.types.js';
export {
  ToolRuntimeError,
  TOOL_RUNTIME_ERROR_CODES,
  DEFAULT_TOOL_EXECUTION_LIMITS,
} from './internal/tool-runtime.types.js';
export type { ToolRuntimeErrorCode } from './internal/tool-runtime.types.js';

export interface AgentsModuleApi {}

export const agentsModule: ModuleContract & AgentsModuleApi = { name: '/agents' };
export default agentsModule;
