"""REFERENCE UI -- not the deployed surface (see reference_ui/README.md). This
is the original local browser app for ONE-TIME, per-site calibration -- click
points on a real page, no native GUI window required. Produces
site_calibration.json: a ground-plane homography per camera (pixel <-> floor
position). The real, deployed calibration logic now lives behind
features/calibration/api.py -- a real frontend does the clicking, this app
just demonstrates one way that interaction can work end to end.

This is calibration ONLY. For drawing zones, use reference_ui/zoning/zone_app.py
instead -- a deliberately separate tool. The two are different concerns on
different timelines: calibration is infrastructure, done once per site, that
any future feature can reuse (tracking, a `world`-mode zone fused across
cameras, whatever comes next of the 16 planned features); zoning is
per-feature, drawn and redrawn as needs change, and (in the pixel mode this
project actually uses -- see reference_ui/zoning/zone_app.py's own docstring
for why) doesn't even depend on this step at all.

WORKFLOW
    python reference_ui/calibration/calibration_app.py --video 0=cam0.mp4 --video 1=cam1.mp4
    -> open http://127.0.0.1:5000 in a browser

    "calibrate" mode: click 3 points that trace a shape you're confident is a
    right angle in real life (a floor tile, a rug, perpendicular wall/floor
    lines) -- ANY rectangle, not necessarily a square, and no numbers typed:
    the true aspect ratio of whatever you clicked is inferred straight from
    the 4 points' own perspective geometry (vanishing-point rectification,
    see _infer_aspect), not assumed. The 4th corner is auto-placed the moment
    you have 3 (parallelogram completion: corner4 = corner1 + corner3 -
    corner2) as a DRAGGABLE handle -- drag it to align with whatever you can
    actually see of that corner (out of frame, blocked, awkward angle are all
    fine), or just click its true position directly if you can see it
    precisely -- doing so removes the 2 degrees of freedom a 3-point click
    can never resolve on its own (a homography needs 4 point correspondences;
    3 points plus "it's a right angle" is still 2 short), which is strictly
    more reliable than leaning on the aspect inference's simplified-camera
    assumptions. The auto-placement is an approximation (exact only for a
    near-front-on view -- a real rectangle doesn't project to an exact
    parallelogram under general perspective), which is why it's draggable
    rather than trusted outright. Repeat per camera, then "compute + save
    calibration" writes site_calibration.json.

    "cross-check two cameras agree" mode: once 2+ cameras are calibrated,
    click the same real point in each and compare -- verifies their
    coordinate systems actually agree BEFORE you rely on that (a 4-point
    exact fit's reprojection error is always ~0 by construction regardless of
    whether the right-angle assumption holds, so it can't catch this on its
    own; two independently-calibrated cameras anchored to different physical
    tiles will silently produce zero fused detections downstream). Read-only
    diagnostic -- doesn't change anything.

    "align cameras (shared points)" mode: for when no single real rectangle
    is visible across every camera you want to fuse (common with wide
    baselines), so the rect mode above can't anchor them to a shared frame by
    itself. Click the SAME real point across whichever cameras happen to see
    it -- any point, any subset of cameras, repeat for as many points as you
    want ("record shared point" banks one; you don't need the same point
    visible in every camera, just >=2 points shared between any two cameras
    you want tied together). "align cameras now" then SOLVES for the
    scale+rotation+translation that reconciles each camera's independently-
    assumed frame with a chosen reference camera's frame (chaining through
    intermediate cameras if two cameras never directly share a point), bakes
    that correction into each camera's Hinv, and re-saves
    site_calibration.json. Unlike cross-check, this mutates the calibration.

    Cross-check is GATED on alignment -- you can't cross-check a camera until
    it's been aligned, because two freshly rect-calibrated cameras invent
    independent frames by construction, so cross-checking them first would
    almost always "fail" and tell you nothing new. Align first, then
    cross-check to confirm it worked (ideally with different points than the
    ones used to fit the alignment).

    Cross-check and align's per-camera views can SCROLL through each
    camera's video independently (cameras aren't necessarily time-synced) --
    needed because floor tiling is often uniform/repetitive enough that no
    single static frame lets you identify "the same real point" across wide-
    baseline cameras. Scrub each camera to a moment where a person is
    visible, and click their feet -- a much more reliable shared landmark
    than floor texture when the floor itself doesn't have one.
"""
import sys as _sys, pathlib as _pl
_root = next(p for p in _pl.Path(__file__).resolve().parents if (p / "paths.py").exists())
_sys.path.insert(0, str(_root))
import paths  # noqa: E402
from features.paths import CALIBRATION

import argparse, json, threading, time, collections
import numpy as np
import cv2
from flask import Flask, jsonify, request, send_file, render_template
import io

app = Flask(__name__)

# _infer_aspect's stability check (see its docstring): how many jointly-
# perturbed re-solves to average over, the assumed per-click pixel noise, and
# the relative-spread threshold below which the result is called "confident".
_STABILITY_TRIALS = 24
_STABILITY_NOISE_PX = 1.0
_STABILITY_MAX_RELATIVE_STD = 0.15

STATE = dict(frames={}, video_paths={}, video_meta={}, rect_points={}, cal={}, align_points=[],
            calib_out=str(CALIBRATION), gates=[], gates_out=None, cur_line={}, align_lines=[],
            buffers={}, holds={}, hold_axis=None)


def _image_to_world(Hinv, uv):
    p = Hinv @ np.array([uv[0], uv[1], 1.0])
    return (p[0] / p[2], p[1] / p[2])


def _world_to_image(H, xy):
    p = H @ np.array([xy[0], xy[1], 1.0])
    return (p[0] / p[2], p[1] / p[2])


def _fit_homography(rows):
    """rows: [(px, py, world_x_pt, world_y_pt), ...] -> (Hinv, diagnostics), same
    fit math as tools/site_calibration.py's calibrate_one() --
    used internally by _fit_homography_rect below with an assumed (not
    measured) target.

    Units are "pt" -- deliberately NOT a real metric unit. The old "cm" label
    was fiction: it just multiplied the assumed unit square by 100, which
    only means real centimetres if the square you clicked happens to BE 1m
    per side in reality, which was never verified. Rather than imply a false
    precision, this stays explicitly unitless/arbitrary -- internally
    consistent (good enough for tracking gates, which get tuned against
    real behavior anyway) but not a claim about real-world scale."""
    arr = np.array(rows, dtype=float)
    px = arr[:, :2]
    wc = arr[:, 2:]
    H, _ = cv2.findHomography(wc, px)
    if H is None:
        return None, None
    Hinv = np.linalg.inv(H)
    ones = np.ones((len(px), 1))
    proj_px = (H @ np.hstack([wc, ones]).T).T
    proj_px = proj_px[:, :2] / proj_px[:, 2:3]
    px_err = np.linalg.norm(proj_px - px, axis=1)
    return Hinv, dict(n_points=len(px), px_err_mean=float(px_err.mean()),
                      px_err_max=float(px_err.max()))


def _fit_homography_rect(pixel_pts, aspect=1.0):
    """4 clicked pixel points (in order around an ASSUMED right-angle shape,
    e.g. clockwise from any corner) -> (Hinv, diagnostics). No real-world
    measurement at all -- the target is a canonical rectangle (default
    square, 1 side = 1 "pt" by convention -- the same made-up unit
    _fit_homography works in, so the two feed the same pipeline), the
    assumption being that the 4 clicked points really do form a right angle
    in real life. Same cv2.findHomography call as _fit_homography, just with
    an assumed rather than measured target.
    """
    px = np.array(pixel_pts, dtype=float)
    target_m = np.array([[0, 0], [aspect, 0], [aspect, 1], [0, 1]], dtype=float)
    return _fit_homography([(px[i, 0], px[i, 1], target_m[i, 0], target_m[i, 1])
                            for i in range(4)])


def _infer_aspect_core(pixel_pts, img_w, img_h):
    """Single vanishing-point solve, no stability check -- (aspect, reason).
    aspect is None whenever the geometry is too degenerate to trust (near-
    parallel sides, no real focal-length solution, implausible result); reason
    then explains why. See _infer_aspect (the public wrapper) for the method."""
    def line(a, b):
        return np.cross(a, b)

    p = [np.array([x, y, 1.0]) for x, y in pixel_pts]
    v1 = np.cross(line(p[0], p[1]), line(p[3], p[2]))   # p0->p1 side's vanishing pt
    v2 = np.cross(line(p[0], p[3]), line(p[1], p[2]))   # p0->p3 side's vanishing pt

    # near-zero w (relative to the point's own magnitude) -> vanishing point at
    # infinity, i.e. that side pair is already parallel in the image (a
    # front-on view along that axis) -- the orthogonality solve below needs a
    # finite vanishing point on both axes
    def near_infinity(v):
        return abs(v[2]) < 1e-6 * max(abs(v[0]), abs(v[1]), 1.0)
    if near_infinity(v1) or near_infinity(v2):
        return None, "one side pair is already parallel in the image (vanishing point at infinity)"

    v1 = v1 / v1[2]; v2 = v2 / v2[2]
    cx, cy = img_w / 2.0, img_h / 2.0
    # orthogonality constraint (zero-skew, square-pixel, centred-principal-point
    # camera): the two real-world side directions are perpendicular, which in
    # terms of the camera's own K matrix pins down the only unknown, f
    f_sq = -((v1[0] - cx) * (v2[0] - cx) + (v1[1] - cy) * (v2[1] - cy))
    if f_sq <= 0:
        return None, "orthogonality constraint gave no real focal length (noisy clicks?)"
    f = float(np.sqrt(f_sq))
    if not (0.2 * img_w <= f <= 20 * img_w):
        return None, f"solved focal length ({f:.0f}px) is implausible for this image size"

    K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1.0]])
    Kinv = np.linalg.inv(K)
    ray = lambda pt: Kinv @ pt

    D1 = ray(v1); D1 = D1 / np.linalg.norm(D1)
    D2 = ray(v2); D2 = D2 / np.linalg.norm(D2)
    N = np.cross(D1, D2)
    n = np.linalg.norm(N)
    if n < 1e-9:
        return None, "degenerate plane normal"
    N = N / n

    # intersect all 4 corners' rays with ONE common plane (normal N, through
    # an arbitrarily-chosen reference point on corner 0's own ray -- only
    # RATIOS of resulting lengths matter, so the overall unknown scale/depth
    # of this plane is irrelevant)
    Q = ray(p[0]); d = N @ Q
    X = []
    for pt in p:
        r = ray(pt)
        denom = N @ r
        if abs(denom) < 1e-9:
            return None, "a corner's sightline is parallel to the inferred plane"
        X.append((d / denom) * r)
    X = np.array(X)
    rel = X - X[0]
    u, v = rel @ D1, rel @ D2
    side_01 = float(np.hypot(u[1] - u[0], v[1] - v[0]))
    side_03 = float(np.hypot(u[3] - u[0], v[3] - v[0]))
    if side_03 < 1e-9:
        return None, "degenerate side length"
    aspect = side_01 / side_03

    if not (0.2 <= aspect <= 5.0):
        return None, f"inferred aspect {aspect:.2f} is outside the plausible range -- likely noisy clicks"
    return aspect, None


def _infer_aspect(pixel_pts, img_w, img_h):
    """4 clicked pixel points (same order as _fit_homography_rect: p0,p1,p2,p3
    around an assumed right-angle shape) -> (aspect, diagnostics). Infers the
    TRUE aspect ratio of side (p0,p1) vs side (p0,p3) from the image alone --
    NOT assumed to be 1.0/square. Standard single-view rectangle rectification:
    the rectangle's two side directions are parallel to their opposite sides
    in real life, so each pair of opposite sides' image lines meet at a
    vanishing point; assuming a simple camera (zero skew, square pixels,
    principal point at image centre), the fact the two vanishing DIRECTIONS
    are perpendicular in real life pins down the one unknown (focal length),
    which is then enough to un-project the 4 corners onto a common plane and
    read off the true relative side lengths. No measurement, no typed number --
    just the perspective geometry already implicit in a photo of a real
    rectangle. Falls back to aspect=1.0 (the old always-square behaviour) with
    an explanatory note whenever the geometry is too degenerate to trust
    (near-parallel sides, no real focal-length solution, implausible result) --
    an honest fallback beats a confident-looking wrong answer.

    IMPORTANT, found by synthetic testing before this shipped: this solve is
    mathematically exact given noise-free points, but its SENSITIVITY to
    ordinary hand-click imprecision (~1-2px) varies wildly with viewing angle
    -- some poses stayed within ~5% of the true aspect under realistic noise,
    one came back with a 95% CI spanning 0.8-2.25 against a true value of 2.0.
    A single solve has no way to tell you which regime you're in. So: also
    re-solve many times (`_STABILITY_TRIALS`) after jointly perturbing ALL 4
    points with small random noise -- matching how a real hand actually
    mis-clicks, every coordinate off by a bit at once, NOT one axis of one
    point at a time (tried that first; it explores too narrow a neighbourhood
    and can call a pose "stable" when combined noise shows it isn't -- a
    real discrepancy hit while validating this) -- and report the resulting
    spread (`aspect_stability_std`) alongside the point estimate: a small
    spread means trust it, a large one means this pose is numerically fragile
    and the 4th-corner-dragging path (see module docstring) is the more
    reliable option."""
    aspect, reason = _infer_aspect_core(pixel_pts, img_w, img_h)
    if aspect is None:
        # A guessed square is a WRONG homography that reports no error, which is
        # the worst failure mode this tool has: it silently bakes an aspect (and
        # therefore a shear) into the world frame, and downstream everything
        # looks calibrated. Measured cost on Warehouse_027: cam2 fell back here
        # and the three cameras then disagreed by 1.6-3.0 person-widths on the
        # same physical floor point.
        #
        # We still RETURN a usable homography, because the camera has to be
        # clickable to record the shared points that fix it -- but it is flagged
        # unreliable, align_compute will refuse to use it as the reference
        # frame, and a >=4-point alignment replaces it outright.
        return 1.0, dict(
            aspect_source=f"fallback (square assumed) -- {reason}",
            aspect_confident=False,
            aspect_unreliable=True,
            aspect_warning="PROVISIONAL: the rectangle's true proportions could not be "
                           "inferred, so a square was assumed and this camera's world "
                           "frame is very likely sheared. Do NOT rely on it as-is. Fix by "
                           "either (a) recording >=4 shared points with an aligned camera, "
                           "which replaces this homography entirely, or (b) re-clicking the "
                           "rectangle on a larger floor feature with corners far apart and "
                           "placing the 4th corner yourself.")

    # perturb ALL 4 points at once with small random noise (matching how a real
    # hand actually mis-clicks -- every coordinate off by a bit simultaneously),
    # not one axis of one point at a time: a one-at-a-time sweep only explores
    # 16 nearby configurations and can badly UNDERESTIMATE the true sensitivity
    # if the fragile direction requires several coordinates to move together
    # (confirmed by synthetic testing: a pose that one-at-a-time called stable
    # had 5x the std under realistic combined noise)
    rng = np.random.default_rng(0)   # fixed seed -- same points always get the same verdict
    trials = [aspect]
    for _ in range(_STABILITY_TRIALS):
        noise = rng.normal(0, _STABILITY_NOISE_PX, size=(4, 2))
        pts2 = [(x + dx, y + dy) for (x, y), (dx, dy) in zip(pixel_pts, noise)]
        a2, _ = _infer_aspect_core(pts2, img_w, img_h)
        if a2 is not None:
            trials.append(a2)
    trials = np.array(trials)
    spread = float(trials.std())
    # most/all perturbations solved, and tightly
    confident = len(trials) >= 0.8 * (_STABILITY_TRIALS + 1) and spread < _STABILITY_MAX_RELATIVE_STD * aspect

    return aspect, dict(
        aspect_source=("vanishing-point inference" if confident else
                       "vanishing-point inference -- LOW CONFIDENCE, verify by dragging the 4th corner"),
        inferred_aspect=round(aspect, 3), aspect_stability_std=round(spread, 3), aspect_confident=confident)


@app.route("/")
def index():
    return render_template("calibration.html", cams=sorted(STATE["frames"]))


@app.route("/frame/<cam>.png")
def frame(cam):
    # ?f=<frame index> scrubs to any frame in that camera's OWN video, on
    # demand -- needed for cross-check/align: cameras aren't necessarily
    # time-synced, and floor texture is often too uniform/repetitive to
    # identify "the same real point" from a single static frame per camera
    # (see module docstring). Without ?f=, serves the original startup frame
    # (used by "calibrate" mode, which doesn't need scrubbing -- a rectangle
    # in the static floor geometry is enough there).
    f = request.args.get("f", type=int)
    if f is None:
        fr = STATE["frames"][cam]
    else:
        if _is_stream(STATE["video_paths"][cam]):
            # asking for a specific frame FREEZES this camera on the buffer as it
            # stands, so every later click lands on the same picture
            fr = _stream_frame_at(cam, f)
            if fr is None:
                return jsonify(error=f"no buffered frames yet from live cam {cam}"), 503
        else:
            cap = cv2.VideoCapture(STATE["video_paths"][cam])
            cap.set(cv2.CAP_PROP_POS_FRAMES, f)
            ok, fr = cap.read()
            cap.release()
            if not ok:
                return jsonify(error=f"could not read frame {f} from cam {cam}"), 404
    ok, buf = cv2.imencode(".png", fr)
    return send_file(io.BytesIO(buf.tobytes()), mimetype="image/png")


@app.route("/stream_live/<cam>", methods=["POST"])
def stream_live(cam):
    """Drop this camera's frozen snapshot and follow the live edge again."""
    # one shared axis -> releasing is global, otherwise cameras would silently
    # end up on different timebases again
    STATE["holds"].clear()
    STATE["hold_axis"] = None
    return jsonify(ok=True, live=True, buffered=len(STATE["buffers"].get(cam) or []))


@app.route("/video_meta")
def video_meta():
    # For a LIVE camera n_frames is not a property of the source (a stream has no
    # length) -- it is how many recent frames are currently CHOOSABLE. Reporting
    # the buffer/hold length here is what makes the existing scrub control work
    # unchanged on a stream: it scrubs the last few seconds instead of the file.
    meta = {}
    for cam, m in STATE["video_meta"].items():
        m = dict(m)
        if _is_stream(STATE["video_paths"].get(cam, "")):
            axis = STATE.get("hold_axis")
            m["n_frames"] = len(axis) if axis else len(STATE["buffers"].get(cam) or [])
            m["live"] = True
            m["held"] = bool(axis)
        meta[cam] = m
    return jsonify(meta)


@app.route("/state")
def state():
    return jsonify(
        rect_points={c: len(v) for c, v in STATE["rect_points"].items()},
        cal_done=sorted(STATE["cal"]),
        n_align_points=len(STATE["align_points"]),
        aligned={c: bool(v.get("diag", {}).get("aligned")) for c, v in STATE["cal"].items()},
        n_gates=len(STATE["gates"]),
        n_lines=len(STATE["align_lines"]),
        cur_line_counts={c: len(v) for c, v in STATE["cur_line"].items()},
    )


def _save_calibration():
    # diagnostics live on STATE["cal"][c]["diag"] so both calib_rect_compute
    # (initial fit) and align_compute (post-hoc correction) can update it and
    # have this function stay a plain dump of current STATE, not a relay of
    # whatever the caller happened to have on hand
    out = dict(units="pt", cameras={
        c: dict(Hinv=STATE["cal"][c]["Hinv"].tolist(), diagnostics=STATE["cal"][c].get("diag", {}))
        for c in STATE["cal"]
    })
    json.dump(out, open(STATE["calib_out"], "w"), indent=2)


def _save_gates():
    out = dict(units="pt", gates=STATE["gates"])
    json.dump(out, open(STATE["gates_out"], "w"), indent=2)


def _pairwise_distances(points):
    """points: {cam: [px, py]} (>=2 entries, all already in STATE["cal"]) ->
    (worlds, pairs) using each camera's CURRENT Hinv -- shared by cross_check
    (read-only) and align_point_add (which also banks the point)."""
    worlds = {c: _image_to_world(STATE["cal"][c]["Hinv"], tuple(pt)) for c, pt in points.items()}
    cams_sorted = sorted(worlds)
    pairs = []
    for i in range(len(cams_sorted)):
        for j in range(i + 1, len(cams_sorted)):
            a, b = cams_sorted[i], cams_sorted[j]
            dist = float(np.hypot(worlds[a][0] - worlds[b][0], worlds[a][1] - worlds[b][1]))
            pairs.append(dict(cam_a=a, cam_b=b, distance_pt=round(dist, 1)))
    return worlds, pairs


def _line_diagnostics(line):
    """line: {cam: [[px,py], ...], ...} (>=1 point per cam, calibrated cams
    only matter here) -> per-camera collinearity + path length, and
    cross-camera length agreement -- the two live checks a real straight
    line gives you almost for free: (1) do THIS camera's own points, once
    projected to world space, actually fall on a straight line (tests that
    camera's OWN homography, independent of any other camera); (2) do
    different cameras agree on how long the same real line is (tests
    alignment, since after a correct similarity-transform fit every camera
    should report the same real length for the same physical line)."""
    out = {}
    lengths = {}
    for cam, pts in line.items():
        if cam not in STATE["cal"] or len(pts) < 2:
            continue
        Hinv = STATE["cal"][cam]["Hinv"]
        world = np.array([_image_to_world(Hinv, tuple(p)) for p in pts])
        seg = np.linalg.norm(np.diff(world, axis=0), axis=1)
        path_len = float(seg.sum())
        entry = dict(n_points=len(pts), path_length_pt=round(path_len, 2))
        if len(pts) >= 3:
            # least-squares line fit (world[0]->world[-1] direction), then
            # max perpendicular distance of the intermediate points from it
            d = world[-1] - world[0]
            d = d / (np.linalg.norm(d) + 1e-9)
            perp = world - world[0]
            proj = perp @ d
            resid = perp - np.outer(proj, d)
            entry["collinearity_max_dev_pt"] = round(float(np.linalg.norm(resid, axis=1).max()), 3)
        out[cam] = entry
        lengths[cam] = path_len
    agreement = None
    if len(lengths) >= 2:
        vals = np.array(list(lengths.values()))
        agreement = dict(mean_pt=round(float(vals.mean()), 2),
                         spread_pt=round(float(vals.max() - vals.min()), 3),
                         spread_frac=round(float((vals.max() - vals.min()) / vals.mean()), 3)
                         if vals.mean() > 1e-9 else None)
    return dict(per_camera=out, agreement=agreement)


def _residual_pt(M, src, dst):
    """mean distance between dst and M @ src (M: 2x3 affine) -- used to compare
    two candidate point orderings for the same correspondence set."""
    src_h = np.hstack([src, np.ones((len(src), 1), dtype=src.dtype)])
    proj = (M @ src_h.T).T
    return float(np.linalg.norm(proj - dst, axis=1).mean())


def cap_fps(path):
    src = int(path) if str(path).isdigit() else path
    c = cv2.VideoCapture(src); f = c.get(cv2.CAP_PROP_FPS) or 25.0; c.release()
    return f


def _is_stream(path):
    """A live source: an http/rtsp URL, or a bare integer (a local camera index).

    Streams differ from files in ways that fail SILENTLY rather than loudly:
    CAP_PROP_FRAME_COUNT returns nonsense (measured: -9223372036854775808 on an
    MJPEG stream) and cap.set(CAP_PROP_POS_FRAMES, n) RETURNS TRUE while doing
    nothing at all -- so "seek to frame n and read" quietly hands back whatever
    happened to be current. Every seek in this file is therefore guarded.
    """
    return str(path).startswith(("http://", "https://", "rtsp://", "rtmp://")) or str(path).isdigit()


# Seconds of recent history kept per live camera so a frame can be CHOSEN.
# Calibration means clicking precise points on a still image; on a live source
# the picture moves under the cursor, so a rolling buffer plus an explicit HOLD
# is what makes clicking possible at all. Stored JPEG-encoded: 10s of raw 1080p
# would be ~1.5 GB per camera, the same buffer as JPEG is a few tens of MB.
STREAM_BUFFER_S = 10.0
STREAM_BUFFER_QUALITY = 92


def _stream_grabber(cam, path):
    """Keep STATE['frames'][cam] on the newest frame AND retain a short rolling
    history in STATE['buffers'][cam].

    A live MJPEG connection must be drained continuously; if nobody reads, the
    socket backs up and every later read returns stale frames. So one daemon
    thread per camera reads flat out.
    """
    src = int(path) if str(path).isdigit() else path
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    if not (0 < fps < 121):
        fps = 25.0
    STATE["buffers"][cam] = collections.deque(maxlen=max(2, int(STREAM_BUFFER_S * fps)))
    enc = [int(cv2.IMWRITE_JPEG_QUALITY), STREAM_BUFFER_QUALITY]
    while True:
        ok, fr = cap.read()
        if not ok:
            time.sleep(0.05)
            cap.release()
            cap = cv2.VideoCapture(src)      # reconnect: a camera may blip
            continue
        STATE["frames"][cam] = fr
        ok2, buf = cv2.imencode(".jpg", fr, enc)
        if ok2:
            # timestamp on ARRIVAL: cameras are separate streams with separate
            # buffers, so a position index means a different moment in each one.
            # Time is the only thing they share, and alignment mode depends on
            # showing the SAME instant across cameras.
            STATE["buffers"][cam].append((time.time(), buf.tobytes()))


def _stream_held(cam):
    """This camera's frozen snapshot [(t, jpg), ...], or None if running live."""
    return STATE["holds"].get(cam)


def _stream_hold_all():
    """Freeze EVERY live camera at once on a SHARED time axis.

    Two reasons this is global rather than per camera:

    1. Freezing at all -- a sliding buffer means index N is a different picture
       each second, so corner 3 would be clicked on a different frame from
       corner 1.
    2. Freezing TOGETHER -- each camera is an independent stream with its own
       buffer, so position 40 in one is not the same instant as position 40 in
       another. Alignment mode exists to click the same real point in several
       cameras at the same moment; with independent indices that is impossible,
       which is exactly the bug this fixes.

    So the axis is built from the time range all cameras actually have in common,
    sampled at the fastest camera's rate, and a frame request resolves to the
    frame NEAREST that timestamp in each camera.
    """
    if STATE.get("hold_axis"):
        return STATE["hold_axis"]
    live = [c for c in STATE["video_paths"] if _is_stream(STATE["video_paths"][c])]
    snaps = {c: list(STATE["buffers"].get(c) or []) for c in live}
    snaps = {c: v for c, v in snaps.items() if len(v) >= 2}
    if not snaps:
        return []
    lo = max(v[0][0] for v in snaps.values())      # latest start
    hi = min(v[-1][0] for v in snaps.values())     # earliest end
    if hi <= lo:
        # no overlap (a camera only just connected) -- fall back to the shortest
        lo, hi = min(v[0][0] for v in snaps.values()), max(v[-1][0] for v in snaps.values())
    step = min((v[-1][0] - v[0][0]) / max(len(v) - 1, 1) for v in snaps.values()) or 0.04
    n = max(2, int((hi - lo) / step) + 1)
    STATE["holds"] = snaps
    STATE["hold_axis"] = [lo + i * step for i in range(n)]
    return STATE["hold_axis"]


def _stream_frame_at(cam, idx):
    """The frame of `cam` nearest the shared-axis timestamp `idx`."""
    axis = _stream_hold_all()
    snap = STATE["holds"].get(cam)
    if not axis or not snap:
        return None
    t = axis[max(0, min(len(axis) - 1, idx))]
    best = min(snap, key=lambda e: abs(e[0] - t))
    return _decode(best[1])


def _decode(jpg):
    return cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)


def _camera_world_footprint(cam):
    """cam's image rect projected to world floor via its CURRENT Hinv ->
    (world polygon points, footprint area in pt^2, horizon_frac). Treats the
    whole frame as if it shows floor -- a rough approximation (real images have
    walls, ceiling, etc in them too), but enough to say roughly how much of the
    shared world floor this camera can see.

    Only the part of the frame BELOW the horizon is projected. A ground-plane
    homography sends the horizon line (Hinv's bottom row = 0) to infinity, so
    any pixel above it is either behind the camera or arbitrarily far away.
    Feeding those corners to the shoelace formula produces a confidently wrong
    finite number -- on a real session one camera whose frame was 9% above the
    horizon reported 133 pt^2 for a floor region that is genuinely unbounded.
    horizon_frac (fraction of the frame lying above the horizon) is returned so
    callers can say "unbounded" instead of quoting that fabricated area."""
    h, w = STATE["frames"][cam].shape[:2]
    Hinv = np.asarray(STATE["cal"][cam]["Hinv"], float)
    a, b, c = Hinv[2]
    s = np.sign(a * (w / 2.0) + b * (h / 2.0) + c) or 1.0
    a, b, c = s * a, s * b, s * c          # denominator > 0 == in front of camera
    eps = 1e-9 * max(1.0, abs(c))

    poly = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
    clipped = []                            # Sutherland-Hodgman against a*x+b*y+c >= eps
    for i in range(len(poly)):
        cur, nxt = poly[i], poly[(i + 1) % len(poly)]
        fc = a * cur[0] + b * cur[1] + c
        fn = a * nxt[0] + b * nxt[1] + c
        if fc >= eps:
            clipped.append(cur)
        if (fc >= eps) != (fn >= eps):
            t = (eps - fc) / (fn - fc)
            clipped.append((cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])))
    if len(clipped) < 3:
        return [], 0.0, 1.0

    px_area = 0.0
    for i in range(len(clipped)):
        x1, y1 = clipped[i]; x2, y2 = clipped[(i + 1) % len(clipped)]
        px_area += x1 * y2 - x2 * y1
    horizon_frac = max(0.0, 1.0 - abs(px_area) / 2.0 / (w * h))

    corners_world = [_image_to_world(Hinv, p) for p in clipped]
    area = 0.0   # shoelace formula
    for i in range(len(corners_world)):
        x1, y1 = corners_world[i]; x2, y2 = corners_world[(i + 1) % len(corners_world)]
        area += x1 * y2 - x2 * y1
    return corners_world, abs(area) / 2.0, horizon_frac


def _coverage_check(cams_list):
    """Compare every calibrated camera's own world-floor footprint AREA
    (_camera_world_footprint) as a WEAK smoke test for a badly-scaled
    alignment: estimateAffinePartial2D's scale term is the part of that fit
    most sensitive to a small, clustered set of shared points -- two points
    close together barely constrain "how big is 1 unit", so a small click
    error becomes a large scale error.

    READ THIS BEFORE TRUSTING IT. Footprint area is a weak signal and a clean
    result here does NOT mean the calibration is good. Measured directly: on
    one real 4-camera scene the per-camera areas spanned 53-694 pt^2 (13x) for
    a calibration later proven correct, while EPFL's own official calibration
    of the same rig spanned 4.2e5-1.3e7 (31x) -- a WIDER spread than the case
    this check was written to catch. Area is dominated by how close a camera's
    view comes to the horizon, not by how much room it really sees, so the
    thresholds below only catch gross blowups. Cameras that cross the horizon
    are reported as unbounded and excluded from the comparison entirely.

    An overlap-based version of this check was tried and is NOT better: the
    known-good EPFL calibration shows pairwise footprint overlaps of 0.3-15%,
    statistically indistinguishable from the suspect one's 0.8-18%. The only
    metric that actually separated good from bad alignment was projecting real
    per-camera person detections to world and checking the clouds coincide."""
    areas, unbounded = {}, []
    for c in cams_list:
        if c not in STATE["cal"]:
            continue
        _, area, horizon_frac = _camera_world_footprint(c)
        if horizon_frac > 0.01:
            unbounded.append(c)
        else:
            areas[c] = area
    if len(areas) < 2:
        return dict(areas_pt2={}, median_pt2=None, flagged=[], unbounded=sorted(unbounded),
                    note="not enough horizon-free cameras to compare footprint areas"
                         + (f" (camera(s) {sorted(unbounded)} see past the horizon, so their "
                            f"floor footprint is unbounded)" if unbounded else ""))
    med = float(np.median(list(areas.values())))
    flagged = sorted(c for c, a in areas.items()
                     if med > 1e-9 and (a / med > 20.0 or a / med < 0.05))
    return dict(
        areas_pt2={c: round(a, 1) for c, a in areas.items()},
        median_pt2=round(med, 1), flagged=flagged, unbounded=sorted(unbounded),
        note=(f"camera(s) {flagged} have a world-floor footprint wildly different from the "
              f"others' median ({med:.0f} pt^2) -- redo alignment with shared points/lines "
              f"spread across the WHOLE room (not clustered together), then re-check"
              if flagged else "no gross footprint-scale outlier -- but this is a weak check, "
                              "not a green light (see _coverage_check's docstring)."))


def _bev_canvas_transform(cams_list, canvas_size=700, pad=20):
    """World bounding box (union of every camera's own footprint, see
    _camera_world_footprint) -> the 3x3 similarity matrix S mapping world
    (x,y) -> BEV canvas pixel (x,y), plus the world bounds used. A UNIFORM
    scale (not stretched per axis) so a real square floor tile still looks
    square in the canvas -- distortion there would make misalignment and
    real skew indistinguishable by eye. Reuses the coverage-check's own
    footprint math so the canvas always covers whatever's currently
    calibrated, no matter the room's real scale.

    Anchored on the clicked calibration/alignment points rather than on raw
    footprint corners: a camera that sees past the horizon has corners
    millions of pt away, and a min/max box over those would zoom the canvas
    out until the actual room is a single pixel. The clicked points are all
    real floor locations, so they bound the region anyone cares about; camera
    corners only widen the box while they stay near that region."""
    anchors = []
    for c in cams_list:
        if c not in STATE["cal"]:
            continue
        for p in STATE["rect_points"].get(c, []):
            anchors.append(_image_to_world(STATE["cal"][c]["Hinv"], p))
    for pt in STATE["align_points"]:
        for c, p in pt.items():
            if c in STATE["cal"]:
                anchors.append(_image_to_world(STATE["cal"][c]["Hinv"], p))
    anchors = [p for p in anchors if np.isfinite(p).all()]
    if not anchors:
        return None, None
    ax = [p[0] for p in anchors]; ay = [p[1] for p in anchors]
    # generous margin around the clicked region, so surrounding floor still shows
    reach = 3.0 * max(max(ax) - min(ax), max(ay) - min(ay), 1e-6)
    cx, cy = (max(ax) + min(ax)) / 2, (max(ay) + min(ay)) / 2

    all_corners = list(anchors)
    for c in cams_list:
        if c not in STATE["cal"]:
            continue
        corners, _, _ = _camera_world_footprint(c)
        all_corners.extend(p for p in corners
                           if abs(p[0] - cx) <= reach and abs(p[1] - cy) <= reach)
    xs = [p[0] for p in all_corners]; ys = [p[1] for p in all_corners]
    xmin, xmax = min(xs), max(xs); ymin, ymax = min(ys), max(ys)
    span = max(xmax - xmin, ymax - ymin, 1e-6)
    scale = (canvas_size - 2 * pad) / span
    S = np.array([[scale, 0, pad - xmin * scale],
                  [0, scale, pad - ymin * scale],
                  [0, 0, 1.0]])
    return S, dict(xmin=xmin, xmax=xmax, ymin=ymin, ymax=ymax)


def _warp_to_bev(cam, S, canvas_size, frame):
    """cam's frame, rectified onto the shared BEV canvas in one step: M = S @
    Hinv maps camera-pixel -> world -> canvas-pixel directly, so
    cv2.warpPerspective does the whole camera-pixel -> floor-plane remap
    without a separate world-space intermediate. Returns (warped BGR image,
    boolean valid-coverage mask) -- the mask is what warpPerspective leaves
    OUTSIDE this camera's actual frame (letterboxing), needed so the overlay
    only blends where this camera genuinely contributes."""
    M = S @ STATE["cal"][cam]["Hinv"]
    warped = cv2.warpPerspective(frame, M, (canvas_size, canvas_size))
    mask_src = np.full(frame.shape[:2], 255, np.uint8)
    mask = cv2.warpPerspective(mask_src, M, (canvas_size, canvas_size)) > 0
    return warped, mask


def _nice_step(span, target_lines=10):
    """span pt -> a round grid spacing (1/2/5 x a power of ten) giving
    roughly target_lines gridlines across it -- same "read off round
    numbers" idea as tools/site_calibration.py's pixel grid, just in world
    units instead of pixels."""
    raw = span / max(target_lines, 1)
    if raw <= 0:
        return 1.0
    magnitude = 10 ** np.floor(np.log10(raw))
    for m in (1, 2, 5, 10):
        step = m * magnitude
        if step >= raw:
            return float(step)
    return float(10 * magnitude)


def _draw_bev_grid(img, S, bounds):
    """Fixed-spacing world-space gridlines, drawn through S onto the BEV
    canvas -- a straight, evenly-spaced grid is the reference a real floor
    SHOULD rectify to; visible warping/curving of these lines under a given
    camera's own BEV render (bev_single) is a distortion signal independent
    of any other camera, easier to judge by eye than a bare image. S has no
    perspective term (pure similarity: scale+rotate+translate), so the
    world->canvas map is exact without a homogeneous divide."""
    step = _nice_step(max(bounds["xmax"] - bounds["xmin"], bounds["ymax"] - bounds["ymin"]))
    col = (70, 160, 70)
    x = np.floor(bounds["xmin"] / step) * step
    while x <= bounds["xmax"] + step:
        p1 = S @ np.array([x, bounds["ymin"], 1.0]); p2 = S @ np.array([x, bounds["ymax"], 1.0])
        cv2.line(img, (int(p1[0]), int(p1[1])), (int(p2[0]), int(p2[1])), col, 1, cv2.LINE_AA)
        cv2.putText(img, f"{x:.0f}", (int(p1[0]) + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.35, col, 1)
        x += step
    y = np.floor(bounds["ymin"] / step) * step
    while y <= bounds["ymax"] + step:
        p1 = S @ np.array([bounds["xmin"], y, 1.0]); p2 = S @ np.array([bounds["xmax"], y, 1.0])
        cv2.line(img, (int(p1[0]), int(p1[1])), (int(p2[0]), int(p2[1])), col, 1, cv2.LINE_AA)
        cv2.putText(img, f"{y:.0f}", (2, int(p1[1]) + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.35, col, 1)
        y += step
    return img


def _align_cameras():
    """BFS from an arbitrary anchor camera (the first calibrated cam, sorted
    by id -- deterministic, not "best" in any other sense): for each not-yet-
    aligned camera with >=2 points shared with an already-aligned one, fit
    the similarity transform (scale+rotation+translation, cv2's
    estimateAffinePartial2D) that reconciles the two cameras' independently-
    assumed frames, and bake it into the not-yet-aligned camera's Hinv. Runs
    breadth-first so two cameras that never directly share a point can still
    be tied together through a third that shares points with both -- each
    step measures the new camera against whatever the reference camera's
    frame CURRENTLY is (possibly itself already corrected earlier in the
    same BFS), not its own original, independently-assumed frame.

    Point ORDER within a shared correspondence set matters -- e.g. a "shared
    line"'s points are paired up by list position (see line_finish), which
    silently assumes both cameras were clicked in the same real-world order.
    A full reversal (the natural mistake when the same physical line visually
    runs opposite directions in two camera views) is INVISIBLE to
    _line_diagnostics' length-agreement check (summed segment length is the
    same forwards or backwards) and would otherwise silently feed a wrong-
    but-self-consistent correspondence set into estimateAffinePartial2D. With
    >=3 points (enough redundancy for residuals to actually distinguish
    forward from reversed -- with exactly 2 points a similarity transform is
    exactly-determined and both orderings fit with 0 residual regardless of
    correctness), also fit the reversed ordering and keep whichever fits
    better, recording which one won so a meaningful gap between the two is a
    visible signal rather than a silent guess.
    """
    cams = sorted(STATE["cal"])
    if len(cams) < 2:
        return dict(error="need >= 2 calibrated cameras")

    # shared-point pixel observations, grouped by camera pair
    pair_obs = {}   # {(cam_a, cam_b): [{cam_a: [px,py], cam_b: [px,py]}, ...]}
    for pt in STATE["align_points"]:
        seen = sorted(c for c in pt if c in STATE["cal"])
        for i in range(len(seen)):
            for j in range(i + 1, len(seen)):
                a, b = seen[i], seen[j]
                pair_obs.setdefault((a, b), []).append({a: pt[a], b: pt[b]})

    # The reference camera's rectangle is the ONE that still matters after this
    # step: every other camera gets refitted onto its frame (see the fit ladder
    # below), so a bad aspect anywhere else is corrected, but a bad aspect HERE
    # is inherited by everyone. Pick the most trustworthy rectangle rather than
    # whichever camera happens to sort first -- on Warehouse_027 cams[0] had a
    # 2.469 aspect while another camera's was confidently inferred.
    def _ref_score(c):
        d = STATE["cal"][c].get("diag", {}) or {}
        src = str(d.get("aspect_source", ""))
        return (
            0 if src.startswith("fallback") else 1,       # never a guessed square
            1 if d.get("aspect_confident") else 0,        # prefer a confident inference
            -float(d.get("aspect_stability_std") or 9e9),  # then the most stable
        )
    ref = max(cams, key=_ref_score)
    ref_diag = STATE["cal"][ref].get("diag", {}) or {}
    if str(ref_diag.get("aspect_source", "")).startswith("fallback"):
        results_warning = ("every calibrated camera's rectangle aspect had to be guessed, so "
                           "the shared world frame's shape is a guess too -- re-click ONE "
                           "camera's rectangle on a large, clearly-rectangular floor feature "
                           "with its corners far apart, then align again")
    else:
        results_warning = None
    visited = {ref}
    queue = [ref]
    STATE["cal"][ref]["diag"] = dict(STATE["cal"][ref].get("diag", {}), aligned=True)
    results = {ref: dict(aligned=True, reference=True, n_points=None, via=None)}

    while queue:
        v = queue.pop(0)
        for (a, b), obs in pair_obs.items():
            if a == v and b not in visited:
                u = b
            elif b == v and a not in visited:
                u = a
            else:
                continue
            if len(obs) < 2:
                continue
            world_v = np.array([_image_to_world(STATE["cal"][v]["Hinv"], o[v]) for o in obs],
                               dtype=np.float32)
            world_u = np.array([_image_to_world(STATE["cal"][u]["Hinv"], o[u]) for o in obs],
                               dtype=np.float32)
            pix_u = np.array([o[u] for o in obs], dtype=np.float32)

            # --- fit the STRONGEST correction the evidence supports -------------
            #
            # This used to be estimateAffinePartial2D unconditionally -- a
            # SIMILARITY (4 dof: uniform scale, rotation, translation). That can
            # never repair a wrong rectangle, because a wrong aspect ratio is a
            # SHEAR, and a similarity has no shear term. So a camera whose
            # rect-mode aspect was mis-inferred stayed broken no matter how many
            # shared points were clicked -- measured on WILDTRACK C3 (17 points,
            # still 5 person-widths out) and again on Warehouse_027, where all
            # three cameras disagreed by 1.6-3.0 person-widths after alignment.
            #
            # With >=4 shared points we can do strictly better: fit a full
            # HOMOGRAPHY straight from this camera's PIXELS to the reference
            # camera's world frame. That is the ground homography, derived
            # entirely from correspondences, so this camera's own clicked
            # rectangle -- and any error in it -- drops out of the answer
            # completely. Only the REFERENCE camera's rectangle still sets the
            # world frame's shape.
            order_reversed = False
            order_diag = {}
            new_Hinv = None
            n = len(obs)

            def _res_h(Hm, src_pix, dst_world):
                p = np.hstack([src_pix, np.ones((len(src_pix), 1), np.float32)])
                q = (Hm @ p.T).T
                q = q[:, :2] / q[:, 2:3]
                return float(np.linalg.norm(q - dst_world, axis=1).mean())

            if n >= 4:
                Hfit, _m = cv2.findHomography(pix_u, world_v, 0)
                if Hfit is not None and np.isfinite(Hfit).all():
                    res_fwd = _res_h(Hfit, pix_u, world_v)
                    Hrev, _m2 = cv2.findHomography(pix_u[::-1], world_v, 0)
                    if Hrev is not None and np.isfinite(Hrev).all():
                        res_rev = _res_h(Hrev, pix_u[::-1], world_v)
                        order_diag = dict(order_check_residual_pt=round(res_fwd, 3),
                                          order_check_reversed_residual_pt=round(res_rev, 3))
                        if res_rev < res_fwd:
                            Hfit, res_fwd, order_reversed = Hrev, res_rev, True
                    else:
                        order_diag = dict(order_check_residual_pt=round(res_fwd, 3))
                    new_Hinv = Hfit
                    fit_kind = f"full homography from {n} shared points (pixels -> cam {v} world)"

            if new_Hinv is None:
                # <4 points: cannot solve a homography. Fall back down the ladder,
                # and say so -- an affine (6 dof) still fixes shear/aspect, a
                # similarity (4 dof) does not.
                if n >= 3:
                    M, _i = cv2.estimateAffine2D(world_u, world_v)
                    fit_kind = f"affine from {n} shared points (fixes shear, not perspective)"
                else:
                    M, _i = cv2.estimateAffinePartial2D(world_u, world_v)
                    fit_kind = (f"similarity from {n} shared points -- CANNOT fix a wrong "
                                f"rectangle aspect; click >=4 shared points for a full fit")
                if M is None:
                    continue
                if n >= 3:
                    M_rev, _ir = (cv2.estimateAffine2D(world_u[::-1], world_v) if n >= 3
                                  else (None, None))
                    if M_rev is not None:
                        res_fwd = _residual_pt(M, world_u, world_v)
                        res_rev = _residual_pt(M_rev, world_u[::-1], world_v)
                        order_diag = dict(order_check_residual_pt=round(res_fwd, 3),
                                          order_check_reversed_residual_pt=round(res_rev, 3))
                        if res_rev < res_fwd:
                            M, order_reversed = M_rev, True
                new_Hinv = np.vstack([M, [0.0, 0.0, 1.0]]) @ STATE["cal"][u]["Hinv"]

            STATE["cal"][u]["Hinv"] = new_Hinv
            STATE["cal"][u]["H"] = np.linalg.inv(new_Hinv)
            STATE["cal"][u]["diag"] = dict(
                STATE["cal"][u].get("diag", {}),
                aligned=True, aligned_to=v, aligned_with_n_points=n,
                order_reversed=order_reversed, fit=fit_kind,
                # a >=4-point fit REPLACES this camera's homography outright, so
                # whatever its rectangle said no longer matters
                aspect_superseded=(n >= 4), **order_diag,
                note=f"Hinv set by align_compute: {fit_kind}"
                     + (" -- this camera's own clicked rectangle no longer affects the "
                        "result" if n >= 4 else "")
                     + (" -- point order was REVERSED relative to click order because it "
                        "fit noticeably better; if this is unexpected, the shared-line "
                        "points for this camera were likely clicked in the opposite "
                        "real-world direction from the other camera's" if order_reversed else ""))
            visited.add(u)
            queue.append(u)
            results[u] = dict(aligned=True, reference=False, n_points=len(obs), via=v,
                              order_reversed=order_reversed)

    for c in cams:
        if c not in visited:
            results[c] = dict(aligned=False, reference=False, n_points=0, via=None,
                              error="no chain of >=2-point camera pairs connects this "
                                    "camera back to the reference -- record more shared "
                                    "points involving it")

    _save_calibration()
    # residual distances for every recorded point, using the now-corrected
    # Hinvs, so the caller can see the improvement directly
    residuals = [dict(pairs=_pairwise_distances(
        {c: pt[c] for c in pt if c in STATE["cal"]})[1])
        for pt in STATE["align_points"] if len(pt) >= 2]
    coverage = _coverage_check(cams)
    out = dict(results=results, reference=ref, residual_checks=residuals,
               coverage_check=coverage)
    if results_warning:
        out["reference_warning"] = results_warning
    # cameras still tied in with a fit too weak to repair a bad rectangle
    weak = sorted(c for c in cams
                  if (STATE["cal"][c].get("diag", {}) or {}).get("aligned_with_n_points", 0)
                  and not (STATE["cal"][c].get("diag", {}) or {}).get("aspect_superseded"))
    if weak:
        out["weak_fits"] = (f"camera(s) {weak} were aligned with <4 shared points, so their "
                            f"own rectangle still determines their world frame. If any of "
                            f"them shows a bad aspect, click more shared points (>=4) to "
                            f"replace it outright.")
    return out


@app.route("/calib_rect_point", methods=["POST"])
def calib_rect_point():
    d = request.get_json()
    cam = d["cam"]
    pts = STATE["rect_points"].setdefault(cam, [])
    if len(pts) >= 4:
        return jsonify(ok=False, error="already have 4 points -- undo or compute first"), 400
    pts.append((float(d["px"]), float(d["py"])))
    return jsonify(ok=True, n=len(pts))


@app.route("/calib_rect_undo", methods=["POST"])
def calib_rect_undo():
    cam = request.get_json()["cam"]
    pts = STATE["rect_points"].get(cam, [])
    if pts:
        pts.pop()
    return jsonify(ok=True, n=len(pts))


@app.route("/calib_rect_compute", methods=["POST"])
def calib_rect_compute():
    results = {}
    for cam, pts in STATE["rect_points"].items():
        if len(pts) != 4:
            results[cam] = dict(error=f"have {len(pts)} points, need exactly 4")
            continue
        img_h, img_w = STATE["frames"][cam].shape[:2]
        aspect, aspect_diag = _infer_aspect(pts, img_w, img_h)
        Hinv, diag = _fit_homography_rect(pts, aspect=aspect)
        if Hinv is None:
            results[cam] = dict(error="homography solve failed -- the 4 points are "
                                      "likely near-collinear (not a real quadrilateral)")
            continue
        diag.update(aspect_diag)
        diag["note"] = ("4-point exact fit: 0 reprojection error is expected regardless "
                        "of whether the right-angle assumption is actually true -- it "
                        "does not validate accuracy the way an over-determined metric "
                        "fit's error does. The target rectangle's aspect ratio is "
                        "inferred from the 4 points themselves (see aspect_source) -- "
                        "no longer always assumed square.")
        # freshly fit -> a brand new, independently-assumed frame, unrelated to
        # any previous alignment -- explicitly NOT aligned yet (even if this
        # cam was aligned before a re-calibration), gating /cross_check below
        diag["aligned"] = False
        STATE["cal"][cam] = dict(Hinv=Hinv, H=np.linalg.inv(Hinv), diag=diag)
        results[cam] = diag

    if STATE["cal"]:
        _save_calibration()
    return jsonify(results=results, saved=STATE["calib_out"] if STATE["cal"] else None)


@app.route("/cross_check", methods=["POST"])
def cross_check():
    # click the SAME real point in as many ALREADY-ALIGNED cameras as you can
    # see it in (any N, not just 2) -> convert each to world coordinates via
    # that camera's OWN calibration -> report every pairwise distance. Small
    # (a few tens of cm) means those two cameras agree; large (metres) means
    # something's still wrong even after alignment. Read-only -- nothing is
    # banked or changed.
    #
    # Gated on alignment on purpose: two freshly rect-calibrated cameras
    # invent independent, unrelated frames by construction (see module
    # docstring), so cross-checking them BEFORE aligning is close to
    # guaranteed to fail and tells you nothing you didn't already know --
    # align first (/align_point_add + /align_compute), then use this to
    # confirm it actually worked, ideally with points you didn't use in the
    # fit.
    d = request.get_json()
    points = d["points"]   # {cam: [px, py]}, any number of entries >= 2
    if len(points) < 2:
        return jsonify(ok=False, error="click the point in at least 2 cameras"), 400
    missing = [c for c in points if c not in STATE["cal"]]
    if missing:
        return jsonify(ok=False, error=f"not calibrated yet: {missing}"), 400
    unaligned = [c for c in points if not STATE["cal"][c].get("diag", {}).get("aligned")]
    if unaligned:
        return jsonify(ok=False, error=f"not aligned yet: {unaligned} -- use \"align cameras\" "
                                       f"first (cross-check only means something once cameras "
                                       f"have actually been reconciled to a shared frame)"), 400

    worlds, pairs = _pairwise_distances(points)
    return jsonify(ok=True, worlds={c: [round(v, 1) for v in w] for c, w in worlds.items()},
                  pairs=pairs)


@app.route("/align_point_add", methods=["POST"])
def align_point_add():
    # bank one shared real-world point, observed in whichever cameras you
    # could identify it in (>=2 of them) -- used later by /align_compute.
    # Also returns the same pairwise-distance report cross_check does, as
    # immediate feedback on this one point, before any correction is applied.
    d = request.get_json()
    points = d["points"]   # {cam: [px, py]}, >= 2 entries
    if len(points) < 2:
        return jsonify(ok=False, error="click the point in at least 2 cameras"), 400
    missing = [c for c in points if c not in STATE["cal"]]
    if missing:
        return jsonify(ok=False, error=f"not calibrated yet: {missing}"), 400

    STATE["align_points"].append({c: list(pt) for c, pt in points.items()})
    worlds, pairs = _pairwise_distances(points)
    return jsonify(ok=True, n=len(STATE["align_points"]),
                  worlds={c: [round(v, 1) for v in w] for c, w in worlds.items()}, pairs=pairs)


@app.route("/align_points_reset", methods=["POST"])
def align_points_reset():
    STATE["align_points"] = []
    return jsonify(ok=True, n=0)


@app.route("/align_compute", methods=["POST"])
def align_compute():
    if not STATE["align_points"]:
        return jsonify(ok=False, error="no shared points recorded -- click a point in 2+ "
                                       "cameras and \"record shared point\" first"), 400
    result = _align_cameras()
    if "error" in result:
        return jsonify(ok=False, error=result["error"]), 400
    return jsonify(ok=True, saved=STATE["calib_out"], **result)


@app.route("/line_point_add", methods=["POST"])
def line_point_add():
    # one point of an in-progress "shared line" -- a real straight edge,
    # clicked as MANY individually-identifiable points as you want (2
    # minimum, no upper bound), independently per camera. Returns live
    # diagnostics after every click: does this point set still look
    # collinear once projected to world space (tests THIS camera's own
    # homography), and if another camera already has points on the same
    # line, do the two cameras agree on how long it is (tests alignment).
    d = request.get_json()
    cam = d["cam"]
    STATE["cur_line"].setdefault(cam, []).append([float(d["px"]), float(d["py"])])
    diag = _line_diagnostics(STATE["cur_line"])
    return jsonify(ok=True, counts={c: len(v) for c, v in STATE["cur_line"].items()}, **diag)


@app.route("/line_undo", methods=["POST"])
def line_undo():
    cam = request.get_json()["cam"]
    pts = STATE["cur_line"].get(cam, [])
    if pts:
        pts.pop()
    diag = _line_diagnostics(STATE["cur_line"])
    return jsonify(ok=True, counts={c: len(v) for c, v in STATE["cur_line"].items()}, **diag)


@app.route("/line_reset", methods=["POST"])
def line_reset():
    STATE["cur_line"] = {}
    return jsonify(ok=True)


@app.route("/line_finish", methods=["POST"])
def line_finish():
    # banks the in-progress line into align_lines (kept regardless, for the
    # record/diagnostics), AND -- only for cameras that recorded the SAME
    # number of points on this line -- feeds each index-matched point tuple
    # into align_points as an ordinary correspondence, reusing
    # _align_cameras() completely unchanged. Cameras with a mismatched count
    # for this line just don't contribute a correspondence from it (their
    # points were still useful for that camera's own collinearity check).
    line = STATE["cur_line"]
    if not line:
        return jsonify(ok=False, error="no points recorded for this line yet"), 400
    STATE["align_lines"].append(line)

    counts = {c: len(v) for c, v in line.items()}
    n_common = None
    common_cams = [c for c in counts if counts[c] >= 2]
    if len(common_cams) >= 2 and len({counts[c] for c in common_cams}) == 1:
        n_common = counts[common_cams[0]]
        for i in range(n_common):
            STATE["align_points"].append({c: line[c][i] for c in common_cams})

    diag = _line_diagnostics(line)
    STATE["cur_line"] = {}
    return jsonify(ok=True, n_lines=len(STATE["align_lines"]),
                  fed_to_alignment=(n_common is not None),
                  n_correspondence_points=n_common or 0, counts=counts, **diag)


@app.route("/mark_gate", methods=["POST"])
def mark_gate():
    # marks a real-world entry/exit location (a doorway, wherever people
    # actually walk in from) for the gate-location prior a tracker can use to
    # tell "genuinely new person" apart from "an existing person's position
    # drifted" -- see evaluation/score_terrace.py's run_tracker. Single click,
    # single camera: unlike calibration itself, a gate point doesn't need
    # multi-camera agreement, just SOME already-calibrated camera's Hinv to
    # convert pixel -> world.
    d = request.get_json()
    cam = d["cam"]
    if cam not in STATE["cal"]:
        return jsonify(ok=False, error=f"cam {cam} not calibrated yet -- calibrate it first "
                                       f"(\"calibrate\" mode)"), 400
    world = _image_to_world(STATE["cal"][cam]["Hinv"], (float(d["px"]), float(d["py"])))
    # NO rounding to a fixed number of decimals. "pt" units are arbitrary by
    # design, so round(x, 1) means a different physical step in every scene:
    # on a calibration whose visible floor spans ~1.8 world units (measured on
    # MEVA and on the ss019 warehouse, whose whole room spanned 1.58 x 1.38)
    # a 0.1 step is ~5-6% of the floor, i.e. roughly one person-width -- the
    # click visibly snapped away from where the user put it. Lab 6p's ~33-unit
    # room is the only scale where 0.1 was ever negligible. Same bug family as
    # the absolute-constant thresholds in generic_pipeline.
    STATE["gates"].append([float(world[0]), float(world[1])])
    _save_gates()
    return jsonify(ok=True, n=len(STATE["gates"]), world=[float(world[0]), float(world[1])],
                  saved=STATE["gates_out"])


@app.route("/gates_reset", methods=["POST"])
def gates_reset():
    STATE["gates"] = []
    _save_gates()
    return jsonify(ok=True, n=0)


@app.route("/gates_pixels")
def gates_pixels():
    # projects every recorded gate (stored as world coords, camera-agnostic)
    # back into ONE camera's pixel space via that camera's forward H -- lets
    # the UI redraw previously-marked gates when a frame reloads (tab switch,
    # scrub), since the one-off dots drawn at click time don't survive a
    # canvas redraw on their own.
    cam = request.args.get("cam")
    if cam not in STATE["cal"]:
        return jsonify(ok=False, error=f"cam {cam} not calibrated"), 400
    H = STATE["cal"][cam]["H"]
    points = [list(_world_to_image(H, w)) for w in STATE["gates"]]
    return jsonify(ok=True, points=points)


def _bev_frame(cam, f):
    if _is_stream(STATE["video_paths"][cam]):
        if STATE.get("hold_axis") and f is not None:
            return _stream_frame_at(cam, f)
        return STATE["frames"][cam]          # running live: "now"
    if f is None:
        return STATE["frames"][cam]
    cap = cv2.VideoCapture(STATE["video_paths"][cam])
    cap.set(cv2.CAP_PROP_POS_FRAMES, f)
    ok, fr = cap.read()
    cap.release()
    return fr if ok else None


@app.route("/bev_overlay.png")
def bev_overlay():
    # every requested camera's own frame, rectified onto ONE shared floor-
    # plane canvas and averaged together -- if calibration+alignment is
    # correct, a real floor feature (a rug's edge, a tile seam) lands in the
    # SAME canvas position from every camera and looks sharp; if it's off,
    # it visibly doubles up/ghosts. Direct visual version of exactly what
    # _coverage_check's numbers describe. ?cams=0,2,3 (default: every
    # calibrated camera), ?f=<frame index> (default: each camera's startup
    # frame, same index applied to all), ?size=<canvas px> (default 700).
    cams_param = request.args.get("cams")
    cams_list = [c for c in (cams_param.split(",") if cams_param else sorted(STATE["cal"]))
                if c in STATE["cal"]]
    if not cams_list:
        return jsonify(error="no calibrated cameras to show"), 400
    f = request.args.get("f", type=int)
    canvas_size = request.args.get("size", default=700, type=int)
    S, bounds = _bev_canvas_transform(cams_list, canvas_size)
    if S is None:
        return jsonify(error="no camera footprint available"), 400

    acc = np.zeros((canvas_size, canvas_size, 3), np.float64)
    count = np.zeros((canvas_size, canvas_size, 1), np.float64)
    for c in cams_list:
        frame = _bev_frame(c, f)
        if frame is None:
            continue
        warped, mask = _warp_to_bev(c, S, canvas_size, frame)
        acc[mask] += warped[mask]
        count[mask] += 1
    out = np.where(count > 0, acc / np.maximum(count, 1), 40).astype(np.uint8)
    if request.args.get("grid", default="1") != "0":
        _draw_bev_grid(out, S, bounds)
    origin_px = (int(round(S[0, 2])), int(round(S[1, 2])))
    if 0 <= origin_px[0] < canvas_size and 0 <= origin_px[1] < canvas_size:
        cv2.drawMarker(out, origin_px, (0, 255, 255), cv2.MARKER_CROSS, 14, 2)
    ok, buf = cv2.imencode(".png", out)
    return send_file(io.BytesIO(buf.tobytes()), mimetype="image/png")


@app.route("/coverage_check")
def coverage_check_route():
    # read-only: inspect CURRENT calibration's per-camera coverage without
    # re-running alignment (align_compute's own coverage_check field only
    # updates when you actually align something) -- what the BEV overlay
    # view uses to show the diagnostic note alongside the picture.
    cc = _coverage_check(sorted(STATE["cal"]))
    return jsonify(cc or dict(note="need >= 2 calibrated cameras"))


@app.route("/bev_single/<cam>.png")
def bev_single(cam):
    # one camera's own rectified floor view, on the SAME canvas/scale
    # bev_overlay uses (computed from every calibrated camera, not just this
    # one) -- so switching between this and the overlay shows the same
    # framing, useful for spotting which specific camera is the misaligned
    # one once the overlay shows ghosting.
    if cam not in STATE["cal"]:
        return jsonify(error=f"cam {cam} not calibrated"), 400
    f = request.args.get("f", type=int)
    canvas_size = request.args.get("size", default=700, type=int)
    S, bounds = _bev_canvas_transform(sorted(STATE["cal"]), canvas_size)
    frame = _bev_frame(cam, f)
    if frame is None:
        return jsonify(error=f"could not read frame {f} from cam {cam}"), 404
    warped, _mask = _warp_to_bev(cam, S, canvas_size, frame)
    if request.args.get("grid", default="1") != "0":
        _draw_bev_grid(warped, S, bounds)
    ok, buf = cv2.imencode(".png", warped)
    return send_file(io.BytesIO(buf.tobytes()), mimetype="image/png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", action="append", required=True,
                    help="'cam_id=path/to/video.mp4', repeat once per camera")
    ap.add_argument("--frame", type=int, default=0, help="frame index to grab")
    ap.add_argument("--calib-out", default=str(CALIBRATION))
    ap.add_argument("--gates-out", default=None,
                    help="defaults to <first --video path>'s directory/gates.json -- gates are "
                         "tied to the physical camera rig (the footage), not to whichever "
                         "--calib-out filename this session happens to use, and this is also "
                         "where retrack.py's RETRACK_GATES_FILE looks by default when the "
                         "footage lives under data/footage/")
    ap.add_argument("--port", type=int, default=5000)
    args = ap.parse_args()

    STATE["calib_out"] = args.calib_out

    for spec in args.video:
        cam, path = spec.split("=", 1)
        STATE["video_paths"][cam] = path
        if _is_stream(path):
            STATE["frames"][cam] = None
            threading.Thread(target=_stream_grabber, args=(cam, path), daemon=True).start()
            t0 = time.time()
            while STATE["frames"][cam] is None and time.time() - t0 < 20:
                time.sleep(0.05)
            fr = STATE["frames"][cam]
            if fr is None:
                raise RuntimeError(f"no frame from live cam {cam} ({path}) after 20s")
            # n_frames 0 tells the UI this is live: there is nothing to scrub through
            STATE["video_meta"][cam] = dict(n_frames=0, fps=cap_fps(path))
            print(f"cam {cam}: {fr.shape[1]}x{fr.shape[0]} LIVE <- {path}")
        else:
            cap = cv2.VideoCapture(path)
            n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
            if args.frame:
                cap.set(cv2.CAP_PROP_POS_FRAMES, args.frame)
            ok, fr = cap.read()
            cap.release()
            if not ok:
                raise RuntimeError(f"could not read a frame from cam {cam} ({path})")
            STATE["frames"][cam] = fr
            STATE["video_meta"][cam] = dict(n_frames=n_frames, fps=fps)
            print(f"cam {cam}: {fr.shape[1]}x{fr.shape[0]}, {n_frames} frames @ {fps:.1f}fps <- {path}")

    first_video_dir = _pl.Path(next(iter(STATE["video_paths"].values()))).resolve().parent
    STATE["gates_out"] = args.gates_out or str(first_video_dir / "gates.json")

    # resume prior work if a calibration/gates file already exists -- the
    # server is stateless-in-memory (STATE["cal"]/STATE["gates"] start empty
    # every process start), so without this a restart would force redoing
    # rect-calibration + alignment from scratch even when nothing about the
    # cameras actually changed (hit repeatedly this session -- see
    # [[ghost_track_theft_bug_and_fix]]/gate-prior work in evaluation/score_terrace.py)
    calib_path = _pl.Path(args.calib_out)
    if calib_path.exists():
        loaded = json.load(open(calib_path))
        for cam, c in loaded.get("cameras", {}).items():
            Hinv = np.array(c["Hinv"], dtype=float)
            STATE["cal"][cam] = dict(Hinv=Hinv, H=np.linalg.inv(Hinv), diag=c.get("diagnostics", {}))
        if STATE["cal"]:
            print(f"resumed calibration for {sorted(STATE['cal'])} from {calib_path}")
    gates_path = _pl.Path(STATE["gates_out"])
    if gates_path.exists():
        STATE["gates"] = json.load(open(gates_path)).get("gates", [])
        if STATE["gates"]:
            print(f"resumed {len(STATE['gates'])} gate(s) from {gates_path}")

    print(f"\nopen http://127.0.0.1:{args.port} in a browser\n")
    app.run(host="127.0.0.1", port=args.port, debug=False)


if __name__ == "__main__":
    main()
