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
 *     by work-order id; PR #62 merged this way as `47615c2`);
 *   - `Governance: WORK-NNN — … (#PR)` — the architect's governance-decision
 *     squash-merge convention (bound by work-order id; PR #81 merged this
 *     way as `8dac9c4` for WORK-063, and PR #80 as `9aadd50` for the
 *     WORK-062 governance correction);
 *   - `type(WORK-NNN): title (#PR)` — the architect's conventional-commit
 *     squash-merge convention, the work-order id in the SCOPE position
 *     (bound by work-order id; PR #86 merged this way as `c351451` for
 *     WORK-064 — the fourth shape, recognized by the WORK-064 finalization).
 *
 * The second, third, and fourth shapes are the SPECIFIC conventions — the
 * work-order id in TITLE-HEAD position, separated from the title by `: ` or
 * ` — ` respectively, or in the SCOPE position with a title that names the
 * DOMAIN and never the work order — NOT every subject that begins with (or
 * merely contains) a work-order id. A post-merge FINALIZATION/state-only
 * commit names the work order as a TOPIC (`WORK-052 post-merge corrective
 * finalization — …`, the `1ccc45f` squash of PR #63; `chore(governance): the
 * WORK-062 post-merge finalization — …`, the `46e7858` squash of PR #83) and
 * is NOT merge evidence: conflating it with the architectural merge it
 * finalizes would misclassify the very commit that established the
 * finalization protocol as merge evidence for its own work order (the PR #75
 * review — a provenance/audit-model defect, not a stale test pin).
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
   * Work order id → the full commit SHAs whose subject follows a recognized
   * architect-merge convention (`WORK-NNN: title`,
   * `Governance: WORK-NNN — title (#PR)`, or `type(WORK-NNN): title (#PR)`).
   * A state-only commit that names the work order as a TOPIC (e.g. a
   * post-merge finalization) is NOT evidence and never appears here.
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
 * The architect's governance-decision squash-merge convention:
 * `Governance: WORK-NNN — title (#PR)` — the work-order id in TITLE-HEAD
 * position after the fixed `Governance: ` prefix, separated from the title
 * by an em-dash (both actual instances: `8dac9c4` "Governance: WORK-063 —
 * Identity and Access Layer (…) (#81)", the WORK-063 completion merge, and
 * `9aadd50` "Governance: WORK-062 — Durable Multi-Agent Orchestration
 * Substrate (…) (#80)", the governance correction that issued WORK-062).
 * Post-merge finalization/state-only subjects are structurally EXCLUDED: the
 * `46e7858` finalization carries the `chore(governance): ` prefix (not
 * `Governance: `) and names the work order as a topic after an article
 * ("chore(governance): the WORK-062 post-merge finalization …"), so neither
 * the prefix nor the title-head position can match. The declared `pr`
 * remains the PR identity for this shape exactly as for the colon
 * convention (ADR-0007): the subject binds the commit to the work order
 * while the trailing `(#PR)` stamp is GitHub's squash-merge provenance
 * marker on the PR title.
 */
const GOVERNANCE_MERGE_SUBJECT_RE = /^Governance: (WORK-\d{3}) — /;
/**
 * The architect's conventional-commit squash-merge convention:
 * `type(work-NNN): title (#PR)` — the work-order id in the SCOPE position
 * (the binding position), with the title naming the DOMAIN, never the work
 * order itself (the actual instance: `c351451` "feat(work-064): the
 * Continuous Product Validation domain (the domain/model authority)
 * (#86)", the WORK-064 completion merge via PR #86 — the scope carries the
 * lowercase form GitHub derives from the branch name, so the match is
 * case-insensitive and the binding id is canonicalized to `WORK-NNN`). Two
 * structural exclusions keep state-only subjects out: the scope must be
 * EXACTLY the work-order id (`fix(WORK-052 round 1): …` is a parenthesized
 * branch-commit prefix, not a scope), and the title must NOT name the same
 * work order as a TOPIC (in any letter case) — the architect's merge carries
 * the id exactly ONCE, in the binding position, so a hypothetical
 * `chore(work-064): the WORK-064 post-merge finalization — …` shape (a
 * state-only reconciliation naming its work order) is excluded exactly like
 * every other finalization subject. The actual finalization convention
 * (`chore(governance): …`) is excluded by the scope itself (the word
 * `governance`, never a work-order id). The declared `pr` remains the PR
 * identity for this shape exactly as for the other conventions (ADR-0007):
 * the trailing `(#PR)` stamp is GitHub's squash-merge provenance marker on
 * the PR title.
 */
const CONVENTIONAL_SCOPE_MERGE_SUBJECT_RE = /^[a-z]+\((WORK-\d{3})\): /i;

/**
 * Parse `<sha> <subject>` log lines (the first-parent history of main) into
 * merge evidence. All four merge shapes are recognized; a work order may
 * legitimately appear more than once when the architect ACTUALLY merged it
 * more than once (e.g. the WORK-062 governance correction `9aadd50` followed
 * by the implementation merge `f0855d2`, both under recognized conventions) —
 * the audit matches ANY actual merge commit. A post-merge
 * finalization/state-only commit is NOT a merge: its subject names the work
 * order as a topic (after a `chore(governance): ` prefix, after an article,
 * or without the title-head/scope binding position), so it never enters the
 * evidence (the PR #75 review).
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
    let workOrderId =
      ARCHITECT_MERGE_SUBJECT_RE.exec(subject)?.[1] ??
      GOVERNANCE_MERGE_SUBJECT_RE.exec(subject)?.[1] ??
      null;
    if (workOrderId === null) {
      // The conventional-commit scope shape (the fourth convention): the
      // scope must be EXACTLY the work-order id (any letter case — GitHub
      // derives the lowercase form from the branch name; the binding id is
      // canonicalized to WORK-NNN), and the title must not name the same
      // work order as a topic (in any case) — the id appears exactly once,
      // in the binding position, on the architect's merges.
      const scoped = CONVENTIONAL_SCOPE_MERGE_SUBJECT_RE.exec(subject);
      if (
        scoped !== null &&
        !subject.slice(scoped[0].length).toLowerCase().includes(scoped[1]!.toLowerCase())
      ) {
        workOrderId = scoped[1]!.toUpperCase();
      }
    }
    if (workOrderId !== null) {
      const list = byWorkOrder.get(workOrderId) ?? [];
      list.push(sha);
      byWorkOrder.set(workOrderId, list);
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
