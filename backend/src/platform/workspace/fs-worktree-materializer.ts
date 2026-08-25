/**
 * WORK-035: FsWorktreeMaterializer — the real WorktreeMaterializer port
 * implementation: `git worktree`-class operations under a configured root.
 *
 * PR #39 REVIEW FIX #2 — the EXPLICIT LAYOUT:
 *   The repository/worktree layout is derived ONLY by
 *   `resolveWorktreeLayout` (platform/workspace/worktree-layout.ts):
 *
 *     <root>/<owner>/<repository>                  → repositoryDir (the
 *       git repository / main checkout the worktree attaches to — created
 *       by the platform bootstrap; the materializer NEVER clones/fetches)
 *     <root>/<owner>/<repository>/exec/<exec-id>   → worktreeDir
 *
 *   The persisted worktree-path token must be EXACTLY
 *   `owner/repository/exec/<executionRecordId>` AND consistent with the
 *   declared repository coordinates (validated on every call — persisted
 *   tokens are never trusted blindly). The previous implementation derived
 *   the repository directory by chaining three dirname() calls off the
 *   worktree host path — which produced `<root>/<owner>` and ran git
 *   against the WRONG directory. The derivation is now explicit + tested.
 *
 * SECURITY BOUNDARY:
 *   * The token is sanitized (path-traversal-safe) + structurally parsed;
 *     the resolved path can never escape the configured root.
 *   * The token is ALWAYS derived from repository coordinates + the
 *     execution UUID (never caller-supplied free text).
 *   * No credentials (git runs against the local workspace root's
 *     repository only; remote fetch/push stay /github's authority).
 *
 * IDEMPOTENCE (the crash-safety contract):
 *   * materialize: `git worktree add -B <branch> <path> <base>` — `-B`
 *     creates the branch OR deterministically resets it to the base
 *     revision, so re-materialization after any crash lands on the SAME
 *     path at the SAME base. If a worktree already exists at the path on
 *     the SAME branch, it is re-used as-is; a different branch is replaced.
 *   * remove: `git worktree remove --force` (absent → success — cleanup
 *     idempotency).
 *
 * FAIL-CLOSED PRE-CHECKS (typed stages — the workspace records where):
 *   * 'git-repository-missing'  — repositoryDir is not a git repository.
 *   * 'base-revision-missing'   — the base revision is not a commit in
 *     the repository (the workspace cannot be reproducible from it).
 *
 * This implementation shells out to the local `git` binary ONLY for
 * worktree-local operations under the root. It is NOT a GitHub authority
 * (no PR/merge), NOT a tool runtime (WORK-036), and grants no arbitrary
 * host filesystem access (the root is the boundary).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Logger } from '@platform/logger.js';
import type { WorktreeMaterializer, WorktreeMaterializerInput, WorktreeRemoveInput } from './worktree-materializer.types.js';
import { WorktreeMaterializerError } from './worktree-materializer.types.js';
import { parseWorktreeToken, resolveWorktreeLayout } from './worktree-layout.js';

const execFileAsync = promisify(execFile);

/** The host path a worktree-path token resolves to (within the root). */
export function assertSafeToken(token: string): void {
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

  async materialize(input: WorktreeMaterializerInput): Promise<string> {
    const layout = this.layoutFor(input.worktreePathToken, input.repositoryOwner, input.repositoryName);

    try {
      // Fail-closed pre-checks — the materializer MUST be operating in the
      // intended repository with an existing base commit (reproducibility).
      await this.assertGitRepository(layout.repositoryDir);
      await this.assertBaseRevision(layout.repositoryDir, input.baseRevision);

      // Idempotent materialization: if a worktree already exists at the
      // deterministic path (a crashed attempt), verify the branch + reuse
      // or replace.
      const existing = await this.worktreeBranch(layout.worktreeDir);
      if (existing !== null) {
        if (existing === input.branch) {
          this.deps.logger.info('workspace.worktree.reused', {
            worktreePathToken: input.worktreePathToken,
            branch: input.branch,
          });
          return layout.worktreeDir; // idempotent re-use
        }
        // A stale worktree from a crashed attempt on a different branch:
        // remove + re-add deterministically.
        await this.git(['worktree', 'remove', '--force', layout.worktreeDir], layout.repositoryDir);
      } else {
        await mkdir(dirname(layout.worktreeDir), { recursive: true });
      }
      // `-B` (not `-b`): create the branch OR deterministically reset it to
      // the base revision — a re-materialization after ANY crash lands on
      // the same path at the same base (idempotent by construction). The
      // checkout happens from the recorded base revision (no --no-checkout:
      // the worktree is the environment the agent executes in).
      await this.git(
        [
          'worktree', 'add',
          '-B', input.branch, layout.worktreeDir,
          input.baseRevision,
        ],
        layout.repositoryDir,
      );
      this.deps.logger.info('workspace.worktree.materialized', {
        worktreePathToken: input.worktreePathToken,
        repositoryDir: layout.repositoryDir,
        worktreeDir: layout.worktreeDir,
        branch: input.branch,
        baseRevision: input.baseRevision,
      });
      return layout.worktreeDir;
    } catch (err) {
      if (err instanceof WorktreeMaterializerError) throw err;
      throw new WorktreeMaterializerError(
        'git-worktree-add',
        `git worktree add failed for ${input.worktreePathToken} (${input.branch} @ ${input.baseRevision}) in ${layout.repositoryDir}: ${(err as Error).message}`,
      );
    }
  }

  async remove(input: WorktreeRemoveInput): Promise<void> {
    // The removal path resolves the SAME explicit layout from the persisted
    // token (the token IS the durable identity being cleaned up).
    assertSafeToken(input.worktreePathToken);
    let parsed;
    try {
      parsed = parseWorktreeToken(input.worktreePathToken);
    } catch (err) {
      throw new WorktreeMaterializerError('token-invalid', (err as Error).message);
    }
    const layout = resolveWorktreeLayout(this.root, parsed);
    try {
      const existing = await this.worktreeBranch(layout.worktreeDir);
      if (existing === null) return; // absent → success (idempotent)
      await this.git(['worktree', 'remove', '--force', layout.worktreeDir], layout.repositoryDir);
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

  // ------------------------------------------------------------------ private

  /**
   * Resolve the explicit layout for a persisted token + the declared
   * repository coordinates, validating BOTH the token structure AND their
   * consistency (a drifted/corrupted row must fail closed, never operate
   * in the wrong repository).
   */
  private layoutFor(token: string, repositoryOwner: string, repositoryName: string) {
    assertSafeToken(token);
    let parsed;
    try {
      parsed = parseWorktreeToken(token);
    } catch (err) {
      throw new WorktreeMaterializerError('token-invalid', (err as Error).message);
    }
    if (parsed.repositoryOwner !== repositoryOwner || parsed.repositoryName !== repositoryName) {
      throw new WorktreeMaterializerError(
        'token-invalid',
        `worktree path token ${token} is inconsistent with the repository coordinates ${repositoryOwner}/${repositoryName} — the durable identity and the /github linkage disagree`,
      );
    }
    return resolveWorktreeLayout(this.root, parsed);
  }

  /** The repository directory must be a git repository (fail-closed). */
  private async assertGitRepository(repositoryDir: string): Promise<void> {
    try {
      await this.git(['rev-parse', '--git-dir'], repositoryDir);
    } catch {
      throw new WorktreeMaterializerError(
        'git-repository-missing',
        `the workspace repository directory ${repositoryDir} is not a git repository — the platform bootstrap/mirror step must create it before worktrees can attach`,
      );
    }
  }

  /** The base revision must exist as a commit (reproducibility, fail-closed). */
  private async assertBaseRevision(repositoryDir: string, baseRevision: string): Promise<void> {
    try {
      await this.git(['cat-file', '-e', `${baseRevision}^{commit}`], repositoryDir);
    } catch {
      throw new WorktreeMaterializerError(
        'base-revision-missing',
        `the base revision ${baseRevision} is not a commit in ${repositoryDir} — the workspace cannot be materialized reproducibly from it`,
      );
    }
  }

  /** The branch checked out at the path, or null when absent. */
  private async worktreeBranch(worktreeDir: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeDir);
      return stdout.trim() || null;
    } catch {
      return null; // not a worktree / does not exist
    }
  }
}
