import type { DatabaseClient } from '@platform/index.js';
import { PgUserRepository } from '../../src/modules/users/internal/pg-user-repository.js';
import { PgLinkedIdentityRepository } from '../../src/modules/users/internal/pg-linked-identity-repository.js';
import { DefaultSessionService } from '../../src/modules/auth/internal/session-service.js';
import { DefaultPasswordCredentialService } from '../../src/modules/auth/internal/password-credential-service.js';
import { DefaultIdentityResolutionService } from '../../src/modules/auth/internal/identity-resolution-service.js';
import { DefaultMachineIdentityService } from '../../src/modules/auth/internal/machine-identity-service.js';
import { PgOAuthStateStore } from '../../src/modules/auth/internal/oauth-state-store.js';
import { SessionAuthProvider } from '../../src/modules/auth/internal/session-auth-provider.js';
import { DefaultAuditService } from '../../src/modules/audit/internal/audit-service.js';
import { buildAuthStack, type TestAuthStack } from './test-auth-stack.js';
import type { OAuthProviderAdapter } from '../../src/modules/auth/internal/oauth-provider.js';

/**
 * WORK-074 identity runtime test harness: the WORK-002 auth stack PLUS the
 * identity/session/machine-identity runtime (sessions, password provider,
 * identity resolution, OAuth state store, machine identity, audit) on real
 * PostgreSQL. OAuth provider adapters are injectable (fakes for tests; the
 * real Google/GitHub adapters are constructed by the composition root).
 */
export interface TestIdentityStack extends Omit<TestAuthStack, 'userRepository' | 'teardown'> {
  userRepository: PgUserRepository;
  linkedIdentityRepository: PgLinkedIdentityRepository;
  sessionService: DefaultSessionService;
  passwordCredentials: DefaultPasswordCredentialService;
  identityResolution: DefaultIdentityResolutionService;
  machineIdentity: DefaultMachineIdentityService;
  oauthStateStore: PgOAuthStateStore;
  sessionAuthProvider: SessionAuthProvider;
  auditService: DefaultAuditService;
  /** Registered OAuth provider adapters (default: none — register fakes in tests). */
  oauthProviders: OAuthProviderAdapterHolder;
  /** Small shared fixture store for suite-level ids. */
  ctx: Record<string, string>;
  setKey(name: string, rawKey: string): void;
  getKey(name: string): string | undefined;
  teardown: () => Promise<void>;
}

export interface OAuthProviderAdapterHolder {
  readonly adapters: OAuthProviderAdapter[];
  register(adapter: OAuthProviderAdapter): void;
}

export async function buildIdentityStack(): Promise<TestIdentityStack> {
  const base: TestAuthStack = await buildAuthStack();
  const db: DatabaseClient = base.db.client;

  const linkedIdentityRepository = new PgLinkedIdentityRepository(db);
  const auditService = new DefaultAuditService(db, base.db.logger);
  const sessionService = new DefaultSessionService(db, auditService);
  const passwordCredentials = new DefaultPasswordCredentialService(
    db,
    base.userRepository,
    linkedIdentityRepository,
  );
  const identityResolution = new DefaultIdentityResolutionService(
    base.userRepository,
    linkedIdentityRepository,
  );
  const machineIdentity = new DefaultMachineIdentityService(db, base.secretStore, auditService);
  const oauthStateStore = new PgOAuthStateStore(db);
  const sessionAuthProvider = new SessionAuthProvider(sessionService, base.userRepository);

  const adapters: OAuthProviderAdapter[] = [];
  const oauthProviders: OAuthProviderAdapterHolder = {
    adapters,
    register(adapter) {
      adapters.push(adapter);
    },
  };

  const keys = new Map<string, string>();
  const ctx: Record<string, string> = {};

  const stack: TestIdentityStack = {
    ...base,
    userRepository: base.userRepository as PgUserRepository,
    linkedIdentityRepository,
    sessionService,
    passwordCredentials,
    identityResolution,
    machineIdentity,
    oauthStateStore,
    sessionAuthProvider,
    auditService,
    oauthProviders,
    ctx,
    setKey(name, rawKey) {
      keys.set(name, rawKey);
    },
    getKey(name) {
      return keys.get(name);
    },
    async teardown() {
      await base.teardown();
    },
  };
  return stack;
}
