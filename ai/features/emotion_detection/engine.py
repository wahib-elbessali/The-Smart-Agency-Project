"""Emotion-detection primitive -- the AI/CV script behind this feature's API
(features/emotion_detection/api.py). Serves the "satisfaction clients"
product feature, scoped to emotion/expression detection only (correlating
mood with visit duration needs the still-unbuilt, deliberately-deferred
ticket-binding/tracking problem -- see product_feature_prioritization in
project memory).

Two-stage pipeline, reusing an already-built primitive rather than
duplicating it: face detection is
features.face_recognition.engine.detect_faces() (InsightFace's SCRFD) --
the same face detector already used and validated for access control, not a
second, different one. Only the per-face CLASSIFICATION (which emotion) is
new here, via hsemotion-onnx (av-savchenko/hsemotion-onnx, Apache-2.0),
EfficientNet-B0-based, ~16MB. 8 classes: Anger, Contempt, Disgust, Fear,
Happiness, Neutral, Sadness, Surprise.

REAL BUG in hsemotion-onnx 0.3.1 worked around here, not upstream: its
get_model_path() calls `urllib.request.urlretrieve` after only `import
urllib` (not `import urllib.request`) -- this raises
`AttributeError: module 'urllib' has no attribute 'request'` UNLESS
something else in the process already imported urllib.request first (a
classic Python submodule gotcha). Worked around by importing urllib.request
explicitly before touching the library, not by patching the installed
package.

REAL COLOR-CHANNEL BUG avoided here, not assumed away: hsemotion_onnx's own
preprocess() applies ImageNet mean/std normalization directly by channel
index (index 0 -> R's mean 0.485, matching standard RGB convention) with NO
BGR handling of its own -- it expects an RGB image. Frames in this project
come from cv2 (BGR, VideoCapture/imread convention), so this module converts
BGR->RGB explicitly before calling predict_emotions(); skipping this would
silently swap the R and B channels rather than crash, exactly the class of
bug this project has been bitten by before (the LFW float-vs-uint8 scaling
bug in evaluation/face_id_lfw_eval.py). Verified against a real photo with a
known, unambiguous expression before trusting this, not assumed correct
because the library "probably handles color order."

Model auto-downloads to ~/.hsemotion/<model_name>.onnx on first use (the
library's own hardcoded cache location, not this project's models/ dir --
can't be redirected without patching the library; still fully
re-downloadable, not a project deliverable, same spirit as every other
auto-downloaded model here).
"""
import urllib.request  # noqa: F401 -- see module docstring: must be imported before HSEmotionRecognizer

import cv2

from ..face_recognition.engine import detect_faces

_RECOGNIZER = None
_MODEL_NAME = "enet_b0_8_best_afew"


def get_recognizer():
    """Lazy-loaded HSEmotionRecognizer, reused across calls in one process."""
    global _RECOGNIZER
    if _RECOGNIZER is None:
        from hsemotion_onnx.facial_emotions import HSEmotionRecognizer
        _RECOGNIZER = HSEmotionRecognizer(model_name=_MODEL_NAME)
    return _RECOGNIZER


def detect_emotions(frame_bgr, det_size=(640, 640)):
    """frame_bgr: HxWx3 uint8, OpenCV convention (as from cv2.imread/
    VideoCapture).
    -> list of {"class": str, "confidence": float, "bbox": (x1,y1,x2,y2)}
    sorted by confidence descending -- one entry per detected face, "class"
    is the predicted emotion label. `det_size` is passed straight through to
    detect_faces() -- a larger value (e.g. (1280,1280)) can help catch
    smaller/more distant faces, same lever as fire_detection's imgsz."""
    recognizer = get_recognizer()
    h, w = frame_bgr.shape[:2]
    out = []
    for face in detect_faces(frame_bgr, det_size=det_size):
        x1, y1, x2, y2 = (int(v) for v in face["bbox"])
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        if x2 <= x1 or y2 <= y1:
            continue
        crop_bgr = frame_bgr[y1:y2, x1:x2]
        crop_rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)  # see module docstring
        emotion, scores = recognizer.predict_emotions(crop_rgb, logits=False)
        out.append({"class": emotion, "confidence": float(max(scores)), "bbox": face["bbox"]})
    out.sort(key=lambda d: -d["confidence"])
    return out
