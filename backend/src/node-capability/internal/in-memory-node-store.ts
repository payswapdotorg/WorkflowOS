import { deriveNodeKeyFingerprint } from './node-auth.js';
import type { NodeKeyStore, NodeRecord, NodeRecordStore, NodeSessionRecord } from '../types.js';

/**
 * V2-004 — default in-memory ports.
 *
 * The work order demands an in-memory registry with ports/adapters (durable
 * node persistence is NOT demanded; runs/events belong to V2-005/V2-009).
 * Everything is deterministic: records list in nodeId order, no wall clock,
 * no randomness.
 */

/** In-memory out-of-band node key provisioning. */
export class InMemoryNodeKeyStore implements NodeKeyStore {
  private readonly secrets = new Map<string, Uint8Array>();

  enroll(nodeKeySecret: Uint8Array): { nodeKeyFingerprint: string } {
    const nodeKeyFingerprint = deriveNodeKeyFingerprint(nodeKeySecret);
    this.secrets.set(nodeKeyFingerprint, nodeKeySecret);
    return { nodeKeyFingerprint };
  }

  getSecret(nodeKeyFingerprint: string): Uint8Array | null {
    return this.secrets.get(nodeKeyFingerprint) ?? null;
  }
}

/** In-memory node record + session store. */
export class InMemoryNodeRecordStore implements NodeRecordStore {
  private readonly records = new Map<string, NodeRecord>();
  private readonly sessions = new Map<string, NodeSessionRecord>();

  saveRecord(record: NodeRecord): void {
    this.records.set(record.nodeId, record);
  }

  getRecord(nodeId: string): NodeRecord | null {
    return this.records.get(nodeId) ?? null;
  }

  listRecords(): readonly NodeRecord[] {
    return [...this.records.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  }

  saveSession(nodeId: string, session: NodeSessionRecord): void {
    this.sessions.set(nodeId, session);
  }

  getSession(nodeId: string): NodeSessionRecord | null {
    return this.sessions.get(nodeId) ?? null;
  }
}

/**
 * Deterministic sequential nonce source (default). Injectable by hosts that
 * prefer an unpredictable challenge source — the port accepts any
 * `() => string`.
 */
export function makeSequentialNonceSource(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return counter.toString(16).padStart(16, '0');
  };
}
