"""Shared person detector -- the SAME fine-tuned yolo11m_multi.pt used by both
features/zoning and features/person_tracking. Extracted from
features/zoning/api.py's _ensure_weights/_get_yolo verbatim (zoning's own
behaviour -- weights path, lazy HF download, loud-not-silent failure -- is
unchanged by this move). Cached by resolved weights path so two features
loading "the same" model share ONE ~120MB+ in-process copy instead of two --
same reasoning features/main.py's docstring gives for face/emotion/wanted
sharing one InsightFace pack instead of three. If a site operator sets two
features' weights config keys to two DIFFERENT local files, that's a
deliberate choice and two models load -- this cache only collapses the common
case where both are left at the null default.
"""
import threading

from ..paths import MODELS

_HF_REPO = "wahib-elbessali/smartagency-detector"
_HF_FILE = "checkpoints/yolo11m_multi/best.pt"
_WEIGHTS_PATH = MODELS / "yolo11m_multi.pt"

_yolo_models = {}        # {weights_path: YOLO}, lazy-loaded, reused across calls
_yolo_lock = threading.Lock()

# Optional replacement for how a detector is obtained. None -> load the
# local checkpoint, which is what this package does on its own and what
# every existing caller gets.
#
# This exists so a subpackage can serve the identical endpoints backed
# by a detector that isn't here -- see features/cloud/, which runs the same
# model on a remote GPU. Dependency inversion rather than an import: this
# module still imports nothing outside itself, and knows nothing about
# what a replacement might be. Whoever installs one owns it.
#
# Deliberately not a config.json key. A backend is chosen by launching a
# different app, not by editing a file -- so "which detector is this
# service using" is answered by what you started, and can never quietly
# differ from what the config on disk says.
_model_factory = None


def set_model_factory(factory):
    """Install a replacement for the model loader, or None to restore the
    local one. `factory(weights_override) -> model`, where model supports
    the small surface every caller here uses:

        model(images, imgsz=, conf=, verbose=) -> [result, ...]
        model.predict(images, imgsz=, conf=, classes=, verbose=) -> [result, ...]
        result.boxes is None/empty, or has .xyxy.cpu().numpy()

    A replacement MUST raise on failure rather than return empty results.
    Returning no boxes is a positive claim that the cameras saw nobody, and
    the whole service is built to never say that when it doesn't know --
    see features/zoning's people_tracking_ready flag for the same rule.

    Call it once at startup, before any feature's background loop begins.
    """
    global _model_factory
    with _yolo_lock:
        _model_factory = factory
        _yolo_models.clear()          # never serve a model from the old backend


def _ensure_weights(weights_override=None):
    """-> a local path to the person detector, downloading it once if needed.

    Fails LOUDLY rather than falling back to a stock ultralytics detector. A
    silent fallback would still produce boxes, so nothing would look broken --
    while quietly giving up the fine-tune's measured gain (Lab6p recall 8.4% ->
    95.7%). Wrong-but-plausible counts are worse than an error that names the
    problem."""
    if weights_override:
        return weights_override                            # explicit override, local file
    if not _WEIGHTS_PATH.exists():
        import shutil
        from huggingface_hub import hf_hub_download
        _WEIGHTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        try:
            downloaded = hf_hub_download(_HF_REPO, _HF_FILE)
        except Exception as e:
            raise RuntimeError(
                f"could not fetch the person detector ({_HF_FILE} from {_HF_REPO}): {e}. "
                f"Either upload it to that repo, or set config.json's weights key to a "
                f"local copy of yolo11m_multi.pt.") from e
        shutil.copy(downloaded, _WEIGHTS_PATH)
    return str(_WEIGHTS_PATH)


def get_model(weights_override=None):
    """-> a shared ultralytics.YOLO instance for the given weights (or the
    default project detector if weights_override is None), loaded once and
    reused across every caller that resolves to the same weights path."""
    with _yolo_lock:
        if _model_factory is not None:
            # Keyed the same way, so a replacement backend gets the same
            # one-instance-per-weights sharing between zoning and
            # person_tracking that the local loader provides.
            key = ("factory", weights_override)
            if key not in _yolo_models:
                _yolo_models[key] = _model_factory(weights_override)
            return _yolo_models[key]
        weights = _ensure_weights(weights_override)
        if weights not in _yolo_models:
            _yolo_models[weights] = _load(weights)
        return _yolo_models[weights]


def _load(weights):
    """-> the detector, on the best runtime this machine has.

    The model is always the same yolo11m_multi.pt; only the runtime differs
    (CUDA / OpenVINO / NCNN / plain PyTorch -- see accelerated_detector for
    the ladder and the measurements). Acceleration is an optimisation, never
    a requirement: any failure to set one up falls back to PyTorch with the
    reason printed, rather than taking the service down."""
    from ..config import CONFIG
    from . import accelerated_detector
    requested = CONFIG.get("detector", {}).get("backend", "auto")
    try:
        model, how = accelerated_detector.build(weights, requested)
        print(f"[detector] {how}")
        return model
    except Exception as e:
        print(f"[detector] {requested!r} backend unavailable ({e}) -- using PyTorch on CPU")
        from ultralytics import YOLO
        return YOLO(weights)
