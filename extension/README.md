# WorkflowOS Companion — Browser Extension

The WorkflowOS Companion is a Manifest V3 Chromium extension that bridges
**WorkflowOS external executions** to the user's **existing AI platform
session** (Z.ai / ChatGPT / Claude) and reports execution events back to
WorkflowOS — eliminating manual copy/paste.

```
WorkflowOS
  → Prepare External Session → "Open with Companion"
  → one-time handoff deep link (/companion/handoff#ref=…)
  → extension redeems the ref (no WorkflowOS API key)
  → extension opens the provider with the task
  → user interacts with the provider's native UI
  → extension observes execution progress
  → extension reports events with a scoped callback token
  → WorkflowOS observes authoritative GitHub/CI/verification/review state
```

## Status (WORK-031)

- ✅ Provider-neutral extension architecture (background service worker, thin
  content scripts, popup, message protocol, provider adapter registry).
- ✅ Secure handoff: token-only redemption, one-time, short-lived.
- ✅ Scoped callback-token event reporting with idempotency + offline
  buffering + bounded backoff.
- ✅ Deterministic **fake provider** (an extension page — no DOM scraping)
  proving the full lifecycle in dev/CI.
- ✅ **REAL Z.ai adapter (WORK-029)** — drives `https://chat.z.ai` (the
  user's existing session; prompt-digest-verified single injection;
  multi-signal completion; blocked/failure classification). See
  `src/providers/zai/README.md` for the observed UI contract + selector
  strategy + fixture E2E.
- ✅ **REAL ChatGPT adapter (WORK-030, PR #33-corrected)** — drives
  `https://chatgpt.com/codex` (the CODEX coding-agent surface — never
  conversational Chat for implementation; no silent fallback). Surface
  capability model (conversational-chat vs coding-agent + readiness) exposed
  in the popup + WorkflowOS UI; codingAgent stays 'unverified' pending live
  signed-in verification. See `src/providers/chatgpt/README.md` for the
  confidence-graded contract, surface gating, and fixture caveats.
- ⏳ Claude = WORK-031 (placeholder only — no automation).

## Local development

Requirements: Node 22+, Bun 1.3+, Chromium.

```bash
cd extension
bun install
bun run typecheck
bun run lint
bun run test        # vitest unit tests
bun run build       # → dist/ (loadable unpacked)
bun run build:watch # rebuild on change
```

### Load unpacked (Chrome / Chromium / Edge)

1. `cd extension && bun install && bun run build`
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `extension/dist`.
4. Keep the WorkflowOS frontend running at `http://localhost:5173` (the
   manifest's WorkflowOS host permission covers the dev/test origin).

### End-to-end with a real backend

The extension browser E2Es load the built extension into a persistent
Chromium context and drive the real backend + SPA:

```bash
cd extension && bun run build
cd ../backend
# WORK-028 fake + WORK-029 Z.ai + WORK-030 ChatGPT + WORK-031 Claude
# fixture loops:
bunx playwright test --config playwright-extension.config.ts
```

The WORK-029/030/031 specs start their own local fixture servers
(127.0.0.1:3777 Z.ai, 127.0.0.1:3778 ChatGPT, 127.0.0.1:3779 Claude)
reproducing the OBSERVED provider DOMs — no live accounts needed. See each
provider README for the observed contract, the optional live smoke test plans
(`ZAI_LIVE_E2E=true` / `CHATGPT_LIVE_E2E=true` / `CLAUDE_LIVE_E2E=true`, not
shipped enabled), and how to diagnose provider UI changes.

## Architecture

```
extension/
  public/manifest.json        MV3 manifest (minimal permissions; see below)
  src/
    shared/                   message protocol (typed unions), session model,
                              handoff deep-link parsing
    workflowos/               WorkflowOSClient (exactly two endpoints) +
                              ExecutionReporter (idempotency, backoff, expiry)
    providers/                provider-neutral adapter contract, detector,
                              registry, fake/ (deterministic test adapter),
                              zai/ (REAL chat.z.ai adapter), chatgpt/
                              (REAL chatgpt.com/codex adapter), claude/
                              (REAL claude.ai/code adapter) — each with
                              selectors + page runtime + observed-contract
                              README
    background/               MV3 service worker: sessions, handoff
                              redemption, adapter lifecycle, tab lifecycle,
                              message routing
    content/
      workflowos-bridge.ts    WorkflowOS origin: install handshake + handoff
                              fragment relay (thin; no domain logic)
      provider-detect.ts      provider origins: detection ONLY
    ui/
      popup/                  session dashboard (textContent-only rendering)
      fake-provider/          deterministic fake provider page (test mode)
  build.mjs                   esbuild multi-entry bundle + static copy
```

### Message protocol (§14)

`src/shared/messages.ts` defines a discriminated TypeScript union
(`CompanionMessage`) covering `WORKFLOWOS_HANDOFF`, `PROVIDER_DETECTED`,
`START_EXECUTION`, `STOP_EXECUTION`, `EXECUTION_PROGRESS`,
`EXECUTION_COMPLETED`, `EXECUTION_FAILED`, `EXECUTION_BLOCKED`,
`OPEN_PROVIDER`, plus popup queries and the install handshake. Every
envelope carries `type`, `executionId`, `timestamp`, `payload`.

### Provider adapter model

`ExternalProviderAdapter` (`src/providers/types.ts`) is provider-neutral:
`matchesPage`, `openTask`, `injectPrompt`, `observeExecution`,
`detectCompletion`, `detectFailure`, `collectObservations`, `stop`. Adapters
are registered in `ExternalProviderAdapterRegistry`.

Registered today: the **fake** adapter (deterministic test mode), the
**Z.ai** adapter (WORK-029), the **ChatGPT** adapter (WORK-030), and the
**Claude** adapter (WORK-031) — all provider DOM knowledge isolated under
`src/providers/<id>/` (see each README). No pending adapters remain.

## Security model

- **No WorkflowOS API key.** The extension never holds, requests, or sends an
  API key (statically enforced: no `x-api-key`, no `Authorization` headers).
- **Handoff:** the WorkflowOS SPA passes ONLY a one-time opaque reference in
  the `/companion/handoff#ref=…` URL **fragment** (never sent to the server;
  never contains the prompt or callback token). The extension redeems it via
  `POST /api/companion/redeem` with `x-handoff-token` — possession of the
  unconsumed token is the authority; redemption consumes it (replay → 409).
- **Callback authentication:** execution events are reported with the scoped
  `x-callback-token` (WORK-027) — bound to exactly one execution, event
  ingestion only, SHA-256-hashed at rest server-side. It cannot read
  packages, mutate workflow/verification/reviews, or anything else.
- **Token storage:** sessions + the reporter queue live in
  `chrome.storage.session` (memory-backed; survives service-worker restarts,
  cleared on browser close). Callback tokens are NEVER written to
  localStorage or disk-synced `storage.local` (statically enforced), and are
  never logged.
- **Least privilege:** permissions are `storage`, `activeTab`, `scripting`
  (the WORK-029 prompt-injection point) — no `tabs`, no `webRequest`, no
  cookies, no `<all_urls>`. Host permissions: the WorkflowOS dev/test origin
  + the supported provider domains. Production deployments add their
  WorkflowOS origin to `host_permissions`.
- **Untrusted provider output:** all provider text is data. Rendering is
  `textContent`-only; no `eval`, no `new Function`, no `innerHTML`
  (statically enforced). Model-generated shell commands are never executed;
  GitHub merges are never approved by the extension.
- **Idempotency:** every event carries a stable `idempotencyKey`
  (`<executionId>:<seq>`); retries reuse the key so duplicate delivery
  collapses server-side. Offline events buffer in memory with bounded
  backoff; when the callback credential expires, retries stop and the session
  is marked expired.

## Testing

```bash
bun run test    # handoff parsing, protocol, detection, registry neutrality,
                # reporter retry/idempotency/expiry, background lifecycle,
                # token non-persistence
```

Backend integration coverage: `backend/tests/integration/agents/companion-handoff.integration.test.ts`
(token-only redemption, one-time semantics, expiry, scope, audit) and the
WORK-027/028 security suites (callback-token isolation across executions and
routes).

## Permissions rationale

| Permission | Why |
| --- | --- |
| `storage` | `chrome.storage.session` — memory-backed session + event queue (survives service-worker restarts without persisting tokens to disk). |
| `activeTab` | Future prompt injection into the ACTIVE provider tab (WORK-029). |
| `scripting` | `chrome.scripting.executeScript` for prompt injection (WORK-029). |
| Host: WorkflowOS origin | Content-script handoff bridge + API calls (redeem/events). |
| Host: `*.z.ai` (covers the actual `chat.z.ai` chat application), `*.chatgpt.com`, `*.claude.ai` | Provider detection + (WORK-029+) adapters on those pages (+ subdomains) only — mirroring the detector's domain recognition exactly. |
