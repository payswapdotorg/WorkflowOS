/**
 * WORK-038: GovernedFilesystemAnalyzer — the default repository analyzer.
 *
 * Routes EVERY candidate read through the project-scoped ToolPolicyGate (the
 * WORK-037 boundary), records the decision as evidence, redacts secrets
 * (the platform observation-redaction util), and produces provenance-tagged
 * observations:
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
 * PR #42 round-2 review (Blocker A) — the /github read path is NOT a
 * ToolRuntime invocation:
 *   The analyzer consults the WORK-037 project-scoped policy gate
 *   (decideForProjectScope) for every candidate read; if the decision is
 *   'deny' or 'ask', the read is blocked (no content observed, no
 *   content-derived observations produced). If 'allow' or 'constrained',
 *   the read is delegated to the /github GitHubAdapter via the production
 *   RepositoryContentPort. That read is NOT a ToolRuntime.invoke — the
 *   /github adapter is the only SDK caller, but it is NOT the WORK-036
 *   governed tool execution boundary. The evidence row honestly records
 *   that: tool_invocation_id is NULL (no ToolRuntime invocation happened),
 *   policy_decision is NULL (no host tool run — the schema reserves
 *   policy_decision for "host tool run" audit trail). The WORK-037 gate
 *   consultation IS a runtime invariant (the analyzer refuses to proceed
 *   on deny/ask); it is not an evidence-row claim. The evidence-row
 *   idempotency key is the honest composite (baseline_id, source, locator).
 *   The observation→evidence linkage uses the locator (the path), not a
 *   manufactured toolInvocationId.
 *
 * PR #42 round-2 review (Blocker B) — distinguish expected-missing from
 * infrastructure failure:
 *   The RepositoryContentPort contract is explicit:
 *     * readFile returns null when the path does not exist at the revision.
 *     * listDir returns [] when the directory does not exist.
 *     * BOTH throw on infrastructure failure (GitHub unavailable,
 *       authentication failure, API failure, content retrieval
 *       infrastructure failure).
 *   The analyzer's per-candidate content read has NO try/catch —
 *   infrastructure failures propagate as a typed OnboardingAnalysisError so
 *   the orchestrator can markFailed the baseline (a baseline must NEVER
 *   reach 'complete' when the required repository analysis could not
 *   actually inspect the repository). Expected-missing (null/[]) and
 *   unparseable JSON (the package.json parse try/catch) are NOT
 *   infrastructure failures — those are handled gracefully (the analyzer
 *   continues with remaining candidates; the baseline still completes with
 *   whatever observations could be derived).
 *
 * Deep stack/security/deployment scanning is WORK-039+ (STRICTLY OUT OF
 * SCOPE). The foundation analyzer demonstrates the governed provenance model
 * end-to-end on a bounded candidate set; the port is extensible.
 *
 * Boundary: src/onboarding/ — application capability, NOT a module, NOT an
 * authority. No provider SDKs, no credentials, no DB access (the orchestrator
 * persists observations through the /projects repository).
 */
import { createHash } from 'node:crypto';
import { redactForObservation } from '@platform/tools/observation-redaction.js';
import type { Logger } from '@platform/logger.js';
import type { ToolPolicyRequest } from '@modules/agents/index.js';
import type {
  BaselineObservationKind,
  NewBaselineEvidence,
  NewBaselineObservation,
} from '@modules/projects/index.js';
import type {
  AnalysisContext,
  AnalysisResult,
  GovernedReadRequest,
  ProjectScopedPolicyGate,
  RepositoryAnalyzer,
  RepositoryContentPort,
} from '../onboarding.types.js';
import { OnboardingAnalysisError } from '../onboarding.types.js';

/** The candidate paths the foundation analyzer inspects (bounded, extensible). */
const CANDIDATE_READS: readonly GovernedReadRequest[] = [
  { path: 'package.json', family: 'filesystem', operation: 'read' },
  { path: 'README.md', family: 'filesystem', operation: 'read' },
  { path: '.github/workflows', family: 'filesystem', operation: 'list' },
  { path: 'Dockerfile', family: 'filesystem', operation: 'read' },
  { path: 'docker-compose.yml', family: 'filesystem', operation: 'read' },
  { path: 'prisma/schema.prisma', family: 'filesystem', operation: 'read' },
];

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

export interface GovernedFilesystemAnalyzerDeps {
  /**
   * The repository content port. The PRODUCTION wiring (app.ts) injects
   * GitHubRepositoryContentPort (delegates to the /github GitHubAdapter);
   * tests inject an in-memory provider for deterministic governed analysis.
   * The port is consulted only for ALLOWED reads (deny/ask blocks the
   * content). The port's contract: readFile returns null when the path does
   * not exist at the revision; listDir returns [] when the directory does
   * not exist; BOTH throw on infrastructure failure (GitHub unavailable,
   * authentication failure, API failure, content retrieval infrastructure
   * failure). Infrastructure failures propagate as a typed
   * OnboardingAnalysisError so the orchestrator can markFailed the baseline
   * (PR #42 round-2 review Blocker B — a baseline must NEVER reach
   * 'complete' when the required repository analysis could not actually
   * inspect the repository).
   */
  readonly contentPort?: RepositoryContentPort;
  readonly policyGate: ProjectScopedPolicyGate;
  readonly logger: Logger;
}

export class GovernedFilesystemAnalyzer implements RepositoryAnalyzer {
  constructor(private readonly deps: GovernedFilesystemAnalyzerDeps) {}

  async analyze(ctx: AnalysisContext): Promise<AnalysisResult> {
    const observations: NewBaselineObservation[] = [];
    const evidence: NewBaselineEvidence[] = [];

    // 1. OBSERVED repository_identity — established from the /github
    //    authority metadata carried in the context (owner, name, sha, ref).
    //    This is a directly-observed fact, not an inference.
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
      evidenceRef: [], // linked below after evidence is persisted
    });

    // 2. Governed candidate reads — each routed through the policy gate.
    //    PR #42 round-2 (Blocker A): the evidence row's tool_invocation_id
    //    is NULL (the /github read path is NOT a ToolRuntime invocation).
    //    The policy_decision is also NULL (no host tool run — the schema
    //    reserves policy_decision for "host tool run" audit trail). The
    //    WORK-037 gate consultation is a runtime invariant only.
    //    PR #42 round-2 (Blocker B): infrastructure failures (the port
    //    throws) propagate as a typed OnboardingAnalysisError; expected-
    //    missing (null/[]) is handled gracefully (the analyzer continues).
    const contentByPath = new Map<string, { content: string; contentDigest: string }>();
    for (const candidate of CANDIDATE_READS) {
      // The invocationId is a STABLE KEY for the policy gate's decision
      // (so the same read gets the same decision across retries). It is
      // NOT persisted as tool_invocation_id — there is no ToolRuntime
      // invocation. It is internal to the policy request only.
      const invocationId = `${ctx.analysisRunId}:${candidate.operation}:${candidate.path}`;
      const policyRequest: ToolPolicyRequest = {
        invocationId,
        executionId: `onboarding:${ctx.baselineId}`,
        sessionId: ctx.analysisRunId,
        workspaceId: `onboarding:${ctx.baselineId}`,
        family: candidate.family,
        operation: candidate.operation,
        input: redactForObservation({ path: candidate.path, mode: candidate.operation }) as Record<string, unknown>,
      };
      const decision = await this.deps.policyGate.decideForProjectScope(
        policyRequest,
        ctx.projectId,
        ctx.organizationId,
      );

      // Record the governed decision as evidence — even when the read is
      // blocked (the audit trail proves analysis respected the policy gate).
      // PR #42 round-2 (Blocker A): tool_invocation_id is NULL (no
      // ToolRuntime invocation); policy_decision is NULL (no host tool run).
      // The evidence row's audit value is the content_digest (NULL when the
      // read was blocked OR the path was absent) + the source + the locator
      // (the honest composite idempotency key).
      let content: { content: string; contentDigest: string } | null = null;
      const allowed = decision.decision === 'allow' || decision.decision === 'constrained';
      if (allowed && this.deps.contentPort) {
        // PR #42 round-2 (Blocker B): NO try/catch around the content read.
        // The port's contract: null/[] = expected-missing (the analyzer
        // continues); throw = infrastructure failure (the analyzer
        // propagates as a typed OnboardingAnalysisError so the orchestrator
        // can markFailed the baseline). The previous implementation's
        // try/catch swallowed GitHub-unavailable failures and produced a
        // false 'complete' baseline with only metadata observations.
        try {
          if (candidate.operation === 'list') {
            const entries = await this.deps.contentPort.listDir(
              ctx.repositoryOwner,
              ctx.repositoryName,
              ctx.baselineCommitSha,
              candidate.path,
              ctx.installationId,
            );
            if (entries.length > 0) {
              const listing = entries.map((e) => `${e.type}:${e.name}`).sort().join('\n');
              content = { content: listing, contentDigest: sha256(listing) };
            }
          } else {
            content = await this.deps.contentPort.readFile(
              ctx.repositoryOwner,
              ctx.repositoryName,
              ctx.baselineCommitSha,
              candidate.path,
              ctx.installationId,
            );
          }
        } catch (err) {
          // Infrastructure / content-provider failure (GitHub unavailable,
          // authentication failure, API failure, content retrieval
          // infrastructure failure). Propagate as a typed
          // OnboardingAnalysisError so the orchestrator can markFailed the
          // baseline — the baseline must NEVER reach 'complete' on a
          // content-provider failure (the required repository analysis
          // could not actually inspect the repository).
          this.deps.logger.error('onboarding.analyzer-content-read-infrastructure-failed', {
            path: candidate.path,
            operation: candidate.operation,
            error: (err as Error).message,
          });
          throw new OnboardingAnalysisError(
            'repository-content-unavailable',
            `repository-content-unavailable: the repository content provider threw an infrastructure failure reading '${candidate.path}' (${candidate.operation}) at revision ${ctx.baselineCommitSha} for ${ctx.repositoryOwner}/${ctx.repositoryName} — ${(err as Error).message}`,
            {
              failingLocator: candidate.path,
              cause: err,
              context: {
                owner: ctx.repositoryOwner,
                repository: ctx.repositoryName,
                commitSha: ctx.baselineCommitSha,
                path: candidate.path,
                operation: candidate.operation,
                underlyingError: (err as Error).message,
              },
            },
          );
        }
      }

      const ev: NewBaselineEvidence = {
        source: 'filesystem',
        locator: candidate.path,
        contentDigest: content?.contentDigest ?? null,
        redacted: true,
        // PR #42 round-2 (Blocker A): NULL — the /github read path is NOT
        // a ToolRuntime invocation. Do not manufacture toolInvocationIds
        // for operations that never went through Tool Runtime.
        toolInvocationId: null,
        // PR #42 round-2 (Blocker A): NULL — no host tool run. The
        // schema reserves policy_decision for "host tool run" audit trail
        // (a ToolRuntime invocation gated by decide()). The WORK-037
        // project-scoped gate IS consulted at runtime (the analyzer
        // refuses to proceed on deny/ask — that is the runtime
        // invariant); that consultation is not an evidence-row claim.
        policyDecision: null,
      };
      evidence.push(ev);
      if (content) {
        contentByPath.set(candidate.path, content);
      }
    }

    // 3. Derive observations from governed content (OBSERVED + INFERRED).
    //    Uses the contentByPath map — a denied read is absent from the map,
    //    so derived observations depending on it are never produced (the
    //    policy gate is respected at the observation level, not just the
    //    evidence level).
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
