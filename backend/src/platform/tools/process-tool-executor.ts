/**
 * WORK-036: ProcessToolExecutor — ONE governed process engine for the
 * terminal, git, and package families (the safest existing platform
 * process abstraction: promisified child_process.execFile with EXPLICIT
 * argv — never child_process.exec(userString); there is no shell, so
 * there is no shell-escape surface).
 *
 * GOVERNANCE (structural, not policy — WORK-037 tightens later):
 *   * explicit argv separation (argv[0] = executable; no shell string);
 *   * the working directory is CONFINED to the WORK-035 workspace root
 *     (a relative cwd; traversal/absolute/symlink escapes fail closed);
 *   * the child environment is a SANITIZED MINIMAL base + the explicit
 *     caller env — the host environment (which may hold GitHub/LLM
 *     credentials) is NEVER inherited;
 *   * stdout/stderr captured with per-stream byte caps (bounded output);
 *   * the exit code, start/end timing, cancellation (AbortSignal →
 *     SIGTERM), and a hard timeout are all part of the outcome;
 *   * GIT family: remote-network subcommands and cwd/git-dir-redirecting
 *     flags are rejected fail-closed (the workspace holds no GitHub
 *     credentials; remote authority stays /github);
 *   * PACKAGE family: the runner is a BARE executable name (path
 *     separators rejected — no arbitrary binaries).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

/**
 * Git subcommands that touch the REMOTE (network) — rejected fail-closed:
 * the workspace layer holds no credentials and remote repository state is
 * /github's authority (push/pull/fetch/clone/…).
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
 * workspace cwd) — rejected anywhere in the argv.
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
}

export class ProcessToolExecutor implements ToolExecutor {
  readonly family: ToolFamily;

  constructor(family: 'terminal' | 'git' | 'package', deps: ProcessToolExecutorDeps) {
    this.family = family;
    this.logger = deps.logger;
  }

  private readonly logger: Logger;

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
        return toolOutcomeError(err.code, `working directory rejected — ${err.message}`);
      }
      throw err;
    }

    const timeout = this.boundedTimeout(opts.timeoutMs, opts.ctx);
    const env = this.sanitizedEnv(opts.env, cwd);

    try {
      const { stdout, stderr } = await execFileAsync(argv[0]!, argv.slice(1) as string[], {
        cwd,
        env,
        timeout,
        maxBuffer: opts.ctx.limits.maxOutputBytes,
        killSignal: 'SIGTERM',
        signal: opts.ctx.signal,
        encoding: 'utf8',
      });
      this.logger.info('tool.process.completed', {
        family: this.family,
        argv0: argv[0],
        exitCode: 0,
      });
      return {
        exitCode: 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        output: { argv: argv.length, cwd: opts.cwd ?? '.', timedOut: false },
        error: null,
        cancelled: false,
        truncated: false,
      };
    } catch (err) {
      return this.mapProcessError(err, argv, opts.ctx.signal);
    }
  }

  /** Map an execFile failure to the governed outcome (never a thrown crash). */
  private mapProcessError(err: unknown, argv: readonly string[], signal?: AbortSignal): ToolExecutionOutcome {
    const e = err as {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
      name?: string;
      message?: string;
    };
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    const truncated = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

    // Caller-initiated cancellation (AbortSignal fired → AbortError).
    if (e.name === 'AbortError' || (signal?.aborted && e.killed)) {
      return {
        exitCode: null,
        stdout,
        stderr,
        output: { argv: argv.length, cancelled: true },
        error: { code: 'cancelled', message: 'the invocation was cancelled (caller interruption)' },
        cancelled: true,
        truncated,
      };
    }
    // Hard timeout (execFile killed the process after timeout ms).
    if (e.killed && e.signal === 'SIGTERM') {
      return {
        exitCode: null,
        stdout,
        stderr,
        output: { argv: argv.length, timedOut: true },
        error: { code: 'timeout', message: `the process was killed after exceeding its timeout bound` },
        cancelled: false,
        truncated,
      };
    }
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        exitCode: typeof e.code === 'number' ? e.code : null,
        stdout,
        stderr,
        output: { argv: argv.length, maxBufferExceeded: true },
        error: { code: 'output-limit-exceeded', message: `the process output exceeded the bounded buffer and the process was killed` },
        cancelled: false,
        truncated: true,
      };
    }
    // Spawn failure (ENOENT etc.) vs non-zero exit.
    const exitCode = typeof e.code === 'number' ? e.code : null;
    return {
      exitCode,
      stdout,
      stderr,
      output: { argv: argv.length },
      error: {
        code: exitCode !== null ? 'non-zero-exit' : 'process-error',
        message:
          exitCode !== null
            ? `the process exited with code ${exitCode}`
            : `${e.name ?? 'Error'}: ${e.message ?? String(err)}`,
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
