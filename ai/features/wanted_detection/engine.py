"""Wanted/watchlisted-person detection -- the AI/CV script behind this feature's
API (features/wanted_detection/api.py). Alerts when someone on an operator-managed
watchlist appears on any camera.

DELIBERATELY NOT A NEW MODEL. This is composition of two already-validated
primitives, and the only reason it's a separate feature at all is that its data
and its failure mode differ from theirs:

  features/face_recognition/engine.py  detect_faces() already returns the 512-d
      L2-normalized embedding per face, so recognition here costs NO second
      inference pass -- identify() is pure NumPy dot products on top of the one
      SCRFD pass. Same reuse pattern as features/emotion_detection/engine.py.
  features/common/live_alert_service.py         the continuous push-on-change broadcaster
      shared with weapon/fire/emotion detection.

WHY THE ACCESS-CONTROL THRESHOLD IS NOT REUSED -- the single most important thing
in this file. identify()'s default 0.248 was measured for VERIFICATION: 1-vs-1
LFW pairs, "are these two photos the same person?", where the subject claims an
identity at a gate. This feature does OPEN-SET IDENTIFICATION: every innocent
passer-by is compared against every embedding of every watchlist member, and
identify() takes the max. With K stored embeddings, one unknown face gets K
chances to false-match, and the live loop re-tests every camera every couple of
seconds. A verification threshold carried over here produces routine false
accusations. The default below is measured on the right task by
evaluation/wanted_openset_eval.py -- see that script and docs/live_alerts.md for
the numbers, including the honest limit on how small a false-alarm rate that
measurement can actually resolve.

`threshold` is therefore a REQUIRED argument, not a defaulted one: the measured
value lives in DEFAULT_WANTED_THRESHOLD for callers to pass explicitly, but no
call site can silently fall back to a guess on the one feature in this project
whose failure mode is accusing an innocent person.
"""
import base64

import cv2

from ..face_recognition.engine import detect_faces, identify

# Both measured by evaluation/wanted_openset_eval.py, not guessed. See the module
# docstring for why the 0.248 access-control value would be wrong here.
#
# Measured on LFW open-set, watchlist of 200 people / 400 embeddings, 400
# impostor probes (identities absent from the watchlist):
#     thr 0.32 -> DIR 0.990, FAR 0.0100     (~90 false alarms/camera/day)
#     thr 0.44 -> DIR 0.975, FAR 0.0000     <- first threshold with no measured false alarm
#     thr 0.50 -> DIR 0.910, FAR 0.0000
#     thr 0.60 -> DIR 0.630, FAR 0.0000
# READ FAR=0.0000 CAREFULLY: 400 impostor probes resolve FAR only down to 2.5e-3,
# so it means "unmeasurably small here", NOT zero -- the honest bound is up to
# ~22 false alarms/camera/day, and a genuinely quiet camera needs ~1e-5, which
# would take ~100k probes to demonstrate (far beyond LFW). 0.50 is chosen ABOVE
# the 0.44 first-zero point deliberately: that point is only where LFW stops
# being able to see the false alarms, and real footage is harder than LFW's
# frontal celebrity photos. It still catches 91% of real watchlist members, and
# LiveAlertService's confirm_cycles=2 multiplies two largely independent
# false-match probabilities on top -- which is where the safety this measurement
# cannot demonstrate actually comes from.
DEFAULT_WANTED_THRESHOLD = 0.50

# From the same script's face-size sweep at thr 0.44 (native LFW face ~91px):
#     ~18px -> DIR 0.660     ~29px -> DIR 0.980     ~44px -> DIR 0.980     ~91px -> DIR 1.000
# HONEST NOTE: this did NOT confirm the hypothesis that motivated the gate. Small
# faces were expected to cause FALSE MATCHES; measured, they caused MISSES (FAR
# stayed 0.0000 at every size, DIR collapsed below ~30px). So this is a quality
# floor -- "don't claim an identity from a face this small" -- not the
# false-alarm mitigation it was intended to be. It still earns its place because
# an operator can lower the threshold via PUT /threshold, and low-quality
# embeddings do become a false-match risk down there.
DEFAULT_MIN_FACE_PX = 30

# Anything at or below the access-control-validated 0.248 is indefensible for
# open-set identification; the API refuses to go below this.
THRESHOLD_FLOOR = 0.25

# The alert carries the triggering frame inline (see attach_snapshot). Downscaled
# because the frame is re-sent to every client that connects (LiveAlertService
# replays _last_detections as its on-connect snapshot), so a full-size 1080p JPEG
# would be paid over and over rather than once. 960px on the long side keeps a
# face clearly reviewable at roughly a quarter the bytes.
SNAPSHOT_MAX_PX = 960
SNAPSHOT_JPEG_QUALITY = 85


def detect_wanted(frame_bgr, watchlist, threshold, det_size=(640, 640),
                  min_face_px=DEFAULT_MIN_FACE_PX):
    """frame_bgr: HxWx3 uint8, OpenCV convention.
    watchlist: {name: [embedding, ...]}, same structure as the face gallery.
    -> list of {"class": <watchlist name>, "confidence": <cosine similarity>,
       "bbox": (x1,y1,x2,y2), "det_score": float, "face_px": int} sorted by
    confidence descending -- WATCHLIST HITS ONLY.

    Unmatched faces are dropped and never leave this function: an innocent
    passer-by's embedding exists only until this list is garbage-collected, is
    never emitted, logged, or stored. That is what makes LiveAlertService's
    class-set equal "the set of watchlisted people currently visible", and it's
    why an empty result is ambiguous between "nobody wanted here", "no faces at
    all", and "camera pointed at a wall" -- a deliberate trade, but it does mean
    this stream cannot double as a camera-liveness signal (use GET /frame).

    NOTE "confidence" is a COSINE SIMILARITY in [-1, 1] (typically 0.25-0.75),
    not a detector probability like weapon/fire/emotion detection return. A UI
    rendering it as "46% confident" would be wrong."""
    if not watchlist:
        return []          # nothing to match against -- skip SCRFD entirely
    h, w = frame_bgr.shape[:2]
    out = []
    for face in detect_faces(frame_bgr, det_size=det_size):
        x1, y1, x2, y2 = face["bbox"]
        # Measured BEFORE clamping, so it reflects the real face size rather than
        # how much of it happened to fall inside the frame.
        face_px = int(min(x2 - x1, y2 - y1))
        if face_px < min_face_px:
            # Too small to carry real identity information. identify() would
            # still happily return its best match, which makes tiny faces a
            # false-accusation source rather than a missed-detection one --
            # docs/live_alerts.md records 9-28px crops on this project's own
            # footage reading as upsampling noise for emotion classification.
            continue
        name, score = identify(watchlist, face["embedding"], threshold=threshold)
        if name is None:
            continue       # <-- unknown person: dropped here, permanently
        # Clamped only so the box is drawable on the snapshot. Unlike
        # detect_emotions we do NOT skip degenerate boxes: it re-crops to
        # classify and would crash, whereas here the identity evidence already
        # exists and discarding a real hit is the expensive direction.
        out.append({"class": name, "confidence": float(score),
                    "bbox": (max(0.0, float(x1)), max(0.0, float(y1)),
                             min(float(w), float(x2)), min(float(h), float(y2))),
                    "det_score": round(float(face["det_score"]), 3),
                    "face_px": face_px})
    out.sort(key=lambda d: -d["confidence"])
    return out


def attach_snapshot(frame_bgr, detections):
    """Attaches the triggering frame to `detections` in place, as a base64 JPEG
    under the "snapshot" key, and returns them.

    Attached ONCE, to the highest-confidence detection: the snapshot is a
    property of the frame, not of an individual match, so duplicating it across
    every detection would multiply a six-figure payload for no information gain.

    Called only when there is at least one match, so the overwhelmingly common
    no-match case costs no JPEG encode at all -- which is why this needs no
    cooperation from LiveAlertService."""
    if not detections:
        return detections
    h, w = frame_bgr.shape[:2]
    scale = min(1.0, SNAPSHOT_MAX_PX / float(max(h, w)))
    img = (cv2.resize(frame_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
           if scale < 1.0 else frame_bgr)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), SNAPSHOT_JPEG_QUALITY])
    if ok:
        detections[0]["snapshot"] = base64.b64encode(buf.tobytes()).decode("ascii")
    return detections


def detect_wanted_with_snapshot(frame_bgr, watchlist, threshold, det_size=(640, 640),
                                min_face_px=DEFAULT_MIN_FACE_PX):
    """detect_wanted() + attach_snapshot() -- the form the API registers with
    LiveAlertService, kept as its own function so detect_wanted() stays a pure
    matcher that's cheap to test and reason about."""
    dets = detect_wanted(frame_bgr, watchlist, threshold, det_size=det_size,
                         min_face_px=min_face_px)
    return attach_snapshot(frame_bgr, dets)
