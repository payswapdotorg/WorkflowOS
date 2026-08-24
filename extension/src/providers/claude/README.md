# Claude Provider Adapter — Observed UI Contract

The REAL Claude adapter for the WorkflowOS Companion. It drives the Claude
web product inside the user's existing authenticated browser session — no
Anthropic API replacement, no cookie access, no credential capture of any
kind.

## Hosts: canonical current + legacy/redirect (PR #34)

Anthropic's product has migrated to `claude.com` as the canonical host. The
adapter treats both domains as supported — `claude.com` is the **current
canonical** host (where the prompt lands), `claude.ai` is the **legacy /
redirect host** (still matched for the brief pre-redirect page + bookmarked
sessions). Without owning BOTH, the extension could pass local fixtures
while failing in the real browser after the redirect, because the Claude
content script would have no host permission on the canonical host.

| Host | Role | Confidence | Observed behavior |
| --- | --- | --- | --- |
| `https://claude.com/code` | **Canonical CURRENT** Claude Code on the web entry point | HIGH (official Anthropic material now identifies `claude.com/code`) | `openTask()` targets this URL; detector recognizes `*.claude.com`; manifest grants `https://*.claude.com/*`; bridge content script runs on `*.claude.com`. |
| `https://claude.ai/code` (and `/chat/<uuid>`) | **Legacy / redirect** host | HIGH (well-established; still live) | Live inspection observed `claude.ai → claude.com` redirect (region-blocked from build env — see "Live inspection caveat" below). `matchesPage()` accepts `claude.ai`; detector recognizes `*.claude.ai`; manifest grants `https://*.claude.com/*` AND `https://*.claude.ai/*` so the bridge attaches before AND after the redirect; the post-redirect page on `claude.com` is where the prompt actually lands, so the host permission on `claude.com` is **non-negotiable**. |
| `https://claude.com` (apex) + subdomains | Canonical current app/landing host | HIGH | Detector + manifest own apex + subdomains (mirrors the Z.ai `*.z.ai` form — covers the actual chat application wherever it lives). |
| `https://claude.ai` (apex) + subdomains | Legacy app/landing host | HIGH (still live; redirects to claude.com) | Detector + manifest own apex + subdomains. The brief pre-redirect page on `claude.ai` is matched so the bridge attaches immediately; if the user has a bookmarked `claude.ai` URL, the redirect still delivers them to the canonical host where the bridge re-attaches. |

Conversation URL paths (`/code/<task-id>`, `/chat/<uuid>`, `/projects`, root)
are host-independent. Surface detection in `claude-page-runtime.ts::detectSurface()`
reads ONLY `location.pathname`, so the same detection logic works on both
`claude.com` and `claude.ai` (the redirect does not change the conversation
path).

## Surfaces: Chat / Projects / Claude Code

The Claude product distinguishes conversational **Chat** (`claude.com/chat`),
**Projects**, and **Claude Code on the web** — the dedicated coding
environment for repositories, tests, and engineering changes at
**`https://claude.com/code`** (HIGH confidence: official Anthropic docs —
`code.claude.com/docs/en/web-quickstart`: *"After signing in, claude.com/code
prompts you to connect GitHub"*; the docs overview: *"Start coding at
claude.com/code"*; routines at `claude.com/code/routines`). Earlier
documentation referenced `claude.ai/code`; current Anthropic material uses
`claude.com/code` and `claude.ai` redirects to `claude.com`.

WorkflowOS implementation Work Orders **must execute on the coding-agent
surface**:

- `openTask` opens **`https://claude.com/code`** (never the conversational
  root; PR #34: canonical current host — targeting `claude.com/code`
  directly avoids a redirect hop and ensures the content script — granted
  host permission on `claude.com` — actually runs on the page the prompt
  lands on).
- The page runtime detects the surface BEFORE anything else (after the login
  wall): `/code` → coding-agent (HIGH — official URL); `/chat/<uuid>` or the
  root/new-chat → conversational-chat; `/projects` → projects; else unknown.
- **Implementation + non-coding surface → BLOCKED** *"Claude coding
  environment unavailable or unverified."* — the prompt is NEVER injected
  into conversational Claude and the adapter NEVER silently falls back
  (§5: the decision comes from the real provider architecture — Claude Code
  IS a distinct product surface, per Anthropic's own docs).
- Conversational Chat support is kept for `taskKind: 'conversational'` tasks.
- Surface capabilities: `conversationalChat: 'ready'` (well-established),
  `codingAgent: 'unverified'`, `implementationSurface: 'coding-agent'`.
  `'unverified'` holds until a **live signed-in verification pass** — per the
  WORK-030 review precedent, fixture-only proof is deliberately insufficient;
  the runtime re-verifies the actual page surface on every execution.

## Observed contract

**Observed date: 2026-08-24 (PR #34 update).** ⚠️ **Confidence caveat:** live
inspection was blocked from the build environment by a **region
restriction** (`claude.com/app-unavailable-in-region` — `claude.ai` redirects
to `claude.com`). The `claude.ai → claude.com` redirect was observed during
live inspection. Anchors below are assembled from current userscripts and
official Claude Code docs, graded by confidence. The adapter is
**confidence-gated**: missing HIGH-confidence anchors BLOCK safely
(*"Claude UI changed; automatic execution paused."*) rather than guessing
(§21).

| Surface | Observation | Confidence |
| --- | --- | --- |
| App domain (canonical) | `https://claude.com` | HIGH (current Anthropic material) |
| App domain (legacy/redirect) | `https://claude.ai` — redirects to `claude.com` | HIGH (observed redirect) |
| Coding surface (canonical) | `claude.com/code` — Claude Code on the web (tasks in cloud environments, GitHub connect) | HIGH (official docs) |
| Coding surface (legacy) | `claude.ai/code` — redirects to `claude.com/code` | HIGH (still live; redirect) |
| Conversations | `claude.com/chat/<uuid>`; `claude.ai/chat/<uuid>` redirects; new-chat via the root / sidebar "New Chat" | HIGH |
| Composer | `div.ProseMirror[contenteditable="true"]` (Claude's ProseMirror editor; generic contenteditable fallbacks kept) | HIGH (userscripts) |
| Composer injection | `focus()` → `selectAll` → `execCommand('insertText')` through the editor pipeline | HIGH (standard ProseMirror path) |
| Send | `button[aria-label="Send message"]` (case variants + `data-testid="send-button"` fallback) | HIGH (userscripts) |
| Streaming marker | `button[aria-label*="Stop"]` (*"Stop Claude response"*) while generating | HIGH (userscripts) |
| Assistant messages | `[data-testid="assistant-message"]` | MEDIUM |
| Login wall | Sign-in redirect; `Log in` / `Sign up` buttons; `/login` path | MEDIUM |
| Model selector | Present (Sonnet/Opus/Haiku dropdown) — **never auto-selected** (§10) | MEDIUM |

## Selector strategy

All DOM knowledge lives in `claude-selectors.ts` as ordered strategy chains:
HIGH-confidence anchors first (ProseMirror composer, aria-label send/stop),
then MEDIUM fallbacks (data-testid, generic form roles). Nothing matches →
BLOCKED (*"Claude UI changed; automatic execution paused."*). No nth-child,
no generated classes, no coordinates. Transcript extraction joins ALL
assistant messages in DOM order (single-message regions strand stale status
lines — lesson from WORK-030).

## Prompt injection + read-back (§8/§9)

Identical to the WORK-030-proven path: `sha256(prompt) === promptDigest`
verified BEFORE any focus/insertion/send (mismatch → BLOCKED, zero
submissions); ProseMirror-safe injection (`focus` → `selectAll` →
`execCommand('insertText')`); read-back via the `<br>`/block-aware
contenteditable text extractor + normalization applied to BOTH sides
(contenteditable represents newlines as breaks — normalized equality is the
documented §8 interpretation). Read-back failure → BLOCKED.

## Failure / blocked / confirmation handling

| Surface | Classification |
| --- | --- |
| Login wall (buttons or `/login` path) | BLOCKED *"Please sign in to Claude."* |
| Session-expiry error text | BLOCKED *"Claude session unavailable; please sign in again."* |
| Rate/usage limit text | `failed` (bounded — observation stops, never hammered) |
| Hard provider failure text | `failed`, monitoring stops |
| Ambiguous/consequential dialog wording | BLOCKED *"Claude requires user confirmation."* (§16 stop + ask — never auto-clicked) |
| Composer/send not found (bounded 20s) | BLOCKED *"Claude UI changed; automatic execution paused."* |
| Implementation on non-coding surface | BLOCKED *"Claude coding environment unavailable or unverified."* |

## Repository observations (§17)

branch / commit / pull request / tests mentioned in Claude output →
**observations only** via the existing execution-event path. Never
PR_OPEN/PASS/APPROVED/MERGED/VERIFIED — WorkflowOS/GitHub stay authoritative.

## Reload / recovery (§19)

`promptSubmitted` persisted (background, chrome.storage.session) + in-page
per-execution guard → re-attach is **observe-only**. Conversation/task
scoping: observations flow only while the URL stays inside the recorded
`/chat/<uuid>` or `/code/<id>` path.

## Known limitations

- **Live DOM not verified from this environment** (region block). HIGH
  anchors come from current userscripts + official docs; a signed-in live
  verification pass should confirm composer/send/streaming anchors and
  extend the Claude Code task-surface anchors (task list, environments
  panel). Fail-safe confidence gating covers drift.
- Claude Code web task-creation anchors ("New task/session") are MEDIUM —
  the URL is the HIGH-confidence signal; the runtime gates on it.
- The `claude.ai → claude.com` redirect was observed during live inspection
  but the redirect target's actual DOM was region-blocked from this build
  environment. The adapter's host-agnostic path-based surface detection +
  the dual-host manifest grants are the mitigation; the optional live smoke
  test (below) is the follow-up verification.
- Mobile app, Cowork, routines, and IDE extensions are not automated.
- One automation session per execution (background session model + in-page
  scope guard).

## Diagnosing UI changes

When the adapter reports *BLOCKED — "Claude UI changed"*:

1. Open `https://claude.com` (signed in; `claude.ai` will redirect here)
   and compare against the table above (update confidence + observed date).
2. Update `claude-selectors.ts` ONLY — no other file holds Claude DOM
   knowledge.
3. Mirror the change in `tests/claude/fixture/` so the deterministic suite
   tracks reality.
4. Run: `cd extension && bun run test && bun run build`, then the fixture
   E2E (below).

## Fixture testing

**Caveat:** fixtures prove ADAPTER MECHANICS deterministically in CI — NOT
that the real signed-in Claude Code surface works. Catalog readiness stays
'unverified' until live verification; the runtime re-verifies the page
surface on every execution. The fixture is served at `http://127.0.0.1:3779`
(the host is irrelevant — the runtime's surface detection reads only the
path, so the fixture exercises the same detection logic the real
`claude.com`/`claude.ai` pages hit at runtime).

Local fixtures at `http://127.0.0.1:3779` (served from
`extension/tests/claude/fixture/`):

- **`/code/`** — the CODING-AGENT fixture (Claude Code task surface: task
  composer, environments sidebar, task URLs `/code/t/<id>`, aria-label
  send/stop) — drives the implementation happy path.
- **`/`** — the conversational Chat fixture — proves the NO-FALLBACK block
  (implementation on a Chat-only page → BLOCKED, zero submissions).
- Variants: `wall=login` · `fail=1` · `confirm=1` · `xss=1`.

```
cd extension && bun install && bun run build
cd ../backend
bunx playwright test --config playwright-extension.config.ts \
  tests/e2e-browser-extension/work-031-claude-adapter.spec.ts
```

## Optional live smoke test

Not shipped enabled — no dedicated Claude test account (per §28 not a
blocker). Opt-in plan: `CLAUDE_LIVE_E2E=true` (explicit opt-in; never normal
CI; dedicated test account; harmless prompt; non-destructive; no credential
logging; no cookie extraction). Minimum: detect Claude → open `claude.com/code`
(canonical current host; `claude.ai` would redirect here anyway) → inject
harmless prompt → submit once → observe completion. This is the live
verification pass that would flip `codingAgent` from `'unverified'` to
`'ready'`.

Manual live check today: load the built extension unpacked, stage NO fixture
origin, prepare an external execution with provider `claude` in WorkflowOS,
click **Open with Companion**, and watch the popup (phase transitions +
task reference) while confirming the prompt lands in a NEW Claude Code task
at `claude.com/code` (or `claude.ai/code` which redirects there).
