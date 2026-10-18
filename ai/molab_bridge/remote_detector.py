"""Client side of the bridge: turns N camera frames into N sets of results,
by way of models that are not in this building.

This is the piece that stands where a local model stands -- originally just
the shared person detector, now every model this project runs: person,
weapon, fire (all plain YOLO, one shape) and face detection+embedding
(InsightFace, a different shape -- an embedding is not a box). Measured on
the dev laptop (i7-1165G7, no CUDA), 4 cameras at 1920x1080, the deployed
yolo11m_multi.pt:

    detector (PyTorch CPU)         12.72 s   <- 99.7% of a tracking cycle
    detector (OpenVINO iGPU FP16)   5.66 s
    POM fusion (hybrid_detect)      0.036 s
    Tracker.step                    0.0001 s

That ratio is the whole argument for this module, and it generalizes: every
model here is small next to the network trip that carries frames to it, so
moving the MODEL is what matters, not shaving milliseconds off any one of
them individually.

USAGE

    from remote_detector import RemoteDetector, RemoteFaceDetector

    det = RemoteDetector(model="person")             # or "weapon" / "fire"
    boxes = det.detect({"0": frame0}, imgsz=1920, conf=0.25)
    # -> {"0": ndarray (n, 6) xyxy+score+class_id, ...} ORIGINAL pixels

    faces = RemoteFaceDetector().detect_faces({"0": frame0}, det_size=(640, 640))
    # -> {"0": [{"bbox": (x1,y1,x2,y2), "det_score": float,
    #            "embedding": ndarray(512,)}, ...], ...}

Both are synchronous and blocking, which is what the callers want: they run
inside asyncio.to_thread already, and results belong to the frames handed in.

NOTHING IN features/'s OTHER MODULES IMPORTS THIS DIRECTLY. features/cloud/
is the seam -- see its README. (features/cloud/remote_detector.py is a
vendored copy of this exact file, kept in sync -- see its own docstring for
why.) The local models stay exactly as they are and stay default.
"""
import time

import cv2
import numpy as np
import requests

from protocol import pack_bundle, rescale_boxes, rescale_face

BRIDGE_URL = "http://127.0.0.1:8100"

# Transmission settings. These are the ONLY knobs that trade accuracy for
# bandwidth, and the trade is not neutral -- see MAX_WIDTH below.
JPEG_QUALITY = 75
MAX_WIDTH = None       # None = send at native resolution

# Each YOLO-family model's OWN fixed class order, exactly as it was
# trained -- see weapon_detection/engine.py and fire_detection/engine.py's
# own docstrings for the derivation. Mirrored here (not fetched from the
# bridge) because features/cloud never loads these checkpoints locally, so
# there is nowhere else to get `.names` from; these lists are a property of
# the TRAINING DATA, not of where inference runs, so they don't drift
# independently of the weights they describe.
CLASS_NAMES = {
    "person": {0: "person"},
    "weapon": {0: "pistol", 1: "knife", 2: "smartphone", 3: "monedero",
              4: "billete", 5: "tarjeta"},
    "fire": {0: "fire", 1: "smoke"},
}


def _encode_cams(frames: dict, jpeg_quality: int, max_width) -> tuple[list, list]:
    """{cam: BGR frame} -> (header_cams, jpeg_blobs), applying the shared
    downscale+encode policy. Split out because both RemoteDetector and
    RemoteFaceDetector need identically-shaped bundles; only what's
    requested of the model on the other end differs."""
    header_cams, jpegs = [], []
    for c in sorted(frames):
        frame = frames[c]
        h, w = frame.shape[:2]
        scale = 1.0
        if max_width and w > max_width:
            scale = max_width / w
            frame = cv2.resize(frame, (int(round(w * scale)), int(round(h * scale))),
                               interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality])
        if not ok:
            raise RuntimeError(f"could not JPEG-encode camera {c}'s frame")
        blob = buf.tobytes()
        header_cams.append({"id": str(c), "bytes": len(blob), "scale": scale, "w": w, "h": h})
        jpegs.append(blob)
    return header_cams, jpegs


def _post(bridge_url: str, header: dict, header_cams: list, jpegs: list, timeout: float) -> dict:
    payload = pack_bundle({**header, "seq": 0, "cams": header_cams}, jpegs)
    r = requests.post(f"{bridge_url}/detect", data=payload,
                      headers={"Content-Type": "application/octet-stream"}, timeout=timeout)
    if r.status_code == 503:
        raise RuntimeError(f"bridge unavailable: {r.json().get('detail', r.text)}")
    r.raise_for_status()
    return r.json()


class RemoteDetector:
    """A YOLO-family detector (person, weapon, or fire) whose weights live
    on a molab GPU.

    Deliberately NOT shaped like an ultralytics `YOLO` object -- that shim
    lives in features/cloud/remote_model.py, one layer up. It would be easy
    to fake `results[i].boxes.xyxy` well enough to slot in unnoticed at the
    existing call sites, and that is exactly the objection: a remote
    detector that is indistinguishable from a local one is one whose
    network failures are also indistinguishable from empty rooms. The
    honest shape here is frames in, per-camera results out, so that
    features/cloud's adoption of it is a visible, deliberate edit.
    """

    def __init__(self, model: str = "person", bridge_url: str = BRIDGE_URL,
                 jpeg_quality: int = JPEG_QUALITY, max_width: int | None = MAX_WIDTH,
                 timeout: float = 35.0):
        if model not in CLASS_NAMES:
            raise ValueError(f"unknown model {model!r} -- valid: {sorted(CLASS_NAMES)}")
        self.model = model
        self.names = CLASS_NAMES[model]
        self.bridge_url = bridge_url.rstrip("/")
        self.jpeg_quality = jpeg_quality
        self.max_width = max_width
        self.timeout = timeout
        self.last = {}

    def status(self) -> dict:
        """-> the bridge's own view: is a notebook connected, recent timings."""
        return requests.get(f"{self.bridge_url}/status", timeout=5).json()

    def detect(self, frames: dict, imgsz: int, conf: float = 0.25,
               classes=None, agnostic_nms: bool = False) -> dict:
        """{cam_id: BGR frame} -> {cam_id: ndarray (n, 6) of xyxy+score+class_id}.

        ALL CAMERAS GO UP IN ONE MESSAGE, sharing one capture timestamp.
        Splitting them into per-camera requests would be simpler to write
        and would reintroduce the per-camera time drift that POM fusion
        cannot tolerate -- see protocol.py's module docstring. (Only
        /people actually needs multiple cameras in step; weapon/fire call
        this one camera at a time today, which is a degenerate case of the
        same bundle shape, not a special path.)

        Coordinates come back in ORIGINAL pixel coordinates, already
        rescaled if the frame was downscaled for transmission. class_id
        indexes self.names, mirroring ultralytics' own `model.names`.

        Raises on any failure. Never returns empty results to mean "the
        link is down" -- an empty result is a claim that the room/frame
        has nothing in it.
        """
        cams = sorted(frames)
        if not cams:
            return {}
        header_cams, jpegs = _encode_cams(frames, self.jpeg_quality, self.max_width)

        # imgsz follows what is actually SENT: running the detector at 1920
        # on an image that was downscaled to 1280 just pads it back up,
        # paying full HD inference cost for 1280 worth of detail.
        sent_w = max(int(round(c["w"] * c["scale"])) for c in header_cams)
        sent_h = max(int(round(c["h"] * c["scale"])) for c in header_cams)
        sent_imgsz = min(imgsz, int(np.ceil(max(sent_w, sent_h) / 32.0) * 32))

        t0 = time.monotonic()
        result = _post(self.bridge_url,
                       {"t": time.time(), "model": self.model, "imgsz": sent_imgsz,
                        "conf": conf, "classes": classes, "agnostic_nms": agnostic_nms},
                       header_cams, jpegs, self.timeout)

        out = {}
        for c in header_cams:
            out[c["id"]] = rescale_boxes(result["boxes"].get(c["id"], []), c["scale"])
        self.last = {"round_trip_ms": round((time.monotonic() - t0) * 1000, 1),
                     "infer_ms": result.get("infer_ms"),
                     "sent_kb": round(sum(c["bytes"] for c in header_cams) / 1024, 1),
                     "sent_imgsz": sent_imgsz}
        return out

    def detect_xyxy(self, frames: dict, imgsz: int, conf: float = 0.25,
                    classes=None) -> dict:
        """As detect(), but dropping score/class -- the exact shape
        features/person_tracking's hybrid_detect() consumes ({cam: (n, 4)}),
        so a caller can hand the result straight to POM fusion. Only makes
        sense for model="person"; weapon/fire callers want detect()."""
        return {c: b[:, :4]
                for c, b in self.detect(frames, imgsz, conf, classes).items()}


class RemoteFaceDetector:
    """InsightFace (detection + embedding) on a molab GPU.

    A SEPARATE class from RemoteDetector, deliberately -- an embedding is
    not a box, and pretending otherwise (padding a 512-d vector into a
    "detect()" call meant for xyxy+score) would be exactly the kind of
    shape-faking this module's sibling class argues against.
    """

    def __init__(self, bridge_url: str = BRIDGE_URL, jpeg_quality: int = JPEG_QUALITY,
                 max_width: int | None = MAX_WIDTH, timeout: float = 35.0):
        self.bridge_url = bridge_url.rstrip("/")
        self.jpeg_quality = jpeg_quality
        self.max_width = max_width
        self.timeout = timeout
        self.last = {}

    def status(self) -> dict:
        return requests.get(f"{self.bridge_url}/status", timeout=5).json()

    def detect_faces(self, frames: dict, det_size=(640, 640)) -> dict:
        """{cam_id: BGR frame} -> {cam_id: [{"bbox","det_score","embedding"}, ...]},
        the exact shape features/face_recognition/engine.py's own
        detect_faces() returns -- see that module's set_faces_override.

        bbox is rescaled to ORIGINAL pixel coordinates; embedding and
        det_score are not (an embedding is not a coordinate) -- but see
        protocol.py's module docstring on why a heavily downscaled face
        crop is still an accuracy cost, unlike a detection box.
        """
        cams = sorted(frames)
        if not cams:
            return {}
        header_cams, jpegs = _encode_cams(frames, self.jpeg_quality, self.max_width)

        t0 = time.monotonic()
        result = _post(self.bridge_url,
                       {"t": time.time(), "model": "faces", "det_size": list(det_size)},
                       header_cams, jpegs, self.timeout)

        out = {}
        for c in header_cams:
            faces = result["faces"].get(c["id"], [])
            rescaled = [rescale_face(f, c["scale"]) for f in faces]
            for f in rescaled:
                f["embedding"] = np.asarray(f["embedding"], dtype=np.float32)
            out[c["id"]] = rescaled
        self.last = {"round_trip_ms": round((time.monotonic() - t0) * 1000, 1),
                     "infer_ms": result.get("infer_ms"),
                     "sent_kb": round(sum(c["bytes"] for c in header_cams) / 1024, 1)}
        return out
