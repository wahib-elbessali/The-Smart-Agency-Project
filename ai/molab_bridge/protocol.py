"""The wire format, in one place, imported by both ends.

ONE MESSAGE PER CYCLE, CARRYING EVERY CAMERA. This is the single most
important property of this protocol and the reason it is not just the
upstream molab template with a different payload.

That template streams one webcam. POM fusion needs all N cameras from the
SAME instant -- it sums evidence from every camera onto one floor grid, so
cameras that disagree about *when* fuse into people who were never there.
Running N independent bridges would reintroduce exactly the per-camera
drift that was already diagnosed the hard way on the live-streaming path
(see docs/tracking_attempts.md, "The live-streaming era"): three cameras
backing up by different amounts is three cameras looking at three different
moments. Bundling makes that failure structurally impossible rather than
merely unlikely -- there is only one capture timestamp to be wrong about.

Frame bundle, local -> molab (binary):

    uint32   length of the JSON header, network byte order
    bytes    the JSON header, utf-8:
                 {"t": <float, local monotonic capture time>,
                  "seq": <int, monotonically increasing>,
                  "model": "person" | "weapon" | "fire" | "faces",
                  "imgsz": <int>, "conf": <float>,        # detect-family only
                  "classes": <list[int] or null>,
                  "agnostic_nms": <bool>,                 # detect-family only
                  "det_size": [w, h],                     # faces only
                  "cams": [{"id": "0", "bytes": 12345,
                            "scale": 0.667,      # transmitted/original
                            "w": 1920, "h": 1080},   # ORIGINAL dims
                           ...]}
    bytes    each camera's JPEG, concatenated in "cams" order

`model` picks which of the notebook's preloaded checkpoints runs this
bundle: "person"/"weapon"/"fire" are all plain YOLO detectors (the same
shared yolo11m person model, and the project's weapon/fire fine-tunes) --
only the weights differ, so they share one result shape. "faces" runs
InsightFace (detection + embedding) instead -- a different shape, since an
embedding isn't a box.

Result, molab -> local (JSON text). Shape depends on `model`:

    detect-family ("person"/"weapon"/"fire"):
        {"seq", "t", "infer_ms",
         "boxes": {"0": [[x1, y1, x2, y2, score, class_id], ...], ...}}
        class_id indexes into that model's OWN fixed class list -- see
        remote_detector.CLASS_NAMES, which mirrors the class order each
        model was actually trained with (weapon_detection/engine.py,
        fire_detection/engine.py). person's class_id is always 0.

    "faces":
        {"seq", "t", "infer_ms",
         "faces": {"0": [{"bbox": [x1,y1,x2,y2], "det_score": float,
                          "embedding": [512 floats]}, ...], ...}}

Coordinates (boxes and face bboxes alike) come back in the coordinates of
the image that was SENT. If that image was downscaled, they are NOT yet in
the coordinates the calibration homographies expect -- see rescale_boxes /
rescale_face, and the warning on rescale_boxes.

Face EMBEDDINGS are not rescaled (they are not coordinates) -- but they are
computed from the TRANSMITTED resolution, so a heavily downscaled face
crop can measurably change recognition accuracy, unlike a detection box
(where a few pixels of shift rarely flips a match/no-match decision). If
/face or /wanted accuracy matters, prefer sending faces at native
resolution (max_width=None) over the bandwidth savings a lower one buys.
"""
import json
import struct

import numpy as np

_LEN = struct.Struct("!I")


def pack_bundle(header: dict, jpegs: list[bytes]) -> bytes:
    """-> one binary message carrying every camera for a single instant."""
    raw = json.dumps(header).encode("utf-8")
    return _LEN.pack(len(raw)) + raw + b"".join(jpegs)


def unpack_bundle(message: bytes) -> tuple[dict, dict[str, bytes]]:
    """-> (header, {cam_id: jpeg_bytes}); the inverse of pack_bundle."""
    (n,) = _LEN.unpack_from(message)
    header = json.loads(message[_LEN.size:_LEN.size + n].decode("utf-8"))
    jpegs, off = {}, _LEN.size + n
    for cam in header["cams"]:
        jpegs[cam["id"]] = message[off:off + cam["bytes"]]
        off += cam["bytes"]
    return header, jpegs


def rescale_boxes(boxes, scale: float):
    """Map boxes from TRANSMITTED pixels back to ORIGINAL pixels.

    This is not an optimisation, it is a correctness requirement, and it is
    the quietest way this whole bridge can go wrong. Downscaling for
    bandwidth and forgetting to undo it produces boxes that are perfectly
    well-formed, plausible-looking, and land at ~0.67x of where the person
    actually is. The ground homography then maps them to a confident wrong
    place on the floor -- no exception, no empty result, just people
    tracked somewhere they are not. It would look like a calibration bug,
    which is precisely the diagnosis this project has already been sent
    down twice by other causes.

    So the local side owns the rescale (it is the side that chose the
    scale), and it happens before the boxes are returned to any caller --
    never in the notebook, which should stay a dumb detector.
    """
    b = np.asarray(boxes, dtype=np.float64).reshape(-1, 6)
    if scale != 1.0 and len(b):
        b[:, :4] /= scale
    return b


def rescale_face(face: dict, scale: float) -> dict:
    """The face-detection analogue of rescale_boxes: maps `bbox` from
    TRANSMITTED pixels back to ORIGINAL pixels. `embedding` and `det_score`
    are untouched -- an embedding is not a coordinate, so there is nothing
    to rescale (see the module docstring on the accuracy consequence of
    downscaling faces, which is real but is not this bug)."""
    out = dict(face)
    if scale != 1.0:
        x1, y1, x2, y2 = face["bbox"]
        out["bbox"] = [x1 / scale, y1 / scale, x2 / scale, y2 / scale]
    return out
