/**
 * WORK-051 round 3 (PR #52 review, BLOCKER 1) — the production GitHub REST
 * client: the ACTUAL external authority boundary.
 *
 * The governed PR protocol (create-or-converge over the PullRequestCreationPort
 * → GitHubAdapter path) is only as real as the /github adapter behind it. This
 * module holds the live GitHub REST plumbing — GitHub App authentication
 * (RS256 JWT + installation access-token minting) and the authenticated
 * request helper — so the production {@link DefaultGitHubAdapter} can perform
 * and RECOVER the governed PR operations against the real GitHub API:
 *
 *   - POST /repos/{owner}/{repo}/pulls                    (the governed CREATE)
 *   - GET  /repos/{owner}/{repo}/pulls?head=…&state=open   (the CONVERGENCE READ)
 *   - GET  /repos/{owner}/{repo}/pulls/{number}           (external-PR resolution)
 *   - GET  /repos/{owner}/{repo}/contents/{path}?ref=…    (exact-revision snapshot reads)
 *
 * Authentication model (GitHub App):
 *   1. an RS256 JWT is signed with the GitHub App private key
 *      (iss = app id, iat = now−60s, exp = now+9min — GitHub's ±10min window);
 *   2. the JWT mints a short-lived installation access token
 *      (POST /app/installations/{id}/access_tokens, ~1h expiry);
 *   3. every repository-scoped REST call carries that installation token.
 *
 * Tokens are cached per installation until 5 minutes before expiry — the token
 * mint is itself an external side effect worth not repeating per call, and the
 * cache is a pure local-memory optimization (no shared state, no middleware).
 *
 * Failure semantics — FAIL CLOSED, never silent:
 *   - transport errors (network unreachable, timeout) THROW a typed error;
 *   - HTTP statuses are returned to the caller (the adapter maps them per the
 *     GitHubAdapter contract: 404 → null/empty per method, 422 → the provider
 *     rejection, anything else → a loud error). NOTHING in this client turns a
 *     failure into a vacuous "not found".
 *
 * Boundary: /github internal ONLY (PLAT-AC-02). This is the single place in
 * the codebase that speaks the GitHub REST protocol; no other module holds
 * credentials or SDK code.
 */

import { createSign } from 'node:crypto';

/** Typed transport-level failure (network unreachable, timeout, bad JSON). */
export class GitHubApiTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`github-api transport failure: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'GitHubApiTransportError';
  }
}

export interface GitHubRestClientConfig {
  /** The GitHub App id (`iss` claim of the authentication JWT). */
  appId: string;
  /** The GitHub App private key (PEM). Newlines may be `\n`-escaped. */
  privateKey: string;
  /** API base URL. Defaults to https://api.github.com (Enterprise-overridable). */
  apiBaseUrl: string;
}

/** A non-2xx HTTP response surface (the adapter maps it per contract). */
export class GitHubApiHttpError extends Error {
  readonly status: number;
  readonly githubMessage: string;

  constructor(message: string, status: number, githubMessage: string) {
    super(message);
    this.name = 'GitHubApiHttpError';
    this.status = status;
    this.githubMessage = githubMessage;
  }
}

export function isGitHubApiHttpError(err: unknown): err is GitHubApiHttpError {
  return err instanceof GitHubApiHttpError;
}

/** Refresh the cached installation token when < 5 minutes remain. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Normalize a PEM private key that arrived with literal `\n` escapes (the
 * standard single-line environment-variable encoding). A PEM that already
 * contains real newlines passes through unchanged.
 */
export function normalizePrivateKeyPem(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * The GitHub App authentication JWT (RS256). GitHub requires the signature
 * over the `header.payload` ASCII bytes and rejects windows outside ±10
 * minutes; the construction here (iat = now−60s, exp = now+9min) is the
 * canonical safe window.
 */
export function githubAppJwt(appId: string, privateKey: string, nowSeconds?: number): string {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64urlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64urlJson({ iat: now - 60, exp: now + 540, iss: appId });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, 'base64url');
  return `${header}.${payload}.${signature}`;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

/** The GitHub REST API client (GitHub App installation authentication). */
export class GitHubRestClient {
  private readonly tokens = new Map<string, { token: string; expiresAtMs: number }>();

  constructor(private readonly config: GitHubRestClientConfig) {}

  /** The API base URL this client speaks to (diagnostics). */
  get apiBaseUrl(): string {
    return this.config.apiBaseUrl;
  }

  /**
   * The GitHub App authentication JWT (RS256) — used directly by surfaces
   * with no installation context (the credential liveness probe GET /app).
   */
  appAuthToken(): string {
    return githubAppJwt(this.config.appId, this.config.privateKey);
  }

  /**
   * The (cached) installation access token — minted through the GitHub App
   * JWT on first use per installation, refreshed before expiry.
   */
  async installationToken(installationId: string): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return cached.token;
    }
    const body = await this.requestJson<InstallationTokenResponse>({
      method: 'POST',
      path: `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      authorization: `Bearer ${githubAppJwt(this.config.appId, this.config.privateKey)}`,
    });
    if (!body.token) {
      throw new GitHubApiTransportError(`installation ${installationId}: no token in the access-token response`);
    }
    const expiresAtMs = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 55 * 60 * 1000;
    if (Number.isNaN(expiresAtMs)) {
      throw new GitHubApiTransportError(`installation ${installationId}: unparseable token expiry '${String(body.expires_at)}'`);
    }
    this.tokens.set(installationId, { token: body.token, expiresAtMs });
    return body.token;
  }

  /**
   * An authenticated, installation-scoped GitHub REST call. Throws
   * {@link GitHubApiTransportError} on transport failure and
   * {@link GitHubApiHttpError} on any non-2xx status — callers map statuses
   * per the GitHubAdapter contract (404 → null/empty where the contract says
   * so; everything else fails closed).
   */
  async requestForInstallation<T>(opts: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    installationId: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<T> {
    const token = await this.installationToken(opts.installationId);
    return this.requestJson<T>({
      method: opts.method,
      path: opts.path,
      authorization: `Bearer ${token}`,
      body: opts.body,
      timeoutMs: opts.timeoutMs,
    });
  }

  /**
   * A raw authenticated request (the adapter's health probe uses the APP JWT
   * directly against GET /app — no installation context exists for a probe).
   */
  async requestJson<T>(opts: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    authorization: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<T> {
    const url = `${this.config.apiBaseUrl}${opts.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method,
        headers: {
          Authorization: opts.authorization,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'WorkflowOS-Backend',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      throw new GitHubApiTransportError(`${opts.method} ${opts.path}: ${(err as Error).message}`, err);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GitHubApiTransportError(`${opts.method} ${opts.path}: non-JSON response body`);
      }
    }
    if (!response.ok) {
      const record = (parsed ?? {}) as Record<string, unknown>;
      const message = typeof record.message === 'string' ? record.message : `HTTP ${response.status}`;
      throw new GitHubApiHttpError(
        `github-api ${opts.method} ${opts.path}: HTTP ${response.status} — ${message}`,
        response.status,
        message,
      );
    }
    return parsed as T;
  }
}
