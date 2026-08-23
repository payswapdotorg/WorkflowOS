/**
 * WorkflowOS Companion — popup (§18).
 *
 * Shows the current execution session (work item, provider, repository,
 * branch, status), the WorkflowOS connection state, buffered-event count,
 * and the provider capability list. Actions: open provider, resume, stop,
 * open WorkflowOS. All rendering uses textContent — provider output is
 * untrusted data and is never injected as HTML (§22).
 */
import { message } from '../../shared/messages.js';

interface SessionView {
  executionId: string;
  provider: string;
  providerLabel: string;
  workItemLabel: string;
  repository: string | null;
  branch: string;
  status: string;
  workflowosOrigin: string;
  promptSubmitted: boolean;
  phase: string | null;
  blockedReason: string | null;
  externalSessionRef: string | null;
}

/** WORK-029 §26: status glyph + tone. */
const STATUS_ICONS: Record<string, string> = {
  connecting: '…',
  ready: '●',
  running: '●',
  completed: '✓',
  failed: '✕',
  blocked: '⚠',
  stopped: '■',
  expired: '⏱',
};

interface ProviderSurfaces {
  conversationalChat: 'ready' | 'unverified' | 'not-available';
  codingAgent: 'ready' | 'unverified' | 'not-available';
  implementationSurface: 'conversational-chat' | 'coding-agent';
}

interface CompanionState {
  session: SessionView | null;
  connection: 'connected' | 'offline';
  pendingEvents: number;
  providers: {
    providerId: string;
    displayName: string;
    supported: boolean;
    adapterAvailable: boolean;
    surfaces?: ProviderSurfaces;
  }[];
  pendingProviderMetadata: { providerId: string; displayName: string; workItem: string }[];
}

const READINESS_LABEL: Record<ProviderSurfaces['conversationalChat'], string> = {
  ready: 'Available',
  unverified: 'Unverified',
  'not-available': 'Not available',
};

function send(msg: unknown): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function render(state: CompanionState): void {
  const connection = el<HTMLSpanElement>('connection');
  connection.textContent = state.connection === 'connected' ? 'Connected' : 'Offline';
  connection.className = `badge ${state.connection}`;

  const noSession = el<HTMLElement>('no-session');
  const sessionSection = el<HTMLElement>('session');
  if (!state.session) {
    noSession.classList.remove('hidden');
    sessionSection.classList.add('hidden');
  } else {
    noSession.classList.add('hidden');
    sessionSection.classList.remove('hidden');
    const s = state.session;
    el('work-item').textContent = s.workItemLabel;
    // Display label: the capability list (registry) knows real display names.
    const display =
      state.providers.find((p) => p.providerId === s.provider)?.displayName ??
      state.pendingProviderMetadata.find((p) => p.providerId === s.provider)?.displayName ??
      s.providerLabel ??
      s.provider;
    el('provider').textContent = display;
    el('repository').textContent = s.repository ?? '(not linked)';
    el('branch').textContent = s.branch;
    const icon = STATUS_ICONS[s.status] ?? '●';
    el('status').textContent = `${icon} ${s.phase ? `${s.phase} · ` : ''}${s.status}`;
    el('execution-id').textContent = s.executionId;
    // §26: blocked reason + external conversation link.
    const reasonEl = document.getElementById('blocked-reason');
    if (reasonEl) {
      reasonEl.textContent = s.blockedReason ?? '';
      reasonEl.classList.toggle('hidden', !s.blockedReason);
    }
    const convEl = document.getElementById('conversation');
    if (convEl) {
      convEl.textContent = s.externalSessionRef ?? '—';
    }
    const pendingRow = el<HTMLElement>('pending-row');
    if (state.pendingEvents > 0) {
      pendingRow.classList.remove('hidden');
      el('pending').textContent = String(state.pendingEvents);
    } else {
      pendingRow.classList.add('hidden');
    }
  }

  const list = el<HTMLUListElement>('providers');
  list.replaceChildren();
  for (const p of state.providers) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent =
      state.pendingProviderMetadata.find((m) => m.providerId === p.providerId)?.displayName ??
      p.providerId;
    const status = document.createElement('span');
    status.textContent = p.adapterAvailable ? 'ready' : 'adapter pending';
    status.className = p.adapterAvailable ? '' : 'pending';
    li.append(name, status);
    // WORK-030 (PR #33 review): surface readiness — Conversational vs
    // Coding Agent — so the user sees which execution surface is usable.
    if (p.surfaces) {
      const cap = document.createElement('li');
      cap.className = 'capabilities';
      const conv = document.createElement('span');
      conv.textContent = `Conversational: ${READINESS_LABEL[p.surfaces.conversationalChat]}`;
      const coding = document.createElement('span');
      coding.textContent = `Coding Agent: ${READINESS_LABEL[p.surfaces.codingAgent]}`;
      cap.append(conv, coding);
      li.append(cap);
    }
    list.append(li);
  }
}

async function refresh(): Promise<void> {
  try {
    const state = (await send(message('GET_STATE', null, {}))) as CompanionState;
    if (state) render(state);
  } catch {
    // Background not ready — leave the last render.
  }
}

el('open-provider').addEventListener('click', () => {
  void send(message('OPEN_PROVIDER', null, {}));
  setTimeout(refresh, 400);
});
el('resume').addEventListener('click', () => {
  void send(message('RESUME_SESSION', null, {}));
  setTimeout(refresh, 400);
});
el('stop').addEventListener('click', () => {
  void send(message('STOP_EXECUTION', null, {}));
  setTimeout(refresh, 400);
});
el('open-workflowos').addEventListener('click', async () => {
  const state = (await send(message('GET_STATE', null, {}))) as CompanionState | null;
  const origin = state?.session?.workflowosOrigin ?? 'http://localhost:5173';
  void chrome.tabs.create({ url: origin });
});

void refresh();
setInterval(refresh, 1000);
