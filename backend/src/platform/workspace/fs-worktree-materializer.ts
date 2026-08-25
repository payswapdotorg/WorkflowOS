/**
 * WORK-035: FsWorktreeMaterializer — the real WorktreeMaterializer port
 * implementation: `git worktree`-class operations under a configured root.
 *
 * SECURITY BOUNDARY:
 *   * The worktree path token is sanitized (path-traversal-safe: only
 *     [A-Za-z0-9._-] and the single '/' separator we derive ourselves);
 *     the resolved path can never escape the configured root.
 *   * The token is ALWAYS derived from the repository coordinates + the
 *     execution UUID (never caller-supplied free text).
 *   * No credentials (the git operations run against the local workspace
 *     root's repository mirrors/checkout mechanics — the /github
 *     installation credential is NOT used here; remote fetch/push stay
 *     /github's authority).
 *
 * IDEMPOTENCE (the crash-safety contract):
 *   * materialize: `git worktree add` at the deterministic path. If the
 *     worktree already exists (a crashed attempt created it), verify the
 *     branch: same branch → re-use (idempotent); different branch →
 *     remove + re-add (the stale worktree from the crashed attempt is
 *     replaced deterministically).
 *   * remove: `git worktree remove --force` (absent → success — cleanup
 *     idempotency).
 *
 * This implementation shells out to the local `git` binary ONLY for
 * worktree-local operations under the root. It is NOT a GitHub authority
 * (no PR/merge), NOT a tool runtime (WORK-036), and grants no arbitrary
 * host filesystem access (the root is the boundary).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import type { Logger } from '@platform/logger.js';
import type { WorktreeMaterializer } from './worktree-materializer.types.js';
import { WorktreeMaterializerError } from './worktree-materializer.types.js';

const execFileAsync = promisify(execFile);

/** Path-traversal-safe token check (the token structure we derive). */
function assertSafeToken(token: string): void {
  if (!/^[A-Za-z0-9._\-]+(\/[A-Za-z0-9._\-]+)*$/.test(token)) {
    throw new WorktreeMaterializerError(
      'token-invalid',
      `worktree path token contains forbidden characters: ${token}`,
    );
  }
  if (token.includes('..')) {
    throw new WorktreeMaterializerError('token-invalid', 'worktree path token must not contain ..');
  }
}

export interface FsWorktreeMaterializerDeps {
  /** The workspace root directory (the filesystem boundary). */
  readonly rootDir: string;
  readonly logger: Logger;
  /**
   * Injectable git executor (tests fake this; production uses
   * child_process.execFile against the local git binary).
   */
  readonly execGit?: (args: readonly string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>;
}

export class FsWorktreeMaterializer implements WorktreeMaterializer {
  private readonly root: string;
  private readonly git: (args: readonly string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>;

  constructor(private readonly deps: FsWorktreeMaterializerDeps) {
    this.root = resolve(deps.rootDir);
    this.git =
      deps.execGit ??
      (async (args, cwd) => {
        return execFileAsync('git', args as string[], { cwd, encoding: 'utf8' }) as never;
      });
  }

  async materialize(input: {
    readonly worktreePathToken: string;
    readonly repositoryOwner: string;
    readonly repositoryName: string;
    readonly branch: string;
    readonly baseRevision: string;
  }): Promise<string> {
    assertSafeToken(input.worktreePathToken);
    const hostPath = join(this.root, input.worktreePathToken);

    // The repo checkout directory (the worktree's main checkout lives at
    // <root>/<owner>/<repo>/repo; worktrees under
    // <root>/<owner>/<repo>/exec/<executionId>). The repo dir is created
    // lazily; in a full deployment the mirror/clone step is part of the
    // platform bootstrap (WORK-035 keeps the materializer's contract
    // worktree-local).
    const repoDir = dirname(dirname(dirname(hostPath)));

    try {
      // Idempotent materialization: if the worktree already exists at the
      // deterministic path (a crashed attempt), verify the branch + reuse
      // or replace.
      const existing = await this.worktreeBranch(hostPath);
      if (existing !== null) {
        if (existing === input.branch) {
          this.deps.logger.info('workspace.worktree.reused', {
            worktreePathToken: input.worktreePathToken,
            branch: input.branch,
          });
          return hostPath; // idempotent re-use
        }
        // A stale worktree from a crashed attempt on a different branch:
        // remove + re-add deterministically.
        await this.git(['worktree', 'remove', '--force', hostPath], repoDir);
      }
      await mkdir(dirname(hostPath), { recursive: true });
      await this.git(
        [
          'worktree', 'add',
          '--no-checkout', // the checkout happens with the recorded base
          '-b', input.branch, hostPath,
          input.baseRevision,
        ],
        repoDir,
      );
      this.deps.logger.info('workspace.worktree.materialized', {
        worktreePathToken: input.worktreePathToken,
        branch: input.branch,
        baseRevision: input.baseRevision,
      });
      return hostPath;
    } catch (err) {
      if (err instanceof WorktreeMaterializerError) throw err;
      throw new WorktreeMaterializerError(
        'git-worktree-add',
        `git worktree add failed for ${input.worktreePathToken} (${input.branch} @ ${input.baseRevision}): ${(err as Error).message}`,
      );
    }
  }

  async remove(input: { readonly worktreePathToken: string }): Promise<void> {
    assertSafeToken(input.worktreePathToken);
    const hostPath = join(this.root, input.worktreePathToken);
    const repoDir = dirname(dirname(dirname(hostPath)));
    try {
      const existing = await this.worktreeBranch(hostPath);
      if (existing === null) return; // absent → success (idempotent)
      await this.git(['worktree', 'remove', '--force', hostPath], repoDir);
      this.deps.logger.info('workspace.worktree.removed', {
        worktreePathToken: input.worktreePathToken,
      });
    } catch (err) {
      if (err instanceof WorktreeMaterializerError) throw err;
      throw new WorktreeMaterializerError(
        'git-worktree-remove',
        `git worktree remove failed for ${input.worktreePathToken}: ${(err as Error).message}`,
      );
    }
  }

  /** The branch checked out at the path, or null when absent. */
  private async worktreeBranch(hostPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], hostPath);
      return stdout.trim() || null;
    } catch {
      return null; // not a worktree / does not exist
    }
  }
}
