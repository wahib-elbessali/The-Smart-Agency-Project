import type { CameraAiFeature } from '@/api/types'

/** How each per-camera AI detection is named on screen. */
export const CAMERA_FEATURE_LABEL: Record<CameraAiFeature, string> = {
  weapon: 'Weapons',
  fire: 'Fire and smoke',
  wanted: 'Watchlist faces',
  emotion: 'Satisfaction (faces)',
}
