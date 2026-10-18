"""Calibration logic -- ground-plane homography fitting, multi-camera
alignment, and cross-check math. No Flask, no click-by-click server-side
state: a real frontend owns showing camera images and collecting clicked
points (reference_ui/calibration/calibration_app.py shows one way to build
that interaction, including the draggable-4th-corner UI trick -- but it's a
reference, not the deployed path). This module takes a COMPLETE set of
points per operation and returns/persists the result; see
features/calibration/api.py for the REST wrapper a frontend actually calls.

Persisted format unchanged from the original browser tool: site_calibration.json,
{"units": "cm", "cameras": {cam_id: {"Hinv": [[3x3]], "diagnostics": {...}}}}.

Aspect inference and the align fit-ladder below are PORTED from
reference_ui/calibration/calibration_app.py, not reinvented -- that tool
already found (and fixed) two real, MEASURED accuracy bugs the naive version
of this module still had:

  1. fit_homography_rect used to always assume a SQUARE target rectangle
     (aspect=1.0). A wrong aspect is a SHEAR baked into the camera's own
     world frame, invisible to the 4-point fit's own reprojection error
     (always ~0 by construction, regardless of whether the right-angle
     assumption -- or the aspect -- was actually correct). Measured cost on
     Warehouse_027: one camera's rectangle silently assumed square, and the
     three cameras then disagreed 1.6-3.0 person-widths on the same real
     floor point.
  2. align_cameras used to always fit a SIMILARITY transform (scale+
     rotation+translation, cv2.estimateAffinePartial2D) between two cameras'
     world frames, regardless of how many shared points were recorded. A
     similarity has NO shear term, so it can never repair a wrong aspect --
     it just reproduces the error in every camera it touches. Measured on
     WILDTRACK C3 (17 shared points, still 5 person-widths out) and again on
     Warehouse_027 (same 1.6-3.0 person-width disagreement as above, still
     present after "alignment").

Both are fixed here the same way the reference tool fixed them: infer the
real aspect ratio from the 4 clicked points' own perspective geometry
(vanishing-point rectification) instead of assuming square, and let
align_cameras fit the STRONGEST transform the evidence supports -- a full
homography (fixes shear/perspective) once >=4 shared points exist, an affine
(fixes shear, not perspective) at exactly 3, and only fall back to a
similarity (cannot fix a wrong aspect at all) below that, with the fit kind
recorded in the diagnostics either way so a weak fit is visible, not silent.
"""
import json
import pathlib as _pl
import numpy as np
import cv2

# _infer_aspect's stability check: how many jointly-perturbed re-solves to
# average over, the assumed per-click pixel noise, and the relative-spread
# threshold below which the result is called "confident". See infer_aspect's
# docstring -- these are the reference tool's own validated values, not
# re-tuned here.
ASPECT_STABILITY_TRIALS = 24
ASPECT_STABILITY_NOISE_PX = 1.0
ASPECT_STABILITY_MAX_RELATIVE_STD = 0.15


def load_calibration(path):
    """-> {cam_id: {"Hinv": (3,3) ndarray, "H": (3,3) ndarray, "diag": {...}}}.
    Missing file -> empty (no cameras calibrated yet)."""
    p = _pl.Path(path)
    if not p.exists():
        return {}
    d = json.load(open(p))
    cal = {}
    for cam_id, c in d.get("cameras", {}).items():
        Hinv = np.array(c["Hinv"], dtype=float)
        cal[cam_id] = dict(Hinv=Hinv, H=np.linalg.inv(Hinv), diag=c.get("diagnostics", {}))
    return cal


def scale_Hinv(Hinv, calib_res, frame_shape):
    """-> Hinv usable on a frame of `frame_shape`, given it was fitted at
    `calib_res`.

    A homography's pixel side is tied to the resolution it was fitted at.
    Feed it coordinates from a half-size frame and it maps people to half
    their real floor position -- confidently, with no error raised. It
    presents as a broken calibration, and this project has already lost
    time to "calibration problems" that were nothing of the kind.

    world = Hinv @ [u, v, 1]. On a frame scaled by s (u' = s*u), the same
    world point needs Hinv @ diag(1/s, 1/s, 1) @ [u', v', 1].

    The scale is taken from the ACTUAL FRAME, never from a config value.
    That way it self-corrects for every cause of a size change -- the
    camera table's quality setting, a renegotiated stream, a replaced
    camera -- rather than only the one we thought of. Returns Hinv
    unchanged when the resolution is unknown (an old calibration) or
    already matches.
    """
    if not calib_res:
        return Hinv
    cw, ch = float(calib_res[0]), float(calib_res[1])
    h, w = frame_shape[:2]
    if cw <= 0 or ch <= 0 or (abs(w - cw) < 1 and abs(h - ch) < 1):
        return Hinv
    sx, sy = w / cw, h / ch
    if abs(sx - sy) > 0.02 * max(sx, sy):
        # Non-uniform scaling means the aspect ratio changed, which a
        # resize alone cannot explain -- something reframed or cropped the
        # image, and the calibration no longer describes it.
        print(f"[calibration] frame {w}x{h} is not a uniform rescale of the "
              f"calibrated {cw:.0f}x{ch:.0f} (x{sx:.3f} vs x{sy:.3f}) -- "
              f"scaling anyway, but this calibration may no longer be valid")
    return Hinv @ np.diag([1.0 / sx, 1.0 / sy, 1.0])


def calibrated_res(cal_entry):
    """-> [w, h] the calibration was fitted at, or None if not recorded."""
    return (cal_entry or {}).get("diag", {}).get("calib_res")


def save_calibration(cal, path):
    out = dict(units="cm", cameras={
        c: dict(Hinv=cal[c]["Hinv"].tolist(), diagnostics=cal[c].get("diag", {}))
        for c in cal
    })
    json.dump(out, open(path, "w"), indent=2)


def image_to_world(Hinv, uv):
    p = Hinv @ np.array([uv[0], uv[1], 1.0])
    return (p[0] / p[2], p[1] / p[2])


def fit_homography(rows):
    """rows: [(px, py, world_x_m, world_y_m), ...] -> (Hinv, diagnostics)."""
    arr = np.array(rows, dtype=float)
    px = arr[:, :2]
    wc = arr[:, 2:] * 100.0
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


def infer_aspect_core(pixel_pts, img_w, img_h):
    """Single vanishing-point solve, no stability check -- (aspect, reason).
    aspect is None whenever the geometry is too degenerate to trust (near-
    parallel sides, no real focal-length solution, implausible result);
    reason then explains why. See infer_aspect (the public wrapper) for the
    method. Ported verbatim from reference_ui/calibration/calibration_app.py's
    _infer_aspect_core."""
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


def infer_aspect(pixel_pts, img_w, img_h):
    """4 clicked pixel points (same order as fit_homography_rect: p0,p1,p2,p3
    around an assumed right-angle shape) -> (aspect, diagnostics). Infers the
    TRUE aspect ratio of side (p0,p1) vs side (p0,p3) from the image alone --
    NOT assumed to be 1.0/square. Standard single-view rectangle
    rectification: the rectangle's two side directions are parallel to their
    opposite sides in real life, so each pair of opposite sides' image lines
    meet at a vanishing point; assuming a simple camera (zero skew, square
    pixels, principal point at image centre), the fact the two vanishing
    DIRECTIONS are perpendicular in real life pins down the one unknown
    (focal length), which is then enough to un-project the 4 corners onto a
    common plane and read off the true relative side lengths. No
    measurement, no typed number -- just the perspective geometry already
    implicit in a photo of a real rectangle.

    Falls back to aspect=1.0 (square) with `aspect_unreliable: True` and an
    explanatory warning whenever the geometry is too degenerate to trust
    (near-parallel sides, no real focal-length solution, implausible
    result) -- this is a LOUD fallback, never a silent one: the caller
    (align_cameras) refuses to use an unreliable camera as its alignment
    reference, and a >=4-point alignment replaces the homography outright
    regardless. An honest fallback beats a confident-looking wrong answer,
    but a wrong answer with no flag at all is worse than either -- that
    silent-square behaviour is the exact bug this function replaces (see
    this module's docstring).

    IMPORTANT, found by synthetic testing before this shipped in the
    reference tool: this solve is mathematically exact given noise-free
    points, but its SENSITIVITY to ordinary hand-click imprecision (~1-2px)
    varies wildly with viewing angle -- some poses stayed within ~5% of the
    true aspect under realistic noise, one came back with a 95% CI spanning
    0.8-2.25 against a true value of 2.0. A single solve has no way to tell
    you which regime you're in. So: also re-solve many times
    (ASPECT_STABILITY_TRIALS) after jointly perturbing ALL 4 points with
    small random noise -- matching how a real hand actually mis-clicks,
    every coordinate off by a bit at once, NOT one axis of one point at a
    time -- and report the resulting spread (`aspect_stability_std`)
    alongside the point estimate: a small spread means trust it, a large
    one means this pose is numerically fragile and dragging the auto-placed
    4th corner (see the reference tool / console UI) to its true position is
    the more reliable option.

    Ported verbatim (algorithm and constants) from reference_ui/calibration/
    calibration_app.py's _infer_aspect."""
    aspect, reason = infer_aspect_core(pixel_pts, img_w, img_h)
    if aspect is None:
        # A guessed square is a WRONG homography that reports no error, which
        # is the worst failure mode here: it silently bakes an aspect (and
        # therefore a shear) into the world frame, and downstream everything
        # looks calibrated. Measured cost on Warehouse_027: cam2 fell back
        # here and the three cameras then disagreed by 1.6-3.0 person-widths
        # on the same physical floor point. We still RETURN a usable
        # homography, because the camera has to be clickable to record the
        # shared points that fix it -- but it is flagged unreliable.
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

    # perturb ALL 4 points at once with small random noise (matching how a
    # real hand actually mis-clicks -- every coordinate off by a bit
    # simultaneously), not one axis of one point at a time: a one-at-a-time
    # sweep only explores 16 nearby configurations and can badly UNDERESTIMATE
    # the true sensitivity if the fragile direction requires several
    # coordinates to move together (confirmed by synthetic testing in the
    # reference tool: a pose that one-at-a-time called stable had 5x the std
    # under realistic combined noise).
    rng = np.random.default_rng(0)   # fixed seed -- same points always get the same verdict
    trials = [aspect]
    for _ in range(ASPECT_STABILITY_TRIALS):
        noise = rng.normal(0, ASPECT_STABILITY_NOISE_PX, size=(4, 2))
        pts2 = [(x + dx, y + dy) for (x, y), (dx, dy) in zip(pixel_pts, noise)]
        a2, _ = infer_aspect_core(pts2, img_w, img_h)
        if a2 is not None:
            trials.append(a2)
    trials = np.array(trials)
    spread = float(trials.std())
    confident = (len(trials) >= 0.8 * (ASPECT_STABILITY_TRIALS + 1)
                and spread < ASPECT_STABILITY_MAX_RELATIVE_STD * aspect)

    return aspect, dict(
        aspect_source=("vanishing-point inference" if confident else
                       "vanishing-point inference -- LOW CONFIDENCE, verify by dragging the 4th corner"),
        inferred_aspect=round(aspect, 3), aspect_stability_std=round(spread, 3), aspect_confident=confident)


def fit_homography_rect(pixel_pts, img_w, img_h):
    """4 pixel points (in order around an ASSUMED right-angle shape) ->
    (Hinv, diagnostics). No real-world measurement -- the target is a
    canonical rectangle whose TRUE aspect ratio is inferred from the 4
    points' own perspective geometry (see infer_aspect), not assumed
    square. `img_w`/`img_h` are the source frame's own pixel dimensions
    (the orthogonality solve needs the image centre as an assumed principal
    point)."""
    aspect, aspect_diag = infer_aspect(pixel_pts, img_w, img_h)
    px = np.array(pixel_pts, dtype=float)
    target_m = np.array([[0, 0], [aspect, 0], [aspect, 1], [0, 1]], dtype=float)
    Hinv, diag = fit_homography([(px[i, 0], px[i, 1], target_m[i, 0], target_m[i, 1])
                                 for i in range(4)])
    if diag is not None:
        diag.update(aspect_diag)
        # The resolution this homography's PIXEL side is expressed in.
        # Without it there is no way to use this calibration on a frame of
        # any other size -- and a frame of another size is not exotic: the
        # camera table's `quality` setting produces one deliberately, and a
        # restream or a swapped camera produces one by accident. Consuming
        # it is scale_Hinv's job; recording it is this function's.
        diag["calib_res"] = [float(img_w), float(img_h)]
    return Hinv, diag


def fit_homography_rect_manual_aspect(pixel_pts, aspect):
    """Same fit as fit_homography_rect, but with an EXPLICIT aspect instead
    of inferring one -- for a caller that already knows the true ratio (a
    tile with a printed/measured size) and wants to skip inference entirely.
    Not used by the deployed /calibration/rect endpoint today; kept as the
    escape hatch inference's own docstring points to (measure and pass the
    real ratio) if inference is ever untrustworthy on a given camera."""
    px = np.array(pixel_pts, dtype=float)
    target_m = np.array([[0, 0], [aspect, 0], [aspect, 1], [0, 1]], dtype=float)
    return fit_homography([(px[i, 0], px[i, 1], target_m[i, 0], target_m[i, 1])
                           for i in range(4)])


def pairwise_distances(cal, points):
    """points: {cam: [px, py]} (>=2 entries, every key already in `cal`) ->
    (worlds, pairs) using each camera's CURRENT Hinv."""
    worlds = {c: image_to_world(cal[c]["Hinv"], tuple(pt)) for c, pt in points.items()}
    cams_sorted = sorted(worlds)
    pairs = []
    for i in range(len(cams_sorted)):
        for j in range(i + 1, len(cams_sorted)):
            a, b = cams_sorted[i], cams_sorted[j]
            dist = float(np.hypot(worlds[a][0] - worlds[b][0], worlds[a][1] - worlds[b][1]))
            pairs.append(dict(cam_a=a, cam_b=b, distance_cm=round(dist, 1)))
    return worlds, pairs


def residual_pt(M, src, dst):
    """mean distance between dst and M @ src (M: 2x3 affine) -- used to
    compare two candidate point orderings for the same correspondence set.
    Ported from calibration_app.py's _residual_pt."""
    src_h = np.hstack([src, np.ones((len(src), 1), dtype=src.dtype)])
    proj = (M @ src_h.T).T
    return float(np.linalg.norm(proj - dst, axis=1).mean())


def residual_h(Hm, src_pix, dst_world):
    """Same idea as residual_pt but for a full 3x3 homography (needs the
    perspective divide a plain 2x3 affine doesn't). Ported from
    calibration_app.py's _res_h."""
    p = np.hstack([src_pix, np.ones((len(src_pix), 1), dtype=src_pix.dtype)])
    q = (Hm @ p.T).T
    q = q[:, :2] / q[:, 2:3]
    return float(np.linalg.norm(q - dst_world, axis=1).mean())


def _align_reference_score(cal, cam):
    """Ranks how trustworthy `cam`'s OWN rectangle is, for picking an
    alignment reference. Every other camera gets refitted onto the
    reference's frame, so a bad aspect anywhere else gets corrected, but a
    bad aspect on the REFERENCE itself is inherited by everyone -- so pick
    the most trustworthy rectangle, never just the lowest camera id (which
    is what this module did before this fix, and on Warehouse_027 that
    naive choice picked a camera whose aspect had to be guessed at 2.469).
    Ported from calibration_app.py's _ref_score."""
    d = cal[cam].get("diag", {}) or {}
    src = str(d.get("aspect_source", ""))
    return (
        0 if src.startswith("fallback") else 1,        # never a guessed square
        1 if d.get("aspect_confident") else 0,          # prefer a confident inference
        -float(d.get("aspect_stability_std") or 9e9),   # then the most stable
    )


def align_cameras(cal, align_points):
    """BFS from the MOST TRUSTWORTHY calibrated camera (see
    _align_reference_score -- not just the lowest id): for each not-yet-
    aligned camera with >=2 points shared with an already-aligned one, fit
    the STRONGEST transform the evidence supports and bake it into the
    not-yet-aligned camera's Hinv. Runs breadth-first so two cameras that
    never directly share a point can still be tied together through a third
    that shares points with both -- each step measures the new camera
    against whatever the reference camera's frame CURRENTLY is (possibly
    itself already corrected earlier in the same BFS), not its own original,
    independently-assumed frame.

    THE FIT LADDER (this is the real fix -- see this module's docstring for
    the measured cost of not having it): a similarity transform (4 dof:
    uniform scale, rotation, translation) has NO shear term, so it can never
    repair a wrong rectangle aspect -- it just reproduces that error in
    every camera it touches. With >=4 shared points this fits a full
    HOMOGRAPHY straight from this camera's pixels to the reference camera's
    world frame instead: the ground homography, derived entirely from
    correspondences, so this camera's own clicked rectangle -- and any
    error in it -- drops out of the answer completely. With exactly 3
    points (not enough for a homography) it fits an AFFINE (6 dof, has a
    shear term, still repairs aspect, not perspective). Only below 3 points
    does it fall back to a similarity, and the returned diagnostics say so
    explicitly (`fit` names which kind ran) rather than leaving it to be
    assumed.

    Point ORDER within a shared correspondence set matters -- e.g. a
    "shared line"'s points are paired up by list position, which silently
    assumes both cameras were clicked in the same real-world order. A full
    reversal (the natural mistake when the same physical line visually runs
    opposite directions in two camera views) is invisible to a simple
    length-agreement check (summed segment length is the same forwards or
    backwards) and would otherwise silently feed a wrong-but-self-consistent
    correspondence set into the fit. With >=3 points (enough redundancy for
    residuals to actually distinguish forward from reversed -- with exactly
    2 points many of these fits are exactly-determined and both orderings
    can fit with ~0 residual regardless of correctness), also fit the
    reversed ordering and keep whichever fits better, recording which one
    won (`order_reversed`) so a meaningful gap between the two is a visible
    signal rather than a silent guess.

    Mutates `cal` in place (each aligned camera's Hinv/H/diag updated) and
    returns a results dict -- same convention as this project's other
    gallery-style mutators (e.g. common/face_id.py's enroll()).

    align_points: [{cam: [px,py], ...}, ...] -- the FULL list of shared-point
    observations. The frontend accumulates these across however many clicks
    and sends the whole list at once; there's no incremental server-side
    banking here (unlike the original browser tool's /align_point_add).

    Ported from calibration_app.py's align_compute -- BFS structure,
    reference selection, and fit ladder all preserved."""
    cams = sorted(cal)
    if len(cams) < 2:
        return dict(error="need >= 2 calibrated cameras")

    pair_obs = {}   # {(cam_a, cam_b): [{cam_a: [px,py], cam_b: [px,py]}, ...]}
    for pt in align_points:
        seen = sorted(c for c in pt if c in cal)
        for i in range(len(seen)):
            for j in range(i + 1, len(seen)):
                a, b = seen[i], seen[j]
                pair_obs.setdefault((a, b), []).append({a: pt[a], b: pt[b]})

    ref = max(cams, key=lambda c: _align_reference_score(cal, c))
    ref_diag = cal[ref].get("diag", {}) or {}
    results_warning = None
    if str(ref_diag.get("aspect_source", "")).startswith("fallback"):
        results_warning = ("every calibrated camera's rectangle aspect had to be guessed, "
                           "so the shared world frame's shape is a guess too -- re-click ONE "
                           "camera's rectangle on a large, clearly-rectangular floor feature "
                           "with its corners far apart, then align again")

    visited = {ref}
    queue = [ref]
    cal[ref]["diag"] = dict(cal[ref].get("diag", {}), aligned=True)
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
            world_v = np.array([image_to_world(cal[v]["Hinv"], o[v]) for o in obs],
                               dtype=np.float32)
            world_u = np.array([image_to_world(cal[u]["Hinv"], o[u]) for o in obs],
                               dtype=np.float32)
            pix_u = np.array([o[u] for o in obs], dtype=np.float32)
            n = len(obs)

            order_reversed = False
            order_diag = {}
            new_Hinv = None
            fit_kind = None

            if n >= 4:
                Hfit, _m = cv2.findHomography(pix_u, world_v, 0)
                if Hfit is not None and np.isfinite(Hfit).all():
                    res_fwd = residual_h(Hfit, pix_u, world_v)
                    Hrev, _m2 = cv2.findHomography(pix_u[::-1], world_v, 0)
                    if Hrev is not None and np.isfinite(Hrev).all():
                        res_rev = residual_h(Hrev, pix_u[::-1], world_v)
                        order_diag = dict(order_check_residual_pt=round(res_fwd, 3),
                                          order_check_reversed_residual_pt=round(res_rev, 3))
                        if res_rev < res_fwd:
                            Hfit, res_fwd, order_reversed = Hrev, res_rev, True
                    else:
                        order_diag = dict(order_check_residual_pt=round(res_fwd, 3))
                    new_Hinv = Hfit
                    fit_kind = f"full homography from {n} shared points (pixels -> cam {v} world)"

            if new_Hinv is None:
                # <4 points: cannot solve a homography. Fall down the ladder --
                # an affine (6 dof) still fixes shear/aspect, a similarity
                # (4 dof) does not.
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
                    M_rev, _ir = cv2.estimateAffine2D(world_u[::-1], world_v)
                    if M_rev is not None:
                        res_fwd = residual_pt(M, world_u, world_v)
                        res_rev = residual_pt(M_rev, world_u[::-1], world_v)
                        order_diag = dict(order_check_residual_pt=round(res_fwd, 3),
                                          order_check_reversed_residual_pt=round(res_rev, 3))
                        if res_rev < res_fwd:
                            M, order_reversed = M_rev, True
                new_Hinv = np.vstack([M, [0.0, 0.0, 1.0]]) @ cal[u]["Hinv"]

            cal[u]["Hinv"] = new_Hinv
            cal[u]["H"] = np.linalg.inv(new_Hinv)
            cal[u]["diag"] = dict(
                cal[u].get("diag", {}),
                aligned=True, aligned_to=v, aligned_with_n_points=n,
                order_reversed=order_reversed, fit=fit_kind,
                # a >=4-point fit REPLACES this camera's homography outright,
                # so whatever its own rectangle said no longer matters
                aspect_superseded=(n >= 4), **order_diag,
                note=f"Hinv set by align_cameras: {fit_kind}"
                     + (" -- this camera's own clicked rectangle no longer affects the "
                        "result" if n >= 4 else "")
                     + (" -- point order was REVERSED relative to click order because it "
                        "fit noticeably better; if this is unexpected, the shared points "
                        "for this camera were likely clicked in the opposite real-world "
                        "direction from the other camera's" if order_reversed else ""))
            visited.add(u)
            queue.append(u)
            results[u] = dict(aligned=True, reference=False, n_points=n, via=v,
                              order_reversed=order_reversed)

    for c in cams:
        if c not in visited:
            results[c] = dict(aligned=False, reference=False, n_points=0, via=None,
                              error="no chain of >=2-point camera pairs connects this "
                                    "camera back to the reference -- record more shared "
                                    "points involving it")

    # residual distances for every recorded point, using the now-corrected
    # Hinvs, so the caller can see the improvement directly
    residuals = [dict(pairs=pairwise_distances(cal, {c: pt[c] for c in pt if c in cal})[1])
                for pt in align_points if len(pt) >= 2]

    weak = sorted(c for c in cams
                  if (cal[c].get("diag", {}) or {}).get("aligned_with_n_points", 0)
                  and not (cal[c].get("diag", {}) or {}).get("aspect_superseded"))

    out = dict(results=results, reference=ref, residual_checks=residuals)
    if results_warning:
        out["reference_warning"] = results_warning
    if weak:
        out["weak_fits"] = (f"camera(s) {weak} were aligned with <4 shared points, so their "
                            f"own rectangle still determines their world frame. If any of "
                            f"them shows a bad aspect, click more shared points (>=4) to "
                            f"replace it outright.")
    return out
