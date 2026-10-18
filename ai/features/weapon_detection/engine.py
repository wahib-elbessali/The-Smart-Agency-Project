"""Weapon-detection primitive -- the AI/CV script behind this feature's API
(features/weapon_detection/api.py). Backed by a project-trained YOLOv8n
fine-tune on the Sohas_weapon-detection dataset (uploaded to
hf://wahib-elbessali/smartagency-detector, public), replacing the earlier
community model (Subh775/Threat-Detection-YOLOv8n). Same "smallest model
that clears the bar" reasoning as every other detector in this project (CPU
dev machine + Raspberry Pi 4 deployment target, no GPU anywhere).

WHY this model, and its scope: verified against real bodycam footage (see
weapon_sohas_finetune_result in project memory) to have real, better-
localized handgun detection than the old model -- e.g. a real officer-aiming-
a-handgun frame scored 0.79 confidence with a tight box, where the old model
false-positived on a background tree at 0.16 and missed the gun entirely.
Long guns/rifles are explicitly OUT OF SCOPE for this product (an agency/
office setting, not a battlefield -- user's call) and Sohas has no long-gun
class, so this is a deliberate handgun-and-knife specialist, not a strict
superset of the old model's 4 classes (`explosion`/`grenade` are dropped,
untested under the old model anyway).

Sohas trains 6 classes -- `pistol`, `knife` (the 2 we alert on) plus
`smartphone`, `monedero` (wallet), `billete` (banknote), `tarjeta` (card) as
deliberate lookalike DISTRACTOR classes, so the model learns to tell a gun
apart from a phone in a hand rather than just firing on "person holding a
dark rectangular thing". _ALERT_CLASSES below filters the distractors back
out of this module's output -- they were never something to alert on, only
scaffolding to make the pistol/knife classification more precise.

`agnostic_nms=True` on the predict() call: a real, observed failure mode
(see project memory) is the SAME physical object scoring under two different
classes in adjacent frames (a held pistol misclassified as `smartphone` at
0.34 one frame after being correctly boxed `pistol` at 0.79). Class-agnostic
NMS means that when two candidate boxes for different classes overlap on the
same object, only the higher-confidence one survives -- it doesn't eliminate
the misclassification, but it stops both an alert-worthy and a non-alert
class from being reported simultaneously for one real object.

Model auto-downloads to models/weapon_sohas_yolov8n.pt on first use
(gitignored, *.pt, re-downloadable, same convention as yolov8n.pt/
InsightFace's buffalo_s -- not a project deliverable). Public repo, no HF
token needed.
"""
from ..paths import MODELS

_MODEL = None
_WEIGHTS_PATH = MODELS / "weapon_sohas_yolov8n.pt"
_HF_REPO = "wahib-elbessali/smartagency-detector"
_HF_FILE = "checkpoints/weapon_sohas/best.pt"

# Same dependency-inversion hook as features/common/person_detector.py's
# set_model_factory -- installed by a subpackage (features/cloud/) to
# run this exact fine-tune on a remote GPU instead of loading it here.
# factory() -> a model supporting .predict(images, conf=, imgsz=,
# agnostic_nms=, verbose=) -> [result,...] with result.boxes.{cls,conf,xyxy}
# and a .names dict, i.e. the same surface get_model() already returns, so
# detect_weapons() below needs NO changes at all.
_model_factory = None


def set_model_factory(factory):
    global _model_factory, _MODEL
    _model_factory = factory
    _MODEL = None          # never serve a model from the old backend

# Sohas trains 4 extra lookalike-distractor classes (smartphone, monedero,
# billete, tarjeta) so the model learns to tell a weapon apart from an
# everyday object -- not something to alert on.
_ALERT_CLASSES = {"pistol", "knife"}


def _ensure_weights():
    if not _WEIGHTS_PATH.exists():
        import shutil
        from huggingface_hub import hf_hub_download
        _WEIGHTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        downloaded = hf_hub_download(_HF_REPO, _HF_FILE)
        shutil.copy(downloaded, _WEIGHTS_PATH)
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


def detect_weapons(frame_bgr, conf=0.25, imgsz=640):
    """frame_bgr: HxWx3 uint8, OpenCV convention (as from cv2.imread/
    VideoCapture).
    -> list of {"class": str, "confidence": float, "bbox": (x1,y1,x2,y2)}
    sorted by confidence descending. Classes: pistol, knife (lookalike
    distractor classes the model was trained with -- smartphone, monedero,
    billete, tarjeta -- are filtered out, not alert-worthy)."""
    model = get_model()
    res = model.predict([frame_bgr], conf=conf, imgsz=imgsz, agnostic_nms=True, verbose=False)[0]
    boxes = res.boxes
    if boxes is None or len(boxes) == 0:
        return []
    out = [
        {"class": model.names[int(c)], "confidence": float(s),
         "bbox": tuple(float(v) for v in b)}
        for c, s, b in zip(boxes.cls, boxes.conf, boxes.xyxy.cpu().numpy())
        if model.names[int(c)] in _ALERT_CLASSES
    ]
    out.sort(key=lambda d: -d["confidence"])
    return out
