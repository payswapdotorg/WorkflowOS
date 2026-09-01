/**
 * V2-003 — document serialization/parsing (canonical JSON transport).
 *
 * `serializeWorkflowIrDocument` emits the canonical FULL-document form
 * (semantic projection + presentation), so round-trips are lossless while
 * the semantic digest remains presentation-independent.
 *
 * `parseWorkflowIrDocument` parses + shape-checks + validates; anything
 * ambiguous, unsupported or non-canonical-shaped is a typed rejection.
 */
import type { ParseResult, WorkflowIrDocument } from '../types.js';
import { canonicalJsonStringify } from './canonical-json.js';
import { normalizeDocumentForSerialization } from './semantic.js';
import { validateWorkflowIrDocument } from './validate.js';

/** Serialize a document to canonical JSON text (deterministic bytes). */
export function serializeWorkflowIrDocument(document: WorkflowIrDocument): string {
  return canonicalJsonStringify(normalizeDocumentForSerialization(document));
}

/** Parse canonical (or any) JSON text into a validated typed document. */
export function parseWorkflowIrDocument(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: 'IR_JSON_PARSE_FAILED',
          path: '$',
          message: `document is not valid JSON: ${(error as Error).message}`,
        },
      ],
    };
  }
  const validation = validateWorkflowIrDocument(parsed);
  if (!validation.ok) {
    return validation;
  }
  return { ok: true, document: parsed as WorkflowIrDocument };
}
