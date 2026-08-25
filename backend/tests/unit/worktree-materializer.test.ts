/**
 * WORK-035 (PR #39 review fix #2) — FsWorktreeMaterializer BEHAVIORAL tests
 * against a REAL git repository in a temp workspace root.
 *
 * The review found the materializer derived its repository directory by
 * chaining dirname() calls off the worktree path — producing
 * `<root>/<owner>` and running git against the WRONG directory. The fix
 * made the layout EXPLICIT (platform/workspace/worktree-layout.ts:
 * `<root>/<owner>/<repository>` = repositoryDir;
 * `<root>/<owner>/<repository>/exec/<executionRecordId>` = worktreeDir).
 *
 * These tests prove the REAL behavior end-to-end with the local git
 * binary (no execGit fake): the layout, the `-B` deterministic
 * re-materialization, the fail-closed pre-checks, the token/coordinates
 * cross-validation, and the idempotent removal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FsWorktreeMaterializer } from '@platform/workspace/fs-worktree-materializer.js';
import { WorktreeMaterializerError } from '@platform/workspace/worktree-materializer.types.js';

const execFileAsync = promisify(execFile);

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A silent logger (the materializer logs operations; tests don't care). */
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
} as never;

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args as string[], { cwd, encoding: 'utf8' });
  return stdout;
}

const OWNER = 'acme';
const REPO = 'platform';

describe('WORK-035 — FsWorktreeMaterializer (real git)', () => {
  let root: string;
  let repositoryDir: string;
  /** A real base commit SHA on the repository's default branch. */
  let baseSha: string;
  let materializer: FsWorktreeMaterializer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'w035-worktree-'));
    // The platform bootstrap step: a REAL git repository at
    // <root>/<owner>/<repository> with one commit on 'main'.
    repositoryDir = join(root, OWNER, REPO);
    await mkdir(repositoryDir, { recursive: true });
    await git(['init', '-b', 'main'], repositoryDir);
    await git(['config', 'user.email', 'test@workflowos.invalid'], repositoryDir);
    await git(['config', 'user.name', 'W035 Test'], repositoryDir);
    await writeFile(join(repositoryDir, 'README.md'), '# base\n');
    await git(['add', '.'], repositoryDir);
    await git(['commit', '-m', 'base'], repositoryDir);
    baseSha = (await git(['rev-parse', 'HEAD'], repositoryDir)).trim();
    materializer = new FsWorktreeMaterializer({ rootDir: root, logger: silentLogger });
  });

  afterAll(async () => {
    // The worktrees hold .git files pointing INTO the repository — remove
    // the whole temp root.
    await rm(root, { recursive: true, force: true });
  });

  it('materializes the worktree at the EXPLICIT layout path (repositoryDir=<root>/<owner>/<repository>; worktreeDir=<…>/exec/<id>) — the dirname-chaining bug stays fixed', async () => {
    const hostPath = await materializer.materialize({
      worktreePathToken: `${OWNER}/${REPO}/exec/wf_00000001`,
      repositoryOwner: OWNER,
      repositoryName: REPO,
      branch: 'feat/w035-layout',
      baseRevision: baseSha,
    });
    expect(hostPath).toBe(join(root, OWNER, REPO, 'exec', 'wf_00000001'));
    // The worktree is CHECKED OUT at the base revision (no --no-checkout):
    // the file from the base commit is present + the HEAD resolves.
    expect(await pathExists(join(hostPath, 'README.md'))).toBe(true);
    const head = await git(['rev-parse', 'HEAD'], hostPath);
    expect(head.trim()).toBe(baseSha);
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], hostPath);
    expect(branch.trim()).toBe('feat/w035-layout');
    // The worktree is REGISTERED from the REPOSITORY directory (the git
    // plumbing ran against repositoryDir — the wrong-dir bug would have
    // failed the materialize entirely).
    const list = await git(['worktree', 'list'], repositoryDir);
    expect(list).toContain(hostPath);
  });

  it('re-materialization is IDEMPOTENT: the same token+branch re-uses the existing worktree (same path, still checked out)', async () => {
    const token = `${OWNER}/${REPO}/exec/wf_00000002`;
    const input = {
      worktreePathToken: token,
      repositoryOwner: OWNER,
      repositoryName: REPO,
      branch: 'feat/w035-idem',
      baseRevision: baseSha,
    };
    const first = await materializer.materialize(input);
    const second = await materializer.materialize(input);
    expect(second).toBe(first);
    expect(await pathExists(join(second, 'README.md'))).toBe(true);
  });

  it('re-materialization after removal RESETS a lingering branch ref to the recorded base (`-B`, not `-b`): the retry after a crashed add lands at the base, never "branch already exists"', async () => {
    const token = `${OWNER}/${REPO}/exec/wf_00000003`;
    const input = {
      worktreePathToken: token,
      repositoryOwner: OWNER,
      repositoryName: REPO,
      branch: 'feat/w035-reset',
      baseRevision: baseSha,
    };
    const hostPath = await materializer.materialize(input);
    // The crash window: the worktree is REMOVED (cleanup/crash) but the
    // branch REF lingers (git worktree remove never deletes it) — and it
    // points PAST the recorded base (the preparer's attempt moved it).
    await materializer.remove({ worktreePathToken: token });
    await writeFile(join(repositoryDir, 'linger.txt'), 'linger\n');
    await git(['add', '.'], repositoryDir);
    await git(['commit', '-m', 'linger'], repositoryDir);
    await git(['branch', '-f', input.branch, 'HEAD'], repositoryDir); // any non-base ref
    const lingered = (await git(['rev-parse', input.branch], repositoryDir)).trim();
    expect(lingered).not.toBe(baseSha);
    // Re-materialize: `-B` resets the lingering ref to the recorded base
    // (with `-b` this add would FAIL: fatal: a branch named … already
    // exists) + the worktree is checked out AT the base.
    const again = await materializer.materialize(input);
    expect(again).toBe(hostPath);
    const head = (await git(['rev-parse', 'HEAD'], hostPath)).trim();
    expect(head).toBe(baseSha);
  });

  it('an EXISTING worktree on the SAME branch is re-used AS-IS (never reset — a reclaim must not destroy in-flight work)', async () => {
    const token = `${OWNER}/${REPO}/exec/wf_00000003b`;
    const input = {
      worktreePathToken: token,
      repositoryOwner: OWNER,
      repositoryName: REPO,
      branch: 'feat/w035-reuse',
      baseRevision: baseSha,
    };
    const hostPath = await materializer.materialize(input);
    // The branch HEAD moves past the base (the agent committed work).
    await writeFile(join(hostPath, 'work.txt'), 'in-flight\n');
    await git(['config', 'user.email', 'test@workflowos.invalid'], hostPath);
    await git(['config', 'user.name', 'W035 Test'], hostPath);
    await git(['add', '.'], hostPath);
    await git(['commit', '-m', 'work'], hostPath);
    const moved = (await git(['rev-parse', 'HEAD'], hostPath)).trim();
    expect(moved).not.toBe(baseSha);
    // Re-materialize (same token, same branch): re-used AS-IS — the
    // in-flight work is preserved (the idempotent re-use contract).
    const again = await materializer.materialize(input);
    expect(again).toBe(hostPath);
    const head = (await git(['rev-parse', 'HEAD'], hostPath)).trim();
    expect(head).toBe(moved);
  });

  it('a STALE worktree on a different branch is REPLACED deterministically', async () => {
    const token = `${OWNER}/${REPO}/exec/wf_00000004`;
    const first = await materializer.materialize({
      worktreePathToken: token,
      repositoryOwner: OWNER,
      repositoryName: REPO,
      branch: 'feat/w035-stale-old',
      baseRevision: baseSha,
    });
    expect(first).toBe(join(root, OWNER, REPO, 'exec', 'wf_00000004'));
    // The same deterministic path, a DIFFERENT branch (a crashed attempt
    // left the worktree on the wrong branch): replaced, not re-used.
    const second = await materializer.materialize({
      worktreePathToken: token,
      repositoryOwner: OWNER,
      repositoryName: REPO,
      branch: 'feat/w035-stale-new',
      baseRevision: baseSha,
    });
    expect(second).toBe(first);
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], second);
    expect(branch.trim()).toBe('feat/w035-stale-new');
  });

  it('FAIL-CLOSED pre-check: a missing repository directory → the typed git-repository-missing stage (never a fabricated workspace)', async () => {
    const err = await materializer
      .materialize({
        worktreePathToken: 'ghost/owner/exec/wf_00000005',
        repositoryOwner: 'ghost',
        repositoryName: 'owner',
        branch: 'feat/w035-ghost',
        baseRevision: baseSha,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WorktreeMaterializerError);
    expect(err.stage).toBe('git-repository-missing');
  });

  it('FAIL-CLOSED pre-check: a base revision that is not a commit in the repository → the typed base-revision-missing stage', async () => {
    const err = await materializer
      .materialize({
        worktreePathToken: `${OWNER}/${REPO}/exec/wf_00000006`,
        repositoryOwner: OWNER,
        repositoryName: REPO,
        branch: 'feat/w035-nobase',
        baseRevision: '0000000000000000000000000000000000000000',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WorktreeMaterializerError);
    expect(err.stage).toBe('base-revision-missing');
    // Nothing was created at the deterministic path.
    expect(await pathExists(join(root, OWNER, REPO, 'exec', 'wf_00000006'))).toBe(false);
  });

  it('the persisted token + the declared repository coordinates are CROSS-VALIDATED (a drifted row fails closed — never operate in the wrong repository)', async () => {
    const err = await materializer
      .materialize({
        worktreePathToken: `${OWNER}/${REPO}/exec/wf_00000007`,
        repositoryOwner: 'other-owner',
        repositoryName: REPO,
        branch: 'feat/w035-mismatch',
        baseRevision: baseSha,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WorktreeMaterializerError);
    expect(err.stage).toBe('token-invalid');
    expect(err.message).toContain('inconsistent with the repository coordinates');
  });

  it('a malformed worktree-path token is rejected (path-traversal-safe: no .., no empty segments, exactly owner/repository/exec/<id>)', async () => {
    for (const bad of [
      '../escape/exec/wf_00000008',
      'a/../b/exec/wf_00000009',
      'owner/repo/exec/../wf_00000010',
      'owner//repo/exec/wf_00000011',
      'owner/repo/wrong/wf_00000012',
      'owner/repo/exec',
    ]) {
      const err = await materializer
        .remove({ worktreePathToken: bad })
        .catch((e) => e);
      expect(err, `token ${bad}`).toBeInstanceOf(WorktreeMaterializerError);
      expect(err.stage, `token ${bad}`).toBe('token-invalid');
    }
  });

  it('removal is IDEMPOTENT: an existing worktree is removed; an absent one is a silent success', async () => {
    const token = `${OWNER}/${REPO}/exec/wf_00000013`;
    const hostPath = await materializer.materialize({
      worktreePathToken: token,
      repositoryOwner: OWNER,
      repositoryName: REPO,
      branch: 'feat/w035-remove',
      baseRevision: baseSha,
    });
    await materializer.remove({ worktreePathToken: token });
    expect(await pathExists(hostPath)).toBe(false);
    // Absent → success (cleanup idempotency — a retry after a crash).
    await expect(materializer.remove({ worktreePathToken: token })).resolves.toBeUndefined();
  });

  it('removal resolves the layout from the token ALONE (the durable identity is self-contained)', async () => {
    // The token — not caller-supplied coordinates — determines WHAT is
    // removed (the persisted worktree_path is the single source).
    const token = `${OWNER}/${REPO}/exec/wf_00000014`;
    const hostPath = await materializer.materialize({
      worktreePathToken: token,
      repositoryOwner: OWNER,
      repositoryName: REPO,
      branch: 'feat/w035-remove2',
      baseRevision: baseSha,
    });
    // Removal works even though the caller passes no repository info —
    // the token parses + resolves within the SAME root.
    const tokenOnlyMaterializer = new FsWorktreeMaterializer({ rootDir: root, logger: silentLogger });
    await tokenOnlyMaterializer.remove({ worktreePathToken: token });
    expect(await pathExists(hostPath)).toBe(false);
  });

  it('the base revision content is ACTUALLY checked out (reproducibility: the file content matches the base commit)', async () => {
    // A second commit on main (the repository moves forward) — the
    // workspace still materializes from the RECORDED base revision, not
    // the branch tip.
    await writeFile(join(repositoryDir, 'README.md'), '# moved-on\n');
    await git(['add', '.'], repositoryDir);
    await git(['commit', '-m', 'move on'], repositoryDir);
    const tip = (await git(['rev-parse', 'HEAD'], repositoryDir)).trim();
    expect(tip).not.toBe(baseSha);
    const hostPath = await materializer.materialize({
      worktreePathToken: `${OWNER}/${REPO}/exec/wf_00000015`,
      repositoryOwner: OWNER,
      repositoryName: REPO,
      branch: 'feat/w035-frozen-base',
      baseRevision: baseSha,
    });
    const content = await readFile(join(hostPath, 'README.md'), 'utf8');
    expect(content).toBe('# base\n'); // the RECORDED base, not the tip
  });
});
