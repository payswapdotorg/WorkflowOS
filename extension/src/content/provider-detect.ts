/**
 * WorkflowOS Companion — provider-detection content script.
 *
 * Runs on supported PROVIDER domains (manifest host permissions). Detection
 * ONLY (§11): it reports which provider the tab is on and whether an adapter
 * exists. It performs NO DOM automation, NO scraping, NO injection — the
 * real adapters (WORK-029+) will attach behavior through the registry.
 */
import { detectProvider } from '../providers/detector.js';
import { message } from '../shared/messages.js';

const detection = detectProvider(new URL(window.location.href));

if (detection.providerId) {
  void chrome.runtime
    .sendMessage(
      message('PROVIDER_DETECTED', null, {
        providerId: detection.providerId,
        supported: detection.supported,
        adapterAvailable: detection.adapterAvailable,
        url: window.location.origin,
      }),
    )
    .catch(() => undefined);
}
