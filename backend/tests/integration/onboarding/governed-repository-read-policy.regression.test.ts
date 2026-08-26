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

/**
 * A configurable project-scoped policy gate (defaults to allow). PR #42 round-4:
 * tracks the decideForProjectScope call count so the fencing tests can verify
 * the boundary called the gate TWICE per governedRead() (capture + revalidate).
 */
class FakePolicyGate implements ProjectScopedPolicyGate {
  private denied = new Set<string>();
  private constrained: { paths: Set<string>; constraints: ToolPolicyConstraints } | null = null;
  private throwing = false;
  private policyVersion = 1;
  private callCount = 0;
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
  /** The number of times decideForProjectScope was called (round-4: capture + revalidate = 2 per governedRead). */
  getCallCount(): number {
    return this.callCount;
  }
  async decideForProjectScope(request: ToolPolicyRequest) {
    this.callCount++;
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

/**
 * PR #42 round-4: a policy gate that MUTATES its (version, decision) when the
 * content port is called mid-read — simulates a concurrent policy mutation
 * committing DURING the read (between the capture and the revalidation).
 *
 * The flow the architect's regression spec requires:
 *   initial version = 7 (allow)
 *     ↓
 *   governedRead() captures V7 (capture call #1)
 *     ↓
 *   content port readFile/listDir fires -> mutates the gate to V8 (deny)
 *     ↓
 *   governedRead() revalidates (revalidation call #2) -> sees V8 (deny)
 *     ↓
 *   the snapshot (V7/allow) is STALE -> the read result is DISCARDED
 *     -> content=null, performed=false, stale=true
 */
class MutatingPolicyGate implements ProjectScopedPolicyGate {
  private policyVersion = 7;
  private decision: 'allow' | 'deny' | 'constrained' = 'allow';
  private ruleId = 'fake-rule-v7';
  private callCount = 0;
  private mutated = false;

  /** Mutate the policy to V8/deny (called by the hooked content port mid-read). */
  mutateToV8Deny(): void {
    this.policyVersion = 8;
    this.decision = 'deny';
    this.ruleId = 'fake-rule-v8';
    this.mutated = true;
  }
  /** Whether the gate was mutated mid-read. */
  wasMutated(): boolean {
    return this.mutated;
  }
  getCallCount(): number {
    return this.callCount;
  }
  getPolicyVersion(): number {
    return this.policyVersion;
  }
  async decideForProjectScope(_request: ToolPolicyRequest) {
    this.callCount++;
    return {
      decision: this.decision,
      policyVersion: this.policyVersion,
      ruleId: this.ruleId,
      scopeSource: 'project' as const,
      reason: this.mutated ? 'denied by V8 mutation' : 'allowed by V7',
    };
  }
}

/**
 * PR #42 round-4: a content port that fires a hook when readFile/listDir is
 * called — the hook mutates the gate mid-read (between the capture and the
 * revalidation). This is the test hook the architect's regression spec
 * requires: "test hook mutates policy to v8 while read is in flight."
 */
class HookedContentPort implements RepositoryContentPort {
  private files = new Map<string, string>();
  private dirs = new Map<string, { name: string; type: 'file' | 'dir' }[]>();
  private readFileCalls: string[] = [];
  private listDirCalls: string[] = [];
  constructor(private readonly onRead: () => void) {}
  setFile(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }
  setDir(path: string, entries: { name: string; type: 'file' | 'dir' }[]): this {
    this.dirs.set(path, entries);
    return this;
  }
  getReadFileCalls(): readonly string[] {
    return this.readFileCalls;
  }
  getListDirCalls(): readonly string[] {
    return this.listDirCalls;
  }
  async readFile(_owner: string, _repo: string, _sha: string, path: string) {
    this.readFileCalls.push(path);
    this.onRead(); // mutate the policy mid-read (between capture + revalidation)
    const content = this.files.get(path);
    if (content === undefined) return null;
    return { content, contentDigest: sha256(content) };
  }
  async listDir(_owner: string, _repo: string, _sha: string, path: string) {
    this.listDirCalls.push(path);
    this.onRead(); // mutate the policy mid-read
    return this.dirs.get(path) ?? [];
  }
}

/**
 * PR #42 round-4: a policy gate that throws on the SECOND call (the
 * revalidation) — simulates a revalidation-failure. The boundary must FAIL
 * CLOSED (treat as stale; discard the result).
 */
class FailOnRevalidationGate implements ProjectScopedPolicyGate {
  private callCount = 0;
  getCallCount(): number {
    return this.callCount;
  }
  async decideForProjectScope(_request: ToolPolicyRequest) {
    this.callCount++;
    if (this.callCount === 2) {
      throw new Error('simulated revalidation failure');
    }
    return {
      decision: 'allow' as const,
      policyVersion: 7,
      ruleId: 'fake-rule-v7',
      scopeSource: 'project' as const,
    };
  }
}

describe('WORK-038 PR #42 round-3 + round-4 — GovernedRepositoryReadPolicy (the atomic governed-read boundary + the snapshot/fencing protocol)', () => {
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

  // =========================================================================
  // 7. PR #42 ROUND-4 — the snapshot/fencing protocol.
  //
  // The architect's round-4 review identified that the round-3 boundary
  // claimed atomicity but was still a check-then-act window with respect to
  // POLICY CHANGES: decideForProjectScope() (V7) and the GitHub read are two
  // separate async operations against two different authorities, and a
  // concurrent policy update CAN commit between them. The round-4 fix is an
  // explicit snapshot/fencing protocol: capture → read → REVALIDATE →
  // discard-if-stale. The invariant: "a repository-read result is persisted
  // only if the policy snapshot that authorized it is still current when the
  // result is committed."
  // =========================================================================

  it('16. ROUND-4 the normal case (v7 -> read -> revalidate v7 -> persist): the boundary calls decideForProjectScope TWICE (capture + revalidate), the snapshot is current, the result is persisted with revalidation metadata', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"fence-ok"}');
    const gate = new FakePolicyGate(); // policyVersion=1, ruleId='fake-rule', always allow
    const boundary = buildBoundary(port, gate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    // The boundary called the gate TWICE: once for the capture, once for the
    // revalidation (the fence ran).
    expect(gate.getCallCount(), 'capture + revalidation = 2 calls').toBe(2);
    // The snapshot was NOT stale (the policy did not change between capture
    // and revalidation).
    expect(outcome.governance.stale, 'the snapshot was current — not stale').toBe(false);
    expect(outcome.governance.performed, 'the read was persisted').toBe(true);
    // The content IS returned (the result was persisted — the fence cleared).
    expect(outcome.content).not.toBeNull();
    expect(outcome.content!.content).toBe('{"name":"fence-ok"}');
    // The fence metadata is recorded honestly.
    expect(outcome.governance.enforcement.revalidated, 'the fence ran').toBe(true);
    expect(outcome.governance.enforcement.revalidatedPolicyVersion, 'the revalidation saw the same V1').toBe(1);
    expect(outcome.governance.enforcement.revalidatedRuleId).toBe('fake-rule');
    expect(outcome.governance.enforcement.revalidatedDecision).toBe('allow');
    // The snapshot version (capture) and the revalidation version match.
    expect(outcome.governance.policyVersion).toBe(1);
    expect(outcome.governance.enforcement.policyVersion).toBe(1);
    expect(outcome.governance.enforcement.revalidatedPolicyVersion).toBe(
      outcome.governance.enforcement.policyVersion,
    );
    // The read DID happen (the content port was called — once).
    expect(port.getReadFileCalls()).toEqual(['package.json']);
  });

  it('17. ROUND-4 the stale case (v7 capture -> mutation to v8 mid-read -> revalidate v8): the snapshot is STALE, the read result is DISCARDED (content=null, performed=false, stale=true), the revalidation metadata records V8', async () => {
    // The architect's regression spec:
    //   initial version = 7
    //     ↓
    //   governedRead captures v7
    //     ↓
    //   test hook mutates policy to v8 while read is in flight
    //     ↓
    //   read completes
    //     ↓
    //   governedRead rejects the stale result
    //     ↓
    //   zero baseline evidence/observation is persisted
    const gate = new MutatingPolicyGate(); // starts at V7/allow
    const port = new HookedContentPort(() => gate.mutateToV8Deny()).setFile(
      'package.json',
      '{"name":"stale-content"}',
    );
    const boundary = buildBoundary(port, gate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    // The boundary called the gate TWICE: capture (V7) + revalidation (V8).
    expect(gate.getCallCount(), 'capture + revalidation = 2 calls').toBe(2);
    expect(gate.wasMutated(), 'the gate was mutated mid-read').toBe(true);
    // The snapshot is STALE — the read result is DISCARDED.
    expect(outcome.governance.stale, 'the snapshot is stale (V7 -> V8 mid-read)').toBe(true);
    expect(outcome.governance.performed, 'the result was discarded (not persisted)').toBe(false);
    expect(outcome.content, 'the content is DISCARDED (null)').toBeNull();
    // The SNAPSHOT decision (V7/allow) is recorded honestly — the read WAS
    // authorized under V7, but V8 superseded it before the result could be
    // committed.
    expect(outcome.governance.decision, 'the snapshot decision was allow (V7)').toBe('allow');
    expect(outcome.governance.policyVersion, 'the snapshot version was V7').toBe(7);
    expect(outcome.governance.ruleId, 'the snapshot rule was fake-rule-v7').toBe('fake-rule-v7');
    // The REVALIDATION metadata records what the fence saw (V8/deny).
    expect(outcome.governance.enforcement.revalidated, 'the fence ran').toBe(true);
    expect(
      outcome.governance.enforcement.revalidatedPolicyVersion,
      'the revalidation saw V8',
    ).toBe(8);
    expect(outcome.governance.enforcement.revalidatedRuleId).toBe('fake-rule-v8');
    expect(outcome.governance.enforcement.revalidatedDecision).toBe('deny');
    // The stale flag is on the enforcement record too.
    expect(outcome.governance.enforcement.stale).toBe(true);
    expect(outcome.governance.enforcement.performed).toBe(false);
    // The reason explains the staleness.
    expect(outcome.governance.reason).toContain('stale');
    expect(outcome.governance.reason).toContain('version=7');
    expect(outcome.governance.reason).toContain('version=8');
    // The read DID happen (the content port was called — the result was
    // read from GitHub, then discarded by the fence).
    expect(port.getReadFileCalls(), 'the read happened (then was discarded)').toEqual(['package.json']);
  });

  it('18. ROUND-4 a revalidation FAILURE (the gate throws on the revalidation call) -> the boundary FAILS CLOSED (stale outcome; the result is discarded — a revalidation failure must NOT become an implicit persist)', async () => {
    const gate = new FailOnRevalidationGate(); // allow/V7 on call 1, throws on call 2
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"reval-fail"}');
    const boundary = buildBoundary(port, gate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    // The boundary called the gate TWICE: capture (succeeded) + revalidation
    // (threw).
    expect(gate.getCallCount(), 'capture + failed-revalidation = 2 calls').toBe(2);
    // The boundary FAILS CLOSED: treats the revalidation failure as STALE
    // (the result is discarded — a revalidation failure must NOT become an
    // implicit persist).
    expect(outcome.governance.stale, 'revalidation failure -> fail closed (stale)').toBe(true);
    expect(outcome.governance.performed, 'the result was discarded').toBe(false);
    expect(outcome.content, 'the content is DISCARDED (null)').toBeNull();
    // The fence metadata: the revalidation did NOT produce a version (it
    // threw). The revalidation fields are null (honestly "the revalidation
    // failed — no version was seen").
    expect(outcome.governance.enforcement.revalidated, 'the fence ran (and failed)').toBe(true);
    expect(outcome.governance.enforcement.revalidatedPolicyVersion).toBeNull();
    expect(outcome.governance.enforcement.revalidatedRuleId).toBeNull();
    expect(outcome.governance.enforcement.revalidatedDecision).toBeNull();
    expect(outcome.governance.enforcement.stale).toBe(true);
    // The snapshot decision (V7/allow) is still recorded honestly.
    expect(outcome.governance.decision).toBe('allow');
    expect(outcome.governance.policyVersion).toBe(7);
    // The reason explains the revalidation failure.
    expect(outcome.governance.reason).toContain('revalidation failed');
    expect(outcome.governance.reason).toContain('discarded');
    // The read DID happen (the content port was called — the result was
    // read from GitHub, then discarded because the fence could not
    // revalidate).
    expect(port.getReadFileCalls()).toEqual(['package.json']);
  });

  it('19. ROUND-4 a snapshot-rule change WITHOUT a version change (a rule replacement with the same version) -> the fence STILL catches it (defense-in-depth — the ruleId changed)', async () => {
    // Simulates an engine bug (a rule replacement without a version bump).
    // The fence catches it via the ruleId comparison (defense-in-depth).
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"rule-change"}');
    let callCount = 0;
    const ruleChangeGate: ProjectScopedPolicyGate = {
      async decideForProjectScope() {
        callCount++;
        return {
          decision: 'allow' as const,
          policyVersion: 7, // version stays the same
          ruleId: callCount === 1 ? 'rule-A' : 'rule-B', // changes on revalidation
          scopeSource: 'project' as const,
        };
      },
    };
    const boundary = buildBoundary(port, ruleChangeGate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    // The fence caught the ruleId change (defense-in-depth) — the snapshot
    // is stale even though the version stayed the same.
    expect(outcome.governance.stale, 'ruleId change -> stale (defense-in-depth)').toBe(true);
    expect(outcome.governance.performed).toBe(false);
    expect(outcome.content).toBeNull();
    expect(outcome.governance.ruleId, 'the snapshot rule was rule-A').toBe('rule-A');
    expect(outcome.governance.enforcement.revalidatedRuleId, 'the revalidation saw rule-B').toBe('rule-B');
  });

  it('20. ROUND-4 a decision change WITHOUT a version/rule change (an allow->deny flip with no version bump) -> the fence STILL catches it (defense-in-depth — the decision changed)', async () => {
    // Simulates an engine bug (a decision flip without a version/rule bump).
    // The fence catches it via the decision comparison (last-resort signal).
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"decision-flip"}');
    let callCount = 0;
    const decisionFlipGate: ProjectScopedPolicyGate = {
      async decideForProjectScope() {
        callCount++;
        // Version stays 7, rule stays 'rule-X', but the decision flips
        // allow -> deny on the revalidation.
        return {
          decision: callCount === 1 ? ('allow' as const) : ('deny' as const),
          policyVersion: 7,
          ruleId: 'rule-X',
          scopeSource: 'project' as const,
        };
      },
    };
    const boundary = buildBoundary(port, decisionFlipGate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    // The fence caught the decision flip (defense-in-depth) — the snapshot
    // is stale even though the version AND the rule stayed the same.
    expect(outcome.governance.stale, 'decision flip -> stale (defense-in-depth)').toBe(true);
    expect(outcome.governance.performed).toBe(false);
    expect(outcome.content).toBeNull();
    expect(outcome.governance.decision, 'the snapshot decision was allow').toBe('allow');
    expect(outcome.governance.enforcement.revalidatedDecision, 'the revalidation saw deny').toBe('deny');
  });

  it('21. ROUND-4 a gate that surfaces NO policyVersion (a test fake returning {decision:"allow"}) -> the fence still runs (revalidated=true), revalidatedPolicyVersion=null (honestly "not surfaced"), stale=false (no drift signal available — best-effort)', async () => {
    // A minimal test fake that does not surface version/ruleId (the contract
    // allows this — every field except `decision` is optional). The fence
    // still runs (revalidated=true) but cannot detect version drift (the
    // gate surfaces no version). The fence falls back to decision comparison
    // — if the decision is the same on both calls, stale=false (best-effort).
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"minimal"}');
    let callCount = 0;
    const minimalGate: ProjectScopedPolicyGate = {
      async decideForProjectScope() {
        callCount++;
        return { decision: 'allow' as const }; // no version, no ruleId
      },
    };
    const boundary = buildBoundary(port, minimalGate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    expect(callCount, 'capture + revalidation = 2 calls').toBe(2);
    expect(outcome.governance.stale, 'no drift signal -> not stale (best-effort)').toBe(false);
    expect(outcome.governance.performed).toBe(true);
    expect(outcome.content).not.toBeNull();
    // The fence ran but the gate surfaced no version — honestly recorded as
    // null (the production gate ALWAYS surfaces a real version, so the fence
    // is fully effective in production).
    expect(outcome.governance.enforcement.revalidated).toBe(true);
    expect(outcome.governance.enforcement.revalidatedPolicyVersion).toBeNull();
    expect(outcome.governance.enforcement.revalidatedRuleId).toBeNull();
  });

  it('22. ROUND-4 a deny decision does NOT trigger the fence (no revalidation runs — the read never happened, so there is nothing to fence); revalidated=false, stale=false', async () => {
    // A denied read is blocked BEFORE the fence runs — the read never
    // happened, so there is nothing to revalidate. The boundary records
    // revalidated=false, stale=false honestly (the fence did NOT run).
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"denied"}');
    const gate = new FakePolicyGate().denyPath('package.json');
    const boundary = buildBoundary(port, gate);
    const outcome = await boundary.governedRead(readPkg, ctx);
    // The boundary called the gate ONCE (capture only — the deny short-
    // circuited before the read + revalidation).
    expect(gate.getCallCount(), 'capture only (deny short-circuits)').toBe(1);
    expect(outcome.governance.decision).toBe('deny');
    expect(outcome.governance.performed).toBe(false);
    expect(outcome.content).toBeNull();
    // The fence did NOT run (the read never happened).
    expect(outcome.governance.enforcement.revalidated, 'the fence did NOT run').toBe(false);
    expect(outcome.governance.enforcement.revalidatedPolicyVersion).toBeNull();
    expect(outcome.governance.enforcement.stale, 'not stale (the fence did not run)').toBe(false);
    expect(outcome.governance.stale).toBe(false);
    // The read NEVER happened (the content port was never called).
    expect(port.getReadFileCalls()).toEqual([]);
  });

  it('23. ROUND-4 a path-not-allowed refusal does NOT trigger the fence (boundary-level enforcement short-circuits before the gate is even consulted); revalidated=false, stale=false, policyVersion=null', async () => {
    // A path outside the candidate allowlist is refused at the BOUNDARY
    // level — before the policy gate is even consulted. The fence does NOT
    // run (there is no snapshot to revalidate).
    const port = new InMemoryContentPort().setFile('secret.env', 'SECRET=value');
    const boundary = buildBoundary(port, new FakePolicyGate());
    const outcome = await boundary.governedRead(
      { path: 'secret.env', family: 'filesystem', operation: 'read' },
      ctx,
    );
    expect(outcome.governance.decision).toBe('deny');
    expect(outcome.governance.enforcement.pathAllowed).toBe(false);
    expect(outcome.governance.enforcement.performed).toBe(false);
    expect(outcome.governance.enforcement.revalidated, 'the fence did NOT run').toBe(false);
    expect(outcome.governance.enforcement.policyVersion).toBeNull();
    expect(outcome.governance.enforcement.stale).toBe(false);
    expect(outcome.governance.stale).toBe(false);
    expect(port.getReadFileCalls()).toEqual([]);
  });

  // =========================================================================
  // 8. PR #42 ROUND-5 — the persistence-boundary fence.
  //
  // The architect's round-5 review of commit `2a597ed` identified that the
  // round-4 fence protects the READ window but NOT the SUBSEQUENT
  // PERSISTENCE window:
  //
  //   capture V7 -> read -> revalidate V7 (round-4 fence passes) ->
  //   policy mutates V7 -> V8 -> appendEvidence(V7) -> markComplete
  //
  // The round-5 fix exposes a SECOND method on the boundary —
  // `capturePersistenceSnapshot` — that the orchestrator calls AFTER
  // analyze() returns + BEFORE the persistence transaction begins. The
  // /projects repository's `persistBaselineWithPolicyFence` method
  // revalidates the snapshot INSIDE the DB transaction (pre-writes + post-
  // writes + per-read verification) + rolls back if it is stale.
  //
  // These unit tests exercise the boundary's `capturePersistenceSnapshot`
  // method DIRECTLY (no DB, no orchestrator, no analyzer) so the snapshot-
  // capture invariant is verified at the unit level. The onboarding-domain
  // integration suite (test 34) verifies the end-to-end fencing through the
  // orchestrator + repository + DB.
  // =========================================================================

  it('24. ROUND-5 capturePersistenceSnapshot returns the CURRENT policy version + ruleId + decision (the snapshot the persistence fence will revalidate)', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"test"}');
    const gate = new FakePolicyGate(); // policyVersion=1, ruleId='fake-rule'
    const boundary = buildBoundary(port, gate);
    const snapshot = await boundary.capturePersistenceSnapshot(ctx);
    // The snapshot carries the CURRENT policy version + ruleId + decision
    // (the persistence fence's reference values).
    expect(snapshot.policyVersion, 'the snapshot carries the current policyVersion').toBe(1);
    expect(snapshot.ruleId, 'the snapshot carries the matched ruleId').toBe('fake-rule');
    expect(snapshot.decision, 'the snapshot carries the decision (informational — NOT enforced at the persistence boundary)').toBe('allow');
    expect(snapshot.reason).toBeNull(); // FakePolicyGate surfaces no reason for allow
    // PR #42 round-6: the snapshot carries `source` (which authoritative
    // wfos_agent_policies row backs the snapshot — the fence locks that row).
    expect(snapshot.source, 'the snapshot carries the gate-surfaced source').toBe('project');
    // The boundary called the gate ONCE for the capture (the persistence
    // fence's revalidation will call it AGAIN — verified in the integration
    // suite).
    expect(gate.getCallCount(), 'the capture called the gate once').toBe(1);
  });

  it('25. ROUND-5 capturePersistenceSnapshot uses a synthetic persist-baseline request (NOT a real read request — the fence uses ONLY the policyVersion + ruleId for drift detection, NOT the decision)', async () => {
    // Verify the synthetic request shape: the gate receives a request with
    // operation='persist-baseline' (NOT 'read' or 'list'). This keeps the
    // WORK-037 gate's API stable (it always takes a ToolPolicyRequest) +
    // makes the capture's intent explicit in the audit trail.
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"test"}');
    let capturedRequest: ToolPolicyRequest | null = null;
    const spyGate: ProjectScopedPolicyGate = {
      async decideForProjectScope(request: ToolPolicyRequest) {
        capturedRequest = request;
        return {
          decision: 'allow' as const,
          policyVersion: 7,
          ruleId: 'spy-rule',
          scopeSource: 'project' as const,
        };
      },
    };
    const boundary = buildBoundary(port, spyGate);
    await boundary.capturePersistenceSnapshot(ctx);
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.operation, 'the synthetic request uses operation=persist-baseline').toBe('persist-baseline');
    expect(capturedRequest!.family, 'the synthetic request uses family=filesystem').toBe('filesystem');
    expect(capturedRequest!.invocationId, 'the invocationId encodes the persist-baseline intent').toContain('persist-baseline');
    expect(capturedRequest!.executionId, 'the executionId scopes to the baseline').toBe(`onboarding:${ctx.baselineId}`);
  });

  it('26. ROUND-5 capturePersistenceSnapshot FAILS CLOSED on a gate failure (returns a null snapshot — the persistence fence will compare it against a fresh revalidation)', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"test"}');
    const gate = new FakePolicyGate().throwOnNext();
    const boundary = buildBoundary(port, gate);
    const snapshot = await boundary.capturePersistenceSnapshot(ctx);
    // The capture FAILED CLOSED: the snapshot is null (the persistence fence
    // will compare it against a fresh revalidation that also fails-closed —
    // both null = no drift signal = stale=false, best-effort).
    expect(snapshot.policyVersion, 'the snapshot is null (fail-closed)').toBeNull();
    expect(snapshot.ruleId, 'the ruleId is null').toBeNull();
    expect(snapshot.decision, 'the decision is null').toBeNull();
    expect(snapshot.source, 'the source is null (fail-closed — no scope resolved)').toBeNull();
    expect(snapshot.reason, 'the reason explains the fail-closed').toContain('persistence-snapshot-capture-failed');
    // The forensic log was emitted.
    const logOutput = capture.raw();
    expect(logOutput, 'the capture failure was logged (forensic)').toContain('persistence-snapshot-capture-failed');
  });

  it('27. ROUND-5 capturePersistenceSnapshot on a gate that surfaces NO policyVersion (a test fake returning {decision:"allow"}) returns a null policyVersion (the fence falls back to ruleId + decision comparison — best-effort, same as round-4)', async () => {
    const port = new InMemoryContentPort().setFile('package.json', '{"name":"test"}');
    const minimalGate: ProjectScopedPolicyGate = {
      async decideForProjectScope() {
        return { decision: 'allow' as const }; // no version, no ruleId
      },
    };
    const boundary = buildBoundary(port, minimalGate);
    const snapshot = await boundary.capturePersistenceSnapshot(ctx);
    // The gate surfaced no version — the snapshot is null (honestly "not
    // surfaced"). The fence falls back to ruleId + decision comparison.
    expect(snapshot.policyVersion).toBeNull();
    expect(snapshot.ruleId).toBeNull();
    expect(snapshot.decision).toBe('allow');
    // PR #42 round-6: the minimal gate surfaced no scopeSource → the
    // snapshot's source is null (the fence treats null as 'platform-default').
    expect(snapshot.source).toBeNull();
  });
});
