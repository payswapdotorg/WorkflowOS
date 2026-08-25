/**
 * WORK-036: the workspace path-confinement boundary (platform/tools).
 *
 * EVERY path a tool touches resolves against the WORK-035 workspace
 * worktree root — never the arbitrary host filesystem. Rejected:
 *   * absolute paths (`/etc/passwd`, `C:\…`);
 *   * `..` traversal (`../../outside`);
 *   * SYMLINK ESCAPE — the nearest EXISTING ancestor of the target is
 *     realpath-resolved and must remain inside the (realpath-resolved)
 *     root, so a symlink planted inside the workspace cannot redirect a
 *     read/write outside the boundary;
 *   * empty paths / NUL or backslash smuggling.
 *
 * The boundary violation is a FAILED TOOL OUTCOME (observable evidence of
 * the attempted escape — recorded on the invocation), never a silent
 * success and never a thrown crash.
 */
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

/** The typed confinement violation (mapped to a failed outcome upstream). */
export class WorkspaceBoundaryError extends Error {
  readonly code: 'workspace-boundary-violation' | 'invalid-path';

  constructor(code: 'workspace-boundary-violation' | 'invalid-path', message: string) {
    super(message);
    this.name = 'WorkspaceBoundaryError';
    this.code = code;
  }
}

/**
 * Resolve a workspace-relative path to a confined absolute path.
 * Throws WorkspaceBoundaryError on any escape attempt.
 */
export async function resolveWithinWorkspace(
  root: string,
  relativePath: string,
): Promise<string> {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new WorkspaceBoundaryError('invalid-path', 'tool path must be a non-empty string');
  }
  if (relativePath.includes('\0')) {
    throw new WorkspaceBoundaryError('invalid-path', 'tool path must not contain NUL bytes');
  }
  if (isAbsolute(relativePath)) {
    throw new WorkspaceBoundaryError(
      'workspace-boundary-violation',
      `tool path must be workspace-relative (got the absolute path ${JSON.stringify(relativePath)})`,
    );
  }
  if (relativePath.includes('\\')) {
    throw new WorkspaceBoundaryError('invalid-path', 'tool path must use "/" separators');
  }

  // Lexical confinement first: resolve normalizes '.'/'..' components.
  const lexical = resolve(root, relativePath);
  if (lexical !== root && !lexical.startsWith(root + sep)) {
    throw new WorkspaceBoundaryError(
      'workspace-boundary-violation',
      `tool path ${JSON.stringify(relativePath)} escapes the workspace boundary`,
    );
  }

  // Symlink confinement: the canonical root + the nearest existing
  // ancestor of the target must keep the target inside. (A symlink at the
  // target itself, or in any existing parent, redirects through realpath —
  // an escape is caught here.)
  const realRoot = await realpathStrict(root, relativePath);
  let ancestor = lexical;
  const tail: string[] = [];
  for (;;) {
    const realAncestor = await realpathSafe(ancestor);
    if (realAncestor !== null) {
      if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
        throw new WorkspaceBoundaryError(
          'workspace-boundary-violation',
          `tool path ${JSON.stringify(relativePath)} resolves through a symlink outside the workspace boundary`,
        );
      }
      return tail.length === 0 ? realAncestor : resolve(realAncestor, ...tail);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      // filesystem root without finding an existing component — treat as
      // an escape (cannot happen under a real workspace root).
      throw new WorkspaceBoundaryError(
        'workspace-boundary-violation',
        `tool path ${JSON.stringify(relativePath)} has no existing ancestor within the workspace`,
      );
    }
    tail.unshift(ancestor.slice(parent.length + sep.length));
    ancestor = parent;
  }
}

async function realpathStrict(root: string, relativePath: string): Promise<string> {
  const real = await realpathSafe(root);
  if (real === null) {
    throw new WorkspaceBoundaryError(
      'invalid-path',
      `the workspace root does not exist (${root}) — cannot resolve ${JSON.stringify(relativePath)}`,
    );
  }
  return real;
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}
