/**
 * WORK-052 — the post-merge finalization audit (§34.8; ADR-0007).
 *
 * The completion rule (`governance-model.json` `completionRule`) defines the
 * completion CONDITION — the architect's merge is the only completion event.
 * The post-merge review of PR #62 (merged as `47615c2` while the canonical
 * state still recorded WORK-052 `in_flight`) exposed the operational gap: a
 * condition without a finalization mechanism leaves the repository able to
 * hold a FALSE program state. This module closes that gap from the evidence
 * side: it binds the canonical state to the repository's own merge history
 * and reports every finalization gap.
 *
 *   MERGED-BUT-NOT-COMPLETE — the architect merged the PR (merge evidence in
 *                             the first-parent history of main) while the work
 *                             order is still in_flight/pending: a merged Work
 *                             Order cannot remain represented as in_flight in
 *                             canonical state.
 *   EVIDENCE-MISMATCH       — a complete record whose mergedAs does not match
 *                             the AUTHORITATIVE merge identity: the PR number
 *                             and/or the merge commit are not the actual ones
 *                             (a genuine merge commit paired with a false PR
 *                             number is still a lie about provenance — the
 *                             PR #63 round-2 review).
 *
 * Merge-evidence shapes recognized on main's first-parent chain:
 *   - `Merge pull request #N from …` — the classic merge commit (bound by PR
 *     number);
 *   - `WORK-NNN: …` — the architect's direct/squash merge convention (bound
 *     by work-order id; PR #62 merged this way as `47615c2`).
 *
 * The second shape is the SPECIFIC colon-separated convention
 * (`WORK-NNN: title`, exactly as recorded in `governance-model.json`
 * postMergeFinalization.enforcement and ADR-0007) — NOT every subject that
 * begins with a work-order id. A post-merge FINALIZATION/state-only commit
 * names the work order as a TOPIC (`WORK-052 post-merge corrective
 * finalization — …`, the `1ccc45f` squash of PR #63) and is NOT merge
 * evidence: conflating it with the architectural merge it finalizes would
 * misclassify the very commit that established the finalization protocol as
 * merge evidence for its own work order (the PR #75 review — a
 * provenance/audit-model defect, not a stale test pin).
 *
 * PURE over its inputs; the only I/O is
 * {@link MergeEvidenceUnavailableError} fail-closed evidence collection from
 * repository-resident git history — never an external service.
 */

import { execFileSync } from 'node:child_process';

import type { ProgramState } from '../../architecture-checkpoints/index.js';

/** Merge evidence extracted from the repository's first-parent history. */
export interface MergeEvidence {
  /** PR number → the full merge-commit SHAs that merged it (classic merge commits). */
  readonly byPr: ReadonlyMap<number, readonly string[]>;
  /**
   * Work order id → the full commit SHAs whose subject follows the
   * `WORK-NNN: title` architect-merge convention. A state-only commit that
   * merely BEGINS with the id (e.g. a post-merge finalization) is NOT
   * evidence and never appears here.
   */
  readonly byWorkOrder: ReadonlyMap<string, readonly string[]>;
}

/** The result of binding the canonical program state to git merge evidence. */
export interface MergedFinalizationAudit {
  /** Work-order ids bound to merge evidence in the audited history. */
  readonly mergedWorkOrderIds: readonly string[];
  /** Finalization gaps — empty means every merged work order is finalized truthfully. */
  readonly gaps: readonly string[];
}

/** Git merge evidence could not be read — the invariant fails closed. */
export class MergeEvidenceUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `the merge evidence could not be read (${reason}) — the merged-finalization ` +
        'invariant requires the repository git history (fail closed)',
    );
    this.name = 'MergeEvidenceUnavailableError';
  }
}

const SHA_SUBJECT_LINE_RE = /^([0-9a-f]{40}) (.*)$/;
const MERGE_PULL_REQUEST_RE = /^Merge pull request #(\d+) from /;
/**
 * The architect-merge subject convention: `WORK-NNN: title` — the
 * colon-separated id-then-title shape (both actual architect squash merges
 * follow it: `WORK-046: Multi-Agent Delegation`, `WORK-052: Development
 * Governance & Self-Hosting Control Plane`). Subjects that merely BEGIN with
 * the id (no colon) name the work order as a topic — e.g. the `1ccc45f`
 * post-merge finalization — and are NOT merge evidence.
 */
const ARCHITECT_MERGE_SUBJECT_RE = /^(WORK-\d{3}): /;

/**
 * Parse `<sha> <subject>` log lines (the first-parent history of main) into
 * merge evidence. Both merge shapes are recognized; a work order or PR may
 * legitimately appear more than once when the architect ACTUALLY merged it
 * more than once (e.g. an implementation merge followed by a corrective
 * re-merge under the same convention) — the audit matches ANY actual merge
 * commit. A post-merge finalization/state-only commit is NOT a merge: its
 * subject names the work order as a topic without the colon convention, so
 * it is never collected as evidence (the PR #75 review).
 */
export function collectMergeEvidenceFromLines(lines: readonly string[]): MergeEvidence {
  const byPr = new Map<number, string[]>();
  const byWorkOrder = new Map<string, string[]>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const matched = SHA_SUBJECT_LINE_RE.exec(line);
    if (!matched) continue;
    const sha = matched[1]!;
    const subject = matched[2]!;
    const pr = MERGE_PULL_REQUEST_RE.exec(subject);
    if (pr) {
      const list = byPr.get(Number(pr[1])) ?? [];
      list.push(sha);
      byPr.set(Number(pr[1]), list);
    }
    const workOrder = ARCHITECT_MERGE_SUBJECT_RE.exec(subject);
    if (workOrder) {
      const list = byWorkOrder.get(workOrder[1]!) ?? [];
      list.push(sha);
      byWorkOrder.set(workOrder[1]!, list);
    }
  }
  return { byPr, byWorkOrder };
}

/**
 * Collect merge evidence from the repository's git history (repository-
 * resident truth; never an external service). The primary ref is `origin/main`
 * (the architect's merge line); a lone local repository falls back to `HEAD`.
 * Anything else fails closed with {@link MergeEvidenceUnavailableError}.
 */
export function collectMergeEvidenceFromRepository(repoRoot: string): MergeEvidence {
  const read = (ref: string): string =>
    execFileSync('git', ['-C', repoRoot, 'log', '--first-parent', ref, '--format=%H %s'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  let log: string;
  try {
    log = read('origin/main');
  } catch {
    try {
      log = read('HEAD');
    } catch (err) {
      throw new MergeEvidenceUnavailableError(String(err instanceof Error ? err.message : err));
    }
  }
  return collectMergeEvidenceFromLines(log.split('\n'));
}

/**
 * THE MERGED-FINALIZATION INVARIANT (§34.8): every work order with merge
 * evidence in the audited history must be `complete` with a `mergedAs` that
 * matches the AUTHORITATIVE MERGE IDENTITY — the ENTIRE identity, both
 * components:
 *
 *   mergedAs.pr          === the authoritative PR identity — the work order's
 *                           declared `pr`: for the classic merge shape the
 *                           commit subject names the PR the work order binds
 *                           by (`byPr` is keyed by that same number); for the
 *                           WORK-NNN convention the subject binds the commit
 *                           to the work order while the declared `pr` remains
 *                           the PR identity, AND
 *   mergedAs.mergeCommit === an actual merge commit for that work order
 *                           (full or prefix form — historical records may
 *                           carry the short hash).
 *
 * The PR number is part of the durable provenance claim and is VALIDATED
 * against the authoritative identity, not merely stored (the PR #63 round-2
 * review: a genuine merge commit paired with a false PR number must not
 * audit clean; a record that declares no `pr` while carrying WORK-NNN merge
 * evidence cannot anchor its claim at all — fail closed). A
 * merged-but-in_flight work order is exactly the false state the post-merge
 * review found; a mismatched identity is a lie about provenance.
 */
export function auditMergedFinalization(program: ProgramState, evidence: MergeEvidence): MergedFinalizationAudit {
  const mergedWorkOrderIds: string[] = [];
  const gaps: string[] = [];
  for (const w of program.workOrders) {
    const actual = [
      ...(w.pr !== undefined ? (evidence.byPr.get(w.pr) ?? []) : []),
      ...(evidence.byWorkOrder.get(w.id) ?? []),
    ];
    if (actual.length === 0) continue; // no merge evidence in history — not bound
    mergedWorkOrderIds.push(w.id);
    const short = actual.map((s) => s.slice(0, 9)).join(', ');
    if (w.status !== 'complete') {
      gaps.push(
        `workOrders[${w.id}]: MERGED (${short}) but the canonical status is "${w.status}" — a merged ` +
          `Work Order cannot remain represented as ${w.status} in canonical state; execute the post-merge ` +
          'finalization protocol (§34.8: complete + mergedAs with the actual merge commit, handoff removed)',
      );
      continue;
    }
    const recorded = (w.mergedAs?.mergeCommit ?? '').toLowerCase();
    if (!recorded || !actual.some((sha) => sha.toLowerCase().startsWith(recorded))) {
      gaps.push(
        `workOrders[${w.id}]: mergedAs.mergeCommit "${w.mergedAs?.mergeCommit ?? ''}" does not match the ` +
          `actual merge evidence (${short}) — the finalization must record the ACTUAL merge commit`,
      );
    }
    // The PR-number half of the provenance identity (the PR #63 round-2
    // review): mergedAs.pr must MATCH the authoritative PR identity, not
    // merely be stored. In both merge shapes that identity is the work
    // order's declared `pr` (the classic merge subject names it; the WORK-NNN
    // convention defers to it). A bound record that declares no `pr` cannot
    // anchor its claim — fail closed, otherwise dropping `pr` would bypass
    // the check entirely.
    if (w.mergedAs !== undefined) {
      if (w.pr === undefined) {
        gaps.push(
          `workOrders[${w.id}]: mergedAs.pr ${String(w.mergedAs.pr)} has no authoritative PR identity — the ` +
            `work order declares no pr while carrying merge evidence (${short}); the PR number is part of the ` +
            'durable provenance claim and must be checkable, not merely stored (fail closed)',
        );
      } else if (w.mergedAs.pr !== w.pr) {
        gaps.push(
          `workOrders[${w.id}]: mergedAs.pr ${String(w.mergedAs.pr)} does not match the authoritative PR ` +
            `identity (${w.pr}) — the PR number is part of the durable provenance claim and must be VALIDATED ` +
            'against the actual merge identity, not merely stored',
        );
      }
    }
  }
  return { mergedWorkOrderIds, gaps };
}
