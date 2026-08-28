import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHash, createVerify } from 'node:crypto';

import {
  DefaultGitHubAdapter,
  resolveGitHubAppCredentials,
} from '../../../src/modules/github/internal/pg-github-repository.js';
import {
  ScriptedGitHubApi,
  generateRsaKeyPairPem,
} from '../../helpers/scripted-github-api.js';

/**
 * WORK-051 round 3 (PR #52 review, BLOCKER 1) — the PRODUCTION /github REST
 * authority, proven against a scripted local GitHub API.
 *
 * The architect's round-2 verdict: "the supposedly authoritative external
 * boundary is still a test-only implementation." These regressions run the
 * REAL production adapter — the real RS256 GitHub-App JWT signing, the real
 * installation-token minting, the real authenticated fetch wire protocol —
 * against a local HTTP server that mirrors GitHub's REST semantics (201
 * create / 404 not-found / 422 duplicate-open-PR-per-head). Nothing is faked
 * in-process: the production code path makes real HTTP requests.
 *
 * What is proven here:
 *   - the app JWT is a REAL RS256 signature (verified with the public key)
 *     over the canonical GitHub claims (iss = app id, ≤10-minute window);
 *   - the installation token is minted once per installation and CACHED
 *     across calls;
 *   - createPullRequest performs the real POST and surfaces GitHub's 422
 *     duplicate-open-PR rejection verbatim (fail closed);
 *   - findPullRequestByHead issues the REAL convergence-read query
 *     (`?head=<owner>:<branch>&state=open`) and maps found/not-found;
 *   - getPullRequestInfo resolves the PR's AUTHORITATIVE head commit (the
 *     external-adoption resolution read) and returns an honest null on 404;
 *   - getFileContent/listDir pass the requested ref through VERBATIM (the
 *     EXACT-REF resolution contract) and decode + digest the bytes;
 *   - the unconfigured adapter fails CLOSED on every governed surface.
 */
describe('WORK-051 round 3 — the production /github REST authority (real client + scripted GitHub API)', () => {
  let api: ScriptedGitHubApi;
  let adapter: DefaultGitHubAdapter;
  let privateKeyPem: string;
  let publicKeyPem: string;
  const APP_ID = '12345678';
  const INSTALLATION_ID = 'inst-42';
  const OWNER = 'prod-org';
  const REPO = 'prod-repo';

  beforeAll(async () => {
    const keyPair = await generateRsaKeyPairPem();
    privateKeyPem = keyPair.privateKeyPem;
    publicKeyPem = keyPair.publicKeyPem;
    api = new ScriptedGitHubApi();
    const baseUrl = await api.start();
    // The PRODUCTION adapter, configured exactly as the composition root
    // configures it in production (app id + private key + API base URL).
    adapter = new DefaultGitHubAdapter({
      appId: APP_ID,
      privateKey: privateKeyPem,
      apiBaseUrl: baseUrl,
    });
  });

  afterAll(async () => {
    await api.stop();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const requestsFor = (predicate: (r: { method: string; path: string }) => boolean) =>
    api.requests.filter((r) => predicate(r));

  it('the app JWT is a REAL RS256 signature over the canonical GitHub claims (verified with the public key)', async () => {
    // Any authenticated call triggers the token mint; the token endpoint
    // receives the APP JWT as the bearer credential.
    await adapter.findPullRequestByHead({
      owner: OWNER,
      repository: REPO,
      head: 'wfos/governed/does-not-exist',
      installationId: INSTALLATION_ID,
    });
    const mint = requestsFor((r) => r.method === 'POST' && r.path.startsWith('/app/installations/'));
    expect(mint.length).toBeGreaterThanOrEqual(1);
    const auth = mint[0]!.authorization ?? '';
    expect(auth.startsWith('Bearer ')).toBe(true);
    const jwt = auth.slice('Bearer '.length);
    const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');
    expect([headerSeg, payloadSeg, signatureSeg].every((s) => typeof s === 'string' && s.length > 0)).toBe(true);

    // The signature VERIFIES with the public key (RS256 over header.payload).
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSeg}.${payloadSeg}`);
    expect(verifier.verify(publicKeyPem, Buffer.from(signatureSeg!, 'base64url'))).toBe(true);

    // The claims are GitHub-conformant.
    const header = JSON.parse(Buffer.from(headerSeg!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(payloadSeg!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(payload.iss).toBe(APP_ID);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);
    expect((payload.iat as number) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120);
  });

  it('createPullRequest performs the REAL REST create: correct method/path/payload, installation-token auth, mapped result', async () => {
    const result = await adapter.createPullRequest({
      owner: OWNER,
      repository: REPO,
      title: 'Governed work item',
      head: 'wfos/governed/create-1',
      base: 'main',
      body: 'governed body',
      installationId: INSTALLATION_ID,
    });
    expect(result.number).toBe(1);
    expect(result.owner).toBe(OWNER);
    expect(result.repository).toBe(REPO);
    expect(result.url).toBe(`https://github.com/${OWNER}/${REPO}/pull/1`);
    // The deterministic head SHA the scripted authority reports.
    const expectedSha = createHash('sha256')
      .update(`${OWNER}/${REPO}/wfos/governed/create-1`, 'utf8')
      .digest('hex')
      .slice(0, 40);
    expect(result.headSha).toBe(expectedSha);

    const create = requestsFor((r) => r.method === 'POST' && r.path === `/repos/${OWNER}/${REPO}/pulls`);
    expect(create).toHaveLength(1);
    expect(create[0]!.authorization).toMatch(/^Bearer ghs_scripted_/);
    expect(create[0]!.body).toEqual({
      title: 'Governed work item',
      head: 'wfos/governed/create-1',
      base: 'main',
      body: 'governed body',
    });
  });

  it('createPullRequest surfaces GitHub\'s 422 duplicate-open-PR rejection VERBATIM (fail closed at the provider boundary)', async () => {
    await expect(
      adapter.createPullRequest({
        owner: OWNER,
        repository: REPO,
        title: 'duplicate',
        head: 'wfos/governed/create-1', // same head — an open PR already exists
        base: 'main',
        installationId: INSTALLATION_ID,
      }),
    ).rejects.toThrow(/422.*A pull request already exists for/);
  });

  it('findPullRequestByHead issues the REAL convergence-read query and maps found/not-found', async () => {
    const found = await adapter.findPullRequestByHead({
      owner: OWNER,
      repository: REPO,
      head: 'wfos/governed/create-1',
      installationId: INSTALLATION_ID,
    });
    expect(found).not.toBeNull();
    expect(found!.number).toBe(1);
    expect(found!.state).toBe('open');
    const expectedSha = createHash('sha256')
      .update(`${OWNER}/${REPO}/wfos/governed/create-1`, 'utf8')
      .digest('hex')
      .slice(0, 40);
    expect(found!.headSha).toBe(expectedSha);

    // The EXACT convergence-read wire query: fully-qualified head + open state.
    const read = requestsFor(
      (r) => r.method === 'GET' && r.path.startsWith(`/repos/${OWNER}/${REPO}/pulls?`),
    );
    expect(read.length).toBeGreaterThanOrEqual(1);
    const lastRead = read.at(-1)!;
    expect(lastRead.path).toBe(
      `/repos/${OWNER}/${REPO}/pulls?head=${encodeURIComponent(`${OWNER}:wfos/governed/create-1`)}&state=open`,
    );

    // Not found → an honest null (never a fabricated PR, never a throw).
    const absent = await adapter.findPullRequestByHead({
      owner: OWNER,
      repository: REPO,
      head: 'wfos/governed/never-created',
      installationId: INSTALLATION_ID,
    });
    expect(absent).toBeNull();
  });

  it('getPullRequestInfo resolves the PR\'s AUTHORITATIVE head commit; an unknown PR is an honest null (404)', async () => {
    const info = await adapter.getPullRequestInfo(INSTALLATION_ID, OWNER, REPO, 1);
    expect(info).not.toBeNull();
    expect(info!.prNumber).toBe(1);
    expect(info!.state).toBe('open');
    expect(info!.merged).toBe(false);
    expect(info!.headCommit).toMatch(/^[0-9a-f]{40}$/);

    const missing = await adapter.getPullRequestInfo(INSTALLATION_ID, OWNER, REPO, 9999);
    expect(missing).toBeNull();
  });

  it('getFileContent passes the ref through VERBATIM, decodes the content, and digests it (the EXACT-REF contract)', async () => {
    const REF = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    api.setFile(OWNER, REPO, REF, 'src/architecture.txt', 'frozen tree bytes');
    const read = await adapter.getFileContent({
      owner: OWNER,
      repository: REPO,
      ref: REF,
      path: 'src/architecture.txt',
      installationId: INSTALLATION_ID,
    });
    expect(read).not.toBeNull();
    expect(read!.content).toBe('frozen tree bytes');
    expect(read!.contentDigest).toBe(
      createHash('sha256').update('frozen tree bytes', 'utf8').digest('hex'),
    );
    // VERBATIM ref pass-through on the wire.
    const wire = requestsFor(
      (r) => r.method === 'GET' && r.path.startsWith(`/repos/${OWNER}/${REPO}/contents/src/architecture.txt`),
    );
    expect(wire.at(-1)!.path).toBe(
      `/repos/${OWNER}/${REPO}/contents/src/architecture.txt?ref=${encodeURIComponent(REF)}`,
    );

    // A missing path at that revision → null (never another revision's bytes).
    const missing = await adapter.getFileContent({
      owner: OWNER,
      repository: REPO,
      ref: REF,
      path: 'src/no-such-file.txt',
      installationId: INSTALLATION_ID,
    });
    expect(missing).toBeNull();

    // A DIRECTORY read through the file surface fails closed (loud).
    api.setDir(OWNER, REPO, REF, 'src', [{ name: 'architecture.txt', type: 'file' }]);
    await expect(
      adapter.getFileContent({
        owner: OWNER,
        repository: REPO,
        ref: REF,
        path: 'src',
        installationId: INSTALLATION_ID,
      }),
    ).rejects.toThrow(/is a directory at ref/);
  });

  it('listDir maps the entries of EXACTLY the requested ref; a missing dir is empty entries', async () => {
    const REF = 'f1e2d3c4b5a6978867564a3b2c1d0e9f8a7b6c5d';
    api.setDir(OWNER, REPO, REF, 'modules', [
      { name: 'github', type: 'dir' },
      { name: 'workflows', type: 'dir' },
    ]);
    const listing = await adapter.listDir({
      owner: OWNER,
      repository: REPO,
      ref: REF,
      path: 'modules',
      installationId: INSTALLATION_ID,
    });
    expect(listing.entries).toEqual([
      { name: 'github', type: 'dir' },
      { name: 'workflows', type: 'dir' },
    ]);
    const wire = requestsFor(
      (r) => r.method === 'GET' && r.path.startsWith(`/repos/${OWNER}/${REPO}/contents/modules`),
    );
    expect(wire.at(-1)!.path).toBe(
      `/repos/${OWNER}/${REPO}/contents/modules?ref=${encodeURIComponent(REF)}`,
    );

    const missing = await adapter.listDir({
      owner: OWNER,
      repository: REPO,
      ref: REF,
      path: 'no/such/dir',
      installationId: INSTALLATION_ID,
    });
    expect(missing.entries).toEqual([]);
  });

  it('the installation token is MINTED ONCE and cached across calls', async () => {
    const mintsBefore = api.tokenMints;
    await adapter.findPullRequestByHead({
      owner: OWNER, repository: REPO, head: 'wfos/governed/create-1', installationId: INSTALLATION_ID,
    });
    await adapter.getPullRequestInfo(INSTALLATION_ID, OWNER, REPO, 1);
    await adapter.findPullRequestByHead({
      owner: OWNER, repository: REPO, head: 'wfos/governed/create-1', installationId: INSTALLATION_ID,
    });
    expect(api.tokenMints).toBe(mintsBefore); // ZERO additional mints — the cache holds
  });

  it('the unconfigured adapter FAILS CLOSED on every governed surface (no env credentials)', async () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    vi.stubEnv('GITHUB_API_BASE_URL', '');
    const unconfigured = new DefaultGitHubAdapter({ appId: undefined, privateKey: undefined });
    await expect(
      unconfigured.createPullRequest({
        owner: OWNER, repository: REPO, title: 'x', head: 'b', base: 'main', installationId: INSTALLATION_ID,
      }),
    ).rejects.toThrow(/github-not-configured/);
    await expect(
      unconfigured.findPullRequestByHead({ owner: OWNER, repository: REPO, head: 'b', installationId: INSTALLATION_ID }),
    ).rejects.toThrow(/github-not-configured/);
    await expect(
      unconfigured.getPullRequestInfo(INSTALLATION_ID, OWNER, REPO, 1),
    ).rejects.toThrow(/github-not-configured/);
    await expect(
      unconfigured.getFileContent({ owner: OWNER, repository: REPO, ref: 'r', path: 'p', installationId: INSTALLATION_ID }),
    ).rejects.toThrow(/github-not-configured/);
    await expect(
      unconfigured.listDir({ owner: OWNER, repository: REPO, ref: 'r', path: 'p', installationId: INSTALLATION_ID }),
    ).rejects.toThrow(/github-not-configured/);
    expect(await unconfigured.health()).toBe('not-configured');
  });

  it('health() probes the credential liveness endpoint (GET /app with the app JWT)', async () => {
    const health = await adapter.health();
    expect(health).toBe('connected');
    const probes = requestsFor((r) => r.method === 'GET' && r.path === '/app');
    expect(probes.length).toBeGreaterThanOrEqual(1);
    expect(probes.at(-1)!.authorization).toMatch(/^Bearer /);
  });

  it('the explicitly-out-of-scope provisioning/merge surfaces still fail with the documented scoped error', async () => {
    await expect(
      adapter.createRepository({ owner: OWNER, repository: REPO, visibility: 'public', installationId: INSTALLATION_ID }),
    ).rejects.toThrow(/WORK-026 follow-on/);
    await expect(
      adapter.createBranch({ owner: OWNER, repository: REPO, branchName: 'b', installationId: INSTALLATION_ID }),
    ).rejects.toThrow(/WORK-026 follow-on/);
    await expect(
      adapter.getBranch({ owner: OWNER, repository: REPO, branchName: 'b', installationId: INSTALLATION_ID }),
    ).rejects.toThrow(/WORK-026 follow-on/);
    await expect(
      adapter.mergePullRequest({ owner: OWNER, repo: REPO, prNumber: 1, installationId: INSTALLATION_ID }),
    ).rejects.toThrow(/WORK-019 follow-on/);
  });
});

describe('WORK-051 round 4 — the credential AUTHORITY is the platform SecretStore (PR #52 review, BLOCKER 1)', () => {
  // The round-4 finding: the adapter read GITHUB_APP_ID /
  // GITHUB_APP_PRIVATE_KEY directly from process.env — a SECOND credential
  // access mechanism next to the platform's SecretStore (SEC-001), so the
  // adapter's documentation and its implementation contradicted each other.
  //
  // The fix proven here: /github owns the canonical KEY NAMES; the VALUES are
  // resolved through the EXISTING SecretStore (resolveGitHubAppCredentials)
  // and injected EXPLICITLY by the composition root. The adapter performs
  // ZERO environment access — env credentials do not configure it at all.
  let api: ScriptedGitHubApi;
  let privateKeyPem: string;
  const APP_ID = '87654321';
  const INSTALLATION_ID = 'inst-r4';
  const OWNER = 'r4-cred-org';
  const REPO = 'r4-cred-repo';

  /** An in-memory SecretStore double (records every resolution). */
  class MapSecretStore {
    readonly resolutions: string[] = [];
    constructor(private readonly secrets: Map<string, string>) {}
    async getSecret(ref: { key: string }): Promise<string | null> {
      this.resolutions.push(ref.key);
      return this.secrets.get(ref.key) ?? null;
    }
    ref(key: string): { key: string } {
      return { key };
    }
  }

  beforeAll(async () => {
    const keyPair = await generateRsaKeyPairPem();
    privateKeyPem = keyPair.privateKeyPem;
    api = new ScriptedGitHubApi();
    await api.start();
  });

  afterAll(async () => {
    await api.stop();
  });

  it('resolveGitHubAppCredentials resolves BOTH credentials THROUGH the SecretStore (the only sanctioned mechanism)', async () => {
    const store = new MapSecretStore(
      new Map([
        ['GITHUB_APP_ID', APP_ID],
        ['GITHUB_APP_PRIVATE_KEY', privateKeyPem],
      ]),
    );
    const credentials = await resolveGitHubAppCredentials(store);
    expect(credentials).toEqual({ appId: APP_ID, privateKey: privateKeyPem });
    // Both resolutions went THROUGH the SecretStore boundary — the canonical
    // key names owned by /github.
    expect(store.resolutions).toContain('GITHUB_APP_ID');
    expect(store.resolutions).toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('a MISSING credential at the store resolves to null (an honestly unconfigured adapter — never a partial configuration)', async () => {
    const onlyId = new MapSecretStore(new Map([['GITHUB_APP_ID', APP_ID]]));
    expect(await resolveGitHubAppCredentials(onlyId)).toBeNull();
    const onlyKey = new MapSecretStore(new Map([['GITHUB_APP_PRIVATE_KEY', privateKeyPem]]));
    expect(await resolveGitHubAppCredentials(onlyKey)).toBeNull();
    const empty = new MapSecretStore(new Map());
    expect(await resolveGitHubAppCredentials(empty)).toBeNull();
  });

  it('the PRODUCTION WIRING SHAPE: the adapter built from SecretStore-resolved credentials performs the REAL governed REST create', async () => {
    // Exactly the composition-root wiring (app.ts): resolve through the
    // SecretStore, then inject EXPLICITLY. The resulting adapter speaks the
    // real REST wire protocol.
    const store = new MapSecretStore(
      new Map([
        ['GITHUB_APP_ID', APP_ID],
        ['GITHUB_APP_PRIVATE_KEY', privateKeyPem],
      ]),
    );
    const credentials = await resolveGitHubAppCredentials(store);
    expect(credentials).not.toBeNull();
    const wired = new DefaultGitHubAdapter({
      ...(credentials ?? {}),
      apiBaseUrl: api.url,
    });

    const branch = 'wfos/governed/r4-wiring-proof';
    api.setBranchHead(OWNER, REPO, branch, 'r4wiringrev0000000000000000000000000001');
    const created = await wired.createPullRequest({
      owner: OWNER,
      repository: REPO,
      title: 'round-4 wiring proof',
      head: branch,
      base: 'main',
      installationId: INSTALLATION_ID,
    });
    expect(created.headSha).toBe('r4wiringrev0000000000000000000000000001');
    // The REAL authenticated wire call happened (installation-token bearer).
    const wireCreate = api.requests.filter(
      (r) => r.method === 'POST' && r.path === `/repos/${OWNER}/${REPO}/pulls`,
    );
    expect(wireCreate.length).toBeGreaterThanOrEqual(1);
    expect(wireCreate.at(-1)!.authorization).toMatch(/^Bearer ghs_/);
    expect(await wired.health()).toBe('connected');
  });

  it('the adapter performs ZERO environment access — env credentials alone NEVER configure it (fail closed)', async () => {
    // The credentials exist in the ENVIRONMENT but are NOT injected: the
    // adapter stays unconfigured (it never reads process.env itself — the
    // composition root's SecretStore resolution is the only channel).
    vi.stubEnv('GITHUB_APP_ID', APP_ID);
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKeyPem);
    const unconfigured = new DefaultGitHubAdapter({ apiBaseUrl: api.url });
    const requestsBefore = api.requests.length;
    await expect(
      unconfigured.createPullRequest({
        owner: OWNER, repository: REPO, title: 'x', head: 'b', base: 'main', installationId: INSTALLATION_ID,
      }),
    ).rejects.toThrow(/github-not-configured/);
    expect(await unconfigured.health()).toBe('not-configured');
    // And ZERO wire calls were attempted (nothing reached the authority).
    expect(api.requests.length).toBe(requestsBefore);
    vi.unstubAllEnvs();
  });
});
