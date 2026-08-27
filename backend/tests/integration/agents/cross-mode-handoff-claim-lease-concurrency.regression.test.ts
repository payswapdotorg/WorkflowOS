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
 * PR #46 round 8 (the DURABLE idempotency boundary — the round-8 review's
 * blocking correction): the round-7 registry was an in-MEMORY Map inside the
 * ExternalExecutionProvider — convergence existed only for the lifetime of
 * that particular provider instance, and the round-7 harness SHARED the
 * provider instance between T1 and T2, so it proved only the Map's
 * convergence — never the architect's actual requirement:
 *
 *     provider instance A
 *         ↓
 *     operation K starts
 *         ↓
 *     instance A disappears
 *         ↓
 *     provider instance B
 *         ↓
 *     submit K
 *         ↓
 *     SAME operation
 *
 * The round-8 correction replaces the Map with the DURABLE PROVIDER-OPERATION
 * LEDGER (wfos_execution_provider_operations, migration 0048 — the
 * architect's acceptable architecture: stable dispatch key → durable
 * provider-operation ledger → PENDING / COMPLETED / FAILED + provider
 * operation/result → same key always resolves to the same operation), and
 * this suite is REBUILT for provider-instance separation: T1's and T2's
 * external providers are now DISTINCT InstrumentedExternalProvider instances
 * on DISTINCT pg clients (no shared instance, no shared registry — exactly
 * the round-8 harness requirement), and T2's native provider is a distinct
 * NativeExecutionProvider on the second client:
 *
 *   R6-#2 (rewritten AGAIN by round 8). The stall-DURING-the-dispatch
 *      interleaving with SEPARATE provider instances: T1's submit OPENED the
 *      ONE durable ledger row (PENDING — the operation is in flight at T1)
 *      and stalls INSIDE the operation body → the lease expires → T2 (a
 *      FRESH provider instance on the SECOND client) reclaims + re-dispatches
 *      → T2's same-key submit CONVERGES through the DURABLE LEDGER onto the
 *      in-flight row (it awaits the row's resolution — it does NOT start a
 *      second drive) → the provider resolves the operation (T1's drive
 *      completes + its resolution CAS stores the ONE result) → T2's await
 *      REPLAYS the stored result → T2 commits the ONE authoritative outcome →
 *      T1's late completion is DISCARDED (fence loss). ONE ledger row, ONE
 *      drive, ONE result, ONE outcome write.
 *
 *   R8-#1 (new — the architect's EXACT round-8 scenario, the external arm):
 *      provider-instance + PROCESS LOSS. T1's submit OPENED the ONE durable
 *      ledger row (PENDING) and its process DIES inside the operation body
 *      (the drive never returns) → the lease expires → T2 (a FRESH provider
 *      instance on the SECOND client) reclaims + re-dispatches → T2's
 *      same-key submit finds the PENDING row, its resolution window elapses
 *      (the dead driver will never resolve it), and it TAKES OVER the drive
 *      of the SAME row (the recovery drive — generation 2) → the resolution
 *      CAS stores the ONE result → T2 commits the ONE authoritative outcome →
 *      a THIRD fresh instance's same-key submit REPLAYS the stored result
 *      (ZERO further drives) → the DEAD driver's late completion (released at
 *      the end) hits the resolution CAS → 0 rows → it REPLAYS the winner's
 *      stored result → its completeFencedDispatch is fenced out. ONE durable
 *      provider operation (ONE ledger row) for the whole interleaving.
 *
 *   R8-#2 (new — the native arm: the EXPLICIT round-8 definition + the
 *      run-creation crash boundary). wfos_agent_runs (migration 0011,
 *      execution_id UNIQUE) IS the durable native provider-operation ledger;
 *      process loss AROUND RUN CREATION / ADAPTER INVOCATION is closed by the
 *      run row's durability: T1's gateway creates the ONE AgentRun (the
 *      durable operation record — through the REAL PgAgentRunRepository, the
 *      exact create DefaultAgentGateway performs) and DIES between the
 *      run-creation commit and the adapter invocation (ZERO adapter
 *      invocations ever) → the lease expires → T2 (a FRESH
 *      NativeExecutionProvider instance on the SECOND client) reclaims → the
 *      reconcile finds the EXISTING run and CONVERGES (ZERO provider
 *      operations from T2 — no gateway call, no adapter invocation) → the
 *      obligation discharges (the run IS the authoritative native outcome).
 *      A THIRD fresh native instance's keyed submit converges at the
 *      provider pre-check onto the SAME run (NO gateway call) — the
 *      convergence authority is the DURABLE RUN ROW, not any provider
 *      instance's memory.
 *
 * PR #46 ROUND 9 (the generation-fenced, identity-recoverable takeover —
 * this session's correction). The round-8 review confirmed the durable
 * ledger is real but found its TAKEOVER PROTOCOL deficient: (1) takeover
 * re-ran the operation body (single-row arbitration, plural operation body —
 * benign only by determinism accident); (2) complete()/fail() were NOT
 * generation-fenced (a stale FAIL could DEFEAT the recovery generation; a
 * stale SUCCESS could win merely by racing); (3) register() re-armed
 * terminally FAILED rows (one key could resolve to two different terminal
 * outcomes). The round-9 protocol (migration 0049): the operation identity
 * (provider_operation_handle) is ATTACHED BEFORE the body (a recorded
 * identity PROVES the operation started — the recovery RESOLVES BY IDENTITY,
 * never a body re-run; an absent identity PROVES the body never started —
 * driving it is the FIRST execution); takeOver() RETURNS the new generation
 * token; complete/fail are CAS-fenced against it (a stale generation is
 * STRUCTURALLY INCAPABLE of resolving); COMPLETED and FAILED are BOTH
 * terminal (the key is immutable — register NEVER re-arms):
 *
 *   R9-#1 (new — the review's adversarial interleaving #1): takeover → stale
 *      generation FAIL → new generation SUCCESS. T1's generation-1 drive
 *      stalls mid-body (identity attached) → T2 takes over (generation 2 —
 *      the fencing token) + parks INSIDE its resolve-by-identity recovery →
 *      T1's dead drive FAILS: its generation-fenced fail CAS hits 0 rows
 *      (the row is STILL pending — the stale failure cannot defeat the
 *      recovery generation) → T2's recovery SUCCEEDS: the generation-2 CAS
 *      stores the ONE result. Final: ONE row, COMPLETED, generation 2, the
 *      stored error NEVER written (error_message NULL), T1's stale failure
 *      structurally discarded.
 *
 *   R9-#2 (new — the review's adversarial interleaving #2): takeover → old
 *      generation SUCCESS → new generation SUCCESS. Same setup; T1's parked
 *      drive COMPLETES after the take-over: its complete(key, generation 1)
 *      CAS hits 0 rows (the old generation cannot win merely by racing) →
 *      T2's generation-2 resolution is stored. Final: ONE row, COMPLETED,
 *      generation 2, the STORED result is T2's (the marked recovery
 *      resolution) — T1's result was never stored. Exactly one generation
 *      resolves authoritatively; stale generations cannot alter the winner.
 *
 *   R9-#3 (new — KEY IMMUTABILITY, the ledger semantics): COMPLETED and
 *      FAILED are BOTH terminal. register NEVER re-arms a failed row (the
 *      generation stays, the stored failure stays — the round-8 re-arm is
 *      gone); takeOver REJECTS a terminal row; a later same-key submit
 *      through a fresh provider instance surfaces the STORED failure (ZERO
 *      drives — a terminally failed operation is a KNOWN outcome, never a new
 *      operation under the same key); the COMPLETED arm is symmetric (pure
 *      replay, generation unchanged); the CAS-level fencing proof (a wrong
 *      generation resolves NOTHING; the takeOver-returned token is the ONLY
 *      generation that can resolve a pending row).
 *
 *   R10-#6 (round 9's R9-#3 + round 10's LIFECYCLE CAS — KEY IMMUTABILITY):
 *      COMPLETED and FAILED are BOTH terminal. register NEVER re-arms a
 *      failed row (the generation stays, the stored failure stays — the
 *      round-8 re-arm is gone); takeOver REJECTS a terminal row; a later
 *      same-key submit through a fresh provider instance surfaces the STORED
 *      failure (ZERO submissions — a terminally failed operation is a KNOWN
 *      outcome, never a new operation under the same key); the COMPLETED arm
 *      is symmetric (pure replay, generation unchanged); the CAS-level
 *      fencing proof (a wrong generation resolves NOTHING) + the ROUND-10
 *      LIFECYCLE GATE (even the takeOver-RETURNED token cannot complete a
 *      NEVER-STARTED row — complete requires 'started'; the recovery must
 *      first pass the PROVIDER-CONFIRMED-START attach CAS).
 *
 * PR #46 ROUND 10 (the IDEMPOTENT-SUBMISSION protocol + the NATIVE LIFECYCLE
 * CONVERGENCE — this session's correction). The round-9 review found the
 * round-9 attach-before-body ordering INVALID: the crash window between the
 * durable attach and the operation body left a row whose recorded identity
 * pointed at an operation that never existed — every recovery driver then
 * resolved by that identity FOREVER without executing the body (the database
 * must never infer that an irreversible provider operation happened merely
 * because WorkflowOS persisted an intended identity). The round-10 protocol:
 * the provider boundary is IDEMPOTENT BY KEY (startOperation(key) converges
 * onto the ONE operation — the provider's key→operation mapping is the
 * authority), the handle is attached ONLY AFTER the provider confirmed the
 * operation (the state CAS 'pending' → 'started'), and the row's EXPLICIT
 * LIFECYCLE (migration 0050) is pending → started → completed/failed (a
 * terminal success is only recordable for a CONFIRMED operation). The
 * architect's COMPLETE crash matrix, proven on real PostgreSQL:
 *
 *   R10-#1 (matrix row 1 — the crash BEFORE the provider accepted): the row
 *      is 'pending' with NO handle (the ledger claims NOTHING); the recovery
 *      RE-SUBMITS + the re-submission performs the ONE FIRST execution (T1's
 *      effect never happened; T2 performs it — ONE effect across the whole
 *      interleaving).
 *
 *   R10-#2 (matrix row 2 — THE ROUND-10 HOLE: the crash AFTER the provider
 *      accepted, BEFORE the ledger attach): the row is STILL 'pending' with
 *      NO handle (the ledger claims NOTHING) yet the operation EXISTS at the
 *      provider; the recovery RE-SUBMITS + the IDEMPOTENT-BY-KEY submission
 *      CONVERGES onto the ONE platform operation (the provider's
 *      key→operation mapping is the authority — NEVER the ledger row): the
 *      side effect happens EXACTLY ONCE (two submissions, ONE effect).
 *
 *   R10-#3 (matrix rows 3 + 4 — the crash after the attach / after the
 *      provider result): a SideEffectingExternalProvider double whose
 *      IDEMPOTENT submission performs a REAL once-only side effect (a
 *      platform operation whose outcome lands on the shared "platform" state
 *      — the external system, surviving the driver's process death). T1
 *      submits (the side effect happens ONCE) + attaches (the row is
 *      'started' @ generation 1) + dies mid-resolution → T2 (a fresh
 *      instance sharing ONLY the platform) takes over → the CONFIRMED
 *      operation is RESOLVED BY IDENTITY (a status fetch — NEVER a
 *      re-submission) → the submission + its side effect ran EXACTLY ONCE
 *      (submissionCount 1 + effectCount 1 FOREVER).
 *
 *   R10-#4 / R10-#5 (matrix rows 5 + 6 — the stale generations, retained
 *      from round 9 with the explicit lifecycle): takeover → stale FAIL /
 *      stale SUCCESS — the generation-fenced CASes hit 0 rows from either
 *      non-terminal state; exactly ONE generation resolves authoritatively.
 *
 *   R10-N1 / R10-N2 / R10-N3 (the NATIVE LIFECYCLE CONVERGENCE — the
 *      round-10 review's second blocker: existing ≠ completed): an existing
 *      IN-PROGRESS AgentRun is AWAITED until terminal (the keyed submit does
 *      NOT resolve while the run is non-terminal — round 9 would have
 *      manufactured 'completed' there), the terminal SUCCESS (N1) and the
 *      terminal FAILURE (N2) are eventually reflected in the converged
 *      submission, and a STUCK (never-terminal) run FAILS CLOSED with the
 *      typed unresolved error (N3 — never a manufactured completion, never a
 *      second run; the execution_id UNIQUE is the ledger authority).
 *
 * PR #46 ROUND 11 (the SUBMISSION-ERROR TAXONOMY — definitive reject vs
 * acceptance unknown). The round-11 review found the round-10 drive
 * terminalized EVERY startOperation failure as FAILED — but an external
 * request can be accepted remotely and then lose its response (a timeout, a
 * connection reset, process death): the provider operation may EXIST (and
 * succeed) while the ledger closed the key as failed, so every later
 * same-key submission replayed a failure the provider never reported and
 * the provider's idempotency-by-key guarantee could never again be used to
 * converge (WorkflowOS itself closed the key). The taxonomy — a submission
 * error proves NOTHING about whether the provider accepted the operation
 * unless the provider says so:
 *
 *   - DEFINITIVE REJECT (the typed ProviderOperationRejectedError): the
 *      provider PROVABLY refused + guarantees NO operation exists for the
 *      key — terminal FAILED is allowed, through the ledger's
 *      DEFINITIVE-REJECT transition (the ONLY 'pending' → 'failed' path);
 *   - ACCEPTANCE UNKNOWN (every other submission error): the row REMAINS
 *      'pending' (recoverable); the keyed submit fails closed with the
 *      typed submission-outcome-unknown error; the SAME-KEY RETRY
 *      re-submits and CONVERGES through the provider's idempotency-by-key
 *      dedup, attaches the returned identity, and resolves the ONE
 *      operation. THE DATABASE NEVER CLOSES A KEY ON AN AMBIGUOUS
 *      SUBMISSION ERROR.
 *
 *   R11-#1 (the review's required regression — THE AMBIGUOUS ACCEPTANCE):
 *      the provider ACCEPTS the operation (the side effect happens; the
 *      outcome lands on the platform) but the RESPONSE IS LOST (the
 *      submission throws an ambiguous plain error) → the ledger REMAINS
 *      'pending' (NOT failed) → the takeover/retry with the SAME key → the
 *      provider returns the SAME operation identity (the dedup converges)
 *      → EXACTLY ONE external side effect → the terminal result is
 *      recorded. (Round 10's R10-#1/#2 tails are ALSO updated: an ambiguous
 *      simulated-death error now fails the dispatch 'handoff-dispatch-failed'
 *      WITHOUT any terminal ledger write.)
 *
 *   R11-#2 (the DEFINITIVE-REJECT arm): the typed reject → terminal FAILED
 *      IS recorded @ generation 1 (the only legal pending-row failure) →
 *      ZERO platform operations/effects (the provider refused) → a later
 *      same-key submit surfaces the STORED failure with ZERO submissions
 *      (key immutability for the reject arm).
 *
 *   R11-#3 (the repository taxonomy proofs): reject is the pending-ONLY
 *      gate (a started row's reject hits 0 rows; a wrong generation hits 0
 *      rows); fail is the started-ONLY gate (a PENDING row's fail hits 0
 *      rows — the ambiguous-submission guard is STRUCTURAL: an unconfirmed
 *      submission has NO resolution-failure path at all).
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
  AgentError,
  AgentGateway,
  AgentProviderAdapter,
  AgentRequest,
  AgentExecutionResult,
} from '../../../src/modules/agents/internal/agent.types.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import {
  PgExecutionRecordRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import {
  ExternalExecutionProvider,
  type ExternalExecutionProviderOptions,
} from '../../../src/modules/agents/internal/external-execution-provider.js';
import { PgExecutionProviderOperationRepository } from '../../../src/modules/agents/internal/pg-execution-provider-operation-repository.js';
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
  ExecutionSubmission,
  ExecutionTask,
} from '../../../src/modules/agents/internal/execution.types.js';
import { ProviderOperationRejectedError } from '../../../src/modules/agents/internal/execution.types.js';
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
  // WORK-043 remediation: the destination-eligibility seam is REQUIRED —
  // the stub returns an ELIGIBLE verdict (these suites exercise the
  // claim/lease/fenced-dispatch mechanics, not destination policy; the
  // verdict-driven destination tests live in the cross-mode regression
  // suite's WORK-043 describe).
  async evaluateCandidateEligibility(_input: {
    organizationId: string;
    projectId: string;
    workItemId: string;
    provider: string;
    model: string | null;
    executionMode: 'native' | 'external';
    userId?: string | null;
  }): Promise<{
    eligibility: {
      status: string;
      eligible: boolean;
      blockingReasons: readonly { category: string; constraint: string; reason: string }[];
    };
    policyVersion: number;
  }> {
    return {
      eligibility: { status: 'eligible', eligible: true, blockingReasons: [] },
      policyVersion: 1,
    };
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
 * PR #46 round 8 + round 10: an InstrumentedExternalProvider — the REAL
 * (ledger-backed) ExternalExecutionProvider instrumented at the provider
 * boundaries, as a SEPARATE INSTANCE per actor. The round-8 review rejected
 * the round-7 harness precisely because it SHARED one provider instance (and
 * therefore the in-memory Map) between T1 and T2 — the registry under test is
 * now the DURABLE LEDGER, so every actor gets its OWN instance (on its OWN
 * pg client), and the counters prove the invariants across instances:
 *
 *   - `submitCount` — the number of submit ATTEMPTS on THIS instance;
 *   - `submissionCount` — the number of IDEMPOTENT-BY-KEY SUBMISSIONS
 *     (startOperation entries) on THIS instance — round 10's submission
 *     seam (a 'pending' row is RE-SUBMITTED by its recovery driver);
 *   - `driveCount` — the number of UNKEYED one-shot body runs (generate
 *     entries) on THIS instance — the KEYED path NEVER calls this seam
 *     (asserted as ZERO by the keyed regressions: the structural proof
 *     that the keyed dispatch never falls back to the raw body);
 *   - `resolveCount` — the number of RESOLVE-BY-IDENTITY resolutions
 *     (resolveOperation entries) on THIS instance — round 10's recovery
 *     seam (a status fetch for a platform provider; pure re-derivation for
 *     the default provider);
 *   - `submitKeys()` — every attempt's dispatch key;
 *   - `inResolve` + `parkAtResolve` — TRUE once a driver parked INSIDE
 *     resolveOperation — between the attach (the row is 'started' @ the
 *     driver's generation) and the generation-fenced completion (the
 *     mid-operation / mid-recovery stall point);
 *   - `inSubmitBefore` + `parkBeforeSubmit` (round 10) — TRUE once the drive
 *     parked INSIDE startOperation BEFORE the provider accepted — the
 *     die-before-the-provider-started point (the row is 'pending', NOTHING
 *     at the provider);
 *   - `inSubmitAfter` + `parkAfterSubmitAccepted` (round 10) — TRUE once
 *     the drive parked INSIDE startOperation AFTER the provider accepted
 *     the submission but BEFORE the ledger attach — THE ROUND-10 CRASH
 *     WINDOW (the provider owns the operation; the ledger row is 'pending'
 *     with NO handle and claims NOTHING);
 *   - `resolutionMarker` (round 9) — resolveOperation returns the derived
 *     submission with `externalSessionRef` set to the marker, so a test can
 *     prove WHICH driver's resolution was stored by the winner CAS.
 *
 * The durable-ledger row count (queried directly from
 * wfos_execution_provider_operations) is THE provider-operation count: ONE
 * row per key, across ALL instances.
 */
class InstrumentedExternalProvider extends ExternalExecutionProvider {
  private _submitCount = 0;
  private _submissionCount = 0;
  private _driveCount = 0;
  private _resolveCount = 0;
  private readonly _submitKeys: string[] = [];
  private readonly beforeSubmitParkGate: Promise<unknown> | undefined;
  private readonly afterSubmitParkGate: Promise<unknown> | undefined;
  private readonly resolveParkGate: Promise<void> | undefined;
  private readonly resolutionMarker: string | undefined;
  private parkedInSubmitBefore = false;
  private parkedInSubmitAfter = false;
  private parkedInResolve = false;
  constructor(
    options: ExternalExecutionProviderOptions & {
      parkBeforeSubmit?: Promise<unknown>;
      parkAfterSubmitAccepted?: Promise<unknown>;
      parkAtResolve?: Promise<void>;
      resolutionMarker?: string;
    } = {},
  ) {
    const {
      parkBeforeSubmit,
      parkAfterSubmitAccepted,
      parkAtResolve,
      resolutionMarker,
      ...providerOptions
    } = options;
    super(providerOptions);
    this.beforeSubmitParkGate = parkBeforeSubmit;
    this.afterSubmitParkGate = parkAfterSubmitAccepted;
    this.resolveParkGate = parkAtResolve;
    this.resolutionMarker = resolutionMarker;
  }
  /** TRUE once a drive parked INSIDE startOperation BEFORE the provider accepted (nothing at the provider). */
  get inSubmitBefore(): boolean { return this.parkedInSubmitBefore; }
  /** TRUE once a drive parked INSIDE startOperation AFTER the provider accepted (the round-10 crash window). */
  get inSubmitAfter(): boolean { return this.parkedInSubmitAfter; }
  /** TRUE once a driver parked INSIDE resolveOperation (the mid-operation/mid-recovery stall point). */
  get inResolve(): boolean { return this.parkedInResolve; }
  /** The number of `submit` calls on THIS instance (the submit attempts). */
  get submitCount(): number { return this._submitCount; }
  /** The number of IDEMPOTENT-BY-KEY SUBMISSIONS (startOperation entries) on THIS instance. */
  get submissionCount(): number { return this._submissionCount; }
  /** The number of UNKEYED one-shot body runs (generate entries) on THIS instance. */
  get driveCount(): number { return this._driveCount; }
  /** The number of RESOLVE-BY-IDENTITY resolutions (resolveOperation entries) on THIS instance. */
  get resolveCount(): number { return this._resolveCount; }
  /** EVERY submit attempt's key on THIS instance, in order. */
  submitKeys(): string[] { return [...this._submitKeys]; }
  override async submit(task: ExecutionTask): Promise<ExecutionSubmission> {
    this._submitCount++;
    this._submitKeys.push(task.dispatchIdempotencyKey ?? task.executionId);
    return super.submit(task);
  }
  protected override async startOperation(
    idempotencyKey: string,
    task: ExecutionTask,
  ): Promise<string> {
    this._submissionCount++;
    if (this.beforeSubmitParkGate) {
      // The round-10 die-BEFORE-the-provider-accepted point: NOTHING exists
      // at the provider; the ledger row is 'pending' with NO handle.
      this.parkedInSubmitBefore = true;
      await this.beforeSubmitParkGate;
      this.parkedInSubmitBefore = false;
    }
    const handle = await super.startOperation(idempotencyKey, task);
    if (this.afterSubmitParkGate) {
      // THE ROUND-10 CRASH WINDOW: the provider ACCEPTED the submission (the
      // operation exists at the provider) but the ledger attach has NOT run
      // — the row is still 'pending' with NO handle (the row claims
      // NOTHING; only the provider's key→operation mapping knows).
      this.parkedInSubmitAfter = true;
      await this.afterSubmitParkGate;
      this.parkedInSubmitAfter = false;
    }
    return handle;
  }
  protected override async generate(
    task: ExecutionTask,
  ): Promise<ExecutionSubmission> {
    this._driveCount++;
    return super.generate(task);
  }
  protected override async resolveOperation(
    providerOperationHandle: string,
    task: ExecutionTask,
  ): Promise<ExecutionSubmission> {
    this._resolveCount++;
    if (this.resolveParkGate) {
      // The round-10 mid-operation/mid-recovery stall point: the row is
      // 'started' (the provider CONFIRMED the operation); the driver parked
      // between the attach + the generation-fenced completion.
      this.parkedInResolve = true;
      await this.resolveParkGate;
      this.parkedInResolve = false;
    }
    const submission = await super.resolveOperation(providerOperationHandle, task);
    return this.resolutionMarker
      ? { ...submission, externalSessionRef: this.resolutionMarker }
      : submission;
  }
}

/**
 * PR #46 round 9 + round 10 (R10-#2/#3) + round 11 (R11-#1/#2): a
 * SIDE-EFFECTING external provider double — the architect's "genuinely
 * side-effecting provider" proof. The IDEMPOTENT-BY-KEY SUBMISSION
 * (startOperation) performs a REAL, ONCE-ONLY side effect: it submits the
 * "platform operation" whose outcome lands on the shared PLATFORM map (the
 * external system's durable state — it survives the driver's process death,
 * exactly like a real platform). THE PLATFORM'S key→operation mapping is the
 * idempotency authority: a re-submission for a key that already owns a
 * platform operation CONVERGES onto it (returns the same identity, performs
 * NO second effect) — exactly like a platform idempotency key. The recovery
 * seam (resolveOperation) is a STATUS FETCH on that map — it NEVER
 * re-submits. The gates model the provider-boundary failure points:
 *   - beforeEffect: die BEFORE the platform accepted (the re-submission is
 *     the FIRST execution — matrix row 1);
 *   - afterEffect: die AFTER the platform accepted, BEFORE the ledger attach
 *     (the re-submission CONVERGES — matrix row 2, THE round-10 hole: the
 *     ledger row is 'pending' with NO handle and claims NOTHING, yet the
 *     operation EXISTS at the provider);
 *   - loseResponseAfterAccept (ROUND 11 — THE AMBIGUOUS ACCEPTANCE): the
 *     platform ACCEPTS the operation (the side effect happens; the outcome
 *     lands on the platform) but the RESPONSE IS LOST — the submission call
 *     throws an AMBIGUOUS plain error (a connection reset after the accept).
 *     NOT a definitive reject: the provider did NOT refuse the operation —
 *     it accepted it and the response never arrived. The ledger row stays
 *     'pending' (recoverable); the same-key re-submission CONVERGES;
 *   - definitiveReject (ROUND 11 — THE DEFINITIVE REJECT): the platform
 *     REFUSES the operation — the typed ProviderOperationRejectedError (it
 *     guarantees NO operation exists for the key; nothing lands on the
 *     platform). Terminal FAILED is legal for exactly this error.
 */
class SideEffectingExternalProvider extends ExternalExecutionProvider {
  private _submissionCount = 0;
  private _effectCount = 0;
  private _resolveCount = 0;
  constructor(
    options: ExternalExecutionProviderOptions,
    private readonly gates: {
      beforeEffect?: Promise<never>;
      afterEffect?: Promise<never>;
      parkAtResolve?: Promise<void>;
      loseResponseAfterAccept?: boolean;
      definitiveReject?: boolean;
    },
    /** The shared "platform" state (the external system — survives process death). */
    private readonly platform: Map<string, ExecutionSubmission>,
  ) {
    super(options);
  }
  /** The number of IDEMPOTENT-BY-KEY SUBMISSIONS (startOperation entries). */
  get submissionCount(): number { return this._submissionCount; }
  /** The number of SIDE EFFECTS performed (platform operations accepted). */
  get effectCount(): number { return this._effectCount; }
  /** The number of STATUS FETCH resolutions (resolve-by-identity). */
  get resolveCount(): number { return this._resolveCount; }
  protected override async startOperation(
    idempotencyKey: string,
    task: ExecutionTask,
  ): Promise<string> {
    this._submissionCount++;
    if (this.gates.definitiveReject) {
      // ROUND 11 — THE DEFINITIVE REJECT: the platform REFUSES the operation
      // — it guarantees NO operation exists for the key (no side effect,
      // NOTHING lands on the platform map). The typed error is the ONLY
      // submission error that may terminally fail the ledger key.
      throw new ProviderOperationRejectedError(
        'simulated definitive provider reject — the platform refused the operation (NO operation exists for the key)',
      );
    }
    // The platform's own operation-identity space (the idempotency key the
    // platform dedupes on).
    const handle = `platform-operation:${idempotencyKey}`;
    if (!this.platform.has(handle)) {
      if (this.gates.beforeEffect) {
        // The process DIES BEFORE the platform accepted — NOTHING exists at
        // the provider (the ledger row is 'pending'; a re-submission will
        // perform the FIRST execution).
        await this.gates.beforeEffect;
      }
      // THE SIDE EFFECT: the platform submission — the operation is accepted
      // + completes, the outcome landing on the shared (durable) platform.
      // Exactly once per key BY THE PLATFORM'S OWN key→operation mapping.
      const submission = await this.generate(task);
      this.platform.set(handle, {
        ...submission,
        externalSessionRef: 'platform-operation-outcome' as string | null,
      });
      this._effectCount++;
      if (this.gates.afterEffect) {
        // The process DIES HERE — AFTER the platform accepted the operation,
        // BEFORE the ledger attach (the outcome exists ONLY at the platform;
        // the ledger row is still 'pending' with NO handle — the row claims
        // NOTHING about the provider).
        await this.gates.afterEffect;
      }
      if (this.gates.loseResponseAfterAccept) {
        // ROUND 11 — THE AMBIGUOUS ACCEPTANCE (the review's blocker): the
        // platform ACCEPTED the operation (the side effect happened; the
        // outcome is on the platform map) but the RESPONSE IS LOST — the
        // submission call fails with an AMBIGUOUS plain error (a connection
        // reset after the accept). This is NOT a definitive reject: the
        // operation EXISTS at the provider. The ledger row must STAY
        // 'pending' (recoverable) — the same-key re-submission converges
        // onto the ONE platform operation. Fires only on the ACCEPTING
        // submission (a re-submission for the existing operation converges
        // normally below).
        throw new Error(
          'simulated connection reset AFTER the platform accepted the operation — the response was lost (NOT a definitive reject: the operation EXISTS at the provider)',
        );
      }
    }
    // A re-submission for an EXISTING platform operation CONVERGES: the same
    // identity is returned, NO second effect is performed (the platform's
    // key→operation mapping is the authority — never the ledger row).
    return handle;
  }
  protected override async resolveOperation(
    providerOperationHandle: string,
    _task: ExecutionTask,
  ): Promise<ExecutionSubmission> {
    this._resolveCount++;
    if (this.gates.parkAtResolve) {
      // The mid-resolution stall point: the row is 'started' (the provider
      // CONFIRMED the operation); the driver parked between the attach + the
      // generation-fenced completion.
      await this.gates.parkAtResolve;
    }
    // THE STATUS FETCH: resolve the CONFIRMED operation by its durable
    // identity — NEVER a re-submission (the architect's requirement for a
    // non-pure provider's takeover recovery).
    const outcome = this.platform.get(providerOperationHandle);
    if (!outcome) {
      throw new Error(
        `platform-operation-not-found: ${providerOperationHandle} (the operation was never started under this identity)`,
      );
    }
    return outcome;
  }
}

/**
 * PR #46 round 8 (R8-#2): a gateway double that reproduces
 * DefaultAgentGateway.execute's FIRST DURABLE step — the AgentRun creation
 * through the REAL PgAgentRunRepository with the exact fields the gateway
 * persists — and then DIES: the gateway call parks on the supplied gate
 * (released as a rejection at the end of the test). This is the crash window
 * BETWEEN the run-creation COMMIT and the adapter invocation: the run row
 * EXISTS (the durable native provider-operation record is OPEN), the adapter
 * was NEVER invoked, and the gateway never finalizes the run — the deepest
 * process-loss point around run creation.
 */
class CrashAfterRunCreationGateway {
  private _runCreated = false;
  constructor(
    private readonly runRepo: PgAgentRunRepository,
    private readonly gate: Promise<never>,
  ) {}
  /** TRUE once the AgentRun row was created (the durable operation record is open). */
  get runCreated(): boolean { return this._runCreated; }
  async execute(request: AgentRequest): Promise<AgentExecutionResult> {
    // The exact create DefaultAgentGateway performs (agent-gateway.ts) — the
    // run row IS the durable native provider-operation record.
    await this.runRepo.create({
      executionId: request.executionId,
      workItemId: request.workItemId,
      workOrderId: request.workOrderId,
      architectureVersionId: request.architectureVersionId,
      provider: request.provider,
      configuration: request.configuration,
      repositoryRef: request.repositoryRef,
      branch: request.branch,
      maxRetries: 3,
    });
    this._runCreated = true;
    // The process DIES here — between the run-creation commit and the adapter
    // invocation. The rejection (when the test releases the gate) models the
    // dead process's in-flight gateway call failing on its connection loss.
    await this.gate;
    throw new Error('crash-after-run-creation: the gateway process died');
  }
}

/**
 * PR #46 round 8 (R8-#2): a counting gateway wrapper — proves a THIRD fresh
 * native provider instance's keyed submit NEVER reaches the gateway (it
 * converges at the provider pre-check onto the durable run row).
 */
class CountingGateway {
  private _executeCount = 0;
  constructor(private readonly real: AgentGateway) {}
  get executeCount(): number { return this._executeCount; }
  async execute(request: AgentRequest): Promise<AgentExecutionResult> {
    this._executeCount++;
    return this.real.execute(request);
  }
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

describe.skipIf(!isRealPg)('PR #46 round 4 + round 5 + round 6 + round 7 + round 8 + round 9 + round 10 + round 11 — the durable cross-mode-handoff claim/lease, the unique-owner/heartbeat/epoch-fence lease semantics, the FENCED DISPATCH boundary, the KEYED provider-dispatch exactly-once boundary, the DURABLE provider-operation ledger, the GENERATION-FENCED takeover protocol, the IDEMPOTENT-SUBMISSION + NATIVE-LIFECYCLE-CONVERGENCE boundary, + the SUBMISSION-ERROR TAXONOMY (definitive reject vs acceptance unknown — the database never closes a key on an ambiguous submission error) (real PostgreSQL two-actor concurrency with provider-instance separation)', () => {
  let stack: TestAuthStack;
  let second: { client: DatabaseClient; close: () => Promise<void> } | undefined;

  let executionRecordRepo: PgExecutionRecordRepository;
  let crossModeHandoffRepo: PgCrossModeHandoffRepository;
  let agentRunRepo: PgAgentRunRepository;
  let contextRepo: PgImplementationContextRepository;
  let executionTaskService: DefaultExecutionTaskService;
  let nativeExecutionProvider: NativeExecutionProvider;
  let externalProviderT1: InstrumentedExternalProvider;
  let externalProviderT2: InstrumentedExternalProvider;
  let t2NativeExecutionProvider: NativeExecutionProvider;
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

    // PR #46 round 8: open the SECOND independent pg.Client (T2) EARLY — the
    // per-actor provider instances below are built on their OWN clients
    // (provider-instance separation: T1's external provider + T2's external
    // provider are DISTINCT instances on DISTINCT connections, exactly the
    // round-8 harness requirement — the round-7 harness shared ONE instance
    // and therefore only proved its in-memory Map).
    second = stack.db.createSecondClient ? await stack.db.createSecondClient() : undefined;

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
    // PR #46 round 8: T2's native provider — a FRESH NativeExecutionProvider
    // instance on the SECOND client (its own gateway + its own run repository):
    // the native convergence authority must be the DURABLE RUN ROW
    // (wfos_agent_runs — the durable native provider-operation ledger), never
    // provider-instance state. The gateway still invokes the SHARED fakeAgent
    // adapter so the adapter-invocation count remains a single global counter.
    t2NativeExecutionProvider = new NativeExecutionProvider({
      agentGateway: new DefaultAgentGateway(second!.client, stack.db.logger, [fakeAgent], 3),
      agentRunRepository: new PgAgentRunRepository(second!.client),
      logger: stack.db.logger,
    });
    // PR #46 round 8: the external providers — DISTINCT instrumented instances
    // of the REAL (ledger-backed) ExternalExecutionProvider per actor, each
    // with its own durable-ledger store on its OWN client. The keyed registry
    // under test is the DURABLE PROVIDER-OPERATION LEDGER
    // (wfos_execution_provider_operations, migration 0048) — the same-key
    // convergence across these instances is proven through the ledger, never
    // through shared instance state.
    externalProviderT1 = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(db),
      logger: stack.db.logger,
    });
    externalProviderT2 = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(second!.client),
      logger: stack.db.logger,
    });

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
    // (The SECOND independent pg.Client (T2) was opened EARLY in this
    // beforeEach — the round-8 per-actor provider instances are built on it;
    // see the setup above.)
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

  /** PR #46 round 8 + round 9: read the DURABLE PROVIDER-OPERATION LEDGER rows
   *  for an execution (wfos_execution_provider_operations) — THE provider-operation
   *  count across ALL provider instances (ONE row per key — the row IS the
   *  operation). Round 9 also reads the OPERATION IDENTITY
   *  (provider_operation_handle) + the stored failure (error_message). */
  async function readProviderOperations(
    executionId: string,
  ): Promise<Array<{
    idempotencyKey: string; state: string; generation: number;
    submissionJson: string | null; handle: string | null; errorMessage: string | null;
  }>> {
    const res = await stack.db.client.query<{
      idempotency_key: string; state: string; generation: number;
      submission_json: string | null; provider_operation_handle: string | null;
      error_message: string | null;
    }>(
      `SELECT idempotency_key, state, generation, submission_json::text AS submission_json,
              provider_operation_handle, error_message
       FROM wfos_execution_provider_operations WHERE execution_id = $1`,
      [executionId],
    );
    return res.rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      state: r.state,
      generation: Number(r.generation),
      submissionJson: r.submission_json,
      handle: r.provider_operation_handle,
      errorMessage: r.error_message,
    }));
  }

  /** PR #46 round 8: count the AgentRun rows for an execution — the durable
   *  native provider-operation ledger's row count (ONE run = ONE native
   *  provider operation). */
  async function countAgentRuns(executionId: string): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_agent_runs WHERE execution_id = $1`,
      [executionId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** PR #46 round 8: the TOTAL external submit attempts across BOTH actors'
   *  provider instances (T1's + T2's) — the actor-agnostic submit count. */
  function totalExternalSubmits(): number {
    return externalProviderT1.submitCount + externalProviderT2.submitCount;
  }

  /** Build a T1 (caller-path) service on T1's client. PR #46 round 8: T1's
   *  EXTERNAL provider is its OWN InstrumentedExternalProvider instance
   *  (externalProviderT1 — T1's client + its own durable-ledger store): NO
   *  provider instance is shared with T2 (the round-8 harness requirement).
   *  The optional hooks (`willMutate` / `onFirstRenew` /
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
   *  INSIDE the adapter, the deepest provider-operation point). The optional
   *  `externalProvider` (round 8) OVERRIDES the suite-level T1 external
   *  provider (e.g. an instance whose first operation drive PARKS — the
   *  mid-operation stall/death simulations). */
  function buildT1Service(opts: {
    willMutate?: () => Promise<void>;
    onFirstRenew?: () => Promise<void>;
    willEnterDispatchGate?: () => Promise<void>;
    onDispatchGateEntered?: () => Promise<void>;
    leaseMs?: number;
    heartbeatMs?: number;
    stats?: DispatchGateStats;
    nativeProvider?: NativeExecutionProvider;
    externalProvider?: ExternalExecutionProvider;
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
      externalExecutionProvider: opts.externalProvider ?? externalProviderT1,
      agentRunRepository: agentRunRepo,
      agentPolicyEvaluator: new AllowAllAgentPolicyEvaluator(),
      executionPolicyService: new StubExecutionPolicyService(true),
      organizationResolver: { getOrganizationId: async () => 'org-test' },
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

  /** Build a T2 (relay-path) service on the SECOND client. PR #46 round 8:
   *  T2's providers are its OWN instances on the SECOND client —
   *  externalProviderT2 (a distinct InstrumentedExternalProvider with its own
   *  durable-ledger store) + t2NativeExecutionProvider (a distinct
   *  NativeExecutionProvider with its own gateway + run repository): NO
   *  provider instance is shared with T1 (the round-8 harness requirement —
   *  the convergence authority must be the DURABLE LEDGERS, never shared
   *  instance state). The optional `stats` is the SHARED dispatch-gate counter
   *  object (the SAME object wired into T1's wrapper — R6 asserts exactly ONE
   *  authoritative outcome write across BOTH actors). The optional
   *  `externalProvider` (round 8) OVERRIDES the suite-level T2 external
   *  provider (e.g. an instance with a SHORT resolution window — the
   *  process-loss take-over simulation). */
  function buildT2Service(opts: {
    stats?: DispatchGateStats;
    externalProvider?: ExternalExecutionProvider;
  } = {}): DefaultCrossModeHandoffService {
    if (!second) throw new Error('T2 second client is not open (isRealPg=false?)');
    const t2RecordRepo = new PgExecutionRecordRepository(second.client);
    const t2HandoffRepo = opts.stats
      ? new HookedHandoffRepository(new PgCrossModeHandoffRepository(second.client), { stats: opts.stats })
      : new PgCrossModeHandoffRepository(second.client);
    return new DefaultCrossModeHandoffService({
      executionRecordRepository: t2RecordRepo,
      crossModeHandoffRepository: t2HandoffRepo,
      executionTaskService,
      nativeExecutionProvider: t2NativeExecutionProvider,
      externalExecutionProvider: opts.externalProvider ?? externalProviderT2,
      agentRunRepository: agentRunRepo,
      agentPolicyEvaluator: new AllowAllAgentPolicyEvaluator(),
      executionPolicyService: new StubExecutionPolicyService(true),
      organizationResolver: { getOrganizationId: async () => 'org-test' },
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
    // first attempt returned early; T2's retry was a no-op discharge). PR #46
    // round 8: the submit count spans BOTH actors' provider instances
    // (T1's + T2's — distinct instances, one durable ledger).
    expect(totalExternalSubmits(), 'ZERO duplicate dispatches — only T1 dispatched (T2 was claim-held then no-op discharge)').toBe(1);
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
    // (T1 crashed before mutating). PR #46 round 8: the submit count spans
    // BOTH actors' provider instances (distinct instances, one ledger).
    expect(totalExternalSubmits(), 'T2 dispatched exactly once (the re-dispatch after reclaim)').toBe(1);
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

    // ZERO duplicate dispatches / session transitions: only T1's. PR #46
    // round 8: the submit count spans BOTH actors' provider instances.
    expect(totalExternalSubmits(), 'ZERO duplicate dispatches — only T1 dispatched (T2 was claim-held mid-flight)').toBe(1);
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
    // mutate). PR #46 round 8: the submit count spans BOTH actors' provider
    // instances.
    expect(totalExternalSubmits(), 'ZERO duplicate dispatches — only T2 dispatched (T1 aborted at the fence check)').toBe(1);
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
      // AR-043-03: the authoritative dispatch-event timestamp (the real
      // provider stamps it at the package derivation).
      dispatchedAt: new Date().toISOString(),
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
    // crossing is what stops T1. PR #46 round 8: the submit count spans BOTH
    // actors' provider instances (distinct instances, one durable ledger).
    expect(totalExternalSubmits(), 'ZERO provider calls from T1 — the gated boundary aborted it BEFORE the submit (exactly one submit: T2\'s)').toBe(1);
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
  // R6-#2 (REWRITTEN by round 8 — the DURABLE provider-operation ledger, with
  // PROVIDER-INSTANCE SEPARATION). The round-8 review rejected the round-7
  // harness precisely on this test: it SHARED the counting provider instance
  // between T1 and T2, so operationsCreated === 1 proved only the in-memory
  // Map converged — never that a FRESH provider instance resolves the SAME
  // operation. The stall-DURING-the-dispatch interleaving now runs with T1's
  // and T2's external providers as DISTINCT instances on DISTINCT clients,
  // converging through the DURABLE LEDGER (wfos_execution_provider_operations,
  // migration 0048):
  //
  //   T1 claims (epoch N) → T1 crosses the dispatch gate → T1's submit OPENED
  //   the ONE durable ledger row under the handoff-derived key (PENDING — the
  //   operation is in flight at T1) and stalls INSIDE the operation body
  //   (heartbeat dead) → the lease expires → T2 reclaims (epoch N+1) + takes
  //   over the in-flight gate + re-dispatches through a FRESH provider
  //   instance (T2's, on the SECOND client) → T2's same-key submit CONVERGES
  //   through the ledger onto the in-flight row (it awaits the row's durable
  //   resolution — NO second drive, NO second row) → the provider resolves
  //   the operation (T1's parked drive completes → its resolution CAS stores
  //   the ONE result) → T2's await REPLAYS the STORED result (both actors
  //   observe the SAME submission) → T2's completeFencedDispatch commits the
  //   ONE authoritative outcome → T1's completeFencedDispatch affects 0 rows
  //   (DISCARDED — fence loss).
  //
  // THE ROUND-8 INVARIANT (proven at the DURABLE-LEDGER level, across DISTINCT
  // provider instances): ONE ledger row for the key (the row IS the operation
  // — there is structurally no second row), exactly ONE operation-body drive
  // (T1's — T2's converged submit performed ZERO drives), both submits under
  // the SAME handoff-derived key, and the durable dispatch_idempotency_key
  // recorded on the obligation row EQUALS the ledger row's key.
  // =========================================================================
  it('R6-#2 (round 8). a stalled owner\'s ALREADY-STARTED provider operation is CONVERGED onto through the DURABLE LEDGER — not duplicated: a FRESH provider instance (T2, second client) converges on the SAME key + ONE ledger row + ONE drive (T2 completes the ONE authoritative outcome; T1\'s resumed completion is DISCARDED)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat, dispatching through a
    // provider instance whose drive parks INSIDE the RESOLUTION (round 10:
    // after the IDEMPOTENT-BY-KEY submission + the attach — the row is
    // 'started' @ generation 1, the provider CONFIRMED the operation; the
    // resolution CAS has not run). A LONG resolution window on T2's provider
    // below keeps T2's converged submit AWAITING the row (the in-flight
    // convergence arm — T2 must NOT re-drive while the original drive is
    // merely stalled, not dead).
    let resolveSubmit!: () => void;
    const submitGate = new Promise<void>((r) => { resolveSubmit = r; });
    const t1Provider = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
      logger: stack.db.logger,
      parkAtResolve: submitGate,
    });
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: t1Provider,
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

    // Wait until T1 is stalled INSIDE its in-flight operation (the ledger row
    // is 'started' @ generation 1 — the provider CONFIRMED the operation;
    // the resolution is parked), then let the 150ms lease expire while T1 is
    // stalled (no heartbeat renews).
    await waitFor(() => t1Provider.inResolve, 5000);
    const rowsAtStall = await readProviderOperations(executionId);
    expect(rowsAtStall.length, 'T1 OPENED exactly ONE durable provider-operation ledger row').toBe(1);
    expect(rowsAtStall[0]!.state, 'the operation is CONFIRMED + IN FLIGHT (the row is STARTED — the idempotent submission returned its identity; the outcome is not yet known)').toBe('started');
    expect(rowsAtStall[0]!.handle, 'PR #46 round 10: the PROVIDER-CONFIRMED identity is recorded (the attach ran AFTER the submission — a recovery driver will RESOLVE BY IDENTITY, never re-submit)').not.toBeNull();
    expect(t1Provider.submissionCount, 'T1 performed exactly ONE idempotent submission').toBe(1);
    expect(t1Provider.resolveCount, 'T1 is parked INSIDE its ONE resolution').toBe(1);
    expect(t1Provider.driveCount, 'the KEYED path NEVER runs the unkeyed one-shot body seam').toBe(0);
    await delay(300);

    // T2 (the boot sweep) reclaims the expired lease (epoch N+1) → crash
    // window #2 (record.mode === external, packageValue missing — T1's
    // outcome write never ran) → T2's re-dispatch TAKES OVER the in-flight
    // gate (dispatch_epoch N < N+1 — the monotonic take-over arm) → T2's
    // SAME-KEY submit runs through a FRESH provider instance on the SECOND
    // client → the DURABLE LEDGER converges it onto the PENDING row (the
    // registry is the ledger — NOT any instance's memory): T2 AWAITS the
    // row's resolution (a LONG window — T1's drive is stalled, not dead; NO
    // second drive is started). T2's reconcile therefore runs as a background
    // promise — it parks inside the ledger await until T1's drive resolves.
    const t2Provider = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(second!.client),
      logger: stack.db.logger,
      operationResolutionWindowMs: 30_000,
      operationPollIntervalMs: 10,
    });
    const t2Service = buildT2Service({ stats, externalProvider: t2Provider });
    let t2Result: { stage?: string } | undefined;
    const t2Promise = (async () => {
      t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    })();
    await waitFor(() => t2Provider.submitCount >= 1, 5000);

    // THE ROUND-8 INVARIANT, asserted MID-FLIGHT (T1's resolution still
    // parked, T2 inside the ledger await): both actors submitted (2 attempts
    // across TWO DISTINCT provider instances) — but exactly ONE durable
    // ledger row + exactly ONE provider operation (T1's submission + T1's
    // parked resolution — T2's converged submit performed ZERO submissions,
    // ZERO resolutions, ZERO drives: it awaits the STARTED row through the
    // ledger), and BOTH attempts carried the SAME handoff-derived key.
    expect(t1Provider.submitCount + t2Provider.submitCount, 'both actors\' submit ATTEMPTS ran (across DISTINCT provider instances — the reclaiming owner re-dispatched mid-flight)').toBe(2);
    expect(t2Provider.submissionCount, 'T2\'s fresh instance performed ZERO submissions (the row is STARTED — the CONFIRMED operation is awaited, never re-submitted)').toBe(0);
    expect(t2Provider.resolveCount, 'T2\'s fresh instance performed ZERO resolutions (it awaits the in-flight operation through the ledger)').toBe(0);
    expect(t1Provider.driveCount + t2Provider.driveCount, 'the KEYED path NEVER runs the unkeyed body seam (on EITHER instance)').toBe(0);
    const t1Keys = t1Provider.submitKeys();
    const t2Keys = t2Provider.submitKeys();
    expect(t1Keys.length + t2Keys.length, 'two submit attempts recorded').toBe(2);
    expect(t1Keys[0], 'both attempts used the SAME durable idempotency key (the handoff identity — stable across owners/epochs/reclaims/INSTANCES)').toBe(t2Keys[0]);
    expect(t1Keys[0], 'the key is the handoff-derived dispatch key').toMatch(/^cross-mode-dispatch-/);
    const rowsMid = await readProviderOperations(executionId);
    expect(rowsMid.length, 'still exactly ONE durable provider operation (ONE ledger row — across BOTH instances)').toBe(1);
    expect(rowsMid[0]!.state, 'the ONE operation is still CONFIRMED + IN FLIGHT (T2 awaits; no second operation exists)').toBe('started');

    // The PROVIDER resolves the operation (T1's parked resolution completes →
    // its generation-1 CAS stores the ONE result — the original submitter's
    // liveness is irrelevant, the operation lives in the DURABLE LEDGER).
    // T2's await then REPLAYS the STORED result.
    resolveSubmit();
    await t2Promise;
    expect(t2Result!.stage, 'T2 reclaimed the expired lease, took over the in-flight gate, converged onto the ONE durable provider operation, + completed the handoff').toBe('complete');

    // The ledger after resolution: ONE row, COMPLETED, with the ONE stored
    // result (T1's drive stored it; T2 replayed it — the same key always
    // resolves to the same operation/result).
    const rowsAfter = await readProviderOperations(executionId);
    expect(rowsAfter.length, 'still exactly ONE durable provider operation for the whole interleaving').toBe(1);
    expect(rowsAfter[0]!.state, 'the ONE operation COMPLETED (the resolution CAS stored the ONE result)').toBe('completed');
    expect(rowsAfter[0]!.submissionJson, 'the operation result is durably stored (replayed by every later same-key submit)').not.toBeNull();
    expect(t1Provider.submissionCount + t2Provider.submissionCount, 'still exactly ONE provider submission for the whole interleaving (T2 replayed; it never submitted)').toBe(1);
    expect(t1Provider.resolveCount + t2Provider.resolveCount, 'exactly ONE resolution for the whole interleaving (T1\'s parked resolution completed; T2 replayed its stored result)').toBe(1);

    // Capture T2's authoritative outcome (the record state after T2's
    // completion) — T1's resumed dispatch must NOT disturb it.
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(afterT2!.packageValue).not.toBeNull();
    expect(afterT2!.expiresAt).not.toBeNull();

    // T1 resumes: its parked resolution completes + its generation-1 CAS
    // stored the ONE result (it was the ONLY driver), so its submit returns
    // the SAME (stored) submission — then T1's completeFencedDispatch
    // evaluates the fence — the lease is T2's (and the obligation is
    // discharged) → 0 rows → the transaction ROLLS BACK — NO outcome write.
    // T1 aborts 'claim-fence-lost'.
    await t1Promise;
    expect(t1Error, 'T1\'s resumed handoff FAILED with the fence-lost error (the discarded already-started dispatch)').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'T1\'s already-started dispatch was fenced out at the atomic completion').toBe('claim-fence-lost');

    // THE ROUND-8 INVARIANT, final: exactly ONE durable provider operation
    // (ONE ledger row — never a second, across DISTINCT provider instances),
    // ONE provider submission + ONE resolution, ONE authoritative outcome
    // write (T2's), T1's completion DISCARDED (0 rows, rollback), and the
    // DURABLE key recorded on the obligation row (migration 0047 — atomic
    // with the gate-open) EQUALS the ledger operation's key.
    expect((await readProviderOperations(executionId)).length, 'exactly ONE durable provider operation (ONE ledger row — the row IS the operation)').toBe(1);
    expect(stats.completeTrueCount, 'exactly ONE authoritative outcome write committed (T2\'s — the fenced completion)').toBe(1);
    expect(stats.completeFalseCount, 'T1\'s already-started dispatch outcome was DISCARDED (0 rows — no second authoritative outcome write)').toBe(1);
    expect(stats.beginCount, 'the gate was crossed by BOTH actors (T1 opened it; T2 took it over — the monotonic take-over arm)').toBe(2);
    const gateAfter = await readDispatchGate(executionId);
    expect(gateAfter.dispatchKey, 'the DURABLE dispatch idempotency key recorded atomically with the gate-open EQUALS the ledger operation key (the same logical operation identity)').toBe(t1Keys[0]);

    // T2's authoritative outcome is INTACT — T1's late completion wrote
    // NOTHING (the package + expiresAt are byte-identical to T2's — both
    // actors observed the SAME converged operation result).
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
  // R6-#3 (updated by round 7 — the provider-level keyed convergence; round 8
  // adds provider-instance separation: T2's native dispatch now runs through
  // a FRESH NativeExecutionProvider instance on the SECOND client, so T1's
  // resumed keyed submit converging at its OWN instance's pre-check proves
  // the authority is the DURABLE RUN ROW, not shared instance state). The
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

  // =========================================================================
  // R8-#1 (round 8, updated by round 9 — the architect's EXACT required
  // regression, the external arm): PROVIDER-INSTANCE + PROCESS LOSS around
  // the keyed provider operation. The round-8 review's blocking scenario:
  //
  //     T1    submit(K) → provider operation starts → provider process dies
  //     T2    reclaim handoff → new provider instance → submit(K) →
  //           [round 7: the Map is empty → SECOND provider operation]
  //
  // The round-8 correction made the registry the DURABLE PROVIDER-OPERATION
  // LEDGER; the ROUND-9 correction completes the takeover protocol (the
  // operation identity is ATTACHED BEFORE the body, so the recovery RESOLVES
  // BY IDENTITY — never a body re-run):
  //
  //   T1 claims (epoch N) → T1 crosses the dispatch gate → T1's submit OPENED
  //   the ONE ledger row under the handoff-derived key (PENDING, generation 1)
  //   → T1 ATTACHED the operation identity (provider_operation_handle) → T1's
  //   process DIES inside the operation body (the drive never returns — the
  //   gate stays in_flight at T1's epoch, heartbeat dead) → the lease expires
  //   → T2 reclaims (epoch N+1) + takes over the in-flight gate + re-dispatches
  //   through a FRESH provider instance (T2's, on the SECOND client) → T2's
  //   same-key submit finds the PENDING row → its resolution window elapses
  //   (the dead driver will never resolve it) → T2 TAKES OVER the drive of the
  //   SAME row (generation 2 — the NEW FENCING TOKEN; T1's generation 1 is
  //   now structurally incapable of resolving the operation) → the RECORDED
  //   identity means the operation was STARTED: B RESOLVES IT BY IDENTITY
  //   (resolveOperation — ZERO body re-runs) → the generation-fenced
  //   resolution CAS stores the ONE result → T2's completeFencedDispatch
  //   commits the ONE authoritative outcome → the obligation discharges → a
  //   THIRD fresh instance's same-key submit REPLAYS the stored result (ZERO
  //   drives, ZERO resolves) → the DEAD driver's late completion (released at
  //   the end) hits the GENERATION-FENCED resolution CAS → 0 rows (its
  //   generation 1 is STALE) → it REPLAYS the winner's stored result → its
  //   completeFencedDispatch is fenced out (0 rows).
  //
  // THE ROUND-8/9 INVARIANT: ONE durable provider operation (ONE ledger row —
  // the row T1 OPENED, resolved BY IDENTITY by T2's recovery) for the whole
  // interleaving, ONE stored result, ONE body run (T1's — the recovery NEVER
  // re-runs the operation body), ONE authoritative outcome write; the same
  // key resolves to the SAME operation through every instance.
  // =========================================================================
  it('R8-#1 (round 10). PROVIDER-INSTANCE + PROCESS LOSS — instance A submits operation K (the provider CONFIRMS it; the row is STARTED @ generation 1) + dies mid-resolution; instance B (T2, second client) TAKES OVER (generation 2 — the fencing token) + RESOLVES THE CONFIRMED OPERATION BY ITS RECORDED IDENTITY (ZERO re-submissions); instance C replays the stored result with ZERO submissions; the dead driver\'s late failure hits the generation-fenced CAS (0 rows) + is fenced out', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat, dispatching through
    // provider INSTANCE A (client 1) whose drive parks INSIDE THE RESOLUTION
    // (round 10: after the IDEMPOTENT-BY-KEY submission + the attach — the
    // row is 'started' @ generation 1) and is NOT released until the very
    // end of the test — T1's "process" is DEAD from the system's perspective
    // (its resolution will never complete on its own; the heartbeat is dead;
    // the lease expires).
    let killDeadDriver!: (reason: Error) => void;
    const deathGate = new Promise<void>((_, reject) => { killDeadDriver = reject; });
    const providerA = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
      logger: stack.db.logger,
      parkAtResolve: deathGate,
    });
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: providerA,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r8-process-loss-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is DEAD-inside-the-operation (the ledger row is 'started'
    // @ generation 1 — the provider CONFIRMED the operation; the resolution
    // is parked forever), then let the 150ms lease expire (no heartbeat
    // renews).
    await waitFor(() => providerA.inResolve, 5000);
    await delay(300);
    const rowsAtDeath = await readProviderOperations(executionId);
    expect(rowsAtDeath.length, 'instance A OPENED exactly ONE durable provider-operation ledger row before dying').toBe(1);
    expect(rowsAtDeath[0]!.state, 'the operation A submitted is CONFIRMED + IN FLIGHT (STARTED — the provider returned its identity; the outcome is UNCERTAIN at A\'s death)').toBe('started');
    expect(rowsAtDeath[0]!.generation, 'the row is at generation 1 (A\'s original drive)').toBe(1);
    expect(rowsAtDeath[0]!.handle, 'PR #46 round 10: the PROVIDER-CONFIRMED identity is recorded (the attach ran AFTER the submission returned it) — the recovery will RESOLVE BY IDENTITY, never re-submit').not.toBeNull();
    expect(providerA.submissionCount, 'A submitted the operation exactly once (the idempotent submission)').toBe(1);
    expect(providerA.resolveCount, 'A is parked/dead INSIDE its ONE resolution').toBe(1);
    expect(providerA.driveCount, 'the KEYED path NEVER runs the unkeyed body seam').toBe(0);

    // T2 (the boot sweep) reclaims the expired lease (epoch N+1) → crash
    // window #2 → T2's re-dispatch takes over the in-flight gate + submits
    // through a FRESH provider instance (B) on the SECOND client with a SHORT
    // resolution window (150ms — the dead driver will never resolve the row).
    // B's same-key submit finds the STARTED row, the window elapses, and B
    // TAKES OVER the drive of the SAME row (generation 2 — the NEW FENCING
    // TOKEN: A's generation 1 is now structurally incapable of resolving the
    // operation). The row is 'started' — the provider CONFIRMED the operation
    // — so B's recovery RESOLVES IT BY IDENTITY (resolveOperation — the
    // round-10 protocol: ZERO re-submissions) + the generation-fenced CAS
    // stores the ONE result. T2 then completes the ONE authoritative outcome
    // through the fence + the obligation discharges.
    const providerB = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(second!.client),
      logger: stack.db.logger,
      operationResolutionWindowMs: 150,
      operationPollIntervalMs: 10,
    });
    const t2Service = buildT2Service({ stats, externalProvider: providerB });
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed the expired lease, took over the in-flight gate, resolved THE SAME durable operation (the recovery drive), + completed the handoff').toBe('complete');

    // THE ROUND-8/9 INVARIANT: still ONE durable provider operation (ONE
    // ledger row — the row instance A OPENED; B's recovery resolved THE SAME
    // row BY ITS RECORDED IDENTITY, generation 2: the take-over's fencing
    // token, never a second operation record). B's submit observed the row's
    // stored result.
    const rowsAfterRecovery = await readProviderOperations(executionId);
    expect(rowsAfterRecovery.length, 'ONE durable provider operation (ONE ledger row) — instance B resolved THE SAME operation instance A opened (NO second operation)').toBe(1);
    expect(rowsAfterRecovery[0]!.state, 'the ONE operation COMPLETED (B\'s recovery resolved it by identity through the generation-fenced CAS)').toBe('completed');
    expect(rowsAfterRecovery[0]!.generation, 'generation 2 — the take-over\'s fencing token on the SAME row (A\'s original drive + B\'s resolve-by-identity recovery of ONE operation)').toBe(2);
    expect(rowsAfterRecovery[0]!.handle, 'the operation identity is UNCHANGED (A\'s attach — the ONE operation\'s durable provider-side identity)').toBe(rowsAtDeath[0]!.handle);
    expect(rowsAfterRecovery[0]!.submissionJson, 'the ONE operation\'s result is durably stored').not.toBeNull();
    expect(providerB.submissionCount, 'B performed ZERO re-submissions — the recovery RESOLVED BY IDENTITY (the round-10 protocol: a CONFIRMED operation is NEVER re-submitted)').toBe(0);
    expect(providerB.resolveCount, 'B resolved the CONFIRMED operation by its recorded identity exactly once').toBe(1);
    expect(providerA.submissionCount, 'A\'s dead resolution is STILL parked (it never resolved on its own)').toBe(1);
    expect(stats.completeTrueCount, 'exactly ONE authoritative outcome write (T2\'s — through the fenced completion)').toBe(1);

    // T2's authoritative outcome + the discharged obligation.
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(afterT2!.packageValue, 'T2\'s outcome holds the ONE operation\'s stored package').not.toBeNull();
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
    const gateAfter = await readDispatchGate(executionId);
    expect(gateAfter.dispatchState, 'the dispatch gate is COMPLETED (at T2\'s epoch)').toBe('completed');
    expect(gateAfter.dispatchKey, 'the durable dispatch key EQUALS the ledger operation key').toBe(rowsAfterRecovery[0]!.idempotencyKey);
    expect(gateAfter.dispatchKey, 'the key is the handoff-derived dispatch key').toMatch(/^cross-mode-dispatch-/);

    // A THIRD provider instance (C — another FRESH instance): the same key
    // resolves to the SAME stored operation — a PURE REPLAY (ZERO
    // submissions, ZERO resolutions, ZERO drives). This is the "same key
    // always resolves to the same operation" proof across yet another
    // instance boundary.
    const providerC = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
      logger: stack.db.logger,
    });
    const recordForTask = await executionRecordRepo.findByExecutionId(executionId);
    const builtTask = await executionTaskService.build({
      workItemId: recordForTask!.workItemId,
      mode: 'external',
      provider: recordForTask!.provider,
      model: recordForTask!.model,
      executionId,
      implementationContextId: recordForTask!.implementationContextId,
    });
    const replaySubmission = await providerC.submit({
      ...builtTask.task,
      dispatchIdempotencyKey: gateAfter.dispatchKey!,
    });
    expect(providerC.submitCount, 'instance C submitted once').toBe(1);
    expect(providerC.submissionCount, 'instance C performed ZERO submissions — the same key REPLAYED the SAME stored operation (convergence through the DURABLE ledger, not any instance\'s memory)').toBe(0);
    expect(providerC.resolveCount, 'instance C performed ZERO resolves — a terminal row is a pure REPLAY').toBe(0);
    expect(providerC.driveCount, 'the KEYED path NEVER runs the unkeyed body seam').toBe(0);
    const storedSubmission = JSON.parse(rowsAfterRecovery[0]!.submissionJson!) as {
      package: Record<string, unknown>;
      expiresAt: string;
    };
    expect(replaySubmission.package, 'the replayed submission is the STORED operation result (byte-identical package)').toEqual(storedSubmission.package);
    expect(replaySubmission.expiresAt?.toISOString(), 'the replayed expiry is the STORED operation result\'s expiry').toBe(storedSubmission.expiresAt);

    // The DEAD driver's LATE failure (A's parked resolution finally fails —
    // the dead process's in-flight call): A's resolution threw, and its
    // GENERATION-FENCED failure CAS hit 0 rows (A's generation 1 is STALE —
    // the take-over moved the row to generation 2, so A's failure is
    // STRUCTURALLY INCAPABLE of resolving the operation) — the provider's
    // convergence check then returns the STORED result (the row is the
    // authority — A's local failure is irrelevant to the operation's recorded
    // outcome) → A's completeFencedDispatch evaluates the fence → 0 rows (the
    // lease is T2's + the obligation is discharged) → ROLLBACK — NO outcome
    // write → T1 aborts 'claim-fence-lost'. NO second result, NO second
    // operation.
    killDeadDriver(new Error('simulated process death — the dead driver\'s in-flight resolution failed'));
    await t1Promise;
    expect(t1Error, 'T1 (the dead driver, late) FAILED with the fence-lost error (its converged completion was discarded)').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'the dead driver\'s late completion was fenced out (NO second authoritative write)').toBe('claim-fence-lost');
    expect(stats.completeFalseCount, 'the dead driver\'s late completion affected 0 rows + was DISCARDED').toBe(1);
    expect(providerA.submissionCount, 'still exactly ONE submission on instance A (the operation was NOT re-submitted)').toBe(1);
    expect(providerA.resolveCount, 'the dead driver\'s ONE resolution failed (it is the ONLY resolution it ever ran)').toBe(1);

    // FINAL: still ONE ledger row, COMPLETED, with the ONE stored result —
    // byte-identical to before the dead driver's late completion (the late
    // completion changed NOTHING).
    const rowsFinal = await readProviderOperations(executionId);
    expect(rowsFinal.length, 'FINAL: exactly ONE durable provider operation for the whole interleaving').toBe(1);
    expect(rowsFinal[0]!.state).toBe('completed');
    expect(rowsFinal[0]!.generation).toBe(2);
    expect(rowsFinal[0]!.submissionJson, 'the ONE stored result is UNCHANGED by the dead driver\'s late completion').toBe(rowsAfterRecovery[0]!.submissionJson);
    const afterT1 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT1!.packageValue, 'T2\'s authoritative package is INTACT (the dead driver\'s late completion wrote NOTHING)').toEqual(afterT2!.packageValue);
    expect(afterT1!.status).toBe('handoff_ready');
    // Exactly ONE session transition (T1's pre-dispatch interrupt — T2's
    // reconcile found it converged + skipped).
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions').toBe(1);
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');
  });

  // =========================================================================
  // R8-#2 (round 8 — the native arm: the EXPLICIT DEFINITION + the
  // run-creation crash boundary). The round-8 review accepts the native
  // convergence keyed on the execution identity + the AgentRun UNIQUE "only
  // if we explicitly define the AgentRun as the durable native
  // provider-operation ledger and prove the remaining crash boundary,
  // particularly process loss around run creation / adapter invocation".
  //
  // The definition (declared in execution.types.ts + the native provider +
  // migration 0048's header): wfos_agent_runs (migration 0011,
  // `execution_id TEXT NOT NULL UNIQUE`) IS the durable native
  // provider-operation ledger — the run row IS the native provider operation
  // (the run creation + the adapter execution the gateway performs only
  // AFTER its own run-creation succeeded), the execution_id UNIQUE IS the
  // operation-key uniqueness, and the run's status/refs ARE the operation
  // result. The crash boundary proof:
  //
  //   T1 claims (epoch N) → T1 crosses the dispatch gate → T1's keyed submit
  //   reaches the gateway → the gateway CREATES the ONE AgentRun (the durable
  //   operation record — committed through the REAL PgAgentRunRepository) →
  //   T1's process DIES between the run-creation commit and the adapter
  //   invocation (the gateway call never returns; the adapter is NEVER
  //   invoked) → the lease expires → T2 reclaims (epoch N+1) through a FRESH
  //   NativeExecutionProvider instance on the SECOND client → the reconcile
  //   finds the EXISTING run (the durable ledger — the operation ALREADY
  //   owns its record) and CONVERGES: ZERO provider operations from T2 (no
  //   gateway call, no adapter invocation) → the obligation discharges (the
  //   run IS the authoritative native outcome — handoffComplete's
  //   existing-run rule) → a THIRD fresh native instance's keyed submit
  //   converges at the provider pre-check onto the SAME run (NO gateway
  //   call) → T1's dead gateway call eventually fails (released at the end)
  //   → the provider's collision-recovery CONVERGES to the existing run →
  //   T1's completeFencedDispatch is fenced out (0 rows).
  //
  // THE ROUND-8 NATIVE INVARIANT: exactly ONE AgentRun (ONE durable native
  // provider operation), ZERO adapter invocations from ANY actor (the crash
  // happened before T1's adapter invocation; T2 and the third instance never
  // reached the gateway), ONE discharged obligation.
  // =========================================================================
  it('R8-#2. the native durable provider-operation ledger (wfos_agent_runs) — process loss BETWEEN run creation + adapter invocation: a FRESH native instance (T2, second client) converges on the ONE run with ZERO provider operations; a THIRD fresh instance converges at the provider pre-check; the dead driver\'s late gateway failure converges + is fenced out', async () => {
    const { executionId, recordId } = await createExternalRecord();
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat, dispatching through
    // a NATIVE provider whose gateway DIES right after the run creation —
    // the crash window BETWEEN the run-creation commit and the adapter
    // invocation (the deepest run-creation crash point: the durable operation
    // record EXISTS, the side-effecting adapter never ran).
    let killDeadGateway!: (reason: Error) => void;
    const deathGate = new Promise<never>((_, reject) => { killDeadGateway = reject; });
    const crashGateway = new CrashAfterRunCreationGateway(agentRunRepo, deathGate);
    // PR #46 round 10: a SHORT existing-run await window — the crashGateway's
    // run is STUCK non-terminal forever (its driver died), so T1's late
    // collision-recovery convergence must FAIL CLOSED fast (the typed
    // unresolved error), never manufacture a completed submission.
    const t1NativeProvider = new NativeExecutionProvider({
      agentGateway: crashGateway,
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
      existingRunResolutionWindowMs: 150,
      existingRunPollIntervalMs: 10,
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
          { targetMode: 'native', idempotencyKey: `r8-native-run-creation-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is dead-inside-the-gateway-call (the ONE AgentRun row is
    // DURABLY created; the adapter was never invoked), then let the 150ms
    // lease expire (no heartbeat renews).
    await waitFor(() => crashGateway.runCreated, 5000);
    await delay(300);
    expect(await countAgentRuns(executionId), 'the ONE AgentRun exists (the durable native provider-operation record — created before the crash)').toBe(1);
    expect(fakeAgent.getCallCount(), 'the adapter was NEVER invoked (the crash happened between the run creation + the adapter invocation)').toBe(0);

    // T2 (the boot sweep) reclaims the expired lease (epoch N+1) through a
    // FRESH NativeExecutionProvider instance on the SECOND client → crash
    // window #2 (record.mode === native, the AgentRun EXISTS) → the
    // reconcile's existing-run check finds the durable operation record +
    // CONVERGES WITHOUT ANY PROVIDER OPERATION (no gateway call, no adapter
    // invocation — T2 is PREVENTED from starting a second operation) → the
    // obligation discharges (the run IS the authoritative native outcome).
    const t2Service = buildT2Service({ stats });
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed the expired lease + converged on the EXISTING run (ZERO provider operations from the fresh instance) + discharged').toBe('complete');

    // THE ROUND-8 NATIVE INVARIANT: still ONE run (the durable operation T1
    // opened); ZERO adapter invocations from ANY actor; T2 never reached the
    // gateway (it converged at the reconcile's existing-run check).
    expect(await countAgentRuns(executionId), 'still exactly ONE AgentRun (ONE durable native provider operation — no second was ever started)').toBe(1);
    expect(fakeAgent.getCallCount(), 'ZERO adapter invocations from ANY actor (T1 died before its invocation; T2 + the third instance below converge without the gateway)').toBe(0);
    expect(stats.beginCount, 'only T1 crossed the dispatch gate (T2 converged at the reconcile level — ZERO provider operations)').toBe(1);
    expect(stats.completeTrueCount, 'no authoritative outcome write from T2 (the run IS the outcome — handoffComplete\'s existing-run rule)').toBe(0);
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);

    // A THIRD actor — ANOTHER fresh NativeExecutionProvider instance whose
    // KEYED submit hits the provider pre-check: the run EXISTS (the durable
    // ledger) but is STUCK NON-TERMINAL forever (its driver died before the
    // adapter invocation; nothing will ever finalize it). PR #46 round 10 —
    // EXISTING ≠ COMPLETED: the keyed submit must NEVER manufacture a
    // completed submission from the mere existence of the ledger row. The
    // convergence AWAITS the run until terminal (a SHORT window here — the
    // run is stuck forever) and FAILS CLOSED with the typed unresolved error:
    // no gateway call, no adapter invocation, no second run — the
    // execution_id UNIQUE is the ledger authority.
    const countingGatewayC = new CountingGateway(
      new DefaultAgentGateway(stack.db.client, stack.db.logger, [fakeAgent], 3),
    );
    const providerC = new NativeExecutionProvider({
      agentGateway: countingGatewayC,
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
      existingRunResolutionWindowMs: 150,
      existingRunPollIntervalMs: 10,
    });
    const recordForTask = await executionRecordRepo.findByExecutionId(executionId);
    const builtTask = await executionTaskService.build({
      workItemId: recordForTask!.workItemId,
      mode: 'native',
      provider: 'fake',
      model: 'test-model',
      executionId,
      implementationContextId: recordForTask!.implementationContextId,
    });
    const gateState = await readDispatchGate(executionId);
    const stuckRun = await agentRunRepo.findByExecutionId(executionId);
    expect(stuckRun, 'the ONE stuck run exists (non-terminal — its driver died)').not.toBeNull();
    expect(['pending', 'in_progress'], 'the existing run is NON-TERMINAL (round 10: the crash left it stuck forever)').toContain(stuckRun!.status);
    await expect(
      providerC.submit({ ...builtTask.task, dispatchIdempotencyKey: gateState.dispatchKey! }),
      'PR #46 round 10 — EXISTING ≠ COMPLETED: a keyed submit on a stuck NON-TERMINAL run FAILS CLOSED with the typed unresolved error (NEVER a manufactured completed submission, NEVER a second run)',
    ).rejects.toThrow(/native-execution-existing-run-unresolved/);
    const theRun = await agentRunRepo.findByExecutionId(executionId);
    expect(theRun, 'the ONE run exists').not.toBeNull();
    expect(theRun!.id, 'still the SAME ONE run (the stuck run was never replaced — the UNIQUE is the ledger authority)').toBe(stuckRun!.id);
    expect(countingGatewayC.executeCount, 'the third instance NEVER reached the gateway (it awaited the existing run at the pre-check, then failed closed)').toBe(0);
    expect(fakeAgent.getCallCount(), 'still ZERO adapter invocations').toBe(0);
    expect(await countAgentRuns(executionId), 'still exactly ONE AgentRun').toBe(1);

    // The DEAD driver's LATE gateway failure (T1's dead in-flight call
    // finally fails — released at the end): the provider's
    // collision-recovery re-check finds the EXISTING run — which is STUCK
    // NON-TERMINAL. PR #46 round 10: the convergence AWAITS it (T1's SHORT
    // window), the window elapses (the run is orphaned — nothing will ever
    // finalize it), and the provider FAILS CLOSED with the typed unresolved
    // error instead of manufacturing a completion → the dispatch failure
    // handler sees a NON-TERMINAL existing run + performs NO OUTCOME WRITE OF
    // EITHER POLARITY (a 'completed' write would be a manufactured success;
    // a 'failed' write would clobber a run that may still resolve) → T1
    // surfaces 'handoff-dispatch-failed' (an honest failure — the obligation
    // was already discharged by T2's reconcile; the run lifecycle owns the
    // execution from here). NO second operation, NO outcome write AT ALL.
    killDeadGateway(new Error('simulated process death — the dead driver\'s in-flight gateway call failed'));
    await t1Promise;
    expect(t1Error, 'T1 (the dead driver, late) FAILED honestly: the stuck non-terminal run cannot be converged').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'the dead driver\'s late dispatch failed on the unresolved run (NO manufactured completion, NO outcome write of either polarity)').toBe('handoff-dispatch-failed');
    expect((t1Error as CrossModeHandoffError).message, 'the failure names the non-terminal run (fail closed, never a fake outcome)').toContain('non-terminal');
    expect(stats.completeFalseCount, 'the dead driver\'s late dispatch performed NO fenced completion at all (the non-terminal run wrote NOTHING)').toBe(0);

    // FINAL: ONE run, ZERO adapter invocations, the record NOT clobbered (the
    // run lifecycle owns the execution from here — a stuck run is the
    // gateway\'s own lifecycle concern, out of WORK-042's dispatch scope),
    // the durable dispatch key recorded.
    expect(await countAgentRuns(executionId), 'FINAL: exactly ONE AgentRun (ONE durable native provider operation for the whole interleaving)').toBe(1);
    expect(fakeAgent.getCallCount(), 'FINAL: ZERO adapter invocations ever (the crash preceded T1\'s invocation; every later actor converged)').toBe(0);
    const afterT1 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT1!.id).toBe(recordId);
    expect(afterT1!.mode).toBe('native');
    expect(afterT1!.status, 'T1\'s late completion wrote NOTHING (no clobber — the fence discarded it; the run row IS the authoritative native outcome)').toBe('running');
    const gateAfter = await readDispatchGate(executionId);
    expect(gateAfter.dispatchKey, 'the DURABLE dispatch idempotency key is recorded on the obligation row (migration 0047)').toMatch(/^cross-mode-dispatch-/);
  });

  // =========================================================================
  // R9-#1 (round 9 — the review's adversarial interleaving #1): takeover →
  // STALE-GENERATION FAIL → NEW-GENERATION SUCCESS. The round-8 blocking
  // race: fail() was NOT fenced by generation, so a stale driver's failure
  // could resolve the row after a take-over and DEFEAT the recovery
  // generation's success:
  //
  //     T1 generation 1 = pending (T1 still running)
  //     T2 takes over                → generation 2, T2 drives
  //     T1 fails    [round 8]        → fail(K) won on state='pending'
  //                                   → generation 2 / failed  ← T1 DEFEATED T2
  //     T2 succeeds  [round 8]       → complete(K) lost the CAS → result LOST
  //
  // The round-9 generation fence makes the stale failure STRUCTURALLY
  // INCAPABLE of resolving the operation:
  //
  //   T1 claims (epoch N) → T1's submit OPENED the ONE ledger row (generation
  //   1) + ATTACHED the operation identity + parks mid-body → the lease
  //   expires → T2 reclaims + re-dispatches through a FRESH provider instance
  //   (B, second client) → B's await window elapses → B TAKES OVER
  //   (generation 2 — the fencing token) → the RECORDED identity means the
  //   operation started: B parks INSIDE its resolve-by-identity recovery →
  //   T1's dead drive FAILS: fail(key, generation 1) hits the generation
  //   fence → 0 ROWS (the row is STILL pending — the stale failure was
  //   discarded) → B's recovery SUCCEEDS: complete(key, generation 2, result)
  //   stores the ONE result → T2 commits the ONE authoritative outcome →
  //   T1's late convergence replays the winner's stored result → fenced out.
  //
  // THE ROUND-9 INVARIANT: exactly ONE generation resolves authoritatively —
  // the stale generation's FAILURE can never defeat the recovery generation's
  // SUCCESS (error_message stays NULL; the row completes with T2's result).
  // =========================================================================
  it('R10-#4. takeover → stale-generation FAIL → new-generation SUCCESS — the stale driver\'s generation-fenced fail CAS hits 0 rows (the row STAYS started; the stored error is NEVER written) + the recovery generation\'s success resolves authoritatively', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat. Its provider instance
    // (A) parks INSIDE the RESOLUTION (round 10: the idempotent submission
    // ran + the attach CAS marked the row 'started' @ generation 1 — the
    // provider CONFIRMED the operation) and holds a LONG resolution window
    // (10s) so A, after its stale CAS rejections, stays in the AWAIT
    // convergence loop (it must NOT take over again during the test — the
    // recovery generation owns the row).
    let killDeadDriver!: (reason: Error) => void;
    const deathGate = new Promise<void>((_, reject) => { killDeadDriver = reject; });
    const providerA = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
      logger: stack.db.logger,
      parkAtResolve: deathGate,
      operationResolutionWindowMs: 10_000,
      operationPollIntervalMs: 10,
    });
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: providerA,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r9-stale-fail-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is parked mid-resolution (the row is 'started' @
    // generation 1 — the provider CONFIRMED the operation; the resolution
    // CAS has not run), then let the 150ms lease expire.
    await waitFor(() => providerA.inResolve, 5000);
    await delay(300);
    const rowsAtStall = await readProviderOperations(executionId);
    expect(rowsAtStall.length).toBe(1);
    expect(rowsAtStall[0]!.state, 'the operation is CONFIRMED + unresolved (the row is STARTED @ generation 1)').toBe('started');
    expect(rowsAtStall[0]!.generation).toBe(1);
    expect(rowsAtStall[0]!.handle, 'the PROVIDER-CONFIRMED identity is recorded (the recovery will resolve by identity)').not.toBeNull();
    expect(providerA.submissionCount).toBe(1);
    expect(providerA.driveCount, 'the KEYED path never runs the unkeyed body seam').toBe(0);

    // T2: a FRESH provider instance (B, second client) with a SHORT window
    // (150ms — the dead driver will never resolve). B's recovery parks INSIDE
    // resolveOperation (the parkAtResolve seam): B has TAKEN OVER (generation
    // 2 — the fencing token) and is mid-resolution when T1's stale failure
    // lands.
    let releaseResolve!: () => void;
    const resolveGate = new Promise<void>((r) => { releaseResolve = r; });
    const providerB = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(second!.client),
      logger: stack.db.logger,
      operationResolutionWindowMs: 150,
      operationPollIntervalMs: 10,
      parkAtResolve: resolveGate,
      resolutionMarker: 'resolved-by-generation-2',
    });
    const t2Service = buildT2Service({ stats, externalProvider: providerB });
    let t2Result: { stage?: string } | undefined;
    const t2Promise = (async () => {
      t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    })();
    await waitFor(() => providerB.inResolve, 5000);

    // MID-TAKEOVER: B owns generation 2 (the fencing token); B NEVER
    // re-submitted — it is INSIDE the resolve-by-identity recovery (the row
    // was 'started': the provider had CONFIRMED the operation).
    const rowsMidTakeover = await readProviderOperations(executionId);
    expect(rowsMidTakeover.length).toBe(1);
    expect(rowsMidTakeover[0]!.state, 'the operation is still unresolved (B is mid-recovery — the row STAYS started through the take-over)').toBe('started');
    expect(rowsMidTakeover[0]!.generation, 'generation 2 — B\'s take-over fencing token (T1\'s generation 1 is now structurally incapable of resolving the operation)').toBe(2);
    expect(providerB.submissionCount, 'B performed ZERO re-submissions — the recovery RESOLVES BY IDENTITY (a CONFIRMED operation is NEVER re-submitted)').toBe(0);
    expect(providerB.resolveCount, 'B is INSIDE its one resolve-by-identity recovery').toBe(1);

    // THE STALE FAIL — the review's exact interleaving: T1's dead resolution
    // fails while generation 2 owns the row. The GENERATION-FENCED fail CAS
    // (state IN ('pending','started') AND generation=1) hits 0 rows: the
    // stale failure is STRUCTURALLY DISCARDED (round 8 would have flipped
    // the row to failed and DEFEATED the recovery generation).
    killDeadDriver(new Error('simulated process death — the stale generation 1 driver failed'));
    await delay(200);
    const rowsAfterStaleFail = await readProviderOperations(executionId);
    expect(rowsAfterStaleFail.length).toBe(1);
    expect(rowsAfterStaleFail[0]!.state, 'THE ROUND-9/10 FENCE: the stale generation\'s failure hit 0 rows — the row is STILL started (the stale failure cannot defeat the recovery generation)').toBe('started');
    expect(rowsAfterStaleFail[0]!.generation).toBe(2);
    expect(rowsAfterStaleFail[0]!.errorMessage, 'the stale failure was NEVER stored (round 8 would have written it and destroyed the recovery)').toBeNull();

    // THE RECOVERY SUCCESS: B's resolve-by-identity returns the outcome + the
    // generation-2 CAS stores the ONE result.
    releaseResolve();
    await t2Promise;
    expect(t2Result!.stage, 'T2 reclaimed, took over (generation 2), resolved by identity, + completed the handoff').toBe('complete');
    expect(providerB.submissionCount, 'still ZERO re-submissions on B (the recovery never re-submitted the CONFIRMED operation)').toBe(0);
    expect(providerB.resolveCount).toBe(1);
    expect(stats.completeTrueCount, 'exactly ONE authoritative outcome write (T2\'s)').toBe(1);

    // T1's late tail: its stale fail was discarded; its convergence loop
    // awaits the row's resolution + REPLAYS the winner's stored result → its
    // completeFencedDispatch is fenced out.
    await t1Promise;
    expect(t1Error, 'T1 (the stale driver, late) aborted with the fence-lost error').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code).toBe('claim-fence-lost');
    expect(stats.completeFalseCount, 'the stale driver\'s late completion was fenced out').toBe(1);

    // FINAL: ONE row, COMPLETED at generation 2 with the recovery
    // generation's result — the stale failure never touched the outcome.
    const rowsFinal = await readProviderOperations(executionId);
    expect(rowsFinal.length).toBe(1);
    expect(rowsFinal[0]!.state, 'the ONE operation COMPLETED (the recovery generation resolved it)').toBe('completed');
    expect(rowsFinal[0]!.generation).toBe(2);
    expect(rowsFinal[0]!.errorMessage, 'FINAL: the stored error was NEVER written — the stale failure was structurally discarded for the whole interleaving').toBeNull();
    expect(rowsFinal[0]!.submissionJson, 'the stored result is the RECOVERY generation\'s resolution (the marker)').toContain('resolved-by-generation-2');
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions').toBe(1);
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
  });

  // =========================================================================
  // R9-#2 (round 9 — the review's adversarial interleaving #2): takeover →
  // OLD-GENERATION SUCCESS → NEW-GENERATION SUCCESS. The round-8 inverse
  // race: complete() had no generation fence, so the OLD driver's success
  // could win merely because it happened to win the CAS race after a
  // take-over — the database accepted the superseded driver's result.
  //
  //   T1 generation 1 pending mid-body → T2 TAKES OVER (generation 2) →
  //   T1's body SUCCEEDS: complete(key, generation 1, resultA) → the
  //   GENERATION FENCE rejects it (0 rows — the old generation cannot alter
  //   the winner) → T2's recovery resolves: complete(key, generation 2,
  //   resultB) → stored. FINAL: the ONE stored result is resultB (the
  //   marked recovery resolution); resultA was NEVER stored.
  //
  // THE ROUND-9 INVARIANT: exactly one generation may resolve authoritatively
  // — stale generations cannot alter the winner, for a success AND for a
  // failure alike.
  // =========================================================================
  it('R10-#5. takeover → old-generation SUCCESS → new-generation SUCCESS — the stale driver\'s generation-fenced complete CAS hits 0 rows (its result is NEVER stored) + the recovery generation\'s result is the ONE authoritative outcome', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // T1: parked mid-resolution (round 10: the row is 'started' @ generation
    // 1 — the provider CONFIRMED the operation); a LONG resolution window so
    // its post-rejection convergence loop stays AWAITING.
    let resolveA!: () => void;
    const aParkGate = new Promise<void>((r) => { resolveA = r; });
    const providerA = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
      logger: stack.db.logger,
      parkAtResolve: aParkGate,
      operationResolutionWindowMs: 10_000,
      operationPollIntervalMs: 10,
    });
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: providerA,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r9-stale-success-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    await waitFor(() => providerA.inResolve, 5000);
    await delay(300);

    // T2: takes over (generation 2) + parks INSIDE its resolve-by-identity
    // recovery (the marked resolution — the proof of WHICH generation's
    // result was stored).
    let releaseResolve!: () => void;
    const resolveGate = new Promise<void>((r) => { releaseResolve = r; });
    const providerB = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(second!.client),
      logger: stack.db.logger,
      operationResolutionWindowMs: 150,
      operationPollIntervalMs: 10,
      parkAtResolve: resolveGate,
      resolutionMarker: 'resolved-by-generation-2',
    });
    const t2Service = buildT2Service({ stats, externalProvider: providerB });
    let t2Result: { stage?: string } | undefined;
    const t2Promise = (async () => {
      t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    })();
    await waitFor(() => providerB.inResolve, 5000);
    const rowsMidTakeover = await readProviderOperations(executionId);
    expect(rowsMidTakeover.length).toBe(1);
    expect(rowsMidTakeover[0]!.state, 'the row STAYS started through the take-over (the outcome is still unresolved)').toBe('started');
    expect(rowsMidTakeover[0]!.generation).toBe(2);

    // THE STALE SUCCESS — the review's exact inverse interleaving: T1's
    // parked resolution COMPLETES after the take-over. Its generation-fenced
    // complete CAS (state='started' AND generation=1) hits 0 rows: the old
    // generation's result is structurally DISCARDED (round 8 would have
    // accepted it merely because it won the race to the unfenced CAS).
    resolveA();
    await delay(200);
    const rowsAfterStaleSuccess = await readProviderOperations(executionId);
    expect(rowsAfterStaleSuccess.length).toBe(1);
    expect(rowsAfterStaleSuccess[0]!.state, 'THE ROUND-9/10 FENCE: the old generation\'s success hit 0 rows — the row is STILL started (the old result was not stored)').toBe('started');
    expect(rowsAfterStaleSuccess[0]!.generation).toBe(2);
    expect(rowsAfterStaleSuccess[0]!.submissionJson, 'the old generation\'s result was NEVER stored').toBeNull();
    expect(providerA.resolveCount, 'T1\'s resolution ran exactly once (its result was discarded at the CAS)').toBe(1);

    // THE RECOVERY SUCCESS: B's generation-2 resolution is stored.
    releaseResolve();
    await t2Promise;
    expect(t2Result!.stage).toBe('complete');
    expect(stats.completeTrueCount).toBe(1);

    // T1's late tail: its stale success was discarded; the convergence loop
    // replays the winner's stored result → fenced out.
    await t1Promise;
    expect(t1Error).toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code).toBe('claim-fence-lost');
    expect(stats.completeFalseCount).toBe(1);

    // FINAL: ONE row, COMPLETED at generation 2 — the stored result is the
    // RECOVERY generation's (the marker); the old generation's result never
    // touched the outcome.
    const rowsFinal = await readProviderOperations(executionId);
    expect(rowsFinal.length).toBe(1);
    expect(rowsFinal[0]!.state).toBe('completed');
    expect(rowsFinal[0]!.generation).toBe(2);
    expect(rowsFinal[0]!.submissionJson, 'the ONE stored result is the RECOVERY generation\'s resolution (the marker — the old generation\'s racing success was structurally discarded)').toContain('resolved-by-generation-2');
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions').toBe(1);
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
  });

  // =========================================================================
  // R9-#3 (round 9 — KEY IMMUTABILITY, the ledger semantics). The round-8
  // register conditionally RE-ARMED a terminally FAILED row (generation + 1,
  // back to pending), so ONE key could resolve to FAILED/result-A and later
  // COMPLETED/result-B — the key did not identify one immutable operation.
  // The round-9 semantics: a true idempotency key identifies the LOGICAL
  // OPERATION INVOCATION — COMPLETED and FAILED are BOTH terminal, register
  // NEVER re-arms, and retryability is the driver mechanics' concern (the
  // await → take-over → resolve-by-identity recovery), never a second
  // operation under the same key.
  //
  // Also the CAS-level fencing proof: a WRONG generation resolves NOTHING;
  // the takeOver-RETURNED token is the ONLY generation that can resolve a
  // pending row.
  // R9-#3 → R10-#6 (round 9 + round 10 — KEY IMMUTABILITY + the LIFECYCLE
  // CAS). The round-8 register conditionally RE-ARMED a terminally FAILED row
  // (generation + 1, back to pending), so ONE key could resolve to
  // FAILED/result-A and later COMPLETED/result-B — the key did not identify
  // one immutable operation. The round-9 semantics: a true idempotency key
  // identifies the LOGICAL OPERATION INVOCATION — COMPLETED and FAILED are
  // BOTH terminal, register NEVER re-arms, and retryability is the driver
  // mechanics' concern (the await → take-over → re-submit/resolve-by-identity
  // recovery), never a second operation under the same key.
  //
  // Round 10 adds the LIFECYCLE GATE to the CAS-level proof: complete()
  // requires state = 'started' — the database structurally cannot record a
  // terminal SUCCESS for an operation it never observed the provider confirm
  // (no silent skip of a merely-prepared operation). A WRONG generation
  // resolves NOTHING; the takeOver-RETURNED token is the ONLY generation that
  // can resolve — and even it must first pass the PROVIDER-CONFIRMED-START
  // CAS (the attach) before its completion is accepted.
  // =========================================================================
  it('R10-#6. KEY IMMUTABILITY + the LIFECYCLE CAS — COMPLETED and FAILED are BOTH terminal (register NEVER re-arms a failed row; takeOver rejects terminal rows; a later same-key submit surfaces the STORED failure with ZERO submissions) + complete REQUIRES started (a never-started row cannot record a terminal success) + the generation fencing (only the takeOver-returned token resolves)', async () => {
    const { executionId } = await createNativeRecord('failed');
    const store = new PgExecutionProviderOperationRepository(second!.client);

    // ---------------- THE FAILED ARM ----------------
    // (Round 11: a pending row's terminal failure is the DEFINITIVE-REJECT
    // transition — store.reject — the ONLY 'pending' → 'failed' path.)
    const failedKey = `r9-immutability-failed-${executionId}`;
    const opened = await store.register({
      idempotencyKey: failedKey, provider: 'external', executionId, mode: 'external',
    });
    expect(opened.opened, 'a FRESH key OPENS the ONE row (generation 1)').toBe(true);
    await store.reject(failedKey, 1, 'terminal provider failure — the operation failed');
    const failedRow = await store.get(failedKey);
    expect(failedRow!.state).toBe('failed');
    expect(failedRow!.generation).toBe(1);
    expect(failedRow!.errorMessage).toBe('terminal provider failure — the operation failed');

    // The re-register: NO re-arm (round 8 silently flipped the row back to
    // pending at generation 2 — round 9 returns the TERMINAL row as-is).
    const reRegistered = await store.register({
      idempotencyKey: failedKey, provider: 'external', executionId, mode: 'external',
    });
    expect(reRegistered.opened, 'an EXISTING key NEVER opens (no re-arm)').toBe(false);
    expect(reRegistered.existing!.state, 'the TERMINAL failure is a KNOWN outcome — returned as-is').toBe('failed');
    expect(reRegistered.existing!.generation, 'the generation is UNCHANGED (round 8 bumped it on re-arm)').toBe(1);
    expect(reRegistered.existing!.errorMessage, 'the ONE terminal result is preserved').toBe('terminal provider failure — the operation failed');

    // takeOver REJECTS a terminal row (no recovery of a resolved operation).
    const rejectedTakeover = await store.takeOver(failedKey);
    expect(rejectedTakeover.tookOver, 'a terminally failed row is never taken over').toBe(false);
    expect(rejectedTakeover.generation).toBeNull();

    // Even the CORRECT generation cannot re-resolve a terminal row (the CAS
    // requires a non-terminal state).
    await store.reject(failedKey, 1, 'a second failure attempt on a terminal row');
    expect((await store.get(failedKey))!.errorMessage, 'the terminal result is IMMUTABLE').toBe('terminal provider failure — the operation failed');

    // The provider-level replay: a same-key submit through a FRESH instance
    // surfaces the STORED failure — ZERO submissions, ZERO resolutions, ZERO
    // drives (a terminally failed operation is a KNOWN outcome, never a new
    // operation under the same key).
    const recordForTask = await executionRecordRepo.findByExecutionId(executionId);
    const builtTask = await executionTaskService.build({
      workItemId: recordForTask!.workItemId,
      mode: 'external',
      provider: recordForTask!.provider,
      model: recordForTask!.model,
      executionId,
      implementationContextId: recordForTask!.implementationContextId,
    });
    const replayProvider = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
      logger: stack.db.logger,
    });
    await expect(
      replayProvider.submit({ ...builtTask.task, dispatchIdempotencyKey: failedKey }),
      'a same-key submit against a terminally failed operation surfaces the STORED failure',
    ).rejects.toThrow(/terminal provider failure — the operation failed/);
    expect(replayProvider.submissionCount, 'ZERO submissions — the failed key never starts a new operation').toBe(0);
    expect(replayProvider.driveCount, 'ZERO unkeyed body runs').toBe(0);
    expect(replayProvider.resolveCount, 'ZERO resolutions').toBe(0);

    // ---------------- THE COMPLETED ARM (the symmetric immutability) ----------------
    const completedKey = `r9-immutability-completed-${executionId}`;
    const openedCompleted = await store.register({
      idempotencyKey: completedKey, provider: 'external', executionId, mode: 'external',
    });
    expect(openedCompleted.opened).toBe(true);
    expect(
      await store.attachOperation(completedKey, 1, `external-package:${completedKey}`),
      'the PROVIDER-CONFIRMED-START attach CAS wins on the fresh row (pending → started)',
    ).toBe(true);
    expect((await store.get(completedKey))!.state, 'the row is STARTED (the provider confirmed the operation)').toBe('started');
    const submission: ExecutionSubmission = {
      executionId, provider: 'external', mode: 'external', status: 'handoff_ready',
      externalSessionRef: null,
    };
    expect((await store.complete(completedKey, 1, submission)).completed).toBe(true);
    const reRegisteredCompleted = await store.register({
      idempotencyKey: completedKey, provider: 'external', executionId, mode: 'external',
    });
    expect(reRegisteredCompleted.opened, 'a COMPLETED key never opens either').toBe(false);
    expect(reRegisteredCompleted.existing!.state).toBe('completed');
    expect(reRegisteredCompleted.existing!.generation, 'the generation is UNCHANGED').toBe(1);
    expect(reRegisteredCompleted.existing!.submission!.status).toBe('handoff_ready');
    expect((await store.takeOver(completedKey)).tookOver, 'a completed row is never taken over').toBe(false);
    expect(
      (await store.complete(completedKey, 1, { ...submission, externalSessionRef: 'stale-never-stored' })).completed,
      'even the SAME generation cannot re-resolve a terminal row',
    ).toBe(false);
    expect((await store.get(completedKey))!.submission!.externalSessionRef, 'the ONE terminal result is IMMUTABLE').toBeNull();

    // ---------------- THE CAS-LEVEL GENERATION FENCING + THE LIFECYCLE GATE ----------------
    const pendingKey = `r9-fencing-${executionId}`;
    await store.register({
      idempotencyKey: pendingKey, provider: 'external', executionId, mode: 'external',
    });
    await store.reject(pendingKey, 7, 'a wrong generation can NEVER resolve');
    expect((await store.get(pendingKey))!.state, 'a WRONG generation resolved NOTHING (the row stays pending)').toBe('pending');
    const takeover = await store.takeOver(pendingKey);
    expect(takeover.tookOver, 'the pending row is taken over').toBe(true);
    expect(takeover.generation, 'takeOver RETURNS the NEW GENERATION TOKEN (the fencing token)').toBe(2);
    await store.reject(pendingKey, 1, 'stale generation fail');
    expect((await store.get(pendingKey))!.state, 'the STALE generation\'s failure hit 0 rows (structurally discarded)').toBe('pending');
    expect((await store.get(pendingKey))!.errorMessage).toBeNull();
    expect((await store.complete(pendingKey, 1, submission)).completed, 'the STALE generation\'s success hit 0 rows').toBe(false);
    expect((await store.get(pendingKey))!.state, 'still pending — no generation-1 resolution possible').toBe('pending');
    // PR #46 ROUND 10 — THE LIFECYCLE GATE: even the takeOver-RETURNED token
    // CANNOT complete a NEVER-STARTED row. The row is still 'pending' (the
    // submission was never confirmed): complete() requires 'started' — the
    // database structurally cannot record a terminal SUCCESS for an
    // operation it never observed the provider confirm (no silent skip of a
    // merely-prepared operation).
    expect(
      (await store.complete(pendingKey, takeover.generation!, submission)).completed,
      'THE LIFECYCLE GATE: the CORRECT generation cannot complete a NEVER-STARTED row (complete requires started)',
    ).toBe(false);
    expect((await store.get(pendingKey))!.state, 'the row is STILL pending (no terminal success for an unconfirmed operation)').toBe('pending');
    expect((await store.get(pendingKey))!.submission, 'no terminal result for an unconfirmed operation').toBeNull();
    // The recovery must first go through the PROVIDER-CONFIRMED-START CAS
    // (the attach — the idempotent submission returned the identity), and
    // ONLY THEN can the takeOver-RETURNED token resolve the row.
    expect(
      await store.attachOperation(pendingKey, takeover.generation!, `external-package:${pendingKey}`),
      'the recovery attach CAS wins (pending → started @ the take-over generation)',
    ).toBe(true);
    expect(
      (await store.complete(pendingKey, takeover.generation!, submission)).completed,
      'the takeOver-RETURNED token resolves the STARTED row — the ONLY generation that can',
    ).toBe(true);
    expect((await store.get(pendingKey))!.state).toBe('completed');
  });

  // =========================================================================
  // R10-#3 (round 10 — matrix rows 3 + 4: after provider start / after
  // provider result). The review's "genuinely side-effecting provider" proof,
  // under the round-10 protocol: T1's IDEMPOTENT-BY-KEY submission performs
  // the REAL once-only side effect (the platform operation accepted + its
  // outcome on the shared "platform" state — the external system's durable
  // memory, which survives T1's process death) → the attach CAS records the
  // provider-confirmed identity ('pending' → 'started' @ generation 1) → T1
  // DIES mid-resolution → T2 (a FRESH instance on the SECOND client, sharing
  // ONLY the platform) takes over (generation 2) → the row is 'started': the
  // provider CONFIRMED the operation — T2 RESOLVES BY IDENTITY (a status
  // fetch on the recorded handle — NEVER a re-submission) → the
  // generation-2 CAS stores the ONE result (the platform outcome).
  //
  // THE ROUND-10 INVARIANT: the side-effecting operation ran EXACTLY ONCE
  // across the whole interleaving (submissionCount 1 + effectCount 1 FOREVER)
  // — a CONFIRMED operation is resolved by identity, never re-submitted, so
  // the provider-independence claim is PROVEN, not assumed.
  // =========================================================================
  it('R10-#3. the genuinely SIDE-EFFECTING provider — a CONFIRMED (started) operation is resolved BY ITS RECORDED IDENTITY (a status fetch) after process loss: the submission + its side effect run EXACTLY ONCE across the whole takeover + late-failure interleaving', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // The shared "platform" (the external system's durable state — the ONLY
    // thing that survives a driver's process death, exactly like a real
    // provider platform).
    const platform = new Map<string, ExecutionSubmission>();

    // T1: its provider instance (A) submits the platform operation (the SIDE
    // EFFECT happens ONCE) + attaches the provider-confirmed identity (the
    // row becomes 'started' @ generation 1) — then parks INSIDE the
    // resolution; the death gate is REJECTED at the very end of the test
    // (T1's "process" is DEAD from the system's perspective until then).
    let killDeadDriver!: (reason: Error) => void;
    const deathGate = new Promise<never>((_, reject) => { killDeadDriver = reject; });
    const providerA = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 10_000,
        operationPollIntervalMs: 10,
      },
      { parkAtResolve: deathGate },
      platform,
    );
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: providerA,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r10-side-effecting-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until the SIDE EFFECT happened (the platform operation accepted)
    // AND the row is 'started' (the attach recorded the provider-confirmed
    // identity) with T1 parked/dead INSIDE the resolution, then let the
    // lease expire.
    await waitFor(() => providerA.effectCount === 1, 5000);
    await delay(300);
    const rowsAtDeath = await readProviderOperations(executionId);
    expect(rowsAtDeath.length).toBe(1);
    expect(rowsAtDeath[0]!.state, 'the row is STARTED (the provider CONFIRMED the operation; T1 died mid-resolution)').toBe('started');
    expect(rowsAtDeath[0]!.generation).toBe(1);
    expect(rowsAtDeath[0]!.handle, 'the PLATFORM operation identity is RECORDED (the attach ran after the submission accepted it)').toMatch(/^platform-operation:/);
    expect(providerA.submissionCount, 'the side-effecting submission ran ONCE').toBe(1);
    expect(providerA.effectCount, 'the SIDE EFFECT happened exactly once').toBe(1);
    expect(providerA.resolveCount, 'T1 is parked/dead INSIDE its one resolution').toBe(1);

    // T2: a FRESH SIDE-EFFECTING instance on the SECOND client, sharing ONLY
    // the platform (the external system). Its recovery MUST NOT re-submit —
    // the row is 'started' (the provider CONFIRMED the operation), so it
    // resolves by a STATUS FETCH.
    const providerB = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(second!.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 150,
        operationPollIntervalMs: 10,
      },
      {},
      platform,
    );
    const t2Service = buildT2Service({ stats, externalProvider: providerB });
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed, took over (generation 2), + resolved the CONFIRMED operation BY IDENTITY').toBe('complete');

    // THE ROUND-10 SIDE-EFFECT INVARIANT: the submission ran EXACTLY ONCE
    // across the whole interleaving — T2 NEVER re-submitted (a status fetch
    // only).
    expect(providerA.submissionCount).toBe(1);
    expect(providerB.submissionCount, 'B NEVER re-submitted — the takeover resolved by identity (a CONFIRMED operation is NEVER re-submitted)').toBe(0);
    expect(providerB.resolveCount, 'B recovered by exactly ONE status fetch on the recorded identity').toBe(1);
    expect(providerA.effectCount, 'the SIDE EFFECT happened exactly ONCE (A\'s original submission — the only one FOREVER)').toBe(1);
    expect(stats.completeTrueCount, 'exactly ONE authoritative outcome write').toBe(1);

    const rowsAfterRecovery = await readProviderOperations(executionId);
    expect(rowsAfterRecovery.length).toBe(1);
    expect(rowsAfterRecovery[0]!.state).toBe('completed');
    expect(rowsAfterRecovery[0]!.generation).toBe(2);
    expect(rowsAfterRecovery[0]!.handle, 'the operation identity is UNCHANGED (A\'s platform identity)').toBe(rowsAtDeath[0]!.handle);
    expect(rowsAfterRecovery[0]!.submissionJson, 'the stored result is the PLATFORM outcome — the ONE the body produced (never a re-computed lookalike)').toContain('platform-operation-outcome');

    // T2's authoritative outcome + the discharged obligation.
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(await countDischargedObligations(executionId)).toBe(1);

    // The DEAD driver's LATE failure: its generation-fenced fail CAS hits 0
    // rows (generation 1 is stale) → the convergence check replays the
    // winner's stored result → fenced out. STILL exactly ONE side effect —
    // nothing re-submitted the operation.
    killDeadDriver(new Error('simulated process death mid-resolution'));
    await t1Promise;
    expect(t1Error).toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code).toBe('claim-fence-lost');
    expect(stats.completeFalseCount).toBe(1);
    expect(providerA.effectCount, 'FINAL: the side effect STILL happened exactly ONCE — across the process loss, the takeover, the recovery, AND the dead driver\'s late failure').toBe(1);
    expect(providerA.submissionCount).toBe(1);
    expect(providerB.submissionCount).toBe(0);

    const rowsFinal = await readProviderOperations(executionId);
    expect(rowsFinal.length).toBe(1);
    expect(rowsFinal[0]!.state).toBe('completed');
    expect(rowsFinal[0]!.generation).toBe(2);
    expect(rowsFinal[0]!.submissionJson).toContain('platform-operation-outcome');
    const afterT1 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT1!.packageValue, 'T2\'s authoritative package is INTACT').toEqual(afterT2!.packageValue);
    expect(afterT1!.status).toBe('handoff_ready');
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions').toBe(1);
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
  });

  // =========================================================================
  // PR #46 ROUND 10 — the architect's COMPLETE crash matrix for the external
  // operation protocol, proven on real PostgreSQL with the SIDE-EFFECTING
  // provider double (whose platform is the external system's durable state):
  //
  //   | Crash point                                        | Recovery |
  //   | before the provider accepted the submission        | first execution |
  //   | after the provider accepted, before the attach     | re-submission CONVERGES |
  //   | after the attach (started), before the result      | resolve by identity |
  //   | after the provider result, before the completion   | resolve/replay the result |
  //   | stale generation completes                         | rejected |
  //   | stale generation fails                             | rejected |
  //
  // Rows 3-4 are R10-#3 (the started resolution); rows 5-6 are R10-#4/#5.
  // R10-#1 below proves row 1; R10-#2 proves row 2 — THE round-10 hole: the
  // round-9 attach-before-body ordering left a crash window in which the
  // ledger recorded an identity for an operation that never existed.
  // =========================================================================

  it('R10-#1. the crash BEFORE the provider accepted — the row is pending with NO handle (the ledger claims NOTHING); the recovery RE-SUBMITS + the re-submission is the ONE FIRST execution (T1\'s effect never happened; T2 performs it)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // The shared "platform" (the external system's durable state).
    const platform = new Map<string, ExecutionSubmission>();

    // T1: its provider instance (A) dies INSIDE the submission BEFORE the
    // platform accepted the operation — NOTHING exists at the provider; the
    // ledger row is 'pending' @ generation 1 with NO handle (the row claims
    // NOTHING about the provider).
    let killDeadDriver!: (reason: Error) => void;
    const deathGate = new Promise<never>((_, reject) => { killDeadDriver = reject; });
    const providerA = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 10_000,
        operationPollIntervalMs: 10,
      },
      { beforeEffect: deathGate },
      platform,
    );
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: providerA,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r10-first-execution-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    await waitFor(() => providerA.submissionCount === 1, 5000);
    await delay(300);
    const rowsAtDeath = await readProviderOperations(executionId);
    expect(rowsAtDeath.length).toBe(1);
    expect(rowsAtDeath[0]!.state, 'the row is pending (the submission was never confirmed)').toBe('pending');
    expect(rowsAtDeath[0]!.generation).toBe(1);
    expect(rowsAtDeath[0]!.handle, 'NO handle — the row claims NOTHING about the provider (the database never infers a start)').toBeNull();
    expect(providerA.submissionCount, 'T1 began exactly ONE submission').toBe(1);
    expect(providerA.effectCount, 'T1\'s submission NEVER reached the provider (died before the platform accepted) — ZERO effects').toBe(0);

    // T2: a FRESH provider instance on the SECOND client (short window). The
    // 'pending' row is RE-SUBMITTED — the re-submission performs the ONE
    // FIRST execution (nothing existed at the provider).
    const providerB = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(second!.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 150,
        operationPollIntervalMs: 10,
      },
      {},
      platform,
    );
    const t2Service = buildT2Service({ stats, externalProvider: providerB });
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed, took over (generation 2), RE-SUBMITTED (the first execution), + completed').toBe('complete');

    // THE MATRIX ROW 1 INVARIANT: the re-submission is the FIRST execution —
    // the platform operation happened exactly ONCE (T2's).
    expect(providerB.submissionCount, 'T2 RE-SUBMITTED exactly once (the recovery drive of the pending row)').toBe(1);
    expect(providerB.effectCount, 'T2\'s re-submission performed the ONE FIRST execution').toBe(1);
    expect(providerA.effectCount, 'T1\'s submission NEVER completed — ZERO effects FOREVER').toBe(0);
    expect(providerB.resolveCount, 'T2 resolved the CONFIRMED operation by identity exactly once').toBe(1);
    expect(stats.completeTrueCount).toBe(1);

    const rowsAfterRecovery = await readProviderOperations(executionId);
    expect(rowsAfterRecovery.length).toBe(1);
    expect(rowsAfterRecovery[0]!.state).toBe('completed');
    expect(rowsAfterRecovery[0]!.generation, 'generation 2 — the take-over fencing token').toBe(2);
    expect(rowsAfterRecovery[0]!.handle, 'the PROVIDER-CONFIRMED identity is recorded by T2\'s attach (after the re-submission returned it)').toMatch(/^platform-operation:cross-mode-dispatch-/);
    expect(rowsAfterRecovery[0]!.submissionJson, 'the ONE stored result is the PLATFORM outcome (the first execution\'s result)').toContain('platform-operation-outcome');
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(await countDischargedObligations(executionId)).toBe(1);

    // T1's late tail (ROUND-11 semantics): its dead submission rejects with
    // an AMBIGUOUS error (simulated process death — a plain Error, NOT the
    // typed definitive reject). The ambiguous submission error NEVER reaches
    // the fail CAS — no terminal write is even attempted: the keyed submit
    // fails closed with the typed outcome-unknown error, the dispatch fails
    // 'handoff-dispatch-failed', and T1 never reaches completeFencedDispatch
    // (its gate stays in flight at its epoch — the reclaiming owner T2
    // already took it over + completed). The row + the ONE authoritative
    // outcome are untouched by T1's ambiguous failure. STILL exactly ONE
    // side effect.
    killDeadDriver(new Error('simulated process death before the provider accepted the submission'));
    await t1Promise;
    expect(t1Error).toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'the AMBIGUOUS submission error fails the dispatch (fail closed — NEVER a terminal ledger write)').toBe('handoff-dispatch-failed');
    expect((t1Error as Error).message, 'the typed outcome-unknown error is surfaced (the same-key retry converges through the provider dedup)').toContain('submission-outcome-unknown');
    expect(stats.completeFalseCount, 'T1 never completed a dispatch — its completeFencedDispatch was never reached').toBe(0);

    // FINAL: ONE row, COMPLETED @ generation 2, ONE platform operation (T2's
    // first execution), ONE authoritative outcome.
    const rowsFinal = await readProviderOperations(executionId);
    expect(rowsFinal.length).toBe(1);
    expect(rowsFinal[0]!.state).toBe('completed');
    expect(rowsFinal[0]!.generation).toBe(2);
    expect(providerA.effectCount + providerB.effectCount, 'FINAL: the platform operation happened EXACTLY ONCE (T2\'s first execution)').toBe(1);
    expect(providerA.submissionCount + providerB.submissionCount, 'TWO submission ATTEMPTS (T1\'s dead one + T2\'s converging re-submission) — ONE effect: the idempotent boundary held').toBe(2);
    const afterT1 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT1!.packageValue, 'T2\'s authoritative package is INTACT').toEqual(afterT2!.packageValue);
    expect(afterT1!.status).toBe('handoff_ready');
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions').toBe(1);
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
  });

  it('R10-#2. the crash AFTER the provider accepted, BEFORE the ledger attach — THE ROUND-10 HOLE: the row is pending with NO handle (the ledger claims NOTHING) yet the operation EXISTS at the provider; the recovery RE-SUBMITS + the IDEMPOTENT-BY-KEY submission CONVERGES onto the ONE platform operation (the provider\'s key→operation mapping is the authority — NEVER the ledger row): the side effect happens EXACTLY ONCE', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // The shared "platform" (the external system's durable state — the ONLY
    // thing that survives T1's process death).
    const platform = new Map<string, ExecutionSubmission>();

    // T1: its provider instance (A) submits the platform operation — the
    // provider ACCEPTS it (the SIDE EFFECT happens ONCE, the outcome lands
    // on the platform) — and then DIES before returning (the ledger attach
    // NEVER runs). THE ROUND-10 CRASH WINDOW: the row is 'pending' @
    // generation 1 with NO handle (it claims NOTHING about the provider),
    // yet the operation EXISTS at the platform.
    let killDeadDriver!: (reason: Error) => void;
    const deathGate = new Promise<never>((_, reject) => { killDeadDriver = reject; });
    const providerA = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 10_000,
        operationPollIntervalMs: 10,
      },
      { afterEffect: deathGate },
      platform,
    );
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: providerA,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r10-converging-resubmission-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    await waitFor(() => providerA.effectCount === 1, 5000);
    await delay(300);
    const rowsAtDeath = await readProviderOperations(executionId);
    expect(rowsAtDeath.length).toBe(1);
    expect(rowsAtDeath[0]!.state, 'THE ROUND-10 CRASH WINDOW: the row is pending (the attach never ran)').toBe('pending');
    expect(rowsAtDeath[0]!.generation).toBe(1);
    expect(rowsAtDeath[0]!.handle, 'NO handle — the ledger claims NOTHING about the provider (the database never infers a start from a persisted intended identity)').toBeNull();
    expect(providerA.submissionCount, 'T1 submitted exactly once').toBe(1);
    expect(providerA.effectCount, 'the provider ACCEPTED the operation — the SIDE EFFECT happened ONCE (the outcome lives at the platform)').toBe(1);

    // T2: a FRESH provider instance on the SECOND client, sharing ONLY the
    // platform (the external system). The 'pending' row is RE-SUBMITTED —
    // and the IDEMPOTENT-BY-KEY submission CONVERGES onto the ONE platform
    // operation the crash interrupted (the platform's key→operation mapping
    // is the authority — the SAME identity returns, NO second effect).
    const providerB = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(second!.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 150,
        operationPollIntervalMs: 10,
      },
      {},
      platform,
    );
    const t2Service = buildT2Service({ stats, externalProvider: providerB });
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed, took over (generation 2), RE-SUBMITTED (converging onto the ONE platform operation), + completed').toBe('complete');

    // THE MATRIX ROW 2 INVARIANT — THE ROUND-10 HOLE CLOSED: the recovery
    // RE-SUBMITTED (the row claimed nothing), the submission CONVERGED onto
    // the ONE platform operation, and the side effect STILL happened exactly
    // ONCE. The provider's key→operation mapping — never the ledger row —
    // is the authority.
    expect(providerB.submissionCount, 'T2 RE-SUBMITTED exactly once (the pending row claims nothing — the recovery safely re-submits)').toBe(1);
    expect(providerB.effectCount, 'the re-submission CONVERGED onto the EXISTING platform operation — NO second effect (the idempotent-by-key contract)').toBe(0);
    expect(providerA.effectCount, 'the SIDE EFFECT happened exactly ONCE (T1\'s submission — the only one FOREVER)').toBe(1);
    expect(providerB.resolveCount, 'T2 resolved the CONFIRMED operation by identity exactly once (a status fetch on the platform)').toBe(1);
    expect(stats.completeTrueCount).toBe(1);

    const rowsAfterRecovery = await readProviderOperations(executionId);
    expect(rowsAfterRecovery.length).toBe(1);
    expect(rowsAfterRecovery[0]!.state).toBe('completed');
    expect(rowsAfterRecovery[0]!.generation, 'generation 2 — the take-over fencing token').toBe(2);
    const thePlatformHandle = [...platform.keys()][0]!;
    expect(platform.size, 'the platform holds EXACTLY ONE operation (the crash-interrupted one)').toBe(1);
    expect(rowsAfterRecovery[0]!.handle, 'the recorded identity is the platform\'s ONE operation identity — the SAME ONE the crash interrupted (the re-submission CONVERGED onto it)').toBe(thePlatformHandle);
    expect(rowsAfterRecovery[0]!.submissionJson, 'the ONE stored result is the PLATFORM outcome (the ONE the crashed submission produced — never a duplicate)').toContain('platform-operation-outcome');
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(await countDischargedObligations(executionId)).toBe(1);

    // T1's late tail (ROUND-11 semantics): its dead submission rejects with
    // an AMBIGUOUS error (simulated process death — a plain Error, NOT the
    // typed definitive reject — the platform HAD accepted the operation).
    // The ambiguous submission error NEVER reaches the fail CAS — no
    // terminal write is even attempted: the keyed submit fails closed with
    // the typed outcome-unknown error, the dispatch fails
    // 'handoff-dispatch-failed', and T1 never reaches
    // completeFencedDispatch. STILL exactly ONE side effect.
    killDeadDriver(new Error('simulated process death after the platform accepted the operation'));
    await t1Promise;
    expect(t1Error).toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'the AMBIGUOUS submission error fails the dispatch (fail closed — NEVER a terminal ledger write)').toBe('handoff-dispatch-failed');
    expect((t1Error as Error).message, 'the typed outcome-unknown error is surfaced (the same-key retry converges through the provider dedup)').toContain('submission-outcome-unknown');
    expect(stats.completeFalseCount, 'T1 never completed a dispatch — its completeFencedDispatch was never reached').toBe(0);
    expect(providerA.effectCount + providerB.effectCount, 'FINAL: the side effect happened EXACTLY ONCE across the crash window + the takeover + the converging re-submission + the late failure').toBe(1);
    expect(providerA.submissionCount + providerB.submissionCount, 'TWO submissions (the crashed one + the CONVERGING re-submission) — ONE effect: the provider boundary is the idempotency authority').toBe(2);

    const rowsFinal = await readProviderOperations(executionId);
    expect(rowsFinal.length).toBe(1);
    expect(rowsFinal[0]!.state).toBe('completed');
    expect(rowsFinal[0]!.generation).toBe(2);
    const afterT1 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT1!.packageValue, 'T2\'s authoritative package is INTACT').toEqual(afterT2!.packageValue);
    expect(afterT1!.status).toBe('handoff_ready');
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions').toBe(1);
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
  });

  // =========================================================================
  // PR #46 round 10 — the NATIVE LIFECYCLE CONVERGENCE regressions (the
  // round-10 review's second blocker: native convergence treated an
  // in_progress AgentRun as completed). The corrected semantics — EXISTING ≠
  // COMPLETED — proven on real PostgreSQL with fresh NativeExecutionProvider
  // instances per actor:
  //
  //   R10-N1. an existing IN-PROGRESS run is AWAITED (the keyed submit does
  //      NOT report completed prematurely — it does not even RESOLVE while
  //      the run is non-terminal) + the terminal SUCCESS is eventually
  //      reflected (ONE run, ONE adapter invocation, ZERO gateway calls from
  //      the converging actor);
  //   R10-N2. the failure arm: an existing in_progress run LATER FAILS → the
  //      converging caller RECEIVES the failed outcome;
  //   R10-N3. the stuck (never-terminal) run: the keyed submit FAILS CLOSED
  //      with the typed unresolved error — NEVER a manufactured completion,
  //      NEVER a second run (also exercised inside R8-#2's legs).
  // =========================================================================

  it('R10-N1. an existing IN-PROGRESS AgentRun is AWAITED, never reported completed — the converging actor\'s keyed submit does NOT resolve while the run is non-terminal, + the terminal SUCCESS is eventually reflected (ONE run, ONE adapter invocation, ZERO gateway calls from the converging actor)', async () => {
    const { executionId } = await createExternalRecord();
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // T1: a keyed native dispatch whose adapter PARKS (ParkableAgentAdapter)
    // — the gateway created the ONE AgentRun (in_progress) + the adapter
    // invocation is in flight.
    let releaseAdapter!: () => void;
    const adapterGate = new Promise<void>((r) => { releaseAdapter = r; });
    const parkableAdapter = new ParkableAgentAdapter(fakeAgent, adapterGate);
    const t1NativeProvider = new NativeExecutionProvider({
      agentGateway: new DefaultAgentGateway(stack.db.client, stack.db.logger, [parkableAdapter], 3),
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
          { targetMode: 'native', idempotencyKey: `r10-native-await-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();
    await waitFor(() => parkableAdapter.inFlight, 5000);
    const midRun = await agentRunRepo.findByExecutionId(executionId);
    expect(midRun, 'the ONE AgentRun exists while T1 is stalled INSIDE the adapter').not.toBeNull();
    expect(['pending', 'in_progress'], 'the existing run is NON-TERMINAL while the adapter is in flight').toContain(midRun!.status);
    await delay(300);

    // T2: a FRESH NativeExecutionProvider instance on the SECOND client
    // (with a CountingGateway — the converging actor must perform ZERO
    // gateway calls). Its KEYED submit finds the existing IN-PROGRESS run →
    // the convergence AWAITS it (never reports completed prematurely).
    const countingGatewayT2 = new CountingGateway(
      new DefaultAgentGateway(second!.client, stack.db.logger, [parkableAdapter], 3),
    );
    const providerT2 = new NativeExecutionProvider({
      agentGateway: countingGatewayT2,
      agentRunRepository: new PgAgentRunRepository(second!.client),
      logger: stack.db.logger,
      existingRunResolutionWindowMs: 5_000,
      existingRunPollIntervalMs: 10,
    });
    const recordForTask = await executionRecordRepo.findByExecutionId(executionId);
    const builtTask = await executionTaskService.build({
      workItemId: recordForTask!.workItemId,
      mode: 'native',
      provider: 'fake',
      model: 'test-model',
      executionId,
      implementationContextId: recordForTask!.implementationContextId,
    });
    const gateState = await readDispatchGate(executionId);
    let t2Resolved: ExecutionSubmission | undefined;
    let t2Rejected: unknown;
    const t2SubmitPromise = (async () => {
      try {
        t2Resolved = await providerT2.submit({
          ...builtTask.task,
          dispatchIdempotencyKey: gateState.dispatchKey!,
        });
      } catch (err) {
        t2Rejected = err;
      }
    })();

    // THE PREMATURE-COMPLETION PROOF: while the run is IN PROGRESS, T2's
    // keyed submit has NOT resolved (and has NOT rejected) — it is parked
    // INSIDE the await. Round 9 would have returned status='completed' HERE.
    await delay(400);
    expect(t2Resolved, 'EXISTING ≠ COMPLETED: the keyed submit has NOT resolved while the run is non-terminal (round 9 would have manufactured completed here)').toBeUndefined();
    expect(t2Rejected).toBeUndefined();
    expect(countingGatewayT2.executeCount, 'the converging actor performed ZERO gateway calls (converge-on-the-existing-run)').toBe(0);
    expect(parkableAdapter.executeCount, 'still exactly ONE adapter invocation (T1\'s — in flight)').toBe(1);
    expect(await countAgentRuns(executionId), 'still exactly ONE AgentRun').toBe(1);

    // The terminal SUCCESS is eventually reflected: release T1's adapter →
    // the gateway finalizes the run 'success' → T2's await observes the
    // TERMINAL state → the submission reflects it.
    releaseAdapter();
    await t2SubmitPromise;
    expect(t2Rejected).toBeUndefined();
    const finalRun = await agentRunRepo.findByExecutionId(executionId);
    expect(finalRun!.status, 'the ONE run reached its terminal SUCCESS').toBe('success');
    expect(t2Resolved!.status, 'the converged submission reports the TERMINAL outcome (eventually reflected) — never a manufactured in-progress completion').toBe('completed');
    expect(t2Resolved!.agentRunId, 'the converged submission binds the ONE existing run').toBe(finalRun!.id);
    expect(countingGatewayT2.executeCount, 'the converging actor STILL performed ZERO gateway calls').toBe(0);
    expect(parkableAdapter.executeCount, 'still exactly ONE adapter invocation — the ONE native provider operation').toBe(1);
    expect(await countAgentRuns(executionId), 'FINAL: exactly ONE AgentRun (never a second)').toBe(1);

    // T1's own dispatch completes through its own gateway result (the run is
    // terminal-success; nobody reclaimed T1 — its lease was never taken
    // over, so its fenced completion writes the authoritative outcome).
    await t1Promise;
    expect(t1Error).toBeUndefined();
    const record = await executionRecordRepo.findByExecutionId(executionId);
    expect(record!.mode).toBe('native');
    expect(record!.status, 'T1\'s own dispatch completed with the terminal run outcome').toBe('completed');
    expect(record!.agentRunId).toBe(finalRun!.id);
  });

  it('R10-N2. the failure arm — an existing IN-PROGRESS AgentRun later FAILS: the converging caller\'s keyed submit AWAITS the terminal state + RECEIVES the failed outcome (never a manufactured completion, never a second run)', async () => {
    const { executionId, recordId } = await createExternalRecord();

    // T1: a keyed native dispatch whose adapter PARKS and then FAILS when
    // released (the gateway finalizes the run 'failed' + T1's provider
    // propagates the failure).
    let releaseAdapter!: () => void;
    const adapterGate = new Promise<void>((r) => { releaseAdapter = r; });
    class FailingAfterParkAdapter implements AgentProviderAdapter {
      readonly providerName = 'fake';
      private parked = false;
      constructor(private readonly gate: Promise<void>) {}
      supports(provider: string): boolean { return provider === 'fake'; }
      get inFlight(): boolean { return this.parked; }
      async execute(request: AgentRequest): Promise<AgentExecutionResult> {
        this.parked = true;
        await this.gate;
        this.parked = false;
        // The gateway's failure path: a THROWN non-retryable AgentError (the
        // gateway persists the run as 'failed' + rethrows).
        throw {
          type: 'non_retryable',
          message: 'the adapter failed after the park',
          provider: 'fake',
          retryable: false,
        } as AgentError;
        void request;
      }
    }
    const failingAdapter = new FailingAfterParkAdapter(adapterGate);
    const t1NativeProvider = new NativeExecutionProvider({
      agentGateway: new DefaultAgentGateway(stack.db.client, stack.db.logger, [failingAdapter], 3),
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
    });
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats: { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 },
      nativeProvider: t1NativeProvider,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'native', idempotencyKey: `r10-native-fail-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();
    await waitFor(() => failingAdapter.inFlight, 5000);
    const midRun = await agentRunRepo.findByExecutionId(executionId);
    expect(midRun, 'the ONE AgentRun exists (in flight at the failing adapter)').not.toBeNull();
    expect(['pending', 'in_progress']).toContain(midRun!.status);

    // T2: a FRESH native instance on the SECOND client — its KEYED submit
    // finds the existing IN-PROGRESS run + AWAITS it.
    const countingGatewayT2 = new CountingGateway(
      new DefaultAgentGateway(second!.client, stack.db.logger, [failingAdapter], 3),
    );
    const providerT2 = new NativeExecutionProvider({
      agentGateway: countingGatewayT2,
      agentRunRepository: new PgAgentRunRepository(second!.client),
      logger: stack.db.logger,
      existingRunResolutionWindowMs: 5_000,
      existingRunPollIntervalMs: 10,
    });
    const recordForTask = await executionRecordRepo.findByExecutionId(executionId);
    const builtTask = await executionTaskService.build({
      workItemId: recordForTask!.workItemId,
      mode: 'native',
      provider: 'fake',
      model: 'test-model',
      executionId,
      implementationContextId: recordForTask!.implementationContextId,
    });
    const gateState = await readDispatchGate(executionId);
    let t2Submission: ExecutionSubmission | undefined;
    const t2SubmitPromise = (async () => {
      t2Submission = await providerT2.submit({
        ...builtTask.task,
        dispatchIdempotencyKey: gateState.dispatchKey!,
      });
    })();

    // While the run is non-terminal, T2's submit has NOT resolved.
    await delay(300);
    expect(t2Submission, 'the keyed submit is AWAITING the non-terminal run (no premature completion)').toBeUndefined();
    expect(countingGatewayT2.executeCount).toBe(0);

    // The run FAILS: release the adapter → the gateway finalizes the run
    // 'failed' → T2's await observes the TERMINAL FAILURE → the converging
    // caller RECEIVES the failed outcome.
    releaseAdapter();
    await t2SubmitPromise;
    const finalRun = await agentRunRepo.findByExecutionId(executionId);
    expect(finalRun!.status, 'the ONE run reached its terminal FAILURE').toBe('failed');
    expect(t2Submission!.status, 'the converging caller RECEIVES the failed outcome (the terminal failure is eventually reflected)').toBe('failed');
    expect(t2Submission!.agentRunId).toBe(finalRun!.id);
    expect(countingGatewayT2.executeCount, 'the converging actor performed ZERO gateway calls').toBe(0);
    expect(await countAgentRuns(executionId), 'FINAL: exactly ONE AgentRun (never a second)').toBe(1);

    // T1's own dispatch: its gateway result failed → the provider propagates
    // → the dispatch failure handler converges on the FAILED terminal run →
    // the authoritative failure record writes through the fence → T1
    // surfaces handoff-dispatch-failed.
    await t1Promise;
    expect(t1Error).toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code).toBe('handoff-dispatch-failed');
    const record = await executionRecordRepo.findByExecutionId(executionId);
    expect(record!.id).toBe(recordId);
    expect(record!.mode).toBe('native');
    expect(record!.status, 'the authoritative record converged on the FAILED terminal run (no manufactured success)').toBe('failed');
    expect(record!.agentRunId).toBe(finalRun!.id);
  });

  it('R10-N3. the STUCK (never-terminal) run — the keyed submit FAILS CLOSED with the typed unresolved error: NEVER a manufactured completed submission, NEVER a second run (the execution_id UNIQUE is the ledger authority)', async () => {
    const { executionId } = await createExternalRecord();
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // T1: a SHORT 150ms lease + a gateway that creates the ONE AgentRun and
    // DIES (the run is ORPHANED non-terminal forever — nothing will ever
    // finalize it).
    let killDeadGateway!: (reason: Error) => void;
    const deathGate = new Promise<never>((_, reject) => { killDeadGateway = reject; });
    const crashGateway = new CrashAfterRunCreationGateway(agentRunRepo, deathGate);
    const t1NativeProvider = new NativeExecutionProvider({
      agentGateway: crashGateway,
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
      existingRunResolutionWindowMs: 150,
      existingRunPollIntervalMs: 10,
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
          { targetMode: 'native', idempotencyKey: `r10-native-stuck-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();
    await waitFor(() => crashGateway.runCreated, 5000);
    await delay(300);
    const stuckRun = await agentRunRepo.findByExecutionId(executionId);
    expect(stuckRun, 'the ONE stuck run exists').not.toBeNull();
    expect(['pending', 'in_progress'], 'the run is NON-TERMINAL + will NEVER finalize (its driver died)').toContain(stuckRun!.status);

    // T2: a FRESH native instance on the SECOND client (a SHORT await
    // window). Its KEYED submit finds the stuck run → the convergence AWAITS
    // it → the window elapses → the typed unresolved error (fail closed —
    // the exact OPPOSITE of round 9's manufactured 'completed').
    const countingGatewayT2 = new CountingGateway(
      new DefaultAgentGateway(second!.client, stack.db.logger, [fakeAgent], 3),
    );
    const providerT2 = new NativeExecutionProvider({
      agentGateway: countingGatewayT2,
      agentRunRepository: new PgAgentRunRepository(second!.client),
      logger: stack.db.logger,
      existingRunResolutionWindowMs: 150,
      existingRunPollIntervalMs: 10,
    });
    const recordForTask = await executionRecordRepo.findByExecutionId(executionId);
    const builtTask = await executionTaskService.build({
      workItemId: recordForTask!.workItemId,
      mode: 'native',
      provider: 'fake',
      model: 'test-model',
      executionId,
      implementationContextId: recordForTask!.implementationContextId,
    });
    const gateState = await readDispatchGate(executionId);
    await expect(
      providerT2.submit({ ...builtTask.task, dispatchIdempotencyKey: gateState.dispatchKey! }),
      'EXISTING ≠ COMPLETED: a keyed submit on a STUCK non-terminal run FAILS CLOSED with the typed unresolved error (round 9 manufactured completed here)',
    ).rejects.toThrow(/native-execution-existing-run-unresolved/);
    expect(countingGatewayT2.executeCount, 'the converging actor performed ZERO gateway calls (no second operation)').toBe(0);
    expect(fakeAgent.getCallCount(), 'ZERO adapter invocations ever').toBe(0);
    expect(await countAgentRuns(executionId), 'FINAL: exactly ONE AgentRun (the stuck run was never replaced)').toBe(1);

    // T1's late gateway failure: the collision-recovery finds the stuck
    // non-terminal run → awaits (150ms) → fails closed → the dispatch
    // failure handler performs NO outcome write for the non-terminal run →
    // T1 surfaces handoff-dispatch-failed (an honest failure).
    killDeadGateway(new Error('simulated process death — the orphaned run never finalizes'));
    await t1Promise;
    expect(t1Error).toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'the dead driver\'s late dispatch failed on the unresolved run (NO manufactured completion)').toBe('handoff-dispatch-failed');
    expect(stats.completeFalseCount, 'NO fenced completion from the dead driver (the non-terminal run wrote NOTHING)').toBe(0);
    expect(stats.completeTrueCount, 'NO authoritative outcome write (the record keeps its intermediate state; the run lifecycle owns the execution)').toBe(0);
    const record = await executionRecordRepo.findByExecutionId(executionId);
    expect(record!.mode).toBe('native');
    expect(record!.status, 'the record keeps the mutated intermediate state (no terminal outcome manufactured for a stuck run)').toBe('running');
  });

  // =========================================================================
  // PR #46 round 11 — the SUBMISSION-ERROR TAXONOMY regressions (the
  // round-11 review's blocker: an ambiguous startOperation failure was
  // terminalized as FAILED, closing the key while the provider operation may
  // EXIST and succeed — every later same-key submission then replayed a
  // failure the provider never reported). The required distinction:
  //
  //   DEFINITIVE_REJECT (the typed ProviderOperationRejectedError)
  //      → terminal FAILED is allowed;
  //   AMBIGUOUS / ACCEPTANCE_UNKNOWN (every other submission error)
  //      → remain recoverable → same-key retry → provider deduplication/
  //        convergence → attach the returned identity → resolve.
  //
  // THE DATABASE NEVER CLOSES A KEY ON AN AMBIGUOUS SUBMISSION ERROR.
  // =========================================================================

  it('R11-#1. THE AMBIGUOUS ACCEPTANCE — the provider ACCEPTS the operation + the RESPONSE IS LOST (the submission throws an ambiguous plain error — NOT a definitive reject): the ledger REMAINS PENDING (never failed), the takeover/retry with the SAME key re-submits, the provider returns the SAME operation identity (the dedup CONVERGES), EXACTLY ONE external side effect happens, + the terminal result is recorded', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // The shared "platform" (the external system's durable state — the ONLY
    // thing that survives T1's ambiguous failure).
    const platform = new Map<string, ExecutionSubmission>();

    // T1: its provider instance (A) submits the platform operation — the
    // platform ACCEPTS it (the SIDE EFFECT happens ONCE, the outcome lands
    // on the platform) — and then the RESPONSE IS LOST: the submission call
    // throws an AMBIGUOUS plain error (a connection reset after the accept).
    // This is NOT a definitive reject: the provider did NOT refuse the
    // operation — it accepted it and the response never arrived. THE
    // ROUND-11 BLOCKER'S EXACT SEQUENCE: the ledger row is 'pending' @
    // generation 1 with NO handle; the provider operation EXISTS.
    const providerA = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 10_000,
        operationPollIntervalMs: 10,
      },
      { loseResponseAfterAccept: true },
      platform,
    );
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: providerA,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r11-ambiguous-acceptance-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();
    await t1Promise;

    // THE ROUND-11 INVARIANT #1: the AMBIGUOUS submission error did NOT
    // terminalize the key. The row is STILL 'pending' (NOT failed — round 10
    // wrote terminal FAILED here, closing the key while the provider
    // operation EXISTS); the dispatch failed closed with the typed
    // outcome-unknown error (the obligation stays pending; the same-key
    // retry converges).
    expect(providerA.submissionCount, 'T1 submitted exactly once (the platform ACCEPTED)').toBe(1);
    expect(providerA.effectCount, 'the provider ACCEPTED the operation — the SIDE EFFECT happened ONCE (the operation EXISTS at the provider)').toBe(1);
    expect(t1Error).toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'the ambiguous submission error fails the dispatch (fail closed — the obligation stays pending)').toBe('handoff-dispatch-failed');
    expect((t1Error as Error).message, 'the typed outcome-unknown error is surfaced').toContain('submission-outcome-unknown');
    const rowsAfterAmbiguity = await readProviderOperations(executionId);
    expect(rowsAfterAmbiguity.length).toBe(1);
    expect(rowsAfterAmbiguity[0]!.state, 'THE ROUND-11 BLOCKER: the ambiguous submission error leaves the ledger PENDING — the key is NOT closed (round 10 wrote terminal FAILED here while the provider operation EXISTS)').toBe('pending');
    expect(rowsAfterAmbiguity[0]!.generation).toBe(1);
    expect(rowsAfterAmbiguity[0]!.handle, 'NO handle — the attach never ran (the response was lost before the identity returned)').toBeNull();
    expect(rowsAfterAmbiguity[0]!.errorMessage, 'NO terminal failure was recorded — the provider never reported a failure').toBeNull();
    expect(platform.size, 'the operation EXISTS at the platform (the external system holds it)').toBe(1);

    // Let T1's 150ms claim lease expire (T1's dispatch already failed — the
    // gate stays in flight at T1's epoch; the obligation stays pending).
    await delay(300);

    // T2: a FRESH provider instance on the SECOND client, sharing ONLY the
    // platform. The TAKEOVER/RETRY with the SAME key: the 'pending' row is
    // taken over (generation 2 — the fencing token) + RE-SUBMITTED — the
    // IDEMPOTENT-BY-KEY submission CONVERGES onto the ONE platform operation
    // (the provider returns the SAME operation identity) → the identity is
    // attached → the ONE operation is resolved → the terminal result is
    // recorded.
    const providerB = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(second!.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 150,
        operationPollIntervalMs: 10,
      },
      {},
      platform,
    );
    const t2Service = buildT2Service({ stats, externalProvider: providerB });
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed, took over (generation 2), RE-SUBMITTED (converging onto the ONE platform operation), + completed').toBe('complete');

    // THE ROUND-11 INVARIANT #2: the same-key retry CONVERGED — the provider
    // returned the SAME operation identity, NO second effect happened, and
    // the terminal result was recorded. The provider's idempotency-by-key
    // guarantee REMAINED USABLE precisely because the ambiguous error never
    // closed the key.
    expect(providerB.submissionCount, 'T2 RE-SUBMITTED exactly once (the pending row claims nothing — the recovery safely re-submits)').toBe(1);
    expect(providerB.effectCount, 'the re-submission CONVERGED onto the EXISTING platform operation — NO second effect (the idempotent-by-key contract)').toBe(0);
    expect(providerB.resolveCount, 'T2 resolved the CONFIRMED operation by identity exactly once (a status fetch on the platform)').toBe(1);
    expect(providerA.effectCount, 'the SIDE EFFECT happened exactly ONCE (T1\'s accepting submission — the only one FOREVER)').toBe(1);
    expect(providerA.effectCount + providerB.effectCount, 'EXACTLY ONE external side effect across the ambiguous acceptance + the lost response + the takeover + the converging re-submission').toBe(1);
    expect(providerA.submissionCount + providerB.submissionCount, 'TWO submissions (the ambiguously-accepted one + the CONVERGING re-submission) — ONE effect').toBe(2);
    expect(stats.completeTrueCount).toBe(1);

    const rowsAfterRecovery = await readProviderOperations(executionId);
    expect(rowsAfterRecovery.length).toBe(1);
    expect(rowsAfterRecovery[0]!.state, 'the terminal result is recorded').toBe('completed');
    expect(rowsAfterRecovery[0]!.generation, 'generation 2 — the take-over fencing token').toBe(2);
    const thePlatformHandle = [...platform.keys()][0]!;
    expect(platform.size, 'the platform holds EXACTLY ONE operation').toBe(1);
    expect(rowsAfterRecovery[0]!.handle, 'the recorded identity is the provider\'s SAME operation identity — the re-submission CONVERGED onto it (the provider returned the SAME identity)').toBe(thePlatformHandle);
    expect(rowsAfterRecovery[0]!.submissionJson, 'the ONE stored result is the PLATFORM outcome (the ONE the ambiguously-lost submission produced — never a duplicate, never a manufactured failure)').toContain('platform-operation-outcome');
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(await countDischargedObligations(executionId)).toBe(1);
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
  });

  it('R11-#2. the DEFINITIVE-REJECT arm — the typed ProviderOperationRejectedError (the provider PROVABLY refused; NO operation exists): terminal FAILED IS recorded @ generation 1 (the only legal pending-row failure), ZERO platform operations/effects ever happen, + a later same-key submit surfaces the STORED failure with ZERO submissions (key immutability for the reject arm)', async () => {
    const { executionId } = await createNativeRecord('failed');
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // The shared "platform" — the provider will REFUSE the operation, so it
    // must stay EMPTY forever (no operation, no side effect).
    const platform = new Map<string, ExecutionSubmission>();

    // T1: its provider instance (A) DEFINITIVELY REJECTS the submission —
    // the typed ProviderOperationRejectedError (the platform guarantees NO
    // operation exists for the key). This is the ONLY submission error that
    // may terminally fail the key.
    const providerA = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 10_000,
        operationPollIntervalMs: 10,
      },
      { definitiveReject: true },
      platform,
    );
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: providerA,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r11-definitive-reject-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();
    await t1Promise;

    // The DEFINITIVE-REJECT arm: terminal FAILED is ALLOWED (the provider
    // PROVED no operation exists — no side effect can ever occur).
    expect(providerA.submissionCount, 'T1 submitted exactly once (the provider refused it)').toBe(1);
    expect(providerA.effectCount, 'ZERO side effects — the provider REFUSED the operation (NO operation exists)').toBe(0);
    expect(platform.size, 'the platform holds NO operation (the refusal guarantee)').toBe(0);
    expect(t1Error).toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'the definitive reject fails the dispatch').toBe('handoff-dispatch-failed');
    expect((t1Error as Error).message, 'the provider\'s definitive rejection surfaces (the stored terminal failure)').toContain('definitive provider reject');
    const rowsAfterReject = await readProviderOperations(executionId);
    expect(rowsAfterReject.length).toBe(1);
    expect(rowsAfterReject[0]!.state, 'DEFINITIVE_REJECT → terminal FAILED is ALLOWED (the provider guarantees no operation exists)').toBe('failed');
    expect(rowsAfterReject[0]!.generation).toBe(1);
    expect(rowsAfterReject[0]!.handle).toBeNull();
    expect(rowsAfterReject[0]!.errorMessage, 'the ONE terminal result is the provider\'s definitive rejection').toContain('definitive provider reject');

    // The replay leg (key immutability for the reject arm): a later
    // same-key submit surfaces the STORED failure with ZERO submissions —
    // a terminally rejected operation is a KNOWN outcome (no second
    // operation under the same key).
    const gateState = await readDispatchGate(executionId);
    expect(gateState.dispatchKey, 'the dispatch key was recorded with the gate-open (the same logical handoff identity)').toBeTruthy();
    const recordForTask = await executionRecordRepo.findByExecutionId(executionId);
    const builtTask = await executionTaskService.build({
      workItemId: recordForTask!.workItemId,
      mode: 'external',
      provider: recordForTask!.provider,
      model: recordForTask!.model,
      executionId,
      implementationContextId: recordForTask!.implementationContextId,
    });
    const replayProvider = new SideEffectingExternalProvider(
      {
        operationStore: new PgExecutionProviderOperationRepository(second!.client),
        logger: stack.db.logger,
        operationResolutionWindowMs: 150,
        operationPollIntervalMs: 10,
      },
      {},
      platform,
    );
    await expect(
      replayProvider.submit({ ...builtTask.task, dispatchIdempotencyKey: gateState.dispatchKey! }),
      'a same-key submit against the terminally rejected operation surfaces the STORED failure',
    ).rejects.toThrow(/definitive provider reject/);
    expect(replayProvider.submissionCount, 'ZERO submissions — the rejected key never starts a new operation').toBe(0);
    expect(replayProvider.effectCount, 'ZERO effects FOREVER (the provider refused; no operation exists)').toBe(0);
    expect(replayProvider.resolveCount, 'ZERO resolutions').toBe(0);
    expect(platform.size, 'the platform STILL holds NO operation').toBe(0);
    expect(stats.completeTrueCount, 'NO authoritative outcome write (the dispatch failed)').toBe(0);
  });

  it('R11-#3. the repository TAXONOMY proofs — reject is the pending-ONLY definitive-reject gate (a started row\'s reject hits 0 rows; a wrong generation hits 0 rows) + fail is the started-ONLY resolution-failure gate (a PENDING row\'s fail hits 0 rows — the ambiguous-submission guard is STRUCTURAL: an unconfirmed submission has NO resolution-failure path at all)', async () => {
    const { executionId } = await createNativeRecord('failed');
    const store = new PgExecutionProviderOperationRepository(second!.client);

    // ---------------- THE REJECT GATE (pending → failed ONLY) ----------------
    const rejectKey = `r11-reject-gate-${executionId}`;
    await store.register({
      idempotencyKey: rejectKey, provider: 'external', executionId, mode: 'external',
    });
    // A WRONG generation can never reject (the generation fence).
    await store.reject(rejectKey, 7, 'a wrong generation can NEVER resolve');
    expect((await store.get(rejectKey))!.state, 'a WRONG generation rejected NOTHING (the row stays pending)').toBe('pending');
    // The CORRECT generation rejects the pending row — the ONLY
    // 'pending' → 'failed' transition (the definitive-reject gate).
    await store.reject(rejectKey, 1, 'the provider definitively refused the operation');
    const rejectedRow = await store.get(rejectKey);
    expect(rejectedRow!.state, 'the DEFINITIVE-REJECT CAS transitions the pending row to failed').toBe('failed');
    expect(rejectedRow!.generation).toBe(1);
    expect(rejectedRow!.errorMessage).toBe('the provider definitively refused the operation');
    // A terminal row is unreachable by either transition.
    await store.reject(rejectKey, 1, 'a second reject attempt on a terminal row');
    await store.fail(rejectKey, 1, 'a fail attempt on a terminal row');
    expect((await store.get(rejectKey))!.errorMessage, 'the terminal result is IMMUTABLE').toBe('the provider definitively refused the operation');

    // ---------------- THE FAIL GATE (started → failed ONLY) ----------------
    const failKey = `r11-fail-gate-${executionId}`;
    await store.register({
      idempotencyKey: failKey, provider: 'external', executionId, mode: 'external',
    });
    // THE STRUCTURAL AMBIGUOUS-SUBMISSION GUARD: a PENDING row's fail hits
    // 0 rows — the unconfirmed submission has NO resolution-failure path at
    // all. (Round 10 accepted 'pending' OR 'started' here; the round-11
    // taxonomy splits them: only the DEFINITIVE-REJECT gate may close a
    // pending key.)
    await store.fail(failKey, 1, 'a resolution failure cannot touch an UNCONFIRMED row');
    const pendingAfterFail = await store.get(failKey);
    expect(pendingAfterFail!.state, 'fail REQUIRES started — a pending row is structurally unreachable (the ambiguous-submission guard)').toBe('pending');
    expect(pendingAfterFail!.errorMessage, 'nothing was written to the pending row').toBeNull();
    // Attach (the provider-confirmed start) — and NOW the resolution
    // failure lands on the started row.
    expect(await store.attachOperation(failKey, 1, `external-package:${failKey}`)).toBe(true);
    await store.fail(failKey, 1, 'the confirmed operation\'s resolution failed');
    const failedRow = await store.get(failKey);
    expect(failedRow!.state, 'the STARTED row\'s resolution failure terminally fails the key').toBe('failed');
    expect(failedRow!.errorMessage).toBe('the confirmed operation\'s resolution failed');

    // ---------------- THE CROSS GATES (each transition is state-narrow) ----------------
    const mixedKey = `r11-mixed-gate-${executionId}`;
    await store.register({
      idempotencyKey: mixedKey, provider: 'external', executionId, mode: 'external',
    });
    expect(await store.attachOperation(mixedKey, 1, `external-package:${mixedKey}`)).toBe(true);
    // A STARTED row's reject hits 0 rows (reject is the pending-only gate —
    // a confirmed operation cannot be "un-submitted").
    await store.reject(mixedKey, 1, 'a definitive reject cannot touch a STARTED row');
    const startedRow = await store.get(mixedKey);
    expect(startedRow!.state, 'the started row is untouched by the reject gate').toBe('started');
    expect(startedRow!.errorMessage).toBeNull();
    // A stale generation's reject also hits 0 rows (the generation fence on
    // the definitive-reject transition).
    await store.reject(mixedKey, 99, 'a stale generation reject');
    expect((await store.get(mixedKey))!.state, 'the stale generation\'s reject hit 0 rows').toBe('started');
    expect((await store.get(mixedKey))!.errorMessage).toBeNull();
  });
// =========================================================================
  // WORK-043 (AR-043-03) — the TIMESTAMP dimension of the retried logical
  // handoff. The architect's preservation invariants:
  //
  //     one authoritative dispatch event
  //     no parallel usage ledger
  //     idempotent replay preserves original dispatch timestamp
  //     handoff snapshots preserve original timestamp
  //     same logical handoff retried → no timestamp mutation
  //
  // The interleaving below is the R6-#2 reclaim-re-dispatch shape with
  // DIVERGENT INJECTABLE CLOCKS on every actor, so the timestamp assertions
  // are deterministic (a re-stamp would carry the later actor's clock —
  // impossible to miss):
  //
  //   T1 (instance A, clock T1) dispatches; its resolution parks INSIDE
  //   resolveOperation (the row is 'started' @ generation 1 — the submission
  //   is CONFIRMED, the outcome not yet resolved); the 150ms lease expires →
  //   T2 (the boot sweep) reclaims (epoch N+1), takes over the in-flight
  //   gate, and RE-DISPATCHES the SAME logical handoff through a FRESH
  //   instance (B, second client, clock T2 = T1+1h): the durable ledger
  //   converges B's same-key submit onto the ONE in-flight operation (B
  //   awaits — ZERO submissions, ZERO resolutions) → T1's parked resolution
  //   completes and its derivation stamps dispatchedAt = T1 (its OWN clock)
  //   → the generation-fenced CAS stores the ONE result → B's await REPLAYS
  //   the stored package VERBATIM (dispatchedAt = T1 — NOT T2's clock) → B's
  //   completeFencedDispatch commits the ONE authoritative outcome write →
  //   T1's resumed completion is fenced out (0 rows — NO outcome write) → a
  //   THIRD fresh instance (C, clock T3 = T1+2h) replays the SAME key
  //   post-completion (a pure replay — ZERO submissions/resolutions/drives)
  //   and STILL observes dispatchedAt = T1.
  //
  // THE AR-043-03 INVARIANT: the rate-limit window's event-time anchor —
  // package_json.dispatchedAt — is the FIRST dispatch's stamp for the whole
  // life of the operation. No retry (the reclaiming owner's re-dispatch), no
  // stale completion (T1's discarded write), and no later same-key replay
  // (instance C) ever mutates it.
  // =========================================================================
  it("R-W43-#1 (AR-043-03). the RETRIED logical handoff + every idempotent same-key replay preserve the ORIGINAL dispatch timestamp — the reclaiming owner's re-dispatch (a LATER clock, a FRESH instance) REPLAYS the first dispatch's stored package VERBATIM (dispatchedAt never re-stamped; the stale owner's late completion mutates NOTHING)", async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const stats: DispatchGateStats = { beginCount: 0, completeTrueCount: 0, completeFalseCount: 0 };

    // The three actors' INJECTABLE CLOCKS: A (the original dispatcher) at
    // T1; B (the reclaiming owner) at T2 = T1 + 1h; C (the post-completion
    // replayer) at T3 = T1 + 2h. If ANY actor re-stamped the package, its
    // dispatchedAt would carry that actor's clock — every assertion below
    // pins the ORIGINAL T1 stamp instead.
    const t1ClockMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const t2ClockMs = t1ClockMs + 60 * 60 * 1000;
    const t3ClockMs = t1ClockMs + 2 * 60 * 60 * 1000;
    const t1Iso = new Date(t1ClockMs).toISOString();

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat, dispatching through
    // provider instance A (client 1, clock T1) whose ONE resolution PARKS
    // INSIDE resolveOperation (the row is 'started' @ generation 1 — the
    // submission CONFIRMED, the derivation not yet run).
    let resolveSubmit!: () => void;
    const submitGate = new Promise<void>((r) => { resolveSubmit = r; });
    const providerA = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
      logger: stack.db.logger,
      parkAtResolve: submitGate,
      now: () => new Date(t1ClockMs),
    });
    const t1Service = buildT1Service({
      leaseMs: 150,
      heartbeatMs: 60_000,
      stats,
      externalProvider: providerA,
    });

    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `w43-retry-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is stalled INSIDE its in-flight resolution, then let the
    // 150ms lease expire while T1 is stalled (no heartbeat renews).
    await waitFor(() => providerA.inResolve, 5000);
    const rowsAtStall = await readProviderOperations(executionId);
    expect(rowsAtStall.length, 'T1 OPENED exactly ONE durable provider-operation ledger row').toBe(1);
    expect(rowsAtStall[0]!.state, 'the operation is CONFIRMED + IN FLIGHT (STARTED — the derivation not yet run)').toBe('started');
    expect(rowsAtStall[0]!.handle, 'the provider-confirmed identity was durably ATTACHED before the resolution parked').not.toBeNull();
    expect(providerA.submissionCount, 'T1 performed exactly ONE idempotent submission').toBe(1);
    expect(providerA.resolveCount, 'T1 is parked INSIDE its ONE resolution (the derivation not yet run — dispatchedAt not yet stamped)').toBe(1);
    expect(providerA.driveCount, 'the KEYED path NEVER runs the unkeyed body seam').toBe(0);
    await delay(300);

    // T2 (the boot sweep) reclaims the expired lease (epoch N+1) → takes
    // over the in-flight gate → RE-DISPATCHES the same logical handoff
    // through a FRESH provider instance (B, second client) whose clock is
    // ONE HOUR LATER. B's same-key submit converges onto the STARTED row
    // (the DURABLE ledger is the authority — never instance memory) and
    // AWAITS its resolution (a LONG window — ZERO submissions/resolutions
    // from B: the re-dispatch never re-runs the derivation).
    const providerB = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(second!.client),
      logger: stack.db.logger,
      operationResolutionWindowMs: 30_000,
      operationPollIntervalMs: 10,
      now: () => new Date(t2ClockMs),
    });
    const t2Service = buildT2Service({ stats, externalProvider: providerB });
    let t2Result: { stage?: string } | undefined;
    const t2Promise = (async () => {
      t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    })();
    await waitFor(() => providerB.submitCount >= 1, 5000);
    expect(providerB.submitKeys()[0], 'B\'s re-dispatch carried the SAME handoff-derived durable key').toMatch(/^cross-mode-dispatch-/);
    expect(providerB.submissionCount, 'B\'s re-dispatch performed ZERO submissions (converged onto the ONE in-flight operation through the DURABLE ledger)').toBe(0);
    expect(providerB.resolveCount, 'B\'s re-dispatch performed ZERO resolutions — the derivation NEVER re-ran (a re-stamp is structurally impossible)').toBe(0);
    expect(providerB.driveCount, 'the KEYED path NEVER runs the unkeyed body seam (on EITHER instance)').toBe(0);

    // T1's parked resolution completes — its derivation stamps dispatchedAt
    // with ITS OWN clock (T1) — and the generation-fenced CAS stores the ONE
    // result. B's await then REPLAYS the STORED package; B completes the ONE
    // authoritative outcome through the fence.
    resolveSubmit();
    await t2Promise;
    expect(t2Result!.stage, 'T2 reclaimed, re-dispatched, converged onto the ONE operation, + completed the handoff').toBe('complete');

    // THE AR-043-03 INVARIANT — the authoritative outcome (T2's write, the
    // ONE completion that committed) carries the FIRST dispatch's stamp:
    // dispatchedAt = T1 (the original dispatcher's clock), NOT T2's — the
    // reclaiming owner's re-dispatch NEVER re-stamped the package.
    const afterT2 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT2!.id).toBe(recordId);
    expect(afterT2!.mode).toBe('external');
    expect(afterT2!.status).toBe('handoff_ready');
    expect(afterT2!.packageValue, 'the authoritative outcome write holds the converged operation\'s package').not.toBeNull();
    expect(
      afterT2!.packageValue!.dispatchedAt,
      'AR-043-03: package_json.dispatchedAt is the FIRST dispatch\'s stamp (T1\'s clock) — the re-dispatching actor\'s LATER clock never re-stamped it',
    ).toBe(t1Iso);

    // The STORED ledger result — the replay source for every later same-key
    // submit — carries the SAME original stamp.
    const rowsAfter = await readProviderOperations(executionId);
    expect(rowsAfter.length, 'still exactly ONE durable provider operation for the whole interleaving').toBe(1);
    expect(rowsAfter[0]!.state).toBe('completed');
    expect(rowsAfter[0]!.submissionJson).not.toBeNull();
    const stored = JSON.parse(rowsAfter[0]!.submissionJson!) as { package: { dispatchedAt: string } };
    expect(
      stored.package.dispatchedAt,
      'the DURABLE provider-operation ledger stored the FIRST dispatch\'s stamp (the replay source preserves it)',
    ).toBe(t1Iso);
    expect(providerA.submissionCount + providerB.submissionCount, 'exactly ONE provider submission for the whole interleaving (A submitted; B replayed)').toBe(1);
    expect(providerA.resolveCount + providerB.resolveCount, 'exactly ONE resolution for the whole interleaving (A\'s parked resolution completed; B replayed its stored result)').toBe(1);

    // T1 resumes: its completion is FENCED OUT (0 rows — the lease is T2's
    // and the obligation is discharged) — NO outcome write, NO mutation of
    // the persisted timestamp.
    await t1Promise;
    expect(t1Error).toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'the stale owner\'s late completion was DISCARDED at the atomic completion').toBe('claim-fence-lost');
    expect(stats.completeTrueCount, 'exactly ONE authoritative outcome write committed (T2\'s)').toBe(1);
    expect(stats.completeFalseCount, 'T1\'s late completion was discarded (0 rows)').toBe(1);
    const afterT1 = await executionRecordRepo.findByExecutionId(executionId);
    expect(afterT1!.packageValue, 'the stale owner\'s late completion wrote NOTHING (byte-identical package)').toEqual(afterT2!.packageValue);
    expect(
      afterT1!.packageValue!.dispatchedAt,
      'AR-043-03: the retried logical handoff did NOT mutate the persisted dispatch timestamp',
    ).toBe(t1Iso);

    // A THIRD fresh instance (C — yet another instance boundary, clock T3 =
    // T1 + 2h): the post-completion same-key submit is a PURE REPLAY (ZERO
    // submissions, ZERO resolutions, ZERO drives) of the STORED operation —
    // the idempotent replay returns the ORIGINAL package VERBATIM,
    // dispatchedAt included.
    const gateAfter = await readDispatchGate(executionId);
    expect(gateAfter.dispatchState).toBe('completed');
    expect(gateAfter.dispatchKey).toBe(rowsAfter[0]!.idempotencyKey);
    const providerC = new InstrumentedExternalProvider({
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
      logger: stack.db.logger,
      now: () => new Date(t3ClockMs),
    });
    const recordForTask = await executionRecordRepo.findByExecutionId(executionId);
    const builtTask = await executionTaskService.build({
      workItemId: recordForTask!.workItemId,
      mode: 'external',
      provider: recordForTask!.provider,
      model: recordForTask!.model,
      executionId,
      implementationContextId: recordForTask!.implementationContextId,
    });
    const replaySubmission = await providerC.submit({
      ...builtTask.task,
      dispatchIdempotencyKey: gateAfter.dispatchKey!,
    });
    expect(providerC.submitCount, 'instance C submitted once').toBe(1);
    expect(providerC.submissionCount, 'instance C performed ZERO submissions — a pure post-completion REPLAY').toBe(0);
    expect(providerC.resolveCount, 'instance C performed ZERO resolutions — the terminal row replays directly').toBe(0);
    expect(providerC.driveCount, 'instance C performed ZERO drives — the terminal row replays directly').toBe(0);
    expect(replaySubmission.package, 'the replay returned a package (the stored operation result)').toBeDefined();
    expect(
      replaySubmission.package!.dispatchedAt,
      'AR-043-03: the idempotent same-key replay preserves the ORIGINAL dispatch timestamp (T1\'s stamp — 2 hours before C\'s clock)',
    ).toBe(t1Iso);
    expect(replaySubmission.package, 'the replayed package is the STORED operation result (byte-identical — dispatchedAt included)').toEqual(afterT2!.packageValue);

    // FINAL: ONE ledger row, COMPLETED, its stored result UNCHANGED by the
    // replay; the record's package_json — the rate-limit window's event-time
    // source — still carries the FIRST dispatch's stamp.
    const rowsFinal = await readProviderOperations(executionId);
    expect(rowsFinal.length).toBe(1);
    expect(rowsFinal[0]!.submissionJson, 'the ONE stored result is UNCHANGED by the replay').toBe(rowsAfter[0]!.submissionJson);
    const finalRecord = await executionRecordRepo.findByExecutionId(executionId);
    expect(finalRecord!.packageValue!.dispatchedAt, 'FINAL: package_json.dispatchedAt is STILL the FIRST dispatch\'s stamp — never mutated across the whole retried-handoff interleaving').toBe(t1Iso);
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions').toBe(1);
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
  });
});
