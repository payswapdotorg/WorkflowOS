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
  /** Optional — when absent, the analyzer produces metadata-only observations. */
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
    const evidenceByLocator = new Map<string, string>();
    // The governed-read content (only for ALLOWED reads — a deny/ask blocks
    // the content, so derived observations depending on that content are
    // never produced). This is the "tool execution respects WORK-037 policy"
    // invariant at the analyzer level: a denied read cannot contribute
    // observed/inferred facts.
    const contentByPath = new Map<string, { content: string; contentDigest: string }>();
    for (const candidate of CANDIDATE_READS) {
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
      let content: { content: string; contentDigest: string } | null = null;
      const allowed = decision.decision === 'allow' || decision.decision === 'constrained';
      if (allowed && this.deps.contentPort) {
        try {
          if (candidate.operation === 'list') {
            const entries = await this.deps.contentPort.listDir(
              ctx.repositoryOwner,
              ctx.repositoryName,
              ctx.baselineCommitSha,
              candidate.path,
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
            );
          }
        } catch (err) {
          // A content-read failure is an observed failure (the evidence
          // records the policy decision + the read error); it does NOT abort
          // the baseline. The analyzer continues with remaining candidates.
          this.deps.logger.warn('onboarding.analyzer-content-read-failed', {
            path: candidate.path,
            error: (err as Error).message,
          });
        }
      }

      const ev: NewBaselineEvidence = {
        source: 'filesystem',
        locator: candidate.path,
        contentDigest: content?.contentDigest ?? null,
        redacted: true,
        toolInvocationId: invocationId,
        policyDecision: decision.decision,
      };
      evidence.push(ev);
      // The evidence row id is assigned by the repository on persist; the
      // orchestrator links observations to evidence after appendEvidence
      // returns the persisted ids. Here we record the locator for the
      // linking pass (observations that depend on this evidence reference
      // it by locator; the orchestrator rewrites evidenceRef to ids).
      if (content) {
        evidenceByLocator.set(candidate.path, invocationId);
        contentByPath.set(candidate.path, content);
      }
    }

    // 3. Derive observations from governed content (OBSERVED + INFERRED).
    //    Uses the contentByPath map — a denied read is absent from the map,
    //    so derived observations depending on it are never produced (the
    //    policy gate is respected at the observation level, not just the
    //    evidence level).
    const packageJsonEvidence = evidence.find(
      (e) => e.locator === 'package.json' && e.policyDecision !== 'deny' && e.policyDecision !== 'ask',
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
            evidenceRef: packageJsonEvidence ? [packageJsonEvidence.toolInvocationId ?? ''] : [],
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
            evidenceRef: packageJsonEvidence ? [packageJsonEvidence.toolInvocationId ?? ''] : [],
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
            evidenceRef: packageJsonEvidence ? [packageJsonEvidence.toolInvocationId ?? ''] : [],
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
          evidenceRef: packageJsonEvidence ? [packageJsonEvidence.toolInvocationId ?? ''] : [],
        });
      } catch {
        // package.json present but unparseable — record nothing (the
        // observed read still produced evidence; the inference is skipped).
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
      observations.push({
        kind: 'ci',
        provenance: 'observed',
        claim: redactForObservation(ciClaim) as Record<string, unknown>,
        claimDigest: claimDigest(ciClaim),
        evidenceRef: [],
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
        evidenceRef: dockerfileEvidence ? [dockerfileEvidence.toolInvocationId ?? ''] : [],
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
