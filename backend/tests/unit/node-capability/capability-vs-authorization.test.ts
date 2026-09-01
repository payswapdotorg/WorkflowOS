import { describe, it, expect } from 'vitest';
import {
  ELIGIBILITY_DIMENSIONS,
  NODE_ELIGIBILITY_REASON_CODES,
} from '../../../src/node-capability/index.js';
import { buildService, findEvaluation, registerTestNode } from './helpers.js';

/**
 * V2-004 — capability-vs-authorization discrimination (constitution §5,
 * V2-CTRL-003 authority rule `capability-advertisement-is-not-authorization`).
 *
 * Matching answers capability/placement/trust/health eligibility ONLY.
 * Authorization is an explicit, separate dimension that this protocol does
 * NOT decide. The regression proves three things:
 *
 *   1. an advertised capability an actor is NOT authorized for still reports
 *      capability-eligible, and never authorizes anything;
 *   2. a rejection for authorization reasons (produced OUTSIDE this module,
 *      by its owning authority) is structurally distinguishable from
 *      capability ineligibility;
 *   3. the API shape itself keeps them distinct: no authorization dimension,
 *      code, or field is representable in a match result.
 */

/**
 * An EXTERNAL authorization decision — owned by the authorization authority
 * (V1 /auth today, a V2 Work Order later), never by the node-capability
 * protocol. It is defined here ONLY to drive the discrimination regression;
 * the node-capability module never imports, computes, or embeds it.
 */
type ExternalAuthorizationDecision =
  | { readonly dimension: 'authorization'; readonly authorized: true }
  | {
      readonly dimension: 'authorization';
      readonly authorized: false;
      readonly reasonCode: 'ACTOR_NOT_AUTHORIZED_FOR_CAPABILITY';
      readonly capability: string;
    };

/** A deliberately external, test-local actor authorization policy. */
function decideActorAuthorization(actorId: string, capability: string): ExternalAuthorizationDecision {
  const grants: Record<string, readonly string[]> = {
    'human-resources-operator': ['contacts.read', 'contacts.search'],
    'automation-admin': ['workflow.execute', 'workflow.observe', 'messaging.send', 'contacts.read'],
  };
  const granted = grants[actorId] ?? [];
  if (granted.includes(capability)) {
    return { dimension: 'authorization', authorized: true };
  }
  return { dimension: 'authorization', authorized: false, reasonCode: 'ACTOR_NOT_AUTHORIZED_FOR_CAPABILITY', capability };
}

describe('V2-004 capability-vs-authorization discrimination', () => {
  it('reports capability-eligible for an advertised capability the actor is NOT authorized for (and authorizes nothing)', () => {
    const { service } = buildService();
    const android = registerTestNode(service, {
      seed: 'android-messaging',
      platformClass: 'android',
      capabilities: [{ name: 'messaging.send', version: 1, availability: 'available' }],
    });
    // The actor is not authorized for messaging.send…
    const decision = decideActorAuthorization('human-resources-operator', 'messaging.send');
    expect(decision.authorized).toBe(false);

    // …yet the node-capability protocol still answers the capability question
    // honestly: the node possesses the capability.
    const result = service.matchNodes({
      capabilities: [{ name: 'messaging.send' }],
      placement: { required: 'device_local' },
    });
    const evaluation = findEvaluation(result, android.nodeId);
    expect(evaluation.capabilityEligible).toBe(true);
    expect(evaluation.eligible).toBe(true);

    // Possession never becomes permission: the serialized result cannot even
    // express an authorization fact.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/authoriz|permission|granted|policy/i);
  });

  it('keeps authorization out of the protocol shape: no authorization dimension, code, or evaluation field', () => {
    const { service } = buildService();
    const web = registerTestNode(service, { seed: 'auth-shape', platformClass: 'web' });
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.observe' }],
      placement: { required: 'any_supported_node' },
    });
    const evaluation = findEvaluation(result, web.nodeId);

    // The evaluation exposes EXACTLY the protocol-owned dimensions.
    expect(Object.keys(evaluation).sort()).toEqual(
      [
        'capabilityEligible',
        'eligible',
        'healthEligible',
        'locationClass',
        'nodeId',
        'placementEligible',
        'placementRank',
        'platformClass',
        'protocolEligible',
        'reasons',
        'satisfiedPlacement',
        'trustEligible',
      ].sort(),
    );

    // The dimension vocabulary cannot represent authorization.
    expect(ELIGIBILITY_DIMENSIONS).toEqual(['protocol', 'capability', 'placement', 'trust', 'health']);
    expect(ELIGIBILITY_DIMENSIONS).not.toContain('authorization');
    // The reason-code namespace has no authorization-ish code.
    for (const code of NODE_ELIGIBILITY_REASON_CODES) {
      expect(code).not.toMatch(/AUTHORIZ|PERMISSION|CONSENT|GRANT/);
    }
    // Reason dimensions come only from the protocol-owned dimension set.
    for (const reason of evaluation.reasons) {
      expect(ELIGIBILITY_DIMENSIONS).toContain(reason.dimension);
    }
  });

  it('an authorization rejection is structurally distinguishable from capability ineligibility', () => {
    const { service } = buildService();
    // Node A advertises messaging.send; node B does not.
    const android = registerTestNode(service, {
      seed: 'android-messaging-2',
      platformClass: 'android',
      capabilities: [{ name: 'messaging.send', version: 1, availability: 'available' }],
    });
    const cloud = registerTestNode(service, { seed: 'cloud-no-messaging', platformClass: 'cloud' });
    const requirement = {
      capabilities: [{ name: 'messaging.send' as const }],
      placement: { required: 'any_supported_node' as const },
    };
    const result = service.matchNodes(requirement);

    const possessed = findEvaluation(result, android.nodeId);
    const missing = findEvaluation(result, cloud.nodeId);
    expect(possessed.capabilityEligible).toBe(true);
    expect(missing.capabilityEligible).toBe(false);
    expect(missing.reasons[0]?.code).toBe('CAPABILITY_NOT_ADVERTISED');
    expect(missing.reasons[0]?.dimension).toBe('capability');

    // The external authorization rejection for the actor on node A:
    const authorizationRejection = decideActorAuthorization('human-resources-operator', 'messaging.send');
    expect(authorizationRejection.authorized).toBe(false);
    if (authorizationRejection.authorized) throw new Error('unreachable');

    // Distinguishability contract — a caller combining both facts can never
    // confuse one for the other:
    const authorizationDimension = authorizationRejection.dimension;
    const authorizationReasonCode = authorizationRejection.reasonCode;
    expect(ELIGIBILITY_DIMENSIONS).not.toContain(authorizationDimension);
    expect(NODE_ELIGIBILITY_REASON_CODES).not.toContain(authorizationReasonCode);
    expect(authorizationReasonCode).not.toBe(missing.reasons[0]?.code);
    // And the capability dimension is untouched by the authorization verdict:
    // node A is still capability-eligible; node B still is not.
    expect(possessed.capabilityEligible).toBe(true);
    expect(missing.capabilityEligible).toBe(false);
  });

  it('an actor authorized for nothing still receives the same honest capability answer', () => {
    const { service } = buildService();
    const cloud = registerTestNode(service, {
      seed: 'cloud-authorized-none',
      platformClass: 'cloud',
      capabilities: [{ name: 'workflow.execute', version: 1, availability: 'available' }],
    });
    // Actor with NO grants at all.
    const decision = decideActorAuthorization('unknown-actor', 'workflow.execute');
    expect(decision.authorized).toBe(false);
    const result = service.matchNodes({
      capabilities: [{ name: 'workflow.execute' }],
      placement: { required: 'cloud_required' },
    });
    const evaluation = findEvaluation(result, cloud.nodeId);
    // Capability answer is independent of the actor: eligibility here never
    // consults actors at all.
    expect(evaluation.capabilityEligible).toBe(true);
    expect(evaluation.eligible).toBe(true);
    expect(result.eligibleNodes).toHaveLength(1);
  });
});
