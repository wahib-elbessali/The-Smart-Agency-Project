import { registerMock, registerMockWriter } from '../registry'
import type { PushPublicKey } from '@/api/types'

/* Mock mode has no push service, so the key is null and the Alerts panel
 * shows its "not configured" state - the honest answer for a backend that has
 * no VAPID keys. Writers are accepted and ignored. */
registerMock<PushPublicKey>('GET /api/push/public-key', {
  normal: () => ({ public_key: null, push_enabled: false }),
  empty: () => ({ public_key: null, push_enabled: false }),
  large: () => ({ public_key: null, push_enabled: false }),
})

registerMockWriter('POST /api/push/subscriptions', () => undefined)
registerMockWriter('DELETE /api/push/subscriptions', () => undefined)
