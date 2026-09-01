/**
 * V2-002 — deterministic identity + digest derivation (pure, no DB).
 *
 * Proves the repository's identity contracts BEFORE any persistence exists:
 *
 *   - the CONTENT digest is SHA-256 over canonical JSON of the opaque version
 *     content (sorted keys, no whitespace, UTF-8) — key-order-insensitive,
 *     envelope-free, and discriminating (registry §"Canonical identity and
 *     digest rules": never hash transport envelopes or presentation);
 *   - the content digest is NOT the WorkflowVersion semantic digest (V2-003
 *     owns that — this module never computes or claims it);
 *   - durable IDs (workflow / workflow-version / installation) derive ONLY
 *     from their authoritative identity inputs: identical authoritative
 *     inputs → byte-identical identity; every authoritative input is
 *     load-bearing (mutation changes the identity); non-authoristic noise
 *     (display names, descriptions, visibility, timestamps) NEVER changes
 *     identity (registry: "UI session IDs, timestamps chosen by models,
 *     random prompt text, or local process identity must never be the sole
 *     identity basis for a durable workflow object").
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  computeContentDigest,
  deriveWorkflowId,
  deriveWorkflowVersionId,
  deriveWorkflowInstallationId,
} from '../../../src/workflow-repository/internal/identity.js';

const PROTOCOL = { irSchemaVersion: 'test-ir-1' } as const;

describe('V2-002 — canonical JSON serialization (the digest preimage)', () => {
  it('sorts object keys recursively and emits NO insignificant whitespace', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ z: { d: 2, c: 1 }, a: { y: false, x: null } })).toBe(
      '{"a":{"x":null,"y":false},"z":{"c":1,"d":2}}',
    );
  });

  it('PRESERVES array order (arrays are ordered sequences, not sets)', () => {
    // The owning schema (V2-003) declares which collections are sets; the
    // canonical form here must not silently reorder ordered sequences.
    expect(canonicalJson({ steps: [3, 1, 2] })).toBe('{"steps":[3,1,2]}');
    expect(canonicalJson({ steps: [1, 2, 3] })).not.toBe(canonicalJson({ steps: [3, 1, 2] }));
  });

  it('escapes strings deterministically (JSON string form, UTF-8)', () => {
    expect(canonicalJson({ note: 'a"b\\c' })).toBe('{"note":"a\\"b\\\\c"}');
    // Unicode round-trips stably across repeated calls (UTF-8, not escapes).
    expect(canonicalJson({ note: 'héllo ✓ 工作流' })).toBe(
      canonicalJson({ note: 'héllo ✓ 工作流' }),
    );
  });

  it('is idempotent (canonicalizing a canonical string is a no-op at the value level)', () => {
    const value = { b: [2, { q: 1, p: 0 }], a: 'x' };
    const once = canonicalJson(value);
    // Re-serializing the PARSED canonical form yields the identical string.
    expect(canonicalJson(JSON.parse(once))).toBe(once);
  });
});

describe('V2-002 — content digest (SHA-256 over canonical JSON of opaque content)', () => {
  it('is deterministic: same content → same digest, repeatedly', () => {
    const content = { version: 1, steps: [{ id: 's1' }, { id: 's2' }] };
    const first = computeContentDigest(content);
    expect(computeContentDigest({ ...content })).toBe(first);
    expect(computeContentDigest(JSON.parse(JSON.stringify(content)))).toBe(first);
  });

  it('is INSENSITIVE to input key order (canonicalization before hashing)', () => {
    const a = computeContentDigest({ alpha: 1, beta: 2, gamma: { x: 1, y: 2 } });
    const b = computeContentDigest({ gamma: { y: 2, x: 1 }, beta: 2, alpha: 1 });
    expect(a).toBe(b);
  });

  it('DISCRIMINATES different content (load-bearing)', () => {
    expect(computeContentDigest({ a: 1 })).not.toBe(computeContentDigest({ a: 2 }));
    expect(computeContentDigest({ a: 1 })).not.toBe(computeContentDigest({ a: 1, b: 2 }));
    expect(computeContentDigest({ a: 1 })).not.toBe(computeContentDigest([1]));
    expect(computeContentDigest({ a: 1 })).not.toBe(computeContentDigest('{"a":1}'));
    expect(computeContentDigest({ a: 1 })).not.toBe(computeContentDigest({ a: '1' }));
  });

  it('never hashes transport envelopes or repository metadata around the content', () => {
    const content = { a: 1, nested: { keep: true } };
    const bare = computeContentDigest(content);
    // Wrapping the content in an envelope (request shape, repository context,
    // presentation) must NOT produce the same digest (registry rule).
    expect(computeContentDigest({ content })).not.toBe(bare);
    expect(computeContentDigest({ workflowId: 'wfw_x', content })).not.toBe(bare);
    expect(computeContentDigest({ content, submittedAt: '2026-01-01T00:00:00Z' })).not.toBe(bare);
  });

  it('is the 64-hex SHA-256 form (the registry digest algorithm)', () => {
    expect(computeContentDigest({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('V2-002 — workflow identity (durable repository identity)', () => {
  it('derives ONLY from the authoritative inputs (organization, owner, slug)', () => {
    const base = { organizationId: 'org-aaa', ownerUserId: 'user-1', slug: 'invoice-bot' };
    const first = deriveWorkflowId(base);
    expect(deriveWorkflowId({ ...base })).toBe(first);
    // Non-authoritative noise never changes identity.
    expect(
      deriveWorkflowId({
        ...base,
        ...({ name: 'Different Name', description: 'x', visibility: 'public', createdAt: 'whenever' } as object),
      }),
    ).toBe(first);
  });

  it('every authoritative input is load-bearing (mutation test)', () => {
    const base = { organizationId: 'org-aaa', ownerUserId: 'user-1', slug: 'invoice-bot' };
    const id = deriveWorkflowId(base);
    expect(deriveWorkflowId({ ...base, organizationId: 'org-bbb' })).not.toBe(id);
    expect(deriveWorkflowId({ ...base, ownerUserId: 'user-2' })).not.toBe(id);
    expect(deriveWorkflowId({ ...base, slug: 'invoice-bot-2' })).not.toBe(id);
  });

  it('uses the prefixed hex identity form', () => {
    expect(deriveWorkflowId({ organizationId: 'o', ownerUserId: 'u', slug: 's' })).toMatch(
      /^wfw_[0-9a-f]{32}$/,
    );
  });
});

describe('V2-002 — workflow VERSION identity (content-addressed, per workflow)', () => {
  it('derives ONLY from (workflow, content digest, protocol descriptor)', () => {
    const base = { workflowId: 'wfw_abc', contentDigest: computeContentDigest({ a: 1 }), protocol: PROTOCOL };
    const first = deriveWorkflowVersionId(base);
    expect(deriveWorkflowVersionId({ ...base })).toBe(first);
    expect(
      deriveWorkflowVersionId({
        ...base,
        ...({ versionNumber: 99, parentVersionId: 'wfwv_parent', createdByUserId: 'u', createdAt: 'now' } as object),
      }),
    ).toBe(first);
  });

  it('every authoritative input is load-bearing (mutation test)', () => {
    const base = { workflowId: 'wfw_abc', contentDigest: computeContentDigest({ a: 1 }), protocol: PROTOCOL };
    const id = deriveWorkflowVersionId(base);
    expect(deriveWorkflowVersionId({ ...base, workflowId: 'wfw_other' })).not.toBe(id);
    expect(
      deriveWorkflowVersionId({ ...base, contentDigest: computeContentDigest({ a: 2 }) }),
    ).not.toBe(id);
    expect(deriveWorkflowVersionId({ ...base, protocol: { irSchemaVersion: 'test-ir-2' } })).not.toBe(id);
  });

  it('the SAME content in TWO DIFFERENT workflows is TWO identities (fork/source never collide)', () => {
    const content = { step: 'same-bytes' };
    const digest = computeContentDigest(content);
    const source = deriveWorkflowVersionId({ workflowId: 'wfw_source', contentDigest: digest, protocol: PROTOCOL });
    const fork = deriveWorkflowVersionId({ workflowId: 'wfw_fork', contentDigest: digest, protocol: PROTOCOL });
    expect(fork).not.toBe(source);
  });

  it('uses the prefixed hex identity form (distinct from workflow ids)', () => {
    const id = deriveWorkflowVersionId({
      workflowId: 'wfw_abc',
      contentDigest: computeContentDigest({ a: 1 }),
      protocol: PROTOCOL,
    });
    expect(id).toMatch(/^wfwv_[0-9a-f]{32}$/);
  });
});

describe('V2-002 — workflow installation identity (tenant + pinned version)', () => {
  it('derives ONLY from (tenant organization, pinned version)', () => {
    const base = { organizationId: 'org-tenant', versionId: 'wfwv_pinned' };
    const first = deriveWorkflowInstallationId(base);
    expect(deriveWorkflowInstallationId({ ...base })).toBe(first);
    expect(
      deriveWorkflowInstallationId({ ...base, ...({ installedByUserId: 'u2', status: 'disabled' } as object) }),
    ).toBe(first);
  });

  it('every authoritative input is load-bearing (mutation test)', () => {
    const base = { organizationId: 'org-tenant', versionId: 'wfwv_pinned' };
    const id = deriveWorkflowInstallationId(base);
    expect(deriveWorkflowInstallationId({ ...base, organizationId: 'org-other' })).not.toBe(id);
    expect(deriveWorkflowInstallationId({ ...base, versionId: 'wfwv_other' })).not.toBe(id);
  });

  it('uses the prefixed hex identity form (distinct from the other kinds)', () => {
    expect(deriveWorkflowInstallationId({ organizationId: 'o', versionId: 'v' })).toMatch(
      /^wfin_[0-9a-f]{32}$/,
    );
  });
});

describe('V2-002 — identity-kind discrimination (no cross-kind collisions)', () => {
  it('the three identity derivations never agree for identical raw input strings', () => {
    // Same literal strings fed to all three derivations must produce three
    // distinct identities (domain separation per object kind).
    const a = deriveWorkflowId({ organizationId: 'x', ownerUserId: 'x', slug: 'x' });
    const b = deriveWorkflowVersionId({
      workflowId: 'x',
      contentDigest: computeContentDigest('x'),
      protocol: { irSchemaVersion: 'x' },
    });
    const c = deriveWorkflowInstallationId({ organizationId: 'x', versionId: 'x' });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
