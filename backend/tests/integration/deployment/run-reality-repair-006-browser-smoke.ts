/**
 * REALITY-REPAIR-006 — the real-topology browser smoke (deterministic proof
 * over the REAL deployment entry + the REAL product SPA + a REAL browser).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-006.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-007 ACCEPT;
 * GitHub dispatch Issue #27).
 *
 * Required evidence (the Work Order's own words): "Resolve installed-card
 * names using the existing public workflow read when the org-scoped listing
 * lacks the workflow name. No new route or aggregate authority. Required
 * regression: an installed marketplace workflow displays its real name and
 * still opens against caller-org detail reads."
 *
 * Topology (the REAL one — NOT a test harness composition):
 *   - the backend is the REAL deployment entrypoint spawned as a process:
 *     `bun src/index.ts` (the docker-compose CMD) on the WORK-071 pglite
 *     dev runtime (real PostgreSQL-WASM DatabaseClient + the SAME
 *     migrations as production), WORKFLOWOS_ROLE=all, a fresh temp data
 *     directory, listening on :3001;
 *   - the frontend is the ACTUAL Vite dev server serving the product SPA
 *     (its /api proxy targets :3001 exactly as deployed);
 *   - the browser is a REAL headless Chromium (Playwright).
 *
 * Personas:
 *   - the PUBLISHER is seeded through the REAL HTTP routes only (register →
 *     login → org → public workflow → listing → publish) so the marketplace
 *     has one published free listing to act on. The consumer's journey
 *     never depends on any other fixture.
 *   - the CONSUMER does EVERYTHING through the real browser UI — signup
 *     included — and ends with TWO real browser sessions (theirs + the
 *     publisher's own-org regression pass).
 *
 *   LEG 1  SIGNUP  — the real LoginPage's register surface lands the
 *                    consumer on Home.
 *   LEG 2  ORG     — the RR-002 first-run onboarding creates the
 *                    consumer's organization through the real browser UI
 *                    (the composed precondition of this slice).
 *   LEG 3  MARKET  — Explore → the listing → the entitled free decision →
 *                    the EXISTING V2-002 Install pins version 1 into the
 *                    CONSUMER org.
 *   LEG 4  NAME    — the F-007 repair, in the real browser: the library's
 *                    Installed tab displays the REAL workflow name — the
 *                    heading, the pinned version, Enabled, the Open route —
 *                    and NEVER the generic 'Installed workflow' fallback.
 *   LEG 4b READS   — the browser's own network capture: the EXISTING PUBLIC
 *                    workflow read (GET /workflow-repository/workflows/:id)
 *                    was issued for the missing workflow id, and the
 *                    caller-org installation read still drives the section.
 *   LEG 5  OPEN    — the RR-003 regression: the Open link still opens the
 *                    cross-org detail against CALLER-ORG reads — the
 *                    heading, the description, the Public line, the
 *                    presentation-label steps, the consumer's installation
 *                    pin, "Not run yet", and NO honest-error state.
 *   LEG 5b BOUNDARY— the browser's own network capture: during the detail
 *                    load ZERO requests target the publisher organization's
 *                    org-scoped routes; the caller-org reads are present
 *                    instead.
 *   LEG 6  OWN-ORG — the publisher (a second real browser session) opens
 *                    their library: the own-org card name comes from THEIR
 *                    org-scoped listing (ZERO public reads needed) and the
 *                    Installed tab keeps its honest empty — the own-org
 *                    naming regression, in the real browser.
 *
 * Every leg persists a screenshot + a sha-256 digest; the transcript lands
 * in spec/architecture/v2/dogfooding-evidence/assets/reality-repair-006/
 * (journey.json + the screenshots the evidence document references).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-repair-006-browser-smoke.ts
 * Exit code 0 = every leg passed. Non-zero = a leg failed (printed).
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  createWorkflowIrBuilder,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';
import { versionContentOf } from '../workflow-deployments/trigger-test-support.js';

expect.configure({ timeout: 20_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(HERE, '..', '..', '..');
const REPO_ROOT = join(BACKEND_ROOT, '..');
const ARTIFACTS_DIR = join(
  REPO_ROOT,
  'spec',
  'architecture',
  'v2',
  'dogfooding-evidence',
  'assets',
  'reality-repair-006',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const PUBLISHER_NAME = 'Padma (RR-006 publisher)';
const PUBLISHER_EMAIL = 'reality-repair-006-publisher@deployment.test';
const PUBLISHER_PASSWORD = 'the-reality-repair-006-publisher-42';
const PUBLISHER_ORG_NAME = 'RR-006 Publisher Org';

const CONSUMER_NAME = 'Joon (RR-006 consumer)';
const CONSUMER_EMAIL = 'reality-repair-006-consumer@deployment.test';
const CONSUMER_PASSWORD = 'the-reality-repair-006-consumer-42';
const CONSUMER_ORG_NAME = 'Joon Consumer Org';

const WORKFLOW_NAME = 'Reality repair installed naming digest';
const WORKFLOW_DESCRIPTION = 'Collect the open tickets and email the digest.';
const LISTING_NAME = 'RR-006 installed-naming listing';

interface TranscriptEntry {
  at: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'INFO';
  ms: number;
  detail?: string;
}

const transcript: TranscriptEntry[] = [];
const artifacts: Array<{ file: string; sha256: string; bytes: number }> = [];
const startedAt = new Date();

function info(label: string): void {
  transcript.push({ at: new Date().toISOString(), label, status: 'INFO', ms: 0 });
  console.log(`[INFO] ${label}`);
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const entry: TranscriptEntry = {
      at: new Date().toISOString(),
      label,
      status: 'PASS',
      ms: Date.now() - t0,
    };
    transcript.push(entry);
    console.log(`[PASS] (${entry.ms}ms) ${label}`);
    return out;
  } catch (err) {
    const entry: TranscriptEntry = {
      at: new Date().toISOString(),
      label,
      status: 'FAIL',
      ms: Date.now() - t0,
      detail: err instanceof Error ? `${err.name}: ${err.message.split('\n').slice(0, 6).join(' | ')}` : String(err),
    };
    transcript.push(entry);
    console.log(`[FAIL] (${entry.ms}ms) ${label}\n      ${entry.detail}`);
    throw err;
  }
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function shot(page: Page, name: string): Promise<void> {
  const path = join(ARTIFACTS_DIR, name);
  await page.screenshot({ path, fullPage: true });
  const stat = statSync(path);
  const sha = sha256OfFile(path);
  artifacts.push({
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-repair-006/${name}`,
    sha256: sha,
    bytes: stat.size,
  });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
}

/** The digest fixture with presentation labels (the published workflow). */
function authorSmokeWorkflow(): WorkflowIrDocument {
  const fetchTickets: WorkflowNode = {
    id: 'fetch_tickets',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'github.repository.read' },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'repository',
        type: { kind: 'string' },
        binding: { kind: 'literal', value: 'payswapdotorg/WorkflowOS' },
      },
    ],
    outputs: [{ name: 'tickets', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const sendDigest: WorkflowNode = {
    id: 'send_digest',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'messaging.send' },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addNode(fetchTickets)
    .addNode(sendDigest)
    .addEdge({ from: 'fetch_tickets', to: 'send_digest', on: 'success' })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withPresentation({
      title: WORKFLOW_NAME,
      nodeLabels: {
        fetch_tickets: 'Collect the open tickets',
        send_digest: 'Email the digest',
      },
    })
    .build();
}

interface SeedFacts {
  listingId: string;
  workflowId: string;
  publisherOrgId: string;
}

/** A JSON call against the REAL entry (the seed channel — same session cookie). */
async function api(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      cookie: `wfos_session=${cookie}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`never became healthy: ${url} (last: ${last})`);
}

async function main(): Promise<number> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  for (const entry of readdirSync(ARTIFACTS_DIR)) {
    if (entry.endsWith('.png') || entry.endsWith('.json')) {
      rmSync(join(ARTIFACTS_DIR, entry));
    }
  }

  info(`REALITY-REPAIR-006 real-deployment browser smoke starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-006-smoke-pglite-'));
  const backend: ChildProcessByStdio<null, Readable, Readable> = spawn(
    'bun',
    ['src/index.ts'],
    {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        WORKFLOWOS_DEV_RUNTIME: 'pglite',
        WORKFLOWOS_ROLE: 'all',
        WORKFLOWOS_DEV_DATABASE_DIR: dataDir,
        PORT: String(BACKEND_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        NODE_ENV: 'test',
        DATABASE_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const backendErr: string[] = [];
  backend.stderr.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) backendErr.push(s);
  });

  // ---- 2. The ACTUAL product frontend (the Vite dev server) ------------------
  const vite = spawn('bun', ['run', 'dev', '--', '--port', String(FRONTEND_PORT)], {
    cwd: join(REPO_ROOT, 'frontend'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vite.stderr.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.log(`[vite] ${s}`);
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let exitCode = 1;
  try {
    await step('the REAL deployment entry boots (bun src/index.ts, pglite, role=all, :3001)', () =>
      waitHealthy(`http://127.0.0.1:${BACKEND_PORT}`, 60_000),
    );
    await step('a V2 product route answers on the real entry (GET /marketplace/listings is 401-not-404)', async () => {
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/marketplace/listings`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(401);
    });

    await step('the ACTUAL product SPA is served (Vite dev server)', async () => {
      for (let i = 0; i < 120; i += 1) {
        try {
          const res = await fetch(`${FRONTEND_URL}/`, { signal: AbortSignal.timeout(1000) });
          if (res.ok) return;
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('the Vite dev server never became ready');
    });

    // ---- 3. The PUBLISHER seed through the REAL routes (no direct DB writes).
    //         The CONSUMER is NOT seeded: their entire journey happens through
    //         the real browser UI. ------------------------------------------------
    const seed = await step('seed: publisher register → login → org → public workflow → listing → publish (REAL routes; the consumer gets NOTHING pre-seeded)', async () => {
      const reg = await fetch(`http://127.0.0.1:${BACKEND_PORT}/auth/password/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: PUBLISHER_EMAIL,
          password: PUBLISHER_PASSWORD,
          displayName: PUBLISHER_NAME,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(reg.status, `register: ${await reg.text()}`).toBe(201);
      const login = await fetch(`http://127.0.0.1:${BACKEND_PORT}/auth/password/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: PUBLISHER_EMAIL, password: PUBLISHER_PASSWORD }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(login.status).toBe(200);
      const setCookie = login.headers.get('set-cookie') ?? '';
      const cookie = /wfos_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
      expect(cookie).not.toBe('');

      const org = await api(cookie, 'POST', '/organizations', { name: PUBLISHER_ORG_NAME });
      expect(org.status, JSON.stringify(org.json)).toBe(201);
      const orgId = org.json.organization.id as string;

      const wf = await api(cookie, 'POST', `/organizations/${orgId}/workflow-repository/workflows`, {
        slug: 'reality-repair-006-digest',
        name: WORKFLOW_NAME,
        description: WORKFLOW_DESCRIPTION,
        visibility: 'public', // public: the marketplace publish precondition
        content: versionContentOf(authorSmokeWorkflow()),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      });
      expect(wf.status, JSON.stringify(wf.json)).toBe(201);
      const workflowId = wf.json.workflow.id as string;
      const versionId = wf.json.initialVersion.id as string;

      // The listing carries a FREE offer: the consumer's purchase path is the
      // offer acceptance (a real marketplace command), not a payment provider
      // (none is configured on this topology — honestly so).
      const listing = await api(cookie, 'POST', '/marketplace/listings', {
        organizationId: orgId,
        workflowId,
        versionId,
        name: LISTING_NAME,
        description: 'The REALITY-REPAIR-006 representative published listing.',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      });
      expect(listing.status, JSON.stringify(listing.json)).toBe(201);
      const listingId = listing.json.listing.id as string;

      const publish = await api(cookie, 'POST', `/marketplace/listings/${listingId}/publish`);
      expect(publish.status, JSON.stringify(publish.json)).toBe(200);

      return { listingId, workflowId, publisherOrgId: orgId } satisfies SeedFacts;
    });

    // ---- 4. A REAL browser against the REAL topology -------------------------
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: FRONTEND_URL,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    exitCode = await journey(page, seed, context, browser);
  } catch (err) {
    console.log(`\n[JOURNEY FAILED] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    const finishedAt = new Date();
    const summary = {
      run: 'REALITY-REPAIR-006 real-deployment browser smoke',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode,
      backendPort: BACKEND_PORT,
      frontendPort: FRONTEND_PORT,
      transcript,
      artifacts,
    };
    writeFileSync(join(ARTIFACTS_DIR, 'journey.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n[DONE] exitCode=${exitCode} duration=${summary.durationMs}ms legs=${transcript.filter((t) => t.status === 'PASS').length} passed / ${transcript.filter((t) => t.status === 'FAIL').length} failed`,
    );
    if (backendErr.length > 0) {
      console.log(`[backend stderr tail]\n${backendErr.slice(-10).join('\n')}`);
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best effort
      }
    }
    vite.kill('SIGTERM');
    backend.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    vite.kill('SIGKILL');
    backend.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }
  return exitCode;
}

/** The session cookie of a Playwright browser context (the REAL session). */
async function sessionToken(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(FRONTEND_URL);
  return cookies.find((c) => c.name === 'wfos_session')?.value ?? '';
}

/** The session user's single organization id (resolved from the REAL entry). */
async function firstOrganizationId(context: BrowserContext): Promise<string> {
  const token = await sessionToken(context);
  expect(token).not.toBe('');
  const orgs = await api(token, 'GET', '/organizations');
  expect(orgs.status).toBe(200);
  const orgId = (orgs.json.organizations as Array<{ id: string; name: string }>)[0]?.id ?? '';
  expect(orgId).not.toBe('');
  return orgId;
}

async function journey(
  page: Page,
  seed: SeedFacts,
  context: BrowserContext,
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<number> {
  // ============ LEG 1 — SIGNUP (the real register surface) ====================
  await step('LEG1 the consumer signs up through the real register UI (Create one → Create account) and lands on Home', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill(CONSUMER_NAME);
    await page.locator('#email').fill(CONSUMER_EMAIL);
    await page.locator('#password').fill(CONSUMER_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
  });

  // ============ LEG 2 — ORG: the composed RR-002 onboarding ===================
  await step('LEG2 the consumer creates their organization through the real Home onboarding (the RR-002 composed precondition)', async () => {
    await page.locator('#organization-name').fill(CONSUMER_ORG_NAME);
    await page.getByRole('button', { name: 'Create organization' }).click();
    await expect(
      page.getByRole('region', { name: 'Organization onboarding' }),
    ).toHaveCount(0);
  });
  await shot(page, '01-consumer-org-created.png');

  // ============ LEG 3 — MARKETPLACE: entitled → install =======================
  await step('LEG3 Explore → the listing → the entitled free decision → Install pins version 1 into the CONSUMER organization', async () => {
    await page.goto(`${FRONTEND_URL}/explore/${seed.listingId}`);
    await expect(page.getByRole('heading', { name: LISTING_NAME })).toBeVisible();
    const access = page.getByRole('region', { name: 'Your access' });
    await expect(
      access.getByText("You're entitled to this workflow."),
    ).toBeVisible({ timeout: 20_000 });
    await access.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(
      access.getByText(/Installed — pinned to version 1/i),
    ).toBeVisible({ timeout: 20_000 });
  });
  await shot(page, '02-listing-installed.png');

  // ============ LEG 4 — INSTALLED: the REAL name (F-007) ======================
  // The F-007 repair, in the real browser: the installation's workflow lives
  // ONLY in the publisher's org, so the consumer's org-scoped listing never
  // contains it — the card resolves the REAL name through the EXISTING PUBLIC
  // read. The network capture (LEG 4b) is armed BEFORE the navigation.
  const libraryRequests: string[] = [];
  const onLibraryRequest = (req: import('@playwright/test').Request) => {
    libraryRequests.push(req.url());
  };
  page.on('request', onLibraryRequest);

  await step('LEG4 the library Installed tab displays the REAL workflow name (the F-007 repair) — never the generic fallback', async () => {
    await page.goto(`${FRONTEND_URL}/workflows`);
    await page.getByRole('tab', { name: 'Installed' }).click();
    const panel = page.getByRole('tabpanel');
    // THE F-007 assertion: the REAL name renders on the installed card (at
    // base every cross-org install card showed the generic fallback).
    await expect(
      panel.getByRole('heading', { name: WORKFLOW_NAME }),
    ).toBeVisible({ timeout: 20_000 });
    // The generic fallback NEVER renders (the honest interim state is gone
    // on this surface; loading/failed resolution is what would restore it).
    await expect(panel.getByText('Installed workflow', { exact: true })).toHaveCount(0);
    // The pinned facts remain verbatim from the installation read.
    await expect(panel.getByText(/Version 1 — pinned/i)).toBeVisible();
    await expect(panel.getByText('Enabled', { exact: true })).toBeVisible();
    // The Open link carries the authoritative workflow id forward.
    await expect(panel.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      `/workflows/${seed.workflowId}`,
    );
  });
  await shot(page, '03-installed-real-name.png');

  // ============ LEG 4b — THE READS (the browser's own capture) ================
  await step('LEG4b the EXISTING PUBLIC workflow read was issued for the missing workflow id; the caller-org installation read still drives the section', async () => {
    // The public read: the same GET /workflow-repository/workflows/:id the
    // card's own Open target consumes (the deduplicated per-id contract is
    // pinned deterministically in the component suite; the browser capture
    // here proves the read FIRED for the real missing id).
    const publicWorkflowRead = libraryRequests.filter(
      (u) => u.includes(`/api/workflow-repository/workflows/${seed.workflowId}`),
    );
    expect(
      publicWorkflowRead,
      `library requests: ${libraryRequests.join(' | ')}`,
    ).not.toEqual([]);

    // The caller-org installation read still drove the section (the
    // org-scoped authority of the Installed listing is unchanged).
    const consumerOrgId = await firstOrganizationId(context);
    const consumerInstallations = libraryRequests.filter(
      (u) => u.includes(`/api/organizations/${consumerOrgId}/workflow-repository/installations`),
    );
    expect(consumerInstallations.length).toBeGreaterThan(0);

    // The publisher's org-scoped routes were never touched by the library.
    const publisherPrefix = `/api/organizations/${seed.publisherOrgId}/`;
    const toPublisher = libraryRequests.filter((u) => u.includes(publisherPrefix));
    expect(
      toPublisher,
      `publisher-org requests issued during the library load: ${toPublisher.join(', ')}`,
    ).toEqual([]);

    page.off('request', onLibraryRequest);
  });

  // ============ LEG 5 — OPEN FROM INSTALLED: the detail LOADS (RR-003) ========
  // The required regression: the Open link still opens the cross-org detail
  // against CALLER-ORG reads — the RR-003 surface, UNCHANGED by this repair.
  // The network capture (LEG 5b) is armed BEFORE the navigation.
  const detailRequests: string[] = [];
  const onDetailRequest = (req: import('@playwright/test').Request) => {
    detailRequests.push(req.url());
  };
  page.on('request', onDetailRequest);

  await step('LEG5 the Open link still opens the cross-org detail against caller-org reads (the RR-003 regression): heading, description, Public line, steps, the consumer pin, Not run yet — no honest-error state', async () => {
    const panel = page.getByRole('tabpanel');
    await panel.getByRole('link', { name: 'Open' }).click();
    // THE RR-003 assertion: the detail renders with the consumer's facts.
    await expect(
      page.getByRole('heading', { name: WORKFLOW_NAME }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(WORKFLOW_DESCRIPTION)).toBeVisible();
    await expect(page.getByText(/Public — any signed-in user/i)).toBeVisible();
    // The steps from the presentation layer (the public version read).
    const steps = page.getByRole('list', { name: /what it does/i });
    await expect(steps.getByRole('listitem')).toHaveCount(2);
    await expect(steps.getByText('Collect the open tickets')).toBeVisible();
    await expect(steps.getByText('Email the digest')).toBeVisible();
    // The CONSUMER's installation pin (the caller-org read).
    await expect(page.getByText(/Installed: Version 1 — pinned · Enabled/)).toBeVisible();
    // Honest no-facts states (no runs / deployments yet in the consumer org).
    await expect(page.getByText(/Not run yet/i)).toBeVisible();
    await expect(page.getByText(/not deployed yet/i)).toBeVisible();
    // NO honest-error state — the detail is NOT the error surface.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
  await shot(page, '04-consumer-detail-opens.png');

  // ============ LEG 5b — NO PUBLISHER-ORG READS (the capture) =================
  await step('LEG5b the detail load issued ZERO publisher-org requests; the caller-org reads are present (the browser network capture)', async () => {
    const consumerOrgId = await firstOrganizationId(context);

    const publisherPrefix = `/api/organizations/${seed.publisherOrgId}/`;
    const toPublisher = detailRequests.filter((u) => u.includes(publisherPrefix));
    expect(
      toPublisher,
      `publisher-org requests issued during the consumer detail load: ${toPublisher.join(', ')}`,
    ).toEqual([]);

    const consumerPrefix = `/api/organizations/${consumerOrgId}/`;
    const consumerRuns = detailRequests.filter(
      (u) => u.includes(`${consumerPrefix}workflow-runs/runs`),
    );
    const consumerInstallations = detailRequests.filter(
      (u) => u.includes(`${consumerPrefix}workflow-repository/installations`),
    );
    expect(consumerRuns.length).toBeGreaterThan(0);
    expect(consumerInstallations.length).toBeGreaterThan(0);

    // The unchanged PUBLIC reads are present.
    const publicWorkflowRead = detailRequests.filter((u) =>
      u.includes(`/api/workflow-repository/workflows/${seed.workflowId}`),
    );
    expect(publicWorkflowRead.length).toBeGreaterThan(0);

    page.off('request', onDetailRequest);
  });

  // ============ LEG 6 — OWN-ORG regression (the publisher's session) ==========
  await step('LEG6 the publisher opens their own library (a second real browser session): the own-org card name comes from THEIR org listing — ZERO public reads — and Installed keeps its honest empty', async () => {
    const publisherContext = await browser.newContext({
      baseURL: FRONTEND_URL,
      viewport: { width: 1280, height: 800 },
    });
    try {
      const ppage = await publisherContext.newPage();
      await ppage.goto(`${FRONTEND_URL}/`);
      // The real sign-in surface (the page's default mode).
      await ppage.locator('#email').fill(PUBLISHER_EMAIL);
      await ppage.locator('#password').fill(PUBLISHER_PASSWORD);
      await ppage.getByRole('button', { name: 'Sign in' }).click();
      await expect(
        ppage.getByRole('heading', { name: /What do you want to get done\?/i }),
      ).toBeVisible();

      // Arm the capture for the own-org library load.
      const ownRequests: string[] = [];
      const onOwnRequest = (req: import('@playwright/test').Request) => {
        ownRequests.push(req.url());
      };
      ppage.on('request', onOwnRequest);

      await ppage.goto(`${FRONTEND_URL}/workflows`);
      // The own-org card name (the publisher IS the workflow's owner — the
      // pre-repair behavior, unchanged: the org-scoped listing carries it).
      await expect(
        ppage.getByRole('heading', { name: WORKFLOW_NAME }),
      ).toBeVisible({ timeout: 20_000 });
      // No installation in the publisher org (they authored, never
      // installed) — the honest own-org Installed empty.
      await ppage.getByRole('tab', { name: 'Installed' }).click();
      await expect(ppage.getByText(/Nothing installed yet/i)).toBeVisible();
      // The own-org name resolution needed NO public read: the workflow is
      // in the publisher's own org-scoped listing.
      const publicWorkflowRead = ownRequests.filter(
        (u) => u.includes(`/api/workflow-repository/workflows/${seed.workflowId}`),
      );
      expect(
        publicWorkflowRead,
        `public reads issued during the own-org library load: ${publicWorkflowRead.join(', ')}`,
      ).toEqual([]);

      await shot(ppage, '05-publisher-own-org-library.png');
      ppage.off('request', onOwnRequest);
    } finally {
      await publisherContext.close();
    }
  });

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
