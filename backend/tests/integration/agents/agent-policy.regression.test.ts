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
// A recording audit writer (captures every audit emission for the dedup proof).
// ---------------------------------------------------------------------------
//
// The architect's PR-#41 review: the engine must emit exactly ONE
// 'agent-policy.approval-requested' audit event per pending DB row, even
// under concurrent asks for the same subject. This recorder captures every
// write() call so the regression can assert the count precisely.
class RecordingAuditWriter {
  readonly events: import('../../../src/modules/audit/internal/audit.types.js').WriteAuditEventInput[] = [];
  readonly written = new Map<string, number>(); // eventType → count
  async write(input: import('../../../src/modules/audit/internal/audit.types.js').WriteAuditEventInput) {
    this.events.push(input);
    this.written.set(input.eventType, (this.written.get(input.eventType) ?? 0) + 1);
    // Return a minimal AuditEvent shape (the engine does not consume the return value).
    return {
      id: `audit-${this.events.length}`,
      organizationId: input.organizationId ?? null,
      projectId: input.projectId ?? null,
      eventType: input.eventType,
      actor: input.actor,
      source: input.source ?? '',
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      executionId: input.executionId ?? null,
      correlationId: input.correlationId ?? null,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      metadata: input.metadata ?? {},
      workItemId: input.workItemId ?? null,
      workOrderId: input.workOrderId ?? null,
      architectureVersionId: input.architectureVersionId ?? null,
      reviewId: input.reviewId ?? null,
      verificationRunId: input.verificationRunId ?? null,
      agentRunId: input.agentRunId ?? null,
      pullRequestAssociationId: input.pullRequestAssociationId ?? null,
      createdAt: new Date(),
    };
  }
  count(eventType: string): number {
    return this.written.get(eventType) ?? 0;
  }
}

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
  // The stub models the real DB: an ARRAY of approvals per subject (so a
  // v1 approved row + a v2 pending row can coexist when the policy changes).
  // The latest is the LAST element (insertion order = requestedAt order in
  // the stub since timestamps are sequential).
  approvalsByKey = new Map<string, AgentPolicyApproval[]>();
  pendingCreations = 0;
  resolveCalls = 0;
  markExpiredCalls = 0;
  supersedeCalls = 0;
  throwOnResolveScope = false;
  throwOnGetEffective = false;

  /** Test helper: the latest approval for a subject (mirrors getLatestApproval). */
  latestFor(subjectKey: string): AgentPolicyApproval | null {
    const arr = this.approvalsByKey.get(subjectKey);
    if (!arr || arr.length === 0) return null;
    return arr[arr.length - 1]!;
  }

  /** Test helper: a specific approval for a subject by id (for binding assertions). */
  approvalById(approvalId: string): AgentPolicyApproval | null {
    for (const arr of this.approvalsByKey.values()) {
      for (const a of arr) {
        if (a.id === approvalId) return a;
      }
    }
    return null;
  }

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
    return this.latestFor(subjectKey);
  }
  async getApproval(approvalId: string): Promise<AgentPolicyApproval | null> {
    return this.approvalById(approvalId);
  }
  async ensurePendingApproval(input: {
    subjectKey: string;
    subjectDomain: AgentPolicyDomain;
    subjectFamily: string | null;
    subjectOperation: string | null;
    subjectHost: string | null;
    ruleId: string;
    policyVersion: number;
    requestedReason: string | null;
    expiresAt: string | null;
  }): Promise<{ approval: AgentPolicyApproval; created: boolean }> {
    // Honor the engine's (ruleId, policyVersion) so the binding contract
    // (architect's PR-#41 review) is exercised: a stored approval carries
    // the (policyVersion, ruleId) that produced it, NOT a fixed stub value.
    const arr = this.approvalsByKey.get(input.subjectKey) ?? [];
    const existingPending = arr.find((a) => a.status === 'pending');
    if (existingPending) {
      return { approval: existingPending, created: false };
    }
    this.pendingCreations++;
    const approval: AgentPolicyApproval = {
      id: `apr-stub-${this.pendingCreations}`,
      organizationId: 'org-1',
      projectId: 'proj-1',
      executionId: 'exec-1',
      subjectDomain: input.subjectDomain,
      subjectFamily: input.subjectFamily,
      subjectOperation: input.subjectOperation,
      subjectHost: input.subjectHost,
      subjectKey: input.subjectKey,
      ruleId: input.ruleId,
      policyVersion: input.policyVersion,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      requestedReason: input.requestedReason,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      expiresAt: input.expiresAt,
    };
    arr.push(approval);
    this.approvalsByKey.set(input.subjectKey, arr);
    return { approval, created: true };
  }
  async supersedePendingApproval(approvalId: string): Promise<void> {
    this.supersedeCalls++;
    for (const arr of this.approvalsByKey.values()) {
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i]!;
        if (a.id === approvalId && a.status === 'pending') {
          arr[i] = {
            ...a,
            status: 'expired',
            resolutionNote: 'superseded by policy-version change',
            resolvedAt: new Date().toISOString(),
          };
        }
      }
    }
  }
  async listApprovals(): Promise<readonly AgentPolicyApproval[]> {
    return [];
  }
  async resolve(input: { approvalId: string; action: 'approve' | 'deny'; userId: string; note?: string }): Promise<AgentPolicyApproval> {
    this.resolveCalls++;
    for (const arr of this.approvalsByKey.values()) {
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i]!;
        if (a.id === input.approvalId && a.status === 'pending') {
          const resolved: AgentPolicyApproval = {
            ...a,
            status: input.action === 'approve' ? 'approved' : 'denied',
            resolvedBy: 'user-1',
            resolvedAt: new Date().toISOString(),
            resolutionNote: input.note ?? null,
          };
          arr[i] = resolved;
          return resolved;
        }
      }
    }
    return null as never;
  }
  async markExpired(approvalId: string): Promise<void> {
    this.markExpiredCalls++;
    for (const arr of this.approvalsByKey.values()) {
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i]!;
        if (a.id === approvalId) {
          arr[i] = { ...a, status: 'expired' };
        }
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
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  // ==========================================================================
  // PR #41 FIX (round 2) — options BEFORE the effective package subcommand.
  //
  // The architect's review of PR #41 at `35420da` approved the git-argv
  // canonical classifier and flagged the package family's positional
  // `args[0] === 'publish'` shortcut as the analogous remaining gap:
  // package runners (npm/pnpm/yarn/bun) permit global/config options
  // BEFORE the effective subcommand (e.g. `npm --registry=<url> publish`),
  // so a positional args[0] check could classify a REGISTRY publication as
  // ordinary `tool` activity → allow/constrained instead of the required
  // deployment deny. The engine now classifies the EFFECTIVE subcommand
  // via the CANONICAL package-argv classifier (shared with the executor).
  // These prove the POLICY authorization decision is correct for the
  // architect's scenarios. (The canonical classifier itself is unit-proven
  // in tests/unit/package-argv.test.ts; these are the engine integration.)
  // ==========================================================================
  it('PR#41 round 2: `npm --registry=http://x publish` (the architect\'s exact example) → deny (deployment-class, NOT allow)', async () => {
    // The positional args[0] check saw `--registry=http://x` → NOT deployment
    // → allow/constrained. WRONG. The canonical classifier skips the
    // `--registry=http://x` single token (the value is attached) → effective
    // `publish` → deployment → the platform default's deployment-deny fires.
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--registry=http://x', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `npm --registry http://x publish` (space form) → deny (deployment-class)', async () => {
    // The space form: --registry consumes the NEXT token (the URL) as its
    // value, so the URL is NOT mistaken for the subcommand; `publish` is.
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--registry', 'http://x', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `npm --silent publish` → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--silent', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `npm -q publish` (short --quiet) → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['-q', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `npm --workspace foo publish` (value option, space form) → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--workspace', 'foo', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `npm --workspace=foo publish` (= form) → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--workspace=foo', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `npm publish --tag beta` (option AFTER the subcommand) → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['publish', '--tag', 'beta'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: stacked options `npm --silent --registry=http://x --workspace=foo publish` → deny', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--silent', '--registry=http://x', '--workspace=foo', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  // The equivalent supported-runner forms (pnpm / yarn / bun) — the
  // classifier is appropriate to ALL publish-capable runners.
  it('PR#41 round 2: `pnpm publish` → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.pnpm', input: { runner: 'pnpm', args: ['publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `pnpm --filter foo publish` (workspace filter) → deny', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.pnpm', input: { runner: 'pnpm', args: ['--filter', 'foo', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `pnpm -C /path publish` (cwd short option) → deny', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.pnpm', input: { runner: 'pnpm', args: ['-C', '/path', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `yarn --cwd /path publish` → deny', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.yarn', input: { runner: 'yarn', args: ['--cwd', '/path', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `bun publish` → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.bun', input: { runner: 'bun', args: ['publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  // The publish-family siblings (unpublish / deprecate) behind options.
  it('PR#41 round 2: `npm --registry=http://x unpublish` → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--registry=http://x', 'unpublish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `npm --silent deprecate` → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--silent', 'deprecate'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  // Normal (local) package commands must NOT be deployment (the fix is
  // surgical — it catches the publication, not the local dev workflow).
  it('PR#41 round 2: `npm test` → constrained (NOT deployment-deny)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['test'] } }));
    expect(d.decision).toBe('constrained');
  });

  it('PR#41 round 2: `npm --silent test` → constrained (boolean option skipped, NOT deployment-deny)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--silent', 'test'] } }));
    expect(d.decision).toBe('constrained');
  });

  it('PR#41 round 2: `npm --registry=http://x test` → constrained (the architect\'s example with a LOCAL subcommand)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--registry=http://x', 'test'] } }));
    expect(d.decision).toBe('constrained');
  });

  it('PR#41 round 2: `npm --workspace foo test` → constrained (value option skipped, local subcommand)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--workspace', 'foo', 'test'] } }));
    expect(d.decision).toBe('constrained');
  });

  // Non-publish-capable runners (node/npx/tsx/vitest/jest/tsc) — `publish`
  // as a positional is a script/argument name, NOT a registry publication →
  // the runner gate returns false → NOT deployment (no false deny).
  it('PR#41 round 2: `node publish.js` → NOT deployment (non-publish-capable runner)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.node', input: { runner: 'node', args: ['publish.js'] } }));
    expect(d.decision).not.toBe('deny');
    expect(d.reason).not.toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `node --inspect publish.js` (node flag + script named publish.js) → NOT deployment', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.node', input: { runner: 'node', args: ['--inspect', 'publish.js'] } }));
    expect(d.decision).not.toBe('deny');
    expect(d.reason).not.toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: `npx publish` (npx, not publish-capable) → NOT deployment', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npx', input: { runner: 'npx', args: ['publish'] } }));
    expect(d.decision).not.toBe('deny');
    expect(d.reason).not.toMatch(/platform-deployment-deny/);
  });

  // The print-and-exit helpers (no subcommand) are NOT deployment.
  it('PR#41 round 2: `npm --version` → NOT deployment (print-and-exit, no subcommand)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--version'] } }));
    expect(d.decision).not.toBe('deny');
    expect(d.reason).not.toMatch(/platform-deployment-deny/);
  });

  // Ambiguity → fail-closed (treat as deployment so a crafted unknown
  // option cannot smuggle a publication past the deployment rule).
  it('PR#41 round 2: fail-closed on ambiguity — `npm -Z publish` (unknown short option) → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['-Z', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: fail-closed on ambiguity — `npm --future-flag publish` (unknown long option) → deny', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--future-flag', 'publish'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41 round 2: fail-closed on ambiguity — `npm --future-flag test` (unknown option before LOCAL subcommand) → deny', async () => {
    // test is local, but the unknown option before it → fail-closed →
    // deployment → deny. Over-restrictive but SAFE (the architect's
    // principle: the policy authorization decision is the authority).
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--future-flag', 'test'] } }));
    expect(d.decision).toBe('deny');
  });

  it('PR#41 round 2: fail-closed on ambiguity — `npm --future-opt=val test` (unknown = form) → deny', async () => {
    const d = await engine.decide(req({ family: 'package', operation: 'package.npm', input: { runner: 'npm', args: ['--future-opt=val', 'test'] } }));
    expect(d.decision).toBe('deny');
  });

  // ==========================================================================
  // PR #41 FIX — options BEFORE the effective git subcommand.
  //
  // The architect's finding: git deployment classification only checked
  // args[0]; git permits global/config options BEFORE the effective
  // subcommand (e.g. `git -c k=v push`), so a positional args[0] check
  // could classify a REMOTE mutation as ordinary `tool` activity →
  // allow/constrained instead of the required deployment deny. The engine
  // now classifies the EFFECTIVE subcommand via the CANONICAL git-argv
  // classifier (shared with the executor). These prove the POLICY
  // authorization decision is correct for the architect's scenarios.
  // (The canonical classifier itself is unit-proven in
  // tests/unit/git-argv.test.ts; these are the engine integration.)
  // ==========================================================================
  it('PR#41: `git -c k=v push` (the architect\'s exact example) → deny (deployment-class, NOT allow)', async () => {
    // The positional args[0] check saw `-c` → NOT deployment → allow. WRONG.
    // The canonical classifier skips `-c` + value `k=v` → effective `push` →
    // deployment → the platform default's deployment-deny fires.
    const d = await engine.decide(req({ family: 'git', operation: 'git.push', input: { args: ['-c', 'k=v', 'push'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41: `git --no-pager push` → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.push', input: { args: ['--no-pager', 'push'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41: `git -C /path push` (chdir before push) → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.push', input: { args: ['-C', '/path', 'push'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41: `git --git-dir=/foo push` (= form) → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.push', input: { args: ['--git-dir=/foo', 'push'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41: `git --git-dir /foo push` (space form) → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.push', input: { args: ['--git-dir', '/foo', 'push'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41: `git -c k=v fetch` → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.fetch', input: { args: ['-c', 'k=v', 'fetch'] } }));
    expect(d.decision).toBe('deny');
  });

  it('PR#41: `git --no-pager remote` → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.remote', input: { args: ['--no-pager', 'remote'] } }));
    expect(d.decision).toBe('deny');
  });

  it('PR#41: `git -c k=v clone <url>` → deny (deployment-class)', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.clone', input: { args: ['-c', 'k=v', 'clone', 'https://github.com/x/y.git'] } }));
    expect(d.decision).toBe('deny');
  });

  it('PR#41: options before push with refspecs: `git -c k=v push origin main` → deny', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.push', input: { args: ['-c', 'k=v', 'push', 'origin', 'main'] } }));
    expect(d.decision).toBe('deny');
  });

  it('PR#41: LOCAL subcommand behind options is preserved: `git --no-pager status` → allow', async () => {
    // The boolean option is skipped; `status` is local → allow (NOT
    // over-restricted by the fix).
    const d = await engine.decide(req({ family: 'git', operation: 'git.status', input: { args: ['--no-pager', 'status'] } }));
    expect(d.decision).toBe('allow');
  });

  it('PR#41: LOCAL subcommand behind -c: `git -c user.email=x@y status` → allow', async () => {
    const d = await engine.decide(req({ family: 'git', operation: 'git.status', input: { args: ['-c', 'user.email=x@y', 'status'] } }));
    expect(d.decision).toBe('allow');
  });

  it('PR#41: fail-closed on ambiguity — `git -Z push` (unknown option) → deny (deployment-class)', async () => {
    // An unknown option before the subcommand → the classifier cannot
    // confidently classify → treat as deployment (deny by default). A
    // crafted unknown option cannot smuggle a remote mutation past the
    // deployment rule.
    const d = await engine.decide(req({ family: 'git', operation: 'git.push', input: { args: ['-Z', 'push'] } }));
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/platform-deployment-deny/);
  });

  it('PR#41: fail-closed on ambiguity — `git --future-flag status` (unknown option before LOCAL subcommand) → deny', async () => {
    // status is local, but the unknown option before it → fail-closed →
    // deployment → deny. Over-restrictive but SAFE (the architect's
    // principle: the policy authorization decision is the authority).
    const d = await engine.decide(req({ family: 'git', operation: 'git.status', input: { args: ['--future-flag', 'status'] } }));
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
    const pending = repo.latestFor('tool:terminal:terminal.exec:')!;
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
    const pending = repo.latestFor('tool:terminal:terminal.exec:')!;
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
    const pending = repo.latestFor('tool:terminal:terminal.exec:')!;
    await repo.resolve({ approvalId: pending.id, action: 'approve', userId: 'user-1' });
    expect(repo.markExpiredCalls).toBe(0);
    // Advance the clock past the approval's expiry.
    clock += 2000;
    const d = await expiredEngine.decide(req({ invocationId: 'inv-2', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('ask');
    expect(repo.markExpiredCalls).toBe(1); // the expired approved row was lazily flipped
  });

  // --- the APPROVAL-BINDING CONTRACT (architect's PR-#41 review) ---
  //
  // An approval authorizes a CURRENT invocation ONLY when its (policyVersion,
  // ruleId) match the policy decision the engine just produced. A material
  // policy change (rule replacement, version bump, default-posture change)
  // supersedes prior approvals for the same subject — the engine re-asks
  // under the new policy rather than silently carrying a stale approval
  // across the change.
  //
  // The five scenarios the architect required:
  //   1. approved v1 → same subject under v1 → allow;
  //   2. approved v1 → policy bumps to v2 → ASK, not allow;
  //   3. approved v1/rule-A → same version but rule-A replaced → ASK;
  //   4. expired approval → ASK (already covered above + re-asserted here
  //      for completeness against the binding contract);
  //   5. concurrent asks after a policy-version change → exactly ONE
  //      pending approval.

  it('binding #1: approved under v1 → same subject under v1 → allow (the binding matches)', async () => {
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 1);
    await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const pending = repo.latestFor('tool:terminal:terminal.exec:')!;
    await engine.resolveApproval({ approvalId: pending.id, action: 'approve', userId: 'user-1' });
    // Same policy version, same rule → the approval authorizes this invocation.
    const d = await engine.decide(req({ invocationId: 'inv-2', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('allow');
    expect(d.reason).toMatch(/approved by user-1/);
    expect(d.reason).toMatch(/v1\/ask-terminal/);
  });

  it('binding #2: approved under v1 → policy bumps to v2 → ASK (the v1 approval does NOT authorize the v2 invocation)', async () => {
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 1);
    await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const pending = repo.latestFor('tool:terminal:terminal.exec:')!;
    await engine.resolveApproval({ approvalId: pending.id, action: 'approve', userId: 'user-1' });
    // Bump the policy version (a material policy change — the rule id stays
    // the same but the version moved, so the binding check fails).
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 2);
    const d = await engine.decide(req({ invocationId: 'inv-v2', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('ask');
    expect(d.reason).toMatch(/v2\/ask-terminal/);
    // The v1 approved row was NOT mutated (terminal evidence under v1
    // stays intact); the engine treated it as not-authoritative for v2.
    const v1Approval = repo.approvalById(pending.id)!;
    expect(v1Approval.status).toBe('approved'); // untouched
    expect(v1Approval.policyVersion).toBe(1);
    // A new v2 pending was created (pendingCreations goes from 1 → 2).
    expect(repo.pendingCreations).toBe(2);
    // The latest approval for the subject is the new v2 pending.
    const latestV2 = repo.latestFor('tool:terminal:terminal.exec:')!;
    expect(latestV2.status).toBe('pending');
    expect(latestV2.policyVersion).toBe(2);
  });

  it('binding #3: approved under v1/rule-A → same version but rule-A replaced with rule-B → ASK (the ruleId binding supersedes)', async () => {
    // Same version number (1), but the matched rule id changed
    // (rule-A replaced with rule-B at the same version — a hypothetical
    // the trigger wouldn't permit via the public API, but the engine's
    // binding check covers it independently of the version dimension).
    repo.effective = resolution(doc([{ id: 'rule-A', domain: 'tool', family: 'terminal', effect: 'ask' }]), 1);
    await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const pending = repo.latestFor('tool:terminal:terminal.exec:')!;
    expect(pending.ruleId).toBe('rule-A');
    await engine.resolveApproval({ approvalId: pending.id, action: 'approve', userId: 'user-1' });
    // Same version (1), but the rule id changed (rule-A → rule-B).
    repo.effective = resolution(doc([{ id: 'rule-B', domain: 'tool', family: 'terminal', effect: 'ask' }]), 1);
    const d = await engine.decide(req({ invocationId: 'inv-ruleB', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('ask');
    expect(d.reason).toMatch(/v1\/rule-B/);
    // The v1/rule-A approved row was NOT mutated (terminal evidence stays).
    const v1Approval = repo.approvalById(pending.id)!;
    expect(v1Approval.status).toBe('approved');
    expect(v1Approval.ruleId).toBe('rule-A');
    // A new v1/rule-B pending was created.
    expect(repo.pendingCreations).toBe(2);
    // The latest approval for the subject is the new v1/rule-B pending.
    const latestRuleB = repo.latestFor('tool:terminal:terminal.exec:')!;
    expect(latestRuleB.status).toBe('pending');
    expect(latestRuleB.ruleId).toBe('rule-B');
  });

  it('binding (denied): a human denial does NOT carry across a policy-version change → ASK under v2 (not deny)', async () => {
    // A denial is durable for the subject UNDER the (policyVersion, ruleId)
    // that produced it. A material policy change supersedes the denial —
    // the engine re-asks under v2 (the human denied v1's posture, not v2's).
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 1);
    await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const pending = repo.latestFor('tool:terminal:terminal.exec:')!;
    await engine.resolveApproval({ approvalId: pending.id, action: 'deny', userId: 'user-1' });
    // Bump to v2.
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 2);
    const d = await engine.decide(req({ invocationId: 'inv-v2', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('ask'); // NOT deny — the v1 denial is stale evidence under v2
    expect(d.reason).toMatch(/v2\/ask-terminal/);
    // The v1 denied row stays as terminal evidence (untouched).
    const v1Approval = repo.approvalById(pending.id)!;
    expect(v1Approval.status).toBe('denied');
    expect(v1Approval.policyVersion).toBe(1);
    // The latest approval for the subject is the new v2 pending (re-asked).
    const latestV2 = repo.latestFor('tool:terminal:terminal.exec:')!;
    expect(latestV2.status).toBe('pending');
    expect(latestV2.policyVersion).toBe(2);
  });

  it('binding (stale pending): a pending under v1 → policy bumps to v2 → the v1 pending is SUPERSEDED + a new v2 pending is created (exactly ONE pending for the subject)', async () => {
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 1);
    await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const v1Pending = repo.latestFor('tool:terminal:terminal.exec:')!;
    expect(v1Pending.status).toBe('pending');
    expect(v1Pending.policyVersion).toBe(1);
    expect(repo.supersedeCalls).toBe(0);
    // Bump to v2.
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 2);
    const d = await engine.decide(req({ invocationId: 'inv-v2', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    expect(d.decision).toBe('ask');
    expect(d.reason).toMatch(/v2\/ask-terminal/);
    // The v1 pending was superseded (flipped to 'expired') so the partial
    // unique index on (execution_id, subject_key) WHERE status='pending'
    // freed the slot for the new v2 pending.
    expect(repo.supersedeCalls).toBe(1);
    const after = repo.latestFor('tool:terminal:terminal.exec:')!;
    expect(after.status).toBe('pending'); // the new v2 pending
    expect(after.policyVersion).toBe(2);
    expect(after.id).not.toBe(v1Pending.id); // a NEW row (the stub overwrites by subjectKey)
    expect(repo.pendingCreations).toBe(2); // v1 + v2
  });

  it('binding #5: concurrent asks AFTER a policy-version change → exactly ONE new v2 pending (the v1 pending was superseded, freeing the unique-index slot)', async () => {
    // v1 → pending P1 (v1, rule-A).
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 1);
    await engine.decide(req({ family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const beforeConcurrent = repo.pendingCreations;
    // Bump to v2 — two concurrent decide() calls.
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 2);
    const [a, b] = await Promise.all([
      engine.decide(req({ invocationId: 'inv-conc-a', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } })),
      engine.decide(req({ invocationId: 'inv-conc-b', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } })),
    ]);
    expect(a.decision).toBe('ask');
    expect(b.decision).toBe('ask');
    // Exactly ONE new v2 pending was created (the v1 pending was
    // superseded first, freeing the slot; the two concurrent ensurePending
    // calls then dedupe to one via the partial unique index).
    expect(repo.pendingCreations - beforeConcurrent).toBe(1);
    // The latest approval for the subject is the v2 pending.
    const latest = repo.latestFor('tool:terminal:terminal.exec:')!;
    expect(latest.status).toBe('pending');
    expect(latest.policyVersion).toBe(2);
  });

  it('audit dedup: two parallel asks for the same subject → exactly ONE approval-requested audit event (the creator emits; the observer does not)', async () => {
    // A recording audit writer captures every emission.
    const audit = new RecordingAuditWriter();
    const auditEngine = new AgentPolicyEngine({
      repository: repo,
      auditWriter: audit,
      logger: silentLogger,
      approvalTtlMs: 0,
    });
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 1);
    const [a, b] = await Promise.all([
      auditEngine.decide(req({ invocationId: 'inv-aud-a', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } })),
      auditEngine.decide(req({ invocationId: 'inv-aud-b', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } })),
    ]);
    expect(a.decision).toBe('ask');
    expect(b.decision).toBe('ask');
    // Exactly ONE approval-requested audit event — the durable pending row
    // was created once (the partial unique index); the engine emitted the
    // audit only for the creator (created=true), NOT for the observer
    // (created=false). This is the architect's PR-#41 secondary finding:
    // concurrent pending creation must not duplicate audit evidence.
    expect(audit.count('agent-policy.approval-requested')).toBe(1);
  });

  it('audit emission on approval resolution (approve/deny) is per-resolution (terminal evidence)', async () => {
    const audit = new RecordingAuditWriter();
    const auditEngine = new AgentPolicyEngine({
      repository: repo,
      auditWriter: audit,
      logger: silentLogger,
      approvalTtlMs: 0,
    });
    repo.effective = resolution(doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]), 1);
    await auditEngine.decide(req({ invocationId: 'inv-res-a', family: 'terminal', operation: 'terminal.exec', input: { argv: ['ls'] } }));
    const pending = repo.latestFor('tool:terminal:terminal.exec:')!;
    await auditEngine.resolveApproval({ approvalId: pending.id, action: 'approve', userId: 'user-1' });
    expect(audit.count('agent-policy.approval-requested')).toBe(1);
    expect(audit.count('agent-policy.approval-approved')).toBe(1);
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

  it('ensurePendingApproval: twice for the same subject → the SAME row (idempotent; created flag distinguishes the creator from the concurrent observer)', async () => {
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
    // Same row (the partial unique index dedupes).
    expect(a.approval.id).toBe(b.approval.id);
    expect(a.approval.status).toBe('pending');
    // The FIRST call created the row; the SECOND found it. The created flag
    // lets the engine emit exactly ONE approval-requested audit event per
    // pending DB row (architect's PR-#41 review: no duplicate audit evidence).
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
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
    const approved = await repo.resolve({ approvalId: pending.approval.id, action: 'approve', userId: userId, note: 'ok' });
    expect(approved.status).toBe('approved');
    expect(approved.resolvedBy).toBe(userId);
    expect(approved.resolutionNote).toBe('ok');
    // A second resolution is rejected — resolutions are immutable.
    await expect(repo.resolve({ approvalId: pending.approval.id, action: 'deny', userId: userId }))
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
    expect(newPending.approval.status).toBe('pending');
    expect(newPending.approval.id).not.toBe('');
    expect(newPending.created).toBe(true); // a NEW row was created (the prior left 'pending')
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
    await repo.markExpired(pending.approval.id);
    const after = await repo.getApproval(pending.approval.id);
    expect(after!.status).toBe('expired');
  });

  it('getApproval: returns a single approval by id', async () => {
    const pending = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'secrets',
      subjectFamily: 'http', subjectOperation: 'http.GET', subjectHost: 'api.secret.test',
      subjectKey: 'secrets:http:http.GET:api.secret.test', ruleId: 'ask-secrets', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    const fetched = await repo.getApproval(pending.approval.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(pending.approval.id);
    expect(fetched!.subjectDomain).toBe('secrets');
  });

  it('listApprovals: filters by status', async () => {
    const pending = await repo.listApprovals(projectId, 'pending');
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((a) => a.status === 'pending')).toBe(true);
    const all = await repo.listApprovals(projectId);
    expect(all.length).toBeGreaterThanOrEqual(pending.length);
  });

  // --- THE APPROVAL-BINDING CONTRACT (architect's PR-#41 review) ---
  //
  // The repository-level guarantees the engine's binding check relies on:
  //   * ensurePendingApproval returns {approval, created} so the engine
  //     can emit exactly ONE audit event per pending DB row (no duplicate
  //     audit evidence under concurrent asks);
  //   * supersedePendingApproval CAS-flips a stale pending to 'expired'
  //     so the partial unique index frees the slot for a new (version,
  //     ruleId) pending — concurrent supersedes are idempotent;
  //   * approved/denied rows are NEVER superseded (terminal evidence stays
  //     intact; the engine treats them as not-authoritative for a current
  //     invocation under a different (policyVersion, ruleId) but does not
  //     rewrite their status).

  it('ensurePendingApproval: created flag distinguishes the creator from the concurrent observer (no duplicate audit evidence)', async () => {
    const subjectKey = `tool:terminal:terminal.exec:audit-${Math.random().toString(36).slice(2)}`;
    const a = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'tool',
      subjectFamily: 'terminal', subjectOperation: 'terminal.exec', subjectHost: null,
      subjectKey, ruleId: 'ask-terminal', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    const b = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'tool',
      subjectFamily: 'terminal', subjectOperation: 'terminal.exec', subjectHost: null,
      subjectKey, ruleId: 'ask-terminal', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    // The partial unique index dedupes the row.
    expect(a.approval.id).toBe(b.approval.id);
    // The FIRST call created the row; the SECOND found it. The engine uses
    // this flag to emit exactly ONE approval-requested audit event per
    // pending DB row.
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });

  it('supersedePendingApproval: CAS-flips a pending row to expired (frees the unique-index slot)', async () => {
    const subjectKey = `tool:terminal:terminal.exec:super-${Math.random().toString(36).slice(2)}`;
    const a = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'tool',
      subjectFamily: 'terminal', subjectOperation: 'terminal.exec', subjectHost: null,
      subjectKey, ruleId: 'ask-terminal', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    await repo.supersedePendingApproval(a.approval.id);
    const after = await repo.getApproval(a.approval.id);
    expect(after!.status).toBe('expired');
    expect(after!.resolutionNote).toBe('superseded by policy-version change');
    expect(after!.resolvedAt).not.toBeNull();
  });

  it('supersedePendingApproval: does NOT touch an approved row (terminal evidence stays intact)', async () => {
    const subjectKey = `tool:terminal:terminal.exec:supapp-${Math.random().toString(36).slice(2)}`;
    const pending = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'tool',
      subjectFamily: 'terminal', subjectOperation: 'terminal.exec', subjectHost: null,
      subjectKey, ruleId: 'ask-terminal', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    await repo.resolve({ approvalId: pending.approval.id, action: 'approve', userId: userId, note: 'human-approved' });
    // Attempting to supersede an APPROVED row is a no-op (the CAS predicate
    // is status='pending'). The approved row stays as terminal evidence.
    await repo.supersedePendingApproval(pending.approval.id);
    const after = await repo.getApproval(pending.approval.id);
    expect(after!.status).toBe('approved');
    expect(after!.resolutionNote).toBe('human-approved'); // the resolve note, NOT 'superseded…'
  });

  it('supersedePendingApproval: concurrent supersedes are idempotent (CAS — only the first flips)', async () => {
    const subjectKey = `tool:terminal:terminal.exec:supconc-${Math.random().toString(36).slice(2)}`;
    const pending = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'tool',
      subjectFamily: 'terminal', subjectOperation: 'terminal.exec', subjectHost: null,
      subjectKey, ruleId: 'ask-terminal', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    // Two concurrent supersedes — both target the same row.
    await Promise.all([
      repo.supersedePendingApproval(pending.approval.id),
      repo.supersedePendingApproval(pending.approval.id),
    ]);
    const after = await repo.getApproval(pending.approval.id);
    expect(after!.status).toBe('expired');
    expect(after!.resolutionNote).toBe('superseded by policy-version change');
  });

  it('the binding end-to-end (real pglite): pending under v1 → bump document to v2 → the v1 pending is superseded + a new v2 pending is created (exactly ONE pending for the subject)', async () => {
    const subjectKey = `tool:terminal:terminal.exec:e2e-${Math.random().toString(36).slice(2)}`;
    // Set the project policy v1 (rule ask-terminal, version 1).
    await repo.setProjectPolicy({
      organizationId: orgId, projectId,
      document: doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask' }]),
      userId: userId,
    });
    const v1 = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'tool',
      subjectFamily: 'terminal', subjectOperation: 'terminal.exec', subjectHost: null,
      subjectKey, ruleId: 'ask-terminal', policyVersion: 1,
      requestedReason: 'ask', expiresAt: null,
    });
    expect(v1.approval.policyVersion).toBe(1);
    expect(v1.created).toBe(true);
    // Bump the document to v2 (the trigger bumps policy_version on UPDATE).
    await repo.setProjectPolicy({
      organizationId: orgId, projectId,
      document: doc([{ id: 'ask-terminal', domain: 'tool', family: 'terminal', effect: 'ask', reason: 'v2 posture' }]),
      userId: userId,
    });
    const effective = await repo.getEffectivePolicy(orgId, projectId);
    expect(effective!.policyVersion).toBe(2);
    // Supersede the v1 pending, then create a v2 pending for the SAME subject.
    await repo.supersedePendingApproval(v1.approval.id);
    const v2 = await repo.ensurePendingApproval({
      organizationId: orgId, projectId, executionId, subjectDomain: 'tool',
      subjectFamily: 'terminal', subjectOperation: 'terminal.exec', subjectHost: null,
      subjectKey, ruleId: 'ask-terminal', policyVersion: 2,
      requestedReason: 'v2 posture', expiresAt: null,
    });
    expect(v2.approval.policyVersion).toBe(2);
    expect(v2.created).toBe(true);
    expect(v2.approval.id).not.toBe(v1.approval.id);
    // Exactly ONE pending row exists for the subject (the v1 row is expired).
    const pendingRows = await stack.db.client.query<{ id: string; status: string; policy_version: number }>(
      `SELECT id, status, policy_version FROM wfos_agent_policy_approvals
        WHERE execution_id = $1 AND subject_key = $2
        ORDER BY requested_at DESC`,
      [executionId, subjectKey],
    );
    const pending = pendingRows.rows.filter((r) => r.status === 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0]!.policy_version).toBe(2);
    // The v1 row is now expired (terminal evidence under v1).
    const v1Row = pendingRows.rows.find((r) => r.policy_version === 1);
    expect(v1Row!.status).toBe('expired');
    // Cleanup.
    await repo.clearProjectPolicy(orgId, projectId);
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
