import { queueDelivery, deliverDue, acknowledgeDelivery } from '../../operations/notifications.mjs';
export function createWebhookHost({ configPath, transport }) {
  return Object.freeze({
    notify(store, { inboxId, channel, nowMs }) { return queueDelivery(store, { inboxId, channel, nowMs }); },
    tick(store, options = {}) { return deliverDue(store, { ...options, configPath, transport }); },
    acknowledge(store, { deliveryId, nowMs }) { return acknowledgeDelivery(store, { deliveryId, nowMs }); },
  });
}
