/**
 * WORK-039: BaselineContextSource — the source-fact reader.
 *
 * Reads SOURCE FACTS + BASELINE OBSERVATIONS + AUTHORITATIVE REFERENCES from
 * the EXISTING authorities + produces ContextSourceItem candidates with
 * provenance preserved + authority_ref pointing back to the authoritative
 * domain (NEVER duplicating it).
 *
 * Sources read (all READ-ONLY — the capability never mutates any authority):
 *   * /projects  (ProjectBaselineRepository) — the baseline's observations +
 *                  evidence (the SOURCE FACTS the baseline established).
 *   * /architecture (ArchitectureVersionRepository) — architecture versions
 *                  for the project's architecture (REFERENCES; the item's
 *                  authorityRef.architectureVersionId POINTS at the version;
 *                  the capability NEVER calls freezeVersion / create).
 *   * /requirements (RequirementRepository + AcceptanceCriterionRepository) —
 *                  requirements + criteria for the architecture version
 *                  (REFERENCES; the capability NEVER calls create).
 *   * /work-items (WorkItemRepository + WorkItemRequirementRepository +
 *                  WorkItemCriterionRepository) — work items + their
 *                  requirement/criterion associations (REFERENCES; the
 *                  capability NEVER mutates workflow state).
 *   * /github (GitHubAdapter.listDir) — repository structure at the baseline
 *                  commit (file/directory items; READ-ONLY; the capability
 *                  holds no credentials — the installationId is carried in
 *                  the ContextResolutionContext).
 *
 * PROVENANCE PRESERVATION. Every candidate carries the SAME provenance as
 * its underlying source: a baseline observation with provenance=`inferred`
 * produces a candidate with provenance=`inferred` (NEVER promoted). An
 * architecture version reference is `observed` (it's an authoritative fact the
 * baseline OBSERVED — the existence of ArchitectureVersion X is a verifiable
 * source fact). A requirement reference is `observed`. A work-item reference is
 * `observed`. A repository file is `observed`.
 *
 * PROVENANCE ≠ AUTHORITY STATE. The architecture version's `state` ('draft' |
 * 'frozen' | 'superseded') is a SEPARATE dimension — it describes the
 * /architecture AUTHORITY's lifecycle for that version, NOT the WORK-038
 * provenance of the context item that REFERENCES it. A frozen architecture
 * version is still an OBSERVED reference from the context layer's perspective
 * (freezing does NOT retroactively `confirm` the context item's provenance;
 * `confirmed` is reachable ONLY through the authorized confirmation route on a
 * baseline observation, never through architecture authority state). The
 * capability NEVER conflates these two dimensions.
 *
 * REDACTION PRESERVATION. The candidate's `redacted` flag is carried through
 * from the underlying baseline evidence (NEVER reversed; the capability never
 * holds raw secrets).
 *
 * TENANT ISOLATION. Every read is scoped by projectId/organizationId (the
 * baseline + the repo link are project-scoped; the architecture/requirements/
 * work-items are project-scoped via the architecture version's projectId).
 *
 * NO FABRICATED EVIDENCE. The source NEVER invents toolInvocationIds — the
 * baseline evidence already carries HONEST toolInvocationIds (from WORK-038's
 * governed reads); the source passes them through via evidenceRef.
 */
import type {
  ContextIndexQuery,
  ContextResolutionContext,
  ContextSource,
  ContextSourceItem,
} from '../repository-intelligence.types.js';
import type { BaselineEvidence } from '@modules/projects/index.js';
import type { Logger } from '@platform/index.js';

/**
 * The default source-fact reader. Composes the EXISTING authorities
 * (read-only) to produce ContextSourceItem candidates.
 */
export class BaselineContextSource implements ContextSource {
  constructor(private readonly logger: Logger) {}

  async readCandidates(
    query: ContextIndexQuery,
    ctx: ContextResolutionContext,
  ): Promise<readonly ContextSourceItem[]> {
    const candidates: ContextSourceItem[] = [];

    // 1. Baseline observations + evidence (the SOURCE FACTS — the evidence
    //    backbone). The baseline MUST be 'complete' (the orchestrator checks
    //    this before calling readCandidates; an 'analyzing'/'failed' baseline
    //    cannot be indexed).
    const [observations, evidence] = await Promise.all([
      ctx.projectBaselineRepository.listObservations(query.baselineId),
      ctx.projectBaselineRepository.listEvidence(query.baselineId),
    ]);
    const evidenceById = new Map<string, BaselineEvidence>(evidence.map((e) => [e.id, e]));

    // 1a. Baseline observations → baseline_observation candidates (carries
    //     provenance verbatim — NEVER promoted).
    for (const obs of observations) {
      const evRefs = obs.evidenceRef;
      const firstEv = evRefs.length > 0 ? evidenceById.get(evRefs[0]!) : undefined;
      candidates.push({
        kind: 'baseline_observation',
        locator: obs.id, // the observation id is the concrete pointer
        source: 'baseline_observation',
        provenance: obs.provenance, // NEVER promoted
        contentDigest: obs.claimDigest,
        redacted: firstEv?.redacted ?? false, // preserved from underlying evidence
        evidenceRef: evRefs,
        authorityRef: { observationId: obs.id, kind: obs.kind },
        matchText: `${obs.kind} ${JSON.stringify(obs.claim)}`,
      });
    }

    // 1b. Baseline evidence → baseline_evidence candidates (the raw evidence
    //     rows — file paths, CI refs, etc.). The evidence locator is the
    //     concrete pointer (e.g. "package.json" or ".github/workflows/ci.yml").
    for (const ev of evidence) {
      candidates.push({
        kind: evidenceKindForLocator(ev.locator),
        locator: ev.locator,
        source: 'baseline_evidence',
        provenance: 'observed', // evidence is directly established
        contentDigest: ev.contentDigest,
        redacted: ev.redacted, // NEVER reversed
        evidenceRef: [ev.id],
        authorityRef: { evidenceId: ev.id, evidenceSource: ev.source },
        matchText: ev.locator,
      });
    }

    // 2. Architecture versions for the project (REFERENCES — the item's
    //    authorityRef.architectureVersionId POINTS at the version; the
    //    capability NEVER calls freezeVersion / create).
    //
    //    PROVENANCE ≠ AUTHORITY STATE. The version's `state` ('draft' |
    //    'frozen' | 'superseded') is the /architecture AUTHORITY's lifecycle
    //    for the version — it is NOT the WORK-038 provenance of the context
    //    item that REFERENCES it. A frozen architecture version is still an
    //    OBSERVED reference from the context layer's perspective (freezing
    //    does NOT retroactively `confirm` the context item; `confirmed` is
    //    reachable ONLY through the authorized confirmation route on a
    //    baseline observation, never through architecture authority state).
    //    The capability records the version's `state` in authorityRef (so the
    //    consumer can SEE the authority state) + assigns `observed` provenance
    //    (the existence of the version is a verifiable source fact). The two
    //    dimensions NEVER collapse.
    try {
      const architectures = await ctx.architectureRepository.findByProject(query.projectId);
      const architecture = architectures[0];
      if (architecture) {
        const versions = await ctx.architectureVersionRepository.findByArchitecture(architecture.id);
        for (const v of versions) {
          candidates.push({
            kind: 'architecture_observation',
            locator: v.id,
            source: 'architecture',
            provenance: 'observed', // NEVER promoted — frozen authority state ≠ confirmed provenance
            contentDigest: v.digestSha256 ?? null,
            redacted: false,
            evidenceRef: [],
            authorityRef: { architectureVersionId: v.id, architectureId: architecture.id, versionNumber: v.versionNumber, state: v.state },
            matchText: `architecture ${architecture.name} version ${v.versionNumber} ${v.state}`,
          });
        }
      }
    } catch (err) {
      // Architecture may not be set up for an onboarded project yet — that's
      // fine (the baseline's proposed-architecture observation is the source
      // of truth in that case). Log + continue.
      this.logger.warn('repository-intelligence: architecture read returned no rows (project may not have an architecture version yet)', { projectId: query.projectId, err: (err as Error).message });
    }

    // 3. Requirements + criteria for the architecture version(s) cited by the
    //    query (REFERENCES — the item's authorityRef.requirementId POINTS at
    //    the requirement; the capability NEVER calls create).
    if (query.queryTerms.requirementRefs && query.queryTerms.requirementRefs.length > 0) {
      for (const reqId of query.queryTerms.requirementRefs) {
        try {
          const req = await ctx.requirementRepository.findById(reqId);
          if (req) {
            candidates.push({
              kind: 'requirement',
              locator: req.id,
              source: 'requirement',
              provenance: 'observed',
              contentDigest: null,
              redacted: false,
              evidenceRef: [],
              authorityRef: { requirementId: req.id, title: req.title },
              matchText: `${req.title} ${req.description ?? ''}`,
            });
          }
        } catch (err) {
          this.logger.warn('repository-intelligence: requirement read failed', { reqId, err: (err as Error).message });
        }
      }
    }

    // 4. Work item references (when the query kind is 'work_item', the
    //    queryRef is the work_item_id). The work item's objective/scope
    //    become matchText (so term_overlap selects related baseline items).
    if (query.kind === 'work_item' && query.queryRef) {
      try {
        const wi = await ctx.workItemRepository.findById(query.queryRef);
        if (wi) {
          candidates.push({
            kind: 'baseline_observation',
            locator: wi.id,
            source: 'work_item',
            provenance: 'observed',
            contentDigest: null,
            redacted: false,
            evidenceRef: [],
            authorityRef: { workItemId: wi.id, title: wi.title },
            matchText: `${wi.title} ${wi.objective ?? ''} ${wi.scope ?? ''}`,
          });
          // The work item's requirement associations → requirement candidates.
          const assocs = await ctx.workItemRequirementRepository.listForWorkItem(wi.id);
          for (const a of assocs) {
            try {
              const req = await ctx.requirementRepository.findById(a.requirementId);
              if (req) {
                candidates.push({
                  kind: 'requirement',
                  locator: req.id,
                  source: 'requirement',
                  provenance: 'observed',
                  contentDigest: null,
                  redacted: false,
                  evidenceRef: [],
                  authorityRef: { requirementId: req.id, workItemId: wi.id, title: req.title },
                  matchText: `${req.title} ${req.description ?? ''}`,
                });
              }
            } catch {
              // best-effort — skip missing requirements
            }
          }
        }
      } catch (err) {
        this.logger.warn('repository-intelligence: work item read failed', { workItemId: query.queryRef, err: (err as Error).message });
      }
    }

    // 5. Repository structure from /github (file/directory items at the
    //    baseline commit). READ-ONLY; the capability holds no credentials
    //    (the installationId is carried in the context). Best-effort — if
    //    /github is not configured (the FakeGitHubAdapter in tests, or
    //    production without GITHUB_APP_*), this returns no items (the
    //    baseline's evidence already covers the candidate allowlist paths).
    try {
      const listing = await ctx.githubAdapter.listDir({
        owner: ctx.repositoryOwner,
        repository: ctx.repositoryName,
        ref: ctx.baselineCommitSha,
        path: '',
        installationId: ctx.installationId,
      });
      for (const entry of listing.entries) {
        candidates.push({
          kind: entry.type === 'dir' ? 'directory' : 'file',
          locator: entry.name,
          source: 'repository_structure',
          provenance: 'observed',
          contentDigest: null,
          redacted: false,
          evidenceRef: [],
          authorityRef: { repositoryStructure: entry.name, type: entry.type },
          matchText: entry.name,
        });
      }
    } catch (err) {
      // /github not configured or unavailable — the baseline's evidence
      // already covers the candidate allowlist paths; this is best-effort.
      this.logger.debug('repository-intelligence: /github listDir returned no items (not configured or unavailable)', { owner: ctx.repositoryOwner, repo: ctx.repositoryName, err: (err as Error).message });
    }

    return candidates;
  }
}

/**
 * Map a baseline-evidence locator to a context-item kind. The locator is
 * the concrete pointer (e.g. "package.json", ".github/workflows/ci.yml",
 * "Dockerfile"). The kind tells the consumer WHAT the item is.
 */
function evidenceKindForLocator(locator: string): ContextSourceItem['kind'] {
  const lower = locator.toLowerCase();
  if (lower.includes('.github/workflows') || lower.includes('ci.yml') || lower.includes('ci.yaml')) return 'ci_workflow';
  if (lower.endsWith('dockerfile') || lower.includes('docker-compose')) return 'configuration';
  if (lower.includes('readme') || lower.includes('.md')) return 'documentation';
  if (lower.includes('test') || lower.includes('spec') || lower.includes('__tests__')) return 'test';
  return 'file';
}
