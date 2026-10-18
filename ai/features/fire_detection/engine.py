"""Fire/smoke-detection primitive -- the AI/CV script behind this feature's
API (features/fire_detection/api.py). Backed by a community-finetuned
YOLOv8n (luminous0219/fire-and-smoke-detection-yolov8 on GitHub) -- 2
classes: fire, smoke. Same "smallest model that clears the bar" reasoning
as every other detector in this project.

LICENSE NOTE: this specific weights file is distributed under AGPL-3.0 --
the strongest copyleft tier, whose network-use clause can obligate open-
sourcing the whole service that runs it, since this project exposes it
through a live API. Chosen deliberately over a much larger (31.8M param,
Apache-2.0) alternative that was likely too heavy for the Raspberry Pi 4 CPU
deployment target -- see weapon_fire_detection_built in project memory for
the full tradeoff discussion. Revisit this choice if the licensing
implication turns out to matter for how this project gets distributed/used.

Verified against real photos before being trusted: a real wildfire photo
(Wikimedia Commons) correctly triggered a "fire" detection at the default
settings. Smoke detection needed imgsz=1280 (not ultralytics' usual 640) to
reliably fire on a real smoke photo at a reasonable confidence -- confirmed
by testing both settings against the same real image, not assumed -- so
1280 is this module's default, not 640.

Model auto-downloads to models/fire_yolov8n.pt on first use (gitignored,
*.pt). NOTE: loading this specific checkpoint triggers ultralytics'
AutoInstall for the 'dill' package on first load in a fresh environment --
a real internet-access dependency at model-load time, worth knowing about
before deploying somewhere with restricted egress (pre-install `pip install
dill` to avoid needing it at load time).
"""
import os
import urllib.request

from ..paths import MODELS

_MODEL = None
_WEIGHTS_PATH = MODELS / "fire_yolov8n.pt"
_WEIGHTS_URL = ("https://raw.githubusercontent.com/luminous0219/"
                "fire-and-smoke-detection-yolov8/main/weights/best.pt")

# Same hook as weapon_detection/engine.py -- see its comment.
_model_factory = None


def set_model_factory(factory):
    global _model_factory, _MODEL
    _model_factory = factory
    _MODEL = None

DEFAULT_IMGSZ = 1280  # NOT ultralytics' usual 640 -- see module docstring


def _ensure_weights():
    if not _WEIGHTS_PATH.exists():
        _WEIGHTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = str(_WEIGHTS_PATH) + ".part"
        urllib.request.urlretrieve(_WEIGHTS_URL, tmp)
        os.replace(tmp, _WEIGHTS_PATH)
    return _WEIGHTS_PATH


def get_model():
    """Lazy-loaded YOLO model, reused across calls in one process."""
    global _MODEL
    if _MODEL is None:
        if _model_factory is not None:
            _MODEL = _model_factory()
        else:
            from ultralytics import YOLO
            _MODEL = YOLO(str(_ensure_weights()))
    return _MODEL


def detect_fire(frame_bgr, conf=0.25, imgsz=DEFAULT_IMGSZ):
    """frame_bgr: HxWx3 uint8, OpenCV convention (as from cv2.imread/
    VideoCapture).
    -> list of {"class": str, "confidence": float, "bbox": (x1,y1,x2,y2)}
    sorted by confidence descending. Classes: fire, smoke."""
    model = get_model()
    res = model.predict([frame_bgr], conf=conf, imgsz=imgsz, verbose=False)[0]
    boxes = res.boxes
    if boxes is None or len(boxes) == 0:
        return []
    out = [
        {"class": model.names[int(c)], "confidence": float(s),
         "bbox": tuple(float(v) for v in b)}
        for c, s, b in zip(boxes.cls, boxes.conf, boxes.xyxy.cpu().numpy())
    ]
    out.sort(key=lambda d: -d["confidence"])
    return out
