import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHORITATIVE_WORK_ORDER_DIR,
  validateGovernanceState,
} from '../../../src/architecture-checkpoints/index.js';
import { GovernanceManifestDetector } from '../../../src/architecture-checkpoints/internal/detectors/governance-manifest.detector.js';
import type { RepositorySnapshot } from '../../../src/architecture-checkpoints/index.js';
import {
  FileSystemGovernanceStateLoader,
  GovernanceStateValidationError,
} from '../../../src/development-governance/index.js';
import type { GovernanceModel, ProgramState } from '../../../src/development-governance/index.js';

/**
 * The 2026-08-29 identity resolution (the architect's PR #74 REQUEST CHANGES
 * verdict): duplicate Work Order identifiers are duplicate authorities — they
 * cannot coexist as authoritative artifacts. Exactly one canonical artifact
 * (`spec/work-orders/WORK-NNN.md`) exists per WORK identity; the retired
 * upload wave lives under distinct UW-053..UW-059 identities in
 * `spec/archive/upload-wave-2026-08-28/` and is never authoritative.
 *
 * This suite is the discrimination proof the verdict required:
 *  - GREEN: the real repository validates (identity surface clean, retirement
 *    record consistent, exactly one canonical mapping per ID);
 *  - RED: every collision shape — the exact historical em-dash collision, a
 *    duplicated canonical identity, a program record pointing at a variant
 *    artifact, a stray file in the authoritative directory — is REJECTED by
 *    the ONE validation engine, by the control-plane loader, and by the
 *    revision-bound governance-manifest detector.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GOVERNANCE_DIR = join(REPO_ROOT, 'spec', 'development-state');
const ARCHIVE_DIR = join(REPO_ROOT, 'spec', 'archive', 'upload-wave-2026-08-28');

describe('WORK-053 identity resolution — the work-order identity surface (the 2026-08-29 architect verdict)', () => {
  let realModel: GovernanceModel;
  let realProgram: ProgramState;
  let realWorkOrderEntries: readonly string[];

  /** A file reader bound to the REAL repository (enforcement references resolve). */
  const realReadFile = async (path: string): Promise<string | null> => {
    try {
      return await (await import('node:fs/promises')).readFile(join(REPO_ROOT, path), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };

  beforeAll(async () => {
    const loaded = await new FileSystemGovernanceStateLoader({
      repoRoot: REPO_ROOT,
      governanceDir: GOVERNANCE_DIR,
    }).inspect();
    realModel = loaded.model;
    realProgram = loaded.program;
    realWorkOrderEntries = readdirSync(join(REPO_ROOT, AUTHORITATIVE_WORK_ORDER_DIR));
  });

  // --- GREEN: the real repository post-resolution ---------------------------

  it('IDENTITY-01 — duplicate Work Order identifiers cannot coexist as authoritative artifacts: the REAL repository validates (the identity surface is clean)', async () => {
    const loaded = await new FileSystemGovernanceStateLoader({
      repoRoot: REPO_ROOT,
      governanceDir: GOVERNANCE_DIR,
    }).inspect();
    expect(loaded.validation.ok, loaded.validation.violations.join('\n')).toBe(true);
    expect(loaded.validation.violations).toEqual([]);
  });

  it('IDENTITY-01 — GREEN: spec/work-orders holds ONLY canonical WORK-NNN.md files (+ TEMPLATE.md) — the authoritative identity surface is closed', () => {
    expect(realWorkOrderEntries.length).toBeGreaterThan(0);
    for (const name of realWorkOrderEntries) {
      if (name === 'TEMPLATE.md') continue;
      expect(name, `non-canonical artifact in the authoritative directory: ${name}`).toMatch(/^WORK-\d{3}\.md$/);
    }
    // The canonical v1.1 identities exist (the architect-issued issue track).
    for (let n = 53; n <= 61; n++) {
      expect(realWorkOrderEntries).toContain(`WORK-${String(n).padStart(3, '0')}.md`);
    }
    // The historical collision shapes are GONE from the live locations.
    expect(realWorkOrderEntries.some((n) => n !== 'TEMPLATE.md' && !/^WORK-\d{3}\.md$/.test(n))).toBe(false);
    expect(realWorkOrderEntries).not.toContain('DAG.yaml');
    expect(existsSync(join(REPO_ROOT, 'spec', 'governance', 'ARCHITECTURE_LOCK.md'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'spec', 'governance', 'ARCHITECT_ROLE.md'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'spec', 'governance', 'AGENT_PROTOCOL.md'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'spec', 'governance', 'NEW_ARCHITECT_START.md'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'spec', 'implementation', 'CURRENT_STATE.md'))).toBe(false);
  });

  it('IDENTITY-01 — GREEN: the retired upload wave carries distinct UW identities with non-authoritative banners, and the machine-readable retirement record is consistent', async () => {
    const { readFile } = await import('node:fs/promises');
    const index = JSON.parse(await readFile(join(ARCHIVE_DIR, 'index.json'), 'utf8')) as {
      status: string;
      identityMapping: Array<{
        originalClaimedId: string;
        retiredIdentity: string;
        archivedFile: string;
        canonicalMeaningOfOriginalId: string;
      }>;
      governanceDocumentCorrections: Array<{ originalPath: string; archivedFile: string }>;
    };
    expect(index.status).toBe('non-authoritative');
    expect(index.identityMapping).toHaveLength(7);
    for (const m of index.identityMapping) {
      expect(m.retiredIdentity).toMatch(/^UW-05[3-9]$/);
      expect(m.originalClaimedId).toMatch(/^WORK-05[3-9]$/);
      const archivedPath = join(REPO_ROOT, m.archivedFile);
      expect(existsSync(archivedPath), `missing archived file: ${m.archivedFile}`).toBe(true);
      const text = await readFile(archivedPath, 'utf8');
      expect(text.startsWith('> **RETIRED UPLOAD-WAVE PROPOSAL')).toBe(true);
      expect(text).toContain(`# ${m.retiredIdentity} — `);
      expect(text).toContain(m.originalClaimedId); // the banner records the original claim as history
      expect(text).toContain('Nothing in this file governs');
      // The retired file's heading does NOT claim the WORK identity anymore.
      expect(text).not.toContain(`\n# ${m.originalClaimedId} `);
      // The canonical meaning is the v1.1 issue track.
      expect(m.canonicalMeaningOfOriginalId).toContain(m.originalClaimedId);
      // The retired identity does not collide with any canonical WORK file.
      expect(realWorkOrderEntries).not.toContain(`${m.retiredIdentity}.md`);
    }
    for (const c of index.governanceDocumentCorrections) {
      expect(existsSync(join(REPO_ROOT, c.archivedFile)), `missing archived doc: ${c.archivedFile}`).toBe(true);
      expect(existsSync(join(REPO_ROOT, c.originalPath)), `${c.originalPath} still exists in a live location`).toBe(false);
    }
  });

  it('IDENTITY-01 — GREEN: exactly one canonical mapping per future Work Order ID (dependency-state futureGeneration == the spec files == the roadmap sequence)', async () => {
    const { readFile } = await import('node:fs/promises');
    const dep = JSON.parse(await readFile(join(GOVERNANCE_DIR, 'dependency-state.json'), 'utf8')) as {
      futureGeneration: Record<string, unknown>;
    };
    const roadmap = JSON.parse(await readFile(join(REPO_ROOT, 'spec', 'governance', 'future-roadmap.json'), 'utf8')) as {
      sequence: string[];
      status: string;
    };
    const futureIds = Object.keys(dep.futureGeneration);
    expect(futureIds).toEqual(roadmap.sequence);
    expect(roadmap.status).toBe('proposed'); // v1.1 remains proposed
    // Each future ID maps to exactly one canonical spec file whose title IS the mapping.
    for (const id of futureIds) {
      const specPath = join(REPO_ROOT, AUTHORITATIVE_WORK_ORDER_DIR, `${id}.md`);
      expect(existsSync(specPath), `missing canonical spec for ${id}`).toBe(true);
      const text = await readFile(specPath, 'utf8');
      expect(text.startsWith(`# ${id} — `)).toBe(true);
      expect(text).toContain('Status: planned.');
    }
    // The canonical WORK-053 is the v1.1 foundation — NOT the retired checkpoint framework.
    const w053 = await readFile(join(REPO_ROOT, AUTHORITATIVE_WORK_ORDER_DIR, 'WORK-053.md'), 'utf8');
    expect(w053).toContain('Architecture v1.1 Foundation and Control Loop');
    expect(w053).not.toContain('Architecture Checkpoint Framework');
    // WORK-053 is NOT activated: the program state records no WORK-053..061 entries.
    for (const w of realProgram.workOrders) {
      expect(w.id).not.toMatch(/^WORK-0(5[3-9]|6[01])$/);
    }
  });

  // --- RED: the engine rejects every collision shape ------------------------

  it('IDENTITY-01 — DISCRIMINATION: the EXACT historical collision (an em-dash variant file claiming WORK-053 beside the canonical WORK-053.md) is REJECTED', async () => {
    const variant = 'WORK-053 — Architecture Checkpoint Framework.md';
    const entries = [...realWorkOrderEntries, variant];
    const result = await validateGovernanceState(realModel, realProgram, realReadFile, async () => entries);
    expect(result.ok).toBe(false);
    expect(
      result.violations.some((v) => v.includes(variant) && v.includes('claims a WORK identity') && v.includes('canonical')),
      `expected the variant-identity violation, got: ${result.violations.join(' | ')}`,
    ).toBe(true);
  });

  it('IDENTITY-01 — DISCRIMINATION: a variant file claiming a WORK identity is REJECTED even WITHOUT the canonical file present (the identity claim alone is the violation)', async () => {
    const entries = realWorkOrderEntries.filter((n) => n !== 'WORK-053.md').concat(['WORK-053 — Some Other Scope.md']);
    const result = await validateGovernanceState(realModel, realProgram, realReadFile, async () => entries);
    expect(result.violations.some((v) => v.includes('WORK-053 — Some Other Scope.md') && v.includes('claims a WORK identity'))).toBe(true);
  });

  it('IDENTITY-01 — DISCRIMINATION: a DUPLICATED canonical identity (two entries claiming the same WORK-NNN) is REJECTED', async () => {
    const entries = [...realWorkOrderEntries, 'WORK-053.md'];
    const result = await validateGovernanceState(realModel, realProgram, realReadFile, async () => entries);
    expect(result.violations.some((v) => v.includes('DUPLICATE Work Order identity "WORK-053"'))).toBe(true);
  });

  it('IDENTITY-01 — DISCRIMINATION: a stray non-identity artifact in the authoritative directory (the retired DAG.yaml shape) is REJECTED', async () => {
    const entries = [...realWorkOrderEntries, 'DAG.yaml'];
    const result = await validateGovernanceState(realModel, realProgram, realReadFile, async () => entries);
    expect(result.violations.some((v) => v.includes('DAG.yaml') && v.includes('not a canonical "WORK-NNN.md" artifact'))).toBe(true);
  });

  it('IDENTITY-01 — DISCRIMINATION: a program-state record referencing a non-canonical identity artifact (the em-dash path) is REJECTED', async () => {
    const program = structuredClone(realProgram);
    const w046 = program.workOrders.find((w) => w.id === 'WORK-046')!;
    w046.workOrder = 'spec/work-orders/WORK-053 — Architecture Checkpoint Framework.md';
    const result = await validateGovernanceState(realModel, program, realReadFile, async () => realWorkOrderEntries);
    expect(
      result.violations.some((v) => v.includes('WORK-046') && v.includes('references the non-canonical identity artifact')),
    ).toBe(true);
  });

  it('IDENTITY-01 — DISCRIMINATION: the BASELINE listing (the real, resolved repository) passes the identity surface — the red cases above are not vacuous', async () => {
    const result = await validateGovernanceState(realModel, realProgram, realReadFile, async () => realWorkOrderEntries);
    expect(result.ok, result.violations.join('\n')).toBe(true);
  });

  // --- RED, end to end: the control-plane loader refuses to serve a colliding state ---

  it('IDENTITY-01 — END-TO-END: the loader REFUSES to serve a repository with a live identity collision (GovernanceStateValidationError), and serves the clean fixture', async () => {
    const buildFixture = async (workOrderFiles: string[]): Promise<string> => {
      const dir = mkdtempSync(join(tmpdir(), 'wfos-identity-'));
      mkdirSync(join(dir, 'spec', 'development-state'), { recursive: true });
      mkdirSync(join(dir, AUTHORITATIVE_WORK_ORDER_DIR), { recursive: true });
      writeFileSync(join(dir, 'spec', 'development-state', 'governance-model.json'), JSON.stringify(realModel, null, 2));
      writeFileSync(join(dir, 'spec', 'development-state', 'program-state.json'), JSON.stringify(realProgram, null, 2));
      // Copy every enforcement-referenced file so the ONLY possible violations
      // are the identity-surface ones (a controlled experiment).
      for (const contract of realModel.checkpointContracts) {
        for (const ref of contract.enforcement) {
          const dest = join(dir, ref.file);
          mkdirSync(dirname(dest), { recursive: true });
          if (!existsSync(dest)) copyFileSync(join(REPO_ROOT, ref.file), dest);
        }
      }
      for (const name of workOrderFiles) {
        copyFileSync(
          join(REPO_ROOT, AUTHORITATIVE_WORK_ORDER_DIR, name),
          join(dir, AUTHORITATIVE_WORK_ORDER_DIR, name),
        );
      }
      return dir;
    };
    const canonicalNames = realWorkOrderEntries.filter((n) => n !== 'TEMPLATE.md');

    // Clean fixture: loads and validates.
    const clean = await buildFixture(canonicalNames);
    try {
      const loaded = await new FileSystemGovernanceStateLoader({ repoRoot: clean }).inspect();
      expect(loaded.validation.ok, loaded.validation.violations.join('\n')).toBe(true);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }

    // Colliding fixture: the exact historical em-dash collision beside the
    // canonical files — the loader must REFUSE to serve the state.
    const colliding = await buildFixture([...canonicalNames]);
    writeFileSync(
      join(colliding, AUTHORITATIVE_WORK_ORDER_DIR, 'WORK-053 — Architecture Checkpoint Framework.md'),
      '# WORK-053 — Architecture Checkpoint Framework\n(architect upload-wave shape)\n',
    );
    try {
      const loader = new FileSystemGovernanceStateLoader({ repoRoot: colliding });
      await expect(loader.load()).rejects.toBeInstanceOf(GovernanceStateValidationError);
      const inspected = await loader.inspect();
      expect(inspected.validation.ok).toBe(false);
      expect(
        inspected.validation.violations.some((v) => v.includes('claims a WORK identity') && v.includes('WORK-053 — Architecture Checkpoint Framework.md')),
      ).toBe(true);
    } finally {
      rmSync(colliding, { recursive: true, force: true });
    }
  });

  // --- RED, revision-bound: the governance-manifest detector fails the collision at the bound revision ---

  it('IDENTITY-01 — REVISION-BOUND: the governance-manifest detector FAILS a snapshot whose revision carries the identity collision, and PASSES the resolved revision', async () => {
    const { readFile } = await import('node:fs/promises');
    const modelText = await readFile(join(GOVERNANCE_DIR, 'governance-model.json'), 'utf8');
    const programText = await readFile(join(GOVERNANCE_DIR, 'program-state.json'), 'utf8');
    const detector = new GovernanceManifestDetector();

    const snapshotWith = (entries: readonly string[]): RepositorySnapshot => ({
      revision: 'rev-identity',
      repository: 'pectoraux/WorkflowOS',
      async listDir(path: string): Promise<readonly { name: string; type: 'file' | 'dir' }[]> {
        if (path === AUTHORITATIVE_WORK_ORDER_DIR) return entries.map((name) => ({ name, type: 'file' as const }));
        return [];
      },
      async readFile(path: string): Promise<string | null> {
        if (path === 'spec/development-state/governance-model.json') return modelText;
        if (path === 'spec/development-state/program-state.json') return programText;
        return realReadFile(path);
      },
      async dirExists(): Promise<boolean> { return true; },
      identity: () => ({ revision: 'rev-identity', repository: 'pectoraux/WorkflowOS', filesRead: 2, treeDigest: null }),
    });

    const evaluate = async (entries: readonly string[]) =>
      detector.evaluate({
        assertion: {
          id: 'a1', architectureVersionId: 'v1', assertionId: 'ARCH-052-001', severity: 'blocking', scope: 'repository',
          statement: 's', detectorKind: 'governance-manifest', detectorConfig: {}, createdAt: new Date(),
        },
        checkpointKind: 'pr_conformance',
        snapshot: snapshotWith(entries),
        context: { projectId: 'p1', workItemId: 'w1', architectureVersionId: 'v1', implementationRevision: 'rev-identity', workOrderId: null },
      });

    // The resolved revision: PASS.
    const pass = await evaluate(realWorkOrderEntries);
    expect(pass.status, pass.summary).toBe('pass');

    // The pre-resolution revision (the em-dash collision live on main): FAIL.
    const fail = await evaluate([...realWorkOrderEntries, 'WORK-053 — Architecture Checkpoint Framework.md']);
    expect(fail.status).toBe('fail');
    expect(fail.summary).toContain('claims a WORK identity');
  });

  // --- The engine wiring is provably in the served path ---------------------

  it('IDENTITY-01 — WIRING: the loader and the detector both pass the directory lister to the ONE engine (the identity check is not optional decoration)', async () => {
    const { readFile } = await import('node:fs/promises');
    const loaderSrc = await readFile(
      join(REPO_ROOT, 'backend', 'src', 'development-governance', 'internal', 'governance-state-loader.ts'),
      'utf8',
    );
    expect(loaderSrc).toMatch(/validateGovernanceState\(model, program, this\.readFile\(\), this\.listDir\(\)\)/);
    expect(loaderSrc).toMatch(/readdir/);
    const detectorSrc = await readFile(
      join(REPO_ROOT, 'backend', 'src', 'architecture-checkpoints', 'internal', 'detectors', 'governance-manifest.detector.ts'),
      'utf8',
    );
    expect(detectorSrc).toMatch(/snapshot\.listDir/);
    // The code-pinned constant names the real authoritative directory.
    expect(existsSync(join(REPO_ROOT, AUTHORITATIVE_WORK_ORDER_DIR))).toBe(true);
  });
});
