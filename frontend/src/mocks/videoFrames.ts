/**
 * Real camera frames for mock mode, decoded from a video file you drop in.
 *
 * WHY THIS EXISTS
 *
 * The fixture frame used to be a grey placard with the camera's name on it.
 * That is honest for "no camera connected", and useless for the two screens
 * that exist to be clicked on a picture of a room: you cannot pick out a
 * floor tile to calibrate against, and you certainly cannot find the same
 * real spot in two cameras to align them. Drop an .mp4 in and every frame
 * request returns a real frame from it instead.
 *
 * HOW TO USE IT
 *
 *   frontend/public/fixtures/cam-lobby.mp4     <- named after the camera
 *   frontend/public/fixtures/cam-counter.mp4
 *   frontend/public/fixtures/default.mp4       <- used by any camera with no
 *                                                 file of its own
 *
 * Nothing else to configure. The files are gitignored - see the README in
 * that folder - so no video ever lands in the repository.
 *
 * WHY IT LOOKS LIVE
 *
 * The video plays, muted and looping, in a detached element. Each frame
 * request grabs whatever it is showing at that moment, so the live view -
 * which refetches every two seconds - genuinely advances, and two cameras
 * pointed at different files drift apart the way real ones would.
 *
 * WHY EVERY FRAME IS 1920x1080 REGARDLESS OF THE VIDEO
 *
 * The scripted weapon detections in aiStreams.ts are in fixed pixel
 * coordinates chosen for a 1920x1080 frame - that is what the contract's
 * bbox is, source-frame pixels. A 1280x720 video would put those boxes
 * somewhere else entirely and make the overlay look broken when it is not.
 * So the video is drawn centred into a 1920x1080 canvas with its aspect
 * preserved, black bars and all. Calibration is unaffected: padding does
 * not change the room's geometry, and the clicked points are still in the
 * frame's own coordinates.
 *
 * WHEN IT DOES NOTHING
 *
 * No browser (the test suite), no file, or a file the browser cannot
 * decode: every entry point returns null and the caller falls back to the
 * placard. Tests never touch this.
 */

const FRAME_W = 1920
const FRAME_H = 1080

/** Cached per source: the playing element, or null once known missing. */
const players = new Map<string, Promise<HTMLVideoElement | null>>()

function canUseVideo(): boolean {
  /* MODE is 'test' under Vitest. jsdom has neither a decoder nor a canvas
     2d context, and probing for them would just be a slower way to fail. */
  return typeof document !== 'undefined' && import.meta.env.MODE !== 'test'
}

function load(url: string): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.loop = true
    video.playsInline = true
    video.preload = 'auto'

    video.addEventListener(
      'loadeddata',
      () => {
        /* Muted autoplay is allowed without a gesture. If a browser refuses
           anyway the element still holds frame 0, which is a still picture
           of the room - worse than live, better than a placard. */
        void video.play().catch(() => {})
        resolve(video)
      },
      { once: true },
    )
    video.addEventListener('error', () => resolve(null), { once: true })
  })
}

/**
 * The element for this camera, its shared fallback, or null.
 *
 * Resolution is cached including the failure, so a missing file costs one
 * failed request per session rather than one per frame - and the live view
 * asks every two seconds.
 */
function playerFor(cameraName: string): Promise<HTMLVideoElement | null> {
  const key = cameraName
  const cached = players.get(key)
  if (cached) return cached

  const attempt = (async () => {
    const own = await load(`/fixtures/${encodeURIComponent(cameraName)}.mp4`)
    if (own) return own
    return load('/fixtures/default.mp4')
  })()

  players.set(key, attempt)
  return attempt
}

/**
 * The frame this camera is showing right now, as a JPEG blob, or null when
 * there is no usable video behind it.
 */
export async function videoFrame(cameraName: string): Promise<Blob | null> {
  if (!canUseVideo()) return null

  const video = await playerFor(cameraName)
  if (!video || !video.videoWidth || !video.videoHeight) return null

  const canvas = document.createElement('canvas')
  canvas.width = FRAME_W
  canvas.height = FRAME_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  /* Letterbox rather than stretch: a squashed room would make every
     calibration measure a building that does not exist. */
  ctx.fillStyle = '#0b0d12'
  ctx.fillRect(0, 0, FRAME_W, FRAME_H)
  const scale = Math.min(FRAME_W / video.videoWidth, FRAME_H / video.videoHeight)
  const w = video.videoWidth * scale
  const h = video.videoHeight * scale
  ctx.drawImage(video, (FRAME_W - w) / 2, (FRAME_H - h) / 2, w, h)

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.82)
  })
}

/** Whether this camera has footage behind it, without decoding a frame. */
export async function hasVideo(cameraName: string): Promise<boolean> {
  if (!canUseVideo()) return false
  return (await playerFor(cameraName)) !== null
}

/** Tests and the console - drops every cached element. */
export function resetVideoFrames(): void {
  players.clear()
}
