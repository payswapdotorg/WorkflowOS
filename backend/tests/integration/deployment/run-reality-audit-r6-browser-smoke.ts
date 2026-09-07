/**
 * V2-REALITY-AUDIT-001-R6 — the FULL-MATRIX REPEAT-AUDIT browser runner
 * (deterministic proof over the REAL deployment entry + the REAL product
 * SPA + a REAL browser, at the exact merged main head that carries ALL
 * NINE REALITY-REPAIRS).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/
 * V2-REALITY-AUDIT-001-R6.md — the FINAL-GATE repeat audit after
 * REALITY-REPAIR-001..009 all merged. THIS RUNNER IS THE R6
 * REQUIRED-EVIDENCE PRODUCER: the Work Order's evidence list ("fresh exact
 * main head; real deployment topology; real browser transcript; journey
 * matrix with pass/fail/blocked/unavailable status; evidence hashes; exact
 * comparison against R0-R4 findings; explicit confirmation that no
 * critical mismatch remains") is produced by an orchestrator run of this
 * file at the exact head (port discipline: the specialist authored it and
 * did NOT run it).
 *
 * Baselines compared against:
 *   - docs/v2/V2-REALITY-AUDIT-001-WORKER-REPORT.md (the R0-R4 matrix)
 *   - docs/v2/V2-REALITY-AUDIT-001-ARCHITECT-DISPOSITION.md (F-001..F-010)
 *
 * HONEST INVENTORY NOTE: the R0-R4 report's summary row says "41 journeys
 * (31 pass / 4 fail / 3 blocked / 3 expected-unavailable)" while its own
 * matrix table enumerates 48 journey rows (the summary arithmetic does not
 * add up to the table). The auditable inventory is the TABLE's journey-id
 * enumeration, so this runner re-runs the COMPLETE matrix — every journey
 * id the R0-R4 table lists (DEP-1, AUTH-1..6, HOME-1..5, CREATE-1..3,
 * MKT-1..6, LIB-1..3, DET-1..2, RUN-1..5, WHEN-1, TEACH-1..4, VER-1..3,
 * ACT-1..3, EXPERT-1..3, RESP-1, NET-1, COMP-1 — 48 records) — with the
 * POST-REPAIR expectations (the nine merged repairs changed what "correct"
 * looks like for the previously failing journeys).
 *
 * Topology (the REAL one — identical to the repair smoke family):
 *   - the backend is the REAL deployment entrypoint spawned as a process:
 *     `bun src/index.ts` (the docker-compose CMD) on the WORK-071 pglite
 *     dev runtime (real PostgreSQL-WASM DatabaseClient + the SAME
 *     migrations as production), WORKFLOWOS_ROLE=all, a fresh temp data
 *     directory, listening on :3001 (the Vite dev proxy's fixed target);
 *   - the frontend is the ACTUAL Vite dev server serving the product SPA
 *     on :5188 (its /api proxy targets :3001 exactly as deployed);
 *   - the browser is a REAL headless Chromium (Playwright), 1280x800
 *     primary + a 390x844 leg for RESP-1.
 *
 * Personas (through real routes only — no direct DB writes, no second
 * authority):
 *   - the PUBLISHER is seeded through the REAL HTTP routes: register →
 *     login → org → public approval-gated workflow v1 (collect_posts →
 *     scan_board → review_gate → send_report, + log_rejection so the IR
 *     parser's uncovered-outcome fail-close is satisfied) → a published
 *     ONE-TIME-PRICED listing ($19.00, pinned_only — the deterministic
 *     reference payment adapter settles the charge on this topology) →
 *     plus an own-org installation, deployment + daily subscription and a
 *     started run so DET-1's own-org surface has real content. The
 *     publisher later ships v2 (the task-text change — task-surface
 *     EQUIVALENT) and v3 (the step-input literal change — task-surface
 *     NON-equivalent, exactly the R0-R4 VER-2/F-010 divergence shape)
 *     through the REAL owner-only createVersion route.
 *   - the CONSUMER/AUDITOR does EVERYTHING through the real browser UI —
 *     signup included: the fresh-user Home, the no-org marketplace
 *     onboarding (MKT-3/F-002), the purchase (MKT-4), the install
 *     (MKT-5), the cross-org detail (DET-2/F-003), the run lifecycle
 *     controls (RUN-4/F-008), the schedule (WHEN-1), the lesson
 *     (TEACH-1..4/F-009), the update review + adoption (VER-1..3/F-010),
 *     the fork (MKT-6), the expert IR authoring (CREATE-3/RR-004), the
 *     project creation (EXPERT-2), responsive (RESP-1), offline (NET-1)
 *     and the companion handoff (COMP-1).
 *
 * THE JOURNEY MATRIX — every R0-R4 journey id, with the POST-REPAIR
 * expectation (the merged repairs' own evidence wording):
 *   DEP-1   the real entry serves the V2 product routes (F-001/RR-001):
 *           /health 200, /health/ready 200, POST /auth/password/register
 *           201, and — after a real login — auth-gated 200s for one read
 *           per V2 product route group (the exact RR-001 integration-test
 *           route list: V2-002 workflows + public workflow/versions reads,
 *           V2-005 runs, V2-009 deployments, V2-006 teaching sessions,
 *           V2-010 reverse teaching, V2-011 optimization analyze+proposals,
 *           V2-012 marketplace listings). The R0-R4 probe log's 404s were
 *           composition probes of these route groups (their literal
 *           shorthand paths were never real routes); the composition proof
 *           is the route-group 200s + GET /marketplace/listings answering
 *           401-when-unauthenticated (not the pre-repair 404).
 *   AUTH-1  register through the real UI → Home.
 *   AUTH-2  Sign Out → the login screen.
 *   AUTH-3  sign in with the password → Home.
 *   AUTH-4  wrong password → "Invalid email or password." (honest error).
 *   AUTH-5  duplicate registration → "An account with this email already
 *           exists. Try signing in." (honest error).
 *   AUTH-6  session survives reload.
 *   HOME-1  the goal/search entry renders (Tell / Show / Tell + Show).
 *   HOME-2  honest empty states on the attention surfaces when empty.
 *   HOME-3  (F-005/RR-005) Pending approvals COMPOSES real approvals
 *           content: a paused-at-approval run appears as "Waiting for you"
 *           + the workflow name + "Open the run" — no false "not part of
 *           the product" claim.
 *   HOME-4  (F-005/RR-005) Updates COMPOSES versions/installations reads:
 *           an installed-behind-head workflow appears ("Update available",
 *           "Version 3 is available — your installed Version 1 stays
 *           pinned", "Open the workflow").
 *   HOME-5  (F-006 — assert AS-IS) Device issues REMAINS honestly
 *           unavailable ("Unavailable" + the device-status deferral
 *           sentence) — an EXPECTED_UNAVAILABLE pass, never a fail.
 *   CREATE-1 (F-004a/RR-004) Tell capture → preview → the corrected honest
 *           copy ("Natural-language capture isn't converted into
 *           executable WorkflowIR — no generation authority exists — so
 *           nothing is created from this page", "Durable creation isn't
 *           available for captured input", "Nothing is committed"), NO
 *           false promise, and ZERO create POSTs leave the flow.
 *   CREATE-2 Show capture: the honest no-recording note + steps → preview.
 *   CREATE-3 Tell+Show combined capture, the same boundary, PLUS the
 *           RR-004 expert IR authoring leg: the boundary's expert entry
 *           leads to /expert, the expert authors a REAL WorkflowIR through
 *           the V2-002 create path, and the created workflow appears in
 *           the consumer's library ("born with immutable version 1").
 *   MKT-1   Explore browse: the listing card renders (name, $19.00,
 *           One-time purchase, "Listed by another organization", Version 1,
 *           the publication-is-not-proof sentence).
 *   MKT-2   listing detail: the full §22 disclosure (Offers + the
 *           entitlement boundary, Needs access to incl. the SENSITIVE
 *           messaging.send flag + line, Works with, Version and trust).
 *   MKT-3   (F-002/RR-002) a NO-ORG session at the listing gets the
 *           first-run onboarding flow (the "Organization onboarding"
 *           region inside Your access — no perpetual "Checking your
 *           access…"); the org is created through the real UI and the
 *           per-org decision resolves (the honest "This listing has no
 *           free offer." denial for the unpurchased one-time listing).
 *   MKT-4   purchase with org: "Get workflow" → the real acceptance →
 *           "You're entitled to this workflow." + "Access through your
 *           one-time purchase."
 *   MKT-5   install pinned version: "Installed — pinned to version 1" +
 *           the execution-separate sentence + "Open in your Workflows
 *           library".
 *   MKT-6   fork with provenance: "Make it my own" → name → "Create copy"
 *           → "Open your copy"; the copy's forkedFrom* provenance verified
 *           through the real read.
 *   LIB-1   My Workflows cards with facts (the fork + the expert-authored
 *           workflow: name, Last run, schedule word, Open).
 *   LIB-2   (F-007/RR-006) the Installed tab shows the workflow's REAL
 *           name (never the generic "Installed workflow" fallback) + the
 *           pinned facts + the Open link.
 *   LIB-3   Drafts / Archived honestly unavailable ("Unavailable" + the
 *           draft/archived deferral sentences) — EXPECTED_UNAVAILABLE.
 *   DET-1   own-org workflow detail full surface: the consumer's fork
 *           (heading, description, Private line, steps, When/Where,
 *           Recent activity, Version, Access and safety, Updates,
 *           Improvements, primary actions) AND the publisher's own-org
 *           detail with real content (the seeded run + deployment +
 *           installation: "Runs every day · 9:00 AM UTC", Recent activity,
 *           the installation pin).
 *   DET-2   (F-003/RR-003) the INSTALLED cross-org workflow detail LOADS
 *           (heading, description, Public line, steps, the consumer's
 *           installation pin, honest no-facts states, no honest-error
 *           state) and ZERO publisher-org-scoped requests fire (the
 *           browser's own network capture; the caller-org reads are
 *           present instead).
 *   RUN-1   run preview → request → start: the consequential preview
 *           (steps, Version 1, "Approval required", Needs access to,
 *           "Where it runs isn't set up yet") → confirm → Running.
 *   RUN-2   Running + trust disclosure: "How do you know?" + "No evidence
 *           records yet for this run." + the Advanced details surface.
 *   RUN-3   run state survives reload (Running retained).
 *   RUN-4   (F-008/RR-007) the USER drives the run lifecycle: Pause →
 *           Paused; Resume → Running; the executor-side pause at the IR
 *           approval node → reload → "Waiting for you" + the Approve
 *           control; the user's Approve returns the run to execution
 *           (history-verified); the Pause/Stop controls are reachable
 *           (Stop opens the §2.4 explicit choice; "Keep it going"
 *           preserves the run).
 *   RUN-5   failure presentation + recovery: the executor-side fail →
 *           "Couldn't complete" + the recovery surface (the reason
 *           verbatim, "Try again", "Edit workflow") → "Try again" starts a
 *           new run.
 *   WHEN-1  schedule editor save: "Runs every day · 9:00 AM UTC" + Pause;
 *           the deployment + subscription created (verified through the
 *           real reads).
 *   TEACH-1 lesson + checkpoints + pause/resume: Start lesson → the steps
 *           ("I've done it" × the lesson length, a Pause → Resume in the
 *           middle) → "All steps confirmed".
 *   TEACH-2 (F-009/RR-008) practice feedback references the CORRECT step:
 *           the attempted question's own verbatim feedback (the authority
 *           template names the ATTEMPTED step); the other question's
 *           section carries NO feedback; the correct answer's feedback
 *           names its own step; the wire carries the attempted nodeId.
 *   TEACH-3 assessment → "Lesson complete" (terminal, no controls remain).
 *   TEACH-4 teaching evidence visibly separate from run evidence
 *           ("Teaching evidence" + "Kept separate from run evidence —
 *           learning never counts as execution").
 *   VER-1   update banner with pin language ("An update is available",
 *           Version 2, "Your installed version: Version 1 — pinned",
 *           "Nothing changes until you approve the update").
 *   VER-2   (F-010/RR-009) Review update / What changed: the EQUIVALENT
 *           path stays "Task-for-task equivalent - verified" (the v2
 *           task-text fixture) AND the NON-EQUIVALENT path renders the
 *           HUMAN-READABLE version diff (the v3 step-input fixture): the
 *           honest "Not equivalent" verdict, the step NAME (the
 *           presentation label — never the raw node id), the field ("its
 *           inputs"), the readable values, NO raw internal JSON envelope —
 *           while the authoritative comparison payload remains on the wire
 *           (the browser's own network capture). BOTH postures are
 *           asserted so the human-readable diff shows real changed fields
 *           (the v3 divergence) with the equivalence regression held.
 *   VER-3   approve update → new pin: "You're on the newest version." +
 *           "Installed: Version 3 — pinned · Enabled".
 *   ACT-1   activity timeline entries + run deep link (version entries +
 *           run entries + "Open the run").
 *   ACT-2   activity → run deep link: /workflows/:id?run=:runId shows the
 *           run-status surface.
 *   ACT-3   teaching/device honestly unavailable on Activity (the
 *           disclosure sentence) — EXPECTED_UNAVAILABLE.
 *   EXPERT-1 the expert bridge renders (the "Developer workspace" bridge
 *           card + the mode-crossing disclosure + "Open developer
 *           workspace").
 *   EXPERT-2 project creation through the real UI (New Project → the form
 *           → Create → the project Overview renders).
 *   EXPERT-3 the engineering surfaces load against the REAL entry (the
 *           V1 engineering routes always existed there — R0-R4's BLOCKED
 *           was a product-test-composition artifact): the project Overview
 *           consumes /projects/:id + /projects/:id/architectures and the
 *           architect surface renders with NO "Error: Not found".
 *   RESP-1  390x844: Home/Detail/Create/Explore render with no horizontal
 *           overflow and the mobile primary nav present.
 *   NET-1   offline in-app navigation → honest degraded states per surface
 *           ("Couldn't load this right now." / "Listings are unavailable" /
 *           "Workflows unavailable — couldn't load the workflow list." /
 *           "Couldn't load this workflow right now." — each with Try
 *           again) + honest recovery once back online.
 *   COMP-1  companion handoff deep link → the honest bridge ("Companion
 *           not installed" + the instruction card).
 *
 * Matrix emission: journey.json (this directory) carries one record per
 * journey — { id, journey, expected, observed, status } with status ∈
 * PASS | FAIL | BLOCKED | EXPECTED_UNAVAILABLE — plus the transcript and
 * every screenshot's sha-256 digest; the full matrix table is printed to
 * stdout at the end. Exit code 0 ONLY if every journey record is PASS or
 * EXPECTED_UNAVAILABLE and the complete inventory ran; non-zero otherwise
 * (the failing journey ids printed).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-audit-r6-browser-smoke.ts
 * (the orchestrator's run at the exact head produces the required R6
 * evidence; the runner clears this directory of .png/.json first).
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page, type BrowserContext, type Response } from '@playwright/test';
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
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
  'reality-audit-r6',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const PUBLISHER_NAME = 'Paula (R6 publisher)';
const PUBLISHER_EMAIL = 'reality-audit-r6-publisher@deployment.test';
const PUBLISHER_PASSWORD = 'the-reality-audit-publisher-42';
const PUBLISHER_ORG_NAME = 'R6 Publisher Org';

const CONSUMER_NAME = 'Noor (R6 consumer/auditor)';
const CONSUMER_EMAIL = 'reality-audit-r6-consumer@deployment.test';
const CONSUMER_PASSWORD = 'the-reality-audit-consumer-42';
const CONSUMER_ORG_NAME = 'Noor Audit Org';

const WORKFLOW_NAME = 'R6 audit approval digest';
const WORKFLOW_DESCRIPTION =
  'Collect the open tickets, scan the board for the digest, wait for your approval, then email it.';
const WORKFLOW_SLUG = 'reality-audit-r6-approval-digest';
const LISTING_NAME = 'R6 audit one-time listing';
const LISTING_DESCRIPTION = 'The R6 repeat-audit representative published listing.';
const FORK_NAME = 'My R6 audit copy';

const EXPERT_WORKFLOW_NAME = 'R6 audit expert digest';
const EXPERT_WORKFLOW_DESCRIPTION = 'The R6 audit expert-authored digest workflow.';
const EXPERT_WORKFLOW_SLUG = 'reality-audit-r6-expert-digest';

const PROJECT_NAME = 'R6 Audit Project';

/** The audit topology's node ids / labels / declared semantics (the R6 fixture). */
const COLLECT_NODE_ID = 'collect_posts';
const SCAN_NODE_ID = 'scan_board';
const REVIEW_NODE_ID = 'review_gate';
const SEND_NODE_ID = 'send_report';
const REJECT_NODE_ID = 'log_rejection';
const APPROVAL_STEP_ID = REVIEW_NODE_ID; // the IR approval node the waiting legs pause at

const COLLECT_LABEL = 'Collect the open tickets';
const SCAN_LABEL = 'Scan the board for the digest';
const REVIEW_LABEL = 'Your approval before sending';
const SEND_LABEL = 'Email the digest';
const REJECT_LABEL = 'Log the rejection';

const COLLECT_SEMANTICS = 'github.repository.read';
const SEND_SEMANTICS = 'messaging.send';
const V1_SCAN_TASK = 'Scan the board and summarize the open tickets (v1).';
const V2_SCAN_TASK = 'Scan the board and summarize the open tickets (v2: a faster, focused scan).';
const REVIEW_INSTRUCTION = 'Approve the digest before it is sent.';

/** The authority's own fixed practice-feedback templates (V2-006/RR-008). */
const collectCorrectFeedback = `Correct: the workflow declares exactly this semantics for step "${COLLECT_NODE_ID}".`;
const sendIncorrectFeedback = `Not the workflow declaration for step "${SEND_NODE_ID}". The workflow declares: "${SEND_SEMANTICS}". (The correction quotes the workflow own declared semantics.)`;

/** The v1/v3 input literals (the RR-009 divergence shape, on collect_posts). */
const V1_REPOSITORY = 'payswapdotorg/WorkflowOS';
const V3_REPOSITORY = 'pectoraux/WorkflowOS';

/** The lesson's canonical order (Kahn topological + sorted ready set). */
const LESSON_ORDER = [COLLECT_NODE_ID, SCAN_NODE_ID, REVIEW_NODE_ID, REJECT_NODE_ID, SEND_NODE_ID];
const LESSON_LABELS: Record<string, string> = {
  [COLLECT_NODE_ID]: COLLECT_LABEL,
  [SCAN_NODE_ID]: SCAN_LABEL,
  [REVIEW_NODE_ID]: REVIEW_LABEL,
  [REJECT_NODE_ID]: REJECT_LABEL,
  [SEND_NODE_ID]: SEND_LABEL,
};
/** Each step's declared semantics (the exact assessment tokens — v1 pin). */
const LESSON_SEMANTICS: Record<string, string> = {
  [COLLECT_NODE_ID]: COLLECT_SEMANTICS,
  [SCAN_NODE_ID]: V1_SCAN_TASK,
  [REVIEW_NODE_ID]: REVIEW_INSTRUCTION,
  [REJECT_NODE_ID]: COLLECT_SEMANTICS,
  [SEND_NODE_ID]: SEND_SEMANTICS,
};

interface TranscriptEntry {
  at: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'INFO';
  ms: number;
  detail?: string;
}

type JourneyStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'EXPECTED_UNAVAILABLE';

interface JourneyRecord {
  id: string;
  journey: string;
  expected: string;
  observed: string;
  status: JourneyStatus;
}

const transcript: TranscriptEntry[] = [];
const artifacts: Array<{ file: string; sha256: string; bytes: number }> = [];
const matrix: JourneyRecord[] = [];
const startedAt = new Date();

/**
 * The COMPLETE R0-R4 journey inventory (see the header's honest inventory
 * note): the matrix table's own id enumeration — DEP-1, AUTH-1..6,
 * HOME-1..5, CREATE-1..3, MKT-1..6, LIB-1..3, DET-1..2, RUN-1..5, WHEN-1,
 * TEACH-1..4, VER-1..3, ACT-1..3, EXPERT-1..3, RESP-1, NET-1, COMP-1.
 */
const EXPECTED_JOURNEY_COUNT = 48;

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

/**
 * One R6 journey: a step() (the family's transcript discipline) PLUS the
 * matrix record. On success the record carries the observed facts; on
 * failure the record is FAIL with the error detail and the error
 * propagates (the family's fail-fast discipline — later legs depend on
 * earlier ones, so a cascade of secondary failures would obscure the
 * primary one).
 */
async function journey<T>(
  id: string,
  journeyName: string,
  expected: string,
  observedOnPass: (result: T) => string,
  statusOnPass: JourneyStatus,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await step(`${id} ${journeyName}`, fn);
    matrix.push({ id, journey: journeyName, expected, observed: observedOnPass(result), status: statusOnPass });
    return result;
  } catch (err) {
    matrix.push({
      id,
      journey: journeyName,
      expected,
      observed: err instanceof Error ? `${err.name}: ${err.message.split('\n').slice(0, 4).join(' | ')}` : String(err),
      status: 'FAIL',
    });
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
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-audit-r6/${name}`,
    sha256: sha,
    bytes: stat.size,
  });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
}

/**
 * The R6 audit fixture: collect (API — the input literal that changes in
 * v3) → scan (AGENTIC — the task text that changes in v2, task-surface
 * EQUIVALENT) → review (the IR approval node — the RUN-4 gate) → send
 * (API, the SENSITIVE messaging.send) + log_rejection (the rejected
 * continuation the IR parser's uncovered-outcome fail-close requires —
 * the RR-005/RR-007 family's proven seed shape).
 */
function authorAuditWorkflow(scanTask: string, repository: string): WorkflowIrDocument {
  const collectPosts: WorkflowNode = {
    id: COLLECT_NODE_ID,
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: COLLECT_SEMANTICS },
    capabilityRequirements: [COLLECT_SEMANTICS],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'repository',
        type: { kind: 'string' },
        binding: { kind: 'literal', value: repository },
      },
    ],
    outputs: [{ name: 'tickets', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const scanBoard: WorkflowNode = {
    id: SCAN_NODE_ID,
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: scanTask },
    capabilityRequirements: [COLLECT_SEMANTICS],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'tickets',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: COLLECT_NODE_ID, output: 'tickets' },
      },
    ],
    outputs: [{ name: 'digest', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
    completionEvidence: 'verification',
  };
  const reviewGate: WorkflowNode = {
    id: REVIEW_NODE_ID,
    executionClass: 'human',
    spec: {
      class: 'human',
      human: { kind: 'approval', instruction: REVIEW_INSTRUCTION },
    },
    capabilityRequirements: [],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'digest',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: SCAN_NODE_ID, output: 'digest' },
      },
    ],
    outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'human_confirmation',
  };
  const sendReport: WorkflowNode = {
    id: SEND_NODE_ID,
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: SEND_SEMANTICS },
    capabilityRequirements: [SEND_SEMANTICS],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: SCAN_NODE_ID, output: 'digest' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  // The approval node's declared 'rejected' outcome must be covered (the
  // IR parser fail-closes an uncovered outcome — the RR-007 correction).
  const logRejection: WorkflowNode = {
    id: REJECT_NODE_ID,
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: COLLECT_SEMANTICS },
    capabilityRequirements: [COLLECT_SEMANTICS],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'literal', value: 'digest rejected' },
      },
    ],
    outputs: [{ name: 'logged', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart(COLLECT_NODE_ID)
    .addNode(collectPosts)
    .addNode(scanBoard)
    .addNode(reviewGate)
    .addNode(sendReport)
    .addNode(logRejection)
    .addEdge({ from: COLLECT_NODE_ID, to: SCAN_NODE_ID, on: 'success' })
    .addEdge({ from: SCAN_NODE_ID, to: REVIEW_NODE_ID, on: 'success' })
    .addEdge({ from: REVIEW_NODE_ID, to: SEND_NODE_ID, on: { outcome: 'approved' } })
    .addEdge({ from: REVIEW_NODE_ID, to: REJECT_NODE_ID, on: { outcome: 'rejected' } })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: SEND_NODE_ID, output: 'messageId' },
    })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withPresentation({
      title: WORKFLOW_NAME,
      nodeLabels: {
        [COLLECT_NODE_ID]: COLLECT_LABEL,
        [SCAN_NODE_ID]: SCAN_LABEL,
        [REVIEW_NODE_ID]: REVIEW_LABEL,
        [SEND_NODE_ID]: SEND_LABEL,
        [REJECT_NODE_ID]: REJECT_LABEL,
      },
    })
    .build();
}

/** The RR-004 expert-authoring fixture (the consumer's own-org workflow). */
function authorExpertWorkflow(): WorkflowIrDocument {
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
      title: EXPERT_WORKFLOW_NAME,
      nodeLabels: {
        fetch_tickets: 'Collect the fresh tickets',
        send_digest: 'Email the digest, sorted',
      },
    })
    .build();
}

interface SeedFacts {
  listingId: string;
  workflowId: string;
  version1Id: string;
  publisherOrgId: string;
  publisherCookie: string;
  publisherInstallationId: string;
}

/** A JSON call against the REAL entry (the seed/command channel — same session cookie). */
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

/** The session cookie of a Playwright browser context (the REAL session). */
async function sessionToken(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(FRONTEND_URL);
  return cookies.find((c) => c.name === 'wfos_session')?.value ?? '';
}

/** The command envelope (the deterministic idempotency identity). */
function envelope(): { commandId: string; correlationId: string } {
  return { commandId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
}

/** The executor-side pause AT the approval node (the t6/RR-005 pattern). */
async function pauseAtApproval(token: string, runId: string): Promise<void> {
  const res = await api(token, 'POST', `/workflow-runs/runs/${runId}/pause`, {
    ...envelope(),
    atStepId: APPROVAL_STEP_ID,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

/** The executor-side failure report (the R0-R4 RUN-5 out-of-band fixture). */
async function failRun(token: string, runId: string, reason: string): Promise<void> {
  const res = await api(token, 'POST', `/workflow-runs/runs/${runId}/fail`, {
    ...envelope(),
    reason,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

/** The reconstructed history of one run (the V2-005 read). */
async function runHistory(token: string, runId: string): Promise<{
  run: { state: string };
  timeline: Array<{ eventName: string; detail: Record<string, unknown> | null; sequence: number }>;
}> {
  const res = await api(token, 'GET', `/workflow-runs/runs/${runId}/history`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
}

/** The consumer's newest run of THIS workflow (the authoritative runs read). */
async function newestRun(
  token: string,
  orgId: string,
  workflowId: string,
): Promise<{ id: string; state: string }> {
  const runs = await api(token, 'GET', `/organizations/${orgId}/workflow-runs/runs`);
  expect(runs.status).toBe(200);
  const mine = ((runs.json.runs as Array<{ id: string; workflowId: string; state: string; updatedAt: string }>) ?? [])
    .filter((r) => r.workflowId === workflowId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  expect(mine.length, 'no run of the workflow in the consumer org').toBeGreaterThan(0);
  return mine[0]!;
}

/** The practice-question section whose prompt names `nodeId` (the RR-008 locator). */
function practiceSection(page: Page, nodeId: string) {
  return page
    .getByRole('region', { name: 'Practice' })
    .filter({ hasText: `assign to step "${nodeId}"` });
}

async function main(): Promise<number> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  for (const entry of readdirSync(ARTIFACTS_DIR)) {
    if (entry.endsWith('.png') || entry.endsWith('.json')) {
      rmSync(join(ARTIFACTS_DIR, entry));
    }
  }

  info(`V2-REALITY-AUDIT-001-R6 full-matrix repeat-audit browser runner starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-audit-r6-pglite-'));
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
    const seed = await step('seed: publisher register → login → org → public approval-gated workflow → one-time-priced listing → publish → own-org installation + deployment + subscription + started run (REAL routes; the consumer gets NOTHING pre-seeded)', async () => {
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
        slug: WORKFLOW_SLUG,
        name: WORKFLOW_NAME,
        description: WORKFLOW_DESCRIPTION,
        visibility: 'public', // public: the marketplace publish precondition
        content: versionContentOf(authorAuditWorkflow(V1_SCAN_TASK, V1_REPOSITORY)),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      });
      expect(wf.status, JSON.stringify(wf.json)).toBe(201);
      const workflowId = wf.json.workflow.id as string;
      const version1Id = wf.json.initialVersion.id as string;

      // The published ONE-TIME-PRICED listing ($19.00, pinned_only): the
      // consumer's purchase path exercises the REAL offer-acceptance command
      // (settled by the deployment composition's deterministic reference
      // payment adapter — no real provider on this topology, honestly so).
      const listing = await api(cookie, 'POST', '/marketplace/listings', {
        organizationId: orgId,
        workflowId,
        versionId: version1Id,
        name: LISTING_NAME,
        description: LISTING_DESCRIPTION,
        offers: [
          {
            model: 'one_time_purchase',
            terms: {
              model: 'one_time_purchase',
              amount: '19.00',
              currency: 'USD',
              updatePolicy: 'pinned_only',
            },
          },
        ],
      });
      expect(listing.status, JSON.stringify(listing.json)).toBe(201);
      const listingId = listing.json.listing.id as string;
      // The create response carries the revision (with its offers) — the
      // one-time offer the consumer will accept through the real UI.
      const offerId = (listing.json.revision.offers as Array<{ id: string }>)[0]?.id ?? '';
      expect(offerId).not.toBe('');

      const publish = await api(cookie, 'POST', `/marketplace/listings/${listingId}/publish`);
      expect(publish.status, JSON.stringify(publish.json)).toBe(200);

      // The publisher's OWN-ORG content (the dispatch's requirement: DET-1's
      // own-org surface needs a real run + deployment): the installation
      // (also the DEP-1 reverse-teaching probe's input), the deployment +
      // daily 09:00 UTC subscription (the same wire the When editor sends),
      // and a requested+started run.
      const installation = await api(cookie, 'POST', `/organizations/${orgId}/workflow-repository/installations`, {
        workflowId,
        versionId: version1Id,
      });
      expect(installation.status, JSON.stringify(installation.json)).toBe(201);
      const installationId = installation.json.installation.id as string;

      const deployment = await api(cookie, 'POST', `/organizations/${orgId}/workflow-deployments/deployments`, {
        workflowId,
        versionId: version1Id,
        name: WORKFLOW_NAME,
        placement: { placement: { required: 'any_supported_node' }, privacy: { localOnly: false } },
      });
      expect(deployment.status, JSON.stringify(deployment.json)).toBe(201);
      const deploymentId = deployment.json.deployment.id as string;

      const subscription = await api(cookie, 'POST', `/workflow-deployments/deployments/${deploymentId}/subscriptions`, {
        kind: 'schedule',
        schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
        enabled: true,
      });
      expect(subscription.status, JSON.stringify(subscription.json)).toBe(201);

      const run = await api(cookie, 'POST', `/organizations/${orgId}/workflow-runs/runs`, {
        ...envelope(),
        workflowId,
        versionId: version1Id,
        installationId,
        trigger: { type: 'manual', id: crypto.randomUUID() },
        inputCommitments: [],
      });
      expect(run.status, JSON.stringify(run.json)).toBe(201);
      const publisherRunId = run.json.run.id as string;
      const start = await api(cookie, 'POST', `/workflow-runs/runs/${publisherRunId}/start`, envelope());
      expect(start.status, JSON.stringify(start.json)).toBe(200);
      expect((start.json.run as { state: string }).state).toBe('running');

      return {
        listingId,
        workflowId,
        version1Id,
        publisherOrgId: orgId,
        publisherCookie: cookie,
        publisherInstallationId: installationId,
      } satisfies SeedFacts;
    });

    // ---- 4. DEP-1: the real entry serves the V2 product route groups ---------
    await journey<void>(
      'DEP-1',
      'the real deployment entry serves the V2 product routes (F-001/RR-001)',
      'the real entry: /health 200, /health/ready 200, POST /auth/password/register 201, and after a real login an auth-gated 200 for one read per V2 product route group (the RR-001 route list); GET /marketplace/listings answers 401-not-404 unauthenticated',
      () =>
        'health 200; health/ready 200; register 201; auth-gated 200s: V2-002 org workflows read, public workflow read, versions read, V2-005 runs read, V2-009 deployments read, V2-006 teaching session create+read, V2-010 reverse-teaching session create+read, V2-011 analyze+proposals, V2-012 marketplace listings; unauthenticated GET /marketplace/listings 401-not-404',
      'PASS',
      async () => {
        // The R0-R4 live probe log's health + identity probes.
        const health = await api('', 'GET', '/health');
        expect(health.status).toBe(200);
        const ready = await api('', 'GET', '/health/ready');
        expect(ready.status).toBe(200);

        // The composition probe: the marketplace listing route answers
        // 401-when-unauthenticated (at R0-R4 base the whole group 404'd).
        const unauthListings = await fetch(`http://127.0.0.1:${BACKEND_PORT}/marketplace/listings`, {
          signal: AbortSignal.timeout(5000),
        });
        expect(unauthListings.status).toBe(401);

        // The exact RR-001 route list, auth-gated through the publisher's
        // real session (the four R0-R4 release-blocker route groups and
        // every other group).
        const cookie = seed.publisherCookie;
        const orgId = seed.publisherOrgId;

        // V2-002 — the workflow repository (the R0-R4 /workflows 404 group).
        const workflows = await api(cookie, 'GET', `/organizations/${orgId}/workflow-repository/workflows`);
        expect(workflows.status).toBe(200);
        expect(
          (workflows.json.workflows as Array<{ id: string }>).some((w) => w.id === seed.workflowId),
        ).toBe(true);

        // V2-002 — the public workflow read + the versions read (the
        // R0-R4 /workflow-versions 404 group).
        const wfRead = await api(cookie, 'GET', `/workflow-repository/workflows/${seed.workflowId}`);
        expect(wfRead.status).toBe(200);
        expect(wfRead.json.workflow.id).toBe(seed.workflowId);
        const versions = await api(cookie, 'GET', `/workflow-repository/workflows/${seed.workflowId}/versions`);
        expect(versions.status).toBe(200);
        expect(Array.isArray(versions.json.versions)).toBe(true);

        // V2-005 — the runs read (the R0-R4 /runs 404 group).
        const runs = await api(cookie, 'GET', `/organizations/${orgId}/workflow-runs/runs`);
        expect(runs.status).toBe(200);
        expect(
          ((runs.json.runs as Array<{ id: string }>) ?? []).some((r) => r.id.length > 0),
        ).toBe(true);

        // V2-009 — the deployments read.
        const deployments = await api(cookie, 'GET', `/organizations/${orgId}/workflow-deployments/deployments`);
        expect(deployments.status).toBe(200);
        expect(Array.isArray(deployments.json.deployments)).toBe(true);

        // V2-006 — teaching sessions: create + read over the real pin.
        const teach = await api(cookie, 'POST', '/teaching-sessions/sessions', {
          workflowId: seed.workflowId,
          versionId: seed.version1Id,
        });
        expect(teach.status, JSON.stringify(teach.json)).toBe(201);
        const teachSessionId = teach.json.session.id as string;
        const teachRead = await api(cookie, 'GET', `/teaching-sessions/sessions/${teachSessionId}`);
        expect(teachRead.status).toBe(200);
        expect(teachRead.json.session.id).toBe(teachSessionId);

        // V2-010 — reverse teaching: create + read over the real pin.
        const reverse = await api(cookie, 'POST', '/reverse-teaching/sessions', {
          organizationId: orgId,
          workflowId: seed.workflowId,
          versionId: seed.version1Id,
          installationId: seed.publisherInstallationId,
        });
        expect(reverse.status, JSON.stringify(reverse.json)).toBe(201);
        const reverseSessionId = reverse.json.session.id as string;
        const reverseRead = await api(cookie, 'GET', `/reverse-teaching/sessions/${reverseSessionId}`);
        expect(reverseRead.status).toBe(200);
        expect(reverseRead.json.session.id).toBe(reverseSessionId);

        // V2-011 — optimization: analyze + the proposals read.
        const analyze = await api(cookie, 'POST', '/workflow-optimization/analyze', {
          workflowId: seed.workflowId,
          versionId: seed.version1Id,
        });
        expect(analyze.status, JSON.stringify(analyze.json)).toBe(200);
        expect(analyze.json.analysis).toBeDefined();
        const proposals = await api(
          cookie,
          'GET',
          `/workflow-optimization/proposals?workflowId=${encodeURIComponent(seed.workflowId)}`,
        );
        expect(proposals.status).toBe(200);
        expect(Array.isArray(proposals.json.proposals)).toBe(true);

        // V2-012 — the marketplace listings read (auth-gated 200).
        const listings = await api(cookie, 'GET', '/marketplace/listings');
        expect(listings.status).toBe(200);
        expect(
          (listings.json.listings as Array<{ id: string }>).some((l) => l.id === seed.listingId),
        ).toBe(true);
      },
    );

    // ---- 5. A REAL browser against the REAL topology -------------------------
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: FRONTEND_URL,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    exitCode = await auditJourney(page, seed, context, browser);
  } catch (err) {
    console.log(`\n[JOURNEY FAILED] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    const finishedAt = new Date();
    const pass = matrix.filter((r) => r.status === 'PASS').length;
    const expectedUnavailable = matrix.filter((r) => r.status === 'EXPECTED_UNAVAILABLE').length;
    const fail = matrix.filter((r) => r.status === 'FAIL').length;
    const blocked = matrix.filter((r) => r.status === 'BLOCKED').length;
    const failing = matrix.filter((r) => r.status === 'FAIL' || r.status === 'BLOCKED');
    // The exit-code discipline (the Work Order's evidence contract): 0 ONLY
    // when the COMPLETE journey inventory ran and every record is PASS or
    // EXPECTED_UNAVAILABLE — anything else (a FAIL/BLOCKED record, or an
    // incomplete matrix from an aborted journey) is a non-zero exit.
    const complete =
      matrix.length === EXPECTED_JOURNEY_COUNT &&
      new Set(matrix.map((r) => r.id)).size === EXPECTED_JOURNEY_COUNT;
    if (failing.length > 0 || !complete) {
      exitCode = 1;
    }
    const summary = {
      run: 'V2-REALITY-AUDIT-001-R6 — the full-matrix repeat-audit browser run',
      workOrder: 'spec/architecture/v2/work-orders/V2-REALITY-AUDIT-001-R6.md',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode,
      backendPort: BACKEND_PORT,
      frontendPort: FRONTEND_PORT,
      counts: {
        total: matrix.length,
        pass,
        expectedUnavailable,
        fail,
        blocked,
      },
      failingJourneys: failing.map((r) => r.id),
      journeyMatrix: matrix,
      transcript,
      artifacts,
    };
    writeFileSync(join(ARTIFACTS_DIR, 'journey.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log('\n=== THE R6 JOURNEY MATRIX (the complete R0-R4 journey inventory) ===');
    for (const rec of matrix) {
      console.log(
        `${rec.id.padEnd(9)} | ${rec.status.padEnd(20)} | ${rec.journey}`,
      );
    }
    console.log(
      `\n[MATRIX SUMMARY] total=${matrix.length} pass=${pass} expected_unavailable=${expectedUnavailable} fail=${fail} blocked=${blocked}`,
    );
    if (failing.length > 0) {
      console.log(`[FAILING JOURNEYS] ${failing.map((r) => r.id).join(', ')}`);
    }
    console.log(
      `\n[DONE] exitCode=${exitCode} duration=${summary.durationMs}ms steps=${transcript.filter((t) => t.status === 'PASS').length} passed / ${transcript.filter((t) => t.status === 'FAIL').length} failed`,
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

async function auditJourney(
  page: Page,
  seed: SeedFacts,
  context: BrowserContext,
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<number> {
  // ============ AUTH-1 — signup (the real register surface) ===================
  await journey<void>(
    'AUTH-1',
    'register through the real UI → Home',
    'account + session; lands on Home',
    () => 'registered through the real register UI; landed on Home ("What do you want to get done?")',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/`);
      await page.getByText('Create one', { exact: true }).click();
      await page.locator('#displayName').fill(CONSUMER_NAME);
      await page.locator('#email').fill(CONSUMER_EMAIL);
      await page.locator('#password').fill(CONSUMER_PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
    },
  );
  await shot(page, '01-signup-home.png');

  // ============ HOME-1 — the entry renders ====================================
  await journey<void>(
    'HOME-1',
    'goal/search entry + mode buttons',
    'entry renders with Tell/Show/Tell+Show',
    () => 'the goal/search entry renders with the Tell / Show / Tell + Show mode buttons',
    'PASS',
    async () => {
      const entry = page.getByRole('search', { name: 'Start with a goal or search' });
      await expect(entry).toBeVisible();
      await expect(entry.getByLabel('Goal or search')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Tell', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Show', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Tell + Show', exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Home attention surfaces' })).toBeVisible();
    },
  );

  // ============ HOME-2 — honest empty states (the fresh session) ==============
  await journey<void>(
    'HOME-2',
    'attention: honest empty states when empty',
    'honest empty states (the fresh zero-org session)',
    () =>
      'the fresh session renders the honest empty states: "No workflows yet…", "Nothing needs your attention right now.", "No run is waiting at an approval step right now.", "No updates available right now…"',
    'PASS',
    async () => {
      const recent = page.getByRole('region', { name: 'Recent workflows' });
      await expect(recent.getByText(/No workflows yet — the ones you create or install will appear here\./i)).toBeVisible({
        timeout: 20_000,
      });
      const attention = page.getByRole('region', { name: 'Needs attention' });
      await expect(attention.getByText(/Nothing needs your attention right now\./i)).toBeVisible();
      const approvals = page.getByRole('region', { name: 'Pending approvals' });
      await expect(approvals.getByText(/No run is waiting at an approval step right now\./i)).toBeVisible();
      const updates = page.getByRole('region', { name: 'Updates' });
      await expect(
        updates.getByText(/No updates available right now — an installed workflow stays pinned until you approve its update\./i),
      ).toBeVisible();
    },
  );
  await shot(page, '02-home-empty-attention.png');

  // ============ HOME-5 — Device issues stays honestly unavailable (F-006) ====
  await journey<void>(
    'HOME-5',
    'attention: Device issues honest unavailable (F-006 assert-as-is)',
    'honest unavailable — the deferral is the product decision, NOT a defect',
    () =>
      'the Device issues panel renders its honest Unavailable state ("Unavailable" + "…they\u2019ll appear once device status becomes part of the product") — F-006 assert-as-is, unchanged',
    'EXPECTED_UNAVAILABLE',
    async () => {
      const devices = page.getByRole('region', { name: 'Device issues' });
      await expect(devices.getByRole('status', { name: 'Unavailable' })).toBeVisible();
      await expect(devices.getByText(/device status becomes part of the product/i)).toBeVisible();
    },
  );

  // ============ AUTH-2..6 — the auth journey set ==============================
  await journey<void>(
    'AUTH-2',
    'sign out → the login screen',
    'login screen',
    () => 'Sign Out returned the consumer to the real login screen',
    'PASS',
    async () => {
      await page.getByRole('button', { name: 'Sign Out' }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
        timeout: 20_000,
      });
    },
  );

  await journey<void>(
    'AUTH-3',
    'sign in with password → Home',
    'Home',
    () => 'signed in with the password through the real login surface; landed on Home',
    'PASS',
    async () => {
      await page.locator('#email').fill(CONSUMER_EMAIL);
      await page.locator('#password').fill(CONSUMER_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
    },
  );

  await journey<void>(
    'AUTH-4',
    'wrong password → the honest error',
    '"Invalid email or password."',
    () => 'the wrong password rendered the honest error "Invalid email or password." (the uniform 401, no enumeration); the correct password then signed in',
    'PASS',
    async () => {
      await page.getByRole('button', { name: 'Sign Out' }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await page.locator('#email').fill(CONSUMER_EMAIL);
      await page.locator('#password').fill('definitely-the-wrong-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Invalid email or password.');
      // then the honest recovery: the correct password signs in.
      await page.locator('#password').fill(CONSUMER_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
    },
  );

  await journey<void>(
    'AUTH-5',
    'duplicate registration → the honest error',
    '"An account with this email already exists. Try signing in."',
    () => 'the duplicate registration rendered the honest 409 error "An account with this email already exists. Try signing in."',
    'PASS',
    async () => {
      await page.getByRole('button', { name: 'Sign Out' }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await page.getByText('Create one', { exact: true }).click();
      await page.locator('#displayName').fill(CONSUMER_NAME);
      await page.locator('#email').fill(CONSUMER_EMAIL);
      await page.locator('#password').fill(CONSUMER_PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByRole('alert')).toContainText(/An account with this email already exists\./);
      // back to sign-in mode and in.
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.locator('#email').fill(CONSUMER_EMAIL);
      await page.locator('#password').fill(CONSUMER_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
    },
  );

  await journey<void>(
    'AUTH-6',
    'session survives reload',
    'session retained (HttpOnly cookie)',
    () => 'the session survived a full page reload (still on Home behind the shell)',
    'PASS',
    async () => {
      await page.reload();
      await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible({
        timeout: 20_000,
      });
    },
  );

  // ============ MKT-1 — Explore browse ========================================
  await journey<void>(
    'MKT-1',
    'Explore browse: listing cards render',
    'card renders with price, model, publisher line, pinned version, trust sentence',
    () => 'the Explore card rendered: the listing name, $19.00 · One-time purchase, "Listed by another organization", Version 1, and the publication-is-not-proof sentence',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/explore`);
      const list = page.getByRole('list', { name: 'Marketplace listings' });
      await expect(list.getByRole('heading', { name: LISTING_NAME })).toBeVisible({
        timeout: 20_000,
      });
      await expect(list.getByText('$19.00')).toBeVisible();
      await expect(list.getByText('One-time purchase')).toBeVisible();
      await expect(list.getByText('Listed by another organization')).toBeVisible();
      await expect(list.getByText('Version 1', { exact: true })).toBeVisible();
      await expect(
        page.getByText(/Publication is not verification, authorization, or proof of safety\./),
      ).toBeVisible();
    },
  );
  await shot(page, '04-explore-cards.png');

  // ============ MKT-2 — listing detail §22 disclosure =========================
  await journey<void>(
    'MKT-2',
    'listing detail: full §22 disclosure',
    'offers + boundary, needs-access incl. the sensitive messaging.send, works-with, version-and-trust',
    () =>
      'the listing detail rendered the full §22 disclosure: $19.00 One-time purchase + the entitlement boundary, Needs access to (github.repository.read + the SENSITIVE messaging.send flag + line), Works with (cloud_allowed), Version and trust (the pinned-version + digest sentence + publication-not-proof)',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/explore/${seed.listingId}`);
      await expect(page.getByRole('heading', { name: LISTING_NAME })).toBeVisible();
      await expect(page.getByText(LISTING_DESCRIPTION)).toBeVisible();

      const offers = page.getByRole('region', { name: 'Offers' });
      await expect(offers.getByText('$19.00')).toBeVisible();
      await expect(offers.getByText('One-time purchase')).toBeVisible();
      await expect(offers.getByText(/Pins this exact version — later updates are separate\./i)).toBeVisible();
      await expect(offers.getByText(/it is not permission to run\./i)).toBeVisible();

      const needs = page.getByRole('region', { name: 'Needs access to' });
      await expect(needs.getByText('github.repository.read', { exact: true })).toBeVisible();
      await expect(needs.getByText('messaging.send', { exact: true })).toBeVisible();
      await expect(needs.getByText('sensitive', { exact: true })).toBeVisible();
      await expect(
        needs.getByText(/messaging\.send is sensitive — your approval stays required even after you get this workflow\./i),
      ).toBeVisible();

      const worksWith = page.getByRole('region', { name: 'Works with' });
      await expect(worksWith.getByText('cloud_allowed')).toBeVisible();

      const versionTrust = page.getByRole('region', { name: 'Version and trust' });
      await expect(versionTrust.getByRole('heading', { name: 'Version 1' })).toBeVisible();
      await expect(
        versionTrust.getByText(/The listing pins this exact version — immutable, with its own digest\./i),
      ).toBeVisible();
      await expect(
        versionTrust.getByText(/Publication is not verification, authorization, or proof of safety\./),
      ).toBeVisible();
    },
  );
  await shot(page, '05-listing-disclosure.png');

  // ============ MKT-3 — the NO-ORG session gets the onboarding (F-002) ========
  await journey<void>(
    'MKT-3',
    'purchase with NO organization → the first-run onboarding flow (F-002/RR-002)',
    'no silent no-op: the actionable Organization onboarding renders in Your access; the org is created through the real UI; the per-org decision resolves',
    () =>
      'the no-org session at the listing: NO perpetual "Checking your access…" — the Organization onboarding rendered inside Your access ("Set up your organization"); the org was created through the real UI; the per-org decision resolved to the honest "This listing has no free offer." denial (an actionable decision, never a silent no-op)',
    'PASS',
    async () => {
      // The consumer is a fresh signup with ZERO organizations (the
      // R0-R4 MKT-3 precondition — the org has NOT been created yet).
      const onboarding = page.getByRole('region', { name: 'Organization onboarding' });
      await expect(onboarding).toBeVisible({ timeout: 20_000 });
      await expect(onboarding.getByRole('heading', { name: /Set up your organization/i })).toBeVisible();
      await expect(onboarding.locator('#organization-name')).toBeVisible();
      await expect(
        onboarding.getByText(/workflows you install and buy belong to an organization/i),
      ).toBeVisible();
      // The perpetual "Checking your access…" is SUPPRESSED (zero orgs) —
      // the onboarding is the actionable state.
      const access = page.getByRole('region', { name: 'Your access' });
      await expect(access.getByText(/Checking your access/i)).toHaveCount(0);

      // The org is created through the real browser UI (the RR-002 fix).
      await onboarding.locator('#organization-name').fill(CONSUMER_ORG_NAME);
      await onboarding.getByRole('button', { name: 'Create organization' }).click();
      await expect(page.getByRole('region', { name: 'Organization onboarding' })).toHaveCount(0, {
        timeout: 20_000,
      });
      // The per-org decision resolves for the created org — the honest
      // denial for the not-yet-purchased one-time listing.
      await expect(access.getByText(/This listing has no free offer\./i)).toBeVisible({
        timeout: 20_000,
      });
    },
  );
  await shot(page, '06-no-org-onboarding.png');

  // The consumer's session + organization (resolved from the REAL browser
  // context AFTER the onboarding — the session cookie + org read).
  const token = await sessionToken(context);
  expect(token).not.toBe('');
  const orgs = await api(token, 'GET', '/organizations');
  expect(orgs.status).toBe(200);
  const consumerOrgId = (orgs.json.organizations as Array<{ id: string; name: string }>)[0]?.id ?? '';
  expect(consumerOrgId).not.toBe('');

  // ============ MKT-4 — purchase with org → entitled ==========================
  await journey<void>(
    'MKT-4',
    'purchase with org → entitled',
    '"You\'re entitled to this workflow." + the one-time-purchase basis',
    () => '"Get workflow" drove the REAL offer acceptance (the deterministic reference payment adapter settled the $19.00 charge); the decision re-read shows "You\u2019re entitled to this workflow." + "Access through your one-time purchase."',
    'PASS',
    async () => {
      const offers = page.getByRole('region', { name: 'Offers' });
      await offers.getByRole('button', { name: 'Get workflow' }).click();
      const access = page.getByRole('region', { name: 'Your access' });
      await expect(access.getByText("You're entitled to this workflow.")).toBeVisible({
        timeout: 20_000,
      });
      await expect(access.getByText(/Access through your one-time purchase\./i)).toBeVisible();
    },
  );
  await shot(page, '07-purchased-entitled.png');

  // ============ MKT-5 — install pinned version ================================
  await journey<void>(
    'MKT-5',
    'install pinned version',
    'installed, pinned; the execution-separate sentence',
    () => 'the EXISTING V2-002 Install pinned version 1 into the CONSUMER org: "Installed — pinned to version 1" + "Running it stays a separate decision…" + "Open in your Workflows library"',
    'PASS',
    async () => {
      const access = page.getByRole('region', { name: 'Your access' });
      await access.getByRole('button', { name: 'Install', exact: true }).click();
      await expect(access.getByText(/Installed — pinned to version 1/i)).toBeVisible({
        timeout: 20_000,
      });
      await expect(access.getByText(/Running it stays a separate decision/i)).toBeVisible();
      await expect(access.getByRole('link', { name: /Open in your Workflows library/i })).toBeVisible();
    },
  );
  await shot(page, '08-listing-installed.png');

  // ============ LIB-2 — the Installed tab shows the REAL name (F-007) ========
  await journey<void>(
    'LIB-2',
    'Installed tab: the REAL workflow name (F-007/RR-006)',
    'installed cards with the workflow\u2019s real name — never the generic fallback',
    () => 'the Installed tab card shows the REAL name "R6 audit approval digest" (never the generic "Installed workflow" fallback) + "Version 1 — pinned" + "Enabled" + the Open link',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/workflows`);
      await page.getByRole('tab', { name: 'Installed' }).click();
      const panel = page.getByRole('tabpanel');
      await expect(panel.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
        timeout: 20_000,
      });
      // The generic fallback NEVER renders (the F-007 fix).
      await expect(panel.getByText('Installed workflow', { exact: true })).toHaveCount(0);
      await expect(panel.getByText(/Version 1 — pinned/i)).toBeVisible();
      await expect(panel.getByText('Enabled', { exact: true })).toBeVisible();
      await expect(panel.getByRole('link', { name: 'Open' })).toHaveAttribute(
        'href',
        `/workflows/${seed.workflowId}`,
      );
    },
  );
  await shot(page, '09-installed-real-name.png');

  // ============ DET-2 — the INSTALLED cross-org detail LOADS (F-003) ==========
  // The network capture is armed BEFORE the navigation (the F-003 proof).
  const detailRequests: string[] = [];
  const onDetailRequest = (req: import('@playwright/test').Request) => {
    detailRequests.push(req.url());
  };
  page.on('request', onDetailRequest);

  await journey<void>(
    'DET-2',
    'INSTALLED (marketplace) workflow detail loads against caller-org reads (F-003/RR-003)',
    'the detail loads (heading, description, Public line, steps, the consumer pin, honest no-facts states — no honest-error state) with ZERO publisher-org requests',
    () =>
      'the cross-org INSTALLED detail LOADED: heading + description + "Public — any signed-in user" + the 5 presentation-label steps + "Installed: Version 1 — pinned · Enabled" + "Not run yet" + "not deployed yet" + NO alert; the network capture: ZERO /api/organizations/{publisher}/ requests, the caller-org runs + installations reads present, the public workflow read present',
    'PASS',
    async () => {
      await panel_openInstalledDetail(page, WORKFLOW_NAME);
      await expect(page.getByText(WORKFLOW_DESCRIPTION)).toBeVisible();
      await expect(page.getByText(/Public — any signed-in user/i)).toBeVisible();
      const steps = page.getByRole('list', { name: /what it does/i });
      await expect(steps.getByRole('listitem')).toHaveCount(5);
      await expect(steps.getByText(COLLECT_LABEL)).toBeVisible();
      await expect(steps.getByText(REVIEW_LABEL)).toBeVisible();
      await expect(steps.getByText(SEND_LABEL)).toBeVisible();
      await expect(page.getByText(/Installed: Version 1 — pinned · Enabled/)).toBeVisible();
      await expect(page.getByText(/Not run yet/i)).toBeVisible();
      await expect(page.getByText(/not deployed yet/i)).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);

      // THE F-003 network proof (the browser's own capture, armed before
      // the navigation): ZERO publisher-org requests; the caller-org reads
      // + the public workflow read are present instead.
      const publisherPrefix = `/api/organizations/${seed.publisherOrgId}/`;
      const toPublisher = detailRequests.filter((u) => u.includes(publisherPrefix));
      expect(
        toPublisher,
        `publisher-org requests issued during the consumer detail load: ${toPublisher.join(', ')}`,
      ).toEqual([]);
      const consumerPrefix = `/api/organizations/${consumerOrgId}/`;
      expect(
        detailRequests.filter((u) => u.includes(`${consumerPrefix}workflow-runs/runs`)).length,
      ).toBeGreaterThan(0);
      expect(
        detailRequests.filter((u) => u.includes(`${consumerPrefix}workflow-repository/installations`))
          .length,
      ).toBeGreaterThan(0);
      expect(
        detailRequests.filter((u) => u.includes(`/api/workflow-repository/workflows/${seed.workflowId}`))
          .length,
      ).toBeGreaterThan(0);
      page.off('request', onDetailRequest);
    },
  );
  await shot(page, '10-installed-detail-loads.png');

  // ============ CREATE-1 — Tell capture + the truthful boundary (F-004a) ======
  const boundaryRequests: string[] = [];
  const onBoundaryRequest = (req: import('@playwright/test').Request) => {
    boundaryRequests.push(`${req.method()} ${req.url()}`);
  };
  page.on('request', onBoundaryRequest);

  await journey<void>(
    'CREATE-1',
    'Tell creation → preview → the truthful boundary (F-004a/RR-004)',
    'honest capture; the corrected boundary copy; the fail-closed commit boundary holds (ZERO create POSTs)',
    () =>
      'the Tell preview rendered "Here\u2019s what I understood" with the corrected honest copy ("Natural-language capture isn\u2019t converted into executable WorkflowIR — no generation authority exists — so nothing is created from this page", "Durable creation isn\u2019t available for captured input", "Nothing is committed") — NO false promise; ZERO workflow-repository POSTs left the flow',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/create?mode=tell`);
      const box = page.getByRole('textbox', { name: /describe what you want done/i });
      await box.fill('Every morning, collect the open tickets and email me the digest.');
      await page.getByRole('button', { name: 'Continue to preview' }).click();
      await expect(page.getByRole('heading', { name: /here's what i understood/i })).toBeVisible();
      // The corrected honest copy (F-004a) — the false promise is GONE.
      await expect(
        page.getByText(/natural-language capture isn't converted into executable workflowir/i),
      ).toBeVisible();
      await expect(page.getByText(/no generation authority exists/i)).toBeVisible();
      await expect(page.getByText(/nothing is created from this page/i)).toBeVisible();
      await expect(
        page.getByText(/durable creation isn't available for captured input/i),
      ).toBeVisible();
      await expect(page.getByText(/nothing is committed/i)).toBeVisible();
      await expect(page.getByText(/executable authoring happens later/i)).toHaveCount(0);
      await expect(page.getByText(/durable workflow is created with immutable version 1/i)).toHaveCount(0);
      // The fail-closed boundary holds: ZERO workflow-repository commands.
      const commands = boundaryRequests.filter(
        (u) => u.startsWith('POST') && u.includes('/api/workflow-repository/'),
      );
      expect(
        commands,
        `workflow-repository commands issued during the captured-input journey: ${commands.join(', ')}`,
      ).toEqual([]);
      page.off('request', onBoundaryRequest);
    },
  );
  await shot(page, '11-create-boundary-tell.png');

  // ============ CREATE-2 — Show capture =======================================
  await journey<void>(
    'CREATE-2',
    'Show creation: honest no-recording note',
    '"No screen recording exists yet — describe what you did…"; steps captured; the same boundary',
    () => 'the Show mode rendered the honest no-recording note; a demonstration step was captured and echoed in the preview; the same fail-closed boundary rendered',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/create?mode=show`);
      await expect(
        page.getByText(/No screen recording exists yet — describe what you did, one step at a time\./i),
      ).toBeVisible();
      await page.locator('#show-step').fill('Open the ticket board');
      await page.getByRole('button', { name: 'Add step' }).click();
      await page.getByRole('button', { name: 'Continue to preview' }).click();
      await expect(page.getByRole('heading', { name: /here's what i understood/i })).toBeVisible();
      const demo = page.getByRole('list', { name: 'Your demonstration' });
      await expect(demo.getByRole('listitem')).toHaveCount(1);
      await expect(demo.getByText('Open the ticket board')).toBeVisible();
      await expect(
        page.getByText(/durable creation isn't available for captured input/i),
      ).toBeVisible();
    },
  );

  // ============ CREATE-3 — Tell+Show + the expert IR authoring (RR-004) =======
  let expertWorkflowId = '';
  await journey<void>(
    'CREATE-3',
    'Tell + Show combined capture, the same boundary, PLUS the RR-004 expert IR authoring path',
    'combined capture, the fail-closed boundary, and the corrected expert entry leading to a REAL authoring surface: the expert authors a valid WorkflowIR through the V2-002 create path and the workflow appears in the library',
    () =>
      'the Tell+Show preview carried both inputs with the same boundary; the boundary\u2019s expert entry navigated to /expert where the consumer authored a real WorkflowIR; the REAL V2-002 create route created "R6 audit expert digest" ("born with immutable version 1", a wfw_… id) and the created workflow resolves through the real reads',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/create?mode=tell-show`);
      await page.getByRole('textbox', { name: /describe what you want done/i }).fill(
        'Every morning, collect the fresh tickets and email the digest, sorted.',
      );
      await page.locator('#show-step').fill('Open the ticket board');
      await page.getByRole('button', { name: 'Add step' }).click();
      await page.getByRole('button', { name: 'Continue to preview' }).click();
      await expect(page.getByRole('heading', { name: /here's what i understood/i })).toBeVisible();
      await expect(
        page.getByText(/durable creation isn't available for captured input/i),
      ).toBeVisible();
      const expertEntry = page.getByRole('link', {
        name: /author a workflow in the expert workspace/i,
      });
      await expect(expertEntry).toBeVisible();
      await expect(expertEntry).toHaveAttribute('href', '/expert');

      // The RR-004 expert surface: the consumer authors the WorkflowIR.
      await expertEntry.click();
      const surface = page.getByRole('region', { name: 'Expert workflow authoring' });
      await expect(surface).toBeVisible();
      await expect(surface.getByText(/generates nothing/i)).toBeVisible();
      await expect(surface.getByText(/author the workflowir document/i)).toBeVisible();
      await page.locator('#expert-name').fill(EXPERT_WORKFLOW_NAME);
      await page.locator('#expert-slug').fill(EXPERT_WORKFLOW_SLUG);
      await page.locator('#expert-description').fill(EXPERT_WORKFLOW_DESCRIPTION);
      const irText = serializeWorkflowIrDocument(authorExpertWorkflow());
      await page.locator('#expert-ir').fill(irText);
      await surface.getByRole('button', { name: 'Create workflow' }).click();

      const done = page.getByRole('status', { name: 'Workflow created' });
      await expect(done).toBeVisible({ timeout: 20_000 });
      await expect(done.getByText(/born with immutable version 1/i)).toBeVisible();
      await expect(done.getByText(EXPERT_WORKFLOW_NAME)).toBeVisible();
      await expect(done.getByText(EXPERT_WORKFLOW_SLUG)).toBeVisible();
      const libraryLink = done.getByRole('link', { name: /open in your workflows library/i });
      await expect(libraryLink).toHaveAttribute('href', /^\/workflows\//);
      expertWorkflowId =
        (await libraryLink.getAttribute('href'))?.replace('/workflows/', '') ?? '';
      expect(expertWorkflowId).toMatch(/^wfw_/);

      // The REAL routes resolve the SAME created facts.
      const wf = await api(token, 'GET', `/workflow-repository/workflows/${expertWorkflowId}`);
      expect(wf.status, JSON.stringify(wf.json)).toBe(200);
      expect(wf.json.workflow.name).toBe(EXPERT_WORKFLOW_NAME);
      expect(wf.json.workflow.slug).toBe(EXPERT_WORKFLOW_SLUG);
      expect(wf.json.workflow.visibility).toBe('private');
      const versions = await api(
        token,
        'GET',
        `/workflow-repository/workflows/${expertWorkflowId}/versions`,
      );
      expect(versions.status).toBe(200);
      expect((versions.json.versions as Array<{ versionNumber: number }>).map((v) => v.versionNumber)).toEqual([1]);
    },
  );
  await shot(page, '13-expert-authoring-created.png');

  // ============ RUN-1 — run preview → request → start =========================
  await journey<void>(
    'RUN-1',
    'run preview → request → start (Running)',
    'consequential preview then Running (the real V2-005 request + start through the browser)',
    () =>
      'the Run preview rendered the 5 steps + Version 1 + "Approval required" + Needs access to + "Where it runs isn\u2019t set up yet — this workflow has no deployment."; the confirm drove the REAL request+start; the run-status surface rendered Running (the API runs read agrees)',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
      await expect(page.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole('region', { name: 'Run entry' }).getByRole('button', { name: 'Run' }).click();
      const preview = page.getByRole('region', { name: 'Run preview' });
      await expect(preview).toBeVisible();
      await expect(preview.getByText(`Run ${WORKFLOW_NAME}?`)).toBeVisible();
      await expect(preview.getByRole('list', { name: 'This will' }).getByRole('listitem')).toHaveCount(5);
      await expect(preview.getByText('Version 1', { exact: true })).toBeVisible();
      await expect(preview.getByText(/Approval required — you'll confirm before it continues\./i)).toBeVisible();
      await expect(preview.getByText('Needs access to')).toBeVisible();
      await expect(
        preview.getByText(/Where it runs isn't set up yet — this workflow has no deployment\./i),
      ).toBeVisible();
      await preview.getByRole('button', { name: 'Run' }).click();
      await expect(preview).toHaveCount(0, { timeout: 20_000 });
      const status = page.getByRole('region', { name: 'Run status' });
      await expect(status).toBeVisible({ timeout: 20_000 });
      await expect(status.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
      const run1 = await newestRun(token, consumerOrgId, seed.workflowId);
      expect(run1.state).toBe('running');
    },
  );
  await shot(page, '14-run-preview-running.png');

  // ============ RUN-2 — Running + trust disclosure ============================
  await journey<void>(
    'RUN-2',
    'Running + trust disclosure',
    'honest evidence state: "How do you know?" + "No evidence records yet" + the advanced surface',
    () => 'the run-status surface carries the §17 trust presentation: "How do you know?" + "No evidence records yet for this run." + the "Advanced details" surface',
    'PASS',
    async () => {
      const status = page.getByRole('region', { name: 'Run status' });
      const trust = status.getByRole('region', { name: 'How do you know?' });
      await expect(trust).toBeVisible({ timeout: 20_000 });
      await expect(trust.getByText(/No evidence records yet for this run\./i)).toBeVisible();
      await expect(trust.getByText('Advanced verification')).toBeVisible();
      await expect(status.getByText('Advanced details')).toBeVisible();
    },
  );
  await shot(page, '15-run-trust-how-know.png');

  // ============ RUN-3 — run state survives reload =============================
  const run1Id = (await newestRun(token, consumerOrgId, seed.workflowId)).id;
  await journey<void>(
    'RUN-3',
    'run state survives reload',
    'state retained (Running)',
    () => 'a full page reload re-derived the run-status surface with Running retained (the authoritative runs read)',
    'PASS',
    async () => {
      await page.reload();
      const status = page.getByRole('region', { name: 'Run status' });
      await expect(status).toBeVisible({ timeout: 20_000 });
      await expect(status.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
    },
  );

  // ============ RUN-4 — the USER drives the run lifecycle (F-008/RR-007) ======
  await journey<void>(
    'RUN-4',
    'the user drives the run lifecycle: Pause → Resume → the approval gate → Approve; Pause/Stop reachable (F-008/RR-007)',
    'the user-facing Approve/Resume/Pause/Stop controls exist and drive the REAL V2-005 commands; the waiting run is resumable by the human',
    () =>
      'the user PAUSED (Paused, history-verified) → RESUMED (Running) → the run parked at the approval gate ("Waiting for you" + the Approve control) → the user\u2019s APPROVE returned the run to execution (the ordered pause→resume→pause-at-review_gate→resumed timeline) → the Stop control opens the §2.4 explicit choice ("Keep it going" preserved the run)',
    'PASS',
    async () => {
      const status = page.getByRole('region', { name: 'Run status' });

      // SAFE PAUSE through the USER's control.
      await status.getByRole('button', { name: 'Pause' }).click();
      await expect(status.getByText('Paused', { exact: true })).toBeVisible({ timeout: 20_000 });
      let record = await newestRun(token, consumerOrgId, seed.workflowId);
      expect(record.id).toBe(run1Id);
      expect(record.state).toBe('paused');

      // RESUME through the USER's control (the generic label).
      await status.getByRole('button', { name: 'Resume' }).click();
      await expect(status.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
      record = await newestRun(token, consumerOrgId, seed.workflowId);
      expect(record.state).toBe('running');

      // The waiting-for-user state (the executor-side pause AT the IR
      // approval node — the t6/RR-005 pattern).
      await pauseAtApproval(token, run1Id);
      await page.reload();
      await expect(status.getByText('Waiting for you')).toBeVisible({ timeout: 20_000 });
      await expect(status.getByText(/^paused$/)).toHaveCount(0);

      // THE F-008 CORE: the user's Approve returns the run to execution.
      await status.getByRole('button', { name: 'Approve' }).click();
      await expect(status.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
      record = await newestRun(token, consumerOrgId, seed.workflowId);
      expect(record.id).toBe(run1Id);
      expect(record.state).toBe('running');
      const history = await runHistory(token, run1Id);
      const ordered = history.timeline
        .filter((e) => e.eventName === 'workflow.run.paused' || e.eventName === 'workflow.run.resumed')
        .sort((a, b) => a.sequence - b.sequence);
      expect(ordered.length).toBe(4); // user pause → user resume → approval pause → user approve
      expect(ordered[0]!.eventName).toBe('workflow.run.paused');
      expect(ordered[1]!.eventName).toBe('workflow.run.resumed');
      expect(ordered[2]!.eventName).toBe('workflow.run.paused');
      expect(ordered[2]!.detail?.atStepId).toBe(APPROVAL_STEP_ID);
      expect(ordered[3]!.eventName).toBe('workflow.run.resumed');

      // The §2.4 explicit choice is reachable (and reversible).
      await status.getByRole('button', { name: 'Stop' }).click();
      await expect(
        status.getByText(/This ends the run — it can't be restarted\./i),
      ).toBeVisible();
      await status.getByRole('button', { name: 'Keep it going' }).click();
      await expect(status.getByText(/This ends the run/i)).toHaveCount(0);
    },
  );
  await shot(page, '17-waiting-approve.png');

  // ============ HOME-3 — Pending approvals COMPOSES (F-005/RR-005a) ===========
  await journey<void>(
    'HOME-3',
    'attention: Pending approvals composes real approvals content (F-005/RR-005)',
    'a pending approval appears with actionable language (the RR-005 composed surface)',
    () =>
      'Home\u2019s Pending approvals showed the approval-waiting run: "Waiting for you" + the workflow name + "It\u2019s paused for your approval before it continues." + the "Open the run" link (href /workflows/{id}?run={runId}) — NO Unavailable claim, NO false "not part of the product" copy; Needs attention shows Paused; the Open-the-run deep link re-opened the waiting run and the user\u2019s Approve closed it again (the loop is closable from Home too)',
    'PASS',
    async () => {
      // Re-park the run at the approval gate (the executor-side report).
      await pauseAtApproval(token, run1Id);
      await page.goto(`${FRONTEND_URL}/`);
      const approvals = page.getByRole('region', { name: 'Pending approvals' });
      await expect(approvals.getByText('Waiting for you')).toBeVisible({ timeout: 20_000 });
      await expect(approvals.getByText(WORKFLOW_NAME)).toBeVisible();
      await expect(approvals.getByText(/paused for your approval/i)).toBeVisible();
      const link = approvals.getByRole('link', { name: 'Open the run' });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', `/workflows/${seed.workflowId}?run=${run1Id}`);
      await expect(approvals.getByRole('status', { name: 'Unavailable' })).toHaveCount(0);
      await expect(approvals.getByText(/becomes? part of the product/i)).toHaveCount(0);
      const attention = page.getByRole('region', { name: 'Needs attention' });
      await expect(attention.getByText('Paused', { exact: true })).toBeVisible();

      // The actionable language is REAL: the Open-the-run deep link opens
      // the waiting run and the user's Approve closes the loop again (the
      // T10 F02 deep-link pattern; the run returns to execution for the
      // downstream journeys).
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/workflows/${seed.workflowId}\\?run=${run1Id}$`));
      const status = page.getByRole('region', { name: 'Run status' });
      await expect(status.getByText('Waiting for you')).toBeVisible({ timeout: 20_000 });
      await status.getByRole('button', { name: 'Approve' }).click();
      await expect(status.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
    },
  );
  await shot(page, '18-home-pending-approvals.png');

  // ============ RUN-5 — failure presentation + recovery =======================
  await journey<void>(
    'RUN-5',
    'failure presentation + recovery (Try again works)',
    'honest failure + recovery: the reason verbatim, "Try again" starts a new run, "Edit workflow" → /expert',
    () =>
      'the executor-side fail rendered "Couldn\u2019t complete" + the recovery surface ("I couldn\u2019t finish this." + the reason verbatim + "Try again" + "Edit workflow" → /expert); "Try again" started a NEW run (Running, a distinct run id)',
    'PASS',
    async () => {
      const failureReason = 'The upstream board refresh failed before the digest could be sent.';
      await failRun(token, run1Id, failureReason);
      await page.reload();
      const status = page.getByRole('region', { name: 'Run status' });
      await expect(status.getByText('Couldn\u2019t complete', { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      const recovery = page.getByRole('region', { name: 'Recovery' });
      await expect(recovery.getByText(/I couldn\u2019t finish this\./i)).toBeVisible();
      await expect(recovery.getByText(new RegExp(`It stopped: ${failureReason}`))).toBeVisible();
      await expect(recovery.getByRole('link', { name: 'Edit workflow' })).toHaveAttribute('href', '/expert');

      // "Try again" — the REAL T6 command path (a fresh manual trigger).
      await recovery.getByRole('button', { name: 'Try again' }).click();
      await expect(recovery.getByText(/Starting a new run…|Try again/i)).toBeVisible();
      const run2 = await newestRun(token, consumerOrgId, seed.workflowId);
      expect(run2.id).not.toBe(run1Id);
      expect(run2.state).toBe('running');
      await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
      const statusAfter = page.getByRole('region', { name: 'Run status' });
      await expect(statusAfter.getByText('Running', { exact: true })).toBeVisible({
        timeout: 20_000,
      });
    },
  );
  await shot(page, '19-failed-recovery.png');

  // ============ WHEN-1 — schedule editor save =================================
  await journey<void>(
    'WHEN-1',
    'schedule editor → save ("Runs every day · 9:00 AM UTC" + Pause; deployment + subscription created)',
    'real V2-009 composition: the schedule sentence + Pause; the deployment + subscription created through the real routes',
    () =>
      'the When editor (On a schedule · Every day · 09:00 UTC) saved through the REAL create-or-converge routes: the note "Scheduled · Runs every day · 9:00 AM UTC" + the subscription line "Runs every day · 9:00 AM UTC" with a Pause control; the caller-org deployment + schedule subscription verified through the real reads',
    'PASS',
    async () => {
      const when = page.getByRole('region', { name: 'When it runs' });
      await when.getByRole('button', { name: 'Schedule' }).click();
      const editor = page.getByRole('region', { name: 'When editor' });
      await expect(editor).toBeVisible();
      await editor.locator('#when-mode-schedule').check();
      // The defaults: Every day, 09:00, UTC — exactly the audit sentence.
      await editor.getByRole('button', { name: 'Save' }).click();
      await expect(when.getByText(/Scheduled · Runs every day · 9:00 AM UTC/i)).toBeVisible({
        timeout: 20_000,
      });
      await expect(when.getByText('Runs every day · 9:00 AM UTC', { exact: true })).toBeVisible();
      await expect(when.getByRole('button', { name: 'Pause' })).toBeVisible();

      // The authoritative reads agree (deployment + subscription in the
      // CALLER's organization).
      const deployments = await api(
        token,
        'GET',
        `/organizations/${consumerOrgId}/workflow-deployments/deployments`,
      );
      expect(deployments.status).toBe(200);
      const mine = (deployments.json.deployments as Array<{
        id: string;
        workflowId: string;
        enabled: boolean;
      }>).filter((d) => d.workflowId === seed.workflowId);
      expect(mine.length).toBeGreaterThan(0);
      const subs = await api(
        token,
        'GET',
        `/workflow-deployments/deployments/${mine[0]!.id}/subscriptions`,
      );
      expect(subs.status).toBe(200);
      const schedule = (subs.json.subscriptions as Array<{ kind: string; enabled: boolean }>).filter(
        (s) => s.kind === 'schedule',
      );
      expect(schedule.length).toBeGreaterThan(0);
      expect(schedule[0]!.enabled).toBe(true);
    },
  );
  await shot(page, '20-when-scheduled.png');

  // ============ TEACH-1..4 — the lesson journey (F-009/RR-008) ================
  const practiceCalls: Array<{ nodeId: string; answer: string }> = [];
  const onTeachRequest = (req: import('@playwright/test').Request) => {
    if (
      req.method() === 'POST' &&
      req.url().includes('/api/teaching-sessions/sessions/') &&
      req.url().endsWith('/practice')
    ) {
      const data = req.postDataJSON() as { nodeId?: unknown; answer?: unknown } | null;
      practiceCalls.push({
        nodeId: String(data?.nodeId ?? ''),
        answer: String(data?.answer ?? ''),
      });
    }
  };
  page.on('request', onTeachRequest);

  await journey<void>(
    'TEACH-1',
    'lesson + checkpoints + pause/resume',
    'governed lesson flow: Start lesson → the steps → "I\'ve done it" × the lesson → pause/resume mid-lesson → All steps confirmed',
    () =>
      'Teach Me opened (bound to the pinned Version 1); Start lesson → "Step 1 of 5 — Collect the open tickets"; a mid-lesson Pause → the paused note → Resume; 5 × "I\u2019ve done it" → "All steps confirmed"',
    'PASS',
    async () => {
      // Open the Teach Me surface beside Run (§12 first-class).
      await page.getByRole('button', { name: 'Teach Me' }).click();
      const teach = page.getByRole('region', { name: 'Teach Me' });
      await expect(teach.getByText(/You.ll learn to do this yourself: /i)).toBeVisible({
        timeout: 20_000,
      });
      await expect(teach.getByText(/Version 1 — the lesson is bound to it/i)).toBeVisible();

      await teach.getByRole('button', { name: 'Start lesson' }).click();
      await expect(teach.getByText(`Step 1 of 5 — ${COLLECT_LABEL}`)).toBeVisible({
        timeout: 20_000,
      });

      // A mid-lesson pause/resume (the R0-R4 TEACH-1 pause).
      await teach.getByRole('button', { name: 'Pause' }).click();
      await expect(teach.getByText(/Paused — .*at Step 1 of 5/i)).toBeVisible({ timeout: 20_000 });
      await teach.getByRole('button', { name: 'Resume' }).click();
      await expect(teach.getByText(`Step 1 of 5 — ${COLLECT_LABEL}`)).toBeVisible({
        timeout: 20_000,
      });

      // The remaining checkpoints (the 5-step lesson).
      for (let i = 0; i < 5; i += 1) {
        await teach.getByRole('button', { name: "I've done it" }).click();
      }
      await expect(teach.getByText(/All steps confirmed/i)).toBeVisible({ timeout: 20_000 });
    },
  );
  await shot(page, '21-teach-lesson.png');

  await journey<void>(
    'TEACH-2',
    'practice feedback references the CORRECT step (F-009/RR-008)',
    'the attempted question\u2019s own verbatim feedback (the authority template names the ATTEMPTED step); the other question carries NO feedback',
    () =>
      'the send_report question answered wrong rendered its own verbatim feedback (naming send_report, quoting messaging.send); the collect_posts question\u2019s section carried NO feedback; the collect_posts correct answer rendered "Correct: … for step \\"collect_posts\\""; the wire carried the attempted nodeId',
    'PASS',
    async () => {
      const collectQuestion = practiceSection(page, COLLECT_NODE_ID);
      const sendQuestion = practiceSection(page, SEND_NODE_ID);
      await expect(collectQuestion).toBeVisible({ timeout: 20_000 });
      await expect(sendQuestion).toBeVisible();

      // No feedback anywhere before any attempt.
      await expect(collectQuestion.getByText(/for step "/)).toHaveCount(0);
      await expect(sendQuestion.getByText(/for step "/)).toHaveCount(0);

      // The send_report question answered WRONG (the collect semantics):
      // the feedback under IT names send_report — never another step.
      await sendQuestion.getByRole('radio', { name: COLLECT_SEMANTICS }).check();
      await sendQuestion.getByRole('button', { name: 'Check' }).click();
      await expect(sendQuestion.getByText(sendIncorrectFeedback)).toBeVisible({
        timeout: 20_000,
      });
      // THE F-009 PROOF: the collect_posts question's section carries NO
      // feedback naming send_report — and no feedback at all.
      await expect(collectQuestion.getByText(/for step "send_report"/)).toHaveCount(0);
      await expect(collectQuestion.getByText(/for step "/)).toHaveCount(0);

      // The known case: the collect_posts answer's own feedback names
      // collect_posts.
      await collectQuestion.getByRole('radio', { name: COLLECT_SEMANTICS }).check();
      await collectQuestion.getByRole('button', { name: 'Check' }).click();
      await expect(collectQuestion.getByText(collectCorrectFeedback)).toBeVisible({
        timeout: 20_000,
      });
      await expect(collectQuestion.getByText(/for step "send_report"/)).toHaveCount(0);
      // The send_report question KEEPS its own feedback.
      await expect(sendQuestion.getByText(sendIncorrectFeedback)).toBeVisible();

      // The wire carried the step actually being assessed.
      expect(practiceCalls, `practice calls: ${JSON.stringify(practiceCalls)}`).toContainEqual({
        nodeId: SEND_NODE_ID,
        answer: COLLECT_SEMANTICS,
      });
      expect(practiceCalls).toContainEqual({ nodeId: COLLECT_NODE_ID, answer: COLLECT_SEMANTICS });
    },
  );
  await shot(page, '22-practice-correct-step.png');

  await journey<void>(
    'TEACH-3',
    'assessment → Lesson complete',
    'terminal on pass: "Lesson complete" with no lifecycle commands remaining',
    () => 'the exact-token assessment (5 ordered positions + 5 declared-semantics answers) passed → "Lesson complete"; no Pause/"I\'ve done it" controls remain',
    'PASS',
    async () => {
      const teach = page.getByRole('region', { name: 'Teach Me' });
      const assessment = teach.getByRole('region', { name: 'Show you know it' });
      await expect(assessment).toBeVisible({ timeout: 20_000 });
      for (const [index, nodeId] of LESSON_ORDER.entries()) {
        const label = LESSON_LABELS[nodeId]!;
        await assessment.getByLabel(`Position of ${label}`).selectOption(String(index + 1));
        await assessment.getByLabel(`What does ${label} do?`).fill(LESSON_SEMANTICS[nodeId]!);
      }
      await assessment.getByRole('button', { name: 'Submit' }).click();
      await expect(teach.getByText('Lesson complete')).toBeVisible({ timeout: 20_000 });
      await expect(teach.getByRole('button', { name: 'Pause' })).toHaveCount(0);
      await expect(teach.getByRole('button', { name: "I've done it" })).toHaveCount(0);
    },
  );

  await journey<void>(
    'TEACH-4',
    'teaching evidence visibly separate from run evidence',
    'the distinct Teaching evidence surface with the separation vocabulary',
    () => 'the "Teaching evidence" region rendered with "Kept separate from run evidence — learning never counts as execution"',
    'PASS',
    async () => {
      const teach = page.getByRole('region', { name: 'Teach Me' });
      const evidence = teach.getByRole('region', { name: 'Teaching evidence' });
      await expect(evidence).toBeVisible();
      await expect(evidence.getByText(/Kept separate from run evidence/i)).toBeVisible();
    },
  );
  await shot(page, '23-lesson-complete.png');
  page.off('request', onTeachRequest);

  // ============ MKT-6 — fork with provenance ==================================
  let forkWorkflowId = '';
  await journey<void>(
    'MKT-6',
    'Make my own (fork) with provenance',
    'provenance-carrying copy: name input → "Create copy" → "Open your copy"; forkedFrom* verified through the real read',
    () =>
      'the "Make it my own" flow created the copy in the CONSUMER org ("Open your copy" appeared); the fork detail loads (Private — only you); the real read confirms forkedFromWorkflowId/forkedFromVersionId point at the publisher workflow + version 1',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/explore/${seed.listingId}`);
      const makeOwn = page.getByRole('region', { name: 'Make my own' });
      await expect(makeOwn).toBeVisible();
      await makeOwn.getByRole('button', { name: 'Make it my own' }).click();
      await makeOwn.locator('#fork-copy-name').fill(FORK_NAME);
      await makeOwn.getByRole('button', { name: 'Create copy' }).click();
      const openCopy = makeOwn.getByRole('link', { name: 'Open your copy' });
      await expect(openCopy).toBeVisible({ timeout: 20_000 });
      forkWorkflowId = (await openCopy.getAttribute('href'))?.replace('/workflows/', '') ?? '';
      expect(forkWorkflowId).toMatch(/^wfw_/);

      // The provenance through the REAL read.
      const fork = await api(token, 'GET', `/workflow-repository/workflows/${forkWorkflowId}`);
      expect(fork.status, JSON.stringify(fork.json)).toBe(200);
      expect(fork.json.workflow.name).toBe(FORK_NAME);
      expect(fork.json.workflow.organizationId).toBe(consumerOrgId);
      expect(fork.json.workflow.forkedFromWorkflowId).toBe(seed.workflowId);
      expect(fork.json.workflow.forkedFromVersionId).toBe(seed.version1Id);

      // The fork detail opens (the ACT-2 DET surface base).
      await openCopy.click();
      await expect(page.getByRole('heading', { name: FORK_NAME })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(/Private — only you/i)).toBeVisible();
    },
  );
  await shot(page, '24-fork-opened.png');

  // ============ LIB-1 — My Workflows cards with facts =========================
  await journey<void>(
    'LIB-1',
    'My Workflows tab: cards with facts',
    'cards with facts (the fork + the expert-authored workflow: name, Last run, schedule word, Open)',
    () =>
      'the My Workflows tab lists the fork "My R6 audit copy" and the expert-authored "R6 audit expert digest" with the honest facts ("Not run yet", "Runs when you start it", the slug, the Open links)',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/workflows`);
      await page.getByRole('tab', { name: 'My Workflows' }).click();
      const panel = page.getByRole('tabpanel');
      await expect(panel.getByRole('heading', { name: FORK_NAME })).toBeVisible({
        timeout: 20_000,
      });
      await expect(panel.getByRole('heading', { name: EXPERT_WORKFLOW_NAME })).toBeVisible();
      await expect(panel.getByText(/Last run Not run yet/i).first()).toBeVisible();
      await expect(panel.getByText('Runs when you start it').first()).toBeVisible();
      expect(await panel.getByRole('link', { name: 'Open' }).count()).toBeGreaterThanOrEqual(2);
    },
  );
  await shot(page, '25-library-my-workflows.png');

  // ============ LIB-3 — Drafts/Archived honestly unavailable ==================
  await journey<void>(
    'LIB-3',
    'Drafts / Archived: honest unavailable',
    'honest Unavailable sections (never fabricated) — the workflow model carries no draft/archived state',
    () =>
      'the Drafts and Archived tabs render their honest Unavailable states ("Drafts aren\u2019t distinguishable in the workflow records yet — they\u2019ll appear here once draft state becomes part of the product" / the archived twin)',
    'EXPECTED_UNAVAILABLE',
    async () => {
      await page.getByRole('tab', { name: 'Drafts' }).click();
      const panel = page.getByRole('tabpanel');
      await expect(panel.getByRole('status', { name: 'Unavailable' })).toBeVisible();
      await expect(
        panel.getByText(/draft state becomes part of the product/i),
      ).toBeVisible();
      await page.getByRole('tab', { name: 'Archived' }).click();
      await expect(panel.getByRole('status', { name: 'Unavailable' })).toBeVisible();
      await expect(
        panel.getByText(/archived state becomes part of the product/i),
      ).toBeVisible();
    },
  );
  await shot(page, '26-drafts-archived-unavailable.png');

  // ============ DET-1 — own-org workflow detail full surface ==================
  await journey<void>(
    'DET-1',
    'own-org workflow detail: full surface (the consumer\u2019s fork + the publisher\u2019s own-org content)',
    'purpose, presentation steps, When/Where, Recent activity, Version, Access and safety, Updates, Improvements, primary actions — with real content on the publisher\u2019s own-org pass',
    () =>
      'the consumer\u2019s fork detail rendered the full surface (heading, description, Private line, the 5 steps, "Runs when you start it", "Not run yet", "Version 1 — immutable", "No installs — run it from the library", Access and safety, Updates, Improvements, Teach Me/Share/Edit); the publisher\u2019s own-org detail (a second real browser session) rendered WITH content: the seeded schedule "Runs every day · 9:00 AM UTC" + Pause, Recent activity listing the run, "Installed: Version 1 — pinned · Enabled"',
    'PASS',
    async () => {
      // (a) The consumer's own-org fork detail — the full surface.
      await page.goto(`${FRONTEND_URL}/workflows/${forkWorkflowId}`);
      await expect(page.getByRole('heading', { name: FORK_NAME })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(WORKFLOW_DESCRIPTION)).toBeVisible();
      await expect(page.getByText(/Private — only you/i)).toBeVisible();
      const steps = page.getByRole('list', { name: /what it does/i });
      await expect(steps.getByRole('listitem')).toHaveCount(5);
      await expect(page.getByText(/Version 1 — immutable/i)).toBeVisible();
      await expect(page.getByText(/No installs — run it from the library/i)).toBeVisible();
      await expect(page.getByText(/Not run yet/i)).toBeVisible();
      await expect(page.getByText(/Runs when you start it/i)).toBeVisible();
      await expect(page.getByRole('region', { name: 'Access and safety' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Updates' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Improvements' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Primary actions' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Teach Me' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
      await shot(page, '27-own-org-fork-detail.png');

      // (b) The publisher's own-org detail (a second real browser session)
      // — the dispatch's requirement: the own-org run + deployment give
      // DET-1's When/Where + Recent activity REAL content.
      const publisherContext = await browser.newContext({
        baseURL: FRONTEND_URL,
        viewport: { width: 1280, height: 800 },
      });
      try {
        const ppage = await publisherContext.newPage();
        await ppage.goto(`${FRONTEND_URL}/`);
        await ppage.locator('#email').fill(PUBLISHER_EMAIL);
        await ppage.locator('#password').fill(PUBLISHER_PASSWORD);
        await ppage.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(
          ppage.getByRole('heading', { name: /What do you want to get done\?/i }),
        ).toBeVisible();

        await ppage.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
        await expect(ppage.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
          timeout: 20_000,
        });
        await expect(ppage.getByText(WORKFLOW_DESCRIPTION)).toBeVisible();
        await expect(ppage.getByText(/Public — any signed-in user/i)).toBeVisible();
        const publisherSteps = ppage.getByRole('list', { name: /what it does/i });
        await expect(publisherSteps.getByRole('listitem')).toHaveCount(5);
        // The seeded deployment + subscription: the schedule sentence.
        const when = ppage.getByRole('region', { name: 'When it runs' });
        await expect(when.getByText(/Runs every day · 9:00 AM UTC/)).toBeVisible({
          timeout: 20_000,
        });
        await expect(when.getByRole('button', { name: 'Pause' })).toBeVisible();
        // The seeded run: Recent activity with a real entry.
        const recent = ppage.getByRole('region', { name: 'Recent activity' });
        await expect(recent.getByRole('list', { name: 'Recent activity' }).getByRole('listitem')).toHaveCount(1);
        // The publisher's own installation: the pin line.
        await expect(ppage.getByText(/Installed: Version 1 — pinned · Enabled/)).toBeVisible();
        await expect(ppage.getByText(/Version 1 — immutable/i)).toBeVisible();
        await expect(ppage.getByRole('region', { name: 'Where it runs' }).getByText('Any supported node')).toBeVisible();
        await expect(ppage.getByRole('alert')).toHaveCount(0);
        await shot(ppage, '28-publisher-own-org-detail.png');
      } finally {
        await publisherContext.close();
      }
    },
  );

  // ============ VER-1 — the §19 update banner (v2 ships) ======================
  await journey<void>(
    'VER-1',
    'update banner with pin language (v2 available)',
    'banner + pin language: "An update is available", Version 2, "Your installed version: Version 1 — pinned", "Nothing changes until you approve the update"',
    () =>
      'the publisher shipped v2 (the task-text change) through the REAL createVersion route; the consumer\u2019s detail shows the §19 banner: "An update is available" + Version 2 + "Your installed version: Version 1 — pinned" + "Nothing changes until you approve the update"',
    'PASS',
    async () => {
      // The publisher ships v2 (the EQUIVALENT task-text change).
      const v2 = await api(
        seed.publisherCookie,
        'POST',
        `/workflow-repository/workflows/${seed.workflowId}/versions`,
        {
          content: versionContentOf(authorAuditWorkflow(V2_SCAN_TASK, V1_REPOSITORY)),
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
          parentVersionId: seed.version1Id,
        },
      );
      expect(v2.status, JSON.stringify(v2.json)).toBe(201);

      // The consumer sees the banner.
      await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
      await expect(page.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
        timeout: 20_000,
      });
      const update = page.getByRole('region', { name: 'Update available' });
      await expect(update.getByText(/an update is available/i)).toBeVisible({ timeout: 20_000 });
      await expect(update.getByText(/version 2/i)).toBeVisible();
      await expect(update.getByText(/your installed version: version 1/i)).toBeVisible();
      await expect(update.getByText(/nothing changes until you approve the update/i)).toBeVisible();
    },
  );
  await shot(page, '29-update-banner.png');

  // ============ VER-2 — What changed (equivalent + human-readable) ============
  // The compare-response capture is armed BEFORE the reviews (the wire proof).
  const compareResponses: Response[] = [];
  const onCompareResponse = (res: Response) => {
    if (res.url().includes('/api/workflow-optimization/compare')) {
      compareResponses.push(res);
    }
  };
  page.on('response', onCompareResponse);

  await journey<void>(
    'VER-2',
    'Review update / What changed: the human-readable version diff (F-010/RR-009)',
    'the EQUIVALENT posture stays "Task-for-task equivalent - verified"; the NON-EQUIVALENT posture renders the field-level readable diff (the step NAME, the field, the readable values — NO raw internal JSON) while the authoritative comparison payload remains on the wire',
    () =>
      'v1→v2 (the task-text change): "Task-for-task equivalent - verified" — no divergence block, no raw JSON; v1→v3 (the step-input literal change): "Not equivalent" + "Where the versions differ: the step \\"Collect the open tickets\\" — its inputs" + the readable Installed/New values (payswapdotorg/WorkflowOS → pectoraux/WorkflowOS) — NO \\"!=\\" blob, no raw node id; the wire capture shows the REAL V2-011 compare route answering with the raw internal envelope (equivalent:false, firstDivergence \\"node collect_posts inputs: …\\") while the rendered DOM never shows it',
    'PASS',
    async () => {
      // (a) The EQUIVALENT regression (v1→v2 — the task-text change is
      // out of the comparison surface by design).
      const update = page.getByRole('region', { name: 'Update available' });
      await update.getByRole('button', { name: /review update/i }).click();
      await expect(
        update.getByText(/task-for-task equivalent - verified/i),
      ).toBeVisible({ timeout: 20_000 });
      await expect(update.getByText(/where the versions differ/i)).toHaveCount(0);
      await expect(update.getByText(/not equivalent/i)).toHaveCount(0);
      await expect(update.getByText(/estimates, not measurements/i)).toBeVisible();
      await expect(update).not.toContainText('!=');
      await shot(page, '30-equivalent-what-changed.png');

      // (b) The publisher ships v3 (the NON-EQUIVALENT step-input literal
      // change — exactly the R0-R4 VER-2 divergence shape).
      const v3 = await api(
        seed.publisherCookie,
        'POST',
        `/workflow-repository/workflows/${seed.workflowId}/versions`,
        {
          content: versionContentOf(authorAuditWorkflow(V2_SCAN_TASK, V3_REPOSITORY)),
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        },
      );
      expect(v3.status, JSON.stringify(v3.json)).toBe(201);

      // (c) THE F-010 REPAIR: the human-readable diff.
      await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
      const update3 = page.getByRole('region', { name: 'Update available' });
      await expect(update3.getByText(/an update is available/i)).toBeVisible({ timeout: 20_000 });
      await expect(update3.getByText(/version 3/i)).toBeVisible();
      await update3.getByRole('button', { name: /review update/i }).click();

      // The honest verdict first — the authority's own non-equivalence.
      await expect(update3.getByText('Not equivalent', { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      // The step NAME (the presentation label — never the raw node id)
      // + the divergent field as consumer words.
      await expect(
        update3.getByText(/where the versions differ: the step "collect the open tickets" — its inputs/i),
      ).toBeVisible();
      // The two values, readable (names and values — not JSON blobs).
      await expect(update3.getByText(/^installed version:/i)).toContainText('value: payswapdotorg/WorkflowOS');
      await expect(update3.getByText(/^installed version:/i)).toContainText('name: repository');
      await expect(update3.getByText(/^new version:/i)).toContainText('value: pectoraux/WorkflowOS');
      // NO raw internal JSON envelope in the rendered surface.
      await expect(update3).not.toContainText('!=');
      await expect(update3).not.toContainText('node collect_posts inputs:');
      await expect(update3).not.toContainText('"kind"');
      await expect(update3).not.toContainText('"literal"');
      await expect(update3).not.toContainText('collect_posts');
      // Correctness first, then the estimates — the adoption gate intact.
      await expect(update3.getByText(/estimates, not measurements/i)).toBeVisible();
      await expect(update3.getByRole('button', { name: /approve update/i })).toBeVisible();
      await shot(page, '32-human-readable-diff.png');

      // (d) WIRE vs DOM (the derivation-over-payload proof): the compare
      // POSTs hit the REAL V2-011 route; the payloads carry the raw
      // internal envelopes (the v1→v2 EQUIVALENT result and the v1→v3
      // non-equivalent divergence) while the rendered DOM never shows
      // any of them.
      expect(compareResponses.length).toBeGreaterThanOrEqual(2);
      const domText = await page.getByRole('region', { name: 'Update available' }).innerText();
      const equivalents: boolean[] = [];
      for (const res of compareResponses) {
        expect(res.request().method()).toBe('POST');
        expect(res.status()).toBe(200);
        const body = (await res.json()) as {
          comparison: { correctness: { equivalent: boolean; firstDivergence: string | null } };
        };
        equivalents.push(body.comparison.correctness.equivalent);
        const divergence = body.comparison.correctness.firstDivergence;
        // The v1→v2 compare: EQUIVALENT (the authority's own result,
        // unchanged by the repair). The v1→v3 compare: NON-equivalent
        // with the raw internal envelope the transport carries…
        if (body.comparison.correctness.equivalent) {
          // The equivalent posture: the authority's own result — no
          // divergence to describe (the DOM showed "Task-for-task
          // equivalent - verified").
          expect(domText).not.toContain(' != ');
        } else {
          expect(typeof divergence).toBe('string');
          expect(divergence).toMatch(/^node collect_posts inputs: /);
          expect(divergence).toContain(' != ');
          expect(divergence).toContain('"kind"');
        }
        // …while the rendered DOM never shows any of it.
        if (divergence !== null) {
          expect(domText).not.toContain(divergence);
        }
        expect(domText).not.toContain('!=');
        expect(domText).not.toContain('"kind"');
      }
      // BOTH postures were exercised on the wire (the dispatch's BOTH-
      // fixtures requirement: the equivalent regression AND the field-
      // level human-readable diff).
      expect(equivalents).toContain(true);
      expect(equivalents).toContain(false);
    },
  );

  // ============ HOME-4 — Updates composes (F-005/RR-005b) =====================
  await journey<void>(
    'HOME-4',
    'attention: Updates composes versions/installations reads (F-005/RR-005)',
    'an installed-behind-head workflow appears in Updates with the pinned-never-auto-updated vocabulary + the Open-the-workflow link; NO adoption action on Home',
    () =>
      'Home\u2019s Updates showed the installed-behind-head workflow: "Update available" + the name + "Version 3 is available — your installed Version 1 stays pinned (it never auto-updates)" + "Nothing changes until you approve the update" + the "Open the workflow" link — no adoption action on Home, no Unavailable claim',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/`);
      const updates = page.getByRole('region', { name: 'Updates' });
      await expect(updates.getByText('Update available')).toBeVisible({ timeout: 20_000 });
      await expect(updates.getByText(WORKFLOW_NAME)).toBeVisible();
      await expect(updates.getByText(/Version 3 is available/i)).toBeVisible();
      await expect(updates.getByText(/stays pinned/i)).toBeVisible();
      await expect(
        updates.getByText(/Nothing changes until you approve the update/i),
      ).toBeVisible();
      const link = updates.getByRole('link', { name: 'Open the workflow' });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', `/workflows/${seed.workflowId}`);
      // The adoption action lives on the detail — NEVER on Home.
      await expect(updates.getByRole('button', { name: /approve|install|update/i })).toHaveCount(0);
      await expect(updates.getByRole('status', { name: 'Unavailable' })).toHaveCount(0);
      await expect(updates.getByText(/becomes? part of the product/i)).toHaveCount(0);
    },
  );
  await shot(page, '31-home-updates.png');

  // ============ VER-3 — approve update → new pin ==============================
  await journey<void>(
    'VER-3',
    'approve update → new pin',
    '"You\'re on the newest version."; the Installed pin moves to Version 3 through the EXISTING commands',
    () =>
      'the user clicked "Approve update" → the EXISTING V2-002 install command re-pinned to Version 3 → "You\u2019re on the newest version." + "Installed: Version 3 — pinned · Enabled" (verified through the real installations read)',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
      const update = page.getByRole('region', { name: 'Update available' });
      await expect(update.getByText(/an update is available/i)).toBeVisible({ timeout: 20_000 });
      await update.getByRole('button', { name: /review update/i }).click();
      await update.getByRole('button', { name: /approve update/i }).click();
      await expect(update.getByText(/You're on the newest version\./i)).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(/Installed: Version 3 — pinned · Enabled/)).toBeVisible({
        timeout: 20_000,
      });
      // The authoritative installations read agrees.
      const installations = await api(
        token,
        'GET',
        `/organizations/${consumerOrgId}/workflow-repository/installations`,
      );
      expect(installations.status).toBe(200);
      const pins = (
        installations.json.installations as Array<{
          workflowId: string;
          pinnedVersion: { versionNumber: number };
        }>
      ).filter((i) => i.workflowId === seed.workflowId);
      expect(pins.length).toBeGreaterThan(0);
      expect(pins[0]!.pinnedVersion.versionNumber).toBe(3);
    },
  );
  await shot(page, '33-newest-version.png');
  page.off('response', onCompareResponse);

  // ============ ACT-1 — the activity timeline =================================
  await journey<void>(
    'ACT-1',
    'activity timeline: entries + links',
    'version entries + run entries + "Open the run"',
    () =>
      'the Activity timeline lists the version entries (the fork + the expert workflow\u2019s immutable v1s) and the run entries with their state words + the "Open the run" links',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/activity`);
      const timeline = page.getByRole('list', { name: 'Activity timeline' });
      await expect(timeline.getByRole('listitem').first()).toBeVisible({ timeout: 20_000 });
      await expect(timeline.getByText(/New version/).first()).toBeVisible();
      const runEntry = timeline.getByText(/Open the run/).first();
      await expect(runEntry).toBeVisible();
      await expect(timeline.getByText(/Couldn\u2019t complete|Running|Waiting for you/).first()).toBeVisible();
    },
  );

  // ============ ACT-2 — activity → run deep link ==============================
  await journey<void>(
    'ACT-2',
    'activity → run deep link',
    'navigates to /workflows/:id?run=:runId and shows the run-status surface',
    () => 'the "Open the run" link navigated to /workflows/{id}?run={runId} and the run-status surface rendered the selected run',
    'PASS',
    async () => {
      const timeline = page.getByRole('list', { name: 'Activity timeline' });
      await timeline.getByText(/Open the run/).first().click();
      await expect(page).toHaveURL(/\/workflows\/[^/]+\?run=[^/]+$/);
      const status = page.getByRole('region', { name: 'Run status' });
      await expect(status).toBeVisible({ timeout: 20_000 });
    },
  );

  // ============ ACT-3 — teaching/device honestly unavailable ==================
  await journey<void>(
    'ACT-3',
    'teaching/device on Activity: honest unavailable',
    '"Teaching activity isn\u2019t shown here yet — teaching records don\u2019t offer a timeline read. Device events aren\u2019t shown here yet either."',
    () => 'the Activity page renders the honest teaching/device disclosure sentence verbatim (no fabricated timeline entries)',
    'EXPECTED_UNAVAILABLE',
    async () => {
      await expect(
        page.getByText(/Teaching activity isn.t shown here yet — teaching records don.t offer a timeline read\. Device events aren.t shown here yet either\./i),
      ).toBeVisible();
    },
  );
  await shot(page, '34-activity-timeline.png');

  // ============ EXPERT-1 — the expert bridge ==================================
  await journey<void>(
    'EXPERT-1',
    'expert bridge page renders',
    'the bridge renders with the mode-crossing disclosure + the developer-workspace entry',
    () => 'the /expert surface renders the "Developer workspace" bridge card with the explicit mode-crossing sentence + the "Open developer workspace" link (and the RR-004 authoring surface beside it)',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/expert`);
      await expect(page.getByRole('heading', { name: 'Expert workspace' })).toBeVisible();
      const bridge = page.getByRole('region', { name: 'Expert workflow authoring' });
      await expect(bridge).toBeVisible();
      await expect(
        page.getByText(/You're leaving the consumer workflow UX for the advanced workspace/i),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Open developer workspace' }),
      ).toHaveAttribute('href', '/projects');
    },
  );
  await shot(page, '35-expert-bridge.png');

  // ============ EXPERT-2 — project creation through the real UI ===============
  let projectId = '';
  await journey<void>(
    'EXPERT-2',
    'project creation through the UI',
    'project created; the engineering shell renders',
    () => 'the project was created through the real /projects form (New Project → the org + name → Create) and the Project Overview shell rendered',
    'PASS',
    async () => {
      await page.getByRole('link', { name: 'Open developer workspace' }).click();
      await expect(page).toHaveURL(/\/projects$/);
      await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        page.getByText(/You're in the advanced engineering workspace/i),
      ).toBeVisible();
      await page.getByRole('button', { name: 'New Project' }).click();
      await page.locator('#project-name').fill(PROJECT_NAME);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page).toHaveURL(/\/projects\/[^/]+$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible({
        timeout: 20_000,
      });
      projectId = page.url().split('/').pop() ?? '';
      expect(projectId).not.toBe('');
    },
  );

  // ============ EXPERT-3 — the engineering surfaces load (real entry) =========
  await journey<void>(
    'EXPERT-3',
    'engineering surfaces load against the REAL entry (the R0-R4 BLOCKED was a composition artifact)',
    'the V1 engineering routes answer on the real entry: the Overview\u2019s project + architectures reads resolve and the architect surface renders without "Error: Not found"',
    () =>
      'the project Overview consumed GET /projects/:id + GET /projects/:id/architectures and rendered (no ErrorState); the /projects/:id/architect surface rendered its "Architect" heading with NO "Error: Not found" — the V1 engineering routes were always wired in the real entry (R0-R4\u2019s 404 was the product-test-composition artifact)',
    'PASS',
    async () => {
      // The Overview itself already proved the architectures read (it
      // renders the project name only when BOTH reads resolve); the
      // negative control: no ErrorState text anywhere on the page.
      await expect(page.getByText(/Error: Not found/i)).toHaveCount(0);

      // The architect surface loads against the REAL entry.
      await page.goto(`${FRONTEND_URL}/projects/${projectId}/architect`);
      await expect(page.getByRole('heading', { name: 'Architect' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(/Error: Not found/i)).toHaveCount(0);

      // And the architecture surface (the second engineering control).
      await page.goto(`${FRONTEND_URL}/projects/${projectId}/architecture`);
      await expect(page.getByRole('heading', { name: 'Architecture' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(/Error: Not found/i)).toHaveCount(0);
    },
  );
  await shot(page, '36-project-created.png');

  // ============ RESP-1 — responsive 390x844 ====================================
  await journey<void>(
    'RESP-1',
    'mobile 390×844: Home/Detail/Create/Explore render with no horizontal overflow',
    'no horizontal overflow; the mobile primary nav present',
    () =>
      'at 390×844 all four surfaces rendered with documentElement.scrollWidth ≤ clientWidth (no horizontal overflow) and the mobile primary nav (Home / Workflows / Create / Explore / Activity) present',
    'PASS',
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const surfaces = ['/', '/workflows', '/create', '/explore'] as const;
      const expectedHeadings = [
        /What do you want to get done\?/i,
        /Workflows/i,
        /Create a workflow/i,
        /Explore/i,
      ];
      for (const [index, route] of surfaces.entries()) {
        await page.goto(`${FRONTEND_URL}${route}`);
        await expect(page.getByRole('main')).toBeVisible({ timeout: 20_000 });
        const heading = expectedHeadings[index]!;
        await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({
          timeout: 20_000,
        });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(
          overflow,
          `horizontal overflow on ${route}: ${overflow}px`,
        ).toBeLessThanOrEqual(0);
        const mobileNav = page.getByTestId('mobile-primary-nav');
        await expect(mobileNav).toBeVisible();
        await expect(mobileNav.getByRole('link', { name: 'Home' })).toBeVisible();
        await expect(mobileNav.getByRole('link', { name: 'Workflows' })).toBeVisible();
        await expect(mobileNav.getByRole('link', { name: 'Create' })).toBeVisible();
        await expect(mobileNav.getByRole('link', { name: 'Explore' })).toBeVisible();
        await expect(mobileNav.getByRole('link', { name: 'Activity' })).toBeVisible();
      }
      // The detail surface at 390 too (the R0-R4 RESP-1 set).
      await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
      await expect(page.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
        timeout: 20_000,
      });
      const detailOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(detailOverflow).toBeLessThanOrEqual(0);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  );
  await shot(page, '37-responsive-390.png');

  // ============ NET-1 — offline in-app navigation ==============================
  await journey<void>(
    'NET-1',
    'in-app navigation while offline → honest degraded states',
    'per-surface honest degraded states with Try again (never fabricated success)',
    () =>
      'offline in-app navigation rendered the honest degraded states: Workflows ("Couldn\u2019t load this right now." + Try again), Explore ("Listings are unavailable" + the not-an-empty-result note + Try again), Activity ("Workflows unavailable — couldn\u2019t load the workflow list." etc.), the workflow detail ("Couldn\u2019t load this workflow right now." + Try again — reached through client-side history); back online, "Try again" restored the surface',
    'PASS',
    async () => {
      // Start ONLINE on the installed detail, then go offline and
      // navigate IN-APP (client-side route changes — the SPA is already
      // loaded; a full reload offline would show the browser error page).
      await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
      await expect(page.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible();
      await context.setOffline(true);

      // Library (client-side via the back-nav link).
      await page.getByRole('navigation', { name: 'Back to the library' }).getByRole('link').click();
      await expect(page.getByText(/Couldn.t load this right now\./i)).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();

      // Explore.
      await page.getByTestId('header-primary-nav').getByRole('link', { name: 'Explore' }).click();
      await expect(page.getByRole('heading', { name: 'Listings are unavailable' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        page.getByText(/The marketplace read failed — this is not an empty result\./i),
      ).toBeVisible();

      // Activity.
      await page.getByTestId('header-primary-nav').getByRole('link', { name: 'Activity' }).click();
      await expect(
        page.getByText(/Workflows unavailable — couldn.t load the workflow list\./i),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByText(/Runs unavailable — couldn.t load the run list\./i),
      ).toBeVisible();

      // The workflow detail (client-side history navigation back — a
      // full page load offline would show the browser error page, so the
      // SPA's history pops are the in-app route changes).
      for (let i = 0; i < 8; i += 1) {
        if (page.url().includes(`/workflows/${seed.workflowId}`)) break;
        await page.evaluate(() => history.back());
        await page.waitForTimeout(250);
      }
      await expect(page).toHaveURL(new RegExp(`/workflows/${seed.workflowId}`));
      await expect(page.getByText(/Couldn.t load this workflow right now\./i)).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await shot(page, '38-offline-degraded.png');

      // Honest recovery: back online, "Try again" restores the surface.
      await context.setOffline(false);
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
        timeout: 20_000,
      });
    },
  );

  // ============ COMP-1 — the companion handoff bridge =========================
  await journey<void>(
    'COMP-1',
    'companion handoff deep link → the honest bridge',
    '"Companion not installed" + instructions',
    () => 'the /companion/handoff deep link rendered the honest bridge: the "Companion not installed" badge + the "WorkflowOS Companion not installed" instruction card',
    'PASS',
    async () => {
      await page.goto(`${FRONTEND_URL}/companion/handoff`);
      await expect(
        page.getByRole('heading', { name: /External Execution — Companion Handoff/i }),
      ).toBeVisible();
      await expect(page.getByText('Companion not installed', { exact: true })).toBeVisible();
      await expect(
        page.getByText('WorkflowOS Companion not installed', { exact: true }),
      ).toBeVisible();
    },
  );
  await shot(page, '39-companion-handoff.png');

  return 0;
}

/** The Installed tab → Open navigation (the DET-2 entry — extracted for reuse). */
async function panel_openInstalledDetail(page: Page, workflowName: string): Promise<void> {
  await page.goto(`${FRONTEND_URL}/workflows`);
  await page.getByRole('tab', { name: 'Installed' }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('heading', { name: workflowName })).toBeVisible({
    timeout: 20_000,
  });
  await panel.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: workflowName })).toBeVisible({
    timeout: 20_000,
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
