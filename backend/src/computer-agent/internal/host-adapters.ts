/**
 * V2-008 — the host adapters: web, desktop and mobile implementing ONE
 * universal invocation protocol.
 *
 * Every adapter:
 *   - carries a V2-004-registered node identity (nodeId + sessionToken) and
 *     the advertisement it registered with (verbatim registry names);
 *   - accepts only capabilities it advertises (typed rejection otherwise —
 *     capability advertisement is what it is, never authorization);
 *   - enforces wrong-target prevention: a grounded act re-resolves the
 *     current target digest and fails closed on any change (no execution);
 *   - returns its own fresh post-action observation for mutating acts (the
 *     real effect the runtime verifies against — a claim is never evidence);
 *   - suppresses duplicate invocations through the host ledger (same
 *     invocation id ⇒ converged recorded result, never a second effect);
 *   - produces single-use attestation nonces where an attester key is
 *     attached (honest `no-attester-key` otherwise).
 *
 * Platform differences appear ONLY in the environment each adapter drives
 * and the capabilities it advertises — never in protocol semantics
 * (constitution §4; cross-host conformance battery pins this).
 */
import { createHash } from 'node:crypto';
import type {
  ComputerHostAdapter,
  HostActionOutcome,
  HostAttestationSupport,
  HostFailure,
  HostInvocationRequest,
  HostInvocationResult,
  HostObservation,
  ObservedElement,
} from '../types.js';
import type { CapabilityAdvertisement, NodeCapabilityService, NodePlatformClass } from '../../node-capability/index.js';
import { computeRegistrationResponse } from '../../node-capability/index.js';
import type { AttesterKeyPair, ExecutionAttestation, ExecutionStatement } from '../../execution-attestation/index.js';
import { signExecutionAttestation } from '../../execution-attestation/index.js';
import {
  FILE_ABSENT_DIGEST,
  HostInvocationLedger,
  createHostNonceSource,
  createHostObservationIdSource,
  hostFailure,
  observed,
  observedElement,
  validateInvocationRequest,
} from './host-protocol.js';
import type {
  BrowserSessionEnvironment,
  DesktopEnvironment,
  MobileEnvironment,
} from './environments.js';
import {
  browserElementToProtocolElement,
  callToProtocolElement,
  notificationToProtocolElement,
  screenElementToProtocolElement,
} from './environments.js';

// ============================================================================
// §0 The shared adapter core (the protocol discipline — identical for all hosts)
// ============================================================================

export interface ProtocolHostAdapterDeps {
  readonly nodeId: string;
  readonly sessionToken: string;
  readonly platformClass: NodePlatformClass;
  readonly capabilities: readonly CapabilityAdvertisement[];
  /** The injected host clock (fixed-format UTC; never ambient). */
  readonly clock: () => string;
  /** The environment this adapter drives (platform-specific BY DESIGN). */
  readonly attestation: HostAttestationSupport;
  /** Real attester key material when the host supports V2-014 production. */
  readonly attesterKey?: AttesterKeyPair;
}

/**
 * The protocol core shared by every host class. The `drive` hook is the
 * ONLY platform-specific code: translating one validated, grounded request
 * into environment operations and a protocol result.
 */
abstract class ProtocolHostAdapterBase implements ComputerHostAdapter {
  readonly nodeId: string;
  readonly sessionToken: string;
  readonly platformClass: NodePlatformClass;
  readonly capabilities: readonly CapabilityAdvertisement[];
  readonly attestationSupport: HostAttestationSupport;
  protected readonly clock: () => string;
  protected readonly attesterKey: AttesterKeyPair | undefined;
  private readonly ledger: HostInvocationLedger;
  private readonly nextObservationId: () => string;
  private readonly nextNonceSource: () => string;
  private readonly supported: Set<string>;

  constructor(deps: ProtocolHostAdapterDeps) {
    this.nodeId = deps.nodeId;
    this.sessionToken = deps.sessionToken;
    this.platformClass = deps.platformClass;
    this.capabilities = deps.capabilities;
    // HONEST attestation support: supported only with real key material AND
    // a `supported` declaration; never a silent up-claim.
    this.attesterKey = deps.attesterKey;
    this.attestationSupport =
      deps.attestation.supported && deps.attesterKey
        ? { supported: true, attesterKeyId: deps.attesterKey.keyId }
        : { supported: false, reason: 'no-attester-key' };
    this.clock = deps.clock;
    this.ledger = new HostInvocationLedger();
    this.nextObservationId = createHostObservationIdSource(deps.nodeId);
    this.nextNonceSource = createHostNonceSource(deps.nodeId);
    this.supported = new Set<string>(deps.capabilities.map((capability) => capability.name));
  }

  nextNonce(): string {
    return this.nextNonceSource();
  }

  signStatement(statement: ExecutionStatement, issuedAt: string): ExecutionAttestation {
    if (!this.attesterKey) {
      throw new Error(`computer-agent host ${this.nodeId}: attestation signing requested without attester key material`);
    }
    return signExecutionAttestation({
      statement,
      attesterPrivateKey: this.attesterKey.privateKey,
      attesterPublicKeyDer: this.attesterKey.publicKeyDer,
      assurance: 'software_signed',
      issuedAt,
    });
  }

  async invoke(invocationId: string, request: HostInvocationRequest): Promise<HostInvocationResult> {
    // Observations are reads: always fresh, never ledger-converged (an
    // observation frozen by convergence would ground acts on stale state —
    // see HostInvocationLedger). Acts are effectful: convergent per id.
    if (request.kind === 'act') {
      return this.ledger.executeAct(invocationId, async () => this.executeFresh(invocationId, request));
    }
    return this.executeFresh(invocationId, request);
  }

  private async executeFresh(invocationId: string, request: HostInvocationRequest): Promise<HostInvocationResult> {
    const shape = validateInvocationRequest(request);
    if (shape) {
      return { ok: false, failure: shape };
    }
    if (!this.supported.has(request.capability)) {
      return {
        ok: false,
        failure: hostFailure(
          'HOST_CAPABILITY_NOT_SUPPORTED',
          `host ${this.nodeId} (${this.platformClass}) does not advertise ${request.capability}`,
        ),
      };
    }
    return this.drive(invocationId, request);
  }

  /** Platform-specific translation of one validated request (the ONLY divergence). */
  protected abstract drive(invocationId: string, request: HostInvocationRequest): Promise<HostInvocationResult>;

  /** Build one host observation (deterministic ids, injected clock). */
  protected buildObservation(subject: string, elements: readonly ObservedElement[]): HostObservation {
    return {
      observationId: this.nextObservationId(),
      observedAt: this.clock(),
      subject,
      elements,
    };
  }

  /**
   * Wrong-target prevention: re-resolve the current digest of the grounded
   * target and fail closed on ANY difference (the target element is looked
   * up through the subclass-provided resolver).
   */
  protected async checkGrounding(
    request: Extract<HostInvocationRequest, { kind: 'act' }>,
    resolveCurrent: (elementId: string) => Promise<{ found: boolean; digest: string | null }>,
  ): Promise<HostFailure | null> {
    if (request.grounding === null) {
      return null;
    }
    const current = await resolveCurrent(request.grounding.targetElementId);
    if (!current.found) {
      return hostFailure(
        'HOST_TARGET_NOT_FOUND',
        `grounded target "${request.grounding.targetElementId}" no longer exists`,
      );
    }
    if (current.digest !== request.grounding.targetDigest) {
      return hostFailure(
        'HOST_TARGET_CHANGED',
        `grounded target "${request.grounding.targetElementId}" changed (expected digest ${request.grounding.targetDigest}, found ${current.digest})`,
        current.digest ?? undefined,
      );
    }
    return null;
  }
}

// ============================================================================
// §1 The web (browser) host adapter
// ============================================================================

/** The canonical web-host capability advertisement (registry names verbatim). */
export const WEB_HOST_CAPABILITIES: readonly CapabilityAdvertisement[] = [
  { name: 'browser.navigate', version: 1, availability: 'available' },
  { name: 'browser.click', version: 1, availability: 'available' },
  { name: 'browser.type', version: 1, availability: 'available' },
  { name: 'browser.select', version: 1, availability: 'available' },
  { name: 'browser.observe', version: 1, availability: 'available' },
  { name: 'browser.download', version: 1, availability: 'available' },
  { name: 'browser.upload', version: 1, availability: 'available' },
];

/** The web host adapter: drives a browser session environment. */
export class WebBrowserHostAdapter extends ProtocolHostAdapterBase {
  private readonly browserEnvironment: BrowserSessionEnvironment;

  constructor(deps: Omit<ProtocolHostAdapterDeps, 'platformClass' | 'capabilities'> & {
    readonly environment: BrowserSessionEnvironment;
    readonly capabilities?: readonly CapabilityAdvertisement[];
  }) {
    super({
      ...deps,
      platformClass: 'web',
      capabilities: deps.capabilities ?? WEB_HOST_CAPABILITIES,
    });
    this.browserEnvironment = deps.environment;
  }

  protected async drive(_invocationId: string, request: HostInvocationRequest): Promise<HostInvocationResult> {
    const environment = this.browserEnvironment;
    switch (request.capability) {
      case 'browser.observe': {
        const elements = environment.snapshot().map(browserElementToProtocolElement);
        return observed(this.buildObservation(environment.currentUrl(), elements));
      }
      case 'browser.navigate': {
        const url = stringParameter(request, 'url');
        if (request.kind !== 'act' || url === null) {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'browser.navigate requires { url }') };
        }
        environment.navigate(url);
        const elements = environment.snapshot().map(browserElementToProtocolElement);
        return observed(this.buildObservation(url, elements));
      }
      case 'browser.click':
      case 'browser.type':
      case 'browser.select': {
        if (request.kind !== 'act') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', `${request.capability} is an act`) };
        }
        const groundingFailure = await this.checkGrounding(request, async (elementId) => {
          const element = environment.snapshot().find((candidate) => candidate.elementId === elementId);
          return { found: element !== undefined, digest: element ? digestOfBrowserElement(element) : null };
        });
        if (groundingFailure) {
          return { ok: false, failure: groundingFailure };
        }
        const target = request.grounding?.targetElementId ?? '';
        if (request.capability === 'browser.click') {
          environment.click(target);
        } else if (request.capability === 'browser.type') {
          const text = stringParameter(request, 'text');
          if (text === null) {
            return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'browser.type requires { text }') };
          }
          environment.type(target, text);
        } else {
          const value = stringParameter(request, 'value');
          if (value === null) {
            return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'browser.select requires { value }') };
          }
          environment.select(target, value);
        }
        const elements = environment.snapshot().map(browserElementToProtocolElement);
        const outcome: HostActionOutcome = {
          outcome: 'succeeded',
          effect: this.buildObservation(environment.currentUrl(), elements),
          detail: `${request.capability} on ${target}`,
        };
        return { ok: true, kind: 'acted', outcome, converged: false };
      }
      case 'browser.download': {
        if (request.kind !== 'act') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'browser.download is an act') };
        }
        const groundingFailure = await this.checkGrounding(request, async (elementId) => {
          const element = environment.snapshot().find((candidate) => candidate.elementId === elementId);
          return { found: element !== undefined, digest: element ? digestOfBrowserElement(element) : null };
        });
        if (groundingFailure) {
          return { ok: false, failure: groundingFailure };
        }
        const target = request.grounding?.targetElementId ?? '';
        const payload = environment.download(target);
        const elements = environment.snapshot().map(browserElementToProtocolElement);
        const outcome: HostActionOutcome = {
          outcome: 'succeeded',
          effect: this.buildObservation(environment.currentUrl(), elements),
          detail: `downloaded ${payload}`,
        };
        return { ok: true, kind: 'acted', outcome, converged: false };
      }
      case 'browser.upload': {
        if (request.kind !== 'act') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'browser.upload is an act') };
        }
        const groundingFailure = await this.checkGrounding(request, async (elementId) => {
          const element = environment.snapshot().find((candidate) => candidate.elementId === elementId);
          return { found: element !== undefined, digest: element ? digestOfBrowserElement(element) : null };
        });
        if (groundingFailure) {
          return { ok: false, failure: groundingFailure };
        }
        const content = stringParameter(request, 'content');
        if (content === null) {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'browser.upload requires { content }') };
        }
        environment.upload(request.grounding?.targetElementId ?? '', content);
        const elements = environment.snapshot().map(browserElementToProtocolElement);
        const outcome: HostActionOutcome = {
          outcome: 'succeeded',
          effect: this.buildObservation(environment.currentUrl(), elements),
          detail: 'uploaded content',
        };
        return { ok: true, kind: 'acted', outcome, converged: false };
      }
      default:
        return {
          ok: false,
          failure: hostFailure('HOST_CAPABILITY_NOT_SUPPORTED', `web host does not implement ${request.capability}`),
        };
    }
  }
}

function digestOfBrowserElement(element: { elementId: string; kind: string; label: string; state: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ elementId: element.elementId, kind: element.kind, label: element.label, state: element.state }), 'utf8')
    .digest('hex');
}

// ============================================================================
// §2 The desktop host adapter
// ============================================================================

/** The canonical desktop-host capability advertisement (registry names verbatim). */
export const DESKTOP_HOST_CAPABILITIES: readonly CapabilityAdvertisement[] = [
  { name: 'filesystem.read', version: 1, availability: 'available' },
  { name: 'filesystem.write', version: 1, availability: 'available' },
  { name: 'application.open', version: 1, availability: 'available' },
  { name: 'application.observe', version: 1, availability: 'available' },
  { name: 'application.interact', version: 1, availability: 'available' },
  { name: 'screen.observe', version: 1, availability: 'available' },
  { name: 'ui.inspect', version: 1, availability: 'available' },
  { name: 'ui.click', version: 1, availability: 'available' },
  { name: 'ui.type', version: 1, availability: 'available' },
];

/**
 * The desktop host adapter: drives a desktop environment (scripted in the
 * batteries, REAL filesystem in the dogfooding host).
 *
 * Filesystem grounding: a read of path P observes the file's current state
 * (content) — or the ABSENT element when P does not exist. A write of P is
 * grounded on that state: if P's content changed since the grounding
 * observation, the write fails closed (no clobber); if P was absent and
 * still is, the write proceeds; if P was absent and now exists, the write
 * fails closed. This is the wrong-target prevention for filesystem targets.
 */
export class DesktopHostAdapter extends ProtocolHostAdapterBase {
  private readonly desktopEnvironment: DesktopEnvironment;

  constructor(deps: Omit<ProtocolHostAdapterDeps, 'platformClass' | 'capabilities'> & {
    readonly environment: DesktopEnvironment;
    readonly capabilities?: readonly CapabilityAdvertisement[];
  }) {
    super({
      ...deps,
      platformClass: 'desktop',
      capabilities: deps.capabilities ?? DESKTOP_HOST_CAPABILITIES,
    });
    this.desktopEnvironment = deps.environment;
  }

  protected async drive(_invocationId: string, request: HostInvocationRequest): Promise<HostInvocationResult> {
    const environment = this.desktopEnvironment;
    switch (request.capability) {
      case 'filesystem.read': {
        if (request.kind !== 'observe') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'filesystem.read is an observe') };
        }
        // A path ending in '/' (or equal to '/') reads a DIRECTORY listing;
        // otherwise it reads a FILE's current content (absent when missing).
        if (request.subject === '/' || request.subject.endsWith('/')) {
          try {
            const entries = await environment.listDirectory(normalizeDirectorySubject(request.subject));
            const elements = entries.map((entry) =>
              observedElement({
                elementId: joinHostPath(normalizeDirectorySubject(request.subject), entry.name),
                kind: entry.kind,
                label: entry.name,
                state: entry.kind,
              }),
            );
            return observed(this.buildObservation(request.subject, elements));
          } catch (error) {
            return { ok: false, failure: hostFailure('HOST_SUBJECT_NOT_FOUND', String(error)) };
          }
        }
        const content = await environment.readFile(request.subject);
        const elements = [
          // The ABSENT target is an observed element whose digest is the
          // canonical FILE_ABSENT_DIGEST (a grounded write on it fails
          // closed the moment the target exists — no clobbering).
          content === null
            ? {
                elementId: request.subject,
                kind: 'file' as const,
                label: baseNameOf(request.subject),
                state: FILE_ABSENT_SENTINEL,
                digest: FILE_ABSENT_DIGEST,
              }
            : observedElement({ elementId: request.subject, kind: 'file', label: baseNameOf(request.subject), state: content }),
        ];
        return observed(this.buildObservation(request.subject, elements));
      }
      case 'filesystem.write': {
        if (request.kind !== 'act') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'filesystem.write is an act') };
        }
        const content = stringParameter(request, 'content');
        if (content === null) {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'filesystem.write requires { content }') };
        }
        const targetPath = stringParameter(request, 'path') ?? request.grounding?.targetElementId ?? '';
        if (targetPath === '') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'filesystem.write requires a target path') };
        }
        const groundingFailure = await this.checkGrounding(request, async (elementId) => {
          const current = await environment.readFile(elementId);
          return {
            found: true,
            digest: current === null ? FILE_ABSENT_DIGEST : fileDigestOf(elementId, current),
          };
        });
        if (groundingFailure) {
          return { ok: false, failure: groundingFailure };
        }
        try {
          await environment.writeFile(targetPath, content);
        } catch (error) {
          return { ok: false, failure: hostFailure('HOST_ENVIRONMENT_ERROR', String(error)) };
        }
        const written = await environment.readFile(targetPath);
        const elements = [
          observedElement({ elementId: targetPath, kind: 'file', label: baseNameOf(targetPath), state: written ?? '' }),
        ];
        const outcome: HostActionOutcome = {
          outcome: 'succeeded',
          effect: this.buildObservation(targetPath, elements),
          detail: `wrote ${content.length} bytes to ${targetPath}`,
        };
        return { ok: true, kind: 'acted', outcome, converged: false };
      }
      case 'screen.observe':
      case 'application.observe':
      case 'ui.inspect': {
        if (request.kind !== 'observe') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', `${request.capability} is an observe`) };
        }
        const elements = environment.screenState().map(screenElementToProtocolElement);
        return observed(this.buildObservation(request.subject, elements));
      }
      case 'application.open': {
        if (request.kind !== 'act') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'application.open is an act') };
        }
        const application = stringParameter(request, 'application');
        if (application === null) {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'application.open requires { application }') };
        }
        environment.openApplication(application);
        const elements = environment.screenState().map(screenElementToProtocolElement);
        const outcome: HostActionOutcome = {
          outcome: 'succeeded',
          effect: this.buildObservation(application, elements),
          detail: `opened ${application}`,
        };
        return { ok: true, kind: 'acted', outcome, converged: false };
      }
      case 'application.interact':
      case 'ui.click':
      case 'ui.type': {
        if (request.kind !== 'act') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', `${request.capability} is an act`) };
        }
        const groundingFailure = await this.checkGrounding(request, async (elementId) => {
          const element = environment.screenState().find((candidate) => candidate.elementId === elementId);
          return { found: element !== undefined, digest: element ? digestOfScreenElement(element) : null };
        });
        if (groundingFailure) {
          return { ok: false, failure: groundingFailure };
        }
        const target = request.grounding?.targetElementId ?? '';
        const action = request.capability === 'ui.type' ? 'type' : 'click';
        const textParameter = request.capability === 'ui.type' ? stringParameter(request, 'text') : null;
        if (request.capability === 'ui.type' && textParameter === null) {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'ui.type requires { text }') };
        }
        try {
          environment.interact(target, action, textParameter ?? undefined);
        } catch (error) {
          return { ok: false, failure: hostFailure('HOST_TARGET_NOT_FOUND', String(error)) };
        }
        const elements = environment.screenState().map(screenElementToProtocolElement);
        const outcome: HostActionOutcome = {
          outcome: 'succeeded',
          effect: this.buildObservation(target, elements),
          detail: `${request.capability} on ${target}`,
        };
        return { ok: true, kind: 'acted', outcome, converged: false };
      }
      default:
        return {
          ok: false,
          failure: hostFailure('HOST_CAPABILITY_NOT_SUPPORTED', `desktop host does not implement ${request.capability}`),
        };
    }
  }
}

/** The sentinel state recorded for an ABSENT filesystem target. */
export const FILE_ABSENT_SENTINEL = '\u0000absent\u0000';

function fileDigestOf(path: string, content: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ elementId: path, kind: 'file', label: baseNameOf(path), state: content }), 'utf8')
    .digest('hex');
}

function digestOfScreenElement(element: { elementId: string; kind: string; label: string; state: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ elementId: element.elementId, kind: element.kind, label: element.label, state: element.state }), 'utf8')
    .digest('hex');
}

function baseNameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function joinHostPath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

function normalizeDirectorySubject(subject: string): string {
  if (subject === '/') {
    return '/';
  }
  return subject.endsWith('/') ? subject.slice(0, -1) : subject;
}

// ============================================================================
// §3 The mobile host adapter
// ============================================================================

/** The canonical mobile-host capability advertisement (registry names verbatim). */
export const MOBILE_HOST_CAPABILITIES: readonly CapabilityAdvertisement[] = [
  { name: 'phone.call.observe', version: 1, availability: 'available' },
  { name: 'phone.call.identify', version: 1, availability: 'available' },
  { name: 'phone.call.answer', version: 1, availability: 'available' },
  { name: 'phone.call.reject', version: 1, availability: 'available' },
  { name: 'phone.call.end', version: 1, availability: 'available' },
  { name: 'notifications.observe', version: 1, availability: 'available' },
];

/** The mobile host adapter: drives a mobile environment (calls/notifications). */
export class MobileHostAdapter extends ProtocolHostAdapterBase {
  private readonly mobileEnvironment: MobileEnvironment;

  constructor(deps: Omit<ProtocolHostAdapterDeps, 'platformClass' | 'capabilities'> & {
    readonly environment: MobileEnvironment;
    readonly capabilities?: readonly CapabilityAdvertisement[];
  }) {
    super({
      ...deps,
      platformClass: 'ios',
      capabilities: deps.capabilities ?? MOBILE_HOST_CAPABILITIES,
    });
    this.mobileEnvironment = deps.environment;
  }

  protected async drive(_invocationId: string, request: HostInvocationRequest): Promise<HostInvocationResult> {
    const environment = this.mobileEnvironment;
    switch (request.capability) {
      case 'phone.call.observe': {
        if (request.kind !== 'observe') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'phone.call.observe is an observe') };
        }
        const elements = environment.calls().map(callToProtocolElement);
        return observed(this.buildObservation(request.subject, elements));
      }
      case 'phone.call.identify': {
        if (request.kind !== 'observe') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'phone.call.identify is an observe') };
        }
        const call = environment.calls().find((candidate) => candidate.callId === request.subject);
        if (!call) {
          return { ok: false, failure: hostFailure('HOST_SUBJECT_NOT_FOUND', `no call ${request.subject}`) };
        }
        const elements = [callToProtocolElement(call)];
        return observed(this.buildObservation(request.subject, elements));
      }
      case 'phone.call.answer':
      case 'phone.call.reject':
      case 'phone.call.end': {
        if (request.kind !== 'act') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', `${request.capability} is an act`) };
        }
        const groundingFailure = await this.checkGrounding(request, async (elementId) => {
          const call = environment.calls().find((candidate) => candidate.callId === elementId);
          if (!call) {
            return { found: false, digest: null };
          }
          const element = callToProtocolElement(call);
          return { found: true, digest: element.digest };
        });
        if (groundingFailure) {
          return { ok: false, failure: groundingFailure };
        }
        const callId = request.grounding?.targetElementId ?? '';
        try {
          if (request.capability === 'phone.call.answer') {
            environment.answer(callId);
          } else if (request.capability === 'phone.call.reject') {
            environment.reject(callId);
          } else {
            environment.end(callId);
          }
        } catch (error) {
          return { ok: false, failure: hostFailure('HOST_TARGET_NOT_FOUND', String(error)) };
        }
        const elements = environment.calls().map(callToProtocolElement);
        const outcome: HostActionOutcome = {
          outcome: 'succeeded',
          effect: this.buildObservation(callId, elements),
          detail: `${request.capability} on ${callId}`,
        };
        return { ok: true, kind: 'acted', outcome, converged: false };
      }
      case 'notifications.observe': {
        if (request.kind !== 'observe') {
          return { ok: false, failure: hostFailure('HOST_PARAMETER_INVALID', 'notifications.observe is an observe') };
        }
        const elements = environment.notifications().map(notificationToProtocolElement);
        return observed(this.buildObservation(request.subject, elements));
      }
      default:
        return {
          ok: false,
          failure: hostFailure('HOST_CAPABILITY_NOT_SUPPORTED', `mobile host does not implement ${request.capability}`),
        };
    }
  }
}

// ============================================================================
// §4 Host registration through the REAL V2-004 protocol
// ============================================================================

export interface RegisterComputerHostInput {
  /** The V2-004 node-capability service (the merged registration authority). */
  readonly nodes: NodeCapabilityService;
  /** Deterministic key seed (sha-256 of a fixed string — never random). */
  readonly keySeed: string;
  readonly platformClass: NodePlatformClass;
  readonly capabilities: readonly CapabilityAdvertisement[];
  /** Human-approval support declaration (V2-004 attribute, honest). */
  readonly supportsHumanApproval?: boolean;
  /** Administrative trust tier set after registration (the control plane's). */
  readonly trustTier?: 'untrusted' | 'provisional' | 'trusted';
  /** Refresh liveness with one heartbeat after registration. */
  readonly heartbeat?: boolean;
}

/**
 * Register one host through the REAL V2-004 registration protocol:
 * enrollNodeKey → requestRegistrationChallenge → MAC response over the
 * exact payload → completeRegistration → setNodeTrustAttributes →
 * heartbeat. Returns the node identity the adapter carries.
 */
export function registerComputerHost(
  input: RegisterComputerHostInput,
): { nodeId: string; sessionToken: string } {
  const secret = createHash('sha256').update(input.keySeed, 'utf8').digest();
  const { nodeKeyFingerprint } = input.nodes.enrollNodeKey({ nodeKeySecret: secret });
  const challenge = input.nodes.requestRegistrationChallenge({ nodeKeyFingerprint });
  const payload = {
    nodeKeyFingerprint,
    platformClass: input.platformClass,
    protocolVersion: 1,
    capabilities: input.capabilities,
    attributes: {
      supportsHumanApproval: input.supportsHumanApproval ?? false,
      health: 'healthy' as const,
    },
  };
  const response = computeRegistrationResponse({
    nodeKeySecret: secret,
    payload,
    nonce: challenge.nonce,
  });
  const session = input.nodes.completeRegistration({
    ...payload,
    challengeNonce: challenge.nonce,
    response,
  });
  input.nodes.setNodeTrustAttributes({ nodeId: session.nodeId, trustTier: input.trustTier ?? 'trusted' });
  if (input.heartbeat !== false) {
    input.nodes.heartbeat({ nodeId: session.nodeId, sessionToken: session.sessionToken });
  }
  return { nodeId: session.nodeId, sessionToken: session.sessionToken };
}

// ============================================================================
// §5 Shared helpers
// ============================================================================

function stringParameter(
  request: HostInvocationRequest,
  name: string,
): string | null {
  if (request.kind !== 'act') {
    return null;
  }
  const value = request.parameters[name];
  if (typeof value !== 'string') {
    return null;
  }
  return value;
}
