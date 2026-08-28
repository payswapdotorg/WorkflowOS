/**
 * WORK-051 round 1 (PR #52 review, BLOCKER 1 + HIGH — fail-closed reads) —
 * the snapshot tree walker. The ONLY tree-traversal helper the detectors
 * use; it reads EXCLUSIVELY through the revision-bound
 * {@link RepositorySnapshot} (never the local filesystem).
 *
 * Fail-closed contract (replaces the old walkFiles, which silently treated
 * unreadable directories as empty and unreadable files as empty content —
 * turning "I could not inspect the governed tree" into a vacuous PASS):
 *
 *   - the scan ROOT must be PROVEN to exist at the revision (parent-chain
 *     verification; for the repository root itself, a non-empty root
 *     listing — a resolvable ref always has an observable tree). A missing
 *     root throws SnapshotReadError('root-missing') ⇒ detector inconclusive.
 *   - any unreadable directory/file throws SnapshotReadError('unreadable')
 *     ⇒ detector inconclusive.
 *   - a file LISTED in a directory but unreadable (readFile → null) is an
 *     inconsistent tree — SnapshotReadError('inconsistent') ⇒ inconclusive,
 *     never silently skipped.
 *
 * Deterministic: entries are visited in sorted order, so the same snapshot
 * state always yields the same result.
 */

import type { RepositorySnapshot, SnapshotDirEntry } from '../../types.js';
import { SnapshotReadError } from '../../types.js';

export interface ScannedSnapshotFile {
  /** Repository-relative path with '/' separators. */
  readonly path: string;
  readonly source: string;
}

/** Normalize a repository-relative path ('' = repository root). */
function normalize(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (trimmed === '' || trimmed === '.') return '';
  return trimmed
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

/**
 * Recursively collect files under `rootPath` (repository-relative) with the
 * given extension (e.g. '.ts'), reading through the snapshot. Throws
 * SnapshotReadError on any inability to inspect (see file header).
 */
export async function walkSnapshotFiles(
  snapshot: RepositorySnapshot,
  rootPath: string,
  extension: string,
): Promise<ScannedSnapshotFile[]> {
  const root = normalize(rootPath);

  // Root existence proof.
  if (root === '') {
    // The repository root: a resolvable ref always has an observable tree.
    // An EMPTY root listing means the revision's tree could not be observed
    // (e.g. an unresolvable ref surfaced as a content-read miss) — fail
    // closed rather than scanning zero files vacuously.
    const rootEntries = await mustList(snapshot, '');
    if (rootEntries.length === 0) {
      throw new SnapshotReadError(
        'root-missing',
        `the repository root at revision ${snapshot.revision} of ${snapshot.repository} presented no observable tree — the revision is unresolvable or the tree is unreadable`,
      );
    }
  } else if (!(await snapshot.dirExists(root))) {
    throw new SnapshotReadError(
      'root-missing',
      `scan root '${root}' does not exist at revision ${snapshot.revision} of ${snapshot.repository} — the governed tree cannot be inspected (fail closed)`,
    );
  }

  const out: ScannedSnapshotFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await mustList(snapshot, dir);
    // Deterministic order: sorted by name.
    for (const entry of entries.slice().sort(byName)) {
      const childPath = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.type === 'dir') {
        await walk(childPath);
      } else if (entry.name.endsWith(extension)) {
        const source = await snapshot.readFile(childPath);
        if (source === null) {
          // Listed in the directory but unreadable at the revision — the
          // tree is inconsistent; never skip the file silently.
          throw new SnapshotReadError(
            'inconsistent',
            `file '${childPath}' is listed at revision ${snapshot.revision} but could not be read (inconsistent tree)`,
          );
        }
        out.push({ path: childPath, source });
      }
    }
  };
  await walk(root);
  return out;
}

/** List a directory through the snapshot; an unreadable dir is fatal (fail closed). */
async function mustList(
  snapshot: RepositorySnapshot,
  path: string,
): Promise<readonly SnapshotDirEntry[]> {
  // listDir itself throws SnapshotReadError on failure; a MISSING directory
  // legitimately returns [] (existence is established separately by
  // dirExists for roots and by the parent listing for children).
  return snapshot.listDir(path);
}

function byName(a: SnapshotDirEntry, b: SnapshotDirEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * List a directory whose EXISTENCE is required (e.g. a configured migrations
 * directory). Missing (confirmed-absent) → SnapshotReadError('root-missing');
 * unreadable → SnapshotReadError('unreadable').
 */
export async function listRequiredDir(
  snapshot: RepositorySnapshot,
  path: string,
): Promise<readonly SnapshotDirEntry[]> {
  const p = normalize(path);
  if (p !== '' && !(await snapshot.dirExists(p))) {
    throw new SnapshotReadError(
      'root-missing',
      `required directory '${p}' does not exist at revision ${snapshot.revision} of ${snapshot.repository} (fail closed)`,
    );
  }
  return mustList(snapshot, p);
}

/**
 * Read a REQUIRED file through the snapshot. Confirmed-absent (null) or
 * unreadable → SnapshotReadError (the caller evaluates 'inconclusive').
 */
export async function readRequiredFile(
  snapshot: RepositorySnapshot,
  path: string,
): Promise<string> {
  const p = normalize(path);
  if (p === '') {
    throw new SnapshotReadError('root-missing', 'a required file path cannot be empty');
  }
  const content = await snapshot.readFile(p);
  if (content === null) {
    throw new SnapshotReadError(
      'root-missing',
      `required file '${p}' does not exist at revision ${snapshot.revision} of ${snapshot.repository} (fail closed)`,
    );
  }
  return content;
}

// ---------------------------------------------------------------------------
// Deterministic source helpers (carried over from file-tree.ts — pure string
// processing, no filesystem access)
// ---------------------------------------------------------------------------

/**
 * Uniform fail-closed message for snapshot read failures: a typed
 * SnapshotReadError's own message, or a wrapped unexpected error. Detectors
 * surface this in 'inconclusive' results — the governed tree could not be
 * inspected, which is NEVER a pass.
 */
export function snapshotFailureMessage(err: unknown, subject: string, revision: string): string {
  if (err instanceof SnapshotReadError) return err.message;
  return `snapshot read failed for '${subject}' at revision ${revision}: ${(err as Error).message}`;
}

/**
 * Strip line + block comments from TypeScript source. Detectors evaluate
 * CODE, not prose — the static-architecture precedent. Deterministic.
 */
export function stripCodeComments(src: string): string {
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extract every import specifier from a TypeScript source (static imports +
 * export-from). Deterministic order of appearance.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specifiers.push(m[1]!);
  }
  const sideEffect = /import\s*['"]([^'"]+)['"]/g;
  while ((m = sideEffect.exec(source)) !== null) {
    specifiers.push(m[1]!);
  }
  return specifiers;
}
