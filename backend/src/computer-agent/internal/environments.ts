/**
 * V2-008 — the host environment ports + deterministic scripted environments.
 *
 * An environment is what a host adapter drives: a browser session, a
 * desktop (filesystem + screen + applications), or a phone. The PORTS are
 * the module's own injection seams; the SCRIPTED implementations are
 * deterministic (injected state + script queues, no wall clock, no random)
 * and power the unit/integration batteries. The REAL filesystem desktop
 * environment (dogfooding host) lives in real-desktop-environment.ts.
 *
 * Constitution §4/§12: platform differences appear ONLY through these
 * environments and the capabilities each host class advertises — never
 * through different protocol semantics.
 */
import { observedElement } from './host-protocol.js';
import type { ObservedElement } from '../types.js';

// ============================================================================
// §0 The browser session environment (web host class)
// ============================================================================

/** A browser page element as the environment exposes it. */
export interface BrowserPageElement {
  readonly elementId: string;
  readonly kind: 'text' | 'button' | 'link' | 'input' | 'select';
  readonly label: string;
  readonly state: string;
}

/** The browser session environment port (the web adapter drives this). */
export interface BrowserSessionEnvironment {
  currentUrl(): string;
  navigate(url: string): void;
  snapshot(): readonly BrowserPageElement[];
  click(elementId: string): void;
  type(elementId: string, text: string): void;
  select(elementId: string, value: string): void;
  download(elementId: string): string;
  upload(elementId: string, content: string): void;
}

/**
 * The deterministic scripted browser environment: an in-memory page model.
 * Tests inject pages and drive external changes (e.g. mutate the page
 * between observe and act to prove wrong-target prevention).
 */
export class ScriptedBrowserEnvironment implements BrowserSessionEnvironment {
  private url = 'about:blank';
  private readonly elements = new Map<string, BrowserPageElement>();
  private readonly downloads: string[] = [];
  private uploaded: { elementId: string; content: string } | null = null;

  constructor(pages: readonly { url: string; elements: readonly BrowserPageElement[] }[] = []) {
    for (const page of pages) {
      this.loadPage(page.url, page.elements);
    }
    const first = pages[0];
    if (first) {
      this.url = first.url;
    }
  }

  private loadPage(url: string, elements: readonly BrowserPageElement[]): void {
    this.url = url;
    this.elements.clear();
    for (const element of elements) {
      this.elements.set(element.elementId, element);
    }
  }

  currentUrl(): string {
    return this.url;
  }

  navigate(url: string): void {
    this.url = url;
  }

  snapshot(): readonly BrowserPageElement[] {
    return [...this.elements.values()].sort((a, b) => a.elementId.localeCompare(b.elementId));
  }

  click(elementId: string): void {
    const element = this.elements.get(elementId);
    if (!element) {
      throw new Error(`browser environment: no element "${elementId}"`);
    }
    this.elements.set(elementId, { ...element, state: 'clicked' });
  }

  type(elementId: string, text: string): void {
    const element = this.elements.get(elementId);
    if (!element) {
      throw new Error(`browser environment: no element "${elementId}"`);
    }
    this.elements.set(elementId, { ...element, state: text });
  }

  select(elementId: string, value: string): void {
    const element = this.elements.get(elementId);
    if (!element) {
      throw new Error(`browser environment: no element "${elementId}"`);
    }
    this.elements.set(elementId, { ...element, state: value });
  }

  download(elementId: string): string {
    const element = this.elements.get(elementId);
    if (!element) {
      throw new Error(`browser environment: no element "${elementId}"`);
    }
    const payload = `download:${element.label}`;
    this.downloads.push(payload);
    return payload;
  }

  upload(elementId: string, content: string): void {
    const element = this.elements.get(elementId);
    if (!element) {
      throw new Error(`browser environment: no element "${elementId}"`);
    }
    this.uploaded = { elementId, content };
    this.elements.set(elementId, { ...element, state: 'uploaded' });
  }

  // ---- script hooks (deterministic external-change injection) ----

  /** External change: replace an element's state (wrong-target tests). */
  mutateElement(elementId: string, state: string): void {
    const element = this.elements.get(elementId);
    if (!element) {
      throw new Error(`browser environment: no element "${elementId}"`);
    }
    this.elements.set(elementId, { ...element, state });
  }

  /** External change: remove an element (target-gone tests). */
  removeElement(elementId: string): void {
    this.elements.delete(elementId);
  }

  /** Audit accessors (tests only). */
  get downloaded(): readonly string[] {
    return this.downloads;
  }

  get lastUpload(): { elementId: string; content: string } | null {
    return this.uploaded;
  }
}

// ============================================================================
// §1 The desktop environment (filesystem + screen + applications)
// ============================================================================

/** A directory entry as the desktop environment exposes it. */
export interface DesktopDirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
}

/** A screen element (windows/controls) as the environment exposes it. */
export interface DesktopScreenElement {
  readonly elementId: string;
  readonly kind: 'window' | 'button' | 'text' | 'input';
  readonly label: string;
  readonly state: string;
}

/**
 * The desktop environment port (the desktop adapter drives this). Paths are
 * host-relative POSIX-style strings; the REAL implementation roots them at
 * a sandbox directory (real node:fs — dogfooding host).
 */
export interface DesktopEnvironment {
  /**
   * Awaitable-union: the scripted implementation is synchronous; the REAL
   * filesystem implementation (dogfooding host) is async. The host adapter
   * always awaits — both satisfy this port.
   */
  listDirectory(path: string): readonly DesktopDirectoryEntry[] | Promise<readonly DesktopDirectoryEntry[]>;
  readFile(path: string): string | null | Promise<string | null>;
  /** Strict write: throws when the parent directory does not exist. */
  writeFile(path: string, content: string): void | Promise<void>;
  screenState(): readonly DesktopScreenElement[];
  openApplication(application: string): void;
  interact(elementId: string, action: string, text?: string): void;
}

/**
 * The deterministic scripted desktop environment: in-memory files, screen
 * and application state. Tests mutate files externally between observe and
 * act (real-change wrong-target proofs) and script transient failures.
 */
export class ScriptedDesktopEnvironment implements DesktopEnvironment {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();
  private screen: readonly DesktopScreenElement[] = [];
  private openedApplications: string[] = [];
  private interactions: { elementId: string; action: string; text?: string }[] = [];
  private writeFileFailuresRemaining = 0;

  constructor(initial: {
    files?: readonly { path: string; content: string }[];
    directories?: readonly string[];
    screen?: readonly DesktopScreenElement[];
  } = {}) {
    for (const file of initial.files ?? []) {
      this.files.set(file.path, file.content);
    }
    for (const directory of initial.directories ?? []) {
      this.directories.add(directory);
    }
    this.screen = [...(initial.screen ?? [])];
  }

  listDirectory(path: string): readonly DesktopDirectoryEntry[] {
    if (path !== '/' && !this.directories.has(path)) {
      throw new Error(`desktop environment: no directory "${path}"`);
    }
    const entries: DesktopDirectoryEntry[] = [];
    for (const directory of this.directories) {
      if (parentOf(directory) === path) {
        entries.push({ name: baseName(directory), kind: 'directory' });
      }
    }
    for (const file of this.files.keys()) {
      if (parentOf(file) === path) {
        entries.push({ name: baseName(file), kind: 'file' });
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  readFile(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  writeFile(path: string, content: string): void {
    if (this.writeFileFailuresRemaining > 0) {
      this.writeFileFailuresRemaining -= 1;
      throw new Error(`desktop environment: scripted transient write failure for "${path}"`);
    }
    if (!this.directories.has(parentOf(path)) && parentOf(path) !== '/') {
      throw new Error(`desktop environment: parent directory missing for "${path}"`);
    }
    this.files.set(path, content);
  }

  screenState(): readonly DesktopScreenElement[] {
    return [...this.screen].sort((a, b) => a.elementId.localeCompare(b.elementId));
  }

  openApplication(application: string): void {
    this.openedApplications.push(application);
  }

  interact(elementId: string, action: string, text?: string): void {
    const element = this.screen.find((candidate) => candidate.elementId === elementId);
    if (!element) {
      throw new Error(`desktop environment: no screen element "${elementId}"`);
    }
    this.interactions.push({ elementId, action, ...(text !== undefined ? { text } : {}) });
    this.screen = this.screen.map((candidate) =>
      candidate.elementId === elementId
        ? { ...candidate, state: text ?? `${candidate.state}:${action}` }
        : candidate,
    );
  }

  // ---- script hooks (deterministic external-change injection) ----

  /** External change: write a file directly (environment-side races). */
  externalWrite(path: string, content: string): void {
    this.files.set(path, content);
  }

  /** External change: delete a file. */
  externalDelete(path: string): void {
    this.files.delete(path);
  }

  /** Script: the next N writeFile calls fail transiently (host recovery tests). */
  failNextWrites(count: number): void {
    this.writeFileFailuresRemaining = count;
  }

  /** Audit accessors (tests only). */
  get opened(): readonly string[] {
    return this.openedApplications;
  }

  get interactionLog(): readonly { elementId: string; action: string; text?: string }[] {
    return this.interactions;
  }
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  if (index <= 0) {
    return '/';
  }
  return path.slice(0, index);
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

// ============================================================================
// §2 The mobile environment (calls + notifications — phone host class)
// ============================================================================

/** A live call as the mobile environment exposes it. */
export interface MobileCall {
  readonly callId: string;
  readonly state: 'ringing' | 'active' | 'ended';
  readonly caller: string;
  readonly number: string;
}

/** A notification as the mobile environment exposes it. */
export interface MobileNotification {
  readonly notificationId: string;
  readonly application: string;
  readonly title: string;
  readonly body: string;
}

/** The mobile environment port (the mobile adapter drives this). */
export interface MobileEnvironment {
  calls(): readonly MobileCall[];
  answer(callId: string): void;
  reject(callId: string): void;
  end(callId: string): void;
  notifications(): readonly MobileNotification[];
}

/**
 * The deterministic scripted mobile environment: an in-memory call state
 * machine + notification list (deterministic transitions, no wall clock).
 */
export class ScriptedMobileEnvironment implements MobileEnvironment {
  private readonly callState = new Map<string, MobileCall>();
  private notificationList: readonly MobileNotification[] = [];

  constructor(initial: { calls?: readonly MobileCall[]; notifications?: readonly MobileNotification[] } = {}) {
    for (const call of initial.calls ?? []) {
      this.callState.set(call.callId, call);
    }
    this.notificationList = [...(initial.notifications ?? [])];
  }

  calls(): readonly MobileCall[] {
    return [...this.callState.values()].sort((a, b) => a.callId.localeCompare(b.callId));
  }

  answer(callId: string): void {
    this.transition(callId, 'active', ['ringing']);
  }

  reject(callId: string): void {
    this.transition(callId, 'ended', ['ringing']);
  }

  end(callId: string): void {
    this.transition(callId, 'ended', ['active', 'ringing']);
  }

  notifications(): readonly MobileNotification[] {
    return [...this.notificationList];
  }

  private transition(callId: string, next: 'active' | 'ended', allowed: readonly string[]): void {
    const call = this.callState.get(callId);
    if (!call) {
      throw new Error(`mobile environment: no call "${callId}"`);
    }
    if (!allowed.includes(call.state)) {
      throw new Error(`mobile environment: call "${callId}" is ${call.state}, cannot become ${next}`);
    }
    this.callState.set(callId, { ...call, state: next });
  }

  // ---- script hooks (deterministic external-change injection) ----

  /** External change: an incoming call arrives. */
  incomingCall(call: MobileCall): void {
    this.callState.set(call.callId, call);
  }

  /** External change: a notification arrives / the list changes. */
  setNotifications(notifications: readonly MobileNotification[]): void {
    this.notificationList = [...notifications];
  }
}

// ============================================================================
// §3 Element projection helpers (environments → protocol elements)
// ============================================================================

/** Project a browser page element into a protocol observed element. */
export function browserElementToProtocolElement(element: BrowserPageElement): ObservedElement {
  return observedElement({
    elementId: element.elementId,
    kind: element.kind,
    label: element.label,
    state: element.state,
  });
}

/** Project a desktop screen element into a protocol observed element. */
export function screenElementToProtocolElement(element: DesktopScreenElement): ObservedElement {
  return observedElement({
    elementId: element.elementId,
    kind: element.kind,
    label: element.label,
    state: element.state,
  });
}

/** Project a mobile call into a protocol observed element. */
export function callToProtocolElement(call: MobileCall): ObservedElement {
  return observedElement({
    elementId: call.callId,
    kind: 'call',
    label: call.caller,
    state: call.state,
  });
}

/** Project a mobile notification into a protocol observed element. */
export function notificationToProtocolElement(notification: MobileNotification): ObservedElement {
  return observedElement({
    elementId: notification.notificationId,
    kind: 'notification',
    label: notification.title,
    state: notification.body,
  });
}
