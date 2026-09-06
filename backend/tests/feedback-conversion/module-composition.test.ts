import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WORK-068 — the module-composition pins (the type-level + barrel-level
 * boundary proofs, mirroring the WORK-067 module-composition discipline):
 *
 *   * the barrel re-exports the full public contract (vocabularies, the
 *     typed error surface, the decision/assessment/proposal/result types,
 *     the pure engines, the composition defaults);
 *   * the domain lives at src/feedback-conversion/ and consumes the
 *     authorities through their PUBLIC barrels only;
 *   * app.ts constructs DefaultFeedbackConversionService and exposes it
 *     on AppDeps (the composition pin);
 *   * the migration set is UNCHANGED (WORK-068 authorizes NO migration).
 */
import {
  DefaultFeedbackConversionService,
  FeedbackConversionError,
  deriveProposalIdentity,
  matchOpenWorkItems,
  deriveCreationId,
  isSameProposalFamily,
  assessSignalGroup,
  assessBlastRadius,
  prioritizeProposal,
  priorityScore,
  deriveBacklogContext,
  readConversionMetadata,
  FEEDBACK_CONVERSION_METADATA_FIELD,
  FEEDBACK_CONVERSION_VERSION,
  CONVERSION_PRIORITIES,
  BLAST_RADIUS_BANDS,
  FEEDBACK_CONVERSION_ERROR_CODES,
} from '../../src/feedback-conversion/index.js';
import type {
  FeedbackConversionService,
  ConversionContext,
  ConversionProposal,
  ConversionDecision,
  FeedbackConversionMetadataPayload,
} from '../../src/feedback-conversion/index.js';

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FC_DIR = join(BACKEND_ROOT, 'src', 'feedback-conversion');
const MIGRATIONS_DIR = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations');
const APP_TS = join(BACKEND_ROOT, 'src', 'app.ts');

describe('WORK-068 — the module composition (the barrel + composition pins)', () => {
  it('the domain exists at src/feedback-conversion/ (index.ts + types.ts + internal/) and is NOT an 18th frozen module', () => {
    expect(existsSync(join(FC_DIR, 'index.ts'))).toBe(true);
    expect(existsSync(join(FC_DIR, 'types.ts'))).toBe(true);
    expect(existsSync(join(FC_DIR, 'internal', 'index.ts'))).toBe(true);
    expect(existsSync(join(FC_DIR, 'internal', 'feedback-conversion-service.ts'))).toBe(true);
    expect(existsSync(join(FC_DIR, 'internal', 'conversion-identity.ts'))).toBe(true);
    expect(existsSync(join(FC_DIR, 'internal', 'signal-assessment.ts'))).toBe(true);
    expect(existsSync(join(FC_DIR, 'internal', 'open-work-item-matcher.ts'))).toBe(true);
    expect(existsSync(join(FC_DIR, 'internal', 'conversion-prioritizer.ts'))).toBe(true);
    expect(existsSync(join(BACKEND_ROOT, 'src', 'modules', 'feedback-conversion'))).toBe(false);
  });

  it('the barrel re-exports the full public contract + the pure engines + the composition defaults', () => {
    // The composition defaults:
    expect(typeof DefaultFeedbackConversionService).toBe('function');
    // The pure engines:
    expect(typeof deriveProposalIdentity).toBe('function');
    expect(typeof matchOpenWorkItems).toBe('function');
    expect(typeof deriveCreationId).toBe('function');
    expect(typeof isSameProposalFamily).toBe('function');
    expect(typeof assessSignalGroup).toBe('function');
    expect(typeof assessBlastRadius).toBe('function');
    expect(typeof prioritizeProposal).toBe('function');
    expect(typeof priorityScore).toBe('function');
    expect(typeof deriveBacklogContext).toBe('function');
    expect(typeof readConversionMetadata).toBe('function');
    // The vocabularies:
    expect(CONVERSION_PRIORITIES).toEqual(['high', 'medium', 'low']);
    expect(BLAST_RADIUS_BANDS).toEqual(['wide', 'moderate', 'narrow']);
    expect(FEEDBACK_CONVERSION_ERROR_CODES.length).toBeGreaterThan(0);
    expect(FEEDBACK_CONVERSION_METADATA_FIELD).toBe('feedbackConversion');
    expect(FEEDBACK_CONVERSION_VERSION).toBe('WORK-068/1.0.0');
    // The typed error:
    const error = new FeedbackConversionError('CONVERSION_DECISION_REQUIRED', 'test');
    expect(error.code).toBe('CONVERSION_DECISION_REQUIRED');
  });

  it('the metadata field convention matches the WORK-040 metadata.planner pattern (embedded in the existing metadata JSONB — NO new table/column)', () => {
    const typesSrc = readFileSync(join(FC_DIR, 'types.ts'), 'utf8');
    expect(typesSrc).toMatch(/metadata\.feedbackConversion/);
    expect(typesSrc).not.toMatch(/CREATE TABLE|ALTER TABLE|ADD COLUMN/);
    // The domain owns no tables (the planner convention):
    const serviceSrc = readFileSync(join(FC_DIR, 'internal', 'feedback-conversion-service.ts'), 'utf8');
    expect(serviceSrc).toMatch(/owns NO tables/);
  });

  it('the conversion context CONSUMES the authorities through their PUBLIC surfaces (the WORK-067 signal service + the /work-items repository + the /architecture reads)', () => {
    const typesSrc = readFileSync(join(FC_DIR, 'types.ts'), 'utf8');
    expect(typesSrc).toMatch(/from '\.\.\/engineering-signals\/index\.js'/);
    expect(typesSrc).toMatch(/from '@modules\/work-items\/index\.js'/);
    expect(typesSrc).toMatch(/from '@modules\/architecture\/index\.js'/);
    // NEVER a module internal/:
    expect(typesSrc).not.toMatch(/modules\/[a-z-]+\/internal\//);
  });

  it('the deterministic conversion service produces FB- ids (the WORK-040 PLAN- convention)', () => {
    const identity = deriveProposalIdentity({
      organizationId: 'org-1',
      projectId: 'project-1',
      architectureVersionId: 'archver-1',
      logicalFailureKey: 'validation:journey-checkout:step-pay',
    });
    expect(identity.proposalId).toMatch(/^FB-[0-9a-f]{10}$/);
    expect(identity.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('app.ts constructs DefaultFeedbackConversionService and exposes it on AppDeps (the composition pin)', () => {
    const appTs = readFileSync(APP_TS, 'utf8');
    expect(appTs).toMatch(/feedbackConversionService = new DefaultFeedbackConversionService\(/);
    expect(appTs).toMatch(/feedbackConversionService\?: FeedbackConversionService;/);
    expect(appTs).toMatch(/import \{\s*DefaultFeedbackConversionService,\s*\} from '\.\/feedback-conversion\/index\.js';/);
  });

  it('the migration set is UNCHANGED (WORK-068 authorizes NO schema migration — the boundary is the metadata JSONB)', () => {
    const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
    // The current pinned count (62 — 62 since V2-009's workflow
    // deployments; unchanged by WORK-068; see the static-architecture
    // suite's migration pins for the history).
    expect(migrationFiles.length).toBe(62);
    expect(migrationFiles.some((name) => name.includes('feedback'))).toBe(false);
  });

  it('the service contract is the two-method surface (assess + convert — pinned at the type level)', () => {
    const typesSrc = readFileSync(join(FC_DIR, 'types.ts'), 'utf8');
    expect(typesSrc).toMatch(/assessSignals\(/);
    expect(typesSrc).toMatch(/convertSignals\(/);
    // The decision is a REQUIRED field of the convert input (the
    // no-silent-creation type pin):
    expect(typesSrc).toMatch(/ConversionEvaluationInput & \{ decision: ConversionDecision \}/);
  });
});

// Type-level pins (compile-time only — the imported types must exist and
// remain assignable to the public contract surface):
export type _Work068PublicSurfacePins = [
  FeedbackConversionService,
  ConversionContext,
  ConversionProposal,
  ConversionDecision,
  FeedbackConversionMetadataPayload,
];
