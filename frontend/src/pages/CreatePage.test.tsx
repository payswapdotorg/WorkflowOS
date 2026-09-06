/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CreatePage from './CreatePage';

/**
 * V2-017 T2 — the creation entry-point landing contract.
 *
 * The Home entry buttons and the search box navigate to /create carrying
 * the chosen entry mode (tell / show / tell-show) and the typed goal (q).
 * CreatePage receives them: the matching entry mode is marked active and
 * the goal is shown as the starting context. Without parameters the page
 * stays neutral — no fabricated selection or goal.
 */

function renderCreate(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/create${search}`]}>
      <CreatePage />
    </MemoryRouter>,
  );
}

describe('V2-017 T2 — Create entry-point landing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks the Show entry mode active and shows the typed goal', () => {
    renderCreate('?mode=show&q=invoice%20processing');
    const modes = screen.getByRole('list', { name: /creation entry modes/i });
    expect(within(modes).getByText('Show').closest('li')?.getAttribute('aria-current')).toBe('true');
    expect(within(modes).getByText('Tell').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(within(modes).getByText('Tell + Show').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(screen.getByText(/invoice processing/i)).toBeInTheDocument();
  });

  it('marks the Tell + Show entry mode active for mode=tell-show', () => {
    renderCreate('?mode=tell-show');
    const modes = screen.getByRole('list', { name: /creation entry modes/i });
    expect(within(modes).getByText('Tell + Show').closest('li')?.getAttribute('aria-current')).toBe('true');
  });

  it('stays neutral without mode or goal parameters', () => {
    renderCreate('');
    const modes = screen.getByRole('list', { name: /creation entry modes/i });
    expect(within(modes).getByText('Show').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(within(modes).getByText('Tell').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(within(modes).getByText('Tell + Show').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(screen.queryByText(/your goal/i)).not.toBeInTheDocument();
  });
});

/**
 * V2-017 T5 — the Tell / Show / Tell + Show creation contract.
 *
 * Creation starts from the goal (UX spec §7): the entry mode lands from T2;
 * T5 owns the capture → understanding preview → correction → EXPLICIT
 * COMMIT flow, composed over the existing V2-002 authoring route.
 *
 * HONESTY RULES:
 *   - the preview shows exactly what the user told/showed (verbatim) plus
 *     the structured fields they can CORRECT — it never INVENTS understood
 *     steps/capabilities (surfacing the honest limitation instead);
 *   - the captured input is transient client-local state, never durable
 *     workflow truth: nothing renders as created before the authoritative
 *     POST succeeds, and the success surface renders FROM THE RESPONSE;
 *   - the durable commit FAILS CLOSED (F-T5-001): the frozen V2-002
 *     contract requires a version's irSchemaVersion to truthfully declare
 *     WorkflowIR compatibility, the IR requires at least one authored node,
 *     and no public authoring authority accepts captured input — so the
 *     preview surfaces the MISSING-AUTHORITY dependency honestly and NO
 *     create POST (with any fabricated/non-WorkflowIR irSchemaVersion) is
 *     ever sent; nothing renders as committed;
 *   - the correction surface (name/slug/description/visibility) remains
 *     the user-owned preview of what they meant.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  // Longest fragment first: the org-scoped create URL must match its own
  // handler, never the bare '/organizations' one.
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    for (const [fragment, handler] of ordered) {
      if (url.includes(fragment)) return Promise.resolve(handler(input, init));
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${url}` }));
  });
}

const orgsOne = () =>
  jsonResponse(200, {
    organizations: [{ id: 'org-1', name: 'Acme', roleId: 'owner' }],
  });

function renderCreateFlow(search: string, routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi(routes));
  return render(
    <MemoryRouter initialEntries={[`/create${search}`]}>
      <CreatePage />
    </MemoryRouter>,
  );
}

async function reachPreview(
  routes: Record<string, RouteHandler>,
  options: { mode?: string; goal?: string; steps?: string[] } = {},
) {
  const { mode = 'tell', goal = '', steps = [] } = options;
  const search = `?mode=${mode}${goal ? `&q=${encodeURIComponent(goal)}` : ''}`;
  renderCreateFlow(search, routes);
  const user = userEvent.setup();
  if (mode === 'tell' || mode === 'tell-show') {
    const box = await screen.findByRole('textbox', { name: /describe what you want done/i });
    if (goal) {
      // The typed goal pre-fills the Tell capture.
      expect(box).toHaveValue(goal);
    } else {
      await user.type(box, 'Send the weekly invoice digest');
    }
  }
  if (mode === 'show' || mode === 'tell-show') {
    for (const step of steps.length > 0 ? steps : ['Open the sales dashboard', 'Export the report']) {
      await user.type(
        screen.getByRole('textbox', { name: /describe one step/i }),
        step,
      );
      await user.click(screen.getByRole('button', { name: 'Add step' }));
    }
  }
  await user.click(screen.getByRole('button', { name: 'Continue to preview' }));
  await screen.findByRole('heading', { name: /here's what i understood/i });
  return user;
}

describe('V2-017 T5 — Tell / Show / Tell + Show creation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Tell: capture → understanding preview shows the description verbatim and NO invented steps', async () => {
    await reachPreview({ '/organizations': orgsOne });
    // The description the user gave is echoed back for correction.
    const echo = within(screen.getByRole('region', { name: 'Captured input' }));
    expect(echo.getByText(/Send the weekly invoice digest/i)).toBeInTheDocument();
    // The honest limitation is surfaced, not fabricated understanding.
    expect(
      screen.getByText(/can't yet turn your description into executable steps/i),
    ).toBeInTheDocument();
    // REALITY-REPAIR-004 Slice A: the captured input is NEVER recorded as
    // durable workflow content (the corrected copy).
    expect(
      screen.getByText(/never recorded as durable workflow content/i),
    ).toBeInTheDocument();
    // Correction fields exist: the structured facts the user owns.
    expect(screen.getByRole('textbox', { name: /workflow name/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /workflow slug/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /visibility/i })).toBeInTheDocument();
    // Transient state is not durable truth: nothing renders as created yet.
    expect(screen.queryByText(/workflow created/i)).not.toBeInTheDocument();
  });

  it('Show: demonstration steps appear numbered in the preview', async () => {
    await reachPreview(
      { '/organizations': orgsOne },
      { mode: 'show', steps: ['Open the sales dashboard', 'Export the report', 'Rename the file'] },
    );
    const steps = screen.getByRole('list', { name: /your demonstration/i });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Open the sales dashboard',
      'Export the report',
      'Rename the file',
    ]);
    // The honest provenance note (UX spec §7: captures are never the durable
    // workflow itself — the REALITY-REPAIR-004 corrected copy).
    expect(screen.getByText(/never recorded as durable workflow content/i)).toBeInTheDocument();
  });

  it('Tell + Show: the preview shows both the description and the steps', async () => {
    await reachPreview(
      { '/organizations': orgsOne },
      { mode: 'tell-show', goal: 'Send the weekly invoice digest', steps: ['Collect the invoices'] },
    );
    const echo = within(screen.getByRole('region', { name: 'Captured input' }));
    expect(echo.getByText(/Send the weekly invoice digest/i)).toBeInTheDocument();
    expect(echo.getByText('Collect the invoices')).toBeInTheDocument();
  });

  it('Change something returns to the capture with the input preserved', async () => {
    const user = await reachPreview({ '/organizations': orgsOne });
    await user.click(screen.getByRole('button', { name: 'Change something' }));
    expect(
      await screen.findByRole('textbox', { name: /describe what you want done/i }),
    ).toHaveValue('Send the weekly invoice digest');
    expect(screen.queryByRole('heading', { name: /here's what i understood/i })).not.toBeInTheDocument();
  });

  it('FAILS CLOSED (F-T5-001): the preview surfaces the missing-authority dependency and NO create POST is ever sent', async () => {
    await reachPreview({
      '/organizations': orgsOne,
      // The authoring route is mocked ONLY to prove it is never called:
      // any call here would carry a fabricated/non-WorkflowIR
      // irSchemaVersion on a durable WorkflowVersion — the F-T5-001
      // blocking violation.
      '/organizations/org-1/workflow-repository/workflows': () => {
        throw new Error('F-T5-001 violation: the create route must never be called from the captured-input flow');
      },
    });
    // The honest missing-authority state (REALITY-REPAIR-004 Slice A: the
    // heading is scoped to captured input — the truthful boundary).
    expect(
      screen.getByText(/durable creation isn't available for captured input/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/accepts workflowir content only/i)).toBeInTheDocument();
    expect(screen.getByText(/missing/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is committed/i)).toBeInTheDocument();
    // The deterministic no-fabricated-descriptor proof: no POST (no call of
    // any kind) to the authoring route ever left the page.
    const fetchMock = vi.mocked(fetch);
    const createCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/workflow-repository/workflows'),
    );
    expect(createCalls).toHaveLength(0);
    expect(screen.queryByText(/workflow created/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the fail-closed state holds even when the captured input is fully corrected — no commit affordance exists', async () => {
    const user = await reachPreview({ '/organizations': orgsOne });
    // The correction surface remains (the user-owned preview of intent)...
    await user.clear(screen.getByRole('textbox', { name: /workflow name/i }));
    await user.type(screen.getByRole('textbox', { name: /workflow name/i }), 'Weekly invoice digest');
    expect(screen.getByRole('textbox', { name: /workflow name/i })).toHaveValue('Weekly invoice digest');
    // ...but there is NO commit button to press.
    expect(screen.queryByRole('button', { name: /create workflow/i })).not.toBeInTheDocument();
    const fetchMock = vi.mocked(fetch);
    const createCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/workflow-repository/workflows'),
    );
    expect(createCalls).toHaveLength(0);
  });
});

/**
 * REALITY-REPAIR-004 Slice A — the truthful creation boundary (F-004a).
 *
 * The audit's honesty defect (V2-REALITY-AUDIT-001 FINDING-004a): the
 * preview promised "the durable workflow is created with immutable Version
 * 1, and executable authoring happens later from the workflow surface" —
 * false on both counts (no create POST is ever sent from the
 * captured-input flow, and no authoring surface existed anywhere in the
 * product).
 *
 * The corrected copy:
 *   - states the true fail-closed fact EXPLICITLY — natural-language
 *     capture is NOT converted into executable WorkflowIR (no generation
 *     authority exists);
 *   - removes the false Version-1 / "authoring happens later" promise;
 *   - now that Slice B's bounded expert authoring exists, points the user
 *     to the REAL expert authoring entry (/expert) instead of implying no
 *     authoring path exists at all;
 *   - PRESERVES the captured-input fail-closed behavior: the captured
 *     input stays transient client-local state — never a create POST.
 */
describe('REALITY-REPAIR-004 Slice A — the truthful creation boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('states the true boundary: natural-language capture is NOT converted into executable WorkflowIR — the false promise sentences are gone', async () => {
    await reachPreview({ '/organizations': orgsOne });
    // The true fail-closed fact, stated explicitly (Work Order Slice A).
    expect(screen.getByText(/natural-language capture/i)).toBeInTheDocument();
    expect(screen.getByText(/isn't converted into executable workflowir/i)).toBeInTheDocument();
    expect(screen.getByText(/no generation authority exists/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is created from this page/i)).toBeInTheDocument();
    // The F-004a false promise sentences are GONE.
    expect(
      screen.queryByText(/durable workflow is created with immutable version 1/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/executable authoring happens later/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/recorded as the starting content/i)).not.toBeInTheDocument();
  });

  it('points to the REAL expert authoring entry (/expert) while staying fail-closed — no create POST, the capture stays transient', async () => {
    await reachPreview({
      '/organizations': orgsOne,
      // The authoring route is mocked ONLY to prove it is never called:
      // any call here would carry a fabricated/non-WorkflowIR
      // irSchemaVersion on a durable WorkflowVersion — the F-T5-001
      // blocking violation (PRESERVED by this repair).
      '/organizations/org-1/workflow-repository/workflows': () => {
        throw new Error('F-T5-001 violation: the create route must never be called from the captured-input flow');
      },
    });
    // The boundary card keeps the fail-closed facts (re-scoped truthfully:
    // captured INPUT cannot create — not "no creation exists anywhere").
    expect(
      screen.getByText(/durable creation isn't available for captured input/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing is committed/i)).toBeInTheDocument();
    // The real expert authoring entry exists and points at /expert.
    const expertEntry = screen.getByRole('link', {
      name: /author a workflow in the expert workspace/i,
    });
    expect(expertEntry).toHaveAttribute('href', '/expert');
    // The captured input STILL never becomes a create POST.
    const fetchMock = vi.mocked(fetch);
    const createCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/workflow-repository/workflows'),
    );
    expect(createCalls).toHaveLength(0);
    expect(screen.queryByText(/workflow created/i)).not.toBeInTheDocument();
  });
});
