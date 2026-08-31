import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';

/**
 * WORK-065 — REAL-BROWSER integration evidence.
 *
 * This test launches a REAL Chromium browser (Playwright) against a tiny
 * local HTTP server serving a known HTML page, and drives the
 * DefaultBrowserValidationAgent through the PlaywrightBrowserDriver adapter
 * (the ONE place browser-automation libraries appear — the boundary).
 *
 * It proves the full execution path against real browser behavior:
 *   admit (WORK-064) → enforce EffectPolicy → navigate + extract via the
 *   BrowserDriver port (WORK-036) → capture observations with provenance →
 *   finalize (WORK-064 derives the typed outcome) → map into /verification.
 *
 * This is the 'browser test itself must use the product as a user would'
 * obligation (spec/work-orders/WORK-065.md — Verification). The fake-driver
 * unit tests (agent-execution.test.ts) prove the adversarial failure
 * semantics deterministically; this test proves the REAL happy path.
 */
import {
  defineValidationJourney,
  describeEnvironment,
  DefaultContinuousValidationService,
  InMemoryValidationRunRepository,
  type ValidationJourney,
  type Environment,
  type TestIdentitySource,
} from '../../src/continuous-validation/index.js';
import {
  DefaultBrowserValidationAgent,
  defineBrowserJourneyPlan,
  PlaywrightBrowserDriver,
} from '../../src/browser-validation/index.js';
import { createLogger } from '@platform/logger.js';
import { FakeVerificationService } from './helpers.js';

const logger = createLogger({ level: 'silent' });

// ---------------------------------------------------------------------------
// The served HTML page (the product surface the browser drives)
// ---------------------------------------------------------------------------

const SERVED_HTML = `<!doctype html>
<html lang="en">
<head><title>WorkflowOS Sign-in</title></head>
<body>
  <main>
    <h1>Sign in to WorkflowOS</h1>
    <form id="sign-in-form">
      <input name="email" type="email" placeholder="email" />
      <input name="password" type="password" placeholder="password" />
      <button type="submit">Sign in</button>
    </form>
    <footer>WorkflowOS — the AI-assisted software development workflow.</footer>
  </main>
</body>
</html>`;

// ---------------------------------------------------------------------------
// The journey + plan (navigate to the served page + extract the heading)
// ---------------------------------------------------------------------------

// The journey is declared in beforeAll: its AUTHORITATIVE navigation-safety
// declaration (readonlySafeNavigationTargets — part of the journey itself,
// PR #97 fourth architect review correction) includes the ephemeral server
// URL, which is only known once the test server has bound its port. There is
// NO executor input channel for the declaration.
let journey: ValidationJourney | null = null;

const makeJourney = (safeTarget: string): ValidationJourney =>
  defineValidationJourney({
  id: 'journey-real-browser-sign-in',
  name: 'The sign-in page renders (real browser)',
  identityRequirement: 'unauthenticated',
  allowedModes: ['PRE_MERGE'],
  effectPolicy: 'READ_ONLY',
  // THE AUTHORITATIVE DECLARATION — journey-owned, declared under WORK-064's
  // authority at defineValidationJourney (validated: http(s), no userinfo):
  readonlySafeNavigationTargets: [safeTarget],
  steps: [
    {
      id: 'step-open',
      name: 'open the sign-in page',
      expectedObservations: [
        { id: 'obs-heading', stepId: 'step-open', kind: 'dom', description: 'the sign-in heading is visible', matcher: { kind: 'contains_text', text: 'Sign in to WorkflowOS' } },
        { id: 'obs-status', stepId: 'step-open', kind: 'network', description: 'the page loaded (200)', matcher: { kind: 'status_code', status: 200 } },
        { id: 'obs-title', stepId: 'step-open', kind: 'dom', description: 'the page title', matcher: { kind: 'contains_text', text: 'WorkflowOS Sign-in' } },
      ],
    },
  ],
  successCriteria: [{ id: 'crit-page', description: 'the sign-in page renders', requiresObservationIds: ['obs-heading', 'obs-status'] }],
  });

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const env: Environment = describeEnvironment({
  id: 'env-real-browser-test',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY'],
});
const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };
const fixedClock = () => new Date('2026-08-30T12:00:00.000Z');

let server: Server | null = null;
let baseUrl = '';
let browser: Browser | null = null;
let driver: PlaywrightBrowserDriver | null = null;
let verification: FakeVerificationService | null = null;
let agent: DefaultBrowserValidationAgent | null = null;

// Determine SYNCHRONOUSLY at module load whether the chromium binary is
// installed. `it.skipIf(skipped)` evaluates its condition eagerly at test
// registration (before beforeAll runs), so a runtime-only flag set in
// beforeAll would NOT skip the tests — they'd run with a null agent and
// fail. The chromium executablePath() returns the expected binary location;
// if it throws or the file does not exist, skip the suite (the backend CI
// workflow does not run `playwright install`; the dedicated e2e workflows do).
let skipped = false;
let chromiumExecutablePath = '';
try {
  chromiumExecutablePath = chromium.executablePath();
} catch {
  skipped = true;
}
if (!skipped && !existsSync(chromiumExecutablePath)) {
  skipped = true;
}

beforeAll(async () => {
  if (skipped) return;
  // 1. Launch a tiny HTTP server on an ephemeral port.
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SERVED_HTML);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server!.address();
  if (typeof addr === 'object' && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  // 1b. Declare the journey NOW (its navigation-safety declaration needs the
  //     ephemeral baseUrl). The declaration is journey-owned — the execution
  //     inputs below carry NO navigation-safety object.
  journey = makeJourney(`${baseUrl}/sign-in`);

  // 2. Launch a real Chromium browser. If the binary is unavailable at runtime
  //    (a race with the synchronous check above), skip the suite. The agent's
  //    fail-closed semantics are proven by the unit tests regardless.
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    skipped = true;
    console.warn('[WORK-065 real-browser] chromium launch failed — skipping:', (err as Error).message);
    return;
  }
  driver = new PlaywrightBrowserDriver({ browser });

  // 3. Construct the agent with the WORK-064 service + the real driver.
  verification = new FakeVerificationService();
  const cv = new DefaultContinuousValidationService({
    runRepository: new InMemoryValidationRunRepository(),
    verificationService: verification,
  });
  agent = new DefaultBrowserValidationAgent({
    continuousValidationService: cv,
    driver,
    logger,
  });
}, 60_000);

afterAll(async () => {
  await driver?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// The real-browser execution proof
// ---------------------------------------------------------------------------

describe('WORK-065 real-browser integration — the execution path against a real Chromium', () => {
  it.skipIf(skipped)('navigates + extracts the heading against a REAL browser → healthy, observations provenance-bound, evidence mapped into /verification', async () => {
    expect(agent).not.toBeNull();
    // Rewrite the navigate URL to the ephemeral server port.
    const realPlan = defineBrowserJourneyPlan(
      {
        journeyId: journey!.id,
        steps: [
          {
            stepId: 'step-open',
            actions: [
              { kind: 'navigate', url: `${baseUrl}/sign-in`, satisfiesObservationId: 'obs-status' },
              { kind: 'extract', selector: 'h1', satisfiesObservationId: 'obs-heading' },
              { kind: 'extract', selector: 'title', satisfiesObservationId: 'obs-title' },
            ],
          },
        ],
      },
      journey!,
    );

    const outcome = await agent!.executeValidationRun({
      journey: journey!, // carries the authoritative declaration (journey-owned)
      identitySource: unauthenticated,
      environment: env,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: realPlan,
      verificationRunId: 'ver-real-1',
      projectId: 'proj-real-1',
      runId: 'run-real-browser-1',
      now: fixedClock,
    });

    // The run was admitted + completed + healthy (the real browser loaded the
    // page + the heading matched the expectation).
    expect(outcome.admitted).toBe(true);
    expect(outcome.run).not.toBeNull();
    expect(outcome.run!.status).toBe('completed');
    expect(outcome.run!.outcome!.kind).toBe('healthy');

    // Every captured observation carries the full provenance chain.
    for (const obs of outcome.run!.observations) {
      expect(obs.provenance.runId).toBe('run-real-browser-1');
      expect(obs.provenance.journeyId).toBe('journey-real-browser-sign-in');
      expect(obs.provenance.stepId).toBe('step-open');
      expect(obs.provenance.environmentId).toBe('env-real-browser-test');
      // observedAt is a real ISO timestamp (the real browser captured it).
      expect(obs.provenance.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }

    // The evidence mapping into /verification ran once (claim authority).
    expect(verification!.recordedAttachCalls).toHaveLength(1);
    expect(verification!.recordedAttachCalls[0]!.result).toBe('pass'); // healthy → pass
    expect(verification!.recordedAttachCalls[0]!.evidenceType).toBe('continuous_validation');
    expect(verification!.recordedAttachCalls[0]!.provider).toBe('agent');

    // The evidence reference binds back to the existing authority's row.
    expect(outcome.evidenceReference).not.toBeNull();
    expect(outcome.evidenceReference!.verificationEvidenceAuthority).toBe('claim');
    expect(outcome.evidenceReference!.outcomeKind).toBe('healthy');
  }, 60_000);

  it.skipIf(skipped)('a selector miss against a REAL browser → validation_failure (actual: null, never healthy)', async () => {
    const missingPlan = defineBrowserJourneyPlan(
      {
        journeyId: journey!.id,
        steps: [
          {
            stepId: 'step-open',
            actions: [
              { kind: 'navigate', url: `${baseUrl}/sign-in`, satisfiesObservationId: 'obs-status' },
              { kind: 'extract', selector: 'h1.nonexistent', satisfiesObservationId: 'obs-heading' },
            ],
          },
        ],
      },
      journey!,
    );

    const outcome = await agent!.executeValidationRun({
      journey: journey!, // carries the authoritative declaration (journey-owned)
      identitySource: unauthenticated,
      environment: env,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      plan: missingPlan,
      verificationRunId: 'ver-real-2',
      projectId: 'proj-real-2',
      runId: 'run-real-browser-miss',
      now: fixedClock,
    });

    expect(outcome.run!.outcome!.kind).toBe('validation_failure');
    if (outcome.run!.outcome!.kind === 'validation_failure') {
      const headingFailure = outcome.run!.outcome!.failures.find((f) => f.expected.id === 'obs-heading');
      expect(headingFailure).toBeDefined();
      expect(headingFailure!.actual).toBeNull(); // selector miss → explicit missing → never healthy
    }
  }, 60_000);
});
