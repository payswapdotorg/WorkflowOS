# ChatGPT Provider Adapter — Observed UI Contract

The REAL ChatGPT adapter for the WorkflowOS Companion. It drives the ChatGPT
web product (https://chatgpt.com) inside the user's existing authenticated
browser session — no OpenAI API calls, no cookie access, no credential
capture of any kind.

## Surfaces (PR #33 review): Chat vs Work vs Codex

The current ChatGPT product distinguishes **Chat** (conversational),
**Work**, and **Codex** — the dedicated coding environment (repositories,
tests/commands, engineering changes). WorkflowOS implementation Work Orders
**must execute on the coding-agent surface**:

- `openTask` opens **`https://chatgpt.com/codex`** (OpenAI's official Codex
  web-app URL — HIGH confidence).
- The page runtime detects the surface BEFORE anything else (after the login
  wall): URL `/codex` → coding-agent (HIGH); `/c/<uuid>` or the root →
  conversational-chat; `/work` → work; anything else → unknown.
- **Implementation + non-Codex surface → BLOCKED** *"ChatGPT coding
  environment unavailable or unverified."* — the prompt is NEVER injected
  into a conversational Chat and the adapter NEVER silently falls back.
- Conversational Chat support is KEPT for `taskKind: 'conversational'`
  tasks (the capability model distinguishes the surfaces; the bridge marks
  WorkflowOS external executions as `implementation`).
- Surface readiness is a **capability model** surfaced in both the
  WorkflowOS UI and the extension popup: `conversationalChat` / `codingAgent`
  ∈ {ready, unverified, not-available} + `implementationSurface`. ChatGPT's
  `codingAgent` stays **'unverified'** until a live signed-in verification
  pass — per the review, **fixture-only proof is deliberately insufficient**;
  a static check guards the catalog value so flipping it to 'ready' is a
  conscious act.
- Model/mode names are still never assumed (§9): Codex task-creation
  anchors are MEDIUM confidence and confidence-gated.

## Observed contract

**Observed date: 2026-08-24.** ⚠️ **Confidence caveat:** live inspection from
the build environment was **blocked** by the provider's edge firewall
(Cloudflare “Unable to load site” for every chatgpt.com /
chat.openai.com request, both direct and via headless Chromium). The contract
below was assembled from **current public sources** (Stack Overflow,
userscript/automation discussions, provider community threads) and is
therefore graded by confidence. The adapter is **confidence-gated**: when a
HIGH-confidence anchor is absent it BLOCKS with *“ChatGPT UI changed;
automatic execution paused.”* rather than guessing (§31).

| Surface | Observation | Confidence |
| --- | --- | --- |
| Production domain | `https://chatgpt.com` (legacy `chat.openai.com` redirects there) | HIGH |
| Conversation URLs | `https://chatgpt.com/c/<uuid>` after the first message | HIGH |
| Composer | `div#prompt-textarea[contenteditable="true"]` — a **ProseMirror** contenteditable (the historical `textarea#prompt-textarea` form is kept as an explicit fallback strategy) | HIGH |
| Composer injection | `focus()` → `document.execCommand('selectAll')` → `document.execCommand('insertText', false, prompt)` — goes through the editor's own input pipeline so app state updates and Send enables | HIGH (standard ProseMirror path) |
| Send action | `button[data-testid="send-button"]` (disabled while empty) | HIGH |
| Streaming marker | `button[data-testid="stop-button"]` visible while generating | HIGH |
| Assistant messages | `[data-message-author-role="assistant"]` | MEDIUM |
| New chat | The `chatgpt.com` ROOT renders a fresh composer (deterministic new-task path); sidebar “New chat” action + ⌘N/⌘⇧O shortcuts also exist | MEDIUM |
| Login wall | Unauthenticated visits land on `Log in` / `Sign up` surfaces; auth redirect paths `/auth/login` / `/auth/signup` | MEDIUM |
| Model/mode selector | Present in the composer area; **names/labels deliberately NOT assumed** (§9) | LOW — detect-only |

## Selector strategy

All DOM knowledge lives in `chatgpt-selectors.ts` as ordered strategy chains
(`COMPOSER`, `SEND_CONTROL`, `NEW_CHAT`, `MODE_CONTROL`, `STREAMING_MARKER`,
`LOGIN_WALL`, `TRANSCRIPT`, `ERROR_SURFACES`):

1. **HIGH-confidence anchors first** — stable ids / `data-testid` attributes
   observed in current sources.
2. **Fallbacks** with lower confidence (aria-labels, generic form roles).
3. **Confidence gating** — nothing matches → BLOCKED (*“ChatGPT UI changed;
   automatic execution paused.”*), never positional selectors, never guessed
   clicks.

Transcript extraction prefers the assistant-message anchor and **joins all
assistant messages in DOM order** (a single-message region would strand stale
status lines at the tail and wedge completion detection).

## Prompt injection + read-back (§8)

The prompt is inserted **exactly** as produced by WorkflowOS:

- **contenteditable (current product):** `focus` → `selectAll` →
  `execCommand('insertText')` — the editor pipeline records the change (app
  state + send-enable). In test environments without `execCommand` (jsdom),
  a documented fallback sets `textContent` + fires an `input` event.
- **textarea (historical fallback):** native `HTMLTextAreaElement` value
  setter + `input` event (React-compatible).
- **Read-back verification:** the composer's text is read back and compared
  after **normalization** (`\u00a0`→space, zero-width stripped, `\r\n`→`\n`,
  trimmed) — contenteditable represents newlines as block elements, so
  byte-for-byte comparison is impossible; §8's “where the browser
  representation allows” is interpreted as *normalized equality*, documented
  here. Mismatch → BLOCKED, nothing submitted.
- **Digest:** `sha256(prompt) === execution.promptDigest` is verified
  **before** any insertion attempt; mismatch → BLOCKED, submission refused.

## Model / mode behavior (§9/§10)

The adapter does **not** assume model names, agent names, or mode semantics.
`MODE_CONTROL` strategies detect conventional model-switcher surfaces for
reporting only. Nothing is auto-selected or substituted: if a Work Order
required a specific model/mode that cannot be confidently validated as
available, the adapter BLOCKS with a specific reason rather than silently
substituting. With no requirement, the provider's default user-visible
configuration is used (the new-chat composer as the user sees it). Codex /
agent surfaces were not observable in this research pass — treat agent-mode
automation as unavailable until a live signed-in inspection documents it.

## Completion signals (§13)

Multi-signal + debounce, in this order:

1. `button[data-testid="stop-button"]` **hidden** (the product's own
   generating indicator — HIGH confidence),
2. transcript text **stable** across the quiet window (2.5s),
3. no last-line status word (“Thinking…”-style) on the final assistant
   message.

Never a single weak signal (empty composer, one spinner frame, network idle,
fixed timeout).

## Failure / blocked / confirmation handling

| Surface | Classification |
| --- | --- |
| Login wall (buttons or `/auth/login` path) | BLOCKED *“Please sign in to ChatGPT.”* |
| Session-expiry error text | BLOCKED *“ChatGPT session unavailable; please sign in again.”* |
| Rate-limit / usage-limit text | `failed` (bounded — observation stops, provider never hammered) |
| Hard provider failure text | `failed`, monitoring stops |
| Ambiguous/consequential dialog wording | BLOCKED *“ChatGPT requires user confirmation.”* (§16 stop + ask — never auto-clicked) |
| Composer/send not found (bounded 20s) | BLOCKED *“ChatGPT UI changed; automatic execution paused.”* |

## Repository observations (§17)

branch / commit / pull request / tests mentioned in ChatGPT output are
extracted as **observations only** and forwarded through the existing
execution-event path. Never PR_OPEN / MERGED / VERIFIED / PASS / APPROVED —
WorkflowOS and GitHub stay authoritative.

## Reload / recovery (§19)

`promptSubmitted` is persisted by the background (chrome.storage.session);
the page runtime keeps an additional in-page per-execution guard. After a
page reload the bridge re-attaches **observe-only** — the prompt is never
resubmitted. Conversation scoping: after submit, observations flow only
while the URL stays inside the recorded `/c/<uuid>` conversation.

## Known limitations

- **Live DOM not verified from this environment** (edge-firewall block).
  HIGH-confidence anchors come from current public sources; a signed-in live
  verification pass should confirm the composer/send/streaming anchors and
  extend `TRANSCRIPT`/`MODE_CONTROL` if needed. Fail-safe behavior covers
  drift (confidence gating → BLOCKED).
- The authenticated sidebar, canvas/projects surfaces, Codex agent mode, and
  attachment flows were not observable and are not automated.
- Read-back equality is *normalized*, not byte-for-byte (contenteditable
  representation — see above).
- One automation session per execution (background session model + in-page
  scope guard).

## Diagnosing UI changes

When the adapter reports *BLOCKED — “ChatGPT UI changed”*:

1. Open `https://chatgpt.com` signed in and compare against the table above
   (update the **Confidence** column with the new observed date).
2. Update `chatgpt-selectors.ts` ONLY. No other file holds ChatGPT DOM
   knowledge.
3. Mirror the change in `tests/chatgpt/fixture/` (index.html +
   fixture-agent.js) so the deterministic suite tracks reality.
4. Run: `cd extension && bun run test && bun run build`, then the fixture
   E2E (below).

## Fixture testing

**Caveat (PR #33 review):** fixtures prove the ADAPTER MECHANICS
deterministically in CI — they are NOT proof that the real signed-in Codex
surface works. The catalog readiness stays 'unverified' until live
verification; the runtime re-verifies the actual page surface on every
execution.

The browser E2E loads the REAL extension + REAL adapter code against LOCAL
fixtures (`http://127.0.0.1:3778`, served from
`extension/tests/chatgpt/fixture/`):

- **`/codex/`** — the CODING-AGENT fixture (Codex task surface: "New task"
  composer, task list, environments sidebar, `/codex/t/<id>` task URLs,
  `data-testid` send/stop) — drives the implementation happy path.
- **`/`** — the conversational Chat fixture — proves the NO-FALLBACK block
  (implementation on a Chat-only page → BLOCKED with zero submissions).
- Variants on both: `wall=login` · `fail=1` · `confirm=1` · `xss=1`.

```
cd extension && bun install && bun run build
cd ../backend
bunx playwright test --config playwright-extension.config.ts \
  tests/e2e-browser-extension/work-030-chatgpt-adapter.spec.ts
```

Proves: detection on the fixture → digest-verified injection into the
contenteditable composer → submit EXACTLY once (fixture counter) →
conversation created (`/c/<uuid>`) → stop-button streaming marker lifecycle →
deterministic agent progress (branch/commit/PR/tests) → completion detection
→ WorkflowOS receives started/progress/completed via the scoped callback
token → popup shows the ChatGPT session → login-wall BLOCKED flow with zero
submissions → XSS payload inertness.

## Optional live smoke test

Not shipped enabled — no dedicated ChatGPT test account exists in this
environment (per §30 not a blocker). The opt-in plan: `CHATGPT_LIVE_E2E=true`
(explicit opt-in; never in normal CI; dedicated test account; harmless
trivial prompt; no destructive repository actions; no credential logging; no
cookie extraction — the user session is used exactly as a human would).

Manual live check today: load the built extension unpacked, stage NO fixture
origin, prepare an external execution with provider `chatgpt` in WorkflowOS,
click **Open with Companion**, and watch the popup (phase transitions +
conversation reference) while confirming the prompt lands in a NEW chatgpt.com
conversation.
