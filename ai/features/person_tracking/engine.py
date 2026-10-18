"""Live multi-camera person tracking -- hybrid foot+silhouette POM detection +
SORT-style frozen-anchor revival tracking, vendored and adapted from
architectures/pom_fusion/generic_pipeline.py (the validated, best-performing
tracker in this repo: Lab 6p HOTA 68.9 / IDF1 88.2 / IDsw 12, also validated
on Lab 4p, EPFL Terrace, and a live MJPEG stream). See that module's own
docstring for the full algorithm writeup and the person-width design
rationale (every world distance here is a multiple of a scene's own measured
person_scale, never an absolute unit).

Vendored rather than imported: features/ never imports from architectures/
(verified -- nothing else here does either), the same reason
features/common/fusion.py deliberately duplicates evaluation/score_
wildtrack.py's fuse_camera_boxes instead of importing it. If the underlying
algorithm changes, port the change to BOTH copies.

What's vendored verbatim: detect_imgsz, measure_person_scale, build_detector,
build_tracker_params, POM_PARAMS and the person-width tuning constants.
What's adapted: recover_heads_and_room now reads frames through
features/common/video_source (so live sampling transparently reuses the same
persistent LiveGrabber the background tracking loop keeps using afterward,
instead of managing its own captures) and returns its warnings as a list
instead of only printing them. Tracker carries three deliberate deltas from
the architectures/ copy -- see its docstring.
"""
import json
import pathlib as _pl
import time

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from ..common.video_source import is_stream, read_frame, video_meta
from ..common.person_detector import get_model
from ..calibration.engine import calibrated_res, load_calibration, scale_Hinv
from ..common.cameras import quality as camera_quality

# ---------------------------------------------------------------------------
# Constants vendored verbatim from architectures/pom_fusion/generic_pipeline.py.
# See that module for the full derivation of each -- every world distance is
# a multiple of person_scale (measured per scene, never an absolute unit).
# ---------------------------------------------------------------------------
POM_PARAMS = dict(WIDTH_RATIO=0.35, GRID_N=240, CAM_SUPPORT_MIN=2,
                  FOOT_BASE=0.35, SUPPORT_THRESH=0.22, PEAK_MIN=0.55)

HEAD_HOMOGRAPHY_RANSAC_PW = 12.0 / 33.09
LIVE_CALIB_GAP_S = 1.5          # seconds between bootstrap samples on a live source
DUP_GUARD_PW = 0.85
FOOT_SIGMA_PW = 24.0 / 33.09
ROOM_PAD_PW = 40.0 / 33.09
GATE_PW = 54.2 / 33.09
REVIVE_GATE_PW = 5.5
GATE_RADIUS_PW = 3.0
FAR_GATE_REVIVE_PW = 9.0
REVIVE_BASE_PW = 2.4
REVIVE_DIFFUSION_PW = 1.4 / (32.011 / 25.0)
ROOM_PW_SANE = (3.0, 120.0)
# Minimum pixels one person-width must span for a camera to count as really
# seeing that patch of floor -- matches build_detector's own `height > 8`
# validity mask. See covisible_floor_bbox.
MIN_PERSON_PX = 8.0
MAX_LOST_S = 24.0
STALE_GATE_S = 0.4


def detect_imgsz(img_dims):
    """Run YOLO at the footage's OWN resolution, not ultralytics' 640 default
    -- see architectures/pom_fusion/generic_pipeline.py's detect_imgsz for the
    measured recall difference (3.3x on WILDTRACK, 640 vs native). Rounded up
    to a multiple of 32 (the detector's stride), max over cameras."""
    longest = max(max(w, h) for w, h in img_dims.values())
    return int(np.ceil(longest / 32.0) * 32)


def measure_person_scale(Hg, cams, sample):
    """Median world-space width of a detection box's BOTTOM edge, over every
    camera -- the scene's own ruler. See generic_pipeline.py's version for
    the full reasoning; identical here."""
    per_cam = {}
    for c in cams:
        b = np.asarray(sample[c], np.float64)
        if not len(b):
            continue
        bottom = lambda xs: np.column_stack([xs, b[:, 3], np.ones(len(b))])
        L = Hg[c] @ bottom(b[:, 0]).T
        R = Hg[c] @ bottom(b[:, 2]).T
        L = np.column_stack([L[0] / L[2], L[1] / L[2]])
        R = np.column_stack([R[0] / R[2], R[1] / R[2]])
        w = np.linalg.norm(R - L, axis=1)
        w = w[np.isfinite(w) & (w > 0)]
        if len(w):
            per_cam[c] = float(np.median(w))
    if not per_cam:
        raise ValueError('could not measure a person width from any camera -- '
                         'no usable detections')
    return float(np.median(list(per_cam.values()))), per_cam


def recover_heads_and_room(model, video_paths, Hg, cams, img_dims, calib_frames, room_trim_pct,
                           imgsz=None, cam_support_min=2):
    """Sample detections across the scene, then: (1) fit each camera's
    head-plane homography by RANSAC; (2) measure the scene's own person-width
    ruler; (3) derive the room's world extent. Adapted from generic_pipeline.
    py's version of this function -- reads frames via features/common/
    video_source.read_frame instead of managing its own captures, so a live
    source's bootstrap sampling reuses the same persistent LiveGrabber the
    tracking loop will keep reading from afterward. Returns (Hh, room,
    person_scale, warnings) -- warnings is new: the batch version only
    printed, this one also returns them so the API can surface them."""
    warnings = []
    i2w = lambda H, px, py: (lambda w: (w[0] / w[2], w[1] / w[2]))(H @ np.array([px, py, 1.0]))
    foot = lambda b: ((b[0] + b[2]) / 2, b[3]); head_pt = lambda b: ((b[0] + b[2]) / 2, b[1])

    live = any(is_stream(video_paths[c]) for c in cams)
    sample = {c: [] for c in cams}
    if live:
        print(f'  live source: sampling {len(calib_frames)} frames over '
              f'{len(calib_frames) * LIVE_CALIB_GAP_S:.0f}s of real time')
    for _k, fi in enumerate(calib_frames):
        ims = []
        for c in cams:
            im = read_frame(video_paths[c], quality=camera_quality(c),
                            index=None if is_stream(video_paths[c]) else fi)
            ims.append(im if im is not None else np.zeros((img_dims[c][1], img_dims[c][0], 3), np.uint8))
        if live and _k < len(calib_frames) - 1:
            time.sleep(LIVE_CALIB_GAP_S)
        res = model(ims, conf=0.25, imgsz=imgsz or detect_imgsz(img_dims), verbose=False)
        for c, r in zip(cams, res):
            if r.boxes is not None and len(r.boxes):
                sample[c].extend(r.boxes.xyxy.cpu().numpy())

    person_scale, per_cam = measure_person_scale(Hg, cams, sample)
    spread = max(per_cam.values()) / max(min(per_cam.values()), 1e-12)
    print('  person width per camera: '
          + '  '.join(f'cam{c}={v:.3f}' for c, v in sorted(per_cam.items()))
          + f'  -> person_scale={person_scale:.3f} (max/min {spread:.2f}x)')
    if spread > 1.5:
        msg = (f'cameras disagree {spread:.1f}x on how wide a person is -- they are '
              f'not on a consistent world scale, so alignment is wrong. Re-align with '
              f'shared points spread across the WHOLE room, not clustered together.')
        print(f'  WARNING: {msg}')
        warnings.append(msg)

    cv2.setRNGSeed(0)
    Hh = {}
    for c in cams:
        if len(sample[c]) < 4:
            raise ValueError(f'cam {c}: only {len(sample[c])} detections across the calibration '
                             f'sample -- not enough to fit a head homography. Check the source is '
                             f'actually showing people right now.')
        if len(sample[c]) < 15:
            msg = f'cam {c}: only {len(sample[c])} calibration detections -- head homography may be noisy'
            print(f'  WARNING {msg}')
            warnings.append(msg)
        hp = np.array([head_pt(b) for b in sample[c]], np.float64)
        wf = np.array([i2w(Hg[c], *foot(b)) for b in sample[c]], np.float64)
        ransac_thresh = HEAD_HOMOGRAPHY_RANSAC_PW * person_scale
        Hcam, mask = cv2.findHomography(hp, wf, cv2.RANSAC, ransac_thresh)
        if Hcam is None:
            raise ValueError(f'cam {c}: head homography fit failed (degenerate points?)')
        Hh[c] = Hcam
        n_in = int(mask.sum())
        print(f'  cam {c}: {len(hp)} dets, {n_in} inliers (of {len(hp)}, '
              f'{ransac_thresh:.3f} threshold)')
        if n_in == len(hp) and len(hp) >= 15:
            msg = (f'cam {c}: 100% inliers on {len(hp)} points is suspicious -- real '
                  f'detection noise rarely fits a homography perfectly.')
            print(f'    WARNING: {msg}')
            warnings.append(msg)

    allw = np.array([i2w(Hg[c], *foot(b)) for c in cams for b in sample[c]])
    allw = allw[np.isfinite(allw).all(1)]
    lo = np.percentile(allw, room_trim_pct, axis=0)
    hi = np.percentile(allw, 100.0 - room_trim_pct, axis=0)
    pad = ROOM_PAD_PW * person_scale
    seen_room = dict(xmin=float(lo[0] - pad), xmax=float(hi[0] + pad),
                     ymin=float(lo[1] - pad), ymax=float(hi[1] + pad))
    seen_span_pw = (min(hi[0] - lo[0], hi[1] - lo[1])) / person_scale
    print(f'  detections during bootstrap spanned {seen_span_pw:.2f} person-widths')

    # The room IS build_detector's POM grid, so anywhere outside it is
    # undetectable by construction. Sizing it purely from where people
    # happened to walk during the ~30s bootstrap is far too fragile live --
    # see covisible_floor_bbox for the measured failure this fixes. UNION the
    # two: never smaller than where people were actually seen, but always at
    # least the floor that enough cameras can see.
    ref_world = (float(np.median(allw[:, 0])), float(np.median(allw[:, 1])))
    covis, covis_note = covisible_floor_bbox(Hg, img_dims, cams, cam_support_min, ref_world,
                                             person_scale)
    if covis is None:
        room = seen_room
        msg = (f'could not derive the co-visible floor region ({covis_note}); falling back to '
               f'the bootstrap detection extent alone, so anyone outside where people walked '
               f'during setup may be undetectable')
        print(f'  WARNING: {msg}')
        warnings.append(msg)
    else:
        room = dict(xmin=min(seen_room['xmin'], covis['xmin']),
                    xmax=max(seen_room['xmax'], covis['xmax']),
                    ymin=min(seen_room['ymin'], covis['ymin']),
                    ymax=max(seen_room['ymax'], covis['ymax']))
        grew = ((room['xmax'] - room['xmin']) * (room['ymax'] - room['ymin'])
                / max((seen_room['xmax'] - seen_room['xmin'])
                      * (seen_room['ymax'] - seen_room['ymin']), 1e-9))
        print(f'  tracked area = bootstrap extent UNION {covis_note} '
              f'({grew:.1f}x the bootstrap extent alone)')

    across = min(room['xmax'] - room['xmin'], room['ymax'] - room['ymin']) / person_scale
    print(f'  room measures {across:.1f} person-widths across')
    if not ROOM_PW_SANE[0] <= across <= ROOM_PW_SANE[1]:
        msg = (f'room measures {across:.1f} person-widths across, outside the plausible '
              f'range {ROOM_PW_SANE} for a real room -- suspect the calibration scale.')
        print(f'  WARNING: {msg}')
        warnings.append(msg)
    return Hh, room, person_scale, warnings


def covisible_floor_bbox(Hg, img_dims, cams, min_cams, ref_world, person_scale, grid_n=200):
    """-> (bbox dict or None, note). The world-space region of FLOOR that at
    least `min_cams` cameras can actually see.

    This exists because deriving the tracked area purely from where people
    happened to walk during the ~30s bootstrap is far too fragile on a live
    site: measured on a real 2-camera deployment, the sampled foot points
    spanned only 1.33 x 1.18 person-widths (one person standing roughly
    still), so the room -- and therefore build_detector's POM grid, which is
    literally linspace(xmin, xmax, GRID_N) -- collapsed to that spot plus
    padding. A zone the operator could plainly see in BOTH cameras ended up
    97.9% outside the grid, so nobody entering it could be detected at all.
    Nothing was wrong with their calibration; the grid just wasn't there.

    The co-visible floor is the principled bound instead: POM already
    requires `min_cams` cameras to agree before it will report a person
    (CAM_SUPPORT_MIN), so grid cells outside that region can never produce a
    detection anyway, and cells inside it are exactly the ones that can.

    A cell counts as visible to a camera only if a person standing there
    would also be RESOLVABLE by it -- at least MIN_PERSON_PX wide, matching
    build_detector's own `height > 8` validity mask. Without that test the
    region runs away toward the horizon (verified: 31.7 vs 4.5 world units on
    a synthetic rig), where floor is technically in frame but a person covers
    a couple of pixels. That area is useless for detection and actively
    harmful: GRID_N is fixed, so a runaway extent makes every cell coarser,
    including the ones that matter.

    `ref_world` must be a world point known to be real floor in view (the
    centroid of the bootstrap detections) -- a planar homography is only
    defined up to sign, so it is used to orient each camera's world->pixel
    map before the in-front-of-camera test."""
    H = {}
    for c in cams:
        try:
            h = np.linalg.inv(Hg[c])
        except np.linalg.LinAlgError:
            # a singular calibration matrix is a real possibility (a bad fit
            # upstream); this function's contract is to REFUSE with a reason,
            # never to raise into the bootstrap or emit a garbage room
            return None, f'camera {c}: calibration matrix is singular, cannot invert'
        if not np.isfinite(h).all():
            return None, f'camera {c}: calibration matrix inverts to non-finite values'
        w = float(h[2] @ np.array([ref_world[0], ref_world[1], 1.0]))
        if not np.isfinite(w) or abs(w) < 1e-12:
            return None, f'camera {c}: reference point is degenerate under its homography'
        H[c] = h if w > 0 else -h

    # Candidate bounds: project a grid of IMAGE points out to the floor and
    # robust-percentile clip. Rows near the horizon project arbitrarily far
    # (that is real projective geometry, not an error), so a plain min/max
    # would be meaningless -- but this only has to be a SUPERSET, since the
    # co-visibility rasterisation below decides the actual answer.
    cand = []
    for c in cams:
        W, Hh_px = img_dims[c]
        us, vs = np.meshgrid(np.linspace(0, W, 60), np.linspace(0, Hh_px, 60))
        pts = np.vstack([us.ravel(), vs.ravel(), np.ones(us.size)])
        q = Hg[c] @ pts
        ok = np.abs(q[2]) > 1e-9
        wx, wy = q[0][ok] / q[2][ok], q[1][ok] / q[2][ok]
        f = np.isfinite(wx) & np.isfinite(wy)
        if f.any():
            cand.append(np.column_stack([wx[f], wy[f]]))
    if not cand:
        return None, 'no camera produced a finite floor projection'
    allc = np.vstack(cand)
    lo = np.percentile(allc, 1.0, axis=0)
    hi = np.percentile(allc, 99.0, axis=0)
    if not (np.isfinite(lo).all() and np.isfinite(hi).all()) or (hi <= lo).any():
        return None, 'floor projection produced no usable candidate bounds'

    xs = np.linspace(lo[0], hi[0], grid_n)
    ys = np.linspace(lo[1], hi[1], grid_n)
    GX, GY = np.meshgrid(xs, ys)
    world = np.vstack([GX.ravel(), GY.ravel(), np.ones(GX.size)])
    world_off = np.vstack([GX.ravel() + person_scale, GY.ravel(), np.ones(GX.size)])
    support = np.zeros(GX.size, dtype=int)
    for c in cams:
        W, Hh_px = img_dims[c]
        p = H[c] @ world
        q = H[c] @ world_off
        infront = (p[2] > 1e-9) & (q[2] > 1e-9)
        safe_p = np.where(infront, p[2], 1.0)
        safe_q = np.where(infront, q[2], 1.0)
        px, py = p[0] / safe_p, p[1] / safe_p
        qx, qy = q[0] / safe_q, q[1] / safe_q
        in_frame = infront & (px >= 0) & (px < W) & (py >= 0) & (py < Hh_px)
        # one person-width at this cell must span >= MIN_PERSON_PX in this
        # camera, i.e. the camera can actually resolve a person standing here
        resolvable = np.hypot(qx - px, qy - py) >= MIN_PERSON_PX
        support += (in_frame & resolvable).astype(int)

    inside = support >= max(1, int(min_cams))
    if not inside.any():
        return None, (f'no floor cell is visible to {min_cams} cameras at once -- the cameras '
                      f'do not share a usable view of the floor')
    gx, gy = GX.ravel()[inside], GY.ravel()[inside]
    # Grow by one cell per side: this is a rasterised test, so the extreme
    # usable cell sits up to one step inside the true boundary and rounding
    # inward would silently clip real, detectable floor off the grid edge.
    dx = (xs[1] - xs[0]) if len(xs) > 1 else 0.0
    dy = (ys[1] - ys[0]) if len(ys) > 1 else 0.0
    return (dict(xmin=float(gx.min() - dx), xmax=float(gx.max() + dx),
                 ymin=float(gy.min() - dy), ymax=float(gy.max() + dy)),
            f'floor visible to >={min_cams} cameras')


def build_detector(Hg, Hh, room, cams, img_dims, P):
    """Hybrid foot+silhouette POM detector, closed over this scene's own
    Hg/Hh/room/params. Vendored verbatim from generic_pipeline.py -- see that
    module for the full reasoning (including why detector-side duplicate
    suppression was tried and measurably hurt; the duplicate guard lives in
    Tracker instead)."""
    xmin, xmax, ymin, ymax = room['xmin'], room['xmax'], room['ymin'], room['ymax']
    Hg_inv = {c: np.linalg.inv(Hg[c]) for c in cams}
    Hh_inv = {c: np.linalg.inv(Hh[c]) for c in cams}
    GRID_N = P['GRID_N']
    xs = np.linspace(xmin, xmax, GRID_N); ys = np.linspace(ymin, ymax, GRID_N)
    GX, GY = np.meshgrid(xs, ys); ones = np.ones_like(GX)

    def w2i(Hinv):
        p = Hinv @ np.stack([GX, GY, ones], 0).reshape(3, -1)
        return (p[0] / p[2]).reshape(GX.shape), (p[1] / p[2]).reshape(GX.shape)

    RECT = {}
    for c in cams:
        IMG_W, IMG_H = img_dims[c]
        fx, fy = w2i(Hg_inv[c]); hx, hy = w2i(Hh_inv[c])
        height = np.abs(fy - hy); width = height * P['WIDTH_RATIO']; xc = (fx + hx) / 2
        RECT[c] = dict(x1=xc - width / 2, y1=np.minimum(fy, hy), x2=xc + width / 2, y2=np.maximum(fy, hy),
                       valid=(fx > 0) & (fx < IMG_W) & (fy > 0) & (fy < IMG_H) & (height > 8) & (height < IMG_H * 1.5))
        RECT[c]['area'] = (RECT[c]['x2'] - RECT[c]['x1']) * (RECT[c]['y2'] - RECT[c]['y1'])

    def iou_grid(c, box):
        r = RECT[c]
        x1 = np.maximum(r['x1'], box[0]); y1 = np.maximum(r['y1'], box[1])
        x2 = np.minimum(r['x2'], box[2]); y2 = np.minimum(r['y2'], box[3])
        inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
        union = r['area'] + (box[2] - box[0]) * (box[3] - box[1]) - inter
        return np.where(union > 0, inter / union, 0.0) * r['valid']

    def foot_field(c, box):
        fx, fy = (box[0] + box[2]) / 2, box[3]
        w = Hg[c] @ np.array([fx, fy, 1.0]); fwx, fwy = w[0] / w[2], w[1] / w[2]
        return np.exp(-((GX - fwx) ** 2 + (GY - fwy) ** 2) / (2 * P['FOOT_SIGMA'] ** 2)) * RECT[c]['valid']

    def hybrid_detect(boxes):
        ev = {c: [foot_field(c, b) * np.maximum(iou_grid(c, b), P['FOOT_BASE']) for b in boxes[c]] for c in cams}
        avail = {c: list(range(len(boxes[c]))) for c in cams}
        people = []
        for _ in range(20):
            total = np.zeros((GRID_N, GRID_N)); support = np.zeros((GRID_N, GRID_N)); binfo = {}
            for c in cams:
                best = np.zeros((GRID_N, GRID_N)); bidx = -np.ones((GRID_N, GRID_N), int)
                for i in avail[c]:
                    upd = ev[c][i] > best
                    best = np.where(upd, ev[c][i], best); bidx = np.where(upd, i, bidx)
                total += best; support += (best > P['SUPPORT_THRESH']).astype(float); binfo[c] = (best, bidx)
            cand = total * ((support >= P['CAM_SUPPORT_MIN']) & (total >= P['PEAK_MIN']))
            if cand.max() <= 0:
                break
            ci, cj = np.unravel_index(np.argmax(cand), cand.shape)
            people.append((float(xs[cj]), float(ys[ci]), int(ci), int(cj)))
            for c in cams:
                best, bidx = binfo[c]
                i = int(bidx[ci, cj])
                if i >= 0 and i in avail[c] and best[ci, cj] > P['SUPPORT_THRESH']:
                    avail[c].remove(i)
        return people

    return hybrid_detect, RECT, xs, ys


def build_tracker_params(person_scale, fps, *, gate_pw=GATE_PW, revive_pw=REVIVE_GATE_PW,
                         dup_guard_pw=DUP_GUARD_PW, max_lost_s=MAX_LOST_S,
                         stale_gate_s=STALE_GATE_S, diffusion_revive=False):
    """THE single source of truth for Tracker's parameter dict, resolved
    against this scene's own person_scale and fps. Vendored verbatim from
    generic_pipeline.py's build_tracker_params -- never construct a second
    parameter dict."""
    P = dict(GATE=gate_pw * person_scale,
             REVIVE_GATE=revive_pw * person_scale,
             DUP_GUARD=dup_guard_pw * person_scale,
             GATE_RADIUS=GATE_RADIUS_PW * person_scale,
             FAR_GATE_REVIVE=FAR_GATE_REVIVE_PW * person_scale,
             MAX_LOST=int(round(max_lost_s * fps)),
             STALE_GATE=int(round(stale_gate_s * fps)),
             FPS=fps,
             MAX_COAST=10, MERGE_DIST=0, MIN_HITS=3, VEL_EMA=0.5)
    if diffusion_revive:
        P.update(REVIVE_BASE=REVIVE_BASE_PW * person_scale,
                 REVIVE_DIFFUSION=REVIVE_DIFFUSION_PW * person_scale)
    return P


class Tracker:
    """Incremental SORT-style frozen-anchor revival tracker -- vendored from
    architectures/pom_fusion/generic_pipeline.py's Tracker (itself refactored
    from that module's original batch run_tracker) with three deliberate
    deltas for a live, unbounded-session deployment instead of a finite
    batch cache:

    1. PRUNING: step() drops tracks past MAX_LOST from self.tracks at the end
       of every call. Safe here (a dead track's misses only ever grows, and a
       merge target must have misses <= MAX_COAST < MAX_LOST, so nothing
       prunable can still become a future merge target) and necessary here (an
       unbounded live session would otherwise accumulate every track that ever
       existed, forever). NOT applied in the architectures/ copy, which needs
       every historical track in `final` for ground-truth scoring.
    2. Track.hist is dropped -- nothing in the live path renders a video.
    3. The FAR_GATE_REVIVE/REVIVE_GATE sanity check raises ValueError instead
       of SystemExit -- appropriate for library code running inside a FastAPI
       background task. Moot at v1 since this feature always passes gates=[].

    See generic_pipeline.py's Tracker for the full per-branch reasoning
    (STALE_GATE, the gate-location prior, DUP_GUARD) -- unchanged here.
    """
    def __init__(self, gates, P):
        self.gates = gates
        self.GATE = P['GATE']; self.REVIVE_GATE = P['REVIVE_GATE']; self.MAX_COAST = P['MAX_COAST']
        self.MAX_LOST = P['MAX_LOST']; self.MERGE_DIST = P['MERGE_DIST']; self.MIN_HITS = P['MIN_HITS']
        self.VEL_EMA = P['VEL_EMA']; self.STALE_GATE = P['STALE_GATE']; self.STALE_PENALTY = 1e6
        self.GATE_RADIUS = P.get('GATE_RADIUS', 0.0); self.FAR_GATE_REVIVE = P.get('FAR_GATE_REVIVE', 0.0)
        self.REVIVE_BASE = P.get('REVIVE_BASE'); self.REVIVE_DIFFUSION = P.get('REVIVE_DIFFUSION', 0.0)
        self.FPS = P.get('FPS') or 25.0
        self.DUP_GUARD = P.get('DUP_GUARD', 0.0)

        if gates and self.FAR_GATE_REVIVE <= self.REVIVE_GATE:
            raise ValueError(
                f'FAR_GATE_REVIVE ({self.FAR_GATE_REVIVE:.3f}) must exceed REVIVE_GATE '
                f'({self.REVIVE_GATE:.3f}) or the entry-gate prior can never fire.')

        MIN_HITS, VEL_EMA = self.MIN_HITS, self.VEL_EMA
        class Track:
            def __init__(s, pos, f):
                s.pos = np.array(pos, float); s.vel = np.zeros(2)
                s.hits = 1; s.misses = 0; s.merged = False; s.did = None; s.alias = None
            @property
            def confirmed(s): return s.hits >= MIN_HITS
            def predict(s): return s.pos + s.vel
            def update(s, d, f):
                d = np.array(d, float)
                s.vel = VEL_EMA * s.vel + (1 - VEL_EMA) * (d - s.pos)
                s.pos = d; s.hits += 1; s.misses = 0
            def coast(s, f):
                s.misses += 1
        self._Track = Track
        self.tracks = []
        self.nd = 0

    def _live(self):
        return [t for t in self.tracks if not t.merged and t.misses <= self.MAX_LOST]

    def _cost(self, track, pos):
        c = np.hypot(*(track.predict() - np.array(pos)))
        if self.STALE_GATE and track.misses > self.STALE_GATE:
            c += self.STALE_PENALTY
        return c

    def _revive_gate(self, track):
        if self.REVIVE_BASE is None:
            return self.REVIVE_GATE
        return self.REVIVE_BASE + self.REVIVE_DIFFUSION * np.sqrt(track.misses / self.FPS)

    def step(self, f, dets):
        """Process exactly one frame/cycle's dets ([(x, y, ci, cj), ...], as
        produced by build_detector's hybrid_detect). Mutates self.tracks and
        returns this frame's assigns: [(ci, cj, track), ...]."""
        pos = [(d[0], d[1]) for d in dets]
        L = self._live(); mt, md = set(), set(); assigns = []
        if L and dets:
            cm = np.array([[self._cost(L[r], pos[c]) for c in range(len(dets))] for r in range(len(L))])
            for r, c in zip(*linear_sum_assignment(cm)):
                if cm[r, c] <= self.GATE:
                    L[r].update(pos[c], f); mt.add(r); md.add(c); assigns.append((dets[c][2], dets[c][3], L[r]))
        for c in range(len(dets)):
            if c in md:
                continue
            all_cand = [(np.hypot(*(L[r].pos - np.array(pos[c]))), r) for r in range(len(L)) if r not in mt]
            cand = [(x, r) for x, r in all_cand if x <= self._revive_gate(L[r])]
            if cand:
                _, r = min(cand); L[r].update(pos[c], f); mt.add(r); md.add(c); assigns.append((dets[c][2], dets[c][3], L[r])); continue
            if self.gates:
                near = any(np.hypot(pos[c][0] - gx, pos[c][1] - gy) <= self.GATE_RADIUS for gx, gy in self.gates)
                if not near:
                    far_cand = [(x, r) for x, r in all_cand if x <= self.FAR_GATE_REVIVE]
                    if far_cand:
                        _, r = min(far_cand); L[r].update(pos[c], f); mt.add(r); md.add(c)
                        assigns.append((dets[c][2], dets[c][3], L[r])); continue
            if self.DUP_GUARD and any(np.hypot(*(L[r].pos - np.array(pos[c]))) <= self.DUP_GUARD
                                      for r in mt):
                continue
            t = self._Track(pos[c], f); self.tracks.append(t)
            assigns.append((dets[c][2], dets[c][3], t))
        for r, t in enumerate(L):
            if r not in mt:
                t.coast(f)
        conf = sorted([t for t in self.tracks if t.confirmed and not t.merged and t.misses <= self.MAX_COAST],
                      key=lambda t: (t.did if t.did is not None else 1e9))
        for i in range(len(conf)):
            if conf[i].merged:
                continue
            for j in range(i + 1, len(conf)):
                if not conf[j].merged and np.hypot(*(conf[i].pos - conf[j].pos)) < self.MERGE_DIST:
                    conf[j].merged = True; conf[j].alias = conf[i]; conf[i].hits += conf[j].hits
        for t in self.tracks:
            if t.confirmed and not t.merged and t.did is None:
                t.did = self.nd; self.nd += 1
        # PRUNING (delta from architectures/ copy) -- see class docstring.
        self.tracks = [t for t in self.tracks if t.misses <= self.MAX_LOST]
        return assigns

    def active_tracks(self):
        return [t for t in self.tracks if t.confirmed and not t.merged and t.misses <= self.MAX_COAST]


def load_gates(path):
    """features/calibration's gates.json ({"gates": [[wx,wy], ...]}, already
    in world coordinates -- converted from clicked pixels via each camera's
    own Hinv at write time, see features/calibration/api.py's POST /gates)
    -> [[x,y], ...], or [] if no gates have been marked yet. Missing file is
    NOT an error -- gates are an optional accuracy lever (see Tracker's
    gate-guarded branches), a site with none just runs without that prior."""
    p = _pl.Path(path)
    if not p.exists():
        return []
    return json.load(open(p)).get('gates', [])


def bootstrap_site(sources, calibration_path, cams, *, room_trim_pct, foot_sigma_pw,
                   cam_support_min, peak_min, weights_override=None):
    """One-time per-site setup: recover_heads_and_room + build_detector for
    this exact camera set. Effectively instant on file sources, ~30s
    wall-clock on live ones (20 samples * LIVE_CALIB_GAP_S). Raises
    ValueError (not SystemExit/print-only) on any failure so the API can
    report a structured error instead of crashing the background task."""
    cal = load_calibration(calibration_path)
    missing = [c for c in cams if c not in cal]
    if missing:
        raise ValueError(f"camera(s) {missing} have no calibration in {calibration_path}")
    not_aligned = [c for c in cams if not cal[c].get("diag", {}).get("aligned")]
    if not_aligned:
        raise ValueError(f"camera(s) {not_aligned} are calibrated but not aligned to a "
                         f"shared frame -- run POST /calibration/align first")
    metas = {c: video_meta(sources[c]) for c in cams}
    bad = [c for c, m in metas.items() if m is None]
    if bad:
        raise ValueError(f"could not open source(s) for camera(s) {bad}")

    # Sizes come from a REAL FRAME, not from video_meta: the camera table's
    # `quality` setting downscales after the read, so video_meta reports the
    # camera's native size while every frame this pipeline actually sees is
    # smaller. Taking dimensions from metadata and pixels from the frame is
    # how a homography ends up mapping people to a fraction of their true
    # floor position -- silently, looking like a calibration fault.
    img_dims, Hg = {}, {}
    for c in cams:
        probe = read_frame(sources[c], index=None, quality=camera_quality(c))
        if probe is None:
            raise ValueError(f"could not read a frame from camera {c}")
        h, w = probe.shape[:2]
        img_dims[c] = (w, h)
        # ...and the calibration is re-expressed for that size, using the
        # resolution it was fitted at. See calibration/engine.scale_Hinv.
        Hg[c] = scale_Hinv(cal[c]["Hinv"], calibrated_res(cal[c]), probe.shape)

    any_live = any(is_stream(sources[c]) for c in cams)
    if any_live:
        calib_frames = [0] * 20
    else:
        shortest = min(metas[c]["n_frames"] for c in cams)
        calib_frames = np.linspace(shortest * 0.1, shortest * 0.9, 20).astype(int).tolist()

    imgsz = detect_imgsz(img_dims)
    model = get_model(weights_override)
    Hh, room, person_scale, warnings = recover_heads_and_room(
        model, sources, Hg, cams, img_dims, calib_frames, room_trim_pct, imgsz=imgsz,
        cam_support_min=cam_support_min)

    pom_params = dict(POM_PARAMS, FOOT_SIGMA=foot_sigma_pw * person_scale,
                      CAM_SUPPORT_MIN=cam_support_min, PEAK_MIN=peak_min)
    hybrid_detect, _, _, _ = build_detector(Hg, Hh, room, cams, img_dims, pom_params)
    fps = min(metas[c]["fps"] for c in cams) or 25.0

    return dict(hybrid_detect=hybrid_detect, person_scale=person_scale, room=room,
               fps=fps, img_dims=img_dims, cams=cams, warnings=warnings)
