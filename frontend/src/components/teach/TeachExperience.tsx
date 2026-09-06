import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  teaching,
  reverseTeaching,
  ApiError,
  type ProductWorkflow,
  type ProductWorkflowVersion,
  type ProductInstallationDetail,
  type ProductTeachingSession,
  type ProductReverseTeachingSession,
  type ProductPracticeQuestion,
} from '../../api/client';
import {
  nodeLabelsFromContent,
  lessonStatusWord,
  lessonStepsFromSession,
  stepLabel,
  reverseStepsFromSession,
  expectedManualModeOf,
  formatLessonTime,
  SEMANTICS_DISCLOSURE_PHRASE,
} from './teach-language';

/**
 * TeachExperience — the §12 lesson surface + the §13 reverse-teaching
 * entry (V2-017 T9), first-class beside Run.
 *
 * Composes over EXISTING authorities only: the V2-006 teaching-session
 * service and the V2-010 reverse-teaching service through their
 * transport routes, and the V2-002 version read (the pin). HONESTY
 * RULES:
 *   - the lesson is bound to the pinned immutable version (the install
 *     pin verbatim; §31.10 — never a mutation, never a second workflow
 *     representation);
 *   - progress derives ONLY from the authoritative session read
 *     (nextCheckpointNodeId, counts, passedAssessment) — never
 *     fabricated, never client-projected;
 *   - step names come from the V2-003 presentation layer (F-T4-001);
 *     workflow-declared gaps render as honest disclosures — never
 *     invented procedure;
 *   - teaching evidence renders under a visibly distinct surface from
 *     execution evidence (§12);
 *   - resumable: pause → resume returns to the EXACT pending
 *     checkpoint (the authority's resumeCheckpointNodeId);
 *   - typed rejections render verbatim as alerts, never as state;
 *   - completed is terminal (no lifecycle commands);
 *   - the §13 reverse-teaching entry is visibly distinct (the
 *     do-it-yourself framing, the zero-runs fact) and composes the
 *     reverse-teaching authority (safety gates, manual performance).
 */

interface TeachExperienceProps {
  workflow: ProductWorkflow;
  versions: ProductWorkflowVersion[];
  installation: ProductInstallationDetail | null;
}

type SessionState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; session: ProductTeachingSession };

type ReverseState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; session: ProductReverseTeachingSession };

export default function TeachExperience({ workflow, versions, installation }: TeachExperienceProps) {
  const [sessionState, setSessionState] = useState<SessionState>({ kind: 'loading' });
  const [practiceQuestions, setPracticeQuestions] = useState<ProductPracticeQuestion[]>([]);
  const [selectedAnswer, setSelectedAnswer] = useState<Record<string, string>>({});
  // REALITY-REPAIR-008 (F-009): the practice feedback is scoped to the
  // question whose attempt produced it (keyed by the authority's own
  // question id) — the feedback under a question always names the step
  // THAT question assesses, verbatim from the teaching authority.
  const [practiceFeedback, setPracticeFeedback] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderPicks, setOrderPicks] = useState<Record<string, string>>({});
  const [semantics, setSemantics] = useState<Record<string, string>>({});
  const [corrections, setCorrections] = useState<string[] | null>(null);

  // The §13 reverse-teaching sub-experience state.
  const [reverseState, setReverseState] = useState<ReverseState>({ kind: 'idle' });
  const [reverseResult, setReverseResult] = useState('');
  const [reverseError, setReverseError] = useState<string | null>(null);

  // The pinned version (the install pin verbatim; else the head).
  const pinnedVersionId = installation
    ? installation.installation.versionId
    : workflow.headVersionId;
  const pinnedVersion = versions.find((v) => v.id === pinnedVersionId) ?? null;
  const labels = useMemo(() => nodeLabelsFromContent(pinnedVersion?.content ?? null), [pinnedVersion]);

  const loadSession = useCallback(async () => {
    if (pinnedVersionId === null) return;
    setSessionState({ kind: 'loading' });
    try {
      const result = await teaching.startSession(workflow.id, pinnedVersionId);
      setSessionState({ kind: 'data', session: result.session });
    } catch {
      setSessionState({ kind: 'error' });
    }
  }, [workflow.id, pinnedVersionId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // The practice questions (the authority's own derivation) once the
  // lesson is in progress.
  const sessionId = sessionState.kind === 'data' ? sessionState.session.id : null;
  const lessonStarted =
    sessionState.kind === 'data' && sessionState.session.status === 'in_progress';
  useEffect(() => {
    if (!sessionId || !lessonStarted) return;
    let cancelled = false;
    (async () => {
      try {
        const questions = await teaching.listPracticeQuestions(sessionId);
        if (!cancelled) setPracticeQuestions(questions);
      } catch {
        if (!cancelled) setPracticeQuestions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, lessonStarted]);

  const session = sessionState.kind === 'data' ? sessionState.session : null;
  const steps = useMemo(() => (session ? lessonStepsFromSession(session) : []), [session]);
  const nextStep = useMemo(() => {
    if (!session) return null;
    const nextId = session.progress.nextCheckpointNodeId;
    return nextId === null ? null : steps.find((s) => s.nodeId === nextId) ?? null;
  }, [session, steps]);
  const completed = session?.status === 'completed';

  async function run(action: () => Promise<void>) {
    setSubmitting(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      // A typed rejection: the honest error, verbatim — never a state.
      setError(err instanceof ApiError ? err.message : 'The lesson action couldn\u2019t be sent.');
    } finally {
      setSubmitting(false);
    }
  }

  const beginLesson = () =>
    sessionId !== null &&
    run(async () => {
      const result = await teaching.beginLesson(sessionId);
      setSessionState({ kind: 'data', session: result.session });
    });

  const confirmCheckpoint = () =>
    sessionId !== null &&
    nextStep !== null &&
    run(async () => {
      const result = await teaching.confirmCheckpoint(sessionId, nextStep.nodeId);
      setSessionState({ kind: 'data', session: result.session });
    });

  const attemptPractice = (question: ProductPracticeQuestion) =>
    sessionId !== null &&
    selectedAnswer[question.id] !== undefined &&
    run(async () => {
      const result = await teaching.attemptPractice(sessionId, question.nodeId, selectedAnswer[question.id]);
      setSessionState({ kind: 'data', session: result.session });
      setPracticeFeedback((prev) => ({ ...prev, [question.id]: result.result.feedback }));
    });

  const pause = () =>
    sessionId !== null &&
    run(async () => {
      const result = await teaching.pauseSession(sessionId);
      setSessionState({ kind: 'data', session: result.session });
    });

  const resume = () =>
    sessionId !== null &&
    run(async () => {
      const result = await teaching.resumeSession(sessionId);
      setSessionState({ kind: 'data', session: result.session });
    });

  const submitAssessment = () => {
    if (sessionId === null || steps.length === 0) return;
    const orderedStepIds = steps
      .map((s) => ({ nodeId: s.nodeId, position: Number(orderPicks[s.nodeId] ?? 0) }))
      .filter((s) => s.position > 0)
      .sort((a, b) => a.position - b.position)
      .map((s) => s.nodeId);
    const semanticsByStep: Record<string, string> = {};
    for (const s of steps) {
      const value = semantics[s.nodeId];
      if (typeof value === 'string' && value.trim() !== '') semanticsByStep[s.nodeId] = value;
    }
    if (orderedStepIds.length !== steps.length || Object.keys(semanticsByStep).length !== steps.length) {
      setError('Order every step and describe each one before submitting.');
      return;
    }
    void run(async () => {
      const result = await teaching.submitAssessment(sessionId, orderedStepIds, semanticsByStep);
      setSessionState({ kind: 'data', session: result.session });
      if (!result.outcome.passed) setCorrections(result.outcome.corrections);
      else setCorrections(null);
    });
  };

  // The §13 reverse-teaching entry (installed workflows only).
  async function startReverse() {
    if (installation === null || pinnedVersionId === null) return;
    setReverseState({ kind: 'loading' });
    setReverseError(null);
    try {
      const created = await reverseTeaching.startSession(
        installation.installation.organizationId,
        workflow.id,
        pinnedVersionId,
        installation.installation.id,
      );
      let current = created.session;
      if (current.status === 'not_started') {
        const begun = await reverseTeaching.beginLesson(current.id);
        current = begun.session;
      }
      setReverseState({ kind: 'data', session: current });
    } catch (err) {
      setReverseState({ kind: 'error' });
      setReverseError(err instanceof ApiError ? err.message : 'The lesson couldn\u2019t start.');
    }
  }

  const reverseSession = reverseState.kind === 'data' ? reverseState.session : null;
  const reverseSteps = useMemo(
    () => (reverseSession ? reverseStepsFromSession(reverseSession) : []),
    [reverseSession],
  );
  const nextReverseStep = useMemo(() => {
    if (!reverseSession) return null;
    const nextId = reverseSession.progress.nextStepNodeId;
    return nextId === null ? null : reverseSteps.find((s) => s.nodeId === nextId) ?? null;
  }, [reverseSession, reverseSteps]);

  const performReverseStep = () => {
    if (reverseSession === null || nextReverseStep === null) return;
    // The authority's own mode rule: system-performed steps are
    // ACKNOWLEDGED (the workflow does them — the learner confirms what
    // it cannot teach); agent/human steps are PERFORMED by the learner.
    const mode = expectedManualModeOf(nextReverseStep);
    if (mode === 'performed' && reverseResult.trim() === '') {
      setReverseError('Describe what you did before confirming the step.');
      return;
    }
    void (async () => {
      setSubmitting(true);
      setReverseError(null);
      try {
        const result = await reverseTeaching.performManualStep(
          reverseSession.id,
          nextReverseStep.nodeId,
          mode,
          mode === 'performed' ? reverseResult.trim() : '',
        );
        setReverseState({ kind: 'data', session: result.session });
        setReverseResult('');
      } catch (err) {
        setReverseError(
          err instanceof ApiError ? err.message : 'The step couldn\u2019t be recorded.',
        );
      } finally {
        setSubmitting(false);
      }
    })();
  };

  const acknowledgeSafety = () => {
    if (reverseSession === null || nextReverseStep === null) return;
    void (async () => {
      setSubmitting(true);
      setReverseError(null);
      try {
        const result = await reverseTeaching.acknowledgeStepSafety(
          reverseSession.id,
          nextReverseStep.nodeId,
        );
        setReverseState({ kind: 'data', session: result.session });
      } catch (err) {
        setReverseError(
          err instanceof ApiError ? err.message : 'The acknowledgment couldn\u2019t be sent.',
        );
      } finally {
        setSubmitting(false);
      }
    })();
  };

  if (pinnedVersionId === null) {
    return (
      <section aria-label="Teach Me" className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-medium">Teach Me</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          There&apos;s no version to teach yet — this workflow needs a saved version first.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Teach Me" className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-medium">Teach Me</h2>

      {sessionState.kind === 'loading' && (
        <p role="status" aria-label="Loading" className="mt-2 text-sm text-muted-foreground">
          Loading the lesson…
        </p>
      )}
      {sessionState.kind === 'error' && (
        <div className="mt-2 space-y-1">
          <p role="status" aria-label="Unavailable" className="text-sm text-muted-foreground">
            The lesson state is unavailable right now.
          </p>
          <button
            type="button"
            onClick={() => void loadSession()}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            Load the lesson again
          </button>
        </div>
      )}

      {session && (
        <div className="mt-2 space-y-3 text-sm">
          <p className="text-muted-foreground">
            You&apos;ll learn to do this yourself: {workflow.name}.
          </p>
          {pinnedVersion && (
            <p className="text-xs text-muted-foreground">
              Version {pinnedVersion.versionNumber} — the lesson is bound to it
            </p>
          )}

          {session.status === 'not_started' && (
            <button
              type="button"
              onClick={beginLesson}
              disabled={submitting}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              Start lesson
            </button>
          )}

          {session.status === 'in_progress' && nextStep && (
            <div className="space-y-2">
              <p className="font-medium">
                Step {nextStep.position} of {steps.length} —{' '}
                {stepLabel(labels, nextStep.nodeId, nextStep.position)}
              </p>
              {nextStep.explanation !== '' && (
                <p className="text-muted-foreground">{nextStep.explanation}</p>
              )}
              {nextStep.hasHumanSemanticsDisclosure && (
                <p className="text-xs text-muted-foreground">{SEMANTICS_DISCLOSURE_PHRASE}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={confirmCheckpoint}
                  disabled={submitting}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                >
                  I&apos;ve done it
                </button>
                <button
                  type="button"
                  onClick={pause}
                  disabled={submitting}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                >
                  Pause
                </button>
              </div>
            </div>
          )}

          {session.status === 'paused' && (
            <div className="space-y-2">
              <p className="text-muted-foreground">
                Paused — {lessonStatusWord(session.status)} at Step {nextStep?.position ?? 1} of{' '}
                {steps.length}. Pick up exactly where you left off.
              </p>
              <button
                type="button"
                onClick={resume}
                disabled={submitting}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                Resume
              </button>
            </div>
          )}

          {lessonStarted &&
            practiceQuestions.map((question) => (
              <section key={question.id} aria-label="Practice" className="space-y-1">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Practice
                </h3>
                <p>{question.prompt}</p>
                <div className="space-y-1">
                  {question.options.map((option) => (
                    <label key={option} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`practice-${question.id}`}
                        value={option}
                        checked={selectedAnswer[question.id] === option}
                        onChange={() =>
                          setSelectedAnswer((prev) => ({ ...prev, [question.id]: option }))
                        }
                      />
                      {option}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => attemptPractice(question)}
                  disabled={submitting || selectedAnswer[question.id] === undefined}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                >
                  Check
                </button>
                {practiceFeedback[question.id] && (
                  <p className="text-xs text-muted-foreground">{practiceFeedback[question.id]}</p>
                )}
              </section>
            ))}

          {session.status === 'in_progress' && session.progress.allCheckpointsConfirmed && (
            <section aria-label="Show you know it" className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Show you know it
              </h3>
              <p className="text-muted-foreground">
                Put the steps in order and describe each one, from memory.
              </p>
              <ol className="space-y-2">
                {steps.map((s) => (
                  <li key={s.nodeId} className="space-y-1">
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">
                        Position of {stepLabel(labels, s.nodeId, s.position)}
                      </span>
                      <select
                        value={orderPicks[s.nodeId] ?? ''}
                        onChange={(e) =>
                          setOrderPicks((prev) => ({ ...prev, [s.nodeId]: e.target.value }))
                        }
                        aria-label={`Position of ${stepLabel(labels, s.nodeId, s.position)}`}
                        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                      >
                        <option value="">Choose…</option>
                        {steps.map((_, i) => (
                          <option key={i + 1} value={String(i + 1)}>
                            {i + 1}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">
                        What does {stepLabel(labels, s.nodeId, s.position)} do?
                      </span>
                      <textarea
                        value={semantics[s.nodeId] ?? ''}
                        onChange={(e) =>
                          setSemantics((prev) => ({ ...prev, [s.nodeId]: e.target.value }))
                        }
                        aria-label={`What does ${stepLabel(labels, s.nodeId, s.position)} do?`}
                        rows={2}
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                      />
                    </label>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                onClick={submitAssessment}
                disabled={submitting}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                Submit
              </button>
              {corrections !== null && corrections.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {corrections.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {completed && (
            <p className="font-medium">Lesson complete</p>
          )}
          {session.progress.allCheckpointsConfirmed && !completed && (
            <p className="text-xs text-muted-foreground">All steps confirmed</p>
          )}

          {session.evidence.length > 0 && (
            <section aria-label="Teaching evidence" className="space-y-1">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Teaching evidence
              </h3>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {session.evidence.slice(0, 5).map((e) => (
                  <li key={e.id}>
                    {e.kind} · {formatLessonTime(e.recordedAt)}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Kept separate from run evidence — learning never counts as execution.
              </p>
            </section>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {installation && reverseState.kind === 'idle' && (
            <div className="border-t border-border pt-3">
              <button
                type="button"
                onClick={() => void startReverse()}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                Do it myself instead
              </button>
              <p className="mt-1 text-xs text-muted-foreground">
                You perform the workflow&apos;s steps by hand — no run is created.
              </p>
            </div>
          )}
        </div>
      )}

      {reverseState.kind === 'loading' && (
        <p role="status" aria-label="Loading" className="mt-2 text-sm text-muted-foreground">
          Preparing the do-it-yourself lesson…
        </p>
      )}
      {reverseState.kind === 'error' && (
        <p role="status" aria-label="Unavailable" className="mt-2 text-sm text-muted-foreground">
          The do-it-yourself lesson is unavailable right now.
        </p>
      )}

      {reverseSession && (
        <section aria-label="Do it yourself" className="mt-4 space-y-3 border-t border-border pt-3 text-sm">
          <h3 className="font-medium">Do it yourself</h3>
          <p className="text-xs text-muted-foreground">
            You do each step by hand — no run is created. Learning this way never executes the
            workflow.
          </p>
          {nextReverseStep && (
            <div className="space-y-2">
              <p className="font-medium">
                Step {nextReverseStep.position} of {reverseSteps.length} —{' '}
                {stepLabel(labels, nextReverseStep.nodeId, nextReverseStep.position)}
              </p>
              <p className="text-muted-foreground">{nextReverseStep.manualInstruction}</p>
              {nextReverseStep.safetyGated && nextReverseStep.safetyNotice !== null && (
                <div className="space-y-1 rounded-md bg-destructive/10 p-2">
                  <p className="text-xs font-medium text-destructive">
                    {nextReverseStep.safetyNotice}
                  </p>
                  <button
                    type="button"
                    onClick={acknowledgeSafety}
                    disabled={submitting}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    I understand — let me do it
                  </button>
                </div>
              )}
              {expectedManualModeOf(nextReverseStep) === 'performed' ? (
                <>
                  <label className="block space-y-1">
                    <span className="text-xs text-muted-foreground">What did you do?</span>
                    <textarea
                      value={reverseResult}
                      onChange={(e) => setReverseResult(e.target.value)}
                      aria-label="What did you do?"
                      rows={2}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={performReverseStep}
                    disabled={submitting}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    I did this step
                  </button>
                </>
              ) : (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    This step is done by the workflow itself — acknowledge what it can&rsquo;t
                    teach you about doing it by hand.
                  </p>
                  <button
                    type="button"
                    onClick={performReverseStep}
                    disabled={submitting}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    I understand
                  </button>
                </div>
              )}
            </div>
          )}
          {reverseSession.progress.allStepsPerformed && (
            <p className="font-medium">You did the whole thing yourself</p>
          )}
          {reverseError && (
            <p role="alert" className="text-sm text-destructive">
              {reverseError}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
