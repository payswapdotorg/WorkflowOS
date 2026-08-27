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
  // WORK-042: the cross-mode transition input (mode + status + the
  // mode-specific authoritative fields). Used ONLY by the cross-mode handoff
  // service to transition an existing ExecutionRecord native <-> external.
  TransitionModeInput,
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
  // WORK-043: the provider-independent final admission contract (the
  // execution-side boundary immediately before provider dispatch).
} from './internal/execution.types.js';

// WORK-042: Cross-Mode Execution Handoff — the cross-mode transition boundary
// for the SAME logical ExecutionRecord (native <-> external). ONE ExecutionRecord
// is preserved; the handoff is a subordinate state transition + an append-only
// history log row. The service composes the EXISTING NativeExecutionProvider +
// ExternalExecutionProvider + ExecutionTaskService + AgentPolicyEngine +
// ExecutionPolicyService + AgentProviderRegistryService — it is NOT an
// ExecutionService, it NEVER creates a second ExecutionRecord, and it NEVER
// touches workflow/verification/review state. Concrete implementations stay
// in internal/ (wired by app.ts).
export type {
  CrossModeHandoffRecord,
  CrossModeHandoffInput,
  CrossModeHandoffResult,
  CrossModeHandoffRepository,
  CrossModeHandoffService,
  CrossModeHandoffDirection,
  CreateCrossModeHandoffInput,
  CrossModeHandoffErrorCode,
} from './internal/cross-mode-handoff.types.js';
export {
  CrossModeHandoffError,
  CROSS_MODE_HANDOFF_ERROR_CODES,
  CROSS_MODE_HANDOFF_RELAY_JOB_TYPE,
} from './internal/cross-mode-handoff.types.js';
// WORK-043 round 4 (AR-043-05 — the dispatch admission boundary): the typed
// admission rejection thrown by the dispatch mutation boundary (the direct
// execution record creation + the cross-mode handoff's beginFencedDispatch
// gate). Re-exported for the route layer's 429 mapping + consumer typing.
export { DispatchAdmissionRejectedError } from './internal/dispatch-admission.js';
export type {
  DispatchAdmissionRejectionDetail,
  DispatchAdmissionCategory,
  DispatchAdmissionInput,
} from './internal/dispatch-admission.js';
export { DISPATCH_RESERVATION_HORIZON_MS } from './internal/dispatch-admission.js';
// PR #46 review #2: the durable cross-mode-handoff relay (mirrors the
// WORK-034 session-terminal relay + the WORK-035 workspace-release relay).
// Wired into the WorkerHost at composition time (app.ts): the job handler is
// registered in the HandlerRegistry; the boot sweep is registered in
// WorkerHostOptions.outboxRelays. The obligation row (migration 0043) is the
// durable source of truth for an in-flight handoff; the relay + the boot
// sweep guarantee eventual delivery of an interrupted handoff. The concrete
// CrossModeHandoffOutboxRelay + createCrossModeHandoffRelayJobHandler stay
// internal (imported by app.ts directly from the internal path — mirrors the
// WORK-034/035 relay pattern; the barrel exposes ONLY the contract types so
// the module-boundary invariant "barrels export only types/interfaces" holds).
export type {
  CrossModeHandoffReconciler,
  CrossModeHandoffRelayJobPayload,
  CrossModeHandoffOutboxRelayDeps,
} from './internal/cross-mode-handoff-relay.js';

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

// WORK-037: Agent Policy and Permissions — the durable execution-policy
// authority BEHIND the WORK-036 ToolPolicyGate seam. The engine implements
// ToolPolicyGate (allow/deny/ask/constrained across the four control
// domains: tools, network, secrets, deployment); the durable ASK
// interaction; versioned document CRUD; and external-handoff eligibility.
// It is DISTINCT from project authorization (WORK-002): the engine never
// imports the authorization service — only the route layer calls
// requireProjectAuthorization (the one-way dependency invariant:
// Auth/ProjectAuth → Execution Policy → Tool Runtime → Sandboxed Executor).
// Concrete implementations (the engine, the pg repository, the
// policy-gated handoff decorator) stay internal — wired by app.ts.
export type {
  AgentPolicyDomain,
  AgentPolicyRule,
  AgentPolicyDocument,
  AgentPolicyResolution,
  AgentPolicyScopeSource,
  AgentPolicyApproval,
  AgentPolicyApprovalStatus,
  AgentPolicyExternalDecision,
  ProjectScopedPolicyDecision,
  AgentPolicyRepository,
  AgentPolicyEngineDeps,
  AgentPolicyService,
} from './internal/agent-policy.types.js';
// The platform default document is pure data (a frozen literal: rule
// selectors + effects + reasons; no wiring, no credentials, no provider
// branches) — the sanctioned exception to the types-only barrel rule.
export {
  AgentPolicyError,
  AGENT_POLICY_ERROR_CODES,
  PLATFORM_DEFAULT_AGENT_POLICY_DOCUMENT,
  AGENT_POLICY_DOMAINS,
} from './internal/agent-policy.types.js';
export type { AgentPolicyErrorCode } from './internal/agent-policy.types.js';
export type { AgentPolicyEngine } from './internal/agent-policy-engine.js';
export type { AgentPolicyHandoffEvaluator } from './internal/policy-gated-handoff-service.js';

export interface AgentsModuleApi {}

export const agentsModule: ModuleContract & AgentsModuleApi = { name: '/agents' };
export default agentsModule;
