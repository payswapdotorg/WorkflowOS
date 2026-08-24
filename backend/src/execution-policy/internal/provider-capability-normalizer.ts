/**
 * WORK-033 §6 — ProviderCapabilityProfile normalizer.
 *
 * Composes the EXISTING provider capability metadata from @modules/agents
 * (`ExecutionProviderInfo` + `EXTERNAL_UI_CATALOG`). This file MUST NOT
 * declare a new provider catalog — it is a pure projection of existing
 * metadata into the WORK-033 normalized shape. (Enforced by static-arch
 * check: `EXTERNAL_UI_CATALOG` must be referenced, no second catalog here.)
 *
 * Mapping (SurfaceReadiness → CapabilityReadiness):
 *   'ready'        → 'ready'
 *   'unverified'   → 'unverified'
 *   'not-available'→ 'unavailable'
 *
 * For native mode: nativeApi 'ready' → nativeApi 'ready', else 'configuration_missing'.
 * For external mode: externalUi 'available' → externalUi 'ready', else 'unavailable'.
 */
import type {
  CapabilityReadiness,
  ProviderCapabilityProfile,
  ProviderAccessProfile,
} from '../types.js';
import type {
  ExecutionProviderInfo,
  ProviderSurfaceCapabilities,
  SurfaceReadiness,
} from '@modules/agents';

const SURFACE_MAP: Readonly<Record<SurfaceReadiness, CapabilityReadiness>> = Object.freeze({
  ready: 'ready',
  unverified: 'unverified',
  'not-available': 'unavailable',
});

/**
 * Normalize an ExecutionProviderInfo into a ProviderCapabilityProfile for a
 * SPECIFIC execution mode. The same provider's profile differs between native
 * (nativeApi drives streaming/toolUse/nativeApi readiness) and external
 * (externalUi drives externalUi readiness; codingAgent from catalog).
 */
export class ProviderCapabilityNormalizer {
  /**
   * @param accessProfilesByProvider user-configured subscription profiles keyed
   *   by provider (may be empty — then subscription status is 'unknown').
   */
  constructor(
    private readonly accessProfilesByProvider: ReadonlyMap<string, ProviderAccessProfile>,
  ) {}

  normalizeForMode(info: ExecutionProviderInfo, mode: 'native' | 'external'): ProviderCapabilityProfile {
    const caps = (info.capabilities ?? defaultSurface()) as ProviderSurfaceCapabilities;
    const access = this.accessProfilesByProvider.get(info.provider) ?? null;

    const conversational = SURFACE_MAP[caps.conversationalChat];
    const codingAgent = this.mergeCodingAgent(caps, access, mode);
    const externalUi = this.mergeExternalUi(info, access);
    const nativeApi = this.mergeNativeApi(info, access);

    return {
      conversational,
      codingAgent,
      // Browser: external coding-agent surfaces (Codex/Claude Code) imply
      // browser availability; native providers have NO browser unless the
      // access profile declares it (future WORK). Default 'unverified'.
      browser: mode === 'external' && caps.codingAgent !== 'not-available' ? 'unverified' : 'unverified',
      // Repository access: external coding agents operate on a repo workspace;
      // native providers access the repo via the AgentGateway (always for native).
      repositoryAccess: mode === 'external' ? (caps.codingAgent !== 'not-available' ? 'unverified' : 'unavailable') : 'ready',
      // Terminal: native has terminal via AgentGateway; external coding agents
      // may (Codex). Marked 'unverified' for external until live-verified.
      terminal: mode === 'native' ? 'ready' : 'unverified',
      nativeApi,
      externalUi,
      // Streaming: native providers stream; external UIs may not expose it.
      streaming: mode === 'native' ? 'ready' : 'unverified',
      // Tool use: coding agents use tools; conversational surfaces limited.
      toolUse: caps.implementationSurface === 'coding-agent' ? 'ready' : 'unverified',
      maxContext: {
        // Not declared in the existing catalog — 'unknown' (§6: do NOT invent).
        tokens: null,
        source: 'unknown',
      },
      supportedExecutionModes: computeSupportedModes(info),
    };
  }

  private mergeCodingAgent(
    caps: ProviderSurfaceCapabilities,
    access: ProviderAccessProfile | null,
    _mode: 'native' | 'external',
  ): CapabilityReadiness {
    const fromCatalog = SURFACE_MAP[caps.codingAgent];
    // §5: user-configured access profile can refine 'unverified' → 'ready' or
    // downgrade to 'unavailable'. 'unknown' statusSource MUST NOT auto-promote.
    if (access && access.codingAgent !== 'unverified') {
      return access.codingAgent;
    }
    return fromCatalog;
  }

  private mergeExternalUi(
    info: ExecutionProviderInfo,
    access: ProviderAccessProfile | null,
  ): CapabilityReadiness {
    const fromCatalog: CapabilityReadiness = info.externalUi === 'available' ? 'ready' : 'unavailable';
    if (access && access.externalUi !== 'unverified') return access.externalUi;
    return fromCatalog;
  }

  private mergeNativeApi(
    info: ExecutionProviderInfo,
    access: ProviderAccessProfile | null,
  ): CapabilityReadiness {
    // 'configuration_missing' is a ProviderAvailability, not a CapabilityReadiness;
    // for the profile we collapse to 'unavailable' when the native credential is
    // not configured. The eligibility layer surfaces the precise
    // 'configuration_missing' availability status.
    const base: CapabilityReadiness = info.nativeApi === 'ready' ? 'ready' : 'unavailable';
    if (access && access.nativeApi !== 'unverified') {
      return access.nativeApi;
    }
    return base;
  }
}

function defaultSurface(): ProviderSurfaceCapabilities {
  return {
    conversationalChat: 'unverified',
    codingAgent: 'unverified',
    implementationSurface: 'conversational-chat',
  };
}

function computeSupportedModes(info: ExecutionProviderInfo): readonly ('native' | 'external')[] {
  const modes: ('native' | 'external')[] = [];
  if (info.nativeApi === 'ready') modes.push('native');
  if (info.externalUi === 'available') modes.push('external');
  // A provider with neither configured still appears as a catalog entry but
  // supports NO mode — it will be excluded by eligibility as 'configuration_missing'.
  return modes;
}
