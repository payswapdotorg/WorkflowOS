/**
 * WORK-074 — OAuth provider adapters (WORK-063: "OAuth/OIDC providers —
 * Google and GitHub first; provider adapters behind the existing
 * provider-independent AuthProvider boundary (a new provider is a new
 * adapter, never a new authority)").
 *
 * The adapters are CONFIDENTIAL clients: the authorization-code exchange
 * happens in server-side code only (client credentials never reach the
 * browser). The produced {@link OAuthProviderAssertion} is the provider's
 * authentication assertion — authoritative ONLY for WHO authenticated
 * (WORK-063 invariant #14: external providers are never WorkflowOS
 * authorization authorities). Identity resolution + session creation happen
 * in /auth's identity runtime.
 *
 * Assertion retrieval: the adapter calls the provider's userinfo endpoint
 * over TLS using the access token obtained directly from the provider's token
 * endpoint (server-to-server). Google: OpenID Connect `userinfo` (the `sub`
 * claim is the stable subject). GitHub: the authenticated user + the
 * primary VERIFIED email (GitHub user ids are the stable subject).
 *
 * CSRF: the /auth routes mint a single-use server-side state (OAuthStateStore)
 * before redirecting the browser and validate+consume it on the callback.
 *
 * No new dependencies: exchanges use the platform-global `fetch`.
 */

export interface OAuthProviderAssertion {
  readonly provider: string;
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string;
}

export interface OAuthProviderAdapter {
  /** The provider identifier ('google' | 'github' ship; a new provider is a new adapter). */
  readonly id: string;
  /** Whether the provider's client credentials are configured in this environment. */
  isConfigured(): boolean;
  /** Build the provider's authorization redirect URL (the state is minted by the /auth route). */
  authorizationUrl(input: { state: string; redirectUri: string }): string;
  /** Exchange an authorization code for the provider identity assertion (server-side only). */
  exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<OAuthProviderAssertion>;
}

// ---------------------------------------------------------------------------
// Google (OpenID Connect)
// ---------------------------------------------------------------------------

export interface GoogleOAuthConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** Optional endpoint overrides (tests inject fakes this way). */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
}

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export class GoogleOAuthProviderAdapter implements OAuthProviderAdapter {
  readonly id = 'google' as const;

  constructor(private readonly config: GoogleOAuthConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    const base = this.config.authorizationEndpoint ?? GOOGLE_AUTHORIZATION_ENDPOINT;
    const params = new URLSearchParams({
      client_id: this.config.clientId ?? '',
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: input.state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `${base}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<OAuthProviderAssertion> {
    const tokenEndpoint = this.config.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
    const userinfoEndpoint = this.config.userinfoEndpoint ?? GOOGLE_USERINFO_ENDPOINT;
    const tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code: input.code,
        client_id: this.config.clientId ?? '',
        client_secret: this.config.clientSecret ?? '',
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error(`google token exchange failed (${tokenRes.status})`);
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) throw new Error('google token exchange returned no access token');

    const userinfoRes = await fetch(userinfoEndpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userinfoRes.ok) throw new Error(`google userinfo failed (${userinfoRes.status})`);
    const info = (await userinfoRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    if (!info.sub) throw new Error('google userinfo returned no subject');
    return {
      provider: this.id,
      subject: info.sub,
      email: info.email ?? null,
      emailVerified: info.email_verified === true,
      displayName: info.name ?? info.email ?? 'Google user',
    };
  }
}

// ---------------------------------------------------------------------------
// GitHub (OAuth app)
// ---------------------------------------------------------------------------

export interface GitHubOAuthConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userEndpoint?: string;
  emailsEndpoint?: string;
}

export const GITHUB_AUTHORIZATION_ENDPOINT = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_ENDPOINT = 'https://api.github.com/user';
export const GITHUB_EMAILS_ENDPOINT = 'https://api.github.com/user/emails';

export class GitHubOAuthProviderAdapter implements OAuthProviderAdapter {
  readonly id = 'github' as const;

  constructor(private readonly config: GitHubOAuthConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    const base = this.config.authorizationEndpoint ?? GITHUB_AUTHORIZATION_ENDPOINT;
    const params = new URLSearchParams({
      client_id: this.config.clientId ?? '',
      redirect_uri: input.redirectUri,
      state: input.state,
      scope: 'read:user user:email',
    });
    return `${base}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<OAuthProviderAssertion> {
    const tokenEndpoint = this.config.tokenEndpoint ?? GITHUB_TOKEN_ENDPOINT;
    const tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        code: input.code,
        client_id: this.config.clientId ?? '',
        client_secret: this.config.clientSecret ?? '',
        redirect_uri: input.redirectUri,
      }),
    });
    if (!tokenRes.ok) throw new Error(`github token exchange failed (${tokenRes.status})`);
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) throw new Error('github token exchange returned no access token');
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workflowos-identity',
    };

    const userRes = await fetch(this.config.userEndpoint ?? GITHUB_USER_ENDPOINT, { headers });
    if (!userRes.ok) throw new Error(`github user fetch failed (${userRes.status})`);
    const user = (await userRes.json()) as { id?: number; login?: string; name?: string };
    if (!user.id) throw new Error('github user fetch returned no id');

    // The primary VERIFIED email is the linking email. GitHub may expose no
    // public email; without a verified email the identity never links by email.
    let email: string | null = null;
    let emailVerified = false;
    try {
      const emailsRes = await fetch(this.config.emailsEndpoint ?? GITHUB_EMAILS_ENDPOINT, { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
        if (primary) {
          email = primary.email;
          emailVerified = primary.verified;
        }
      }
    } catch {
      // No emails access — proceed without a linking email (fail closed on linking).
    }

    return {
      provider: this.id,
      subject: String(user.id),
      email,
      emailVerified,
      displayName: user.name ?? user.login ?? `github:${user.id}`,
    };
  }
}
