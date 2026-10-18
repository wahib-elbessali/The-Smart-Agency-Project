"""Tunable settings, from features/config.json.

There are exactly three ways anything in this package is configured, and
environment variables are deliberately not one of them:

1. **Fixed** -- file locations (see paths.py). Nothing to configure: the data
   lives beside the code, so the service behaves the same however it is
   launched. An env-var'd path is the classic way to half-configure a
   deployment and not notice.
2. **config.json** -- values you set once for a site: detector confidence,
   image size, poll interval, the wanted-list threshold. Edited on disk,
   read at startup (or on POST /config/reload), visible at GET /config.
3. **An API call** -- values that need changing while it runs: PATCH /config
   (any tunable marked "live" below) and the older PUT /wanted/threshold. A
   live change takes effect on the next detection cycle, with no restart and
   no re-registration of cameras. By default it lasts for the process
   lifetime and config.json remains the durable default; PATCH /config with
   persist=true also writes config.json, and POST /config/reload re-reads it.

config.json may be partial or absent -- anything missing falls back to DEFAULTS
below, so a fresh copy of this package runs with no configuration at all.

Unknown keys are reported rather than ignored: a typo like "confidence" instead
of "conf" would otherwise look like it worked while changing nothing.
"""
import json

from .paths import CONFIG_FILE

# Every tunable, with the value each feature was actually verified at. The
# reasoning behind the non-obvious ones lives in the engine that uses them --
# fire's 1280 and wanted's 0.50 in particular are measured, not preferences.
DEFAULTS = {
    # Which RUNTIME the shared person detector uses (zoning and
    # person_tracking both pull from it). The model is always the same
    # yolo11m_multi.pt -- this only changes what executes it.
    #
    # "auto" picks: cuda -> openvino (Intel GPU) -> ncnn (ARM/Pi) -> pytorch.
    # See common/accelerated_detector.py for the ladder and its measurements
    # (openvino on the Intel iGPU is 2.40x here, identical boxes). Pin it to
    # a specific backend only to reproduce a problem -- a hand-set value is
    # how a deployment ends up on the slow path without anyone noticing.
    "detector": {
        "backend": "auto",   # "auto"|"cuda"|"openvino"|"ncnn"|"pytorch"
    },
    "zoning": {
        "weights": None,          # null -> download the project detector on first use
        "imgsz": 1280,
        "conf": 0.25,
        "update_interval": 2.0,
        # world-mode zones read live positions from person_tracking instead
        # of running their own fusion -- see features/zoning/api.py's
        # docstring. fuse_dist/min_cameras used to live here; the equivalent
        # knobs are now person_tracking's own (gate_pw, cam_support_min, etc).
    },
    "weapon": {"conf": 0.25, "imgsz": 640, "update_interval": 2.0},
    "fire": {"conf": 0.25, "imgsz": 1280, "update_interval": 2.0},   # 1280 is measured, see engine
    "emotion": {"det_size": 640, "update_interval": 2.0},
    "face": {
        # Which InsightFace pack backs face DETECTION and EMBEDDING for
        # /face, /wanted, and (through detect_faces()) /emotion's face step.
        # "buffalo_s" (SCRFD 500M detector + MobileFaceNet, ~120MB) is the
        # CPU/Raspberry-Pi-friendly default this project has used from the
        # start. "buffalo_l" (SCRFD 10G + ResNet50, ~330MB) detects real
        # faces buffalo_s misses -- up close, at an angle, not just distant
        # ones -- at a real compute cost this project's Pi 4 target cannot
        # absorb, which is why it isn't the default here.
        #
        # CROSS-PACK GALLERIES DO NOT MATCH RELIABLY. Both packs emit
        # 512-d embeddings, so nothing crashes if you enroll under one and
        # scan under another -- but the two are DIFFERENT embedding
        # spaces (different recognition networks), and identify() will
        # silently under-match across them. Changing this value means
        # RE-ENROLLING everyone in the gallery, not just restarting.
        "pack": "buffalo_s",
    },
    "wanted": {
        "threshold": 0.50,        # measured open-set operating point, see engine
        "min_face_px": 30,
        "det_size": 640,
        "update_interval": 2.0,
        "confirm_cycles": 2,      # sightings before alerting
        "hold_cycles": 5,         # consecutive misses before the all-clear
    },
    "employee_activity": {
        "poll_interval": 2.0,
        # How long a bound zone must be CONTINUOUSLY empty before a
        # workstation flips to "away" -- see employee_activity/tracker.py.
        # 300s (5 min) is a starting default, not a measured one (unlike
        # e.g. wanted's 0.50 threshold): there is no ground truth yet for
        # what counts as "stepped away" vs "not working" in this project's
        # real deployment. Tune per site.
        "absence_seconds": 300.0,
    },
    "person_tracking": {
        "weights": None,          # null -> shared with zoning, download on first use
        "conf": 0.25,
        "update_interval": 2.0,
        # Every value below mirrors architectures/pom_fusion/generic_pipeline.py's
        # own CLI flags, at their validated defaults -- see that module's
        # constants block for the full derivation of each. All are multiples of
        # this scene's own measured person_scale (or seconds), never absolute
        # units -- see person_tracking/engine.py.
        "gate_pw": 54.2 / 33.09,      # GATE_PW -- primary Hungarian match gate
        "revive_pw": 5.5,             # REVIVE_GATE_PW -- revival match gate
        "dup_guard_pw": 0.85,         # DUP_GUARD_PW -- on by default (largest AssA lever)
        "max_lost_s": 24.0,           # MAX_LOST_S -- seconds a lost track stays revivable
        "stale_gate_s": 0.4,          # STALE_GATE_S -- on by default (paired with revive_pw)
        "room_trim_pct": 1.0,         # percentile trim deriving room extent from bootstrap samples
        "cam_support_min": 2,         # cameras that must agree before reporting a person
        "peak_min": 0.55,             # minimum summed evidence for a detection peak
        "foot_sigma_pw": 24.0 / 33.09,  # FOOT_SIGMA_PW -- foot-position evidence std-dev
        "diffusion_revive": False,    # off -- measured worse on ground truth, see engine.py
    },
}


def _merge(defaults, override, where):
    out = dict(defaults)
    for k, v in override.items():
        if k not in defaults:
            print(f"[config] ignoring unknown key {where}.{k!r} in {CONFIG_FILE.name} "
                  f"-- valid keys: {sorted(defaults)}")
            continue
        if defaults[k] is not None and v is not None and not isinstance(v, type(defaults[k])):
            # int where a float is expected is fine; anything else is a real mistake
            if not (isinstance(defaults[k], float) and isinstance(v, int)):
                raise TypeError(f"{CONFIG_FILE.name}: {where}.{k} should be "
                                f"{type(defaults[k]).__name__}, got {v!r}")
        out[k] = v
    return out


def load():
    """-> the effective config: DEFAULTS with config.json merged over the top."""
    if not CONFIG_FILE.exists():
        return {k: dict(v) for k, v in DEFAULTS.items()}
    raw = json.load(open(CONFIG_FILE, encoding="utf-8"))
    cfg = {}
    for feature, defaults in DEFAULTS.items():
        cfg[feature] = _merge(defaults, raw.get(feature, {}), feature)
    for feature in raw:
        if feature not in DEFAULTS:
            print(f"[config] ignoring unknown section {feature!r} in {CONFIG_FILE.name} "
                  f"-- valid sections: {sorted(DEFAULTS)}")
    return cfg


CONFIG = load()


# --------------------------------------------------------------------------
# Changing config while the service runs
# --------------------------------------------------------------------------
#
# Every key has one of three APPLY modes, because "can it change live" is a
# property of how the engine uses the value, not a preference:
#
#   live        read fresh every detection cycle (or pushed into the running
#               service by a listener) -- takes effect within update_interval.
#   next_start  consumed once when person_tracking next bootstraps the site
#               (camera set changed, or the service restarted) -- stored now,
#               used then.
#   restart     baked in when a model or engine is built: weights, the
#               detector runtime, the face pack, and det_size (the shared
#               InsightFace engine is prepared once at a fixed size, so
#               changing it live would silently do nothing). Accepted only
#               with persist=true, written to config.json, and reported as
#               pending until the service restarts.

import os
import threading

LIVE, NEXT_START, RESTART = "live", "next_start", "restart"

APPLY = {
    "detector": {"backend": RESTART},
    "zoning": {"weights": RESTART, "imgsz": LIVE, "conf": LIVE, "update_interval": LIVE},
    "weapon": {"conf": LIVE, "imgsz": LIVE, "update_interval": LIVE},
    "fire": {"conf": LIVE, "imgsz": LIVE, "update_interval": LIVE},
    "emotion": {"det_size": RESTART, "update_interval": LIVE},
    "face": {"pack": RESTART},
    "wanted": {"threshold": LIVE, "min_face_px": LIVE, "det_size": RESTART,
               "update_interval": LIVE, "confirm_cycles": LIVE, "hold_cycles": LIVE},
    "employee_activity": {"poll_interval": LIVE, "absence_seconds": LIVE},
    "person_tracking": {
        "weights": RESTART, "conf": LIVE, "update_interval": LIVE,
        **{k: NEXT_START for k in ("gate_pw", "revive_pw", "dup_guard_pw", "max_lost_s",
                                   "stale_gate_s", "room_trim_pct", "cam_support_min",
                                   "peak_min", "foot_sigma_pw", "diffusion_revive")},
    },
}

# (min, max, inclusive_min, multiple_of) -- anything not listed only gets the
# type check. Bounds are sanity rails against a typo (conf 25 instead of 0.25),
# not tuning advice.
_CONF = (0.0, 1.0, False, None)
_IMGSZ = (32, 4096, True, 32)
_INTERVAL = (0.05, 3600.0, True, None)
RULES = {
    ("zoning", "conf"): _CONF, ("weapon", "conf"): _CONF, ("fire", "conf"): _CONF,
    ("person_tracking", "conf"): _CONF,
    ("zoning", "imgsz"): _IMGSZ, ("weapon", "imgsz"): _IMGSZ, ("fire", "imgsz"): _IMGSZ,
    ("zoning", "update_interval"): _INTERVAL, ("weapon", "update_interval"): _INTERVAL,
    ("fire", "update_interval"): _INTERVAL, ("emotion", "update_interval"): _INTERVAL,
    ("wanted", "update_interval"): _INTERVAL, ("person_tracking", "update_interval"): _INTERVAL,
    ("employee_activity", "poll_interval"): _INTERVAL,
    ("employee_activity", "absence_seconds"): (1.0, 86400.0 * 7, True, None),
    ("wanted", "min_face_px"): (16, 1000, True, None),
    ("wanted", "confirm_cycles"): (1, 100, True, None),
    ("wanted", "hold_cycles"): (0, 1000, True, None),
    ("person_tracking", "cam_support_min"): (1, 64, True, None),
}

_lock = threading.RLock()
_listeners = {}        # (feature, key) -> [callback(value)]
_validators = {}       # (feature, key) -> [fn(value) -> error message | None]
_startup = {f: dict(v) for f, v in CONFIG.items()}   # what the file/defaults said at boot
_pending_restart = {}  # {feature: {key: value}} written to disk, not yet running


class ConfigError(ValueError):
    """Every problem with a requested change, so one call reports them all."""

    def __init__(self, errors):
        super().__init__("; ".join(errors))
        self.errors = errors


def on_change(feature, key, callback):
    """Run callback(new_value) whenever a live key changes -- how a value that
    was copied into a running object (an update interval, the wanted-list
    threshold) follows config. Reads of CONFIG[feature][key] need no listener."""
    _listeners.setdefault((feature, key), []).append(callback)


def add_validator(feature, key, fn):
    """fn(value) -> an error string, or None if fine. For rules that belong to
    one feature (wanted's accusation-rate floor), not to this module."""
    _validators.setdefault((feature, key), []).append(fn)


def _check_type(feature, key, value):
    default = DEFAULTS[feature][key]
    if value is None:
        return None if default is None else f"{feature}.{key} cannot be null"
    if default is None:
        return None   # nullable weights path: restart-only anyway
    if isinstance(value, bool) != isinstance(default, bool):
        return f"{feature}.{key} should be {type(default).__name__}, got {value!r}"
    if isinstance(default, bool):
        return None
    if isinstance(default, float) and isinstance(value, (int, float)):
        return None
    if not isinstance(value, type(default)):
        return f"{feature}.{key} should be {type(default).__name__}, got {value!r}"
    return None


def _check_value(feature, key, value):
    error = _check_type(feature, key, value)
    if error:
        return error
    rule = RULES.get((feature, key))
    if rule is not None:
        lo, hi, inclusive, multiple = rule
        if value < lo or (value == lo and not inclusive) or value > hi:
            bracket = "[" if inclusive else "("
            return f"{feature}.{key} must be in {bracket}{lo}, {hi}], got {value!r}"
        if multiple and value % multiple:
            return f"{feature}.{key} must be a multiple of {multiple}, got {value!r}"
    for fn in _validators.get((feature, key), []):
        message = fn(value)
        if message:
            return message
    return None


def _write_file(changes):
    """Merge `changes` into config.json and replace it atomically, so a crash
    mid-write cannot leave a half-file that stops the next start."""
    raw = {}
    if CONFIG_FILE.exists():
        raw = json.load(open(CONFIG_FILE, encoding="utf-8"))
    for feature, values in changes.items():
        raw.setdefault(feature, {}).update(values)
    tmp = CONFIG_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(raw, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, CONFIG_FILE)


def apply_changes(changes, persist=False, restart_keys_pending=False):
    """Validate every requested change, then apply them all or none.

    changes: {"weapon": {"conf": 0.4}, ...}. Returns {"applied", "pending_restart",
    "previous", "persisted"}: applied = live/next_start keys now in effect;
    pending_restart = restart keys written to config.json but not yet running.
    Raises ConfigError listing every problem. A restart-mode key without
    persist=true is an error (it would change nothing), unless
    restart_keys_pending (reload from file, where the file already holds it)."""
    if not isinstance(changes, dict) or not changes:
        raise ConfigError(['body must be {"<feature>": {"<key>": value}} with at least one change'])
    errors, live, pending = [], {}, {}
    for feature, values in changes.items():
        if feature not in DEFAULTS:
            errors.append(f"unknown section {feature!r} -- valid sections: {sorted(DEFAULTS)}")
            continue
        if not isinstance(values, dict) or not values:
            errors.append(f"{feature} must be an object of key: value")
            continue
        for key, value in values.items():
            if key not in DEFAULTS[feature]:
                errors.append(f"unknown key {feature}.{key!r} -- valid keys: {sorted(DEFAULTS[feature])}")
                continue
            error = _check_value(feature, key, value)
            if error:
                errors.append(error)
                continue
            if APPLY[feature][key] == RESTART:
                if not (persist or restart_keys_pending):
                    errors.append(f"{feature}.{key} only changes on restart; send persist=true to "
                                  f"write it to config.json for the next start")
                    continue
                pending.setdefault(feature, {})[key] = value
            else:
                live.setdefault(feature, {})[key] = value
    if errors:
        raise ConfigError(errors)

    with _lock:
        if persist:
            _write_file({f: {**live.get(f, {}), **pending.get(f, {})}
                         for f in set(live) | set(pending)})
        previous, applied, listener_errors = {}, {}, []
        for feature, values in live.items():
            for key, value in values.items():
                previous.setdefault(feature, {})[key] = CONFIG[feature][key]
                CONFIG[feature][key] = value
                applied.setdefault(feature, {})[key] = {"value": value, "mode": APPLY[feature][key]}
                for callback in _listeners.get((feature, key), []):
                    try:
                        callback(value)
                    except Exception as exc:   # a listener must never undo a valid change
                        listener_errors.append(f"{feature}.{key}: {exc}")
        for feature, values in pending.items():
            _pending_restart.setdefault(feature, {}).update(values)
    result = {"applied": applied, "pending_restart": pending, "previous": previous,
              "persisted": bool(persist)}
    if listener_errors:
        result["warnings"] = listener_errors
    return result


def reload_from_file():
    """Re-read config.json and apply whatever differs from what is running.
    Live keys take effect now; restart keys are reported as pending. Atomic: a
    bad value anywhere in the file applies nothing."""
    empty = {"applied": {}, "pending_restart": {}, "previous": {}, "persisted": False}
    if not CONFIG_FILE.exists():
        return empty
    raw = json.load(open(CONFIG_FILE, encoding="utf-8"))
    diff = {}
    for feature, values in raw.items():
        if feature not in DEFAULTS or not isinstance(values, dict):
            continue
        for key, value in values.items():
            if key in DEFAULTS[feature] and value != CONFIG[feature][key]:
                diff.setdefault(feature, {})[key] = value
    if not diff:
        return empty
    return apply_changes(diff, persist=False, restart_keys_pending=True)


def describe():
    """What GET /config returns beyond the values themselves."""
    return {
        "apply_modes": APPLY,
        "startup_config": _startup,
        "pending_restart": {f: dict(v) for f, v in _pending_restart.items()},
    }
