"""REFERENCE UI -- not the deployed surface (see reference_ui/README.md). This
is the original local browser app for drawing zones -- click polygon corners
on a real page, no native GUI window required. Produces zones.json. The
real, deployed zoning logic now lives behind features/zoning/api.py -- a real
frontend does the clicking, this app just demonstrates one way that
interaction can work end to end.

This is zone-drawing ONLY. For a one-time site calibration (needed only if a
later feature wants a real floor position, e.g. a `world`-mode zone fused
across cameras), use reference_ui/calibration/calibration_app.py instead -- a deliberately
separate tool. The two are different concerns on different timelines:
calibration is infrastructure done once per site; zoning is per-feature, and
in the mode this project actually uses, doesn't depend on calibration at all.

Zones drawn here are per-camera pixel polygons -- NOT calibrated, NOT fused
across cameras. Draw a zone directly on one camera's own image; a detection
counts if its feet land inside that pixel region, checked only against that
one camera's own raw detections. No real-world measurement needed at all.

(Why not calibrated multi-camera zones: that needs every camera you're fusing
to agree on the SAME real-world floor coordinate system, which in turn needs
either real measurements or the exact same physical reference feature clicked
in each overlapping camera. Get it wrong and detections from different
cameras land tens to hundreds of cm apart for the same real person, which
silently kills the multi-camera consensus -- fused-detection counts of zero
even though people are clearly being detected in every individual camera.
Per-camera zones sidestep the whole problem. If a zone really is covered by
multiple cameras and that consensus matters enough to be worth it, calibrate
those specific cameras with reference_ui/calibration/calibration_app.py, verify them with its
cross-check tool, then hand-author a `world`-mode zone into zones.json -- see
docs/zone_occupancy.md.)

WORKFLOW
    python reference_ui/zoning/zone_app.py --video 0=cam0.mp4 --video 1=cam1.mp4
    -> open http://127.0.0.1:5001 in a browser

    Pick a camera tab, click as many polygon corners as you need (>= 3)
    around the real area you want, then "close zone" -- the last point
    connects back to the first automatically, you name it, and it saves
    immediately.

    Every action saves to disk immediately; there's also an explicit "save
    zones" button if you want to trigger a re-save on demand.
"""
import sys as _sys, pathlib as _pl
_root = next(p for p in _pl.Path(__file__).resolve().parents if (p / "paths.py").exists())
_sys.path.insert(0, str(_root))
import paths  # noqa: E402
from features.paths import ZONES

import argparse, json
import cv2
from flask import Flask, jsonify, request, send_file, render_template
import io

app = Flask(__name__)

STATE = dict(frames={}, zones={}, zones_out=str(ZONES))


@app.route("/")
def index():
    return render_template("zone.html", cams=sorted(STATE["frames"]))


@app.route("/frame/<cam>.png")
def frame(cam):
    fr = STATE["frames"][cam]
    ok, buf = cv2.imencode(".png", fr)
    return send_file(io.BytesIO(buf.tobytes()), mimetype="image/png")


@app.route("/state")
def state():
    return jsonify(zones={name: z["mode"] for name, z in STATE["zones"].items()})


def _save_zones():
    out = dict(zones={n: dict(mode="pixel", camera=z["camera"], polygon_px=z["polygon"])
                      for n, z in STATE["zones"].items()})
    json.dump(out, open(STATE["zones_out"], "w"), indent=2)


@app.route("/zone", methods=["POST"])
def zone():
    # pixel-only: no calibration needed, checked directly against this one
    # camera's own raw detections later (see module docstring for why)
    d = request.get_json()
    cam, name, poly_px = d["cam"], d["name"].strip(), d["polygon"]
    if not name:
        return jsonify(ok=False, error="empty zone name"), 400
    if len(poly_px) < 3:
        return jsonify(ok=False, error="need >= 3 points"), 400

    STATE["zones"][name] = dict(mode="pixel", camera=cam, polygon=poly_px)
    _save_zones()
    return jsonify(ok=True, polygon_px=poly_px, saved=STATE["zones_out"])


@app.route("/zone_undo", methods=["POST"])
def zone_undo():
    name = request.get_json()["name"]
    STATE["zones"].pop(name, None)
    _save_zones()
    return jsonify(ok=True)


@app.route("/zones_save", methods=["POST"])
def zones_save():
    # every /zone and /zone_undo call already writes zones.json immediately;
    # this is an explicit, on-demand re-save for a visible confirmation
    _save_zones()
    return jsonify(ok=True, saved=STATE["zones_out"], n=len(STATE["zones"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", action="append", required=True,
                    help="'cam_id=path/to/video.mp4', repeat once per camera")
    ap.add_argument("--frame", type=int, default=0, help="frame index to grab")
    ap.add_argument("--zones-out", default=str(ZONES))
    ap.add_argument("--port", type=int, default=5001)
    args = ap.parse_args()

    STATE["zones_out"] = args.zones_out

    for spec in args.video:
        cam, path = spec.split("=", 1)
        cap = cv2.VideoCapture(path)
        if args.frame:
            cap.set(cv2.CAP_PROP_POS_FRAMES, args.frame)
        ok, fr = cap.read()
        cap.release()
        if not ok:
            raise RuntimeError(f"could not read a frame from cam {cam} ({path})")
        STATE["frames"][cam] = fr
        print(f"cam {cam}: {fr.shape[1]}x{fr.shape[0]} <- {path}")

    print(f"\nopen http://127.0.0.1:{args.port} in a browser\n")
    app.run(host="127.0.0.1", port=args.port, debug=False)


if __name__ == "__main__":
    main()
