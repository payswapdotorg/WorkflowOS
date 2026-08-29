/**
 * WORK-049 — pure presentation helpers for the Project Health view.
 *
 * EVERY function here is PURE over its inputs: it derives health FINDINGS
 * from the AUTHORITATIVE facts the backend already returned (the maintenance
 * authority's signals with their own severity/category/evidence, the
 * verification authority's failed runs, the dependency authority's
 * unsatisfied dependencies, the execution records' own failed statuses, the
 * runtime authority's provider/deployment statuses). It never invents a
 * signal, never queries anything, never mutates anything, and never computes
 * a severity the authority did not state:
 *
 *   - a maintenance finding's severity IS the maintenance authority's own
 *     `severity` value (critical/high/medium/low/…), rendered verbatim;
 *   - a failed verification/execution/deployment finding's "severity" IS the
 *     record's own status value (`failed`/`error`), rendered verbatim;
 *   - the DISPLAY ORDER is a stable presentation order over the authority's
 *     own values (maintenance severity first, then the fact kinds in a fixed
 *     order) — the same facts ALWAYS produce the same output. This is a
 *     presentation grouping, NOT a prioritization authority: no new
 *     severity/priority is ever computed, and the backend remains the only
 *     place a finding (and its weight) is decided.
 *
 * The health view OWNS no state: there is no second maintenance engine, no
 * second health authority, no policy engine, no Work Item store, and no
 * workflow state machine here — only the shaping of authoritative facts for
 * display (the WORK-048 work-graph.ts precedent).
 */

import type {
  WorkGraph,
  ExecutionSummary,
  VerificationRun,
  MaintenanceHealth,
  MaintenanceSignalItem,
  ProjectRuntimeStatus,
  Deployment,
} from '@/api/client';

/** The maintenance authority's own severity values, in display order (most severe first). */
const MAINTENANCE_SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

/** The rank of a maintenance severity for DISPLAY ordering only (unknown → last). */
function maintenanceSeverityRank(severity: string | null | undefined): number {
  const idx = (MAINTENANCE_SEVERITY_ORDER as readonly string[]).indexOf(severity ?? '');
  return idx === -1 ? MAINTENANCE_SEVERITY_ORDER.length : idx;
}

/** A health finding — a fact from an authority, shaped for display. */
export interface HealthFinding {
  /** Which authority produced the fact (presentation grouping only). */
  kind:
    | 'maintenance-signal'
    | 'failed-verification'
    | 'blocked-work'
    | 'failed-execution'
    | 'failed-deployment'
    | 'provider-error';
  /** What is unhealthy (one line). */
  what: string;
  /** Why (the authority's own explanation for the fact). */
  why: string;
  /** The authority's own severity/status value, verbatim — never computed. */
  severity: string | null;
  /** The evidence backing the finding (the authoritative record's identity). */
  evidence: string;
  /** Where to inspect the evidence (a work item route or a workbench tab). */
  href?: string;
}

/**
 * A maintenance work item — the maintenance authority's own signal record
 * (a planner-originated Work Item carrying maintenance metadata). The
 * `completed` flag is the authority's own value: an OPEN finding and
 * COMPLETED work are always distinguishable (adversarial #6).
 */
export interface MaintenanceWorkItem {
  workItemId: string;
  workItemHumanId: string;
  title: string;
  completed: boolean;
  category: string | null;
  severity: string | null;
  advisoryId: string | null;
  affectedCount: number | null;
  detectorSource: string | null;
  whyNow: string;
  href: string;
}

/** Split the maintenance authority's signals into OPEN work and COMPLETED work. */
export function splitMaintenanceWork(
  signals: readonly MaintenanceSignalItem[],
): { open: MaintenanceWorkItem[]; completed: MaintenanceWorkItem[] } {
  const toWork = (s: MaintenanceSignalItem): MaintenanceWorkItem => ({
    workItemId: s.workItemId,
    workItemHumanId: s.workItemHumanId,
    title: s.title,
    completed: s.completed,
    category: s.planner.maintenance?.category ?? null,
    severity: s.planner.maintenance?.severity ?? null,
    advisoryId: s.planner.maintenance?.advisoryId ?? null,
    affectedCount: s.planner.maintenance?.affectedCount ?? null,
    detectorSource: s.planner.maintenance?.detectorSource ?? null,
    whyNow: s.planner.whyNow,
    href: `/work-items/${s.workItemId}`,
  });
  const open: MaintenanceWorkItem[] = [];
  const completed: MaintenanceWorkItem[] = [];
  for (const s of signals) {
    (s.completed ? completed : open).push(toWork(s));
  }
  return { open, completed };
}

/**
 * Derive the health findings from the loaded authoritative facts. PURE and
 * DETERMINISTIC: the SAME facts always produce the SAME findings in the SAME
 * order; facts that are absent (a null/undefined input) contribute NOTHING —
 * a missing signal is never fabricated (adversarial #3; the page separately
 * withholds the all-clear when a contributing read FAILED — that is the
 * page's read-state concern, not this derivation's).
 */
export function deriveHealthFindings(input: {
  graph?: WorkGraph | null;
  executions?: readonly ExecutionSummary[];
  verificationRuns?: readonly VerificationRun[];
  maintenanceHealth?: MaintenanceHealth | null;
  runtimeStatus?: ProjectRuntimeStatus | null;
  deployments?: readonly Deployment[];
}): HealthFinding[] {
  const {
    graph = null,
    executions = [],
    verificationRuns = [],
    maintenanceHealth = null,
    runtimeStatus = null,
    deployments = [],
  } = input;
  const findings: HealthFinding[] = [];

  // 1. Maintenance signals (OPEN only — completed maintenance work is done
  //    work, never a finding). Severity/category/evidence are the authority's
  //    own values; display order: the authority's severity, then the record's
  //    own order.
  if (maintenanceHealth) {
    const { open } = splitMaintenanceWork(maintenanceHealth.signals);
    const ordered = [...open].sort(
      (a, b) =>
        maintenanceSeverityRank(a.severity) - maintenanceSeverityRank(b.severity) ||
        a.workItemHumanId.localeCompare(b.workItemHumanId),
    );
    for (const m of ordered) {
      findings.push({
        kind: 'maintenance-signal',
        what: `Maintenance: ${m.title}`,
        why: m.whyNow,
        severity: m.severity,
        evidence: [
          `${m.workItemHumanId} (${m.category ?? 'unknown category'})`,
          m.advisoryId ? `advisory ${m.advisoryId}` : null,
          m.affectedCount !== null ? `${m.affectedCount} affected` : null,
          m.detectorSource ? `detector: ${m.detectorSource}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        href: m.href,
      });
    }
  }

  // 2. Failed verification runs (the verification authority's own records —
  //    the run's own status and criteria counts, never a frontend verdict).
  for (const run of verificationRuns) {
    if (run.status !== 'failed') continue;
    const summary = run.summary as Record<string, unknown> | null;
    const fail = typeof summary?.criteriaFail === 'number' ? summary.criteriaFail : null;
    findings.push({
      kind: 'failed-verification',
      what: `Verification failed for ${run.workItemId.slice(0, 8)}`,
      why:
        fail !== null
          ? `The verification authority's run failed ${fail} acceptance ${fail === 1 ? 'criterion' : 'criteria'}.`
          : 'The verification authority\'s run failed.',
      severity: run.status,
      evidence: `run ${run.id.slice(0, 8)} (${run.source}${run.sourceRef ? `, ${run.sourceRef}` : ''})`,
      href: `/work-items/${run.workItemId}`,
    });
  }

  // 3. Blocked work items (the dependency authority's unsatisfied dependencies).
  if (graph) {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const n of graph.nodes) {
      if (!n.completed && n.unsatisfiedDependencies.length > 0) {
        const names = n.unsatisfiedDependencies.map(
          (id) => nodeById.get(id)?.workItemId ?? id.slice(0, 8),
        );
        findings.push({
          kind: 'blocked-work',
          what: `${n.workItemId} is blocked`,
          why: `waiting on ${names.join(', ')} (the dependency authority reports the dependencies unsatisfied)`,
          severity: 'blocked',
          evidence: `${n.unsatisfiedDependencies.length} unsatisfied dependenc${n.unsatisfiedDependencies.length === 1 ? 'y' : 'ies'}`,
          href: `/work-items/${n.id}`,
        });
      }
    }
  }

  // 4. Failed executions (the execution records' own failed status).
  for (const e of executions) {
    if (e.status !== 'failed') continue;
    findings.push({
      kind: 'failed-execution',
      what: `Execution failed (${e.provider}${e.model ? ` / ${e.model}` : ''})`,
      why: `The execution record's own status is failed (${e.mode} mode).`,
      severity: e.status,
      evidence: `execution ${e.executionId}`,
      href: e.workItemId ? `/work-items/${e.workItemId}` : undefined,
    });
  }

  // 5. Failed deployments (the runtime authority's own deployment statuses).
  for (const d of deployments) {
    if (d.status !== 'error' && d.status !== 'failed') continue;
    findings.push({
      kind: 'failed-deployment',
      what: `Deployment failed (${shortSha(d.commitSha)})`,
      why: `The runtime authority's deployment record status is ${d.status}.`,
      severity: d.status,
      evidence: `deployment ${d.externalId} on ${d.branch ?? '—'}`,
    });
  }

  // 6. Provider errors (the runtime authority's own provider statuses).
  if (runtimeStatus) {
    const providers: Array<[string, string | undefined]> = [
      ['GitHub', runtimeStatus.github?.status],
      ['Vercel', runtimeStatus.vercel?.status],
      ['Architect', runtimeStatus.architect?.status],
      ['Agent', runtimeStatus.agent?.status],
    ];
    for (const [name, status] of providers) {
      if (status !== 'error') continue;
      findings.push({
        kind: 'provider-error',
        what: `${name} provider connection is in error`,
        why: 'The runtime authority reports the provider status as error.',
        severity: status,
        evidence: `runtime provider ${name.toLowerCase()}`,
      });
    }
  }

  return findings;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : 'no commit';
}
