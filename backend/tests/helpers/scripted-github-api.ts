/**
 * WORK-051 round 3 (PR #52 review, BLOCKER 1) — a SCRIPTED local GitHub REST
 * API for the production-shaped regressions.
 *
 * The production {@link DefaultGitHubAdapter} (the REAL REST client: RS256
 * app-JWT signing + installation-token minting + authenticated fetch) is
 * pointed at this local HTTP server through its `apiBaseUrl` config, so the
 * production code path — including the actual HTTP wire protocol, the token
 * exchange, GitHub's status semantics (201 create / 404 not-found / 422
 * duplicate-open-PR-per-head) — runs for real, end to end, without network
 * access to github.com.
 *
 * The server RECORDS every request (method, path, auth header, JSON body)
 * and counts token mints, so the regressions can assert the EXACT wire
 * behavior: verbatim ref pass-through, the convergence-read query string,
 * exactly-one-create across crash/retry, token caching, and more.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

interface ScriptedPullRequest {
  owner: string;
  repository: string;
  number: number;
  head: string;
  headSha: string;
  base: string;
  title: string;
  state: 'open' | 'closed';
  mergedAt: string | null;
}

interface ScriptedContentEntry {
  name: string;
  type: 'file' | 'dir';
  /** base64 file content (files only). */
  content?: string;
}

function deterministicHeadSha(owner: string, repository: string, head: string): string {
  return createHash('sha256').update(`${owner}/${repository}/${head}`, 'utf8').digest('hex').slice(0, 40);
}

/**
 * The scripted GitHub REST API. Supports exactly the operations the WORK-051
 * governed boundary needs (plus the app-auth probe):
 *
 *   POST /app/installations/:id/access_tokens      (token mint)
 *   GET  /app                                     (health probe, app JWT)
 *   GET  /repos/:o/:r/pulls?head=:o:branch&state=open
 *   POST /repos/:o/:r/pulls                       (201; 422 duplicate open head)
 *   GET  /repos/:o/:r/pulls/:number               (404 when unknown)
 *   GET  /repos/:o/:r/contents/*?ref=...          (files + dir listings; 404)
 */
export class ScriptedGitHubApi {
  readonly requests: RecordedRequest[] = [];
  tokenMints = 0;

  private readonly pullRequests: ScriptedPullRequest[] = [];
  private nextPrNumber = 1;
  /** contentKey(owner, repo, ref, path) → entry (file) | entries array (dir). */
  private readonly content = new Map<string, ScriptedContentEntry | ScriptedContentEntry[]>();
  private server: ReturnType<typeof createServer> | null = null;
  private baseUrl = '';

  /** Seed a file at an exact (owner, repo, ref, path) tuple. */
  setFile(owner: string, repository: string, ref: string, path: string, text: string): this {
    this.content.set(this.contentKey(owner, repository, ref, path), {
      name: path.split('/').pop() ?? path,
      type: 'file',
      content: Buffer.from(text, 'utf8').toString('base64'),
    });
    return this;
  }

  /** Seed a directory listing at an exact (owner, repo, ref, path) tuple. */
  setDir(owner: string, repository: string, ref: string, path: string, entries: Array<{ name: string; type: 'file' | 'dir' }>): this {
    this.content.set(this.contentKey(owner, repository, ref, path), entries.map((e) => ({ ...e })));
    return this;
  }

  /** All PRs currently held (assertions). */
  get pullRequestCount(): number {
    return this.pullRequests.length;
  }

  /** Seed an EXTERNAL PR (opened out-of-band — not through the governed path). */
  seedExternalPullRequest(input: {
    owner: string;
    repository: string;
    head: string;
    headSha: string;
    state?: 'open' | 'closed';
    merged?: boolean;
  }): number {
    const number = this.nextPrNumber++;
    this.pullRequests.push({
      owner: input.owner,
      repository: input.repository,
      number,
      head: input.head,
      headSha: input.headSha,
      base: 'main',
      title: 'External PR',
      state: input.state ?? 'open',
      mergedAt: input.merged ? new Date().toISOString() : null,
    });
    return number;
  }

  private contentKey(owner: string, repository: string, ref: string, path: string): string {
    return `${owner}/${repository}/${ref}/${path}`;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server!.address();
    if (address && typeof address === 'object') {
      this.baseUrl = `http://127.0.0.1:${address.port}`;
    }
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  get url(): string {
    return this.baseUrl;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://scripted.github.local');
    const path = url.pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    this.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
      body,
    });

    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // --- the GitHub App authentication surface ---
    const tokenMatch = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(path);
    if (req.method === 'POST' && tokenMatch) {
      this.tokenMints += 1;
      const installationId = tokenMatch[1]!;
      json(201, {
        token: `ghs_scripted_${installationId}_${this.tokenMints}`,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      return;
    }
    if (req.method === 'GET' && path === '/app') {
      json(200, { id: 12345, slug: 'workflowos-scripted' });
      return;
    }

    // --- the repository PR surface ---
    const pullsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(path);
    if (req.method === 'GET' && pullsMatch) {
      const owner = decodeURIComponent(pullsMatch[1]!);
      const repository = decodeURIComponent(pullsMatch[2]!);
      const head = url.searchParams.get('head');
      const state = url.searchParams.get('state') ?? 'open';
      let list = this.pullRequests.filter(
        (pr) => pr.owner === owner && pr.repository === repository,
      );
      if (head) {
        // GitHub's fully-qualified head filter: owner:branch (same-repo).
        const [headOwner, headBranch] = head.split(':');
        list = list.filter(
          (pr) => pr.head === (headBranch ?? head) && (!headOwner || headOwner === owner),
        );
      }
      if (state) {
        list = list.filter((pr) => pr.state === state);
      }
      json(200, list.map((pr) => this.prJson(pr)));
      return;
    }
    if (req.method === 'POST' && pullsMatch) {
      const owner = decodeURIComponent(pullsMatch[1]!);
      const repository = decodeURIComponent(pullsMatch[2]!);
      const payload = (body ?? {}) as Record<string, unknown>;
      const head = typeof payload.head === 'string' ? payload.head : '';
      const base = typeof payload.base === 'string' ? payload.base : 'main';
      const title = typeof payload.title === 'string' ? payload.title : '';
      // GitHub's identity semantics: at most ONE OPEN PR per (head, base).
      const duplicate = this.pullRequests.some(
        (pr) =>
          pr.owner === owner &&
          pr.repository === repository &&
          pr.head === head &&
          pr.base === base &&
          pr.state === 'open',
      );
      if (duplicate) {
        json(422, {
          message: `A pull request already exists for ${owner}:${head}.`,
          documentation_url: 'https://docs.github.com/rest',
        });
        return;
      }
      const number = this.nextPrNumber++;
      const pr: ScriptedPullRequest = {
        owner,
        repository,
        number,
        head,
        headSha: deterministicHeadSha(owner, repository, head),
        base,
        title,
        state: 'open',
        mergedAt: null,
      };
      this.pullRequests.push(pr);
      json(201, this.prJson(pr));
      return;
    }
    const prMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(path);
    if (req.method === 'GET' && prMatch) {
      const owner = decodeURIComponent(prMatch[1]!);
      const repository = decodeURIComponent(prMatch[2]!);
      const number = Number(prMatch[3]);
      const pr = this.pullRequests.find(
        (p) => p.owner === owner && p.repository === repository && p.number === number,
      );
      if (!pr) {
        json(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
        return;
      }
      json(200, this.prJson(pr));
      return;
    }

    // --- the repository content surface ---
    const contentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/.exec(path);
    if (req.method === 'GET' && contentsMatch) {
      const owner = decodeURIComponent(contentsMatch[1]!);
      const repository = decodeURIComponent(contentsMatch[2]!);
      const contentPath = contentsMatch[3]!
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => decodeURIComponent(segment))
        .join('/');
      const ref = url.searchParams.get('ref') ?? '';
      const entry = this.content.get(this.contentKey(owner, repository, ref, contentPath));
      if (!entry) {
        json(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
        return;
      }
      if (Array.isArray(entry)) {
        // A directory listing — GitHub returns the child entries with
        // relative _links; only name+type matter to the adapter.
        json(200, entry.map((e) => ({ name: e.name, type: e.type, path: `${contentPath}/${e.name}` })));
        return;
      }
      json(200, {
        name: entry.name,
        path: contentPath,
        type: entry.type,
        content: entry.content ?? '',
        encoding: 'base64',
      });
      return;
    }

    json(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
  }

  private prJson(pr: ScriptedPullRequest): Record<string, unknown> {
    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      merged_at: pr.mergedAt,
      html_url: `https://github.com/${pr.owner}/${pr.repository}/pull/${pr.number}`,
      head: { ref: pr.head, sha: pr.headSha },
      base: { ref: pr.base },
    };
  }
}

/**
 * Generate an RSA keypair for the production-shaped regressions: the private
 * key is handed to the PRODUCTION adapter (which signs the real RS256 JWT),
 * the public key verifies the signature the scripted server received — the
 * full proof that the production JWT construction is GitHub-conformant.
 */
export async function generateRsaKeyPairPem(): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
