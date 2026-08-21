import type { DatabaseClient } from '@platform/index.js';
import type {
  User,
  UserRepository,
  CreateUserInput,
} from './user.types.js';

/**
 * PostgreSQL-backed {@link UserRepository}. Owned by /users; constructed by
 * the composition root and injected where needed.
 *
 * PostgreSQL is the authoritative store for user identity (architecture §28,
 * AUTH-001). Redis is NOT used for authoritative user state (DATA2-AC-02).
 */
export class PgUserRepository implements UserRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findByExternalId(externalId: string): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      'SELECT id, external_id, display_name, email, created_at FROM wfos_users WHERE external_id = $1',
      [externalId],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async findById(id: string): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      'SELECT id, external_id, display_name, email, created_at FROM wfos_users WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async upsertByExternalId(input: CreateUserInput): Promise<User> {
    // ON CONFLICT (external_id) DO UPDATE keeps this deterministic: the same
    // externalId always resolves to the same row (AUTH-AC-01). We update the
    // mutable fields (display_name, email) so an identity refresh propagates.
    const result = await this.db.query<UserRow>(
      `INSERT INTO wfos_users (external_id, display_name, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (external_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             email = EXCLUDED.email
       RETURNING id, external_id, display_name, email, created_at`,
      [input.externalId, input.displayName, input.email ?? null],
    );
    return mapRow(result.rows[0]!);
  }
}

interface UserRow {
  id: string;
  external_id: string;
  display_name: string;
  email: string | null;
  created_at: Date;
}

function mapRow(row: UserRow): User {
  return {
    id: row.id,
    externalId: row.external_id,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at,
  };
}
