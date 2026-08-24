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
 */
const PROVIDER_DOMAINS: readonly { providerId: string; domain: string }[] = [
  { providerId: 'zai', domain: 'z.ai' },
  { providerId: 'chatgpt', domain: 'chatgpt.com' },
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
    // WORK-029 shipped the Z.ai adapter; WORK-030 shipped the ChatGPT
    // adapter; Claude remains pending (WORK-031). The registry remains the
    // capability source of truth.
    adapterAvailable: ['zai', 'chatgpt'].includes(match.providerId),
  };
}

/** All supported provider ids (for the popup's provider list). */
export function supportedProviderIds(): string[] {
  return [...PROVIDER_DOMAINS.map((p) => p.providerId), 'fake'];
}
