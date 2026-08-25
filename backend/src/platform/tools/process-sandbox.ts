/**
 * WORK-036 (PR #40 review fix): the PROCESS SANDBOX boundary — the
 * architectural correction of the finding that cwd confinement is NOT
 * process confinement.
 *
 * A process spawned with cwd=<worktree> can still `cat /etc/passwd`, run
 * `git -C /outside/repository …`, read the host environment through
 * /proc/<pid>/environ, and open sockets. Governing the argv and the
 * working directory governs the INVOCATION, not the PROCESS. The
 * namespace sandbox closes that gap at the kernel level:
 *
 *   WORK-035 Workspace
 *           ↓  (the worktree host path — the only writable surface)
 *   WORK-036 Tool Runtime → ProcessToolExecutor
 *           ↓  (wrapLaunch — ONE launch pipeline, no second engine)
 *   namespace sandbox → the actual process
 *
 * WHAT THE KERNEL ENFORCES (per invocation, zero host-side residue):
 *   * MOUNT namespace + pivot_root — the host filesystem is DETACHED:
 *     the sandbox root is a fresh tmpfs; the ONLY host paths inside are
 *     (a) the workspace worktree, read-write, at its exact host path;
 *     (b) the repository's shared `.git` object store (git's own worktree
 *         model — objects/refs are shared across worktrees BY DESIGN),
 *         derived from the WORK-035 layout, never from the tamperable
 *         `.git` pointer file;
 *     (c) the read-only system toolchain (/usr + the merged-usr symlinks
 *         + operator-configured extra roots);
 *     (d) a synthetic minimal /etc, /dev, and /proc (never host content).
 *     The stale old root is unmounted (best-effort) AND sealed under a
 *     mode-000 tmpfs cover.
 *   * NETWORK namespace — no interfaces: direct network access is
 *     impossible from any process family (network is the governed HTTP
 *     tool's capability, not the terminal's).
 *   * PID namespace — host processes (incl. this backend and its
 *     /proc/<pid>/environ credentials) are invisible; a fresh minimal
 *     /proc exposes only the sandboxed process itself.
 *   * IPC + UTS namespaces — no host SysV IPC objects, an isolated
 *     hostname.
 *   * USER namespace with map-root-user — the process owns the workspace
 *     files as its real uid, and gains the privileges needed ONLY to
 *     build the sandbox — then setpriv drops EVERY capability and sets
 *     no_new_privs right before exec, so the target process can never
 *     remount the read-only binds, unstack the cover, or regain
 *     CAP_SYS_ADMIN. The mount tree is FROZEN for the target.
 *
 * FAIL-CLOSED: if the sandbox primitives are unavailable (no unshare,
 * no user namespaces, no setpriv, blocked mounts), the process families
 * report the typed `process-sandbox-unavailable` outcome — there is NO
 * unsandboxed fallback anywhere.
 *
 * NOT a second execution engine: the sandbox computes the WRAPPED launch
 * (argv + env). Spawning, timeout, bounded output, cancellation and error
 * mapping remain ProcessToolExecutor's single execFile pipeline.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { deriveRepositoryDirFromWorktreePath } from '@platform/workspace/worktree-layout.js';
import type { Logger } from '@platform/logger.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** The launch the process engine wants to run (already workspace-confined). */
export interface ProcessSandboxLaunch {
  /** The EXPLICIT user argv (argv[0] = executable) — passed POSITIONALLY. */
  readonly argv: readonly string[];
  /** The confined working directory (host-absolute, inside the worktree). */
  readonly cwd: string;
  /** The WORK-035 worktree host path — the only writable host surface. */
  readonly workspaceRoot: string;
  /** The sanitized child environment (unchanged by the sandbox). */
  readonly env: Readonly<Record<string, string>>;
}

/** The wrapped launch the single execFile pipeline spawns. */
export interface WrappedProcessLaunch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The provider-independent sandbox port. One implementation ships
 * (NamespaceProcessSandbox); a future container/VM runtime (WORK-042+)
 * would implement the same port — the executor never knows which.
 */
export interface ProcessSandbox {
  /** The confinement identity recorded on every outcome (observability). */
  readonly id: string;
  /**
   * Fail-closed availability gate: resolves when the sandbox is usable on
   * this host, throws ProcessSandboxError otherwise. Cached per instance.
   */
  ensureAvailable(): Promise<void>;
  /**
   * Wrap a launch in the sandbox. PURE with respect to the launch: the
   * user argv is appended POSITIONALLY — never interpolated into any
   * script text (no shell-string surface, no injection surface).
   */
  wrapLaunch(launch: ProcessSandboxLaunch): Promise<WrappedProcessLaunch>;
}

// ---------------------------------------------------------------------------
// The typed error
// ---------------------------------------------------------------------------

export const PROCESS_SANDBOX_ERROR_CODES = ['process-sandbox-unavailable'] as const;
export type ProcessSandboxErrorCode = (typeof PROCESS_SANDBOX_ERROR_CODES)[number];

export class ProcessSandboxError extends Error {
  constructor(
    readonly code: ProcessSandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessSandboxError';
  }
}

// ---------------------------------------------------------------------------
// The namespace sandbox — the frozen setup script
// ---------------------------------------------------------------------------

/**
 * The COMPLETE sandbox setup script. FROZEN: a constant with NO
 * interpolation — every value it needs arrives as a POSITIONAL parameter
 * ($1=workspaceRoot $2=cwd $3=gitDir $4=extraToolchainRoots ':'-joined;
 * shift 4 → "$@" = the user argv). No caller-controlled data can ever
 * enter the script text.
 *
 * Requirements: Linux, util-linux `unshare`/`mount`/`setpriv`
 * (/usr/bin/setpriv), unprivileged user namespaces. The script fails
 * closed (`set -eu`) at the first unusable primitive.
 */
export const NAMESPACE_SANDBOX_SETUP_SCRIPT = `set -eu
WS=$1
CWD=$2
GITDIR=$3
EXTRA=$4
shift 4
STAGE=/mnt
mkdir -p "$STAGE" 2>/dev/null || true
mount -t tmpfs -o mode=0755,size=256m tmpfs "$STAGE"
mkdir -p "$STAGE/etc" "$STAGE/proc" "$STAGE/dev" "$STAGE/run" "$STAGE/root" "$STAGE/opt" "$STAGE/var/tmp" "$STAGE/tmp" "$STAGE/usr" "$STAGE/home"
chmod 1777 "$STAGE/tmp" "$STAGE/var/tmp"
mount --bind /usr "$STAGE/usr"
mount -o remount,bind,ro "$STAGE/usr"
for L in bin lib lib64 sbin; do
  if [ -L "/$L" ]; then
    ln -s "$(readlink "/$L")" "$STAGE/$L"
  elif [ -d "/$L" ]; then
    mkdir -p "$STAGE/$L"
    mount --bind "/$L" "$STAGE/$L"
    mount -o remount,bind,ro "$STAGE/$L"
  fi
done
if [ -n "$EXTRA" ]; then
  OLDIFS=$IFS
  IFS=:
  for P in $EXTRA; do
    if [ -n "$P" ] && [ -d "$P" ]; then
      mkdir -p "$STAGE$P"
      mount --bind "$P" "$STAGE$P"
      mount -o remount,bind,ro "$STAGE$P"
    fi
  done
  IFS=$OLDIFS
fi
printf 'root:x:0:0:root:/root:/bin/sh\\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\\n' > "$STAGE/etc/passwd"
printf 'root:x:0:\\nnogroup:x:65534:\\n' > "$STAGE/etc/group"
printf '127.0.0.1 localhost\\n::1 localhost\\n' > "$STAGE/etc/hosts"
for D in null zero random urandom; do
  : > "$STAGE/dev/$D"
  mount --bind "/dev/$D" "$STAGE/dev/$D"
done
mkdir -p "$STAGE/dev/shm"
chmod 1777 "$STAGE/dev/shm"
ln -s /proc/self/fd "$STAGE/dev/fd"
ln -s /proc/self/fd/0 "$STAGE/dev/stdin"
ln -s /proc/self/fd/1 "$STAGE/dev/stdout"
ln -s /proc/self/fd/2 "$STAGE/dev/stderr"
if ! mount -t proc proc "$STAGE/proc" 2>/dev/null; then
  mkdir -p "$STAGE/proc/self"
  mount --bind /proc/self "$STAGE/proc/self"
  : > "$STAGE/proc/cpuinfo"
  mount --bind /proc/cpuinfo "$STAGE/proc/cpuinfo"
  : > "$STAGE/proc/meminfo"
  mount --bind /proc/meminfo "$STAGE/proc/meminfo"
fi
mkdir -p "$STAGE$WS"
mount --bind "$WS" "$STAGE$WS"
if [ -n "$GITDIR" ] && [ -d "$GITDIR" ]; then
  mkdir -p "$STAGE$GITDIR"
  mount --bind "$GITDIR" "$STAGE$GITDIR"
fi
cd "$STAGE"
mkdir -p .putold
pivot_root /mnt /mnt/.putold
cd /
umount -l /.putold 2>/dev/null || true
mount -t tmpfs -o size=4k,mode=000 tmpfs /.putold
hostname workflowos-sandbox 2>/dev/null || true
test -x /usr/bin/setpriv
cd "$CWD"
unset OLDPWD
exec /usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- "$@"
`;

/** The unshare launcher prefix (the kernel-enforced isolation flags). */
const UNSHARE_ARGV = [
  'unshare',
  '--user',
  '--map-root-user',
  '--mount',
  '--net',
  '--pid',
  '--ipc',
  '--uts',
  '--fork',
  '--kill-child',
  '/bin/sh',
  '-c',
] as const;

// ---------------------------------------------------------------------------
// The namespace implementation
// ---------------------------------------------------------------------------

export interface NamespaceProcessSandboxOptions {
  /**
   * Operator-configured ADDITIONAL read-only toolchain roots (absolute
   * paths, ':'-unrelated — passed individually). For deployments whose
   * dev tooling lives outside /usr. Deployment-level system image
   * configuration ONLY — tool callers can never influence it. Rejected:
   * non-absolute paths, '/', and anything overlapping a workspace.
   */
  readonly extraToolchainRoots?: readonly string[];
  readonly logger?: Logger;
}

export class NamespaceProcessSandbox implements ProcessSandbox {
  readonly id = 'linux-namespace-v1';

  private readonly extraRoots: readonly string[];
  private readonly logger?: Logger;
  /** Cached successful availability probe (failures re-probe — transient). */
  private available = false;
  private probing: Promise<void> | undefined;

  constructor(options: NamespaceProcessSandboxOptions = {}) {
    const roots = options.extraToolchainRoots ?? [];
    for (const root of roots) {
      if (typeof root !== 'string' || !isAbsolute(root) || root === '/' || root.includes('..')) {
        throw new ProcessSandboxError(
          'process-sandbox-unavailable',
          `invalid extra toolchain root ${JSON.stringify(root)} — must be an absolute, non-root host path without '..'`,
        );
      }
    }
    this.extraRoots = [...roots];
    this.logger = options.logger;
  }

  async ensureAvailable(): Promise<void> {
    if (this.available) return;
    if (!this.probing) this.probing = this.probeOnce();
    try {
      await this.probing;
      this.available = true;
      this.logger?.info('tool.sandbox.probe.ok', { sandbox: this.id });
    } finally {
      this.probing = undefined;
    }
  }

  async wrapLaunch(launch: ProcessSandboxLaunch): Promise<WrappedProcessLaunch> {
    const workspaceRoot = normalizeHostPath(launch.workspaceRoot, 'workspaceRoot');
    const cwd = normalizeHostPath(launch.cwd, 'cwd');
    if (workspaceRoot === '/' || cwd === '/') {
      throw new ProcessSandboxError(
        'process-sandbox-unavailable',
        'the sandbox refuses a root ("/") workspace or working directory — that would bind the host',
      );
    }
    if (!pathContains(workspaceRoot, cwd)) {
      throw new ProcessSandboxError(
        'process-sandbox-unavailable',
        `the working directory ${cwd} is not inside the workspace ${workspaceRoot}`,
      );
    }
    for (const root of this.extraRoots) {
      if (pathContains(root, workspaceRoot) || pathContains(workspaceRoot, root)) {
        throw new ProcessSandboxError(
          'process-sandbox-unavailable',
          `extra toolchain root ${root} overlaps the workspace ${workspaceRoot} — refused`,
        );
      }
    }
    const gitDir = await this.resolveGitDir(workspaceRoot);
    const extra = this.extraRoots.join(':');
    return {
      argv: [
        ...UNSHARE_ARGV,
        NAMESPACE_SANDBOX_SETUP_SCRIPT,
        'workflowos-sandbox',
        workspaceRoot,
        cwd,
        gitDir,
        extra,
        ...launch.argv,
      ],
      env: launch.env,
    };
  }

  /**
   * The shared git object store a WORKTREE needs: derived from the
   * WORK-035 layout (the single source of truth — see
   * deriveRepositoryDirFromWorktreePath), NEVER from the worktree's
   * `.git` pointer file (which lives inside the writable worktree and
   * could be tampered with to widen the bind). Only bound when it exists
   * as a directory; a plain directory workspace has no separate store.
   */
  private async resolveGitDir(workspaceRoot: string): Promise<string> {
    const repositoryDir = deriveRepositoryDirFromWorktreePath(workspaceRoot);
    if (!repositoryDir) return '';
    const candidate = join(repositoryDir, '.git');
    try {
      const st = await stat(candidate);
      if (!st.isDirectory()) return '';
    } catch {
      return '';
    }
    return candidate;
  }

  /**
   * The full-pipeline probe: run `/bin/true` through the REAL sandbox
   * (every mount, the pivot, the cover, the capability drop) in a
   * throwaway directory. Any unusable primitive — missing unshare flags,
   * blocked user namespaces, missing setpriv, blocked mounts — surfaces
   * here as the typed error BEFORE a real invocation ever spawns.
   */
  private async probeOnce(): Promise<void> {
    const probeDir = await mkdtemp(join(tmpdir(), 'wfos-sandbox-probe-'));
    try {
      const launch = await this.wrapLaunch({
        argv: ['true'],
        cwd: probeDir,
        workspaceRoot: probeDir,
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      });
      await execFileAsync(launch.argv[0]!, launch.argv.slice(1) as string[], {
        cwd: probeDir,
        env: launch.env as Record<string, string>,
        timeout: 15_000,
        maxBuffer: 65_536,
      });
    } catch (err) {
      const e = err as { message?: string; stderr?: string };
      const detail = (e.stderr ?? e.message ?? String(err)).toString().slice(0, 400);
      this.logger?.warn('tool.sandbox.probe.failed', { sandbox: this.id, detail });
      throw new ProcessSandboxError(
        'process-sandbox-unavailable',
        `the namespace sandbox is not usable on this host (unshare/mount/pivot_root/setpriv or user namespaces unavailable): ${detail}`,
      );
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizeHostPath(p: string, field: string): string {
  if (typeof p !== 'string' || !isAbsolute(p)) {
    throw new ProcessSandboxError(
      'process-sandbox-unavailable',
      `${field} must be an absolute host path (got ${JSON.stringify(p)})`,
    );
  }
  let normalized = p;
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

/** True iff `descendant` equals or lives beneath `ancestor` (lexical). */
function pathContains(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const prefix = ancestor.endsWith('/') ? ancestor : ancestor + '/';
  return descendant.startsWith(prefix);
}
