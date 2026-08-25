/**
 * WORK-036 — Tool Runtime regression matrix.
 *
 * REAL governed execution end-to-end: a REAL git repository + REAL
 * worktrees (the WORK-035 materializer), REAL processes (node via the
 * governed process engine), a REAL local HTTP server, and a fake browser
 * DRIVER behind the real port. Every invocation goes through the full
 * chain:
 *
 *   ExecutionRecord → ExecutionSession (running) → Workspace (ready)
 *     → ToolRuntime (policy seam → executor → observation).
 *
 * The matrix covers the frozen requirements:
 *   1  filesystem read                  11 HTTP abstraction contract
 *   2  filesystem write                 12 identity links execution/session/workspace
 *   3  path traversal rejection         13 concurrent invocation behavior
 *   4  workspace boundary enforcement   14 crash/retry behavior
 *   5  terminal command execution       15 failure is not success
 *   6  stdout/stderr/exit-code capture  16 no workflow/verification/review mutation
 *   7  terminal cancellation            17 native observations normalized
 *   8  git runs in the correct workspace 18 external observations normalized
 *   9  package/test workspace boundary  19 credentials cannot enter payloads
 *   10 browser abstraction contract     20 no arbitrary host filesystem escape
 * + the policy seam (deny/ask/constrained), the session/workspace gates,
 *   the audit trail, and the git remote-authority denial.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgExecutionSessionRepository } from '../../../src/modules/agents/internal/pg-execution-session-repository.js';
import { DefaultExecutionSessionService } from '../../../src/modules/agents/internal/execution-session-service.js';
import { PgAgentWorkspaceRepository } from '../../../src/modules/agents/internal/pg-agent-workspace-repository.js';
import { DefaultAgentWorkspaceService } from '../../../src/modules/agents/internal/agent-workspace-service.js';
import { DefaultToolRuntime } from '../../../src/modules/agents/internal/tool-runtime-service.js';
import { DefaultToolPolicyGate, ToolRuntimeError } from '../../../src/modules/agents/internal/tool-runtime.types.js';
import type { ToolPolicyGate } from '../../../src/modules/agents/internal/tool-runtime.types.js';
import { FsToolExecutor } from '../../../src/platform/tools/fs-tool-executor.js';
import { ProcessToolExecutor } from '../../../src/platform/tools/process-tool-executor.js';
import { HttpToolExecutor } from '../../../src/platform/tools/http-tool-executor.js';
import { BrowserToolExecutor } from '../../../src/platform/tools/browser-tool-executor.js';
import { NamespaceProcessSandbox } from '../../../src/platform/tools/process-sandbox.js';
import type { BrowserDriver } from '../../../src/platform/tools/browser-tool-executor.js';
import { FsWorktreeMaterializer } from '../../../src/platform/workspace/fs-worktree-materializer.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import type { ToolExecutor, ToolFamily, ToolExecutionOutcome } from '@platform/tools/tool-contracts.js';

const execFileAsync = promisify(execFile);

const OWNER = 'w036-org';
const REPO = 'w036-repo';

/** A counting/gating executor wrapper (drives the concurrency tests). */
class CountingExecutor implements ToolExecutor {
  readonly family: ToolFamily;
  readonly calls: ToolFamilyRecord[] = [];
  private next: Promise<ToolExecutionOutcome>;
  private resolveNext!: (o: ToolExecutionOutcome) => void;

  constructor(
    family: ToolFamily,
    private readonly inner: ToolExecutor | null,
    outcome?: ToolExecutionOutcome,
  ) {
    this.family = family;
    this.next = new Promise((res) => {
      this.resolveNext = res;
      if (outcome) res(outcome);
    });
  }

  /** Unblock a gated execution (first use only). */
  release(outcome: ToolExecutionOutcome): void {
    this.resolveNext(outcome);
  }

  async execute(request: ToolFamilyRecord, ctx: Parameters<ToolExecutor['execute']>[1]): Promise<ToolExecutionOutcome> {
    this.calls.push(request);
    if (this.inner) return this.inner.execute(request, ctx);
    return this.next;
  }
}

type ToolFamilyRecord = Parameters<ToolExecutor['execute']>[0];

/** The fake provider browser driver (behind the REAL port). */
class FakeBrowserDriver implements BrowserDriver {
  readonly opened: string[] = [];
  async open(url: string): Promise<{ finalUrl: string; status: number | null; title: string | null }> {
    this.opened.push(url);
    return { finalUrl: url, status: 200, title: 'Fake Page' };
  }
  async click(selector: string): Promise<{ matched: boolean; finalUrl: string }> {
    void selector; // recorded by the executor; the fake only reports matching
    return { matched: selector !== '#missing', finalUrl: 'https://example.test/page' };
  }
  async type(selector: string, text: string): Promise<{ matched: boolean; finalUrl: string }> {
    void selector;
    void text;
    return { matched: true, finalUrl: 'https://example.test/page' };
  }
  async extract(selector: string): Promise<{ matched: boolean; text: string; finalUrl: string }> {
    return { matched: true, text: `extracted-for:${selector}`, finalUrl: 'https://example.test/page' };
  }
  async screenshot(): Promise<{ base64: string; finalUrl: string }> {
    return { base64: Buffer.from('fake-png-bytes').toString('base64'), finalUrl: 'https://example.test/page' };
  }
}

describe('WORK-036 — Tool Runtime (governed tools inside the WORK-035 workspace)', () => {
  let stack: TestAuthStack;
  let executionRecordRepo: PgExecutionRecordRepository;
  let sessionRepo: PgExecutionSessionRepository;
  let sessionService: DefaultExecutionSessionService;
  let workspaceRepo: PgAgentWorkspaceRepository;
  let workspaceService: DefaultAgentWorkspaceService;
  let auditService: DefaultAuditService;
  let runtime: DefaultToolRuntime;

  let root: string;
  let repositoryDir: string;
  let baseSha: string;
  let materializer: FsWorktreeMaterializer;
  let httpServer: Server;
  let httpPort: number;
  const browserDriver = new FakeBrowserDriver();

  let orgId: string;
  let projectId: string;
  let workItemId: string;
  let workOrderId: string;
  let sharedContextId: string;

  let execCount = 0;
  const nextExecId = () => `exec-w036-${++execCount}`;

  /** An injectable policy gate (the WORK-037 seam tests override it). */
  let customGate: ToolPolicyGate | undefined;

  beforeAll(async () => {
    process.env.AGENT_PROVIDER_NAME = 'fake';
    process.env.AGENT_API_KEY = 'test-agent-key';
    process.env.AGENT_DEFAULT_MODEL = 'test-model';
    // A host-side secret that must NEVER reach a child process env.
    process.env.W036_HOST_SECRET = 'host-secret-value';

    stack = await buildAuthStack({ AGENT_API_KEY: 'test-agent-key' });
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    sessionRepo = new PgExecutionSessionRepository(stack.db.client);
    sessionService = new DefaultExecutionSessionService({
      sessionRepository: sessionRepo,
      executionRecordRepository: executionRecordRepo,
      logger: stack.db.logger,
    });
    auditService = new DefaultAuditService(stack.db.client, stack.db.logger);

    // The REAL git repository the worktrees attach to (platform bootstrap).
    root = await mkdtemp(join(tmpdir(), 'w036-tools-'));
    repositoryDir = join(root, OWNER, REPO);
    await mkdir(repositoryDir, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repositoryDir });
    await execFileAsync('git', ['config', 'user.email', 'test@workflowos.invalid'], { cwd: repositoryDir });
    await execFileAsync('git', ['config', 'user.name', 'W036 Test'], { cwd: repositoryDir });
    await writeFile(join(repositoryDir, 'README.md'), '# w036 base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repositoryDir });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repositoryDir });
    baseSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryDir })).stdout.trim();

    materializer = new FsWorktreeMaterializer({ rootDir: root, logger: stack.db.logger });

    workspaceRepo = new PgAgentWorkspaceRepository({
      db: stack.db.client,
      executionRecordRepository: executionRecordRepo,
      projectGitHubRepositoryLookup: {
        findByProject: async (pid: string) => {
          const row = await stack.db.client.query<{
            id: string; project_id: string; owner: string; repository: string;
            default_branch: string; installation_id: string;
          }>(
            `SELECT id, project_id, owner, repository, default_branch, installation_id
               FROM wfos_project_github_repositories WHERE project_id = $1 LIMIT 1`,
            [pid],
          );
          const r = row.rows[0];
          return r
            ? {
                id: r.id, projectId: r.project_id, owner: r.owner, repository: r.repository,
                defaultBranch: r.default_branch, installationId: r.installation_id,
              }
            : null;
        },
      },
      baselineResolver: {
        getBranch: async () => ({ sha: baseSha }),
      },
    });
    workspaceService = new DefaultAgentWorkspaceService({
      workspaceRepository: workspaceRepo,
      materializer,
      logger: stack.db.logger,
    });

    const gate: ToolPolicyGate = {
      decide: async (req) => {
        if (customGate) return customGate.decide(req);
        return new DefaultToolPolicyGate().decide();
      },
    };

    // PR #40 review fix: the REAL namespace sandbox — every process-family
    // test now proves its behavior THROUGH the kernel-enforced boundary
    // (the same one app.ts wires).
    const processSandbox = new NamespaceProcessSandbox({ logger: stack.db.logger });
    runtime = new DefaultToolRuntime({
      sessionService,
      sessionRepository: sessionRepo,
      workspaceRepository: workspaceRepo,
      materializer,
      executors: {
        filesystem: new FsToolExecutor({ logger: stack.db.logger }),
        terminal: new ProcessToolExecutor('terminal', { logger: stack.db.logger, sandbox: processSandbox }),
        git: new ProcessToolExecutor('git', { logger: stack.db.logger, sandbox: processSandbox }),
        package: new ProcessToolExecutor('package', { logger: stack.db.logger, sandbox: processSandbox }),
        http: new HttpToolExecutor({ logger: stack.db.logger }),
        browser: new BrowserToolExecutor({ logger: stack.db.logger, driver: browserDriver }),
      },
      policyGate: gate,
      auditWriter: auditService,
      logger: stack.db.logger,
    });

    // A local HTTP server (loopback only — no external network dependency).
    httpServer = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/hello') {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-custom': 'custom-value' });
        res.end('hello-world');
        return;
      }
      if (url === '/setcookie') {
        res.writeHead(200, { 'set-cookie': 'session=abc123; Path=/', 'content-type': 'text/plain' });
        res.end('cookie-set');
        return;
      }
      if (url === '/redirect') {
        res.writeHead(302, { location: '/hello' });
        res.end();
        return;
      }
      if (url === '/large') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(64 * 1024, 0x61)); // 64 KiB of 'a'
        return;
      }
      if (url === '/notfound') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
        return;
      }
      if (url === '/echo' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(`echo:${body}`);
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((res) => httpServer.listen(0, '127.0.0.1', res));
    httpPort = (httpServer.address() as { port: number }).port;

    // The project chain + the /github authority row.
    const org = await stack.organizationRepository.create({ name: 'W036 Org' });
    orgId = org.id;
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'W036 Project' });
    projectId = project.id;
    await stack.db.client.query(
      `INSERT INTO wfos_project_github_repositories
         (project_id, installation_id, owner, repository, default_branch, link_type)
       VALUES ($1, 'inst-w036', $2, $3, 'main', 'linked')`,
      [projectId, OWNER, REPO],
    );
    const arch = await stack.architectureRepository.create({ projectId, name: 'W036 Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W036' });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id, workItemId: 'WORK-W036-001',
      title: 'Tool runtime', objective: 'Governed tools.', scope: 'src/', outOfScope: 'none',
      metadata: { baseCommit: baseSha },
    });
    const workOrder = await stack.workOrderRepository.create({
      workItemId: workItem.id, projectId, architectureVersionId: version.id,
      requirementIds: [], criterionIds: [], scope: 'src/', verificationRequirements: [],
    });
    workItemId = workItem.id;
    workOrderId = workOrder.id;
    const contextRepo = new PgImplementationContextRepository(stack.db.client);
    const ctx = await contextRepo.create({
      workItemId, revision: 1, kind: 'initial',
      content: { prompt: 'w036 context' } as never,
    });
    sharedContextId = ctx.id;
  }, 120_000);

  afterAll(async () => {
    delete process.env.W036_HOST_SECRET;
    await new Promise<void>((res) => httpServer.close(() => res()));
    await rm(root, { recursive: true, force: true });
    await stack.teardown();
  });

  /** A running session + a READY workspace (the full governed chain). */
  async function makeReadyChain(): Promise<{ executionId: string; sessionId: string; workspaceId: string; hostPath: string }> {
    const executionId = nextExecId();
    await executionRecordRepo.create({
      executionId,
      projectId,
      workItemId,
      workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `digest-${executionId}`,
    });
    const claim = await workspaceService.acquireWorkspace({
      executionId,
      branch: `feat/w036-${execCount}`,
    });
    const session = await sessionService.ensureSession(executionId);
    await sessionService.startSession(session.id);
    return { executionId, sessionId: session.id, workspaceId: claim.workspace.id, hostPath: claim.hostPath };
  }

  /** The observation events recorded for a session. */
  async function observationsFor(sessionId: string) {
    const events = await sessionRepo.listEvents(sessionId);
    return events.filter((e) => e.eventType === 'observation');
  }

  // ---------------------------------------------------------------------------
  // 1–4: filesystem + the boundary
  // ---------------------------------------------------------------------------

  it('filesystem write + read round-trip inside the workspace (bounded, observed)', async () => {
    const chain = await makeReadyChain();
    const write = await runtime.invoke({
      invocationId: 'w036-fs-write-1',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'write', path: 'notes/hello.txt', content: 'tool-runtime-content' },
      idempotency: 'idempotent',
    });
    expect(write.record.status).toBe('succeeded');
    expect(write.record.tool).toEqual({ family: 'filesystem', operation: 'fs.write' });
    // The file is REALLY inside the worktree.
    const onDisk = await readFile(join(chain.hostPath, 'notes/hello.txt'), 'utf8');
    expect(onDisk).toBe('tool-runtime-content');

    const read = await runtime.invoke({
      invocationId: 'w036-fs-read-1',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'read', path: 'notes/hello.txt' },
      idempotency: 'idempotent',
    });
    expect(read.record.status).toBe('succeeded');
    expect(read.record.output).toMatchObject({ path: 'notes/hello.txt', content: 'tool-runtime-content', truncated: false });
  });

  it('path traversal is REJECTED as an observable failed outcome (never host access)', async () => {
    const chain = await makeReadyChain();
    for (const bad of ['../outside.txt', '../../etc/passwd', 'notes/../../escape.txt']) {
      const res = await runtime.invoke({
        invocationId: `w036-trav-${bad.length}-${bad.slice(-6)}`,
        executionId: chain.executionId,
        family: 'filesystem',
        input: { operation: 'read', path: bad },
        idempotency: 'idempotent',
      });
      expect(res.record.status, `path ${bad}`).toBe('failed');
      expect(res.record.error?.code, `path ${bad}`).toBe('workspace-boundary-violation');
    }
  });

  it('the workspace boundary is ENFORCED: absolute paths + symlink escapes rejected', async () => {
    const chain = await makeReadyChain();
    // Absolute path.
    const abs = await runtime.invoke({
      invocationId: 'w036-boundary-abs',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'read', path: '/etc/passwd' },
      idempotency: 'idempotent',
    });
    expect(abs.record.status).toBe('failed');
    expect(abs.record.error?.code).toBe('workspace-boundary-violation');

    // Symlink escape: a symlink inside the worktree pointing OUTSIDE.
    const outsideFile = join(root, 'outside-secret.txt');
    await writeFile(outsideFile, 'outside-secret');
    await symlink(outsideFile, join(chain.hostPath, 'escape-link.txt'));
    const link = await runtime.invoke({
      invocationId: 'w036-boundary-symlink',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'read', path: 'escape-link.txt' },
      idempotency: 'idempotent',
    });
    expect(link.record.status).toBe('failed');
    expect(link.record.error?.code).toBe('workspace-boundary-violation');
  });

  // ---------------------------------------------------------------------------
  // 5–7: terminal
  // ---------------------------------------------------------------------------

  it('terminal command execution with full capture (argv-separated, no shell)', async () => {
    const chain = await makeReadyChain();
    const res = await runtime.invoke({
      invocationId: 'w036-term-1',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-e', 'console.log("term-out"); console.error("term-err"); process.exit(3)'] },
      idempotency: 'non-idempotent',
    });
    // A non-zero exit is a FAILED invocation (never reported as success)…
    expect(res.record.status).toBe('failed');
    expect(res.record.exitCode).toBe(3);
    // …with BOTH streams + the exit code captured.
    expect(res.record.stdout).toContain('term-out');
    expect(res.record.stderr).toContain('term-err');
    expect(res.record.error?.code).toBe('non-zero-exit');

    const ok = await runtime.invoke({
      invocationId: 'w036-term-2',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-e', 'process.stdout.write("plain-ok")'] },
      idempotency: 'idempotent',
    });
    expect(ok.record.status).toBe('succeeded');
    expect(ok.record.exitCode).toBe(0);
    expect(ok.record.stdout).toBe('plain-ok');
  });

  it('terminal cancellation: the caller AbortSignal interrupts the process (cancelled, observed)', async () => {
    const chain = await makeReadyChain();
    const controller = new AbortController();
    const invocation = runtime.invoke({
      invocationId: 'w036-term-cancel',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-e', 'setInterval(() => {}, 50)'] },
      idempotency: 'non-idempotent',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    const res = await invocation;
    expect(res.record.status).toBe('cancelled');
    expect(res.record.error?.code).toBe('cancelled');
    // The interruption is DURABLY observed.
    const obs = await observationsFor(chain.sessionId);
    expect(obs.some((e) => e.payload.invocationId === 'w036-term-cancel' && (e.payload.record as { status: string }).status === 'cancelled')).toBe(true);
  });

  it('the terminal timeout bound kills the process (a bounded, failed outcome)', async () => {
    const chain = await makeReadyChain();
    const res = await runtime.invoke({
      invocationId: 'w036-term-timeout',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-e', 'setInterval(() => {}, 50)'], timeoutMs: 200 },
      idempotency: 'non-idempotent',
    });
    expect(res.record.status).toBe('failed');
    expect(res.record.error?.code).toBe('timeout');
  });

  // ---------------------------------------------------------------------------
  // 8: git
  // ---------------------------------------------------------------------------

  it('git operations run inside the CORRECT workspace worktree', async () => {
    const chain = await makeReadyChain();
    await runtime.invoke({
      invocationId: 'w036-git-setup',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'write', path: 'git-tracked-file.txt', content: 'staged by the fs tool' },
      idempotency: 'idempotent',
    });
    const status = await runtime.invoke({
      invocationId: 'w036-git-status',
      executionId: chain.executionId,
      family: 'git',
      input: { args: ['status', '--porcelain'] },
      idempotency: 'idempotent',
    });
    expect(status.record.status).toBe('succeeded');
    // The untracked file written INSIDE this worktree appears in git status
    // — the git tool operated against THIS execution's worktree.
    expect(status.record.stdout).toContain('git-tracked-file.txt');
    expect(status.record.tool).toEqual({ family: 'git', operation: 'git.status' });
  });

  it('git remote-network operations are DENIED (the /github authority is never duplicated)', async () => {
    const chain = await makeReadyChain();
    for (const [id, args] of [
      ['w036-git-push', ['push', 'origin', 'main']],
      ['w036-git-fetch', ['fetch', 'origin']],
      ['w036-git-clone', ['clone', 'https://github.com/x/y.git']],
    ] as const) {
      const res = await runtime.invoke({
        invocationId: id,
        executionId: chain.executionId,
        family: 'git',
        input: { args: [...args] },
        idempotency: 'idempotent',
      });
      expect(res.record.status, id).toBe('failed');
      expect(res.record.error?.code, id).toBe('git-remote-operation-forbidden');
    }
    // A cwd/git-dir redirect attempt is rejected too.
    const redirect = await runtime.invoke({
      invocationId: 'w036-git-redirect',
      executionId: chain.executionId,
      family: 'git',
      input: { args: ['-C', '/etc', 'status'] },
      idempotency: 'idempotent',
    });
    expect(redirect.record.status).toBe('failed');
    expect(redirect.record.error?.code).toBe('git-redirect-forbidden');
  });

  // ---------------------------------------------------------------------------
  // 9: package/test
  // ---------------------------------------------------------------------------

  it('package/test execution uses the workspace boundary (bare runner, confined cwd)', async () => {
    const chain = await makeReadyChain();
    await runtime.invoke({
      invocationId: 'w036-pkg-mkdir',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'mkdir', path: 'pkg-out' },
      idempotency: 'idempotent',
    });
    const res = await runtime.invoke({
      invocationId: 'w036-pkg-run',
      executionId: chain.executionId,
      family: 'package',
      input: {
        runner: 'node',
        args: ['-e', 'require("fs").writeFileSync("pkg-out/result.txt", "pkg-ran")'],
        cwd: '.',
      },
      idempotency: 'non-idempotent',
    });
    expect(res.record.status).toBe('succeeded');
    // The runner wrote INSIDE the worktree (the confined cwd).
    const onDisk = await readFile(join(chain.hostPath, 'pkg-out/result.txt'), 'utf8');
    expect(onDisk).toBe('pkg-ran');
    expect(res.record.tool).toEqual({ family: 'package', operation: 'package.node' });

    // A cwd escape attempt fails closed…
    const escape = await runtime.invoke({
      invocationId: 'w036-pkg-escape',
      executionId: chain.executionId,
      family: 'package',
      input: { runner: 'node', args: ['-e', 'process.exit(0)'], cwd: '../..' },
      idempotency: 'idempotent',
    });
    expect(escape.record.status).toBe('failed');
    expect(escape.record.error?.code).toBe('workspace-boundary-violation');
    // …and an arbitrary-binary runner (a path) is not a capability at all.
    const binary = await runtime.invoke({
      invocationId: 'w036-pkg-binary',
      executionId: chain.executionId,
      family: 'package',
      input: { runner: '/bin/sh', args: ['-c', 'true'] },
      idempotency: 'idempotent',
    });
    expect(binary.record.status).toBe('failed');
    expect(binary.record.error?.code).toBe('package-runner-path-forbidden');
  });

  // ---------------------------------------------------------------------------
  // 10: browser
  // ---------------------------------------------------------------------------

  it('browser abstraction: the driver port is decoupled, observations normalized + bounded', async () => {
    const chain = await makeReadyChain();
    const open = await runtime.invoke({
      invocationId: 'w036-browser-open',
      executionId: chain.executionId,
      family: 'browser',
      input: { operation: 'open', url: 'https://example.test/page' },
      idempotency: 'idempotent',
    });
    expect(open.record.status).toBe('succeeded');
    expect(browserDriver.opened).toContain('https://example.test/page');
    expect(open.record.tool).toEqual({ family: 'browser', operation: 'browser.open' });
    expect(open.record.output).toMatchObject({ finalUrl: 'https://example.test/page', status: 200, title: 'Fake Page' });

    const extract = await runtime.invoke({
      invocationId: 'w036-browser-extract',
      executionId: chain.executionId,
      family: 'browser',
      input: { operation: 'extract', selector: '#main' },
      idempotency: 'idempotent',
    });
    expect(extract.record.status).toBe('succeeded');
    expect(extract.record.output).toMatchObject({ selector: '#main', text: 'extracted-for:#main' });
    // A browser observation is EVIDENCE — it decided no workflow state
    // (asserted structurally below; here the record is observation-only).
    expect(extract.record.origin).toBe('native');
  });

  it('browser without a driver fails CLOSED (typed, observable — never a silent no-op)', async () => {
    const chain = await makeReadyChain();
    const noDriver = new DefaultToolRuntime({
      sessionService,
      sessionRepository: sessionRepo,
      workspaceRepository: workspaceRepo,
      materializer,
      executors: { browser: new BrowserToolExecutor({ logger: stack.db.logger }) },
      policyGate: new DefaultToolPolicyGate(),
      logger: stack.db.logger,
    });
    const res = await noDriver.invoke({
      invocationId: 'w036-browser-nodriver',
      executionId: chain.executionId,
      family: 'browser',
      input: { operation: 'open', url: 'https://example.test/x' },
      idempotency: 'idempotent',
    });
    expect(res.record.status).toBe('failed');
    expect(res.record.error?.code).toBe('browser-driver-unavailable');
  });

  // ---------------------------------------------------------------------------
  // 11: HTTP
  // ---------------------------------------------------------------------------

  it('HTTP abstraction: explicit URL/method/headers/body + bounded response + data-not-verdict status', async () => {
    const chain = await makeReadyChain();
    const get = await runtime.invoke({
      invocationId: 'w036-http-get',
      executionId: chain.executionId,
      family: 'http',
      input: { url: `http://127.0.0.1:${httpPort}/hello`, method: 'GET' },
      idempotency: 'idempotent',
    });
    expect(get.record.status).toBe('succeeded');
    expect(get.record.tool).toEqual({ family: 'http', operation: 'http.GET' });
    expect(get.record.output).toMatchObject({
      status: 200,
      body: 'hello-world',
      finalUrl: `http://127.0.0.1:${httpPort}/hello`,
      redirected: false,
    });
    const headers = (get.record.output as { headers: Record<string, string> }).headers;
    expect(headers['x-custom']).toBe('custom-value');

    // Redirects are followed + observable.
    const redirect = await runtime.invoke({
      invocationId: 'w036-http-redirect',
      executionId: chain.executionId,
      family: 'http',
      input: { url: `http://127.0.0.1:${httpPort}/redirect`, method: 'GET' },
      idempotency: 'idempotent',
    });
    expect(redirect.record.output).toMatchObject({ status: 200, redirected: true, body: 'hello-world' });

    // POST with a body round-trips.
    const post = await runtime.invoke({
      invocationId: 'w036-http-post',
      executionId: chain.executionId,
      family: 'http',
      input: { url: `http://127.0.0.1:${httpPort}/echo`, method: 'POST', body: 'payload-123' },
      idempotency: 'non-idempotent',
    });
    expect(post.record.output).toMatchObject({ status: 200, body: 'echo:payload-123' });

    // A bounded response body (maxResponseBytes) truncates observably.
    const large = await runtime.invoke({
      invocationId: 'w036-http-large',
      executionId: chain.executionId,
      family: 'http',
      input: { url: `http://127.0.0.1:${httpPort}/large`, method: 'GET', maxResponseBytes: 1024 },
      idempotency: 'idempotent',
    });
    expect(large.record.truncated).toBe(true);
    expect(Buffer.byteLength((large.record.output as { body: string }).body, 'utf8')).toBeLessThanOrEqual(1024);

    // An HTTP 404 is DATA (the capability succeeded; the status is
    // recorded) — never conflated with a verification verdict.
    const notFound = await runtime.invoke({
      invocationId: 'w036-http-404',
      executionId: chain.executionId,
      family: 'http',
      input: { url: `http://127.0.0.1:${httpPort}/notfound`, method: 'GET' },
      idempotency: 'idempotent',
    });
    expect(notFound.record.status).toBe('succeeded');
    expect(notFound.record.output).toMatchObject({ status: 404 });

    // A transport failure is a FAILED outcome (error semantics).
    const dead = await runtime.invoke({
      invocationId: 'w036-http-dead',
      executionId: chain.executionId,
      family: 'http',
      input: { url: 'http://127.0.0.1:1/nope', method: 'GET', timeoutMs: 2000 },
      idempotency: 'idempotent',
    });
    expect(dead.record.status).toBe('failed');
    expect(dead.record.error?.code).toBe('http-network-error');

    // A non-http(s) scheme + embedded userinfo are rejected outright.
    const scheme = await runtime.invoke({
      invocationId: 'w036-http-scheme',
      executionId: chain.executionId,
      family: 'http',
      input: { url: 'file:///etc/passwd', method: 'GET' },
      idempotency: 'idempotent',
    });
    expect(scheme.record.status).toBe('failed');
    expect(scheme.record.error?.code).toBe('http-scheme-forbidden');
  });

  // ---------------------------------------------------------------------------
  // 12 + 17: identity links + normalized native observations
  // ---------------------------------------------------------------------------

  it('the invocation identity links execution + session + workspace; the observation is normalized', async () => {
    const chain = await makeReadyChain();
    const res = await runtime.invoke({
      invocationId: 'w036-identity-1',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-e', 'process.stdout.write("identity")'] },
      idempotency: 'idempotent',
    });
    const r = res.record;
    expect(r.invocationId).toBe('w036-identity-1');
    expect(r.executionId).toBe(chain.executionId);
    expect(r.sessionId).toBe(chain.sessionId);
    expect(r.workspaceId).toBe(chain.workspaceId);
    expect(r.origin).toBe('native');
    expect(r.tool).toEqual({ family: 'terminal', operation: 'terminal.exec' });
    expect(r.policy).toEqual({ decision: 'allow', reason: undefined });
    expect(r.startedAt).toBeTruthy();
    expect(r.completedAt).toBeTruthy();
    expect(r.status).toBe('succeeded');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('identity');
    // The full normalized contract key set.
    for (const key of [
      'invocationId', 'executionId', 'sessionId', 'workspaceId', 'origin', 'tool',
      'input', 'policy', 'startedAt', 'completedAt', 'status', 'exitCode',
      'stdout', 'stderr', 'output', 'error', 'truncated',
    ]) {
      expect(r).toHaveProperty(key);
    }

    // The durable evidence: a tool_call marker + an observation event on
    // the SESSION (the existing evidence architecture — no parallel store).
    const events = await sessionRepo.listEvents(chain.sessionId);
    const marker = events.find((e) => e.eventType === 'tool_call' && e.payload.invocationId === 'w036-identity-1');
    const observation = events.find((e) => e.eventType === 'observation' && e.payload.invocationId === 'w036-identity-1');
    expect(marker).toBeDefined();
    expect(observation).toBeDefined();
    expect((observation!.payload as { record: { invocationId: string } }).record.invocationId).toBe('w036-identity-1');
    expect(marker!.sequenceNumber).toBeLessThan(observation!.sequenceNumber);

    // The audit boundary carries the governance trail.
    const auditEvents = await auditService.listForProject(projectId, {
      eventTypes: ['tool.invocation.succeeded'],
    });
    expect(auditEvents.some((a) => a.resourceId === 'w036-identity-1' && a.executionId === chain.executionId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 13: concurrency
  // ---------------------------------------------------------------------------

  it('concurrent SAME-invocationId calls execute EXACTLY ONCE (in-flight dedupe + one observation)', async () => {
    const chain = await makeReadyChain();
    const counting = new CountingExecutor('terminal', null, {
      exitCode: 0, stdout: 'once', stderr: '', output: null, error: null, cancelled: false, truncated: false,
    });
    const runtime2 = new DefaultToolRuntime({
      sessionService,
      sessionRepository: sessionRepo,
      workspaceRepository: workspaceRepo,
      materializer,
      executors: { terminal: counting },
      policyGate: new DefaultToolPolicyGate(),
      logger: stack.db.logger,
    });
    const [a, b] = await Promise.all([
      runtime2.invoke({
        invocationId: 'w036-concurrent-same',
        executionId: chain.executionId,
        family: 'terminal',
        input: { argv: ['node', '-v'] },
        idempotency: 'idempotent',
      }),
      runtime2.invoke({
        invocationId: 'w036-concurrent-same',
        executionId: chain.executionId,
        family: 'terminal',
        input: { argv: ['node', '-v'] },
        idempotency: 'idempotent',
      }),
    ]);
    expect(counting.calls.length).toBe(1); // ONE execution
    expect(a.record).toEqual(b.record); // both callers see the SAME outcome
    expect(a.record.stdout).toBe('once');
    const obs = (await observationsFor(chain.sessionId)).filter((e) => e.payload.invocationId === 'w036-concurrent-same');
    expect(obs.length).toBe(1); // ONE durable observation
  });

  it('concurrent DIFFERENT invocationIds both execute (no global tool lock)', async () => {
    const chain = await makeReadyChain();
    const [a, b] = await Promise.all([
      runtime.invoke({
        invocationId: 'w036-concurrent-a',
        executionId: chain.executionId,
        family: 'terminal',
        input: { argv: ['node', '-e', 'process.stdout.write("A")'] },
        idempotency: 'idempotent',
      }),
      runtime.invoke({
        invocationId: 'w036-concurrent-b',
        executionId: chain.executionId,
        family: 'terminal',
        input: { argv: ['node', '-e', 'process.stdout.write("B")'] },
        idempotency: 'idempotent',
      }),
    ]);
    expect(a.record.status).toBe('succeeded');
    expect(b.record.status).toBe('succeeded');
    expect(a.record.stdout).toBe('A');
    expect(b.record.stdout).toBe('B');
  });

  // ---------------------------------------------------------------------------
  // 14: crash/retry
  // ---------------------------------------------------------------------------

  it('retry after a COMPLETED observation REPLAYS (the idempotent no-duplicate-effect contract)', async () => {
    const chain = await makeReadyChain();
    const counting = new CountingExecutor('terminal', null, {
      exitCode: 0, stdout: 'first-run', stderr: '', output: null, error: null, cancelled: false, truncated: false,
    });
    const runtime2 = new DefaultToolRuntime({
      sessionService,
      sessionRepository: sessionRepo,
      workspaceRepository: workspaceRepo,
      materializer,
      executors: { terminal: counting },
      policyGate: new DefaultToolPolicyGate(),
      logger: stack.db.logger,
    });
    const first = await runtime2.invoke({
      invocationId: 'w036-retry-replay',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-v'] },
      idempotency: 'idempotent',
    });
    expect(first.replayed).toBe(false);
    expect(first.record.stdout).toBe('first-run');
    const second = await runtime2.invoke({
      invocationId: 'w036-retry-replay',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-v'] },
      idempotency: 'idempotent',
    });
    expect(second.replayed).toBe(true);
    expect(second.record).toEqual(first.record); // the SAME record — not a re-run
    expect(counting.calls.length).toBe(1); // executed ONCE
  });

  it('a NON-IDEMPOTENT retry after a crash (dangling claim) reports UNKNOWN — never a false success', async () => {
    const chain = await makeReadyChain();
    const counting = new CountingExecutor('terminal', null, {
      exitCode: 0, stdout: '', stderr: '', output: null, error: null, cancelled: false, truncated: false,
    });
    const runtime2 = new DefaultToolRuntime({
      sessionService,
      sessionRepository: sessionRepo,
      workspaceRepository: workspaceRepo,
      materializer,
      executors: { terminal: counting },
      policyGate: new DefaultToolPolicyGate(),
      logger: stack.db.logger,
    });
    // Simulate the crash: the durable claim exists, the completion does not.
    await sessionRepo.claimToolInvocation(chain.sessionId, 'w036-crash-unknown', {
      executionId: chain.executionId,
      status: 'requested',
    });
    const res = await runtime2.invoke({
      invocationId: 'w036-crash-unknown',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-v'] },
      idempotency: 'non-idempotent',
    });
    expect(res.record.status).toBe('unknown');
    expect(res.record.error?.code).toBe('tool-runtime-unknown-outcome');
    expect(counting.calls.length).toBe(0); // NOTHING re-executed
    // The uncertainty is DURABLY observed.
    const obs = await observationsFor(chain.sessionId);
    const unknown = obs.find((e) => e.payload.invocationId === 'w036-crash-unknown');
    expect((unknown!.payload as { record: { status: string } }).record.status).toBe('unknown');
  });

  it('an IDEMPOTENT retry after a crash re-runs safely (the dangling claim is harmless)', async () => {
    const chain = await makeReadyChain();
    const counting = new CountingExecutor('terminal', null, {
      exitCode: 0, stdout: 'recovered', stderr: '', output: null, error: null, cancelled: false, truncated: false,
    });
    const runtime2 = new DefaultToolRuntime({
      sessionService,
      sessionRepository: sessionRepo,
      workspaceRepository: workspaceRepo,
      materializer,
      executors: { terminal: counting },
      policyGate: new DefaultToolPolicyGate(),
      logger: stack.db.logger,
    });
    await sessionRepo.claimToolInvocation(chain.sessionId, 'w036-crash-idem', {
      executionId: chain.executionId,
      status: 'requested',
    });
    const res = await runtime2.invoke({
      invocationId: 'w036-crash-idem',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-v'] },
      idempotency: 'idempotent',
    });
    expect(res.record.status).toBe('succeeded');
    expect(counting.calls.length).toBe(1); // safely re-run exactly once
    expect(res.record.stdout).toBe('recovered');
  });

  // ---------------------------------------------------------------------------
  // 15: failure fidelity
  // ---------------------------------------------------------------------------

  it('tool failure is NEVER reported as success (exit codes, missing files, executor errors)', async () => {
    const chain = await makeReadyChain();
    // Non-zero exit.
    const exit = await runtime.invoke({
      invocationId: 'w036-fail-exit',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-e', 'process.exit(7)'] },
      idempotency: 'non-idempotent',
    });
    expect(exit.record.status).toBe('failed');
    expect(exit.record.exitCode).toBe(7);
    // Missing file.
    const missing = await runtime.invoke({
      invocationId: 'w036-fail-missing',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'read', path: 'does-not-exist.txt' },
      idempotency: 'idempotent',
    });
    expect(missing.record.status).toBe('failed');
    expect(missing.record.error?.code).toBe('filesystem-error');
    // A missing executable — PR #40 review fix: the failure now happens
    // INSIDE the sandbox (the setup shell reports 127), which is the
    // honest semantics: the SANDBOX worked; the TOOL does not exist.
    // (A sandbox-level failure would be 'process-sandbox-unavailable'.)
    const noBinary = await runtime.invoke({
      invocationId: 'w036-fail-nobinary',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['w036-no-such-binary-xyz'] },
      idempotency: 'idempotent',
    });
    expect(noBinary.record.status).toBe('failed');
    expect(noBinary.record.error?.code).toBe('non-zero-exit');
    expect(noBinary.record.exitCode).toBe(127);
    // Invalid input (the typed contract error).
    const invalid = await runtime
      .invoke({
        invocationId: 'w036-fail-invalid',
        executionId: chain.executionId,
        family: 'terminal',
        input: { argv: [] },
        idempotency: 'idempotent',
      })
      .catch((e) => e);
    expect(invalid).toBeInstanceOf(ToolRuntimeError);
    expect(invalid.code).toBe('tool-runtime-invalid-input');
  });

  // ---------------------------------------------------------------------------
  // 16: authority isolation
  // ---------------------------------------------------------------------------

  it('tool observations NEVER mutate workflow/verification/review authority', async () => {
    const chain = await makeReadyChain();
    const countsBefore = await stack.db.client.query<{
      wf: string; vr: string; rv: string; wi: string; ex: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM wfos_workflow_executions) AS wf,
         (SELECT COUNT(*)::text FROM wfos_verification_runs) AS vr,
         (SELECT COUNT(*)::text FROM wfos_reviews) AS rv,
         (SELECT COUNT(*)::text FROM wfos_work_items) AS wi,
         (SELECT COUNT(*)::text FROM wfos_executions) AS ex`,
    );
    await runtime.invoke({
      invocationId: 'w036-authority-1',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-e', 'process.stdout.write("authority-check")'] },
      idempotency: 'idempotent',
    });
    await runtime.invoke({
      invocationId: 'w036-authority-2',
      executionId: chain.executionId,
      family: 'git',
      input: { args: ['status', '--porcelain'] },
      idempotency: 'idempotent',
    });
    const countsAfter = await stack.db.client.query<{
      wf: string; vr: string; rv: string; wi: string; ex: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM wfos_workflow_executions) AS wf,
         (SELECT COUNT(*)::text FROM wfos_verification_runs) AS vr,
         (SELECT COUNT(*)::text FROM wfos_reviews) AS rv,
         (SELECT COUNT(*)::text FROM wfos_work_items) AS wi,
         (SELECT COUNT(*)::text FROM wfos_executions) AS ex`,
    );
    expect(countsAfter.rows[0]).toEqual(countsBefore.rows[0]);
  });

  // ---------------------------------------------------------------------------
  // 18: external parity
  // ---------------------------------------------------------------------------

  it('external provider observations flow through the SAME normalized contract (no execution, no authority)', async () => {
    const executionId = nextExecId();
    await executionRecordRepo.create({
      executionId,
      projectId,
      workItemId,
      workOrderId,
      implementationContextId: sharedContextId,
      mode: 'external', provider: 'fake-external', model: null,
      prompt: `p ${executionId}`, promptDigest: `digest-${executionId}`,
    });
    const external = await runtime.recordExternalObservation({
      invocationId: 'w036-external-1',
      executionId,
      family: 'terminal',
      operation: 'terminal.exec',
      completedAt: new Date().toISOString(),
      status: 'succeeded',
      exitCode: 0,
      stdout: 'provider-side output',
      source: 'companion:fake-external',
    });
    expect(external.replayed).toBe(false);
    expect(external.record.origin).toBe('external');
    expect(external.record.workspaceId).toBeNull(); // the provider-native environment
    expect(external.record.status).toBe('succeeded');
    expect(external.record.tool).toEqual({ family: 'terminal', operation: 'terminal.exec' });
    // The SAME normalized key set as native observations.
    for (const key of [
      'invocationId', 'executionId', 'sessionId', 'workspaceId', 'origin', 'tool',
      'input', 'policy', 'startedAt', 'completedAt', 'status', 'exitCode',
      'stdout', 'stderr', 'output', 'error', 'truncated',
    ]) {
      expect(external.record).toHaveProperty(key);
    }
    // Appended to the SESSION evidence log as an observation.
    const session = await sessionService.getSessionForExecution(executionId);
    const obs = (await observationsFor(session!.id)).filter((e) => e.payload.invocationId === 'w036-external-1');
    expect(obs.length).toBe(1);

    // A duplicate invocationId is an idempotent REPLAY (no second event).
    const dup = await runtime.recordExternalObservation({
      invocationId: 'w036-external-1',
      executionId,
      family: 'terminal',
      operation: 'terminal.exec',
      completedAt: new Date().toISOString(),
      status: 'succeeded',
    });
    expect(dup.replayed).toBe(true);
    expect((await observationsFor(session!.id)).filter((e) => e.payload.invocationId === 'w036-external-1').length).toBe(1);
  });

  it('an external observation for an unknown execution is the typed not-found error', async () => {
    const err = await runtime
      .recordExternalObservation({
        invocationId: 'w036-external-missing',
        executionId: 'exec-w036-never-exists',
        family: 'http',
        operation: 'http.GET',
        completedAt: new Date().toISOString(),
        status: 'failed',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ToolRuntimeError);
    expect(err.code).toBe('tool-runtime-session-not-found');
  });

  // ---------------------------------------------------------------------------
  // 19: credentials
  // ---------------------------------------------------------------------------

  it('credentials CANNOT enter durable tool payloads (redaction + sanitized child env)', async () => {
    const chain = await makeReadyChain();
    // Caller-explicit HTTP auth header: the request carries it (explicit),
    // the OBSERVATION redacts it.
    const http = await runtime.invoke({
      invocationId: 'w036-cred-http',
      executionId: chain.executionId,
      family: 'http',
      input: {
        url: `http://127.0.0.1:${httpPort}/hello`,
        method: 'GET',
        headers: { Authorization: 'Bearer super-secret-token', 'X-Custom': 'keep-me' },
      },
      idempotency: 'idempotent',
    });
    const sentHeaders = (http.record.input as { headers: Record<string, string> }).headers;
    expect(sentHeaders.Authorization).toBe('[REDACTED]');
    expect(sentHeaders['X-Custom']).toBe('keep-me');
    // Response set-cookie is redacted in the output.
    const cookieRes = await runtime.invoke({
      invocationId: 'w036-cred-cookie',
      executionId: chain.executionId,
      family: 'http',
      input: { url: `http://127.0.0.1:${httpPort}/setcookie`, method: 'GET' },
      idempotency: 'idempotent',
    });
    const outHeaders = (cookieRes.record.output as { headers: Record<string, string> }).headers;
    expect(outHeaders['set-cookie']).toBe('[REDACTED]');

    // A secret-shaped env key is redacted in the observation…
    const env = await runtime.invoke({
      invocationId: 'w036-cred-env',
      executionId: chain.executionId,
      family: 'terminal',
      input: {
        argv: ['node', '-e', 'process.stdout.write("env-check")'],
        env: { MY_API_KEY: 'abc123', VISIBLE: 'plain' },
      },
      idempotency: 'idempotent',
    });
    expect((env.record.input as { env: Record<string, string> }).env.MY_API_KEY).toBe('[REDACTED]');
    expect((env.record.input as { env: Record<string, string> }).env.VISIBLE).toBe('plain');

    // …and the HOST environment (which holds secrets) is NOT inherited by
    // the child process.
    const host = await runtime.invoke({
      invocationId: 'w036-cred-host',
      executionId: chain.executionId,
      family: 'terminal',
      input: {
        argv: ['node', '-e', 'process.stdout.write(process.env.W036_HOST_SECRET ?? "absent")'],
      },
      idempotency: 'idempotent',
    });
    expect(host.record.stdout).toBe('absent'); // the host secret never reached the child
  });

  // ---------------------------------------------------------------------------
  // 20: no host escape (terminal cwd + git redirect)
  // ---------------------------------------------------------------------------

  it('NO arbitrary host filesystem escape from ANY family (terminal cwd, fs absolute, git -C, package runner)', async () => {
    const chain = await makeReadyChain();
    const cwdEscape = await runtime.invoke({
      invocationId: 'w036-escape-cwd',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-e', 'process.stdout.write("x")'], cwd: '../../../' },
      idempotency: 'idempotent',
    });
    expect(cwdEscape.record.status).toBe('failed');
    expect(cwdEscape.record.error?.code).toBe('workspace-boundary-violation');

    const absCwd = await runtime.invoke({
      invocationId: 'w036-escape-abs',
      executionId: chain.executionId,
      family: 'terminal',
      input: { argv: ['node', '-e', 'process.stdout.write("x")'], cwd: '/etc' },
      idempotency: 'idempotent',
    });
    expect(absCwd.record.status).toBe('failed');
    expect(absCwd.record.error?.code).toBe('workspace-boundary-violation');
  });

  // ---------------------------------------------------------------------------
  // The policy seam (WORK-037's future surface — live in WORK-036)
  // ---------------------------------------------------------------------------

  it('the policy seam: deny + ask BLOCK execution (observable, no executor call); constrained read-only refuses mutations', async () => {
    const chain = await makeReadyChain();
    const counting = new CountingExecutor('filesystem', null, {
      exitCode: null, stdout: '', stderr: '', output: { path: 'x' }, error: null, cancelled: false, truncated: false,
    });
    const runtime2 = new DefaultToolRuntime({
      sessionService,
      sessionRepository: sessionRepo,
      workspaceRepository: workspaceRepo,
      materializer,
      executors: { filesystem: counting },
      policyGate: {
        decide: async (req) => {
          if (req.invocationId === 'w036-policy-deny') {
            return { decision: 'deny', reason: 'not permitted for this execution' };
          }
          if (req.invocationId === 'w036-policy-ask') {
            return { decision: 'ask', reason: 'requires human approval' };
          }
          if (req.invocationId === 'w036-policy-readonly') {
            return { decision: 'constrained', constraints: { readOnly: true } };
          }
          return { decision: 'allow' };
        },
      },
      logger: stack.db.logger,
    });
    const denied = await runtime2.invoke({
      invocationId: 'w036-policy-deny',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'read', path: 'README.md' },
      idempotency: 'idempotent',
    });
    expect(denied.record.status).toBe('blocked');
    expect(denied.record.policy).toEqual({ decision: 'deny', reason: 'not permitted for this execution' });
    expect(denied.record.error?.code).toBe('policy-deny');

    const asked = await runtime2.invoke({
      invocationId: 'w036-policy-ask',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'read', path: 'README.md' },
      idempotency: 'idempotent',
    });
    expect(asked.record.status).toBe('blocked');
    expect(asked.record.policy?.decision).toBe('ask');
    expect(asked.record.error?.code).toBe('policy-ask');

    // Constrained read-only: a WRITE is blocked, a READ executes.
    const write = await runtime2.invoke({
      invocationId: 'w036-policy-readonly',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'write', path: 'blocked.txt', content: 'x' },
      idempotency: 'idempotent',
    });
    expect(write.record.status).toBe('blocked');
    expect(write.record.error?.code).toBe('policy-constrained-read-only');
    const read = await runtime2.invoke({
      invocationId: 'w036-policy-readonly-read',
      executionId: chain.executionId,
      family: 'filesystem',
      input: { operation: 'read', path: 'README.md' },
      idempotency: 'idempotent',
    });
    expect(read.record.status).toBe('succeeded');

    // NOTHING executed for the blocked invocations (the seam precedes the
    // executor — the capability never ran).
    expect(counting.calls.length).toBe(1); // only the allowed read
    // The blocked decisions are DURABLY observed.
    const obs = await observationsFor(chain.sessionId);
    expect(obs.some((e) => e.payload.invocationId === 'w036-policy-deny' && (e.payload.record as { status: string }).status === 'blocked')).toBe(true);
    expect(obs.some((e) => e.payload.invocationId === 'w036-policy-ask' && (e.payload.record as { status: string }).status === 'blocked')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // The chain gates (session/workspace state enforcement)
  // ---------------------------------------------------------------------------

  it('the chain gates: no session / not-running session / no workspace / not-ready workspace are typed errors', async () => {
    // No session at all.
    const executionId = nextExecId();
    await executionRecordRepo.create({
      executionId,
      projectId,
      workItemId,
      workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `digest-${executionId}`,
    });
    const noSession = await runtime
      .invoke({
        invocationId: 'w036-gate-nosession',
        executionId,
        family: 'filesystem',
        input: { operation: 'read', path: 'README.md' },
        idempotency: 'idempotent',
      })
      .catch((e) => e);
    expect(noSession).toBeInstanceOf(ToolRuntimeError);
    expect(noSession.code).toBe('tool-runtime-session-not-found');

    // A session that is created but NOT running.
    const session = await sessionService.ensureSession(executionId);
    const notRunning = await runtime
      .invoke({
        invocationId: 'w036-gate-notrunning',
        executionId,
        family: 'filesystem',
        input: { operation: 'read', path: 'README.md' },
        idempotency: 'idempotent',
      })
      .catch((e) => e);
    expect(notRunning).toBeInstanceOf(ToolRuntimeError);
    expect(notRunning.code).toBe('tool-runtime-session-not-running');

    // Running session but NO workspace.
    await sessionService.startSession(session.id);
    const noWorkspace = await runtime
      .invoke({
        invocationId: 'w036-gate-noworkspace',
        executionId,
        family: 'filesystem',
        input: { operation: 'read', path: 'README.md' },
        idempotency: 'idempotent',
      })
      .catch((e) => e);
    expect(noWorkspace).toBeInstanceOf(ToolRuntimeError);
    expect(noWorkspace.code).toBe('tool-runtime-workspace-not-found');

    // A workspace stuck in 'requested' (never acquired) is NOT ready.
    const executionId2 = nextExecId();
    await executionRecordRepo.create({
      executionId: executionId2,
      projectId,
      workItemId,
      workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId2}`, promptDigest: `digest-${executionId2}`,
    });
    await workspaceRepo.ensureWorkspace({ executionId: executionId2, branch: 'feat/w036-notready' });
    const session2 = await sessionService.ensureSession(executionId2);
    await sessionService.startSession(session2.id);
    const notReady = await runtime
      .invoke({
        invocationId: 'w036-gate-notready',
        executionId: executionId2,
        family: 'filesystem',
        input: { operation: 'read', path: 'README.md' },
        idempotency: 'idempotent',
      })
      .catch((e) => e);
    expect(notReady).toBeInstanceOf(ToolRuntimeError);
    expect(notReady.code).toBe('tool-runtime-workspace-not-ready');
  });

  it('a malformed invocationId is the typed invalid-input error (the durable key contract)', async () => {
    const chain = await makeReadyChain();
    for (const bad of ['', 'has space', 'x'.repeat(129), 'bad;key']) {
      const err = await runtime
        .invoke({
          invocationId: bad,
          executionId: chain.executionId,
          family: 'filesystem',
          input: { operation: 'read', path: 'README.md' },
          idempotency: 'idempotent',
        })
        .catch((e) => e);
      expect(err, JSON.stringify(bad)).toBeInstanceOf(ToolRuntimeError);
      expect(err.code).toBe('tool-runtime-invalid-input');
    }
  });

  it('an unsupported family (no executor wired) is the typed unsupported-family error', async () => {
    const chain = await makeReadyChain();
    const runtime2 = new DefaultToolRuntime({
      sessionService,
      sessionRepository: sessionRepo,
      workspaceRepository: workspaceRepo,
      materializer,
      executors: {}, // nothing wired
      policyGate: new DefaultToolPolicyGate(),
      logger: stack.db.logger,
    });
    const err = await runtime2
      .invoke({
        invocationId: 'w036-unsupported',
        executionId: chain.executionId,
        family: 'http',
        input: { url: `http://127.0.0.1:${httpPort}/hello`, method: 'GET' },
        idempotency: 'idempotent',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ToolRuntimeError);
    expect(err.code).toBe('tool-runtime-unsupported-family');
  });
});
