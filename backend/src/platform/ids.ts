import { randomUUID } from 'node:crypto';

/**
 * Generate a traceable execution identifier.
 *
 * Execution IDs are short, opaque, URL-safe identifiers that follow an
 * WorkflowOS execution through API → queue → worker → logs. They are NOT
 * UUIDs because they are also intended to be human-skimmable in logs.
 *
 * Format: `wf_<8hex>` — fixed prefix `wf_` (WorkflowOS) followed by 8 hex chars
 * derived from a UUIDv4. Collisions within a single runtime are negligible.
 */
export function generateExecutionId(): string {
  const uuid = randomUUID().replace(/-/g, '');
  return `wf_${uuid.slice(0, 8)}`;
}
