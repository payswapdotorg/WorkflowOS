/**
 * WORK-037 PR-#41 FIX (round 2) — the CANONICAL package-command classifier
 * unit matrix.
 *
 * The architect's review of PR #41 at `35420da` approved the git-argv
 * canonical classifier (shared by the policy engine + the process
 * executor) and flagged the package family's positional
 * `args[0] === 'publish'` shortcut as the analogous remaining gap:
 * package runners (npm/pnpm/yarn/bun) permit global/config options BEFORE
 * the effective subcommand (e.g. `npm --registry=<url> publish`), so a
 * positional args[0] check could classify a REGISTRY publication as
 * ordinary `tool` activity → allow/constrained instead of the required
 * deployment deny. The classifier (shared by the policy engine + the
 * process executor) finds the EFFECTIVE subcommand by skipping the
 * runner's global options first, and fail-closes on ambiguity.
 *
 * This is the pure-function proof (no DB, no process spawning): every
 * architect-required scenario — `npm publish`, `npm --registry=... publish`,
 * equivalent supported-runner forms, normal `npm test`, ambiguous cases —
 * plus the fail-closed ambiguity path. The engine + executor integration
 * is covered by the agent-policy + tool-runtime regression suites.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPackageSubcommand,
  isPackageDeploymentInvocation,
  PACKAGE_PUBLISH_CAPABLE_RUNNERS,
  PACKAGE_DEPLOYMENT_SUBCOMMANDS,
  PACKAGE_GLOBAL_VALUE_OPTIONS,
  PACKAGE_GLOBAL_VALUE_OPTIONS_SHORT,
  PACKAGE_GLOBAL_BOOLEAN_OPTIONS,
  PACKAGE_GLOBAL_BOOLEAN_OPTIONS_SHORT,
} from '../../src/platform/tools/package-argv.js';

describe('WORK-037 PR-#41 round 2 — the canonical package-command classifier', () => {
  // -------------------------------------------------------------------------
  // The architect's exact example + the family of "options before publish".
  // -------------------------------------------------------------------------
  describe('options BEFORE publish (the registry publication must still be deployment-class)', () => {
    it('`npm publish` (bare) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['publish'])).toBe(true);
    });

    it('`npm --registry=http://x publish` (the architect\'s exact example, = form) → deployment', () => {
      // The positional args[0] check saw `--registry=http://x` → NOT
      // deployment → WRONG (allow/constrained). The classifier skips the
      // `--registry=http://x` single token (the value is attached) →
      // effective subcommand `publish` → deployment.
      expect(isPackageDeploymentInvocation('npm', ['--registry=http://x', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['--registry=http://x', 'publish']).subcommand).toBe('publish');
    });

    it('`npm --registry http://x publish` (the architect\'s example, space form) → deployment', () => {
      // The space form: --registry consumes the NEXT token (the URL) as its
      // value, so the URL is NOT mistaken for the subcommand; `publish` is.
      expect(isPackageDeploymentInvocation('npm', ['--registry', 'http://x', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['--registry', 'http://x', 'publish']).subcommand).toBe('publish');
    });

    it('`npm --registry=https://registry.npmjs.org publish` (realistic URL) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--registry=https://registry.npmjs.org', 'publish'])).toBe(true);
    });

    it('`npm --silent publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--silent', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['--silent', 'publish']).subcommand).toBe('publish');
    });

    it('`npm -s publish` (short --silent) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['-s', 'publish'])).toBe(true);
    });

    it('`npm --quiet publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--quiet', 'publish'])).toBe(true);
    });

    it('`npm -q publish` (short --quiet) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['-q', 'publish'])).toBe(true);
    });

    it('`npm --dry-run publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--dry-run', 'publish'])).toBe(true);
    });

    it('`npm --json publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--json', 'publish'])).toBe(true);
    });

    it('`npm --workspace=foo publish` (= form, value option) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--workspace=foo', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['--workspace=foo', 'publish']).subcommand).toBe('publish');
    });

    it('`npm --workspace foo publish` (space form, value option) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--workspace', 'foo', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['--workspace', 'foo', 'publish']).subcommand).toBe('publish');
    });

    it('`npm --scope=@myorg publish` (= form) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--scope=@myorg', 'publish'])).toBe(true);
    });

    it('`npm --access=public publish` (= form) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--access=public', 'publish'])).toBe(true);
    });

    it('`npm --tag=beta publish` (= form) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--tag=beta', 'publish'])).toBe(true);
    });

    it('`npm --userconfig=/etc/.npmrc publish` (= form) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--userconfig=/etc/.npmrc', 'publish'])).toBe(true);
    });

    it('`npm publish --tag beta` (option AFTER the subcommand) → deployment', () => {
      // The effective subcommand is the FIRST positional (`publish`); the
      // `--tag beta` after it is the subcommand's own args (irrelevant).
      expect(isPackageDeploymentInvocation('npm', ['publish', '--tag', 'beta'])).toBe(true);
    });

    it('`npm --registry=http://x publish --tag beta` (option before + after) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--registry=http://x', 'publish', '--tag', 'beta'])).toBe(true);
    });

    it('multiple options stacked: `npm --silent --registry=http://x --workspace=foo publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--silent', '--registry=http://x', '--workspace=foo', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['--silent', '--registry=http://x', '--workspace=foo', 'publish']).subcommand).toBe('publish');
    });

    it('`npm -- publish` (-- terminator, next token is the subcommand) → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['--', 'publish']).subcommand).toBe('publish');
    });
  });

  // -------------------------------------------------------------------------
  // The publish-family siblings (unpublish / deprecate) — same attack.
  // -------------------------------------------------------------------------
  describe('the publish-family siblings (unpublish / deprecate) behind options', () => {
    it('`npm unpublish` → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['unpublish'])).toBe(true);
    });

    it('`npm --registry=http://x unpublish` → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--registry=http://x', 'unpublish'])).toBe(true);
    });

    it('`npm --silent deprecate` → deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--silent', 'deprecate'])).toBe(true);
    });

    it('every member of PACKAGE_DEPLOYMENT_SUBCOMMANDS is recognized behind `--registry=http://x`', () => {
      // The deployment set + the classifier must agree — no subcommand is
      // deployment-tagged in the bare case but missed when behind options.
      for (const sub of PACKAGE_DEPLOYMENT_SUBCOMMANDS) {
        expect(isPackageDeploymentInvocation('npm', ['--registry=http://x', sub]), `npm --registry=http://x ${sub}`).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // The equivalent supported-runner forms (pnpm / yarn / bun) — the
  // classifier is appropriate to ALL publish-capable runners.
  // -------------------------------------------------------------------------
  describe('the equivalent supported-runner forms (pnpm / yarn / bun)', () => {
    it('`pnpm publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('pnpm', ['publish'])).toBe(true);
    });

    it('`pnpm --registry=http://x publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('pnpm', ['--registry=http://x', 'publish'])).toBe(true);
    });

    it('`pnpm --filter foo publish` (workspace filter, space form) → deployment', () => {
      // The space form: --filter consumes `foo` as its value → `publish` is
      // the effective subcommand. Without --filter in the value set, `foo`
      // would be mistaken for the subcommand → NOT deployment → WRONG.
      expect(isPackageDeploymentInvocation('pnpm', ['--filter', 'foo', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['--filter', 'foo', 'publish']).subcommand).toBe('publish');
    });

    it('`pnpm -C /path publish` (cwd, short value option) → deployment', () => {
      expect(isPackageDeploymentInvocation('pnpm', ['-C', '/path', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['-C', '/path', 'publish']).subcommand).toBe('publish');
    });

    it('`pnpm --silent publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('pnpm', ['--silent', 'publish'])).toBe(true);
    });

    it('`yarn publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('yarn', ['publish'])).toBe(true);
    });

    it('`yarn --cwd /path publish` (cwd, long value option) → deployment', () => {
      expect(isPackageDeploymentInvocation('yarn', ['--cwd', '/path', 'publish'])).toBe(true);
      expect(classifyPackageSubcommand(['--cwd', '/path', 'publish']).subcommand).toBe('publish');
    });

    it('`yarn -C /path publish` (cwd, short value option) → deployment', () => {
      expect(isPackageDeploymentInvocation('yarn', ['-C', '/path', 'publish'])).toBe(true);
    });

    it('`yarn --registry=http://x publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('yarn', ['--registry=http://x', 'publish'])).toBe(true);
    });

    it('`bun publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('bun', ['publish'])).toBe(true);
    });

    it('`bun --cwd /path publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('bun', ['--cwd', '/path', 'publish'])).toBe(true);
    });

    it('`bun --registry=http://x publish` → deployment', () => {
      expect(isPackageDeploymentInvocation('bun', ['--registry=http://x', 'publish'])).toBe(true);
    });

    it('every publish-capable runner × `--registry=http://x publish` → deployment', () => {
      for (const runner of PACKAGE_PUBLISH_CAPABLE_RUNNERS) {
        expect(isPackageDeploymentInvocation(runner, ['--registry=http://x', 'publish']), `${runner} --registry=http://x publish`).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Normal (local) package commands must NOT be deployment (the
  // allow/constrained path is preserved — the fix is surgical).
  // -------------------------------------------------------------------------
  describe('LOCAL package commands are NOT deployment (the allow/constrained path is preserved)', () => {
    it('`npm test` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['test'])).toBe(false);
      expect(classifyPackageSubcommand(['test']).subcommand).toBe('test');
    });

    it('`npm --silent test` → NOT deployment (the boolean option is skipped)', () => {
      expect(isPackageDeploymentInvocation('npm', ['--silent', 'test'])).toBe(false);
      expect(classifyPackageSubcommand(['--silent', 'test']).subcommand).toBe('test');
    });

    it('`npm -q test` (short --quiet) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['-q', 'test'])).toBe(false);
    });

    it('`npm --registry=http://x test` → NOT deployment (the = value option is skipped)', () => {
      // The architect's exact example, but with a LOCAL subcommand: the
      // --registry override is skipped; `test` is the effective subcommand.
      expect(isPackageDeploymentInvocation('npm', ['--registry=http://x', 'test'])).toBe(false);
      expect(classifyPackageSubcommand(['--registry=http://x', 'test']).subcommand).toBe('test');
    });

    it('`npm --registry http://x test` (space form, local subcommand) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--registry', 'http://x', 'test'])).toBe(false);
      expect(classifyPackageSubcommand(['--registry', 'http://x', 'test']).subcommand).toBe('test');
    });

    it('`npm --workspace foo test` (value option, local subcommand) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--workspace', 'foo', 'test'])).toBe(false);
    });

    it('`npm run build` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['run', 'build'])).toBe(false);
    });

    it('`npm install` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['install'])).toBe(false);
    });

    it('`npm --silent install` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--silent', 'install'])).toBe(false);
    });

    it('`pnpm test` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('pnpm', ['test'])).toBe(false);
    });

    it('`pnpm --filter foo test` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('pnpm', ['--filter', 'foo', 'test'])).toBe(false);
    });

    it('`yarn test` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('yarn', ['test'])).toBe(false);
    });

    it('`bun test` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('bun', ['test'])).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Non-publish-capable runners (node / npx / tsx / vitest / jest / tsc) —
  // `publish` as a positional is a script/argument name, NOT a registry
  // publication → never deployment (the runner gate returns false).
  // -------------------------------------------------------------------------
  describe('non-publish-capable runners (node / npx / tsx / vitest / jest / tsc)', () => {
    it('`node script.js` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('node', ['script.js'])).toBe(false);
    });

    it('`node --inspect publish.js` (node flag + a script named publish.js) → NOT deployment', () => {
      // node has NO `publish` subcommand; `publish.js` is a script filename.
      // The runner gate returns false BEFORE the subcommand is examined.
      expect(isPackageDeploymentInvocation('node', ['--inspect', 'publish.js'])).toBe(false);
    });

    it('`node publish` (a script literally named publish, no extension) → NOT deployment', () => {
      // Even though the first positional is `publish`, node is not
      // publish-capable → not deployment (node cannot publish to a registry).
      expect(isPackageDeploymentInvocation('node', ['publish'])).toBe(false);
    });

    it('`npx publish` (npx would run a package literally named `publish`) → NOT deployment', () => {
      // npx is not a publish-capable package manager; `publish` here is the
      // name of a package npx would fetch+run (a separate concern outside
      // the deployment-domain classification).
      expect(isPackageDeploymentInvocation('npx', ['publish'])).toBe(false);
    });

    it('`tsx script.ts` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('tsx', ['script.ts'])).toBe(false);
    });

    it('`vitest run` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('vitest', ['run'])).toBe(false);
    });

    it('`jest` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('jest', [])).toBe(false);
    });

    it('`tsc --noEmit` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('tsc', ['--noEmit'])).toBe(false);
    });

    it('`eslint src/` → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('eslint', ['src/'])).toBe(false);
    });

    it('an unknown runner `weird-tool publish` → NOT deployment (weird-tool is not publish-capable)', () => {
      // The classifier is appropriate to the SUPPORTED package runners
      // (npm/pnpm/yarn/bun); an unknown runner is not publish-capable →
      // not deployment. (If `weird-tool` could publish, that is an
      // arbitrary-binary-execution concern outside the deployment domain.)
      expect(isPackageDeploymentInvocation('weird-tool', ['publish'])).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // No effective subcommand (print-and-exit helpers + empty argv).
  // -------------------------------------------------------------------------
  describe('no effective subcommand (print-and-exit / empty argv)', () => {
    it('`npm --version` → NOT deployment (print-and-exit, no subcommand)', () => {
      expect(isPackageDeploymentInvocation('npm', ['--version'])).toBe(false);
      expect(classifyPackageSubcommand(['--version']).subcommand).toBe(null);
    });

    it('`npm -v` (short --version) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['-v'])).toBe(false);
    });

    it('`npm --help` → NOT deployment (print-and-exit)', () => {
      expect(isPackageDeploymentInvocation('npm', ['--help'])).toBe(false);
    });

    it('`npm -h` (short --help) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['-h'])).toBe(false);
    });

    it('`npm --silent` (no subcommand) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--silent'])).toBe(false);
      expect(classifyPackageSubcommand(['--silent']).subcommand).toBe(null);
    });

    it('`npm` (empty args) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', [])).toBe(false);
      expect(classifyPackageSubcommand([]).subcommand).toBe(null);
    });
  });

  // -------------------------------------------------------------------------
  // Ambiguity → fail-closed (treat as deployment so a crafted unknown
  // option cannot smuggle a registry publication past the deployment rule).
  // -------------------------------------------------------------------------
  describe('ambiguity (unknown option before the subcommand) → fail-closed deployment', () => {
    it('`npm -Z publish` (unknown short option) → deployment (fail-closed)', () => {
      const c = classifyPackageSubcommand(['-Z', 'publish']);
      expect(c.subcommand).toBe('publish');
      expect(c.ambiguous).toBe(true);
      expect(isPackageDeploymentInvocation('npm', ['-Z', 'publish'])).toBe(true);
    });

    it('`npm --future-flag publish` (unknown long option before publish) → deployment (fail-closed)', () => {
      const c = classifyPackageSubcommand(['--future-flag', 'publish']);
      expect(c.subcommand).toBe('publish');
      expect(c.ambiguous).toBe(true);
      expect(isPackageDeploymentInvocation('npm', ['--future-flag', 'publish'])).toBe(true);
    });

    it('`npm --future-flag test` (unknown long option before a LOCAL subcommand) → deployment (fail-closed)', () => {
      // test is local, but the unknown option before it means we cannot
      // confidently classify → treat as deployment (deny by default).
      const c = classifyPackageSubcommand(['--future-flag', 'test']);
      expect(c.subcommand).toBe('test');
      expect(c.ambiguous).toBe(true);
      expect(isPackageDeploymentInvocation('npm', ['--future-flag', 'test'])).toBe(true);
    });

    it('`npm --future-flag` (unknown long option, no subcommand) → deployment (fail-closed)', () => {
      const c = classifyPackageSubcommand(['--future-flag']);
      expect(c.subcommand).toBe(null);
      expect(c.ambiguous).toBe(true);
      expect(isPackageDeploymentInvocation('npm', ['--future-flag'])).toBe(true);
    });

    it('`npm --future-opt=val publish` (unknown long option, = form) → deployment (fail-closed)', () => {
      expect(isPackageDeploymentInvocation('npm', ['--future-opt=val', 'publish'])).toBe(true);
    });

    it('`npm --future-opt=val test` (unknown long option, = form, local subcommand) → deployment (fail-closed)', () => {
      expect(isPackageDeploymentInvocation('npm', ['--future-opt=val', 'test'])).toBe(true);
    });

    it('`pnpm --future-flag publish` (unknown long option, pnpm) → deployment (fail-closed)', () => {
      expect(isPackageDeploymentInvocation('pnpm', ['--future-flag', 'publish'])).toBe(true);
    });

    it('`yarn --future-flag publish` (unknown long option, yarn) → deployment (fail-closed)', () => {
      expect(isPackageDeploymentInvocation('yarn', ['--future-flag', 'publish'])).toBe(true);
    });

    it('`bun --future-flag publish` (unknown long option, bun) → deployment (fail-closed)', () => {
      expect(isPackageDeploymentInvocation('bun', ['--future-flag', 'publish'])).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // The value-taking option's value cannot smuggle a deployment-looking token.
  // -------------------------------------------------------------------------
  describe('the value-taking option\'s value cannot smuggle a publish-looking token', () => {
    it('`npm --registry publish` (publish is the --registry VALUE, not the subcommand) → NOT deployment', () => {
      // --registry (space form) consumes `publish` as its value; there is no
      // subcommand. `npm --registry publish` would error (invalid URL), so
      // NOT-deployment is harmless. This proves --registry is recognized as
      // value-taking (its value cannot masquerade as the subcommand).
      const c = classifyPackageSubcommand(['--registry', 'publish']);
      expect(c.subcommand).toBe(null);
      expect(c.ambiguous).toBe(false);
      expect(isPackageDeploymentInvocation('npm', ['--registry', 'publish'])).toBe(false);
    });

    it('`npm --workspace publish` (publish is the --workspace VALUE) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('npm', ['--workspace', 'publish'])).toBe(false);
    });

    it('`pnpm --filter publish` (publish is the --filter VALUE) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('pnpm', ['--filter', 'publish'])).toBe(false);
    });

    it('`pnpm -C publish` (publish is the -C VALUE) → NOT deployment', () => {
      expect(isPackageDeploymentInvocation('pnpm', ['-C', 'publish'])).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // The shared vocabulary (one source of truth — no second copy anywhere).
  // -------------------------------------------------------------------------
  describe('the shared vocabulary (one source of truth)', () => {
    it('PACKAGE_PUBLISH_CAPABLE_RUNNERS contains npm / pnpm / yarn / bun', () => {
      for (const runner of ['npm', 'pnpm', 'yarn', 'bun']) {
        expect(PACKAGE_PUBLISH_CAPABLE_RUNNERS.has(runner), `${runner} is publish-capable`).toBe(true);
      }
      // Non-publish-capable runners are NOT in the set.
      for (const runner of ['node', 'npx', 'tsx', 'vitest', 'jest', 'tsc', 'eslint']) {
        expect(PACKAGE_PUBLISH_CAPABLE_RUNNERS.has(runner), `${runner} is NOT publish-capable`).toBe(false);
      }
    });

    it('PACKAGE_DEPLOYMENT_SUBCOMMANDS contains the publish family', () => {
      for (const sub of ['publish', 'unpublish', 'deprecate']) {
        expect(PACKAGE_DEPLOYMENT_SUBCOMMANDS.has(sub), `${sub} is deployment-class`).toBe(true);
      }
      // Local subcommands are NOT in the deployment set.
      for (const sub of ['test', 'run', 'install', 'ci', 'start', 'build']) {
        expect(PACKAGE_DEPLOYMENT_SUBCOMMANDS.has(sub), `${sub} is NOT deployment-class`).toBe(false);
      }
    });

    it('PACKAGE_GLOBAL_VALUE_OPTIONS contains --registry (the architect\'s example) + the workspace/cwd/filter value-takers', () => {
      expect(PACKAGE_GLOBAL_VALUE_OPTIONS.has('--registry')).toBe(true);
      for (const opt of ['--workspace', '--filter', '--cwd', '--prefix', '--cache', '--scope', '--otp', '--tag', '--access']) {
        expect(PACKAGE_GLOBAL_VALUE_OPTIONS.has(opt), `${opt} takes a value`).toBe(true);
      }
    });

    it('PACKAGE_GLOBAL_VALUE_OPTIONS_SHORT contains -C (the cwd selector)', () => {
      expect(PACKAGE_GLOBAL_VALUE_OPTIONS_SHORT.has('-C')).toBe(true);
    });

    it('PACKAGE_GLOBAL_BOOLEAN_OPTIONS contains the silence/verbosity/dry-run toggles', () => {
      for (const opt of ['--silent', '--quiet', '--dry-run', '--json', '--offline', '--verbose', '--workspaces', '--ignore-scripts']) {
        expect(PACKAGE_GLOBAL_BOOLEAN_OPTIONS.has(opt), `${opt} is boolean`).toBe(true);
      }
    });

    it('PACKAGE_GLOBAL_BOOLEAN_OPTIONS_SHORT contains the npm common shorts', () => {
      for (const opt of ['-q', '-s', '-d', '-dd', '-ddd', '-v', '-h']) {
        expect(PACKAGE_GLOBAL_BOOLEAN_OPTIONS_SHORT.has(opt), `${opt} is a boolean short`).toBe(true);
      }
    });
  });
});
