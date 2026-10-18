"""VENDORED COPY of molab_bridge/protocol.py, kept byte-identical on purpose.

molab_bridge/ (the notebook-side relay + its GPU-side counterpart) and
features/cloud/ (this client) are two INDEPENDENTLY deployable things -- one
runs on whatever machine hosts this service, the other runs inside a molab
GPU notebook -- so neither may import the other. The wire format they both
speak has to live somewhere on each side; this is that somewhere on this
side. PORT ANY CHANGE TO BOTH COPIES, same rule this project already applies
to features/person_tracking/engine.py (vendored from architectures/) -- a
protocol the two ends disagree about fails exactly the quiet way this
module's own docstring below warns about.

Everything past this point is unmodified from molab_bridge/protocol.py.
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
