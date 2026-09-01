/**
 * V2-014 — Execution Attestation Protocol: the public contracts.
 *
 * WORK ORDER: spec/architecture/v2/work-orders/V2-014.md
 * ARCHITECTURE CHANGE: V2-ACR-001 — Verifiable Execution and Execution
 *   Attestation (spec/architecture/v2/architecture-change-requests/)
 * SPEC: spec/architecture/v2/execution-attestation.md
 * REGISTRY: spec/architecture/v2/V2-CTRL-003-protocol-registry.md (+ .json)
 * CONSTITUTION: §5/§7/§19/§21 (separate dimensions; evidence truth; forbidden
 * drift; execution attestation and verifiable execution).
 *
 * The domain lives at `src/execution-attestation/` (application-layer pure
 * domain module — orchestration / workflow-ir / node-capability precedent).
 * It owns EXACTLY the V2-014 scope:
 *
 *   - the ExecutionStatement schema + canonical deterministic serialization;
 *   - the domain-separated ExecutionDigest (registry executionDomain
 *     `workflowos/execution-statement/v1` — distinct from the WorkflowVersion
 *     semantic digest owned by V2-003 and from content digests owned by
 *     V2-002);
 *   - the ExecutionAttestation envelope + real Ed25519 signature model
 *     binding attester key identity and workload identity;
 *   - freshness + anti-replay semantics (nonce/epoch; timestamps alone are
 *     never sufficient — enforced structurally by the verification policy);
 *   - duplicate-attestation convergence by stable identity;
 *   - the assurance vocabulary + representable assurance evidence (explicit,
 *     never silently downgraded, never changing WorkflowIR semantics);
 *   - cryptographic verification with a TYPED failure taxonomy (every
 *     rejection is a discriminated result, never a boolean);
 *   - typed protocol events for `execution.attestation.issued` /
 *     `execution.attestation.verified`;
 *   - protocol conformance fixtures + discrimination tests (the battery).
 *
 * BOUNDARY CONTRACT (load-bearing, pinned by
 * tests/unit/execution-attestation/module-boundary.test.ts):
 *
 *   - NOT repository/version persistence (V2-002): this module consumes
 *     merged sibling outputs only as OPAQUE reference DATA (identity/digest
 *     values carried as strings). It never imports, computes or re-derives
 *     sibling semantics.
 *   - NOT WorkflowIR semantics (V2-003): the WorkflowVersion semantic digest
 *     is reference binding data inside the statement; the ExecutionDigest is
 *     a different, domain-separated identity.
 *   - NOT Node identity/capability authority (V2-004): the node identity in a
 *     statement is an opaque external identity; capability possession is
 *     never evaluated here.
 *   - NOT run/state/evidence persistence authority (V2-005): no durable
 *     storage, no run lifecycle. Replay registries and ingestion ledgers are
 *     injected ports; durable implementations belong to the run/evidence
 *     authority.
 *   - NOT computer-use execution (V2-008) and NOT proof-graph composition
 *     (V2-015): the proof-graph object type is deliberately absent from this
 *     module's vocabulary snapshot.
 *   - NO authorization authority: a valid signature NEVER implies
 *     authorization, correct behavior, or sufficient evidence (registry
 *     authorityRules). The verified fact explicitly lists the non-authority
 *     dimensions.
 *   - NO blockchain/transparency/mandatory hardware/TEE dependency: software
 *     Ed25519 signatures are the universal baseline; stronger assurance is
 *     optional evidence, honestly reported when absent.
 *   - Secrets never enter statements: values are bound through one-way
 *     sha-256 commitments (executionValueCommitment); the schema carries only
 *     opaque identifiers, commitments and descriptions.
 */

import type { KeyObject } from 'node:crypto';

// ============================================================================
// §0 Domain identity (registry attestationObjectTypes — V2-014's two)
// ============================================================================

/** The canonical object type of an ExecutionStatement (registry, frozen). */
export const EXECUTION_STATEMENT_OBJECT_TYPE = 'workflowos/execution-statement/v1';

/** The canonical object type of an ExecutionAttestation (registry, frozen). */
export const EXECUTION_ATTESTATION_OBJECT_TYPE = 'workflowos/execution-attestation/v1';

/** The current statement schema version. */
export const EXECUTION_STATEMENT_SCHEMA_VERSION = 1;

/** The current attestation envelope schema version. */
export const EXECUTION_ATTESTATION_ENVELOPE_SCHEMA_VERSION = 1;

/**
 * The internal hash domain label for attester key identity derivation
 * (module-internal MAC discipline; NOT a registry identifier — mirrors the
 * merged node-key domain label pattern).
 */
export const ATTESTER_KEY_ID_DOMAIN = 'workflowos/attester-key/v1';

// ============================================================================
// §1 Vocabularies (frozen V2-CTRL-003 registry identifiers)
// ============================================================================

/** Canonical execution classes (registry: executionClasses). */
export const EXECUTION_CLASSES = [
  'deterministic_api',
  'agentic_computer_use',
  'human',
  'subworkflow',
] as const;
export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

/**
 * Canonical execution assurance identifiers (registry: assurance). Evidence/
 * trust properties of an attestation — they never change WorkflowIR
 * semantics, execution classes, or capability authorization.
 */
export const ASSURANCE_LEVELS = [
  'software_signed',
  'hardware_backed',
  'tee_attested',
  'verifiable_computation',
] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

/** A canonical capability name (registry: capabilities; membership enforced). */
export type CapabilityName = string;

/**
 * The execution-outcome vocabulary (schema-internal, statement-scoped): what
 * the executor claims happened. A claim — never evidence of a side effect
 * (constitution §7; registry evidence vocabulary).
 */
export const EXECUTION_OUTCOMES = ['succeeded', 'failed'] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

/** Canonical protocol event names for the attestation lifecycle (registry). */
export const EXECUTION_ATTESTATION_EVENT_NAMES = [
  'execution.attestation.issued',
  'execution.attestation.verified',
] as const;
export type ExecutionAttestationEventName = (typeof EXECUTION_ATTESTATION_EVENT_NAMES)[number];

// ============================================================================
// §2 Primitive value shapes
// ============================================================================

/** A lowercase 64-hex sha-256 digest (commitment or digest value). */
export type Sha256Hex = string;

/**
 * A UTC timestamp in the exact fixed format `YYYY-MM-DDTHH:MM:SS.sssZ`.
 * Fixed-width UTC strings compare chronologically as plain strings and keep
 * the module free of ambient clock APIs (all time is injected).
 */
export type UtcTimestamp = string;

/** A lowercase 128-hex Ed25519 signature. */
export type Ed25519SignatureHex = string;

/** Identity prefixes (stable identity namespaces — invariant 4). */
export const ATTESTATION_ID_PREFIX = 'wfea_';
export const ATTESTER_KEY_ID_PREFIX = 'wfeak_';
export const ATTESTATION_EVENT_ID_PREFIX = 'wfeaev_';

// ============================================================================
// §3 The ExecutionStatement (the commitment object)
// ============================================================================

/**
 * A canonical structured representation of ONE bounded execution fact
 * (execution-attestation.md §ExecutionStatement). Every decision-relevant
 * attestation binds the exact WorkflowVersion, Run, execution attempt, and
 * applicable step (invariant 3). Secrets never enter: input/output values are
 * bound through one-way sha-256 commitments (executionValueCommitment).
 */
export interface ExecutionStatement {
  /** MUST be exactly `workflowos/execution-statement/v1`. */
  readonly objectType: typeof EXECUTION_STATEMENT_OBJECT_TYPE;
  readonly statementSchemaVersion: number;
  /** Workflow identity (opaque external identity — repository scope). */
  readonly workflowId: string;
  /** The immutable WorkflowVersion identity (opaque external identity). */
  readonly workflowVersionId: string;
  /**
   * The WorkflowIR semantic digest of the bound WorkflowVersion (the merged
   * V2-003 digest, carried as opaque reference binding data — never
   * recomputed here; the ExecutionDigest is a DIFFERENT, domain-separated
   * identity).
   */
  readonly workflowVersionSemanticDigest: Sha256Hex;
  /** Deployment identity (opaque external identity). */
  readonly deploymentId: string;
  /** Run identity (opaque external identity — run lifecycle is elsewhere). */
  readonly runId: string;
  /** Execution-attempt identity within the run (integer >= 1). */
  readonly attemptId: number;
  /** Step identity when the fact concerns a step (decision-relevant scope). */
  readonly stepId?: string;
  /** Node identity of the executor (opaque external identity — V2-004). */
  readonly nodeId: string;
  /** Workload/runtime identity of the executor when available (opaque). */
  readonly workloadIdentity?: string;
  readonly executionClass: ExecutionClass;
  /** The invoked canonical capability where applicable (registry name). */
  readonly capability?: CapabilityName;
  /** Human-readable description of the executed action (never parameters). */
  readonly action: string;
  /** One-way sha-256 commitments over semantic execution inputs (sets). */
  readonly inputCommitments: readonly Sha256Hex[];
  /** One-way sha-256 commitments over outputs/effects (sets). */
  readonly outputCommitments: readonly Sha256Hex[];
  /** Observation commitments (sets). */
  readonly observationCommitments: readonly Sha256Hex[];
  /** Opaque references to evidence records (sets). */
  readonly evidenceReferences: readonly string[];
  /** Causal parent ExecutionDigest digests (sets — the execution ancestry). */
  readonly causalParents: readonly Sha256Hex[];
  /** Authorization-context digest when relevant (opaque commitment). */
  readonly authorizationContextDigest?: Sha256Hex;
  /** Placement/policy digest when relevant (opaque commitment). */
  readonly placementPolicyDigest?: Sha256Hex;
  /**
   * Freshness material: the single-use nonce for this execution attempt.
   * Timestamps alone are NEVER sufficient replay protection (invariant 6).
   */
  readonly nonce: string;
  /** Freshness material: the protocol epoch the execution belongs to. */
  readonly epoch: number;
  /** The claimed execution outcome (a claim — never side-effect evidence). */
  readonly outcome: ExecutionOutcome;
  /** When the execution (attempt) was performed. */
  readonly executedAt: UtcTimestamp;
  /** Bounded validity: the attestation is stale after this instant. */
  readonly validUntil?: UtcTimestamp;
}

// ============================================================================
// §4 The ExecutionDigest (domain-separated)
// ============================================================================

/**
 * The ExecutionDigest: SHA-256 over canonical JSON of the semantic object
 * `{domain, statement}` where domain is the registry executionDomain
 * `workflowos/execution-statement/v1` and the statement is the canonical
 * (set-normalized) projection. Domain-separated from the WorkflowVersion
 * semantic digest (V2-003) and every other digest domain in the repository
 * (invariants 1 + 2).
 */
export interface ExecutionDigestValue {
  readonly algorithm: 'sha-256';
  readonly domain: typeof EXECUTION_STATEMENT_OBJECT_TYPE;
  readonly digest: Sha256Hex;
}

// ============================================================================
// §5 Assurance evidence representation
// ============================================================================

/**
 * Representable assurance evidence for stronger-than-software assurance
 * levels: an opaque secure reference or an inline sha-256 commitment.
 * Raw secret material is never inline evidence.
 */
export type AssuranceEvidence =
  | { readonly kind: 'opaque_reference'; readonly reference: string }
  | { readonly kind: 'inline_commitment'; readonly algorithm: 'sha-256'; readonly digest: Sha256Hex };

// ============================================================================
// §6 The ExecutionAttestation envelope (authenticated protocol object)
// ============================================================================

/**
 * The authenticated envelope (execution-attestation.md §ExecutionAttestation).
 * The signature is REAL Ed25519 over the canonical JSON of the unsigned
 * envelope (all fields except `signature`), which includes the statement,
 * the ExecutionDigest, the attester key identity, the workload identity (via
 * the signed statement), the assurance context and the issuance metadata —
 * the signature model therefore binds attester key identity + workload
 * identity to the canonical statement/digest.
 */
export interface ExecutionAttestation {
  /** MUST be exactly `workflowos/execution-attestation/v1`. */
  readonly objectType: typeof EXECUTION_ATTESTATION_OBJECT_TYPE;
  readonly envelopeSchemaVersion: number;
  /**
   * The stable attestation identity: derived ONLY from the (executionDigest,
   * attesterKeyId) pair. Distinct from Node identity, workload identity and
   * attester key identity (invariant 4); duplicate delivery converges on it.
   */
  readonly attestationId: string;
  readonly executionDigest: ExecutionDigestValue;
  /** The canonical ExecutionStatement (embedded form of the contract). */
  readonly statement: ExecutionStatement;
  /** The attester key identity (derived from the embedded public key). */
  readonly attesterKeyId: string;
  /** The attester's Ed25519 public key (hex SPKI DER). */
  readonly attesterPublicKey: string;
  /** The assurance level claimed for this attestation. */
  readonly assurance: AssuranceLevel;
  /** Representable evidence — REQUIRED for stronger-than-software levels. */
  readonly assuranceEvidence?: readonly AssuranceEvidence[];
  /** Opaque key-reference metadata (e.g. an HSM slot reference). */
  readonly keyReference?: string;
  /** When the attestation was issued (attester clock, injected). */
  readonly issuedAt: UtcTimestamp;
  /** Ed25519 signature over the canonical unsigned-envelope preimage. */
  readonly signature: Ed25519SignatureHex;
}

// ============================================================================
// §7 Attester key material
// ============================================================================

/** A real Ed25519 attester key pair (generated through node:crypto). */
export interface AttesterKeyPair {
  /** The Ed25519 private key (kept in memory; never serialized). */
  readonly privateKey: KeyObject;
  /** The Ed25519 public key as hex SPKI DER (embeddable in envelopes). */
  readonly publicKeyDer: string;
  /** The stable key identity derived from the public key. */
  readonly keyId: string;
}

/** Signing input (the caller injects key material, assurance and clock). */
export interface AttestationSigningInput {
  readonly statement: ExecutionStatement;
  readonly attesterPrivateKey: KeyObject;
  readonly attesterPublicKeyDer: string;
  readonly assurance: AssuranceLevel;
  readonly assuranceEvidence?: readonly AssuranceEvidence[];
  readonly keyReference?: string;
  readonly issuedAt: UtcTimestamp;
}

// ============================================================================
// §8 The typed failure taxonomy (every rejection is typed, never boolean)
// ============================================================================

export const ATTESTATION_FAILURE_CODES = [
  'ATTESTATION_MALFORMED_ENVELOPE',
  'ATTESTATION_DOMAIN_MISMATCH',
  'ATTESTATION_DIGEST_MISMATCH',
  'ATTESTATION_ATTESTER_KEY_ID_MISMATCH',
  'ATTESTATION_SIGNATURE_INVALID',
  'ATTESTATION_ATTESTER_UNEXPECTED',
  'ATTESTATION_BINDING_MISMATCH',
  'ATTESTATION_NONCE_UNEXPECTED',
  'ATTESTATION_EPOCH_STALE',
  'ATTESTATION_EXPIRED',
  'ATTESTATION_REPLAYED',
  'ATTESTATION_ASSURANCE_INSUFFICIENT',
  'ATTESTATION_ASSURANCE_EVIDENCE_MISSING',
] as const;
export type AttestationFailureCode = (typeof ATTESTATION_FAILURE_CODES)[number];

/** The binding dimensions of invariant 3 (typed per-dimension rejection). */
export const ATTESTATION_BINDING_DIMENSIONS = [
  'workflow',
  'workflowVersion',
  'workflowVersionSemanticDigest',
  'deployment',
  'run',
  'attempt',
  'step',
  'node',
  'causalParents',
] as const;
export type AttestationBindingDimension = (typeof ATTESTATION_BINDING_DIMENSIONS)[number];

/** A typed verification failure (discriminated by `code`, fail-closed). */
export interface AttestationFailure {
  readonly code: AttestationFailureCode;
  readonly detail: string;
  /** Only present for ATTESTATION_BINDING_MISMATCH. */
  readonly dimension?: AttestationBindingDimension;
  /** Only present for ATTESTATION_BINDING_MISMATCH. */
  readonly expected?: string;
  /** Only present for ATTESTATION_BINDING_MISMATCH. */
  readonly actual?: string;
  /** The rejected attestation's identity when structurally recoverable. */
  readonly attestationId?: string;
}

// ============================================================================
// §9 The verification result (VerifiedExecutionFact or typed rejection)
// ============================================================================

/**
 * The result of applying an explicit verification policy to an attestation.
 * A valid signature with insufficient evidence NEVER becomes a verified
 * execution fact (execution-attestation.md §Verification).
 */
export type AttestationVerification =
  | { readonly ok: true; readonly fact: VerifiedExecutionFact }
  | { readonly ok: false; readonly failure: AttestationFailure };

/**
 * A verified execution fact: the attestation is cryptographically authentic,
 * correctly bound, fresh, and sufficiently assured UNDER THE GIVEN POLICY.
 *
 * CONSTITUTIONAL SEPARATION (invariant 5 + registry authorityRules): this
 * fact attests statement authenticity ONLY. A valid signature never implies
 * authorization, capability possession, correct behavior, an observed effect,
 * or sufficient evidence for any decision. Those dimensions are explicitly
 * marked as NEVER asserted here.
 */
export interface VerifiedExecutionFact {
  readonly attestationId: string;
  readonly executionDigest: ExecutionDigestValue;
  readonly statement: ExecutionStatement;
  readonly attesterKeyId: string;
  readonly assurance: AssuranceLevel;
  /** The injected verification clock at which the fact was established. */
  readonly verifiedAt: UtcTimestamp;
  /** What the fact attests: statement authenticity (nothing more). */
  readonly attests: 'statement_authenticity';
  /** The dimensions this fact NEVER asserts (fail-closed honesty marker). */
  readonly neverAsserts: readonly [
    'authorization',
    'capability_possession',
    'correct_behavior',
    'observed_effect',
    'sufficient_evidence',
  ];
  /** The fixed non-authority note (registry authorityRules discipline). */
  readonly nonAuthorityNote: string;
}

// ============================================================================
// §10 The verification policy (injected bindings, freshness, assurance)
// ============================================================================

/** The exact execution binding a decision requires (invariant 3). */
export interface AttestationBindingExpectation {
  readonly workflowId?: string;
  readonly workflowVersionId?: string;
  readonly workflowVersionSemanticDigest?: Sha256Hex;
  readonly deploymentId?: string;
  readonly runId?: string;
  readonly attemptId?: number;
  readonly stepId?: string;
  readonly nodeId?: string;
  readonly causalParents?: readonly string[];
}

/**
 * The freshness policy. REQUIRED for every verification: freshness is
 * mandatory wherever an attestation can influence current execution, and
 * timestamps alone are insufficient — the policy must bind a nonce
 * expectation and/or a replay registry (enforced fail-closed).
 */
export interface AttestationFreshnessPolicy {
  /** The injected verifier clock. */
  readonly now: UtcTimestamp;
  /** The verifier's current protocol epoch (earlier statement epochs are stale). */
  readonly currentEpoch: number;
  /** The exact challenge nonce expected for the execution attempt. */
  readonly expectedNonce?: string;
  /** Maximum attestation age (issuedAt + maxAgeMs must cover `now`). */
  readonly maxAgeMs?: number;
  /** Single-use nonce consumption registry (replay defense, injected port). */
  readonly replayRegistry?: ReplayRegistry;
}

/**
 * The full verification policy. The verifier decides ONLY about the
 * attestation object; it never evaluates authorization (a separate dimension)
 * and never recomputes WorkflowIR semantics.
 */
export interface AttestationVerificationPolicy {
  readonly bindings: AttestationBindingExpectation;
  readonly freshness: AttestationFreshnessPolicy;
  /** The trusted attester key ids; the empty list trusts nobody (fail-closed). */
  readonly attesterKeyIds?: readonly string[];
  /** The minimum required assurance level (typed insufficient failure below). */
  readonly requiredAssurance?: AssuranceLevel;
}

// ============================================================================
// §11 The replay registry port (durable implementation belongs elsewhere)
// ============================================================================

/**
 * Single-use nonce consumption port. The in-memory implementation is the
 * reference composition; durable run-scoped replay state is the run/evidence
 * authority's concern (deliberately out of scope here).
 */
export interface ReplayRegistry {
  /** Is the nonce for this exact execution binding already consumed? */
  isConsumed(binding: { runId: string; attemptId: number; nonce: string }): boolean;
  /**
   * Consume the nonce (single-use). The verifier calls this ONLY after a
   * fully successful verification; a rejected attestation never burns state.
   */
  consume(binding: { runId: string; attemptId: number; nonce: string }): void;
}

// ============================================================================
// §12 Duplicate-attestation convergence (stable identity ingestion)
// ============================================================================

/** The outcome of delivering an attestation to an ingestion surface. */
export interface AttestationIngestionOutcome {
  readonly kind: 'accepted' | 'duplicate';
  readonly attestationId: string;
  readonly firstSeenAt: UtcTimestamp;
  readonly deliveries: number;
}

// ============================================================================
// §13 Parse results
// ============================================================================

export type AttestationParseResult =
  | { readonly ok: true; readonly attestation: ExecutionAttestation }
  | { readonly ok: false; readonly failure: AttestationFailure };

// ============================================================================
// §14 Typed protocol events
// ============================================================================

/**
 * A typed protocol event (canonical registry names only; aliases forbidden).
 * Pure data: deterministic identity, injected occurrence clock.
 */
export interface ExecutionAttestationProtocolEvent {
  readonly eventType: ExecutionAttestationEventName;
  /** Deterministic event identity (same event + attestation → same id). */
  readonly eventId: string;
  readonly occurredAt: UtcTimestamp;
  readonly attestationId: string;
  readonly executionDigest: Sha256Hex;
  readonly attesterKeyId: string;
}

// ============================================================================
// §15 Validation results + the typed error surface
// ============================================================================

export interface AttestationValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type AttestationValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly AttestationValidationIssue[] };

export const EXECUTION_ATTESTATION_ERROR_CODES = [
  'EXECUTION_ATTESTATION_INVALID',
  'EXECUTION_ATTESTATION_CANONICAL_VALUE_NOT_JSON',
] as const;
export type ExecutionAttestationErrorCode = (typeof EXECUTION_ATTESTATION_ERROR_CODES)[number];

/** Typed, fail-closed error for attestation operations (never a silent default). */
export class ExecutionAttestationError extends Error {
  readonly code: ExecutionAttestationErrorCode;
  readonly issues: readonly AttestationValidationIssue[];

  constructor(code: ExecutionAttestationErrorCode, message: string, issues: readonly AttestationValidationIssue[] = []) {
    super(message);
    this.name = 'ExecutionAttestationError';
    this.code = code;
    this.issues = issues;
  }
}
