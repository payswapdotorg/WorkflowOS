# Z.ai Provider Adapter — Observed UI Contract

The REAL Z.ai adapter for the WorkflowOS Companion. It drives the Z.ai web
product (https://chat.z.ai) inside the user's existing authenticated browser
session — no API keys, no cookie access, no credential capture of any kind.

## Observed contract

**Observed date: 2026-08-24** (unauthenticated view of `https://chat.z.ai`,
live headless-Chromium inspection; probe session closed afterwards).

| Surface | Observation |
| --- | --- |
| Chat application | served at `https://chat.z.ai` (conversation URLs `/chat/<id>` — structure inferred from the product's routing; unauthenticated visits land on `/`) |
| Framework | React SPA (React-controlled inputs — verified: setting the composer via the native `HTMLTextAreaElement` value setter + `input` event updates app state and enables Send) |
| Composer | `<textarea id="chat-input" placeholder="How can I help you today?">` |
| Send action | `div[aria-label="Send Message"]` wrapping `button[type=submit][disabled]` (disabled while the composer is empty) |
| New conversation | `div[aria-label="New Chat"]` (sidebar) |
| History | `div[aria-label="Chat History"]` |
| Coding/agent mode | `<button>ZCode</button>` (the provider's coding-agent mode) |
| Model selector | `button[aria-label="Select a model"]` (observed label text: `GLM-4.7`) |
| Extras | `div[aria-label="Deep think enabled"]`, `div[aria-label="Upload Files"]` |
| Login wall | `Sign in` buttons rendered when unauthenticated; composer unreachable |
| Streaming/completion markers | **NOT observable unauthenticated** — see “Selector strategy” below |

## Selector strategy

All DOM knowledge lives in `zai-selectors.ts` as ordered strategy chains
(`COMPOSER`, `SEND_CONTROL`, `NEW_CHAT`, `CODING_MODE`, `MODEL_SELECTOR`,
`LOGIN_WALL`, `TRANSCRIPT`, `ERROR_SURFACES`):

1. **Semantic anchors first** — element id, `aria-label`, role, placeholder,
   `button[type=submit]` (all observed anchors above).
2. **Fallbacks** with lower confidence (generic textarea-in-form, etc.).
3. **Confidence gating** — when nothing matches, the adapter BLOCKS with
   *"Z.ai UI changed; automatic execution paused."* instead of clicking
   arbitrary controls. It never falls back to positional selectors.

Streaming/completion detection uses, in order: explicit
`[data-state="streaming"]`-style markers when present (the fixture reproduces
this pattern), a last-line status heuristic ("Thinking…" as the FINAL
transcript line), and a quiet-window stability check (transcript unchanged for
2.5s + no streaming marker + text stable across two observations). Completion
is multi-signal by design and never inferred from a single spinner or a fixed
timeout (§12).

Because the authenticated transcript DOM was not observable during
inspection, `TRANSCRIPT` targets conventional conversation-region semantics
(`[role=log]`, chat history test-ids, `main`) with the same confidence
gating — **re-verify against a signed-in session when one is available**
(this is the primary known limitation).

## Fallback strategy

- Composer/send not found (bounded 20s retry while the SPA mounts) → BLOCKED
  *"Z.ai UI changed; automatic execution paused."*
- `sha256(prompt) !== promptDigest` → BLOCKED, **submission refused**.
- Read-back mismatch after insertion → BLOCKED (never submit unverified).
- Login wall (`Sign in` visible, composer absent) → BLOCKED *"Please sign in
  to Z.ai."* — never bypassed, no credentials requested.
- Visible `role=alert` error text → classified: session expiry → BLOCKED
  (*"Z.ai session expired; please sign in."*), rate limit → failed (bounded,
  no hammering), hard failure → failed.
- Confirmation dialogs (`role=alertdialog` + confirm wording) → BLOCKED
  *"Z.ai requires user interaction."* (stop + ask — §24; never auto-click).
- Conversation scope: after submit, observations flow only while the URL
  stays inside the recorded `/chat/<id>` conversation (§16).

## Agent/coding mode (§10)

`ZCode` is the observed coding-agent control. WORK-029 detects it
(`CODING_MODE` strategies) but does **not** auto-toggle it: mode changes are
a visible user action on the provider's product, and the observed
unauthenticated view did not confirm toggle semantics. If a task requires an
explicit mode that is unavailable, the adapter BLOCKS rather than pretending
the execution started. Auto-selection may be added once signed-in inspection
confirms the control's state model (WORK-029 follow-up; see limitations).

## Known limitations

- **Authenticated DOM not yet verified.** The transcript/streaming structure,
  conversation sidebar, and post-send navigation were inferred from the
  public view + product conventions; re-verify (and extend `TRANSCRIPT`
  anchors) with a signed-in session. The deterministic fixture
  (`tests/zai/fixture/`) reproduces the observed public contract and drives
  CI.
- ZCode/mode toggling not automated (see above).
- The user's Z.ai plan must allow the coding agent; plan-gated surfaces would
  surface as BLOCKED (unsupported feature) via confidence gating.
- Multi-execution: one automation session per execution, enforced by the
  background session model + the runtime's execution-scope guard.

## Diagnosing UI changes

When the adapter starts reporting *BLOCKED — "Z.ai UI changed"*:

1. Open `https://chat.z.ai` and compare against the table above.
2. Update `zai-selectors.ts` ONLY (strategy chains + this README's table with
   a new observed date). No other file holds Z.ai DOM knowledge.
3. Mirror the change in `tests/zai/fixture/index.html` +
   `fixture-agent.js` so the deterministic suite tracks reality.
4. Run: `cd extension && bun run test && bun run build`, then the fixture
   E2E (`cd ../backend && bunx playwright test --config
   playwright-extension.config.ts tests/e2e-browser-extension/work-029-zai-adapter.spec.ts`).

## Fixture E2E

The browser E2E loads the REAL extension + REAL adapter code and drives the
LOCAL fixture server (`http://127.0.0.1:3777`, served from
`extension/tests/zai/fixture/`) reproducing the observed DOM — no live Z.ai
account or network dependency:

```
cd extension && bun install && bun run build
cd ../backend
bunx playwright test --config playwright-extension.config.ts \
  tests/e2e-browser-extension/work-029-zai-adapter.spec.ts
```

Proves: detection on the fixture (as chat.z.ai stand-in) → digest-verified
injection → submit EXACTLY once (fixture counter) → deterministic agent
progress (branch/commit/PR/tests) → completion detection → WorkflowOS
receives started/progress/completed via the scoped callback token → popup
shows the Z.ai session → login-wall BLOCKED flow with zero submissions →
XSS payload inertness.

## Optional live smoke test

An opt-in live smoke test is planned but **not shipped enabled** (no test
account is configured in this environment; per WORK-029 §31 that is not a
blocker). When a dedicated test environment exists, it will be gated behind
`ZAI_LIVE_E2E=true` (explicit opt-in, never in normal CI, dedicated test
account only, no destructive repository operations, no credentials in code
or logs — the user session is used exactly as a human would).

To run a manual live check today: load the built extension unpacked, stage
NO fixture origin (production mode), prepare an external execution with
provider `zai` in WorkflowOS, click **Open with Companion**, and watch the
popup (phase transitions + conversation reference) while confirming the
prompt lands in a NEW chat.z.ai conversation.
