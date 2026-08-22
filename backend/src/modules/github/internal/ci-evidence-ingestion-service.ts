import type { Logger } from '@platform/logger.js';
import type { GitHubInstallationRepository } from './github.types.js';
import type {
  CiRunEvidence,
  CiArtifactReference,
  CiEvidenceIngestionService,
  CiEvidenceIngestionRepository,
} from './ci-evidence.types.js';

/**
 * Default {@link CiEvidenceIngestionService} — translates GitHub Actions
 * `check_run` and `workflow_run` webhook payloads into provider-independent
 * CI evidence rows (GITHUB-006).
 *
 * Boundary ownership (frozen architecture §24, §25; GH6-AC-02):
 *   This service is owned by /github and ONLY ingests + translates. It does
 *   NOT evaluate acceptance criteria. /verification reads the resulting
 *   CiRunEvidence rows via the {@link CiEvidenceIngestionRepository} contract
 *   and interprets them as Evidence + CriterionEvidenceMappings.
 *
 * Idempotency (GITHUB-004): the underlying UNIQUE(provider, external_run_id)
 * constraint makes re-processing the same GitHub Actions event idempotent —
 * one CI evidence row, updated in place.
 *
 * Tenant isolation: the project_id is resolved from the installation →
 * project association (the same mechanism as the WORK-008 webhook processing
 * service). A payload whose installation is not associated with any project
 * is dropped (returns null) — it cannot be ingested as evidence for an
 * unrelated tenant.
 */
export class DefaultCiEvidenceIngestionService implements CiEvidenceIngestionService {
  constructor(
    private readonly ingestionRepo: CiEvidenceIngestionRepository,
    private readonly installationRepo: GitHubInstallationRepository,
    private readonly logger: Logger,
  ) {}

  async ingestFromWebhookPayload(input: {
    webhookEventId: string;
    eventType: string;
    payload: string;
  }): Promise<CiRunEvidence | null> {
    // Parse the GitHub payload.
    let parsed: GitHubCiPayload;
    try {
      parsed = JSON.parse(input.payload) as GitHubCiPayload;
    } catch {
      this.logger.warn('ci_evidence.invalid_payload', {
        webhookEventId: input.webhookEventId,
        eventType: input.eventType,
      });
      return null;
    }

    // Only check_run / workflow_run events carry CI results.
    if (input.eventType !== 'check_run' && input.eventType !== 'workflow_run') {
      return null;
    }

    // Resolve the project from the installation → project association.
    const installationId = parsed.installation?.id?.toString();
    if (!installationId) {
      this.logger.warn('ci_evidence.no_installation', {
        webhookEventId: input.webhookEventId,
        eventType: input.eventType,
      });
      return null;
    }
    const installation = await this.installationRepo.findByInstallationId(installationId);
    if (!installation) {
      // Invalid/unknown repository mapping behavior (per the WORK-015 prompt):
      // an installation not associated with any project cannot have its CI
      // evidence ingested. Drop the event — no evidence row is created.
      this.logger.info('ci_evidence.no_project_for_installation', {
        webhookEventId: input.webhookEventId,
        installationId,
      });
      return null;
    }
    const projectId = installation.projectId;

    // Extract the canonical fields from the GitHub-native payload.
    const externalRunId = extractExternalRunId(input.eventType, parsed);
    if (!externalRunId) {
      this.logger.warn('ci_evidence.no_run_id', {
        webhookEventId: input.webhookEventId,
        eventType: input.eventType,
      });
      return null;
    }

    const repoFullName = parsed.repository?.full_name ?? null;
    const headSha = extractHeadSha(input.eventType, parsed);
    const branch = extractBranch(input.eventType, parsed);
    const workflowName = extractWorkflowName(input.eventType, parsed);
    const checkName = extractCheckName(input.eventType, parsed);
    const status = extractStatus(input.eventType, parsed);
    const conclusion = extractConclusion(input.eventType, parsed);
    const runUrl = extractRunUrl(input.eventType, parsed);
    const runStartedAt = extractStartedAt(input.eventType, parsed);
    const runCompletedAt = extractCompletedAt(input.eventType, parsed);
    const artifactReferences = extractArtifactReferences(input.eventType, parsed);
    const providerMetadata = extractProviderMetadata(input.eventType, parsed);

    const result = await this.ingestionRepo.upsert({
      projectId,
      externalRunId,
      workflowName,
      checkName,
      repositoryFullName: repoFullName,
      headSha,
      branch,
      status,
      conclusion,
      runUrl,
      runStartedAt,
      runCompletedAt,
      artifactReferences,
      providerMetadata,
      webhookEventId: input.webhookEventId,
    });

    this.logger.info('ci_evidence.ingested', {
      ciEvidenceId: result.id,
      projectId,
      externalRunId,
      workflowName,
      headSha,
      conclusion,
    });
    return result;
  }
}

// --- GitHub-native payload shape (internal to /github) ---

interface GitHubCiPayload {
  action?: string;
  check_run?: {
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string;
    html_url?: string;
    started_at?: string;
    completed_at?: string;
    head_sha?: string;
    head_branch?: string | null;
    check_suite?: {
      head_branch?: string | null;
      head_sha?: string;
    };
    output?: {
      title?: string;
      summary?: string;
    };
  };
  workflow_run?: {
    id?: number;
    name?: string;
    head_branch?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string;
    html_url?: string;
    run_started_at?: string;
    updated_at?: string;
    path?: string;
    workflow_id?: number;
  };
  workflow?: {
    name?: string;
    path?: string;
  };
  repository?: {
    id?: number;
    full_name?: string;
  };
  installation?: {
    id?: number;
  };
}

function extractExternalRunId(eventType: string, p: GitHubCiPayload): string | null {
  if (eventType === 'check_run') {
    const id = p.check_run?.id;
    return id != null ? `check_run:${id}` : null;
  }
  if (eventType === 'workflow_run') {
    const id = p.workflow_run?.id;
    return id != null ? `workflow_run:${id}` : null;
  }
  return null;
}

function extractHeadSha(eventType: string, p: GitHubCiPayload): string | null {
  if (eventType === 'check_run') {
    return p.check_run?.head_sha ?? p.check_run?.check_suite?.head_sha ?? null;
  }
  if (eventType === 'workflow_run') {
    return p.workflow_run?.head_sha ?? null;
  }
  return null;
}

function extractBranch(eventType: string, p: GitHubCiPayload): string | null {
  if (eventType === 'check_run') {
    return p.check_run?.head_branch ?? p.check_run?.check_suite?.head_branch ?? null;
  }
  if (eventType === 'workflow_run') {
    return p.workflow_run?.head_branch ?? null;
  }
  return null;
}

function extractWorkflowName(eventType: string, p: GitHubCiPayload): string | null {
  if (eventType === 'workflow_run') {
    return p.workflow_run?.name ?? p.workflow?.name ?? null;
  }
  if (eventType === 'check_run') {
    // check_run has a workflow context if available.
    return p.workflow?.name ?? null;
  }
  return null;
}

function extractCheckName(eventType: string, p: GitHubCiPayload): string | null {
  if (eventType === 'check_run') {
    return p.check_run?.name ?? null;
  }
  return null;
}

function extractStatus(eventType: string, p: GitHubCiPayload): string | null {
  if (eventType === 'check_run') return p.check_run?.status ?? null;
  if (eventType === 'workflow_run') return p.workflow_run?.status ?? null;
  return null;
}

function extractConclusion(eventType: string, p: GitHubCiPayload): string | null {
  if (eventType === 'check_run') return p.check_run?.conclusion ?? null;
  if (eventType === 'workflow_run') return p.workflow_run?.conclusion ?? null;
  return null;
}

function extractRunUrl(eventType: string, p: GitHubCiPayload): string | null {
  if (eventType === 'check_run') return p.check_run?.html_url ?? null;
  if (eventType === 'workflow_run') return p.workflow_run?.html_url ?? null;
  return null;
}

function extractStartedAt(eventType: string, p: GitHubCiPayload): Date | null {
  const raw = eventType === 'check_run'
    ? p.check_run?.started_at
    : eventType === 'workflow_run'
      ? p.workflow_run?.run_started_at
      : null;
  return raw ? new Date(raw) : null;
}

function extractCompletedAt(eventType: string, p: GitHubCiPayload): Date | null {
  const raw = eventType === 'check_run'
    ? p.check_run?.completed_at
    : eventType === 'workflow_run'
      ? p.workflow_run?.updated_at
      : null;
  return raw ? new Date(raw) : null;
}

function extractArtifactReferences(_eventType: string, p: GitHubCiPayload): CiArtifactReference[] {
  // GitHub's check_run/workflow_run payloads don't embed artifact binaries —
  // they only reference artifact metadata. For WORK-015 we capture the
  // available metadata (output title/summary) as inline references. Full
  // artifact body download is a future enhancement that would write to
  // ObjectStore and populate storageKey.
  const refs: CiArtifactReference[] = [];
  if (p.check_run?.output?.summary) {
    refs.push({
      name: 'check-output-summary',
      contentType: 'text/plain',
      metadata: { title: p.check_run.output.title, summary: p.check_run.output.summary },
    });
  }
  return refs;
}

function extractProviderMetadata(eventType: string, p: GitHubCiPayload): Record<string, unknown> {
  // Preserve raw provider metadata for traceability. /verification never
  // interprets this — it's kept only for audit/debugging.
  return {
    eventType,
    action: p.action ?? null,
    repositoryId: p.repository?.id ?? null,
    repositoryFullName: p.repository?.full_name ?? null,
    installationId: p.installation?.id ?? null,
    rawCheckRunId: p.check_run?.id ?? null,
    rawWorkflowRunId: p.workflow_run?.id ?? null,
    rawWorkflowId: p.workflow_run?.workflow_id ?? null,
    workflowPath: p.workflow?.path ?? null,
  };
}
