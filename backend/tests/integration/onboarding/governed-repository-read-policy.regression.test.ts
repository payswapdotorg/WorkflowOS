/**
 * WORK-038 PR #42 round-3: the governed repository-read boundary — direct
 * regression coverage.
 *
 * The architect's round-3 review identified the single remaining architectural
 * blocker: the round-2 path was a check-then-act authorization window
 *
 *   PolicyGate.decideForProjectScope()            (decision at T1)
 *     -> if allow/constrained
 *       -> GitHubAdapter.getFileContent/listDir()  (read at T2 > T1)
 *
 * with NOTHING atomic tying the authorization decision to the actual read,
 * and `constrained` having no concrete enforcement effect. The round-3 fix
 * introduces a DISTINCT {@link DefaultGovernedRepositoryReadPolicy} boundary
 * whose governedRead() atomically captures the decision, enforces it,
 * performs the read under the captured decision, applies the `constrained`
 * enforcement, and returns the bound decision+effect+content.
 *
 * This file exercises the boundary DIRECTLY (no DB, no orchestrator, no
 * analyzer) so the atomic-operation + enforcement + drift-prevention
 * invariants are verified at the unit level. The onboarding-domain
 * integration suite (tests 30–32) verifies the same invariants end-to-end
 * through the analyzer + orchestrator + DB.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { DefaultGovernedRepositoryReadPolicy } from '../../../src/onboarding/internal/governed-repository-read-policy.js';
import { GOVERNED_FILESYSTEM_CANDIDATE_ALLOWLIST } from '../../../src/onboarding/internal/governed-filesystem-analyzer.js';
import { OnboardingAnalysisError } from '../../../src/onboarding/onboarding.types.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import type { RepositoryContentPort, ProjectScopedPolicyGate, GovernedReadRequest, AnalysisContext } from '@onboarding/index.js';
import type { ToolPolicyConstraints, ToolPolicyRequest } from '@modules/agents/index.js';

/** sha256 hex of a string. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** An in-memory content port (deterministic file tree). */
class InMemoryContentPort implements RepositoryContentPort {
  private files = new Map<string, string>();
  private dirs = new Map<string, { name: string; type: 'file' | 'dir' }[]>();
  private readFileCalls: string[] = [];
  private listDirCalls: string[] = [];
  setFile(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }
  setDir(path: string, entries: { name: string; type: 'file' | 'dir' }[]): this {
    this.dirs.set(path, entries);
    return this;
  }
  /** The list of paths readFile was actually called with (proves the read happened / did NOT happen). */
  getReadFileCalls(): readonly string[] {
    return this.readFileCalls;
  }
  getListDirCalls(): readonly string[] {
    return this.listDirCalls;
  }
  async readFile(_owner: string, _repo: string, _sha: string, path: string) {
    this.readFileCalls.push(path);
    const content = this.files.get(path);
    if (content === undefined) return null;
    return { content, contentDigest: sha256(content) };
  }
  async listDir(_owner: string, _repo: string, _sha: string, path: string) {
    this.listDirCalls.push(path);
    return this.dirs.get(path) ?? [];
  }
}

/** A content port that always throws (infrastructure failure). */
class FailingContentPort implements RepositoryContentPort {
  constructor(private readonly failureCode = 'github-not-configured') {}
  async readFile(): Promise<never> {
    throw new Error(`${this.failureCode}: simulated infrastructure failure`);
  }
  async listDir(): Promise<never> {
    throw new Error(`${this.failureCode}: simulated infrastructure failure`);
  }
}

/** A configurable project-scoped policy gate (defaults to allow). */
class FakePolicyGate implements ProjectScopedPolicyGate {
  private denied = new Set<string>();
  private constrained: { paths: Set<string>; constraints: ToolPolicyConstraints } | null = null;
  private throwing = false;
  private policyVersion = 1;
  denyPath(path: string): this {
    this.denied.add(path);
    return this;
  }
  constrainPaths(paths: string[], constraints: ToolPolicyConstraints): this {
    this.constrained = { paths: new Set(paths), constraints };
    return this;
  }
  throwOnNext(): this {
    this.throwing = true;
    return this;
  }
  async decideForProjectScope(request: ToolPolicyRequest) {
    if (this.throwing) throw new Error('simulated policy-gate failure');
    const path = request.input.path as string;
    const base = { policyVersion: this.policyVersion, ruleId: 'fake-rule', scopeSource: 'project' as const };
    if (this.denied.has(path)) return { ...base, decision: 'deny' as const, reason: 'denied by test policy' };
    if (this.constrained && this.constrained.paths.has(path)) {
      return { ...base, decision: 'constrained' as const, constraints: this.constrained.constraints, reason: 'constrained by test policy' };
    }
    return { ...base, decision: 'allow' as const };
  }
}

describe('WORK-038 PR #42 round-3 — GovernedRepositoryReadPolicy (the atomic governed-read boundary)', () => {
  let capture: CaptureStream;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    capture = new CaptureStream();
    logger = createLogger({ level: 'info', destination: capture });
  });

  const ctx: AnalysisContext = {
    baselineId: '00000000-0000-0000-0000-000000000001',
    projectId: '00000000-0000-0000-0000-000000000002',
    organizationId: '00000000-0000-0000-0000-000000000003',
    repositoryOwner: 'test-org',
    repositoryName: 'test-repo',
    installationId: '99999',
    baselineCommitSha: '0123456789abcdef0123456789abcdef01234567',
    revisionRef: 'main',
    analysisRunId: 'onboarding:test:test-repo:0123456789abcdef',
    analysisMode: 'native',
  };

  function buildBoundary(port: RepositoryContentPort, gate: ProjectScopedPolicyGate) {
    return new DefaultGovernedRepositoryReadPolicy({
      policyGate: gate,
      contentPort: port,
      candidateAllowlist: GOVERNED_FILESYSTEM_CANDIDATE_ALLOWLIST,
      logger,
    });
  }

  const readPkg: GovernedReadRequest = { path: 'package.json', family: 'filesystem', operation: 'read' };

  // =========================================================================
  // 1. ATOMIC OPERATION — no check-then-act window at the boundary API.
  // =========================================================================

  it('1. allow -> the read IS performed under the captured decision (the decision + the content come back in ONE outcome)', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"test"}');
    const boundary = buildBoundary(port, new FakePolicyGate());
    const outcome = await boundary.governedRead(readPkg, ctx);
    // The decision is 'allow' AND the content is non-null in the SAME outcome
    // — there was no separate decide() call the caller could interleave a
    // policy change between (the boundary method did both).
    expect(outcome.governance.decision).toBe('allow');
    expect(outcome.governance.performed).toBe(true);
    expect(outcome.content).not.toBeNull();
    expect(outcome.content!.content).toBe('{"name":"test"}');
    expect(outcome.content!.contentDigest).toBe(sha256('{"name":"test"}'));
    // The read actually happened (the content port was called).
    expect(port.getReadFileCalls()).toEqual(['package.json']);
  });

  it('2. deny -> the read did NOT happen (the content port was never called) — the decision is enforced, not just consulted', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"test"}');
    const gate = new FakePolicyGate().denyPath('package.json');
    const boundary = buildBoundary(port, gate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    expect(outcome.governance.decision).toBe('deny');
    expect(outcome.governance.performed).toBe(false);
    expect(outcome.content).toBeNull();
    // CRITICAL: the content port was NEVER called — deny actually blocked the
    // read (not just consulted-then-read-anyway, which was the round-2
    // check-then-act window).
    expect(port.getReadFileCalls(), 'deny blocked the read — the content port was never called').toEqual([]);
  });

  it('3. ask -> the read did NOT happen (ask is treated as blocked, like deny)', async () => {
    // The FakePolicyGate doesn't surface 'ask' directly, so use a custom gate.
    const askGate: ProjectScopedPolicyGate = {
      async decideForProjectScope() {
        return { decision: 'ask' as const, reason: 'requires approval', policyVersion: 1, ruleId: 'fake-rule', scopeSource: 'project' };
      },
    };
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"test"}');
    const boundary = buildBoundary(port, askGate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    expect(outcome.governance.decision).toBe('ask');
    expect(outcome.governance.performed).toBe(false);
    expect(outcome.content).toBeNull();
    expect(port.getReadFileCalls(), 'ask blocked the read').toEqual([]);
  });

  // =========================================================================
  // 2. `constrained` has a CONCRETE enforcement effect (maxOutputBytes).
  // =========================================================================

  it('4. constrained + maxOutputBytes -> the observed content IS truncated + the digest is recomputed on the truncated content', async () => {
    const full = 'THIS_IS_A_LONG_PACKAGE_JSON_CONTENT_THAT_EXCEEDS_THE_16_BYTE_CONSTRAINT!!!!!';
    expect(full.length).toBeGreaterThan(16);
    const port = new InMemoryContentPort().setFile('package.json', full);
    const gate = new FakePolicyGate().constrainPaths(['package.json'], { maxOutputBytes: 16 });
    const boundary = buildBoundary(port, gate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    expect(outcome.governance.decision).toBe('constrained');
    expect(outcome.governance.enforcement.truncated).toBe(true);
    expect(outcome.governance.enforcement.maxOutputBytes).toBe(16);
    expect(outcome.governance.enforcement.truncatedAtBytes).toBe(16);
    // The content IS the truncated slice (16 bytes).
    expect(outcome.content!.content).toBe(full.slice(0, 16));
    // The digest is the digest of the TRUNCATED content (what was actually
    // observed), NOT the full content.
    expect(outcome.content!.contentDigest).toBe(sha256(full.slice(0, 16)));
    expect(outcome.content!.contentDigest).not.toBe(sha256(full));
  });

  it('5. constrained + maxOutputBytes LARGER than the content -> no truncation (the constraint is in effect but does not change a small content)', async () => {
    const small = '{"name":"x"}'; // 12 bytes
    const port = new InMemoryContentPort().setFile('package.json', small);
    const gate = new FakePolicyGate().constrainPaths(['package.json'], { maxOutputBytes: 1024 });
    const boundary = buildBoundary(port, gate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    expect(outcome.governance.decision).toBe('constrained');
    expect(outcome.governance.enforcement.truncated).toBe(false);
    expect(outcome.governance.enforcement.maxOutputBytes).toBe(1024);
    expect(outcome.governance.enforcement.truncatedAtBytes).toBeNull();
    expect(outcome.content!.content).toBe(small);
    expect(outcome.content!.contentDigest).toBe(sha256(small));
  });

  it('6. allow (no constraints) -> the FULL content is observed (no truncation) — constrained vs allow return DIFFERENT content for the same path', async () => {
    // Proves `constrained` is a REAL effect, not cosmetic: an allow read and
    // a constrained read of the same path return different digests.
    const full = '0123456789ABCDEF'.repeat(8); // 128 bytes
    const portAllow = new InMemoryContentPort().setFile('package.json', full);
    const portConstrained = new InMemoryContentPort().setFile('package.json', full);
    const allowBoundary = buildBoundary(portAllow, new FakePolicyGate());
    const constrainedBoundary = buildBoundary(
      portConstrained,
      new FakePolicyGate().constrainPaths(['package.json'], { maxOutputBytes: 32 }),
    );
    const allowOutcome = await allowBoundary.governedRead(readPkg, ctx);
    const constrainedOutcome = await constrainedBoundary.governedRead(readPkg, ctx);
    expect(allowOutcome.content!.content).toBe(full);
    expect(allowOutcome.content!.contentDigest).toBe(sha256(full));
    expect(constrainedOutcome.content!.content).toBe(full.slice(0, 32));
    expect(constrainedOutcome.content!.contentDigest).toBe(sha256(full.slice(0, 32)));
    expect(allowOutcome.content!.contentDigest, 'allow vs constrained return DIFFERENT digests').not.toBe(constrainedOutcome.content!.contentDigest);
  });

  // =========================================================================
  // 3. PATH-ALLOWLIST + READ-ONLY (boundary-level structural enforcement).
  // =========================================================================

  it('7. a path NOT in the candidate allowlist -> the boundary refuses (deny + pathAllowed=false + performed=false), even on an allow decision — the read NEVER happens', async () => {
    const port = new InMemoryContentPort().setFile('secret.env', 'SECRET=value');
    const boundary = buildBoundary(port, new FakePolicyGate()); // allow-all
    const outcome = await boundary.governedRead(
      { path: 'secret.env', family: 'filesystem', operation: 'read' }, ctx,
    );
    expect(outcome.governance.decision).toBe('deny');
    expect(outcome.governance.enforcement.pathAllowed).toBe(false);
    expect(outcome.governance.enforcement.performed).toBe(false);
    expect(outcome.content).toBeNull();
    expect(outcome.governance.reason).toContain('not in the candidate allowlist');
    expect(port.getReadFileCalls(), 'the read NEVER happened').toEqual([]);
  });

  it('8. a non-read/list operation -> the boundary refuses (deny + performed=false) — the boundary is structurally read-only', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{}');
    const boundary = buildBoundary(port, new FakePolicyGate()); // allow-all
    const outcome = await boundary.governedRead(
      { path: 'package.json', family: 'filesystem', operation: 'write' }, ctx,
    );
    expect(outcome.governance.decision).toBe('deny');
    expect(outcome.governance.enforcement.performed).toBe(false);
    expect(outcome.governance.reason).toContain('not supported');
    expect(port.getReadFileCalls(), 'the write NEVER happened (the boundary is read-only)').toEqual([]);
  });

  it('9. list operation on a directory IN the allowlist -> the listing IS read', async () => {
    const port = new InMemoryContentPort().setDir('.github/workflows', [{ name: 'ci.yml', type: 'file' }]);
    const boundary = buildBoundary(port, new FakePolicyGate());
    const outcome = await boundary.governedRead(
      { path: '.github/workflows', family: 'filesystem', operation: 'list' }, ctx,
    );
    expect(outcome.governance.decision).toBe('allow');
    expect(outcome.governance.enforcement.performed).toBe(true);
    expect(outcome.content).not.toBeNull();
    expect(outcome.content!.content).toBe('file:ci.yml');
    expect(port.getListDirCalls()).toEqual(['.github/workflows']);
  });

  // =========================================================================
  // 4. EXPECTED-MISSING vs INFRASTRUCTURE FAILURE (round-2 Blocker B preserved).
  // =========================================================================

  it('10. expected-missing (the port returns null) -> performed=true, content=null (the read happened; the path was absent) — NOT an infrastructure failure', async () => {
    const port = new InMemoryContentPort(); // no package.json set -> null
    const boundary = buildBoundary(port, new FakePolicyGate());
    const outcome = await boundary.governedRead(readPkg, ctx);
    expect(outcome.governance.decision).toBe('allow');
    expect(outcome.governance.enforcement.performed, 'the read happened').toBe(true);
    expect(outcome.content, 'the path was absent (null content)').toBeNull();
    expect(port.getReadFileCalls()).toEqual(['package.json']);
  });

  it('11. infrastructure failure (the port throws) -> OnboardingAnalysisError repository-content-unavailable (NOT a false complete)', async () => {
    const port = new FailingContentPort('github-not-configured');
    const boundary = buildBoundary(port, new FakePolicyGate());
    await expect(boundary.governedRead(readPkg, ctx)).rejects.toThrow(OnboardingAnalysisError);
    await expect(boundary.governedRead(readPkg, ctx)).rejects.toMatchObject({
      code: 'repository-content-unavailable',
      failingLocator: 'package.json',
    });
  });

  it('12. the governance record (decision + version + ruleId) is attached to the OnboardingAnalysisError context — the bound authorization travels with the failure', async () => {
    const port = new FailingContentPort();
    const boundary = buildBoundary(port, new FakePolicyGate()); // policyVersion=1, ruleId='fake-rule'
    let caught: OnboardingAnalysisError | null = null;
    try {
      await boundary.governedRead(readPkg, ctx);
    } catch (err) {
      caught = err as OnboardingAnalysisError;
    }
    expect(caught).not.toBeNull();
    // The decision that authorized the (failed) read is in the error context
    // — forensic provenance travels with the failure even though no evidence
    // row is persisted (the orchestrator's markFailed records the
    // failure_stage='repository-content-unavailable').
    expect(caught!.context.decision).toBe('allow');
    expect(caught!.context.policyVersion).toBe(1);
    expect(caught!.context.ruleId).toBe('fake-rule');
  });

  // =========================================================================
  // 5. POLICY DRIFT PREVENTION (decision captured + bound to the read).
  // =========================================================================

  it('13. the policy version snapshot IS recorded in the governance (drift made OBSERVABLE — a later auditor can verify which version authorized the read)', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"drift"}');
    const boundary = buildBoundary(port, new FakePolicyGate()); // policyVersion=1
    const outcome = await boundary.governedRead(readPkg, ctx);
    expect(outcome.governance.policyVersion).toBe(1);
    expect(outcome.governance.ruleId).toBe('fake-rule');
    expect(outcome.governance.enforcement.policyVersion).toBe(1);
    expect(outcome.governance.enforcement.ruleId).toBe('fake-rule');
  });

  it('14. a policy-gate failure -> the boundary fails CLOSED (deny + performed=false) — never an implicit allow', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"test"}');
    const gate = new FakePolicyGate().throwOnNext();
    const boundary = buildBoundary(port, gate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    expect(outcome.governance.decision, 'policy-gate failure -> fail closed (deny)').toBe('deny');
    expect(outcome.governance.enforcement.performed).toBe(false);
    expect(outcome.content).toBeNull();
    expect(port.getReadFileCalls(), 'the read NEVER happened').toEqual([]);
    expect(outcome.governance.reason).toContain('failed to resolve a decision');
  });

  // =========================================================================
  // 6. HONESTY — no fake tool invocation claim (round-2 invariant preserved
  // at the boundary level — the boundary produces no tool_invocation_id).
  // =========================================================================

  it('15. the outcome carries NO toolInvocationId — the boundary does NOT manufacture a Tool Runtime invocation claim (round-2 invariant preserved at the boundary level)', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"test"}');
    const boundary = buildBoundary(port, new FakePolicyGate());
    const outcome = await boundary.governedRead(readPkg, ctx);
    // The outcome shape has NO toolInvocationId field — the boundary is a
    // DISTINCT repository-read boundary, NOT a Tool Runtime invocation. The
    // evidence row records tool_invocation_id=NULL (verified in the
    // integration suite). The decision + effect are recorded in their OWN
    // columns (repository_read_decision + repository_read_enforcement).
    expect(outcome.governance).not.toHaveProperty('toolInvocationId');
    expect(Object.keys(outcome.governance)).not.toContain('toolInvocationId');
  });
});
