/**
 * WORK-036: the governed TOOL CONTRACTS — platform-owned, provider-
 * independent (the WORK-035 worktree-materializer pattern: the tool
 * executors are execution infrastructure, like platform/storage's
 * ObjectStore; the dependency direction is domain (agents) → platform).
 *
 * THE BOUNDARY (spec §33.8 — "execution infrastructure, not workflow
 * authority"):
 *
 *     Work Item → Work Order → ExecutionRecord → ExecutionSession
 *              → Workspace (WORK-035) → TOOL RUNTIME → actual tool
 *
 * A tool is a CAPABILITY, never an authority: no tool outcome decides
 * Work Item / Work Order / workflow / verification / review / merge /
 * architecture state. `git merge` succeeding is NOT "WorkflowOS VERIFIED";
 * an HTTP 200 is NOT a verification PASS; a browser observation is NOT
 * workflow authority. Outcomes are OBSERVATIONS (evidence) only.
 *
 * THE CONTRACT SHAPE (every invocation, native or external):
 *   tool identity (family + operation) · invocation identity (the
 *   caller-supplied invocationId idempotency key) · execution/session/
 *   workspace identity · input · the policy decision boundary · start +
 *   completion time · success/failure · structured output · stderr/error
 *   · exit status where applicable · cancellation/interruption.
 *
 * FAMILIES (the frozen WORK-036 set): filesystem, terminal, git, package,
 * http, browser. Provider-specific details (Playwright internals, Chrome
 * CDP types, provider SDKs) NEVER appear here — the browser DRIVER is an
 * injected port, the HTTP executor uses plain fetch, the process executor
 * uses argv-separated child spawning with NO shell.
 *
 * All executors are IDEMPOTENT-CONTRACT-ONLY capabilities: they receive a
 * resolved workspace root (the WORK-035 worktree host path) and MUST
 * confine every path to it (path-confinement.ts) — no arbitrary host
 * filesystem access, no credentials (the process environment is
 * sanitized; the HTTP executor never adds authentication).
 *
 * PR #40 review fix — the confinement claim, corrected: application-level
 * path confinement (fs family, cwd) confines the INVOCATION; for the
 * process families the PROCESS itself must also be confined, which is
 * the kernel's job: every terminal/git/package launch crosses the
 * ProcessSandbox boundary (namespace-isolated: the host filesystem is
 * detached via pivot_root, the network is unshared, host processes are
 * invisible, and the capability set is dropped before exec — see
 * process-sandbox.ts). cwd confinement alone was never confinement.
 */

/** The frozen WORK-036 tool families. */
export type ToolFamily = 'filesystem' | 'terminal' | 'git' | 'package' | 'http' | 'browser';

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/** The governed filesystem operations (all paths workspace-relative). */
export type FilesystemToolOperation = 'read' | 'write' | 'list' | 'stat' | 'mkdir' | 'delete';

export interface FilesystemToolRequest {
  readonly operation: FilesystemToolOperation;
  /** A path RELATIVE to the workspace root (traversal/absolute/symlink escape rejected). */
  readonly path: string;
  /** write only: the full file content (UTF-8). */
  readonly content?: string;
}

// ---------------------------------------------------------------------------
// Terminal / Git / Package (one governed process engine, three families)
// ---------------------------------------------------------------------------

export interface TerminalToolRequest {
  /** The EXPLICIT argv (argv[0] = the executable; NO shell string is ever accepted). */
  readonly argv: readonly string[];
  /** A cwd RELATIVE to the workspace root (default '.'). */
  readonly cwd?: string;
  /** Explicit extra environment (sanitized base + these; host env is NOT inherited). */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface GitToolRequest {
  /**
   * The git arguments WITHOUT the binary (e.g. ['status', '--porcelain']).
   * Repository-LOCAL operations only: remote-network subcommands (push/
   * pull/fetch/clone/remote/…) are rejected fail-closed — the workspace
   * never holds GitHub credentials and remote authority stays /github.
   */
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface PackageToolRequest {
  /**
   * The package-manager/test-runner EXECUTABLE (a bare name resolved via
   * PATH — path separators are rejected: no arbitrary binaries).
   */
  readonly runner: string;
  readonly args: readonly string[];
  /** A cwd RELATIVE to the workspace root (default '.'). */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type HttpToolMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface HttpToolRequest {
  /** An absolute http(s) URL (no userinfo; schemes other than http/https rejected). */
  readonly url: string;
  readonly method: HttpToolMethod;
  /**
   * Explicit caller headers. The executor NEVER adds authentication or
   * cookies itself; sensitive header values are REDACTED in the durable
   * observation (observation-redaction.ts).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** The request body (UTF-8; ignored for GET/HEAD). */
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

// ---------------------------------------------------------------------------
// Browser (the explicit abstraction — driver details stay behind the port)
// ---------------------------------------------------------------------------

export type BrowserToolOperation = 'open' | 'click' | 'type' | 'extract' | 'screenshot';

export interface BrowserToolRequest {
  readonly operation: BrowserToolOperation;
  /** open only: an absolute http(s) URL. */
  readonly url?: string;
  /** click/type/extract only: a selector. */
  readonly selector?: string;
  /** type only: the text to enter. */
  readonly text?: string;
  readonly timeoutMs?: number;
}

/** The union of every family request (discriminated by shape). */
export type ToolFamilyRequest =
  | FilesystemToolRequest
  | TerminalToolRequest
  | GitToolRequest
  | PackageToolRequest
  | HttpToolRequest
  | BrowserToolRequest;

// ---------------------------------------------------------------------------
// Execution limits (bounded output behavior — structural, not policy)
// ---------------------------------------------------------------------------

/** Structural bounds (WORK-037 may tighten per invocation via constraints). */
export interface ToolExecutionLimits {
  /** fs read: max content bytes. */
  readonly maxFileBytes: number;
  /** fs list: max entries. */
  readonly maxListEntries: number;
  /** process families: max stdout/stderr bytes per stream. */
  readonly maxOutputBytes: number;
  /** http: max response body bytes. */
  readonly maxHttpBodyBytes: number;
  /** process/http/browser: the default per-invocation timeout. */
  readonly defaultTimeoutMs: number;
  /** process/http/browser: the ceiling a request may not exceed. */
  readonly maxTimeoutMs: number;
  /** browser extract: max text bytes. */
  readonly browserMaxTextBytes: number;
  /** browser screenshot: max base64 bytes persisted. */
  readonly browserMaxScreenshotBytes: number;
}

export const DEFAULT_TOOL_EXECUTION_LIMITS: Readonly<ToolExecutionLimits> = Object.freeze({
  maxFileBytes: 1_048_576, // 1 MiB
  maxListEntries: 1_000,
  maxOutputBytes: 262_144, // 256 KiB per stream
  maxHttpBodyBytes: 1_048_576, // 1 MiB
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 600_000,
  browserMaxTextBytes: 65_536,
  browserMaxScreenshotBytes: 262_144,
});

// ---------------------------------------------------------------------------
// The executor port
// ---------------------------------------------------------------------------

/** Per-invocation execution context (resolved by the tool RUNTIME). */
export interface ToolExecutorContext {
  /** The WORK-035 workspace worktree host path — the filesystem boundary. */
  readonly workspaceRoot: string;
  /** Caller cancellation (terminal kill / HTTP abort / driver stop). */
  readonly signal?: AbortSignal;
  readonly limits: ToolExecutionLimits;
}

/**
 * The outcome envelope shared by every family. Tool-level failures are
 * OUTCOMES (recorded, observable), never thrown exceptions: a non-zero
 * exit, a missing file, a boundary violation, a network error — all
 * become `{ error: { code, message } }` with the structured details
 * preserved. `cancelled: true` marks caller-initiated interruption.
 */
export interface ToolExecutionOutcome {
  /** The process exit code where applicable (process families); else null. */
  readonly exitCode: number | null;
  /** Captured stdout (bounded; '' for non-process families). */
  readonly stdout: string;
  /** Captured stderr (bounded; '' for non-process families). */
  readonly stderr: string;
  /** The family-specific structured output (evidence — redactable upstream). */
  readonly output: Readonly<Record<string, unknown>> | null;
  /** Set iff the invocation FAILED at the execution level. */
  readonly error: { readonly code: string; readonly message: string } | null;
  /** Caller-initiated cancellation (AbortSignal fired). */
  readonly cancelled: boolean;
  /** Any bounded stream was truncated. */
  readonly truncated: boolean;
}

/** The provider-independent executor port (one implementation per family). */
export interface ToolExecutor {
  readonly family: ToolFamily;
  execute(request: ToolFamilyRequest, context: ToolExecutorContext): Promise<ToolExecutionOutcome>;
}

/** A failed-outcome helper (the one-liner the executors share). */
export function toolOutcomeError(
  code: string,
  message: string,
  extra?: Partial<Omit<ToolExecutionOutcome, 'error'>>,
): ToolExecutionOutcome {
  return {
    exitCode: extra?.exitCode ?? null,
    stdout: extra?.stdout ?? '',
    stderr: extra?.stderr ?? '',
    output: extra?.output ?? null,
    error: { code, message },
    cancelled: extra?.cancelled ?? false,
    truncated: extra?.truncated ?? false,
  };
}
