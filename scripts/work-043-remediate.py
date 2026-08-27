from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def replace_once(path: str, old: str, new: str):
    p = ROOT / path
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"anchor not found: {path}")
    p.write_text(s.replace(old, new, 1))

def ensure_line(path: str, anchor: str, addition: str):
    p = ROOT / path
    s = p.read_text()
    if addition.strip() not in s:
        if anchor not in s:
            raise SystemExit(f"anchor not found: {path}")
        s = s.replace(anchor, addition + anchor, 1)
        p.write_text(s)

# A: eligibility evaluation is observational; never create a missing policy row.
replace_once(
    "backend/src/execution-policy/internal/default-execution-policy-service.ts",
    """    if (!policy && organizationId) {\n      policy = await this.deps.repository.insertDefaultProjectPolicy(organizationId, projectId);\n    }\n    if (!policy) {\n""",
    """    if (!policy) {\n""",
)

# B: organization scope is mandatory at the policy seam.
replace_once(
    "backend/src/execution-policy/types.ts",
    "  readonly organizationId?: string | null;",
    "  readonly organizationId: string;",
)

# C: provider-independent final admission boundary.
agent_types = ROOT / "backend/src/modules/agents/internal/execution.types.ts"
s = agent_types.read_text()
if "export interface ExecutionAdmissionPort" not in s:
    marker = "export interface ExecutionProvider {\n"
    i = s.index(marker)
    j = s.index("}\n\n", i) + 3
    addition = """
/** WORK-043: final hard-constraint admission boundary before provider dispatch. */
export interface ExecutionAdmissionResult {
  readonly admitted: boolean;
  readonly reason: string;
  readonly policyVersion: number | null;
  readonly blockingReasons: readonly {
    readonly category: string;
    readonly constraint: string;
    readonly reason: string;
  }[];
}

export interface ExecutionAdmissionPort {
  admit(task: ExecutionTask): Promise<ExecutionAdmissionResult>;
}
"""
    agent_types.write_text(s[:j] + addition + s[j:])

admission = ROOT / "backend/src/execution-policy/internal/default-execution-admission-service.ts"
if not admission.exists():
    admission.write_text("""/** WORK-043: final execution admission boundary. */
import type { Logger } from '@platform/logger.js';
import type { ExecutionTask, ExecutionAdmissionPort, ExecutionAdmissionResult } from '@modules/agents';
import type { ExecutionPolicyService } from '../types.js';

export interface ProjectOrganizationResolver {
  getOrganizationId(projectId: string): Promise<string | null>;
}

export interface DefaultExecutionAdmissionServiceDeps {
  readonly executionPolicyService: ExecutionPolicyService;
  readonly organizationResolver: ProjectOrganizationResolver;
  readonly logger: Logger;
}

export class DefaultExecutionAdmissionService implements ExecutionAdmissionPort {
  constructor(private readonly deps: DefaultExecutionAdmissionServiceDeps) {}

  async admit(task: ExecutionTask): Promise<ExecutionAdmissionResult> {
    const organizationId = await this.deps.organizationResolver.getOrganizationId(task.projectId);
    if (!organizationId) {
      return {
        admitted: false,
        reason: 'execution-admission-organization-unresolvable',
        policyVersion: null,
        blockingReasons: [{
          category: 'organization',
          constraint: 'project_organization_resolution',
          reason: `Organization for project ${task.projectId} could not be resolved.`,
        }],
      };
    }
    try {
      const verdict = await this.deps.executionPolicyService.evaluateCandidateEligibility({
        organizationId,
        projectId: task.projectId,
        workItemId: task.workItemId,
        provider: task.provider,
        model: task.model,
        executionMode: task.mode,
        userId: null,
      });
      return {
        admitted: verdict.eligibility.eligible,
        reason: verdict.eligibility.eligible
          ? 'execution-admitted-current-hard-constraints'
          : 'execution-admission-hard-constraint-block',
        policyVersion: verdict.policyVersion,
        blockingReasons: verdict.eligibility.blockingReasons,
      };
    } catch (error) {
      this.deps.logger.error('execution-admission.evaluation-failed', {
        projectId: task.projectId,
        executionId: task.executionId,
        error: (error as Error).message,
      });
      return {
        admitted: false,
        reason: 'execution-admission-evaluation-failed',
        policyVersion: null,
        blockingReasons: [{
          category: 'policy',
          constraint: 'evaluation',
          reason: (error as Error).message,
        }],
      };
    }
  }
}
""")

# Export the contract/service.
idx = ROOT / "backend/src/execution-policy/index.ts"
s = idx.read_text()
if "ExecutionAdmissionPort," not in s:
    s = s.replace("  CandidateEligibilityResult,\n", "  CandidateEligibilityResult,\n  ExecutionAdmissionResult,\n  ExecutionAdmissionPort,\n", 1)
if "DefaultExecutionAdmissionService" not in s:
    s = s.replace(
        "export { DefaultExecutionEligibilityService }",
        "export { DefaultExecutionAdmissionService } from './internal/default-execution-admission-service.js';\nexport { DefaultExecutionEligibilityService }",
        1,
    )
idx.write_text(s)

# Cross-mode destination re-eligibility must use authoritative organization scope.
p = ROOT / "backend/src/modules/agents/internal/default-cross-mode-handoff-service.ts"
s = p.read_text()
s = s.replace("  evaluateCandidateEligibility?(input: {", "  evaluateCandidateEligibility(input: {", 1)
s = s.replace("    organizationId?: string | null;", "    organizationId: string;", 1)
if "interface CrossModeProjectOrganizationResolver" not in s:
    marker = "export interface CrossModeAgentProviderRegistryPort {"
    resolver = """/** WORK-043: authoritative Project → Organization resolver. */
export interface CrossModeProjectOrganizationResolver {
  getOrganizationId(projectId: string): Promise<string | null>;
}

"""
    s = s.replace(marker, resolver + marker, 1)
if "readonly organizationResolver: CrossModeProjectOrganizationResolver;" not in s:
    s = s.replace(
        "  readonly executionPolicyService: CrossModeExecutionPolicyPort;\n",
        "  readonly executionPolicyService: CrossModeExecutionPolicyPort;\n  readonly organizationResolver: CrossModeProjectOrganizationResolver;\n",
        1,
    )
old = """    const seam = this.deps.executionPolicyService.evaluateCandidateEligibility;
    if (!seam) {
      // Pre-WORK-043 port — the destination gate is not wired. Compose a
      // skip marker so the log row records the gate's absence honestly.
      return composeSummary(policySummary, {
        destinationEligibility: { status: 'not_evaluated', eligible: null, reason: 'WORK-043 destination eligibility seam not wired' },
      });
    }
    let verdict;
    try {
      verdict = await seam.call(
        this.deps.executionPolicyService,
        {
          // No organization context at the handoff service layer: the
          // org-scoped families are inactive; the per-execution agent-policy
          // gate (step 6) already enforces the external domain STRICTER.
          organizationId: null,
          projectId: record.projectId,
          workItemId: record.workItemId,
          provider,
          model,
          executionMode: input.targetMode,
          userId: actor.userId,
        },
      );
"""
new = """    const organizationId = await this.deps.organizationResolver.getOrganizationId(record.projectId);
    if (!organizationId) {
      throw new CrossModeHandoffError(
        `handoff-ineligible-destination: organization for project ${record.projectId} could not be resolved — failing closed`,
        'handoff-ineligible-destination',
      );
    }
    let verdict;
    try {
      verdict = await this.deps.executionPolicyService.evaluateCandidateEligibility({
        organizationId,
        projectId: record.projectId,
        workItemId: record.workItemId,
        provider,
        model,
        executionMode: input.targetMode,
        userId: actor.userId,
      });
"""
if old not in s:
    raise SystemExit("cross-mode destination gate anchor not found")
s = s.replace(old, new, 1)
p.write_text(s)

# Final admission before provider submit.
p = ROOT / "backend/src/modules/agents/internal/execution-service.ts"
s = p.read_text()
if "ExecutionAdmissionPort," not in s:
    s = s.replace("  CreateExecutionRecordInput,\n", "  CreateExecutionRecordInput,\n  ExecutionAdmissionPort,\n", 1)
if "readonly executionAdmission: ExecutionAdmissionPort;" not in s:
    s = s.replace(
        "  readonly sessionService?: ExecutionSessionService;\n",
        "  readonly sessionService?: ExecutionSessionService;\n  readonly executionAdmission: ExecutionAdmissionPort;\n",
        1,
    )
old = """    // 3. Dispatch through the provider boundary.
    let submission;
"""
new = """    // 3. Final hard-constraint admission immediately before provider dispatch.
    const admission = await this.deps.executionAdmission.admit(task);
    if (!admission.admitted) {
      const reason = admission.blockingReasons.map((b) => `${b.category}/${b.constraint}: ${b.reason}`).join('; ');
      throw new Error(`execution-admission-denied: ${admission.reason}${reason ? ` (${reason})` : ''}`);
    }

    // 3b. Dispatch through the provider boundary.
    let submission;
"""
if old not in s:
    raise SystemExit("execution-service dispatch anchor not found")
s = s.replace(old, new, 1)
p.write_text(s)

# Production composition root.
p = ROOT / "backend/src/app.ts"
s = p.read_text()
if "DefaultExecutionAdmissionService" not in s:
    s = s.replace("  DefaultExecutionPolicyService,\n", "  DefaultExecutionPolicyService,\n  DefaultExecutionAdmissionService,\n", 1)
if "const executionAdmissionService = new DefaultExecutionAdmissionService" not in s:
    ctor = """    const executionAdmissionService = new DefaultExecutionAdmissionService({
      executionPolicyService,
      organizationResolver: {
        getOrganizationId: async (projectId) => (await projectRepository!.findById(projectId))?.organizationId ?? null,
      },
      logger,
    });
"""
    s = s.replace("    executionService = new DefaultExecutionService({\n", ctor + "    executionService = new DefaultExecutionService({\n", 1)
if "executionAdmission: executionAdmissionService" not in s:
    s = s.replace("      sessionService: executionSessionService,\n    });\n", "      sessionService: executionSessionService,\n      executionAdmission: executionAdmissionService,\n    });\n", 1)
marker = "    crossModeHandoffService = new DefaultCrossModeHandoffService({\n"
start = s.index(marker)
end = s.index("\n    });", start)
block = s[start:end]
if "organizationResolver:" not in block:
    block = block.replace("      executionPolicyService,\n", "      executionPolicyService,\n      organizationResolver: {\n        getOrganizationId: async (projectId) => (await projectRepository!.findById(projectId))?.organizationId ?? null,\n      },\n", 1)
    s = s[:start] + block + s[end:]
p.write_text(s)

# Test construction sites: add a permissive explicit admission fake without touching semantics.
line = "      executionAdmission: { admit: async () => ({ admitted: true, reason: 'test-permit', policyVersion: null, blockingReasons: [] }) },\n"
for path in (ROOT / "backend/tests").rglob("*.ts"):
    text = path.read_text()
    if "new DefaultExecutionService({" not in text or "executionAdmission:" in text:
        continue
    out = []
    i = 0
    while True:
        start = text.find("new DefaultExecutionService({", i)
        if start < 0:
            out.append(text[i:])
            break
        out.append(text[i:start])
        depth = 0
        j = start + len("new DefaultExecutionService(")
        while j < len(text):
            if text[j] == "{": depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0: break
            j += 1
        obj = text[start:j+1]
        if "executionAdmission:" not in obj:
            obj = obj[:-1] + "\n" + line + "  }"
        out.append(obj)
        i = j + 1
    new_text = "".join(out)
    if new_text != text:
        path.write_text(new_text)

# Focused regression for the admission service.
test = ROOT / "backend/tests/integration/execution-policy/execution-admission.regression.test.ts"
if not test.exists():
    test.write_text("""import { describe, expect, it, vi } from 'vitest';
import { DefaultExecutionAdmissionService } from '../../src/execution-policy/internal/default-execution-admission-service.js';

describe('WORK-043 execution admission boundary', () => {
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

  it('fails closed without authoritative organization scope', async () => {
    const evaluateCandidateEligibility = vi.fn();
    const service = new DefaultExecutionAdmissionService({
      executionPolicyService: { evaluateCandidateEligibility } as never,
      organizationResolver: { getOrganizationId: async () => null },
      logger,
    });
    const result = await service.admit({ projectId: 'p', executionId: 'e' } as never);
    expect(result.admitted).toBe(false);
    expect(evaluateCandidateEligibility).not.toHaveBeenCalled();
  });

  it('passes authoritative organization scope into current eligibility', async () => {
    const evaluateCandidateEligibility = vi.fn().mockResolvedValue({
      eligibility: { eligible: false, status: 'quota_exhausted', blockingReasons: [{ category: 'quota', constraint: 'daily', reason: 'exhausted' }] },
      policyVersion: 4,
    });
    const service = new DefaultExecutionAdmissionService({
      executionPolicyService: { evaluateCandidateEligibility } as never,
      organizationResolver: { getOrganizationId: async () => 'org-a' },
      logger,
    });
    const result = await service.admit({ projectId: 'p', executionId: 'e', workItemId: 'w', provider: 'fake', model: 'm', mode: 'native' } as never);
    expect(result.admitted).toBe(false);
    expect(evaluateCandidateEligibility).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a' }));
  });
});
""")

print('WORK-043 remediation applied')
