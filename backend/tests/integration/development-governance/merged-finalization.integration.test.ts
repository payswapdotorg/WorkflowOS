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

  it('collects merge evidence from first-parent history lines — BOTH merge shapes (the classic merge commit AND the WORK-NNN architect-merge subject convention)', () => {
    const evidence = collectMergeEvidenceFromLines([
      `${SHA_A} Merge pull request #52 from pectoraux/feat/work-051-architecture-governance-checkpoints`,
      `${SHA_B} WORK-052: Development Governance & Self-Hosting Control Plane`,
      'not a sha line at all',
      `${SHA_A.slice(0, 8)} short-sha subjects are not first-parent history lines`,
      'f2c996c26b0a1cdf6b0b946102e4aa669a2847c9 Merge pull request #29 from pectoraux/feat/work-026-project-runtime',
      'e3d0f2b1c4a5968712345678abcdef01234567890 fix(WORK-052 round 1): branch commits with parenthesized prefixes are NOT merge subjects',
    ]);
    // The classic merge shape binds by PR number.
    expect(evidence.byPr.get(52)).toEqual([SHA_A]);
    expect(evidence.byPr.get(29)).toEqual(['f2c996c26b0a1cdf6b0b946102e4aa669a2847c9']);
    expect(evidence.byPr.has(62)).toBe(false); // PR #62 merged as a squash — no #62 subject
    // The architect-merge subject convention binds by work-order id.
    expect(evidence.byWorkOrder.get('WORK-052')).toEqual([SHA_B]);
    // Noise is ignored: non-sha lines, short shas, and parenthesized branch
    // prefixes ("fix(WORK-…") are NOT merge evidence.
    expect(evidence.byWorkOrder.has('WORK-051')).toBe(false);
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

  it('a second architect merge of the same work order (e.g. a corrective finalization squash) audits clean when mergedAs matches ANY actual merge commit', () => {
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
    // The real history binds WORK-052 through the WORK-NNN squash convention.
    expect(evidence.byWorkOrder.get('WORK-052')).toEqual(['47615c236ec0e194e112efd3d2ef0f432c4bf210']);
    // …and WORK-051 through the classic merge shape (its declared pr 52) —
    // BOTH shapes audit clean with their full mergedAs identities.
    expect(evidence.byPr.get(52)).toEqual(['f2c996c26b0a1cdf6b0b946102e4aa669a2847c9']);
    const audit = auditMergedFinalization(realProgram, evidence);
    expect(audit.gaps).toEqual([]);
    expect(audit.mergedWorkOrderIds).toContain('WORK-052');
    expect(audit.mergedWorkOrderIds).toContain('WORK-051');
  });
});
