import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@platform/index.js';
import type { SecretStore } from '@platform/secrets/secret-store.js';
import type { AuditEventWriter } from '@modules/audit/index.js';

/**
 * WORK-074 — scoped machine identity (WORK-063 machine identity): service
 * accounts are FIRST-CLASS PRINCIPALS (NOT users) that belong to an
 * organization and hold an explicit capability set; API credentials for them
 * are SCOPED and fail closed.
 *
 * Discipline:
 *   - A service account NEVER gets a wfos_users row (invariant #3 — a machine
 *     principal is never a human user). Its credentials live in the EXTENDED
 *     wfos_api_key_credentials table (scopes + service_account_id — invariant
 *     #10: API keys extended, never removed).
 *   - Capability vocabulary is a CLOSED set (below). Capabilities that would
 *     breach privilege separation — modifying architecture, approving own PR,
 *     altering verification evidence, changing tenant — are deliberately NOT
 *     in the set and can never be granted (typed `unknown-capability`).
 *   - The capability → permission mapping lives in the AuthorizationService
 *     (the ONE chain) — this service only validates/records the scopes.
 *   - Raw key material: returned to the caller EXACTLY once at issuance; the
 *     database stores ONLY the digest + an opaque SecretStore reference
 *     (SEC-AC-01/02). Revocation sets revoked_at — a revoked key fails closed.
 *   - Issuance/revocation are audit-covered (invariant #12).
 */

/**
 * The closed grantable capability set (WORK-063's example agent set). Every
 * capability maps to permissions INSIDE the AuthorizationService. Anything
 * outside this set is ungrantable — governance surfaces stay behind
 * human-owned permissions (invariant #7).
 */
export const GRANTABLE_CAPABILITIES: readonly string[] = [
  'project.read', // read project surfaces
  'project.write', // write project surfaces
  'work-orders.read', // read Work Orders
  'execution.read', // read execution state
  'branches.create', // create branches
  'prs.create', // create PRs
] as const;

/** Capabilities that are deliberately UNGRANTABLE (privilege separation). */
export const UNGRANTABLE_CAPABILITIES: readonly string[] = [
  'architecture.modify',
  'review.approve',
  'verification.evidence.write',
  'tenant.change',
  'org.admin',
  'org.members',
] as const;

export interface ServiceAccount {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly createdAt: Date;
}

export interface ServiceAccountKeyView {
  readonly keyId: string;
  readonly label: string;
  readonly scopes: readonly string[] | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface IssuedKeyMaterial {
  readonly keyId: string;
  /** The raw key — shown to the operator EXACTLY once. Never persisted raw. */
  readonly rawKey: string;
  readonly scopes: readonly string[];
}

export type MachineIdentityError = Error & {
  code:
    | 'unknown-capability'
    | 'scope-not-in-account-capabilities'
    | 'not-found'
    | 'secret-store-not-writable';
};

export interface CreateServiceAccountInput {
  readonly organizationId: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly actor: string;
}

export interface IssueKeyInput {
  readonly serviceAccountId: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly actor: string;
}

export interface MachineIdentityService {
  createServiceAccount(input: CreateServiceAccountInput): Promise<ServiceAccount>;
  getServiceAccount(id: string): Promise<ServiceAccount | null>;
  listForOrganization(organizationId: string): Promise<ServiceAccount[]>;
  issueKey(input: IssueKeyInput): Promise<IssuedKeyMaterial>;
  listKeys(serviceAccountId: string): Promise<ServiceAccountKeyView[]>;
  revokeKey(input: { keyId: string; actor: string }): Promise<void>;
}

export class DefaultMachineIdentityService implements MachineIdentityService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly secrets: SecretStore,
    private readonly audit?: AuditEventWriter,
  ) {}

  async createServiceAccount(input: CreateServiceAccountInput): Promise<ServiceAccount> {
    validateCapabilities(input.capabilities);
    const result = await this.db.query<ServiceAccountRow>(
      `INSERT INTO wfos_service_accounts (organization_id, name, capabilities)
       VALUES ($1, $2, $3)
       RETURNING id, organization_id, name, capabilities, created_at`,
      [input.organizationId, input.name, [...input.capabilities]],
    );
    const account = mapAccount(result.rows[0]!);
    await this.audit?.write({
      eventType: 'identity.service_account.created',
      actor: input.actor,
      source: 'auth',
      resourceType: 'service_account',
      resourceId: account.id,
      organizationId: account.organizationId,
      metadata: { name: account.name, capabilities: [...account.capabilities] },
    });
    return account;
  }

  async getServiceAccount(id: string): Promise<ServiceAccount | null> {
    const result = await this.db.query<ServiceAccountRow>(
      'SELECT id, organization_id, name, capabilities, created_at FROM wfos_service_accounts WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapAccount(result.rows[0]!);
  }

  async listForOrganization(organizationId: string): Promise<ServiceAccount[]> {
    const result = await this.db.query<ServiceAccountRow>(
      'SELECT id, organization_id, name, capabilities, created_at FROM wfos_service_accounts WHERE organization_id = $1 ORDER BY created_at ASC',
      [organizationId],
    );
    return result.rows.map(mapAccount);
  }

  async issueKey(input: IssueKeyInput): Promise<IssuedKeyMaterial> {
    const account = await this.getServiceAccount(input.serviceAccountId);
    if (!account) throw machineIdentityError('not-found', 'service account not found');
    validateCapabilities(input.scopes);
    for (const scope of input.scopes) {
      if (!account.capabilities.includes(scope)) {
        throw machineIdentityError(
          'scope-not-in-account-capabilities',
          `scope ${scope} is not in the service account capability set`,
        );
      }
    }

    const keyId = `sk_${randomBytes(8).toString('hex')}`;
    const rawKey = `wfos_sk_${randomBytes(32).toString('base64url')}`;
    const digest = sha256Hex(rawKey);
    const secretRef = `wfos_apikey_${keyId}`;

    // Raw value goes ONLY behind the SecretStore boundary (SEC-AC-01). A store
    // without runtime-write capability cannot issue keys (fail closed) — the
    // digest alone would fail the provider's secret double-check.
    const put = this.secrets.putSecret?.bind(this.secrets);
    if (typeof put !== 'function') {
      throw machineIdentityError(
        'secret-store-not-writable',
        'the configured SecretStore does not support runtime writes; scoped key issuance is unavailable',
      );
    }
    await put({ key: secretRef }, rawKey);

    await this.db.query(
      `INSERT INTO wfos_api_key_credentials (key_id, secret_ref, external_id, label, key_digest, scopes, service_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        keyId,
        secretRef,
        // Machine namespace external id — NEVER a wfos_users external id.
        `service-account:${account.id}`,
        input.label,
        digest,
        [...input.scopes],
        account.id,
      ],
    );

    await this.audit?.write({
      eventType: 'identity.api_key.issued',
      actor: input.actor,
      source: 'auth',
      resourceType: 'service_account_api_key',
      resourceId: keyId,
      organizationId: account.organizationId,
      metadata: {
        serviceAccountId: account.id,
        scopes: [...input.scopes],
        // NOTE: the raw key and its digest are deliberately NOT in metadata.
      },
    });

    return { keyId, rawKey, scopes: [...input.scopes] };
  }

  async listKeys(serviceAccountId: string): Promise<ServiceAccountKeyView[]> {
    const result = await this.db.query<KeyRow>(
      `SELECT key_id, label, scopes, revoked_at, created_at
       FROM wfos_api_key_credentials WHERE service_account_id = $1 ORDER BY created_at ASC`,
      [serviceAccountId],
    );
    return result.rows.map((row) => ({
      keyId: row.key_id,
      label: row.label,
      scopes: row.scopes,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    }));
  }

  async revokeKey(input: { keyId: string; actor: string }): Promise<void> {
    const result = await this.db.query<{ service_account_id: string | null }>(
      `UPDATE wfos_api_key_credentials SET revoked_at = NOW()
       WHERE key_id = $1 AND revoked_at IS NULL
       RETURNING service_account_id`,
      [input.keyId],
    );
    if (result.rows.length === 0) return; // idempotent
    const serviceAccountId = result.rows[0]!.service_account_id;
    const account = serviceAccountId ? await this.getServiceAccount(serviceAccountId) : null;
    await this.audit?.write({
      eventType: 'identity.api_key.revoked',
      actor: input.actor,
      source: 'auth',
      resourceType: 'service_account_api_key',
      resourceId: input.keyId,
      organizationId: account?.organizationId ?? null,
      metadata: { serviceAccountId: serviceAccountId },
    });
  }
}

interface ServiceAccountRow {
  id: string;
  organization_id: string;
  name: string;
  capabilities: string[];
  created_at: Date;
}

interface KeyRow {
  key_id: string;
  label: string;
  scopes: string[] | null;
  revoked_at: Date | null;
  created_at: Date;
}

function mapAccount(row: ServiceAccountRow): ServiceAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    capabilities: row.capabilities,
    createdAt: row.created_at,
  };
}

function validateCapabilities(capabilities: readonly string[]): void {
  for (const capability of capabilities) {
    if (!GRANTABLE_CAPABILITIES.includes(capability)) {
      throw machineIdentityError(
        'unknown-capability',
        `capability ${capability} is not in the closed grantable set`,
      );
    }
  }
}

function machineIdentityError(code: MachineIdentityError['code'], message: string): MachineIdentityError {
  const err = new Error(message) as MachineIdentityError;
  err.code = code;
  return err;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
