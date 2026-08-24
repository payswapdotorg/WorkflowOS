/**
 * WORK-032: DefaultBenchmarkService — the application-layer orchestrator that
 * ties together snapshot, experiment, trial, metrics, integrity, export, and
 * recommendation (§8).
 *
 * This service:
 *   - freezes snapshots (via the snapshot service)
 *   - creates experiments + trials (§5)
 *   - starts/pauses/cancels experiments (§45)
 *   - runs trials (via the trial orchestrator) — delegates to ExecutionService
 *   - collects metrics after trial completion (via the metric collector)
 *   - records integrity (§32)
 *   - exports results (§40)
 *   - recommends (§42)
 *
 * It does NOT create another workflow/verification/review/CI engine (§34).
 * It reads authoritative state through the existing public contracts.
 *
 * Boundary: imports the benchmark internal services + @modules/* barrels.
 */
import type {
  BenchmarkTaskSnapshot,
  BenchmarkExperiment,
  BenchmarkTrial,
  BenchmarkTrialMetrics,
  BenchmarkReviewFinding,
  BenchmarkIntegrityRecord,
  BenchmarkComparison,
  BenchmarkSnapshotPreview,
  BenchmarkExportFormat,
  BenchmarkRecommendation,
  BenchmarkCellStatistics,
  CreateBenchmarkSnapshotInput,
  CreateBenchmarkExperimentInput,
  BenchmarkTrialSpec,
  BenchmarkService,
} from '../types.js';
import type {
  DefaultBenchmarkServiceDeps,
  BenchmarkTrialRunner,
} from './benchmark.types.js';
import {
  BENCHMARK_HARNESS_VERSION,
  BENCHMARK_SCORING_VERSION,
  buildTrialBranchName,
} from './benchmark-helpers.js';

/**
 * PR #36 review fix #3: default TTL (ms) for the `finalizing` reservation
 * lease. A worker that wins `claimExperimentCompletion` (running →
 * finalizing) sets `finalizing_lease_expires_at = NOW() + ttl`. If the
 * worker dies before finalizing, the lease eventually expires and a
 * recovery worker can reclaim the reservation via
 * `recoverStaleFinalizingExperiment`. 2 minutes is long enough for
 * integrity validation + the finalization CAS under normal conditions;
 * short enough that a crashed worker's reservation is reclaimed within a
 * tolerable window. The `finalizingLeaseTtlMs` dep overrides this (e.g.
 * tests may pass a shorter TTL).
 */
const DEFAULT_FINALIZING_LEASE_TTL_MS = 120_000;

export class DefaultBenchmarkService implements BenchmarkService, BenchmarkTrialRunner {
  constructor(private readonly deps: DefaultBenchmarkServiceDeps) {}

  /** PR #36 review fix #3: the finalizing-lease TTL (dep override or default). */
  private get finalizingLeaseTtlMs(): number {
    return this.deps.finalizingLeaseTtlMs ?? DEFAULT_FINALIZING_LEASE_TTL_MS;
  }

  // --- Snapshots (§4) ---

  async previewSnapshot(input: { projectId: string; workItemId: string }): Promise<BenchmarkSnapshotPreview> {
    return this.deps.snapshotService.preview(input);
  }

  async createSnapshot(input: CreateBenchmarkSnapshotInput): Promise<BenchmarkTaskSnapshot> {
    const snapshot = await this.deps.snapshotService.create(input);
    // PR #35 review fix #5: the audit `actor` MUST be the authenticated user
    // identity (server-side), NOT the benchmark display name. The route
    // populates `input.actor` from `requireProjectAuthorization(...).id`.
    // When absent (system-initiated snapshots), fall back to 'system'.
    await this.deps.auditService.write({
      projectId: snapshot.projectId,
      eventType: 'BENCHMARK_SNAPSHOT_CREATED',
      actor: input.actor ?? 'system',
      source: 'benchmark-service',
      resourceType: 'benchmark_snapshot',
      resourceId: snapshot.id,
      metadata: { name: input.name, promptDigest: snapshot.promptDigest, baseCommit: snapshot.baseCommit },
    });
    return snapshot;
  }

  async listSnapshots(projectId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ snapshots: BenchmarkTaskSnapshot[]; total: number }> {
    return this.deps.repository.listSnapshots(projectId, opts);
  }

  async getSnapshot(snapshotId: string): Promise<BenchmarkTaskSnapshot | null> {
    return this.deps.repository.getSnapshot(snapshotId);
  }

  // --- Experiments (§5) ---

  async createExperiment(input: CreateBenchmarkExperimentInput): Promise<BenchmarkExperiment> {
    const snapshot = await this.deps.repository.getSnapshot(input.benchmarkTaskSnapshotId);
    if (!snapshot) {
      throw new Error('benchmark-experiment-snapshot-not-found');
    }
    if (snapshot.projectId !== input.projectId) {
      throw new Error('benchmark-experiment-project-mismatch');
    }

    // Validate trial specs (§2 provider matrix, §19 model configuration).
    const seenCells = new Set<string>();
    for (const spec of input.trials) {
      const key = `${spec.provider}|${spec.model ?? ''}|${spec.mode}`;
      if (seenCells.has(key)) {
        throw new Error(`benchmark-experiment-duplicate-trial-spec: ${key}`);
      }
      seenCells.add(key);
    }

    // §21: optional trial ordering randomization.
    const randomizationSeed = input.randomizeOrder
      ? (input.randomizationSeed ?? crypto.randomUUID())
      : null;
    const repetitions = input.repetitions ?? 1;

    const experiment = await this.deps.repository.createExperiment({
      organizationId: snapshot.organizationId,
      projectId: snapshot.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: input.name,
      description: input.description ?? null,
      createdBy: input.createdBy,
      status: 'created',
      randomizationSeed,
      repetitions,
    });

    // §32: record the integrity record at creation time.
    await this.deps.integrityService.record({
      experimentId: experiment.id,
      snapshotHash: snapshot.snapshotHash,
      promptDigest: snapshot.promptDigest,
      baselineCommit: snapshot.baseCommit,
      scoringVersion: snapshot.scoringVersion,
      harnessVersion: snapshot.harnessVersion,
    });

    // Create the trial rows (queued) — one per (provider, mode, repetition).
    // The execution order is assigned now (randomized if requested).
    const expandedSpecs = this.expandTrialSpecs(input.trials, repetitions);
    const orderedSpecs = randomizationSeed
      ? this.shuffle(expandedSpecs, randomizationSeed)
      : expandedSpecs;

    for (let i = 0; i < orderedSpecs.length; i++) {
      const spec = orderedSpecs[i]!;
      const trialBranch = buildTrialBranchName({
        targetBranchPrefix: snapshot.targetBranchPrefix,
        provider: spec.provider,
        mode: spec.mode,
        repetition: spec.repetition,
      });
      await this.deps.repository.createTrial({
        experimentId: experiment.id,
        benchmarkTaskSnapshotId: snapshot.id,
        organizationId: snapshot.organizationId,
        projectId: snapshot.projectId,
        provider: spec.provider,
        model: spec.model ?? null,
        executionMode: spec.mode,
        repetitionIndex: spec.repetition,
        executionOrder: i,
        randomizationSeed,
        status: 'queued',
        trialBranch,
        baselineCommit: snapshot.baseCommit,
        promptDigest: snapshot.promptDigest,
      });
    }

    await this.deps.auditService.write({
      projectId: snapshot.projectId,
      eventType: 'BENCHMARK_CREATED',
      actor: input.createdBy,
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experiment.id,
      metadata: { name: input.name, trialCount: orderedSpecs.length, repetitions },
    });

    return experiment;
  }

  async startExperiment(experimentId: string): Promise<BenchmarkExperiment> {
    const experiment = await this.deps.repository.getExperiment(experimentId);
    if (!experiment) throw new Error('benchmark-experiment-not-found');
    // PR #35 review fix (control-plane concurrency): ATOMIC START CLAIM.
    // The previous implementation was read-check-write: it read the
    // experiment, checked status ∈ {created, paused} in the application
    // layer, then ran an UNCONDITIONAL `updateExperimentStatus(...,
    // 'running')`. Under concurrent starts, BOTH callers passed the check
    // (both read 'created'), BOTH wrote 'running', BOTH emitted a
    // BENCHMARK_STARTED audit, and BOTH enqueued the queued trials —
    // duplicate auditing + duplicate queue delivery (the reviewer's
    // secondary blocker).
    //
    // The fix: a compare-and-swap (claimExperimentStart: created|paused →
    // running). Only the CAS WINNER (the caller that receives a RETURNING
    // row) performs the side effects — the BENCHMARK_STARTED audit + the
    // trial enqueues. The loser (null) threw no audit, enqueued nothing,
    // and re-reads to report the invalid-state error (mirroring the
    // sequential double-start semantics: starting an already-running
    // experiment is invalid).
    const claimed = await this.deps.repository.claimExperimentStart(experimentId);
    if (!claimed) {
      // Lost the start race OR the experiment is in a non-startable
      // state. Re-read for an accurate error message (the winner may have
      // already advanced it to 'running').
      const current = await this.deps.repository.getExperiment(experimentId);
      throw new Error(`benchmark-experiment-invalid-state: ${current?.status ?? 'unknown'}`);
    }
    // WINNER ONLY: side effects (exactly-once under concurrency).
    await this.deps.auditService.write({
      projectId: claimed.projectId,
      eventType: 'BENCHMARK_STARTED',
      actor: 'system',
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experimentId,
      metadata: {},
    });
    // PR #35 review fix #4: the benchmark trial lifecycle is EVENT-DRIVEN +
    // ASYNCHRONOUS. `startExperiment()` enqueues a `benchmark.trial` job per
    // queued trial and returns IMMEDIATELY (experiment 'running'). The
    // WorkerHost picks up each job asynchronously and calls
    // `runTrialJob(trialId)`, which advances the trial to terminal + collects
    // metrics + checks experiment completion.
    //
    // The experiment stays 'running' until EVERY trial is terminal. It is
    // NEVER marked 'completed' while an external trial is only
    // 'handoff_ready'/'running' (the core correctness invariant from review
    // fix #4).
    const { trials } = await this.deps.repository.listTrials(experimentId, { limit: 1000 });
    for (const trial of trials) {
      // PR #35 follow-up: filter by the explicit phase (queued = not yet
      // claimed by an orchestrator worker). Equivalent to status='queued'
      // for freshly created trials, but phase-aware for the rare case of a
      // re-start after a partial run.
      if (trial.lifecyclePhase !== 'queued') continue;
      await this.deps.queue.enqueue('benchmark.trial', { trialId: trial.id });
    }
    // If there are no queued trials (defensive: empty experiment), finalize
    // immediately. Otherwise the worker drives completion.
    await this.checkExperimentCompletion(experimentId);
    const running = await this.deps.repository.getExperiment(experimentId);
    return running ?? claimed;
  }

  /**
   * PR #35 review fix v2 (Blocker A + Blocker B): the WorkerHost calls this
   * for each `benchmark.trial` job. NON-BLOCKING, RE-ENTRANT state machine
   * that advances a single trial through the orchestrator → execution →
   * delivery phases, then finalizes (collect metrics + audit + check
   * experiment completion). The trial is re-advanced by event-driven
   * composition hooks (`onExecutionTerminal` on the ingestion service +
   * `onTransition` on the workflow engine — both wired in app.ts), NOT by
   * bounded polling. There is NO `externalTimeoutMs` and NO
   * `awaitExternalCompletion` poll.
   */
  async runTrialJob(trialId: string): Promise<void> {
    const trial = await this.deps.repository.getTrial(trialId);
    if (!trial) {
      this.deps.logger.warn('benchmark.trial.trial-not-found', { trialId });
      return;
    }

    // PR #35 follow-up (idempotency): route by the EXPLICIT persisted phase
    // (lifecycle_phase), not the coarse `status`. Each phase has exactly
    // one advancement path; a duplicate delivery observes the current phase
    // + either no-ops (terminal / starting) or advances through the same
    // compare-and-swap (the claim returns null for the loser → no side
    // effects). This is the "duplicate job → observe already-advanced state
    // → NO side effects" invariant the review requires.
    const phase = trial.lifecyclePhase;

    // Terminal phases: re-check experiment completion (redelivery after the
    // last trial finalized) + return. No further advancement.
    if (phase === 'completed' || phase === 'failed') {
      this.deps.logger.info('benchmark.trial.skipped-terminal', { trialId, phase });
      await this.checkExperimentCompletion(trial.experimentId);
      return;
    }

    // STARTING: another worker has CLAIMED the trial (atomic queued→starting)
    // + is mid-setup (clone / branch / submit). A duplicate delivery MUST
    // NOT re-run orchestration (the claim is exclusive — only one worker
    // won) + MUST NOT finalize (the claiming worker is still setting up;
    // the trial is not in a wait phase yet). Just return — the claiming
    // worker will advance to execution_wait/delivery_wait when setup
    // completes, + the event hooks will re-enqueue.
    //
    // This closes the THIRD race (a redelivery arriving while the
    // orchestrator is still mid-setup would otherwise read `running`,
    // observe executionId=null, + finalize the active trial as
    // 'execution-record-not-found'). The `starting` phase makes that
    // redelivery a no-op.
    if (phase === 'starting') {
      this.deps.logger.info('benchmark.trial.skipped-starting', { trialId });
      return;
    }

    // QUEUED: the claim has not happened yet. Run the orchestrator — it
    // atomically claims (queued→starting). If the claim is lost (another
    // worker won), the orchestrator returns WITHOUT side effects. For
    // native execution that itself FAILED at submit time, the orchestrator
    // sets the trial 'failed' terminal immediately (atomic
    // starting→failed).
    if (phase === 'queued') {
      try {
        await this.deps.trialOrchestrator.runTrial(trial);
      } catch (err) {
        // Unexpected error during orchestration — defensive outer catch
        // (the orchestrator handles its own internal failures via
        // failTrial + returns; this only fires for truly unexpected
        // throws, e.g. a repository DB error).
        this.deps.logger.error('benchmark.trial.orchestration-failed', {
          trialId, error: (err as Error).message,
        });
        await this.failTrialFromError(trial, err as Error);
        return;
      }
      await this.checkExperimentCompletion(trial.experimentId);
      return;
    }

    // EXECUTION_WAIT: the orchestrator submitted (external mode) + is
    // awaiting the `onExecutionTerminal` ingestion hook. Read the
    // authoritative execution record. If terminal-completed → advance to
    // delivery_wait (atomic). If terminal-failed → claimTerminal(failed)
    // (atomic). If non-terminal → return (the hook will re-enqueue). NO
    // bounded poll.
    if (phase === 'execution_wait') {
      // Defensive: execution_wait should only occur for external mode
      // (native skips to delivery_wait since its execution is
      // synchronous-completed). A native trial in execution_wait is a
      // state-machine invariant violation — fail it.
      if (trial.executionMode !== 'external' || !trial.executionId) {
        await this.finalizeTrial(trial, 'execution_wait', {
          status: 'failed',
          failureKind: 'infrastructure',
          failureReason: 'execution-wait-without-external-execution',
        });
        return;
      }
      const record = await this.deps.executionRecordRepository.findByExecutionId(trial.executionId);
      if (!record) {
        // The execution record vanished (shouldn't happen — it was created
        // by executionService.submit at orchestrator time). Fail the trial
        // (infrastructure) via the atomic terminal claim.
        await this.finalizeTrial(trial, 'execution_wait', {
          status: 'failed',
          failureKind: 'infrastructure',
          failureReason: 'execution-record-not-found',
        });
        return;
      }
      const status = record.status;
      if (status === 'completed') {
        // Atomic execution_wait → delivery_wait. If null, another worker
        // advanced (or terminalized) — re-check experiment completion.
        const advanced = await this.deps.repository.advanceToDeliveryWait(trial.id);
        if (!advanced) {
          await this.checkExperimentCompletion(trial.experimentId);
          return;
        }
        // Now in delivery_wait — drive the delivery phase with the
        // advanced row (re-read the authoritative workflow state).
        await this.driveDeliveryPhase(advanced);
        return;
      }
      if (status === 'failed' || status === 'expired' || status === 'cancelled') {
        await this.finalizeTrial(trial, 'execution_wait', {
          status: 'failed',
          failureKind: 'engineering',
          failureReason: `external-execution-${status}`,
        });
        return;
      }
      // Non-terminal: stay in execution_wait. The `onExecutionTerminal`
      // composition hook (wired in app.ts) re-enqueues `benchmark.trial`
      // when the ingestion service observes a terminal event for this
      // executionId. NO bounded poll.
      return;
    }

    // DELIVERY_WAIT: execution terminal-completed; awaiting the workflow
    // `onTransition` hook to report `verified` (or a terminal failure).
    if (phase === 'delivery_wait') {
      await this.driveDeliveryPhase(trial);
      return;
    }

    // Defensive: unknown phase — log + skip.
    this.deps.logger.warn('benchmark.trial.unknown-phase', { trialId, phase });
  }

  /**
   * PR #35 follow-up (idempotency): drive the DELIVERY PHASE for a trial in
   * `delivery_wait`. Read the authoritative workflow state for the trial's
   * cloned work item. `verified` (terminal success) → trial 'completed'
   * (atomic claimTerminal). Terminal failure states → trial 'failed'
   * (engineering, atomic claimTerminal). Anything else → return (the
   * `onTransition` composition hook will re-advance when the work item
   * reaches a terminal state). NO bounded poll.
   */
  private async driveDeliveryPhase(trial: BenchmarkTrial): Promise<void> {
    if (!trial.workItemId) {
      // Defensive: trial has no cloned work item (shouldn't happen — the
      // orchestrator set it). Fail the trial (infrastructure) via the
      // atomic terminal claim.
      await this.finalizeTrial(trial, 'delivery_wait', {
        status: 'failed',
        failureKind: 'infrastructure',
        failureReason: 'trial-missing-work-item',
      });
      return;
    }
    const wf = await this.deps.workflowEngine.getState(trial.workItemId);
    if (!wf) {
      // Defensive: no workflow execution row (shouldn't happen — the
      // orchestrator created one). Leave the trial in delivery_wait; the
      // `onTransition` hook (or a redelivery) will re-advance.
      return;
    }
    if (wf.currentState === 'verified') {
      await this.finalizeTrial(trial, 'delivery_wait', { status: 'completed' });
      return;
    }
    if (
      wf.currentState === 'verification_failed' ||
      wf.currentState === 'implementation_blocked'
    ) {
      await this.finalizeTrial(trial, 'delivery_wait', {
        status: 'failed',
        failureKind: 'engineering',
        failureReason: `delivery-${wf.currentState}`,
      });
      return;
    }
    // Still delivering (pr_open → verifying → architect_review → approved
    // → merged, etc.). Wait for the `onTransition` composition hook.
    return;
  }

  /**
   * PR #35 review fix v2 / Blocker A: re-advance every trial pointing at
   * the given external executionId. Wired in app.ts as the
   * `onExecutionTerminal` callback on `DefaultExecutionEventIngestionService`
   * — fires when an external execution reaches a terminal state
   * (completed / failed). Each matching trial is re-enqueued onto the
   * `benchmark.trial` queue; the worker re-enters `runTrialJob` and
   * advances the trial through the delivery phase.
   */
  async advanceTrialsForExecution(executionId: string): Promise<void> {
    const trials = await this.deps.repository.listTrialsByExecutionId(executionId);
    if (trials.length === 0) return;
    this.deps.logger.info('benchmark.trial.advance-for-execution', {
      executionId, trialCount: trials.length,
    });
    for (const t of trials) {
      // Only re-advance trials that are still 'running' (skip terminal —
      // they would no-op anyway + skip queued — the orchestrator hasn't
      // run yet).
      if (t.status === 'running') {
        await this.deps.queue.enqueue('benchmark.trial', { trialId: t.id });
      }
    }
  }

  /**
   * PR #35 review fix v2 / Blocker B: re-advance every trial pointing at
   * the given cloned workItemId. Wired in app.ts as the `onTransition`
   * callback on `DefaultWorkflowEngine` — fires when the work item
   * reaches `verified` or a terminal failure state
   * (`verification_failed` / `implementation_blocked`). Each matching
   * trial is re-enqueued onto the `benchmark.trial` queue; the worker
   * re-enters `runTrialJob` and finalizes the trial.
   */
  async advanceTrialsForWorkItem(workItemId: string): Promise<void> {
    const trials = await this.deps.repository.listTrialsByWorkItem(workItemId);
    if (trials.length === 0) return;
    this.deps.logger.info('benchmark.trial.advance-for-work-item', {
      workItemId, trialCount: trials.length,
    });
    for (const t of trials) {
      if (t.status === 'running') {
        await this.deps.queue.enqueue('benchmark.trial', { trialId: t.id });
      }
    }
  }

  /**
   * PR #35 follow-up (idempotency): Finalize a trial via an ATOMIC TERMINAL
   * CLAIM. Compare-and-swap from a non-terminal phase (execution_wait or
   * delivery_wait) to a terminal phase (completed/failed). Only the worker
   * that wins the claim (claimTerminal returns a row) may collect metrics
   * + insert findings + write audit — exactly-once by construction. The
   * LOSER (null) MUST skip ALL side effects (another worker already
   * finalized).
   *
   * This closes the `running → terminal` finalization race identified in
   * the PR #35 follow-up review: two terminal-advancement jobs can no
   * longer both finalize the same trial and both collect metrics + insert
   * findings (duplicate rows) + write audit events (duplicate events).
   */
  private async finalizeTrial(
    trial: BenchmarkTrial,
    fromPhase: 'execution_wait' | 'delivery_wait',
    outcome:
      | { status: 'completed' }
      | { status: 'failed'; failureKind: 'infrastructure' | 'engineering' | 'configuration'; failureReason: string },
  ): Promise<void> {
    // ATOMIC TERMINAL CLAIM. Returns the claimed row ONLY for the winner.
    // null = another worker already finalized (or the trial is not in the
    // expected fromPhase). The LOSER skips metrics/findings/audit.
    const claimed = await this.deps.repository.claimTerminal(trial.id, fromPhase, outcome);
    if (!claimed) {
      this.deps.logger.info('benchmark.trial.finalize-lost-race', {
        trialId: trial.id, fromPhase, outcome: outcome.status,
      });
      // Still re-check experiment completion (the winner may have been
      // the last trial; this worker's re-check is idempotent via
      // claimExperimentCompletion).
      await this.checkExperimentCompletion(trial.experimentId);
      return;
    }
    const current = claimed;

    // Collect metrics from authoritative state (only after the trial reached
    // a terminal outcome — never while still running). EXACTLY-ONCE: only
    // the terminal-claim winner reaches here.
    try {
      const metrics = await this.deps.metricCollector.collect(current);
      await this.deps.repository.upsertMetrics(metrics);
      const findings = await this.deps.metricCollector.collectFindings(current);
      for (const f of findings) {
        await this.deps.repository.insertFinding(f);
      }
    } catch (err) {
      this.deps.logger.warn('benchmark.trial.metrics-collection-failed', {
        trialId: trial.id, error: (err as Error).message,
      });
    }

    // Audit the trial outcome. EXACTLY-ONCE (only the winner).
    await this.deps.auditService.write({
      projectId: trial.projectId,
      eventType: current.status === 'completed' ? 'TRIAL_COMPLETED' : 'TRIAL_FAILED',
      actor: 'benchmark-orchestrator',
      source: 'benchmark-service',
      resourceType: 'benchmark_trial',
      resourceId: trial.id,
      metadata: { status: current.status, provider: trial.provider, mode: trial.executionMode },
    });

    // Check experiment completion — marks the experiment 'completed' ONLY
    // when every trial is terminal (atomic experiment claim — see below).
    await this.checkExperimentCompletion(trial.experimentId);
  }

  /**
   * Finalize a trial as 'failed' (infrastructure) from an unexpected
   * orchestration error. Used by the QUEUED → orchestrator path when
   * `trialOrchestrator.runTrial` throws (the orchestrator's own catch
   * already handles its internal failures + persists a 'failed' row via
   * the atomic `failFromStarting`, but a defensive outer catch is required
   * for unexpected throw-paths, e.g. a repository DB error).
   *
   * PR #35 follow-up (idempotency): phase-aware + atomic. Only terminalizes
   * if the trial is still in `starting` (the claim succeeded but setup threw
   * before advancing). If the trial already advanced to
   * execution_wait/delivery_wait (rare — advance is the last step), do NOT
   * clobber its phase (the orchestrator's successful setup is preserved; a
   * redelivery re-advances through the wait phase). The atomic
   * `failFromStarting` claim ensures exactly-once metrics + audit (only
   * the winner collects side effects).
   */
  private async failTrialFromError(trial: BenchmarkTrial, err: Error): Promise<void> {
    // ATOMIC starting → failed. Returns the claimed row ONLY for the
    // winner. null = the trial already advanced past `starting` (do NOT
    // clobber) OR already terminal.
    const claimed = await this.deps.repository.failFromStarting(
      trial.id, 'infrastructure', err.message,
    );
    if (!claimed) {
      // Trial already advanced past 'starting' (orchestrator succeeded
      // setup but threw after — rare) OR already terminal. Do NOT clobber
      // its phase. Log + re-check experiment completion.
      this.deps.logger.warn('benchmark.trial.fail-from-error-lost-race', {
        trialId: trial.id, error: err.message,
      });
      await this.checkExperimentCompletion(trial.experimentId);
      return;
    }
    // Won the terminal claim — collect metrics + audit (exactly-once).
    try {
      const metrics = await this.deps.metricCollector.collect(claimed);
      await this.deps.repository.upsertMetrics(metrics);
    } catch {
      // Swallow — best-effort metrics on an error path.
    }
    await this.deps.auditService.write({
      projectId: trial.projectId,
      eventType: 'TRIAL_FAILED',
      actor: 'benchmark-orchestrator',
      source: 'benchmark-service',
      resourceType: 'benchmark_trial',
      resourceId: trial.id,
      metadata: { status: 'failed', reason: err.message },
    });
    await this.checkExperimentCompletion(trial.experimentId);
  }

  /**
   * Two-phase experiment completion protocol (PR #36 review fix #2) with a
   * crash-safe recovery path (PR #36 review fix #3) + fencing generation
   * (PR #36 review fix #4):
   *
   *   0. RECOVERY (PR #36 review fix #3 + #4): if the experiment is already
   *      in `finalizing` with a STALE (expired) lease, a previous worker
   *      won the reservation but died before finalizing. The recovery CAS
   *      (recoverStaleFinalizingExperiment) reclaims + renews the lease +
   *      INCREMENTS the fencing generation so the recovering worker re-enters
   *      the protocol at phase 2 with a NEW generation. The stale worker's
   *      old generation is FENCED (its finalization CAS rejects). Without
   *      this, the experiment would be permanently stuck in `finalizing`
   *      (the durable reservation the reviewer flagged) OR a stale worker
   *      could finalize after a newer worker reclaimed (the fencing hole
   *      the reviewer flagged).
   *   1. RESERVATION (exactly-once CAS): claimExperimentCompletion
   *      running → finalizing (sets a fresh lease + a fresh generation).
   *      Only the winner proceeds; the loser (null) no-ops. `completed` is
   *      NOT made authoritative here. The winner receives the new
   *      `finalizingGeneration` value + MUST pass it to the finalization CAS.
   *   2. INTEGRITY VALIDATION (winner only): integrityService.validate.
   *      Returns BenchmarkIntegrityRecord { valid }. Thrown errors are
   *      treated as a validation failure (the experiment must not read
   *      `completed`).
   *   3. FINALIZATION (CAS, makes the status authoritative, FENCED on the
   *      generation the caller received):
   *      valid===true  → finalizeExperimentCompletion (finalizing → completed)
   *                      + audit BENCHMARK_COMPLETED
   *      valid===false → finalizeExperimentInvalidation (finalizing → invalidated)
   *                      + audit BENCHMARK_INVALIDATED
   *      The `WHERE finalizing_generation = $2` guard fences stale workers
   *      holding an OLDER generation — they cannot finalize after a newer
   *      worker reclaimed + advanced the generation.
   *
   * This closes the PR #36 review findings: (a) the prior version flipped
   * the experiment to `completed` BEFORE validation ran, so a failed
   * integrity check exposed a false successful completion. Now `completed`
   * is authoritative ONLY after integrity passes. (b) The `finalizing`
   * reservation is durable + a crashed worker's lease is reclaimable, so
   * no experiment is permanently stuck. (c) The recovering worker has
   * EXCLUSIVE ownership — a stale ghost holding an older generation is
   * fenced + cannot finalize.
   *
   * The `finalizing` reservation state is non-terminal, so no concurrent
   * worker re-enters the protocol while the winner is validating (the
   * all-terminal guard treats `finalizing` as not-yet-terminal). The
   * reservation CAS is exclusive (WHERE status='running'), so exactly one
   * worker wins — exactly-once validation + exactly-once audit. The
   * recovery CAS is also exclusive (WHERE status='finalizing' AND
   * lease < NOW()), so exactly one recovery worker wins. The finalization
   * CAS is fenced (WHERE status='finalizing' AND finalizing_generation=$2),
   * so a stale worker cannot finalize after a newer reclaim.
   *
   * Only called when every trial is terminal. If any trial is still in a
   * non-terminal phase, this is a no-op (the worker re-checks when the
   * last trial finishes). The recovery path (phase 0) is also triggered
   * POST-AUTHORIZATION by `recoverExperimentIfStale` (the authorized
   * control-plane read path) when the experiment is stuck in `finalizing`
   * — NO polling sweep, NO second execution engine (§34 invariant intact).
   */
  private async checkExperimentCompletion(experimentId: string): Promise<void> {
    const { trials } = await this.deps.repository.listTrials(experimentId, { limit: 1000 });
    if (trials.length === 0) return;
    // A trial is terminal iff its lifecycle_phase is completed/failed
    // (covers the `unavailable` high-level status too — it backfills to
    // lifecycle_phase='failed').
    const allTerminal = trials.every(
      (t) => t.lifecyclePhase === 'completed' || t.lifecyclePhase === 'failed',
    );
    if (!allTerminal) return;
    // Phase 0 — CRASH-SAFE RECOVERY (PR #36 review fix #3). Try to reclaim
    // a stale `finalizing` reservation FIRST. If a previous worker won
    // the reservation (running → finalizing) but died before finalizing,
    // its lease has expired + this CAS reclaims it (renewing the lease so
    // the recovering worker has exclusive ownership). If there is no stale
    // reservation, this returns null + we fall through to the fresh-claim
    // path. The recovery winner reuses the SAME phase 2 + phase 3 path as a
    // fresh reservation winner — only the reservation source differs.
    const recovered = await this.deps.repository.recoverStaleFinalizingExperiment(
      experimentId, this.finalizingLeaseTtlMs,
    );
    // Phase 1 — RESERVATION (exactly-once CAS, fresh path). Only the
    // winner may run integrity validation + the finalization CAS. The
    // loser (null) no-ops. Skipped if phase 0 already reclaimed a stale
    // reservation (`recovered` is non-null).
    const claimed = recovered ?? await this.deps.repository.claimExperimentCompletion(
      experimentId, this.finalizingLeaseTtlMs,
    );
    if (!claimed) return;
    // PR #36 review fix #4 — FENCING GENERATION. The reservation (whether
    // the fresh-claim path OR the recovery path) set `finalizing_generation`
    // + returned the new value on `claimed.finalizingGeneration`. The winner
    // MUST pass it to the finalization CAS so a stale worker holding an
    // OLDER generation is fenced. A null generation means the row was a
    // legacy pre-0030 `finalizing` row that somehow reached here without
    // being reclaimed (should not happen — the recovery CAS sets the
    // generation on the first reclaim via COALESCE(NULL, 0) + 1). Defensive:
    // log + return WITHOUT finalizing (do NOT finalize without fencing — a
    // missing generation means we cannot prove exclusive ownership).
    const expectedGeneration = claimed.finalizingGeneration;
    if (expectedGeneration === null) {
      this.deps.logger.error('benchmark.experiment-finalizing-missing-generation', {
        experimentId,
        reservationSource: recovered ? 'recovery' : 'fresh-claim',
      });
      return;
    }
    // Phase 2 — INTEGRITY VALIDATION (winner only). validate() returns a
    // record with `valid` (it does NOT throw on integrity failure — it
    // calls invalidateIntegrity internally + returns valid===false). A
    // thrown error (e.g. snapshot/experiment not found, DB failure) is
    // treated as a validation failure: the experiment MUST NOT read
    // `completed`.
    let valid = false;
    try {
      const record = await this.deps.integrityService.validate(experimentId);
      valid = record.valid;
    } catch (err) {
      this.deps.logger.error('benchmark.experiment-integrity-validation-failed', {
        experimentId, error: (err as Error).message,
      });
      valid = false;
    }
    // Phase 3 — FINALIZATION (CAS, makes the status authoritative). The
    // `expectedGeneration` is the fencing token — a stale worker holding
    // an older generation is fenced by the finalization CAS's
    // `WHERE finalizing_generation = $2` guard.
    if (valid) {
      const finalized = await this.deps.repository.finalizeExperimentCompletion(
        experimentId, expectedGeneration,
      );
      if (!finalized) {
        // Should not happen (the reservation is exclusive + the
        // generation matches), but the CAS makes it safe — another worker
        // already advanced the experiment (e.g. a recovery that fenced us
        // because our lease expired mid-validation).
        return;
      }
      await this.deps.auditService.write({
        projectId: claimed.projectId,
        eventType: 'BENCHMARK_COMPLETED',
        actor: 'system',
        source: 'benchmark-service',
        resourceType: 'benchmark_experiment',
        resourceId: experimentId,
        metadata: {},
      });
      return;
    }
    const invalidated = await this.deps.repository.finalizeExperimentInvalidation(
      experimentId, expectedGeneration,
    );
    if (!invalidated) {
      // Should not happen; another worker already advanced. No audit (the
      // winner that advanced wrote it).
      return;
    }
    await this.deps.auditService.write({
      projectId: claimed.projectId,
      eventType: 'BENCHMARK_INVALIDATED',
      actor: 'system',
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experimentId,
      metadata: {},
    });
  }

  async pauseExperiment(experimentId: string): Promise<BenchmarkExperiment> {
    const updated = await this.deps.repository.updateExperimentStatus(experimentId, 'paused');
    if (!updated) throw new Error('benchmark-experiment-not-found');
    await this.deps.auditService.write({
      projectId: updated.projectId,
      eventType: 'BENCHMARK_PAUSED',
      actor: 'system',
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experimentId,
      metadata: {},
    });
    return updated;
  }

  async cancelExperiment(experimentId: string): Promise<BenchmarkExperiment> {
    const updated = await this.deps.repository.updateExperimentStatus(experimentId, 'cancelled', { completedAt: new Date() });
    if (!updated) throw new Error('benchmark-experiment-not-found');
    await this.deps.auditService.write({
      projectId: updated.projectId,
      eventType: 'BENCHMARK_CANCELLED',
      actor: 'system',
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experimentId,
      metadata: {},
    });
    return updated;
  }

  async listExperiments(projectId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ experiments: BenchmarkExperiment[]; total: number }> {
    return this.deps.repository.listExperiments(projectId, opts);
  }

  async getExperiment(experimentId: string): Promise<BenchmarkExperiment | null> {
    // PR #35 review fix (control-plane boundary): PURE READ.
    //
    // The previous implementation triggered LAZY RECOVERY here: a read of a
    // `finalizing` experiment called checkExperimentCompletion, which runs
    // the recovery CAS + the finalization CASes + writes terminal audit
    // events. Because every route resolves the experiment's projectId via
    // `getExperiment(id)` BEFORE calling requireProjectAuthorization, that
    // made a state-mutating operation reachable BEFORE authorization — a
    // caller with NO access to the experiment's project could trigger
    // recovery (mutation + audits) on another project's experiment merely
    // by knowing its UUID. The experiment UUID is NOT an authorization
    // credential; authorization MUST precede ANY mutation, even recovery.
    //
    // The fix: this method is now a PURE read (select + map). The recovery
    // trigger moved to `recoverExperimentIfStale()`, which the route layer
    // calls ONLY AFTER requireProjectAuthorization succeeded for the
    // experiment's owning project. The system-internal worker paths
    // (runTrialJob terminal redelivery / startExperiment) keep their
    // existing checkExperimentCompletion triggers — those are queue-driven,
    // never user-supplied. NO polling sweep, NO second execution engine
    // (§34 invariant intact).
    const experiment = await this.deps.repository.getExperiment(experimentId);
    return experiment;
  }

  /**
   * PR #35 review fix (control-plane boundary): POST-AUTHORIZATION recovery
   * for a stuck `finalizing` experiment (a previous worker won the
   * reservation but died before finalizing — its lease has expired).
   *
   * CONTROL-PLANE BOUNDARY: this method MUTATES (it runs the recovery CAS +
   * the finalization CASes + writes terminal audit events). It MUST only be
   * called from a path that has ALREADY succeeded at
   * `requireProjectAuthorization` for the experiment's owning project (the
   * route layer does exactly that). It exists so read routes can recover a
   * stuck experiment AFTER authorization WITHOUT making the service-level
   * `getExperiment` impure.
   *
   * Behavior:
   *   - experiment not found → null
   *   - status ≠ 'finalizing' → returned as-is (nothing to recover — no-op)
   *   - status = 'finalizing' → runs checkExperimentCompletion (phase 0
   *     recovery CAS reclaims the expired lease + phase 2 validation +
   *     phase 3 finalization), then re-reads so the caller sees the
   *     recovered terminal state. Best-effort: a recovery failure is caught
   *     + logged and the stuck `finalizing` row is returned (a visible,
   *     debuggable stuck-state, NOT a false completion).
   */
  async recoverExperimentIfStale(experimentId: string): Promise<BenchmarkExperiment | null> {
    const experiment = await this.deps.repository.getExperiment(experimentId);
    if (!experiment) return null;
    if (experiment.status !== 'finalizing') return experiment;
    // The recovery CAS guards on `finalizing_lease_expires_at < NOW()`, so
    // an ACTIVE worker (lease not yet expired) is never preempted — the CAS
    // returns null + checkExperimentCompletion no-ops. This is the safety
    // net that ensures no experiment is permanently stuck: the moment an
    // AUTHORIZED reader reads a stuck experiment, it gets recovered.
    try {
      await this.checkExperimentCompletion(experimentId);
    } catch (err) {
      this.deps.logger.error('benchmark.experiment-finalizing-recovery-failed', {
        experimentId, error: (err as Error).message,
      });
    }
    return this.deps.repository.getExperiment(experimentId);
  }

  async listTrials(experimentId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ trials: BenchmarkTrial[]; total: number }> {
    return this.deps.repository.listTrials(experimentId, opts);
  }

  async getTrial(trialId: string): Promise<BenchmarkTrial | null> {
    return this.deps.repository.getTrial(trialId);
  }

  async getTrialMetrics(trialId: string): Promise<BenchmarkTrialMetrics | null> {
    return this.deps.repository.getMetrics(trialId);
  }

  async listTrialFindings(trialId: string): Promise<BenchmarkReviewFinding[]> {
    return this.deps.repository.listFindings(trialId);
  }

  async compareTrials(trialIds: readonly string[]): Promise<BenchmarkComparison> {
    if (trialIds.length < 2) {
      throw new Error('benchmark-comparison-requires-at-least-two-trials');
    }
    const trials: BenchmarkTrial[] = [];
    const metrics: Record<string, BenchmarkTrialMetrics> = {};
    for (const id of trialIds) {
      const trial = await this.deps.repository.getTrial(id);
      if (!trial) throw new Error(`benchmark-trial-not-found: ${id}`);
      trials.push(trial);
      const m = await this.deps.repository.getMetrics(id);
      if (m) metrics[id] = m;
    }
    // §27: prompt digest equality.
    const digestSet = new Set(trials.map((t) => t.promptDigest));
    // §28: baseline commit equality.
    const commitSet = new Set(trials.map((t) => t.baselineCommit));
    // §29: snapshot equality.
    const snapshotSet = new Set(trials.map((t) => t.benchmarkTaskSnapshotId));
    const integrityValid = digestSet.size === 1 && commitSet.size === 1 && snapshotSet.size === 1;

    // Compute per-cell statistics (§22, §23).
    const recService = this.deps.recommendationService as unknown as { computeStatsFromMetrics(trials: { provider: string; executionMode: 'native' | 'external'; status: string; id: string }[], metrics: Record<string, { correctionCycles: number | null; timeToVerifiedMs: number | null; ciFirstPass: boolean | null; verificationFirstPass: boolean | null; engineeringQualityScore: number | null }>): BenchmarkCellStatistics[] };
    const cells = recService.computeStatsFromMetrics(
      trials.map((t) => ({ provider: t.provider, executionMode: t.executionMode, status: t.status, id: t.id })),
      Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, {
        correctionCycles: v.correctionCycles,
        timeToVerifiedMs: v.timeToVerifiedMs,
        ciFirstPass: v.ciFirstPass,
        verificationFirstPass: v.verificationFirstPass,
        engineeringQualityScore: v.engineeringQualityScore,
      }])),
    );

    return {
      benchmarkTaskSnapshotId: trials[0]!.benchmarkTaskSnapshotId,
      promptDigest: trials[0]!.promptDigest,
      baselineCommit: trials[0]!.baselineCommit,
      trials,
      metrics,
      cells,
      integrityValid,
    };
  }

  async getIntegrity(experimentId: string): Promise<BenchmarkIntegrityRecord | null> {
    return this.deps.integrityService.get(experimentId);
  }

  async exportExperiment(experimentId: string, format: BenchmarkExportFormat): Promise<{ contentType: string; body: string; filename: string }> {
    return this.deps.exportService.exportExperiment(experimentId, format);
  }

  async recommend(experimentId: string): Promise<BenchmarkRecommendation | null> {
    return this.deps.recommendationService.recommend(experimentId);
  }

  // --- Helpers ---

  private expandTrialSpecs(specs: readonly BenchmarkTrialSpec[], repetitions: number): Array<BenchmarkTrialSpec & { repetition: number }> {
    const out: Array<BenchmarkTrialSpec & { repetition: number }> = [];
    for (const spec of specs) {
      const reps = spec.repetitions > 0 ? spec.repetitions : repetitions;
      for (let i = 0; i < reps; i++) {
        out.push({ ...spec, repetition: i });
      }
    }
    return out;
  }

  /**
   * Deterministic Fisher–Yates shuffle seeded by a string seed (§21). The
   * same seed always produces the same order — reproducibility (§20).
   */
  private shuffle<T>(arr: readonly T[], seed: string): T[] {
    const out = [...arr];
    let s = 0;
    for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    // xorshift32 for deterministic pseudo-randomness
    const rand = () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 0xFFFFFFFF;
    };
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/** Re-exported for the barrel + tests. */
export { BENCHMARK_HARNESS_VERSION, BENCHMARK_SCORING_VERSION };
