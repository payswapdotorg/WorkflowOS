/**
 * WORK-025: PgArchitectSessionRepository — persistence for Architect sessions.
 *
 * Owned by /llm. The route consumes this repository through the
 * ArchitectSessionRepository interface — it never queries
 * wfos_architect_sessions directly.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  ArchitectSession,
  ArchitectSessionRepository,
  ArchitectMessage,
  ArchitectRevision,
  ArchitectParsedPlan,
} from './conversational-architect.types.js';

interface SessionRow {
  id: string;
  project_id: string;
  status: string;
  provider: string;
  model: string;
  messages: ArchitectMessage[];
  revision_count: number;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  session_id: string;
  revision_number: number;
  user_prompt: string;
  architect_response: string;
  parsed_plan: ArchitectParsedPlan | null;
  created_at: string;
}

function mapSession(row: SessionRow): ArchitectSession {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as ArchitectSession['status'],
    provider: row.provider,
    model: row.model,
    messages: row.messages ?? [],
    revisionCount: row.revision_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgArchitectSessionRepository implements ArchitectSessionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findActiveByProject(projectId: string): Promise<ArchitectSession | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT id, project_id, status, provider, model, messages, revision_count, created_at, updated_at
       FROM wfos_architect_sessions
       WHERE project_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    if (result.rows.length === 0) return null;
    return mapSession(result.rows[0]!);
  }

  async create(input: {
    projectId: string;
    provider: string;
    model: string;
  }): Promise<ArchitectSession> {
    const result = await this.db.query<SessionRow>(
      `INSERT INTO wfos_architect_sessions (project_id, provider, model)
       VALUES ($1, $2, $3)
       RETURNING id, project_id, status, provider, model, messages, revision_count, created_at, updated_at`,
      [input.projectId, input.provider, input.model],
    );
    return mapSession(result.rows[0]!);
  }

  async updateMessages(
    sessionId: string,
    messages: ArchitectMessage[],
    parsedPlan: ArchitectParsedPlan | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE wfos_architect_sessions
       SET messages = $1, parsed_plan = $2, updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(messages), parsedPlan ? JSON.stringify(parsedPlan) : null, sessionId],
    );
  }

  async saveRevision(input: {
    sessionId: string;
    revisionNumber: number;
    userPrompt: string;
    architectResponse: string;
    parsedPlan: ArchitectParsedPlan | null;
  }): Promise<ArchitectRevision> {
    const result = await this.db.query<RevisionRow>(
      `INSERT INTO wfos_architect_revisions
         (session_id, revision_number, user_prompt, architect_response, parsed_plan)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, session_id, revision_number, user_prompt, architect_response, parsed_plan, created_at`,
      [
        input.sessionId,
        input.revisionNumber,
        input.userPrompt,
        input.architectResponse,
        input.parsedPlan ? JSON.stringify(input.parsedPlan) : null,
      ],
    );
    const row = result.rows[0]!;
    return {
      id: row.id,
      sessionId: row.session_id,
      revisionNumber: row.revision_number,
      userPrompt: row.user_prompt,
      architectResponse: row.architect_response,
      parsedPlan: row.parsed_plan,
      createdAt: row.created_at,
    };
  }

  async listRevisions(sessionId: string): Promise<ArchitectRevision[]> {
    const result = await this.db.query<RevisionRow>(
      `SELECT id, session_id, revision_number, user_prompt, architect_response, parsed_plan, created_at
       FROM wfos_architect_revisions
       WHERE session_id = $1
       ORDER BY revision_number ASC`,
      [sessionId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      revisionNumber: row.revision_number,
      userPrompt: row.user_prompt,
      architectResponse: row.architect_response,
      parsedPlan: row.parsed_plan,
      createdAt: row.created_at,
    }));
  }

  async markAccepted(sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE wfos_architect_sessions SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
      [sessionId],
    );
  }
}
