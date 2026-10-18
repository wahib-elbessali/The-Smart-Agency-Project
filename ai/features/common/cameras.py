"""The site's camera table -- one place that knows what cameras exist.

Before this, every feature kept its own `{cam: url}` dict in memory. Six
copies of the same list, none of them written down, all of them gone on
restart -- so a deployment came back up with every feature watching
nothing, which looks exactly like "nobody is in any zone". Cameras are now
defined once, here, and each feature selects from that table.

    {
      "cameras": {
        "0": {"name": "Entrance", "url": "rtsp://...",
              "quality": 1.0, "features": ["people", "zoning"]}
      }
    }

QUALITY is a fraction of the camera's native resolution: 1.0 = full, 0.5 =
half in each dimension (a quarter of the pixels). It is per camera, so one
camera is decoded at one size and every feature sees the same frame.

WHY QUALITY CANNOT BREAK CALIBRATION. A calibration is a homography from
PIXELS to the floor. Halve the frame and every pixel coordinate halves, so
the same homography maps people to the wrong place on the floor -- silently,
with no error, looking exactly like a bad calibration. (This project has
been sent chasing a "calibration problem" that was nothing of the kind more
than once.)

The fix is not to trust this file's `quality` number. It is to record what
resolution the calibration was FITTED at, then compare against the frame
actually in hand and scale the homography by the real ratio -- see
calibration/engine.py's scale_Hinv. That self-corrects for anything that
changes frame size: this setting, a swapped camera, a stream that
renegotiates. Trusting the config would only handle the one case we thought
of.
"""
import json
import threading

from ..paths import DATA

CAMERAS_FILE = DATA / "cameras.json"

# Feature keys a camera can be assigned to. Names match each feature's URL
# prefix so the table reads the same as the API.
FEATURES = ("people", "zoning", "weapon", "fire", "emotion", "wanted")

_lock = threading.Lock()


def _read():
    if not CAMERAS_FILE.exists():
        return {}
    try:
        return json.load(open(CAMERAS_FILE, encoding="utf-8")).get("cameras", {})
    except Exception as e:
        # Loud, and empty -- never a half-parsed table that silently drops
        # half the site's cameras.
        print(f"[cameras] {CAMERAS_FILE.name} is unreadable ({e}) -- treating as empty")
        return {}


def _write(cams):
    CAMERAS_FILE.parent.mkdir(parents=True, exist_ok=True)
    json.dump({"cameras": cams}, open(CAMERAS_FILE, "w", encoding="utf-8"), indent=2)


def all_cameras():
    """-> {cam_id: entry}. Read from disk each time; the table is small and
    an operator editing the file should not need a restart."""
    with _lock:
        return _read()


def get(cam_id):
    return all_cameras().get(str(cam_id))


def upsert(cam_id, *, url=None, name=None, quality=None, features=None):
    """Create or update one camera. Only the fields given are touched, so a
    quality change does not silently clear the feature assignments."""
    cam_id = str(cam_id)
    with _lock:
        cams = _read()
        entry = cams.get(cam_id, {"name": cam_id, "url": None,
                                  "quality": 1.0, "features": []})
        if url is not None:
            entry["url"] = url
        if name is not None:
            entry["name"] = name
        if quality is not None:
            q = float(quality)
            if not 0.05 <= q <= 1.0:
                raise ValueError(f"quality must be between 0.05 and 1.0, got {q}")
            entry["quality"] = q
        if features is not None:
            bad = sorted(set(features) - set(FEATURES))
            if bad:
                raise ValueError(f"unknown feature(s) {bad} -- valid: {list(FEATURES)}")
            entry["features"] = sorted(set(features))
        cams[cam_id] = entry
        _write(cams)
        return entry


def assign(cam_id, feature, on=True):
    """Add/remove one feature from one camera, leaving the rest alone."""
    entry = get(cam_id) or upsert(cam_id)
    feats = set(entry.get("features", []))
    feats.add(feature) if on else feats.discard(feature)
    return upsert(cam_id, features=sorted(feats))


def remove(cam_id):
    with _lock:
        cams = _read()
        gone = cams.pop(str(cam_id), None)
        if gone is not None:
            _write(cams)
        return gone is not None


def for_feature(feature):
    """-> {cam_id: url} for the cameras assigned to this feature.

    Cameras with no url are skipped: an entry that exists but was never
    given a source is a half-finished row in the table, and handing it to a
    detector would just fail per cycle."""
    return {c: e["url"] for c, e in all_cameras().items()
            if feature in e.get("features", []) and e.get("url")}


def quality(cam_id):
    entry = get(cam_id)
    return float(entry.get("quality", 1.0)) if entry else 1.0
