/**
 * WorkflowOS Companion — ProviderDetector (§11).
 *
 * Recognizes supported provider domains GENERICALLY. This file contains
 * domain names only — NO selectors, NO scraping, NO platform automation
 * (that is WORK-029/030/031, implemented inside each adapter file).
 */
import type { ProviderDetection } from './types.js';

/**
 * Supported provider domains. The fake provider is an extension-internal
 * page (chrome-extension:// origin) — the deterministic test-mode provider.
 *
 * PR #34 fix (WORK-031): Anthropic's canonical Claude Code on the web host
 * is now `claude.com/code` (live inspection observed claude.ai → claude.com
 * redirect). The detector recognizes BOTH domains so:
 *   - `claude.com` = canonical CURRENT Claude host (where the content script
 *     MUST run after the redirect).
 *   - `claude.ai` = legacy/redirect host (still matched for the brief
 *     pre-redirect page load + any user bookmarks/old sessions).
 * Both domains resolve to providerId 'claude'; the manifest grants
 * host_permissions to BOTH (https://*.claude.com/* AND https://*.claude.ai/*)
 * so the content script has permission on the post-redirect canonical host
 * (the PR #34 finding: detector-only recognition on claude.ai would let the
 * extension claim 'supported' where it cannot actually run after redirect).
 */
const PROVIDER_DOMAINS: readonly { providerId: string; domain: string }[] = [
  { providerId: 'zai', domain: 'z.ai' },
  { providerId: 'chatgpt', domain: 'chatgpt.com' },
  { providerId: 'claude', domain: 'claude.com' },
  { providerId: 'claude', domain: 'claude.ai' },
];

/** Extension pages that act as providers (test mode). */
const FAKE_PROVIDER_PATH = '/ui/fake-provider/index.html';

export function detectProvider(
  url: URL,
  isExtensionPage?: (path: string) => boolean,
): ProviderDetection {
  // Extension-internal fake provider page.
  if (url.protocol === 'chrome-extension:' ) {
    const fake = isExtensionPage
      ? isExtensionPage(url.pathname)
      : url.pathname === FAKE_PROVIDER_PATH;
    if (fake) {
      return { providerId: 'fake', supported: true, adapterAvailable: true };
    }
    return { providerId: null, supported: false, adapterAvailable: false };
  }

  const hostname = url.hostname.toLowerCase();
  const match = PROVIDER_DOMAINS.find((p) => hostname === p.domain || hostname.endsWith(`.${p.domain}`));
  if (!match) {
    return { providerId: null, supported: false, adapterAvailable: false };
  }
  return {
    providerId: match.providerId,
    supported: true,
    // WORK-029/030/031 shipped the Z.ai, ChatGPT, and Claude adapters. The
    // registry remains the capability source of truth.
    adapterAvailable: ['zai', 'chatgpt', 'claude'].includes(match.providerId),
  };
}

/** All supported provider ids (for the popup's provider list). */
export function supportedProviderIds(): string[] {
  // De-duplicate provider ids — a provider with multiple recognized domains
  // (e.g. Claude: claude.com + claude.ai) appears once.
  return [...new Set(PROVIDER_DOMAINS.map((p) => p.providerId)), 'fake'];
}
