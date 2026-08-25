/**
 * WORK-037 PR-#41 FIX (round 2): the CANONICAL package-command classifier —
 * ONE vocabulary shared by BOTH the agent policy engine (deployment-domain
 * tagging) and the process tool executor (publish-rejection governance
 * gate). The two layers previously each inspected args[0] positionally
 * (`if (args[0] === 'publish') domains.add('deployment')` in the engine;
 * the executor did not classify publish at all); package runners permit
 * GLOBAL / CONFIG options BEFORE the effective subcommand (e.g.
 * `npm --registry=<url> publish`, `npm --silent publish`,
 * `pnpm -C /path publish`, `pnpm --filter <pkg> publish`,
 * `yarn --cwd /path publish`), so a positional args[0] check could classify
 * a REGISTRY publication as ordinary `tool` activity — the policy engine
 * would return allow / constrained instead of the required deployment deny,
 * and the executor would spawn the publish (relying on the sandbox to
 * block the network egress — defense-in-depth, NOT the authority). This
 * classifier finds the EFFECTIVE subcommand by skipping the runner's
 * global options first, and fail-closes on ambiguity.
 *
 * This is the package-family twin of ./git-argv.ts — the architect's
 * review of PR #41 at `35420da` approved the git-argv canonical classifier
 * (shared by both layers) and flagged the package family's positional
 * `args[0] === 'publish'` shortcut as the analogous remaining gap. The
 * frozen WORK-037 contract (agent-policy.types.ts) defines the `deployment`
 * domain as "structurally identifiable publication actions: git
 * remote-mutating subcommands (push/pull/fetch/clone/remote/…) and
 * package 'publish' commands." This classifier owns the package side of
 * that contract — ONE source of truth (no second copy in the engine; a
 * mismatch would let policy-allow what the executor rejects, or vice
 * versa).
 *
 * Pure: no IO, no deps. Lives in @platform/tools so BOTH the policy
 * engine (Execution Policy → Tool Runtime, the correct one-way dependency
 * direction) and the process executor (Tool Runtime → same layer) import
 * the ONE vocabulary. The static-architecture checks enforce the single
 * source.
 *
 * Failure mode (mirrors git-argv): an unrecognized option-looking token
 * (starts with `-`) before the effective subcommand sets `ambiguous=true`.
 * Consumers SHOULD fail-closed on ambiguity — see
 * {@link isPackageDeploymentInvocation} (the conservative helper).
 *
 * Scope (the publish-capable runners): only `npm`, `pnpm`, `yarn`, and
 * `bun` HAVE a `publish` subcommand (they push artifacts to a registry).
 * Other package-family runners (`node`, `npx`, `tsx`, `vitest`, `jest`,
 * `tsc`, `eslint`, …) are exec/test runners — they have NO publish
 * subcommand, so `publish` as a positional is just a script/argument
 * name, NOT a registry publication → never deployment-class for them.
 * This runner gate is what lets `node publish.js` / `npx publish` run
 * without a false deployment-deny, while `npm publish` / `pnpm publish` /
 * `yarn publish` / `bun publish` are correctly denied.
 */

/**
 * The package managers that can PUBLISH (have a `publish` subcommand that
 * pushes artifacts to a registry). For these runners, a publish-family
 * effective subcommand is deployment-class; an AMBIGUOUS argv (an unknown
 * option before the effective subcommand) is ALSO deployment-class
 * (fail-closed — a crafted unknown option cannot smuggle a publish past
 * the deployment rule). ONE source of truth — the policy engine + the
 * executor MUST agree (a mismatch would let policy-allow what the
 * executor rejects, or vice versa).
 *
 * Other package-family runners (node, npx, tsx, vitest, jest, tsc,
 * eslint, …) are exec/test runners — they have no `publish` subcommand,
 * so `publish` as a positional is a script/argument name, NOT a registry
 * publication → never deployment-class for them (the runner gate returns
 * false before the subcommand is even examined).
 */
export const PACKAGE_PUBLISH_CAPABLE_RUNNERS: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
]);

/**
 * The package-manager subcommands that PUBLISH / un-publish / deprecate
 * artifacts on a registry — deployment-class (the frozen WORK-037
 * contract's "package 'publish' commands"). ONE source of truth shared by
 * the policy engine (deployment-domain tagging) and the process executor
 * (governance-gate rejection). A mismatch would let policy-allow what the
 * executor rejects, or vice versa.
 *
 * Scope matches the frozen contract's "package 'publish' commands":
 *   - `publish`   — push artifacts to the registry (the architect's ex).
 *   - `unpublish` — REMOVE published artifacts from the registry (the
 *                   inverse of publish; deployment-class by symmetry).
 *   - `deprecate` — mark a published version deprecated (mutates registry
 *                   metadata; deployment-class).
 *
 * Registry-metadata commands that operate on the org / ACL surface
 * (`dist-tag`, `owner`, `access`, `team`, `profile`, `org`, …) are
 * OUT of the frozen deployment scope (they do not publish artifacts);
 * they are controlled via tool-domain / network rules if a deployment
 * posture is desired. Tightening to the publish family keeps the
 * classifier aligned with the frozen contract (amending the scope is a
 * separate, contract-level change).
 */
export const PACKAGE_DEPLOYMENT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'publish',
  'unpublish',
  'deprecate',
]);

/**
 * Package-manager LONG global options that take a VALUE (the next token,
 * OR an `=value` suffix on the same token). Skipping these correctly
 * handles BOTH `--registry=<url> publish` (one token, the `=` form) AND
 * `--registry <url> publish` (two tokens, the space form). Curated for
 * the supported publish-capable runners (npm / pnpm / yarn / bun) — the
 * common global flags that appear BEFORE the effective subcommand.
 *
 * The architect's exact example (`npm --registry=<...> publish`) is the
 * `--registry` attached-`=` form (the value is on the same token, so the
 * classifier skips a single token regardless of this set — but the set is
 * still needed for the SPACE form `npm --registry <url> publish`, where
 * the value is the NEXT token and must be consumed so it is not mistaken
 * for the effective subcommand).
 *
 * High-confidence value-takers (npm/pnpm/yarn/bun shared vocabulary):
 * registry target, install/cache paths, scope, 2FA, audit/funding
 * selectors, workspace / filter selectors, cwd, network proxies.
 */
export const PACKAGE_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--registry', // the architect's example — the registry URL target
  '--prefix', // npm install prefix
  '--cache', // npm cache path
  '--userconfig', // npm per-user config path
  '--globalconfig', // npm global config path
  '--tag', // the dist-tag to publish/install under
  '--omit', // npm omit (dev/optional/peer)
  '--include', // npm include (dev/optional/peer)
  '--scope', // npm package scope
  '--otp', // npm 2FA code
  '--auth-type', // npm auth type
  '--before', // npm date for outdated
  '--loglevel', // npm log level
  '--install-strategy', // npm install strategy
  '--audit-level', // npm audit level
  '--workspace', // npm workspace by name (singular — takes a value)
  '--filter', // pnpm/yarn/bun workspace filter pattern
  '--cwd', // yarn/pnpm/bun working directory (also a redirect analog)
  '--proxy', // npm http proxy
  '--https-proxy', // npm https proxy
  '--noproxy', // npm no-proxy host list
  '--node-linker', // pnpm node linker mode
  '--network-timeout', // pnpm/yarn network timeout
  '--access', // npm publish access (public/restricted)
]);

/**
 * Package-manager SHORT global options that take a VALUE (the NEXT
 * token — package runners have no `-C<path>` attached form). Mirrors
 * the npm/pnpm/yarn/bun shared vocabulary.
 *
 * `-C` is the yarn/pnpm/bun working-directory selector (the package
 * analog of git's `-C` — it changes the runner's working directory
 * before the subcommand runs). It is the only high-confidence
 * value-taking short shared across the publish-capable runners.
 *
 * Unknown short options before the subcommand → ambiguous (fail-closed).
 * This is conservative: `npm -w foo test` (npm `-w` workspace selector)
 * → `-w` is not in this set → ambiguous → deployment → deny. Over-
 * restrictive but SAFE (the architect's fail-closed principle); the
 * long form `--workspace foo` is recognized and non-ambiguous.
 */
export const PACKAGE_GLOBAL_VALUE_OPTIONS_SHORT: ReadonlySet<string> = new Set([
  '-C', // yarn/pnpm/bun cwd (value-taking; also a redirect analog)
]);

/**
 * Package-manager LONG boolean global options (no value; skipped as a
 * single token). Curated for the supported publish-capable runners
 * (npm / pnpm / yarn / bun) — the common global toggles that appear
 * BEFORE the effective subcommand (silence/verbosity, color, dry-run,
 * json output, offline/prefer-offline, progress, workspaces-all,
 * ignore-scripts, save flags).
 */
export const PACKAGE_GLOBAL_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  '--silent',
  '--quiet',
  '--no-color',
  '--color',
  '--dry-run',
  '--json',
  '--offline',
  '--prefer-offline',
  '--no-progress',
  '--progress',
  '--workspaces', // npm plural (boolean — ALL workspaces; cf. singular --workspace which takes a value)
  '--ignore-scripts',
  '--no-save',
  '--save-exact',
  '--verbose',
  '--no-fund',
  '--no-audit',
  '--no-update-notifier',
  '--long',
  '--version', // npm print-and-exit (the long form of -v)
  '--help', // npm print-and-exit (the long form of -h)
]);

/**
 * Package-manager SHORT boolean global options (no value; skipped as a
 * single token). The common npm global shorts. Other short options
 * before the subcommand → ambiguous (fail-closed). This is conservative
 * — combined shorts (`-qs`) and runner-specific shorts are treated as
 * ambiguous → deployment → deny (the architect's fail-closed principle).
 */
export const PACKAGE_GLOBAL_BOOLEAN_OPTIONS_SHORT: ReadonlySet<string> = new Set([
  '-q', // npm quiet
  '-s', // npm silent
  '-d', // npm --loglevel=info
  '-dd', // npm --loglevel=verbose
  '-ddd', // npm --loglevel=silly
  '-v', // npm --version (print-and-exit)
  '-h', // npm --help
]);

/** The effective package subcommand classification (the classifier's output). */
export interface PackageSubcommandClassification {
  /**
   * The effective package subcommand, or null if none was found (e.g.
   * `npm --version`, `npm --silent` with no subcommand, or `npm` alone).
   */
  readonly subcommand: string | null;
  /**
   * True if an option-looking token (starts with `-`) appeared before the
   * subcommand that the classifier did NOT recognize as a known package
   * global option. A consumer that treats ambiguity as deployment-class
   * (fail-closed) cannot be smuggled a publish past the deployment rule
   * by a crafted unknown option — see {@link isPackageDeploymentInvocation}.
   */
  readonly ambiguous: boolean;
}

/**
 * Classify the EFFECTIVE package subcommand from an explicit argv (the
 * args array AFTER the runner executable — i.e. `PackageToolRequest.args`,
 * NOT the process argv that includes argv[0]=<runner>). Skips the runner's
 * global options (value-taking long + short, boolean, `=value` forms, and
 * the `--` options terminator) to find the first positional token — the
 * effective subcommand.
 *
 * Mirrors ./git-argv.ts:classifyGitSubcommand: the global options precede
 * the subcommand; the first non-option positional token IS the subcommand.
 * `--` ends option parsing (the next token, if any, is the subcommand).
 *
 * Failure mode: an unrecognized option-looking token before the
 * subcommand sets `ambiguous=true` (the classifier cannot confidently
 * identify the subcommand). Consumers SHOULD fail-closed on ambiguity —
 * see {@link isPackageDeploymentInvocation} (the conservative helper).
 *
 * Examples (the architect's PR-#41 round-2 scenarios):
 *   ['publish']                              → { subcommand: 'publish', ambiguous: false }
 *   ['--registry=http://x', 'publish']       → { subcommand: 'publish', ambiguous: false }  (the architect's ex)
 *   ['--registry', 'http://x', 'publish']    → { subcommand: 'publish', ambiguous: false }  (space form)
 *   ['--silent', 'publish']                  → { subcommand: 'publish', ambiguous: false }
 *   ['-q', 'publish']                        → { subcommand: 'publish', ambiguous: false }
 *   ['--workspace', 'foo', 'publish']       → { subcommand: 'publish', ambiguous: false }
 *   ['--filter', 'foo', 'publish']           → { subcommand: 'publish', ambiguous: false }  (pnpm/yarn)
 *   ['-C', '/path', 'publish']               → { subcommand: 'publish', ambiguous: false }  (yarn/pnpm/bun)
 *   ['--silent', 'test']                     → { subcommand: 'test',    ambiguous: false }
 *   ['test']                                 → { subcommand: 'test',    ambiguous: false }
 *   ['--version']                            → { subcommand: null,      ambiguous: false }
 *   ['-Z', 'publish']   (unknown -Z)         → { subcommand: 'publish', ambiguous: true  }
 *   ['--future-flag', 'test']                → { subcommand: 'test',    ambiguous: true  }
 *   ['--future-flag=x', 'test']              → { subcommand: 'test',    ambiguous: true  }
 */
export function classifyPackageSubcommand(argv: readonly string[]): PackageSubcommandClassification {
  let i = 0;
  let ambiguous = false;
  const n = argv.length;
  while (i < n) {
    const tok = argv[i]!;
    // `--` ends option parsing; the next token (if any) is the subcommand.
    if (tok === '--') {
      const next = argv[i + 1];
      return { subcommand: typeof next === 'string' ? next : null, ambiguous };
    }
    // Long option with `=value` attached (single token) — value is on the
    // same token, so consume just this one (the value cannot be a
    // subcommand). The flag name is checked against the value set ONLY to
    // decide ambiguity: a recognized value option with `=` is non-ambiguous;
    // an UNKNOWN `--foo=bar` before the subcommand is ambiguous (conservative
    // — mirrors git-argv). The skip is always 1 regardless (the value is
    // attached, so it cannot masquerade as a subcommand).
    if (tok.startsWith('--') && tok.includes('=')) {
      const name = tok.slice(0, tok.indexOf('='));
      if (PACKAGE_GLOBAL_VALUE_OPTIONS.has(name)) {
        i += 1;
        continue;
      }
      // Unknown `--foo=bar` long option before the subcommand → ambiguous.
      ambiguous = true;
      i += 1;
      continue;
    }
    // Long option WITHOUT `=` (may take the NEXT token as its value).
    if (tok.startsWith('--')) {
      if (PACKAGE_GLOBAL_VALUE_OPTIONS.has(tok)) {
        i += 2; // consume the flag + its value (the value cannot be a subcommand)
        continue;
      }
      if (PACKAGE_GLOBAL_BOOLEAN_OPTIONS.has(tok)) {
        i += 1; // boolean flag — consume just this token
        continue;
      }
      // Unknown long option before the subcommand → ambiguous.
      ambiguous = true;
      i += 1;
      continue;
    }
    // Short option (starts with single `-`, not `--`; a lone `-` is a
    // positional / stdin marker, NOT an option — it would be a positional).
    if (tok.startsWith('-') && tok.length > 1) {
      if (PACKAGE_GLOBAL_VALUE_OPTIONS_SHORT.has(tok)) {
        i += 2; // consume the flag + its value (the value cannot be a subcommand)
        continue;
      }
      if (PACKAGE_GLOBAL_BOOLEAN_OPTIONS_SHORT.has(tok)) {
        i += 1; // boolean short — consume just this token
        continue;
      }
      // Unknown short option before the subcommand → ambiguous.
      ambiguous = true;
      i += 1;
      continue;
    }
    // A positional token (not option-looking) → the effective subcommand.
    return { subcommand: tok, ambiguous };
  }
  // All tokens were global options (e.g. `npm --version`, `npm --silent`
  // with no subcommand, or `npm` alone). There is no effective subcommand.
  return { subcommand: null, ambiguous };
}

/**
 * The conservative deployment classification used by BOTH the agent policy
 * engine (deployment-domain tagging in tagInvocation) AND the process
 * executor (publish-rejection governance gate in executePackage): a package
 * invocation is deployment-class IFF the runner is publish-capable
 * (npm/pnpm/yarn/bun) AND (the effective subcommand is a known
 * publish-family command OR the argv is ambiguous before the subcommand).
 * On ambiguity (an unrecognized option before the subcommand) the
 * invocation is treated as deployment-class (fail-closed) so a crafted
 * unknown option cannot smuggle a publish past the deployment rule. ONE
 * function — the two layers MUST agree (a mismatch would let policy-allow
 * what the executor rejects, or vice versa).
 *
 * The runner gate (publish-capable only) is what lets non-publish-capable
 * runners (`node`, `npx`, `tsx`, `vitest`, `jest`, `tsc`, `eslint`, …)
 * run `publish` as a script/argument name without a false deployment-deny,
 * while `npm`/`pnpm`/`yarn`/`bun` `publish` are correctly denied. For a
 * non-publish-capable runner, ambiguity is NOT deployment (the runner
 * cannot publish regardless — the publish threat does not apply).
 *
 * Semantics:
 *   - `npm publish`                                    → true  (deployment)
 *   - `npm --registry=http://x publish` (the architect's ex) → true  (deployment)
 *   - `npm --registry http://x publish` (space form)   → true  (deployment)
 *   - `npm --silent publish`                            → true  (deployment)
 *   - `npm -q publish`                                  → true  (deployment)
 *   - `npm --workspace foo publish`                     → true  (deployment)
 *   - `pnpm --filter foo publish`                       → true  (deployment)
 *   - `pnpm -C /path publish`                            → true  (deployment)
 *   - `yarn --cwd /path publish`                         → true  (deployment)
 *   - `bun publish`                                     → true  (deployment)
 *   - `npm test`                                         → false (local)
 *   - `npm --silent test`                                → false (local)
 *   - `npm --registry=http://x test`                    → false (local)
 *   - `npm --version`                                    → false (print-and-exit, no subcommand)
 *   - `node script.js`                                  → false (non-publish-capable runner)
 *   - `node --inspect publish.js`                       → false (non-publish-capable runner)
 *   - `npx publish`                                      → false (non-publish-capable runner)
 *   - `npm -Z publish`  (unknown -Z)                    → true  (ambiguous → fail-closed)
 *   - `npm --future-flag test` (unknown before LOCAL)   → true  (ambiguous → fail-closed)
 *   - `npm --future-flag=x test` (unknown `=` form)     → true  (ambiguous → fail-closed)
 */
export function isPackageDeploymentInvocation(runner: string, args: readonly string[]): boolean {
  // Only publish-capable runners (npm/pnpm/yarn/bun) have a `publish`
  // subcommand. For other package-family runners, `publish` as a
  // positional is a script/argument name, NOT a registry publication →
  // never deployment-class (the runner gate returns false before the
  // subcommand is examined; ambiguity does not apply).
  if (!PACKAGE_PUBLISH_CAPABLE_RUNNERS.has(runner)) {
    return false;
  }
  const { subcommand, ambiguous } = classifyPackageSubcommand(args);
  if (subcommand !== null && PACKAGE_DEPLOYMENT_SUBCOMMANDS.has(subcommand)) {
    return true; // the effective subcommand is a known publish-family command
  }
  // No known deployment subcommand. Fail-closed on ambiguity: an
  // unrecognized option before the subcommand means we cannot confidently
  // classify the invocation as non-deployment → treat as deployment.
  return ambiguous;
}
