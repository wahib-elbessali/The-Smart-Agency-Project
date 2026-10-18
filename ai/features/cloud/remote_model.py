"""Shims that make every remote model look like the local thing it replaces.

`features/`'s call sites use small, stable slices of two different APIs:

  YOLO-family (person/weapon/fire):
    model(images, imgsz=, conf=, verbose=)                         -> [result, ...]
    model.predict(images, imgsz=, conf=, classes=, agnostic_nms=, verbose=) -> [result, ...]
    result.boxes  ->  None / empty, or .xyxy/.conf/.cls (+ model.names)

  InsightFace (face/emotion/wanted, via detect_faces()):
    detect_faces(image_bgr, det_size) -> [{"bbox","det_score","embedding"}, ...]

RemoteYOLO covers the first; remote_detect_faces covers the second. Both sit
over remote_detector.py (a vendored copy of molab_bridge/remote_detector.py,
see that file), so `zoning`, `person_tracking`, `weapon_detection`,
`fire_detection`, `face_recognition` (and, through it, `emotion_detection`
and `wanted_detection`) run unmodified against models that live on a GPU
somewhere else.

ON WEARING THE LOCAL SHAPE
---------------------------
remote_detector.py argues against precisely this: a remote model
indistinguishable from a local one is one whose network failures are also
indistinguishable from empty rooms / no faces present. That objection is
answered here, not waived:

  * Nothing here ever fabricates an empty result. Every failure path in
    RemoteDetector / RemoteFaceDetector raises, and nothing here catches.
    A dead tunnel propagates out and surfaces as the calling feature's own
    error state -- the same way a dead camera does.
  * Which backend is running is a property of WHICH APP YOU LAUNCHED, not
    of a config file that could drift from reality. `GET /detector` on the
    cloud app answers it directly, and the local app has no such route.

So the interface is shared deliberately, and the failure semantics are not
shared at all. That is the whole trick: identical where sameness is the
point (the endpoints), loudly different where it isn't (what "nothing
detected" means).

WHAT STAYS LOCAL, ON PURPOSE. hsemotion (emotion classification) and
identify() (gallery matching) are NOT here -- see molab_bridge/molab_notebook.py's
module docstring for the first, and face_recognition/engine.py's identify()
docstring for the second. Neither is worth the network trip, and the
gallery match specifically must never touch the network at all: it
compares an embedding against named real people's stored data.
"""
import json
import pathlib

import numpy as np

from .remote_detector import CLASS_NAMES, RemoteDetector, RemoteFaceDetector

CONFIG_FILE = pathlib.Path(__file__).resolve().parent / "config.json"

DEFAULTS = {
    "bridge_url": "http://127.0.0.1:8100",
    "jpeg_quality": 75,
    # The bandwidth lever, and the one setting here that was MEASURED
    # rather than chosen. This link is bandwidth-bound and round-trip time
    # is linear in bytes sent (~85 KB/s measured), so width is the only
    # thing that moves latency -- the GPU itself is 9-30 ms and irrelevant.
    #
    # 960 rather than native, on 2x 1920x1080 w027, 20 frames sampled
    # across the sequence, scored against the SAME model at native:
    #     260 detections vs 259  (100.4%)
    #     243 matched, 16 missed, 17 extra
    #     median foot-point shift 3.3 px
    #     1.88 s/cycle vs 4.75 s  (2.5x faster)
    # Foot shift is what matters -- POM maps the box's bottom edge through
    # the ground homography -- and 3.3 px is a small fraction of a person
    # width, far inside the 1.64 pw match gate.
    #
    # This was checked over a sequence rather than one frame precisely
    # because the project's largest detector win came from running at
    # native resolution (HD recall 20% -> 66%); a downscale has to be
    # argued against real data, and on THIS scene it costs nothing. Re-run
    # scratchpad/bench_sequence.py on a new site before assuming it
    # transfers -- a scene with people further from the camera will not
    # behave the same.
    #
    # This is the person/tracking default. Face embeddings are more
    # resolution-sensitive than a detection box (see protocol.py's module
    # docstring) -- remote_detect_faces below does NOT use this value; it
    # always sends faces at native resolution, deliberately.
    "max_width": 960,
    "timeout": 35.0,
}


def load_config():
    """DEFAULTS with config.json merged over the top. Unknown keys are
    reported rather than ignored, matching features/config.py's stance --
    a typo that silently changes nothing is worse than an error."""
    cfg = dict(DEFAULTS)
    if CONFIG_FILE.exists():
        raw = json.load(open(CONFIG_FILE, encoding="utf-8"))
        for k, v in raw.items():
            if k not in DEFAULTS:
                print(f"[features.cloud] ignoring unknown key {k!r} in "
                      f"{CONFIG_FILE.name} -- valid keys: {sorted(DEFAULTS)}")
                continue
            cfg[k] = v
    return cfg


class _Array(np.ndarray):
    """A numpy array that also answers .cpu().numpy(), because that is how
    every caller in features/ unwraps a torch tensor."""

    def cpu(self):
        return self

    def numpy(self):
        return np.asarray(self)


class _Boxes:
    """The `.boxes` of one image's result -- xyxy, conf, AND cls, since
    weapon/fire read `model.names[int(c)]` off a real ultralytics result
    and need the same three fields here."""

    def __init__(self, arr):
        arr = np.asarray(arr, dtype=np.float32).reshape(-1, 6)
        self.xyxy = arr[:, :4].view(_Array)
        self.conf = arr[:, 4].view(_Array)
        self.cls = arr[:, 5].view(_Array)
        self._n = len(arr)

    def __len__(self):
        return self._n


class _Result:
    """One image's result. `boxes` only -- masks/keypoints/probs are not
    part of the slice features/ uses, and inventing empty ones would just
    make an unsupported feature look supported."""

    def __init__(self, arr):
        self.boxes = _Boxes(arr)


class RemoteYOLO:
    """Stands in for `ultralytics.YOLO`, backed by the molab bridge.

    One instance per MODEL ("person" | "weapon" | "fire") -- the class
    itself is generic across all three; only which checkpoint runs on the
    other end differs, exactly the way molab_notebook.py loads all three
    into one process and picks between them per bundle.

    Camera identity is positional here: callers pass a list of images and
    zip the results back against their own camera list, exactly as they do
    with the real YOLO. The bridge is keyed by camera id internally, so
    this maps positions to ids and back, and the ordering is preserved by
    construction rather than by luck.
    """

    def __init__(self, model: str = "person", weights_override=None, **kwargs):
        cfg = {**load_config(), **kwargs}
        self.detector = RemoteDetector(model=model, bridge_url=cfg["bridge_url"],
                                       jpeg_quality=cfg["jpeg_quality"],
                                       max_width=cfg["max_width"],
                                       timeout=cfg["timeout"])
        self.names = CLASS_NAMES[model]
        # Recorded only so GET /detector can report it. The remote side
        # loads its own copy of the same fine-tune -- a weights_override
        # pointing at a local file CANNOT be honoured over the bridge, so
        # it is refused rather than silently ignored.
        if weights_override:
            raise ValueError(
                f"features/cloud cannot honour a local weights override "
                f"({weights_override!r}) for model={model!r}: the detector runs on "
                f"the molab side, which loads its own copy. Leave the weights "
                f"config key null, or run the local app instead.")
        self.weights = f"remote: {model}"

    def __call__(self, images, imgsz=640, conf=0.25, classes=None,
                 agnostic_nms=False, verbose=False, **_ignored):
        frames = {str(i): im for i, im in enumerate(images)}
        boxes = self.detector.detect(frames, imgsz=imgsz, conf=conf, classes=classes,
                                     agnostic_nms=agnostic_nms)
        return [_Result(boxes[str(i)]) for i in range(len(images))]

    # ultralytics exposes both; zoning/weapon/fire use .predict,
    # person_tracking calls the object directly. Same thing.
    predict = __call__

    def status(self):
        """-> the bridge's view (is a notebook connected, recent timings),
        plus whatever the last call cost."""
        return {"bridge": self.detector.status(), "last_detect": self.detector.last}


def remote_detect_faces(image_bgr, det_size=(640, 640)):
    """Drop-in replacement for features/face_recognition/engine.py's own
    detect_faces() -- same signature, same return shape -- installed via
    that module's set_faces_override(). Faces are ALWAYS sent at native
    resolution (max_width=None), ignoring config.json's max_width: an
    embedding computed from a heavily downscaled crop is a real accuracy
    cost in a way a detection box's few pixels of shift is not -- see
    protocol.py's module docstring."""
    cfg = load_config()
    det = RemoteFaceDetector(bridge_url=cfg["bridge_url"], jpeg_quality=cfg["jpeg_quality"],
                             max_width=None, timeout=cfg["timeout"])
    faces = det.detect_faces({"0": image_bgr}, det_size=det_size)
    return faces["0"]
