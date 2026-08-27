/**
 * PR #46 round 4 + round 5 — the durable execution claim/lease for the
 * cross-mode-handoff obligation: REAL PostgreSQL two-actor concurrency
 * regression.
 *
 * The architect's round-4 review of the round-3 commit (`cd88d9f` — the
 * post-mutation relay enqueue) established that the round-3 reorder closed
 * the live-relay race but NOT the boot-sweep race — the synchronous caller
 * + the boot sweep / the relay reconcile could BOTH drive the same pending
 * obligation between the reserve and the caller's mutation (TWO concurrent
 * handoff drivers → duplicate provider dispatches + conflicting session
 * transitions). The handoff-row UNIQUE constraint did NOT serialize these
 * two executions (both operated on the same already-reserved handoff row;
 * it only fenced creation of a SECOND handoff row).
 *
 * The round-4 fix introduced a durable execution claim/lease on the
 * obligation row itself (migration 0044), shared by the synchronous caller
 * + the relay reconcile. The claim is the serialization boundary — only
 * the claim owner may perform the mutation/session/dispatch critical
 * section. A crashed owner's lease auto-expires (`claim_expires_at < NOW()`)
 * so the boot sweep reclaims + recovers.
 *
 * PR #46 round 5 (the lease-ownership + lease-expiry fixes): the round-5
 * review found two lease-correctness holes in the round-4 implementation:
 * (1) the claim owner was a FIXED per-role string shared by every
 * invocation of that role — an old invocation's `finally` release could
 * clear a NEW owner's live claim after an expiry+reclaim under the same
 * owner string; (2) the fixed 30s lease had NO renewal/fencing — a critical
 * section longer than the lease let a second actor reclaim while the first
 * was still executing. The round-5 fix: unique per-invocation owners
 * (`<role-prefix>:<uuid>`), the claim_epoch fencing token (migration 0045),
 * the heartbeat renewal covering the whole critical section, phase-boundary
 * fence checks, and the epoch-fenced discharge.
 *
 * This file proves the serialization + the lease semantics are REAL by
 * exercising TWO concurrent `pg.Client` connections against the same
 * schema:
 *
 *   R4-#1. T1 caller claims → T2 reconcile CANNOT dispatch concurrently
 *      (the claim-held early return — NO mutate, NO dispatch) → T1
 *      completes → T2 converges (a no-op discharge). The architect's
 *      exact invariant: ZERO duplicate dispatches + ZERO duplicate session
 *      transitions.
 *
 *   R4-#2. A crashed claim is reclaimed by the boot sweep AFTER the lease
 *      expires (crash-reclaim semantics). T1 reserves + claims (short
 *      200ms lease) + "crashes" (no mutate, no release). After the lease
 *      expires, T2's reconcile reclaims + recovers (re-mutate + re-dispatch
 *      + session + discharge).
 *
 *   R4-#3. DB-level serialization — two concurrent `claimHandoffObligation`
 *      calls on the same obligation, exactly one wins. T1 claims → T2's
 *      claim fails (T1 holds a live claim) → T1 releases → T2's retry
 *      succeeds (reclaimed after release).
 *
 *   R5-#1. The architect's EXACT round-5 five-step regression: T1 claims
 *      with owner A (unique, caller role) → the lease expires → T2 (the
 *      SAME role) reclaims with owner B → T1's LATE release CANNOT clear
 *      T2's claim → a THIRD actor cannot acquire the still-live T2 claim.
 *      Also proves T1's stale renewal fails (the fence check) while T2's
 *      live renewal succeeds.
 *
 *   R5-#2. The heartbeat renewal covers the ENTIRE critical section: T1's
 *      critical section outlives the lease (a slow dispatch — parked
 *      mid-section) with the heartbeat active → T2's mid-flight reclaim
 *      FAILS (the lease never expired under the live heartbeating owner) →
 *      T1 completes → ZERO duplicate dispatches / session transitions.
 *
 *   R5-#3. The stalled-owner abort: T1's heartbeat is SUPPRESSED + its
 *      short lease expires while it is parked mid-critical-section → T2
 *      reclaims + completes + discharges → T1 resumes → its next fence
 *      check FAILS (owner/epoch mismatch) → T1 aborts with
 *      'claim-fence-lost' BEFORE any mutation/dispatch → ZERO duplicate
 *      dispatches / session transitions under the exact
 *      stall-then-reclaim interleaving.
 *
 *   R5-#4. The discharge is epoch-fenced: after T2 reclaims (a new epoch),
 *      T1's stale-epoch discharge is REJECTED (0 rows — the obligation
 *      stays pending) while T2's live-epoch discharge succeeds.
 *
 * PR #46 round 7 (the provider-operation exactly-once boundary): the
 * round-7 review found the round-6 dispatch gate protects the AUTHORITATIVE
 * DB OUTCOME but not the PROVIDER OPERATION itself — the submit runs outside
 * the DB transaction, so a lease reclaimed while the first submit is still
 * in flight let the reclaiming owner's take-over re-dispatch start a SECOND
 * provider operation (R6-#2 originally allowed exactly that: both actors
 * submitted, only the DB write was fenced). The round-7 correction adopts
 * the architect's contract option 1 — the exactly-once side-effect boundary
 * via a DURABLE IDEMPOTENCY KEY derived from the LOGICAL HANDOFF IDENTITY
 * (migration 0047's dispatch_idempotency_key, recorded atomically with the
 * gate-open + stamped on the submitted task):
 *
 *   R6-#2 (rewritten). The stall-DURING-the-dispatch interleaving now proves
 *      PROVIDER-OPERATION uniqueness: both actors' submits CONVERGE onto the
 *      SAME keyed provider operation (submitCount === 2,
 *      operationsCreated === 1, both submit keys IDENTICAL, the durable
 *      recorded key EQUAL to the provider operation key) — plus the retained
 *      round-6 DB-fence assertions (ONE authoritative outcome write; T1's
 *      late completion DISCARDED).
 *
 *   R6-#3 (updated). T1's resumed native submit now CONVERGES at the
 *      provider pre-check (the run EXISTS — the durable execution identity):
 *      NO gateway call, NO second adapter invocation; exactly ONE AgentRun
 *      + ONE adapter invocation + ONE authoritative outcome write.
 *
 *   R7-#1 (new — the architect's exact required regression, the native
 *      "prevented from starting a second operation" arm): T1 stalls INSIDE
 *      THE ADAPTER (after the run creation — the provider operation itself
 *      in flight) → the lease expires → T2 reclaims → T2's reconcile
 *      converges on the EXISTING run WITHOUT PERFORMING ANY PROVIDER
 *      OPERATION (adapter invoked EXACTLY ONCE — T1's; ONE AgentRun; T2
 *      never reaches the gateway) → the obligation discharges → T1's
 *      adapter resolves → T1's completion is FENCED OUT.
 *
 * A fake / single-connection test is INSUFFICIENT for these invariants (the
 * architect's round-4 words): the problem is specifically database
 * transaction serialization, so the regression must use REAL PostgreSQL
 * concurrency. The suite SKIPS on pglite (single-threaded WASM cannot
 * demonstrate true blocking) — it runs only when `WORKFLOWOS_DATABASE_URL`
 * is set (CI with a real postgres service).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import type {
  AgentProviderAdapter,
  AgentRequest,
  AgentExecutionResult,
} from '../../../src/modules/agents/internal/agent.types.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import {
  PgExecutionRecordRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../../src/modules/agents/internal/external-execution-provider.js';
import { PgCrossModeHandoffRepository } from '../../../src/modules/agents/internal/pg-cross-mode-handoff-repository.js';
import { DefaultCrossModeHandoffService } from '../../../src/modules/agents/internal/default-cross-mode-handoff-service.js';
import type {
  CrossModeAgentProviderRegistryPort,
  CrossModeExecutionPolicyPort,
  CrossModeExecutionSessionPort,
} from '../../../src/modules/agents/internal/default-cross-mode-handoff-service.js';
import { DefaultExecutionTaskService } from '../../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultExecutionPromptBuilder } from '../../../src/modules/work-items/internal/execution-prompt-builder.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { PgExecutionSessionRepository } from '../../../src/modules/agents/internal/pg-execution-session-repository.js';
import { DefaultExecutionSessionService } from '../../../src/modules/agents/internal/execution-session-service.js';
import type {
  ExecutionSession,
  SessionTransitionResult,
} from '../../../src/modules/agents/internal/execution-session.types.js';
import { PgAgentWorkspaceRepository } from '../../../src/modules/agents/internal/pg-agent-workspace-repository.js';
import { DefaultAgentWorkspaceService } from '../../../src/modules/agents/internal/agent-workspace-service.js';
import type { WorktreeMaterializer } from '../../../src/modules/agents/internal/agent-workspace.types.js';
import { InMemoryQueue } from '@platform/index.js';
import type { DatabaseClient } from '@platform/postgres/database-client.js';
import type {
  CreateCrossModeHandoffInput,
  CrossModeHandoffFencedDispatchOutcome,
  CrossModeHandoffRecord,
  CrossModeHandoffRepository,
} from '../../../src/modules/agents/internal/cross-mode-handoff.types.js';
import { CrossModeHandoffError } from '../../../src/modules/agents/internal/cross-mode-handoff.types.js';
import {
  CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX,
  CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX,
  newCrossModeHandoffClaimOwner,
} from '../../../src/modules/agents/internal/cross-mode-handoff.types.js';
import type {
  ExecutionProvider,
  ExecutionSubmission,
  ExecutionTask,
} from '../../../src/modules/agents/internal/execution.types.js';
import type { AgentPolicyExternalDecision } from '../../../src/modules/agents/internal/agent-policy.types.js';
import type { AgentPolicyHandoffEvaluator } from '../../../src/modules/agents/internal/policy-gated-handoff-service.js';

const isRealPg = !!process.env.WORKFLOWOS_DATABASE_URL && process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

/** A promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` every 10ms until it holds (throws after `timeoutMs`). */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: the condition was not met before the timeout');
    }
    await delay(10);
  }
}

/**
 * PR #46 round 5: narrow a claim result to the claimed branch + return its
 * fencing epoch (the test FAILS if the claim did not succeed — vitest's
 * expect() does not narrow TypeScript unions).
 */
function assertClaimed(
  claim: { claimed: true; claimEpoch: number } | { claimed: false; activeOwner: string | null },
): number {
  if (!claim.claimed) {
    throw new Error(`assertClaimed: the claim did not succeed (activeOwner=${claim.activeOwner})`);
  }
  return claim.claimEpoch;
}

// ---------------------------------------------------------------------------
// Test doubles (narrow ports — mirror the cross-mode-handoff.regression
// test's policy / provider / registry stubs + the persistence-fence-
// concurrency test's Hooked/Counting wrappers).
// ---------------------------------------------------------------------------

class AllowAllAgentPolicyEvaluator implements AgentPolicyHandoffEvaluator {
  async evaluateExternalHandoff(_input: { executionId: string }): Promise<AgentPolicyExternalDecision> {
    return {
      decision: 'allow',
      reason: 'test-allow-all',
      policyVersion: 1,
      scopeSource: 'platform-default',
    };
  }
}

class StubExecutionPolicyService implements CrossModeExecutionPolicyPort {
  constructor(private readonly nativeAllowed: boolean = true) {}
  async getProjectPolicy(_projectId: string): Promise<{ nativeExecutionAllowed: boolean; policyVersion: number | null } | null> {
    return { nativeExecutionAllowed: this.nativeAllowed, policyVersion: 1 };
  }
}

class StubAgentProviderRegistry implements CrossModeAgentProviderRegistryPort {
  getPlatformDefaultProvider(): string | undefined { return 'fake'; }
  getPlatformDefaultModel(): string | undefined { return 'test-model'; }
  async isProviderConfigured(_provider: string, _model: string, _projectId?: string): Promise<boolean> { return true; }
}

/**
 * A recording worktree materializer that tracks the working-tree state per
 * token (mirrors the cross-mode-handoff.regression test's setup — the
 * workspace continuity gate needs a worktree materializer to be wired, but
 * for these tests no worktree state is asserted; the materializer is a
 * minimal stand-in).
 */
class FakeWorktreeMaterializer implements WorktreeMaterializer {
  readonly hostPaths = new Map<string, string>();
  async materialize(input: {
    worktreePathToken: string; repositoryOwner: string; repositoryName: string;
    branch: string; baseRevision: string;
  }): Promise<string> {
    const host = `/fake-cmh-concurrency/${input.worktreePathToken}`;
    if (!this.hostPaths.has(input.worktreePathToken)) {
      this.hostPaths.set(input.worktreePathToken, host);
    }
    return this.hostPaths.get(input.worktreePathToken)!;
  }
  async remove(input: { worktreePathToken: string }): Promise<void> {
    this.hostPaths.delete(input.worktreePathToken);
  }
}

/**
 * PR #46 round 7: a ParkableAgentAdapter — delegates to the REAL
 * FakeAgentAdapter but parks the FIRST `execute` invocation on a supplied
 * gate. Used by the round-7 native regression to stall an actor INSIDE the
 * provider operation itself (the gateway has already created the AgentRun;
 * the ADAPTER — the actual side-effecting provider operation — is in
 * flight). The gateway invokes the adapter only after its own run-creation
 * succeeded, so "parked inside the adapter" is the deepest possible point:
 * the run exists + the provider operation is in flight + the outcome write
 * has not run.
 */
class ParkableAgentAdapter implements AgentProviderAdapter {
  readonly providerName = 'fake';
  private firstParked = false;
  private parked = false;
  private _executeCount = 0;
  constructor(
    private readonly real: FakeAgentAdapter,
    private readonly gate: Promise<void>,
  ) {}
  supports(provider: string): boolean { return provider === 'fake'; }
  /** TRUE once the first invocation has reached the park point (the provider operation is in flight). */
  get inFlight(): boolean { return this.parked; }
  /** The number of `execute` INVOCATIONS (the provider-operation count — incremented at entry, before the park). */
  get executeCount(): number { return this._executeCount; }
  async execute(request: AgentRequest): Promise<AgentExecutionResult> {
    this._executeCount++;
    if (!this.firstParked) {
      this.firstParked = true;
      this.parked = true;
      await this.gate;
      this.parked = false;
    }
    return this.real.execute(request);
  }
}

/**
 * PR #46 round 4: a CountingExternalProvider that wraps the real
 * ExternalExecutionProvider + counts `submit` calls. SHARED between T1 +
 * T2 services so both paths' dispatches are visible through ONE counter
 * (the architect's invariant: ZERO duplicate dispatches — exactly one
 * submit per handoff, regardless of which actor drove it).
 *
 * PR #46 round 6: `parkFirstSubmit` lets a test STALL T1 INSIDE its provider
 * submit (after the fenced dispatch gate was crossed, before the outcome
 * write) — the architect's stall-DURING-the-dispatch interleaving.
 *
 * PR #46 round 7 (the provider-operation exactly-once boundary): the double
 * now models the REAL provider contract — the keyed operation registry.
 * A submit registers its provider-side OPERATION under the task's dispatch
 * idempotency key (falling back to the executionId for unkeyed tasks); a
 * SAME-KEY submit CONVERGES onto the REGISTERED operation — it awaits (and
 * returns) the FIRST operation's promise, and NO second operation is
 * created (exactly like the real ExternalExecutionProvider's registry, and
 * like a Stripe-style idempotency key at a real external platform). The
 * `parkFirstSubmit` gate parks the FIRST CREATED OPERATION (at the provider
 * — before the real generation runs), so BOTH the creator's and a
 * convergent same-key submit await the SAME parked provider-side operation:
 * the test resolves the operation at the PROVIDER (the original submitter's
 * liveness is irrelevant — the operation lives at the provider).
 *
 * The counters prove the round-7 invariant at the PROVIDER level:
 *   - `submitCount` — the number of submit ATTEMPTS (both actors' calls);
 *   - `operationsCreated` — the number of provider OPERATIONS started
 *     (unique keys) — THE provider-operation count;
 *   - `operationKeys()` — the operation identities (one key per operation).
 */
class CountingExternalProvider implements ExecutionProvider {
  readonly name = 'external';
  readonly mode = 'external' as const;
  private _submitCount = 0;
  private _operationsCreated = 0;
  private readonly _submitKeys: string[] = [];
  private readonly operations = new Map<string, Promise<ExecutionSubmission>>();
  private parkGate: Promise<void> | null = null;
  constructor(private readonly real: ExternalExecutionProvider) {}
  /** Park the FIRST CREATED provider operation on the supplied gate (rounds 6+7 — the mid-dispatch stall). */
  parkFirstSubmit(gate: Promise<void>): void {
    this.parkGate = gate;
  }
  async submit(task: ExecutionTask): Promise<ExecutionSubmission> {
    const key = task.dispatchIdempotencyKey ?? task.executionId;
    this._submitCount++;
    this._submitKeys.push(key);
    const registered = this.operations.get(key);
    if (registered) {
      // Round 7 — CONVERGE: the SAME provider operation (awaited when still
      // in flight). NO second operation is created.
      return registered;
    }
    this._operationsCreated++;
    const operation = (async () => {
      // The operation lives at the PROVIDER: the park gate (when armed)
      // stalls the OPERATION ITSELF (before the generation), not the
      // submitter — a convergent same-key submit awaits the same resolution.
      if (this.parkGate) {
        const gate = this.parkGate;
        this.parkGate = null;
        await gate;
      }
      return this.real.submit(task);
    })();
    this.operations.set(key, operation);
    return operation;
  }
  /** The number of `submit` calls so far (both actors' attempts). */
  get submitCount(): number { return this._submitCount; }
  /** The number of provider OPERATIONS created (unique dispatch keys) — proves exactly-one operation. */
  get operationsCreated(): number { return this._operationsCreated; }
  /** The operation identities created so far (one key per operation). */
  operationKeys(): string[] { return [...this.operations.keys()]; }
  /** EVERY submit attempt's key, in order — proves both actors submitted under the SAME key. */
  submitKeys(): string[] { return [...this._submitKeys]; }
}

/**
 * PR #46 round 4: a CountingSessionService that wraps the real
 * DefaultExecutionSessionService + counts `interruptSession` calls. SHARED
 * between T1 + T2 services so both paths' session transitions are visible
 * through ONE counter (the architect's invariant: ZERO duplicate session
 * transitions — exactly one interrupt per handoff, regardless of which
 * actor drove it).
 */
class CountingSessionService implements CrossModeExecutionSessionPort {
  private _interruptCount = 0;
  private _resumeCount = 0;
  private _startCount = 0;
  constructor(private readonly real: CrossModeExecutionSessionPort) {}
  getSessionForExecution(executionId: string): Promise<ExecutionSession | null> {
    return this.real.getSessionForExecution(executionId);
  }
  async interruptSession(sessionId: string, expectedVersion: number): Promise<SessionTransitionResult | null> {
    this._interruptCount++;
    return this.real.interruptSession(sessionId, expectedVersion);
  }
  async resumeSession(sessionId: string, expectedVersion: number): Promise<SessionTransitionResult | null> {
    this._resumeCount++;
    return this.real.resumeSession(sessionId, expectedVersion);
  }
  async startSession(sessionId: string): Promise<ExecutionSession | null> {
    this._startCount++;
    return this.real.startSession(sessionId);
  }
  /** The number of `interruptSession` calls so far (proves exactly-one transition). */
  get interruptCount(): number { return this._interruptCount; }
  /** The number of `resumeSession` calls so far. */
  get resumeCount(): number { return this._resumeCount; }
  /** The number of `startSession` calls so far. */
  get startCount(): number { return this._startCount; }
}

/**
 * PR #46 round 4 + round 5 + round 6: a HookedHandoffRepository that wraps a
 * real CrossModeHandoffRepository + fires hooks for the two-actor tests:
 *
 *   - `willMutate`: fires AFTER `createHandoffAndClaim` succeeds with
 *     `claimed:true` + a caller-role owner (the unique round-5 owner string
 *     starts with the caller role PREFIX) + BEFORE T1's mutateAndDispatch
 *     runs. Used by R4-#1 (T2's claim-held early return) + R5-#3 (the
 *     stalled-owner abort: T1 parks at the hook with its heartbeat
 *     SUPPRESSED while T2 reclaims).
 *   - `onFirstRenew`: fires ONCE after the FIRST successful
 *     `renewHandoffObligationClaim` (the first phase-boundary fence check —
 *     i.e. T1 is INSIDE the critical section with its heartbeat alive).
 *     Used by R5-#2 (the heartbeat liveness: T1 parks mid-section; the
 *     heartbeat keeps renewing; T2's reclaim fails).
 *   - `willEnterDispatchGate` (round 6): fires ONCE BEFORE forwarding
 *     `beginFencedDispatch` — i.e. AFTER the pre-call `ensureFence('dispatch')`
 *     PASSED but BEFORE the atomic gate crossing (T1 has NOT crossed). Used
 *     by R6-#1 (the architect's stall-immediately-BEFORE-the-dispatch
 *     interleaving: T1's resumed begin is fenced out → ZERO provider calls
 *     from T1).
 *   - `onDispatchGateEntered` (round 6): fires ONCE AFTER
 *     `beginFencedDispatch` returns TRUE — i.e. the durable dispatch intent
 *     is crossed at T1's epoch but the provider submit has NOT started. Used
 *     by R6-#3 (the native stall between the gate + the gateway submit: T2
 *     takes over the in-flight gate + completes; T1's resumed submit COLLIDES
 *     on the wfos_agent_runs UNIQUE + conflict-recovers + its outcome write
 *     is fenced out).
 *
 * `stats` (round 6): a SHARED mutable counter object (the SAME object is
 * wired into BOTH T1's + T2's wrappers) counting the dispatch-gate
 * operations across ALL actors — `beginCount` (gate crossings) +
 * `completeTrueCount` (authoritative outcome writes COMMITTED — the count of
 * authoritative provider operations) + `completeFalseCount` (fenced-out
 * completions — discarded outcomes). R6-#2 asserts `completeTrueCount === 1`
 * while BOTH actors submitted: exactly ONE authoritative provider operation
 * under the stall-then-reclaim interleaving.
 *
 * All other calls (including the round-5 `renewHandoffObligationClaim`
 * heartbeat renewals) forward to the real repository.
 */
interface DispatchGateStats {
  beginCount: number;
  completeTrueCount: number;
  completeFalseCount: number;
}

class HookedHandoffRepository implements CrossModeHandoffRepository {
  private renewHookFired = false;
  private willEnterGateHookFired = false;
  private gateEnteredHookFired = false;
  constructor(
    private readonly real: CrossModeHandoffRepository,
    private readonly opts: {
      willMutate?: () => Promise<void>;
      onFirstRenew?: () => Promise<void>;
      willEnterDispatchGate?: () => Promise<void>;
      onDispatchGateEntered?: () => Promise<void>;
      stats?: DispatchGateStats;
    } = {},
  ) {}
  async createHandoff(input: CreateCrossModeHandoffInput): Promise<CrossModeHandoffRecord> {
    return this.real.createHandoff(input);
  }
  async createHandoffAndClaim(
    input: CreateCrossModeHandoffInput,
    owner: string,
    leaseMs: number,
  ): Promise<
    | { handoff: CrossModeHandoffRecord; claimed: true; claimEpoch: number }
    | { handoff: CrossModeHandoffRecord; claimed: false; claimEpoch: null }
  > {
    const result = await this.real.createHandoffAndClaim(input, owner, leaseMs);
    // Fire the hook ONLY when the caller-path claim succeeds (the
    // serialization boundary is held by T1). The owner is now a UNIQUE
    // per-invocation string — match by the caller role PREFIX.
    if (
      result.claimed &&
      owner.startsWith(`${CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX}:`)
    ) {
      if (this.opts.willMutate) await this.opts.willMutate();
    }
    return result;
  }
  async claimHandoffObligation(
    handoffId: string,
    owner: string,
    leaseMs: number,
  ): Promise<
    | { claimed: true; claimEpoch: number }
    | { claimed: false; activeOwner: string | null }
  > {
    return this.real.claimHandoffObligation(handoffId, owner, leaseMs);
  }
  async renewHandoffObligationClaim(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    leaseMs: number,
  ): Promise<boolean> {
    const renewed = await this.real.renewHandoffObligationClaim(
      handoffId,
      owner,
      claimEpoch,
      leaseMs,
    );
    // Fire the renew hook ONCE after the first successful renewal (T1 is
    // inside the critical section — the heartbeat is alive). The hook must
    // NOT fire on subsequent heartbeat renewals (it would park on every
    // beat) — the `renewHookFired` guard makes it a one-shot.
    if (renewed && !this.renewHookFired) {
      this.renewHookFired = true;
      if (this.opts.onFirstRenew) await this.opts.onFirstRenew();
    }
    return renewed;
  }
  async releaseHandoffObligationClaim(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): Promise<boolean> {
    return this.real.releaseHandoffObligationClaim(handoffId, owner, claimEpoch);
  }
  async findByExecutionId(executionId: string): Promise<CrossModeHandoffRecord | null> {
    return this.real.findByExecutionId(executionId);
  }
  async findByIdempotencyKey(key: string): Promise<CrossModeHandoffRecord | null> {
    return this.real.findByIdempotencyKey(key);
  }
  async listPendingHandoffObligations() {
    return this.real.listPendingHandoffObligations();
  }
  async dischargeHandoffObligation(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): Promise<boolean> {
    return this.real.dischargeHandoffObligation(handoffId, owner, claimEpoch);
  }
  async beginFencedDispatch(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    dispatchIdempotencyKey: string,
  ): Promise<boolean> {
    // Round 6: the willEnterDispatchGate hook fires BEFORE the atomic gate
    // crossing — the pre-call ensureFence('dispatch') has ALREADY passed (a
    // false-positive pass, exactly the architect's round-6 residual window)
    // but the durable dispatch intent is NOT yet crossed.
    if (!this.willEnterGateHookFired) {
      this.willEnterGateHookFired = true;
      if (this.opts.willEnterDispatchGate) await this.opts.willEnterDispatchGate();
    }
    const began = await this.real.beginFencedDispatch(
      handoffId,
      owner,
      claimEpoch,
      dispatchIdempotencyKey,
    );
    if (began) {
      if (this.opts.stats) this.opts.stats.beginCount += 1;
      // Round 6: the onDispatchGateEntered hook fires AFTER a successful
      // crossing (the durable dispatch intent is open at THIS actor's epoch;
      // the provider submit has NOT started).
      if (!this.gateEnteredHookFired) {
        this.gateEnteredHookFired = true;
        if (this.opts.onDispatchGateEntered) await this.opts.onDispatchGateEntered();
      }
    }
    return began;
  }
  async completeFencedDispatch(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    executionRecordId: string,
    outcome: CrossModeHandoffFencedDispatchOutcome,
  ): Promise<boolean> {
    const completed = await this.real.completeFencedDispatch(
      handoffId,
      owner,
      claimEpoch,
      executionRecordId,
      outcome,
    );
    if (this.opts.stats) {
      if (completed) this.opts.stats.completeTrueCount += 1;
      else this.opts.stats.completeFalseCount += 1;
    }
    return completed;
  }
}

describe.skipIf(!isRealPg)('PR #46 round 4 + round 5 + round 6 + round 7 — the durable cross-mode-handoff claim/lease, the unique-owner/heartbeat/epoch-fence lease semantics, the FENCED DISPATCH boundary, + the KEYED provider-dispatch exactly-once boundary (real PostgreSQL two-actor concurrency)', () => {
  let stack: TestAuthStack;
  let second: { client: DatabaseClient; close: () => Promise<void> } | undefined;

  let executionRecordRepo: PgExecutionRecordRepository;
  let crossModeHandoffRepo: PgCrossModeHandoffRepository;
  let agentRunRepo: PgAgentRunRepository;
  let contextRepo: PgImplementationContextRepository;
  let executionTaskService: DefaultExecutionTaskService;
  let nativeExecutionProvider: NativeExecutionProvider;
  let countingExternalProvider: CountingExternalProvider;
  let auditService: DefaultAuditService;
  let sessionRepo: PgExecutionSessionRepository;
  let executionSessionService: DefaultExecutionSessionService;
  let countingSessionService: CountingSessionService;
  let workspaceRepo: PgAgentWorkspaceRepository;
  let agentWorkspaceService: DefaultAgentWorkspaceService;
  let implementationContextBuilder: DefaultImplementationContextBuilder;

  let orgId: string;
  let projectId: string;
  let workItemId: string;
  let workOrderId: string;
  let sharedContextId: string;

  let execCount = 0;
  const nextExecId = () => `wf-cmh-r4-${++execCount}`;

  /** PR #46 round 7: the suite-level FakeAgentAdapter — hoisted so the
   *  regressions can assert the ADAPTER-invocation count (the native
   * provider operation count) directly on the adapter. */
  let fakeAgent: FakeAgentAdapter;

  beforeAll(() => {
    // Real-PG only; pglite cannot demonstrate true two-actor concurrency.
  });

  beforeEach(async () => {
    process.env.AGENT_PROVIDER_NAME = 'fake';
    process.env.AGENT_API_KEY = 'test-agent-key';
    process.env.AGENT_DEFAULT_MODEL = 'test-model';

    stack = await buildAuthStack({ AGENT_API_KEY: 'test-agent-key' });
    const db = stack.db.client;
    executionRecordRepo = new PgExecutionRecordRepository(db);
    crossModeHandoffRepo = new PgCrossModeHandoffRepository(db);
    agentRunRepo = new PgAgentRunRepository(db);
    contextRepo = new PgImplementationContextRepository(db);
    auditService = new DefaultAuditService(db, stack.db.logger);

    // The native execution provider (real NativeExecutionProvider against the
    // deterministic FakeAgentAdapter — the SAME setup the cross-mode-handoff
    // regression test uses). PR #46 round 7: the fakeAgent is hoisted to the
    // suite scope so the regressions can assert the ADAPTER-invocation count
    // (the native provider operation — the round-7 provider-operation
    // uniqueness proof).
    fakeAgent = new FakeAgentAdapter();
    const gateway = new DefaultAgentGateway(db, stack.db.logger, [fakeAgent], 3);
    nativeExecutionProvider = new NativeExecutionProvider({
      agentGateway: gateway,
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
    });
    countingExternalProvider = new CountingExternalProvider(new ExternalExecutionProvider());

    const promptBuilder = new DefaultExecutionPromptBuilder();
    implementationContextBuilder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      contextRepo,
      async () => null,
      async () => null,
      async () => [],
      async () => [],
    );
    executionTaskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder,
      contextRepository: contextRepo,
      promptBuilder,
      logger: stack.db.logger,
    });

    // The real WORK-034 session service + the shared CountingSessionService
    // wrapper (both T1 + T2 services share this instance — the session row
    // is in the shared schema, so a single underlying session service is
    // correct; the counter is the proof of exactly-one interrupt).
    sessionRepo = new PgExecutionSessionRepository(db);
    executionSessionService = new DefaultExecutionSessionService({
      sessionRepository: sessionRepo,
      executionRecordRepository: executionRecordRepo,
      logger: stack.db.logger,
    });
    countingSessionService = new CountingSessionService(executionSessionService);

    // The workspace service (the continuity gate needs it; no workspace state
    // is asserted in these tests — the gate passes when no workspace exists).
    workspaceRepo = new PgAgentWorkspaceRepository({
      db,
      executionRecordRepository: executionRecordRepo,
      projectGitHubRepositoryLookup: {
        findByProject: async (pid: string) => {
          const r = await db.query<{ id: string; project_id: string; owner: string; repository: string; default_branch: string; installation_id: string }>(
            `SELECT id, project_id, owner, repository, default_branch, installation_id
             FROM wfos_project_github_repositories WHERE project_id = $1 LIMIT 1`,
            [pid],
          );
          const row = r.rows[0];
          return row
            ? {
                id: row.id, projectId: row.project_id, owner: row.owner,
                repository: row.repository, defaultBranch: row.default_branch,
                installationId: row.installation_id,
              }
            : null;
        },
      },
      baselineResolver: {
        getBranch: async (_input: { owner: string; repository: string; branchName: string; installationId: string }) => ({
          sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        }),
      },
    });
    agentWorkspaceService = new DefaultAgentWorkspaceService({
      workspaceRepository: workspaceRepo,
      materializer: new FakeWorktreeMaterializer(),
      logger: stack.db.logger,
    });

    // Seed the project / architecture / work-item / work-order / shared
    // implementation context (mirrors the cross-mode-handoff regression
    // test's beforeAll seed).
    const org = await stack.organizationRepository.create({ name: 'W042 R4 Concurrency Org' });
    orgId = org.id;
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'W042 R4 Concurrency Project' });
    projectId = project.id;
    await stack.db.client.query(
      `INSERT INTO wfos_project_github_repositories
         (project_id, installation_id, owner, repository, default_branch, link_type)
       VALUES ($1, 'inst-w042-r4', 'w042-r4-org', 'w042-r4-repo', 'main', 'linked')`,
      [projectId],
    );
    const arch = await stack.architectureRepository.create({ projectId, name: 'W042 R4 Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W042 R4', digestSha256: 'w042-r4-digest-1' });
    const req = await stack.requirementRepository.create({
      architectureVersionId: version.id, requirementId: 'REQ-W042-R4-001',
      title: 'Calculator adds', description: 'add(2,3)===5',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id, criterionId: 'AC-W042-R4-001',
      description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
    });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id, workItemId: 'WORK-W042-R4-001',
      title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
      metadata: { baseCommit: 'w042-r4-baseline-commit-0000000000000001' },
    });
    await stack.workItemRequirementRepository.associate(workItem.id, req.id);
    await stack.workItemCriterionRepository.associate(workItem.id, crit.id);
    const workOrder = await stack.workOrderRepository.create({
      workItemId: workItem.id, projectId, architectureVersionId: version.id,
      requirementIds: [req.id], criterionIds: [crit.id], scope: 'src/calc.ts',
      verificationRequirements: ['unit-test: add(2,3)===5'],
    });
    workItemId = workItem.id;
    workOrderId = workOrder.id;
    const ctx = await implementationContextBuilder.build(workItem.id);
    sharedContextId = ctx.id;

    // Open the SECOND independent pg.Client (T2) against the same schema
    // (mirrors the persistence-fence-concurrency test's setup).
    second = stack.db.createSecondClient ? await stack.db.createSecondClient() : undefined;
  });

  afterEach(async () => {
    if (second) await second.close();
    await stack.teardown();
    delete process.env.AGENT_PROVIDER_NAME;
    delete process.env.AGENT_API_KEY;
    delete process.env.AGENT_DEFAULT_MODEL;
  });

  afterAll(async () => {
    // nothing extra (the schema is dropped in stack.teardown).
  });

  // -------------------------------------------------------------------------
  // Helpers (mirror the cross-mode-handoff regression test's helpers).
  // -------------------------------------------------------------------------

  /** Create a native execution record in the failed state. */
  async function createNativeRecord(
    status: 'created' | 'running' | 'failed' | 'completed' = 'failed',
  ): Promise<{ executionId: string; recordId: string }> {
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
      branch: 'feat/work-w042-r4-001',
    });
    if (status !== 'created') {
      await executionRecordRepo.updateStatus(record.id, { status, completedAt: status === 'failed' || status === 'completed' ? new Date() : null });
    }
    return { executionId, recordId: record.id };
  }

  /** Create a REAL running ExecutionSession for an execution. */
  async function createRunningSession(executionId: string): Promise<{ sessionId: string; version: number }> {
    const session = await executionSessionService.ensureSession(executionId);
    const started = await executionSessionService.startSession(session.id);
    const current = started ?? await sessionRepo.getSession(session.id);
    return { sessionId: current!.id, version: current!.version };
  }

  /** Count handoff log rows for an execution. */
  async function countHandoffsForExecution(executionId: string): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_execution_mode_handoffs h
       JOIN wfos_executions e ON e.id = h.execution_record_id
       WHERE e.execution_id = $1`,
      [executionId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** Count pending cross-mode-handoff obligations for an execution. */
  async function countPendingObligations(executionId: string): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_cross_mode_handoff_obligations o
       JOIN wfos_execution_mode_handoffs h ON h.id = o.handoff_id
       JOIN wfos_executions e ON e.id = o.execution_id
       WHERE e.execution_id = $1 AND o.discharged_at IS NULL`,
      [executionId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** Count discharged cross-mode-handoff obligations for an execution. */
  async function countDischargedObligations(executionId: string): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_cross_mode_handoff_obligations o
       JOIN wfos_execution_mode_handoffs h ON h.id = o.handoff_id
       JOIN wfos_executions e ON e.id = o.execution_id
       WHERE e.execution_id = $1 AND o.discharged_at IS NOT NULL`,
      [executionId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** Build a T1 (caller-path) service on T1's client, sharing the counting
   *  providers. The optional hooks (`willMutate` / `onFirstRenew` /
   *  `willEnterDispatchGate` / `onDispatchGateEntered`) wrap T1's
   *  `crossModeHandoffRepository` in a `HookedHandoffRepository` so the test
   *  can run T2 BETWEEN T1's reserve+claim and T1's mutate (willMutate), park
   *  T1 INSIDE the critical section after the first fence check
   *  (onFirstRenew), park T1 after the pre-call dispatch fence passed but
   *  BEFORE the atomic gate crossing (willEnterDispatchGate), or park T1
   *  AFTER the gate crossing but BEFORE the provider submit
   *  (onDispatchGateEntered). The optional `leaseMs` / `heartbeatMs`
   *  configure the round-5 lease + heartbeat (a huge heartbeatMs SUPPRESSES
   *  the heartbeat — simulating a stalled owner whose renewals stopped).
   *  The optional `stats` is the SHARED dispatch-gate counter object (also
   *  wired into T2's wrapper when passed to buildT2Service). The optional
   *  `nativeProvider` (round 7) OVERRIDES the suite-level native provider
   *  (e.g. a gateway wired to a ParkableAgentAdapter — an actor that stalls
   *  INSIDE the adapter, the deepest provider-operation point). */
  function buildT1Service(opts: {
    willMutate?: () => Promise<void>;
    onFirstRenew?: () => Promise<void>;
    willEnterDispatchGate?: () => Promise<void>;
    onDispatchGateEntered?: () => Promise<void>;
    leaseMs?: number;
    heartbeatMs?: number;
    stats?: DispatchGateStats;
    nativeProvider?: NativeExecutionProvider;
  } = {}): DefaultCrossModeHandoffService {
    const hasHooks =
      opts.willMutate || opts.onFirstRenew ||
      opts.willEnterDispatchGate || opts.onDispatchGateEntered || opts.stats;
    const repo: CrossModeHandoffRepository = hasHooks
      ? new HookedHandoffRepository(crossModeHandoffRepo, {
          ...(opts.willMutate ? { willMutate: opts.willMutate } : {}),
          ...(opts.onFirstRenew ? { onFirstRenew: opts.onFirstRenew } : {}),
          ...(opts.willEnterDispatchGate ? { willEnterDispatchGate: opts.willEnterDispatchGate } : {}),
          ...(opts.onDispatchGateEntered ? { onDispatchGateEntered: opts.onDispatchGateEntered } : {}),
          ...(opts.stats ? { stats: opts.stats } : {}),
        })
      : crossModeHandoffRepo;
    return new DefaultCrossModeHandoffService({
      executionRecordRepository: executionRecordRepo,
      crossModeHandoffRepository: repo,
      executionTaskService,
      nativeExecutionProvider: opts.nativeProvider ?? nativeExecutionProvider,
      externalExecutionProvider: countingExternalProvider,
      agentRunRepository: agentRunRepo,
      agentPolicyEvaluator: new AllowAllAgentPolicyEvaluator(),
      executionPolicyService: new StubExecutionPolicyService(true),
      agentProviderRegistryService: new StubAgentProviderRegistry(),
      executionSessionService: countingSessionService,
      agentWorkspaceService,
      auditService,
      logger: stack.db.logger,
      // A real InMemoryQueue (T1's enqueue happens AFTER the mutate; no worker
      // drains it — the tests check the handoff result + the obligation state
      // directly, not the relay delivery).
      queue: new InMemoryQueue(),
      // PR #46 round 5: configurable lease + heartbeat for the lease-semantics
      // regressions (R5-#2 uses a short lease with the DEFAULT heartbeat to
      // prove liveness; R5-#3/R6-* use a short lease with a SUPPRESSED
      // heartbeat to prove the fence/gate aborts).
      ...(opts.leaseMs !== undefined ? { handoffClaimLeaseMs: opts.leaseMs } : {}),
      ...(opts.heartbeatMs !== undefined ? { handoffClaimHeartbeatMs: opts.heartbeatMs } : {}),
    });
  }

  /** Build a T2 (relay-path) service on the SECOND client, sharing the
   *  counting providers (so T2's dispatch/session calls are visible through
   *  the SAME counters as T1's). T2's repos use `second.client`; the
   *  underlying session row + record row are in the SHARED schema (both
   *  clients point to the same schema). The optional `stats` is the SHARED
   *  dispatch-gate counter object (the SAME object wired into T1's wrapper —
   * R6 asserts exactly ONE authoritative outcome write across BOTH actors). */
  function buildT2Service(opts: { stats?: DispatchGateStats } = {}): DefaultCrossModeHandoffService {
    if (!second) throw new Error('T2 second client is not open (isRealPg=false?)');
    const t2RecordRepo = new PgExecutionRecordRepository(second.client);
    const t2HandoffRepo = opts.stats
      ? new HookedHandoffRepository(new PgCrossModeHandoffRepository(second.client), { stats: opts.stats })
      : new PgCrossModeHandoffRepository(second.client);
    return new DefaultCrossModeHandoffService({
      executionRecordRepository: t2RecordRepo,
      crossModeHandoffRepository: t2HandoffRepo,
      executionTaskService,
      nativeExecutionProvider,
      externalExecutionProvider: countingExternalProvider,
      agentRunRepository: agentRunRepo,
      agentPolicyEvaluator: new AllowAllAgentPolicyEvaluator(),
      executionPolicyService: new StubExecutionPolicyService(true),
      agentProviderRegistryService: new StubAgentProviderRegistry(),
      // SHARED CountingSessionService — T2's interruptSession calls go through
      // the same counter as T1's (proves exactly-one interrupt regardless of
      // which actor drove it).
      executionSessionService: countingSessionService,
      agentWorkspaceService,
      auditService,
      logger: stack.db.logger,
      queue: new InMemoryQueue(),
    });
  }

  // =========================================================================
  // R4-#1. T1 caller claims → T2 reconcile CANNOT dispatch concurrently →
  // T1 completes → T2 converges (ZERO duplicate dispatches + ZERO duplicate
  // session transitions). The architect's exact round-4 invariant.
  // =========================================================================
  it('R4-#1. T1 caller claims → T2 reconcile CANNOT dispatch concurrently (claim-held early return) → T1 completes → T2 converges (ZERO duplicate dispatches + ZERO duplicate session transitions)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);

    const t2Service = buildT2Service();

    // The willMutate hook: fires AFTER T1's reserve+claim commits (T1 holds
    // the live claim) + BEFORE T1's mutateAndDispatch runs. Starts T2's
    // reconcile on the SECOND client + awaits it. T2's reconcile tries to
    // claim → fails (T1 holds a live 30s claim) → returns
    // `{ stage: 'claim-held' }` (NO mutate, NO dispatch, NO session
    // transition). This is the architect's invariant: a concurrent reconcile
    // CANNOT re-mutate + re-dispatch the same obligation while the caller
    // holds the claim.
    let t2FirstResult: unknown = undefined;
    const willMutate = async () => {
      t2FirstResult = await t2Service.reconcileCrossModeHandoffForExecution(executionId);
    };
    // Build T1 with the willMutate hook (the hook fires inside T1's
    // HookedHandoffRepository.createHandoffAndClaim wrapper).
    const hookedT1Service = buildT1Service({ willMutate });

    // T1's handoff: reserve + claim (succeeds) → willMutate fires (T2
    // attempts to claim → fails → returns claim-held) → T1 continues:
    // mutateAndDispatch (record external/handoff_ready + packageValue +
    // session interrupted) → enqueueRelayJob → finally release.
    await hookedT1Service.handoff(
      executionId,
      { targetMode: 'external', idempotencyKey: `r4-race-${executionId}` },
      { userId: 'test-user', source: 'cmh-test' },
    );

    // T2's FIRST attempt: claim failed (T1 held the live claim throughout T1's
    // critical section) → returned the claim-held early-return BEFORE any
    // mutate/dispatch. NO re-mutate, NO re-dispatch, NO session transition.
    expect(t2FirstResult, 'T2\'s first reconcile returned a result (the claim-held early-return)').toBeDefined();
    expect((t2FirstResult as { stage?: string }).stage, 'T2\'s first reconcile stage is claim-held (NO mutate, NO dispatch)').toBe('claim-held');

    // T2's RETRY: T1 has completed + released the claim. T2's claim succeeds
    // now → finds the handoff complete (record external + packageValue +
    // session interrupted) → discharges (a no-op reconcile — no re-mutate, no
    // re-dispatch).
    const t2RetryResult = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2RetryResult.stage, 'T2\'s retry converged + discharged (claim succeeded after T1 released)').toBe('complete');

    // THE ARCHITECT'S EXACT INVARIANT: ZERO duplicate dispatches + ZERO
    // duplicate session transitions. Only T1 dispatched + interrupted (T2's
    // first attempt returned early; T2's retry was a no-op discharge).
    expect(countingExternalProvider.submitCount, 'ZERO duplicate dispatches — only T1 dispatched (T2 was claim-held then no-op discharge)').toBe(1);
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions — only T1 interrupted (T2 was claim-held then no-op discharge)').toBe(1);

    // Exactly ONE handoff log row (no duplicate — no concurrent driver).
    expect(await countHandoffsForExecution(executionId)).toBe(1);
    // The obligation discharged (T2's retry confirmed completion).
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);

    // The final state: the record IS external/handoff_ready + packageValue +
    // the session IS interrupted (converged).
    const after = await executionRecordRepo.findByExecutionId(executionId);
    expect(after!.id).toBe(recordId);
    expect(after!.mode).toBe('external');
    expect(after!.status).toBe('handoff_ready');
    expect(after!.packageValue).not.toBeNull();
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');
  });

  // =========================================================================
  // R4-#2. A crashed claim is reclaimed by the boot sweep AFTER the lease
  // expires (crash-reclaim semantics). T1 reserves + claims (short 200ms
  // lease) + "crashes" (no mutate, no release). After the lease expires,
  // T2's reconcile reclaims + recovers.
  // =========================================================================
  it('R4-#2. a crashed claim is reclaimed by the boot sweep after the lease expires (crash-reclaim semantics — T2 reclaims + recovers)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);

    const t1Service = buildT1Service();
    const t2Service = buildT2Service();
    // Silence the unused-variable lint: t1Service is constructed for symmetry
    // (T1's repos on T1's client — but T1 "crashes" before the service's
    // mutateAndDispatch runs, so the service is not invoked in this test; the
    // claim is acquired directly via the repo to simulate the crash).
    void t1Service;

    // T1 "crashes" after reserve+claim: directly call
    // `crossModeHandoffRepo.createHandoffAndClaim(...)` with a SHORT 200ms
    // lease (simulate the caller's reserve+claim with NO subsequent
    // mutate/release — the process died mid-critical-section). PR #46 round
    // 5: the owner is a UNIQUE per-invocation identity (the caller role
    // prefix + a UUID — the same composition the service uses). The
    // createInput is built from the record (mirrors the service's
    // reserveAndClaim build).
    const record = await executionRecordRepo.findByExecutionId(executionId);
    expect(record).not.toBeNull();
    const createInput: CreateCrossModeHandoffInput = {
      executionRecordId: record!.id,
      fromMode: record!.mode,
      toMode: 'external',
      reason: 'r4-crash-reclaim',
      actor: 'test-user',
      source: 'cmh-test',
      previousStatus: record!.status,
      resultingStatus: 'handoff_ready',
      previousAgentRunId: record!.agentRunId,
      previousExternalSessionRef: record!.externalSessionRef,
      previousPackageValue: record!.packageValue,
      authorized: true,
      policyDecision: 'test-allow-all',
      idempotencyKey: `r4-crash-${executionId}`,
    };
    const claimResult = await crossModeHandoffRepo.createHandoffAndClaim(
      createInput,
      newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX),
      200, // short 200ms lease — the crash-reclaim window
    );
    expect(claimResult.claimed, 'T1 acquired the claim (200ms lease) before "crashing"').toBe(true);
    // PR #46 round 5: the claim also minted the fencing epoch (migration
    // 0045) — a positive token identifying THIS lease.
    expect(claimResult.claimEpoch, 'the crashed claim minted a fencing epoch (claim_epoch)').toBeGreaterThan(0);
    expect(await countPendingObligations(executionId)).toBe(1);

    // The record is STILL native (T1 never mutated).
    const midRecord = await executionRecordRepo.findByExecutionId(executionId);
    expect(midRecord!.mode).toBe('native');

    // Wait for the 200ms lease to expire (the reclaimable window).
    await delay(250);

    // T2 (boot sweep): reconcile on the SECOND client. T2's claim succeeds
    // (the lease expired — `claim_expires_at < NOW()` arm of the reclaim
    // predicate). T2 sees `record.mode !== toMode` (T1 never mutated) →
    // re-mutate + re-dispatch + session transition + discharge.
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed the expired claim + recovered (re-mutated + re-dispatched + discharged)').toBe('complete');

    // T2 dispatched exactly once (the re-dispatch). T2 interrupted the
    // session exactly once (the session transition). NO duplicate from T1
    // (T1 crashed before mutating).
    expect(countingExternalProvider.submitCount, 'T2 dispatched exactly once (the re-dispatch after reclaim)').toBe(1);
    expect(countingSessionService.interruptCount, 'T2 interrupted the session exactly once (the transition after reclaim)').toBe(1);

    // The boot sweep reclaimed + recovered: the obligation DISCHARGED.
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
    expect(await countHandoffsForExecution(executionId)).toBe(1);

    // The final state: record external + packageValue + session interrupted
    // (T2 drove the handoff to completion after reclaiming the crashed
    // claim).
    const after = await executionRecordRepo.findByExecutionId(executionId);
    expect(after!.id).toBe(recordId);
    expect(after!.mode).toBe('external');
    expect(after!.status).toBe('handoff_ready');
    expect(after!.packageValue).not.toBeNull();
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');
  });

  // =========================================================================
  // R4-#3. DB-level serialization — two concurrent `claimHandoffObligation`
  // calls on the same obligation, exactly one wins. T1 (client1 repo) claims
  // → T2 (client2 repo) claims → fails (T1 holds a live claim) → T1 releases
  // → T2 retries → succeeds (reclaimed after release). Proves the
  // conditional UPDATE serializes concurrent actors at the DB level (NOT an
  // application-level check).
  // =========================================================================
  it('R4-#3. DB-level serialization — two concurrent claimHandoffObligation calls on the same obligation, exactly one wins (T2 fails while T1 holds; T2 succeeds after T1 releases)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const t1Service = buildT1Service();

    // Use T1's service to create the handoff + obligation (the happy-path
    // reserve + claim + mutate + dispatch + release). After this, the
    // obligation exists + is PENDING + UNCLAIMED (T1's finally released
    // the claim).
    await t1Service.handoff(
      executionId,
      { targetMode: 'external', idempotencyKey: `r4-claim-${executionId}` },
      { userId: 'test-user', source: 'cmh-test' },
    );
    expect(await countPendingObligations(executionId)).toBe(1);

    // Reset the obligation to PENDING + UNCLAIMED + the record to native
    // (so T2's reconcile, if it could claim, would re-mutate). This isolates
    // the claim-UPDATE serialization from the service-level handoff state.
    // PR #46 round 5: also reset claim_epoch to 0 (a fresh fencing-token
    // baseline for the direct claim calls below). PR #46 round 6: also reset
    // the dispatch gate (dispatch_state/dispatch_epoch — a completed gate
    // from the prior handoff would otherwise never be re-entered).
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'failed', mode = 'native', agent_run_id = NULL, external_session_ref = NULL, package_json = NULL, expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [recordId],
    );
    await stack.db.client.query(
      `UPDATE wfos_cross_mode_handoff_obligations
         SET discharged_at = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL,
             claim_owner = NULL,
             claim_epoch = 0,
             dispatch_state = NULL,
             dispatch_epoch = NULL
       WHERE handoff_id = (SELECT id FROM wfos_execution_mode_handoffs WHERE execution_record_id = $1)`,
      [recordId],
    );

    // Resolve the handoffId (the obligation's handoff_id column) for the
    // direct claim calls.
    const handoffIdRes = await stack.db.client.query<{ id: string }>(
      `SELECT id FROM wfos_execution_mode_handoffs WHERE execution_record_id = $1`,
      [recordId],
    );
    const handoffId = handoffIdRes.rows[0]!.id;

    // T1 (client1 repo) claims — succeeds (the obligation is unclaimed +
    // pending). PR #46 round 5: T1's owner is a UNIQUE per-invocation
    // identity (caller role prefix + UUID) + the claim mints the fencing
    // epoch. The 30s lease keeps T1's claim live.
    const t1Repo = crossModeHandoffRepo; // T1's repo (on stack.db.client)
    const t1Owner = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX);
    const t1Claim1 = await t1Repo.claimHandoffObligation(
      handoffId,
      t1Owner,
      30_000,
    );
    expect(t1Claim1.claimed, 'T1 (client1) acquired the claim (unclaimed + pending)').toBe(true);
    const t1Epoch = assertClaimed(t1Claim1);
    expect(t1Epoch, 'T1\'s claim minted a fencing epoch').toBeGreaterThan(0);

    // T2 (client2 repo) claims WHILE T1 holds a live claim — FAILS. The
    // conditional UPDATE's WHERE clause `discharged_at IS NULL AND
    // (claimed_at IS NULL OR claim_expires_at < NOW())` does NOT match (T1
    // holds a live, non-expired claim). PR #46 round 5: the `activeOwner`
    // diagnostics read is T1's EXACT unique owner string (the caller role
    // prefix + T1's invocation UUID).
    const t2Repo = new PgCrossModeHandoffRepository(second!.client);
    const t2Owner = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX);
    const t2Claim1 = await t2Repo.claimHandoffObligation(
      handoffId,
      t2Owner,
      30_000,
    );
    expect(t2Claim1.claimed, 'T2 (client2) could NOT claim while T1 holds a live claim (DB-level serialization)').toBe(false);
    if (!t2Claim1.claimed) {
      expect(t2Claim1.activeOwner, 'T2\'s diagnostics read T1\'s EXACT unique owner (the caller prefix + T1\'s invocation UUID)').toBe(t1Owner);
      expect(t2Claim1.activeOwner, 'the active owner is a unique per-invocation identity (round 5), NOT the bare role constant').toMatch(new RegExp(`^${CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX}:[0-9a-f-]{36}$`));
    }

    // T1 releases the claim (the `finally` block in production). PR #46
    // round 5: the release is guarded by the EXACT lease identity (owner +
    // epoch) — T1 captured both at claim time.
    const t1Release = await t1Repo.releaseHandoffObligationClaim(
      handoffId,
      t1Owner,
      t1Epoch,
    );
    expect(t1Release, 'T1 released the claim (the owner+epoch-guarded release succeeded)').toBe(true);

    // T2 retries — succeeds (the claim is now free + the reclaim predicate
    // matches). The conditional UPDATE serializes: T2's claim matches
    // because T1's release set claimed_at=NULL. PR #46 round 5: T2's claim
    // mints the NEXT fencing epoch (strictly greater than T1's — tokens
    // are never reused across leases).
    const t2Claim2 = await t2Repo.claimHandoffObligation(
      handoffId,
      t2Owner,
      30_000,
    );
    expect(t2Claim2.claimed, 'T2 reclaimed the claim after T1 released (the reclaim predicate matched)').toBe(true);
    const t2Epoch = assertClaimed(t2Claim2);
    expect(t2Epoch, 'T2\'s reclaim minted a strictly-greater fencing epoch (monotonic tokens)').toBe(t1Epoch + 1);

    // Cleanup: release T2's claim so the obligation is clean for the next
    // test (the schema is per-test, but this is defensive).
    await t2Repo.releaseHandoffObligationClaim(handoffId, t2Owner, t2Epoch);
  });

  // =========================================================================
  // Shared round-5 helper: drive ONE complete caller-path handoff, then reset
  // the record + the obligation to PENDING + UNCLAIMED + native (mirrors the
  // R4-#3 reset) so the direct claim/release/renew/discharge calls below
  // operate on a fresh, controllable obligation.
  // =========================================================================
  async function setupPendingUnclaimedObligation(
    idempotencyPrefix: string,
  ): Promise<{ executionId: string; recordId: string; handoffId: string }> {
    const { executionId, recordId } = await createNativeRecord('failed');
    const t1Service = buildT1Service();
    await t1Service.handoff(
      executionId,
      { targetMode: 'external', idempotencyKey: `${idempotencyPrefix}-${executionId}` },
      { userId: 'test-user', source: 'cmh-test' },
    );
    // Reset: the record back to native/failed + the obligation back to
    // pending + unclaimed + epoch 0 (the fresh fencing-token baseline) + the
    // dispatch gate cleared (PR #46 round 6 — a completed gate from the
    // prior handoff would otherwise never be re-entered).
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'failed', mode = 'native', agent_run_id = NULL, external_session_ref = NULL, package_json = NULL, expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [recordId],
    );
    await stack.db.client.query(
      `UPDATE wfos_cross_mode_handoff_obligations
         SET discharged_at = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL,
             claim_owner = NULL,
             claim_epoch = 0,
             dispatch_state = NULL,
             dispatch_epoch = NULL
       WHERE handoff_id = (SELECT id FROM wfos_execution_mode_handoffs WHERE execution_record_id = $1)`,
      [recordId],
    );
    const handoffIdRes = await stack.db.client.query<{ id: string }>(
      `SELECT id FROM wfos_execution_mode_handoffs WHERE execution_record_id = $1`,
      [recordId],
    );
    return { executionId, recordId, handoffId: handoffIdRes.rows[0]!.id };
  }

  // =========================================================================
  // R5-#1. The architect's EXACT round-5 five-step regression: T1 claims with
  // owner A → the lease expires → T2 (the SAME role) reclaims with owner B →
  // T1's LATE release CANNOT clear T2's claim → a THIRD actor cannot acquire
  // the still-live T2 claim. Plus: T1's stale renewal FAILS (the fence
  // check) while T2's live renewal succeeds.
  // =========================================================================
  it('R5-#1. unique lease owners — T1\'s late release CANNOT clear T2\'s same-role reclaimed claim; a third actor cannot acquire the live claim; the stale owner cannot renew', async () => {
    const { executionId, handoffId } = await setupPendingUnclaimedObligation('r5-owner');
    const t2Repo = new PgCrossModeHandoffRepository(second!.client);

    // STEP 1 — T1 claims with owner A (a UNIQUE per-invocation identity of
    // the CALLER role; a SHORT 150ms lease so the test can expire it).
    const ownerA = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX);
    const claimA = await crossModeHandoffRepo.claimHandoffObligation(handoffId, ownerA, 150);
    expect(claimA.claimed, 'step 1: T1 claimed with owner A (unique, caller role)').toBe(true);
    const epochA = assertClaimed(claimA);
    expect(epochA, 'step 1: T1\'s claim minted fencing epoch N').toBeGreaterThan(0);

    // STEP 2 — the lease expires.
    await delay(200);

    // STEP 3 — T2 (the SAME role — the caller role, NOT the relay role)
    // reclaims the expired lease with owner B. Under the round-4 shared
    // per-role owner string this reclaim would leave claim_owner UNCHANGED
    // (owner A === owner B) — the exact hole the round-5 review identified.
    const ownerB = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX);
    const claimB = await t2Repo.claimHandoffObligation(handoffId, ownerB, 30_000);
    expect(claimB.claimed, 'step 3: T2 (the SAME role) reclaimed the expired lease with owner B').toBe(true);
    const epochB = assertClaimed(claimB);
    expect(epochB, 'step 3: T2\'s reclaim minted the NEXT fencing epoch (N + 1)').toBe(epochA + 1);

    // STEP 4 — T1's LATE release (its `finally` finally ran after the stall)
    // CANNOT clear T2's claim: the release is guarded by the EXACT lease
    // identity (owner A + epoch N ≠ owner B + epoch N+1).
    const lateRelease = await crossModeHandoffRepo.releaseHandoffObligationClaim(
      handoffId,
      ownerA,
      epochA,
    );
    expect(lateRelease, 'step 4: T1\'s late release was a NO-OP (could not clear T2\'s claim)').toBe(false);
    const claimState = await stack.db.client.query<{ claim_owner: string | null; claim_epoch: string | number }>(
      `SELECT claim_owner, claim_epoch FROM wfos_cross_mode_handoff_obligations WHERE handoff_id = $1`,
      [handoffId],
    );
    expect(claimState.rows[0]!.claim_owner, 'step 4: T2\'s claim is INTACT (owner B still holds it)').toBe(ownerB);
    expect(Number(claimState.rows[0]!.claim_epoch), 'step 4: T2\'s fencing epoch is INTACT').toBe(epochB);

    // STEP 5 — a THIRD actor cannot acquire the still-live T2 claim.
    const ownerC = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX);
    const claimC = await crossModeHandoffRepo.claimHandoffObligation(handoffId, ownerC, 30_000);
    expect(claimC.claimed, 'step 5: the third actor could NOT acquire T2\'s live claim').toBe(false);
    if (!claimC.claimed) {
      expect(claimC.activeOwner, 'step 5: the diagnostics read T2\'s exact unique owner').toBe(ownerB);
    }

    // The STALE owner cannot renew (its phase-boundary fence check fails —
    // the conditional renewal matches 0 rows under owner A + epoch N) while
    // the LIVE owner's renewal succeeds.
    const staleRenew = await crossModeHandoffRepo.renewHandoffObligationClaim(
      handoffId,
      ownerA,
      epochA,
      30_000,
    );
    expect(staleRenew, 'the stale owner (T1/owner A/epoch N) cannot renew — the fence check fails').toBe(false);
    const liveRenew = await t2Repo.renewHandoffObligationClaim(
      handoffId,
      ownerB,
      epochB,
      30_000,
    );
    expect(liveRenew, 'the live owner (T2/owner B/epoch N+1) renews successfully').toBe(true);

    // Cleanup: release T2's claim (defensive — the schema is per-test).
    await t2Repo.releaseHandoffObligationClaim(handoffId, ownerB, epochB);
    expect(await countPendingObligations(executionId)).toBe(1);
  });

  // =========================================================================
  // R5-#2. The heartbeat renewal covers the ENTIRE critical section: T1's
  // critical section outlives the lease (parked mid-section after the first
  // fence check — the "slow provider dispatch") with the heartbeat ACTIVE →
  // T2's mid-flight reclaim FAILS (a live owner's lease never expires) → T1
  // completes → ZERO duplicate dispatches / session transitions. This is the
  // round-5 second blocker's fix: the lease no longer relies on being longer
  // than the critical section.
  // =========================================================================
  it('R5-#2. the heartbeat keeps a LIVE owner\'s lease alive across a critical section LONGER than the lease (T2\'s mid-flight reclaim fails)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const t2Service = buildT2Service();

    let firstRenewSeen = false;
    let t2MidFlight: { stage?: string } | undefined;
    const onFirstRenew = async () => {
      firstRenewSeen = true;
      // T1 is INSIDE the critical section (the first phase-boundary fence
      // check just renewed the lease) + the heartbeat timer is ALIVE. Park
      // for 3x the lease — WITHOUT the heartbeat this park would forfeit
      // the claim (the round-5 second blocker); WITH the heartbeat
      // (lease/3) the lease is renewed continuously.
      await delay(900);
      // T2 (the boot sweep / a live relay) tries to reclaim mid-flight —
      // MUST FAIL: the heartbeat renewed the lease (claim_expires_at is in
      // the future).
      t2MidFlight = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
      // Park again (the total critical section ≈ 3.4x the lease).
      await delay(900);
    };
    // A SHORT 600ms lease with the DEFAULT heartbeat (600/3 = 200ms): the
    // critical section (~1.8s+) legitimately outlives the lease.
    const t1Service = buildT1Service({ onFirstRenew, leaseMs: 600 });

    await t1Service.handoff(
      executionId,
      { targetMode: 'external', idempotencyKey: `r5-heartbeat-${executionId}` },
      { userId: 'test-user', source: 'cmh-test' },
    );

    // T1 reached the mid-critical-section fence check.
    expect(firstRenewSeen, 'T1 parked INSIDE the critical section (the first fence check ran)').toBe(true);
    // T2's mid-flight reclaim FAILED — the heartbeat kept the lease live.
    expect(t2MidFlight, 'T2\'s mid-flight reconcile returned a result').toBeDefined();
    expect(t2MidFlight!.stage, 'T2\'s mid-flight reclaim FAILED (claim-held — the heartbeat kept the lease live)').toBe('claim-held');

    // ZERO duplicate dispatches / session transitions: only T1's.
    expect(countingExternalProvider.submitCount, 'ZERO duplicate dispatches — only T1 dispatched (T2 was claim-held mid-flight)').toBe(1);
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions — only T1 interrupted').toBe(1);

    // T1 COMPLETED the handoff (the lease survived the whole critical
    // section): the record is external + packaged + the session interrupted.
    const after = await executionRecordRepo.findByExecutionId(executionId);
    expect(after!.id).toBe(recordId);
    expect(after!.mode).toBe('external');
    expect(after!.status).toBe('handoff_ready');
    expect(after!.packageValue).not.toBeNull();
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');

    // T2's retry (T1 completed + released) converges + discharges.
    const t2Retry = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Retry.stage, 'T2\'s retry converged + discharged after T1 released').toBe('complete');
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
  });

  // =========================================================================
  // R5-#3. The stalled-owner abort: T1's heartbeat is SUPPRESSED + its short
  // lease expires while it is parked mid-critical-section (the exact
  // round-5 second-blocker interleaving: T1 owns lease → critical section >
  // lease → T2 reclaims → T1 still executing) → T2 reclaims + completes +
  // discharges → T1 resumes → its next fence check FAILS (owner/epoch
  // mismatch) → T1 aborts with 'claim-fence-lost' BEFORE any mutation or
  // dispatch → ZERO duplicate dispatches / session transitions + T2's
  // completed state is INTACT despite T1's late release (a no-op).
  // =========================================================================
  it('R5-#3. a STALLED owner (heartbeat suppressed) loses the fence — T2 reclaims + completes; T1\'s resume ABORTS at the fence check (zero duplicate side effects)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    // T2 uses the DEFAULT lease/heartbeat — its reclaim + its whole critical
    // section run normally.
    const t2Service = buildT2Service();

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat (a 60s interval — no
    // renewal fires during the test: the "stalled owner" whose heartbeat
    // died). T1 parks at the willMutate hook (AFTER its reserve+claim,
    // BEFORE its mutate) on a gate the test controls.
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });
    let t1AtGate = false;
    const willMutate = async () => {
      t1AtGate = true;
      await gate;
    };
    const t1Service = buildT1Service({ willMutate, leaseMs: 150, heartbeatMs: 60_000 });

    // T1 starts its handoff asynchronously + parks at the gate.
    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r5-stall-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is parked at the gate (after its reserve+claim), then
    // let the 150ms lease expire while T1 is stalled (no heartbeat renews).
    await waitFor(() => t1AtGate, 5000);
    await delay(250);

    // T2 (the boot sweep) reclaims the expired lease + drives the handoff
    // to completion (re-mutate + re-dispatch + session + discharge).
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed the expired lease + completed the handoff').toBe('complete');

    // T1 resumes: its first phase-boundary fence check (before the record
    // mutate) FAILS — the renewal's owner+epoch predicate matches 0 rows
    // (T2 reclaimed under a new unique owner + epoch). T1 aborts with
    // 'claim-fence-lost' BEFORE any mutation or dispatch.
    resolveGate();
    await t1Promise;
    expect(t1Error, 'T1\'s resumed handoff FAILED with the fence-lost error').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'T1 aborted with claim-fence-lost (the stale-owner fence)').toBe('claim-fence-lost');

    // THE ARCHITECT'S INVARIANT: ZERO duplicate dispatches + ZERO duplicate
    // session transitions under the stall-then-reclaim interleaving — only
    // T2 dispatched + interrupted (T1 aborted at the fence BEFORE its
    // mutate).
    expect(countingExternalProvider.submitCount, 'ZERO duplicate dispatches — only T2 dispatched (T1 aborted at the fence check)').toBe(1);
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions — only T2 interrupted (T1 aborted at the fence check)').toBe(1);

    // T2's completed state is INTACT despite T1's late critical-section
    // attempt + its `finally` release (the owner+epoch-guarded release was
    // a NO-OP — it could not disturb the discharged obligation).
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
    const after = await executionRecordRepo.findByExecutionId(executionId);
    expect(after!.id).toBe(recordId);
    expect(after!.mode).toBe('external');
    expect(after!.status).toBe('handoff_ready');
    expect(after!.packageValue).not.toBeNull();
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');
  });

  // =========================================================================
  // R5-#4. The discharge is epoch-fenced at the DB: after T2 reclaims (a new
  // epoch), T1's stale-epoch discharge is REJECTED (0 rows — the obligation
  // stays pending; the stale actor cannot complete the authoritative
  // obligation transition) while T2's live-epoch discharge succeeds.
  // =========================================================================
  it('R5-#4. the discharge is epoch-fenced — the STALE owner\'s discharge is rejected (the obligation stays pending); the LIVE owner\'s discharge succeeds', async () => {
    const { executionId, handoffId } = await setupPendingUnclaimedObligation('r5-discharge');
    const t2Repo = new PgCrossModeHandoffRepository(second!.client);

    // T1 claims (a SHORT 150ms lease) — fencing epoch N.
    const ownerA = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX);
    const claimA = await crossModeHandoffRepo.claimHandoffObligation(handoffId, ownerA, 150);
    expect(claimA.claimed, 'T1 claimed (epoch N)').toBe(true);
    const epochA = assertClaimed(claimA);

    // The lease expires; T2 reclaims — fencing epoch N+1.
    await delay(200);
    const ownerB = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX);
    const claimB = await t2Repo.claimHandoffObligation(handoffId, ownerB, 30_000);
    expect(claimB.claimed, 'T2 reclaimed the expired lease (epoch N+1)').toBe(true);
    const epochB = assertClaimed(claimB);
    expect(epochB).toBe(epochA + 1);

    // T1 (the STALE owner) attempts the epoch-fenced discharge — REJECTED
    // (0 rows: the WHERE clause requires T1's exact owner+epoch, which the
    // reclaim replaced). Even if T1's phase-boundary fence check raced, the
    // DB-level fence still rejects the authoritative transition.
    const staleDischarge = await crossModeHandoffRepo.dischargeHandoffObligation(
      handoffId,
      ownerA,
      epochA,
    );
    expect(staleDischarge, 'the STALE owner\'s discharge was REJECTED (epoch-fenced)').toBe(false);
    // The obligation is STILL pending — the stale actor did NOT complete it.
    expect(await countPendingObligations(executionId), 'the obligation is STILL pending (the stale actor could not discharge)').toBe(1);
    expect(await countDischargedObligations(executionId)).toBe(0);

    // T2 (the LIVE lease holder) discharges — succeeds.
    const liveDischarge = await t2Repo.dischargeHandoffObligation(
      handoffId,
      ownerB,
      epochB,
    );
    expect(liveDischarge, 'the LIVE owner\'s discharge succeeded (the exact owner+epoch matched)').toBe(true);
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
  });

  // =========================================================================
  // Shared round-6 helpers: an external record (for the external→native
  // direction) + a dispatch-gate state reader.
  // =========================================================================

  /** Create an external execution record in the handoff_ready state (with a
   *  representative ExternalExecutionPackage persisted — the prior phase's
   *  authoritative evidence; mirrors the pglite regression test's helper). */
  async function createExternalRecord(): Promise<{ executionId: string; recordId: string }> {
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'external', provider: 'external', model: null,
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
      branch: 'feat/work-w042-r4-001',
    });
    const pkg = {
      executionId, mode: 'external' as const, projectId, workItemId,
      workItemLabel: 'WORK-W042-R4-001', workOrderId,
      implementationContextId: sharedContextId, provider: 'external', model: null,
      repository: { owner: null, name: null, url: null, defaultBranch: null },
      branch: 'feat/work-w042-r4-001', prompt: `p ${executionId}`,
      structuredInstructions: [], verificationRequirements: [],
      expectedOutputs: [], browserTestRequirements: [],
      returnCallback: {
        eventsPath: `/execution/${executionId}/events`,
        eventTypes: ['started', 'progress', 'completed', 'failed'],
        auth: 'x-callback-token', note: 'test package',
      },
      expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    await executionRecordRepo.updateStatus(record.id, { status: 'handoff_ready', packageValue: pkg });
    return { executionId, recordId: record.id };
  }

  /** Read the obligation's dispatch-gate state (PR #46 round 6) + the durable
   *  dispatch idempotency key (PR #46 round 7 — migration 0047). */
  async function readDispatchGate(
    executionId: string,
  ): Promise<{ dispatchState: string | null; dispatchEpoch: number | null; dispatchKey: string | null }> {
    const res = await stack.db.client.query<{ dispatch_state: string | null; dispatch_epoch: string | number | null; dispatch_idempotency_key: string | null }>(
      `SELECT o.dispatch_state, o.dispatch_epoch, o.dispatch_idempotency_key
       FROM wfos_cross_mode_handoff_obligations o
       JOIN wfos_execution_mode_handoffs h ON h.id = o.handoff_id
       JOIN wfos_executions e ON e.id = o.execution_id
       WHERE e.execution_id = $1`,
      [executionId],
    );
    const row = res.rows[0];
    return {
      dispatchState: row?.dispatch_state ?? null,
      dispatchEpoch: row ? (row.dispatch_epoch == null ? null : Number(row.dispatch_epoch)) : null,
      dispatchKey: row?.dispatch_idempotency_key ?? null,
    };
  }

  // =========================================================================
  // R6-#1. The architect's round-6 interleaving, variant A (stall
  // IMMEDIATELY BEFORE the dispatch): T1 claims (epoch N) → T1 passes the
  // pre-call ensureFence('dispatch') → T1 stalls (heartbeat dead) between the
  // fence check and the provider call → the lease expires → T2 reclaims
  // (epoch N+1) → T2 completes the dispatch (ONE authoritative provider
  // operation) → T1 resumes → T1 MUST NOT create a second authoritative
  // provider operation. The FENCED DISPATCH GATE (beginFencedDispatch — the
  // lease fence evaluated ATOMICALLY with the durable dispatch intent) fences
  // T1's resume out BEFORE its provider submit: ZERO provider calls from T1.
  // =========================================================================
  it('R6-#1. a stalled owner that PASSED the pre-call fence is fenced out AT the dispatch boundary — T1\'s resumed dispatch NEVER reaches the provider (zero provider calls from T1)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };
    const t2Service = buildT2Service({ stats });

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat. T1 parks at the
    // willEnterDispatchGate hook — AFTER the pre-call ensureFence('dispatch')
    // PASSED (the residual round-6 window: the check was a false positive)
    // but BEFORE the atomic gate crossing (the durable dispatch intent is
    // NOT crossed — the gate is still NULL).
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });
    let t1AtGate = false;
    const willEnterDispatchGate = async () => {
      t1AtGate = true;
      await gate;
    };
    const t1Service = buildT1Service({
      willEnterDispatchGate,
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r6-pre-dispatch-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is parked between the pre-call fence check and the gate
    // (the mutate + session transition have already happened), then let the
    // 150ms lease expire while T1 is stalled (no heartbeat renews).
    await waitFor(() => t1AtGate, 5000);
    await delay(300);

    // T2 (the boot sweep) reclaims the expired lease (epoch N+1) + drives the
    // handoff to completion: crash-window #2 (record.mode === external but
    // packageValue missing) → T2's re-dispatch crosses the gate (still NULL —
    // T1 never crossed) → T2's submit → T2's atomic completeFencedDispatch
    // (the ONE authoritative outcome write) → discharge.
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed the expired lease + completed the handoff (the authoritative dispatch)').toBe('complete');

    // T1 resumes: the ATOMIC gate crossing (beginFencedDispatch) evaluates
    // the lease fence — T2 owns the obligation now → 0 rows → T1 aborts
    // 'claim-fence-lost' BEFORE its provider submit.
    resolveGate();
    await t1Promise;
    expect(t1Error, 'T1\'s resumed handoff FAILED with the fence-lost error (the ATOMIC dispatch boundary)').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'T1 aborted at the dispatch gate (claim-fence-lost) — BEFORE the provider submit').toBe('claim-fence-lost');

    // THE ARCHITECT'S ROUND-6 INVARIANT: T1 performed NO provider operation —
    // exactly ONE submit total (T2's). The pre-call fence check passing was
    // NOT sufficient protection on its own (round-5's hole); the atomic gate
    // crossing is what stops T1.
    expect(countingExternalProvider.submitCount, 'ZERO provider calls from T1 — the gated boundary aborted it BEFORE the submit (exactly one submit: T2\'s)').toBe(1);
    expect(stats.completeTrueCount, 'exactly ONE authoritative outcome write (T2\'s — committed through the fenced completion)').toBe(1);
    expect(stats.beginCount, 'exactly ONE gate crossing (T2\'s — T1\'s begin affected 0 rows)').toBe(1);

    // Exactly ONE session transition (T1's pre-dispatch interrupt — T2's
    // reconcile found it converged + skipped).
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions').toBe(1);

    // The obligation discharged + the gate COMPLETED at T2's epoch.
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
    const gateAfter = await readDispatchGate(executionId);
    expect(gateAfter.dispatchState, 'the dispatch gate is COMPLETED (the outcome write landed atomically with it)').toBe('completed');
    expect(gateAfter.dispatchEpoch, 'the gate completed at T2\'s (the reclaiming owner\'s) epoch').toBeGreaterThan(0);

    // The final state: the record IS external/handoff_ready + T2's package
    // (T1's late attempt wrote NOTHING).
    const after = await executionRecordRepo.findByExecutionId(executionId);
    expect(after!.id).toBe(recordId);
    expect(after!.mode).toBe('external');
    expect(after!.status).toBe('handoff_ready');
    expect(after!.packageValue).not.toBeNull();
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');
  });

  // =========================================================================
  // R6-#2 (REWRITTEN by round 7 — the provider-operation exactly-once
  // boundary). The architect's round-7 review rejected the original R6-#2
  // framing ("both actors submit — the CALL is not the authoritative
  // operation"): the DB outcome being singular does NOT make the PROVIDER
  // OPERATION exactly-once. The stall-DURING-the-dispatch interleaving now
  // runs under the round-7 keyed-provider contract:
  //
  //   T1 claims (epoch N) → T1 crosses the dispatch gate → T1's submit
  //   STARTS the provider operation (keyed cross-mode-dispatch-<handoffId>)
  //   + stalls INSIDE it (heartbeat dead) → the lease expires → T2 reclaims
  //   (epoch N+1) → T2 takes over the in-flight gate + re-dispatches → T2's
  //   same-key submit CONVERGES onto T1's IN-FLIGHT provider operation (NO
  //   second operation — the registry returns the REGISTERED operation,
  //   awaited while in flight) → the provider resolves the operation (the
  //   original submitter's liveness is IRRELEVANT — the operation lives at
  //   the provider) → BOTH actors observe the SAME submission → T2's
  //   completeFencedDispatch commits the ONE authoritative outcome → T1's
  //   completeFencedDispatch affects 0 rows (DISCARDED — fence loss).
  //
  // THE ROUND-7 INVARIANT (proven at the PROVIDER level, not merely the DB
  // level): submitCount === 2 (both actors' attempts) but
  // operationsCreated === 1 (ONE provider operation), BOTH attempts under
  // the SAME idempotency key (submitKeys[0] === submitKeys[1]), and the
  // durable dispatch_idempotency_key recorded on the obligation row EQUALS
  // that provider operation key.
  // =========================================================================
  it('R6-#2 (round 7). a stalled owner\'s ALREADY-STARTED provider operation is CONVERGED onto — not duplicated: both actors\' submits converge on the SAME idempotency key + ONE provider operation (T2 completes the ONE authoritative outcome; T1\'s resumed completion is DISCARDED)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };
    const t2Service = buildT2Service({ stats });

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat. T1's provider submit
    // STARTS the keyed provider operation + PARKS IT AT THE PROVIDER (the
    // operation is in flight; T1 awaits it; the outcome write has NOT run).
    let resolveSubmit!: () => void;
    const submitGate = new Promise<void>((r) => { resolveSubmit = r; });
    countingExternalProvider.parkFirstSubmit(submitGate);
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r6-mid-dispatch-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is stalled INSIDE its in-flight provider operation
    // (submitCount === 1, ONE operation created), then let the 150ms lease
    // expire while T1 is stalled (no heartbeat renews).
    await waitFor(() => countingExternalProvider.submitCount >= 1, 5000);
    await delay(300);
    expect(countingExternalProvider.operationsCreated, 'T1 started exactly ONE provider operation').toBe(1);

    // T2 (the boot sweep) reclaims the expired lease (epoch N+1) → crash
    // window #2 (record.mode === external, packageValue missing — T1's
    // outcome write never ran) → T2's re-dispatch TAKES OVER the in-flight
    // gate (dispatch_epoch N < N+1 — the monotonic take-over arm) → T2's
    // SAME-KEY submit CONVERGES onto T1's IN-FLIGHT provider operation (the
    // registry returns the REGISTERED operation — NO second operation is
    // created; T2 awaits the same provider-side resolution). T2's reconcile
    // therefore runs as a background promise — it parks inside the same
    // operation until the provider resolves it.
    let t2Result: { stage?: string } | undefined;
    const t2Promise = (async () => {
      t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    })();
    await waitFor(() => countingExternalProvider.submitCount >= 2, 5000);

    // THE ROUND-7 INVARIANT, asserted MID-FLIGHT (T1's operation still
    // unresolved, both actors inside the dispatch): BOTH actors submitted
    // (2 attempts) — but exactly ONE provider operation exists, and BOTH
    // attempts carried the SAME durable idempotency key (the handoff-derived
    // key — the architect's "both attempts converge on the SAME provider
    // operation idempotency key").
    expect(countingExternalProvider.submitCount, 'both actors\' submit ATTEMPTS ran (the reclaiming owner re-dispatched mid-flight)').toBe(2);
    expect(countingExternalProvider.operationsCreated, 'exactly ONE provider operation — T2\'s same-key submit CONVERGED onto T1\'s in-flight operation (NO second operation started)').toBe(1);
    const submitKeys = countingExternalProvider.submitKeys();
    expect(submitKeys.length, 'two submit attempts recorded').toBe(2);
    expect(submitKeys[0], 'both attempts used the SAME durable idempotency key (the handoff identity — stable across owners/epochs/reclaims)').toBe(submitKeys[1]);
    expect(submitKeys[0], 'the key is the handoff-derived dispatch key').toMatch(/^cross-mode-dispatch-/);

    // The PROVIDER resolves the operation (the original submitter's liveness
    // is irrelevant — the operation lives at the provider, exactly like a
    // Stripe-style idempotency key whose request outlives the client
    // connection). Both actors' submits return the SAME submission.
    resolveSubmit();
    await t2Promise;
    expect(t2Result!.stage, 'T2 reclaimed the expired lease, took over the in-flight gate, converged onto the ONE provider operation, + completed the handoff').toBe('complete');

    // Capture T2's authoritative outcome (the record state after T2's
    // completion) — T1's resumed dispatch must NOT disturb it.
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(afterT2!.packageValue).not.toBeNull();
    expect(afterT2!.expiresAt).not.toBeNull();

    // T1 resumes: its already-started submit returns the SAME (converged)
    // operation's submission, then T1's completeFencedDispatch evaluates the
    // fence — the lease is T2's (and the obligation is discharged) → 0 rows
    // → the transaction ROLLS BACK — NO outcome write. T1 aborts
    // 'claim-fence-lost'.
    await t1Promise;
    expect(t1Error, 'T1\'s resumed handoff FAILED with the fence-lost error (the discarded already-started dispatch)').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'T1\'s already-started dispatch was fenced out at the atomic completion').toBe('claim-fence-lost');

    // THE ROUND-7 INVARIANT, final: exactly ONE provider operation
    // (operationsCreated === 1 — never a second), ONE authoritative outcome
    // write (completeTrueCount === 1 — T2's), T1's completion DISCARDED
    // (completeFalseCount === 1 — 0 rows, rollback), and the DURABLE key
    // recorded on the obligation row (migration 0047 — atomic with the
    // gate-open) EQUALS the provider operation's key.
    expect(countingExternalProvider.operationsCreated, 'exactly ONE provider operation for the whole interleaving (the round-7 exactly-once side-effect boundary)').toBe(1);
    expect(countingExternalProvider.operationKeys().length, 'one operation identity').toBe(1);
    expect(countingExternalProvider.operationKeys()[0], 'the operation key is the handoff-derived dispatch key').toBe(submitKeys[0]);
    expect(stats.completeTrueCount, 'exactly ONE authoritative outcome write committed (T2\'s — the fenced completion)').toBe(1);
    expect(stats.completeFalseCount, 'T1\'s already-started dispatch outcome was DISCARDED (0 rows — no second authoritative outcome write)').toBe(1);
    expect(stats.beginCount, 'the gate was crossed by BOTH actors (T1 opened it; T2 took it over — the monotonic take-over arm)').toBe(2);
    const gateAfter = await readDispatchGate(executionId);
    expect(gateAfter.dispatchKey, 'the DURABLE dispatch idempotency key recorded atomically with the gate-open EQUALS the provider operation key (the same logical operation identity)').toBe(submitKeys[0]);

    // T2's authoritative outcome is INTACT — T1's late completion wrote
    // NOTHING (the package + expiresAt are byte-identical to T2's — both
    // actors observed the SAME converged operation).
    const afterT1 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT1!.packageValue, 'T2\'s package is INTACT (the converged operation\'s package — T1\'s completion never wrote)').toEqual(afterT2!.packageValue);
    expect(afterT1!.expiresAt?.getTime(), 'T2\'s expires_at is INTACT').toBe(afterT2!.expiresAt?.getTime());
    expect(afterT1!.status).toBe('handoff_ready');

    // Exactly ONE session transition (T1's pre-dispatch interrupt — T2's
    // reconcile found it converged + skipped).
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions').toBe(1);

    // The obligation discharged + the gate COMPLETED (at T2's epoch).
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
    expect(gateAfter.dispatchState, 'the dispatch gate is COMPLETED').toBe('completed');
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');
  });

  // =========================================================================
  // R6-#3 (updated by round 7 — the provider-level keyed convergence). The
  // architect's round-6 interleaving on the NATIVE path: T1 claims (epoch N)
  // → T1 passes the pre-call fence + CROSSES the dispatch gate → T1 stalls
  // between the gate + the gateway submit (heartbeat dead) → the lease
  // expires → T2 reclaims (epoch N+1) → T2 takes over the in-flight gate +
  // submits through the AgentGateway (creating the ONE AgentRun — its
  // adapter invocation is the ONE native provider operation) + completes the
  // dispatch + discharges → T1 resumes → T1's KEYED submit hits the
  // round-7 provider pre-check (the run EXISTS — the durable operation
  // identity) → the provider CONVERGES T1 to the existing run (NO gateway
  // call, NO second adapter invocation — the round-6 UNIQUE-collision +
  // service-level conflict recovery is now the backstop, not the mechanism)
  // → T1's completion is FENCED OUT (0 rows — NO outcome write, neither
  // success NOR a stale 'failed' clobber) → T1 aborts 'claim-fence-lost'.
  // Exactly ONE AgentRun + ONE adapter invocation + ONE authoritative
  // outcome write.
  // =========================================================================
  it('R6-#3 (round 7). a stalled NATIVE dispatch converges at the provider boundary + is fenced out — exactly ONE AgentRun, ONE adapter invocation, ONE authoritative outcome (T1\'s resumed KEYED submit converges onto T2\'s run + its completion writes NOTHING)', async () => {
    const { executionId, recordId } = await createExternalRecord();
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };
    const t2Service = buildT2Service({ stats });

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat. T1 parks at the
    // onDispatchGateEntered hook — AFTER the gate crossing (the durable
    // dispatch intent is open at T1's epoch) but BEFORE the gateway submit
    // (NO AgentRun exists yet).
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });
    let t1AtGate = false;
    const onDispatchGateEntered = async () => {
      t1AtGate = true;
      await gate;
    };
    const t1Service = buildT1Service({
      onDispatchGateEntered,
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'native', idempotencyKey: `r6-native-stall-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is parked after the gate crossing (the record is already
    // mutated to native/running; NO AgentRun exists), then let the 150ms
    // lease expire while T1 is stalled (no heartbeat renews).
    await waitFor(() => t1AtGate, 5000);
    await delay(300);
    // Sanity: no AgentRun exists yet (T1 stalled before its gateway submit).
    const midRun = await agentRunRepo.findByExecutionId(executionId);
    expect(midRun, 'no AgentRun exists while T1 is stalled before its gateway submit').toBeNull();

    // T2 (the boot sweep) reclaims the expired lease (epoch N+1) → crash
    // window #2 (record.mode === native, NO AgentRun, NOT terminal) → T2's
    // re-dispatch TAKES OVER the in-flight gate → T2's gateway submit CREATES
    // the AgentRun → T2's atomic completeFencedDispatch (the ONE
    // authoritative outcome write) → discharge.
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed the expired lease, took over the in-flight gate, dispatched natively, + completed').toBe('complete');
    const t2Run = await agentRunRepo.findByExecutionId(executionId);
    expect(t2Run, 'T2\'s dispatch created the ONE AgentRun').not.toBeNull();

    // Capture T2's authoritative outcome — T1's resumed dispatch must NOT
    // disturb it.
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('native');
    expect(afterT2!.status).toBe('completed');
    expect(afterT2!.agentRunId).toBe(t2Run!.id);

    // T1 resumes: its KEYED submit hits the round-7 NativeExecutionProvider
    // pre-check — the run EXISTS (T2's, the durable operation identity —
    // wfos_agent_runs.execution_id) → the provider CONVERGES T1 to that run
    // (NO gateway call, NO second adapter invocation) → T1's
    // completeFencedDispatch evaluates the fence → 0 rows (the lease is
    // T2's + the obligation is discharged) → NO outcome write (neither a
    // duplicate success NOR the legacy 'failed' clobber) → T1 aborts
    // 'claim-fence-lost'.
    resolveGate();
    await t1Promise;
    expect(t1Error, 'T1\'s resumed handoff FAILED with the fence-lost error (the converged native dispatch)').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'T1\'s converged native dispatch was fenced out (its completion wrote NOTHING)').toBe('claim-fence-lost');

    // THE ROUND-7 INVARIANT on the native path: exactly ONE AgentRun +
    // exactly ONE adapter invocation (the ONE native provider operation —
    // T2\'s gateway created the run + invoked the adapter; T1\'s resumed
    // submit converged at the provider pre-check and NEVER reached the
    // gateway) + exactly ONE authoritative outcome write (T2\'s; T1\'s
    // converge completion affected 0 rows + was discarded).
    const runCountRes = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_agent_runs WHERE execution_id = $1`,
      [executionId],
    );
    expect(Number(runCountRes.rows[0]?.c ?? 0), 'exactly ONE AgentRun (no second native provider operation)').toBe(1);
    expect(fakeAgent.getCallCount(), 'exactly ONE adapter invocation — the ONE native provider operation (T1\'s resumed KEYED submit converged at the provider pre-check: it NEVER invoked the adapter)').toBe(1);
    expect(stats.completeTrueCount, 'exactly ONE authoritative outcome write committed (T2\'s)').toBe(1);
    expect(stats.completeFalseCount, 'T1\'s converged completion was DISCARDED (0 rows)').toBe(1);
    expect(stats.beginCount, 'the gate was crossed by BOTH actors (T1 opened it; T2 took it over)').toBe(2);
    const gateAfter = await readDispatchGate(executionId);
    expect(gateAfter.dispatchState, 'the dispatch gate is COMPLETED').toBe('completed');
    expect(gateAfter.dispatchKey, 'the DURABLE dispatch idempotency key is recorded on the obligation row (migration 0047 — atomic with the gate-open)').toMatch(/^cross-mode-dispatch-/);
  });

  // =========================================================================
  // R7-#1 (round 7 — the architect's EXACT required regression, the native
  // direction / the "prevented from starting a second operation" arm):
  // T1 claims (epoch N) → T1 crosses the dispatch gate → T1's keyed submit
  // creates the ONE AgentRun + STALLS INSIDE THE ADAPTER (the native
  // provider operation itself — in flight at the gateway; heartbeat dead) →
  // the lease expires → T2 reclaims (epoch N+1) → T2's reconcile finds the
  // run ALREADY EXISTS (the durable operation identity) → T2 converges on
  // it WITHOUT PERFORMING ANY PROVIDER OPERATION (no gateway call, no
  // adapter invocation — the architect's "T2 is prevented from starting a
  // second operation") → the obligation discharges (the run IS the
  // authoritative native outcome — handoffComplete's existing-run rule) →
  // T1's adapter eventually completes (the ONE operation resolves) → T1's
  // completion is FENCED OUT (0 rows — NO outcome write). Exactly ONE
  // AgentRun + ONE adapter invocation + ZERO provider operations from T2.
  // =========================================================================
  it('R7-#1. the NATIVE provider operation is EXACTLY-ONCE under the stall-inside-the-operation interleaving — T2\'s reclaim performs ZERO provider operations (ONE AgentRun, ONE adapter invocation, ONE fenced authoritative state)', async () => {
    const { executionId, recordId } = await createExternalRecord();
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };
    const t2Service = buildT2Service({ stats });

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat, dispatching through
    // a NATIVE provider whose gateway is wired to a ParkableAgentAdapter —
    // the FIRST adapter invocation (the provider operation itself) parks on
    // the gate AFTER the gateway created the AgentRun (the run exists, in
    // flight; the outcome write has NOT run).
    let resolveAdapter!: () => void;
    const adapterGate = new Promise<void>((r) => { resolveAdapter = r; });
    const parkableAdapter = new ParkableAgentAdapter(fakeAgent, adapterGate);
    const parkableGateway = new DefaultAgentGateway(stack.db.client, stack.db.logger, [parkableAdapter], 3);
    const t1NativeProvider = new NativeExecutionProvider({
      agentGateway: parkableGateway,
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
    });
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      nativeProvider: t1NativeProvider,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'native', idempotencyKey: `r7-native-adapter-stall-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is stalled INSIDE the adapter (the ONE provider
    // operation is in flight: the AgentRun exists + the adapter is parked),
    // then let the 150ms lease expire while T1 is stalled (no heartbeat
    // renews).
    await waitFor(() => parkableAdapter.inFlight, 5000);
    const midRun = await agentRunRepo.findByExecutionId(executionId);
    expect(midRun, 'the ONE AgentRun exists while T1 is stalled INSIDE the adapter (the provider operation is in flight at the gateway)').not.toBeNull();
    await delay(300);

    // T2 (the boot sweep) reclaims the expired lease (epoch N+1) → crash
    // window #2 (record.mode === native, the AgentRun EXISTS) → the
    // reconcile's existing-run check finds the run + CONVERGES WITHOUT ANY
    // PROVIDER OPERATION (no gateway call, no adapter invocation — T2 is
    // PREVENTED from starting a second operation) → the obligation
    // discharges (the run IS the authoritative native outcome — the
    // handoffComplete existing-run rule) → session convergence.
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed the expired lease + converged on the EXISTING run (ZERO provider operations from T2) + discharged').toBe('complete');

    // THE ROUND-7 INVARIANT (the native arm): T2 performed ZERO provider
    // operations — the adapter was invoked EXACTLY ONCE (T1's invocation, in
    // flight at the park point) + exactly ONE AgentRun exists. T2 never
    // reached the gateway.
    expect(parkableAdapter.executeCount, 'exactly ONE adapter invocation — the ONE native provider operation (T2\'s reclaim performed ZERO provider operations: it converged on the existing run)').toBe(1);
    expect(fakeAgent.getCallCount(), 'the ONE provider operation is still IN FLIGHT (not yet resolved — the delegated adapter call has not returned)').toBe(0);
    const runCountRes = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_agent_runs WHERE execution_id = $1`,
      [executionId],
    );
    expect(Number(runCountRes.rows[0]?.c ?? 0), 'exactly ONE AgentRun (no second native provider operation was ever started)').toBe(1);
    // T2's dispatch performed no gate crossing (it converged at the
    // reconcile's existing-run check — BEFORE the dispatch boundary) + no
    // completion: the gate remains in_flight at T1's epoch (inert once the
    // obligation is discharged — no further write can pass the CAS).
    expect(stats.beginCount, 'only T1 crossed the dispatch gate (T2 converged at the reconcile level — ZERO provider operations)').toBe(1);
    expect(stats.completeTrueCount, 'no authoritative outcome write from T2 (the run IS the outcome — handoffComplete\'s existing-run rule); T1\'s late completion is fenced out below').toBe(0);

    // The obligation DISCHARGED under T2's reclaim (the run exists + the
    // session converged — the handoff is complete).
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);

    // T1's adapter eventually completes (the ONE provider operation
    // resolves — the run reaches its terminal state) → T1's provider submit
    // returns → T1's completeFencedDispatch evaluates the fence — the lease
    // is reclaimed + the obligation is discharged → 0 rows → ROLLBACK — NO
    // outcome write (neither a duplicate success NOR a 'failed' clobber over
    // the discharged state) → T1 aborts 'claim-fence-lost'.
    resolveAdapter();
    await t1Promise;
    expect(t1Error, 'T1\'s resumed handoff FAILED with the fence-lost error (the resolved provider operation\'s completion was discarded)').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'T1\'s late completion was fenced out (NO second authoritative write)').toBe('claim-fence-lost');
    expect(stats.completeFalseCount, 'T1\'s completion affected 0 rows + was DISCARDED').toBe(1);
    expect(parkableAdapter.executeCount, 'still exactly ONE adapter invocation after T1 resumes (the operation RESOLVED — it was not re-issued)').toBe(1);
    expect(fakeAgent.getCallCount(), 'the ONE provider operation resolved exactly once (the delegated adapter call returned once)').toBe(1);

    // The final state: ONE run (now terminal), the record NOT clobbered by
    // T1's late completion (T1's write rolled back — the record keeps the
    // mutated native/running state + the discharged obligation; the run
    // lifecycle owns the execution from here).
    const finalRun = await agentRunRepo.findByExecutionId(executionId);
    expect(finalRun!.status, 'the ONE run completed (the ONE provider operation resolved)').toBe('success');
    const afterT1 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT1!.id).toBe(recordId);
    expect(afterT1!.mode).toBe('native');
    expect(afterT1!.status, 'T1\'s late completion wrote NOTHING (no clobber — the fence discarded it)').toBe('running');
    const gateAfter = await readDispatchGate(executionId);
    expect(gateAfter.dispatchKey, 'the DURABLE dispatch idempotency key is recorded on the obligation row (migration 0047)').toMatch(/^cross-mode-dispatch-/);
  });
});
