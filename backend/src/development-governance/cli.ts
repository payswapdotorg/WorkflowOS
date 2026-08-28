/**
 * WORK-052 — the governance:status CLI.
 *
 * Answers the seven control questions from the repository-resident state alone
 * (Issue #61 Definition of Done): run from `backend/` with
 * `bun run governance:status` (or `bun run src/development-governance/cli.ts`
 * with `--repo-root <path>` to inspect any checkout). A fresh clone + this
 * command = the complete control-plane view; no conversational history.
 */

/* eslint-disable no-console -- a CLI's output IS the console. */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DefaultDevelopmentGovernanceService } from './internal/default-development-governance-service.js';

const repoRootFromArgs = (): string => {
  const i = process.argv.indexOf('--repo-root');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  // backend/src/development-governance/cli.ts → repo root is three levels up.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
};

const main = async (): Promise<void> => {
  const repoRoot = repoRootFromArgs();
  const service = await DefaultDevelopmentGovernanceService.create({ repoRoot });

  const governing = service.getGoverningState();
  const frontier = service.getFrontier();
  const parallel = service.evaluateParallelEligibility();

  console.log('=== WorkflowOS Development Governance Control Plane ===');
  console.log(`repository: ${repoRoot}`);
  console.log('');
  console.log('--- Q1: what architecture version governs? ---');
  console.log(`${governing.architectureVersion} (${governing.architectureVersionState})`);
  console.log(governing.evolution);
  console.log(`design package: ${governing.activeDesignPackage}`);
  console.log('');
  console.log('--- Engineering Control Loop ---');
  console.log(governing.controlLoop.map((s) => s.name).join(' → '));
  console.log('');
  console.log('--- Q2/Q3: Work Orders (complete / in flight / blocked / pending) ---');
  console.log(`complete:          ${frontier.complete.length}`);
  for (const w of frontier.inFlight) {
    const coord = w.coordinated ? '' : ' [UNCOORDINATED]';
    console.log(`in flight:         ${w.id} — ${w.title} (branch ${w.branch}${w.pr ? `, PR #${w.pr}` : ''})${coord}`);
    for (const c of w.conflicts) {
      console.log(
        `  conflict with ${c.with} on ${c.sharedSurfaces.map((s) => `${s.kind}:${s.value}`).join(', ')}${c.coordinated ? ' (coordinated)' : ''}`,
      );
    }
  }
  for (const w of frontier.dependencyEligible) {
    console.log(`eligible pending:  ${w.id} — ${w.title} (awaiting architect authorization)`);
  }
  for (const w of frontier.blocked) {
    console.log(`blocked:           ${w.id} — ${w.title}${w.blockedBy.length ? ` (blocked by ${w.blockedBy.join(', ')})` : ''}`);
  }
  console.log('');
  console.log('--- Q4: parallel eligibility (non-complete candidates) ---');
  for (const a of parallel.assessments) {
    // A candidate is independently startable when its dependencies are
    // satisfied AND it shares no UNCOORDINATED surface with an IN-FLIGHT item.
    // Pending/blocked partners are potential conflicts (planning input), not
    // active blockers.
    const activeConflicts = a.conflictsWith.filter((c) => c.partnerStatus === 'in_flight');
    const startable = a.dependencyEligible && activeConflicts.every((c) => c.coordinated);
    console.log(
      `${a.workOrderId}: ${startable ? 'startable' : 'not startable'}` +
        (a.unsatisfiedDependencies.length ? ` — unsatisfied deps: ${a.unsatisfiedDependencies.join(', ')}` : '') +
        (activeConflicts.length
          ? ` — active conflicts: ${activeConflicts.map((c) => `${c.workOrderId}${c.coordinated ? ' (coordinated)' : ''}`).join(', ')}`
          : '') +
        (a.conflictsWith.length !== activeConflicts.length
          ? ` — potential conflicts (not started): ${a.conflictsWith.filter((c) => c.partnerStatus !== 'in_flight').map((c) => c.workOrderId).join(', ')}`
          : ''),
    );
  }
  console.log('');
  console.log('--- Q5: assurance profiles (deterministic selection from declared surfaces) ---');
  const contractsByProfile = {
    LIGHT: service.getCheckpointApplicability('LIGHT'),
    STANDARD: service.getCheckpointApplicability('STANDARD'),
    HIGH_ASSURANCE: service.getCheckpointApplicability('HIGH_ASSURANCE'),
    CRITICAL: service.getCheckpointApplicability('CRITICAL'),
  };
  for (const [profile, contracts] of Object.entries(contractsByProfile)) {
    console.log(`${profile}: ${contracts.length} applicable checkpoint contracts`);
  }
  console.log('');
  console.log('--- Q6: durable decisions ---');
  for (const d of governing.decisions) {
    console.log(`${d.id} [${d.kind}, ${d.status}]: ${d.title} (${d.file})`);
  }
  console.log('');
  console.log('--- Q7: resumption (interrupted implementations) ---');
  for (const w of frontier.inFlight) {
    try {
      const view = service.resumeImplementation(w.id);
      console.log(`${view.workOrderId}: ${view.handoff.lastVerifiedState}`);
      for (const step of view.handoff.nextSteps) console.log(`  next: ${step}`);
      for (const blocker of view.handoff.blockers) console.log(`  BLOCKED: ${blocker}`);
    } catch {
      console.log(`${w.id}: no handoff record`);
    }
  }
  console.log('');
  console.log('--- Self-hosting boundary ---');
  console.log('MAY:');
  for (const m of governing.selfHostingBoundary.may) console.log(`  + ${m}`);
  console.log('MAY NOT:');
  for (const m of governing.selfHostingBoundary.mayNot) console.log(`  - ${m}`);
};

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
});
