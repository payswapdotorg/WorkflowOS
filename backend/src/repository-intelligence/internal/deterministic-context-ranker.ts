/**
 * WORK-039: DeterministicContextRanker — the deterministic, explainable
 * retrieval/ranking layer.
 *
 * NO embedding / NO vector store / NO full-text index / NO AI model. The
 * WORK-039 prompt is explicit: "A deterministic baseline-aware retrieval
 * layer should be established before optional semantic ranking." An optional
 * SemanticRanker is a future slice; its output would remain ADVISORY
 * evidence, not authority.
 *
 * SIGNALS (each contributes a discrete weight + a human-readable reason
 * fragment to every selected item):
 *   term_overlap         — work-item/freeform terms matched against matchText.
 *   architecture_ref    — the item is referenced by an ArchitectureVersion.
 *   requirement_ref     — the item is referenced by a Requirement/Criterion.
 *   work_item_ref        — the item is referenced by a work item's scope
 *                          (surfaced via workItemTerms matching the item).
 *   dependency_ref       — the item is referenced by a dependency observation.
 *   baseline_observation — the item IS a baseline observation (carries
 *                          provenance; the evidence backbone — always
 *                          included regardless of term match, so the
 *                          consumer sees the full provenance-bearing view).
 *   test_relationship    — the item matches a test pattern.
 *   repository_structure — the item is a structural element (directory/module).
 *
 * PROVENANCE PRESERVATION (the central WORK-039 invariant). The ranker
 * NEVER mutates `item.provenance`. It only attaches `relevanceScore` +
 * `relevanceReason`. A high-relevance `observed` item stays `observed`; a
 * high-relevance `inferred` item stays `inferred`. The ONLY path to
 * `confirmed` is the authorized confirmation route on the baseline
 * observation (WORK-038), never the ranker.
 *
 * EXPLAINABLE. Every ranked item carries a non-empty `relevanceReason` — a
 * human-readable chain of the matched signals. No opaque output.
 *
 * DETERMINISTIC. Same query + same candidates → same ranked output (same
 * scores, same reasons, same order). The orchestrator's content_digest is
 * sha256 of the canonical (query_terms + item locators + sources + kinds +
 * scores) tuple, so the same baseline+query always produces the same digest
 * (test invariant #1).
 */
import type {
  ContextIndexQuery,
  ContextRanker,
  ContextSourceItem,
  RankedContextItem,
} from '../repository-intelligence.types.js';
import { createHash } from 'node:crypto';

/** The discrete weights each signal contributes. */
const WEIGHTS = {
  termOverlapPerMatch: 2,
  termOverlapMax: 12,
  architectureRef: 10,
  requirementRef: 8,
  dependencyRef: 6,
  baselineObservation: 4,
  testRelationship: 6,
  repositoryStructure: 2,
} as const;

/** The max items the ranker returns (bounds the index; the cap is generous). */
const MAX_ITEMS = 500;

interface SignalHit {
  readonly score: number;
  readonly reason: string;
}

/** Case-insensitive substring match (the item's matchText vs a term). */
function matchesTerm(matchText: string, term: string): boolean {
  if (term.length === 0) return false;
  return matchText.toLowerCase().includes(term.toLowerCase());
}

/** Compute the signal hits for a candidate against the query. */
function computeSignals(item: ContextSourceItem, query: ContextIndexQuery): SignalHit[] {
  const hits: SignalHit[] = [];
  const terms: string[] = [
    ...(query.queryTerms.workItemTerms ?? []),
    ...(query.queryTerms.freeformTerms ?? []),
  ];
  // term_overlap (covers work_item_ref via workItemTerms).
  if (terms.length > 0) {
    const matched: string[] = [];
    let perMatchScore = 0;
    for (const term of terms) {
      if (matchesTerm(item.matchText, term) && !matched.includes(term.toLowerCase())) {
        matched.push(term.toLowerCase());
        perMatchScore += WEIGHTS.termOverlapPerMatch;
      }
    }
    if (matched.length > 0) {
      hits.push({
        score: Math.min(perMatchScore, WEIGHTS.termOverlapMax),
        reason: `term_overlap(${matched.join(",")})`,
      });
    }
  }
  // architecture_ref — the item's authorityRef cites one of the query's architectureRefs.
  if (query.queryTerms.architectureRefs && query.queryTerms.architectureRefs.length > 0) {
    const cited = query.queryTerms.architectureRefs.includes(
      String(item.authorityRef.architectureVersionId ?? ''),
    );
    if (cited) {
      hits.push({ score: WEIGHTS.architectureRef, reason: `architecture_ref(${item.authorityRef.architectureVersionId})` });
    }
  }
  // requirement_ref — the item's authorityRef cites one of the query's requirementRefs.
  if (query.queryTerms.requirementRefs && query.queryTerms.requirementRefs.length > 0) {
    const cited = query.queryTerms.requirementRefs.includes(
      String(item.authorityRef.requirementId ?? ''),
    );
    if (cited) {
      hits.push({ score: WEIGHTS.requirementRef, reason: `requirement_ref(${item.authorityRef.requirementId})` });
    }
  }
  // dependency_ref — the item's authorityRef cites one of the query's dependencyRefs.
  if (query.queryTerms.dependencyRefs && query.queryTerms.dependencyRefs.length > 0) {
    const cited = query.queryTerms.dependencyRefs.includes(
      String(item.authorityRef.dependencyObservationId ?? ''),
    );
    if (cited) {
      hits.push({ score: WEIGHTS.dependencyRef, reason: `dependency_ref(${item.authorityRef.dependencyObservationId})` });
    }
  }
  // baseline_observation — the item IS a baseline observation (always gets the
  // base weight so the consumer sees the full provenance-bearing view, even
  // when no term matched — these are the evidence backbone).
  if (item.source === 'baseline_observation' || item.source === 'baseline_evidence') {
    hits.push({ score: WEIGHTS.baselineObservation, reason: `baseline_observation(${item.provenance})` });
  }
  // test_relationship — the item matches a test pattern.
  if (query.queryTerms.testPatterns && query.queryTerms.testPatterns.length > 0) {
    const matchedPattern = query.queryTerms.testPatterns.find((p) => item.matchText.toLowerCase().includes(p.toLowerCase()));
    if (matchedPattern) {
      hits.push({ score: WEIGHTS.testRelationship, reason: `test_relationship(${matchedPattern})` });
    }
  }
  // repository_structure — the item is a directory/module (structural element).
  if (item.kind === 'directory' || item.kind === 'module') {
    hits.push({ score: WEIGHTS.repositoryStructure, reason: 'repository_structure' });
  }
  return hits;
}

export class DeterministicContextRanker implements ContextRanker {
  async rank(
    query: ContextIndexQuery,
    candidates: readonly ContextSourceItem[],
  ): Promise<readonly RankedContextItem[]> {
    // Score every candidate.
    const scored: Array<{ item: ContextSourceItem; score: number; reason: string }> = [];
    for (const item of candidates) {
      const hits = computeSignals(item, query);
      const score = hits.reduce((acc, h) => acc + h.score, 0);
      const reason = hits.length > 0 ? hits.map((h) => h.reason).join(' + ') : '';
      // PROVENANCE PRESERVATION: the ranker NEVER mutates item.provenance.
      // It only attaches score + reason. A high-relevance observed item stays
      // observed; a high-relevance inferred item stays inferred.
      scored.push({ item, score, reason });
    }
    // Inclusion policy: include every item with score > 0 PLUS every baseline
    // observation/evidence (the provenance-bearing evidence backbone — the
    // consumer needs to see the full observed/inferred/confirmed/proposed
    // view of the baseline, not a term-filtered subset).
    const included = scored.filter(
      (s) => s.score > 0 || s.item.source === 'baseline_observation' || s.item.source === 'baseline_evidence',
    );
    // Deterministic order: score DESC, then locator ASC.
    included.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.locator.localeCompare(b.item.locator);
    });
    // Cap (bounds the index; the cap is generous — the evidence backbone is
    // always included, the cap only trims the long tail of low-relevance
    // file/module items).
    const capped = included.slice(0, MAX_ITEMS);
    // Map to RankedContextItem. The ranker NEVER mutates provenance — it
    // passes it through verbatim. Every item gets a NON-EMPTY relevanceReason
    // (test invariant #15): baseline observations with no other hit get the
    // baseline_observation reason; non-baseline items with no hit are filtered
    // out by the inclusion policy above.
    return capped.map((s) => {
      const reason = s.reason.length > 0 ? s.reason : `baseline_observation(${s.item.provenance})`;
      return {
        kind: s.item.kind,
        locator: s.item.locator,
        source: s.item.source,
        provenance: s.item.provenance, // NEVER mutated
        contentDigest: s.item.contentDigest,
        redacted: s.item.redacted,
        evidenceRef: s.item.evidenceRef,
        authorityRef: s.item.authorityRef,
        relevanceScore: s.score,
        relevanceReason: reason,
      };
    });
  }
}

/**
 * Compute the deterministic content_digest for an index. sha256 of the
 * canonical (query_kind, query_ref, query_terms_json, item locators +
 * sources + kinds + scores) tuple. Same baseline + same query → same digest
 * (test invariant #1). Different revision → different baseline → different
 * items → different digest (test invariant #3).
 */
export function computeIndexContentDigest(
  query: ContextIndexQuery,
  ranked: readonly RankedContextItem[],
): string {
  const canonical = {
    kind: query.kind,
    queryRef: query.queryRef,
    queryTerms: query.queryTerms,
    items: ranked.map((r) => ({
      kind: r.kind,
      locator: r.locator,
      source: r.source,
      provenance: r.provenance, // included in the digest — provenance is part of identity
      score: r.relevanceScore,
      reason: r.relevanceReason,
    })),
  };
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}
