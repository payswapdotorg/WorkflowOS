/**
 * Audit domain types (AUDIT-001, AUDIT-AC-01..02, WF-AUDIT-AC-01..02).
 *
 * The /audit module owns durable AuditEvent persistence. The audit trail is
 * append-oriented: normal application operations must not UPDATE or DELETE
 * audit events (frozen architecture §31).
 *
 * Authority direction (frozen architecture §31):
 *   domain state → domain operation → audit event
 * Audit ingestion must NEVER mutate domain state.
 */

// --- AuditEvent ---

export interface AuditEvent {
  readonly id: string;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly eventType: string;
  readonly actor: string;
  readonly source: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly executionId: string | null;
  readonly correlationId: string | null;
  readonly beforeState: Record<string, unknown> | null;
  readonly afterState: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown>;
  readonly workItemId: string | null;
  readonly workOrderId: string | null;
  readonly architectureVersionId: string | null;
  readonly reviewId: string | null;
  readonly verificationRunId: string | null;
  readonly agentRunId: string | null;
  readonly pullRequestAssociationId: string | null;
  readonly createdAt: Date;
}

// --- Audit event writer (the application boundary for system/internal emission) ---

export interface WriteAuditEventInput {
  organizationId?: string | null;
  projectId?: string | null;
  eventType: string;
  actor: string;
  source?: string;
  resourceType: string;
  resourceId: string;
  executionId?: string | null;
  correlationId?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  workItemId?: string | null;
  workOrderId?: string | null;
  architectureVersionId?: string | null;
  reviewId?: string | null;
  verificationRunId?: string | null;
  agentRunId?: string | null;
  pullRequestAssociationId?: string | null;
}

/**
 * The AuditEventWriter is the ONLY application boundary for writing audit
 * events. Other modules receive this via dependency injection and call
 * `write()` to emit audit events. They must NOT instantiate database clients
 * to write audit rows directly.
 */
export interface AuditEventWriter {
  write(input: WriteAuditEventInput): Promise<AuditEvent>;
}

// --- Audit event repository (persistence) ---

export interface AuditEventRepository {
  create(input: WriteAuditEventInput): Promise<AuditEvent>;
  findById(id: string): Promise<AuditEvent | null>;
  listForProject(projectId: string, opts?: { eventTypes?: string[]; limit?: number }): Promise<AuditEvent[]>;
  listForResource(resourceType: string, resourceId: string, opts?: { limit?: number }): Promise<AuditEvent[]>;
  listForWorkItem(workItemId: string, opts?: { limit?: number }): Promise<AuditEvent[]>;
}

// --- Audit event query (read contract for authorized callers) ---

export interface AuditEventQuery {
  listForProject(projectId: string, opts?: { eventTypes?: string[]; limit?: number }): Promise<AuditEvent[]>;
  listForResource(resourceType: string, resourceId: string, opts?: { limit?: number }): Promise<AuditEvent[]>;
  listForWorkItem(workItemId: string, opts?: { limit?: number }): Promise<AuditEvent[]>;
}

// --- Audit service (combines writer + query) ---

/**
 * The AuditService combines the writer + query contracts. It is the public
 * surface that other modules receive via dependency injection.
 */
export interface AuditService extends AuditEventWriter, AuditEventQuery, WorkflowAuditEmitter {}

// --- Workflow audit emission callback ---
//
// The WorkflowEngine accepts an optional callback to emit audit events on
// successful transitions. This keeps the audit boundary clean: the engine
// receives a typed callback rather than importing /audit/internal.

export interface WorkflowAuditEmitter {
  /**
   * Emit a workflow transition audit event. Called after a successful
   * transition is persisted. Must NOT throw — audit failure should not
   * roll back the transition (the transition is authoritative; audit is
   * supplementary forensic history).
   */
  emitWorkflowTransition(input: {
    workItemId: string;
    fromState: string;
    toState: string;
    transitionType: string | null;
    actor: string | null;
    executionId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}
