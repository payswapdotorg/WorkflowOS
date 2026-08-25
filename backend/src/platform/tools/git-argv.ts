/**
 * WORK-037 PR-#41 FIX: the CANONICAL git argv classifier — ONE vocabulary
 * shared by BOTH the agent policy engine (deployment-domain tagging) and
 * the process tool executor (remote-network rejection). The two layers
 * previously each inspected args[0] positionally; git permits GLOBAL /
 * CONFIG options BEFORE the effective subcommand (e.g. `git -c k=v push`,
 * `git --no-pager push`, `git -C /path push`, `git --git-dir=/foo push`),
 * so a positional args[0] check could classify a REMOTE mutation as
 * ordinary `tool` activity — the policy engine would return allow /
 * constrained instead of the required deployment deny, and the executor
 * would fail to reject it at the governance gate. The sandbox's network
 * isolation is valuable defense-in-depth, but it does NOT replace the
 * policy authorization decision (a misclassified remote mutation is a
 * policy-authorized remote mutation until the sandbox happens to block
 * it; the authority must be correct on its own). This classifier finds
 * the EFFECTIVE subcommand by skipping git's global options first.
 *
 * Pure: no IO, no deps. Lives in @platform/tools so BOTH the policy
 * engine (Execution Policy → Tool Runtime, the correct one-way
 * dependency direction) and the process executor (Tool Runtime → same
 * layer) import the ONE vocabulary. There is no second copy anywhere —
 * the engine's deployment set and the executor's remote set are THIS set
 * (a mismatch would let policy-allow what the executor rejects, or vice
 * versa). The static-architecture checks enforce the single source.
 *
 * Mirrors git.c:handle_options — the global options precede the
 * subcommand; the first non-option positional token IS the effective
 * subcommand; `--` ends option parsing (the next token, if any, is the
 * subcommand). Unknown option-looking tokens before the subcommand set
 * `ambiguous=true` so consumers can fail-closed (treat as deployment-
 * class) — a crafted unknown option cannot smuggle a remote mutation
 * past the deployment rule.
 */

/**
 * Git subcommands that touch the REMOTE (network) / are deployment-class.
 * The policy engine tags these as the 'deployment' domain; the executor
 * rejects them fail-closed (the workspace holds no GitHub credentials;
 * remote repository authority stays /github). ONE source of truth — the
 * two layers MUST agree (a mismatch would let policy-allow what the
 * executor rejects, or vice versa).
 *
 * Includes the git-svn bridge (`svn`), the smart-http / git-daemon servers
 * (`daemon`, `http-backend`), and the plumbing transfer commands
 * (`fetch-pack`, `upload-pack`, `send-pack`, `receive-pack`).
 */
export const GIT_DEPLOYMENT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'push',
  'pull',
  'fetch',
  'clone',
  'remote',
  'ls-remote',
  'submodule',
  'fetch-pack',
  'upload-pack',
  'send-pack',
  'receive-pack',
  'daemon',
  'http-backend',
  'svn',
]);

/**
 * Git LONG global options that take a VALUE (the next token, OR an
 * `=value` suffix on the same token). Skipping these correctly handles
 * BOTH `--git-dir=/foo push` (one token) AND `--git-dir /foo push` (two
 * tokens). Mirrors git.c:handle_options.
 *
 * `--upload-pack` and `--receive-pack` are ALSO redirect flags (the
 * executor rejects them anywhere via GIT_REDIRECT_FLAGS) — they redirect
 * git to a custom upload/receive-pack program.
 */
export const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--upload-pack',
  '--receive-pack',
]);

/**
 * Git SHORT global options that take a VALUE (the NEXT token, always
 * space-separated — git has no `-cNAME=VALUE` attached form). Mirrors
 * git.c:handle_options.
 *
 * `-c name=value` is the architect's PR-#41 example (`git -c k=v push`).
 * `-C <path>` is also a redirect flag (the executor rejects it anywhere
 * via GIT_REDIRECT_FLAGS) — it changes git's working directory before the
 * subcommand runs.
 */
export const GIT_GLOBAL_VALUE_OPTIONS_SHORT: ReadonlySet<string> = new Set([
  '-c', // -c name=value (config override — the architect's example)
  '-C', // -C <path> (chdir before the subcommand; also a redirect flag)
]);

/**
 * Git BOOLEAN global options (no value; skipped as a single token).
 * Includes the pager toggles, the pathspec modes, the no-replace/no-locks
 * flags, and the print-and-exit helpers (`--exec-path`, `--html-path`,
 * `--man-path`, `--info-path`, `--version`). Mirrors git.c:handle_options.
 */
export const GIT_GLOBAL_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  '-p',
  '--paginate',
  '-P',
  '--no-pager',
  '--no-replace-objects',
  '--bare',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-negate-refs-in-revision-walk',
  '--exec-path',
  '--html-path',
  '--man-path',
  '--info-path',
  '--version',
]);

/**
 * Git argv tokens that REDIRECT where git operates (defeating the forced
 * workspace cwd) — rejected ANYWHERE in the argv by the executor (a
 * redirect flag as a subcommand arg still redirects, e.g.
 * `git log --git-dir=/foo`). This is the executor's governance vocabulary
 * (a curated subset of the value-taking global options + the
 * config-scope selectors `--global` / `--system`). Exported from the
 * canonical module so the executor does NOT maintain a divergent copy
 * (defense in depth — the sandbox makes redirected host paths
 * unreachable anyway, but the rejection is a POLICY reason, not a
 * sandbox happenstance).
 */
export const GIT_REDIRECT_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--upload-pack',
  '--exec-path',
  '--global',
  '--system',
]);

/** The effective git subcommand classification (the classifier's output). */
export interface GitSubcommandClassification {
  /**
   * The effective git subcommand, or null if none was found (e.g.
   * `git --version`, `git --no-pager` with no subcommand, or `git` alone).
   */
  readonly subcommand: string | null;
  /**
   * True if an option-looking token (starts with `-`) appeared before the
   * subcommand that the classifier did NOT recognize as a known git
   * global option. A consumer that treats ambiguity as deployment-class
   * (fail-closed) cannot be smuggled a remote mutation past the
   * deployment rule by a crafted unknown option — see
   * {@link isGitDeploymentInvocation}.
   */
  readonly ambiguous: boolean;
}

/**
 * Classify the EFFECTIVE git subcommand from an explicit argv (the args
 * array AFTER the `git` executable — i.e. `GitToolRequest.args`, NOT the
 * process argv that includes argv[0]='git'). Skips git's global options
 * (value-taking long + short, boolean, `=value` forms, and the `--`
 * options terminator) to find the first positional token — the effective
 * subcommand.
 *
 * Mirrors git.c:handle_options: the global options precede the
 * subcommand; the first non-option positional token IS the subcommand.
 * `--` ends option parsing (the next token, if any, is the subcommand).
 *
 * Failure mode: an unrecognized option-looking token before the
 * subcommand sets `ambiguous=true` (the classifier cannot confidently
 * identify the subcommand). Consumers SHOULD fail-closed on ambiguity —
 * see {@link isGitDeploymentInvocation} (the conservative helper).
 *
 * Examples (the architect's PR-#41 scenarios):
 *   ['push']                              → { subcommand: 'push', ambiguous: false }
 *   ['-c', 'k=v', 'push']                 → { subcommand: 'push', ambiguous: false }
 *   ['--no-pager', 'push']                → { subcommand: 'push', ambiguous: false }
 *   ['-C', '/path', 'push']               → { subcommand: 'push', ambiguous: false }
 *   ['--git-dir=/foo', 'push']            → { subcommand: 'push', ambiguous: false }
 *   ['--git-dir', '/foo', 'push']         → { subcommand: 'push', ambiguous: false }
 *   ['--no-pager', 'status']              → { subcommand: 'status', ambiguous: false }
 *   ['-c', 'k=v', 'status']               → { subcommand: 'status', ambiguous: false }
 *   ['status']                            → { subcommand: 'status', ambiguous: false }
 *   ['--version']                         → { subcommand: null,    ambiguous: false }
 *   ['-Z', 'push']   (unknown -Z)         → { subcommand: 'push', ambiguous: true  }
 *   ['--future-flag', 'status']           → { subcommand: 'status', ambiguous: true  }
 */
export function classifyGitSubcommand(argv: readonly string[]): GitSubcommandClassification {
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
    // same token, so consume just this one (the value cannot be a subcommand).
    if (tok.startsWith('--') && tok.includes('=')) {
      const name = tok.slice(0, tok.indexOf('='));
      if (GIT_GLOBAL_VALUE_OPTIONS.has(name)) {
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
      if (GIT_GLOBAL_VALUE_OPTIONS.has(tok)) {
        i += 2; // consume the flag + its value (the value cannot be a subcommand)
        continue;
      }
      if (GIT_GLOBAL_BOOLEAN_OPTIONS.has(tok)) {
        i += 1; // boolean flag — consume just this token
        continue;
      }
      // Unknown long option before the subcommand → ambiguous.
      ambiguous = true;
      i += 1;
      continue;
    }
    // Short option (starts with single `-`, not `--`; a lone `-` is a
    // pathspec / stdin marker, NOT an option — it would be a positional).
    if (tok.startsWith('-') && tok.length > 1) {
      if (GIT_GLOBAL_VALUE_OPTIONS_SHORT.has(tok)) {
        i += 2; // consume the flag + its value (the value cannot be a subcommand)
        continue;
      }
      if (GIT_GLOBAL_BOOLEAN_OPTIONS.has(tok)) {
        i += 1;
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
  // All tokens were global options (e.g. `git --version`, `git --no-pager`
  // with no subcommand, or `git` alone). There is no effective subcommand.
  return { subcommand: null, ambiguous };
}

/**
 * The conservative deployment classification used by BOTH the agent policy
 * engine (deployment-domain tagging in tagInvocation) AND the process
 * executor (remote-network rejection in executeGit): a git invocation is
 * deployment-class IFF the effective subcommand is a known remote-mutating
 * subcommand. On ambiguity (an unrecognized option before the
 * subcommand) the invocation is treated as deployment-class (fail-closed)
 * so a crafted unknown option cannot smuggle a remote mutation past the
 * deployment rule. ONE function — the two layers MUST agree (a mismatch
 * would let policy-allow what the executor rejects, or vice versa).
 *
 * Semantics:
 *   - `git push`                              → true  (deployment)
 *   - `git -c k=v push` (the architect's ex)  → true  (deployment)
 *   - `git --no-pager push`                    → true  (deployment)
 *   - `git -C /path push`                      → true  (deployment)
 *   - `git --git-dir=/foo push`                → true  (deployment)
 *   - `git --git-dir /foo push`                → true  (deployment)
 *   - `git status`                             → false (local)
 *   - `git --no-pager status`                  → false (local)
 *   - `git -c k=v status`                      → false (local)
 *   - `git --version`                          → false (print-and-exit, no subcommand)
 *   - `git -Z push`  (unknown -Z)              → true  (ambiguous → fail-closed)
 *   - `git --future-flag status`              → true  (ambiguous → fail-closed)
 */
export function isGitDeploymentInvocation(argv: readonly string[]): boolean {
  const { subcommand, ambiguous } = classifyGitSubcommand(argv);
  if (subcommand !== null && GIT_DEPLOYMENT_SUBCOMMANDS.has(subcommand)) {
    return true; // the effective subcommand is a known remote-mutating subcommand
  }
  // No known deployment subcommand. Fail-closed on ambiguity: an
  // unrecognized option before the subcommand means we cannot confidently
  // classify the invocation as non-deployment → treat as deployment.
  return ambiguous;
}
