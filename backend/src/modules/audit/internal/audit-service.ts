import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type {
  AuditEvent,
  AuditService,
  WriteAuditEventInput,
  WorkflowAuditEmitter,
} from './audit.types.js';
import { PgAuditEventRepository } from './pg-audit-repository.js';

/**
 * Default {@link AuditService} — the application boundary for audit event
 * emission and querying (AUDIT-001).
 *
 * The service combines the writer + query contracts. Other modules receive
 * this via dependency injection and call `write()` to emit audit events.
 * They must NOT instantiate database clients to write audit rows directly.
 *
 * Append-only protection (AUDIT-AC-02): the underlying wfos_audit_events
 * table has BEFORE UPDATE OR DELETE triggers that reject normal application
 * mutations at the PostgreSQL level. The repository only performs INSERTs.
 *
 * Secret safety: the write() method does NOT accept raw credentials, tokens,
 * API keys, or SecretStore values. It accepts only safe identifiers/references
 * and structured metadata. An explicit filter strips known secret patterns
 * from metadata before persistence.
 */
export class DefaultAuditService implements AuditService, WorkflowAuditEmitter {
  private readonly repo: PgAuditEventRepository;

  constructor(
    db: DatabaseClient,
    private readonly logger: Logger,
  ) {
    this.repo = new PgAuditEventRepository(db);
  }

  // --- AuditEventWriter ---

  async write(input: WriteAuditEventInput): Promise<AuditEvent> {
    // Secret safety: strip known secret patterns from metadata.
    const safeMetadata = stripSecrets(input.metadata ?? {});
    const safeBefore = input.beforeState ? stripSecrets(input.beforeState) : null;
    const safeAfter = input.afterState ? stripSecrets(input.afterState) : null;

    const event = await this.repo.create({
      ...input,
      metadata: safeMetadata,
      beforeState: safeBefore,
      afterState: safeAfter,
    });

    this.logger.info('audit.event.written', {
      eventId: event.id,
      eventType: event.eventType,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
    });

    return event;
  }

  // --- WorkflowAuditEmitter ---

  async emitWorkflowTransition(input: {
    workItemId: string;
    fromState: string;
    toState: string;
    transitionType: string | null;
    actor: string | null;
    executionId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.write({
        eventType: 'WORKFLOW_TRANSITION',
        actor: input.actor ?? 'system',
        source: 'workflow-engine',
        resourceType: 'work_item',
        resourceId: input.workItemId,
        executionId: input.executionId,
        correlationId: input.executionId,
        beforeState: { state: input.fromState },
        afterState: { state: input.toState },
        metadata: {
          transitionType: input.transitionType,
          ...input.metadata,
        },
        workItemId: input.workItemId,
      });
    } catch (err) {
      // Audit failure must NOT roll back the transition (the transition is
      // authoritative; audit is supplementary forensic history).
      this.logger.error('audit.workflow_transition.failed', {
        workItemId: input.workItemId,
        fromState: input.fromState,
        toState: input.toState,
        error: (err as Error).message,
      });
    }
  }

  // --- AuditEventQuery ---

  async listForProject(projectId: string, opts?: { eventTypes?: string[]; limit?: number }): Promise<AuditEvent[]> {
    return this.repo.listForProject(projectId, opts);
  }

  async listForResource(resourceType: string, resourceId: string, opts?: { limit?: number }): Promise<AuditEvent[]> {
    return this.repo.listForResource(resourceType, resourceId, opts);
  }

  async listForWorkItem(workItemId: string, opts?: { limit?: number }): Promise<AuditEvent[]> {
    return this.repo.listForWorkItem(workItemId, opts);
  }
}

// --- Secret safety helper ---

/**
 * Strips known secret patterns from a metadata object. Recursively checks
 * string values for common secret indicators (key names containing 'secret',
 * 'password', 'token', 'apiKey', 'credential', 'privateKey').
 *
 * This is a defense-in-depth measure — callers should NOT pass secrets to
 * the audit API in the first place. This filter catches accidental leaks.
 */
function stripSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const SECRET_KEY_PATTERNS = /(?:secret|password|token|api_?key|credential|private_?key)/i;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_KEY_PATTERNS.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = stripSecrets(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
