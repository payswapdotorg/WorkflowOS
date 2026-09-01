import { runTwoHostDiscoveryExperiment } from './dogfooding-two-hosts.harness.js';

/**
 * V2-004 — standalone dogfooding RUN (real process, real protocol paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/node-capability/run-two-host-dogfooding.ts
 *
 * Executes the two-host capability-discovery experiment in a real process and
 * prints the full structured transcript that is persisted (verbatim) as
 * dogfooding evidence at
 * spec/architecture/v2/dogfooding-evidence/V2-004-two-host-capability-discovery.md.
 */

function line(label: string, value: string): string {
  return `  ${label.padEnd(34, ' ')} ${value}`;
}

const report = runTwoHostDiscoveryExperiment();

const out: string[] = [];
out.push('V2-004 two-host capability discovery — dogfooding run');
out.push(`work order: ${report.workOrderId} (node+capability protocol v${report.protocolVersion})`);
out.push(`injected protocol clock base: ${report.injectedClockBase}`);
out.push(`wall clock start (ms): ${report.wallClockStartedAtMs}`);
out.push(`wall duration (ms): ${report.wallDurationMs}`);
out.push('');
out.push('authentication (registration channel only):');
out.push(line('mechanism', report.authentication.mechanism));
out.push(line('MAC domain', report.authentication.domain));
out.push(line('challenges exchanged', String(report.authentication.challengesExchanged)));
out.push(line('sessions issued', String(report.authentication.sessionsIssued)));
out.push('');
out.push('host A (device/browser class):');
out.push(line('node id', report.deviceHost.nodeId));
out.push(line('key fingerprint', report.deviceHost.nodeKeyFingerprint));
out.push(line('platform class', report.deviceHost.platformClass));
out.push(line('location class', report.deviceHost.locationClass));
out.push(line('capabilities', report.deviceHost.capabilities.join(', ')));
out.push('');
out.push('host B (cloud class):');
out.push(line('node id', report.cloudHost.nodeId));
out.push(line('key fingerprint', report.cloudHost.nodeKeyFingerprint));
out.push(line('platform class', report.cloudHost.platformClass));
out.push(line('location class', report.cloudHost.locationClass));
out.push(line('capabilities', report.cloudHost.capabilities.join(', ')));
out.push('');
out.push('liveness phases (heartbeat/lease):');
for (const phase of report.livenessPhases) {
  out.push(line(phase.phase, phase.eligibleNodeIds.length === 0 ? '<no eligible nodes>' : phase.eligibleNodeIds.join(', ')));
}
out.push('');
out.push('requirement resolutions (same requirement set through both hosts):');
for (const resolution of report.requirementResolutions) {
  out.push(`- ${resolution.requirementId}`);
  out.push(line('required capabilities', resolution.requiredCapabilities.join(', ')));
  const placementText =
    resolution.placement.fallbackOrder !== undefined
      ? `${resolution.placement.required} (fallback: ${resolution.placement.fallbackOrder.join(', ')})`
      : resolution.placement.required;
  out.push(line('placement', placementText));
  for (const node of resolution.perNode) {
    const reasons = node.reasons.length === 0 ? 'none' : node.reasons.map((r) => `${r.dimension}:${r.code}`).join('; ');
    out.push(
      line(
        `node ${node.platformClass}`,
        `${node.eligible ? 'ELIGIBLE' : 'INELIGIBLE'} (capability=${node.capabilityEligible}, placement=${node.placementEligible}, rank=${node.placementRank ?? 'n/a'})`,
      ),
    );
    out.push(line('  reasons', reasons));
  }
}
out.push('');
out.push('cross-host equivalence checks (capabilities genuinely on both hosts):');
for (const check of report.equivalenceChecks) {
  out.push(
    line(
      `${check.requirementId} / ${check.sharedCapability}`,
      check.equivalent ? 'EQUIVALENT' : `NOT EQUIVALENT (${JSON.stringify(check.observed)})`,
    ),
  );
}
out.push('');
out.push('honest ineligibility differences (explicit, never silent):');
if (report.honestIneligibility.length === 0) {
  out.push('  <none>');
}
for (const difference of report.honestIneligibility) {
  out.push(line(`${difference.requirementId}`, `${difference.nodeId} → ${difference.code}`));
  out.push(line('  detail', difference.detail));
}
out.push('');
out.push(
  report.equivalenceChecks.every((c) => c.equivalent)
    ? 'RESULT: all shared capabilities resolved equivalently on both host classes'
    : 'RESULT: EQUIVALENCE FAILURE — a shared capability resolved differently across hosts',
);

process.stdout.write(`${out.join('\n')}\n`);
