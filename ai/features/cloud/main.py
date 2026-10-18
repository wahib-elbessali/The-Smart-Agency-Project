"""The same service, with EVERY model on a cloud GPU.

    uvicorn features.main:app        --port 8000     # local models
    uvicorn features.cloud.main:app  --port 8000     # remote models, same API

Every route, payload and response is IDENTICAL to features/ -- because they
are literally the same route objects. This module does not reimplement,
copy, or wrap any endpoint. It installs remote backends for every model
this project runs, then serves features/'s own app.

WHY THIS ISN'T A COPY OF features/'s OTHER MODULES
----------------------------------------------------
The obvious way to build "the same service but cloud" is to duplicate the
folder and change one file. It is also the way the two drift: every future
fix has to be found and applied twice, and nothing fails when someone
forgets. So the difference is expressed where the difference actually is --
how each model is obtained -- through hooks the individual engines expose
for exactly this (mirroring features/common/person_detector.py's
set_model_factory). features/'s other modules still import nothing outside
themselves and do not know this subpackage exists; only main.py here reaches
up into them to install the hooks before serving the shared app object.

WHAT MOVES, AND WHAT DOESN'T
------------------------------
Every model moves: the shared person detector (yolo11m_multi, used by
`/zoning` and `/people`), weapon, fire, and InsightFace's face detector+
embedder (used by `/face`, and through it `/emotion` and `/wanted`).

Two things do NOT move, on purpose:

  * hsemotion (emotion CLASSIFICATION) -- it runs on a face crop the local
    process already has once InsightFace has found a face, is tiny
    (~16MB), and a network round trip for it would buy nothing. See
    molab_bridge/molab_notebook.py's module docstring.
  * Gallery matching (identify(), in /face and /wanted) -- comparing an
    embedding against NAMED real people's stored data must never touch the
    network, full stop. Only the embedding EXTRACTION moves; the
    comparison against biometric identities stays local, always.

Track identity is the other thing that never moves regardless of what else
does: POM fusion and the tracker stay local, because molab sessions are
ephemeral and a reconnect would silently renumber everyone. See
molab_bridge/molab_notebook.py for the full argument.

ONE EXTRA ROUTE, on top of features/'s surface: GET /detector, so "which
backend is this?" has a definite answer from the outside, for every model.
Nothing existing is renamed, removed or reshaped.
"""
from ..common.person_detector import get_model as get_person_model
from ..common.person_detector import set_model_factory
from ..face_recognition.engine import set_faces_override
from ..fire_detection import engine as fire_engine
from ..weapon_detection import engine as weapon_engine

from .remote_model import RemoteFaceDetector, RemoteYOLO, load_config, remote_detect_faces

CONFIG = load_config()

# Installed BEFORE features.main is imported below, so no feature's startup
# can obtain a local model first. Each get_model()/detect_faces() consults
# its hook at call time, so ordering here is belt-and-braces rather than
# load-bearing -- but the cost of being wrong is a service that quietly
# runs a local model while claiming to be the cloud one, which is worth
# being careful about.
set_model_factory(lambda weights_override: RemoteYOLO("person", weights_override))
weapon_engine.set_model_factory(lambda: RemoteYOLO("weapon"))
fire_engine.set_model_factory(lambda: RemoteYOLO("fire"))
set_faces_override(remote_detect_faces)

from ..main import app  # noqa: E402  (must follow the hooks above)

app.title = "smartAgencyAI (cloud models)"

# wanted_detection's startup warms the local InsightFace pack via get_engine().
# Faces are served remotely here (set_faces_override above), so that load is
# dead weight and fails outright on a Pi without insightface installed.
from ..wanted_detection import api as _wanted_api  # noqa: E402

_wanted_api.get_engine = lambda *args, **kwargs: None


@app.get("/detector", tags=["meta"])
def detector():
    """Which backend is actually serving each model, and is it reachable.

    This route exists ONLY on the cloud app, deliberately: its absence on
    features/ is itself the answer for that one. A config flag would have
    been the alternative, and a config flag can disagree with reality --
    this cannot.

    A model reporting `connected: false` (or an `error`) means every call
    to it will FAIL rather than return an empty result -- that is the
    intended behaviour; check here first when any feature reports an
    error state.
    """
    models = {}
    for name, get in (("person", lambda: get_person_model(None)),
                      ("weapon", weapon_engine.get_model),
                      ("fire", fire_engine.get_model)):
        try:
            model = get()
            models[name] = {"weights": model.weights, **model.status()}
        except Exception as e:
            models[name] = {"error": f"bridge unreachable: {e}"}
    try:
        models["faces"] = RemoteFaceDetector(bridge_url=CONFIG["bridge_url"]).status()
    except Exception as e:
        models["faces"] = {"error": f"bridge unreachable: {e}"}
    return {"backend": "molab_bridge", "config": CONFIG, "models": models}
