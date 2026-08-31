import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditMergedFinalization,
  collectMergeEvidenceFromLines,
  collectMergeEvidenceFromRepository,
  DefaultDevelopmentGovernanceService,
  type MergeEvidence,
} from '../../../src/development-governance/index.js';
import type { ProgramState } from '../../../src/development-governance/index.js';

/**
 * WORK-052 — the post-merge finalization protocol (§34.8; ADR-0007).
 *
 * The merged-finalization invariant binds the canonical program state to the
 * repository's git merge history: a Work Order with merge evidence MUST be
 * `complete` with a `mergedAs` matching the AUTHORITATIVE merge identity —
 * the ENTIRE identity (the PR number AND the ACTUAL merge commit; the PR #63
 * round-2 review). This suite proves the audit's positive arms and its
 * discriminations (the false state the post-merge review found — PR #62
 * merged as 47615c2 while WORK-052 was still in_flight — can never again pass
 * silently), plus the control-plane wiring (`verifyPostMergeFinalization`)
 * and the REAL repository audit.
 */
describe('WORK-052 — the post-merge finalization audit binds canonical state to git merge history', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const GOVERNANCE_DIR = join(REPO_ROOT, 'spec', 'development-state');

  let realProgram: ProgramState;
  let realService: DefaultDevelopmentGovernanceService;

  beforeAll(async () => {
    const loaded = await DefaultDevelopmentGovernanceService.create({ repoRoot: REPO_ROOT });
    realProgram = JSON.parse(
      readFileSync(join(GOVERNANCE_DIR, 'program-state.json'), 'utf8'),
    ) as ProgramState;
    realService = loaded;
  });

  const evidenceWith = (byPr: Array<[number, string[]]>, byWorkOrder: Array<[string, string[]]> = []): MergeEvidence =>
    ({
      byPr: new Map(byPr),
      byWorkOrder: new Map(byWorkOrder),
    }) as MergeEvidence;

  const SHA_A = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee';
  const SHA_B = '1111111122222222333333334444444455555555';

  it('collects merge evidence from first-parent history lines — ALL FOUR merge shapes (the classic merge commit, the WORK-NNN architect-merge subject convention, the Governance: WORK-NNN — governance-decision squash convention, AND the type(work-NNN): conventional-commit scope convention)', () => {
    const evidence = collectMergeEvidenceFromLines([
      `${SHA_A} Merge pull request #52 from pectoraux/feat/work-051-architecture-governance-checkpoints`,
      `${SHA_B} WORK-052: Development Governance & Self-Hosting Control Plane`,
      'not a sha line at all',
      `${SHA_A.slice(0, 8)} short-sha subjects are not first-parent history lines`,
      'f2c996c26b0a1cdf6b0b946102e4aa669a2847c9 Merge pull request #29 from pectoraux/feat/work-026-project-runtime',
      'e3d0f2b1c4a5968712345678abcdef01234567890 fix(WORK-052 round 1): branch commits with parenthesized prefixes are NOT merge subjects',
      // The governance-decision squash convention (the actual shape the
      // architect used for PR #81 / WORK-063 and PR #80 / the WORK-062
      // governance correction): the work-order id in TITLE-HEAD position
      // after the fixed `Governance: ` prefix, separated by an em-dash.
      `${SHA_A} Governance: WORK-063 — Identity and Access Layer (the identity-and-access architecture decision) (#81)`,
      `${SHA_B} Governance: WORK-062 — Durable Multi-Agent Orchestration Substrate (the execution-substrate architecture decision) (#80)`,
      // The conventional-commit scope convention (the actual shape the
      // architect used for PR #86 / WORK-064, merged as c351451): the
      // work-order id in the SCOPE position — GitHub derives the lowercase
      // form from the branch name — with the title naming the DOMAIN.
      `${SHA_A} feat(work-064): the Continuous Product Validation domain (the domain/model authority) (#86)`,
    ]);
    // The classic merge shape binds by PR number.
    expect(evidence.byPr.get(52)).toEqual([SHA_A]);
    expect(evidence.byPr.get(29)).toEqual(['f2c996c26b0a1cdf6b0b946102e4aa669a2847c9']);
    expect(evidence.byPr.has(62)).toBe(false); // PR #62 merged as a squash — no #62 subject
    // The architect-merge subject conventions bind by work-order id.
    expect(evidence.byWorkOrder.get('WORK-052')).toEqual([SHA_B]);
    expect(evidence.byWorkOrder.get('WORK-063')).toEqual([SHA_A]);
    expect(evidence.byWorkOrder.get('WORK-062')).toEqual([SHA_B]);
    // The scope convention binds by work-order id (canonicalized to
    // WORK-NNN from the lowercase scope).
    expect(evidence.byWorkOrder.get('WORK-064')).toEqual([SHA_A]);
    // Noise is ignored: non-sha lines, short shas, and parenthesized branch
    // prefixes ("fix(WORK-…") are NOT merge evidence.
    expect(evidence.byWorkOrder.has('WORK-051')).toBe(false);
  });

  it('DISCRIMINATION (the WORK-063 finalization — the governance-decision shape): a post-merge FINALIZATION/state-only commit is NOT governance merge evidence — neither the chore(governance) topic shape NOR a governance subject that names the work order after an article', () => {
    // The actual finalization shapes on this repository's history: the
    // WORK-062 finalization `46e7858` ("chore(governance): the WORK-062
    // post-merge finalization — … (#83)") and the WORK-052 finalization
    // `1ccc45f`. Neither may ever be classified as merge evidence — the
    // discriminating features of the true governance merge
    // (`Governance: WORK-NNN — title (#PR)`, the id in TITLE-HEAD position)
    // are structurally absent: the finalization carries the
    // `chore(governance): ` prefix and names the work order as a TOPIC after
    // an article ("the WORK-063 post-merge finalization").
    const FINALIZATION_SHA = '25e5f1f2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';
    const MERGE_SHA = '8dac9c47f7397e22765478520ac71659d37e1783';
    const evidence = collectMergeEvidenceFromLines([
      `${FINALIZATION_SHA} chore(governance): the WORK-063 post-merge finalization (§34.8/ADR-0007) — the canonical state reconciled with the 8dac9c4 merge (#85)`,
      // The governance prefix with the id demoted to a topic after an
      // article is EQUALLY not evidence (the title head is the work order
      // id on true merges, never an article).
      `${SHA_A} Governance: the WORK-063 post-merge finalization — state-only reconciliation`,
      `${SHA_B} Governance: WORK-063 post-merge finalization (§34.8/ADR-0007) — canonical state only`,
      `${MERGE_SHA} Governance: WORK-063 — Identity and Access Layer (the identity-and-access architecture decision) (#81)`,
    ]);
    // The architect's ACTUAL merge is evidence; the finalization shapes are
    // NOT — exact equality, so no extra candidate can hide in the list.
    expect(evidence.byWorkOrder.get('WORK-063')).toEqual([MERGE_SHA]);
    expect(evidence.byWorkOrder.get('WORK-063')).not.toContain(FINALIZATION_SHA);
    // AUDIT-LEVEL proof: a history containing ONLY the finalization commit
    // does NOT bind WORK-063 as merged — a state-only reconciliation is not
    // a completion event and can never satisfy (or violate) the
    // merged-finalization invariant.
    const finalizationOnly = collectMergeEvidenceFromLines([
      `${FINALIZATION_SHA} chore(governance): the WORK-063 post-merge finalization (§34.8/ADR-0007) — the canonical state reconciled with the 8dac9c4 merge (#85)`,
    ]);
    const audit = auditMergedFinalization(realProgram, finalizationOnly);
    expect(audit.mergedWorkOrderIds).not.toContain('WORK-063');
    expect(audit.gaps).toEqual([]);
  });

  it('DISCRIMINATION (the WORK-064 finalization — the conventional-commit scope shape): a post-merge FINALIZATION/state-only commit is NOT scope-convention merge evidence — neither the chore(governance) topic shape NOR a work-order-scoped subject whose title names the work order as a topic', () => {
    // The finalization shapes that must never classify as the fourth merge
    // shape: the actual finalization convention `chore(governance): the
    // WORK-064 post-merge finalization — … (#PR)` (the scope is the word
    // `governance`, never a work-order id), and the hypothetical misshape
    // `chore(work-064): the WORK-064 post-merge finalization — …` (the
    // scope IS a work-order id, but the title names the SAME work order as
    // a topic — the architect's merges carry the id exactly ONCE, in the
    // binding position, and name the DOMAIN in the title). A parenthesized
    // branch-commit prefix (`fix(WORK-052 round 1): …`) is equally excluded
    // (the scope is not exactly a work-order id).
    const FINALIZATION_SHA = '35e5f1f2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';
    const MIS_SCOPED_FINALIZATION_SHA = '36e6f1f2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f9';
    const MERGE_SHA = 'c3514512cb5bcf7694f551d1f1bac9b1ee2d3c3b';
    const evidence = collectMergeEvidenceFromLines([
      `${FINALIZATION_SHA} chore(governance): the WORK-064 post-merge finalization (§34.8/ADR-0007) — the canonical state reconciled with the c351451 merge (#87)`,
      `${MIS_SCOPED_FINALIZATION_SHA} chore(work-064): the WORK-064 post-merge finalization — state-only reconciliation`,
      `${SHA_A} fix(work-052 round 1): branch commits with parenthesized prefixes are NOT merge subjects`,
      // The architect's ACTUAL merge (the fourth shape): the id in the scope
      // exactly once, the title naming the domain.
      `${MERGE_SHA} feat(work-064): the Continuous Product Validation domain (the domain/model authority) (#86)`,
    ]);
    // Only the architect's ACTUAL merge is evidence — exact equality, so no
    // extra candidate can hide in the list.
    expect(evidence.byWorkOrder.get('WORK-064')).toEqual([MERGE_SHA]);
    expect(evidence.byWorkOrder.get('WORK-064')).not.toContain(FINALIZATION_SHA);
    expect(evidence.byWorkOrder.get('WORK-064')).not.toContain(MIS_SCOPED_FINALIZATION_SHA);
    expect(evidence.byWorkOrder.has('WORK-052')).toBe(false);
    // AUDIT-LEVEL proof: a history containing ONLY the finalization shapes
    // does NOT bind WORK-064 as merged — a state-only reconciliation is not
    // a completion event and can never satisfy (or violate) the
    // merged-finalization invariant.
    const finalizationOnly = collectMergeEvidenceFromLines([
      `${FINALIZATION_SHA} chore(governance): the WORK-064 post-merge finalization (§34.8/ADR-0007) — the canonical state reconciled with the c351451 merge (#87)`,
      `${MIS_SCOPED_FINALIZATION_SHA} chore(work-064): the WORK-064 post-merge finalization — state-only reconciliation`,
    ]);
    const audit = auditMergedFinalization(realProgram, finalizationOnly);
    expect(audit.mergedWorkOrderIds).not.toContain('WORK-064');
    expect(audit.gaps).toEqual([]);
  });

  it('DISCRIMINATION (the PR #75 review — evidence classification): a post-merge FINALIZATION/state-only commit beginning with WORK-NNN is NOT merge evidence — the 1ccc45f conflation can never recur', () => {
    // The real-world defect: the WORK-052 post-merge finalization commit
    // 1ccc45f ("WORK-052 post-merge corrective finalization — … (#63)", the
    // squash of PR #63 — a STATE-ONLY change reconciling the canonical state
    // after the merge) was classified as a SECOND merge-evidence commit for
    // WORK-052 by the loose `^WORK-NNN\b` subject matcher. Merge evidence is
    // the architect's ACTUAL merge (47615c2), never the finalization that
    // reconciles state after it: the very commit that established the
    // finalization protocol was being misclassified as merge evidence for
    // its own work order — a provenance/audit-model defect, not a stale
    // expected-value pin.
    const FINALIZATION_SHA = '1ccc45ff926331c0b4bd161a11bb28a7182c6146';
    const MERGE_SHA = '47615c236ec0e194e112efd3d2ef0f432c4bf210';
    const finalizationSubject =
      'WORK-052 post-merge corrective finalization — the canonical state reconciled with the 47615c2 merge, ' +
      'the post-merge finalization protocol (§34.8/ADR-0007), the detector corrected to ADR-0006 (#63)';
    const evidence = collectMergeEvidenceFromLines([
      `${FINALIZATION_SHA} ${finalizationSubject}`,
      `${MERGE_SHA} WORK-052: Development Governance & Self-Hosting Control Plane`,
      // Generic state-only shapes — any subject naming the work order as a
      // topic WITHOUT the colon convention — are equally not evidence.
      `${SHA_A} WORK-052 post-merge finalization — state-only reconciliation`,
      `${SHA_B} WORK-046 post-merge corrective finalization — canonical state only`,
      `${SHA_A} WORK-052 finalization`,
    ]);
    // The architect's ACTUAL merge is evidence; the finalization commit is
    // NOT — exact equality, so no extra candidate can hide in the list.
    expect(evidence.byWorkOrder.get('WORK-052')).toEqual([MERGE_SHA]);
    expect(evidence.byWorkOrder.get('WORK-052')).not.toContain(FINALIZATION_SHA);
    expect(evidence.byWorkOrder.has('WORK-046')).toBe(false);
    // AUDIT-LEVEL proof: a history containing ONLY the finalization commit
    // does NOT bind the work order as merged — under the loose matcher this
    // exact history would have bound WORK-052 ([1ccc45f]) and reported a
    // FALSE "mergedAs.mergeCommit does not match the actual merge evidence"
    // gap against the truthful 47615c2 record. A state-only reconciliation
    // is not a completion event and can never satisfy (or violate) the
    // merged-finalization invariant.
    const finalizationOnly = collectMergeEvidenceFromLines([
      `${FINALIZATION_SHA} ${finalizationSubject}`,
    ]);
    const audit = auditMergedFinalization(realProgram, finalizationOnly);
    expect(audit.mergedWorkOrderIds).not.toContain('WORK-052');
    expect(audit.mergedWorkOrderIds).toEqual([]);
    expect(audit.gaps).toEqual([]);
  });

  it('the POSITIVE arm: a finalized work order (complete + mergedAs matching the actual merge evidence, full or short form) audits clean', () => {
    const program = structuredClone(realProgram);
    const evidence = evidenceWith([[62, ['47615c236ec0e194e112efd3d2ef0f432c4bf210']]]);
    const audit = auditMergedFinalization(program, evidence);
    // WORK-052 carries pr 62 → bound by PR evidence → complete + matching.
    expect(audit.mergedWorkOrderIds).toEqual(['WORK-052']);
    expect(audit.gaps).toEqual([]);
    // The short-hash form (the historical convention, e.g. WORK-051's
    // 'f2c996c') matches by prefix.
    const shortForm = structuredClone(realProgram);
    shortForm.workOrders.find((w) => w.id === 'WORK-052')!.mergedAs = { pr: 62, mergeCommit: '47615c2' };
    expect(auditMergedFinalization(shortForm, evidence).gaps).toEqual([]);
    // And a synthetic sha binds a synthetic finalization just as well.
    const synthetic = structuredClone(realProgram);
    synthetic.workOrders.find((w) => w.id === 'WORK-052')!.mergedAs = { pr: 62, mergeCommit: SHA_A };
    expect(auditMergedFinalization(synthetic, evidenceWith([[62, [SHA_A]]])).gaps).toEqual([]);
  });

  it('DISCRIMINATION (post-merge correction, BLOCKER 1): a MERGED work order still in_flight is a GAP — never a silent pass', () => {
    // The exact false state the post-merge review found: the merge evidence
    // exists in history while the canonical status is still in_flight.
    const program = structuredClone(realProgram);
    const w052 = program.workOrders.find((w) => w.id === 'WORK-052')!;
    w052.status = 'in_flight';
    delete (w052 as { mergedAs?: unknown }).mergedAs;
    const evidence = evidenceWith([[62, ['47615c236ec0e194e112efd3d2ef0f432c4bf210']]]);
    const audit = auditMergedFinalization(program, evidence);
    expect(audit.gaps.length).toBe(1);
    expect(audit.gaps[0]).toMatch(/WORK-052.*MERGED/);
    expect(audit.gaps[0]).toMatch(/in_flight/);
    expect(audit.gaps[0]).toMatch(/post-merge finalization protocol/);
  });

  it('DISCRIMINATION (post-merge correction, BLOCKER 1): a complete work order whose mergedAs does NOT match the actual merge evidence is a GAP', () => {
    const program = structuredClone(realProgram);
    program.workOrders.find((w) => w.id === 'WORK-052')!.mergedAs = {
      pr: 62,
      mergeCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    };
    const evidence = evidenceWith([[62, ['47615c236ec0e194e112efd3d2ef0f432c4bf210']]]);
    const gaps = auditMergedFinalization(program, evidence).gaps;
    expect(gaps.length).toBe(1);
    expect(gaps[0]).toMatch(/does not match the actual merge evidence/);
    expect(gaps[0]).toContain('47615c2');
  });

  it('DISCRIMINATION (the PR #63 round-2 review — the provenance identity): a FALSE mergedAs.pr — a different PR number with the REAL merge commit intact — is a GAP (the PR number is part of the durable provenance claim, VALIDATED not merely stored)', () => {
    // The exact provenance defect the round-2 review found: the audit
    // validated only mergedAs.mergeCommit, so a record claiming pr 999
    // alongside the GENUINE merge commit audited clean. mergedAs must match
    // the AUTHORITATIVE merge identity — the authoritative pair for a bound
    // work order is (workOrderId, prNumber, mergeCommit); for the WORK-NNN
    // convention the declared pr remains the PR identity, so mergedAs.pr
    // must equal w.pr in addition to the commit matching.
    const program = structuredClone(realProgram);
    program.workOrders.find((w) => w.id === 'WORK-052')!.mergedAs = {
      pr: 999,
      mergeCommit: '47615c236ec0e194e112efd3d2ef0f432c4bf210',
    };
    // The REAL evidence: the WORK-NNN squash binds WORK-052 while the record
    // declares pr 62 — the authoritative PR identity.
    const evidence = collectMergeEvidenceFromRepository(REPO_ROOT);
    const gaps = auditMergedFinalization(program, evidence).gaps;
    expect(gaps.length).toBe(1);
    expect(gaps[0]).toMatch(/does not match the authoritative PR identity/);
    expect(gaps[0]).toContain('999');
    expect(gaps[0]).toContain('62');
    // The classic-merge shape discriminates identically (the evidence binds
    // byPr through the SAME declared pr).
    const byPrGaps = auditMergedFinalization(
      structuredClone(program),
      evidenceWith([[62, ['47615c236ec0e194e112efd3d2ef0f432c4bf210']]]),
    ).gaps;
    expect(byPrGaps.length).toBe(1);
    expect(byPrGaps[0]).toMatch(/does not match the authoritative PR identity/);
  });

  it('DISCRIMINATION (the PR #63 round-2 review — fail closed): a WORK-NNN-merged work order that declares NO pr cannot anchor its mergedAs.pr provenance claim — a GAP', () => {
    // Dropping the declared pr would otherwise bypass the PR-identity check
    // entirely (any number could hide in mergedAs.pr); an unanchorable claim
    // fails closed.
    const program = structuredClone(realProgram);
    const w052 = program.workOrders.find((w) => w.id === 'WORK-052')!;
    delete (w052 as { pr?: number }).pr;
    const evidence = evidenceWith([], [['WORK-052', ['47615c236ec0e194e112efd3d2ef0f432c4bf210']]]);
    const gaps = auditMergedFinalization(program, evidence).gaps;
    expect(gaps.length).toBe(1);
    expect(gaps[0]).toMatch(/no authoritative PR identity/);
    expect(gaps[0]).toMatch(/fail closed/);
  });

  it('DISCRIMINATION: an in-flight work order with NO merge evidence is NOT a gap (the invariant binds merged work only — no false positives)', () => {
    // WORK-046 is in_flight with PR #60 OPEN: no evidence for 60 → no gap.
    const evidence = evidenceWith([[62, ['47615c236ec0e194e112efd3d2ef0f432c4bf210']]]);
    const audit = auditMergedFinalization(realProgram, evidence);
    expect(audit.mergedWorkOrderIds).toEqual(['WORK-052']);
    expect(audit.gaps).toEqual([]);
  });

  it('a work order the architect ACTUALLY merged more than once (e.g. an implementation merge followed by a corrective re-merge under the SAME convention) audits clean when mergedAs matches ANY actual merge commit', () => {
    // Multiple evidence entries are legitimate only for multiple ACTUAL
    // architect merges — a post-merge finalization/state-only squash is NOT
    // among them (see the PR #75 review discrimination above: it never
    // enters the evidence at all).
    const evidence = evidenceWith([], [['WORK-052', ['47615c236ec0e194e112efd3d2ef0f432c4bf210', SHA_B]]]);
    // mergedAs records the IMPLEMENTATION merge (the completion event).
    const audit = auditMergedFinalization(realProgram, evidence);
    expect(audit.mergedWorkOrderIds).toEqual(['WORK-052']);
    expect(audit.gaps).toEqual([]);
  });

  it('the control plane exposes the audit: verifyPostMergeFinalization reports gaps through the service (the CLI prints them; never swallows)', () => {
    // Real loaded state + synthetic evidence binding PR #60 (WORK-046's OPEN
    // PR): if PR #60 were merged while WORK-046 stayed in_flight, the audit
    // reports the gap through the SAME service the CLI uses.
    const report = realService.verifyPostMergeFinalization(evidenceWith([[60, [SHA_A]]]));
    expect(report.merged).toBe(1);
    expect(report.finalized).toBe(0);
    expect(report.gaps.length).toBe(1);
    expect(report.gaps[0]).toMatch(/WORK-046/);
    expect(report.evidenceSource).toBe('explicit merge evidence');
    // The finalized truth with the REAL history: no gaps.
    const real = realService.verifyPostMergeFinalization();
    expect(real.gaps).toEqual([]);
    expect(real.finalized).toBe(real.merged);
    expect(real.evidenceSource).toMatch(/first-parent merge history/);
  });

  it('the REAL repository audits clean — the drift the post-merge review found is closed (WORK-052: merged 47615c2, finalized complete with the full provenance identity)', () => {
    const evidence = collectMergeEvidenceFromRepository(REPO_ROOT);
    // The real history binds WORK-052 through the WORK-NNN colon convention —
    // EXACTLY the architect's actual merge. The WORK-052 post-merge
    // finalization commit 1ccc45f (also in the real first-parent history,
    // subject "WORK-052 post-merge corrective finalization — …") is NOT
    // evidence: the exact-equality assertion is the discriminating proof
    // that the conflation is gone on the REAL repository (no expected-SHA
    // re-pinning — the matcher now classifies the truth this always asserted).
    expect(evidence.byWorkOrder.get('WORK-052')).toEqual(['47615c236ec0e194e112efd3d2ef0f432c4bf210']);
    // …and WORK-051 through the classic merge shape (its declared pr 52) —
    // BOTH shapes audit clean with their full mergedAs identities.
    expect(evidence.byPr.get(52)).toEqual(['f2c996c26b0a1cdf6b0b946102e4aa669a2847c9']);
    // WORK-062 (the 2026-08-30 merge): the real history binds it through the
    // WORK-NNN colon convention — the architect's actual implementation
    // merge f0855d2 (PR #82, squash-merged at branch head 1caa259) — AND
    // through the governance-decision convention at 9aadd50 (PR #80, the
    // governance correction that issued WORK-062): BOTH are actual
    // architect merges of WORK-062 identity content, and the audit
    // matches ANY actual merge commit (mergedAs records the completion
    // event f0855d2). The WORK-062 post-merge FINALIZATION commit (subject
    // "chore(governance): the WORK-062 post-merge finalization — …") never
    // enters the evidence: only the architect's merges bind WORK-062.
    expect(evidence.byWorkOrder.get('WORK-062')).toEqual([
      'f0855d2955dcf2d3edea683e497902ad30778fc8',
      '9aadd5088dfcf871a4801e26cc3a5fbd02076ffc',
    ]);
    expect(evidence.byPr.has(82)).toBe(false); // the squash merges bind by work-order id, not PR subject
    // WORK-063 (the 2026-08-30 identity-and-access architecture decision):
    // the actual architect merge 8dac9c4 (PR #81, subject "Governance:
    // WORK-063 — Identity and Access Layer (…) (#81)", squash-merged at
    // branch head f86d1f2) binds EXACTLY — the governance-decision shape
    // the audit must recognize (the WORK-063 finalization's narrow detector
    // correction). The subsequent WORK-063 post-merge FINALIZATION squash
    // ("chore(governance): the WORK-063 post-merge finalization — …") is
    // structurally excluded and NEVER enters this evidence.
    expect(evidence.byWorkOrder.get('WORK-063')).toEqual(['8dac9c47f7397e22765478520ac71659d37e1783']);
    // WORK-064 (the 2026-08-30 continuous product validation domain/model
    // authority): the actual architect merge c351451 (PR #86, subject
    // "feat(work-064): the Continuous Product Validation domain (the
    // domain/model authority) (#86)", squash-merged at the approved head
    // 524c3f4 — the tree is identical) binds EXACTLY — the conventional-
    // commit scope shape the audit must recognize (the WORK-064 finalization's
    // narrow detector correction, the FOURTH merge-evidence shape). The
    // subsequent WORK-064 post-merge FINALIZATION squash
    // ("chore(governance): the WORK-064 post-merge finalization — …") is
    // structurally excluded and NEVER enters this evidence.
    expect(evidence.byWorkOrder.get('WORK-064')).toEqual(['c3514512cb5bcf7694f551d1f1bac9b1ee2d3c3b']);
    expect(evidence.byPr.has(86)).toBe(false); // the squash merge binds by work-order id, not PR subject
    // WORK-065 (the 2026-08-31 synthetic browser validation agent — the
    // execution mechanism, NOT an authority): the actual architect merge
    // 5de5e83 (PR #97, subject "feat(work-065): Synthetic Browser Validation
    // Agent (the execution mechanism, not authority) (#97)", squash-merged
    // at the approved head c06a3e3 — the post-#100 reconciliation head, the
    // tree identical) binds EXACTLY — the conventional-commit scope shape
    // (recognized since the WORK-064 finalization; the title names the
    // DOMAIN and never the work order). The subsequent WORK-065 post-merge
    // FINALIZATION squash ("chore(governance): the WORK-065 post-merge
    // finalization — …") is structurally excluded and NEVER enters this
    // evidence (pinned by the WORK-065 finalization's discrimination test).
    expect(evidence.byWorkOrder.get('WORK-065')).toEqual(['5de5e83ac9a3ce2c1613a7b8b83045d0ab1d8916']);
    expect(evidence.byPr.has(97)).toBe(false); // the squash merge binds by work-order id, not PR subject
    // WORK-066 (the 2026-08-31 validation scheduling & change-triggers
    // DECISION layer): the actual architect merge 0a506b1 (PR #102, subject
    // "feat(work-066): Validation Scheduling & Change Triggers (the
    // scheduling/trigger DECISION layer, not an authority) (#102)",
    // squash-merged at the approved head 493ae59 — the tree identical) binds
    // EXACTLY — the conventional-commit scope shape (recognized since the
    // WORK-064 finalization; the title names the DOMAIN and never the work
    // order). The subsequent WORK-066 post-merge FINALIZATION squash
    // ("chore(governance): the WORK-066 post-merge finalization — …") is
    // structurally excluded and NEVER enters this evidence (pinned by the
    // WORK-066 finalization's discrimination test).
    expect(evidence.byWorkOrder.get('WORK-066')).toEqual(['0a506b10e5526151929366bb11197230334b620c']);
    expect(evidence.byPr.has(102)).toBe(false); // the squash merge binds by work-order id, not PR subject
    // WORK-067 (the 2026-08-31 engineering signal & regression correlation —
    // the ADVISORY correlation layer): the actual architect merge bde33cc
    // (PR #103, subject "feat(work-067): Engineering Signal & Regression
    // Correlation (the ADVISORY correlation layer, not an authority)
    // (#103)", squash-merged at the approved head 0fe9c48 — the post-#104
    // reconciliation head, the tree identical) binds EXACTLY — the
    // conventional-commit scope shape (recognized since the WORK-064
    // finalization; the title names the DOMAIN and never the work order).
    // The subsequent WORK-067 post-merge FINALIZATION squash
    // ("chore(governance): the WORK-067 post-merge finalization — …") is
    // structurally excluded and NEVER enters this evidence (pinned by the
    // WORK-067 finalization's discrimination test below).
    expect(evidence.byWorkOrder.get('WORK-067')).toEqual(['bde33cc5e9a1b109951be9ec48aaef7e692c33c7']);
    expect(evidence.byPr.has(103)).toBe(false); // the squash merge binds by work-order id, not PR subject
    const audit = auditMergedFinalization(realProgram, evidence);
    expect(audit.gaps).toEqual([]);
    expect(audit.mergedWorkOrderIds).toContain('WORK-052');
    expect(audit.mergedWorkOrderIds).toContain('WORK-051');
    // The WORK-062 finalization closed the red window the merge opened:
    // complete + mergedAs {pr: 82, mergeCommit: f0855d2…} audits clean.
    expect(audit.mergedWorkOrderIds).toContain('WORK-062');
    // The WORK-063 finalization closes ITS red window the same way: the
    // complete record with mergedAs {pr: 81, mergeCommit: 8dac9c4…} audits
    // clean against the actual governance-decision merge.
    expect(audit.mergedWorkOrderIds).toContain('WORK-063');
    // The WORK-064 finalization closes ITS red window: the complete record
    // with mergedAs {pr: 86, mergeCommit: c351451…} audits clean against the
    // actual conventional-commit scope merge.
    expect(audit.mergedWorkOrderIds).toContain('WORK-064');
    // The WORK-065 finalization closes ITS red window the same way: the
    // complete record with mergedAs {pr: 97, mergeCommit: 5de5e83…} audits
    // clean against the actual conventional-commit scope merge (this was
    // the live red window between the PR #97 merge and the WORK-065
    // finalization — the audit reported exactly this gap, 12/13 finalized).
    expect(audit.mergedWorkOrderIds).toContain('WORK-065');
    // The WORK-066 finalization closes ITS red window the same way: the
    // complete record with mergedAs {pr: 102, mergeCommit: 0a506b10…} audits
    // clean against the actual conventional-commit scope merge (this was
    // the live red window between the PR #102 merge and the WORK-066
    // finalization — the audit reported exactly this gap, 13/14 finalized).
    expect(audit.mergedWorkOrderIds).toContain('WORK-066');
    const w066 = realProgram.workOrders.find((w) => w.id === 'WORK-066')!;
    expect(w066.status).toBe('complete');
    expect(w066.mergedAs).toEqual({ pr: 102, mergeCommit: '0a506b10e5526151929366bb11197230334b620c' });
    // DISCRIMINATION (in memory, the REAL evidence): the exact false state
    // the finalization exists to prevent — WORK-066 merged (0a506b1) while
    // still represented as in_flight — is DETECTED on the real history (this
    // was the live red window between the PR #102 merge and this
    // finalization; reproduced and recorded by the finalization's own
    // verification run: governance:status exit 1, 13/14 finalized, the GAP
    // below verbatim).
    const unfinalized066 = structuredClone(realProgram);
    const mutated066 = unfinalized066.workOrders.find((w) => w.id === 'WORK-066')!;
    mutated066.status = 'in_flight';
    delete (mutated066 as { mergedAs?: unknown }).mergedAs;
    const gaps066 = auditMergedFinalization(unfinalized066, evidence).gaps;
    expect(gaps066.join('\n')).toMatch(/WORK-066.*MERGED/);
    expect(gaps066.join('\n')).toContain('0a506b10e');
    expect(gaps066.join('\n')).toMatch(/post-merge finalization protocol/);
    // DISCRIMINATION (the PR identity, the PR #63 round-2 rule): a complete
    // WORK-066 record whose mergedAs.pr is not the authoritative PR identity
    // (102) is DETECTED — the PR number is validated, not stored.
    const falsePr066 = structuredClone(realProgram);
    falsePr066.workOrders.find((w) => w.id === 'WORK-066')!.mergedAs = {
      pr: 999,
      mergeCommit: '0a506b10e5526151929366bb11197230334b620c',
    };
    expect(
      auditMergedFinalization(falsePr066, evidence).gaps.join('\n'),
    ).toMatch(/does not match the authoritative PR identity/);
    // DISCRIMINATION (a false merge commit): a complete WORK-066 record
    // whose mergedAs.mergeCommit is NOT the actual merge evidence is
    // DETECTED (a fabricated SHA cannot fabricate completion).
    const falseSha066 = structuredClone(realProgram);
    falseSha066.workOrders.find((w) => w.id === 'WORK-066')!.mergedAs = {
      pr: 102,
      mergeCommit: 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
    };
    expect(
      auditMergedFinalization(falseSha066, evidence).gaps.join('\n'),
    ).toMatch(/does not match the actual merge evidence/);
    const w064 = realProgram.workOrders.find((w) => w.id === 'WORK-064')!;
    expect(w064.status).toBe('complete');
    expect(w064.mergedAs).toEqual({ pr: 86, mergeCommit: 'c3514512cb5bcf7694f551d1f1bac9b1ee2d3c3b' });
    // DISCRIMINATION (in memory, the REAL evidence): the exact false state
    // the finalization exists to prevent — WORK-064 merged (c351451) while
    // still represented as in_flight — is DETECTED on the real history (this
    // is the red window the fourth-shape correction opens between the merge
    // and this finalization; under the pre-correction collector it was
    // fail-open INVISIBLE — the exact blindness ADR-0007's amendment
    // describes).
    const unfinalized064 = structuredClone(realProgram);
    const mutated064 = unfinalized064.workOrders.find((w) => w.id === 'WORK-064')!;
    mutated064.status = 'in_flight';
    delete (mutated064 as { mergedAs?: unknown }).mergedAs;
    const gaps064 = auditMergedFinalization(unfinalized064, evidence).gaps;
    expect(gaps064.join('\n')).toMatch(/WORK-064.*MERGED/);
    expect(gaps064.join('\n')).toContain('c3514512');
    expect(gaps064.join('\n')).toMatch(/post-merge finalization protocol/);
    // DISCRIMINATION (the PR identity, the PR #63 round-2 rule): a complete
    // WORK-064 record whose mergedAs.pr is not the authoritative PR
    // identity (86) is DETECTED — the PR number is validated, not stored.
    const falsePr064 = structuredClone(realProgram);
    falsePr064.workOrders.find((w) => w.id === 'WORK-064')!.mergedAs = {
      pr: 999,
      mergeCommit: 'c3514512cb5bcf7694f551d1f1bac9b1ee2d3c3b',
    };
    expect(
      auditMergedFinalization(falsePr064, evidence).gaps.join('\n'),
    ).toMatch(/does not match the authoritative PR identity/);
    const w063 = realProgram.workOrders.find((w) => w.id === 'WORK-063')!;
    expect(w063.status).toBe('complete');
    expect(w063.mergedAs).toEqual({ pr: 81, mergeCommit: '8dac9c47f7397e22765478520ac71659d37e1783' });
    // DISCRIMINATION (in memory, the REAL evidence): the exact false state
    // the finalization exists to prevent — WORK-063 merged (8dac9c4) while
    // still represented as in_flight — is DETECTED on the real history.
    const unfinalized063 = structuredClone(realProgram);
    const mutated063 = unfinalized063.workOrders.find((w) => w.id === 'WORK-063')!;
    mutated063.status = 'in_flight';
    delete (mutated063 as { mergedAs?: unknown }).mergedAs;
    const gaps063 = auditMergedFinalization(unfinalized063, evidence).gaps;
    expect(gaps063.join('\n')).toMatch(/WORK-063.*MERGED/);
    expect(gaps063.join('\n')).toContain('8dac9c47');
    expect(gaps063.join('\n')).toMatch(/post-merge finalization protocol/);
    // DISCRIMINATION (the PR identity, the PR #63 round-2 rule): a complete
    // WORK-063 record whose mergedAs.pr is not the authoritative PR
    // identity (81) is DETECTED — the PR number is validated, not stored.
    const falsePr063 = structuredClone(realProgram);
    falsePr063.workOrders.find((w) => w.id === 'WORK-063')!.mergedAs = {
      pr: 999,
      mergeCommit: '8dac9c47f7397e22765478520ac71659d37e1783',
    };
    expect(
      auditMergedFinalization(falsePr063, evidence).gaps.join('\n'),
    ).toMatch(/does not match the authoritative PR identity/);
  });

  it('DISCRIMINATION (the WORK-074 finalization — the scope shape binds the RUNTIME work order, NEVER the SPEC it names as a topic): the real history binds WORK-074 ↔ PR #99 ↔ cdedd0ca and does NOT bind WORK-063 through the WORK-074 merge subject; state-only finalization subjects stay excluded', () => {
    // The actual WORK-074 architect merge (PR #99, squash-merged at the
    // approved head 25512f4 on 2026-08-31T05:08:54Z) carries the subject
    // "feat(work-074): Identity & Access Runtime Activation — the WORK-063
    // RUNTIME (human login, server-side sessions, scoped machine identity,
    // the demo-key retirement) (#99)" — the FOURTH shape (the work-order id
    // in the SCOPE position), with a title that names WORK-063 as the SPEC
    // being implemented. The binding position is the scope: the commit is
    // WORK-074's merge evidence — and precisely BECAUSE the binding is the
    // scope, the WORK-063 mention in the title (topic position) must NOT
    // bind WORK-063: WORK-063's merge evidence remains EXACTLY its own
    // governance-decision merge (8dac9c4, PR #81). The audit-level identity:
    // WORK-074 ↔ PR #99 ↔ cdedd0ca on the real first-parent history.
    const evidence = collectMergeEvidenceFromRepository(REPO_ROOT);
    const WORK_074_MERGE = 'cdedd0ca3c72821d289d8d9d683f9902ddca480f';
    const WORK_071_MERGE = '8604c8a5286b7533caf907c25fcd4dfdeeb662eb';
    // EXACT equality — the scope shape binds the WORK-074 merge, and nothing
    // else (no state-only commit) hides in the evidence list.
    expect(evidence.byWorkOrder.get('WORK-074')).toEqual([WORK_074_MERGE]);
    // The WORK-071 merge (PR #96, subject "feat(work-071): the Local
    // Development Runtime Substrate — … (#96)") binds EXACTLY the same way.
    expect(evidence.byWorkOrder.get('WORK-071')).toEqual([WORK_071_MERGE]);
    // THE SPEC/RUNTIME DISCRIMINATION: the WORK-074 merge subject NAMES
    // WORK-063 ("the WORK-063 RUNTIME") — and WORK-063's evidence must
    // remain EXACTLY its own merge. Exact equality proves the WORK-074 merge
    // (and the WORK-074 finalization commit, once on main) can never leak
    // into WORK-063's evidence.
    expect(evidence.byWorkOrder.get('WORK-063')).toEqual(['8dac9c47f7397e22765478520ac71659d37e1783']);
    expect(evidence.byWorkOrder.get('WORK-063')!).not.toContain(WORK_074_MERGE);
    // Squash merges bind by work-order id, not PR subject: PR #99 and #96
    // have NO "Merge pull request" subject on the first-parent chain.
    expect(evidence.byPr.has(99)).toBe(false);
    expect(evidence.byPr.has(96)).toBe(false);
    // COLLECTOR-LEVEL exclusion of the state-only finalization subjects: the
    // actual finalization convention `chore(governance): the WORK-074
    // post-merge finalization — … (#PR)` (scope = the word `governance`) and
    // the hypothetical mis-scoped `chore(work-074): the WORK-074 post-merge
    // finalization — …` (the title names the SAME work order as a topic —
    // the id must appear exactly once, in the binding position) NEVER enter
    // the evidence.
    const finalizationOnly = collectMergeEvidenceFromLines([
      '4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e chore(governance): the WORK-074 post-merge finalization (§34.8/ADR-0007) — the canonical state reconciled with the cdedd0ca merge (#100)',
      '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f chore(work-074): the WORK-074 post-merge finalization — state-only reconciliation',
      '6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a Governance: the WORK-074 post-merge finalization — state-only reconciliation',
      '7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b WORK-074 post-merge finalization — state-only reconciliation',
    ]);
    expect(finalizationOnly.byWorkOrder.has('WORK-074')).toBe(false);
    expect(finalizationOnly.byWorkOrder.has('WORK-063')).toBe(false);
    // AUDIT-LEVEL proof: a history containing ONLY the finalization shapes
    // does NOT bind WORK-074 (or WORK-063) as merged — a state-only
    // reconciliation is not a completion event and can never satisfy (or
    // violate) the merged-finalization invariant.
    const auditFinalizationOnly = auditMergedFinalization(realProgram, finalizationOnly);
    expect(auditFinalizationOnly.mergedWorkOrderIds).not.toContain('WORK-074');
    expect(auditFinalizationOnly.mergedWorkOrderIds).not.toContain('WORK-063');
    expect(auditFinalizationOnly.gaps).toEqual([]);
    // The REAL program (post-finalization): WORK-074 is complete with the
    // FULL provenance identity — mergedAs {pr: 99, mergeCommit: cdedd0ca…} —
    // and the real history audits clean (the finalization closed the red
    // window the merge opened).
    const audit = auditMergedFinalization(realProgram, evidence);
    expect(audit.gaps).toEqual([]);
    expect(audit.mergedWorkOrderIds).toContain('WORK-071');
    expect(audit.mergedWorkOrderIds).toContain('WORK-074');
    const w074 = realProgram.workOrders.find((w) => w.id === 'WORK-074')!;
    expect(w074.status).toBe('complete');
    expect(w074.mergedAs).toEqual({ pr: 99, mergeCommit: WORK_074_MERGE });
    // DISCRIMINATION (in memory, the REAL evidence): the exact false state
    // the finalization exists to prevent — WORK-074 merged (cdedd0ca) while
    // still represented as in_flight — is DETECTED on the real history (this
    // was the live red window between the PR #99 merge and this
    // finalization: the audit reported exactly this gap, 11/12 finalized).
    const unfinalized074 = structuredClone(realProgram);
    const mutated074 = unfinalized074.workOrders.find((w) => w.id === 'WORK-074')!;
    mutated074.status = 'in_flight';
    delete (mutated074 as { mergedAs?: unknown }).mergedAs;
    const gaps074 = auditMergedFinalization(unfinalized074, evidence).gaps;
    expect(gaps074.join('\n')).toMatch(/WORK-074.*MERGED/);
    expect(gaps074.join('\n')).toContain('cdedd0ca3');
    expect(gaps074.join('\n')).toMatch(/post-merge finalization protocol/);
    // DISCRIMINATION (the PR identity, the PR #63 round-2 rule): a complete
    // WORK-074 record whose mergedAs.pr is not the authoritative PR identity
    // (99) is DETECTED — the PR number is validated, not stored.
    const falsePr074 = structuredClone(realProgram);
    falsePr074.workOrders.find((w) => w.id === 'WORK-074')!.mergedAs = {
      pr: 999,
      mergeCommit: WORK_074_MERGE,
    };
    expect(
      auditMergedFinalization(falsePr074, evidence).gaps.join('\n'),
    ).toMatch(/does not match the authoritative PR identity/);
    // …and the same full identity holds for WORK-071 (complete since the
    // PR #99 reconciliation recorded it).
    const w071 = realProgram.workOrders.find((w) => w.id === 'WORK-071')!;
    expect(w071.status).toBe('complete');
    expect(w071.mergedAs).toEqual({ pr: 96, mergeCommit: WORK_071_MERGE });
  });

  it('DISCRIMINATION (the WORK-065 finalization — the scope shape binds the EXECUTION-MECHANISM work order; the approved head is reconciled history, and the pre-finalization red window is pinned): the real history binds WORK-065 ↔ PR #97 ↔ 5de5e83; state-only finalization subjects stay excluded', () => {
    // The actual WORK-065 architect merge (PR #97, squash-merged at the
    // approved head c06a3e3 on 2026-08-31T12:01:14Z) carries the subject
    // "feat(work-065): Synthetic Browser Validation Agent (the execution
    // mechanism, not authority) (#97)" — the FOURTH shape (the work-order id
    // in the SCOPE position), with a title that names the DOMAIN ("the
    // execution mechanism, not authority") and never a work order. The
    // approved head c06a3e3 is the post-#100 reconciliation head (rebased
    // onto the WORK-074 finalization mainline 1e279a2, the out-of-scope
    // WORK-042 relay-deflake change removed, 11/11 CI green) — the merge
    // tree is IDENTICAL to it (both trees 8b6469c8). The audit-level
    // identity: WORK-065 ↔ PR #97 ↔ 5de5e83 on the real first-parent
    // history — NO detector change was needed (the scope shape has been
    // recognized since the WORK-064 finalization).
    const evidence = collectMergeEvidenceFromRepository(REPO_ROOT);
    const WORK_065_MERGE = '5de5e83ac9a3ce2c1613a7b8b83045d0ab1d8916';
    // EXACT equality — the scope shape binds the WORK-065 merge, and nothing
    // else (no state-only commit) hides in the evidence list.
    expect(evidence.byWorkOrder.get('WORK-065')).toEqual([WORK_065_MERGE]);
    // Squash merges bind by work-order id, not PR subject: PR #97 has NO
    // "Merge pull request" subject on the first-parent chain.
    expect(evidence.byPr.has(97)).toBe(false);
    // COLLECTOR-LEVEL exclusion of the state-only finalization subjects: the
    // actual finalization convention `chore(governance): the WORK-065
    // post-merge finalization — … (#PR)` (scope = the word `governance`) and
    // the hypothetical mis-scoped `chore(work-065): the WORK-065 post-merge
    // finalization — …` (the title names the SAME work order as a topic —
    // the id must appear exactly once, in the binding position) NEVER enter
    // the evidence — this finalization commit itself can never be mistaken
    // for the architect's implementation merge.
    const finalizationOnly = collectMergeEvidenceFromLines([
      '8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e chore(governance): the WORK-065 post-merge finalization (§34.8/ADR-0007) — the canonical state reconciled with the 5de5e83 merge (#101)',
      '9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f chore(work-065): the WORK-065 post-merge finalization — state-only reconciliation',
      '0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a Governance: the WORK-065 post-merge finalization — state-only reconciliation',
      '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b WORK-065 post-merge finalization — state-only reconciliation',
    ]);
    expect(finalizationOnly.byWorkOrder.has('WORK-065')).toBe(false);
    // AUDIT-LEVEL proof: a history containing ONLY the finalization shapes
    // does NOT bind WORK-065 as merged — a state-only reconciliation is not
    // a completion event and can never satisfy (or violate) the
    // merged-finalization invariant.
    const auditFinalizationOnly = auditMergedFinalization(realProgram, finalizationOnly);
    expect(auditFinalizationOnly.mergedWorkOrderIds).not.toContain('WORK-065');
    expect(auditFinalizationOnly.gaps).toEqual([]);
    // The REAL program (post-finalization): WORK-065 is complete with the
    // FULL provenance identity — mergedAs {pr: 97, mergeCommit: 5de5e83…} and
    // the approved head c06a3e3 recorded — and the real history audits clean
    // (the finalization closed the red window the merge opened).
    const audit = auditMergedFinalization(realProgram, evidence);
    expect(audit.gaps).toEqual([]);
    expect(audit.mergedWorkOrderIds).toContain('WORK-065');
    const w065 = realProgram.workOrders.find((w) => w.id === 'WORK-065')!;
    expect(w065.status).toBe('complete');
    expect(w065.mergedAs).toEqual({ pr: 97, mergeCommit: WORK_065_MERGE });
    // The approved implementation head is the reconciliation head (the
    // historical record of what the architect actually merged — the WORK-064
    // finalization's `head` convention).
    expect(w065.head).toBe('c06a3e3');
    // DISCRIMINATION (in memory, the REAL evidence): the exact false state
    // the finalization exists to prevent — WORK-065 merged (5de5e83) while
    // still represented as in_flight — is DETECTED on the real history (this
    // was the live red window between the PR #97 merge and this
    // finalization: the audit reported exactly this gap, 12/13 finalized).
    const unfinalized065 = structuredClone(realProgram);
    const mutated065 = unfinalized065.workOrders.find((w) => w.id === 'WORK-065')!;
    mutated065.status = 'in_flight';
    delete (mutated065 as { mergedAs?: unknown }).mergedAs;
    const gaps065 = auditMergedFinalization(unfinalized065, evidence).gaps;
    expect(gaps065.join('\n')).toMatch(/WORK-065.*MERGED/);
    expect(gaps065.join('\n')).toContain('5de5e83a');
    expect(gaps065.join('\n')).toMatch(/post-merge finalization protocol/);
    // DISCRIMINATION (the PR identity, the PR #63 round-2 rule): a complete
    // WORK-065 record whose mergedAs.pr is not the authoritative PR identity
    // (97) is DETECTED — the PR number is validated, not stored.
    const falsePr065 = structuredClone(realProgram);
    falsePr065.workOrders.find((w) => w.id === 'WORK-065')!.mergedAs = {
      pr: 999,
      mergeCommit: WORK_065_MERGE,
    };
    expect(
      auditMergedFinalization(falsePr065, evidence).gaps.join('\n'),
    ).toMatch(/does not match the authoritative PR identity/);
    // DISCRIMINATION (a false merge commit): a complete WORK-065 record
    // whose mergedAs.mergeCommit is NOT the actual merge evidence is
    // DETECTED — the finalization must record the ACTUAL merge commit.
    const falseSha065 = structuredClone(realProgram);
    falseSha065.workOrders.find((w) => w.id === 'WORK-065')!.mergedAs = {
      pr: 97,
      mergeCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    };
    expect(
      auditMergedFinalization(falseSha065, evidence).gaps.join('\n'),
    ).toMatch(/does not match the actual merge evidence/);
  });

  it('DISCRIMINATION (the WORK-066 finalization — the scope shape binds the DECISION-LAYER work order; the pre-finalization red window is pinned): the real history binds WORK-066 ↔ PR #102 ↔ 0a506b1; state-only finalization subjects stay excluded', () => {
    // The actual WORK-066 architect merge (PR #102, squash-merged at the
    // approved head 493ae593da59edf0375e3c7e8e57147e36d065b5 on
    // 2026-08-31T16:37:09Z) carries the subject "feat(work-066): Validation
    // Scheduling & Change Triggers (the scheduling/trigger DECISION layer,
    // not an authority) (#102)" — the FOURTH shape (the work-order id in the
    // SCOPE position), with a title that names the DOMAIN ("the
    // scheduling/trigger DECISION layer, not an authority") and never a
    // work order. The approved head 493ae59 is the branch head the architect
    // reviewed — created from the post-#101 mainline 5f0b058 (the WORK-065
    // finalization) and never diverged (no reconciliation was needed; all 11
    // CI workflows green on that head) — and the merge tree is IDENTICAL to
    // it (git diff 493ae59 0a506b1 is empty). The audit-level identity:
    // WORK-066 ↔ PR #102 ↔ 0a506b1 on the real first-parent history — NO
    // detector change was needed (the scope shape has been recognized since
    // the WORK-064 finalization).
    const evidence = collectMergeEvidenceFromRepository(REPO_ROOT);
    const WORK_066_MERGE = '0a506b10e5526151929366bb11197230334b620c';
    // EXACT equality — the scope shape binds the WORK-066 merge, and nothing
    // else (no state-only commit) hides in the evidence list.
    expect(evidence.byWorkOrder.get('WORK-066')).toEqual([WORK_066_MERGE]);
    // Squash merges bind by work-order id, not PR subject: PR #102 has NO
    // "Merge pull request" subject on the first-parent chain.
    expect(evidence.byPr.has(102)).toBe(false);
    // COLLECTOR-LEVEL exclusion of the state-only finalization subjects: the
    // actual finalization convention `chore(governance): the WORK-066
    // post-merge finalization — … (#PR)` (scope = the word `governance`) and
    // the hypothetical mis-scoped `chore(work-066): the WORK-066 post-merge
    // finalization — …` (the title names the SAME work order as a topic —
    // the id must appear exactly once, in the binding position) NEVER enter
    // the evidence — this finalization commit itself can never be mistaken
    // for the architect's implementation merge.
    const finalizationOnly = collectMergeEvidenceFromLines([
      '2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c chore(governance): the WORK-066 post-merge finalization (§34.8/ADR-0007) — the canonical state reconciled with the 0a506b1 merge (#104)',
      '3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d chore(work-066): the WORK-066 post-merge finalization — state-only reconciliation',
      '4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e Governance: the WORK-066 post-merge finalization — state-only reconciliation',
      '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f WORK-066 post-merge finalization — state-only reconciliation',
    ]);
    expect(finalizationOnly.byWorkOrder.has('WORK-066')).toBe(false);
    // AUDIT-LEVEL proof: a history containing ONLY the finalization shapes
    // does NOT bind WORK-066 as merged — a state-only reconciliation is not
    // a completion event and can never satisfy (or violate) the
    // merged-finalization invariant.
    const auditFinalizationOnly = auditMergedFinalization(realProgram, finalizationOnly);
    expect(auditFinalizationOnly.mergedWorkOrderIds).not.toContain('WORK-066');
    expect(auditFinalizationOnly.gaps).toEqual([]);
    // The REAL program (post-finalization): WORK-066 is complete with the
    // FULL provenance identity — mergedAs {pr: 102, mergeCommit: 0a506b10…}
    // and the approved head 493ae59 recorded — and the real history audits
    // clean (the finalization closed the red window the merge opened:
    // 14/14 finalized, gaps []).
    const audit = auditMergedFinalization(realProgram, evidence);
    expect(audit.gaps).toEqual([]);
    expect(audit.mergedWorkOrderIds).toContain('WORK-066');
    const w066 = realProgram.workOrders.find((w) => w.id === 'WORK-066')!;
    expect(w066.status).toBe('complete');
    expect(w066.mergedAs).toEqual({ pr: 102, mergeCommit: WORK_066_MERGE });
    // The approved implementation head (the historical record of what the
    // architect actually merged — the WORK-064/WORK-065 finalization `head`
    // convention).
    expect(w066.head).toBe('493ae59');
    // The pre-finalization red window is pinned in memory: WORK-066 merged
    // (0a506b1) while still represented as in_flight is DETECTED on the real
    // history — this was the live red window between the PR #102 merge and
    // this finalization (the audit reported exactly this gap, 13/14
    // finalized; governance:status exited 1 with the GAP line verbatim:
    // 'workOrders[WORK-066]: MERGED (0a506b10e) but the canonical status is
    // "in_flight" — a merged Work Order cannot remain represented as
    // in_flight in canonical state; execute the post-merge finalization
    // protocol (§34.8: complete + mergedAs with the actual merge commit,
    // handoff removed)').
    const unfinalized066b = structuredClone(realProgram);
    const mutated066b = unfinalized066b.workOrders.find((w) => w.id === 'WORK-066')!;
    mutated066b.status = 'in_flight';
    delete (mutated066b as { mergedAs?: unknown }).mergedAs;
    const gaps066b = auditMergedFinalization(unfinalized066b, evidence).gaps;
    expect(gaps066b.length).toBe(1);
    expect(gaps066b[0]).toMatch(/WORK-066.*MERGED \(0a506b10e\) but the canonical status is "in_flight"/);
    expect(gaps066b.join('\n')).toMatch(/post-merge finalization protocol/);
    // DISCRIMINATION (the PR identity, the PR #63 round-2 rule): a complete
    // WORK-066 record whose mergedAs.pr is not the authoritative PR identity
    // (102) is DETECTED — the PR number is validated, not stored.
    const falsePr066b = structuredClone(realProgram);
    falsePr066b.workOrders.find((w) => w.id === 'WORK-066')!.mergedAs = {
      pr: 999,
      mergeCommit: WORK_066_MERGE,
    };
    expect(
      auditMergedFinalization(falsePr066b, evidence).gaps.join('\n'),
    ).toMatch(/does not match the authoritative PR identity/);
    // DISCRIMINATION (a false merge commit): a complete WORK-066 record
    // whose mergedAs.mergeCommit is NOT the actual merge evidence is
    // DETECTED — a fabricated SHA cannot fabricate completion evidence.
    const falseSha066b = structuredClone(realProgram);
    falseSha066b.workOrders.find((w) => w.id === 'WORK-066')!.mergedAs = {
      pr: 102,
      mergeCommit: 'feedfacefeedfacefeedfacefeedfacefeedface',
    };
    expect(
      auditMergedFinalization(falseSha066b, evidence).gaps.join('\n'),
    ).toMatch(/does not match the actual merge evidence/);
    // DISCRIMINATION (the wrong work-order binding): the WORK-066 merge
    // subject names its DOMAIN and never another work order — a hypothetical
    // subject that would bind the WRONG work order (the topic-position
    // exclusion) is not in the real history, and the collector proves it on
    // synthetic lines: a subject naming WORK-0XX as a topic while scoped to
    // WORK-066 binds ONLY WORK-066 (the scope position), never the topic.
    const topicOnly = collectMergeEvidenceFromLines([
      '6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a feat(work-066): the WORK-070 post-merge finalization — state-only reconciliation',
    ]);
    expect(topicOnly.byWorkOrder.get('WORK-066')).toEqual([
      '6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a',
    ]);
    expect(topicOnly.byWorkOrder.has('WORK-070')).toBe(false);
  });

  it('DISCRIMINATION (the WORK-067 finalization — the scope shape binds the ADVISORY-CORRELATION-LAYER work order; the pre-finalization red window is pinned): the real history binds WORK-067 ↔ PR #103 ↔ bde33cc; state-only finalization subjects stay excluded', () => {
    // The actual WORK-067 architect merge (PR #103, squash-merged at the
    // approved head 0fe9c481e80d435a18552bbec4c70c9f93e265b2 on
    // 2026-08-31T18:30:23Z) carries the subject "feat(work-067): Engineering
    // Signal & Regression Correlation (the ADVISORY correlation layer, not an
    // authority) (#103)" — the FOURTH shape (the work-order id in the SCOPE
    // position), with a title that names the DOMAIN ("the ADVISORY
    // correlation layer, not an authority") and never a work order. The
    // approved head 0fe9c48 is the post-#104 reconciliation head the
    // architect reviewed — grown from the 5f0b058 base, rebased onto the
    // post-#102 mainline 0a506b1 when the architect merged the parallel
    // WORK-066 mid-delivery, and REBASED AGAIN onto the post-#104 finalization
    // mainline 69f2edf (the WORK-065 PR #97 post-#100 reconciliation
    // precedent) — and the merge tree is IDENTICAL to it (git diff 0fe9c48
    // bde33cc is empty; both trees 4fd2a46). The audit-level identity:
    // WORK-067 ↔ PR #103 ↔ bde33cc on the real first-parent history — NO
    // detector change was needed (the scope shape has been recognized since
    // the WORK-064 finalization).
    const evidence = collectMergeEvidenceFromRepository(REPO_ROOT);
    const WORK_067_MERGE = 'bde33cc5e9a1b109951be9ec48aaef7e692c33c7';
    // EXACT equality — the scope shape binds the WORK-067 merge, and nothing
    // else (no state-only commit) hides in the evidence list.
    expect(evidence.byWorkOrder.get('WORK-067')).toEqual([WORK_067_MERGE]);
    // Squash merges bind by work-order id, not PR subject: PR #103 has NO
    // "Merge pull request" subject on the first-parent chain.
    expect(evidence.byPr.has(103)).toBe(false);
    // COLLECTOR-LEVEL exclusion of the state-only finalization subjects: the
    // actual finalization convention `chore(governance): the WORK-067
    // post-merge finalization — … (#PR)` (scope = the word `governance`) and
    // the hypothetical mis-scoped `chore(work-067): the WORK-067 post-merge
    // finalization — …` (the title names the SAME work order as a topic —
    // the id must appear exactly once, in the binding position) NEVER enter
    // the evidence — this finalization commit itself can never be mistaken
    // for the architect's implementation merge.
    const finalizationOnly067 = collectMergeEvidenceFromLines([
      '7b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c chore(governance): the WORK-067 post-merge finalization (§34.8/ADR-0007) — the canonical state reconciled with the bde33cc merge (#105)',
      '8c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d chore(work-067): the WORK-067 post-merge finalization — state-only reconciliation',
      '9d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e Governance: the WORK-067 post-merge finalization — state-only reconciliation',
      'ae6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f WORK-067 post-merge finalization — state-only reconciliation',
    ]);
    expect(finalizationOnly067.byWorkOrder.has('WORK-067')).toBe(false);
    // AUDIT-LEVEL proof: a history containing ONLY the finalization shapes
    // does NOT bind WORK-067 as merged — a state-only reconciliation is not
    // a completion event and can never satisfy (or violate) the
    // merged-finalization invariant.
    const auditFinalizationOnly067 = auditMergedFinalization(realProgram, finalizationOnly067);
    expect(auditFinalizationOnly067.mergedWorkOrderIds).not.toContain('WORK-067');
    expect(auditFinalizationOnly067.gaps).toEqual([]);
    // The REAL program (post-finalization): WORK-067 is complete with the
    // FULL provenance identity — mergedAs {pr: 103, mergeCommit: bde33cc…}
    // and the approved head 0fe9c48 recorded — and the real history audits
    // clean (the finalization closed the red window the merge opened:
    // 15/15 finalized, gaps []).
    const audit067 = auditMergedFinalization(realProgram, evidence);
    expect(audit067.gaps).toEqual([]);
    expect(audit067.mergedWorkOrderIds).toContain('WORK-067');
    const w067 = realProgram.workOrders.find((w) => w.id === 'WORK-067')!;
    expect(w067.status).toBe('complete');
    expect(w067.mergedAs).toEqual({ pr: 103, mergeCommit: WORK_067_MERGE });
    // The approved implementation head (the historical record of what the
    // architect actually merged — the WORK-064/WORK-065/WORK-066 finalization
    // `head` convention).
    expect(w067.head).toBe('0fe9c48');
    // The pre-merge activation handoff actually EXISTED (the post-#104
    // reconciliation handoff) and was REMOVED by this finalization (merged
    // work is not resumable — §34.8).
    expect(realProgram.resumption.activeHandoffs.some((h) => h.workOrderId === 'WORK-067')).toBe(false);
    // The pre-finalization red window is pinned in memory: WORK-067 merged
    // (bde33cc) while still represented as in_flight is DETECTED on the real
    // history — this was the live red window between the PR #103 merge and
    // this finalization (the audit reported exactly this gap, 14/15
    // finalized; governance:status exited non-zero with the GAP line
    // verbatim: 'workOrders[WORK-067]: MERGED (bde33cc5e) but the canonical
    // status is "in_flight" — a merged Work Order cannot remain represented
    // as in_flight in canonical state; execute the post-merge finalization
    // protocol (§34.8: complete + mergedAs with the actual merge commit,
    // handoff removed)').
    const unfinalized067 = structuredClone(realProgram);
    const mutated067 = unfinalized067.workOrders.find((w) => w.id === 'WORK-067')!;
    mutated067.status = 'in_flight';
    delete (mutated067 as { mergedAs?: unknown }).mergedAs;
    const gaps067 = auditMergedFinalization(unfinalized067, evidence).gaps;
    expect(gaps067.length).toBe(1);
    expect(gaps067[0]).toMatch(/WORK-067.*MERGED \(bde33cc5e\) but the canonical status is "in_flight"/);
    expect(gaps067.join('\n')).toMatch(/post-merge finalization protocol/);
    // DISCRIMINATION (the PR identity, the PR #63 round-2 rule): a complete
    // WORK-067 record whose mergedAs.pr is not the authoritative PR identity
    // (103) is DETECTED — the PR number is validated, not stored.
    const falsePr067 = structuredClone(realProgram);
    falsePr067.workOrders.find((w) => w.id === 'WORK-067')!.mergedAs = {
      pr: 999,
      mergeCommit: WORK_067_MERGE,
    };
    expect(
      auditMergedFinalization(falsePr067, evidence).gaps.join('\n'),
    ).toMatch(/does not match the authoritative PR identity/);
    // DISCRIMINATION (a fake SHA): a complete WORK-067 record whose
    // mergedAs.mergeCommit is NOT the actual merge evidence is DETECTED —
    // a fabricated SHA cannot fabricate completion evidence.
    const falseSha067 = structuredClone(realProgram);
    falseSha067.workOrders.find((w) => w.id === 'WORK-067')!.mergedAs = {
      pr: 103,
      mergeCommit: 'feedfacefeedfacefeedfacefeedfacefeedface',
    };
    expect(
      auditMergedFinalization(falseSha067, evidence).gaps.join('\n'),
    ).toMatch(/does not match the actual merge evidence/);
    // DISCRIMINATION (the wrong work-order binding): the WORK-067 merge
    // subject names its DOMAIN and never another work order — a hypothetical
    // subject that would bind the WRONG work order (the topic-position
    // exclusion) is not in the real history, and the collector proves it on
    // synthetic lines: a subject naming WORK-0XX as a topic while scoped to
    // WORK-067 binds ONLY WORK-067 (the scope position), never the topic.
    const topicOnly067 = collectMergeEvidenceFromLines([
      'bf7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a feat(work-067): the WORK-070 post-merge finalization — state-only reconciliation',
    ]);
    expect(topicOnly067.byWorkOrder.get('WORK-067')).toEqual([
      'bf7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a',
    ]);
    expect(topicOnly067.byWorkOrder.has('WORK-070')).toBe(false);
  });
});
