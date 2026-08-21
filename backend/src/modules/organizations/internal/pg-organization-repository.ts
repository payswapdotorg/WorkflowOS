import type { DatabaseClient } from '@platform/index.js';
import type {
  Organization,
  OrganizationRepository,
  CreateOrganizationInput,
} from './organization.types.js';

/**
 * PostgreSQL-backed {@link OrganizationRepository}.
 */
export class PgOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateOrganizationInput): Promise<Organization> {
    const result = await this.db.query<OrgRow>(
      'INSERT INTO wfos_organizations (name) VALUES ($1) RETURNING id, name, created_at',
      [input.name],
    );
    return mapRow(result.rows[0]!);
  }

  async findById(id: string): Promise<Organization | null> {
    const result = await this.db.query<OrgRow>(
      'SELECT id, name, created_at FROM wfos_organizations WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }
}

interface OrgRow {
  id: string;
  name: string;
  created_at: Date;
}

function mapRow(row: OrgRow): Organization {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}
