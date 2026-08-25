/**
 * WORK-035 (PR #39 review fix #2): the EXPLICIT workspace-root layout —
 * the single source of truth for how a worktree-path token maps onto the
 * host filesystem.
 *
 * THE LAYOUT (explicit; derived ONLY by this module — never by counting
 * dirname() calls at the call site):
 *
 *   <root>/<owner>/<repository>                → repositoryDir
 *        The git repository (the main checkout) that worktrees attach to.
 *        It is created by the platform bootstrap / repository mirror step
 *        — the materializer's contract is worktree-LOCAL (it never clones
 *        or fetches: that would require credentials, which the workspace
 *        layer must never hold).
 *
 *   <root>/<owner>/<repository>/exec/<executionRecordId>  → worktreeDir
 *        The per-execution isolated worktree. Because it is derived from
 *   the repository coordinates + the ExecutionRecord UUID, two executions
 *   NEVER share a mutable worktree and one execution never gets two (the
 *   UNIQUE(worktree_path) constraint is the durable backstop).
 *
 *   <owner>/<repository>/exec/<executionRecordId>  → worktreePathToken
 *        The ROOT-INDEPENDENT durable identity persisted on the workspace
 *        row (host paths are machine-local; the token re-resolves on every
 *   machine).
 */
import { resolve } from 'node:path';

/** The repository + execution coordinates a worktree derives from. */
export interface WorktreeLayoutCoordinates {
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  /** The ExecutionRecord's UUID (the durable per-execution discriminator). */
  readonly executionRecordId: string;
}

/** The resolved filesystem layout under a workspace root. */
export interface WorktreeLayout {
  /** `<root>/<owner>/<repository>` — the git repository (main checkout). */
  readonly repositoryDir: string;
  /** `<root>/<owner>/<repository>/exec/<executionRecordId>` — the worktree. */
  readonly worktreeDir: string;
  /** `owner/repository/exec/<executionRecordId>` — the durable token. */
  readonly worktreePathToken: string;
}

/** A parsed worktree-path token. */
export interface ParsedWorktreeToken extends WorktreeLayoutCoordinates {
  /** Always 'exec' (the layout constant separating worktrees from the repo). */
  readonly kind: 'exec';
}

/** Path-segment safety: [A-Za-z0-9._-] only, never '..' (traversal-safe). */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafeSegment(field: string, value: string): void {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new Error(
      `worktree-layout-invalid-segment: ${field} must match [A-Za-z0-9._-] and must not contain '..' (got: ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Build the durable worktree-path token:
 * `owner/repository/exec/<executionRecordId>`. The SAME derivation is used
 * by the workspace repository (the persisted worktree_path) and by the
 * materializer (the resolved host path) — the layout can never drift
 * between the durable identity and the filesystem.
 */
export function buildWorktreePathToken(input: WorktreeLayoutCoordinates): string {
  assertSafeSegment('repositoryOwner', input.repositoryOwner);
  assertSafeSegment('repositoryName', input.repositoryName);
  assertSafeSegment('executionRecordId', input.executionRecordId);
  return `${input.repositoryOwner}/${input.repositoryName}/exec/${input.executionRecordId}`;
}

/**
 * Resolve the explicit layout under a workspace root. This is the ONLY
 * place repositoryDir / worktreeDir are derived.
 */
export function resolveWorktreeLayout(
  rootDir: string,
  input: WorktreeLayoutCoordinates,
): WorktreeLayout {
  const worktreePathToken = buildWorktreePathToken(input);
  return {
    repositoryDir: resolve(rootDir, input.repositoryOwner, input.repositoryName),
    worktreeDir: resolve(rootDir, worktreePathToken),
    worktreePathToken,
  };
}

/**
 * Parse a worktree-path token back into its coordinates. Rejects anything
 * that is not EXACTLY `owner/repository/exec/<executionRecordId>` with
 * safe segments (the token is persisted data — it is validated, never
 * trusted).
 */
export function parseWorktreeToken(token: string): ParsedWorktreeToken {
  const parts = typeof token === 'string' ? token.split('/') : [];
  if (parts.length !== 4 || parts[2] !== 'exec') {
    throw new Error(
      `worktree-layout-invalid-token: expected exactly owner/repository/exec/<executionRecordId> (got: ${JSON.stringify(token)})`,
    );
  }
  const [repositoryOwner, repositoryName, , executionRecordId] = parts as [string, string, string, string];
  assertSafeSegment('repositoryOwner', repositoryOwner);
  assertSafeSegment('repositoryName', repositoryName);
  assertSafeSegment('executionRecordId', executionRecordId);
  return { repositoryOwner, repositoryName, kind: 'exec', executionRecordId };
}
