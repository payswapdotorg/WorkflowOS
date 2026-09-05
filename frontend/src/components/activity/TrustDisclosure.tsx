/**
 * TrustDisclosure — the §17 "How do you know?" content (V2-017 T10).
 *
 * Composed over the EXISTING evidence/attestation authorities only — the
 * records arrive through the V2-005 reconstructed-history read (evidence
 * records + the attestation bindings the Run boundary verified). No second
 * evidence model, no client-side verification, no invented facts:
 *
 *   - concise evidence first: each record's OWN description (or the honest
 *     absence of one) with the honest "Verified by" wording derived from
 *     the evidence class (claim/intent records are never dressed as
 *     verification);
 *   - a genuinely empty evidence array is a record fact ("No evidence
 *     records yet") — a FAILED read never reaches this component (each
 *     owning surface keeps its own Unavailable + Try-again state);
 *   - advanced verification is on-demand (progressive disclosure): the
 *     V2-014 binding facts (the statement's action, the assurance level,
 *     the execution digest, the attester) with the frozen trust boundary —
 *     a signature supports the explanation, it is never presented as
 *     automatic proof of a physical side effect.
 *
 * The owning surface provides the accessible region and the read states.
 */
import {
  assuranceWord,
  statementAction,
  TRUST_BOUNDARY_SENTENCE,
  verifiedByLine,
} from './trust-language';
import { formatRelative } from '../../lib/format';
import type { ProductRunHistory } from '../../api/client';

export default function TrustDisclosure({ history }: { history: ProductRunHistory }) {
  const evidence = history.evidence ?? [];
  const attestations = history.attestations ?? [];

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">How do you know?</h3>
      {evidence.length === 0 ? (
        <p className="text-sm text-muted-foreground">No evidence records yet for this run.</p>
      ) : (
        <ul aria-label="Evidence" className="space-y-1 text-sm">
          {evidence.map((record) => (
            <li key={record.id} className="space-y-0.5">
              <p>{record.description ?? 'Evidence recorded without a description.'}</p>
              <p className="text-xs text-muted-foreground">{verifiedByLine(record)}</p>
            </li>
          ))}
        </ul>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          Advanced verification
        </summary>
        <div className="mt-2 space-y-2">
          {attestations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No attestations attached to this run.
            </p>
          ) : (
            <ul aria-label="Attestations" className="space-y-2">
              {attestations.map((binding) => (
                <li key={binding.attestationId} className="space-y-0.5">
                  <dl className="space-y-0.5 text-xs text-muted-foreground">
                    {statementAction(binding) !== null && (
                      <div className="flex gap-2">
                        <dt className="font-medium">Execution statement</dt>
                        <dd>{statementAction(binding)}</dd>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <dt className="font-medium">Assurance</dt>
                      <dd>{assuranceWord(binding)}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-medium">Execution digest</dt>
                      <dd className="font-mono break-all">{binding.executionDigest}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-medium">Attester key</dt>
                      <dd className="font-mono break-all">{binding.attesterKeyId}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-medium">Verified</dt>
                      <dd>{formatRelative(binding.verifiedAt)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{TRUST_BOUNDARY_SENTENCE}</p>
        </div>
      </details>
    </div>
  );
}
