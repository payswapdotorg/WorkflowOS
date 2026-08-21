#!/usr/bin/env bash
# Generates the 16 frozen WorkflowOS backend module skeletons.
# Each module gets:
#   - index.ts         public interface (ModuleContract) + module-specific API surface
#   - internal/README.md  marker that this directory is private to the module
#   - README.md        responsibility summary (from spec/architecture.md)
# Out of scope per WORK-001: any domain logic. These are boundary markers only.
set -euo pipefail

MODULES_DIR="/home/z/WorkflowOS/backend/src/modules"
mkdir -p "$MODULES_DIR"

# name|canonical|responsibility
entries=(
  "auth|/auth|Authentication, WorkflowOS user identity boundary (paired with /users)."
  "users|/users|WorkflowOS user records and identity resolution."
  "organizations|/organizations|Organizations, membership, project ownership hierarchy."
  "projects|/projects|Projects as the primary WorkflowOS container for a development effort."
  "architecture|/architecture|Architecture Management, ADRs, Architecture Change Requests, Architecture Versions."
  "specifications|/specifications|Specification documents and specification lifecycle."
  "requirements|/requirements|Requirements and Acceptance Criteria."
  "work-items|/work-items|Work Items, Work Item Dependencies, Work Order state."
  "workflows|/workflows|Workflow state machine, legal state transitions, orchestration."
  "verification|/verification|Verification, evidence, acceptance-criterion evaluation."
  "reviews|/reviews|Architect Reviews and Review Findings."
  "llm|/llm|LLM Gateway, architect role execution, Work-order generation."
  "agents|/agents|Agent Gateway and Agent Runs."
  "github|/github|GitHub App, GitHub webhooks, Pull Requests, CI integration."
  "notifications|/notifications|Optional provider-independent notification boundary."
  "audit|/audit|Append-oriented audit trail for privileged/domain actions."
)

for entry in "${entries[@]}"; do
  IFS='|' read -r dir name resp <<<"$entry"
  mod_dir="$MODULES_DIR/$dir"
  mkdir -p "$mod_dir/internal"

  # kebab-case -> PascalCase (e.g. work-items -> WorkItems) and camelCase (workItems)
  pascal="$(echo "$dir" | awk -F'-' '{for(i=1;i<=NF;i++){printf "%s%s", toupper(substr($i,1,1)), substr($i,2)}}' )"
  camel="$(echo "$dir" | awk -F'-' '{printf "%s", $1; for(i=2;i<=NF;i++){printf "%s%s", toupper(substr($i,1,1)), substr($i,2)}}')"
  upper="$pascal"
  snake="$camel"

  cat > "$mod_dir/index.ts" <<TS
/**
 * ${dir} module — public interface.
 *
 * Canonical name: ${name}
 * Responsibility (spec/architecture.md): ${resp}
 *
 * This file is the ONLY surface other modules may import. Files under
 * \`internal/\` are private to this module; cross-module imports of
 * \`internal/\` are forbidden and enforced statically (PLAT-AC-02).
 *
 * Domain logic for this module is out of scope for WORK-001 and will be added
 * by later work items. The contract marker is established here so the module
 * boundary exists mechanically from day one (PLAT-AC-01).
 */
import type { ModuleContract } from '@platform/module-contract.js';

/**
 * Public capabilities exposed by the ${name} module to other modules.
 *
 * Empty for WORK-001 (foundation). Future work items declare methods here and
 * implement them under \`internal/\`.
 */
export interface ${upper}ModuleApi {
  // future: provider-independent methods consumed by other modules
}

/**
 * Frozen module contract for ${name}.
 */
export const ${snake}Module: ModuleContract & ${upper}ModuleApi = {
  name: '${name}',
};

export default ${snake}Module;
TS

  cat > "$mod_dir/internal/README.md" <<MD
# \`internal/\` — private to the ${name} module

Files in this directory are implementation details of the **${name}** module.
Other modules MUST NOT import from here. Cross-module imports of
\`src/modules/${dir}/internal/**\` are rejected by the static architecture
check in \`tests/architecture/static-architecture.test.ts\` (PLAT-AC-02).

Public capabilities are exported from \`../index.ts\`.
MD

  cat > "$mod_dir/README.md" <<MD
# ${name}

**Responsibility (frozen):** ${resp}

This directory is a frozen backend module boundary (spec/architecture.md §6).
Cross-module communication must go through \`index.ts\`; \`internal/\` is private.
MD
done

echo "Generated $(ls -d "$MODULES_DIR"/*/ | wc -l) modules."
ls "$MODULES_DIR"
