/**
 * trust-language — the §17 "How do you know?" vocabulary (V2-017 T10).
 *
 * Pure presentational mappings over the AUTHORITATIVE evidence and
 * attestation facts (the V2-005 history read's evidence records and the
 * V2-014 bindings the Run boundary verified). This module never evaluates,
 * verifies, or re-derives anything — it only shapes backend-supplied values
 * into honest human wording:
 *
 *   - the "Verified by" line is derived from the evidence CLASS, and
 *     deliberately does NOT claim verification for claim/intent records
 *     (the class vocabulary is the authority's own);
 *   - the assurance wording stays the attestation's own level;
 *   - the trust boundary sentence keeps the frozen rule: a cryptographic
 *     signature/digest/attestation SUPPORTS the explanation but is never
 *     presented as automatic proof of a physical side effect.
 */
import type {
  ProductRunAttestationBinding,
  ProductRunEvidenceRecord,
} from '../../api/client';

/**
 * The honest "Verified by" wording for one evidence record, derived from
 * the authoritative evidence class (registry: evidence — constitution §7):
 * observation / verification / human_confirmation carry verification
 * meaning; claim and intent NEVER do (rendered as what they are).
 */
export function verifiedByLine(evidence: Pick<ProductRunEvidenceRecord, 'evidenceClass'>): string {
  switch (evidence.evidenceClass) {
    case 'observation':
      return 'Verified by an observation record';
    case 'verification':
      return 'Verified by a verification record';
    case 'human_confirmation':
      return 'Verified by human confirmation';
    case 'claim':
      return 'A claim — not verification';
    case 'intent':
      return 'Recorded intent — not verification';
    default:
      // An unknown authoritative class: the honest word is the class
      // itself, never a guessed verification.
      return `Recorded as ${evidence.evidenceClass}`;
  }
}

/** The human assurance word for one attestation binding (the registry level). */
export function assuranceWord(
  binding: Pick<ProductRunAttestationBinding, 'assurance'>,
): string {
  switch (binding.assurance) {
    case 'software_signed':
      return 'Software-signed';
    case 'hardware_backed':
      return 'Hardware-backed';
    case 'tee_attested':
      return 'TEE-attested';
    case 'verifiable_computation':
      return 'Verifiable computation';
    default:
      // An unknown authoritative assurance: the honest word is the level
      // itself, never an inflated one.
      return binding.assurance;
  }
}

/** The human action sentence of an attestation's execution statement, if any. */
export function statementAction(
  binding: Pick<ProductRunAttestationBinding, 'statement'>,
): string | null {
  const action = binding.statement?.action;
  return typeof action === 'string' && action.trim() !== '' ? action : null;
}

/** The frozen trust-boundary sentence (UX spec §17 / Work Order rule 6). */
export const TRUST_BOUNDARY_SENTENCE =
  'A cryptographic check supports this record — it can\u2019t by itself prove what happened in the physical world.';
