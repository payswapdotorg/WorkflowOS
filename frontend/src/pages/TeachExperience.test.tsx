/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TeachExperience from '../components/teach/TeachExperience';
import type {
  ProductWorkflow,
  ProductWorkflowVersion,
  ProductInstallationDetail,
} from '../api/client';

/**
 * V2-017 T9 — the Teach Me / reverse-teaching contract (Issue #200).
 *
 * The teaching experience composes over EXISTING authorities only: the
 * V2-006 teaching-session service (through its transport routes — the
 * route layer consumes the authority; no teaching semantics are
 * redefined client-side) and the V2-002 version read (the pin).
 * HONESTY RULES (UX §12/§13 + V2-017):
 *   - the lesson is bound to the installed/head immutable version
 *     (the pin shown verbatim; never a second workflow
 *     representation);
 *   - progress derives ONLY from the authoritative session read
 *     (nextCheckpointNodeId / counts / passedAssessment) — never
 *     fabricated, never client-projected;
 *   - step names come from the V2-003 presentation layer (F-T4-001);
 *     internal node IDs never surface;
 *   - gaps in the workflow's own facts render as honest
 *     "the workflow doesn't specify" disclosures — never invented
 *     procedure;
 *   - teaching evidence renders under a visibly DISTINCT surface from
 *     execution evidence (§12: "separate in the UI and data model");
 *   - resumable: pause → resume returns to the EXACT pending
 *     checkpoint (the authority's resumeCheckpointNodeId);
 *   - typed rejections render verbatim as alerts, never as state;
 *   - honest unavailable: a failed session read is never an empty
 *     success; a workflow with no version cannot be taught;
 *   - completed is terminal: the surface says so and offers no
 *     lifecycle commands;
 *   - the reverse-teaching entry is visibly distinct from ordinary
 *     execution (§13) and is composed over the reverse-teaching
 *     authority (its own routes, its own evidence, the zero-runs
 *     fact).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = (body?: unknown) => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const [key, handler] of ordered) {
      const methodPrefix = /^([A-Z]+) (.*)$/.exec(key);
      if (methodPrefix) {
        if (methodPrefix[1] === method && url.includes(methodPrefix[2])) {
          return Promise.resolve(handler(init?.body ? JSON.parse(String(init.body)) : undefined));
        }
        continue;
      }
      if (url.includes(key)) return Promise.resolve(handler());
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${url}` }));
  });
}

const WORKFLOW: ProductWorkflow = {
  id: 'wf-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  slug: 'weekly-invoice-digest',
  name: 'Weekly invoice digest',
  description: 'Collect invoices and email the digest.',
  visibility: 'private',
  headVersionId: 'ver-2',
  forkedFromWorkflowId: null,
  forkedFromVersionId: null,
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-04T09:00:00Z',
};

const IR_CONTENT = {
  objectType: 'workflowos/workflow-ir/v1',
  irSchemaVersion: 1,
  ir: {
    start: 'fetch',
    nodes: [
      {
        id: 'fetch',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'github.repository.read' },
        capabilityRequirements: ['github.repository.read'],
        placement: 'cloud_allowed',
      },
      {
        id: 'send',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'messaging.send' },
        capabilityRequirements: ['messaging.send'],
        placement: 'cloud_allowed',
      },
    ],
    edges: [{ from: 'fetch', to: 'send', on: 'success' }],
    defaultPlacement: 'any_supported_node',
  },
  presentation: {
    title: 'Weekly invoice digest',
    nodeLabels: { fetch: 'Collect the open tickets', send: 'Email the weekly digest' },
  },
};

const VERSIONS: ProductWorkflowVersion[] = [
  {
    id: 'ver-2',
    workflowId: 'wf-1',
    versionNumber: 2,
    contentDigest: 'sha256:new',
    content: IR_CONTENT,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-04T09:00:00Z',
  },
];

const INSTALLATION: ProductInstallationDetail = {
  installation: {
    id: 'inst-1',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    installedByUserId: 'user-1',
    status: 'enabled',
    installedAt: '2026-09-02T09:00:00Z',
    updatedAt: '2026-09-02T09:00:00Z',
  },
  pinnedVersion: {
    id: 'ver-2',
    workflowId: 'wf-1',
    versionNumber: 2,
    contentDigest: 'sha256:new',
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  },
};

/** The lesson step view (the V2-006 derived lesson, as the route serializes). */
function lessonStep(nodeId: string, position: number, overrides: Record<string, unknown> = {}) {
  return {
    nodeId,
    position,
    executionClass: 'deterministic_api',
    semantics: `The workflow declares: ${nodeId} semantics`,
    facts: [],
    disclosures: [],
    inputs: [],
    outputs: [],
    placement: 'cloud_allowed',
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: null,
    conditionalOn: [],
    explanation: `This step ${nodeId}.`,
    ...overrides,
  };
}

const LESSON = {
  stepOrder: ['fetch', 'send'],
  intent: {
    startNodeId: 'fetch',
    inputNames: [],
    outputNames: [],
    provenanceOrigin: 'authored',
    disclosures: [],
    statement: 'Prepare and send the weekly digest.',
  },
  prerequisites: [],
  steps: [
    lessonStep('fetch', 1),
    lessonStep('send', 2, {
      disclosures: [{ field: 'step_human_readable_semantics', kind: 'NOT_SPECIFIED_BY_WORKFLOW' }],
    }),
  ],
  decisionPoints: [],
  observations: [],
  completionCriteria: [],
  disclosures: [],
};

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ts_1',
    learnerId: 'user-1',
    pinned: { workflowId: 'wf-1', versionId: 'ver-2', semanticDigest: { algorithm: 'sha-256', domain: 'workflowos/workflow-ir/v1', digest: 'a'.repeat(64) } },
    status: 'in_progress',
    createdAt: 1733568000000,
    updatedAt: 1733568001000,
    lesson: LESSON,
    pinnedDocument: null,
    confirmedCheckpoints: [{ nodeId: 'fetch', confirmedAt: 1733568002000 }],
    unresolvedQuestions: [],
    evidence: [
      {
        evidenceClass: 'teaching',
        kind: 'learner_checkpoint_confirmation',
        id: 'ev_1',
        sessionId: 'ts_1',
        learnerId: 'user-1',
        recordedAt: 1733568002000,
        detail: { nodeId: 'fetch' },
      },
    ],
    progress: {
      confirmedCheckpoints: [{ nodeId: 'fetch', confirmedAt: 1733568002000 }],
      nextCheckpointNodeId: 'send',
      allCheckpointsConfirmed: false,
      practiceAttemptCount: 1,
      correctPracticeAttemptCount: 1,
      assessmentAttemptCount: 0,
      passedAssessment: false,
    },
    ...overrides,
  };
}

const PRACTICE_QUESTIONS = [
  {
    id: 'pq_1',
    kind: 'step_semantics',
    nodeId: 'send',
    prompt: 'What does the "Email the weekly digest" step do?',
    options: [
      'The workflow declares: send semantics',
      'An unrelated option',
    ],
  },
];

function renderTeach(
  props: Partial<Parameters<typeof TeachExperience>[0]> & {
    routes?: Record<string, RouteHandler>;
  } = {},
) {
  const routes = props.routes ?? {
    'POST /teaching-sessions/sessions': () => jsonResponse(201, { session: session(), created: true }),
    'GET /teaching-sessions/sessions/ts_1': () => jsonResponse(200, { session: session() }),
    'GET /teaching-sessions/sessions/ts_1/practice-questions': () =>
      jsonResponse(200, { questions: PRACTICE_QUESTIONS }),
  };
  vi.stubGlobal('fetch', mockApi(routes));
  const fetchMock = vi.mocked(fetch);
  return {
    user: userEvent.setup(),
    fetchMock,
    ...render(
      <MemoryRouter>
        <TeachExperience
          workflow={props.workflow ?? WORKFLOW}
          versions={props.versions ?? VERSIONS}
          installation={props.installation ?? null}
        />
      </MemoryRouter>,
    ),
  };
}

async function opened() {
  return await screen.findByRole('region', { name: 'Teach Me' });
}

describe('V2-017 T9 — the Teach Me experience', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('the lesson opening (§12)', () => {
    it('create-or-converges the session bound to the pinned version — the install pin verbatim when installed', async () => {
      const { fetchMock } = renderTeach({
        installation: INSTALLATION,
        routes: {
          'POST /teaching-sessions/sessions': () =>
            jsonResponse(200, { session: session({ status: 'not_started', lesson: null, confirmedCheckpoints: [], progress: { confirmedCheckpoints: [], nextCheckpointNodeId: null, allCheckpointsConfirmed: false, practiceAttemptCount: 0, correctPracticeAttemptCount: 0, assessmentAttemptCount: 0, passedAssessment: false }, evidence: [] }), created: false }),
        },
      });
      await opened();
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      // The install pin verbatim (never auto-updated to the head).
      expect(body).toEqual({ workflowId: 'wf-1', versionId: 'ver-2' });
      // The opening: what you'll learn + the pinned version + Start.
      expect(screen.getByText(/You'll learn to do this yourself/)).toBeInTheDocument();
      expect(screen.getByText(/Version 2 — the lesson is bound to it/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start lesson' })).toBeInTheDocument();
    });

    it('an honest no-version state — a workflow with no version cannot be taught', async () => {
      renderTeach({
        workflow: { ...WORKFLOW, headVersionId: null },
        versions: [],
      });
      const panel = await opened();
      expect(within(panel).getByText(/no version to teach yet/i)).toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: 'Start lesson' })).not.toBeInTheDocument();
    });
  });

  describe('the step / checkpoint flow (§12)', () => {
    it('presents the next checkpoint step with the presentation label — internal node IDs never surface — and confirms through the real command', async () => {
      const { user, fetchMock } = renderTeach({
        routes: {
          'POST /teaching-sessions/sessions': () => jsonResponse(201, { session: session(), created: true }),
          'POST /teaching-sessions/sessions/ts_1/checkpoints/confirm': () =>
            jsonResponse(200, {
              session: session({
                confirmedCheckpoints: [
                  { nodeId: 'fetch', confirmedAt: 1733568002000 },
                  { nodeId: 'send', confirmedAt: 1733568003000 },
                ],
                progress: {
                  confirmedCheckpoints: [
                    { nodeId: 'fetch', confirmedAt: 1733568002000 },
                    { nodeId: 'send', confirmedAt: 1733568003000 },
                  ],
                  nextCheckpointNodeId: null,
                  allCheckpointsConfirmed: true,
                  practiceAttemptCount: 1,
                  correctPracticeAttemptCount: 1,
                  assessmentAttemptCount: 0,
                  passedAssessment: false,
                },
                evidence: [
                  {
                    evidenceClass: 'teaching',
                    kind: 'learner_checkpoint_confirmation',
                    id: 'ev_1',
                    sessionId: 'ts_1',
                    learnerId: 'user-1',
                    recordedAt: 1733568002000,
                    detail: { nodeId: 'fetch' },
                  },
                  {
                    evidenceClass: 'teaching',
                    kind: 'learner_checkpoint_confirmation',
                    id: 'ev_2',
                    sessionId: 'ts_1',
                    learnerId: 'user-1',
                    recordedAt: 1733568003000,
                    detail: { nodeId: 'send' },
                  },
                ],
              }),
            }),
        },
      });
      const panel = await opened();
      // The next checkpoint: Step 2 of 2, the presentation label.
      expect(within(panel).getByText(/Step 2 of 2/)).toBeInTheDocument();
      expect(within(panel).getByText(/Step 2 of 2 — Email the weekly digest/)).toBeInTheDocument();
      expect(within(panel).queryByText(/^send$/)).not.toBeInTheDocument();
      expect(within(panel).queryByText(/nodeId/i)).not.toBeInTheDocument();
      // The honest disclosure for the workflow's own gap.
      expect(
        within(panel).getByText(/the workflow doesn't specify this step's readable semantics/i),
      ).toBeInTheDocument();
      // The learner action.
      await user.click(within(panel).getByRole('button', { name: "I've done it" }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions/ts_1/checkpoints/confirm') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions/ts_1/checkpoints/confirm') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(body).toEqual({ nodeId: 'send' });
      // Progress derives from the authoritative read (all confirmed).
      await waitFor(() => expect(within(panel).getByText(/All steps confirmed/)).toBeInTheDocument());
    });

    it('practice: the question and options render; the attempt travels the real route with verbatim feedback', async () => {
      const { user, fetchMock } = renderTeach({
        routes: {
          'POST /teaching-sessions/sessions': () => jsonResponse(201, { session: session(), created: true }),
          'GET /teaching-sessions/sessions/ts_1/practice-questions': () =>
            jsonResponse(200, { questions: PRACTICE_QUESTIONS }),
          'POST /teaching-sessions/sessions/ts_1/practice': () =>
            jsonResponse(200, {
              session: session(),
              result: {
                outcome: 'correct',
                attemptId: 'pa_1',
                nodeId: 'send',
                feedback: "That matches the workflow's own declaration.",
              },
            }),
        },
      });
      const panel = await opened();
      const practice = within(within(panel).getByRole('region', { name: 'Practice' }));
      expect(practice.getByText('What does the "Email the weekly digest" step do?')).toBeInTheDocument();
      await user.click(practice.getByRole('radio', { name: 'The workflow declares: send semantics' }));
      await user.click(practice.getByRole('button', { name: 'Check' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions/ts_1/practice') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions/ts_1/practice') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(body).toEqual({ nodeId: 'send', answer: 'The workflow declares: send semantics' });
      await waitFor(() =>
        expect(practice.getByText(/That matches the workflow's own declaration/i)).toBeInTheDocument(),
      );
    });
  });

  describe('pause / resume (resumable)', () => {
    it('pauses through the real command, then resumes to the EXACT pending checkpoint', async () => {
      const { user, fetchMock } = renderTeach({
        routes: {
          'POST /teaching-sessions/sessions': () => jsonResponse(201, { session: session(), created: true }),
          'POST /teaching-sessions/sessions/ts_1/pause': () =>
            jsonResponse(200, { session: session({ status: 'paused' }) }),
          'POST /teaching-sessions/sessions/ts_1/resume': () =>
            jsonResponse(200, {
              session: session(),
              resumeCheckpointNodeId: 'send',
            }),
        },
      });
      const panel = await opened();
      await user.click(within(panel).getByRole('button', { name: 'Pause' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions/ts_1/pause') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      await waitFor(() => expect(within(panel).getByText(/Paused/i)).toBeInTheDocument());
      await user.click(within(panel).getByRole('button', { name: 'Resume' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions/ts_1/resume') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      // Resumed to the exact pending checkpoint.
      await waitFor(() => expect(within(panel).getByText(/Step 2 of 2/)).toBeInTheDocument());
    });

    it('a same-state rejection (409) renders verbatim — never a silent success', async () => {
      const { user } = renderTeach({
        routes: {
          'POST /teaching-sessions/sessions': () => jsonResponse(201, { session: session(), created: true }),
          'POST /teaching-sessions/sessions/ts_1/pause': () =>
            jsonResponse(409, { error: 'teaching-sessions-session-already-paused' }),
        },
      });
      const panel = await opened();
      await user.click(within(panel).getByRole('button', { name: 'Pause' }));
      const alert = await within(panel).findByRole('alert');
      expect(alert).toHaveTextContent('teaching-sessions-session-already-paused');
    });
  });

  describe('the assessment and completion (§12)', () => {
    it('the assessment (order + semantics) travels the real route; passed → the terminal complete surface', async () => {
      const { user, fetchMock } = renderTeach({
        routes: {
          'POST /teaching-sessions/sessions': () =>
            jsonResponse(201, {
              session: session({
                confirmedCheckpoints: [
                  { nodeId: 'fetch', confirmedAt: 1733568002000 },
                  { nodeId: 'send', confirmedAt: 1733568003000 },
                ],
                progress: {
                  confirmedCheckpoints: [
                    { nodeId: 'fetch', confirmedAt: 1733568002000 },
                    { nodeId: 'send', confirmedAt: 1733568003000 },
                  ],
                  nextCheckpointNodeId: null,
                  allCheckpointsConfirmed: true,
                  practiceAttemptCount: 1,
                  correctPracticeAttemptCount: 1,
                  assessmentAttemptCount: 0,
                  passedAssessment: false,
                },
              }),
              created: true,
            }),
          'POST /teaching-sessions/sessions/ts_1/assessment': () =>
            jsonResponse(200, {
              session: session({
                status: 'completed',
                progress: {
                  confirmedCheckpoints: [
                    { nodeId: 'fetch', confirmedAt: 1733568002000 },
                    { nodeId: 'send', confirmedAt: 1733568003000 },
                  ],
                  nextCheckpointNodeId: null,
                  allCheckpointsConfirmed: true,
                  practiceAttemptCount: 1,
                  correctPracticeAttemptCount: 1,
                  assessmentAttemptCount: 1,
                  passedAssessment: true,
                },
              }),
              outcome: { assessmentId: 'as_1', passed: true, orderCorrect: true, perStep: [], corrections: [], sessionStatus: 'completed' },
            }),
        },
      });
      const panel = await opened();
      const assessment = within(panel).getByRole('region', { name: 'Show you know it' });
      // Order the steps (each step gets a position).
      await user.selectOptions(within(assessment).getByLabelText('Position of Collect the open tickets'), '1');
      await user.selectOptions(within(assessment).getByLabelText('Position of Email the weekly digest'), '2');
      await user.type(within(assessment).getByLabelText('What does Collect the open tickets do?'), 'The workflow declares: fetch semantics');
      await user.type(within(assessment).getByLabelText('What does Email the weekly digest do?'), 'The workflow declares: send semantics');
      await user.click(within(assessment).getByRole('button', { name: 'Submit' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions/ts_1/assessment') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/teaching-sessions/sessions/ts_1/assessment') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(body.orderedStepIds).toEqual(['fetch', 'send']);
      expect(body.semanticsByStep).toEqual({
        fetch: 'The workflow declares: fetch semantics',
        send: 'The workflow declares: send semantics',
      });
      // Terminal: Lesson complete — no lifecycle commands remain.
      await waitFor(() => expect(within(panel).getByText('Lesson complete')).toBeInTheDocument());
      expect(within(panel).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: "I've done it" })).not.toBeInTheDocument();
    });

    it("a failed assessment renders the authority's corrections verbatim — never a fabricated pass", async () => {
      const { user } = renderTeach({
        routes: {
          'POST /teaching-sessions/sessions': () =>
            jsonResponse(201, {
              session: session({
                confirmedCheckpoints: [
                  { nodeId: 'fetch', confirmedAt: 1733568002000 },
                  { nodeId: 'send', confirmedAt: 1733568003000 },
                ],
                progress: {
                  confirmedCheckpoints: [
                    { nodeId: 'fetch', confirmedAt: 1733568002000 },
                    { nodeId: 'send', confirmedAt: 1733568003000 },
                  ],
                  nextCheckpointNodeId: null,
                  allCheckpointsConfirmed: true,
                  practiceAttemptCount: 0,
                  correctPracticeAttemptCount: 0,
                  assessmentAttemptCount: 0,
                  passedAssessment: false,
                },
              }),
              created: true,
            }),
          'POST /teaching-sessions/sessions/ts_1/assessment': () =>
            jsonResponse(200, {
              session: session({
                confirmedCheckpoints: [
                  { nodeId: 'fetch', confirmedAt: 1733568002000 },
                  { nodeId: 'send', confirmedAt: 1733568003000 },
                ],
                progress: {
                  confirmedCheckpoints: [
                    { nodeId: 'fetch', confirmedAt: 1733568002000 },
                    { nodeId: 'send', confirmedAt: 1733568003000 },
                  ],
                  nextCheckpointNodeId: null,
                  allCheckpointsConfirmed: true,
                  practiceAttemptCount: 0,
                  correctPracticeAttemptCount: 0,
                  assessmentAttemptCount: 1,
                  passedAssessment: false,
                },
              }),
              outcome: {
                assessmentId: 'as_1',
                passed: false,
                orderCorrect: true,
                perStep: [],
                corrections: ['Step "send": the workflow declares "The workflow declares: send semantics".'],
                sessionStatus: 'in_progress',
              },
            }),
        },
      });
      const panel = await opened();
      const assessment = within(panel).getByRole('region', { name: 'Show you know it' });
      await user.selectOptions(within(assessment).getByLabelText('Position of Collect the open tickets'), '1');
      await user.selectOptions(within(assessment).getByLabelText('Position of Email the weekly digest'), '2');
      await user.type(within(assessment).getByLabelText('What does Collect the open tickets do?'), 'wrong');
      await user.type(within(assessment).getByLabelText('What does Email the weekly digest do?'), 'wrong');
      await user.click(within(assessment).getByRole('button', { name: 'Submit' }));
      await waitFor(() =>
        expect(within(panel).getByText(/the workflow declares/i)).toBeInTheDocument(),
      );
      expect(within(panel).queryByText('Lesson complete')).not.toBeInTheDocument();
    });
  });

  describe('evidence separation (§12)', () => {
    it('teaching evidence renders under a visibly distinct surface — never execution vocabulary', async () => {
      renderTeach();
      const panel = await opened();
      const evidence = within(panel).getByRole('region', { name: 'Teaching evidence' });
      expect(
        within(evidence).getByText(/kept separate from run evidence/i),
      ).toBeInTheDocument();
      expect(within(evidence).getByText(/learner_checkpoint_confirmation/)).toBeInTheDocument();
      // The teaching surface never uses execution-evidence vocabulary.
      expect(within(panel).queryByText(/^Run evidence$/)).not.toBeInTheDocument();
      expect(within(panel).queryByText(/^Execution evidence$/)).not.toBeInTheDocument();
    });
  });

  describe('honest unavailable (§2.5)', () => {
    it('a failed session read is the honest unavailable surface — never an empty success', async () => {
      renderTeach({
        routes: {
          'POST /teaching-sessions/sessions': () => jsonResponse(500, { error: 'session-store-unavailable' }),
        },
      });
      const panel = await opened();
      await waitFor(() =>
        expect(within(panel).getByText(/lesson state is unavailable/i)).toBeInTheDocument(),
      );
      expect(within(panel).queryByRole('button', { name: 'Start lesson' })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------
  // §13: reverse teaching — the distinct do-it-yourself mode over the
  // reverse-teaching authority.
  // -------------------------------------------------------------------

  describe('the reverse-teaching entry (§13)', () => {
    it('offers the distinct do-it-yourself entry ONLY when the workflow is installed', async () => {
      const { rerender } = renderTeach({ installation: null });
      const panel = await opened();
      expect(
        within(panel).queryByRole('button', { name: /do it myself/i }),
      ).not.toBeInTheDocument();
      rerender(
        <MemoryRouter>
          <TeachExperience workflow={WORKFLOW} versions={VERSIONS} installation={INSTALLATION} />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(within(panel).getByRole('button', { name: /do it myself/i })).toBeInTheDocument(),
      );
    });

    it('the reverse journey: begin → the safety-gated manual step (notice + acknowledge) → perform through the real command → the zero-runs distinction', async () => {
      const reverseSession = {
        id: 'rt_1',
        learnerId: 'user-1',
        pin: {
          workflowId: 'wf-1',
          versionId: 'ver-2',
          installationId: 'inst-1',
          semanticDigest: { algorithm: 'sha-256', domain: 'workflowos/workflow-ir/v1', digest: 'a'.repeat(64) },
        },
        status: 'in_progress',
        createdAt: 1733568000000,
        updatedAt: 1733568001000,
        lesson: {
          ...LESSON,
          steps: [
            {
              ...lessonStep('fetch', 1),
              actionability: 'agent_task',
              manualInstruction: 'Do the fetch step yourself, following the workflow.',
              uncertainty: [],
            },
            {
              ...lessonStep('send', 2),
              actionability: 'human_declared',
              manualInstruction: 'Send the digest yourself.',
              uncertainty: [],
              capabilityRequirements: ['messaging.send'],
            },
          ],
        },
        performedSteps: [],
        safetyAcknowledged: [],
        evidence: [],
        progress: { nextStepNodeId: 'fetch', allStepsPerformed: false },
      };
      const routes: Record<string, RouteHandler> = {
        'POST /teaching-sessions/sessions': () => jsonResponse(201, { session: session(), created: true }),
        'GET /teaching-sessions/sessions/ts_1/practice-questions': () =>
          jsonResponse(200, { questions: PRACTICE_QUESTIONS }),
        'POST /reverse-teaching/sessions': () =>
          jsonResponse(201, { session: reverseSession, created: true }),
        'POST /reverse-teaching/sessions/rt_1/begin-lesson': () =>
          jsonResponse(200, { session: reverseSession }),
        'GET /reverse-teaching/sessions/rt_1': () => jsonResponse(200, { session: reverseSession }),
        'POST /reverse-teaching/sessions/rt_1/steps/fetch/safety-ack': () =>
          jsonResponse(200, { session: reverseSession }),
        'POST /reverse-teaching/sessions/rt_1/steps/fetch/perform': () =>
          jsonResponse(200, {
            session: {
              ...reverseSession,
              performedSteps: [{ nodeId: 'fetch', mode: 'performed', performedAt: 1733568002000 }],
              progress: { nextStepNodeId: 'send', allStepsPerformed: false },
            },
          }),
      };
      const { user, fetchMock } = renderTeach({ installation: INSTALLATION, routes });
      const panel = await opened();
      // The distinct framing (§13 — never ordinary execution vocabulary).
      await user.click(within(panel).getByRole('button', { name: /do it myself/i }));
      const reverse = await screen.findByRole('region', { name: 'Do it yourself' });
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/reverse-teaching/sessions') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const createBody = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/reverse-teaching/sessions') &&
              (init?.method ?? 'GET') === 'POST' &&
              String(init?.body).includes('installationId'),
          )?.[1]?.body,
        ),
      );
      expect(createBody).toEqual({
        organizationId: 'org-1',
        workflowId: 'wf-1',
        versionId: 'ver-2',
        installationId: 'inst-1',
      });
      // The zero-runs distinction is explicit.
      expect(within(reverse).getByText(/no run is created/i)).toBeInTheDocument();
      // The manual step: the instruction + the learner's own result.
      await user.type(within(reverse).getByLabelText('What did you do?'), 'Opened the report myself');
      await user.click(within(reverse).getByRole('button', { name: 'I did this step' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/reverse-teaching/sessions/rt_1/steps/fetch/perform') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const performBody = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/reverse-teaching/sessions/rt_1/steps/fetch/perform') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(performBody).toEqual({ mode: 'performed', learnerResult: 'Opened the report myself' });
    });

    it('a safety-gated step requires the acknowledgment FIRST — the typed rejection renders verbatim', async () => {
      const reverseSession = {
        id: 'rt_1',
        learnerId: 'user-1',
        pin: {
          workflowId: 'wf-1',
          versionId: 'ver-2',
          installationId: 'inst-1',
          semanticDigest: { algorithm: 'sha-256', domain: 'workflowos/workflow-ir/v1', digest: 'a'.repeat(64) },
        },
        status: 'in_progress',
        createdAt: 1733568000000,
        updatedAt: 1733568001000,
        lesson: {
          ...LESSON,
          steps: [
            {
              ...lessonStep('fetch', 1),
              actionability: 'agent_task',
              manualInstruction: 'Do the fetch step yourself, following the workflow.',
              uncertainty: [],
              safety: 'safety_gated',
              safetyNotice: 'This step uses messaging.send — a sensitive capability.',
            },
          ],
        },
        performedSteps: [],
        safetyAcknowledged: [],
        evidence: [],
        progress: { nextStepNodeId: 'fetch', allStepsPerformed: false },
      };
      const routes: Record<string, RouteHandler> = {
        'POST /teaching-sessions/sessions': () => jsonResponse(201, { session: session(), created: true }),
        'GET /teaching-sessions/sessions/ts_1/practice-questions': () =>
          jsonResponse(200, { questions: PRACTICE_QUESTIONS }),
        'POST /reverse-teaching/sessions': () =>
          jsonResponse(201, { session: reverseSession, created: true }),
        'POST /reverse-teaching/sessions/rt_1/steps/fetch/perform': () =>
          jsonResponse(409, { error: 'reverse-teaching-safety-acknowledgment-required' }),
      };
      const { user } = renderTeach({ installation: INSTALLATION, routes });
      const panel = await opened();
      await user.click(within(panel).getByRole('button', { name: /do it myself/i }));
      const reverse = await screen.findByRole('region', { name: 'Do it yourself' });
      // The safety notice renders before any performance.
      await waitFor(() =>
        expect(within(reverse).getByText(/sensitive capability/i)).toBeInTheDocument(),
      );
      await user.type(within(reverse).getByLabelText('What did you do?'), 'I did it carefully');
      await user.click(within(reverse).getByRole('button', { name: 'I did this step' }));
      const alert = await within(reverse).findByRole('alert');
      expect(alert).toHaveTextContent('reverse-teaching-safety-acknowledgment-required');
    });
  });
});
