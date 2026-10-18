"""Run the shared person detector on whatever this machine actually has.

The model is always the same fine-tuned yolo11m_multi.pt -- only the runtime
changes. Picking it by hand means every deployment is one forgotten setting
away from running the slow path and looking merely "a bit sluggish", so the
default is `auto`:

    CUDA GPU present            -> pytorch on cuda      (fastest by far)
    else Intel GPU present      -> openvino on intel:gpu
    else ARM (Raspberry Pi)     -> ncnn
    else                        -> pytorch on cpu

MEASURED on the dev laptop (i7-1165G7 / Iris Xe, x86), 2 cameras of
1920x1080 footage, seconds per call, warmed up. All three produced
IDENTICAL boxes at both sizes:

    backend            imgsz 640   imgsz 1280
    pytorch cpu             0.67         2.52
    openvino intel:gpu      0.20         0.97      <- 3.3x / 2.6x
    ncnn cpu                1.19         3.92      <- SLOWER than pytorch

and at native 1920 across 4 cameras: pytorch 13.31 s -> openvino 5.55 s
(2.40x), identical box counts, median IoU 0.970-0.997.

Two things that table settles:

  * OpenVINO's gain is entirely the idle Iris Xe iGPU. OpenVINO on the CPU
    is worth nothing (12.40 s vs 12.72 s at 1920x4), which is why the
    ladder tests for a GPU rather than just "is openvino importable".
  * **ncnn is slower than PyTorch on x86** -- it is built for ARM NEON, and
    this is exactly why the ladder reaches it only on ARM. Picking it here
    would be a pessimisation, so `auto` never does.

The ncnn rung's CODE PATH is verified (it exports, loads and detects); its
SPEED ON A PI IS NOT -- there is no Pi to test on. Expect a Pi 4 to be
~5-8x slower than this laptop before ncnn's own gain, so yolo11m at HD
will not be real time there whatever the runtime. That needs a smaller
model, not a faster loader.

The cuda rung is ultralytics' own path and is UNTESTED here -- no CUDA on
this machine.

EXPORTED FORMATS ARE PER-imgsz. openvino and ncnn both compile for a fixed
input size; a dynamic export accepts any size but runs slower. This
service's imgsz is fixed for a site once /people bootstraps (detect_imgsz
reads the cameras' own resolution), so exports are cached per size and
built on demand -- the first call at a new size pays 5-20 s once.
"""
import platform
import threading

import numpy as np

from ..paths import MODELS

_lock = threading.Lock()
_ov_devices = None

# The formats that need a conversion step before use. "cuda"/"pytorch" run
# the .pt directly.
EXPORTED = {"openvino", "ncnn"}


def _openvino_devices():
    global _ov_devices
    if _ov_devices is None:
        try:
            import openvino
            _ov_devices = list(openvino.Core().available_devices)
        except Exception:
            _ov_devices = []
    return _ov_devices


def has_cuda():
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def has_intel_gpu():
    """An Intel GPU OpenVINO can actually target. Deliberately not just
    'is openvino importable' -- OpenVINO on CPU is no faster than PyTorch,
    so falling to it would be a speedup that isn't one."""
    return any(d.startswith("GPU") for d in _openvino_devices())


def is_arm():
    """Raspberry Pi and friends."""
    return platform.machine().lower() in ("aarch64", "arm64", "armv7l", "armv6l")


def resolve_backend(requested="auto"):
    """-> one of 'cuda' | 'openvino' | 'ncnn' | 'pytorch', and says why.

    Announces the choice because the failure mode being guarded against is
    silent: a machine that quietly lands on plain CPU looks identical to
    one where the acceleration is working, just slower -- and 'slower' is
    exactly what someone is likely to blame on the cameras or the model."""
    if requested and requested != "auto":
        return requested
    if has_cuda():
        return "cuda"
    if has_intel_gpu():
        return "openvino"
    if is_arm():
        return "ncnn"
    print(f"[detector] no CUDA, no Intel GPU ({_openvino_devices() or 'openvino absent'}), "
          f"not ARM -- falling back to PyTorch on CPU")
    return "pytorch"


class ExportedYOLO:
    """Ultralytics-shaped, backed by a converted model (openvino or ncnn).

    Presents only the slice features/ uses:
        model(images, imgsz=, conf=, classes=, verbose=) -> [result, ...]
        model.predict(...)                               -> same
        result.boxes -> None/empty, or .xyxy.cpu().numpy()
    """

    def __init__(self, weights, fmt, device=None):
        if fmt not in EXPORTED:
            raise ValueError(f"{fmt!r} is not an exported format ({sorted(EXPORTED)})")
        self.weights = str(weights)
        self.fmt = fmt
        self.device = device
        self._by_imgsz = {}

    def _model_for(self, imgsz):
        imgsz = int(np.ceil(imgsz / 32.0) * 32)          # detector stride
        with _lock:
            if imgsz in self._by_imgsz:
                return self._by_imgsz[imgsz], imgsz
            from pathlib import Path
            from ultralytics import YOLO

            src = Path(self.weights)
            out = MODELS / f"{src.stem}_{self.fmt}{imgsz}_{self.fmt}_model"
            if not out.exists():
                print(f"[detector] exporting {src.name} to {self.fmt} at imgsz={imgsz} "
                      f"(one time, ~5-30s)...", flush=True)
                kw = dict(format=self.fmt, imgsz=imgsz)
                if self.fmt == "openvino":
                    kw.update(half=True, dynamic=False)
                # ultralytics always writes to "<stem>_<fmt>_model" beside the
                # weights, so exports at different sizes would overwrite each
                # other. Move it to a size-tagged directory immediately.
                Path(YOLO(self.weights).export(**kw)).replace(out)
            self._by_imgsz[imgsz] = YOLO(str(out), task="detect")
            return self._by_imgsz[imgsz], imgsz

    def __call__(self, images, imgsz=640, conf=0.25, classes=None,
                 verbose=False, **_ignored):
        model, imgsz = self._model_for(imgsz)
        kw = dict(imgsz=imgsz, conf=conf, classes=classes, verbose=verbose)
        if self.device:
            kw["device"] = self.device
        # Static exports are batch-1, so cameras go one at a time. That costs
        # nothing measurable: batching gave NO speedup on this hardware even
        # in PyTorch -- per-camera time was flat from 1 to 4 cameras, because
        # one HD image already saturates it.
        return [model(im, **kw)[0] for im in images]

    predict = __call__


def build(weights, requested="auto"):
    """-> (model, description). Raises if the chosen backend can't be set
    up; person_detector catches and falls back to PyTorch, loudly."""
    backend = resolve_backend(requested)
    if backend == "cuda":
        from ultralytics import YOLO
        model = YOLO(str(weights))
        model.to("cuda")
        return model, "pytorch on cuda"
    if backend == "openvino":
        device = "intel:gpu" if has_intel_gpu() else "intel:cpu"
        return ExportedYOLO(weights, "openvino", device), f"openvino on {device}"
    if backend == "ncnn":
        return ExportedYOLO(weights, "ncnn"), "ncnn on cpu"
    from ultralytics import YOLO
    return YOLO(str(weights)), "pytorch on cpu"
