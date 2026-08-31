import type { User, UserRepository, LinkedIdentityRepository } from '@modules/users/index.js';

/**
 * WORK-074 — deterministic identity resolution + identity linking (WORK-063:
 * "Deterministic identity resolution: the same provider subject always
 * resolves to the same WorkflowOS user (AUTH-AC-01 generalized from the
 * API-key precedent to OIDC subjects)" and "Identity linking: multiple
 * provider identities may link to one user; a linked re-login resolves to the
 * SAME user").
 *
 * Resolution algorithm (server-side; PostgreSQL authoritative — invariant
 * #14):
 *
 *   1. (provider, subject) already linked → that user. Deterministic
 *      re-login: the same provider subject ALWAYS resolves to the same user.
 *   2. Otherwise, the assertion carries a PROVIDER-VERIFIED email AND an
 *      existing user's email matches AND that user ALREADY holds at least one
 *      provider-verified identity → LINK: the new subject is bound to that
 *      user (one human, multiple provider identities).
 *   3. Otherwise → a NEW user is created (externalId `<provider>:<subject>`)
 *      and the subject is linked to it.
 *
 * Fail-closed email-linking rules (typed rejections — no takeover paths):
 *   - `email-conflict`: a verified assertion matches a user whose email was
 *     never provider-verified (e.g. a password account). Auto-linking would
 *     hand the provider identity a session on an unverified-email account —
 *     rejected. The user keeps their original login method.
 *   - `machine-subject-forbidden`: subjects in the machine namespace
 *     (`service-account:*`) never resolve to human users (invariant #3 —
 *     a machine principal is never a human user).
 */

export interface ProviderIdentityAssertion {
  readonly provider: string;
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string;
}

export interface IdentityResolution {
  readonly user: User;
  /** True when this call created the WorkflowOS user. */
  readonly created: boolean;
  /** True when this call linked the subject to an EXISTING user (email match). */
  readonly linked: boolean;
}

export type IdentityResolutionError = Error & {
  code: 'email-conflict' | 'machine-subject-forbidden';
};

export interface IdentityResolutionService {
  resolve(assertion: ProviderIdentityAssertion): Promise<IdentityResolution>;
}

export class DefaultIdentityResolutionService implements IdentityResolutionService {
  constructor(
    private readonly users: UserRepository,
    private readonly linkedIdentities: LinkedIdentityRepository,
  ) {}

  async resolve(assertion: ProviderIdentityAssertion): Promise<IdentityResolution> {
    const subject = assertion.subject;
    if (subject.startsWith('service-account:')) {
      throw identityError(
        'machine-subject-forbidden',
        'machine principals never resolve to human users',
      );
    }

    // 1. Deterministic re-login: the exact (provider, subject) pair.
    const existing = await this.linkedIdentities.findByProviderSubject(assertion.provider, subject);
    if (existing) {
      const user = await this.users.findById(existing.userId);
      if (user) {
        // Refresh the display name if the provider sent a better one.
        return { user, created: false, linked: false };
      }
      // Fall through if the user row vanished (should not happen; FK enforced).
    }

    // 2. Identity linking by PROVIDER-VERIFIED email, only to an account that
    //    already holds a verified identity (fail-closed — never a takeover
    //    path for unverified-email accounts).
    const email = assertion.email?.trim().toLowerCase() || null;
    if (email && assertion.emailVerified) {
      const candidate = await this.users.findByEmail(email);
      if (candidate) {
        const candidateVerified = await this.linkedIdentities.hasVerifiedIdentity(candidate.id);
        if (!candidateVerified) {
          throw identityError(
            'email-conflict',
            'this email already belongs to an account that signs in with another method',
          );
        }
        await this.linkedIdentities.link({
          userId: candidate.id,
          provider: assertion.provider,
          subject,
          email,
          displayName: assertion.displayName,
          emailVerified: true,
        });
        return { user: candidate, created: false, linked: true };
      }
    }

    // 3. New user (deterministic externalId = `<provider>:<subject>`).
    const user = await this.users.upsertByExternalId({
      externalId: `${assertion.provider}:${subject}`,
      displayName: assertion.displayName || email || subject,
      email,
    });
    await this.linkedIdentities.link({
      userId: user.id,
      provider: assertion.provider,
      subject,
      email,
      displayName: assertion.displayName,
      emailVerified: assertion.emailVerified,
    });
    return { user, created: true, linked: false };
  }
}

function identityError(code: IdentityResolutionError['code'], message: string): IdentityResolutionError {
  const err = new Error(message) as IdentityResolutionError;
  err.code = code;
  return err;
}
