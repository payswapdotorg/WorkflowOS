/**
 * WORK-040: Deterministic, explainable planning prioritizer.
 *
 * Turns a {@link PlanningSignal} into a {@link PlanningCandidate} with a
 * deterministic, explainable priority (priorityFactors + rationale + whyNow +
 * expectedImpact) + a deterministic proposedWorkItemId (the dedup key).
 *
 * DESIGN INVARIANTS (enforced statically in static-architecture.test.ts):
 *
 *   * NO OPAQUE AI SCORE. Every priority factor is a discrete, traceable
 *     signal (blocks-n-downstream, requested-by-developer, architecture-risk,
 *     dependency-chain, technical-debt, performance-opportunity, product-goal,
 *     completed-work-unblocks, requirement-gap, benchmark-evidence,
 *     confidence-evidence-quality). The priority band (high/medium/low) is a
 *     deterministic function of the summed weights — never an LLM whim.
 *   * PROVENANCE NEVER PROMOTED. The prioritizer reads `signal.provenance` +
 *     passes it to the candidate verbatim. It NEVER assigns the literal
 *     'confirmed' to a provenance field (the regex
 *     /provenance:\s*[^,}]*['"]confirmed['"]/ forbids both direct + conditional
 *     promotion). A planner recommendation stays `proposed` (or
 *     `observed`/`inferred` when the signal carries that); `confirmed` is
 *     reachable ONLY through the authorized confirmation route on a baseline
 *     observation — a SEPARATE dimension from the planner.
 *   * DETERMINISTIC DEDUP KEY. The proposedWorkItemId = "PLAN-" +
 *     sha256(canonical(goal) + "|" + canonical(scope)).slice(0,10). Two
 *     signals with the same canonical goal + scope produce the same id → the
 *     existing UNIQUE(architecture_version_id, work_item_id) DB constraint
 *     fences concurrent runs → convergent Work Item creation (no duplicates).
 *   * DEPENDENCY-AWARE, NEVER MUTATING. The prioritizer MAY consult the
 *     existing dependency graph (read-only: listTransitiveDependencies /
 *     listForWorkItem) to surface dependency-chain explanation (blockers /
 *     prerequisites / chains). It NEVER calls add/remove (the dependency graph
 *     is the /work-items authority's to mutate via the existing
 *     /work-items/dependencies route).
 *   * NO PROVIDER SELECTION. executionModeAdvisory is the ADVISORY frozen-spec
 *     value 'native-or-external-per-eligibility' — the planner does NOT select
 *     a provider (WORK-043/044 territory).
 */
import { createHash } from 'node:crypto';
import type {
  PlanningCandidate,
  PlanningContext,
  PlanningPriority,
  PlanningPriorityFactor,
  PlanningSignal,
  PlanningSignalKind,
  PlanningPrioritizer,
} from '../development-planner.types.js';

/**
 * Canonicalize a freeform string for dedup hashing: lowercase, trim, collapse
 * internal whitespace to single spaces. Two signals whose goals differ only
 * in case / whitespace produce the SAME hash → the same proposedWorkItemId →
 * convergence.
 */
function canonicalizeText(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Compute the deterministic dedup hash for a signal: sha256 of
 * canonical(goal) + "|" + canonical(scope-or-empty), truncated to 10 hex chars.
 * 10 hex chars = 40 bits = ~1.1e12 buckets — collision-resistant for any
 * realistic per-project backlog; the existing DB UNIQUE constraint is the hard
 * fence even in the vanishingly unlikely collision case (the second INSERT
 * throws + the planner catches + re-queries → converges).
 */
export function computeCanonicalGoalHash(goal: string, scope?: string): string {
  const canon = canonicalizeText(goal);
  const scopeCanon = scope ? canonicalizeText(scope) : '';
  return createHash('sha256')
    .update(`${canon}|${scopeCanon}`)
    .digest('hex')
    .slice(0, 10);
}

/**
 * The deterministic proposedWorkItemId (the dedup key). Prefixed "PLAN-" so a
 * planner-originated Work Item is visually distinguishable from a
 * manually-created "WORK-xxx" id. Two signals with the same canonical goal +
 * scope produce the same proposedWorkItemId.
 */
export function computeProposedWorkItemId(goal: string, scope?: string): string {
  return `PLAN-${computeCanonicalGoalHash(goal, scope)}`;
}

/** Title-case the first letter of a goal for the Work Item title. */
function deriveTitle(goal: string): string {
  const trimmed = goal.trim();
  if (trimmed.length === 0) return 'Untitled planning candidate';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Build the objective from the signal's goal + scope. */
function deriveObjective(signal: PlanningSignal): string {
  const parts: string[] = [signal.canonicalGoal.trim()];
  if (signal.scope) parts.push(`Scope: ${signal.scope.trim()}.`);
  const prov = signal.provenance;
  parts.push(
    `(planner recommendation — provenance: ${prov}; source: ${signal.kind}; not confirmed truth)`,
  );
  return parts.join(' ');
}

/** Per-kind base weight + the primary factor detail. */
function kindBaseWeight(signal: PlanningSignal): {
  weight: number;
  detail: string;
} {
  switch (signal.kind) {
    case 'developer-request':
      return { weight: 4, detail: 'explicit developer request' };
    case 'product-goal':
      return { weight: 3, detail: 'declared product goal' };
    case 'technical-debt':
      return { weight: 2, detail: 'technical debt identified' };
    case 'refactor':
      return { weight: 2, detail: 'refactor opportunity' };
    case 'performance-opportunity':
      return { weight: 2, detail: 'performance opportunity' };
    case 'dependency-observation':
      return { weight: 2, detail: 'dependency observation' };
    case 'completed-work':
      return { weight: 1, detail: 'completed-work signal (unblocks follow-up)' };
    case 'architecture-observation':
      return { weight: 3, detail: 'architecture observation' };
    case 'requirement-gap':
      return { weight: 3, detail: 'requirement gap identified' };
    case 'benchmark-evidence':
      return { weight: 2, detail: 'benchmark evidence' };
    default:
      return { weight: 1, detail: 'unspecified signal' };
  }
}

/** Map the kind to a canonical priority-factor kind. */
function kindFactorKind(
  kind: PlanningSignalKind,
): PlanningPriorityFactor['kind'] {
  switch (kind) {
    case 'developer-request':
      return 'requested-by-developer';
    case 'product-goal':
      return 'product-goal';
    case 'technical-debt':
      return 'technical-debt';
    case 'refactor':
      return 'technical-debt';
    case 'performance-opportunity':
      return 'performance-opportunity';
    case 'dependency-observation':
      return 'dependency-chain';
    case 'completed-work':
      return 'completed-work-unblocks';
    case 'architecture-observation':
      return 'architecture-risk';
    case 'requirement-gap':
      return 'requirement-gap';
    case 'benchmark-evidence':
      return 'benchmark-evidence';
    default:
      return 'confidence-evidence-quality';
  }
}

/** Sum weights → discrete priority band. */
function bandFor(totalWeight: number): PlanningPriority {
  if (totalWeight >= 10) return 'high';
  if (totalWeight >= 5) return 'medium';
  return 'low';
}

/**
 * The deterministic, explainable prioritizer.
 */
export class DeterministicPlanningPrioritizer implements PlanningPrioritizer {
  async prioritize(
    signal: PlanningSignal,
    ctx: PlanningContext,
  ): Promise<PlanningCandidate> {
    const factors: PlanningPriorityFactor[] = [];

    // 1. The signal-kind base factor.
    const base = kindBaseWeight(signal);
    factors.push({
      kind: kindFactorKind(signal.kind),
      weight: base.weight,
      detail: base.detail,
    });

    // 2. blocks-n-downstream — the signal's explicit declaration OR the count
    //    of relatedWorkItemIds (the candidate relates to N existing items; a
    //    rough downstream-impact proxy). The planner does NOT mutate the
    //    dependency graph; it surfaces this as explanation only.
    const blocksN =
      signal.blocksCount ?? signal.relatedWorkItemIds?.length ?? 0;
    if (blocksN > 0) {
      factors.push({
        kind: 'blocks-n-downstream',
        weight: Math.min(blocksN, 5),
        detail: `relates to ${blocksN} existing work item(s) — potential downstream impact`,
      });
    }

    // 3. dependency-chain — read the existing graph (read-only) for each
    //    related item to surface the chain in the rationale. NEVER mutate.
    if (signal.relatedWorkItemIds && signal.relatedWorkItemIds.length > 0) {
      let chainDepth = 0;
      const chainItems: string[] = [];
      for (const relatedId of signal.relatedWorkItemIds) {
        try {
          const transitive =
            await ctx.workItemDependencyRepository.listTransitiveDependencies(
              relatedId,
            );
          if (transitive.length > 0) {
            chainDepth += transitive.length;
            chainItems.push(`${relatedId}→${transitive.length} deps`);
          }
        } catch {
          // A related id that does not exist (or whose deps can't be read) is
          // recorded honestly — the planner does NOT fabricate a chain.
          ctx.logger.warn('development-planner.dependency-chain-read-failed', {
            relatedId,
          });
        }
      }
      if (chainDepth > 0) {
        factors.push({
          kind: 'dependency-chain',
          weight: Math.min(chainDepth, 4),
          detail: `dependency chain depth ${chainDepth} (${chainItems.join('; ')})`,
        });
      }
    }

    // 4. confidence-evidence-quality — the count + provenance of evidence refs.
    const evidenceCount = signal.evidenceRefs?.length ?? 0;
    if (evidenceCount > 0) {
      // 'observed' evidence is worth more than 'inferred'; the signal's own
      // provenance modulates this.
      const provMultiplier =
        signal.provenance === 'observed'
          ? 1
          : signal.provenance === 'inferred'
            ? 0.5
            : 0.25;
      const evidenceWeight = Math.min(
        Math.round(evidenceCount * provMultiplier),
        3,
      );
      if (evidenceWeight > 0) {
        factors.push({
          kind: 'confidence-evidence-quality',
          weight: evidenceWeight,
          detail: `${evidenceCount} evidence ref(s) (provenance ${signal.provenance})`,
        });
      }
    }

    // 5. requirement-gap — the signal explicitly declares a requirement gap.
    if (signal.kind === 'requirement-gap') {
      factors.push({
        kind: 'requirement-gap',
        weight: 2,
        detail: 'requirement gap — coverage missing',
      });
    }

    // 6. architecture-risk — architecture-observation signals carry elevated risk.
    if (signal.kind === 'architecture-observation') {
      factors.push({
        kind: 'architecture-risk',
        weight: 2,
        detail: 'architecture observation — boundary/drift risk',
      });
    }

    // 7. performance-opportunity — explicit perf signals.
    if (signal.kind === 'performance-opportunity') {
      factors.push({
        kind: 'performance-opportunity',
        weight: 2,
        detail: 'performance opportunity identified',
      });
    }

    // 8. benchmark-evidence — explicit benchmark signals.
    if (signal.kind === 'benchmark-evidence') {
      factors.push({
        kind: 'benchmark-evidence',
        weight: 2,
        detail: 'benchmark evidence cited',
      });
    }

    // Sum + band.
    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    const priority = bandFor(totalWeight);

    // Rationale + whyNow + expectedImpact — derived from the factors (no LLM).
    const rationale = `Priority ${priority} (total weight ${totalWeight}): ${factors.map((f) => `${f.kind}(+${f.weight}: ${f.detail})`).join('; ')}.`;
    const whyNow =
      signal.kind === 'developer-request'
        ? 'explicit developer request — direct user intent'
        : signal.kind === 'completed-work'
          ? 'completed-work signal — follow-up now unblocked'
          : signal.kind === 'architecture-observation'
            ? 'architecture observation — drift/risk warrants near-term attention'
            : signal.kind === 'requirement-gap'
              ? 'requirement gap — coverage missing now'
              : 'planner-recommended candidate — eligible for the existing Work Item lifecycle';
    const expectedImpact = `Creates a governed Work Item (proposedWorkItemId ${computeProposedWorkItemId(signal.canonicalGoal, signal.scope)}) entering the existing Work Item → Work Order → Execution → Verification → Review lifecycle. Execution mode: native or external per eligibility/policy (advisory — the planner does NOT select a provider).`;

    // PROVENANCE — passed through verbatim. NEVER promoted. The candidate's
    // signal carries the SAME provenance the caller supplied (observed /
    // inferred / proposed). The literal 'confirmed' is NEVER assigned here.
    return {
      signal,
      canonicalGoalHash: computeCanonicalGoalHash(
        signal.canonicalGoal,
        signal.scope,
      ),
      proposedWorkItemId: computeProposedWorkItemId(
        signal.canonicalGoal,
        signal.scope,
      ),
      title: deriveTitle(signal.canonicalGoal),
      objective: deriveObjective(signal),
      scope: signal.scope ?? null,
      priority,
      priorityFactors: factors,
      rationale,
      whyNow,
      expectedImpact,
      proposedDependencies: signal.relatedWorkItemIds ?? [],
      executionModeAdvisory: 'native-or-external-per-eligibility',
    };
  }
}
