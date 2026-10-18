"""Deployable surface over engine.py, mounted at /face by the unified app in
main.py.

- POST   /face/enroll       -- name + one photo in, added to the gallery.
- GET    /face/faces        -- every enrolled person + their full embedding
                           vectors (e.g. so the backend can mirror this
                           gallery into its own database).
- DELETE /face/faces/{name} -- removes a person's ENTIRE gallery entry.
- POST   /face/scan         -- event-triggered recognition for access control:
                           given a video SOURCE (an RTSP camera URL, or a
                           file path for testing), opens it, watches it until
                           a face is found (or `timeout_seconds` elapses),
                           and returns the result directly in the response
                           (blocking -- see below for why). Deliberately has
                           NO concept of "gates" -- the backend already
                           knows which camera belongs to which physical
                           gate, so it sends us the raw source and gets the
                           answer back on the same request; nothing
                           gate-specific is stored here.
- POST   /face/capture      -- event-triggered VISITOR capture. Same
                           watch-a-source-until-a-face-appears shape as
                           /scan, but touches NO gallery: no name in, no
                           name out. Returns a photo of the face + its
                           embedding and nothing else -- see the section
                           below on why this is a deliberately different
                           identity model from enroll/scan.

This gallery (face_gallery.json) is SEPARATE from wanted_detection's watchlist
(wanted_gallery.json), and the routes are named differently on purpose so the
two can't be confused. Since the unified app runs both in one process, that file
separation and the distinct route names are now the whole of the isolation
between "enrolled employee" and "wanted person" -- there is no longer a process
or port boundary.

/face/capture SERVES A DIFFERENT IDENTITY MODEL than enroll+scan, and it is
worth being explicit about the split. Enroll/scan are for a KNOWN, NAMED
population (staff) -- enroll once with a name, and this service recognizes
that person forever after, entirely within itself. /capture is for an OPEN
population (walk-in visitors) where this service never learns who anyone
is, on purpose: it hands back a face's photo and embedding and stops there.
Comparing that embedding against previously-captured ones, deciding "new
visitor" vs "the same person from last week", and owning any resulting
visitor id is 100% the CALLER's job. This service has no visitor gallery
and no visitor-identity concept -- there is nothing here to grow unbounded,
and nothing here that could leak a visitor's identity even if it wanted to,
because it was never told one.

/scan is a plain blocking request/response, not a callback: the caller's
HTTP request just stays open for up to `timeout_seconds` while we scan, then
we reply directly. This was a deliberate choice over a callback/webhook --
since the backend is expected to handle requests concurrently (async or
multi-worker, as any real backend would), one gate's scan sitting open for
15s doesn't stop the backend from handling other gates or unrelated work at
the same time, and this way the backend doesn't need to build a receiving
endpoint at all.
"""
import base64
import threading
import time

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..common.video_source import is_stream, read_frame
from ..paths import FACE_GALLERY
from ..face_recognition.engine import detect_faces, enroll, identify, load_gallery, save_gallery

router = APIRouter(prefix="/face", tags=["face recognition"])

_gallery = load_gallery(FACE_GALLERY)
_gallery_lock = threading.Lock()

_active_scans = set()  # sources currently being scanned -- guards a double activation
_active_scans_lock = threading.Lock()

DEFAULT_SCAN_TIMEOUT = 15.0


def _decode_image(raw_bytes):
    """raw_bytes: an encoded image file (jpg/png) as bytes, e.g. from an
    UploadFile. -> HxWx3 uint8 BGR, or None if the bytes aren't a decodable image."""
    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


@router.post("/enroll")
def enroll_endpoint(name: str = Form(...), image: UploadFile = File(...)):
    """multipart/form-data: name (str) + image (one photo, exactly one face).
    -> {"name": ..., "embeddings_count": N} -- N counts every photo ever
    enrolled for this name, including from earlier calls."""
    img = _decode_image(image.file.read())
    if img is None:
        raise HTTPException(400, "could not decode image")
    with _gallery_lock:
        try:
            enroll(_gallery, name, img)
        except ValueError as e:
            raise HTTPException(422, str(e))
        save_gallery(_gallery, FACE_GALLERY)
        count = len(_gallery[name])
    return {"name": name, "embeddings_count": count}


@router.get("/faces")
def list_faces():
    """-> [{"name": str, "embeddings": [[512 floats], ...]}, ...] -- the full
    gallery, e.g. for the backend to mirror into its own database."""
    with _gallery_lock:
        return [{"name": name, "embeddings": [e.tolist() for e in embs]}
                for name, embs in _gallery.items()]


@router.delete("/faces/{name}")
def delete_face(name: str):
    """Removes name's ENTIRE gallery entry. -> {"name": ..., "embeddings_removed": N}."""
    with _gallery_lock:
        if name not in _gallery:
            raise HTTPException(404, f"no such person: {name!r}")
        removed = len(_gallery.pop(name))
        save_gallery(_gallery, FACE_GALLERY)
    return {"name": name, "embeddings_removed": removed}


class ScanRequest(BaseModel):
    source: str          # RTSP camera URL, or a video file path for testing
    timeout_seconds: float = DEFAULT_SCAN_TIMEOUT


def _watch_for_faces(source, timeout_seconds):
    """Watches `source` until at least one face is detected or
    `timeout_seconds` elapses. -> (frame, faces, timed_out, error).

    `frame` is the BGR image faces were found in (None if none were);
    `faces` is detect_faces()'s own list, sorted by det_score descending
    (empty if none found). Exactly one of timed_out/error is meaningful
    when faces is empty -- `error` means the source couldn't be opened at
    all (bad URL, camera offline); `timed_out` means it opened fine but
    nobody showed up in time. Callers need to react differently to each.

    Shared by every /face route that needs to "wait for someone to show up
    at a camera": /scan (matches the result against the gallery) and
    /capture (returns the raw face + a photo, no gallery involved) both
    build on this rather than each re-implementing the live/file dispatch
    and the polling loop.

    Live sources (RTSP/HTTP) and file sources need genuinely different
    handling -- see _watch_live vs _watch_file below; this just dispatches
    on which one `source` is (see common/video_source.is_stream)."""
    if is_stream(source):
        return _watch_live(source, timeout_seconds)
    return _watch_file(source, timeout_seconds)


def _watch_live(source, timeout_seconds):
    """Polls read_frame() -- the SAME reconnecting LiveGrabber every other
    live feature uses -- instead of a private cv2.VideoCapture.

    This replaces a real bug, not a style choice: an earlier version of
    this scan path opened its OWN raw cv2.VideoCapture and treated the
    FIRST failed .read() as end-of-stream, aborting the whole attempt
    immediately. That is a reasonable assumption for a file (a failed read
    there really does mean EOF) and a wrong one for a live RTSP feed,
    where a single dropped read is routine -- a network blip, or simply
    not having synced to a keyframe yet immediately after opening -- and
    does NOT mean the stream is dead. VLC handles exactly this by
    retrying/resyncing; raw OpenCV .read() does not, and this reported as
    "scan not working" against a real camera that works fine in VLC.

    LiveGrabber (common/video_source.py) already solves this -- reconnect
    logic, RTSP forced to TCP -- for every other feature; this path just
    wasn't using it before. read_frame() returns the newest frame
    currently held, or None only if the source could never be opened at
    all (up to ~20s on a brand new source; cached and instant on repeat
    calls against the same camera)."""
    frame = read_frame(source)
    if frame is None:
        return None, [], False, "could not open source"
    start = time.monotonic()
    while time.monotonic() - start < timeout_seconds:
        frame = read_frame(source)
        if frame is not None:
            faces = detect_faces(frame)
            if faces:
                return frame, faces, False, None
        # Guards the LOCAL-detector case (sub-100ms) from spinning needlessly
        # fast; irrelevant when detect_faces() is a remote call over molab,
        # which already takes multiple seconds per call on its own.
        time.sleep(0.15)
    return None, [], True, None


def _watch_file(source, timeout_seconds):
    """Unchanged from the original: a fresh cv2.VideoCapture, advancing
    frame by frame. A failed read here really does mean end-of-file, so
    the original "abort on first failure" logic is correct for this case
    -- only the live-source path above needed to change."""
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        return None, [], False, "could not open source"
    start = time.monotonic()
    try:
        while time.monotonic() - start < timeout_seconds:
            ok, frame = cap.read()
            if not ok:
                break  # end of file
            faces = detect_faces(frame)
            if faces:
                return frame, faces, False, None
    finally:
        cap.release()
    return None, [], True, None


def _run_scan(source, timeout_seconds):
    """-> {"source", "name" (str or None), "score" (float or None),
    "timed_out" (bool), "error" (str or None)} -- identifies the first
    face found against the ENROLLED gallery. See _watch_for_faces for the
    watch/timeout/error mechanics this builds on."""
    frame, faces, timed_out, error = _watch_for_faces(source, timeout_seconds)
    if error:
        return {"source": source, "name": None, "score": None, "timed_out": False, "error": error}
    if not faces:
        return {"source": source, "name": None, "score": None, "timed_out": True, "error": None}
    with _gallery_lock:
        gallery_snapshot = dict(_gallery)
    name, score = identify(gallery_snapshot, faces[0]["embedding"])
    return {"source": source, "name": name, "score": round(score, 3),
           "timed_out": False, "error": None}


def _run_capture(source, timeout_seconds):
    """-> {"source", "image" (base64 JPEG of the face crop, or None),
    "bbox", "det_score", "embedding" (or None), "timed_out", "error"}.

    NO gallery, NO identify() -- see this module's docstring on why
    /capture is a deliberately different identity model from /scan. Takes
    the highest-det_score face if several are visible (detect_faces()
    already sorts that way); a ticket kiosk expects one person at a time,
    and picking a favourite among several isn't this service's call to
    make silently -- the caller sees only one photo/embedding per call
    either way, by construction."""
    frame, faces, timed_out, error = _watch_for_faces(source, timeout_seconds)
    empty = {"source": source, "image": None, "bbox": None, "det_score": None, "embedding": None}
    if error:
        return {**empty, "timed_out": False, "error": error}
    if not faces:
        return {**empty, "timed_out": True, "error": None}

    face = faces[0]
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = face["bbox"]
    # 40% margin on each side: a razor-tight crop to the bbox is nearly
    # useless as "a photo of them" -- confirmed by testing (a real 37x31px
    # crop from a distant camera), not assumed. This is the photo a human
    # (or the backend's own dedup UI) might actually need to look at, not
    # a model input -- detect_faces() already ran on the full frame, so
    # nothing here affects the embedding's accuracy either way.
    mx, my = (x2 - x1) * 0.4, (y2 - y1) * 0.4
    x1, y1 = max(0, int(round(x1 - mx))), max(0, int(round(y1 - my)))
    x2, y2 = min(w, int(round(x2 + mx))), min(h, int(round(y2 + my)))
    crop = frame[y1:y2, x1:x2] if x2 > x1 and y2 > y1 else frame
    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
    image_b64 = base64.b64encode(buf.tobytes()).decode("ascii") if ok else None

    return {"source": source, "image": image_b64,
           "bbox": [round(float(v), 1) for v in face["bbox"]],
           "det_score": round(float(face["det_score"]), 4),
           "embedding": [round(float(v), 5) for v in face["embedding"]],
           "timed_out": False, "error": None}


@router.post("/scan")
def scan_endpoint(req: ScanRequest):
    """Blocking: opens req.source, scans for up to req.timeout_seconds, and
    returns the result directly in this response (see /scan's module-level
    docstring for why this is blocking rather than a callback). A sync `def`
    route runs in FastAPI's threadpool, so this doesn't block the event loop
    -- other requests (other gates, unrelated endpoints) are served
    concurrently while this one is in flight.
    409s if this exact source is already being scanned by another in-flight
    request (prevents a double button-press from opening two captures on the
    same camera)."""
    with _active_scans_lock:
        if req.source in _active_scans:
            raise HTTPException(409, f"already scanning source: {req.source!r}")
        _active_scans.add(req.source)
    try:
        return _run_scan(req.source, req.timeout_seconds)
    finally:
        with _active_scans_lock:
            _active_scans.discard(req.source)


@router.post("/capture")
def capture_endpoint(req: ScanRequest):
    """Blocking, same lifecycle as /scan (see its docstring): opens
    req.source, watches for a face, returns directly.

    UNLIKE /scan, touches NO gallery and calls identify() on nothing --
    no name in, no name out. Returns a photo of the face and its
    embedding; deciding whether this is a new visitor or one returning,
    and owning any resulting visitor id, is entirely the CALLER's job --
    see this module's top-level docstring for why that split is
    deliberate. Shares /scan's `_active_scans` guard (keyed by source, not
    by route): the two can't safely open two captures on the same camera
    concurrently either way."""
    with _active_scans_lock:
        if req.source in _active_scans:
            raise HTTPException(409, f"already scanning source: {req.source!r}")
        _active_scans.add(req.source)
    try:
        return _run_capture(req.source, req.timeout_seconds)
    finally:
        with _active_scans_lock:
            _active_scans.discard(req.source)
