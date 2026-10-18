import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'
import {
  deletePushSubscription,
  fetchPushPublicKey,
  savePushSubscription,
} from '@/api/endpoints/push'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody } from '@/components/ui/Panel'

/**
 * Turns this browser into a place the backend can send CRITICAL alerts to
 * (Web Push). Needs a secure context - https, or http://localhost - and, on
 * iOS, the app installed to the home screen first; the browser decides, this
 * only reports what it says.
 *
 * Users with no push subscription still get CRITICAL alerts by email if the
 * backend has SMTP configured, so "off" here is not "unprotected".
 */

const SW_URL = '/sw.js'

function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=')
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(SW_URL)
  return registration ? registration.pushManager.getSubscription() : null
}

export function PushPanel() {
  const supported = pushSupported()
  const [subscribed, setSubscribed] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  const key = useQuery({
    queryKey: ['push', 'public-key'],
    queryFn: ({ signal }) => fetchPushPublicKey(signal),
    enabled: supported,
  })

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    currentSubscription()
      .then((sub) => {
        if (!cancelled) setSubscribed(sub !== null)
      })
      .catch(() => {
        if (!cancelled) setSubscribed(false)
      })
    return () => {
      cancelled = true
    }
  }, [supported])

  /* "On" used to mean only that THIS BROWSER had a subscription. The backend
     could have none - a reset database, or a subscription made against an
     older server key - and then it notified nobody while the page said on.
     So every visit re-registers the subscription (the save is idempotent by
     endpoint), re-subscribing first if it was made with a different key. */
  const serverKey = key.data?.push_enabled ? key.data.public_key : null
  useEffect(() => {
    if (!supported || !serverKey || subscribed !== true) return
    let cancelled = false
    ;(async () => {
      const registration = await navigator.serviceWorker.getRegistration(SW_URL)
      let subscription = await registration?.pushManager.getSubscription()
      if (!registration || !subscription) return
      const wanted = base64UrlToBytes(serverKey)
      const current = subscription.options.applicationServerKey
      const sameKey =
        current !== null &&
        new Uint8Array(current).length === wanted.length &&
        new Uint8Array(current).every((byte, i) => byte === wanted[i])
      if (!sameKey) {
        await subscription.unsubscribe()
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: wanted,
        })
      }
      const json = subscription.toJSON()
      if (cancelled || !json.endpoint || !json.keys?.p256dh || !json.keys.auth) return
      await savePushSubscription({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      })
    })().catch(() => {
      if (!cancelled)
        setError(
          'Could not re-register this browser for notifications. Turn them off and on again.',
        )
    })
    return () => {
      cancelled = true
    }
  }, [supported, serverKey, subscribed])

  const enable = useMutation({
    mutationFn: async () => {
      const publicKey = key.data?.public_key
      if (!publicKey) throw new Error('Push is not configured on the server.')
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') throw new Error('Notification permission was not granted.')
      const registration = await navigator.serviceWorker.register(SW_URL)
      await navigator.serviceWorker.ready
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        }))
      const json = subscription.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        throw new Error('The browser returned an incomplete push subscription.')
      }
      await savePushSubscription({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      })
    },
    onSuccess: () => {
      setError(null)
      setSubscribed(true)
    },
    onError: (e: Error) => setError(e.message),
  })

  const disable = useMutation({
    mutationFn: async () => {
      const subscription = await currentSubscription()
      if (!subscription) return
      await deletePushSubscription(subscription.endpoint)
      await subscription.unsubscribe()
    },
    onSuccess: () => {
      setError(null)
      setSubscribed(false)
    },
    onError: (e: Error) => setError(e.message),
  })

  let body: string
  let action: React.ReactNode = null
  if (!supported) {
    body =
      'This browser cannot receive push notifications here (it needs https or localhost, and on iOS the app installed to the home screen).'
  } else if (key.isPending) {
    body = 'Checking whether the server can send push notifications…'
  } else if (!key.data?.push_enabled) {
    body = 'Push notifications are not configured on the server yet.'
  } else if (subscribed) {
    body = 'This device will get a notification the moment a CRITICAL alert opens.'
    action = (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => disable.mutate()}
        disabled={disable.isPending}
      >
        Turn off
      </Button>
    )
  } else if (Notification.permission === 'denied') {
    body = 'Notifications are blocked for this site - allow them in the browser settings first.'
  } else {
    body = 'Get a notification on this device the moment a CRITICAL alert opens.'
    action = (
      <Button size="sm" onClick={() => enable.mutate()} disabled={enable.isPending}>
        Enable alerts on this device
      </Button>
    )
  }

  return (
    <Panel as="section" className="mb-4">
      <PanelBody className="flex flex-wrap items-center gap-3 py-3">
        <BellRing className="text-ink-3 size-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-ink text-sm font-semibold">Critical alert notifications</h2>
            {subscribed && <Badge tone="ok">on</Badge>}
          </div>
          <p className="text-ink-2 mt-0.5 text-xs leading-relaxed" role="status">
            {body}
          </p>
          {error && <p className="text-bad mt-1 text-xs">{error}</p>}
        </div>
        {action}
      </PanelBody>
    </Panel>
  )
}
