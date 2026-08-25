/**
 * WORK-036 (PR #40 review fix): the PROCESS SANDBOX confinement
 * regression — the architect's blocking finding was that the tool
 * runtime confined only the WORKING DIRECTORY while claiming
 * "no arbitrary host filesystem access from any family":
 *
 *     cwd confined ≠ process filesystem/network confined
 *
 * Every test below drives the REAL executors through the REAL
 * NamespaceProcessSandbox (the same wiring app.ts uses) against a REAL
 * git repository + worktree, with REAL node processes — and proves:
 *
 *   * legitimate workspace-local development commands STILL run
 *     (node scripts, git status/log/commit — including git run through
 *     the TERMINAL family, the exact bypass route the review called out);
 *   * a native terminal invocation CANNOT escape the workspace through
 *     absolute filesystem access, ../ paths, git -C /outside, host
 *     environment/configuration (incl. /proc/<pid>/environ of host
 *     processes), or direct network access;
 *   * a hostile sandboxed process cannot remount, unstack, or unmount
 *     the frozen sandbox (capabilities are dropped before exec);
 *   * the stale host root left by pivot_root (/.putold) is SEALED;
 *   * an unusable sandbox fails CLOSED (typed outcome, no process);
 *   * the setup script is a frozen constant — user argv travels as
 *     POSITIONAL parameters (no interpolation, no injection surface);
 *   * the git object store bind derives from the WORK-035 layout —
 *     NEVER from the tamperable .git pointer file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { Logger } from '@platform/logger.js';
import type { ToolExecutorContext } from '@platform/tools/tool-contracts.js';
import { DEFAULT_TOOL_EXECUTION_LIMITS } from '@platform/tools/tool-contracts.js';
import { ProcessToolExecutor } from '../../../src/platform/tools/process-tool-executor.js';
import {
  NamespaceProcessSandbox,
  NAMESPACE_SANDBOX_SETUP_SCRIPT,
  ProcessSandboxError,
} from '../../../src/platform/tools/process-sandbox.js';
import type { ProcessSandbox } from '../../../src/platform/tools/process-sandbox.js';

const execFileAsync = promisify(execFile);

const OWNER = 'w036-owner';
const REPO = 'sandbox-repo';
const EXEC_ID = 'w036-sbx-exec-1';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

describe('WORK-036 process sandbox (PR #40 review fix) — cwd confinement is NOT process confinement; the namespace sandbox closes the gap', () => {
  let root: string;
  let repositoryDir: string;
  let worktreeDir: string;
  let unrelatedRepoDir: string;
  let plainDir: string;
  let httpServer: Server;
  let httpPort: number;

  let sandbox: NamespaceProcessSandbox;
  let terminalExec: ProcessToolExecutor;
  let gitExec: ProcessToolExecutor;
  let packageExec: ProcessToolExecutor;
  let ctx: ToolExecutorContext;

  beforeAll(async () => {
    // A host-side secret that must NEVER be visible to a sandboxed process.
    process.env.W036_SANDBOX_HOST_SECRET = 'must-never-leak';

    // The workspace layout: <root>/<owner>/<repository>/exec/<id>.
    root = await mkdtemp(join(tmpdir(), 'w036-sbx-'));
    repositoryDir = join(root, OWNER, REPO);
    worktreeDir = join(repositoryDir, 'exec', EXEC_ID);
    await mkdir(repositoryDir, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repositoryDir });
    await execFileAsync('git', ['config', 'user.email', 'sbx@workflowos.invalid'], { cwd: repositoryDir });
    await execFileAsync('git', ['config', 'user.name', 'SBX Test'], { cwd: repositoryDir });
    await writeFile(join(repositoryDir, 'README.md'), '# base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repositoryDir });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repositoryDir });
    await execFileAsync('git', ['worktree', 'add', worktreeDir, '-b', 'sbx-branch'], { cwd: repositoryDir });

    // A host marker OUTSIDE the worktree (inside the workspace ROOT, but
    // outside the repository — invisible to the sandbox).
    await writeFile(join(root, 'host-marker.txt'), 'HOST-ONLY-SECRET-MARKER\n');

    // A completely unrelated host repository (for the git -C escape route).
    unrelatedRepoDir = await mkdtemp(join(tmpdir(), 'w036-unrelated-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: unrelatedRepoDir });
    await writeFile(join(unrelatedRepoDir, 'secret.txt'), 'UNRELATED-REPO-SECRET\n');
    await execFileAsync('git', ['add', '.'], { cwd: unrelatedRepoDir });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: unrelatedRepoDir });

    // A plain (non-worktree) directory workspace.
    plainDir = await mkdtemp(join(tmpdir(), 'w036-plain-'));

    // The local HTTP server the network test must NOT reach.
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('reachable');
    });
    await new Promise<void>((res) => httpServer.listen(0, '127.0.0.1', res));
    httpPort = (httpServer.address() as { port: number }).port;

    // The REAL wiring (one shared sandbox — the probe runs once).
    sandbox = new NamespaceProcessSandbox({ logger });
    terminalExec = new ProcessToolExecutor('terminal', { logger, sandbox });
    gitExec = new ProcessToolExecutor('git', { logger, sandbox });
    packageExec = new ProcessToolExecutor('package', { logger, sandbox });
    ctx = { workspaceRoot: worktreeDir, limits: DEFAULT_TOOL_EXECUTION_LIMITS };
  });

  afterAll(async () => {
    await new Promise<void>((res) => httpServer.close(() => res()));
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(unrelatedRepoDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(plainDir, { recursive: true, force: true }).catch(() => undefined);
    delete process.env.W036_SANDBOX_HOST_SECRET;
  });

  // -------------------------------------------------------------------------
  // Legitimate workspace-local development commands still run.
  // -------------------------------------------------------------------------

  it('legitimate workspace-local development commands still run (node writes + reads INSIDE the worktree)', async () => {
    const out = await terminalExec.execute(
      {
        argv: [
          'node',
          '-e',
          'const fs = require("fs"); fs.writeFileSync("made-by-tool.txt", "sandbox-rw-ok"); process.stdout.write(fs.readFileSync("made-by-tool.txt", "utf8"));',
        ],
      },
      ctx,
    );
    expect(out.error).toBeNull();
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('sandbox-rw-ok');
    expect(out.output).toMatchObject({ sandbox: 'linux-namespace-v1' });
    // The write landed on the HOST worktree (the bind is the real thing).
    expect(await readFile(join(worktreeDir, 'made-by-tool.txt'), 'utf8')).toBe('sandbox-rw-ok');
  });

  it('legitimate git operations run inside the worktree THROUGH the shared object store (git family)', async () => {
    const status = await gitExec.execute({ args: ['status', '--porcelain'] }, ctx);
    expect(status.error).toBeNull();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('?? made-by-tool.txt');

    const commit = await gitExec.execute({ args: ['commit', '--allow-empty', '-m', 'sbx-git-commit'] }, ctx);
    expect(commit.error).toBeNull();
    expect(commit.exitCode).toBe(0);
    // The commit landed in the SHARED .git on the host.
    const log = await execFileAsync('git', ['log', '-1', '--oneline'], { cwd: worktreeDir });
    expect(log.stdout).toContain('sbx-git-commit');
  });

  it('git through the TERMINAL family (the review bypass route) works for legitimate repository-LOCAL operations', async () => {
    const log = await terminalExec.execute({ argv: ['git', 'log', '--oneline'] }, ctx);
    expect(log.error).toBeNull();
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('base');

    const commit = await terminalExec.execute(
      {
        argv: [
          'git',
          '-c',
          'user.name=Terminal',
          '-c',
          'user.email=term@workflowos.invalid',
          'commit',
          '--allow-empty',
          '-m',
          'terminal-git-commit',
        ],
      },
      ctx,
    );
    expect(commit.error).toBeNull();
    expect(commit.exitCode).toBe(0);
    const hostLog = await execFileAsync('git', ['log', '-1', '--oneline'], { cwd: worktreeDir });
    expect(hostLog.stdout).toContain('terminal-git-commit');
  });

  it('package/test execution runs inside the sandbox (bare runner via PATH, confined cwd)', async () => {
    const run = await packageExec.execute({ runner: 'node', args: ['-e', 'process.stdout.write("pkg-ok")'] }, ctx);
    expect(run.error).toBeNull();
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('pkg-ok');

    await mkdir(join(worktreeDir, 'sub'), { recursive: true });
    const sub = await packageExec.execute(
      { runner: 'node', args: ['-e', 'require("fs").writeFileSync("from-sub.txt", "sub-ok")'], cwd: 'sub' },
      ctx,
    );
    expect(sub.error).toBeNull();
    expect(sub.exitCode).toBe(0);
    expect(await readFile(join(worktreeDir, 'sub', 'from-sub.txt'), 'utf8')).toBe('sub-ok');
  });

  it('a plain directory workspace (not a worktree) still runs sandboxed', async () => {
    const plainCtx: ToolExecutorContext = { workspaceRoot: plainDir, limits: DEFAULT_TOOL_EXECUTION_LIMITS };
    const out = await terminalExec.execute(
      {
        argv: [
          'node',
          '-e',
          'const fs = require("fs"); fs.writeFileSync("plain.txt", "plain-ok"); process.stdout.write(fs.readFileSync("plain.txt", "utf8"));',
        ],
      },
      plainCtx,
    );
    expect(out.error).toBeNull();
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('plain-ok');
  });

  // -------------------------------------------------------------------------
  // The escape routes are all BLOCKED.
  // -------------------------------------------------------------------------

  it('absolute host filesystem access is BLOCKED (markers outside the worktree, the main checkout, /etc/shadow; /etc/passwd is SYNTHETIC)', async () => {
    const targets = [
      join(root, 'host-marker.txt'),
      join(repositoryDir, 'README.md'),
      join(unrelatedRepoDir, 'secret.txt'),
      '/etc/shadow',
    ];
    const script =
      'const fs = require("fs"); ' +
      targets.map((t) => `try { console.log(${JSON.stringify(t)} + " => " + fs.readFileSync(${JSON.stringify(t)}, "utf8").slice(0, 40).replace(/\\n/g, "|")); } catch (e) { console.log(${JSON.stringify(t)} + " => ERR:" + e.code); }`).join(' ') +
      ' try { console.log("/etc/passwd => " + fs.readFileSync("/etc/passwd", "utf8").replace(/\\n/g, "|")); } catch (e) { console.log("/etc/passwd => ERR:" + e.code); }';
    const out = await terminalExec.execute({ argv: ['node', '-e', script] }, ctx);
    expect(out.exitCode).toBe(0);
    for (const t of targets) {
      expect(out.stdout).toContain(`${t} => ERR:`);
    }
    // The synthetic /etc/passwd — EXACTLY the two sandbox entries, never
    // the host's account database.
    expect(out.stdout).toContain(
      '/etc/passwd => root:x:0:0:root:/root:/bin/sh|nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin|',
    );
    expect(out.stdout).not.toContain('HOST-ONLY-SECRET-MARKER');
    expect(out.stdout).not.toContain('UNRELATED-REPO-SECRET');
  });

  it('../ traversal cannot escape the workspace (writes land on the sandbox tmpfs, NEVER on the host)', async () => {
    const out = await terminalExec.execute(
      {
        argv: [
          'node',
          '-e',
          'const fs = require("fs"); fs.writeFileSync("../escaped.txt", "x"); fs.writeFileSync("../../../../deep-escape.txt", "x"); fs.writeFileSync("/sandbox-root-write.txt", "x"); process.stdout.write("inside-writes-ok");',
        ],
      },
      ctx,
    );
    // All three writes SUCCEED inside the sandbox (they land on the
    // private tmpfs — that is the proof of namespace isolation, not a
    // permission accident).
    expect(out.error).toBeNull();
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('inside-writes-ok');
    // …and NONE of them exist on the HOST.
    const hostChecks = await Promise.all(
      [
        join(repositoryDir, 'exec', 'escaped.txt'),
        join(root, 'deep-escape.txt'),
        '/sandbox-root-write.txt',
      ].map(async (p) => {
        try {
          await readFile(p, 'utf8');
          return `PRESENT:${p}`;
        } catch {
          return `absent:${p}`;
        }
      }),
    );
    for (const check of hostChecks) {
      expect(check).not.toContain('PRESENT:');
    }
  });

  it('git -C <outside repository> is BLOCKED via the terminal family (the exact bypass route from the review)', async () => {
    const outside = await terminalExec.execute({ argv: ['git', '-C', unrelatedRepoDir, 'status'] }, ctx);
    expect(outside.exitCode).not.toBe(0);
    expect(outside.error?.code).toBe('non-zero-exit');

    const etc = await terminalExec.execute({ argv: ['git', '-C', '/etc', 'status'] }, ctx);
    expect(etc.exitCode).not.toBe(0);
    // The unrelated host repository is untouched.
    const hostStatus = await execFileAsync('git', ['status', '--porcelain'], { cwd: unrelatedRepoDir });
    expect(hostStatus.stdout).not.toContain('secret.txt');
  });

  it('the host environment and host processes are invisible (sanitized env, no /proc/<host-pid>/environ)', async () => {
    expect(process.pid).toBeGreaterThan(10); // the vitest worker's HOST pid
    const script =
      'const fs = require("fs"); ' +
      `console.log("ENVKEYS=" + Object.keys(process.env).sort().join(",")); ` +
      'console.log("SECRET=" + (process.env.W036_SANDBOX_HOST_SECRET ?? "absent")); ' +
      `console.log("HOSTPROC=" + fs.existsSync("/proc/${process.pid}/cmdline"));`;
    const out = await terminalExec.execute({ argv: ['node', '-e', script] }, ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('ENVKEYS=HOME,LANG,LC_ALL,NO_COLOR,PATH,PWD,TZ');
    expect(out.stdout).toContain('SECRET=absent');
    expect(out.stdout).toContain('HOSTPROC=false');
  });

  it('direct network access is BLOCKED from the sandbox (network is the HTTP family capability, not the terminal family)', async () => {
    // Control: the server IS reachable from the host side.
    const control = await fetch(`http://127.0.0.1:${httpPort}/`);
    expect(control.status).toBe(200);

    const out = await terminalExec.execute(
      {
        argv: [
          'node',
          '-e',
          `fetch("http://127.0.0.1:${httpPort}/").then(() => { console.log("CONNECTED-BAD"); }).catch(() => { console.log("BLOCKED"); process.exitCode = 7; });`,
        ],
        timeoutMs: 15_000,
      },
      ctx,
    );
    expect(out.stdout).toContain('BLOCKED');
    expect(out.stdout).not.toContain('CONNECTED-BAD');
    expect(out.exitCode).toBe(7);
  });

  it('a hostile process cannot remount, unstack, or unmount the frozen sandbox (capabilities dropped before exec)', async () => {
    const probe =
      'mount -t tmpfs tmpfs /tmp 2>&1; echo "rc-mount=$?"; ' +
      'umount /usr 2>&1; echo "rc-umount=$?"; ' +
      'mount -o remount,rw /usr 2>&1; echo "rc-remount=$?"; ' +
      'ls /.putold 2>&1; echo "rc-putold-ls=$?"; ' +
      'cat /.putold/etc/passwd 2>&1; echo "rc-putold-cat=$?"; ' +
      'mkdir -p /tmp/x && mount -t tmpfs tmpfs /tmp/x 2>&1; echo "rc-mount2=$?"';
    const out = await terminalExec.execute({ argv: ['/bin/sh', '-c', probe] }, ctx);
    expect(out.exitCode).toBe(0);
    const rcs = [...out.stdout.matchAll(/rc-[a-z2-]+=(\d+)/g)].map((m) => [m[0], Number(m[1])] as const);
    expect(rcs.length).toBe(6);
    for (const [name, rc] of rcs) {
      expect(rc, `${name} must FAIL (the sandbox mount tree is frozen)`).not.toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // Fail-closed + the launch shape.
  // -------------------------------------------------------------------------

  it('an unusable sandbox fails CLOSED — the typed outcome, and NO process is ever spawned', async () => {
    let wrapLaunchCalls = 0;
    const unavailable: ProcessSandbox = {
      id: 'unavailable-stub',
      ensureAvailable: async () => {
        throw new ProcessSandboxError('process-sandbox-unavailable', 'probe failed (stub)');
      },
      wrapLaunch: async () => {
        wrapLaunchCalls += 1;
        throw new ProcessSandboxError('process-sandbox-unavailable', 'unreachable');
      },
    };
    const exec = new ProcessToolExecutor('terminal', { logger, sandbox: unavailable });
    const out = await exec.execute({ argv: ['node', '-v'] }, ctx);
    expect(out.error?.code).toBe('process-sandbox-unavailable');
    expect(out.error?.message).toContain('probe failed (stub)');
    expect(out.exitCode).toBeNull();
    expect(out.cancelled).toBe(false);
    expect(out.output).toMatchObject({ sandbox: 'unavailable-stub' });
    expect(wrapLaunchCalls).toBe(0);
  });

  it('wrapLaunch: the frozen constant script + POSITIONAL argv (no interpolation, no injection surface)', async () => {
    const userArgv = ['node', '-e', 'console.log("MAGIC-USER-ARGV-9271")'];
    const env = { FOO: 'bar' };
    const wrapped = await sandbox.wrapLaunch({ argv: userArgv, cwd: worktreeDir, workspaceRoot: worktreeDir, env });
    expect(wrapped.argv[0]).toBe('unshare');
    const scriptIdx = wrapped.argv.indexOf(NAMESPACE_SANDBOX_SETUP_SCRIPT);
    expect(scriptIdx).toBeGreaterThan(0);
    // name + workspaceRoot + cwd + gitDir + extraRoots, then the user argv.
    expect(wrapped.argv[scriptIdx + 1]).toBe('workflowos-sandbox');
    expect(wrapped.argv[scriptIdx + 2]).toBe(worktreeDir);
    expect(wrapped.argv[scriptIdx + 3]).toBe(worktreeDir);
    expect(wrapped.argv.slice(scriptIdx + 6)).toEqual(userArgv);
    // The user data NEVER enters the script text.
    expect(NAMESPACE_SANDBOX_SETUP_SCRIPT).not.toContain('MAGIC-USER-ARGV-9271');
    // The environment passes through UNCHANGED (positional params only —
    // the sandbox never injects its own env keys).
    expect(wrapped.env).toEqual(env);
  });

  it('extra toolchain roots are validated (operator misconfiguration is refused, fail-closed)', async () => {
    expect(() => new NamespaceProcessSandbox({ extraToolchainRoots: ['/'] })).toThrow(ProcessSandboxError);
    expect(() => new NamespaceProcessSandbox({ extraToolchainRoots: ['relative/path'] })).toThrow(ProcessSandboxError);
    expect(() => new NamespaceProcessSandbox({ extraToolchainRoots: ['/usr/..'] })).toThrow(ProcessSandboxError);

    const containing = new NamespaceProcessSandbox({ extraToolchainRoots: [join(root, OWNER)] });
    await expect(
      containing.wrapLaunch({ argv: ['true'], cwd: worktreeDir, workspaceRoot: worktreeDir, env: {} }),
    ).rejects.toBeInstanceOf(ProcessSandboxError);

    const inside = new NamespaceProcessSandbox({ extraToolchainRoots: [join(worktreeDir, 'bin')] });
    await expect(
      inside.wrapLaunch({ argv: ['true'], cwd: worktreeDir, workspaceRoot: worktreeDir, env: {} }),
    ).rejects.toBeInstanceOf(ProcessSandboxError);
  });

  it('the git object store bind derives from the WORK-035 layout, never the tamperable .git pointer', async () => {
    const dotGitPath = join(worktreeDir, '.git');
    const original = await readFile(dotGitPath, 'utf8');
    const scriptIdx = (await sandbox.wrapLaunch({ argv: ['true'], cwd: worktreeDir, workspaceRoot: worktreeDir, env: {} })).argv.indexOf(
      NAMESPACE_SANDBOX_SETUP_SCRIPT,
    );
    // Sanity: the pointer file agrees with the layout today.
    expect(original).toContain(join(repositoryDir, '.git'));

    // TAMPER the pointer to name an arbitrary host path…
    await writeFile(dotGitPath, 'gitdir: /etc/.git/worktrees/pwned\n');
    try {
      const wrapped = await sandbox.wrapLaunch({ argv: ['true'], cwd: worktreeDir, workspaceRoot: worktreeDir, env: {} });
      // …the bind derivation does NOT move: the LAYOUT is the authority.
      expect(wrapped.argv[scriptIdx + 4]).toBe(join(repositoryDir, '.git'));

      // And git inside the sandbox FAILS (it follows the tampered pointer
      // into a path that is not there) — an observable failure, never an
      // escape.
      const status = await terminalExec.execute({ argv: ['git', 'status', '--porcelain'] }, ctx);
      expect(status.exitCode).not.toBe(0);
    } finally {
      await writeFile(dotGitPath, original);
    }
    // Restored: git works again.
    const ok = await terminalExec.execute({ argv: ['git', 'status', '--porcelain'] }, ctx);
    expect(ok.exitCode).toBe(0);
  });
});
