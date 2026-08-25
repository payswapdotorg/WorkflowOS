/**
 * WORK-036: ProcessToolExecutor — ONE governed process engine for the
 * terminal, git, and package families (explicit-argv child spawning —
 * never child_process.exec(userString); there is no shell, so there is
 * no shell-escape surface).
 *
 * PR #40 REVIEW FIX — the sandbox boundary: this executor previously
 * confined only the WORKING DIRECTORY, which confines the invocation,
 * not the PROCESS: a cwd-confined child could still `cat /etc/passwd`,
 * run `git -C /outside/repository …`, read host credentials through
 * /proc/<pid>/environ, and open sockets. EVERY launch now crosses the
 * injected ProcessSandbox boundary (mount/net/pid/ipc/uts/user
 * namespaces, pivot_root, capability drop) — see process-sandbox.ts.
 * Fail-closed: no usable sandbox ⇒ the typed
 * `process-sandbox-unavailable` outcome ⇒ NO process. There is no
 * unsandboxed fallback path in this class.
 *
 * GOVERNANCE (structural, not policy — WORK-037 tightens later):
 *   * explicit argv separation (argv[0] = executable; no shell string);
 *   * the working directory is CONFINED to the WORK-035 workspace root
 *     (a relative cwd; traversal/absolute/symlink escapes fail closed);
 *   * the child environment is a SANITIZED MINIMAL base + the explicit
 *     caller env — the host environment (which may hold GitHub/LLM
 *     credentials) is NEVER inherited;
 *   * the kernel-enforced sandbox confines the PROCESS to the worktree
 *     (+ the repository's shared .git object store — git's own worktree
 *     model) and cuts network, host processes, and host configuration;
 *   * stdout/stderr captured with per-stream byte caps (bounded output);
 *   * the exit code, start/end timing, cancellation (AbortSignal →
 *     SIGTERM), and a hard timeout are all part of the outcome (the
 *     timeout bounds the ENTIRE sandboxed invocation);
 *   * GIT family: remote-network subcommands and cwd/git-dir-redirecting
 *     flags are rejected fail-closed (the workspace holds no GitHub
 *     credentials; remote authority stays /github);
 *   * PACKAGE family: the runner is a BARE executable name (path
 *     separators rejected — no arbitrary binaries).
 */
import { execFile } from 'node:child_process';
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import type { Logger } from '@platform/logger.js';
import type {
  GitToolRequest,
  PackageToolRequest,
  TerminalToolRequest,
  ToolExecutionOutcome,
  ToolExecutor,
  ToolExecutorContext,
  ToolFamily,
  ToolFamilyRequest,
} from './tool-contracts.js';
import { toolOutcomeError } from './tool-contracts.js';
import { resolveWithinWorkspace, WorkspaceBoundaryError } from './path-confinement.js';
import type { ProcessSandbox, WrappedProcessLaunch } from './process-sandbox.js';

/**
 * The teardown grace: after SIGTERM the group gets this long before the
 * SIGKILL escalation (a PID-1-in-its-namespace target legitimately
 * ignores default-disposition SIGTERM — only SIGKILL is guaranteed).
 */
const TEARDOWN_GRACE_MS = 2_000;

/** The raw spawn result before governed mapping. */
interface RawProcessResult {
  readonly err: (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

/**
 * Git subcommands that touch the REMOTE (network) — rejected fail-closed:
 * the workspace layer holds no credentials and remote repository state is
 * /github's authority (push/pull/fetch/clone/…). (Defense in depth: the
 * sandbox's network namespace blocks these anyway.)
 */
const GIT_REMOTE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'push',
  'pull',
  'fetch',
  'clone',
  'remote',
  'ls-remote',
  'submodule',
  'fetch-pack',
  'upload-pack',
  'send-pack',
  'receive-pack',
  'daemon',
  'http-backend',
  'svn',
]);

/**
 * Git argv tokens that REDIRECT where git operates (defeating the forced
 * workspace cwd) — rejected anywhere in the argv. (Defense in depth: the
 * sandbox makes redirected host paths unreachable anyway.)
 */
const GIT_REDIRECT_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--upload-pack',
  '--exec-path',
  '--global',
  '--system',
]);

/** Env keys the process engine rejects for the GIT family (git-dir smuggling). */
const GIT_ENV_PREFIX = 'GIT_';

export interface ProcessToolExecutorDeps {
  readonly logger: Logger;
  /**
   * REQUIRED, no default: the sandbox every native process crosses. The
   * composition root injects NamespaceProcessSandbox (app.ts); tests
   * inject the real one or an unavailable stub — there is no constructor
   * path that yields an unsandboxed executor.
   */
  readonly sandbox: ProcessSandbox;
}

export class ProcessToolExecutor implements ToolExecutor {
  readonly family: ToolFamily;

  constructor(family: 'terminal' | 'git' | 'package', deps: ProcessToolExecutorDeps) {
    this.family = family;
    this.logger = deps.logger;
    this.sandbox = deps.sandbox;
  }

  private readonly logger: Logger;
  private readonly sandbox: ProcessSandbox;

  async execute(request: ToolFamilyRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    if (this.family === 'git') return this.executeGit(request as GitToolRequest, ctx);
    if (this.family === 'package') return this.executePackage(request as PackageToolRequest, ctx);
    return this.executeTerminal(request as TerminalToolRequest, ctx);
  }

  // ------------------------------------------------------------------ terminal

  private async executeTerminal(
    req: TerminalToolRequest,
    ctx: ToolExecutorContext,
  ): Promise<ToolExecutionOutcome> {
    if (!req || !Array.isArray(req.argv) || req.argv.length === 0 || !req.argv.every((a) => typeof a === 'string')) {
      return toolOutcomeError('tool-invalid-input', 'terminal request requires a non-empty argv of strings (no shell strings)');
    }
    return this.runProcess(req.argv, {
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.timeoutMs,
      rejectGitEnv: false,
      ctx,
    });
  }

  // ------------------------------------------------------------------ git

  private async executeGit(req: GitToolRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    if (!req || !Array.isArray(req.args) || req.args.length === 0 || !req.args.every((a) => typeof a === 'string')) {
      return toolOutcomeError('tool-invalid-input', 'git request requires a non-empty args array of strings');
    }
    // Fail-closed governance BEFORE any process spawns.
    const subcommand = req.args[0]!;
    if (GIT_REMOTE_SUBCOMMANDS.has(subcommand)) {
      return toolOutcomeError(
        'git-remote-operation-forbidden',
        `git ${subcommand} is a remote-network operation — the workspace holds no GitHub credentials and remote repository authority stays /github (repository-LOCAL git operations only)`,
      );
    }
    const redirect = req.args.find((a) => GIT_REDIRECT_FLAGS.has(a));
    if (redirect !== undefined) {
      return toolOutcomeError(
        'git-redirect-forbidden',
        `git argument ${JSON.stringify(redirect)} would redirect git away from the workspace worktree — rejected`,
      );
    }
    for (const key of Object.keys(req.env ?? {})) {
      if (key.toUpperCase().startsWith(GIT_ENV_PREFIX)) {
        return toolOutcomeError(
          'git-env-forbidden',
          `git request env key ${JSON.stringify(key)} starts with GIT_ — the git environment is owned by the workspace boundary, not the caller`,
        );
      }
    }
    // The cwd is ALWAYS the workspace worktree root (the WORK-035 identity).
    return this.runProcess(['git', ...req.args], {
      cwd: '.',
      env: req.env,
      timeoutMs: req.timeoutMs,
      rejectGitEnv: true,
      ctx,
    });
  }

  // ------------------------------------------------------------------ package

  private async executePackage(req: PackageToolRequest, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
    if (!req || typeof req.runner !== 'string' || req.runner.length === 0) {
      return toolOutcomeError('tool-invalid-input', 'package request requires a runner executable name');
    }
    if (!Array.isArray(req.args) || !req.args.every((a) => typeof a === 'string')) {
      return toolOutcomeError('tool-invalid-input', 'package request requires an args array of strings');
    }
    if (req.runner.includes('/') || req.runner.includes('\\') || req.runner.includes('..')) {
      return toolOutcomeError(
        'package-runner-path-forbidden',
        `the package runner must be a bare executable name resolved via PATH (got ${JSON.stringify(req.runner)}) — arbitrary binaries are not a capability`,
      );
    }
    return this.runProcess([req.runner, ...req.args], {
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.timeoutMs,
      rejectGitEnv: false,
      ctx,
    });
  }

  // ------------------------------------------------------------------ engine

  private async runProcess(
    argv: readonly string[],
    opts: {
      cwd: string | undefined;
      env: Readonly<Record<string, string>> | undefined;
      timeoutMs: number | undefined;
      rejectGitEnv: boolean;
      ctx: ToolExecutorContext;
    },
  ): Promise<ToolExecutionOutcome> {
    let cwd: string;
    try {
      cwd = await resolveWithinWorkspace(opts.ctx.workspaceRoot, opts.cwd ?? '.');
    } catch (err) {
      if (err instanceof WorkspaceBoundaryError) {
        return toolOutcomeError(err.code, `working directory rejected — ${err.message}`, {
          output: { argv: argv.length, sandbox: this.sandbox.id },
        });
      }
      throw err;
    }

    const timeout = this.boundedTimeout(opts.timeoutMs, opts.ctx);
    const env = this.sanitizedEnv(opts.env, cwd);

    // The sandbox boundary — FAIL-CLOSED: if it is not usable, no process
    // runs at all (there is no unsandboxed fallback anywhere).
    try {
      await this.sandbox.ensureAvailable();
    } catch (err) {
      return toolOutcomeError('process-sandbox-unavailable', (err as Error).message, {
        output: { argv: argv.length, sandbox: this.sandbox.id },
      });
    }
    let launch: WrappedProcessLaunch;
    try {
      launch = await this.sandbox.wrapLaunch({ argv, cwd, workspaceRoot: opts.ctx.workspaceRoot, env });
    } catch (err) {
      return toolOutcomeError(
        'process-sandbox-unavailable',
        `the sandboxed launch could not be prepared — ${(err as Error).message}`,
        { output: { argv: argv.length, sandbox: this.sandbox.id } },
      );
    }

    try {
      const raw = await this.spawnSandboxed(launch, {
        timeout,
        signal: opts.ctx.signal,
        maxBuffer: opts.ctx.limits.maxOutputBytes,
        hostCwd: opts.ctx.workspaceRoot,
      });
      if (raw.err === null) {
        this.logger.info('tool.process.completed', {
          family: this.family,
          argv0: argv[0],
          exitCode: 0,
          sandbox: this.sandbox.id,
        });
        return {
          exitCode: 0,
          stdout: raw.stdout ?? '',
          stderr: raw.stderr ?? '',
          output: { argv: argv.length, cwd: opts.cwd ?? '.', timedOut: false, sandbox: this.sandbox.id },
          error: null,
          cancelled: false,
          truncated: false,
        };
      }
      return this.mapProcessError(raw, argv);
    } catch (err) {
      // A spawn-level failure BEFORE any child exists (typed, honest).
      return toolOutcomeError('process-error', `${(err as Error).name ?? 'Error'}: ${(err as Error).message ?? String(err)}`, {
        output: { argv: argv.length, sandbox: this.sandbox.id },
      });
    }
  }

  /**
   * Spawn the WRAPPED launch and own its ENTIRE lifecycle. The unshare
   * wrapper blocks SIGTERM while waiting, and the exec'd target is PID 1
   * of its namespace (default-disposition signals are ignored) — so the
   * teardown is a PROCESS-GROUP kill (detached spawn) with a guaranteed
   * SIGKILL escalation after the grace period. The timeout bounds the
   * WHOLE sandboxed invocation (setup included).
   */
  private spawnSandboxed(
    launch: WrappedProcessLaunch,
    opts: { timeout: number; signal?: AbortSignal; maxBuffer: number; hostCwd: string },
  ): Promise<RawProcessResult> {
    return new Promise<RawProcessResult>((resolve) => {
      let timedOut = false;
      let settled = false;
      let escalateTimer: ReturnType<typeof setTimeout> | undefined;

      // `detached` is a runtime spawn option the execFile typings omit
      // (it makes the wrapper a process-group leader for teardown).
      const spawnOptions = {
        cwd: opts.hostCwd,
        env: launch.env as Record<string, string>,
        maxBuffer: opts.maxBuffer,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        detached: true,
      } as ExecFileOptionsWithStringEncoding & { detached: boolean };

      const child = execFile(
        launch.argv[0]!,
        launch.argv.slice(1) as string[],
        spawnOptions,
        (err: ExecFileException | null, stdout: string, stderr: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          clearTimeout(escalateTimer);
          opts.signal?.removeEventListener('abort', onAbort);
          resolve({
            err: err as RawProcessResult['err'],
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            timedOut,
            aborted: opts.signal?.aborted === true,
          });
        },
      );

      const teardown = (sig: 'SIGTERM' | 'SIGKILL') => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          /* the group is already gone */
        }
        try {
          child.kill(sig);
        } catch {
          /* the child is already gone */
        }
      };

      const onAbort = () => {
        teardown('SIGTERM');
        escalateTimer = setTimeout(() => teardown('SIGKILL'), TEARDOWN_GRACE_MS);
      };

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        teardown('SIGTERM');
        escalateTimer = setTimeout(() => teardown('SIGKILL'), TEARDOWN_GRACE_MS);
      }, opts.timeout);

      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Map a raw spawn result to the governed outcome (never a thrown crash). */
  private mapProcessError(raw: RawProcessResult, argv: readonly string[]): ToolExecutionOutcome {
    const e = raw.err!;
    const stdout = raw.stdout ?? '';
    const stderr = raw.stderr ?? '';
    const truncated = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    const sandboxOutput = { argv: argv.length, sandbox: this.sandbox.id };

    // The sandbox launcher itself could not be executed (ENOENT on the
    // unshare binary) — never fall back to an unsandboxed spawn.
    if (e.code === 'ENOENT' && e.message.includes('unshare')) {
      return toolOutcomeError(
        'process-sandbox-unavailable',
        "the sandbox launcher 'unshare' is not executable on this host — there is no unsandboxed fallback",
        { stdout, stderr, output: sandboxOutput },
      );
    }

    // Caller-initiated cancellation (deterministic: the flag, not signal
    // bookkeeping through the wrapper chain).
    if (raw.aborted) {
      return {
        exitCode: null,
        stdout,
        stderr,
        output: { ...sandboxOutput, cancelled: true },
        error: { code: 'cancelled', message: 'the invocation was cancelled (caller interruption)' },
        cancelled: true,
        truncated,
      };
    }
    // Hard timeout (deterministic flag — the bound covers the ENTIRE
    // sandboxed invocation, setup included; the escalation guarantees
    // the teardown completes).
    if (raw.timedOut) {
      return {
        exitCode: null,
        stdout,
        stderr,
        output: { ...sandboxOutput, timedOut: true },
        error: { code: 'timeout', message: `the process was killed after exceeding its timeout bound` },
        cancelled: false,
        truncated,
      };
    }
    if (truncated) {
      return {
        exitCode: null,
        stdout,
        stderr,
        output: { ...sandboxOutput, maxBufferExceeded: true },
        error: { code: 'output-limit-exceeded', message: `the process output exceeded the bounded buffer and the process was killed` },
        cancelled: false,
        truncated: true,
      };
    }
    // Spawn failure vs non-zero exit. A missing TARGET binary fails
    // INSIDE the sandbox (exit 127 from the setup shell) — that is a
    // tool-level failure, not a sandbox failure.
    const exitCode = typeof e.code === 'number' ? e.code : null;
    return {
      exitCode,
      stdout,
      stderr,
      output: sandboxOutput,
      error: {
        code: exitCode !== null ? 'non-zero-exit' : 'process-error',
        message:
          exitCode !== null
            ? `the process exited with code ${exitCode}`
            : `${e.name ?? 'Error'}: ${e.message}`,
      },
      cancelled: false,
      truncated,
    };
  }

  /** Clamp a requested timeout into [1, maxTimeoutMs]. */
  private boundedTimeout(requested: number | undefined, ctx: ToolExecutorContext): number {
    const base = requested ?? ctx.limits.defaultTimeoutMs;
    return Math.max(1, Math.min(base, ctx.limits.maxTimeoutMs));
  }

  /**
   * The sanitized child environment: a FIXED minimal base (never the host
   * env — the host may hold GitHub/LLM credentials) + the explicit caller
   * env. HOME points INSIDE the workspace cwd (no host user configuration
   * leaks through ~/.gitconfig or runner caches).
   */
  private sanitizedEnv(
    extra: Readonly<Record<string, string>> | undefined,
    homeDir: string,
  ): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: process.env.TZ ?? 'UTC',
      HOME: homeDir,
      NO_COLOR: '1',
    };
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (typeof v === 'string') env[k] = v;
    }
    return env;
  }
}
