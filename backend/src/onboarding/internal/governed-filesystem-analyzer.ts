/**
 * WORK-038: GovernedFilesystemAnalyzer — the default repository analyzer.
 *
 * Routes EVERY candidate read through the governed repository-read boundary
 * (the PR #42 round-3 {@link GovernedRepositoryReadPolicy} — a DISTINCT,
 * atomic operation boundary for /github reads that ties the WORK-037
 * authorization decision to the actual read + the `constrained`
 * enforcement + the bound record). The boundary returns ONE outcome per
 * candidate carrying the content (null when blocked/absent) + the bound
 * governance (decision + policyVersion + ruleId + performed + enforcement).
 *
 * The analyzer NEVER calls the WORK-037 policy gate directly, NEVER calls
 * the content port directly — it calls the boundary's governedRead() ONLY.
 * This eliminates the round-2 check-then-act window (decide() then read())
 * — the decision and the read are bound in ONE atomic boundary method.
 *
 * The analyzer redacts secrets (the platform observation-redaction util) and
 * produces provenance-tagged observations:
 *
 *   * OBSERVED   — directly established from file content (package.json
 *                  fields, CI config presence, Dockerfile presence).
 *   * INFERRED    — reasoned from observations (framework from deps,
 *                  deployment target from Dockerfile).
 *   * PROPOSED   — a suggested architecture, never an authoritative fact.
 *
 * The analyzer NEVER produces CONFIRMED observations — confirmation is the
 * authorized human path (the /projects ProjectBaselineRepository
 * confirmObservation method + the route's requireProjectAuthorization).
 * This is the "no silent promotion" invariant at the source: the analyzer
 * cannot promote.
 *
 * PR #42 round-3 (the governed read made real):
 *   * the evidence row records the ACTUAL decision that governed the read
 *     (repository_read_decision) + the concrete enforcement effect
 *     (repository_read_enforcement) in their OWN columns — NOT masquerading
 *     as a Tool Runtime invocation. tool_invocation_id stays NULL (the
 *     /github read path is NOT a ToolRuntime invocation — round-2 invariant
 *     preserved). policy_decision stays NULL (reserved for "host tool run"
 *     — round-2 invariant preserved). The decision + effect are recorded
 *     honestly in their own columns.
 *   * `constrained` has a CONCRETE enforcement effect: maxOutputBytes
 *     truncates the observed content + recomputes the digest on the
 *     truncated content (the digest reflects what was actually observed).
 *     The boundary applies this; the analyzer just records the returned
 *     enforcement record.
 *   * policy drift is prevented-by-construction (the decision is captured
 *     and the read is performed in ONE boundary method) AND made observable
 *     (the policyVersion snapshot is recorded in repository_read_enforcement).
 *
 * PR #42 round-2 invariants PRESERVED:
 *   * no fake toolInvocationId (tool_invocation_id stays NULL).
 *   * infrastructure failure propagates as OnboardingAnalysisError
 *     'repository-content-unavailable' → markFailed (the boundary
 *     re-throws content-port failures as the typed error).
 *   * expected-missing graceful (null/[] → continue, baseline completes).
 *   * observation DELETE protection (the migration trigger).
 *   * failed-baseline confirmation guard (the repository method).
 *
 * Deep stack/security/deployment scanning is WORK-039+ (STRICTLY OUT OF
 * SCOPE). The foundation analyzer demonstrates the governed provenance model
 * end-to-end on a bounded candidate set; the boundary is extensible.
 *
 * Boundary: src/onboarding/ — application capability, NOT a module, NOT an
 * authority. No provider SDKs, no credentials, no DB access (the orchestrator
 * persists observations through the /projects repository).
 */
import { createHash } from 'node:crypto';
import { redactForObservation } from '@platform/tools/observation-redaction.js';
import type { Logger } from '@platform/logger.js';
import type {
  BaselineObservationKind,
  NewBaselineEvidence,
  NewBaselineObservation,
} from '@modules/projects/index.js';
import type {
  AnalysisContext,
  AnalysisResult,
  GovernedReadRequest,
  GovernedRepositoryReadPolicy,
  RepositoryAnalyzer,
} from '../onboarding.types.js';

/** The candidate paths the foundation analyzer inspects (bounded, extensible). */
const CANDIDATE_READS: readonly GovernedReadRequest[] = [
  { path: 'package.json', family: 'filesystem', operation: 'read' },
  { path: 'README.md', family: 'filesystem', operation: 'read' },
  { path: '.github/workflows', family: 'filesystem', operation: 'list' },
  { path: 'Dockerfile', family: 'filesystem', operation: 'read' },
  { path: 'docker-compose.yml', family: 'filesystem', operation: 'read' },
  { path: 'prisma/schema.prisma', family: 'filesystem', operation: 'read' },
];

/** The candidate-path allowlist (the boundary refuses reads outside this set). */
const CANDIDATE_ALLOWLIST: ReadonlySet<string> = new Set(
  CANDIDATE_READS.map((c) => c.path),
);

/** sha256 hex of a string. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical (kind|provenance|claim-digest) for content-digest computation. */
function canonicalObservationSet(
  observations: readonly NewBaselineObservation[],
): string {
  return observations
    .map((o) => `${o.kind}|${o.provenance}|${o.claimDigest}`)
    .sort()
    .join('\n');
}

/** sha256 of a JSON claim (canonical, stable key order). */
function claimDigest(claim: Record<string, unknown>): string {
  return sha256(JSON.stringify(claim, Object.keys(claim).sort()));
}

/**
 * The frozen candidate set (re-exported so the composition root can pass
 * the SAME allowlist to the boundary — the analyzer cannot read an
 * arbitrary path through the boundary because the boundary is scoped to
 * this set).
 */
export const GOVERNED_FILESYSTEM_CANDIDATE_ALLOWLIST = CANDIDATE_ALLOWLIST;

export interface GovernedFilesystemAnalyzerDeps {
  /**
   * The governed repository-read boundary (PR #42 round-3). The analyzer
   * calls governedRead() per candidate — the boundary atomically captures
   * the WORK-037 decision, enforces it (deny/ask/path-not-allowed/
   * operation-not-read -> no read), performs the read under the captured
   * decision, applies the `constrained` enforcement, and returns the bound
   * decision+effect+content. The analyzer NEVER calls the policy gate or
   * the content port directly — there is no check-then-act window.
   */
  readonly governedReadPolicy: GovernedRepositoryReadPolicy;
  readonly logger: Logger;
}

export class GovernedFilesystemAnalyzer implements RepositoryAnalyzer {
  constructor(private readonly deps: GovernedFilesystemAnalyzerDeps) {}

  async analyze(ctx: AnalysisContext): Promise<AnalysisResult> {
    const observations: NewBaselineObservation[] = [];
    const evidence: NewBaselineEvidence[] = [];

    // 1. OBSERVED repository_identity — established from the /github
    //    authority metadata carried in the context (owner, name, sha, ref).
    //    This is a directly-observed fact, not an inference. It does NOT
    //    come from a governed content read (no evidence row, no governance
    //    record) — it is observed from the context metadata the orchestrator
    //    resolved through /github getBranch.
    const repoIdentityClaim = {
      owner: ctx.repositoryOwner,
      repository: ctx.repositoryName,
      commitSha: ctx.baselineCommitSha,
      revisionRef: ctx.revisionRef,
      installationId: ctx.installationId,
      analysisRunId: ctx.analysisRunId,
    };
    observations.push({
      kind: 'repository_identity',
      provenance: 'observed',
      claim: redactForObservation(repoIdentityClaim) as Record<string, unknown>,
      claimDigest: claimDigest(repoIdentityClaim),
      evidenceRef: [], // no evidence row (metadata-observed, not content-read)
    });

    // 2. Governed candidate reads — each through the boundary's
    //    governedRead() (the atomic decide+enforce+read+REVALIDATE+record
    //    method — PR #42 round-3 + round-4). The evidence row records the
    //    ACTUAL decision (repository_read_decision) + the concrete
    //    enforcement effect (repository_read_enforcement) in their OWN
    //    columns. The Tool Runtime columns (tool_invocation_id +
    //    policy_decision) stay NULL (round-2 invariant preserved — the
    //    /github read is NOT a Tool Runtime invocation, NOT a host tool
    //    run).
    //
    //    PR #42 round-4 (the snapshot/fencing protocol): when the boundary
    //    detects that the policy snapshot that authorized the read is NO
    //    LONGER current at revalidation (a concurrent policy mutation
    //    committed DURING the read), it returns a STALE outcome —
    //    content=null, performed=false, stale=true. The analyzer MUST NOT
    //    persist an evidence row or observation for that path (the
    //    architect's invariant: "a repository-read result is persisted only
    //    if the policy snapshot that authorized it is still current when
    //    the result is committed"). The forensic audit goes to the
    //    boundary's log (the DB stays clean — only successfully-authorized-
    //    and-revalidated reads produce evidence rows). The baseline still
    //    completes (the other reads' evidence is still valid under their
    //    own revalidated snapshots).
    const contentByPath = new Map<string, { content: string; contentDigest: string }>();
    for (const candidate of CANDIDATE_READS) {
      // The boundary throws OnboardingAnalysisError on an infrastructure
      // failure (the orchestrator catches it + markFailed — round-2
      // Blocker B, preserved). Expected-missing (null/[]) is NOT an
      // infrastructure failure — the boundary returns content=null +
      // performed=true (the read happened; the path was absent). A STALE
      // read (round-4 fencing) is ALSO not an infrastructure failure —
      // the boundary returns content=null + performed=false + stale=true,
      // and the analyzer skips the evidence row + observation for that
      // path (the read result was discarded).
      const outcome = await this.deps.governedReadPolicy.governedRead(candidate, ctx);

      // PR #42 round-4 (the snapshot/fencing protocol): a STALE outcome
      // means the policy snapshot that authorized the read is no longer
      // current at revalidation. The read result is DISCARDED — do NOT
      // persist an evidence row or observation for this path. The
      // boundary already logged the staleness for forensics. Continue
      // with the next candidate (the baseline still completes with the
      // other reads' evidence).
      if (outcome.governance.stale) {
        continue;
      }

      // Build the evidence row from the bound outcome. The decision +
      // enforcement come from the boundary's governance record (the actual
      // decision that governed THIS read + the concrete effect + the
      // revalidation metadata).
      const g = outcome.governance;
      const ev: NewBaselineEvidence = {
        source: 'filesystem',
        locator: candidate.path,
        contentDigest: outcome.content?.contentDigest ?? null,
        redacted: true,
        // PR #42 round-2 invariant (PRESERVED): NULL — the /github read
        // path is NOT a ToolRuntime invocation. Do not manufacture
        // toolInvocationIds for operations that never went through Tool
        // Runtime.
        toolInvocationId: null,
        // PR #42 round-2 invariant (PRESERVED): NULL — no host tool run.
        // The schema reserves policy_decision for "host tool run" audit
        // trail (a ToolRuntime invocation gated by decide()). The /github
        // read is NOT a host tool run.
        policyDecision: null,
        // PR #42 round-3: the ACTUAL WORK-037 decision that governed THIS
        // /github read, recorded in its OWN column (not masquerading as a
        // Tool Runtime invocation). Non-null for every governed read
        // (allow/constrained/deny/ask — the boundary always produces a
        // decision, even for path-not-allowed/operation-not-read refusals,
        // which it records as 'deny' with the boundary's refusal reason).
        repositoryReadDecision: g.decision,
        // PR #42 round-3 + round-4: the concrete enforcement effect (what
        // `constrained` actually did — OBSERVABLE) + the snapshot/fencing
        // metadata (revalidated + revalidatedPolicyVersion +
        // revalidatedRuleId + revalidatedDecision + stale). Carries the
        // policy version snapshot (drift detection), the matched rule id,
        // whether the read was performed, whether maxOutputBytes truncated
        // the content + at what byte offset, whether the path was in the
        // candidate allowlist, AND whether the snapshot was revalidated
        // current (the fence).
        repositoryReadEnforcement: g.enforcement,
      };
      evidence.push(ev);
      if (outcome.content) {
        contentByPath.set(candidate.path, outcome.content);
      }
    }

    // 3. Derive observations from governed content (OBSERVED + INFERRED).
    //    Uses the contentByPath map — a denied/blocked read is absent from
    //    the map, so derived observations depending on it are never
    //    produced (the policy gate is respected at the observation level,
    //    not just the evidence level — the boundary's governance propagates
    //    to the observation derivation).
    const packageJsonEvidence = evidence.find(
      (e) => e.locator === 'package.json',
    );
    const packageContent = contentByPath.get('package.json') ?? null;
    if (packageContent) {
      try {
        const pkg = JSON.parse(packageContent.content) as Record<string, unknown>;
        // The observed package claim is the FULL redacted package.json —
        // secret-shaped keys (e.g. `secret`, `token`, `apiKey`) are
        // replaced with [REDACTED] by the platform observation-redaction
        // util before persistence. This is the "secrets discovered during
        // analysis are not persisted" invariant: the claim carries the
        // redaction marker, never the raw secret.
        const observedPkg = redactForObservation(pkg) as Record<string, unknown>;
        if (Object.keys(observedPkg).length > 0) {
          observations.push({
            kind: 'package_managers',
            provenance: 'observed',
            claim: observedPkg,
            claimDigest: claimDigest(pkg),
            // PR #42 round-2 (Blocker A): observations reference evidence
            // by LOCATOR (the path), not by a manufactured
            // toolInvocationId. The orchestrator resolves locator→evidence
            // id by the composite (source, locator) key.
            evidenceRef: packageJsonEvidence ? [packageJsonEvidence.locator] : [],
          });
        }
        // build/test/lint commands (OBSERVED from scripts).
        const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
        const commandsClaim: Record<string, unknown> = {};
        for (const k of ['build', 'test', 'lint', 'typecheck', 'dev']) {
          if (typeof scripts[k] === 'string') commandsClaim[k] = scripts[k];
        }
        if (Object.keys(commandsClaim).length > 0) {
          observations.push({
            kind: 'build_commands',
            provenance: 'observed',
            claim: redactForObservation(commandsClaim) as Record<string, unknown>,
            claimDigest: claimDigest(commandsClaim),
            evidenceRef: packageJsonEvidence ? [packageJsonEvidence.locator] : [],
          });
        }
        // frameworks + languages (INFERRED from dependencies).
        const deps = {
          ...(pkg.dependencies as Record<string, string> | undefined),
          ...(pkg.devDependencies as Record<string, string> | undefined),
        };
        const frameworks: string[] = [];
        if (deps && typeof deps === 'object') {
          if ('next' in deps) frameworks.push('next');
          if ('react' in deps) frameworks.push('react');
          if ('vue' in deps) frameworks.push('vue');
          if ('@angular/core' in deps) frameworks.push('angular');
          if ('express' in deps) frameworks.push('express');
          if ('fastify' in deps) frameworks.push('fastify');
          if ('@prisma/client' in deps) frameworks.push('prisma');
        }
        if (frameworks.length > 0) {
          const frameworksClaim = { frameworks, inferredFrom: 'package.json dependencies' };
          observations.push({
            kind: 'frameworks',
            provenance: 'inferred',
            claim: redactForObservation(frameworksClaim) as Record<string, unknown>,
            claimDigest: claimDigest(frameworksClaim),
            evidenceRef: packageJsonEvidence ? [packageJsonEvidence.locator] : [],
          });
        }
        // languages (INFERRED from package.json presence → javascript/typescript).
        const languagesClaim = {
          languages: ['javascript', 'typescript'],
          inferredFrom: 'package.json presence',
        };
        observations.push({
          kind: 'languages',
          provenance: 'inferred',
          claim: redactForObservation(languagesClaim) as Record<string, unknown>,
          claimDigest: claimDigest(languagesClaim),
          evidenceRef: packageJsonEvidence ? [packageJsonEvidence.locator] : [],
        });
      } catch {
        // package.json present but unparseable — record nothing (the
        // observed read still produced evidence; the inference is skipped).
        // This is NOT an infrastructure failure (the content WAS read);
        // the analyzer continues with remaining candidates.
      }
    }

    // 4. CI observation (OBSERVED from .github/workflows listing).
    const ciContent = contentByPath.get('.github/workflows') ?? null;
    if (ciContent) {
      const workflows = ciContent.content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('file:'))
        .map((l) => l.replace(/^file:/, ''));
      const ciClaim = {
        ciConfigured: true,
        workflows,
        inferredFrom: '.github/workflows directory listing',
      };
      const ciEvidence = evidence.find((e) => e.locator === '.github/workflows');
      observations.push({
        kind: 'ci',
        provenance: 'observed',
        claim: redactForObservation(ciClaim) as Record<string, unknown>,
        claimDigest: claimDigest(ciClaim),
        evidenceRef: ciEvidence ? [ciEvidence.locator] : [],
      });
    }

    // 5. Deployment observation (INFERRED from Dockerfile presence).
    const dockerfileEvidence = evidence.find((e) => e.locator === 'Dockerfile');
    const dockerfileContent = contentByPath.get('Dockerfile') ?? null;
    if (dockerfileContent) {
      const deploymentClaim = {
        containerization: 'docker',
        inferredFrom: 'Dockerfile presence',
      };
      observations.push({
        kind: 'deployment',
        provenance: 'inferred',
        claim: redactForObservation(deploymentClaim) as Record<string, unknown>,
        claimDigest: claimDigest(deploymentClaim),
        evidenceRef: dockerfileEvidence ? [dockerfileEvidence.locator] : [],
      });
    }

    // 6. PROPOSED architecture — a suggested reconstruction, never an
    //    authoritative fact. The user/authorized workflow confirms through
    //    /architecture (the authority). The analyzer NEVER auto-freezes.
    const proposedArchClaim = {
      proposal: 'Reconstruct an Architecture Version from the observed repository structure.',
      basis: 'package.json frameworks + CI + containerization observations',
      authority: 'Requires user confirmation through /architecture (the architecture authority). The baseline observation is PROPOSED; it is NOT a frozen ArchitectureVersion.',
    };
    observations.push({
      kind: 'architecture',
      provenance: 'proposed',
      claim: redactForObservation(proposedArchClaim) as Record<string, unknown>,
      claimDigest: claimDigest(proposedArchClaim),
      evidenceRef: [],
    });

    const contentDigest = sha256(canonicalObservationSet(observations));
    return { observations, evidence, contentDigest };
  }
}

// Internal: the kind vocabulary is re-exported for the orchestrator.
export type { BaselineObservationKind };
