"""Tiny shared helper for reading a single frame (or metadata) out of a video
SOURCE -- an RTSP/HTTP camera URL or a local file path. Used by
features/calibration/api.py, features/zoning/api.py, features/person_tracking
and every alert-stream feature (via common/live_alert_service.py), which all
need a live per-camera read for their respective compute endpoints -- pulled
out here once rather than duplicated in each.

LIVE sources (rtsp/http/mjpeg URL, or a bare camera index -- see is_stream)
are handled through a persistent, keyed-by-source-string LiveGrabber
registry, vendored from architectures/pom_fusion/generic_pipeline.py's
is_stream/LiveGrabber. That module's docstring records the confirmed bug this
fixes: this project's detector runs 4-8x slower than a 25fps stream, so a
naive synchronous read (worse here -- this file used to open a FRESH
VideoCapture and immediately release it, i.e. reconnect, on every single
call) drains/reconnects against a backlog in FIFO order, and
independently-lagging cameras silently disagree on what real moment they are
looking at. LiveGrabber's background drain thread always returns the newest
frame instead.

FILE sources are completely unchanged from before this fix: a fresh
cv2.VideoCapture per call, released immediately, index honoured via
CAP_PROP_POS_FRAMES, frame-0-by-default when index=None (see the recurring
"read_frame() opens a fresh capture each cycle" gotcha documented in project
memory -- a FILE source always yields frame 0 unless index is given; that
behaviour is deliberately untouched here).

Accepted tradeoff: a LiveGrabber registry entry (one background thread + one
open connection) is never explicitly torn down -- it persists for the life of
the process once a source string has been read once. This mirrors the same
tradeoff features/zoning's and features/weapon_detection's own `_sources`
registries already accept (entries accumulate, nothing is ever swept), just
now also holding an OS thread and a live connection per distinct source
string. Sources are operator-registered through each feature's `POST
.../sources`, not attacker-controlled, so this is a fine deployment tradeoff,
not a resource-exhaustion risk.
"""
import os
import threading
import time

import cv2

# Force RTSP over TCP. OpenCV's FFMPEG backend defaults to UDP for RTSP in
# most builds; VLC negotiates TCP (or falls back to it) far more readily.
# UDP drops packets on any real network (NAT, wifi, a switch under load),
# and a dropped packet is exactly what breaks the H.264 stream state -- so
# "works fine in VLC, dies here" is the single most common RTSP symptom
# this causes. Set once, globally, before any capture opens; harmless for
# the http/mjpeg sources this module also handles, which never look at it.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")


def is_stream(source):
    """Vendored from generic_pipeline.py -- identical logic/reasoning
    (CAP_PROP_FRAME_COUNT and cap.set(CAP_PROP_POS_FRAMES) are both silently
    meaningless on a live source, which is why streams and files need
    different handling throughout this module)."""
    return str(source).startswith(("http://", "https://", "rtsp://", "rtmp://")) or str(source).isdigit()


RECONNECT_AFTER_S = 3.0     # consecutive read failures for this long -> reopen the capture
RECONNECT_BACKOFF_S = 1.0   # wait between reopen attempts, so a fully dead camera
                            # doesn't spin this thread at 100% forever


class LiveGrabber:
    """Wraps a live cv2.VideoCapture with a background drain thread so
    .read() ALWAYS returns the newest available frame, never a backlog.
    Originally vendored from architectures/pom_fusion/generic_pipeline.py --
    see that module's docstring for the drain/backlog story.

    RECONNECTS on its own. The vendored version did not: once a single
    cap.read() call failed, the pump loop kept calling .read() on the SAME
    now-dead capture forever, sleeping 20ms between each no-op retry --
    self._frame was simply never updated again. Every caller of read() kept
    receiving the last good frame, indefinitely, with ok=True: a frozen
    feed that looks exactly like a working one, the silent-plausible
    failure this project guards against everywhere else. Real RTSP
    connections DO drop -- a network blip, a camera reboot, a brief
    encoder hiccup -- and OpenCV's FFMPEG backend does not recover from
    that on its own the way a player like VLC does; a fresh
    cv2.VideoCapture is required. Confirmed as the reported symptom
    ("works fine in VLC, stops updating here").
    """
    def __init__(self, path):
        self._path = path
        self._cap = self._open(path)
        self._frame = None
        self._lock = threading.Lock()
        self._stop = False
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()
        t0 = time.time()
        while self._frame is None and time.time() - t0 < 20 and not self._stop:
            time.sleep(0.02)

    @staticmethod
    def _open(path):
        cap = cv2.VideoCapture(path)
        # Fail a stuck read() quickly rather than block forever -- without
        # this, a capture that hangs (not merely returns False) can never
        # be detected as failed at all, and the reconnect logic below never
        # gets a chance to run. Best-effort: older opencv-python builds may
        # not honour these on every backend, so a hang is still possible on
        # some platforms, just less likely.
        try:
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10000)
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000)
        except Exception:
            pass
        return cap

    def _pump(self):
        fail_since = None
        while not self._stop:
            ok, fr = self._cap.read()
            if not ok:
                now = time.time()
                if fail_since is None:
                    fail_since = now
                elif now - fail_since > RECONNECT_AFTER_S:
                    print(f"[video_source] {self._path!r}: no frame for "
                          f"{RECONNECT_AFTER_S:.0f}s, reconnecting")
                    self._cap.release()
                    self._cap = self._open(self._path)
                    fail_since = None
                    time.sleep(RECONNECT_BACKOFF_S)
                else:
                    time.sleep(0.02)
                continue
            fail_since = None
            with self._lock:
                self._frame = fr

    def read(self):
        with self._lock:
            fr = self._frame
        return (fr is not None), (None if fr is None else fr.copy())

    def get(self, prop):
        return self._cap.get(prop)

    def release(self):
        self._stop = True
        self._thread.join(timeout=2)
        self._cap.release()


_live_sources = {}            # {source_string: LiveGrabber} -- persistent, reused across calls
_live_sources_lock = threading.Lock()


def _get_live_grabber(source):
    with _live_sources_lock:
        g = _live_sources.get(source)
        if g is None:
            g = LiveGrabber(int(source) if str(source).isdigit() else source)
            _live_sources[source] = g
        return g


def read_frame(source, index=None, quality=1.0):
    """-> HxWx3 uint8 BGR frame, or None if the source can't be opened or the
    requested index can't be read. `index` is only meaningful for a FILE
    source (a live source cannot be seeked, so index is ignored there);
    index=None reads whatever frame the source is currently positioned at
    (frame 0 for a fresh file capture, or the newest frame for a live one).

    `quality` is a fraction of the source's native resolution (1.0 = full),
    from the camera table -- see common/cameras.py. It downscales AFTER
    reading, so the LiveGrabber still drains at full rate and only the
    frame handed to a model gets smaller.

    A caller that turns pixels into world coordinates must not assume the
    frame is native size. Take the size from the FRAME (frame.shape), never
    from video_meta(), and scale the homography accordingly -- see
    calibration/engine.py's scale_Hinv."""
    if is_stream(source):
        ok, frame = _get_live_grabber(source).read()
        frame = frame if ok else None
    else:
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            return None
        if index is not None:
            cap.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = cap.read()
        cap.release()
        frame = frame if ok else None
    if frame is not None and quality and quality != 1.0:
        h, w = frame.shape[:2]
        frame = cv2.resize(frame, (max(1, int(round(w * quality))),
                                   max(1, int(round(h * quality)))),
                           interpolation=cv2.INTER_AREA)
    return frame


def video_meta(source):
    """-> {"n_frames": int, "fps": float, "width": int, "height": int}, or
    None if the source can't be opened. A live source has no length, so
    n_frames is always 0 for one (CAP_PROP_FRAME_COUNT is garbage on a
    stream) -- callers must not do arithmetic on it expecting a real video
    length."""
    if is_stream(source):
        ok, frame = _get_live_grabber(source).read()
        if not ok:
            return None
        h, w = frame.shape[:2]
        fps = _get_live_grabber(source).get(cv2.CAP_PROP_FPS) or 25.0
        if not (0 < fps < 121):
            fps = 25.0
        return dict(n_frames=0, fps=fps, width=w, height=h)
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        return None
    meta = dict(
        n_frames=int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        fps=cap.get(cv2.CAP_PROP_FPS) or 25.0,
        width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
    )
    cap.release()
    return meta
