/**
 * notifications module — public interface.
 *
 * Canonical name: /notifications
 * Responsibility (spec/architecture.md): Optional provider-independent
 * notification boundary.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-021: implements the provider-independent notification boundary
 * (NOTIFY-001). Notifications are a side effect — they are NOT authoritative
 * for workflow/domain state (NOTIFY-AC-02).
 */
import type { ModuleContract } from '@platform/module-contract.js';

export type {
  NotificationRequest,
  NotificationStatus,
  CreateNotificationInput,
  NotificationService,
  NotificationProviderAdapter,
  NotificationDeliveryInput,
  NotificationDeliveryResult,
  NotificationRepository,
} from './internal/notification.types.js';

/**
 * Public capabilities exposed by the /notifications module to other modules.
 */
export interface NotificationsModuleApi {
  // future: additional notification-domain methods consumed by other modules
}

/**
 * Frozen module contract for /notifications.
 */
export const notificationsModule: ModuleContract & NotificationsModuleApi = {
  name: '/notifications',
};

export default notificationsModule;
