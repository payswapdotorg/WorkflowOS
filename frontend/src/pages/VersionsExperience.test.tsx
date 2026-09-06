/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VersionsExperience from '../components/versions/VersionsExperience';
import type {
  ProductWorkflow,
  ProductWorkflowVersion,
  ProductInstallationDetail,
} from '../api/client';

/**
 * V2-017 T11 — the versions/updates/optimization contract (Issue #202).
 *
 * The experience composes over EXISTING authorities only: the V2-002
 * version/installation reads + the existing install/lifecycle command
 * routes (adoption is a composition — install the new version, retire the
 * old installation; NO adoption authority is invented), and the V2-011
 * optimization authority through its transport routes (analysis,
 * proposals, the owner approval gate, materialization as NEW versions,
 * the deterministic comparison).
 * HONESTY RULES (UX §19/§20 + V2-017):
 *   - "Nothing changes until you approve the update." — the installed pin
 *     is shown verbatim and moves ONLY through the explicit adoption
 *     action (install new + disable old, both existing V2-002 routes);
 *   - historical versions remain addressable and inspectable;
 *   - the "What changed" panel comes ONLY from the V2-011 comparison
 *     (correctness first, then the modeled rubric deltas — presented as
 *     ESTIMATES, never as measurements; a worse score renders honestly);
 *   - optimizations are recommendations: each proposal explains what
 *     changed (the authority's rationale), why it is expected to
 *     preserve semantics (the task-surface proof), and the trade-offs
 *     (the rubric deltas);
 *   - a proposal becomes a NEW version only through the owner's explicit
 *     approval + materialization — never a silent mutation of the
 *     installed version;
 *   - failed reads remain visibly unavailable, never empty successes;
 *   - internal node ids never surface (V2-003 presentation labels,
 *     F-T4-001).
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

// --- fixtures ---------------------------------------------------------------

const WORKFLOW: ProductWorkflow = {
  id: 'wf-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  slug: 'weekly-ticket-digest',
  name: 'Weekly ticket digest',
  description: 'Collect the open tickets and email the digest.',
  visibility: 'private',
  headVersionId: 'ver-3',
  forkedFromWorkflowId: null,
  forkedFromVersionId: null,
  createdAt: '2026-09-02T09:00:00Z',
  updatedAt: '2026-09-02T09:00:00Z',
};

function version(id: string, versionNumber: number, parentVersionId: string | null): ProductWorkflowVersion {
  return {
    id,
    workflowId: 'wf-1',
    versionNumber,
    contentDigest: 'd'.repeat(64),
    content: {
      objectType: 'workflowos/workflow-ir/v1',
      ir: {
        nodes: [
          { id: 'fetch', executionClass: 'deterministic_api' },
          { id: 'do', executionClass: 'agentic_computer_use' },
          { id: 'send', executionClass: 'deterministic_api' },
        ],
      },
      presentation: {
        nodeLabels: {
          fetch: 'Collect the open tickets',
          do: 'Copy the ticket numbers',
          send: 'Email the weekly digest',
        },
      },
    },
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId,
    createdByUserId: 'user-1',
    createdAt: '2026-09-02T09:00:00Z',
  };
}

const VERSIONS: ProductWorkflowVersion[] = [
  version('ver-1', 1, null),
  version('ver-2', 2, 'ver-1'),
  version('ver-3', 3, 'ver-2'),
];

const INSTALLATION: ProductInstallationDetail = {
  installation: {
    id: 'inst-1',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    installedByUserId: 'user-1',
    status: 'enabled',
    installedAt: '2026-09-02T10:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z',
  },
  pinnedVersion: {
    id: 'ver-2',
    workflowId: 'wf-1',
    versionNumber: 2,
    contentDigest: 'd'.repeat(64),
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  },
};

const ANALYSIS = {
  analysisId: 'opt_' + 'a'.repeat(60),
  rulesVersion: 'workflowos-optimization-rules-v1',
  opportunities: [
    {
      kind: 'api_substitution',
      nodeId: 'do',
      declaredTask: 'Copy the ticket numbers',
      declaredRequirements: ['github.repository.read'],
      apiCapability: 'github.repository.read',
      rationale:
        'The step declares the single API-stable capability github.repository.read, so a direct API call can perform it without the agent loop.',
    },
  ],
  rejected: [],
};

const COMPARISON = {
  rulesVersion: 'workflowos-optimization-rules-v1',
  correctness: { equivalent: true, firstDivergence: null },
  negotiation: { decision: 'accept', reason: 'public-surface-unchanged' },
  latency: { baseline: 7, candidate: 5, delta: -2 },
  cost: { baseline: 6, candidate: 3, delta: -3 },
  reliability: { baseline: 0.29, candidate: 0.16, delta: -0.13 },
  maintenance: { baseline: 6, candidate: 5, delta: -1 },
  maintenanceBreakdown: {
    baseline: { nodeCount: 3, duplicateNodeCount: 0, agenticNodeCount: 1, score: 6 },
    candidate: { nodeCount: 3, duplicateNodeCount: 0, agenticNodeCount: 0, score: 5 },
  },
};

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'opt_1',
    kind: 'api_substitution',
    ownerId: 'user-1',
    provenance: {
      baseline: {
        workflowId: 'wf-1',
        versionId: 'ver-2',
        semanticDigest: 'a'.repeat(64),
      },
      analysisId: ANALYSIS.analysisId,
      rulesVersion: 'workflowos-optimization-rules-v1',
      opportunityKind: 'api_substitution',
      opportunityNodeIds: ['do'],
      candidateDigest: 'b'.repeat(64),
    },
    affectedNodeIds: ['do'],
    rationale:
      'Replace the agent-driven step with the direct github.repository.read API call; the task surface is preserved.',
    comparison: COMPARISON,
    status: 'proposed',
    createdAt: 1733568000000,
    decision: null,
    materialization: null,
    reuseTarget: null,
    ...overrides,
  };
}

interface RenderProps {
  workflow?: ProductWorkflow;
  versions?: ProductWorkflowVersion[];
  installation?: ProductInstallationDetail | null;
  routes?: Record<string, RouteHandler>;
  onRefresh?: ReturnType<typeof vi.fn>;
}

function renderVersions({
  workflow = WORKFLOW,
  versions = VERSIONS,
  installation = INSTALLATION,
  routes = {},
  onRefresh = vi.fn(),
}: RenderProps = {}) {
  const fetchMock = mockApi(routes);
  vi.stubGlobal('fetch', fetchMock);
  const utils = render(
    <VersionsExperience
      workflow={workflow}
      versions={versions}
      installation={installation}
      onRefresh={onRefresh}
    />,
  );
  return { user: userEvent.setup(), onRefresh, fetchMock, ...utils };
}

function defaultRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    'POST /workflow-optimization/analyze': () => jsonResponse(200, { analysis: ANALYSIS }),
    'GET /workflow-optimization/proposals': () => jsonResponse(200, { proposals: [] }),
    'POST /workflow-optimization/compare': () => jsonResponse(200, { comparison: COMPARISON }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('V2-017 T11 — version history (§19 "addressable and inspectable")', () => {
  it('renders every version with the Current and Installed badges (the verbatim pins)', async () => {
    renderVersions({ routes: defaultRoutes() });
    const history = await screen.findByRole('region', { name: 'Version history' });
    await waitFor(() => expect(within(history).getByText('Version 1')).toBeInTheDocument());
    expect(within(history).getByText('Version 2')).toBeInTheDocument();
    expect(within(history).getByText('Version 3')).toBeInTheDocument();
    // The head is Current; the installed pin is Installed — verbatim.
    const current = within(history).getByText('Version 3').closest('li')!;
    expect(within(current as HTMLElement).getByText('Current')).toBeInTheDocument();
    const installed = within(history).getByText('Version 2').closest('li')!;
    expect(within(installed as HTMLElement).getByText('Installed')).toBeInTheDocument();
  });

  it('a historical version is inspectable — its steps from the presentation labels', async () => {
    const { user } = renderVersions({ routes: defaultRoutes() });
    const history = await screen.findByRole('region', { name: 'Version history' });
    const first = within(history).getByText('Version 1').closest('li') as HTMLElement;
    await user.click(within(first).getByRole('button', { name: /view steps/i }));
    const steps = within(first).getByRole('list', { name: /version 1 steps/i });
    expect(within(steps).getByText('Collect the open tickets')).toBeInTheDocument();
    expect(within(steps).getByText('Copy the ticket numbers')).toBeInTheDocument();
    expect(within(steps).getByText('Email the weekly digest')).toBeInTheDocument();
    // Internal node ids never surface.
    expect(within(first).queryByText('fetch')).not.toBeInTheDocument();
    expect(within(first).queryByText('do')).not.toBeInTheDocument();
  });

  it('REGRESSION (architect finding T11-F02): missing or malformed presentation labels stay VISIBLY unavailable — never a successful empty steps list', async () => {
    // A read whose presentation labels are MISSING (no presentation field)
    // and one whose labels are MALFORMED (nodeLabels is not a record) —
    // both are failed reads (nodeLabelsFromContent → null), and the V2-017
    // rule keeps failed reads distinct from successful empty results.
    const missingLabels = version('ver-2', 2, 'ver-1');
    missingLabels.content = { objectType: 'workflowos/workflow-ir/v1' };
    const malformedLabels = version('ver-3', 3, 'ver-2');
    malformedLabels.content = {
      objectType: 'workflowos/workflow-ir/v1',
      presentation: { nodeLabels: 'not-a-record' },
    };
    const { user } = renderVersions({
      workflow: { ...WORKFLOW, headVersionId: 'ver-3' },
      versions: [version('ver-1', 1, null), missingLabels, malformedLabels],
      installation: null,
      routes: defaultRoutes(),
    });
    const history = await screen.findByRole('region', { name: 'Version history' });

    // the MISSING-labels version: the failed read renders the explicit
    // unavailable state …
    const second = within(history).getByText('Version 2').closest('li') as HTMLElement;
    await user.click(within(second).getByRole('button', { name: /view steps/i }));
    expect(
      within(second).getByText(/this version's steps aren't available right now/i),
    ).toBeInTheDocument();
    // … never a successful (empty) steps list.
    expect(within(second).queryByRole('list', { name: /version 2 steps/i })).not.toBeInTheDocument();

    // the MALFORMED-labels version: the same explicit unavailable state.
    const third = within(history).getByText('Version 3').closest('li') as HTMLElement;
    await user.click(within(third).getByRole('button', { name: /view steps/i }));
    expect(
      within(third).getByText(/this version's steps aren't available right now/i),
    ).toBeInTheDocument();
    expect(within(third).queryByRole('list', { name: /version 3 steps/i })).not.toBeInTheDocument();

    // The healthy version on the same page still renders its real steps
    // (the unavailable state never contaminates successful reads).
    const first = within(history).getByText('Version 1').closest('li') as HTMLElement;
    await user.click(within(first).getByRole('button', { name: /view steps/i }));
    expect(within(first).getByText('Collect the open tickets')).toBeInTheDocument();
  });

  it('no versions → the honest unavailable state (never an empty success)', async () => {
    renderVersions({
      workflow: { ...WORKFLOW, headVersionId: 'ver-1' },
      versions: [],
      installation: null,
      routes: defaultRoutes(),
    });
    const history = await screen.findByRole('region', { name: 'Version history' });
    expect(
      within(history).getByText(/version history isn't available right now/i),
    ).toBeInTheDocument();
  });
});

describe('V2-017 T11 — the update banner + explicit adoption (§19)', () => {
  it('"An update is available" with the verbatim installed pin and the no-silent-change promise', async () => {
    renderVersions({ routes: defaultRoutes() });
    const update = await screen.findByRole('region', { name: 'Update available' });
    expect(within(update).getByText(/an update is available/i)).toBeInTheDocument();
    expect(within(update).getByText('Weekly ticket digest')).toBeInTheDocument();
    expect(within(update).getByText('Version 3')).toBeInTheDocument();
    expect(within(update).getByText(/your installed version/i)).toBeInTheDocument();
    expect(within(update).getByText('Version 2')).toBeInTheDocument();
    // §19 verbatim: "Nothing changes until you approve the update."
    expect(
      within(update).getByText(/nothing changes until you approve the update/i),
    ).toBeInTheDocument();
    expect(within(update).getByRole('button', { name: /review update/i })).toBeInTheDocument();
  });

  it('Review shows What changed — ONLY the V2-011 comparison (correctness first, estimates honest)', async () => {
    const { user } = renderVersions({ routes: defaultRoutes() });
    const update = await screen.findByRole('region', { name: 'Update available' });
    await user.click(within(update).getByRole('button', { name: /review update/i }));
    // The comparison is fetched from the optimization transport route.
    await waitFor(() =>
      expect(
        within(update).getByText(/task-for-task equivalent - verified/i),
      ).toBeInTheDocument(),
    );
    // The modeled rubric deltas render as ESTIMATES (never measurements) —
    // the frozen §20 wording pins the per-criterion "estimated score"
    // phrasing (versions-language.ts scoreLine); the T15 correction aligns
    // these regexes to that pinned language (they previously omitted the
    // honest "estimated" qualifier and failed against the real output).
    expect(within(update).getByText(/speed estimated score 7 to 5/i)).toBeInTheDocument();
    expect(within(update).getByText(/cost estimated score 6 to 3/i)).toBeInTheDocument();
    expect(within(update).getByText(/reliability estimated score 0\.29 to 0\.16/i)).toBeInTheDocument();
    expect(within(update).getByText(/maintenance estimated score 6 to 5/i)).toBeInTheDocument();
    expect(within(update).getByText(/estimates, not measurements/i)).toBeInTheDocument();
    expect(within(update).getByRole('button', { name: /approve update/i })).toBeInTheDocument();
  });

  it('a WORSE score renders honestly (the trade-off is visible)', async () => {
    const worse = {
      ...COMPARISON,
      reliability: { baseline: 0.18, candidate: 0.19, delta: 0.01 },
    };
    const { user } = renderVersions({
      routes: defaultRoutes({ 'POST /workflow-optimization/compare': () => jsonResponse(200, { comparison: worse }) }),
    });
    const update = await screen.findByRole('region', { name: 'Update available' });
    await user.click(within(update).getByRole('button', { name: /review update/i }));
    await waitFor(() =>
      expect(within(update).getByText(/reliability estimated score 0\.18 to 0\.19/i)).toBeInTheDocument(),
    );
  });

  it('the comparison read fails → What changed stays visibly unavailable (never empty)', async () => {
    const { user } = renderVersions({
      routes: defaultRoutes({ 'POST /workflow-optimization/compare': () => jsonResponse(500, { error: 'boom' }) }),
    });
    const update = await screen.findByRole('region', { name: 'Update available' });
    await user.click(within(update).getByRole('button', { name: /review update/i }));
    await waitFor(() =>
      expect(within(update).getByText(/what changed isn't available right now/i)).toBeInTheDocument(),
    );
    expect(within(update).queryByRole('button', { name: /approve update/i })).not.toBeInTheDocument();
  });

  it('Approve update = the EXISTING V2-002 commands only: install the new version, retire the old installation', async () => {
    const { user, onRefresh, fetchMock } = renderVersions({
      routes: defaultRoutes({
        'POST /workflow-repository/installations': () =>
          jsonResponse(201, { installation: INSTALLATION.installation }),
        'POST /workflow-repository/installations/inst-1/disable': () =>
          jsonResponse(200, { installation: { ...INSTALLATION.installation, status: 'disabled' } }),
      }),
    });
    const update = await screen.findByRole('region', { name: 'Update available' });
    await user.click(within(update).getByRole('button', { name: /review update/i }));
    await user.click(within(update).getByRole('button', { name: /approve update/i }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    // Install the NEW version through the existing installation route.
    const installCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/workflow-repository/installations') &&
        (init?.method ?? 'GET') === 'POST' &&
        !String(input).includes('/disable') &&
        !String(input).includes('/enable') &&
        !String(input).includes('/uninstall'),
    );
    expect(installCall).toBeDefined();
    expect(JSON.parse(String(installCall![1]?.body))).toEqual({
      workflowId: 'wf-1',
      versionId: 'ver-3',
    });
    // Retire the OLD installation through the existing lifecycle route.
    const disableCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/installations/inst-1/disable') &&
        (init?.method ?? 'GET') === 'POST',
    );
    expect(disableCall).toBeDefined();
  });

  it('adoption failure renders as an error — never a silent success', async () => {
    const { user } = renderVersions({
      routes: defaultRoutes({
        'POST /workflow-optimization/compare': () => jsonResponse(200, { comparison: COMPARISON }),
      }),
    });
    // The install command fails (500): the error surfaces.
    const failing: Record<string, RouteHandler> = {
      'POST /workflow-optimization/analyze': () => jsonResponse(200, { analysis: ANALYSIS }),
      'GET /workflow-optimization/proposals': () => jsonResponse(200, { proposals: [] }),
      'POST /workflow-optimization/compare': () => jsonResponse(200, { comparison: COMPARISON }),
    };
    // rebuild with the install failing
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      mockApi({
        ...failing,
        'POST /workflow-repository/installations': () =>
          jsonResponse(500, { error: 'workflow-not-owned' }),
      }),
    );
    const update = await screen.findByRole('region', { name: 'Update available' });
    await user.click(within(update).getByRole('button', { name: /review update/i }));
    await waitFor(() =>
      expect(within(update).getByRole('button', { name: /approve update/i })).toBeInTheDocument(),
    );
    await user.click(within(update).getByRole('button', { name: /approve update/i }));
    const alert = await within(update).findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't be approved/i);
  });

  it('on the newest version: the honest newest-version state (no fabricated update)', async () => {
    const onHead: ProductInstallationDetail = {
      ...INSTALLATION,
      installation: { ...INSTALLATION.installation, versionId: 'ver-3' },
      pinnedVersion: { ...INSTALLATION.pinnedVersion, id: 'ver-3', versionNumber: 3 },
    };
    renderVersions({
      workflow: { ...WORKFLOW, headVersionId: 'ver-3' },
      installation: onHead,
      routes: defaultRoutes(),
    });
    const update = await screen.findByRole('region', { name: 'Update available' });
    expect(within(update).getByText(/you're on the newest version/i)).toBeInTheDocument();
    expect(within(update).queryByText(/an update is available/i)).not.toBeInTheDocument();
  });
});

describe('V2-017 T11 — improvements as NEW versions (§20)', () => {
  it('"WorkflowOS found 1 improvement" — the recommendation telemetry (§20 verbatim)', async () => {
    renderVersions({ routes: defaultRoutes() });
    const improvements = await screen.findByRole('region', { name: 'Improvements' });
    await waitFor(() =>
      expect(within(improvements).getByText(/workflowos found 1 improvement/i)).toBeInTheDocument(),
    );
    // The recommendation card: the consumer label, never the node id.
    expect(within(improvements).getByText(/copy the ticket numbers/i)).toBeInTheDocument();
    expect(within(improvements).queryByText('do')).not.toBeInTheDocument();
    expect(within(improvements).getByRole('button', { name: /review/i })).toBeInTheDocument();
  });

  it('Review → the proposal (created through the authority) with what/why/trade-offs', async () => {
    const { user, fetchMock } = renderVersions({
      routes: defaultRoutes({
        'POST /workflow-optimization/proposals': () => jsonResponse(201, { proposal: proposal() }),
      }),
    });
    const improvements = await screen.findByRole('region', { name: 'Improvements' });
    await waitFor(() =>
      expect(within(improvements).getByText(/workflowos found 1 improvement/i)).toBeInTheDocument(),
    );
    await user.click(within(improvements).getByRole('button', { name: /review/i }));
    // The proposal was created over the transport route, server-side
    // document resolution (the client passes identifiers only).
    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/workflow-optimization/proposals') &&
          (init?.method ?? 'GET') === 'POST' &&
          !String(input).includes('/approve') &&
          !String(input).includes('/materialize'),
      );
      expect(createCall).toBeDefined();
      expect(JSON.parse(String(createCall![1]?.body))).toEqual({
        workflowId: 'wf-1',
        versionId: 'ver-2',
        opportunityNodeId: 'do',
      });
    });
    // What changed (the authority's rationale) + why semantics-preserving.
    await waitFor(() =>
      expect(within(improvements).getByText(/direct github\.repository\.read API call/i)).toBeInTheDocument(),
    );
    expect(within(improvements).getByText(/task-for-task equivalent - verified/i)).toBeInTheDocument();
    // The trade-offs (estimates).
    expect(within(improvements).getByText(/speed estimated score 7 to 5/i)).toBeInTheDocument();
    expect(within(improvements).getByText(/estimates, not measurements/i)).toBeInTheDocument();
    // The approval gate: status Proposed + the Approve action.
    expect(within(improvements).getByText(/proposed/i)).toBeInTheDocument();
    expect(
      within(improvements).getByRole('button', { name: /approve improvement/i }),
    ).toBeInTheDocument();
  });

  it('Approve → Create the new version: the full §20 gate — nothing exists until the owner acts', async () => {
    const approved = proposal({ status: 'approved', decision: { ownerId: 'user-1', decidedAt: 1733568001000 } });
    const materialized = proposal({
      status: 'materialized',
      decision: { ownerId: 'user-1', decidedAt: 1733568001000 },
      materialization: {
        workflowId: 'wf-1',
        versionId: 'ver-4',
        materializedAt: 1733568002000,
        candidateDigest: 'b'.repeat(64),
      },
    });
    const routes: Record<string, RouteHandler> = {
      'POST /workflow-optimization/analyze': () => jsonResponse(200, { analysis: ANALYSIS }),
      'GET /workflow-optimization/proposals': () => jsonResponse(200, { proposals: [] }),
      'POST /workflow-optimization/compare': () => jsonResponse(200, { comparison: COMPARISON }),
      'POST /workflow-optimization/proposals': () => jsonResponse(201, { proposal: proposal() }),
      'POST /workflow-optimization/proposals/opt_1/approve': () =>
        jsonResponse(200, { proposal: approved }),
      'POST /workflow-optimization/proposals/opt_1/materialize': () =>
        jsonResponse(200, { proposal: materialized, materialization: materialized.materialization }),
    };
    const { user, onRefresh } = renderVersions({ routes });
    const improvements = await screen.findByRole('region', { name: 'Improvements' });
    await waitFor(() =>
      expect(within(improvements).getByText(/workflowos found 1 improvement/i)).toBeInTheDocument(),
    );
    await user.click(within(improvements).getByRole('button', { name: /review/i }));
    await waitFor(() =>
      expect(within(improvements).getByText(/proposed/i)).toBeInTheDocument(),
    );
    await user.click(within(improvements).getByRole('button', { name: /approve improvement/i }));
    await waitFor(() =>
      expect(within(improvements).getByText(/approved - not created yet/i)).toBeInTheDocument(),
    );
    // NOTHING is a version until materialization ("requires adoption" §20).
    expect(onRefresh).not.toHaveBeenCalled();
    await user.click(within(improvements).getByRole('button', { name: /create the new version/i }));
    await waitFor(() =>
      expect(within(improvements).getByText(/created as a new version/i)).toBeInTheDocument(),
    );
    expect(onRefresh).toHaveBeenCalled();
  });

  it('an approved-materialized proposal (listProposals converge) shows the terminal state with no commands', async () => {
    const materialized = proposal({
      status: 'materialized',
      decision: { ownerId: 'user-1', decidedAt: 1733568001000 },
      materialization: {
        workflowId: 'wf-1',
        versionId: 'ver-4',
        materializedAt: 1733568002000,
        candidateDigest: 'b'.repeat(64),
      },
    });
    renderVersions({
      routes: defaultRoutes({
        'GET /workflow-optimization/proposals': () =>
          jsonResponse(200, { proposals: [materialized] }),
      }),
    });
    const improvements = await screen.findByRole('region', { name: 'Improvements' });
    await waitFor(() =>
      expect(within(improvements).getByText(/created as a new version/i)).toBeInTheDocument(),
    );
    expect(within(improvements).queryByRole('button', { name: /approve improvement/i })).not.toBeInTheDocument();
    expect(within(improvements).queryByRole('button', { name: /create the new version/i })).not.toBeInTheDocument();
  });

  it('a typed rejection renders verbatim — never as state', async () => {
    const { user } = renderVersions({
      routes: defaultRoutes({
        'POST /workflow-optimization/proposals': () =>
          jsonResponse(409, { error: 'workflow-optimization-approval-required' }),
      }),
    });
    const improvements = await screen.findByRole('region', { name: 'Improvements' });
    await waitFor(() =>
      expect(within(improvements).getByText(/workflowos found 1 improvement/i)).toBeInTheDocument(),
    );
    await user.click(within(improvements).getByRole('button', { name: /review/i }));
    const alert = await within(improvements).findByRole('alert');
    expect(alert).toHaveTextContent('workflow-optimization-approval-required');
  });

  it('the analysis read fails → improvements stay visibly unavailable', async () => {
    renderVersions({
      routes: defaultRoutes({
        'POST /workflow-optimization/analyze': () => jsonResponse(500, { error: 'boom' }),
      }),
    });
    const improvements = await screen.findByRole('region', { name: 'Improvements' });
    await waitFor(() =>
      expect(
        within(improvements).getByText(/improvements aren't available right now/i),
      ).toBeInTheDocument(),
    );
  });

  it('zero opportunities is the honest "No improvements found yet" (a real zero, not a failure)', async () => {
    renderVersions({
      routes: defaultRoutes({
        'POST /workflow-optimization/analyze': () =>
          jsonResponse(200, { analysis: { ...ANALYSIS, opportunities: [], rejected: [] } }),
      }),
    });
    const improvements = await screen.findByRole('region', { name: 'Improvements' });
    await waitFor(() =>
      expect(within(improvements).getByText(/no improvements found yet/i)).toBeInTheDocument(),
    );
  });
});

// --- REALITY-REPAIR-009 (F-010): the human-readable version diff ------------
//
// The audit's VER-2 finding: the "What changed" surface rendered the V2-011
// comparison payload VERBATIM — `Not equivalent: node collect_posts inputs:
// [{…}] != [{…}]` — an internal transport shape shown to end users. The
// repair boundary (Work Order REALITY-REPAIR-009): render the SAME payload
// as a human-readable node/field summary (names + values), keep the honest
// non-equivalence statement, change NO comparison semantics (the payload is
// the input; the frontend re-presents, never re-derives).
//
// The fixtures below reproduce the payload's OWN divergence grammar exactly
// as the comparison authority emits it (backend
// workflow-optimization/internal/comparison.ts firstTaskSurfaceDivergence):
// `<surface>: <baseline JSON> != <candidate JSON>` — the raw internal JSON
// envelope that must never reach the rendered DOM.

const NODE_INPUTS_DIVERGENCE =
  'node fetch inputs: [{"name":"repository","type":{"kind":"string"},"binding":{"kind":"literal","value":"payswapdotorg/WorkflowOS"}}] != [{"name":"repository","type":{"kind":"string"},"binding":{"kind":"literal","value":"pectoraux/WorkflowOS"}},{"name":"limit","type":{"kind":"number"},"binding":{"kind":"literal","value":10}}]';

const WORKFLOW_INPUTS_DIVERGENCE =
  'workflow inputs: [{"name":"topic","type":{"kind":"string"}}] != [{"name":"topic","type":{"kind":"string"}},{"name":"depth","type":{"kind":"number"}}]';

describe('REALITY-REPAIR-009 (F-010) — the human-readable version diff', () => {
  it('a non-equivalent comparison renders the node/field summary — the step NAME, the field, readable values, the honest verdict; NEVER the raw internal JSON envelope', async () => {
    const { user } = renderVersions({
      routes: defaultRoutes({
        'POST /workflow-optimization/compare': () =>
          jsonResponse(200, {
            comparison: {
              ...COMPARISON,
              correctness: { equivalent: false, firstDivergence: NODE_INPUTS_DIVERGENCE },
            },
          }),
      }),
    });
    const update = await screen.findByRole('region', { name: 'Update available' });
    await user.click(within(update).getByRole('button', { name: /review update/i }));

    // The honest verdict first: the authority's own non-equivalence result,
    // stated explicitly (never buried, never softened).
    await waitFor(() => expect(within(update).getByText('Not equivalent')).toBeInTheDocument());

    // The node/field NAMES: the divergent step renders through its
    // presentation label (never the raw node id — F-T4-001) and the
    // divergent field renders as consumer words.
    const headline = within(update).getByText(/where the versions differ/i);
    expect(headline).toHaveTextContent('the step "Collect the open tickets" — its inputs');

    // The two values, readable: names and values, side by side — not JSON.
    expect(within(update).getByText(/^installed version:/i)).toHaveTextContent(
      'name: repository, type (kind: string), binding (kind: literal, value: payswapdotorg/WorkflowOS)',
    );
    expect(within(update).getByText(/^new version:/i)).toHaveTextContent(
      'name: repository, type (kind: string), binding (kind: literal, value: pectoraux/WorkflowOS)',
    );
    expect(within(update).getByText(/^new version:/i)).toHaveTextContent('name: limit');

    // NO raw internal JSON envelope anywhere in the surface: no `!=` blob,
    // no JSON.stringify'd payload, no raw node-id+field transport head.
    const text = update.textContent ?? '';
    expect(text).not.toContain('!=');
    expect(text).not.toContain('node fetch inputs:');
    expect(text).not.toContain('"kind"');
    expect(text).not.toContain('"literal"');
    // The internal node id never renders (the presentation label is the name).
    expect(text).not.toMatch(/\bfetch\b/);

    // Correctness first, then the estimates — and the explicit adoption
    // gate still hangs off the comparison (no semantics change).
    expect(within(update).getByText(/estimates, not measurements/i)).toBeInTheDocument();
    expect(within(update).getByRole('button', { name: /approve update/i })).toBeInTheDocument();
  });

  it('a workflow-level divergence renders its surface and its values readably (the same payload, still no raw envelope)', async () => {
    const { user } = renderVersions({
      routes: defaultRoutes({
        'POST /workflow-optimization/compare': () =>
          jsonResponse(200, {
            comparison: {
              ...COMPARISON,
              correctness: { equivalent: false, firstDivergence: WORKFLOW_INPUTS_DIVERGENCE },
            },
          }),
      }),
    });
    const update = await screen.findByRole('region', { name: 'Update available' });
    await user.click(within(update).getByRole('button', { name: /review update/i }));
    await waitFor(() => expect(within(update).getByText('Not equivalent')).toBeInTheDocument());
    expect(within(update).getByText(/where the versions differ/i)).toHaveTextContent(
      "the workflow's inputs",
    );
    expect(within(update).getByText(/^installed version:/i)).toHaveTextContent('name: topic');
    expect(within(update).getByText(/^new version:/i)).toHaveTextContent('name: depth');
    const text = update.textContent ?? '';
    expect(text).not.toContain('!=');
    expect(text).not.toContain('"kind"');
  });

  it('the improvement proposal card renders the same human-readable diff for its non-equivalent comparison — never the raw envelope', async () => {
    const { user } = renderVersions({
      routes: defaultRoutes({
        'POST /workflow-optimization/proposals': () =>
          jsonResponse(201, {
            proposal: proposal({
              comparison: {
                ...COMPARISON,
                correctness: { equivalent: false, firstDivergence: NODE_INPUTS_DIVERGENCE },
              },
            }),
          }),
      }),
    });
    const improvements = await screen.findByRole('region', { name: 'Improvements' });
    await waitFor(() =>
      expect(within(improvements).getByText(/workflowos found 1 improvement/i)).toBeInTheDocument(),
    );
    await user.click(within(improvements).getByRole('button', { name: /review/i }));
    await waitFor(() => expect(within(improvements).getByText('Not equivalent')).toBeInTheDocument());
    expect(within(improvements).getByText(/where the versions differ/i)).toHaveTextContent(
      'the step "Collect the open tickets" — its inputs',
    );
    expect(within(improvements).getByText(/^current version:/i)).toHaveTextContent(
      'payswapdotorg/WorkflowOS',
    );
    expect(within(improvements).getByText(/^proposed version:/i)).toHaveTextContent(
      'pectoraux/WorkflowOS',
    );
    const text = improvements.textContent ?? '';
    expect(text).not.toContain('!=');
    expect(text).not.toContain('"kind"');
    // The §20 gate is unchanged: the estimates + the owner approval action.
    expect(within(improvements).getByText(/estimates, not measurements/i)).toBeInTheDocument();
    expect(
      within(improvements).getByRole('button', { name: /approve improvement/i }),
    ).toBeInTheDocument();
  });

  it('a divergence the payload grammar does not describe degrades honestly — no raw envelope, no fabricated equivalence', async () => {
    const { user } = renderVersions({
      routes: defaultRoutes({
        'POST /workflow-optimization/compare': () =>
          jsonResponse(200, {
            comparison: {
              ...COMPARISON,
              correctness: {
                equivalent: false,
                firstDivergence: 'future-shape: {"opaque":true} != {"opaque":false}',
              },
            },
          }),
      }),
    });
    const update = await screen.findByRole('region', { name: 'Update available' });
    await user.click(within(update).getByRole('button', { name: /review update/i }));
    // The verdict stays the authority's own; the undescribed detail renders
    // the honest unavailable state — never the raw internals, never an
    // invented equivalence.
    await waitFor(() => expect(within(update).getByText('Not equivalent')).toBeInTheDocument());
    expect(
      within(update).getByText(/isn't available in a readable form right now/i),
    ).toBeInTheDocument();
    const text = update.textContent ?? '';
    expect(text).not.toContain('!=');
    expect(text).not.toContain('future-shape');
    expect(text).not.toContain('"opaque"');
  });

  it('REGRESSION (semantics preserved): equivalence stays equivalence — the verified verdict, no divergence block, no raw payload', async () => {
    const { user } = renderVersions({ routes: defaultRoutes() });
    const update = await screen.findByRole('region', { name: 'Update available' });
    await user.click(within(update).getByRole('button', { name: /review update/i }));
    await waitFor(() =>
      expect(within(update).getByText(/task-for-task equivalent - verified/i)).toBeInTheDocument(),
    );
    expect(within(update).queryByText(/where the versions differ/i)).not.toBeInTheDocument();
    expect(within(update).queryByText('Not equivalent')).not.toBeInTheDocument();
    const text = update.textContent ?? '';
    expect(text).not.toContain('!=');
  });
});
