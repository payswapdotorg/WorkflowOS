/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import RecoveryExperience from '../components/recovery/RecoveryExperience';
import type {
  ProductWorkflow,
  ProductWorkflowVersion,
  ProductWorkflowRun,
  ProductInstallationDetail,
} from '../api/client';

/**
 * V2-017 T7 — the failure / recovery / takeover contract (Issue #197).
 *
 * The recovery surface composes over EXISTING authorities only: the
 * V2-005 run record + history read (the crash-recovery projection —
 * timeline reasons, step outcomes, attempts), the V2-005 lifecycle
 * commands (resume, cancel), and the T6 request/start path for
 * "Try again" (a fresh manual trigger = a fresh run identity — honest,
 * never a fake resume of a terminal run). HONESTY RULES (UX §18/§2.4/
 * §2.5 + V2-017 rule 9):
 *   - failures answer the §18 questions: what is known (recorded step
 *     outcomes, ✓/✕, labels from the V2-003 presentation layer —
 *     internal step IDs never surface), what is unknown (absent reason,
 *     unfinished steps — never fabricated), what to do next (only the
 *     actions the authority actually admits for the state);
 *   - terminal honesty: a failed/cancelled run NEVER offers Resume or
 *     Stop (the authority would reject them); "Try again" is presented
 *     as a NEW run, never as restarting the failed one;
 *   - takeover is presented honestly: no takeover command exists on the
 *     public routes, so [Take over] explains the preserved-run
 *     semantics and points at the execution host surface — it never
 *     sends an invented command;
 *   - typed backend rejections render verbatim as alerts, never as
 *     state; a failed history read is the honest unavailable surface —
 *     never a successful empty "nothing happened";
 *   - consequential Stop carries the §2.4 explicit choice (a summary +
 *     a confirm), and the cancel command travels the real envelope;
 *   - internal run-state words, the run id, and attempt counts stay
 *     expert-only (Advanced details).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const [key, handler] of ordered) {
      const methodPrefix = /^([A-Z]+) (.*)$/.exec(key);
      if (methodPrefix) {
        if (methodPrefix[1] === method && url.includes(methodPrefix[2])) {
          return Promise.resolve(handler());
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
    edges: [],
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

const FAILED_RUN: ProductWorkflowRun = {
  id: 'run-9',
  organizationId: 'org-1',
  workflowId: 'wf-1',
  versionId: 'ver-2',
  installationId: 'inst-1',
  trigger: { type: 'manual', id: 'trg-1' },
  triggeredByUserId: 'user-1',
  inputCommitments: [],
  inputDigest: 'sha256:input',
  state: 'failed',
  createdAt: '2026-09-05T08:00:00Z',
  updatedAt: '2026-09-05T08:30:00Z',
};

const PAUSED_RUN: ProductWorkflowRun = {
  ...FAILED_RUN,
  id: 'run-p',
  state: 'paused',
};

const CANCELLED_RUN: ProductWorkflowRun = {
  ...FAILED_RUN,
  id: 'run-c',
  state: 'cancelled',
};

const NEW_RUN: ProductWorkflowRun = {
  ...FAILED_RUN,
  id: 'run-new',
  state: 'requested',
  createdAt: '2026-09-05T09:00:00Z',
  updatedAt: '2026-09-05T09:00:00Z',
};

function history(overrides: {
  run?: ProductWorkflowRun;
  timeline?: unknown[];
  steps?: unknown[];
  attempts?: unknown[];
}): Record<string, unknown> {
  return {
    run: overrides.run ?? FAILED_RUN,
    timeline:
      overrides.timeline ??
      [
        { id: 't1', runId: 'run-9', attemptNumber: 1, stepId: null, eventName: 'workflow.run.requested', occurredAt: '2026-09-05T08:00:00Z', sequence: 1, detail: null },
        { id: 't2', runId: 'run-9', attemptNumber: 1, stepId: null, eventName: 'workflow.run.started', occurredAt: '2026-09-05T08:01:00Z', sequence: 2, detail: null },
        { id: 't3', runId: 'run-9', attemptNumber: 1, stepId: null, eventName: 'workflow.run.failed', occurredAt: '2026-09-05T08:30:00Z', sequence: 3, detail: { reason: 'The website had changed.' } },
      ],
    attempts: overrides.attempts ?? [{ id: 'a1', attemptNumber: 1, state: 'interrupted', nodeId: null, pausedAtStepId: null, startedAt: '2026-09-05T08:01:00Z', endedAt: '2026-09-05T08:30:00Z' }],
    steps:
      overrides.steps ??
      [
        { stepId: 'fetch', status: 'completed', outcome: 'succeeded', inputCommitments: [], outputCommitments: [], startedAt: '2026-09-05T08:02:00Z', completedAt: '2026-09-05T08:10:00Z' },
        { stepId: 'send', status: 'failed', outcome: 'failed', inputCommitments: [], outputCommitments: [], startedAt: '2026-09-05T08:11:00Z', completedAt: '2026-09-05T08:30:00Z' },
      ],
    invocations: [],
    evidence: [],
    attestations: [],
    attestationRejections: [],
    commands: [],
  };
}

function renderRecovery(
  props: Partial<Parameters<typeof RecoveryExperience>[0]> & {
    routes?: Record<string, RouteHandler>;
  } = {},
) {
  const routes = props.routes ?? {
    '/workflow-runs/runs/run-9/history': () => jsonResponse(200, history({})),
    '/workflow-runs/runs/run-p/history': () => jsonResponse(200, history({ run: PAUSED_RUN })),
    '/workflow-runs/runs/run-c/history': () => jsonResponse(200, history({ run: CANCELLED_RUN })),
  };
  vi.stubGlobal('fetch', mockApi(routes));
  const onRunsChanged = props.onRunsChanged ?? vi.fn();
  const fetchMock = vi.mocked(fetch);
  return {
    user: userEvent.setup(),
    onRunsChanged,
    fetchMock,
    ...render(
      <MemoryRouter>
        <RecoveryExperience
          workflow={props.workflow ?? WORKFLOW}
          versions={props.versions ?? VERSIONS}
          installation={props.installation ?? INSTALLATION}
          latestRun={props.latestRun ?? FAILED_RUN}
          onRunsChanged={onRunsChanged}
        />
      </MemoryRouter>,
    ),
  };
}

describe('V2-017 T7 — the failure / recovery / takeover experience', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------
  // §18: the failure explanation (known / unknown / next).
  // -------------------------------------------------------------------

  describe('the failure explanation (UX §18)', () => {
    it('answers the four §18 questions for a failed run: the sentence, the recorded reason, the known ✓/✕ facts, and the next actions', async () => {
      renderRecovery();
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      expect(within(panel).getByText('I couldn\u2019t finish this.')).toBeInTheDocument();
      expect(within(panel).getByText('It stopped: The website had changed.')).toBeInTheDocument();
      const known = within(panel).getByRole('list', { name: 'What I know' });
      const items = within(known).getAllByRole('listitem');
      expect(items.map((li) => li.textContent)).toEqual([
        '\u2713 Collect the open tickets',
        '\u2717 Email the weekly digest',
      ]);
      // The next actions (only what the authority admits for a terminal run).
      expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(within(panel).getByRole('link', { name: 'Edit workflow' })).toHaveAttribute('href', '/expert');
    });

    it('derives the ✓/✕ labels ONLY from the V2-003 presentation layer — internal step IDs never surface', async () => {
      renderRecovery();
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      await waitFor(() =>
        expect(within(panel).getByRole('list', { name: 'What I know' })).toBeInTheDocument(),
      );
      expect(screen.queryByText(/step_fetch_id|fetch_/i)).not.toBeInTheDocument();
      expect(within(panel).queryByText(/^send$/)).not.toBeInTheDocument();
    });

    it('degrades honestly when a step has no presentation label — a generic line, never the internal ID', async () => {
      const content = {
        ...IR_CONTENT,
        presentation: { nodeLabels: { fetch: 'Collect the open tickets' } },
      };
      renderRecovery({
        versions: [{ ...VERSIONS[0], content }],
      });
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      const known = within(panel).getByRole('list', { name: 'What I know' });
      expect(within(known).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
        '\u2713 Collect the open tickets',
        '\u2717 A step that failed',
      ]);
    });

    it('presents the honest unknowns: an absent reason, a step that started but never finished — never fabricated specifics', async () => {
      renderRecovery({
        routes: {
          '/workflow-runs/runs/run-9/history': () =>
            jsonResponse(200, {
              ...history({}),
              timeline: [
                { id: 't1', runId: 'run-9', attemptNumber: 1, stepId: null, eventName: 'workflow.run.requested', occurredAt: '2026-09-05T08:00:00Z', sequence: 1, detail: null },
                { id: 't2', runId: 'run-9', attemptNumber: 1, stepId: null, eventName: 'workflow.run.failed', occurredAt: '2026-09-05T08:30:00Z', sequence: 2, detail: null },
              ],
              steps: [
                { stepId: 'fetch', status: 'completed', outcome: 'succeeded', startedAt: '2026-09-05T08:02:00Z', completedAt: '2026-09-05T08:10:00Z' },
                { stepId: 'send', status: 'started', outcome: null, startedAt: '2026-09-05T08:11:00Z', completedAt: null },
              ],
            }),
        },
      });
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      expect(within(panel).getByText('What made it stop isn\u2019t recorded yet.')).toBeInTheDocument();
      const unknown = within(panel).getByRole('list', { name: 'What we don\u2019t know yet' });
      expect(within(unknown).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
        'Whether Email the weekly digest finished',
        'Which step failed',
      ]);
    });

    it('a failed history read is the honest unavailable surface — never a successful empty "nothing happened"', async () => {
      renderRecovery({
        routes: {
          '/workflow-runs/runs/run-9/history': () => jsonResponse(500, { error: 'history-unavailable' }),
        },
      });
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      await waitFor(() =>
        expect(
          within(panel).getByText(/What happened is unavailable — the execution history couldn\u2019t be loaded\./),
        ).toBeInTheDocument(),
      );
      // The record-derived facts stay, and the read can be retried (a
      // distinct label — never confused with the run-level Try again).
      expect(within(panel).getByText('I couldn\u2019t finish this.')).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: /load the details again/i })).toBeInTheDocument();
      expect(within(panel).queryByRole('list', { name: 'What I know' })).not.toBeInTheDocument();
    });

    it('a cancelled run presents the honest cancelled sentence and only the admissible actions', async () => {
      renderRecovery({
        routes: {
          '/workflow-runs/runs/run-c/history': () =>
            jsonResponse(200, {
              ...history({ run: CANCELLED_RUN }),
              timeline: [
                { id: 't1', runId: 'run-c', attemptNumber: 1, stepId: null, eventName: 'workflow.run.requested', occurredAt: '2026-09-05T08:00:00Z', sequence: 1, detail: null },
                { id: 't2', runId: 'run-c', attemptNumber: 1, stepId: null, eventName: 'run.cancelled', occurredAt: '2026-09-05T08:20:00Z', sequence: 2, detail: { reason: 'You stopped it.' } },
              ],
            }),
        },
        latestRun: CANCELLED_RUN,
      });
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      expect(within(panel).getByText('It was cancelled.')).toBeInTheDocument();
      expect(within(panel).getByText('It was stopped: You stopped it.')).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('terminal honesty: a failed run NEVER offers Resume or Stop — the authority would reject them', async () => {
      renderRecovery();
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      expect(within(panel).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: 'Stop it' })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------
  // Try again: the REAL command path (a fresh run — honest, never a
  // fake resume of a terminal run).
  // -------------------------------------------------------------------

  describe('Try again (the real request/start path)', () => {
    it('requests a NEW run (fresh manual trigger, the pinned version, the installation pin) and starts exactly the returned run', async () => {
      const routes: Record<string, RouteHandler> = {
        '/workflow-runs/runs/run-9/history': () => jsonResponse(200, history({})),
        'POST /organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(201, { run: NEW_RUN, created: true, executed: true }),
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [FAILED_RUN, NEW_RUN] }),
        'POST /workflow-runs/runs/run-new/start': () =>
          jsonResponse(200, { run: { ...NEW_RUN, state: 'running' }, executed: true }),
      };
      const { user, fetchMock, onRunsChanged } = renderRecovery({ routes });
      await screen.findByRole('region', { name: 'Recovery' });
      await user.click(screen.getByRole('button', { name: 'Try again' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/organizations/org-1/workflow-runs/runs') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const requestCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/organizations/org-1/workflow-runs/runs') &&
          (init?.method ?? 'GET') === 'POST' &&
          String(init?.body).includes('workflowId'),
      );
      const body = JSON.parse(String(requestCall?.[1]?.body));
      // A FRESH manual trigger identity (never the failed run's trigger),
      // the deterministic envelope, the pinned version + installation.
      expect(body.workflowId).toBe('wf-1');
      expect(body.versionId).toBe('ver-2');
      expect(body.installationId).toBe('inst-1');
      expect(typeof body.commandId).toBe('string');
      expect(typeof body.correlationId).toBe('string');
      expect(body.trigger.type).toBe('manual');
      expect(typeof body.trigger.id).toBe('string');
      // The start targets EXACTLY the returned run (the re-read discipline).
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-runs/runs/run-new/start') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      await waitFor(() => expect(onRunsChanged).toHaveBeenCalled());
    });

    it('fail closed: the exact returned run is absent from the re-read list → NO start is sent', async () => {
      const routes: Record<string, RouteHandler> = {
        '/workflow-runs/runs/run-9/history': () => jsonResponse(200, history({})),
        'POST /organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(201, { run: NEW_RUN, created: true, executed: true }),
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [FAILED_RUN] }),
      };
      const { user, fetchMock } = renderRecovery({ routes });
      await screen.findByRole('region', { name: 'Recovery' });
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/could not be started safely/i);
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes('/start') && (init?.method ?? 'GET') === 'POST',
        ),
      ).toBe(false);
    });

    it('a typed command rejection renders verbatim — never as a fabricated success', async () => {
      const routes: Record<string, RouteHandler> = {
        '/workflow-runs/runs/run-9/history': () => jsonResponse(200, history({})),
        'POST /organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(400, {
            error: 'workflow-run-version-not-of-workflow',
            code: 'RUN_VERSION_NOT_OF_WORKFLOW',
            message: 'the version does not belong to the workflow',
          }),
      };
      const { user, onRunsChanged } = renderRecovery({ routes });
      await screen.findByRole('region', { name: 'Recovery' });
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('workflow-run-version-not-of-workflow');
      expect(onRunsChanged).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // The paused-run controls: Resume / Stop / Take over (honest).
  // -------------------------------------------------------------------

  describe('the paused-run controls', () => {
    it('offers Resume and Stop and Take over (the §18 action vocabulary) for a paused run', async () => {
      renderRecovery({ latestRun: PAUSED_RUN });
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      expect(within(panel).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Take over' })).toBeInTheDocument();
    });

    it('Resume travels the REAL lifecycle command (the deterministic envelope)', async () => {
      const routes: Record<string, RouteHandler> = {
        '/workflow-runs/runs/run-p/history': () => jsonResponse(200, history({ run: PAUSED_RUN })),
        'POST /workflow-runs/runs/run-p/resume': () =>
          jsonResponse(200, { run: { ...PAUSED_RUN, state: 'running' }, executed: true }),
      };
      const { user, fetchMock, onRunsChanged } = renderRecovery({ routes, latestRun: PAUSED_RUN });
      await screen.findByRole('region', { name: 'Recovery' });
      await user.click(screen.getByRole('button', { name: 'Resume' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-runs/runs/run-p/resume') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/workflow-runs/runs/run-p/resume') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(typeof body.commandId).toBe('string');
      expect(typeof body.correlationId).toBe('string');
      await waitFor(() => expect(onRunsChanged).toHaveBeenCalled());
    });

    it('Stop carries the §2.4 explicit choice (the summary + confirm), then sends the REAL cancel command', async () => {
      const routes: Record<string, RouteHandler> = {
        '/workflow-runs/runs/run-p/history': () => jsonResponse(200, history({ run: PAUSED_RUN })),
        'POST /workflow-runs/runs/run-p/cancel': () =>
          jsonResponse(200, { run: { ...PAUSED_RUN, state: 'cancelled' }, executed: true }),
      };
      const { user, fetchMock, onRunsChanged } = renderRecovery({ routes, latestRun: PAUSED_RUN });
      await screen.findByRole('region', { name: 'Recovery' });
      await user.click(screen.getByRole('button', { name: 'Stop' }));
      expect(screen.getByText(/This ends the run — it can\u2019t be restarted\./)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Stop it' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-runs/runs/run-p/cancel') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      await waitFor(() => expect(onRunsChanged).toHaveBeenCalled());
    });

    it('a typed cancel rejection (RUN_TERMINAL — the run ended elsewhere) renders verbatim, never as a silent success', async () => {
      const routes: Record<string, RouteHandler> = {
        '/workflow-runs/runs/run-p/history': () => jsonResponse(200, history({ run: PAUSED_RUN })),
        'POST /workflow-runs/runs/run-p/cancel': () =>
          jsonResponse(409, {
            error: 'workflow-run-terminal',
          }),
      };
      const { user, onRunsChanged } = renderRecovery({ routes, latestRun: PAUSED_RUN });
      await screen.findByRole('region', { name: 'Recovery' });
      await user.click(screen.getByRole('button', { name: 'Stop' }));
      await user.click(screen.getByRole('button', { name: 'Stop it' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('workflow-run-terminal');
      expect(onRunsChanged).not.toHaveBeenCalled();
    });

    it('Take over is the honest entry — no invented command is sent; the note explains the preserved-run semantics', async () => {
      const { user, fetchMock } = renderRecovery({ latestRun: PAUSED_RUN });
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      await user.click(within(panel).getByRole('button', { name: 'Take over' }));
      expect(
        screen.getByText(/Taking over preserves this run and hands control to you\./),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /open the expert workspace/i }),
      ).toHaveAttribute('href', '/expert');
      const posts = fetchMock.mock.calls.filter(
        ([, init]) => (init?.method ?? 'GET') === 'POST',
      );
      expect(posts).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // Progressive disclosure: internal words / ids stay expert-only.
  // -------------------------------------------------------------------

  describe('progressive disclosure (expert-only facts)', () => {
    it('keeps the raw run-state word, the run id, and the attempt count inside Advanced details', async () => {
      const { user } = renderRecovery();
      const panel = await screen.findByRole('region', { name: 'Recovery' });
      expect(within(panel).queryByText(/^failed$/)).not.toBeInTheDocument();
      expect(within(panel).queryByText(/run-9/)).not.toBeInTheDocument();
      await user.click(within(panel).getByText('Advanced details'));
      const facts = within(panel).getByRole('list', { name: 'Recovery facts' });
      expect(within(facts).getByText(/^Run state: failed$/)).toBeInTheDocument();
      expect(within(facts).getByText(/^Run id: run-9$/)).toBeInTheDocument();
      expect(within(facts).getByText(/^Attempts: 1$/)).toBeInTheDocument();
    });
  });
});
