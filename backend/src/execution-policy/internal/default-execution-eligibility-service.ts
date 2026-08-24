/**
 * WORK-033 §3/§4 — ExecutionEligibilityService (the HARD filter).
 *
 * Eligibility is a HARD filter. Benchmark quality MUST NEVER make an
 * ineligible candidate eligible (§3). Every blocking reason names the
 * constraint category that excluded the candidate (§4) so the frontend can
 * show "why" (§19, §23).
 *
 * Constraint precedence (most specific wins the final status):
 *   capability > subscription > privacy > project_policy > policy(org) >
 *   configuration_missing > unavailable > provider_temporarily_unavailable
 *
 * Pure function — no I/O. Deterministic. Fully unit-testable.
 */
import type {
  CapabilityReadiness,
  EligibilityBlock,
  EligibilityEvaluationInput,
  ExecutionConstraintCategory,
  ExecutionEligibilityResult,
  ExecutionEligibilityService,
  ExecutionEligibilityStatus,
} from '../types.js';

const STATUS_PRECEDENCE: readonly ExecutionEligibilityStatus[] = [
  'capability_blocked',
  'subscription_blocked',
  'unknown_constrained',
  'privacy_blocked',
  'project_policy_blocked',
  'policy_blocked',
  'configuration_missing',
  'unavailable',
  'provider_temporarily_unavailable',
];

export class DefaultExecutionEligibilityService implements ExecutionEligibilityService {
  evaluate(input: EligibilityEvaluationInput): ExecutionEligibilityResult {
    const blocks: EligibilityBlock[] = [];
    const satisfied: string[] = [];

    // §4.1 Capability constraints — task-profile required capabilities.
    this.evaluateCapability(input, blocks, satisfied);
    // PR #37 review fix (fail-closed §8): constrained modes require KNOWN
    // cost/latency evidence — unknown evidence under an explicit maximum
    // constraint is NOT neutral; the candidate cannot be declared eligible
    // because the constraint cannot be verified.
    this.evaluateConstrainedEvidence(input, blocks, satisfied);
    // §4.2 User constraints — allowed providers/modes, budget.
    this.evaluateUser(input, blocks, satisfied);
    // §4.3 Project constraints — external/native allowed, allowlist, denylist.
    this.evaluateProject(input, blocks, satisfied);
    // §4.4 Organization constraints — approved providers/models, browser auto.
    this.evaluateOrganization(input, blocks, satisfied);
    // §4.5 Availability constraints — provider/model unavailable, companion.
    this.evaluateAvailability(input, blocks, satisfied);
    // §5 Subscription constraints — block 'unknown' subscription, coding req.
    this.evaluateSubscription(input, blocks, satisfied);
    // §4/§26 Privacy + human-intervention constraints.
    this.evaluatePrivacy(input, blocks, satisfied);

    if (blocks.length === 0) {
      return {
        status: 'eligible',
        eligible: true,
        blockingReasons: [],
        satisfiedConstraints: satisfied,
      };
    }
    return {
      status: this.worstStatus(blocks),
      eligible: false,
      blockingReasons: blocks,
      satisfiedConstraints: satisfied,
    };
  }

  private worstStatus(blocks: readonly EligibilityBlock[]): ExecutionEligibilityStatus {
    const present = new Set(blocks.map((b) => this.categoryToStatus(b.category)));
    for (const s of STATUS_PRECEDENCE) if (present.has(s)) return s;
    return 'unavailable';
  }

  private categoryToStatus(cat: ExecutionConstraintCategory): ExecutionEligibilityStatus {
    switch (cat) {
      case 'capability': return 'capability_blocked';
      case 'subscription': return 'subscription_blocked';
      case 'privacy': return 'privacy_blocked';
      case 'project': return 'project_policy_blocked';
      case 'organization': return 'policy_blocked';
      case 'availability': return 'unavailable';
      case 'user': return 'project_policy_blocked';
      // PR #37 review fix (fail-closed): unknown cost/latency evidence under
      // an explicit maximum constraint is its own verdict — the candidate is
      // not policy-blocked or unavailable; it CANNOT BE VERIFIED against the
      // constraint, so it is 'unknown_constrained'.
      case 'evidence': return 'unknown_constrained';
    }
  }

  // ----- §4.1 capability -----
  private evaluateCapability(
    input: EligibilityEvaluationInput,
    blocks: EligibilityBlock[],
    satisfied: string[],
  ): void {
    const { candidate, taskProfile } = input;
    const caps = candidate.capabilities;
    for (const req of taskProfile.requiredCapabilities) {
      const have = this.capabilityFor(req, caps);
      const ok = have === 'ready' || have === 'unverified' || have === 'supported';
      if (ok) {
        satisfied.push(`capability:${req}`);
      } else {
        blocks.push({
          category: 'capability',
          constraint: `required:${req}`,
          reason: `Task requires ${req} but the candidate provides ${have}.`,
        });
      }
    }
  }

  private capabilityFor(req: string, caps: { codingAgent: CapabilityReadiness; browser: CapabilityReadiness; repositoryAccess: CapabilityReadiness; terminal: CapabilityReadiness; nativeApi: CapabilityReadiness; externalUi: CapabilityReadiness; }): CapabilityReadiness {
    switch (req) {
      case 'coding_agent': return caps.codingAgent;
      case 'browser': return caps.browser;
      case 'repository_access': return caps.repositoryAccess;
      case 'terminal': return caps.terminal;
      case 'native_api': return caps.nativeApi;
      case 'external_ui': return caps.externalUi;
      default: return 'unavailable';
    }
  }

  // ----- PR #37 review fix: fail-closed constrained evidence (§8) -----
  /**
   * FAIL-CLOSED rule for constrained benchmark modes (§8) + explicit
   * maximum constraints:
   *
   *   cost constraint + unknown cost      → ineligible (unknown_constrained)
   *   latency constraint + unknown latency → ineligible (unknown_constrained)
   *   known cost over the cap              → ineligible (existing §4.2/§4.4 checks)
   *   known latency over the cap           → ineligible (hard latency check)
   *
   * A candidate whose required evidence is UNKNOWN cannot legitimately be
   * declared eligible under an explicit maximum — treating unknown as
   * neutral would let COST_CONSTRAINED / LATENCY_CONSTRAINED modes recommend
   * candidates that were never verified against the constraint. The honest
   * verdict is 'unknown_constrained' with the missing-evidence reason, so
   * the UI can tell the user exactly what evidence is missing (§19 why).
   *
   * Cost caps compose from every source: the user/project per-task cap, the
   * org maximum, and the benchmark policy snapshot's maxCostCents. Latency
   * uses the policy snapshot's maxDurationMs (§26 max_time_to_pr_ms).
   */
  private evaluateConstrainedEvidence(
    input: EligibilityEvaluationInput,
    blocks: EligibilityBlock[],
    satisfied: string[],
  ): void {
    const { candidate, policy, constraints } = input;
    // --- cost: fail closed when ANY explicit cap is set + cost unknown ---
    const costCaps = [
      constraints.user.maxPerTaskCostCents,
      constraints.organization.maximumExecutionCostCents,
      policy.maxCostCents,
    ].filter((c): c is number => c != null);
    if (costCaps.length > 0) {
      if (candidate.estimatedCost.cents == null) {
        blocks.push({
          category: 'evidence',
          constraint: 'unknown_cost_under_cost_constraint',
          reason: `A cost constraint is active (max ${Math.min(...costCaps)} cents) but this candidate's cost estimate is unknown — it cannot be verified against the constraint (fail-closed).`,
        });
      } else {
        satisfied.push('evidence:cost_known');
      }
    }
    // --- latency: hard check + fail closed ---
    const latencyCap = policy.maxDurationMs;
    if (latencyCap != null) {
      if (candidate.estimatedLatency.estimatedMs == null) {
        blocks.push({
          category: 'evidence',
          constraint: 'unknown_latency_under_latency_constraint',
          reason: `A latency constraint is active (max ${latencyCap}ms) but this candidate's latency estimate is unknown — it cannot be verified against the constraint (fail-closed).`,
        });
      } else if (candidate.estimatedLatency.estimatedMs > latencyCap) {
        // PR #37 review fix: the latency constraint was previously only a
        // recommendation-scoring input — a KNOWN over-cap latency is a hard
        // constraint violation, exactly like a known over-cap cost.
        blocks.push({
          category: 'evidence',
          constraint: 'latency_over_max',
          reason: `Estimated latency ${candidate.estimatedLatency.estimatedMs}ms exceeds the maximum ${latencyCap}ms.`,
        });
      } else {
        satisfied.push('evidence:latency_known');
      }
    }
  }

  // ----- §4.2 user -----
  private evaluateUser(
    input: EligibilityEvaluationInput,
    blocks: EligibilityBlock[],
    satisfied: string[],
  ): void {
    const { candidate, constraints } = input;
    const u = constraints.user;
    if (u.allowedProviders.length > 0 && !u.allowedProviders.includes(candidate.provider)) {
      blocks.push({ category: 'user', constraint: 'allowed_providers', reason: `Provider ${candidate.provider} is not in your allowed providers list.` });
    } else {
      satisfied.push('user:allowed_providers');
    }
    if (u.allowedModes.length > 0 && !u.allowedModes.includes(candidate.executionMode)) {
      blocks.push({ category: 'user', constraint: 'allowed_modes', reason: `Execution mode ${candidate.executionMode} is not in your allowed modes.` });
    } else {
      satisfied.push('user:allowed_modes');
    }
    if (u.maxPerTaskCostCents != null && candidate.estimatedCost.cents != null && candidate.estimatedCost.cents > u.maxPerTaskCostCents) {
      blocks.push({ category: 'user', constraint: 'max_per_task_cost', reason: `Estimated cost exceeds your per-task budget.` });
    } else {
      satisfied.push('user:max_per_task_cost');
    }
  }

  // ----- §4.3 project -----
  private evaluateProject(
    input: EligibilityEvaluationInput,
    blocks: EligibilityBlock[],
    satisfied: string[],
  ): void {
    const { candidate, constraints, taskProfile } = input;
    const p = constraints.project;
    if (candidate.executionMode === 'external' && !p.externalExecutionAllowed) {
      blocks.push({ category: 'project', constraint: 'external_execution_prohibited', reason: 'Project policy prohibits external execution.' });
    } else {
      satisfied.push('project:external_execution_allowed');
    }
    if (candidate.executionMode === 'native' && !p.nativeExecutionAllowed) {
      blocks.push({ category: 'project', constraint: 'native_execution_prohibited', reason: 'Project policy prohibits native execution.' });
    } else {
      satisfied.push('project:native_execution_allowed');
    }
    if (p.providerAllowlist.length > 0 && !p.providerAllowlist.includes(candidate.provider)) {
      blocks.push({ category: 'project', constraint: 'provider_allowlist', reason: `Provider ${candidate.provider} is not on the project allowlist.` });
    }
    if (p.providerDenylist.includes(candidate.provider)) {
      blocks.push({ category: 'project', constraint: 'provider_denylist', reason: `Provider ${candidate.provider} is on the project denylist.` });
    }
    if (p.allowedModes.length > 0 && !p.allowedModes.includes(candidate.executionMode)) {
      blocks.push({ category: 'project', constraint: 'allowed_modes', reason: `Mode ${candidate.executionMode} not allowed by project.` });
    }
    if (p.localOnly && candidate.executionMode !== 'native') {
      blocks.push({ category: 'project', constraint: 'local_only', reason: 'Project is local-only; external execution prohibited.' });
    }
    if (p.privateRepositoryPolicy && candidate.executionMode === 'external' && !taskProfile.repositoryAccess) {
      blocks.push({ category: 'project', constraint: 'private_repository', reason: 'Private repository policy + external execution requires repository access.' });
    }
    // taskProfile-derived mode gating
    if (!taskProfile.externalExecutionAllowed && candidate.executionMode === 'external') {
      blocks.push({ category: 'project', constraint: 'task_external_disallowed', reason: 'This task does not allow external execution.' });
    }
    if (!taskProfile.nativeExecutionAllowed && candidate.executionMode === 'native') {
      blocks.push({ category: 'project', constraint: 'task_native_disallowed', reason: 'This task does not allow native execution.' });
    }
  }

  // ----- §4.4 organization -----
  private evaluateOrganization(
    input: EligibilityEvaluationInput,
    blocks: EligibilityBlock[],
    satisfied: string[],
  ): void {
    const { candidate, constraints } = input;
    const o = constraints.organization;
    if (o.approvedProvidersOnly.length > 0 && !o.approvedProvidersOnly.includes(candidate.provider)) {
      blocks.push({ category: 'organization', constraint: 'approved_providers_only', reason: `Provider ${candidate.provider} is not org-approved.` });
    } else {
      satisfied.push('org:approved_providers');
    }
    if (o.approvedModelsOnly.length > 0 && !o.approvedModelsOnly.includes(candidate.model)) {
      blocks.push({ category: 'organization', constraint: 'approved_models_only', reason: `Model ${candidate.model} is not org-approved.` });
    }
    if (o.noThirdPartyBrowserAutomation && candidate.executionMode === 'external' && candidate.capabilities.codingAgent !== 'unavailable') {
      blocks.push({ category: 'organization', constraint: 'no_third_party_browser_automation', reason: 'Org policy prohibits third-party browser automation for external coding agents.' });
    }
    if (o.maximumExecutionCostCents != null && candidate.estimatedCost.cents != null && candidate.estimatedCost.cents > o.maximumExecutionCostCents) {
      blocks.push({ category: 'organization', constraint: 'maximum_execution_cost', reason: 'Estimated cost exceeds the org maximum.' });
    }
  }

  // ----- §4.5 availability -----
  private evaluateAvailability(
    input: EligibilityEvaluationInput,
    blocks: EligibilityBlock[],
    satisfied: string[],
  ): void {
    const { candidate, constraints } = input;
    const a = constraints.availability;
    if (a.providerUnavailable.includes(candidate.provider)) {
      blocks.push({ category: 'availability', constraint: 'provider_unavailable', reason: `Provider ${candidate.provider} is temporarily unavailable.` });
    }
    if (a.modelUnavailable.includes(candidate.model)) {
      blocks.push({ category: 'availability', constraint: 'model_unavailable', reason: `Model ${candidate.model} is temporarily unavailable.` });
    }
    if (candidate.executionMode === 'external' && !a.externalCompanionInstalled) {
      blocks.push({ category: 'availability', constraint: 'companion_not_installed', reason: 'External execution requires the Companion extension (not installed).' });
    } else {
      satisfied.push('availability:companion');
    }
    if (candidate.executionMode === 'external' && candidate.capabilities.codingAgent === 'unverified' && !a.codingSurfaceVerified.includes(candidate.provider)) {
      // §23: unverified coding surface is NOT automatically eligible — the
      // Companion verifies at runtime; for policy we mark 'configuration_missing'
      // so the user understands the surface is unverified.
      blocks.push({ category: 'availability', constraint: 'coding_surface_unverified', reason: 'The provider coding surface is unverified.' });
    }
    // No supported modes → configuration_missing.
    if (candidate.capabilities.supportedExecutionModes.length === 0) {
      blocks.push({ category: 'availability', constraint: 'configuration_missing', reason: 'No execution mode is configured for this provider.' });
    }
  }

  // ----- §5 subscription -----
  private evaluateSubscription(
    input: EligibilityEvaluationInput,
    blocks: EligibilityBlock[],
    satisfied: string[],
  ): void {
    const { candidate, constraints } = input;
    const s = constraints.subscription;
    const access = candidate.accessProfile;
    if (s.blockUnknownSubscription && (!access || access.statusSource === 'unknown')) {
      blocks.push({ category: 'subscription', constraint: 'subscription_unknown', reason: 'Subscription status is unknown; configure your provider access profile.' });
    } else {
      satisfied.push('subscription:verified');
    }
    if (s.requiredCodingAgentProviders.includes(candidate.provider)) {
      const ca = candidate.capabilities.codingAgent;
      if (ca !== 'ready' && ca !== 'supported') {
        blocks.push({ category: 'subscription', constraint: 'coding_agent_subscription_required', reason: 'This provider requires a coding-agent subscription.' });
      }
    }
  }

  // ----- §26 privacy + human intervention -----
  private evaluatePrivacy(
    input: EligibilityEvaluationInput,
    blocks: EligibilityBlock[],
    satisfied: string[],
  ): void {
    const { candidate, policy, taskProfile } = input;
    const lvl = policy.privacyRequirements.level;
    if (lvl === 'local_only' && candidate.executionMode !== 'native') {
      blocks.push({ category: 'privacy', constraint: 'local_only', reason: 'Privacy level is local-only; external execution prohibited.' });
    } else {
      satisfied.push('privacy:level');
    }
    if (lvl === 'regulated' && candidate.executionMode === 'external') {
      blocks.push({ category: 'privacy', constraint: 'regulated', reason: 'Regulated data must not leave the native execution boundary.' });
    }
    // §26 human intervention: if policy disallows intervention and the
    // external surface requires it, the candidate is ineligible.
    if (!policy.humanInterventionPolicy.allowed && taskProfile.humanInterventionLikely && candidate.executionMode === 'external') {
      blocks.push({ category: 'privacy', constraint: 'human_intervention_disallowed', reason: 'Policy disallows human intervention; external execution may require it.' });
    }
  }
}
