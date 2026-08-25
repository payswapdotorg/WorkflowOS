/**
 * WORK-037 PR-#41 FIX — the CANONICAL git argv classifier unit matrix.
 *
 * The architect's finding: git deployment classification only checked
 * args[0]; git permits global/config options BEFORE the effective
 * subcommand (e.g. `git -c k=v push`), so a positional args[0] check
 * could classify a REMOTE mutation as ordinary `tool` activity →
 * allow/constrained instead of the required deployment deny. The
 * classifier (shared by the policy engine + the process executor) finds
 * the EFFECTIVE subcommand by skipping git's global options first.
 *
 * This is the pure-function proof (no DB, no process spawning): every
 * architect-required scenario — options before push, fetch, remote,
 * clone, etc. — plus the fail-closed ambiguity path. The engine +
 * executor integration is covered by the agent-policy + tool-runtime
 * regression suites.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyGitSubcommand,
  isGitDeploymentInvocation,
  GIT_DEPLOYMENT_SUBCOMMANDS,
  GIT_GLOBAL_VALUE_OPTIONS,
  GIT_GLOBAL_VALUE_OPTIONS_SHORT,
  GIT_GLOBAL_BOOLEAN_OPTIONS,
  GIT_REDIRECT_FLAGS,
} from '../../src/platform/tools/git-argv.js';

describe('WORK-037 PR-#41 — the canonical git argv classifier', () => {
  // -------------------------------------------------------------------------
  // The architect's exact example + the family of "options before push".
  // -------------------------------------------------------------------------
  describe('options BEFORE push (the remote mutation must still be deployment-class)', () => {
    it('`git push` (bare) → deployment', () => {
      expect(isGitDeploymentInvocation(['push'])).toBe(true);
    });

    it('`git -c k=v push` (the architect\'s exact example) → deployment', () => {
      // The positional args[0] check saw `-c` → NOT deployment → WRONG (allow).
      // The classifier skips `-c` + its value `k=v` → effective subcommand `push`.
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'push'])).toBe(true);
      expect(classifyGitSubcommand(['-c', 'k=v', 'push']).subcommand).toBe('push');
    });

    it('`git -c user.email=x@y push` (realistic config override) → deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'user.email=x@y', 'push'])).toBe(true);
    });

    it('`git --no-pager push` → deployment', () => {
      expect(isGitDeploymentInvocation(['--no-pager', 'push'])).toBe(true);
      expect(classifyGitSubcommand(['--no-pager', 'push']).subcommand).toBe('push');
    });

    it('`git -P push` (short --no-pager) → deployment', () => {
      expect(isGitDeploymentInvocation(['-P', 'push'])).toBe(true);
    });

    it('`git --paginate push` → deployment', () => {
      expect(isGitDeploymentInvocation(['--paginate', 'push'])).toBe(true);
    });

    it('`git -p push` (short --paginate) → deployment', () => {
      expect(isGitDeploymentInvocation(['-p', 'push'])).toBe(true);
    });

    it('`git -C /path push` (chdir before push; also a redirect flag) → deployment', () => {
      expect(isGitDeploymentInvocation(['-C', '/path', 'push'])).toBe(true);
      expect(classifyGitSubcommand(['-C', '/path', 'push']).subcommand).toBe('push');
    });

    it('`git --git-dir=/foo push` (= form, single token) → deployment', () => {
      expect(isGitDeploymentInvocation(['--git-dir=/foo', 'push'])).toBe(true);
      expect(classifyGitSubcommand(['--git-dir=/foo', 'push']).subcommand).toBe('push');
    });

    it('`git --git-dir /foo push` (space form, two tokens) → deployment', () => {
      expect(isGitDeploymentInvocation(['--git-dir', '/foo', 'push'])).toBe(true);
      expect(classifyGitSubcommand(['--git-dir', '/foo', 'push']).subcommand).toBe('push');
    });

    it('`git --work-tree=/foo push` → deployment', () => {
      expect(isGitDeploymentInvocation(['--work-tree=/foo', 'push'])).toBe(true);
    });

    it('`git --namespace=foo push` → deployment', () => {
      expect(isGitDeploymentInvocation(['--namespace=foo', 'push'])).toBe(true);
    });

    it('`git --namespace foo push` (space form) → deployment', () => {
      expect(isGitDeploymentInvocation(['--namespace', 'foo', 'push'])).toBe(true);
    });

    it('`git --super-prefix=/x push` → deployment', () => {
      expect(isGitDeploymentInvocation(['--super-prefix=/x', 'push'])).toBe(true);
    });

    it('`git --config-env=NAME=VAR push` → deployment', () => {
      expect(isGitDeploymentInvocation(['--config-env=NAME=VAR', 'push'])).toBe(true);
    });

    it('`git --bare push` → deployment', () => {
      expect(isGitDeploymentInvocation(['--bare', 'push'])).toBe(true);
    });

    it('multiple options stacked: `git --no-pager -c k=v --git-dir=/foo push` → deployment', () => {
      expect(isGitDeploymentInvocation(['--no-pager', '-c', 'k=v', '--git-dir=/foo', 'push'])).toBe(true);
      expect(classifyGitSubcommand(['--no-pager', '-c', 'k=v', '--git-dir=/foo', 'push']).subcommand).toBe('push');
    });

    it('push with refspecs after the subcommand: `git -c k=v push origin main` → deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'push', 'origin', 'main'])).toBe(true);
    });

    it('`git -- push` (-- terminator, next token is the subcommand) → deployment', () => {
      expect(isGitDeploymentInvocation(['--', 'push'])).toBe(true);
      expect(classifyGitSubcommand(['--', 'push']).subcommand).toBe('push');
    });
  });

  // -------------------------------------------------------------------------
  // The other remote-mutating subcommands — same options-before attack.
  // -------------------------------------------------------------------------
  describe('options BEFORE fetch / remote / clone / pull / ls-remote / submodule', () => {
    it('`git -c k=v fetch` → deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'fetch'])).toBe(true);
    });

    it('`git --no-pager fetch origin` → deployment', () => {
      expect(isGitDeploymentInvocation(['--no-pager', 'fetch', 'origin'])).toBe(true);
    });

    it('`git -c k=v remote` → deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'remote'])).toBe(true);
    });

    it('`git --no-pager remote -v` → deployment', () => {
      expect(isGitDeploymentInvocation(['--no-pager', 'remote', '-v'])).toBe(true);
    });

    it('`git -c k=v clone https://github.com/x/y.git` → deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'clone', 'https://github.com/x/y.git'])).toBe(true);
    });

    it('`git --no-pager pull` → deployment', () => {
      expect(isGitDeploymentInvocation(['--no-pager', 'pull'])).toBe(true);
    });

    it('`git -c k=v ls-remote` → deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'ls-remote'])).toBe(true);
    });

    it('`git --no-pager submodule update` → deployment', () => {
      expect(isGitDeploymentInvocation(['--no-pager', 'submodule', 'update'])).toBe(true);
    });

    it('`git -c k=v fetch-pack` → deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'fetch-pack'])).toBe(true);
    });

    it('`git -c k=v svn` (the git-svn bridge) → deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'svn'])).toBe(true);
    });

    it('every member of GIT_DEPLOYMENT_SUBCOMMANDS is recognized behind `-c k=v`', () => {
      // The deployment set + the classifier must agree — no subcommand is
      // deployment-tagged in the bare case but missed when behind options.
      for (const sub of GIT_DEPLOYMENT_SUBCOMMANDS) {
        expect(isGitDeploymentInvocation(['-c', 'k=v', sub]), `git -c k=v ${sub}`).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Local subcommands must NOT be deployment (the policy allow path).
  // -------------------------------------------------------------------------
  describe('LOCAL subcommands are NOT deployment (the allow path is preserved)', () => {
    it('`git status` → NOT deployment', () => {
      expect(isGitDeploymentInvocation(['status'])).toBe(false);
    });

    it('`git --no-pager status` → NOT deployment (the boolean option is skipped)', () => {
      expect(isGitDeploymentInvocation(['--no-pager', 'status'])).toBe(false);
      expect(classifyGitSubcommand(['--no-pager', 'status']).subcommand).toBe('status');
    });

    it('`git -c k=v status` → NOT deployment (the -c value is skipped)', () => {
      // The positional args[0] check saw `-c` → NOT deployment → (accidentally
      // correct here, but for the WRONG reason). The classifier is correct
      // for the RIGHT reason: it skips `-c` + value, finds `status`.
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'status'])).toBe(false);
      expect(classifyGitSubcommand(['-c', 'k=v', 'status']).subcommand).toBe('status');
    });

    it('`git -C /worktree status` → NOT deployment (the -C value is skipped)', () => {
      expect(isGitDeploymentInvocation(['-C', '/worktree', 'status'])).toBe(false);
    });

    it('`git --git-dir=/foo status` → NOT deployment', () => {
      expect(isGitDeploymentInvocation(['--git-dir=/foo', 'status'])).toBe(false);
    });

    it('`git log` → NOT deployment', () => {
      expect(isGitDeploymentInvocation(['log'])).toBe(false);
    });

    it('`git -c user.email=x@y log --oneline` → NOT deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'user.email=x@y', 'log', '--oneline'])).toBe(false);
    });

    it('`git add .` → NOT deployment', () => {
      expect(isGitDeploymentInvocation(['add', '.'])).toBe(false);
    });

    it('`git -c k=v commit -m msg` → NOT deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'k=v', 'commit', '-m', 'msg'])).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // No effective subcommand (print-and-exit helpers + empty argv).
  // -------------------------------------------------------------------------
  describe('no effective subcommand (print-and-exit / empty argv)', () => {
    it('`git --version` → NOT deployment (print-and-exit, no subcommand)', () => {
      expect(isGitDeploymentInvocation(['--version'])).toBe(false);
      expect(classifyGitSubcommand(['--version']).subcommand).toBe(null);
    });

    it('`git --exec-path` → NOT deployment (print-and-exit)', () => {
      expect(isGitDeploymentInvocation(['--exec-path'])).toBe(false);
      expect(classifyGitSubcommand(['--exec-path']).subcommand).toBe(null);
    });

    it('`git --html-path` / `--man-path` / `--info-path` → NOT deployment', () => {
      for (const opt of ['--html-path', '--man-path', '--info-path']) {
        expect(isGitDeploymentInvocation([opt]), opt).toBe(false);
      }
    });

    it('`git --no-pager` (no subcommand) → NOT deployment', () => {
      expect(isGitDeploymentInvocation(['--no-pager'])).toBe(false);
      expect(classifyGitSubcommand(['--no-pager']).subcommand).toBe(null);
    });

    it('`git` (empty args) → NOT deployment', () => {
      expect(isGitDeploymentInvocation([])).toBe(false);
      expect(classifyGitSubcommand([]).subcommand).toBe(null);
    });
  });

  // -------------------------------------------------------------------------
  // Ambiguity → fail-closed (treat as deployment so a crafted unknown
  // option cannot smuggle a remote mutation past the deployment rule).
  // -------------------------------------------------------------------------
  describe('ambiguity (unknown option before the subcommand) → fail-closed deployment', () => {
    it('`git -Z push` (unknown short option) → deployment (fail-closed)', () => {
      const c = classifyGitSubcommand(['-Z', 'push']);
      expect(c.subcommand).toBe('push');
      expect(c.ambiguous).toBe(true);
      expect(isGitDeploymentInvocation(['-Z', 'push'])).toBe(true);
    });

    it('`git --future-flag status` (unknown long option before a LOCAL subcommand) → deployment (fail-closed)', () => {
      // status is local, but the unknown option before it means we cannot
      // confidently classify → treat as deployment (deny by default).
      const c = classifyGitSubcommand(['--future-flag', 'status']);
      expect(c.subcommand).toBe('status');
      expect(c.ambiguous).toBe(true);
      expect(isGitDeploymentInvocation(['--future-flag', 'status'])).toBe(true);
    });

    it('`git --future-flag` (unknown long option, no subcommand) → deployment (fail-closed)', () => {
      const c = classifyGitSubcommand(['--future-flag']);
      expect(c.subcommand).toBe(null);
      expect(c.ambiguous).toBe(true);
      expect(isGitDeploymentInvocation(['--future-flag'])).toBe(true);
    });

    it('`git --future-opt=val push` (unknown long option, = form) → deployment (fail-closed)', () => {
      expect(isGitDeploymentInvocation(['--future-opt=val', 'push'])).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // The `-c` value cannot smuggle a deployment-looking token.
  // -------------------------------------------------------------------------
  describe('the -c value cannot smuggle a deployment-looking token', () => {
    it('`git -c push` (push is the -c VALUE, not the subcommand) → NOT deployment', () => {
      // -c consumes `push` as its value; there is no subcommand. `git -c push`
      // would error (invalid config), so NOT-deployment is harmless.
      const c = classifyGitSubcommand(['-c', 'push']);
      expect(c.subcommand).toBe(null);
      expect(c.ambiguous).toBe(false);
      expect(isGitDeploymentInvocation(['-c', 'push'])).toBe(false);
    });

    it('`git -c fetch` (fetch is the -c VALUE) → NOT deployment', () => {
      expect(isGitDeploymentInvocation(['-c', 'fetch'])).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // The shared vocabulary (one source of truth — no second copy anywhere).
  // -------------------------------------------------------------------------
  describe('the shared vocabulary (one source of truth)', () => {
    it('GIT_DEPLOYMENT_SUBCOMMANDS contains the remote-mutating family', () => {
      for (const sub of ['push', 'pull', 'fetch', 'clone', 'remote', 'ls-remote', 'submodule']) {
        expect(GIT_DEPLOYMENT_SUBCOMMANDS.has(sub), `${sub} is deployment-class`).toBe(true);
      }
      // The git-svn bridge + the smart-http / daemon servers + plumbing.
      for (const sub of ['svn', 'daemon', 'http-backend', 'fetch-pack', 'upload-pack', 'send-pack', 'receive-pack']) {
        expect(GIT_DEPLOYMENT_SUBCOMMANDS.has(sub), `${sub} is deployment-class`).toBe(true);
      }
      // Local subcommands are NOT in the deployment set.
      for (const sub of ['status', 'log', 'add', 'commit', 'diff', 'show', 'branch']) {
        expect(GIT_DEPLOYMENT_SUBCOMMANDS.has(sub), `${sub} is NOT deployment-class`).toBe(false);
      }
    });

    it('GIT_GLOBAL_VALUE_OPTIONS_SHORT contains -c (the architect\'s example) + -C', () => {
      expect(GIT_GLOBAL_VALUE_OPTIONS_SHORT.has('-c')).toBe(true);
      expect(GIT_GLOBAL_VALUE_OPTIONS_SHORT.has('-C')).toBe(true);
    });

    it('GIT_GLOBAL_VALUE_OPTIONS contains the redirect-class value-takers', () => {
      for (const opt of ['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--upload-pack', '--receive-pack']) {
        expect(GIT_GLOBAL_VALUE_OPTIONS.has(opt), `${opt} takes a value`).toBe(true);
      }
    });

    it('GIT_GLOBAL_BOOLEAN_OPTIONS contains the pager toggles + pathspec modes', () => {
      for (const opt of ['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--no-optional-locks']) {
        expect(GIT_GLOBAL_BOOLEAN_OPTIONS.has(opt), `${opt} is boolean`).toBe(true);
      }
    });

    it('GIT_REDIRECT_FLAGS is the executor\'s redirect-anywhere vocabulary', () => {
      for (const flag of ['-C', '--git-dir', '--work-tree', '--namespace', '--upload-pack', '--exec-path', '--global', '--system']) {
        expect(GIT_REDIRECT_FLAGS.has(flag), `${flag} is a redirect flag`).toBe(true);
      }
    });
  });
});
