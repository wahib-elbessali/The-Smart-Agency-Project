"""Deployable surface over zones.py. A real frontend owns the interactive
part (showing a camera image, letting someone click polygon corners --
reference_ui/zoning/zone_app.py is a reference implementation of that
interaction, not the deployed one); this API only ever receives a COMPLETE
polygon per call.

Mounted at /zoning by the unified app in features/main.py.

- GET       /zoning/zones    -- every current zone (mode/camera/polygon).
- POST      /zoning/zones     -- {"name", "camera", "polygon": [[px,py],...],
                                  "sources": {cam: url_or_path, ...}} (>=3
                                  polygon points). `camera` is the camera the
                                  polygon was DRAWN on and must be one of
                                  `sources`. The zone's MODE is inferred from
                                  how many cameras `sources` carries: one ->
                                  pixel zone (that camera's own detections, no
                                  calibration needed), two or more -> world
                                  zone (converted to floor metres via
                                  `camera`'s calibration, counted against
                                  features/person_tracking's LIVE tracked
                                  positions -- see the route docstring and
                                  _world_positions() below). `sources` is
                                  also how this deployment learns where to
                                  pull a PIXEL camera's live feed from
                                  (calibration only gives pixel<->floor math,
                                  never a feed address) -- merged into the
                                  site-wide camera registry, keyed by camera
                                  id, so it accumulates across every zone
                                  ever created, not just this one. A world
                                  zone's own cameras are registered here too
                                  (for the `camera`/Hinv lookup and response
                                  bookkeeping) but this module no longer
                                  reads live frames for them itself -- only
                                  cameras referenced by a PIXEL zone are ever
                                  actually read, see _run_pixel_cycle().
- DELETE    /zoning/zones/{name}      -- removes one zone entirely.
- WebSocket /zoning/occupancy/stream  -- live per-zone occupancy, pushed only when
                                  a zone's count actually CHANGES, OR (world
                                  zones only) when /people's running-ness
                                  changes -- not a fixed heartbeat. Optional
                                  `?threshold=N` query param: only bother this
                                  connection once a zone's count is >= N
                                  (still tells it when a zone drops back
                                  below, so its view never goes stale). See
                                  the docstring on that route.

The frontend gets its clickable camera image from the app-level GET /frame and
GET /video_meta, shared by every feature rather than duplicated here.

WORLD-MODE ZONES ARE COUPLED TO /people, NOT INDEPENDENTLY DETECTED. This
module used to run its own second person-detector + nearest-position fusion
(fuse_camera_boxes) for world zones -- two independent person-detection
pipelines watching the same cameras, pure redundant compute, and this
module's own fusion was strictly weaker than /people's POM-based one anyway
(real silhouette+foot evidence, a duplicate guard, identity-aware revival).
A world-mode zone now REQUIRES features/person_tracking to be `running`
(POST /people/sources with the same camera(s), confirm via GET
/people/status) -- if it isn't, the zone counts 0 but the occupancy stream's
`people_tracking_ready: false` field says so explicitly, rather than that 0
being silently indistinguishable from "genuinely empty" (see
_world_positions()'s docstring). PIXEL-mode zones are completely unaffected
-- no calibration, no /people dependency, this module still runs its own
lightweight single-camera detection for those.

Detection runs CONTINUOUSLY in the background once at least one zone exists
-- there is no on-demand "give me occupancy right now" endpoint anymore (an
earlier version had a blocking POST /occupancy; replaced entirely by the
WebSocket, per the same "one way to do a job" reasoning used everywhere else
in this project -- a backend just connects to the stream and gets pushed
updates, or doesn't connect and the detection loop runs regardless).
Tunables live in features/config.json under "zoning": weights, imgsz, conf,
update_interval (default 2.0s -- responsive enough for a live queue display
without pinning the CPU continuously on the Pi 4 deployment target; `fuse_dist`
and `min_cameras` were removed from here when world-mode zones stopped doing
their own fusion -- see features/person_tracking's own tunables for the
equivalent knobs on the pipeline that now does that work). Zones and
calibration are read from and written to features/data/, a fixed location --
see paths.py.
"""
import asyncio
import threading
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from ..common.video_source import read_frame
from ..common import cameras as registry
from ..common.cameras import quality as camera_quality
from ..common.person_detector import get_model
from ..calibration.engine import load_calibration
from ..config import CONFIG
from ..paths import CALIBRATION, ZONES
from ..person_tracking.api import get_active_tracks
from .zones import (
    add_pixel_zone, add_world_zone, load_zones, occupancy, pixel_to_world_m, remove_zone,
    save_zones, zones_to_dict,
)

_CFG = CONFIG["zoning"]
# imgsz, conf and update_interval are read from _CFG at use time (PATCH /config changes them live)

# The person detector -- shared with features/person_tracking, which uses the
# SAME fine-tuned checkpoint (see common/person_detector.py: loading it twice
# would mean two ~120MB+ in-process copies on the Raspberry Pi 4 deployment
# target). Set config.json's zoning.weights to a local path to skip the
# download.
WEIGHTS = _CFG["weights"]                      # null -> download on first use

_zones = load_zones(ZONES) if ZONES.exists() else {}
_zones_lock = threading.Lock()

# Cameras come from the site table (common/cameras.py), not a private dict
# -- see person_tracking/api.py for the same change and why.

_last_counts = {}        # {zone_name: {"count", "points"}} -- last state PUSHED, for change detection
_ws_clients = {}         # {WebSocket: threshold} -- only ever touched from the event loop


def _run_pixel_cycle(zones_snapshot):
    """Synchronous, CPU-bound -- ONE live frame per camera referenced by a
    PIXEL-mode zone (and ONLY those cameras -- derived from the zones
    themselves, not every camera in the table, so a camera registered
    only for /people or another feature is never needlessly read here), run
    through detection -> {cam: [(x1,y1,x2,y2), ...]}. Run inside
    asyncio.to_thread() by the background loop so it never blocks the event
    loop/WebSocket traffic while YOLO is working.

    World-mode zones no longer run any detection of their own at all -- see
    _world_positions() and this module's docstring for why."""
    pixel_cams = {z["camera"] for z in zones_snapshot.values() if z["mode"] == "pixel"}
    if not pixel_cams:
        return {}
    sources_snapshot = registry.for_feature("zoning")
    imgs = {}
    for cam in pixel_cams:
        source = sources_snapshot.get(cam)
        if source is None:
            continue
        frame = read_frame(source, quality=camera_quality(cam))
        if frame is not None:
            imgs[cam] = frame
    if not imgs:
        return {}

    model = get_model(WEIGHTS)
    results = model.predict(list(imgs.values()), imgsz=_CFG["imgsz"], conf=_CFG["conf"], classes=[0], verbose=False)
    raw_boxes_by_cam = {}
    for cam, r in zip(imgs, results):
        b = r.boxes
        raw_boxes_by_cam[cam] = ([tuple(map(float, x)) for x in b.xyxy.cpu().numpy()]
                                  if b is not None and len(b) else [])
    return raw_boxes_by_cam


def _world_positions():
    """-> (fused_positions, people_tracking_ready). World-mode zones are
    counted against /people's OWN live tracked positions instead of running
    an independent detector here -- two person-detection pipelines watching
    the same cameras was pure waste, and /people's POM-based fusion (real
    silhouette+foot evidence, a duplicate guard, identity-aware revival) is
    strictly better than this module's old nearest-position fuse_camera_boxes
    anyway. Both read the SAME features/data/site_calibration.json, so the
    coordinate frame always agrees regardless of exactly which camera subset
    a given zone's own `sources` happens to list.

    people_tracking_ready=False means /people isn't currently running
    (idle/bootstrapping/error) -- the caller must NOT treat that the same as
    "genuinely zero people", the exact silent-zero trap this project keeps
    guarding against elsewhere (see post_zone's own `camera not in sources`
    check). A world-mode zone now REQUIRES /people to be tracking the same
    site: POST /people/sources with the same cameras, then check
    GET /people/status."""
    tracks = get_active_tracks()
    if tracks is None:
        return [], False
    return [(t["x"], t["y"]) for t in tracks], True


async def _broadcast_update(zone_name, new_state, old_count):
    """Sends to each connected client UNLESS both the old and new count are
    below that client's own threshold (a connection with ?threshold=3 never
    hears about a zone bouncing between 0 and 2). A transition INTO the
    threshold (old < N <= new) or OUT of it (new < N <= old) is always sent
    -- otherwise a client's last-known state for a zone would go stale the
    moment it drops back below their threshold and just never update again."""
    dead = []
    for ws, threshold in list(_ws_clients.items()):
        if new_state["count"] < threshold and old_count < threshold:
            continue
        try:
            await ws.send_json({"type": "update", "zone": zone_name, **new_state})
        except Exception:
            dead.append(ws)
    for ws in dead:
        _ws_clients.pop(ws, None)


async def _background_loop():
    while True:
        with _zones_lock:
            zones_snapshot = dict(_zones)
        has_pixel = any(z["mode"] == "pixel" for z in zones_snapshot.values())
        has_world = any(z["mode"] == "world" for z in zones_snapshot.values())
        if zones_snapshot and (has_pixel or has_world):
            try:
                raw_boxes_by_cam = (await asyncio.to_thread(_run_pixel_cycle, zones_snapshot)
                                    if has_pixel else {})
                # _world_positions() is a plain in-process function call (no I/O,
                # no model inference -- it just reads /people's already-computed
                # state), so it doesn't need asyncio.to_thread the way the pixel
                # cycle's YOLO call does.
                fused_positions, people_ready = _world_positions() if has_world else ([], True)
                occ = occupancy(fused_positions, raw_boxes_by_cam, zones_snapshot)
                for name, pts in occ.items():
                    z_ready = people_ready if zones_snapshot[name]["mode"] == "world" else True
                    new_state = {"count": len(pts), "points": [[round(x, 1), round(y, 1)] for x, y in pts],
                                 "people_tracking_ready": z_ready}
                    old = _last_counts.get(name, {})
                    old_count = old.get("count", 0)
                    # Recorded EVERY cycle, not just on change: a zone that's
                    # genuinely always empty (count stays 0 forever) used to never
                    # get an entry here at all, making it indistinguishable from a
                    # zone that doesn't exist / has never been read once -- the
                    # exact silent-zero trap this module guards against everywhere
                    # else (see people_tracking_ready above). get_zone_count() and
                    # a fresh WebSocket snapshot both depend on this being current
                    # even when nothing changed.
                    _last_counts[name] = new_state
                    # A ready<->not-ready flip also triggers a push, even if the
                    # count itself is unchanged (e.g. both are "0") -- otherwise
                    # a world zone stuck at 0 because /people isn't running yet
                    # is silently indistinguishable from a zone that's genuinely
                    # always empty, which is exactly the failure mode this field
                    # exists to prevent.
                    if old_count != new_state["count"] or old.get("people_tracking_ready", True) != z_ready:
                        await _broadcast_update(name, new_state, old_count)
            except Exception as e:
                print(f"[zoning.api] background detection cycle failed: {e}")
        await asyncio.sleep(_CFG["update_interval"])


@asynccontextmanager
async def lifespan():
    task = asyncio.create_task(_background_loop())
    yield
    task.cancel()


router = APIRouter(prefix="/zoning", tags=["zoning"])


def zone_names():
    """-> the set of currently-defined zone names. For another feature (e.g.
    features/employee_activity) validating a zone reference before binding
    to it, without needing this module's full zone/polygon detail."""
    with _zones_lock:
        return set(_zones)


def get_zone_count(name):
    """-> the last-computed {"count", "points", "people_tracking_ready"} for
    zone `name`, or None if that zone doesn't exist or hasn't been read even
    once yet by the background loop. Lets another in-process feature (e.g.
    features/employee_activity) reuse zoning's already-computed occupancy
    instead of re-running detection -- the same reuse-an-existing-primitive
    pattern zoning itself uses for world zones via /people's
    get_active_tracks(). Relies on _background_loop recording every cycle
    unconditionally (not just on change), see its own comment."""
    return _last_counts.get(name)


@router.get("/zones")
def get_zones():
    with _zones_lock:
        return zones_to_dict(_zones)


class ZoneRequest(BaseModel):
    name: str
    camera: str                          # the camera the polygon was DRAWN on
    polygon: list[list[float]]           # [[px, py], ...], >= 3 points, in `camera`'s pixel space
    sources: dict[str, str] = {}         # {camera_id: url_or_path} -- merged into the site registry


def _to_world(name, camera, polygon_px):
    """Converts a just-drawn pixel polygon into a world-metre one via `camera`'s
    calibration. -> (polygon_m, converted_from). Raises HTTPException(422) rather
    than producing a plausible-but-wrong zone.

    Refusing on an UNALIGNED camera is the important part: its calibration maps
    pixels into a coordinate frame that camera invented for itself, not one
    shared with the other cameras being fused. The resulting zone looks exactly
    as valid as a correct one and only reveals itself when fused counts come out
    quietly wrong."""
    cal = load_calibration(CALIBRATION)
    if camera not in cal:
        raise HTTPException(422, f"camera {camera!r} has no calibration in {CALIBRATION.name} -- "
                                 f"a world zone is a FLOOR-metre polygon, so the camera it was drawn "
                                 f"on must be calibrated first (POST /calibration/rect)")
    # NOTE "diag", not "diagnostics": load_calibration() renames the on-disk key
    # (features/calibration/engine.py). Reading "diagnostics" here would always be
    # missing -> always refuse, including for correctly-aligned cameras.
    if not cal[camera].get("diag", {}).get("aligned"):
        raise HTTPException(422, f"camera {camera!r} is calibrated but NOT aligned to a shared frame "
                                 f"-- converting through it would anchor this zone to camera "
                                 f"{camera}'s own invented coordinate frame, which looks valid but "
                                 f"makes fused counts silently wrong. Run POST /calibration/align "
                                 f"first (then /calibration/cross_check to confirm it took)")
    polygon_m = pixel_to_world_m(polygon_px, cal[camera]["Hinv"])
    return ([[round(float(x), 4), round(float(y), 4)] for x, y in polygon_m],
            dict(camera=camera, polygon_px=[[float(x), float(y)] for x, y in polygon_px]))


@router.post("/zones")
def post_zone(req: ZoneRequest):
    """The zone's MODE is inferred from how many cameras `sources` carries:

      1 camera  -> PIXEL zone: the polygon is checked against that one camera's
                   own raw detections. No calibration needed at all.
      2+        -> WORLD zone: the polygon is converted to floor metres via
                   `camera`'s calibration and checked against
                   features/person_tracking's LIVE tracked positions, so it
                   isn't tied to any single view. This REQUIRES /people to be
                   running (POST /people/sources, then GET /people/status)
                   -- see this module's docstring for why zoning no longer
                   runs its own multi-camera fusion.

    `camera` says which camera's image the polygon was actually drawn on, and it
    MUST be one of `sources`. Without that check you can draw on one camera and
    register another: the zone saves happily and then reads 0 forever, because
    the detection loop looks up raw_boxes_by_cam[zone["camera"]] and that camera
    is never read. Silent permanent-zero is the worst failure mode here, so it's
    a 422 at the moment of the mistake instead.

    To create a PIXEL zone on a multi-camera site, send just that one camera in
    `sources` -- the registry accumulates across calls, so registering cameras
    one request at a time costs nothing."""
    name = req.name.strip()
    if not name:
        raise HTTPException(422, "empty zone name")
    if req.camera not in req.sources:
        raise HTTPException(422, f"the polygon was drawn on camera {req.camera!r}, but `sources` "
                                 f"only carries {sorted(req.sources)} -- send that camera's feed "
                                 f"too, otherwise this zone can never be read")

    warnings = []
    world = len(req.sources) > 1
    if world:
        polygon_m, converted_from = _to_world(name, req.camera, req.polygon)

    with _zones_lock:
        try:
            if world:
                add_world_zone(_zones, name, polygon_m, converted_from=converted_from)
            else:
                add_pixel_zone(_zones, name, req.camera, req.polygon)
        except ValueError as e:
            raise HTTPException(422, str(e))
        save_zones(_zones, ZONES)
    # Re-posting a name (especially switching its mode) leaves a cached count
    # from a different measurement entirely -- pixel foot-points vs fused floor
    # positions -- which would suppress or fabricate the next change broadcast.
    _last_counts.pop(name, None)

    for cam, url in req.sources.items():
        registry.upsert(cam, url=url)
        registry.assign(cam, "zoning", True)
    known = sorted(registry.for_feature("zoning"))

    if world:
        # A world zone is counted against /people's OWN live tracked
        # positions now (see _world_positions()), not an independent fusion
        # step here -- so the thing worth warning about is whether /people is
        # actually running, not camera-calibration counts (that's /people's
        # own bootstrap concern, reported via GET /people/status).
        if get_active_tracks() is None:
            warnings.append("`/people` is not currently running (idle/bootstrapping/error) -- "
                            "this zone will count 0 until it is. POST /people/sources with the "
                            "same camera(s), then check GET /people/status.")

    out = {"name": name, "mode": "world" if world else "pixel", "saved": str(ZONES),
           "sources_known": known, "warnings": warnings}
    if world:
        out["polygon_m"] = polygon_m
        out["converted_from"] = converted_from
    return out


@router.delete("/zones/{name}")
def delete_zone(name: str):
    with _zones_lock:
        try:
            remove_zone(_zones, name)
        except KeyError:
            raise HTTPException(404, f"no such zone: {name!r}")
        save_zones(_zones, ZONES)
    _last_counts.pop(name, None)
    return {"name": name, "deleted": True}


@router.websocket("/occupancy/stream")
async def occupancy_stream(ws: WebSocket, threshold: int = 0):
    """Server push only, change-triggered: connect and you immediately get
    the current known state of every zone at/above `threshold` (a
    `{"type": "snapshot", ...}` message), then one `{"type": "update",
    "zone", "count", "points", "people_tracking_ready"}` message each time a
    zone's count crosses that threshold in either direction, changes while
    already above it, or (world zones only) `people_tracking_ready` flips --
    not a fixed-interval heartbeat, and not every reading regardless of
    relevance. `people_tracking_ready` is always `true` for a pixel zone;
    for a world zone it reflects whether features/person_tracking is
    currently `running` -- `false` means this zone's `count: 0` means
    "/people isn't tracking yet", NOT "genuinely empty", and pushing on that
    transition (not just on count) is what keeps the two distinguishable
    instead of both looking like a silent, unexplained zero. `?threshold=3`
    (default 0, i.e. every change) means "only bother me once 3+ people are
    in a zone" -- but you'll still get told when it drops back below, so
    your last-known state never goes stale. The backend can connect,
    disconnect, and reconnect at will; the background detection loop keeps
    running either way."""
    await ws.accept()
    _ws_clients[ws] = threshold
    try:
        snapshot = {name: state for name, state in _last_counts.items() if state["count"] >= threshold}
        await ws.send_json({"type": "snapshot", "zones": snapshot})
        while True:
            # bare receive() returns a dict and does NOT raise on disconnect --
            # only receive_text()/receive_json() do that. Must check the type
            # and break manually, otherwise the next receive() call after a
            # disconnect hits Starlette's "cannot call receive() again" RuntimeError.
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.pop(ws, None)
