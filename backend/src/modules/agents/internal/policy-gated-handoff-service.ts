/**
 * WORK-037: PolicyGatedExecutionHandoffService — the composition-root
 * decorator that enforces agent-policy external-handoff eligibility on top
 * of the WORK-027 handoff boundary.
 *
 * The inner ExecutionHandoffService (DefaultExecutionHandoffService) is
 * UNCHANGED — its token issuance/redemption mechanics stay exactly as
 * WORK-027 defined them. This decorator wraps issue() + redeem() to gate
 * them through AgentPolicyEngine.evaluateExternalHandoff():
 *
 *   deny        → ExecutionHandoffError('handoff-policy-denied')        (403)
 *   ask         → ExecutionHandoffError('handoff-policy-approval-
 *                 required') with the pending approval id in the message (422)
 *   allow       → delegate to inner.issue()/redeem()
 *   constrained → delegate; on redeem, attach policyConstraints to the
 *                 returned package (ADVISORY to the external environment —
 *                 the external runtime is not WorkflowOS host; the
 *                 constraints are communicated, not enforced host-side)
 *
 * redeemByToken() (the WORK-028 companion path) is NOT gated here: the
 * companion authenticates by the one-time token ALONE, the token was
 * issued under a policy-allowed state (issue() gated), and the one-time
 * consumption semantics cannot be re-gated without resolving-then-
 * consuming the token (which would lose it). The issuance gate is the
 * policy authority for companion redemption; the route layer's
 * requireProjectAuthorization remains the user-authorization gate.
 *
 * The decorator is wired in app.ts; the inner service + existing tests
 * are untouched.
 */
import type { Logger } from '@platform/logger.js';
import type {
  CompanionRedeemedHandoff,
  ExecutionHandoffService,
  IssuedExecutionHandoff,
  RedeemedExecutionPackage,
} from './execution.types.js';
import { ExecutionHandoffError } from './execution.types.js';
import type { AgentPolicyExternalDecision } from './agent-policy.types.js';
import type { ToolPolicyConstraints } from './tool-runtime.types.js';

/** The narrow engine port the decorator depends on (DI cleanliness). */
export interface AgentPolicyHandoffEvaluator {
  evaluateExternalHandoff(input: { executionId: string }): Promise<AgentPolicyExternalDecision>;
}

export interface PolicyGatedExecutionHandoffServiceDeps {
  readonly inner: ExecutionHandoffService;
  readonly policy: AgentPolicyHandoffEvaluator;
  readonly logger: Logger;
}

export class PolicyGatedExecutionHandoffService implements ExecutionHandoffService {
  constructor(private readonly deps: PolicyGatedExecutionHandoffServiceDeps) {}

  async issue(executionId: string): Promise<IssuedExecutionHandoff> {
    const decision = await this.deps.policy.evaluateExternalHandoff({ executionId });
    this.assertAllowed(decision, executionId);
    return this.deps.inner.issue(executionId);
  }

  async redeem(executionId: string, rawToken: string): Promise<RedeemedExecutionPackage> {
    const decision = await this.deps.policy.evaluateExternalHandoff({ executionId });
    this.assertAllowed(decision, executionId);
    const pkg = await this.deps.inner.redeem(executionId, rawToken);
    if (decision.decision === 'constrained' && decision.constraints) {
      // Additive advisory field — the external runtime is communicated the
      // constraints; it is not WorkflowOS host and cannot be enforced.
      return { ...pkg, policyConstraints: decision.constraints } as RedeemedExecutionPackage & {
        policyConstraints: ToolPolicyConstraints;
      };
    }
    return pkg;
  }

  async redeemByToken(rawToken: string): Promise<CompanionRedeemedHandoff> {
    // See file header: the companion path is post-issuance delivery; the
    // issuance gate is the policy authority. Delegate unchanged.
    return this.deps.inner.redeemByToken(rawToken);
  }

  private assertAllowed(decision: AgentPolicyExternalDecision, executionId: string): void {
    if (decision.decision === 'deny') {
      throw new ExecutionHandoffError(
        `handoff-policy-denied: external handoff for execution ${executionId} is denied by agent policy (${decision.reason})`,
        'handoff-policy-denied',
      );
    }
    if (decision.decision === 'ask') {
      throw new ExecutionHandoffError(
        `handoff-policy-approval-required: external handoff for execution ${executionId} requires approval (${decision.reason})`,
        'handoff-policy-approval-required',
      );
    }
    // allow | constrained → proceed
  }
}
