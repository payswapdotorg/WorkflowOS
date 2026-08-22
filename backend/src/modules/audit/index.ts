/**
 * audit module — public interface.
 *
 * Canonical name: /audit
 * Responsibility (spec/architecture.md §31): Append-oriented audit trail for
 * privileged/domain actions.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-020: implements the authoritative /audit domain (AUDIT-001).
 * Owns AuditEvent persistence, audit event schema, event normalization,
 * append-only audit history, and audit query/read contracts.
 *
 * The audit system is forensic/governance infrastructure, not the source of
 * truth for underlying domain state. Audit ingestion must NEVER mutate domain
 * state (frozen architecture §31: "domain state → domain operation → audit
 * event" — NOT the reverse).
 */
import type { ModuleContract } from '@platform/module-contract.js';

export type {
  AuditEvent,
  WriteAuditEventInput,
  AuditEventWriter,
  AuditEventRepository,
  AuditEventQuery,
  AuditService,
  WorkflowAuditEmitter,
} from './internal/audit.types.js';

/**
 * Public capabilities exposed by the /audit module to other modules.
 */
export interface AuditModuleApi {
  // future: additional audit-domain methods consumed by other modules
}

/**
 * Frozen module contract for /audit.
 */
export const auditModule: ModuleContract & AuditModuleApi = {
  name: '/audit',
};

export default auditModule;
