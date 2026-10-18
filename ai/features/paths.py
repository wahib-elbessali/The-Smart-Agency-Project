"""Every path this package uses, fixed relative to THIS folder.

Nothing here is configurable, on purpose. These locations used to be
CWD-relative or environment-overridable, which meant the service's data lived
wherever it happened to be launched from -- and the failure was silent: start it
in the wrong directory and it comes up with zero zones, serving happily, looking
exactly like "nobody is in any zone". Pinning everything beside the code makes
the service behave the same however it is started (shell, systemd, Docker), and
makes the whole folder copyable as one unit.

    features/
      config.json     <- tunables (see config.py)
      models/         <- weights, downloaded on first use
      data/           <- runtime state: zones, calibration, galleries

`data/` is where everything the service WRITES goes. Two of its files are
biometric data tied to named real people and must never be committed -- the
repo's .gitignore covers them by the `*_gallery.json` glob; keep an equivalent
rule if this package is copied into another repo.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent                  # = features/

MODELS = ROOT / "models"                                # weights, auto-downloaded
DATA = ROOT / "data"                                    # everything the service writes
CONFIG_FILE = ROOT / "config.json"

ZONES = DATA / "zones.json"                             # authored floor polygons
CALIBRATION = DATA / "site_calibration.json"            # per-camera homographies
GATES = DATA / "gates.json"                             # entry/exit points, world coords -- /people's revival prior
FACE_GALLERY = DATA / "face_gallery.json"               # enrolled employees   (biometric)
WANTED_GALLERY = DATA / "wanted_gallery.json"           # watchlist            (biometric)
EMPLOYEE_ACTIVITY = DATA / "employee_activity.json"     # workstation name -> zoning zone name

DATA.mkdir(parents=True, exist_ok=True)
