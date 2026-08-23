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
}

interface CompanionState {
  session: SessionView | null;
  connection: 'connected' | 'offline';
  pendingEvents: number;
  providers: { providerId: string; supported: boolean; adapterAvailable: boolean }[];
  pendingProviderMetadata: { providerId: string; displayName: string; workItem: string }[];
}

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
    el('provider').textContent = s.providerLabel || s.provider;
    el('repository').textContent = s.repository ?? '(not linked)';
    el('branch').textContent = s.branch;
    el('status').textContent = s.status;
    el('execution-id').textContent = s.executionId;
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
