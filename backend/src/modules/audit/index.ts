/**
 * audit module — public interface.
 *
 * Canonical name: /audit
 * Responsibility (spec/architecture.md): Append-oriented audit trail for privileged/domain actions.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * Domain logic for this module is out of scope for WORK-001 and will be added
 * by later work items. The contract marker is established here so the module
 * boundary exists mechanically from day one (PLAT-AC-01).
 */
import type { ModuleContract } from '@platform/module-contract.js';

/**
 * Public capabilities exposed by the /audit module to other modules.
 *
 * Empty for WORK-001 (foundation). Future work items declare methods here and
 * implement them under `internal/`.
 */
export interface AuditModuleApi {
  // future: provider-independent methods consumed by other modules
}

/**
 * Frozen module contract for /audit.
 */
export const auditModule: ModuleContract & AuditModuleApi = {
  name: '/audit',
};

export default auditModule;
