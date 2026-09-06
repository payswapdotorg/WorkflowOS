/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ExpertPage from './ExpertPage';

/**
 * REALITY-REPAIR-004 Slice B — the bounded expert workflow authoring
 * contract (F-004b; Architect disposition: composition-only expert
 * authoring, AI generation deferred).
 *
 * The audit's finding (V2-REALITY-AUDIT-001 FINDING-004): the ONLY user
 * paths to a workflow were marketplace install and fork; the ONLY path to a
 * new version was optimization-proposal adoption. Raw authoring had no UX —
 * while the backend V2-002 `createWorkflow` / `createVersion` commands
 * EXIST and are proven (the dogfooding authored versions through them).
 *
 * This is the bounded composition-only repair: the expert workspace hosts
 * an authoring surface over the EXISTING commands and the EXISTING
 * server-side V2-003 validation. The expert authors the truthful WorkflowIR
 * document DIRECTLY (a JSON editor).
 *
 * BOUNDARY RULES (the Work Order's own prohibitions):
 *   - NO new workflow model, NO compiler, NO execution authority, NO
 *     AI-generation authority — the surface composes createWorkflow /
 *     createVersion only; the JSON editor is transport (the semantic
 *     validation stays server-side; typed rejections render verbatim);
 *   - the create command flows through the REAL V2-002 route with the REAL
 *     body contract (slug, name, description, visibility, content, protocol
 *     declaring irSchemaVersion);
 *   - success renders FROM THE AUTHORITATIVE RESPONSE (the created workflow
 *     identity + the created version facts + the durable library links) —
 *     nothing renders as created before the 201/200 responds;
 *   - create-or-converge is rendered honestly (created: false says the
 *     workflow already existed — never a fabricated new creation);
 *   - typed backend rejections render VERBATIM with the editor staying
 *     open;
 *   - invalid JSON is an honest local SYNTAX error — nothing is sent.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

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
          return Promise.resolve(handler(input, init));
        }
        continue;
      }
      if (url.includes(key)) return Promise.resolve(handler(input, init));
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${url}` }));
  });
}

const orgsOne: RouteHandler = () =>
  jsonResponse(200, {
    organizations: [{ id: 'org-1', name: 'Acme', roleId: 'owner' }],
  });

const orgsTwo: RouteHandler = () =>
  jsonResponse(200, {
    organizations: [
      { id: 'org-1', name: 'Acme', roleId: 'owner' },
      { id: 'org-2', name: 'Globex', roleId: 'owner' },
    ],
  });

// A plausible WorkflowIR document the EXPERT authors by hand (the shape is
// the expert's own responsibility — the backend owns the semantic
// validation; this fixture only needs to be the JSON the user typed).
const IR_V1_TEXT = JSON.stringify(
  {
    objectType: 'workflowos.workflow.ir',
    irSchemaVersion: 1,
    compatibility: { affectsVersion: true },
    ir: {
      start: 'fetch_tickets',
      nodes: [{ id: 'fetch_tickets', executionClass: 'deterministic_api' }],
      edges: [],
    },
    presentation: {
      title: 'Expert digest',
      nodeLabels: { fetch_tickets: 'Collect the open tickets' },
    },
  },
  null,
  2,
);

const IR_V2_TEXT = JSON.stringify(
  {
    objectType: 'workflowos.workflow.ir',
    irSchemaVersion: 1,
    compatibility: { affectsVersion: true },
    ir: {
      start: 'fetch_tickets',
      nodes: [{ id: 'fetch_tickets', executionClass: 'deterministic_api' }],
      edges: [],
    },
    presentation: {
      title: 'Expert digest v2',
      nodeLabels: { fetch_tickets: 'Collect the fresh tickets' },
    },
  },
  null,
  2,
);

const CREATE_RESPONSE = {
  workflow: {
    id: 'wf-new',
    organizationId: 'org-1',
    ownerUserId: 'user-1',
    slug: 'expert-digest',
    name: 'Expert digest',
    description: 'The expert-authored digest.',
    visibility: 'private',
    headVersionId: 'ver-1',
    forkedFromWorkflowId: null,
    forkedFromVersionId: null,
    createdAt: '2026-09-05T10:00:00Z',
    updatedAt: '2026-09-05T10:00:00Z',
  },
  initialVersion: {
    id: 'ver-1',
    workflowId: 'wf-new',
    versionNumber: 1,
    contentDigest: 'sha256:version-one-digest',
    content: {},
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-05T10:00:00Z',
  },
  created: true,
};

const VERSION_RESPONSE = {
  version: {
    id: 'ver-2',
    workflowId: 'wf-new',
    versionNumber: 2,
    contentDigest: 'sha256:version-two-digest',
    content: {},
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId: 'ver-1',
    createdByUserId: 'user-1',
    createdAt: '2026-09-05T11:00:00Z',
  },
  created: true,
};

function renderExpert(routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi(routes));
  return render(
    <MemoryRouter initialEntries={['/expert']}>
      <ExpertPage />
    </MemoryRouter>,
  );
}

/** Sets a textarea's value directly (JSON braces are not typeable). */
async function setEditorValue(
  editor: HTMLTextAreaElement | HTMLInputElement,
  text: string,
): Promise<void> {
  fireEvent.change(editor, { target: { value: text } });
}

/** The authoritative rejection the REAL route answers (typed wire shape). */
const INVALID_SLUG_REJECTION: RouteHandler = () =>
  jsonResponse(400, {
    error: 'workflow-invalid-slug',
    code: 'WORKFLOW_INVALID_SLUG',
    message:
      'slug must be 1-64 lowercase alphanumeric characters with no leading/trailing hyphen (got: "Expert Digest")',
  });

const INVALID_PROTOCOL_REJECTION: RouteHandler = () =>
  jsonResponse(400, {
    error: 'workflow-invalid-protocol',
    code: 'WORKFLOW_INVALID_PROTOCOL',
    message: 'protocol must declare exactly irSchemaVersion',
  });

describe('REALITY-REPAIR-004 Slice B — the bounded expert authoring surface', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the honest bounded surface: organization selection, the metadata fields, and the EMPTY WorkflowIR editor the expert authors directly (no generation)', async () => {
    renderExpert({ '/organizations': orgsOne });
    const surface = await screen.findByRole('region', { name: /expert workflow authoring/i });
    // The organization the create command is scoped to (the product-shell
    // selection — organizations.listForUser).
    const orgSelect = await within(surface).findByRole('combobox', { name: /for organization/i });
    expect(orgSelect).toHaveValue('org-1');
    expect(within(orgSelect).getByRole('option', { name: 'Acme' })).toBeInTheDocument();
    // The workflow metadata fields.
    expect(within(surface).getByRole('textbox', { name: /workflow name/i })).toBeInTheDocument();
    expect(within(surface).getByRole('textbox', { name: /workflow slug/i })).toBeInTheDocument();
    expect(
      within(surface).getByRole('textbox', { name: /description \(optional\)/i }),
    ).toBeInTheDocument();
    expect(within(surface).getByRole('combobox', { name: /visibility/i })).toBeInTheDocument();
    // The truthful WorkflowIR editor: EMPTY — the expert authors the IR
    // document themselves. No generation, no node-graph builder.
    expect(
      within(surface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
    ).toHaveValue('');
    // The protocol declaration (the version's truthful compatibility
    // descriptor) is explicit, defaulting to the current WorkflowIR
    // descriptor.
    expect(
      within(surface).getByRole('textbox', { name: /protocol irschemaversion/i }),
    ).toHaveValue('workflowos-workflow-ir-v1');
    // The honest boundary copy: the expert authors directly; the backend
    // validates; nothing is generated.
    expect(within(surface).getByText(/generates nothing/i)).toBeInTheDocument();
    expect(within(surface).getByText(/author the workflowir document/i)).toBeInTheDocument();
    expect(within(surface).getByText(/validated server-side/i)).toBeInTheDocument();
    // The second command's surface (a new version for an EXISTING
    // workflow) is present too.
    const versionSurface = await screen.findByRole('region', { name: /create a new version/i });
    expect(within(versionSurface).getByRole('textbox', { name: /workflow id/i })).toBeInTheDocument();
  });

  it('two organizations: the selector carries both and the command targets the CHOSEN one', async () => {
    renderExpert({
      '/organizations': orgsTwo,
      'POST /organizations/org-2/workflow-repository/workflows': () =>
        jsonResponse(201, {
          ...CREATE_RESPONSE,
          workflow: { ...CREATE_RESPONSE.workflow, id: 'wf-globex', organizationId: 'org-2' },
        }),
    });
    const surface = await screen.findByRole('region', { name: /expert workflow authoring/i });
    const orgSelect = await within(surface).findByRole('combobox', { name: /for organization/i });
    await userEvent.selectOptions(orgSelect, 'org-2');
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow name/i }), 'Expert digest');
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow slug/i }), 'expert-digest');
    await setEditorValue(
      within(surface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
      IR_V1_TEXT,
    );
    await userEvent.click(within(surface).getByRole('button', { name: /create workflow/i }));
    await waitFor(() => {
      expect(screen.getByText(/workflow created/i)).toBeInTheDocument();
    });
    const fetchMock = vi.mocked(fetch);
    const createCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/workflow-repository/workflows'),
    );
    expect(createCall).toBeDefined();
    expect(String(createCall?.[0])).toContain('/api/organizations/org-2/workflow-repository/workflows');
  });

  it('zero organizations: the RR-002 onboarding is the actionable state (the create command needs an organization) — never a silent dead end', async () => {
    renderExpert({
      '/organizations': () => jsonResponse(200, { organizations: [] }),
      'POST /organizations': () =>
        jsonResponse(201, {
          organization: { id: 'org-created', name: 'Newly Created', roleId: 'owner' },
          roleId: 'role-owner',
        }),
    });
    // The zero-org actionable onboarding (the existing RR-002 component).
    const onboarding = await screen.findByRole('region', { name: /organization onboarding/i });
    expect(
      within(onboarding).getByRole('button', { name: /create organization/i }),
    ).toBeInTheDocument();
    // Creating the organization makes the authoring surface reachable.
    await userEvent.type(
      within(onboarding).getByRole('textbox', { name: /organization name/i }),
      'Newly Created',
    );
    await userEvent.click(within(onboarding).getByRole('button', { name: /create organization/i }));
    const surface = await screen.findByRole('region', { name: /expert workflow authoring/i });
    expect(
      await within(surface).findByRole('combobox', { name: /for organization/i }),
    ).toHaveValue('org-created');
  });

  it('the organizations read failure renders an honest error with retry — never a fabricated empty selection', async () => {
    let fail = true;
    renderExpert({
      '/organizations': () =>
        fail ? jsonResponse(500, { error: 'boom' }) : jsonResponse(200, { organizations: [] }),
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/organizations are unavailable/i)).toBeInTheDocument();
    // Retry is explicit (a failed read is never a successful empty).
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: /try again/i }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('the create flow: authoring WorkflowIR + metadata through the REAL V2-002 createWorkflow command — the POST body is exact, and the authoritative 201 facts render (identity + Version 1 + the library links)', async () => {
    renderExpert({
      '/organizations': orgsOne,
      'POST /organizations/org-1/workflow-repository/workflows': () =>
        jsonResponse(201, CREATE_RESPONSE),
    });
    const surface = await screen.findByRole('region', { name: /expert workflow authoring/i });
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow name/i }), 'Expert digest');
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow slug/i }), 'expert-digest');
    await userEvent.type(
      within(surface).getByRole('textbox', { name: /description \(optional\)/i }),
      'The expert-authored digest.',
    );
    await setEditorValue(
      within(surface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
      IR_V1_TEXT,
    );
    await userEvent.click(within(surface).getByRole('button', { name: /create workflow/i }));

    // The authoritative created facts render FROM THE RESPONSE.
    const done = await screen.findByRole('status', { name: /workflow created/i });
    expect(within(done).getByText(/born with immutable version 1/i)).toBeInTheDocument();
    expect(within(done).getByText('Expert digest')).toBeInTheDocument();
    expect(within(done).getByText('expert-digest')).toBeInTheDocument();
    expect(within(done).getByText('wf-new')).toBeInTheDocument();
    expect(within(done).getByText('sha256:version-one-digest')).toBeInTheDocument();
    // The durable library links.
    expect(
      within(done).getByRole('link', { name: /open in your workflows library/i }),
    ).toHaveAttribute('href', '/workflows/wf-new');
    expect(within(done).getByRole('link', { name: /back to the library/i })).toHaveAttribute(
      'href',
      '/workflows',
    );
    // The version surface carries the created workflow forward (the next
    // command's target — user-owned, editable).
    const versionSurface = screen.getByRole('region', { name: /create a new version/i });
    await waitFor(() => {
      expect(within(versionSurface).getByRole('textbox', { name: /workflow id/i })).toHaveValue(
        'wf-new',
      );
    });

    // The REAL route, the REAL body contract (content is the PARSED JSON —
    // never the raw text; protocol declares irSchemaVersion).
    const fetchMock = vi.mocked(fetch);
    const createCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/organizations/org-1/workflow-repository/workflows'),
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      slug: 'expert-digest',
      name: 'Expert digest',
      description: 'The expert-authored digest.',
      visibility: 'private',
      content: JSON.parse(IR_V1_TEXT),
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    });
  });

  it('create-or-converge honesty: a converged create (created: false, 200) says the workflow already existed — never a fabricated new creation', async () => {
    renderExpert({
      '/organizations': orgsOne,
      'POST /organizations/org-1/workflow-repository/workflows': () =>
        jsonResponse(200, { ...CREATE_RESPONSE, created: false }),
    });
    const surface = await screen.findByRole('region', { name: /expert workflow authoring/i });
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow name/i }), 'Expert digest');
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow slug/i }), 'expert-digest');
    await setEditorValue(
      within(surface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
      IR_V1_TEXT,
    );
    await userEvent.click(within(surface).getByRole('button', { name: /create workflow/i }));
    const done = await screen.findByRole('status', { name: /workflow created/i });
    expect(within(done).getByText(/already exists/i)).toBeInTheDocument();
    expect(within(done).getByText(/create-or-converge/i)).toBeInTheDocument();
    expect(within(done).getByText(/version 1/i)).toBeInTheDocument();
  });

  it('a typed backend rejection (400) renders VERBATIM and the editor stays open — the fields keep their values, exactly one POST', async () => {
    renderExpert({
      '/organizations': orgsOne,
      'POST /organizations/org-1/workflow-repository/workflows': INVALID_SLUG_REJECTION,
    });
    const surface = await screen.findByRole('region', { name: /expert workflow authoring/i });
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow name/i }), 'Expert digest');
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow slug/i }), 'Expert-Digest!');
    await setEditorValue(
      within(surface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
      IR_V1_TEXT,
    );
    await userEvent.click(within(surface).getByRole('button', { name: /create workflow/i }));
    // The typed wire identifier renders verbatim (the transport preserves
    // the backend's typed rejection; the page paraphrases nothing).
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/workflow-invalid-slug/i)).toBeInTheDocument();
    // The editor STAYS OPEN with the authored values.
    expect(within(surface).getByRole('textbox', { name: /workflow name/i })).toHaveValue(
      'Expert digest',
    );
    expect(within(surface).getByRole('textbox', { name: /workflow slug/i })).toHaveValue(
      'Expert-Digest!',
    );
    expect(
      within(surface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
    ).toHaveValue(IR_V1_TEXT);
    // Exactly ONE POST (no retry storm, no silent convergence).
    const fetchMock = vi.mocked(fetch);
    const createCalls = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes('/workflow-repository/workflows'),
    );
    expect(createCalls).toHaveLength(1);
    // Nothing renders as created.
    expect(screen.queryByRole('status', { name: /workflow created/i })).not.toBeInTheDocument();
  });

  it('invalid JSON in the editor: the honest local SYNTAX error renders and NO POST is ever sent', async () => {
    renderExpert({
      '/organizations': orgsOne,
      'POST /organizations/org-1/workflow-repository/workflows': () => {
        throw new Error('must never be called: invalid JSON must not be sent');
      },
    });
    const surface = await screen.findByRole('region', { name: /expert workflow authoring/i });
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow name/i }), 'Expert digest');
    await userEvent.type(within(surface).getByRole('textbox', { name: /workflow slug/i }), 'expert-digest');
    await setEditorValue(
      within(surface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
      '{not valid json',
    );
    await userEvent.click(within(surface).getByRole('button', { name: /create workflow/i }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/valid json/i)).toBeInTheDocument();
    expect(within(alert).getByText(/nothing was sent/i)).toBeInTheDocument();
    // The editor stays open with the user's text.
    expect(
      within(surface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
    ).toHaveValue('{not valid json');
    // ZERO commands left the page.
    const fetchMock = vi.mocked(fetch);
    const createCalls = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes('/workflow-repository/workflows'),
    );
    expect(createCalls).toHaveLength(0);
  });

  it('the version-creation flow: the second EXISTING command (POST /workflow-repository/workflows/:id/versions) creates the next immutable version and renders its facts', async () => {
    renderExpert({
      '/organizations': orgsOne,
      'POST /workflow-repository/workflows/wf-existing/versions': () =>
        jsonResponse(201, {
          ...VERSION_RESPONSE,
          version: { ...VERSION_RESPONSE.version, workflowId: 'wf-existing' },
        }),
    });
    const versionSurface = await screen.findByRole('region', { name: /create a new version/i });
    await userEvent.type(
      within(versionSurface).getByRole('textbox', { name: /workflow id/i }),
      'wf-existing',
    );
    await setEditorValue(
      within(versionSurface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
      IR_V2_TEXT,
    );
    await userEvent.click(
      within(versionSurface).getByRole('button', { name: /create version/i }),
    );

    const done = await screen.findByRole('status', { name: /version created/i });
    expect(within(done).getByText(/version 2/i)).toBeInTheDocument();
    expect(within(done).getByText(/immutable/i)).toBeInTheDocument();
    expect(within(done).getByText('sha256:version-two-digest')).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: /open the workflow/i })).toHaveAttribute(
      'href',
      '/workflows/wf-existing',
    );

    // The REAL route and body (content parsed, protocol declared).
    const fetchMock = vi.mocked(fetch);
    const versionCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/workflow-repository/workflows/wf-existing/versions'),
    );
    expect(versionCall).toBeDefined();
    const body = JSON.parse(String(versionCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      content: JSON.parse(IR_V2_TEXT),
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    });
  });

  it('the version rejection renders verbatim with the editor staying open', async () => {
    renderExpert({
      '/organizations': orgsOne,
      'POST /workflow-repository/workflows/wf-existing/versions': INVALID_PROTOCOL_REJECTION,
    });
    const versionSurface = await screen.findByRole('region', { name: /create a new version/i });
    await userEvent.type(
      within(versionSurface).getByRole('textbox', { name: /workflow id/i }),
      'wf-existing',
    );
    await setEditorValue(
      within(versionSurface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
      IR_V2_TEXT,
    );
    await userEvent.click(
      within(versionSurface).getByRole('button', { name: /create version/i }),
    );
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/workflow-invalid-protocol/i)).toBeInTheDocument();
    expect(
      within(versionSurface).getByRole('textbox', { name: /workflowir document \(json\)/i }),
    ).toHaveValue(IR_V2_TEXT);
    expect(screen.queryByRole('status', { name: /version created/i })).not.toBeInTheDocument();
  });
});
