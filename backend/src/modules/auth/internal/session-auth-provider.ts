import type {
  AuthProvider,
  AuthenticatedPrincipal,
  AuthenticationResult,
} from './auth.types.js';
import type { SessionService } from './session-service.js';
import type { UserRepository } from '@modules/users/index.js';

/**
 * WORK-074 — the session-backed {@link AuthProvider} (the server-side session
 * verification behind the SAME provider-independent boundary as the API-key
 * provider).
 *
 * The presented credential is the opaque session token carried in the HttpOnly
 * `wfos_session` cookie. The token is verified server-side against
 * PostgreSQL (wfos_sessions — WORK-063 invariant #14); the resulting principal
 * carries the session CONTEXT (ids only — never token material) so the request
 * pipeline can resolve the persisted user WITHOUT any client-supplied
 * identity claim.
 *
 * This provider does NOT decide authorization — the AuthorizationService does
 * (AUTHZ-AC-01..03 unchanged).
 */
export class SessionAuthProvider implements AuthProvider {
  readonly name = 'session';

  constructor(
    private readonly sessions: SessionService,
    private readonly users: UserRepository,
  ) {}

  async authenticate(rawCredential: string): Promise<AuthenticationResult> {
    if (!rawCredential || rawCredential.length === 0) {
      return { kind: 'unauthenticated', reason: 'missing-credentials' };
    }
    const verified = await this.sessions.verify(rawCredential);
    if (verified.status !== 'valid') {
      return { kind: 'unauthenticated', reason: 'invalid-credentials' };
    }
    // The user must still exist (sessions are revocable server-side; a deleted
    // user's session grants nothing).
    const user = await this.users.findById(verified.userId);
    if (!user) {
      return { kind: 'unauthenticated', reason: 'invalid-credentials' };
    }
    const principal: AuthenticatedPrincipal = {
      externalId: `session:${verified.session.id}`,
      label: user.displayName,
      provider: this.name,
      session: {
        sessionId: verified.session.id,
        userId: verified.session.userId,
        expiresAt: verified.session.expiresAt,
      },
    };
    return { kind: 'principal', principal };
  }
}
