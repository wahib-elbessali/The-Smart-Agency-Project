"""Deployable surface over engine.py. A real frontend owns the interactive
part (showing a camera image, letting someone click points, the draggable
4th-corner UI trick -- see reference_ui/calibration/calibration_app.py for a
reference implementation of that interaction, or reference_ui/console/ for a
live client of this exact API); this API only ever receives a COMPLETE set of
already-clicked points per call and returns/persists the computed result. No
server-side click-by-click session state.

Mounted at /calibration by the unified app in features/main.py.

- GET    /calibration              -- current calibration for every camera
                                       (Hinv + diagnostics), e.g. so the frontend
                                       can show what's calibrated/aligned already.
- POST   /calibration/rect          -- {"camera", "points": [[px,py]] x4,
                                       "img_w", "img_h"} -> fits a fresh
                                       homography from an assumed right angle,
                                       with the TRUE aspect ratio inferred from
                                       the 4 points' own perspective geometry
                                       (see engine.infer_aspect -- NOT assumed
                                       square). Freshly fit = NOT aligned yet.
- POST   /calibration/align         -- {"points": [{cam: [px,py], ...}, ...]} --
                                       the FULL list of shared-point observations
                                       the frontend has collected -- runs the BFS
                                       alignment once over all of them, fitting
                                       the strongest transform the evidence
                                       supports (see engine.align_cameras).
- POST   /calibration/cross_check   -- {"points": {cam: [px,py], ...}} (>=2,
                                       already-aligned cams only) -> pairwise
                                       distances, read-only.
- GET    /calibration/gates         -- current entry/exit gate points (world
                                       coords), used by /people's tracker as a
                                       revival prior -- an unmatched detection
                                       far from every gate is assumed to be an
                                       existing person whose position drifted,
                                       not someone new walking in.
- POST   /calibration/gates         -- {"gates": [{"camera", "points": [[px,py],...]},
                                       ...]} -- REPLACES the whole gate list
                                       (same "complete set, no session state"
                                       convention as /align). Each camera must
                                       already be calibrated; points convert to
                                       world coords via that camera's Hinv.
- DELETE /calibration/gates         -- clears all gates.
- DELETE /calibration/{camera}      -- removes one camera's calibration entirely.

The frontend gets its clickable camera image from the app-level GET /frame and
GET /video_meta, which are shared by every feature rather than duplicated here.
"""
import threading

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..paths import CALIBRATION, GATES
from .engine import (
    align_cameras, fit_homography_rect, image_to_world, load_calibration, pairwise_distances,
    save_calibration,
)


router = APIRouter(prefix="/calibration", tags=["calibration"])

_cal = load_calibration(CALIBRATION)
_cal_lock = threading.Lock()


def _cal_to_json(cal):
    return {c: dict(Hinv=cal[c]["Hinv"].tolist(), diagnostics=cal[c].get("diag", {})) for c in cal}


def _load_gates():
    if not GATES.exists():
        return []
    import json
    return json.load(open(GATES)).get("gates", [])


def _save_gates(gates):
    import json
    json.dump({"gates": gates}, open(GATES, "w"), indent=2)


@router.get("")
def get_calibration():
    with _cal_lock:
        return _cal_to_json(_cal)


class RectRequest(BaseModel):
    camera: str
    points: list[list[float]]  # exactly 4, [px, py] each
    img_w: float               # the source frame's own pixel width
    img_h: float                # the source frame's own pixel height


@router.post("/rect")
def calibrate_rect(req: RectRequest):
    if len(req.points) != 4:
        raise HTTPException(422, f"need exactly 4 points, got {len(req.points)}")
    Hinv, diag = fit_homography_rect(req.points, req.img_w, req.img_h)
    if Hinv is None:
        raise HTTPException(422, "homography solve failed -- the 4 points are likely "
                                  "near-collinear (not a real quadrilateral)")
    diag["note"] = ("4-point exact fit: 0 reprojection error is expected regardless of "
                    "whether the right-angle assumption is actually true -- it does not "
                    "validate accuracy the way an over-determined metric fit's error does. "
                    "The rectangle's ASPECT ratio is inferred from the 4 points themselves "
                    "(see aspect_source/aspect_confident) -- read aspect_warning if "
                    "aspect_unreliable is true, the fit is provisional until fixed.")
    # freshly fit -> a brand new, independently-assumed frame, unrelated to any
    # previous alignment -- explicitly NOT aligned yet, gating /calibrate/cross_check
    diag["aligned"] = False
    with _cal_lock:
        _cal[req.camera] = dict(Hinv=Hinv, H=np.linalg.inv(Hinv), diag=diag)
        save_calibration(_cal, CALIBRATION)
    return diag


class AlignRequest(BaseModel):
    points: list[dict[str, list[float]]]  # [{cam: [px,py], ...}, ...]


@router.post("/align")
def calibrate_align(req: AlignRequest):
    with _cal_lock:
        result = align_cameras(_cal, req.points)
        if "error" in result:
            raise HTTPException(400, result["error"])
        save_calibration(_cal, CALIBRATION)
    return result


class CrossCheckRequest(BaseModel):
    points: dict[str, list[float]]  # {cam: [px,py], ...}, >= 2 entries


@router.post("/cross_check")
def calibrate_cross_check(req: CrossCheckRequest):
    if len(req.points) < 2:
        raise HTTPException(422, "need the same point in at least 2 cameras")
    with _cal_lock:
        missing = [c for c in req.points if c not in _cal]
        if missing:
            raise HTTPException(422, f"not calibrated yet: {missing}")
        unaligned = [c for c in req.points if not _cal[c].get("diag", {}).get("aligned")]
        if unaligned:
            raise HTTPException(422, f"not aligned yet: {unaligned} -- run /calibrate/align "
                                      f"first, cross-check only means something once cameras "
                                      f"are actually reconciled to a shared frame")
        worlds, pairs = pairwise_distances(_cal, req.points)
    return {"worlds": {c: [round(v, 1) for v in w] for c, w in worlds.items()}, "pairs": pairs}


class GatesRequest(BaseModel):
    gates: list[dict]  # [{"camera": str, "points": [[px,py], ...]}, ...]


# These must be declared BEFORE the /{camera} routes below -- FastAPI/Starlette
# matches routes in declaration order, and /{camera} is a path parameter that
# would otherwise swallow the literal "/gates" segment.
@router.get("/gates")
def get_gates():
    return {"gates": _load_gates()}


@router.post("/gates")
def post_gates(req: GatesRequest):
    """REPLACES the whole gate list (same convention as /align -- the
    frontend accumulates clicks locally across however many cameras and
    sends the full set each time). Each entry's `camera` must already be
    calibrated; its pixel points convert to world coordinates via that
    camera's CURRENT Hinv, same as any other point in this module."""
    with _cal_lock:
        world = []
        for entry in req.gates:
            cam = entry.get("camera")
            pts = entry.get("points", [])
            if cam not in _cal:
                raise HTTPException(422, f"camera {cam!r} has no calibration -- calibrate "
                                         f"it first (POST /calibration/rect)")
            world.extend([list(image_to_world(_cal[cam]["Hinv"], tuple(pt))) for pt in pts])
    _save_gates(world)
    return {"gates": world, "n": len(world), "saved": str(GATES)}


@router.delete("/gates")
def delete_gates():
    _save_gates([])
    return {"gates": [], "n": 0, "saved": str(GATES)}


@router.delete("/{camera}")
def delete_calibration(camera: str):
    with _cal_lock:
        if camera not in _cal:
            raise HTTPException(404, f"no such camera: {camera!r}")
        del _cal[camera]
        save_calibration(_cal, CALIBRATION)
    return {"camera": camera, "deleted": True}
