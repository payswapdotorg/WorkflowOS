import type { DatabaseClient } from '@platform/index.js';
import type {
  LinkedIdentity,
  LinkedIdentityRepository,
  CreateLinkedIdentityInput,
} from './user.types.js';

/**
 * PostgreSQL-backed {@link LinkedIdentityRepository} (WORK-074).
 *
 * Owned by /users (the users + linked-identities authority). Maps external
 * provider subjects to WorkflowOS users — the persistence behind deterministic
 * identity resolution (AUTH-AC-01 generalized to OIDC subjects) and identity
 * linking (WORK-063). Constructed by the composition root and injected into
 * /auth's identity resolution service.
 */
export class PgLinkedIdentityRepository implements LinkedIdentityRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findByProviderSubject(provider: string, subject: string): Promise<LinkedIdentity | null> {
    const result = await this.db.query<LinkedIdentityRow>(
      `SELECT id, user_id, provider, subject, email, display_name, email_verified, created_at
       FROM wfos_linked_identities WHERE provider = $1 AND subject = $2`,
      [provider, subject],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async listForUser(userId: string): Promise<LinkedIdentity[]> {
    const result = await this.db.query<LinkedIdentityRow>(
      `SELECT id, user_id, provider, subject, email, display_name, email_verified, created_at
       FROM wfos_linked_identities WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    return result.rows.map(mapRow);
  }

  async hasVerifiedIdentity(userId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM wfos_linked_identities WHERE user_id = $1 AND email_verified = TRUE
       ) AS exists`,
      [userId],
    );
    return result.rows[0]?.exists === true;
  }

  async link(input: CreateLinkedIdentityInput): Promise<LinkedIdentity> {
    // Idempotent on (provider, subject): re-linking the same subject returns
    // the existing row so resolution stays deterministic.
    const result = await this.db.query<LinkedIdentityRow>(
      `INSERT INTO wfos_linked_identities (user_id, provider, subject, email, display_name, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, subject) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             email = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             email_verified = EXCLUDED.email_verified
       RETURNING id, user_id, provider, subject, email, display_name, email_verified, created_at`,
      [
        input.userId,
        input.provider,
        input.subject,
        input.email ?? null,
        input.displayName ?? null,
        input.emailVerified ?? false,
      ],
    );
    return mapRow(result.rows[0]!);
  }
}

interface LinkedIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  subject: string;
  email: string | null;
  display_name: string | null;
  email_verified: boolean;
  created_at: Date;
}

function mapRow(row: LinkedIdentityRow): LinkedIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    emailVerified: row.email_verified,
    createdAt: row.created_at,
  };
}
