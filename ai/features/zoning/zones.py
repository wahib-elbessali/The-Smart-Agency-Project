"""Named zones for zone-based occupancy (queue counting, private-zone alerts,
etc.) -- the shared primitive behind several of the 16 product features.

Two independent zone types, mixed freely in one zones.json:

- "world" zones -- a floor-METRE polygon (same convention as
  tools/site_calibration.py's calib_points_camX.csv), checked
  against FUSED multi-camera positions. Needs calibration.
- "pixel" zones -- a polygon in ONE camera's own pixel coordinates, checked
  directly against that camera's raw (unfused) detections. Needs NO
  calibration at all -- if a zone is entirely covered by a single camera
  (true for most real zones: a queue area, a doorway, a private room), there
  is no real-world measurement to get, estimated or otherwise. This is the
  answer when you have no way to know the room's real dimensions.

Metres, not centimetres, for "world" zones is deliberate -- it matches the
calibration script's metre-in/cm-internal convention (this project has been
bitten twice by a silent metres/centimetres mixup), converted to cm
internally here, same as calibrate_one() does.
"""
import json
import cv2
import numpy as np


def load_zones(path):
    """-> {name: {"mode": "world"|"pixel", "camera": cam_id_or_None, "polygon": (N,2) array}}

    "polygon" is in cm for "world" zones, raw pixels for "pixel" zones.
    Accepts the current mixed-mode format:
        {"zones": {name: {"mode": "world", "polygon_m": [[x,y],...]}
                   | {"mode": "pixel", "camera": "0", "polygon_px": [[x,y],...]}}}
    and the older world-only format, for backward compatibility with
    already-authored zones.json files:
        {"units": "m", "zones": {name: [[x_m,y_m], ...]}}
    """
    d = json.load(open(path))
    zones = d.get("zones", {})
    out = {}
    if d.get("units") == "m":
        for name, poly in zones.items():
            out[name] = dict(mode="world", camera=None,
                             polygon=(np.array(poly, dtype=np.float64) * 100.0).astype(np.float32))
        return out

    for name, z in zones.items():
        mode = z["mode"]
        if mode == "world":
            out[name] = dict(mode="world", camera=None,
                             polygon=(np.array(z["polygon_m"], dtype=np.float64) * 100.0).astype(np.float32))
            if "converted_from" in z:
                out[name]["converted_from"] = z["converted_from"]
        elif mode == "pixel":
            out[name] = dict(mode="pixel", camera=z["camera"],
                             polygon=np.array(z["polygon_px"], dtype=np.float32))
        else:
            raise ValueError(f"{path}: zone {name!r} has unknown mode {mode!r}")
    return out


def zones_to_dict(zones):
    """zones: same shape load_zones() returns -> the mixed pixel/world
    zones.json dict shape (the inverse of load_zones(), always the current
    mixed format, never the older world-only one). Pure -- no file I/O,
    shared by save_zones() and features/zoning/api.py's GET /zones."""
    out = {}
    for name, z in zones.items():
        if z["mode"] == "world":
            out[name] = dict(
                mode="world", polygon_m=[[float(x) / 100.0, float(y) / 100.0] for x, y in z["polygon"]])
            # Carried through explicitly: this function rebuilds each entry from
            # scratch, so anything not copied here is silently lost on the next
            # save_zones() -- which would quietly discard the provenance of every
            # converted zone the first time an unrelated zone was added.
            if "converted_from" in z:
                out[name]["converted_from"] = z["converted_from"]
        else:
            out[name] = dict(
                mode="pixel", camera=z["camera"], polygon_px=[[float(x), float(y)] for x, y in z["polygon"]])
    return out


def save_zones(zones, path):
    """zones: same shape load_zones() returns -- writes the mixed
    pixel/world zones.json format."""
    json.dump({"zones": zones_to_dict(zones)}, open(path, "w"), indent=2)


def add_pixel_zone(zones, name, camera, polygon_px):
    """Adds (or overwrites, same name) a pixel-mode zone. polygon_px: [[x,y],...],
    >= 3 points -- raises ValueError otherwise, same "fail loud, don't guess"
    convention as common/face_id.py's enroll(). Mutates `zones` in place, also
    returned for chaining."""
    if len(polygon_px) < 3:
        raise ValueError(f"zone needs >= 3 points, got {len(polygon_px)}")
    zones[name] = dict(mode="pixel", camera=camera, polygon=np.array(polygon_px, dtype=np.float32))
    return zones


def add_world_zone(zones, name, polygon_m, converted_from=None):
    """Adds (or overwrites, same name) a world-mode zone. polygon_m: [[x,y],...]
    in floor METRES, >= 3 points -- same "fail loud" ValueError as
    add_pixel_zone().

    METRES in, CENTIMETRES stored: the in-memory polygon is cm because that's
    what occupancy() compares fused positions against, and what load_zones()
    produces when reading `polygon_m` off disk. pixel_to_world_m() returns
    metres, so its caller feeds this function directly without converting.

    `converted_from` records the pixel zone this came from (source camera +
    original pixel polygon) for traceability -- a world polygon is otherwise
    untraceable back to what anyone actually drew. Mutates `zones` in place,
    also returned for chaining."""
    if len(polygon_m) < 3:
        raise ValueError(f"zone needs >= 3 points, got {len(polygon_m)}")
    zones[name] = dict(
        mode="world", camera=None,
        polygon=(np.array(polygon_m, dtype=np.float64) * 100.0).astype(np.float32))
    if converted_from is not None:
        zones[name]["converted_from"] = converted_from
    return zones


def remove_zone(zones, name):
    """Raises KeyError if `name` isn't in `zones` -- callers translate that to
    a 404, not a silent no-op. Mutates `zones` in place, also returned."""
    if name not in zones:
        raise KeyError(name)
    del zones[name]
    return zones


def pixel_to_world_m(polygon_px, Hinv):
    """polygon_px: (N,2) pixel coords in ONE camera's own image -> (N,2) floor
    METRES, via that camera's Hinv (image pixel homogeneous -> floor cm, same
    convention as tools/site_calibration.py's calibrate_one()
    and features/calibration/engine.py's image_to_world). The building block
    for converting a "pixel" zone into a "world" zone -- see
    tools/zone_to_world.py, which is the actual tool that does that
    conversion and additionally refuses to run it through a camera that isn't
    aligned to a shared frame (this function itself has no way to know that
    -- it just applies Hinv)."""
    Hinv = np.asarray(Hinv, dtype=np.float64)
    out = []
    for px, py in polygon_px:
        p = Hinv @ np.array([px, py, 1.0])
        out.append((p[0] / p[2] / 100.0, p[1] / p[2] / 100.0))
    return out


def occupancy(fused_positions, raw_boxes_by_cam, zones):
    """fused_positions: [(x, y), ...] floor-cm points (from fuse_camera_boxes).
    raw_boxes_by_cam: {cam: [(x1,y1,x2,y2), ...]} raw per-camera detector boxes
    (unfused) -- only consulted for "pixel" zones.
    -> {zone_name: [(x, y), ...]} in whichever space that zone is defined in.

    A point can land in zero, one, or several zones (overlapping zones are
    allowed). Boundary points count as inside (cv2.pointPolygonTest == 0).
    """
    result = {name: [] for name in zones}
    for name, z in zones.items():
        if z["mode"] == "world":
            for x, y in fused_positions:
                if cv2.pointPolygonTest(z["polygon"], (float(x), float(y)), False) >= 0:
                    result[name].append((x, y))
        else:
            for box in raw_boxes_by_cam.get(z["camera"], []):
                foot = ((box[0] + box[2]) / 2.0, box[3])
                if cv2.pointPolygonTest(z["polygon"], foot, False) >= 0:
                    result[name].append(foot)
    return result
