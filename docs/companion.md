# WorkflowOS Companion (Production Guide)

The **WorkflowOS Companion** is the browser extension that lets an external
AI platform (Z.ai, ChatGPT, Claude) execute a WorkflowOS Work Order inside
the user's own provider session — with WorkflowOS retaining every authority
(workflow state, verification, reviews, PR/merge observation).

## Requirements

- **Browser:** Chromium-based (Chrome 120+, Edge, Brave, …) with Manifest V3
  extension support. Firefox is not supported yet.
- **WorkflowOS:** a reachable deployment (API + SPA). The extension's
  manifest `host_permissions` must include your WorkflowOS origin — adjust
  `extension/public/manifest.json` before building for production and add
  your origin (e.g. `https://workflowos.example.com/*`) to BOTH the
  `host_permissions` and the `content_scripts` matches for
  `content/workflowos-bridge.js`.

## Installation

1. Obtain the extension build (from the repository):
   ```bash
   cd extension && bun install && bun run build
   ```
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `extension/dist`.
4. (Enterprise) distribute the packed `.crx`/`.zip` via your browser
   management tooling; the unpacked flow above is the developer path.

> Note: the Z.ai chat application is served at `https://chat.z.ai` — the
> manifest grants `https://*.z.ai/*` (domain + subdomains) so detection and
> the future Z.ai adapter (WORK-029) work on the real chat domain.

## Usage

1. In WorkflowOS, open a Work Item in `ready` / `changes_requested`.
2. **Start Implementation** → choose **External** → pick a provider
   (Z.ai / ChatGPT / Claude; real adapters arrive in WORK-029+; the
   deterministic `Fake (test)` provider is available for evaluation).
3. In the External Execution dialog, click **Open with Companion**.
   - Extension installed: the Companion opens the provider with the
     WorkflowOS task (no copy/paste) and reports progress automatically.
   - Extension NOT installed: the handoff page explains installation with a
     help link.
4. Watch status on the Work Item page (Executions card) or in the
   Companion popup.

## Security considerations

- The extension **never** holds a WorkflowOS API key, GitHub token, Vercel
  token, or provider API key.
- The WorkflowOS → extension handoff is a **one-time, short-lived opaque
  reference** transported in a URL fragment (never sent to servers, never
  containing the prompt). Redemption consumes it; replays are rejected.
- Event reporting uses a **scoped callback token** (event ingestion for ONE
  execution only; hashed at rest; short-lived). It grants no other
  capability — no package reads, no project reads, no workflow/verification/
  review mutation.
- The extension treats all provider output as untrusted data: no `eval`, no
  `innerHTML`, no automatic shell execution, no automatic GitHub approvals.
- WorkflowOS independently observes GitHub/CI/verification/review state.
  External execution can never declare PASS / APPROVED / MERGED / VERIFIED.
- Permissions are minimal and documented in `extension/README.md`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "WorkflowOS Companion not installed" | Load `extension/dist` unpacked; check it's enabled; confirm your WorkflowOS origin is in the manifest host permissions. |
| Handoff fails with `handoff-token-expired` (410) | Handoff references live ~15 minutes. Start a fresh external session. |
| Session shows `expired` | The external handoff window elapsed without completion — re-run the execution. |
| Events buffered / "Offline" badge | WorkflowOS is unreachable; the Companion retries with bounded backoff and resends with the same idempotency keys. |
