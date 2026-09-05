/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import WhenSection from '../components/when/WhenSection';
import type {
  ProductWorkflow,
  ProductDeployment,
  ProductTriggerSubscription,
  ProductScheduleSpec,
} from '../api/client';

/**
 * V2-017 T8 — the "When" experience contract (Issue #196 dispatch).
 *
 * The When surface composes over EXISTING authorities only: the V2-009
 * workflow-deployments routes (subscription create/enable/disable reads and
 * mutations, deployment create-or-converge) and the V2-002 org-workflow
 * read (for "After another workflow" name resolution). HONESTY RULES:
 *   - human-readable When language for every trigger mode (manual,
 *     scheduled, event, workflow-completion) — the UX spec §11 vocabulary
 *     (Run now / At a time / On a schedule / When something happens /
 *     After another workflow);
 *   - canonical trigger/event semantics are preserved verbatim on the wire:
 *     schedule specs, event patterns, typed matches, and delivery policy
 *     go to the REAL routes unchanged — the frontend never re-derives,
 *     re-validates, or invents scheduling semantics;
 *   - NO next-run fabrication: the frontend never computes occurrences
 *     (the cursor/timezone math is the backend's); only configured facts
 *     are presented;
 *   - typed backend rejections render verbatim as errors, never as state;
 *   - progressive disclosure: simple scheduling first; advanced trigger
 *     controls (timezone, missed windows, event source) only on demand;
 *     canonical event names and subscription identifiers stay expert-only
 *     (Advanced details), never in the primary When language;
 *   - every configured subscription renders (never just the first);
 *     configured-but-disabled triggers are shown as Paused (honest), never
 *     silently dropped;
 *   - a failed read is never a successful empty (page-level all-or-error);
 *     unparseable authoritative facts fail closed to honest unavailable
 *     phrasing, never to fabricated specifics.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  // Keys may carry a method prefix ('POST /path'); the longest fragment
  // wins, and a method-prefixed key matches only that HTTP verb.
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

const OTHER_WORKFLOW: ProductWorkflow = {
  id: 'wf-2',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  slug: 'expense-sweep',
  name: 'Expense sweep',
  description: 'Sweep the weekly expenses.',
  visibility: 'private',
  headVersionId: 'ver-9',
  forkedFromWorkflowId: null,
  forkedFromVersionId: null,
  createdAt: '2026-09-01T11:00:00Z',
  updatedAt: '2026-09-04T09:00:00Z',
};

const DEPLOYMENT: ProductDeployment = {
  id: 'dep-1',
  organizationId: 'org-1',
  workflowId: 'wf-1',
  versionId: 'ver-2',
  installationId: null,
  name: 'Weekly invoice digest',
  description: null,
  placement: { placement: { required: 'cloud_allowed' }, privacy: { localOnly: false } },
  enabled: true,
  enabledAt: '2026-09-02T11:00:00Z',
  disabledAt: null,
  createdByUserId: 'user-1',
  createdAt: '2026-09-02T11:00:00Z',
  updatedAt: '2026-09-02T11:00:00Z',
};

const DEFAULT_POLICY = {
  missWindowMs: 86_400_000,
  missedWindow: 'skip',
  maxAttempts: 8,
  backoffBaseMs: 60_000,
  backoffMaxMs: 3_600_000,
};

function subscription(
  overrides: Partial<ProductTriggerSubscription> & { id: string },
): ProductTriggerSubscription {
  return {
    organizationId: 'org-1',
    deploymentId: 'dep-1',
    kind: 'schedule',
    schedule: null,
    eventPattern: null,
    deliveryPolicy: DEFAULT_POLICY,
    enabled: true,
    cursor: null,
    createdAt: '2026-09-02T11:00:00Z',
    updatedAt: '2026-09-02T11:00:00Z',
    ...overrides,
  } as ProductTriggerSubscription;
}

function renderWhen(
  props: Partial<Parameters<typeof WhenSection>[0]> & {
    routes?: Record<string, RouteHandler>;
  } = {},
) {
  const routes = props.routes ?? {};
  vi.stubGlobal('fetch', mockApi(routes));
  const onChanged = props.onChanged ?? vi.fn();
  const fetchMock = vi.mocked(fetch);
  return {
    user: userEvent.setup(),
    onChanged,
    fetchMock,
    ...render(
      <MemoryRouter>
        <WhenSection
          workflow={props.workflow ?? WORKFLOW}
          deployments={props.deployments ?? [DEPLOYMENT]}
          subscriptions={props.subscriptions ?? []}
          orgWorkflows={props.orgWorkflows ?? [WORKFLOW, OTHER_WORKFLOW]}
          onChanged={onChanged}
        />
      </MemoryRouter>,
    ),
  };
}

describe('V2-017 T8 — the When experience', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------
  // The human When vocabulary (every trigger mode, human-readable).
  // ---------------------------------------------------------------------

  describe('the When presentation (human language over canonical facts)', () => {
    it('presents the manual mode when no trigger is configured, with the contextual Schedule action', () => {
      renderWhen({ subscriptions: [] });
      expect(screen.getByText('Runs when you start it')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Schedule' })).toBeInTheDocument();
    });

    it('presents every configured trigger — never only the first', () => {
      renderWhen({
        subscriptions: [
          subscription({
            id: 'sub-1',
            kind: 'schedule',
            schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
          }),
          subscription({
            id: 'sub-2',
            kind: 'event',
            eventPattern: { eventType: 'file.changed' },
            createdAt: '2026-09-02T12:00:00Z',
          }),
        ],
      });
      const when = screen.getByRole('list', { name: 'When it runs' });
      expect(within(when).getByText('Runs every day · 9:00 AM UTC')).toBeInTheDocument();
      expect(within(when).getByText('Runs when a file changes')).toBeInTheDocument();
    });

    it('presents one-shot, interval, daily, and weekly schedules in human language', () => {
      renderWhen({
        subscriptions: [
          subscription({
            id: 'sub-1',
            schedule: { kind: 'one_shot', at: '2026-09-06T09:00:00.000Z' },
          }),
          subscription({
            id: 'sub-2',
            schedule: { kind: 'interval', everyMs: 7_200_000 },
            createdAt: '2026-09-02T12:00:00Z',
          }),
          subscription({
            id: 'sub-3',
            schedule: { kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '16:30' },
            createdAt: '2026-09-02T13:00:00Z',
          }),
          subscription({
            id: 'sub-4',
            schedule: {
              kind: 'weekly',
              timezone: 'UTC',
              timeOfDay: '16:00',
              daysOfWeek: [1, 5],
            },
            createdAt: '2026-09-02T14:00:00Z',
          }),
        ],
      });
      const when = screen.getByRole('list', { name: 'When it runs' });
      expect(within(when).getByText('Runs once · Sep 6, 2026 at 9:00 AM UTC')).toBeInTheDocument();
      expect(within(when).getByText('Runs every 2 hours')).toBeInTheDocument();
      expect(within(when).getByText('Runs every day · 4:30 PM Africa/Accra')).toBeInTheDocument();
      expect(within(when).getByText('Runs every Mon, Fri · 4:00 PM UTC')).toBeInTheDocument();
    });

    it('presents event and workflow-completion triggers in human language (names resolved from the org read)', () => {
      renderWhen({
        subscriptions: [
          subscription({
            id: 'sub-1',
            kind: 'event',
            eventPattern: {
              eventType: 'workflow.run.completed',
              match: [{ field: 'workflowId', value: 'wf-2' }],
            },
          }),
          subscription({
            id: 'sub-2',
            kind: 'event',
            eventPattern: { eventType: 'phone.call.received' },
            createdAt: '2026-09-02T12:00:00Z',
          }),
        ],
      });
      const when = screen.getByRole('list', { name: 'When it runs' });
      expect(within(when).getByText('Runs after Expense sweep finishes')).toBeInTheDocument();
      expect(within(when).getByText('Runs when a phone call comes in')).toBeInTheDocument();
    });

    it('fails closed when the followed workflow name cannot be resolved — never fabricates', () => {
      renderWhen({
        orgWorkflows: [WORKFLOW],
        subscriptions: [
          subscription({
            id: 'sub-1',
            kind: 'event',
            eventPattern: {
              eventType: 'workflow.run.completed',
              match: [{ field: 'workflowId', value: 'wf-gone' }],
            },
          }),
        ],
      });
      expect(screen.getByText('Runs after another workflow finishes')).toBeInTheDocument();
    });

    it('marks configured-but-disabled triggers as Paused (never silently dropped)', () => {
      renderWhen({
        subscriptions: [
          subscription({
            id: 'sub-1',
            schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
            enabled: false,
          }),
        ],
      });
      expect(screen.getByText('Runs every day · 9:00 AM UTC · Paused')).toBeInTheDocument();
    });

    it('fails closed to honest unavailable phrasing on unparseable authoritative facts', () => {
      renderWhen({
        subscriptions: [
          subscription({ id: 'sub-1', schedule: { kind: 'cron' } as unknown as ProductScheduleSpec }),
          subscription({
            id: 'sub-2',
            kind: 'event',
            eventPattern: { eventType: 'not.a.registry.event' },
            createdAt: '2026-09-02T12:00:00Z',
          }),
        ],
      });
      const when = screen.getByRole('list', { name: 'When it runs' });
      expect(within(when).getByText(/Runs on a schedule \(details unavailable\)/)).toBeInTheDocument();
      expect(within(when).getByText(/Runs on events \(details unavailable\)/)).toBeInTheDocument();
    });

    it('never computes or fabricates a next run — only configured facts are presented', () => {
      renderWhen({
        subscriptions: [
          subscription({ id: 'sub-1', schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' } }),
        ],
      });
      expect(screen.queryByText(/next run/i)).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // Progressive disclosure (§2.3/§11): canonical names and identifiers
  // stay expert-only; advanced controls appear only on demand.
  // ---------------------------------------------------------------------

  describe('progressive disclosure', () => {
    it('keeps the canonical event name, match fields, and subscription identifier out of the primary language — Advanced details only', async () => {
      const { user } = renderWhen({
        subscriptions: [
          subscription({
            id: 'sub-9',
            kind: 'event',
            eventPattern: {
              eventType: 'file.changed',
              source: 'watcher-a',
              match: [{ field: 'path', value: '/reports/monthly.md' }],
            },
          }),
        ],
      });
      const when = screen.getByRole('list', { name: 'When it runs' });
      expect(within(when).queryByText(/file\.changed/)).not.toBeInTheDocument();
      expect(within(when).queryByText(/watcher-a/)).not.toBeInTheDocument();
      expect(screen.queryByText(/sub-9/)).not.toBeInTheDocument();

      await user.click(screen.getByText('Advanced details'));
      const facts = screen.getByRole('list', { name: 'Advanced when facts' });
      expect(within(facts).getByText(/Event type: file\.changed/)).toBeInTheDocument();
      expect(within(facts).getByText(/Source: watcher-a/)).toBeInTheDocument();
      expect(within(facts).getByText(/Match: path = \/reports\/monthly\.md/)).toBeInTheDocument();
      expect(within(facts).getByText(/Missed window: skip/)).toBeInTheDocument();
      expect(within(facts).getByText(/Subscription: sub-9/)).toBeInTheDocument();
    });

    it('exposes the schedule timezone and missed-window policy only inside Advanced details', async () => {
      const { user } = renderWhen({
        subscriptions: [
          subscription({
            id: 'sub-1',
            schedule: { kind: 'daily', timezone: 'Africa/Accra', timeOfDay: '09:00' },
          }),
        ],
      });
      // The primary line carries the timezone fact (it is part of the
      // schedule semantics) but the expert policy line stays hidden.
      expect(screen.queryByText(/Missed window/)).not.toBeInTheDocument();
      await user.click(screen.getByText('Advanced details'));
      expect(screen.getByText(/Timezone: Africa\/Accra/)).toBeInTheDocument();
      expect(screen.getByText(/Missed window: skip/)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // The editor (§11 choices): Run now / At a time / On a schedule /
  // When something happens / After another workflow.
  // ---------------------------------------------------------------------

  describe('the When editor (the §11 choices)', () => {
    it('offers exactly the five §11 choices in plain language', async () => {
      const { user } = renderWhen({ subscriptions: [] });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      const editor = screen.getByRole('region', { name: 'When editor' });
      for (const choice of [
        'Run now',
        'At a time',
        'On a schedule',
        'When something happens',
        'After another workflow',
      ]) {
        expect(within(editor).getByRole('radio', { name: choice })).toBeInTheDocument();
      }
    });

    it('Run now explains the manual mode and sends nothing — no mutation, no invented trigger', async () => {
      const { user, fetchMock } = renderWhen({ subscriptions: [] });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'Run now' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByText(/It runs when you start it\./)).toBeInTheDocument();
      const calls = fetchMock.mock.calls.map(([input, init]) => `${(init?.method ?? 'GET')} ${String(input)}`);
      expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    });

    it('At a time creates the one-shot subscription with the exact fixed-UTC wire format', async () => {
      const { user, fetchMock } = renderWhen({ subscriptions: [] });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'At a time' }));
      await user.clear(screen.getByLabelText('Date (UTC)'));
      await user.type(screen.getByLabelText('Date (UTC)'), '2026-09-06');
      await user.clear(screen.getByLabelText('Time (UTC)'));
      await user.type(screen.getByLabelText('Time (UTC)'), '09:00');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(body).toEqual({
        kind: 'schedule',
        schedule: { kind: 'one_shot', at: '2026-09-06T09:00:00.000Z' },
        enabled: true,
      });
    });

    it('On a schedule creates the daily subscription; timezone and missed-window stay advanced', async () => {
      const { user, fetchMock } = renderWhen({ subscriptions: [] });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'On a schedule' }));
      // Simple surface: only the repeat mode + the time.
      expect(screen.queryByLabelText('Timezone')).not.toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText('How often?'), 'daily');
      await user.clear(screen.getByLabelText('Time'));
      await user.type(screen.getByLabelText('Time'), '09:00');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      // The default policy is NOT re-sent — the backend owns the defaults.
      expect(body).toEqual({
        kind: 'schedule',
        schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
        enabled: true,
      });
    });

    it('weekly: the chosen weekdays travel as sorted ISO days; the advanced timezone is honored', async () => {
      const { user, fetchMock } = renderWhen({ subscriptions: [] });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'On a schedule' }));
      await user.selectOptions(screen.getByLabelText('How often?'), 'weekly');
      await user.click(screen.getByLabelText('Friday'));
      await user.click(screen.getByLabelText('Monday'));
      await user.clear(screen.getByLabelText('Time'));
      await user.type(screen.getByLabelText('Time'), '16:00');
      await user.click(screen.getByText('Advanced controls'));
      await user.clear(screen.getByLabelText('Timezone'));
      await user.type(screen.getByLabelText('Timezone'), 'Africa/Accra');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(body.schedule).toEqual({
        kind: 'weekly',
        timezone: 'Africa/Accra',
        timeOfDay: '16:00',
        daysOfWeek: [1, 5],
      });
    });

    it('When something happens creates the event subscription with the canonical registry name', async () => {
      const { user, fetchMock } = renderWhen({ subscriptions: [] });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'When something happens' }));
      await user.selectOptions(screen.getByLabelText('What event?'), 'file.changed');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(body).toEqual({
        kind: 'event',
        eventPattern: { eventType: 'file.changed' },
        enabled: true,
      });
    });

    it('After another workflow creates the workflow-completion trigger with the typed workflowId match', async () => {
      const { user, fetchMock } = renderWhen({ subscriptions: [] });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'After another workflow' }));
      await user.selectOptions(screen.getByLabelText('Which workflow?'), 'wf-2');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(body).toEqual({
        kind: 'event',
        eventPattern: {
          eventType: 'workflow.run.completed',
          match: [{ field: 'workflowId', value: 'wf-2' }],
        },
        enabled: true,
      });
    });

    it('creates the deployment first (create-or-converge, any-supported placement, the head version) when none exists, then attaches the subscription', async () => {
      const routes: Record<string, RouteHandler> = {
        'POST /organizations/org-1/workflow-deployments/deployments': () =>
          jsonResponse(201, {
            deployment: {
              id: 'dep-new',
              organizationId: 'org-1',
              workflowId: 'wf-1',
              versionId: 'ver-2',
              installationId: null,
              name: 'Weekly invoice digest',
              description: null,
              placement: {
                placement: { required: 'any_supported_node' },
                privacy: { localOnly: false },
              },
              enabled: true,
              enabledAt: '2026-09-05T09:00:00Z',
              disabledAt: null,
              createdByUserId: 'user-1',
              createdAt: '2026-09-05T09:00:00Z',
              updatedAt: '2026-09-05T09:00:00Z',
            },
            created: true,
          }),
        'POST /workflow-deployments/deployments/dep-new/subscriptions': () =>
          jsonResponse(201, {
            subscription: {
              id: 'sub-new',
              organizationId: 'org-1',
              deploymentId: 'dep-new',
              kind: 'schedule',
              schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
              eventPattern: null,
              deliveryPolicy: DEFAULT_POLICY,
              enabled: true,
              cursor: null,
              createdAt: '2026-09-05T09:00:00Z',
              updatedAt: '2026-09-05T09:00:00Z',
            },
            created: true,
          }),
      };
      const { user, fetchMock } = renderWhen({ deployments: [], routes });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'On a schedule' }));
      await user.clear(screen.getByLabelText('Time'));
      await user.type(screen.getByLabelText('Time'), '09:00');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      // The deployment create (201 create-or-converge) precedes the
      // subscription create on the returned deployment.
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/organizations/org-1/workflow-deployments/deployments') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const deploymentBody = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/organizations/org-1/workflow-deployments/deployments') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(deploymentBody).toEqual({
        workflowId: 'wf-1',
        versionId: 'ver-2',
        name: 'Weekly invoice digest',
        placement: { placement: { required: 'any_supported_node' }, privacy: { localOnly: false } },
      });
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-new/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const subscriptionBody = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-new/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(subscriptionBody).toEqual({
        kind: 'schedule',
        schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
        enabled: true,
      });
    });

    it('renders a typed backend rejection verbatim — never as a state — and stays open for correction', async () => {
      const routes: Record<string, RouteHandler> = {
        'POST /workflow-deployments/deployments/dep-1/subscriptions': () =>
          jsonResponse(400, {
            error: 'workflow-deployment-subscription-schedule-invalid',
            code: 'SUBSCRIPTION_SCHEDULE_INVALID',
            message: 'one_shot.at must be a fixed-format UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ)',
          }),
      };
      const { user } = renderWhen({ routes });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'At a time' }));
      await user.clear(screen.getByLabelText('Date (UTC)'));
      await user.type(screen.getByLabelText('Date (UTC)'), '2026-09-06');
      await user.clear(screen.getByLabelText('Time (UTC)'));
      await user.type(screen.getByLabelText('Time (UTC)'), '09:00');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'workflow-deployment-subscription-schedule-invalid',
      );
      // The editor stays open (the honest retry path).
      expect(screen.getByRole('region', { name: 'When editor' })).toBeInTheDocument();
    });

    it('confirms with the new human phrase and refreshes through the page callback after a successful save', async () => {
      const routes: Record<string, RouteHandler> = {
        'POST /workflow-deployments/deployments/dep-1/subscriptions': () =>
          jsonResponse(201, {
            subscription: {
              id: 'sub-new',
              organizationId: 'org-1',
              deploymentId: 'dep-1',
              kind: 'schedule',
              schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
              eventPattern: null,
              deliveryPolicy: DEFAULT_POLICY,
              enabled: true,
              cursor: null,
              createdAt: '2026-09-05T09:00:00Z',
              updatedAt: '2026-09-05T09:00:00Z',
            },
            created: true,
          }),
      };
      const { user, onChanged } = renderWhen({ routes });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'On a schedule' }));
      await user.clear(screen.getByLabelText('Time'));
      await user.type(screen.getByLabelText('Time'), '09:00');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(
        await screen.findByText(/Scheduled · Runs every day · 9:00 AM UTC/),
      ).toBeInTheDocument();
    });

    it('sends the non-default missed-window policy only when the advanced control changes it', async () => {
      const { user, fetchMock } = renderWhen({ subscriptions: [] });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'On a schedule' }));
      await user.click(screen.getByText('Advanced controls'));
      await user.selectOptions(
        screen.getByLabelText('If a run is missed'),
        'catch_up_run_now',
      );
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      const body = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/deployments/dep-1/subscriptions') &&
              (init?.method ?? 'GET') === 'POST',
          )?.[1]?.body,
        ),
      );
      expect(body.deliveryPolicy).toEqual({ missedWindow: 'catch_up_run_now' });
    });

    it('exposes advanced controls only after they are asked for (simple scheduling first)', async () => {
      const { user } = renderWhen({ subscriptions: [] });
      await user.click(screen.getByRole('button', { name: 'Schedule' }));
      await user.click(screen.getByRole('radio', { name: 'On a schedule' }));
      expect(screen.queryByLabelText('Timezone')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('If a run is missed')).not.toBeInTheDocument();
      await user.click(screen.getByText('Advanced controls'));
      expect(screen.getByLabelText('Timezone')).toBeInTheDocument();
      expect(screen.getByLabelText('If a run is missed')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // Pause / Resume — the existing enable/disable authority, honestly.
  // ---------------------------------------------------------------------

  describe('pause and resume (the existing subscription enable/disable authority)', () => {
    it('pauses a trigger through the real route and refreshes', async () => {
      const routes: Record<string, RouteHandler> = {
        'POST /workflow-deployments/subscriptions/sub-1/disable': () =>
          jsonResponse(200, {
            subscription: {
              id: 'sub-1',
              organizationId: 'org-1',
              deploymentId: 'dep-1',
              kind: 'schedule',
              schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
              eventPattern: null,
              deliveryPolicy: DEFAULT_POLICY,
              enabled: false,
              cursor: null,
              createdAt: '2026-09-02T11:00:00Z',
              updatedAt: '2026-09-05T09:00:00Z',
            },
          }),
      };
      const { user, fetchMock, onChanged } = renderWhen({
        routes,
        subscriptions: [
          subscription({ id: 'sub-1', schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' } }),
        ],
      });
      await user.click(screen.getByRole('button', { name: 'Pause' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/subscriptions/sub-1/disable') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      expect(await screen.findByText(/Paused/)).toBeInTheDocument();
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('resumes a paused trigger through the real route', async () => {
      const routes: Record<string, RouteHandler> = {
        'POST /workflow-deployments/subscriptions/sub-1/enable': () =>
          jsonResponse(200, {
            subscription: {
              id: 'sub-1',
              organizationId: 'org-1',
              deploymentId: 'dep-1',
              kind: 'schedule',
              schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
              eventPattern: null,
              deliveryPolicy: DEFAULT_POLICY,
              enabled: true,
              cursor: null,
              createdAt: '2026-09-02T11:00:00Z',
              updatedAt: '2026-09-05T09:00:00Z',
            },
          }),
      };
      const { user, fetchMock } = renderWhen({
        routes,
        subscriptions: [
          subscription({
            id: 'sub-1',
            schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
            enabled: false,
          }),
        ],
      });
      expect(screen.getByText(/Paused/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Resume' }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              String(input).includes('/workflow-deployments/subscriptions/sub-1/enable') &&
              (init?.method ?? 'GET') === 'POST',
          ),
        ).toBe(true),
      );
      expect(screen.queryByText(/Paused/)).not.toBeInTheDocument();
    });

    it('renders a same-state 409 rejection verbatim — never as a silent success', async () => {
      const routes: Record<string, RouteHandler> = {
        'POST /workflow-deployments/subscriptions/sub-1/disable': () =>
          jsonResponse(409, {
            error: 'workflow-deployment-subscription-already-disabled',
          }),
      };
      const { user } = renderWhen({
        routes,
        subscriptions: [
          subscription({ id: 'sub-1', schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' } }),
        ],
      });
      await user.click(screen.getByRole('button', { name: 'Pause' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('workflow-deployment-subscription-already-disabled');
    });
  });
});
