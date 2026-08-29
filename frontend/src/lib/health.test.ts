/**
 * WORK-049 — the pure health-view presentation helpers.
 *
 * These tests prove the helpers are PURE over the authoritative facts: health
 * findings are DERIVED from the authorities' own records (severity, status,
 * counts, evidence), the SAME facts always produce the SAME output (fresh
 * facts produce the fresh verdict — stale facts can never persist through a
 * pure function), a missing signal is NEVER fabricated, and a COMPLETED
 * maintenance Work Item is never presented as an open finding (findings vs
 * completed work are always distinguishable).
 */
import { describe, it, expect } from 'vitest';
import { deriveHealthFindings, splitMaintenanceWork } from './health';
import type {
  Deployment,
  ExecutionSummary,
  MaintenanceHealth,
  MaintenanceSignalItem,
  ProjectRuntimeStatus,
  VerificationRun,
  WorkGraph,
} from '@/api/client';

// --- fixtures -----------------------------------------------------------------

function signal(overrides: Partial<MaintenanceSignalItem> & { workItemId: string }): MaintenanceSignalItem {
  return {
    workItemHumanId: `WI-${overrides.workItemId.slice(0, 4)}`,
    title: `title ${overrides.workItemId}`,
    objective: null,
    scope: null,
    completed: false,
    planner: {
      source: 'maintenance',
      priority: 'medium',
      rationale: 'rationale',
      whyNow: 'why now',
      expectedImpact: 'impact',
    },
    ...overrides,
  };
}

function healthOf(signals: MaintenanceSignalItem[]): MaintenanceHealth {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const s of signals) {
    const cat = s.planner.maintenance?.category ?? 'unknown';
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    const sev = s.planner.maintenance?.severity ?? 'unknown';
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }
  return { architectureVersionId: 'ver-1', totalSignals: signals.length, byCategory, bySeverity, signals };
}

const runtimeAllHealthy = {
  github: { status: 'connected' },
  vercel: { status: 'ready' },
  architect: { status: 'ready', providers: [] },
  agent: { status: 'ready', providers: [] },
} as unknown as ProjectRuntimeStatus;

const emptyGraph: WorkGraph = { projectId: 'p1', nodes: [], edges: [] };

const quietInput = {
  graph: emptyGraph,
  executions: [],
  verificationRuns: [],
  maintenanceHealth: healthOf([]),
  runtimeStatus: runtimeAllHealthy,
  deployments: [],
};

// --- the derivation -----------------------------------------------------------

describe('WORK-049 health helpers (pure presentation over authoritative facts)', () => {
  it('DETERMINISM: the SAME facts always produce the SAME findings in the SAME order', () => {
    const maintenanceHealth = healthOf([
      signal({
        workItemId: 'wi-a',
        planner: {
          source: 'maintenance',
          priority: 'high',
          rationale: 'r',
          whyNow: 'why a',
          expectedImpact: 'i',
          maintenance: { category: 'ci-regression', severity: 'high', advisoryId: 'ADV-1', affectedCount: 3, detectorSource: 'ci-evidence' },
        },
      }),
    ]);
    const input = { ...quietInput, maintenanceHealth };
    expect(deriveHealthFindings(input)).toEqual(deriveHealthFindings(input));
  });

  it('QUIET FACTS → ZERO findings (nothing is invented: no signals, no failures, no errors)', () => {
    expect(deriveHealthFindings(quietInput)).toEqual([]);
  });

  it('MISSING SIGNALS ARE NOT FABRICATED: absent/failed inputs contribute NOTHING (the page reports those reads separately)', () => {
    // Every authority input absent: no findings can be claimed.
    expect(deriveHealthFindings({})).toEqual([]);
    // A maintenance read that is not available (null) contributes no findings
    // — and never a fabricated all-clear (that withholding is the page's job).
    expect(deriveHealthFindings({ maintenanceHealth: null, graph: null, runtimeStatus: null })).toEqual([]);
  });

  it('MAINTENANCE FINDINGS carry the AUTHORITY\'s own severity/category/evidence — never a computed severity', () => {
    const maintenanceHealth = healthOf([
      signal({
        workItemId: 'wi-adv',
        title: 'CI is regressing',
        planner: {
          source: 'maintenance',
          priority: 'high',
          rationale: 'r',
          whyNow: 'three consecutive failures on main',
          expectedImpact: 'i',
          maintenance: { category: 'ci-regression', severity: 'critical', advisoryId: 'ADV-7', affectedCount: 5, detectorSource: 'ci-evidence' },
        },
      }),
    ]);
    const [finding] = deriveHealthFindings({ ...quietInput, maintenanceHealth });
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe('maintenance-signal');
    expect(finding!.what).toBe('Maintenance: CI is regressing');
    expect(finding!.why).toBe('three consecutive failures on main');
    expect(finding!.severity).toBe('critical'); // the authority's own value, verbatim
    expect(finding!.evidence).toContain('ci-regression');
    expect(finding!.evidence).toContain('ADV-7');
    expect(finding!.evidence).toContain('5 affected');
    expect(finding!.evidence).toContain('detector: ci-evidence');
    expect(finding!.href).toBe('/work-items/wi-adv');
  });

  it('a maintenance signal WITHOUT severity renders severity null — the view never invents one', () => {
    const maintenanceHealth = healthOf([
      signal({
        workItemId: 'wi-nosev',
        planner: {
          source: 'maintenance',
          priority: 'low',
          rationale: 'r',
          whyNow: 'why',
          expectedImpact: 'i',
          maintenance: { category: 'advisory' },
        },
      }),
    ]);
    const [finding] = deriveHealthFindings({ ...quietInput, maintenanceHealth });
    expect(finding!.severity).toBeNull();
  });

  it('FINDINGS vs COMPLETED WORK: a COMPLETED maintenance Work Item is NEVER an open finding', () => {
    const maintenanceHealth = healthOf([
      signal({
        workItemId: 'wi-done',
        completed: true,
        planner: {
          source: 'maintenance',
          priority: 'high',
          rationale: 'r',
          whyNow: 'why',
          expectedImpact: 'i',
          maintenance: { category: 'ci-regression', severity: 'critical' },
        },
      }),
      signal({
        workItemId: 'wi-open',
        planner: {
          source: 'maintenance',
          priority: 'high',
          rationale: 'r',
          whyNow: 'why',
          expectedImpact: 'i',
          maintenance: { category: 'architecture-drift', severity: 'high' },
        },
      }),
    ]);
    const findings = deriveHealthFindings({ ...quietInput, maintenanceHealth });
    expect(findings.map((f) => f.what)).toEqual(['Maintenance: title wi-open']);
    // The split keeps the completed record visibly distinguishable.
    const split = splitMaintenanceWork(maintenanceHealth.signals);
    expect(split.open.map((w) => w.workItemId)).toEqual(['wi-open']);
    expect(split.completed.map((w) => w.workItemId)).toEqual(['wi-done']);
    expect(split.completed[0]!.severity).toBe('critical'); // the authority's own value, preserved
  });

  it('DISPLAY ORDER: maintenance severity first (critical → high → medium → low), then the fixed fact kinds', () => {
    const maintenanceHealth = healthOf([
      signal({
        workItemId: 'wi-low',
        workItemHumanId: 'WI-low',
        planner: { source: 'm', priority: 'p', rationale: 'r', whyNow: 'w', expectedImpact: 'i', maintenance: { category: 'c', severity: 'low' } },
      }),
      signal({
        workItemId: 'wi-critical',
        workItemHumanId: 'WI-crit',
        planner: { source: 'm', priority: 'p', rationale: 'r', whyNow: 'w', expectedImpact: 'i', maintenance: { category: 'c', severity: 'critical' } },
      }),
      signal({
        workItemId: 'wi-high',
        workItemHumanId: 'WI-high',
        planner: { source: 'm', priority: 'p', rationale: 'r', whyNow: 'w', expectedImpact: 'i', maintenance: { category: 'c', severity: 'high' } },
      }),
    ]);
    const failedRun: VerificationRun = {
      id: 'run-0001', projectId: 'p1', workItemId: 'wi-x', workOrderId: null, architectureVersionId: 'v1',
      source: 'github-ci', sourceRef: 'sha', status: 'failed', executionId: 'exec-1',
      startedAt: null, finishedAt: null, summary: { criteriaFail: 2 }, errorMetadata: null,
      createdAt: '', updatedAt: '',
    };
    const findings = deriveHealthFindings({ ...quietInput, maintenanceHealth, verificationRuns: [failedRun] });
    expect(findings.map((f) => f.kind)).toEqual([
      'maintenance-signal', // critical
      'maintenance-signal', // high
      'maintenance-signal', // low
      'failed-verification',
    ]);
    expect(findings[0]!.severity).toBe('critical');
    expect(findings[3]!.severity).toBe('failed'); // the run's own status value
    expect(findings[3]!.why).toContain('failed 2 acceptance criteria');
  });

  it('failed verification findings come from the verification authority\'s own failed records only', () => {
    const failed: VerificationRun = {
      id: 'run-fail', projectId: 'p1', workItemId: 'wi-a', workOrderId: null, architectureVersionId: 'v1',
      source: 'github-ci', sourceRef: null, status: 'failed', executionId: 'e1',
      startedAt: null, finishedAt: null, summary: null, errorMetadata: null, createdAt: '', updatedAt: '',
    };
    const passed: VerificationRun = { ...failed, id: 'run-pass', status: 'passed' };
    const findings = deriveHealthFindings({ ...quietInput, verificationRuns: [failed, passed] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('failed-verification');
    expect(findings[0]!.evidence).toContain('run-fail');
  });

  it('blocked-work findings carry the dependency authority\'s own blocker list', () => {
    const graph: WorkGraph = {
      projectId: 'p1',
      nodes: [
        { id: 'wi-a', architectureVersionId: 'v1', workItemId: 'WI-0001', title: 'A', completed: false, currentState: 'ready', unsatisfiedDependencies: ['wi-b'] },
        { id: 'wi-b', architectureVersionId: 'v1', workItemId: 'WI-0002', title: 'B', completed: false, currentState: 'implementing', unsatisfiedDependencies: [] },
      ],
      edges: [{ workItemId: 'wi-a', dependsOnId: 'wi-b' }],
    };
    const findings = deriveHealthFindings({ ...quietInput, graph });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('blocked-work');
    expect(findings[0]!.what).toBe('WI-0001 is blocked');
    expect(findings[0]!.why).toContain('WI-0002');
  });

  it('failed-execution / failed-deployment / provider-error findings use the records\' own statuses; healthy records produce nothing', () => {
    const failedExecution = {
      executionId: 'exec-9', mode: 'internal', provider: 'anthropic', model: 'claude', status: 'failed',
      agentRunId: null, externalSessionRef: null, repository: null, branch: null, promptDigest: '',
      benchmarkMetadata: {}, startedAt: null, completedAt: null, expiresAt: null, createdAt: '', updatedAt: '',
    } as unknown as ExecutionSummary;
    const completedExecution = { ...failedExecution, executionId: 'exec-10', status: 'completed' } as unknown as ExecutionSummary;
    const failedDeployment = { id: 'd1', integrationId: 'i', externalId: 'dep_1', status: 'error', previewUrl: null, commitSha: 'abcd1234', branch: 'main' } as unknown as Deployment;
    const readyDeployment = { ...failedDeployment, id: 'd2', externalId: 'dep_2', status: 'ready' } as unknown as Deployment;
    const runtimeWithError = {
      ...runtimeAllHealthy,
      github: { status: 'error' },
    } as unknown as ProjectRuntimeStatus;

    const findings = deriveHealthFindings({
      ...quietInput,
      executions: [failedExecution, completedExecution],
      deployments: [failedDeployment, readyDeployment],
      runtimeStatus: runtimeWithError,
    });
    expect(findings.map((f) => f.kind)).toEqual(['failed-execution', 'failed-deployment', 'provider-error']);
    expect(findings[0]!.severity).toBe('failed');
    expect(findings[1]!.severity).toBe('error');
    expect(findings[2]!.what).toBe('GitHub provider connection is in error');
    // not-configured is NOT an error (a quiet project is not an unhealthy one).
    const quiet = deriveHealthFindings({
      ...quietInput,
      runtimeStatus: { ...runtimeAllHealthy, vercel: { status: 'not-configured' } } as unknown as ProjectRuntimeStatus,
    });
    expect(quiet).toEqual([]);
  });

  it('REFRESH CONSISTENCY: fresh authoritative facts produce the fresh health view — never a cached verdict', () => {
    // Before: one failed verification run.
    const failedRun: VerificationRun = {
      id: 'run-1', projectId: 'p1', workItemId: 'wi-a', workOrderId: null, architectureVersionId: 'v1',
      source: 'github-ci', sourceRef: null, status: 'failed', executionId: 'e1',
      startedAt: null, finishedAt: null, summary: null, errorMetadata: null, createdAt: '', updatedAt: '',
    };
    const before = deriveHealthFindings({ ...quietInput, verificationRuns: [failedRun] });
    expect(before).toHaveLength(1);

    // The backend changes: the run passes on re-verification. The SAME pure
    // helper over the FRESH facts must produce the fresh verdict (no findings).
    const after = deriveHealthFindings({
      ...quietInput,
      verificationRuns: [{ ...failedRun, status: 'passed' }],
    });
    expect(after).toEqual([]);

    // And the maintenance authority surfacing a NEW critical signal produces
    // the new finding immediately.
    const withSignal = deriveHealthFindings({
      ...quietInput,
      maintenanceHealth: healthOf([
        signal({
          workItemId: 'wi-new',
          planner: { source: 'm', priority: 'p', rationale: 'r', whyNow: 'w', expectedImpact: 'i', maintenance: { category: 'c', severity: 'critical' } },
        }),
      ]),
    });
    expect(withSignal.map((f) => f.kind)).toEqual(['maintenance-signal']);
  });
});
