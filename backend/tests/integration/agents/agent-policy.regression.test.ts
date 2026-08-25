/**
 * WORK-037 — Agent Policy & Permissions regression matrix.
 *
 * Three layers of proof:
 *
 *   1. ENGINE DECISION LOGIC (stub repository, no DB) — the policy
 *      contract: platform default posture, the four control domains,
 *      deny/ask/constrained, the ASK approval flow (approved/denied/
 *      pending/absent/expired), first-match-wins, hostGlob, org/project
 *      precedence, fail-closed (scope unresolvable + repo error), the
 *      version+ruleId reason, + the external-handoff eligibility surface.
 *      Includes the concurrency invariant (two parallel asks for the
 *      same subject → exactly ONE pending approval).
 *
 *   2. PERSISTENCE (real pglite) — the SQL durability contracts: version
 *      bump on document update (the trigger), the partial unique indexes
 *      (one org default, one project override per project), org/project
 *      precedence, approval idempotency under the partial unique index,
 *      approval resolution CAS (terminal evidence), markExpired, +
 *      scope resolution through the real execution→project→org chain.
 *
 *   3. SEAM INTEGRATION — the engine slots BEHIND the WORK-036
 *      ToolPolicyGate: DefaultToolRuntime wired with the engine as
 *      policyGate (+ a fake executor) → deny/ask produce durable
 *      'blocked' observations (executor NEVER called); constrained
 *      applies tightened limits; allow executes. No executor bypass.
 *
 * The invariant under test:
 *
 *   Auth / Project Authorization → Execution Policy → Tool Runtime → Sandbox
 *
 *   (no reverse dependency — the engine imports no workflow/auth module)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgAgentPolicyRepository } from '../../../src/modules/agents/internal/pg-agent-policy-repository.js';
import { AgentPolicyEngine } from '../../../src/modules/agents/internal/agent-policy-engine.js';
import { DefaultToolRuntime } from '../../../src/modules/agents/internal/tool-runtime-service.js';
import type {
  AgentPolicyApproval,
  AgentPolicyDocument,
  AgentPolicyDomain,
  AgentPolicyRepository,
  AgentPolicyResolution,
} from '../../../src/modules/agents/internal/agent-policy.types.js';
import type { ToolPolicyRequest } from '../../../src/modules/agents/internal/tool-runtime.types.js';
import type { ToolExecutor, ToolExecutionOutcome, ToolFamily, ToolExecutorContext } from '@platform/tools/tool-contracts.js';
import type { Logger } from '@platform/logger.js';

// ---------------------------------------------------------------------------
// A silent logger for the engine under test.
// ---------------------------------------------------------------------------
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// A stub repository for the decision-logic layer (no DB).
// ---------------------------------------------------------------------------
class StubPolicyRepository implements AgentPolicyRepository {
  scope: { organizationId: string; projectId: string } | null = {
    organizationId: 'org-1',
    projectId: 'proj-1',
  };
  // null → the engine falls to the platform default document.
  effective: AgentPolicyResolution | null = null;
  approvalsByKey = new Map<string, AgentPolicyApproval>();
  pendingCreations = 0;
  resolveCalls = 0;
  markExpiredCalls = 0;
  throwOnResolveScope = false;
  throwOnGetEffective = false;

  async resolveScope(): Promise<{ organizationId: string; projectId: string } | null> {
    if (this.throwOnResolveScope) throw new Error('stub: scope resolution failed');
    return this.scope;
  }
  async getEffectivePolicy(): Promise<AgentPolicyResolution | null> {
    if (this.throwOnGetEffective) throw new Error('stub: getEffective failed');
    return this.effective;
  }
  async getProjectPolicy(): Promise<AgentPolicyResolution | null> {
    return this.effective && this.effective.source === 'project' ? this.effective : null;
  }
  async getOrganizationPolicy(): Promise<AgentPolicyResolution | null> {
    return this.effective && this.effective.source === 'organization' ? this.effective : null;
  }
  async setProjectPolicy(): Promise<AgentPolicyResolution> {
    throw new Error('not used in stub tests');
  }
  async clearProjectPolicy(): Promise<boolean> {
    return false;
  }
  async setOrganizationPolicy(): Promise<AgentPolicyResolution> {
    throw new Error('not used in stub tests');
  }
  async clearOrganizationPolicy(): Promise<boolean> {
    return false;
  }
  async getLatestApproval(_executionId: string, subjectKey: string): Promise<AgentPolicyApproval | null> {
    return this.approvalsByKey.get(subjectKey) ?? null;
  }
  async getApproval(): Promise<AgentPolicyApproval | null> {
    return null;
  }
  async ensurePendingApproval(input: {
    subjectKey: string;
    subjectDomain: AgentPolicyDomain;
    requestedReason: string | null;
    expiresAt: string | null;
  }): Promise<AgentPolicyApproval> {
    this.pendingCreations++;
    const existing = this.approvalsByKey.get(input.subjectKey);
    if (existing && existing.status === 'pending') return existing;
    const approval: AgentPolicyApproval = {
      id: `apr-stub-${this.pendingCreations}`,
      organizationId: 'org-1',
      projectId: 'proj-1',
      executionId: 'exec-1',
      subjectDomain: input.subjectDomain,
      subjectFamily: null,
      subjectOperation: null,
      subjectHost: null,
      subjectKey: input.subjectKey,
      ruleId: 'stub-rule',
      policyVersion: 1,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      requestedReason: input.requestedReason,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      expiresAt: input.expiresAt,
    };
    this.approvalsByKey.set(input.subjectKey, approval);
    return approval;
  }
  async listApprovals(): Promise<readonly AgentPolicyApproval[]> {
    return [];
  }
  async resolve(input: { approvalId: string; action: 'approve' | 'deny'; userId: string; note?: string }): Promise<AgentPolicyApproval> {
    this.resolveCalls++;
    for (const a of this.approvalsByKey.values()) {
      if (a.id === input.approvalId && a.status === 'pending') {
        const resolved: AgentPolicyApproval = {
          ...a,
          status: input.action === 'approve' ? 'approved' : 'denied',
          resolvedBy: 'user-1',
          resolvedAt: new Date().toISOString(),
          resolutionNote: input.note ?? null,
        };
        this.approvalsByKey.set(a.subjectKey, resolved);
        return resolved;
      }
    }
    return null as never;
  }
  async markExpired(approvalId: string): Promise<void> {
    this.markExpiredCalls++;
    for (const a of this.approvalsByKey.values()) {
      if (a.id === approvalId) {
        this.approvalsByKey.set(a.subjectKey, { ...a, status: 'expired' });
      }
    }
  }
}

/** Build a ToolPolicyRequest for the engine's decide(). */
function req(overrides: Partial<ToolPolicyRequest> & { family: ToolFamily; operation: string }): ToolPolicyRequest {
  return {
    invocationId: 'inv-1',
    executionId: 'exec-1',
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    input: {},
    ...overrides,
  } as ToolPolicyRequest;
}

/** A document with one rule + a default. */
function doc(rules: AgentPolicyDocument['rules'], defaultEffect: 'allow' | 'deny' | 'ask' = 'allow'): AgentPolicyDocument {
  return { description: 'test', rules, defaultEffect };
}

function resolution(document: AgentPolicyDocument, version = 1, source: 'project' | 'organization' = 'project'): AgentPolicyResolution {
  return { source, document, policyVersion: version, organizationId: 'org-1', projectId: 'proj-1' };
}

// ===========================================================================
// LAYER 1 — ENGINE DECISION LOGIC (stub repository)
// ===========================================================================

describe('WORK-037 — Agent Policy Engine (decision logic, stub repository)', () => {
  let repo: StubPolicyRepository;
  let engine: AgentPolicyEngine;

  beforeEach(() => {
    repo = new StubPolicyRepository();
    engine = new AgentPolicyEngine({ repository: repo, logger: silentLogger, approvalTtlMs: 0 });
  });

  // --- platform default posture ---

  it('platform default: filesystem read → allow', async () => {
    const d = await engine.decide(req({ family: 'filesystem', operation: 'fs.read', input: { operation: 'read', path: 'a.ts' } }));
    expect(d.decision).toBe('allow');
    expect(d.reason).toMatch(/agent-policy v0/);
  });

  it('platform default: terminal → constrained (timeoutMs 120000)', async () => {
    const d = await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['echo', 'hi'] } }));
    expect(d.decision).toBe('constrained');
    expect(d.constraints?.timeoutMs).toBe(120_000);
  });

  it('platform default: package → constrained (timeoutMs 300000)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['test'] } }));
    expect(d.decision).toBe('constrained');
    expect(d.constraints?.timeoutMs).toBe(300_000);
  });

  it('platform default: git push → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.push', input: { args: ['push'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('platform default: git status → allow (local, not deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.status', input: { args: ['status'] } }));
    expect(d.decision).toBe('allow');
  });

  it('platform default: package publish → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['publish'] } }));
    expect(d.decision).toBe('deny');
  });

  it('platform default: http GET → allow', async () => {
    const d = await engine.decide(req({ family: 'http', operation: 'http.GET', input: { url: 'https://api.example.com/x', method: 'GET' } }));
    expect(d.decision).toBe('allow');
  });

  it('platform default: http POST → ask (network-mutating)', async () => {
    const d = await engine.decide(req({ family: 'http', operation: 'http.POST', input: { url: 'https://api.example.com/x', method: 'POST' } }));
    expect(d.decision).toBe('ask');
  });

  it('platform default: browser click → ask (network-mutating)', async () => {
    const d = await engine.decide(req({ family: 'browser', operation: 'browser.click', input: { operation: 'click', selector: '#x' } }));
    expect(d.decision).toBe('ask');
  });

  it('platform default: secrets-bearing invocation → ask (a redacted Authorization header)', async () => {
    // The gate sees the REDACTED input (the runtime redacts before decide()).
    const d = await engine.decide(
      req({ family: 'http', operation: 'http.GET', input: { url: 'https://api.example.com/x', method: 'GET', headers: { authorization: '[REDACTED]' } } }),
    );
    expect(d.decision).toBe('ask');
  });

  it('platform default: secrets precedence — secrets-ask fires BEFORE network-mutating-ask', async () => {
    // A GET with an auth header: matches secrets-ask (rule #1) not the network-mutating rule.
    const d = await engine.decide(
      req({ family: 'http', operation: 'http.POST', input: { url: 'https://api.example.com/x', method: 'POST', headers: { authorization: '[REDACTED]' } } }),
    );
    expect(d.decision).toBe('ask');
    expect(d.reason).toMatch(/platform-secrets-ask/);
  });

  // --- explicit rules + precedence ---

  it('explicit deny rule → deny (first-match-wins over a later allow)', async () => {
    repo.effective = resolution(
      doc([
        { id: 'deny-terminal', domain: 'tool', family: 'terminal', effect: 'deny', reason: 'no terminal' },
        { id: 'allow-terminal', domain: 'tool', family: 'terminal', effect: 'allow' },
      ]),
    );
    const d = await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/v1\/deny-terminal/);
  });

  it('defaultEffect deny → deny when no rule matches (fail-closed author posture)', async () => {
    repo.effective = resolution(doc([], 'deny'));
    const d = await engine.decide(req({ family: 'filesystem', operation: 'fs.read', input: { operation: 'read', path: 'a' } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/v1\/default/);
  });

  it('hostGlob: deny *.evil.test, allow other hosts', async () => {
    repo.effective = resolution(
      doc([
        { id: 'deny-evil', domain: 'network', hostGlob: '*.evil.test', effect: 'deny', reason: 'evil' },
      ], 'allow'),
    );
    const denied = await engine.decide(req({ family: 'http', operation: 'http.GET', input: { url: 'https://api.evil.test/x', method: 'GET' } }));
    expect(denied.decision).toBe('deny');
    const allowed = await engine.decide(req({ family: 'http', operation: 'http.GET', input: { url: 'https://api.good.test/x', method: 'GET' } }));
    expect(allowed.decision).toBe('allow');
  });

  it('hostGlob does not match a rule with no host (network rule without hostGlob matches all network)', async () => {
    repo.effective = resolution(doc([{ id: 'deny-net', domain: 'network', effect: 'deny' }]));
    const d = await engine.decide(req({ family: 'http', operation: 'http.GET', input: { url: 'https://anywhere.test/x', method: 'GET' } }));
    expect(d.decision).toBe('deny');
  });

  // --- the ASK approval flow ---

  it('ask with no prior approval → ask + a pending approval is created (idempotent)', async () => {
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]));
    const d = await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('ask');
    expect(repo.pendingCreations).toBe(1);
    expect(d.reason).toMatch(/pending/);
    // A second decide() for the SAME subject reuses the existing pending (no new row).
    const d2 = await engine.decide(req({ invocationId: 'inv-2', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d2.decision).toBe('ask');
    expect(repo.pendingCreations).toBe(1); // idempotent — no new pending row
  });

  it('ask with an APPROVED approval for the same subject → allow (cites the approval)', async () => {
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]));
    // First invocation creates the pending.
    await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const pending = repo.approvalsByKey.get('tool:terminal:terminal.exec:')!;
    // Resolve it approved.
    await engine.resolveApproval({ approvalId: pending.id, action: 'approve', userId: "user-1" });
    // A NEW invocation (new invocationId) for the same subject → allow.
    const d = await engine.decide(req({ invocationId: 'inv-2', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('allow');
    expect(d.reason).toMatch(/approved by user-1/);
  });

  it('ask with a DENIED approval for the same subject → deny (a human denial is durable)', async () => {
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]));
    await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const pending = repo.approvalsByKey.get('tool:terminal:terminal.exec:')!;
    await engine.resolveApproval({ approvalId: pending.id, action: 'deny', userId: "user-1" });
    const d = await engine.decide(req({ invocationId: 'inv-2', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/denied by user-1/);
  });

  it('ask with an EXPIRED approved approval → ask + a new pending (lazy expiry + markExpired called)', async () => {
    // A controllable clock: starts at T0; the approval TTL is 1000ms; we
    // advance the clock past the TTL after the approval resolves.
    let clock = 1_000_000;
    const expiredEngine = new AgentPolicyEngine({
      repository: repo,
      logger: silentLogger,
      approvalTtlMs: 1000,
      now: () => new Date(clock),
    });
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]));
    await expiredEngine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const pending = repo.approvalsByKey.get('tool:terminal:terminal.exec:')!;
    await repo.resolve({ approvalId: pending.id, action: 'approve', userId: 'user-1' });
    expect(repo.markExpiredCalls).toBe(0);
    // Advance the clock past the approval's expiry.
    clock += 2000;
    const d = await expiredEngine.decide(req({ invocationId: 'inv-2', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('ask');
    expect(repo.markExpiredCalls).toBe(1); // the expired approved row was lazily flipped
  });

  // --- fail-closed ---

  it('fail-closed: unresolvable scope → deny with scope-unresolvable reason', async () => {
    repo.scope = null;
    const d = await engine.decide(req({ family: 'filesystem', operation: 'fs.read', input: { operation: 'read', path: 'a' } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/agent-policy-scope-unresolvable/);
  });

  it('fail-closed: repository throws → deny with agent-policy-unavailable reason', async () => {
    repo.throwOnGetEffective = true;
    const d = await engine.decide(req({ family: 'filesystem', operation: 'fs.read', input: { operation: 'read', path: 'a' } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/agent-policy-unavailable/);
  });

  // --- org/project precedence ---

  it('precedence: project override wins over org default', async () => {
    // Two-step: org doc says deny-all; project doc says allow-terminal.
    // The engine consults getEffectivePolicy (project first → org).
    repo.effective = resolution(
      doc([{ id: 'allow-terminal', domain: 'tool', family: 'terminal', effect: 'allow' }]),
      1,
      'project',
    );
    const d = await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('allow');
  });

  // --- concurrency: the pending-approval idempotency under parallel asks ---

  it('concurrency: two parallel asks for the same subject → exactly ONE pending creation', async () => {
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]));
    const [a, b] = await Promise.all([
      engine.decide(req({ invocationId: 'inv-a', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } })),
      engine.decide(req({ invocationId: 'inv-b', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } })),
    ]);
    expect(a.decision).toBe('ask');
    expect(b.decision).toBe('ask');
    // The stub's ensurePendingApproval is called; with real SQL the partial
    // unique index would enforce this. Here the stub dedupes in-memory.
    expect(repo.pendingCreations).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// LAYER 1b — EXTERNAL HANDOFF ELIGIBILITY (stub repository)
// ===========================================================================

describe('WORK-037 — Agent Policy Engine (external handoff eligibility, stub repository)', () => {
  let repo: StubPolicyRepository;
  let engine: AgentPolicyEngine;

  beforeEach(() => {
    repo = new StubPolicyRepository();
    engine = new AgentPolicyEngine({ repository: repo, logger: silentLogger, approvalTtlMs: 0 });
  });

  it('platform default: external handoff → allow (no external-domain rule; defaultEffect allow)', async () => {
    const d = await engine.evaluateExternalHandoff({ executionId: 'exec-1' });
    expect(d.decision).toBe('allow');
    expect(d.scopeSource).toBe('platform-default');
    expect(d.policyVersion).toBe(0);
  });

  it('org deny external → deny', async () => {
    repo.effective = resolution(doc([{ id: 'deny-external', domain: 'external', effect: 'deny', reason: 'no external' }]), 1, 'organization');
    const d = await engine.evaluateExternalHandoff({ executionId: 'exec-1' });
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/v1\/deny-external/);
  });

  it('org ask external → ask + a pending approval is created', async () => {
    repo.effective = resolution(doc([{ id: 'ask-external', domain: 'external', effect: 'ask' }]), 1, 'organization');
    const d = await engine.evaluateExternalHandoff({ executionId: 'exec-1' });
    expect(d.decision).toBe('ask');
    expect(d.approvalId).toBeDefined();
    expect(repo.pendingCreations).toBe(1);
  });

  it('org constrained external → constrained + constraints carried', async () => {
    repo.effective = resolution(
      doc([{ id: 'constrain-external', domain: 'external', effect: 'constrained', constraints: { timeoutMs: 5000, readOnly: true } }]),
      1,
      'organization',
    );
    const d = await engine.evaluateExternalHandoff({ executionId: 'exec-1' });
    expect(d.decision).toBe('constrained');
    expect(d.constraints?.timeoutMs).toBe(5000);
    expect(d.constraints?.readOnly).toBe(true);
  });

  it('fail-closed: unresolvable scope → deny', async () => {
    repo.scope = null;
    const d = await engine.evaluateExternalHandoff({ executionId: 'exec-1' });
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/scope-unresolvable/);
  });
});

// ===========================================================================
// LAYER 2 — PERSISTENCE (real pglite)
// ===========================================================================

describe('WORK-037 — PgAgentPolicyRepository (durability, real pglite)', () => {
  let stack: TestAuthStack;
  let repo: PgAgentPolicyRepository;
  let orgId: string;
  let projectId: string;
  let otherProjectId: string;
  let executionId: string;
  let userId: string;
  // the execution chain
  let execRepo: PgExecutionRecordRepository;
  let contextRepo: PgImplementationContextRepository;
  let workItemId: string;
  let workOrderId: string;
  let contextId: string;

  beforeAll(async () => {
    stack = await buildAuthStack();
    repo = new PgAgentPolicyRepository({ db: stack.db.client });
    execRepo = new PgExecutionRecordRepository(stack.db.client);
    contextRepo = new PgImplementationContextRepository(stack.db.client);

    const org = await stack.organizationRepository.create({ name: 'W037 Org' });
    orgId = org.id;
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'W037 Project' });
    projectId = project.id;
    const other = await stack.projectRepository.create({ organizationId: orgId, name: 'W037 Other' });
    otherProjectId = other.id;
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'w037-user', displayName: 'W037 User', email: null });
    userId = user.id;

    // The full execution chain (architecture → version → work item → work order → impl context → execution).
    const arch = await stack.architectureRepository.create({ projectId, name: 'W037 Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W037' });
    const wi = await stack.workItemRepository.create({
      architectureVersionId: version.id, workItemId: 'WORK-W037-001',
      title: 't', objective: 'o', scope: 's', outOfScope: 'n', metadata: { baseCommit: 'w037-base-000000000000000001' },
    });
    workItemId = wi.id;
    await stack.workOrderRepository.create({
      workItemId, projectId, architectureVersionId: version.id,
      requirementIds: [], criterionIds: [], scope: 's', verificationRequirements: [],
    });
    const wo = await stack.db.client.query<{ id: string }>(
      `SELECT id FROM wfos_work_orders WHERE work_item_id = $1 LIMIT 1`, [workItemId]);
    workOrderId = wo.rows[0]!.id;
    const ctx = await contextRepo.create({ workItemId, revision: 1, kind: 'initial', content: { prompt: 'w037' } as never });
    contextId = ctx.id;
    executionId = 'exec-w037-1';
    await execRepo.create({
      executionId, projectId, workItemId, workOrderId, implementationContextId: contextId,
      mode: 'external', provider: 'fake', model: null, prompt: 'p', promptDigest: 'd',
    });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  // --- document CRUD + versioning ---

  it('setProjectPolicy → version 1; update → version 2 (the trigger)', async () => {
    const d1: AgentPolicyDocument = { description: 'v1', rules: [], defaultEffect: 'allow' };
    const r1 = await repo.setProjectPolicy({ organizationId: orgId, projectId, document: d1, userId: userId });
    expect(r1.policyVersion).toBe(1);
    expect(r1.source).toBe('project');
    const d2: AgentPolicyDocument = { description: 'v2', rules: [{ id: 'r1', domain: 'tool', family: 'terminal', effect: 'deny' }], defaultEffect: 'deny' };
    const r2 = await repo.setProjectPolicy({ organizationId: orgId, projectId, document: d2, userId: userId });
    expect(r2.policyVersion).toBe(2);
    expect(r2.document.rules).toHaveLength(1);
    await repo.clearProjectPolicy(orgId, projectId);
  });

  it('partial unique: a second project-scope row for the same project upserts (not duplicates)', async () => {
    const d: AgentPolicyDocument = { rules: [], defaultEffect: 'allow' };
    await repo.setProjectPolicy({ organizationId: orgId, projectId, document: d, userId: userId });
    await repo.setProjectPolicy({ organizationId: orgId, projectId, document: d, userId: userId });
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_agent_policies WHERE scope='project' AND organization_id=$1 AND project_id=$2`,
      [orgId, projectId],
    );
    expect(Number(res.rows[0]!.c)).toBe(1);
    await repo.clearProjectPolicy(orgId, projectId);
  });

  it('setOrganizationPolicy → version 1 (the org-level default)', async () => {
    const d: AgentPolicyDocument = { rules: [{ id: 'org-allow', domain: 'tool', effect: 'allow' }], defaultEffect: 'allow' };
    const r = await repo.setOrganizationPolicy({ organizationId: orgId, document: d, userId: userId });
    expect(r.policyVersion).toBe(1);
    expect(r.source).toBe('organization');
    expect(r.projectId).toBeNull();
  });

  it('partial unique: only ONE org-scope default per organization', async () => {
    const d: AgentPolicyDocument = { rules: [], defaultEffect: 'allow' };
    await repo.setOrganizationPolicy({ organizationId: orgId, document: d, userId: userId });
    await repo.setOrganizationPolicy({ organizationId: orgId, document: d, userId: userId });
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_agent_policies WHERE scope='organization' AND organization_id=$1`, [orgId]);
    expect(Number(res.rows[0]!.c)).toBe(1);
  });

  it('precedence: project override wins over org default in getEffectivePolicy', async () => {
    await repo.setOrganizationPolicy({ organizationId: orgId, document: { rules: [], defaultEffect: 'deny' }, userId: userId });
    await repo.setProjectPolicy({ organizationId: orgId, projectId, document: { rules: [], defaultEffect: 'allow' }, userId: userId });
    const eff = await repo.getEffectivePolicy(orgId, projectId);
    expect(eff!.source).toBe('project');
    expect(eff!.document.defaultEffect).toBe('allow');
    // The other project (no override) falls to the org default.
    const effOther = await repo.getEffectivePolicy(orgId, otherProjectId);
    expect(effOther!.source).toBe('organization');
    expect(effOther!.document.defaultEffect).toBe('deny');
    await repo.clearProjectPolicy(orgId, projectId);
    await repo.clearOrganizationPolicy(orgId);
  });

  it('clearProjectPolicy → the row is removed (falls to org/platform)', async () => {
    await repo.setProjectPolicy({ organizationId: orgId, projectId, document: { rules: [], defaultEffect: 'allow' }, userId: userId });
    const removed = await repo.clearProjectPolicy(orgId, projectId);
    expect(removed).toBe(true);
    const after = await repo.getProjectPolicy(orgId, projectId);
    expect(after).toBeNull();
    const removedAgain = await repo.clearProjectPolicy(orgId, projectId);
    expect(removedAgain).toBe(false);
  });

  // --- scope resolution ---

  it('resolveScope: execution → project → organization', async () => {
    const scope = await repo.resolveScope(executionId);
    expect(scope).not.toBeNull();
    expect(scope!.projectId).toBe(projectId);
    expect(scope!.organizationId).toBe(orgId);
  });

  it('resolveScope: unknown execution → null', async () => {
    const scope = await repo.resolveScope('exec-does-not-exist');
    expect(scope).toBeNull();
  });

  // --- approvals: idempotency + resolution CAS ---

  it('ensurePendingApproval: twice for the same subject → the SAME row (idempotent)', async () => {
    const a = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'tool',
      subjectFamily: 'terminal', subjectOperation: 'terminal.exec', subjectHost: null,
      subjectKey: 'tool:terminal:terminal.exec:', ruleId: 'ask-terminal', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    const b = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'tool',
      subjectFamily: 'terminal', subjectOperation: 'terminal.exec', subjectHost: null,
      subjectKey: 'tool:terminal:terminal.exec:', ruleId: 'ask-terminal', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('pending');
  });

  it('getLatestApproval: returns the latest for a subject', async () => {
    const latest = await repo.getLatestApproval(executionId, 'tool:terminal:terminal.exec:');
    expect(latest).not.toBeNull();
    expect(latest!.status).toBe('pending');
  });

  it('resolve: approve → approved; resolve again → already-resolved error (terminal evidence)', async () => {
    const pending = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'network',
      subjectFamily: 'http', subjectOperation: 'http.POST', subjectHost: 'api.evil.test',
      subjectKey: 'network:http:http.POST:api.evil.test', ruleId: 'ask-net', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    const approved = await repo.resolve({ approvalId: pending.id, action: 'approve', userId: userId, note: 'ok' });
    expect(approved.status).toBe('approved');
    expect(approved.resolvedBy).toBe(userId);
    expect(approved.resolutionNote).toBe('ok');
    // A second resolution is rejected — resolutions are immutable.
    await expect(repo.resolve({ approvalId: pending.id, action: 'deny', userId: userId }))
      .rejects.toThrow(/already-resolved/);
  });

  it('resolve: non-existent approval → not-found error', async () => {
    await expect(repo.resolve({ approvalId: '00000000-0000-0000-0000-000000000000', action: 'approve', userId: userId }))
      .rejects.toThrow(/not-found/);
  });

  it('a resolved approval is terminal — a NEW pending for the same subject creates a NEW row', async () => {
    // The previous test left an APPROVED row for 'network:http:http.POST:api.evil.test'.
    // A new pending for the same subject is permitted (the partial unique index is WHERE status='pending').
    const newPending = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'network',
      subjectFamily: 'http', subjectOperation: 'http.POST', subjectHost: 'api.evil.test',
      subjectKey: 'network:http:http.POST:api.evil.test', ruleId: 'ask-net', policyVersion: 1,
      requestedReason: 'ask again', expiresAt: null,
    });
    expect(newPending.status).toBe('pending');
    expect(newPending.id).not.toBe('');
    // getLatestApproval now returns the NEW pending (latest by requested_at).
    const latest = await repo.getLatestApproval(executionId, 'network:http:http.POST:api.evil.test');
    expect(latest!.status).toBe('pending');
  });

  it('markExpired: flips a past-expires row to expired', async () => {
    const pending = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'deployment',
      subjectFamily: 'git', subjectOperation: 'git.push', subjectHost: null,
      subjectKey: 'deployment:git:git.push:', ruleId: 'deny-deploy', policyVersion: 1,
      requestedReason: 'ask', expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await repo.markExpired(pending.id);
    const after = await repo.getApproval(pending.id);
    expect(after!.status).toBe('expired');
  });

  it('getApproval: returns a single approval by id', async () => {
    const pending = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'secrets',
      subjectFamily: 'http', subjectOperation: 'http.GET', subjectHost: 'api.secret.test',
      subjectKey: 'secrets:http:http.GET:api.secret.test', ruleId: 'ask-secrets', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    const fetched = await repo.getApproval(pending.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(pending.id);
    expect(fetched!.subjectDomain).toBe('secrets');
  });

  it('listApprovals: filters by status', async () => {
    const pending = await repo.listApprovals(projectId, 'pending');
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((a) => a.status === 'pending')).toBe(true);
    const all = await repo.listApprovals(projectId);
    expect(all.length).toBeGreaterThanOrEqual(pending.length);
  });
});

// ===========================================================================
// LAYER 3 — SEAM INTEGRATION (engine behind DefaultToolRuntime)
// ===========================================================================

describe('WORK-037 — the seam integration (engine behind the WORK-036 ToolPolicyGate)', () => {
  // A capturing executor: records calls + ctx.limits, returns a governed outcome.
  class CapturingExecutor implements ToolExecutor {
    readonly family: ToolFamily;
    calls: { request: unknown; ctx: ToolExecutorContext }[] = [];
    constructor(family: ToolFamily) {
      this.family = family;
    }
    async execute(request: unknown, ctx: ToolExecutorContext): Promise<ToolExecutionOutcome> {
      this.calls.push({ request, ctx });
      return { exitCode: 0, stdout: 'ok', stderr: '', output: null, error: null, cancelled: false, truncated: false };
    }
  }

  function buildRuntimeWithEngine(repo: StubPolicyRepository, executors: Partial<Record<ToolFamily, ToolExecutor>>) {
    const engine = new AgentPolicyEngine({ repository: repo, logger: silentLogger, approvalTtlMs: 0 });
    // Stub session/workspace/materializer/session-repo.
    const session = { id: 'sess-1', executionId: 'exec-1', projectId: 'proj-1', workItemId: 'wi', workOrderId: 'wo', status: 'running' as const, version: 1, currentTurn: 1, createdAt: new Date(), updatedAt: new Date(), interruptedAt: null, terminalAt: null };
    const workspace = { id: 'ws-1', executionId: 'exec-1', projectId: 'proj-1', repositoryOwner: 'o', repositoryName: 'r', worktreePath: '/tmp/fake-ws', branch: 'b', baseRevision: 'abc', state: 'ready' as const };
    const runtime = new DefaultToolRuntime({
      sessionService: { getSessionForExecution: async () => session, ensureSession: async () => session },
      sessionRepository: {
        claimToolInvocation: async () => ({ claimed: true as const }),
        appendToolObservation: async () => ({ appended: true as const }),
        listEvents: async () => [],
      },
      workspaceRepository: { getWorkspaceForExecution: async () => workspace } as never,
      materializer: { materialize: async () => '/tmp/fake-ws', remove: async () => {} } as never,
      executors,
      policyGate: engine,
      logger: silentLogger,
    });
    return { runtime, engine };
  }

  it('deny → durable blocked observation; the executor is NEVER called', async () => {
    const repo = new StubPolicyRepository();
    repo.effective = resolution(doc([{ id: 'deny-fs', domain: 'tool', family: 'filesystem', effect: 'deny', reason: 'no fs' }]));
    const fs = new CapturingExecutor('filesystem');
    const { runtime } = buildRuntimeWithEngine(repo, { filesystem: fs });
    const result = await runtime.invoke({
      invocationId: 'inv-deny', executionId: 'exec-1', family: 'filesystem',
      input: { operation: 'read', path: 'a.ts' }, idempotency: 'idempotent',
    });
    expect(result.record.status).toBe('blocked');
    expect(result.record.policy?.decision).toBe('deny');
    expect(result.record.error?.code).toBe('policy-deny');
    expect(fs.calls).toHaveLength(0); // no executor bypass
  });

  it('ask → durable blocked observation; a pending approval is created; executor NEVER called', async () => {
    const repo = new StubPolicyRepository();
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]));
    const terminal = new CapturingExecutor('terminal');
    const { runtime } = buildRuntimeWithEngine(repo, { terminal: terminal });
    const result = await runtime.invoke({
      invocationId: 'inv-ask', executionId: 'exec-1', family: 'terminal',
      input: { argv: ['echo', 'hi'] }, idempotency: 'idempotent',
    });
    expect(result.record.status).toBe('blocked');
    expect(result.record.policy?.decision).toBe('ask');
    expect(result.record.error?.code).toBe('policy-ask');
    expect(terminal.calls).toHaveLength(0);
    expect(repo.pendingCreations).toBe(1);
  });

  it('constrained → the executor runs UNDER the tightened limits (no bypass; structural)', async () => {
    const repo = new StubPolicyRepository();
    repo.effective = resolution(
      doc([{ id: 'constrain-terminal', domain: 'tool', family: 'terminal', effect: 'constrained', constraints: { timeoutMs: 5000 } }]),
    );
    const terminal = new CapturingExecutor('terminal');
    const { runtime } = buildRuntimeWithEngine(repo, { terminal: terminal });
    const result = await runtime.invoke({
      invocationId: 'inv-constrain', executionId: 'exec-1', family: 'terminal',
      input: { argv: ['echo', 'hi'] }, idempotency: 'idempotent',
    });
    expect(result.record.status).toBe('succeeded');
    expect(result.record.policy?.decision).toBe('constrained');
    expect(terminal.calls).toHaveLength(1);
    // applyConstraints tightens only (Math.min) — 5000 < the default.
    expect(terminal.calls[0]!.ctx.limits.defaultTimeoutMs).toBeLessThanOrEqual(5000);
  });

  it('constrained readOnly → a mutating invocation is BLOCKED (read-only enforced)', async () => {
    const repo = new StubPolicyRepository();
    repo.effective = resolution(
      doc([{ id: 'ro-fs', domain: 'tool', family: 'filesystem', effect: 'constrained', constraints: { readOnly: true } }]),
    );
    const fs = new CapturingExecutor('filesystem');
    const { runtime } = buildRuntimeWithEngine(repo, { filesystem: fs });
    const result = await runtime.invoke({
      invocationId: 'inv-ro', executionId: 'exec-1', family: 'filesystem',
      input: { operation: 'write', path: 'a.ts', content: 'x' }, idempotency: 'idempotent',
    });
    expect(result.record.status).toBe('blocked');
    expect(result.record.error?.code).toBe('policy-constrained-read-only');
    expect(fs.calls).toHaveLength(0);
  });

  it('allow → the executor runs; the observation records the allow decision', async () => {
    const repo = new StubPolicyRepository();
    repo.effective = resolution(doc([{ id: 'allow-fs', domain: 'tool', family: 'filesystem', effect: 'allow' }]));
    const fs = new CapturingExecutor('filesystem');
    const { runtime } = buildRuntimeWithEngine(repo, { filesystem: fs });
    const result = await runtime.invoke({
      invocationId: 'inv-allow', executionId: 'exec-1', family: 'filesystem',
      input: { operation: 'read', path: 'a.ts' }, idempotency: 'idempotent',
    });
    expect(result.record.status).toBe('succeeded');
    expect(result.record.policy?.decision).toBe('allow');
    expect(fs.calls).toHaveLength(1);
  });

  it('fail-closed: scope-unresolvable → the runtime records a blocked observation (deny)', async () => {
    const repo = new StubPolicyRepository();
    repo.scope = null; // unresolvable
    const fs = new CapturingExecutor('filesystem');
    const { runtime } = buildRuntimeWithEngine(repo, { filesystem: fs });
    const result = await runtime.invoke({
      invocationId: 'inv-fail', executionId: 'exec-1', family: 'filesystem',
      input: { operation: 'read', path: 'a.ts' }, idempotency: 'idempotent',
    });
    expect(result.record.status).toBe('blocked');
    expect(result.record.policy?.decision).toBe('deny');
    expect(result.record.error?.message).toMatch(/scope-unresolvable/);
    expect(fs.calls).toHaveLength(0); // policy failure cannot execute
  });
});
